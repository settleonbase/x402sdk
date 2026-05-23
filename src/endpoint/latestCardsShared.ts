import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'
import { API_EXCLUDED_USER_CARD_ADDRESSES } from '../apiExcludedUserCards'

/**
 * latestCards / last-N 发卡列表：Cluster 与 Master 共用排除集（与 SilentPassUI USER_CARD_DISPLAY_EXCLUDED 对齐）。
 */
export const LATEST_CARDS_EXCLUDED = API_EXCLUDED_USER_CARD_ADDRESSES

/** 旧卡只放行这一张；从该时间点之后新发行的 BeamioUserCard 默认放行。 */
const DISCOVER_ALLOWED_LEGACY_CARD_LOWER = ethers.getAddress(
	'0x7334a7c7fE867538018fcC4CEA8b266E47600911',
).toLowerCase()
const DISCOVER_NEW_CARD_ALLOW_AFTER_MS = Date.parse('2026-05-23T00:30:00.000Z')

/** Apply after `LATEST_CARDS_EXCLUDED` + enrichment. */
export function filterLatestCardsByDiscoverMerchantPolicy(cards: BeamioLatestCardItem[]): BeamioLatestCardItem[] {
	return cards.filter((c) => {
		const cardAddress = (c.cardAddress || '').trim()
		if (!cardAddress || !ethers.isAddress(cardAddress)) return false
		if (ethers.getAddress(cardAddress).toLowerCase() === DISCOVER_ALLOWED_LEGACY_CARD_LOWER) return true
		const createdAtMs = Date.parse(String(c.createdAt || ''))
		return Number.isFinite(createdAtMs) && createdAtMs >= DISCOVER_NEW_CARD_ALLOW_AFTER_MS
	})
}
