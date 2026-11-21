/**
 * P1 of the Lab pools baseline: invariant C (history pays only blocks <= the committed cursor), the back-pressure fix, and the observability fields.
 * Pure functions and a small in-memory simulation. No RPC, no beacon, no socket, no files.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readSegmentedState, writeSegmentedState } from './labClPayoutStateStore'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import { buildLabInFlightWithdraw, resumeLabWithdrawInFlight, type LabInFlightWithdraw, type LabLifecycleDeps } from './labClPayoutBatchLifecycle'
import { LAB_MINING_POOL_FIXED } from './labMiningPoolPayoutSigner'
import { decideLinePauses, nextPaused, PENDING_HIGH_WATER_ALL_DEFAULT, PENDING_HIGH_WATER_HISTORY_DEFAULT, BACKPRESSURE_RESUME_RATIO } from './labBackpressure'
import { planPrune } from './labConsumedPrune'
import { selectFlushCandidates, type FlushPos } from './labFlushSelect'
import {
	HISTORY_PAY_BEHIND_CURSOR_ENV,
	ScanBottleneckTracker,
	advanceMaxPaidHistoryBlock,
	checkInvariantC,
	countHistoryAhead,
	mergeInitialMaxPaid,
	planInvariantCFlush,
	settleKeysAndAdvance,
	frontLead,
	historyMaxBlockFor,
	initialMaxPaidHistoryBlock,
	resolveHistoryPayBehindCursor,
} from './labInvariantC'
import { formatFlushSummary, newLabFlushCounters } from './labScanSummary'

const H = 1_000_000
type E = FlushPos & { id: number }
let seq = 0
const mk = (blockNumber: number, withdrawalIndex = 0): E => ({ blockNumber, withdrawalIndex, id: seq++ })

// deterministic pseudo-random numbers (no Math.random: the cases must be reproducible)
function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 0x100000000
	}
}

// ------------------------------------------------------------ flag and limit
test('C flag: only 1/true/yes/on switch it on; unset and garbage are off', () => {
	assert.equal(resolveHistoryPayBehindCursor({}), false)
	for (const v of ['1', 'true', 'TRUE', ' yes ', 'on']) assert.equal(resolveHistoryPayBehindCursor({ [HISTORY_PAY_BEHIND_CURSOR_ENV]: v }), true, v)
	for (const v of ['0', 'false', 'off', '', 'maybe', '2']) assert.equal(resolveHistoryPayBehindCursor({ [HISTORY_PAY_BEHIND_CURSOR_ENV]: v }), false, v)
})

test('C limit: off = no limit; on = committed cursor; unset cursor = pay nothing from history (fail-closed)', () => {
	assert.equal(historyMaxBlockFor(false, 123), null)
	assert.equal(historyMaxBlockFor(false, null), null)
	assert.equal(historyMaxBlockFor(true, 123), 123)
	assert.equal(historyMaxBlockFor(true, null), -1)
	assert.equal(historyMaxBlockFor(true, undefined), -1)
	assert.equal(historyMaxBlockFor(true, Number.NaN), -1)
})

// ------------------------------------------------------------ selection
function legacyOldest<T extends FlushPos>(all: T[], n: number): T[] {
	return [...all].sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex).slice(0, n)
}

test('C selection: with the limit absent, null, or above every block, the picks are identical (200 random worlds, both quota modes)', () => {
	const r = rng(7)
	for (let i = 0; i < 200; i++) {
		const nHist = Math.floor(r() * 900)
		const nRt = Math.floor(r() * 400)
		const all: E[] = []
		for (let k = 0; k < nHist; k++) all.push(mk(100 + Math.floor(r() * 5000), k))
		for (let k = 0; k < nRt; k++) all.push(mk(H + 1 + Math.floor(r() * 500), k))
		const flushMax = 50 + Math.floor(r() * 300)
		const base = { freezeH: H, flushMax, realtimeQuota: r() < 0.5 ? 0 : Math.floor(r() * flushMax), historyFloor: 20, historyHeld: r() < 0.1 }
		const a = selectFlushCandidates(all, base)
		const b = selectFlushCandidates(all, { ...base, historyMaxBlock: null })
		const c = selectFlushCandidates(all, { ...base, historyMaxBlock: Number.MAX_SAFE_INTEGER })
		assert.deepEqual(b.ordered, a.ordered)
		assert.deepEqual(c.ordered, a.ordered)
		assert.equal(a.historyAheadPending, 0, 'limit off: nothing is "ahead"')
		assert.equal(a.historyPayablePending, a.historyPending)
		assert.equal(c.historyAheadPending, 0)
		assert.deepEqual([c.realtimeInspected, c.historyInspected], [a.realtimeInspected, a.historyInspected])
	}
})

test('C selection: with the limit on, no history pick is beyond the cursor, order stays oldest-first, payable + ahead = history pending', () => {
	const r = rng(11)
	for (let i = 0; i < 200; i++) {
		const all: E[] = []
		for (let k = 0; k < 600; k++) all.push(mk(100 + Math.floor(r() * 3000), k))
		for (let k = 0; k < 150; k++) all.push(mk(H + 1 + Math.floor(r() * 100), k))
		const cursor = 100 + Math.floor(r() * 3200)
		const flushMax = 60 + Math.floor(r() * 200)
		const quota = r() < 0.7 ? Math.floor(r() * flushMax) : 0
		const sel = selectFlushCandidates(all, { freezeH: H, flushMax, realtimeQuota: quota, historyFloor: 25, historyMaxBlock: cursor })
		const hist = sel.ordered.filter((e) => e.blockNumber <= H)
		assert.ok(hist.every((e) => e.blockNumber <= cursor), 'a history entry beyond the cursor was picked')
		for (let k = 1; k < hist.length; k++) {
			const p = hist[k - 1]!
			const q = hist[k]!
			assert.ok(p.blockNumber < q.blockNumber || (p.blockNumber === q.blockNumber && p.withdrawalIndex <= q.withdrawalIndex), 'history stays oldest first')
		}
		const ahead = all.filter((e) => e.blockNumber <= H && e.blockNumber > cursor).length
		const historyTotal = all.filter((e) => e.blockNumber <= H).length
		assert.equal(sel.historyAheadPending, ahead)
		assert.equal(sel.historyPending, historyTotal)
		assert.equal(sel.historyPayablePending + sel.historyAheadPending, sel.historyPending)
		assert.ok(sel.ordered.length <= flushMax)
		// the picks are the oldest ELIGIBLE history entries
		const eligible = all.filter((e) => e.blockNumber <= H && e.blockNumber <= cursor)
		const picked = new Set(hist)
		const legacy = legacyOldest(eligible, hist.length)
		assert.deepEqual(new Set(legacy), picked, 'the picked history entries are the oldest eligible ones')
	}
})

test('C selection: unset cursor (-1) pays nothing from history, realtime is untouched; the history floor counts only eligible entries', () => {
	const all: E[] = []
	for (let i = 0; i < 300; i++) all.push(mk(100 + i))
	for (let i = 0; i < 300; i++) all.push(mk(H + 1 + i))
	const none = selectFlushCandidates(all, { freezeH: H, flushMax: 200, realtimeQuota: 100, historyFloor: 100, historyMaxBlock: -1 })
	assert.equal(none.historyInspected, 0)
	assert.equal(none.realtimeInspected, 200, 'with no payable history every slot goes to realtime (spare slots rule)')
	assert.equal(none.historyAheadPending, 300)
	// only 30 eligible history entries: the floor (100) is capped by what exists, the rest goes to realtime
	const few = selectFlushCandidates(all, { freezeH: H, flushMax: 200, realtimeQuota: 100, historyFloor: 100, historyMaxBlock: 100 + 29 })
	assert.equal(few.historyInspected, 30)
	assert.equal(few.realtimeInspected, 170)
	// the realtime quota is unchanged by the limit when both lines have enough eligible entries
	const both = selectFlushCandidates(all, { freezeH: H, flushMax: 200, realtimeQuota: 100, historyFloor: 100, historyMaxBlock: 100 + 199 })
	assert.deepEqual([both.realtimeInspected, both.historyInspected], [100, 100])
})

// ------------------------------------------------------------ back-pressure
test('C back-pressure: with nothing ahead (default) the decision is exactly the old one', () => {
	const high = { history: 1_800_000, all: 2_000_000 }
	for (const size of [0, 1_000_000, 1_709_999, 1_710_000, 1_799_999, 1_800_000, 1_900_000, 1_999_999, 2_000_000, 2_500_000]) {
		for (const ph of [false, true]) {
			for (const pr of [false, true]) {
				const prev = { history: ph, realtime: pr }
				assert.deepEqual(decideLinePauses(prev, size, high), decideLinePauses(prev, size, high, 0))
				const rt = nextPaused(pr, size, high.all)
				assert.deepEqual(decideLinePauses(prev, size, high), { history: nextPaused(ph, size, high.history) || rt, realtime: rt })
			}
		}
	}
})

test('C back-pressure: entries ahead of the cursor do not freeze the history scan, but the memory guard still counts the whole pool', () => {
	const high = { history: PENDING_HIGH_WATER_HISTORY_DEFAULT, all: PENDING_HIGH_WATER_ALL_DEFAULT }
	// today: 1.66M pending, 1.585M of it ahead of the cursor. Old rule at 1.85M total would pause history; the new rule does not.
	const total = 1_850_000
	assert.equal(decideLinePauses({ history: false, realtime: false }, total, high).history, true, 'old behaviour: history paused')
	assert.deepEqual(decideLinePauses({ history: false, realtime: false }, total, high, 1_585_000), { history: false, realtime: false }, 'new: payable + realtime = 265k, far below')
	// payable + realtime above the level still pauses history
	assert.equal(decideLinePauses({ history: false, realtime: false }, 1_900_000, high, 50_000).history, true)
	// resume uses the history basis with its own 0.95 threshold
	const resume = Math.floor(high.history * BACKPRESSURE_RESUME_RATIO)
	assert.equal(decideLinePauses({ history: true, realtime: false }, resume - 1 + 100_000, high, 100_000).history, false)
	assert.equal(decideLinePauses({ history: true, realtime: false }, resume + 100_000, high, 100_000).history, true)
	// the all-lines guard uses the TOTAL: pool 2.0M with 1.9M ahead still pauses realtime (and history with it)
	assert.deepEqual(decideLinePauses({ history: false, realtime: false }, 2_000_000, high, 1_900_000), { history: true, realtime: true })
})

test('C back-pressure (a): a small ahead stock, payable + realtime push the total past 2.0M -> all paused -> payments continue -> resume below 0.95 x 2.0M, each on its own basis', () => {
	const high = { history: 1_800_000, all: 2_000_000 }
	let paused = { history: false, realtime: false }
	let total = 1_990_000
	const ahead = 100_000
	// scanning adds 20k: crosses 2.0M
	total += 20_000
	paused = decideLinePauses(paused, total, high, ahead)
	assert.deepEqual(paused, { history: true, realtime: true })
	// payments keep draining the pool while paused (scan stays stopped): still paused until below 0.95 * 2.0M
	const resumeAll = Math.floor(high.all * BACKPRESSURE_RESUME_RATIO)
	while (total >= resumeAll) {
		total -= 5_000 // payments
		paused = decideLinePauses(paused, total, high, ahead)
		if (total >= resumeAll) assert.equal(paused.realtime, true, `still paused at ${total}`)
	}
	assert.equal(paused.realtime, false, 'resumed once the total is below 0.95 x 2.0M')
	// history has its own basis (total - ahead) and its own resume level 0.95 x 1.8M = 1.71M: still paused here (total - ahead is about 1.8M)
	assert.equal(paused.history, true, 'history resumes on its own basis, not with the all-lines level')
	const resumeHistory = Math.floor(high.history * BACKPRESSURE_RESUME_RATIO)
	while (total - ahead >= resumeHistory) {
		total -= 5_000
		paused = decideLinePauses(paused, total, high, ahead)
		if (total - ahead >= resumeHistory) assert.equal(paused.history, true, `history still paused at ${total}`)
	}
	assert.equal(paused.history, false, 'history resumed once (total - ahead) is below 0.95 x 1.8M')
	// and the cursor was never frozen by the ahead stock: with the pool far below 2.0M the history scan runs
	assert.equal(decideLinePauses({ history: false, realtime: false }, 1_700_000, high, 1_600_000).history, false)
})

// ------------------------------------------------------------ maxPaidHistoryBlock, self-check, lead
test('C maxPaid: monotonic, history entries only, never decreases, and the first-run initial value is the oldest pending history block (K1)', () => {
	assert.equal(advanceMaxPaidHistoryBlock(undefined, [], H), undefined)
	assert.equal(advanceMaxPaidHistoryBlock(undefined, [{ blockNumber: 500 }, { blockNumber: 300 }], H), 500)
	assert.equal(advanceMaxPaidHistoryBlock(500, [{ blockNumber: 400 }], H), 500, 'never goes back')
	assert.equal(advanceMaxPaidHistoryBlock(500, [{ blockNumber: 900 }, { blockNumber: H + 5 }], H), 900, 'realtime blocks do not count')
	assert.equal(advanceMaxPaidHistoryBlock(undefined, [{ blockNumber: H + 5 }], H), undefined)
	assert.deepEqual(initialMaxPaidHistoryBlock([{ blockNumber: 700 }, { blockNumber: 650 }, { blockNumber: H + 1 }], H, 2000), { value: 650, source: 'oldest-pending-history' })
	assert.deepEqual(initialMaxPaidHistoryBlock([{ blockNumber: H + 1 }], H, 2000), { value: 1999, source: 'cursor-minus-1' })
	assert.equal(initialMaxPaidHistoryBlock([], H, null), null)
})

test('C self-check and frontLead: <= cursor is fine, beyond it is a violation; lead is max paid minus cursor', () => {
	assert.deepEqual(checkInvariantC(undefined, 100), { ok: true })
	assert.deepEqual(checkInvariantC(100, 100), { ok: true })
	assert.deepEqual(checkInvariantC(99, 100), { ok: true })
	assert.deepEqual(checkInvariantC(101, 100), { ok: false, lead: 1 })
	assert.deepEqual(checkInvariantC(5, null), { ok: false, lead: 6 }, 'unset cursor counts as -1')
	assert.equal(frontLead(90, 100), -10)
	assert.equal(frontLead(110, 100), 10)
	assert.equal(frontLead(undefined, 100), undefined)
	assert.equal(frontLead(100, null), undefined)
})

test('C alert: "scan is the bottleneck" needs 3 flushes in a row AND 10 minutes, resets when the condition clears, and is separate from the pause', () => {
	const t = new ScanBottleneckTracker()
	const cond = { payableHistoryCandidates: 0, historyAhead: 500, idleHistoryWallet: true }
	const min = 60_000
	assert.equal(t.observe(cond, 0), false)
	assert.equal(t.observe(cond, 4 * min), false, '2nd observation, only 4 minutes')
	assert.equal(t.observe(cond, 8 * min), false, '3rd observation but only 8 minutes')
	assert.equal(t.observe(cond, 11 * min), true, '4th observation and over 10 minutes')
	assert.equal(t.observe({ ...cond, payableHistoryCandidates: 3 }, 12 * min), false, 'payable candidates reset it')
	assert.equal(t.observe(cond, 13 * min), false, 'the streak restarted')
	assert.equal(t.observe({ ...cond, historyAhead: 0 }, 14 * min), false, 'nothing ahead: not a scan bottleneck')
	assert.equal(t.observe({ ...cond, idleHistoryWallet: false }, 15 * min), false, 'wallet busy: not a scan bottleneck')
})

// ------------------------------------------------------------ journal line
test('C journal: flag off the flush-summary line is the old text byte for byte; flag on only appends the new fields', () => {
	const c = newLabFlushCounters()
	c.inspect = 200
	c.pendingAtInspect = 1_662_581
	c.signable = 200
	c.batches = 2
	c.inspectRealtime = 100
	c.inspectHistory = 100
	c.pendingRealtime = 42_775
	c.pendingHistory = 1_619_806
	const old =
		'flush-summary inspect=200/1662581 droppedChainConsumed=0 unconfirmed=0 guardianHeld=0 held=0 signable=200 batches=2 ' +
		'settledEntries=200 consumedDelta=200 failed=0 inspectRealtime=100 inspectHistory=100 pendingRealtime=42775 pendingHistory=1619806'
	assert.equal(formatFlushSummary(c, 200), old)
	c.invariantC = { pendingHistoryPayable: 34_172, pendingHistoryAhead: 1_585_634, histAheadHeld: 1_585_634, histCursor: 2_013_146, maxPaidHistoryBlock: 2_010_452, frontLead: -2_694 }
	const on = formatFlushSummary(c, 200)!
	assert.ok(on.startsWith(old + ' '), 'old text is a prefix')
	assert.equal(
		on.slice(old.length),
		' pendingHistoryPayable=34172 pendingHistoryAhead=1585634 histAheadHeld=1585634 histCursor=2013146 maxPaidHistoryBlock=2010452 frontLead=-2694'
	)
	c.invariantC = { ...c.invariantC, histCursor: null, maxPaidHistoryBlock: null, frontLead: null }
	assert.ok(formatFlushSummary(c, 200)!.endsWith('histCursor=- maxPaidHistoryBlock=- frontLead=-'))
})

// ------------------------------------------------------------ the property: no duplicate payment from pruning (with a control group)
type SimEntry = FlushPos & { key: string }
/**
 * A small model of the daemon around the rescan hole: every history entry is pre-queued (as the old scanner left them), the cursor rescans block
 * by block, payments take the oldest candidates, and the consumed set is pruned when it passes its cap (planPrune, oldest first, pending skipped).
 * A rescan that finds a key in neither consumed nor pending queues it again (the on-chain view does not know Lab payments).
 */
function simulate(opts: { blocks: number; perBlock: number; cursorStart: number; cursorPerCycle: number; payPerCycle: number; cap: number; invariantC: boolean }): { duplicatePays: number; paid: number; cyclesRun: number } {
	const truth = new Map<number, SimEntry[]>()
	const pending = new Map<string, SimEntry>()
	for (let b = 1; b <= opts.blocks; b++) {
		const list: SimEntry[] = []
		for (let i = 0; i < opts.perBlock; i++) list.push({ blockNumber: b, withdrawalIndex: i, key: `k${b}_${i}` })
		truth.set(b, list)
		for (const e of list) pending.set(e.key, e)
	}
	const consumed = new Map<string, true>()
	const everPaid = new Set<string>()
	let cursor = opts.cursorStart
	let duplicatePays = 0
	let paid = 0
	let cycles = 0
	const FREEZE = opts.blocks
	while ((pending.size > 0 || cursor < opts.blocks) && cycles < 200_000) {
		cycles++
		// scan: the cursor advances and rescans the blocks it passes
		const to = Math.min(opts.blocks, cursor + opts.cursorPerCycle)
		for (let b = cursor + 1; b <= to; b++) {
			for (const e of truth.get(b)!) {
				if (consumed.has(e.key) || pending.has(e.key)) continue // localHit
				pending.set(e.key, e) // queued again: neither local set knows it
			}
		}
		cursor = to
		// flush: oldest eligible candidates, paid and consumed
		const sel = selectFlushCandidates(pending.values(), { freezeH: FREEZE, flushMax: opts.payPerCycle, realtimeQuota: 0, historyMaxBlock: opts.invariantC ? cursor : null })
		for (const e of sel.ordered as SimEntry[]) {
			if (everPaid.has(e.key)) duplicatePays++
			everPaid.add(e.key)
			paid++
			pending.delete(e.key)
			consumed.set(e.key, true)
		}
		// prune (planPrune: oldest first, pending skipped)
		if (consumed.size > opts.cap) {
			const pendingKeys = new Set(pending.keys())
			for (const k of planPrune([...consumed.keys()], pendingKeys, opts.cap)) consumed.delete(k)
		}
		if (sel.ordered.length === 0 && cursor >= opts.blocks && pending.size > 0) break // nothing left that can ever be paid
	}
	return { duplicatePays, paid, cyclesRun: cycles }
}

test('C property: with invariant C on, pruning never causes a duplicate payment, whatever the speeds and the cap (60 random cases)', () => {
	const r = rng(2026)
	for (let i = 0; i < 60; i++) {
		const perBlock = 3 + Math.floor(r() * 10)
		const blocks = 120 + Math.floor(r() * 200)
		const res = simulate({
			blocks,
			perBlock,
			cursorStart: Math.floor(r() * 30),
			cursorPerCycle: 1 + Math.floor(r() * 6),
			payPerCycle: 5 + Math.floor(r() * 120),
			cap: 30 + Math.floor(r() * 150),
			invariantC: true,
		})
		assert.equal(res.duplicatePays, 0, `case ${i}: duplicate payments with invariant C on`)
		assert.equal(res.paid, blocks * perBlock, `case ${i}: every entry paid exactly once`)
	}
})

test('C property (control group): with the invariant off the same model DOES pay twice when payments outrun the cursor and the consumed cap is small', () => {
	// payments fast, cursor slow, tiny cap: the adversarial combination the production numbers rule out only by speed ratio
	const bad = simulate({ blocks: 300, perBlock: 8, cursorStart: 0, cursorPerCycle: 1, payPerCycle: 100, cap: 100, invariantC: false })
	assert.ok(bad.duplicatePays > 0, `the control must show the hole (duplicates=${bad.duplicatePays})`)
	// the same parameters with the invariant on: none
	const good = simulate({ blocks: 300, perBlock: 8, cursorStart: 0, cursorPerCycle: 1, payPerCycle: 100, cap: 100, invariantC: true })
	assert.equal(good.duplicatePays, 0)
	assert.equal(good.paid, 300 * 8)
	// and the production-like safe case (cursor faster than payments) is clean even without it, so the invariant costs nothing there
	const calm = simulate({ blocks: 300, perBlock: 8, cursorStart: 5, cursorPerCycle: 20, payPerCycle: 40, cap: 100, invariantC: false })
	assert.equal(calm.duplicatePays, 0)
})

// ------------------------------------------------------------ persistence of the high-water mark (J1)
test('C persistence: maxPaidHistoryBlock survives a state write and read (it is a plain scalar of the v2 store), and a later write keeps the larger value', () => {
	const dir = mkdtempSync(join(tmpdir(), 'labinvc-'))
	try {
		const v2 = join(dir, 'state.v2')
		writeSegmentedState(v2, { pending: [], consumedEventKeys: {}, exitedPubkeys: {}, historyCursor: 2_013_146, maxPaidHistoryBlock: 2_010_452 })
		const back = readSegmentedState(v2)
		assert.equal((back as unknown as { maxPaidHistoryBlock?: number }).maxPaidHistoryBlock, 2_010_452)
		assert.equal((back as unknown as { historyCursor?: number }).historyCursor, 2_013_146)
		// the daemon only ever advances it with advanceMaxPaidHistoryBlock (max), so a second write carries the larger value
		const next = advanceMaxPaidHistoryBlock(2_010_452, [{ blockNumber: 2_010_460 }], H + 5_000_000)
		writeSegmentedState(v2, { pending: [], consumedEventKeys: {}, exitedPubkeys: {}, historyCursor: 2_013_200, maxPaidHistoryBlock: next })
		assert.equal((readSegmentedState(v2) as unknown as { maxPaidHistoryBlock?: number }).maxPaidHistoryBlock, 2_010_460)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

// ------------------------------------------------------------ review M1/M3: pure flush-start plan, merge on every start, counts, settle hook
test('C count: history total and ahead are counted in one pass; realtime entries are ignored', () => {
	const pool = [{ blockNumber: 10 }, { blockNumber: 20 }, { blockNumber: 30 }, { blockNumber: H + 1 }, { blockNumber: H + 2 }]
	assert.deepEqual(countHistoryAhead(pool, H, 20), { histTotal: 3, histAhead: 1 })
	assert.deepEqual(countHistoryAhead(pool, H, 5), { histTotal: 3, histAhead: 3 })
	assert.deepEqual(countHistoryAhead(pool, H, null), { histTotal: 3, histAhead: 3 }, 'unset cursor: everything is ahead')
	assert.deepEqual(countHistoryAhead([], H, 20), { histTotal: 0, histAhead: 0 })
})

test('C merge (M1): value = max(current, oldest pending history block) capped at the cursor; an off -> on switch with a stale high-water is repaired', () => {
	const pend = [{ blockNumber: 700 }, { blockNumber: 650 }, { blockNumber: H + 1 }]
	// first ever: the oldest pending block itself
	assert.deepEqual(mergeInitialMaxPaid(undefined, pend, H, 2000).value, 650)
	// stale high-water from before an off period (payments moved on while the flag was off): the merge raises it
	const stale = mergeInitialMaxPaid(400, pend, H, 2000)
	assert.equal(stale.value, 650)
	assert.equal(stale.changed, true)
	assert.match(stale.log!, /raised 400 -> 650/)
	// a larger current value is kept (never lowered)
	const keep = mergeInitialMaxPaid(900, pend, H, 2000)
	assert.equal(keep.value, 900)
	assert.equal(keep.changed, false)
	assert.equal(keep.log, null)
	// the oldest pending block beyond the cursor is capped at the cursor (no false violation)
	const cap = mergeInitialMaxPaid(undefined, [{ blockNumber: 5000 }], H, 3000)
	assert.equal(cap.value, 3000)
	assert.match(cap.log!, /capped-at-cursor/)
	// nothing known
	const none = mergeInitialMaxPaid(undefined, [], H, null)
	assert.equal(none.value, undefined)
	assert.match(none.log!, /cannot be initialised/)
})

test('C plan: flag off is a no-op; flag on merges once per process, sets the limit, and a violation stops history claims', () => {
	const pend = [{ blockNumber: 700 }, { blockNumber: 650 }]
	const off = planInvariantCFlush({ flagOn: false, freezeH: H, committedHistoryCursor: 2000, maxPaidHistoryBlock: undefined, initDone: false, pending: pend })
	assert.deepEqual(off, { historyMaxBlock: null, maxPaidHistoryBlock: undefined, stateChanged: false, initDone: false, logs: [], violation: null })
	const noFreeze = planInvariantCFlush({ flagOn: true, freezeH: undefined, committedHistoryCursor: 2000, maxPaidHistoryBlock: 5, initDone: false, pending: pend })
	assert.equal(noFreeze.historyMaxBlock, null, 'without a freeze height the lines cannot be told: no limit')
	const first = planInvariantCFlush({ flagOn: true, freezeH: H, committedHistoryCursor: 2000, maxPaidHistoryBlock: undefined, initDone: false, pending: pend })
	assert.equal(first.historyMaxBlock, 2000)
	assert.equal(first.maxPaidHistoryBlock, 650)
	assert.equal(first.stateChanged, true)
	assert.equal(first.initDone, true)
	assert.equal(first.violation, null)
	const second = planInvariantCFlush({ flagOn: true, freezeH: H, committedHistoryCursor: 2000, maxPaidHistoryBlock: 650, initDone: true, pending: pend })
	assert.equal(second.stateChanged, false, 'merge runs once per process')
	assert.equal(second.logs.length, 0)
	const bad = planInvariantCFlush({ flagOn: true, freezeH: H, committedHistoryCursor: 600, maxPaidHistoryBlock: 650, initDone: true, pending: pend })
	assert.deepEqual(bad.violation, { lead: 50 })
	assert.equal(bad.historyMaxBlock, -1, 'history claims stop')
	assert.ok(bad.logs.some((l) => l.startsWith('ALERT invariant C violated')))
	// the cursor passes the high-water: the stop clears by itself
	const cleared = planInvariantCFlush({ flagOn: true, freezeH: H, committedHistoryCursor: 700, maxPaidHistoryBlock: 650, initDone: true, pending: pend })
	assert.equal(cleared.violation, null)
	assert.equal(cleared.historyMaxBlock, 700)
	const unsetCursor = planInvariantCFlush({ flagOn: true, freezeH: H, committedHistoryCursor: null, maxPaidHistoryBlock: undefined, initDone: true, pending: pend })
	assert.equal(unsetCursor.historyMaxBlock, -1, 'unset cursor: no history payment')
})

test('C settle hook (M3): the high-water advances with the settle; a crash before the settle persist leaves it behind with pending intact; the retry advances it', async () => {
	type St = { freezeH: { height: number }; maxPaidHistoryBlock?: number; consumedEventKeys: Record<string, true>; inFlight: LabInFlightWithdraw | null; settled: number }
	const k = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
	const entries = [
		{ eventKey: k(1), blockNumber: 100 },
		{ eventKey: k(2), blockNumber: 105 },
		{ eventKey: k(3), blockNumber: H + 9 }, // realtime: must not move the history high-water
	]
	const mkWorld = () => {
		const pending = new Map<string, { eventKey: string; blockNumber: number }>(entries.map((e) => [e.eventKey, { ...e }]))
		const state: St = { freezeH: { height: H }, maxPaidHistoryBlock: 90, consumedEventKeys: {}, inFlight: null, settled: 0 }
		return { pending, state }
	}
	const live = mkWorld()
	live.state.inFlight = buildLabInFlightWithdraw(
		{ line: 'history', redeem: '0xc71e246DD78B37C2fABc905D340932F28F503433', pool: LAB_MINING_POOL_FIXED, amount: 10n ** 15n, eventKeys: entries.map((e) => e.eventKey) },
		new Date('2026-11-21T00:00:00Z')
	)
	// what is on disk: a deep copy taken at every persist
	let disk = { state: JSON.parse(JSON.stringify(live.state)) as St, pending: JSON.parse(JSON.stringify([...live.pending.values()])) as { eventKey: string; blockNumber: number }[] }
	const snapshot = (): void => {
		disk = { state: JSON.parse(JSON.stringify(live.state)), pending: JSON.parse(JSON.stringify([...live.pending.values()])) }
	}
	snapshot()
	let failSettlePersist = true
	const mkDeps = (w: { pending: Map<string, { eventKey: string; blockNumber: number }>; state: St }): LabLifecycleDeps => ({
		gate: new LabPayoutFailClosedGate(() => undefined),
		getInFlight: () => w.state.inFlight,
		setInFlight: (v) => {
			w.state.inFlight = v
		},
		countSettled: () => {
			w.state.settled++
		},
		persist: () => {
			// the settle persist is the one after setInFlight(null): fail it once, as a crash would
			if (w.state.inFlight === null && failSettlePersist) {
				failSettlePersist = false
				throw new Error('simulated crash before the settle persist')
			}
			if (w === live) snapshot()
		},
		confirmBeforeSend: async () => undefined,
		send: async () => ({ hash: `0x${'cd'.repeat(32)}` }),
		waitReceipt: async () => ({ status: 1 }),
		settle: (keys) => settleKeysAndAdvance(w.state, w.pending, keys, true),
		log: () => undefined,
	})
	// first attempt: the hook ran in memory, then the persist "crashes"
	await assert.rejects(resumeLabWithdrawInFlight(mkDeps(live)), /simulated crash/)
	assert.equal(live.state.maxPaidHistoryBlock, 105, 'in memory the high-water moved')
	// restart from disk: nothing of that settle was written
	const restarted = {
		state: JSON.parse(JSON.stringify(disk.state)) as St,
		pending: new Map<string, { eventKey: string; blockNumber: number }>(disk.pending.map((e) => [e.eventKey, e])),
	}
	assert.equal(restarted.state.maxPaidHistoryBlock, 90, 'on disk the high-water is still the old one')
	assert.equal(restarted.pending.size, 3, 'pending intact: nothing was lost')
	assert.deepEqual(Object.keys(restarted.state.consumedEventKeys), [])
	assert.ok(restarted.state.inFlight, 'the in-flight record is still there')
	// the retry settles once and advances the high-water from the pending pool
	assert.equal(await resumeLabWithdrawInFlight(mkDeps(restarted)), 'settled')
	assert.equal(restarted.state.maxPaidHistoryBlock, 105, 'history entries advanced it; the realtime entry did not')
	assert.equal(restarted.pending.size, 0)
	assert.equal(Object.keys(restarted.state.consumedEventKeys).length, 3)
	assert.equal(restarted.state.inFlight, null)
})

test('C settle hook: flag off leaves the high-water untouched and still consumes the keys', () => {
	const pending = new Map([['0xa', { blockNumber: 100 }]])
	const state = { freezeH: { height: H }, maxPaidHistoryBlock: 90, consumedEventKeys: {} as Record<string, true> }
	settleKeysAndAdvance(state, pending, ['0xa'], false)
	assert.equal(state.maxPaidHistoryBlock, 90)
	assert.deepEqual(state.consumedEventKeys, { '0xa': true })
	assert.equal(pending.size, 0)
})
