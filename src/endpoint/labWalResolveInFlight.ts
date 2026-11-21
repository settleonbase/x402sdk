/**
 * Offline "settle the in-flight batch only" command (review R11; PM decision: option 2). It brings the in-flight withdrawal record of a STOPPED daemon to a final state without starting the
 * daemon, so that nothing can be paid on the side: no scan, no new batch, no signer write.
 *
 * It only READS: the signer's record for the in-flight idempotency key (signer_getTransaction over the local unix socket) and the on-chain receipt (eth_getTransactionReceipt over an http(s) URL; a ws:// or
 * wss:// URL is refused - no WebSocket). Decision, the same one the daemon's own resume path takes, with every doubt resolved towards "stay stopped":
 *   - a hash (from the record, or from the signer) and a receipt with status 1          -> SETTLED: consumedAdd + pendingDel for the record's keys, inFlightSet(null), settledBatchCount + 1,
 *                                                                                          maxPaidHistoryBlock derived from the history keys (max-merge), exactly what the lost settle carried;
 *   - a receipt with status 0, or no hash and a signer record with status "rejected"  -> RELEASED (only with --allow-release): inFlightSet(null); the keys stay pending and are paid by the normal flow;
 *   - anything else (no hash, no signer record, signer unreadable, receipt not available, signer and record disagree on the hash, stuck/sent) -> UNKNOWN: refuse, nothing is written.
 * Same discipline as the other offline commands: the state-directory lock (the daemon's), a run id and an approval reference (a plain string), the audit first (outside the state dir, exclusive create,
 * fsync), then exactly ONE event (t='manual-resolve-inflight') through the daemon's writer, read back, then a .done.json. The expected idempotency key must be given and must equal the record's (typo guard).
 * `--dry-run` reads and prints the decision and the audit; it writes nothing and takes no lock. The daemon does not reference this command.
 *
 * Usage: node labWalResolveInFlight.js --state-dir <dir> --audit-dir <dir outside> --run-id <id> --approval <ref> --idempotency-key <key> --signer-socket <path> --rpc-url <http(s)> [--allow-release] [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ethers } from 'ethers'
import { acquireStateDirLock } from './labClPayoutStateLock'
import { readLabSignerTransactionRecord } from './labMiningPoolPayoutSigner'
import { recoverPayoutState } from './labPayoutRecovery'
import { WAL_DIR, WalMidCorruptionError, WalWriter, scanWal, segmentFileName, type WalOp } from './labWal'
import { RUN_ID_RE, assertAuditDirOutside, readSnapshotWalSeq } from './labWalRepair'

export type InFlightReaders = {
	/** Read-only. null = the signer answered with an empty result. MUST throw when it cannot read (so "no record" and "could not read" differ). */
	signerRecord(idempotencyKey: string): Promise<{ hash?: string; status?: string } | null>
	/** Read-only. null = the chain has no receipt (yet). MUST throw when it cannot read. */
	receipt(hash: string): Promise<{ status: number; blockNumber: number } | null>
}

export function defaultReaders(opts: { signerSocket: string; rpcUrl: string }): InFlightReaders {
	if (!/^https?:\/\//i.test(opts.rpcUrl)) throw new Error('labWalResolveInFlight: the RPC URL must be http:// or https:// (only plain HTTP endpoints are allowed)')
	const provider = new ethers.JsonRpcProvider(opts.rpcUrl)
	return {
		signerRecord: async (key) => {
			const r = await readLabSignerTransactionRecord(opts.signerSocket, key)
			return r === null ? null : { hash: r.hash, status: r.status }
		},
		receipt: async (hash) => {
			const r = await provider.getTransactionReceipt(hash)
			return r === null ? null : { status: r.status ?? 0, blockNumber: r.blockNumber }
		},
	}
}

export type ResolveDecision = 'settled' | 'released' | 'unknown'

export type ResolveAudit = {
	runId: string
	approval: string
	approvalVerified: false
	approvalNote: string
	at: string
	dryRun: boolean
	stateDir: string
	snapshotWalSeq: number
	lastSeqBefore: number
	eventSeq: number
	decision: ResolveDecision
	reason: string
	inFlight: { batchId?: string; idempotencyKey: string; line?: string; amountWei?: string; eventKeyCount: number; hash?: string; createdAt?: string }
	signerRecord: { hash?: string; status?: string } | null
	signerReadError: string | null
	hashUsed: string | null
	receipt: { status: number; blockNumber: number } | null
	receiptReadError: string | null
	keys: { eventKey: string; was: 'pending' | 'consumed-already' | 'neither' }[]
	pendingSumWei: string
	amountCheck: 'ok' | 'mismatch' | 'not-checkable'
	settledBatchCountBefore: number
	settledBatchCountAfter: number | null
	maxPaidHistoryBlock: number | null
	historyCursor: number | null
	maxPaidAboveCursor: boolean
	ops: number
	note: string
}

export type ResolveResult =
	| { status: 'dry-run'; audit: ResolveAudit }
	| { status: 'appended'; audit: ResolveAudit; auditFile: string; doneFile: string; eventSeq: number }

export type ResolveHooks = { beforeAppend?: () => void }

export type ResolveOptions = {
	stateDir: string
	auditDir: string
	runId: string
	approval: string
	expectIdempotencyKey: string
	readers: InFlightReaders
	allowRelease?: boolean
	dryRun?: boolean
	now?: () => Date
	hooks?: ResolveHooks
}

export async function resolveInFlight(opts: ResolveOptions): Promise<ResolveResult> {
	if (!opts.runId || !RUN_ID_RE.test(opts.runId)) throw new Error('labWalResolveInFlight: a run id is required (letters, digits, . _ -, 8 to 64 characters)')
	if (!opts.approval || opts.approval.trim().length < 3) throw new Error('labWalResolveInFlight: the approval reference (the written release) is required')
	if (!opts.stateDir) throw new Error('labWalResolveInFlight: a state directory is required')
	if (!opts.auditDir) throw new Error('labWalResolveInFlight: an audit directory is required')
	if (!opts.expectIdempotencyKey) throw new Error('labWalResolveInFlight: the expected idempotency key is required')
	assertAuditDirOutside(opts.stateDir, opts.auditDir)
	let lock: { release: () => void } | null = null
	if (!opts.dryRun) {
		try {
			lock = acquireStateDirLock(opts.stateDir)
		} catch (e) {
			throw new Error(`labWalResolveInFlight: cannot take the state directory lock (${e instanceof Error ? e.message : String(e)}); stop the daemon first. Nothing was changed`)
		}
	}
	try {
		return await resolveLocked(opts)
	} finally {
		lock?.release()
	}
}

async function resolveLocked(opts: ResolveOptions): Promise<ResolveResult> {
	const now = opts.now ?? (() => new Date())
	const snap = readSnapshotWalSeq(opts.stateDir)
	let rec
	try {
		rec = recoverPayoutState(opts.stateDir, { readOnly: true })
	} catch (e) {
		if (e instanceof WalMidCorruptionError) throw new Error('labWalResolveInFlight: the log has damage in the middle; run the audited repair first. Nothing was changed')
		throw e
	}
	if (rec.scan.truncatedBytes > 0) throw new Error(`labWalResolveInFlight: the log ends in a torn tail (${rec.scan.truncatedBytes} bytes); repair first. Nothing was changed`)
	const core = rec.core
	const rec1 = core.getInFlight()
	if (!rec1) throw new Error('labWalResolveInFlight: there is no in-flight record; nothing to resolve. Nothing was changed')
	const idem = typeof rec1.idempotencyKey === 'string' ? rec1.idempotencyKey : ''
	if (idem !== opts.expectIdempotencyKey) throw new Error(`labWalResolveInFlight: the in-flight record's idempotency key (${idem}) is not the expected one (${opts.expectIdempotencyKey}). Nothing was changed`)
	const keys = (Array.isArray(rec1.eventKeys) ? (rec1.eventKeys as unknown[]) : []).filter((k): k is string => typeof k === 'string')
	if (keys.length === 0) throw new Error('labWalResolveInFlight: the in-flight record has no event keys. Nothing was changed')
	const lastSeqBefore = rec.writerLastSeq
	const eventSeq = lastSeqBefore + 1

	// the read-only reads
	let signer: { hash?: string; status?: string } | null = null
	let signerErr: string | null = null
	try {
		signer = await opts.readers.signerRecord(idem)
	} catch (e) {
		signerErr = e instanceof Error ? e.message : String(e)
	}
	const recHash = typeof rec1.hash === 'string' ? rec1.hash : undefined
	let decision: ResolveDecision = 'unknown'
	let reason = ''
	let hashUsed: string | null = null
	let receipt: { status: number; blockNumber: number } | null = null
	let receiptErr: string | null = null
	if (recHash && signer?.hash && recHash.toLowerCase() !== signer.hash.toLowerCase()) {
		reason = `the in-flight record's hash (${recHash}) and the signer's hash (${signer.hash}) differ`
	} else {
		hashUsed = recHash ?? signer?.hash ?? null
		if (hashUsed) {
			try {
				receipt = await opts.readers.receipt(hashUsed)
			} catch (e) {
				receiptErr = e instanceof Error ? e.message : String(e)
			}
			if (receiptErr) reason = `the receipt could not be read: ${receiptErr}`
			else if (receipt === null) reason = 'no receipt on chain yet (pending or never mined)'
			else if (receipt.status === 1) {
				decision = 'settled'
				reason = `receipt status 1 at block ${receipt.blockNumber}`
			} else if (opts.allowRelease) {
				decision = 'released'
				reason = `receipt status ${receipt.status} (reverted): the batch moved no money; --allow-release given`
			} else reason = `receipt status ${receipt.status} (reverted); pass --allow-release to release the record (the keys stay pending)`
		} else if (signerErr) reason = `no hash on the record and the signer could not be read: ${signerErr}`
		else if (signer === null) reason = 'no hash on the record and the signer has no record for the key: "never sent" cannot be proven offline'
		else if (signer.status === 'rejected' && opts.allowRelease) {
			decision = 'released'
			reason = 'the signer rejected the request (never broadcast); --allow-release given'
		} else reason = `no hash and the signer record is "${signer.status ?? '?'}": unknown`
	}

	// self-check of the amounts for the keys that are still pending (same discipline as the reconcile command)
	const classified = keys.map((k) => ({ eventKey: k, was: (core.pendingHas(k) ? 'pending' : core.consumedHas(k) ? 'consumed-already' : 'neither') as 'pending' | 'consumed-already' | 'neither' }))
	let pendingSum = 0n
	let readable = true
	for (const k of classified) {
		if (k.was !== 'pending') continue
		const a = (core.pendingGet(k.eventKey) as Record<string, unknown> | undefined)?.amount
		try {
			pendingSum += BigInt(a as string)
		} catch {
			readable = false
		}
	}
	const allPending = classified.every((k) => k.was === 'pending')
	const recAmount = typeof rec1.amountWei === 'string' ? rec1.amountWei : undefined
	const amountCheck: ResolveAudit['amountCheck'] = !allPending || !readable || !recAmount ? 'not-checkable' : pendingSum === BigInt(recAmount) ? 'ok' : 'mismatch'
	if (decision === 'settled' && amountCheck === 'mismatch') {
		decision = 'unknown'
		reason = `the pending entries of the record's keys add up to ${pendingSum} wei but the record says ${recAmount}: refusing to book`
	}

	const fh = core.freezeHeight()
	let maxPaid: number | null = null
	for (const k of classified) {
		const e = core.pendingGet(k.eventKey)
		const b = e && typeof e.blockNumber === 'number' ? e.blockNumber : null
		if (b !== null && fh !== null && b <= fh && (maxPaid === null || b > maxPaid)) maxPaid = b
	}
	const cursor = typeof core.getScalar('historyCursor') === 'number' ? (core.getScalar('historyCursor') as number) : null
	const before = typeof core.getScalar('settledBatchCount') === 'number' ? (core.getScalar('settledBatchCount') as number) : 0
	const ops: WalOp[] = []
	if (decision === 'settled') {
		for (const k of keys) ops.push({ op: 'consumedAdd', key: k }, { op: 'pendingDel', key: k })
		ops.push({ op: 'inFlightSet', record: null })
		const patch: Record<string, unknown> = { settledBatchCount: before + 1 }
		if (maxPaid !== null) patch.maxPaidHistoryBlock = maxPaid
		ops.push({ op: 'scalarsSet', patch })
	} else if (decision === 'released') ops.push({ op: 'inFlightSet', record: null })

	const audit: ResolveAudit = {
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
		decision,
		reason,
		inFlight: { batchId: typeof rec1.batchId === 'string' ? rec1.batchId : undefined, idempotencyKey: idem, line: typeof rec1.line === 'string' ? rec1.line : undefined, amountWei: recAmount, eventKeyCount: keys.length, hash: recHash, createdAt: typeof rec1.createdAt === 'string' ? rec1.createdAt : undefined },
		signerRecord: signer,
		signerReadError: signerErr,
		hashUsed,
		receipt,
		receiptReadError: receiptErr,
		keys: classified,
		pendingSumWei: pendingSum.toString(),
		amountCheck,
		settledBatchCountBefore: before,
		settledBatchCountAfter: decision === 'settled' ? before + 1 : null,
		maxPaidHistoryBlock: decision === 'settled' ? maxPaid : null,
		historyCursor: cursor,
		maxPaidAboveCursor: decision === 'settled' && maxPaid !== null && cursor !== null && maxPaid > cursor,
		ops: ops.length,
		note:
			decision === 'unknown'
				? `UNKNOWN: ${reason}. Nothing will be written; keep the daemon stopped and escalate (signer record and chain evidence by hand).`
				: decision === 'settled'
					? `The batch is booked as settled at seq ${eventSeq}: ${keys.length} key(s) consumed and removed from pending, record cleared, settled count ${before} -> ${before + 1}.`
					: `The in-flight record is released at seq ${eventSeq}; the ${keys.length} key(s) stay pending and will be paid by the normal flow. Only do this when money did not move.`,
	}
	if (opts.dryRun) return { status: 'dry-run', audit }
	if (decision === 'unknown') throw new Error(`labWalResolveInFlight: UNKNOWN: ${reason}. Nothing was changed; keep the daemon stopped and escalate`)

	fs.mkdirSync(opts.auditDir, { recursive: true, mode: 0o700 })
	const writeExclusive = (name: string, data: string): string => {
		const file = path.join(opts.auditDir, name)
		const fd = fs.openSync(file, 'wx', 0o600)
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
	const auditName = `wal-resolve-inflight-${opts.runId}.json`
	if (fs.existsSync(path.join(opts.auditDir, auditName))) throw new Error(`labWalResolveInFlight: run id ${opts.runId} was already used (audit file exists); use a new run id. Nothing was changed`)
	const auditFile = writeExclusive(auditName, JSON.stringify(audit, null, 2) + '\n')
	const dfd = fs.openSync(opts.auditDir, 'r')
	try {
		fs.fsyncSync(dfd)
	} finally {
		fs.closeSync(dfd)
	}
	opts.hooks?.beforeAppend?.()
	assertAuditDirOutside(opts.stateDir, opts.auditDir)

	const wal = new WalWriter({ stateDir: opts.stateDir, lastSeq: lastSeqBefore, onFatal: (e) => { throw e } })
	const { seq, durable } = wal.append('manual-resolve-inflight', ops)
	if (seq !== eventSeq) throw new Error(`labWalResolveInFlight: the writer assigned seq ${seq}, expected ${eventSeq}`)
	await durable
	await wal.close()
	let lastT = ''
	let lastOps = ''
	let lastTs = ''
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
	if (res.lastSeq !== eventSeq || lastT !== 'manual-resolve-inflight' || lastOps !== JSON.stringify(ops)) throw new Error('labWalResolveInFlight: the appended event did not read back as written; check the log before starting the daemon')
	const segFile = path.join(opts.stateDir, WAL_DIR, segmentFileName(eventSeq))
	const done = { runId: opts.runId, eventSeq, eventTs: lastTs, decision, segmentFile: path.basename(segFile), segmentSha256: createHash('sha256').update(fs.readFileSync(segFile)).digest('hex'), ops: ops.length }
	const doneFile = writeExclusive(`wal-resolve-inflight-${opts.runId}.done.json`, JSON.stringify(done, null, 2) + '\n')
	return { status: 'appended', audit, auditFile, doneFile, eventSeq }
}

if (require.main === module) {
	// Arguments only: no environment variable is read, so no standing setting can enable this.
	void (async () => {
		try {
			const argv = process.argv.slice(2)
			const valueFlags = ['--state-dir', '--audit-dir', '--run-id', '--approval', '--idempotency-key', '--signer-socket', '--rpc-url']
			const boolFlags = ['--allow-release', '--dry-run']
			const values: Record<string, string> = {}
			const bools = new Set<string>()
			for (let i = 0; i < argv.length; i++) {
				const a = argv[i]!
				if (boolFlags.includes(a)) bools.add(a)
				else if (valueFlags.includes(a)) {
					const v = argv[i + 1]
					if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value (got ${v === undefined ? 'nothing' : `"${v}"`})`)
					if (a in values) throw new Error(`${a} given twice`)
					values[a] = v
					i++
				} else throw new Error(`unknown argument "${a}"`)
			}
			const r = await resolveInFlight({
				stateDir: values['--state-dir'] ?? '',
				auditDir: values['--audit-dir'] ?? '',
				runId: values['--run-id'] ?? '',
				approval: values['--approval'] ?? '',
				expectIdempotencyKey: values['--idempotency-key'] ?? '',
				readers: defaultReaders({ signerSocket: values['--signer-socket'] ?? '', rpcUrl: values['--rpc-url'] ?? '' }),
				allowRelease: bools.has('--allow-release'),
				dryRun: bools.has('--dry-run'),
			})
			process.stdout.write(JSON.stringify(r, null, 2) + '\n')
			process.exit(0)
		} catch (e) {
			process.stderr.write(`labWalResolveInFlight: ${e instanceof Error ? e.message : String(e)}\n`)
			process.exit(2)
		}
	})()
}
