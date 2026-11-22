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
 *  - frames that cannot be decoded at all (the damaged frame itself) cannot be listed either; the audit gives their inferred seqs, byte ranges and the split by the snapshot, and says that
 *    at least that many events are lost and every transaction sent in that span must be reconciled (R7);
 *  - the dropped frames are split in the audit: those with seq <= the snapshot's walSeq are COVERED by the snapshot (their effect is already in the state), those above it are
 *    LOST (the operator must check their intents against the signer and the chain). The daemon continues at max(lastGoodSeq, walSeq) + 1 (recovery's writerLastSeq): seqs above that are
 *    REUSED by different events, seqs up to walSeq are not. scanWal accepts the resulting forward jump only because every missing seq lies inside the snapshot (R6);
 *  - the scan starts AFTER the snapshot: afterSeq is read from the committed manifest (v3 top-level walSeq, or the informational scalars.walSeq of a v2 downgrade
 *    manifest), never assumed to be 0. A manifest that is missing, unreadable, of another version or without a valid walSeq REFUSES the repair (R1);
 *  - the audit directory is compared with the state directory after realpath (nearest existing ancestor when it does not exist yet), and a symlink as the audit
 *    directory itself is refused (R4); the cut is made only if the segment still equals, byte for byte, what was scanned and audited (R2);
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

export const MAX_LISTED_UNDECODABLE = 10_000

/** min and max by a loop: Math.min(...a)/Math.max(...a) overflows the call stack on a very large array (a log can hold hundreds of thousands of frames). */
export function minMax(a: readonly number[]): { min: number; max: number } | null {
	if (a.length === 0) return null
	let min = a[0]!
	let max = a[0]!
	for (let i = 1; i < a.length; i++) {
		const v = a[i]!
		if (v < min) min = v
		if (v > max) max = v
	}
	return { min, max }
}

/**
 * The undecodable events between the last intact frame and the highest decodable later frame (sequence numbers are contiguous): exact counts by arithmetic, the lists only when the span is
 * at most `maxList` (review R8: a damaged first frame with a snapshot far ahead must not enumerate hundreds of thousands of seqs).
 */
export function inferUndecodable(lastGoodSeq: number, decodedSeqs: number[], walSeq: number, maxList = MAX_LISTED_UNDECODABLE): {
	span: number
	count: number
	coveredCount: number
	lostCount: number
	listTruncated: boolean
	seqs: number[]
	coveredList: number[]
	lostList: number[]
} {
	const decoded = new Set(decodedSeqs)
	const highest = minMax(decodedSeqs)?.max ?? lastGoodSeq
	const span = Math.max(0, highest - lastGoodSeq)
	const count = span - decoded.size
	const decodedCovered = decodedSeqs.filter((x) => x <= walSeq).length
	const coveredCount = Math.max(0, Math.min(highest, walSeq) - lastGoodSeq) - decodedCovered
	const listTruncated = span > maxList
	const seqs: number[] = []
	if (!listTruncated) for (let q = lastGoodSeq + 1; q <= highest; q++) if (!decoded.has(q)) seqs.push(q)
	return { span, count, coveredCount, lostCount: count - coveredCount, listTruncated, seqs, coveredList: seqs.filter((x) => x <= walSeq), lostList: seqs.filter((x) => x > walSeq) }
}
export const RUN_ID_RE = /^[A-Za-z0-9._-]{8,64}$/
const MANIFEST_FILE = 'manifest.json'

/**
 * The seq the committed snapshot already contains (R1). Reads manifest.json as plain JSON (the strict state reader only knows version 2): version 3 carries `walSeq`
 * at the top level, a version 2 downgrade manifest carries it as the informational scalar `scalars.walSeq`. Anything else refuses; there is no default.
 */
export function readSnapshotWalSeq(stateDir: string): { walSeq: number; manifestSha256: string; version: number } {
	const file = path.join(stateDir, MANIFEST_FILE)
	let raw: Buffer
	try {
		raw = fs.readFileSync(file)
	} catch (e) {
		throw new Error(`labWalRepair: cannot read the committed manifest ${file} (${e instanceof Error ? e.message : String(e)}); the scan start seq is unknown, so nothing is repaired`)
	}
	let m: unknown
	try {
		m = JSON.parse(raw.toString('utf8'))
	} catch {
		throw new Error(`labWalRepair: ${file} is not valid JSON; nothing is repaired`)
	}
	const o = m as { version?: unknown; walSeq?: unknown; scalars?: { walSeq?: unknown } } | null
	if (o === null || typeof o !== 'object') throw new Error(`labWalRepair: ${file} is not an object; nothing is repaired`)
	const version = o.version
	if (version !== 2 && version !== 3) throw new Error(`labWalRepair: manifest version ${String(version)} is not 2 or 3; nothing is repaired`)
	const w = version === 3 ? o.walSeq : o.scalars && typeof o.scalars === 'object' ? o.scalars.walSeq : undefined
	if (typeof w !== 'number' || !Number.isSafeInteger(w) || w < 0) {
		throw new Error(`labWalRepair: the manifest (version ${version}) has no valid walSeq; the snapshot's last applied seq is unknown, so nothing is repaired`)
	}
	return { walSeq: w, manifestSha256: createHash('sha256').update(raw).digest('hex'), version }
}

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
	/** The seq the committed snapshot contains: the scan started after it (R1). */
	snapshotWalSeq: number
	manifestVersion: number
	manifestSha256: string
	/** The whole segment as scanned: length and sha256 before the cut (R3). The cut part is stored separately, sha256 in tailSha256. */
	segmentBytesBefore: number
	segmentSha256Before: string
	bytesCut: number
	validFramesDropped: number
	frames: DroppedFrame[]
	dryRun: boolean
	/** Seq of the last intact frame before the damage. The dropped seqs (first..last below) are reused by the next events written after the cut. */
	lastGoodSeq: number
	droppedSeqs: { first: number; last: number; count: number } | null
	/** R6: dropped frames whose seq is <= snapshotWalSeq: already inside the snapshot, nothing is lost by cutting them. */
	droppedCoveredBySnapshot: { count: number; seqs: number[] }
	/** R6: dropped frames above snapshotWalSeq: acknowledged events that are really lost by the cut. Check every intent in them. */
	droppedBeyondSnapshot: { count: number; seqs: number[] }
	/**
	 * R7: events that cannot be decoded at all (the damaged frame itself and any other damaged frame between the intact ones). Sequence numbers are contiguous, so they are exactly the
	 * seqs between lastGoodSeq+1 and the highest decodable later frame that no decodable frame carries. Split by the snapshot like the decodable ones. An undecodable event may have been
	 * an in-flight record of a transaction that was already sent: it cannot be listed, so the operator must reconcile every transaction sent in that time span.
	 */
	undecodableEvents: {
		count: number
		/** Counts are exact and always present; the seq lists are bounded (R8): when the span is larger than MAX_LISTED_UNDECODABLE they are empty and `listTruncated` is true (use `range`). */
		coveredCount: number
		lostCount: number
		range: { from: number; to: number } | null
		listTruncated: boolean
		seqs: number[]
		coveredBySnapshot: number[]
		lostBeyondSnapshot: number[]
		/** Byte ranges [from, to) of the segment that hold the undecodable frames (all inside the cut part). */
		byteRanges: { from: number; to: number }[]
		note: string
	}
	/** Timestamp of the last intact event before the damage (null if the damaged frame is the first of the segment) and the segment file's mtime: the time span to reconcile is between them. */
	lastGoodEventTs: string | null
	segmentMtime: string
	/** At least this many acknowledged events are lost by the cut: decodable ones beyond the snapshot plus undecodable ones beyond the snapshot. */
	lostEventsAtLeast: number
	/** The seq the next event gets after recovery: max(lastGoodSeq, snapshotWalSeq) + 1. */
	nextEventSeq: number
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

/** realpath of the path itself, or, when it does not exist yet, of its nearest existing ancestor with the missing tail appended. Symlinks anywhere are resolved. */
export function realpathOrAncestor(p: string): string {
	let cur = path.resolve(p)
	const tail: string[] = []
	for (;;) {
		try {
			return path.join(fs.realpathSync(cur), ...tail.reverse())
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code
			if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
			const parent = path.dirname(cur)
			if (parent === cur) throw e
			tail.push(path.basename(cur))
			cur = parent
		}
	}
}

/** The audit directory must not be (or be reached through a symlink into) the state directory, and must not itself be a symlink. */
export function assertAuditDirOutside(stateDir: string, auditDir: string): void {
	let st: fs.Stats | null = null
	try {
		st = fs.lstatSync(auditDir)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
	}
	if (st && st.isSymbolicLink()) throw new Error('labWalRepair: the audit directory is a symbolic link; use a real directory')
	if (st && !st.isDirectory()) throw new Error('labWalRepair: the audit path exists and is not a directory')
	const realState = fs.realpathSync(stateDir)
	const realAudit = realpathOrAncestor(auditDir)
	if (insideDir(realAudit, realState) || insideDir(realState, realAudit)) {
		throw new Error('labWalRepair: the audit directory must be OUTSIDE the state directory (compared after resolving symbolic links)')
	}
}

function summarize(ev: WalEvent, offset: number): DroppedFrame {
	const intents: DroppedFrame['intents'] = []
	let settled = 0
	for (const op of ev.ops) {
		if ((op.op === 'inFlightSet' || op.op === 'slotSet') && op.record) {
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
	if (!opts.stateDir) throw new Error('labWalRepair: a state directory is required')
	if (insideDir(opts.auditDir, opts.stateDir)) throw new Error('labWalRepair: the audit directory must be OUTSIDE the state directory')
	assertAuditDirOutside(opts.stateDir, opts.auditDir)
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
	// R1: start the scan where the snapshot ends; a manifest that cannot be read refuses before any log byte is looked at
	const snap = readSnapshotWalSeq(opts.stateDir)
	try {
		scanWal(opts.stateDir, { afterSeq: snap.walSeq, onEvent: () => undefined, repair: false })
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
	const covered = seqs.filter((x) => x <= snap.walSeq)
	const beyond = seqs.filter((x) => x > snap.walSeq)
	const nextSeq = Math.max(mid.lastGoodSeq, snap.walSeq) + 1
	// R7: the frames that cannot be decoded. Contiguous seqs: everything from lastGoodSeq+1 to the highest decodable later seq that no decodable frame has.
	const decoded = new Set(seqs)
	const highest = minMax(seqs)?.max ?? mid.lastGoodSeq
	const und = inferUndecodable(mid.lastGoodSeq, seqs, snap.walSeq)
	const undecodable = und.seqs
	const undecCount = und.count
	const undecCoveredCount = und.coveredCount
	const undecLostCount = und.lostCount
	const listTruncated = und.listTruncated
	const spanFrom = mid.lastGoodSeq + 1
	const span = und.span
	const undecCovered = und.coveredList
	const undecLost = und.lostList
	let lastGoodTs: string | null = null
	for (let at = 0; at < mid.badOffset; ) {
		const d = decodeFrameAt(buf, at)
		if (!d.ok) break
		lastGoodTs = d.event.ts
		at = d.end
	}
	const byteRanges: { from: number; to: number }[] = []
	{
		let from = mid.badOffset
		for (const off of mid.laterFrameOffsets) {
			if (off > from) byteRanges.push({ from, to: off })
			const d = decodeFrameAt(buf, off)
			from = d.ok ? d.end : off
		}
	}
	const tailSha = createHash('sha256').update(tail).digest('hex')
	const segmentSha = createHash('sha256').update(buf).digest('hex')
	const tailName = `wal-midcorruption-${opts.runId}.tail.bin`
	const audit: RepairAudit = {
		runId: opts.runId,
		approval: opts.approval,
		at: now().toISOString(),
		stateDir: path.resolve(opts.stateDir),
		segmentFile: path.basename(mid.file),
		badOffset: mid.badOffset,
		reason: mid.reason,
		snapshotWalSeq: snap.walSeq,
		manifestVersion: snap.version,
		manifestSha256: snap.manifestSha256,
		segmentBytesBefore: buf.length,
		segmentSha256Before: segmentSha,
		bytesCut: tail.length,
		validFramesDropped: frames.length,
		frames,
		dryRun: opts.dryRun === true,
		lastGoodSeq: mid.lastGoodSeq,
		droppedSeqs: ((mm) => (mm ? { first: mm.min, last: mm.max, count: seqs.length } : null))(minMax(seqs)),
		droppedCoveredBySnapshot: { count: covered.length, seqs: covered },
		droppedBeyondSnapshot: { count: beyond.length, seqs: beyond },
		undecodableEvents: {
			count: undecCount,
			coveredCount: undecCoveredCount,
			lostCount: undecLostCount,
			range: span > 0 ? { from: spanFrom, to: highest } : null,
			listTruncated,
			seqs: undecodable,
			coveredBySnapshot: undecCovered,
			lostBeyondSnapshot: undecLost,
			byteRanges,
			note:
				undecLostCount > 0
					? `AT LEAST ${undecLostCount} event(s) above the snapshot could not be decoded and are lost (${listTruncated ? `seq range ${spanFrom}..${highest}, list omitted` : `seq ${undecLost.join(', ')}`}). They may have been in-flight records of transactions already sent: ` +
						'reconcile EVERY transaction sent from the signer record and the chain for the whole time span from the last intact event to the end of the segment, and book what was sent as consumed.'
					: undecCount > 0
						? `${undecCount} undecodable event(s) lie inside the snapshot (${listTruncated ? `seq range ${spanFrom}..${Math.min(highest, snap.walSeq)}` : `seq ${undecodable.join(', ')}`}); their effect is already in the state, nothing is lost by cutting them.`
						: 'no undecodable event between the intact frames.',
		},
		lastGoodEventTs: lastGoodTs,
		segmentMtime: fs.statSync(mid.file).mtime.toISOString(),
		lostEventsAtLeast: beyond.length + undecLostCount,
		nextEventSeq: nextSeq,
		seqReuseNote:
			`After the cut the daemon continues at seq ${nextSeq} (= max(last intact seq ${mid.lastGoodSeq}, snapshot walSeq ${snap.walSeq}) + 1). ` +
			`${covered.length} dropped frame(s) lie inside the snapshot (nothing lost); ${beyond.length} lie above it and ARE lost` +
			(beyond.length > 0 ? `; seqs ${beyond.filter((x) => x >= nextSeq).length > 0 ? 'from ' + nextSeq : 'none of them'} will be reused by different events` : '') +
			'. Anything that recorded the lost seqs (journal lines, receipts) refers to events that no longer exist.',
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
	// R4: the audit directory is checked again now that it exists; R2: the segment must still be exactly what was scanned and audited
	assertAuditDirOutside(opts.stateDir, opts.auditDir)
	const now2 = fs.readFileSync(mid.file)
	if (now2.length !== buf.length || !now2.equals(buf)) {
		throw new Error('labWalRepair: the segment changed after it was scanned (another writer?); nothing was cut. The audit files remain; run again with a new run id')
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

const CLI_VALUE_FLAGS = ['--state-dir', '--audit-dir', '--run-id', '--approval']
const CLI_BOOL_FLAGS = ['--dry-run']

/** Strict argument parsing (R5): a value flag needs a value that does not start with `--`, no repeats, no unknown flags. */
export function parseCliArgs(argv: string[], extraValueFlags: readonly string[] = []): { values: Record<string, string>; dryRun: boolean } {
	const values: Record<string, string> = {}
	let dryRun = false
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!
		if (CLI_BOOL_FLAGS.includes(a)) {
			dryRun = true
		} else if (CLI_VALUE_FLAGS.includes(a) || extraValueFlags.includes(a)) {
			const v = argv[i + 1]
			if (v === undefined || v.startsWith('--')) throw new Error(`labWalRepair: ${a} needs a value (got ${v === undefined ? 'nothing' : `"${v}"`})`)
			if (a in values) throw new Error(`labWalRepair: ${a} given twice`)
			values[a] = v
			i++
		} else {
			throw new Error(`labWalRepair: unknown argument "${a}"`)
		}
	}
	return { values, dryRun }
}

if (require.main === module) {
	// Arguments only: no environment variable is read, so no standing setting can enable this.
	try {
		const { values, dryRun } = parseCliArgs(process.argv.slice(2))
		const r = repairMidCorruption({
			stateDir: values['--state-dir'] ?? '',
			auditDir: values['--audit-dir'] ?? '',
			runId: values['--run-id'] ?? '',
			approval: values['--approval'] ?? '',
			dryRun,
		})
		process.stdout.write(JSON.stringify(r, null, 2) + '\n')
		process.exit(0)
	} catch (e) {
		process.stderr.write(`labWalRepair: ${e instanceof Error ? e.message : String(e)}\n`)
		process.exit(2)
	}
}

void WAL_DIR
