/**
 * StripeBeamio — 唯一现役 Stripe 账号 + 唯一 webhook 验签。
 * Merchant Kit Checkout 与 Consumer Onramp 共用；履约必须分轨。
 * 禁止读 `stripe_SecretKey` / `STRIPE_WEBHOOK_SECRET_EOA_USDC`。
 */
import Stripe from 'stripe'
import { masterSetup } from '../util'

export function getStripeBeamioSecretKey(): string {
	const setup = masterSetup as { StripeBeamio?: string }
	return (
		(typeof process !== 'undefined' && process.env?.STRIPE_SECRET_KEY?.trim()) ||
		setup.StripeBeamio?.trim() ||
		''
	)
}

export function getStripeBeamioWebhookSecret(): string {
	const setup = masterSetup as { STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?: string }
	return (
		(typeof process !== 'undefined' && process.env?.STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?.trim()) ||
		setup.STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?.trim() ||
		''
	)
}

export function getStripeBeamioClient(): Stripe | null {
	const key = getStripeBeamioSecretKey()
	if (!key) return null
	return new Stripe(key)
}

export function constructStripeBeamioEvent(
	rawBody: Buffer,
	sigHeader: string | string[] | undefined
): { ok: true; event: Stripe.Event } | { ok: false; error: string } {
	const whSecret = getStripeBeamioWebhookSecret()
	if (!whSecret) {
		return { ok: false, error: 'STRIPE_WEBHOOK_SECRET_MERCHANT_KIT not configured' }
	}
	const stripe = getStripeBeamioClient()
	if (!stripe) {
		return { ok: false, error: 'Stripe client not configured' }
	}
	const sig = typeof sigHeader === 'string' ? sigHeader : sigHeader?.[0] ?? ''
	try {
		return { ok: true, event: stripe.webhooks.constructEvent(rawBody, sig, whSecret) }
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		return { ok: false, error: msg }
	}
}
