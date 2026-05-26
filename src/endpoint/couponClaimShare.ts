import { ethers } from 'ethers'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { listCouponIssuedNftSeriesForCardDescending, getCardByAddress } from '../db'
import { metadataMatchesClientCouponCategoryFilter } from '../couponMetadataCategory'

const BEAMIO_APP_ORIGIN = 'https://beamio.app'
const ISSUED_NFT_START_ID = 100_000_000_000n
const OG_WIDTH = 1200
const OG_HEIGHT = 630

export type CouponShareKind = 'open_claim' | 'redeem'

export type CouponOpenClaimShareParams = {
	kind: 'open_claim'
	cardAddress: string
	couponId: string
}

export type CouponRedeemShareParams = {
	kind: 'redeem'
	cardAddress: string
	redeemCode: string
	/** Optional — helps resolve coupon capsule metadata for social previews. */
	couponId?: string
}

/** @deprecated alias — prefer BeamioCouponShareParams */
export type CouponClaimShareParams = CouponOpenClaimShareParams

export type BeamioCouponShareParams = CouponOpenClaimShareParams | CouponRedeemShareParams

export type CouponClaimShareMeta = {
	shareKind: CouponShareKind
	cardAddress: string
	couponId?: string
	/** Program / merchant display name for share headline (e.g. "CoNET Labs Inc."). */
	merchantName: string
	/** e.g. "Claim a CoNET Labs Inc. Coupon" — matches OG image headline. */
	shareHeadline: string
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

const MERCHANT_NAME_KEYS = [
	'displayName',
	'merchantName',
	'brandName',
	'storeName',
	'programName',
	'brand',
	'merchant',
] as const

/** Default Card Unit Name — not a merchant brand; prefer shareTokenMetadata.displayName. */
const GENERIC_PROGRAM_UNIT_NAMES = new Set(['beamio'])

const readMetadataMerchantName = (meta: Record<string, unknown> | null): string => {
	if (!meta) return ''
	const props = asRecord(meta.properties)
	const beamioCoupon = asRecord(props?.beamioCoupon)
	for (const src of [meta, beamioCoupon, props]) {
		if (!src) continue
		for (const key of MERCHANT_NAME_KEYS) {
			const v = readString(src[key])
			if (v) return v
		}
	}
	return ''
}

const readCardProgramName = (metadata: Record<string, unknown> | null): string => {
	if (!metadata) return ''
	const shareTokenMetadata = asRecord(metadata.shareTokenMetadata)
	const displayName =
		readString(shareTokenMetadata?.displayName) || readString(metadata.displayName)
	if (displayName) return displayName
	const unitOrProgramName =
		readString(shareTokenMetadata?.name) ||
		readString(metadata.name) ||
		readString(metadata.programName)
	if (unitOrProgramName && !GENERIC_PROGRAM_UNIT_NAMES.has(unitOrProgramName.toLowerCase())) {
		return unitOrProgramName
	}
	return unitOrProgramName
}

const resolveMerchantNameForShare = async (
	cardNorm: string,
	couponMeta: Record<string, unknown> | null
): Promise<string> => {
	const fromCoupon = readMetadataMerchantName(couponMeta)
	if (fromCoupon) return truncateText(fromCoupon, 32)

	try {
		const cardRow = await getCardByAddress(cardNorm)
		const fromCard = readCardProgramName(asRecord(cardRow?.metadata ?? null))
		if (fromCard) return truncateText(fromCard, 32)
	} catch {
		// ignore — fall back below
	}

	return 'Beamio'
}

export const buildShareHeadline = (merchantName: string, shareKind: CouponShareKind): string => {
	const verb = shareKind === 'redeem' ? 'Redeem' : 'Claim'
	return `${verb} a ${truncateText(merchantName.trim() || 'Beamio', 28)} Coupon`
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

export function buildCouponRedeemAppDownloadUrl(
	cardAddress: string,
	redeemCode: string,
	couponId?: string
): string {
	const card = ethers.getAddress(cardAddress)
	const params = new URLSearchParams()
	params.set('beamiocard', card)
	params.set('redeemcode', redeemCode.trim())
	const cid = couponId?.trim() ?? ''
	if (cid) params.set('couponId', cid)
	const redeemUrl = `${BEAMIO_APP_ORIGIN}/app/?${params.toString()}`
	return `${BEAMIO_APP_ORIGIN}/app-download?target=${encodeURIComponent(redeemUrl)}`
}

function appendAppDownloadCacheBust(appDownloadUrl: string, v?: string): string {
	const vTrim = v?.trim() ?? ''
	if (!vTrim) return appDownloadUrl
	try {
		const u = new URL(appDownloadUrl)
		u.searchParams.set('v', vTrim)
		return u.toString()
	} catch {
		return appDownloadUrl
	}
}

export function parseCouponClaimFromBeamioAppUrl(raw: string): CouponOpenClaimShareParams | null {
	const input = raw?.trim() ?? ''
	if (!input) return null
	try {
		const url = new URL(input)
		if (url.origin !== BEAMIO_APP_ORIGIN) return null
		if (!isAllowedBeamioAppPath(url.pathname)) return null
		const cardAddress = (url.searchParams.get('beamiocard') ?? url.searchParams.get('Beamiocard') ?? '').trim()
		const redeemCode = decodeURIComponent(
			(url.searchParams.get('redeemcode') ?? url.searchParams.get('Redeemcode') ?? '').trim()
		)
		const couponId = decodeURIComponent(
			(url.searchParams.get('couponId') ?? url.searchParams.get('couponid') ?? '').trim()
		)
		const claim = (url.searchParams.get('claim') ?? '').trim().toLowerCase()
		if (!cardAddress || !couponId || !ethers.isAddress(cardAddress)) return null
		if (redeemCode) return null
		if (claim && claim !== 'open' && claim !== '1' && claim !== 'true') return null
		return { kind: 'open_claim', cardAddress: ethers.getAddress(cardAddress), couponId }
	} catch {
		return null
	}
}

export function parseRedeemShareFromBeamioAppUrl(raw: string): CouponRedeemShareParams | null {
	const input = raw?.trim() ?? ''
	if (!input) return null
	try {
		const url = new URL(input)
		if (url.origin !== BEAMIO_APP_ORIGIN) return null
		if (!isAllowedBeamioAppPath(url.pathname)) return null
		const cardAddress = (url.searchParams.get('beamiocard') ?? url.searchParams.get('Beamiocard') ?? '').trim()
		const redeemCode = decodeURIComponent(
			(url.searchParams.get('redeemcode') ?? url.searchParams.get('Redeemcode') ?? '').trim()
		)
		if (!cardAddress || !redeemCode || !ethers.isAddress(cardAddress)) return null
		const couponId = decodeURIComponent(
			(url.searchParams.get('couponId') ?? url.searchParams.get('couponid') ?? '').trim()
		)
		return {
			kind: 'redeem',
			cardAddress: ethers.getAddress(cardAddress),
			redeemCode,
			...(couponId ? { couponId } : {}),
		}
	} catch {
		return null
	}
}

export function parseRedeemShareFromAppDownloadTarget(target: string): CouponRedeemShareParams | null {
	const trimmed = target?.trim() ?? ''
	if (!trimmed) return null
	try {
		const wrapper = new URL(trimmed)
		if (wrapper.origin !== BEAMIO_APP_ORIGIN) return null
		if (!isAllowedBeamioAppPath(wrapper.pathname)) return null
		return parseRedeemShareFromBeamioAppUrl(trimmed)
	} catch {
		return null
	}
}

export function parseCouponClaimFromAppDownloadTarget(target: string): CouponOpenClaimShareParams | null {
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
	redeemcode?: string
	redeemCode?: string
	v?: string
}): { params: BeamioCouponShareParams; shareUrl: string } | null {
	const target = readString(query.target)
	const cacheBustV = readString(query.v)
	const withCacheBust = (url: string) => appendAppDownloadCacheBust(url, cacheBustV)
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
		const openClaim = parseCouponClaimFromAppDownloadTarget(innerTarget)
		const redeem = parseRedeemShareFromAppDownloadTarget(innerTarget)
		if (redeem) {
			if (!shareUrl) {
				shareUrl = buildCouponRedeemAppDownloadUrl(redeem.cardAddress, redeem.redeemCode, redeem.couponId)
			}
			return { params: redeem, shareUrl: withCacheBust(shareUrl) }
		}
		if (openClaim) {
			if (!shareUrl) shareUrl = buildCouponClaimAppDownloadUrl(openClaim.cardAddress, openClaim.couponId)
			return { params: openClaim, shareUrl: withCacheBust(shareUrl) }
		}
		return null
	}
	const card = readString(query.card)
	const couponId = readString(query.couponId)
	const redeemCode = readString(query.redeemcode ?? query.redeemCode)
	if (card && redeemCode && ethers.isAddress(card)) {
		const params: CouponRedeemShareParams = {
			kind: 'redeem',
			cardAddress: ethers.getAddress(card),
			redeemCode,
			...(couponId ? { couponId } : {}),
		}
		return { params, shareUrl: buildCouponRedeemAppDownloadUrl(params.cardAddress, params.redeemCode, params.couponId) }
	}
	if (!card || !couponId || !ethers.isAddress(card)) return null
	const params: CouponOpenClaimShareParams = { kind: 'open_claim', cardAddress: ethers.getAddress(card), couponId }
	return { params, shareUrl: buildCouponClaimAppDownloadUrl(params.cardAddress, params.couponId) }
}

/** Prefer path-based OG URL (no query string) for WeChat; JPEG for preview compatibility. */
function encodeOgShareToken(params: BeamioCouponShareParams): string {
	const payload =
		params.kind === 'redeem'
			? { k: 'r' as const, c: params.cardAddress, r: params.redeemCode, ...(params.couponId ? { i: params.couponId } : {}) }
			: { k: 'o' as const, c: params.cardAddress, i: params.couponId }
	return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodeOgShareToken(tokenRaw: string): BeamioCouponShareParams | null {
	let token = tokenRaw.replace(/\.jpg$/i, '').trim()
	if (!token) return null
	// Legacy WeChat square suffix — always serve full 1200×630 wide card art.
	if (token.endsWith('-wx')) token = token.slice(0, -3)
	try {
		const raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
			k?: string
			c?: string
			r?: string
			i?: string
		}
		if (raw.k === 'r' && raw.c && raw.r && ethers.isAddress(raw.c)) {
			return {
				kind: 'redeem',
				cardAddress: ethers.getAddress(raw.c),
				redeemCode: raw.r,
				...(raw.i ? { couponId: raw.i } : {}),
			}
		}
		if (raw.k === 'o' && raw.c && raw.i && ethers.isAddress(raw.c)) {
			return { kind: 'open_claim', cardAddress: ethers.getAddress(raw.c), couponId: raw.i }
		}
		return null
	} catch {
		return null
	}
}

function buildOgImageUrl(_shareUrl: string, params?: BeamioCouponShareParams): string {
	if (params) {
		return `${BEAMIO_APP_ORIGIN}/og/s/${encodeOgShareToken(params)}.jpg`
	}
	return `${BEAMIO_APP_ORIGIN}/og.png`
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

async function lookupCouponSeriesMeta(
	cardNorm: string,
	wantedCouponId: string
): Promise<{ matchedMeta: Record<string, unknown> | null; validBeforeSec: number | null }> {
	const candidates = await listCouponIssuedNftSeriesForCardDescending(cardNorm, 300)
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
		return { matchedMeta: meta, validBeforeSec: readMetadataValidBeforeSec(meta) }
	}
	return { matchedMeta: null, validBeforeSec: null }
}

async function resolveOpenClaimShareMeta(
	params: CouponOpenClaimShareParams,
	shareUrl: string
): Promise<CouponClaimShareMeta | null> {
	const cardNorm = ethers.getAddress(params.cardAddress)
	const wantedCouponId = params.couponId.trim()
	if (!wantedCouponId) return null

	const { matchedMeta, validBeforeSec } = await lookupCouponSeriesMeta(cardNorm, wantedCouponId)

	const title = truncateText(readMetadataTitle(matchedMeta) || 'Beamio Coupon', 48)
	const merchantName = await resolveMerchantNameForShare(cardNorm, matchedMeta)
	const rawSubtitle = readMetadataSubtitle(matchedMeta)
	const subtitle = truncateText(
		rawSubtitle || (title !== 'Beamio Coupon' ? `${title} — ${merchantName}` : 'Claim this coupon in the Beamio app.'),
		120
	)
	const expiresLabel = formatCouponExpiryPill(validBeforeSec)

	return {
		shareKind: 'open_claim',
		cardAddress: cardNorm,
		couponId: wantedCouponId,
		merchantName,
		shareHeadline: buildShareHeadline(merchantName, 'open_claim'),
		title,
		subtitle,
		iconUrl: readMetadataIconUrl(matchedMeta),
		backgroundImage: readMetadataBackgroundImage(matchedMeta),
		backgroundColorHex: readMetadataBackgroundColor(matchedMeta) || '#2B2E3A',
		validBeforeSec,
		expiresLabel,
		shareUrl,
		ogImageUrl: buildOgImageUrl(shareUrl, { kind: 'open_claim', cardAddress: cardNorm, couponId: wantedCouponId }),
	}
}

async function resolveRedeemShareMeta(
	params: CouponRedeemShareParams,
	shareUrl: string
): Promise<CouponClaimShareMeta | null> {
	const cardNorm = ethers.getAddress(params.cardAddress)
	const wantedCouponId = params.couponId?.trim() ?? ''
	let matchedMeta: Record<string, unknown> | null = null
	let validBeforeSec: number | null = null
	if (wantedCouponId) {
		const looked = await lookupCouponSeriesMeta(cardNorm, wantedCouponId)
		matchedMeta = looked.matchedMeta
		validBeforeSec = looked.validBeforeSec
	}

	const title = truncateText(readMetadataTitle(matchedMeta) || 'Beamio Coupon', 48)
	const merchantName = await resolveMerchantNameForShare(cardNorm, matchedMeta)
	const rawSubtitle = readMetadataSubtitle(matchedMeta)
	const subtitle = truncateText(
		rawSubtitle || (title !== 'Beamio Coupon' ? `${title} — ${merchantName}` : 'Redeem this coupon in the Beamio app.'),
		120
	)
	const expiresLabel = formatCouponExpiryPill(validBeforeSec)

	return {
		shareKind: 'redeem',
		cardAddress: cardNorm,
		...(wantedCouponId ? { couponId: wantedCouponId } : {}),
		merchantName,
		shareHeadline: buildShareHeadline(merchantName, 'redeem'),
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
	}
}

export async function resolveCouponClaimShareMeta(
	params: BeamioCouponShareParams,
	shareUrl: string
): Promise<CouponClaimShareMeta | null> {
	if (params.kind === 'redeem') return resolveRedeemShareMeta(params, shareUrl)
	return resolveOpenClaimShareMeta(params, shareUrl)
}

export function buildFallbackCouponClaimShareMeta(
	params: BeamioCouponShareParams,
	shareUrl: string
): CouponClaimShareMeta {
	const isRedeem = params.kind === 'redeem'
	const merchantName = 'Beamio'
	return {
		shareKind: params.kind,
		cardAddress: params.cardAddress,
		...(params.kind === 'open_claim'
			? { couponId: params.couponId }
			: params.couponId
				? { couponId: params.couponId }
				: {}),
		merchantName,
		shareHeadline: buildShareHeadline(merchantName, params.kind),
		title: 'Beamio Coupon',
		subtitle: isRedeem ? 'Redeem this coupon in the Beamio app.' : 'Claim this coupon in the Beamio app.',
		iconUrl: '',
		backgroundImage: '',
		backgroundColorHex: '#2B2E3A',
		validBeforeSec: null,
		expiresLabel: 'VALID NOW',
		shareUrl,
		ogImageUrl: buildOgImageUrl(shareUrl, params),
	}
}

async function buildCouponClaimOgSvg(meta: CouponClaimShareMeta): Promise<string> {
	const punchBg = '#f9f9fe'
	const hasBanner = Boolean(meta.backgroundImage?.trim())
	const capsuleX = 50
	const capsuleW = 1100
	const capsuleRx = 28
	const capsuleY = hasBanner ? 96 : 165
	const capsuleH = hasBanner ? 150 : 300
	const iconCx = capsuleX + 112
	const iconCy = capsuleY + capsuleH / 2
	const urgent = couponExpiryUsesUrgentVariant(meta.expiresLabel)
	const innerExpiryFill = urgent ? '#dc2626' : 'rgba(15,23,42,0.65)'
	const innerExpiryText = '#ffffff'
	const externalExpiryFill = urgent ? '#dc2626' : '#eef1f3'
	const externalExpiryStroke = urgent ? '#dc2626' : 'rgba(171,173,175,0.35)'
	const externalExpiryText = urgent ? '#ffffff' : '#595c5e'

	const iconDataUrl = meta.iconUrl ? await fetchImageAsDataUrl(meta.iconUrl) : null
	const bgDataUrl = hasBanner ? await fetchImageAsDataUrl(meta.backgroundImage) : null
	const qrDataUrl = await QRCode.toDataURL(meta.shareUrl, {
		width: 280,
		margin: 1,
		color: { dark: '#111827', light: '#ffffff' },
	})

	const titleRaw = meta.title.trim()
	const subtitleRaw = meta.subtitle.trim()
	const title = titleRaw ? escapeXml(titleRaw) : ''
	const subtitle = subtitleRaw ? escapeXml(subtitleRaw) : ''
	const expires = escapeXml(meta.expiresLabel)
	const claimHeadline = escapeXml(meta.shareHeadline || buildShareHeadline(meta.merchantName, meta.shareKind))
	const initial = escapeXml((titleRaw.charAt(0) || 'B').toUpperCase())
	const expiryPillW = Math.min(360, Math.max(160, expires.length * 11 + 48))

	const bgLayer = bgDataUrl
		? `<image href="${bgDataUrl}" x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#capsuleClip)" />
<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" fill="url(#photoShade)" clip-path="url(#capsuleClip)" />`
		: `<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="${escapeXml(meta.backgroundColorHex)}" />
<rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="url(#stripePattern)" opacity="0.12" clip-path="url(#capsuleClip)" />`

	const iconLayer = iconDataUrl
		? `<image href="${iconDataUrl}" x="${iconCx - 56}" y="${iconCy - 56}" width="112" height="112" preserveAspectRatio="xMidYMid slice" clip-path="url(#iconClip)" />`
		: `<text x="${iconCx}" y="${iconCy + 14}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="800" fill="#334155">${initial}</text>`

	const ticketShell = `
  ${bgLayer}
  <rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="url(#capsuleShade)" clip-path="url(#capsuleClip)" />
  <rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="2" />
  <circle cx="${capsuleX}" cy="${iconCy}" r="18" fill="${punchBg}" />
  <circle cx="${capsuleX + capsuleW}" cy="${iconCy}" r="18" fill="${punchBg}" />
  <circle cx="${iconCx}" cy="${iconCy}" r="58" fill="rgba(255,255,255,0.95)" stroke="rgba(255,255,255,0.4)" stroke-width="4" />
  ${iconLayer}`

	const innerTextLayer =
		!hasBanner && (title || subtitle)
			? `
  ${title ? `<text x="${capsuleX + 200}" y="${capsuleY + 128}" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800" fill="#ffffff">${title}</text>` : ''}
  ${subtitle ? `<text x="${capsuleX + 200}" y="${capsuleY + 172}" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="600" fill="rgba(255,255,255,0.92)">${subtitle}</text>` : ''}
  <rect x="${capsuleX + 200}" y="${capsuleY + 198}" rx="18" ry="18" width="${expiryPillW}" height="36" fill="${innerExpiryFill}" />
  <text x="${capsuleX + 224}" y="${capsuleY + 222}" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="${innerExpiryText}">${expires}</text>`
			: !hasBanner
				? `
  <rect x="${capsuleX + 200}" y="${capsuleY + 128}" rx="18" ry="18" width="${expiryPillW}" height="36" fill="${innerExpiryFill}" />
  <text x="${capsuleX + 224}" y="${capsuleY + 152}" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="${innerExpiryText}">${expires}</text>`
				: ''

	const innerQrLayer = !hasBanner
		? `
  <rect x="${capsuleX + capsuleW - 196}" y="${capsuleY + 78}" width="156" height="156" rx="20" fill="#ffffff" />
  <image href="${qrDataUrl}" x="${capsuleX + capsuleW - 184}" y="${capsuleY + 90}" width="132" height="132" />`
		: ''

	let metaBelowY = capsuleY + capsuleH + 36
	const metaLines: string[] = []
	if (hasBanner) {
		if (title) {
			metaLines.push(
				`<text x="${capsuleX}" y="${metaBelowY}" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="800" fill="#2c2f31">${title}</text>`
			)
			metaBelowY += 38
		}
		if (subtitle) {
			metaLines.push(
				`<text x="${capsuleX}" y="${metaBelowY}" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="600" fill="#595c5e">${subtitle}</text>`
			)
			metaBelowY += 34
		}
		const pillY = metaBelowY - 8
		metaLines.push(
			`<rect x="${capsuleX}" y="${pillY}" rx="18" ry="18" width="${expiryPillW}" height="36" fill="${externalExpiryFill}" stroke="${externalExpiryStroke}" stroke-width="2" />`,
			`<text x="${capsuleX + 24}" y="${pillY + 24}" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="${externalExpiryText}">${expires}</text>`
		)
		metaBelowY = pillY + 36
	}

	const qrSize = hasBanner ? 120 : 0
	const qrY = hasBanner ? metaBelowY + 20 : 0
	const qrX = (OG_WIDTH - qrSize) / 2
	const externalQrLayer = hasBanner
		? `
  <rect x="${qrX - 12}" y="${qrY - 12}" width="${qrSize + 24}" height="${qrSize + 24}" rx="20" fill="#ffffff" stroke="rgba(0,0,0,0.08)" stroke-width="2" />
  <image href="${qrDataUrl}" x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" />`
		: ''

	const scanHintY = hasBanner ? qrY + qrSize + 44 : 132
	const scanHint = 'Scan the QR code above or open this link on your phone'

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <clipPath id="capsuleClip">
      <rect x="${capsuleX}" y="${capsuleY}" width="${capsuleW}" height="${capsuleH}" rx="${capsuleRx}" />
    </clipPath>
    <clipPath id="iconClip">
      <circle cx="${iconCx}" cy="${iconCy}" r="56" />
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
  <text x="600" y="${hasBanner ? 56 : 92}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800" fill="#1a1c1f">${claimHeadline}</text>
  ${!hasBanner ? `<text x="600" y="132" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="600" fill="#64748b">Scan the QR or open the link on your phone</text>` : ''}
  ${ticketShell}
  ${innerTextLayer}
  ${innerQrLayer}
  ${hasBanner ? metaLines.join('\n  ') : ''}
  ${externalQrLayer}
  ${hasBanner ? `<text x="600" y="${scanHintY}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="600" fill="#64748b">${scanHint}</text>` : ''}
</svg>`
}

const ogImageCache = new Map<string, { buf: Buffer; expiry: number }>()
const OG_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000

async function renderCouponClaimOgRaster(meta: CouponClaimShareMeta, format: 'png' | 'jpeg'): Promise<Buffer> {
	const hasBanner = Boolean(meta.backgroundImage?.trim())
	const cacheKey = `${format}:wide:v2:${meta.shareKind}:${meta.cardAddress.toLowerCase()}:${meta.couponId ?? ''}:${meta.merchantName}:${meta.shareUrl}:${hasBanner ? 'banner' : 'solid'}`
	const cached = ogImageCache.get(cacheKey)
	if (cached && Date.now() < cached.expiry) return cached.buf

	const svg = await buildCouponClaimOgSvg(meta)
	const buf =
		format === 'jpeg'
			? await sharp(Buffer.from(svg))
					.jpeg({ quality: 80, progressive: false, mozjpeg: true, chromaSubsampling: '4:2:0' })
					.toBuffer()
			: await sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer()
	ogImageCache.set(cacheKey, { buf, expiry: Date.now() + OG_IMAGE_CACHE_TTL_MS })
	return buf
}

export async function renderCouponClaimOgPng(meta: CouponClaimShareMeta): Promise<Buffer> {
	return renderCouponClaimOgRaster(meta, 'png')
}

export async function renderCouponClaimOgJpeg(meta: CouponClaimShareMeta): Promise<Buffer> {
	return renderCouponClaimOgRaster(meta, 'jpeg')
}

export function renderCouponClaimShareHtml(meta: CouponClaimShareMeta): string {
	const headline = escapeXml(meta.shareHeadline || buildShareHeadline(meta.merchantName, meta.shareKind))
	const title = escapeXml(meta.title)
	const description = escapeXml(meta.subtitle)
	const shareUrl = escapeXml(meta.shareUrl)
	const ogImage = escapeXml(meta.ogImageUrl)
	const actionHint =
		meta.shareKind === 'redeem'
			? 'Open this link on your phone to redeem in Beamio.'
			: 'Open this link on your phone to claim in Beamio.'
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
</html>`
}

export function isSocialShareCrawlerUserAgent(userAgent: string | undefined): boolean {
	const ua = String(userAgent ?? '')
	if (!ua) return false
	return /(facebookexternalhit|Facebot|Twitterbot|WhatsApp|LinkedInBot|Slackbot|TelegramBot|MicroMessenger|weixin_spider|TencentTraveler|WindowsWechat|WechatShare|WeChat|Discordbot|bingpreview|Pinterestbot|Applebot)/i.test(
		ua
	)
}
