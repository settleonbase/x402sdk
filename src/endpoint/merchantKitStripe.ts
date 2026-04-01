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

/** Set `MERCHANT_KIT_STRIPE_DEBUG=1` (or `true`) for verbose poll/refresh logs. Webhook always logs a short summary line. */
function merchantKitStripeDebugEnabled(): boolean {
	const v = (typeof process !== 'undefined' && process.env?.MERCHANT_KIT_STRIPE_DEBUG?.trim()?.toLowerCase()) || ''
	return v === '1' || v === 'true' || v === 'yes'
}

function merchantKitDbg(...args: unknown[]) {
	if (merchantKitStripeDebugEnabled()) {
		logger(Colors.cyan('[merchantKitStripe:debug]'), ...args)
	}
}

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

/** 与 setInterval 等价的首拍延迟 1h，随后每轮结束后再排 1h（遵守 beamio-no-setinterval） */
function scheduleMerchantKitSessionPrune(): void {
	const t = setTimeout(() => {
		pruneMerchantKitSessions()
		scheduleMerchantKitSessionPrune()
	}, 60 * 60 * 1000)
	t.unref?.()
}

scheduleMerchantKitSessionPrune()

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

	logger(
		Colors.green('[merchantKitStripe] createSession ok'),
		`session=${session.id}`,
		`pkg=${packageType}`,
		`eoa=${eoaLower.slice(0, 10)}…`
	)

	return { sessionId: session.id, url: session.url }
}

export function getMerchantKitSessionStatus(sessionId: string): SessionRecord | null {
	return sessions.get(sessionId) ?? null
}

export type RefreshMerchantKitSessionOptions = {
	/** After user closes the Stripe window: treat `open` + `unpaid` as abandoned. */
	treatOpenUnpaidAsAbandoned?: boolean
}

/** Best-effort sync when webhook is delayed or missed. */
export async function refreshMerchantKitSessionFromStripe(
	sessionId: string,
	options?: RefreshMerchantKitSessionOptions
): Promise<void> {
	const stripe = getStripeClient()
	if (!stripe) return
	const rec_ = sessions.get(sessionId)
	if (rec_?.status !== 'pending') {
		merchantKitDbg('refresh skip (not pending)', sessionId, 'local=', rec_?.status ?? '(no record)')
		return
	}
	try {
		const s = await stripe.checkout.sessions.retrieve(sessionId)
		merchantKitDbg(
			'retrieve',
			sessionId,
			`checkoutStatus=${s.status}`,
			`payment_status=${s.payment_status}`,
			`abandonedFlag=${Boolean(options?.treatOpenUnpaidAsAbandoned)}`
		)
		if (s.status === 'complete' && s.payment_status === 'paid') {
			sessions.set(sessionId, {
				...rec_,
				status: 'succeeded',
				lastEvent: 'retrieve.paid',
			})
			logger(Colors.green('[merchantKitStripe] refresh → succeeded'), sessionId)
			return
		}
		if (s.status === 'expired') {
			sessions.set(sessionId, {
				...rec_,
				status: 'failed',
				lastEvent: 'expired',
			})
			logger(Colors.yellow('[merchantKitStripe] refresh → failed (expired)'), sessionId)
			return
		}
		if (
			options?.treatOpenUnpaidAsAbandoned &&
			s.status === 'open' &&
			s.payment_status === 'unpaid'
		) {
			sessions.set(sessionId, {
				...rec_,
				status: 'failed',
				lastEvent: 'abandoned',
			})
			logger(
				Colors.yellow('[merchantKitStripe] refresh → failed (abandoned open+unpaid)'),
				sessionId
			)
		}
	} catch (err: unknown) {
		logger(Colors.yellow(`[merchantKitStripe] retrieve error ${sessionId}:`), err)
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
	const next: SessionRecord = {
		status,
		eoaAddress: eoa,
		packageType,
		createdAt,
		lastEvent: meta.lastEvent,
	}
	sessions.set(sessionId, next)
	merchantKitDbg('applySessionOutcome', sessionId, meta.lastEvent, '→', status, `pkg=${packageType}`)
}

export async function handleMerchantKitStripeWebhook(
	rawBody: Buffer,
	sigHeader: string | string[] | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
	logger(
		Colors.cyan('[merchantKitStripe:hook] inbound'),
		`bytes=${rawBody.length}`,
		`stripe-signature=${Boolean(sigHeader && (typeof sigHeader === 'string' ? sigHeader : sigHeader[0]))}`
	)

	const whSecret = getWebhookSecret()
	if (!whSecret) {
		logger(Colors.red('[merchantKitStripe:hook] abort: STRIPE_WEBHOOK_SECRET_MERCHANT_KIT / ~/.master.json missing'))
		return { ok: false, error: 'STRIPE_WEBHOOK_SECRET_MERCHANT_KIT not configured' }
	}
	const stripe = getStripeClient()
	if (!stripe) {
		logger(Colors.red('[merchantKitStripe:hook] abort: Stripe API key missing'))
		return { ok: false, error: 'Stripe client not configured' }
	}
	const sig = typeof sigHeader === 'string' ? sigHeader : sigHeader?.[0] ?? ''
	let event: Stripe.Event
	try {
		event = stripe.webhooks.constructEvent(rawBody, sig, whSecret)
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red('[merchantKitStripe:hook] constructEvent FAILED'), msg)
		return { ok: false, error: msg }
	}

	logger(
		Colors.green('[merchantKitStripe:hook] verified'),
		`id=${event.id}`,
		`type=${event.type}`,
		`livemode=${event.livemode}`,
		`api_version=${event.api_version ?? '(n/a)'}`
	)

	switch (event.type) {
		case 'checkout.session.completed': {
			const session = event.data.object as Stripe.Checkout.Session
			const meta = session.metadata ?? {}
			logger(
				'[merchantKitStripe:hook] checkout.session.completed',
				`session=${session.id}`,
				`payment_status=${session.payment_status}`,
				`status=${session.status}`,
				`metadata.pkg=${meta.packageType ?? '?'}`,
				`metadata.eoa=${meta.eoaAddress ? `${String(meta.eoaAddress).slice(0, 10)}…` : '?'}`
			)
			if (session.payment_status === 'paid') {
				const hadLocal = sessions.has(session.id)
				applySessionOutcome(session.id, 'succeeded', {
					eoaAddress: session.metadata?.eoaAddress,
					packageType: session.metadata?.packageType,
					lastEvent: event.type,
				})
				logger(
					Colors.green('[merchantKitStripe:hook] → local map UPDATED succeeded'),
					`session=${session.id}`,
					`hadLocalRecord=${hadLocal}`
				)
			} else {
				logger(
					Colors.yellow('[merchantKitStripe:hook] checkout.session.completed SKIPPED (not paid yet)'),
					`payment_status=${session.payment_status}`
				)
			}
			break
		}
		case 'checkout.session.async_payment_failed': {
			const session = event.data.object as Stripe.Checkout.Session
			logger(
				Colors.yellow('[merchantKitStripe:hook] checkout.session.async_payment_failed'),
				`session=${session.id}`
			)
			applySessionOutcome(session.id, 'failed', {
				eoaAddress: session.metadata?.eoaAddress,
				packageType: session.metadata?.packageType,
				lastEvent: event.type,
			})
			break
		}
		case 'checkout.session.expired': {
			const session = event.data.object as Stripe.Checkout.Session
			logger(
				Colors.yellow('[merchantKitStripe:hook] checkout.session.expired'),
				`session=${session.id}`
			)
			applySessionOutcome(session.id, 'failed', {
				eoaAddress: session.metadata?.eoaAddress,
				packageType: session.metadata?.packageType,
				lastEvent: event.type,
			})
			break
		}
		default:
			logger(Colors.grey(`[merchantKitStripe:hook] unhandled event type (ignored): ${event.type}`))
			break
	}

	return { ok: true }
}
