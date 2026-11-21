/**
 * Offline, one-shot, audited repair of damage in the MIDDLE of the last WAL segment (review Z1; PM decision: manual only, never a standing setting).
 *
 * scanWal always refuses such a log. This command is the only way past it, under these rules:
 *  - it is a command, not a flag: nothing in the daemon, in any environment variable or in lab-d6.env can turn it on, and it keeps no state, so the next start is
 *    back to "refuse by default";
 *  - it needs a run id (letters, digits, . _ -, 8-64 chars) and an approval reference (the PM's written release), both recorded in the audit file;
 *  - it writes an audit record OUTSIDE the state directory first (offset and bytes cut, the number of valid frames dropped, each dropped frame's seq and type, and every
 *    decodable intent with its idempotency key), fsyncs it, and only then truncates; the audit file is created exclusively (one per run id);
 *  - it never touches anything when the damage is an ordinary torn tail (scanWal repairs that itself) or when there is no damage;
 *  - it takes the state-directory lock (the same lock the daemon holds) before it reads or cuts anything and refuses when the lock is held (no TOCTOU against a running daemon);
 *  - the cut bytes are stored WHOLE in the audit directory (exclusive create, fsync, sha256 in the audit), not only the decoded summary;
 *  - the sequence numbers of the dropped frames are REUSED: after the cut the next event gets lastGoodSeq + 1. The audit says so;
 *  - the approval reference is only a string. Nothing here can verify it technically. The audit records approvalVerified=false and the receipt must say so.
 * Before using it the operator must compare every intent in the audit with the signer record (signer_getTransaction) and the chain, and book any transaction already
 * sent as consumed (runbook). `--dry-run` prints the audit and changes nothing.
 *
 * Usage: node labWalRepair.js --state-dir <dir> --audit-dir <dir outside the state dir> --run-id <id> --approval <ref> [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { acquireStateDirLock } from './labClPayoutStateLock'
import { WAL_DIR, WalMidCorruptionError, decodeFrameAt, scanWal, type WalEvent } from './labWal'

export const RUN_ID_RE = /^[A-Za-z0-9._-]{8,64}$/

export type DroppedFrame = {
	offset: number
	seq: number
	t: string
	ts: string
	opCount: number
	/** In-flight records decoded from inFlightSet ops: the intents and hashes that may correspond to transactions already sent. */
	intents: { batchId?: string; idempotencyKey?: string; line?: string; amountWei?: string; eventKeyCount?: number; hash?: string }[]
	settledKeyCount: number
}

export type RepairAudit = {
	runId: string
	approval: string
	at: string
	stateDir: string
	segmentFile: string
	badOffset: number
	reason: string
	bytesCut: number
	validFramesDropped: number
	frames: DroppedFrame[]
	dryRun: boolean
	/** Seq of the last intact frame before the damage. The dropped seqs (first..last below) are reused by the next events written after the cut. */
	lastGoodSeq: number
	droppedSeqs: { first: number; last: number; count: number } | null
	seqReuseNote: string
	/** The raw bytes from the bad offset to the end of the segment, stored beside this audit. */
	tailFile: string | null
	tailBytes: number
	tailSha256: string
	/** Always false: the approval reference is a plain string and cannot be verified technically. */
	approvalVerified: false
	approvalNote: string
}

export type RepairResult =
	| { status: 'nothing-to-repair'; detail: string }
	| { status: 'dry-run'; audit: RepairAudit }
	| { status: 'repaired'; audit: RepairAudit; auditFile: string }

function insideDir(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child))
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function summarize(ev: WalEvent, offset: number): DroppedFrame {
	const intents: DroppedFrame['intents'] = []
	let settled = 0
	for (const op of ev.ops) {
		if (op.op === 'inFlightSet' && op.record) {
			const r = op.record as Record<string, unknown>
			const keys = Array.isArray(r.eventKeys) ? (r.eventKeys as unknown[]).length : undefined
			intents.push({
				batchId: typeof r.batchId === 'string' ? r.batchId : typeof r.requestFingerprint === 'string' ? (r.requestFingerprint as string) : undefined,
				idempotencyKey: typeof r.idempotencyKey === 'string' ? r.idempotencyKey : undefined,
				line: typeof r.line === 'string' ? r.line : undefined,
				amountWei: typeof r.amountWei === 'string' ? r.amountWei : undefined,
				eventKeyCount: keys,
				hash: typeof r.hash === 'string' ? r.hash : undefined,
			})
		}
		if (op.op === 'consumedAdd') settled++
	}
	return { offset, seq: ev.seq, t: ev.t, ts: ev.ts, opCount: ev.ops.length, intents, settledKeyCount: settled }
}

export type RepairHooks = {
	/** Called after the audit files are durable and before the truncation. Throw to simulate a crash there. */
	beforeTruncate?: () => void
}

export function repairMidCorruption(opts: { stateDir: string; auditDir: string; runId: string; approval: string; dryRun?: boolean; now?: () => Date; hooks?: RepairHooks }): RepairResult {
	if (!opts.runId || !RUN_ID_RE.test(opts.runId)) throw new Error('labWalRepair: a run id is required (letters, digits, . _ -, 8 to 64 characters)')
	if (!opts.approval || opts.approval.trim().length < 3) throw new Error('labWalRepair: the approval reference (the written release) is required')
	if (!opts.auditDir) throw new Error('labWalRepair: an audit directory is required')
	if (insideDir(opts.auditDir, opts.stateDir)) throw new Error('labWalRepair: the audit directory must be OUTSIDE the state directory')
	const now = opts.now ?? (() => new Date())

	// the daemon's own lock: refuse while anything holds it (a running daemon, another repair), keep it until the log is cut
	let lock: { release: () => void } | null = null
	if (!opts.dryRun) {
		try {
			lock = acquireStateDirLock(opts.stateDir)
		} catch (e) {
			throw new Error(`labWalRepair: cannot take the state directory lock (${e instanceof Error ? e.message : String(e)}); stop the daemon first. Nothing was changed`)
		}
	}
	try {
		return repairLocked(opts, now)
	} finally {
		lock?.release()
	}
}

function repairLocked(opts: { stateDir: string; auditDir: string; runId: string; approval: string; dryRun?: boolean; hooks?: RepairHooks }, now: () => Date): RepairResult {
	let mid: WalMidCorruptionError
	try {
		scanWal(opts.stateDir, { afterSeq: 0, onEvent: () => undefined, repair: false })
		return { status: 'nothing-to-repair', detail: 'the log scans cleanly or ends in an ordinary torn tail (scanWal repairs that itself)' }
	} catch (e) {
		if (!(e instanceof WalMidCorruptionError)) throw e
		mid = e
	}
	const buf = fs.readFileSync(mid.file)
	const tail = buf.subarray(mid.badOffset)
	const frames: DroppedFrame[] = []
	for (const off of mid.laterFrameOffsets) {
		const d = decodeFrameAt(buf, off)
		if (d.ok) frames.push(summarize(d.event, off))
	}
	const seqs = frames.map((f) => f.seq)
	const tailSha = createHash('sha256').update(tail).digest('hex')
	const tailName = `wal-midcorruption-${opts.runId}.tail.bin`
	const audit: RepairAudit = {
		runId: opts.runId,
		approval: opts.approval,
		at: now().toISOString(),
		stateDir: path.resolve(opts.stateDir),
		segmentFile: path.basename(mid.file),
		badOffset: mid.badOffset,
		reason: mid.reason,
		bytesCut: tail.length,
		validFramesDropped: frames.length,
		frames,
		dryRun: opts.dryRun === true,
		lastGoodSeq: mid.lastGoodSeq,
		droppedSeqs: seqs.length > 0 ? { first: Math.min(...seqs), last: Math.max(...seqs), count: seqs.length } : null,
		seqReuseNote:
			`After the cut the next event written gets seq ${mid.lastGoodSeq + 1}: the dropped sequence numbers are REUSED by different events. ` +
			'Anything that recorded those seqs (journal lines, receipts) refers to events that no longer exist.',
		tailFile: opts.dryRun ? null : tailName,
		tailBytes: tail.length,
		tailSha256: tailSha,
		approvalVerified: false,
		approvalNote: 'The approval reference is a plain string. This command cannot verify it technically; the receipt must say so and the written release must be kept by the PM.',
	}
	if (opts.dryRun) return { status: 'dry-run', audit }

	fs.mkdirSync(opts.auditDir, { recursive: true, mode: 0o700 })
	const writeExclusive = (name: string, data: Buffer | string): string => {
		const file = path.join(opts.auditDir, name)
		const fd = fs.openSync(file, 'wx', 0o600) // one per run id: an existing file fails the repair before anything is cut
		try {
			let off = 0
			const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
			while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off)
			fs.fsyncSync(fd)
		} finally {
			fs.closeSync(fd)
		}
		return file
	}
	// the raw cut bytes first, then the audit that names them; both fsynced, then the directory, then the cut
	writeExclusive(tailName, tail)
	const auditFile = writeExclusive(`wal-midcorruption-${opts.runId}.json`, JSON.stringify(audit, null, 2) + '\n')
	const dfd = fs.openSync(opts.auditDir, 'r')
	try {
		fs.fsyncSync(dfd)
	} finally {
		fs.closeSync(dfd)
	}
	opts.hooks?.beforeTruncate?.()
	const sfd = fs.openSync(mid.file, 'r+')
	try {
		fs.ftruncateSync(sfd, mid.badOffset)
		fs.fsyncSync(sfd)
	} finally {
		fs.closeSync(sfd)
	}
	return { status: 'repaired', audit, auditFile }
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name)
	return i >= 0 ? process.argv[i + 1] : undefined
}

if (require.main === module) {
	// Arguments only: no environment variable is read, so no standing setting can enable this.
	try {
		const r = repairMidCorruption({
			stateDir: arg('--state-dir') ?? '',
			auditDir: arg('--audit-dir') ?? '',
			runId: arg('--run-id') ?? '',
			approval: arg('--approval') ?? '',
			dryRun: process.argv.includes('--dry-run'),
		})
		process.stdout.write(JSON.stringify(r, null, 2) + '\n')
		process.exit(0)
	} catch (e) {
		process.stderr.write(`labWalRepair: ${e instanceof Error ? e.message : String(e)}\n`)
		process.exit(2)
	}
}

void WAL_DIR
