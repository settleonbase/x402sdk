import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import {
	isApiExcludedUserCard,
	normalizeUserCardAddressLower,
	registerDynamicApiExcludedUserCard,
	setDynamicApiExcludedUserCards,
} from './apiExcludedUserCards'
import { getCardByAddress, insertApiExcludedUserCard, listApiExcludedUserCardAddressesFromDb } from './db'
import { providerForUserCardChain } from './beamioUserCardChain'

export const EXCLUDE_USER_CARD_SIGN_PREFIX = 'Beamio excludeUserCard:v1'

export function buildExcludeUserCardSignMessage(
	cardAddress: string,
	deadline: number,
	nonce: string
): string {
	return `${EXCLUDE_USER_CARD_SIGN_PREFIX}\n${ethers.getAddress(cardAddress)}\n${deadline}\n${nonce}`
}

export async function warmDynamicApiExcludedUserCardsFromDb(): Promise<void> {
	const rows = await listApiExcludedUserCardAddressesFromDb()
	setDynamicApiExcludedUserCards(rows.map((a) => a.toLowerCase()))
	logger(
		Colors.green(
			`[warmDynamicApiExcludedUserCardsFromDb] loaded ${rows.length} dynamic exclude(s)`
		)
	)
}

async function resolveExcludeUserCardOwnerCandidates(cardAddress: string): Promise<Set<string>> {
	const out = new Set<string>()
	const cardAddr = ethers.getAddress(cardAddress)
	const ownerAbi = ['function owner() view returns (address)'] as const
	for (const chain of ['conet', 'base'] as const) {
		try {
			const cardProvider = providerForUserCardChain(chain)
			const code = await cardProvider.getCode(cardAddr)
			if (!code || code === '0x') continue
			const card = new ethers.Contract(cardAddr, ownerAbi, cardProvider)
			const owner = await card.owner()
			if (owner && ethers.isAddress(owner)) {
				out.add(ethers.getAddress(owner).toLowerCase())
				break
			}
		} catch {
			/* try other chain */
		}
	}
	const row = await getCardByAddress(cardAddress)
	if (row?.cardOwner && ethers.isAddress(row.cardOwner)) {
		out.add(ethers.getAddress(row.cardOwner).toLowerCase())
	}
	return out
}

export async function excludeUserCardPreCheck(params: {
	cardAddress: string
	ownerEOA: string
	deadline: number
	nonce: string
	ownerSignature: string
}): Promise<{ success: true } | { success: false; error: string }> {
	const cardAddress = typeof params.cardAddress === 'string' ? params.cardAddress.trim() : ''
	if (!cardAddress || !ethers.isAddress(cardAddress)) {
		return { success: false, error: 'Invalid or missing cardAddress' }
	}
	const ownerEOA = typeof params.ownerEOA === 'string' ? params.ownerEOA.trim() : ''
	if (!ownerEOA || !ethers.isAddress(ownerEOA)) {
		return { success: false, error: 'Invalid or missing ownerEOA' }
	}
	const { deadline, nonce, ownerSignature } = params
	if (!Number.isInteger(deadline)) {
		return { success: false, error: 'Invalid deadline' }
	}
	const now = Math.floor(Date.now() / 1000)
	if (deadline <= now) {
		return { success: false, error: 'Deadline expired' }
	}
	if (!ethers.isHexString(nonce, 32)) {
		return { success: false, error: 'Invalid nonce' }
	}
	if (!/^0x[0-9a-fA-F]{130}$/.test(String(ownerSignature))) {
		return { success: false, error: 'Invalid ownerSignature' }
	}

	const cardNorm = ethers.getAddress(cardAddress)
	if (isApiExcludedUserCard(cardNorm)) {
		return { success: true }
	}

	let recovered: string
	try {
		const message = buildExcludeUserCardSignMessage(cardNorm, deadline, nonce)
		recovered = ethers.getAddress(ethers.verifyMessage(message, ownerSignature))
	} catch {
		return { success: false, error: 'Invalid owner signature' }
	}

	const ownerCandidates = await resolveExcludeUserCardOwnerCandidates(cardNorm)
	if (ownerCandidates.size === 0) {
		return {
			success: false,
			error:
				'Could not verify card owner on-chain or in programs database. Ensure this address is a deployed BeamioUserCard you own.',
		}
	}
	const signerLower = recovered.toLowerCase()
	if (!ownerCandidates.has(signerLower)) {
		return { success: false, error: 'Signer is not card owner' }
	}
	if (signerLower !== ethers.getAddress(ownerEOA).toLowerCase()) {
		return { success: false, error: 'ownerEOA does not match signature' }
	}

	return { success: true }
}

export async function applyExcludeUserCard(params: {
	cardAddress: string
	excludedBy: string
}): Promise<{ success: boolean; cardAddress?: string; error?: string }> {
	const lower = normalizeUserCardAddressLower(params.cardAddress)
	if (!lower) {
		return { success: false, error: 'Invalid cardAddress' }
	}
	const excludedBy = normalizeUserCardAddressLower(params.excludedBy)
	if (!excludedBy) {
		return { success: false, error: 'Invalid excludedBy' }
	}

	if (isApiExcludedUserCard(lower)) {
		registerDynamicApiExcludedUserCard(lower)
		return { success: true, cardAddress: ethers.getAddress(lower) }
	}

	const inserted = await insertApiExcludedUserCard({
		cardAddress: lower,
		excludedBy,
	})
	if (!inserted.ok) {
		return { success: false, error: inserted.error }
	}
	registerDynamicApiExcludedUserCard(lower)
	logger(Colors.yellow(`[applyExcludeUserCard] blacklisted card=${ethers.getAddress(lower)} by=${ethers.getAddress(excludedBy)}`))
	return { success: true, cardAddress: ethers.getAddress(lower) }
}
