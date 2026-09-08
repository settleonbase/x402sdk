/**
 * Discover Gifting: gifter pays CoNET-USDC (EIP-3009 offline sign, zero gas) →
 * Master collects to card.owner() → EntryPoint relay createGiftRedeemForPayer (no owner signature).
 * Plaintext redeem code is returned once to the gifter only; chain stores keccak256(utf8(code)).
 */
import type { Response } from 'express'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import {
	BEAMIO_INDEXER_DIAMOND,
	CONET_CARD_FACTORY,
	CONET_MAINNET_CHAIN_ID,
	CONET_USDC,
} from './chainAddresses'
import { providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'
import {
	checkBusinessRelayTxSuccessful,
	relayUserCardCallViaEntryPoint,
} from './MemberCard'
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
	'function getGiftRedeemSplit(bytes32 hash) view returns (bool isGift, uint256 membershipFeeE6, uint256 topupCreditE6)',
] as const

const FACTORY_QUOTE_ABI = [
	'function quoteCurrencyAmountInUSDC6(uint8 currency, uint256 amount6) view returns (uint256)',
	'function defaultRedeemModule() view returns (address)',
] as const

const CARD_VERSION_ABI = ['function VERSION() view returns (uint256)'] as const

const CREATE_GIFT_REDEEM_IFACE = new ethers.Interface([
	'function createGiftRedeemForPayer(bytes32 hash, uint256 membershipFeeE6, uint256 topupCreditE6, uint64 validAfter, uint64 validBefore)',
])

const CREATE_GIFT_REDEEM_SEL =
	CREATE_GIFT_REDEEM_IFACE.getFunction('createGiftRedeemForPayer')?.selector ?? '0x00000000'

export type PurchaseMerchantGiftRedeemBody = {
	cardAddress: string
	from: string
	usdcAmount: string
	userSignature: string
	nonce: string
	validAfter: string
	validBefore: string
	redeemCode: string
	/** Optional client hint; Cluster overrides from metadata for fee cards. */
	membershipFeeE6?: string
	/** Top-up principal in card-currency E6 (before Multiplier bonus). */
	topupPrincipalE6?: string
	redeemValidAfter?: string
	redeemValidBefore?: string
}

export type PurchaseMerchantGiftRedeemPreChecked = PurchaseMerchantGiftRedeemBody & {
	cardOwner: string
	membershipFeeE6: string
	topupPrincipalE6: string
	topupCreditE6: string
	redeemHash: string
	cardCurrency: number
	quotedUsdc6: string
}

type PoolItem = PurchaseMerchantGiftRedeemPreChecked & { res: Response }

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

function humanFromE6(e6: bigint): number {
	return Number(e6) / 1e6
}

function e6FromHuman(n: number): bigint {
	return BigInt(Math.round(n * 1e6))
}

/** Multiplier / top-up promotion bonus on principal (card-currency human units → E6 credit). */
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
		if (!body?.redeemCode || typeof body.redeemCode !== 'string' || body.redeemCode.trim().length < 8) {
			return { success: false, error: 'redeemCode must be at least 8 characters' }
		}
		if (body.redeemCode.length > 128) {
			return { success: false, error: 'redeemCode too long' }
		}
		const usdcAmount = BigInt(body.usdcAmount)
		if (usdcAmount <= 0n) {
			return { success: false, error: 'usdcAmount must be > 0' }
		}
		const validBefore = BigInt(body.validBefore || '0')
		const validAfter = BigInt(body.validAfter || '0')
		const now = BigInt(Math.floor(Date.now() / 1000))
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

		const cardAddress = ethers.getAddress(body.cardAddress)
		const from = ethers.getAddress(body.from)
		const chain = await resolveUserCardChain(cardAddress)
		if (chain !== 'conet') {
			return { success: false, error: 'Merchant gift redeem is CoNET-only' }
		}
		const provider = providerForUserCardChain('conet')
		const factoryRead = new ethers.Contract(CONET_CARD_FACTORY, FACTORY_QUOTE_ABI, provider)
		const redeemModuleAddr = (await factoryRead.defaultRedeemModule()) as string
		const hasGiftModule = await bytecodeHasSelector(provider, redeemModuleAddr, CREATE_GIFT_REDEEM_SEL)
		if (!hasGiftModule) {
			return {
				success: false,
				error: 'Discover Gifting RedeemModule is not bound on Factory yet',
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

		const totalFiat6 = membershipFeeE6 + topupPrincipalE6
		let quotedUsdc6: bigint
		if (cardCurrency === 4) {
			// USDC card currency: 1:1 with payment USDC when unit price is 1e6
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

		const bonusE6 = computeTopupBonusE6(metadata, topupPrincipalE6)
		const topupCreditE6 = topupPrincipalE6 + bonusE6
		if (membershipFeeE6 + topupCreditE6 <= 0n) {
			return { success: false, error: 'Gift credit total must be > 0' }
		}

		const redeemCode = body.redeemCode.trim()
		const redeemHash = redeemHashFromCode(redeemCode)
		const [active] = (await card.getRedeemStatus(redeemHash)) as [boolean, bigint]
		if (active) {
			return { success: false, error: 'redeemCode already exists on-chain' }
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

		const redeemValidAfter = BigInt(body.redeemValidAfter ?? '0')
		const redeemValidBefore = BigInt(
			body.redeemValidBefore ?? String(Math.floor(Date.now() / 1000) + 365 * 24 * 3600),
		)
		if (redeemValidBefore <= now) {
			return { success: false, error: 'redeemValidBefore must be in the future' }
		}

		return {
			success: true,
			preChecked: {
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

async function purchaseMerchantGiftRedeemProcess(): Promise<void> {
	if (purchaseGiftInFlight) return
	const item = purchaseMerchantGiftRedeemPool.shift()
	if (!item) return
	purchaseGiftInFlight = true
	const SC = shiftSettleConet()
	try {
		if (!SC) {
			if (item.res && !item.res.headersSent) {
				item.res.status(503).json({ success: false, error: 'CoNET settle pool busy' }).end()
			}
			return
		}
		const cardAddress = ethers.getAddress(item.cardAddress)
		const from = ethers.getAddress(item.from)
		const cardOwner = ethers.getAddress(item.cardOwner)
		const usdcAmount = BigInt(item.usdcAmount)
		const nonceBytes32 = padNonceBytes32(item.nonce)
		const provider = providerForUserCardChain('conet')

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
			throw new Error(`CoNET-USDC transfer failed: ${usdcTx.hash} (${usdcOk.reason})`)
		}

		const membershipFeeE6 = BigInt(item.membershipFeeE6)
		const topupCreditE6 = BigInt(item.topupCreditE6)
		const cardCallData = CREATE_GIFT_REDEEM_IFACE.encodeFunctionData('createGiftRedeemForPayer', [
			item.redeemHash,
			membershipFeeE6,
			topupCreditE6,
			BigInt(item.redeemValidAfter || '0'),
			BigInt(item.redeemValidBefore || '0'),
		])
		const createTx = await relayUserCardCallViaEntryPoint({
			SC,
			chain: 'conet',
			cardAddress,
			cardCallData,
			logTag: 'purchaseMerchantGiftRedeem:createGift',
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
			logTag: 'purchaseMerchantGiftRedeem:createGift',
		})
		if (!createOk.ok) {
			throw new Error(`createGiftRedeemForPayer failed: ${createTx.hash} (${createOk.reason})`)
		}

		// Confirm gift split on-chain (best-effort)
		try {
			const card = new ethers.Contract(cardAddress, CARD_VIEW_ABI, provider)
			const [isGift] = (await card.getGiftRedeemSplit(item.redeemHash)) as [boolean, bigint, bigint]
			if (!isGift) {
				logger(Colors.yellow(`[purchaseMerchantGiftRedeem] getGiftRedeemSplit not yet visible hash=${item.redeemHash}`))
			}
		} catch {
			/* optional */
		}

		logger(
			Colors.green(
				`[purchaseMerchantGiftRedeem] ok card=${cardAddress} from=${from} usdc=${usdcTx.hash} create=${createTx.hash} fee=${membershipFeeE6} topupCredit=${topupCreditE6}`,
			),
		)

		if (item.res && !item.res.headersSent) {
			item.res
				.status(200)
				.json({
					success: true,
					cardAddress,
					from,
					usdcTxHash: usdcTx.hash,
					createTxHash: createTx.hash,
					redeemHash: item.redeemHash,
					redeemCode: item.redeemCode,
					membershipFeeE6: item.membershipFeeE6,
					topupPrincipalE6: item.topupPrincipalE6,
					topupCreditE6: item.topupCreditE6,
					shareUrl: `https://beamio.app/app/?beamiocard=${encodeURIComponent(cardAddress)}&redeemcode=${encodeURIComponent(item.redeemCode)}`,
				})
				.end()
		}

		// Indexer: fire-and-forget (do not block HTTP — already returned)
		void syncMerchantGiftRedeemIndexer({
			walletConet: SC.walletConet,
			usdcTxHash: usdcTx.hash,
			createTxHash: createTx.hash,
			cardAddress,
			from,
			cardOwner,
			usdcAmount,
			membershipFeeE6,
			topupCreditE6: topupCreditE6,
			topupPrincipalE6: BigInt(item.topupPrincipalE6),
			redeemHash: item.redeemHash,
			cardCurrency: item.cardCurrency,
		}).catch((e: unknown) => {
			logger(
				Colors.yellow(
					`[purchaseMerchantGiftRedeem] indexer non-critical: ${e instanceof Error ? e.message : String(e)}`,
				),
			)
		})
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red(`[purchaseMerchantGiftRedeem] ${msg}`))
		if (item.res && !item.res.headersSent) {
			item.res.status(400).json({ success: false, error: msg }).end()
		}
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
}): Promise<void> {
	const ACTION_SYNC_TOKEN_ABI = [
		'function syncTokenAction((bytes32 txId, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, address operator, address[] operatorParentChain, address topAdmin, address subordinate) in_) returns (uint256 actionId)',
	]
	const TX_CAT = ethers.keccak256(ethers.toUtf8Bytes('merchantGiftRedeem'))
	const fiat6 = args.membershipFeeE6 + args.topupPrincipalE6
	const displayJson = JSON.stringify({
		title: 'Discover Gift Redeem',
		handle: `Gift from ${args.from.slice(0, 10)}…`,
		finishedHash: args.createTxHash,
		source: 'purchaseMerchantGiftRedeem',
		usdcTxHash: args.usdcTxHash,
		redeemHash: args.redeemHash,
		membershipFeeE6: args.membershipFeeE6.toString(),
		topupPrincipalE6: args.topupPrincipalE6.toString(),
		topupCreditE6: args.topupCreditE6.toString(),
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
		finalRequestAmountUSDC6: args.usdcAmount,
		isAAAccount: false,
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
			requestAmountUSDC6: args.usdcAmount,
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
