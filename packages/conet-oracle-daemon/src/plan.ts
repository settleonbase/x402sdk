import { Interface, getAddress, keccak256 } from 'ethers'
import {
	BEAMIO_ORACLE,
	CONET_CHAIN_ID,
	GUARDIAN_ORACLE_BASE,
	GUARDIAN_ORACLE_CONET,
	ORACLE_KEY_ARRAY,
	ORACLE_OWNER,
	UPDATE_RATE_SELECTOR,
	UPDATE_RATES_BATCH_SELECTOR,
} from './constants'
import { QuoteRefusal } from './refusal'
import type { FreshQuote } from './quoteSource'

const RATE_IFACE = new Interface([
	'function updateRatesBatch(uint8[] cs, uint256[] rs)',
	'function updateRate(uint8 c, uint256 rateE18)',
])

const FORBIDDEN_TARGETS = new Set(
	[GUARDIAN_ORACLE_CONET, GUARDIAN_ORACLE_BASE].map((addr) => getAddress(addr).toLowerCase()),
)

export type OracleTx = {
	keyArray: typeof ORACLE_KEY_ARRAY
	chainId: typeof CONET_CHAIN_ID
	from: typeof ORACLE_OWNER
	to: typeof BEAMIO_ORACLE
	value: '0'
	data: string
	idempotencyKey: string
}

export type TargetInput = {
	chainId: number
	to: string
	value?: bigint | string
}

/** Refuse Base, the old GuardianOracle, and any native value. */
export function assertConetOracleTarget(input: TargetInput): void {
	if (input.chainId !== CONET_CHAIN_ID) {
		throw new QuoteRefusal('chain', `chain ${input.chainId} is not CoNET ${CONET_CHAIN_ID}`)
	}
	let to: string
	try {
		to = getAddress(input.to)
	} catch {
		throw new QuoteRefusal('target', 'quote target is not an address')
	}
	if (FORBIDDEN_TARGETS.has(to.toLowerCase())) {
		throw new QuoteRefusal('guardian-oracle', `refusing old oracle ${to}`)
	}
	if (to !== getAddress(BEAMIO_ORACLE)) {
		throw new QuoteRefusal('target', `refusing target ${to}`)
	}
	const value = typeof input.value === 'bigint' ? input.value : BigInt(input.value ?? '0')
	if (value !== 0n) throw new QuoteRefusal('value', 'native value must be 0')
}

export function encodeRateUpdate(quote: FreshQuote): string {
	if (quote.rates.length === 1) {
		const row = quote.rates[0]!
		const data = RATE_IFACE.encodeFunctionData('updateRate', [row.currencyId, row.rateE18])
		if (!data.toLowerCase().startsWith(UPDATE_RATE_SELECTOR)) {
			throw new QuoteRefusal('calldata', 'updateRate selector drifted')
		}
		return data
	}
	const ids = quote.rates.map((row) => row.currencyId)
	const rates = quote.rates.map((row) => row.rateE18)
	const data = RATE_IFACE.encodeFunctionData('updateRatesBatch', [ids, rates])
	if (!data.toLowerCase().startsWith(UPDATE_RATES_BATCH_SELECTOR)) {
		throw new QuoteRefusal('calldata', 'updateRatesBatch selector drifted')
	}
	return data
}

export function buildOracleTx(quote: FreshQuote, target: TargetInput = {
	chainId: CONET_CHAIN_ID,
	to: BEAMIO_ORACLE,
	value: 0n,
}): OracleTx {
	assertConetOracleTarget(target)
	const data = encodeRateUpdate(quote)
	const selector = data.slice(0, 10).toLowerCase()
	if (selector !== UPDATE_RATES_BATCH_SELECTOR && selector !== UPDATE_RATE_SELECTOR) {
		throw new QuoteRefusal('calldata', `selector ${selector} is not a rate update`)
	}
	const stamp = keccak256(data).slice(2, 18)
	return {
		keyArray: ORACLE_KEY_ARRAY,
		chainId: CONET_CHAIN_ID,
		from: ORACLE_OWNER,
		to: BEAMIO_ORACLE,
		value: '0',
		data,
		idempotencyKey: `conet-oracle:${quote.observedAtMs}:${stamp}`,
	}
}
