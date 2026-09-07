"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerIssuedCouponSeriesQueryCacheInvalidator = registerIssuedCouponSeriesQueryCacheInvalidator;
exports.invalidateIssuedCouponSeriesQueryCachesForCard = invalidateIssuedCouponSeriesQueryCachesForCard;
const ethers_1 = require("ethers");
const invalidators = [];
/** Cluster / Master register their in-memory cache clear hooks at module load. */
function registerIssuedCouponSeriesQueryCacheInvalidator(fn) {
    invalidators.push(fn);
}
/** Notify all registered cache layers after beamio_nft_series registration or metadata update. */
function invalidateIssuedCouponSeriesQueryCachesForCard(cardNorm, issuedTokenId) {
    const lo = ethers_1.ethers.getAddress(cardNorm).toLowerCase();
    for (const fn of invalidators) {
        try {
            fn(lo, issuedTokenId);
        }
        catch {
            /* ignore hook failures */
        }
    }
}
