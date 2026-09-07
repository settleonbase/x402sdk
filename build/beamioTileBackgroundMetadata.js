"use strict";
/**
 * Tile background semantics for Program coupons and catalog items (productions).
 *
 * Rule: optional wide background photo (`couponImage` / `productionImage`) overrides
 * `backgroundColor` for tile/card rendering. Solid color applies only when no photo URL.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BEAMIO_CATALOG_TILE_PHOTO_FIELD = exports.BEAMIO_COUPON_TILE_PHOTO_FIELD = void 0;
exports.hasBeamioTileBackgroundPhoto = hasBeamioTileBackgroundPhoto;
exports.tileBackgroundColorApplies = tileBackgroundColorApplies;
exports.readBeamioTileBackgroundPhoto = readBeamioTileBackgroundPhoto;
exports.resolveBeamioTileBackgroundForRender = resolveBeamioTileBackgroundForRender;
exports.effectiveBeamioTileBackgroundColorForMetadata = effectiveBeamioTileBackgroundColorForMetadata;
exports.applyBeamioTileBackgroundPhotoRuleToMetadataRow = applyBeamioTileBackgroundPhotoRuleToMetadataRow;
exports.BEAMIO_COUPON_TILE_PHOTO_FIELD = 'couponImage';
exports.BEAMIO_CATALOG_TILE_PHOTO_FIELD = 'productionImage';
function hasBeamioTileBackgroundPhoto(photo) {
    return typeof photo === 'string' && photo.trim().length > 0;
}
/** True when `backgroundColor` should be shown/edited/used for tile fill. */
function tileBackgroundColorApplies(photo) {
    return !hasBeamioTileBackgroundPhoto(photo);
}
function readBeamioTileBackgroundPhoto(row, photoField) {
    const raw = row[photoField];
    return typeof raw === 'string' ? raw.trim() : '';
}
/**
 * Resolve tile fill for UI: photo wins; otherwise normalized solid color (optional fallback).
 */
function resolveBeamioTileBackgroundForRender(row, photoField, fallbackSolidColor = '#0051d1') {
    const photo = readBeamioTileBackgroundPhoto(row, photoField);
    if (photo)
        return { photo };
    const rawColor = row.backgroundColor;
    const solid = typeof rawColor === 'string' && rawColor.trim() ? rawColor.trim() : fallbackSolidColor;
    return { solidColor: solid };
}
/**
 * Metadata publish helper: omit `backgroundColor` when a background photo is present
 * (color may remain in editor state for when the photo is removed later).
 */
function effectiveBeamioTileBackgroundColorForMetadata(args) {
    if (!tileBackgroundColorApplies(args.photo))
        return undefined;
    const raw = typeof args.backgroundColor === 'string' ? args.backgroundColor.trim() : '';
    return raw || undefined;
}
function applyBeamioTileBackgroundPhotoRuleToMetadataRow(row, photoField) {
    const photo = readBeamioTileBackgroundPhoto(row, photoField);
    if (!photo)
        return row;
    if (row.backgroundColor === undefined)
        return row;
    const { backgroundColor: _ignored, ...rest } = row;
    return rest;
}
