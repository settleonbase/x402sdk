import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'

/** BeamioIndexerDiamond（CoNET）上 BeamioUserCardStatsFacet：按卡统计 tokenId=0（点数）持仓人数 */
const INDEXER_USER_CARD_NFT0_HOLDER_ABI = [
	'function getBeamioUserCardNft0HolderCount(address beamioUserCard) view returns (uint256)',
] as const

/**
 * 用索引合约的 on-chain 统计覆盖每条 latest card 的 holderCount（indexedHolderCountByAssetToken[card][0]）。
 * 单次调用失败时保留数据库原值。
 */
export async function enrichLatestCardsWithIndexerNft0HolderCounts(
	items: BeamioLatestCardItem[],
	indexerDiamondAddress: string,
	provider: ethers.Provider,
): Promise<BeamioLatestCardItem[]> {
	if (items.length === 0) return items
	const indexer = new ethers.Contract(indexerDiamondAddress, INDEXER_USER_CARD_NFT0_HOLDER_ABI, provider)
	const results = await Promise.all(
		items.map(async (it) => {
			try {
				const n = await indexer.getBeamioUserCardNft0HolderCount(it.cardAddress)
				const hc = Number(n)
				if (!Number.isFinite(hc) || hc < 0) return it
				return { ...it, holderCount: hc }
			} catch {
				return it
			}
		}),
	)
	return results
}
