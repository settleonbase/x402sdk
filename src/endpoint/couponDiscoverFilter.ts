import { ethers } from 'ethers'
import { getCardByAddress, getCardCreatedAtByAddress } from '../db'
import { omitCardsOwnedByUnhandedAgentTemp } from './agentTempDiscoverVisibility'
import { passDiscoverFeaturedBrandsMerchantCardPolicy } from './latestCardsShared'

/** Filter coupon rows with the same gate as Featured Brands (`latestCardsShared.ts`). */
export async function filterCouponSeriesRowsByDiscoverMerchantPolicy<T extends { cardAddress?: string }>(
	rows: T[]
): Promise<T[]> {
	const visibilityByCard = new Map<string, boolean>()
	const out: T[] = []
	for (const row of rows) {
		const raw = row.cardAddress?.trim()
		if (!raw || !ethers.isAddress(raw)) continue
		const lower = ethers.getAddress(raw).toLowerCase()
		if (!visibilityByCard.has(lower)) {
			const createdAt = await getCardCreatedAtByAddress(lower)
			visibilityByCard.set(
				lower,
				passDiscoverFeaturedBrandsMerchantCardPolicy({ cardAddress: lower, createdAt })
			)
		}
		if (visibilityByCard.get(lower)) out.push(row)
	}
	const owners = new Map<string, string>()
	for (const row of out) {
		const lower = ethers.getAddress(String(row.cardAddress)).toLowerCase()
		if (owners.has(lower)) continue
		const record = await getCardByAddress(lower).catch(() => null)
		owners.set(lower, record?.cardOwner ?? '')
	}
	const kept = await omitCardsOwnedByUnhandedAgentTemp(
		out.map((row) => ({
			row,
			cardOwner: owners.get(ethers.getAddress(String(row.cardAddress)).toLowerCase()) ?? '',
		})),
	)
	return kept.map((item) => item.row)
}

export async function isCouponCardDiscoverVisible(cardAddress: string): Promise<boolean> {
	const raw = cardAddress?.trim()
	if (!raw || !ethers.isAddress(raw)) return false
	const checksum = ethers.getAddress(raw)
	const createdAt = await getCardCreatedAtByAddress(checksum)
	if (!passDiscoverFeaturedBrandsMerchantCardPolicy({ cardAddress: checksum, createdAt })) return false
	const record = await getCardByAddress(checksum).catch(() => null)
	const kept = await omitCardsOwnedByUnhandedAgentTemp([
		{ cardOwner: record?.cardOwner ?? '' },
	])
	return kept.length === 1
}
