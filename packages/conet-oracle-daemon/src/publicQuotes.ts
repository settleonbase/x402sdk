import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { parseUnits } from 'ethers'
import {
	COINBASE_ETH_USD_SPOT_URL,
	COINBASE_FX_URL,
	FETCH_TIMEOUT_MS,
	MAX_FETCH_ATTEMPTS,
	MAX_SOURCE_AGE_MS,
} from './constants'
import { readQuoteDocument, type FreshQuote } from './quoteSource'
import { QuoteRefusal } from './refusal'

const ONE_E18 = 10n ** 18n
const MAX_BODY_BYTES = 1_000_000

/** Coinbase `data.rates` is units of foreign currency per 1 USD. On-chain value is USD per 1 unit. */
const FIAT_PER_USD: ReadonlyArray<readonly [string, number]> = [
	['CAD', 0],
	['JPY', 2],
	['CNY', 3],
	['HKD', 5],
	['EUR', 6],
	['SGD', 7],
	['TWD', 8],
]

export type HttpResponse = {
	status: number
	dateHeader: string | null
	body: string
}

export type HttpGet = (url: string, timeoutMs: number) => Promise<HttpResponse>

export function fxUnitsPerUsdToRateE18(unitsPerUsd: number): bigint {
	if (!Number.isFinite(unitsPerUsd) || unitsPerUsd <= 0) {
		throw new QuoteRefusal('rate', 'fx rate is not a positive number')
	}
	const usdPerUnit = 1 / unitsPerUsd
	if (!Number.isFinite(usdPerUnit) || usdPerUnit <= 0) {
		throw new QuoteRefusal('rate', 'inverted fx is not positive')
	}
	return parseUnits(usdPerUnit.toFixed(18), 18)
}

export function usdAmountToRateE18(amount: number): bigint {
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new QuoteRefusal('rate', 'spot amount is not a positive number')
	}
	return parseUnits(amount.toFixed(18), 18)
}

function positiveNumber(value: unknown, label: string): number {
	const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
	if (typeof value === 'string' && value.trim() === '') throw new QuoteRefusal('rate', `${label} is empty`)
	if (!Number.isFinite(num) || num <= 0) throw new QuoteRefusal('rate', `${label} is not a positive number`)
	return num
}

function httpDateMs(header: string | null, label: string): number {
	if (!header || !header.trim()) throw new QuoteRefusal('timestamp', `${label} Date header is missing`)
	const ms = Date.parse(header)
	if (!Number.isFinite(ms)) throw new QuoteRefusal('timestamp', `${label} Date header is not a time`)
	return ms
}

function assertFreshDate(ms: number, nowMs: number, label: string): void {
	const age = nowMs - ms
	if (age < 0) throw new QuoteRefusal('timestamp', `${label} Date header is in the future`)
	if (age > MAX_SOURCE_AGE_MS) {
		throw new QuoteRefusal('stale', `${label} Date header is ${age}ms old; limit is ${MAX_SOURCE_AGE_MS}ms`)
	}
}

function parseJson(body: string, label: string): unknown {
	try {
		return JSON.parse(body) as unknown
	} catch {
		throw new QuoteRefusal('source', `${label} body is not JSON`)
	}
}

/**
 * Build a quote from the two responses of this attempt only.
 * The timestamp is the older HTTP Date. Rates from a previous attempt are not reused.
 */
export function quoteFromResponses(fx: HttpResponse, eth: HttpResponse, nowMs: number): FreshQuote {
	if (fx.status < 200 || fx.status >= 300) throw new QuoteRefusal('source', `fx HTTP ${fx.status}`)
	if (eth.status < 200 || eth.status >= 300) throw new QuoteRefusal('source', `eth HTTP ${eth.status}`)
	const fxDate = httpDateMs(fx.dateHeader, 'fx')
	const ethDate = httpDateMs(eth.dateHeader, 'eth')
	assertFreshDate(fxDate, nowMs, 'fx')
	assertFreshDate(ethDate, nowMs, 'eth')
	const fxJson = parseJson(fx.body, 'fx') as { data?: { rates?: Record<string, unknown> } }
	const ethJson = parseJson(eth.body, 'eth') as { data?: { amount?: unknown } }
	const rates = fxJson?.data?.rates
	if (!rates || typeof rates !== 'object') throw new QuoteRefusal('rate', 'fx data.rates is missing')
	const points: { currencyId: number; rateE18: string }[] = []
	for (const [code, currencyId] of FIAT_PER_USD) {
		if (!(code in rates)) throw new QuoteRefusal('rate', `fx data.rates.${code} is missing`)
		points.push({ currencyId, rateE18: fxUnitsPerUsdToRateE18(positiveNumber(rates[code], code)).toString() })
	}
	points.push({ currencyId: 1, rateE18: ONE_E18.toString() })
	points.push({ currencyId: 4, rateE18: ONE_E18.toString() })
	if (!ethJson?.data || !('amount' in ethJson.data)) throw new QuoteRefusal('rate', 'eth data.amount is missing')
	points.push({ currencyId: 9, rateE18: usdAmountToRateE18(positiveNumber(ethJson.data.amount, 'ETH')).toString() })
	points.sort((a, b) => a.currencyId - b.currencyId)
	return readQuoteDocument({ observedAt: new Date(Math.min(fxDate, ethDate)).toISOString(), rates: points }, nowMs)
}

export function nodeHttpGet(ca?: Buffer): HttpGet {
	return (url, timeoutMs) =>
		new Promise((resolve, reject) => {
			let parsed: URL
			try {
				parsed = new URL(url)
			} catch {
				reject(new QuoteRefusal('source', 'quote URL is invalid'))
				return
			}
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
				reject(new QuoteRefusal('source', 'quote URL must be http(s)'))
				return
			}
			const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest
			const req = lib(
				url,
				{
					method: 'GET',
					headers: { accept: 'application/json' },
					...(parsed.protocol === 'https:'
						? {
								rejectUnauthorized: true,
								...(ca ? { ca } : {}),
								...(isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
							}
						: {}),
				},
				(res) => {
					const chunks: Buffer[] = []
					let size = 0
					res.on('data', (chunk: Buffer) => {
						size += chunk.length
						if (size > MAX_BODY_BYTES) {
							req.destroy()
							reject(new QuoteRefusal('source', 'quote response is too large'))
							return
						}
						chunks.push(chunk)
					})
					res.on('end', () => {
						const date = res.headers.date
						resolve({
							status: res.statusCode ?? 0,
							dateHeader: Array.isArray(date) ? (date[0] ?? null) : (date ?? null),
							body: Buffer.concat(chunks).toString('utf8'),
						})
					})
				},
			)
			req.setTimeout(timeoutMs, () => {
				req.destroy(new Error('timeout'))
			})
			req.on('error', (err) => reject(err))
			req.end()
		})
}

function delay(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve()
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

export type FetchQuoteInput = {
	/** Read after both responses of an attempt are in hand. Do not snapshot this before GET. */
	now?: () => number
	fxUrl?: string
	ethUrl?: string
	timeoutMs?: number
	maxAttempts?: number
	retryDelayMs?: number
	get?: HttpGet
}

/**
 * Each attempt GETs both public sources again. A failed body is discarded.
 * The clock is read only after that attempt's two responses have arrived.
 * At most MAX_FETCH_ATTEMPTS tries. This function does not sign.
 */
export async function fetchPublicQuote(input: FetchQuoteInput): Promise<{ quote: FreshQuote; attempts: number }> {
	const get = input.get ?? nodeHttpGet()
	const fxUrl = input.fxUrl ?? COINBASE_FX_URL
	const ethUrl = input.ethUrl ?? COINBASE_ETH_USD_SPOT_URL
	const timeoutMs = input.timeoutMs ?? FETCH_TIMEOUT_MS
	const retryDelayMs = input.retryDelayMs ?? 500
	const readClock = input.now ?? Date.now
	const requested = input.maxAttempts
	const attempts = Math.min(
		MAX_FETCH_ATTEMPTS,
		Math.max(1, requested !== undefined && Number.isFinite(requested) ? requested : MAX_FETCH_ATTEMPTS),
	)
	let last: unknown
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const [fx, eth] = await Promise.all([get(fxUrl, timeoutMs), get(ethUrl, timeoutMs)])
			const nowMs = readClock()
			return { quote: quoteFromResponses(fx, eth, nowMs), attempts: attempt }
		} catch (err) {
			last = err
			if (attempt === attempts) break
			await delay(retryDelayMs)
		}
	}
	if (last instanceof QuoteRefusal) throw last
	const message = last instanceof Error ? last.message : 'public quote fetch failed'
	throw new QuoteRefusal('source', message)
}
