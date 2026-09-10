import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isStealthChallengeHtml } from './stealthBrowserChallenge.js'
import {
	humanizeMarketplaceSlug,
	isMarketplaceListingUrl,
	listingVenueDisplayName,
	looksLikeGenericMarketplaceSnippet,
	looksLikeNonVenueListingLabel,
	looksLikeOpaqueListingId,
	looksLikeOpaqueListingPageUrl,
	looksLikeLocalePathSegment,
	looksLikeWebsiteQuery,
	marketplaceVenueName,
	mergeDiscoverHopSources,
	overlayScrapedVenueForWebsiteQuery,
	preferNonChromeCandidateNames,
	scrapeLooksLikeListingChrome,
	shopListingSlug,
	venueNameFromReviewsForPhrase,
	extractVisibleContact,
	type OnboardingBusinessLookupCandidate,
} from './onboardingBusinessLookup.js'

const ZOMI_LONGDHANG = 'https://www.zomi.menu/shop/longdhang'
const AMAZON_PROTEAR =
	'https://www.amazon.ca/stores/PROTEAR/page/982EFF4B-8533-447D-B482-533338ED3C9E?lp_asin=B0HGD4BYDX'

const longdhangDescription =
	'See reviews, hours and location for LONGDHANG in Richmond, plus popular picks curated from the most-ordered and most-talked-about dishes across the web – starting with favourites like Chinese Rice'

describe('zomi.menu shop listing name', () => {
	it('treats zomi.menu URLs as marketplace listings', () => {
		assert.equal(isMarketplaceListingUrl(ZOMI_LONGDHANG), true)
	})

	it('reads /shop/{slug} even when the slug has no hyphen', () => {
		assert.equal(shopListingSlug(ZOMI_LONGDHANG), 'longdhang')
		assert.equal(marketplaceVenueName(ZOMI_LONGDHANG), 'Longdhang')
		assert.equal(humanizeMarketplaceSlug('longdhang'), 'Longdhang')
	})

	it('extracts LONGDHANG from the reviews-for phrase', () => {
		assert.equal(venueNameFromReviewsForPhrase(longdhangDescription), 'LONGDHANG')
	})

	it('uses the shop name, not og:site_name ZOMI', () => {
		const name = listingVenueDisplayName({
			url: ZOMI_LONGDHANG,
			title: 'LONGDHANG - Chinese in Richmond | ZOMI',
			description: longdhangDescription,
			siteName: 'ZOMI',
			jsonLdName: 'ZOMI',
		})
		assert.equal(name, 'LONGDHANG')
		assert.notEqual(name.toLowerCase(), 'zomi')
	})

	it('falls back to title left of the platform suffix when description has no phrase', () => {
		const name = listingVenueDisplayName({
			url: ZOMI_LONGDHANG,
			title: 'LONGDHANG - Chinese in Richmond | ZOMI',
			description: 'Order online from a Richmond restaurant.',
			siteName: 'ZOMI',
			jsonLdName: 'ZOMI',
		})
		assert.equal(name, 'LONGDHANG')
	})

	it('falls back to the shop slug when title and jsonLd are the platform brand', () => {
		const name = listingVenueDisplayName({
			url: ZOMI_LONGDHANG,
			title: 'ZOMI',
			description: '',
			siteName: 'ZOMI',
			jsonLdName: 'ZOMI',
		})
		assert.equal(name, 'Longdhang')
	})

	it('does not invent a venue from the zomi homepage', () => {
		const name = listingVenueDisplayName({
			url: 'https://www.zomi.menu/',
			title: 'ZOMI',
			description: longdhangDescription,
			siteName: 'ZOMI',
			jsonLdName: 'ZOMI',
		})
		assert.equal(name, '')
	})
})

describe('Amazon Brand Store listing name', () => {
	it('recognizes Amazon Brand Store URLs and extracts the brand slug', () => {
		assert.equal(isMarketplaceListingUrl(AMAZON_PROTEAR), true)
		assert.equal(shopListingSlug(AMAZON_PROTEAR), 'protear')
		assert.equal(marketplaceVenueName(AMAZON_PROTEAR), 'PROTEAR')
	})

	it('does not treat Amazon platform chrome as the merchant', () => {
		assert.equal(looksLikeNonVenueListingLabel('Amazon.ca', AMAZON_PROTEAR), true)
		assert.equal(
			scrapeLooksLikeListingChrome({
				url: AMAZON_PROTEAR,
				title: 'Amazon.ca: PROTEAR Store',
				description: 'PROTEAR HEARING PROTECTION WITH ENTERTAINMENT',
				siteName: 'Amazon.ca',
				jsonLdName: 'Amazon.ca',
				visibleText: 'PROTEAR HEARING PROTECTION WITH ENTERTAINMENT',
			}),
			true,
		)
	})

	it('keeps the Amazon brand and removes the marketplace URL', () => {
		const out = overlayScrapedVenueForWebsiteQuery(AMAZON_PROTEAR, [
			emptyPage({
				url: AMAZON_PROTEAR,
				title: 'Amazon.ca: PROTEAR Store',
				description: 'PROTEAR HEARING PROTECTION WITH ENTERTAINMENT',
				siteName: 'Amazon.ca',
				jsonLdName: 'Amazon.ca',
				visibleText: 'PROTEAR HEARING PROTECTION WITH ENTERTAINMENT',
			}),
		], [
			emptyCand({
				name: 'PROTEAR',
				website: AMAZON_PROTEAR,
				snippet: 'Hearing protection products.',
			}),
		])
		assert.equal(out.length, 1)
		assert.equal(out[0].name, 'PROTEAR')
		assert.equal(out[0].website, '')
	})
})

const FANTUAN_OPAQUE =
	'https://order.fantuan.ca/zh-CN/store/Restaurant/ca-1725834231'

const ALIBABA_TRACKING_URL =
	'https://detail.1688.com/offer/1032130276764.html?spm=a26352.13672862.offerlist.4.30771e62DeUUMZ&offerId=1032130276764&sortType=&pageId=&abBizDataType=cbuOffer&hotSaleSkuId=6246554422850&trace_log=normal&uuid=23aa3ee30337414fb55c2a3a40d7f07b&forcePC=1788987455998'

function emptyPage(partial: Record<string, string>) {
	return {
		url: '',
		lang: 'en',
		title: '',
		description: '',
		siteName: '',
		jsonLdName: '',
		city: '',
		province: '',
		country: '',
		street: '',
		phone: '',
		email: '',
		postalCode: '',
		visibleText: '',
		...partial,
	}
}

function emptyCand(
	partial: Partial<OnboardingBusinessLookupCandidate>,
): OnboardingBusinessLookupCandidate {
	return {
		id: 'c1',
		name: '',
		website: '',
		snippet: '',
		channelKind: '',
		category: '',
		orgType: '',
		country: '',
		city: '',
		province: '',
		publicBio: '',
		street: '',
		phone: '',
		email: '',
		postalCode: '',
		...partial,
	}
}

describe('host-agnostic listing chrome', () => {
	it('accepts marketplace URLs with tracking parameters', () => {
		assert.equal(ALIBABA_TRACKING_URL.length > 200, true)
		assert.equal(looksLikeWebsiteQuery(ALIBABA_TRACKING_URL), true)
	})

	it('treats ca-1725834231 as an opaque listing id', () => {
		assert.equal(looksLikeOpaqueListingId('ca-1725834231'), true)
		assert.equal(looksLikeOpaqueListingId('longdhang'), false)
		assert.equal(looksLikeOpaqueListingId('coco-fresh-tea-juice'), false)
	})

	it('treats category+opaque path as an opaque listing page', () => {
		assert.equal(looksLikeOpaqueListingPageUrl(FANTUAN_OPAQUE), true)
		assert.equal(looksLikeOpaqueListingPageUrl(ZOMI_LONGDHANG), false)
	})

	it('does not treat locale path segments as shop slugs (Fantuan /zh-CN/…)', () => {
		assert.equal(looksLikeLocalePathSegment('zh-CN'), true)
		assert.equal(looksLikeLocalePathSegment('en_US'), true)
		assert.equal(looksLikeLocalePathSegment('coco-fresh-tea-juice'), false)
		assert.equal(shopListingSlug(FANTUAN_OPAQUE), '')
		assert.equal(marketplaceVenueName(FANTUAN_OPAQUE), '')
	})

	it('does not treat a real storefront name as listing chrome', () => {
		assert.equal(looksLikeNonVenueListingLabel('CoCo Richmond Center'), false)
		assert.equal(looksLikeNonVenueListingLabel('LONGDHANG'), false)
		assert.equal(looksLikeNonVenueListingLabel('Restaurant ca-1725834231', FANTUAN_OPAQUE), true)
		assert.equal(looksLikeNonVenueListingLabel('Home'), false)
	})

	it('flags generic delivery template blurbs', () => {
		assert.equal(
			looksLikeGenericMarketplaceSnippet(
				'This restaurant is available for online delivery and pickup on Fantuan.',
			),
			true,
		)
		assert.equal(looksLikeGenericMarketplaceSnippet('Order online from a Richmond restaurant.'), true)
		assert.equal(
			looksLikeGenericMarketplaceSnippet('CoCo serves bubble tea at Richmond Centre.'),
			false,
		)
	})

	it('readable shop slugs are not listing chrome (Zomi overlay still recovers LONGDHANG)', () => {
		assert.equal(
			scrapeLooksLikeListingChrome({
				url: ZOMI_LONGDHANG,
				title: 'ZOMI',
				description: 'Order online from a Richmond restaurant.',
				siteName: 'ZOMI',
				jsonLdName: 'ZOMI',
			}),
			false,
		)
	})

	it('opaque category+id titles are listing chrome', () => {
		assert.equal(
			scrapeLooksLikeListingChrome({
				url: FANTUAN_OPAQUE,
				title: 'Restaurant ca-1725834231',
				description: 'This restaurant is available for online delivery and pickup on Fantuan.',
				siteName: 'Fantuan',
				jsonLdName: 'Restaurant ca-1725834231',
				visibleText: 'This restaurant is available for online delivery and pickup on Fantuan.',
			}),
			true,
		)
	})
})

describe('overlay does not copy listing chrome over Gemini', () => {
	it('keeps the AI storefront name on an opaque listing scrape', () => {
		const sources = [
			emptyPage({
				url: FANTUAN_OPAQUE,
				title: 'Restaurant ca-1725834231',
				description: 'This restaurant is available for online delivery and pickup on Fantuan.',
				siteName: 'Fantuan',
				jsonLdName: 'Restaurant ca-1725834231',
				visibleText: 'This restaurant is available for online delivery and pickup on Fantuan.',
			}),
		]
		const out = overlayScrapedVenueForWebsiteQuery(FANTUAN_OPAQUE, sources, [
			emptyCand({
				name: 'CoCo Richmond Center',
				website: 'https://www.coco-tea.com/',
				snippet: 'Bubble tea shop at Richmond Centre.',
			}),
		])
		assert.equal(out.length, 1)
		assert.equal(out[0].name, 'CoCo Richmond Center')
		assert.equal(out[0].website, 'https://www.coco-tea.com/')
		assert.notEqual(out[0].name, 'Restaurant ca-1725834231')
	})

	it('overlays LONGDHANG but keeps a better Gemini snippet over a generic delivery blurb', () => {
		const sources = [
			emptyPage({
				url: ZOMI_LONGDHANG,
				title: 'LONGDHANG - Chinese in Richmond | ZOMI',
				description: 'Order online from a Richmond restaurant.',
				siteName: 'ZOMI',
				jsonLdName: 'ZOMI',
				visibleText: 'See reviews, hours and location for LONGDHANG in Richmond.',
			}),
		]
		const out = overlayScrapedVenueForWebsiteQuery(ZOMI_LONGDHANG, sources, [
			emptyCand({
				name: 'ZOMI',
				website: '',
				snippet: 'Shanghainese restaurant in Richmond, BC.',
				publicBio: 'Shanghainese restaurant in Richmond, BC.',
			}),
		])
		assert.equal(out.length, 1)
		assert.equal(out[0].name, 'LONGDHANG')
		assert.equal(out[0].snippet, 'Shanghainese restaurant in Richmond, BC.')
	})

	it('still humanizes a readable hyphenated slug', () => {
		assert.equal(humanizeMarketplaceSlug('coco-fresh-tea-juice'), 'Coco Fresh Tea Juice')
	})

	it('drops chrome names when a real venue name is also present', () => {
		const mixed = preferNonChromeCandidateNames(
			[
				emptyCand({ id: 'a', name: 'Restaurant ca-1725834231' }),
				emptyCand({ id: 'b', name: 'CoCo Richmond Center' }),
			],
			FANTUAN_OPAQUE,
		)
		assert.equal(mixed.length, 1)
		assert.equal(mixed[0].name, 'CoCo Richmond Center')
	})

	it('drops all-chrome names so the handler can hop', () => {
		const none = preferNonChromeCandidateNames(
			[emptyCand({ name: 'Restaurant ca-1725834231' })],
			FANTUAN_OPAQUE,
		)
		assert.equal(none.length, 0)
	})

	it('treats zbj.com /fw/{id}.html as an opaque marketplace listing', () => {
		const zbj = 'https://www.zbj.com/fw/1924081.html'
		assert.equal(isMarketplaceListingUrl(zbj), true)
		assert.equal(looksLikeOpaqueListingId('1924081.html'), true)
		assert.equal(looksLikeOpaqueListingId('1924081'), true)
		assert.equal(looksLikeOpaqueListingPageUrl(zbj), true)
		assert.equal(marketplaceVenueName(zbj), '')
		assert.equal(looksLikeNonVenueListingLabel('猪八戒网', zbj), true)
		assert.equal(looksLikeNonVenueListingLabel('Zhubajie', zbj), true)
		assert.equal(
			looksLikeNonVenueListingLabel(
				'猪八戒网(ZBJ.COM)企业外包服务-中国领先的灵活用工平台',
				zbj,
			),
			true,
		)
	})
})

describe('discover hop merge + Aliyun WAF interstitial', () => {
	it('prefers an official hop page over listing chrome', () => {
		const listing = emptyPage({
			url: FANTUAN_OPAQUE,
			title: 'Restaurant ca-1725834231',
			visibleText: 'This restaurant is available for online delivery and pickup on Fantuan.',
		})
		const official = emptyPage({
			url: 'https://www.coco-tea.com/',
			title: 'CoCo Richmond Center',
			visibleText: 'Bubble tea at Richmond Centre.',
		})
		const merged = mergeDiscoverHopSources([listing], [official])
		assert.equal(merged[0].url, 'https://www.coco-tea.com/')
		assert.equal(merged[merged.length - 1].url, FANTUAN_OPAQUE)
	})

	it('treats Aliyun WAF HTML as a stealth interstitial', () => {
		assert.equal(
			isStealthChallengeHtml('<html><script>var x5secdata="1"; aliyun_waf</script></html>'),
			true,
		)
		assert.equal(isStealthChallengeHtml('<html><title>CoCo Richmond Center</title></html>'), false)
	})
})

describe('generic footer contact extraction', () => {
	it('finds a footer address after a large storefront body', () => {
		const html = `<main>${'<p>Product content </p>'.repeat(7_000)}</main>
			<footer>
				<h3>Contact</h3>
				<p>10551 Shellbridge Way, Suite#149<br/>Richmond, BC, V6X 2W9, Canada</p>
				<p>support@maysense.com</p>
			</footer>`
		const contact = extractVisibleContact(html)
		assert.match(contact.street, /10551 Shellbridge Way/i)
		assert.match(contact.street, /Suite#149/i)
		assert.match(contact.street, /Richmond, BC/i)
		assert.equal(contact.postalCode, 'V6X 2W9')
		assert.equal(contact.email, 'support@maysense.com')
	})
})
