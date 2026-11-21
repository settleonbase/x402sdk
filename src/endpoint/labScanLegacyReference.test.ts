/**
 * Reference copy of the scan classification before P1 (order: local consumed -> pending -> chain consumed -> pubkey -> Lab filter
 * -> non-skim -> status -> guardian). The logic is the previous implementation line for line; only the four outside reads are
 * routed through `deps` so a test can run the old and the new code on the same inputs. Not used by the daemon.
 * This file has no tests of its own (the name keeps it out of the build and inside the lab*.test.ts test glob).
 */
import { ethers } from 'ethers'
import { PaidKeyViewUnconfirmed } from './clPaidKeyGate'
import type { LabScanDeps } from './validatorLabMiningPoolClPayoutReporter'

type Skim = { eventKey: string; amount: bigint; blockNumber: number; withdrawalIndex: number; pubkey: string }
type State = { consumedEventKeys: Record<string, true>; exitedPubkeys: Record<string, true> }
type Block = { withdrawals?: Array<{ address?: string; amount?: string; validatorIndex?: string | number; index?: string | number }> }

export function eventKeyOf(blockNumber: number, withdrawalIndex: number): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(blockNumber), BigInt(withdrawalIndex)])
	)
}

export async function legacyCollect(
	proxyLower: string,
	blockNumber: number,
	block: Block,
	state: State,
	pending: Map<string, Skim>,
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
		if (!Number.isFinite(validatorIndex) || validatorIndex < 0) continue
		if (!Number.isFinite(withdrawalIndex) || withdrawalIndex < 0) continue

		const eventKey = eventKeyOf(blockNumber, withdrawalIndex)
		if (state.consumedEventKeys[eventKey]) continue
		if (pending.has(eventKey.toLowerCase())) continue

		try {
			const consumedOnChain = await deps.chainConsumed(eventKey)
			if (consumedOnChain) {
				state.consumedEventKeys[eventKey] = true
				continue
			}
		} catch (err: unknown) {
			throw new PaidKeyViewUnconfirmed(eventKey, err instanceof Error ? err.message : String(err))
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
		if (!pubkey || !deps.isLabPubkey(pubkey)) continue

		if (amountWei >= floorWei) {
			state.exitedPubkeys[pubkey.toLowerCase()] = true
			state.consumedEventKeys[eventKey] = true
			continue
		}

		if (status !== 'active_ongoing') {
			state.exitedPubkeys[pubkey.toLowerCase()] = true
			continue
		}

		try {
			const pkHash = ethers.keccak256(pubkey)
			const beneficiary = await deps.guardianBeneficiary(pkHash)
			if (beneficiary !== ethers.ZeroAddress) continue
		} catch (err: unknown) {
			throw new PaidKeyViewUnconfirmed(eventKey, err instanceof Error ? err.message : String(err))
		}

		entries.push({ eventKey, amount: amountWei, blockNumber, withdrawalIndex, pubkey })
	}
	return entries
}
