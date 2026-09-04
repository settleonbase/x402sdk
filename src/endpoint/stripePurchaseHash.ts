/**
 * Stripe Checkout → on-chain mintForUsdcPurchase baseTxHash.
 * Prefer payment_intent (pi_…); fall back to checkout session id (cs_…).
 * Persist the chosen id on the session record so retries never flip PI ↔ session.
 */
import { ethers } from 'ethers'

export type StripeCheckoutPaymentSource = {
	id?: string | null
	payment_intent?: string | { id?: string | null } | null
}

/** Stripe payment code used as hash material (PI preferred). */
export function extractStripeCheckoutPaymentId(session: StripeCheckoutPaymentSource, fallbackSessionId?: string): string {
	const pi = session.payment_intent
	if (typeof pi === 'string' && pi.trim()) return pi.trim()
	if (pi && typeof pi === 'object' && typeof pi.id === 'string' && pi.id.trim()) return pi.id.trim()
	const sid =
		(typeof session.id === 'string' && session.id.trim()) ||
		(typeof fallbackSessionId === 'string' && fallbackSessionId.trim()) ||
		''
	if (!sid) throw new Error('missing Stripe checkout session / payment_intent id')
	return sid
}

/** Fuel Pack: namespaced so kit / other flows cannot collide. */
export function fuelPackStripePurchaseHash(paymentId: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(`fuelPackStripe:${paymentId}`))
}

/**
 * Merchant Kit: keccak(paymentId). Historical mints used checkout session id;
 * new mints prefer payment_intent when available (same keccak shape).
 */
export function merchantKitStripePurchaseHash(paymentId: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(paymentId))
}
