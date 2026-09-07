"use strict";
/** Social points (#13) exchange activity metadata on issued coupon series. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REWARD_VOUCHER_TOKEN_ID = void 0;
exports.readSocialExchangeFromMetadata = readSocialExchangeFromMetadata;
function parsePositiveInt(raw) {
    if (raw == null || raw === '')
        return null;
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n))
        return null;
    return n;
}
function parseUsdcReward6(raw) {
    if (raw == null || raw === '')
        return null;
    try {
        const v = BigInt(String(raw).trim());
        if (v <= 0n)
            return null;
        return v;
    }
    catch {
        return null;
    }
}
function normalizeSocialExchangePayload(raw) {
    const points = parsePositiveInt(raw.pointsCost ?? raw.points_cost ?? raw.points13);
    if (points == null)
        return null;
    const kindRaw = String(raw.kind ?? raw.exchangeKind ?? 'coupon').trim().toLowerCase();
    const kind = kindRaw === 'usdc' ? 'usdc' : 'coupon';
    const usdcReward6 = kind === 'usdc'
        ? (parseUsdcReward6(raw.usdcReward6 ?? raw.usdc_reward6 ?? raw.usdcAmount6) ?? null)
        : 0n;
    if (kind === 'usdc' && (usdcReward6 == null || usdcReward6 <= 0n))
        return null;
    if (raw.enabled === false)
        return null;
    return {
        enabled: true,
        kind,
        pointsCost: points,
        usdcReward6: usdcReward6 ?? 0n,
    };
}
function readSocialExchangeFromMetadata(meta) {
    if (!meta)
        return null;
    const direct = meta.socialExchange;
    if (direct && typeof direct === 'object') {
        return normalizeSocialExchangePayload(direct);
    }
    const beamioCoupon = meta.beamioCoupon;
    if (beamioCoupon && typeof beamioCoupon === 'object') {
        const nested = beamioCoupon.socialExchange;
        if (nested && typeof nested === 'object') {
            return normalizeSocialExchangePayload(nested);
        }
    }
    const properties = meta.properties;
    if (properties && typeof properties === 'object') {
        const bc = properties.beamioCoupon;
        if (bc && typeof bc === 'object') {
            const nested = bc.socialExchange;
            if (nested && typeof nested === 'object') {
                return normalizeSocialExchangePayload(nested);
            }
        }
    }
    return null;
}
exports.REWARD_VOUCHER_TOKEN_ID = 13n;
