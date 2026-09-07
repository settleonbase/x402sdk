"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRODUCTION_BACKGROUND_YOUTUBE_MIME = exports.CATALOG_VIDEO_OG_PLAY_BADGE_MAX_RADIUS_PX = exports.CATALOG_VIDEO_OG_PLAY_BADGE_MIN_RADIUS_PX = exports.CATALOG_VIDEO_OG_PLAY_BADGE_RADIUS_RATIO = exports.CATALOG_VIDEO_OG_THUMB_FFMPEG_QV = exports.CATALOG_VIDEO_OG_RIGHT_THUMB_JPEG_QUALITY = exports.CATALOG_VIDEO_OG_RIGHT_THUMB_HEIGHT = exports.CATALOG_VIDEO_OG_RIGHT_THUMB_WIDTH = void 0;
exports.productionBackgroundMediaKindFromMime = productionBackgroundMediaKindFromMime;
exports.resolveProductionBackgroundMediaKind = resolveProductionBackgroundMediaKind;
exports.inferProductionImageMimeFromUrl = inferProductionImageMimeFromUrl;
exports.flattenIssuedProductionSeriesMetadata = flattenIssuedProductionSeriesMetadata;
exports.catalogProductionHasVideoBackgroundMedia = catalogProductionHasVideoBackgroundMedia;
exports.youtubeThumbnailUrlFromProductionUrl = youtubeThumbnailUrlFromProductionUrl;
exports.formatCatalogProductionPublisherLine = formatCatalogProductionPublisherLine;
exports.resolveCatalogProductionSharePresentation = resolveCatalogProductionSharePresentation;
exports.catalogVideoOgPlayBadgeRadiusPx = catalogVideoOgPlayBadgeRadiusPx;
exports.buildCatalogVideoOgPlayBadgeSvgParts = buildCatalogVideoOgPlayBadgeSvgParts;
/**
 * Business Catalog item — video background presentation (YouTube OG layout).
 * Single source of truth for server OG / share meta. Web clients mirror this module.
 *
 * `iconUrl` = catalog video OG right thumbnail (480×360 hqdefault parity), not a small item icon.
 * Mirror: `src/bizSite/src/utils/catalogProductionVideoOgConstants.ts`
 */
const youtubeProductionVideo_1 = require("./endpoint/youtubeProductionVideo");
/** YouTube hqdefault — keep in sync with bizSite `catalogProductionVideoOgConstants.ts`. */
exports.CATALOG_VIDEO_OG_RIGHT_THUMB_WIDTH = 480;
exports.CATALOG_VIDEO_OG_RIGHT_THUMB_HEIGHT = 360;
exports.CATALOG_VIDEO_OG_RIGHT_THUMB_JPEG_QUALITY = 0.88;
exports.CATALOG_VIDEO_OG_THUMB_FFMPEG_QV = 3;
/** Play badge on video banner — keep in sync with bizSite `catalogProductionVideoOgConstants.ts`. */
exports.CATALOG_VIDEO_OG_PLAY_BADGE_RADIUS_RATIO = 0.11;
exports.CATALOG_VIDEO_OG_PLAY_BADGE_MIN_RADIUS_PX = 22;
exports.CATALOG_VIDEO_OG_PLAY_BADGE_MAX_RADIUS_PX = 52;
exports.PRODUCTION_BACKGROUND_YOUTUBE_MIME = 'video/youtube';
function productionBackgroundMediaKindFromMime(mime) {
    const m = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
    if (m.startsWith('video/'))
        return 'video';
    if (m === 'application/pdf')
        return 'pdf';
    return 'image';
}
function resolveProductionBackgroundMediaKind(args) {
    const mime = typeof args.mime === 'string' ? args.mime.trim().toLowerCase() : '';
    if (mime === exports.PRODUCTION_BACKGROUND_YOUTUBE_MIME)
        return 'video';
    const mimeKind = typeof args.mime === 'string' && args.mime.trim()
        ? productionBackgroundMediaKindFromMime(args.mime)
        : null;
    if (mimeKind === 'video' || mimeKind === 'pdf')
        return mimeKind;
    const u = typeof args.url === 'string' ? args.url.trim().toLowerCase() : '';
    if (u.includes('youtube.com') || u.includes('youtu.be'))
        return 'video';
    if (u.includes('.pdf') || u.includes('application/pdf'))
        return 'pdf';
    if (/\.(mp4|webm|mov|m4v|ogv)(\?|&|$)/i.test(u))
        return 'video';
    return mimeKind ?? 'image';
}
/** Infer stored mime when issued-series / share metadata omitted `productionImageMime` but URL is video. */
function inferProductionImageMimeFromUrl(url) {
    const u = url.trim();
    if (!u)
        return '';
    if (u.includes('youtube.com') || u.includes('youtu.be'))
        return exports.PRODUCTION_BACKGROUND_YOUTUBE_MIME;
    const kind = resolveProductionBackgroundMediaKind({ url: u, mime: '' });
    if (kind === 'video')
        return 'video/mp4';
    if (kind === 'pdf')
        return 'application/pdf';
    if (kind === 'image')
        return 'image/jpeg';
    return '';
}
/** Merge `properties.beamioProduction` / root `beamioProduction` into one row (issued NFT + share token). */
function flattenIssuedProductionSeriesMetadata(rootMeta) {
    const props = rootMeta.properties && typeof rootMeta.properties === 'object' && !Array.isArray(rootMeta.properties)
        ? rootMeta.properties
        : {};
    const fromProps = props.beamioProduction &&
        typeof props.beamioProduction === 'object' &&
        !Array.isArray(props.beamioProduction)
        ? props.beamioProduction
        : {};
    const fromRoot = rootMeta.beamioProduction &&
        typeof rootMeta.beamioProduction === 'object' &&
        !Array.isArray(rootMeta.beamioProduction)
        ? rootMeta.beamioProduction
        : {};
    const productionId = (typeof rootMeta.productionId === 'string' && rootMeta.productionId.trim()) ||
        (typeof fromRoot.productionId === 'string' && fromRoot.productionId.trim()) ||
        (typeof fromProps.productionId === 'string' && fromProps.productionId.trim()) ||
        (typeof rootMeta.id === 'string' && rootMeta.id.trim()) ||
        (typeof fromRoot.id === 'string' && fromRoot.id.trim()) ||
        (typeof fromProps.id === 'string' && fromProps.id.trim()) ||
        '';
    return {
        ...rootMeta,
        ...fromProps,
        ...fromRoot,
        ...(productionId ? { productionId, id: productionId } : {}),
    };
}
function catalogProductionHasVideoBackgroundMedia(args) {
    if (!args.productionImage.trim())
        return false;
    return (resolveProductionBackgroundMediaKind({
        url: args.productionImage,
        mime: args.productionImageMime,
    }) === 'video');
}
function youtubeThumbnailUrlFromProductionUrl(raw) {
    const id = (0, youtubeProductionVideo_1.parseYoutubeVideoId)(raw);
    if (!id)
        return null;
    return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}
function formatCatalogProductionPublisherLine(publisherBeamioTag, channelOrDisplayName) {
    const name = channelOrDisplayName.trim();
    const rawTag = (publisherBeamioTag ?? '').trim().replace(/^@/, '');
    if (!rawTag && !name)
        return null;
    if (rawTag && name)
        return `@${rawTag} · ${name}`;
    if (rawTag)
        return `@${rawTag}`;
    return name;
}
function resolveCatalogVideoOgBannerImage(productionImage, iconUrl) {
    const thumb = youtubeThumbnailUrlFromProductionUrl(productionImage);
    if (thumb)
        return thumb;
    if (iconUrl.trim())
        return iconUrl.trim();
    return productionImage.trim();
}
function resolveCatalogVideoOgIconUrl(productionImage, iconUrl) {
    if (iconUrl.trim())
        return iconUrl.trim();
    return youtubeThumbnailUrlFromProductionUrl(productionImage) ?? '';
}
/**
 * Maps stored catalog fields → share / OG / in-app preview text.
 * Video: title = videoTitle (subtitle), subtitle = description, publisher = @tag · channelName.
 */
function resolveCatalogProductionSharePresentation(input) {
    const channelName = input.channelName.trim();
    const videoTitle = input.videoTitle.trim();
    const description = input.description.trim();
    const productionImage = input.productionImage.trim();
    const iconUrl = input.iconUrl.trim();
    if (!catalogProductionHasVideoBackgroundMedia(input)) {
        const title = channelName || 'Catalog Item';
        const subtitle = videoTitle;
        return {
            layout: 'default',
            title,
            subtitle,
            publisherLine: null,
            iconUrl,
            bannerImageUrl: productionImage,
            channelName,
        };
    }
    const title = videoTitle || channelName || 'Catalog Item';
    const subtitle = description;
    const resolvedIcon = resolveCatalogVideoOgIconUrl(productionImage, iconUrl);
    return {
        layout: 'videoOg',
        title,
        subtitle,
        publisherLine: formatCatalogProductionPublisherLine(input.publisherBeamioTag, channelName),
        iconUrl: resolvedIcon,
        bannerImageUrl: resolveCatalogVideoOgBannerImage(productionImage, resolvedIcon),
        channelName,
    };
}
/** Centered play badge radius for banner slot (OG raster + parity with biz canvas composite). */
function catalogVideoOgPlayBadgeRadiusPx(width, height) {
    const min = Math.min(width, height);
    return Math.max(exports.CATALOG_VIDEO_OG_PLAY_BADGE_MIN_RADIUS_PX, Math.min(exports.CATALOG_VIDEO_OG_PLAY_BADGE_MAX_RADIUS_PX, min * exports.CATALOG_VIDEO_OG_PLAY_BADGE_RADIUS_RATIO));
}
/**
 * SVG filter + shapes for catalog videoOg banner play affordance (Business Catalogs preview).
 * Caller must include `filterDef` in `<defs>` and `badgeLayer` after the banner `<image>`.
 */
function buildCatalogVideoOgPlayBadgeSvgParts(slotX, slotY, slotW, slotH) {
    const r = catalogVideoOgPlayBadgeRadiusPx(slotW, slotH);
    const cx = slotX + slotW / 2;
    const cy = slotY + slotH / 2;
    const tri = r * 0.4;
    const left = cx - tri * 0.38;
    const right = cx + tri * 0.74;
    const top = cy - tri * 0.62;
    const bottom = cy + tri * 0.62;
    const shadowDy = r * 0.14;
    const shadowBlur = r * 0.55;
    const filterDef = `<filter id="catalogPlayBadgeShadow" x="-100%" y="-100%" width="300%" height="300%">
      <feDropShadow dx="0" dy="${shadowDy}" stdDeviation="${shadowBlur}" flood-color="rgba(0,0,0,0.48)" />
    </filter>`;
    const badgeLayer = `<g clip-path="url(#capsuleClip)">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(0,0,0,0.44)" filter="url(#catalogPlayBadgeShadow)" />
    <polygon points="${left},${top} ${left},${bottom} ${right},${cy}" fill="rgba(255,255,255,0.96)" />
  </g>`;
    return { filterDef, badgeLayer };
}
