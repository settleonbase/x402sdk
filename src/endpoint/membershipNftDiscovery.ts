/**
 * Discover membership NFTs that exist as ERC-1155 balances but are missing from
 * `_userOwnedNfts` / `getOwnership` inventory (orphaned membership ledger).
 *
 * Also merges getOwnership across EOA + AA when both hold assets.
 */
import { ethers } from 'ethers'
import {
	isMembershipNftTokenId,
	MEMBERSHIP_NFT_MIN_ID,
	MEMBERSHIP_NFT_MAX_EXCLUSIVE,
} from '../membershipFeeMetadata'
import { listMembershipNftTierTokenIdsByCard } from '../db'

/** Matches on-chain `NFTDetail` / getUIDAssets ownership rows. */
export type OwnershipNftRow = {
	tokenId: bigint
	attribute: bigint
	tierIndexOrMax: bigint
	expiry: bigint
	isExpired: boolean
}

export type OwnershipSnapshot = {
	points: bigint
	nfts: OwnershipNftRow[]
}

const OWNERSHIP_ABI = [
	'function getOwnership(address user) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function nftAttributes(uint256 tokenId) view returns (uint256 attr)',
	'function nftExpiresAt(uint256 tokenId) view returns (uint256)',
	'function expiresAt(uint256 tokenId) view returns (uint256)',
	'function nftTierIndexOrMax(uint256 tokenId) view returns (uint256)',
	'function tokenTierIndexOrMax(uint256 tokenId) view returns (uint256)',
	'function activeMembershipId(address user) view returns (uint256)',
	'function totalMembershipIssued() view returns (uint256)',
] as const

const MEMBERSHIP_BALANCE_PROBE_SPAN = 64n
const MEMBERSHIP_BALANCE_PROBE_HARD_CAP = 256n

function nftKey(n: OwnershipNftRow): string {
	return String(n.tokenId)
}

export function mergeOwnershipSnapshots(
	...parts: Array<OwnershipSnapshot | null | undefined>
): OwnershipSnapshot {
	let points = 0n
	const byId = new Map<string, OwnershipNftRow>()
	for (const part of parts) {
		if (!part) continue
		points += part.points
		for (const n of part.nfts) {
			const k = nftKey(n)
			if (!byId.has(k)) byId.set(k, n)
		}
	}
	return { points, nfts: Array.from(byId.values()) }
}

function normalizeOwnershipNfts(nftsRaw: unknown): OwnershipNftRow[] {
	if (!Array.isArray(nftsRaw)) return []
	return nftsRaw.map((n: any) => {
		const tokenId = BigInt(n.tokenId ?? n[0] ?? 0)
		const attribute = BigInt(n.attribute ?? n[1] ?? 0)
		const tierIndexOrMax = BigInt(n.tierIndexOrMax ?? n[2] ?? 0)
		const expiry = BigInt(n.expiry ?? n[3] ?? 0)
		const isExpired = Boolean(n.isExpired ?? n[4] ?? false)
		return { tokenId, attribute, tierIndexOrMax, expiry, isExpired }
	})
}

export async function readOwnershipSnapshot(
	card: ethers.Contract,
	holder: string
): Promise<OwnershipSnapshot | null> {
	try {
		const raw = await card.getOwnership(holder)
		const points = BigInt(raw?.pt ?? raw?.points ?? raw?.[0] ?? 0)
		const nfts = normalizeOwnershipNfts(raw?.nfts ?? raw?.[1])
		return { points, nfts }
	} catch {
		return null
	}
}

async function readExpiry(card: ethers.Contract, tokenId: bigint): Promise<bigint> {
	try {
		return BigInt(await card.nftExpiresAt(tokenId))
	} catch {
		try {
			return BigInt(await card.expiresAt(tokenId))
		} catch {
			return 0n
		}
	}
}

async function readTierIndexOrMax(card: ethers.Contract, tokenId: bigint): Promise<bigint> {
	try {
		return BigInt(await card.nftTierIndexOrMax(tokenId))
	} catch {
		try {
			return BigInt(await card.tokenTierIndexOrMax(tokenId))
		} catch {
			return ethers.MaxUint256
		}
	}
}

async function readMembershipNftRowIfHeld(
	card: ethers.Contract,
	holder: string,
	tokenId: bigint,
	nowSec: bigint
): Promise<OwnershipNftRow | null> {
	if (!isMembershipNftTokenId(tokenId)) return null
	try {
		const bal = await card.balanceOf(holder, tokenId)
		if (BigInt(bal ?? 0) <= 0n) return null
		const [attrRaw, expiry, tierIndexOrMax] = await Promise.all([
			card.nftAttributes(tokenId).catch(() => 0n),
			readExpiry(card, tokenId),
			readTierIndexOrMax(card, tokenId),
		])
		const attribute = BigInt(attrRaw ?? 0)
		const isExpired = expiry > 0n && expiry <= nowSec
		if (isExpired) return null
		return { tokenId, attribute, tierIndexOrMax, expiry, isExpired: false }
	} catch {
		return null
	}
}

async function listMembershipNftTierTokenIdsByCardSafe(cardAddress: string): Promise<bigint[]> {
	try {
		const rows = await listMembershipNftTierTokenIdsByCard(cardAddress)
		if (!Array.isArray(rows)) return []
		return rows
			.map((tid) => {
				try {
					return BigInt(tid)
				} catch {
					return 0n
				}
			})
			.filter((tid) => isMembershipNftTokenId(tid))
	} catch {
		return []
	}
}

async function collectMembershipTokenIdCandidates(
	card: ethers.Contract,
	cardAddress: string,
	holders: string[]
): Promise<bigint[]> {
	const ids = new Set<string>()
	const add = (raw: unknown) => {
		try {
			const tid = typeof raw === 'bigint' ? raw : BigInt(String(raw ?? '').trim() || '0')
			if (isMembershipNftTokenId(tid)) ids.add(tid.toString())
		} catch {
			/* ignore */
		}
	}

	// Always probe the first membership id (#100) — common orphan after bootstrap.
	ids.add(MEMBERSHIP_NFT_MIN_ID.toString())

	for (const holder of holders) {
		try {
			add(await card.activeMembershipId(holder))
		} catch {
			/* ignore */
		}
	}

	try {
		const total = BigInt(await card.totalMembershipIssued().catch(() => 0n))
		const span =
			total > 0n && total < MEMBERSHIP_BALANCE_PROBE_HARD_CAP
				? total
				: MEMBERSHIP_BALANCE_PROBE_SPAN
		const end = MEMBERSHIP_NFT_MIN_ID + span
		for (let tid = MEMBERSHIP_NFT_MIN_ID; tid < end && tid < MEMBERSHIP_NFT_MAX_EXCLUSIVE; tid++) {
			ids.add(tid.toString())
		}
	} catch {
		for (let i = 0n; i < MEMBERSHIP_BALANCE_PROBE_SPAN; i++) {
			ids.add((MEMBERSHIP_NFT_MIN_ID + i).toString())
		}
	}

	try {
		const fromDb = await listMembershipNftTierTokenIdsByCardSafe(cardAddress)
		for (const tid of fromDb) add(tid)
	} catch {
		/* ignore */
	}

	return Array.from(ids)
		.map((s) => BigInt(s))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * When inventory-backed ownership has no membership NFT, probe balanceOf for
 * membership tokenIds on each holder (EOA and/or AA).
 */
export async function discoverOrphanMembershipNfts(input: {
	provider: ethers.Provider
	cardAddress: string
	holders: string[]
	existingNfts?: OwnershipNftRow[]
}): Promise<OwnershipNftRow[]> {
	const holders = Array.from(
		new Set(
			input.holders
				.map((h) => {
					try {
						return ethers.getAddress(String(h || '').trim())
					} catch {
						return ''
					}
				})
				.filter(Boolean)
		)
	)
	if (!holders.length) return []

	const existing = input.existingNfts ?? []
	const hasMembershipInInventory = existing.some((n) => isMembershipNftTokenId(n.tokenId) && !n.isExpired)
	if (hasMembershipInInventory) return []

	const card = new ethers.Contract(input.cardAddress, OWNERSHIP_ABI, input.provider)
	const nowSec = BigInt(Math.floor(Date.now() / 1000))
	const candidates = await collectMembershipTokenIdCandidates(card, input.cardAddress, holders)
	const found = new Map<string, OwnershipNftRow>()

	await Promise.all(
		holders.flatMap((holder) =>
			candidates.map(async (tid) => {
				const row = await readMembershipNftRowIfHeld(card, holder, tid, nowSec)
				if (!row) return
				const k = nftKey(row)
				if (!found.has(k)) found.set(k, row)
			})
		)
	)

	return Array.from(found.values())
}

/**
 * Resolve ownership for wallet assets: merge EOA + AA getOwnership, then
 * discover orphan membership NFTs via balanceOf when inventory is empty.
 */
export async function resolveMergedCardOwnership(input: {
	provider: ethers.Provider
	cardAddress: string
	eoa: string
	aaAddress?: string | null
}): Promise<OwnershipSnapshot> {
	const card = new ethers.Contract(input.cardAddress, OWNERSHIP_ABI, input.provider)
	let eoa = ''
	let aa = ''
	try {
		eoa = ethers.getAddress(String(input.eoa || '').trim())
	} catch {
		eoa = ''
	}
	try {
		aa = input.aaAddress ? ethers.getAddress(String(input.aaAddress).trim()) : ''
	} catch {
		aa = ''
	}

	const holders = Array.from(new Set([eoa, aa].filter(Boolean)))
	const snaps = await Promise.all(holders.map((h) => readOwnershipSnapshot(card, h)))
	let merged = mergeOwnershipSnapshots(...snaps)

	// Prefer ERC-1155 #0 balances when inventory points are 0 but either wallet holds points.
	if (merged.points === 0n && holders.length) {
		try {
			let sum = 0n
			for (const h of holders) {
				sum += BigInt(await card.balanceOf(h, 0).catch(() => 0n))
			}
			if (sum > 0n) merged = { ...merged, points: sum }
		} catch {
			/* keep inventory points */
		}
	}

	const orphans = await discoverOrphanMembershipNfts({
		provider: input.provider,
		cardAddress: input.cardAddress,
		holders,
		existingNfts: merged.nfts,
	})
	if (orphans.length) {
		merged = mergeOwnershipSnapshots(merged, { points: 0n, nfts: orphans })
	}
	return merged
}

/**
 * True if EOA or AA holds a non-expired membership NFT (inventory or orphan balance).
 * Does not trust dirty activeMembershipId ∈ [1, 99].
 */
export async function holderHasValidMembershipNft(input: {
	provider: ethers.Provider
	cardAddress: string
	eoa: string
	aaAddress?: string | null
}): Promise<boolean> {
	const ownership = await resolveMergedCardOwnership(input)
	return ownership.nfts.some((n) => isMembershipNftTokenId(n.tokenId) && !n.isExpired)
}
