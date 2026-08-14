import { ethers } from 'ethers'

/** Merchant OS Custom Fuel packs — Cluster source of truth (copy independently in homepage / bizSite). */
export type FuelPackId =
	| 'genesis_starter'
	| 'testing_waters'
	| 'growth'
	| 'enterprise'
	| 'institutional'

export type FuelPackCatalogEntry = {
	id: FuelPackId
	priceUsdc: number
	usdcAmount: string
	paidBUnits: number
	freeBUnits: number
	firstTimeOnly?: boolean
}

export const FUEL_PACK_CATALOG: FuelPackCatalogEntry[] = [
	{
		id: 'genesis_starter',
		priceUsdc: 15,
		usdcAmount: '15',
		paidBUnits: 1500,
		freeBUnits: 500,
		firstTimeOnly: true,
	},
	{
		id: 'testing_waters',
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
		id: 'enterprise',
		priceUsdc: 999,
		usdcAmount: '999',
		paidBUnits: 99900,
		freeBUnits: 14985,
	},
	{
		id: 'institutional',
		priceUsdc: 4999,
		usdcAmount: '4999',
		paidBUnits: 499900,
		freeBUnits: 99980,
	},
]

export function lookupFuelPack(raw: unknown): FuelPackCatalogEntry | null {
	const id = String(raw ?? '')
		.trim()
		.toLowerCase()
	if (!id) return null
	return FUEL_PACK_CATALOG.find((p) => p.id === id) ?? null
}

export function fuelPackUsdc6(pack: FuelPackCatalogEntry): bigint {
	return ethers.parseUnits(pack.usdcAmount, 6)
}

export function fuelPackFreeBUnits6(pack: FuelPackCatalogEntry): bigint {
	return BigInt(pack.freeBUnits) * 1_000_000n
}
