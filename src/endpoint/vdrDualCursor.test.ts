/**
 * Offline tests for VDR dual-cursor (PM-VDR-DUAL-CURSOR-H-2026-11-10 §§5–9).
 * Run: npx --yes tsx src/endpoint/vdrDualCursor.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import {
	applyReorgRollback,
	atomicWriteState,
	buildSettleRequestFingerprint,
	commitScanProgress,
	dualCursorToLegacyRollback,
	ensureBoundaryH,
	isHistoricalComplete,
	migrateLegacyToDualCursor,
	normalizeEventKey,
	planFlushOrder,
	planScanRanges,
	prepareSettleIntent,
	rebuildSignerTxFromIntent,
	reconcileAckLostIntent,
	recordRealtimeLatency,
	removePendingKeys,
	withdrawalEventKey,
	type DualCursorState,
	type PendingEntryJson,
} from './vdrDualCursor'
import { buildVdrSignerTx } from './vdrPayoutSigner'

const DEPLOY_FLOOR = 100
const PASS: string[] = []
const FAIL: string[] = []

function check(name: string, fn: () => void): void {
	try {
		fn()
		PASS.push(name)
		console.log(`PASS ${name}`)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		FAIL.push(`${name}: ${msg}`)
		console.error(`FAIL ${name}: ${msg}`)
	}
}

function entry(
	blockNumber: number,
	withdrawalIndex: number,
	guardianId = '1',
	amount = '1000000000000000000',
	scanLine?: 'historical' | 'realtime'
): PendingEntryJson {
	return {
		guardianId,
		amount,
		eventKey: withdrawalEventKey(blockNumber, withdrawalIndex),
		blockNumber,
		withdrawalIndex,
		scanLine,
		enqueuedAtMs: Date.now(),
	}
}

function tipHash(n: number): string {
	return ethers.keccak256(ethers.toUtf8Bytes(`tip:${n}`))
}

check('migrate legacy lastProcessedBlock → dual cursors', () => {
	const s = migrateLegacyToDualCursor(
		{ lastProcessedBlock: 150, scanTargetBlock: 200, pending: [entry(140, 0)] },
		DEPLOY_FLOOR
	)
	assert.equal(s.version, 2)
	assert.equal(s.historicalCursor, 150)
	assert.equal(s.realtimeCursor, 150)
	assert.equal(s.boundaryH, null)
	assert.equal(s.pending.length, 1)
})

check('H / H+1: history stops at H; realtime from H+1', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	const locked = ensureBoundaryH(s, 120, tipHash(118), 2)
	s = locked.state
	assert.ok(locked.lockedNow)
	assert.equal(s.boundaryH?.blockNumber, 118)
	assert.equal(s.realtimeCursor, 118)

	const plan = planScanRanges(s, 130, { confirmationDepth: 2, historicalChunk: 50, realtimeChunk: 50 })
	assert.deepEqual(plan.historical, { from: 100, to: 118 })
	assert.deepEqual(plan.realtime, { from: 119, to: 128 })

	s = commitScanProgress(s, {
		line: 'historical',
		okThrough: 118,
		entries: [entry(110, 0, '1', '1', 'historical')],
	})
	assert.ok(isHistoricalComplete(s))
	const plan2 = planScanRanges(s, 130, { confirmationDepth: 2 })
	assert.equal(plan2.historical, null)
	assert.deepEqual(plan2.realtime, { from: 119, to: 128 })
})

check('same eventKey namespace: dual-line enqueue dedupes; restart no double-pay', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 110, tipHash(108), 2).state
	const ek = withdrawalEventKey(105, 0)
	s = commitScanProgress(s, {
		line: 'historical',
		okThrough: 105,
		entries: [{ ...entry(105, 0), eventKey: ek, scanLine: 'historical' }],
	})
	s = commitScanProgress(s, {
		line: 'historical',
		okThrough: 108,
		entries: [{ ...entry(105, 0), eventKey: ek, scanLine: 'realtime' }],
	})
	assert.equal(s.pending.length, 1)
	assert.equal(normalizeEventKey(s.pending[0].eventKey), normalizeEventKey(ek))

	// Simulate restart: remigrate same state file contents
	const again = migrateLegacyToDualCursor(s, DEPLOY_FLOOR)
	assert.equal(again.pending.length, 1)
})

check('independent cursor progress', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 200, tipHash(198), 2).state
	s = commitScanProgress(s, { line: 'historical', okThrough: 120, entries: [] })
	s = commitScanProgress(s, {
		line: 'realtime',
		okThrough: 210,
		entries: [entry(200, 0, '1', '1', 'realtime')],
	})
	assert.equal(s.historicalCursor, 120)
	assert.equal(s.realtimeCursor, 210)
	assert.ok(s.realtimeCursor > s.historicalCursor)
})

check('payer scheduling: realtime priority + history floor; latency + history progress', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 150, tipHash(148), 2).state
	const now = 1_700_000_000_000
	const histEntries = Array.from({ length: 60 }, (_, i) => ({
		...entry(100 + i, 0, String(i + 1), '1000', 'historical'),
		enqueuedAtMs: now - 60_000,
	}))
	const rtEntries = Array.from({ length: 10 }, (_, i) => ({
		...entry(200 + i, 0, String(1000 + i), '1000', 'realtime'),
		enqueuedAtMs: now - 500,
	}))
	s = { ...s, pending: [...histEntries, ...rtEntries] }

	const plan = planFlushOrder(s, {
		maxEntriesPerTx: 5,
		realtimeQuota: 2,
		historicalFloor: 1,
		nowMs: now,
	})
	assert.equal(plan.realtimeBatchCount, 2)
	assert.equal(plan.historicalBatchCount, 1)
	assert.equal(plan.historyStillProgressing, true)
	assert.ok(plan.batches[0].every((e) => e.scanLine === 'realtime'))
	assert.ok(plan.batches[2].every((e) => e.scanLine === 'historical'))
	assert.ok(plan.realtimeLatencyMs.length > 0)
	assert.ok(plan.realtimeLatencyMs.every((ms) => ms >= 400 && ms <= 600))

	s = recordRealtimeLatency(s, plan.realtimeLatencyMs)
	assert.ok(s.metrics.realtimeLatencyMsSamples.length > 0)
	assert.equal(s.metrics.lastHistoryCursor, s.historicalCursor)
})

check('tip jump fills every missing block (no skip)', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 105, tipHash(103), 2).state
	s = commitScanProgress(s, { line: 'historical', okThrough: 103, entries: [] })
	s = commitScanProgress(s, { line: 'realtime', okThrough: 110, entries: [] })
	// Tip jumps from 112 to 200 → plan from 111 contiguous
	const plan = planScanRanges(s, 200, { confirmationDepth: 2, realtimeChunk: 10 })
	assert.deepEqual(plan.realtime, { from: 111, to: 120 })
	// Next tick continues 121…
	s = commitScanProgress(s, { line: 'realtime', okThrough: 120, entries: [] })
	const plan2 = planScanRanges(s, 200, { confirmationDepth: 2, realtimeChunk: 10 })
	assert.deepEqual(plan2.realtime, { from: 121, to: 130 })
})

check('reorg: hash mismatch rolls cursors and drops later pending', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 150, tipHash(148), 2).state
	s = commitScanProgress(s, {
		line: 'historical',
		okThrough: 140,
		entries: [entry(130, 0, '1', '1', 'historical'), entry(145, 0, '2', '1', 'historical')],
	})
	s = commitScanProgress(s, {
		line: 'realtime',
		okThrough: 160,
		entries: [entry(155, 0, '3', '1', 'realtime')],
	})
	s = applyReorgRollback(s, 145, tipHash(145), tipHash(999))
	// historical was only at 140 — stays; realtime 160 → cut to 144 (mismatch−1)
	assert.equal(s.historicalCursor, 140)
	assert.equal(s.realtimeCursor, 144)
	assert.ok(s.pending.every((p) => p.blockNumber <= 144))
	assert.equal(s.pending.length, 1)
})

check('crash-safe: enqueue+cursor atomic write survives rename', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdr-dual-'))
	const file = path.join(dir, 'state.json')
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 110, tipHash(108), 2).state
	s = commitScanProgress(s, {
		line: 'historical',
		okThrough: 105,
		entries: [entry(102, 0, '1', '1', 'historical')],
	})
	atomicWriteState(file, s)
	const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as DualCursorState
	assert.equal(raw.historicalCursor, 105)
	assert.equal(raw.pending.length, 1)
	assert.equal(raw.version, 2)
	fs.rmSync(dir, { recursive: true, force: true })
})

check('broadcast intent: idempotencyKey + fingerprint; ACK loss recovers original batch (not RPC mock)', () => {
	const to = '0x1111111111111111111111111111111111111111'
	const keyArray = 'vdr_payout'
	const eventKeys = [withdrawalEventKey(200, 0), withdrawalEventKey(201, 1)]
	const guardianIds = [1n, 2n]
	const amounts = [10n, 20n]

	const intent = prepareSettleIntent({
		to,
		guardianIds,
		amounts,
		eventKeys,
		gasLimit: 500_000,
		keyArray,
		scanLines: ['realtime', 'realtime'],
	})

	assert.ok(intent.idempotencyKey.startsWith('vdr-settle:0x'))
	assert.ok(/^0x[0-9a-f]{64}$/.test(intent.requestFingerprint))
	assert.equal(intent.status, 'prepared')

	const rebuilt = rebuildSignerTxFromIntent(intent, keyArray)
	assert.equal(rebuilt.idempotencyKey, intent.idempotencyKey)
	assert.equal(buildSettleRequestFingerprint(rebuilt), intent.requestFingerprint)
	assert.equal(rebuilt.data.toLowerCase(), intent.data.toLowerCase())

	// Simulate ACK lost: we still have intent fingerprint; "signer memory" returns same hash for same key.
	const signerStore = new Map<string, string>()
	const firstHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	signerStore.set(intent.idempotencyKey, firstHash)

	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 190, tipHash(188), 2).state
	s = {
		...s,
		settleIntents: [intent],
		pending: [
			{ ...entry(200, 0, '1', '10', 'realtime'), eventKey: eventKeys[0] },
			{ ...entry(201, 1, '2', '20', 'realtime'), eventKey: eventKeys[1] },
		],
	}

	// Persist "broadcast" without ACK (txHash unknown to process, but signer retained key).
	s = {
		...s,
		settleIntents: [
			{
				...intent,
				status: 'broadcast',
				note: 'ack_lost_after_broadcast',
				updatedAt: new Date().toISOString(),
			},
		],
	}

	const recoveredTx = rebuildSignerTxFromIntent(s.settleIntents[0], keyArray)
	const recoveredHash = signerStore.get(recoveredTx.idempotencyKey)
	assert.equal(recoveredHash, firstHash, 'must recover original batch hash via idempotencyKey')

	const reconciled = reconcileAckLostIntent(s, intent.idempotencyKey, {
		txHash: recoveredHash,
		safeToResend: false,
	})
	assert.equal(reconciled.action, 'reuse_hash')
	assert.equal(reconciled.state.settleIntents[0].txHash, firstHash)

	// Uncertain path: refuse blind resend when hash unknown and not safe.
	const uncertain = reconcileAckLostIntent(s, intent.idempotencyKey, {
		safeToResend: false,
	})
	assert.equal(uncertain.action, 'refuse_blind_resend')
	assert.equal(uncertain.state.settleIntents[0].status, 'uncertain')

	// Prove fingerprint binds calldata — different amounts = different key (no silent reuse).
	const other = buildVdrSignerTx({
		keyArray,
		to,
		guardianIds,
		amounts: [10n, 21n],
		eventKeys,
		gasLimit: 500_000,
	})
	assert.notEqual(other.idempotencyKey, intent.idempotencyKey)
})

check('scanned ≠ paid: cursor advances with pending still unpaid', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 110, tipHash(108), 2).state
	s = commitScanProgress(s, {
		line: 'historical',
		okThrough: 108,
		entries: [entry(105, 0, '1', '1', 'historical')],
	})
	assert.equal(s.historicalCursor, 108)
	assert.equal(s.pending.length, 1)
	s = removePendingKeys(s, [s.pending[0].eventKey])
	assert.equal(s.pending.length, 0)
	assert.equal(s.historicalCursor, 108)
})

check('migrate / rollback documented shapes', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 130, pending: [] }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 140, tipHash(138), 2).state
	const legacy = dualCursorToLegacyRollback(s)
	assert.equal(legacy.lastProcessedBlock, s.historicalCursor)
	assert.equal(legacy.scanTargetBlock, s.boundaryH?.blockNumber)
	assert.ok(!('boundaryH' in (legacy as object) && (legacy as { boundaryH?: unknown }).boundaryH))
})

check('ensureBoundaryH does not rewrite H mid catch-up', () => {
	let s = migrateLegacyToDualCursor({ lastProcessedBlock: 99 }, DEPLOY_FLOOR)
	s = ensureBoundaryH(s, 120, tipHash(118), 2).state
	const h = s.boundaryH
	const again = ensureBoundaryH(s, 999, tipHash(997), 2)
	assert.equal(again.lockedNow, false)
	assert.deepEqual(again.state.boundaryH, h)
})

const summary = {
	pass: PASS.length,
	fail: FAIL.length,
	failures: FAIL,
}
console.log(JSON.stringify(summary, null, 2))
if (FAIL.length) process.exit(1)
