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
	marketplaceVenueName,
	mergeDiscoverHopSources,
	overlayScrapedVenueForWebsiteQuery,
	preferNonChromeCandidateNames,
	scrapeLooksLikeListingChrome,
	shopListingSlug,
	venueNameFromReviewsForPhrase,
	type OnboardingBusinessLookupCandidate,
} from './onboardingBusinessLookup.js'

const ZOMI_LONGDHANG = 'https://www.zomi.menu/shop/longdhang'

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

const FANTUAN_OPAQUE =
	'https://order.fantuan.ca/zh-CN/store/Restaurant/ca-1725834231'

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
	it('treats ca-1725834231 as an opaque listing id', () => {
		assert.equal(looksLikeOpaqueListingId('ca-1725834231'), true)
		assert.equal(looksLikeOpaqueListingId('longdhang'), false)
		assert.equal(looksLikeOpaqueListingId('coco-fresh-tea-juice'), false)
	})

	it('treats category+opaque path as an opaque listing page', () => {
		assert.equal(looksLikeOpaqueListingPageUrl(FANTUAN_OPAQUE), true)
		assert.equal(looksLikeOpaqueListingPageUrl(ZOMI_LONGDHANG), false)
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
