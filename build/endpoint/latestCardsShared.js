"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISCOVER_FEATURED_PINNED_CARD_ADDRESSES = exports.DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_MS = exports.DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_ISO = exports.LATEST_CARDS_EXCLUDED = void 0;
exports.passDiscoverFeaturedBrandsMerchantCardPolicy = passDiscoverFeaturedBrandsMerchantCardPolicy;
exports.passDiscoverMerchantCardPolicy = passDiscoverMerchantCardPolicy;
exports.filterLatestCardsByDiscoverMerchantPolicy = filterLatestCardsByDiscoverMerchantPolicy;
exports.orderLatestCardsWithDiscoverPins = orderLatestCardsWithDiscoverPins;
const ethers_1 = require("ethers");
const apiExcludedUserCards_1 = require("../apiExcludedUserCards");
/**
 * Featured Brands / Discover 商户可见性 — **全项目唯一标准**（见 `.cursor/rules/beamio-discover-merchant-visibility-single-standard.mdc`）。
 *
 * Gate 第一步：`isApiExcludedUserCard`（含废弃 infrastructure 卡 `0xBCcfA50…`、CCSA 卡 `0x2032A363…` 及 `apiExcludedUserCards.ts` 全集）。
 * 适用：Featured Brands、`/api/latestCards`、公开优惠券列表等 **对外 Discover 展示**。
 * 不适用：用户已持有资产、POS 终端绑定卡、必填 `cardAddress` 的写操作预检（仍可用 `isApiExcludedUserCard` 硬拒绝废弃地址）。
 */
/** @deprecated 请改用 `passDiscoverFeaturedBrandsMerchantCardPolicy`；保留别名供存量 import。 */
var apiExcludedUserCards_2 = require("../apiExcludedUserCards");
Object.defineProperty(exports, "LATEST_CARDS_EXCLUDED", { enumerable: true, get: function () { return apiExcludedUserCards_2.API_EXCLUDED_USER_CARD_ADDRESSES; } });
/** 此时间点（含）之后 `beamio_cards.created_at` 的新发卡默认对 Discover 可见。 */
exports.DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_ISO = '2026-05-23T00:30:00.000Z';
exports.DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_MS = Date.parse(exports.DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_ISO);
/**
 * Featured Brands Discover 可见性（唯一 gate）：`apiExcludedUserCards` exclude + 发卡时间 cutover。
 */
function passDiscoverFeaturedBrandsMerchantCardPolicy(card) {
    const cardAddress = (card.cardAddress || '').trim();
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return false;
    if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(cardAddress))
        return false;
    const createdAtMs = Date.parse(String(card.createdAt ?? ''));
    return Number.isFinite(createdAtMs) && createdAtMs >= exports.DISCOVER_NEW_MERCHANT_CARD_ALLOW_AFTER_MS;
}
/** @deprecated 内部 cutover 子规则；新代码请用 `passDiscoverFeaturedBrandsMerchantCardPolicy`。 */
function passDiscoverMerchantCardPolicy(card) {
    return passDiscoverFeaturedBrandsMerchantCardPolicy(card);
}
function filterLatestCardsByDiscoverMerchantPolicy(cards) {
    return cards.filter((c) => passDiscoverFeaturedBrandsMerchantCardPolicy(c));
}
/**
 * Featured Brands merchandising pin (All list / `/api/latestCards` order).
 * Visibility still goes through {@link passDiscoverFeaturedBrandsMerchantCardPolicy} first —
 * a pinned address that fails the gate is omitted, not forced visible.
 */
exports.DISCOVER_FEATURED_PINNED_CARD_ADDRESSES = [
    '0x6e600DfaEa5eD006A97aF2AD080518c1d06C0A74',
];
function orderLatestCardsWithDiscoverPins(cards) {
    const pinnedSet = new Set(exports.DISCOVER_FEATURED_PINNED_CARD_ADDRESSES.map((a) => a.toLowerCase()));
    const pinnedByLower = new Map();
    const rest = [];
    for (const card of cards) {
        const lc = (card.cardAddress || '').trim().toLowerCase();
        if (lc && pinnedSet.has(lc) && !pinnedByLower.has(lc)) {
            pinnedByLower.set(lc, card);
            continue;
        }
        rest.push(card);
    }
    const pinnedOrdered = exports.DISCOVER_FEATURED_PINNED_CARD_ADDRESSES.flatMap((addr) => {
        const hit = pinnedByLower.get(addr.toLowerCase());
        return hit ? [hit] : [];
    });
    return [...pinnedOrdered, ...rest];
}
