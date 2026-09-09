import Stripe from 'stripe'
import { ethers } from 'ethers'
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
    updateMerchantCardStripeAccount,
	updateMerchantCardStripeAccountById,
	updateMerchantCardStripeSession,
} from '../db'
import {
    executeForAdminPool,
    executeForAdminProcess,
    getStripeCardFulfillmentAdminAddresses,
    getStripeCardFulfillmentAdminAddress,
    nfcTopupPreparePayload,
    type NfcTopupMembershipFeeStage,
} from '../MemberCard'
import { CONET_RPC_URL } from '../chainAddresses'
import {
	exchangeStripeConnectOAuthCode,
	getStripeConnectClientId,
	getStripeConnectRedirectUri,
} from './stripeBeamio'

const APP_BASE_URL = 'https://beamio.app'

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
	await createMerchantCardStripeOAuthState({
		state,
		cardAddress,
		merchantEoa,
		expiresAt: new Date(Date.now() + 10 * 60 * 1000),
	})
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
}): Promise<{ cardAddress: string; stripeAccountId: string; merchantEoa: string }> {
	if (!/^0x[0-9a-fA-F]{64}$/.test(params.state)) throw new Error('Invalid OAuth state')
	if (!params.code || params.code.length > 2048) throw new Error('Invalid OAuth code')
	const state = await consumeMerchantCardStripeOAuthState(params.state)
	if (!state) throw new Error('OAuth state is invalid, expired, or already used')
	const token = await exchangeStripeConnectOAuthCode(params.code)
	if (!token.stripe_user_id) throw new Error('Stripe OAuth did not return a connected account')
	const account = await stripeClient().accounts.retrieve(token.stripe_user_id)
	if ('deleted' in account && account.deleted) throw new Error('Connected Stripe account was deleted')
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
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
	})
	return {
		cardAddress: state.cardAddress,
		stripeAccountId: token.stripe_user_id,
		merchantEoa: state.merchantEoa,
	}
}

export async function getMerchantCardStripeStatus(cardAddressRaw: string) {
	const cardAddress = normalizeCardAddress(cardAddressRaw)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	const fulfillmentAdmins = getStripeCardFulfillmentAdminAddresses()
	const fulfillmentAdmin = fulfillmentAdmins[0] ?? null
	if (!fulfillmentAdmin) throw new Error('Stripe card fulfillment admin pool is not configured')
	if (!local?.stripeAccountId) {
		return { linked: false, cardAddress, fulfillmentAdmin, fulfillmentAdmins }
	}
	const account = await stripeClient().accounts.retrieve(local.stripeAccountId)
	if ('deleted' in account && account.deleted) {
		return { linked: false, cardAddress, fulfillmentAdmin, fulfillmentAdmins }
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
	return {
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
	}
}

export async function createMerchantCardStripeCheckoutSession(params: {
	cardAddress: string
	buyerEoa: string
	amountFiat6: string
	currency: string
	kind: 'topup' | 'membership'
	membershipTierIndex?: number
	membershipFeeFiat6?: string
	businessIdempotencyKey?: string
}): Promise<{ sessionId: string; url: string }> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const buyerEoa = normalizeEoa(params.buyerEoa)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (!local?.stripeAccountId || !local.chargesEnabled || !local.detailsSubmitted) {
		throw new Error('Merchant Stripe account is not ready')
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
	const session = await stripe.checkout.sessions.create({
		mode: 'payment',
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
		},
		success_url: `${APP_BASE_URL}/app/stripe-payment-return?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${APP_BASE_URL}/app/stripe-payment-return?cancelled=1`,
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

export async function pollMerchantCardStripeSession(sessionId: string) {
	if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error('Invalid sessionId')
	const session = await stripeClient().checkout.sessions.retrieve(sessionId)
	const paid = session.payment_status === 'paid'
	const local = await getMerchantCardStripeSessionStatus(sessionId)
    if (session.status === 'expired') {
        await updateMerchantCardStripeSession({ sessionId, status: 'failed', lastError: 'Stripe Checkout session expired' })
    }
	return {
		sessionId: session.id,
		status: paid ? 'succeeded' : session.status === 'expired' ? 'failed' : 'pending',
		paymentStatus: session.payment_status,
		fulfillmentStatus: local?.fulfillmentStatus ?? (paid ? 'payment_succeeded' : 'payment_pending'),
		txHash: local?.txHash ?? null,
		error: local?.lastError ?? null,
		url: session.url ?? null,
	}
}

/** Fulfill one paid Checkout session exactly once through ExecuteForAdmin. */
export async function fulfillMerchantCardStripeSession(sessionId: string): Promise<void> {
    const stripe = stripeClient()
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.payment_status !== 'paid') return
    const meta = session.metadata ?? {}
    if (meta.product !== 'merchantCardStripe') return
    if (!['topup', 'membership'].includes(meta.kind ?? '')) throw new Error('Invalid merchantCardStripe kind')
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
	// Claim before changing any status. A duplicate webhook must observe
	// fulfillment_succeeded/processing and stop here; otherwise updating the
	// row to payment_succeeded first could reopen an already minted payment.
	if (!(await claimMerchantCardStripeSession(sessionId))) return
	await updateMerchantCardStripeSession({
		sessionId,
		status: 'succeeded',
		fulfillmentStatus: 'payment_succeeded',
		paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
	})
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
            void updateMerchantCardStripeSession({
                sessionId,
                status: 'failed',
                fulfillmentStatus: 'fulfillment_failed',
                lastError: error?.message ?? String(error),
            })
        })
    } catch (error: any) {
        await updateMerchantCardStripeSession({
            sessionId,
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
	const sessionId = event.type.startsWith('checkout.session.') ? eventObject?.id ?? null : null
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
