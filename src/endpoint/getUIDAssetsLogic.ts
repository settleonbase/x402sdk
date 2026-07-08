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
	maybeEnqueueNfcBeamioTag,
	maybeClearLegacyNfcBeamioProfileNames,
	listCouponIssuedNftSeriesForCardDescending,
	listRegisteredBeamioUserCardAddresses,
} from '../db'
import { BEAMIO_USER_CARD_ASSET_ADDRESS } from '../chainAddresses'
import { filterApiExcludedCardRows, isApiExcludedUserCard } from '../apiExcludedUserCards'
import { metadataMatchesClientCouponCategoryFilter } from '../couponMetadataCategory'
import { pickBestMembershipNftByMinUsdc6 } from './membershipTierPick'
import { resolveBeamioAaForEoaWithFallback } from './resolveBeamioAaViaUserCardFactory'
import { pickTierMetadataRowForChainSlot, type CardTierMetadataRow } from './tierMetadataRowResolve'
import { hasCoNETUserCardBytecode, providerForUserCardChain, resolveUserCardChain } from '../beamioUserCardChain'
import { REWARD_VOUCHER_TOKEN_ID } from '../socialExchangeMetadata'

/** Drop blacklist + Base-only legacy rows before asset-scan RPC (CoNET merchant cards only). */
async function filterBeamioUserCardAddressesForAssetScan(addresses: string[]): Promise<string[]> {
	const out: string[] = []
	const seen = new Set<string>()
	for (const raw of addresses) {
		if (isApiExcludedUserCard(raw)) continue
		let addr: string
		try {
			addr = ethers.getAddress(String(raw || '').trim())
		} catch {
			continue
		}
		const lower = addr.toLowerCase()
		if (seen.has(lower)) continue
		if (!(await hasCoNETUserCardBytecode(addr))) continue
		seen.add(lower)
		out.push(addr)
	}
	return out
}

/** 与 util.resolveBeamioBaseHttpRpcUrl 一致；此处不 import util，避免经 db 与 util/server 形成循环依赖 */
const BASE_RPC_URL =
	(typeof process !== 'undefined' && process.env?.BASE_RPC_URL?.trim()) || 'https://base-rpc.conet.network'
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CADD_BASE = '0x16F93eBC5320C89EfC8701577efe49d14A276a06'

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
	caddBalance?: string
	cards: Array<{
		cardAddress: string
		cardName: string
		cardType: string
		points: string
		points6: string
		/** ERC-1155 token #2 (ChargeRewardModule) balance, formatted with 6 decimals. */
		chargeRewardPoints: string
		/** Raw ERC-1155 token #2 balance in 6-decimal fixed units. */
		chargeRewardPoints6: string
		/** ERC-1155 token #13 (Social / dispatchEventReward13) integer balance (EOA+AA sum). */
		socialRewardPoints: string
		/** Same as socialRewardPoints — #13 uses integer units, not 6-decimal fixed point. */
		socialRewardPoints6: string
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
	 * 本次查询所用商户程序卡（`merchantInfraCard` / `infrastructureCardAddress`）上，该会员 EOA 在 DB 中的最近一笔 top-up。
	 * 与 `getMemberLastTopupOnCard` / `insertMemberTopupEvent` 一致；无记录时字段省略。
	 */
	posLastTopupAt?: string
	posLastTopupUsdcE6?: string
	posLastTopupPointsE6?: string
	merchantCouponBalances?: Array<{
		cardAddress: string
		couponId: string
		tokenId: string
		title: string
		balance: string
		requiresRedeemCode: boolean
	}>
	merchantClaimableCoupons?: Array<{
		cardAddress: string
		couponId: string
		tokenId: string
		title: string
		requiresRedeemCode: boolean
	}>
}

/** POS / 客户端可选：终端登记的商户程序 BeamioUserCard 地址（`merchantInfraCard`）。 */
export type FetchUIDAssetsOptions = {
	/** @deprecated 使用 merchantInfraCard；字段名保留兼容。须为终端登记的有效程序卡，无全局默认。 */
	infrastructureCardAddress?: string
	/** Extra BeamioUserCard addresses from trusted DB/indexer discovery (for NFC all-card inventory refresh). */
	extraCardAddresses?: string[]
	/** Scan DB-registered BeamioUserCard rows and return only cards with trusted on-chain assets for this user. */
	includeRegisteredBeamioCards?: boolean
	/**
	 * `merchantInfraOnly`：仅返回 `merchantInfraCard` 指定程序卡一行（含余额为 0），用于 POS「Check Balance」。
	 * `infrastructureOnly`（别名）：同上，须显式传卡地址。
	 * `all`（默认）：DB 已登记商户卡 + extra；**不**自动扫描 CCSA 或废弃全局卡。
	 */
	cardsScope?: 'all' | 'merchantInfraOnly' | 'infrastructureOnly'
	/** getWalletAssets 历史行为：即使 points/NFT 全空也返回该卡一行。 */
	includeZeroBalanceCards?: boolean
}

const resolveMerchantProgramCardAddress = (opt?: string): string | null => {
	if (!opt || typeof opt !== 'string') return null
	try {
		const a = ethers.getAddress(opt.trim())
		if (isApiExcludedUserCard(a)) return null
		return a
	} catch {
		return null
	}
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

function readCouponIdFromSeriesMetadata(meta: Record<string, unknown> | null | undefined): string {
	if (!meta || typeof meta !== 'object') return ''
	const rootId = meta.couponId
	if (typeof rootId === 'string' && rootId.trim()) return rootId.trim()
	const properties = meta.properties
	if (!properties || typeof properties !== 'object') return ''
	const beamioCoupon = (properties as Record<string, unknown>).beamioCoupon
	if (!beamioCoupon || typeof beamioCoupon !== 'object') return ''
	const nestedId = (beamioCoupon as Record<string, unknown>).couponId
	return typeof nestedId === 'string' && nestedId.trim() ? nestedId.trim() : ''
}

function readCouponRequiresRedeemCode(meta: Record<string, unknown> | null | undefined): boolean {
	if (!meta || typeof meta !== 'object') return false
	const root = meta as Record<string, unknown>
	const toBool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true'
	if (toBool(root.requiresRedeemCode) || toBool(root.redeemCodeRequired)) return true
	const properties = root.properties
	if (!properties || typeof properties !== 'object') return false
	const beamioCoupon = (properties as Record<string, unknown>).beamioCoupon
	if (!beamioCoupon || typeof beamioCoupon !== 'object') return false
	const nested = beamioCoupon as Record<string, unknown>
	return toBool(nested.requiresRedeemCode) || toBool(nested.redeemCodeRequired)
}

function readCouponTitleFromSeriesMetadata(meta: Record<string, unknown> | null | undefined, tokenId: string): string {
	if (!meta || typeof meta !== 'object') return `Coupon #${tokenId}`
	const rootTitle = typeof meta.title === 'string' ? meta.title.trim() : ''
	if (rootTitle) return rootTitle
	const rootName = typeof meta.name === 'string' ? meta.name.trim() : ''
	if (rootName) return rootName
	const properties = meta.properties
	if (properties && typeof properties === 'object') {
		const beamioCoupon = (properties as Record<string, unknown>).beamioCoupon
		if (beamioCoupon && typeof beamioCoupon === 'object') {
			const nestedTitle = typeof (beamioCoupon as Record<string, unknown>).title === 'string' ? String((beamioCoupon as Record<string, unknown>).title).trim() : ''
			if (nestedTitle) return nestedTitle
			const nestedName = typeof (beamioCoupon as Record<string, unknown>).name === 'string' ? String((beamioCoupon as Record<string, unknown>).name).trim() : ''
			if (nestedName) return nestedName
		}
	}
	return `Coupon #${tokenId}`
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
		'function balanceOf(address account, uint256 id) view returns (uint256)',
		'function currency() view returns (uint8)',
		'function tiers(uint256) view returns (uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds)',
	]
	const usdcAbi = ['function balanceOf(address) view returns (uint256)']
	const caddAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']
	const usdc = new ethers.Contract(USDC_BASE, usdcAbi, providerBase)
	const cadd = new ethers.Contract(CADD_BASE, caddAbi, providerBase)
	const [usdcEoaRaw, aaAddr] = await Promise.all([
		usdc.balanceOf(eoaAddr),
		resolveBeamioAccountOf(eoaAddr),
	])
	let usdcTotalRaw = usdcEoaRaw
	let caddTotalRaw = 0n
	let caddDecimals = 18
	if (aaAddr) {
		const [usdcAaRaw, caddAaRaw] = await Promise.all([
			usdc.balanceOf(aaAddr),
			cadd.balanceOf(aaAddr).catch(() => 0n),
		])
		usdcTotalRaw += usdcAaRaw
		caddTotalRaw += caddAaRaw
	}
	const [caddEoaRaw, caddDecimalsRaw] = await Promise.all([
		cadd.balanceOf(eoaAddr).catch(() => 0n),
		cadd.decimals().catch(() => 18),
	])
	caddTotalRaw += caddEoaRaw
	caddDecimals = Number(caddDecimalsRaw)
	const usdcBalance = ethers.formatUnits(usdcTotalRaw, 6)
	const caddBalance = ethers.formatUnits(caddTotalRaw, caddDecimals)
	const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
	const infraAddr = resolveMerchantProgramCardAddress(opts?.infrastructureCardAddress)
	const merchantInfraOnly = opts?.cardsScope === 'merchantInfraOnly'
	const merchantProgramOnly = opts?.cardsScope === 'infrastructureOnly'
	const singleProgramScope = merchantInfraOnly || merchantProgramOnly
	const programFallbackName = 'Merchant program card'
	const cardAddresses: { address: string; name: string; type: string }[] = []
	if (singleProgramScope) {
		if (!infraAddr) {
			logger(Colors.yellow('[fetchUIDAssetsForEOA] merchantInfraOnly/infrastructureOnly requires merchantInfraCard'))
		} else {
			cardAddresses.push({ address: infraAddr, name: programFallbackName, type: 'beamio-user-card' })
		}
	} else {
		/* cardsScope=all：仅 DB 已登记 + extraCardAddresses；无全局默认卡 */
	}
	const seenCardAddresses = new Set(cardAddresses.map((c) => c.address.toLowerCase()))
	if (!singleProgramScope && opts?.includeRegisteredBeamioCards !== false) {
		try {
			const registered = await filterBeamioUserCardAddressesForAssetScan(
				await listRegisteredBeamioUserCardAddresses()
			)
			for (const address of registered) {
				const lower = address.toLowerCase()
				if (seenCardAddresses.has(lower)) continue
				cardAddresses.push({ address, name: 'BeamioUserCard', type: 'beamio-user-card' })
				seenCardAddresses.add(lower)
			}
			logger(Colors.gray(`[fetchUIDAssetsForEOA] registered BeamioUserCard candidates=${registered.length} totalCandidates=${cardAddresses.length}`))
		} catch (e: any) {
			logger(Colors.yellow(`[fetchUIDAssetsForEOA] list registered BeamioUserCards failed: ${e?.message ?? e}`))
		}
	}
	if (!singleProgramScope) {
		for (const raw of opts?.extraCardAddresses ?? []) {
			try {
				if (isApiExcludedUserCard(raw)) continue
				const address = ethers.getAddress(raw)
				const lower = address.toLowerCase()
				if (seenCardAddresses.has(lower)) continue
				cardAddresses.push({ address, name: 'BeamioUserCard', type: 'beamio-user-card' })
				seenCardAddresses.add(lower)
			} catch {
				/* ignore invalid DB/cache address */
			}
		}
	}
	const cardsStaged: { row: FetchUIDAssetsResult['cards'][number]; sortMin: bigint }[] = []
	for (const { address: cardAddr, name: fallbackDisplayName, type: cardType } of cardAddresses) {
		if (isApiExcludedUserCard(cardAddr)) continue
		let cardName = fallbackDisplayName
		try {
			if (!(await hasCoNETUserCardBytecode(cardAddr))) continue
			let cardRow: { cardOwner: string; metadata: Record<string, unknown> | null } | null = null
			try {
				cardRow = await getCardByAddress(cardAddr)
			} catch {
				/* DB 失败仍用链上数据 */
			}
			cardName = displayNameFromCardMetadata(cardRow?.metadata ?? undefined) ?? fallbackDisplayName
			const cardProvider = providerForUserCardChain(await resolveUserCardChain(cardAddr))
			const card = new ethers.Contract(cardAddr, cardAbi, cardProvider)
			const tokenHolder = aaAddr || eoaAddr
			const [
				[pointsBalance, nfts],
				chargeRewardByHolder,
				chargeRewardByEoa,
				socialRewardByHolder,
				socialRewardByEoa,
				currencyNum,
			] = await Promise.all([
				aaAddr ? card.getOwnership(aaAddr) : card.getOwnershipByEOA(eoaAddr),
				card.balanceOf(tokenHolder, 2n).catch(() => 0n) as Promise<bigint>,
				tokenHolder.toLowerCase() === eoaAddr.toLowerCase()
					? Promise.resolve(0n)
					: (card.balanceOf(eoaAddr, 2n).catch(() => 0n) as Promise<bigint>),
				card.balanceOf(tokenHolder, REWARD_VOUCHER_TOKEN_ID).catch(() => 0n) as Promise<bigint>,
				tokenHolder.toLowerCase() === eoaAddr.toLowerCase()
					? Promise.resolve(0n)
					: (card.balanceOf(eoaAddr, REWARD_VOUCHER_TOKEN_ID).catch(() => 0n) as Promise<bigint>),
				card.currency(),
			])
			const chargeRewardPointsBalance = chargeRewardByHolder + chargeRewardByEoa
			const socialRewardPointsBalance = socialRewardByHolder + socialRewardByEoa
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
			const hasChargeRewardPoints = chargeRewardPointsBalance > 0n
			const hasSocialRewardPoints = socialRewardPointsBalance > 0n
			const hasNftGt0 = nftList.some((n: { tokenId: string }) => Number(n.tokenId) > 0)
			const includeRow =
				hasPoints ||
				hasChargeRewardPoints ||
				hasSocialRewardPoints ||
				hasNftGt0 ||
				merchantInfraOnly ||
				merchantProgramOnly ||
				(opts?.includeZeroBalanceCards === true && cardType !== 'beamio-user-card')
			if (includeRow) {
				const row: FetchUIDAssetsResult['cards'][number] = {
					cardAddress: cardAddr,
					cardName,
					cardType,
					points: ethers.formatUnits(pointsBalance, 6),
					points6: String(pointsBalance),
					chargeRewardPoints: ethers.formatUnits(chargeRewardPointsBalance, 6),
					chargeRewardPoints6: String(chargeRewardPointsBalance),
					socialRewardPoints: String(socialRewardPointsBalance),
					socialRewardPoints6: String(socialRewardPointsBalance),
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
			if (singleProgramScope && infraAddr && cardAddr.toLowerCase() === infraAddr.toLowerCase()) {
				try {
					const cardProvider = providerForUserCardChain(await resolveUserCardChain(cardAddr))
					const card = new ethers.Contract(cardAddr, cardAbi, cardProvider)
					const currencyNum = await card.currency()
					const currency = currencyMap[Number(currencyNum)] ?? 'CAD'
					cardsStaged.push({
						row: {
							cardAddress: cardAddr,
							cardName,
							cardType,
							points: '0',
							points6: '0',
							chargeRewardPoints: '0',
							chargeRewardPoints6: '0',
							socialRewardPoints: '0',
							socialRewardPoints6: '0',
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
	const cards = filterApiExcludedCardRows(cardsStaged.map((s) => s.row))
	const beamioTag = await fetchBeamioTagForEoa(eoaAddr)
	let posTopFields: {
		posLastTopupAt?: string
		posLastTopupUsdcE6?: string
		posLastTopupPointsE6?: string
	} = {}
	if (infraAddr) {
		try {
			const snap = await getMemberLastTopupOnCard(infraAddr, eoaAddr)
			if (snap) {
				posTopFields.posLastTopupAt = snap.lastTopupAt
				if (snap.usdcE6 != null) posTopFields.posLastTopupUsdcE6 = snap.usdcE6
				if (snap.pointsE6 != null) posTopFields.posLastTopupPointsE6 = snap.pointsE6
			}
		} catch {
			/* DB 失败不阻塞资产查询 */
		}
	}
	let merchantCouponBalances: FetchUIDAssetsResult['merchantCouponBalances'] | undefined
	let merchantClaimableCoupons: FetchUIDAssetsResult['merchantClaimableCoupons'] | undefined
	if (infraAddr) {
		try {
			const seriesRows = await listCouponIssuedNftSeriesForCardDescending(infraAddr, 80)
			if (seriesRows.length > 0) {
				const tokenHolder = aaAddr && ethers.isAddress(aaAddr) ? ethers.getAddress(aaAddr) : eoaAddr
			const couponProvider = providerForUserCardChain(await resolveUserCardChain(infraAddr))
			const couponRead = new ethers.Contract(
					infraAddr,
				[
					'function isIssuedNftValid(uint256 tokenId) view returns (bool)',
					'function issuedNftPriceInCurrency6(uint256 tokenId) view returns (uint256)',
					'function issuedNftUserSigClaimUsed(address userEOA, uint256 tokenId) view returns (bool)',
					'function balanceOf(address account, uint256 id) view returns (uint256)',
				],
				couponProvider
			)
			const seen = new Set<string>()
			const balances: NonNullable<FetchUIDAssetsResult['merchantCouponBalances']> = []
			const claimables: NonNullable<FetchUIDAssetsResult['merchantClaimableCoupons']> = []
			for (const row of seriesRows) {
				if (!metadataMatchesClientCouponCategoryFilter(row.metadata)) continue
				const tokenId = String(row.tokenId ?? '').trim()
				if (!tokenId || seen.has(tokenId)) continue
				seen.add(tokenId)
				let tokenIdN: bigint
				try {
					tokenIdN = BigInt(tokenId)
				} catch {
					continue
				}
				const couponId = readCouponIdFromSeriesMetadata(row.metadata ?? null)
				if (!couponId) continue
				const requiresRedeemCode = readCouponRequiresRedeemCode(row.metadata ?? null)
				const title = readCouponTitleFromSeriesMetadata(row.metadata ?? null, tokenId)
				const [isValid, priceInCurrency6, alreadyClaimed, balByHolder, balByEoa] = await Promise.all([
					couponRead.isIssuedNftValid(tokenIdN).catch(() => false) as Promise<boolean>,
					couponRead.issuedNftPriceInCurrency6(tokenIdN).catch(() => 0n) as Promise<bigint>,
					couponRead.issuedNftUserSigClaimUsed(eoaAddr, tokenIdN).catch(() => false) as Promise<boolean>,
					couponRead.balanceOf(tokenHolder, tokenIdN).catch(() => 0n) as Promise<bigint>,
					tokenHolder.toLowerCase() === eoaAddr.toLowerCase()
						? Promise.resolve(0n)
						: (couponRead.balanceOf(eoaAddr, tokenIdN).catch(() => 0n) as Promise<bigint>),
				])
				if (!isValid) continue
				const bal = balByHolder > balByEoa ? balByHolder : balByEoa
				if (bal > 0n) {
					balances.push({
						cardAddress: infraAddr,
						couponId,
						tokenId,
						title,
						balance: String(bal),
						requiresRedeemCode,
					})
				}
				if (!requiresRedeemCode && priceInCurrency6 === 0n && !alreadyClaimed && bal === 0n) {
					claimables.push({
						cardAddress: infraAddr,
						couponId,
						tokenId,
						title,
						requiresRedeemCode,
					})
				}
			}
			merchantCouponBalances = balances.length > 0 ? balances : undefined
			merchantClaimableCoupons = claimables.length > 0 ? claimables : undefined
		}
		} catch {
			/* ignore coupon enrichment failure */
		}
	}
	return {
		ok: true,
		address: eoaAddr,
		aaAddress: aaAddr || undefined,
		...(beamioTag != null && beamioTag !== '' ? { beamioTag } : {}),
		usdcBalance,
		caddBalance,
		cards,
		...posTopFields,
		...(merchantCouponBalances ? { merchantCouponBalances } : {}),
		...(merchantClaimableCoupons ? { merchantClaimableCoupons } : {}),
	}
}

/** 商户程序卡主会员 NFT：与链上 `tiers[i].minUsdc6` 最高档一致（`primaryMemberTokenId`）。 */
export const pickInfrastructureCashTreeTierTokenId = (
	cards: FetchUIDAssetsResult['cards'],
	programCardAddress?: string | null
): string | null => {
	const want = programCardAddress?.trim()
	const row = want && ethers.isAddress(want)
		? cards.find((c) => c.cardAddress.toLowerCase() === ethers.getAddress(want).toLowerCase())
		: cards.find((c) => c.cardType === 'beamio-user-card')
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
 * 优先基础设施卡 NFT 对应的 CashTreeDamo_*；否则分配 beamio_nfc_{N}（beamio_nfc_seq + 链上占用校验）。
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
			if (exists && accName !== '') {
				maybeClearLegacyNfcBeamioProfileNames(wallet)
				return
			}

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
				maybeEnqueueNfcBeamioTag({ wallet, uid: uidS, tagIdHex })
			}
		} catch (e: unknown) {
			logger(Colors.yellow(`[scheduleEnsureNfcBeamioTagForEoa] ${(e as Error)?.message ?? e}`))
		}
	})()
}

/**
 * @deprecated Prefer scheduleEnsureNfcBeamioTagForEoa（含无 NFT 时的 beamio_nfc_*）
 */
export const ensureNfcCashTreeBeamioTagAfterFetch = (
	eoa: string,
	uid: string,
	tagIdHex: string | null | undefined,
	cards: FetchUIDAssetsResult['cards']
): void => {
	scheduleEnsureNfcBeamioTagForEoa(eoa, uid, tagIdHex, cards)
}
