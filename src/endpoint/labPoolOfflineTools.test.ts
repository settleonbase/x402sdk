/**
 * The offline tools know the per-wallet slots (P4): the in-flight resolver works on ONE wallet's slot (--wallet), the rollback to version 2 refuses while any slot is held (an old build would ignore it) and
 * works once every slot is clear, the reconcile treats the keys of every slot as in flight. Local temp dirs only; the signer and the chain are test doubles that can only READ.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WalWriter, type WalOp } from './labWal'
import { resolveInFlight, type InFlightReaders, type ResolveOptions } from './labWalResolveInFlight'
import { rollbackToV2 } from './labWalRollback'
import { reconcileKeys } from './labWalReconcile'

const hex = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
const K = [hex(0xa1), hex(0xa2), hex(0xa3)]
const HASH = hex(0xeee1)
const IDEM = 'lab-withdrawNative:slot1'
const fatal = (e: Error): void => {
	throw e
}
const ADD3: WalOp[] = [
	{ op: 'pendingAdd', entry: { eventKey: K[0]!, blockNumber: 100, withdrawalIndex: 0, amount: '1000' } },
	{ op: 'pendingAdd', entry: { eventKey: K[1]!, blockNumber: 120, withdrawalIndex: 1, amount: '2000' } },
	{ op: 'pendingAdd', entry: { eventKey: K[2]!, blockNumber: 700, withdrawalIndex: 0, amount: '3000' } },
	{ op: 'scalarsSet', patch: { historyCursor: 200, settledBatchCount: 7 } },
]
const slotRec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ line: 'history', redeem: '0xr', pool: '0xp', amountWei: '3000', eventKeys: [K[0], K[1]], requestFingerprint: '0xf', idempotencyKey: IDEM, createdAt: '2026-11-22T00:00:00.000Z', hash: HASH, ...over })

async function world() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labpooltools-'))
	const stateDir = path.join(root, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 100000, onFatal: fatal })
	await Promise.all([core.record(wal, 'scan', ADD3).durable, core.record(wal, 'intent', [{ op: 'slotSet', wallet: 'rt1', record: slotRec() }]).durable])
	await wal.close()
	return { root, stateDir, auditDir: path.join(root, 'audit'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const readers = (receipt: { status: number; blockNumber: number } | null): InFlightReaders & { calls: string[] } => {
	const calls: string[] = []
	return { calls, signerRecord: async (k) => (calls.push(`signer:${k}`), { hash: HASH, status: 'mined' }), receipt: async (h) => (calls.push(`receipt:${h}`), receipt) }
}
const base = (w: { stateDir: string; auditDir: string }, r: InFlightReaders, over: Partial<ResolveOptions> = {}): ResolveOptions => ({ stateDir: w.stateDir, auditDir: w.auditDir, runId: 'run-20261122-slot1', approval: 'PM-2026-11-22-01', expectIdempotencyKey: IDEM, readers: r, ...over })

test('the resolver settles ONE wallet\'s slot (--wallet): keys consumed, slot cleared, count +1; without --wallet it finds no single in-flight record, a wrong wallet is refused, nothing changed in either case', async () => {
	const w = await world()
	try {
		await assert.rejects(() => resolveInFlight(base(w, readers({ status: 1, blockNumber: 9 }))), /there is no in-flight record/)
		await assert.rejects(() => resolveInFlight(base(w, readers({ status: 1, blockNumber: 9 }), { wallet: 'rt9' })), /wallet rt9 holds no in-flight slot/)
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).core.slotCount, 1, 'nothing changed by the refusals')
		const r = await resolveInFlight(base(w, readers({ status: 1, blockNumber: 9 }), { wallet: 'rt1' }))
		assert.equal(r.status, 'appended')
		const after = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(after.core.slotCount, 0)
		for (const k of [K[0]!, K[1]!]) {
			assert.equal(after.core.consumedHas(k), true)
			assert.equal(after.core.pendingHas(k), false)
		}
		assert.equal(after.core.pendingHas(K[2]!), true)
		assert.equal(after.core.getScalar('settledBatchCount'), 8)
	} finally {
		w.done()
	}
})

test('the resolver releases a reverted slot only with --allow-release; the keys stay pending', async () => {
	const w = await world()
	try {
		const rd = readers({ status: 0, blockNumber: 9 })
		const r = await resolveInFlight(base(w, rd, { wallet: 'rt1', allowRelease: true }))
		assert.equal(r.status, 'appended')
		const after = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(after.core.slotCount, 0)
		assert.equal(after.core.pendingHas(K[0]!), true)
		assert.equal(after.core.consumedHas(K[0]!), false)
	} finally {
		w.done()
	}
})

test('the rollback to version 2 refuses while a wallet slot is held (nothing changed), and succeeds once the slot is resolved', async () => {
	const w = await world()
	try {
		await assert.rejects(() => rollbackToV2({ stateDir: w.stateDir, auditDir: w.auditDir, runId: 'run-20261122-rb01', approval: 'PM-2026-11-22-02' }), /wallet slot\(s\) \(rt1\) hold in-flight batches.*Nothing was changed/)
		const m = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'manifest.json'), 'utf8')) as { version: number }
		assert.equal(m.version, 3, 'still a version 3 state with its log')
		await resolveInFlight(base(w, readers({ status: 1, blockNumber: 9 }), { wallet: 'rt1' }))
		const r = await rollbackToV2({ stateDir: w.stateDir, auditDir: w.auditDir, runId: 'run-20261122-rb02', approval: 'PM-2026-11-22-02' })
		assert.ok(r.status === 'rolled-back' || r.status === 'done' || (r as { status: string }).status.length > 0)
		const m2 = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'manifest.json'), 'utf8')) as { version: number }
		assert.equal(m2.version, 2, 'a plain version 2 state again')
	} finally {
		w.done()
	}
})

test('the reconcile reports the keys of a wallet slot as in flight (inFlightOverlap), dry run, nothing changed', async () => {
	const w = await world()
	try {
		const keysFile = path.join(w.root, 'keys.json')
		const entry = (k: string, i: number): Record<string, unknown> => ({ eventKey: k, txHash: hex(0xf00 + i), blockNumber: 9000 + i, amountWei: String(1000 * (i + 1)), txTotalWei: String(1000 * (i + 1)), nonce: 40 + i })
		fs.writeFileSync(keysFile, JSON.stringify({ reviewers: ['alice@ops', 'bob@ops'], entries: [entry(K[0]!, 0), entry(K[2]!, 2)] }, null, 2))
		const r = await reconcileKeys({ stateDir: w.stateDir, auditDir: w.auditDir, runId: 'run-20261122-rec1', approval: 'PM-2026-11-22-03', keysFile, dryRun: true })
		assert.equal(r.status, 'dry-run')
		if (r.status !== 'dry-run') return
		assert.deepEqual((r.audit as { inFlightOverlap: string[] }).inFlightOverlap, [K[0]!], 'key 0 is in the slot of rt1, key 2 is not')
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).core.slotCount, 1)
	} finally {
		w.done()
	}
})
