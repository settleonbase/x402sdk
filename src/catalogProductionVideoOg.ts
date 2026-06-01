/**
 * Business Catalog item — video background presentation (YouTube OG layout).
 * Single source of truth for server OG / share meta. Web clients mirror this module.
 *
 * `iconUrl` = catalog video OG right thumbnail (480×360 hqdefault parity), not a small item icon.
 * Mirror: `src/bizSite/src/utils/catalogProductionVideoOgConstants.ts`
 */
import { parseYoutubeVideoId } from './endpoint/youtubeProductionVideo'

/** YouTube hqdefault — keep in sync with bizSite `catalogProductionVideoOgConstants.ts`. */
export const CATALOG_VIDEO_OG_RIGHT_THUMB_WIDTH = 480
export const CATALOG_VIDEO_OG_RIGHT_THUMB_HEIGHT = 360
export const CATALOG_VIDEO_OG_RIGHT_THUMB_JPEG_QUALITY = 0.88
export const CATALOG_VIDEO_OG_THUMB_FFMPEG_QV = 3

/** Play badge on video banner — keep in sync with bizSite `catalogProductionVideoOgConstants.ts`. */
export const CATALOG_VIDEO_OG_PLAY_BADGE_RADIUS_RATIO = 0.11
export const CATALOG_VIDEO_OG_PLAY_BADGE_MIN_RADIUS_PX = 22
export const CATALOG_VIDEO_OG_PLAY_BADGE_MAX_RADIUS_PX = 52

export const PRODUCTION_BACKGROUND_YOUTUBE_MIME = 'video/youtube'

export type ProductionBackgroundMediaKind = 'image' | 'video' | 'pdf'

export type CatalogProductionShareFieldsInput = {
	/** Channel / display name (YouTube import → channel handle). */
	channelName: string
	/** Video title (stored as catalog `subtitle`). */
	videoTitle: string
	description: string
	productionImage: string
	productionImageMime?: string
	iconUrl: string
	publisherBeamioTag?: string
}

export type CatalogProductionVideoOgLayout = 'default' | 'videoOg'

export type CatalogProductionSharePresentation = {
	layout: CatalogProductionVideoOgLayout
	/** Share / OG primary headline (video title when videoOg). */
	title: string
	/** Secondary line (description when videoOg; legacy subtitle otherwise). */
	subtitle: string
	publisherLine: string | null
	iconUrl: string
	/** Banner image URL for ticket shell (YouTube thumb when videoOg). */
	bannerImageUrl: string
	channelName: string
}

export function productionBackgroundMediaKindFromMime(mime: unknown): ProductionBackgroundMediaKind {
	const m = typeof mime === 'string' ? mime.trim().toLowerCase() : ''
	if (m.startsWith('video/')) return 'video'
	if (m === 'application/pdf') return 'pdf'
	return 'image'
}

export function resolveProductionBackgroundMediaKind(args: {
	url?: unknown
	mime?: unknown
}): ProductionBackgroundMediaKind {
	const mime = typeof args.mime === 'string' ? args.mime.trim().toLowerCase() : ''
	if (mime === PRODUCTION_BACKGROUND_YOUTUBE_MIME) return 'video'
	const mimeKind =
		typeof args.mime === 'string' && args.mime.trim()
			? productionBackgroundMediaKindFromMime(args.mime)
			: null
	if (mimeKind === 'video' || mimeKind === 'pdf') return mimeKind
	const u = typeof args.url === 'string' ? args.url.trim().toLowerCase() : ''
	if (u.includes('youtube.com') || u.includes('youtu.be')) return 'video'
	if (u.includes('.pdf') || u.includes('application/pdf')) return 'pdf'
	if (/\.(mp4|webm|mov|m4v|ogv)(\?|&|$)/i.test(u)) return 'video'
	return mimeKind ?? 'image'
}

/** Infer stored mime when issued-series / share metadata omitted `productionImageMime` but URL is video. */
export function inferProductionImageMimeFromUrl(url: string): string {
	const u = url.trim()
	if (!u) return ''
	if (u.includes('youtube.com') || u.includes('youtu.be')) return PRODUCTION_BACKGROUND_YOUTUBE_MIME
	const kind = resolveProductionBackgroundMediaKind({ url: u, mime: '' })
	if (kind === 'video') return 'video/mp4'
	if (kind === 'pdf') return 'application/pdf'
	if (kind === 'image') return 'image/jpeg'
	return ''
}

/** Merge `properties.beamioProduction` / root `beamioProduction` into one row (issued NFT + share token). */
export function flattenIssuedProductionSeriesMetadata(rootMeta: Record<string, unknown>): Record<string, unknown> {
	const props =
		rootMeta.properties && typeof rootMeta.properties === 'object' && !Array.isArray(rootMeta.properties)
			? (rootMeta.properties as Record<string, unknown>)
			: {}
	const fromProps =
		props.beamioProduction &&
		typeof props.beamioProduction === 'object' &&
		!Array.isArray(props.beamioProduction)
			? (props.beamioProduction as Record<string, unknown>)
			: {}
	const fromRoot =
		rootMeta.beamioProduction &&
		typeof rootMeta.beamioProduction === 'object' &&
		!Array.isArray(rootMeta.beamioProduction)
			? (rootMeta.beamioProduction as Record<string, unknown>)
			: {}
	const productionId =
		(typeof rootMeta.productionId === 'string' && rootMeta.productionId.trim()) ||
		(typeof fromRoot.productionId === 'string' && fromRoot.productionId.trim()) ||
		(typeof fromProps.productionId === 'string' && fromProps.productionId.trim()) ||
		(typeof rootMeta.id === 'string' && rootMeta.id.trim()) ||
		(typeof fromRoot.id === 'string' && fromRoot.id.trim()) ||
		(typeof fromProps.id === 'string' && fromProps.id.trim()) ||
		''
	return {
		...rootMeta,
		...fromProps,
		...fromRoot,
		...(productionId ? { productionId, id: productionId } : {}),
	}
}

export function catalogProductionHasVideoBackgroundMedia(args: {
	productionImage: string
	productionImageMime?: string
}): boolean {
	if (!args.productionImage.trim()) return false
	return (
		resolveProductionBackgroundMediaKind({
			url: args.productionImage,
			mime: args.productionImageMime,
		}) === 'video'
	)
}

export function youtubeThumbnailUrlFromProductionUrl(raw: string): string | null {
	const id = parseYoutubeVideoId(raw)
	if (!id) return null
	return `https://img.youtube.com/vi/${id}/hqdefault.jpg`
}

export function formatCatalogProductionPublisherLine(
	publisherBeamioTag: string | undefined,
	channelOrDisplayName: string
): string | null {
	const name = channelOrDisplayName.trim()
	const rawTag = (publisherBeamioTag ?? '').trim().replace(/^@/, '')
	if (!rawTag && !name) return null
	if (rawTag && name) return `@${rawTag} · ${name}`
	if (rawTag) return `@${rawTag}`
	return name
}

function resolveCatalogVideoOgBannerImage(productionImage: string, iconUrl: string): string {
	const thumb = youtubeThumbnailUrlFromProductionUrl(productionImage)
	if (thumb) return thumb
	if (iconUrl.trim()) return iconUrl.trim()
	return productionImage.trim()
}

function resolveCatalogVideoOgIconUrl(productionImage: string, iconUrl: string): string {
	if (iconUrl.trim()) return iconUrl.trim()
	return youtubeThumbnailUrlFromProductionUrl(productionImage) ?? ''
}

/**
 * Maps stored catalog fields → share / OG / in-app preview text.
 * Video: title = videoTitle (subtitle), subtitle = description, publisher = @tag · channelName.
 */
export function resolveCatalogProductionSharePresentation(
	input: CatalogProductionShareFieldsInput
): CatalogProductionSharePresentation {
	const channelName = input.channelName.trim()
	const videoTitle = input.videoTitle.trim()
	const description = input.description.trim()
	const productionImage = input.productionImage.trim()
	const iconUrl = input.iconUrl.trim()

	if (!catalogProductionHasVideoBackgroundMedia(input)) {
		const title = channelName || 'Catalog Item'
		const subtitle = videoTitle
		return {
			layout: 'default',
			title,
			subtitle,
			publisherLine: null,
			iconUrl,
			bannerImageUrl: productionImage,
			channelName,
		}
	}

	const title = videoTitle || channelName || 'Catalog Item'
	const subtitle = description
	const resolvedIcon = resolveCatalogVideoOgIconUrl(productionImage, iconUrl)
	return {
		layout: 'videoOg',
		title,
		subtitle,
		publisherLine: formatCatalogProductionPublisherLine(input.publisherBeamioTag, channelName),
		iconUrl: resolvedIcon,
		bannerImageUrl: resolveCatalogVideoOgBannerImage(productionImage, resolvedIcon),
		channelName,
	}
}

/** Centered play badge radius for banner slot (OG raster + parity with biz canvas composite). */
export function catalogVideoOgPlayBadgeRadiusPx(width: number, height: number): number {
	const min = Math.min(width, height)
	return Math.max(
		CATALOG_VIDEO_OG_PLAY_BADGE_MIN_RADIUS_PX,
		Math.min(CATALOG_VIDEO_OG_PLAY_BADGE_MAX_RADIUS_PX, min * CATALOG_VIDEO_OG_PLAY_BADGE_RADIUS_RATIO)
	)
}

/**
 * SVG filter + shapes for catalog videoOg banner play affordance (Business Catalogs preview).
 * Caller must include `filterDef` in `<defs>` and `badgeLayer` after the banner `<image>`.
 */
export function buildCatalogVideoOgPlayBadgeSvgParts(
	slotX: number,
	slotY: number,
	slotW: number,
	slotH: number
): { filterDef: string; badgeLayer: string } {
	const r = catalogVideoOgPlayBadgeRadiusPx(slotW, slotH)
	const cx = slotX + slotW / 2
	const cy = slotY + slotH / 2
	const tri = r * 0.4
	const left = cx - tri * 0.38
	const right = cx + tri * 0.74
	const top = cy - tri * 0.62
	const bottom = cy + tri * 0.62
	const shadowDy = r * 0.14
	const shadowBlur = r * 0.55
	const filterDef = `<filter id="catalogPlayBadgeShadow" x="-100%" y="-100%" width="300%" height="300%">
      <feDropShadow dx="0" dy="${shadowDy}" stdDeviation="${shadowBlur}" flood-color="rgba(0,0,0,0.48)" />
    </filter>`
	const badgeLayer = `<g clip-path="url(#capsuleClip)">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(0,0,0,0.44)" filter="url(#catalogPlayBadgeShadow)" />
    <polygon points="${left},${top} ${left},${bottom} ${right},${cy}" fill="rgba(255,255,255,0.96)" />
  </g>`
	return { filterDef, badgeLayer }
}
