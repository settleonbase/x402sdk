import { ethers } from 'ethers'
import { providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'

const REFERRER_REWARD_TOKEN_ID = 1n

const CARD_REFERRER_READ_ABI = [
	'function referrerTotalCount() view returns (uint256)',
	'function registeredRefereeTotalCount() view returns (uint256)',
	'function refereeCountByReferrer(address referrerAA) view returns (uint256)',
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function refereeChargePointsTotal6(address refereeAA) view returns (uint256)',
] as const

export type CardProgramReferrerChainSummary = {
	referrerTotalCount: number | null
	registeredRefereeTotalCount: number | null
}

async function cardReferrerReadContract(cardAddress: string): Promise<ethers.Contract> {
	const card = ethers.getAddress(cardAddress)
	const chain = await resolveUserCardChain(card)
	const provider = providerForUserCardChain(chain)
	return new ethers.Contract(card, CARD_REFERRER_READ_ABI, provider)
}

function bigintToCount(raw: bigint): number | null {
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null
}

export async function readCardProgramReferrerChainSummary(
	cardAddress: string,
): Promise<CardProgramReferrerChainSummary> {
	try {
		const card = await cardReferrerReadContract(cardAddress)
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
		const card = await cardReferrerReadContract(cardAddress)
		const raw = (await card.balanceOf(ethers.getAddress(referrerAA), REFERRER_REWARD_TOKEN_ID)) as bigint
		return raw.toString()
	} catch {
		return null
	}
}

export async function readRefereeChargePointsTotal6(cardAddress: string, refereeAA: string): Promise<string | null> {
	try {
		if (!ethers.isAddress(refereeAA)) return null
		const card = await cardReferrerReadContract(cardAddress)
		const raw = (await card.refereeChargePointsTotal6(ethers.getAddress(refereeAA))) as bigint
		return raw.toString()
	} catch {
		return null
	}
}

export async function readRefereeCountByReferrer(cardAddress: string, referrerAA: string): Promise<number | null> {
	try {
		if (!ethers.isAddress(referrerAA)) return null
		const card = await cardReferrerReadContract(cardAddress)
		const raw = (await card.refereeCountByReferrer(ethers.getAddress(referrerAA))) as bigint
		return bigintToCount(raw)
	} catch {
		return null
	}
}
