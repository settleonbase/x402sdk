/**
 * 共享的 getUIDAssets 资产拉取逻辑。供 Cluster（已有 EOA 时）与 Master（provision 完成后）共同使用。
 */
import { ethers } from 'ethers'
import { logger } from '../logger'
import Colors from 'colors/safe'
import { getCardByAddress, getNftTierMetadataByCardAndToken, getNftTierMetadataByOwnerAndToken } from '../db'
import { BASE_AA_FACTORY, BASE_CCSA_CARD_ADDRESS, BEAMIO_USER_CARD_ASSET_ADDRESS } from '../chainAddresses'

const DEPRECATED_INFRA_CARDS = new Set([
	'0x74f35741ad8bc75d873a8d7d140ae5ffb529ac0f'.toLowerCase(),
])

const BASE_RPC_URL = (typeof process !== 'undefined' && process.env?.BASE_RPC_URL?.trim()) || 'https://1rpc.io/base'
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const resolveBeamioAccountOf = async (eoa: string): Promise<string | null> => {
	try {
		const aaFactoryAbi = ['function beamioAccountOf(address) view returns (address)']
		const aaFactory = new ethers.Contract(BASE_AA_FACTORY, aaFactoryAbi, providerBase)
		const result = await providerBase.call({
			to: BASE_AA_FACTORY as `0x${string}`,
			data: (aaFactory.interface.encodeFunctionData('beamioAccountOf', [eoa]) as `0x${string}`),
		})
		if (!result || result === '0x') return null
		const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address'], result)
		const addr = decoded[0] as string
		if (!addr || addr === ethers.ZeroAddress) return null
		const code = await providerBase.getCode(addr)
		return code && code !== '0x' && code.length > 2 ? ethers.getAddress(addr) : null
	} catch {
		return null
	}
}

export type FetchUIDAssetsResult = {
	ok: true
	address: string
	aaAddress?: string
	usdcBalance: string
	cards: Array<{
		cardAddress: string
		cardName: string
		cardType: string
		points: string
		points6: string
		cardCurrency: string
		cardBackground?: string
		cardImage?: string
		tierName?: string
		tierDescription?: string
		nfts: Array<{ tokenId: string; attribute: string; tier: string; expiry: string; isExpired: boolean }>
	}>
}

export const fetchUIDAssetsForEOA = async (eoa: string): Promise<FetchUIDAssetsResult> => {
	const eoaAddr = ethers.getAddress(eoa)
	const cardAbi = [
		'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
		'function currency() view returns (uint8)',
	]
	const usdcAbi = ['function balanceOf(address) view returns (uint256)']
	const usdc = new ethers.Contract(USDC_BASE, usdcAbi, providerBase)
	const [usdcEoaRaw, aaAddr] = await Promise.all([
		usdc.balanceOf(eoaAddr),
		resolveBeamioAccountOf(eoaAddr),
	])
	let usdcTotalRaw = usdcEoaRaw
	if (aaAddr) {
		const usdcAaRaw = await usdc.balanceOf(aaAddr)
		usdcTotalRaw += usdcAaRaw
	}
	const usdcBalance = ethers.formatUnits(usdcTotalRaw, 6)
	const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
	const cardAddresses: { address: string; name: string; type: string }[] = [
		{ address: BASE_CCSA_CARD_ADDRESS, name: 'CCSA CARD', type: 'ccsa' },
		{ address: BEAMIO_USER_CARD_ASSET_ADDRESS, name: 'CashTrees Card', type: 'infrastructure' },
	].filter(({ address }) => !DEPRECATED_INFRA_CARDS.has(address.toLowerCase()))
	const cards: FetchUIDAssetsResult['cards'] = []
	for (const { address: cardAddr, name: cardName, type: cardType } of cardAddresses) {
		try {
			const card = new ethers.Contract(cardAddr, cardAbi, providerBase)
			const [[pointsBalance, nfts], currencyNum] = await Promise.all([
				card.getOwnershipByEOA(eoaAddr),
				card.currency(),
			])
			const currency = currencyMap[Number(currencyNum)] ?? 'CAD'
			const nftList = nfts.map((nft: { tokenId: bigint; attribute: bigint; tierIndexOrMax: bigint; expiry: bigint; isExpired: boolean }) => ({
				tokenId: nft.tokenId.toString(),
				attribute: nft.attribute.toString(),
				tier: nft.tierIndexOrMax === ethers.MaxUint256 ? 'Default/Max' : nft.tierIndexOrMax.toString(),
				expiry: nft.expiry === 0n ? 'Never' : new Date(Number(nft.expiry) * 1000).toLocaleString(),
				isExpired: nft.isExpired,
			}))
			let cardBackground: string | undefined
			let cardImage: string | undefined
			let tierName: string | undefined
			let tierDescription: string | undefined
			const withTokenId = nftList.filter((n: { tokenId: string }) => Number(n.tokenId) > 0)
			logger(Colors.gray(`[fetchUIDAssetsForEOA] card=${cardAddr} withTokenId=${withTokenId.length}`))
			const bestNft = withTokenId.length > 0
				? withTokenId.reduce((a: { tokenId: string; tier: string }, b: { tokenId: string; tier: string }) => (Number(b.tokenId) > Number(a.tokenId) ? b : a))
				: null
			let cardRow: { cardOwner: string; metadata: Record<string, unknown> | null } | null = null
			if (bestNft) {
				try {
					cardRow = await getCardByAddress(cardAddr)
					let tierMeta = await getNftTierMetadataByCardAndToken(cardAddr, bestNft.tokenId)
					if (!tierMeta && cardRow?.cardOwner) {
						tierMeta = await getNftTierMetadataByOwnerAndToken(cardRow.cardOwner, bestNft.tokenId)
					}
					if (tierMeta && typeof tierMeta === 'object') {
						const props = tierMeta.properties as Record<string, unknown> | undefined
						const bg = (props?.background_color ?? tierMeta.background_color) as string | undefined
						if (bg && typeof bg === 'string' && bg.trim()) {
							cardBackground = bg.trim().startsWith('#') ? bg.trim() : `#${bg.trim().replace(/^#/, '')}`
						}
						const img = (props?.image ?? tierMeta.image) as string | undefined
						if (img && typeof img === 'string' && img.trim()) cardImage = img.trim()
						tierName = (props?.tier_name ?? tierMeta.name) as string | undefined
						if (tierName && typeof tierName === 'string' && tierName.trim()) tierName = tierName.trim()
						else tierName = undefined
						tierDescription = (props?.tier_description ?? tierMeta.description) as string | undefined
						if (tierDescription && typeof tierDescription === 'string' && tierDescription.trim()) tierDescription = tierDescription.trim()
						else tierDescription = undefined
					}
					if ((!tierName || !tierDescription || !cardBackground || !cardImage) && cardRow?.metadata?.tiers && Array.isArray(cardRow.metadata.tiers)) {
						const tiersRaw = cardRow.metadata.tiers as Array<{ index?: number; minUsdc6?: string; name?: string; description?: string; image?: string; backgroundColor?: string }>
						const minUsdc6Num = (t: { minUsdc6?: string }) => {
							const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : ''
							const n = parseInt(s, 10)
							return Number.isNaN(n) ? Infinity : n
						}
						const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b))
						const tierIndexChain = bestNft.tier === 'Default/Max' ? 0 : (parseInt(bestNft.tier, 10) || 0)
						const t = bestNft.tier === 'Default/Max'
							? tiersSorted[0]
							: (tiersRaw.find((x: { index?: number }, i: number) => (x.index != null ? x.index : i) === tierIndexChain) ?? tiersRaw[tierIndexChain])
						if (t) {
							if (!tierName && t.name && String(t.name).trim()) tierName = String(t.name).trim()
							if (!tierDescription && t.description && String(t.description).trim()) tierDescription = String(t.description).trim()
							if (!cardImage && t.image && String(t.image).trim()) cardImage = String(t.image).trim()
							if (!cardBackground && t.backgroundColor && String(t.backgroundColor).trim()) {
								const bg = String(t.backgroundColor).trim()
								cardBackground = bg.startsWith('#') ? bg : `#${bg.replace(/^#/, '')}`
							}
						}
						if (!tierName && (bestNft.tier === 'Default/Max' || tierIndexChain === 0)) tierName = 'Default'
						else if (!tierName) tierName = `Tier ${tierIndexChain + 1}`
					}
				} catch {
					/* ignore */
				}
			}
			const hasPoints = pointsBalance > 0n
			const hasNftGt0 = nftList.some((n: { tokenId: string }) => Number(n.tokenId) > 0)
			if (hasPoints || hasNftGt0) {
				cards.push({
					cardAddress: cardAddr,
					cardName,
					cardType,
					points: ethers.formatUnits(pointsBalance, 6),
					points6: String(pointsBalance),
					cardCurrency: currency,
					...(cardBackground != null && { cardBackground }),
					...(cardImage != null && { cardImage }),
					...(tierName != null && { tierName }),
					...(tierDescription != null && { tierDescription }),
					nfts: nftList,
				})
			}
		} catch (cardErr: unknown) {
			logger(Colors.gray(`[fetchUIDAssetsForEOA] card=${cardAddr} skip: ${(cardErr as Error)?.message ?? cardErr}`))
		}
	}
	const cardsFiltered = cards.filter((c) => !DEPRECATED_INFRA_CARDS.has(c.cardAddress.toLowerCase()))
	return {
		ok: true,
		address: eoaAddr,
		aaAddress: aaAddr || undefined,
		usdcBalance,
		cards: cardsFiltered,
	}
}
