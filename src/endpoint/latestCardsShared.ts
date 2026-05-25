import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'
import { isApiExcludedUserCard } from '../apiExcludedUserCards'

/**
 * Featured Brands / Discover 商户可见性 — **全项目唯一标准**（见 `.cursor/rules/beamio-discover-merchant-visibility-single-standard.mdc`）。
 *
 * Gate 第一步：`isApiExcludedUserCard`（含废弃 infrastructure 卡 `0xBCcfA50…`、CCSA 卡 `0x2032A363…` 及 `apiExcludedUserCards.ts` 全集）。
 * 适用：Featured Brands、`/api/latestCards`、公开优惠券列表等 **对外 Discover 展示**。
 * 不适用：用户已持有资产、POS 终端绑定卡、必填 `cardAddress` 的写操作预检（仍可用 `isApiExcludedUserCard` 硬拒绝废弃地址）。
 */

/** @deprecated 请改用 `passDiscoverFeaturedBrandsMerchantCardPolicy`；保留别名供存量 import。 */
export { API_EXCLUDED_USER_CARD_ADDRESSES as LATEST_CARDS_EXCLUDED } from '../apiExcludedUserCards'

/** 此时间点（含）之后 `beamio_cards.created_at` 的新发卡默认对 Discover 可见。 */
export const DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_ISO = '2026-05-23T00:30:00.000Z'
export const DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_MS = Date.parse(DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_ISO)

/**
 * Featured Brands Discover 可见性（唯一 gate）：`apiExcludedUserCards` exclude + 发卡时间 cutover。
 */
export function passDiscoverFeaturedBrandsMerchantCardPolicy(card: {
	cardAddress: string
	createdAt?: string | null
}): boolean {
	const cardAddress = (card.cardAddress || '').trim()
	if (!cardAddress || !ethers.isAddress(cardAddress)) return false
	if (isApiExcludedUserCard(cardAddress)) return false
	const createdAtMs = Date.parse(String(card.createdAt ?? ''))
	return Number.isFinite(createdAtMs) && createdAtMs >= DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_MS
}

/** @deprecated 内部 cutover 子规则；新代码请用 `passDiscoverFeaturedBrandsMerchantCardPolicy`。 */
export function passDiscoverMerchantCardPolicy(card: {
	cardAddress: string
	createdAt?: string | null
}): boolean {
	return passDiscoverFeaturedBrandsMerchantCardPolicy(card)
}

export function filterLatestCardsByDiscoverMerchantPolicy(cards: BeamioLatestCardItem[]): BeamioLatestCardItem[] {
	return cards.filter((c) => passDiscoverFeaturedBrandsMerchantCardPolicy(c))
}
