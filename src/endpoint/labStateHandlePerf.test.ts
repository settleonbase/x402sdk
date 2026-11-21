/**
 * P2c-1 acceptance (errata C2): the per-tick reads the reporter makes over the pending pool cost the same through the state handle as directly on the Map the reporter used before.
 * Opt-in (LAB_PERF=1, run with NODE_OPTIONS=--expose-gc): it builds 1.66 million SkimEntry objects and takes a while. LAB_PERF_N overrides the size.
 * Thresholds: time <= +10%, heap <= +5% (medians of 5 alternating runs per operation).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countHistoryAhead, planInvariantCFlush } from './labInvariantC'
import { classifyPendingLine } from './labMiningPoolDualCursor'
import { selectFlushCandidates } from './labFlushSelect'
import { LegacyStateHandle } from './labStateHandle'

const N = Number(process.env.LAB_PERF_N ?? 1_660_000)
type E = { eventKey: string; amount: bigint; blockNumber: number; withdrawalIndex: number; pubkey: string }
const median = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!

test(`C2: the four per-tick pool reads over ${N} entries cost the same through the handle as directly on the Map (time <= +10%, heap <= +5%)`, { skip: process.env.LAB_PERF === '1' ? false : 'set LAB_PERF=1 (and NODE_OPTIONS=--expose-gc) to run the 1.66M-entry comparison', timeout: 900_000 }, () => {
	const gc = (globalThis as { gc?: () => void }).gc
	const pending = new Map<string, E>()
	const FREEZE = 2_100_000
	for (let i = 0; i < N; i++) {
		const eventKey = `0x${i.toString(16).padStart(64, '0')}`
		pending.set(eventKey, { eventKey, amount: 1_000_000_000_000n + BigInt(i % 97), blockNumber: 2_000_000 + Math.floor(i / 13), withdrawalIndex: i % 13, pubkey: '0x' + 'ab'.repeat(48) })
	}
	const h = new LegacyStateHandle<E, { freezeH: unknown }>({ state: { consumedEventKeys: {}, exitedPubkeys: {} } as never, pending, persist: () => undefined })
	const direct = (): Iterable<E> => pending.values()
	const viaHandle = (): Iterable<E> => h.pendingValues()
	const ops: Record<string, (it: Iterable<E>) => unknown> = {
		selectFlushCandidates: (it) => selectFlushCandidates(it, { freezeH: FREEZE, flushMax: 200, realtimeQuota: 100, historyFloor: 100, historyMaxBlock: 2_050_000 }),
		// initDone false: the start-up pass is the one that walks the pool
		planInvariantCFlush: (it) => planInvariantCFlush({ flagOn: true, freezeH: FREEZE, committedHistoryCursor: 2_050_000, maxPaidHistoryBlock: undefined, initDone: false, pending: it }),
		countHistoryAhead: (it) => countHistoryAhead(it, FREEZE, 2_050_000),
		oldestRealtimePendingBlock: (it) => [...it].filter((e) => classifyPendingLine(e.blockNumber, FREEZE) === 'realtime').reduce<number | null>((m, e) => (m == null ? e.blockNumber : Math.min(m, e.blockNumber)), null),
	}
	const rows: string[] = []
	for (const [name, op] of Object.entries(ops)) {
		const tA: number[] = []
		const tB: number[] = []
		const hA: number[] = []
		const hB: number[] = []
		let rA: unknown
		let rB: unknown
		for (let rep = 0; rep < 5; rep++) {
			for (const which of rep % 2 === 0 ? ['A', 'B'] : ['B', 'A']) {
				gc?.()
				const base = process.memoryUsage().heapUsed
				const t0 = process.hrtime.bigint()
				const r = op(which === 'A' ? direct() : viaHandle())
				const dt = Number(process.hrtime.bigint() - t0) / 1e6
				const heap = process.memoryUsage().heapUsed - base
				if (which === 'A') {
					tA.push(dt)
					hA.push(heap)
					rA = r
				} else {
					tB.push(dt)
					hB.push(heap)
					rB = r
				}
			}
		}
		assert.deepEqual(JSON.parse(JSON.stringify(rB, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))), JSON.parse(JSON.stringify(rA, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))), `${name}: same result`)
		const ta = median(tA)
		const tb = median(tB)
		const ha = median(hA)
		const hb = median(hB)
		rows.push(`${name}: time direct ${ta.toFixed(1)} ms, handle ${tb.toFixed(1)} ms (${(((tb - ta) / ta) * 100).toFixed(1)}%); heap delta direct ${(ha / 1e6).toFixed(1)} MB, handle ${(hb / 1e6).toFixed(1)} MB`)
		assert.ok(tb <= ta * 1.1 + 2, `${name}: time through the handle ${tb.toFixed(1)} ms vs direct ${ta.toFixed(1)} ms exceeds +10%`)
		assert.ok(hb <= ha * 1.05 + 5_000_000, `${name}: heap through the handle ${(hb / 1e6).toFixed(1)} MB vs direct ${(ha / 1e6).toFixed(1)} MB exceeds +5%`)
	}
	console.log('# C2 ' + rows.join('\n# C2 '))
})
