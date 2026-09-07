"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLatestCardsQueryCacheInvalidator = registerLatestCardsQueryCacheInvalidator;
exports.invalidateLatestCardsQueryCaches = invalidateLatestCardsQueryCaches;
const invalidators = [];
/** Master registers its in-memory latestCards / cardsByCategory cache clear hook at module load. */
function registerLatestCardsQueryCacheInvalidator(fn) {
    invalidators.push(fn);
}
/**
 * Call after a trusted `beamio_cards` INSERT/UPDATE so Discover `/api/latestCards`
 * does not serve a 30s stale list that omits the new card.
 */
function invalidateLatestCardsQueryCaches() {
    for (const fn of invalidators) {
        try {
            fn();
        }
        catch {
            /* ignore hook failures */
        }
    }
}
