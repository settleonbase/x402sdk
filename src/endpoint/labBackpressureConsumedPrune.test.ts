/**
 * B3 back-pressure on the pending pool and R-C soft cap for the consumed set (hysteresis prune, cold archive).
 * Local files in a temp dir and fakes only. No RPC, no beacon, no socket.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import { buildLabInFlightWithdraw, resumeLabWithdrawInFlight, type LabInFlightWithdraw, type LabLifecycleDeps } from './labClPayoutBatchLifecycle'
import { readSegmentedState, writeSegmentedState } from './labClPayoutStateStore'
import { appendConsumedArchive, consumedArchiveDir, planPrune } from './labConsumedPrune'
import { assertCursorMonotonic } from './labMiningPoolDualCursor'
import {
	BACKPRESSURE_RESUME_RATIO,
	PENDING_HIGH_WATER_ALL_DEFAULT,
	PENDING_HIGH_WATER_HISTORY_DEFAULT,
	decideLinePauses,
	nextPaused,
	resolvePendingHighWater,
} from './labBackpressure'
import { formatScanSummary, newLabScanCounters } from './labScanSummary'
import { LAB_MINING_POOL_FIXED } from './labMiningPoolPayoutSigner'
import { pruneConsumedEventKeys } from './validatorLabMiningPoolClPayoutReporter'

const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`

// ---------------------------------------------------------------- B3
test('B3: defaults, env, clamp, and the realtime level is never below the history level', () => {
	assert.deepEqual(resolvePendingHighWater({}), { history: PENDING_HIGH_WATER_HISTORY_DEFAULT, all: PENDING_HIGH_WATER_ALL_DEFAULT })
	assert.deepEqual(
		resolvePendingHighWater({ CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_HISTORY: '2400000', CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_ALL: '2600000' }),
		{ history: 2_400_000, all: 2_600_000 }
	)
	// garbage and out-of-range values fall back to the defaults, never to "no limit"
	assert.deepEqual(resolvePendingHighWater({ CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_HISTORY: 'abc', CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_ALL: '5' }), {
		history: PENDING_HIGH_WATER_HISTORY_DEFAULT,
		all: PENDING_HIGH_WATER_ALL_DEFAULT,
	})
	const r = resolvePendingHighWater({ CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_HISTORY: '3000000', CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_ALL: '2500000' })
	assert.equal(r.all, 3_000_000, 'all is raised to the history level')
})

test('B3: hysteresis — pause at the level, resume only below 95% of it', () => {
	const high = 1_800_000
	assert.equal(nextPaused(false, high - 1, high), false)
	assert.equal(nextPaused(false, high, high), true)
	assert.equal(nextPaused(true, high, high), true)
	assert.equal(nextPaused(true, Math.floor(high * BACKPRESSURE_RESUME_RATIO), high), true, 'still paused exactly at the resume level')
	assert.equal(nextPaused(true, Math.floor(high * BACKPRESSURE_RESUME_RATIO) - 1, high), false)
})

test('B3: decideLinePauses — history pauses first, a paused realtime line pauses history too, resume with hysteresis', () => {
	const hw = { history: 1_800_000, all: 2_000_000 }
	let s = { history: false, realtime: false }
	s = decideLinePauses(s, 1_700_000, hw)
	assert.deepEqual(s, { history: false, realtime: false })
	s = decideLinePauses(s, 1_800_000, hw)
	assert.deepEqual(s, { history: true, realtime: false }, 'history alone')
	s = decideLinePauses(s, 2_000_000, hw)
	assert.deepEqual(s, { history: true, realtime: true }, 'both')
	s = decideLinePauses(s, 1_990_000, hw)
	assert.deepEqual(s, { history: true, realtime: true }, 'still above 95% of the realtime level')
	s = decideLinePauses(s, 1_899_999, hw)
	assert.deepEqual(s, { history: true, realtime: false }, 'realtime resumes first')
	s = decideLinePauses(s, 1_709_999, hw)
	assert.deepEqual(s, { history: false, realtime: false }, 'history resumes below 95% of its level')
})

test('B3: simulation — with back-pressure the pool is bounded even though inflow exceeds payout; without it, it is not', () => {
	const hw = { history: 1_800_000, all: 2_000_000 }
	const run = (bp: boolean): number => {
		let pending = 1_640_000
		let histPaused = false
		let rtPaused = false
		let peak = pending
		for (let cycle = 0; cycle < 288 * 30; cycle++) {
			rtPaused = nextPaused(rtPaused, pending, hw.all)
			histPaused = nextPaused(histPaused, pending, hw.history) || rtPaused
			if (!bp || !rtPaused) pending += 457 // realtime inflow per cycle
			if (!bp || !histPaused) pending += 396 // history inflow per cycle
			pending -= 200 // payout per cycle
			peak = Math.max(peak, pending)
		}
		return peak
	}
	assert.ok(run(true) <= hw.all + 1000, 'bounded by the realtime level plus one cycle of inflow')
	assert.ok(run(false) > 2_000_000 + 1_000_000, 'unbounded without back-pressure (30 days of net growth)')
})

test('B3: a paused line prints a scan-summary with paused=1 and no blocks', () => {
	const c = newLabScanCounters()
	assert.equal(formatScanSummary('history', c), null, 'not paused and nothing scanned: silent')
	c.paused = true
	assert.match(formatScanSummary('history', c)!, /^scan-summary line=history blocks=--- n=0 .* fetchFailed=0 unconfirmed=0 paused=1$/)
})

// ---------------------------------------------------------------- R-C
test('R-C: within the cap nothing is pruned; over the cap it prunes the oldest to 90%, never a pending key', () => {
	const keys = Array.from({ length: 1000 }, (_, i) => key(i))
	assert.deepEqual(planPrune(keys, new Set(), 1000), [], 'exactly at the cap: no prune')
	const over = [...keys, key(1000)] // 1001 > 1000
	const pend = new Set([key(0), key(1), key(2)].map((k) => k.toLowerCase()))
	const drop = planPrune(over, pend, 1000)
	assert.equal(over.length - drop.length, 900, 'pruned to floor(cap*0.9)')
	assert.ok(!drop.some((k) => pend.has(k.toLowerCase())), 'pending keys are untouched')
	assert.deepEqual(drop.slice(0, 3), [key(3), key(4), key(5)], 'oldest in insertion order first, pending skipped')
	assert.equal(new Set(drop).size, drop.length, 'no duplicates')
})

test('R-C: property — random sets and pending subsets: pending never dropped, result size is the target when enough non-pending keys exist', () => {
	let seed = 99
	const rnd = (n: number): number => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed % n
	}
	for (let round = 0; round < 50; round++) {
		const n = 200 + rnd(800)
		const cap = 100 + rnd(n)
		const keys = Array.from({ length: n }, (_, i) => key(round * 100000 + i))
		const pend = new Set<string>()
		for (const k of keys) if (rnd(4) === 0) pend.add(k.toLowerCase())
		const drop = planPrune(keys, pend, cap)
		for (const d of drop) assert.ok(!pend.has(d.toLowerCase()), `round ${round}: dropped a pending key`)
		if (n > cap) {
			const target = Math.floor(cap * 0.9)
			const nonPending = n - pend.size
			assert.equal(drop.length, Math.min(n - target, nonPending), `round ${round}: size`)
		} else {
			assert.equal(drop.length, 0)
		}
	}
})

test('R-C: cold archive — appended per UTC day, exactly the dropped keys, no duplicates across prunes, outside the v2 directory', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lab-prune-'))
	try {
		const stateFile = join(dir, 'payout-state.json')
		const arch = consumedArchiveDir(stateFile)
		assert.equal(arch, join(dir, 'payout-state.consumed-archive'))
		const a = appendConsumedArchive(arch, [key(1), key(2)], new Date('2026-11-21T10:00:00Z'))
		const b = appendConsumedArchive(arch, [key(3)], new Date('2026-11-21T23:59:59Z'))
		const c = appendConsumedArchive(arch, [key(4)], new Date('2026-11-22T00:00:01Z'))
		assert.equal(a, b)
		assert.notEqual(a, c)
		const day1 = readFileSync(a, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string)
		assert.deepEqual(day1, [key(1), key(2), key(3)])
		assert.deepEqual(readFileSync(c, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string), [key(4)])
		assert.equal(appendConsumedArchive(arch, []), '', 'nothing to archive: no file written')
		assert.deepEqual(readdirSync(arch).sort(), ['consumed-20261121.jsonl', 'consumed-20261122.jsonl'])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('R-C: end to end with the real state store — prune, archive, write, read back; two generations kept; archive untouched', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lab-prune-e2e-'))
	try {
		const stateFile = join(dir, 'payout-state.json')
		const v2 = join(dir, 'payout-state.v2')
		const consumed: Record<string, true> = {}
		for (let i = 0; i < 1100; i++) consumed[key(i)] = true
		const pending = [{ eventKey: key(5), blockNumber: 1 }, { eventKey: key(2000), blockNumber: 2 }] // key(5) is also among the oldest consumed
		const pend = new Set(pending.map((e) => e.eventKey.toLowerCase()))
		const keys = Object.keys(consumed)
		const drop = planPrune(keys, pend, 1000)
		appendConsumedArchive(consumedArchiveDir(stateFile), drop)
		const dropSet = new Set(drop)
		const kept: Record<string, true> = {}
		for (const k of keys) if (!dropSet.has(k)) kept[k] = true
		for (let g = 0; g < 5; g++) writeSegmentedState(v2, { pending, consumedEventKeys: kept, exitedPubkeys: {}, historyCursor: g })
		const back = readSegmentedState(v2)
		assert.equal(Object.keys(back.consumedEventKeys).length, 900)
		assert.deepEqual(back.pending.map((e) => e.eventKey).sort(), pending.map((e) => e.eventKey).sort(), 'pending intact')
		const gens = readdirSync(v2).filter((n) => /^gen-/.test(n))
		assert.equal(gens.length, 2, 'only the current and the previous generation remain')
		const archived = readFileSync(join(consumedArchiveDir(stateFile), readdirSync(consumedArchiveDir(stateFile))[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string)
		assert.equal(new Set([...archived, ...Object.keys(back.consumedEventKeys)]).size, 1100, 'kept ∪ archived equals the original set')
		assert.equal(archived.filter((k) => back.consumedEventKeys[k]).length, 0, 'nothing is both kept and archived')
		assert.ok(existsSync(consumedArchiveDir(stateFile)), 'the archive lives outside the v2 directory and survives generation pruning')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('R-C safety: the protection is the cursor, not consumed — a cursor regression is refused before any rescan could happen', () => {
	assert.throws(() => assertCursorMonotonic('historyCursor', 2009519, 2009263), /must only advance|backwards/)
	assert.doesNotThrow(() => assertCursorMonotonic('historyCursor', 2009263, 2009519))
	// and the daemon's state writer applies it to both cursors on every write
	const src = readFileSync(join(__dirname, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	assert.match(src, /assertCursorMonotonic\('lastBackfillProcessedBlock'/)
	assert.match(src, /assertCursorMonotonic\('lastListeningEndBlock'/)
})

test('R-C safety: an in-flight batch does not depend on consumed — with consumed empty it still resumes, settles once and marks exactly its own keys', async () => {
	const consumed: Record<string, true> = {} // as if every old key had been pruned
	const logs: string[] = []
	let inFlight: LabInFlightWithdraw | null = buildLabInFlightWithdraw(
		{ line: 'history', redeem: '0xc71e246DD78B37C2fABc905D340932F28F503433', pool: LAB_MINING_POOL_FIXED, amount: 10n ** 15n, eventKeys: [key(7), key(8), key(9)] },
		new Date('2026-11-21T00:00:00Z')
	)
	const idemBefore = inFlight.idempotencyKey
	let sends = 0
	const deps: LabLifecycleDeps = {
		gate: new LabPayoutFailClosedGate(() => undefined),
		getInFlight: () => inFlight,
		setInFlight: (v) => {
			inFlight = v
		},
		persist: () => undefined,
		confirmBeforeSend: async () => undefined,
		send: async (rec) => {
			sends++
			assert.equal(rec.idempotencyKey, idemBefore, 'the idempotency key comes from the record, not from consumed')
			return { hash: `0x${'ab'.repeat(32)}` }
		},
		waitReceipt: async () => ({ status: 1 }),
		settle: (keys) => {
			for (const k of keys) consumed[k] = true
		},
		log: (l) => logs.push(l),
	}
	assert.equal(await resumeLabWithdrawInFlight(deps), 'settled')
	assert.equal(sends, 1)
	assert.deepEqual(Object.keys(consumed).sort(), [key(7), key(8), key(9)].sort())
	assert.equal(inFlight, null)
})

test('R-C in the daemon: pruneConsumedEventKeys prunes to 90% with the archive written first; an archive failure prunes nothing', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lab-prune-daemon-'))
	const saved = { s: process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE, c: process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX }
	try {
		process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE = join(dir, 'payout-state.json')
		process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX = '10000'
		const mkState = (n: number) => {
			const consumed: Record<string, true> = {}
			for (let i = 0; i < n; i++) consumed[key(i)] = true
			return { consumedEventKeys: consumed, pending: [{ eventKey: key(3) }, { eventKey: key(50000) }] } as never as Parameters<typeof pruneConsumedEventKeys>[0]
		}
		// within the cap: nothing
		const small = mkState(10000)
		assert.equal(pruneConsumedEventKeys(small), 0)
		// over the cap: down to 9000, oldest first, pending key(3) kept, archive holds exactly the dropped keys
		const st = mkState(12000)
		assert.equal(pruneConsumedEventKeys(st), 3000)
		const left = Object.keys((st as unknown as { consumedEventKeys: Record<string, true> }).consumedEventKeys)
		assert.equal(left.length, 9000)
		assert.ok(left.includes(key(3)), 'the pending key survives although it is among the oldest')
		const arch = consumedArchiveDir(join(dir, 'payout-state.json'))
		const archived = readFileSync(join(arch, readdirSync(arch)[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string)
		assert.equal(archived.length, 3000)
		assert.equal(new Set([...archived, ...left]).size, 12000, 'kept ∪ archived = original, no overlap')
		// an archive that cannot be written: nothing is pruned (retried at the next write)
		const dir2 = mkdtempSync(join(tmpdir(), 'lab-prune-daemon2-'))
		try {
			process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE = join(dir2, 'payout-state.json')
			writeFileSync(consumedArchiveDir(join(dir2, 'payout-state.json')), 'a file where the archive directory should be')
			const st2 = mkState(12000)
			assert.equal(pruneConsumedEventKeys(st2), 0)
			assert.equal(Object.keys((st2 as unknown as { consumedEventKeys: Record<string, true> }).consumedEventKeys).length, 12000)
		} finally {
			rmSync(dir2, { recursive: true, force: true })
		}
	} finally {
		for (const [k, v] of [['CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE', saved.s], ['CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX', saved.c]] as const) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
		rmSync(dir, { recursive: true, force: true })
	}
})
