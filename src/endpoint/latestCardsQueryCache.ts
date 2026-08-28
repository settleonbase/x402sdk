type LatestCardsQueryCacheInvalidator = () => void

const invalidators: LatestCardsQueryCacheInvalidator[] = []

/** Master registers its in-memory latestCards / cardsByCategory cache clear hook at module load. */
export function registerLatestCardsQueryCacheInvalidator(fn: LatestCardsQueryCacheInvalidator): void {
	invalidators.push(fn)
}

/**
 * Call after a trusted `beamio_cards` INSERT/UPDATE so Discover `/api/latestCards`
 * does not serve a 30s stale list that omits the new card.
 */
export function invalidateLatestCardsQueryCaches(): void {
	for (const fn of invalidators) {
		try {
			fn()
		} catch {
			/* ignore hook failures */
		}
	}
}
