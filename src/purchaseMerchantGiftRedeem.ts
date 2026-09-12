/**
 * Discover Gifting (two pay rails — keep separate from Home P2P #0 Gift):
 *
 * 1) payWith=usdc (default): EIP-3009 CoNET-USDC → card.owner() → createGiftRedeemForPayer.
 *    May apply Top-up Promotion Multiplier on principal. Merchant owner pays 20 B-Unit protocol fee.
 *
 * 2) payWith=credit: burn buyer AA #0 face G + optional merchant fee F → createGiftRedeemWithCreditBurn.
 *    Stores split of G only (F never minted). No Top-up Promotion / no #13. Requires metadata giftCreditPurchase.enabled.
 *    Merchant owner pays 20 B-Unit protocol fee.
 *
 * Plaintext redeem code returned once; chain stores keccak256(utf8(code)).
 */
import type { Response } from 'express'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import {
	BEAMIO_INDEXER_DIAMOND,
	CONET_BUNIT_AIRDROP_ADDRESS,
	CONET_CARD_FACTORY,
	CONET_MAINNET_CHAIN_ID,
	CONET_USDC,
} from './chainAddresses'
import { providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'
import {
	calcTopupFixedBUnitFee,
	checkBusinessRelayTxSuccessful,
	getCardAaFactoryAddress,
	pickBUnitFeeConsumerPreferEoaThenAa,
	relayUserCardCallViaEntryPoint,
	relayUserCardBatchViaEntryPoint,
	resolveCardOwnerToEOA,
	syncStandaloneBunitServiceFeeToIndexer,
} from './MemberCard'
import { CHARGE_REWARD_V2_IFACE } from './userCumulativeStatRewardPool'
import { shiftSettleConet, unshiftSettleConet } from './settleContractPool'
import { getCardByAddress } from './db'
import {
	baseMembershipFeeE6,
	extractMetadataTiers,
	metadataTierMembershipFeeE6,
} from './membershipFeeMetadata'
import {
	normalizeTopupPromotionEntry,
	topupPromotionToBonusRules,
	type CreateCardBonusRuleNormalized,
} from './programTopupPromotion'
import { buildCouponRedeemAppDownloadUrl } from './endpoint/couponClaimShare'
import {
	computeGiftCreditBurnAmountE6,
	parseGiftCreditPurchaseConfig,
} from './giftCreditPurchaseMetadata'
import { resolveBeamioAaForEoaWithFallback } from './endpoint/resolveBeamioAaViaUserCardFactory'

const CONET_USDC_EIP3009_ABI = [
	'function name() view returns (string)',
	'function balanceOf(address) view returns (uint256)',
	'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
	'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
] as const

const CONET_USDC_TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, { name: string; type: string }[]> = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

const CARD_VIEW_ABI = [
	'function owner() view returns (address)',
	'function currency() view returns (uint8)',
	'function pointsUnitPriceInCurrencyE6() view returns (uint256)',
	'function getRedeemStatus(bytes32 hash) view returns (bool active, uint256 totalPoints6)',
	'function balanceOf(address account, uint256 id) view returns (uint256)',
] as const

const FACTORY_QUOTE_ABI = [
	'function quoteCurrencyAmountInUSDC6(uint8 currency, uint256 amount6) view returns (uint256)',
	'function defaultRedeemModule() view returns (address)',
] as const

const CARD_VERSION_ABI = ['function VERSION() view returns (uint256)'] as const

const CREATE_GIFT_REDEEM_IFACE = new ethers.Interface([
	'function createGiftRedeemForPayer(bytes32 hash, uint256 membershipFeeE6, uint256 topupCreditE6, uint64 validAfter, uint64 validBefore)',
	'function createGiftRedeemWithCreditBurn(bytes32 hash, uint256 membershipFeeE6, uint256 topupCreditE6, uint256 burnAmountE6, address payerAccount, uint64 validAfter, uint64 validBefore)',
	'function createGiftRedeemWithReward13Payment(bytes32 hash, uint256 membershipFeeE6, uint256 topupCreditE6, uint256 sameStoreBurn13, uint256 peerUsdcCredited6, address payerAccount, address userEOA, uint64 validAfter, uint64 validBefore, uint256 deadline, bytes32 nonce, bytes32 legsHash)',
])

const CREATE_GIFT_REDEEM_SEL =
	CREATE_GIFT_REDEEM_IFACE.getFunction('createGiftRedeemForPayer')?.selector ?? '0x00000000'
const CREATE_GIFT_CREDIT_SEL =
	CREATE_GIFT_REDEEM_IFACE.getFunction('createGiftRedeemWithCreditBurn')?.selector ?? '0x00000000'
const CREATE_GIFT_REWARD13_SEL =
	CREATE_GIFT_REDEEM_IFACE.getFunction('createGiftRedeemWithReward13Payment')?.selector ?? '0x00000000'

/** consumeFromUser kind — same family as NFC/USDC top-up (20 B-Unit). */
const BUNIT_KIND_TOPUP_FAMILY = 2n

export const GIFT_CREDIT_EIP712_TYPES: Record<string, { name: string; type: string }[]> = {
	GiftCreditPurchase: [
		{ name: 'card', type: 'address' },
		{ name: 'from', type: 'address' },
		{ name: 'payerAccount', type: 'address' },
		{ name: 'membershipFeeE6', type: 'uint256' },
		{ name: 'topupCreditE6', type: 'uint256' },
		{ name: 'burnAmountE6', type: 'uint256' },
		{ name: 'redeemHash', type: 'bytes32' },
		{ name: 'validAfter', type: 'uint64' },
		{ name: 'validBefore', type: 'uint64' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export const GIFT_REWARD13_EIP712_TYPES: Record<string, { name: string; type: string }[]> = {
	GiftReward13Payment: [
		{ name: 'card', type: 'address' },
		{ name: 'from', type: 'address' },
		{ name: 'payerAccount', type: 'address' },
		{ name: 'membershipFeeE6', type: 'uint256' },
		{ name: 'topupCreditE6', type: 'uint256' },
		{ name: 'sameStoreBurn13', type: 'uint256' },
		{ name: 'peerLegsHash', type: 'bytes32' },
		{ name: 'redeemHash', type: 'bytes32' },
		{ name: 'validAfter', type: 'uint64' },
		{ name: 'validBefore', type: 'uint64' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export type MerchantGiftPayWith = 'usdc' | 'credit' | 'reward13'

export type MerchantGiftReward13PeerLeg = {
	cardAddress: string
	burn13: string
	usdcOut6: string
}

export type PurchaseMerchantGiftRedeemBody = {
	cardAddress: string
	from: string
	userSignature: string
	nonce: string
	validAfter: string
	validBefore: string
	/** Client-only secret. Stripe fulfillment uses redeemHash instead. */
	redeemCode?: string
	redeemHash?: string
	/** Default usdc. credit = burn #0 G+F from buyer AA. */
	payWith?: MerchantGiftPayWith | string
	/** Required for usdc rail. */
	usdcAmount?: string
	membershipFeeE6?: string
	topupPrincipalE6?: string
	redeemValidAfter?: string
	redeemValidBefore?: string
	/** Optional client hint for credit rail AA; Cluster resolves from EOA. */
	payerAccount?: string
	sameStoreBurn13?: string
	peerLegs?: MerchantGiftReward13PeerLeg[]
	peerLegsHash?: string
	cashUsdcAmount?: string
	cashSignature?: string
	cashNonce?: string
	cashValidAfter?: string
	cashValidBefore?: string
}

export type PurchaseMerchantGiftRedeemPreChecked = {
	payWith: MerchantGiftPayWith
	cardAddress: string
	from: string
	usdcAmount: string
	userSignature: string
	nonce: string
	validAfter: string
	validBefore: string
	redeemCode: string
	membershipFeeE6: string
	topupPrincipalE6: string
	topupCreditE6: string
	redeemHash: string
	cardOwner: string
	cardCurrency: number
	quotedUsdc6: string
	redeemValidAfter: string
	redeemValidBefore: string
	/** Credit rail only */
	payerAccount: string
	burnAmountE6: string
	merchantFeeE6: string
	cardOwnerEOA: string
	bunitFeeConsumer: string
	bunitFeeUnits6: string
	sameStoreBurn13?: string
	peerLegs?: MerchantGiftReward13PeerLeg[]
	peerLegsHash?: string
	cashUsdcAmount?: string
	cashSignature?: string
	cashNonce?: string
	cashValidAfter?: string
	cashValidBefore?: string
}

type PoolItem = PurchaseMerchantGiftRedeemPreChecked & {
	res?: Response
	onSuccess?: (createTxHash: string) => Promise<void> | void
	onFailure?: (error: string) => Promise<void> | void
}

export const purchaseMerchantGiftRedeemPool: PoolItem[] = []

let purchaseGiftInFlight = false

function padNonceBytes32(nonce: string): `0x${string}` {
	if (typeof nonce === 'string' && nonce.startsWith('0x')) {
		return ethers.zeroPadValue(nonce, 32) as `0x${string}`
	}
	return ethers.zeroPadValue(ethers.toBeHex(BigInt(nonce)), 32) as `0x${string}`
}

function redeemHashFromCode(code: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(code.trim()))
}

function hashReward13PeerLegs(legs: MerchantGiftReward13PeerLeg[]): string {
	if (legs.length === 0) return ethers.ZeroHash
	const sorted = [...legs]
		.map((leg) => ({
			cardAddress: ethers.getAddress(leg.cardAddress),
			burn13: BigInt(leg.burn13),
			usdcOut6: BigInt(leg.usdcOut6),
		}))
		.sort((a, b) => a.cardAddress.toLowerCase().localeCompare(b.cardAddress.toLowerCase()))
	return ethers.keccak256(
		ethers.concat(
			sorted.map((leg) =>
				ethers.solidityPacked(['address', 'uint256', 'uint256'], [
					leg.cardAddress,
					leg.burn13,
					leg.usdcOut6,
				]),
			),
		),
	)
}

function humanFromE6(e6: bigint): number {
	return Number(e6) / 1e6
}

function e6FromHuman(n: number): bigint {
	return BigInt(Math.round(n * 1e6))
}

export function normalizePayWith(raw: unknown): MerchantGiftPayWith {
	const s = String(raw ?? 'usdc').toLowerCase().trim()
	if (s === 'reward13' || s === 'pt' || s === 'reward-pt') return 'reward13'
	return s === 'credit' || s === 'points' || s === 'program' ? 'credit' : 'usdc'
}

/** Multiplier / top-up promotion bonus on principal — USDC rail only. */
function computeTopupBonusE6(
	metadata: Record<string, unknown> | null,
	principalE6: bigint,
): bigint {
	if (principalE6 <= 0n || !metadata) return 0n
	const amount = humanFromE6(principalE6)
	const share =
		metadata.shareTokenMetadata && typeof metadata.shareTokenMetadata === 'object'
			? (metadata.shareTokenMetadata as Record<string, unknown>)
			: metadata
	const rawPromo = share.topupPromotion ?? metadata.topupPromotion
	if (rawPromo && typeof rawPromo === 'object') {
		const norm = normalizeTopupPromotionEntry(rawPromo, 'topupPromotion')
		if (norm.success && norm.promotion.enabled) {
			const promo = norm.promotion
			if (promo.rewardType === 'percent') {
				if (amount < promo.minimumTopupAmount) return 0n
				const bonus = Math.round((amount * promo.rewardValue) / 100 * 100) / 100
				return bonus > 0 ? e6FromHuman(bonus) : 0n
			}
			const rules = topupPromotionToBonusRules(promo)
			let picked: CreateCardBonusRuleNormalized | null = null
			for (const rule of rules) {
				if (amount >= rule.paymentAmount) picked = rule
			}
			if (!picked) return 0n
			if (picked.bonusProportional && picked.paymentAmount > 0) {
				const bonus = Math.round((amount * picked.bonusValue) / picked.paymentAmount * 100) / 100
				return bonus > 0 ? e6FromHuman(bonus) : 0n
			}
			return e6FromHuman(picked.bonusValue)
		}
	}
	const legacy = share.bonusRules ?? metadata.bonusRules
	if (Array.isArray(legacy) && legacy.length > 0) {
		let picked: { paymentAmount: number; bonusValue: number; bonusProportional?: boolean } | null = null
		for (const row of legacy) {
			if (!row || typeof row !== 'object') continue
			const o = row as Record<string, unknown>
			const pay = Number(o.paymentAmount ?? o.payment_amount ?? 0)
			const bonus = Number(o.bonusValue ?? o.bonus_value ?? 0)
			if (!(pay > 0) || !(bonus > 0) || amount < pay) continue
			if (!picked || pay > picked.paymentAmount) {
				picked = {
					paymentAmount: pay,
					bonusValue: bonus,
					bonusProportional: Boolean(o.bonusProportional ?? o.bonus_proportional),
				}
			}
		}
		if (!picked) return 0n
		if (picked.bonusProportional && picked.paymentAmount > 0) {
			const bonus = Math.round((amount * picked.bonusValue) / picked.paymentAmount * 100) / 100
			return bonus > 0 ? e6FromHuman(bonus) : 0n
		}
		return e6FromHuman(picked.bonusValue)
	}
	return 0n
}

async function bytecodeHasSelector(provider: ethers.Provider, address: string, selector: string): Promise<boolean> {
	if (!selector || selector === '0x00000000') return false
	const code = await provider.getCode(address)
	if (!code || code === '0x') return false
	return code.toLowerCase().includes(selector.slice(2).toLowerCase())
}

async function precheckMerchantGiftBUnitFee(
	cardAddress: string,
	provider: ethers.Provider,
): Promise<
	| { success: true; cardOwnerEOA: string; bunitFeeConsumer: string; bunitFeeUnits6: bigint }
	| { success: false; error: string }
> {
	const { feeBUnits6 } = calcTopupFixedBUnitFee()
	const card = new ethers.Contract(cardAddress, ['function owner() view returns (address)'], provider)
	const rawOwner = (await card.owner()) as string
	const resolveResult = await resolveCardOwnerToEOA(provider, rawOwner)
	if (!resolveResult.success) {
		return { success: false, error: resolveResult.error ?? 'Cannot resolve card owner to EOA for B-Unit fee' }
	}
	const aaFac = await getCardAaFactoryAddress(cardAddress)
	const picked = await pickBUnitFeeConsumerPreferEoaThenAa(resolveResult.cardOwner, feeBUnits6, {
		aaFactoryAddress: aaFac,
	})
	if (!picked.ok) {
		return {
			success: false,
			error: `Insufficient B-Units for gift purchase protocol fee (20 B-Units): ${picked.error}`,
		}
	}
	return {
		success: true,
		cardOwnerEOA: resolveResult.cardOwner,
		bunitFeeConsumer: picked.consumer,
		bunitFeeUnits6: feeBUnits6,
	}
}

export async function purchaseMerchantGiftRedeemPreCheck(
	body: PurchaseMerchantGiftRedeemBody,
): Promise<
	{ success: true; preChecked: PurchaseMerchantGiftRedeemPreChecked } | { success: false; error: string }
> {
	try {
		if (!body?.cardAddress || !ethers.isAddress(body.cardAddress)) {
			return { success: false, error: 'Invalid cardAddress' }
		}
		if (!body?.from || !ethers.isAddress(body.from)) {
			return { success: false, error: 'Invalid from' }
		}
		if (!body?.userSignature || typeof body.userSignature !== 'string') {
			return { success: false, error: 'Missing userSignature' }
		}
		const suppliedRedeemCode = typeof body.redeemCode === 'string' ? body.redeemCode.trim() : ''
		const suppliedRedeemHash = typeof body.redeemHash === 'string' ? body.redeemHash.trim() : ''
		if (!suppliedRedeemCode && !ethers.isHexString(suppliedRedeemHash, 32)) {
			return { success: false, error: 'redeemCode or redeemHash is required' }
		}
		if (suppliedRedeemCode && (suppliedRedeemCode.length < 8 || suppliedRedeemCode.length > 128)) {
			return { success: false, error: 'redeemCode must be between 8 and 128 characters' }
		}

		const payWith = normalizePayWith(body.payWith)
		const cardAddress = ethers.getAddress(body.cardAddress)
		const from = ethers.getAddress(body.from)
		const chain = await resolveUserCardChain(cardAddress)
		if (chain !== 'conet') {
			return { success: false, error: 'Merchant gift redeem is CoNET-only' }
		}
		const provider = providerForUserCardChain('conet')
		const factoryRead = new ethers.Contract(CONET_CARD_FACTORY, FACTORY_QUOTE_ABI, provider)
		const redeemModuleAddr = (await factoryRead.defaultRedeemModule()) as string
		const needSel =
			payWith === 'credit'
				? CREATE_GIFT_CREDIT_SEL
				: payWith === 'reward13'
					? CREATE_GIFT_REWARD13_SEL
					: CREATE_GIFT_REDEEM_SEL
		const hasGiftModule = await bytecodeHasSelector(provider, redeemModuleAddr, needSel)
		if (!hasGiftModule) {
			return {
				success: false,
				error:
					payWith === 'credit'
						? 'Credit Gift RedeemModule is not bound on Factory yet'
						: 'Discover Gifting RedeemModule is not bound on Factory yet',
			}
		}
		try {
			const ver = (await new ethers.Contract(cardAddress, CARD_VERSION_ABI, provider).VERSION()) as bigint
			if (ver < 21n) {
				return {
					success: false,
					error: 'This program card does not support Discover Gifting yet (UserCard VERSION < 21)',
				}
			}
		} catch {
			return {
				success: false,
				error: 'Unable to read program card VERSION for Discover Gifting',
			}
		}

		const card = new ethers.Contract(cardAddress, CARD_VIEW_ABI, provider)
		const [ownerRaw, currencyRaw, priceE6] = await Promise.all([
			card.owner() as Promise<string>,
			card.currency() as Promise<bigint>,
			card.pointsUnitPriceInCurrencyE6() as Promise<bigint>,
		])
		const cardOwner = ethers.getAddress(ownerRaw)
		if (cardOwner === ethers.ZeroAddress) {
			return { success: false, error: 'Card owner not found' }
		}
		const cardCurrency = Number(currencyRaw)
		if (!(priceE6 > 0n)) {
			return { success: false, error: 'Invalid points unit price' }
		}

		const dbRow = await getCardByAddress(cardAddress)
		const metadata = dbRow?.metadata ?? null
		const tiers = extractMetadataTiers(metadata)
		const metaBaseFee = BigInt(baseMembershipFeeE6(metadata))
		const legacyBase =
			metaBaseFee > 0n
				? metaBaseFee
				: tiers.length > 0
					? BigInt(metadataTierMembershipFeeE6(tiers[0]))
					: 0n
		const isFeeCard = legacyBase > 0n
		const membershipFeeE6 = isFeeCard ? legacyBase : 0n

		let topupPrincipalE6 = 0n
		try {
			topupPrincipalE6 = BigInt(body.topupPrincipalE6 ?? '0')
		} catch {
			return { success: false, error: 'Invalid topupPrincipalE6' }
		}
		if (topupPrincipalE6 < 0n) {
			return { success: false, error: 'topupPrincipalE6 must be >= 0' }
		}
		if (!isFeeCard && topupPrincipalE6 <= 0n) {
			return { success: false, error: 'topupPrincipalE6 required for non-membership gift cards' }
		}
		if (isFeeCard && membershipFeeE6 + topupPrincipalE6 <= 0n) {
			return { success: false, error: 'Gift amount must cover at least the base membership fee' }
		}

		const now = BigInt(Math.floor(Date.now() / 1000))
		const redeemCode = suppliedRedeemCode
		const redeemHash = suppliedRedeemCode
			? redeemHashFromCode(suppliedRedeemCode)
			: ethers.hexlify(suppliedRedeemHash)
		const [active] = (await card.getRedeemStatus(redeemHash)) as [boolean, bigint]
		if (active) {
			return { success: false, error: 'redeemCode already exists on-chain' }
		}

		const redeemValidAfter = BigInt(body.redeemValidAfter ?? '0')
		const redeemValidBefore = BigInt(
			body.redeemValidBefore ?? String(Math.floor(Date.now() / 1000) + 365 * 24 * 3600),
		)
		if (redeemValidBefore <= now) {
			return { success: false, error: 'redeemValidBefore must be in the future' }
		}

		const bunitPre = await precheckMerchantGiftBUnitFee(cardAddress, provider)
		if (!bunitPre.success) return bunitPre

		if (payWith === 'reward13') {
			const payerAccount =
				(await resolveBeamioAaForEoaWithFallback(provider, from)) ??
				(body.payerAccount && ethers.isAddress(body.payerAccount)
					? ethers.getAddress(body.payerAccount)
					: null)
			if (!payerAccount || payerAccount === ethers.ZeroAddress) {
				return { success: false, error: 'Buyer Smart Wallet (AA) required for Reward PT Gift' }
			}
			const sameStoreBurn13 = BigInt(body.sameStoreBurn13 ?? '0')
			const peerLegs = Array.isArray(body.peerLegs) ? body.peerLegs : []
			if (sameStoreBurn13 <= 0n && peerLegs.length === 0) {
				return { success: false, error: 'Reward PT payment requires at least one #13 leg' }
			}
			const targetBal = (await card.balanceOf(payerAccount, 13n)) as bigint
			if (targetBal < sameStoreBurn13) {
				return { success: false, error: 'Insufficient target merchant #13 Reward PT balance' }
			}
			let peerUsdcCredited6 = 0n
			for (const raw of peerLegs) {
				if (!raw || !ethers.isAddress(raw.cardAddress) || ethers.getAddress(raw.cardAddress) === cardAddress) {
					return { success: false, error: 'Invalid Reward PT peer card' }
				}
				const peerCardAddress = ethers.getAddress(raw.cardAddress)
				const burn13 = BigInt(raw.burn13)
				const usdcOut6 = BigInt(raw.usdcOut6)
				if (burn13 <= 0n || usdcOut6 <= 0n) {
					return { success: false, error: 'Reward PT peer legs must be positive' }
				}
				const peerCard = new ethers.Contract(peerCardAddress, CARD_VIEW_ABI, provider)
				const [ratio, quoted, balance] = await Promise.all([
					peerCard.convertReward13ToUsdcRatioE6() as Promise<bigint>,
					peerCard.quoteUsdcWithdrawForFiat6(burn13) as Promise<bigint>,
					peerCard.balanceOf(payerAccount, 13n) as Promise<bigint>,
				])
				if (ratio <= 0n || quoted !== usdcOut6 || balance < burn13) {
					return { success: false, error: 'Reward PT peer quote or balance changed; retry' }
				}
				peerUsdcCredited6 += usdcOut6
			}
			const peerLegsHash = hashReward13PeerLegs(peerLegs)
			const cashUsdcAmount = BigInt(body.cashUsdcAmount ?? '0')
			const cashSignature = String(body.cashSignature ?? '')
			const cashNonce = cashUsdcAmount > 0n ? padNonceBytes32(String(body.cashNonce ?? '')) : ethers.ZeroHash
			const cashValidAfter = BigInt(body.cashValidAfter ?? '0')
			const cashValidBefore = BigInt(body.cashValidBefore ?? '0')
			if (cashUsdcAmount > 0n) {
				if (!cashSignature || cashValidBefore <= now || cashValidAfter > now + 60n) {
					return { success: false, error: 'Reward PT cash authorization window invalid' }
				}
				const token = new ethers.Contract(CONET_USDC, CONET_USDC_EIP3009_ABI, provider)
				const tokenName = String((await token.name()) || 'CoNET USD Coin')
				const recoveredCash = ethers.verifyTypedData(
					{ name: tokenName, version: '1', chainId: CONET_MAINNET_CHAIN_ID, verifyingContract: ethers.getAddress(CONET_USDC) },
					CONET_USDC_TRANSFER_WITH_AUTHORIZATION_TYPES,
					{ from, to: cardOwner, value: cashUsdcAmount, validAfter: cashValidAfter, validBefore: cashValidBefore, nonce: cashNonce },
					cashSignature,
				)
				if (recoveredCash.toLowerCase() !== from.toLowerCase()) return { success: false, error: 'Reward PT cash signer mismatch' }
				if ((await token.authorizationState(from, cashNonce)) as boolean) return { success: false, error: 'Reward PT cash nonce already used' }
				if ((await token.balanceOf(from)) as bigint < cashUsdcAmount) return { success: false, error: 'Insufficient USDC for Reward PT remainder' }
			}
			const validBefore = BigInt(body.validBefore || '0')
			const validAfter = BigInt(body.validAfter || '0')
			if (validBefore <= now || validAfter > now + 60n) {
				return { success: false, error: 'Reward PT authorization window invalid' }
			}
			if (!ethers.isHexString(body.nonce, 32)) return { success: false, error: 'Invalid Reward PT nonce' }
			const nonceBytes32 = padNonceBytes32(body.nonce)
			const domain = {
				name: 'BeamioMerchantGiftReward13',
				version: '1',
				chainId: CONET_MAINNET_CHAIN_ID,
				verifyingContract: cardAddress,
			}
			const recovered = ethers.verifyTypedData(domain, GIFT_REWARD13_EIP712_TYPES, {
				card: cardAddress,
				from,
				payerAccount,
				membershipFeeE6,
				topupCreditE6: topupPrincipalE6,
				sameStoreBurn13,
				peerLegsHash,
				redeemHash,
				validAfter,
				validBefore,
				nonce: nonceBytes32,
			}, body.userSignature)
			if (recovered.toLowerCase() !== from.toLowerCase()) {
				return { success: false, error: 'Reward PT signer mismatch' }
			}
			if (!(await bytecodeHasSelector(provider, redeemModuleAddr, CREATE_GIFT_REWARD13_SEL))) {
				return { success: false, error: 'Reward PT Gift relay is not deployed on Factory yet' }
			}
			return {
				success: true,
				preChecked: {
					payWith: 'reward13',
					cardAddress,
					from,
					usdcAmount: '0',
					userSignature: body.userSignature,
					nonce: nonceBytes32,
					validAfter: validAfter.toString(),
					validBefore: validBefore.toString(),
					redeemCode,
					membershipFeeE6: membershipFeeE6.toString(),
					topupPrincipalE6: topupPrincipalE6.toString(),
					topupCreditE6: topupPrincipalE6.toString(),
					redeemHash,
					cardOwner,
					cardCurrency,
					quotedUsdc6: peerUsdcCredited6.toString(),
					redeemValidAfter: redeemValidAfter.toString(),
					redeemValidBefore: redeemValidBefore.toString(),
					payerAccount,
					burnAmountE6: '0',
					merchantFeeE6: '0',
					cardOwnerEOA: bunitPre.cardOwnerEOA,
					bunitFeeConsumer: bunitPre.bunitFeeConsumer,
					bunitFeeUnits6: bunitPre.bunitFeeUnits6.toString(),
					sameStoreBurn13: sameStoreBurn13.toString(),
					peerLegs,
					peerLegsHash,
					cashUsdcAmount: cashUsdcAmount.toString(),
					cashSignature,
					cashNonce: cashNonce === ethers.ZeroHash ? '' : cashNonce,
					cashValidAfter: cashValidAfter.toString(),
					cashValidBefore: cashValidBefore.toString(),
				},
			}
		}

		if (payWith === 'credit') {
			const giftCfg = parseGiftCreditPurchaseConfig(metadata as Record<string, unknown> | null)
			if (!giftCfg.enabled) {
				return { success: false, error: 'Credit Gift is not enabled for this program card' }
			}
			// Credit rail: G = membership + principal; NO Top-up Promotion bonus
			const topupCreditE6 = topupPrincipalE6
			const giftFaceE6 = membershipFeeE6 + topupCreditE6
			if (giftFaceE6 <= 0n) {
				return { success: false, error: 'Gift credit total must be > 0' }
			}
			const { merchantFeeE6, burnAmountE6 } = computeGiftCreditBurnAmountE6(giftCfg, giftFaceE6)

			const payerAccount =
				(await resolveBeamioAaForEoaWithFallback(provider, from)) ??
				(body.payerAccount && ethers.isAddress(body.payerAccount)
					? ethers.getAddress(body.payerAccount)
					: null)
			if (!payerAccount || payerAccount === ethers.ZeroAddress) {
				return { success: false, error: 'Buyer Smart Wallet (AA) required for Credit Gift' }
			}
			const aaBal = (await card.balanceOf(payerAccount, 0n)) as bigint
			if (aaBal < burnAmountE6) {
				return {
					success: false,
					error: `Insufficient program points (#0) on Smart Wallet (need ${burnAmountE6}, have ${aaBal})`,
				}
			}

			const validBefore = BigInt(body.validBefore || '0')
			const validAfter = BigInt(body.validAfter || '0')
			if (validBefore <= now) {
				return { success: false, error: 'Credit Gift authorization expired (validBefore)' }
			}
			if (validAfter > now + 60n) {
				return { success: false, error: 'Credit Gift authorization not yet valid (validAfter)' }
			}
			const nonce = body.nonce
			if (typeof nonce !== 'string' || !nonce.startsWith('0x') || nonce.length !== 66) {
				return { success: false, error: 'Invalid Credit Gift EIP-712 nonce (bytes32)' }
			}
			const nonceBytes32 = padNonceBytes32(nonce)
			const domain = {
				name: 'BeamioMerchantGiftCredit',
				version: '1',
				chainId: CONET_MAINNET_CHAIN_ID,
				verifyingContract: cardAddress,
			}
			let recovered: string
			try {
				recovered = ethers.verifyTypedData(
					domain,
					GIFT_CREDIT_EIP712_TYPES,
					{
						card: cardAddress,
						from,
						payerAccount,
						membershipFeeE6,
						topupCreditE6,
						burnAmountE6,
						redeemHash,
						validAfter,
						validBefore,
						nonce: nonceBytes32,
					},
					body.userSignature,
				)
			} catch (sigErr: unknown) {
				const msg = sigErr instanceof Error ? sigErr.message : String(sigErr)
				return { success: false, error: `Invalid Credit Gift EIP-712 signature: ${msg}` }
			}
			if (recovered.toLowerCase() !== from.toLowerCase()) {
				return { success: false, error: `Credit Gift signer mismatch: recovered=${recovered}` }
			}

			return {
				success: true,
				preChecked: {
					payWith: 'credit',
					cardAddress,
					from,
					usdcAmount: '0',
					userSignature: body.userSignature,
					nonce: nonceBytes32,
					validAfter: validAfter.toString(),
					validBefore: validBefore.toString(),
					redeemCode,
					membershipFeeE6: membershipFeeE6.toString(),
					topupPrincipalE6: topupPrincipalE6.toString(),
					topupCreditE6: topupCreditE6.toString(),
					redeemHash,
					cardOwner,
					cardCurrency,
					quotedUsdc6: '0',
					redeemValidAfter: redeemValidAfter.toString(),
					redeemValidBefore: redeemValidBefore.toString(),
					payerAccount,
					burnAmountE6: burnAmountE6.toString(),
					merchantFeeE6: merchantFeeE6.toString(),
					cardOwnerEOA: bunitPre.cardOwnerEOA,
					bunitFeeConsumer: bunitPre.bunitFeeConsumer,
					bunitFeeUnits6: bunitPre.bunitFeeUnits6.toString(),
				},
			}
		}

		// —— USDC rail ——
		const usdcAmount = BigInt(body.usdcAmount ?? '0')
		if (usdcAmount <= 0n) {
			return { success: false, error: 'usdcAmount must be > 0' }
		}
		const validBefore = BigInt(body.validBefore || '0')
		const validAfter = BigInt(body.validAfter || '0')
		if (validBefore <= now) {
			return { success: false, error: 'USDC authorization expired (validBefore)' }
		}
		if (validAfter > now + 60n) {
			return { success: false, error: 'USDC authorization not yet valid (validAfter)' }
		}
		const nonce = body.nonce
		if (typeof nonce !== 'string' || !nonce.startsWith('0x') || (nonce.length !== 66 && nonce.length < 3)) {
			return { success: false, error: 'Invalid EIP-3009 nonce' }
		}

		const totalFiat6 = membershipFeeE6 + topupPrincipalE6
		let quotedUsdc6: bigint
		if (cardCurrency === 4) {
			quotedUsdc6 = priceE6 === 1_000_000n ? totalFiat6 : (totalFiat6 * priceE6) / 1_000_000n
		} else {
			quotedUsdc6 = (await factoryRead.quoteCurrencyAmountInUSDC6(cardCurrency, totalFiat6)) as bigint
		}
		if (quotedUsdc6 <= 0n) {
			return { success: false, error: 'Unable to quote gift amount in USDC' }
		}
		const drift = usdcAmount > quotedUsdc6 ? usdcAmount - quotedUsdc6 : quotedUsdc6 - usdcAmount
		if (drift * 100n > quotedUsdc6 * 2n && drift > 10_000n) {
			return {
				success: false,
				error: `usdcAmount diverges from quote (paid=${usdcAmount} quoted=${quotedUsdc6})`,
			}
		}

		const bonusE6 = computeTopupBonusE6(metadata as Record<string, unknown> | null, topupPrincipalE6)
		const topupCreditE6 = topupPrincipalE6 + bonusE6
		if (membershipFeeE6 + topupCreditE6 <= 0n) {
			return { success: false, error: 'Gift credit total must be > 0' }
		}

		const nonceBytes32 = padNonceBytes32(nonce)
		const conetUsdc = new ethers.Contract(CONET_USDC, CONET_USDC_EIP3009_ABI, provider)
		let tokenName = 'CoNET USD Coin'
		try {
			const n = (await conetUsdc.name()) as string
			if (typeof n === 'string' && n.trim()) tokenName = n.trim()
		} catch {
			/* fallback */
		}
		const eip3009Domain = {
			name: tokenName,
			version: '1',
			chainId: CONET_MAINNET_CHAIN_ID,
			verifyingContract: ethers.getAddress(CONET_USDC),
		}
		let recovered: string
		try {
			recovered = ethers.verifyTypedData(
				eip3009Domain,
				CONET_USDC_TRANSFER_WITH_AUTHORIZATION_TYPES,
				{
					from,
					to: cardOwner,
					value: usdcAmount,
					validAfter,
					validBefore,
					nonce: nonceBytes32,
				},
				body.userSignature,
			)
		} catch (sigErr: unknown) {
			const msg = sigErr instanceof Error ? sigErr.message : String(sigErr)
			return { success: false, error: `Invalid CoNET-USDC EIP-3009 signature: ${msg}` }
		}
		if (recovered.toLowerCase() !== from.toLowerCase()) {
			return { success: false, error: `EIP-3009 signer mismatch: recovered=${recovered}` }
		}
		const alreadyUsed = (await conetUsdc.authorizationState(from, nonceBytes32)) as boolean
		if (alreadyUsed) {
			return { success: false, error: 'CoNET-USDC authorization nonce already used' }
		}
		const bal = (await conetUsdc.balanceOf(from)) as bigint
		if (bal < usdcAmount) {
			return { success: false, error: 'Insufficient CoNET-USDC balance' }
		}

		return {
			success: true,
			preChecked: {
				payWith: 'usdc',
				cardAddress,
				from,
				usdcAmount: usdcAmount.toString(),
				userSignature: body.userSignature,
				nonce: nonceBytes32,
				validAfter: validAfter.toString(),
				validBefore: validBefore.toString(),
				redeemCode,
				membershipFeeE6: membershipFeeE6.toString(),
				topupPrincipalE6: topupPrincipalE6.toString(),
				topupCreditE6: topupCreditE6.toString(),
				redeemHash,
				cardOwner,
				cardCurrency,
				quotedUsdc6: quotedUsdc6.toString(),
				redeemValidAfter: redeemValidAfter.toString(),
				redeemValidBefore: redeemValidBefore.toString(),
				payerAccount: ethers.ZeroAddress,
				burnAmountE6: '0',
				merchantFeeE6: '0',
				cardOwnerEOA: bunitPre.cardOwnerEOA,
				bunitFeeConsumer: bunitPre.bunitFeeConsumer,
				bunitFeeUnits6: bunitPre.bunitFeeUnits6.toString(),
			},
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		return { success: false, error: msg }
	}
}

export function kickPurchaseMerchantGiftRedeemProcess(): void {
	if (purchaseGiftInFlight) return
	void purchaseMerchantGiftRedeemProcess()
}

async function consumeMerchantGiftPurchaseBunitInBackground(args: {
	cardAddress: string
	createTxHash: string
	cardOwnerEOA: string
	bunitFeeConsumer: string
	bunitFeeUnits6: bigint
	payWith: MerchantGiftPayWith
}): Promise<void> {
	if (args.bunitFeeUnits6 <= 0n) return
	const SC = shiftSettleConet()
	if (!SC) {
		logger(Colors.yellow('[purchaseMerchantGiftRedeem] B-Unit consume skipped: CoNET settle pool busy'))
		return
	}
	try {
		const bunitWrite = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
			SC.walletConet,
		)
		const consumeTx = await bunitWrite.consumeFromUser(
			args.bunitFeeConsumer,
			args.bunitFeeUnits6,
			args.createTxHash as `0x${string}`,
			0n,
			BUNIT_KIND_TOPUP_FAMILY,
			{ gasLimit: 2_500_000 },
		)
		await consumeTx.wait()
		await syncStandaloneBunitServiceFeeToIndexer({
			walletConet: SC.walletConet,
			BeamioTaskDiamondAction: SC.BeamioTaskDiamondAction,
			consumeTxHash: consumeTx.hash,
			basePaymentHash: args.createTxHash,
			cardAddress: args.cardAddress,
			bServiceUnits6: args.bunitFeeUnits6,
			feePayer: args.bunitFeeConsumer,
			txCategory: ethers.keccak256(
				ethers.toUtf8Bytes('merchantGiftPurchase:bunitService'),
			) as `0x${string}`,
			title: 'Gift Purchase B-Unit Fee',
			source: 'purchaseMerchantGiftRedeem',
			operator: ethers.ZeroAddress,
			operatorParentChain: [],
			topAdmin: ethers.ZeroAddress,
			subordinate: ethers.ZeroAddress,
			extraDisplay: { payWith: args.payWith, cardOwnerEOA: args.cardOwnerEOA },
			logLabel: 'purchaseMerchantGiftRedeem.bunit',
		})
		logger(
			Colors.cyan(
				`[purchaseMerchantGiftRedeem] B-Unit 20 consumed ${consumeTx.hash} consumer=${args.bunitFeeConsumer}`,
			),
		)
	} catch (e: unknown) {
		logger(
			Colors.yellow(
				`[purchaseMerchantGiftRedeem] B-Unit consume non-fatal: ${
					e instanceof Error ? e.message : String(e)
				}`,
			),
		)
	} finally {
		unshiftSettleConet(SC)
	}
}

async function purchaseMerchantGiftRedeemProcess(): Promise<void> {
	if (purchaseGiftInFlight) return
	const item = purchaseMerchantGiftRedeemPool.shift()
	if (!item) return
	purchaseGiftInFlight = true
	const SC = shiftSettleConet()
	try {
		if (!SC) {
			purchaseMerchantGiftRedeemPool.unshift(item)
			setTimeout(() => kickPurchaseMerchantGiftRedeemProcess(), 3000)
			return
		}
		const payWith = normalizePayWith(item.payWith)
		const cardAddress = ethers.getAddress(item.cardAddress)
		const from = ethers.getAddress(item.from)
		const cardOwner = ethers.getAddress(item.cardOwner)
		const membershipFeeE6 = BigInt(item.membershipFeeE6)
		const topupCreditE6 = BigInt(item.topupCreditE6)
		const topupPrincipalE6 = BigInt(item.topupPrincipalE6)
		const redeemHash = item.redeemHash
		const redeemValidAfter = BigInt(item.redeemValidAfter || '0')
		const redeemValidBefore = BigInt(item.redeemValidBefore)
		const bunitFeeUnits6 = BigInt(item.bunitFeeUnits6 || '0')
		const bunitFeeConsumer = item.bunitFeeConsumer
			? ethers.getAddress(item.bunitFeeConsumer)
			: ethers.ZeroAddress
		const cardOwnerEOA = item.cardOwnerEOA
			? ethers.getAddress(item.cardOwnerEOA)
			: cardOwner

		let paymentTxHash = ethers.ZeroHash
		let createCalldata: string

		if (payWith === 'reward13') {
			const peers = item.peerLegs ?? []
			const peerUsdcCredited6 = BigInt(item.quotedUsdc6 || '0')
			const sameStoreBurn13 = BigInt(item.sameStoreBurn13 || '0')
			const payerAccount = ethers.getAddress(item.payerAccount)
			const legsHash = item.peerLegsHash ?? ethers.ZeroHash
			const dest: string[] = []
			const value: bigint[] = []
			const func: string[] = []
			for (const peer of peers) {
				dest.push(ethers.getAddress(peer.cardAddress))
				value.push(0n)
				func.push(
					CHARGE_REWARD_V2_IFACE.encodeFunctionData('peerRedeem13ForContainerTopup', [
						from,
						BigInt(peer.burn13),
						BigInt(peer.usdcOut6),
						cardAddress,
					]),
				)
			}
			if (BigInt(item.cashUsdcAmount || '0') > 0n) {
				dest.push(ethers.getAddress(CONET_USDC))
				value.push(0n)
				func.push(
					new ethers.Interface([
						'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)',
					]).encodeFunctionData('transferWithAuthorization', [
						from,
						cardOwner,
						BigInt(item.cashUsdcAmount ?? '0'),
						BigInt(item.cashValidAfter || '0'),
						BigInt(item.cashValidBefore || '0'),
						item.cashNonce ?? ethers.ZeroHash,
						item.cashSignature ?? '0x',
					]),
				)
			}
			dest.push(cardAddress)
			value.push(0n)
			func.push(
				CREATE_GIFT_REDEEM_IFACE.encodeFunctionData('createGiftRedeemWithReward13Payment', [
					redeemHash,
					membershipFeeE6,
					topupCreditE6,
					sameStoreBurn13,
					peerUsdcCredited6,
					payerAccount,
					from,
					redeemValidAfter,
					redeemValidBefore,
					BigInt(item.validBefore),
					item.nonce,
					legsHash,
				]),
			)
			const createTx = await relayUserCardBatchViaEntryPoint({
				SC,
				chain: 'conet',
				cardAddressForFactory: cardAddress,
				dest,
				value,
				func,
				logTag: 'purchaseMerchantGiftRedeem.reward13',
				gasLimit: 30_000_000n,
			})
			const receipt = await createTx.wait()
			const ok = checkBusinessRelayTxSuccessful(receipt ?? undefined, {
				logTag: 'purchaseMerchantGiftRedeem.reward13',
			})
			if (!ok.ok) throw new Error(ok.reason ?? 'Reward PT Gift relay failed')
			const redeemUrl = item.redeemCode
				? buildCouponRedeemAppDownloadUrl(cardAddress, item.redeemCode)
				: undefined
			if (item.res && !item.res.headersSent) {
				item.res.status(200).json({
					success: true,
					payWith,
					...(item.redeemCode ? { redeemCode: item.redeemCode } : {}),
					redeemHash,
					...(redeemUrl ? { redeemUrl } : {}),
					createTxHash: createTx.hash,
					membershipFeeE6: item.membershipFeeE6,
					topupCreditE6: item.topupCreditE6,
					peerUsdcCredited6: peerUsdcCredited6.toString(),
				}).end()
			}
			await item.onSuccess?.(createTx.hash)
			await consumeMerchantGiftPurchaseBunitInBackground({
				cardAddress,
				cardOwnerEOA,
				bunitFeeConsumer,
				bunitFeeUnits6,
				createTxHash: createTx.hash,
				payWith,
			})
			return
		}

		if (payWith === 'credit') {
			const burnAmountE6 = BigInt(item.burnAmountE6)
			const payerAccount = ethers.getAddress(item.payerAccount)
			createCalldata = CREATE_GIFT_REDEEM_IFACE.encodeFunctionData('createGiftRedeemWithCreditBurn', [
				redeemHash,
				membershipFeeE6,
				topupCreditE6,
				burnAmountE6,
				payerAccount,
				redeemValidAfter,
				redeemValidBefore,
			])
			logger(
				Colors.gray(
					`[purchaseMerchantGiftRedeem] credit burn+create payerAA=${payerAccount} burn=${burnAmountE6} G=${
						membershipFeeE6 + topupCreditE6
					} F=${item.merchantFeeE6}`,
				),
			)
		} else {
			const usdcAmount = BigInt(item.usdcAmount)
			const nonceBytes32 = padNonceBytes32(item.nonce)
			const conetUsdcWrite = new ethers.Contract(CONET_USDC, CONET_USDC_EIP3009_ABI, SC.walletConet)
			logger(
				Colors.gray(
					`[purchaseMerchantGiftRedeem] USDC transferWithAuthorization from=${from} to=${cardOwner} value=${usdcAmount}`,
				),
			)
			const usdcTx = await conetUsdcWrite.transferWithAuthorization(
				from,
				cardOwner,
				usdcAmount,
				BigInt(item.validAfter || '0'),
				BigInt(item.validBefore),
				nonceBytes32,
				item.userSignature,
			)
			const usdcReceipt = await usdcTx.wait().catch((waitErr: unknown) => {
				logger(
					Colors.yellow(
						`[purchaseMerchantGiftRedeem] USDC tx.wait failed: ${
							waitErr instanceof Error ? waitErr.message : String(waitErr)
						}`,
					),
				)
				return null
			})
			const usdcOk = checkBusinessRelayTxSuccessful(usdcReceipt ?? undefined, {
				logTag: 'purchaseMerchantGiftRedeem.usdc',
			})
			if (!usdcOk.ok) {
				throw new Error(usdcOk.reason ?? 'CoNET-USDC transferWithAuthorization failed')
			}
			paymentTxHash = usdcTx.hash
			createCalldata = CREATE_GIFT_REDEEM_IFACE.encodeFunctionData('createGiftRedeemForPayer', [
				redeemHash,
				membershipFeeE6,
				topupCreditE6,
				redeemValidAfter,
				redeemValidBefore,
			])
		}

		const createTx = await relayUserCardCallViaEntryPoint({
			SC,
			chain: 'conet',
			cardAddress,
			cardCallData: createCalldata,
			logTag: 'purchaseMerchantGiftRedeem.create',
		})
		const createReceipt = await createTx.wait().catch((waitErr: unknown) => {
			logger(
				Colors.yellow(
					`[purchaseMerchantGiftRedeem] create tx.wait failed: ${
						waitErr instanceof Error ? waitErr.message : String(waitErr)
					}`,
				),
			)
			return null
		})
		const createOk = checkBusinessRelayTxSuccessful(createReceipt ?? undefined, {
			logTag: 'purchaseMerchantGiftRedeem.create',
		})
		if (!createOk.ok) {
			throw new Error(createOk.reason ?? 'createGiftRedeem relay failed')
		}
		const createTxHash = createTx.hash
		const redeemUrl = item.redeemCode
			? buildCouponRedeemAppDownloadUrl(cardAddress, item.redeemCode)
			: undefined

		if (item.res && !item.res.headersSent) {
			item.res
				.status(200)
				.json({
					success: true,
					payWith,
					...(item.redeemCode ? { redeemCode: item.redeemCode } : {}),
					redeemHash,
					...(redeemUrl ? { redeemUrl } : {}),
					usdcTxHash: paymentTxHash !== ethers.ZeroHash ? paymentTxHash : undefined,
					createTxHash,
					membershipFeeE6: item.membershipFeeE6,
					topupPrincipalE6: item.topupPrincipalE6,
					topupCreditE6: item.topupCreditE6,
					burnAmountE6: payWith === 'credit' ? item.burnAmountE6 : undefined,
					merchantFeeE6: payWith === 'credit' ? item.merchantFeeE6 : undefined,
					cardOwner,
				})
				.end()
		}
		await item.onSuccess?.(createTxHash)

		void consumeMerchantGiftPurchaseBunitInBackground({
			cardAddress,
			createTxHash,
			cardOwnerEOA,
			bunitFeeConsumer,
			bunitFeeUnits6,
			payWith,
		})

		void syncMerchantGiftRedeemIndexer({
			walletConet: SC.walletConet,
			usdcTxHash: paymentTxHash !== ethers.ZeroHash ? paymentTxHash : createTxHash,
			createTxHash,
			cardAddress,
			from,
			cardOwner,
			usdcAmount: payWith === 'usdc' ? BigInt(item.usdcAmount) : 0n,
			membershipFeeE6,
			topupCreditE6,
			topupPrincipalE6,
			redeemHash,
			cardCurrency: item.cardCurrency,
			payWith,
			merchantFeeE6: payWith === 'credit' ? BigInt(item.merchantFeeE6 || '0') : 0n,
		}).catch((e: unknown) => {
			logger(
				Colors.yellow(
					`[purchaseMerchantGiftRedeem] indexer non-critical: ${
						e instanceof Error ? e.message : String(e)
					}`,
				),
			)
		})
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red(`[purchaseMerchantGiftRedeem] ${msg}`))
		if (item.res && !item.res.headersSent) {
			item.res.status(400).json({ success: false, error: msg }).end()
		}
		await item.onFailure?.(msg)
	} finally {
		if (SC) unshiftSettleConet(SC)
		purchaseGiftInFlight = false
		if (purchaseMerchantGiftRedeemPool.length > 0) {
			setTimeout(() => {
				kickPurchaseMerchantGiftRedeemProcess()
			}, 0)
		}
	}
}

async function syncMerchantGiftRedeemIndexer(args: {
	walletConet: ethers.Wallet
	usdcTxHash: string
	createTxHash: string
	cardAddress: string
	from: string
	cardOwner: string
	usdcAmount: bigint
	membershipFeeE6: bigint
	topupCreditE6: bigint
	topupPrincipalE6: bigint
	redeemHash: string
	cardCurrency: number
	payWith: MerchantGiftPayWith
	merchantFeeE6: bigint
}): Promise<void> {
	const ACTION_SYNC_TOKEN_ABI = [
		'function syncTokenAction((bytes32 txId, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, address operator, address[] operatorParentChain, address topAdmin, address subordinate) in_) returns (uint256 actionId)',
	]
	const TX_CAT = ethers.keccak256(ethers.toUtf8Bytes('merchantGiftRedeem'))
	const fiat6 = args.membershipFeeE6 + args.topupPrincipalE6
	const displayJson = JSON.stringify({
		title: args.payWith === 'credit' ? 'Discover Credit Gift' : 'Discover Gift Redeem',
		handle: `Gift from ${args.from.slice(0, 10)}…`,
		finishedHash: args.createTxHash,
		source: 'purchaseMerchantGiftRedeem',
		payWith: args.payWith,
		usdcTxHash: args.usdcTxHash,
		redeemHash: args.redeemHash,
		membershipFeeE6: args.membershipFeeE6.toString(),
		topupPrincipalE6: args.topupPrincipalE6.toString(),
		topupCreditE6: args.topupCreditE6.toString(),
		merchantFeeE6: args.merchantFeeE6.toString(),
	})
	const input = {
		txId: args.createTxHash as `0x${string}`,
		originalPaymentHash: args.usdcTxHash as `0x${string}`,
		chainId: BigInt(CONET_MAINNET_CHAIN_ID),
		txCategory: TX_CAT,
		displayJson,
		timestamp: 0n,
		payer: args.from,
		payee: args.cardOwner,
		finalRequestAmountFiat6: fiat6 > 0n ? fiat6 : 1n,
		finalRequestAmountUSDC6: args.usdcAmount > 0n ? args.usdcAmount : fiat6 > 0n ? fiat6 : 1n,
		isAAAccount: args.payWith === 'credit',
		route: [
			{
				asset: args.cardAddress,
				amountE6: args.membershipFeeE6 + args.topupCreditE6,
				assetType: 1,
				source: 1,
				tokenId: 0n,
				itemCurrencyType: args.cardCurrency,
				offsetInRequestCurrencyE6: 0n,
			},
		],
		fees: {
			gasChainType: 0,
			gasWei: 0n,
			gasUSDC6: 0n,
			serviceUSDC6: 0n,
			bServiceUSDC6: 0n,
			bServiceUnits6: 0n,
			feePayer: ethers.ZeroAddress,
		},
		meta: {
			requestAmountFiat6: fiat6 > 0n ? fiat6 : 1n,
			requestAmountUSDC6: args.usdcAmount > 0n ? args.usdcAmount : fiat6 > 0n ? fiat6 : 1n,
			currencyFiat: args.cardCurrency,
			discountAmountFiat6: 0n,
			discountRateBps: 0,
			taxAmountFiat6: 0n,
			taxRateBps: 0,
			afterNotePayer: '',
			afterNotePayee: '',
		},
		operator: args.from,
		operatorParentChain: [] as string[],
		topAdmin: ethers.ZeroAddress,
		subordinate: ethers.ZeroAddress,
	}
	const facet = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, ACTION_SYNC_TOKEN_ABI, args.walletConet)
	const tx = await facet.syncTokenAction(input)
	await tx.wait().catch(() => null)
	logger(Colors.cyan(`[purchaseMerchantGiftRedeem] indexer sync ${tx.hash}`))
}
