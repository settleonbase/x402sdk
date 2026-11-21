/**
 * Before / after throughput of the tick-loop patch on the SAME synthetic world (scaled emulation, stated in the output):
 *
 *   tsx src/endpoint/labTickE2e/throughput.test.ts --out <dir> [--runMs 72000] [--latencyMs 20] [--waitMs 600] [--blockMs 60] [--reps 1] [--every 3]
 *
 * Field facts (cycle analysis 589919fe): chain head about 600 blocks/hour, realtime line 32 blocks per tick, tick about 182 s, plus the 60 s wait = about 242 s per cycle.
 * Emulation at 1 real second = 100 field seconds: the 60 s wait becomes --waitMs 600 (the child replaces the reporter's TICK_MS timer by it), 6 s per block becomes --blockMs 60 (a head that grows by one block
 * every 60 ms of real time while the reporter works), and --latencyMs is the fake chain's per-RPC latency, set so that a patched tick takes about 1.82 s (= 182 s field). Both variants (the df78e6b baseline and the
 * patched checkout) run the same world, the same child and the same latency; reported per run: realtime blocks scanned (state cursor), blocks per field hour, tip gap at the end, ticks and their duration,
 * cycle (start to start), wait, payment batches (transactions on the fake chain) and paid keys checked once each with the right wei. Nothing is patched in the reporter.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSegmentedState } from '../labClPayoutStateStore'
import { BASELINE_ROOT, DEPLOY_BLOCK, PATCHED_ROOT, checkPayments, quantiles, seedValidators, strip, synthetic, ticksOf, ticksOfBaseline, withWorld, parseEvents } from './harness.test'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let FIELD_FACTOR = 100 // 1 real second = FIELD_FACTOR field seconds (1 for a real-time run)

export type VariantResult = {
	variant: 'baseline-df78e6b' | 'patched'
	root: string
	rep: number
	runMs: number
	latencyMs: number
	waitMs: number | 'real'
	blockMs: number
	freezeHeight: number
	realtimeCursorEnd: number
	headEnd: number
	realtimeBlocksScanned: number
	blocksPerFieldHour: number
	tipGapEnd: number
	chainHeadBlocksPerFieldHour: number
	ticks: number
	tickMs: ReturnType<typeof quantiles>
	cycleMs: ReturnType<typeof quantiles>
	waitMsObserved: ReturnType<typeof quantiles>
	maxRunning: number | 'n/a (baseline has no loop to observe)'
	txs: number
	paidKeys: number
	txsPerFieldHour: number
	historyCursorEnd: number
	/** Whole-state persistence seen from the child (fs.writeSync / fsyncSync / rename of manifest.json): real writes into the state dir. Absent in runs made before the counters existed. */
	io?: { writeBytes: number; writeCalls: number; writeMs: number; fsyncCalls: number; fsyncMs: number; manifestCommits: number; manifestCommitsPerTick: number; bytesPerCommit: number; stateBytesEnd: number }
}

export async function measure(variant: VariantResult['variant'], root: string, rep: number, o: { runMs: number; latencyMs: number; waitMs: number | 'real'; blockMs: number; every: number; outDir?: string; tickMs?: number }): Promise<VariantResult> {
	return withWorld(`tp-${variant}`, root, { E2E_WAIT_MS: String(o.waitMs), E2E_RUN_MS: String(o.runMs), ...(o.tickMs ? { CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS: String(o.tickMs) } : {}) }, async (w) => {
		seedValidators(w)
		const syn = synthetic(w, o.every)
		w.chain.head = DEPLOY_BLOCK + 4900 // 4 900 history blocks of backlog: the history line never finishes inside the run, the realtime line follows the growing head
		const head0 = w.chain.head
		w.chain.onRequest = async () => void (await sleep(o.latencyMs))
		w.chain.startAutoHead(o.blockMs)
		const r = await w.run({ timeoutMs: o.runMs + 120_000 })
		assert.equal(r.code, 0)
		const st = readSegmentedState(w.stateDir) as { freezeH?: { height: number }; realtimeCursor?: number; historyCursor?: number }
		const freeze = st.freezeH?.height ?? head0
		const rtEnd = st.realtimeCursor ?? freeze
		const headEnd = w.chain.head
		const expected = syn.expectedKeys(DEPLOY_BLOCK, headEnd + 100)
		const { paidKeys, txs } = checkPayments(w.chain.sent.values(), expected)
		const ticks = variant === 'patched' ? ticksOf(r.events) : ticksOfBaseline(r.events)
		const cycles: number[] = []
		for (let i = 1; i < ticks.length; i++) cycles.push(ticks[i]!.start - ticks[i - 1]!.start)
		const waits = r.events.filter((e) => e.kind === 'wait-set').map((e) => Number(e.attrs.used))
		const fieldHours = (o.runMs / 1000) * FIELD_FACTOR / 3600
		const sum = r.events.find((e) => e.kind === 'summary')?.attrs ?? {}
		if (o.outDir) {
			fs.mkdirSync(path.join(o.outDir, 'raw-lines'), { recursive: true })
			fs.writeFileSync(path.join(o.outDir, 'raw-lines', `${variant}_rep${rep}.log`), r.lines.map(strip).join('\n') + '\n')
		}
		return {
			variant,
			root,
			rep,
			runMs: o.runMs,
			latencyMs: o.latencyMs,
			waitMs: o.waitMs,
			blockMs: o.blockMs,
			freezeHeight: freeze,
			realtimeCursorEnd: rtEnd,
			headEnd,
			realtimeBlocksScanned: rtEnd - freeze,
			blocksPerFieldHour: (rtEnd - freeze) / fieldHours,
			tipGapEnd: headEnd - rtEnd,
			chainHeadBlocksPerFieldHour: (headEnd - head0) / fieldHours,
			ticks: ticks.length,
			tickMs: quantiles(ticks.map((t) => t.end - t.start)),
			cycleMs: quantiles(cycles),
			waitMsObserved: quantiles(waits),
			maxRunning: variant === 'patched' ? Number(sum.maxRunning) : 'n/a (baseline has no loop to observe)',
			txs,
			paidKeys: paidKeys.size,
			txsPerFieldHour: txs / fieldHours,
			historyCursorEnd: st.historyCursor ?? 0,
			...(sum.manifestCommits !== undefined
				? {
						io: {
							writeBytes: Number(sum.fsWriteBytes),
							writeCalls: Number(sum.fsWriteCalls),
							writeMs: Number(sum.fsWriteMs),
							fsyncCalls: Number(sum.fsyncCalls),
							fsyncMs: Number(sum.fsyncMs),
							manifestCommits: Number(sum.manifestCommits),
							manifestCommitsPerTick: Number(sum.manifestCommits) / Math.max(1, ticks.length),
							bytesPerCommit: Number(sum.fsWriteBytes) / Math.max(1, Number(sum.manifestCommits)),
							stateBytesEnd: dirBytes(w.stateDir),
						},
					}
				: {}),
		}
	})
}

function dirBytes(dir: string): number {
	let n = 0
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name)
		n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size
	}
	return n
}
const f = (x: number, d = 0): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a')
export function table(rs: VariantResult[]): string {
	const rows = [['variant', 'rep', 'ticks', 'tick p50/p90 ms', 'cycle p50/p90 ms', 'wait ms', 'rt blocks', 'blocks/field-h', 'chain head/field-h', 'tip gap end', 'txs', 'txs/field-h', 'paid keys', 'maxRunning', 'commits/tick', 'bytes/commit', 'write+fsync ms/tick']]
	for (const r of rs) rows.push([r.variant, String(r.rep), String(r.ticks), `${f(r.tickMs.p50)}/${f(r.tickMs.p90)}`, `${f(r.cycleMs.p50)}/${f(r.cycleMs.p90)}`, f(r.waitMsObserved.p50), String(r.realtimeBlocksScanned), f(r.blocksPerFieldHour), f(r.chainHeadBlocksPerFieldHour), String(r.tipGapEnd), String(r.txs), f(r.txsPerFieldHour, 1), String(r.paidKeys), String(r.maxRunning), r.io ? f(r.io.manifestCommitsPerTick, 1) : 'n/a', r.io ? f(r.io.bytesPerCommit) : 'n/a', r.io ? f((r.io.writeMs + r.io.fsyncMs) / Math.max(1, r.ticks), 1) : 'n/a'])
	const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
	return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')).join('\n')
}

async function cli(): Promise<void> {
	const a = process.argv.slice(2)
	const arg = (n: string, d?: string): string => {
		const i = a.indexOf(`--${n}`)
		if (i >= 0) return a[i + 1]!
		if (d === undefined) throw new Error(`--${n} required`)
		return d
	}
	const out = arg('out')
	FIELD_FACTOR = Number(arg('fieldFactor', '100'))
	const waitArg = arg('waitMs', '600')
	const o = { runMs: Number(arg('runMs', '72000')), latencyMs: Number(arg('latencyMs', '20')), waitMs: (waitArg === 'real' ? 'real' : Number(waitArg)) as number | 'real', tickMs: a.includes('--tickMs') ? Number(arg('tickMs')) : undefined, blockMs: Number(arg('blockMs', '60')), every: Number(arg('every', '3')), outDir: out }
	const reps = Number(arg('reps', '1'))
	fs.mkdirSync(out, { recursive: true })
	const results: VariantResult[] = []
	for (let rep = 1; rep <= reps; rep++) {
		// alternate the order per repetition so a drifting machine load does not favour one variant
		const order: [VariantResult['variant'], string][] = rep % 2 ? [['baseline-df78e6b', BASELINE_ROOT], ['patched', PATCHED_ROOT]] : [['patched', PATCHED_ROOT], ['baseline-df78e6b', BASELINE_ROOT]]
		const one = async ([v, root]: [VariantResult['variant'], string]): Promise<VariantResult> => {
			console.log(`[throughput] rep ${rep} ${v} start ${new Date().toISOString()} load=${(await import('node:os')).loadavg().map((x) => x.toFixed(2)).join('/')}`)
			return measure(v, root, rep, o)
		}
		// --parallel: both variants run at the same time on separate worlds (the same wall-clock window, so a drifting machine load hits both alike)
		if (a.includes('--parallel')) results.push(...(await Promise.all(order.map(one))))
		else for (const x of order) results.push(await one(x))
	}
	fs.writeFileSync(path.join(out, 'throughput.json'), JSON.stringify({ params: o, fieldFactor: FIELD_FACTOR, parallel: a.includes('--parallel'), startedAtUtc: new Date().toISOString(), results }, null, 2) + '\n')
	const t = table(results)
	fs.writeFileSync(path.join(out, 'throughput.txt'), t + '\n')
	console.log(t)
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
	void cli().catch((e) => {
		console.error(e)
		process.exit(1)
	})
}

if (process.env.NODE_TEST_CONTEXT) {
	test('throughput tool: baseline ticks are derived from start / wait-fired and wait-set events; quantiles', () => {
		const evs = parseEvents(['E2E_EV start t=0.000', 'E2E_EV wait-set requested=15000 used=600 t=1800.000', 'E2E_EV wait-fired t=2400.000', 'E2E_EV wait-set requested=15000 used=600 t=4200.000'])
		const ticks = ticksOfBaseline(evs)
		assert.deepEqual(ticks.map((t) => [t.start, t.end]), [[0, 1800], [2400, 4200]])
		const q = quantiles([1, 2, 3, 4, 5])
		assert.equal(q.p50, 3)
		assert.equal(q.max, 5)
	})
}
