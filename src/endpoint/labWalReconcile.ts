/**
 * Offline, one-shot, audited bookkeeping of keys that a human has PROVEN were paid (runbook G-1; PM approval for local development).
 *
 * After a WAL repair (or any loss of acknowledged events) a `settle` event may be gone: its keys were paid on chain but the recovered state still has them as pending and not consumed, so
 * the daemon would pay them again. The chain's consumed view is not set by Lab's own payments, so nothing else stops it. This command appends exactly ONE event, t='manual-reconcile',
 * carrying consumedAdd + pendingDel for each reconciled key (and, when derivable from the pending entries, the max-merged scalar maxPaidHistoryBlock that the lost settle would have carried).
 *
 *  - a command, not a flag: no environment variable, no configuration, no state; the daemon does not reference it (source test);
 *  - the same state-directory lock as the daemon (refuses while held); needs a run id and an approval reference (a plain string: approvalVerified is always false in the audit);
 *  - the input is a human-made list; every key carries its evidence (tx hash, block, amount) and the file is validated (format, lower-case hex, no duplicate keys) before anything is touched;
 *  - the audit goes first: written OUTSIDE the state directory (exclusive create, fsync, directory fsync), together with a verbatim copy of the input file; only then is the single event appended
 *    and fsynced; a `.done.json` record with the seq and the frame hash is written afterwards. A repeated run id fails before anything is appended;
 *  - it appends nothing when the log is not clean (a torn tail or mid-log damage must be repaired first), and it never modifies or removes an existing event or file;
 *  - it does not touch the in-flight record. The audit lists keys that overlap it; a mined in-flight batch is settled by the daemon's own resume path.
 * `--dry-run` prints the audit and changes nothing (no lock, no files).
 *
 * Usage: node labWalReconcile.js --state-dir <dir> --audit-dir <dir outside the state dir> --run-id <id> --approval <ref> --keys-file <json> [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { acquireStateDirLock } from './labClPayoutStateLock'
import { recoverPayoutState } from './labPayoutRecovery'
import { WAL_DIR, WalMidCorruptionError, WalWriter, scanWal, segmentFileName, type WalOp } from './labWal'
import { RUN_ID_RE, assertAuditDirOutside, parseCliArgs, readSnapshotWalSeq } from './labWalRepair'

export const MAX_RECONCILE_KEYS = 20_000
const KEY_RE = /^0x[0-9a-f]{64}$/
const TX_RE = /^0x[0-9a-f]{64}$/

export type ReconcileInput = { eventKey: string; txHash: string; blockNumber: number; amountWei: string; note?: string }

export type ReconcileAudit = {
	runId: string
	approval: string
	approvalVerified: false
	approvalNote: string
	at: string
	dryRun: boolean
	stateDir: string
	snapshotWalSeq: number
	lastSeqBefore: number
	/** The seq of the single manual-reconcile event. */
	eventSeq: number
	keysFileSha256: string
	keyCount: number
	keys: (ReconcileInput & { was: 'pending' | 'consumed-already' | 'neither' })[]
	counts: { wasPending: number; alreadyConsumed: number; neither: number }
	/** Keys that are part of the current in-flight record: the command does not touch the record; the daemon's resume path settles it. */
	inFlightOverlap: string[]
	/** scalarsSet maxPaidHistoryBlock carried by the event (max over the reconciled HISTORY keys found in pending), or null. */
	maxPaidHistoryBlock: number | null
	historyCursor: number | null
	maxPaidAboveCursor: boolean
	ops: number
	copyFile: string | null
	note: string
}

export type ReconcileResult =
	| { status: 'dry-run'; audit: ReconcileAudit }
	| { status: 'appended'; audit: ReconcileAudit; auditFile: string; doneFile: string; eventSeq: number }

export type ReconcileHooks = {
	/** After the audit files are durable, before the event is appended. Throw to simulate a crash there. */
	beforeAppend?: () => void
}

/** Parse and validate the human-made list. Throws with the first problem found; nothing has been touched yet. */
export function parseKeysFile(text: string): ReconcileInput[] {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		throw new Error('labWalReconcile: the keys file is not valid JSON')
	}
	if (!Array.isArray(raw) || raw.length === 0) throw new Error('labWalReconcile: the keys file must be a non-empty JSON array')
	if (raw.length > MAX_RECONCILE_KEYS) throw new Error(`labWalReconcile: more than ${MAX_RECONCILE_KEYS} keys in one run; split the list (the event must stay far below the frame limit)`)
	const seen = new Set<string>()
	const out: ReconcileInput[] = []
	raw.forEach((r, i) => {
		const at = `entry ${i}`
		if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new Error(`labWalReconcile: ${at} is not an object`)
		const o = r as Record<string, unknown>
		for (const k of Object.keys(o)) if (!['eventKey', 'txHash', 'blockNumber', 'amountWei', 'note'].includes(k)) throw new Error(`labWalReconcile: ${at} has an unknown field "${k}"`)
		if (typeof o.eventKey !== 'string' || !KEY_RE.test(o.eventKey)) throw new Error(`labWalReconcile: ${at}: eventKey must be 0x + 64 LOWER-case hex digits`)
		if (typeof o.txHash !== 'string' || !TX_RE.test(o.txHash)) throw new Error(`labWalReconcile: ${at}: txHash (the evidence) must be 0x + 64 lower-case hex digits`)
		if (typeof o.blockNumber !== 'number' || !Number.isSafeInteger(o.blockNumber) || o.blockNumber < 1) throw new Error(`labWalReconcile: ${at}: blockNumber (the evidence) must be a positive integer`)
		if (typeof o.amountWei !== 'string' || !/^[1-9][0-9]*$/.test(o.amountWei)) throw new Error(`labWalReconcile: ${at}: amountWei (the evidence) must be a positive decimal string`)
		if (o.note !== undefined && (typeof o.note !== 'string' || o.note.length > 500)) throw new Error(`labWalReconcile: ${at}: note must be a string of at most 500 characters`)
		if (seen.has(o.eventKey)) throw new Error(`labWalReconcile: ${at}: duplicate eventKey ${o.eventKey}`)
		seen.add(o.eventKey)
		out.push({ eventKey: o.eventKey, txHash: o.txHash, blockNumber: o.blockNumber, amountWei: o.amountWei, ...(o.note !== undefined ? { note: o.note } : {}) })
	})
	return out
}

export async function reconcileKeys(opts: { stateDir: string; auditDir: string; runId: string; approval: string; keysFile: string; dryRun?: boolean; now?: () => Date; hooks?: ReconcileHooks }): Promise<ReconcileResult> {
	if (!opts.runId || !RUN_ID_RE.test(opts.runId)) throw new Error('labWalReconcile: a run id is required (letters, digits, . _ -, 8 to 64 characters)')
	if (!opts.approval || opts.approval.trim().length < 3) throw new Error('labWalReconcile: the approval reference (the written release) is required')
	if (!opts.stateDir) throw new Error('labWalReconcile: a state directory is required')
	if (!opts.auditDir) throw new Error('labWalReconcile: an audit directory is required')
	if (!opts.keysFile) throw new Error('labWalReconcile: a keys file is required')
	assertAuditDirOutside(opts.stateDir, opts.auditDir)
	const keysText = fs.readFileSync(opts.keysFile, 'utf8')
	const keys = parseKeysFile(keysText)
	const now = opts.now ?? (() => new Date())
	let lock: { release: () => void } | null = null
	if (!opts.dryRun) {
		try {
			lock = acquireStateDirLock(opts.stateDir)
		} catch (e) {
			throw new Error(`labWalReconcile: cannot take the state directory lock (${e instanceof Error ? e.message : String(e)}); stop the daemon first. Nothing was changed`)
		}
	}
	try {
		return await reconcileLocked(opts, keys, keysText, now)
	} finally {
		lock?.release()
	}
}

async function reconcileLocked(opts: { stateDir: string; auditDir: string; runId: string; approval: string; keysFile: string; dryRun?: boolean; hooks?: ReconcileHooks }, keys: ReconcileInput[], keysText: string, now: () => Date): Promise<ReconcileResult> {
	const snap = readSnapshotWalSeq(opts.stateDir)
	// the log must be clean: nothing is appended behind a torn tail or past mid-log damage
	let rec
	try {
		rec = recoverPayoutState(opts.stateDir, { readOnly: true })
	} catch (e) {
		if (e instanceof WalMidCorruptionError) throw new Error('labWalReconcile: the log has damage in the middle; run the audited repair first. Nothing was changed')
		throw e
	}
	if (rec.scan.truncatedBytes > 0) throw new Error(`labWalReconcile: the log ends in a torn tail (${rec.scan.truncatedBytes} bytes); start the daemon once (it repairs a torn tail) or repair first. Nothing was changed`)
	const core = rec.core
	const lastSeqBefore = rec.writerLastSeq
	const eventSeq = lastSeqBefore + 1
	const classified = keys.map((k) => ({ ...k, was: (core.pendingHas(k.eventKey) ? 'pending' : core.consumedHas(k.eventKey) ? 'consumed-already' : 'neither') as 'pending' | 'consumed-already' | 'neither' }))
	const inFlight = core.getInFlight()
	const inFlightKeys = new Set<string>(inFlight && Array.isArray(inFlight.eventKeys) ? (inFlight.eventKeys as string[]) : [])
	const overlap = keys.filter((k) => inFlightKeys.has(k.eventKey)).map((k) => k.eventKey)
	// the high-water the lost settle would have carried: max block of the reconciled HISTORY keys that are still pending (blocks <= freezeH)
	const fh = core.freezeHeight()
	let maxPaid: number | null = null
	for (const k of keys) {
		const e = core.pendingGet(k.eventKey)
		const b = e && typeof e.blockNumber === 'number' ? e.blockNumber : null
		if (b !== null && fh !== null && b <= fh && (maxPaid === null || b > maxPaid)) maxPaid = b
	}
	const cursor = typeof core.getScalar('historyCursor') === 'number' ? (core.getScalar('historyCursor') as number) : null
	const ops: WalOp[] = []
	for (const k of keys) ops.push({ op: 'consumedAdd', key: k.eventKey }, { op: 'pendingDel', key: k.eventKey })
	if (maxPaid !== null) ops.push({ op: 'scalarsSet', patch: { maxPaidHistoryBlock: maxPaid } })
	const copyName = `wal-reconcile-${opts.runId}.keys.json`
	const audit: ReconcileAudit = {
		runId: opts.runId,
		approval: opts.approval,
		approvalVerified: false,
		approvalNote: 'The approval reference is a plain string. This command cannot verify it technically; the receipt must say so and the written release must be kept by the PM.',
		at: now().toISOString(),
		dryRun: opts.dryRun === true,
		stateDir: path.resolve(opts.stateDir),
		snapshotWalSeq: snap.walSeq,
		lastSeqBefore,
		eventSeq,
		keysFileSha256: createHash('sha256').update(keysText).digest('hex'),
		keyCount: keys.length,
		keys: classified,
		counts: { wasPending: classified.filter((k) => k.was === 'pending').length, alreadyConsumed: classified.filter((k) => k.was === 'consumed-already').length, neither: classified.filter((k) => k.was === 'neither').length },
		inFlightOverlap: overlap,
		maxPaidHistoryBlock: maxPaid,
		historyCursor: cursor,
		maxPaidAboveCursor: maxPaid !== null && cursor !== null && maxPaid > cursor,
		ops: ops.length,
		copyFile: opts.dryRun ? null : copyName,
		note:
			'One manual-reconcile event (consumedAdd + pendingDel per key, idempotent) will be appended at seq ' +
			eventSeq +
			'. Keys that are "neither" pending nor consumed are still booked as consumed so the scan cannot re-queue them. ' +
			(overlap.length > 0 ? `${overlap.length} key(s) belong to the current in-flight record: the record is NOT touched; the daemon resumes it from the signer record. ` : '') +
			(maxPaid !== null && cursor !== null && maxPaid > cursor ? 'WARNING: the derived maxPaidHistoryBlock is above historyCursor (invariant C): check before starting the daemon. ' : ''),
	}
	if (opts.dryRun) return { status: 'dry-run', audit }

	fs.mkdirSync(opts.auditDir, { recursive: true, mode: 0o700 })
	const writeExclusive = (name: string, data: string): string => {
		const file = path.join(opts.auditDir, name)
		const fd = fs.openSync(file, 'wx', 0o600) // one per run id: an existing file fails the run before anything is appended
		try {
			const b = Buffer.from(data, 'utf8')
			let off = 0
			while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off)
			fs.fsyncSync(fd)
		} finally {
			fs.closeSync(fd)
		}
		return file
	}
	const auditName = `wal-reconcile-${opts.runId}.json`
	if (fs.existsSync(path.join(opts.auditDir, auditName)) || fs.existsSync(path.join(opts.auditDir, copyName))) throw new Error(`labWalReconcile: run id ${opts.runId} was already used (audit files exist); use a new run id. Nothing was changed`)
	writeExclusive(copyName, keysText)
	const auditFile = writeExclusive(auditName, JSON.stringify(audit, null, 2) + '\n')
	const dfd = fs.openSync(opts.auditDir, 'r')
	try {
		fs.fsyncSync(dfd)
	} finally {
		fs.closeSync(dfd)
	}
	opts.hooks?.beforeAppend?.()
	assertAuditDirOutside(opts.stateDir, opts.auditDir)

	// the single event, through the same writer the daemon uses (new segment named by its seq, file + directory fsync, then the ack)
	const wal = new WalWriter({
		stateDir: opts.stateDir,
		lastSeq: lastSeqBefore,
		onFatal: (e) => {
			throw e
		},
	})
	const { seq, durable } = wal.append('manual-reconcile', ops)
	if (seq !== eventSeq) throw new Error(`labWalReconcile: the writer assigned seq ${seq}, expected ${eventSeq}`)
	await durable
	await wal.close()
	// read the log back: the last event must be exactly ours
	let lastTs = ''
	let lastOps = ''
	let lastT = ''
	const res = scanWal(opts.stateDir, {
		afterSeq: snap.walSeq,
		repair: false,
		onEvent: (e) => {
			if (e.seq === eventSeq) {
				lastT = e.t
				lastTs = e.ts
				lastOps = JSON.stringify(e.ops)
			}
		},
	})
	if (res.lastSeq !== eventSeq || lastT !== 'manual-reconcile' || lastOps !== JSON.stringify(ops)) throw new Error('labWalReconcile: the appended event did not read back as written; check the log before starting the daemon')
	const segFile = path.join(opts.stateDir, WAL_DIR, segmentFileName(eventSeq))
	const done = {
		runId: opts.runId,
		eventSeq,
		eventTs: lastTs,
		segmentFile: path.basename(segFile),
		segmentSha256: createHash('sha256').update(fs.readFileSync(segFile)).digest('hex'),
		keyCount: audit.keyCount,
		ops: audit.ops,
	}
	const doneFile = writeExclusive(`wal-reconcile-${opts.runId}.done.json`, JSON.stringify(done, null, 2) + '\n')
	return { status: 'appended', audit, auditFile, doneFile, eventSeq }
}

if (require.main === module) {
	// Arguments only: no environment variable is read, so no standing setting can enable this.
	void (async () => {
		try {
			const { values, dryRun } = parseCliArgs(process.argv.slice(2), ['--keys-file'])
			const r = await reconcileKeys({
				stateDir: values['--state-dir'] ?? '',
				auditDir: values['--audit-dir'] ?? '',
				runId: values['--run-id'] ?? '',
				approval: values['--approval'] ?? '',
				keysFile: values['--keys-file'] ?? '',
				dryRun,
			})
			process.stdout.write(JSON.stringify(r, null, 2) + '\n')
			process.exit(0)
		} catch (e) {
			process.stderr.write(`labWalReconcile: ${e instanceof Error ? e.message : String(e)}\n`)
			process.exit(2)
		}
	})()
}
