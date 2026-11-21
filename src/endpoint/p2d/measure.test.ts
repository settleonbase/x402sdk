/**
 * P2d measurement tool (test-only; *.test.ts keeps it out of the build; not in the lab*.test.ts suite glob). Every measurement runs in its OWN child process so peaks do not leak between runs.
 *
 *   tsx --expose-gc src/endpoint/p2d/measure.test.ts m0 --out <dir under claudeTemp/lab-p2d> [--repeats 5] [--keep]
 *
 * Child modes (internal, `--child <mode> --dir <state dir>`):
 *   recover-wal    recoverPayoutState on a version 3 / WAL directory (read-only), as the daemon's recovery does
 *   read-legacy    the legacy whole-state read (readStateFromDisk + the per-tick pending map the old path builds)
 *   snapshot       recover, then one cooperative snapshot into a scratch COPY of the directory
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
	gc: { count: number; maxPauseMs: number; totalPauseMs: number }
	counts: Record<string, number>
	extra?: Record<string, unknown>
}

function gcObserver(): { stop: () => { count: number; maxPauseMs: number; totalPauseMs: number } } {
	const obs = new PerformanceObserver(() => undefined)
	obs.observe({ entryTypes: ['gc'] })
	return {
		stop: () => {
			const recs = obs.takeRecords()
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
	} else throw new Error(`unknown child mode ${mode}`)
	lap('totalMs', t0)
	const heapBefore = process.memoryUsage().heapUsed
	const maxRssKb = process.resourceUsage().maxRSS
	gc?.()
	gc?.()
	const mem = process.memoryUsage()
	const gcStats = go.stop()
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
		gc: gcStats,
		counts,
		extra,
	}
	process.stdout.write(`P2D_REPORT ${JSON.stringify(report)}\n`)
}

// ---------------------------------------------------------------------------------------------- parent side
function runChild(mode: string, dir: string, extraNodeArgs: string[] = []): Promise<{ report: ChildReport; psPeakBytes: number; psSamples: number; wallMs: number }> {
	if (process.env.P2D_CHILD) throw new Error('p2d: a measurement child must not start children of its own')
	const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
	const args = [...loader.filter((a) => !a.startsWith('--expose-gc')), '--expose-gc', ...extraNodeArgs, __filename, '--child', mode, '--dir', dir]
	const t0 = Date.now()
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), P2D_CHILD: '1' } })
		let out = ''
		let err = ''
		let peak = 0
		let samples = 0
		child.stdout.on('data', (d: Buffer) => void (out += d.toString('utf8')))
		child.stderr.on('data', (d: Buffer) => void (err += d.toString('utf8')))
		const timer = setInterval(() => {
			try {
				const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim())
				if (Number.isFinite(kb)) {
					peak = Math.max(peak, kb * 1024)
					samples++
				}
			} catch {
				/* the child has exited */
			}
		}, 25)
		child.on('exit', (code) => {
			clearInterval(timer)
			const line = out.split('\n').find((l) => l.startsWith('P2D_REPORT '))
			if (code !== 0 || !line) return reject(new Error(`child ${mode} exited ${code}: ${err.slice(-500)} ${out.slice(-300)}`))
			resolve({ report: JSON.parse(line.slice('P2D_REPORT '.length)) as ChildReport, psPeakBytes: peak, psSamples: samples, wallMs: Date.now() - t0 })
		})
	})
}

const med = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!
const gb = (b: number): string => (b / 1024 ** 3).toFixed(3)

function dfFreeBytes(dir: string): number {
	const st = fs.statfsSync(dir)
	return Number(st.bavail) * Number(st.bsize)
}

async function m0(out: string, repeats: number, keep: boolean): Promise<void> {
	if (!path.resolve(out).includes('/claudeTemp/lab-p2d')) throw new Error('p2d: the output directory must be under claudeTemp/lab-p2d')
	fs.mkdirSync(out, { recursive: true })
	const freeBefore = dfFreeBytes(out)
	process.stderr.write(`M0: disk free before: ${gb(freeBefore)} GB (floor ${gb(FREE_SPACE_FLOOR_BYTES)} GB)\n`)
	const t = TIERS.A!
	assertFreeSpace(out, (t.pending * 330 + t.consumed * 70) * 2)
	const tGen = Date.now()
	const g = await generate({ tier: 'A', forms: ['v2', 'wal'], out, seed: 1, tail: 0 })
	process.stderr.write(`M0: generated tier A (${t.pending} pending, ${t.consumed} consumed) in ${((Date.now() - tGen) / 1000).toFixed(1)} s; free ${gb(dfFreeBytes(out))} GB\n`)
	const du = (d: string): number => Number(execFileSync('du', ['-sk', d], { encoding: 'utf8' }).split('\t')[0]) * 1024
	const sizes = { v2: du(path.join(out, 'v2')), wal: du(path.join(out, 'wal')) }
	const results: Record<string, unknown[]> = { 'recover-wal': [], 'read-legacy': [], snapshot: [] }
	for (let i = 0; i < repeats; i++) {
		results['recover-wal']!.push(await runChild('recover-wal', g.dirs.wal!))
		results['read-legacy']!.push(await runChild('read-legacy', g.dirs.v2!))
		if (i < 3) results.snapshot!.push(await runChild('snapshot', g.dirs.wal!))
		process.stderr.write(`M0: repeat ${i + 1}/${repeats} done\n`)
	}
	const summarize = (name: string, f: (r: { report: ChildReport; psPeakBytes: number }) => number): { median: number; max: number; all: number[] } => {
		const all = (results[name] as { report: ChildReport; psPeakBytes: number }[]).map(f)
		return { median: med(all), max: Math.max(...all), all }
	}
	const summary = {
		platform: `${process.platform}/${process.arch} node ${process.version}`,
		tier: { name: 'A', ...t },
		sizesBytes: sizes,
		recoverWal: { maxRssGB: { ...summarize('recover-wal', (r) => r.report.maxRssBytes / 1024 ** 3) }, psPeakGB: summarize('recover-wal', (r) => r.psPeakBytes / 1024 ** 3), steadyAfterGcGB: summarize('recover-wal', (r) => r.report.rssAfterGcBytes / 1024 ** 3), heapAfterGcGB: summarize('recover-wal', (r) => r.report.heapUsedAfterGcBytes / 1024 ** 3), recoverMs: summarize('recover-wal', (r) => r.report.phases.recoverMs!), gcMaxPauseMs: summarize('recover-wal', (r) => r.report.gc.maxPauseMs) },
		readLegacy: { maxRssGB: summarize('read-legacy', (r) => r.report.maxRssBytes / 1024 ** 3), psPeakGB: summarize('read-legacy', (r) => r.psPeakBytes / 1024 ** 3), steadyAfterGcGB: summarize('read-legacy', (r) => r.report.rssAfterGcBytes / 1024 ** 3), readStateMs: summarize('read-legacy', (r) => r.report.phases.readStateMs!), pendingMapMs: summarize('read-legacy', (r) => r.report.phases.pendingMapMs!), gcMaxPauseMs: summarize('read-legacy', (r) => r.report.gc.maxPauseMs) },
		snapshot: { snapshotMs: summarize('snapshot', (r) => r.report.phases.snapshotMs!), slices: summarize('snapshot', (r) => Number(r.report.extra!.slices)), maxSliceMs: summarize('snapshot', (r) => Number(r.report.extra!.maxSliceMs)), eventLoopMaxMs: summarize('snapshot', (r) => Number((r.report.extra!.eventLoopDelayMs as { max: number }).max)), maxRssGB: summarize('snapshot', (r) => r.report.maxRssBytes / 1024 ** 3), bytesWritten: summarize('snapshot', (r) => Number(r.report.extra!.bytesWritten)) },
	}
	const raw = path.join(out, `results-M0-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
	fs.writeFileSync(raw, JSON.stringify({ summary, results, freeBeforeBytes: freeBefore }, null, 2))
	process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
	process.stderr.write(`M0: raw results ${raw}\n`)
	if (!keep) {
		fs.rmSync(path.join(out, 'v2'), { recursive: true, force: true })
		fs.rmSync(path.join(out, 'wal'), { recursive: true, force: true })
	}
	const freeAfter = dfFreeBytes(out)
	process.stderr.write(`M0: disk free after cleanup: ${gb(freeAfter)} GB (before: ${gb(freeBefore)} GB, difference ${gb(freeAfter - freeBefore)} GB)\n`)
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
		if (a[0] === 'm0') return m0(get('--out'), Number(get('--repeats', '5')), a.includes('--keep'))
		throw new Error('usage: measure.test.ts m0 --out <dir> | --child <mode> --dir <dir>')
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
		const r1 = await runChild('recover-wal', g.dirs.wal!)
		assert.equal(r1.report.counts.pending, 3000)
		assert.ok(r1.report.maxRssBytes > 20 * MB && r1.report.maxRssBytes < 2 * 1024 * MB, `maxRSS ${r1.report.maxRssBytes}`)
		assert.ok(r1.report.phases.recoverMs! >= 0)
		const r2 = await runChild('read-legacy', g.dirs.v2!)
		assert.equal(r2.report.counts.pending, 3000)
		assert.equal(r2.report.counts.consumed, 5000)
		const r3 = await runChild('snapshot', g.dirs.wal!)
		assert.ok(Number(r3.report.extra!.bytesWritten) > 0, 'the snapshot wrote bytes (slices count only the yields, a tiny set finishes inside one slice)')
		assert.ok(r3.report.phases.snapshotMs! > 0)
		assert.equal(fs.readdirSync(path.join(out, 'wal')).filter((n) => n.startsWith('snapscratch')).length, 0, 'the scratch copy is removed')
	} finally {
		fs.rmSync(out, { recursive: true, force: true })
	}
})
