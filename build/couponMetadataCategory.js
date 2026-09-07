"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BEAMIO_CATALOG_GLOBAL_CATEGORY = exports.BEAMIO_CATALOG_GLOBAL_CATEGORIES = exports.BEAMIO_PRODUCTION_NFT_CATEGORY = exports.BEAMIO_COUPON_NFT_CATEGORY = void 0;
exports.isBeamioCatalogGlobalCategory = isBeamioCatalogGlobalCategory;
exports.normalizeBeamioCatalogGlobalCategory = normalizeBeamioCatalogGlobalCategory;
exports.isBeamioProductionNftCategory = isBeamioProductionNftCategory;
exports.isBeamioCouponNftCategory = isBeamioCouponNftCategory;
exports.propertiesLookLikeCouponProps = propertiesLookLikeCouponProps;
exports.normalizeCouponCategoryOnTierProperties = normalizeCouponCategoryOnTierProperties;
exports.seriesMetadataLooksLikeCoupon = seriesMetadataLooksLikeCoupon;
exports.normalizeCouponSeriesMetadataJson = normalizeCouponSeriesMetadataJson;
exports.normalizeCouponMetadataExtraProperties = normalizeCouponMetadataExtraProperties;
exports.normalizeShareTokenMetadataCoupons = normalizeShareTokenMetadataCoupons;
exports.metadataMatchesClientCouponCategoryFilter = metadataMatchesClientCouponCategoryFilter;
exports.shareTokenMetadataCouponItemMatchesCategoryFilter = shareTokenMetadataCouponItemMatchesCategoryFilter;
exports.filterClientCouponSeriesRows = filterClientCouponSeriesRows;
exports.readCouponDisabledFromMetadata = readCouponDisabledFromMetadata;
exports.metadataMatchesListedClientCouponFilter = metadataMatchesListedClientCouponFilter;
exports.filterListedClientCouponSeriesRows = filterListedClientCouponSeriesRows;
exports.shareTokenMetadataCouponItemIsListed = shareTokenMetadataCouponItemIsListed;
exports.filterShareTokenMetadataCouponsForClient = filterShareTokenMetadataCouponsForClient;
exports.propertiesLookLikeProductionProps = propertiesLookLikeProductionProps;
exports.resolveIssuedNftProductKindFromMetadataExtra = resolveIssuedNftProductKindFromMetadataExtra;
exports.normalizeProductionCategoryOnTierProperties = normalizeProductionCategoryOnTierProperties;
exports.seriesMetadataLooksLikeProduction = seriesMetadataLooksLikeProduction;
exports.normalizeProductionSeriesMetadataJson = normalizeProductionSeriesMetadataJson;
exports.normalizeIssuedNftMetadataExtraProperties = normalizeIssuedNftMetadataExtraProperties;
exports.metadataMatchesClientProductionCategoryFilter = metadataMatchesClientProductionCategoryFilter;
exports.filterClientProductionSeriesRows = filterClientProductionSeriesRows;
exports.resolveIssuedNftDistributionFieldsFromSeriesMetadata = resolveIssuedNftDistributionFieldsFromSeriesMetadata;
exports.normalizeShareTokenMetadataProductions = normalizeShareTokenMetadataProductions;
exports.normalizeShareTokenMetadataItemCategory = normalizeShareTokenMetadataItemCategory;
exports.normalizeShareTokenMetadataServiceCategory = normalizeShareTokenMetadataServiceCategory;
/** Issued coupon NFT / program coupon definition metadata category label. */
const ethers_1 = require("ethers");
const beamioTileBackgroundMetadata_1 = require("./beamioTileBackgroundMetadata");
exports.BEAMIO_COUPON_NFT_CATEGORY = 'Coupon';
/** Legacy issued service / production catalog NFT metadata category label. */
exports.BEAMIO_PRODUCTION_NFT_CATEGORY = 'productions';
/** Catalog item global categories — stored on metadata root `category` (same level as coupon `Coupon`). */
exports.BEAMIO_CATALOG_GLOBAL_CATEGORIES = ['Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement'];
exports.DEFAULT_BEAMIO_CATALOG_GLOBAL_CATEGORY = 'Service';
function isBeamioCatalogGlobalCategory(value) {
    return (typeof value === 'string' &&
        exports.BEAMIO_CATALOG_GLOBAL_CATEGORIES.some((cat) => cat === value.trim()));
}
function normalizeBeamioCatalogGlobalCategory(raw) {
    if (isBeamioCatalogGlobalCategory(raw))
        return raw.trim();
    if (typeof raw === 'string' && raw.trim().toLowerCase() === exports.BEAMIO_PRODUCTION_NFT_CATEGORY.toLowerCase()) {
        return exports.DEFAULT_BEAMIO_CATALOG_GLOBAL_CATEGORY;
    }
    return exports.DEFAULT_BEAMIO_CATALOG_GLOBAL_CATEGORY;
}
function isBeamioProductionNftCategory(value) {
    if (isBeamioCatalogGlobalCategory(value))
        return true;
    return typeof value === 'string' && value.trim().toLowerCase() === exports.BEAMIO_PRODUCTION_NFT_CATEGORY.toLowerCase();
}
function isBeamioCouponNftCategory(value) {
    return typeof value === 'string' && value.trim().toLowerCase() === exports.BEAMIO_COUPON_NFT_CATEGORY.toLowerCase();
}
/** Tier / issued-NFT `properties` object looks like a Program coupon series. */
function propertiesLookLikeCouponProps(props) {
    if (isBeamioCouponNftCategory(props.category))
        return true;
    const beamioCoupon = props.beamioCoupon;
    return beamioCoupon != null && typeof beamioCoupon === 'object' && !Array.isArray(beamioCoupon);
}
/** Ensure `properties.category = Coupon` when coupon semantics are present (createIssuedNft / tier metadata). */
function normalizeCouponCategoryOnTierProperties(props) {
    if (!propertiesLookLikeCouponProps(props))
        return props;
    return { ...props, category: exports.BEAMIO_COUPON_NFT_CATEGORY };
}
/** `beamio_nft_series.metadata_json` or registerSeries payload. */
function seriesMetadataLooksLikeCoupon(meta) {
    if (isBeamioProductionNftCategory(meta.category))
        return false;
    if (isBeamioCouponNftCategory(meta.category))
        return true;
    if (typeof meta.couponId === 'string' && meta.couponId.trim())
        return true;
    const id = typeof meta.id === 'string' ? meta.id.trim() : '';
    if (id && (meta.issueTotal != null || meta.issuedTokenId != null || meta.requiresRedeemCode != null)) {
        return true;
    }
    const props = meta.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        return propertiesLookLikeCouponProps(props);
    }
    return false;
}
function normalizeCouponSeriesMetadataJson(meta) {
    if (!seriesMetadataLooksLikeCoupon(meta))
        return meta;
    const out = { ...meta, category: exports.BEAMIO_COUPON_NFT_CATEGORY };
    if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
        out.properties = normalizeCouponCategoryOnTierProperties(out.properties);
    }
    return out;
}
/** Normalize `metadata_extra_properties` from cardCreateIssuedNft (object or JSON string). */
function normalizeCouponMetadataExtraProperties(extra) {
    if (extra == null)
        return extra;
    let props;
    if (typeof extra === 'string') {
        const s = extra.trim();
        if (!s)
            return extra;
        try {
            const parsed = JSON.parse(s);
            if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                props = parsed;
            }
        }
        catch {
            return extra;
        }
    }
    else if (typeof extra === 'object' && !Array.isArray(extra)) {
        props = extra;
    }
    if (!props)
        return extra;
    const normalized = normalizeCouponCategoryOnTierProperties(props);
    return typeof extra === 'string' ? JSON.stringify(normalized) : normalized;
}
/** Ensure each `shareTokenMetadata.coupons[]` row carries category when it is a coupon definition. */
function normalizeShareTokenMetadataCoupons(share) {
    const coupons = share.coupons;
    if (!Array.isArray(coupons) || coupons.length === 0)
        return share;
    const next = coupons.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return item;
        const row = { ...item };
        const id = String(row.id ?? row.couponId ?? '').trim();
        if (id || isBeamioCouponNftCategory(row.category) || row.issueTotal != null) {
            row.category = exports.BEAMIO_COUPON_NFT_CATEGORY;
        }
        return (0, beamioTileBackgroundMetadata_1.applyBeamioTileBackgroundPhotoRuleToMetadataRow)(row, beamioTileBackgroundMetadata_1.BEAMIO_COUPON_TILE_PHOTO_FIELD);
    });
    return { ...share, coupons: next };
}
/**
 * Client coupon fetch endpoints: return rows whose metadata is category `Coupon`.
 * When `category` is explicitly set to a non-coupon value, exclude. Legacy rows without
 * `category` but with coupon markers (beamioCoupon / couponId) remain included.
 */
function metadataMatchesClientCouponCategoryFilter(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta))
        return false;
    const m = meta;
    const rootCat = m.category;
    if (rootCat != null && String(rootCat).trim() !== '') {
        return isBeamioCouponNftCategory(rootCat);
    }
    const props = m.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        const propCat = props.category;
        if (propCat != null && String(propCat).trim() !== '') {
            return isBeamioCouponNftCategory(propCat);
        }
    }
    return seriesMetadataLooksLikeCoupon(m);
}
function shareTokenMetadataCouponItemMatchesCategoryFilter(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return false;
    const row = item;
    const cat = row.category;
    if (cat != null && String(cat).trim() !== '') {
        return isBeamioCouponNftCategory(cat);
    }
    const id = String(row.id ?? row.couponId ?? '').trim();
    return Boolean(id && (row.issueTotal != null || row.issuedTokenId != null || row.requiresRedeemCode != null));
}
function filterClientCouponSeriesRows(rows) {
    return rows.filter((row) => metadataMatchesClientCouponCategoryFilter(row.metadata));
}
/** Merchant delisted coupon (`disable: true` in series / shareTokenMetadata). */
function readCouponDisabledFromMetadata(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta))
        return false;
    const m = meta;
    if (m.disable === true)
        return true;
    const props = m.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        const beamioCoupon = props.beamioCoupon;
        if (beamioCoupon &&
            typeof beamioCoupon === 'object' &&
            !Array.isArray(beamioCoupon) &&
            beamioCoupon.disable === true) {
            return true;
        }
    }
    return false;
}
/** Client discover / claim lists: category Coupon and not delisted. */
function metadataMatchesListedClientCouponFilter(meta) {
    if (!metadataMatchesClientCouponCategoryFilter(meta))
        return false;
    return !readCouponDisabledFromMetadata(meta);
}
function filterListedClientCouponSeriesRows(rows) {
    return rows.filter((row) => metadataMatchesListedClientCouponFilter(row.metadata));
}
function shareTokenMetadataCouponItemIsListed(item) {
    if (!shareTokenMetadataCouponItemMatchesCategoryFilter(item))
        return false;
    return !readCouponDisabledFromMetadata(item);
}
function filterShareTokenMetadataCouponsForClient(share) {
    const coupons = share.coupons;
    if (!Array.isArray(coupons) || coupons.length === 0)
        return share;
    const filtered = coupons.filter((item) => shareTokenMetadataCouponItemMatchesCategoryFilter(item));
    if (filtered.length === coupons.length)
        return share;
    return { ...share, coupons: filtered };
}
/** Tier / issued-NFT `properties` for Program service catalog (productions / Product / Service / Menu). */
function propertiesLookLikeProductionProps(props) {
    if (isBeamioProductionNftCategory(props.category))
        return true;
    const beamioProduction = props.beamioProduction;
    return beamioProduction != null && typeof beamioProduction === 'object' && !Array.isArray(beamioProduction);
}
/** `cardCreateIssuedNft` metadata_extra_properties → coupon vs catalog (B-Unit indexer + UI). */
function resolveIssuedNftProductKindFromMetadataExtra(extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra))
        return 'coupon';
    if (propertiesLookLikeProductionProps(extra))
        return 'catalog';
    if (propertiesLookLikeCouponProps(extra))
        return 'coupon';
    return 'coupon';
}
function normalizeProductionCategoryOnTierProperties(props) {
    if (!propertiesLookLikeProductionProps(props))
        return props;
    return { ...props, category: normalizeBeamioCatalogGlobalCategory(props.category) };
}
function seriesMetadataLooksLikeProduction(meta) {
    if (isBeamioProductionNftCategory(meta.category))
        return true;
    if (typeof meta.productionId === 'string' && meta.productionId.trim())
        return true;
    const props = meta.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        return propertiesLookLikeProductionProps(props);
    }
    const id = typeof meta.id === 'string' ? meta.id.trim() : '';
    return Boolean(id && meta.singleSessionPrice != null);
}
function normalizeProductionSeriesMetadataJson(meta) {
    if (!seriesMetadataLooksLikeProduction(meta))
        return meta;
    const out = {
        ...meta,
        category: normalizeBeamioCatalogGlobalCategory(meta.category),
    };
    if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
        out.properties = normalizeProductionCategoryOnTierProperties(out.properties);
    }
    return out;
}
/** createIssuedNft metadata_extra_properties — coupon or catalog item (Product / Service / Menu). */
function normalizeIssuedNftMetadataExtraProperties(extra) {
    if (extra == null)
        return extra;
    let props;
    if (typeof extra === 'string') {
        const s = extra.trim();
        if (!s)
            return extra;
        try {
            const parsed = JSON.parse(s);
            if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                props = parsed;
            }
        }
        catch {
            return extra;
        }
    }
    else if (typeof extra === 'object' && !Array.isArray(extra)) {
        props = extra;
    }
    if (!props)
        return extra;
    let normalized = props;
    if (propertiesLookLikeProductionProps(props)) {
        normalized = normalizeProductionCategoryOnTierProperties(props);
    }
    else if (propertiesLookLikeCouponProps(props)) {
        normalized = normalizeCouponCategoryOnTierProperties(props);
    }
    return typeof extra === 'string' ? JSON.stringify(normalized) : normalized;
}
function metadataMatchesClientProductionCategoryFilter(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta))
        return false;
    const m = meta;
    const rootCat = m.category;
    if (rootCat != null && String(rootCat).trim() !== '') {
        return isBeamioProductionNftCategory(rootCat);
    }
    const props = m.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        const propCat = props.category;
        if (propCat != null && String(propCat).trim() !== '') {
            return isBeamioProductionNftCategory(propCat);
        }
    }
    return seriesMetadataLooksLikeProduction(m);
}
function filterClientProductionSeriesRows(rows) {
    return rows.filter((row) => metadataMatchesClientProductionCategoryFilter(row.metadata));
}
/** Issued-NFT series row → ledger / displayJson distribution fields (coupon vs catalog global category). */
function resolveIssuedNftDistributionFieldsFromSeriesMetadata(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta))
        return null;
    if (metadataMatchesClientCouponCategoryFilter(meta)) {
        const couponId = typeof meta.couponId === 'string' && meta.couponId.trim()
            ? meta.couponId.trim()
            : typeof meta.id === 'string' && meta.id.trim()
                ? meta.id.trim()
                : undefined;
        return {
            distributionKind: 'coupon',
            globalCategory: exports.BEAMIO_COUPON_NFT_CATEGORY,
            ...(couponId ? { couponId } : {}),
        };
    }
    if (metadataMatchesClientProductionCategoryFilter(meta)) {
        const productionId = typeof meta.productionId === 'string' && meta.productionId.trim()
            ? meta.productionId.trim()
            : typeof meta.id === 'string' && meta.id.trim()
                ? meta.id.trim()
                : undefined;
        return {
            distributionKind: 'catalog',
            globalCategory: normalizeBeamioCatalogGlobalCategory(meta.category),
            ...(productionId ? { productionId } : {}),
        };
    }
    return null;
}
function normalizeShareTokenMetadataProductions(share) {
    const productions = share.productions;
    if (!Array.isArray(productions) || productions.length === 0)
        return share;
    const next = productions.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return item;
        const row = { ...item };
        const id = String(row.id ?? row.productionId ?? '').trim();
        if (id || isBeamioProductionNftCategory(row.category) || row.singleSessionPrice != null) {
            row.category = normalizeBeamioCatalogGlobalCategory(row.category);
            const itemCategoryRaw = typeof row.itemCategory === 'string'
                ? row.itemCategory.trim()
                : typeof row.serviceCategory === 'string'
                    ? row.serviceCategory.trim()
                    : '';
            if (itemCategoryRaw)
                row.itemCategory = itemCategoryRaw;
            delete row.serviceCategory;
        }
        return (0, beamioTileBackgroundMetadata_1.applyBeamioTileBackgroundPhotoRuleToMetadataRow)(row, beamioTileBackgroundMetadata_1.BEAMIO_CATALOG_TILE_PHOTO_FIELD);
    });
    return { ...share, productions: next };
}
/** Card-level item category chips (`shareTokenMetadata.itemCategory`; legacy `serviceCategory`). */
function normalizeServiceCategoryLabelForHash(label) {
    return label.trim().replace(/\s+/g, ' ').toLowerCase();
}
function serviceCategoryHashIdFromLabel(label) {
    const key = normalizeServiceCategoryLabelForHash(label);
    if (!key)
        return '';
    return ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(`beamio:serviceCategory:${key}`)).slice(2, 18);
}
function normalizeShareTokenMetadataItemCategory(share) {
    const raw = share.itemCategory ?? share.serviceCategory;
    if (raw == null) {
        const { serviceCategory: _legacy, ...rest } = share;
        return rest;
    }
    if (!Array.isArray(raw)) {
        const { serviceCategory: _legacy, itemCategory: _removed, ...rest } = share;
        return rest;
    }
    const out = [];
    const hashKeysSeen = new Set();
    const idSeen = new Set();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        const row = entry;
        const label = typeof row.label === 'string' ? row.label.trim().slice(0, 128) : '';
        if (!label)
            continue;
        const hashKey = normalizeServiceCategoryLabelForHash(label);
        if (hashKeysSeen.has(hashKey))
            continue;
        const id = serviceCategoryHashIdFromLabel(label);
        if (!id || idSeen.has(id))
            continue;
        hashKeysSeen.add(hashKey);
        idSeen.add(id);
        out.push({ id, label });
    }
    const { serviceCategory: _legacy, ...base } = share;
    if (out.length === 0) {
        const { itemCategory: _removed, ...rest } = base;
        return rest;
    }
    return { ...base, itemCategory: out };
}
/** @deprecated Use `normalizeShareTokenMetadataItemCategory`. */
function normalizeShareTokenMetadataServiceCategory(share) {
    return normalizeShareTokenMetadataItemCategory(share);
}
