/**
 * P2c-0 fixture: the child process that runs the REAL Lab payout reporter (the code under test, loaded from E2E_REPORTER_ROOT) exactly like the daemon does, against the fake services named in
 * the environment. Time compression only: the tick timer (15 s .. 60 s) fires after 20 ms, and after E2E_TICKS ticks the child shuts down like the daemon does on SIGTERM.
 * Nothing in the reporter is patched; only the global setTimeout used by its scheduler is wrapped here, in this test child.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.E2E_REPORTER_ROOT
if (!root) throw new Error('E2E_REPORTER_ROOT is required')
const ticks = Number(process.env.E2E_TICKS ?? 1)
const realSetTimeout = global.setTimeout
let scheduledTicks = 0
let finish: () => void = () => undefined
;(global as unknown as { setTimeout: unknown }).setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
	if (typeof ms === 'number' && ms === 15_000 && String(new Error().stack).includes('scheduleNextLabTick')) {
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
	let shuttingDown = false
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		console.log(`[e2e-child] ${signal}; draining`)
		rep.stopValidatorLabMiningPoolClPayoutReporter()
		await rep.waitForLabMiningPoolClPayoutIdle(90_000)
		await rep.flushLabMiningPoolListeningCheckpoint()
		await queue.waitForAllOnchainTxQueues(90_000)
		process.exit(0)
	}
	finish = () => void shutdown('E2E_DONE')
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
	rep.startValidatorLabMiningPoolClPayoutReporter()
}

main().catch((e) => {
	console.error(`[e2e-child] fatal: ${e instanceof Error ? e.stack : String(e)}`)
	process.exit(1)
})
