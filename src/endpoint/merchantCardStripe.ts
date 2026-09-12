import Stripe from 'stripe'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { getStripeBeamioClient, getStripeBeamioSecretKey } from './stripeBeamio'
import {
    claimMerchantCardStripeSession,
	createMerchantCardStripeSession,
	createMerchantCardStripeOAuthState,
	consumeMerchantCardStripeOAuthState,
	claimMerchantCardStripeEvent,
	getMerchantCardStripeSessionByBusinessKey,
	getMerchantCardStripeSessionStatus,
	getMerchantCardStripeStatusFromDb,
	disconnectMerchantCardStripeAccount,
	disconnectMerchantCardStripeAccountWithAuthorization,
	setMerchantCardStripeTopupEnabledWithAuthorization,
    updateMerchantCardStripeAccount,
	updateMerchantCardStripeAccountById,
	updateMerchantCardStripeSession,
	claimPaymentLedger,
	updatePaymentLedger,
} from '../db'
import {
    executeForAdminPool,
    executeForAdminProcess,
    getStripeCardFulfillmentAdminAddresses,
    getStripeCardFulfillmentAdminAddress,
    nfcTopupPreparePayload,
    nfcTopupPreCheckAdminAirdropLimit,
    quoteUsdcDepositForCardFiat6,
    type NfcTopupMembershipFeeStage,
} from '../MemberCard'
import { providerForUserCardChain, resolveUserCardChain } from '../beamioUserCardChain'
import { CONET_RPC_URL } from '../chainAddresses'
import {
	purchaseMerchantGiftRedeemPreCheck,
	purchaseMerchantGiftRedeemPool,
	kickPurchaseMerchantGiftRedeemProcess,
	type PurchaseMerchantGiftRedeemBody,
} from '../purchaseMerchantGiftRedeem'
import {
	exchangeStripeConnectOAuthCode,
	getStripeConnectClientId,
	getStripeConnectRedirectUri,
	getStripeBeamioPublishableKey,
} from './stripeBeamio'

const APP_BASE_URL = 'https://beamio.app'

function stripePaymentRef(providerRef: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(`beamio-stripe-payment:v1|${providerRef}`))
}

function stripeClient(): Stripe {
	const client = getStripeBeamioClient()
	if (!client) throw new Error('Stripe is not configured on server')
	return client
}

function normalizeCardAddress(raw: string): string {
	if (!ethers.isAddress(raw)) throw new Error('Invalid cardAddress')
	return ethers.getAddress(raw)
}

function normalizeEoa(raw: string): string {
	if (!ethers.isAddress(raw)) throw new Error('Invalid buyerEoa')
	return ethers.getAddress(raw)
}

function stripeAmountFromFiat6(amountFiat6: string): number {
	if (!/^[0-9]+$/.test(amountFiat6) || BigInt(amountFiat6) <= 0n) {
		throw new Error('amountFiat6 must be a positive integer')
	}
	const value = BigInt(amountFiat6)
	if (value % 10_000n !== 0n) throw new Error('Stripe payments require a whole minor currency unit')
	const minor = value / 10_000n
	if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amountFiat6 is too large')
	return Number(minor)
}

function normalizeStripeCurrency(raw: string): string {
	const currency = raw.trim().toLowerCase()
	if (!/^[a-z]{3}$/.test(currency)) throw new Error('Invalid currency')
	return currency
}

const STRIPE_COUNTRY_CURRENCY: Record<string, string> = {
	AU: 'aud', AT: 'eur', BE: 'eur', CA: 'cad', CH: 'chf', DE: 'eur',
	DK: 'dkk', ES: 'eur', FI: 'eur', FR: 'eur', GB: 'gbp', HK: 'hkd',
	IE: 'eur', IT: 'eur', JP: 'jpy', LU: 'eur', MX: 'mxn', NL: 'eur',
	NO: 'nok', NZ: 'nzd', PL: 'pln', PT: 'eur', SE: 'sek', SG: 'sgd',
	US: 'usd',
}

function stripeTerminalCurrencyForCountry(country: string | null | undefined): string | null {
	return country ? STRIPE_COUNTRY_CURRENCY[country.trim().toUpperCase()] ?? null : null
}

function giftStripeMetadata(params: {
	kind: string
	redeemHash?: string
	ptUserSignature?: string
	ptNonce?: string
	ptValidAfter?: string
	ptValidBefore?: string
	ptPayerAccount?: string
	ptMembershipFeeE6?: string
	ptTopupPrincipalE6?: string
	ptSameStoreBurn13?: string
	ptPeerLegs?: unknown
}): Stripe.MetadataParam {
	if (params.kind !== 'gift') return {}
	if (!params.redeemHash || !ethers.isHexString(params.redeemHash, 32)) {
		throw new Error('Gift Stripe checkout requires redeemHash')
	}
	if (!params.ptUserSignature || !params.ptNonce || !params.ptPayerAccount) {
		throw new Error('Gift Stripe checkout requires Reward PT authorization')
	}
	return {
		redeem_hash: params.redeemHash,
		pt_user_signature: params.ptUserSignature,
		pt_nonce: params.ptNonce,
		pt_valid_after: params.ptValidAfter ?? '0',
		pt_valid_before: params.ptValidBefore ?? '0',
		pt_payer_account: params.ptPayerAccount,
		pt_membership_fee_e6: params.ptMembershipFeeE6 ?? '0',
		pt_topup_principal_e6: params.ptTopupPrincipalE6 ?? '0',
		pt_same_store_burn13: params.ptSameStoreBurn13 ?? '0',
		pt_peer_legs_json: JSON.stringify(params.ptPeerLegs ?? []),
	}
}

/**
 * Stripe payment success must never enqueue a mint that is guaranteed to
 * revert with UC_AdminAirdropLimitExceeded. This check intentionally covers
 * every configured signer: the worker may acquire any currently-free signer.
 */
async function assertStripeFulfillmentAdminLimits(
	cardAddress: string,
	pointsCredit6: string,
): Promise<void> {
	const points6 = BigInt(pointsCredit6)
	if (points6 <= 0n) return
	const admins = getStripeCardFulfillmentAdminAddresses()
	if (admins.length === 0) {
		throw new Error('Stripe fulfillment admin pool is empty')
	}
	for (const admin of admins) {
		const check = await nfcTopupPreCheckAdminAirdropLimit(cardAddress, admin, points6)
		if (!check.success) {
			throw new Error(
				`Stripe fulfillment admin ${admin} is not authorized for this top-up: ${check.error ?? 'admin airdrop limit check failed'}`,
			)
		}
	}
}

export function buildMerchantCardStripeDisconnectMessage(params: {
	cardAddress: string
	merchantEoa: string
	deadline: number
	nonce: string
}): string {
	return [
		'Beamio Merchant Card Stripe Disconnect',
		`Card: ${normalizeCardAddress(params.cardAddress).toLowerCase()}`,
		`Merchant: ${normalizeEoa(params.merchantEoa).toLowerCase()}`,
		`Deadline: ${params.deadline}`,
		`Nonce: ${params.nonce.toLowerCase()}`,
	].join('\n')
}

export function buildMerchantCardStripeTopupEnabledMessage(params: {
	cardAddress: string
	merchantEoa: string
	deadline: number
	nonce: string
	topupEnabled: boolean
}): string {
	return [
		'Beamio Merchant Card Stripe Top-up Availability',
		`Card: ${normalizeCardAddress(params.cardAddress).toLowerCase()}`,
		`Merchant: ${normalizeEoa(params.merchantEoa).toLowerCase()}`,
		`Top-up enabled: ${params.topupEnabled ? 'true' : 'false'}`,
		`Deadline: ${params.deadline}`,
		`Nonce: ${params.nonce.toLowerCase()}`,
	].join('\n')
}

export function buildMerchantCardStripeOAuthConnectMessage(params: {
	cardAddress: string
	merchantEoa: string
	deadline: number
	nonce: string
}): string {
	return [
		'Beamio Merchant Card Stripe OAuth Connect',
		`Card: ${normalizeCardAddress(params.cardAddress).toLowerCase()}`,
		`Merchant: ${normalizeEoa(params.merchantEoa).toLowerCase()}`,
		`Deadline: ${params.deadline}`,
		`Nonce: ${params.nonce.toLowerCase()}`,
	].join('\n')
}

/**
 * Runs only after Cluster verifies the owner signature. This removes Beamio's
 * local mapping and OAuth credentials; it does not close or delete the
 * merchant's Stripe Connected Account.
 */
export async function disconnectMerchantCardStripeAccountForOwner(params: {
	cardAddress: string
	merchantEoa: string
	deadline: number
	nonce: string
}): Promise<{ cardAddress: string; disconnected: true }> {
	const outcome = await disconnectMerchantCardStripeAccountWithAuthorization({
		nonce: params.nonce,
		cardAddress: params.cardAddress,
		merchantEoa: params.merchantEoa,
		expiresAt: new Date(params.deadline * 1000),
	})
	if (outcome === 'authorization_used') {
		throw new Error('This Stripe disconnect authorization has already been used')
	}
	if (outcome === 'not_connected') {
		throw new Error('No Stripe account is currently connected to this merchant card')
	}
	return { cardAddress: normalizeCardAddress(params.cardAddress), disconnected: true }
}

/** Runs only after Cluster verifies the signed owner authorization. */
export async function setMerchantCardStripeTopupEnabledForOwner(params: {
	cardAddress: string
	merchantEoa: string
	deadline: number
	nonce: string
	topupEnabled: boolean
}): Promise<{ cardAddress: string; topupEnabled: boolean }> {
	const outcome = await setMerchantCardStripeTopupEnabledWithAuthorization({
		nonce: params.nonce,
		cardAddress: params.cardAddress,
		merchantEoa: params.merchantEoa,
		expiresAt: new Date(params.deadline * 1000),
		topupEnabled: params.topupEnabled,
	})
	if (outcome === 'authorization_used') {
		throw new Error('This Stripe top-up authorization has already been used')
	}
	if (outcome === 'not_connected') {
		throw new Error('No Stripe account is currently connected to this merchant card')
	}
	return {
		cardAddress: normalizeCardAddress(params.cardAddress),
		topupEnabled: params.topupEnabled,
	}
}

export async function createMerchantCardStripeAccountLink(cardAddressRaw: string): Promise<{
	stripeAccountId: string
	url: string
	fulfillmentAdmin: string
	fulfillmentAdmins: string[]
}> {
	const cardAddress = normalizeCardAddress(cardAddressRaw)
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	const fulfillmentAdmin = fulfillmentAdmins[0] ?? null
	if (!fulfillmentAdmin) throw new Error('Stripe card fulfillment admin pool is not configured')
	const existing = await getMerchantCardStripeStatusFromDb(cardAddress)
	const stripe = stripeClient()
	if (existing?.stripeAccountId) {
		throw new Error('Merchant already has a Stripe account connected. Use OAuth reconnect if needed.')
	}
	throw new Error('Express Account Link is deprecated. Use Stripe OAuth Connect.')
}

/** Starts Stripe OAuth Connect for an existing merchant Stripe account. */
export async function createMerchantCardStripeOAuthUrl(params: {
	cardAddress: string
	merchantEoa: string
	deadline: number
	nonce: string
}): Promise<{ url: string; state: string; fulfillmentAdmin: string; fulfillmentAdmins: string[] }> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const merchantEoa = normalizeEoa(params.merchantEoa)
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	const fulfillmentAdmin = fulfillmentAdmins[0] ?? null
	const clientId = getStripeConnectClientId()
	if (!fulfillmentAdmin || fulfillmentAdmins.length === 0) {
		throw new Error('Stripe card fulfillment admin pool is not configured')
	}
	if (!clientId) throw new Error('Stripe Connect OAuth is not configured on server')
	const existing = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (existing?.stripeAccountId) {
		throw new Error('Merchant Stripe account is already connected')
	}
	const state = ethers.hexlify(ethers.randomBytes(32))
	const authorizationStored = await createMerchantCardStripeOAuthState({
		state,
		cardAddress,
		merchantEoa,
		authorizationNonce: params.nonce,
		expiresAt: new Date(Date.now() + 10 * 60 * 1000),
	})
	if (!authorizationStored) throw new Error('This Stripe connection authorization has already been used')
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		scope: 'read_write',
		state,
		redirect_uri: getStripeConnectRedirectUri(),
	})
	return {
		url: `https://connect.stripe.com/oauth/authorize?${query.toString()}`,
		state,
		fulfillmentAdmin,
		fulfillmentAdmins,
	}
}

/** Exchanges a one-time OAuth code and binds the returned connected account to the card. */
export async function completeMerchantCardStripeOAuth(params: {
	state: string
	code: string
}): Promise<{
	cardAddress: string
	stripeAccountId: string
	merchantEoa: string
	topupEnabled: boolean
	adminLimitAuthorizationRequired: string[]
	adminNotOnCard: string[]
}> {
	if (!/^0x[0-9a-fA-F]{64}$/.test(params.state)) throw new Error('Invalid OAuth state')
	if (!params.code || params.code.length > 2048) throw new Error('Invalid OAuth code')
	const state = await consumeMerchantCardStripeOAuthState(params.state)
	if (!state) throw new Error('OAuth state is invalid, expired, or already used')
	const token = await exchangeStripeConnectOAuthCode(params.code)
	if (!token.stripe_user_id) throw new Error('Stripe OAuth did not return a connected account')
	const account = await stripeClient().accounts.retrieve(token.stripe_user_id)
	if ('deleted' in account && account.deleted) throw new Error('Connected Stripe account was deleted')
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	let adminLimitStatus: Awaited<ReturnType<typeof getMerchantCardStripeAdminLimitStatus>>
	try {
		adminLimitStatus = await getMerchantCardStripeAdminLimitStatus({
			cardAddress: state.cardAddress,
			adminAddresses: fulfillmentAdmins,
		})
	} catch (error: any) {
		logger(Colors.yellow(`[merchantCardStripe] unable to verify fulfillment admin allowances after OAuth: ${error?.message ?? error}`))
		// Keep Stripe top-up disabled until the owner explicitly repairs the
		// allowances and the status endpoint can verify them.
		adminLimitStatus = {
			cardAddress: state.cardAddress,
			admins: [],
			zeroLimitAdmins: fulfillmentAdmins,
			nonCardAdmins: [],
		}
	}
	await updateMerchantCardStripeAccount({
		cardAddress: state.cardAddress,
		stripeAccountId: token.stripe_user_id,
		chargesEnabled: account.charges_enabled === true,
		detailsSubmitted: account.details_submitted === true,
		stripeFulfillmentAdmin: fulfillmentAdmins[0] ?? null,
		stripeFulfillmentAdmins: fulfillmentAdmins,
		stripeAccessToken: token.access_token ?? null,
		stripeRefreshToken: token.refresh_token ?? null,
		stripeOauthScope: token.scope ?? null,
		// Do not enable checkout until every configured Beamio fulfillment admin
		// has a non-zero on-chain allowance. Changing that allowance requires a
		// separate card-owner executeForOwner authorization.
		stripeTopupEnabled: adminLimitStatus.zeroLimitAdmins.length === 0 && adminLimitStatus.nonCardAdmins.length === 0,
	})
	return {
		cardAddress: state.cardAddress,
		stripeAccountId: token.stripe_user_id,
		merchantEoa: state.merchantEoa,
		topupEnabled: adminLimitStatus.zeroLimitAdmins.length === 0 && adminLimitStatus.nonCardAdmins.length === 0,
		adminLimitAuthorizationRequired: adminLimitStatus.zeroLimitAdmins,
		adminNotOnCard: adminLimitStatus.nonCardAdmins,
	}
}

export type MerchantCardStripeAdminLimitStatus = {
	admin: string
	isCardAdmin: boolean
	limit: string
	usedFromClear: string
	unlimited: boolean
	requiresOwnerAuthorization: boolean
}

/**
 * Reads the current CoNET card governance state for the server's Stripe
 * fulfillment admins. This is deliberately read-only: only the card owner
 * may authorize setAdminAirdropLimit through executeForOwner.
 */
export async function getMerchantCardStripeAdminLimitStatus(params: {
	cardAddress: string
	adminAddresses?: string[]
}): Promise<{
	cardAddress: string
	admins: MerchantCardStripeAdminLimitStatus[]
	zeroLimitAdmins: string[]
	nonCardAdmins: string[]
}> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const addresses = (params.adminAddresses ?? getStripeCardFulfillmentAdminAddresses())
		.map(normalizeEoa)
		.filter((address, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === address.toLowerCase()) === index)
	const provider = providerForUserCardChain(await resolveUserCardChain(cardAddress))
	const card = new ethers.Contract(cardAddress, [
		'function getAdminAirdropLimit(address) view returns (tuple(address admin, address parent, uint256 limit, uint256 usedFromClear, uint256 remainingAvailable, bool unlimited))',
	], provider)
	const admins: MerchantCardStripeAdminLimitStatus[] = []
	for (const adminAddress of addresses) {
		const row = await card.getAdminAirdropLimit(adminAddress)
		const admin = ethers.getAddress(String(row.admin))
		const limit = BigInt(row.limit)
		const usedFromClear = BigInt(row.usedFromClear)
		const unlimited = Boolean(row.unlimited)
		const isCardAdmin = admin !== ethers.ZeroAddress
		admins.push({
			admin: adminAddress,
			isCardAdmin,
			limit: limit.toString(),
			usedFromClear: usedFromClear.toString(),
			unlimited,
			requiresOwnerAuthorization: isCardAdmin && !unlimited && limit === 0n,
		})
	}
	return {
		cardAddress,
		admins,
		zeroLimitAdmins: admins
			.filter((entry) => entry.requiresOwnerAuthorization)
			.map((entry) => entry.admin),
		nonCardAdmins: admins
			.filter((entry) => !entry.isCardAdmin)
			.map((entry) => entry.admin),
	}
}

export async function getMerchantCardStripeStatus(cardAddressRaw: string) {
	const cardAddress = normalizeCardAddress(cardAddressRaw)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	const fulfillmentAdmin = fulfillmentAdmins[0] ?? null
	if (!fulfillmentAdmin) throw new Error('Stripe card fulfillment admin pool is not configured')
	if (!local?.stripeAccountId) {
		return { connected: false, linked: false, topupEnabled: false, cardAddress, fulfillmentAdmin, fulfillmentAdmins }
	}
	const account = await stripeClient().accounts.retrieve(local.stripeAccountId)
	if ('deleted' in account && account.deleted) {
		// Stripe has authoritatively removed this Connected Account, so clear
		// the stale local mapping and let the merchant start a new OAuth flow.
		await disconnectMerchantCardStripeAccount(cardAddress)
		return { connected: false, linked: false, topupEnabled: false, cardAddress, fulfillmentAdmin, fulfillmentAdmins }
	}
	const chargesEnabled = account.charges_enabled === true
	const detailsSubmitted = account.details_submitted === true
	await updateMerchantCardStripeAccount({
		cardAddress,
		stripeAccountId: account.id,
		chargesEnabled,
		detailsSubmitted,
		stripeFulfillmentAdmin: fulfillmentAdmin,
		stripeFulfillmentAdmins: fulfillmentAdmins,
	})
	const adminLimitStatus = await getMerchantCardStripeAdminLimitStatus({
		cardAddress,
		adminAddresses: fulfillmentAdmins,
	})
	const topupEnabled =
		local.stripeTopupEnabled &&
		adminLimitStatus.zeroLimitAdmins.length === 0 &&
		adminLimitStatus.nonCardAdmins.length === 0
	return {
		connected: true,
		linked: chargesEnabled && detailsSubmitted && fulfillmentAdmins.every(
			(address) => local.stripeFulfillmentAdmins.some(
				(bound) => bound.toLowerCase() === address.toLowerCase(),
			),
		),
		cardAddress,
		stripeAccountId: account.id,
		chargesEnabled,
		detailsSubmitted,
		fulfillmentAdmin,
		fulfillmentAdmins,
		// A persisted flag cannot override the current on-chain allowance.
		// Keep top-ups off until every configured Beamio fulfillment admin is
		// an actual card admin with an unlimited allowance.
		topupEnabled,
		adminLimitStatus: adminLimitStatus.admins,
		adminLimitAuthorizationRequired: adminLimitStatus.zeroLimitAdmins,
		adminNotOnCard: adminLimitStatus.nonCardAdmins,
	}
}

export async function createMerchantCardStripeCheckoutSession(params: {
	cardAddress: string
	buyerEoa: string
	amountFiat6: string
	currency: string
	kind: 'topup' | 'membership' | 'gift'
	membershipTierIndex?: number
	membershipFeeFiat6?: string
	redeemHash?: string
	ptUserSignature?: string
	ptNonce?: string
	ptValidAfter?: string
	ptValidBefore?: string
	ptPayerAccount?: string
	ptMembershipFeeE6?: string
	ptTopupPrincipalE6?: string
	ptSameStoreBurn13?: string
	ptPeerLegs?: unknown
	businessIdempotencyKey?: string
}): Promise<{ sessionId: string; url: string }> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const buyerEoa = normalizeEoa(params.buyerEoa)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (!local?.stripeAccountId || !local.chargesEnabled || !local.detailsSubmitted) {
		throw new Error('Merchant Stripe account is not ready')
	}
	if (params.kind === 'topup' && !local.stripeTopupEnabled) {
		throw new Error('This merchant is not accepting Stripe top-ups')
	}
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	const fulfillmentAdmin = fulfillmentAdmins[0] ?? null
	const boundFulfillmentAdmins = local.stripeFulfillmentAdmins.length > 0
		? local.stripeFulfillmentAdmins
		: local.stripeFulfillmentAdmin
			? [local.stripeFulfillmentAdmin]
			: []
	if (!fulfillmentAdmin || fulfillmentAdmins.some(
		(address) => !boundFulfillmentAdmins.some((bound) => bound.toLowerCase() === address.toLowerCase()),
	)) {
		throw new Error('Merchant card Stripe fulfillment admin pool is not linked')
	}
	const amount = stripeAmountFromFiat6(params.amountFiat6)
	const currency = normalizeStripeCurrency(params.currency)
	const businessIdempotencyKey = params.businessIdempotencyKey?.trim()
	if (!businessIdempotencyKey || !/^[A-Za-z0-9:_-]{16,128}$/.test(businessIdempotencyKey)) {
		throw new Error('businessIdempotencyKey is required')
	}
	const existingByKey = await getMerchantCardStripeSessionByBusinessKey(businessIdempotencyKey)
	if (existingByKey) {
		const existingSession = await stripeClient().checkout.sessions.retrieve(existingByKey.sessionId)
		return { sessionId: existingByKey.sessionId, url: existingSession.url ?? '' }
	}
	const stripe = stripeClient()
	const giftMetadata = giftStripeMetadata(params)
	const session = await stripe.checkout.sessions.create({
		mode: 'payment',
		customer_creation: 'if_required',
		line_items: [{
			price_data: {
				currency,
				product_data: { name: params.kind === 'membership' ? 'Membership fee' : 'Program card top-up' },
				unit_amount: amount,
			},
			quantity: 1,
		}],
		payment_intent_data: {
			transfer_data: { destination: local.stripeAccountId },
			metadata: {
				product: 'merchantCardStripe',
				card_address: cardAddress,
				buyer_eoa: buyerEoa,
				amount_fiat6: params.amountFiat6,
				currency: params.currency.toUpperCase(),
				kind: params.kind,
				...(params.membershipTierIndex == null ? {} : { membership_tier_index: String(params.membershipTierIndex) }),
				...(params.membershipFeeFiat6 == null ? {} : { membership_fee_fiat6: params.membershipFeeFiat6 }),
				...giftMetadata,
			},
		},
		metadata: {
			product: 'merchantCardStripe',
			card_address: cardAddress,
			buyer_eoa: buyerEoa,
                    amount_fiat6: params.amountFiat6,
                    currency: params.currency.toUpperCase(),
			kind: params.kind,
                    ...(params.membershipTierIndex == null ? {} : { membership_tier_index: String(params.membershipTierIndex) }),
                    ...(params.membershipFeeFiat6 == null ? {} : { membership_fee_fiat6: params.membershipFeeFiat6 }),
                    ...giftMetadata,
		},
		// SilentPassUI uses HashRouter. Keep the session query inside the hash so
		// Stripe returns to a URL that the PWA router can actually match.
		success_url: `${APP_BASE_URL}/app/#/stripe-payment-return?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${APP_BASE_URL}/app/#/stripe-payment-return?cancelled=1&session_id={CHECKOUT_SESSION_ID}`,
	}, { idempotencyKey: businessIdempotencyKey })
	const inserted = await createMerchantCardStripeSession({
		sessionId: session.id,
		cardAddress,
		buyerEoa,
		amountFiat6: params.amountFiat6,
		currency: params.currency,
		kind: params.kind,
		membershipTierIndex: params.membershipTierIndex,
		membershipFeeFiat6: params.membershipFeeFiat6,
		redeemHash: params.redeemHash,
		fulfillmentPayload: params.kind === 'gift' ? giftMetadata : null,
		businessIdempotencyKey,
		paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
	})
	if (!inserted) {
		const duplicate = await getMerchantCardStripeSessionByBusinessKey(businessIdempotencyKey)
		if (duplicate) {
			const duplicateSession = await stripe.checkout.sessions.retrieve(duplicate.sessionId)
			return { sessionId: duplicate.sessionId, url: duplicateSession.url ?? '' }
		}
		throw new Error('Stripe session already exists')
	}
	return { sessionId: session.id, url: session.url ?? '' }
}

/** Creates a PaymentIntent for the browser Payment Element.
 * No receipt email is supplied: email remains optional in the client UI.
 */
export async function createMerchantCardStripePaymentIntent(params: {
	cardAddress: string
	buyerEoa: string
	amountFiat6: string
	currency: string
	kind: 'topup' | 'membership' | 'gift'
	membershipTierIndex?: number
	membershipFeeFiat6?: string
	redeemHash?: string
	ptUserSignature?: string
	ptNonce?: string
	ptValidAfter?: string
	ptValidBefore?: string
	ptPayerAccount?: string
	ptMembershipFeeE6?: string
	ptTopupPrincipalE6?: string
	ptSameStoreBurn13?: string
	ptPeerLegs?: unknown
	businessIdempotencyKey?: string
}): Promise<{ paymentIntentId: string; clientSecret: string; publishableKey: string }> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const buyerEoa = normalizeEoa(params.buyerEoa)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (!local?.stripeAccountId || !local.chargesEnabled || !local.detailsSubmitted) {
		throw new Error('Merchant Stripe account is not ready')
	}
	if (params.kind === 'topup' && !local.stripeTopupEnabled) {
		throw new Error('This merchant is not accepting Stripe top-ups')
	}
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	const fulfillmentAdmin = fulfillmentAdmins[0] ?? null
	const boundFulfillmentAdmins = local.stripeFulfillmentAdmins.length > 0
		? local.stripeFulfillmentAdmins
		: local.stripeFulfillmentAdmin ? [local.stripeFulfillmentAdmin] : []
	if (!fulfillmentAdmin || fulfillmentAdmins.some(
		(address) => !boundFulfillmentAdmins.some((bound) => bound.toLowerCase() === address.toLowerCase()),
	)) {
		throw new Error('Merchant card Stripe fulfillment admin pool is not linked')
	}
	const amount = stripeAmountFromFiat6(params.amountFiat6)
	const currency = normalizeStripeCurrency(params.currency)
	const businessIdempotencyKey = params.businessIdempotencyKey?.trim()
	if (!businessIdempotencyKey || !/^[A-Za-z0-9:_-]{16,128}$/.test(businessIdempotencyKey)) {
		throw new Error('businessIdempotencyKey is required')
	}
	const publishableKey = getStripeBeamioPublishableKey()
	if (!publishableKey) throw new Error('Stripe publishable key is not configured on server')
	const existingByKey = await getMerchantCardStripeSessionByBusinessKey(businessIdempotencyKey)
	if (existingByKey?.paymentIntentId) {
		const existingIntent = await stripeClient().paymentIntents.retrieve(existingByKey.paymentIntentId)
		if (!existingIntent.client_secret) throw new Error('Stripe PaymentIntent has no client secret')
		return { paymentIntentId: existingIntent.id, clientSecret: existingIntent.client_secret, publishableKey }
	}
	const metadata: Stripe.MetadataParam = {
		product: 'merchantCardStripe',
		card_address: cardAddress,
		buyer_eoa: buyerEoa,
		amount_fiat6: params.amountFiat6,
		currency: params.currency.toUpperCase(),
		kind: params.kind,
		...(params.membershipTierIndex == null ? {} : { membership_tier_index: String(params.membershipTierIndex) }),
		...(params.membershipFeeFiat6 == null ? {} : { membership_fee_fiat6: params.membershipFeeFiat6 }),
		...giftStripeMetadata(params),
	}
	const paymentIntent = await stripeClient().paymentIntents.create({
		amount,
		currency,
		automatic_payment_methods: { enabled: true },
		description: params.kind === 'membership'
			? 'Membership fee'
			: params.kind === 'gift' ? 'Dining gift payment' : 'Program card top-up',
		transfer_data: { destination: local.stripeAccountId },
		metadata,
	}, { idempotencyKey: businessIdempotencyKey })
	if (!paymentIntent.client_secret) throw new Error('Stripe PaymentIntent has no client secret')
	const inserted = await createMerchantCardStripeSession({
		sessionId: paymentIntent.id,
		cardAddress,
		buyerEoa,
		amountFiat6: params.amountFiat6,
		currency: params.currency,
		kind: params.kind,
		membershipTierIndex: params.membershipTierIndex,
		membershipFeeFiat6: params.membershipFeeFiat6,
		redeemHash: params.redeemHash,
		fulfillmentPayload: params.kind === 'gift' ? giftStripeMetadata(params) : null,
		businessIdempotencyKey,
		paymentIntentId: paymentIntent.id,
	})
	if (!inserted) {
		const duplicate = await getMerchantCardStripeSessionByBusinessKey(businessIdempotencyKey)
		if (duplicate?.paymentIntentId) {
			const duplicateIntent = await stripeClient().paymentIntents.retrieve(duplicate.paymentIntentId)
			if (!duplicateIntent.client_secret) throw new Error('Stripe PaymentIntent has no client secret')
			return { paymentIntentId: duplicateIntent.id, clientSecret: duplicateIntent.client_secret, publishableKey }
		}
		throw new Error('Stripe PaymentIntent already exists')
	}
	return { paymentIntentId: paymentIntent.id, clientSecret: paymentIntent.client_secret, publishableKey }
}

type MerchantCardStripeTerminalPaymentParams = {
	cardAddress: string
	buyerEoa: string
	amountFiat6: string
	currency: string
	kind: 'topup' | 'membership' | 'gift'
	membershipTierIndex?: number
	membershipFeeFiat6?: string
	businessIdempotencyKey: string
	/** Cluster-resolved Stripe Terminal charge snapshot. Master trusts this snapshot. */
	chargeAmountFiat6?: string
	chargeCurrency?: string
}

async function ensureMerchantStripeTerminalLocation(
	stripe: Stripe,
	stripeAccountId: string,
	existingLocationId: string | null,
): Promise<string> {
	const account = await stripe.accounts.retrieve(stripeAccountId)
	if ('deleted' in account && account.deleted) throw new Error('Connected Stripe account was deleted')
	if (!account.country) throw new Error('Connected Stripe account country is unavailable')
	if (existingLocationId?.trim()) {
		const locationId = existingLocationId.trim()
		const location = await stripe.terminal.locations.retrieve(locationId, { stripeAccount: stripeAccountId })
		if ('deleted' in location && location.deleted) throw new Error('Stripe Terminal location was deleted')
		if (location.address?.country?.toUpperCase() !== account.country.toUpperCase()) {
			await stripe.terminal.locations.update(
				locationId,
				{ address: { country: account.country } },
				{ stripeAccount: stripeAccountId },
			)
		}
		return locationId
	}
	const locations = await stripe.terminal.locations.list(
		{ limit: 1 },
		{ stripeAccount: stripeAccountId },
	)
	const existing = locations.data[0]
	if (existing?.id) return existing.id
	const created = await stripe.terminal.locations.create(
		{
			display_name: 'Beamio POS',
			address: { country: account.country },
		},
		{ stripeAccount: stripeAccountId },
	)
	if (!created.id) throw new Error('Stripe Terminal location was not created')
	return created.id
}

export async function resolveMerchantCardStripeTerminalCharge(params: {
	cardAddress: string
	amountFiat6: string
	currency: string
}): Promise<{
	accountCountry: string
	chargeAmountFiat6: string
	chargeCurrency: string
}> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (!local?.stripeAccountId) throw new Error('Merchant Stripe account is not connected')
	const account = await stripeClient().accounts.retrieve(local.stripeAccountId)
	if ('deleted' in account && account.deleted) throw new Error('Connected Stripe account was deleted')
	const originalCurrency = normalizeStripeCurrency(params.currency)
	const localCurrency = stripeTerminalCurrencyForCountry(account.country)
	if (originalCurrency === 'usd' || originalCurrency === localCurrency) {
		return {
			accountCountry: account.country?.toUpperCase() ?? 'US',
			chargeAmountFiat6: params.amountFiat6,
			chargeCurrency: originalCurrency,
		}
	}
	const quotedUsd6 = await quoteUsdcDepositForCardFiat6(
		cardAddress,
		ethers.formatUnits(BigInt(params.amountFiat6), 6),
		originalCurrency.toUpperCase(),
	)
	const chargeAmountFiat6 = ((quotedUsd6 + 5_000n) / 10_000n) * 10_000n
	if (chargeAmountFiat6 <= 0n) {
		throw new Error(`Stripe Terminal cannot charge ${originalCurrency.toUpperCase()} for this merchant and USD conversion is unavailable`)
	}
	return {
		accountCountry: account.country?.toUpperCase() ?? 'US',
		chargeAmountFiat6: chargeAmountFiat6.toString(),
		chargeCurrency: 'usd',
	}
}

/**
 * Creates the server-side objects needed by the native Stripe Terminal SDK.
 * The card-present PaymentIntent is still fulfilled by the existing webhook /
 * idempotent merchant-card Stripe fulfillment path after confirmation.
 */
export async function createMerchantCardStripeTerminalPaymentIntent(
	params: MerchantCardStripeTerminalPaymentParams,
): Promise<{
	paymentIntentId: string
	clientSecret: string
	publishableKey: string
	locationId: string
}> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const buyerEoa = normalizeEoa(params.buyerEoa)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (!local?.stripeAccountId || !local.chargesEnabled || !local.detailsSubmitted) {
		throw new Error('Merchant Stripe account is not ready')
	}
	if (params.kind === 'topup' && !local.stripeTopupEnabled) {
		throw new Error('This merchant is not accepting Stripe top-ups')
	}
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	const boundAdmins = local.stripeFulfillmentAdmins.length > 0
		? local.stripeFulfillmentAdmins
		: local.stripeFulfillmentAdmin ? [local.stripeFulfillmentAdmin] : []
	if (
		fulfillmentAdmins.length === 0 ||
		fulfillmentAdmins.some((address) => !boundAdmins.some((bound) => bound.toLowerCase() === address.toLowerCase()))
	) {
		throw new Error('Merchant card Stripe fulfillment admin pool is not linked')
	}
	const currency = normalizeStripeCurrency(params.currency)
	const terminalCharge = params.chargeAmountFiat6 && params.chargeCurrency
		? {
			accountCountry: '',
			chargeAmountFiat6: params.chargeAmountFiat6,
			chargeCurrency: normalizeStripeCurrency(params.chargeCurrency),
		}
		: await resolveMerchantCardStripeTerminalCharge({
			cardAddress,
			amountFiat6: params.amountFiat6,
			currency,
		})
	const amount = stripeAmountFromFiat6(terminalCharge.chargeAmountFiat6)
	if (!/^[A-Za-z0-9:_-]{16,128}$/.test(params.businessIdempotencyKey.trim())) {
		throw new Error('businessIdempotencyKey is required')
	}
	const publishableKey = getStripeBeamioPublishableKey()
	if (!publishableKey) throw new Error('Stripe publishable key is not configured on server')
	const stripe = stripeClient()
	const existingByKey = await getMerchantCardStripeSessionByBusinessKey(params.businessIdempotencyKey.trim())
	if (existingByKey?.paymentIntentId) {
		const existingIntent = await stripe.paymentIntents.retrieve(existingByKey.paymentIntentId)
		if (!existingIntent.client_secret) throw new Error('Stripe PaymentIntent has no client secret')
		const locationId = await ensureMerchantStripeTerminalLocation(
			stripe,
			local.stripeAccountId,
			local.stripeTerminalLocationId,
		)
		if (local.stripeTerminalLocationId !== locationId) {
			await updateMerchantCardStripeAccount({
				cardAddress,
				stripeAccountId: local.stripeAccountId,
				stripeTerminalLocationId: locationId,
			})
		}
		return { paymentIntentId: existingIntent.id, clientSecret: existingIntent.client_secret, publishableKey, locationId }
	}
	const metadata: Stripe.MetadataParam = {
		product: 'merchantCardStripe',
		payment_mode: 'terminal',
		card_address: cardAddress,
		buyer_eoa: buyerEoa,
		amount_fiat6: params.amountFiat6,
		currency: currency.toUpperCase(),
		charge_amount_fiat6: terminalCharge.chargeAmountFiat6,
		charge_currency: terminalCharge.chargeCurrency.toUpperCase(),
		kind: params.kind,
		...(params.membershipTierIndex == null ? {} : { membership_tier_index: String(params.membershipTierIndex) }),
		...(params.membershipFeeFiat6 == null ? {} : { membership_fee_fiat6: params.membershipFeeFiat6 }),
	}
	const paymentIntent = await stripe.paymentIntents.create({
		amount,
		currency,
		payment_method_types: ['card_present'],
		description: params.kind === 'membership' ? 'Membership fee' : 'Program card top-up',
		on_behalf_of: local.stripeAccountId,
		transfer_data: { destination: local.stripeAccountId },
		metadata,
	}, { idempotencyKey: params.businessIdempotencyKey.trim() })
	if (!paymentIntent.client_secret) throw new Error('Stripe PaymentIntent has no client secret')
	const inserted = await createMerchantCardStripeSession({
		sessionId: paymentIntent.id,
		cardAddress,
		buyerEoa,
		amountFiat6: params.amountFiat6,
		currency,
		kind: params.kind,
		membershipTierIndex: params.membershipTierIndex,
		membershipFeeFiat6: params.membershipFeeFiat6,
		businessIdempotencyKey: params.businessIdempotencyKey.trim(),
		paymentIntentId: paymentIntent.id,
	})
	if (!inserted) throw new Error('Stripe Terminal payment already exists')
	const locationId = await ensureMerchantStripeTerminalLocation(
		stripe,
		local.stripeAccountId,
		local.stripeTerminalLocationId,
	)
	if (local.stripeTerminalLocationId !== locationId) {
		await updateMerchantCardStripeAccount({
			cardAddress,
			stripeAccountId: local.stripeAccountId,
			stripeTerminalLocationId: locationId,
		})
	}
	return { paymentIntentId: paymentIntent.id, clientSecret: paymentIntent.client_secret, publishableKey, locationId }
}

export async function createMerchantCardStripeTerminalConnectionToken(params: {
	cardAddress: string
}): Promise<{ secret: string; locationId: string }> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (!local?.stripeAccountId || !local.chargesEnabled || !local.detailsSubmitted) {
		throw new Error('Merchant Stripe account is not ready')
	}
	const stripe = stripeClient()
	const locationId = await ensureMerchantStripeTerminalLocation(
		stripe,
		local.stripeAccountId,
		local.stripeTerminalLocationId,
	)
	if (local.stripeTerminalLocationId !== locationId) {
		await updateMerchantCardStripeAccount({
			cardAddress,
			stripeAccountId: local.stripeAccountId,
			stripeTerminalLocationId: locationId,
		})
	}
	const token = await stripe.terminal.connectionTokens.create(
		{ location: locationId },
		{ stripeAccount: local.stripeAccountId },
	)
	return { secret: token.secret, locationId }
}

export async function pollMerchantCardStripeSession(sessionId: string) {
	if (/^pi_[A-Za-z0-9_]+$/.test(sessionId)) {
		const intent = await stripeClient().paymentIntents.retrieve(sessionId)
		if (intent.status === 'succeeded') {
			await fulfillMerchantCardStripePaymentIntent(sessionId).catch((error: any) => {
				logger(Colors.yellow(`[merchantCardStripe] terminal fulfillment retry failed: ${error?.message ?? error}`))
			})
		}
		const local = await getMerchantCardStripeSessionStatus(sessionId)
		return {
			sessionId: intent.id,
			status: intent.status === 'succeeded'
				? 'succeeded'
				: ['canceled', 'requires_payment_method'].includes(intent.status) ? 'failed' : 'pending',
			paymentStatus: intent.status,
			fulfillmentStatus: local?.fulfillmentStatus ?? (intent.status === 'succeeded' ? 'payment_succeeded' : 'payment_pending'),
			txHash: local?.txHash ?? null,
			error: local?.lastError ?? null,
			url: null,
		}
	}
	if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error('Invalid sessionId')
	const session = await stripeClient().checkout.sessions.retrieve(sessionId)
	const paid = session.payment_status === 'paid'
	if (paid) {
		await fulfillMerchantCardStripeSession(sessionId).catch((error: any) => {
			logger(Colors.yellow(`[merchantCardStripe] Checkout fulfillment retry failed: ${error?.message ?? error}`))
		})
	}
	const local = await getMerchantCardStripeSessionStatus(sessionId)
    if (session.status === 'expired') {
        await updateMerchantCardStripeSession({ sessionId, status: 'failed', lastError: 'Stripe Checkout session expired' })
    }
	const reconciledLocal = session.status === 'expired'
		? await getMerchantCardStripeSessionStatus(sessionId)
		: local
	return {
		sessionId: session.id,
		status: paid ? 'succeeded' : session.status === 'expired' ? 'failed' : 'pending',
		paymentStatus: session.payment_status,
		fulfillmentStatus: reconciledLocal?.fulfillmentStatus ?? (paid ? 'payment_succeeded' : 'payment_pending'),
		txHash: reconciledLocal?.txHash ?? null,
		error: reconciledLocal?.lastError ?? null,
		url: session.url ?? null,
	}
}

export async function cancelMerchantCardStripeSession(sessionId: string) {
	if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error('Invalid sessionId')
	const stripe = stripeClient()
	const session = await stripe.checkout.sessions.retrieve(sessionId)
	if (session.payment_status === 'paid' || session.status === 'complete') {
		// A close/cancel request must never roll back a payment that has already
		// completed. The webhook or the next poll remains responsible for
		// idempotent fulfillment.
		return {
			sessionId,
			cancelled: false,
			status: session.status,
			paymentStatus: session.payment_status,
			fulfillmentStatus: (await getMerchantCardStripeSessionStatus(sessionId))?.fulfillmentStatus ?? 'payment_succeeded',
		}
	}
	let reconciled = session
	if (session.status === 'open') {
		// Closing the browser is not a Stripe event. Explicitly expire the
		// unpaid Checkout Session so a later reopen cannot keep polling it.
		try {
			reconciled = await stripe.checkout.sessions.expire(sessionId)
		} catch (error) {
			// Payment and expire can race. Re-read before reporting cancellation;
			// a winning payment must remain successful and retryable for fulfillment.
			const latest = await stripe.checkout.sessions.retrieve(sessionId)
			if (latest.payment_status === 'paid' || latest.status === 'complete') {
				return {
					sessionId,
					cancelled: false,
					status: latest.status,
					paymentStatus: latest.payment_status,
					fulfillmentStatus: (await getMerchantCardStripeSessionStatus(sessionId))?.fulfillmentStatus ?? 'payment_succeeded',
				}
			}
			throw error
		}
	}
	if (reconciled.status === 'expired' && reconciled.payment_status !== 'paid') {
		await updateMerchantCardStripeSession({
			sessionId,
			status: 'failed',
			lastError: 'Stripe Checkout session expired before payment',
		})
	}
	const local = await getMerchantCardStripeSessionStatus(sessionId)
	return {
		sessionId,
		cancelled: reconciled.status === 'expired',
		status: reconciled.status,
		paymentStatus: reconciled.payment_status,
		fulfillmentStatus: local?.fulfillmentStatus ?? 'payment_pending',
		error: local?.lastError ?? null,
	}
}

async function fulfillMerchantCardStripeGift(params: {
	sessionId: string
	metadata: Stripe.Metadata
	paidAmount: number
	paidCurrency: string
}): Promise<void> {
	const meta = params.metadata
	if (!meta.card_address || !meta.buyer_eoa || !meta.redeem_hash ||
		!meta.pt_user_signature || !meta.pt_nonce || !meta.pt_payer_account) {
		throw new Error('Gift Stripe payment is missing Reward PT fulfillment metadata')
	}
	if (!meta.amount_fiat6 || !meta.currency ||
		params.paidAmount !== stripeAmountFromFiat6(meta.amount_fiat6) ||
		params.paidCurrency.toLowerCase() !== normalizeStripeCurrency(meta.currency)) {
		throw new Error('Gift Stripe amount does not match the fulfillment snapshot')
	}
	let peerLegs: unknown
	try {
		peerLegs = JSON.parse(meta.pt_peer_legs_json || '[]')
	} catch {
		throw new Error('Gift Stripe peer legs metadata is invalid')
	}
	const pre = await purchaseMerchantGiftRedeemPreCheck({
		cardAddress: meta.card_address,
		from: meta.buyer_eoa,
		redeemHash: meta.redeem_hash,
		userSignature: meta.pt_user_signature,
		nonce: meta.pt_nonce,
		validAfter: meta.pt_valid_after || '0',
		validBefore: meta.pt_valid_before || '0',
		payWith: 'reward13',
		payerAccount: meta.pt_payer_account,
		membershipFeeE6: meta.pt_membership_fee_e6 || '0',
		topupPrincipalE6: meta.pt_topup_principal_e6 || '0',
		sameStoreBurn13: meta.pt_same_store_burn13 || '0',
		peerLegs: peerLegs as PurchaseMerchantGiftRedeemBody['peerLegs'],
	})
	if (!pre.success) throw new Error(pre.error)
	if (!(await claimMerchantCardStripeSession(params.sessionId))) return
	await updateMerchantCardStripeSession({
		sessionId: params.sessionId,
		status: 'succeeded',
		fulfillmentStatus: 'payment_succeeded',
	})
	purchaseMerchantGiftRedeemPool.push({
		...pre.preChecked,
		res: undefined,
		onSuccess: (createTxHash) => updateMerchantCardStripeSession({
			sessionId: params.sessionId,
			fulfillmentStatus: 'fulfillment_succeeded',
			txHash: createTxHash,
		}),
		onFailure: (error) => updateMerchantCardStripeSession({
			sessionId: params.sessionId,
			status: 'failed',
			fulfillmentStatus: 'fulfillment_failed',
			lastError: error,
		}),
	})
	kickPurchaseMerchantGiftRedeemProcess()
}

/** Fulfill one paid Checkout session exactly once through ExecuteForAdmin. */
export async function fulfillMerchantCardStripeSession(sessionId: string): Promise<void> {
    const stripe = stripeClient()
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.payment_status !== 'paid') return
    const meta = session.metadata ?? {}
    if (meta.product !== 'merchantCardStripe') return
    if (!['topup', 'membership', 'gift'].includes(meta.kind ?? '')) throw new Error('Invalid merchantCardStripe kind')
	if (meta.kind === 'gift') {
		await fulfillMerchantCardStripeGift({
			sessionId,
			metadata: meta,
			paidAmount: session.amount_total ?? 0,
			paidCurrency: session.currency ?? '',
		})
		return
	}
    if (!meta.card_address || !meta.buyer_eoa || !meta.amount_fiat6 || !meta.currency) {
        throw new Error('Stripe session is missing fulfillment metadata')
    }
	const expectedAmount = stripeAmountFromFiat6(meta.amount_fiat6)
	if (session.amount_total !== expectedAmount) {
		throw new Error('Stripe amount does not match the fulfillment snapshot')
	}
	if ((session.currency ?? '').toLowerCase() !== normalizeStripeCurrency(meta.currency)) {
		throw new Error('Stripe currency does not match the fulfillment snapshot')
	}
    try {
        const tierIndex = meta.membership_tier_index == null ? undefined : Number(meta.membership_tier_index)
        const prepared = await nfcTopupPreparePayload({
            cardAddress: meta.card_address,
            wallet: meta.buyer_eoa,
            amount: ethers.formatUnits(BigInt(meta.amount_fiat6), 6),
            currency: meta.currency,
            idempotencyKey: `stripe-session:${sessionId}`,
            ...(tierIndex == null ? {} : { membershipTierIndex: tierIndex }),
            ...(meta.membership_fee_fiat6 ? { membershipFeeFiat6: meta.membership_fee_fiat6 } : {}),
        })
        if ('error' in prepared) throw new Error(prepared.error)
        let membershipFeeStage: NfcTopupMembershipFeeStage | undefined
        if (prepared.membershipNeedsFee && prepared.membershipTierIndex != null && prepared.membershipFeeFiat6) {
            const preparedFeeFiat6 = prepared.membershipFeeFiat6
            membershipFeeStage = {
                recipientEOA: meta.buyer_eoa,
                tierIndex: prepared.membershipTierIndex,
                feePaid6: BigInt(preparedFeeFiat6),
                pointsCredit6: BigInt(prepared.pointsCredit6 ?? '0'),
                durationKind: prepared.membershipDurationKind ?? 0,
                bootstrapOnChain: false,
            }
        }
		await assertStripeFulfillmentAdminLimits(prepared.cardAddr, prepared.pointsCredit6 ?? '0')
		const paymentRef = stripePaymentRef(sessionId)
		const ledgerClaim = await claimPaymentLedger({
			paymentRef,
			providerRef: sessionId,
			chain: 'stripe',
			payer: meta.buyer_eoa,
			recipient: prepared.cardAddr,
			amount6: meta.amount_fiat6,
		})
		if (!ledgerClaim.claimed) return
		// Claim only after all deterministic preflights pass. A failed preflight
		// therefore remains retryable after the merchant repairs authorization.
		if (!(await claimMerchantCardStripeSession(sessionId))) return
		await updateMerchantCardStripeSession({
			sessionId,
			status: 'succeeded',
			fulfillmentStatus: 'payment_succeeded',
			paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
		})
        executeForAdminPool.push({
            cardAddr: prepared.cardAddr,
            data: prepared.data,
            deadline: prepared.deadline,
            nonce: prepared.nonce,
			stripeFulfillment: true,
            topupKind: 2,
            topupFeeBUnits: 20_000_000n,
            stripeSessionId: sessionId,
            ...(membershipFeeStage ? { membershipFeeStage } : {}),
        })
        void executeForAdminProcess().catch((error) => {
			void updatePaymentLedger(paymentRef, {
				status: 'failed',
				lastError: error?.message ?? String(error),
			}).catch(() => {})
            void updateMerchantCardStripeSession({
                sessionId,
                status: 'failed',
                fulfillmentStatus: 'fulfillment_failed',
                lastError: error?.message ?? String(error),
            })
        })
		await updatePaymentLedger(paymentRef, { status: 'succeeded' })
    } catch (error: any) {
		await updatePaymentLedger(stripePaymentRef(sessionId), {
			status: 'failed',
			lastError: error?.message ?? String(error),
		}).catch(() => {})
        await updateMerchantCardStripeSession({
            sessionId,
            status: 'failed',
            fulfillmentStatus: 'fulfillment_failed',
            lastError: error?.message ?? String(error),
        })
        throw error
    }
}

/** Fulfill a paid PaymentIntent created by the Payment Element. */
export async function fulfillMerchantCardStripePaymentIntent(paymentIntentId: string): Promise<void> {
	const paymentIntent = await stripeClient().paymentIntents.retrieve(paymentIntentId)
	if (paymentIntent.status !== 'succeeded') return
	const meta = paymentIntent.metadata ?? {}
	if (meta.product !== 'merchantCardStripe') return
	if (!['topup', 'membership', 'gift'].includes(meta.kind ?? '')) throw new Error('Invalid merchantCardStripe kind')
	if (meta.kind === 'gift') {
		await fulfillMerchantCardStripeGift({
			sessionId: paymentIntentId,
			metadata: meta,
			paidAmount: paymentIntent.amount,
			paidCurrency: paymentIntent.currency,
		})
		return
	}
	if (!meta.card_address || !meta.buyer_eoa || !meta.amount_fiat6 || !meta.currency) {
		throw new Error('Stripe PaymentIntent is missing fulfillment metadata')
	}
	const chargeAmountFiat6 = meta.charge_amount_fiat6 || meta.amount_fiat6
	const chargeCurrency = meta.charge_currency || meta.currency
	const expectedAmount = stripeAmountFromFiat6(chargeAmountFiat6)
	if (paymentIntent.amount !== expectedAmount) {
		throw new Error('Stripe amount does not match the fulfillment snapshot')
	}
	if (paymentIntent.currency.toLowerCase() !== normalizeStripeCurrency(chargeCurrency)) {
		throw new Error('Stripe currency does not match the fulfillment snapshot')
	}
	try {
		const tierIndex = meta.membership_tier_index == null ? undefined : Number(meta.membership_tier_index)
		const prepared = await nfcTopupPreparePayload({
			cardAddress: meta.card_address,
			wallet: meta.buyer_eoa,
			amount: ethers.formatUnits(BigInt(meta.amount_fiat6), 6),
			currency: meta.currency,
			idempotencyKey: `stripe-payment-intent:${paymentIntentId}`,
			...(tierIndex == null ? {} : { membershipTierIndex: tierIndex }),
			...(meta.membership_fee_fiat6 ? { membershipFeeFiat6: meta.membership_fee_fiat6 } : {}),
		})
		if ('error' in prepared) throw new Error(prepared.error)
		let membershipFeeStage: NfcTopupMembershipFeeStage | undefined
		if (prepared.membershipNeedsFee && prepared.membershipTierIndex != null && prepared.membershipFeeFiat6) {
			membershipFeeStage = {
				recipientEOA: meta.buyer_eoa,
				tierIndex: prepared.membershipTierIndex,
				feePaid6: BigInt(prepared.membershipFeeFiat6),
				pointsCredit6: BigInt(prepared.pointsCredit6 ?? '0'),
				durationKind: prepared.membershipDurationKind ?? 0,
				bootstrapOnChain: false,
			}
		}
		await assertStripeFulfillmentAdminLimits(prepared.cardAddr, prepared.pointsCredit6 ?? '0')
		const paymentRef = stripePaymentRef(paymentIntentId)
		const ledgerClaim = await claimPaymentLedger({
			paymentRef,
			providerRef: paymentIntentId,
			chain: 'stripe',
			payer: meta.buyer_eoa,
			recipient: prepared.cardAddr,
			amount6: meta.amount_fiat6,
		})
		if (!ledgerClaim.claimed) return
		if (!(await claimMerchantCardStripeSession(paymentIntentId))) return
		await updateMerchantCardStripeSession({
			sessionId: paymentIntentId,
			status: 'succeeded',
			fulfillmentStatus: 'payment_succeeded',
			paymentIntentId,
		})
		executeForAdminPool.push({
			cardAddr: prepared.cardAddr,
			data: prepared.data,
			deadline: prepared.deadline,
			nonce: prepared.nonce,
			stripeFulfillment: true,
			topupKind: 2,
			topupFeeBUnits: 20_000_000n,
			stripeSessionId: paymentIntentId,
			...(membershipFeeStage ? { membershipFeeStage } : {}),
		})
		void executeForAdminProcess().catch((error) => {
			void updatePaymentLedger(paymentRef, {
				status: 'failed',
				lastError: error?.message ?? String(error),
			}).catch(() => {})
			void updateMerchantCardStripeSession({
				sessionId: paymentIntentId,
				status: 'failed',
				fulfillmentStatus: 'fulfillment_failed',
				lastError: error?.message ?? String(error),
			})
		})
		await updatePaymentLedger(paymentRef, { status: 'succeeded' })
	} catch (error: any) {
		await updatePaymentLedger(stripePaymentRef(paymentIntentId), {
			status: 'failed',
			lastError: error?.message ?? String(error),
		}).catch(() => {})
		await updateMerchantCardStripeSession({
			sessionId: paymentIntentId,
			status: 'failed',
			fulfillmentStatus: 'fulfillment_failed',
			lastError: error?.message ?? String(error),
		})
		throw error
	}
}

/** Webhook dispatch target. On-chain fulfillment is intentionally a separate idempotent worker step. */
export async function processMerchantCardStripeEvent(event: Stripe.Event): Promise<{ ok: true }> {
	const eventObject = event.data?.object as { id?: string; metadata?: { product?: string } } | undefined
	const sessionId = (event.type.startsWith('checkout.session.') || event.type.startsWith('payment_intent.'))
		? eventObject?.id ?? null
		: null
	const isNewEvent = await claimMerchantCardStripeEvent({
		eventId: event.id,
		eventType: event.type,
		sessionId,
	})
	if (event.type.startsWith('account.')) {
		if (!isNewEvent) return { ok: true }
		const account = event.data.object as Stripe.Account
		await updateMerchantCardStripeAccountById({
			stripeAccountId: account.id,
			chargesEnabled: account.charges_enabled === true,
			detailsSubmitted: account.details_submitted === true,
		})
		return { ok: true }
	}
	if (event.type === 'payment_intent.succeeded') {
		await fulfillMerchantCardStripePaymentIntent(eventObject?.id ?? '')
		return { ok: true }
	}
	if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
		if (eventObject?.id) {
			await updateMerchantCardStripeSession({
				sessionId: eventObject.id,
				status: 'failed',
				lastError: `Stripe event ${event.type}`,
			})
		}
		return { ok: true }
	}
	if (!event.type.startsWith('checkout.session.')) return { ok: true }
	const session = event.data.object as Stripe.Checkout.Session
	if (session.metadata?.product !== 'merchantCardStripe') return { ok: true }
	if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
		// A duplicate event is still a valid retry signal. Session-level claiming
		// prevents concurrent or completed sessions from minting twice.
		await fulfillMerchantCardStripeSession(session.id)
	} else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
		await updateMerchantCardStripeSession({
			sessionId: session.id,
			status: 'failed',
			lastError: `Stripe event ${event.type}`,
		})
	}
	return { ok: true }
}

export function merchantCardStripeConfigured(): boolean {
	return Boolean(getStripeBeamioSecretKey() && CONET_RPC_URL && getStripeCardFulfillmentAdminAddress())
}
