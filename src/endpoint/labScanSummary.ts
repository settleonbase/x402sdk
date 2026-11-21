/**
 * Counters and one-line summaries for the Lab CL payout daemon (journal reconciliation).
 * Integers only: no event key, no pubkey, no address is ever printed by these lines.
 *
 * Reconciliation identity (per scan line and tick, then summed over the journal):
 *   proxyWithdrawals = invalid + localHit + nonLab + labChainConsumed + nonSkim + nonActive + guardianBeneficiary + added
 *     (not required on a line with fetchFailed=1 or unconfirmed=1: the cursor stopped inside a block)
 *   consumedDelta(scan)  = labChainConsumed + nonSkim
 *   consumedDelta(flush) = droppedChainConsumed + settledEntries
 *   change of manifest consumed.lines = sum of every consumedDelta printed since the earlier reading.
 */
import type { LabScanLine } from './labMiningPoolDualCursor'

export type LabScanCounters = {
	/** Blocks fully processed (cursor advanced over them). */
	blocks: number
	/** Withdrawals credited to the VDR proxy with amount > 0. */
	proxyWithdrawals: number
	/** Of those, ones with an unusable validatorIndex or withdrawalIndex: skipped, nothing recorded. */
	invalid: number
	/** Already in the local consumed map or in the pending pool. */
	localHit: number
	/** Validator pubkey is not in the Lab manifest (or the beacon has no pubkey for the index): skipped, nothing recorded. */
	nonLab: number
	/** Lab pubkey whose key is already consumed on chain (settled by another path): recorded as consumed, not paid here. */
	labChainConsumed: number
	/** Single withdrawal at or above the exit floor: recorded as consumed, validator marked exited, not paid. */
	nonSkim: number
	/** Lab pubkey whose status is not active_ongoing: validator marked exited, nothing consumed. */
	nonActive: number
	/** Lab pubkey with an active guardian beneficiary (redeem stack pays it): skipped, nothing consumed. */
	guardianBeneficiary: number
	/** New entries queued into the pending pool. */
	added: number
	/** First block handed to the scanner in this tick (null when nothing was scanned). */
	from: number | null
	/** Last block the cursor advanced to in this tick. */
	through: number | null
	fetchFailed: boolean
	unconfirmed: boolean
}

export function newLabScanCounters(): LabScanCounters {
	return {
		blocks: 0,
		proxyWithdrawals: 0,
		invalid: 0,
		localHit: 0,
		nonLab: 0,
		labChainConsumed: 0,
		nonSkim: 0,
		nonActive: 0,
		guardianBeneficiary: 0,
		added: 0,
		from: null,
		through: null,
		fetchFailed: false,
		unconfirmed: false,
	}
}

export function scanConsumedDelta(c: LabScanCounters): number {
	return c.labChainConsumed + c.nonSkim
}

/** One line per scan line and tick. Empty ticks (no block processed, no failure) print nothing. */
export function formatScanSummary(line: LabScanLine, c: LabScanCounters): string | null {
	if (c.blocks === 0 && !c.fetchFailed && !c.unconfirmed) return null
	return (
		`scan-summary line=${line} blocks=${c.from ?? '-'}-${c.through ?? '-'} n=${c.blocks} ` +
		`proxyWithdrawals=${c.proxyWithdrawals} invalid=${c.invalid} localHit=${c.localHit} nonLab=${c.nonLab} ` +
		`labChainConsumed=${c.labChainConsumed} nonSkim=${c.nonSkim} nonActive=${c.nonActive} ` +
		`guardianBeneficiary=${c.guardianBeneficiary} added=${c.added} consumedDelta=${scanConsumedDelta(c)} ` +
		`fetchFailed=${c.fetchFailed ? 1 : 0} unconfirmed=${c.unconfirmed ? 1 : 0}`
	)
}

export type LabFlushCounters = {
	/** Entries re-checked against the chain before signing (at most flushMax). */
	inspect: number
	/** Size of the pending pool when the flush started composing. */
	pendingAtInspect: number
	/** Pending entries dropped because their key is already consumed on chain (recorded as consumed). */
	droppedChainConsumed: number
	/** Entries left pending because the paid-key view could not be confirmed. */
	unconfirmed: number
	/** Entries left pending by the review hold. */
	held: number
	signable: number
	batches: number
	failed: boolean
}

export function newLabFlushCounters(): LabFlushCounters {
	return { inspect: 0, pendingAtInspect: 0, droppedChainConsumed: 0, unconfirmed: 0, held: 0, signable: 0, batches: 0, failed: false }
}

/** One line per flush that inspected entries or settled a batch; nothing for no-op flushes. */
export function formatFlushSummary(c: LabFlushCounters, settledEntries: number): string | null {
	if (c.inspect === 0 && settledEntries === 0 && !c.failed) return null
	return (
		`flush-summary inspect=${c.inspect}/${c.pendingAtInspect} droppedChainConsumed=${c.droppedChainConsumed} ` +
		`unconfirmed=${c.unconfirmed} held=${c.held} signable=${c.signable} batches=${c.batches} ` +
		`settledEntries=${settledEntries} consumedDelta=${c.droppedChainConsumed + settledEntries} failed=${c.failed ? 1 : 0}`
	)
}
