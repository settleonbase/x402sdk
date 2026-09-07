"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldShowCouponExpiryPill = exports.formatCouponExpiryPill = exports.buildCatalogShareHeadline = exports.buildDiscoverMerchantShareHeadline = exports.buildShareHeadline = exports.OG_LAYOUT_REV = void 0;
exports.layoutAppDownloadCacheBust = layoutAppDownloadCacheBust;
exports.buildDiscoverMerchantAppDownloadUrl = buildDiscoverMerchantAppDownloadUrl;
exports.buildCouponClaimAppDownloadUrl = buildCouponClaimAppDownloadUrl;
exports.buildCouponRedeemAppDownloadUrl = buildCouponRedeemAppDownloadUrl;
exports.parseDiscoverMerchantFromBeamioAppUrl = parseDiscoverMerchantFromBeamioAppUrl;
exports.parseDiscoverMerchantFromAppDownloadTarget = parseDiscoverMerchantFromAppDownloadTarget;
exports.parseCouponClaimFromBeamioAppUrl = parseCouponClaimFromBeamioAppUrl;
exports.parseRedeemShareFromBeamioAppUrl = parseRedeemShareFromBeamioAppUrl;
exports.parseRedeemShareFromAppDownloadTarget = parseRedeemShareFromAppDownloadTarget;
exports.parseCouponClaimFromAppDownloadTarget = parseCouponClaimFromAppDownloadTarget;
exports.buildBeamioAppDeeplinkUrlFromShareQuery = buildBeamioAppDeeplinkUrlFromShareQuery;
exports.parseCouponClaimShareRequest = parseCouponClaimShareRequest;
exports.decodeOgShareTokenPayload = decodeOgShareTokenPayload;
exports.decodeOgShareToken = decodeOgShareToken;
exports.buildShareUrlForOgToken = buildShareUrlForOgToken;
exports.resolveCouponClaimShareMeta = resolveCouponClaimShareMeta;
exports.computeIssuedSeriesMetadataRevision = computeIssuedSeriesMetadataRevision;
exports.buildIssuedNftExplorerImageUrl = buildIssuedNftExplorerImageUrl;
exports.resolveIssuedNftExplorerShareMeta = resolveIssuedNftExplorerShareMeta;
exports.buildFallbackCouponClaimShareMeta = buildFallbackCouponClaimShareMeta;
exports.renderCouponClaimOgPng = renderCouponClaimOgPng;
exports.warmCouponClaimOgJpeg = warmCouponClaimOgJpeg;
exports.renderCouponClaimOgJpeg = renderCouponClaimOgJpeg;
exports.warmIssuedNftExplorerOgJpeg = warmIssuedNftExplorerOgJpeg;
exports.renderCouponClaimShareHtml = renderCouponClaimShareHtml;
exports.isSocialShareCrawlerUserAgent = isSocialShareCrawlerUserAgent;
const crypto_1 = require("crypto");
const promises_1 = __importDefault(require("fs/promises"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const ethers_1 = require("ethers");
const sharp_1 = __importDefault(require("sharp"));
const db_1 = require("../db");
const couponMetadataCategory_1 = require("../couponMetadataCategory");
const catalogProductionVideoOg_1 = require("../catalogProductionVideoOg");
const couponClaimShareOgText_1 = require("./couponClaimShareOgText");
const BEAMIO_APP_ORIGIN = 'https://beamio.app';
const ISSUED_NFT_START_ID = 100000000000n;
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
/** Hi-res Lanczos preprocess multiplier for banner/icon embed (layout stays 1×). */
const OG_IMAGE_PREP_SCALE = 2;
/** Match homepage app-download ticket ratio: max-w-lg (512px) / 7.5rem (120px) ≈ 4.27:1. */
const OG_BANNER_CAPSULE_H = 258;
/** Match homepage `rounded-[1.75rem]` on a 7.5rem ticket: 28 / 120 × 258 ≈ 60. */
const OG_BANNER_CAPSULE_RX = 60;
/** Match homepage side notch diameter 36px on a 120px ticket: 18 / 120 × 258 ≈ 39. */
const OG_BANNER_NOTCH_R = 39;
/** Homepage uses `mt-3` (12 CSS px); scaled from 512px ticket to 1100px OG ticket. */
const OG_BANNER_META_TOP_GAP = 26;
const OG_BANNER_HEADLINE_FONT_SIZE = 34;
const OG_BANNER_HEADLINE_BASELINE_Y = 56;
const OG_BANNER_HEADLINE_BOX_TOP_GAP = OG_BANNER_HEADLINE_BASELINE_Y - OG_BANNER_HEADLINE_FONT_SIZE;
const OG_BANNER_HEADLINE_VISUAL_TOP_GAP = Math.round(OG_BANNER_HEADLINE_BOX_TOP_GAP / 2);
/** Bottom breathing room is 4× the headline visual top margin. */
const OG_BANNER_BOTTOM_EXTRA_GAP = OG_BANNER_HEADLINE_VISUAL_TOP_GAP * 4;
const OG_JPEG_QUALITY = 93;
/** Bump when OG layout/quality changes; embedded in `/og/s/` token JSON to bust social platform caches. */
exports.OG_LAYOUT_REV = 29;
/** Stable `v=` when crawlers hit a share URL that omitted cache-bust (forces Meta/WhatsApp re-key). */
function layoutAppDownloadCacheBust() {
    return `l${exports.OG_LAYOUT_REV}`;
}
/** Discover merchant videoOg hero — taller 4:3-ish banner (not coupon ticket strip). */
const DISCOVER_MERCHANT_OG_BANNER_H = 360;
/** Cross-worker OG JPEG cache (Cluster forks do not share in-memory ogImageCache). */
const OG_DISK_CACHE_DIR = path_1.default.join(os_1.default.tmpdir(), 'beamio-og-share-cache', `v${exports.OG_LAYOUT_REV}`);
const asRecord = (v) => v && typeof v === 'object' ? v : null;
const readString = (v) => (typeof v === 'string' ? v.trim() : '');
const readMetadataCouponId = (meta) => {
    if (!meta)
        return '';
    const root = readString(meta.couponId);
    if (root)
        return root;
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    return readString(beamioCoupon?.couponId);
};
const readMetadataTitle = (meta) => {
    if (!meta)
        return '';
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    return (readString(meta.title) ||
        readString(meta.name) ||
        readString(beamioCoupon?.title) ||
        readString(beamioCoupon?.name));
};
const readMetadataSubtitle = (meta) => {
    if (!meta)
        return '';
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    return (readString(meta.subtitle) ||
        readString(meta.description) ||
        readString(beamioCoupon?.subtitle) ||
        readString(beamioCoupon?.description));
};
const MERCHANT_NAME_KEYS = [
    'displayName',
    'merchantName',
    'brandName',
    'storeName',
    'programName',
    'brand',
    'merchant',
];
/** Default Card Unit Name — not a merchant brand; prefer shareTokenMetadata.displayName. */
const GENERIC_PROGRAM_UNIT_NAMES = new Set(['beamio']);
const readMetadataMerchantName = (meta) => {
    if (!meta)
        return '';
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    for (const src of [meta, beamioCoupon, props]) {
        if (!src)
            continue;
        for (const key of MERCHANT_NAME_KEYS) {
            const v = readString(src[key]);
            if (v)
                return v;
        }
    }
    return '';
};
const readCardProgramName = (metadata) => {
    if (!metadata)
        return '';
    const shareTokenMetadata = asRecord(metadata.shareTokenMetadata);
    const displayName = readString(shareTokenMetadata?.displayName) || readString(metadata.displayName);
    if (displayName)
        return displayName;
    const unitOrProgramName = readString(shareTokenMetadata?.name) ||
        readString(metadata.name) ||
        readString(metadata.programName);
    if (unitOrProgramName && !GENERIC_PROGRAM_UNIT_NAMES.has(unitOrProgramName.toLowerCase())) {
        return unitOrProgramName;
    }
    return unitOrProgramName;
};
const resolveMerchantNameForShare = async (cardNorm, couponMeta) => {
    const fromCoupon = readMetadataMerchantName(couponMeta);
    if (fromCoupon)
        return truncateText(fromCoupon, 32);
    try {
        const cardRow = await (0, db_1.getCardByAddress)(cardNorm);
        const fromCard = readCardProgramName(asRecord(cardRow?.metadata ?? null));
        if (fromCard)
            return truncateText(fromCard, 32);
    }
    catch {
        // ignore — fall back below
    }
    return 'Beamio';
};
const buildShareHeadline = (merchantName, shareKind) => {
    const verb = shareKind === 'redeem' ? 'Redeem' : 'Claim';
    return `${verb} a ${truncateText(merchantName.trim() || 'Beamio', 28)} Coupon`;
};
exports.buildShareHeadline = buildShareHeadline;
const buildDiscoverMerchantShareHeadline = (merchantName) => `Discover ${truncateText(merchantName.trim() || 'Beamio', 32)} on Beamio`;
exports.buildDiscoverMerchantShareHeadline = buildDiscoverMerchantShareHeadline;
function buildDiscoverMerchantAppDownloadUrl(cardAddress, referrerEoa) {
    const card = ethers_1.ethers.getAddress(cardAddress);
    let discoverUrl = `${BEAMIO_APP_ORIGIN}/app/?beamiocard=${encodeURIComponent(card)}&discover=open`;
    const refRaw = referrerEoa?.trim() ?? '';
    if (refRaw && ethers_1.ethers.isAddress(refRaw)) {
        discoverUrl += `&ref=${encodeURIComponent(ethers_1.ethers.getAddress(refRaw))}`;
    }
    return `${BEAMIO_APP_ORIGIN}/app-download?target=${encodeURIComponent(discoverUrl)}`;
}
const buildCatalogShareHeadline = (merchantName) => {
    const trimmed = truncateText(merchantName.trim() || 'Beamio', 28);
    return `Get a ${trimmed} Catalog Item`;
};
exports.buildCatalogShareHeadline = buildCatalogShareHeadline;
const catalogGlobalCategoryLabel = (id) => {
    const s = String(id);
    if (s === 'Product')
        return 'Product';
    if (s === 'Menu')
        return 'Menu';
    if (s === 'SalesManagement')
        return 'Sales Management';
    if (s === 'ShareLink')
        return 'Share link';
    return 'Service';
};
const readMetadataProductionId = (meta) => {
    if (!meta)
        return '';
    const root = readString(meta.productionId) || readString(meta.id);
    if (root)
        return root;
    const props = asRecord(meta.properties);
    const beamioProduction = asRecord(props?.beamioProduction);
    return readString(beamioProduction?.productionId);
};
const readProductionShareFields = (meta) => {
    if (!meta) {
        return {
            name: '',
            subtitle: '',
            description: '',
            globalCategory: 'Service',
            itemCategoryId: '',
            iconUrl: '',
            backgroundImage: '',
            backgroundImageMime: '',
            backgroundColorHex: '#ea580c',
            publisherBeamioTag: '',
        };
    }
    const props = asRecord(meta.properties);
    const fromPropsBp = asRecord(props?.beamioProduction);
    const fromRootBp = asRecord(meta.beamioProduction);
    const beamioProduction = fromPropsBp || fromRootBp
        ? { ...fromPropsBp, ...fromRootBp }
        : undefined;
    const globalCategory = catalogGlobalCategoryLabel((0, couponMetadataCategory_1.normalizeBeamioCatalogGlobalCategory)(meta.category ?? props?.category ?? beamioProduction?.category));
    const itemCategoryId = readString(beamioProduction?.itemCategory) ||
        readString(meta.itemCategory) ||
        readString(meta.serviceCategory);
    const name = readString(beamioProduction?.name) || readString(meta.name) || readString(meta.title) || 'Catalog Item';
    const subtitle = readString(beamioProduction?.subtitle) ||
        readString(meta.subtitle) ||
        '';
    const description = readString(beamioProduction?.description) ||
        readString(meta.description) ||
        '';
    const iconUrl = readString(beamioProduction?.icon) || readString(meta.icon) || readString(meta.iconUrl);
    const backgroundImage = readString(beamioProduction?.productionImage) ||
        readString(meta.productionImage) ||
        readString(meta.backgroundImage);
    let backgroundImageMime = readString(beamioProduction?.productionImageMime) || readString(meta.productionImageMime) || '';
    if (!backgroundImageMime.trim() && backgroundImage.trim()) {
        backgroundImageMime = (0, catalogProductionVideoOg_1.inferProductionImageMimeFromUrl)(backgroundImage);
    }
    const bgRaw = readString(beamioProduction?.backgroundColor) ||
        readMetadataStringFromKeys(meta, COUPON_BACKGROUND_COLOR_KEYS);
    const backgroundColorHex = bgRaw ? (bgRaw.startsWith('#') ? bgRaw : `#${bgRaw}`) : '#ea580c';
    const publisherBeamioTag = readString(beamioProduction?.publisherBeamioTag) ||
        readString(meta.publisherBeamioTag) ||
        readString(meta.publisherAccountName) ||
        '';
    return {
        name,
        subtitle,
        description,
        globalCategory,
        itemCategoryId,
        iconUrl,
        backgroundImage,
        backgroundImageMime,
        backgroundColorHex,
        publisherBeamioTag,
    };
};
function buildCatalogCouponClaimShareCopy(fields) {
    const presentation = (0, catalogProductionVideoOg_1.resolveCatalogProductionSharePresentation)({
        channelName: fields.name,
        videoTitle: fields.subtitle,
        description: fields.description,
        productionImage: fields.backgroundImage,
        productionImageMime: fields.backgroundImageMime,
        iconUrl: fields.iconUrl,
        publisherBeamioTag: fields.publisherBeamioTag,
    });
    return {
        catalogLayout: presentation.layout,
        title: presentation.title,
        subtitle: presentation.subtitle,
        ...(presentation.publisherLine ? { publisherLine: presentation.publisherLine } : {}),
        iconUrl: presentation.iconUrl,
        backgroundImage: presentation.bannerImageUrl,
    };
}
const resolveItemCategoryLabelForShare = async (cardNorm, itemCategoryId) => {
    const id = itemCategoryId.trim();
    if (!id)
        return '';
    try {
        const cardRow = await (0, db_1.getCardByAddress)(cardNorm);
        const shareTokenMetadata = asRecord(asRecord(cardRow?.metadata ?? null)?.shareTokenMetadata);
        const chips = shareTokenMetadata?.itemCategory ?? shareTokenMetadata?.serviceCategory;
        if (Array.isArray(chips)) {
            for (const row of chips) {
                const chip = asRecord(row);
                if (!chip)
                    continue;
                if (readString(chip.id) === id) {
                    return readString(chip.label) || id;
                }
            }
        }
    }
    catch {
        // ignore — fall back to raw id
    }
    return id;
};
const readMetadataIconUrl = (meta) => {
    if (!meta)
        return '';
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    const shareTokenMetadata = asRecord(props?.shareTokenMetadata);
    const imageObj = asRecord(meta.image);
    return (readString(meta.iconUrl) ||
        readString(meta.icon) ||
        readString(meta.logoUrl) ||
        readString(meta.logo) ||
        readString(beamioCoupon?.iconUrl) ||
        readString(beamioCoupon?.icon) ||
        readString(beamioCoupon?.logoUrl) ||
        readString(beamioCoupon?.logo) ||
        readString(shareTokenMetadata?.logoUrl) ||
        readString(shareTokenMetadata?.logo) ||
        readString(imageObj?.url) ||
        readString(meta.image));
};
const COUPON_BACKGROUND_IMAGE_KEYS = [
    'couponImage',
    'background',
    'backgroundImage',
    'backgroundImageUrl',
    'cover',
    'coverImage',
];
const readMetadataStringFromKeys = (src, keys) => {
    if (!src)
        return '';
    for (const key of keys) {
        const v = readString(src[key]);
        if (v)
            return v;
    }
    return '';
};
const readMetadataBackgroundImage = (meta) => {
    if (!meta)
        return '';
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    return (readMetadataStringFromKeys(meta, COUPON_BACKGROUND_IMAGE_KEYS) ||
        readMetadataStringFromKeys(beamioCoupon, COUPON_BACKGROUND_IMAGE_KEYS));
};
const COUPON_BACKGROUND_COLOR_KEYS = [
    'backgroundColor',
    'bgColor',
    'color',
    'backgroundColorHex',
    'background_color',
];
const readMetadataBackgroundColor = (meta) => {
    if (!meta)
        return '';
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    const c = readMetadataStringFromKeys(meta, COUPON_BACKGROUND_COLOR_KEYS) ||
        readMetadataStringFromKeys(beamioCoupon, COUPON_BACKGROUND_COLOR_KEYS);
    if (!c)
        return '';
    return c.startsWith('#') ? c : `#${c}`;
};
const formatCouponExpiryPill = (validBeforeSec) => {
    if (!Number.isFinite(validBeforeSec ?? NaN) || (validBeforeSec ?? 0) <= 0)
        return 'VALID NOW';
    const now = Math.floor(Date.now() / 1000);
    if ((validBeforeSec ?? 0) <= now)
        return 'EXPIRED';
    const delta = (validBeforeSec ?? now) - now;
    if (delta >= 86_400)
        return `EXPIRES IN ${Math.ceil(delta / 86_400)}D`;
    if (delta >= 3_600)
        return `EXPIRES IN ${Math.ceil(delta / 3_600)}H`;
    return `EXPIRES IN ${Math.max(1, Math.ceil(delta / 60))}M`;
};
exports.formatCouponExpiryPill = formatCouponExpiryPill;
const readMetadataValidBeforeSec = (meta) => {
    if (!meta)
        return null;
    const props = asRecord(meta.properties);
    const beamioCoupon = asRecord(props?.beamioCoupon);
    for (const src of [meta, beamioCoupon, props]) {
        if (!src)
            continue;
        for (const key of ['issuedNftValidBefore', 'validBefore', 'expiresAt', 'valid_before']) {
            const n = Number(src[key]);
            if (Number.isFinite(n) && n > 0)
                return n;
        }
    }
    return null;
};
const couponExpiryUsesUrgentVariant = (expiresLabel) => expiresLabel === 'EXPIRED' || /\bEXPIRES IN \d+H\b|\bEXPIRES IN \d+M\b/.test(expiresLabel);
/** Hide non-actionable open-ended status pills on coupon ticket UI. */
const shouldShowCouponExpiryPill = (expiresLabel) => {
    const normalized = expiresLabel.trim().toUpperCase();
    if (!normalized)
        return false;
    return normalized !== 'VALID NOW' && normalized !== 'NO EXPIRY';
};
exports.shouldShowCouponExpiryPill = shouldShowCouponExpiryPill;
function buildCouponClaimAppDownloadUrl(cardAddress, couponId) {
    const card = ethers_1.ethers.getAddress(cardAddress);
    const claimUrl = `${BEAMIO_APP_ORIGIN}/app/?beamiocard=${encodeURIComponent(card)}&couponId=${encodeURIComponent(couponId.trim())}&claim=open`;
    return `${BEAMIO_APP_ORIGIN}/app-download?target=${encodeURIComponent(claimUrl)}`;
}
function isAllowedBeamioAppPath(pathname) {
    return pathname === '/app/' || pathname === '/app' || pathname.startsWith('/app/');
}
function buildCouponRedeemAppDownloadUrl(cardAddress, redeemCode, couponId) {
    const card = ethers_1.ethers.getAddress(cardAddress);
    const params = new URLSearchParams();
    params.set('beamiocard', card);
    params.set('redeemcode', redeemCode.trim());
    const cid = couponId?.trim() ?? '';
    if (cid)
        params.set('couponId', cid);
    const redeemUrl = `${BEAMIO_APP_ORIGIN}/app/?${params.toString()}`;
    return `${BEAMIO_APP_ORIGIN}/app-download?target=${encodeURIComponent(redeemUrl)}`;
}
function appendAppDownloadCacheBust(appDownloadUrl, v) {
    const vTrim = v?.trim() ?? '';
    if (!vTrim)
        return appDownloadUrl;
    try {
        const u = new URL(appDownloadUrl);
        u.searchParams.set('v', vTrim);
        return u.toString();
    }
    catch {
        return appDownloadUrl;
    }
}
function parseDiscoverMerchantFromBeamioAppUrl(raw) {
    const input = raw?.trim() ?? '';
    if (!input)
        return null;
    try {
        const url = new URL(input);
        if (url.origin !== BEAMIO_APP_ORIGIN)
            return null;
        if (!isAllowedBeamioAppPath(url.pathname))
            return null;
        const cardAddress = (url.searchParams.get('beamiocard') ?? url.searchParams.get('Beamiocard') ?? '').trim();
        const redeemCode = decodeURIComponent((url.searchParams.get('redeemcode') ?? url.searchParams.get('Redeemcode') ?? '').trim());
        const couponId = decodeURIComponent((url.searchParams.get('couponId') ?? url.searchParams.get('couponid') ?? '').trim());
        const discover = (url.searchParams.get('discover') ?? '').trim().toLowerCase();
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
            return null;
        if (redeemCode || couponId)
            return null;
        if (discover !== 'open' && discover !== '1' && discover !== 'true')
            return null;
        return { kind: 'discover_merchant', cardAddress: ethers_1.ethers.getAddress(cardAddress) };
    }
    catch {
        return null;
    }
}
function parseDiscoverMerchantFromAppDownloadTarget(target) {
    const trimmed = target?.trim() ?? '';
    if (!trimmed)
        return null;
    try {
        const wrapper = new URL(trimmed);
        if (wrapper.origin !== BEAMIO_APP_ORIGIN)
            return null;
        if (!isAllowedBeamioAppPath(wrapper.pathname))
            return null;
        return parseDiscoverMerchantFromBeamioAppUrl(trimmed);
    }
    catch {
        return null;
    }
}
function parseCouponClaimFromBeamioAppUrl(raw) {
    const input = raw?.trim() ?? '';
    if (!input)
        return null;
    try {
        const url = new URL(input);
        if (url.origin !== BEAMIO_APP_ORIGIN)
            return null;
        if (!isAllowedBeamioAppPath(url.pathname))
            return null;
        const cardAddress = (url.searchParams.get('beamiocard') ?? url.searchParams.get('Beamiocard') ?? '').trim();
        const redeemCode = decodeURIComponent((url.searchParams.get('redeemcode') ?? url.searchParams.get('Redeemcode') ?? '').trim());
        const couponId = decodeURIComponent((url.searchParams.get('couponId') ?? url.searchParams.get('couponid') ?? '').trim());
        const claim = (url.searchParams.get('claim') ?? '').trim().toLowerCase();
        if (!cardAddress || !couponId || !ethers_1.ethers.isAddress(cardAddress))
            return null;
        if (redeemCode)
            return null;
        if (claim && claim !== 'open' && claim !== '1' && claim !== 'true')
            return null;
        return { kind: 'open_claim', cardAddress: ethers_1.ethers.getAddress(cardAddress), couponId };
    }
    catch {
        return null;
    }
}
function parseRedeemShareFromBeamioAppUrl(raw) {
    const input = raw?.trim() ?? '';
    if (!input)
        return null;
    try {
        const url = new URL(input);
        if (url.origin !== BEAMIO_APP_ORIGIN)
            return null;
        if (!isAllowedBeamioAppPath(url.pathname))
            return null;
        const cardAddress = (url.searchParams.get('beamiocard') ?? url.searchParams.get('Beamiocard') ?? '').trim();
        const redeemCode = decodeURIComponent((url.searchParams.get('redeemcode') ?? url.searchParams.get('Redeemcode') ?? '').trim());
        if (!cardAddress || !redeemCode || !ethers_1.ethers.isAddress(cardAddress))
            return null;
        const couponId = decodeURIComponent((url.searchParams.get('couponId') ?? url.searchParams.get('couponid') ?? '').trim());
        return {
            kind: 'redeem',
            cardAddress: ethers_1.ethers.getAddress(cardAddress),
            redeemCode,
            ...(couponId ? { couponId } : {}),
        };
    }
    catch {
        return null;
    }
}
function parseRedeemShareFromAppDownloadTarget(target) {
    const trimmed = target?.trim() ?? '';
    if (!trimmed)
        return null;
    try {
        const wrapper = new URL(trimmed);
        if (wrapper.origin !== BEAMIO_APP_ORIGIN)
            return null;
        if (!isAllowedBeamioAppPath(wrapper.pathname))
            return null;
        return parseRedeemShareFromBeamioAppUrl(trimmed);
    }
    catch {
        return null;
    }
}
function parseCouponClaimFromAppDownloadTarget(target) {
    const trimmed = target?.trim() ?? '';
    if (!trimmed)
        return null;
    try {
        const wrapper = new URL(trimmed);
        if (wrapper.origin !== BEAMIO_APP_ORIGIN)
            return null;
        if (!isAllowedBeamioAppPath(wrapper.pathname))
            return null;
        return parseCouponClaimFromBeamioAppUrl(trimmed);
    }
    catch {
        return null;
    }
}
/** Social crawlers may request `/app/?beamiocard=…&discover=open` without an app-download wrapper. */
function buildBeamioAppDeeplinkUrlFromShareQuery(query) {
    const cardRaw = readString(query.beamiocard ?? query.Beamiocard ?? query.card);
    if (!cardRaw || !ethers_1.ethers.isAddress(cardRaw))
        return null;
    const card = ethers_1.ethers.getAddress(cardRaw);
    const discover = readString(query.discover).toLowerCase();
    const couponId = decodeURIComponent(readString(query.couponId ?? query.couponid));
    const redeemCode = decodeURIComponent(readString(query.redeemcode ?? query.Redeemcode ?? query.redeemCode));
    const claim = readString(query.claim).toLowerCase();
    const hasShareIntent = discover === 'open' ||
        discover === '1' ||
        discover === 'true' ||
        Boolean(couponId) ||
        Boolean(redeemCode);
    if (!hasShareIntent)
        return null;
    const sp = new URLSearchParams();
    sp.set('beamiocard', card);
    if (discover)
        sp.set('discover', discover);
    if (couponId)
        sp.set('couponId', couponId);
    if (redeemCode)
        sp.set('redeemcode', redeemCode);
    if (claim)
        sp.set('claim', claim);
    return `${BEAMIO_APP_ORIGIN}/app/?${sp.toString()}`;
}
function parseDirectAppDeeplinkShareRequest(query, withCacheBust) {
    const appUrl = buildBeamioAppDeeplinkUrlFromShareQuery(query);
    if (!appUrl)
        return null;
    const redeem = parseRedeemShareFromBeamioAppUrl(appUrl);
    if (redeem) {
        return {
            params: redeem,
            shareUrl: withCacheBust(appUrl),
        };
    }
    const discoverMerchant = parseDiscoverMerchantFromBeamioAppUrl(appUrl);
    if (discoverMerchant) {
        return {
            params: discoverMerchant,
            // og:url must match the URL users paste (direct /app/ deeplink), not app-download wrapper.
            shareUrl: withCacheBust(appUrl),
        };
    }
    const openClaim = parseCouponClaimFromBeamioAppUrl(appUrl);
    if (openClaim) {
        return {
            params: openClaim,
            shareUrl: withCacheBust(appUrl),
        };
    }
    return null;
}
function parseCouponClaimShareRequest(query) {
    const target = readString(query.target);
    const cacheBustV = readString(query.v) || readString(query.iiis);
    const withCacheBust = (url) => appendAppDownloadCacheBust(url, cacheBustV);
    if (target) {
        let innerTarget = target;
        let shareUrl = '';
        try {
            const asUrl = new URL(target);
            if (asUrl.origin === BEAMIO_APP_ORIGIN && (asUrl.pathname === '/app-download' || asUrl.pathname === '/app-download/')) {
                innerTarget = asUrl.searchParams.get('target')?.trim() ?? '';
                shareUrl = asUrl.toString();
            }
        }
        catch {
            // Use raw target as inner claim URL.
        }
        const openClaim = parseCouponClaimFromAppDownloadTarget(innerTarget);
        const redeem = parseRedeemShareFromAppDownloadTarget(innerTarget);
        const discoverMerchant = parseDiscoverMerchantFromAppDownloadTarget(innerTarget);
        if (redeem) {
            if (!shareUrl) {
                shareUrl = buildCouponRedeemAppDownloadUrl(redeem.cardAddress, redeem.redeemCode, redeem.couponId);
            }
            return { params: redeem, shareUrl: withCacheBust(shareUrl) };
        }
        if (discoverMerchant) {
            if (!shareUrl)
                shareUrl = buildDiscoverMerchantAppDownloadUrl(discoverMerchant.cardAddress);
            return { params: discoverMerchant, shareUrl: withCacheBust(shareUrl) };
        }
        if (openClaim) {
            if (!shareUrl)
                shareUrl = buildCouponClaimAppDownloadUrl(openClaim.cardAddress, openClaim.couponId);
            return { params: openClaim, shareUrl: withCacheBust(shareUrl) };
        }
        return null;
    }
    const direct = parseDirectAppDeeplinkShareRequest(query, withCacheBust);
    if (direct)
        return direct;
    const card = readString(query.card ?? query.beamiocard ?? query.Beamiocard);
    const couponId = readString(query.couponId ?? query.couponid);
    const redeemCode = readString(query.redeemcode ?? query.redeemCode ?? query.Redeemcode);
    if (card && redeemCode && ethers_1.ethers.isAddress(card)) {
        const params = {
            kind: 'redeem',
            cardAddress: ethers_1.ethers.getAddress(card),
            redeemCode,
            ...(couponId ? { couponId } : {}),
        };
        return { params, shareUrl: buildCouponRedeemAppDownloadUrl(params.cardAddress, params.redeemCode, params.couponId) };
    }
    if (!card || !couponId || !ethers_1.ethers.isAddress(card))
        return null;
    const params = { kind: 'open_claim', cardAddress: ethers_1.ethers.getAddress(card), couponId };
    return { params, shareUrl: buildCouponClaimAppDownloadUrl(params.cardAddress, params.couponId) };
}
function readShareUrlCacheBust(shareUrl) {
    try {
        const url = new URL(shareUrl);
        return readString(url.searchParams.get('v'));
    }
    catch {
        return '';
    }
}
/** Prefer path-based OG URL (no query string) for WeChat; JPEG for preview compatibility. */
function encodeOgShareToken(params, shareUrl) {
    const cacheBust = shareUrl ? readShareUrlCacheBust(shareUrl) : '';
    const payload = params.kind === 'redeem'
        ? {
            k: 'r',
            c: params.cardAddress,
            r: params.redeemCode,
            v: exports.OG_LAYOUT_REV,
            ...(cacheBust ? { b: cacheBust } : {}),
            ...(params.couponId ? { i: params.couponId } : {}),
        }
        : params.kind === 'discover_merchant'
            ? {
                k: 'd',
                c: params.cardAddress,
                v: exports.OG_LAYOUT_REV,
                ...(cacheBust ? { b: cacheBust } : {}),
            }
            : {
                k: 'o',
                c: params.cardAddress,
                i: params.couponId,
                v: exports.OG_LAYOUT_REV,
                ...(cacheBust ? { b: cacheBust } : {}),
            };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}
function decodeOgShareTokenPayload(tokenRaw) {
    let token = tokenRaw.replace(/\.jpg$/i, '').trim();
    if (!token)
        return null;
    // Legacy WeChat square suffix — always serve full 1200×630 wide card art.
    if (token.endsWith('-wx'))
        token = token.slice(0, -3);
    try {
        const raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
        const cacheBust = readString(raw.b);
        if (raw.k === 'r' && raw.c && raw.r && ethers_1.ethers.isAddress(raw.c)) {
            return {
                params: {
                    kind: 'redeem',
                    cardAddress: ethers_1.ethers.getAddress(raw.c),
                    redeemCode: raw.r,
                    ...(raw.i ? { couponId: raw.i } : {}),
                },
                ...(cacheBust ? { cacheBust } : {}),
            };
        }
        if (raw.k === 'd' && raw.c && ethers_1.ethers.isAddress(raw.c)) {
            return {
                params: { kind: 'discover_merchant', cardAddress: ethers_1.ethers.getAddress(raw.c) },
                ...(cacheBust ? { cacheBust } : {}),
            };
        }
        if (raw.k === 'o' && raw.c && raw.i && ethers_1.ethers.isAddress(raw.c)) {
            return {
                params: { kind: 'open_claim', cardAddress: ethers_1.ethers.getAddress(raw.c), couponId: raw.i },
                ...(cacheBust ? { cacheBust } : {}),
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
function decodeOgShareToken(tokenRaw) {
    return decodeOgShareTokenPayload(tokenRaw)?.params ?? null;
}
function buildShareUrlForOgToken(params, cacheBust) {
    const base = params.kind === 'redeem'
        ? buildCouponRedeemAppDownloadUrl(params.cardAddress, params.redeemCode, params.couponId)
        : params.kind === 'discover_merchant'
            ? buildDiscoverMerchantAppDownloadUrl(params.cardAddress)
            : buildCouponClaimAppDownloadUrl(params.cardAddress, params.couponId);
    return cacheBust ? appendAppDownloadCacheBust(base, cacheBust) : base;
}
function ogShareTokenFromImageUrl(ogImageUrl) {
    const trimmed = ogImageUrl.trim();
    const prefix = `${BEAMIO_APP_ORIGIN}/og/s/`;
    if (!trimmed.startsWith(prefix))
        return null;
    return trimmed.slice(prefix.length).replace(/\.jpg$/i, '');
}
function ogShareDiskCachePath(token) {
    return path_1.default.join(OG_DISK_CACHE_DIR, `${token}.jpg`);
}
async function ensureOgDiskCacheDir() {
    await promises_1.default.mkdir(OG_DISK_CACHE_DIR, { recursive: true });
}
async function readOgShareDiskCache(token) {
    try {
        const cachePath = ogShareDiskCachePath(token);
        if (!fs_1.default.existsSync(cachePath))
            return null;
        const buf = await promises_1.default.readFile(cachePath);
        return buf.length > 0 ? buf : null;
    }
    catch {
        return null;
    }
}
async function writeOgShareDiskCache(token, buf) {
    await ensureOgDiskCacheDir();
    const finalPath = ogShareDiskCachePath(token);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    await promises_1.default.writeFile(tmpPath, buf);
    await promises_1.default.rename(tmpPath, finalPath);
}
function ogShareMemoryCacheKey(format, token) {
    return `${format}:wide:v${exports.OG_LAYOUT_REV}:${token}`;
}
function buildOgImageUrl(_shareUrl, params) {
    if (params) {
        return `${BEAMIO_APP_ORIGIN}/og/s/${encodeOgShareToken(params, _shareUrl)}.jpg`;
    }
    return `${BEAMIO_APP_ORIGIN}/og.png`;
}
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function truncateText(text, maxLen) {
    const s = text.trim();
    if (s.length <= maxLen)
        return s;
    return `${s.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}
async function fetchImageBuffer(url) {
    const trimmed = url.trim();
    if (!trimmed.startsWith('https://'))
        return null;
    try {
        const res = await fetch(trimmed, { signal: AbortSignal.timeout(12000) });
        if (!res.ok)
            return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length <= 0 || buf.length > 8_000_000)
            return null;
        return buf;
    }
    catch {
        return null;
    }
}
/** Lanczos3 cover-crop to exact slot pixels before SVG embed (avoids libvips SVG downscale blur). */
async function fetchImageCoverPngDataUrl(url, width, height) {
    const buf = await fetchImageBuffer(url);
    if (!buf || width <= 0 || height <= 0)
        return null;
    try {
        const png = await (0, sharp_1.default)(buf)
            .rotate()
            .toColorspace('srgb')
            .resize(Math.round(width), Math.round(height), {
            fit: 'cover',
            position: 'centre',
            kernel: sharp_1.default.kernel.lanczos3,
        })
            .withIccProfile('srgb')
            .png({ compressionLevel: 6 })
            .toBuffer();
        return `data:image/png;base64,${png.toString('base64')}`;
    }
    catch {
        return null;
    }
}
async function fetchBannerFitHeightPngDataUrl(url, width, height) {
    const buf = await fetchImageBuffer(url);
    const slotW = Math.round(width);
    const slotH = Math.round(height);
    if (!buf || slotW <= 0 || slotH <= 0)
        return null;
    try {
        const blurredCover = await (0, sharp_1.default)(buf)
            .rotate()
            .toColorspace('srgb')
            .resize(slotW, slotH, {
            fit: 'cover',
            position: 'centre',
            kernel: sharp_1.default.kernel.lanczos3,
        })
            .blur(24)
            .withIccProfile('srgb')
            .png({ compressionLevel: 6 })
            .toBuffer();
        const foregroundResult = await (0, sharp_1.default)(buf)
            .rotate()
            .toColorspace('srgb')
            .resize({ height: slotH, kernel: sharp_1.default.kernel.lanczos3 })
            .withIccProfile('srgb')
            .png({ compressionLevel: 6 })
            .toBuffer({ resolveWithObject: true });
        const foreground = foregroundResult.data;
        const foregroundW = foregroundResult.info.width;
        const cropLeft = Math.max(0, Math.floor((foregroundW - slotW) / 2));
        const foregroundInput = foregroundW > slotW
            ? await (0, sharp_1.default)(foreground)
                .extract({ left: cropLeft, top: 0, width: slotW, height: slotH })
                .withIccProfile('srgb')
                .png({ compressionLevel: 6 })
                .toBuffer()
            : foreground;
        const foregroundLeft = foregroundW > slotW ? 0 : Math.floor((slotW - foregroundW) / 2);
        const canvas = await (0, sharp_1.default)(blurredCover)
            .composite([{ input: foregroundInput, left: foregroundLeft, top: 0 }])
            .withIccProfile('srgb')
            .png({ compressionLevel: 6 })
            .toBuffer();
        return `data:image/png;base64,${canvas.toString('base64')}`;
    }
    catch {
        return null;
    }
}
async function lookupCouponSeriesMeta(cardNorm, wantedCouponId) {
    const candidates = await (0, db_1.listCouponIssuedNftSeriesForCardDescending)(cardNorm, 300);
    for (const row of candidates) {
        if (!(0, couponMetadataCategory_1.metadataMatchesClientCouponCategoryFilter)(row.metadata))
            continue;
        let tid;
        try {
            tid = BigInt(row.tokenId);
        }
        catch {
            continue;
        }
        if (tid < ISSUED_NFT_START_ID)
            continue;
        const meta = asRecord(row.metadata);
        if (!meta)
            continue;
        if (readMetadataCouponId(meta) !== wantedCouponId)
            continue;
        return { matchedMeta: meta, validBeforeSec: readMetadataValidBeforeSec(meta) };
    }
    return { matchedMeta: null, validBeforeSec: null };
}
function lookupProductionRowFromShareTokenMetadata(cardRow, wantedProductionId) {
    const shareTokenMetadata = asRecord(asRecord(cardRow?.metadata ?? null)?.shareTokenMetadata);
    const productions = shareTokenMetadata?.productions;
    if (!Array.isArray(productions))
        return null;
    for (const entry of productions) {
        const row = asRecord(entry);
        if (!row)
            continue;
        const id = readString(row.id) || readString(row.productionId);
        if (id !== wantedProductionId)
            continue;
        return row;
    }
    return null;
}
function productionShareFieldsNeedShareTokenHydration(fields) {
    if (fields.backgroundImage.trim())
        return false;
    if (fields.subtitle.trim() || fields.description.trim())
        return false;
    if (fields.name.trim() && fields.name !== 'Catalog Item')
        return false;
    return true;
}
async function resolveCatalogSeriesMetaForShare(cardNorm, wantedProductionId, seriesMeta) {
    let merged = seriesMeta ? (0, catalogProductionVideoOg_1.flattenIssuedProductionSeriesMetadata)(seriesMeta) : null;
    let fields = readProductionShareFields(merged);
    if (!productionShareFieldsNeedShareTokenHydration(fields))
        return merged;
    try {
        const cardRow = await (0, db_1.getCardByAddress)(cardNorm);
        const fromShare = lookupProductionRowFromShareTokenMetadata(cardRow, wantedProductionId);
        if (fromShare) {
            const flatShare = (0, catalogProductionVideoOg_1.flattenIssuedProductionSeriesMetadata)(fromShare);
            merged = { ...merged, ...flatShare };
        }
    }
    catch {
        // ignore — keep flattened series meta
    }
    return merged;
}
async function lookupProductionSeriesMeta(cardNorm, wantedProductionId) {
    const candidates = await (0, db_1.listProductionIssuedNftSeriesForCardDescending)(cardNorm, 300);
    for (const row of candidates) {
        if (!(0, couponMetadataCategory_1.metadataMatchesClientProductionCategoryFilter)(row.metadata))
            continue;
        let tid;
        try {
            tid = BigInt(row.tokenId);
        }
        catch {
            continue;
        }
        if (tid < ISSUED_NFT_START_ID)
            continue;
        const meta = asRecord(row.metadata);
        if (!meta)
            continue;
        if (readMetadataProductionId(meta) !== wantedProductionId)
            continue;
        return { matchedMeta: meta, validBeforeSec: readMetadataValidBeforeSec(meta) };
    }
    return { matchedMeta: null, validBeforeSec: null };
}
async function resolveOpenClaimShareMeta(params, shareUrl) {
    const cardNorm = ethers_1.ethers.getAddress(params.cardAddress);
    const wantedId = params.couponId.trim();
    if (!wantedId)
        return null;
    let matchedMeta = null;
    let validBeforeSec = null;
    let distributionKind = 'coupon';
    const couponLookup = await lookupCouponSeriesMeta(cardNorm, wantedId);
    matchedMeta = couponLookup.matchedMeta;
    validBeforeSec = couponLookup.validBeforeSec;
    if (!matchedMeta) {
        const productionLookup = await lookupProductionSeriesMeta(cardNorm, wantedId);
        matchedMeta = productionLookup.matchedMeta;
        validBeforeSec = productionLookup.validBeforeSec;
        if (matchedMeta)
            distributionKind = 'catalog';
    }
    const merchantName = await resolveMerchantNameForShare(cardNorm, matchedMeta);
    const expiresLabel = (0, exports.formatCouponExpiryPill)(validBeforeSec);
    if (distributionKind === 'catalog' && matchedMeta) {
        const enrichedMeta = await resolveCatalogSeriesMetaForShare(cardNorm, wantedId, matchedMeta);
        const fields = readProductionShareFields(enrichedMeta);
        const itemCategory = await resolveItemCategoryLabelForShare(cardNorm, fields.itemCategoryId);
        const copy = buildCatalogCouponClaimShareCopy(fields);
        const title = truncateText(copy.title, 48);
        const subtitle = truncateText(copy.subtitle, 120);
        return {
            shareKind: 'open_claim',
            distributionKind: 'catalog',
            cardAddress: cardNorm,
            couponId: wantedId,
            merchantName,
            shareHeadline: '',
            title,
            subtitle,
            catalogLayout: copy.catalogLayout,
            ...(copy.publisherLine ? { publisherLine: truncateText(copy.publisherLine, 80) } : {}),
            globalCategory: fields.globalCategory,
            itemCategory,
            iconUrl: copy.iconUrl,
            backgroundImage: copy.backgroundImage,
            productionVideoUrl: fields.backgroundImage,
            productionVideoMime: fields.backgroundImageMime,
            backgroundColorHex: fields.backgroundColorHex,
            validBeforeSec,
            expiresLabel,
            shareUrl,
            ogImageUrl: buildOgImageUrl(shareUrl, { kind: 'open_claim', cardAddress: cardNorm, couponId: wantedId }),
        };
    }
    const title = truncateText(readMetadataTitle(matchedMeta) || 'Beamio Coupon', 48);
    const rawSubtitle = readMetadataSubtitle(matchedMeta);
    const subtitle = truncateText(rawSubtitle || (title !== 'Beamio Coupon' ? `${title} — ${merchantName}` : 'Claim this coupon in the Beamio app.'), 120);
    return {
        shareKind: 'open_claim',
        distributionKind: 'coupon',
        cardAddress: cardNorm,
        couponId: wantedId,
        merchantName,
        shareHeadline: (0, exports.buildShareHeadline)(merchantName, 'open_claim'),
        title,
        subtitle,
        iconUrl: readMetadataIconUrl(matchedMeta),
        backgroundImage: readMetadataBackgroundImage(matchedMeta),
        backgroundColorHex: readMetadataBackgroundColor(matchedMeta) || '#2B2E3A',
        validBeforeSec,
        expiresLabel,
        shareUrl,
        ogImageUrl: buildOgImageUrl(shareUrl, { kind: 'open_claim', cardAddress: cardNorm, couponId: wantedId }),
    };
}
async function resolveRedeemShareMeta(params, shareUrl) {
    const cardNorm = ethers_1.ethers.getAddress(params.cardAddress);
    const wantedCouponId = params.couponId?.trim() ?? '';
    let matchedMeta = null;
    let validBeforeSec = null;
    if (wantedCouponId) {
        const looked = await lookupCouponSeriesMeta(cardNorm, wantedCouponId);
        matchedMeta = looked.matchedMeta;
        validBeforeSec = looked.validBeforeSec;
    }
    const title = truncateText(readMetadataTitle(matchedMeta) || 'Beamio Coupon', 48);
    const merchantName = await resolveMerchantNameForShare(cardNorm, matchedMeta);
    const rawSubtitle = readMetadataSubtitle(matchedMeta);
    const subtitle = truncateText(rawSubtitle || (title !== 'Beamio Coupon' ? `${title} — ${merchantName}` : 'Redeem this coupon in the Beamio app.'), 120);
    const expiresLabel = (0, exports.formatCouponExpiryPill)(validBeforeSec);
    return {
        shareKind: 'redeem',
        cardAddress: cardNorm,
        ...(wantedCouponId ? { couponId: wantedCouponId } : {}),
        merchantName,
        shareHeadline: (0, exports.buildShareHeadline)(merchantName, 'redeem'),
        title,
        subtitle,
        iconUrl: readMetadataIconUrl(matchedMeta),
        backgroundImage: readMetadataBackgroundImage(matchedMeta),
        backgroundColorHex: readMetadataBackgroundColor(matchedMeta) || '#2B2E3A',
        validBeforeSec,
        expiresLabel,
        shareUrl,
        ogImageUrl: buildOgImageUrl(shareUrl, {
            kind: 'redeem',
            cardAddress: cardNorm,
            redeemCode: params.redeemCode,
            ...(wantedCouponId ? { couponId: wantedCouponId } : {}),
        }),
    };
}
async function resolveCouponClaimShareMeta(params, shareUrl) {
    if (params.kind === 'discover_merchant')
        return resolveDiscoverMerchantShareMeta(params, shareUrl);
    if (params.kind === 'redeem')
        return resolveRedeemShareMeta(params, shareUrl);
    return resolveOpenClaimShareMeta(params, shareUrl);
}
async function readCardDiscoverSharePresentation(cardNorm) {
    let meta = null;
    try {
        meta = asRecord((await (0, db_1.getCardByAddress)(cardNorm))?.metadata ?? null);
    }
    catch {
        meta = null;
    }
    const share = asRecord(meta?.shareTokenMetadata);
    const merchantName = await resolveMerchantNameForShare(cardNorm, null);
    const businessName = readString(meta?.businessName) ||
        readString(share?.businessName) ||
        readString(share?.displayName) ||
        merchantName;
    const title = truncateText(businessName || merchantName, 48);
    const rawDescription = readString(share?.description) ||
        readString(meta?.description) ||
        readString(meta?.programDescription) ||
        '';
    const subtitle = truncateText(rawDescription || `${title} on Beamio`, 120);
    const backgroundImage = readString(share?.merchantImage) ||
        readString(share?.background) ||
        readString(share?.backgroundImage) ||
        readString(share?.backgroundImageUrl) ||
        readString(meta?.programBackgroundImage) ||
        readMetadataStringFromKeys(meta, COUPON_BACKGROUND_IMAGE_KEYS) ||
        readMetadataStringFromKeys(share, COUPON_BACKGROUND_IMAGE_KEYS);
    const iconUrl = readString(share?.image) ||
        readString(share?.icon) ||
        readString(meta?.programIconUrl) ||
        readString(meta?.logoUrl) ||
        '';
    const backgroundColorHex = readMetadataBackgroundColor(meta) || readMetadataBackgroundColor(share) || '#2B2E3A';
    return { merchantName, title, subtitle, backgroundImage, iconUrl, backgroundColorHex };
}
async function resolveDiscoverMerchantShareMeta(params, shareUrl) {
    const cardNorm = ethers_1.ethers.getAddress(params.cardAddress);
    const fields = await readCardDiscoverSharePresentation(cardNorm);
    return {
        shareKind: 'discover_merchant',
        distributionKind: 'merchant',
        cardAddress: cardNorm,
        merchantName: fields.merchantName,
        shareHeadline: (0, exports.buildDiscoverMerchantShareHeadline)(fields.merchantName),
        title: fields.title,
        subtitle: fields.subtitle,
        catalogLayout: 'videoOg',
        iconUrl: fields.iconUrl,
        backgroundImage: fields.backgroundImage,
        backgroundColorHex: fields.backgroundColorHex,
        validBeforeSec: null,
        expiresLabel: 'VALID NOW',
        shareUrl,
        ogImageUrl: buildOgImageUrl(shareUrl, { kind: 'discover_merchant', cardAddress: cardNorm }),
    };
}
/** Revision for `/api/og/issued-nft.jpg?v=` — changes when series visuals change (biz edit / publish). */
function computeIssuedSeriesMetadataRevision(meta) {
    if (!meta)
        return String(exports.OG_LAYOUT_REV);
    const payload = {
        layoutRev: exports.OG_LAYOUT_REV,
        title: readMetadataTitle(meta),
        subtitle: readMetadataSubtitle(meta),
        icon: readMetadataIconUrl(meta),
        banner: readMetadataBackgroundImage(meta),
        bg: readMetadataBackgroundColor(meta),
    };
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}
/** BaseScan / OpenSea `image` — same Coupon Preview OG raster as Programs share. */
function buildIssuedNftExplorerImageUrl(cardAddress, tokenId, metadataRevision) {
    const card = ethers_1.ethers.getAddress(cardAddress);
    const tid = String(tokenId).trim();
    const rev = metadataRevision?.trim() || String(exports.OG_LAYOUT_REV);
    const q = new URLSearchParams({ card, tokenId: tid, v: rev });
    return `${BEAMIO_APP_ORIGIN}/api/og/issued-nft.jpg?${q.toString()}`;
}
/** Resolve issued-series metadata by on-chain tokenId (coupon or catalog). */
async function resolveIssuedNftExplorerShareMeta(cardAddress, tokenId) {
    const cardNorm = ethers_1.ethers.getAddress(cardAddress);
    const tid = String(tokenId).trim();
    let tidBig;
    try {
        tidBig = BigInt(tid);
    }
    catch {
        return null;
    }
    if (tidBig < ISSUED_NFT_START_ID)
        return null;
    const series = await (0, db_1.getSeriesByCardAndTokenId)(cardNorm, tid);
    if (!series)
        return null;
    const matchedMeta = asRecord(series.metadata);
    if (!matchedMeta)
        return null;
    const validBeforeSec = readMetadataValidBeforeSec(matchedMeta);
    const expiresLabel = (0, exports.formatCouponExpiryPill)(validBeforeSec);
    const merchantName = await resolveMerchantNameForShare(cardNorm, matchedMeta);
    if ((0, couponMetadataCategory_1.metadataMatchesClientProductionCategoryFilter)(matchedMeta)) {
        const productionId = readMetadataProductionId(matchedMeta) || tid;
        const enrichedMeta = await resolveCatalogSeriesMetaForShare(cardNorm, productionId, matchedMeta);
        const fields = readProductionShareFields(enrichedMeta);
        const itemCategory = await resolveItemCategoryLabelForShare(cardNorm, fields.itemCategoryId);
        const copy = buildCatalogCouponClaimShareCopy(fields);
        const title = truncateText(copy.title, 48);
        const subtitle = truncateText(copy.subtitle, 120);
        const shareUrl = buildCouponClaimAppDownloadUrl(cardNorm, productionId);
        const rev = computeIssuedSeriesMetadataRevision(matchedMeta);
        return {
            shareKind: 'open_claim',
            distributionKind: 'catalog',
            cardAddress: cardNorm,
            couponId: productionId,
            merchantName,
            shareHeadline: '',
            title,
            subtitle,
            catalogLayout: copy.catalogLayout,
            ...(copy.publisherLine ? { publisherLine: truncateText(copy.publisherLine, 80) } : {}),
            globalCategory: fields.globalCategory,
            itemCategory,
            iconUrl: copy.iconUrl,
            backgroundImage: copy.backgroundImage,
            productionVideoUrl: fields.backgroundImage,
            productionVideoMime: fields.backgroundImageMime,
            backgroundColorHex: fields.backgroundColorHex,
            validBeforeSec,
            expiresLabel,
            shareUrl,
            ogImageUrl: buildIssuedNftExplorerImageUrl(cardNorm, tid, rev),
        };
    }
    const couponId = readMetadataCouponId(matchedMeta);
    const shareUrl = couponId
        ? buildCouponClaimAppDownloadUrl(cardNorm, couponId)
        : `${BEAMIO_APP_ORIGIN}/app/?beamiocard=${encodeURIComponent(cardNorm)}`;
    const title = truncateText(readMetadataTitle(matchedMeta) || 'Beamio Coupon', 48);
    const rawSubtitle = readMetadataSubtitle(matchedMeta);
    const subtitle = truncateText(rawSubtitle || (title !== 'Beamio Coupon' ? `${title} — ${merchantName}` : 'Claim this coupon in the Beamio app.'), 120);
    const rev = computeIssuedSeriesMetadataRevision(matchedMeta);
    return {
        shareKind: 'open_claim',
        distributionKind: 'coupon',
        cardAddress: cardNorm,
        ...(couponId ? { couponId } : {}),
        merchantName,
        shareHeadline: (0, exports.buildShareHeadline)(merchantName, 'open_claim'),
        title,
        subtitle,
        iconUrl: readMetadataIconUrl(matchedMeta),
        backgroundImage: readMetadataBackgroundImage(matchedMeta),
        backgroundColorHex: readMetadataBackgroundColor(matchedMeta) || '#2B2E3A',
        validBeforeSec,
        expiresLabel,
        shareUrl,
        ogImageUrl: buildIssuedNftExplorerImageUrl(cardNorm, tid, rev),
    };
}
function buildFallbackCouponClaimShareMeta(params, shareUrl) {
    if (params.kind === 'discover_merchant') {
        const merchantName = 'Beamio';
        return {
            shareKind: 'discover_merchant',
            distributionKind: 'merchant',
            cardAddress: params.cardAddress,
            merchantName,
            shareHeadline: (0, exports.buildDiscoverMerchantShareHeadline)(merchantName),
            title: merchantName,
            subtitle: 'Explore this brand in the Beamio app.',
            catalogLayout: 'videoOg',
            iconUrl: '',
            backgroundImage: '',
            backgroundColorHex: '#2B2E3A',
            validBeforeSec: null,
            expiresLabel: 'VALID NOW',
            shareUrl,
            ogImageUrl: buildOgImageUrl(shareUrl, params),
        };
    }
    const isRedeem = params.kind === 'redeem';
    const merchantName = 'Beamio';
    return {
        shareKind: params.kind,
        cardAddress: params.cardAddress,
        ...(params.kind === 'open_claim'
            ? { couponId: params.couponId }
            : params.couponId
                ? { couponId: params.couponId }
                : {}),
        merchantName,
        shareHeadline: (0, exports.buildShareHeadline)(merchantName, isRedeem ? 'redeem' : 'open_claim'),
        title: 'Beamio Coupon',
        subtitle: isRedeem ? 'Redeem this coupon in the Beamio app.' : 'Claim this coupon in the Beamio app.',
        iconUrl: '',
        backgroundImage: '',
        backgroundColorHex: '#2B2E3A',
        validBeforeSec: null,
        expiresLabel: 'VALID NOW',
        shareUrl,
        ogImageUrl: buildOgImageUrl(shareUrl, params),
    };
}
async function buildCouponClaimOgRasterParts(meta) {
    const imgPrep = OG_IMAGE_PREP_SCALE;
    const punchBg = '#f9f9fe';
    const isDiscoverMerchant = meta.shareKind === 'discover_merchant' || meta.distributionKind === 'merchant';
    const isVideoOgLayout = meta.catalogLayout === 'videoOg';
    const isCatalogVideoOg = isVideoOgLayout && !isDiscoverMerchant;
    const isMerchantVideoOg = isVideoOgLayout && isDiscoverMerchant;
    /** videoOg card shell even when hero image is missing (solid tile color). */
    const hasBanner = isVideoOgLayout || Boolean(meta.backgroundImage?.trim());
    /** Coupon share tickets use side notches; videoOg (catalog + Discover merchant) uses plain card. No QR in OG raster. */
    const isCouponBannerTicket = hasBanner && !isVideoOgLayout;
    const capsuleX = 50;
    const capsuleW = 1100;
    const capsuleRx = isVideoOgLayout ? 32 : hasBanner ? OG_BANNER_CAPSULE_RX : 28;
    const notchR = isCouponBannerTicket ? OG_BANNER_NOTCH_R : 18;
    const capsuleY = isVideoOgLayout ? 40 : hasBanner ? 86 : 165;
    const bannerCapsuleH = isMerchantVideoOg ? DISCOVER_MERCHANT_OG_BANNER_H : OG_BANNER_CAPSULE_H;
    const capsuleH = hasBanner ? bannerCapsuleH : 300;
    const iconCx = capsuleX + 112;
    const iconCy = capsuleY + capsuleH / 2;
    const iconSize = 112;
    const iconClipR = 56;
    const urgent = couponExpiryUsesUrgentVariant(meta.expiresLabel);
    const innerExpiryFill = urgent ? '#dc2626' : 'rgba(15,23,42,0.65)';
    const externalExpiryFill = urgent ? '#dc2626' : '#eef1f3';
    const externalExpiryStroke = urgent ? '#dc2626' : 'rgba(171,173,175,0.35)';
    const iconDataUrl = !hasBanner && meta.iconUrl.trim()
        ? await fetchImageCoverPngDataUrl(meta.iconUrl, iconSize * imgPrep, iconSize * imgPrep)
        : null;
    const bgDataUrl = hasBanner
        ? await fetchBannerFitHeightPngDataUrl(meta.backgroundImage, capsuleW * imgPrep, capsuleH * imgPrep)
        : null;
    const titleRaw = meta.title.trim();
    const subtitleRaw = meta.subtitle.trim();
    const publisherRaw = meta.publisherLine?.trim() ?? '';
    const expiresRaw = meta.expiresLabel.trim();
    const showExpiryPill = (0, exports.shouldShowCouponExpiryPill)(expiresRaw);
    const isCatalogDistribution = meta.distributionKind === 'catalog';
    const claimHeadlineRaw = isCatalogDistribution || isMerchantVideoOg
        ? ''
        : isDiscoverMerchant
            ? meta.shareHeadline?.trim() || (0, exports.buildDiscoverMerchantShareHeadline)(meta.merchantName)
            : meta.shareHeadline?.trim() ||
                (0, exports.buildShareHeadline)(meta.merchantName, meta.shareKind === 'redeem' ? 'redeem' : 'open_claim');
    const expiryPillW = showExpiryPill ? Math.min(360, Math.max(160, expiresRaw.length * 11 + 48)) : 0;
    const textLayers = [];
    const innerTextStartX = iconDataUrl ? capsuleX + 200 : capsuleX + 48;
    const innerTextMaxWidth = iconDataUrl ? capsuleW - 248 : capsuleW - 96;
    const bgLayer = bgDataUrl
        ? `<image href="${bgDataUrl}" x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#capsuleClip)" />`
        : `<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="${escapeXml(meta.backgroundColorHex)}" />
<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="url(#stripePattern)" opacity="0.12" clip-path="url(#capsuleClip)" />`;
    const iconLayer = iconDataUrl
        ? `<image href="${iconDataUrl}" x="${iconCx - iconClipR}" y="${iconCy - iconClipR}" width="${iconSize}" height="${iconSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#iconClip)" />`
        : '';
    const iconCircleLayer = iconDataUrl
        ? `<circle cx="${iconCx}" cy="${iconCy}" r="58" fill="rgba(255,255,255,0.95)" stroke="rgba(255,255,255,0.4)" stroke-width="4" />
  ${iconLayer}`
        : '';
    if (claimHeadlineRaw) {
        textLayers.push({
            text: claimHeadlineRaw,
            x: OG_WIDTH / 2,
            y: hasBanner ? OG_BANNER_HEADLINE_BASELINE_Y : 92,
            fontSize: OG_BANNER_HEADLINE_FONT_SIZE,
            fontWeight: 800,
            color: '#1a1c1f',
            align: 'center',
            maxWidth: OG_WIDTH - 80,
        });
    }
    if (!hasBanner && !isCatalogDistribution && !isDiscoverMerchant) {
        textLayers.push({
            text: 'Open the link on your phone to continue in Beamio',
            x: OG_WIDTH / 2,
            y: 132,
            fontSize: 20,
            fontWeight: 600,
            color: '#64748b',
            align: 'center',
            maxWidth: OG_WIDTH - 120,
        });
    }
    const couponNotchLayer = isCouponBannerTicket
        ? `<circle cx="${capsuleX}" cy="${iconCy}" r="${notchR}" fill="${punchBg}" />
  <circle cx="${capsuleX + capsuleW}" cy="${iconCy}" r="${notchR}" fill="${punchBg}" />`
        : '';
    const catalogCardShell = isVideoOgLayout
        ? `<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH + OG_BANNER_META_TOP_GAP + 200}" rx="${capsuleRx}" fill="#ffffff" stroke="rgba(0,0,0,0.08)" stroke-width="2" />`
        : '';
    const catalogPlayBadgeParts = isCatalogVideoOg && bgDataUrl && Boolean(meta.productionVideoUrl?.trim())
        ? (0, catalogProductionVideoOg_1.buildCatalogVideoOgPlayBadgeSvgParts)(capsuleX, capsuleY, capsuleW, capsuleH)
        : null;
    const catalogPlayBadgeFilterDef = catalogPlayBadgeParts?.filterDef ?? '';
    const catalogPlayBadgeLayer = catalogPlayBadgeParts?.badgeLayer ?? '';
    const ticketShell = `
  ${isVideoOgLayout ? catalogCardShell : ''}
  ${bgLayer}
  ${catalogPlayBadgeLayer}
  ${hasBanner ? '' : `<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="url(#capsuleShade)" clip-path="url(#capsuleClip)" />`}
  ${isVideoOgLayout ? '' : `<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="2" />`}
  ${couponNotchLayer}
  ${iconCircleLayer}`;
    const innerTextLayer = !hasBanner && showExpiryPill && (titleRaw || subtitleRaw || expiresRaw)
        ? `
  <rect x="${innerTextStartX}" y="${capsuleY + (titleRaw || subtitleRaw ? 198 : 128)}" rx="18" ry="18" width="${expiryPillW}" height="36" fill="${innerExpiryFill}" />`
        : '';
    if (!hasBanner) {
        if (titleRaw) {
            textLayers.push({
                text: titleRaw,
                x: innerTextStartX,
                y: capsuleY + 128,
                fontSize: 34,
                fontWeight: 800,
                color: '#ffffff',
                align: 'left',
                maxWidth: innerTextMaxWidth,
            });
        }
        if (subtitleRaw) {
            textLayers.push({
                text: subtitleRaw,
                x: innerTextStartX,
                y: capsuleY + 172,
                fontSize: 24,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.92)',
                align: 'left',
                maxWidth: innerTextMaxWidth,
            });
        }
        if (showExpiryPill && expiresRaw) {
            textLayers.push({
                text: expiresRaw,
                x: innerTextStartX + 24,
                y: capsuleY + (titleRaw || subtitleRaw ? 222 : 152),
                fontSize: 16,
                fontWeight: 800,
                color: '#ffffff',
                align: 'left',
                maxWidth: expiryPillW - 48,
            });
        }
    }
    const innerQrLayer = '';
    let metaBelowY = capsuleY + capsuleH;
    const metaLines = [];
    const videoOgMetaTextMaxWidth = capsuleW;
    const videoOgMetaTextX = capsuleX;
    const videoOgIconClipDef = '';
    const videoOgIconRasterLayer = '';
    if (hasBanner) {
        const categoryRaw = [meta.globalCategory?.trim(), meta.itemCategory?.trim()].filter(Boolean).join(' · ');
        if (isMerchantVideoOg && !categoryRaw) {
            metaBelowY += OG_BANNER_META_TOP_GAP;
            textLayers.push({
                text: 'DISCOVER',
                x: videoOgMetaTextX + 4,
                y: metaBelowY + 14,
                fontSize: 14,
                fontWeight: 800,
                color: '#1562f0',
                align: 'left',
                maxWidth: videoOgMetaTextMaxWidth,
            });
            metaBelowY += 22;
        }
        if (isCatalogVideoOg && categoryRaw) {
            metaBelowY += OG_BANNER_META_TOP_GAP;
            textLayers.push({
                text: categoryRaw.toUpperCase(),
                x: videoOgMetaTextX + 4,
                y: metaBelowY + 14,
                fontSize: 14,
                fontWeight: 800,
                color: '#ea580c',
                align: 'left',
                maxWidth: videoOgMetaTextMaxWidth,
            });
            metaBelowY += 22;
        }
        if (titleRaw) {
            const titleFontSize = 28;
            metaBelowY +=
                isVideoOgLayout && !categoryRaw && !isMerchantVideoOg ? OG_BANNER_META_TOP_GAP : 0;
            metaBelowY += titleFontSize;
            textLayers.push({
                text: titleRaw,
                x: videoOgMetaTextX,
                y: metaBelowY,
                fontSize: titleFontSize,
                fontWeight: 800,
                color: '#2c2f31',
                align: 'left',
                maxWidth: videoOgMetaTextMaxWidth,
            });
            metaBelowY += 32;
        }
        if (subtitleRaw) {
            textLayers.push({
                text: subtitleRaw,
                x: videoOgMetaTextX,
                y: metaBelowY,
                fontSize: 20,
                fontWeight: 600,
                color: '#595c5e',
                align: 'left',
                maxWidth: videoOgMetaTextMaxWidth,
            });
            metaBelowY += 28;
        }
        if (publisherRaw) {
            textLayers.push({
                text: publisherRaw,
                x: videoOgMetaTextX,
                y: metaBelowY,
                fontSize: 18,
                fontWeight: 600,
                color: '#747779',
                align: 'left',
                maxWidth: videoOgMetaTextMaxWidth,
            });
            metaBelowY += 26;
        }
        const pillY = metaBelowY - 8;
        if (showExpiryPill) {
            metaLines.push(`<rect x="${capsuleX}" y="${pillY}" rx="18" ry="18" width="${expiryPillW}" height="36" fill="${externalExpiryFill}" stroke="${externalExpiryStroke}" stroke-width="2" />`);
            if (expiresRaw) {
                textLayers.push({
                    text: expiresRaw,
                    x: capsuleX + 24,
                    y: pillY + 24,
                    fontSize: 16,
                    fontWeight: 800,
                    color: urgent ? '#ffffff' : '#595c5e',
                    align: 'left',
                    maxWidth: expiryPillW - 48,
                });
            }
            metaBelowY = pillY + 36;
        }
    }
    const externalQrLayer = '';
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <clipPath id="capsuleClip">
      <rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" />
    </clipPath>
    <clipPath id="iconClip">
      <circle cx="${iconCx}" cy="${iconCy}" r="${iconClipR}" />
    </clipPath>
    ${videoOgIconClipDef}
    ${catalogPlayBadgeFilterDef}
    <linearGradient id="capsuleShade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.30" />
    </linearGradient>
    <pattern id="stripePattern" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-26)">
      <rect width="8" height="8" fill="transparent" />
      <rect width="1" height="8" fill="#ffffff" />
    </pattern>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${punchBg}" />
  ${ticketShell}
  ${innerTextLayer}
  ${innerQrLayer}
  ${hasBanner ? metaLines.join('\n  ') : ''}
  ${videoOgIconRasterLayer}
  ${externalQrLayer}
</svg>`;
    return { svg, textLayers };
}
const ogImageCache = new Map();
const OG_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
async function renderCouponClaimOgRaster(meta, format) {
    const ogToken = ogShareTokenFromImageUrl(meta.ogImageUrl) ??
        encodeOgShareToken(meta.shareKind === 'redeem'
            ? {
                kind: 'redeem',
                cardAddress: meta.cardAddress,
                redeemCode: '',
                ...(meta.couponId ? { couponId: meta.couponId } : {}),
            }
            : meta.shareKind === 'discover_merchant'
                ? { kind: 'discover_merchant', cardAddress: meta.cardAddress }
                : { kind: 'open_claim', cardAddress: meta.cardAddress, couponId: meta.couponId ?? '' }, meta.shareUrl);
    const cacheKey = ogShareMemoryCacheKey(format, ogToken);
    const cached = ogImageCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry)
        return cached.buf;
    const { svg, textLayers } = await buildCouponClaimOgRasterParts(meta);
    const textComposites = (0, couponClaimShareOgText_1.buildOgTextComposites)(textLayers);
    const baseRaster = await (0, sharp_1.default)(Buffer.from(svg))
        .resize(OG_WIDTH, OG_HEIGHT, { fit: 'fill' })
        .toColorspace('srgb')
        .withIccProfile('srgb')
        .png()
        .toBuffer();
    let pipeline = (0, sharp_1.default)(baseRaster).composite(textComposites);
    const buf = format === 'jpeg'
        ? await pipeline
            .withIccProfile('srgb')
            .jpeg({
            quality: OG_JPEG_QUALITY,
            // Baseline only: mozjpeg ignores progressive:false and emits SOF2 (breaks WhatsApp previews).
            progressive: false,
            mozjpeg: false,
            chromaSubsampling: '4:4:4',
        })
            .toBuffer()
        : await pipeline.withIccProfile('srgb').png({ compressionLevel: 6 }).toBuffer();
    ogImageCache.set(cacheKey, { buf, expiry: Date.now() + OG_IMAGE_CACHE_TTL_MS });
    return buf;
}
async function renderCouponClaimOgPng(meta) {
    return renderCouponClaimOgRaster(meta, 'png');
}
async function warmCouponClaimOgJpeg(meta) {
    const token = ogShareTokenFromImageUrl(meta.ogImageUrl);
    if (token) {
        const diskCached = await readOgShareDiskCache(token);
        if (diskCached) {
            ogImageCache.set(ogShareMemoryCacheKey('jpeg', token), {
                buf: diskCached,
                expiry: Date.now() + OG_IMAGE_CACHE_TTL_MS,
            });
            return diskCached;
        }
    }
    const buf = await renderCouponClaimOgRaster(meta, 'jpeg');
    if (token)
        await writeOgShareDiskCache(token, buf);
    return buf;
}
async function renderCouponClaimOgJpeg(meta) {
    return warmCouponClaimOgJpeg(meta);
}
function issuedNftExplorerOgDiskCachePath(cardAddress, tokenId, revision) {
    const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
    const tid = String(tokenId).trim();
    const rev = revision.trim() || String(exports.OG_LAYOUT_REV);
    return path_1.default.join(OG_DISK_CACHE_DIR, `issued-${card}-${tid}-v${rev}.jpg`);
}
/** Warm issued-NFT explorer JPEG (Coupon Preview OG layout) for BaseScan / OpenSea crawlers. */
async function warmIssuedNftExplorerOgJpeg(cardAddress, tokenId, shareMeta) {
    const meta = shareMeta ?? (await resolveIssuedNftExplorerShareMeta(cardAddress, tokenId));
    if (!meta)
        throw new Error('Issued NFT series metadata not found');
    const revMatch = meta.ogImageUrl.match(/[?&]v=([^&]+)/);
    const rev = revMatch?.[1]?.trim() || String(exports.OG_LAYOUT_REV);
    const cachePath = issuedNftExplorerOgDiskCachePath(cardAddress, tokenId, rev);
    try {
        if (fs_1.default.existsSync(cachePath)) {
            const diskCached = await promises_1.default.readFile(cachePath);
            if (diskCached.length > 0)
                return diskCached;
        }
    }
    catch {
        /* render */
    }
    const buf = await renderCouponClaimOgRaster(meta, 'jpeg');
    await ensureOgDiskCacheDir();
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    await promises_1.default.writeFile(tmpPath, buf);
    await promises_1.default.rename(tmpPath, cachePath);
    return buf;
}
function renderCouponClaimShareHtml(meta) {
    const isDiscoverMerchant = meta.shareKind === 'discover_merchant' || meta.distributionKind === 'merchant';
    const headline = meta.distributionKind === 'catalog'
        ? escapeXml(meta.title)
        : isDiscoverMerchant
            ? escapeXml(meta.shareHeadline || (0, exports.buildDiscoverMerchantShareHeadline)(meta.merchantName))
            : escapeXml(meta.shareHeadline ||
                (0, exports.buildShareHeadline)(meta.merchantName, meta.shareKind === 'redeem' ? 'redeem' : 'open_claim'));
    const title = escapeXml(meta.title);
    const description = escapeXml(meta.subtitle);
    const shareUrl = escapeXml(meta.shareUrl);
    const ogImage = escapeXml(meta.ogImageUrl);
    const actionHint = isDiscoverMerchant
        ? 'Open this link on your phone to explore this brand in Beamio.'
        : meta.shareKind === 'redeem'
            ? 'Open this link on your phone to redeem in Beamio.'
            : 'Open this link on your phone to claim in Beamio.';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:secure_url" content="${ogImage}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="${OG_WIDTH}" />
  <meta property="og:image:height" content="${OG_HEIGHT}" />
  <link rel="image_src" href="${ogImage}" />
  <meta itemprop="image" content="${ogImage}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Beamio" />
  <meta property="og:title" content="${headline}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${shareUrl}" />
  <meta itemprop="name" content="${headline}" />
  <meta itemprop="description" content="${description}" />
  <meta name="description" content="${description}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${headline} — Beamio</title>
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${headline}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImage}" />
  <link rel="canonical" href="${shareUrl}" />
</head>
<body style="margin:0;background:#f9f9fe;color:#1a1c1f;font-family:Inter,Arial,sans-serif;">
  <main style="max-width:640px;margin:0 auto;padding:48px 24px;text-align:center;">
    <h1 style="font-size:28px;margin:0 0 12px;">${headline}</h1>
    <p style="font-size:18px;color:#64748b;margin:0 0 24px;">${description}</p>
    <p style="font-size:14px;color:#94a3b8;">${actionHint}</p>
    <p><a href="${shareUrl}" style="color:#1562f0;font-weight:600;">Continue to Beamio</a></p>
  </main>
</body>
</html>`;
}
function isSocialShareCrawlerUserAgent(userAgent) {
    const ua = String(userAgent ?? '');
    if (!ua)
        return false;
    return /(facebookexternalhit|Facebot|Twitterbot|WhatsApp|LinkedInBot|Slackbot|TelegramBot|MicroMessenger|weixin_spider|TencentTraveler|WindowsWechat|WechatShare|WeChat|Discordbot|bingpreview|Pinterestbot|Applebot)/i.test(ua);
}
