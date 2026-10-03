/**
 * Merchants whose Top-up or Charge Reward PT is on, and whose Reward PT → USDC
 * convert switch is on. Both flags are the card's CoNET views, not coupon metadata.
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
])

const MULTICALL_IFACE = new ethers.Interface([
	'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
])

const TOPUP_CALL = RATIO_IFACE.encodeFunctionData('topupActorRewardRatioE6')
const CHARGE_CALL = RATIO_IFACE.encodeFunctionData('chargeRewardRatioE6')
const CONVERT_CALL = RATIO_IFACE.encodeFunctionData('convertReward13ToUsdcRatioE6')

const CARDS_PER_CALL = 80

export type RewardPtUsdcMerchantRow = {
	cardAddress: string
	cardOwner: string
	topupRewardRatioE6: string
	chargeRewardRatioE6: string
	convertUsdcRatioE6: string
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
		])
		const raw = (await multicall.aggregate3.staticCall(calls)) as Array<{
			success: boolean
			returnData: string
		}>
		if (!Array.isArray(raw) || raw.length !== calls.length) {
			throw new Error('Reward PT merchant ratio batch returned an unexpected result')
		}
		for (let i = 0; i < slice.length; i++) {
			const topup = decodeRatio(raw[i * 3].success, raw[i * 3].returnData)
			const charge = decodeRatio(raw[i * 3 + 1].success, raw[i * 3 + 1].returnData)
			const convert = decodeRatio(raw[i * 3 + 2].success, raw[i * 3 + 2].returnData)
			if (topup == null || charge == null || convert == null) continue
			if (convert <= 0n) continue
			if (topup <= 0n && charge <= 0n) continue
			out.push({
				cardAddress: slice[i].cardAddress,
				cardOwner: slice[i].cardOwner,
				topupRewardRatioE6: topup.toString(),
				chargeRewardRatioE6: charge.toString(),
				convertUsdcRatioE6: convert.toString(),
			})
		}
	}
	return out
}

/** Discover-visible cards with Top-up or Charge Reward PT, and PT → USDC convert on. */
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
