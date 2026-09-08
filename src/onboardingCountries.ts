/**
 * ISO 3166-1 alpha-2 countries for Merchant OS onboarding lookup.
 * Independent copy — do not import from bizSiteMerchant.
 */

const EXCLUDE_REGION_CODES = new Set([
	'AN',
	'BU',
	'CS',
	'DD',
	'DY',
	'EU',
	'EZ',
	'FX',
	'HV',
	'NH',
	'QO',
	'RH',
	'SU',
	'TP',
	'UN',
	'VD',
	'XA',
	'XB',
	'YD',
	'YU',
	'ZR',
	'ZZ',
])

const COUNTRY_ALIASES: Record<string, string> = {
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
	china: 'CN',
	prc: 'CN',
	cn: 'CN',
	'peoples republic of china': 'CN',
	"people's republic of china": 'CN',
	中国: 'CN',
	中國: 'CN',
	中国大陆: 'CN',
	中國大陸: 'CN',
	japan: 'JP',
	日本: 'JP',
	korea: 'KR',
	'south korea': 'KR',
	韩国: 'KR',
	韓國: 'KR',
	'north korea': 'KP',
	taiwan: 'TW',
	台湾: 'TW',
	台灣: 'TW',
	hongkong: 'HK',
	'hong kong': 'HK',
	香港: 'HK',
	macau: 'MO',
	macao: 'MO',
	澳门: 'MO',
	澳門: 'MO',
	singapore: 'SG',
	新加坡: 'SG',
	india: 'IN',
	印度: 'IN',
	france: 'FR',
	法国: 'FR',
	法國: 'FR',
	italy: 'IT',
	意大利: 'IT',
	spain: 'ES',
	西班牙: 'ES',
	mexico: 'MX',
	墨西哥: 'MX',
	brazil: 'BR',
	巴西: 'BR',
	netherlands: 'NL',
	荷兰: 'NL',
	荷蘭: 'NL',
	ireland: 'IE',
	爱尔兰: 'IE',
	愛爾蘭: 'IE',
	'new zealand': 'NZ',
	新西兰: 'NZ',
	新西蘭: 'NZ',
}

function foldCountryKey(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function displayNames(): Intl.DisplayNames {
	return new Intl.DisplayNames(['en'], { type: 'region' })
}

function buildCountryOptions(): { value: string; label: string }[] {
	const dn = displayNames()
	const out: { value: string; label: string }[] = []
	for (let a = 65; a <= 90; a++) {
		for (let b = 65; b <= 90; b++) {
			const code = String.fromCharCode(a) + String.fromCharCode(b)
			if (EXCLUDE_REGION_CODES.has(code) || code === 'UK') continue
			const label = dn.of(code)
			if (!label || label === code) {
				if (code === 'XK') out.push({ value: 'XK', label: 'Kosovo' })
				continue
			}
			out.push({ value: code, label })
		}
	}
	out.sort((x, y) => x.label.localeCompare(y.label, 'en'))
	return out
}

let cachedOptions: { value: string; label: string }[] | null = null
let cachedCodeSet: Set<string> | null = null

export function onboardingCountryOptions(): readonly { value: string; label: string }[] {
	if (!cachedOptions) cachedOptions = buildCountryOptions()
	return cachedOptions
}

function countryCodeSet(): Set<string> {
	if (!cachedCodeSet) {
		cachedCodeSet = new Set(onboardingCountryOptions().map((o) => o.value))
	}
	return cachedCodeSet
}

export function isOnboardingCountryCode(code: string): boolean {
	return countryCodeSet().has(code.toUpperCase())
}

export function onboardingCountryLabel(code: string): string {
	const upper = code.trim().toUpperCase()
	const hit = onboardingCountryOptions().find((o) => o.value === upper)
	if (hit) return hit.label
	try {
		const label = displayNames().of(upper)
		if (label && label !== upper) return label
	} catch {
		/* ignore */
	}
	return upper
}

export function normalizeOnboardingCountryCode(raw: string): string {
	const s = raw.trim()
	if (!s || /^unknown$/i.test(s)) return ''
	const upper = s.toUpperCase()
	if (upper === 'UK') return 'GB'
	if (isOnboardingCountryCode(upper)) return upper
	const lower = s.toLowerCase()
	const folded = foldCountryKey(s)
	const alias = COUNTRY_ALIASES[lower] || COUNTRY_ALIASES[folded] || COUNTRY_ALIASES[s]
	if (alias && isOnboardingCountryCode(alias)) return alias
	for (const o of onboardingCountryOptions()) {
		if (foldCountryKey(o.label) === folded || foldCountryKey(o.value) === folded) return o.value
	}
	return ''
}
