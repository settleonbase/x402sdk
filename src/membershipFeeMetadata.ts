/**
 * Membership-fee cards: metadata is the source of truth (not on-chain setMembershipFees).
 * CoNET Factory AndTiers uses 3-tuple Tier (no upgradeByBalance); membership-fee cards skip Factory tiers entirely.
 *
 * Product model: baseMembership = index 0 (not Add-tier); tiers[] = higher paid memberships only.
 * Membership NFT tokenId ∈ [100, 1e11). Leftover #0 is program points, not a membership NFT.
 */
import { getCardByAddress } from './db'

/** Membership NFT tokenId lower bound (inclusive). */
export const MEMBERSHIP_NFT_MIN_ID = 100n
/** Membership NFT tokenId upper bound (exclusive); issued NFT / coupon ids start here. */
export const MEMBERSHIP_NFT_MAX_EXCLUSIVE = 100_000_000_000n

export function isMembershipNftTokenId(tokenId: bigint | number | string | null | undefined): boolean {
	if (tokenId == null) return false
	try {
		const tid =
			typeof tokenId === 'bigint'
				? tokenId
				: typeof tokenId === 'number' && Number.isFinite(tokenId)
					? BigInt(Math.floor(tokenId))
					: BigInt(String(tokenId).trim())
		return tid >= MEMBERSHIP_NFT_MIN_ID && tid < MEMBERSHIP_NFT_MAX_EXCLUSIVE
	} catch {
		return false
	}
}

export type MembershipFeeMetadataTiers = {
	index?: number
	chainTierIndex?: number
	membershipFeeE6?: string
	membershipFee?: string | number
	membershipDurationKind?: number
	minUsdc6?: string | number
	attr?: number
	name?: string
}

/** Card-level base membership (index 0); not an Add-tier row. */
export type MembershipFeeMetadataBase = {
	membershipFeeE6?: string
	membershipFee?: string | number
	membershipDurationKind?: number
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

export function metadataTierMembershipFeeE6(row: MembershipFeeMetadataTiers | MembershipFeeMetadataBase): string {
	if (row.membershipFeeE6 && BigInt(row.membershipFeeE6) > 0n) return row.membershipFeeE6
	return membershipFeeHumanToE6(row.membershipFee)
}

export function metadataTierOnChainIndex(row: MembershipFeeMetadataTiers, fallbackIndex: number): number {
	if (typeof row.index === 'number' && Number.isFinite(row.index)) return Math.trunc(row.index)
	if (typeof row.chainTierIndex === 'number' && Number.isFinite(row.chainTierIndex)) {
		return Math.trunc(row.chainTierIndex)
	}
	return fallbackIndex
}

export function parseBaseMembership(
	raw: unknown,
): MembershipFeeMetadataBase | null {
	if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
	const o = raw as Record<string, unknown>
	const feeE6 = metadataTierMembershipFeeE6({
		membershipFeeE6: o.membershipFeeE6 != null ? String(o.membershipFeeE6) : undefined,
		membershipFee: o.membershipFee as string | number | undefined,
	})
	if (BigInt(feeE6) <= 0n) return null
	const dkRaw = o.membershipDurationKind
	const dk = dkRaw == null ? 0 : Number(dkRaw)
	return {
		membershipFeeE6: feeE6,
		...(o.membershipFee != null && { membershipFee: o.membershipFee as string | number }),
		membershipDurationKind: Number.isFinite(dk) ? Math.trunc(dk) : 0,
	}
}

export function baseMembershipFeeE6(
	metadata: Record<string, unknown> | null | undefined,
): string {
	if (!metadata) return '0'
	const base = parseBaseMembership(metadata.baseMembership)
	return base ? metadataTierMembershipFeeE6(base) : '0'
}

export function tiersPayloadHaveMembershipFee(
	tiers: MembershipFeeMetadataTiers[] | undefined | null,
): boolean {
	if (!tiers?.length) return false
	return tiers.some((t) => BigInt(metadataTierMembershipFeeE6(t)) > 0n)
}

/** Build fee arrays indexed by on-chain tier index from metadata tiers payload (incl. synthesized base at 0). */
export function membershipFeesFromMetadataTiers(
	tiers: MembershipFeeMetadataTiers[],
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

/**
 * Extract membership fee rows for API/POS:
 * - If baseMembership.fee > 0 → index 0 from baseMembership; tiers[] become indices 1+
 * - Legacy: no baseMembership but tiers[0].fee > 0 → treat tiers[0] as base (index 0)
 */
export function extractMetadataTiers(
	metadata: Record<string, unknown> | null | undefined,
): MembershipFeeMetadataTiers[] {
	if (!metadata || typeof metadata !== 'object') return []
	const base = parseBaseMembership(metadata.baseMembership)
	const raw = metadata.tiers
	const higher: MembershipFeeMetadataTiers[] = Array.isArray(raw)
		? raw.filter((t): t is MembershipFeeMetadataTiers => t != null && typeof t === 'object')
		: []

	if (base) {
		const out: MembershipFeeMetadataTiers[] = [
			{
				index: 0,
				membershipFeeE6: metadataTierMembershipFeeE6(base),
				membershipDurationKind: base.membershipDurationKind ?? 0,
				minUsdc6: '1',
			},
		]
		higher.forEach((row, i) => {
			out.push({
				...row,
				index: typeof row.index === 'number' && Number.isFinite(row.index) ? Math.trunc(row.index) : i + 1,
			})
		})
		return out
	}

	// Legacy: no baseMembership — tiers[] as-is (tiers[0] may be base)
	return higher.map((row, i) => ({
		...row,
		index: typeof row.index === 'number' && Number.isFinite(row.index) ? Math.trunc(row.index) : i,
	}))
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
		const meta = row.metadata as Record<string, unknown>
		if (BigInt(baseMembershipFeeE6(meta)) > 0n) return true
		const tiers = extractMetadataTiers(meta)
		if (tiers.length > 0) return false
	} catch {
		/* fall through */
	}
	return null
}

/**
 * Membership-fee cards must not pass tiers to Factory AndTiers (use initCode-only create).
 * Pass optional metadata so baseMembership-only cards (no tiers[]) still skip AndTiers.
 * Loyalty cards with only the default/base row skip AndTiers in CCSA (`isBasicOnlyCreateCardTiers`).
 */
export function shouldSkipFactoryTiersForCreate(
	tiers: MembershipFeeMetadataTiers[] | undefined | null,
	metadata?: Record<string, unknown> | null,
): boolean {
	if (tiersPayloadHaveMembershipFee(tiers ?? [])) return true
	if (metadata && BigInt(baseMembershipFeeE6(metadata)) > 0n) return true
	return false
}

/**
 * Validate publish shape: base fee > 0 ⇒ duration 1–6; each higher tier fee strictly > previous.
 * Returns English error or null if OK.
 */
export function validateMembershipFeePublishShape(opts: {
	baseMembership?: MembershipFeeMetadataBase | null
	tiers?: MembershipFeeMetadataTiers[] | null
}): string | null {
	const base = opts.baseMembership ? parseBaseMembership(opts.baseMembership) : null
	const higher = (opts.tiers ?? []).filter((t) => t != null && typeof t === 'object')
	let prevFee = 0n
	if (base) {
		const fee = BigInt(metadataTierMembershipFeeE6(base))
		const dk = Number(base.membershipDurationKind ?? 0)
		if (fee > 0n && (dk < 1 || dk > 6)) {
			return 'baseMembership.membershipDurationKind must be 1–6 when membershipFeeE6 > 0'
		}
		prevFee = fee
	}
	for (let i = 0; i < higher.length; i++) {
		const fee = BigInt(metadataTierMembershipFeeE6(higher[i]!))
		if (fee <= 0n) continue
		const dk = Number(higher[i]!.membershipDurationKind ?? 0)
		if (dk < 1 || dk > 6) {
			return `tiers[${i}].membershipDurationKind must be 1–6 when membershipFeeE6 > 0`
		}
		if (prevFee > 0n && fee <= prevFee) {
			return base
				? `tiers[${i}].membershipFeeE6 must be strictly greater than baseMembership and previous higher tier`
				: `tiers[${i}].membershipFeeE6 must be strictly greater than previous fee tier`
		}
		prevFee = fee
	}
	return null
}

/**
 * Lock check: once a fee+duration was published for an index, reject changes to fee or duration.
 * prev/next are full metadata objects (or extractable tiers via extractMetadataTiers).
 */
export function membershipFeeLockViolation(
	prevMetadata: Record<string, unknown> | null | undefined,
	nextBase: MembershipFeeMetadataBase | null | undefined,
	nextTiers: MembershipFeeMetadataTiers[] | null | undefined,
): string | null {
	if (!prevMetadata) return null
	const prevRows = extractMetadataTiers(prevMetadata)
	if (!prevRows.length || !tiersPayloadHaveMembershipFee(prevRows)) return null

	const nextMeta: Record<string, unknown> = {
		...(nextBase && { baseMembership: nextBase }),
		...(nextTiers && { tiers: nextTiers }),
	}
	// If caller only sends higher tiers without base, preserve prev base for comparison
	if (!nextBase && prevMetadata.baseMembership != null) {
		nextMeta.baseMembership = prevMetadata.baseMembership
	}
	if (nextTiers === undefined && Array.isArray(prevMetadata.tiers)) {
		nextMeta.tiers = prevMetadata.tiers
	}
	const nextRows = extractMetadataTiers(nextMeta)

	for (const prev of prevRows) {
		const prevFee = BigInt(metadataTierMembershipFeeE6(prev))
		if (prevFee <= 0n) continue
		const idx = metadataTierOnChainIndex(prev, 0)
		const prevDk = Number(prev.membershipDurationKind ?? 0)
		const next = nextRows.find((r) => metadataTierOnChainIndex(r, -1) === idx)
		if (!next) {
			return `Cannot remove published membership fee tier at index ${idx}`
		}
		const nextFee = BigInt(metadataTierMembershipFeeE6(next))
		const nextDk = Number(next.membershipDurationKind ?? 0)
		if (nextFee !== prevFee || nextDk !== prevDk) {
			return `Membership fee and duration are locked for index ${idx} after first publish`
		}
	}
	return null
}

export const MEMBERSHIP_FEE_CHECK_BALANCE_HINT =
	'Active membership required. Purchase membership from Check Balance before top-up.'
