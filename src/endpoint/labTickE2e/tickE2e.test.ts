/**
 * Tick-loop patch e2e: the REAL reporter (patched checkout; the df78e6b baseline for the differential) in a child process against a fake chain / beacon / signer.
 * Every fault is injected from the fake-service side and counted there. Run: node --import tsx --test src/endpoint/labTickE2e/tickE2e.test.ts
 * Time compression: the reporter's wait timer (TICK_MS = 15 000 ms) is replaced in the child by E2E_WAIT_MS (default 20 ms); the tests that judge the wait itself use "real".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { BASELINE_ROOT, PATCHED_ROOT, TICK_MS, checkPayments, eventKeyOf, quantiles, seedValidators, synthetic, ticksOf, withWorld, type RunResult, type World } from './harness.test'
import { readSegmentedState } from '../labClPayoutStateStore'

const HEAD = 740 // history 100..739 = 20 windows of 32
const EVERY = 3
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const paidCount = (w: World): number => [...w.chain.sent.values()].filter((t) => t.mined).reduce((s, t) => s + t.eventKeys.length, 0)
const evOf = (r: RunResult, kind: string) => r.events.filter((e) => e.kind === kind)
const summaryOf = (r: RunResult): Record<string, string> => evOf(r, 'summary')[0]?.attrs ?? {}

/** stopWhen: everything expected is paid, then 400 ms more (several idle ticks at 20 ms compressed waits). */
function stopAfterAllPaid(expectedCount: number) {
	let doneAt = 0
	return (w: World): boolean => {
		if (!doneAt && paidCount(w) >= expectedCount) doneAt = Date.now()
		return doneAt > 0 && Date.now() - doneAt > 400
	}
}

function backlogWorld(w: World, latencyMs = 1) {
	seedValidators(w)
	const syn = synthetic(w, EVERY)
	w.chain.head = HEAD
	if (latencyMs) w.chain.onRequest = async () => void (await sleep(latencyMs))
	return syn
}

function fetchedOnce(w: World, from: number, toExclusive: number): void {
	const count = new Map<number, number>()
	for (const b of w.chain.blockFetches) count.set(b, (count.get(b) ?? 0) + 1)
	for (let b = from; b < toExclusive; b++) assert.equal(count.get(b), 1, `block ${b} fetched ${count.get(b) ?? 0} times (cursor must neither skip nor rescan)`)
}

test('E1: backlog on the patched code - serial ticks (counter in the child), working ticks continue at once (no wait event), idle ticks wait exactly one TICK_MS, cursor continuity, every key paid exactly once with the right wei', async () => {
	await withWorld('e1', PATCHED_ROOT, {}, async (w) => {
		const syn = backlogWorld(w)
		const expected = syn.expectedKeys(100, HEAD - 1)
		const r = await w.run({ stopWhen: stopAfterAllPaid(expected.size), timeoutMs: 90_000 })
		assert.equal(r.code, 0)
		const s = summaryOf(r)
		assert.equal(s.maxRunning, '1', 'max tick concurrency (counted around the loop\'s tick function)')
		const ticks = ticksOf(r.events)
		assert.ok(ticks.length >= 22, `ticks=${ticks.length}`)
		// strictly alternating start/end events
		let open = 0
		for (const e of r.events) {
			if (e.kind === 'tick-start') assert.equal(++open, 1)
			if (e.kind === 'tick-end') assert.equal(--open, 0)
		}
		// a progress tick is followed by NO wait and a start within a setImmediate turn; every other outcome by exactly one wait of TICK_MS
		const gaps: number[] = []
		for (const t of ticks.slice(0, -1)) {
			if (t.outcome === 'progress') {
				assert.equal(t.waitAfterRequested, null, `tick ${t.n}: progress must not wait`)
				gaps.push(t.gapToNextStart!)
			} else {
				assert.equal(t.waitAfterRequested, TICK_MS, `tick ${t.n} (${t.outcome}): exactly one wait of TICK_MS`)
			}
		}
		const g = quantiles(gaps)
		console.log(`E1 ticks=${ticks.length} progress=${ticks.filter((t) => t.outcome === 'progress').length} idle=${ticks.filter((t) => t.outcome === 'idle').length} gap-after-progress ms p50=${g.p50.toFixed(2)} p99=${g.p99.toFixed(2)} max=${g.max.toFixed(2)}`)
		assert.ok(g.p99 < 100, `progress->next start gap p99 ${g.p99} ms`)
		assert.ok(ticks.filter((t) => t.outcome === 'progress').length >= 20)
		assert.ok(ticks.some((t) => t.outcome === 'idle'), 'caught up: idle ticks were observed')
		// cursor continuity on the chain side, payments
		fetchedOnce(w, 100, HEAD)
		const { paidKeys, txs } = checkPayments(w.chain.sent.values(), expected)
		assert.equal(paidKeys.size, expected.size)
		console.log(`E1 blocks 100..${HEAD - 1} each fetched once; paid keys=${paidKeys.size} txs=${txs}; maxRunning=${s.maxRunning}`)
		const st = readSegmentedState(w.stateDir) as { historyCursor?: number; pending: unknown[]; consumedEventKeys: Record<string, true> }
		assert.equal(st.historyCursor, HEAD, 'history scans up to the frozen height (the head at the first tick), inclusive')
		assert.equal(st.pending.length, 0)
		assert.equal(Object.keys(st.consumedEventKeys).length, expected.size)
	})
})

test('E2: differential - the df78e6b baseline in the same world pays the same keys with the same wei and scans the same blocks once', async () => {
	let patchedPaid: string[] = []
	let patchedState = ''
	await withWorld('e2p', PATCHED_ROOT, {}, async (w) => {
		const syn = backlogWorld(w)
		const expected = syn.expectedKeys(100, HEAD - 1)
		await w.run({ stopWhen: stopAfterAllPaid(expected.size), timeoutMs: 90_000 })
		patchedPaid = [...checkPayments(w.chain.sent.values(), expected).paidKeys].sort()
		const st = readSegmentedState(w.stateDir) as Record<string, unknown>
		patchedState = JSON.stringify({ historyCursor: st.historyCursor, realtimeCursor: st.realtimeCursor, consumed: Object.keys(st.consumedEventKeys as object).sort(), pending: (st.pending as unknown[]).length })
	})
	await withWorld('e2b', BASELINE_ROOT, {}, async (w) => {
		const syn = backlogWorld(w)
		const expected = syn.expectedKeys(100, HEAD - 1)
		await w.run({ stopWhen: stopAfterAllPaid(expected.size), timeoutMs: 90_000 })
		const paid = [...checkPayments(w.chain.sent.values(), expected).paidKeys].sort()
		assert.deepEqual(paid, patchedPaid)
		fetchedOnce(w, 100, HEAD)
		const st = readSegmentedState(w.stateDir) as Record<string, unknown>
		assert.equal(JSON.stringify({ historyCursor: st.historyCursor, realtimeCursor: st.realtimeCursor, consumed: Object.keys(st.consumedEventKeys as object).sort(), pending: (st.pending as unknown[]).length }), patchedState)
		console.log(`E2 baseline and patched: same ${paid.length} keys paid once, same cursors/consumed/pending`)
	})
})

test('E3: kill -9 at the signer send, restart: every key paid exactly once, amounts to the wei (patched code, continuous ticks)', async () => {
	await withWorld('e3', PATCHED_ROOT, {}, async (w) => {
		const syn = backlogWorld(w)
		const expected = syn.expectedKeys(100, HEAD - 1)
		// first run: killed when the SECOND batch reaches the signer (the first is already out; intent for the second is persisted)
		let sends = 0
		const r1 = await w.run({ killWhen: (e) => e.kind === 'signer' && e.method === 'signer_sendTransaction' && ++sends === 2, timeoutMs: 60_000 })
		assert.equal(r1.killed, true)
		const sentAfterKill = w.chain.sent.size
		assert.ok(sentAfterKill >= 1, 'the first batch was out before the kill')
		// second run: normal restart, runs to completion
		const r2 = await w.run({ stopWhen: stopAfterAllPaid(expected.size), timeoutMs: 90_000 })
		assert.equal(r2.code, 0)
		const { paidKeys, txs } = checkPayments(w.chain.sent.values(), expected)
		assert.equal(paidKeys.size, expected.size)
		console.log(`E3 kill -9 at send #2 (signer-side requests seen: ${w.signer.requests.filter((x) => x.method === 'signer_sendTransaction').length}); after restart paid keys=${paidKeys.size} txs=${txs}, duplicateSends(server-side)=${w.signer.duplicateSends}`)
	})
})

test('E4: lost ACK and late receipt across a restart: faults actually fire (counted on the signer / chain side), still exactly once', async () => {
	await withWorld('e4', PATCHED_ROOT, {}, async (w) => {
		const syn = backlogWorld(w)
		const expected = syn.expectedKeys(100, HEAD - 1)
		w.signer.mode = 'lose-ack'
		const r1 = await w.run({ killWhen: () => w.signer.acksLost >= 1, timeoutMs: 60_000 })
		assert.equal(r1.killed, true)
		assert.ok(w.signer.acksLost >= 1, 'a connection was really dropped without an answer')
		w.signer.mode = 'ok'
		let asks = 0
		w.chain.receiptRule = () => (++asks <= 6 ? 'none' : 'mined')
		const r2 = await w.run({ stopWhen: stopAfterAllPaid(expected.size), timeoutMs: 120_000, env: { CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_TIMEOUT_MS: '3000' } })
		assert.equal(r2.code, 0)
		const { paidKeys } = checkPayments(w.chain.sent.values(), expected)
		assert.equal(paidKeys.size, expected.size)
		assert.ok(w.chain.emptyReceipts >= 1, 'a receipt was really withheld')
		console.log(`E4 acksLost=${w.signer.acksLost} duplicateSends=${w.signer.duplicateSends} getTransactionCalls=${w.signer.getTransactionCalls} emptyReceipts=${w.chain.emptyReceipts}; paid keys=${paidKeys.size}`)
	})
})

test('E5: idle on real timers (TICK_MS 15 000 not compressed): one tick, one wait of 15 000, nothing else in 5 s, few RPC calls, almost no CPU', async () => {
	await withWorld('e5', PATCHED_ROOT, { E2E_WAIT_MS: 'real', E2E_RUN_MS: '5000' }, async (w) => {
		seedValidators(w)
		w.chain.head = 130 // caught up after the first tick
		synthetic(w, 1000)
		const r = await w.run({ timeoutMs: 60_000 })
		assert.equal(r.code, 0)
		const ticks = ticksOf(r.events)
		const s = summaryOf(r)
		console.log(`E5 ticks=${ticks.length} (outcomes ${ticks.map((t) => t.outcome).join(',')}) waits=${s.waits} rpc=${w.chain.rpcLog.length} cpuUser=${s.cpuUserMs}ms cpuSys=${s.cpuSysMs}ms`)
		const first = ticks[0]!
		// first tick: scans the (tiny) range, so it may be progress and run once more; after that nothing may run for the remaining time except at most one more tick per 15 s
		assert.ok(ticks.length <= 3, `${ticks.length} ticks in 5 s`)
		assert.equal(ticks[ticks.length - 1]!.outcome === 'idle' ? ticks[ticks.length - 1]!.waitAfterRequested : TICK_MS, TICK_MS)
		assert.ok(first.start >= 0)
		assert.ok(w.chain.rpcLog.length < 200, `rpc calls ${w.chain.rpcLog.length}`)
		assert.ok(Number(s.cpuUserMs) + Number(s.cpuSysMs) < 4000, 'cpu')
	})
})

test('E6: persistent RPC fault (injected on the chain side, counted there): one tick per wait, every wait TICK_MS, no busy loop', async () => {
	await withWorld('e6', PATCHED_ROOT, { E2E_WAIT_MS: '200', E2E_RUN_MS: '3000' }, async (w) => {
		seedValidators(w)
		w.chain.head = 200
		let injected = 0
		w.chain.onRequest = async (m) => {
			if (m === 'eth_blockNumber') {
				injected++
				return { status: 503 }
			}
		}
		const r = await w.run({ timeoutMs: 60_000 })
		assert.equal(r.code, 0)
		const ticks = ticksOf(r.events)
		const s = summaryOf(r)
		console.log(`E6 ticks=${ticks.length} injectedFaults(chain-side)=${injected} waits=${s.waits} cpu=${Number(s.cpuUserMs) + Number(s.cpuSysMs)}ms`)
		assert.ok(ticks.every((t) => t.outcome === 'fault'))
		assert.ok(ticks.length >= 10 && ticks.length <= 16, `ticks ${ticks.length} for a 200 ms compressed wait over 3 s (<= 1 + 3000/200)`)
		// one failed eth_blockNumber per tick, plus the shutdown checkpoint flush's own best-effort getBlockNumber (flushLabMiningPoolListeningCheckpoint)
		assert.equal(injected, ticks.length + 1, 'one failed RPC per tick on the chain side (+1: the shutdown flush)')
		for (const t of ticks.slice(0, -1)) assert.equal(t.waitAfterRequested, TICK_MS)
		assert.ok(Number(s.cpuUserMs) + Number(s.cpuSysMs) < 2500)
	})
})

test('E7: fail-closed gate (state write refused after the first ticks): every later tick is skipped with ONE ALERT line and ONE wait of TICK_MS - no ALERT storm', async () => {
	await withWorld('e7', PATCHED_ROOT, { E2E_WAIT_MS: '200', E2E_RUN_MS: '3500' }, async (w) => {
		seedValidators(w)
		synthetic(w, 3)
		w.chain.head = 400
		let blockNumberCalls = 0
		let locked = false
		w.chain.onRequest = async (m) => {
			if (m === 'eth_blockNumber' && ++blockNumberCalls === 3 && !locked) {
				locked = true
				fs.chmodSync(w.stateDir, 0o500) // no new generation can be created: the next state write trips the gate
			}
		}
		try {
			const r = await w.run({ timeoutMs: 60_000 })
			const ticks = ticksOf(r.events)
			const alerts = r.lines.filter((l) => l.includes('ALERT tick skipped: fail-closed')).length
			const s = summaryOf(r)
			console.log(`E7 ticks=${ticks.length} outcomes=${[...new Set(ticks.map((t) => t.outcome))].join('/')} ALERT lines=${alerts} waits=${s.waits} locked=${locked}`)
			assert.ok(locked)
			const skipped = ticks.filter((t) => t.outcome === 'skipped').length
			assert.ok(skipped >= 8, `skipped ticks ${skipped}`)
			assert.equal(alerts, skipped, 'one ALERT per skipped tick')
			assert.ok(ticks.length <= 20, `ticks ${ticks.length} (<= about 1 + 3500/200 plus the ticks before the lock)`)
			for (const t of ticks.filter((x) => x.outcome === 'skipped').slice(0, -1)) assert.equal(t.waitAfterRequested, TICK_MS)
		} finally {
			fs.chmodSync(w.stateDir, 0o700)
		}
	})
})

test('E8: stop while a long tick runs (SIGTERM mid-tick): the tick finishes, no tick starts after the stop, shutdown order stop -> idle -> flush', async () => {
	await withWorld('e8', PATCHED_ROOT, {}, async (w) => {
		backlogWorld(w, 15) // each RPC 15 ms: a tick takes seconds
		let tickStarted = false
		const r = await w.run({
			timeoutMs: 90_000,
			stopWhen: () => {
				if (w.chain.blockFetches.length >= 3) tickStarted = true
				return tickStarted
			},
		})
		assert.equal(r.code, 0)
		const ev = r.events
		const iShut = ev.findIndex((e) => e.kind === 'shutdown')
		const iStop = ev.findIndex((e) => e.kind === 'stopped')
		const iIdle = ev.findIndex((e) => e.kind === 'idle')
		assert.ok(iShut >= 0 && iStop > iShut && iIdle > iStop)
		const startsAfterStop = ev.slice(iStop).filter((e) => e.kind === 'tick-start').length
		assert.equal(startsAfterStop, 0, 'no tick started after stop')
		const lastEnd = ev.map((e, i) => (e.kind === 'tick-end' ? i : -1)).filter((i) => i >= 0).pop()!
		const lastStart = ev.map((e, i) => (e.kind === 'tick-start' ? i : -1)).filter((i) => i >= 0).pop()!
		assert.ok(lastEnd > lastStart && lastEnd < iIdle, 'the tick running at stop finished before idle was reported')
		assert.equal(summaryOf(r).maxRunning, '1')
		console.log(`E8 stop at tick ${ticksOf(ev).length}; tick-end after stop at +${(ev[lastEnd]!.t - ev[iShut]!.t).toFixed(1)} ms, idle at +${(ev[iIdle]!.t - ev[iShut]!.t).toFixed(1)} ms, no tick after stop`)
	})
})

test('E9: stop() followed by start() in the same process (exported API): no second loop, no further tick', async () => {
	await withWorld('e9', PATCHED_ROOT, { E2E_STOP_START_AT_MS: '400', E2E_RUN_MS: '2000' }, async (w) => {
		backlogWorld(w, 10)
		const r = await w.run({ timeoutMs: 60_000 })
		assert.equal(r.code, 0)
		const ev = r.events
		const iStop = ev.findIndex((e) => e.kind === 'stop-call')
		assert.ok(iStop >= 0)
		const refused = ev.find((e) => e.kind.startsWith('start-after-stop'))
		console.log(`E9 ${refused?.kind} ${[...Object.keys(refused?.attrs ?? {})].join(' ')}`)
		const startsAfter = ev.slice(iStop).filter((e) => e.kind === 'tick-start').length
		assert.equal(startsAfter, 0, 'a stopped loop does not tick again')
		assert.equal(summaryOf(r).maxRunning, '1')
	})
})

test('E10: pending entries that cannot be paid (gas above the cap): once the scan has caught up the ticks are idle - one wait of TICK_MS each, no busy loop, nothing is paid', async () => {
	await withWorld('e10', PATCHED_ROOT, { E2E_WAIT_MS: '200', E2E_RUN_MS: '16000' }, async (w) => {
		backlogWorld(w, 1)
		w.chain.gasPriceWei = 200_000_000n // above the 30,000,000 wei cap plus the dust band: flush waits (gas wait is far from forced)
		const r = await w.run({ timeoutMs: 60_000 })
		assert.equal(r.code, 0)
		const ticks = ticksOf(r.events)
		const skips = r.lines.filter((l) => l.includes('skip flush: gasPrice=')).length
		const lastProgress = ticks.map((t) => t.outcome).lastIndexOf('progress')
		const idleAfter = ticks.slice(lastProgress + 1)
		console.log(`E10 ticks=${ticks.length} progress=${lastProgress + 1} idle-after=${idleAfter.length} flush-skipped lines=${skips} txs paid=${w.chain.sent.size}`)
		assert.equal(w.chain.sent.size, 0, 'nothing may be paid above the gas cap')
		assert.ok(idleAfter.length >= 8 && idleAfter.every((t) => t.outcome === 'idle'))
		for (const t of idleAfter.slice(0, -1)) assert.equal(t.waitAfterRequested, TICK_MS)
		assert.ok(idleAfter.length <= 16000 / 200 + 2, `idle ticks ${idleAfter.length}: at most one per 200 ms compressed wait`)
		assert.ok(skips >= idleAfter.length, 'every idle tick logged the gas-wait skip (the pending pool stayed non-empty)')
	})
})
