/**
 * 共享的 getUIDAssets 资产拉取逻辑。供 Cluster（已有 EOA 时）与 Master（provision 完成后）共同使用。
 */
import { ethers } from 'ethers'
import { logger } from '../logger'
import Colors from 'colors/safe'
import {
	getCardByAddress,
	getNftTierMetadataByCardAndToken,
	getNftTierMetadataByOwnerAndToken,
	beamio_ContractPool,
	getMemberLastTopupOnCard,
	maybeEnqueueNfcCashTreeBeamioTag,
	maybeEnqueueNfcVerraBeamioTag,
} from '../db'
import { BASE_CCSA_CARD_ADDRESS, BEAMIO_USER_CARD_ASSET_ADDRESS } from '../chainAddresses'
import { pickBestMembershipNftByMinUsdc6 } from './membershipTierPick'
import { resolveBeamioAaForEoaWithFallback } from './resolveBeamioAaViaUserCardFactory'
import { pickTierMetadataRowForChainSlot, type CardTierMetadataRow } from './tierMetadataRowResolve'

/** 已废弃的旧基础设施卡地址，getUIDAssets 不查询、不返回。当前 BEAMIO_USER_CARD_ASSET_ADDRESS (0x74f35741...) 必须不在本列表。 */
const DEPRECATED_INFRA_CARDS = new Set([
	'0xB7644DDb12656F4854dC746464af47D33C206F0E'.toLowerCase(),
	'0xC0F1c74fb95100a97b532be53B266a54f41DB615'.toLowerCase(),
	'0x02BAe511632354584b198951B42eC73BACBc4E98'.toLowerCase(),
])

/** 与 util.resolveBeamioBaseHttpRpcUrl 一致；此处不 import util，避免经 db 与 util/server 形成循环依赖 */
const BASE_RPC_URL =
	(typeof process !== 'undefined' && process.env?.BASE_RPC_URL?.trim()) || 'https://base-rpc.conet.network'
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const resolveBeamioAccountOf = async (eoa: string): Promise<string | null> =>
	resolveBeamioAaForEoaWithFallback(providerBase, eoa)

/**
 * 从链上 AccountRegistry 读 EOA 的 beamioTag（accountName）；去掉首尾空白与前缀 `@`。
 * 无登记、`exists` 为 false 或 RPC 失败时返回 undefined。
 */
export async function fetchBeamioTagForEoa(eoa: string): Promise<string | undefined> {
	let eoaAddr: string
	try {
		eoaAddr = ethers.getAddress(String(eoa || '').trim())
	} catch {
		return undefined
	}
	const reg = beamio_ContractPool[0]?.constAccountRegistry
	if (!reg) return undefined
	try {
		const o = await reg.getAccount(eoaAddr)
		if (!o?.exists) return undefined
		const raw = String(o.accountName ?? '')
			.trim()
			.replace(/^@+/, '')
			.trim()
		return raw !== '' ? raw : undefined
	} catch {
		return undefined
	}
}

export type FetchUIDAssetsResult = {
	ok: true
	address: string
	aaAddress?: string
	/** AccountRegistry `accountName`（无 `@`）；无链上账户或未设置时省略 */
	beamioTag?: string
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
		/** 档展示名：优先卡级 metadata.tiers[].name（与链上主档索引对齐），无则回退 NFT 库元数据 / 占位。客户端应优先用本字段而非自行拼「Tier N」。 */
		tierName?: string
		tierDescription?: string
		/** Best membership NFT on this card by max `tiers[i].minUsdc6` (matches `_findBestValidMembership`). */
		primaryMemberTokenId?: string
		nfts: Array<{ tokenId: string; attribute: string; tier: string; expiry: string; isExpired: boolean }>
	}>
	/**
	 * 本次查询所用基础设施卡（`merchantInfraCard` / `infrastructureCardAddress` 或默认常量）上，该会员 EOA 在 DB 中的最近一笔 top-up。
	 * 与 `getMemberLastTopupOnCard` / `insertMemberTopupEvent` 一致；无记录时字段省略。
	 */
	posLastTopupAt?: string
	posLastTopupUsdcE6?: string
	posLastTopupPointsE6?: string
}

/** POS / 客户端可选：指定终端登记的基础设施 BeamioUserCard 地址；若与默认常量不一致则查询该合约。 */
export type FetchUIDAssetsOptions = {
	infrastructureCardAddress?: string
	/**
	 * `merchantInfraOnly`：仅返回该基础设施卡一行（含余额为 0），用于 POS「Check Balance」。
	 * `infrastructureOnly`：仅查询/返回解析后的基础设施卡（`merchantInfraCard` 或默认常量），不附带 CCSA。
	 * `all`（默认）：CCSA + 基础设施（与历史行为一致）。
	 */
	cardsScope?: 'all' | 'merchantInfraOnly' | 'infrastructureOnly'
	/** getWalletAssets 历史行为：即使 points/NFT 全空也返回该卡一行。 */
	includeZeroBalanceCards?: boolean
}

const resolveInfrastructureCardAddress = (opt?: string): string => {
	if (opt && typeof opt === 'string') {
		try {
			const a = ethers.getAddress(opt.trim())
			if (!DEPRECATED_INFRA_CARDS.has(a.toLowerCase())) return a
		} catch {
			/* fall through */
		}
	}
	return BEAMIO_USER_CARD_ASSET_ADDRESS
}

/** 与 MemberCard / cardMetadata 一致：优先 shareTokenMetadata.name，其次顶层 name。 */
function displayNameFromCardMetadata(m: Record<string, unknown> | null | undefined): string | null {
	if (!m || typeof m !== 'object') return null
	const stm = m.shareTokenMetadata as Record<string, unknown> | undefined
	const n1 = stm?.name
	if (typeof n1 === 'string' && n1.trim()) return n1.trim()
	const n2 = m.name
	if (typeof n2 === 'string' && n2.trim()) return n2.trim()
	return null
}

/**
 * 仅用 metadata.tiers 的 index / 数组下标对齐链上档（回退用）。
 */
function pickCardMetadataTierRow(tiersRaw: CardTierMetadataRow[], bestNftTier: string): CardTierMetadataRow | null {
	if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) return null
	const minUsdc6Num = (t: { minUsdc6?: string | number | null }) => {
		const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : ''
		const n = parseInt(s, 10)
		return Number.isNaN(n) ? Infinity : n
	}
	const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b))
	if (bestNftTier === 'Default/Max') return tiersSorted[0] ?? null
	const tierIndexChain = parseInt(bestNftTier, 10) || 0
	const byIndex = tiersRaw.find((x, i) => (x.index != null ? x.index : i) === tierIndexChain)
	return byIndex ?? tiersRaw[tierIndexChain] ?? null
}

/**
 * 解析卡 metadata.tiers 展示行：由 {@link pickTierMetadataRowForChainSlot} 优先按 `tierIndex`，
 * 找不到再按链上 `tiers(tierIndex).minUsdc6` 回退；链上调用失败时仅用 index/下标。
 */
async function pickCardMetadataTierRowForChain(
	card: ethers.Contract,
	tiersRaw: CardTierMetadataRow[],
	bestNftTier: string,
	primaryNftAttribute?: string | null
): Promise<CardTierMetadataRow | null> {
	if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) return null
	const minUsdc6Num = (t: { minUsdc6?: string | number | null }) => {
		const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : ''
		const n = parseInt(s, 10)
		return Number.isNaN(n) ? Infinity : n
	}
	const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b))
	if (bestNftTier === 'Default/Max') return tiersSorted[0] ?? null

	const tierIndexChain = Number.parseInt(bestNftTier, 10)
	if (!Number.isFinite(tierIndexChain) || tierIndexChain < 0) {
		return pickCardMetadataTierRow(tiersRaw, bestNftTier)
	}

	const c = card as ethers.Contract & { tiers: (i: bigint) => Promise<[bigint, bigint, bigint]> }
	try {
		const trow = await c.tiers(BigInt(tierIndexChain))
		const picked = pickTierMetadataRowForChainSlot(
			tiersRaw,
			tierIndexChain,
			trow[0].toString(),
			trow[1],
			primaryNftAttribute
		)
		if (picked) return picked
	} catch {
		/* tiers(i) revert */
	}

	return pickCardMetadataTierRow(tiersRaw, bestNftTier)
}

export const fetchUIDAssetsForEOA = async (eoa: string, opts?: FetchUIDAssetsOptions): Promise<FetchUIDAssetsResult> => {
	const eoaAddr = ethers.getAddress(eoa)
	const cardAbi = [
		'function getOwnership(address user) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
		'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
		'function currency() view returns (uint8)',
		'function tiers(uint256) view returns (uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds)',
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
	const infraAddr = resolveInfrastructureCardAddress(opts?.infrastructureCardAddress)
	const merchantInfraOnly = opts?.cardsScope === 'merchantInfraOnly'
	const infrastructureOnly = opts?.cardsScope === 'infrastructureOnly'
	const singleInfraScope = merchantInfraOnly || infrastructureOnly
	const infraFallbackName = 'Infrastructure card'
	const cardAddresses: { address: string; name: string; type: string }[] = singleInfraScope
		? [{ address: infraAddr, name: infraFallbackName, type: 'infrastructure' }]
		: [
				{ address: BASE_CCSA_CARD_ADDRESS, name: 'CCSA CARD', type: 'ccsa' },
				{ address: infraAddr, name: infraFallbackName, type: 'infrastructure' },
			].filter(({ address }) => !DEPRECATED_INFRA_CARDS.has(address.toLowerCase()))
	const cardsStaged: { row: FetchUIDAssetsResult['cards'][number]; sortMin: bigint }[] = []
	for (const { address: cardAddr, name: fallbackDisplayName, type: cardType } of cardAddresses) {
		let cardName = fallbackDisplayName
		try {
			let cardRow: { cardOwner: string; metadata: Record<string, unknown> | null } | null = null
			try {
				cardRow = await getCardByAddress(cardAddr)
			} catch {
				/* DB 失败仍用链上数据 */
			}
			cardName = displayNameFromCardMetadata(cardRow?.metadata ?? undefined) ?? fallbackDisplayName
			const card = new ethers.Contract(cardAddr, cardAbi, providerBase)
			const [[pointsBalance, nfts], currencyNum] = await Promise.all([
				aaAddr ? card.getOwnership(aaAddr) : card.getOwnershipByEOA(eoaAddr),
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
			const pick = await pickBestMembershipNftByMinUsdc6(
				card,
				nfts.map((nft: { tokenId: bigint; tierIndexOrMax: bigint; isExpired: boolean }) => ({
					tokenId: nft.tokenId,
					tierIndexOrMax: nft.tierIndexOrMax,
					isExpired: nft.isExpired,
				}))
			)
			const bestNft = pick ? nftList.find((n: { tokenId: string }) => n.tokenId === pick.tokenId) ?? null : null
			if (bestNft) {
				try {
					let tierMeta = await getNftTierMetadataByCardAndToken(cardAddr, bestNft.tokenId)
					if (!tierMeta && aaAddr) {
						tierMeta = await getNftTierMetadataByOwnerAndToken(aaAddr, bestNft.tokenId)
					}
					if (!tierMeta) {
						tierMeta = await getNftTierMetadataByOwnerAndToken(eoaAddr, bestNft.tokenId)
					}
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
					// 卡级 metadata.tiers：与主档链上索引对齐的 name 作为 tierName（覆盖 NFT 库里的占位文案），供 Android/Web 直接使用。
					if (cardRow?.metadata?.tiers && Array.isArray(cardRow.metadata.tiers)) {
						const tiersRaw = cardRow.metadata.tiers as CardTierMetadataRow[]
						const t = await pickCardMetadataTierRowForChain(card, tiersRaw, bestNft.tier, bestNft.attribute)
						if (t) {
							const cardTierName = t.name != null ? String(t.name).trim() : ''
							const cardTierDesc = t.description != null ? String(t.description).trim() : ''
							if (cardTierName) {
								tierName = cardTierName
								// 与 tierName 同源：卡级 tiers 命中 name 时，description 只认该行；无则清空，禁止沿用 NFT 库按 tokenId 缓存的旧档文案（升降级同 tokenId 会串档）。
								tierDescription = cardTierDesc !== '' ? cardTierDesc : undefined
							} else if (cardTierDesc !== '') {
								tierDescription = cardTierDesc
							}
							if (!cardImage && t.image && String(t.image).trim()) cardImage = String(t.image).trim()
							if (!cardBackground && t.backgroundColor && String(t.backgroundColor).trim()) {
								const bg = String(t.backgroundColor).trim()
								cardBackground = bg.startsWith('#') ? bg : `#${bg.replace(/^#/, '')}`
							}
						}
						const tierIndexChain = bestNft.tier === 'Default/Max' ? 0 : (parseInt(bestNft.tier, 10) || 0)
						if (!tierName) {
							if (bestNft.tier === 'Default/Max' || tierIndexChain === 0) tierName = 'Default'
							// 与 Android chainTierLabelFromPrimaryNft 一致：链上索引 N →「Tier N」
							else tierName = `Tier ${tierIndexChain}`
						}
					}
				} catch {
					/* ignore */
				}
			}
			const hasPoints = pointsBalance > 0n
			const hasNftGt0 = nftList.some((n: { tokenId: string }) => Number(n.tokenId) > 0)
			const includeRow = hasPoints || hasNftGt0 || merchantInfraOnly || opts?.includeZeroBalanceCards === true
			if (includeRow) {
				const row: FetchUIDAssetsResult['cards'][number] = {
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
					...(pick ? { primaryMemberTokenId: pick.tokenId } : {}),
					nfts: nftList,
				}
				cardsStaged.push({ row, sortMin: pick?.minUsdc6 ?? 0n })
			}
		} catch (cardErr: unknown) {
			logger(Colors.gray(`[fetchUIDAssetsForEOA] card=${cardAddr} skip: ${(cardErr as Error)?.message ?? cardErr}`))
			if (singleInfraScope && cardAddr.toLowerCase() === infraAddr.toLowerCase()) {
				try {
					const card = new ethers.Contract(cardAddr, cardAbi, providerBase)
					const currencyNum = await card.currency()
					const currency = currencyMap[Number(currencyNum)] ?? 'CAD'
					cardsStaged.push({
						row: {
							cardAddress: cardAddr,
							cardName,
							cardType,
							points: '0',
							points6: '0',
							cardCurrency: currency,
							nfts: [],
						},
						sortMin: 0n,
					})
				} catch {
					/* ignore */
				}
			}
		}
	}
	cardsStaged.sort((a, b) => {
		if (a.sortMin > b.sortMin) return -1
		if (a.sortMin < b.sortMin) return 1
		return 0
	})
	const cards = cardsStaged.map((s) => s.row)
	const cardsFiltered = cards.filter((c) => !DEPRECATED_INFRA_CARDS.has(c.cardAddress.toLowerCase()))
	const beamioTag = await fetchBeamioTagForEoa(eoaAddr)
	const infraForPos = resolveInfrastructureCardAddress(opts?.infrastructureCardAddress)
	let posTopFields: {
		posLastTopupAt?: string
		posLastTopupUsdcE6?: string
		posLastTopupPointsE6?: string
	} = {}
	try {
		const snap = await getMemberLastTopupOnCard(infraForPos, eoaAddr)
		if (snap) {
			posTopFields.posLastTopupAt = snap.lastTopupAt
			if (snap.usdcE6 != null) posTopFields.posLastTopupUsdcE6 = snap.usdcE6
			if (snap.pointsE6 != null) posTopFields.posLastTopupPointsE6 = snap.pointsE6
		}
	} catch {
		/* DB 失败不阻塞资产查询 */
	}
	return {
		ok: true,
		address: eoaAddr,
		aaAddress: aaAddr || undefined,
		...(beamioTag != null && beamioTag !== '' ? { beamioTag } : {}),
		usdcBalance,
		cards: cardsFiltered,
		...posTopFields,
	}
}

/** 基础设施卡（CashTrees）主会员 NFT：与链上 `tiers[i].minUsdc6` 最高档一致（`primaryMemberTokenId`）。 */
export const pickInfrastructureCashTreeTierTokenId = (
	cards: FetchUIDAssetsResult['cards'],
	infraAddress: string = BEAMIO_USER_CARD_ASSET_ADDRESS
): string | null => {
	const row =
		cards.find((c) => c.cardAddress.toLowerCase() === infraAddress.toLowerCase()) ??
		cards.find((c) => c.cardType === 'infrastructure')
	if (!row?.nfts?.length) return null
	const primary = row.primaryMemberTokenId?.trim()
	if (primary && Number(primary) > 0) return primary
	const withT = row.nfts.filter((n) => Number(n.tokenId) > 0)
	if (!withT.length) return null
	return withT.reduce((a, b) => (Number(b.tokenId) > Number(a.tokenId) ? b : a)).tokenId
}

const INFRA_OWNERSHIP_ABI = [
	'function getOwnership(address user) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
	'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
	'function tiers(uint256) view returns (uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds)',
] as const

/** 仅查基础设施卡在链上的主会员 tokenId（与 fetchUIDAssetsForEOA 一致），供无 cards 数组时的 NFC 入口 */
export async function pickInfrastructureCashTreeTierTokenIdFromChain(eoa: string): Promise<string | null> {
	const eoaAddr = ethers.getAddress(eoa)
	try {
		if (DEPRECATED_INFRA_CARDS.has(BEAMIO_USER_CARD_ASSET_ADDRESS.toLowerCase())) return null
		const aaAddr = await resolveBeamioAccountOf(eoaAddr)
		const card = new ethers.Contract(BEAMIO_USER_CARD_ASSET_ADDRESS, INFRA_OWNERSHIP_ABI, providerBase)
		const [, nfts] = (await (aaAddr ? card.getOwnership(aaAddr) : card.getOwnershipByEOA(eoaAddr))) as [
			bigint,
			{ tokenId: bigint; tierIndexOrMax: bigint; isExpired: boolean }[],
		]
		const pick = await pickBestMembershipNftByMinUsdc6(
			card,
			nfts.map((nft) => ({
				tokenId: nft.tokenId,
				tierIndexOrMax: nft.tierIndexOrMax,
				isExpired: nft.isExpired,
			}))
		)
		return pick?.tokenId ?? null
	} catch {
		return null
	}
}

/**
 * NFC 流程在校验 SUN、且 EOA 已有部署 AA 之后：若链上尚无 beamioTag，则排队登记。
 * 优先基础设施卡 NFT 对应的 CashTreeDamo_*；否则分配 verra_{N}（全局序号 + nfc_cards.verra_number）。
 */
export function scheduleEnsureNfcBeamioTagForEoa(
	eoa: string,
	uid: string,
	tagIdHex: string | null | undefined,
	cards: FetchUIDAssetsResult['cards'] | null | undefined
): void {
	void (async () => {
		try {
			const wallet = ethers.getAddress(String(eoa || '').trim())
			const uidS = String(uid || '').trim()
			if (!uidS) return
			const reg = beamio_ContractPool[0]?.constAccountRegistry
			if (!reg) return
			let accName = ''
			let exists = false
			try {
				const o = await reg.getAccount(wallet)
				exists = !!o?.exists
				accName = String(o?.accountName ?? '').trim()
			} catch {
				exists = false
			}
			if (exists && accName !== '') return

			let tierTokenId: string | null = null
			if (cards && cards.length > 0) {
				tierTokenId = pickInfrastructureCashTreeTierTokenId(cards)
			}
			if (!tierTokenId) {
				tierTokenId = await pickInfrastructureCashTreeTierTokenIdFromChain(wallet)
			}
			if (tierTokenId) {
				maybeEnqueueNfcCashTreeBeamioTag({ wallet, uid: uidS, tagIdHex, tierTokenId })
			} else {
				maybeEnqueueNfcVerraBeamioTag({ wallet, uid: uidS, tagIdHex })
			}
		} catch (e: unknown) {
			logger(Colors.yellow(`[scheduleEnsureNfcBeamioTagForEoa] ${(e as Error)?.message ?? e}`))
		}
	})()
}

/**
 * @deprecated Prefer scheduleEnsureNfcBeamioTagForEoa（含无 NFT 时的 verra_*）
 */
export const ensureNfcCashTreeBeamioTagAfterFetch = (
	eoa: string,
	uid: string,
	tagIdHex: string | null | undefined,
	cards: FetchUIDAssetsResult['cards']
): void => {
	scheduleEnsureNfcBeamioTagForEoa(eoa, uid, tagIdHex, cards)
}
