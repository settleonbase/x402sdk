import dns from 'node:dns/promises'
import net from 'node:net'
import { Request, Response } from 'express'
import { GoogleGenAI } from '@google/genai'
import Colors from 'colors/safe'
import { getClientIp, masterSetup } from '../util'
import { logger } from '../logger'

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
const COUNTRIES = ['CA', 'US', 'GB', 'AU', 'DE'] as const

type ChannelKind = (typeof CHANNELS)[number]
type OrgType = (typeof ORG_TYPES)[number]
type CountryCode = (typeof COUNTRIES)[number]

export type OnboardingBusinessLookupCandidate = {
	id: string
	name: string
	website: string
	snippet: string
	channelKind: ChannelKind | ''
	category: string
	orgType: OrgType | ''
	country: CountryCode | ''
	city: string
	province: string
	publicBio: string
}

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
	visibleText: string
}

const MAX_QUERY = 200
const MAX_CANDIDATES = 5
const MAX_HTML_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 20
const USER_AGENT = 'BeamioOnboardingLookup/1.0'
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,ja;q=0.6,de;q=0.5,fr;q=0.4'
const VISIBLE_PER_PAGE = 4_000
const VISIBLE_TOTAL = 12_000
const MAX_NAME_SITES = 3
const MAX_EXTRA_LANG_URL = 2
const MAX_EXTRA_LANG_NAME = 1

const rateByIp = new Map<string, { windowStart: number; count: number }>()

/** Mirrors Merchant OS `onboardingRegions.ts` — independent copy. */
const REGIONS_BY_COUNTRY: Record<CountryCode, readonly { value: string; label: string }[]> = {
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

const EXTRA_PROVINCE_ALIASES: Record<CountryCode, Record<string, string>> = {
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

const COUNTRY_ALIASES: Record<string, CountryCode> = {
	canada: 'CA',
	can: 'CA',
	kanada: 'CA',
	加拿大: 'CA',
	カナダ: 'CA',
	'united states': 'US',
	usa: 'US',
	'united states of america': 'US',
	america: 'US',
	美国: 'US',
	美國: 'US',
	アメリカ: 'US',
	'united kingdom': 'GB',
	uk: 'GB',
	'great britain': 'GB',
	britain: 'GB',
	england: 'GB',
	英国: 'GB',
	英國: 'GB',
	イギリス: 'GB',
	australia: 'AU',
	澳洲: 'AU',
	澳大利亚: 'AU',
	澳大利亞: 'AU',
	オーストラリア: 'AU',
	germany: 'DE',
	deutschland: 'DE',
	德国: 'DE',
	德國: 'DE',
	ドイツ: 'DE',
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
					country: { type: 'string' as const, enum: [...COUNTRIES, SCHEMA_UNKNOWN] },
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
				},
				required: ['name'],
			},
		},
	},
	required: ['candidates'],
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

function isSameApexHost(a: string, b: string): boolean {
	return apexHost(a) === apexHost(b)
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
}

function walkJsonLd(
	node: unknown,
	acc: { name: string; desc: string; city: string; region: string; country: string; url: string },
): void {
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
	const isBiz = /organization|localbusiness|restaurant|store|cafe|brand/i.test(typeStr)
	if (isBiz || !acc.name) {
		if (typeof o.name === 'string' && o.name.trim() && !acc.name) acc.name = o.name.trim()
		if (typeof o.description === 'string' && o.description.trim() && !acc.desc) acc.desc = o.description.trim()
		if (typeof o.url === 'string' && o.url.trim() && !acc.url) acc.url = o.url.trim()
	}
	const addr = o.address
	if (addr && typeof addr === 'object') {
		const a = addr as Record<string, unknown>
		if (typeof a.addressLocality === 'string' && !acc.city) acc.city = a.addressLocality
		if (typeof a.addressRegion === 'string' && !acc.region) acc.region = a.addressRegion
		if (typeof a.addressCountry === 'string' && !acc.country) acc.country = a.addressCountry
	}
}

function parseHtmlMeta(html: string, pageUrl: string): ScrapeMeta {
	const acc = { name: '', desc: '', city: '', region: '', country: '', url: '' }
	const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []
	for (const block of ldBlocks) {
		const body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
		try {
			walkJsonLd(JSON.parse(body), acc)
		} catch {
			/* ignore malformed json-ld */
		}
	}
	const ogTitle = metaContent(html, 'og:title')
	const ogDesc = metaContent(html, 'og:description')
	const ogUrl = metaContent(html, 'og:url')
	const ogSite = metaContent(html, 'og:site_name')
	const title = acc.name || ogTitle || titleTag(html) || ogSite
	return {
		finalUrl: acc.url || ogUrl || pageUrl,
		title: clip(title, 120),
		description: clip(acc.desc || ogDesc, 280),
		siteName: clip(ogSite, 80),
		jsonLdName: clip(acc.name, 120),
		city: clip(acc.city, 80),
		province: clip(acc.region, 80),
		country: clip(acc.country, 40),
	}
}

function htmlToPageSource(
	html: string,
	pageUrl: string,
	visibleBudget: number,
	headerLang = '',
): PageSource {
	const meta = parseHtmlMeta(html, pageUrl)
	return {
		url: meta.finalUrl || pageUrl,
		lang: htmlLang(html, headerLang),
		title: meta.title,
		description: meta.description,
		siteName: meta.siteName,
		jsonLdName: meta.jsonLdName,
		city: meta.city,
		province: meta.province,
		country: meta.country,
		visibleText: extractVisibleText(html, visibleBudget),
	}
}

async function fetchHtmlSafe(
	start: URL,
	hopsLeft: number,
): Promise<{ url: string; html: string; contentLang: string } | null> {
	if (hopsLeft < 0) return null
	if (!(await assertPublicHost(start))) return null
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
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
			return fetchHtmlSafe(next, hopsLeft - 1)
		}
		if (!res.ok) return null
		const ctype = (res.headers.get('content-type') || '').toLowerCase()
		if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) return null
		const buf = Buffer.from(await res.arrayBuffer())
		if (buf.length > MAX_HTML_BYTES) return null
		return {
			url: start.toString(),
			html: decodeHtmlBytes(buf, ctype),
			contentLang: (res.headers.get('content-language') || '').trim(),
		}
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

async function collectPageSources(start: URL, maxExtraLang: number): Promise<PageSource[]> {
	const fetched = await fetchHtmlSafe(start, MAX_REDIRECTS)
	if (!fetched) return []
	const primary = htmlToPageSource(
		fetched.html,
		fetched.url,
		Math.min(VISIBLE_PER_PAGE, VISIBLE_TOTAL),
		fetched.contentLang,
	)
	const extras = pickAlternateLangUrls(fetched.html, fetched.url, maxExtraLang)
	const extraPages = await Promise.all(extras.map((u) => fetchHtmlSafe(u, MAX_REDIRECTS)))
	const sources = [primary]
	let used = primary.visibleText.length
	for (const extra of extraPages) {
		if (!extra) continue
		const budget = Math.min(VISIBLE_PER_PAGE, VISIBLE_TOTAL - used)
		if (budget < 200) break
		const page = htmlToPageSource(extra.html, extra.url, budget, extra.contentLang)
		sources.push(page)
		used += page.visibleText.length
	}
	return sources
}

export function normalizeCountry(raw: string): CountryCode | '' {
	const s = raw.trim()
	if (!s || /^unknown$/i.test(s)) return ''
	const upper = s.toUpperCase()
	if ((COUNTRIES as readonly string[]).includes(upper)) return upper as CountryCode
	const lower = s.toLowerCase()
	if (COUNTRY_ALIASES[lower]) return COUNTRY_ALIASES[lower]
	if (COUNTRY_ALIASES[s]) return COUNTRY_ALIASES[s]
	return ''
}

export function normalizeProvince(country: CountryCode | '', raw: string): string {
	if (!country) return ''
	const regions = REGIONS_BY_COUNTRY[country]
	const t = raw.trim()
	if (!t) return ''
	const upper = t.toUpperCase()
	if (regions.some((r) => r.value === upper)) return upper
	const f = foldKey(t)
	const byLabel = regions.find((r) => foldKey(r.label) === f || foldKey(r.value) === f)
	if (byLabel) return byLabel.value
	const extras = EXTRA_PROVINCE_ALIASES[country]
	for (const [alias, code] of Object.entries(extras)) {
		if (foldKey(alias) === f) return code
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
	咖啡: 'food-beverage',
	餐厅: 'food-beverage',
	餐廳: 'food-beverage',
	餐饮: 'food-beverage',
	餐飲: 'food-beverage',
	美食: 'food-beverage',
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
	return ''
}

function sanitizeWebsite(raw: string): string {
	const u = parsePublicHttpUrl(raw)
	if (!u) return ''
	if (u.protocol !== 'https:') return ''
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
		visibleText: s.visibleText,
	}))
}

const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'] as const

type GeminiJsonResult = { status: 'no_key' } | { status: 'failed' } | { status: 'ok'; items: unknown[] }

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
): Promise<GeminiJsonResult> {
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

async function askGeminiDiscover(
	query: string,
): Promise<{ failed: boolean; list: { name: string; website: string }[] }> {
	const prompt = `You help Beamio Merchant OS find public businesses from a name query.
Query: ${JSON.stringify(query)}
Return up to ${MAX_CANDIDATES} real public businesses. name must be English (official English name, or a reasonable English transliteration). website must be the official https URL if you know it from public knowledge, otherwise empty. Do not invent private IPs, localhost, or non-https websites. Do not invent a website you are not reasonably sure of.`
	const result = await geminiJson(prompt, DISCOVER_SCHEMA)
	if (result.status !== 'ok') return { failed: true, list: [] }
	const out: { name: string; website: string }[] = []
	for (const item of result.items) {
		if (!item || typeof item !== 'object') continue
		const o = item as Record<string, unknown>
		const name = clip(String(o.name ?? ''), 120)
		if (name.length < 2) continue
		out.push({ name, website: sanitizeWebsite(String(o.website ?? '')) })
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
- country: only CA | US | GB | AU | DE. Use "unknown" if missing or not in that list. Do not invent Canada.
- province: region CODE only (BC, ON, CA, NY, ENG, NSW, BY) matching that country. Use "" if unknown. Never write the full English name.
- channelKind: physical | digital | app, or "unknown"
- physical categories: ${PHYSICAL_CATS.join(', ')}
- digital categories: ${DIGITAL_CATS.join(', ')}
- app categories: ${APP_CATS.join(', ')}
- orgType: sme | franchise | ngo, or "unknown"
- website must be an https URL that appears in the sources or the query. Use "" if unknown. Never invent a different website.
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

function discoveredToCandidates(list: { name: string; website: string }[]): OnboardingBusinessLookupCandidate[] {
	return list.map((d, i) => ({
		id: `discover-${i + 1}`,
		name: d.name,
		website: d.website,
		snippet: '',
		channelKind: '' as const,
		category: '',
		orgType: '' as const,
		country: '' as const,
		city: '',
		province: '',
		publicBio: '',
	}))
}

export async function onboardingBusinessLookupHandler(req: Request, res: Response): Promise<void> {
	const ip = getClientIp(req) || req.ip || 'unknown'
	if (!takeRate(ip)) {
		res.status(429).json({ ok: false, error: 'rate_limited' })
		return
	}
	const query = clip(String((req.body as { query?: unknown })?.query ?? ''), MAX_QUERY)
	if (query.length < 2) {
		res.status(400).json({ ok: false, error: 'query_required' })
		return
	}
	logger(Colors.cyan('[onboardingBusinessLookup]'), clip(query, 80), ip)

	let sources: PageSource[] = []
	let discovered: { name: string; website: string }[] = []
	let discoverFailed = false
	let singleSiteFallback = ''

	if (looksLikeWebsiteQuery(query)) {
		const start = parsePublicHttpUrl(query)
		if (start) {
			sources = await collectPageSources(start, MAX_EXTRA_LANG_URL)
		}
	} else {
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
		const batches = await Promise.all(urls.map((u) => collectPageSources(u, MAX_EXTRA_LANG_NAME)))
		sources = batches.flat()
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

	if (analyzed.length) {
		res.json({ ok: true, candidates: dedupe(analyzed) })
		return
	}
	const fallback = discoveredToCandidates(discovered)
	if (fallback.length) {
		res.json({ ok: true, candidates: dedupe(fallback) })
		return
	}
	if (discoverFailed || analyzeFailed) {
		logger(Colors.yellow('[onboardingBusinessLookup] ai_unavailable'))
		res.json({ ok: false, error: 'ai_unavailable' })
		return
	}
	res.json({ ok: true, candidates: [] })
}
