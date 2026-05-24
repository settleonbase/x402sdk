import { ethers } from 'ethers'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { listCouponIssuedNftSeriesForCardDescending } from '../db'
import { metadataMatchesClientCouponCategoryFilter } from '../couponMetadataCategory'

const BEAMIO_APP_ORIGIN = 'https://beamio.app'
const ISSUED_NFT_START_ID = 100_000_000_000n
const OG_WIDTH = 1200
const OG_HEIGHT = 630

export type CouponClaimShareParams = {
	cardAddress: string
	couponId: string
}

export type CouponClaimShareMeta = {
	cardAddress: string
	couponId: string
	title: string
	subtitle: string
	iconUrl: string
	backgroundImage: string
	backgroundColorHex: string
	validBeforeSec: number | null
	expiresLabel: string
	shareUrl: string
	ogImageUrl: string
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === 'object' ? (v as Record<string, unknown>) : null

const readString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const readMetadataCouponId = (meta: Record<string, unknown> | null): string => {
	if (!meta) return ''
	const root = readString(meta.couponId)
	if (root) return root
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	return readString(beamioCoupon?.couponId)
}

const readMetadataTitle = (meta: Record<string, unknown> | null): string => {
	if (!meta) return ''
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	return (
		readString(meta.title) ||
		readString(meta.name) ||
		readString(beamioCoupon?.title) ||
		readString(beamioCoupon?.name)
	)
}

const readMetadataSubtitle = (meta: Record<string, unknown> | null): string => {
	if (!meta) return ''
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	return (
		readString(meta.subtitle) ||
		readString(meta.description) ||
		readString(beamioCoupon?.subtitle) ||
		readString(beamioCoupon?.description)
	)
}

const readMetadataIconUrl = (meta: Record<string, unknown> | null): string => {
	if (!meta) return ''
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	const shareTokenMetadata = asRecord(props?.shareTokenMetadata)
	const imageObj = asRecord(meta.image)
	return (
		readString(meta.iconUrl) ||
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
		readString(meta.image)
	)
}

const COUPON_BACKGROUND_IMAGE_KEYS = [
	'couponImage',
	'background',
	'backgroundImage',
	'backgroundImageUrl',
	'cover',
	'coverImage',
] as const

const readMetadataStringFromKeys = (src: Record<string, unknown> | null, keys: readonly string[]): string => {
	if (!src) return ''
	for (const key of keys) {
		const v = readString(src[key])
		if (v) return v
	}
	return ''
}

const readMetadataBackgroundImage = (meta: Record<string, unknown> | null): string => {
	if (!meta) return ''
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	return (
		readMetadataStringFromKeys(meta, COUPON_BACKGROUND_IMAGE_KEYS) ||
		readMetadataStringFromKeys(beamioCoupon, COUPON_BACKGROUND_IMAGE_KEYS)
	)
}

const COUPON_BACKGROUND_COLOR_KEYS = [
	'backgroundColor',
	'bgColor',
	'color',
	'backgroundColorHex',
	'background_color',
] as const

const readMetadataBackgroundColor = (meta: Record<string, unknown> | null): string => {
	if (!meta) return ''
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	const c =
		readMetadataStringFromKeys(meta, COUPON_BACKGROUND_COLOR_KEYS) ||
		readMetadataStringFromKeys(beamioCoupon, COUPON_BACKGROUND_COLOR_KEYS)
	if (!c) return ''
	return c.startsWith('#') ? c : `#${c}`
}

export const formatCouponExpiryPill = (validBeforeSec: number | null): string => {
	if (!Number.isFinite(validBeforeSec ?? NaN) || (validBeforeSec ?? 0) <= 0) return 'VALID NOW'
	const now = Math.floor(Date.now() / 1000)
	if ((validBeforeSec ?? 0) <= now) return 'EXPIRED'
	const delta = (validBeforeSec ?? now) - now
	if (delta >= 86_400) return `EXPIRES IN ${Math.ceil(delta / 86_400)}D`
	if (delta >= 3_600) return `EXPIRES IN ${Math.ceil(delta / 3_600)}H`
	return `EXPIRES IN ${Math.max(1, Math.ceil(delta / 60))}M`
}

const readMetadataValidBeforeSec = (meta: Record<string, unknown> | null): number | null => {
	if (!meta) return null
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	for (const src of [meta, beamioCoupon, props]) {
		if (!src) continue
		for (const key of ['issuedNftValidBefore', 'validBefore', 'expiresAt', 'valid_before']) {
			const n = Number(src[key])
			if (Number.isFinite(n) && n > 0) return n
		}
	}
	return null
}

const couponExpiryUsesUrgentVariant = (expiresLabel: string): boolean =>
	expiresLabel === 'EXPIRED' || /\bEXPIRES IN \d+H\b|\bEXPIRES IN \d+M\b/.test(expiresLabel)

export function buildCouponClaimAppDownloadUrl(cardAddress: string, couponId: string): string {
	const card = ethers.getAddress(cardAddress)
	const claimUrl = `${BEAMIO_APP_ORIGIN}/app/?beamiocard=${encodeURIComponent(
		card
	)}&couponId=${encodeURIComponent(couponId.trim())}&claim=open`
	return `${BEAMIO_APP_ORIGIN}/app-download?target=${encodeURIComponent(claimUrl)}`
}

function isAllowedBeamioAppPath(pathname: string): boolean {
	return pathname === '/app/' || pathname === '/app' || pathname.startsWith('/app/')
}

export function parseCouponClaimFromBeamioAppUrl(raw: string): CouponClaimShareParams | null {
	const input = raw?.trim() ?? ''
	if (!input) return null
	try {
		const url = new URL(input)
		if (url.origin !== BEAMIO_APP_ORIGIN) return null
		if (!isAllowedBeamioAppPath(url.pathname)) return null
		const cardAddress = (url.searchParams.get('beamiocard') ?? url.searchParams.get('Beamiocard') ?? '').trim()
		const couponId = decodeURIComponent(
			(url.searchParams.get('couponId') ?? url.searchParams.get('couponid') ?? '').trim()
		)
		const claim = (url.searchParams.get('claim') ?? '').trim().toLowerCase()
		if (!cardAddress || !couponId || !ethers.isAddress(cardAddress)) return null
		if (claim && claim !== 'open' && claim !== '1' && claim !== 'true') return null
		return { cardAddress: ethers.getAddress(cardAddress), couponId }
	} catch {
		return null
	}
}

export function parseCouponClaimFromAppDownloadTarget(target: string): CouponClaimShareParams | null {
	const trimmed = target?.trim() ?? ''
	if (!trimmed) return null
	try {
		const wrapper = new URL(trimmed)
		if (wrapper.origin !== BEAMIO_APP_ORIGIN) return null
		if (!isAllowedBeamioAppPath(wrapper.pathname)) return null
		return parseCouponClaimFromBeamioAppUrl(trimmed)
	} catch {
		return null
	}
}

export function parseCouponClaimShareRequest(query: {
	target?: string
	card?: string
	couponId?: string
}): { params: CouponClaimShareParams; shareUrl: string } | null {
	const target = readString(query.target)
	if (target) {
		let innerTarget = target
		let shareUrl = ''
		try {
			const asUrl = new URL(target)
			if (asUrl.origin === BEAMIO_APP_ORIGIN && (asUrl.pathname === '/app-download' || asUrl.pathname === '/app-download/')) {
				innerTarget = asUrl.searchParams.get('target')?.trim() ?? ''
				shareUrl = asUrl.toString()
			}
		} catch {
			// Use raw target as inner claim URL.
		}
		const params = parseCouponClaimFromAppDownloadTarget(innerTarget)
		if (!params) return null
		if (!shareUrl) shareUrl = buildCouponClaimAppDownloadUrl(params.cardAddress, params.couponId)
		return { params, shareUrl }
	}
	const card = readString(query.card)
	const couponId = readString(query.couponId)
	if (!card || !couponId || !ethers.isAddress(card)) return null
	const params = { cardAddress: ethers.getAddress(card), couponId }
	return { params, shareUrl: buildCouponClaimAppDownloadUrl(params.cardAddress, params.couponId) }
}

function buildOgImageUrl(shareUrl: string): string {
	return `${BEAMIO_APP_ORIGIN}/api/og/coupon-claim.png?target=${encodeURIComponent(shareUrl)}`
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

function truncateText(text: string, maxLen: number): string {
	const s = text.trim()
	if (s.length <= maxLen) return s
	return `${s.slice(0, Math.max(0, maxLen - 1)).trim()}…`
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
	const trimmed = url.trim()
	if (!trimmed.startsWith('https://')) return null
	try {
		const res = await fetch(trimmed, { signal: AbortSignal.timeout(8000) })
		if (!res.ok) return null
		const buf = Buffer.from(await res.arrayBuffer())
		if (buf.length <= 0 || buf.length > 4_000_000) return null
		const ct = (res.headers.get('content-type') || 'image/png').split(';')[0]?.trim() || 'image/png'
		return `data:${ct};base64,${buf.toString('base64')}`
	} catch {
		return null
	}
}

export async function resolveCouponClaimShareMeta(
	params: CouponClaimShareParams,
	shareUrl: string
): Promise<CouponClaimShareMeta | null> {
	const cardNorm = ethers.getAddress(params.cardAddress)
	const wantedCouponId = params.couponId.trim()
	if (!wantedCouponId) return null

	const candidates = await listCouponIssuedNftSeriesForCardDescending(cardNorm, 300)
	let matchedMeta: Record<string, unknown> | null = null
	let validBeforeSec: number | null = null

	for (const row of candidates) {
		if (!metadataMatchesClientCouponCategoryFilter(row.metadata)) continue
		let tid: bigint
		try {
			tid = BigInt(row.tokenId)
		} catch {
			continue
		}
		if (tid < ISSUED_NFT_START_ID) continue
		const meta = asRecord(row.metadata)
		if (!meta) continue
		if (readMetadataCouponId(meta) !== wantedCouponId) continue
		matchedMeta = meta
		validBeforeSec = readMetadataValidBeforeSec(meta)
		break
	}

	const title = truncateText(readMetadataTitle(matchedMeta) || 'Beamio Coupon', 48)
	const subtitle = truncateText(readMetadataSubtitle(matchedMeta) || 'Claim this coupon in the Beamio app.', 72)
	const expiresLabel = formatCouponExpiryPill(validBeforeSec)

	return {
		cardAddress: cardNorm,
		couponId: wantedCouponId,
		title,
		subtitle,
		iconUrl: readMetadataIconUrl(matchedMeta),
		backgroundImage: readMetadataBackgroundImage(matchedMeta),
		backgroundColorHex: readMetadataBackgroundColor(matchedMeta) || '#2B2E3A',
		validBeforeSec,
		expiresLabel,
		shareUrl,
		ogImageUrl: buildOgImageUrl(shareUrl),
	}
}

export function buildFallbackCouponClaimShareMeta(
	params: CouponClaimShareParams,
	shareUrl: string
): CouponClaimShareMeta {
	return {
		cardAddress: params.cardAddress,
		couponId: params.couponId,
		title: 'Beamio Coupon',
		subtitle: 'Claim this coupon in the Beamio app.',
		iconUrl: '',
		backgroundImage: '',
		backgroundColorHex: '#2B2E3A',
		validBeforeSec: null,
		expiresLabel: 'VALID NOW',
		shareUrl,
		ogImageUrl: buildOgImageUrl(shareUrl),
	}
}

async function buildCouponClaimOgSvg(meta: CouponClaimShareMeta): Promise<string> {
	const punchBg = '#f9f9fe'
	const capsuleX = 50
	const capsuleY = 165
	const capsuleW = 1100
	const capsuleH = 300
	const capsuleRx = 28
	const urgent = couponExpiryUsesUrgentVariant(meta.expiresLabel)
	const expiryFill = urgent ? '#dc2626' : 'rgba(15,23,42,0.65)'
	const expiryText = urgent ? '#ffffff' : '#ffffff'

	const iconDataUrl = meta.iconUrl ? await fetchImageAsDataUrl(meta.iconUrl) : null
	const bgDataUrl = meta.backgroundImage ? await fetchImageAsDataUrl(meta.backgroundImage) : null
	const qrDataUrl = await QRCode.toDataURL(meta.shareUrl, {
		width: 280,
		margin: 1,
		color: { dark: '#111827', light: '#ffffff' },
	})

	const title = escapeXml(meta.title)
	const subtitle = escapeXml(meta.subtitle)
	const expires = escapeXml(meta.expiresLabel)
	const initial = escapeXml((meta.title.charAt(0) || 'B').toUpperCase())

	const bgLayer = bgDataUrl
		? `<image href="${bgDataUrl}" x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#capsuleClip)" />
<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" fill="url(#photoShade)" clip-path="url(#capsuleClip)" />`
		: `<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="${escapeXml(meta.backgroundColorHex)}" />
<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="url(#stripePattern)" opacity="0.12" clip-path="url(#capsuleClip)" />`

	const iconLayer = iconDataUrl
		? `<image href="${iconDataUrl}" x="${capsuleX + 56}" y="${capsuleY + 94}" width="112" height="112" preserveAspectRatio="xMidYMid slice" clip-path="url(#iconClip)" />`
		: `<text x="${capsuleX + 112}" y="${capsuleY + 162}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="800" fill="#334155">${initial}</text>`

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <clipPath id="capsuleClip">
      <rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" />
    </clipPath>
    <clipPath id="iconClip">
      <circle cx="${capsuleX + 112}" cy="${capsuleY + 150}" r="56" />
    </clipPath>
    <linearGradient id="capsuleShade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.30" />
    </linearGradient>
    <linearGradient id="photoShade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.72" />
      <stop offset="55%" stop-color="#000000" stop-opacity="0.52" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.35" />
    </linearGradient>
    <pattern id="stripePattern" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-26)">
      <rect width="8" height="8" fill="transparent" />
      <rect width="1" height="8" fill="#ffffff" />
    </pattern>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${punchBg}" />
  <text x="600" y="92" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800" fill="#1a1c1f">Claim a Beamio Coupon</text>
  <text x="600" y="132" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="600" fill="#64748b">Scan the QR or open the link on your phone</text>
  ${bgLayer}
  <rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="url(#capsuleShade)" clip-path="url(#capsuleClip)" />
  <rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="2" />
  <circle cx="${capsuleX}" cy="${capsuleY + capsuleH / 2}" r="18" fill="${punchBg}" />
  <circle cx="${capsuleX + capsuleW}" cy="${capsuleY + capsuleH / 2}" r="18" fill="${punchBg}" />
  <circle cx="${capsuleX + 112}" cy="${capsuleY + 150}" r="58" fill="rgba(255,255,255,0.95)" stroke="rgba(255,255,255,0.4)" stroke-width="4" />
  ${iconLayer}
  <text x="${capsuleX + 200}" y="${capsuleY + 128}" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800" fill="#ffffff">${title}</text>
  <text x="${capsuleX + 200}" y="${capsuleY + 172}" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="600" fill="rgba(255,255,255,0.92)">${subtitle}</text>
  <rect x="${capsuleX + 200}" y="${capsuleY + 198}" rx="18" ry="18" width="${Math.min(360, Math.max(160, expires.length * 11 + 48))}" height="36" fill="${expiryFill}" />
  <text x="${capsuleX + 224}" y="${capsuleY + 222}" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="${expiryText}">${expires}</text>
  <rect x="${capsuleX + capsuleW - 196}" y="${capsuleY + 78}" width="156" height="156" rx="20" fill="#ffffff" />
  <image href="${qrDataUrl}" x="${capsuleX + capsuleW - 184}" y="${capsuleY + 90}" width="132" height="132" />
</svg>`
}

const ogPngCache = new Map<string, { buf: Buffer; expiry: number }>()
const OG_PNG_CACHE_TTL_MS = 10 * 60 * 1000

export async function renderCouponClaimOgPng(meta: CouponClaimShareMeta): Promise<Buffer> {
	const cacheKey = `${meta.cardAddress.toLowerCase()}:${meta.couponId}:${meta.shareUrl}`
	const cached = ogPngCache.get(cacheKey)
	if (cached && Date.now() < cached.expiry) return cached.buf

	const svg = await buildCouponClaimOgSvg(meta)
	const buf = await sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer()
	ogPngCache.set(cacheKey, { buf, expiry: Date.now() + OG_PNG_CACHE_TTL_MS })
	return buf
}

export function renderCouponClaimShareHtml(meta: CouponClaimShareMeta): string {
	const title = escapeXml(meta.title)
	const description = escapeXml(meta.subtitle)
	const shareUrl = escapeXml(meta.shareUrl)
	const ogImage = escapeXml(meta.ogImageUrl)
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Beamio Coupon</title>
  <meta name="description" content="${description}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Beamio" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${shareUrl}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="${OG_WIDTH}" />
  <meta property="og:image:height" content="${OG_HEIGHT}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImage}" />
  <link rel="canonical" href="${shareUrl}" />
</head>
<body style="margin:0;background:#f9f9fe;color:#1a1c1f;font-family:Inter,Arial,sans-serif;">
  <main style="max-width:640px;margin:0 auto;padding:48px 24px;text-align:center;">
    <h1 style="font-size:28px;margin:0 0 12px;">${title}</h1>
    <p style="font-size:18px;color:#64748b;margin:0 0 24px;">${description}</p>
    <p style="font-size:14px;color:#94a3b8;">Open this link on your phone to claim in Beamio.</p>
    <p><a href="${shareUrl}" style="color:#1562f0;font-weight:600;">Continue to Beamio</a></p>
  </main>
</body>
</html>`
}

export function isSocialShareCrawlerUserAgent(userAgent: string | undefined): boolean {
	const ua = String(userAgent ?? '')
	if (!ua) return false
	return /(facebookexternalhit|Facebot|Twitterbot|WhatsApp|LinkedInBot|Slackbot|TelegramBot|MicroMessenger|Discordbot|bingpreview|Pinterestbot|Applebot)/i.test(
		ua
	)
}
