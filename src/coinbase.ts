import { generateJwt } from '@coinbase/cdp-sdk/auth'
import {masterSetup} from './util'
import fetch from 'node-fetch'
import { Request, Response} from 'express'
import { getClientIp} from './util'
import { logger } from './logger'
import { inspect } from 'util'

interface CDPAuthConfig {
	requestMethod: string
	requestPath: string
	requestHost: string
}

interface CreateOnrampParams {
	destinationAddress: string  // 用户钱包地址
	country: string             // 'US'
	subdivision?: string        // 'CA' / 'NY' 等，美国必填
	paymentAmount?: string      // 比如 '100.00'
	partnerUserRef: string      // 你系统里的 userId
}

const ONRAMP_API_BASE_URL = 'https://api.cdp.coinbase.com'
const LEGACY_API_BASE_URL = 'https://api.developer.coinbase.com'

export function getCDPCredentials() {
	const apiKeyId = masterSetup.coinbase.CDP_API_KEY_ID
	const apiKeySecret = masterSetup.coinbase.CDP_API_KEY_SECRET

	if (!apiKeyId || !apiKeySecret) {
		throw new Error('CDP API credentials not configured')
	}

	return { apiKeyId, apiKeySecret }
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
		paymentAmount: params.paymentAmount ?? '50.00',
		paymentCurrency: 'USD',
		paymentMethod: 'CARD',             // CARD / ACH / APPLE_PAY / PAYPAL 等
		country: params.country,
		subdivision: params.subdivision ?? 'CA',
		redirectUrl: 'https://beamio.app/app/onramp/success', // 完成后回调到你
		clientIp: '203.0.113.10',          // 真实用户 IP
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
		const { address } = req.body

		if (!address || typeof address !== 'string') {
			return res.status(400).json({ error: 'Missing or invalid address' })
		}

		// 调用上面封装好的 createSessionToken
		const sessionToken = await createSessionToken({
			userAddress: address,
			clientIp,
		})
		logger(`coinbaseToken`, inspect(sessionToken, false, 3, true))
		return res.json({ sessionToken }).end()
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