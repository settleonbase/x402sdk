/**
 * P2c-2: the WAL implementation of the state handle - one atomic event per commit, scopes, the in-place in-flight record, cursor monotonicity before apply, fail-stop on a refused append,
 * and a differential run against the legacy handle on the same scripted operations. Real files in temp dirs.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { scanWal, WalWriter, type WalEvent } from './labWal'
import { LegacyStateHandle } from './labStateHandle'
import { WalStateHandle } from './labWalStateHandle'
import { canonicalJson } from './labClPayoutStateStore'

type E = { eventKey: string; amount: bigint | string; blockNumber: number; withdrawalIndex: number; pubkey: string }
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const entry = (i: number, block: number, amount = 1000n): E => ({ eventKey: key(i).toUpperCase().replace('0X', '0x'), amount, blockNumber: block, withdrawalIndex: i % 5, pubkey: '0xABCDEF' })
const fatal = (e: Error): void => {
	throw e
}

async function world(segmentBytes = 100000): Promise<{ dir: string; stateDir: string; core: LabPayoutStateCore; wal: WalWriter; h: WalStateHandle<E, Record<string, unknown>> }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labwalh-'))
	const stateDir = path.join(dir, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes, onFatal: fatal })
	const h = new WalStateHandle<E, Record<string, unknown>>({ core, wal, onFatal: fatal })
	return { dir, stateDir, core, wal, h }
}
const events = (stateDir: string): WalEvent[] => {
	const out: WalEvent[] = []
	scanWal(stateDir, { afterSeq: 0, repair: false, onEvent: (e) => out.push(e) })
	return out
}

test('writes are applied at once; commit appends ONE event with all of them; recovery from the log reproduces the state', async () => {
	const w = await world()
	try {
		const { h, core } = w
		assert.equal(h.pendingAdd([entry(1, 10), entry(2, 20), entry(1, 10)]), 2, 'the duplicate key is skipped; keys are lower-cased, amount becomes a string, pubkey lower-case')
		assert.equal(h.pendingHas(key(1)), true, 'visible before the commit')
		assert.equal(core.pendingGet(key(1))?.amount, '1000')
		assert.equal(core.pendingGet(key(1))?.pubkey, '0xabcdef')
		h.consumedAdd(key(7))
		h.exitedAdd('0xABCD')
		h.setScalar('historyCursor', 15)
		h.setScalar('lastBackfillProcessedBlock', 15)
		h.setScalar('lastLiveHeadScanned', 12)
		assert.equal(events(w.stateDir).length, 0, 'nothing is in the log before the commit')
		await h.commit('scan')
		const ev = events(w.stateDir)
		assert.equal(ev.length, 1, 'one commit = one event')
		assert.equal(ev[0]!.t, 'scan')
		assert.deepEqual(ev[0]!.ops.map((o) => o.op).sort(), ['consumedAdd', 'exitedAdd', 'pendingAdd', 'pendingAdd', 'scalarsSet'])
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(rec.core.pendingSize, 2)
		assert.equal(rec.core.consumedHas(key(7)), true)
		assert.equal(rec.core.exitedHas('0xabcd'), true)
		assert.equal(rec.core.getScalar('historyCursor'), 15)
		assert.deepEqual(rec.core.getScalar('cursorHighWater'), { backfill: 15, listen: -1 }, 'the high-water follows the cursors, as the legacy write did')
	} finally {
		await w.wal.close()
		fs.rmSync(w.dir, { recursive: true, force: true })
	}
})

test('the lifecycle changes the in-flight record in place (rec.hash = ...): the live copy is journaled at the next commit; setScalar/delScalar of it work like the legacy handle', async () => {
	const w = await world()
	try {
		const { h } = w
		h.setScalar('inFlightWithdraw', { idempotencyKey: 'k1', eventKeys: [key(1)], line: 'history', amountWei: '1000', redeem: 'r', pool: 'p', requestFingerprint: 'f', createdAt: 't' })
		await h.commit('intent')
		const live = h.scalar('inFlightWithdraw') as Record<string, unknown>
		live.hash = '0xhash' // in place, as resumeLabWithdrawInFlight does
		await h.commit('hash')
		const ev = events(w.stateDir)
		assert.deepEqual(ev.map((e) => e.t), ['intent', 'hash'])
		assert.deepEqual(ev[1]!.ops.map((o) => o.op), ['inFlightSet'])
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).core.getInFlight()?.hash, '0xhash')
		h.delScalar('inFlightWithdraw')
		await h.commit('settle')
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).core.getInFlight(), null)
		assert.equal(h.scalar('inFlightWithdraw'), undefined)
	} finally {
		await w.wal.close()
		fs.rmSync(w.dir, { recursive: true, force: true })
	}
})

test('scopes (T1): scan scope refuses other labels and a commit(scan) closes it; batch scope allows the lifecycle steps; ticks are serial; leaving a scope keeps the buffered writes for the next commit', async () => {
	const w = await world()
	try {
		const { h } = w
		h.openScope('scan')
		h.pendingAdd([entry(1, 10)])
		await assert.rejects(h.commit('settle'), /commit scope 'scan' is open; commit 'settle' refused/)
		await h.commit('scan')
		assert.equal(h.openScopeLabel, null)
		h.openScope('batch')
		await assert.rejects(h.commit('scan'), /commit scope 'batch' is open/)
		await h.commit('intent')
		h.closeScope()
		h.openScope('scan')
		h.consumedAdd(key(9)) // the window throws here: the finally closes the scope without a commit
		h.closeScope()
		await h.commit('scalars') // another label carries the kept write
		const last = events(w.stateDir).at(-1)!
		assert.equal(last.t, 'scalars')
		assert.deepEqual(last.ops.map((o) => o.op), ['consumedAdd'])
		h.enterTick()
		assert.throws(() => h.enterTick(), /ticks must be serial/)
		assert.throws(() => h.requireIdle(), /a tick is still running/)
		h.exitTick()
	} finally {
		await w.wal.close()
		fs.rmSync(w.dir, { recursive: true, force: true })
	}
})

test('cursor monotonicity is checked BEFORE the value is applied: a refused value changes neither memory nor the log', async () => {
	const w = await world()
	try {
		const { h, core } = w
		h.setScalar('lastBackfillProcessedBlock', 100)
		await h.commit('scan')
		assert.throws(() => h.setScalar('lastBackfillProcessedBlock', 90), /would move backwards/)
		assert.equal(core.getScalar('lastBackfillProcessedBlock'), 100, 'memory unchanged')
		h.setScalar('lastListeningEndBlock', 50)
		await h.commit('scalars')
		assert.throws(() => h.setScalar('lastListeningEndBlock', 49), /would move backwards/)
		assert.equal(events(w.stateDir).length, 2)
	} finally {
		await w.wal.close()
		fs.rmSync(w.dir, { recursive: true, force: true })
	}
})

test('an empty commit writes no event but is still a durability barrier; setScalar(undefined) deletes; an event the log refuses is fatal (memory would be ahead of the log)', async () => {
	const w = await world()
	try {
		const { h, core, wal } = w
		await h.commit('scalars')
		assert.equal(events(w.stateDir).length, 0, 'no ops, no event')
		h.setScalar('gasWaitStartedAt', 'T')
		await h.commit('scalars')
		h.setScalar('gasWaitStartedAt', undefined as never)
		await h.commit('scalars')
		assert.equal(core.getScalar('gasWaitStartedAt'), undefined)
		assert.deepEqual(events(w.stateDir).at(-1)!.ops.map((o) => o.op), ['scalarsDel'])
		// the barrier waits for an event that is queued but not yet durable
		const pending = wal.append('x', [{ op: 'consumedAdd', key: 'late' }])
		let resolved = false
		const b = h.commit('scalars').then(() => (resolved = true))
		await pending.durable
		await b
		assert.equal(resolved, true)
		// a refused append: an event larger than the frame limit
		const fatals: string[] = []
		const tiny = new WalWriter({ stateDir: path.join(w.dir, 'tiny'), lastSeq: 0, maxFrameBytes: 200, onFatal: fatal })
		const h2 = new WalStateHandle<E, Record<string, unknown>>({ core: new LabPayoutStateCore(), wal: tiny, onFatal: (e) => fatals.push(e.message) })
		h2.pendingAdd(Array.from({ length: 50 }, (_, i) => entry(i + 100, 5)))
		await assert.rejects(h2.commit('scan'), /the log refused the 'scan' event/)
		assert.equal(fatals.length, 1, 'onFatal ran')
		await tiny.close()
	} finally {
		await w.wal.close()
		fs.rmSync(w.dir, { recursive: true, force: true })
	}
})

test('differential: the same scripted operations through the legacy handle and the WAL handle give the same logical state (pending set, consumed order, exited, scalars, in-flight), also after a recovery from the log', async () => {
	const w = await world()
	try {
		const legacyState: Record<string, unknown> = { consumedEventKeys: {}, exitedPubkeys: {}, lastBackfillProcessedBlock: 99, freezeH: { height: 500 } }
		const legacyPending = new Map<string, E>()
		const legacy = new LegacyStateHandle<E, Record<string, unknown>>({ state: legacyState as never, pending: legacyPending, persist: () => undefined })
		const wal = w.h
		wal.setScalar('lastBackfillProcessedBlock', 99)
		wal.setScalar('freezeH', { height: 500 })
		await wal.commit('scalars')
		let seed = 12345
		const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000)
		const both = (f: (h: LegacyStateHandle<E, Record<string, unknown>> | WalStateHandle<E, Record<string, unknown>>) => void): void => {
			f(legacy)
			f(wal)
		}
		for (let step = 0; step < 400; step++) {
			const x = rnd()
			const i = Math.floor(rnd() * 60)
			if (x < 0.3) both((h) => h.pendingAdd([entry(i, 100 + Math.floor(rnd() * 0 + i), BigInt(1000 + i))]))
			else if (x < 0.5) both((h) => h.pendingDel(key(i)))
			else if (x < 0.65) both((h) => h.consumedAdd(key(i)))
			else if (x < 0.72) both((h) => h.exitedAdd(`0xPUB${i}`))
			else if (x < 0.85) {
				const v = 100 + step
				both((h) => h.setScalar('historyCursor', v))
			} else if (x < 0.92) both((h) => h.setScalar('gasWaitStartedAt', `T${step}`))
			else both((h) => h.delScalar('gasWaitStartedAt'))
			if (step % 25 === 24) await wal.commit('scan')
		}
		await wal.commit('scalars')
		const norm = (h: { pendingValues(): IterableIterator<E>; scalar: (n: never) => unknown; consumedSize: number; consumedHas: (k: string) => boolean }, consumed: string[], exited: string[]): string =>
			canonicalJson({
				pending: [...h.pendingValues()].map((e) => ({ k: e.eventKey.toLowerCase(), a: String(e.amount), b: e.blockNumber, w: e.withdrawalIndex, p: String(e.pubkey).toLowerCase() })).sort((a, b) => (a.k < b.k ? -1 : 1)),
				consumed,
				exited: exited.slice().sort(),
				cursor: h.scalar('historyCursor' as never),
				gas: h.scalar('gasWaitStartedAt' as never) ?? null,
			})
		const legacyConsumed = Object.keys(legacyState.consumedEventKeys as object)
		const legacyExited = Object.keys(legacyState.exitedPubkeys as object)
		const a = norm(legacy as never, legacyConsumed, legacyExited)
		const b = norm(wal as never, [...w.core.consumedKeys()], [...w.core.exited.keys()])
		assert.equal(b, a, 'live WAL state equals the legacy state')
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		const recovered = norm(new WalStateHandle<E, Record<string, unknown>>({ core: rec.core, wal: w.wal, onFatal: fatal }) as never, [...rec.core.consumedKeys()], [...rec.core.exited.keys()])
		assert.equal(recovered, a, 'and so does the state recovered from the log')
	} finally {
		await w.wal.close()
		fs.rmSync(w.dir, { recursive: true, force: true })
	}
})
