/** Issued coupon NFT / program coupon definition metadata category label. */
export const BEAMIO_COUPON_NFT_CATEGORY = 'Coupon' as const

/** Issued service / production catalog NFT metadata category label. */
export const BEAMIO_PRODUCTION_NFT_CATEGORY = 'productions' as const

export function isBeamioProductionNftCategory(value: unknown): boolean {
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
		return row
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

/** Tier / issued-NFT `properties` for Program service catalog (productions). */
export function propertiesLookLikeProductionProps(props: Record<string, unknown>): boolean {
	if (isBeamioProductionNftCategory(props.category)) return true
	const beamioProduction = props.beamioProduction
	return beamioProduction != null && typeof beamioProduction === 'object' && !Array.isArray(beamioProduction)
}

export function normalizeProductionCategoryOnTierProperties(props: Record<string, unknown>): Record<string, unknown> {
	if (!propertiesLookLikeProductionProps(props)) return props
	return { ...props, category: BEAMIO_PRODUCTION_NFT_CATEGORY }
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
	const out: Record<string, unknown> = { ...meta, category: BEAMIO_PRODUCTION_NFT_CATEGORY }
	if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
		out.properties = normalizeProductionCategoryOnTierProperties(out.properties as Record<string, unknown>)
	}
	return out
}

/** createIssuedNft metadata_extra_properties — coupon or productions. */
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
			row.category = BEAMIO_PRODUCTION_NFT_CATEGORY
		}
		return row
	})
	return { ...share, productions: next }
}
