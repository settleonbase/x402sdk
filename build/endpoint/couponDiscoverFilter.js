"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterCouponSeriesRowsByDiscoverMerchantPolicy = filterCouponSeriesRowsByDiscoverMerchantPolicy;
exports.isCouponCardDiscoverVisible = isCouponCardDiscoverVisible;
const ethers_1 = require("ethers");
const db_1 = require("../db");
const latestCardsShared_1 = require("./latestCardsShared");
/** Filter coupon rows with the same gate as Featured Brands (`latestCardsShared.ts`). */
async function filterCouponSeriesRowsByDiscoverMerchantPolicy(rows) {
    const visibilityByCard = new Map();
    const out = [];
    for (const row of rows) {
        const raw = row.cardAddress?.trim();
        if (!raw || !ethers_1.ethers.isAddress(raw))
            continue;
        const lower = ethers_1.ethers.getAddress(raw).toLowerCase();
        if (!visibilityByCard.has(lower)) {
            const createdAt = await (0, db_1.getCardCreatedAtByAddress)(lower);
            visibilityByCard.set(lower, (0, latestCardsShared_1.passDiscoverFeaturedBrandsMerchantCardPolicy)({ cardAddress: lower, createdAt }));
        }
        if (visibilityByCard.get(lower))
            out.push(row);
    }
    return out;
}
async function isCouponCardDiscoverVisible(cardAddress) {
    const raw = cardAddress?.trim();
    if (!raw || !ethers_1.ethers.isAddress(raw))
        return false;
    const checksum = ethers_1.ethers.getAddress(raw);
    const createdAt = await (0, db_1.getCardCreatedAtByAddress)(checksum);
    return (0, latestCardsShared_1.passDiscoverFeaturedBrandsMerchantCardPolicy)({ cardAddress: checksum, createdAt });
}
