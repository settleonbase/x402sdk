"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readTiersLength = readTiersLength;
exports.pickBestMembershipNftByMinUsdc6 = pickBestMembershipNftByMinUsdc6;
/**
 * Aligns client "best membership" / primary card with BeamioUserCard `_findBestValidMembership`:
 * among non-expired membership NFTs (`tokenId ∈ [100, 1e11)`), prefer the highest
 * `tiers[tierIndex].minUsdc6` (trackable tiers only). Leftover `#0` program points are not membership NFTs.
 * non-trackable tierIndex (e.g. MaxUint256) participates only as fallback when no trackable NFT qualifies.
 */
const ethers_1 = require("ethers");
function isTrackableTierIndex(tierIdx, tiersLength) {
    return tierIdx !== ethers_1.ethers.MaxUint256 && tierIdx < BigInt(tiersLength);
}
/** BeamioUserCard exposes `tiers(uint256)` only; probe successive indices until revert (same pattern as biz on-chain tier list). */
async function readTiersLength(card) {
    const c = card;
    let n = 0;
    for (let i = 0; i < 64; i++) {
        try {
            await c.tiers(BigInt(i));
            n = i + 1;
        }
        catch {
            break;
        }
    }
    return n;
}
async function pickBestMembershipNftByMinUsdc6(card, rawNfts) {
    const MEMBERSHIP_NFT_MIN_ID = 100n;
    const MEMBERSHIP_NFT_MAX_EXCLUSIVE = 100000000000n;
    const alive = rawNfts.filter((n) => n.tokenId >= MEMBERSHIP_NFT_MIN_ID &&
        n.tokenId < MEMBERSHIP_NFT_MAX_EXCLUSIVE &&
        !n.isExpired);
    if (alive.length === 0)
        return null;
    const tiersLen = await readTiersLength(card);
    const cardWithTiers = card;
    let bestId = null;
    let bestTierIdx = null;
    let bestMin = -1n;
    let fallbackId = null;
    let fallbackTierStr = '';
    for (const n of alive) {
        const tid = n.tokenId;
        const tierIdx = n.tierIndexOrMax;
        const tierStr = tierIdx === ethers_1.ethers.MaxUint256 ? 'Default/Max' : tierIdx.toString();
        if (!isTrackableTierIndex(tierIdx, tiersLen)) {
            if (fallbackId === null) {
                fallbackId = tid;
                fallbackTierStr = tierStr;
            }
            continue;
        }
        let minU;
        try {
            const row = await cardWithTiers.tiers(tierIdx);
            minU = BigInt(row[0].toString());
        }
        catch {
            continue;
        }
        if (bestId === null || minU > bestMin) {
            bestId = tid;
            bestMin = minU;
            bestTierIdx = tierIdx;
        }
    }
    if (bestId != null && bestTierIdx != null) {
        return { tokenId: bestId.toString(), tier: bestTierIdx.toString(), minUsdc6: bestMin };
    }
    if (fallbackId != null) {
        return { tokenId: fallbackId.toString(), tier: fallbackTierStr, minUsdc6: 0n };
    }
    return null;
}
