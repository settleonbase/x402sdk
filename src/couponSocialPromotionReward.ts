/**
 * Per-issued-coupon L2 social promotion (#13 dispatch) — ruleId + active rule read.
 * Aligns bizSite `programSocialPromotion.ts` slot semantics.
 */
import { ethers } from 'ethers'
import { resolveUserCardChain, providerForUserCardChain } from './beamioUserCardChain'
import { UC_METRIC, UC_TARGET } from './userCumulativeStatRewardPool'
import { getSeriesByCardAndTokenId } from './db'
import { readCouponDisabledFromMetadata } from './couponMetadataCategory'

export type CouponSocialPromotionEventKey = 'linkClick' | 'like' | 'claim' | 'burn'

/** On-chain rule slot per coupon event (linkClick keeps ruleId = issuedTokenId). */
export const COUPON_SOCIAL_PROMOTION_EVENT_RULE_SLOTS: Record<CouponSocialPromotionEventKey, number> = {
	linkClick: 0,
	like: 1,
	claim: 2,
	burn: 3,
}

export const COUPON_EVENT_METRIC_KIND: Record<CouponSocialPromotionEventKey, number> = {
	linkClick: UC_METRIC.USER_CLICK,
	like: UC_METRIC.USER_LIKE,
	claim: UC_METRIC.USER_PURCHASE,
	burn: UC_METRIC.REF_BURN,
}

const REWARD_RULE_ABI = [
	'function getRewardRule(uint256 ruleId) view returns (bool active, uint8 eventKind, uint8 targetKind, uint256 issuedParentId, uint256 actorMint13, uint256 refMint13)',
] as const

export function couponSocialPromotionRuleIdForEvent(
	issuedTokenId: bigint | string | number,
	eventKey: CouponSocialPromotionEventKey,
): bigint {
	const base = BigInt(String(issuedTokenId).trim())
	const slot = COUPON_SOCIAL_PROMOTION_EVENT_RULE_SLOTS[eventKey]
	if (slot === 0) return base
	return base * 100n + BigInt(slot)
}

export type ActiveCouponSocialRewardRule = {
	ruleId: bigint
	targetKind: number
	issuedParentId: bigint
	actorMint13: bigint
	refMint13: bigint
	eventKey: CouponSocialPromotionEventKey
}

export function resolveRefWalletDistinct(actorEOA: string, refWalletRaw: string | null | undefined): string {
	const raw = refWalletRaw?.trim() ?? ''
	if (!raw || !ethers.isAddress(raw)) return ethers.ZeroAddress
	try {
		const ref = ethers.getAddress(raw)
		const actor = ethers.getAddress(actorEOA)
		return ref === actor ? ethers.ZeroAddress : ref
	} catch {
		return ethers.ZeroAddress
	}
}

export function resolveRefWalletForDispatch(
	actorEOA: string,
	refWalletRaw: string | null | undefined,
	refMint13: bigint,
): string {
	if (refMint13 <= 0n) return ethers.ZeroAddress
	return resolveRefWalletDistinct(actorEOA, refWalletRaw)
}

async function ruleMatchesCouponEvent(
	reader: ethers.Contract,
	ruleId: bigint,
	eventKey: CouponSocialPromotionEventKey,
	expectedParentId: bigint,
): Promise<boolean> {
	try {
		const row = (await reader.getRewardRule(ruleId)) as [
			boolean,
			number,
			number,
			bigint,
			bigint,
			bigint,
		]
		const [active, eventKind, targetKind, issuedParentId, actorMint13, refMint13] = row
		return (
			active &&
			Number(eventKind) === COUPON_EVENT_METRIC_KIND[eventKey] &&
			Number(targetKind) === UC_TARGET.ISSUED_COUPON &&
			BigInt(issuedParentId) === expectedParentId &&
			(actorMint13 > 0n || refMint13 > 0n)
		)
	} catch {
		return false
	}
}

/** Active L2 coupon social #13 rule; null when inactive or untrusted read. */
export async function readActiveCouponSocialRewardRule(params: {
	cardAddress: string
	issuedTokenId: bigint | string | number
	eventKey: CouponSocialPromotionEventKey
}): Promise<ActiveCouponSocialRewardRule | null> {
	try {
		const card = ethers.getAddress(params.cardAddress)
		const expectedParentId = BigInt(String(params.issuedTokenId).trim())
		const series = await getSeriesByCardAndTokenId(card, String(expectedParentId))
		if (series?.metadata && readCouponDisabledFromMetadata(series.metadata)) {
			return null
		}
		const chain = await resolveUserCardChain(card)
		if (chain !== 'conet') return null
		const provider = providerForUserCardChain(chain)
		const reader = new ethers.Contract(card, REWARD_RULE_ABI, provider)
		const preferredRuleId = couponSocialPromotionRuleIdForEvent(expectedParentId, params.eventKey)
		if (!(await ruleMatchesCouponEvent(reader, preferredRuleId, params.eventKey, expectedParentId))) {
			return null
		}
		const row = (await reader.getRewardRule(preferredRuleId)) as [
			boolean,
			number,
			number,
			bigint,
			bigint,
			bigint,
		]
		const [, , targetKind, issuedParentId, actorMint13, refMint13] = row
		if (actorMint13 <= 0n && refMint13 <= 0n) return null
		return {
			ruleId: preferredRuleId,
			targetKind: Number(targetKind),
			issuedParentId,
			actorMint13,
			refMint13,
			eventKey: params.eventKey,
		}
	} catch {
		return null
	}
}

/** Resolve referrer for coupon burn: explicit ref → on-chain refereeReferrer(holder AA). */
export async function resolveCouponBurnRefWallet(params: {
	cardAddress: string
	holderAccount: string
	actorEOA: string
	explicitRefWallet?: string | null
}): Promise<string> {
	const explicit = resolveRefWalletDistinct(params.actorEOA, params.explicitRefWallet)
	if (explicit !== ethers.ZeroAddress) return explicit
	try {
		const card = ethers.getAddress(params.cardAddress)
		const holder = ethers.getAddress(params.holderAccount)
		const chain = await resolveUserCardChain(card)
		const provider = providerForUserCardChain(chain)
		const reader = new ethers.Contract(
			card,
			['function refereeReferrer(address refereeAA) view returns (address)'],
			provider,
		)
		const referrer = (await reader.refereeReferrer(holder)) as string
		if (referrer && ethers.isAddress(referrer) && referrer !== ethers.ZeroAddress) {
			return resolveRefWalletDistinct(params.actorEOA, referrer)
		}
	} catch {
		/* untrusted — no ref */
	}
	return ethers.ZeroAddress
}
