import { generateJwt } from '@coinbase/cdp-sdk/auth'
import {masterSetup, getClientIp} from './util'
import fetch from 'node-fetch'
import { Request, Response} from 'express'
import { logger } from './logger'
import { inspect } from 'util'
import {ethers} from 'ethers'
import crypto from 'node:crypto'

interface CDPAuthConfig {
	requestMethod: string
	requestPath: string
	requestHost: string
}

const coinbase_subscription = {
	createdAt: '2025-12-13T21:01:15.542744Z',
	description: 'Beamio Onramp/Offramp transaction status webhook',
	eventTypes: [
		'onramp.transaction.created',
		'onramp.transaction.updated',
		'onramp.transaction.success',
		'onramp.transaction.failed',
		'offramp.transaction.created',
		'offramp.transaction.updated',
		'offramp.transaction.success',
		'offramp.transaction.failed'
	],
	isEnabled: true,
	labelKey: 'project',
	labelValue: '292c1ff5-e113-49d5-82ae-c7999dab7257',
	labels: { project: '292c1ff5-e113-49d5-82ae-c7999dab7257' },
	subscriptionId: 'ff683cce-069f-49c3-b735-246268a26b22',
	target: { url: 'https://beamio.app/app/coinbase-hooks' }
}



const COINBASE_WEBHOOK_SECRET = masterSetup.coinbase.secret
const apiKeyId = masterSetup.coinbase.CDP_API_KEY_ID
const apiKeySecret = masterSetup.coinbase.CDP_API_KEY_SECRET

// --- 从 eventType 推导状态 ---
function extractStatus(evt: CoinbaseHookEvent) {
	const eventType = (evt.eventType || evt.type || '').toLowerCase()
	const root = evt.data ?? evt.payload?.data ?? evt.event?.data ?? evt.payload ?? evt.event ?? {}

	// 优先取 payload 自带的 status
	const payloadStatus =
		root?.status ||
		root?.transaction?.status ||
		root?.session?.status

	if (typeof payloadStatus === 'string' && payloadStatus.length > 0) {
		return payloadStatus
	}

	// 没有就用事件名推导
	if (eventType.endsWith('.success')) return 'success'
	if (eventType.endsWith('.failed')) return 'failed'
	if (eventType.endsWith('.created')) return 'created'
	if (eventType.endsWith('.updated')) return 'updated'

	return 'unknown'
}

// --- 取 eventType ---
function extractEventType(evt: CoinbaseHookEvent) {
  	return evt.eventType || evt.type || 'unknown'
}

// --- 取 eventId 做幂等 ---
function extractEventId(evt: CoinbaseHookEvent) {
  	return evt.id || evt.eventId || evt.event?.id || evt.payload?.id || null
}

function verifyCoinbaseWebhook(req: Request, rawBody: string) {
	if (!COINBASE_WEBHOOK_SECRET) {
		throw new Error('Missing COINBASE_WEBHOOK_SECRET')
	}

	// Coinbase CDP webhooks 常见的签名 header（不同环境/代理可能大小写不同）
	const sigHeader =
		(req.headers['x-hook0-signature'] as string) ||
		(req.headers['x-coinbase-signature'] as string) ||
		(req.headers['x-webhook-signature'] as string) ||
		''

	const tsHeader =
		(req.headers['x-hook0-timestamp'] as string) ||
		(req.headers['x-coinbase-timestamp'] as string) ||
		(req.headers['x-webhook-timestamp'] as string) ||
		''

	if (!sigHeader) {
		throw new Error('Missing signature header')
	}

	/**
	 * 兼容两种常见签名输入：
	 * 1) payload-only:    HMAC(secret, rawBody)
	 * 2) ts + payload:    HMAC(secret, `${timestamp}.${rawBody}`)
	 *
	 * 兼容签名 header 形态：
	 * - 直接是 hex/base64
	 * - 或者 "t=...,v1=...." / "v1=...."
	 */
	const parts = sigHeader.split(',').map(s => s.trim())
	let provided = sigHeader.trim()

	for (const p of parts) {
		const [k, v] = p.split('=')
		if (!v) continue
		if (k === 'v1' || k === 'sig' || k === 'signature') {
		provided = v
		break
		}
	}

	const msg1 = rawBody
	const msg2 = tsHeader ? `${tsHeader}.${rawBody}` : ''

	const h1 = crypto.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg1).digest('hex')
	const h2 = msg2
		? crypto.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg2).digest('hex')
		: ''

	// 有些实现会用 base64，顺便算一份
	const h1b64 = crypto.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg1).digest('base64')
	const h2b64 = msg2
		? crypto.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg2).digest('base64')
		: ''

	const ok =
		safeEqual(provided, h1) ||
		safeEqual(provided, h2) ||
		safeEqual(provided, h1b64) ||
		(h2b64 ? safeEqual(provided, h2b64) : false)

	if (!ok) {
		throw new Error('Invalid webhook signature')
	}
}


const ONRAMP_API_BASE_URL = 'https://api.cdp.coinbase.com'
const LEGACY_API_BASE_URL = 'https://api.developer.coinbase.com'

export function getCDPCredentials() {


	if (!apiKeyId || !apiKeySecret) {
		throw new Error('CDP API credentials not configured')
	}

	return { apiKeyId, apiKeySecret }
}

type CoinbaseHookEvent = {
	eventType?: string
	type?: string
	id?: string
	eventId?: string
	data?: any
	// 有些版本会把主体放在 payload / event
	payload?: any
	event?: any
}

// --- 解析 destinationAddress 的“宽松提取器” ---
function extractDestinationAddress(evt: CoinbaseHookEvent) {
	const root = evt.data ?? evt.payload?.data ?? evt.event?.data ?? evt.payload ?? evt.event ?? {}

	const candidates = [
		root?.destinationAddress,
		root?.destination_address,

		root?.transaction?.destinationAddress,
		root?.transaction?.destination_address,

		root?.quote?.destinationAddress,
		root?.quote?.destination_address,

		root?.session?.destinationAddress,
		root?.session?.destination_address,

		root?.details?.destinationAddress,
		root?.details?.destination_address,
	]

	const addr = candidates.find(v => typeof v === 'string' && v.length > 0)
	return addr || null
}

async function generateCDPJWT(config: CDPAuthConfig) {
	const { apiKeyId, apiKeySecret } = getCDPCredentials()

	return generateJwt({
		apiKeyId,
		apiKeySecret,
		requestMethod: config.requestMethod,
		requestPath: config.requestPath,
		requestHost: config.requestHost,
	})
}



async function createOnrampSession(params: CreateOnrampParams) {
	const path = '/platform/v2/onramp/sessions'
	const host = 'api.cdp.coinbase.com'

	const jwt = await generateCDPJWT({
		requestMethod: 'POST',
		requestPath: path,
		requestHost: host,
	})

	const body = {
		purchaseCurrency: 'USDC',          // 买 USDC
		destinationNetwork: 'base',        // 打到 Base
		destinationAddress: params.destinationAddress,
		paymentAmount: params.paymentAmount,
		paymentCurrency: 'USD',
		paymentMethod: 'CARD',             // CARD / ACH / APPLE_PAY / PAYPAL 等
		country: params.country,
		subdivision: params.subdivision ?? 'CA',
		redirectUrl: 'https://beamio.app/app/onramp-success', // 完成后回调到你
		partnerUserRef: params.partnerUserRef,
	}

	const res = await fetch(`${ONRAMP_API_BASE_URL}${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwt}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const error = await res.text()
		throw new Error(`Onramp session failed: ${res.status} ${error}`)
	}

	const data = await res.json() as {
		session: { onrampUrl: string }
		quote?: any
	}

	return data
}

async function createSessionToken({
	userAddress,
	clientIp,
}: {
	userAddress: string
	clientIp: string
}) {
	const path = '/onramp/v1/token'
	const host = 'api.developer.coinbase.com'

	const jwt = await generateCDPJWT({
		requestMethod: 'POST',
		requestPath: path,
		requestHost: host,
	})

	const body = {
		addresses: [
		{
			address: userAddress,
			blockchains: ['base'], // 或 ['ethereum', 'base'] 等
		},
		],
		assets: ['USDC', 'ETH'], // 这次 session 允许的资产
		clientIp,                // 真实 IP，不要随便伪造
	}

	const res = await fetch(`${LEGACY_API_BASE_URL}${path}`, {
		method: 'POST',
		headers: {
		Authorization: `Bearer ${jwt}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const error = await res.text()
		throw new Error(`Create session token failed: ${res.status} ${error}`)
	}

	const data = await res.json() as { token: string; channel_id?: string }
	return data.token // 这个就是 sessionToken
}

export const coinbaseToken = async (req: Request, res: Response) => {
	const clientIp = getClientIp(req)
	try {
		const { address, paymentAmount } = req.query as {
			address?: string
			paymentAmount?: string

		}

		if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress ) {
			return res.status(400).json({ error: 'Missing or invalid address' })
		}

		const amount = Number(paymentAmount)
		if (isNaN(amount) || amount <= 0 || amount > 500) {
			return res.status(400).json({ error: 'amount must less than 500' })
		}

		// 调用上面封装好的 createSessionToken
		const data = await createOnrampSession({
			destinationAddress: address,
			paymentAmount: amount.toFixed(2),
			partnerUserRef: `beamio-${address}`,
		})

		return res.json({
			onrampUrl: data.session.onrampUrl,
			quote: data.quote ?? null,
		})

	} catch (err: any) {
		console.error('coinbaseToken error:', err)
		return res.status(500).json({ error: 'Failed to create session token' })
	}
}


export const coinbaseOnrampSession = async (req: Request, res: Response) => {
  try {
    const { address, country, subdivision, paymentAmount, userId } = req.body

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid address' })
    }

    const clientIp =
      (req.headers['cf-connecting-ip'] as string) ||
      (req.headers['x-real-ip'] as string) ||
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      ''

    const data = await createOnrampSession({
		destinationAddress: address,
		country: country || 'US',
		subdivision: subdivision || 'CA',
		paymentAmount: paymentAmount || '50.00',
		partnerUserRef: userId || `beamio-${address}`,
    })

    // data.session.onrampUrl 就是你要丢给前端打开的 URL
    return res.json({
      onrampUrl: data.session.onrampUrl,
      quote: data.quote ?? null,
      clientIp, // 看情况要不要返回，仅用于调试
    })
  } catch (err: any) {
    console.error('coinbaseOnrampSession error:', err)
    return res.status(500).json({ error: 'Failed to create onramp session' })
  }
}

// ⭐ 使用 v1 token 生成 sessionToken，再拼 sell/offramp URL
async function createOfframpSessionToken(userAddress: string, clientIp: string) {
	const path = '/onramp/v1/token'
	const host = 'api.developer.coinbase.com'

	const jwt = await generateCDPJWT({
			requestMethod: 'POST',
			requestPath: path,
			requestHost: host,
	})

  const body = {
		addresses: [
			{
				address: userAddress,
				blockchains: ['base'],
			},
		],
		assets: ['USDC'],   // 允许卖出的资产
		clientIp,           // 真实 IP
  }

	const res = await fetch(`${LEGACY_API_BASE_URL}${path}`, {
		method: 'POST',
		headers: {
		Authorization: `Bearer ${jwt}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const error = await res.text()
		throw new Error(`Create session token failed: ${res.status} ${error}`)
	}

  const data = (await res.json()) as { token: string }
  return data.token // sessionToken
}
type CreateWebhookParams = {
	url?: string
	description?: string
}

// GET /api/coinbase-offramp?address=0x...
export const coinbaseOfframp = async (req: Request, res: Response) => {
  try {
    const address = req.query.address as string

    if (!address) {
      return res.status(400).json({ error: 'Missing address' })
    }

    const clientIp =
		(req.headers['cf-connecting-ip'] as string) ||
		(req.headers['x-real-ip'] as string) ||
		(req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
		req.socket.remoteAddress ||
      ''

    // 1) 生成 sessionToken
    const sessionToken = await createOfframpSessionToken(address, clientIp)

    // 2) 拼 Offramp / Sell URL
    // 文档约定：sell / off-ramp 入口 path 一般类似 /v3/sell/input 或 /buy/select-asset 的变体
    const url = new URL('https://pay.coinbase.com/v3/sell/input')
    url.searchParams.set('sessionToken', sessionToken)
    url.searchParams.set('partnerUserRef', `beamio-${address}`)
    url.searchParams.set('defaultNetwork', 'base')
    url.searchParams.set('defaultAsset', 'USDC')
    url.searchParams.set('fiatCurrency', 'USD')
    url.searchParams.set(
      'redirectUrl',
      'https://beamio.app/app/offramp/success'
    )

    return res.json({ offrampUrl: url.toString() })
  } catch (err: any) {
    console.error('coinbaseOfframp error:', err)
    return res.status(500).json({ error: 'Failed to create offramp url' })
  }
}

export async function coinbaseWebhook() {
	const host = 'api.cdp.coinbase.com'
	const path = '/platform/v2/data/webhooks/subscriptions'

	const jwt = await generateCDPJWT({
		requestMethod: 'POST',
		requestPath: path,
		requestHost: host,
	})

	const body = {
		description: 'Beamio Onramp/Offramp transaction status webhook',
		eventTypes: [
		// Onramp
		'onramp.transaction.created',
		'onramp.transaction.updated',
		'onramp.transaction.success',
		'onramp.transaction.failed',

		// Offramp
		'offramp.transaction.created',
		'offramp.transaction.updated',
		'offramp.transaction.success',
		'offramp.transaction.failed',
		],
		target: {
		url: 'https://beamio.app/app/coinbase-hooks',
		method: 'POST',
		},
		labels: {},
		isEnabled: true,
	}

	const res = await fetch(`https://${host}${path}`, {
		method: 'POST',
		headers: {
		Authorization: `Bearer ${jwt}`,
		'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const err = await res.text()
		throw new Error(`Create webhook subscription failed: ${res.status} ${err}`)
	}

	const data = await res.json()
	logger(`success `, inspect(data, false, 3, true))
	// ⚠️ metadata.secret 会在创建时返回，用于验签；务必保存
	return data

}


interface CreateOnrampParams {
	destinationAddress: string  // 用户钱包地址
	country?: string             // 'US'
	subdivision?: string        // 'CA' / 'NY' 等，美国必填
	paymentAmount: string      // 比如 '100.00'
	partnerUserRef: string      // 你系统里的 userId
}


// --- 小工具：安全比较 ---
function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (aa.length !== bb.length) return false
  return crypto.timingSafeEqual(aa, bb)
}

// --- 小工具：取 raw body ---
function getRawBody(req: Request) {
  // 因为我们用了 express.raw，所以 req.body 是 Buffer
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
  // 兜底：如果有人误配成 json parser
  if (typeof req.body === 'string') return req.body
  try {
    return JSON.stringify(req.body ?? {})
  } catch {
    return ''
  }
}


export const coinbaseHooks = (req: Request, res: Response) => {
	const rawBody = getRawBody(req)

	try {
		// 1) 验签
		verifyCoinbaseWebhook(req, rawBody)

		// 2) parse JSON
		const evt = JSON.parse(rawBody) as CoinbaseHookEvent

		const eventId = extractEventId(evt)
		const eventType = extractEventType(evt)
		const destinationAddress = extractDestinationAddress(evt)
		const status = extractStatus(evt)

		// 3) 幂等处理（强烈建议）
		// TODO: 用 eventId 做唯一键，已处理过就直接 200
		// await db.webhookEvents.insertOnce({ eventId, ... })

		// 4) 业务处理：更新你们的订单/流水
		// 推荐：用 destinationAddress + (payload里的 partnerUserRef / transactionId) 去定位订单
		// TODO:
		// await db.onrampOrders.updateByTxOrRef({ ... })

		// 你想直接“获得 destinationAddress 和状态”
		// 这里返回给调用方（Coinbase）必须 200，且尽量快
		// 你自己 debug 可以 log
		console.log('[coinbaseHooks]', {
			eventId,
			eventType,
			destinationAddress,
			status,
		})

		return res.status(200).json({
			ok: true,
			eventId,
			eventType,
			destinationAddress,
			status,
		})
	} catch (e: any) {
		console.error('[coinbaseHooks] error:', e?.message || e)

		// 验签失败一般返回 401
		if ((e?.message || '').includes('signature')) {
			return res.status(401).json({ ok: false, error: 'invalid_signature' })
		}

		return res.status(400).json({ ok: false, error: 'bad_request' })
	}
}