/**
 * Serial tick loop of the Lab CL payout daemon (owner decision 2026-11-21: no fixed wait after a working tick).
 *
 * Rules (each one has a test in labTickLoop.test.ts):
 *  - One loop, one tick at a time. A tick is awaited to the end (scan, payment handling, ledger persistence), then the loop yields once through setImmediate and starts the next tick
 *    when - and only when - the finished tick made progress. No timer re-entry, no second tick while one is running.
 *  - A tick that did nothing (idle), failed (fault) or was skipped (an earlier tick still in flight, fail-closed gate, manifest or tip unavailable) is followed by ONE wait of backoffMs()
 *    (the daemon passes TICK_MS: default 60 s, the same wait it had before for every tick). So idle and persistent faults cost exactly what they cost before; only working ticks lose the wait.
 *  - stop() makes the loop non-re-arming before anything else: it invalidates the generation, clears a pending immediate or timer and returns. A tick that is running when stop() is called
 *    finishes and does not re-arm. start() after stop() opens a new generation; the old generation can never re-arm, so two loops cannot exist. start() on a running loop does nothing.
 *  - The tick function must never run two instances at once (the daemon's labInFlight guard stays); if it reports 'skipped' the loop backs off, it never re-arms immediately.
 */
export type LabTickOutcome = 'progress' | 'idle' | 'fault' | 'skipped'

export type LabTickLoopDeps = {
	/** One full tick. Resolves with what it did; a rejection counts as 'fault'. */
	tick: () => Promise<LabTickOutcome>
	/** Wait after a tick that did not make progress (re-read on every use so a configuration change is honoured). */
	backoffMs: () => number
	/**
	 * Optional switch (default: continuous). When it returns false the loop behaves like the daemon before this loop existed: ONE wait of backoffMs() after EVERY tick, a working tick included.
	 * The daemon reads CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MODE (fixed | continuous, default fixed - the continuous mode is the "cancel the fixed wait" patch, held by the owner's decision 2026-11-22).
	 */
	continuous?: () => boolean
	/** Timer seams (tests). Defaults are the platform functions. */
	setImmediate?: (fn: () => void) => unknown
	clearImmediate?: (h: unknown) => void
	setTimeout?: (fn: () => void, ms: number) => unknown
	clearTimeout?: (h: unknown) => void
	/** Called once per scheduling decision (observability and tests). */
	onSchedule?: (e: { generation: number; outcome: LabTickOutcome; mode: 'immediate' | 'backoff'; delayMs: number }) => void
}

export class LabTickLoop {
	private generation = 0
	private active = false
	private inFlight = 0
	private handle: { kind: 'immediate' | 'timeout'; h: unknown } | undefined
	private readonly d: Required<Omit<LabTickLoopDeps, 'onSchedule'>> & Pick<LabTickLoopDeps, 'onSchedule'>

	constructor(deps: LabTickLoopDeps) {
		this.d = {
			tick: deps.tick,
			backoffMs: deps.backoffMs,
			continuous: deps.continuous ?? (() => true),
			setImmediate: deps.setImmediate ?? ((fn) => setImmediate(fn)),
			clearImmediate: deps.clearImmediate ?? ((h) => clearImmediate(h as NodeJS.Immediate)),
			setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
			clearTimeout: deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
			onSchedule: deps.onSchedule,
		}
	}

	isActive(): boolean {
		return this.active
	}

	/** True while a tick started by this loop has not finished. */
	isRunning(): boolean {
		return this.inFlight > 0
	}

	/** Starts the loop and runs the first tick at once. Returns false (and does nothing) when a loop is already active. */
	start(): boolean {
		if (this.active) return false
		this.active = true
		const gen = ++this.generation
		void this.runOnce(gen)
		return true
	}

	/** No further tick will be started. A tick that is running now finishes (see isRunning) and does not re-arm. */
	stop(): void {
		this.active = false
		this.generation++
		this.clearHandle()
	}

	private clearHandle(): void {
		const h = this.handle
		this.handle = undefined
		if (!h) return
		if (h.kind === 'immediate') this.d.clearImmediate(h.h)
		else this.d.clearTimeout(h.h)
	}

	private current(gen: number): boolean {
		return this.active && gen === this.generation
	}

	private async runOnce(gen: number): Promise<void> {
		if (!this.current(gen)) return
		// an old generation's tick may still be running after stop() + start(): the daemon's labInFlight guard turns the new generation's first tick into 'skipped' (a backoff), never a parallel tick
		this.inFlight++
		let outcome: LabTickOutcome
		try {
			outcome = await this.d.tick()
		} catch {
			outcome = 'fault'
		} finally {
			this.inFlight--
		}
		if (!this.current(gen)) return
		this.arm(gen, outcome)
	}

	private arm(gen: number, outcome: LabTickOutcome): void {
		const again = (): void => {
			this.handle = undefined
			if (!this.current(gen)) return
			void this.runOnce(gen)
		}
		if (outcome === 'progress' && this.d.continuous()) {
			this.d.onSchedule?.({ generation: gen, outcome, mode: 'immediate', delayMs: 0 })
			this.handle = { kind: 'immediate', h: this.d.setImmediate(again) }
			return
		}
		const delayMs = this.d.backoffMs()
		this.d.onSchedule?.({ generation: gen, outcome, mode: 'backoff', delayMs })
		this.handle = { kind: 'timeout', h: this.d.setTimeout(again, delayMs) }
	}
}

/**
 * TICK_MODE (CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MODE): `fixed` (default, unset = fixed) waits TICK_MS after EVERY tick, exactly like the daemon before the continuous loop; `continuous` is the
 * "cancel the fixed wait" patch (a working tick is followed at once; owner decision 2026-11-22: held, not part of a deployment unless the owner enables it). Anything else refuses the start.
 */
export function parseTickMode(raw: string | undefined): 'fixed' | 'continuous' {
	const v = raw?.trim()
	if (v === undefined || v === '' || v === 'fixed') return 'fixed'
	if (v === 'continuous') return 'continuous'
	throw new Error(`[labMiningPoolClPayout] CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MODE must be "fixed" or "continuous" (default fixed); got "${v.slice(0, 40)}"`)
}
