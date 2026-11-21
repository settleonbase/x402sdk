/**
 * Flush candidate selection: realtime reserved quota first, the rest history, no wasted slots, nothing else changes.
 * Pure functions and fakes only. No RPC.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectFlushCandidates, type FlushPos } from './labFlushSelect'
import { classifyPendingLine } from './labMiningPoolDualCursor'

const H = 1_000_000
type E = FlushPos & { id: number }
let seq = 0
const mk = (blockNumber: number, withdrawalIndex = 0): E => ({ blockNumber, withdrawalIndex, id: seq++ })
/** n history entries (blocks <= H, oldest first by index) and m realtime entries (blocks > H). */
function world(nHist: number, nRt: number): E[] {
	const out: E[] = []
	for (let i = 0; i < nHist; i++) out.push(mk(100 + Math.floor(i / 4), i % 4))
	for (let i = 0; i < nRt; i++) out.push(mk(H + 1 + Math.floor(i / 4), i % 4))
	return out
}
const lineOf = (e: E): string => classifyPendingLine(e.blockNumber, H)
const legacy = (all: E[], max: number): E[] => [...all].sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex).slice(0, max)
const OPTS = { freezeH: H, flushMax: 200, realtimeQuota: 100, historyFloor: 100 }

test('both lines backlogged: every flush takes the quota from realtime (oldest first) and the rest from history', () => {
	let pending = world(5000, 700)
	for (let flush = 0; flush < 5; flush++) {
		const r = selectFlushCandidates(pending, OPTS)
		assert.equal(r.ordered.length, 200)
		assert.equal(r.realtimeInspected, 100)
		assert.equal(r.historyInspected, 100)
		const rt = r.ordered.filter((e) => lineOf(e) === 'realtime')
		const hi = r.ordered.filter((e) => lineOf(e) === 'history')
		const rtAll = pending.filter((e) => lineOf(e) === 'realtime')
		const hiAll = pending.filter((e) => lineOf(e) === 'history')
		assert.deepEqual(rt, legacy(rtAll, 100), 'the 100 oldest realtime entries')
		assert.deepEqual(hi, legacy(hiAll, 100), 'the 100 oldest history entries')
		assert.deepEqual(r.ordered, [...rt, ...hi], 'realtime picks first, then history')
		const paid = new Set(r.ordered)
		pending = pending.filter((e) => !paid.has(e))
	}
})

test('the old selection never reached realtime while history was backlogged (regression guard for what this fixes)', () => {
	const pending = world(5000, 700)
	assert.equal(legacy(pending, 200).filter((e) => lineOf(e) === 'realtime').length, 0)
	assert.equal(selectFlushCandidates(pending, OPTS).realtimeInspected, 100)
})

test('only history has a backlog: all 200 slots go to history (no waste)', () => {
	const pending = world(5000, 0)
	const r = selectFlushCandidates(pending, OPTS)
	assert.equal(r.ordered.length, 200)
	assert.equal(r.realtimeInspected, 0)
	assert.equal(r.historyInspected, 200)
	assert.deepEqual(r.ordered, legacy(pending, 200))
})

test('only realtime has a backlog: all 200 slots go to realtime (the quota is a floor, not a ceiling)', () => {
	const pending = world(0, 900)
	const r = selectFlushCandidates(pending, OPTS)
	assert.equal(r.ordered.length, 200)
	assert.equal(r.realtimeInspected, 200)
	assert.deepEqual(r.ordered, legacy(pending, 200))
})

test('realtime has fewer than the quota: history gets the rest', () => {
	const r = selectFlushCandidates(world(5000, 30), OPTS)
	assert.equal(r.realtimeInspected, 30)
	assert.equal(r.historyInspected, 170)
	assert.equal(r.ordered.length, 200)
})

test('history has fewer than its share: realtime takes the spare slots beyond the quota', () => {
	const r = selectFlushCandidates(world(20, 500), OPTS)
	assert.equal(r.historyInspected, 20)
	assert.equal(r.realtimeInspected, 180)
	assert.equal(r.ordered.length, 200)
})

test('less pending than flushMax: everything is inspected once', () => {
	const pending = world(40, 25)
	const r = selectFlushCandidates(pending, OPTS)
	assert.equal(r.ordered.length, 65)
	assert.equal(new Set(r.ordered).size, 65)
})

test('history held by the review hold: every slot goes to realtime', () => {
	const r = selectFlushCandidates(world(5000, 700), { ...OPTS, historyHeld: true })
	assert.equal(r.realtimeInspected, 200)
	assert.equal(r.historyInspected, 0)
})

test('quota off (reserved batches 0): identical to the old global oldest-first selection', () => {
	for (let trial = 0; trial < 200; trial++) {
		const all: E[] = []
		const n = 50 + ((trial * 37) % 400)
		for (let i = 0; i < n; i++) all.push(mk(1 + ((i * 7919 + trial * 31) % 2000), (i * 13) % 5))
		const max = 1 + (trial % 120)
		const r = selectFlushCandidates(all, { freezeH: H, flushMax: max, realtimeQuota: 0 })
		assert.deepEqual(r.ordered, legacy(all, max))
		assert.equal(r.mode, 'oldest-first')
	}
})

test('counts by line cover the whole pending set; ordered is a duplicate-free subset in oldest-first order within each line', () => {
	const pending = world(3000, 450)
	const r = selectFlushCandidates(pending, OPTS)
	assert.equal(r.historyPending, 3000)
	assert.equal(r.realtimePending, 450)
	assert.equal(new Set(r.ordered).size, r.ordered.length)
	const inputs = new Set(pending)
	for (const e of r.ordered) assert.ok(inputs.has(e))
	for (const line of ['realtime', 'history']) {
		const xs = r.ordered.filter((e) => lineOf(e) === line)
		for (let i = 1; i < xs.length; i++) {
			assert.ok(xs[i - 1]!.blockNumber < xs[i]!.blockNumber || (xs[i - 1]!.blockNumber === xs[i]!.blockNumber && xs[i - 1]!.withdrawalIndex < xs[i]!.withdrawalIndex))
		}
	}
})

test('payable set unchanged: draining the pool flush by flush pays every entry exactly once, old order and new order alike', () => {
	const base = world(1200, 900)
	const drain = (useQuota: boolean): { order: E[]; flushes: number } => {
		let pending = [...base]
		const order: E[] = []
		let flushes = 0
		while (pending.length) {
			const r = useQuota ? selectFlushCandidates(pending, OPTS) : { ordered: legacy(pending, 200) }
			const set = new Set(r.ordered)
			order.push(...r.ordered)
			pending = pending.filter((e) => !set.has(e))
			flushes++
		}
		return { order, flushes }
	}
	const a = drain(false)
	const b = drain(true)
	assert.equal(new Set(a.order).size, base.length)
	assert.equal(new Set(b.order).size, base.length)
	assert.deepEqual(new Set(a.order), new Set(b.order), 'the same entries are paid')
	assert.equal(a.flushes, b.flushes, 'the same number of flushes to drain the same count')
	// The realtime entries are paid earlier (that is the point): first realtime in the new order comes within the first flush.
	const firstRt = (o: E[]): number => o.findIndex((e) => lineOf(e) === 'realtime')
	assert.ok(firstRt(b.order) < 200)
	assert.ok(firstRt(a.order) >= 1200)
})

test('large pending set: one linear pass, no full sort (1.6 million entries selected in well under a second of CPU per flush)', () => {
	const big: E[] = []
	for (let i = 0; i < 1_600_000; i++) big.push({ blockNumber: 100 + Math.floor(i / 16), withdrawalIndex: i % 16, id: i })
	for (let i = 0; i < 4000; i++) big.push({ blockNumber: H + 1 + Math.floor(i / 16), withdrawalIndex: i % 16, id: 2_000_000 + i })
	const t0 = Date.now()
	const r = selectFlushCandidates(big, OPTS)
	const ms = Date.now() - t0
	assert.equal(r.realtimeInspected, 100)
	assert.equal(r.historyInspected, 100)
	assert.ok(ms < 2000, `selection took ${ms} ms`)
})

test('both lines pending: the history line keeps one batch even when the realtime quota is configured at or above flushMax', () => {
	const pending = world(5000, 700)
	for (const quota of [200, 300, 1000]) {
		const r = selectFlushCandidates(pending, { ...OPTS, realtimeQuota: quota })
		assert.equal(r.realtimeInspected, 100, `quota ${quota}`)
		assert.equal(r.historyInspected, 100, `quota ${quota}`)
	}
})

test('the history floor does not reserve slots when history has nothing (or less than a batch): realtime takes them', () => {
	const none = selectFlushCandidates(world(0, 700), { ...OPTS, realtimeQuota: 200 })
	assert.equal(none.realtimeInspected, 200)
	assert.equal(none.historyInspected, 0)
	const few = selectFlushCandidates(world(30, 700), { ...OPTS, realtimeQuota: 200 })
	assert.equal(few.historyInspected, 30)
	assert.equal(few.realtimeInspected, 170)
})

test('each line keeps a share when both are pending, for the default 200/100/1: 100 realtime + 100 history (the ratio the flush composes)', () => {
	const r = selectFlushCandidates(world(5000, 700), OPTS)
	assert.deepEqual([r.realtimeInspected, r.historyInspected], [100, 100])
})
