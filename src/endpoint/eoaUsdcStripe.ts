/**
 * Stripe 入金 → Base 原生 USDC 转到用户 EOA（独立于 merchantKit / walletDeposit LockMint）。
 * Cluster 预检后转发；会话 map 仅 Master 单进程持有。
 */
import Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { masterSetup } from '../util'
import { logger } from '../logger'
import { USDC_BASE } from '../chainAddresses'
import { shiftSettleBase, unshiftSettleBase } from '../settleContractPool'
import { resolveStripeMintRecipientEoaOnBase } from '../stripeWalletEoaResolve'

export const EOA_USDC_STRIPE_PRODUCT = 'eoaUsdc'

/** 1 USDC = 1_000_000（6 位） */
export const EOA_USDC_STRIPE_MIN_USDC6 = 1_000_000n
/** 安全上限 10,000 USDC */
export const EOA_USDC_STRIPE_MAX_USDC6 = 10_000_000_000n
/** Stripe 以分为单位：1 cent = 10_000（6 位） */
export const EOA_USDC_STRIPE_CENTS_UNIT = 10_000n

const USDC_TRANSFER_ABI = [
	'function transfer(address to, uint256 amount) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
] as const

export type EoaUsdcStripeChainFulfillment = {
	usdcTxHash?: string
	recipientEoa?: string
	lastError?: string
}

type SessionRecord = {
	status: 'pending' | 'succeeded' | 'failed'
	walletAddress: string
	amountUsdc6: string
	createdAt: number
	lastEvent?: string
	chainFulfillment?: EoaUsdcStripeChainFulfillment
}

const sessions = new Map<string, SessionRecord>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function pruneEoaUsdcSessions() {
	const now = Date.now()
	for (const [id, rec] of sessions) {
		if (now - rec.createdAt > SESSION_TTL_MS) sessions.delete(id)
	}
}

function scheduleEoaUsdcSessionPrune(): void {
	const t = setTimeout(() => {
		pruneEoaUsdcSessions()
		scheduleEoaUsdcSessionPrune()
	}, 60 * 60 * 1000)
	t.unref?.()
}

scheduleEoaUsdcSessionPrune()

const fulfillmentInflight = new Map<string, Promise<void>>()

function eoaUsdcStripeDebugEnabled(): boolean {
	const v = (typeof process !== 'undefined' && process.env?.EOA_USDC_STRIPE_DEBUG?.trim()?.toLowerCase()) || ''
	return v === '1' || v === 'true' || v === 'yes'
}

function eoaUsdcDbg(...args: unknown[]) {
	if (eoaUsdcStripeDebugEnabled()) {
		logger(Colors.cyan('[eoaUsdcStripe:debug]'), ...args)
	}
}

export function parseEoaUsdcStripeAmountUsdc6(raw: unknown): { ok: true; amount: bigint } | { ok: false; error: string } {
	const amountStr =
		typeof raw === 'number' && Number.isFinite(raw)
			? String(Math.trunc(raw))
			: typeof raw === 'string'
				? raw.trim()
				: ''
	if (!/^\d+$/.test(amountStr)) {
		return { ok: false, error: 'amountUsdc6 must be a positive integer string' }
	}
	const amount = BigInt(amountStr)
	if (amount < EOA_USDC_STRIPE_MIN_USDC6) {
		return { ok: false, error: 'Minimum deposit is 1 USDC' }
	}
	if (amount > EOA_USDC_STRIPE_MAX_USDC6) {
		return { ok: false, error: 'Maximum deposit is 10,000 USDC' }
	}
	if (amount % EOA_USDC_STRIPE_CENTS_UNIT !== 0n) {
		return { ok: false, error: 'amountUsdc6 must be a whole USD cent (multiple of 10000)' }
	}
	return { ok: true, amount }
}

function amountUsdc6ToUsdCents(amountUsdc6: bigint): number {
	return Number(amountUsdc6 / EOA_USDC_STRIPE_CENTS_UNIT)
}

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
		STRIPE_WEBHOOK_SECRET_EOA_USDC?: string
	}
	return (
		(typeof process !== 'undefined' && process.env?.STRIPE_WEBHOOK_SECRET_EOA_USDC?.trim()) ||
		setup.STRIPE_WEBHOOK_SECRET_EOA_USDC?.trim() ||
		''
	)
}

function getStripeClient(): Stripe | null {
	const key = getStripeSecretKey()
	if (!key) return null
	return new Stripe(key)
}

function getEoaUsdcStripeReturnBase(): string {
	const env =
		(typeof process !== 'undefined' && process.env?.EOA_USDC_STRIPE_RETURN_BASE?.trim()) || ''
	return env.replace(/\/$/, '') || 'https://beamio.app/app'
}

export function eoaUsdcStripeSuccessUrl(): string {
	return `${getEoaUsdcStripeReturnBase()}/?eoa_usdc_stripe=success&session_id={CHECKOUT_SESSION_ID}`
}

export function eoaUsdcStripeCancelUrl(): string {
	return `${getEoaUsdcStripeReturnBase()}/?eoa_usdc_stripe=cancel`
}

async function fulfillEoaUsdcStripeOnChain(sessionId: string): Promise<void> {
	let inflight = fulfillmentInflight.get(sessionId)
	if (inflight) {
		eoaUsdcDbg('fulfill join (in flight)', sessionId)
		return inflight
	}
	inflight = (async () => {
		let retryBusy = false
		const getCf = (): EoaUsdcStripeChainFulfillment => sessions.get(sessionId)?.chainFulfillment ?? {}
		const patchChainFulfillment = (patch: EoaUsdcStripeChainFulfillment) => {
			const cur = sessions.get(sessionId)
			if (!cur) {
				return
			}
			sessions.set(sessionId, {
				...cur,
				chainFulfillment: { ...cur.chainFulfillment, ...patch },
			})
		}
		try {
			const rec = sessions.get(sessionId)
			if (!rec || rec.status !== 'succeeded') {
				eoaUsdcDbg('fulfill skip (not succeeded)', sessionId, rec?.status ?? '(no record)')
				return
			}
			if (getCf().usdcTxHash) {
				eoaUsdcDbg('fulfill skip (already transferred)', sessionId, getCf().usdcTxHash)
				return
			}
			const parsed = parseEoaUsdcStripeAmountUsdc6(rec.amountUsdc6)
			if (!parsed.ok) {
				logger(Colors.red('[eoaUsdcStripe] fulfill: invalid amount'), rec.amountUsdc6, parsed.error)
				patchChainFulfillment({ lastError: parsed.error })
				return
			}
			let recipient: string
			try {
				recipient = ethers.getAddress(rec.walletAddress)
			} catch {
				logger(Colors.red('[eoaUsdcStripe] fulfill: invalid wallet'), rec.walletAddress)
				patchChainFulfillment({ lastError: 'Invalid wallet address' })
				return
			}
			recipient = await resolveStripeMintRecipientEoaOnBase(recipient)
			if (recipient.toLowerCase() !== rec.walletAddress.toLowerCase()) {
				logger(
					Colors.cyan('[eoaUsdcStripe] fulfill: wallet was AA on Base; transferring USDC to EOA'),
					rec.walletAddress,
					'→',
					recipient
				)
			}
			patchChainFulfillment({ recipientEoa: recipient, lastError: undefined })

			const SC = shiftSettleBase()
			if (!SC) {
				logger(Colors.yellow('[eoaUsdcStripe] fulfill: Base settle pool busy; retry in 3s'), sessionId)
				retryBusy = true
				return
			}
			try {
				const usdc = new ethers.Contract(USDC_BASE, USDC_TRANSFER_ABI, SC.walletBase)
				const payer = ethers.getAddress(SC.walletBase.address)
				const bal = await usdc.balanceOf(payer)
				if (bal < parsed.amount) {
					const msg = `Treasury Base USDC balance insufficient (have ${bal.toString()}, need ${parsed.amount.toString()})`
					logger(Colors.red('[eoaUsdcStripe] fulfill:'), msg)
					patchChainFulfillment({ lastError: msg })
					return
				}
				const tx = await usdc.transfer(recipient, parsed.amount)
				const receipt = await tx.wait()
				const h = receipt?.hash ?? tx.hash
				patchChainFulfillment({ usdcTxHash: h, recipientEoa: recipient, lastError: undefined })
				logger(
					Colors.green('[eoaUsdcStripe] Base USDC transfer ok'),
					`session=${sessionId}`,
					`amountUsdc6=${parsed.amount.toString()}`,
					`to=${recipient}`,
					`tx=${h}`
				)
			} finally {
				unshiftSettleBase(SC)
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e)
			logger(Colors.red('[eoaUsdcStripe] fulfill FAILED'), sessionId, msg)
			patchChainFulfillment({ lastError: msg })
		} finally {
			fulfillmentInflight.delete(sessionId)
		}
		if (retryBusy) {
			const t = setTimeout(() => {
				void fulfillEoaUsdcStripeOnChain(sessionId)
			}, 3000)
			t.unref?.()
		}
	})()
	fulfillmentInflight.set(sessionId, inflight)
	return inflight
}

export function scheduleEoaUsdcStripeChainFulfillment(sessionId: string): void {
	void fulfillEoaUsdcStripeOnChain(sessionId)
}

export async function createEoaUsdcStripeCheckoutSession(
	walletAddress: string,
	amountUsdc6Raw: unknown
): Promise<{ sessionId: string; url: string } | { error: string }> {
	let wallet: string
	try {
		wallet = ethers.getAddress(walletAddress)
	} catch {
		return { error: 'Invalid wallet address' }
	}
	const parsed = parseEoaUsdcStripeAmountUsdc6(amountUsdc6Raw)
	if (!parsed.ok) {
		return { error: parsed.error }
	}
	const stripe = getStripeClient()
	if (!stripe) {
		return { error: 'Stripe is not configured' }
	}
	const walletLower = wallet.toLowerCase()
	const amountUsdc6 = parsed.amount.toString()
	const usdCents = amountUsdc6ToUsdCents(parsed.amount)
	const usdcHuman = (Number(parsed.amount) / 1e6).toFixed(2)

	const idempotencyKey = `eoa-usdc-${walletLower}-${amountUsdc6}-${randomUUID()}`

	const session = await stripe.checkout.sessions.create(
		{
			mode: 'payment',
			metadata: {
				product: EOA_USDC_STRIPE_PRODUCT,
				walletAddress: walletLower,
				amountUsdc6,
			},
			line_items: [
				{
					price_data: {
						currency: 'usd',
						unit_amount: usdCents,
						product_data: {
							name: 'USDC on Base',
							description: `${usdcHuman} USDC transferred to your EOA on Base after payment`,
						},
					},
					quantity: 1,
				},
			],
			payment_intent_data: {
				metadata: {
					product: EOA_USDC_STRIPE_PRODUCT,
					walletAddress: walletLower,
					amountUsdc6,
				},
			},
			success_url: eoaUsdcStripeSuccessUrl(),
			cancel_url: eoaUsdcStripeCancelUrl(),
		},
		{ idempotencyKey }
	)

	if (!session.id || !session.url) {
		return { error: 'Checkout session creation failed' }
	}

	sessions.set(session.id, {
		status: 'pending',
		walletAddress: walletLower,
		amountUsdc6,
		createdAt: Date.now(),
	})

	logger(
		Colors.green('[eoaUsdcStripe] createSession ok'),
		`session=${session.id}`,
		`amountUsdc6=${amountUsdc6}`,
		`wallet=${walletLower.slice(0, 10)}…`
	)

	return { sessionId: session.id, url: session.url }
}

export function getEoaUsdcStripeSessionStatus(sessionId: string): SessionRecord | null {
	return sessions.get(sessionId) ?? null
}

export type RefreshEoaUsdcStripeSessionOptions = {
	treatOpenUnpaidAsAbandoned?: boolean
}

export async function refreshEoaUsdcStripeSessionFromStripe(
	sessionId: string,
	options?: RefreshEoaUsdcStripeSessionOptions
): Promise<void> {
	const stripe = getStripeClient()
	if (!stripe) return
	const rec_ = sessions.get(sessionId)
	if (rec_?.status !== 'pending') {
		if (rec_?.status === 'succeeded' && !rec_.chainFulfillment?.usdcTxHash) {
			scheduleEoaUsdcStripeChainFulfillment(sessionId)
		}
		eoaUsdcDbg('refresh skip (not pending)', sessionId, 'local=', rec_?.status ?? '(no record)')
		return
	}
	try {
		const s = await stripe.checkout.sessions.retrieve(sessionId)
		eoaUsdcDbg(
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
			logger(Colors.green('[eoaUsdcStripe] refresh → succeeded'), sessionId)
			scheduleEoaUsdcStripeChainFulfillment(sessionId)
			return
		}
		if (s.status === 'expired') {
			sessions.set(sessionId, {
				...rec_,
				status: 'failed',
				lastEvent: 'expired',
			})
			logger(Colors.yellow('[eoaUsdcStripe] refresh → failed (expired)'), sessionId)
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
			logger(Colors.yellow('[eoaUsdcStripe] refresh → failed (abandoned open+unpaid)'), sessionId)
		}
	} catch (err: unknown) {
		logger(Colors.yellow(`[eoaUsdcStripe] retrieve error ${sessionId}:`), err)
	}
}

function applySessionOutcome(
	sessionId: string,
	status: 'succeeded' | 'failed',
	meta: { walletAddress?: string; amountUsdc6?: string; lastEvent: string }
) {
	const prev = sessions.get(sessionId)
	const createdAt = prev?.createdAt ?? Date.now()
	const walletNorm = (meta.walletAddress ?? prev?.walletAddress ?? '').toLowerCase()
	const amountNorm = meta.amountUsdc6 ?? prev?.amountUsdc6 ?? ''
	const next: SessionRecord = {
		status,
		walletAddress: walletNorm,
		amountUsdc6: amountNorm,
		createdAt,
		lastEvent: meta.lastEvent,
		chainFulfillment: prev?.chainFulfillment,
	}
	sessions.set(sessionId, next)
	eoaUsdcDbg('applySessionOutcome', sessionId, meta.lastEvent, '→', status, `amount=${amountNorm}`)
}

export async function handleEoaUsdcStripeWebhook(
	rawBody: Buffer,
	sigHeader: string | string[] | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
	logger(
		Colors.cyan('[eoaUsdcStripe:hook] inbound'),
		`bytes=${rawBody.length}`,
		`stripe-signature=${Boolean(sigHeader && (typeof sigHeader === 'string' ? sigHeader : sigHeader[0]))}`
	)

	const whSecret = getWebhookSecret()
	if (!whSecret) {
		logger(Colors.red('[eoaUsdcStripe:hook] abort: STRIPE_WEBHOOK_SECRET_EOA_USDC / ~/.master.json missing'))
		return { ok: false, error: 'STRIPE_WEBHOOK_SECRET_EOA_USDC not configured' }
	}
	const stripe = getStripeClient()
	if (!stripe) {
		logger(Colors.red('[eoaUsdcStripe:hook] abort: Stripe API key missing'))
		return { ok: false, error: 'Stripe client not configured' }
	}
	const sig = typeof sigHeader === 'string' ? sigHeader : sigHeader?.[0] ?? ''
	let event: Stripe.Event
	try {
		event = stripe.webhooks.constructEvent(rawBody, sig, whSecret)
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red('[eoaUsdcStripe:hook] constructEvent FAILED'), msg)
		return { ok: false, error: msg }
	}

	logger(
		Colors.green('[eoaUsdcStripe:hook] verified'),
		`id=${event.id}`,
		`type=${event.type}`,
		`livemode=${event.livemode}`
	)

	const sessionObj = (event.data?.object ?? null) as Stripe.Checkout.Session | null
	const product = sessionObj?.metadata?.product
	if (product && product !== EOA_USDC_STRIPE_PRODUCT) {
		logger(Colors.grey(`[eoaUsdcStripe:hook] ignore other product=${product}`))
		return { ok: true }
	}

	switch (event.type) {
		case 'checkout.session.completed': {
			const session = event.data.object as Stripe.Checkout.Session
			const meta = session.metadata ?? {}
			logger(
				'[eoaUsdcStripe:hook] checkout.session.completed',
				`session=${session.id}`,
				`payment_status=${session.payment_status}`,
				`amountUsdc6=${meta.amountUsdc6 ?? '?'}`,
				`wallet=${meta.walletAddress ? `${String(meta.walletAddress).slice(0, 10)}…` : '?'}`
			)
			if (session.payment_status === 'paid') {
				applySessionOutcome(session.id, 'succeeded', {
					walletAddress: meta.walletAddress,
					amountUsdc6: meta.amountUsdc6,
					lastEvent: event.type,
				})
				scheduleEoaUsdcStripeChainFulfillment(session.id)
			} else {
				logger(
					Colors.yellow('[eoaUsdcStripe:hook] checkout.session.completed SKIPPED (not paid yet)'),
					`payment_status=${session.payment_status}`
				)
			}
			break
		}
		case 'checkout.session.async_payment_failed': {
			const session = event.data.object as Stripe.Checkout.Session
			applySessionOutcome(session.id, 'failed', {
				walletAddress: session.metadata?.walletAddress,
				amountUsdc6: session.metadata?.amountUsdc6,
				lastEvent: event.type,
			})
			break
		}
		case 'checkout.session.expired': {
			const session = event.data.object as Stripe.Checkout.Session
			applySessionOutcome(session.id, 'failed', {
				walletAddress: session.metadata?.walletAddress,
				amountUsdc6: session.metadata?.amountUsdc6,
				lastEvent: event.type,
			})
			break
		}
		default:
			logger(Colors.grey(`[eoaUsdcStripe:hook] unhandled event type (ignored): ${event.type}`))
			break
	}

	return { ok: true }
}
