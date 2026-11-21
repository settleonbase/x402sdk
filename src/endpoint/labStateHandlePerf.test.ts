/**
 * P2c-1 acceptance (errata C2): the per-tick reads the reporter makes over the pending pool cost the same through the state handle as directly on the Map the reporter used before.
 * Opt-in (LAB_PERF=1, run with NODE_OPTIONS=--expose-gc): it builds 1.66 million SkimEntry objects and takes a while. LAB_PERF_N overrides the size.
 * Thresholds: time <= +10% + 3 ms, heap <= +5% (+5 MB). Time compares the MINIMUM of 15 alternating runs per side (after a warm-up run of each side): the minimum is the run least disturbed by GC and
 * the machine, which is the robust statistic here. The first version compared medians of 5 with a bare +10% line, and the reviewer measured +6.4% and +18.0% on the same direct-Map-vs-pass-through
 * pair (pure noise, the legacy handle is a pass-through), so that line was below the noise and could not be a release gate. Heap compares medians (its noise is small).
 * P2c-2 adds the WAL handle (a LabPayoutStateCore over the same entry objects): the same four reads through WalStateHandle, plus the same reads while a snapshot is in flight (informational: layered
 * views over a 3% delta; no threshold, the numbers go in the receipt) and the O(1) size counters.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countHistoryAhead, planInvariantCFlush } from './labInvariantC'
import { classifyPendingLine } from './labMiningPoolDualCursor'
import { selectFlushCandidates } from './labFlushSelect'
import { LegacyStateHandle } from './labStateHandle'
import { LabPayoutStateCore, type PendingEntry } from './labPayoutStateCore'
import { WalStateHandle } from './labWalStateHandle'

const N = Number(process.env.LAB_PERF_N ?? 1_660_000)
type E = { eventKey: string; amount: bigint; blockNumber: number; withdrawalIndex: number; pubkey: string }
const median = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!

test(`C2: the four per-tick pool reads over ${N} entries cost the same through the legacy handle and through the WAL handle as directly on the Map (time <= +10%, heap <= +5%)`, { skip: process.env.LAB_PERF === '1' ? false : 'set LAB_PERF=1 (and NODE_OPTIONS=--expose-gc) to run the 1.66M-entry comparison', timeout: 900_000 }, () => {
	const gc = (globalThis as { gc?: () => void }).gc
	const pending = new Map<string, E>()
	const FREEZE = 2_100_000
	for (let i = 0; i < N; i++) {
		const eventKey = `0x${i.toString(16).padStart(64, '0')}`
		pending.set(eventKey, { eventKey, amount: 1_000_000_000_000n + BigInt(i % 97), blockNumber: 2_000_000 + Math.floor(i / 13), withdrawalIndex: i % 13, pubkey: '0x' + 'ab'.repeat(48) })
	}
	const hLegacy = new LegacyStateHandle<E, { freezeH: unknown }>({ state: { consumedEventKeys: {}, exitedPubkeys: {} } as never, pending, persist: () => undefined })
	// the WAL core is built over the SAME entry objects (the core freezes them once; both sides then read identical frozen objects)
	const core = new LabPayoutStateCore({ pending: [...pending.values()] as unknown as PendingEntry[] })
	const hWal = new WalStateHandle<E, { freezeH: unknown }>({ core, wal: { append: () => { throw new Error('reads only') } } as never })
	const direct = (): Iterable<E> => pending.values()
	const handleKind = process.env.LAB_PERF_HANDLE ?? 'legacy'
	const viaHandle = (): Iterable<E> => (handleKind === 'wal' ? hWal.pendingValues() : hLegacy.pendingValues())
	const ops: Record<string, (it: Iterable<E>) => unknown> = {
		selectFlushCandidates: (it) => selectFlushCandidates(it, { freezeH: FREEZE, flushMax: 200, realtimeQuota: 100, historyFloor: 100, historyMaxBlock: 2_050_000 }),
		// initDone false: the start-up pass is the one that walks the pool
		planInvariantCFlush: (it) => planInvariantCFlush({ flagOn: true, freezeH: FREEZE, committedHistoryCursor: 2_050_000, maxPaidHistoryBlock: undefined, initDone: false, pending: it }),
		countHistoryAhead: (it) => countHistoryAhead(it, FREEZE, 2_050_000),
		oldestRealtimePendingBlock: (it) => [...it].filter((e) => classifyPendingLine(e.blockNumber, FREEZE) === 'realtime').reduce<number | null>((m, e) => (m == null ? e.blockNumber : Math.min(m, e.blockNumber)), null),
	}
	const rows: string[] = []
	const fails: string[] = []
	for (const [name, op] of Object.entries(ops)) {
		const tA: number[] = []
		const tB: number[] = []
		const hA: number[] = []
		const hB: number[] = []
		let rA: unknown
		let rB: unknown
		op(direct())
		op(viaHandle())
		for (let rep = 0; rep < 15; rep++) {
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
		const ta = Math.min(...tA)
		const tb = Math.min(...tB)
		const ha = median(hA)
		const hb = median(hB)
		rows.push(`${name}: time (min of 15) direct ${ta.toFixed(1)} ms, handle ${tb.toFixed(1)} ms (${(((tb - ta) / ta) * 100).toFixed(1)}%), medians ${median(tA).toFixed(1)} / ${median(tB).toFixed(1)} ms; heap delta direct ${(ha / 1e6).toFixed(1)} MB, handle ${(hb / 1e6).toFixed(1)} MB`)
		if (!(tb <= ta * 1.1 + 3)) fails.push(`${name}: time (min of 15) through the handle ${tb.toFixed(1)} ms vs direct ${ta.toFixed(1)} ms exceeds +10% + 3 ms`)
		if (!(hb <= ha * 1.05 + 5_000_000)) fails.push(`${name}: heap through the handle ${(hb / 1e6).toFixed(1)} MB vs direct ${(ha / 1e6).toFixed(1)} MB exceeds +5%`)
	}
	console.log(`# C2 (${handleKind} handle, N=${N}) ` + rows.join(`\n# C2 (${handleKind}) `))
	assert.deepEqual(fails, [])
})

test(`C2 (informational): the WAL handle's reads over ${N} entries while a snapshot is in flight (layered views over a ~3% delta), and the size counters`, { skip: process.env.LAB_PERF === '1' ? false : 'set LAB_PERF=1 (and NODE_OPTIONS=--expose-gc)', timeout: 900_000 }, () => {
	const gc = (globalThis as { gc?: () => void }).gc
	const entries: E[] = []
	for (let i = 0; i < N; i++) {
		const eventKey = `0x${i.toString(16).padStart(64, '0')}`
		entries.push({ eventKey, amount: 1_000_000_000_000n + BigInt(i % 97), blockNumber: 2_000_000 + Math.floor(i / 13), withdrawalIndex: i % 13, pubkey: '0x' + 'ab'.repeat(48) })
	}
	const core = new LabPayoutStateCore({ pending: entries as unknown as PendingEntry[] })
	const h = new WalStateHandle<E, { freezeH: unknown }>({ core, wal: { append: () => { throw new Error('reads only') } } as never })
	const FREEZE = 2_100_000
	const run = (): number => {
		const it = h.pendingValues()
		let n = 0
		for (const e of it) if (classifyPendingLine(e.blockNumber as number, FREEZE) === 'history') n++
		return n
	}
	const time = (f: () => unknown): number => {
		gc?.()
		const t0 = process.hrtime.bigint()
		f()
		return Number(process.hrtime.bigint() - t0) / 1e6
	}
	run()
	const quiet = median([0, 1, 2, 3, 4].map(() => time(run)))
	const src = core.freezeForSnapshot()
	const delta = Math.floor(N * 0.03)
	for (let i = 0; i < delta; i++) core.pendingDelete(entries[i * 5]!.eventKey)
	for (let i = 0; i < delta; i++) core.pendingSet({ ...entries[i]!, eventKey: `0x${(N + i).toString(16).padStart(64, '0')}` } as never)
	run()
	const inFlight = median([0, 1, 2, 3, 4].map(() => time(run)))
	const sizeNs = median([0, 1, 2, 3, 4].map(() => time(() => { for (let i = 0; i < 1000; i++) void (h.pendingSize + h.consumedSize) }))) / 1000 * 1e6
	core.finishSnapshot(src, { committed: false })
	console.log(`# C2 (wal, snapshot) N=${N}: full pool walk quiet ${quiet.toFixed(1)} ms, with a snapshot in flight and a ${delta}+${delta} delta ${inFlight.toFixed(1)} ms (${(((inFlight - quiet) / quiet) * 100).toFixed(1)}%); pendingSize+consumedSize ${sizeNs.toFixed(0)} ns per call`)
})
