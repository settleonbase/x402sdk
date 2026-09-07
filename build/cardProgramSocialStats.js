"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MERCHANT_CARD_REF_CLICK_SCOPED_TOKEN_ID = void 0;
exports.resolveProgramSocialShareClickCount = resolveProgramSocialShareClickCount;
exports.readCardProgramSocialChainTotals = readCardProgramSocialChainTotals;
const ethers_1 = require("ethers");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
const userCumulativeStatRewardPool_1 = require("./userCumulativeStatRewardPool");
/** UserCumulativeStatLib.MERCHANT_CARD_REF_CLICK_TOKEN_ID @ L1. */
exports.MERCHANT_CARD_REF_CLICK_SCOPED_TOKEN_ID = 21n;
const READ_ABI = ['function totalSupply(uint256 id) view returns (uint256)'];
/**
 * Share-link KPI: chain totalSupply(21) is canonical for Discover RPC reads, but DB rows
 * (`recorded going forward`) may lead when gateway relay skipped REF_CLICK (legacy bug).
 */
function resolveProgramSocialShareClickCount(chainCount, dbTotal) {
    const db = Math.max(0, Math.trunc(Number.isFinite(dbTotal) ? dbTotal : 0));
    if (chainCount == null)
        return db > 0 ? db : null;
    const chain = Math.max(0, Math.trunc(chainCount));
    return Math.max(chain, db);
}
async function readMerchantScopedTotalSupply(cardAddress, tokenId) {
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const c = new ethers_1.ethers.Contract(card, READ_ABI, provider);
        const raw = (await c.totalSupply(tokenId));
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
    }
    catch {
        return null;
    }
}
/** 与 SilentPassUI Discover 一致：L1 totalSupply(19) / totalSupply(21)。 */
async function readCardProgramSocialChainTotals(cardAddress) {
    const [likeCount, shareClickCount] = await Promise.all([
        readMerchantScopedTotalSupply(cardAddress, userCumulativeStatRewardPool_1.MERCHANT_CARD_USER_LIKE_SCOPED_TOKEN_ID),
        readMerchantScopedTotalSupply(cardAddress, exports.MERCHANT_CARD_REF_CLICK_SCOPED_TOKEN_ID),
    ]);
    return { likeCount, shareClickCount };
}
