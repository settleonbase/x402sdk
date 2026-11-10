import { MAX_SOURCE_AGE_MS } from './constants'
import { QuoteRefusal } from './refusal'

const USD_CURRENCY_ID = 1
const ONE_E18 = 10n ** 18n

/** Fields that would steer this process at Base, a private key, or another chain. */
const FORBIDDEN_DOCUMENT_KEYS = [
	'chainId',
	'rpc',
	'rpcUrl',
	'base',
	'baseRpc',
	'baseUrl',
	'privateKey',
	'mnemonic',
	'guardianOracle',
] as const

export type RatePoint = {
	currencyId: number
	rateE18: bigint
}

export type FreshQuote = {
	observedAtMs: number
	rates: RatePoint[]
}

export function assertSourceFresh(observedAtMs: number, nowMs: number): void {
	if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) {
		throw new QuoteRefusal('timestamp', 'observedAt is missing or invalid')
	}
	const age = nowMs - observedAtMs
	if (age < 0) throw new QuoteRefusal('timestamp', 'observedAt is in the future')
	if (age > MAX_SOURCE_AGE_MS) {
		throw new QuoteRefusal('stale', `source is ${age}ms old; limit is ${MAX_SOURCE_AGE_MS}ms`)
	}
}

function parseObservedAt(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value)
	if (typeof value === 'string') {
		const ms = Date.parse(value)
		if (Number.isFinite(ms)) return ms
	}
	throw new QuoteRefusal('timestamp', 'observedAt is missing or invalid')
}

function parseRateE18(value: unknown): bigint {
	if (typeof value === 'bigint') return value
	if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
		throw new QuoteRefusal('rate', 'rateE18 must be a positive decimal integer string')
	}
	return BigInt(value)
}

/**
 * Accept a local quote document. The timestamp is the source time, not the time
 * this process happened to read the file.
 */
export function readQuoteDocument(raw: unknown, nowMs: number): FreshQuote {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new QuoteRefusal('source', 'quote document is not an object')
	}
	const doc = raw as Record<string, unknown>
	for (const key of FORBIDDEN_DOCUMENT_KEYS) {
		if (key in doc) throw new QuoteRefusal('base-or-secret', `quote document must not include ${key}`)
	}
	const observedAtMs = parseObservedAt(doc.observedAt)
	assertSourceFresh(observedAtMs, nowMs)
	if (!Array.isArray(doc.rates) || doc.rates.length === 0) {
		throw new QuoteRefusal('rate', 'rates must be a non-empty array')
	}
	const rates: RatePoint[] = []
	const seen = new Set<number>()
	for (const row of doc.rates) {
		if (row === null || typeof row !== 'object') throw new QuoteRefusal('rate', 'rate row is not an object')
		const rec = row as Record<string, unknown>
		const currencyId = rec.currencyId
		if (typeof currencyId !== 'number' || !Number.isInteger(currencyId) || currencyId < 0 || currencyId > 255) {
			throw new QuoteRefusal('rate', 'currencyId must be an integer from 0 to 255')
		}
		if (seen.has(currencyId)) throw new QuoteRefusal('rate', `duplicate currencyId ${currencyId}`)
		seen.add(currencyId)
		const rateE18 = parseRateE18(rec.rateE18)
		if (rateE18 <= 0n) throw new QuoteRefusal('rate', 'rateE18 must be positive')
		if (currencyId === USD_CURRENCY_ID && rateE18 !== ONE_E18) {
			throw new QuoteRefusal('rate', 'USD rate must be exactly 1e18')
		}
		rates.push({ currencyId, rateE18 })
	}
	return { observedAtMs, rates }
}
