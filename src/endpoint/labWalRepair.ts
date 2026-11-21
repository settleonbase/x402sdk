/**
 * Offline, one-shot, audited repair of damage in the MIDDLE of the last WAL segment (review Z1; PM decision: manual only, never a standing setting).
 *
 * scanWal always refuses such a log. This command is the only way past it, under these rules:
 *  - it is a command, not a flag: nothing in the daemon, in any environment variable or in lab-d6.env can turn it on, and it keeps no state, so the next start is
 *    back to "refuse by default";
 *  - it needs a run id (letters, digits, . _ -, 8-64 chars) and an approval reference (the PM's written release), both recorded in the audit file;
 *  - it writes an audit record OUTSIDE the state directory first (offset and bytes cut, the number of valid frames dropped, each dropped frame's seq and type, and every
 *    decodable intent with its idempotency key), fsyncs it, and only then truncates; the audit file is created exclusively (one per run id);
 *  - it never touches anything when the damage is an ordinary torn tail (scanWal repairs that itself) or when there is no damage.
 * Before using it the operator must compare every intent in the audit with the signer record (signer_getTransaction) and the chain, and book any transaction already
 * sent as consumed (runbook). `--dry-run` prints the audit and changes nothing.
 *
 * Usage: node labWalRepair.js --state-dir <dir> --audit-dir <dir outside the state dir> --run-id <id> --approval <ref> [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
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

export function repairMidCorruption(opts: { stateDir: string; auditDir: string; runId: string; approval: string; dryRun?: boolean; now?: () => Date }): RepairResult {
	if (!opts.runId || !RUN_ID_RE.test(opts.runId)) throw new Error('labWalRepair: a run id is required (letters, digits, . _ -, 8 to 64 characters)')
	if (!opts.approval || opts.approval.trim().length < 3) throw new Error('labWalRepair: the approval reference (the written release) is required')
	if (!opts.auditDir) throw new Error('labWalRepair: an audit directory is required')
	if (insideDir(opts.auditDir, opts.stateDir)) throw new Error('labWalRepair: the audit directory must be OUTSIDE the state directory')
	const now = opts.now ?? (() => new Date())

	let mid: WalMidCorruptionError
	try {
		scanWal(opts.stateDir, { afterSeq: 0, onEvent: () => undefined, repair: false })
		return { status: 'nothing-to-repair', detail: 'the log scans cleanly or ends in an ordinary torn tail (scanWal repairs that itself)' }
	} catch (e) {
		if (!(e instanceof WalMidCorruptionError)) throw e
		mid = e
	}
	const buf = fs.readFileSync(mid.file)
	const frames: DroppedFrame[] = []
	for (const off of mid.laterFrameOffsets) {
		const d = decodeFrameAt(buf, off)
		if (d.ok) frames.push(summarize(d.event, off))
	}
	const audit: RepairAudit = {
		runId: opts.runId,
		approval: opts.approval,
		at: now().toISOString(),
		stateDir: path.resolve(opts.stateDir),
		segmentFile: path.basename(mid.file),
		badOffset: mid.badOffset,
		reason: mid.reason,
		bytesCut: buf.length - mid.badOffset,
		validFramesDropped: frames.length,
		frames,
		dryRun: opts.dryRun === true,
	}
	if (opts.dryRun) return { status: 'dry-run', audit }

	fs.mkdirSync(opts.auditDir, { recursive: true, mode: 0o700 })
	const auditFile = path.join(opts.auditDir, `wal-midcorruption-${opts.runId}.json`)
	// exclusive create: one audit per run id; fsync before anything is cut
	const fd = fs.openSync(auditFile, 'wx', 0o600)
	try {
		fs.writeSync(fd, JSON.stringify(audit, null, 2) + '\n')
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
	const dfd = fs.openSync(opts.auditDir, 'r')
	try {
		fs.fsyncSync(dfd)
	} finally {
		fs.closeSync(dfd)
	}
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
