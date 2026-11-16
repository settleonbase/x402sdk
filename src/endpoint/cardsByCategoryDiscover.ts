import type { BeamioLatestCardItem } from '../db'
import { passDiscoverFeaturedBrandsMerchantCardPolicy } from './latestCardsShared'

/** getLatestCardsGroupedByCategory 的一个分组。 */
export type CardsByCategoryGroup = { categoryId: string; items: BeamioLatestCardItem[] }

export type CardsByCategoryDiscoverDeps = {
	/**
	 * 由调用方注入 agent temp 过滤（agentTempDiscoverVisibility.ts，读取链上注册表）。
	 * 不在本模块静态导入，使本模块保持纯函数；测试注入桩，避免链上读取。
	 */
	omitUnhandedAgentTemp: (cards: BeamioLatestCardItem[]) => Promise<BeamioLatestCardItem[]>
}

/**
 * GET /api/cardsByCategory 对外可见性过滤，口径与 latestCards（computeLatestCardsSuperset）完全一致：
 *  1. passDiscoverFeaturedBrandsMerchantCardPolicy：API_EXCLUDED 排除 + 发卡时间 cutover（2026-05-23）；
 *  2. agent temp 过滤（由调用方注入，Master 注入 fail-closed 版本）：owner 仍是未移交 agent temp 的卡不列出；
 *     链上无法判定（读取失败）的 owner 不展示，除非本进程在有效期内曾读为可见。与 latestCards 的 fail-open 口径不同，见待审单。
 * 过滤后为空的分组整体去掉（与被删的 Cluster 旧实现一致）。pin 排序不适用于分类列表，故不做 pin。
 * 必须在返回公网之前调用；Master 与 Cluster 之间的透传不做过滤。
 */
export async function filterCardsByCategoryGroupsForDiscover(
	groups: CardsByCategoryGroup[],
	deps: CardsByCategoryDiscoverDeps,
): Promise<CardsByCategoryGroup[]> {
	const omit = deps.omitUnhandedAgentTemp
	const policyPassed = groups.map((g) => ({
		categoryId: g.categoryId,
		items: g.items.filter((c) => passDiscoverFeaturedBrandsMerchantCardPolicy(c)),
	}))
	const unique = new Map<string, BeamioLatestCardItem>()
	for (const g of policyPassed) {
		for (const c of g.items) {
			const key = (c.cardAddress || '').toLowerCase()
			if (!unique.has(key)) unique.set(key, c)
		}
	}
	const kept = new Set((await omit([...unique.values()])).map((c) => (c.cardAddress || '').toLowerCase()))
	return policyPassed
		.map((g) => ({ categoryId: g.categoryId, items: g.items.filter((c) => kept.has((c.cardAddress || '').toLowerCase())) }))
		.filter((g) => g.items.length > 0)
}
