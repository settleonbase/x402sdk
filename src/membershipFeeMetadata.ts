/**
 * Membership-fee cards: metadata is the source of truth (not on-chain setMembershipFees).
 * CoNET Factory AndTiers uses 3-tuple Tier (no upgradeByBalance); membership-fee cards skip Factory tiers entirely.
 */
import { getCardByAddress } from './db'

export type MembershipFeeMetadataTier = {
	index?: number
	chainTierIndex?: number
	membershipFeeE6?: string
	membershipFee?: string | number
	membershipDurationKind?: number
	minUsdc6?: string | number
	attr?: number
}

/** Human fee → E6 string; empty/invalid → "0". */
export function membershipFeeHumanToE6(raw: string | number | undefined | null): string {
	if (raw == null || raw === '') return '0'
	const s = String(raw).replace(/,/g, '').trim()
	if (!s) return '0'
	const n = Number(s)
	if (!Number.isFinite(n) || n <= 0) return '0'
	return String(Math.round(n * 1e6))
}

export function metadataTierMembershipFeeE6(row: MembershipFeeMetadataTier): string {
	if (row.membershipFeeE6 && BigInt(row.membershipFeeE6) > 0n) return row.membershipFeeE6
	return membershipFeeHumanToE6(row.membershipFee)
}

export function metadataTierOnChainIndex(row: MembershipFeeMetadataTier, fallbackIndex: number): number {
	if (typeof row.index === 'number' && Number.isFinite(row.index)) return Math.trunc(row.index)
	if (typeof row.chainTierIndex === 'number' && Number.isFinite(row.chainTierIndex)) {
		return Math.trunc(row.chainTierIndex)
	}
	return fallbackIndex
}

export function tiersPayloadHaveMembershipFee(
	tiers: MembershipFeeMetadataTier[] | undefined | null,
): boolean {
	if (!tiers?.length) return false
	return tiers.some((t) => BigInt(metadataTierMembershipFeeE6(t)) > 0n)
}

/** Build fee arrays indexed by on-chain tier index from metadata tiers payload. */
export function membershipFeesFromMetadataTiers(
	tiers: MembershipFeeMetadataTier[],
): { feeE6: bigint[]; durationKind: number[] } {
	const feeE6: bigint[] = []
	const durationKind: number[] = []
	tiers.forEach((row, i) => {
		const idx = metadataTierOnChainIndex(row, i)
		const fee = BigInt(metadataTierMembershipFeeE6(row))
		const dk = Number(row.membershipDurationKind ?? 0)
		while (feeE6.length <= idx) {
			feeE6.push(0n)
			durationKind.push(0)
		}
		feeE6[idx] = fee
		durationKind[idx] = dk
	})
	return { feeE6, durationKind }
}

export function extractMetadataTiers(
	metadata: Record<string, unknown> | null | undefined,
): MembershipFeeMetadataTier[] {
	if (!metadata || typeof metadata !== 'object') return []
	const raw = metadata.tiers
	if (!Array.isArray(raw)) return []
	return raw.filter((t): t is MembershipFeeMetadataTier => t != null && typeof t === 'object')
}

/** Metadata-backed membership fees; null when DB row missing or no fee tiers in metadata. */
export async function readMembershipFeesFromCardMetadata(
	cardAddrRaw: string,
): Promise<{ feeE6: bigint[]; durationKind: number[] } | null> {
	try {
		const row = await getCardByAddress(cardAddrRaw.trim())
		if (!row?.metadata) return null
		const tiers = extractMetadataTiers(row.metadata)
		if (!tiers.length || !tiersPayloadHaveMembershipFee(tiers)) return null
		return membershipFeesFromMetadataTiers(tiers)
	} catch {
		return null
	}
}

/** true = metadata declares membership fees; false = metadata tiers exist but no fees; null = no metadata signal. */
export async function readCardMembershipFeeModeFromMetadata(
	cardAddrRaw: string,
): Promise<boolean | null> {
	const fees = await readMembershipFeesFromCardMetadata(cardAddrRaw)
	if (fees != null) return fees.feeE6.some((f) => f > 0n)
	try {
		const row = await getCardByAddress(cardAddrRaw.trim())
		if (!row?.metadata) return null
		const tiers = extractMetadataTiers(row.metadata)
		if (tiers.length > 0) return false
	} catch {
		/* fall through */
	}
	return null
}

/** Membership-fee cards must not pass tiers to Factory AndTiers (use initCode-only create). */
export function shouldSkipFactoryTiersForCreate(
	tiers: MembershipFeeMetadataTier[] | undefined | null,
): boolean {
	return tiersPayloadHaveMembershipFee(tiers ?? [])
}

export const MEMBERSHIP_FEE_CHECK_BALANCE_HINT =
	'Active membership required. Purchase membership from Check Balance before top-up.'
