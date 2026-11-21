/**
 * P2b-2: recovery, the crash matrix for the snapshot cycle, the graceful stop to version 2 (V5a, Y1), and the P1 guard interplay. Real files in temp dirs; the "crash" abandons the
 * in-memory objects and recovers from what is on disk.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readManifest, readSegmentedState, writeSegmentedState } from './labClPayoutStateStore'
import { Model, modelView, view } from './labPayoutTestSupport'
import { opsForSeq } from './labWalKillChild'
import { LabPayoutStateCore, type PendingEntry } from './labPayoutStateCore'
import { gracefulStopToV2, postReplayChecks, recoverOrRefuse, recoverPayoutState } from './labPayoutRecovery'
import { repairMidCorruption } from './labWalRepair'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WAL_DIR, WalMidCorruptionError, WalWriter, listSegments, segmentFileName, type WalOp } from './labWal'
import { assertNoWalEvents } from './labWalGuard'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'labrecov-'))
const done = (d: string): void => fs.rmSync(d, { recursive: true, force: true })
const noFatal = (e: Error): void => {
	throw e
}

type Sim = { dir: string; seed: number; core: LabPayoutStateCore; wal: WalWriter; model: Model; segmentBytes: number }

async function bootstrap(dir: string, seed: number, segmentBytes = 700): Promise<Sim> {
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
	const model = new Model()
	model.setScalar('freezeH', { height: 500 })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir: dir, lastSeq: 0, segmentBytes, onFatal: noFatal })
	return { dir, seed, core, wal, model, segmentBytes }
}

/** Append n events through the core (memory first, then the log), mirror them in the model; resolves when all are durable. */
async function emit(sim: Sim, n: number, ack = true): Promise<void> {
	const ps: Promise<void>[] = []
	for (let i = 0; i < n; i++) {
		const seq = sim.wal.lastSeq + 1
		const ops = opsForSeq(sim.seed, seq)
		const r = sim.core.record(sim.wal, 't', ops)
		assert.equal(r.seq, seq)
		sim.model.apply(ops)
		ps.push(r.durable)
	}
	if (ack) await Promise.all(ps)
}

/** A full snapshot cycle. `stopAfter` abandons the cycle at that step (a crash there). */
type Step = 'files' | 'commit' | 'merge' | 'partial-truncate' | 'truncate'
async function cycle(sim: Sim, stopAfter: Step = 'truncate', duringSnapshot?: () => Promise<void>, faults: { beforeCommit?: () => void; beforeManifestRename?: () => void } = {}): Promise<void> {
	const src = sim.core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, {
		dir: sim.dir,
		mode: 'wal',
		sliceMs: 0,
		yieldFn: async () => {
			if (duringSnapshot) await duringSnapshot()
			await new Promise<void>((r) => setImmediate(r))
		},
		waitDurable: (seq) => sim.wal.whenDurable(seq),
		hooks: faults,
	})
	if (stopAfter === 'commit') return
	sim.core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
	if (stopAfter === 'merge') return
	if (stopAfter === 'partial-truncate') {
		// remove only the oldest fully covered segment (the truncation was interrupted after the first unlink)
		const segs = listSegments(path.join(sim.dir, WAL_DIR))
		const covered = segs.filter((s, i) => (i + 1 < segs.length ? segs[i + 1]!.firstSeq - 1 : sim.wal.lastSeq) <= src.walSeq)
		if (covered.length > 0) fs.unlinkSync(path.join(sim.dir, WAL_DIR, covered[0]!.file))
		return
	}
	sim.wal.truncateThrough(src.walSeq)
}

async function crashAndRecover(sim: Sim): Promise<Sim> {
	await sim.wal.close() // abandon: nothing is flushed that was not already queued and fsynced; the in-memory state is dropped
	const rec = recoverPayoutState(sim.dir)
	assert.equal(view(rec.core), modelView(sim.model), 'recovered state equals the reference')
	assert.deepEqual(rec.warnings, [])
	assert.equal(rec.core.counts.driftEvents, 0)
	const wal = new WalWriter({ stateDir: sim.dir, lastSeq: rec.writerLastSeq, segmentBytes: sim.segmentBytes, onFatal: noFatal })
	assert.equal(rec.writerLastSeq, rec.core.lastAppliedSeq, 'the log and the memory continue from the same seq')
	return { ...sim, core: rec.core, wal }
}

// ------------------------------------------------------------------ plain recovery
test('recovery: snapshot + log equals the reference; only events after the snapshot are replayed; a v3 snapshot at walSeq is the replay base', async () => {
	const dir = tmp()
	try {
		const sim = await bootstrap(dir, 7)
		await emit(sim, 40)
		await cycle(sim)
		const m = readManifest(dir)
		assert.equal(m.version, 3)
		assert.equal(m.walSeq, 40)
		await emit(sim, 15)
		await sim.wal.close()
		const rec = recoverPayoutState(dir)
		assert.equal(rec.snapshotSeq, 40)
		assert.equal(rec.replayed, 15)
		assert.equal(rec.writerLastSeq, 55)
		assert.equal(view(rec.core), modelView(sim.model))
		assert.deepEqual(rec.warnings, [])
	} finally {
		done(dir)
	}
})

test('recovery: no committed snapshot (absent or orphan) refuses; a version 2 snapshot without walSeq replays the whole log (the migration start)', async () => {
	const dir = tmp()
	try {
		assert.throws(() => recoverPayoutState(path.join(dir, 'nothing')), /no committed snapshot/)
		fs.mkdirSync(path.join(dir, 'orphan'))
		fs.writeFileSync(path.join(dir, 'orphan', 'junk'), 'x')
		assert.throws(() => recoverPayoutState(path.join(dir, 'orphan')), /no committed snapshot \(orphan\)/)
		// df78e6b/P1 wrote this state (version 2, no walSeq); the first WAL-mode start has events from seq 1
		const mig = path.join(dir, 'mig')
		writeSegmentedState(mig, { pending: [{ eventKey: 'a', blockNumber: 1 }], consumedEventKeys: { c1: true }, exitedPubkeys: {}, historyCursor: 5, freezeH: { height: 100 } })
		const w = new WalWriter({ stateDir: mig, lastSeq: 0, onFatal: noFatal })
		const model = new Model()
		model.pending.set('a', { eventKey: 'a', blockNumber: 1 })
		model.consumedAdd('c1')
		model.setScalar('historyCursor', 5)
		model.setScalar('freezeH', { height: 100 })
		const core0 = new LabPayoutStateCore({ pending: [{ eventKey: 'a', blockNumber: 1 } as PendingEntry], consumed: ['c1'], scalars: { historyCursor: 5, freezeH: { height: 100 } } })
		const sim: Sim = { dir: mig, seed: 3, core: core0, wal: w, model, segmentBytes: 700 }
		await emit(sim, 12)
		await w.close()
		const rec = recoverPayoutState(mig)
		assert.equal(rec.manifestVersion, 2)
		assert.equal(rec.snapshotSeq, 0)
		assert.equal(rec.replayed, 12)
		assert.equal(view(rec.core), modelView(model))
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------------ the crash matrix
const POINTS: { name: string; run: (s: Sim) => Promise<void> }[] = [
	{ name: 'snapshot files written, crash before the commit hook', run: (s) => cycle(s, 'truncate', undefined, { beforeCommit: () => { throw new Error('crash') } }).catch(() => undefined) },
	{ name: 'crash at the commit point (manifest staged, not renamed)', run: (s) => cycle(s, 'truncate', undefined, { beforeManifestRename: () => { throw new Error('crash') } }).catch(() => undefined) },
	{ name: 'manifest committed, crash before the merge and the truncation', run: (s) => cycle(s, 'commit') },
	{ name: 'merged, crash before the truncation', run: (s) => cycle(s, 'merge') },
	{ name: 'truncation interrupted after the first unlink', run: (s) => cycle(s, 'partial-truncate') },
	{ name: 'complete cycle, crash afterwards', run: (s) => cycle(s, 'truncate') },
	{ name: 'events appended while the snapshot is written, crash after the commit', run: (s) => cycle(s, 'commit', () => emit(s, 3, false)) },
	{ name: 'events appended while the snapshot is written, crash before the commit', run: (s) => cycle(s, 'truncate', () => emit(s, 3, false), { beforeManifestRename: () => { throw new Error('crash') } }).catch(() => undefined) },
]
for (const p of POINTS) {
	test(`crash matrix: ${p.name} - recovery equals the reference, no gap in the seq, and the daemon can go on (two more cycles)`, async () => {
		const dir = tmp()
		try {
			let sim = await bootstrap(dir, 11)
			await emit(sim, 30)
			await cycle(sim) // S1, committed and truncated
			await emit(sim, 25)
			await p.run(sim)
			sim = await crashAndRecover(sim)
			// life goes on: more events and a full snapshot cycle, then another crash and recovery
			await emit(sim, 20)
			await cycle(sim)
			await emit(sim, 7)
			sim = await crashAndRecover(sim)
			await emit(sim, 5)
			await sim.wal.close()
			const rec = recoverPayoutState(dir)
			assert.equal(view(rec.core), modelView(sim.model))
		} finally {
			done(dir)
		}
	})
}

test('crash matrix: a leftover covered segment (crash between the commit and the truncation) is removed by the next recovery, and the log still scans cleanly afterwards', async () => {
	const dir = tmp()
	try {
		let sim = await bootstrap(dir, 21, 400)
		await emit(sim, 60)
		const before = listSegments(path.join(dir, WAL_DIR)).length
		assert.ok(before >= 3, `several segments (${before})`)
		await cycle(sim, 'commit')
		sim = await crashAndRecover(sim)
		const after = listSegments(path.join(dir, WAL_DIR))
		assert.ok(after.length < before, 'covered segments were removed')
		assert.ok(after.length <= 1)
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------------ graceful stop, V5a, Y1
test('graceful stop writes a version 2 downgrade snapshot (readable by the plain reader), reads it back, removes every segment file; the P1 guard then passes; a WAL restart continues after walSeq', async () => {
	const dir = tmp()
	try {
		let sim = await bootstrap(dir, 31)
		await emit(sim, 50)
		await cycle(sim)
		await emit(sim, 20)
		const stop = await gracefulStopToV2(sim.core, sim.wal, dir)
		assert.equal(stop.walSeq, 70)
		assert.ok(stop.removedSegments >= 1)
		const m = readManifest(dir)
		assert.equal(m.version, 2)
		assert.equal(m.scalars.walSeq, 70)
		assert.equal(assertNoWalEvents(dir), 'empty', 'wal/ is empty: an older build may start')
		assert.deepEqual(fs.readdirSync(path.join(dir, WAL_DIR)), [], 'no empty segment file left behind')
		const old = readSegmentedState(dir) // what df78e6b / P1 would read
		assert.equal(old.pending.length, sim.model.pending.size)
		assert.deepEqual(Object.keys(old.consumedEventKeys), sim.model.consumed)
		// restart in WAL mode: the v2 snapshot with walSeq is the base, numbering continues at 71
		const rec = recoverPayoutState(dir)
		assert.equal(rec.snapshotSeq, 70)
		assert.equal(rec.writerLastSeq, 70)
		assert.equal(rec.replayed, 0)
		assert.equal(view(rec.core), modelView(sim.model))
		const wal = new WalWriter({ stateDir: dir, lastSeq: rec.writerLastSeq, segmentBytes: 700, onFatal: noFatal })
		sim = { ...sim, core: rec.core, wal }
		await emit(sim, 9)
		assert.equal(wal.lastSeq, 79)
		await wal.close()
		// crash before the first snapshot of this run: version 2 + walSeq 70 + events 71..79 replays them
		const rec2 = recoverPayoutState(dir)
		assert.equal(rec2.manifestVersion, 2)
		assert.equal(rec2.replayed, 9)
		assert.equal(view(rec2.core), modelView(sim.model))
	} finally {
		done(dir)
	}
})

test('V5a / Y1: crash after the downgrade manifest was committed but before the segment files were deleted - the P1 guard refuses, recovery skips the covered events (no double count, no resurrected in-flight), completes the stop and leaves wal/ empty', async () => {
	const dir = tmp()
	try {
		const sim = await bootstrap(dir, 41)
		await emit(sim, 10)
		// an intent, its hash, and the settlement of that batch, with an absolute settled count
		const rec1 = { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '1000', eventKeys: ['k1', 'k2'] }
		const evs: WalOp[][] = [
			[{ op: 'pendingAdd', entry: { eventKey: 'k1', blockNumber: 10 } }, { op: 'pendingAdd', entry: { eventKey: 'k2', blockNumber: 11 } }],
			[{ op: 'inFlightSet', record: rec1 }],
			[{ op: 'inFlightSet', record: { ...rec1, hash: '0xdead' } }],
			[{ op: 'consumedAdd', key: 'k1' }, { op: 'consumedAdd', key: 'k2' }, { op: 'pendingDel', key: 'k1' }, { op: 'pendingDel', key: 'k2' }, { op: 'inFlightSet', record: null }, { op: 'scalarsSet', patch: { settledBatchCount: 7, maxPaidHistoryBlock: 11 } }],
		]
		for (const ops of evs) {
			sim.core.record(sim.wal, 'x', ops)
			sim.model.apply(ops)
		}
		await sim.wal.whenDurable(sim.wal.lastSeq)
		await assert.rejects(
			gracefulStopToV2(sim.core, sim.wal, dir, {
				beforeRemoveSegments: () => {
					throw new Error('crash before the segment files are removed')
				},
			}),
			/crash before the segment files are removed/
		)
		const segs = listSegments(path.join(dir, WAL_DIR))
		assert.ok(segs.length >= 1, 'the segment files are still there')
		const m = readManifest(dir)
		assert.equal(m.version, 2)
		assert.equal(m.scalars.walSeq, 14)
		assert.throws(() => assertNoWalEvents(dir), /is not empty/, 'the P1 guard refuses while segment files remain')
		await sim.wal.close()
		const rec = recoverPayoutState(dir)
		assert.equal(rec.replayed, 0, 'every event is <= walSeq: nothing is applied twice')
		assert.deepEqual(rec.cleanedSegments.sort(), segs.map((s) => s.file).sort(), 'the interrupted stop is completed')
		assert.equal(rec.core.getInFlight(), null, 'the settled batch is not put back in flight')
		assert.equal(rec.core.getScalar('settledBatchCount'), 7, 'the absolute settled count is not accumulated twice')
		assert.equal(view(rec.core), modelView(sim.model))
		assert.equal(assertNoWalEvents(dir), 'empty', 'afterwards the P1 guard passes')
	} finally {
		done(dir)
	}
})

test('graceful stop failures leave the log in place: a snapshot that fails, a memory/log seq mismatch, a snapshot still in flight', async () => {
	const dir = tmp()
	try {
		const sim = await bootstrap(dir, 51)
		await emit(sim, 12)
		await assert.rejects(
			gracefulStopToV2(sim.core, sim.wal, dir, { hooks: { beforeManifestRename: () => { throw new Error('disk full at the commit') } } }),
			/disk full at the commit/
		)
		assert.equal(sim.core.snapshotInFlight, false, 'the views were folded back')
		assert.ok(listSegments(path.join(dir, WAL_DIR)).length >= 1, 'the log is untouched')
		assert.equal(readManifest(dir).version, 3, 'the committed manifest is still the version 3 one')
		// memory ahead of the log (an event applied but never appended) is refused
		sim.core.setScalar('note', 'applied without a log event')
		sim.core.applyEvent({ v: 1, seq: sim.wal.lastSeq + 5, ts: 't', t: 'x', ops: [] })
		await assert.rejects(gracefulStopToV2(sim.core, sim.wal, dir), /memory is at seq/)
		// a snapshot in flight is refused
		const core2 = new LabPayoutStateCore()
		const wal2 = new WalWriter({ stateDir: tmp(), lastSeq: 0, onFatal: noFatal })
		const src = core2.freezeForSnapshot()
		await assert.rejects(gracefulStopToV2(core2, wal2, dir), /still in flight/)
		core2.finishSnapshot(src, { committed: false })
	} finally {
		done(dir)
	}
})

test('an old daemon that ran after a graceful stop carries the stale informational walSeq forward; a later WAL-mode start still recovers (the stale value is only a replay base with an empty log)', async () => {
	const dir = tmp()
	try {
		const sim = await bootstrap(dir, 61)
		await emit(sim, 18)
		await gracefulStopToV2(sim.core, sim.wal, dir)
		// df78e6b / P1 reads the state and writes a new generation; extractScalars passes walSeq through untouched
		const st = readSegmentedState(dir)
		writeSegmentedState(dir, { ...st, historyCursor: 123456 })
		const rec = recoverPayoutState(dir)
		assert.equal(rec.snapshotSeq, 18)
		assert.equal(rec.writerLastSeq, 18)
		assert.equal(rec.core.getScalar('historyCursor'), 123456)
		assert.equal(rec.core.getScalar('walSeq'), undefined, 'the informational value is not a live scalar')
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------------ refusals and self-checks
test('mid-log damage refuses recovery (WalMidCorruptionError), changes nothing on disk and removes no segment', async () => {
	const dir = tmp()
	try {
		const sim = await bootstrap(dir, 71, 100000)
		await emit(sim, 20)
		await sim.wal.close()
		const walDir = path.join(dir, WAL_DIR)
		const file = path.join(walDir, segmentFileName(1))
		const buf = fs.readFileSync(file)
		buf[40] = buf[40]! ^ 0x55
		fs.writeFileSync(file, buf)
		const before = fs.readFileSync(file)
		assert.throws(() => recoverPayoutState(dir), WalMidCorruptionError)
		assert.deepEqual(fs.readFileSync(file), before, 'nothing truncated')
		assert.equal(listSegments(walDir).length, 1)
	} finally {
		done(dir)
	}
})

test('post-replay self-checks: maxPaidHistoryBlock above the cursor and in-flight keys that are neither pending nor consumed are reported as warnings', () => {
	const core = new LabPayoutStateCore({
		pending: [{ eventKey: 'p1', blockNumber: 1 } as PendingEntry],
		consumed: ['c1'],
		scalars: { historyCursor: 100, maxPaidHistoryBlock: 150 },
		inFlight: { idempotencyKey: 'i', eventKeys: ['p1', 'c1', 'lost1', 'lost2'] },
	})
	const w = postReplayChecks(core)
	assert.equal(w.length, 2)
	assert.match(w[0]!, /invariant C: maxPaidHistoryBlock 150 is above historyCursor 100/)
	assert.match(w[1]!, /2 key\(s\) that are neither pending nor consumed/)
	const ok = new LabPayoutStateCore({ scalars: { historyCursor: 100, maxPaidHistoryBlock: 100 } })
	assert.deepEqual(postReplayChecks(ok), [])
})

test('recoverOrRefuse: mid-log damage only alerts (the alert text names the offline repair, no automatic repair) and exits; the module never references the repair command; other errors propagate', async () => {
	const dir = tmp()
	try {
		const sim = await bootstrap(dir, 81, 100000)
		await emit(sim, 20)
		await sim.wal.close()
		const file = path.join(dir, WAL_DIR, segmentFileName(1))
		const buf = fs.readFileSync(file)
		buf[40] = buf[40]! ^ 0x55
		fs.writeFileSync(file, buf)
		const lines: string[] = []
		class Exited extends Error {}
		assert.throws(
			() =>
				recoverOrRefuse(dir, {
					log: (l) => lines.push(l),
					exit: (c) => {
						lines.push(`exit ${c}`)
						throw new Exited()
					},
				}),
			Exited
		)
		assert.equal(lines.length, 2)
		assert.match(lines[0]!, /ALERT WAL damaged in the middle/)
		assert.match(lines[0]!, /Refusing to start; nothing was truncated; no automatic repair/)
		assert.equal(lines[1], 'exit 78')
		assert.deepEqual(fs.readFileSync(file), buf, 'nothing was changed')
		const src = fs.readFileSync(path.join(__dirname, 'labPayoutRecovery.ts'), 'utf8')
		assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /labWalRepair|repairMidCorruption/)
		// an unrelated failure is not swallowed
		assert.throws(() => recoverOrRefuse(path.join(dir, 'missing'), { exit: () => { throw new Exited() } }), /no committed snapshot/)
	} finally {
		done(dir)
	}
})

test('R6 full stack: snapshot committed at walSeq 12, frame 11 damaged, frames 13..15 beyond the snapshot - after the audited repair recovery starts, continues at 13, and the new events survive another crash and recovery', async () => {
	const dir = tmp()
	const audit = tmp()
	try {
		let sim = await bootstrap(dir, 91, 100000)
		await emit(sim, 12)
		await cycle(sim, 'commit') // manifest walSeq 12; the single segment (events 1..12) is not truncated
		await emit(sim, 3) // 13..15, acknowledged and then lost by the cut below
		await sim.wal.close()
		const file = path.join(dir, WAL_DIR, segmentFileName(1))
		const buf = fs.readFileSync(file)
		let off = 0
		const starts: number[] = []
		for (let i = 0; i < 15; i++) {
			starts.push(off)
			off += 10 + buf.readUInt32LE(off + 2)
		}
		buf[starts[10]! + 12] = buf[starts[10]! + 12]! ^ 0x40 // damage the payload of frame 11
		fs.writeFileSync(file, buf)
		assert.throws(() => recoverPayoutState(dir), WalMidCorruptionError)
		const rep = repairMidCorruption({ stateDir: dir, auditDir: path.join(audit, 'a'), runId: 'run-20261121-r6', approval: 'PM-2026-11-21-01' })
		assert.equal(rep.status, 'repaired')
		if (rep.status !== 'repaired') return
		assert.deepEqual(rep.audit.droppedCoveredBySnapshot.seqs, [12])
		assert.deepEqual(rep.audit.droppedBeyondSnapshot.seqs, [13, 14, 15])
		assert.equal(rep.audit.nextEventSeq, 13)
		// recovery: state = the snapshot (12), the covered leftover segment is cleaned, the writer continues at 12
		const rec = recoverPayoutState(dir)
		assert.equal(rec.snapshotSeq, 12)
		assert.equal(rec.replayed, 0)
		assert.equal(rec.writerLastSeq, 12)
		assert.equal(rec.cleanedSegments.length, 1)
		const model = new Model()
		model.setScalar('freezeH', { height: 500 })
		for (let q = 1; q <= 12; q++) model.apply(opsForSeq(91, q))
		assert.equal(view(rec.core), modelView(model))
		// new life: the events after the repair are different events with seq 13.. and they survive a crash
		const wal = new WalWriter({ stateDir: dir, lastSeq: rec.writerLastSeq, segmentBytes: 700, onFatal: noFatal })
		sim = { dir, seed: 92, core: rec.core, wal, model, segmentBytes: 700 }
		await emit(sim, 4)
		await wal.close()
		const rec2 = recoverPayoutState(dir)
		assert.equal(rec2.replayed, 4, 'the new events are replayed, none swallowed as already in the snapshot')
		assert.equal(rec2.core.lastAppliedSeq, 16)
		assert.equal(view(rec2.core), modelView(model))
	} finally {
		done(dir)
		done(audit)
	}
})
