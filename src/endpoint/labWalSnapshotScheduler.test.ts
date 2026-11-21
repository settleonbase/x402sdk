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
