import dns from 'node:dns/promises'
import net from 'node:net'
import { Request, Response } from 'express'
import { GoogleGenAI } from '@google/genai'
import Colors from 'colors/safe'
import { getClientIp, masterSetup } from '../util'
import { logger } from '../logger'
import { normalizeOnboardingCountryCode } from '../onboardingCountries'
import {
	parseOnboardingLookupFiles,
	summarizeOnboardingLookupFiles,
	type ParsedOnboardingLookupFile,
} from './onboardingLookupFiles'
import { isStealthChallengeHtml, STEALTH_BROWSER_UA } from './stealthBrowserChallenge'
import { fetchHtmlViaStealthBrowser } from './stealthBrowserClient'

const CHANNELS = ['physical', 'digital', 'app'] as const
const PHYSICAL_CATS = [
	'food-beverage',
	'grocery-convenience',
	'fitness-wellness',
	'education-consulting',
	'entertainment-leisure',
	'health-beauty',
	'retail-shopping',
] as const
const DIGITAL_CATS = ['ecommerce-store', 'creator-kol', 'digital-services', 'freelance-agency'] as const
const APP_CATS = ['saas-platform', 'mobile-application', 'ai-ml-service', 'api-provider'] as const
const ORG_TYPES = ['sme', 'franchise', 'ngo'] as const
const CODED_PROVINCE_COUNTRIES = ['CA', 'US', 'GB', 'AU', 'DE'] as const

type ChannelKind = (typeof CHANNELS)[number]
type OrgType = (typeof ORG_TYPES)[number]

export type OnboardingBusinessLookupCandidate = {
	id: string
	name: string
	website: string
	snippet: string
	channelKind: ChannelKind | ''
	category: string
	orgType: OrgType | ''
	country: string
	city: string
	province: string
	publicBio: string
	street: string
	phone: string
	email: string
	postalCode: string
}

type DiscoveredBusiness = {
	name: string
	website: string
	snippet: string
	city: string
	country: string
	province: string
}

/** Cuisine in the shop name is not a city or country. */
const CUISINE_NOT_LOCATION_RULE =
	'Cuisine words in the name (Shanghainese, Shanghai Noodle, Sichuan, Cantonese) do NOT mean the shop is in that city or in China. Diaspora restaurants are common. Leave city and country unknown unless you know THAT named venue’s public listing address. Do not invent Canada.'

/** Platform-agnostic: recover the storefront name; never copy listing chrome or opaque store ids. */
const GEMINI_VENUE_NAME_RULE =
	'name must be the merchant venue (storefront) name, not a delivery/review platform brand, not a URL category segment such as Restaurant or Store, and not an opaque store id (for example “Restaurant ca-1725834231” or a UUID). If the scrape title or path is only a platform id, use visible page text or public knowledge of THAT listing to recover the real shop name, or leave name empty so another source can fill it. Do not copy generic marketplace template blurbs such as “available for online delivery and pickup on {Platform}” into snippet or publicBio.'

type PageSource = {
	url: string
	lang: string
	title: string
	description: string
	siteName: string
	jsonLdName: string
	city: string
	province: string
	country: string
	street: string
	phone: string
	email: string
	postalCode: string
	visibleText: string
}

// URLs copied from marketplaces often include tracking parameters. Keep the
// full URL intact so parsing/fetching does not receive a query truncated in
// the middle of a parameter value.
const MAX_QUERY = 2_048
const DISCOVER_QUERY_MAX = 400
const MAX_CANDIDATES = 5
// Modern storefronts (especially Shopify) often place app/configuration markup
// before the footer. Keep a bounded page budget, but do not reject a valid
// document merely because its footer pushes it slightly past 512 KiB.
const MAX_HTML_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 20
const CARD_SETUP_RATE_MAX = 10
const CARD_SETUP_DISCOVER_COPY_MAX = 200
const MAX_BRANDING_IMAGES = 24
const MAX_RAW_BRANDING = 40
const USER_AGENT = STEALTH_BROWSER_UA
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,ja;q=0.6,de;q=0.5,fr;q=0.4'
const VISIBLE_PER_PAGE = 4_000
const VISIBLE_TOTAL = 12_000
const MAX_NAME_SITES = 3
const MAX_EXTRA_LANG_URL = 2
const MAX_EXTRA_LANG_NAME = 1

const rateByIp = new Map<string, { windowStart: number; count: number }>()
const cardSetupRateByIp = new Map<string, { windowStart: number; count: number }>()

/** Mirrors Merchant OS `onboardingRegions.ts` — independent copy. Coded provinces only. */
const REGIONS_BY_COUNTRY: Record<string, readonly { value: string; label: string }[]> = {
	CA: [
		{ value: 'AB', label: 'Alberta' },
		{ value: 'BC', label: 'British Columbia' },
		{ value: 'MB', label: 'Manitoba' },
		{ value: 'NB', label: 'New Brunswick' },
		{ value: 'NL', label: 'Newfoundland and Labrador' },
		{ value: 'NS', label: 'Nova Scotia' },
		{ value: 'NT', label: 'Northwest Territories' },
		{ value: 'NU', label: 'Nunavut' },
		{ value: 'ON', label: 'Ontario' },
		{ value: 'PE', label: 'Prince Edward Island' },
		{ value: 'QC', label: 'Quebec' },
		{ value: 'SK', label: 'Saskatchewan' },
		{ value: 'YT', label: 'Yukon' },
	],
	US: [
		{ value: 'AL', label: 'Alabama' },
		{ value: 'AK', label: 'Alaska' },
		{ value: 'AZ', label: 'Arizona' },
		{ value: 'AR', label: 'Arkansas' },
		{ value: 'CA', label: 'California' },
		{ value: 'CO', label: 'Colorado' },
		{ value: 'CT', label: 'Connecticut' },
		{ value: 'DE', label: 'Delaware' },
		{ value: 'DC', label: 'District of Columbia' },
		{ value: 'FL', label: 'Florida' },
		{ value: 'GA', label: 'Georgia' },
		{ value: 'HI', label: 'Hawaii' },
		{ value: 'ID', label: 'Idaho' },
		{ value: 'IL', label: 'Illinois' },
		{ value: 'IN', label: 'Indiana' },
		{ value: 'IA', label: 'Iowa' },
		{ value: 'KS', label: 'Kansas' },
		{ value: 'KY', label: 'Kentucky' },
		{ value: 'LA', label: 'Louisiana' },
		{ value: 'ME', label: 'Maine' },
		{ value: 'MD', label: 'Maryland' },
		{ value: 'MA', label: 'Massachusetts' },
		{ value: 'MI', label: 'Michigan' },
		{ value: 'MN', label: 'Minnesota' },
		{ value: 'MS', label: 'Mississippi' },
		{ value: 'MO', label: 'Missouri' },
		{ value: 'MT', label: 'Montana' },
		{ value: 'NE', label: 'Nebraska' },
		{ value: 'NV', label: 'Nevada' },
		{ value: 'NH', label: 'New Hampshire' },
		{ value: 'NJ', label: 'New Jersey' },
		{ value: 'NM', label: 'New Mexico' },
		{ value: 'NY', label: 'New York' },
		{ value: 'NC', label: 'North Carolina' },
		{ value: 'ND', label: 'North Dakota' },
		{ value: 'OH', label: 'Ohio' },
		{ value: 'OK', label: 'Oklahoma' },
		{ value: 'OR', label: 'Oregon' },
		{ value: 'PA', label: 'Pennsylvania' },
		{ value: 'RI', label: 'Rhode Island' },
		{ value: 'SC', label: 'South Carolina' },
		{ value: 'SD', label: 'South Dakota' },
		{ value: 'TN', label: 'Tennessee' },
		{ value: 'TX', label: 'Texas' },
		{ value: 'UT', label: 'Utah' },
		{ value: 'VT', label: 'Vermont' },
		{ value: 'VA', label: 'Virginia' },
		{ value: 'WA', label: 'Washington' },
		{ value: 'WV', label: 'West Virginia' },
		{ value: 'WI', label: 'Wisconsin' },
		{ value: 'WY', label: 'Wyoming' },
	],
	GB: [
		{ value: 'ENG', label: 'England' },
		{ value: 'SCT', label: 'Scotland' },
		{ value: 'WLS', label: 'Wales' },
		{ value: 'NIR', label: 'Northern Ireland' },
	],
	AU: [
		{ value: 'ACT', label: 'Australian Capital Territory' },
		{ value: 'NSW', label: 'New South Wales' },
		{ value: 'NT', label: 'Northern Territory' },
		{ value: 'QLD', label: 'Queensland' },
		{ value: 'SA', label: 'South Australia' },
		{ value: 'TAS', label: 'Tasmania' },
		{ value: 'VIC', label: 'Victoria' },
		{ value: 'WA', label: 'Western Australia' },
	],
	DE: [
		{ value: 'BW', label: 'Baden-Württemberg' },
		{ value: 'BY', label: 'Bavaria' },
		{ value: 'BE', label: 'Berlin' },
		{ value: 'BB', label: 'Brandenburg' },
		{ value: 'HB', label: 'Bremen' },
		{ value: 'HH', label: 'Hamburg' },
		{ value: 'HE', label: 'Hesse' },
		{ value: 'MV', label: 'Mecklenburg-Vorpommern' },
		{ value: 'NI', label: 'Lower Saxony' },
		{ value: 'NW', label: 'North Rhine-Westphalia' },
		{ value: 'RP', label: 'Rhineland-Palatinate' },
		{ value: 'SL', label: 'Saarland' },
		{ value: 'SN', label: 'Saxony' },
		{ value: 'ST', label: 'Saxony-Anhalt' },
		{ value: 'SH', label: 'Schleswig-Holstein' },
		{ value: 'TH', label: 'Thuringia' },
	],
}

const EXTRA_PROVINCE_ALIASES: Record<string, Record<string, string>> = {
	CA: {
		卑诗: 'BC',
		卑詩: 'BC',
		不列颠哥伦比亚: 'BC',
		不列顛哥倫比亞: 'BC',
		安大略: 'ON',
		魁北克: 'QC',
		阿尔伯塔: 'AB',
		阿爾伯塔: 'AB',
	},
	US: {
		加州: 'CA',
		加利福尼亚: 'CA',
		加利福尼亞: 'CA',
		纽约: 'NY',
		紐約: 'NY',
		德州: 'TX',
		得克萨斯: 'TX',
	},
	GB: {
		英格兰: 'ENG',
		英格蘭: 'ENG',
		苏格兰: 'SCT',
		蘇格蘭: 'SCT',
		威尔士: 'WLS',
		威爾士: 'WLS',
	},
	AU: {
		新南威尔士: 'NSW',
		新南威爾士: 'NSW',
		维多利亚: 'VIC',
		維多利亞: 'VIC',
	},
	DE: {
		bayern: 'BY',
		nrw: 'NW',
		nordrheinwestfalen: 'NW',
		巴伐利亚: 'BY',
		巴伐利亞: 'BY',
	},
}

/** Gemini JSON Schema forbids empty-string enum values. */
const SCHEMA_UNKNOWN = 'unknown'

const LOOKUP_SCHEMA = {
	type: 'object' as const,
	properties: {
		candidates: {
			type: 'array' as const,
			items: {
				type: 'object' as const,
				properties: {
					id: { type: 'string' as const },
					name: { type: 'string' as const },
					website: { type: 'string' as const },
					snippet: { type: 'string' as const },
					channelKind: { type: 'string' as const, enum: [...CHANNELS, SCHEMA_UNKNOWN] },
					category: { type: 'string' as const },
					orgType: { type: 'string' as const, enum: [...ORG_TYPES, SCHEMA_UNKNOWN] },
					country: { type: 'string' as const },
					city: { type: 'string' as const },
					province: { type: 'string' as const },
					publicBio: { type: 'string' as const },
				},
				required: ['name'],
			},
		},
	},
	required: ['candidates'],
}

const DISCOVER_SCHEMA = {
	type: 'object' as const,
	properties: {
		candidates: {
			type: 'array' as const,
			items: {
				type: 'object' as const,
				properties: {
					name: { type: 'string' as const },
					website: { type: 'string' as const },
					snippet: { type: 'string' as const },
					city: { type: 'string' as const },
					country: { type: 'string' as const },
					province: { type: 'string' as const },
				},
				required: ['name'],
			},
		},
	},
	required: ['candidates'],
}

const CARD_SETUP_SCHEMA = {
	type: 'object' as const,
	properties: {
		logoUrl: { type: 'string' as const },
		backgroundUrl: { type: 'string' as const },
		brandColor: { type: 'string' as const },
		discoverCopy: { type: 'string' as const },
	},
	required: ['logoUrl', 'backgroundUrl', 'brandColor', 'discoverCopy'],
}

export type OnboardingCardSetupAssets = {
	logoUrl: string
	backgroundUrl: string
	brandColor: string
	discoverCopy: string
}

function clip(s: string, n: number): string {
	return s.trim().slice(0, n)
}

function foldKey(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function decodeEntities(raw: string): string {
	return raw
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/\s+/g, ' ')
		.trim()
}

function isBlockedIpv4(ip: string): boolean {
	const p = ip.split('.').map((x) => Number(x))
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
	if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true
	if (p[0] === 169 && p[1] === 254) return true
	if (p[0] === 192 && p[1] === 168) return true
	if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
	if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
	return false
}

function isBlockedIp(ip: string): boolean {
	const v = net.isIP(ip)
	if (v === 4) return isBlockedIpv4(ip)
	if (v === 6) {
		const n = ip.toLowerCase()
		if (n === '::1' || n === '::') return true
		if (n.startsWith('fe80:')) return true
		if (n.startsWith('fc') || n.startsWith('fd')) return true
		if (n.startsWith('::ffff:')) {
			const v4 = n.slice('::ffff:'.length)
			if (net.isIP(v4) === 4) return isBlockedIpv4(v4)
		}
		return false
	}
	return true
}

function hostnameBlocked(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/\.+$/, '')
	if (!h) return true
	if (h === 'localhost' || h === 'metadata.google.internal') return true
	if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
	if (net.isIP(h) && isBlockedIp(h)) return true
	return false
}

function takeRate(ip: string): boolean {
	const now = Date.now()
	const cur = rateByIp.get(ip)
	if (!cur || now - cur.windowStart >= RATE_WINDOW_MS) {
		rateByIp.set(ip, { windowStart: now, count: 1 })
		return true
	}
	if (cur.count >= RATE_MAX) return false
	cur.count += 1
	return true
}

function takeCardSetupRate(ip: string): boolean {
	const now = Date.now()
	const cur = cardSetupRateByIp.get(ip)
	if (!cur || now - cur.windowStart >= RATE_WINDOW_MS) {
		cardSetupRateByIp.set(ip, { windowStart: now, count: 1 })
		return true
	}
	if (cur.count >= CARD_SETUP_RATE_MAX) return false
	cur.count += 1
	return true
}

export function looksLikeWebsiteQuery(raw: string): boolean {
	const q = raw.trim()
	if (!q || q.length > MAX_QUERY) return false
	if (/^https?:\/\//i.test(q)) return true
	if (q.includes('@') || /\s/.test(q)) return false
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q)
}

function parsePublicHttpUrl(raw: string): URL | null {
	let s = raw.trim()
	if (!s) return null
	if (!/^https?:\/\//i.test(s)) s = `https://${s}`
	let u: URL
	try {
		u = new URL(s)
	} catch {
		return null
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
	if (u.username || u.password) return null
	if (hostnameBlocked(u.hostname)) return null
	return u
}

function apexHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '')
}

/** Delivery / review platforms — never treat as a merchant homepage. Not google.com. */
const MARKETPLACE_APEX_HOSTS = new Set([
	'ubereats.com',
	'doordash.com',
	'grubhub.com',
	'skipthedishes.com',
	'yelp.com',
	'tripadvisor.com',
	'opentable.com',
	'deliveroo.com',
	'just-eat.com',
	'justeat.com',
	'postmates.com',
	'seamless.com',
	'foodpanda.com',
	'wolt.com',
	'glovoapp.com',
	'menulog.com.au',
	'takeaway.com',
	'hungrypanda.co',
	'fantuanorder.com',
	'zomi.menu',
])

const MARKETPLACE_PLATFORM_LABEL: Record<string, string> = {
	'ubereats.com': 'Uber Eats',
	'doordash.com': 'DoorDash',
	'grubhub.com': 'Grubhub',
	'skipthedishes.com': 'SkipTheDishes',
	'yelp.com': 'Yelp',
	'tripadvisor.com': 'Tripadvisor',
	'opentable.com': 'OpenTable',
	'deliveroo.com': 'Deliveroo',
	'just-eat.com': 'Just Eat',
	'justeat.com': 'Just Eat',
	'postmates.com': 'Postmates',
	'seamless.com': 'Seamless',
	'foodpanda.com': 'foodpanda',
	'wolt.com': 'Wolt',
	'glovoapp.com': 'Glovo',
	'menulog.com.au': 'Menulog',
	'takeaway.com': 'Takeaway',
	'hungrypanda.co': 'HungryPanda',
	'fantuanorder.com': 'Fantuan',
	'zomi.menu': 'Zomi',
}

/** Path segments that are platform chrome, not a venue slug. Host-agnostic category tokens. */
const MARKETPLACE_GENERIC_PATH_SLUGS = new Set([
	'menu',
	'shop',
	'cart',
	'checkout',
	'search',
	'about',
	'login',
	'signup',
	'stores',
	'restaurants',
	'restaurant',
	'store',
	'cafe',
	'merchant',
	'venue',
	'listing',
	'takeaway',
	'pickup',
	'eatery',
	'bistro',
	'food',
	'delivery',
	'home',
	'index',
])

const LISTING_CATEGORY_CHROME = new Set([
	'restaurant',
	'store',
	'shop',
	'cafe',
	'menu',
	'merchant',
	'venue',
	'listing',
	'food',
	'delivery',
	'takeaway',
	'pickup',
	'eatery',
	'bistro',
])

/**
 * Opaque marketplace / CMS listing ids — not a human venue slug.
 * Matches `ca-1725834231`, UUIDs, long digit ids. Does not match
 * `coco-fresh-tea-juice`, `longdhang`, or `CoCo Richmond Center`.
 */
export function looksLikeOpaqueListingId(token: string): boolean {
	const t = token.trim().split(/[?#]/)[0] || ''
	if (!t) return false
	const raw = t.toLowerCase()
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true
	if (/^\d{6,}$/.test(raw)) return true
	if (/^(id|store|shop|venue|merchant|listing|item|place|loc|biz)[-_]?\d{3,}$/i.test(raw)) return true
	if (/^[a-z]{1,3}[-_]\d{6,}$/i.test(raw)) return true
	const letters = (raw.match(/[a-z]/g) || []).length
	const digits = (raw.match(/\d/g) || []).length
	if (digits >= 8 && letters <= 4) return true
	return false
}

/** Generic delivery-platform template blurbs, not a venue bio. */
export function looksLikeGenericMarketplaceSnippet(snippet: string): boolean {
	const s = snippet.replace(/\s+/g, ' ').trim()
	if (!s) return false
	if (/available for online delivery and pickup on\b/i.test(s)) return true
	if (/order online from a .{0,40} restaurant\.?$/i.test(s)) return true
	if (/^order (food )?online (for delivery|from)\b/i.test(s) && s.length < 90) return true
	if (/\b(online )?delivery and pickup\b/i.test(s) && /\bon\s+[A-Za-z]{3,}\b/.test(s) && s.length < 180) {
		return true
	}
	return false
}

function listingPathTokens(u: URL): string[] {
	return u.pathname
		.split('/')
		.filter(Boolean)
		.map((p) => {
			const raw = p.split(/[?#]/)[0] || ''
			try {
				return decodeURIComponent(raw)
			} catch {
				return raw
			}
		})
}

/** Host-agnostic: last path token is an opaque id and a category chrome segment is present. */
export function looksLikeOpaqueListingPageUrl(raw: string | URL): boolean {
	const u = typeof raw === 'string' ? parsePublicHttpUrl(raw) : raw
	if (!u) return false
	const parts = listingPathTokens(u)
	const last = parts[parts.length - 1] || ''
	if (!looksLikeOpaqueListingId(last)) return false
	return parts.some((p) => LISTING_CATEGORY_CHROME.has(p.toLowerCase()))
}

function isBareHomeWelcomeIndexTitle(name: string): boolean {
	return /^(home|homepage|welcome|index)$/i.test(name.trim())
}

/**
 * Platform-agnostic: this string is listing chrome, not a storefront name.
 * Does **not** treat bare Home / Welcome / Index as listing chrome (official sites).
 */
export function looksLikeNonVenueListingLabel(name: string, pageUrl?: string): boolean {
	const raw = name.replace(/\s+/g, ' ').trim()
	if (!raw) return true
	if (isBareHomeWelcomeIndexTitle(raw) || isBareHomeWelcomeIndexTitle(stripTitleSiteSuffix(raw))) return false
	const host = pageUrl ? parsePublicHttpUrl(pageUrl)?.hostname || '' : ''
	const apex = host ? marketplacePlatformApex(host) : null
	if (looksLikeMarketplacePlatformName(raw, apex)) return true
	const tokens = raw.split(/[\s|/]+/).filter(Boolean)
	if (tokens.length >= 2) {
		const last = tokens[tokens.length - 1] || ''
		const headFold = foldKey(tokens.slice(0, -1).join(' '))
		const firstFold = tokens[0].toLowerCase()
		if (
			(LISTING_CATEGORY_CHROME.has(headFold) || LISTING_CATEGORY_CHROME.has(firstFold)) &&
			looksLikeOpaqueListingId(last)
		) {
			return true
		}
	}
	if (looksLikeOpaqueListingId(raw.replace(/\s+/g, '-'))) return true
	if (pageUrl) {
		const u = parsePublicHttpUrl(pageUrl)
		if (u) {
			const parts = listingPathTokens(u)
			const last = parts[parts.length - 1] || ''
			const prev = parts[parts.length - 2] || ''
			if (looksLikeOpaqueListingId(last)) {
				const joined = `${prev} ${last}`.replace(/[-_]+/g, ' ')
				if (foldKey(raw) === foldKey(joined) || foldKey(raw) === foldKey(last)) return true
			}
		}
	}
	return false
}

/**
 * Weak marketplace listing scrape: platform brand, category+opaque id, or generic
 * delivery template. Readable shop slugs (longdhang, coco-fresh-tea-juice) are
 * **not** chrome — overlay must still recover the venue name.
 */
export function scrapeLooksLikeListingChrome(src: {
	url: string
	title: string
	description: string
	siteName: string
	jsonLdName: string
	visibleText?: string
}): boolean {
	const slug = shopListingSlug(src.url)
	if (slug && !looksLikeOpaqueListingId(slug)) return false
	const title = stripTitleSiteSuffix(src.title)
	if (
		title.length >= 2 &&
		!looksLikeNonVenueListingLabel(title, src.url) &&
		!isBareHomeWelcomeIndexTitle(title) &&
		!looksLikeMarketplacePlatformName(title)
	) {
		return false
	}
	if (looksLikeNonVenueListingLabel(title, src.url)) return true
	if (
		looksLikeNonVenueListingLabel(src.jsonLdName, src.url) &&
		looksLikeOpaqueListingPageUrl(src.url) &&
		(!title || looksLikeNonVenueListingLabel(title, src.url) || looksLikeMarketplacePlatformName(title))
	) {
		return true
	}
	const u = parsePublicHttpUrl(src.url)
	if (!u) return false
	const last = listingPathTokens(u).pop() || ''
	if (!looksLikeOpaqueListingId(last)) return false
	const weakTitle =
		!title || looksLikeNonVenueListingLabel(title, src.url) || looksLikeMarketplacePlatformName(title)
	const text = (src.visibleText || '').replace(/\s+/g, ' ').trim()
	const weakText = !text || text.length < 40 || looksLikeGenericMarketplaceSnippet(text)
	if (weakTitle && weakText) return true
	if (weakTitle && looksLikeGenericMarketplaceSnippet(src.description)) return true
	return false
}

export function isBlockedInterstitialHtml(html: string): boolean {
	return isStealthChallengeHtml(html)
}

function marketplacePlatformApex(host: string): string | null {
	const h = apexHost(host)
	for (const apex of MARKETPLACE_APEX_HOSTS) {
		if (h === apex || h.endsWith(`.${apex}`)) return apex
	}
	return null
}

export function isGoogleMapsListingUrl(u: URL): boolean {
	const h = apexHost(u.hostname)
	if (h === 'maps.app.goo.gl' || h === 'goo.gl' || h.endsWith('.app.goo.gl')) return true
	if (h === 'maps.google.com' || h.startsWith('maps.google.')) return true
	if (h === 'google.com' || /^google\.(ca|com|co\.uk|com\.au|de|fr|co\.jp)$/.test(h) || h.startsWith('google.')) {
		return /\/maps\/(place|search|dir)\b/i.test(u.pathname) || /\/place\//i.test(u.pathname)
	}
	return false
}

export function isMarketplaceListingUrl(raw: string | URL): boolean {
	const u = typeof raw === 'string' ? parsePublicHttpUrl(raw) : raw
	if (!u) return false
	if (isGoogleMapsListingUrl(u)) return true
	return marketplacePlatformApex(u.hostname) !== null
}

function titleCaseMarketplaceToken(token: string): string {
	if (token === '&' || token === '+') return token
	if (/^[a-z0-9]&[a-z0-9]$/i.test(token)) {
		return token
			.split('&')
			.map((p) => p.toUpperCase())
			.join('&')
	}
	return token.replace(/[A-Za-zÀ-ÿ]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

/** Decode listing slugs. Keep `&` and `+` in names such as A&S / Restro + Bar. */
export function humanizeMarketplaceSlug(raw: string): string {
	let s = raw.trim()
	try {
		s = decodeURIComponent(s)
	} catch {
		/* keep encoded */
	}
	s = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
	if (!s) return ''
	return s.split(' ').map(titleCaseMarketplaceToken).join(' ')
}

function humanizeGoogleMapsPlace(raw: string): string {
	let s = raw.trim()
	try {
		s = decodeURIComponent(s)
	} catch {
		/* keep */
	}
	s = s.replace(/\+/g, ' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
	if (!s) return ''
	return s.split(' ').map(titleCaseMarketplaceToken).join(' ')
}

function marketplaceSlugParts(u: URL): { slug: string; plusIsSpace: boolean } | null {
	const path = u.pathname
	if (isGoogleMapsListingUrl(u)) {
		const m = path.match(/\/place\/([^/]+)/i) || path.match(/\/search\/([^/]+)/i)
		const slug = m?.[1] ? m[1] : ''
		return slug ? { slug, plusIsSpace: true } : null
	}
	const apex = marketplacePlatformApex(u.hostname)
	if (!apex) return null
	let slug = ''
	if (apex === 'ubereats.com') {
		slug = path.match(/\/store\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'doordash.com') {
		slug = path.match(/\/store\/([^/]+)(?:\/|$)/i)?.[1] || path.match(/\/food-delivery\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'grubhub.com' || apex === 'seamless.com') {
		slug = path.match(/\/restaurant\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'skipthedishes.com') {
		slug = path.match(/\/restaurant\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'yelp.com') {
		slug = path.match(/\/biz\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'opentable.com') {
		slug = path.match(/\/r\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'deliveroo.com') {
		slug = path.match(/\/menu\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'just-eat.com' || apex === 'justeat.com' || apex === 'takeaway.com' || apex === 'menulog.com.au') {
		slug = path.match(/\/restaurants\/([^/]+)(?:\/|$)/i)?.[1] || path.match(/\/restaurant\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'foodpanda.com' || apex === 'wolt.com' || apex === 'glovoapp.com') {
		slug = path.match(/\/restaurant\/([^/]+)(?:\/|$)/i)?.[1] || path.match(/\/venue\/([^/]+)(?:\/|$)/i)?.[1] || ''
	} else if (apex === 'tripadvisor.com') {
		const m = path.match(/Reviews-([A-Za-z0-9_]+)-/i)
		slug = m?.[1] || ''
	} else if (apex === 'zomi.menu') {
		slug = path.match(/\/shop\/([^/]+)(?:\/|$)/i)?.[1] || ''
	}
	if (!slug) {
		slug = path.match(/\/shop\/([^/]+)(?:\/|$)/i)?.[1] || ''
	}
	if (slug && (MARKETPLACE_GENERIC_PATH_SLUGS.has(slug.toLowerCase()) || looksLikeOpaqueListingId(slug))) {
		slug = ''
	}
	if (!slug) {
		const parts = path.split('/').filter(Boolean)
		slug =
			[...parts]
				.reverse()
				.find(
					(p) =>
						/[a-z].*-.*[a-z]/i.test(p) &&
						p.length >= 4 &&
						!MARKETPLACE_GENERIC_PATH_SLUGS.has(p.toLowerCase()) &&
						!looksLikeOpaqueListingId(p),
				) || ''
	}
	if (slug && looksLikeOpaqueListingId(slug.split(/[?#]/)[0] || '')) slug = ''
	return slug ? { slug, plusIsSpace: false } : null
}

export function shopListingSlug(raw: string | URL): string {
	const u = typeof raw === 'string' ? parsePublicHttpUrl(raw) : raw
	if (!u) return ''
	const parts = marketplaceSlugParts(u)
	if (!parts?.slug) return ''
	const slug = parts.slug.split(/[?#]/)[0]?.toLowerCase() || ''
	if (!slug || MARKETPLACE_GENERIC_PATH_SLUGS.has(slug) || looksLikeOpaqueListingId(slug)) return ''
	return slug
}

export function marketplaceVenueName(raw: string | URL): string {
	const u = typeof raw === 'string' ? parsePublicHttpUrl(raw) : raw
	if (!u) return ''
	const parts = marketplaceSlugParts(u)
	if (!parts) return ''
	if (looksLikeOpaqueListingId(parts.slug.split(/[?#]/)[0] || '')) return ''
	const name = parts.plusIsSpace ? humanizeGoogleMapsPlace(parts.slug) : humanizeMarketplaceSlug(parts.slug)
	return name.length >= 2 ? name : ''
}

export function marketplaceVenueSearchQuery(raw: string | URL): string {
	const u = typeof raw === 'string' ? parsePublicHttpUrl(raw) : raw
	if (!u) return ''
	const name = marketplaceVenueName(u)
	if (!name) return ''
	const apex = marketplacePlatformApex(u.hostname)
	const platform = apex ? MARKETPLACE_PLATFORM_LABEL[apex] : isGoogleMapsListingUrl(u) ? 'Google Maps' : ''
	return platform ? `${name} listed on ${platform}` : name
}

export function discoverQueryFromWebsiteUrl(
	start: URL,
	originalQuery: string,
	listingSource?: Pick<PageSource, 'title' | 'description' | 'visibleText'>,
): string {
	const opaque = looksLikeOpaqueListingPageUrl(start)
	if (isMarketplaceListingUrl(start) || opaque) {
		const fromSlug = marketplaceVenueSearchQuery(start)
		if (fromSlug) return fromSlug
		const extra = listingSource
			? clip(listingSource.visibleText.replace(/\s+/g, ' ').trim().slice(0, 180), 180)
			: ''
		const extraUsable =
			extra &&
			!looksLikeGenericMarketplaceSnippet(extra) &&
			!looksLikeNonVenueListingLabel(extra, start.toString())
		const q = extraUsable ? `${originalQuery} ${extra}` : originalQuery
		return clip(q, DISCOVER_QUERY_MAX)
	}
	return originalQuery
}

function marketplaceCountryHint(u: URL): string {
	if (marketplacePlatformApex(u.hostname) !== 'ubereats.com') return ''
	const m = u.pathname.match(/^\/([a-z]{2})(?:\/|$)/i)
	if (!m) return ''
	return normalizeCountry(m[1])
}

function isSameApexHost(a: string, b: string): boolean {
	return apexHost(a) === apexHost(b)
}

function withWwwHost(u: URL): URL | null {
	const host = u.hostname.toLowerCase()
	if (host.startsWith('www.')) return null
	const next = new URL(u.toString())
	next.hostname = `www.${host}`
	return parsePublicHttpUrl(next.toString())
}

function websiteFetchStarts(start: URL): URL[] {
	const www = withWwwHost(start)
	return www ? [www, start] : [start]
}

function sameApexClaimedUrl(claimed: string, fetchedUrl: string): string {
	const c = parsePublicHttpUrl(claimed)
	const p = parsePublicHttpUrl(fetchedUrl)
	if (!p) return fetchedUrl
	if (!c) return fetchedUrl
	if (apexHost(c.hostname) !== apexHost(p.hostname)) return fetchedUrl
	return c.toString()
}

function urlKey(u: URL): string {
	const path = u.pathname.replace(/\/+$/, '') || '/'
	return `${apexHost(u.hostname)}${path}${u.search}`
}

async function assertPublicHost(url: URL): Promise<boolean> {
	if (hostnameBlocked(url.hostname)) return false
	if (net.isIP(url.hostname)) return !isBlockedIp(url.hostname)
	try {
		const records = await dns.lookup(url.hostname, { all: true, verbatim: true })
		if (!records.length) return false
		return records.every((r) => !isBlockedIp(r.address))
	} catch {
		return false
	}
}

function mapCharset(raw: string): string {
	const s = raw.trim().toLowerCase()
	if (!s || s === 'utf8' || s === 'utf-8') return 'utf-8'
	if (s === 'utf-16' || s === 'utf16') return 'utf-16le'
	if (s === 'gbk' || s === 'gb2312' || s === 'gb_2312-80') return 'gbk'
	if (s === 'gb18030') return 'gb18030'
	if (s === 'shift_jis' || s === 'shift-jis' || s === 'sjis' || s === 'windows-31j') return 'shift_jis'
	if (s === 'euc-jp' || s === 'eucjp') return 'euc-jp'
	if (s === 'euc-kr' || s === 'euckr') return 'euc-kr'
	if (s === 'big5' || s === 'big-5') return 'big5'
	if (s === 'iso-8859-1' || s === 'latin1' || s === 'latin-1') return 'iso-8859-1'
	if (s === 'windows-1252' || s === 'cp1252') return 'windows-1252'
	return s
}

function sniffCharset(headerCtype: string, buf: Buffer): string {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8'
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be'
	const fromHeader = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(headerCtype)?.[1]
	if (fromHeader) return mapCharset(fromHeader)
	const head = buf.subarray(0, Math.min(buf.length, 8_192)).toString('latin1')
	const meta =
		/<meta[^>]+charset=["']?([a-z0-9._-]+)/i.exec(head)?.[1] ||
		/<meta[^>]+http-equiv=["']content-type["'][^>]+content=["'][^"']*charset=([a-z0-9._-]+)/i.exec(head)?.[1] ||
		/<meta[^>]+content=["'][^"']*charset=([a-z0-9._-]+)[^"']*["'][^>]+http-equiv=["']content-type["']/i.exec(
			head,
		)?.[1]
	if (meta) return mapCharset(meta)
	return 'utf-8'
}

function decodeHtmlBytes(buf: Buffer, headerCtype: string): string {
	const enc = sniffCharset(headerCtype, buf)
	try {
		return new TextDecoder(enc).decode(buf)
	} catch {
		return buf.toString('utf8')
	}
}

function metaContent(html: string, key: string): string {
	const re = new RegExp(
		`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`,
		'i',
	)
	const re2 = new RegExp(
		`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`,
		'i',
	)
	const m = html.match(re) || html.match(re2)
	return decodeEntities(m?.[1] ?? '')
}

function titleTag(html: string): string {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
	return decodeEntities(m?.[1] ?? '')
}

function htmlLang(html: string, headerLang = ''): string {
	const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? ''
	const fromHtml = tagAttr(htmlTag, 'lang') || tagAttr(htmlTag, 'xml:lang')
	const httpEq =
		html.match(/<meta[^>]+http-equiv=["']content-language["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+http-equiv=["']content-language["']/i)?.[1] ??
		''
	const og = metaContent(html, 'og:locale')
	return clip(fromHtml || httpEq || headerLang || og, 16)
}

function tagAttr(tag: string, name: string): string {
	const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
	return m?.[1] ?? ''
}

function extractHreflang(html: string, base: string): { lang: string; href: string }[] {
	const out: { lang: string; href: string }[] = []
	const re = /<link\b[^>]*>/gi
	let m: RegExpExecArray | null
	while ((m = re.exec(html))) {
		const tag = m[0]
		if (!/\brel\s*=\s*["'][^"']*\balternate\b/i.test(tag)) continue
		const lang = tagAttr(tag, 'hreflang').trim()
		const href = tagAttr(tag, 'href').trim()
		if (!lang || !href) continue
		try {
			out.push({ lang, href: new URL(href, base).toString() })
		} catch {
			/* ignore bad href */
		}
	}
	return out
}

function pickAlternateLangUrls(html: string, pageUrl: string, max: number): URL[] {
	if (max <= 0) return []
	let primary: URL
	try {
		primary = new URL(pageUrl)
	} catch {
		return []
	}
	const seen = new Set([urlKey(primary)])
	const picked: URL[] = []
	const consider = (rawHref: string) => {
		if (picked.length >= max) return
		const u = parsePublicHttpUrl(rawHref)
		if (!u) return
		if (!isSameApexHost(u.hostname, primary.hostname)) return
		const key = urlKey(u)
		if (seen.has(key)) return
		seen.add(key)
		picked.push(u)
	}
	const links = extractHreflang(html, pageUrl)
	for (const l of links) {
		if (/^en\b/i.test(l.lang)) consider(l.href)
	}
	if (picked.length < max) {
		const xd = links.find((l) => /^x-default$/i.test(l.lang))
		if (xd) consider(xd.href)
	}
	return picked
}

function extractVisibleText(html: string, max: number): string {
	const stripped = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
	return clip(decodeEntities(stripped), max)
}

type ScrapeMeta = {
	finalUrl: string
	title: string
	description: string
	siteName: string
	jsonLdName: string
	city: string
	province: string
	country: string
	street: string
	phone: string
	email: string
	postalCode: string
}

type JsonLdAcc = {
	name: string
	desc: string
	city: string
	region: string
	country: string
	url: string
	street: string
	phone: string
	email: string
	postalCode: string
}

function emptyContact(): { street: string; phone: string; email: string; postalCode: string } {
	return { street: '', phone: '', email: '', postalCode: '' }
}

function jsonLdText(value: unknown): string {
	if (typeof value === 'string') return value.trim()
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	if (Array.isArray(value)) {
		for (const item of value) {
			const t = jsonLdText(item)
			if (t) return t
		}
		return ''
	}
	if (value && typeof value === 'object') {
		const o = value as Record<string, unknown>
		return jsonLdText(o.name) || jsonLdText(o.text) || jsonLdText(o['@value']) || ''
	}
	return ''
}

function takePostalAddress(addr: unknown, acc: JsonLdAcc): void {
	if (!addr) return
	if (Array.isArray(addr)) {
		for (const item of addr) takePostalAddress(item, acc)
		return
	}
	if (typeof addr === 'string') {
		if (!acc.street) acc.street = addr.trim()
		return
	}
	if (typeof addr !== 'object') return
	const a = addr as Record<string, unknown>
	if (!acc.street) acc.street = jsonLdText(a.streetAddress)
	if (!acc.city) acc.city = jsonLdText(a.addressLocality)
	if (!acc.region) acc.region = jsonLdText(a.addressRegion)
	if (!acc.country) acc.country = jsonLdText(a.addressCountry)
	if (!acc.postalCode) acc.postalCode = jsonLdText(a.postalCode)
	if (!acc.phone) acc.phone = jsonLdText(a.telephone)
}

function walkJsonLd(node: unknown, acc: JsonLdAcc): void {
	if (!node) return
	if (Array.isArray(node)) {
		for (const item of node) walkJsonLd(item, acc)
		return
	}
	if (typeof node !== 'object') return
	const o = node as Record<string, unknown>
	if (Array.isArray(o['@graph'])) walkJsonLd(o['@graph'], acc)
	const types = o['@type']
	const typeStr = Array.isArray(types) ? types.map(String).join(' ') : String(types ?? '')
	const isBiz = /organization|localbusiness|restaurant|store|cafe|brand|place/i.test(typeStr)
	if (isBiz || !acc.name) {
		if (!acc.name) acc.name = jsonLdText(o.name)
		if (!acc.desc) acc.desc = jsonLdText(o.description)
		if (!acc.url) acc.url = jsonLdText(o.url)
	}
	if (!acc.phone) acc.phone = jsonLdText(o.telephone)
	if (!acc.email) acc.email = jsonLdText(o.email)
	takePostalAddress(o.address, acc)
	if (o.location) walkJsonLd(o.location, acc)
	if (o.contactPoint) walkJsonLd(o.contactPoint, acc)
}

type BrandingImageKind = 'logo' | 'og' | 'hero' | 'other'
type RawBrandingImage = { href: string; kind: BrandingImageKind; weak?: boolean }
type ScrapedBrandingImage = { url: string; kind: BrandingImageKind; weak?: boolean }

function jsonLdMediaHref(value: unknown): string {
	if (typeof value === 'string') return value.trim()
	if (!value || typeof value !== 'object') return ''
	const o = value as Record<string, unknown>
	if (typeof o.url === 'string') return o.url.trim()
	if (typeof o.contentUrl === 'string') return o.contentUrl.trim()
	return ''
}

function walkJsonLdImages(node: unknown, acc: RawBrandingImage[]): void {
	if (!node || acc.length >= MAX_RAW_BRANDING) return
	if (Array.isArray(node)) {
		for (const item of node) walkJsonLdImages(item, acc)
		return
	}
	if (typeof node !== 'object') return
	const o = node as Record<string, unknown>
	if (Array.isArray(o['@graph'])) walkJsonLdImages(o['@graph'], acc)
	const push = (raw: unknown, kind: BrandingImageKind) => {
		if (acc.length >= MAX_RAW_BRANDING) return
		if (Array.isArray(raw)) {
			for (const item of raw) push(item, kind)
			return
		}
		const href = jsonLdMediaHref(raw)
		if (href) acc.push({ href, kind })
	}
	push(o.logo, 'logo')
	push(o.image, 'og')
}

function brandingScore(i: { kind: BrandingImageKind; weak?: boolean }): number {
	if (i.kind === 'logo' && !i.weak) return 50
	if (i.kind === 'hero') return 40
	if (i.kind === 'og') return 30
	if (i.kind === 'logo' && i.weak) return 12
	return 8
}

function mergeRawBranding(list: RawBrandingImage[]): RawBrandingImage[] {
	const map = new Map<string, RawBrandingImage>()
	for (const item of list) {
		const k = item.href.trim().toLowerCase()
		if (!k) continue
		const prev = map.get(k)
		if (!prev || brandingScore(item) > brandingScore(prev)) map.set(k, item)
	}
	return [...map.values()].sort((a, b) => brandingScore(b) - brandingScore(a)).slice(0, MAX_RAW_BRANDING)
}

function firstSrcsetUrl(srcset: string): string {
	const t = srcset.trim()
	if (!t) return ''
	let best = ''
	let bestW = -1
	for (const part of t.split(',')) {
		const bits = part.trim().split(/\s+/)
		if (!bits[0]) continue
		const wm = bits[1]?.match(/^(\d+)w$/i)
		const w = wm ? Number(wm[1]) : 0
		if (w >= bestW) {
			bestW = w
			best = bits[0]
		}
	}
	return best
}

function isJunkImageUrl(href: string, alt = '', width = '', height = ''): boolean {
	const h = href.toLowerCase()
	if (
		/wp-includes\/(?:js\/)?(?:tinymce|.*emoji)|wp-emoji|smilies|wlwmanifest|gravatar\.com\/avatar\/0+|doubleclick|facebook\.com\/tr|google-analytics|pixel\.gif|spacer\.gif|1x1|tracking[-_]?pixel|googletagmanager/.test(
			h,
		)
	) {
		return true
	}
	if (width === '1' && height === '1') return true
	if (/\b(blank|spacer|pixel)\b/.test(alt.toLowerCase()) && /pixel|1x1|spacer/.test(h)) return true
	return false
}

function classifyImageHint(href: string, alt = ''): { kind: BrandingImageKind; weak?: boolean } {
	const hay = `${href} ${alt}`.toLowerCase()
	if (/\b(favicon|apple-touch-icon|mstile|android-chrome|safari-pinned)\b/.test(hay)) {
		return { kind: 'logo', weak: true }
	}
	if (/\b(logo|wordmark|logomark|brandmark)\b/.test(hay)) return { kind: 'logo' }
	if (/\b(banner|hero|cover|slideshow|slide|og-image|opengraph)\b/.test(hay)) return { kind: 'hero' }
	return { kind: 'other' }
}

function collectCssHttpsUrls(html: string): string[] {
	const out: string[] = []
	const re = /url\(\s*(['"]?)((?:https:)?\/\/[^)'"\s]+)\1\s*\)/gi
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) && out.length < 16) {
		out.push(m[2])
	}
	return out
}

function collectBodyImageHrefs(html: string): RawBrandingImage[] {
	const out: RawBrandingImage[] = []
	const re = /<(?:img|source)\b[^>]*>/gi
	let m: RegExpExecArray | null
	let n = 0
	while ((m = re.exec(html)) && n < 80) {
		n += 1
		const tag = m[0]
		const alt = tagAttr(tag, 'alt')
		const w = tagAttr(tag, 'width')
		const h = tagAttr(tag, 'height')
		const hrefs = [
			tagAttr(tag, 'src'),
			tagAttr(tag, 'data-src'),
			tagAttr(tag, 'data-lazy-src'),
			tagAttr(tag, 'data-original'),
			firstSrcsetUrl(tagAttr(tag, 'srcset') || tagAttr(tag, 'data-srcset')),
		].filter(Boolean)
		for (const href of hrefs) {
			if (isJunkImageUrl(href, alt, w, h)) continue
			const hint = classifyImageHint(href, alt)
			const wNum = Number(w)
			const hNum = Number(h)
			if (
				hint.kind === 'other' &&
				Number.isFinite(wNum) &&
				Number.isFinite(hNum) &&
				wNum >= 800 &&
				hNum >= 240 &&
				wNum > hNum
			) {
				hint.kind = 'hero'
			}
			out.push({ href, kind: hint.kind, weak: hint.weak })
		}
	}
	for (const href of collectCssHttpsUrls(html)) {
		if (isJunkImageUrl(href)) continue
		const hint = classifyImageHint(href)
		out.push({ href, kind: hint.kind, weak: hint.weak })
	}
	return out
}

function brandingAllowLabel(i: ScrapedBrandingImage): string {
	if (i.kind === 'logo' && i.weak) return 'weak favicon'
	if (i.kind === 'logo') return 'logo'
	if (i.kind === 'hero') return 'hero'
	if (i.kind === 'og') return 'og'
	return 'other'
}

function brandingNameTokens(name: string, website: string): string[] {
	let host = ''
	try {
		host = new URL(website).hostname.replace(/^www\./i, '').replace(/\./g, ' ')
	} catch {
		host = ''
	}
	const raw = `${name} ${host}`.toLowerCase()
	return [...new Set(raw.split(/[^a-z0-9]+/).filter((t) => t.length >= 4))]
}

function logoMatchesBusiness(url: string, tokens: string[]): boolean {
	if (!url || !tokens.length) return false
	const hay = url.toLowerCase()
	return tokens.some((t) => hay.includes(t))
}

function demoteUnmatchedLogos(
	images: ScrapedBrandingImage[],
	name: string,
	website: string,
): ScrapedBrandingImage[] {
	const tokens = brandingNameTokens(name, website)
	if (!tokens.length) return images
	return images.map((i) => {
		if (i.kind === 'logo' && !i.weak && !logoMatchesBusiness(i.url, tokens)) {
			return { ...i, kind: 'other' as const }
		}
		return i
	})
}

function pickStrongLogoUrl(images: ScrapedBrandingImage[], name = '', website = ''): string {
	const strong = images.filter((i) => i.kind === 'logo' && !i.weak)
	if (!strong.length) return ''
	const tokens = brandingNameTokens(name, website)
	if (tokens.length) {
		return strong.find((i) => logoMatchesBusiness(i.url, tokens))?.url || ''
	}
	return strong[0].url
}

/** `Place` is omitted: it matches English “this place” in reviews. `Pl` still covers “Main Pl,”. */
const STREET_RE =
	/(?:\d+\s*\/\s*[A-Za-z]\s*,\s*)?\d{2,6}\s+(?:[A-Za-z][\w.'-]*\s+){0,5}(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Way|Lane|Ln|Crt|Court|Pl|Cres|Crescent|Hwy|Highway)\b(?:\s*,?\s*(?:Suite|Ste|Unit|#)\s*#?\s*[A-Za-z0-9-]+)?(?:\s*,\s*[A-Za-z][\w.'-]+(?:\s+[A-Za-z][\w.'-]*){0,2}\s*,\s*[A-Z]{2}(?:\s*,?\s*[A-Z]\d[A-Z]\s?\d[A-Z]\d)?)?/gi
const PHONE_RE = /(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}\b/g
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const POSTAL_RE = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/gi
const CONTACT_VISIBLE_MAX = 120_000

function streetLookalikeScore(raw: string): number {
	const s = raw.replace(/\s+/g, ' ').trim()
	if (!s) return -1
	if (/\b(this|best|love|our|the)\s+place\b/i.test(s)) return -1
	let n = 0
	if (POSTAL_RE.test(s)) n += 5
	POSTAL_RE.lastIndex = 0
	if (/,\s*[A-Z]{2}\b/.test(s)) n += 3
	if (/^\d+\s*\/\s*[A-Za-z]\s*,/.test(s)) n += 2
	if (/\b(?:Rd|Road|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive)\b/i.test(s)) n += 2
	if (/,/.test(s)) n += 1
	return n
}

function pickBestStreet(text: string): { street: string; index: number } {
	let best = { street: '', index: -1, score: -1 }
	for (const m of text.matchAll(STREET_RE)) {
		const raw = (m[0] || '').replace(/\s+/g, ' ').trim()
		const score = streetLookalikeScore(raw)
		if (score < 0) continue
		const idx = m.index ?? -1
		if (score > best.score || (score === best.score && idx > best.index)) {
			best = { street: raw, index: idx, score }
		}
	}
	STREET_RE.lastIndex = 0
	return { street: best.street, index: best.index }
}

function pickNearestPhone(text: string, around: number): string {
	const hits = [...text.matchAll(PHONE_RE)]
	PHONE_RE.lastIndex = 0
	if (!hits.length) return ''
	if (around < 0) return normalizePhone(hits[0][0] || '')
	let best = hits[0]
	let bestDist = Infinity
	for (const m of hits) {
		const idx = m.index ?? 0
		const dist = Math.abs(idx - around)
		if (dist < bestDist) {
			best = m
			bestDist = dist
		}
	}
	return normalizePhone(best[0] || '')
}

function normalizePhone(raw: string): string {
	return clip(raw.trim().replace(/^tel:/i, '').replace(/\s+/g, ' '), 40)
}

function normalizeEmail(raw: string): string {
	const s = raw.trim().replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase()
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return ''
	if (/example\.|sentry|wixpress|cloudflare|wordpress/.test(s)) return ''
	return clip(s, 80)
}

function decodeMaybe(raw: string): string {
	try {
		return decodeURIComponent(raw)
	} catch {
		return raw
	}
}

function extractHrefContacts(html: string): { phone: string; email: string } {
	const tel = html.match(/href\s*=\s*["']\s*tel:([^"']+)["']/i)
	const mail = html.match(/href\s*=\s*["']\s*mailto:([^"'?]+)["'?]/i)
	return {
		phone: tel ? normalizePhone(decodeMaybe(tel[1])) : '',
		email: mail ? normalizeEmail(decodeMaybe(mail[1])) : '',
	}
}

function extractVisibleContactText(html: string, max: number): string {
	// Contact blocks are commonly rendered in the footer, after a large
	// product/app markup section. Preserve both ends of the visible document
	// instead of clipping only the beginning.
	const withBreaks = html.replace(/<br\s*\/?>/gi, ', ')
	const stripped = withBreaks
		.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
	const text = decodeEntities(stripped).replace(/\s+/g, ' ').trim()
	if (text.length <= max) return text
	const tailBudget = Math.floor(max * 0.65)
	const headBudget = max - tailBudget
	return `${text.slice(0, headBudget)} ${text.slice(-tailBudget)}`
}

export function extractVisibleContact(html: string): {
	street: string
	phone: string
	email: string
	postalCode: string
} {
	const text = extractVisibleContactText(html, CONTACT_VISIBLE_MAX)
	const { street, index } = pickBestStreet(text)
	const emailM = text.match(EMAIL_RE)
	EMAIL_RE.lastIndex = 0
	const postalFromStreet = street.match(POSTAL_RE)
	POSTAL_RE.lastIndex = 0
	const postalM = postalFromStreet || text.match(POSTAL_RE)
	POSTAL_RE.lastIndex = 0
	return {
		street: clip(street, 160),
		phone: pickNearestPhone(text, index),
		email: emailM ? normalizeEmail(emailM[0]) : '',
		postalCode: clip((postalM?.[0] || '').toUpperCase().replace(/\s+/g, ' '), 12),
	}
}

function normalizeBrandHex(raw: string): string {
	const s = raw.trim()
	const m6 = s.match(/^#?([0-9a-fA-F]{6})$/)
	if (m6) return `#${m6[1].toUpperCase()}`
	const m3 = s.match(/^#?([0-9a-fA-F]{3})$/)
	if (m3) {
		const [a, b, c] = m3[1]
		return `#${a}${a}${b}${b}${c}${c}`.toUpperCase()
	}
	const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
	if (rgb) {
		const hex = [rgb[1], rgb[2], rgb[3]]
			.map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0'))
			.join('')
		return `#${hex.toUpperCase()}`
	}
	return ''
}

async function parseHttpsImageUrl(raw: string, pageUrl: string): Promise<string> {
	let s = raw.trim()
	if (!s || /^data:|^blob:/i.test(s)) return ''
	if (s.startsWith('//')) s = `https:${s}`
	let resolved: URL
	try {
		resolved = new URL(s, pageUrl)
	} catch {
		return ''
	}
	if (resolved.protocol !== 'https:') return ''
	if (resolved.username || resolved.password) return ''
	if (hostnameBlocked(resolved.hostname)) return ''
	if (!(await assertPublicHost(resolved))) return ''
	resolved.hash = ''
	return resolved.toString()
}

function collectRawBrandingImages(html: string): RawBrandingImage[] {
	const out: RawBrandingImage[] = []
	const og = metaContent(html, 'og:image') || metaContent(html, 'og:image:url')
	if (og) out.push({ href: og, kind: 'og' })
	const tw = metaContent(html, 'twitter:image') || metaContent(html, 'twitter:image:src')
	if (tw) out.push({ href: tw, kind: 'og' })
	const tile = metaContent(html, 'msapplication-TileImage')
	if (tile) out.push({ href: tile, kind: 'other' })
	const re = /<link\b[^>]*>/gi
	let m: RegExpExecArray | null
	while ((m = re.exec(html))) {
		const tag = m[0]
		const rel = tagAttr(tag, 'rel').toLowerCase()
		if (!/\b(apple-touch-icon|shortcut\s+icon|mask-icon|icon)\b/.test(rel)) continue
		if (/\bstylesheet\b/.test(rel)) continue
		const href = tagAttr(tag, 'href').trim()
		if (href) out.push({ href, kind: 'logo', weak: true })
	}
	const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []
	for (const block of ldBlocks) {
		const body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
		try {
			walkJsonLdImages(JSON.parse(body), out)
		} catch {
			/* ignore malformed json-ld */
		}
	}
	out.push(...collectBodyImageHrefs(html))
	return mergeRawBranding(out)
}

async function extractPageBranding(
	html: string,
	pageUrl: string,
): Promise<{ images: ScrapedBrandingImage[]; themeColors: string[] }> {
	const byKey = new Map<string, ScrapedBrandingImage>()
	for (const raw of collectRawBrandingImages(html)) {
		const url = await parseHttpsImageUrl(raw.href, pageUrl)
		if (!url) continue
		const k = urlKey(new URL(url))
		const item: ScrapedBrandingImage = { url, kind: raw.kind, weak: raw.weak }
		const prev = byKey.get(k)
		if (!prev || brandingScore(item) > brandingScore(prev)) byKey.set(k, item)
	}
	const images = [...byKey.values()]
		.sort((a, b) => brandingScore(b) - brandingScore(a))
		.slice(0, MAX_BRANDING_IMAGES)
	const themeColors: string[] = []
	const theme = normalizeBrandHex(metaContent(html, 'theme-color'))
	if (theme) themeColors.push(theme)
	const tileColor = normalizeBrandHex(metaContent(html, 'msapplication-TileColor'))
	if (tileColor && !themeColors.includes(tileColor)) themeColors.push(tileColor)
	return { images, themeColors }
}

function pickAllowlistedImageUrl(raw: string, allow: { url: string; key: string }[]): string {
	const s = raw.trim()
	if (!s || !allow.length) return ''
	let parsed: URL
	try {
		parsed = new URL(s)
	} catch {
		return ''
	}
	if (parsed.protocol !== 'https:') return ''
	const k = urlKey(parsed)
	return allow.find((a) => a.key === k)?.url ?? ''
}

function isWeakLogoUrl(url: string, images: ScrapedBrandingImage[]): boolean {
	if (!url) return false
	return images.some((i) => i.url === url && i.kind === 'logo' && Boolean(i.weak))
}

function scrapeFallbackAssets(
	images: ScrapedBrandingImage[],
	themeColors: string[],
	publicBio: string,
	snippet: string,
	name = '',
	website = '',
): OnboardingCardSetupAssets {
	const logoUrl = pickStrongLogoUrl(images, name, website)
	const backgroundUrl =
		images.find((i) => i.url !== logoUrl && (i.kind === 'hero' || i.kind === 'og'))?.url ||
		images.find((i) => i.url !== logoUrl && i.kind !== 'logo')?.url ||
		''
	return {
		logoUrl,
		backgroundUrl,
		brandColor: themeColors[0] || '',
		discoverCopy: clip(publicBio || snippet, CARD_SETUP_DISCOVER_COPY_MAX),
	}
}

async function scrapeWebsiteBranding(website: string): Promise<{
	images: ScrapedBrandingImage[]
	themeColors: string[]
}> {
	const start = parsePublicHttpUrl(website)
	if (!start || start.protocol !== 'https:') return { images: [], themeColors: [] }
	for (const u of websiteFetchStarts(start)) {
		const fetched = await fetchHtmlSafe(u, MAX_REDIRECTS, apexHost(u.hostname))
		if (fetched) return extractPageBranding(fetched.html, fetched.url)
	}
	return { images: [], themeColors: [] }
}

function parseHtmlMeta(html: string, pageUrl: string): ScrapeMeta {
	const acc: JsonLdAcc = {
		name: '',
		desc: '',
		city: '',
		region: '',
		country: '',
		url: '',
		street: '',
		phone: '',
		email: '',
		postalCode: '',
	}
	const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []
	for (const block of ldBlocks) {
		const body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
		try {
			walkJsonLd(JSON.parse(body), acc)
		} catch {
			/* ignore malformed json-ld */
		}
	}
	const href = extractHrefContacts(html)
	const vis = extractVisibleContact(html)
	const ogTitle = metaContent(html, 'og:title')
	const ogDesc = metaContent(html, 'og:description')
	const ogUrl = metaContent(html, 'og:url')
	const ogSite = metaContent(html, 'og:site_name')
	const title = acc.name || ogTitle || titleTag(html) || ogSite
	const street = clip(acc.street || vis.street, 160)
	const fromStreet = locationFromStreet(street)
	return {
		finalUrl: acc.url || ogUrl || pageUrl,
		title: clip(title, 120),
		description: clip(acc.desc || ogDesc, 280),
		siteName: clip(ogSite, 80),
		jsonLdName: clip(acc.name, 120),
		city: clip(acc.city || fromStreet.city, 80),
		province: clip(acc.region || fromStreet.province, 80),
		country: clip(acc.country, 40),
		street,
		phone: clip(acc.phone || href.phone || vis.phone, 40),
		email: clip(acc.email || href.email || vis.email, 80),
		postalCode: clip(acc.postalCode || vis.postalCode, 12),
	}
}

function locationFromStreet(street: string): { city: string; province: string } {
	const m = street.match(
		/,\s*([A-Za-z][\w.'-]+(?:\s+[A-Za-z][\w.'-]*){0,2})\s*,\s*([A-Z]{2})\b/,
	)
	if (!m) return { city: '', province: '' }
	return { city: clip(m[1], 80), province: m[2] }
}

function htmlToPageSource(
	html: string,
	pageUrl: string,
	visibleBudget: number,
	headerLang = '',
): PageSource {
	const meta = parseHtmlMeta(html, pageUrl)
	return {
		url: sameApexClaimedUrl(meta.finalUrl, pageUrl),
		lang: htmlLang(html, headerLang),
		title: meta.title,
		description: meta.description,
		siteName: meta.siteName,
		jsonLdName: meta.jsonLdName,
		city: meta.city,
		province: meta.province,
		country: meta.country,
		street: meta.street,
		phone: meta.phone,
		email: meta.email,
		postalCode: meta.postalCode,
		visibleText: extractVisibleText(html, visibleBudget),
	}
}

export function isUnusableScrapeSource(src: Pick<PageSource, 'url' | 'title' | 'siteName' | 'visibleText'>): boolean {
	if (isBlockedInterstitialHtml(`${src.title}\n${src.siteName}\n${src.visibleText.slice(0, 800)}`)) return true
	if (/just a moment/i.test(src.title)) return true
	return false
}

function shouldEscalateHttpStatus(status: number): boolean {
	if (status === 400 || status === 404 || status === 410) return false
	if (status === 401 || status === 403 || status === 407 || status === 429) return true
	if (status >= 500 && status <= 599) return true
	return false
}

async function fetchViaStealthIfAllowed(
	start: URL,
	stayApex: string,
	allowStealth: boolean,
): Promise<{ url: string; html: string; contentLang: string } | null> {
	if (!allowStealth) return null
	const got = await fetchHtmlViaStealthBrowser(start.toString())
	if (!got?.html) return null
	let final: URL
	try {
		final = new URL(got.url)
	} catch {
		return null
	}
	if (stayApex && apexHost(final.hostname) !== stayApex) return null
	if (isBlockedInterstitialHtml(got.html)) return null
	return {
		url: got.url,
		html: got.html,
		contentLang: got.contentLang || '',
	}
}

async function fetchHtmlSafe(
	start: URL,
	hopsLeft: number,
	stayApex = '',
	opts?: { allowStealth?: boolean },
): Promise<{ url: string; html: string; contentLang: string } | null> {
	if (hopsLeft < 0) return null
	const apex = stayApex || apexHost(start.hostname)
	if (!(await assertPublicHost(start))) return null
	const allowStealth = opts?.allowStealth !== false
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
	let escalate = false
	try {
		const res = await fetch(start.toString(), {
			method: 'GET',
			redirect: 'manual',
			signal: ac.signal,
			headers: {
				Accept: 'text/html,application/xhtml+xml',
				'Accept-Language': ACCEPT_LANGUAGE,
				'User-Agent': USER_AGENT,
			},
		})
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location')
			if (!loc) return null
			const next = parsePublicHttpUrl(new URL(loc, start).toString())
			if (!next) return null
			if (apexHost(next.hostname) !== apex) return null
			return fetchHtmlSafe(next, hopsLeft - 1, apex, opts)
		}
		if (!res.ok) {
			escalate = shouldEscalateHttpStatus(res.status)
			if (!escalate) return null
		} else {
			const ctype = (res.headers.get('content-type') || '').toLowerCase()
			if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) return null
			const buf = Buffer.from(await res.arrayBuffer())
			if (buf.length > MAX_HTML_BYTES) return null
			const html = decodeHtmlBytes(buf, ctype)
			if (isBlockedInterstitialHtml(html)) {
				escalate = true
			} else {
				return {
					url: start.toString(),
					html,
					contentLang: (res.headers.get('content-language') || '').trim(),
				}
			}
		}
	} catch {
		escalate = true
	} finally {
		clearTimeout(timer)
	}
	if (!escalate) return null
	return fetchViaStealthIfAllowed(start, apex, allowStealth)
}

async function collectPageSources(start: URL, maxExtraLang: number): Promise<PageSource[]> {
	const stay = apexHost(start.hostname)
	const fetched = await fetchHtmlSafe(start, MAX_REDIRECTS, stay)
	if (!fetched) return []
	const primary = htmlToPageSource(
		fetched.html,
		fetched.url,
		Math.min(VISIBLE_PER_PAGE, VISIBLE_TOTAL),
		fetched.contentLang,
	)
	if (isUnusableScrapeSource(primary)) return []
	const extras = pickAlternateLangUrls(fetched.html, fetched.url, maxExtraLang)
	const extraPages = await Promise.all(
		extras.map((u) => fetchHtmlSafe(u, MAX_REDIRECTS, stay, { allowStealth: false })),
	)
	const sources = [primary]
	let used = primary.visibleText.length
	for (const extra of extraPages) {
		if (!extra) continue
		const budget = Math.min(VISIBLE_PER_PAGE, VISIBLE_TOTAL - used)
		if (budget < 200) break
		const page = htmlToPageSource(extra.html, extra.url, budget, extra.contentLang)
		if (isUnusableScrapeSource(page)) continue
		sources.push(page)
		used += page.visibleText.length
	}
	return sources
}

async function collectWebsitePageSources(start: URL, maxExtraLang: number): Promise<PageSource[]> {
	for (const u of websiteFetchStarts(start)) {
		const pages = await collectPageSources(u, maxExtraLang)
		if (pages.length) return pages.filter((s) => !isUnusableScrapeSource(s))
	}
	return []
}

async function discoverOfficialSitesFromQuery(
	query: string,
	extraLang: number,
): Promise<{ discovered: DiscoveredBusiness[]; discoverFailed: boolean; sources: PageSource[] }> {
	let discovered: DiscoveredBusiness[] = []
	let discoverFailed = false
	try {
		const discover = await askGeminiDiscover(query)
		discoverFailed = discover.failed
		discovered = discover.list
	} catch (e) {
		discoverFailed = true
		logger(Colors.yellow('[onboardingBusinessLookup] Gemini discover:'), (e as Error)?.message ?? e)
	}
	const urls = uniquePublicWebsites(
		discovered.map((d) => d.website).filter(Boolean),
		MAX_NAME_SITES,
	)
	const batches = await Promise.all(urls.map((u) => collectWebsitePageSources(u, extraLang)))
	const sources = batches.flat().filter((s) => !isUnusableScrapeSource(s))
	return { discovered, discoverFailed, sources }
}

export function scrapeNeedsOfficialDiscoverHop(sources: PageSource[]): boolean {
	if (!sources.length) return true
	return scrapeLooksLikeListingChrome(sources[0])
}

/** Prefer official (non-marketplace, non-chrome) hop pages as sources[0]. */
export function mergeDiscoverHopSources(listing: PageSource[], hop: PageSource[]): PageSource[] {
	const usable = (s: PageSource) => !isUnusableScrapeSource(s)
	const isOfficial = (s: PageSource) =>
		usable(s) &&
		!isMarketplaceListingUrl(s.url) &&
		!looksLikeOpaqueListingPageUrl(s.url) &&
		!scrapeLooksLikeListingChrome(s)
	const official = hop.filter(isOfficial)
	const restListing = listing.filter(usable)
	const restHop = hop.filter((s) => usable(s) && !isOfficial(s))
	const seen = new Set<string>()
	const out: PageSource[] = []
	for (const s of [...official, ...restListing, ...restHop]) {
		const k = s.url.toLowerCase()
		if (seen.has(k)) continue
		seen.add(k)
		out.push(s)
	}
	return out
}

async function scrapeWebsiteThenMaybeDiscover(
	start: URL,
	originalQuery: string,
): Promise<{ sources: PageSource[]; discovered: DiscoveredBusiness[]; discoverFailed: boolean }> {
	const sources = await collectWebsitePageSources(start, MAX_EXTRA_LANG_URL)
	if (!scrapeNeedsOfficialDiscoverHop(sources)) {
		return { sources, discovered: [], discoverFailed: false }
	}
	const dq = discoverQueryFromWebsiteUrl(start, originalQuery, sources[0])
	const hop = await discoverOfficialSitesFromQuery(dq, MAX_EXTRA_LANG_NAME)
	return {
		sources: mergeDiscoverHopSources(sources, hop.sources),
		discovered: hop.discovered,
		discoverFailed: hop.discoverFailed,
	}
}

export function normalizeCountry(raw: string): string {
	return normalizeOnboardingCountryCode(raw)
}

export function normalizeProvince(country: string, raw: string): string {
	if (!country) return ''
	const t = raw.trim()
	if (!t || /^unknown$/i.test(t)) return ''
	const regions = REGIONS_BY_COUNTRY[country]
	if (!regions?.length) return clip(t, 80)
	const upper = t.toUpperCase()
	if (regions.some((r) => r.value === upper)) return upper
	const f = foldKey(t)
	const byLabel = regions.find((r) => foldKey(r.label) === f || foldKey(r.value) === f)
	if (byLabel) return byLabel.value
	const extras = EXTRA_PROVINCE_ALIASES[country]
	if (extras) {
		for (const [alias, code] of Object.entries(extras)) {
			if (foldKey(alias) === f) return code
		}
	}
	return ''
}

function catsForChannel(kind: ChannelKind | ''): readonly string[] {
	if (kind === 'digital') return DIGITAL_CATS
	if (kind === 'app') return APP_CATS
	if (kind === 'physical') return PHYSICAL_CATS
	return [...PHYSICAL_CATS, ...DIGITAL_CATS, ...APP_CATS]
}

const CATEGORY_ALIASES: Record<string, string> = {
	cafe: 'food-beverage',
	coffee: 'food-beverage',
	restaurant: 'food-beverage',
	food: 'food-beverage',
	'food & beverage': 'food-beverage',
	shanghainese: 'food-beverage',
	noodle: 'food-beverage',
	noodles: 'food-beverage',
	cuisine: 'food-beverage',
	eatery: 'food-beverage',
	bistro: 'food-beverage',
	diner: 'food-beverage',
	bakery: 'food-beverage',
	咖啡: 'food-beverage',
	餐厅: 'food-beverage',
	餐廳: 'food-beverage',
	餐饮: 'food-beverage',
	餐飲: 'food-beverage',
	美食: 'food-beverage',
	面馆: 'food-beverage',
	麵館: 'food-beverage',
	饭店: 'food-beverage',
	飯店: 'food-beverage',
	餐馆: 'food-beverage',
	餐館: 'food-beverage',
	酒楼: 'food-beverage',
	酒樓: 'food-beverage',
	茶馆: 'food-beverage',
	茶館: 'food-beverage',
	烧烤: 'food-beverage',
	燒烤: 'food-beverage',
	火锅: 'food-beverage',
	火鍋: 'food-beverage',
	grocery: 'grocery-convenience',
	convenience: 'grocery-convenience',
	fitness: 'fitness-wellness',
	gym: 'fitness-wellness',
	健身: 'fitness-wellness',
	education: 'education-consulting',
	consulting: 'education-consulting',
	entertainment: 'entertainment-leisure',
	salon: 'health-beauty',
	spa: 'health-beauty',
	barber: 'health-beauty',
	beauty: 'health-beauty',
	美容: 'health-beauty',
	美发: 'health-beauty',
	美髮: 'health-beauty',
	retail: 'retail-shopping',
	shop: 'retail-shopping',
	零售: 'retail-shopping',
	ecommerce: 'ecommerce-store',
	'e-commerce': 'ecommerce-store',
	电商: 'ecommerce-store',
	電商: 'ecommerce-store',
	creator: 'creator-kol',
	kol: 'creator-kol',
	saas: 'saas-platform',
	软件: 'saas-platform',
	軟體: 'saas-platform',
	app: 'mobile-application',
	ai: 'ai-ml-service',
	api: 'api-provider',
}

function normalizeCategory(kind: ChannelKind | '', raw: string): string {
	const allowed = catsForChannel(kind)
	const slug = raw.trim().toLowerCase().replace(/_/g, '-')
	if (allowed.includes(slug)) return slug
	const aliased = CATEGORY_ALIASES[slug] || CATEGORY_ALIASES[raw.trim()] || CATEGORY_ALIASES[slug.replace(/\s+/g, ' ')]
	if (aliased && allowed.includes(aliased)) return aliased
	const tokens = slug.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
	for (const t of tokens) {
		const hit = CATEGORY_ALIASES[t]
		if (hit && allowed.includes(hit)) return hit
	}
	return ''
}

function channelForCategory(cat: string): ChannelKind | '' {
	if ((PHYSICAL_CATS as readonly string[]).includes(cat)) return 'physical'
	if ((DIGITAL_CATS as readonly string[]).includes(cat)) return 'digital'
	if ((APP_CATS as readonly string[]).includes(cat)) return 'app'
	return ''
}

const FOOD_NAME_RE =
	/restaurant|restro|noodle|cuisine|cafe|coffee|bakery|bistro|diner|eatery|\bbar\b|\bpub\b|grill|kitchen|面馆|麵館|餐厅|餐廳|饭店|飯店|餐馆|餐館|酒楼|酒樓|咖啡|茶馆|茶館|烧烤|燒烤|火锅|火鍋|餐饮|餐飲|弄堂|小吃|料理|食堂|食府|菜馆|菜館|夜宵|本帮|本幫/

function parseDiscoveredBusiness(raw: unknown): DiscoveredBusiness | null {
	if (!raw || typeof raw !== 'object') return null
	const o = raw as Record<string, unknown>
	const name = clip(String(o.name ?? ''), 120)
	if (name.length < 2) return null
	const country = normalizeCountry(String(o.country ?? ''))
	return {
		name,
		website: sanitizeWebsite(String(o.website ?? '')),
		snippet: clip(String(o.snippet ?? ''), 200),
		city: clip(String(o.city ?? ''), 80),
		country,
		province: country ? normalizeProvince(country, String(o.province ?? '')) : '',
	}
}

function sanitizeWebsite(raw: string): string {
	const u = parsePublicHttpUrl(raw)
	if (!u) return ''
	if (u.protocol !== 'https:') return ''
	if (isMarketplaceListingUrl(u)) return ''
	if (looksLikeOpaqueListingPageUrl(u)) return ''
	return u.toString()
}

function uniqueSourceWebsites(sources: PageSource[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const s of sources) {
		const w = sanitizeWebsite(s.url)
		if (!w) continue
		const k = apexHost(new URL(w).hostname)
		if (seen.has(k)) continue
		seen.add(k)
		out.push(w)
	}
	return out
}

function uniquePublicWebsites(raws: string[], max: number): URL[] {
	const out: URL[] = []
	const seen = new Set<string>()
	for (const r of raws) {
		const u = parsePublicHttpUrl(r)
		if (!u || u.protocol !== 'https:') continue
		if (isMarketplaceListingUrl(u)) continue
		if (looksLikeOpaqueListingPageUrl(u)) continue
		const k = apexHost(u.hostname)
		if (seen.has(k)) continue
		seen.add(k)
		out.push(u)
		if (out.length >= max) break
	}
	return out
}

function sanitizeCandidate(
	raw: unknown,
	idx: number,
	fallbackWebsite: string,
): OnboardingBusinessLookupCandidate | null {
	if (!raw || typeof raw !== 'object') return null
	const o = raw as Record<string, unknown>
	const name = clip(String(o.name ?? ''), 120)
	if (name.length < 2) return null
	const channelRaw = String(o.channelKind ?? '').trim()
	const channelKind =
		!channelRaw || /^unknown$/i.test(channelRaw)
			? ''
			: (CHANNELS as readonly string[]).includes(channelRaw)
				? (channelRaw as ChannelKind)
				: ''
	const category = normalizeCategory(channelKind, String(o.category ?? ''))
	const orgRaw = String(o.orgType ?? '').trim()
	const orgType =
		!orgRaw || /^unknown$/i.test(orgRaw)
			? ''
			: (ORG_TYPES as readonly string[]).includes(orgRaw)
				? (orgRaw as OrgType)
				: ''
	const website = sanitizeWebsite(String(o.website ?? '')) || fallbackWebsite
	const country = normalizeCountry(String(o.country ?? ''))
	const id = clip(String(o.id ?? `cand-${idx + 1}`), 64) || `cand-${idx + 1}`
	return {
		id,
		name,
		website,
		snippet: clip(String(o.snippet ?? ''), 200),
		channelKind,
		category,
		orgType,
		country,
		city: clip(String(o.city ?? ''), 80),
		province: normalizeProvince(country, String(o.province ?? '')),
		publicBio: clip(String(o.publicBio ?? ''), 280),
		...emptyContact(),
	}
}

function dedupe(list: OnboardingBusinessLookupCandidate[]): OnboardingBusinessLookupCandidate[] {
	const seen = new Set<string>()
	const out: OnboardingBusinessLookupCandidate[] = []
	for (const c of list) {
		const key = `${c.name.toLowerCase()}|${c.website.toLowerCase()}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push(c)
		if (out.length >= MAX_CANDIDATES) break
	}
	return out
}

function compactSources(sources: PageSource[]): unknown[] {
	return sources.map((s) => ({
		url: s.url,
		lang: s.lang,
		title: s.title,
		siteName: s.siteName,
		jsonLdName: s.jsonLdName,
		description: s.description,
		city: s.city,
		province: s.province,
		country: s.country,
		street: s.street,
		phone: s.phone,
		email: s.email,
		postalCode: s.postalCode,
		visibleText: s.visibleText,
	}))
}

const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'] as const

type GeminiJsonResult = { status: 'no_key' } | { status: 'failed' } | { status: 'ok'; items: unknown[] }

type GeminiUserPart = { text: string } | { inlineData: { mimeType: string; data: string } }

function geminiErrorText(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e)
	return clip(msg.replace(/AIza[0-9A-Za-z_\-]+/g, '[redacted]'), 280)
}

function isGeminiQuotaExhausted(text: string): boolean {
	return /RESOURCE_EXHAUSTED|prepayment credits are depleted/i.test(text)
}

async function geminiJson(
	prompt: string,
	schema: typeof LOOKUP_SCHEMA | typeof DISCOVER_SCHEMA,
	extraParts: GeminiUserPart[] = [],
): Promise<GeminiJsonResult> {
	const apiKey = masterSetup?.GEMINI_API_KEY
	if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) return { status: 'no_key' }
	const ai = new GoogleGenAI({ apiKey })
	let lastErr = ''
	for (const model of GEMINI_MODELS) {
		try {
			const response = await ai.models.generateContent({
				model,
				contents: [{ role: 'user', parts: [{ text: prompt }, ...extraParts] }],
				config: {
					responseMimeType: 'application/json' as const,
					responseSchema: schema,
				},
			})
			const text = (response as { text?: string })?.text?.trim()
			if (!text) return { status: 'ok', items: [] }
			try {
				const parsed = JSON.parse(text) as { candidates?: unknown }
				return { status: 'ok', items: Array.isArray(parsed.candidates) ? parsed.candidates : [] }
			} catch {
				logger(Colors.yellow('[onboardingBusinessLookup] Invalid JSON from AI'))
				return { status: 'ok', items: [] }
			}
		} catch (e) {
			lastErr = geminiErrorText(e)
			logger(Colors.yellow('[onboardingBusinessLookup] Gemini'), model, lastErr)
			if (isGeminiQuotaExhausted(lastErr)) break
		}
	}
	if (lastErr) logger(Colors.yellow('[onboardingBusinessLookup] Gemini failed:'), lastErr)
	return { status: 'failed' }
}

type GeminiObjectResult =
	| { status: 'ok'; value: Record<string, unknown> }
	| { status: 'no_key' }
	| { status: 'failed' }

async function geminiJsonObject(
	prompt: string,
	schema: typeof CARD_SETUP_SCHEMA,
): Promise<GeminiObjectResult> {
	const apiKey = masterSetup?.GEMINI_API_KEY
	if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) return { status: 'no_key' }
	const ai = new GoogleGenAI({ apiKey })
	let lastErr = ''
	for (const model of GEMINI_MODELS) {
		try {
			const response = await ai.models.generateContent({
				model,
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				config: {
					responseMimeType: 'application/json' as const,
					responseSchema: schema,
				},
			})
			const text = (response as { text?: string })?.text?.trim()
			if (!text) return { status: 'ok', value: {} }
			try {
				const parsed = JSON.parse(text) as unknown
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return { status: 'ok', value: {} }
				}
				return { status: 'ok', value: parsed as Record<string, unknown> }
			} catch {
				logger(Colors.yellow('[onboardingBusinessCardSetup] Invalid JSON from AI'))
				return { status: 'ok', value: {} }
			}
		} catch (e) {
			lastErr = geminiErrorText(e)
			logger(Colors.yellow('[onboardingBusinessCardSetup] Gemini'), model, lastErr)
			if (isGeminiQuotaExhausted(lastErr)) break
		}
	}
	if (lastErr) logger(Colors.yellow('[onboardingBusinessCardSetup] Gemini failed:'), lastErr)
	return { status: 'failed' }
}

async function askGeminiCardSetup(input: {
	name: string
	website: string
	snippet: string
	publicBio: string
	channelKind: string
	category: string
	country: string
	city: string
	allowlistedImages: ScrapedBrandingImage[]
	themeColors: string[]
}): Promise<GeminiObjectResult> {
	const allowLines = input.allowlistedImages
		.map((i) => `- ${brandingAllowLabel(i)}: ${i.url}`)
		.join('\n')
	const prompt = `You help Beamio Merchant OS Card Setup after the merchant picked one business from a lookup list.
Return JSON for Discover presentation only. Do not invent image URLs.

Business name: ${JSON.stringify(input.name)}
Official website: ${JSON.stringify(input.website)}
Lookup snippet: ${JSON.stringify(input.snippet)}
Public bio: ${JSON.stringify(input.publicBio)}
Channel: ${JSON.stringify(input.channelKind)}
Category: ${JSON.stringify(input.category)}
Country: ${JSON.stringify(input.country)}
City: ${JSON.stringify(input.city)}

Scraped HTTPS image URLs (choose only from this list; copy the exact URL; empty string if none fit):
${allowLines || '(none — logoUrl and backgroundUrl MUST be empty strings)'}

Scraped theme colors: ${input.themeColors.join(', ') || '(none)'}

Rules:
- logoUrl: prefer THIS business’s own wordmark. The URL path or filename MUST contain a token from the business name. Skip partner, supplier, or product-brand logos even if they appear first. Never pick a weak favicon. Empty if nothing fits.
- backgroundUrl: prefer a wide banner / hero / og image, and it MUST differ from logoUrl when possible. Empty if nothing fits.
- NEVER invent, rewrite hosts, or guess image URLs that are not in the scraped list.
- brandColor: #RRGGBB. If scraped theme colors are listed, you MUST copy one of those exact values. If none were scraped, you may infer a public brand color for THIS named venue.
- discoverCopy: English, 1–2 sentences for Discover, at most ${CARD_SETUP_DISCOVER_COPY_MAX} characters. Do not invent Canada or a city from cuisine words.
- ${CUISINE_NOT_LOCATION_RULE}`
	return geminiJsonObject(prompt, CARD_SETUP_SCHEMA)
}

async function askGeminiDiscover(
	query: string,
): Promise<{ failed: boolean; list: DiscoveredBusiness[] }> {
	const prompt = `You help Beamio Merchant OS find public businesses from a name query.
Query: ${JSON.stringify(query)}
Return up to ${MAX_CANDIDATES} real public businesses that match this query.
- name must be English (official English name, or a reasonable English transliteration).
- website must be the official https URL if you know it from public knowledge, otherwise empty.
- snippet: one English sentence that helps tell similar names apart (what the venue is, neighborhood if known).
- city / country / province: only if you know THAT named venue’s public listing address.
- country: ISO 3166-1 alpha-2, or empty if unknown.
- ${CUISINE_NOT_LOCATION_RULE}
- ${GEMINI_VENUE_NAME_RULE}
- If the query is a delivery or review marketplace listing (Uber Eats, DoorDash, Grubhub, Yelp, SkipTheDishes, Google Maps place, …), return the named restaurant or shop on that listing, not the marketplace company.
- Prefer the merchant's own official https website. Never use ubereats.com, doordash.com, grubhub.com, yelp.com, zomi.menu, or similar marketplace hosts as website.
Do not invent private IPs, localhost, or non-https websites. Do not invent a website you are not reasonably sure of.`
	const result = await geminiJson(prompt, DISCOVER_SCHEMA)
	if (result.status !== 'ok') return { failed: true, list: [] }
	const out: DiscoveredBusiness[] = []
	for (const item of result.items) {
		const parsed = parseDiscoveredBusiness(item)
		if (!parsed) continue
		out.push(parsed)
		if (out.length >= MAX_CANDIDATES) break
	}
	return { failed: false, list: out }
}

async function askGeminiAnalyze(
	query: string,
	sources: PageSource[],
	fallbackWebsite: string,
): Promise<{ failed: boolean; list: OnboardingBusinessLookupCandidate[] }> {
	if (!sources.length) return { failed: false, list: [] }
	const prompt = `You help Beamio Merchant OS onboarding. Analyze the scraped public pages (they may be Chinese, Japanese, German, or another language) and return JSON candidates for a merchant to review.

Query: ${JSON.stringify(query)}
Scraped sources (do not invent facts that are not supported by these sources or the query):
${JSON.stringify(compactSources(sources))}

Rules:
- Return at most ${MAX_CANDIDATES} candidates.
- Every user-visible string must be English: name, snippet, publicBio, city.
- name: official English name if the sources show one; otherwise a reasonable English name or transliteration (e.g. 星巴克 → Starbucks).
- snippet: one English sentence about the business.
- publicBio: short English Discover bio (1–2 sentences).
- city: English (Vancouver, not 溫哥華).
- country: ISO 3166-1 alpha-2 (CN, CA, US, JP, …). Use "unknown" if missing. Do not invent Canada.
- ${CUISINE_NOT_LOCATION_RULE}
- ${GEMINI_VENUE_NAME_RULE}
- province: for ${CODED_PROVINCE_COUNTRIES.join(', ')} use the region CODE (BC, ON, CA, NY, ENG, NSW, BY). For other countries use the English province/state/region name, or "" if unknown.
- channelKind: physical | digital | app, or "unknown"
- physical categories: ${PHYSICAL_CATS.join(', ')}
- digital categories: ${DIGITAL_CATS.join(', ')}
- app categories: ${APP_CATS.join(', ')}
- orgType: sme | franchise | ngo, or "unknown"
- website must be an https URL that appears in the sources or the query. Use "" if unknown. Never invent a different website.
- Use the scraped street, city, province, and country for THIS page’s venue. Do not replace them with another location of a similar brand (for example do not change Richmond to Burnaby).
- For a website query, the candidate MUST be the venue at that URL. If the URL is a multi-store platform listing (for example https://www.zomi.menu/shop/longdhang), name the restaurant/shop (LONGDHANG), never the platform brand (ZOMI / og:site_name).
- For a merchant’s own homepage URL, the candidate MUST be the business that owns that homepage, not a sister shop.
- Never use an empty string for channelKind, orgType, or country. Use "unknown" instead.`

	const result = await geminiJson(prompt, LOOKUP_SCHEMA)
	if (result.status !== 'ok') return { failed: true, list: [] }
	const out: OnboardingBusinessLookupCandidate[] = []
	for (let i = 0; i < result.items.length; i++) {
		const c = sanitizeCandidate(result.items[i], i, fallbackWebsite)
		if (c) out.push(c)
	}
	return { failed: false, list: out }
}

async function askGeminiAnalyzeAttachments(
	query: string,
	files: ParsedOnboardingLookupFile[],
	sources: PageSource[],
	fallbackWebsite: string,
): Promise<{ failed: boolean; list: OnboardingBusinessLookupCandidate[] }> {
	const extraParts: GeminiUserPart[] = []
	for (const f of files) {
		if (f.kind === 'docx' && f.text) {
			extraParts.push({ text: `Attached Word file ${f.filename}:\n${f.text}` })
		} else {
			extraParts.push({ inlineData: { mimeType: f.geminiMime, data: f.base64 } })
			extraParts.push({ text: `Attached file: ${f.filename} (${f.geminiMime})` })
		}
	}
	const prompt = `You help Beamio Merchant OS onboarding. The merchant attached files (menu, flyer, PDF, photo of a storefront or business card) and may have typed a query. Extract real businesses from the attachments and any scraped pages.

Query: ${JSON.stringify(query || '(none)')}
Scraped sources (may be empty):
${JSON.stringify(compactSources(sources))}

Rules:
- Return at most ${MAX_CANDIDATES} candidates.
- Prefer facts from the attached files. Use scraped sources to confirm website, address, and contact when they match.
- Every user-visible string must be English: name, snippet, publicBio, city.
- name: official English name if shown; otherwise a reasonable English name or transliteration.
- snippet: one English sentence about the business.
- publicBio: short English Discover bio (1–2 sentences).
- city: English (Vancouver, not 溫哥華).
- country: ISO 3166-1 alpha-2 (CN, CA, US, JP, …). Use "unknown" if missing. Do not invent Canada.
- ${CUISINE_NOT_LOCATION_RULE}
- ${GEMINI_VENUE_NAME_RULE}
- province: for ${CODED_PROVINCE_COUNTRIES.join(', ')} use the region CODE (BC, ON, CA, NY, ENG, NSW, BY). For other countries use the English province/state/region name, or "" if unknown.
- channelKind: physical | digital | app, or "unknown"
- physical categories: ${PHYSICAL_CATS.join(', ')}
- digital categories: ${DIGITAL_CATS.join(', ')}
- app categories: ${APP_CATS.join(', ')}
- orgType: sme | franchise | ngo, or "unknown"
- website must be an https URL that appears in the files, sources, or query. Use "" if unknown. Never invent a website.
- Never use an empty string for channelKind, orgType, or country. Use "unknown" instead.`

	const result = await geminiJson(prompt, LOOKUP_SCHEMA, extraParts)
	if (result.status !== 'ok') return { failed: true, list: [] }
	const out: OnboardingBusinessLookupCandidate[] = []
	for (let i = 0; i < result.items.length; i++) {
		const c = sanitizeCandidate(result.items[i], i, fallbackWebsite)
		if (c) out.push(c)
	}
	return { failed: false, list: out }
}

async function askGeminiAnalyzeKnownBusinesses(
	query: string,
	discovered: DiscoveredBusiness[],
): Promise<{ failed: boolean; list: OnboardingBusinessLookupCandidate[] }> {
	if (!discovered.length) return { failed: false, list: [] }
	const prompt = `You help Beamio Merchant OS onboarding. These public businesses were found by name, but there is no scraped website text. Use widely known public facts about EACH listed business (the kind of shop it is) to fill English onboarding fields.

Query: ${JSON.stringify(query)}
Discovered businesses:
${JSON.stringify(discovered)}

Rules:
- Return exactly one candidate per discovered business, in the same order. Keep the English name (you may lightly normalize spelling).
- Every user-visible string must be English: name, snippet, publicBio, city.
- snippet: one English sentence about the business. Prefer the discovered snippet when it already distinguishes venues.
- publicBio: short English Discover bio (1–2 sentences).
- channelKind: physical | digital | app. A restaurant, cafe, bar, bakery, noodle shop, salon, gym, clinic, or other brick-and-mortar shop MUST be physical. Do not leave this unknown when the name already says restaurant / cuisine / salon.
- physical categories: ${PHYSICAL_CATS.join(', ')}
- digital categories: ${DIGITAL_CATS.join(', ')}
- app categories: ${APP_CATS.join(', ')}
- Shanghainese / Chinese / noodle / restaurant / cafe / bakery → category food-beverage.
- orgType: sme for an independent restaurant or shop; franchise only if it is clearly a chain; ngo only if clearly a non-profit. Prefer sme over unknown for a named restaurant.
- website: copy the https URL from discovered if present. Otherwise "". NEVER invent a website.
- country: ISO 3166-1 alpha-2 when you are reasonably sure of THAT named venue’s public listing address. Copy discovered.country when present. Use "unknown" if the name is ambiguous across cities/countries. Do not invent Canada.
- city: English city name only when reasonably sure of THAT venue. Copy discovered.city when present. Otherwise "".
- ${CUISINE_NOT_LOCATION_RULE}
- ${GEMINI_VENUE_NAME_RULE}
- province: for ${CODED_PROVINCE_COUNTRIES.join(', ')} use the region CODE (BC, ON, CA, NY, ENG, NSW, BY). For other countries use the English province/state/region name, or "" if unknown.
- Never use an empty string for channelKind, orgType, or country. Use "unknown" instead when you truly cannot tell.`

	const result = await geminiJson(prompt, LOOKUP_SCHEMA)
	if (result.status !== 'ok') return { failed: true, list: [] }
	const out: OnboardingBusinessLookupCandidate[] = []
	for (let i = 0; i < result.items.length; i++) {
		const fallbackWebsite = discovered[i]?.website || discovered[0]?.website || ''
		const c = sanitizeCandidate(result.items[i], i, fallbackWebsite)
		if (c) out.push(c)
	}
	return { failed: false, list: out }
}

function mergeKnownOntoDiscovered(
	discovered: DiscoveredBusiness[],
	known: OnboardingBusinessLookupCandidate[],
): OnboardingBusinessLookupCandidate[] {
	if (!known.length) return []
	const byFold = new Map<string, DiscoveredBusiness>()
	for (const d of discovered) {
		const k = foldKey(d.name)
		if (k && !byFold.has(k)) byFold.set(k, d)
	}
	return known.map((c, i) => {
		const d = byFold.get(foldKey(c.name)) || discovered[i]
		if (!d) return enrichCandidateFromPublicName(c)
		const country = c.country || d.country
		return enrichCandidateFromPublicName({
			...c,
			website: c.website || d.website,
			name: c.name || d.name,
			snippet: c.snippet || d.snippet,
			country,
			city: c.city || d.city,
			province: c.province || (country ? normalizeProvince(country, d.province) : ''),
		})
	})
}

function enrichCandidateFromPublicName(
	c: OnboardingBusinessLookupCandidate,
): OnboardingBusinessLookupCandidate {
	const catFromName = normalizeCategory(c.channelKind, c.category || c.name)
	if (c.channelKind) {
		return c.category ? c : { ...c, category: catFromName }
	}
	let cat = catFromName
	const hay = [c.name, c.snippet, c.publicBio].filter(Boolean).join('\n')
	const n = hay.toLowerCase()
	if (!cat) {
		if (FOOD_NAME_RE.test(n) || FOOD_NAME_RE.test(hay)) cat = 'food-beverage'
		else if (/salon|spa|barber|clinic|beauty|美容|美发|美髮/.test(n) || /美容|美发|美髮/.test(hay)) {
			cat = 'health-beauty'
		} else if (/gym|fitness|yoga|健身/.test(n) || /健身/.test(hay)) cat = 'fitness-wellness'
	}
	const channel = channelForCategory(cat)
	if (!channel || !cat) return c
	return {
		...c,
		channelKind: channel,
		category: c.category || cat,
		orgType: c.orgType || (channel === 'physical' ? 'sme' : c.orgType),
	}
}

function discoveredToCandidates(list: DiscoveredBusiness[]): OnboardingBusinessLookupCandidate[] {
	return list.map((d, i) => ({
		id: `discover-${i + 1}`,
		name: d.name,
		website: d.website,
		snippet: d.snippet,
		channelKind: '' as const,
		category: '',
		orgType: '' as const,
		country: d.country,
		city: d.city,
		province: d.province,
		publicBio: '',
		...emptyContact(),
	}))
}

function stripTitleSiteSuffix(title: string): string {
	const parts = title.split(/\s+[|\-–—]\s+/)
	if (parts.length >= 2) {
		const left = parts[0].trim()
		if (left.length >= 2) return clip(left, 120)
	}
	return clip(title, 120)
}

function isGenericPageTitle(name: string): boolean {
	const n = name.trim()
	if (/^(home|homepage|welcome|index)$/i.test(n)) return true
	if (/^(uber eats|doordash|grubhub|skip.?the.?dishes|yelp|google maps|tripadvisor|zomi|zomi menu)$/i.test(n)) {
		return true
	}
	return false
}

function looksLikeMarketplacePlatformName(name: string, apex?: string | null): boolean {
	if (isGenericPageTitle(name)) return true
	const n = foldKey(name)
	if (!n) return false
	if (apex) {
		const label = MARKETPLACE_PLATFORM_LABEL[apex]
		if (label && foldKey(label) === n) return true
		const apexBrand = foldKey(apex.replace(/\.(com|co|menu|app|net|org|au)$/i, '').split('.').join(''))
		if (apexBrand && n === apexBrand) return true
	}
	for (const label of Object.values(MARKETPLACE_PLATFORM_LABEL)) {
		if (foldKey(label) === n) return true
	}
	return false
}

/** “See reviews … for LONGDHANG in Richmond” — venue, not the platform. */
export function venueNameFromReviewsForPhrase(description: string): string {
	const m = description.match(/\bfor\s+([A-Z][A-Z0-9 .&'+-]{1,80}?)\s+in\s+[A-Z]/)
	if (!m?.[1]) return ''
	const name = m[1].replace(/\s+/g, ' ').trim()
	if (name.length < 2) return ''
	if (looksLikeMarketplacePlatformName(name)) return ''
	return clip(name, 120)
}

/** Listing-page venue name. Never prefer og:site_name / jsonLd platform brand. */
export function listingVenueDisplayName(src: {
	url: string
	title: string
	description: string
	siteName: string
	jsonLdName: string
}): string {
	const u = parsePublicHttpUrl(src.url)
	const apex = u ? marketplacePlatformApex(u.hostname) : null
	const slug = u ? shopListingSlug(u) : ''
	if (!slug && !apex) return ''
	if (!slug) return ''
	const reject = (name: string) =>
		!name.trim() ||
		looksLikeMarketplacePlatformName(name, apex) ||
		looksLikeNonVenueListingLabel(name, src.url)
	const fromDesc = venueNameFromReviewsForPhrase(src.description)
	if (fromDesc && !reject(fromDesc)) return fromDesc
	if (src.jsonLdName && !reject(src.jsonLdName)) return clip(src.jsonLdName, 120)
	const fromTitle = stripTitleSiteSuffix(src.title)
	if (fromTitle && !reject(fromTitle)) return clip(fromTitle, 120)
	const fromSlug = u ? marketplaceVenueName(u) : ''
	if (fromSlug && !reject(fromSlug)) return clip(fromSlug, 120)
	return fromDesc
}

function displayNameFromScrape(src: PageSource): string {
	const city = src.city.trim()
	const stripCity = (raw: string): string => {
		let s = clip(raw, 120)
		if (city) {
			const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			s = s.replace(new RegExp(`\\s*[-|–—]\\s*${escaped}\\s*$`, 'i'), '').trim()
		}
		return s
	}
	const listed = listingVenueDisplayName(src)
	if (listed.length >= 2) return stripCity(listed)
	const u = parsePublicHttpUrl(src.url)
	const apex = u ? marketplacePlatformApex(u.hostname) : null
	const reject = (name: string) =>
		!name.trim() ||
		looksLikeMarketplacePlatformName(name, apex) ||
		looksLikeNonVenueListingLabel(name, src.url)
	if (src.jsonLdName && !reject(src.jsonLdName)) return stripCity(src.jsonLdName)
	if (src.siteName && !reject(src.siteName)) return stripCity(src.siteName)
	const fromTitle = stripTitleSiteSuffix(src.title)
	if (fromTitle && !reject(fromTitle)) return stripCity(fromTitle)
	const fallback = [src.title, src.jsonLdName, src.siteName].find((n) => n && !reject(n)) || ''
	return stripCity(fallback)
}

function candidateFromScrapedHomepage(
	sources: PageSource[],
	fallbackWebsite: string,
): OnboardingBusinessLookupCandidate | null {
	const src = sources[0]
	if (!src || isUnusableScrapeSource(src)) return null
	if (scrapeLooksLikeListingChrome(src)) return null
	const name = displayNameFromScrape(src)
	if (name.length < 2) return null
	if (looksLikeNonVenueListingLabel(name, src.url)) return null
	const website = sanitizeWebsite(src.url) || fallbackWebsite
	const country = normalizeCountry(src.country)
	return {
		id: 'homepage-1',
		name,
		website,
		snippet: clip(src.description || src.visibleText.slice(0, 200), 200),
		channelKind: '',
		category: '',
		orgType: '',
		country,
		city: clip(src.city, 80),
		province: country ? normalizeProvince(country, src.province) : clip(src.province, 80),
		publicBio: clip(src.description, 280),
		...emptyContact(),
	}
}

function sourceApex(url: string): string {
	try {
		return apexHost(new URL(url).hostname)
	} catch {
		return ''
	}
}

function attachScrapedContact(
	list: OnboardingBusinessLookupCandidate[],
	sources: PageSource[],
): OnboardingBusinessLookupCandidate[] {
	if (!list.length) return list
	return list.map((c) => {
		const want = sourceApex(c.website)
		const src =
			(want ? sources.find((s) => sourceApex(s.url) === want) : undefined) ||
			(list.length === 1 ? sources[0] : undefined)
		if (!src) return { ...c, ...emptyContact() }
		return {
			...c,
			city: src.city || c.city,
			province: src.province || c.province,
			country: src.country || c.country,
			street: src.street,
			phone: src.phone,
			email: src.email,
			postalCode: src.postalCode,
		}
	})
}

function candidateFromMarketplaceListing(query: string): OnboardingBusinessLookupCandidate | null {
	if (!looksLikeWebsiteQuery(query)) return null
	const start = parsePublicHttpUrl(query)
	if (!start || !isMarketplaceListingUrl(start)) return null
	const name = marketplaceVenueName(start)
	if (name.length < 2) return null
	const apex = marketplacePlatformApex(start.hostname)
	const platform = apex
		? MARKETPLACE_PLATFORM_LABEL[apex] || 'a listing'
		: isGoogleMapsListingUrl(start)
			? 'Google Maps'
			: 'a listing'
	const country = marketplaceCountryHint(start)
	return {
		id: 'listing-1',
		name,
		website: '',
		snippet: clip(`Listed on ${platform}.`, 200),
		channelKind: '',
		category: '',
		orgType: '',
		country,
		city: '',
		province: '',
		publicBio: '',
		...emptyContact(),
	}
}

/**
 * Drop listing-chrome names when at least one real venue name exists.
 * If every name is chrome, return [] so the handler can use discover / a listing stub
 * instead of showing “Restaurant ca-1725834231”.
 */
export function preferNonChromeCandidateNames(
	candidates: OnboardingBusinessLookupCandidate[],
	pageUrl?: string,
): OnboardingBusinessLookupCandidate[] {
	if (!candidates.length) return candidates
	const real = candidates.filter((c) => !looksLikeNonVenueListingLabel(c.name, pageUrl))
	return real
}

/**
 * Overlay scrape onto Gemini only when the scrape looks like a real venue.
 * Listing chrome (opaque ids, category+id titles, generic delivery blurbs) must not
 * replace an AI storefront name. Host-agnostic — no per-marketplace parser.
 */
export function overlayScrapedVenueForWebsiteQuery(
	query: string,
	sources: PageSource[],
	candidates: OnboardingBusinessLookupCandidate[],
): OnboardingBusinessLookupCandidate[] {
	if (!looksLikeWebsiteQuery(query) || !sources.length) {
		return preferNonChromeCandidateNames(candidates, sources[0]?.url)
	}
	if (sources[0] && isUnusableScrapeSource(sources[0])) {
		return preferNonChromeCandidateNames(candidates, sources[0]?.url)
	}
	if (scrapeLooksLikeListingChrome(sources[0])) {
		return preferNonChromeCandidateNames(candidates, sources[0].url)
	}
	const home = candidateFromScrapedHomepage(sources, sanitizeWebsite(sources[0].url) || '')
	if (!home) return preferNonChromeCandidateNames(candidates, sources[0].url)
	if (!candidates.length) return [home]
	const queryUrl = parsePublicHttpUrl(query)
	const platformApex = queryUrl ? marketplacePlatformApex(queryUrl.hostname) : null
	const scrapeNameUsable =
		home.name.length >= 2 &&
		!looksLikeMarketplacePlatformName(home.name, platformApex) &&
		!looksLikeNonVenueListingLabel(home.name, sources[0].url)
	const listingName = listingVenueDisplayName(sources[0]) || marketplaceVenueName(query)
	const listingNameUsable =
		listingName.length >= 2 && !looksLikeNonVenueListingLabel(listingName, sources[0].url)
	const scrapeSnippetBad =
		looksLikeGenericMarketplaceSnippet(home.snippet) ||
		looksLikeGenericMarketplaceSnippet(home.publicBio)
	const scrapeIsPlatform = looksLikeMarketplacePlatformName(home.name, platformApex)
	const overlaid = candidates.map((c) => {
		let name = c.name
		if (scrapeIsPlatform) {
			if (listingNameUsable) name = listingName
		} else if (scrapeNameUsable) {
			name = home.name
		} else if (listingNameUsable) {
			name = listingName
		}
		return {
			...c,
			name,
			website: home.website || c.website,
			city: home.city || c.city,
			province: home.province || c.province,
			country: home.country || c.country,
			snippet: scrapeSnippetBad ? c.snippet : home.snippet || c.snippet,
			publicBio: scrapeSnippetBad ? c.publicBio : home.publicBio || c.publicBio,
		}
	})
	return preferNonChromeCandidateNames(overlaid, sources[0].url)
}

async function handleAttachmentLookup(
	query: string,
	files: ParsedOnboardingLookupFile[],
	res: Response,
): Promise<void> {
	let sources: PageSource[] = []
	if (query && looksLikeWebsiteQuery(query)) {
		const start = parsePublicHttpUrl(query)
		if (start) {
			const hop = await scrapeWebsiteThenMaybeDiscover(start, query)
			sources = hop.sources
		}
	}

	let analyzed: OnboardingBusinessLookupCandidate[] = []
	let analyzeFailed = false
	let sites = uniqueSourceWebsites(sources)
	let singleSiteFallback = sites.length === 1 ? sites[0] : ''
	try {
		const analyze = await askGeminiAnalyzeAttachments(query, files, sources, singleSiteFallback)
		analyzeFailed = analyze.failed
		analyzed = analyze.list
	} catch (e) {
		analyzeFailed = true
		logger(Colors.yellow('[onboardingBusinessLookup] Gemini attachments:'), (e as Error)?.message ?? e)
	}

	const extraWebsites = analyzed.map((c) => c.website).filter(Boolean)
	if (extraWebsites.length) {
		const urls = uniquePublicWebsites(extraWebsites, MAX_NAME_SITES)
		const have = new Set(sources.map((s) => sourceApex(s.url)).filter(Boolean))
		const missing = urls.filter((u) => !have.has(apexHost(u.hostname)))
		if (missing.length) {
			const batches = await Promise.all(missing.map((u) => collectWebsitePageSources(u, MAX_EXTRA_LANG_NAME)))
			sources = [...sources, ...batches.flat()]
		}
	}
	sites = uniqueSourceWebsites(sources)
	singleSiteFallback = sites.length === 1 ? sites[0] : singleSiteFallback

	const overlayQuery = looksLikeWebsiteQuery(query) ? query : analyzed[0]?.website || ''
	if (overlayQuery) {
		analyzed = overlayScrapedVenueForWebsiteQuery(overlayQuery, sources, analyzed)
	}

	logger(
		Colors.cyan('[onboardingBusinessLookup] attach sources='),
		String(sources.length),
		sources.map((s) => `${clip(s.lang || '?', 12)} ${clip(s.title, 40)}`).join(' | '),
	)

	if (analyzed.length) {
		res.json({
			ok: true,
			candidates: attachScrapedContact(dedupe(analyzed.map(enrichCandidateFromPublicName)), sources),
		})
		return
	}

	const homepage = looksLikeWebsiteQuery(query)
		? candidateFromScrapedHomepage(sources, singleSiteFallback)
		: extraWebsites[0]
			? candidateFromScrapedHomepage(sources, extraWebsites[0])
			: null
	if (homepage) {
		res.json({
			ok: true,
			candidates: attachScrapedContact([enrichCandidateFromPublicName(homepage)], sources),
		})
		return
	}

	const listing = candidateFromMarketplaceListing(query)
	if (listing) {
		res.json({
			ok: true,
			candidates: attachScrapedContact([enrichCandidateFromPublicName(listing)], sources),
		})
		return
	}

	if (analyzeFailed) {
		logger(Colors.yellow('[onboardingBusinessLookup] ai_unavailable attachments'))
		res.json({ ok: false, error: 'ai_unavailable' })
		return
	}
	res.json({ ok: true, candidates: [] })
}

export async function onboardingBusinessLookupHandler(req: Request, res: Response): Promise<void> {
	const ip = getClientIp(req) || req.ip || 'unknown'
	if (!takeRate(ip)) {
		res.status(429).json({ ok: false, error: 'rate_limited' })
		return
	}
	const parsedFiles = parseOnboardingLookupFiles((req.body as { files?: unknown })?.files)
	if ('error' in parsedFiles) {
		res.status(400).json({ ok: false, error: parsedFiles.error })
		return
	}
	const files = parsedFiles.files
	const query = clip(String((req.body as { query?: unknown })?.query ?? ''), MAX_QUERY)
	if (!files.length && query.length < 2) {
		res.status(400).json({ ok: false, error: 'query_required' })
		return
	}
	logger(Colors.cyan('[onboardingBusinessLookup]'), clip(query, 80), summarizeOnboardingLookupFiles(files), ip)
	if (files.length) {
		await handleAttachmentLookup(query, files, res)
		return
	}

	let sources: PageSource[] = []
	let discovered: DiscoveredBusiness[] = []
	let discoverFailed = false
	let singleSiteFallback = ''

	if (looksLikeWebsiteQuery(query)) {
		const start = parsePublicHttpUrl(query)
		if (start) {
			const hop = await scrapeWebsiteThenMaybeDiscover(start, query)
			sources = hop.sources
			discovered = hop.discovered
			discoverFailed = hop.discoverFailed
		}
	} else {
		const hop = await discoverOfficialSitesFromQuery(query, MAX_EXTRA_LANG_NAME)
		discoverFailed = hop.discoverFailed
		discovered = hop.discovered
		sources = hop.sources
	}
	const sites = uniqueSourceWebsites(sources)
	singleSiteFallback = sites.length === 1 ? sites[0] : ''

	logger(
		Colors.cyan('[onboardingBusinessLookup] sources='),
		String(sources.length),
		sources.map((s) => `${clip(s.lang || '?', 12)} ${clip(s.title, 40)}`).join(' | '),
	)

	let analyzed: OnboardingBusinessLookupCandidate[] = []
	let analyzeFailed = false
	try {
		const analyze = await askGeminiAnalyze(query, sources, singleSiteFallback)
		analyzeFailed = analyze.failed
		analyzed = analyze.list
	} catch (e) {
		analyzeFailed = true
		logger(Colors.yellow('[onboardingBusinessLookup] Gemini analyze:'), (e as Error)?.message ?? e)
	}

	analyzed = overlayScrapedVenueForWebsiteQuery(query, sources, analyzed)

	if (analyzed.length) {
		res.json({
			ok: true,
			candidates: attachScrapedContact(dedupe(analyzed.map(enrichCandidateFromPublicName)), sources),
		})
		return
	}

	const homepage = looksLikeWebsiteQuery(query)
		? candidateFromScrapedHomepage(sources, singleSiteFallback)
		: null
	if (homepage) {
		res.json({
			ok: true,
			candidates: attachScrapedContact([enrichCandidateFromPublicName(homepage)], sources),
		})
		return
	}

	let known: OnboardingBusinessLookupCandidate[] = []
	let knownFailed = false
	if (discovered.length) {
		try {
			const knowledge = await askGeminiAnalyzeKnownBusinesses(query, discovered)
			knownFailed = knowledge.failed
			known = mergeKnownOntoDiscovered(discovered, knowledge.list)
			logger(
				Colors.cyan('[onboardingBusinessLookup] knowledge='),
				String(known.length),
				known
					.map((c) => `${clip(c.name, 32)} ${c.channelKind || '-'} ${c.category || '-'}`)
					.join(' | '),
			)
		} catch (e) {
			knownFailed = true
			logger(Colors.yellow('[onboardingBusinessLookup] Gemini knowledge:'), (e as Error)?.message ?? e)
		}
	}
	if (known.length) {
		res.json({
			ok: true,
			candidates: attachScrapedContact(dedupe(known.map(enrichCandidateFromPublicName)), sources),
		})
		return
	}

	const fallback = discoveredToCandidates(discovered).map(enrichCandidateFromPublicName)
	if (fallback.length) {
		res.json({ ok: true, candidates: attachScrapedContact(dedupe(fallback), sources) })
		return
	}
	const listing = candidateFromMarketplaceListing(query)
	if (listing) {
		res.json({
			ok: true,
			candidates: attachScrapedContact([enrichCandidateFromPublicName(listing)], sources),
		})
		return
	}
	if (discoverFailed || analyzeFailed || knownFailed) {
		logger(Colors.yellow('[onboardingBusinessLookup] ai_unavailable'))
		res.json({ ok: false, error: 'ai_unavailable' })
		return
	}
	res.json({ ok: true, candidates: [] })
}

export async function onboardingBusinessCardSetupHandler(req: Request, res: Response): Promise<void> {
	const ip = getClientIp(req) || req.ip || 'unknown'
	if (!takeCardSetupRate(ip)) {
		res.status(429).json({ ok: false, error: 'rate_limited' })
		return
	}
	const body = (req.body ?? {}) as {
		name?: unknown
		website?: unknown
		snippet?: unknown
		publicBio?: unknown
		channelKind?: unknown
		category?: unknown
		country?: unknown
		city?: unknown
	}
	const name = clip(String(body.name ?? ''), 120)
	if (name.length < 2) {
		res.status(400).json({ ok: false, error: 'name_required' })
		return
	}
	const website = sanitizeWebsite(String(body.website ?? ''))
	const snippet = clip(String(body.snippet ?? ''), 400)
	const publicBio = clip(String(body.publicBio ?? ''), 400)
	const channelRaw = clip(String(body.channelKind ?? ''), 24)
	const channelKind = (CHANNELS as readonly string[]).includes(channelRaw) ? channelRaw : ''
	const category = clip(String(body.category ?? ''), 80)
	const country = normalizeOnboardingCountryCode(String(body.country ?? ''))
	const city = clip(String(body.city ?? ''), 80)

	logger(Colors.cyan('[onboardingBusinessCardSetup]'), clip(name, 80), website || '-', ip)

	let scraped: { images: ScrapedBrandingImage[]; themeColors: string[] } = {
		images: [],
		themeColors: [],
	}
	if (website) {
		try {
			scraped = await scrapeWebsiteBranding(website)
		} catch (e) {
			logger(Colors.yellow('[onboardingBusinessCardSetup] scrape:'), (e as Error)?.message ?? e)
		}
		scraped = {
			images: demoteUnmatchedLogos(scraped.images, name, website),
			themeColors: scraped.themeColors,
		}
	}

	const allow = scraped.images.map((i) => ({ url: i.url, key: urlKey(new URL(i.url)) }))
	const fallback = scrapeFallbackAssets(
		scraped.images,
		scraped.themeColors,
		publicBio,
		snippet,
		name,
		website,
	)

	let gemini: GeminiObjectResult
	try {
		gemini = await askGeminiCardSetup({
			name,
			website,
			snippet,
			publicBio,
			channelKind,
			category,
			country,
			city,
			allowlistedImages: scraped.images,
			themeColors: scraped.themeColors,
		})
	} catch (e) {
		logger(Colors.yellow('[onboardingBusinessCardSetup] Gemini:'), (e as Error)?.message ?? e)
		gemini = { status: 'failed' }
	}

	const g = gemini.status === 'ok' ? gemini.value : {}
	const geminiLogo = pickAllowlistedImageUrl(String(g.logoUrl ?? ''), allow)
	const geminiBg = pickAllowlistedImageUrl(String(g.backgroundUrl ?? ''), allow)
	const geminiHex = normalizeBrandHex(String(g.brandColor ?? ''))
	const geminiCopy = clip(String(g.discoverCopy ?? ''), CARD_SETUP_DISCOVER_COPY_MAX)

	let logoUrl = geminiLogo || fallback.logoUrl
	const strongLogo = pickStrongLogoUrl(scraped.images, name, website)
	const logoTokens = brandingNameTokens(name, website)
	if (
		strongLogo &&
		(!logoUrl ||
			isWeakLogoUrl(logoUrl, scraped.images) ||
			(logoMatchesBusiness(strongLogo, logoTokens) && !logoMatchesBusiness(logoUrl, logoTokens)))
	) {
		logoUrl = strongLogo
	}
	if (logoTokens.length && logoUrl && !logoMatchesBusiness(logoUrl, logoTokens)) {
		logoUrl = strongLogo
	}
	let backgroundUrl = geminiBg || fallback.backgroundUrl
	if (backgroundUrl && logoUrl && backgroundUrl === logoUrl) {
		backgroundUrl =
			scraped.images.find((i) => i.url !== logoUrl && (i.kind === 'hero' || i.kind === 'og'))?.url ||
			scraped.images.find((i) => i.url !== logoUrl && i.kind !== 'logo')?.url ||
			''
	}

	let brandColor = ''
	if (scraped.themeColors.length) {
		brandColor = scraped.themeColors.includes(geminiHex) ? geminiHex : scraped.themeColors[0]
	} else {
		brandColor = geminiHex
	}

	const discoverCopy = geminiCopy || fallback.discoverCopy

	const hasAny =
		Boolean(logoUrl) || Boolean(backgroundUrl) || Boolean(brandColor) || Boolean(discoverCopy)
	if (!hasAny && (gemini.status === 'no_key' || gemini.status === 'failed')) {
		res.json({ ok: false, error: 'ai_unavailable' })
		return
	}

	const assets: OnboardingCardSetupAssets = {
		logoUrl,
		backgroundUrl,
		brandColor,
		discoverCopy,
	}
	res.json({ ok: true, ...assets })
}
