/**
 * Discover share-click B-Unit billing gate: charge only when the merchant card
 * has an active Social Promotion linkClick / USER_CLICK reward (mint #13 > 0).
 * Click stats may still be recorded without this rule.
 */
import { ethers } from 'ethers'
import { resolveUserCardChain, providerForUserCardChain } from './beamioUserCardChain'
import { getSeriesByCardAndTokenId } from './db'
import { readCouponDisabledFromMetadata } from './couponMetadataCategory'

/** Align with UC_METRIC.USER_CLICK / UC_TARGET in userCumulativeStatRewardPool. */
const UC_USER_CLICK = 3
const UC_TARGET_MERCHANT_CARD = 1
const UC_TARGET_ISSUED_COUPON = 2

const GET_REWARD_RULE_ABI = [
	'function getRewardRule(uint256 ruleId) view returns (bool active, uint8 eventKind, uint8 targetKind, uint256 issuedParentId, uint256 actorMint13, uint256 refMint13)',
] as const

function parseParentId(raw: unknown): bigint {
	if (typeof raw === 'bigint') return raw
	if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.trunc(raw))
	if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return BigInt(raw.trim())
	return 0n
}

/**
 * True when card has an active link-click Social Reward that would mint #13
 * (merchant-card rule scan or issued-coupon preferred ruleId).
 * On RPC/parse failure returns false (do not bill — untrusted).
 */
export async function cardHasActiveLinkClickSocialReward(params: {
	cardAddress: string
	targetKind?: number
	issuedParentId?: bigint | string | number | null
}): Promise<boolean> {
	try {
		const card = ethers.getAddress(params.cardAddress)
		const chain = await resolveUserCardChain(card)
		if (chain !== 'conet') return false

		const targetKind = Number(params.targetKind ?? UC_TARGET_MERCHANT_CARD)
		const parentId = parseParentId(params.issuedParentId)

		if (targetKind === UC_TARGET_ISSUED_COUPON && parentId > 0n) {
			const series = await getSeriesByCardAndTokenId(card, parentId.toString())
			if (series?.metadata && readCouponDisabledFromMetadata(series.metadata)) {
				return false
			}
			const provider = providerForUserCardChain(chain)
			const reader = new ethers.Contract(card, GET_REWARD_RULE_ABI, provider)
			const row = (await reader.getRewardRule(parentId)) as [
				boolean,
				number,
				number,
				bigint,
				bigint,
				bigint,
			]
			const [active, eventKind, tk, issuedParentId, actorMint13, refMint13] = row
			return (
				active &&
				Number(eventKind) === UC_USER_CLICK &&
				Number(tk) === UC_TARGET_ISSUED_COUPON &&
				BigInt(issuedParentId) === parentId &&
				(actorMint13 > 0n || refMint13 > 0n)
			)
		}

		const provider = providerForUserCardChain(chain)
		const reader = new ethers.Contract(card, GET_REWARD_RULE_ABI, provider)
		for (let ruleId = 1; ruleId <= 12; ruleId++) {
			try {
				const row = (await reader.getRewardRule(BigInt(ruleId))) as [
					boolean,
					number,
					number,
					bigint,
					bigint,
					bigint,
				]
				const [active, eventKind, tk, issuedParentId, actorMint13, refMint13] = row
				if (!active) continue
				if (Number(eventKind) !== UC_USER_CLICK) continue
				if (Number(tk) !== UC_TARGET_MERCHANT_CARD) continue
				if (issuedParentId !== 0n) continue
				if (actorMint13 <= 0n && refMint13 <= 0n) continue
				return true
			} catch {
				/* skip rule slot */
			}
		}
		return false
	} catch {
		return false
	}
}
