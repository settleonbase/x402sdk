/**
 * P2d old-path heap evidence: the REAL production code (the df78e6b reporter, unmodified, loaded through the e2e fixture's E2E_REPORTER_ROOT) runs against a fake chain / fake signer on a synthetic
 * state of a given shape, under an exact V8 heap limit (--max-old-space-size through the child's NODE_OPTIONS: 1536 MB = heap_size_limit 1,660,944,384 B, the production value), and its memory is
 * read from V8's own GC log (--trace-gc, switched on inside the test child) plus a 25 ms heap/RSS sample tagged with the tick counter. Nothing in the reporter is patched.
 *
 *   tsx src/endpoint/p2d/oldpath.test.ts --out <dir under claudeTemp/lab-p2d> --root <df78e6b worktree> --cells 1683285:252951,2050000:500000 --heaps 1536,2048 [--ticks 4]
 *
 * One run per (cell, heap): start from the seeded state (the start IS a restart recovery: whole-state read, then the first tick) and N ticks, each tick scanning a window, paying up to 200 entries
 * in 2 batches of 100 and persisting the whole state around every step (the production flush path). A V8 out-of-memory abort (SIGABRT) is a failed cell: the production unit is Restart=no, so it
 * would stay down. Per phase (startup / each tick / the flush part of a tick) the tool reports: highest heap before a GC (MiB), highest sampled heapUsed, longest GC pause, number of Mark-Compact
 * collections, duration, RSS peak. Free space floor 30 GB; data sets deleted after every cell.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readManifest } from '../labClPayoutStateStore'
import { normalizeLine, runScenario } from '../labE2e/harness.test'
import { headPlan } from '../labE2e/scenarios.test'
import { assertFreeSpace } from './genState.test'

const MIB = 1024 * 1024
export const PROD_HEAP_LIMIT_BYTES = 1_660_944_384

const GC_RE = /(Scavenge|Mark-Compact|Mark-sweep)[^\d]*([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB, (?:pooled: [\d.]+ MB, )?([\d.]+) \/ ([\d.]+) ms/

export type Phase = { peakGcBeforeMiB: number; /** the live heap right AFTER a full (Mark-Compact) collection: the quantity V8 aborts on when it no longer fits under the limit */ peakMcAfterMiB: number; peakSampleMiB: number; maxPauseMs: number; maxMarkCompactPauseMs: number; markCompactCount: number; gcCount: number; startMs: number | null; endMs: number | null; peakRssMiB: number }
export type RunAnalysis = {
	exit: { code: number | null; signal: string | null }
	oom: boolean
	maxRssBytes: number | null
	heapLimit: number | null
	overall: Phase
	startup: Phase
	ticks: Record<string, Phase>
	flush: Phase
	tickDurationsMs: number[]
	ticksCompleted: number
	/** every full collection: time since start (ms), heap before and after (MiB), pause (ms) */
	mcEvents: { t: number; before: number; after: number; pauseMs: number }[]
}

const emptyPhase = (): Phase => ({ peakGcBeforeMiB: 0, peakMcAfterMiB: 0, peakSampleMiB: 0, maxPauseMs: 0, maxMarkCompactPauseMs: 0, markCompactCount: 0, gcCount: 0, startMs: null, endMs: null, peakRssMiB: 0 })

/** Reads the raw output lines of one child run (reporter log lines, V8 --trace-gc lines, the E2E_HEAP samples) in the order they were written. */
export function analyseRun(lines: string[], exit: { code: number | null; signal: string | null }): RunAnalysis {
	const overall = emptyPhase()
	const startup = emptyPhase()
	const flush = emptyPhase()
	const ticks: Record<string, Phase> = {}
	let current: Phase = startup
	let currentKey = 'startup'
	let started = false
	let t = 0
	let tickCounter = 0
	let inFlush = false
	let maxRssBytes: number | null = null
	let heapLimit: number | null = null
	let oom = exit.signal === 'SIGABRT'
	const mcEvents: RunAnalysis['mcEvents'] = []
	const touch = (p: Phase): void => {
		if (p.startMs === null) p.startMs = t
		p.endMs = t
	}
	const eachPhase = (f: (p: Phase) => void): void => {
		f(overall)
		f(current)
		if (inFlush) f(flush)
	}
	for (const raw of lines) {
		const line = normalizeLine(raw)
		if (/FATAL ERROR/.test(line) && /heap out of memory|Allocation failed|JavaScript heap/i.test(line)) oom = true
		const hs = /^E2E_HEAP t=(\d+) used=(\d+) rss=(\d+) ticks=(\d+)/.exec(line)
		if (hs) {
			t = Number(hs[1])
			tickCounter = Number(hs[4])
			if (started && currentKey !== `tick${tickCounter}`) {
				currentKey = `tick${tickCounter}`
				current = ticks[currentKey] ?? (ticks[currentKey] = emptyPhase())
			}
			eachPhase((p) => {
				p.peakSampleMiB = Math.max(p.peakSampleMiB, Number(hs[2]) / MIB)
				p.peakRssMiB = Math.max(p.peakRssMiB, Number(hs[3]) / MIB)
				touch(p)
			})
			continue
		}
		const mem = /^E2E_MEM maxRssBytes=(\d+) heapLimit=(\d+)/.exec(line)
		if (mem) {
			maxRssBytes = Number(mem[1])
			heapLimit = Number(mem[2])
			continue
		}
		const gcm = GC_RE.exec(line)
		if (gcm) {
			const before = Number(gcm[2])
			const after = Number(gcm[4])
			const pause = Number(gcm[6])
			const isMc = gcm[1] !== 'Scavenge'
			if (isMc) mcEvents.push({ t: Number(/(\d+) ms:/.exec(line)?.[1] ?? 0), before, after, pauseMs: pause })
			eachPhase((p) => {
				p.peakGcBeforeMiB = Math.max(p.peakGcBeforeMiB, before)
				if (isMc) p.peakMcAfterMiB = Math.max(p.peakMcAfterMiB, after)
				p.maxPauseMs = Math.max(p.maxPauseMs, pause)
				p.gcCount++
				if (isMc) {
					p.markCompactCount++
					p.maxMarkCompactPauseMs = Math.max(p.maxMarkCompactPauseMs, pause)
				}
			})
			continue
		}
		if (line.includes('starting dual-cursor+withdrawNative')) {
			started = true
			currentKey = `tick${tickCounter}`
			current = ticks[currentKey] ?? (ticks[currentKey] = emptyPhase())
		} else if (line.includes('] flush inspect=')) inFlush = true
		else if (line.includes('flush-summary')) inFlush = false
	}
	const keys = Object.keys(ticks).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
	const tickDurationsMs = keys.map((k) => (ticks[k]!.endMs ?? 0) - (ticks[k]!.startMs ?? 0))
	return { exit, oom, maxRssBytes, heapLimit, overall, startup, ticks, flush, tickDurationsMs, ticksCompleted: keys.length, mcEvents }
}

const tsxLoader = (): string[] => (process.execArgv.some((a) => a.includes('tsx')) ? process.execArgv.filter((x) => !x.startsWith('--max-old-space-size')) : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href])

async function runCell(out: string, root: string, pending: number, consumed: number, heapMB: number, ticks: number, srcV2: string): Promise<RunAnalysis> {
	let analysis!: RunAnalysis
	const manifest = readManifest(srcV2)
	const realtimeCursor = Number((manifest.scalars as Record<string, unknown>).realtimeCursor)
	await runScenario(
		{
			name: `oldpath_${pending}_${consumed}_${heapMB}`,
			// the production values the field read (defaults except CONSUMED_KEYS_MAX and DEPLOY_BLOCK), the exact heap limit through NODE_OPTIONS, V8's GC log on
			env: {
				CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNK_BLOCKS: '32',
				CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '1',
				CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_MAX_ENTRIES: '200',
				CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '100',
				CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_MAX_BATCHES: '2',
				CONET_LAB_MINING_POOL_CL_PAYOUT_REALTIME_RESERVED: '1',
				CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX: '3000000',
				CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK: '2009200',
				NODE_OPTIONS: `--max-old-space-size=${heapMB}`,
				E2E_TRACE_GC: '1',
			},
			body: async (ctx) => {
				ctx.signer.eventKeysOf = (idem) => [idem] // unique per transaction: the heavy in-flight read of the harness is not needed here
				fs.cpSync(srcV2, ctx.stateDir, { recursive: true })
				headPlan(ctx, Array.from({ length: ticks + 2 }, () => realtimeCursor + 4))
				const r = await ctx.run({ ticks, timeoutMs: 1_800_000 })
				analysis = analyseRun(r.lines, { code: r.code, signal: r.signal })
				fs.mkdirSync(path.join(out, 'raw-lines'), { recursive: true })
				fs.writeFileSync(path.join(out, 'raw-lines', `oldpath_${pending}_${consumed}_${heapMB}.log`), r.lines.join('\n') + '\n') // the child's complete output: reporter lines, V8 GC log, heap samples
			},
		},
		root
	)
	return analysis
}

async function main(): Promise<void> {
	const a = process.argv.slice(2)
	const get = (n: string, d?: string): string => {
		const i = a.indexOf(n)
		if (i < 0) {
			if (d === undefined) throw new Error(`${n} is required`)
			return d
		}
		return a[i + 1]!
	}
	const out = get('--out')
	const root = get('--root')
	if (!path.resolve(out).includes('/claudeTemp/lab-p2d')) throw new Error('p2d: the output directory must be under claudeTemp/lab-p2d')
	const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
	const cells = get('--cells').split(',').map((c) => c.split(':').map(Number) as [number, number])
	const heaps = get('--heaps', '1536,2048').split(',').map(Number)
	const ticks = Number(get('--ticks', '4'))
	fs.mkdirSync(out, { recursive: true })
	const genPath = path.join(__dirname, 'genState.test.ts')
	const results: { pending: number; consumed: number; heapMB: number; analysis: RunAnalysis }[] = []
	process.stderr.write(`oldpath: code under test ${root} @ ${head}; node ${process.version}; uptime ${execFileSync('uptime', { encoding: 'utf8' }).trim()}\n`)
	for (const [pending, consumed] of cells) {
		assertFreeSpace(out, (pending * 290 + consumed * 75) * 2.2)
		const dir = path.join(out, `cell_${pending}_${consumed}`)
		fs.rmSync(dir, { recursive: true, force: true })
		execFileSync(process.execPath, [...tsxLoader(), '--max-old-space-size=24576', genPath, '--pending', String(pending), '--consumed', String(consumed), '--form', 'v2', '--out', dir], { stdio: ['ignore', 'ignore', 'inherit'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } })
		const srcV2 = path.join(dir, 'v2', 'state.v2')
		for (const heapMB of heaps) {
			const analysis = await runCell(out, root, pending, consumed, heapMB, ticks, srcV2)
			results.push({ pending, consumed, heapMB, analysis })
			const o = analysis.overall
			process.stderr.write(`oldpath: pending ${pending} consumed ${consumed} heap ${heapMB} MB: ${analysis.oom ? `ABORTED (${analysis.exit.signal}), ticks completed ${analysis.ticksCompleted}` : `ok, ticks ${analysis.ticksCompleted}`}; peak heap before GC ${o.peakGcBeforeMiB.toFixed(0)} MiB (${((o.peakGcBeforeMiB * MIB * 100) / PROD_HEAP_LIMIT_BYTES).toFixed(0)}% of 1,660,944,384), live heap after a full GC at most ${o.peakMcAfterMiB.toFixed(0)} MiB (${((o.peakMcAfterMiB * MIB * 100) / PROD_HEAP_LIMIT_BYTES).toFixed(0)}%), RSS peak ${o.peakRssMiB.toFixed(0)} MiB, longest MC pause ${o.maxMarkCompactPauseMs.toFixed(0)} ms\n`)
		}
		fs.rmSync(dir, { recursive: true, force: true })
		const st = fs.statfsSync(out)
		process.stderr.write(`oldpath: cell done, disk free ${((Number(st.bavail) * Number(st.bsize)) / 1024 ** 3).toFixed(1)} GB\n`)
	}
	const raw = path.join(out, `results-oldpath-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
	fs.writeFileSync(raw, JSON.stringify({ node: process.version, codeUnderTest: { root, head }, ticks, heaps, results }, null, 2))
	process.stdout.write(JSON.stringify({ node: process.version, codeUnderTest: head, ticks, results: results.map((r) => ({ pending: r.pending, consumed: r.consumed, heapMB: r.heapMB, oom: r.analysis.oom, exit: r.analysis.exit, ticksCompleted: r.analysis.ticksCompleted, startup: r.analysis.startup, overall: r.analysis.overall, flush: r.analysis.flush, tickDurationsMs: r.analysis.tickDurationsMs, maxRssBytes: r.analysis.maxRssBytes, heapLimit: r.analysis.heapLimit })) }, null, 2) + '\n')
	process.stderr.write(`oldpath: raw ${raw}; uptime ${execFileSync('uptime', { encoding: 'utf8' }).trim()}\n`)
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
	main().catch((e) => {
		process.stderr.write(`oldpath: ${e instanceof Error ? e.stack : String(e)}\n`)
		process.exit(2)
	})
}

if (process.env.NODE_TEST_CONTEXT) {
	test('oldpath analyser: reads V8 GC lines, heap samples and the reporter markers into phases and finds an out-of-memory abort', () => {
		const L = [
			'[1:0x1]       10 ms: Scavenge 4.4 (5.1) -> 4.1 (6.1) MB, pooled: 0 MB, 0.29 / 0.00 ms  (average mu = 1.000, current mu = 1.000) allocation failure;',
			'[1:0x1]      900 ms: Mark-Compact 1400.5 (1500.0) -> 1000.1 (1100.0) MB, pooled: 0 MB, 410.20 / 0.00 ms  (average mu = 0.5, current mu = 0.5) allocation failure; scavenge might not succeed',
			'[labMiningPoolClPayout] starting dual-cursor+withdrawNative pubkeys=6',
			'E2E_HEAP t=100 used=1048576000 rss=1500000000 ticks=0',
			'[labMiningPoolClPayout] flush inspect=5/5 live=5',
			'[1:0x1]      950 ms: Mark-Compact 1500.0 (1600.0) -> 1100.0 (1200.0) MB, 250.00 / 0.00 ms  (average mu = 0.5, current mu = 0.5) allocation failure;',
			'[labMiningPoolClPayout] flush-summary inspect=5/5',
			'E2E_HEAP t=900 used=1200000000 rss=1600000000 ticks=1',
			'E2E_MEM maxRssBytes=1700000000 heapLimit=1660944384',
			'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
		]
		const r = analyseRun(L, { code: null, signal: 'SIGABRT' })
		assert.equal(r.oom, true)
		assert.equal(r.startup.peakGcBeforeMiB, 1400.5, 'the first Mark-Compact happened before the start marker')
		assert.equal(r.startup.maxMarkCompactPauseMs, 410.2)
		assert.equal(r.ticks.tick0!.peakGcBeforeMiB, 1500)
		assert.equal(r.flush.peakGcBeforeMiB, 1500, 'the GC between flush inspect and flush-summary belongs to the flush part')
		assert.equal(r.flush.markCompactCount, 1)
		assert.equal(r.overall.markCompactCount, 2, "two Mark-Compact lines (the Scavenge is not counted)")
		assert.equal(r.overall.peakRssMiB, 1600000000 / MIB)
		assert.equal(r.maxRssBytes, 1700000000)
		assert.equal(r.heapLimit, 1660944384)
		assert.equal(r.ticksCompleted, 2)
		assert.equal(r.overall.peakMcAfterMiB, 1100, 'the live heap after the larger full collection')
		assert.equal(r.startup.peakMcAfterMiB, 1000.1)
		assert.deepEqual(r.mcEvents.map((e) => [e.t, e.before, e.after, e.pauseMs]), [[900, 1400.5, 1000.1, 410.2], [950, 1500, 1100, 250]])
	})
}
