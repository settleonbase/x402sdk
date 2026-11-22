/**
 * Child process of the tick-loop e2e: runs the REAL Lab payout reporter (E2E_REPORTER_ROOT: the patched checkout or the df78e6b baseline) like the daemon does, against the fake services named in
 * the environment. Nothing in the reporter is patched. Observation only:
 *  - the reporter's wait timer (TICK_MS, 15 000 ms, set from scheduleNextLabTick in df78e6b or from LabTickLoop in the patch) is replaced by E2E_WAIT_MS (default 20 ms; "real" = keep it) and every such wait is logged
 *    (E2E_EV wait-set requested=<ms> used=<ms>, E2E_EV wait-fired);
 *  - in the patched code LabTickLoop.prototype.runOnce is wrapped to log tick start / end and to count how many ticks run at once (E2E_EV tick-start|tick-end n=<k> running=<c>);
 *  - E2E_RUN_MS stops the child after that long like SIGTERM does (stop, wait for idle, flush), SIGTERM does the same at any time.
 * Events carry t=<ms since child start> from the child's own monotonic clock.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.E2E_REPORTER_ROOT
if (!root) throw new Error('E2E_REPORTER_ROOT is required')
const t0 = process.hrtime.bigint()
const now = (): number => Number((process.hrtime.bigint() - t0) / 1_000n) / 1000
const origLog = console.log.bind(console)
const ev = (s: string): void => origLog(`E2E_EV ${s} t=${now().toFixed(3)}`)
const realSetTimeout = global.setTimeout
const ANSI_RE = /\u001b\[[0-9;]*m/g
// phase marks (observation only): the reporter's own progress lines are timestamped here, in the child's clock, so a tick can be split into its phases (see the E2E_EV mark lines)
console.log = (...a: unknown[]): void => {
	const text = a.map((x) => String(x)).join(' ').replace(ANSI_RE, '')
	let kind: string | undefined
	let extra = ''
	if (text.includes('scan-summary line=realtime')) {
		kind = 'rt'
		extra = ` n=${/ n=(\d+)/.exec(text)?.[1] ?? '?'}`
	} else if (text.includes('scan-summary line=history')) {
		kind = 'hist'
		extra = ` n=${/ n=(\d+)/.exec(text)?.[1] ?? '?'}`
	} else if (text.includes('progress hist remaining=')) {
		kind = 'prog'
		extra = ` tipGap=${/rt tipGap=(\d+)/.exec(text)?.[1] ?? '?'} pending=${/pending=(\d+)/.exec(text)?.[1] ?? '?'}`
	} else if (text.includes('flush-summary')) kind = 'flush'
	else if (text.includes('flush inspect=')) kind = 'flush-inspect'
	if (kind) ev(`mark kind=${kind}${extra} ${ioStr()}`)
	origLog(...a)
}
// persistence evidence (observation only): the state store writes through fs.writeSync / fs.fsyncSync / fs.renameSync of the default fs object; bytes, calls and time are counted here, the reporter is not touched.
const ioStr = (): string => `io_wb=${io.writeBytes} io_wms=${io.writeMs.toFixed(1)} io_fms=${io.fsyncMs.toFixed(1)} io_mc=${io.manifestCommits}`
const io = { writeBytes: 0, writeCalls: 0, writeMs: 0, fsyncCalls: 0, fsyncMs: 0, manifestCommits: 0 }
{
	const w0 = fs.writeSync
	const f0 = fs.fsyncSync
	const r0 = fs.renameSync
	const ms = (a: bigint): number => Number(process.hrtime.bigint() - a) / 1e6
	;(fs as unknown as { writeSync: unknown }).writeSync = ((...a: unknown[]) => {
		const t = process.hrtime.bigint()
		const n = (w0 as (...x: unknown[]) => number)(...a)
		io.writeCalls++
		io.writeBytes += n
		io.writeMs += ms(t)
		return n
	}) as typeof fs.writeSync
	;(fs as unknown as { fsyncSync: unknown }).fsyncSync = ((...a: unknown[]) => {
		const t = process.hrtime.bigint()
		;(f0 as (...x: unknown[]) => void)(...a)
		io.fsyncCalls++
		io.fsyncMs += ms(t)
	}) as typeof fs.fsyncSync
	;(fs as unknown as { renameSync: unknown }).renameSync = ((a: string, b: string) => {
		if (String(b).endsWith('manifest.json')) io.manifestCommits++
		return r0(a, b)
	}) as typeof fs.renameSync
}
const waitMsRaw = process.env.E2E_WAIT_MS ?? '20'
let waits = 0
;(global as unknown as { setTimeout: unknown }).setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
	const stack = String(new Error().stack)
	if (typeof ms === 'number' && ms === Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS) && (stack.includes('scheduleNextLabTick') || stack.includes('LabTickLoop'))) {
		waits++
		const used = waitMsRaw === 'real' ? ms : Number(waitMsRaw)
		ev(`wait-set requested=${ms} used=${used} ${ioStr()}`)
		return realSetTimeout(() => {
			ev(`wait-fired ${ioStr()}`)
			fn(...a)
		}, used)
	}
	return realSetTimeout(fn, ms, ...a)
}) as typeof setTimeout

async function main(): Promise<void> {
	const rep = await import(pathToFileURL(path.join(root!, 'src/endpoint/validatorLabMiningPoolClPayoutReporter.ts')).href)
	const queue = await import(pathToFileURL(path.join(root!, 'src/onchainTxSerialQueue.ts')).href)
	let loopMod: { LabTickLoop?: { prototype: { runOnce: (g: number) => Promise<void> } } } | undefined
	try {
		loopMod = await import(pathToFileURL(path.join(root!, 'src/endpoint/labTickLoop.ts')).href)
	} catch {
		loopMod = undefined // df78e6b: no loop module
	}
	let running = 0
	let maxRunning = 0
	let ticks = 0
	if (loopMod?.LabTickLoop) {
		const proto = loopMod.LabTickLoop.prototype
		const orig = proto.runOnce
		proto.runOnce = async function (this: unknown, gen: number): Promise<void> {
			// runOnce returns early when the generation is stale; the daemon's tick function is awaited inside, so measure around the whole call but count only real ticks via the deps
			const loop = this as { d: { tick: () => Promise<string> } }
			const d = loop.d
			if (!(d as unknown as { __wrapped?: boolean }).__wrapped) {
				const inner = d.tick
				;(d as unknown as { __wrapped: boolean }).__wrapped = true
				d.tick = async () => {
					const n = ++ticks
					running++
					maxRunning = Math.max(maxRunning, running)
					ev(`tick-start n=${n} running=${running} ${ioStr()}`)
					try {
						const r = await inner()
						ev(`tick-end n=${n} outcome=${r} ${ioStr()}`)
						return r
					} finally {
						running--
					}
				}
			}
			return orig.call(this, gen)
		}
	}
	let shuttingDown = false
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		ev(`shutdown signal=${signal}`)
		console.log(`[e2e-child] ${signal}; draining`)
		rep.stopValidatorLabMiningPoolClPayoutReporter()
		ev('stopped')
		await rep.waitForLabMiningPoolClPayoutIdle(90_000)
		ev('idle')
		await rep.flushLabMiningPoolListeningCheckpoint()
		await queue.waitForAllOnchainTxQueues(90_000)
		const ru = process.resourceUsage()
		ev(`summary ticks=${ticks} maxRunning=${maxRunning} waits=${waits} cpuUserMs=${Math.round(ru.userCPUTime / 1000)} cpuSysMs=${Math.round(ru.systemCPUTime / 1000)} fsWriteBytes=${io.writeBytes} fsWriteCalls=${io.writeCalls} fsWriteMs=${io.writeMs.toFixed(1)} fsyncCalls=${io.fsyncCalls} fsyncMs=${io.fsyncMs.toFixed(1)} manifestCommits=${io.manifestCommits}`)
		process.exit(0)
	}
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
	if (process.env.E2E_RUN_MS) realSetTimeout(() => void shutdown('E2E_RUN_MS'), Number(process.env.E2E_RUN_MS))
	ev(`start ${ioStr()}`)
	rep.startValidatorLabMiningPoolClPayoutReporter()
	if (process.env.E2E_STOP_START_AT_MS) {
		realSetTimeout(() => {
			ev('stop-call')
			rep.stopValidatorLabMiningPoolClPayoutReporter()
			try {
				rep.startValidatorLabMiningPoolClPayoutReporter()
				ev('start-after-stop accepted')
			} catch (e) {
				ev(`start-after-stop refused ${(e as Error).message.slice(0, 60).replace(/\s+/g, '_')}`)
			}
		}, Number(process.env.E2E_STOP_START_AT_MS))
	}
}

main().catch((e) => {
	console.error(`[e2e-child] fatal: ${e instanceof Error ? e.stack : String(e)}`)
	process.exit(1)
})
