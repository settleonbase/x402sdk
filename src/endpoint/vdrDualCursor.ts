/**
 * VDR payout dual-cursor scan / settle planning (production `conet-vdr-payout`).
 *
 * Pure helpers — no RPC. Reporter wires these into eth_getBlock + signer settle.
 *
 * Lines share one eventKey namespace and one pending queue. Single settler only.
 * Historical backlog must not starve realtime; realtime gets priority quota while
 * history still advances every flush tick.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ethers } from 'ethers'
import { buildVdrSignerTx, type VdrSignerTx } from './vdrPayoutSigner'

export const VDR_DUAL_CURSOR_VERSION = 2 as const

export type ScanLine = 'historical' | 'realtime'

export type BoundaryH = {
	blockNumber: number
	blockHash: string
}

export type PendingEntryJson = {
	guardianId: string
	amount: string
	eventKey: string
	blockNumber: number
	withdrawalIndex: number
	/** Which scan line enqueued this row (shared eventKey still). */
	scanLine?: ScanLine
	/** Wall-clock ms when first enqueued (realtime latency metrics). */
	enqueuedAtMs?: number
}

export type SettleIntentStatus =
	| 'prepared' // persisted before broadcast
	| 'broadcast' // signer accepted / hash known (or ACK lost but fingerprint retained)
	| 'confirmed' // receipt status=1
	| 'uncertain' // receipt unknown — do not blind resend
	| 'failed'

export type SettleIntent = {
	intentId: string
	status: SettleIntentStatus
	createdAt: string
	updatedAt: string
	to: string
	guardianIds: string[]
	amounts: string[]
	eventKeys: string[]
	gasLimit: number
	/** Same key signer expects — derived from settle calldata. */
	idempotencyKey: string
	/** keccak256 of canonical request fingerprint (chainId|to|data|value|gasLimit|keyArray). */
	requestFingerprint: string
	/** Calldata hex used to rebuild the original batch. */
	data: string
	scanLines: ScanLine[]
	txHash?: string
	receiptStatus?: number
	note?: string
}

export type DualCursorMetrics = {
	/** Last measured realtime enqueue→flush-ready delay samples (ms). */
	realtimeLatencyMsSamples: number[]
	historicalBlocksScannedTotal: number
	realtimeBlocksScannedTotal: number
	historicalPendingFlushed: number
	realtimePendingFlushed: number
	lastHistoryCursor: number
	lastRealtimeCursor: number
	updatedAt: string
}

export type DualCursorState = {
	version: typeof VDR_DUAL_CURSOR_VERSION
	boundaryH: BoundaryH | null
	/** Last contiguous historical block fully scanned into pending (≤ H when H set). */
	historicalCursor: number
	/**
	 * Last contiguous realtime block fully scanned.
	 * Before realtime starts: equals H (or floor-1 when H unset).
	 * Realtime scans H+1 … tip.
	 */
	realtimeCursor: number
	pending: PendingEntryJson[]
	settleIntents: SettleIntent[]
	gasWaitStartedAt?: string
	/**
	 * Cumulative wei successfully settled under first-batch CAP_B (persists across restart).
	 * Combined with in-flight settleIntent reserves so peel/pack cannot bypass CAP by multi-pack flush.
	 */
	firstBatchSettledWei?: string
	metrics: DualCursorMetrics
	updatedAt: string
	/**
	 * Legacy mirrors for operators / rollback docs.
	 * historicalCursor maps to lastProcessedBlock while history incomplete;
	 * boundaryH.blockNumber maps to scanTargetBlock.
	 */
	lastProcessedBlock?: number
	scanTargetBlock?: number
}

export type LegacyClPayoutState = {
	lastProcessedBlock?: number
	scanTargetBlock?: number
	pending?: PendingEntryJson[]
	gasWaitStartedAt?: string
	firstBatchSettledWei?: string
	updatedAt?: string
	version?: number
	boundaryH?: BoundaryH | null
	historicalCursor?: number
	realtimeCursor?: number
	settleIntents?: SettleIntent[]
	metrics?: DualCursorMetrics
}

export type ScanPlan = {
	historical: { from: number; to: number } | null
	realtime: { from: number; to: number } | null
	tipForPlan: number
}

export type FlushPlan = {
	/** Ordered batches; realtime-first within reserved quota, then history. */
	batches: PendingEntryJson[][]
	realtimeBatchCount: number
	historicalBatchCount: number
	historyStillProgressing: boolean
	realtimeLatencyMs: number[]
}

function emptyMetrics(cursorFloor: number): DualCursorMetrics {
	return {
		realtimeLatencyMsSamples: [],
		historicalBlocksScannedTotal: 0,
		realtimeBlocksScannedTotal: 0,
		historicalPendingFlushed: 0,
		realtimePendingFlushed: 0,
		lastHistoryCursor: cursorFloor,
		lastRealtimeCursor: cursorFloor,
		updatedAt: new Date().toISOString(),
	}
}

export function normalizeEventKey(raw: string): string {
	return String(raw || '').toLowerCase()
}

export function withdrawalEventKey(blockNumber: number, withdrawalIndex: number): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(
			['uint256', 'uint256'],
			[BigInt(blockNumber), BigInt(withdrawalIndex)]
		)
	).toLowerCase()
}

export function resolveConfirmationDepth(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number(env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CONFIRMATION_DEPTH || 2)
	return Number.isFinite(n) && n >= 0 ? Math.min(64, Math.floor(n)) : 2
}

/** Max realtime batches ahead of history per flush tick (default 2). */
export function resolveRealtimeFlushQuota(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number(env.CONET_VALIDATOR_CL_REWARD_PAYOUT_REALTIME_FLUSH_QUOTA || 2)
	return Number.isFinite(n) && n >= 1 ? Math.min(16, Math.floor(n)) : 2
}

/** Always flush at least this many historical batches when backlog exists (default 1). */
export function resolveHistoricalFlushFloor(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number(env.CONET_VALIDATOR_CL_REWARD_PAYOUT_HISTORICAL_FLUSH_FLOOR || 1)
	return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 1
}

export function createInitialDualCursorState(deployFloor: number): DualCursorState {
	const cursor = Math.max(-1, deployFloor - 1)
	return {
		version: VDR_DUAL_CURSOR_VERSION,
		boundaryH: null,
		historicalCursor: cursor,
		realtimeCursor: cursor,
		pending: [],
		settleIntents: [],
		metrics: emptyMetrics(cursor),
		updatedAt: new Date().toISOString(),
		lastProcessedBlock: cursor,
	}
}

/**
 * Import old single-cursor state. H is NOT invented here — set on next start via ensureBoundaryH.
 * historicalCursor = lastProcessedBlock; realtimeCursor starts at same until H is locked.
 */
export function migrateLegacyToDualCursor(
	raw: LegacyClPayoutState | null | undefined,
	deployFloor: number
): DualCursorState {
	const floorCursor = Math.max(-1, deployFloor - 1)
	if (!raw || typeof raw !== 'object') {
		return createInitialDualCursorState(deployFloor)
	}

	const firstBatchSettledWei = normalizeFirstBatchSettledWei(raw.firstBatchSettledWei)

	// Dual-cursor v2 must preserve settleIntents + pending even when boundaryH is still null
	// (harness mid-restart / ACK-lost freeze before ensureBoundaryH). Requiring boundaryH
	// previously routed v2 files through the legacy branch and wiped settleIntents → pack1 gap.
	if (Number(raw.version) === VDR_DUAL_CURSOR_VERSION) {
		const hist = Number(raw.historicalCursor)
		const rt = Number(raw.realtimeCursor)
		const pending = Array.isArray(raw.pending) ? raw.pending.map(normalizePendingEntry) : []
		const boundaryH = normalizeBoundaryH(raw.boundaryH)
		const histCursor = Number.isFinite(hist) ? Math.max(floorCursor, Math.floor(hist)) : floorCursor
		const rtCursor = Number.isFinite(rt) ? Math.max(floorCursor, Math.floor(rt)) : floorCursor
		return {
			version: VDR_DUAL_CURSOR_VERSION,
			boundaryH,
			historicalCursor: histCursor,
			realtimeCursor: rtCursor,
			pending: pending.filter(Boolean) as PendingEntryJson[],
			settleIntents: Array.isArray(raw.settleIntents) ? raw.settleIntents : [],
			gasWaitStartedAt:
				typeof raw.gasWaitStartedAt === 'string' && raw.gasWaitStartedAt.trim()
					? raw.gasWaitStartedAt.trim()
					: undefined,
			firstBatchSettledWei,
			metrics: raw.metrics ?? emptyMetrics(floorCursor),
			updatedAt: raw.updatedAt ?? new Date().toISOString(),
			lastProcessedBlock: Number.isFinite(hist) ? Math.floor(hist) : floorCursor,
			scanTargetBlock: boundaryH?.blockNumber ?? normalizeScanTarget(raw.scanTargetBlock),
		}
	}

	const last = Number(raw.lastProcessedBlock)
	const historicalCursor = Number.isFinite(last) ? Math.max(floorCursor, Math.floor(last)) : floorCursor
	const pending = Array.isArray(raw.pending) ? raw.pending.map(normalizePendingEntry) : []
	return {
		version: VDR_DUAL_CURSOR_VERSION,
		boundaryH: null,
		historicalCursor,
		realtimeCursor: historicalCursor,
		pending: pending.filter(Boolean) as PendingEntryJson[],
		settleIntents: [],
		gasWaitStartedAt:
			typeof raw.gasWaitStartedAt === 'string' && raw.gasWaitStartedAt.trim()
				? raw.gasWaitStartedAt.trim()
				: undefined,
		firstBatchSettledWei,
		metrics: emptyMetrics(historicalCursor),
		updatedAt: new Date().toISOString(),
		lastProcessedBlock: historicalCursor,
		scanTargetBlock: normalizeScanTarget(raw.scanTargetBlock),
	}
}

function normalizeFirstBatchSettledWei(raw: unknown): string | undefined {
	if (raw == null || raw === '') return undefined
	try {
		const v = BigInt(String(raw).trim())
		return v > 0n ? v.toString() : undefined
	} catch {
		return undefined
	}
}

function normalizeScanTarget(raw: unknown): number | undefined {
	if (raw == null) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

function normalizeBoundaryH(raw: BoundaryH | null | undefined): BoundaryH | null {
	if (!raw) return null
	const blockNumber = Number(raw.blockNumber)
	const blockHash = String(raw.blockHash || '').toLowerCase()
	if (!Number.isFinite(blockNumber) || blockNumber < 0) return null
	if (!/^0x[0-9a-f]{64}$/.test(blockHash)) return null
	return { blockNumber: Math.floor(blockNumber), blockHash }
}

function normalizePendingEntry(raw: PendingEntryJson): PendingEntryJson | null {
	try {
		const eventKey = normalizeEventKey(raw.eventKey)
		if (!eventKey || eventKey === ethers.ZeroHash) return null
		const guardianId = String(raw.guardianId)
		const amount = String(raw.amount)
		if (BigInt(guardianId) <= 0n || BigInt(amount) <= 0n) return null
		const blockNumber = Number(raw.blockNumber)
		const withdrawalIndex = Number(raw.withdrawalIndex)
		if (!Number.isFinite(blockNumber) || !Number.isFinite(withdrawalIndex)) return null
		const scanLine: ScanLine | undefined =
			raw.scanLine === 'historical' || raw.scanLine === 'realtime' ? raw.scanLine : undefined
		return {
			guardianId,
			amount,
			eventKey,
			blockNumber: Math.floor(blockNumber),
			withdrawalIndex: Math.floor(withdrawalIndex),
			scanLine,
			enqueuedAtMs: Number.isFinite(Number(raw.enqueuedAtMs)) ? Number(raw.enqueuedAtMs) : undefined,
		}
	} catch {
		return null
	}
}

/**
 * Lock H once at start from chosen tip (usually tip − confirmationDepth).
 * Never rewrite H while historical catch-up is incomplete.
 */
export function ensureBoundaryH(
	state: DualCursorState,
	tipBlockNumber: number,
	tipBlockHash: string,
	confirmationDepth = 2
): { state: DualCursorState; lockedNow: boolean } {
	if (state.boundaryH) {
		return { state, lockedNow: false }
	}
	const safeTip = Math.max(0, Math.floor(tipBlockNumber) - Math.max(0, confirmationDepth))
	const hash = String(tipBlockHash || '').toLowerCase()
	if (!/^0x[0-9a-f]{64}$/.test(hash)) {
		throw new Error('ensureBoundaryH requires tip block hash')
	}
	// If operator already scanned past safeTip, clamp H upward to cursor so history is empty/no-op.
	const hNumber = Math.max(safeTip, state.historicalCursor)
	const next: DualCursorState = {
		...state,
		boundaryH: { blockNumber: hNumber, blockHash: hash },
		// Realtime starts at H; first realtime block is H+1.
		realtimeCursor: Math.max(state.realtimeCursor, hNumber),
		scanTargetBlock: hNumber,
		lastProcessedBlock: state.historicalCursor,
		updatedAt: new Date().toISOString(),
	}
	return { state: next, lockedNow: true }
}

export function isHistoricalComplete(state: DualCursorState): boolean {
	if (!state.boundaryH) return false
	return state.historicalCursor >= state.boundaryH.blockNumber
}

/**
 * Plan contiguous scan windows for this tick.
 * History: historicalCursor+1 … min(H, from+chunk-1)
 * Realtime: max(H+1, realtimeCursor+1) … min(safeTip, from+chunk-1)
 * Tip jumps: caller passes current tip; planner fills every missing block via from=cursor+1.
 */
export function planScanRanges(
	state: DualCursorState,
	liveTip: number,
	opts: { confirmationDepth?: number; historicalChunk?: number; realtimeChunk?: number } = {}
): ScanPlan {
	const depth = opts.confirmationDepth ?? 2
	const histChunk = Math.max(1, opts.historicalChunk ?? 32)
	const rtChunk = Math.max(1, opts.realtimeChunk ?? 32)
	const safeTip = Math.max(0, Math.floor(liveTip) - depth)

	if (!state.boundaryH) {
		return { historical: null, realtime: null, tipForPlan: safeTip }
	}

	const H = state.boundaryH.blockNumber
	let historical: ScanPlan['historical'] = null
	if (state.historicalCursor < H) {
		const from = state.historicalCursor + 1
		const to = Math.min(H, from + histChunk - 1)
		if (from <= to) historical = { from, to }
	}

	let realtime: ScanPlan['realtime'] = null
	const rtFrom = Math.max(H + 1, state.realtimeCursor + 1)
	if (rtFrom <= safeTip) {
		const to = Math.min(safeTip, rtFrom + rtChunk - 1)
		if (rtFrom <= to) realtime = { from: rtFrom, to }
	}

	return { historical, realtime, tipForPlan: safeTip }
}

export type ScanCommitInput = {
	line: ScanLine
	okThrough: number
	/** Entries discovered in this contiguous scan (already filtered to proxy). */
	entries: PendingEntryJson[]
	/** Optional hash of okThrough block for reorg tracking on realtime tip. */
	okThroughHash?: string
	nowMs?: number
}

/**
 * Merge entries into shared pending (eventKey unique) and advance the line cursor
 * in one logical transaction — caller must persist via atomicWriteState.
 */
export function commitScanProgress(state: DualCursorState, input: ScanCommitInput): DualCursorState {
	const nowMs = input.nowMs ?? Date.now()
	const pendingMap = new Map<string, PendingEntryJson>()
	for (const p of state.pending) {
		pendingMap.set(normalizeEventKey(p.eventKey), p)
	}

	let added = 0
	for (const e of input.entries) {
		const key = normalizeEventKey(e.eventKey)
		if (!key || pendingMap.has(key)) continue
		pendingMap.set(key, {
			...e,
			eventKey: key,
			scanLine: input.line,
			enqueuedAtMs: e.enqueuedAtMs ?? nowMs,
		})
		added++
	}

	const pending = [...pendingMap.values()].sort(
		(a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex
	)

	const metrics = { ...state.metrics, updatedAt: new Date().toISOString() }
	let historicalCursor = state.historicalCursor
	let realtimeCursor = state.realtimeCursor

	if (input.line === 'historical') {
		if (input.okThrough < historicalCursor) {
			throw new Error('historical cursor cannot move backward without reorg handler')
		}
		metrics.historicalBlocksScannedTotal += Math.max(0, input.okThrough - state.historicalCursor)
		historicalCursor = input.okThrough
		metrics.lastHistoryCursor = historicalCursor
	} else {
		if (input.okThrough < realtimeCursor) {
			throw new Error('realtime cursor cannot move backward without reorg handler')
		}
		metrics.realtimeBlocksScannedTotal += Math.max(0, input.okThrough - state.realtimeCursor)
		realtimeCursor = input.okThrough
		metrics.lastRealtimeCursor = realtimeCursor
	}
	void added

	return {
		...state,
		historicalCursor,
		realtimeCursor,
		pending,
		metrics,
		lastProcessedBlock: historicalCursor,
		scanTargetBlock: state.boundaryH?.blockNumber,
		updatedAt: new Date().toISOString(),
	}
}

/**
 * Reorg within confirmation depth: if stored hash for cursor tip mismatches,
 * roll both cursors back to parentBlock and drop pending / intents at/after that height.
 */
export function applyReorgRollback(
	state: DualCursorState,
	mismatchBlock: number,
	_expectedHash: string,
	_actualHash: string
): DualCursorState {
	const cut = Math.max(-1, Math.floor(mismatchBlock) - 1)
	const pending = state.pending.filter((p) => p.blockNumber <= cut)
	const settleIntents = state.settleIntents.filter((intent) => {
		const maxBn = intent.eventKeys.length
			? Math.max(
					...state.pending
						.filter((p) => intent.eventKeys.includes(p.eventKey))
						.map((p) => p.blockNumber),
					-1
				)
			: -1
		// Keep intents that only reference blocks ≤ cut, or already confirmed.
		if (intent.status === 'confirmed') return true
		return maxBn <= cut
	})

	let historicalCursor = Math.min(state.historicalCursor, cut)
	let realtimeCursor = Math.min(state.realtimeCursor, cut)
	if (state.boundaryH && historicalCursor > state.boundaryH.blockNumber) {
		historicalCursor = state.boundaryH.blockNumber
	}

	return {
		...state,
		historicalCursor,
		realtimeCursor,
		pending,
		settleIntents,
		lastProcessedBlock: historicalCursor,
		updatedAt: new Date().toISOString(),
		metrics: {
			...state.metrics,
			lastHistoryCursor: historicalCursor,
			lastRealtimeCursor: realtimeCursor,
			updatedAt: new Date().toISOString(),
		},
	}
}

export function splitEntriesForFlush(
	entries: PendingEntryJson[],
	maxEntriesPerTx: number
): PendingEntryJson[][] {
	if (!entries.length) return []
	const size = Math.max(1, maxEntriesPerTx)
	const batches: PendingEntryJson[][] = []
	for (let i = 0; i < entries.length; i += size) {
		batches.push(entries.slice(i, i + size))
	}
	return batches
}

/**
 * Single-payer scheduling: realtime batches first up to quota, then at least
 * historicalFloor historical batches so history never starves.
 */
export function planFlushOrder(
	state: DualCursorState,
	opts: {
		maxEntriesPerTx?: number
		realtimeQuota?: number
		historicalFloor?: number
		nowMs?: number
	} = {}
): FlushPlan {
	const maxEntries = opts.maxEntriesPerTx ?? 29
	const rtQuota = opts.realtimeQuota ?? 2
	const histFloor = opts.historicalFloor ?? 1
	const nowMs = opts.nowMs ?? Date.now()

	const rt = state.pending
		.filter((p) => (p.scanLine ?? inferScanLine(state, p)) === 'realtime')
		.sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
	const hist = state.pending
		.filter((p) => (p.scanLine ?? inferScanLine(state, p)) === 'historical')
		.sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)

	const rtBatchesAll = splitEntriesForFlush(rt, maxEntries)
	const histBatchesAll = splitEntriesForFlush(hist, maxEntries)

	const rtTake = rtBatchesAll.slice(0, rtQuota)
	const histTake = histBatchesAll.slice(0, Math.max(histFloor, histBatchesAll.length > 0 ? histFloor : 0))

	// If realtime exhausted quota slots but history has more, still only floor this tick;
	// remaining history continues next tick (progresses every tick while backlog exists).
	const batches = [...rtTake, ...histTake]
	const realtimeLatencyMs = rt
		.filter((p) => rtTake.some((b) => b.includes(p)))
		.map((p) => Math.max(0, nowMs - (p.enqueuedAtMs ?? nowMs)))

	return {
		batches,
		realtimeBatchCount: rtTake.length,
		historicalBatchCount: histTake.length,
		historyStillProgressing: histBatchesAll.length === 0 || histTake.length > 0,
		realtimeLatencyMs,
	}
}

function inferScanLine(state: DualCursorState, p: PendingEntryJson): ScanLine {
	if (!state.boundaryH) return 'historical'
	return p.blockNumber <= state.boundaryH.blockNumber ? 'historical' : 'realtime'
}

export function buildSettleRequestFingerprint(tx: Pick<VdrSignerTx, 'chainId' | 'to' | 'data' | 'value' | 'gasLimit' | 'keyArray'>): string {
	const canonical = [
		String(tx.chainId),
		tx.to.toLowerCase(),
		tx.data.toLowerCase(),
		tx.value,
		tx.gasLimit,
		tx.keyArray,
	].join('|')
	return ethers.keccak256(ethers.toUtf8Bytes(canonical))
}

export function prepareSettleIntent(input: {
	to: string
	guardianIds: bigint[]
	amounts: bigint[]
	eventKeys: string[]
	gasLimit: number
	keyArray: string
	scanLines: ScanLine[]
	now?: Date
}): SettleIntent {
	const tx = buildVdrSignerTx({
		keyArray: input.keyArray,
		to: input.to,
		guardianIds: input.guardianIds,
		amounts: input.amounts,
		eventKeys: input.eventKeys,
		gasLimit: input.gasLimit,
	})
	const now = (input.now ?? new Date()).toISOString()
	const fingerprint = buildSettleRequestFingerprint(tx)
	return {
		intentId: `intent:${fingerprint.slice(2, 18)}`,
		status: 'prepared',
		createdAt: now,
		updatedAt: now,
		to: tx.to,
		guardianIds: input.guardianIds.map((g) => g.toString()),
		amounts: input.amounts.map((a) => a.toString()),
		eventKeys: input.eventKeys.map(normalizeEventKey),
		gasLimit: input.gasLimit,
		idempotencyKey: tx.idempotencyKey,
		requestFingerprint: fingerprint,
		data: tx.data,
		scanLines: input.scanLines,
	}
}

export function attachIntentToState(state: DualCursorState, intent: SettleIntent): DualCursorState {
	// Same key only: a replaced intent with the same fingerprint stays as an audit record (see markIntentReplacedFailed).
	const others = state.settleIntents.filter((i) => i.idempotencyKey !== intent.idempotencyKey)
	return {
		...state,
		settleIntents: [...others, intent],
		updatedAt: new Date().toISOString(),
	}
}

export function markIntentBroadcast(
	state: DualCursorState,
	idempotencyKey: string,
	txHash: string | undefined,
	opts: { ackLost?: boolean } = {}
): DualCursorState {
	const settleIntents = state.settleIntents.map((i) => {
		if (i.idempotencyKey !== idempotencyKey) return i
		return {
			...i,
			status: (opts.ackLost ? 'broadcast' : 'broadcast') as SettleIntentStatus,
			txHash: txHash ?? i.txHash,
			updatedAt: new Date().toISOString(),
			note: opts.ackLost ? 'ack_lost_after_broadcast' : i.note,
		}
	})
	return { ...state, settleIntents, updatedAt: new Date().toISOString() }
}

export function markIntentUncertain(state: DualCursorState, idempotencyKey: string, note: string): DualCursorState {
	const settleIntents = state.settleIntents.map((i) => {
		if (i.idempotencyKey !== idempotencyKey) return i
		return {
			...i,
			status: 'uncertain' as const,
			note,
			updatedAt: new Date().toISOString(),
		}
	})
	return { ...state, settleIntents, updatedAt: new Date().toISOString() }
}

export function markIntentConfirmed(state: DualCursorState, idempotencyKey: string, receiptStatus: number): DualCursorState {
	const prior = state.settleIntents.find((i) => i.idempotencyKey === idempotencyKey)
	const alreadyConfirmed = prior?.status === 'confirmed'
	const settleIntents = state.settleIntents.map((i) => {
		if (i.idempotencyKey !== idempotencyKey) return i
		return {
			...i,
			status: receiptStatus === 1 ? ('confirmed' as const) : ('failed' as const),
			receiptStatus,
			updatedAt: new Date().toISOString(),
		}
	})
	let firstBatchSettledWei = state.firstBatchSettledWei
	if (receiptStatus === 1 && prior && !alreadyConfirmed) {
		let add = 0n
		for (const a of prior.amounts) {
			try {
				add += BigInt(a)
			} catch {
				/* skip bad amount */
			}
		}
		if (add > 0n) {
			let prev = 0n
			try {
				prev = BigInt(state.firstBatchSettledWei ?? '0')
			} catch {
				prev = 0n
			}
			firstBatchSettledWei = (prev + add).toString()
		}
	}
	return { ...state, settleIntents, firstBatchSettledWei, updatedAt: new Date().toISOString() }
}

/** Drop a prepared intent that never broadcast (signer/config fail) so it does not reserve first-batch budget. */
export function markIntentFailed(state: DualCursorState, idempotencyKey: string, note?: string): DualCursorState {
	const settleIntents = state.settleIntents.map((i) => {
		if (i.idempotencyKey !== idempotencyKey) return i
		if (i.status === 'confirmed' || i.status === 'broadcast' || i.status === 'uncertain') return i
		return {
			...i,
			status: 'failed' as const,
			note: note ?? i.note,
			updatedAt: new Date().toISOString(),
		}
	})
	return { ...state, settleIntents, updatedAt: new Date().toISOString() }
}

/** Wei already successfully settled under first-batch CAP_B (durable). */
export function firstBatchSettledWeiOf(state: DualCursorState): bigint {
	try {
		return BigInt(state.firstBatchSettledWei ?? '0')
	} catch {
		return 0n
	}
}

/** Open settle intents reserve budget until confirmed/failed (survives restart). */
export function inFlightFirstBatchReserveWei(state: DualCursorState): bigint {
	let sum = 0n
	for (const i of state.settleIntents) {
		if (i.status !== 'prepared' && i.status !== 'broadcast' && i.status !== 'uncertain') continue
		for (const a of i.amounts) {
			try {
				sum += BigInt(a)
			} catch {
				/* skip */
			}
		}
	}
	return sum
}

export function remainingFirstBatchBudgetWei(state: DualCursorState, capWei: bigint): bigint {
	const used = firstBatchSettledWeiOf(state) + inFlightFirstBatchReserveWei(state)
	return used >= capWei ? 0n : capWei - used
}

/**
 * Rebuild the exact signer tx from a persisted intent (same idempotencyKey + fingerprint).
 * Used when ACK was lost after broadcast — must NOT invent a new batch.
 */
export function rebuildSignerTxFromIntent(intent: SettleIntent, keyArray: string): VdrSignerTx {
	if (intent.status === 'uncertain' && !intent.txHash) {
		// Still allowed to rebuild for signer lookup; caller must not blind-broadcast a new key.
	}
	const guardianIds = intent.guardianIds.map((g) => BigInt(g))
	const amounts = intent.amounts.map((a) => BigInt(a))
	const tx = buildVdrSignerTx({
		keyArray,
		to: intent.to,
		guardianIds,
		amounts,
		eventKeys: intent.eventKeys,
		gasLimit: intent.gasLimit,
	})
	if (expectedIdempotencyKey(intent, tx.data) !== intent.idempotencyKey) {
		throw new Error('rebuilt idempotencyKey drifted from persisted intent')
	}
	const fp = buildSettleRequestFingerprint(tx)
	if (fp !== intent.requestFingerprint) {
		throw new Error('rebuilt requestFingerprint drifted from persisted intent')
	}
	if (tx.data.toLowerCase() !== intent.data.toLowerCase()) {
		throw new Error('rebuilt calldata drifted from persisted intent')
	}
	// A rebuilt intent carries its own key; the signer tx uses the persisted key, never a silently recomputed one.
	return { ...tx, idempotencyKey: intent.idempotencyKey }
}

/**
 * After ACK loss: recover original batch via fingerprint. Safe to resend only when
 * signer can return the same hash for the same idempotencyKey (caller supplies lookup).
 */
export function reconcileAckLostIntent(
	state: DualCursorState,
	idempotencyKey: string,
	lookup: { txHash?: string; safeToResend: boolean }
): { state: DualCursorState; action: 'reuse_hash' | 'wait' | 'refuse_blind_resend' } {
	const intent = state.settleIntents.find((i) => i.idempotencyKey === idempotencyKey)
	if (!intent) {
		return { state, action: 'refuse_blind_resend' }
	}
	if (lookup.txHash) {
		return {
			state: markIntentBroadcast(state, idempotencyKey, lookup.txHash, { ackLost: true }),
			action: 'reuse_hash',
		}
	}
	if (!lookup.safeToResend) {
		return {
			state: markIntentUncertain(state, idempotencyKey, 'receipt_unknown_ack_lost'),
			action: 'refuse_blind_resend',
		}
	}
	return { state: markIntentBroadcast(state, idempotencyKey, undefined, { ackLost: true }), action: 'wait' }
}

export function removePendingKeys(state: DualCursorState, eventKeys: string[]): DualCursorState {
	const drop = new Set(eventKeys.map(normalizeEventKey))
	const removed = state.pending.filter((p) => drop.has(normalizeEventKey(p.eventKey)))
	const pending = state.pending.filter((p) => !drop.has(normalizeEventKey(p.eventKey)))
	const metrics = { ...state.metrics, updatedAt: new Date().toISOString() }
	for (const p of removed) {
		const line = p.scanLine ?? inferScanLine(state, p)
		if (line === 'realtime') metrics.realtimePendingFlushed += 1
		else metrics.historicalPendingFlushed += 1
	}
	return { ...state, pending, metrics, updatedAt: new Date().toISOString() }
}

export function recordRealtimeLatency(state: DualCursorState, samplesMs: number[]): DualCursorState {
	const merged = [...state.metrics.realtimeLatencyMsSamples, ...samplesMs].slice(-64)
	return {
		...state,
		metrics: {
			...state.metrics,
			realtimeLatencyMsSamples: merged,
			updatedAt: new Date().toISOString(),
		},
		updatedAt: new Date().toISOString(),
	}
}

/** Crash-safe persist: write temp → fsync → rename. */
export function atomicWriteState(filePath: string, state: DualCursorState): void {
	const dir = path.dirname(filePath)
	fs.mkdirSync(dir, { recursive: true })
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
	const body = JSON.stringify(state, null, 2) + '\n'
	const fd = fs.openSync(tmp, 'w')
	try {
		fs.writeSync(fd, body)
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
	fs.renameSync(tmp, filePath)
	try {
		const dirFd = fs.openSync(dir, 'r')
		try {
			fs.fsyncSync(dirFd)
		} finally {
			fs.closeSync(dirFd)
		}
	} catch {
		/* some FS ignore dir fsync */
	}
}

export function readDualCursorStateFile(filePath: string, deployFloor: number): DualCursorState {
	try {
		if (!fs.existsSync(filePath)) return createInitialDualCursorState(deployFloor)
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyClPayoutState
		return migrateLegacyToDualCursor(raw, deployFloor)
	} catch {
		return createInitialDualCursorState(deployFloor)
	}
}

/** Documented rollback: strip v2 fields → legacy single cursor shape. */
export function dualCursorToLegacyRollback(state: DualCursorState): LegacyClPayoutState {
	return {
		lastProcessedBlock: state.historicalCursor,
		scanTargetBlock: state.boundaryH?.blockNumber ?? state.scanTargetBlock,
		pending: state.pending.map(({ scanLine: _s, enqueuedAtMs: _e, ...rest }) => rest),
		gasWaitStartedAt: state.gasWaitStartedAt,
		firstBatchSettledWei: state.firstBatchSettledWei,
		updatedAt: new Date().toISOString(),
	}
}

/** Key for rebuild n >= 1 of a batch: keccak of (calldata | rebuild:n). Distinct from the plain key keccak(calldata). */
export function rebuildIdempotencyKey(data: string, rebuildSeq: number): string {
	return `vdr-settle:${ethers.keccak256(ethers.toUtf8Bytes(`${data.toLowerCase()}|rebuild:${rebuildSeq}`))}`
}

/** The idempotencyKey a persisted intent must carry for its calldata. Rebuilt intents carry an `.r<n>` suffix in intentId. */
export function expectedIdempotencyKey(intent: Pick<SettleIntent, 'intentId'>, data: string): string {
	const m = /\.r(\d+)$/.exec(intent.intentId)
	if (!m) return `vdr-settle:${ethers.keccak256(data)}`
	return rebuildIdempotencyKey(data, Number(m[1]))
}

/** Next rebuild number for a replaced intent (its intentId suffix, if any, is the last rebuild). */
export function nextRebuildSeq(intentId: string): number {
	const m = /\.r(\d+)$/.exec(intentId)
	return m ? Number(m[1]) + 1 : 1
}

/**
 * Same batch under a NEW idempotencyKey. Used only after a provable replace/drop (nonce consumed, no receipt):
 * the signer keeps the original key reserved and would return the dead hash with duplicate:true.
 */
export function prepareRebuiltSettleIntent(
	prev: SettleIntent,
	rebuildSeq: number,
	keyArray: string,
	now?: Date
): SettleIntent {
	const base = prepareSettleIntent({
		to: prev.to,
		guardianIds: prev.guardianIds.map((g) => BigInt(g)),
		amounts: prev.amounts.map((a) => BigInt(a)),
		eventKeys: prev.eventKeys,
		gasLimit: prev.gasLimit,
		keyArray,
		scanLines: prev.scanLines,
		now,
	})
	if (base.data.toLowerCase() !== prev.data.toLowerCase()) {
		throw new Error('rebuilt calldata drifted from replaced intent')
	}
	if (base.requestFingerprint !== prev.requestFingerprint) {
		throw new Error('rebuilt requestFingerprint drifted from replaced intent')
	}
	return {
		...base,
		intentId: `${prev.intentId.replace(/\.r\d+$/, '')}.r${rebuildSeq}`,
		idempotencyKey: rebuildIdempotencyKey(base.data, rebuildSeq),
	}
}

/** Replaced/dropped intent (nonce consumed, no receipt): marked failed so it no longer reserves budget; kept as audit. */
export function markIntentReplacedFailed(state: DualCursorState, idempotencyKey: string, note: string): DualCursorState {
	const now = new Date().toISOString()
	const settleIntents = state.settleIntents.map((i) => {
		if (i.idempotencyKey !== idempotencyKey || i.status === 'confirmed') return i
		return { ...i, status: 'failed' as const, note, updatedAt: now }
	})
	return { ...state, settleIntents, updatedAt: now }
}
