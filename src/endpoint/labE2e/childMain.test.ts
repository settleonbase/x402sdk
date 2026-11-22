/**
 * P2c-0 fixture: the child process that runs the REAL Lab payout reporter (the code under test, loaded from E2E_REPORTER_ROOT) exactly like the daemon does, against the fake services named in
 * the environment. Time compression only: the tick timer (15 s .. 60 s) fires after 20 ms, and after E2E_TICKS ticks the child shuts down like the daemon does on SIGTERM.
 * Nothing in the reporter is patched; only the global setTimeout used by its scheduler is wrapped here, in this test child.
 */
import path from 'node:path'
import v8 from 'node:v8'
import { pathToFileURL } from 'node:url'

const root = process.env.E2E_REPORTER_ROOT
if (!root) throw new Error('E2E_REPORTER_ROOT is required')
const ticks = Number(process.env.E2E_TICKS ?? 1)
const realSetTimeout = global.setTimeout
let scheduledTicks = 0
let finish: () => void = () => undefined
// P2d memory evidence (opt-in, E2E_TRACE_GC=1): V8's own GC log (--trace-gc, switched on at run time) and a heap sample every 25 ms tagged with the tick counter; the reporter under test is not touched.
if (process.env.E2E_TRACE_GC) {
	v8.setFlagsFromString('--trace-gc')
	const t0 = process.hrtime.bigint()
	setInterval(() => {
		const m = process.memoryUsage()
		console.log(`E2E_HEAP t=${Number((process.hrtime.bigint() - t0) / 1_000_000n)} used=${m.heapUsed} rss=${m.rss} ticks=${scheduledTicks}`)
	}, 25).unref()
}
;(global as unknown as { setTimeout: unknown }).setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
	if (typeof ms === 'number' && ms === 15_000 && /scheduleNextLabTick|LabTickLoop/.test(String(new Error().stack))) {
		scheduledTicks++
		if (scheduledTicks >= ticks) return realSetTimeout(() => finish(), 20)
		// before every scheduled tick the child asks the fake chain (plain HTTP) to move its head to this tick's value
		return realSetTimeout(() => {
			void fetch(`${process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL}/e2e/tick`)
				.catch(() => undefined)
				.then(() => fn(...a))
		}, 20)
	}
	return realSetTimeout(fn, ms, ...a)
}) as typeof setTimeout

async function main(): Promise<void> {
	const rep = await import(pathToFileURL(path.join(root!, 'src/endpoint/validatorLabMiningPoolClPayoutReporter.ts')).href)
	const queue = await import(pathToFileURL(path.join(root!, 'src/onchainTxSerialQueue.ts')).href)
	// Legacy pacing for the fixture (P2c-0 scenarios drive the chain head per scheduled tick): since the cancel-the-fixed-wait patch a tick that made progress is followed at once, with no timer and so
	// no head step. The scenarios keep their meaning if EVERY tick is followed by the (compressed) wait, so the loop's tick function is wrapped here, in the test child only, to report 'idle'. The reporter's
	// own behaviour (continuous ticks) is tested in labTickE2e and labTickLoop.test.ts.
	if (!process.env.E2E_CONTINUOUS_TICKS) {
		try {
			const loopMod = await import(pathToFileURL(path.join(root!, 'src/endpoint/labTickLoop.ts')).href)
			const proto = loopMod.LabTickLoop?.prototype as { runOnce: (g: number) => Promise<void> } | undefined
			if (proto) {
				const orig = proto.runOnce
				proto.runOnce = async function (this: unknown, gen: number): Promise<void> {
					const d = (this as { d: { tick: () => Promise<string>; __legacy?: boolean } }).d
					if (!d.__legacy) {
						d.__legacy = true
						const inner = d.tick
						d.tick = async () => {
							await inner()
							return 'idle'
						}
					}
					return orig.call(this, gen)
				}
			}
		} catch {
			/* a checkout without the loop module (df78e6b baselines): nothing to wrap */
		}
	}
	let shuttingDown = false
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		console.log(`[e2e-child] ${signal}; draining`)
		// decoupled mode (test only): the payment worker runs on its own clock, so after the last scan tick give it time to pay what the scan queued (state read through the same recovery the daemon uses; bounded)
		if (process.env.E2E_DRAIN_PENDING && signal === 'E2E_DONE') {
			const rcv = await import(pathToFileURL(path.join(root!, 'src/endpoint/labPayoutRecovery.ts')).href)
			const stateDir = String(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE).replace(/\.json$/, '.v2')
			const t0 = Date.now()
			let quiet = 0
			while (Date.now() - t0 < 45_000 && quiet < 3) {
				await new Promise((r) => realSetTimeout(r, 150))
				try {
					const c = rcv.recoverPayoutState(stateDir, { readOnly: true }).core
					quiet = c.pendingSize === 0 && c.getInFlight() === null ? quiet + 1 : 0
				} catch {
					quiet = 0
				}
			}
		}
		if (process.env.E2E_TRACE_GC) console.log(`E2E_MEM maxRssBytes=${process.resourceUsage().maxRSS * 1024} heapLimit=${v8.getHeapStatistics().heap_size_limit}`)
		console.log(`[e2e-child] compressed=${scheduledTicks} requested=${ticks}`)
		let code = 0
		if (typeof rep.shutdownLabMiningPoolClPayout === 'function') code = await rep.shutdownLabMiningPoolClPayout(Number(process.env.E2E_SHUTDOWN_WAIT_MS ?? 90_000))
		else {
			// older checkouts (the P1 / df78e6b baselines the goldens are cross-checked against) have no combined shutdown: the same three steps the daemon used then
			rep.stopValidatorLabMiningPoolClPayoutReporter()
			await rep.waitForLabMiningPoolClPayoutIdle(90_000)
			await rep.flushLabMiningPoolListeningCheckpoint()
		}
		await queue.waitForAllOnchainTxQueues(90_000)
		process.exit(code)
	}
	finish = () => void shutdown('E2E_DONE')
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
	rep.startValidatorLabMiningPoolClPayoutReporter()
}

main().catch((e) => {
	console.error(`[e2e-child] fatal: ${e instanceof Error ? e.stack : String(e)}`)
	process.exit(1)
})
