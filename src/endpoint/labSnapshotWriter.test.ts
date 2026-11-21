/**
 * P2b-2: the state core and the cooperative snapshot writer. Local temp dirs only; no daemon, no network.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { keySetHash, loadCommittedForRecovery, readManifest, readSegmentedState, writeSegmentedState } from './labClPayoutStateStore'
import { planPrune } from './labConsumedPrune'
import { LabPayoutStateCore, type PendingEntry } from './labPayoutStateCore'
import { CooperativeKeySetHasher, SnapshotAbortedError, planPruneCooperative, writeSnapshotCooperative, nodeSnapshotFs, type SnapshotFs } from './labSnapshotWriter'

function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 0x100000000
	}
}
const hex = (n: number, w = 64): string => `0x${n.toString(16).padStart(w, '0')}`
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'labsnap-'))
const done = (d: string): void => fs.rmSync(d, { recursive: true, force: true })
const entry = (i: number, block: number, extra: Record<string, unknown> = {}): { eventKey: string } & Record<string, unknown> => ({ eventKey: hex(i), blockNumber: block, withdrawalIndex: i % 7, amountWei: String(1000 + i), ...extra })
const immediate = (): Promise<void> => new Promise((r) => setImmediate(r))

/** A core with `n` pending entries (blocks 1000.. ; freezeH 1500 so blocks <= 1500 are history), `c` consumed keys, `x` exited pubkeys and some scalars. */
function makeCore(n: number, c: number, x: number, withInFlight = false): LabPayoutStateCore {
	const core = new LabPayoutStateCore({
		pending: Array.from({ length: n }, (_, i) => entry(i, 1000 + Math.floor(i / 3)) as PendingEntry),
		consumed: Array.from({ length: c }, (_, i) => hex(1_000_000 + i)),
		exited: Array.from({ length: x }, (_, i) => hex(2_000_000 + i, 40)),
		scalars: { freezeH: { height: 1500, hash: '0xabc' }, historyCursor: 1400, realtimeCursor: 1600, settledBatchCount: 5, updatedAt: '2026-11-21T00:00:00.000Z' },
		inFlight: withInFlight ? { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '1000', eventKeys: [hex(1), hex(2), hex(3)] } : null,
		lastAppliedSeq: 40,
	})
	return core
}

function dump(core: LabPayoutStateCore): { pending: PendingEntry[]; consumed: string[]; exited: string[]; scalars: Record<string, unknown>; inFlight: unknown; seq: number } {
	return { pending: [...core.pendingEntries()], consumed: [...core.consumedKeys()], exited: [...core.exited.keys()], scalars: core.scalarsCopy(), inFlight: core.getInFlight(), seq: core.lastAppliedSeq }
}

// ------------------------------------------------------------------ pieces
test('CooperativeKeySetHasher equals keySetHash (sorted, newline-terminated, multiset) for empty, small, duplicate, non-ASCII and chunk-straddling sets', async () => {
	const r = rng(5)
	const sets: string[][] = [[], ['b'], ['b', 'a', 'b', 'a'], ['é', 'e', 'z', '😀', 'ab', 'a', '\u0000x'], Array.from({ length: 70_000 }, () => hex(Math.floor(r() * 50_000))), Array.from({ length: 200_000 }, (_, i) => `k${(i * 7919) % 100_003}`)]
	for (const keys of sets) {
		const h = new CooperativeKeySetHasher()
		for (const k of keys) h.add(k)
		assert.equal(await h.digest(null), keySetHash(keys), `set of ${keys.length}`)
	}
})

test('planPruneCooperative equals planPrune (oldest first, skips pending incl. other case, target = 90% of the cap, nothing within the cap)', async () => {
	const r = rng(12)
	for (let c = 0; c < 40; c++) {
		const n = Math.floor(r() * 400)
		const keys = Array.from({ length: n }, (_, i) => `0x${(i * 31 + c).toString(16)}${r() < 0.2 ? 'AB' : 'ab'}`)
		const consumed = new Map(keys.map((k) => [k, true as const]))
		const pendingKeys = keys.filter(() => r() < 0.25).map((k) => (r() < 0.5 ? k.toUpperCase() : k))
		const pending = new Map(pendingKeys.map((k) => [k, 1]))
		const cap = Math.floor(r() * 450)
		const expected = planPrune(keys, new Set(pendingKeys.map((k) => k.toLowerCase())), cap)
		assert.deepEqual(await planPruneCooperative(consumed, pending, cap, null), expected, `case ${c} cap ${cap} n ${n}`)
	}
})

// ------------------------------------------------------------------ the core
test('core: replay of events equals a plain model; applyEvent is idempotent; scalars max-merge; reserved scalar names are refused; values are frozen', () => {
	const core = new LabPayoutStateCore({ scalars: { historyCursor: 10, freezeH: { height: 100 } } })
	const ev = (seq: number, ops: Parameters<LabPayoutStateCore['applyEvent']>[0]['ops']) => ({ v: 1 as const, seq, ts: 't', t: 'x', ops })
	core.applyEvent(ev(1, [{ op: 'pendingAdd', entry: { eventKey: 'k1', blockNumber: 50 } }, { op: 'pendingAdd', entry: { eventKey: 'k2', blockNumber: 150 } }, { op: 'scalarsSet', patch: { historyCursor: 60 } }]))
	core.applyEvent(ev(2, [{ op: 'scalarsSet', patch: { historyCursor: 20 } }])) // max merge: stays 60
	core.applyEvent(ev(2, [{ op: 'pendingDel', key: 'k1' }])) // a replay overlap (seq <= applied) is skipped
	assert.equal(core.pendingHas('k1'), true)
	assert.equal(core.getScalar('historyCursor'), 60)
	assert.equal(core.histTotal, 1, 'k1 (block 50 <= freezeH 100) counts as history, k2 (150) does not')
	core.applyEvent(ev(3, [{ op: 'pendingDel', key: 'k1' }, { op: 'consumedAdd', key: 'k1' }, { op: 'inFlightSet', record: { idempotencyKey: 'i', eventKeys: ['k2'] } }]))
	assert.equal(core.histTotal, 0)
	assert.equal(core.consumedHas('k1'), true)
	assert.deepEqual(core.getInFlight(), { idempotencyKey: 'i', eventKeys: ['k2'] })
	assert.equal(Object.isFrozen(core.getInFlight()), true, 'the in-flight record is frozen')
	assert.equal(Object.isFrozen((core.getInFlight() as { eventKeys: string[] }).eventKeys), true, 'and so is its key array')
	assert.equal(Object.isFrozen(core.pendingGet('k2')), true, 'pending entries are frozen')
	for (const bad of ['pending', 'consumedEventKeys', 'exitedPubkeys', 'inFlightWithdraw', '__proto__']) assert.throws(() => core.setScalar(bad, 1), /not a plain scalar/)
	core.applyEvent(ev(4, [{ op: 'scalarsDel', names: ['historyCursor'] }]))
	assert.equal(core.getScalar('historyCursor'), undefined)
	// the same events applied twice leave the same state
	const before = JSON.stringify(dump(core))
	core.applyEvent(ev(3, [{ op: 'pendingAdd', entry: { eventKey: 'k1', blockNumber: 50 } }]))
	assert.equal(JSON.stringify(dump(core)), before)
})

test('core: a change of freezeH re-classifies the history entries (counts are rebuilt, no drift is reported); ahead() follows the cursor', () => {
	const drift: string[] = []
	const core = new LabPayoutStateCore({ pending: [entry(1, 10) as PendingEntry, entry(2, 20) as PendingEntry, entry(3, 30) as PendingEntry] }, { onDrift: (w) => drift.push(w) })
	assert.equal(core.histTotal, 0, 'no freezeH yet: nothing is history')
	core.setScalar('freezeH', { height: 25 })
	assert.equal(core.histTotal, 2)
	assert.equal(core.histAhead(15), 1)
	core.setScalar('freezeH', { height: 5 })
	assert.equal(core.histTotal, 0)
	core.deleteScalar('freezeH')
	assert.equal(core.histTotal, 0)
	assert.deepEqual(drift, [])
})

// ------------------------------------------------------------------ snapshot equals the whole-state writer
test('the cooperative snapshot of a state has the same file digests as the whole-state writer (pending, consumed, exited, scalars, key-set hashes) and reads back to the same state', async () => {
	const core = makeCore(2500, 4000, 300, true)
	const dirA = tmp()
	const dirB = tmp()
	try {
		const src = core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: dirA, mode: 'wal', segmentSize: 1000, sliceMs: 2 })
		core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
		assert.equal(res.stats.slices > 0, true)
		// reference: the existing whole-state writer on the same logical state
		const input = {
			...core.scalarsCopy(),
			inFlightWithdraw: core.getInFlight(),
			pending: [...core.pendingEntries()],
			consumedEventKeys: Object.fromEntries([...core.consumedKeys()].map((k) => [k, true as const])),
			exitedPubkeys: Object.fromEntries([...core.exited.keys()].map((k) => [k, true as const])),
		}
		writeSegmentedState(dirB, input, { segmentSize: 1000 })
		const a = readManifest(dirA)
		const b = readManifest(dirB)
		assert.equal(a.version, 3)
		assert.equal(a.walSeq, 40)
		assert.deepEqual(a.pending, b.pending)
		assert.deepEqual(a.consumed, b.consumed)
		assert.deepEqual(a.exited, b.exited)
		assert.equal(a.scalarsSha256, b.scalarsSha256)
		assert.deepEqual(a.inFlightKeys, b.inFlightKeys)
		assert.ok(a.pending.segments.every((s) => s.lines <= 1000), 'no segment exceeds segmentSize (W4)')
		const loaded = loadCommittedForRecovery(dirA)
		assert.equal(loaded.snapshotSeq, 40)
		assert.deepEqual(loaded.state.pending, [...core.pendingEntries()])
		assert.deepEqual(Object.keys(loaded.state.consumedEventKeys), [...core.consumedKeys()], 'consumed keeps insertion order (W4)')
		assert.deepEqual(Object.keys(loaded.state.exitedPubkeys), [...core.exited.keys()])
		assert.deepEqual((loaded.state as Record<string, unknown>).inFlightWithdraw, core.getInFlight())
		assert.equal(core.counts.driftEvents, 0)
		// a WAL-mode snapshot cannot be read by the plain reader (it would lose the WAL events)
		assert.throws(() => readSegmentedState(dirA), /WAL-mode snapshot/)
	} finally {
		done(dirA)
		done(dirB)
	}
})

test('downgrade mode writes a version 2 manifest with the informational scalars.walSeq that the plain (old-compatible) reader accepts', async () => {
	const core = makeCore(300, 500, 20, true)
	const dir = tmp()
	try {
		const src = core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir, mode: 'downgrade' })
		core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		const m = readManifest(dir)
		assert.equal(m.version, 2)
		assert.equal(m.walSeq, undefined)
		assert.equal(m.scalars.walSeq, 40)
		const st = readSegmentedState(dir)
		assert.equal(st.pending.length, 300)
		assert.equal(loadCommittedForRecovery(dir).snapshotSeq, 40)
		// a version 2 manifest must not carry a top-level walSeq
		const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
		raw.walSeq = 40
		fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(raw))
		assert.throws(() => readManifest(dir), /must not carry walSeq/)
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------------ concurrent changes during the snapshot
test('changes made while the snapshot is written (at every yield) never reach the file; after the merge the live state equals a plain reference run; order is frozen then delta', async () => {
	for (let seed = 1; seed <= 8; seed++) {
		const r = rng(seed * 101)
		const core = makeCore(1200, 1500, 50)
		// the reference applies the same operations to plain structures, no snapshot
		const refPending = new Map<string, PendingEntry>(core.pendingEntries() ? [...core.pendingEntries()].map((e) => [e.eventKey, e]) : [])
		const refConsumed = new Set<string>(core.consumedKeys())
		const refExited = new Set<string>(core.exited.keys())
		let next = 10_000
		const mutate = (): void => {
			for (let i = 0; i < 40; i++) {
				const x = r()
				if (x < 0.35) {
					const e = entry(next++, 1000 + Math.floor(r() * 700)) as PendingEntry
					core.pendingSet(e)
					refPending.set(e.eventKey, e)
				} else if (x < 0.65) {
					const keys = [...refPending.keys()]
					const k = keys[Math.floor(r() * Math.min(keys.length, 50))]
					if (k === undefined) continue
					core.pendingDelete(k)
					refPending.delete(k)
					if (r() < 0.8) {
						core.consumedAdd(k)
						refConsumed.add(k)
					}
				} else if (x < 0.8) {
					const k = hex(5_000_000 + Math.floor(r() * 100_000))
					core.consumedAdd(k)
					refConsumed.add(k)
				} else if (x < 0.9) {
					const k = hex(6_000_000 + Math.floor(r() * 100_000), 40)
					core.exitedAdd(k)
					refExited.add(k)
				} else {
					core.setScalar('historyCursor', 1400 + Math.floor(r() * 50))
				}
			}
		}
		const atFreeze = dump(core)
		const dir = tmp()
		try {
			const src = core.freezeForSnapshot()
			const res = await writeSnapshotCooperative(src, {
				dir,
				mode: 'wal',
				segmentSize: 400,
				sliceMs: 1,
				yieldFn: async () => {
					mutate()
					await immediate()
				},
			})
			core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
			// the snapshot holds exactly the state at the freeze
			const loaded = loadCommittedForRecovery(dir)
			assert.deepEqual(loaded.state.pending, atFreeze.pending, `seed ${seed}: pending in the file = at freeze`)
			assert.deepEqual(Object.keys(loaded.state.consumedEventKeys), atFreeze.consumed)
			assert.deepEqual(Object.keys(loaded.state.exitedPubkeys), atFreeze.exited)
			assert.equal(loaded.state.historyCursor, atFreeze.scalars.historyCursor)
			// the live state equals the reference (set contents and, for the consumed set, insertion order)
			assert.deepEqual([...core.pendingEntries()].map((e) => e.eventKey).sort(), [...refPending.keys()].sort(), `seed ${seed}: live pending`)
			assert.deepEqual([...core.consumedKeys()], [...refConsumed], `seed ${seed}: live consumed in insertion order`)
			assert.deepEqual([...core.exited.keys()], [...refExited])
			// the block counts still match a recount of the live pending set
			const recount = new Map<number, number>()
			for (const e of core.pendingEntries()) if ((e.blockNumber as number) <= 1500) recount.set(e.blockNumber as number, (recount.get(e.blockNumber as number) ?? 0) + 1)
			let total = 0
			for (const n of recount.values()) total += n
			assert.equal(core.histTotal, total, `seed ${seed}: histTotal`)
			assert.equal(core.histAhead(1450), [...recount].filter(([b]) => b > 1450).reduce((a, [, n]) => a + n, 0), `seed ${seed}: ahead`)
			assert.equal(core.counts.driftEvents, 0)
			assert.equal(res.stats.slices > 3, true, 'the writer really ran in several slices')
		} finally {
			done(dir)
		}
	}
})

test('the consumed prune: planned on the frozen views, archived BEFORE the commit, never a pending key, not applied to a key re-added after the freeze; an archive failure means no prune and an intact snapshot', async () => {
	const build = (): LabPayoutStateCore => {
		const core = makeCore(200, 1000, 10)
		// make some of the oldest consumed keys pending too (they must survive)
		core.pendingSet(entry(900_000, 1100, { eventKey: hex(1_000_003) }) as PendingEntry)
		core.pendingSet(entry(900_001, 1100, { eventKey: hex(1_000_004) }) as PendingEntry)
		return core
	}
	const dir = tmp()
	try {
		const core = build()
		const order: string[] = []
		const archived: string[] = []
		const src = core.freezeForSnapshot()
		// after the freeze: one of the soon-to-be-pruned keys is deleted and re-added to consumed; another becomes pending again
		core.consumed.delete(hex(1_000_000))
		core.consumed.add(hex(1_000_000))
		core.pendingSet(entry(900_002, 1700, { eventKey: hex(1_000_001) }) as PendingEntry)
		const res = await writeSnapshotCooperative(src, {
			dir,
			mode: 'wal',
			consumedCap: 800,
			archive: (keys) => {
				order.push('archive')
				archived.push(...keys)
			},
			hooks: { beforeCommit: () => order.push('commit') },
		})
		assert.deepEqual(order, ['archive', 'commit'], 'the archive is written before the manifest commit')
		assert.equal(res.prunedKeys.length, 1000 - 720, 'pruned down to 90% of the cap')
		assert.equal(archived.length, res.prunedKeys.length)
		assert.ok(!res.prunedKeys.includes(hex(1_000_003)) && !res.prunedKeys.includes(hex(1_000_004)), 'pending keys are never pruned')
		const file = loadCommittedForRecovery(dir).state
		assert.equal(Object.keys(file.consumedEventKeys).length, 720)
		core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
		assert.equal(core.consumedHas(hex(1_000_000)), true, 'a key deleted and re-added after the freeze survives the prune of its older copy')
		assert.equal(core.consumedHas(hex(1_000_001)), true, 'a key that became pending after the freeze is not pruned')
		assert.equal(core.consumedHas(hex(1_000_003)), true)
		assert.equal(core.consumedHas(hex(1_000_002)), false, 'a plain old key is gone from the live set')
		assert.equal(core.consumedSize, 720 + 2 - 0, 'live = file + the two protected keys that the file no longer lists') // 1_000_000 and 1_000_001 were planned but protected
		// archive failure: no prune, snapshot still committed, nothing lost
		const dir2 = tmp()
		try {
			const core2 = build()
			const src2 = core2.freezeForSnapshot()
			const res2 = await writeSnapshotCooperative(src2, {
				dir: dir2,
				mode: 'wal',
				consumedCap: 800,
				archive: () => {
					throw new Error('disk full')
				},
			})
			assert.equal(res2.stats.archiveFailed, true)
			assert.deepEqual(res2.prunedKeys, [])
			assert.equal(Object.keys(loadCommittedForRecovery(dir2).state.consumedEventKeys).length, 1000)
			core2.finishSnapshot(src2, { committed: true, prunedKeys: res2.prunedKeys, frozenHistCounts: res2.frozenHistCounts })
			assert.equal(core2.consumedSize, 1000)
			// no archive function at all: also no prune (a key is never dropped silently)
			const core3 = build()
			const src3 = core3.freezeForSnapshot()
			const dir3 = tmp()
			try {
				const res3 = await writeSnapshotCooperative(src3, { dir: dir3, mode: 'wal', consumedCap: 800 })
				assert.deepEqual(res3.prunedKeys, [])
				core3.finishSnapshot(src3, { committed: true, prunedKeys: [] })
			} finally {
				done(dir3)
			}
		} finally {
			done(dir2)
		}
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------------ slicing and event loop
test('a large snapshot runs in many short slices and the event loop keeps turning (timer ticks) while it is written', async () => {
	const core = makeCore(150_000, 300_000, 5_000)
	const dir = tmp()
	let ticks = 0
	const timer = setInterval(() => ticks++, 5)
	try {
		const src = core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir, mode: 'wal', sliceMs: 15 })
		core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		assert.ok(res.stats.slices >= 10, `slices ${res.stats.slices}`)
		assert.ok(res.stats.maxSliceMs < 250, `longest synchronous stretch ${res.stats.maxSliceMs.toFixed(1)} ms`)
		assert.ok(ticks >= 10, `timer ticks during the snapshot: ${ticks}`)
		assert.equal(core.counts.driftEvents, 0)
		console.log(`# snapshot 150k pending + 300k consumed: ${res.stats.totalMs.toFixed(0)} ms in ${res.stats.slices} slices, longest ${res.stats.maxSliceMs.toFixed(1)} ms`)
	} finally {
		clearInterval(timer)
		done(dir)
	}
})

// ------------------------------------------------------------------ counts reconcile
test('block counts are reconciled against the writer\'s own count of the frozen pending view: a drift is reported once and the live counts are corrected', async () => {
	const seen: string[] = []
	const core = new LabPayoutStateCore(
		{ pending: Array.from({ length: 300 }, (_, i) => entry(i, 1000 + (i % 40)) as PendingEntry), scalars: { freezeH: { height: 1500 } } },
		{ onDrift: (w) => seen.push(w) }
	)
	core.counts.add(1010) // a stray increment the pool never had
	core.counts.remove(1011) // and a lost one
	const dir = tmp()
	try {
		const src = core.freezeForSnapshot()
		core.pendingDelete(hex(5)) // a live change after the freeze
		const res = await writeSnapshotCooperative(src, { dir, mode: 'wal' })
		const fin = core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		assert.equal(fin.drift, true)
		assert.equal(core.counts.driftEvents, 1)
		assert.equal(seen.length, 1)
		// after the correction the counts equal a recount of the live pool
		const recount = new Map<number, number>()
		for (const e of core.pendingEntries()) recount.set(e.blockNumber as number, (recount.get(e.blockNumber as number) ?? 0) + 1)
		for (let b = 1000; b < 1040; b++) assert.equal(core.counts.ahead(b - 1) - core.counts.ahead(b), recount.get(b) ?? 0, `block ${b}`)
		assert.equal(core.histTotal, core.pendingSize)
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------------ failures: the previous committed state survives, nothing leaks
function listAll(dir: string): string[] {
	const out: string[] = []
	const walk = (d: string, rel: string): void => {
		for (const n of fs.readdirSync(d)) {
			const p = path.join(d, n)
			if (fs.statSync(p).isDirectory()) walk(p, path.join(rel, n))
			else out.push(path.join(rel, n))
		}
	}
	walk(dir, '')
	return out.sort()
}

test('ENOSPC on a write, a failed fsync, a failed rename, a failed manifest commit: the snapshot throws, the generation directory and tmp files are gone, the previous snapshot is still readable and the next snapshot works', async () => {
	const dir = tmp()
	try {
		// a first good snapshot
		const core = makeCore(900, 1200, 40)
		let src = core.freezeForSnapshot()
		let res = await writeSnapshotCooperative(src, { dir, mode: 'wal' })
		core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		const baseline = listAll(dir)
		const baselineManifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
		core.pendingSet(entry(77_777, 1100) as PendingEntry)
		core.applyEvent({ v: 1, seq: 41, ts: 't', t: 'x', ops: [{ op: 'consumedAdd', key: 'late' }] })
		const failures: { name: string; mk: () => SnapshotFs; hooks?: Record<string, () => void>; re: RegExp }[] = [
			{
				name: 'ENOSPC on the 3rd write',
				mk: () => {
					let n = 0
					return { ...nodeSnapshotFs, writeSync: (fd, b, o, l) => (++n === 3 ? ((): never => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) })() : nodeSnapshotFs.writeSync(fd, b, o, l)) }
				},
				re: /ENOSPC/,
			},
			{
				name: 'fsync failure on the 2nd file',
				mk: () => {
					let n = 0
					return { ...nodeSnapshotFs, fsyncSync: (fd) => (++n === 2 ? ((): never => { throw Object.assign(new Error('EIO: fsync failed'), { code: 'EIO' }) })() : nodeSnapshotFs.fsyncSync(fd)) }
				},
				re: /EIO/,
			},
			{
				name: 'rename failure on the consumed file',
				mk: () => ({ ...nodeSnapshotFs, renameSync: (a, b) => (b.endsWith('consumed.jsonl') ? ((): never => { throw new Error('EXDEV: rename failed') })() : nodeSnapshotFs.renameSync(a, b)) }),
				re: /EXDEV/,
			},
			{ name: 'manifest commit failure', mk: () => nodeSnapshotFs, hooks: { beforeManifestRename: () => { throw new Error('crash at the commit point') } }, re: /crash at the commit point/ },
		]
		for (const f of failures) {
			const s = core.freezeForSnapshot()
			const hooks = f.hooks ? { beforeManifestRename: f.hooks.beforeManifestRename } : undefined
			await assert.rejects(writeSnapshotCooperative(s, { dir, mode: 'wal', fs: f.mk(), hooks }), f.re, f.name)
			core.finishSnapshot(s, { committed: false })
			assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), baselineManifest, `${f.name}: the committed manifest is unchanged`)
			assert.deepEqual(listAll(dir), baseline, `${f.name}: no generation directory, no tmp file left`)
			assert.equal(loadCommittedForRecovery(dir).snapshotSeq, 40)
			// the live state kept every change (the overlay was folded back, nothing pruned)
			assert.equal(core.pendingHas(hex(77_777)), true, f.name)
			assert.equal(core.consumedHas('late'), true, f.name)
		}
		// the next snapshot after all those failures works and contains the late changes
		src = core.freezeForSnapshot()
		res = await writeSnapshotCooperative(src, { dir, mode: 'wal' })
		core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		const m = loadCommittedForRecovery(dir)
		assert.equal(m.snapshotSeq, 41)
		assert.equal(m.state.pending.some((p) => p.eventKey === hex(77_777)), true)
	} finally {
		done(dir)
	}
})

test('the owner merging or aborting the views under a running writer, or a WAL that is not durable, aborts the snapshot without touching the committed state', async () => {
	const dir = tmp()
	try {
		const core = makeCore(500, 800, 10)
		let s = core.freezeForSnapshot()
		let res = await writeSnapshotCooperative(s, { dir, mode: 'wal' })
		core.finishSnapshot(s, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		const manifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
		const files = listAll(dir)
		// 1. the owner aborts while the writer is between slices
		s = core.freezeForSnapshot()
		await assert.rejects(
			writeSnapshotCooperative(s, {
				dir,
				mode: 'wal',
				sliceMs: 0,
				yieldFn: async () => {
					if (core.snapshotInFlight) core.finishSnapshot(s, { committed: false })
					await immediate()
				},
			}),
			SnapshotAbortedError
		)
		assert.equal(core.snapshotInFlight, false)
		assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifest)
		assert.deepEqual(listAll(dir), files)
		// 2. the log is not durable up to walSeq: waitDurable rejects, nothing is committed; and it is awaited right before the commit, after all files
		s = core.freezeForSnapshot()
		const order: string[] = []
		await assert.rejects(
			writeSnapshotCooperative(s, {
				dir,
				mode: 'wal',
				hooks: { afterFile: (f) => order.push(`file:${path.basename(f)}`) },
				waitDurable: async (seq) => {
					order.push(`wait:${seq}`)
					throw new Error('wal fsync failed')
				},
			}),
			/wal fsync failed/
		)
		assert.equal(order[order.length - 1], 'wait:40', 'waitDurable runs after every data file and before the commit')
		core.finishSnapshot(s, { committed: false })
		assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifest)
		assert.deepEqual(listAll(dir), files)
		// 3. a second freeze while one is in flight is refused
		s = core.freezeForSnapshot()
		assert.throws(() => core.freezeForSnapshot(), /already in flight/)
		core.finishSnapshot(s, { committed: false })
		assert.throws(() => core.finishSnapshot(s, { committed: false }), /not the one in flight/)
		res = res // keep the linter quiet about the reassignment above
	} finally {
		done(dir)
	}
})
