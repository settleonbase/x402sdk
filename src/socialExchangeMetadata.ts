/** Social points (#13) exchange activity metadata on issued coupon series. */

export type SocialExchangeKind = 'coupon' | 'usdc'

export type SocialExchangeConfig = {
	enabled: boolean
	kind: SocialExchangeKind
	/** #13 units burned per claim. */
	pointsCost: number
	/** CONET-USDC 6-decimal reward when kind=usdc; 0 for coupon-only. */
	usdcReward6: bigint
}

function parsePositiveInt(raw: unknown): number | null {
	if (raw == null || raw === '') return null
	const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10)
	if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null
	return n
}

function parseUsdcReward6(raw: unknown): bigint | null {
	if (raw == null || raw === '') return null
	try {
		const v = BigInt(String(raw).trim())
		if (v <= 0n) return null
		return v
	} catch {
		return null
	}
}

function normalizeSocialExchangePayload(raw: Record<string, unknown>): SocialExchangeConfig | null {
	const points = parsePositiveInt(raw.pointsCost ?? raw.points_cost ?? raw.points13)
	if (points == null) return null
	const kindRaw = String(raw.kind ?? raw.exchangeKind ?? 'coupon').trim().toLowerCase()
	const kind: SocialExchangeKind = kindRaw === 'usdc' ? 'usdc' : 'coupon'
	const usdcReward6 =
		kind === 'usdc'
			? (parseUsdcReward6(raw.usdcReward6 ?? raw.usdc_reward6 ?? raw.usdcAmount6) ?? null)
			: 0n
	if (kind === 'usdc' && (usdcReward6 == null || usdcReward6 <= 0n)) return null
	if (raw.enabled === false) return null
	return {
		enabled: true,
		kind,
		pointsCost: points,
		usdcReward6: usdcReward6 ?? 0n,
	}
}

export function readSocialExchangeFromMetadata(
	meta: Record<string, unknown> | null | undefined,
): SocialExchangeConfig | null {
	if (!meta) return null
	const direct = meta.socialExchange
	if (direct && typeof direct === 'object') {
		return normalizeSocialExchangePayload(direct as Record<string, unknown>)
	}
	const beamioCoupon = meta.beamioCoupon
	if (beamioCoupon && typeof beamioCoupon === 'object') {
		const nested = (beamioCoupon as Record<string, unknown>).socialExchange
		if (nested && typeof nested === 'object') {
			return normalizeSocialExchangePayload(nested as Record<string, unknown>)
		}
	}
	const properties = meta.properties
	if (properties && typeof properties === 'object') {
		const bc = (properties as Record<string, unknown>).beamioCoupon
		if (bc && typeof bc === 'object') {
			const nested = (bc as Record<string, unknown>).socialExchange
			if (nested && typeof nested === 'object') {
				return normalizeSocialExchangePayload(nested as Record<string, unknown>)
			}
		}
	}
	return null
}

export const REWARD_VOUCHER_TOKEN_ID = 13n
