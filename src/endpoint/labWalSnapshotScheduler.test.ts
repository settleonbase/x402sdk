/** P2c-3: the WAL snapshot scheduler - when a snapshot is due, one at a time, failure and archive-failure alerts, the log is truncated after a commit, nothing already fsynced is ever lost. Real files. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from './labClPayoutStateStore'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { listSegments, WalWriter } from './labWal'
import { WalSnapshotScheduler, type SchedulerOptions } from './labWalSnapshotScheduler'
import { WalStateHandle } from './labWalStateHandle'

type E = { eventKey: string; amount: bigint | string; blockNumber: number; withdrawalIndex: number; pubkey: string }
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const entry = (i: number, block = 10 + i): E => ({ eventKey: key(i), amount: 1000n, blockNumber: block, withdrawalIndex: i % 5, pubkey: '0xabcdef' })
const fatal = (e: Error): void => {
	throw e
}

async function world(segmentBytes = 4096) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsched-'))
	const stateDir = path.join(dir, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes, onFatal: fatal })
	const h = new WalStateHandle<E, Record<string, unknown>>({ core, wal, onFatal: fatal })
	const logs: string[] = []
	const clock = { t: 1_000_000 }
	const mk = (o: Partial<SchedulerOptions> = {}): WalSnapshotScheduler => new WalSnapshotScheduler({ core, wal, stateDir, log: (l) => logs.push(l), now: () => clock.t, intervalMs: 600_000, ...o })
	const logical = (c: LabPayoutStateCore): string =>
		canonicalJson({ pending: [...c.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)), consumed: [...c.consumedKeys()], scalars: c.scalarsCopy() })
	const settle = async (s: WalSnapshotScheduler): Promise<void> => {
		for (let i = 0; i < 200 && s.inFlight; i++) await new Promise((r) => setTimeout(r, 5))
	}
	const done = async (): Promise<void> => {
		await wal.close()
		fs.rmSync(dir, { recursive: true, force: true })
	}
	return { dir, stateDir, core, wal, h, logs, clock, mk, logical, settle, done }
}
async function fill(h: WalStateHandle<E, Record<string, unknown>>, from: number, n: number): Promise<void> {
	for (let i = from; i < from + n; i++) {
		h.pendingAdd([entry(i)])
		await h.commit('scan')
	}
}

test('due by interval: nothing before the interval, a committed snapshot after it; the covered log segments are removed and the recovered state equals the live state', async () => {
	const w = await world()
	try {
		await fill(w.h, 1, 60)
		const s = w.mk()
		s.poke()
		assert.equal(s.stats.started, 0, 'not due yet')
		w.clock.t += 600_000
		const segsBefore = listSegments(path.join(w.stateDir, 'wal')).length
		assert.ok(segsBefore > 1, 'the log has several segments')
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 1)
		assert.ok(w.logs.some((l) => /snapshot committed walSeq=60 reason=interval/.test(l)), w.logs.join('\n'))
		assert.ok(listSegments(path.join(w.stateDir, 'wal')).length < segsBefore, 'segments covered by the snapshot were removed')
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(rec.snapshotSeq, 60)
		assert.equal(w.logical(rec.core), w.logical(w.core))
		s.poke()
		assert.equal(s.stats.started, 1, 'the interval restarts after a commit')
	} finally {
		await w.done()
	}
})

test('due by log size: a log above the limit snapshots at once, even inside the interval', async () => {
	const w = await world()
	try {
		await fill(w.h, 1, 10)
		const s = w.mk({ walMaxBytes: 1000 })
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 1)
		assert.ok(w.logs.some((l) => /reason=wal-size/.test(l)))
	} finally {
		await w.done()
	}
})

test('one snapshot at a time: a due one that finds the previous still running is skipped, counted and alerted; writes made meanwhile are not lost', async () => {
	const w = await world()
	try {
		await fill(w.h, 1, 20)
		let release: () => void = () => undefined
		const gate = new Promise<void>((r) => (release = r))
		const s = w.mk({ writeOptions: { waitDurable: async (seq) => { await gate; await w.wal.whenDurable(seq) } } }) // held right before the commit
		w.clock.t += 600_000
		s.poke()
		assert.equal(s.inFlight, true)
		await new Promise((r) => setTimeout(r, 20))
		await fill(w.h, 100, 5) // events while the snapshot is in flight
		s.poke()
		s.poke()
		assert.equal(s.stats.skippedBusy, 2)
		assert.equal(w.logs.filter((l) => /ALERT snapshot due .* previous one is still running/.test(l)).length, 1, 'the first skip is alerted (then every 10th)')
		release()
		await w.settle(s)
		assert.equal(s.stats.committed, 1)
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(w.logical(rec.core), w.logical(w.core), 'snapshot + remaining log reproduce the live state, including the writes made during the snapshot')
	} finally {
		await w.done()
	}
})

test('a failing snapshot is an ALERT, never an exception: the events already fsynced are intact, the core is unfrozen, and the next try waits for the backoff', async () => {
	const w = await world()
	try {
		await fill(w.h, 1, 20)
		let fail = true
		const s = w.mk({ writeOptions: { hooks: { beforeManifestRename: () => { if (fail) throw new Error('disk full at the commit') } } } })
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.failed, 1)
		assert.equal(s.stats.lastError, 'disk full at the commit')
		assert.ok(w.logs.some((l) => /ALERT snapshot failed \(interval\): disk full at the commit/.test(l)))
		assert.equal(w.core.snapshotInFlight, false)
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(rec.snapshotSeq, 0, 'the old snapshot is still the committed one')
		assert.equal(w.logical(rec.core), w.logical(w.core), 'the log alone reproduces everything')
		s.poke()
		assert.equal(s.stats.started, 1, 'backoff: no retry at once')
		fail = false
		w.clock.t += 120_000
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 1, 'retried after the backoff')
	} finally {
		await w.done()
	}
})

test('archive failure: the snapshot still commits, nothing is pruned, and an ALERT "consumed archive failed" names it', async () => {
	const w = await world()
	try {
		for (let i = 1; i <= 30; i++) w.h.consumedAdd(key(1000 + i))
		await w.h.commit('settle')
		const s = w.mk({ consumedCap: 10, archive: () => { throw new Error('archive dir not writable') } })
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 1)
		assert.equal(s.stats.archiveFailed, 1)
		assert.equal(w.core.consumedSize, 30, 'nothing was pruned')
		assert.ok(w.logs.some((l) => /ALERT consumed archive failed/.test(l)), w.logs.join('\n'))
		// and with a working archive the oldest are pruned and handed to it
		const archived: string[] = []
		const s2 = w.mk({ consumedCap: 10, archive: (k) => void archived.push(...k) })
		w.clock.t += 600_000
		s2.poke()
		await w.settle(s2)
		assert.equal(w.core.consumedSize, 9, 'pruned to 90% of the cap')
		assert.equal(archived.length, 21)
		assert.equal(archived[0], key(1001), 'the oldest keys go first')
	} finally {
		await w.done()
	}
})

test('a log more than twice the limit raises its own ALERT (rate limited); stop() waits for a running snapshot and starts no new one', async () => {
	const w = await world()
	try {
		await fill(w.h, 1, 5)
		const s = w.mk({ walBytes: () => 3 * 1048576, walMaxBytes: 1048576, writeOptions: { hooks: { beforeManifestRename: () => { throw new Error('x') } } } })
		s.poke()
		await w.settle(s)
		s.poke()
		assert.equal(w.logs.filter((l) => /ALERT WAL is 3\.0 MiB, more than twice/.test(l)).length, 1, 'rate limited')
		await s.stop()
		const started = s.stats.started
		w.clock.t += 10 * 60_000
		s.poke()
		assert.equal(s.stats.started, started, 'no snapshot starts after stop()')
	} finally {
		await w.done()
	}
})

test('count drift found at a snapshot is an ALERT and is corrected', async () => {
	const w = await world()
	try {
		await fill(w.h, 1, 5)
		// an entry that reaches the pool without going through the counting path (what a bug would do): the snapshot writer counts it, the incremental counts do not
		w.core.pending.set(key(900), { eventKey: key(900), blockNumber: 77, withdrawalIndex: 0, amount: '1', pubkey: '0xabc' } as never)
		const s = w.mk()
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 1)
		assert.ok(w.logs.some((l) => /ALERT history-block counts drifted/.test(l)), w.logs.join('\n'))
	} finally {
		await w.done()
	}
})

// ---- s12 as the reviewer specified it: seed 10,300 consumed keys, cap 10,000, one scheduled snapshot
import { createLegacyStateStore } from './labLegacyState'
import { appendConsumedArchive, consumedArchiveDir } from './labConsumedPrune'

async function seed10300(w: Awaited<ReturnType<typeof world>>): Promise<string[]> {
	const keys = Array.from({ length: 10_300 }, (_, i) => key(0x100000 + i))
	for (const k of keys) w.h.consumedAdd(k)
	await w.h.commit('settle')
	return keys
}

test('s12 spec: with 10,300 consumed keys and cap 10,000 the COMMITTED manifest holds exactly the set the legacy prune leaves (the oldest 1,300 gone, 9,000 left, insertion order); the archive has them all, oldest first, BEFORE the manifest commits', async () => {
	const w = await world()
	try {
		const keys = await seed10300(w)
		// what the legacy implementation leaves, computed by the legacy code itself
		// TIME POINT of the comparison: the legacy prune runs at its first write, on exactly this seeded set (no paid keys added yet), so the sets are identical. In the end-to-end golden the legacy path then
		// ADDS the 5 keys it pays (9,005 left) while WAL prunes at the snapshot/stop after those 5 were added (10,305 -> 9,000): the WAL set is the golden set minus its 5 oldest survivors (see labE2eWalShutdown).
		const archDir = path.join(w.dir, 'legacy-archive')
		const logsLegacy: string[] = []
		const legacy = createLegacyStateStore({ stateFile: () => path.join(w.dir, 'legacy.json'), segmentedDir: () => path.join(w.dir, 'legacy.v2'), consumedCap: () => 10_000, scanFloor: () => 100, tripPersist: () => undefined, logger: (...a: unknown[]) => void logsLegacy.push(String(a[0])) })
		const st = { consumedEventKeys: Object.fromEntries(keys.map((k) => [k, true] as const)), exitedPubkeys: {}, pending: [] } as never
		assert.equal(legacy.pruneConsumedEventKeys(st), 1300)
		const legacyLeft = Object.keys((st as { consumedEventKeys: Record<string, true> }).consumedEventKeys)
		assert.equal(legacyLeft.length, 9000)
		void archDir
		const archived: string[] = []
		let archivedWhenCommitting = -1
		const s = w.mk({
			consumedCap: 10_000,
			archive: (k) => void archived.push(...k),
			writeOptions: { hooks: { beforeManifestRename: () => void (archivedWhenCommitting = archived.length) } },
		})
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 1)
		assert.equal(archivedWhenCommitting, 1300, 'the whole archive write happened before the manifest was made visible')
		assert.deepEqual(archived, keys.slice(0, 1300), 'oldest first')
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(rec.snapshotSeq, w.core.lastAppliedSeq)
		assert.deepEqual([...rec.core.consumedKeys()], legacyLeft, 'the committed snapshot holds exactly the legacy-pruned set, in order')
		assert.deepEqual([...w.core.consumedKeys()], legacyLeft, 'and so does the live state')
		for (const k of keys.slice(0, 1300)) assert.equal(rec.core.consumedHas(k), false)
		assert.equal(rec.core.pendingSize, 0, 'pruned keys are not queued again after a restart-style recovery')
	} finally {
		await w.done()
	}
})

test('s12 spec: when the archive fails nothing is pruned this time (the committed manifest still holds all 10,300) and the operator sees the ALERT', async () => {
	const w = await world()
	try {
		const keys = await seed10300(w)
		const s = w.mk({ consumedCap: 10_000, archive: () => { throw new Error('disk full') } })
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 1)
		assert.equal(s.stats.archiveFailed, 1)
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.deepEqual([...rec.core.consumedKeys()], keys, 'the committed manifest holds every key')
		assert.ok(w.logs.some((l) => /ALERT consumed archive failed/.test(l)))
		// the next try with a working archive prunes
		const archived: string[] = []
		const s2 = w.mk({ consumedCap: 10_000, archive: (k) => void archived.push(...k) })
		w.clock.t += 600_000
		s2.poke()
		await w.settle(s2)
		assert.equal(archived.length, 1300)
		assert.equal(w.core.consumedSize, 9000)
	} finally {
		await w.done()
	}
})

// ---- K1: failures AFTER the manifest is committed
function watchUnhandled(): { seen: unknown[]; stop: () => void } {
	const seen: unknown[] = []
	const h = (e: unknown): void => void seen.push(e)
	process.on('unhandledRejection', h)
	return { seen, stop: () => void process.off('unhandledRejection', h) }
}
const turn = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('K1: trimming the log fails AFTER the commit: the snapshot counts as committed, truncateFailed is counted, an ALERT is logged, nothing is rejected, finishSnapshot(false) is never called, and the next snapshot trims the log', async () => {
	const w = await world(700)
	const uh = watchUnhandled()
	try {
		await fill(w.h, 1, 30)
		const realTruncate = w.wal.truncateThrough.bind(w.wal)
		let boom = true
		w.wal.truncateThrough = (seq: number) => {
			if (boom) throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' })
			return realTruncate(seq)
		}
		const finish = w.core.finishSnapshot.bind(w.core)
		const calls: boolean[] = []
		w.core.finishSnapshot = ((src: never, outcome: { committed: boolean }) => {
			calls.push(outcome.committed)
			return finish(src, outcome as never)
		}) as typeof w.core.finishSnapshot
		const s = w.mk()
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		await turn()
		assert.equal(s.stats.committed, 1, 'the commit counts')
		assert.equal(s.stats.failed, 0, 'it is not a failed snapshot')
		assert.equal(s.stats.truncateFailed, 1)
		assert.deepEqual(calls, [true], 'finishSnapshot(committed:false) was never called after the commit')
		assert.ok(w.logs.some((l) => /ALERT snapshot committed at walSeq 30 but trimming the log failed: EIO/.test(l)), w.logs.join('\n'))
		assert.equal(w.core.snapshotInFlight, false)
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).snapshotSeq, 30, 'the committed snapshot is the recovery base; the untrimmed log is harmless')
		assert.equal(uh.seen.length, 0, 'no unhandled rejection')
		// the next snapshot works and trims what the failed one left
		boom = false
		await fill(w.h, 100, 3)
		w.clock.t += 600_000
		const segsBefore = listSegments(path.join(w.stateDir, 'wal')).length
		s.poke()
		await w.settle(s)
		assert.equal(s.stats.committed, 2)
		assert.ok(listSegments(path.join(w.stateDir, 'wal')).length < segsBefore, 'old segments trimmed by the next snapshot')
		assert.equal(w.logical(recoverPayoutState(w.stateDir, { readOnly: true }).core), w.logical(w.core))
	} finally {
		uh.stop()
		await w.done()
	}
})

test('K1: the in-memory bookkeeping throws after the commit, or anything unexpected happens inside a run: ALERT, counted, no rejection, finishSnapshot(false) not called after a commit', async () => {
	const w = await world()
	const uh = watchUnhandled()
	try {
		await fill(w.h, 1, 10)
		const finish = w.core.finishSnapshot.bind(w.core)
		const calls: boolean[] = []
		w.core.finishSnapshot = ((src: never, outcome: { committed: boolean }) => {
			calls.push(outcome.committed)
			if (outcome.committed) throw new Error('bookkeeping broke')
			return finish(src, outcome as never)
		}) as typeof w.core.finishSnapshot
		const s = w.mk()
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		await turn()
		assert.equal(s.stats.committed, 1)
		assert.equal(s.stats.bookkeepingFailed, 1)
		assert.deepEqual(calls, [true])
		assert.ok(w.logs.some((l) => /ALERT snapshot committed at walSeq 10 but the in-memory bookkeeping failed: bookkeeping broke/.test(l)))
		// the core is still marked as snapshotting (finishSnapshot never completed), so the next attempt throws inside run(): that must be an ALERT, not a rejection
		w.clock.t += 600_000
		s.poke()
		await w.settle(s)
		await turn()
		assert.ok(w.logs.some((l) => /ALERT snapshot scheduler internal error/.test(l)), w.logs.join('\n'))
		assert.equal(uh.seen.length, 0, 'no unhandled rejection')
	} finally {
		uh.stop()
		await w.done()
	}
})

// ---- K3: a snapshot that does not happen is itself an alert, even when ticks never end
test('K3: no committed snapshot for more than 3 intervals is an ALERT (once per interval, reset by a commit); the scheduler heartbeat starts a due snapshot with no tick at all, and stop() ends it', async () => {
	const w = await world()
	try {
		await fill(w.h, 1, 5)
		const s = w.mk({ walBytes: () => 0 })
		w.clock.t += 3 * 600_000
		s.checkStale()
		assert.equal(w.logs.filter((l) => /ALERT no snapshot has committed/.test(l)).length, 0, 'exactly 3 intervals is not yet "more than"')
		w.clock.t += 1000
		s.checkStale()
		s.checkStale()
		assert.equal(w.logs.filter((l) => /ALERT no snapshot has committed for 1801s/.test(l)).length, 1, 'alerted once')
		assert.equal(s.stats.staleAlerts, 1)
		w.clock.t += 600_000
		s.checkStale()
		assert.equal(s.stats.staleAlerts, 2, 'and again one interval later')
		// the heartbeat: no poke from any tick, the timer alone starts the due snapshot
		assert.equal(s.timerActive, false)
		s.start(5)
		assert.equal(s.timerActive, true)
		await w.settle({ get inFlight() { return false } } as never)
		for (let i = 0; i < 100 && s.stats.committed === 0; i++) await turn(10)
		assert.equal(s.stats.committed, 1, 'a snapshot started by the heartbeat alone')
		const alerts = s.stats.staleAlerts
		w.clock.t += 600_000
		s.checkStale()
		assert.equal(s.stats.staleAlerts, alerts, 'a commit resets the staleness')
		await s.stop()
		assert.equal(s.timerActive, false, 'stop() ends the heartbeat')
	} finally {
		await w.done()
	}
})
