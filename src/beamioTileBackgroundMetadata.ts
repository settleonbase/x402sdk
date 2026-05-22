/**
 * Tile background semantics for Program coupons and catalog items (productions).
 *
 * Rule: optional wide background photo (`couponImage` / `productionImage`) overrides
 * `backgroundColor` for tile/card rendering. Solid color applies only when no photo URL.
 */

export const BEAMIO_COUPON_TILE_PHOTO_FIELD = 'couponImage' as const
export const BEAMIO_CATALOG_TILE_PHOTO_FIELD = 'productionImage' as const

export type BeamioTileBackgroundPhotoField =
	| typeof BEAMIO_COUPON_TILE_PHOTO_FIELD
	| typeof BEAMIO_CATALOG_TILE_PHOTO_FIELD

export function hasBeamioTileBackgroundPhoto(photo: unknown): boolean {
	return typeof photo === 'string' && photo.trim().length > 0
}

/** True when `backgroundColor` should be shown/edited/used for tile fill. */
export function tileBackgroundColorApplies(photo: unknown): boolean {
	return !hasBeamioTileBackgroundPhoto(photo)
}

export function readBeamioTileBackgroundPhoto(
	row: Record<string, unknown>,
	photoField: BeamioTileBackgroundPhotoField
): string {
	const raw = row[photoField]
	return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Resolve tile fill for UI: photo wins; otherwise normalized solid color (optional fallback).
 */
export function resolveBeamioTileBackgroundForRender(
	row: Record<string, unknown>,
	photoField: BeamioTileBackgroundPhotoField,
	fallbackSolidColor = '#0051d1'
): { photo?: string; solidColor?: string } {
	const photo = readBeamioTileBackgroundPhoto(row, photoField)
	if (photo) return { photo }
	const rawColor = row.backgroundColor
	const solid =
		typeof rawColor === 'string' && rawColor.trim() ? rawColor.trim() : fallbackSolidColor
	return { solidColor: solid }
}

/**
 * Metadata publish helper: omit `backgroundColor` when a background photo is present
 * (color may remain in editor state for when the photo is removed later).
 */
export function effectiveBeamioTileBackgroundColorForMetadata(args: {
	photo: unknown
	backgroundColor: unknown
}): string | undefined {
	if (!tileBackgroundColorApplies(args.photo)) return undefined
	const raw = typeof args.backgroundColor === 'string' ? args.backgroundColor.trim() : ''
	return raw || undefined
}

export function applyBeamioTileBackgroundPhotoRuleToMetadataRow<T extends Record<string, unknown>>(
	row: T,
	photoField: BeamioTileBackgroundPhotoField
): T {
	const photo = readBeamioTileBackgroundPhoto(row, photoField)
	if (!photo) return row
	if (row.backgroundColor === undefined) return row
	const { backgroundColor: _ignored, ...rest } = row
	return rest as T
}
