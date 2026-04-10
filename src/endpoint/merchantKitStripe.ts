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
import { CONET_BUNIT_AIRDROP_ADDRESS, CONET_BUSINESS_START_KET } from '../chainAddresses'

/** CoNET B-Unit / kit mint signer（与 MemberCard Settle 一致） */
const CONET_MAINNET_RPC_HTTP = 'https://mainnet-rpc.conet.network'

const BUNIT_AIRDROP_MINT_FOR_USDC_PURCHASE_ABI = [
	'function mintForUsdcPurchase(address to, uint256 usdcAmount, bytes32 baseTxHash) external',
] as const

const BUSINESS_START_KET_MINT_ABI = [
	'function mint(address to, uint256 id, uint256 amount, bytes data) external',
] as const

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
	lite_kit: {
		name: 'Lite Program Kit',
		cadCents: 1900,
		description: '500 B-Units included — digital program (no NFC cards)',
	},
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

/**
 * 合成 USDC（6 位）传入 BUnitAirdrop.mintForUsdcPurchase：合约内 bunit = usdc * 100（USDC_TO_BUNIT_RATE），
 * 与各 kit 标价中包含的 B-Unit 数量一致（付费池 mintPaid）。非真实链上 USDC，仅用于铸造配额与 Indexer 记账维度。
 */
export const MERCHANT_KIT_SYNTHETIC_USDC6_FOR_BUINT: Record<MerchantKitPackageType, bigint> = {
	lite_kit: 5_000_000n,
	standard_kit: 20_000_000n,
	custom_kit: 50_000_000n,
}

/** 各 kit 对应铸造的 B-Unit 数量（6 位精度），与 MERCHANT_KIT_PACKAGES 文案一致 */
export const MERCHANT_KIT_INCLUDED_BUNITS_6: Record<MerchantKitPackageType, bigint> = {
	lite_kit: 500_000_000n,
	standard_kit: 2_000_000_000n,
	custom_kit: 5_000_000_000n,
}

export type MerchantKitChainFulfillment = {
	buintTxHash?: string
	nftTxHash?: string
	lastError?: string
}

type SessionRecord = {
	status: 'pending' | 'succeeded' | 'failed'
	eoaAddress: string
	packageType: string
	createdAt: number
	lastEvent?: string
	chainFulfillment?: MerchantKitChainFulfillment
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

/** 同 session 多次触发 webhook / refresh 时合并为单次履约链上流程 */
const merchantKitFulfillmentInflight = new Map<string, Promise<void>>()

function resolveConetBusinessStartKetAddressForMint(): string | null {
	const raw =
		(typeof process !== 'undefined' && process.env.CONET_BUSINESS_START_KET?.trim()) ||
		CONET_BUSINESS_START_KET?.trim() ||
		''
	if (!raw) {
		return null
	}
	try {
		const a = ethers.getAddress(raw)
		return a === ethers.ZeroAddress ? null : a
	} catch {
		return null
	}
}

/**
 * Stripe Checkout 支付确认后：向 metadata 中的 EOA 铸造 B-Units（付费池）并 mint BusinessStartKet #0 ×1。
 * 幂等：按 session 记录分步跳过已完成的交易；并发合并为单次 in-flight Promise。
 */
async function fulfillMerchantKitStripeOnChain(sessionId: string): Promise<void> {
	let inflight = merchantKitFulfillmentInflight.get(sessionId)
	if (inflight) {
		merchantKitDbg('fulfill join (in flight)', sessionId)
		return inflight
	}
	inflight = (async () => {
		const getCf = (): MerchantKitChainFulfillment => sessions.get(sessionId)?.chainFulfillment ?? {}
		const patchChainFulfillment = (patch: MerchantKitChainFulfillment) => {
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
				merchantKitDbg('fulfill skip (not succeeded)', sessionId, rec?.status ?? '(no record)')
				return
			}
			let eoa: string
			try {
				eoa = ethers.getAddress(rec.eoaAddress)
			} catch {
				logger(Colors.red('[merchantKitStripe] fulfill: invalid EOA'), rec.eoaAddress)
				return
			}
			if (!(rec.packageType in MERCHANT_KIT_PACKAGES)) {
				logger(Colors.red('[merchantKitStripe] fulfill: unknown packageType'), rec.packageType)
				return
			}
			const pkg = rec.packageType as MerchantKitPackageType
			const usdc6Synth = MERCHANT_KIT_SYNTHETIC_USDC6_FOR_BUINT[pkg]

			const pk = (masterSetup as { settle_contractAdmin?: string[] }).settle_contractAdmin?.[0]
			if (!pk?.trim()) {
				logger(Colors.red('[merchantKitStripe] fulfill: settle_contractAdmin[0] missing'))
				return
			}
			const pkNorm = pk.trim().startsWith('0x') ? pk.trim() : `0x${pk.trim()}`
			const provider = new ethers.JsonRpcProvider(CONET_MAINNET_RPC_HTTP)
			const signer = new ethers.Wallet(pkNorm, provider)

			if (!getCf().buintTxHash) {
				const airdrop = new ethers.Contract(
					CONET_BUNIT_AIRDROP_ADDRESS,
					BUNIT_AIRDROP_MINT_FOR_USDC_PURCHASE_ABI,
					signer
				)
				const refHash = ethers.keccak256(ethers.toUtf8Bytes(sessionId))
				const tx = await airdrop.mintForUsdcPurchase(eoa, usdc6Synth, refHash)
				const receipt = await tx.wait()
				const h = receipt?.hash ?? tx.hash
				patchChainFulfillment({ buintTxHash: h, lastError: undefined })
				logger(
					Colors.green('[merchantKitStripe] mintForUsdcPurchase ok (kit B-Units paid pool)'),
					`session=${sessionId}`,
					`pkg=${pkg}`,
					`bunits≈${(Number(MERCHANT_KIT_INCLUDED_BUNITS_6[pkg]) / 1e6).toFixed(2)}`,
					`tx=${h}`,
					`eoa=${eoa}`
				)
			}

			const ketAddr = resolveConetBusinessStartKetAddressForMint()
			if (ketAddr && !getCf().nftTxHash) {
				const ket = new ethers.Contract(ketAddr, BUSINESS_START_KET_MINT_ABI, signer)
				const tx2 = await ket.mint(eoa, 0n, 1n, '0x')
				const receipt2 = await tx2.wait()
				const h2 = receipt2?.hash ?? tx2.hash
				patchChainFulfillment({ nftTxHash: h2, lastError: undefined })
				logger(
					Colors.green('[merchantKitStripe] BusinessStartKet mint token #0 ok'),
					`session=${sessionId}`,
					`tx=${h2}`,
					`eoa=${eoa}`
				)
			} else if (!ketAddr) {
				merchantKitDbg('fulfill: skip ERC1155 (CONET_BUSINESS_START_KET unset)')
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e)
			logger(Colors.red('[merchantKitStripe] fulfill FAILED'), sessionId, msg)
			patchChainFulfillment({ lastError: msg })
		} finally {
			merchantKitFulfillmentInflight.delete(sessionId)
		}
	})()
	merchantKitFulfillmentInflight.set(sessionId, inflight)
	return inflight
}

/** Fire-and-forget；应从 webhook / paid refresh 各调用一次（内部幂等） */
export function scheduleMerchantKitStripeChainFulfillment(sessionId: string): void {
	void fulfillMerchantKitStripeOnChain(sessionId)
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
	const createdAt = prev?.createdAt ?? Date.now()
	const eoaNorm = (meta.eoaAddress ?? prev?.eoaAddress ?? '').toLowerCase()
	const pkgNorm = meta.packageType ?? prev?.packageType ?? ''
	const next: SessionRecord = {
		status,
		eoaAddress: eoaNorm,
		packageType: pkgNorm,
		createdAt,
		lastEvent: meta.lastEvent,
		chainFulfillment: prev?.chainFulfillment,
	}
	sessions.set(sessionId, next)
	merchantKitDbg('applySessionOutcome', sessionId, meta.lastEvent, '→', status, `pkg=${pkgNorm}`)
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
				scheduleMerchantKitStripeChainFulfillment(session.id)
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
