/** Issued coupon NFT / program coupon definition metadata category label. */
import { ethers } from 'ethers'
import {
	applyBeamioTileBackgroundPhotoRuleToMetadataRow,
	BEAMIO_CATALOG_TILE_PHOTO_FIELD,
	BEAMIO_COUPON_TILE_PHOTO_FIELD,
} from './beamioTileBackgroundMetadata'

export const BEAMIO_COUPON_NFT_CATEGORY = 'Coupon' as const

/** Legacy issued service / production catalog NFT metadata category label. */
export const BEAMIO_PRODUCTION_NFT_CATEGORY = 'productions' as const

/** Catalog item global categories — stored on metadata root `category` (same level as coupon `Coupon`). */
export const BEAMIO_CATALOG_GLOBAL_CATEGORIES = ['Product', 'Service', 'Menu', 'SalesManagement'] as const

export type BeamioCatalogGlobalCategory = (typeof BEAMIO_CATALOG_GLOBAL_CATEGORIES)[number]

export const DEFAULT_BEAMIO_CATALOG_GLOBAL_CATEGORY: BeamioCatalogGlobalCategory = 'Service'

export function isBeamioCatalogGlobalCategory(value: unknown): value is BeamioCatalogGlobalCategory {
	return (
		typeof value === 'string' &&
		BEAMIO_CATALOG_GLOBAL_CATEGORIES.some((cat) => cat === value.trim())
	)
}

export function normalizeBeamioCatalogGlobalCategory(raw: unknown): BeamioCatalogGlobalCategory {
	if (isBeamioCatalogGlobalCategory(raw)) return raw.trim() as BeamioCatalogGlobalCategory
	if (typeof raw === 'string' && raw.trim().toLowerCase() === BEAMIO_PRODUCTION_NFT_CATEGORY.toLowerCase()) {
		return DEFAULT_BEAMIO_CATALOG_GLOBAL_CATEGORY
	}
	return DEFAULT_BEAMIO_CATALOG_GLOBAL_CATEGORY
}

export function isBeamioProductionNftCategory(value: unknown): boolean {
	if (isBeamioCatalogGlobalCategory(value)) return true
	return typeof value === 'string' && value.trim().toLowerCase() === BEAMIO_PRODUCTION_NFT_CATEGORY.toLowerCase()
}

export function isBeamioCouponNftCategory(value: unknown): boolean {
	return typeof value === 'string' && value.trim().toLowerCase() === BEAMIO_COUPON_NFT_CATEGORY.toLowerCase()
}

/** Tier / issued-NFT `properties` object looks like a Program coupon series. */
export function propertiesLookLikeCouponProps(props: Record<string, unknown>): boolean {
	if (isBeamioCouponNftCategory(props.category)) return true
	const beamioCoupon = props.beamioCoupon
	return beamioCoupon != null && typeof beamioCoupon === 'object' && !Array.isArray(beamioCoupon)
}

/** Ensure `properties.category = Coupon` when coupon semantics are present (createIssuedNft / tier metadata). */
export function normalizeCouponCategoryOnTierProperties(props: Record<string, unknown>): Record<string, unknown> {
	if (!propertiesLookLikeCouponProps(props)) return props
	return { ...props, category: BEAMIO_COUPON_NFT_CATEGORY }
}

/** `beamio_nft_series.metadata_json` or registerSeries payload. */
export function seriesMetadataLooksLikeCoupon(meta: Record<string, unknown>): boolean {
	if (isBeamioProductionNftCategory(meta.category)) return false
	if (isBeamioCouponNftCategory(meta.category)) return true
	if (typeof meta.couponId === 'string' && meta.couponId.trim()) return true
	const id = typeof meta.id === 'string' ? meta.id.trim() : ''
	if (id && (meta.issueTotal != null || meta.issuedTokenId != null || meta.requiresRedeemCode != null)) {
		return true
	}
	const props = meta.properties
	if (props && typeof props === 'object' && !Array.isArray(props)) {
		return propertiesLookLikeCouponProps(props as Record<string, unknown>)
	}
	return false
}

export function normalizeCouponSeriesMetadataJson(meta: Record<string, unknown>): Record<string, unknown> {
	if (!seriesMetadataLooksLikeCoupon(meta)) return meta
	const out: Record<string, unknown> = { ...meta, category: BEAMIO_COUPON_NFT_CATEGORY }
	if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
		out.properties = normalizeCouponCategoryOnTierProperties(out.properties as Record<string, unknown>)
	}
	return out
}

/** Normalize `metadata_extra_properties` from cardCreateIssuedNft (object or JSON string). */
export function normalizeCouponMetadataExtraProperties(
	extra: string | Record<string, unknown> | undefined
): string | Record<string, unknown> | undefined {
	if (extra == null) return extra
	let props: Record<string, unknown> | undefined
	if (typeof extra === 'string') {
		const s = extra.trim()
		if (!s) return extra
		try {
			const parsed = JSON.parse(s) as unknown
			if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				props = parsed as Record<string, unknown>
			}
		} catch {
			return extra
		}
	} else if (typeof extra === 'object' && !Array.isArray(extra)) {
		props = extra as Record<string, unknown>
	}
	if (!props) return extra
	const normalized = normalizeCouponCategoryOnTierProperties(props)
	return typeof extra === 'string' ? JSON.stringify(normalized) : normalized
}

/** Ensure each `shareTokenMetadata.coupons[]` row carries category when it is a coupon definition. */
export function normalizeShareTokenMetadataCoupons(share: Record<string, unknown>): Record<string, unknown> {
	const coupons = share.coupons
	if (!Array.isArray(coupons) || coupons.length === 0) return share
	const next = coupons.map((item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return item
		const row = { ...(item as Record<string, unknown>) }
		const id = String(row.id ?? row.couponId ?? '').trim()
		if (id || isBeamioCouponNftCategory(row.category) || row.issueTotal != null) {
			row.category = BEAMIO_COUPON_NFT_CATEGORY
		}
		return applyBeamioTileBackgroundPhotoRuleToMetadataRow(row, BEAMIO_COUPON_TILE_PHOTO_FIELD)
	})
	return { ...share, coupons: next }
}

/**
 * Client coupon fetch endpoints: return rows whose metadata is category `Coupon`.
 * When `category` is explicitly set to a non-coupon value, exclude. Legacy rows without
 * `category` but with coupon markers (beamioCoupon / couponId) remain included.
 */
export function metadataMatchesClientCouponCategoryFilter(meta: unknown): boolean {
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false
	const m = meta as Record<string, unknown>
	const rootCat = m.category
	if (rootCat != null && String(rootCat).trim() !== '') {
		return isBeamioCouponNftCategory(rootCat)
	}
	const props = m.properties
	if (props && typeof props === 'object' && !Array.isArray(props)) {
		const propCat = (props as Record<string, unknown>).category
		if (propCat != null && String(propCat).trim() !== '') {
			return isBeamioCouponNftCategory(propCat)
		}
	}
	return seriesMetadataLooksLikeCoupon(m)
}

export function shareTokenMetadataCouponItemMatchesCategoryFilter(item: unknown): boolean {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return false
	const row = item as Record<string, unknown>
	const cat = row.category
	if (cat != null && String(cat).trim() !== '') {
		return isBeamioCouponNftCategory(cat)
	}
	const id = String(row.id ?? row.couponId ?? '').trim()
	return Boolean(id && (row.issueTotal != null || row.issuedTokenId != null || row.requiresRedeemCode != null))
}

export function filterClientCouponSeriesRows<
	T extends { metadata: Record<string, unknown> | null },
>(rows: T[]): T[] {
	return rows.filter((row) => metadataMatchesClientCouponCategoryFilter(row.metadata))
}

export function filterShareTokenMetadataCouponsForClient(share: Record<string, unknown>): Record<string, unknown> {
	const coupons = share.coupons
	if (!Array.isArray(coupons) || coupons.length === 0) return share
	const filtered = coupons.filter((item) => shareTokenMetadataCouponItemMatchesCategoryFilter(item))
	if (filtered.length === coupons.length) return share
	return { ...share, coupons: filtered }
}

/** Tier / issued-NFT `properties` for Program service catalog (productions / Product / Service / Menu). */
export function propertiesLookLikeProductionProps(props: Record<string, unknown>): boolean {
	if (isBeamioProductionNftCategory(props.category)) return true
	const beamioProduction = props.beamioProduction
	return beamioProduction != null && typeof beamioProduction === 'object' && !Array.isArray(beamioProduction)
}

export function normalizeProductionCategoryOnTierProperties(props: Record<string, unknown>): Record<string, unknown> {
	if (!propertiesLookLikeProductionProps(props)) return props
	return { ...props, category: normalizeBeamioCatalogGlobalCategory(props.category) }
}

export function seriesMetadataLooksLikeProduction(meta: Record<string, unknown>): boolean {
	if (isBeamioProductionNftCategory(meta.category)) return true
	if (typeof meta.productionId === 'string' && meta.productionId.trim()) return true
	const props = meta.properties
	if (props && typeof props === 'object' && !Array.isArray(props)) {
		return propertiesLookLikeProductionProps(props as Record<string, unknown>)
	}
	const id = typeof meta.id === 'string' ? meta.id.trim() : ''
	return Boolean(id && meta.singleSessionPrice != null)
}

export function normalizeProductionSeriesMetadataJson(meta: Record<string, unknown>): Record<string, unknown> {
	if (!seriesMetadataLooksLikeProduction(meta)) return meta
	const out: Record<string, unknown> = {
		...meta,
		category: normalizeBeamioCatalogGlobalCategory(meta.category),
	}
	if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
		out.properties = normalizeProductionCategoryOnTierProperties(out.properties as Record<string, unknown>)
	}
	return out
}

/** createIssuedNft metadata_extra_properties — coupon or catalog item (Product / Service / Menu). */
export function normalizeIssuedNftMetadataExtraProperties(
	extra: string | Record<string, unknown> | undefined
): string | Record<string, unknown> | undefined {
	if (extra == null) return extra
	let props: Record<string, unknown> | undefined
	if (typeof extra === 'string') {
		const s = extra.trim()
		if (!s) return extra
		try {
			const parsed = JSON.parse(s) as unknown
			if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				props = parsed as Record<string, unknown>
			}
		} catch {
			return extra
		}
	} else if (typeof extra === 'object' && !Array.isArray(extra)) {
		props = extra as Record<string, unknown>
	}
	if (!props) return extra
	let normalized = props
	if (propertiesLookLikeProductionProps(props)) {
		normalized = normalizeProductionCategoryOnTierProperties(props)
	} else if (propertiesLookLikeCouponProps(props)) {
		normalized = normalizeCouponCategoryOnTierProperties(props)
	}
	return typeof extra === 'string' ? JSON.stringify(normalized) : normalized
}

export function metadataMatchesClientProductionCategoryFilter(meta: unknown): boolean {
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false
	const m = meta as Record<string, unknown>
	const rootCat = m.category
	if (rootCat != null && String(rootCat).trim() !== '') {
		return isBeamioProductionNftCategory(rootCat)
	}
	const props = m.properties
	if (props && typeof props === 'object' && !Array.isArray(props)) {
		const propCat = (props as Record<string, unknown>).category
		if (propCat != null && String(propCat).trim() !== '') {
			return isBeamioProductionNftCategory(propCat)
		}
	}
	return seriesMetadataLooksLikeProduction(m)
}

export function filterClientProductionSeriesRows<
	T extends { metadata: Record<string, unknown> | null },
>(rows: T[]): T[] {
	return rows.filter((row) => metadataMatchesClientProductionCategoryFilter(row.metadata))
}

export function normalizeShareTokenMetadataProductions(share: Record<string, unknown>): Record<string, unknown> {
	const productions = share.productions
	if (!Array.isArray(productions) || productions.length === 0) return share
	const next = productions.map((item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return item
		const row = { ...(item as Record<string, unknown>) }
		const id = String(row.id ?? row.productionId ?? '').trim()
		if (id || isBeamioProductionNftCategory(row.category) || row.singleSessionPrice != null) {
			row.category = normalizeBeamioCatalogGlobalCategory(row.category)
			const itemCategoryRaw =
				typeof row.itemCategory === 'string'
					? row.itemCategory.trim()
					: typeof row.serviceCategory === 'string'
						? row.serviceCategory.trim()
						: ''
			if (itemCategoryRaw) row.itemCategory = itemCategoryRaw
			delete row.serviceCategory
		}
		return applyBeamioTileBackgroundPhotoRuleToMetadataRow(row, BEAMIO_CATALOG_TILE_PHOTO_FIELD)
	})
	return { ...share, productions: next }
}

/** Card-level item category chips (`shareTokenMetadata.itemCategory`; legacy `serviceCategory`). */
function normalizeServiceCategoryLabelForHash(label: string): string {
	return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function serviceCategoryHashIdFromLabel(label: string): string {
	const key = normalizeServiceCategoryLabelForHash(label)
	if (!key) return ''
	return ethers.keccak256(ethers.toUtf8Bytes(`beamio:serviceCategory:${key}`)).slice(2, 18)
}

export function normalizeShareTokenMetadataItemCategory(share: Record<string, unknown>): Record<string, unknown> {
	const raw = share.itemCategory ?? share.serviceCategory
	if (raw == null) {
		const { serviceCategory: _legacy, ...rest } = share
		return rest
	}
	if (!Array.isArray(raw)) {
		const { serviceCategory: _legacy, itemCategory: _removed, ...rest } = share
		return rest
	}
	const out: Array<{ id: string; label: string }> = []
	const hashKeysSeen = new Set<string>()
	const idSeen = new Set<string>()
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const row = entry as Record<string, unknown>
		const label = typeof row.label === 'string' ? row.label.trim().slice(0, 128) : ''
		if (!label) continue
		const hashKey = normalizeServiceCategoryLabelForHash(label)
		if (hashKeysSeen.has(hashKey)) continue
		const id = serviceCategoryHashIdFromLabel(label)
		if (!id || idSeen.has(id)) continue
		hashKeysSeen.add(hashKey)
		idSeen.add(id)
		out.push({ id, label })
	}
	const { serviceCategory: _legacy, ...base } = share
	if (out.length === 0) {
		const { itemCategory: _removed, ...rest } = base
		return rest
	}
	return { ...base, itemCategory: out }
}

/** @deprecated Use `normalizeShareTokenMetadataItemCategory`. */
export function normalizeShareTokenMetadataServiceCategory(share: Record<string, unknown>): Record<string, unknown> {
	return normalizeShareTokenMetadataItemCategory(share)
}
