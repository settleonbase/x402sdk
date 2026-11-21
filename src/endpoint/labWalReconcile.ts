/**
 * Offline, one-shot, audited bookkeeping of keys that a human has PROVEN were paid (runbook G-1; PM approval for local development).
 *
 * After a WAL repair (or any loss of acknowledged events) a `settle` event may be gone: its keys were paid on chain but the recovered state still has them as pending and not consumed, so
 * the daemon would pay them again. The chain's consumed view is not set by Lab's own payments, so nothing else stops it. This command appends exactly ONE event, t='manual-reconcile',
 * carrying consumedAdd + pendingDel for each reconciled key (and, when derivable from the pending entries, the max-merged scalar maxPaidHistoryBlock that the lost settle would have carried).
 *
 *  - a command, not a flag: no environment variable, no configuration, no state; the daemon does not reference it (source test);
 *  - the same state-directory lock as the daemon (refuses while held); needs a run id and an approval reference (a plain string: approvalVerified is always false in the audit);
 *  - the input is a human-made file {reviewers:[a,b], entries:[...]}: TWO DIFFERENT reviewer ids (plain strings, recorded in the audit; the command cannot verify them); every entry carries its
 *    evidence (tx hash, block, the key's own amount `amountWei`, the tx total `txTotalWei`, optional wallet `nonce`) and the file is validated (format, lower-case hex, no duplicate keys) before anything is touched;
 *  - OFFLINE SELF-CONSISTENCY (review R9): entries are grouped by tx hash; inside a group blockNumber/txTotalWei/nonce must agree; for every key that is still pending the declared amount must equal the pending
 *    entry's amount to the wei; and (pending amounts + declared amounts of the non-pending keys) must equal txTotalWei to the wei. A key that is neither pending nor consumed cannot be checked offline: it is listed separately
 *    in the audit and its entry must carry a note that explains it (>= 10 characters). Any mismatch refuses the whole run before anything is touched (a wrong key would be booked consumed for good: there is no consumedDel);
 *  - settledBatchCount (review R10): the lost settle events also lost their count. The event carries the absolute corrected count = recorded + number of distinct tx hashes that are not already fully consumed;
 *    the audit prints before/after and the nonces the entries declare so the operator can compare them with the Lab wallet's chain nonce;
 *  - the audit goes first: written OUTSIDE the state directory (exclusive create, fsync, directory fsync), together with a verbatim copy of the input file; only then is the single event appended
 *    and fsynced; a `.done.json` record with the seq and the frame hash is written afterwards. A repeated run id fails before anything is appended;
 *  - it appends nothing when the log is not clean (a torn tail or mid-log damage must be repaired first), and it never modifies or removes an existing event or file;
 *  - it REFUSES when any listed key belongs to the current in-flight record (PM decision): the in-flight batch may settle the same keys at the next start, and booking them on both sides
 *    would confuse the reconciliation. The refusal names the overlapping keys and the in-flight batch (and, for a real run, leaves a `.refused-<time>.json` record in the audit directory;
 *    it does not use up the run id). First bring the in-flight batch to a final state (settled, or confirmed not sent and released) with the normal in-flight recovery, then run again.
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

export type ReconcileInput = { eventKey: string; txHash: string; blockNumber: number; /** The key's own amount. */ amountWei: string; /** The whole tx's NativeWithdrawn amount (same for every key of the tx). */ txTotalWei: string; nonce?: number; note?: string }
export type ReconcileFile = { reviewers: [string, string]; entries: ReconcileInput[] }
const REVIEWER_RE = /^[A-Za-z0-9._@:-]{3,64}$/

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
	reviewers: [string, string]
	reviewersNote: string
	keys: (ReconcileInput & { was: 'pending' | 'consumed-already' | 'neither' })[]
	/** R9: per tx hash: the offline self-check (all must be ok, otherwise the run is refused). */
	txGroups: { txHash: string; blockNumber: number; nonce: number | null; txTotalWei: string; keyCount: number; pendingSumWei: string; declaredOtherSumWei: string; sumWei: string; ok: boolean }[]
	/** R9: keys that are neither pending nor consumed: cannot be verified offline; each carries the operator's explanation. */
	unverifiableOffline: { eventKey: string; amountWei: string; note: string }[]
	/** R10 */
	settledBatchCountBefore: number
	settledBatchCountAfter: number
	distinctTxHashes: number
	distinctTxHashesCounted: number
	nonces: number[]
	nonceNote: string
	counts: { wasPending: number; alreadyConsumed: number; neither: number }
	/** Keys that are part of the current in-flight record. A non-empty list means the command REFUSES (see `refused`). */
	inFlightOverlap: string[]
	/** The in-flight batch the overlap belongs to (null when there is no overlap or no in-flight record). */
	inFlightBatch: { batchId?: string; idempotencyKey?: string; line?: string; amountWei?: string; eventKeyCount?: number; hash?: string } | null
	/** True when the command refuses to run because of the overlap (a dry run reports it without failing). */
	refused: boolean
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

/** Parse and validate the human-made file. Throws with the first problem found; nothing has been touched yet. */
export function parseKeysFile(text: string): ReconcileFile {
	let rawFile: unknown
	try {
		rawFile = JSON.parse(text)
	} catch {
		throw new Error('labWalReconcile: the keys file is not valid JSON')
	}
	if (rawFile === null || typeof rawFile !== 'object' || Array.isArray(rawFile)) throw new Error('labWalReconcile: the keys file must be a JSON object {reviewers:[a,b], entries:[...]}')
	const top = rawFile as Record<string, unknown>
	for (const k of Object.keys(top)) if (!['reviewers', 'entries'].includes(k)) throw new Error(`labWalReconcile: the keys file has an unknown top-level field "${k}"`)
	const rv = top.reviewers
	if (!Array.isArray(rv) || rv.length !== 2 || rv.some((x) => typeof x !== 'string' || !REVIEWER_RE.test(x))) throw new Error('labWalReconcile: "reviewers" must be an array of exactly two ids (3-64 chars: letters, digits, . _ @ : -)')
	if (rv[0]!.toLowerCase() === rv[1]!.toLowerCase()) throw new Error('labWalReconcile: the two reviewers must be different people (two different ids)')
	const raw = top.entries
	if (!Array.isArray(raw) || raw.length === 0) throw new Error('labWalReconcile: "entries" must be a non-empty JSON array')
	if (raw.length > MAX_RECONCILE_KEYS) throw new Error(`labWalReconcile: more than ${MAX_RECONCILE_KEYS} keys in one run; split the list (the event must stay far below the frame limit)`)
	const seen = new Set<string>()
	const out: ReconcileInput[] = []
	const dec = (v: unknown, name: string, at: string): string => {
		if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v)) throw new Error(`labWalReconcile: ${at}: ${name} (the evidence) must be a positive decimal string`)
		return v
	}
	raw.forEach((r, i) => {
		const at = `entry ${i}`
		if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new Error(`labWalReconcile: ${at} is not an object`)
		const o = r as Record<string, unknown>
		for (const k of Object.keys(o)) if (!['eventKey', 'txHash', 'blockNumber', 'amountWei', 'txTotalWei', 'nonce', 'note'].includes(k)) throw new Error(`labWalReconcile: ${at} has an unknown field "${k}"`)
		if (typeof o.eventKey !== 'string' || !KEY_RE.test(o.eventKey)) throw new Error(`labWalReconcile: ${at}: eventKey must be 0x + 64 LOWER-case hex digits`)
		if (typeof o.txHash !== 'string' || !TX_RE.test(o.txHash)) throw new Error(`labWalReconcile: ${at}: txHash (the evidence) must be 0x + 64 lower-case hex digits`)
		if (typeof o.blockNumber !== 'number' || !Number.isSafeInteger(o.blockNumber) || o.blockNumber < 1) throw new Error(`labWalReconcile: ${at}: blockNumber (the evidence) must be a positive integer`)
		const amountWei = dec(o.amountWei, 'amountWei', at)
		const txTotalWei = dec(o.txTotalWei, 'txTotalWei', at)
		if (o.nonce !== undefined && (typeof o.nonce !== 'number' || !Number.isSafeInteger(o.nonce) || o.nonce < 0)) throw new Error(`labWalReconcile: ${at}: nonce must be a non-negative integer`)
		if (o.note !== undefined && (typeof o.note !== 'string' || o.note.length > 500)) throw new Error(`labWalReconcile: ${at}: note must be a string of at most 500 characters`)
		if (seen.has(o.eventKey)) throw new Error(`labWalReconcile: ${at}: duplicate eventKey ${o.eventKey}`)
		seen.add(o.eventKey)
		out.push({ eventKey: o.eventKey, txHash: o.txHash, blockNumber: o.blockNumber, amountWei, txTotalWei, ...(o.nonce !== undefined ? { nonce: o.nonce } : {}), ...(o.note !== undefined ? { note: o.note } : {}) })
	})
	return { reviewers: [rv[0] as string, rv[1] as string], entries: out }
}

export async function reconcileKeys(opts: { stateDir: string; auditDir: string; runId: string; approval: string; keysFile: string; dryRun?: boolean; now?: () => Date; hooks?: ReconcileHooks }): Promise<ReconcileResult> {
	if (!opts.runId || !RUN_ID_RE.test(opts.runId)) throw new Error('labWalReconcile: a run id is required (letters, digits, . _ -, 8 to 64 characters)')
	if (!opts.approval || opts.approval.trim().length < 3) throw new Error('labWalReconcile: the approval reference (the written release) is required')
	if (!opts.stateDir) throw new Error('labWalReconcile: a state directory is required')
	if (!opts.auditDir) throw new Error('labWalReconcile: an audit directory is required')
	if (!opts.keysFile) throw new Error('labWalReconcile: a keys file is required')
	assertAuditDirOutside(opts.stateDir, opts.auditDir)
	const keysText = fs.readFileSync(opts.keysFile, 'utf8')
	const file = parseKeysFile(keysText)
	const keys = file.entries
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
		return await reconcileLocked(opts, file, keysText, now)
	} finally {
		lock?.release()
	}
}

async function reconcileLocked(opts: { stateDir: string; auditDir: string; runId: string; approval: string; keysFile: string; dryRun?: boolean; hooks?: ReconcileHooks }, file: ReconcileFile, keysText: string, now: () => Date): Promise<ReconcileResult> {
	const keys = file.entries
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
	// R9: offline self-consistency, per tx hash. Everything refused here happens BEFORE any file or lock effect beyond the read.
	const pendingAmount = (k: string): bigint | null => {
		const e = core.pendingGet(k)
		if (!e) return null
		const a = (e as Record<string, unknown>).amount
		try {
			return typeof a === 'string' || typeof a === 'number' ? BigInt(a) : null
		} catch {
			return null
		}
	}
	const groups = new Map<string, (typeof classified)[number][]>()
	for (const k of classified) groups.set(k.txHash, [...(groups.get(k.txHash) ?? []), k])
	const txGroups: ReconcileAudit['txGroups'] = []
	for (const [txHash, list] of groups) {
		const first = list[0]!
		for (const k of list) {
			if (k.txTotalWei !== first.txTotalWei) throw new Error(`labWalReconcile: R9: tx ${txHash}: the entries declare different txTotalWei (${first.txTotalWei} and ${k.txTotalWei}). Nothing was changed`)
			if (k.blockNumber !== first.blockNumber) throw new Error(`labWalReconcile: R9: tx ${txHash}: the entries declare different blockNumbers. Nothing was changed`)
			if ((k.nonce ?? null) !== (first.nonce ?? null)) throw new Error(`labWalReconcile: R9: tx ${txHash}: the entries declare different nonces. Nothing was changed`)
		}
		let pendingSum = 0n
		let otherSum = 0n
		for (const k of list) {
			if (k.was === 'pending') {
				const pa = pendingAmount(k.eventKey)
				if (pa === null) throw new Error(`labWalReconcile: R9: key ${k.eventKey} is pending but its entry has no readable amount; cannot self-check. Nothing was changed`)
				if (pa !== BigInt(k.amountWei)) throw new Error(`labWalReconcile: R9: key ${k.eventKey}: declared amountWei ${k.amountWei} differs from the pending entry's amount ${pa}. Nothing was changed`)
				pendingSum += pa
			} else otherSum += BigInt(k.amountWei)
		}
		const sum = pendingSum + otherSum
		const ok = sum === BigInt(first.txTotalWei)
		txGroups.push({ txHash, blockNumber: first.blockNumber, nonce: first.nonce ?? null, txTotalWei: first.txTotalWei, keyCount: list.length, pendingSumWei: pendingSum.toString(), declaredOtherSumWei: otherSum.toString(), sumWei: sum.toString(), ok })
		if (!ok) throw new Error(`labWalReconcile: R9: tx ${txHash}: the keys add up to ${sum} wei (pending ${pendingSum} + declared ${otherSum}) but the tx total is ${first.txTotalWei}. A foreign or missing key, or a wrong amount: nothing was changed`)
	}
	const unverifiable = classified.filter((k) => k.was === 'neither').map((k) => ({ eventKey: k.eventKey, amountWei: k.amountWei, note: (k.note ?? '').trim() }))
	for (const u of unverifiable) if (u.note.length < 10) throw new Error(`labWalReconcile: R9: key ${u.eventKey} is neither pending nor consumed and cannot be verified offline: its entry needs a note (>= 10 characters) that explains where it comes from. Nothing was changed`)
	// R10: the settled count. Groups that are entirely consumed already were counted by a surviving settle event.
	const settledBefore = typeof core.getScalar('settledBatchCount') === 'number' ? (core.getScalar('settledBatchCount') as number) : 0
	const counted = [...groups.values()].filter((l) => l.some((k) => k.was !== 'consumed-already')).length
	const settledAfter = settledBefore + counted
	const nonces = [...new Set(keys.filter((k) => k.nonce !== undefined).map((k) => k.nonce as number))].sort((a, b) => a - b)
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
	const patch: Record<string, unknown> = { settledBatchCount: settledAfter }
	if (maxPaid !== null) patch.maxPaidHistoryBlock = maxPaid
	ops.push({ op: 'scalarsSet', patch })
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
		reviewers: file.reviewers,
		reviewersNote: 'The two reviewer ids are plain strings. This command cannot verify that two different people reviewed the list; the receipt must say so and the PM keeps the sign-offs.',
		txGroups,
		unverifiableOffline: unverifiable,
		settledBatchCountBefore: settledBefore,
		settledBatchCountAfter: settledAfter,
		distinctTxHashes: groups.size,
		distinctTxHashesCounted: counted,
		nonces,
		nonceNote: 'Compare with the Lab wallet on chain: the declared nonces (' + (nonces.length > 0 ? nonces.join(', ') : 'none declared') + ') must be consecutive and sit between the nonce of the last intact payment and the wallet\'s latest nonce.',
		keyCount: keys.length,
		keys: classified,
		counts: { wasPending: classified.filter((k) => k.was === 'pending').length, alreadyConsumed: classified.filter((k) => k.was === 'consumed-already').length, neither: classified.filter((k) => k.was === 'neither').length },
		inFlightOverlap: overlap,
		inFlightBatch:
			overlap.length > 0 && inFlight
				? {
						batchId: typeof inFlight.batchId === 'string' ? inFlight.batchId : undefined,
						idempotencyKey: typeof inFlight.idempotencyKey === 'string' ? inFlight.idempotencyKey : undefined,
						line: typeof inFlight.line === 'string' ? inFlight.line : undefined,
						amountWei: typeof inFlight.amountWei === 'string' ? inFlight.amountWei : undefined,
						eventKeyCount: Array.isArray(inFlight.eventKeys) ? inFlight.eventKeys.length : undefined,
						hash: typeof inFlight.hash === 'string' ? inFlight.hash : undefined,
					}
				: null,
		refused: overlap.length > 0,
		maxPaidHistoryBlock: maxPaid,
		historyCursor: cursor,
		maxPaidAboveCursor: maxPaid !== null && cursor !== null && maxPaid > cursor,
		ops: ops.length,
		copyFile: opts.dryRun ? null : copyName,
		note:
			'One manual-reconcile event (consumedAdd + pendingDel per key, idempotent) will be appended at seq ' +
			eventSeq +
			'. Keys that are "neither" pending nor consumed are still booked as consumed so the scan cannot re-queue them. ' +
			(overlap.length > 0
				? `REFUSED: ${overlap.length} listed key(s) belong to the current in-flight record (batch ${inFlight?.batchId ?? inFlight?.idempotencyKey ?? '?'}). Bring that batch to a final state first (settled, or confirmed not sent and released), then run again. `
				: '') +
			(maxPaid !== null && cursor !== null && maxPaid > cursor ? 'WARNING: the derived maxPaidHistoryBlock is above historyCursor (invariant C): check before starting the daemon. ' : ''),
	}
	if (opts.dryRun) return { status: 'dry-run', audit }
	if (overlap.length > 0) {
		// leave a record of the refusal outside the state dir (never the main audit file, so the run id stays usable); then refuse
		try {
			fs.mkdirSync(opts.auditDir, { recursive: true, mode: 0o700 })
			const f = path.join(opts.auditDir, `wal-reconcile-${opts.runId}.refused-${now().toISOString().replace(/[:.]/g, '-')}.json`)
			const fd = fs.openSync(f, 'wx', 0o600)
			try {
				fs.writeSync(fd, JSON.stringify(audit, null, 2) + '\n')
				fs.fsyncSync(fd)
			} finally {
				fs.closeSync(fd)
			}
		} catch {
			/* the refusal stands even if the record could not be written */
		}
		throw new Error(
			`labWalReconcile: REFUSED: ${overlap.length} listed key(s) belong to the in-flight batch ${inFlight?.batchId ?? inFlight?.idempotencyKey ?? '?'} (${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ', …' : ''}). ` +
				'Settle it, or confirm it was not sent and release it (normal in-flight recovery), then run again. Nothing was appended'
		)
	}

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
