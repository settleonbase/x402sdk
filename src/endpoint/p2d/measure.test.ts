/**
 * P2d measurement tool (test-only; *.test.ts keeps it out of the build; not in the lab*.test.ts suite glob). Every measurement runs in its OWN child process so peaks do not leak between runs.
 *
 *   tsx --expose-gc --max-old-space-size=16384 src/endpoint/p2d/measure.test.ts tier --tier A|P0|B2 --out <dir under claudeTemp/lab-p2d> [--repeats 5] [--tail 100000] [--heapfloor] [--keep]
 *   (m0 = tier A)
 *
 * Child modes (internal, `--child <mode> --dir <state dir>`):
 *   recover-wal    recoverPayoutState on a version 3 / WAL directory (read-only), as the daemon's recovery does
 *   read-legacy    the legacy whole-state read (readStateFromDisk + the per-tick pending map the old path builds)
 *   snapshot       recover, then one cooperative snapshot into a scratch COPY of the directory
 *   heap-limit     print v8.getHeapStatistics().heap_size_limit (the default old-space limit of this Node on this host, or the one given by --max-old-space-size)
 * Each child prints one JSON line: wall times, process.resourceUsage().maxRSS (the OS high-water mark: exact, it does not depend on a sampling interval), heap before and after a forced GC, GC pause
 * statistics (PerformanceObserver 'gc'), event-loop delay (snapshot). The parent adds an external RSS profile (ps every 25 ms) as a cross-check, because a blocked child cannot sample itself.
 * No network, no WebSocket, no real state: the data is synthetic (genState.test.ts).
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLegacyStateStore } from '../labLegacyState'
import { recoverPayoutState } from '../labPayoutRecovery'
import { writeSnapshotCooperative } from '../labSnapshotWriter'
import { assertFreeSpace, FREE_SPACE_FLOOR_BYTES, generate, TIERS } from './genState.test'

const MB = 1024 * 1024
const gc = (globalThis as { gc?: () => void }).gc

type ChildReport = {
	mode: string
	dir: string
	node: string
	execArgv: string[]
	phases: Record<string, number>
	maxRssBytes: number
	rssNowBytes: number
	heapUsedBeforeGcBytes: number
	heapUsedAfterGcBytes: number
	rssAfterGcBytes: number
	/** RSS right after the work, BEFORE any forced GC (what a plain measurement of the process shows; the OS does not give freed pages back at once) */
	rssBeforeGcBytes: number
	gc: { count: number; maxPauseMs: number; totalPauseMs: number }
	counts: Record<string, number>
	extra?: Record<string, unknown>
}

function gcObserver(): { stop: () => Promise<{ count: number; maxPauseMs: number; totalPauseMs: number }> } {
	// entries are collected IN the callback (a callback that does nothing drains the queue, so a later takeRecords() is always empty: the first two M0 runs read 0 pauses for that reason)
	const recs: { duration: number }[] = []
	const obs = new PerformanceObserver((list) => void recs.push(...list.getEntries()))
	obs.observe({ entryTypes: ['gc'] })
	return {
		stop: async () => {
			// delivery to the callback is asynchronous: after purely synchronous work it only happens once the event loop has turned
			for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
			obs.disconnect()
			return { count: recs.length, maxPauseMs: recs.reduce((m, r) => Math.max(m, r.duration), 0), totalPauseMs: recs.reduce((a, r) => a + r.duration, 0) }
		},
	}
}

async function childMain(mode: string, dir: string): Promise<void> {
	const go = gcObserver()
	const phases: Record<string, number> = {}
	const counts: Record<string, number> = {}
	let extra: Record<string, unknown> | undefined
	const t0 = process.hrtime.bigint()
	const lap = (name: string, from: bigint): void => void (phases[name] = Number(process.hrtime.bigint() - from) / 1e6)
	let hold: unknown
	if (mode === 'recover-wal') {
		const t = process.hrtime.bigint()
		const rec = recoverPayoutState(dir, { readOnly: true })
		lap('recoverMs', t)
		counts.pending = rec.core.pendingSize
		counts.consumed = rec.core.consumedSize
		counts.exited = rec.core.exitedSize
		counts.replayed = rec.replayed
		hold = rec
	} else if (mode === 'read-legacy') {
		const store = createLegacyStateStore({ stateFile: () => path.join(dir, '..', 'x.json'), segmentedDir: () => dir, consumedCap: () => 1e9, scanFloor: () => 0, tripPersist: () => undefined, logger: () => undefined })
		const t = process.hrtime.bigint()
		const state = store.readStateFromDisk()
		lap('readStateMs', t)
		// the OS high-water mark and the RSS right after the whole-state READ alone, before the per-tick pending map is built (what a plain "read the old state" measurement sees)
		counts.maxRssAfterReadStateKb = process.resourceUsage().maxRSS
		counts.rssAfterReadStateKb = Math.round(process.memoryUsage().rss / 1024)
		const t2 = process.hrtime.bigint()
		const h = store.newHandle(state)
		lap('pendingMapMs', t2)
		counts.pending = h.pendingSize
		counts.consumed = Object.keys(state.consumedEventKeys).length
		hold = { state, h }
	} else if (mode === 'snapshot') {
		const scratch = fs.mkdtempSync(path.join(path.dirname(path.dirname(dir)), 'snapscratch-'))
		fs.cpSync(dir, path.join(scratch, 'state.v2'), { recursive: true })
		const sdir = path.join(scratch, 'state.v2')
		const tR = process.hrtime.bigint()
		const rec = recoverPayoutState(sdir, { readOnly: true })
		lap('recoverMs', tR)
		gc?.()
		const rssBefore = process.memoryUsage().rss
		const eld = monitorEventLoopDelay({ resolution: 1 })
		eld.enable()
		const tS = process.hrtime.bigint()
		const src = rec.core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: sdir, mode: 'wal' })
		rec.core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
		lap('snapshotMs', tS)
		eld.disable()
		counts.pending = rec.core.pendingSize
		counts.consumed = rec.core.consumedSize
		extra = { slices: res.stats.slices, maxSliceMs: res.stats.maxSliceMs, bytesWritten: res.stats.bytes, eventLoopDelayMs: { p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 }, rssBeforeSnapshotBytes: rssBefore }
		hold = rec
		fs.rmSync(scratch, { recursive: true, force: true })
	} else if (mode === 'heap-limit') {
		const hs = (await import('node:v8')).getHeapStatistics()
		counts.heapSizeLimitBytes = hs.heap_size_limit
		counts.totalAvailableBytes = hs.total_available_size
	} else throw new Error(`unknown child mode ${mode}`)
	lap('totalMs', t0)
	const memBefore = process.memoryUsage()
	const heapBefore = memBefore.heapUsed
	const maxRssKb = process.resourceUsage().maxRSS
	const gcStats = await go.stop() // the workload's own collections only (before the forced ones below)
	gc?.()
	gc?.()
	const mem = process.memoryUsage()
	void hold
	const report: ChildReport = {
		mode,
		dir,
		node: process.version,
		execArgv: process.execArgv.filter((a) => !a.includes('loader')),
		phases,
		maxRssBytes: maxRssKb * 1024,
		rssNowBytes: mem.rss,
		heapUsedBeforeGcBytes: heapBefore,
		heapUsedAfterGcBytes: mem.heapUsed,
		rssAfterGcBytes: mem.rss,
		rssBeforeGcBytes: memBefore.rss,
		gc: gcStats,
		counts,
		extra,
	}
	process.stdout.write(`P2D_REPORT ${JSON.stringify(report)}\n`)
}

// ---------------------------------------------------------------------------------------------- parent side
type ChildRun = { ok: true; report: ChildReport; psPeakBytes: number; timeMaxRssBytes: number; peakFootprintBytes: number; releasePeakBytes: number; wallMs: number } | { ok: false; code: number | null; signal: string | null; stderrTail: string; wallMs: number }

/**
 * One measured child. Run under `/usr/bin/time -l` (maximum resident set size and peak memory footprint, in bytes on macOS) and sampled externally every 20 ms; the child also reports its own OS high-water mark.
 * The number used for a release decision is the LARGEST of the three (the reviewer's rule: a sample can miss a short peak). `allowFail` returns a failure (e.g. a V8 out-of-memory abort) instead of throwing.
 */
function runChild(mode: string, dir: string, extraNodeArgs: string[] = [], allowFail = false): Promise<ChildRun> {
	if (process.env.P2D_CHILD) throw new Error('p2d: a measurement child must not start children of its own')
	const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
	// the parent may run with a big heap only to GENERATE data; a measured child gets exactly the flags passed in extraNodeArgs (default: Node's own default old-space limit), and its flags are recorded in its report
	const nodeArgs = [...loader.filter((a) => !a.startsWith('--expose-gc') && !a.startsWith('--max-old-space-size')), '--expose-gc', ...extraNodeArgs, __filename, '--child', mode, '--dir', dir]
	const t0 = Date.now()
	return new Promise((resolve, reject) => {
		const child = spawn('/usr/bin/time', ['-l', process.execPath, ...nodeArgs], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), P2D_CHILD: '1' } })
		let out = ''
		let err = ''
		let peak = 0
		let target = 0
		child.stdout.on('data', (d: Buffer) => void (out += d.toString('utf8')))
		child.stderr.on('data', (d: Buffer) => void (err += d.toString('utf8')))
		const timer = setInterval(() => {
			try {
				if (!target) target = Number(execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n')[0])
				const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(target)], { encoding: 'utf8' }).trim())
				if (Number.isFinite(kb)) peak = Math.max(peak, kb * 1024)
			} catch {
				/* not started yet, or already exited */
			}
		}, 20)
		child.on('exit', (code, signal) => {
			clearInterval(timer)
			const wallMs = Date.now() - t0
			const line = out.split('\n').find((l) => l.startsWith('P2D_REPORT '))
			const m1 = /(\d+)\s+maximum resident set size/.exec(err)
			const m2 = /(\d+)\s+peak memory footprint/.exec(err)
			if (code !== 0 || !line) {
				const fail: ChildRun = { ok: false, code, signal, stderrTail: err.slice(-600), wallMs }
				return allowFail ? resolve(fail) : reject(new Error(`child ${mode} exited ${code}/${signal}: ${err.slice(-500)} ${out.slice(-300)}`))
			}
			const report = JSON.parse(line.slice('P2D_REPORT '.length)) as ChildReport
			const timeMax = m1 ? Number(m1[1]) : 0
			const footprint = m2 ? Number(m2[1]) : 0
			resolve({ ok: true, report, psPeakBytes: peak, timeMaxRssBytes: timeMax, peakFootprintBytes: footprint, releasePeakBytes: Math.max(peak, timeMax, report.maxRssBytes), wallMs })
		})
	})
}
const okRun = (r: ChildRun): Extract<ChildRun, { ok: true }> => {
	if (!r.ok) throw new Error(`child failed: ${r.code}/${r.signal} ${r.stderrTail}`)
	return r
}

const med = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!
const gb = (b: number): string => (b / 1024 ** 3).toFixed(3)

function dfFreeBytes(dir: string): number {
	const st = fs.statfsSync(dir)
	return Number(st.bavail) * Number(st.bsize)
}

async function tierRun(tier: string, out: string, repeats: number, keep: boolean, tail: number, heapFloor: boolean): Promise<void> {
	if (!path.resolve(out).includes('/claudeTemp/lab-p2d')) throw new Error('p2d: the output directory must be under claudeTemp/lab-p2d')
	const t = TIERS[tier]
	if (!t) throw new Error(`unknown tier ${tier}`)
	fs.mkdirSync(out, { recursive: true })
	const forms = tier === 'B2' || tier === 'P0' ? ['v2', 'wal', 'walTail'] : ['v2', 'wal']
	const freeBefore = dfFreeBytes(out)
	process.stderr.write(`${tier}: disk free before: ${gb(freeBefore)} GB (floor ${gb(FREE_SPACE_FLOOR_BYTES)} GB)\n`)
	const tGen = Date.now()
	const g = await generate({ tier, forms, out, seed: 1, tail })
	process.stderr.write(`${tier}: generated (${t.pending} pending, ${t.consumed} consumed, forms ${forms.join('/')}) in ${((Date.now() - tGen) / 1000).toFixed(1)} s; free ${gb(dfFreeBytes(out))} GB\n`)
	const du = (d: string): number => Number(execFileSync('du', ['-sk', d], { encoding: 'utf8' }).split('\t')[0]) * 1024
	const sizes: Record<string, number> = {}
	for (const f of forms) sizes[f] = du(path.join(out, f))
	const runs: Record<string, Extract<ChildRun, { ok: true }>[]> = { 'recover-wal': [], 'read-legacy': [], snapshot: [], 'recover-walTail': [] }
	for (let i = 0; i < repeats; i++) {
		runs['recover-wal']!.push(okRun(await runChild('recover-wal', g.dirs.wal!)))
		runs['read-legacy']!.push(okRun(await runChild('read-legacy', g.dirs.v2!)))
		if (g.dirs.walTail) runs['recover-walTail']!.push(okRun(await runChild('recover-wal', g.dirs.walTail!)))
		if (i < 3) runs.snapshot!.push(okRun(await runChild('snapshot', g.dirs.wal!)))
		process.stderr.write(`${tier}: repeat ${i + 1}/${repeats} done\n`)
	}
	const heapLimitDefault = okRun(await runChild('heap-limit', g.dirs.wal!)).report.counts.heapSizeLimitBytes
	// the smallest old-space limit under which the WAL recovery still succeeds (V8 aborts with an out-of-memory exit otherwise): which limit is hit first, V8's heap or the 3 GiB cgroup
	const floorProbe: { limitMB: number; ok: boolean; code?: number | null; signal?: string | null; tail?: string }[] = []
	if (heapFloor) {
		for (const limitMB of [768, 1024, 1280, 1536, 1792, 2048, 2560, 3072]) {
			const r = await runChild('recover-wal', g.dirs.wal!, [`--max-old-space-size=${limitMB}`], true)
			floorProbe.push(r.ok ? { limitMB, ok: true } : { limitMB, ok: false, code: r.code, signal: r.signal, tail: r.stderrTail.split('\n').filter((l) => /heap|memory|FATAL/i.test(l)).slice(0, 2).join(' | ') })
			process.stderr.write(`${tier}: heap floor probe ${limitMB} MB: ${r.ok ? 'ok' : `FAILED (${r.code}/${r.signal})`}\n`)
			if (r.ok) break
		}
	}
	const sum = (name: string, f: (r: Extract<ChildRun, { ok: true }>) => number): { median: number; max: number; all: number[] } => {
		const all = runs[name]!.map(f)
		return { median: med(all), max: Math.max(...all), all }
	}
	const G = 1024 ** 3
	const summary = {
		platform: `${process.platform}/${process.arch} node ${process.version}`,
		tier: { name: tier, ...t },
		sizesBytes: sizes,
		defaultHeapLimitBytes: heapLimitDefault,
		recoverWal: runs['recover-wal']!.length ? { releasePeakGB: sum('recover-wal', (r) => r.releasePeakBytes / G), osHighWaterGB: sum('recover-wal', (r) => r.report.maxRssBytes / G), timeMaxRssGB: sum('recover-wal', (r) => r.timeMaxRssBytes / G), peakFootprintGB: sum('recover-wal', (r) => r.peakFootprintBytes / G), psPeakGB: sum('recover-wal', (r) => r.psPeakBytes / G), rssBeforeGcGB: sum('recover-wal', (r) => r.report.rssBeforeGcBytes / G), rssAfterGcGB: sum('recover-wal', (r) => r.report.rssAfterGcBytes / G), heapAfterGcGB: sum('recover-wal', (r) => r.report.heapUsedAfterGcBytes / G), heapBeforeGcGB: sum('recover-wal', (r) => r.report.heapUsedBeforeGcBytes / G), recoverMs: sum('recover-wal', (r) => r.report.phases.recoverMs!), gcMaxPauseMs: sum('recover-wal', (r) => r.report.gc.maxPauseMs), gcTotalPauseMs: sum('recover-wal', (r) => r.report.gc.totalPauseMs) } : null,
		recoverWalTail: runs['recover-walTail']!.length ? { releasePeakGB: sum('recover-walTail', (r) => r.releasePeakBytes / G), recoverMs: sum('recover-walTail', (r) => r.report.phases.recoverMs!), replayed: runs['recover-walTail']![0]!.report.counts.replayed } : null,
		readLegacy: { releasePeakGB: sum('read-legacy', (r) => r.releasePeakBytes / G), osHighWaterGB: sum('read-legacy', (r) => r.report.maxRssBytes / G), timeMaxRssGB: sum('read-legacy', (r) => r.timeMaxRssBytes / G), psPeakGB: sum('read-legacy', (r) => r.psPeakBytes / G), maxRssAfterStateReadOnlyGB: sum('read-legacy', (r) => (r.report.counts.maxRssAfterReadStateKb! * 1024) / G), rssBeforeGcGB: sum('read-legacy', (r) => r.report.rssBeforeGcBytes / G), rssAfterGcGB: sum('read-legacy', (r) => r.report.rssAfterGcBytes / G), heapAfterGcGB: sum('read-legacy', (r) => r.report.heapUsedAfterGcBytes / G), readStateMs: sum('read-legacy', (r) => r.report.phases.readStateMs!), pendingMapMs: sum('read-legacy', (r) => r.report.phases.pendingMapMs!), gcMaxPauseMs: sum('read-legacy', (r) => r.report.gc.maxPauseMs) },
		snapshot: { snapshotMs: sum('snapshot', (r) => r.report.phases.snapshotMs!), slices: sum('snapshot', (r) => Number(r.report.extra!.slices)), maxSliceMs: sum('snapshot', (r) => Number(r.report.extra!.maxSliceMs)), eventLoopMaxMs: sum('snapshot', (r) => Number((r.report.extra!.eventLoopDelayMs as { max: number }).max)), releasePeakGB: sum('snapshot', (r) => r.releasePeakBytes / G), rssBeforeSnapshotGB: sum('snapshot', (r) => Number(r.report.extra!.rssBeforeSnapshotBytes) / G), bytesWritten: sum('snapshot', (r) => Number(r.report.extra!.bytesWritten)), gcMaxPauseMs: sum('snapshot', (r) => r.report.gc.maxPauseMs) },
		heapFloorProbe: floorProbe,
	}
	const raw = path.join(out, `results-${tier}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
	fs.writeFileSync(raw, JSON.stringify({ summary, runs, freeBeforeBytes: freeBefore }, null, 2))
	process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
	process.stderr.write(`${tier}: raw results ${raw}\n`)
	if (!keep) for (const f of forms) fs.rmSync(path.join(out, f), { recursive: true, force: true })
	const freeAfter = dfFreeBytes(out)
	process.stderr.write(`${tier}: disk free after cleanup: ${gb(freeAfter)} GB (before: ${gb(freeBefore)} GB, difference ${gb(freeAfter - freeBefore)} GB)\n`)
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
	void (async () => {
		const a = process.argv.slice(2)
		const get = (n: string, d?: string): string => {
			const i = a.indexOf(n)
			if (i < 0) {
				if (d === undefined) throw new Error(`${n} is required`)
				return d
			}
			return a[i + 1]!
		}
		if (a[0] === '--child') return childMain(get('--child'), get('--dir'))
		if (a[0] === 'm0') return tierRun('A', get('--out'), Number(get('--repeats', '5')), a.includes('--keep'), 0, false)
		if (a[0] === 'tier') return tierRun(get('--tier'), get('--out'), Number(get('--repeats', '5')), a.includes('--keep'), Number(get('--tail', '100000')), a.includes('--heapfloor'))
		throw new Error('usage: measure.test.ts tier --tier A|P0|B2 --out <dir> | m0 --out <dir> | --child <mode> --dir <dir>')
	})().catch((e) => {
		process.stderr.write(`measure: ${e instanceof Error ? e.stack : String(e)}\n`)
		process.exit(2)
	})
}

// ---------------------------------------------------------------------------------------------- self-test (tiny data)
// registered only under the test runner (a child process that imports this file must never run it: it would start children of its own)
if (process.env.NODE_TEST_CONTEXT) test('measurement tool self-test: the three child modes report on a tiny data set, the external profile and the OS high-water mark are plausible', async () => {
	const out = fs.mkdtempSync(path.join(process.env.P2D_TMP ?? '/tmp', 'p2d-meas-'))
	try {
		const g = await generate({ tier: 'tiny', forms: ['v2', 'wal'], out, seed: 3, tail: 0 })
		const r1 = okRun(await runChild('recover-wal', g.dirs.wal!))
		assert.ok(r1.timeMaxRssBytes > 20 * MB, `/usr/bin/time -l reports a maximum resident set size: ${r1.timeMaxRssBytes}`)
		assert.ok(r1.releasePeakBytes >= r1.report.maxRssBytes && r1.releasePeakBytes >= r1.timeMaxRssBytes, 'the release peak is the largest of the three readings')
		assert.equal(r1.report.counts.pending, 3000)
		assert.ok(r1.report.maxRssBytes > 20 * MB && r1.report.maxRssBytes < 2 * 1024 * MB, `maxRSS ${r1.report.maxRssBytes}`)
		assert.ok(r1.report.phases.recoverMs! >= 0)
		const r2 = okRun(await runChild('read-legacy', g.dirs.v2!))
		assert.equal(r2.report.counts.pending, 3000)
		assert.equal(r2.report.counts.consumed, 5000)
		const r3 = okRun(await runChild('snapshot', g.dirs.wal!))
		const hl = okRun(await runChild('heap-limit', g.dirs.wal!))
		assert.ok(Number(hl.report.counts.heapSizeLimitBytes) > 100 * MB, 'the heap limit is reported')
		const oom = await runChild('recover-wal', g.dirs.wal!, ['--max-old-space-size=4'], true)
		assert.equal(oom.ok, false, 'a 4 MB old space cannot even start: a V8 failure is returned, not thrown')
		assert.ok(Number(r3.report.extra!.bytesWritten) > 0, 'the snapshot wrote bytes (slices count only the yields, a tiny set finishes inside one slice)')
		assert.ok(r3.report.phases.snapshotMs! > 0)
		assert.equal(fs.readdirSync(path.join(out, 'wal')).filter((n) => n.startsWith('snapscratch')).length, 0, 'the scratch copy is removed')
	} finally {
		fs.rmSync(out, { recursive: true, force: true })
	}
})
