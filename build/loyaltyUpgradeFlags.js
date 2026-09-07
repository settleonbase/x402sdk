"use strict";
/**
 * Merchant loyalty upgrade flags from card-level `upgradeType`.
 *
 * | Merchant choice | upgradeType | upgradeByBalance (on-chain + metadata) | upgradeByCharge (metadata only) |
 * |-----------------|-------------|----------------------------------------|---------------------------------|
 * | Top-up          | 0           | false                                  | false                           |
 * | Balance         | 1           | true                                   | false                           |
 * | Charge          | 2           | false                                  | true                            |
 *
 * Paid-membership cards force both flags false and upgradeType 0.
 * `upgradeByCharge` is not on the live 4-tuple `Tier` ABI; Charge vs Top-up
 * on-chain both use `upgradeByBalance=false` and are distinguished by metadata.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loyaltyUpgradeFlagsFromType = loyaltyUpgradeFlagsFromType;
exports.normalizeLoyaltyUpgradeType = normalizeLoyaltyUpgradeType;
exports.inferLoyaltyUpgradeType = inferLoyaltyUpgradeType;
exports.stampLoyaltyUpgradeFlagsOnTiers = stampLoyaltyUpgradeFlagsOnTiers;
function loyaltyUpgradeFlagsFromType(upgradeType, membershipFee) {
    if (membershipFee)
        return { upgradeByBalance: false, upgradeByCharge: false };
    return {
        upgradeByBalance: upgradeType === 1,
        upgradeByCharge: upgradeType === 2,
    };
}
function normalizeLoyaltyUpgradeType(raw, membershipFee) {
    if (membershipFee)
        return 0;
    const n = Number(raw);
    if (n === 1 || n === 2)
        return n;
    return 0;
}
/** Prefer explicit upgradeType; otherwise infer from per-tier flags (Charge vs Balance). */
function inferLoyaltyUpgradeType(raw, membershipFee, tiers) {
    if (membershipFee)
        return 0;
    const n = Number(raw);
    if (n === 0 || n === 1 || n === 2)
        return n;
    if (tiers?.some((t) => t.upgradeByCharge === true))
        return 2;
    if (tiers?.some((t) => t.upgradeByBalance === true))
        return 1;
    return 0;
}
function stampLoyaltyUpgradeFlagsOnTiers(tiers, upgradeType, membershipFee) {
    if (!tiers)
        return undefined;
    const flags = loyaltyUpgradeFlagsFromType(upgradeType, membershipFee);
    return tiers.map((t) => ({ ...t, ...flags }));
}
