/**
 * 唯一现役 Stripe webhook：`POST /api/stripeBeamioHook`。
 * 验签一次后按 event.type / metadata.product 分流：
 * Onramp → eoaUsdc；Checkout fuelPack → Fuel Pack；其余 Checkout → Merchant Kit。
 * 履约禁止交叉。
 */
import type Stripe from 'stripe'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { constructStripeBeamioEvent } from './stripeBeamio'
import { processEoaUsdcStripeEvent } from './eoaUsdcStripe'
import { processMerchantKitStripeEvent } from './merchantKitStripe'
import { processFuelPackStripeEvent } from './fuelPackStripe'

export async function handleStripeBeamioWebhook(
	rawBody: Buffer,
	sigHeader: string | string[] | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
	logger(
		Colors.cyan('[stripeBeamioHook] inbound'),
		`bytes=${rawBody.length}`,
		`stripe-signature=${Boolean(sigHeader && (typeof sigHeader === 'string' ? sigHeader : sigHeader[0]))}`
	)

	const constructed = constructStripeBeamioEvent(rawBody, sigHeader)
	if (!constructed.ok) {
		logger(Colors.red('[stripeBeamioHook] constructEvent FAILED'), constructed.error)
		return constructed
	}
	const { event } = constructed
	logger(
		Colors.green('[stripeBeamioHook] verified'),
		`id=${event.id}`,
		`type=${event.type}`,
		`livemode=${event.livemode}`
	)

	if (event.type.startsWith('crypto.onramp_session')) {
		return processEoaUsdcStripeEvent(event)
	}
	if (event.type.startsWith('checkout.session.')) {
		const product = (event.data?.object as Stripe.Checkout.Session | undefined)?.metadata?.product
		if (product === 'fuelPack') {
			return processFuelPackStripeEvent(event)
		}
		return processMerchantKitStripeEvent(event)
	}

	logger(Colors.grey(`[stripeBeamioHook] unhandled event type (ignored): ${event.type}`))
	return { ok: true }
}
