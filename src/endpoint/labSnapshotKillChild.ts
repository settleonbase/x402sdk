/**
 * Test support for labSnapshotKill.test.ts (real process kill -9, errata W7): the whole WAL-mode stack in one process - recovery on start, deterministic events through the core, a
 * cooperative snapshot cycle (write, merge, truncate) running in the background every <every> events while events keep arriving. "durable <seq>" is printed only after the fsync that
 * made the event durable. The parent kills it with SIGKILL at a random moment and recovers the state directory.
 * Usage: node --import tsx labSnapshotKillChild.ts <stateDir> <seed> <segmentBytes> <every>
 */
import { inspectSegmentedDir } from './labClPayoutStateStore'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WalWriter } from './labWal'
import { opsForSeq } from './labWalKillChild'

async function main(): Promise<void> {
	const [stateDir, seedRaw, segRaw, everyRaw] = process.argv.slice(2)
	if (!stateDir) throw new Error('usage: labSnapshotKillChild <stateDir> <seed> <segmentBytes> <every>')
	const seed = Number(seedRaw ?? 1)
	const segmentBytes = Number(segRaw ?? 2048)
	const every = Number(everyRaw ?? 40)
	let core: LabPayoutStateCore
	let wal: WalWriter
	if (inspectSegmentedDir(stateDir) === 'committed') {
		const rec = recoverPayoutState(stateDir)
		if (rec.warnings.length > 0) throw new Error(`recovery warnings: ${rec.warnings.join('; ')}`)
		core = rec.core
		wal = new WalWriter({ stateDir, lastSeq: rec.writerLastSeq, segmentBytes })
		process.stdout.write(`recovered ${rec.core.lastAppliedSeq} snapshot=${rec.snapshotSeq} replayed=${rec.replayed} cleaned=${rec.cleanedSegments.length}\n`)
	} else {
		core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
		const src = core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
		core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes })
	}
	let snap: Promise<void> | null = null
	let sinceSnap = 0
	const runCycle = async (): Promise<void> => {
		const src = core.freezeForSnapshot()
		try {
			const res = await writeSnapshotCooperative(src, {
				dir: stateDir,
				mode: 'wal',
				sliceMs: 0,
				segmentSize: 50,
				waitDurable: (seq) => wal.whenDurable(seq),
			})
			core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
			wal.truncateThrough(src.walSeq)
		} catch (e) {
			core.finishSnapshot(src, { committed: false })
			throw e
		}
	}
	for (;;) {
		const batch = []
		for (let i = 0; i < 3; i++) {
			const seq = wal.lastSeq + 1
			batch.push(core.record(wal, 't', opsForSeq(seed, seq)))
		}
		sinceSnap += 3
		if (sinceSnap >= every && snap === null) {
			sinceSnap = 0
			snap = runCycle().finally(() => {
				snap = null
			})
			snap.catch((e) => {
				process.stderr.write(`snapshot error: ${e instanceof Error ? e.message : String(e)}\n`)
				process.exit(1)
			})
		}
		await Promise.all(batch.map((b) => b.durable))
		process.stdout.write(`durable ${batch[batch.length - 1]!.seq}\n`)
	}
}

if (require.main === module) {
	main().catch((e) => {
		process.stderr.write(`child error: ${e instanceof Error ? e.message : String(e)}\n`)
		process.exit(1)
	})
}
