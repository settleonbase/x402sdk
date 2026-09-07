"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healTopupPromotionRewardType = healTopupPromotionRewardType;
exports.normalizeTopupPromotionEntry = normalizeTopupPromotionEntry;
exports.topupPromotionToBonusRule = topupPromotionToBonusRule;
function parseAmount(raw) {
    if (raw == null || raw === '')
        return null;
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(n) || n < 0)
        return null;
    return Math.round(n * 100) / 100;
}
function parseYmd(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const t = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t))
        return undefined;
    return t;
}
function approxEq(a, b) {
    return Math.abs(a - b) < 0.005;
}
/**
 * Heal legacy buggy encode: `rewardType: percent` + unscaled `bonusValue === rewardValue`
 * (should have been `paymentAmount * rewardValue / 100`). Treat as **fixed**.
 */
function healTopupPromotionRewardType(promo, legacyBonus) {
    if (promo.rewardType !== 'percent')
        return promo;
    const min = promo.minimumTopupAmount;
    const reward = promo.rewardValue;
    if (!(min > 0) || !(reward > 0))
        return promo;
    const scaled = Math.round(min * reward) / 100;
    if (!legacyBonus)
        return promo;
    const bv = legacyBonus.bonusValue;
    if (!legacyBonus.bonusProportional && approxEq(bv, reward)) {
        return { ...promo, rewardType: 'fixed' };
    }
    if (legacyBonus.bonusProportional && approxEq(bv, reward) && !approxEq(bv, scaled)) {
        return { ...promo, rewardType: 'fixed' };
    }
    return promo;
}
function normalizeTopupPromotionEntry(raw, idxLabel) {
    if (!raw || typeof raw !== 'object') {
        return { success: false, error: `${idxLabel} must be an object` };
    }
    const o = raw;
    const min = parseAmount(o.minimumTopupAmount ?? o.minimum_topup_amount);
    const reward = parseAmount(o.rewardValue ?? o.reward_value);
    if (min == null || reward == null) {
        return {
            success: false,
            error: `${idxLabel} requires finite numeric minimumTopupAmount and rewardValue`,
        };
    }
    if (min <= 0 || reward <= 0) {
        return { success: false, error: `${idxLabel} minimumTopupAmount and rewardValue must be > 0` };
    }
    const rewardTypeRaw = String(o.rewardType ?? o.reward_type ?? '').trim().toLowerCase();
    // Missing / unknown → fixed (not percent).
    const rewardType = rewardTypeRaw === 'percent' ? 'percent' : 'fixed';
    if (rewardType === 'percent' && reward > 100) {
        return { success: false, error: `${idxLabel} percentage rewardValue cannot exceed 100` };
    }
    const from = parseYmd(o.validFrom ?? o.valid_from);
    const to = parseYmd(o.validTo ?? o.valid_to);
    if (typeof o.validFrom === 'string' && o.validFrom.trim() && !from) {
        return { success: false, error: `${idxLabel} validFrom must be YYYY-MM-DD` };
    }
    if (typeof o.validTo === 'string' && o.validTo.trim() && !to) {
        return { success: false, error: `${idxLabel} validTo must be YYYY-MM-DD` };
    }
    if (from && to && from > to) {
        return { success: false, error: `${idxLabel} validFrom cannot be after validTo` };
    }
    const enabled = o.enabled === false ? false : true;
    return {
        success: true,
        promotion: {
            enabled,
            ...(from ? { validFrom: from } : {}),
            ...(to ? { validTo: to } : {}),
            minimumTopupAmount: min,
            rewardType,
            rewardValue: reward,
        },
    };
}
/**
 * Canonical → legacy bonusRule for POS:
 * - fixed: bonusValue = rewardValue, not proportional
 * - percent: bonusValue = paymentAmount * rewardValue / 100, proportional
 *   so `principal * bonusValue / paymentAmount` == `principal * rewardValue / 100`
 */
function topupPromotionToBonusRule(promo) {
    if (!promo.enabled)
        return null;
    if (promo.rewardType === 'percent') {
        const bonusValue = Math.round(promo.minimumTopupAmount * promo.rewardValue) / 100;
        if (bonusValue <= 0)
            return null;
        return {
            paymentAmount: promo.minimumTopupAmount,
            bonusValue,
            bonusProportional: true,
        };
    }
    return {
        paymentAmount: promo.minimumTopupAmount,
        bonusValue: promo.rewardValue,
    };
}
