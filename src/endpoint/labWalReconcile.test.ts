/**
 * The offline, audited "book these keys as paid" command (runbook G-1). Local temp dirs only.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { acquireStateDirLock } from './labClPayoutStateLock'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { view } from './labPayoutTestSupport'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WAL_DIR, WalWriter, applyOps, listSegments, segmentFileName, type WalOp } from './labWal'
import { MAX_RECONCILE_KEYS, parseKeysFile, reconcileKeys } from './labWalReconcile'
import { repairMidCorruption } from './labWalRepair'

const hex = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
const K = [hex(0xa1), hex(0xa2), hex(0xa3)]
const tx = (n: number): string => hex(0xf00 + n)
const RUN = 'run-20261121-rec1'
const APPROVAL = 'PM-2026-11-21-02'
const fatal = (e: Error): void => {
	throw e
}

type World = { root: string; stateDir: string; auditDir: string; keysFile: string }

/** A WAL-mode state dir: snapshot at seq 0 (freezeH 500), then the given events through the core and the log. Returns after the writer is closed. */
async function world(events: { t: string; ops: WalOp[] }[], scalars: Record<string, unknown> = {}): Promise<World> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labreconcile-'))
	const stateDir = path.join(root, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 }, ...scalars } })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 100000, onFatal: fatal })
	const ps: Promise<void>[] = []
	for (const e of events) ps.push(core.record(wal, e.t, e.ops).durable)
	await Promise.all(ps)
	await wal.close()
	const keysFile = path.join(root, 'keys.json')
	return { root, stateDir, auditDir: path.join(root, 'audit'), keysFile }
}
const done = (w: World): void => fs.rmSync(w.root, { recursive: true, force: true })

const ADD3: { t: string; ops: WalOp[] } = {
	t: 'scan',
	ops: [
		{ op: 'pendingAdd', entry: { eventKey: K[0]!, blockNumber: 100, withdrawalIndex: 0, amount: '1000' } },
		{ op: 'pendingAdd', entry: { eventKey: K[1]!, blockNumber: 120, withdrawalIndex: 1, amount: '2000' } },
		{ op: 'pendingAdd', entry: { eventKey: K[2]!, blockNumber: 700, withdrawalIndex: 0, amount: '3000' } },
		{ op: 'scalarsSet', patch: { historyCursor: 200 } },
	],
}
const REVIEWERS = ['alice@ops', 'bob@ops']
const writeKeys = (w: World, list: object[], reviewers: unknown = REVIEWERS): void => fs.writeFileSync(w.keysFile, JSON.stringify({ reviewers, entries: list }, null, 2))
const entryFor = (k: string, i: number): Record<string, unknown> => ({ eventKey: k, txHash: tx(i), blockNumber: 9000 + i, amountWei: String(1000 * (i + 1)), txTotalWei: String(1000 * (i + 1)), nonce: 40 + i })
const args = (w: World, over: Partial<Parameters<typeof reconcileKeys>[0]> = {}): Parameters<typeof reconcileKeys>[0] => ({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: APPROVAL, keysFile: w.keysFile, ...over })
const walFiles = (w: World): string[] => listSegments(path.join(w.stateDir, WAL_DIR)).map((s) => s.file)

test('dry-run prints the audit (classification, the single event, the derived maxPaidHistoryBlock) and changes nothing: no lock, no files, no event', async () => {
	const w = await world([ADD3])
	try {
		writeKeys(w, [entryFor(K[0]!, 0), entryFor(K[1]!, 1)])
		const before = walFiles(w)
		const held = acquireStateDirLock(w.stateDir) // a dry run does not need the lock
		try {
			const r = await reconcileKeys(args(w, { dryRun: true }))
			assert.equal(r.status, 'dry-run')
			if (r.status !== 'dry-run') return
			assert.equal(r.audit.eventSeq, 2)
			assert.equal(r.audit.lastSeqBefore, 1)
			assert.deepEqual(r.audit.counts, { wasPending: 2, alreadyConsumed: 0, neither: 0 })
			assert.equal(r.audit.maxPaidHistoryBlock, 120)
			assert.equal(r.audit.historyCursor, 200)
			assert.equal(r.audit.maxPaidAboveCursor, false)
			assert.equal(r.audit.ops, 5)
			assert.equal(r.audit.approvalVerified, false)
			assert.equal(r.audit.copyFile, null)
		} finally {
			held.release()
		}
		assert.deepEqual(walFiles(w), before)
		assert.equal(fs.existsSync(w.auditDir), false)
	} finally {
		done(w)
	}
})

test('append: one manual-reconcile event; after recovery the keys are consumed and no longer pending (so they cannot be claimed again), the others are untouched, the audit and the verbatim keys copy exist, the .done record names the event', async () => {
	const w = await world([ADD3])
	try {
		writeKeys(w, [entryFor(K[0]!, 0), entryFor(K[1]!, 1)])
		const before = recoverPayoutState(w.stateDir, { readOnly: true }).core
		assert.equal(before.pendingHas(K[0]!), true)
		const r = await reconcileKeys(args(w))
		assert.equal(r.status, 'appended')
		if (r.status !== 'appended') return
		assert.equal(r.eventSeq, 2)
		const rec = recoverPayoutState(w.stateDir)
		assert.equal(rec.core.lastAppliedSeq, 2)
		assert.equal(rec.replayed, 2)
		for (const k of [K[0]!, K[1]!]) {
			assert.equal(rec.core.consumedHas(k), true, 'consumed after the restart')
			assert.equal(rec.core.pendingHas(k), false, 'no longer pending: it cannot be selected for payment')
		}
		assert.equal(rec.core.pendingHas(K[2]!), true)
		assert.equal(rec.core.consumedHas(K[2]!), false)
		assert.equal(rec.core.getScalar('maxPaidHistoryBlock'), 120)
		assert.equal(rec.core.getScalar('historyCursor'), 200)
		assert.equal(rec.core.histTotal, 0, 'the history count follows: k1/k2 gone; k3 (block 700) is realtime')
		assert.deepEqual(rec.warnings, [])
		// audit files
		const a = JSON.parse(fs.readFileSync(r.auditFile, 'utf8'))
		assert.equal(a.runId, RUN)
		assert.equal(a.keyCount, 2)
		assert.equal(a.keys[0].txHash, tx(0))
		assert.deepEqual(fs.readFileSync(path.join(w.auditDir, `wal-reconcile-${RUN}.keys.json`)), fs.readFileSync(w.keysFile), 'verbatim copy of the input')
		assert.equal(a.keysFileSha256, createHash('sha256').update(fs.readFileSync(w.keysFile)).digest('hex'))
		const d = JSON.parse(fs.readFileSync(r.doneFile, 'utf8'))
		assert.equal(d.eventSeq, 2)
		assert.equal(d.segmentFile, segmentFileName(2))
		assert.equal(d.segmentSha256, createHash('sha256').update(fs.readFileSync(path.join(w.stateDir, WAL_DIR, d.segmentFile))).digest('hex'))
		// the original segment was not touched: events 1 is still in wal-1
		assert.deepEqual(walFiles(w), [segmentFileName(1), segmentFileName(2)])
	} finally {
		done(w)
	}
})

test('replay is idempotent: recovering twice, applying the event again, and applying its ops again leave the state unchanged', async () => {
	const w = await world([ADD3])
	try {
		writeKeys(w, [entryFor(K[0]!, 0), entryFor(K[1]!, 1)])
		await reconcileKeys(args(w))
		const a = recoverPayoutState(w.stateDir, { readOnly: true })
		const b = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(view(a.core), view(b.core))
		const snap = view(a.core)
		a.core.applyEvent({ v: 1, seq: 2, ts: 't', t: 'manual-reconcile', ops: [{ op: 'consumedAdd', key: K[0]! }, { op: 'pendingDel', key: K[0]! }] }) // seq <= applied: skipped
		assert.equal(view(a.core), snap)
		applyOps(a.core, [{ op: 'consumedAdd', key: K[0]! }, { op: 'pendingDel', key: K[0]! }, { op: 'consumedAdd', key: K[1]! }, { op: 'pendingDel', key: K[1]! }, { op: 'scalarsSet', patch: { maxPaidHistoryBlock: 120 } }])
		assert.equal(view(a.core), snap)
	} finally {
		done(w)
	}
})

test('the state-directory lock: refused while held (nothing appended, no audit written); released afterwards', async () => {
	const w = await world([ADD3])
	try {
		writeKeys(w, [entryFor(K[0]!, 0)])
		const before = walFiles(w)
		const held = acquireStateDirLock(w.stateDir)
		try {
			await assert.rejects(reconcileKeys(args(w)), /cannot take the state directory lock.*stop the daemon first.*Nothing was changed/s)
		} finally {
			held.release()
		}
		assert.deepEqual(walFiles(w), before)
		assert.equal(fs.existsSync(w.auditDir), false)
		const r = await reconcileKeys(args(w))
		assert.equal(r.status, 'appended')
		acquireStateDirLock(w.stateDir).release() // the command released its own lock
	} finally {
		done(w)
	}
})

test('an audit write failure appends nothing; a crash between the audit and the append leaves the log unchanged and burns the run id; a repeated run id is refused before anything is appended', async () => {
	const w = await world([ADD3])
	try {
		writeKeys(w, [entryFor(K[0]!, 0)])
		const before = walFiles(w)
		// 1. the audit directory cannot be written
		fs.mkdirSync(w.auditDir, { mode: 0o500 })
		await assert.rejects(reconcileKeys(args(w)), /EACCES|EPERM/)
		fs.chmodSync(w.auditDir, 0o700)
		assert.deepEqual(walFiles(w), before, 'no event appended after a failed audit write')
		assert.deepEqual(fs.readdirSync(w.auditDir), [])
		// 2. a crash after the audit files are durable and before the append
		await assert.rejects(
			reconcileKeys(args(w, { hooks: { beforeAppend: () => { throw new Error('crash before the append') } } })),
			/crash before the append/
		)
		assert.deepEqual(walFiles(w), before)
		assert.ok(fs.existsSync(path.join(w.auditDir, `wal-reconcile-${RUN}.json`)), 'the audit stays as evidence of the attempt')
		// 3. the same run id again: refused, still nothing appended
		await assert.rejects(reconcileKeys(args(w)), /already used|EEXIST/)
		assert.deepEqual(walFiles(w), before)
		// a new run id works
		const ok = await reconcileKeys(args(w, { runId: 'run-20261121-rec2' }))
		assert.equal(ok.status, 'appended')
		// and the first run id is still burned after a success elsewhere
		await assert.rejects(reconcileKeys(args(w)), /already used|EEXIST/)
		assert.equal(walFiles(w).length, 2)
	} finally {
		fs.chmodSync(w.auditDir, 0o700)
		done(w)
	}
})

test('a successful run id cannot be used twice: the second run appends no second event', async () => {
	const w = await world([ADD3])
	try {
		writeKeys(w, [entryFor(K[0]!, 0)])
		await reconcileKeys(args(w))
		await assert.rejects(reconcileKeys(args(w)), /already used/)
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).core.lastAppliedSeq, 2)
	} finally {
		done(w)
	}
})

test('the keys file is validated before anything is touched: format, lower-case hex, evidence fields, no duplicates, unknown fields, size', async () => {
	const w = await world([ADD3])
	try {
		const good = entryFor(K[0]!, 0) as Record<string, unknown>
		const bad: [string, unknown, RegExp][] = [
			['not an object', [good], /must be a JSON object/],
			['empty', [], /must be a JSON object/],
			['entries not an array', { reviewers: REVIEWERS, entries: { a: 1 } }, /non-empty JSON array/],
			['entries empty', { reviewers: REVIEWERS, entries: [] }, /non-empty JSON array/],
			['no reviewers', { entries: [good] }, /exactly two ids/],
			['one reviewer', { reviewers: ['alice@ops'], entries: [good] }, /exactly two ids/],
			['same reviewer twice', { reviewers: ['alice@ops', 'ALICE@ops'], entries: [good] }, /must be different people/],
			['bad reviewer id', { reviewers: ['a', 'bob@ops'], entries: [good] }, /exactly two ids/],
			['unknown top-level field', { reviewers: REVIEWERS, entries: [good], extra: 1 }, /unknown top-level field/],
			['upper-case key', { reviewers: REVIEWERS, entries: [{ ...good, eventKey: K[0]!.toUpperCase().replace('0X', '0x') }] }, /LOWER-case/],
			['short key', { reviewers: REVIEWERS, entries: [{ ...good, eventKey: '0x12' }] }, /eventKey must be/],
			['no tx hash', { reviewers: REVIEWERS, entries: [{ ...good, txHash: undefined }] }, /txHash/],
			['bad tx hash', { reviewers: REVIEWERS, entries: [{ ...good, txHash: '0xabc' }] }, /txHash/],
			['block 0', { reviewers: REVIEWERS, entries: [{ ...good, blockNumber: 0 }] }, /blockNumber/],
			['fractional block', { reviewers: REVIEWERS, entries: [{ ...good, blockNumber: 1.5 }] }, /blockNumber/],
			['amount 0', { reviewers: REVIEWERS, entries: [{ ...good, amountWei: '0' }] }, /amountWei/],
			['amount with a leading zero', { reviewers: REVIEWERS, entries: [{ ...good, amountWei: '01' }] }, /amountWei/],
			['negative amount', { reviewers: REVIEWERS, entries: [{ ...good, amountWei: '-5' }] }, /amountWei/],
			['numeric amount', { reviewers: REVIEWERS, entries: [{ ...good, amountWei: 5 }] }, /amountWei/],
			['unknown field', { reviewers: REVIEWERS, entries: [{ ...good, extra: 1 }] }, /unknown field "extra"/],
			['long note', { reviewers: REVIEWERS, entries: [{ ...good, note: 'x'.repeat(501) }] }, /note/],
			['duplicate key', { reviewers: REVIEWERS, entries: [good, { ...good, txHash: tx(9) }] }, /duplicate eventKey/],
			['not an object', { reviewers: REVIEWERS, entries: [5] }, /not an object/],
		]
		for (const [name, list, re] of bad) {
			fs.writeFileSync(w.keysFile, JSON.stringify(list))
			await assert.rejects(reconcileKeys(args(w)), re, name)
			assert.equal(fs.existsSync(w.auditDir), false, `${name}: nothing written`)
		}
		fs.writeFileSync(w.keysFile, '{not json')
		await assert.rejects(reconcileKeys(args(w)), /not valid JSON/)
		assert.throws(() => parseKeysFile(JSON.stringify({ reviewers: REVIEWERS, entries: Array.from({ length: MAX_RECONCILE_KEYS + 1 }, (_, i) => entryFor(hex(0x10000 + i), i)) })), /more than 20000 keys/)
		assert.equal(parseKeysFile(JSON.stringify({ reviewers: REVIEWERS, entries: [good, { ...entryFor(K[1]!, 1), note: 'matched in tx ' + tx(1) }] })).entries.length, 2)
		assert.equal(walFiles(w).length, 1)
		// arguments
		for (const [name, over, re] of [
			['run id', { runId: 'short' }, /run id is required/],
			['approval', { approval: '' }, /approval reference/],
			['audit dir', { auditDir: '' }, /audit directory is required/],
			['keys file', { keysFile: '' }, /keys file is required/],
			['audit dir inside the state dir', { auditDir: join(w.stateDir, 'audit') }, /OUTSIDE the state directory/],
		] as const) await assert.rejects(reconcileKeys(args(w, over)), re, name)
	} finally {
		done(w)
	}
})

test('it refuses to append behind a torn tail or past mid-log damage (repair first) and changes nothing', async () => {
	const w = await world([ADD3, { t: 'x', ops: [{ op: 'consumedAdd', key: 'later' }] }, { t: 'y', ops: [{ op: 'consumedAdd', key: 'later2' }] }])
	try {
		writeKeys(w, [entryFor(K[0]!, 0)])
		const file = path.join(w.stateDir, WAL_DIR, segmentFileName(1))
		const intact = fs.readFileSync(file)
		// torn tail: half a frame appended
		fs.writeFileSync(file, Buffer.concat([intact, Buffer.from([0x57, 0x4c, 0x20, 0, 0, 0, 1, 2])]))
		const torn = fs.readFileSync(file)
		await assert.rejects(reconcileKeys(args(w)), /torn tail/)
		assert.deepEqual(fs.readFileSync(file), torn)
		// mid-log damage
		const dmg = Buffer.from(intact)
		dmg[40] = dmg[40]! ^ 0x55
		fs.writeFileSync(file, dmg)
		await assert.rejects(reconcileKeys(args(w)), /damage in the middle/)
		assert.deepEqual(fs.readFileSync(file), dmg)
		assert.equal(fs.existsSync(w.auditDir), false)
	} finally {
		done(w)
	}
})

test('G-1 end to end: the settle was lost in a damaged log - after the audited repair the paid keys are pending again (the re-pay hazard); after the reconcile they are consumed and not pending, and the rest of the pool is untouched', async () => {
	const rec1 = { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '3000', eventKeys: [K[0], K[1]] }
	const w = await world([
		ADD3,
		{ t: 'intent', ops: [{ op: 'inFlightSet', record: rec1 }] },
		{ t: 'settle', ops: [{ op: 'consumedAdd', key: K[0]! }, { op: 'consumedAdd', key: K[1]! }, { op: 'pendingDel', key: K[0]! }, { op: 'pendingDel', key: K[1]! }, { op: 'inFlightSet', record: null }, { op: 'scalarsSet', patch: { maxPaidHistoryBlock: 120, settledBatchCount: 1 } }] },
	])
	try {
		// damage frame 2 (the intent): frame 3 (the settle) is a valid frame behind it
		const file = path.join(w.stateDir, WAL_DIR, segmentFileName(1))
		const buf = fs.readFileSync(file)
		let off = 0
		const starts: number[] = []
		for (let i = 0; i < 3; i++) {
			starts.push(off)
			off += 10 + buf.readUInt32LE(off + 2)
		}
		buf[starts[1]! + 12] = buf[starts[1]! + 12]! ^ 0x40
		fs.writeFileSync(file, buf)
		const rep = repairMidCorruption({ stateDir: w.stateDir, auditDir: path.join(w.root, 'repair-audit'), runId: 'run-20261121-rep1', approval: APPROVAL })
		assert.equal(rep.status, 'repaired')
		if (rep.status !== 'repaired') return
		assert.equal(rep.audit.lostEventsAtLeast, 2, 'the undecodable intent and the settle are lost')
		const hazard = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(hazard.core.pendingHas(K[0]!), true, 'HAZARD: the paid key is pending again')
		assert.equal(hazard.core.consumedHas(K[0]!), false)
		// the human reconciled both keys against the signer record and the chain, and lists them with the evidence
		writeKeys(w, [entryFor(K[0]!, 0), entryFor(K[1]!, 1)])
		const r = await reconcileKeys(args(w))
		assert.equal(r.status, 'appended')
		if (r.status !== 'appended') return
		assert.equal(r.eventSeq, 2, 'the event continues right after the last intact event (seq 1)')
		const after = recoverPayoutState(w.stateDir)
		assert.deepEqual(after.warnings, [])
		for (const k of [K[0]!, K[1]!]) {
			assert.equal(after.core.consumedHas(k), true)
			assert.equal(after.core.pendingHas(k), false)
		}
		assert.equal(after.core.pendingHas(K[2]!), true)
		assert.equal(after.core.getScalar('maxPaidHistoryBlock'), 120)
		assert.equal(after.core.getInFlight(), null)
	} finally {
		done(w)
	}
})

test('a listed key that belongs to the current in-flight record REFUSES the run (dry-run reports it without failing); the refusal names the keys and the batch, appends nothing, does not use up the run id; once the in-flight record is cleared the same list runs', async () => {
	const rec1 = { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '3000', eventKeys: [K[0], K[1]], hash: '0xdead' }
	const w = await world([{ t: 'scan', ops: ADD3.ops.slice(0, 3).concat([{ op: 'scalarsSet', patch: { historyCursor: 110 } }]) }, { t: 'intent', ops: [{ op: 'inFlightSet', record: rec1 }] }])
	try {
		writeKeys(w, [entryFor(K[0]!, 0), entryFor(K[2]!, 2)]) // K[0] overlaps, K[2] does not
		const before = walFiles(w)
		const dry = await reconcileKeys(args(w, { dryRun: true }))
		if (dry.status !== 'dry-run') throw new Error('expected a dry run')
		assert.equal(dry.audit.refused, true)
		assert.deepEqual(dry.audit.inFlightOverlap, [K[0]])
		assert.deepEqual(dry.audit.inFlightBatch, { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '3000', eventKeyCount: 2, hash: '0xdead' })
		assert.match(dry.audit.note, /REFUSED: 1 listed key\(s\) belong to the current in-flight record \(batch b1\)/)
		// the real run refuses, names the keys and the batch, appends nothing
		await assert.rejects(reconcileKeys(args(w)), new RegExp(`REFUSED: 1 listed key\\(s\\) belong to the in-flight batch b1 \\(${K[0]}\\).*Nothing was appended`, 's'))
		assert.deepEqual(walFiles(w), before)
		const names = fs.readdirSync(w.auditDir)
		assert.equal(names.length, 1, 'only the refusal record exists')
		assert.match(names[0]!, new RegExp(`^wal-reconcile-${RUN}\\.refused-.*\\.json$`))
		const refused = JSON.parse(fs.readFileSync(path.join(w.auditDir, names[0]!), 'utf8'))
		assert.equal(refused.refused, true)
		assert.deepEqual(refused.inFlightOverlap, [K[0]])
		assert.equal(refused.inFlightBatch.batchId, 'b1')
		// the list has no overlap with a record for other keys: runs. (a list with only non-overlapping keys is fine while the batch is in flight)
		writeKeys(w, [entryFor(K[2]!, 2)])
		const okWhileInFlight = await reconcileKeys(args(w, { runId: 'run-20261121-rec9' }))
		assert.equal(okWhileInFlight.status, 'appended')
		// bring the in-flight batch to a final state (the daemon's normal recovery would settle or release it): append a release event as the daemon would
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		const wal = new WalWriter({ stateDir: w.stateDir, lastSeq: rec.writerLastSeq, onFatal: fatal })
		await wal.append('release', [{ op: 'inFlightSet', record: null }]).durable
		await wal.close()
		assert.equal(recoverPayoutState(w.stateDir, { readOnly: true }).core.getInFlight(), null)
		// the refused run id is still usable: the same overlapping list now runs
		writeKeys(w, [entryFor(K[0]!, 0), entryFor(K[1]!, 1)])
		const r = await reconcileKeys(args(w))
		assert.equal(r.status, 'appended')
		if (r.status !== 'appended') return
		assert.equal(r.audit.refused, false)
		assert.deepEqual(r.audit.inFlightOverlap, [])
		assert.equal(r.audit.maxPaidHistoryBlock, 120)
		assert.equal(r.audit.maxPaidAboveCursor, true, 'history cursor is 110: the derived high-water 120 is flagged (invariant C)')
		assert.match(r.audit.note, /WARNING: the derived maxPaidHistoryBlock is above historyCursor/)
		const after = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.ok(after.warnings.some((x) => /maxPaidHistoryBlock 120 is above historyCursor 110/.test(x)), 'recovery reports the invariant warning, nothing hides it')
		assert.equal(after.core.consumedHas(K[0]!), true)
		assert.equal(after.core.pendingHas(K[0]!), false)
	} finally {
		done(w)
	}
})

test('keys that are already consumed or unknown are still booked (classified in the audit); a key list may not exceed the cap; the daemon and the other recovery modules never reference this command', async () => {
	const w = await world([ADD3, { t: 'x', ops: [{ op: 'consumedAdd', key: hex(0xb1) }] }])
	try {
		writeKeys(w, [entryFor(hex(0xb1), 3), { ...entryFor(hex(0xb2), 4), note: 'unknown to the state; paid in tx f04 per the signer record' }, entryFor(K[0]!, 0)])
		const dry = await reconcileKeys(args(w, { dryRun: true }))
		if (dry.status !== 'dry-run') throw new Error('expected a dry run')
		assert.deepEqual(dry.audit.counts, { wasPending: 1, alreadyConsumed: 1, neither: 1 })
		await reconcileKeys(args(w))
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(rec.core.consumedHas(hex(0xb2)), true, 'an unknown key is booked as consumed so the scan cannot re-queue it')
	} finally {
		done(w)
	}
	for (const f of ['validatorLabMiningPoolClPayoutReporter.ts', 'labPayoutRecovery.ts', 'labPayoutStateCore.ts', 'labSnapshotWriter.ts', 'labWal.ts', 'labMiningPoolClPayoutDaemon.ts']) {
		const src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		assert.doesNotMatch(src, /labWalReconcile|reconcileKeys/, f)
	}
	const own = fs.readFileSync(path.join(__dirname, 'labWalReconcile.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
	assert.doesNotMatch(own, /process\.env/, 'no environment variable is read')
})

test('CLI: missing --keys-file or run id exits 2 and touches nothing; --dry-run works and prints the audit; the environment is irrelevant', async () => {
	const w = await world([ADD3])
	try {
		writeKeys(w, [entryFor(K[0]!, 0)])
		const script = join(__dirname, 'labWalReconcile.ts')
		const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
		const run = (a: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [...loader, script, ...a], { encoding: 'utf8', env })
		const before = walFiles(w)
		const noKeys = run(['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', RUN, '--approval', APPROVAL])
		assert.equal(noKeys.status, 2)
		assert.match(noKeys.stderr, /keys file is required/)
		const swallowed = run(['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', '--approval', APPROVAL, '--keys-file', w.keysFile])
		assert.equal(swallowed.status, 2)
		assert.match(swallowed.stderr, /--run-id needs a value/)
		const dry = run(['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', RUN, '--approval', APPROVAL, '--keys-file', w.keysFile, '--dry-run'], { ...process.env, CONET_LAB_WAL_RECONCILE: '1' })
		assert.equal(dry.status, 0, dry.stderr)
		assert.equal(JSON.parse(dry.stdout).status, 'dry-run')
		assert.deepEqual(walFiles(w), before)
		const real = run(['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', RUN, '--approval', APPROVAL, '--keys-file', w.keysFile])
		assert.equal(real.status, 0, real.stderr)
		assert.equal(JSON.parse(real.stdout).status, 'appended')
		assert.equal(walFiles(w).length, 2)
	} finally {
		done(w)
	}
})

// ------------------------------------------------------------ review R9 / R10
test('R9: offline self-check per tx hash - a declared amount that differs from the pending entry, a foreign pending key mixed into a tx, inconsistent group fields, and an unexplained key all REFUSE before anything is touched; a correct multi-key tx passes', async () => {
	const w = await world([ADD3])
	try {
		const before = walFiles(w)
		const refuse = async (name: string, list: object[], re: RegExp): Promise<void> => {
			writeKeys(w, list)
			await assert.rejects(reconcileKeys(args(w)), re, name)
			assert.deepEqual(walFiles(w), before, `${name}: nothing appended`)
			assert.equal(fs.existsSync(w.auditDir), false, `${name}: nothing written`)
		}
		// the reviewer's cases: declared amount 999 for a key whose pending entry is 1000
		await refuse('declared amount differs from pending', [{ ...entryFor(K[0]!, 0), amountWei: '999', txTotalWei: '999' }], /declared amountWei 999 differs from the pending entry's amount 1000/)
		// a pending key that was never paid mixed into the same tx: the total of the tx (K0+K1 = 3000) no longer matches (K0+K1+K2 = 6000)
		const tx0 = tx(77)
		await refuse(
			'foreign pending key in the tx',
			[
				{ eventKey: K[0], txHash: tx0, blockNumber: 9000, amountWei: '1000', txTotalWei: '3000', nonce: 41 },
				{ eventKey: K[1], txHash: tx0, blockNumber: 9000, amountWei: '2000', txTotalWei: '3000', nonce: 41 },
				{ eventKey: K[2], txHash: tx0, blockNumber: 9000, amountWei: '3000', txTotalWei: '3000', nonce: 41 },
			],
			/keys add up to 6000 wei \(pending 6000 \+ declared 0\) but the tx total is 3000/
		)
		await refuse('group declares different totals', [{ eventKey: K[0], txHash: tx0, blockNumber: 9000, amountWei: '1000', txTotalWei: '3000' }, { eventKey: K[1], txHash: tx0, blockNumber: 9000, amountWei: '2000', txTotalWei: '3001' }], /different txTotalWei/)
		await refuse('group declares different blocks', [{ eventKey: K[0], txHash: tx0, blockNumber: 9000, amountWei: '1000', txTotalWei: '3000' }, { eventKey: K[1], txHash: tx0, blockNumber: 9001, amountWei: '2000', txTotalWei: '3000' }], /different blockNumbers/)
		await refuse('group declares different nonces', [{ eventKey: K[0], txHash: tx0, blockNumber: 9000, amountWei: '1000', txTotalWei: '3000', nonce: 1 }, { eventKey: K[1], txHash: tx0, blockNumber: 9000, amountWei: '2000', txTotalWei: '3000', nonce: 2 }], /different nonces/)
		await refuse('unknown key without an explanation', [entryFor(hex(0xc7), 5)], /neither pending nor consumed.*needs a note/)
		await refuse('unknown key with a too-short note', [{ ...entryFor(hex(0xc7), 5), note: 'short' }], /needs a note/)
		// a correct two-key tx passes: 1000 + 2000 = 3000, one tx, one nonce
		writeKeys(w, [{ eventKey: K[0], txHash: tx0, blockNumber: 9000, amountWei: '1000', txTotalWei: '3000', nonce: 41 }, { eventKey: K[1], txHash: tx0, blockNumber: 9000, amountWei: '2000', txTotalWei: '3000', nonce: 41 }])
		const r = await reconcileKeys(args(w, { dryRun: true }))
		if (r.status !== 'dry-run') throw new Error('expected a dry run')
		assert.deepEqual(r.audit.txGroups, [{ txHash: tx0, blockNumber: 9000, nonce: 41, txTotalWei: '3000', keyCount: 2, pendingSumWei: '3000', declaredOtherSumWei: '0', sumWei: '3000', ok: true }])
		assert.deepEqual(r.audit.reviewers, REVIEWERS)
		assert.match(r.audit.reviewersNote, /plain strings.*cannot verify/)
		// an unknown key WITH an explanation passes and is listed separately; a mixed tx (pending + unknown) adds the declared amount of the unknown one
		writeKeys(w, [
			{ eventKey: K[0], txHash: tx0, blockNumber: 9000, amountWei: '1000', txTotalWei: '1500' },
			{ eventKey: hex(0xc8), txHash: tx0, blockNumber: 9000, amountWei: '500', txTotalWei: '1500', note: 'state lost the pendingAdd; amount from the chain tx logs' },
		])
		const m = await reconcileKeys(args(w, { dryRun: true }))
		if (m.status !== 'dry-run') throw new Error('expected a dry run')
		assert.equal(m.audit.txGroups[0]!.sumWei, '1500')
		assert.deepEqual(m.audit.unverifiableOffline, [{ eventKey: hex(0xc8), amountWei: '500', note: 'state lost the pendingAdd; amount from the chain tx logs' }])
	} finally {
		done(w)
	}
})

test('R10: the event carries the corrected absolute settledBatchCount (recorded + distinct tx hashes that are not already fully consumed); the audit prints before/after, the distinct counts and the declared nonces', async () => {
	const w = await world([ADD3, { t: 'settle', ops: [{ op: 'consumedAdd', key: hex(0xd1) }, { op: 'scalarsSet', patch: { settledBatchCount: 7 } }] }])
	try {
		writeKeys(w, [entryFor(K[0]!, 0), entryFor(K[1]!, 1), entryFor(hex(0xd1), 2)]) // d1 is consumed already (its settle survived): that tx is not counted again
		const dry = await reconcileKeys(args(w, { dryRun: true }))
		if (dry.status !== 'dry-run') throw new Error('expected a dry run')
		assert.equal(dry.audit.settledBatchCountBefore, 7)
		assert.equal(dry.audit.distinctTxHashes, 3)
		assert.equal(dry.audit.distinctTxHashesCounted, 2)
		assert.equal(dry.audit.settledBatchCountAfter, 9)
		assert.deepEqual(dry.audit.nonces, [40, 41, 42])
		assert.match(dry.audit.nonceNote, /declared nonces \(40, 41, 42\)/)
		const r = await reconcileKeys(args(w))
		assert.equal(r.status, 'appended')
		const rec = recoverPayoutState(w.stateDir, { readOnly: true })
		assert.equal(rec.core.getScalar('settledBatchCount'), 9, 'the corrected count is what a restart reads (the reviewer reproduced 7 where 8 was right)')
		// idempotent: applying the same event again does not move it (absolute, max-merged)
		applyOps(rec.core, [{ op: 'scalarsSet', patch: { settledBatchCount: 9 } }])
		assert.equal(rec.core.getScalar('settledBatchCount'), 9)
	} finally {
		done(w)
	}
})
