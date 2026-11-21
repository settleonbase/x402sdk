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
	/** RSS after exactly ONE forced GC (the reviewer's method for "steady"); rssAfterGcBytes is after two */
	rssAfterOneGcBytes: number
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
	if (mode === 'recover-wal' || mode === 'recover-wal-whole') {
		const t = process.hrtime.bigint()
		// 'recover-wal' = the daemon's default loader (streaming since P2d M3); 'recover-wal-whole' = the original whole-state loader, for the before/after comparison
		const rec = recoverPayoutState(dir, { readOnly: true, loader: mode === 'recover-wal-whole' ? 'whole' : 'stream' })
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
	const rssAfterOneGc = process.memoryUsage().rss // the reviewer's "steady": exactly ONE global.gc(), then rss
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
		rssAfterOneGcBytes: rssAfterOneGc,
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
/** Spawn limits (after the first version of the tool multiplied its own children): depth 1 only (a child must not start children: P2D_CHILD), one child at a time, and a total cap per process. */
export const P2D_MAX_CHILDREN = Number(process.env.P2D_MAX_CHILDREN ?? 400)
const spawnState = { started: 0, running: 0 }
export const spawnStateForTest = spawnState

function runChild(mode: string, dir: string, extraNodeArgs: string[] = [], allowFail = false): Promise<ChildRun> {
	if (process.env.P2D_CHILD) throw new Error('p2d: a measurement child must not start children of its own')
	if (spawnState.running >= 1) throw new Error('p2d: a measurement child is still running; the tool runs one child at a time')
	if (spawnState.started >= P2D_MAX_CHILDREN) throw new Error(`p2d: ${spawnState.started} children already started in this process (cap ${P2D_MAX_CHILDREN}); refusing to start more`)
	spawnState.started++
	spawnState.running++
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
			spawnState.running--
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

type CurveCell = { ok: boolean; n: number; releasePeakGB?: { median: number; max: number; all: number[] }; heapAfterGcGB?: number; rssAfterOneGcGB?: number; recoverMs?: number; gcMaxPauseMs?: number; failedWith?: string }

/**
 * Consumed-count curve at a fixed pending size (and, with several --pendings, a grid): for every size the state is generated once (v2 and WAL snapshot), then recovered with the streaming loader, the
 * whole-state loader and the old path's read, each under every heap setting ("default" = Node's own default old-space limit on this host; a number = --max-old-space-size in MB). A child that
 * dies (V8 out of memory = SIGABRT) is recorded as a failed cell, not an error. Release peak = max(OS high-water, /usr/bin/time -l, 20 ms sample). Data sets are deleted after every size.
 */
async function curveRun(out: string, pendings: number[], consumeds: number[], heaps: string[], repeats: number): Promise<void> {
	if (!path.resolve(out).includes('/claudeTemp/lab-p2d')) throw new Error('p2d: the output directory must be under claudeTemp/lab-p2d')
	fs.mkdirSync(out, { recursive: true })
	const freeBefore = dfFreeBytes(out)
	process.stderr.write(`curve: uptime at start: ${execFileSync('uptime', { encoding: 'utf8' }).trim()}\ncurve: disk free before: ${gb(freeBefore)} GB\n`)
	const G = 1024 ** 3
	const cells: Record<string, CurveCell> = {}
	for (const pending of pendings) {
		for (const consumed of consumeds) {
			const name = `c_${pending}_${consumed}`
			TIERS[name] = { pending, consumed, exited: 2_000, historyShare: pending >= 1_900_000 ? 1_800_000 / pending : 1_609_706 / 1_683_285 }
			const dirOut = path.join(out, name)
			const g = await generate({ tier: name, forms: ['v2', 'wal'], out: dirOut, seed: 1, tail: 0 })
			for (const heap of heaps) {
				const args = heap === 'default' ? [] : [`--max-old-space-size=${heap}`]
				for (const [label, mode, dir] of [['stream', 'recover-wal', g.dirs.wal!], ['whole', 'recover-wal-whole', g.dirs.wal!], ['oldpath', 'read-legacy', g.dirs.v2!]] as const) {
					const runsOk: Extract<ChildRun, { ok: true }>[] = []
					let failed: string | undefined
					for (let i = 0; i < repeats; i++) {
						const r = await runChild(mode, dir, args, true)
						if (r.ok) runsOk.push(r)
						else {
							failed = `${r.code}/${r.signal}`
							break
						}
					}
					const key = `${pending}|${consumed}|${heap}|${label}`
					if (failed || runsOk.length === 0) cells[key] = { ok: false, n: runsOk.length, failedWith: failed }
					else {
						const peaks = runsOk.map((r) => r.releasePeakBytes / G)
						cells[key] = { ok: true, n: runsOk.length, releasePeakGB: { median: med(peaks), max: Math.max(...peaks), all: peaks }, heapAfterGcGB: runsOk[0]!.report.heapUsedAfterGcBytes / G, rssAfterOneGcGB: med(runsOk.map((r) => r.report.rssAfterOneGcBytes / G)), recoverMs: med(runsOk.map((r) => r.report.phases.recoverMs ?? r.report.phases.readStateMs! + r.report.phases.pendingMapMs!)), gcMaxPauseMs: med(runsOk.map((r) => r.report.gc.maxPauseMs)) }
					}
					process.stderr.write(`curve: pending ${pending} consumed ${consumed} heap ${heap} ${label}: ${cells[key]!.ok ? `peak ${cells[key]!.releasePeakGB!.median.toFixed(3)} GB` : `FAILED ${cells[key]!.failedWith}`}\n`)
				}
			}
			fs.rmSync(dirOut, { recursive: true, force: true })
			process.stderr.write(`curve: ${name} done; disk free ${gb(dfFreeBytes(out))} GB\n`)
		}
	}
	const summary = { platform: `${process.platform}/${process.arch} node ${process.version}`, pendings, consumeds, heaps, repeats, cells }
	const raw = path.join(out, `results-curve-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
	fs.writeFileSync(raw, JSON.stringify(summary, null, 2))
	process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
	process.stderr.write(`curve: uptime at end: ${execFileSync('uptime', { encoding: 'utf8' }).trim()}\ncurve: raw results ${raw}\ncurve: disk free after cleanup: ${gb(dfFreeBytes(out))} GB (before ${gb(freeBefore)} GB)\n`)
}

async function tierRun(tier: string, out: string, repeats: number, keep: boolean, tail: number, heapFloor: boolean): Promise<void> {
	if (!path.resolve(out).includes('/claudeTemp/lab-p2d')) throw new Error('p2d: the output directory must be under claudeTemp/lab-p2d')
	const t = TIERS[tier]
	if (!t) throw new Error(`unknown tier ${tier}`)
	fs.mkdirSync(out, { recursive: true })
	const forms = tier === 'B2' || tier === 'P0' ? ['v2', 'wal', 'walTail'] : ['v2', 'wal']
	process.stderr.write(`${tier}: uptime at start: ${execFileSync('uptime', { encoding: 'utf8' }).trim()}\n`)
	const freeBefore = dfFreeBytes(out)
	process.stderr.write(`${tier}: disk free before: ${gb(freeBefore)} GB (floor ${gb(FREE_SPACE_FLOOR_BYTES)} GB)\n`)
	const tGen = Date.now()
	const g = await generate({ tier, forms, out, seed: 1, tail })
	process.stderr.write(`${tier}: generated (${t.pending} pending, ${t.consumed} consumed, forms ${forms.join('/')}) in ${((Date.now() - tGen) / 1000).toFixed(1)} s; free ${gb(dfFreeBytes(out))} GB\n`)
	const du = (d: string): number => Number(execFileSync('du', ['-sk', d], { encoding: 'utf8' }).split('\t')[0]) * 1024
	const sizes: Record<string, number> = {}
	for (const f of forms) sizes[f] = du(path.join(out, f))
	const runs: Record<string, Extract<ChildRun, { ok: true }>[]> = { 'recover-wal': [], 'recover-wal-whole': [], 'read-legacy': [], snapshot: [], 'recover-walTail': [], 'recover-walTail-whole': [] }
	for (let i = 0; i < repeats; i++) {
		runs['recover-wal']!.push(okRun(await runChild('recover-wal', g.dirs.wal!)))
		runs['recover-wal-whole']!.push(okRun(await runChild('recover-wal-whole', g.dirs.wal!)))
		runs['read-legacy']!.push(okRun(await runChild('read-legacy', g.dirs.v2!)))
		if (g.dirs.walTail) runs['recover-walTail']!.push(okRun(await runChild('recover-wal', g.dirs.walTail!)))
		if (g.dirs.walTail) runs['recover-walTail-whole']!.push(okRun(await runChild('recover-wal-whole', g.dirs.walTail!)))
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
		recoverWal: runs['recover-wal']!.length ? { releasePeakGB: sum('recover-wal', (r) => r.releasePeakBytes / G), osHighWaterGB: sum('recover-wal', (r) => r.report.maxRssBytes / G), timeMaxRssGB: sum('recover-wal', (r) => r.timeMaxRssBytes / G), peakFootprintGB: sum('recover-wal', (r) => r.peakFootprintBytes / G), psPeakGB: sum('recover-wal', (r) => r.psPeakBytes / G), rssBeforeGcGB: sum('recover-wal', (r) => r.report.rssBeforeGcBytes / G), rssAfterOneGcGB: sum('recover-wal', (r) => r.report.rssAfterOneGcBytes / G), rssAfterGcGB: sum('recover-wal', (r) => r.report.rssAfterGcBytes / G), heapAfterGcGB: sum('recover-wal', (r) => r.report.heapUsedAfterGcBytes / G), heapBeforeGcGB: sum('recover-wal', (r) => r.report.heapUsedBeforeGcBytes / G), recoverMs: sum('recover-wal', (r) => r.report.phases.recoverMs!), gcMaxPauseMs: sum('recover-wal', (r) => r.report.gc.maxPauseMs), gcTotalPauseMs: sum('recover-wal', (r) => r.report.gc.totalPauseMs) } : null,
		recoverWalWhole: runs['recover-wal-whole']!.length ? { releasePeakGB: sum('recover-wal-whole', (r) => r.releasePeakBytes / G), osHighWaterGB: sum('recover-wal-whole', (r) => r.report.maxRssBytes / G), rssBeforeGcGB: sum('recover-wal-whole', (r) => r.report.rssBeforeGcBytes / G), rssAfterOneGcGB: sum('recover-wal-whole', (r) => r.report.rssAfterOneGcBytes / G), heapAfterGcGB: sum('recover-wal-whole', (r) => r.report.heapUsedAfterGcBytes / G), heapBeforeGcGB: sum('recover-wal-whole', (r) => r.report.heapUsedBeforeGcBytes / G), recoverMs: sum('recover-wal-whole', (r) => r.report.phases.recoverMs!), gcMaxPauseMs: sum('recover-wal-whole', (r) => r.report.gc.maxPauseMs), gcTotalPauseMs: sum('recover-wal-whole', (r) => r.report.gc.totalPauseMs) } : null,
		recoverWalTailWhole: runs['recover-walTail-whole']!.length ? { releasePeakGB: sum('recover-walTail-whole', (r) => r.releasePeakBytes / G), recoverMs: sum('recover-walTail-whole', (r) => r.report.phases.recoverMs!) } : null,
		recoverWalTail: runs['recover-walTail']!.length ? { releasePeakGB: sum('recover-walTail', (r) => r.releasePeakBytes / G), recoverMs: sum('recover-walTail', (r) => r.report.phases.recoverMs!), replayed: runs['recover-walTail']![0]!.report.counts.replayed } : null,
		readLegacy: { releasePeakGB: sum('read-legacy', (r) => r.releasePeakBytes / G), osHighWaterGB: sum('read-legacy', (r) => r.report.maxRssBytes / G), timeMaxRssGB: sum('read-legacy', (r) => r.timeMaxRssBytes / G), psPeakGB: sum('read-legacy', (r) => r.psPeakBytes / G), maxRssAfterStateReadOnlyGB: sum('read-legacy', (r) => (r.report.counts.maxRssAfterReadStateKb! * 1024) / G), rssBeforeGcGB: sum('read-legacy', (r) => r.report.rssBeforeGcBytes / G), rssAfterOneGcGB: sum('read-legacy', (r) => r.report.rssAfterOneGcBytes / G), rssAfterGcGB: sum('read-legacy', (r) => r.report.rssAfterGcBytes / G), heapAfterGcGB: sum('read-legacy', (r) => r.report.heapUsedAfterGcBytes / G), readStateMs: sum('read-legacy', (r) => r.report.phases.readStateMs!), pendingMapMs: sum('read-legacy', (r) => r.report.phases.pendingMapMs!), gcMaxPauseMs: sum('read-legacy', (r) => r.report.gc.maxPauseMs) },
		snapshot: { snapshotMs: sum('snapshot', (r) => r.report.phases.snapshotMs!), slices: sum('snapshot', (r) => Number(r.report.extra!.slices)), maxSliceMs: sum('snapshot', (r) => Number(r.report.extra!.maxSliceMs)), eventLoopMaxMs: sum('snapshot', (r) => Number((r.report.extra!.eventLoopDelayMs as { max: number }).max)), releasePeakGB: sum('snapshot', (r) => r.releasePeakBytes / G), rssBeforeSnapshotGB: sum('snapshot', (r) => Number(r.report.extra!.rssBeforeSnapshotBytes) / G), bytesWritten: sum('snapshot', (r) => Number(r.report.extra!.bytesWritten)), gcMaxPauseMs: sum('snapshot', (r) => r.report.gc.maxPauseMs) },
		heapFloorProbe: floorProbe,
	}
	process.stderr.write(`${tier}: uptime at end: ${execFileSync('uptime', { encoding: 'utf8' }).trim()}\n`)
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
		if (a[0] === 'curve') return curveRun(get('--out'), get('--pendings', '2050000').split(',').map(Number), get('--consumeds', '250000,500000,1000000,2000000,3000000').split(',').map(Number), get('--heaps', 'default,1536').split(','), Number(get('--repeats', '3')))
		throw new Error('usage: measure.test.ts tier --tier A|P0|B2 --out <dir> | curve --out <dir> [--pendings a,b] [--consumeds a,b,c] [--heaps default,1536] | m0 --out <dir> | --child <mode> --dir <dir>')
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

if (process.env.NODE_TEST_CONTEXT) {
	test('spawn guards: a measurement child cannot start children, children run one at a time, the total is capped, and a child process registers no tests', async () => {
		const out = fs.mkdtempSync(path.join(process.env.P2D_TMP ?? '/tmp', 'p2d-guard-'))
		try {
			const g = await generate({ tier: 'tiny', forms: ['wal'], out, seed: 5, tail: 0 })
			// 1. depth: with the child marker set (as every child has it) runChild refuses
			process.env.P2D_CHILD = '1'
			try {
				assert.throws(() => runChild('heap-limit', g.dirs.wal!), /must not start children of its own/)
			} finally {
				delete process.env.P2D_CHILD
			}
			// 2. concurrency: a second child while one runs is refused (the first one is allowed to finish)
			const first = runChild('heap-limit', g.dirs.wal!)
			assert.throws(() => runChild('heap-limit', g.dirs.wal!), /one child at a time/)
			okRun(await first)
			// 3. total cap
			const before = spawnState.started
			const savedCap = (spawnStateForTest as { started: number }).started
			spawnState.started = P2D_MAX_CHILDREN
			try {
				assert.throws(() => runChild('heap-limit', g.dirs.wal!), /cap \d+\); refusing to start more/)
			} finally {
				spawnState.started = savedCap
			}
			assert.equal(spawnState.started, before)
			// 4. a child process that imports this module registers and runs NO test and prints no TAP: it only reports (the first version's children ran the self-test, which started children...)
			const r = okRun(await runChild('heap-limit', g.dirs.wal!))
			assert.ok(r.report.counts.heapSizeLimitBytes! > 0)
			// the raw output of a child is one report line: re-run the child by hand and look at everything it printed
			const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
			const raw = execFileSync(process.execPath, [...loader.filter((a) => !a.startsWith('--max-old-space-size')), '--expose-gc', __filename, '--child', 'heap-limit', '--dir', g.dirs.wal!], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), P2D_CHILD: '1' } })
			assert.ok(!/TAP version|# Subtest|^ok |^not ok /m.test(raw), `a child printed test output: ${raw.slice(0, 200)}`)
			assert.equal(raw.trim().split('\n').length, 1, 'exactly one line: the report')
		} finally {
			fs.rmSync(out, { recursive: true, force: true })
		}
	})
}
