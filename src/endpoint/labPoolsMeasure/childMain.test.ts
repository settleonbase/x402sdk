/**
 * Child process of the pool measurements: the REAL reporter (pool mode) like the daemon runs it, against the fake services in the environment. Observation only, nothing in the reporter is patched:
 *  - the scan tick's wait timer (TICK_MS, 15 000 ms, set from scheduleNextLabTick) is replaced by E2E_WAIT_MS (default 20 ms; "real" keeps it) and logged (E2E_EV wait-set / wait-fired);
 *  - the reporter's own progress lines are timestamped in the child's clock (E2E_EV mark kind=rt|hist|prog|flush ...), with the numbers a measurement needs (window size, paused flag, tipGap, pending);
 *  - E2E_RUN_MS stops the child after that long like SIGTERM (stop, wait for idle, flush); the summary line carries CPU time.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.E2E_REPORTER_ROOT
if (!root) throw new Error('E2E_REPORTER_ROOT is required')
const t0 = process.hrtime.bigint()
const now = (): number => Number((process.hrtime.bigint() - t0) / 1_000n) / 1000
const origLog = console.log.bind(console)
const ev = (s: string): void => origLog(`E2E_EV ${s} t=${now().toFixed(3)}`)
const realSetTimeout = global.setTimeout
const waitMsRaw = process.env.E2E_WAIT_MS ?? '20'
const ANSI_RE = /\u001b\[[0-9;]*m/g
console.log = (...a: unknown[]): void => {
	const text = a.map((x) => String(x)).join(' ').replace(ANSI_RE, '')
	let extra = ''
	let kind: string | undefined
	if (text.includes('scan-summary line=realtime')) {
		kind = 'rt'
		extra = ` n=${/ n=(\d+)/.exec(text)?.[1] ?? '?'} paused=${/paused=(\d)/.exec(text)?.[1] ?? '0'}`
	} else if (text.includes('scan-summary line=history')) {
		kind = 'hist'
		extra = ` n=${/ n=(\d+)/.exec(text)?.[1] ?? '?'} paused=${/paused=(\d)/.exec(text)?.[1] ?? '0'}`
	} else if (text.includes('progress hist remaining=')) {
		kind = 'prog'
		extra = ` tipGap=${/rt tipGap=(\d+)/.exec(text)?.[1] ?? '?'} pending=${/pending=(\d+)/.exec(text)?.[1] ?? '?'}`
	} else if (text.includes('withdrawNative ok')) kind = 'settled'
	if (kind) ev(`mark kind=${kind}${extra}`)
	origLog(...a)
}
;(global as unknown as { setTimeout: unknown }).setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
	if (typeof ms === 'number' && ms === Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS) && /scheduleNextLabTick|LabTickLoop/.test(String(new Error().stack))) {
		const used = waitMsRaw === 'real' ? ms : Number(waitMsRaw)
		ev(`wait-set requested=${ms} used=${used}`)
		return realSetTimeout(() => {
			ev('wait-fired')
			fn(...a)
		}, used)
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
		ev(`shutdown signal=${signal}`)
		const code = await rep.shutdownLabMiningPoolClPayout(Number(process.env.E2E_SHUTDOWN_WAIT_MS ?? 90_000))
		await queue.waitForAllOnchainTxQueues(90_000)
		const ru = process.resourceUsage()
		ev(`summary exit=${code} cpuUserMs=${Math.round(ru.userCPUTime / 1000)} cpuSysMs=${Math.round(ru.systemCPUTime / 1000)}`)
		process.exit(code)
	}
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
	if (process.env.E2E_RUN_MS) realSetTimeout(() => void shutdown('E2E_RUN_MS'), Number(process.env.E2E_RUN_MS))
	ev('start')
	rep.startValidatorLabMiningPoolClPayoutReporter()
}

main().catch((e) => {
	console.error(`[e2e-child] fatal: ${e instanceof Error ? e.stack : String(e)}`)
	process.exit(1)
})
