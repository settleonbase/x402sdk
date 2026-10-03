/**
 * Discover-visible merchants that exchange Reward PT for USDC and already
 * award Reward PT on Top-up or Charge (actor or Referrer).
 * Chain views on the card: `convertReward13ToUsdcRatioE6` > 0, and at least one of
 * `topupActorRewardRatioE6`, `chargeRewardRatioE6`, `referrerTopupAmountRatioE6`,
 * or `referrerChargeAmountRatioE6` > 0.
 * `getRewardRule(2)` and coupon metadata do not qualify a card.
 */
import { ethers } from 'ethers'
import { CONET_MULTICALL3 } from './chainAddresses'
import { providerForUserCardChain } from './beamioUserCardChain'
import { listBeamioCardsCreatedSince } from './db'
import {
	DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_ISO,
	passDiscoverFeaturedBrandsMerchantCardPolicy,
} from './endpoint/latestCardsShared'

const RATIO_IFACE = new ethers.Interface([
	'function topupActorRewardRatioE6() view returns (uint256)',
	'function chargeRewardRatioE6() view returns (uint256)',
	'function convertReward13ToUsdcRatioE6() view returns (uint256)',
	'function referrerTopupAmountRatioE6() view returns (uint256)',
	'function referrerChargeAmountRatioE6() view returns (uint256)',
])

const MULTICALL_IFACE = new ethers.Interface([
	'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
])

const TOPUP_CALL = RATIO_IFACE.encodeFunctionData('topupActorRewardRatioE6')
const CHARGE_CALL = RATIO_IFACE.encodeFunctionData('chargeRewardRatioE6')
const CONVERT_CALL = RATIO_IFACE.encodeFunctionData('convertReward13ToUsdcRatioE6')
const REF_TOPUP_CALL = RATIO_IFACE.encodeFunctionData('referrerTopupAmountRatioE6')
const REF_CHARGE_CALL = RATIO_IFACE.encodeFunctionData('referrerChargeAmountRatioE6')

/** Keep multicall payload size similar to the prior 3-call × 80-card batches. */
const CARDS_PER_CALL = 48
const CALLS_PER_CARD = 5

export type RewardPtUsdcMerchantRow = {
	cardAddress: string
	cardOwner: string
	topupRewardRatioE6: string
	chargeRewardRatioE6: string
	convertUsdcRatioE6: string
	referrerTopupRatioE6: string
	referrerChargeRatioE6: string
}

function decodeRatio(success: boolean, data: string): bigint | null {
	if (!success) return null
	const hex = String(data ?? '')
	if (!hex.startsWith('0x') || hex.length < 66) return null
	try {
		return BigInt(hex)
	} catch {
		return null
	}
}

async function readRatios(
	cards: Array<{ cardAddress: string; cardOwner: string }>,
): Promise<RewardPtUsdcMerchantRow[]> {
	if (cards.length === 0) return []
	const provider = providerForUserCardChain('conet')
	const multicall = new ethers.Contract(CONET_MULTICALL3, MULTICALL_IFACE, provider)
	const out: RewardPtUsdcMerchantRow[] = []
	for (let offset = 0; offset < cards.length; offset += CARDS_PER_CALL) {
		const slice = cards.slice(offset, offset + CARDS_PER_CALL)
		const calls = slice.flatMap((card) => [
			{ target: card.cardAddress, allowFailure: true, callData: TOPUP_CALL },
			{ target: card.cardAddress, allowFailure: true, callData: CHARGE_CALL },
			{ target: card.cardAddress, allowFailure: true, callData: CONVERT_CALL },
			{ target: card.cardAddress, allowFailure: true, callData: REF_TOPUP_CALL },
			{ target: card.cardAddress, allowFailure: true, callData: REF_CHARGE_CALL },
		])
		const raw = (await multicall.aggregate3.staticCall(calls)) as Array<{
			success: boolean
			returnData: string
		}>
		if (!Array.isArray(raw) || raw.length !== calls.length) {
			throw new Error('Reward PT merchant ratio batch returned an unexpected result')
		}
		for (let i = 0; i < slice.length; i++) {
			const base = i * CALLS_PER_CARD
			const topup = decodeRatio(raw[base].success, raw[base].returnData)
			const charge = decodeRatio(raw[base + 1].success, raw[base + 1].returnData)
			const convert = decodeRatio(raw[base + 2].success, raw[base + 2].returnData)
			const refTopup = decodeRatio(raw[base + 3].success, raw[base + 3].returnData)
			const refCharge = decodeRatio(raw[base + 4].success, raw[base + 4].returnData)
			if (convert == null || convert <= 0n) continue
			const hasActor = (topup ?? 0n) > 0n || (charge ?? 0n) > 0n
			const hasReferrer = (refTopup ?? 0n) > 0n || (refCharge ?? 0n) > 0n
			if (!hasActor && !hasReferrer) continue
			out.push({
				cardAddress: slice[i].cardAddress,
				cardOwner: slice[i].cardOwner,
				topupRewardRatioE6: (topup ?? 0n).toString(),
				chargeRewardRatioE6: (charge ?? 0n).toString(),
				convertUsdcRatioE6: convert.toString(),
				referrerTopupRatioE6: (refTopup ?? 0n).toString(),
				referrerChargeRatioE6: (refCharge ?? 0n).toString(),
			})
		}
	}
	return out
}

/** Discover-visible cards with USDC convert on and actor or Referrer Reward PT on. */
export async function listRewardPtUsdcMerchants(): Promise<RewardPtUsdcMerchantRow[]> {
	const rows = await listBeamioCardsCreatedSince(DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_ISO, 2000)
	const cards: Array<{ cardAddress: string; cardOwner: string }> = []
	const seen = new Set<string>()
	for (const row of rows) {
		if (!passDiscoverFeaturedBrandsMerchantCardPolicy(row)) continue
		let cardAddress = ''
		try {
			cardAddress = ethers.getAddress(row.cardAddress)
		} catch {
			continue
		}
		const key = cardAddress.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		cards.push({ cardAddress, cardOwner: String(row.cardOwner ?? '') })
	}
	return readRatios(cards)
}
