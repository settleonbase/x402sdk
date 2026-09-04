/**
 * SaaS Fuel Pack — Stripe Checkout + webhook fulfill.
 * Metadata `product: 'fuelPack'` — must not cross Merchant Kit or Onramp fulfill.
 * Paid B-Units via mintForUsdcPurchase; free via mintReward; Business Start Ket #0 when missing.
 */
import Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { masterSetup, resolveBeamioConetHttpRpcUrl } from '../util'
import { logger } from '../logger'
import {
	CONET_BUINT,
	CONET_BUNIT_AIRDROP_ADDRESS,
	CONET_BUSINESS_START_KET,
} from '../chainAddresses'
import { resolveStripeMintRecipientEoaOnBase } from '../stripeWalletEoaResolve'
import { getStripeBeamioClient, getStripeBeamioSecretKey } from './stripeBeamio'
import {
	extractStripeCheckoutPaymentId,
	fuelPackStripePurchaseHash,
} from './stripePurchaseHash'
import {
	FUEL_PACK_CATALOG,
	type FuelPackCatalogEntry,
	type FuelPackId,
	fuelPackFreeBUnits6,
	fuelPackUsdc6,
	lookupFuelPack,
} from '../fuelPackCatalog'

const CONET_MAINNET_RPC_HTTP = resolveBeamioConetHttpRpcUrl()

const BUNIT_AIRDROP_MINT_FOR_USDC_PURCHASE_ABI = [
	'function mintForUsdcPurchase(address to, uint256 usdcAmount, bytes32 baseTxHash) external',
] as const

const BUNIT_REWARD_ABI = ['function mintReward(address to, uint256 amount) external'] as const

const BUSINESS_START_KET_MINT_ABI = [
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function mint(address to, uint256 id, uint256 amount, bytes data) external',
] as const

const KET_TOKEN_ID = 0n

/** Stripe Checkout line-item copy (English). Amounts from FUEL_PACK_CATALOG. */
const FUEL_PACK_STRIPE_COPY: Record<
	FuelPackId,
	{ name: string; description: string }
> = {
	genesis_starter: {
		name: 'Newcomer Genesis Pack',
		description: '2,000 B-Units total — first-time ice-breaker + Business Start Ket',
	},
	testing_waters: {
		name: 'Testing the Waters Pack',
		description: '5,145 B-Units total — SaaS fuel for digital transactions',
	},
	growth: {
		name: 'Growth Pack',
		description: '21,890 B-Units total — high-frequency clearing fuel',
	},
	enterprise: {
		name: 'Enterprise Pack',
		description: '114,885 B-Units total — Best Value SaaS fuel',
	},
	institutional: {
		name: 'Institutional Pack',
		description: '599,880 B-Units total — super-node / regional fuel',
	},
	genesis_partner: {
		name: 'Genesis Partner Pack',
		description: '500,000 B-Units total — lock multi-year clearing fuel',
	},
}

function fuelPackStripeDebugEnabled(): boolean {
	const v =
		(typeof process !== 'undefined' && process.env?.FUEL_PACK_STRIPE_DEBUG?.trim()?.toLowerCase()) ||
		''
	return v === '1' || v === 'true' || v === 'yes'
}

function fuelPackDbg(...args: unknown[]) {
	if (fuelPackStripeDebugEnabled()) {
		logger(Colors.cyan('[fuelPackStripe:debug]'), ...args)
	}
}

export type FuelPackChainFulfillment = {
	buintTxHash?: string
	freeBuintTxHash?: string
	nftTxHash?: string
	lastError?: string
}

type SessionRecord = {
	status: 'pending' | 'succeeded' | 'failed'
	eoaAddress: string
	packId: FuelPackId
	createdAt: number
	lastEvent?: string
	/** Stable Stripe payment code (pi_… or cs_…) for mint baseTxHash; set once. */
	stripePaymentId?: string
	chainFulfillment?: FuelPackChainFulfillment
}

const sessions = new Map<string, SessionRecord>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function pruneFuelPackSessions() {
	const now = Date.now()
	for (const [id, rec] of sessions) {
		if (now - rec.createdAt > SESSION_TTL_MS) sessions.delete(id)
	}
}

function scheduleFuelPackSessionPrune(): void {
	const t = setTimeout(() => {
		pruneFuelPackSessions()
		scheduleFuelPackSessionPrune()
	}, 60 * 60 * 1000)
	t.unref?.()
}

scheduleFuelPackSessionPrune()

const fuelPackFulfillmentInflight = new Map<string, Promise<void>>()

function resolveConetBusinessStartKetAddressForMint(): string | null {
	const raw =
		(typeof process !== 'undefined' && process.env.CONET_BUSINESS_START_KET?.trim()) ||
		CONET_BUSINESS_START_KET?.trim() ||
		''
	if (!raw) return null
	try {
		const a = ethers.getAddress(raw)
		return a === ethers.ZeroAddress ? null : a
	} catch {
		return null
	}
}

function usdCentsFromPack(pack: FuelPackCatalogEntry): number {
	return Math.round(pack.priceUsdc * 100)
}

/**
 * Stripe paid → mint paid B-Units + optional free reward + Business Start Ket #0 (if missing).
 * Idempotent per session; concurrent calls share one in-flight Promise.
 */
async function fulfillFuelPackStripeOnChain(sessionId: string): Promise<void> {
	let inflight = fuelPackFulfillmentInflight.get(sessionId)
	if (inflight) {
		fuelPackDbg('fulfill join (in flight)', sessionId)
		return inflight
	}
	inflight = (async () => {
		const getCf = (): FuelPackChainFulfillment => sessions.get(sessionId)?.chainFulfillment ?? {}
		const patchChainFulfillment = (patch: FuelPackChainFulfillment) => {
			const cur = sessions.get(sessionId)
			if (!cur) return
			sessions.set(sessionId, {
				...cur,
				chainFulfillment: { ...cur.chainFulfillment, ...patch },
			})
		}
		try {
			const rec = sessions.get(sessionId)
			if (!rec || rec.status !== 'succeeded') {
				fuelPackDbg('fulfill skip (not succeeded)', sessionId, rec?.status ?? '(no record)')
				return
			}
			const pack = lookupFuelPack(rec.packId)
			if (!pack) {
				logger(Colors.red('[fuelPackStripe] fulfill: unknown packId'), rec.packId)
				return
			}

			let mintRecipient: string
			try {
				mintRecipient = ethers.getAddress(rec.eoaAddress)
			} catch {
				logger(Colors.red('[fuelPackStripe] fulfill: invalid EOA'), rec.eoaAddress)
				return
			}
			mintRecipient = await resolveStripeMintRecipientEoaOnBase(mintRecipient)

			const pk = (masterSetup as { settle_contractAdmin?: string[] }).settle_contractAdmin?.[0]
			if (!pk?.trim()) {
				logger(Colors.red('[fuelPackStripe] fulfill: settle_contractAdmin[0] missing'))
				return
			}
			const pkNorm = pk.trim().startsWith('0x') ? pk.trim() : `0x${pk.trim()}`
			const provider = new ethers.JsonRpcProvider(CONET_MAINNET_RPC_HTTP)
			const signer = new ethers.Wallet(pkNorm, provider)

			const usdc6 = fuelPackUsdc6(pack)
			const free6 = fuelPackFreeBUnits6(pack)

			if (!getCf().buintTxHash) {
				let paymentId = sessions.get(sessionId)?.stripePaymentId?.trim()
				if (!paymentId) {
					const stripe = getStripeClient()
					if (!stripe) {
						logger(Colors.red('[fuelPackStripe] fulfill: Stripe client missing (need payment id)'))
						return
					}
					const s = await stripe.checkout.sessions.retrieve(sessionId, {
						expand: ['payment_intent'],
					})
					paymentId = extractStripeCheckoutPaymentId(s, sessionId)
					const cur = sessions.get(sessionId)
					if (cur) sessions.set(sessionId, { ...cur, stripePaymentId: paymentId })
				}
				const refHash = fuelPackStripePurchaseHash(paymentId)
				const airdrop = new ethers.Contract(
					CONET_BUNIT_AIRDROP_ADDRESS,
					BUNIT_AIRDROP_MINT_FOR_USDC_PURCHASE_ABI,
					signer
				)
				const tx = await airdrop.mintForUsdcPurchase(mintRecipient, usdc6, refHash)
				const receipt = await tx.wait()
				const h = receipt?.hash ?? tx.hash
				patchChainFulfillment({ buintTxHash: h, lastError: undefined })
				logger(
					Colors.green('[fuelPackStripe] mintForUsdcPurchase ok'),
					`session=${sessionId}`,
					`stripePaymentId=${paymentId}`,
					`pack=${pack.id}`,
					`paidBUnits=${pack.paidBUnits}`,
					`tx=${h}`,
					`eoa=${mintRecipient}`
				)
			}

			if (free6 > 0n && !getCf().freeBuintTxHash) {
				try {
					const bunit = new ethers.Contract(CONET_BUINT, BUNIT_REWARD_ABI, signer)
					const freeTx = await bunit.mintReward(mintRecipient, free6)
					const freeReceipt = await freeTx.wait()
					const fh = freeReceipt?.hash ?? freeTx.hash
					if (freeReceipt?.status === 1) {
						patchChainFulfillment({ freeBuintTxHash: fh, lastError: undefined })
						logger(
							Colors.green('[fuelPackStripe] mintReward free B-Units ok'),
							`session=${sessionId}`,
							`free=${pack.freeBUnits}`,
							`tx=${fh}`
						)
					} else {
						logger(Colors.yellow('[fuelPackStripe] mintReward status!=1; paid mint already confirmed'))
					}
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e)
					logger(Colors.yellow(`[fuelPackStripe] mintReward skipped: ${msg}`))
					patchChainFulfillment({ lastError: `freeMint: ${msg}` })
				}
			}

			const ketAddr = resolveConetBusinessStartKetAddressForMint()
			if (ketAddr && !getCf().nftTxHash) {
				try {
					const ket = new ethers.Contract(ketAddr, BUSINESS_START_KET_MINT_ABI, signer)
					const bal = (await ket.balanceOf(mintRecipient, KET_TOKEN_ID)) as bigint
					if (bal >= 1n) {
						patchChainFulfillment({ nftTxHash: 'skipped-already-holds', lastError: undefined })
						logger(
							Colors.cyan('[fuelPackStripe] skip Ket mint; EOA already holds #0'),
							mintRecipient
						)
					} else {
						const tx2 = await ket.mint(mintRecipient, KET_TOKEN_ID, 1n, '0x')
						const receipt2 = await tx2.wait()
						const h2 = receipt2?.hash ?? tx2.hash
						patchChainFulfillment({ nftTxHash: h2, lastError: undefined })
						logger(
							Colors.green('[fuelPackStripe] BusinessStartKet mint token #0 ok'),
							`session=${sessionId}`,
							`tx=${h2}`,
							`eoa=${mintRecipient}`
						)
					}
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e)
					logger(Colors.red('[fuelPackStripe] Ket mint FAILED'), sessionId, msg)
					patchChainFulfillment({ lastError: `ket: ${msg}` })
				}
			} else if (!ketAddr) {
				fuelPackDbg('fulfill: skip Ket (CONET_BUSINESS_START_KET unset)')
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e)
			logger(Colors.red('[fuelPackStripe] fulfill FAILED'), sessionId, msg)
			patchChainFulfillment({ lastError: msg })
		} finally {
			fuelPackFulfillmentInflight.delete(sessionId)
		}
	})()
	fuelPackFulfillmentInflight.set(sessionId, inflight)
	return inflight
}

export function scheduleFuelPackStripeChainFulfillment(sessionId: string): void {
	void fulfillFuelPackStripeOnChain(sessionId)
}

function getStripeClient(): Stripe | null {
	return getStripeBeamioClient()
}

function getFuelPackStripeReturnBase(): string {
	const env =
		(typeof process !== 'undefined' && process.env?.FUEL_PACK_STRIPE_RETURN_BASE?.trim()) ||
		(typeof process !== 'undefined' && process.env?.MERCHANT_KIT_STRIPE_RETURN_BASE?.trim()) ||
		''
	return env.replace(/\/$/, '') || 'https://beamio.app/biz'
}

export function fuelPackStripeSuccessUrl(): string {
	return `${getFuelPackStripeReturnBase()}/native-pos?fuel_pack_stripe=success&session_id={CHECKOUT_SESSION_ID}`
}

export function fuelPackStripeCancelUrl(): string {
	return `${getFuelPackStripeReturnBase()}/native-pos?fuel_pack_stripe=cancel`
}

export function isKnownFuelPackId(raw: unknown): raw is FuelPackId {
	return lookupFuelPack(raw) != null
}

/** Cluster precheck helper — pack must exist in FUEL_PACK_CATALOG. */
export function listFuelPackIdsForApi(): FuelPackId[] {
	return FUEL_PACK_CATALOG.map((p) => p.id)
}

export async function createFuelPackCheckoutSession(
	eoaAddress: string,
	packIdRaw: string
): Promise<{ sessionId: string; url: string } | { error: string }> {
	let eoa: string
	try {
		eoa = ethers.getAddress(eoaAddress)
	} catch {
		return { error: 'Invalid wallet address' }
	}
	const pack = lookupFuelPack(packIdRaw)
	if (!pack) {
		return { error: 'Invalid fuel pack' }
	}
	const stripe = getStripeClient()
	if (!stripe) {
		return { error: 'Stripe is not configured' }
	}
	const eoaLower = eoa.toLowerCase()
	const copy = FUEL_PACK_STRIPE_COPY[pack.id]
	const unitAmount = usdCentsFromPack(pack)
	if (!Number.isFinite(unitAmount) || unitAmount < 50) {
		return { error: 'Invalid pack price' }
	}

	const idempotencyKey = `fuel-pack-${eoaLower}-${pack.id}-${randomUUID()}`

	const session = await stripe.checkout.sessions.create(
		{
			mode: 'payment',
			metadata: {
				product: 'fuelPack',
				eoaAddress: eoaLower,
				packId: pack.id,
			},
			line_items: [
				{
					price_data: {
						currency: 'usd',
						unit_amount: unitAmount,
						product_data: {
							name: copy.name,
							description: copy.description,
						},
					},
					quantity: 1,
				},
			],
			payment_intent_data: {
				metadata: {
					product: 'fuelPack',
					eoaAddress: eoaLower,
					packId: pack.id,
				},
			},
			success_url: fuelPackStripeSuccessUrl(),
			cancel_url: fuelPackStripeCancelUrl(),
		},
		{ idempotencyKey }
	)

	if (!session.id || !session.url) {
		return { error: 'Checkout session creation failed' }
	}

	sessions.set(session.id, {
		status: 'pending',
		eoaAddress: eoaLower,
		packId: pack.id,
		createdAt: Date.now(),
	})

	logger(
		Colors.green('[fuelPackStripe] createSession ok'),
		`session=${session.id}`,
		`pack=${pack.id}`,
		`usdCents=${unitAmount}`,
		`eoa=${eoaLower.slice(0, 10)}…`
	)

	return { sessionId: session.id, url: session.url }
}

export function getFuelPackSessionStatus(sessionId: string): SessionRecord | null {
	return sessions.get(sessionId) ?? null
}

export type RefreshFuelPackSessionOptions = {
	treatOpenUnpaidAsAbandoned?: boolean
}

export async function refreshFuelPackSessionFromStripe(
	sessionId: string,
	options?: RefreshFuelPackSessionOptions
): Promise<void> {
	const stripe = getStripeClient()
	if (!stripe) return
	const rec_ = sessions.get(sessionId)
	if (rec_?.status !== 'pending') {
		fuelPackDbg('refresh skip (not pending)', sessionId, 'local=', rec_?.status ?? '(no record)')
		return
	}
	try {
		const s = await stripe.checkout.sessions.retrieve(sessionId)
		fuelPackDbg(
			'retrieve',
			sessionId,
			`checkoutStatus=${s.status}`,
			`payment_status=${s.payment_status}`
		)
		if (s.status === 'complete' && s.payment_status === 'paid') {
			const paymentId = extractStripeCheckoutPaymentId(s, sessionId)
			sessions.set(sessionId, {
				...rec_,
				status: 'succeeded',
				lastEvent: 'retrieve.paid',
				stripePaymentId: rec_.stripePaymentId ?? paymentId,
			})
			logger(Colors.green('[fuelPackStripe] refresh → succeeded'), sessionId)
			scheduleFuelPackStripeChainFulfillment(sessionId)
			return
		}
		if (s.status === 'expired') {
			sessions.set(sessionId, {
				...rec_,
				status: 'failed',
				lastEvent: 'expired',
			})
			logger(Colors.yellow('[fuelPackStripe] refresh → failed (expired)'), sessionId)
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
				Colors.yellow('[fuelPackStripe] refresh → failed (abandoned open+unpaid)'),
				sessionId
			)
		}
	} catch (err: unknown) {
		logger(Colors.yellow(`[fuelPackStripe] retrieve error ${sessionId}:`), err)
	}
}

function applySessionOutcome(
	sessionId: string,
	status: 'succeeded' | 'failed',
	meta: {
		eoaAddress?: string
		packId?: string
		lastEvent: string
		stripePaymentId?: string
		session?: Stripe.Checkout.Session
	}
) {
	const prev = sessions.get(sessionId)
	const createdAt = prev?.createdAt ?? Date.now()
	const eoaNorm = (meta.eoaAddress ?? prev?.eoaAddress ?? '').toLowerCase()
	const packRaw = meta.packId ?? prev?.packId ?? ''
	const pack = lookupFuelPack(packRaw)
	const packId = (pack?.id ?? prev?.packId ?? 'genesis_starter') as FuelPackId
	let stripePaymentId = prev?.stripePaymentId ?? meta.stripePaymentId
	if (!stripePaymentId && meta.session) {
		try {
			stripePaymentId = extractStripeCheckoutPaymentId(meta.session, sessionId)
		} catch {
			/* leave unset; fulfill will retrieve */
		}
	}
	const next: SessionRecord = {
		status,
		eoaAddress: eoaNorm,
		packId,
		createdAt,
		lastEvent: meta.lastEvent,
		stripePaymentId,
		chainFulfillment: prev?.chainFulfillment,
	}
	sessions.set(sessionId, next)
	fuelPackDbg('applySessionOutcome', sessionId, meta.lastEvent, '→', status, `pack=${packId}`)
}

function markFuelPackPaidSession(session: Stripe.Checkout.Session, lastEvent: string): void {
	const meta = session.metadata ?? {}
	logger(
		`[fuelPackStripe:hook] ${lastEvent}`,
		`session=${session.id}`,
		`payment_status=${session.payment_status}`,
		`metadata.pack=${meta.packId ?? '?'}`,
		`metadata.eoa=${meta.eoaAddress ? `${String(meta.eoaAddress).slice(0, 10)}…` : '?'}`
	)
	if (session.payment_status !== 'paid') {
		logger(
			Colors.yellow(`[fuelPackStripe:hook] ${lastEvent} SKIPPED (not paid yet)`),
			`payment_status=${session.payment_status}`
		)
		return
	}
	applySessionOutcome(session.id, 'succeeded', {
		eoaAddress: session.metadata?.eoaAddress,
		packId: session.metadata?.packId,
		lastEvent,
		session,
	})
	scheduleFuelPackStripeChainFulfillment(session.id)
}

export function processFuelPackStripeEvent(
	event: Stripe.Event
): { ok: true } | { ok: false; error: string } {
	const session = event.data?.object as Stripe.Checkout.Session | undefined
	const product = session?.metadata?.product
	if (product !== 'fuelPack') {
		logger(Colors.grey('[fuelPackStripe:hook] ignore non-fuelPack product'), product ?? '(none)')
		return { ok: true }
	}

	switch (event.type) {
		case 'checkout.session.completed':
		case 'checkout.session.async_payment_succeeded': {
			markFuelPackPaidSession(session as Stripe.Checkout.Session, event.type)
			break
		}
		case 'checkout.session.async_payment_failed': {
			const s = event.data.object as Stripe.Checkout.Session
			logger(Colors.yellow('[fuelPackStripe:hook] async_payment_failed'), `session=${s.id}`)
			applySessionOutcome(s.id, 'failed', {
				eoaAddress: s.metadata?.eoaAddress,
				packId: s.metadata?.packId,
				lastEvent: event.type,
			})
			break
		}
		case 'checkout.session.expired': {
			const s = event.data.object as Stripe.Checkout.Session
			logger(Colors.yellow('[fuelPackStripe:hook] expired'), `session=${s.id}`)
			applySessionOutcome(s.id, 'failed', {
				eoaAddress: s.metadata?.eoaAddress,
				packId: s.metadata?.packId,
				lastEvent: event.type,
			})
			break
		}
		default:
			logger(Colors.grey(`[fuelPackStripe:hook] unhandled ${event.type}`))
	}
	return { ok: true }
}

/** Re-export for Cluster precheck without importing catalog twice. */
export { getStripeBeamioSecretKey }
