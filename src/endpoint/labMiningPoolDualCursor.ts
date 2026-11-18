/**
 * Lab Mining Pool dual-cursor H freeze.
 * Pure helpers — no VDR state paths, no shared cursors with the VDR payout line.
 *
 * History: continuousCoverageCursor+1 → H (inclusive).
 * Realtime: H+1 → tip (fill tip jumps).
 * Same source event keys across both lines; single payer scheduling (A2).
 */

export type LabFreezeH = {
	height: number
	hash: string
	frozenAt: string
}

export type LabScanLine = 'history' | 'realtime'

export type LabDualCursorSnapshot = {
	freezeH: LabFreezeH | null
	/** Inclusive last fully scanned history block (next = historyCursor + 1). */
	historyCursor: number
	/** Inclusive last fully scanned realtime block (next = realtimeCursor + 1). */
	realtimeCursor: number
}

export type LabScanWindow = {
	line: LabScanLine
	from: number
	to: number
}

/** Default realtime reserved batches per flush tick (A2). */
export const LAB_REALTIME_RESERVED_BATCHES_DEFAULT = 1

export function normalizeBlock(raw: unknown): number | undefined {
	if (raw == null) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

export function isValidBlockHash(hash: string | undefined | null): boolean {
	return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)
}

/**
 * Freeze H once from live tip. Idempotent when freezeH already set.
 * Returns the freeze to persist (existing or newly created).
 */
export function ensureFreezeH(
	existing: LabFreezeH | null | undefined,
	tipHeight: number,
	tipHash: string,
	nowIso: string = new Date().toISOString()
): LabFreezeH {
	if (existing && Number.isFinite(existing.height) && isValidBlockHash(existing.hash)) {
		return existing
	}
	if (!Number.isFinite(tipHeight) || tipHeight < 0) {
		throw new Error('cannot freeze H: invalid tip height')
	}
	if (!isValidBlockHash(tipHash)) {
		throw new Error('cannot freeze H: invalid tip hash')
	}
	return { height: Math.floor(tipHeight), hash: tipHash.toLowerCase(), frozenAt: nowIso }
}

/**
 * Seed history/realtime cursors from legacy Lab listen+backfill fields.
 * historyCursor starts at continuousCoverage-1 (so next scan is coverage).
 * After freeze, realtimeCursor = H (next scan H+1).
 */
export function seedCursorsFromLegacy(input: {
	freezeH: LabFreezeH
	lastListeningEndBlock?: number
	lastBackfillProcessedBlock?: number
	scanFloor: number
}): { historyCursor: number; realtimeCursor: number } {
	const listen = normalizeBlock(input.lastListeningEndBlock)
	const backfill = normalizeBlock(input.lastBackfillProcessedBlock)
	const floor = Math.max(0, Math.floor(input.scanFloor))
	// Round-10 D3: continuous history coverage is the last processed history block (lastBackfillProcessedBlock), so the
	// next history window starts at backfill+1. The listen checkpoint is a realtime marker and does not move the history line.
	let historyCursor =
		backfill != null ? backfill : listen != null ? listen : floor - 1
	if (historyCursor < floor - 1) historyCursor = floor - 1
	// Cap history at H (cannot scan past freeze on history line).
	if (historyCursor > input.freezeH.height) historyCursor = input.freezeH.height
	return {
		historyCursor,
		realtimeCursor: input.freezeH.height,
	}
}

/**
 * R1 guard: the history line must not start above the blocks already covered. floor-1 > seed would skip [seed+1, floor-1].
 * Throws (refuses start) with the reason. Returns the floor-1 value when accepted.
 */
export function assertNoSkippedHistory(scanFloor: number, backfill: number | null | undefined): number {
	const floorMinus1 = Math.floor(scanFloor) - 1
	const seed = normalizeBlock(backfill)
	if (seed == null) throw new Error('history seed missing: refusing to start')
	if (floorMinus1 > seed) {
		throw new Error(
			`refusing to start: scan floor ${scanFloor} (floor-1 ${floorMinus1}) is above the history seed ${seed}; ` +
				`blocks ${seed + 1}..${floorMinus1} would be skipped. Check CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK / CONET_LAB_MINING_POOL_DEPLOY_BLOCK.`
		)
	}
	return floorMinus1
}

/** Next history scan window [from,to] inclusive, or null when history caught up to H. */
export function nextHistoryWindow(
	historyCursor: number,
	freezeH: number,
	chunkBlocks: number
): LabScanWindow | null {
	const from = historyCursor + 1
	if (from > freezeH) return null
	const to = Math.min(from + Math.max(1, chunkBlocks) - 1, freezeH)
	return { line: 'history', from, to }
}

/**
 * Next realtime scan window. Always starts at max(realtimeCursor+1, H+1).
 * Tip-jump: to = liveHead (caller may chunk).
 */
export function nextRealtimeWindow(
	realtimeCursor: number,
	freezeH: number,
	liveHead: number,
	chunkBlocks: number
): LabScanWindow | null {
	const floor = freezeH + 1
	let from = realtimeCursor + 1
	if (from < floor) from = floor
	if (from > liveHead) return null
	const to = Math.min(from + Math.max(1, chunkBlocks) - 1, liveHead)
	return { line: 'realtime', from, to }
}

export function classifyPendingLine(blockNumber: number, freezeH: number): LabScanLine {
	return blockNumber <= freezeH ? 'history' : 'realtime'
}

/**
 * A2: build flush order — realtime batches first (reservedQuota), then history.
 * `batches` already packed; each tagged with line of its first entry.
 */
export function scheduleFlushBatches<T extends { line: LabScanLine }>(
	batches: T[],
	realtimeReserved: number = LAB_REALTIME_RESERVED_BATCHES_DEFAULT
): { ordered: T[]; realtimeFirst: number; historyCount: number } {
	const rt = batches.filter((b) => b.line === 'realtime')
	const hi = batches.filter((b) => b.line === 'history')
	const reserved = Math.max(0, Math.floor(realtimeReserved))
	const rtFirst = rt.slice(0, reserved > 0 ? reserved : rt.length)
	const rtRest = reserved > 0 ? rt.slice(reserved) : []
	const ordered = [...rtFirst, ...hi, ...rtRest]
	return { ordered, realtimeFirst: rtFirst.length, historyCount: hi.length }
}

export function formatRealtimeLatency(input: {
	tipBlock: number
	oldestRealtimePendingBlock: number | null
	nowMs?: number
	enqueuedAtMs?: number | null
}): { tipGapBlocks: number; ageMs: number | null } {
	const tipGapBlocks =
		input.oldestRealtimePendingBlock == null
			? 0
			: Math.max(0, input.tipBlock - input.oldestRealtimePendingBlock)
	const ageMs =
		input.enqueuedAtMs != null && Number.isFinite(input.enqueuedAtMs)
			? Math.max(0, (input.nowMs ?? Date.now()) - input.enqueuedAtMs)
			: null
	return { tipGapBlocks, ageMs }
}

export function formatHistoryProgress(historyCursor: number, freezeH: number): {
	historyCursor: number
	freezeH: number
	remaining: number
	pct: number
} {
	const remaining = Math.max(0, freezeH - historyCursor)
	const span = Math.max(1, freezeH)
	const done = Math.min(historyCursor, freezeH)
	const pct = Math.min(100, Math.max(0, Math.floor((done / span) * 100)))
	return { historyCursor, freezeH, remaining, pct }
}

/** Durable batch id from sorted event keys (same keys → same batchId). */
export function labBatchIdFromEventKeys(eventKeys: string[]): string {
	const sorted = [...eventKeys].map((k) => k.toLowerCase()).sort()
	// Lazy import avoided — caller passes keccak via inject for testability.
	return sorted.join('|')
}

/** Consumed-key cap: default 200,000; accepted 10,000..3,000,000; anything else falls back to the default. */
export const CONSUMED_KEYS_CAP_DEFAULT = 200_000
export const CONSUMED_KEYS_CAP_MAX = 3_000_000
export function resolveConsumedKeysCap(raw: string | undefined): number {
	const n = Number(raw || CONSUMED_KEYS_CAP_DEFAULT)
	if (!Number.isFinite(n) || n < 10_000) return CONSUMED_KEYS_CAP_DEFAULT
	return Math.min(CONSUMED_KEYS_CAP_MAX, Math.floor(n))
}

/**
 * At the consumed cap the history line is NOT held any more. Oldest consumed keys are pruned instead (see pruneOrder).
 * Safe only while both cursors move forward monotonically (assertCursorMonotonic) and pruned keys are not pending.
 */
export function historyHeldFor(_consumedCount: number, _cap: number, _releaseHistory: boolean): boolean {
	return false
}

/**
 * Keys to drop from the consumed map: the oldest in insertion order, never a key that is still pending.
 * Returns [] when the map is within cap.
 */
export function pruneOrder(keysInInsertionOrder: string[], pendingKeys: Set<string>, cap: number): string[] {
	const excess = keysInInsertionOrder.length - cap
	if (excess <= 0) return []
	const out: string[] = []
	for (const k of keysInInsertionOrder) {
		if (out.length >= excess) break
		if (pendingKeys.has(k.toLowerCase())) continue
		out.push(k)
	}
	return out
}

/** Cursor monotonicity guard: a persisted cursor must never move backwards. Throws with the reason. */
export function assertCursorMonotonic(name: string, previous: number | null | undefined, next: number | null | undefined): void {
	const p = normalizeBlock(previous)
	const n = normalizeBlock(next)
	if (p != null && n != null && n < p) {
		throw new Error(`refusing: ${name} would move backwards (${p} -> ${n}); cursors must only advance`)
	}
}

/** Re-migration guard: a legacy single-file migration is allowed only when no committed v2 state exists. */
export function assertNoRemigration(dirStatus: 'absent' | 'orphan' | 'committed', legacyFilePresent: boolean): void {
	if (legacyFilePresent && dirStatus !== 'absent') {
		throw new Error(
			`refusing to start: legacy single-file state present while the v2 directory is ${dirStatus}; re-migration is allowed only into an absent directory`
		)
	}
}

/** One-shot stop: true once the persisted settled-batch count reaches the limit. Unset limit never stops. */
export function shouldStopAfterSettled(settledCount: number, maxSettled: number | null): boolean {
	return maxSettled != null && settledCount >= maxSettled
}
