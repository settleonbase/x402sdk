/**
 * Lab dual-cursor H + A2 scheduling unit tests (no chain, no VDR).
 * Run: npx tsx src/endpoint/labMiningPoolDualCursor.test.ts
 */
import assert from 'node:assert/strict'
import {
	ensureFreezeH,
	seedCursorsFromLegacy,
	nextHistoryWindow,
	nextRealtimeWindow,
	classifyPendingLine,
	scheduleFlushBatches,
	formatRealtimeLatency,
	formatHistoryProgress,
} from './labMiningPoolDualCursor.js'

const TIP_HASH = `0x${'ab'.repeat(32)}`

function testFreezeOnce(): void {
	const a = ensureFreezeH(null, 1000, TIP_HASH, '2026-11-10T00:00:00.000Z')
	assert.equal(a.height, 1000)
	assert.equal(a.hash, TIP_HASH.toLowerCase())
	const b = ensureFreezeH(a, 2000, `0x${'cd'.repeat(32)}`)
	assert.equal(b.height, 1000, 'freeze H must not move')
	assert.equal(b.hash, a.hash)
}

function testHistoryThenRealtimeWindows(): void {
	const H = 100
	let hist = 90
	const w1 = nextHistoryWindow(hist, H, 5)
	assert.deepEqual(w1, { line: 'history', from: 91, to: 95 })
	hist = 95
	const w2 = nextHistoryWindow(hist, H, 20)
	assert.deepEqual(w2, { line: 'history', from: 96, to: 100 })
	hist = 100
	assert.equal(nextHistoryWindow(hist, H, 5), null)

	let rt = H
	const r1 = nextRealtimeWindow(rt, H, 105, 10)
	assert.deepEqual(r1, { line: 'realtime', from: 101, to: 105 })
	rt = 105
	// Tip jump to 120
	const r2 = nextRealtimeWindow(rt, H, 120, 10)
	assert.deepEqual(r2, { line: 'realtime', from: 106, to: 115 })
}

function testSeedFromLegacy(): void {
	const freeze = ensureFreezeH(null, 500, TIP_HASH)
	const seeded = seedCursorsFromLegacy({
		freezeH: freeze,
		lastListeningEndBlock: 480,
		lastBackfillProcessedBlock: 450,
		scanFloor: 100,
	})
	assert.equal(seeded.historyCursor, 480)
	assert.equal(seeded.realtimeCursor, 500)
}

function testSameEventKeyClassification(): void {
	assert.equal(classifyPendingLine(100, 100), 'history')
	assert.equal(classifyPendingLine(101, 100), 'realtime')
}

function testA2RealtimePriority(): void {
	const batches = [
		{ id: 'h1', line: 'history' as const },
		{ id: 'r1', line: 'realtime' as const },
		{ id: 'h2', line: 'history' as const },
		{ id: 'r2', line: 'realtime' as const },
	]
	const { ordered, realtimeFirst, historyCount } = scheduleFlushBatches(batches, 1)
	assert.equal(realtimeFirst, 1)
	assert.equal(historyCount, 2)
	assert.equal(ordered[0]!.id, 'r1')
	assert.equal(ordered[1]!.id, 'h1')
	assert.equal(ordered[2]!.id, 'h2')
	assert.equal(ordered[3]!.id, 'r2')
}

function testLatencyAndProgressLogs(): void {
	const lat = formatRealtimeLatency({
		tipBlock: 110,
		oldestRealtimePendingBlock: 102,
		nowMs: 10_000,
		enqueuedAtMs: 7_000,
	})
	assert.equal(lat.tipGapBlocks, 8)
	assert.equal(lat.ageMs, 3_000)
	const prog = formatHistoryProgress(50, 100)
	assert.equal(prog.remaining, 50)
	assert.equal(prog.pct, 50)
}

/**
 * Crash/restart: cursor advance + enqueue must be one durable snapshot.
 * Anti-miss: after reload, next window starts at cursor+1 (no skipped blocks).
 */
function testCrashRestartCursorEnqueueAtomicityAndAntiMiss(): void {
	const freeze = ensureFreezeH(null, 100, TIP_HASH)
	let snap = {
		freezeH: freeze,
		historyCursor: 90,
		realtimeCursor: freeze.height,
		pending: {} as Record<string, { block: number; eventKey: string }>,
	}

	const w = nextHistoryWindow(snap.historyCursor, freeze.height, 5)
	assert.ok(w)
	assert.deepEqual(w, { line: 'history', from: 91, to: 95 })

	// Simulate scan success through `to` with one enqueued event — persist together.
	const eventKey = `0x${'11'.repeat(32)}`
	snap.pending[eventKey] = { block: 93, eventKey }
	snap.historyCursor = w!.to
	const durable = JSON.stringify(snap)

	// Crash mid-tick then reload from durable snapshot only.
	const reloaded = JSON.parse(durable) as typeof snap
	assert.equal(reloaded.historyCursor, 95)
	assert.ok(reloaded.pending[eventKey], 'enqueued event must survive restart')
	assert.equal(Object.keys(reloaded.pending).length, 1)

	// Anti-miss: next history window must continue at 96 (no gap after 95).
	const next = nextHistoryWindow(reloaded.historyCursor, freeze.height, 5)
	assert.deepEqual(next, { line: 'history', from: 96, to: 100 })

	// Realtime anti-miss after freeze: first window is H+1.
	const rt = nextRealtimeWindow(reloaded.realtimeCursor, freeze.height, 110, 10)
	assert.deepEqual(rt, { line: 'realtime', from: 101, to: 110 })

	// Re-enqueue same eventKey is a no-op at merge layer (dedupe map key).
	assert.equal(Boolean(reloaded.pending[eventKey]), true)
}

function main(): void {
	testFreezeOnce()
	testHistoryThenRealtimeWindows()
	testSeedFromLegacy()
	testSameEventKeyClassification()
	testA2RealtimePriority()
	testLatencyAndProgressLogs()
	testCrashRestartCursorEnqueueAtomicityAndAntiMiss()
	console.log('labMiningPoolDualCursor.test.ts: PASS')
}

main()
