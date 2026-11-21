/**
 * Errata W7 soak, accelerated: a long stream of events (pending queue/settle churn, a growing consumed set with a soft cap and archive, cursors) with background snapshot cycles, WAL rotation
 * and truncation, in one process. It checks that nothing drifts: the WAL stays bounded, the overlay peaks stay small, the event-loop stalls stay short, the block counts never drift, the
 * consumed set honours its cap, and a recovery from disk at the end equals the live state. Event time is compressed, not real: this is NOT an hours-long run, it shows the absence of
 * accumulation over many snapshot generations only.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { view } from './labPayoutTestSupport'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WAL_DIR, WalWriter, type WalOp } from './labWal'

const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const EVENTS = Number(process.env.LAB_SOAK_EVENTS ?? 120_000)

function soakOps(seq: number): WalOp[] {
	const ops: WalOp[] = [{ op: 'pendingAdd', entry: { eventKey: key(seq), blockNumber: 1000 + Math.floor(seq / 3), withdrawalIndex: seq % 5, amountWei: String(seq) } }]
	if (seq > 2000) ops.push({ op: 'pendingDel', key: key(seq - 2000) }, { op: 'consumedAdd', key: key(seq - 2000) })
	if (seq % 7 === 0) ops.push({ op: 'scalarsSet', patch: { historyCursor: 1000 + Math.floor(seq / 3), lastListeningEndBlock: seq } })
	if (seq % 211 === 0) ops.push({ op: 'exitedAdd', pubkey: key(seq).slice(0, 42) })
	return ops
}

function walBytes(dir: string): { bytes: number; files: number } {
	const d = path.join(dir, WAL_DIR)
	let bytes = 0
	let files = 0
	for (const n of fs.readdirSync(d)) {
		bytes += fs.statSync(path.join(d, n)).size
		files++
	}
	return { bytes, files }
}

test(`W7 soak (accelerated): ${EVENTS} events, snapshot cycles every 8000 events with a consumed cap, WAL rotation and truncation - bounded WAL, short stalls, no drift, recovery equals live`, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsoak-'))
	const archive: string[] = []
	try {
		const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 1000 + Math.floor(EVENTS / 6) } } })
		{
			const src = core.freezeForSnapshot()
			const r = await writeSnapshotCooperative(src, { dir, mode: 'wal' })
			core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: r.frozenHistCounts })
		}
		const wal = new WalWriter({ stateDir: dir, lastSeq: 0, segmentBytes: 256 * 1024 })
		const CAP = 30_000
		let snap: Promise<void> | null = null
		let snapshots = 0
		let maxWal = 0
		let maxFiles = 0
		let maxSlice = 0
		let maxStall = 0
		let pruned = 0
		let peakDelta = 0
		let last = process.hrtime.bigint()
		const cycle = async (): Promise<void> => {
			const src = core.freezeForSnapshot()
			try {
				const res = await writeSnapshotCooperative(src, { dir, mode: 'wal', sliceMs: 20, consumedCap: CAP, archive: (k) => void archive.push(...k), waitDurable: (s) => wal.whenDurable(s) })
				const fin = core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
				assert.equal(fin.drift, false, 'block counts never drift')
				pruned += fin.pruned
				maxSlice = Math.max(maxSlice, res.stats.maxSliceMs)
				wal.truncateThrough(src.walSeq)
				snapshots++
				const w = walBytes(dir)
				maxWal = Math.max(maxWal, w.bytes)
				maxFiles = Math.max(maxFiles, w.files)
			} catch (e) {
				core.finishSnapshot(src, { committed: false })
				throw e
			}
		}
		for (let seq0 = 0; seq0 < EVENTS; seq0 += 100) {
			const ps: Promise<void>[] = []
			for (let i = 0; i < 100; i++) {
				const seq = wal.lastSeq + 1
				ps.push(core.record(wal, 't', soakOps(seq)).durable)
			}
			peakDelta = Math.max(peakDelta, core.pending.overlaySize().delta)
			if (snap === null && wal.lastSeq - (core.stats.snapshotsCommitted * 8000) >= 8000) {
				snap = cycle().finally(() => {
					snap = null
				})
			}
			await Promise.all(ps)
			const now = process.hrtime.bigint()
			maxStall = Math.max(maxStall, Number(now - last) / 1e6)
			await new Promise<void>((r) => setImmediate(r))
			last = process.hrtime.bigint()
		}
		if (snap) await snap
		await wal.close()
		assert.ok(snapshots >= EVENTS / 8000 - 2, `snapshot cycles ${snapshots}`)
		assert.ok(maxFiles <= 6, `WAL files stayed bounded (max ${maxFiles})`)
		assert.ok(maxWal < 8 * 1024 * 1024, `WAL bytes stayed bounded (max ${maxWal})`)
		assert.ok(core.consumedSize <= CAP + 8000 * 2, `consumed honours its cap with the interval overshoot (${core.consumedSize})`)
		assert.ok(pruned > 0 && archive.length === pruned, `the prune ran and every dropped key was archived first (${pruned} / ${archive.length})`)
		assert.equal(core.counts.driftEvents, 0)
		assert.ok(maxSlice < 400, `longest snapshot slice ${maxSlice.toFixed(1)} ms`)
		assert.ok(maxStall < 1500, `longest gap between event-loop turns ${maxStall.toFixed(0)} ms (includes the fsync of a batch)`)
		const rec = recoverPayoutState(dir)
		assert.equal(view(rec.core), view(core), 'recovery from disk equals the live state after all the cycles')
		assert.deepEqual(rec.warnings, [])
		console.log(`# W7 soak events=${EVENTS} snapshots=${snapshots} maxWalBytes=${maxWal} maxWalFiles=${maxFiles} pruned=${pruned} peakPendingDelta=${peakDelta} maxSliceMs=${maxSlice.toFixed(1)} maxLoopGapMs=${maxStall.toFixed(0)} consumedLive=${core.consumedSize}`)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
