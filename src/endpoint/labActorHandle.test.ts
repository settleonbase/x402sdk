/**
 * P3 actor handles (labActorHandle.ts): visibility (a payer sees only committed writes), one atomic event per commit, commit-time scalar writes (two wallets settling N batches each end at 2N),
 * consumed wins over a late pendingAdd, per-actor scopes, and a randomized interleaving of several actors with the core compared against the log prefix at every commit and against
 * copies of the log directory taken mid-run (a kill at any point). Real files in temp dirs.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ActorHub } from './labActorHandle'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { scanWal, WalWriter, type WalEvent } from './labWal'
import { canonicalJson } from './labClPayoutStateStore'

type E = { eventKey: string; amount: string; blockNumber: number; withdrawalIndex: number; pubkey: string }
type S = Record<string, unknown>
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const entry = (i: number, block: number): E => ({ eventKey: key(i), amount: '1000', blockNumber: block, withdrawalIndex: i % 5, pubkey: '0xabcdef' })
const fatal = (e: Error): void => {
	throw e
}
const turn = (): Promise<void> => new Promise((r) => setImmediate(r))

async function world(reserved?: (k: string) => boolean) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labactor-'))
	const stateDir = path.join(dir, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 }, settledBatchCount: 0 } })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 1 << 20, onFatal: fatal })
	const hub = new ActorHub<E, S>({ core, wal, onFatal: fatal, reserved })
	return { dir, stateDir, core, wal, hub, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const events = (stateDir: string): WalEvent[] => {
	const out: WalEvent[] = []
	scanWal(stateDir, { afterSeq: 0, repair: false, onEvent: (e) => out.push(e) })
	return out
}
const digest = (c: LabPayoutStateCore): string =>
	canonicalJson({
		scalars: c.scalarsCopy(),
		inFlight: c.getInFlight(),
		pending: [...c.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: [...c.consumedKeys()].sort(),
		exited: [...c.exited.keys()].sort(),
	})

test('A1: a payer sees only committed writes - the scan actor\'s half window (pendingAdd done, cursor not) is invisible until its commit, and one commit is ONE event', async () => {
	const w = await world()
	try {
		const scan = w.hub.actor('scan')
		const pay = w.hub.actor('pay:rt:0')
		scan.openScope('scan')
		scan.pendingAdd([entry(1, 100), entry(2, 101)])
		await turn()
		scan.pendingAdd([entry(3, 102)])
		assert.equal(scan.pendingSize, 3, 'the scan actor reads its own writes')
		assert.equal(scan.pendingHas(key(1)), true)
		assert.equal(pay.pendingSize, 0, 'the payer sees nothing of the open window')
		assert.equal(pay.pendingHas(key(1)), false)
		assert.equal([...pay.pendingValues()].length, 0)
		assert.equal(w.core.pendingSize, 0, 'and the core has nothing: the core is the log prefix')
		scan.setScalar('realtimeCursor', 102)
		await scan.commit('scan')
		assert.equal(pay.pendingSize, 3)
		assert.equal([...pay.pendingValues()].length, 3)
		const ev = events(w.stateDir)
		assert.equal(ev.length, 1, 'one commit = one event')
		assert.deepEqual(ev[0]!.ops.map((o) => o.op).sort(), ['pendingAdd', 'pendingAdd', 'pendingAdd', 'scalarsSet'])
		// every key a payer could name in an intent is in the log as a pendingAdd
		const logged = new Set(ev.flatMap((e) => e.ops.filter((o) => o.op === 'pendingAdd').map((o) => (o as { entry: { eventKey: string } }).entry.eventKey)))
		for (const e of pay.pendingValues()) assert.ok(logged.has(e.eventKey))
	} finally {
		w.done()
	}
})

test('A2: per-actor scopes - a second scope on the SAME actor is refused, scopes of different actors are open at the same time; a scope left without a commit DISCARDS the actor\'s overlay (F-A0-3)', async () => {
	const lines: string[] = []
	const w = await world()
	try {
		const hub = new ActorHub<E, S>({ core: w.core, wal: w.wal, onFatal: fatal, log: (l) => lines.push(l) })
		const a = hub.actor('a')
		const b = hub.actor('b')
		a.openScope('scan')
		assert.throws(() => a.openScope('batch'), /already open/)
		b.openScope('batch') // another actor: allowed
		await assert.rejects(() => b.commit('scan'), /commit scope 'batch' is open/)
		a.pendingAdd([entry(5, 10)])
		a.setScalar('realtimeCursor', 99)
		a.closeScope() // left without its commit (an exception inside the scope): the overlay is discarded, nothing of it ever reached the core
		assert.equal(w.core.pendingSize, 0)
		assert.equal(a.pendingHas(key(5)), false, 'the discarded add is gone from the actor\'s own view too')
		assert.equal(a.scalar('realtimeCursor'), undefined)
		assert.ok(lines.some((l) => l.includes('discarded 2 uncommitted ops of an aborted \'scan\' scope')), lines.join('|'))
		assert.equal(hub.stats.discardedOps, 2)
		await a.commit('scalars')
		assert.equal(events(w.stateDir).length, 0, 'an empty commit appends nothing')
		// writes made OUTSIDE a scope are not discarded by a later closeScope of nothing: they wait for the actor's next commit
		a.pendingAdd([entry(6, 11)])
		a.closeScope()
		await a.commit('scalars')
		assert.equal(w.core.pendingHas(key(6)), true)
		b.closeScope()
		a.enterTick()
		assert.throws(() => a.enterTick(), /ticks must be serial/)
		b.enterTick() // a different actor has its own tick
	} finally {
		w.done()
	}
})

test('A3: commit-time scalar writes - two wallets each settling 100 batches end at 200 (the absolute read-then-set pattern loses updates: negative control)', async () => {
	const w = await world()
	try {
		const a = w.hub.actor('pay:1')
		const b = w.hub.actor('pay:2')
		const n = 100
		const run = async (h: typeof a): Promise<void> => {
			for (let i = 0; i < n; i++) {
				h.incScalar('settledBatchCount', 1)
				h.incScalar('settledBatchCount', 0)
				await turn() // another actor commits meanwhile
				await h.commit('settle')
			}
		}
		await Promise.all([run(a), run(b)])
		assert.equal(w.core.getScalar('settledBatchCount'), 2 * n)
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(rec.core.getScalar('settledBatchCount'), 2 * n, 'the log replays to the same count')
	} finally {
		w.done()
	}
	// negative control: the same two loops with the absolute pattern (read the value, set value+1) lose updates
	const w2 = await world()
	try {
		const a = w2.hub.actor('pay:1')
		const b = w2.hub.actor('pay:2')
		const run = async (h: typeof a): Promise<void> => {
			for (let i = 0; i < 100; i++) {
				h.setScalar('settledBatchCount', ((h.scalar('settledBatchCount') as number) ?? 0) + 1)
				await turn()
				await h.commit('settle')
			}
		}
		await Promise.all([run(a), run(b)])
		assert.ok((w2.core.getScalar('settledBatchCount') as number) < 200, 'the test is sensitive: the old pattern ends below 200')
	} finally {
		w2.done()
	}
})

test('A4: setScalarIfUnset - the first actor to commit starts the clock, the second does not overwrite it; delScalar clears it', async () => {
	const w = await world()
	try {
		const a = w.hub.actor('a')
		const b = w.hub.actor('b')
		a.setScalarIfUnset('gasWaitStartedAt', '2026-11-22T00:00:00.000Z')
		b.setScalarIfUnset('gasWaitStartedAt', '2026-11-22T00:00:30.000Z')
		assert.equal(b.scalar('gasWaitStartedAt'), '2026-11-22T00:00:30.000Z', 'before any commit each actor previews its own value')
		await a.commit('scalars')
		await b.commit('scalars')
		assert.equal(w.core.getScalar('gasWaitStartedAt'), '2026-11-22T00:00:00.000Z')
		a.delScalar('gasWaitStartedAt')
		await a.commit('scalars')
		assert.equal(w.core.getScalar('gasWaitStartedAt'), undefined)
	} finally {
		w.done()
	}
})

test('A5: consumed wins - a pendingAdd that was prepared before its key became consumed (or reserved) is dropped at commit, the paid key never returns to the pool', async () => {
	const reservedKeys = new Set<string>()
	const w = await world((k) => reservedKeys.has(k))
	try {
		const scan = w.hub.actor('scan')
		const pay = w.hub.actor('pay')
		scan.pendingAdd([entry(1, 100), entry(2, 101), entry(3, 102)])
		pay.consumedAdd(key(1)) // paid by another route (or settled) while the scan window is open
		await pay.commit('settle')
		reservedKeys.add(key(2)) // part of a wallet's in-flight batch
		await scan.commit('scan')
		assert.equal(w.core.pendingHas(key(1)), false, 'consumed key is not pending')
		assert.equal(w.core.pendingHas(key(2)), false, 'reserved key is not re-added')
		assert.equal(w.core.pendingHas(key(3)), true)
		assert.equal(w.hub.stats.droppedConsumedAdds, 1)
		assert.equal(w.hub.stats.droppedReservedAdds, 1)
		// settle and rescan in the other order: the settle's pendingDel + consumedAdd, then the rescan of the same block adds nothing
		const p2 = w.hub.actor('pay2')
		p2.pendingDel(key(3))
		p2.consumedAdd(key(3))
		scan.pendingAdd([entry(3, 102)]) // the scan looked before the settle: the key is pending in its view? (no: it is in the core, so the add is a no-op)
		await p2.commit('settle')
		await scan.commit('scan')
		assert.equal(w.core.pendingHas(key(3)), false)
		assert.equal(w.core.consumedHas(key(3)), true)
	} finally {
		w.done()
	}
})

test('A6: randomized interleaving of 4 actors (adds, deletes, consumed, increments, cursors, in-flight): at every commit the core equals the replay of the log prefix; a copy of the log directory taken at random moments recovers to a state the core really had', async () => {
	const w = await world()
	try {
		const names = ['scan', 'pay:a', 'pay:b', 'pay:c']
		const actors = names.map((n) => w.hub.actor(n))
		let seed = 0x9e3779b9
		const rnd = (m: number): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed % m
		}
		const digestBySeq = new Map<number, string>([[0, digest(w.core)]])
		const copies: string[] = []
		let nextKey = 1
		let cursor = 100
		const steps = 400
		const worker = async (id: number): Promise<void> => {
			const h = actors[id]!
			for (let s = 0; s < steps / 4; s++) {
				const k = rnd(8)
				if (id === 0) {
					if (k < 5) {
						h.pendingAdd([entry(nextKey++, cursor + rnd(50))])
						if (rnd(3) === 0) h.pendingAdd([entry(rnd(nextKey) + 1, cursor)]) // may be a duplicate key
					} else if (k === 5) {
						cursor += 3
						h.setScalar('realtimeCursor', cursor)
						h.setScalar('lastLiveHeadScanned', cursor)
					} else h.consumedAdd(key(rnd(nextKey) + 1))
				} else {
					const pend = [...h.pendingValues()]
					if (k < 4 && pend.length > 0) {
						const e = pend[rnd(pend.length)]!
						h.pendingDel(e.eventKey)
						h.consumedAdd(e.eventKey)
						h.incScalar('settledBatchCount', 1)
					} else if (k === 4) h.setScalarIfUnset('gasWaitStartedAt', `t${id}`)
					else if (k === 5) h.delScalar('gasWaitStartedAt')
					else if (k === 6 && id === 1) h.setScalar('inFlightWithdraw', { idempotencyKey: `w${id}-${s}`, eventKeys: pend.slice(0, 2).map((e) => e.eventKey) })
					else if (k === 7 && id === 1) h.setScalar('inFlightWithdraw', undefined as never)
				}
				for (let t = rnd(3); t > 0; t--) await turn()
				if (rnd(2) === 0) {
					const before = w.wal.lastSeq
					const p = h.commit(id === 0 ? 'scan' : 'settle')
					// the digest of the core right after the synchronous record of this commit is the state AT its seq (no await between apply and here)
					if (w.wal.lastSeq > before) digestBySeq.set(w.wal.lastSeq, digest(w.core))
					await p
					// the core equals the replay of the log prefix up to its applied seq
					if (rnd(25) === 0) {
						const rep = recoverPayoutState(w.stateDir, { readOnly: true })
						if (rep.core.lastAppliedSeq === w.core.lastAppliedSeq) assert.equal(digest(rep.core), digest(w.core), 'core equals the replay of the log')
					}
					if (rnd(30) === 0) {
						const c = fs.mkdtempSync(path.join(os.tmpdir(), 'labactor-copy-'))
						fs.cpSync(w.stateDir, path.join(c, 'state.v2'), { recursive: true })
						copies.push(c)
					}
				}
			}
			await h.commit('scalars')
		}
		await Promise.all(actors.map((_, i) => worker(i)))
		digestBySeq.set(w.wal.lastSeq, digest(w.core))
		await w.wal.whenDurable(w.wal.lastSeq)
		const full = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(digest(full.core), digest(w.core), 'final: the replay of the whole log equals the core (inFlight, pending, consumed, scalars)')
		assert.ok(copies.length >= 3, `mid-run copies: ${copies.length}`)
		for (const c of copies) {
			const rec = recoverPayoutState(path.join(c, 'state.v2'), { readOnly: true })
			const want = digestBySeq.get(rec.core.lastAppliedSeq)
			assert.notEqual(want, undefined, `a copy recovered to seq ${rec.core.lastAppliedSeq}, which no commit produced`)
			assert.equal(digest(rec.core), want, `a kill at seq ${rec.core.lastAppliedSeq} recovers to the state the core had at that seq (the log prefix)`)
			fs.rmSync(c, { recursive: true, force: true })
		}
		console.log(`A6 events=${w.wal.lastSeq} commits=${w.hub.stats.commits} dropped consumed=${w.hub.stats.droppedConsumedAdds} copies=${copies.length} settled=${w.core.getScalar('settledBatchCount')}`)
	} finally {
		w.done()
	}
})

test('A7: cursorHighWater is a maximum (F-A0-1): an actor whose cursor commits later but is lower cannot pull the high-water back; and a second actor writing the single in-flight slot is refused (F-A0-4)', async () => {
	const w = await world()
	try {
		const a = w.hub.actor('scan-a')
		const b = w.hub.actor('scan-b')
		b.setScalar('lastBackfillProcessedBlock', 400) // b looked first (committed high-water was 0) ...
		b.setScalar('lastListeningEndBlock', 300)
		a.setScalar('lastBackfillProcessedBlock', 500)
		a.setScalar('lastListeningEndBlock', 350)
		await a.commit('scan') // ... a commits the higher cursors first
		assert.deepEqual(w.core.getScalar('cursorHighWater'), { backfill: 500, listen: 350 })
		await b.commit('scan') // ... b commits its lower ones afterwards
		assert.equal(w.core.getScalar('lastBackfillProcessedBlock'), 500, 'the cursor is max-merged at apply')
		assert.deepEqual(w.core.getScalar('cursorHighWater'), { backfill: 500, listen: 350 }, 'the high-water keeps the maximum of the committed and the committed-now values')
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.deepEqual(rec.core.getScalar('cursorHighWater'), { backfill: 500, listen: 350 }, 'and so does the replay')
		// a cursor below the committed high-water is refused when it is set (monotonicity, before it is recorded)
		assert.throws(() => a.setScalar('lastBackfillProcessedBlock', 450), /cursor|monoton|backwards|high/i)
		// one writer for the single in-flight slot
		const p1 = w.hub.actor('pay-1')
		const p2 = w.hub.actor('pay-2')
		p1.setScalar('inFlightWithdraw', { idempotencyKey: 'k1', eventKeys: [] })
		assert.throws(() => p2.setScalar('inFlightWithdraw', { idempotencyKey: 'k2', eventKeys: [] }), /owns \(one writer until per-wallet slots\)|one writer/)
		assert.throws(() => p2.delScalar('inFlightWithdraw'), /one writer/)
	} finally {
		w.done()
	}
})
