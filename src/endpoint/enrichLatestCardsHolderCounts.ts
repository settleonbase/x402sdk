import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'
import { logger } from '../logger'
import Colors from 'colors/safe'

/** AdminStatsPeriodLib: valid periodType; cumulative slice when cumulativeStartTs=0 仍见合约实现 */
const PERIOD_HOUR = 0

const POINTS_TOKEN_ID = 0n

/**
 * Full `GlobalStatsFullView` 与链上 `BeamioUserCardAdminStatsQueryModuleV1.getGlobalStatsFull` 一致（经 BeamioUserCard fallback）。
 * @see src/BeamioUserCard/readme.md — getGlobalStatsFull
 */
const CARD_HOLDER_METRICS_ABI = [
	'function totalSupply(uint256 id) view returns (uint256)',
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
 * latestCards：链上 enrichment。
 * - `holderCount`：`totalActiveMemberships`，否则 `cumulativeIssued + cumulativeUpgraded`。
 * - `token0TotalSupply6`：`totalSupply(0)` 当前流通。
 * - `token0CumulativeMint6`：`getGlobalStatsFull.cumulativeMint`（统计窗口内 token #0 累计 mint）。
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
			const [supply0, active, tup] = await Promise.all([
				card.totalSupply(POINTS_TOKEN_ID),
				card.totalActiveMemberships(),
				card.getGlobalStatsFull(PERIOD_HOUR, 0, 0),
			])
			const g = tup as ethers.Result
			const cumulativeMint = g[0] as bigint
			let n = toSafeNonNegInt(active as bigint)
			if (n === 0) {
				const issued = (g[6] as bigint) + (g[7] as bigint)
				n = toSafeNonNegInt(issued)
			}
			out.push({
				...it,
				holderCount: n,
				token0TotalSupply6: (supply0 as bigint).toString(),
				token0CumulativeMint6: cumulativeMint.toString(),
			})
		} catch (e: any) {
			logger(Colors.gray(`[latestCards holders] ${it.cardAddress}: ${e?.message ?? e}`))
			out.push(it)
		}
	}
	return out
}
