/**
 * The offline "settle the in-flight batch only" command (review R11). Local temp dirs only; the signer and the chain are test doubles that can only READ.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { acquireStateDirLock } from './labClPayoutStateLock'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WAL_DIR, WalWriter, listSegments, type WalOp } from './labWal'
import { defaultReaders, resolveInFlight, type InFlightReaders, type ResolveOptions } from './labWalResolveInFlight'
import { reconcileKeys } from './labWalReconcile'

const hex = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
const K = [hex(0xa1), hex(0xa2), hex(0xa3)]
const HASH = hex(0xeee1)
const IDEM = 'lab-withdrawNative:abc123'
const RUN = 'run-20261121-res1'
const APPROVAL = 'PM-2026-11-21-03'
const fatal = (e: Error): void => {
	throw e
}
type World = { root: string; stateDir: string; auditDir: string }

const ADD3: WalOp[] = [
	{ op: 'pendingAdd', entry: { eventKey: K[0]!, blockNumber: 100, withdrawalIndex: 0, amount: '1000' } },
	{ op: 'pendingAdd', entry: { eventKey: K[1]!, blockNumber: 120, withdrawalIndex: 1, amount: '2000' } },
	{ op: 'pendingAdd', entry: { eventKey: K[2]!, blockNumber: 700, withdrawalIndex: 0, amount: '3000' } },
	{ op: 'scalarsSet', patch: { historyCursor: 200, settledBatchCount: 7 } },
]
const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ line: 'history', redeem: '0xr', pool: '0xp', amountWei: '3000', eventKeys: [K[0], K[1]], requestFingerprint: '0xf', idempotencyKey: IDEM, createdAt: '2026-11-21T00:00:00.000Z', ...over })

async function world(inFlight: Record<string, unknown> | null): Promise<World> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labresolve-'))
	const stateDir = path.join(root, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 100000, onFatal: fatal })
	const ps = [core.record(wal, 'scan', ADD3).durable]
	if (inFlight) ps.push(core.record(wal, 'intent', [{ op: 'inFlightSet', record: inFlight }]).durable)
	await Promise.all(ps)
	await wal.close()
	return { root, stateDir, auditDir: path.join(root, 'audit') }
}
const done = (w: World): void => fs.rmSync(w.root, { recursive: true, force: true })
const walFiles = (w: World): string[] => listSegments(path.join(w.stateDir, WAL_DIR)).map((s) => s.file)

const readers = (o: { signer?: { hash?: string; status?: string } | null | Error; receipt?: { status: number; blockNumber: number } | null | Error }): InFlightReaders & { calls: string[] } => {
	const calls: string[] = []
	return {
		calls,
		signerRecord: async (k) => {
			calls.push(`signer:${k}`)
			if (o.signer instanceof Error) throw o.signer
			return o.signer ?? null
		},
		receipt: async (h) => {
			calls.push(`receipt:${h}`)
			if (o.receipt instanceof Error) throw o.receipt
			return o.receipt ?? null
		},
	}
}
const args = (w: World, r: InFlightReaders, over: Partial<ResolveOptions> = {}): ResolveOptions => ({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: APPROVAL, expectIdempotencyKey: IDEM, readers: r, ...over })

test('SETTLED: a hash and a receipt with status 1 - the batch is booked exactly as the lost settle would have (keys consumed and gone from pending, record cleared, count +1, high-water derived); audit, one event, done record', async () => {
	const w = await world(rec({ hash: HASH }))
	try {
		const rd = readers({ signer: { hash: HASH, status: 'mined' }, receipt: { status: 1, blockNumber: 5555 } })
		const r = await resolveInFlight(args(w, rd))
		assert.equal(r.status, 'appended')
		if (r.status !== 'appended') return
		assert.equal(r.audit.decision, 'settled')
		assert.equal(r.audit.amountCheck, 'ok')
		assert.equal(r.audit.settledBatchCountBefore, 7)
		assert.equal(r.audit.settledBatchCountAfter, 8)
		assert.equal(r.audit.maxPaidHistoryBlock, 120)
		assert.equal(r.eventSeq, 3)
		assert.deepEqual(rd.calls, [`signer:${IDEM}`, `receipt:${HASH}`], 'only reads, one of each')
		const after = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(after.core.getInFlight(), null)
		for (const k of [K[0]!, K[1]!]) {
			assert.equal(after.core.consumedHas(k), true)
			assert.equal(after.core.pendingHas(k), false)
		}
		assert.equal(after.core.pendingHas(K[2]!), true)
		assert.equal(after.core.getScalar('settledBatchCount'), 8)
		assert.equal(after.core.getScalar('maxPaidHistoryBlock'), 120)
		assert.deepEqual(after.warnings, [])
		const d = JSON.parse(fs.readFileSync(r.doneFile, 'utf8'))
		assert.equal(d.decision, 'settled')
		assert.equal(d.eventSeq, 3)
	} finally {
		done(w)
	}
})

test('a record without a hash is settled from the signer\'s hash and the receipt; dry-run reads and prints the decision but writes nothing and takes no lock', async () => {
	const w = await world(rec())
	try {
		const before = walFiles(w)
		const held = acquireStateDirLock(w.stateDir)
		try {
			const dry = await resolveInFlight(args(w, readers({ signer: { hash: HASH, status: 'mined' }, receipt: { status: 1, blockNumber: 9 } }), { dryRun: true }))
			if (dry.status !== 'dry-run') throw new Error('expected a dry run')
			assert.equal(dry.audit.decision, 'settled')
			assert.equal(dry.audit.hashUsed, HASH)
			assert.match(dry.audit.note, /booked as settled at seq 3/)
		} finally {
			held.release()
		}
		assert.deepEqual(walFiles(w), before)
		assert.equal(fs.existsSync(w.auditDir), false)
		const r = await resolveInFlight(args(w, readers({ signer: { hash: HASH }, receipt: { status: 1, blockNumber: 9 } })))
		assert.equal(r.status, 'appended')
	} finally {
		done(w)
	}
})

test('UNKNOWN always refuses and writes nothing (no audit, no event): no receipt, receipt unreadable, signer unreadable with no hash, no signer record, hash conflict, stuck/sent, amount mismatch', async () => {
	const cases: { name: string; inFlight: Record<string, unknown>; r: InFlightReaders; re: RegExp }[] = [
		{ name: 'no receipt yet', inFlight: rec({ hash: HASH }), r: readers({ receipt: null }), re: /no receipt on chain yet/ },
		{ name: 'receipt unreadable', inFlight: rec({ hash: HASH }), r: readers({ receipt: new Error('rpc down') }), re: /receipt could not be read: rpc down/ },
		{ name: 'signer unreadable, no hash', inFlight: rec(), r: readers({ signer: new Error('socket gone') }), re: /signer could not be read: socket gone/ },
		{ name: 'no signer record, no hash', inFlight: rec(), r: readers({ signer: null }), re: /"never sent" cannot be proven offline/ },
		{ name: 'hash conflict', inFlight: rec({ hash: HASH }), r: readers({ signer: { hash: hex(0xdead) }, receipt: { status: 1, blockNumber: 1 } }), re: /differ/ },
		{ name: 'signer sent, no hash', inFlight: rec(), r: readers({ signer: { status: 'sent' } }), re: /signer record is "sent": unknown/ },
		{ name: 'stuck', inFlight: rec(), r: readers({ signer: { status: 'stuck' } }), re: /"stuck": unknown/ },
		{ name: 'amount mismatch', inFlight: rec({ hash: HASH, amountWei: '3001' }), r: readers({ receipt: { status: 1, blockNumber: 1 } }), re: /add up to 3000 wei but the record says 3001/ },
	]
	for (const c of cases) {
		const w = await world(c.inFlight)
		try {
			const before = walFiles(w)
			await assert.rejects(resolveInFlight(args(w, c.r)), /UNKNOWN/, c.name)
			const dry = await resolveInFlight(args(w, c.r, { dryRun: true }))
			if (dry.status !== 'dry-run') throw new Error('expected a dry run')
			assert.equal(dry.audit.decision, 'unknown', c.name)
			assert.match(dry.audit.reason, c.re, c.name)
			assert.deepEqual(walFiles(w), before, `${c.name}: nothing appended`)
			assert.equal(fs.existsSync(w.auditDir), false, `${c.name}: nothing written`)
			assert.notEqual(recoverPayoutState(w.stateDir, { readOnly: true }).core.getInFlight(), null, `${c.name}: the record is still there`)
		} finally {
			done(w)
		}
	}
})

test('RELEASED needs --allow-release: a reverted receipt (status 0) or a signer "rejected" with no hash releases the record, the keys stay pending; without the flag it refuses', async () => {
	let w = await world(rec({ hash: HASH }))
	try {
		await assert.rejects(resolveInFlight(args(w, readers({ receipt: { status: 0, blockNumber: 3 } }))), /pass --allow-release/)
		const r = await resolveInFlight(args(w, readers({ receipt: { status: 0, blockNumber: 3 } }), { allowRelease: true }))
		assert.equal(r.status, 'appended')
		if (r.status !== 'appended') return
		assert.equal(r.audit.decision, 'released')
		assert.equal(r.audit.ops, 1)
		const after = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(after.core.getInFlight(), null)
		assert.equal(after.core.pendingHas(K[0]!), true, 'the keys stay pending')
		assert.equal(after.core.consumedHas(K[0]!), false)
		assert.equal(after.core.getScalar('settledBatchCount'), 7, 'no batch was settled')
	} finally {
		done(w)
	}
	w = await world(rec())
	try {
		await assert.rejects(resolveInFlight(args(w, readers({ signer: { status: 'rejected' } }))), /UNKNOWN/)
		const r = await resolveInFlight(args(w, readers({ signer: { status: 'rejected' } }), { allowRelease: true }))
		assert.equal(r.status, 'appended')
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).core.getInFlight(), null)
	} finally {
		done(w)
	}
})

test('guards: wrong expected idempotency key, no in-flight record, lock held, audit write failure, crash between audit and append, repeated run id, damaged log - each appends nothing', async () => {
	let w = await world(null)
	try {
		await assert.rejects(resolveInFlight(args(w, readers({}))), /no in-flight record/)
	} finally {
		done(w)
	}
	w = await world(rec({ hash: HASH }))
	try {
		const ok = readers({ receipt: { status: 1, blockNumber: 1 } })
		const before = walFiles(w)
		await assert.rejects(resolveInFlight(args(w, ok, { expectIdempotencyKey: 'lab-withdrawNative:other' })), /not the expected one/)
		const held = acquireStateDirLock(w.stateDir)
		try {
			await assert.rejects(resolveInFlight(args(w, ok)), /cannot take the state directory lock.*stop the daemon first.*Nothing was changed/s)
		} finally {
			held.release()
		}
		fs.mkdirSync(w.auditDir, { mode: 0o500 })
		await assert.rejects(resolveInFlight(args(w, ok)), /EACCES|EPERM/)
		fs.chmodSync(w.auditDir, 0o700)
		await assert.rejects(resolveInFlight(args(w, ok, { hooks: { beforeAppend: () => { throw new Error('crash before the append') } } })), /crash before the append/)
		assert.deepEqual(walFiles(w), before, 'no event appended by any of the failures')
		await assert.rejects(resolveInFlight(args(w, ok)), /already used|EEXIST/)
		const fine = await resolveInFlight(args(w, ok, { runId: 'run-20261121-res2' }))
		assert.equal(fine.status, 'appended')
		await assert.rejects(resolveInFlight(args(w, ok)), /already used|EEXIST|no in-flight record/)
	} finally {
		fs.chmodSync(w.auditDir, 0o700)
		done(w)
	}
	w = await world(rec({ hash: HASH }))
	try {
		const file = path.join(w.stateDir, WAL_DIR, listSegments(path.join(w.stateDir, WAL_DIR))[0]!.file)
		const buf = fs.readFileSync(file)
		buf[40] = buf[40]! ^ 0x55
		fs.writeFileSync(file, buf)
		await assert.rejects(resolveInFlight(args(w, readers({ receipt: { status: 1, blockNumber: 1 } }))), /damage in the middle|torn tail/)
	} finally {
		done(w)
	}
})

test('R11 closure: reconcile refuses while a listed key is in flight; after the offline resolve the same list is accepted (its keys are consumed already: not counted twice)', async () => {
	const w = await world(rec({ hash: HASH }))
	try {
		const keysFile = path.join(w.root, 'keys.json')
		const entry = (k: string, i: number, amt: string): Record<string, unknown> => ({ eventKey: k, txHash: hex(0xf00 + i), blockNumber: 9000, amountWei: amt, txTotalWei: amt, nonce: 40 + i })
		fs.writeFileSync(keysFile, JSON.stringify({ reviewers: ['alice@ops', 'bob@ops'], entries: [entry(K[0]!, 1, '1000'), entry(K[2]!, 2, '3000')] }))
		await assert.rejects(reconcileKeys({ stateDir: w.stateDir, auditDir: path.join(w.root, 'rec-audit'), runId: 'run-20261121-rec1', approval: APPROVAL, keysFile }), /REFUSED: 1 listed key\(s\) belong to the in-flight batch/)
		const r = await resolveInFlight(args(w, readers({ receipt: { status: 1, blockNumber: 7 } })))
		assert.equal(r.status, 'appended')
		const ok = await reconcileKeys({ stateDir: w.stateDir, auditDir: path.join(w.root, 'rec-audit'), runId: 'run-20261121-rec1', approval: APPROVAL, keysFile })
		assert.equal(ok.status, 'appended')
		if (ok.status !== 'appended') return
		assert.equal(ok.audit.counts.alreadyConsumed, 1, 'K0 was booked by the resolve')
		assert.equal(ok.audit.settledBatchCountBefore, 8)
		assert.equal(ok.audit.distinctTxHashesCounted, 1, 'only the tx of K2 is counted: K0\'s group is already consumed')
		assert.equal(ok.audit.settledBatchCountAfter, 9)
	} finally {
		done(w)
	}
})

test('read-only readers and no WebSocket: ws:// and wss:// RPC URLs are refused, the command source has no write call to the signer or chain and no WebSocket, the daemon and the other modules never reference it, CLI is strict', async () => {
	assert.throws(() => defaultReaders({ signerSocket: '/tmp/x.sock', rpcUrl: 'ws://127.0.0.1:8545' }), /http:\/\/ or https:\/\//)
	assert.throws(() => defaultReaders({ signerSocket: '/tmp/x.sock', rpcUrl: 'wss://rpc.example' }), /http:\/\/ or https:\/\//)
	assert.doesNotThrow(() => defaultReaders({ signerSocket: '/tmp/x.sock', rpcUrl: 'http://127.0.0.1:8545' }))
	const src = fs.readFileSync(path.join(__dirname, 'labWalResolveInFlight.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
	assert.doesNotMatch(src, /WebSocket|wss?:\/\/|signer_sendTransaction|sendTransaction|sendRawTransaction|labPayoutSignerSendOnce|process\.env/)
	for (const f of ['validatorLabMiningPoolClPayoutReporter.ts', 'labPayoutRecovery.ts', 'labPayoutStateCore.ts', 'labSnapshotWriter.ts', 'labWal.ts', 'labMiningPoolClPayoutDaemon.ts']) {
		const text = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		assert.doesNotMatch(text, /labWalResolveInFlight|resolveInFlight/, f)
	}
	const w = await world(rec({ hash: HASH }))
	try {
		const script = join(__dirname, 'labWalResolveInFlight.ts')
		const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
		const run = (a: string[]) => spawnSync(process.execPath, [...loader, script, ...a], { encoding: 'utf8' })
		const base = ['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', RUN, '--approval', APPROVAL, '--idempotency-key', IDEM, '--signer-socket', '/tmp/none.sock']
		const ws = run([...base, '--rpc-url', 'ws://127.0.0.1:1', '--dry-run'])
		assert.equal(ws.status, 2)
		assert.match(ws.stderr, /http:\/\/ or https:\/\//)
		const swallowed = run(['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', '--approval', APPROVAL, '--idempotency-key', IDEM, '--signer-socket', '/tmp/none.sock', '--rpc-url', 'http://127.0.0.1:1'])
		assert.equal(swallowed.status, 2)
		assert.match(swallowed.stderr, /--run-id needs a value/)
		assert.equal(run([...base, '--rpc-url', 'http://127.0.0.1:1', '--force']).status, 2)
		assert.equal(fs.existsSync(w.auditDir), false)
	} finally {
		done(w)
	}
})
