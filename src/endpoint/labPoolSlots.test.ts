/**
 * P4 B1: per-wallet in-flight slots (inFlightByWallet) - the core's slot/reserved bookkeeping, the actor API (claims visible to every other claimer at once, slot writes committed as one event, one writer per
 * wallet), snapshot + log recovery, the refusal of a version 2 downgrade while a slot is held, and the real df78e6b reader refusing a directory that carries slots. Real files in temp dirs.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { ActorHub } from './labActorHandle'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { gracefulStopToV2, recoverPayoutState } from './labPayoutRecovery'
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
const rec = (wallet: string, keys: number[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ batchId: `b-${wallet}-${keys[0]}`, idempotencyKey: `idem-${wallet}-${keys[0]}`, line: 'realtime', amountWei: String(keys.length * 1000), eventKeys: keys.map(key), status: 'intent', ...extra })

async function world() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labslots-'))
	const stateDir = path.join(dir, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 }, settledBatchCount: 0 } })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 1 << 20, onFatal: fatal })
	const hub = new ActorHub<E, S>({ core, wal, onFatal: fatal })
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
		slots: Object.fromEntries([...c.slotEntries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
		pending: [...c.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: [...c.consumedKeys()].sort(),
		exited: [...c.exited.keys()].sort(),
	})

test('S1: core slots - set, replace, clear; the reserved key set follows the slots; amounts add up; the snapshot scalars carry the slots', () => {
	const c = new LabPayoutStateCore({})
	assert.equal(c.slotCount, 0)
	c.setSlot('w1', rec('w1', [1, 2, 3]))
	c.setSlot('w2', rec('w2', [4, 5]))
	assert.equal(c.slotCount, 2)
	assert.equal(c.slotOwnerOfKey(key(2)), 'w1')
	assert.equal(c.slotOwnerOfKey(key(5)), 'w2')
	assert.equal(c.slotOwnerOfKey(key(9)), undefined)
	assert.equal(c.slotsAmountWei(), 5000n)
	c.setSlot('w1', rec('w1', [1], { status: 'sent' })) // replaced as a whole: keys 2 and 3 are free again
	assert.equal(c.slotOwnerOfKey(key(2)), undefined)
	assert.equal(c.slotOwnerOfKey(key(1)), 'w1')
	c.setSlot('w2', null)
	assert.equal(c.slotCount, 1)
	assert.equal(c.slotOwnerOfKey(key(4)), undefined)
	const src = c.freezeForSnapshot()
	assert.deepEqual(Object.keys(src.scalars.inFlightByWallet as object), ['w1'])
	c.finishSnapshot(src, { committed: false })
	assert.throws(() => c.setScalar('inFlightByWallet', {}), /not a plain scalar/)
})

test('S2: actors - a claim is visible to every other claimer at once, a slot write is one event and invisible until committed, one writer per wallet', async () => {
	const w = await world()
	try {
		const a = w.hub.actor('pay:w1')
		const b = w.hub.actor('pay:w2')
		assert.equal(w.hub.claim('w1', [key(1), key(2)]), true)
		assert.equal(w.hub.isReserved(key(1)), true, 'reserved before anything is in the log')
		assert.equal(w.hub.claim('w2', [key(2), key(3)]), false, 'overlap with w1: w2 gets nothing')
		assert.equal(w.hub.isReserved(key(3)), false, 'and reserved nothing')
		assert.equal(w.hub.claim('w2', [key(3)]), true)
		// the intent: the slot is set in the overlay, nothing in the core or the log yet
		a.setSlot('w1', rec('w1', [1, 2]))
		assert.equal(b.slot('w1'), null, 'another actor does not see an uncommitted slot')
		assert.equal(w.core.slotCount, 0)
		await a.commit('intent')
		assert.equal(w.core.slotOwnerOfKey(key(1)), 'w1')
		w.hub.releaseClaim('w1')
		assert.equal(w.hub.isReserved(key(1)), true, 'the committed slot is the reservation now')
		assert.equal(w.hub.reservedBy(key(1)), 'w1')
		assert.deepEqual(w.hub.claimedKeysOf('w2'), [key(3)])
		const ev = events(w.stateDir)
		assert.equal(ev.length, 1)
		assert.deepEqual(ev[0]!.ops.map((o) => o.op), ['slotSet'])
		// in-place change of the live copy (the lifecycle does rec.hash = ...) is journaled at the next commit
		const live = a.slot('w1')!
		live.hash = '0xabc'
		live.status = 'sent'
		await a.commit('hash')
		assert.equal((w.core.getSlot('w1') as Record<string, unknown>).hash, '0xabc')
		// one writer per wallet
		assert.throws(() => b.setSlot('w1', null), /owns/)
		// settle: slot cleared, keys consumed, in one event; the reservation ends with it
		a.setSlot('w1', null)
		a.consumedAdd(key(1))
		a.consumedAdd(key(2))
		await a.commit('settle')
		assert.equal(w.core.slotCount, 0)
		assert.equal(w.hub.isReserved(key(1)), false)
	} finally {
		w.done()
	}
})

test('S3: snapshot + log recovery restore the slots (a slotSet after the snapshot is replayed; a snapshot taken while a slot is held carries it) and the version of a slot-bearing snapshot is 3', async () => {
	const w = await world()
	try {
		const a = w.hub.actor('pay:w1')
		const b = w.hub.actor('pay:w2')
		a.setSlot('w1', rec('w1', [1, 2, 3]))
		await a.commit('intent')
		// a snapshot while the slot is held
		const src = w.core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: w.stateDir, mode: 'wal', waitDurable: (s) => w.wal.whenDurable(s) })
		w.core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		b.setSlot('w2', rec('w2', [7, 8]))
		await b.commit('intent') // after the snapshot: only in the log
		await w.wal.whenDurable(w.wal.lastSeq)
		const r = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(r.manifestVersion, 3)
		assert.equal(digest(r.core), digest(w.core))
		assert.deepEqual([...r.core.slotEntries()].map(([k]) => k).sort(), ['w1', 'w2'])
		assert.equal(r.core.slotOwnerOfKey(key(8)), 'w2')
		const rw = recoverPayoutState(w.stateDir, { readOnly: true, loader: 'whole' })
		assert.equal(digest(rw.core), digest(w.core), 'the whole-state loader recovers the same slots')
	} finally {
		w.done()
	}
})

test('S4: no version 2 downgrade while a wallet slot is held (the old build would ignore the slot); once every slot is clear the downgrade works and the log is gone', async () => {
	const w = await world()
	try {
		const a = w.hub.actor('pay:w1')
		a.setSlot('w1', rec('w1', [1]))
		await a.commit('intent')
		await assert.rejects(() => gracefulStopToV2(w.core, w.wal, w.stateDir), /wallet slot\(s\) still hold an in-flight batch.*the log is kept/)
		assert.ok(fs.readdirSync(path.join(w.stateDir, 'wal')).length > 0, 'the log is kept')
		a.setSlot('w1', null)
		a.consumedAdd(key(1))
		await a.commit('settle')
		const r = await gracefulStopToV2(w.core, w.wal, w.stateDir)
		assert.equal(r.walSeq, w.core.lastAppliedSeq)
		const m = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'manifest.json'), 'utf8')) as { version: number }
		assert.equal(m.version, 2)
	} finally {
		w.done()
	}
})

const BASELINE = process.env.E2E_BASELINE_ROOT ?? path.resolve(__dirname, '../../../lab-baseline-df78e6b')
test('S5: the REAL df78e6b reader refuses a directory that carries wallet slots (version 3 snapshot) and still reads the version 2 downgrade written when no slot is held', { skip: !fs.existsSync(path.join(BASELINE, 'src/endpoint/labClPayoutStateStore.ts')) }, async () => {
	const old = (await import(pathToFileURL(path.join(BASELINE, 'src/endpoint/labClPayoutStateStore.ts')).href)) as { readSegmentedState: (dir: string) => unknown }
	const w = await world()
	try {
		const a = w.hub.actor('pay:w1')
		a.pendingAdd([entry(1, 100), entry(2, 101)])
		a.setSlot('w1', rec('w1', [1]))
		await a.commit('intent')
		const src = w.core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: w.stateDir, mode: 'wal', waitDurable: (s) => w.wal.whenDurable(s) })
		w.core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		assert.throws(() => old.readSegmentedState(w.stateDir), /unsupported version|WAL-mode snapshot|replay the WAL/i, 'the old reader refuses a slot-bearing directory')
		a.setSlot('w1', null)
		a.consumedAdd(key(1))
		a.pendingDel(key(1))
		await a.commit('settle')
		await gracefulStopToV2(w.core, w.wal, w.stateDir)
		const st = old.readSegmentedState(w.stateDir) as { pending: unknown[]; consumedEventKeys: Record<string, true> }
		assert.equal(st.pending.length, 1)
		assert.equal(Object.keys(st.consumedEventKeys).length, 1, 'the old build reads the plain version 2 state')
	} finally {
		w.done()
	}
})

test('S6: three wallets claim, commit, settle and release at random against a scan that keeps adding: no key is ever in two slots, the core equals the replay of the log, a reserved key is never re-added to pending', async () => {
	const w = await world()
	try {
		const scan = w.hub.actor('scan')
		const wallets = ['w1', 'w2', 'w3']
		let seed = 0x51ed270b
		const rnd = (m: number): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed % m
		}
		let nextKey = 1
		let maxSlots = 0
		const owners = new Map<string, string>()
		const check = (): void => {
			owners.clear()
			for (const [wl, r] of w.core.slotEntries()) for (const k of (r as { eventKeys: string[] }).eventKeys) {
				assert.equal(owners.get(k), undefined, `key ${k} is in the slots of ${owners.get(k)} and ${wl}`)
				owners.set(k, wl)
			}
			maxSlots = Math.max(maxSlots, w.core.slotCount)
		}
		const scanner = async (): Promise<void> => {
			for (let s = 0; s < 120; s++) {
				scan.pendingAdd(Array.from({ length: 1 + rnd(6) }, () => entry(nextKey++, 100 + s)))
				if (rnd(4) === 0) scan.pendingAdd([entry(rnd(nextKey) + 1, 100)]) // a rescan of an old key
				await turn()
				await scan.commit('scan')
				check()
			}
		}
		const worker = async (wl: string): Promise<void> => {
			const h = w.hub.actor(`pay:${wl}`)
			for (let s = 0; s < 80; s++) {
				const cand = [...h.pendingValues()].filter((e) => !w.hub.isReserved(e.eventKey)).slice(0, 1 + rnd(5))
				if (cand.length === 0) {
					await turn()
					continue
				}
				const keys = cand.map((e) => e.eventKey)
				if (!w.hub.claim(wl, keys)) continue
				await turn() // paid-key and guardian reads would be here
				h.setSlot(wl, { batchId: `b${s}`, idempotencyKey: `i-${wl}-${s}`, line: 'realtime', amountWei: String(keys.length * 1000), eventKeys: keys, status: 'intent' })
				await h.commit('intent')
				w.hub.releaseClaim(wl)
				check()
				for (let t = rnd(3); t > 0; t--) await turn()
				if (rnd(5) === 0) {
					h.setSlot(wl, null) // released: rejected batch, the keys go back to the pool
					await h.commit('release')
				} else {
					h.setSlot(wl, null)
					for (const k of keys) {
						h.pendingDel(k)
						h.consumedAdd(k)
					}
					h.incScalar('settledBatchCount', 1)
					await h.commit('settle')
				}
				check()
			}
		}
		await Promise.all([scanner(), ...wallets.map(worker)])
		await w.wal.whenDurable(w.wal.lastSeq)
		check()
		const full = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(digest(full.core), digest(w.core), 'the replay of the whole log equals the core, slots included')
		for (const k of w.core.consumedKeys()) assert.equal(w.core.pendingHas(k), false, `consumed key ${k} is not pending`)
		assert.ok(maxSlots >= 2, `at least two wallets held a slot at the same time (${maxSlots})`)
		console.log(`S6 events=${w.wal.lastSeq} settled=${w.core.getScalar('settledBatchCount')} maxSlots=${maxSlots} droppedConsumed=${w.hub.stats.droppedConsumedAdds} droppedReserved=${w.hub.stats.droppedReservedAdds}`)
	} finally {
		w.done()
	}
})
