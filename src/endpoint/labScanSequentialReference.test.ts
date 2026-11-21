/**
 * Reference copy of the SEQUENTIAL scan classification (P1 order, one read after another) as it was before B2. Used only to
 * show that the bounded-parallel version makes the same decisions, the same state changes and fails at the same item.
 * Not used by the daemon; no tests of its own (the name keeps it out of the build and inside the lab*.test.ts glob).
 */
import { ethers } from 'ethers'
import { PaidKeyViewUnconfirmed } from './clPaidKeyGate'
import { newLabScanCounters, type LabScanCounters } from './labScanSummary'
import type { LabScanDeps } from './validatorLabMiningPoolClPayoutReporter'
import { eventKeyOf } from './labScanLegacyReference.test'

type Skim = { eventKey: string; amount: bigint; blockNumber: number; withdrawalIndex: number; pubkey: string }
type State = { consumedEventKeys: Record<string, true>; exitedPubkeys: Record<string, true> }
type Block = { withdrawals?: Array<{ address?: string; amount?: string; validatorIndex?: string | number; index?: string | number }> }

export async function sequentialCollect(
	proxyLower: string,
	blockNumber: number,
	block: Block,
	state: State,
	pending: Map<string, Skim>,
	counters: LabScanCounters,
	deps: LabScanDeps
): Promise<Skim[]> {
	const floorWei = deps.exitFloorWei()
	const entries: Skim[] = []
	for (const w of block.withdrawals ?? []) {
		const addr = String(w.address ?? '').toLowerCase()
		if (addr !== proxyLower) continue
		const amountGwei = BigInt(String(w.amount ?? '0'))
		if (amountGwei <= 0n) continue
		const amountWei = amountGwei * 1_000_000_000n
		const validatorIndex = Number(w.validatorIndex)
		const withdrawalIndex = Number(w.index)
		counters.proxyWithdrawals++
		if (!Number.isFinite(validatorIndex) || validatorIndex < 0) {
			counters.invalid++
			continue
		}
		if (!Number.isFinite(withdrawalIndex) || withdrawalIndex < 0) {
			counters.invalid++
			continue
		}

		const eventKey = eventKeyOf(blockNumber, withdrawalIndex)
		if (state.consumedEventKeys[eventKey]) {
			counters.localHit++
			continue
		}
		if (pending.has(eventKey.toLowerCase())) {
			counters.localHit++
			continue
		}

		let pubkey: string | null
		let status: string | null
		try {
			const fetched = await deps.fetchValidator(validatorIndex)
			pubkey = fetched.pubkey
			status = fetched.status
		} catch (err: unknown) {
			throw new PaidKeyViewUnconfirmed(eventKey, err instanceof Error ? err.message : String(err))
		}
		if (!pubkey || !deps.isLabPubkey(pubkey)) {
			counters.nonLab++
			continue
		}

		try {
			const consumedOnChain = await deps.chainConsumed(eventKey)
			if (consumedOnChain) {
				state.consumedEventKeys[eventKey] = true
				counters.labChainConsumed++
				continue
			}
		} catch (err: unknown) {
			throw new PaidKeyViewUnconfirmed(eventKey, err instanceof Error ? err.message : String(err))
		}

		if (amountWei >= floorWei) {
			state.exitedPubkeys[pubkey.toLowerCase()] = true
			state.consumedEventKeys[eventKey] = true
			counters.nonSkim++
			continue
		}

		if (status !== 'active_ongoing') {
			state.exitedPubkeys[pubkey.toLowerCase()] = true
			counters.nonActive++
			continue
		}

		try {
			const pkHash = ethers.keccak256(pubkey)
			const beneficiary = await deps.guardianBeneficiary(pkHash)
			if (beneficiary !== ethers.ZeroAddress) {
				counters.guardianBeneficiary++
				continue
			}
		} catch (err: unknown) {
			throw new PaidKeyViewUnconfirmed(eventKey, err instanceof Error ? err.message : String(err))
		}

		entries.push({ eventKey, amount: amountWei, blockNumber, withdrawalIndex, pubkey })
	}
	return entries
}

export { newLabScanCounters }
