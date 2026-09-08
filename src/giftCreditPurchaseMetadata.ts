/**
 * Discover Credit Gift — merchant program metadata for optional #0 purchase fee.
 *
 * Shape (card0 / metadata_json):
 * {
 *   giftCreditPurchase: {
 *     enabled: false,
 *     feeKind: "percent" | "fixed",
 *     percentBps: 500,   // 5.00% of full gift face G (membership + top-up)
 *     feeE6: "0"         // fixed fee in #0 E6 when feeKind=fixed; may be "0"
 *   }
 * }
 *
 * Default OFF. F may be 0 when enabled. Percent base = entire face G (incl. membership-fee slice).
 * Credit rail must NOT apply Top-up Promotion bonus or mint #13.
 */

export type GiftCreditFeeKind = 'percent' | 'fixed'

export type GiftCreditPurchaseConfig = {
	enabled: boolean
	feeKind: GiftCreditFeeKind
	/** 0–10000 (10000 = 100%). Used when feeKind=percent. */
	percentBps: number
	/** Fixed fee in program points E6 when feeKind=fixed. May be 0. */
	feeE6: bigint
}

const DEFAULT_CONFIG: GiftCreditPurchaseConfig = {
	enabled: false,
	feeKind: 'percent',
	percentBps: 0,
	feeE6: 0n,
}

/** Default OFF — safe baseline for new cards / UI hydrate. */
export const DEFAULT_GIFT_CREDIT_PURCHASE_CONFIG: GiftCreditPurchaseConfig = {
	...DEFAULT_CONFIG,
}

/** JSON-safe shape written to card0 / metadata_json / createCardPreCheck. */
export type GiftCreditPurchaseConfigSerialized = {
	enabled: boolean
	feeKind: GiftCreditFeeKind
	percentBps: number
	feeE6: string
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function parseFeeE6(raw: unknown): bigint {
	if (typeof raw === 'bigint') return raw >= 0n ? raw : 0n
	if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
		return BigInt(Math.floor(raw))
	}
	if (typeof raw === 'string' && raw.trim() !== '') {
		try {
			const n = BigInt(raw.trim())
			return n >= 0n ? n : 0n
		} catch {
			return 0n
		}
	}
	return 0n
}

function parseBps(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
	if (!Number.isFinite(n) || n < 0) return 0
	return Math.min(10_000, Math.floor(n))
}

/**
 * Read giftCreditPurchase from card metadata (top-level or shareTokenMetadata).
 */
export function parseGiftCreditPurchaseConfig(
	metadata: Record<string, unknown> | null | undefined,
): GiftCreditPurchaseConfig {
	if (!metadata) return { ...DEFAULT_CONFIG }
	const share = asRecord(metadata.shareTokenMetadata) ?? metadata
	const raw = asRecord(share.giftCreditPurchase) ?? asRecord(metadata.giftCreditPurchase)
	if (!raw) return { ...DEFAULT_CONFIG }

	const enabled = Boolean(raw.enabled === true || raw.enabled === 'true' || raw.enabled === 1)
	const kindRaw = String(raw.feeKind ?? raw.kind ?? 'percent').toLowerCase()
	const feeKind: GiftCreditFeeKind = kindRaw === 'fixed' ? 'fixed' : 'percent'
	return {
		enabled,
		feeKind,
		percentBps: parseBps(raw.percentBps ?? raw.bps ?? 0),
		feeE6: parseFeeE6(raw.feeE6 ?? raw.fixedFeeE6 ?? '0'),
	}
}

/**
 * Merchant fee F from full gift face G (membershipFeeE6 + topupCreditE6).
 * Returns 0 when disabled or configured fee is 0.
 */
export function computeGiftCreditMerchantFeeE6(
	config: GiftCreditPurchaseConfig,
	giftFaceE6: bigint,
): bigint {
	if (!config.enabled || giftFaceE6 <= 0n) return 0n
	if (config.feeKind === 'fixed') {
		return config.feeE6 > 0n ? config.feeE6 : 0n
	}
	if (config.percentBps <= 0) return 0n
	return (giftFaceE6 * BigInt(config.percentBps)) / 10_000n
}

/** Burn amount = face G + merchant fee F. */
export function computeGiftCreditBurnAmountE6(
	config: GiftCreditPurchaseConfig,
	giftFaceE6: bigint,
): { merchantFeeE6: bigint; burnAmountE6: bigint } {
	const merchantFeeE6 = computeGiftCreditMerchantFeeE6(config, giftFaceE6)
	return { merchantFeeE6, burnAmountE6: giftFaceE6 + merchantFeeE6 }
}

/** Persist shape for metadata_json / createCardPreCheck (feeE6 as decimal string). */
export function serializeGiftCreditPurchaseConfig(
	config: GiftCreditPurchaseConfig,
): GiftCreditPurchaseConfigSerialized {
	const feeKind: GiftCreditFeeKind = config.feeKind === 'fixed' ? 'fixed' : 'percent'
	const percentBps = Math.max(0, Math.min(10_000, Math.floor(Number(config.percentBps) || 0)))
	const feeE6 = config.feeE6 >= 0n ? config.feeE6 : 0n
	return {
		enabled: Boolean(config.enabled),
		feeKind,
		percentBps,
		feeE6: feeE6.toString(),
	}
}

export function cloneGiftCreditPurchaseConfig(
	config: GiftCreditPurchaseConfig,
): GiftCreditPurchaseConfig {
	return {
		enabled: Boolean(config.enabled),
		feeKind: config.feeKind === 'fixed' ? 'fixed' : 'percent',
		percentBps: Math.max(0, Math.min(10_000, Math.floor(Number(config.percentBps) || 0))),
		feeE6: config.feeE6 >= 0n ? config.feeE6 : 0n,
	}
}

export function giftCreditPurchaseConfigsEqual(
	a: GiftCreditPurchaseConfig,
	b: GiftCreditPurchaseConfig,
): boolean {
	return (
		Boolean(a.enabled) === Boolean(b.enabled) &&
		(a.feeKind === 'fixed' ? 'fixed' : 'percent') === (b.feeKind === 'fixed' ? 'fixed' : 'percent') &&
		Math.floor(Number(a.percentBps) || 0) === Math.floor(Number(b.percentBps) || 0) &&
		(a.feeE6 >= 0n ? a.feeE6 : 0n) === (b.feeE6 >= 0n ? b.feeE6 : 0n)
	)
}
