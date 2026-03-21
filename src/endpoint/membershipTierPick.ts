/**
 * Aligns client "best membership" / primary card with BeamioUserCard `_findBestValidMembership`:
 * among non-expired NFTs with tokenId > 0, prefer the highest `tiers[tierIndex].minUsdc6` (trackable tiers only);
 * non-trackable tierIndex (e.g. MaxUint256) participates only as fallback when no trackable NFT qualifies.
 */
import { ethers, type Contract } from 'ethers'

export type RawNftOwnershipRow = {
	tokenId: bigint
	tierIndexOrMax: bigint
	isExpired: boolean
}

export type PickBestMembershipByMinUsdc6Result = {
	tokenId: string
	/** Same convention as API `tier` field on each NFT */
	tier: string
	/** On-chain `tiers(tierIdx).minUsdc6` for ranking / multi-card sort; 0n for fallback-only NFTs */
	minUsdc6: bigint
}

function isTrackableTierIndex(tierIdx: bigint, tiersLength: number): boolean {
	return tierIdx !== ethers.MaxUint256 && tierIdx < BigInt(tiersLength)
}

/** BeamioUserCard exposes `tiers(uint256)` only; probe successive indices until revert (same pattern as biz on-chain tier list). */
export async function readTiersLength(card: Contract): Promise<number> {
	const c = card as Contract & { tiers: (i: bigint) => Promise<unknown> }
	let n = 0
	for (let i = 0; i < 64; i++) {
		try {
			await c.tiers(BigInt(i))
			n = i + 1
		} catch {
			break
		}
	}
	return n
}

export async function pickBestMembershipNftByMinUsdc6(
	card: Contract,
	rawNfts: RawNftOwnershipRow[]
): Promise<PickBestMembershipByMinUsdc6Result | null> {
	const alive = rawNfts.filter((n) => n.tokenId > 0n && !n.isExpired)
	if (alive.length === 0) return null

	const tiersLen = await readTiersLength(card)
	const cardWithTiers = card as Contract & { tiers: (i: bigint) => Promise<[bigint, bigint, bigint, boolean]> }

	let bestId: bigint | null = null
	let bestTierIdx: bigint | null = null
	let bestMin = -1n
	let fallbackId: bigint | null = null
	let fallbackTierStr = ''

	for (const n of alive) {
		const tid = n.tokenId
		const tierIdx = n.tierIndexOrMax
		const tierStr = tierIdx === ethers.MaxUint256 ? 'Default/Max' : tierIdx.toString()

		if (!isTrackableTierIndex(tierIdx, tiersLen)) {
			if (fallbackId === null) {
				fallbackId = tid
				fallbackTierStr = tierStr
			}
			continue
		}

		let minU: bigint
		try {
			const row = await cardWithTiers.tiers(tierIdx)
			minU = BigInt(row[0].toString())
		} catch {
			continue
		}

		if (bestId === null || minU > bestMin) {
			bestId = tid
			bestMin = minU
			bestTierIdx = tierIdx
		}
	}

	if (bestId != null && bestTierIdx != null) {
		return { tokenId: bestId.toString(), tier: bestTierIdx.toString(), minUsdc6: bestMin }
	}
	if (fallbackId != null) {
		return { tokenId: fallbackId.toString(), tier: fallbackTierStr, minUsdc6: 0n }
	}
	return null
}
