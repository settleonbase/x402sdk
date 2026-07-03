import { ethers } from 'ethers'
import { providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'
import { MERCHANT_CARD_USER_LIKE_SCOPED_TOKEN_ID } from './userCumulativeStatRewardPool'

/** UserCumulativeStatLib.MERCHANT_CARD_REF_CLICK_TOKEN_ID @ L1. */
export const MERCHANT_CARD_REF_CLICK_SCOPED_TOKEN_ID = 21n

const READ_ABI = ['function totalSupply(uint256 id) view returns (uint256)'] as const

export type CardProgramSocialChainTotals = {
	likeCount: number | null
	shareClickCount: number | null
}

/**
 * Share-link KPI: chain totalSupply(21) is canonical for Discover RPC reads, but DB rows
 * (`recorded going forward`) may lead when gateway relay skipped REF_CLICK (legacy bug).
 */
export function resolveProgramSocialShareClickCount(
	chainCount: number | null,
	dbTotal: number,
): number | null {
	const db = Math.max(0, Math.trunc(Number.isFinite(dbTotal) ? dbTotal : 0))
	if (chainCount == null) return db > 0 ? db : null
	const chain = Math.max(0, Math.trunc(chainCount))
	return Math.max(chain, db)
}

async function readMerchantScopedTotalSupply(cardAddress: string, tokenId: bigint): Promise<number | null> {
	try {
		const card = ethers.getAddress(cardAddress)
		const chain = await resolveUserCardChain(card)
		const provider = providerForUserCardChain(chain)
		const c = new ethers.Contract(card, READ_ABI, provider)
		const raw = (await c.totalSupply(tokenId)) as bigint
		const n = Number(raw)
		return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
	} catch {
		return null
	}
}

/** 与 SilentPassUI Discover 一致：L1 totalSupply(19) / totalSupply(21)。 */
export async function readCardProgramSocialChainTotals(cardAddress: string): Promise<CardProgramSocialChainTotals> {
	const [likeCount, shareClickCount] = await Promise.all([
		readMerchantScopedTotalSupply(cardAddress, MERCHANT_CARD_USER_LIKE_SCOPED_TOKEN_ID),
		readMerchantScopedTotalSupply(cardAddress, MERCHANT_CARD_REF_CLICK_SCOPED_TOKEN_ID),
	])
	return { likeCount, shareClickCount }
}
