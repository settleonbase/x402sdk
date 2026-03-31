/**
 * Merchant kit (Standard / Custom program) — Stripe Checkout + webhook + poll.
 * Pattern inspired by CoNET paymentHook payment_waiting_status + checkout sessions.
 */
import Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { masterSetup } from '../util'
import { logger } from '../logger'

export const MERCHANT_KIT_PACKAGES = {
	standard_kit: {
		name: 'Standard Program Kit',
		cadCents: 6900,
		description: '2,000 B-Units included — VERRA generic NFC program',
	},
	custom_kit: {
		name: 'Custom Program Kit',
		cadCents: 13900,
		description: '5,000 B-Units included — custom design program',
	},
} as const

export type MerchantKitPackageType = keyof typeof MERCHANT_KIT_PACKAGES

type SessionRecord = {
	status: 'pending' | 'succeeded' | 'failed'
	eoaAddress: string
	packageType: string
	createdAt: number
	lastEvent?: string
}

const sessions = new Map<string, SessionRecord>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function pruneMerchantKitSessions() {
	const now = Date.now()
	for (const [id, rec] of sessions) {
		if (now - rec.createdAt > SESSION_TTL_MS) sessions.delete(id)
	}
}

setInterval(pruneMerchantKitSessions, 60 * 60 * 1000).unref?.()

function getStripeSecretKey(): string {
	const setup = masterSetup as { stripe_SecretKey?: string }
	return (
		(typeof process !== 'undefined' && process.env?.STRIPE_SECRET_KEY?.trim()) ||
		setup.stripe_SecretKey?.trim() ||
		''
	)
}

function getWebhookSecret(): string {
	const setup = masterSetup as {
		STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?: string
	}
	return (
		(typeof process !== 'undefined' && process.env?.STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?.trim()) ||
		setup.STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?.trim() ||
		''
	)
}

function getStripeClient(): Stripe | null {
	const key = getStripeSecretKey()
	if (!key) return null
	return new Stripe(key)
}

/** Return base for Stripe redirects (no trailing slash). bizSite CRA `homepage` is `/biz`. */
function getMerchantKitStripeReturnBase(): string {
	const env =
		(typeof process !== 'undefined' && process.env?.MERCHANT_KIT_STRIPE_RETURN_BASE?.trim()) || ''
	return env.replace(/\/$/, '') || 'https://beamio.app/biz'
}

export function merchantKitStripeSuccessUrl(): string {
	return `${getMerchantKitStripeReturnBase()}/native-pos?merchant_kit_stripe=success&session_id={CHECKOUT_SESSION_ID}`
}

export function merchantKitStripeCancelUrl(): string {
	return `${getMerchantKitStripeReturnBase()}/native-pos?merchant_kit_stripe=cancel`
}

export async function createMerchantKitCheckoutSession(
	eoaAddress: string,
	packageType: string
): Promise<{ sessionId: string; url: string } | { error: string }> {
	let eoa: string
	try {
		eoa = ethers.getAddress(eoaAddress)
	} catch {
		return { error: 'Invalid wallet address' }
	}
	if (!(packageType in MERCHANT_KIT_PACKAGES)) {
		return { error: 'Invalid package type' }
	}
	const stripe = getStripeClient()
	if (!stripe) {
		return { error: 'Stripe is not configured' }
	}
	const pkg = MERCHANT_KIT_PACKAGES[packageType as MerchantKitPackageType]
	const eoaLower = eoa.toLowerCase()

	const idempotencyKey = `merchant-kit-${eoaLower}-${packageType}-${randomUUID()}`

	const session = await stripe.checkout.sessions.create(
		{
			mode: 'payment',
			metadata: {
				eoaAddress: eoaLower,
				packageType,
			},
			line_items: [
				{
					price_data: {
						currency: 'cad',
						unit_amount: pkg.cadCents,
						product_data: {
							name: pkg.name,
							description: pkg.description,
						},
					},
					quantity: 1,
				},
			],
			payment_intent_data: {
				metadata: {
					eoaAddress: eoaLower,
					packageType,
				},
			},
			success_url: merchantKitStripeSuccessUrl(),
			cancel_url: merchantKitStripeCancelUrl(),
		},
		{ idempotencyKey }
	)

	if (!session.id || !session.url) {
		return { error: 'Checkout session creation failed' }
	}

	sessions.set(session.id, {
		status: 'pending',
		eoaAddress: eoaLower,
		packageType,
		createdAt: Date.now(),
	})

	return { sessionId: session.id, url: session.url }
}

export function getMerchantKitSessionStatus(sessionId: string): SessionRecord | null {
	return sessions.get(sessionId) ?? null
}

/** Best-effort sync when webhook is delayed or missed. */
export async function refreshMerchantKitSessionFromStripe(sessionId: string): Promise<void> {
	const stripe = getStripeClient()
	if (!stripe) return
	const rec_ = sessions.get(sessionId)
	if (rec_?.status !== 'pending') return
	try {
		const s = await stripe.checkout.sessions.retrieve(sessionId)
		if (s.status === 'complete' && s.payment_status === 'paid') {
			sessions.set(sessionId, {
				...rec_,
				status: 'succeeded',
				lastEvent: 'retrieve.paid',
			})
			return
		}
		if (s.status === 'expired') {
			sessions.set(sessionId, {
				...rec_,
				status: 'failed',
				lastEvent: 'expired',
			})
		}
	} catch (err: unknown) {
		logger(Colors.yellow(`[merchantKitStripe] retrieve session ${sessionId}:`), err)
	}
}

function applySessionOutcome(
	sessionId: string,
	status: 'succeeded' | 'failed',
	meta: { eoaAddress?: string; packageType?: string; lastEvent: string }
) {
	const prev = sessions.get(sessionId)
	const eoa = meta.eoaAddress ?? prev?.eoaAddress ?? ''
	const packageType = meta.packageType ?? prev?.packageType ?? ''
	const createdAt = prev?.createdAt ?? Date.now()
	sessions.set(sessionId, {
		status,
		eoaAddress: eoa,
		packageType,
		createdAt,
		lastEvent: meta.lastEvent,
	})
}

export async function handleMerchantKitStripeWebhook(
	rawBody: Buffer,
	sigHeader: string | string[] | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
	const whSecret = getWebhookSecret()
	if (!whSecret) {
		return { ok: false, error: 'STRIPE_WEBHOOK_SECRET_MERCHANT_KIT not configured' }
	}
	const stripe = getStripeClient()
	if (!stripe) {
		return { ok: false, error: 'Stripe client not configured' }
	}
	const sig = typeof sigHeader === 'string' ? sigHeader : sigHeader?.[0] ?? ''
	let event: Stripe.Event
	try {
		event = stripe.webhooks.constructEvent(rawBody, sig, whSecret)
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		return { ok: false, error: msg }
	}

	switch (event.type) {
		case 'checkout.session.completed': {
			const session = event.data.object as Stripe.Checkout.Session
			if (session.payment_status === 'paid') {
				applySessionOutcome(session.id, 'succeeded', {
					eoaAddress: session.metadata?.eoaAddress,
					packageType: session.metadata?.packageType,
					lastEvent: event.type,
				})
				logger(Colors.green(`[merchantKitStripe] paid session=${session.id} pkg=${session.metadata?.packageType}`))
			}
			break
		}
		case 'checkout.session.async_payment_failed': {
			const session = event.data.object as Stripe.Checkout.Session
			applySessionOutcome(session.id, 'failed', {
				eoaAddress: session.metadata?.eoaAddress,
				packageType: session.metadata?.packageType,
				lastEvent: event.type,
			})
			logger(Colors.yellow(`[merchantKitStripe] async_payment_failed session=${session.id}`))
			break
		}
		case 'checkout.session.expired': {
			const session = event.data.object as Stripe.Checkout.Session
			applySessionOutcome(session.id, 'failed', {
				eoaAddress: session.metadata?.eoaAddress,
				packageType: session.metadata?.packageType,
				lastEvent: event.type,
			})
			break
		}
		default:
			break
	}

	return { ok: true }
}
