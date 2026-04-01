import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'
import { logger } from '../logger'
import Colors from 'colors/safe'

/** AdminStatsPeriodLib: valid periodType; cumulative slice when cumulativeStartTs=0 仍见合约实现 */
const PERIOD_HOUR = 0

/**
 * Full `GlobalStatsFullView` 与链上 `BeamioUserCardAdminStatsQueryModuleV1.getGlobalStatsFull` 一致（经 BeamioUserCard fallback）。
 * @see src/BeamioUserCard/readme.md — getGlobalStatsFull
 */
const CARD_HOLDER_METRICS_ABI = [
	'function totalActiveMemberships() view returns (uint256)',
	'function getGlobalStatsFull(uint8 periodType, uint256 anchorTs, uint256 cumulativeStartTs) view returns (uint256 cumulativeMint, uint256 cumulativeBurn, uint256 cumulativeTransfer, uint256 cumulativeTransferAmount, uint256 cumulativeRedeemMint, uint256 cumulativeUSDCMint, uint256 cumulativeIssued, uint256 cumulativeUpgraded, uint256 periodMint, uint256 periodBurn, uint256 periodTransfer, uint256 periodTransferAmount, uint256 periodRedeemMint, uint256 periodUSDCMint, uint256 periodIssued, uint256 periodUpgraded, uint256 adminCount, uint256 cumulativeAdminToAdminTransfer, uint256 cumulativeAdminToAdminTransferAmount, uint256 periodAdminToAdminTransfer, uint256 periodAdminToAdminTransferAmount, uint256 lifetimeAdminToAdminTransferCount, uint256 lifetimeAdminToAdminTransferAmount)',
] as const

function toSafeNonNegInt(n: bigint): number {
	const x = Number(n)
	if (!Number.isFinite(x) || x < 0) return 0
	if (x > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
	return Math.trunc(x)
}

/**
 * latestCards `holderCount`：链上 BeamioUserCard（readme 全局统计 / 会员计数）。
 * - 优先 `totalActiveMemberships`（当前有效会员数）。
 * - 若仍为 0，用 `getGlobalStatsFull` 的 `cumulativeIssued + cumulativeUpgraded`（默认累计窗口内发卡/升级量，作参与度下界）。
 * 不依赖部署 txHash、不扫 getLogs，避免 RPC/DB 导致恒为 0。
 */
export async function enrichLatestCardsWithBaseErc1155PointsHolderCounts(
	items: BeamioLatestCardItem[],
	provider: ethers.Provider,
): Promise<BeamioLatestCardItem[]> {
	if (items.length === 0) return items
	const out: BeamioLatestCardItem[] = []
	for (const it of items) {
		try {
			const card = new ethers.Contract(it.cardAddress, CARD_HOLDER_METRICS_ABI, provider)
			const active = (await card.totalActiveMemberships()) as bigint
			let n = toSafeNonNegInt(active)
			if (n === 0) {
				const tup = (await card.getGlobalStatsFull(PERIOD_HOUR, 0, 0)) as ethers.Result
				const issued = (tup[6] as bigint) + (tup[7] as bigint)
				n = toSafeNonNegInt(issued)
			}
			out.push({ ...it, holderCount: n })
		} catch (e: any) {
			logger(Colors.gray(`[latestCards holders] ${it.cardAddress}: ${e?.message ?? e}`))
			out.push(it)
		}
	}
	return out
}
