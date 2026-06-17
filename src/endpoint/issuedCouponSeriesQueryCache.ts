import { ethers } from 'ethers'

type IssuedCouponSeriesCacheInvalidator = (cardLower: string, issuedTokenId?: string) => void

const invalidators: IssuedCouponSeriesCacheInvalidator[] = []

/** Cluster / Master register their in-memory cache clear hooks at module load. */
export function registerIssuedCouponSeriesQueryCacheInvalidator(fn: IssuedCouponSeriesCacheInvalidator): void {
	invalidators.push(fn)
}

/** Notify all registered cache layers after beamio_nft_series registration or metadata update. */
export function invalidateIssuedCouponSeriesQueryCachesForCard(cardNorm: string, issuedTokenId?: string): void {
	const lo = ethers.getAddress(cardNorm).toLowerCase()
	for (const fn of invalidators) {
		try {
			fn(lo, issuedTokenId)
		} catch {
			/* ignore hook failures */
		}
	}
}
