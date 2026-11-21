/**
 * Invariant C for the Lab payout daemon: the history line pays only entries whose block is <= the committed history cursor.
 *
 * Why (see PLAN-lab-signing-pools-BASELINE rev2 §3 P1): the consumed set only protects against a scan cursor that re-queues a key
 * that was already paid. The Lab withdrawNative path never sets the on-chain consumed view, so when the consumed set is pruned
 * (labConsumedPrune.ts) a paid key whose block the cursor has not reached yet would be queued again at the rescan and paid twice.
 * If every paid history key belongs to a block the cursor has already passed, the cursor never revisits it, and pruning has no effect.
 *
 * This module holds the pure pieces so they can be tested without the daemon: the env flag, the selection limit, the
 * maxPaidHistoryBlock high-water mark with its self-check, the first-run initial value, and the "scan is the bottleneck" streak.
 * Flag off (the default in single-wallet mode) changes nothing: every function returns "no limit" and the logs stay byte-identical.
 */
import { classifyPendingLine } from './labMiningPoolDualCursor'

export const HISTORY_PAY_BEHIND_CURSOR_ENV = 'CONET_LAB_MINING_POOL_CL_PAYOUT_HISTORY_PAY_BEHIND_CURSOR'

/** true only for 1 / true / yes / on (case-insensitive). Anything else, including unset, is off. */
export function resolveHistoryPayBehindCursor(env: NodeJS.ProcessEnv = process.env): boolean {
	const t = String(env[HISTORY_PAY_BEHIND_CURSOR_ENV] ?? '')
		.trim()
		.toLowerCase()
	return t === '1' || t === 'true' || t === 'yes' || t === 'on'
}

/**
 * Block limit for history candidates in a flush, or null when the invariant is off.
 * The cursor must be the COMMITTED one (persisted before this flush). An unset cursor means no history payment at all (fail-closed): -1.
 */
export function historyMaxBlockFor(flagOn: boolean, committedHistoryCursor: number | null | undefined): number | null {
	if (!flagOn) return null
	if (committedHistoryCursor == null || !Number.isFinite(committedHistoryCursor)) return -1
	return committedHistoryCursor
}

/** Monotonic high-water: never decreases. Persisted with the state (and later with the WAL), merged by max on every replay. */
export function advanceMaxPaidHistoryBlock(current: number | undefined, paid: Iterable<{ blockNumber: number }>, freezeH: number): number | undefined {
	let m = current
	for (const e of paid) {
		if (classifyPendingLine(e.blockNumber, freezeH) !== 'history') continue
		if (m === undefined || e.blockNumber > m) m = e.blockNumber
	}
	return m
}

/**
 * First-run initial value of maxPaidHistoryBlock (J1): the oldest pending history block minus one (everything older has been paid or
 * dropped), taken once from the pending pool and recorded with its source. With no pending history it falls back to cursor-1.
 * Returns null when neither is available (then the field stays unset and the self-check cannot fire; the caller logs it).
 */
export function initialMaxPaidHistoryBlock(
	pending: Iterable<{ blockNumber: number }>,
	freezeH: number,
	committedHistoryCursor: number | null | undefined
): { value: number; source: 'oldest-pending-history-minus-1' | 'cursor-minus-1' } | null {
	let oldest: number | null = null
	for (const e of pending) {
		if (classifyPendingLine(e.blockNumber, freezeH) !== 'history') continue
		if (oldest === null || e.blockNumber < oldest) oldest = e.blockNumber
	}
	if (oldest !== null) return { value: oldest - 1, source: 'oldest-pending-history-minus-1' }
	if (committedHistoryCursor != null && Number.isFinite(committedHistoryCursor)) return { value: committedHistoryCursor - 1, source: 'cursor-minus-1' }
	return null
}

/**
 * Self-check (H2): maxPaidHistoryBlock <= committedHistoryCursor must always hold while the invariant is on.
 * A violation means a history entry ahead of the cursor was paid: stop history claims (fail-closed) and alert.
 */
export function checkInvariantC(maxPaidHistoryBlock: number | undefined, committedHistoryCursor: number | null | undefined): { ok: true } | { ok: false; lead: number } {
	if (maxPaidHistoryBlock === undefined) return { ok: true }
	const cursor = committedHistoryCursor == null || !Number.isFinite(committedHistoryCursor) ? -1 : committedHistoryCursor
	return maxPaidHistoryBlock <= cursor ? { ok: true } : { ok: false, lead: maxPaidHistoryBlock - cursor }
}

/** frontLead = maxPaidHistoryBlock - committedHistoryCursor. <= 0 is normal; > 0 means a payment passed the cursor. Undefined when unknown. */
export function frontLead(maxPaidHistoryBlock: number | undefined, committedHistoryCursor: number | null | undefined): number | undefined {
	if (maxPaidHistoryBlock === undefined || committedHistoryCursor == null || !Number.isFinite(committedHistoryCursor)) return undefined
	return maxPaidHistoryBlock - committedHistoryCursor
}

/**
 * "Scan is the bottleneck" alert (J1): payable history candidates are 0, entries ahead of the cursor exist, and a history wallet is idle,
 * for at least `minStreak` consecutive flushes AND at least `minMs` (the later of the two). Informational; it is not the back-pressure pause.
 */
export class ScanBottleneckTracker {
	private streak = 0
	private since: number | null = null
	constructor(
		private readonly minStreak = 3,
		private readonly minMs = 10 * 60 * 1000
	) {}
	/** Returns true when the alert should fire on this observation (and keeps firing while the condition holds). */
	observe(cond: { payableHistoryCandidates: number; historyAhead: number; idleHistoryWallet: boolean }, nowMs: number): boolean {
		if (cond.payableHistoryCandidates === 0 && cond.historyAhead > 0 && cond.idleHistoryWallet) {
			this.streak++
			if (this.since === null) this.since = nowMs
			return this.streak >= this.minStreak && nowMs - this.since >= this.minMs
		}
		this.streak = 0
		this.since = null
		return false
	}
}
