import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	humanizeMarketplaceSlug,
	isMarketplaceListingUrl,
	listingVenueDisplayName,
	marketplaceVenueName,
	shopListingSlug,
	venueNameFromReviewsForPhrase,
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
