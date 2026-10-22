/**
 * SaaS Fuel Pack catalog — single source for Stripe Checkout + mint amounts.
 * Mirror in Merchant OS `MARKET_FUEL_PACKAGES` and homepage `fuelPackCatalog.ts`.
 * User UI: price + total B-Units only (see beamio-fuel-pack-display-no-paid-free).
 */
export type FuelPackId = 'starter' | 'growth' | 'business' | 'scale'

export type FuelPackCatalogEntry = {
	id: string
	/** Whole USDC for Stripe Checkout `unit_amount` (dollars). */
	priceUsdc: number
	/** Same as priceUsdc, string form for API bodies. */
	usdcAmount: string
	/** Checkout allocation only — UI must show paid+free as a single B-Units total. */
	paidBUnits: number
	freeBUnits: number
	firstTimeOnly?: boolean
}

/** Current packs offered for new Checkout (Starter / Growth / Business / Scale). */
export const FUEL_PACK_CATALOG: FuelPackCatalogEntry[] = [
	{
		id: 'starter',
		priceUsdc: 49,
		usdcAmount: '49',
		paidBUnits: 4900,
		freeBUnits: 245,
	},
	{
		id: 'growth',
		priceUsdc: 199,
		usdcAmount: '199',
		paidBUnits: 19900,
		freeBUnits: 1990,
	},
	{
		id: 'business',
		priceUsdc: 999,
		usdcAmount: '999',
		paidBUnits: 99900,
		freeBUnits: 14985,
	},
	{
		id: 'scale',
		priceUsdc: 4999,
		usdcAmount: '4999',
		paidBUnits: 499900,
		freeBUnits: 99980,
	},
]

/** Legacy pack ids → current catalog id (new Checkout + open-session remapping). */
const FUEL_PACK_ID_ALIASES: Record<string, FuelPackId> = {
	testing_waters: 'starter',
	enterprise: 'business',
	institutional: 'scale',
}

/**
 * Open Stripe sessions only — not offered for new Checkout.
 * Kept so webhook fulfill can still mint for in-flight checkouts.
 */
const LEGACY_FUEL_PACK_FULFILL: FuelPackCatalogEntry[] = [
	{
		id: 'genesis_starter',
		priceUsdc: 15,
		usdcAmount: '15',
		paidBUnits: 1500,
		freeBUnits: 500,
		firstTimeOnly: true,
	},
	{
		id: 'genesis_partner',
		priceUsdc: 4000,
		usdcAmount: '4000',
		paidBUnits: 400000,
		freeBUnits: 100000,
	},
]

function normalizeFuelPackId(raw: unknown): string {
	return String(raw ?? '')
		.trim()
		.toLowerCase()
}

export function lookupFuelPack(raw: unknown): FuelPackCatalogEntry | null {
	let id = normalizeFuelPackId(raw)
	if (!id) return null
	id = FUEL_PACK_ID_ALIASES[id] ?? id
	return (
		FUEL_PACK_CATALOG.find((p) => p.id === id) ??
		LEGACY_FUEL_PACK_FULFILL.find((p) => p.id === id) ??
		null
	)
}

/** True when `raw` is (or aliases to) a currently offered pack — for new Checkout. */
export function isCatalogFuelPackId(raw: unknown): raw is FuelPackId {
	const id = normalizeFuelPackId(raw)
	if (!id) return false
	const resolved = FUEL_PACK_ID_ALIASES[id] ?? id
	return FUEL_PACK_CATALOG.some((p) => p.id === resolved)
}

export function fuelPackUsdc6(pack: FuelPackCatalogEntry): bigint {
	return BigInt(Math.round(pack.priceUsdc * 1e6))
}

export function fuelPackFreeBUnits6(pack: FuelPackCatalogEntry): bigint {
	return BigInt(pack.freeBUnits) * 1_000_000n
}

export function fuelPackPaidBUnits6(pack: FuelPackCatalogEntry): bigint {
	return BigInt(pack.paidBUnits) * 1_000_000n
}
