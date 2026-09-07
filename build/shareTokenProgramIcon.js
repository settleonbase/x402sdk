"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readFirstShareCatalogIconUrl = readFirstShareCatalogIconUrl;
exports.ensureShareTokenProgramIconAssembled = ensureShareTokenProgramIconAssembled;
const SHARE_CATALOG_ICON_FIELD_KEYS = ['icon', 'iconUrl', 'logoUrl', 'logo', 'image'];
const SHARE_PROGRAM_ICON_FIELD_KEYS = ['icon', 'iconUrl', 'logoUrl', 'logo'];
function readShareMetadataStringField(obj, keys) {
    if (!obj)
        return '';
    for (const key of keys) {
        const raw = obj[key];
        if (typeof raw === 'string' && raw.trim())
            return raw.trim();
    }
    return '';
}
/** First coupon / catalog row square icon URL (not couponImage banner). */
function readFirstShareCatalogIconUrl(share) {
    if (!share || typeof share !== 'object' || Array.isArray(share))
        return '';
    const coupons = share.coupons;
    if (Array.isArray(coupons)) {
        for (const row of coupons) {
            if (!row || typeof row !== 'object')
                continue;
            const url = readShareMetadataStringField(row, SHARE_CATALOG_ICON_FIELD_KEYS);
            if (url)
                return url;
        }
    }
    const productions = share.productions;
    if (Array.isArray(productions)) {
        for (const row of productions) {
            if (!row || typeof row !== 'object')
                continue;
            const url = readShareMetadataStringField(row, SHARE_CATALOG_ICON_FIELD_KEYS);
            if (url)
                return url;
        }
    }
    return '';
}
/**
 * Ensure program square icon lives on shareTokenMetadata (`icon` + optional `image`).
 * Does not use couponImage / merchantImage banners.
 */
function ensureShareTokenProgramIconAssembled(share) {
    const next = { ...share };
    const existingIcon = readShareMetadataStringField(next, SHARE_PROGRAM_ICON_FIELD_KEYS);
    const existingImage = readShareMetadataStringField(next, ['image']);
    if (existingIcon) {
        if (!existingImage)
            next.image = existingIcon;
        return next;
    }
    const fromCatalog = readFirstShareCatalogIconUrl(next);
    if (!fromCatalog)
        return next;
    next.icon = fromCatalog;
    if (!existingImage)
        next.image = fromCatalog;
    return next;
}
