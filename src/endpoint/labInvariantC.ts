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
 * First-run initial value of maxPaidHistoryBlock (J1, tightened by review note K1): the oldest pending history block B itself. Payment is oldest-first
 * by (block, index), so every paid key has a block <= B and B may be only partly paid; B-1 would understate the high-water. Taken once from the
 * pending pool and recorded with its source. With no pending history it falls back to cursor-1.
 * Returns null when neither is available (then the field stays unset and the self-check cannot fire; the caller logs it).
 */
export function initialMaxPaidHistoryBlock(
	pending: Iterable<{ blockNumber: number }>,
	freezeH: number,
	committedHistoryCursor: number | null | undefined
): { value: number; source: 'oldest-pending-history' | 'cursor-minus-1' } | null {
	let oldest: number | null = null
	for (const e of pending) {
		if (classifyPendingLine(e.blockNumber, freezeH) !== 'history') continue
		if (oldest === null || e.blockNumber < oldest) oldest = e.blockNumber
	}
	if (oldest !== null) return { value: oldest, source: 'oldest-pending-history' }
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

/** Counts history entries in the pool and how many of them are beyond the cursor (not payable yet). One linear pass. */
export function countHistoryAhead(pending: Iterable<{ blockNumber: number }>, freezeH: number, committedHistoryCursor: number | null | undefined): { histTotal: number; histAhead: number } {
	const cursor = historyMaxBlockFor(true, committedHistoryCursor) as number
	let histTotal = 0
	let histAhead = 0
	for (const e of pending) {
		if (classifyPendingLine(e.blockNumber, freezeH) !== 'history') continue
		histTotal++
		if (e.blockNumber > cursor) histAhead++
	}
	return { histTotal, histAhead }
}

/**
 * High-water merge on every start with the invariant on (review M1): value = max(current, initial), initial = oldest pending history block
 * (K1), capped at the committed cursor (a pending block beyond the cursor is no evidence that anything beyond it was paid, and an uncapped value
 * would raise a false violation). Covers the off -> on switch: while the invariant was off the high-water was not maintained, and payments may have
 * moved on, so "only initialise when undefined" would leave the self-check blind. Returns the new value and a log line when it changed.
 */
export function mergeInitialMaxPaid(
	current: number | undefined,
	pending: Iterable<{ blockNumber: number }>,
	freezeH: number,
	committedHistoryCursor: number | null | undefined
): { value: number | undefined; changed: boolean; log: string | null } {
	const init = initialMaxPaidHistoryBlock(pending, freezeH, committedHistoryCursor)
	if (!init) {
		return { value: current, changed: false, log: current === undefined ? 'invariant C on: maxPaidHistoryBlock cannot be initialised (no pending history and no cursor); self-check inactive' : null }
	}
	let candidate = init.value
	let capped = false
	if (committedHistoryCursor != null && Number.isFinite(committedHistoryCursor) && candidate > committedHistoryCursor) {
		candidate = committedHistoryCursor
		capped = true
	}
	const value = current === undefined ? candidate : Math.max(current, candidate)
	const changed = value !== current
	const log = changed
		? `invariant C on: maxPaidHistoryBlock ${current === undefined ? 'initialised' : `raised ${current} ->`} ${value} (initial=${init.value} source=${init.source}${capped ? ' capped-at-cursor' : ''}) committedHistoryCursor=${committedHistoryCursor ?? 'unset'}`
		: null
	return { value, changed, log }
}

export type InvariantCFlushPlan = {
	/** Limit for selectFlushCandidates (null = invariant off). */
	historyMaxBlock: number | null
	/** State value after the plan (high-water merged on the first flush of the process). */
	maxPaidHistoryBlock: number | undefined
	/** True when the state changed and must be persisted by the caller. */
	stateChanged: boolean
	initDone: boolean
	logs: string[]
	/** Set when maxPaidHistoryBlock > committed cursor: history claims are stopped for this flush. */
	violation: { lead: number } | null
}

/** The flush-start decisions of invariant C as one pure function (review M3). */
export function planInvariantCFlush(input: {
	flagOn: boolean
	freezeH: number | undefined
	committedHistoryCursor: number | null | undefined
	maxPaidHistoryBlock: number | undefined
	initDone: boolean
	pending: Iterable<{ blockNumber: number }>
}): InvariantCFlushPlan {
	const on = input.flagOn && input.freezeH != null
	if (!on) return { historyMaxBlock: null, maxPaidHistoryBlock: input.maxPaidHistoryBlock, stateChanged: false, initDone: input.initDone, logs: [], violation: null }
	const logs: string[] = []
	let maxPaid = input.maxPaidHistoryBlock
	let stateChanged = false
	let initDone = input.initDone
	if (!initDone) {
		const m = mergeInitialMaxPaid(maxPaid, input.pending, input.freezeH as number, input.committedHistoryCursor)
		maxPaid = m.value
		stateChanged = m.changed
		if (m.log) logs.push(m.log)
		initDone = true
	}
	let historyMaxBlock = historyMaxBlockFor(true, input.committedHistoryCursor)
	let violation: { lead: number } | null = null
	const chk = checkInvariantC(maxPaid, input.committedHistoryCursor)
	if (!chk.ok) {
		violation = { lead: chk.lead }
		historyMaxBlock = -1
		logs.push(
			`ALERT invariant C violated: maxPaidHistoryBlock=${maxPaid} > committedHistoryCursor=${input.committedHistoryCursor ?? 'unset'} (frontLead=${chk.lead}); history claims stopped (fail-closed) until the cursor passes it`
		)
	}
	return { historyMaxBlock, maxPaidHistoryBlock: maxPaid, stateChanged, initDone, logs, violation }
}

/**
 * The settle step of the lifecycle, in memory only (the lifecycle persists right after): advance the high-water from the pending entries of the settled
 * keys (history entries only, and only while the invariant is on), then mark the keys consumed and drop them from pending.
 * It reads the block numbers from the pending pool, not from the in-flight record, so it must run before the pending entries are removed.
 */
export function settleKeysAndAdvance(
	state: { freezeH?: { height: number } | null; maxPaidHistoryBlock?: number; consumedEventKeys: Record<string, true> },
	pending: Map<string, { blockNumber: number }>,
	keys: readonly string[],
	flagOn: boolean
): void {
	if (flagOn && state.freezeH) {
		const paid: { blockNumber: number }[] = []
		for (const k of keys) {
			const e = pending.get(k)
			if (e) paid.push(e)
		}
		state.maxPaidHistoryBlock = advanceMaxPaidHistoryBlock(state.maxPaidHistoryBlock, paid, state.freezeH.height)
	}
	for (const k of keys) {
		pending.delete(k)
		state.consumedEventKeys[k] = true
	}
}
