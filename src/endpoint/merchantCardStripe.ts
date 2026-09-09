import Stripe from 'stripe'
import { ethers } from 'ethers'
import { getStripeBeamioClient, getStripeBeamioSecretKey } from './stripeBeamio'
import {
    claimMerchantCardStripeSession,
	createMerchantCardStripeSession,
	getMerchantCardStripeStatusFromDb,
    updateMerchantCardStripeAccount,
	updateMerchantCardStripeAccountById,
	updateMerchantCardStripeSession,
} from '../db'
import {
    executeForAdminPool,
    executeForAdminProcess,
    getStripeCardFulfillmentAdminAddress,
    nfcTopupPreparePayload,
    signExecuteForAdminWithStripeFulfillmentAdmin,
    type NfcTopupMembershipFeeStage,
} from '../MemberCard'
import { CONET_RPC_URL } from '../chainAddresses'

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
}> {
	const cardAddress = normalizeCardAddress(cardAddressRaw)
	const fulfillmentAdmin = getStripeCardFulfillmentAdminAddress()
	if (!fulfillmentAdmin) throw new Error('Stripe card fulfillment admin is not configured')
	const existing = await getMerchantCardStripeStatusFromDb(cardAddress)
	const stripe = stripeClient()
	const accountId =
		existing?.stripeAccountId ??
		(await stripe.accounts.create({
			type: 'express',
			capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
			metadata: { product: 'merchantCardStripe', card_address: cardAddress },
		})).id

	if (accountId !== existing?.stripeAccountId) {
		await updateMerchantCardStripeAccount({ cardAddress, stripeAccountId: accountId, stripeFulfillmentAdmin: fulfillmentAdmin })
	} else if (existing?.stripeFulfillmentAdmin !== fulfillmentAdmin) {
		await updateMerchantCardStripeAccount({ cardAddress, stripeAccountId: accountId, stripeFulfillmentAdmin: fulfillmentAdmin })
	}
	const link = await stripe.accountLinks.create({
		account: accountId,
		type: 'account_onboarding',
		refresh_url: `${APP_BASE_URL}/app/merchant-card-stripe?cardAddress=${encodeURIComponent(cardAddress)}`,
		return_url: `${APP_BASE_URL}/app/merchant-card-stripe?cardAddress=${encodeURIComponent(cardAddress)}&connected=1`,
		collect: 'eventually_due',
	})
	return { stripeAccountId: accountId, url: link.url, fulfillmentAdmin }
}

export async function getMerchantCardStripeStatus(cardAddressRaw: string) {
	const cardAddress = normalizeCardAddress(cardAddressRaw)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	const fulfillmentAdmin = getStripeCardFulfillmentAdminAddress()
	if (!fulfillmentAdmin) throw new Error('Stripe card fulfillment admin is not configured')
	if (!local?.stripeAccountId) {
		return { linked: false, cardAddress, fulfillmentAdmin }
	}
	const account = await stripeClient().accounts.retrieve(local.stripeAccountId)
	if ('deleted' in account && account.deleted) {
		return { linked: false, cardAddress, fulfillmentAdmin }
	}
	const chargesEnabled = account.charges_enabled === true
	const detailsSubmitted = account.details_submitted === true
	await updateMerchantCardStripeAccount({
		cardAddress,
		stripeAccountId: account.id,
		chargesEnabled,
		detailsSubmitted,
		stripeFulfillmentAdmin: fulfillmentAdmin,
	})
	return {
		linked: chargesEnabled && detailsSubmitted,
		cardAddress,
		stripeAccountId: account.id,
		chargesEnabled,
		detailsSubmitted,
		fulfillmentAdmin,
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
}): Promise<{ sessionId: string; url: string }> {
	const cardAddress = normalizeCardAddress(params.cardAddress)
	const buyerEoa = normalizeEoa(params.buyerEoa)
	const local = await getMerchantCardStripeStatusFromDb(cardAddress)
	if (!local?.stripeAccountId || !local.chargesEnabled || !local.detailsSubmitted) {
		throw new Error('Merchant Stripe account is not ready')
	}
	const fulfillmentAdmin = getStripeCardFulfillmentAdminAddress()
	if (!fulfillmentAdmin || local.stripeFulfillmentAdmin?.toLowerCase() !== fulfillmentAdmin.toLowerCase()) {
		throw new Error('Merchant card Stripe fulfillment admin is not linked')
	}
	const amount = stripeAmountFromFiat6(params.amountFiat6)
	const currency = normalizeStripeCurrency(params.currency)
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
		success_url: `${APP_BASE_URL}/app/stripe-payment?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${APP_BASE_URL}/app/stripe-payment?cancelled=1`,
	})
	const inserted = await createMerchantCardStripeSession({
		sessionId: session.id,
		cardAddress,
		buyerEoa,
		amountFiat6: params.amountFiat6,
		currency: params.currency,
		kind: params.kind,
		membershipTierIndex: params.membershipTierIndex,
		membershipFeeFiat6: params.membershipFeeFiat6,
	})
	if (!inserted) throw new Error('Stripe session already exists')
	return { sessionId: session.id, url: session.url ?? '' }
}

export async function pollMerchantCardStripeSession(sessionId: string) {
	if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error('Invalid sessionId')
	const session = await stripeClient().checkout.sessions.retrieve(sessionId)
	const paid = session.payment_status === 'paid'
    if (session.status === 'expired') {
        await updateMerchantCardStripeSession({ sessionId, status: 'failed', lastError: 'Stripe Checkout session expired' })
    }
	return {
		sessionId: session.id,
		status: paid ? 'succeeded' : session.status === 'expired' ? 'failed' : 'pending',
		paymentStatus: session.payment_status,
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
    if (!(await claimMerchantCardStripeSession(sessionId))) return
    try {
        const tierIndex = meta.membership_tier_index == null ? undefined : Number(meta.membership_tier_index)
        const prepared = await nfcTopupPreparePayload({
            cardAddress: meta.card_address,
            wallet: meta.buyer_eoa,
            amount: ethers.formatUnits(BigInt(meta.amount_fiat6), 6),
            currency: meta.currency,
            ...(tierIndex == null ? {} : { membershipTierIndex: tierIndex }),
            ...(meta.membership_fee_fiat6 ? { membershipFeeFiat6: meta.membership_fee_fiat6 } : {}),
        })
        if ('error' in prepared) throw new Error(prepared.error)
        const signed = await signExecuteForAdminWithStripeFulfillmentAdmin({
            cardAddr: prepared.cardAddr,
            data: prepared.data,
            deadline: prepared.deadline,
            nonce: prepared.nonce,
        })
        if ('error' in signed) throw new Error(signed.error)
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
            adminSignature: signed.adminSignature,
            topupKind: 2,
            topupFeeBUnits: 20_000_000n,
            stripeSessionId: sessionId,
            ...(membershipFeeStage ? { membershipFeeStage } : {}),
        })
        void executeForAdminProcess().catch((error) => {
            void updateMerchantCardStripeSession({
                sessionId,
                status: 'failed',
                lastError: error?.message ?? String(error),
            })
        })
    } catch (error: any) {
        await updateMerchantCardStripeSession({
            sessionId,
            status: 'failed',
            lastError: error?.message ?? String(error),
        })
        throw error
    }
}

/** Webhook dispatch target. On-chain fulfillment is intentionally a separate idempotent worker step. */
export async function processMerchantCardStripeEvent(event: Stripe.Event): Promise<{ ok: true }> {
	if (event.type.startsWith('account.')) {
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
