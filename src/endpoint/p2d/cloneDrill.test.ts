/**
 * Clone drill of the WAL migration on a COPY of the production ledger (APFS clone-of-clone, never the original): one subject step per child process under the production heap flag
 * (`--max-old-space-size=1536 --expose-gc`), the digests in separate checker processes with a large heap (the subject's heap is what is measured). No network, no keys, no signer.
 *   digest <dir> <out.json>               read-only: counts + sha256 of the canonical logical state (recoverPayoutState readOnly + labWalRollback.logicalDigest) - works for v2 and v3+log
 *   convert-stop <dir> <out.json>         openWalSession (v2 -> v3 snapshot before the first event) then gracefulStopWalSession (the downgrade to v2); phases timed, heap/RSS sampled, exit code of the stop
 *   commits-kill <dir> <killAt> <log>     open (convert), then commit 512-entry scan events; every acknowledged commit is appended to <log>; at <killAt> a commit is started and the process SIGKILLs itself at once
 *   recover <dir> <out.json>              open the session (replays the log), record timing/heap/counts, close WITHOUT the downgrade (the log stays)
 * Registered as a test only under the runner (a plain child runs this file as a script).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import v8 from 'node:v8'
import { test } from 'node:test'
import { gracefulStopToV2, recoverPayoutState } from '../labPayoutRecovery'
import { gracefulStopWalSession, openWalSession } from '../labWalSession'
import { digestPartsOfCore } from '../labWalRollback'

const MIB = 1024 * 1024
declare const gc: undefined | (() => void)
type Phase = { name: string; ms: number; maxHeapUsedMiB: number; maxRssMiB: number; liveHeapAfterGcMiB: number | null; heapLimitMiB: number }

function sampler(): { end: (name: string, t0: number) => Phase; stop: () => void } {
	let maxH = 0
	let maxR = 0
	const timer = setInterval(() => {
		const m = process.memoryUsage()
		maxH = Math.max(maxH, m.heapUsed)
		maxR = Math.max(maxR, m.rss)
	}, 25)
	return {
		end(name, t0) {
			let live: number | null = null
			if (typeof gc === 'function') {
				gc()
				live = Math.round(process.memoryUsage().heapUsed / MIB)
			}
			const p: Phase = { name, ms: Date.now() - t0, maxHeapUsedMiB: Math.round(maxH / MIB), maxRssMiB: Math.round(maxR / MIB), liveHeapAfterGcMiB: live, heapLimitMiB: Math.round(v8.getHeapStatistics().heap_size_limit / MIB) }
			maxH = process.memoryUsage().heapUsed
			maxR = process.memoryUsage().rss
			return p
		},
		stop: () => clearInterval(timer),
	}
}
const entry = (n: number, i: number): never => ({ eventKey: '0x' + (0xd1100000000 + n).toString(16).padStart(64, '0'), amount: '1000000000000000', blockNumber: 2_300_000 + Math.floor(n / 512), withdrawalIndex: i, pubkey: '0x' + 'ee'.repeat(48) }) as never

async function main(): Promise<void> {
	const [mode, dir, a3, a4] = process.argv.slice(2)
	if (!mode || !dir) throw new Error('usage: cloneDrill.test.ts <digest|convert-stop|commits-kill|recover> <dir> ...')
	if (mode === 'digest') {
		const t0 = Date.now()
		const rec = recoverPayoutState(dir, { readOnly: true })
		const dp = digestPartsOfCore(rec.core) // streaming: also where JSON.stringify of the whole list would exceed V8's string limit (B2)
		const d = dp.full
		const sc = rec.core.scalarsCopy() as Record<string, unknown>
		delete sc.walSeq
		const parts = { scalars: sc, inFlight: dp.inFlight, pending: dp.pendingEntries, consumed: dp.consumedOrder, exited: dp.exited }
		fs.writeFileSync(a3!, JSON.stringify({ mode, ms: Date.now() - t0, pending: rec.core.pendingSize, consumed: rec.core.consumedSize, slotCount: rec.core.slotCount, logicalSha256: d, parts }, null, 1))
		return
	}
	if (mode === 'convert-stop') {
		const s = sampler()
		const phases: Phase[] = []
		let t = Date.now()
		const session = await openWalSession({ stateDir: dir, legacyStateFile: '/nonexistent.json', scanFloor: 1, log: (l) => console.error(l) })
		phases.push(s.end('open: v2 read + v3 snapshot before the first event', t))
		t = Date.now()
		const code = await gracefulStopWalSession(session, { stateDir: dir, tickIdle: true, log: (l) => console.error(l) })
		phases.push(s.end('graceful stop (downgrade to v2)', t))
		s.stop()
		fs.writeFileSync(a3!, JSON.stringify({ mode, phases, gracefulStopExitCode: code }, null, 1))
		process.exitCode = code
		return
	}
	if (mode === 'commits-kill') {
		const killAt = Number(a3)
		const log = a4!
		const session = await openWalSession({ stateDir: dir, legacyStateFile: '/nonexistent.json', scanFloor: 1, log: (l) => console.error(l) })
		const base = session.core.pendingSize
		fs.writeFileSync(log, `base ${base}\n`)
		const scan = session.hub.actor('scan')
		for (let k = 1; ; k++) {
			scan.pendingAdd(Array.from({ length: 512 }, (_, i) => entry((k - 1) * 512 + i, i)))
			if (k === killAt) {
				void scan.commit('scan')
				process.kill(process.pid, 'SIGKILL')
				await new Promise((r) => setTimeout(r, 60_000))
			}
			await scan.commit('scan')
			fs.appendFileSync(log, `acked ${k}\n`)
		}
	}
	if (mode === 'recover') {
		const s = sampler()
		const t0 = Date.now()
		const logs: string[] = []
		const session = await openWalSession({ stateDir: dir, legacyStateFile: '/nonexistent.json', scanFloor: 1, log: (l) => logs.push(l) })
		const ph = s.end('open: recover (snapshot + log replay)', t0)
		s.stop()
		const out = { mode, phase: ph, pending: session.core.pendingSize, consumed: session.core.consumedSize, slotCount: session.core.slotCount, startLines: logs.filter((l) => /WAL mode|replayed/.test(l)).map((l) => l.replace(/\u001b\[[0-9;]*m/g, '')) }
		await session.scheduler.stop()
		await session.wal.whenDurable(session.wal.lastSeq)
		await session.wal.close()
		fs.writeFileSync(a3!, JSON.stringify(out, null, 1))
		return
	}
	throw new Error(`unknown mode ${mode}`)
}
void gracefulStopToV2

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
	main().then(
		() => process.exit(process.exitCode ?? 0),
		(e) => {
			console.error(String(e && (e as Error).stack ? (e as Error).stack : e))
			process.exit(1)
		}
	)
}
if (process.env.NODE_TEST_CONTEXT) test('cloneDrill is a script (no unit test here)', () => undefined)
