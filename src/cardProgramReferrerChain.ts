import { ethers } from 'ethers'
import { CONET_AA_FACTORY } from './chainAddresses'
import { providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'

/** Unified reward points (#13). Legacy #1 was referrer-only and is no longer minted as spendable. */
const REFERRER_REWARD_TOKEN_ID = 13n

const CARD_REFERRER_READ_ABI = [
	'function referrerTotalCount() view returns (uint256)',
	'function registeredRefereeTotalCount() view returns (uint256)',
	'function refereeCountByReferrer(address referrerAA) view returns (uint256)',
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function refereeChargePointsTotal6(address refereeAA) view returns (uint256)',
	'function refereeReferrer(address refereeAA) view returns (address)',
	'function getReferrersPage(uint256 offset, uint256 pageSize) view returns (address[] referrers, uint256[] referrerRewardBalances, uint256 total, uint256 nextOffset)',
	'function getRefereesByReferrerPage(address referrerAA, uint256 offset, uint256 pageSize) view returns (address[] referees, uint256[] refereeChargeTotals6, uint256 total, uint256 nextOffset)',
	'function getRegisteredRefereesPage(uint256 offset, uint256 pageSize) view returns (address[] referees, uint256 total, uint256 nextOffset)',
] as const

const AA_FACTORY_ABI = [
	'function isBeamioAccount(address) view returns (bool)',
	'function beamioAccountOf(address) view returns (address)',
] as const

const AA_OWNER_ABI = ['function owner() view returns (address)'] as const

export type CardProgramReferrerChainSummary = {
	referrerTotalCount: number | null
	registeredRefereeTotalCount: number | null
}

async function cardReferrerReadContract(cardAddress: string): Promise<{
	card: ethers.Contract
	provider: ethers.Provider
}> {
	const card = ethers.getAddress(cardAddress)
	const chain = await resolveUserCardChain(card)
	const provider = providerForUserCardChain(chain)
	return { card: new ethers.Contract(card, CARD_REFERRER_READ_ABI, provider), provider }
}

function bigintToCount(raw: bigint): number | null {
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null
}

/** Chain stores Beamio AA; product UI/API must expose EOA. */
export async function resolveReferrerRegistryAaToEoa(
	provider: ethers.Provider,
	aaOrEoa: string,
): Promise<string> {
	if (!ethers.isAddress(aaOrEoa) || aaOrEoa === ethers.ZeroAddress) return aaOrEoa
	const addr = ethers.getAddress(aaOrEoa)
	try {
		const fac = new ethers.Contract(CONET_AA_FACTORY, AA_FACTORY_ABI, provider)
		const isAa = Boolean(await fac.isBeamioAccount(addr))
		if (!isAa) return addr
		const acct = new ethers.Contract(addr, AA_OWNER_ABI, provider)
		const owner = (await acct.owner()) as string
		if (owner && owner !== ethers.ZeroAddress) return ethers.getAddress(owner)
	} catch {
		/* keep addr */
	}
	return addr
}

/**
 * Lookup keys for referrer-registry mappings.
 * Bind writes the **login EOA** on-card; older rows may be AA. Always try the
 * address as-is first — never rewrite EOA → AA before the first read.
 */
export async function resolveReferrerRegistryLookupKeys(
	provider: ethers.Provider,
	eoaOrAa: string,
): Promise<string[]> {
	if (!ethers.isAddress(eoaOrAa) || eoaOrAa === ethers.ZeroAddress) return []
	const addr = ethers.getAddress(eoaOrAa)
	const keys = [addr]
	try {
		const fac = new ethers.Contract(CONET_AA_FACTORY, AA_FACTORY_ABI, provider)
		if (await fac.isBeamioAccount(addr)) {
			const owner = (await new ethers.Contract(addr, AA_OWNER_ABI, provider).owner()) as string
			if (owner && owner !== ethers.ZeroAddress) keys.push(ethers.getAddress(owner))
		} else {
			const aa = (await fac.beamioAccountOf(addr)) as string
			if (aa && aa !== ethers.ZeroAddress) keys.push(ethers.getAddress(aa))
		}
	} catch {
		/* keep as-is */
	}
	return [...new Set(keys)]
}

/** Accept EOA or AA for chain index lookups; return the AA used on-card. */
export async function resolveReferrerRegistryLookupAa(
	provider: ethers.Provider,
	eoaOrAa: string,
): Promise<string> {
	if (!ethers.isAddress(eoaOrAa) || eoaOrAa === ethers.ZeroAddress) return eoaOrAa
	const addr = ethers.getAddress(eoaOrAa)
	try {
		const fac = new ethers.Contract(CONET_AA_FACTORY, AA_FACTORY_ABI, provider)
		if (await fac.isBeamioAccount(addr)) return addr
		const aa = (await fac.beamioAccountOf(addr)) as string
		if (aa && aa !== ethers.ZeroAddress) return ethers.getAddress(aa)
	} catch {
		/* fall through */
	}
	return addr
}

async function pickLookupWithPreferredHit<T>(
	keys: string[],
	read: (key: string) => Promise<T>,
	isHit: (value: T) => boolean,
): Promise<{ key: string; value: T } | null> {
	let last: { key: string; value: T } | null = null
	for (const key of keys) {
		const value = await read(key)
		last = { key, value }
		if (isHit(value)) return last
	}
	return last
}

async function mapAaListToEoa(provider: ethers.Provider, addrs: string[]): Promise<string[]> {
	return Promise.all(addrs.map((a) => resolveReferrerRegistryAaToEoa(provider, a)))
}

export async function readCardProgramReferrerChainSummary(
	cardAddress: string,
): Promise<CardProgramReferrerChainSummary> {
	try {
		const { card } = await cardReferrerReadContract(cardAddress)
		const [referrerTotal, registeredTotal] = await Promise.all([
			card.referrerTotalCount() as Promise<bigint>,
			card.registeredRefereeTotalCount() as Promise<bigint>,
		])
		return {
			referrerTotalCount: bigintToCount(referrerTotal),
			registeredRefereeTotalCount: bigintToCount(registeredTotal),
		}
	} catch {
		return { referrerTotalCount: null, registeredRefereeTotalCount: null }
	}
}

export async function readReferrerRewardBalance(cardAddress: string, referrerAA: string): Promise<string | null> {
	try {
		if (!ethers.isAddress(referrerAA)) return null
		const { card, provider } = await cardReferrerReadContract(cardAddress)
		const keys = await resolveReferrerRegistryLookupKeys(provider, referrerAA)
		const picked = await pickLookupWithPreferredHit(
			keys,
			async (key) => (await card.balanceOf(key, REFERRER_REWARD_TOKEN_ID)) as bigint,
			(raw) => raw > 0n,
		)
		return picked ? picked.value.toString() : null
	} catch {
		return null
	}
}

export async function readRefereeChargePointsTotal6(cardAddress: string, refereeAA: string): Promise<string | null> {
	try {
		if (!ethers.isAddress(refereeAA)) return null
		const { card, provider } = await cardReferrerReadContract(cardAddress)
		const keys = await resolveReferrerRegistryLookupKeys(provider, refereeAA)
		const picked = await pickLookupWithPreferredHit(
			keys,
			async (key) => (await card.refereeChargePointsTotal6(key)) as bigint,
			(raw) => raw > 0n,
		)
		return picked ? picked.value.toString() : null
	} catch {
		return null
	}
}

export async function readRefereeCountByReferrer(cardAddress: string, referrerAA: string): Promise<number | null> {
	try {
		if (!ethers.isAddress(referrerAA)) return null
		const { card, provider } = await cardReferrerReadContract(cardAddress)
		const keys = await resolveReferrerRegistryLookupKeys(provider, referrerAA)
		const picked = await pickLookupWithPreferredHit(
			keys,
			async (key) => bigintToCount((await card.refereeCountByReferrer(key)) as bigint),
			(n) => n != null && n > 0,
		)
		return picked?.value ?? null
	} catch {
		return null
	}
}

/**
 * API rows keep `referrerAa` / `refereeAa` field names for clients, but values are **EOA**
 * (chain index still uses AA internally).
 */
export type ChainReferrersPage = {
	ok: true
	referrers: Array<{ referrerAa: string; refereeCount: number | null; referrerRewardBalance: string | null }>
	total: number
	nextOffset: number
} | { ok: false }

export async function readReferrersPageFromChain(
	cardAddress: string,
	offset: number,
	pageSize: number,
): Promise<ChainReferrersPage> {
	try {
		const { card, provider } = await cardReferrerReadContract(cardAddress)
		const [referrers, balances, total, nextOffset] = (await card.getReferrersPage(
			BigInt(offset),
			BigInt(pageSize),
		)) as [string[], bigint[], bigint, bigint]
		const items = await Promise.all(
			referrers.map(async (addr, i) => {
				const referrerAaOnChain = ethers.getAddress(addr)
				const referrerEoa = await resolveReferrerRegistryAaToEoa(provider, referrerAaOnChain)
				return {
					referrerAa: referrerEoa,
					refereeCount: await readRefereeCountByReferrer(cardAddress, referrerAaOnChain),
					referrerRewardBalance:
						balances[i] != null
							? balances[i]!.toString()
							: await readReferrerRewardBalance(cardAddress, referrerAaOnChain),
				}
			}),
		)
		return {
			ok: true,
			referrers: items,
			total: bigintToCount(total) ?? items.length,
			nextOffset: bigintToCount(nextOffset) ?? offset + items.length,
		}
	} catch {
		return { ok: false }
	}
}

export type ChainRefereesByReferrerPage = {
	ok: true
	/** EOA (query may have been AA or EOA). */
	referrerEoa: string
	referees: Array<{ refereeAa: string; referrerAa: string; refereeChargePointsTotal6: string | null }>
	total: number
	nextOffset: number
} | { ok: false }

export async function readRefereesByReferrerPageFromChain(
	cardAddress: string,
	referrerEoaOrAa: string,
	offset: number,
	pageSize: number,
): Promise<ChainRefereesByReferrerPage> {
	try {
		if (!ethers.isAddress(referrerEoaOrAa)) return { ok: false }
		const { card, provider } = await cardReferrerReadContract(cardAddress)
		const keys = await resolveReferrerRegistryLookupKeys(provider, referrerEoaOrAa)
		if (keys.length === 0) return { ok: false }
		let referrerLookup = keys[0]!
		let page: [string[], bigint[], bigint, bigint] | null = null
		for (const key of keys) {
			try {
				const tuple = (await card.getRefereesByReferrerPage(
					key,
					BigInt(offset),
					BigInt(pageSize),
				)) as [string[], bigint[], bigint, bigint]
				page = tuple
				referrerLookup = key
				if ((bigintToCount(tuple[2]) ?? 0) > 0) break
			} catch {
				/* try next key */
			}
		}
		if (!page) return { ok: false }
		const [referees, chargeTotals, total, nextOffset] = page
		const referrerEoa = await resolveReferrerRegistryAaToEoa(provider, referrerLookup)
		const refereeEoas = await mapAaListToEoa(provider, referees)
		return {
			ok: true,
			referrerEoa,
			referees: refereeEoas.map((refereeEoa, i) => ({
				refereeAa: refereeEoa,
				referrerAa: referrerEoa,
				refereeChargePointsTotal6: chargeTotals[i] != null ? chargeTotals[i]!.toString() : null,
			})),
			total: bigintToCount(total) ?? referees.length,
			nextOffset: bigintToCount(nextOffset) ?? offset + referees.length,
		}
	} catch {
		return { ok: false }
	}
}

export type ChainRegisteredRefereesPage = {
	ok: true
	referees: Array<{ refereeAa: string; referrerAa: string | null }>
	total: number
	nextOffset: number
} | { ok: false }

export async function readRegisteredRefereesPageFromChain(
	cardAddress: string,
	offset: number,
	pageSize: number,
): Promise<ChainRegisteredRefereesPage> {
	try {
		const { card, provider } = await cardReferrerReadContract(cardAddress)
		const [referees, total, nextOffset] = (await card.getRegisteredRefereesPage(
			BigInt(offset),
			BigInt(pageSize),
		)) as [string[], bigint, bigint]
		const items = await Promise.all(
			referees.map(async (addr) => {
				const refereeAaOnChain = ethers.getAddress(addr)
				const refereeEoa = await resolveReferrerRegistryAaToEoa(provider, refereeAaOnChain)
				let referrerEoa: string | null = null
				try {
					const up = ethers.getAddress((await card.refereeReferrer(refereeAaOnChain)) as string)
					if (up !== ethers.ZeroAddress) {
						referrerEoa = await resolveReferrerRegistryAaToEoa(provider, up)
					}
				} catch {
					referrerEoa = null
				}
				return { refereeAa: refereeEoa, referrerAa: referrerEoa }
			}),
		)
		return {
			ok: true,
			referees: items,
			total: bigintToCount(total) ?? items.length,
			nextOffset: bigintToCount(nextOffset) ?? offset + items.length,
		}
	} catch {
		return { ok: false }
	}
}
