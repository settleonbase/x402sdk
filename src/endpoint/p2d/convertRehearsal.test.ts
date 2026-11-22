/**
 * Heap rehearsal of the v2 -> WAL conversion and the WAL run (merged candidate): ONE child process, started by the caller with the production heap flag
 * (`node --max-old-space-size=1536 --expose-gc --import tsx convertRehearsal.test.ts <v2 state dir> <result.json>`), on a synthetic ledger from genState (P0 or B2 shape, form v2). Phases, each with the highest
 * heapUsed / RSS sampled every 25 ms and the live heap after a forced GC: convert (openWalSession: v2 read + v3 snapshot before the first event), run (scan and wallet actors committing at the field's rates),
 * snapshot (a cooperative snapshot with commits going on: the layered overlay), stop (the graceful downgrade to v2). A V8 abort (SIGABRT) or a failure is the result: the cell failed at this limit.
 * Registered as a test only under the runner (a plain child that runs this file as a script does the work); no network, no keys.
 */
import fs from 'node:fs'
import v8 from 'node:v8'
import { test } from 'node:test'
import { ActorHub } from '../labActorHandle'
import { gracefulStopToV2 } from '../labPayoutRecovery'
import { writeSnapshotCooperative } from '../labSnapshotWriter'
import { openWalSession } from '../labWalSession'

type Phase = { name: string; ms: number; maxHeapUsedMiB: number; maxRssMiB: number; liveHeapAfterGcMiB: number | null; heapLimitMiB: number }
const MIB = 1024 * 1024
declare const gc: undefined | (() => void)

export async function rehearse(stateDir: string, out: string): Promise<void> {
	const phases: Phase[] = []
	let maxH = 0
	let maxR = 0
	const timer = setInterval(() => {
		const m = process.memoryUsage()
		maxH = Math.max(maxH, m.heapUsed)
		maxR = Math.max(maxR, m.rss)
	}, 25)
	const endPhase = (name: string, t0: number, gcAfter = true): void => {
		let live: number | null = null
		if (gcAfter && typeof gc === 'function') {
			gc()
			live = Math.round(process.memoryUsage().heapUsed / MIB)
		}
		phases.push({ name, ms: Date.now() - t0, maxHeapUsedMiB: Math.round(maxH / MIB), maxRssMiB: Math.round(maxR / MIB), liveHeapAfterGcMiB: live, heapLimitMiB: Math.round(v8.getHeapStatistics().heap_size_limit / MIB) })
		maxH = process.memoryUsage().heapUsed
		maxR = process.memoryUsage().rss
		fs.writeFileSync(out, JSON.stringify({ phases, done: false }, null, 1))
	}
	try {
		let t = Date.now()
		const session = await openWalSession({ stateDir, legacyStateFile: '/nonexistent.json', scanFloor: 1, log: () => undefined })
		endPhase('convert (v2 read + v3 snapshot before the first event)', t)
		const hub = new ActorHub<never, Record<string, unknown>>({ core: session.core, wal: session.wal })
		void hub
		// the run: the scan actor adds 512 entries per "tick" and three wallets settle 100-entry batches, 40 rounds (the field does about 20 ticks and 30-40 batches an hour; this is a burst)
		t = Date.now()
		const scan = session.hub.actor('scan')
		const wallets = ['w1', 'w2', 'w3'].map((w) => session.hub.actor(`pay:${w}`))
		let k = 0
		for (let round = 0; round < 40; round++) {
			scan.pendingAdd(Array.from({ length: 512 }, (_, i) => ({ eventKey: '0x' + (0xabc00000000 + k++).toString(16).padStart(64, '0'), amount: '1000000000000000', blockNumber: 2_100_000 + round, withdrawalIndex: i, pubkey: '0x' + 'ab'.repeat(48) }) as never))
			await scan.commit('scan')
			for (const [wi, w] of wallets.entries()) {
				const batch = [...w.pendingValues()].slice(wi * 100, wi * 100 + 100)
				for (const e of batch) {
					w.pendingDel(e.eventKey)
					w.consumedAdd(e.eventKey)
				}
				w.incScalar('settledBatchCount', 1)
				await w.commit('settle')
			}
		}
		endPhase('run (40 scan commits of 512 entries + 120 settle batches of up to 100)', t)
		// a cooperative snapshot while commits continue (the overlay grows)
		t = Date.now()
		const src = session.core.freezeForSnapshot()
		let running = true
		const committer = (async () => {
			while (running) {
				scan.pendingAdd(Array.from({ length: 512 }, (_, i) => ({ eventKey: '0x' + (0xdef00000000 + k++).toString(16).padStart(64, '0'), amount: '1', blockNumber: 2_200_000, withdrawalIndex: i, pubkey: '0x' + 'cd'.repeat(48) }) as never))
				await scan.commit('scan')
				await new Promise((r) => setTimeout(r, 5))
			}
		})()
		const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal', waitDurable: (s) => session.wal.whenDurable(s) })
		running = false
		await committer
		session.core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		endPhase('snapshot with commits going on', t)
		// settle everything in flight and stop gracefully (the downgrade snapshot)
		t = Date.now()
		await session.scheduler.stop()
		await session.wal.whenDurable(session.wal.lastSeq)
		await gracefulStopToV2(session.core, session.wal, stateDir)
		endPhase('graceful stop (version 2 downgrade snapshot)', t)
		fs.writeFileSync(out, JSON.stringify({ phases, done: true, finalPending: session.core.pendingSize, finalConsumed: session.core.consumedSize }, null, 1))
	} finally {
		clearInterval(timer)
	}
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
	const [dir, out] = process.argv.slice(2)
	if (!dir || !out) {
		console.error('usage: node --max-old-space-size=1536 --expose-gc --import tsx convertRehearsal.test.ts <v2 state dir> <result.json>')
		process.exit(2)
	}
	rehearse(dir, out).then(
		() => process.exit(0),
		(e) => {
			fs.writeFileSync(out, JSON.stringify({ failed: String(e && (e as Error).stack ? (e as Error).stack : e) }, null, 1))
			process.exit(1)
		}
	)
}
if (process.env.NODE_TEST_CONTEXT) test('convertRehearsal is a script (no unit test here)', () => undefined)
