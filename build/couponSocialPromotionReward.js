"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COUPON_EVENT_METRIC_KIND = exports.COUPON_SOCIAL_PROMOTION_EVENT_RULE_SLOTS = void 0;
exports.couponSocialPromotionRuleIdForEvent = couponSocialPromotionRuleIdForEvent;
exports.resolveRefWalletDistinct = resolveRefWalletDistinct;
exports.resolveRefWalletForDispatch = resolveRefWalletForDispatch;
exports.readActiveCouponSocialRewardRule = readActiveCouponSocialRewardRule;
exports.resolveCouponBurnRefWallet = resolveCouponBurnRefWallet;
/**
 * Per-issued-coupon L2 social promotion (#13 dispatch) — ruleId + active rule read.
 * Aligns bizSite `programSocialPromotion.ts` slot semantics.
 */
const ethers_1 = require("ethers");
const cardProgramReferrerChain_js_1 = require("./cardProgramReferrerChain.js");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
const userCumulativeStatRewardPool_1 = require("./userCumulativeStatRewardPool");
const db_1 = require("./db");
const couponMetadataCategory_1 = require("./couponMetadataCategory");
/** On-chain rule slot per coupon event (linkClick keeps ruleId = issuedTokenId). */
exports.COUPON_SOCIAL_PROMOTION_EVENT_RULE_SLOTS = {
    linkClick: 0,
    like: 1,
    claim: 2,
    burn: 3,
};
exports.COUPON_EVENT_METRIC_KIND = {
    linkClick: userCumulativeStatRewardPool_1.UC_METRIC.USER_CLICK,
    like: userCumulativeStatRewardPool_1.UC_METRIC.USER_LIKE,
    claim: userCumulativeStatRewardPool_1.UC_METRIC.USER_PURCHASE,
    burn: userCumulativeStatRewardPool_1.UC_METRIC.REF_BURN,
};
const REWARD_RULE_ABI = [
    'function getRewardRule(uint256 ruleId) view returns (bool active, uint8 eventKind, uint8 targetKind, uint256 issuedParentId, uint256 actorMint13, uint256 refMint13)',
];
function couponSocialPromotionRuleIdForEvent(issuedTokenId, eventKey) {
    const base = BigInt(String(issuedTokenId).trim());
    const slot = exports.COUPON_SOCIAL_PROMOTION_EVENT_RULE_SLOTS[eventKey];
    if (slot === 0)
        return base;
    return base * 100n + BigInt(slot);
}
function resolveRefWalletDistinct(actorEOA, refWalletRaw) {
    const raw = refWalletRaw?.trim() ?? '';
    if (!raw || !ethers_1.ethers.isAddress(raw))
        return ethers_1.ethers.ZeroAddress;
    try {
        const ref = ethers_1.ethers.getAddress(raw);
        const actor = ethers_1.ethers.getAddress(actorEOA);
        return ref === actor ? ethers_1.ethers.ZeroAddress : ref;
    }
    catch {
        return ethers_1.ethers.ZeroAddress;
    }
}
function resolveRefWalletForDispatch(actorEOA, refWalletRaw, refMint13) {
    if (refMint13 <= 0n)
        return ethers_1.ethers.ZeroAddress;
    return resolveRefWalletDistinct(actorEOA, refWalletRaw);
}
async function ruleMatchesCouponEvent(reader, ruleId, eventKey, expectedParentId) {
    try {
        const row = (await reader.getRewardRule(ruleId));
        const [active, eventKind, targetKind, issuedParentId, actorMint13, refMint13] = row;
        return (active &&
            Number(eventKind) === exports.COUPON_EVENT_METRIC_KIND[eventKey] &&
            Number(targetKind) === userCumulativeStatRewardPool_1.UC_TARGET.ISSUED_COUPON &&
            BigInt(issuedParentId) === expectedParentId &&
            (actorMint13 > 0n || refMint13 > 0n));
    }
    catch {
        return false;
    }
}
/** Active L2 coupon social #13 rule; null when inactive or untrusted read. */
async function readActiveCouponSocialRewardRule(params) {
    try {
        const card = ethers_1.ethers.getAddress(params.cardAddress);
        const expectedParentId = BigInt(String(params.issuedTokenId).trim());
        const series = await (0, db_1.getSeriesByCardAndTokenId)(card, String(expectedParentId));
        if (series?.metadata && (0, couponMetadataCategory_1.readCouponDisabledFromMetadata)(series.metadata)) {
            return null;
        }
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
        if (chain !== 'conet')
            return null;
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const reader = new ethers_1.ethers.Contract(card, REWARD_RULE_ABI, provider);
        const preferredRuleId = couponSocialPromotionRuleIdForEvent(expectedParentId, params.eventKey);
        if (!(await ruleMatchesCouponEvent(reader, preferredRuleId, params.eventKey, expectedParentId))) {
            return null;
        }
        const row = (await reader.getRewardRule(preferredRuleId));
        const [, , targetKind, issuedParentId, actorMint13, refMint13] = row;
        if (actorMint13 <= 0n && refMint13 <= 0n)
            return null;
        return {
            ruleId: preferredRuleId,
            targetKind: Number(targetKind),
            issuedParentId,
            actorMint13,
            refMint13,
            eventKey: params.eventKey,
        };
    }
    catch {
        return null;
    }
}
/** Resolve referrer for #13 dispatch: explicit ref → on-chain refereeReferrer(referee AA). */
async function resolveCouponBurnRefWallet(params) {
    const explicit = resolveRefWalletDistinct(params.actorEOA, params.explicitRefWallet);
    if (explicit !== ethers_1.ethers.ZeroAddress)
        return explicit;
    try {
        const card = ethers_1.ethers.getAddress(params.cardAddress);
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const holder = ethers_1.ethers.getAddress(await (0, cardProgramReferrerChain_js_1.resolveReferrerRegistryLookupAa)(provider, params.holderAccount));
        if (holder === ethers_1.ethers.ZeroAddress)
            return ethers_1.ethers.ZeroAddress;
        const reader = new ethers_1.ethers.Contract(card, ['function refereeReferrer(address refereeAA) view returns (address)'], provider);
        const referrer = (await reader.refereeReferrer(holder));
        if (referrer && ethers_1.ethers.isAddress(referrer) && referrer !== ethers_1.ethers.ZeroAddress) {
            return resolveRefWalletDistinct(params.actorEOA, referrer);
        }
    }
    catch {
        /* untrusted — no ref */
    }
    return ethers_1.ethers.ZeroAddress;
}
