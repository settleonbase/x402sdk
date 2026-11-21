/**
 * Flush candidate selection: a reserved quota for the realtime line, the rest for the history line.
 *
 * Before: the flush inspected the globally oldest `flushMax` pending entries. With a large history backlog (older block numbers) the
 * realtime entries (block > freeze height H) never reached that window, so the realtime reserved quota (A2) was never exercised.
 * Now, when both lines have pending entries each keeps a share: up to `realtimeQuota` of the oldest realtime entries are taken first, the
 * remaining slots go to the oldest history entries, and the history line always keeps at least `historyFloor` slots (one batch) even when
 * the realtime quota is configured at or above flushMax. A line with nothing pending hands all its slots to the other line, and a line that
 * cannot fill its share hands the spare slots over (no wasted slots).
 *
 * This only decides WHICH pending entries are inspected in this flush, and in which order. It does not change what is payable, how
 * entries are packed into batches, signed, or de-duplicated: every entry keeps its own event key and still goes through the same
 * consumed check, guardian check and idempotent batch path. Within a line the order stays oldest block first.
 *
 * Cost: one linear pass over the pending set with two small bounded lists, instead of sorting the whole set on every flush.
 *
 * Invariant C (optional, `historyMaxBlock`): history candidates must have blockNumber <= historyMaxBlock (the committed history cursor).
 * History entries beyond it stay pending, are counted as `historyAheadPending`, and are never offered for payment. With the option
 * absent or null the function behaves exactly as before. See labInvariantC.ts.
 */
import { classifyPendingLine } from './labMiningPoolDualCursor.js'

export type FlushPos = { blockNumber: number; withdrawalIndex: number }

export type FlushSelection<T> = {
	/** Realtime picks (oldest first) followed by history picks (oldest first). */
	ordered: T[]
	realtimeInspected: number
	historyInspected: number
	/** Whole pending set by line (free by-product of the pass; for the journal). */
	realtimePending: number
	historyPending: number
	/** History entries beyond historyMaxBlock (not payable yet). 0 when the limit is off. historyPending = payable + ahead. */
	historyAheadPending: number
	/** History entries payable now (blockNumber <= historyMaxBlock, or all of them when the limit is off). */
	historyPayablePending: number
	mode: 'quota' | 'oldest-first'
}

const byPos = (a: FlushPos, b: FlushPos): number => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex

/** Keep the `cap` smallest items of a stream in a sorted array. */
function insertBounded<T extends FlushPos>(arr: T[], item: T, cap: number): void {
	if (arr.length >= cap && byPos(item, arr[arr.length - 1]!) >= 0) return
	let lo = 0
	let hi = arr.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		if (byPos(arr[mid]!, item) <= 0) lo = mid + 1
		else hi = mid
	}
	arr.splice(lo, 0, item)
	if (arr.length > cap) arr.pop()
}

export function selectFlushCandidates<T extends FlushPos>(
	entries: Iterable<T>,
	opts: {
		freezeH: number
		flushMax: number
		/** Entries reserved for the realtime line (reserved batches × batch size). 0 or less = quota off: global oldest-first as before. */
		realtimeQuota: number
		/** Slots the history line keeps while it has pending entries (one batch). 0 or missing = history gets only what the quota leaves. */
		historyFloor?: number
		/** History is held back by the review hold: nothing from history can be signed, so every slot goes to realtime. */
		historyHeld?: boolean
		/** Invariant C: history candidates need blockNumber <= this (committed history cursor). Absent or null = no limit. */
		historyMaxBlock?: number | null
	}
): FlushSelection<T> {
	const cap = Math.max(0, Math.floor(opts.flushMax))
	const quotaOn = opts.realtimeQuota > 0
	const topRt: T[] = []
	const topHi: T[] = []
	const topAll: T[] = []
	let realtimePending = 0
	let historyPending = 0
	let historyAheadPending = 0
	const maxBlock = opts.historyMaxBlock ?? null
	for (const e of entries) {
		const isRt = classifyPendingLine(e.blockNumber, opts.freezeH) === 'realtime'
		if (isRt) realtimePending++
		else historyPending++
		if (!isRt && maxBlock !== null && e.blockNumber > maxBlock) {
			historyAheadPending++
			continue
		}
		if (quotaOn) insertBounded(isRt ? topRt : topHi, e, cap)
		else insertBounded(topAll, e, cap)
	}
	if (!quotaOn) {
		const rt = topAll.filter((e) => classifyPendingLine(e.blockNumber, opts.freezeH) === 'realtime').length
		return {
			ordered: topAll,
			realtimeInspected: rt,
			historyInspected: topAll.length - rt,
			realtimePending,
			historyPending,
			historyAheadPending,
			historyPayablePending: historyPending - historyAheadPending,
			mode: 'oldest-first',
		}
	}
	let rtTake: number
	let hiTake: number
	if (opts.historyHeld) {
		rtTake = Math.min(cap, topRt.length)
		hiTake = 0
	} else {
		const floor = Math.min(Math.max(0, Math.floor(opts.historyFloor ?? 0)), cap, topHi.length)
		rtTake = Math.min(Math.floor(opts.realtimeQuota), cap - floor, topRt.length)
		hiTake = Math.min(cap - rtTake, topHi.length)
		const spare = cap - rtTake - hiTake
		if (spare > 0 && topRt.length > rtTake) rtTake += Math.min(spare, topRt.length - rtTake)
	}
	return {
		ordered: [...topRt.slice(0, rtTake), ...topHi.slice(0, hiTake)],
		realtimeInspected: rtTake,
		historyInspected: hiTake,
		realtimePending,
		historyPending,
		historyAheadPending,
		historyPayablePending: historyPending - historyAheadPending,
		mode: 'quota',
	}
}
