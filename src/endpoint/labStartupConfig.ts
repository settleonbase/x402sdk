/**
 * Startup configuration for the Lab CL payout daemon (round-4 F5 and the redeem pin).
 *
 * Each parser returns the effective value together with where it came from (env or default) and why. The reporter
 * uses these same functions for its resolvers and its startup log, so the log cannot disagree with the value used.
 * Code defaults are unchanged. The candidate values (0.03 Gwei, 300 s, 800000) equal the
 * defaults here; the env example sets them explicitly so that the operator can see src=env.
 * Pure functions. No I/O. Node built-ins and ethers only.
 */
import { ethers } from 'ethers'

export type ConfigReport<T> = {
	value: T
	src: 'env' | 'default'
	/** "unset", "accepted", or the reason a supplied value was rejected. */
	reason: string
	/** The env variable that produced the value, or "default". */
	name: string
}

export const DEFAULT_MAX_GAS_PRICE_WEI = 30_000_000n
export const DEFAULT_GAS_WAIT_FORCE_MS = 300_000
export const DEFAULT_GAS_LIMIT = 800_000

const MAX_GAS_LIMIT_CAP = 8_000_000

function text(raw: string | undefined): string {
	return raw?.trim() ?? ''
}

/** MAX_GAS_PRICE_WEI wins when valid; otherwise MAX_GAS_PRICE_GWEI when valid; otherwise the default. */
export function maxGasWeiFromEnv(weiRaw: string | undefined, gweiRaw: string | undefined): ConfigReport<bigint> {
	const wei = text(weiRaw)
	let weiReason = 'unset'
	if (wei !== '') {
		try {
			const w = BigInt(wei)
			if (w > 0n) return { value: w, src: 'env', reason: 'accepted', name: 'CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_WEI' }
			weiReason = `rejected "${wei}" (must be > 0)`
		} catch {
			weiReason = `rejected "${wei}" (not an integer)`
		}
	}
	const gwei = text(gweiRaw)
	if (gwei !== '') {
		const g = Number(gwei)
		if (Number.isFinite(g) && g > 0) {
			return {
				value: ethers.parseUnits(String(g), 'gwei'),
				src: 'env',
				reason: `accepted${wei !== '' ? `; WEI ${weiReason}` : ''}`,
				name: 'CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI',
			}
		}
		return {
			value: DEFAULT_MAX_GAS_PRICE_WEI,
			src: 'default',
			reason: `rejected "${gwei}" (must be a number > 0 Gwei)${wei !== '' ? `; WEI ${weiReason}` : ''}`,
			name: 'default',
		}
	}
	return { value: DEFAULT_MAX_GAS_PRICE_WEI, src: 'default', reason: weiReason, name: 'default' }
}

/** Minimum 30000 ms. Non-numeric or smaller values fall back to the default. */
export function gasWaitForceFromEnv(raw: string | undefined): ConfigReport<number> {
	const t = text(raw)
	if (t === '') return { value: DEFAULT_GAS_WAIT_FORCE_MS, src: 'default', reason: 'unset', name: 'default' }
	const n = Number(t)
	if (Number.isFinite(n) && n >= 30_000) {
		return { value: Math.floor(n), src: 'env', reason: 'accepted', name: 'CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS' }
	}
	return { value: DEFAULT_GAS_WAIT_FORCE_MS, src: 'default', reason: `rejected "${t}" (must be a number >= 30000 ms)`, name: 'default' }
}

/** Minimum 100000, capped at 8000000. Anything else falls back to the default. */
export function gasLimitFromEnv(raw: string | undefined): ConfigReport<number> {
	const t = text(raw)
	if (t === '') return { value: DEFAULT_GAS_LIMIT, src: 'default', reason: 'unset', name: 'default' }
	const n = Number(t)
	if (Number.isFinite(n) && n >= 100_000) {
		return {
			value: Math.min(MAX_GAS_LIMIT_CAP, Math.floor(n)),
			src: 'env',
			reason: n > MAX_GAS_LIMIT_CAP ? `accepted, capped at ${MAX_GAS_LIMIT_CAP}` : 'accepted',
			name: 'CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT',
		}
	}
	return { value: DEFAULT_GAS_LIMIT, src: 'default', reason: `rejected "${t}" (must be a number >= 100000)`, name: 'default' }
}

/**
 * The redeem address is pinned. An env override that differs from the pinned address refuses the start.
 * An unset or equal value passes. Returns the checksummed pinned address.
 */
export function assertPinnedRedeem(envRaw: string | undefined, pinned: string): string {
	const pinnedChecksum = ethers.getAddress(pinned)
	const t = text(envRaw)
	if (t === '') return pinnedChecksum
	let given: string
	try {
		given = ethers.getAddress(t)
	} catch {
		throw new Error(`CONET_VALIDATOR_DEPOSIT_REDEEM is not a valid address; the Lab redeem is pinned to ${pinnedChecksum}`)
	}
	if (given !== pinnedChecksum) {
		throw new Error(`CONET_VALIDATOR_DEPOSIT_REDEEM=${given} differs from the pinned Lab redeem ${pinnedChecksum}; refusing to start`)
	}
	return pinnedChecksum
}

/**
 * The startup log line for the gas and alert settings (round-5 item 3). Lives here, next to the parsers, so the text
 * is unit-tested. Each value is printed as the parser returned it, with its source and reason.
 */
export function startupConfigLine(env: NodeJS.ProcessEnv = process.env): string {
	const mg = maxGasWeiFromEnv(env.CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_WEI, env.CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI)
	const gw = gasWaitForceFromEnv(env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS)
	const gl = gasLimitFromEnv(env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT)
	return [
		`maxGasGwei=${ethers.formatUnits(mg.value, 'gwei')} src=${mg.src} name=${mg.name} reason="${mg.reason}"`,
		`gasWaitForceMs=${gw.value} src=${gw.src} name=${gw.name} reason="${gw.reason}"`,
		`gasLimit=${gl.value} src=${gl.src} name=${gl.name} reason="${gl.reason}"`,
	].join(' ')
}
