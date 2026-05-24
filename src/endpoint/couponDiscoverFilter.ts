import { ethers } from 'ethers'
import { getCardCreatedAtByAddress } from '../db'
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
	return out
}

export async function isCouponCardDiscoverVisible(cardAddress: string): Promise<boolean> {
	const raw = cardAddress?.trim()
	if (!raw || !ethers.isAddress(raw)) return false
	const checksum = ethers.getAddress(raw)
	const createdAt = await getCardCreatedAtByAddress(checksum)
	return passDiscoverFeaturedBrandsMerchantCardPolicy({ cardAddress: checksum, createdAt })
}
