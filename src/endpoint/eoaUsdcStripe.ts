/**
 * Stripe Crypto Onramp → Stripe 把 Base 原生 USDC 直接转到用户 EOA。
 * 禁止 Beamio settle 钱包库存 `USDC.transfer`；禁止改 walletDeposit / Merchant Kit。
 * Cluster 预检后转发；会话 map 仅 Master 单进程持有。
 */
import Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { resolveStripeOnrampRecipientEoa } from '../stripeWalletEoaResolve'
import { getStripeBeamioClient, getStripeBeamioSecretKey } from './stripeBeamio'

export const EOA_USDC_STRIPE_PRODUCT = 'eoaUsdc'

/** 1 USDC = 1_000_000（6 位） */
export const EOA_USDC_STRIPE_MIN_USDC6 = 1_000_000n
/** 安全上限 10,000 USDC */
export const EOA_USDC_STRIPE_MAX_USDC6 = 10_000_000_000n
/** Stripe 以分为单位：1 cent = 10_000（6 位） */
export const EOA_USDC_STRIPE_CENTS_UNIT = 10_000n

const STRIPE_API_BASE = 'https://api.stripe.com'

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

type StripeOnrampSession = {
	id: string
	object?: string
	status?: string
	redirect_url?: string
	created?: number
	metadata?: Record<string, string>
	transaction_details?: {
		transaction_id?: string
		wallet_address?: string
		destination_amount?: string
		destination_currency?: string
		destination_network?: string
	}
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

function amountUsdc6ToUsdSourceAmount(amountUsdc6: bigint): string {
	const cents = amountUsdc6 / EOA_USDC_STRIPE_CENTS_UNIT
	const dollars = cents / 100n
	const rem = cents % 100n
	return `${dollars.toString()}.${rem.toString().padStart(2, '0')}`
}

function getStripeSecretKey(): string {
	return getStripeBeamioSecretKey()
}

function getStripeClient(): Stripe | null {
	return getStripeBeamioClient()
}

function stripeErrorMessage(payload: unknown, fallback: string): string {
	if (payload && typeof payload === 'object') {
		const err = (payload as { error?: { message?: unknown }; message?: unknown }).error
		const nested = typeof err?.message === 'string' ? err.message.trim() : ''
		if (nested) return nested
		const top = (payload as { message?: unknown }).message
		if (typeof top === 'string' && top.trim()) return top.trim()
	}
	return fallback
}

function flattenStripeForm(value: unknown, prefix = '', out = new URLSearchParams()): URLSearchParams {
	if (value === undefined || value === null) return out
	if (Array.isArray(value)) {
		value.forEach((item, i) => flattenStripeForm(item, `${prefix}[${i}]`, out))
		return out
	}
	if (typeof value === 'object') {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			flattenStripeForm(v, prefix ? `${prefix}[${k}]` : k, out)
		}
		return out
	}
	if (!prefix) return out
	out.append(prefix, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value))
	return out
}

async function stripeCryptoHttp(
	method: 'GET' | 'POST',
	path: string,
	params?: Record<string, unknown>,
	idempotencyKey?: string
): Promise<Record<string, unknown>> {
	const key = getStripeSecretKey()
	if (!key) {
		throw new Error('Stripe is not configured')
	}
	const url = new URL(`${STRIPE_API_BASE}${path}`)
	const headers: Record<string, string> = {
		Authorization: `Bearer ${key}`,
	}
	if (idempotencyKey) {
		headers['Idempotency-Key'] = idempotencyKey
	}
	let body: string | undefined
	if (method === 'GET' && params) {
		const form = flattenStripeForm(params)
		form.forEach((v, k) => url.searchParams.append(k, v))
	} else if (method === 'POST') {
		headers['Content-Type'] = 'application/x-www-form-urlencoded'
		body = params ? flattenStripeForm(params).toString() : ''
	}
	const res = await fetch(url, { method, headers, body })
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
	if (!res.ok) {
		throw new Error(stripeErrorMessage(json, `Stripe request failed (${res.status})`))
	}
	return json
}

function asOnrampSession(raw: unknown): StripeOnrampSession | null {
	if (!raw || typeof raw !== 'object') return null
	const obj = raw as Record<string, unknown>
	const id = typeof obj.id === 'string' ? obj.id.trim() : ''
	if (!id) return null
	const metadata =
		obj.metadata && typeof obj.metadata === 'object'
			? Object.fromEntries(
					Object.entries(obj.metadata as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
				)
			: undefined
	const details = obj.transaction_details && typeof obj.transaction_details === 'object'
		? (obj.transaction_details as Record<string, unknown>)
		: undefined
	return {
		id,
		object: typeof obj.object === 'string' ? obj.object : undefined,
		status: typeof obj.status === 'string' ? obj.status : undefined,
		redirect_url: typeof obj.redirect_url === 'string' ? obj.redirect_url : undefined,
		created: typeof obj.created === 'number' ? obj.created : undefined,
		metadata,
		transaction_details: details
			? {
					transaction_id: typeof details.transaction_id === 'string' ? details.transaction_id : undefined,
					wallet_address: typeof details.wallet_address === 'string' ? details.wallet_address : undefined,
					destination_amount:
						typeof details.destination_amount === 'string' ? details.destination_amount : undefined,
					destination_currency:
						typeof details.destination_currency === 'string' ? details.destination_currency : undefined,
					destination_network:
						typeof details.destination_network === 'string' ? details.destination_network : undefined,
				}
			: undefined,
	}
}

function parseOnchainTxHash(raw: unknown): string | undefined {
	const s = typeof raw === 'string' ? raw.trim() : ''
	return /^0x[0-9a-fA-F]{64}$/.test(s) ? s : undefined
}

function mapOnrampStatus(stripeStatus: string | undefined): 'pending' | 'succeeded' | 'failed' {
	const s = (stripeStatus ?? '').trim().toLowerCase()
	if (s === 'fulfillment_complete') return 'succeeded'
	if (s === 'rejected') return 'failed'
	return 'pending'
}

function isOnrampOpenUnpaid(stripeStatus: string | undefined): boolean {
	const s = (stripeStatus ?? '').trim().toLowerCase()
	return s === 'initialized' || s === 'requires_payment' || s === ''
}

async function retrieveStripeOnrampSession(sessionId: string): Promise<StripeOnrampSession | null> {
	const stripe = getStripeClient()
	const cryptoApi = stripe
		? ((stripe as unknown as { crypto?: { onrampSessions?: { retrieve?: (id: string) => Promise<unknown> } } })
				.crypto?.onrampSessions)
		: undefined
	try {
		if (cryptoApi?.retrieve) {
			return asOnrampSession(await cryptoApi.retrieve(sessionId))
		}
		return asOnrampSession(await stripeCryptoHttp('GET', `/v1/crypto/onramp_sessions/${encodeURIComponent(sessionId)}`))
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		logger(Colors.yellow('[eoaUsdcStripe] onramp retrieve failed'), sessionId, msg)
		return null
	}
}

function stripeThrownMessage(err: unknown): string {
	if (err && typeof err === 'object') {
		const o = err as { message?: unknown; raw?: { message?: unknown } }
		if (typeof o.message === 'string' && o.message.trim()) return o.message.trim()
		if (typeof o.raw?.message === 'string' && o.raw.message.trim()) return o.raw.message.trim()
	}
	return err instanceof Error ? err.message : String(err)
}

function isStripeWalletAddressParamUnknownError(err: unknown): boolean {
	const msg = stripeThrownMessage(err).toLowerCase()
	const code =
		err && typeof err === 'object' ? String((err as { code?: unknown }).code ?? '').toLowerCase() : ''
	const param =
		err && typeof err === 'object' ? String((err as { param?: unknown }).param ?? '').toLowerCase() : ''
	const mentionsWallet = msg.includes('wallet_address') || param.includes('wallet_address')
	const unknown =
		code === 'parameter_unknown' ||
		msg.includes('unknown parameter') ||
		msg.includes('parameter_unknown')
	return mentionsWallet && unknown
}

async function createStripeOnrampSession(
	params: Record<string, unknown>,
	idempotencyKey: string
): Promise<StripeOnrampSession> {
	const stripe = getStripeClient()
	const cryptoApi = stripe
		? ((stripe as unknown as {
				crypto?: { onrampSessions?: { create?: (body: unknown, opts?: unknown) => Promise<unknown> } }
			}).crypto?.onrampSessions)
		: undefined
	if (cryptoApi?.create) {
		const created = asOnrampSession(await cryptoApi.create(params, { idempotencyKey }))
		if (!created) throw new Error('Stripe Onramp session creation failed')
		return created
	}
	const created = asOnrampSession(
		await stripeCryptoHttp('POST', '/v1/crypto/onramp_sessions', params, idempotencyKey)
	)
	if (!created) throw new Error('Stripe Onramp session creation failed')
	return created
}

function applyOnrampSessionToLocal(
	session: StripeOnrampSession,
	opts?: { lastEvent?: string; treatOpenUnpaidAsAbandoned?: boolean }
): SessionRecord | null {
	const meta = session.metadata ?? {}
	if (meta.product && meta.product !== EOA_USDC_STRIPE_PRODUCT) {
		return null
	}
	const prev = sessions.get(session.id)
	const walletNorm = (meta.walletAddress || prev?.walletAddress || '').toLowerCase()
	const amountNorm = meta.amountUsdc6 || prev?.amountUsdc6 || ''
	if (!walletNorm || !amountNorm) {
		return null
	}
	const createdAt =
		prev?.createdAt ??
		(typeof session.created === 'number' && session.created > 0 ? session.created * 1000 : Date.now())
	const stripeStatus = session.status ?? ''
	let status = mapOnrampStatus(stripeStatus)
	let lastEvent = opts?.lastEvent || stripeStatus || prev?.lastEvent
	if (opts?.treatOpenUnpaidAsAbandoned && isOnrampOpenUnpaid(stripeStatus) && status === 'pending') {
		status = 'failed'
		lastEvent = 'abandoned'
	}
	if (prev?.status === 'succeeded' && status !== 'succeeded') {
		status = 'succeeded'
		lastEvent = prev.lastEvent
	}
	const txHash =
		parseOnchainTxHash(session.transaction_details?.transaction_id) || prev?.chainFulfillment?.usdcTxHash
	const recipientFromMeta = meta.recipientEoa?.trim()
	const recipientFromTx = session.transaction_details?.wallet_address?.trim()
	let recipientEoa = prev?.chainFulfillment?.recipientEoa
	for (const cand of [recipientFromMeta, recipientFromTx]) {
		if (cand && ethers.isAddress(cand)) {
			recipientEoa = ethers.getAddress(cand)
			break
		}
	}
	const next: SessionRecord = {
		status,
		walletAddress: walletNorm,
		amountUsdc6: amountNorm,
		createdAt,
		lastEvent,
		chainFulfillment: {
			...prev?.chainFulfillment,
			...(recipientEoa ? { recipientEoa } : {}),
			...(txHash ? { usdcTxHash: txHash, lastError: undefined } : {}),
		},
	}
	sessions.set(session.id, next)
	return next
}

function markRetiredCheckoutSession(sessionId: string): SessionRecord | null {
	const prev = sessions.get(sessionId)
	if (!prev) return null
	if (prev.status === 'succeeded') return prev
	const next: SessionRecord = {
		...prev,
		status: 'failed',
		lastEvent: 'retired.checkout.session',
		chainFulfillment: {
			...prev.chainFulfillment,
			lastError: 'This session used the retired card checkout. Start a new Stripe USDC deposit.',
		},
	}
	sessions.set(sessionId, next)
	return next
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
	if (!getStripeSecretKey()) {
		return { error: 'Stripe is not configured' }
	}

	/** Do not await Base RPC here — CoNET `base-rpc` lag must not block Opening Stripe. */
	let recipientEoa: string
	try {
		recipientEoa = await resolveStripeOnrampRecipientEoa(wallet)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		logger(Colors.yellow('[eoaUsdcStripe] resolve EOA failed; using submitted address'), msg)
		recipientEoa = wallet
	}
	if (recipientEoa.toLowerCase() !== wallet.toLowerCase()) {
		logger(
			Colors.cyan('[eoaUsdcStripe] create: submitted wallet is AA; locking Onramp to EOA'),
			wallet,
			'→',
			recipientEoa
		)
	}

	const walletLower = wallet.toLowerCase()
	const amountUsdc6 = parsed.amount.toString()
	const sourceAmount = amountUsdc6ToUsdSourceAmount(parsed.amount)
	const idempotencyKey = `eoa-usdc-onramp-${walletLower}-${amountUsdc6}-${randomUUID()}`

	const onrampBase = {
		destination_networks: ['base'],
		destination_network: 'base',
		destination_currencies: ['usdc'],
		destination_currency: 'usdc',
		lock_wallet_address: true,
		source_amount: sourceAmount,
		source_currency: 'usd',
		metadata: {
			product: EOA_USDC_STRIPE_PRODUCT,
			walletAddress: walletLower,
			amountUsdc6,
			recipientEoa,
		},
	}

	/** This Stripe account rejects `wallet_addresses[base]`. Lock EOA with `wallet_address`. */
	let session: StripeOnrampSession
	try {
		session = await createStripeOnrampSession(
			{ ...onrampBase, wallet_address: recipientEoa },
			idempotencyKey
		)
	} catch (err: unknown) {
		const msg = stripeThrownMessage(err)
		if (!isStripeWalletAddressParamUnknownError(err)) {
			logger(Colors.red('[eoaUsdcStripe] onramp create failed'), msg)
			return { error: msg || 'Could not start Stripe USDC deposit' }
		}
		logger(
			Colors.yellow('[eoaUsdcStripe] wallet_address unknown; retry wallet_addresses[base_network]'),
			recipientEoa
		)
		try {
			session = await createStripeOnrampSession(
				{ ...onrampBase, wallet_addresses: { base_network: recipientEoa } },
				`${idempotencyKey}-wan`
			)
		} catch (retryErr: unknown) {
			const retryMsg = stripeThrownMessage(retryErr)
			logger(Colors.red('[eoaUsdcStripe] onramp create failed'), retryMsg)
			return { error: retryMsg || 'Could not start Stripe USDC deposit' }
		}
	}

	if (!session.id || !session.redirect_url) {
		return { error: 'Stripe Onramp session creation failed' }
	}

	sessions.set(session.id, {
		status: 'pending',
		walletAddress: walletLower,
		amountUsdc6,
		createdAt: Date.now(),
		lastEvent: session.status || 'initialized',
		chainFulfillment: { recipientEoa },
	})

	logger(
		Colors.green('[eoaUsdcStripe] createSession ok'),
		`session=${session.id}`,
		`sourceUsd=${sourceAmount}`,
		`eoa=${recipientEoa.slice(0, 10)}…`
	)

	return { sessionId: session.id, url: session.redirect_url }
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
	if (sessionId.startsWith('cs_')) {
		const retired = markRetiredCheckoutSession(sessionId)
		eoaUsdcDbg('refresh retired checkout session', sessionId, retired?.status ?? '(unknown)')
		return
	}
	const rec = sessions.get(sessionId)
	if (rec?.status === 'succeeded' && rec.chainFulfillment?.usdcTxHash) {
		eoaUsdcDbg('refresh skip (already complete)', sessionId)
		return
	}
	const remote = await retrieveStripeOnrampSession(sessionId)
	if (!remote) {
		eoaUsdcDbg('refresh miss', sessionId)
		return
	}
	const next = applyOnrampSessionToLocal(remote, {
		lastEvent: remote.status || 'retrieve',
		treatOpenUnpaidAsAbandoned: options?.treatOpenUnpaidAsAbandoned,
	})
	if (next) {
		eoaUsdcDbg('refresh', sessionId, `stripe=${remote.status}`, `local=${next.status}`)
	}
}

export function processEoaUsdcStripeEvent(
	event: Stripe.Event
): { ok: true } | { ok: false; error: string } {
	if (event.type.startsWith('checkout.session.')) {
		logger(Colors.grey('[eoaUsdcStripe:hook] ignore retired Checkout event'), event.type)
		return { ok: true }
	}
	if (!event.type.startsWith('crypto.onramp_session')) {
		logger(Colors.grey(`[eoaUsdcStripe:hook] unhandled event type (ignored): ${event.type}`))
		return { ok: true }
	}

	const session = asOnrampSession(event.data?.object)
	if (!session) {
		logger(Colors.yellow('[eoaUsdcStripe:hook] onramp object missing id'))
		return { ok: true }
	}
	const product = session.metadata?.product
	if (product && product !== EOA_USDC_STRIPE_PRODUCT) {
		logger(Colors.grey(`[eoaUsdcStripe:hook] ignore other product=${product}`))
		return { ok: true }
	}

	const next = applyOnrampSessionToLocal(session, { lastEvent: event.type })
	logger(
		Colors.cyan('[eoaUsdcStripe:hook] onramp'),
		`session=${session.id}`,
		`stripe=${session.status ?? '?'}`,
		`local=${next?.status ?? 'ignored'}`,
		`tx=${next?.chainFulfillment?.usdcTxHash ?? 'none'}`
	)
	return { ok: true }
}
