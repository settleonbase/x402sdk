/**
 * labTickLoop: deterministic tests with injected timers (virtual time) plus real-timer tests for the interval distribution and the CPU cost of idle and fault loops.
 * Fakes only. No RPC.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LabTickLoop, type LabTickOutcome } from './labTickLoop'

/** Virtual timers: setImmediate and setTimeout queues that the test drives by hand. */
function makeFakeTimers() {
	let now = 0
	let seq = 0
	const immediates = new Map<number, () => void>()
	const timers = new Map<number, { at: number; fn: () => void }>()
	const requested: number[] = []
	return {
		deps: {
			setImmediate: (fn: () => void) => {
				const id = ++seq
				immediates.set(id, fn)
				return id
			},
			clearImmediate: (h: unknown) => void immediates.delete(h as number),
			setTimeout: (fn: () => void, ms: number) => {
				const id = ++seq
				requested.push(ms)
				timers.set(id, { at: now + ms, fn })
				return id
			},
			clearTimeout: (h: unknown) => void timers.delete(h as number),
		},
		requested,
		pendingImmediates: () => immediates.size,
		pendingTimers: () => timers.size,
		now: () => now,
		/** Fire everything due now: immediates first; returns false when nothing was fired. */
		fireImmediate(): boolean {
			const e = [...immediates.entries()][0]
			if (!e) return false
			immediates.delete(e[0])
			e[1]()
			return true
		},
		/** Advance virtual time to the next timer and fire it; returns false when there is none. */
		fireNextTimer(): boolean {
			const e = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
			if (!e) return false
			timers.delete(e[0])
			now = Math.max(now, e[1].at)
			e[1].fn()
			return true
		},
		/** Fire a timer even though stop() cleared it (a clear that raced the callback): models "the callback was already queued". */
		raw: { immediates, timers },
	}
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const flush = async (n = 8): Promise<void> => {
	for (let i = 0; i < n; i++) await tick()
}

/** A scripted tick: outcomes are consumed in order, then `after` repeats. Tracks concurrency. */
function makeTick(script: LabTickOutcome[], after: LabTickOutcome, hold?: () => Promise<void>) {
	let running = 0
	const s = { calls: 0, max: 0, starts: [] as number[] }
	return Object.assign(s, {
		fn: async (): Promise<LabTickOutcome> => {
			s.calls++
			running++
			s.max = Math.max(s.max, running)
			try {
				if (hold) await hold()
				else await tick()
				return script.shift() ?? after
			} finally {
				running--
			}
		},
	})
}

test('L1: a working tick is followed by setImmediate, never by a timer; idle/fault/skipped by exactly one backoff of backoffMs()', async () => {
	const ft = makeFakeTimers()
	const t = makeTick(['progress', 'progress', 'idle', 'fault', 'skipped', 'progress'], 'idle')
	const events: string[] = []
	let backoff = 60_000
	const loop = new LabTickLoop({ tick: t.fn, backoffMs: () => backoff, ...ft.deps, onSchedule: (e) => events.push(`${e.outcome}:${e.mode}:${e.delayMs}`) })
	assert.equal(loop.start(), true)
	await flush()
	assert.equal(t.calls, 1)
	assert.equal(ft.pendingImmediates(), 1)
	assert.equal(ft.pendingTimers(), 0)
	ft.fireImmediate()
	await flush()
	assert.equal(t.calls, 2)
	ft.fireImmediate()
	await flush()
	assert.equal(t.calls, 3) // third tick returned 'idle'
	assert.equal(ft.pendingImmediates(), 0)
	assert.deepEqual(ft.requested, [60_000])
	backoff = 17_000 // re-read on every use
	ft.fireNextTimer()
	await flush()
	assert.equal(t.calls, 4) // 'fault' -> backoff 17 000
	assert.deepEqual(ft.requested, [60_000, 17_000])
	ft.fireNextTimer()
	await flush()
	assert.equal(t.calls, 5) // 'skipped' -> backoff
	assert.deepEqual(ft.requested, [60_000, 17_000, 17_000])
	ft.fireNextTimer()
	await flush()
	assert.equal(t.calls, 6)
	assert.equal(ft.pendingImmediates(), 1) // 'progress' -> immediate again
	assert.deepEqual(events, ['progress:immediate:0', 'progress:immediate:0', 'idle:backoff:60000', 'fault:backoff:17000', 'skipped:backoff:17000', 'progress:immediate:0'])
	loop.stop()
	assert.equal(t.max, 1)
})

test('L2: a rejecting tick counts as fault (backoff, loop stays alive)', async () => {
	const ft = makeFakeTimers()
	let n = 0
	const loop = new LabTickLoop({
		tick: async () => {
			n++
			if (n === 1) throw new Error('boom')
			return 'idle'
		},
		backoffMs: () => 15_000,
		...ft.deps,
	})
	loop.start()
	await flush()
	assert.deepEqual(ft.requested, [15_000])
	ft.fireNextTimer()
	await flush()
	assert.equal(n, 2)
	assert.deepEqual(ft.requested, [15_000, 15_000])
	loop.stop()
})

test('L3: stop() while a tick runs: the tick finishes, nothing is re-armed, isRunning reflects the unfinished tick', async () => {
	const ft = makeFakeTimers()
	let release: () => void = () => undefined
	const gate = new Promise<void>((r) => (release = r))
	const t = makeTick(['progress'], 'progress', () => gate)
	const loop = new LabTickLoop({ tick: t.fn, backoffMs: () => 60_000, ...ft.deps })
	loop.start()
	await flush()
	assert.equal(loop.isRunning(), true)
	loop.stop()
	assert.equal(loop.isActive(), false)
	assert.equal(loop.isRunning(), true) // still finishing: the shutdown path waits for labInFlight, not for the loop
	release()
	await flush()
	assert.equal(loop.isRunning(), false)
	assert.equal(ft.pendingImmediates(), 0)
	assert.equal(ft.pendingTimers(), 0)
	assert.equal(t.calls, 1)
})

test('L4: stop() clears a pending immediate and a pending backoff timer; a callback that was already queued and fires anyway does not tick', async () => {
	// pending immediate
	{
		const ft = makeFakeTimers()
		const t = makeTick([], 'progress')
		const loop = new LabTickLoop({ tick: t.fn, backoffMs: () => 60_000, ...ft.deps })
		loop.start()
		await flush()
		assert.equal(ft.pendingImmediates(), 1)
		const queued = [...ft.raw.immediates.values()][0]!
		loop.stop()
		assert.equal(ft.pendingImmediates(), 0)
		queued() // the callback ran although clearImmediate had been called (race): the generation check stops it
		await flush()
		assert.equal(t.calls, 1)
	}
	// pending backoff timer
	{
		const ft = makeFakeTimers()
		const t = makeTick([], 'idle')
		const loop = new LabTickLoop({ tick: t.fn, backoffMs: () => 60_000, ...ft.deps })
		loop.start()
		await flush()
		assert.equal(ft.pendingTimers(), 1)
		const queued = [...ft.raw.timers.values()][0]!.fn
		loop.stop()
		assert.equal(ft.pendingTimers(), 0)
		queued()
		await flush()
		assert.equal(t.calls, 1)
	}
})

test('L5: duplicate start does not create a second loop', async () => {
	const ft = makeFakeTimers()
	const t = makeTick([], 'progress')
	const loop = new LabTickLoop({ tick: t.fn, backoffMs: () => 60_000, ...ft.deps })
	assert.equal(loop.start(), true)
	assert.equal(loop.start(), false)
	assert.equal(loop.start(), false)
	await flush()
	assert.equal(t.calls, 1)
	assert.equal(ft.pendingImmediates(), 1) // one continuation, not three
	for (let i = 0; i < 5; i++) {
		ft.fireImmediate()
		await flush()
	}
	assert.equal(t.calls, 6)
	assert.equal(t.max, 1)
	loop.stop()
})

test('L6: stop() then start() while the old generation\'s tick is still running: the old one never re-arms, only one loop exists', async () => {
	const ft = makeFakeTimers()
	let release: () => void = () => undefined
	let first = true
	let running = 0
	let maxRunning = 0
	let calls = 0
	const gate = new Promise<void>((r) => (release = r))
	// the daemon's labInFlight guard, modelled: a second tick while one runs is 'skipped'
	let inFlight = false
	const loop = new LabTickLoop({
		tick: async () => {
			calls++
			if (inFlight) return 'skipped'
			inFlight = true
			running++
			maxRunning = Math.max(maxRunning, running)
			try {
				if (first) {
					first = false
					await gate
				} else await tick()
				return 'progress'
			} finally {
				running--
				inFlight = false
			}
		},
		backoffMs: () => 60_000,
		...ft.deps,
	})
	loop.start() // generation 1, tick running
	await flush()
	loop.stop()
	assert.equal(loop.start(), true) // generation 2: its first tick runs while generation 1's is still in flight -> 'skipped'
	await flush()
	assert.equal(calls, 2)
	assert.deepEqual(ft.requested, [60_000]) // generation 2 backs off
	release() // generation 1 ends: must not re-arm
	await flush()
	assert.equal(ft.pendingImmediates(), 0)
	assert.equal(ft.pendingTimers(), 1) // only generation 2's backoff timer
	ft.fireNextTimer()
	await flush()
	assert.equal(calls, 3)
	assert.equal(ft.pendingImmediates(), 1) // generation 2 now makes progress
	assert.equal(maxRunning, 1)
	loop.stop()
})

test('L7: virtual time: an always-idle, always-fault and always-skipped loop starts at most one tick per backoff (no busy loop), for any number of timer firings', async () => {
	for (const outcome of ['idle', 'fault', 'skipped'] as const) {
		const ft = makeFakeTimers()
		const t = makeTick([], outcome)
		const loop = new LabTickLoop({ tick: t.fn, backoffMs: () => 60_000, ...ft.deps })
		loop.start()
		await flush()
		let fired = 0
		while (fired < 50 && ft.fireNextTimer()) {
			fired++
			await flush()
			assert.equal(ft.pendingImmediates(), 0, `${outcome}: no immediate continuation`)
		}
		assert.equal(fired, 50)
		assert.equal(t.calls, 51, `${outcome}: one tick per timer firing plus the first`)
		assert.ok(ft.requested.every((m) => m === 60_000))
		assert.equal(ft.now(), 50 * 60_000)
		loop.stop()
	}
})

test('L8: real timers: tick durations are not stretched - the gap between a finished tick and the next start is a setImmediate turn; max concurrency 1 over 2000 ticks', async () => {
	let running = 0
	let max = 0
	let calls = 0
	let lastEnd = 0n
	const gaps: number[] = []
	let done: () => void = () => undefined
	const finished = new Promise<void>((r) => (done = r))
	const loop = new LabTickLoop({
		tick: async () => {
			const start = process.hrtime.bigint()
			if (lastEnd) gaps.push(Number(start - lastEnd) / 1e6)
			calls++
			running++
			max = Math.max(max, running)
			await new Promise((r) => setTimeout(r, 0)) // some async work
			running--
			lastEnd = process.hrtime.bigint()
			if (calls >= 2000) {
				queueMicrotask(done)
				return 'idle'
			}
			return 'progress'
		},
		backoffMs: () => 60_000,
	})
	loop.start()
	await finished
	loop.stop()
	assert.equal(max, 1)
	gaps.sort((a, b) => a - b)
	const p = (q: number): number => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]!
	console.log(`L8 gaps ms: n=${gaps.length} p50=${p(0.5).toFixed(3)} p99=${p(0.99).toFixed(3)} max=${gaps[gaps.length - 1]!.toFixed(3)}`)
	assert.ok(p(0.5) < 5, 'median gap is a setImmediate turn, not a wait')
	assert.ok(gaps[gaps.length - 1]! < 250, 'no gap anywhere near a timer-length wait')
})

test('L9: real timers: idle and fault loops with a 300 ms backoff make at most one tick per backoff and use almost no CPU; stop leaves no timer behind', async () => {
	for (const outcome of ['idle', 'fault'] as const) {
		let calls = 0
		const loop = new LabTickLoop({
			tick: async () => {
				calls++
				if (outcome === 'fault') throw new Error('rpc down')
				return 'idle'
			},
			backoffMs: () => 300,
		})
		const cpu0 = process.cpuUsage()
		loop.start()
		await new Promise((r) => setTimeout(r, 1_850))
		loop.stop()
		const cpu = process.cpuUsage(cpu0)
		const cpuMs = (cpu.user + cpu.system) / 1000
		console.log(`L9 ${outcome}: ticks=${calls} in 1850 ms at backoff 300 ms, cpu=${cpuMs.toFixed(1)} ms`)
		assert.ok(calls >= 6 && calls <= 7, `${outcome}: ${calls} ticks (1 + floor(1850/300) = 7 at most)`)
		assert.ok(cpuMs < 150, `${outcome}: cpu ${cpuMs} ms`)
		const before = calls
		await new Promise((r) => setTimeout(r, 700))
		assert.equal(calls, before, `${outcome}: no tick after stop`)
	}
})
