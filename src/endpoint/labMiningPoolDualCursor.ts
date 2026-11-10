/**
 * Lab Mining Pool dual-cursor H freeze (PM-LAB-DUAL-CURSOR-H-2026-11-10).
 * Pure helpers — no VDR state paths, no shared cursors with conet-vdr-payout.
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
	// Continuous coverage: prefer listen checkpoint, else backfill cursor, else floor-1.
	let historyCursor =
		listen != null ? listen : backfill != null ? backfill : floor - 1
	if (historyCursor < floor - 1) historyCursor = floor - 1
	// Cap history at H (cannot scan past freeze on history line).
	if (historyCursor > input.freezeH.height) historyCursor = input.freezeH.height
	return {
		historyCursor,
		realtimeCursor: input.freezeH.height,
	}
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
