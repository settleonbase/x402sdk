/**
 * P2d synthetic state generator (test-only: the *.test.ts name keeps it out of the build, see the plan section 4b; it is NOT in the lab*.test.ts suite glob).
 *
 * Writes a Lab payout state directory of a given size with the PRODUCTION writers (writeSegmentedState for version 2, writeSnapshotCooperative + WalWriter for WAL), so the layout is what a real
 * daemon leaves. Everything is synthetic and deterministic (sha256 of seed:domain:index): field SHAPES only (public), no byte of a real state is read or copied.
 *
 *   tsx --max-old-space-size=16384 src/endpoint/p2d/genState.test.ts --tier A --form v2,wal,walTail --out <dir> [--seed N] [--tail 100000]
 *
 * Forms (each in its own subdirectory <out>/<form>/state.v2): v2 = whole-state version 2 (the old path); wal = version 3 snapshot at seq 0; walTail = version 3 snapshot plus a log tail of --tail events.
 * Free-space guard: refuses to start when the free space after the estimated size would drop under 30 GB.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSegmentedState, writeSegmentedState } from '../labClPayoutStateStore'
import { LabPayoutStateCore, type PendingEntry } from '../labPayoutStateCore'
import { recoverPayoutState } from '../labPayoutRecovery'
import { writeSnapshotCooperative } from '../labSnapshotWriter'
import { WalWriter, type WalOp } from '../labWal'

export type Tier = { pending: number; consumed: number; exited: number; historyShare: number }
export const TIERS: Record<string, Tier> = {
	/** half scale: only to reproduce the reviewer's already measured numbers (M0); entries as before the field aggregates */
	A: { pending: 830_000, consumed: 1_500_000, exited: 2_000, historyShare: 0.95 },
	/** today's real shape, from the field's read-only aggregates (2026-11-21T20:28Z): 1,683,285 pending (1,609,706 history + 73,579 realtime), 252,951 consumed */
	P0: { pending: 1_683_285, consumed: 252_951, exited: 2_000, historyShare: 1_609_706 / 1_683_285 },
	/** release tier: about 2.05M pending (history at the 1.8M back-pressure pause line + 250k realtime), consumed at the production CONSUMED_KEYS_MAX = 3,000,000 (field value, not interpolated) */
	B2: { pending: 2_050_000, consumed: 3_000_000, exited: 2_000, historyShare: 1_800_000 / 2_050_000 },
	/** self-test */
	tiny: { pending: 3_000, consumed: 5_000, exited: 40, historyShare: 0.9 },
}

export const FREE_SPACE_FLOOR_BYTES = 30 * 1024 ** 3
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
/** the field counted 1,887 distinct pubkeys among the 1.68M pending entries */
const PUBKEY_POOL = 1_887

export function estimateBytes(t: Tier, forms: number): number {
	return (t.pending * 290 + t.consumed * 75) * forms
}

export function assertFreeSpace(dir: string, needBytes: number): void {
	fs.mkdirSync(dir, { recursive: true })
	const st = fs.statfsSync(dir)
	const free = Number(st.bavail) * Number(st.bsize)
	if (free - needBytes < FREE_SPACE_FLOOR_BYTES) throw new Error(`p2d genState: free space ${(free / 1024 ** 3).toFixed(1)} GB minus the estimated ${(needBytes / 1024 ** 3).toFixed(1)} GB would drop under the 30 GB floor; delete earlier data sets first`)
}

export type Dataset = { pending: PendingEntry[]; consumed: string[]; exited: string[]; scalars: Record<string, unknown> }

export function makeDataset(t: Tier, seed: number): Dataset {
	const pubkeys: string[] = new Array(PUBKEY_POOL)
	for (let i = 0; i < PUBKEY_POOL; i++) pubkeys[i] = '0x' + sha(`${seed}:pk1:${i}`) + sha(`${seed}:pk2:${i}`).slice(0, 32) // 0x + 96 hex
	const nHist = Math.floor(t.pending * t.historyShare)
	const BASE = 2_000_000
	const histBlocks = Math.ceil(nHist / 13)
	const pending: PendingEntry[] = new Array(t.pending)
	for (let i = 0; i < t.pending; i++) {
		const k = sha(`${seed}:pend:${i}`)
		pending[i] = {
			eventKey: '0x' + k,
			// 22 digits: with the 5 production keys this puts the average JSON line at about 267.2 bytes, the field's measured 267.17-267.18
			amount: (BigInt('0x' + k.slice(0, 15)) % 9_000_000_000_000_000_000_000n + 1_000_000_000_000_000_000_000n).toString(),
			blockNumber: i < nHist ? BASE + Math.floor(i / 13) : BASE + histBlocks + Math.floor((i - nHist) / 13), // history exactly up to the freeze height, realtime above it
			withdrawalIndex: i % 13,
			pubkey: pubkeys[i % PUBKEY_POOL]!,
		}
	}
	const freezeHeight = BASE + histBlocks - 1
	const lastBlock = BASE + histBlocks + Math.floor((t.pending - nHist) / 13)
	const consumed: string[] = new Array(t.consumed)
	for (let i = 0; i < t.consumed; i++) consumed[i] = '0x' + sha(`${seed}:cons:${i}`)
	const exited: string[] = new Array(t.exited)
	for (let i = 0; i < t.exited; i++) exited[i] = '0x' + sha(`${seed}:exit1:${i}`) + sha(`${seed}:exit2:${i}`).slice(0, 32)
	const scalars: Record<string, unknown> = {
		freezeH: { height: freezeHeight, hash: '0x' + sha(`${seed}:freeze`), frozenAt: '2026-11-21T00:00:00.000Z' },
		historyCursor: freezeHeight - 1_000,
		realtimeCursor: lastBlock,
		lastBackfillProcessedBlock: freezeHeight - 1_000,
		lastLiveHeadScanned: lastBlock,
		lastListeningEndBlock: lastBlock,
		settledBatchCount: 12_345,
		maxPaidHistoryBlock: BASE + 17,
		cursorHighWater: { backfill: freezeHeight - 1_000, listen: lastBlock },
	}
	return { pending, consumed, exited, scalars }
}

export function writeV2(dir: string, d: Dataset): void {
	writeSegmentedState(dir, {
		...d.scalars,
		pending: d.pending as unknown as never[],
		consumedEventKeys: Object.fromEntries(d.consumed.map((k) => [k, true] as const)) as Record<string, true>,
		exitedPubkeys: Object.fromEntries(d.exited.map((k) => [k, true] as const)) as Record<string, true>,
	})
}

export async function writeWal(dir: string, d: Dataset, tail: number, seed: number): Promise<{ core: LabPayoutStateCore; lastSeq: number }> {
	const core = new LabPayoutStateCore({ pending: d.pending, consumed: d.consumed, exited: d.exited, scalars: d.scalars })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir, mode: 'wal', sliceMs: 1000 })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	if (tail <= 0) return { core, lastSeq: 0 }
	const wal = new WalWriter({ stateDir: dir, lastSeq: 0 })
	let pendingToSettle: string[] = []
	let waits: Promise<void>[] = []
	const baseBlock = Number((d.scalars.lastListeningEndBlock as number) ?? 0)
	for (let e = 0; e < tail; e++) {
		let ops: WalOp[]
		let label: string
		if (e % 5 !== 4) {
			label = 'scan'
			ops = []
			for (let j = 0; j < 4; j++) {
				const k = sha(`${seed}:tail:${e}:${j}`)
				ops.push({ op: 'pendingAdd', entry: { eventKey: '0x' + k, amount: String(1_000_000_000 + e), blockNumber: baseBlock + 1 + Math.floor(e / 5), withdrawalIndex: j, pubkey: d.pending[(e + j) % d.pending.length]!.pubkey } })
				pendingToSettle.push('0x' + k)
			}
			ops.push({ op: 'scalarsSet', patch: { realtimeCursor: baseBlock + 1 + Math.floor(e / 5), lastLiveHeadScanned: baseBlock + 1 + Math.floor(e / 5) } })
		} else {
			label = 'settle'
			ops = []
			for (const k of pendingToSettle.splice(0, 8)) ops.push({ op: 'consumedAdd', key: k }, { op: 'pendingDel', key: k })
			ops.push({ op: 'scalarsSet', patch: { settledBatchCount: 12_345 + Math.floor(e / 5) } })
		}
		waits.push(core.record(wal, label, ops).durable)
		if (waits.length >= 2000) {
			await Promise.all(waits)
			waits = []
		}
	}
	await Promise.all(waits)
	const lastSeq = wal.lastSeq
	await wal.close()
	return { core, lastSeq }
}

export async function generate(opts: { tier: string; forms: string[]; out: string; seed: number; tail: number }): Promise<{ dirs: Record<string, string>; counts: { pending: number; consumed: number; exited: number } }> {
	const t = TIERS[opts.tier]
	if (!t) throw new Error(`unknown tier ${opts.tier}`)
	assertFreeSpace(opts.out, estimateBytes(t, opts.forms.length))
	const ds = makeDataset(t, opts.seed)
	const dirs: Record<string, string> = {}
	for (const form of opts.forms) {
		const dir = path.join(opts.out, form, 'state.v2')
		fs.rmSync(path.join(opts.out, form), { recursive: true, force: true })
		fs.mkdirSync(path.join(opts.out, form), { recursive: true })
		if (form === 'v2') writeV2(dir, ds)
		else if (form === 'wal') await writeWal(dir, ds, 0, opts.seed)
		else if (form === 'walTail') await writeWal(dir, ds, opts.tail, opts.seed)
		else throw new Error(`unknown form ${form}`)
		dirs[form] = dir
	}
	return { dirs, counts: { pending: t.pending, consumed: t.consumed, exited: t.exited } }
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
	void (async () => {
		const a = process.argv.slice(2)
		const get = (n: string, d?: string): string => {
			const i = a.indexOf(n)
			if (i < 0) {
				if (d === undefined) throw new Error(`${n} is required`)
				return d
			}
			return a[i + 1]!
		}
		const r = await generate({ tier: get('--tier'), forms: get('--form', 'v2,wal,walTail').split(','), out: get('--out'), seed: Number(get('--seed', '1')), tail: Number(get('--tail', '100000')) })
		process.stdout.write(JSON.stringify(r) + '\n')
	})().catch((e) => {
		process.stderr.write(`genState: ${e instanceof Error ? e.message : String(e)}\n`)
		process.exit(2)
	})
}

// ---------------------------------------------------------------------------------------------- self-test (tiny tier, runs in seconds)
const TMP = (): string => fs.mkdtempSync(path.join(process.env.P2D_TMP ?? '/tmp', 'p2d-gen-'))

// registered only under the test runner: node:test runs tests that are registered at import time, also in a plain child process that merely imports this module
if (process.env.NODE_TEST_CONTEXT) test('generator self-test: deterministic, the three forms hold the same data, the log tail replays, the free-space guard refuses', async () => {
	const out = TMP()
	try {
		const r = await generate({ tier: 'tiny', forms: ['v2', 'wal', 'walTail'], out, seed: 7, tail: 50 })
		const v2 = readSegmentedState(r.dirs.v2!)
		assert.equal((v2.pending as unknown[]).length, 3000)
		assert.equal(Object.keys(v2.consumedEventKeys).length, 5000)
		assert.equal(Object.keys(v2.exitedPubkeys).length, 40)
		const w = recoverPayoutState(r.dirs.wal!, { readOnly: true })
		assert.equal(w.core.pendingSize, 3000)
		assert.equal(w.core.consumedSize, 5000)
		assert.equal(w.replayed, 0)
		const wt = recoverPayoutState(r.dirs.walTail!, { readOnly: true })
		assert.equal(wt.replayed, 50, 'the log tail has 50 events and they replay')
		assert.ok(wt.core.pendingSize > 3000 - 1 && wt.core.consumedSize > 5000, 'the tail changed the state')
		// the same seed gives the same keys (deterministic); a different seed does not
		const again = makeDataset(TIERS.tiny!, 7)
		assert.equal(again.pending[17]!.eventKey, (v2.pending as PendingEntry[])[17]!.eventKey)
		assert.notEqual(makeDataset(TIERS.tiny!, 8).pending[17]!.eventKey, again.pending[17]!.eventKey)
		// the v2 and the wal snapshot hold the same logical state
		assert.deepEqual([...w.core.consumedKeys()], Object.keys(v2.consumedEventKeys))
		// shapes: key 0x+64 hex, pubkey 0x+96 hex, amount decimal string, history entries at or below the freeze height
		const e0 = again.pending[0]!
		assert.match(String(e0.eventKey), /^0x[0-9a-f]{64}$/)
		assert.match(String(e0.pubkey), /^0x[0-9a-f]{96}$/)
		assert.match(String(e0.amount), /^[0-9]+$/)
		// the field's aggregates: average pending JSON line 267.17-267.18 bytes (without the newline), 1,887 distinct pubkeys, consumed lines 69.00 bytes with the newline
		const avgLine = again.pending.reduce((a, e) => a + JSON.stringify(e).length, 0) / again.pending.length
		assert.ok(Math.abs(avgLine - 267.2) < 1.0, `average pending line ${avgLine.toFixed(2)} bytes`)
		assert.equal(new Set(again.pending.map((e) => e.pubkey)).size, 1_887)
		assert.equal(JSON.stringify(again.consumed[0]).length + 1, 69)
		const fz = (again.scalars.freezeH as { height: number }).height
		assert.equal(again.pending.filter((e) => (e.blockNumber as number) <= fz).length, Math.floor(3000 * 0.9), 'history share')
		// the free-space guard: an absurd size is refused, nothing is written
		assert.throws(() => assertFreeSpace(out, 1e15), /30 GB floor/)
	} finally {
		fs.rmSync(out, { recursive: true, force: true })
	}
})
