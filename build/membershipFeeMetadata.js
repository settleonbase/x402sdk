"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMBERSHIP_FEE_CHECK_BALANCE_HINT = exports.MEMBERSHIP_NFT_MAX_EXCLUSIVE = exports.MEMBERSHIP_NFT_MIN_ID = void 0;
exports.isMembershipNftTokenId = isMembershipNftTokenId;
exports.membershipFeeHumanToE6 = membershipFeeHumanToE6;
exports.metadataTierMembershipFeeE6 = metadataTierMembershipFeeE6;
exports.metadataTierOnChainIndex = metadataTierOnChainIndex;
exports.parseBaseMembership = parseBaseMembership;
exports.baseMembershipFeeE6 = baseMembershipFeeE6;
exports.tiersPayloadHaveMembershipFee = tiersPayloadHaveMembershipFee;
exports.membershipFeesFromMetadataTiers = membershipFeesFromMetadataTiers;
exports.extractMetadataTiers = extractMetadataTiers;
exports.readMembershipFeesFromCardMetadata = readMembershipFeesFromCardMetadata;
exports.readCardMembershipFeeModeFromMetadata = readCardMembershipFeeModeFromMetadata;
exports.shouldSkipFactoryTiersForCreate = shouldSkipFactoryTiersForCreate;
exports.validateMembershipFeePublishShape = validateMembershipFeePublishShape;
exports.membershipFeeLockViolation = membershipFeeLockViolation;
/**
 * Membership-fee cards: metadata is the source of truth (not on-chain setMembershipFees).
 * New non-membership loyalty cards: one tx createCardCollectionWithInitCodeAndTiers
 * (live 3-tuple 0x9a7eb0f0). Membership-fee cards skip Factory tiers (initCode-only).
 * Never send Hardhat 4-tuple AndTiers (0x62cb913c).
 *
 * Product model: baseMembership = index 0 (not Add-tier); tiers[] = higher paid memberships only.
 * Membership NFT tokenId ∈ [100, 1e11). Leftover #0 is program points, not a membership NFT.
 */
const db_1 = require("./db");
/** Membership NFT tokenId lower bound (inclusive). */
exports.MEMBERSHIP_NFT_MIN_ID = 100n;
/** Membership NFT tokenId upper bound (exclusive); issued NFT / coupon ids start here. */
exports.MEMBERSHIP_NFT_MAX_EXCLUSIVE = 100000000000n;
function isMembershipNftTokenId(tokenId) {
    if (tokenId == null)
        return false;
    try {
        const tid = typeof tokenId === 'bigint'
            ? tokenId
            : typeof tokenId === 'number' && Number.isFinite(tokenId)
                ? BigInt(Math.floor(tokenId))
                : BigInt(String(tokenId).trim());
        return tid >= exports.MEMBERSHIP_NFT_MIN_ID && tid < exports.MEMBERSHIP_NFT_MAX_EXCLUSIVE;
    }
    catch {
        return false;
    }
}
/** Human fee → E6 string; empty/invalid → "0". */
function membershipFeeHumanToE6(raw) {
    if (raw == null || raw === '')
        return '0';
    const s = String(raw).replace(/,/g, '').trim();
    if (!s)
        return '0';
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0)
        return '0';
    return String(Math.round(n * 1e6));
}
function metadataTierMembershipFeeE6(row) {
    if (row.membershipFeeE6 && BigInt(row.membershipFeeE6) > 0n)
        return row.membershipFeeE6;
    return membershipFeeHumanToE6(row.membershipFee);
}
function metadataTierOnChainIndex(row, fallbackIndex) {
    if (typeof row.index === 'number' && Number.isFinite(row.index))
        return Math.trunc(row.index);
    if (typeof row.chainTierIndex === 'number' && Number.isFinite(row.chainTierIndex)) {
        return Math.trunc(row.chainTierIndex);
    }
    return fallbackIndex;
}
function parseBaseMembership(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const o = raw;
    const feeE6 = metadataTierMembershipFeeE6({
        membershipFeeE6: o.membershipFeeE6 != null ? String(o.membershipFeeE6) : undefined,
        membershipFee: o.membershipFee,
    });
    if (BigInt(feeE6) <= 0n)
        return null;
    const dkRaw = o.membershipDurationKind;
    const dk = dkRaw == null ? 0 : Number(dkRaw);
    return {
        membershipFeeE6: feeE6,
        ...(o.membershipFee != null && { membershipFee: o.membershipFee }),
        membershipDurationKind: Number.isFinite(dk) ? Math.trunc(dk) : 0,
    };
}
function baseMembershipFeeE6(metadata) {
    if (!metadata)
        return '0';
    const base = parseBaseMembership(metadata.baseMembership);
    return base ? metadataTierMembershipFeeE6(base) : '0';
}
function tiersPayloadHaveMembershipFee(tiers) {
    if (!tiers?.length)
        return false;
    return tiers.some((t) => BigInt(metadataTierMembershipFeeE6(t)) > 0n);
}
/** Build fee arrays indexed by on-chain tier index from metadata tiers payload (incl. synthesized base at 0). */
function membershipFeesFromMetadataTiers(tiers) {
    const feeE6 = [];
    const durationKind = [];
    tiers.forEach((row, i) => {
        const idx = metadataTierOnChainIndex(row, i);
        const fee = BigInt(metadataTierMembershipFeeE6(row));
        const dk = Number(row.membershipDurationKind ?? 0);
        while (feeE6.length <= idx) {
            feeE6.push(0n);
            durationKind.push(0);
        }
        feeE6[idx] = fee;
        durationKind[idx] = dk;
    });
    return { feeE6, durationKind };
}
/**
 * Extract membership fee rows for API/POS:
 * - If baseMembership.fee > 0 → index 0 from baseMembership; tiers[] become indices 1+
 * - Legacy: no baseMembership but tiers[0].fee > 0 → treat tiers[0] as base (index 0)
 */
function extractMetadataTiers(metadata) {
    if (!metadata || typeof metadata !== 'object')
        return [];
    const base = parseBaseMembership(metadata.baseMembership);
    const raw = metadata.tiers;
    const higher = Array.isArray(raw)
        ? raw.filter((t) => t != null && typeof t === 'object')
        : [];
    if (base) {
        const out = [
            {
                index: 0,
                membershipFeeE6: metadataTierMembershipFeeE6(base),
                membershipDurationKind: base.membershipDurationKind ?? 0,
                minUsdc6: '1',
            },
        ];
        higher.forEach((row, i) => {
            out.push({
                ...row,
                index: typeof row.index === 'number' && Number.isFinite(row.index) ? Math.trunc(row.index) : i + 1,
            });
        });
        return out;
    }
    // Legacy: no baseMembership — tiers[] as-is (tiers[0] may be base)
    return higher.map((row, i) => ({
        ...row,
        index: typeof row.index === 'number' && Number.isFinite(row.index) ? Math.trunc(row.index) : i,
    }));
}
/** Metadata-backed membership fees; null when DB row missing or no fee tiers in metadata. */
async function readMembershipFeesFromCardMetadata(cardAddrRaw) {
    try {
        const row = await (0, db_1.getCardByAddress)(cardAddrRaw.trim());
        if (!row?.metadata)
            return null;
        const tiers = extractMetadataTiers(row.metadata);
        if (!tiers.length || !tiersPayloadHaveMembershipFee(tiers))
            return null;
        return membershipFeesFromMetadataTiers(tiers);
    }
    catch {
        return null;
    }
}
/** true = metadata declares membership fees; false = metadata tiers exist but no fees; null = no metadata signal. */
async function readCardMembershipFeeModeFromMetadata(cardAddrRaw) {
    const fees = await readMembershipFeesFromCardMetadata(cardAddrRaw);
    if (fees != null)
        return fees.feeE6.some((f) => f > 0n);
    try {
        const row = await (0, db_1.getCardByAddress)(cardAddrRaw.trim());
        if (!row?.metadata)
            return null;
        const meta = row.metadata;
        if (BigInt(baseMembershipFeeE6(meta)) > 0n)
            return true;
        const tiers = extractMetadataTiers(meta);
        if (tiers.length > 0)
            return false;
    }
    catch {
        /* fall through */
    }
    return null;
}
/**
 * Membership-fee cards must not pass tiers to Factory create (use initCode-only create; no append).
 * Pass optional metadata so baseMembership-only cards (no tiers[]) still skip Factory tiers.
 * Non-membership loyalty cards write tiers in the same AndTiers create tx (including a single base row).
 */
function shouldSkipFactoryTiersForCreate(tiers, metadata) {
    if (tiersPayloadHaveMembershipFee(tiers ?? []))
        return true;
    if (metadata && BigInt(baseMembershipFeeE6(metadata)) > 0n)
        return true;
    return false;
}
/**
 * Validate publish shape: base fee > 0 ⇒ duration 1–6; each higher tier fee strictly > previous.
 * Returns English error or null if OK.
 */
function validateMembershipFeePublishShape(opts) {
    const base = opts.baseMembership ? parseBaseMembership(opts.baseMembership) : null;
    const higher = (opts.tiers ?? []).filter((t) => t != null && typeof t === 'object');
    let prevFee = 0n;
    if (base) {
        const fee = BigInt(metadataTierMembershipFeeE6(base));
        const dk = Number(base.membershipDurationKind ?? 0);
        if (fee > 0n && (dk < 1 || dk > 6)) {
            return 'baseMembership.membershipDurationKind must be 1–6 when membershipFeeE6 > 0';
        }
        prevFee = fee;
    }
    for (let i = 0; i < higher.length; i++) {
        const fee = BigInt(metadataTierMembershipFeeE6(higher[i]));
        if (fee <= 0n)
            continue;
        const dk = Number(higher[i].membershipDurationKind ?? 0);
        if (dk < 1 || dk > 6) {
            return `tiers[${i}].membershipDurationKind must be 1–6 when membershipFeeE6 > 0`;
        }
        if (prevFee > 0n && fee <= prevFee) {
            return base
                ? `tiers[${i}].membershipFeeE6 must be strictly greater than baseMembership and previous higher tier`
                : `tiers[${i}].membershipFeeE6 must be strictly greater than previous fee tier`;
        }
        prevFee = fee;
    }
    return null;
}
/**
 * Lock check: once a fee+duration was published for an index, reject changes to fee or duration.
 * prev/next are full metadata objects (or extractable tiers via extractMetadataTiers).
 */
function membershipFeeLockViolation(prevMetadata, nextBase, nextTiers) {
    if (!prevMetadata)
        return null;
    const prevRows = extractMetadataTiers(prevMetadata);
    if (!prevRows.length || !tiersPayloadHaveMembershipFee(prevRows))
        return null;
    const nextMeta = {
        ...(nextBase && { baseMembership: nextBase }),
        ...(nextTiers && { tiers: nextTiers }),
    };
    // If caller only sends higher tiers without base, preserve prev base for comparison
    if (!nextBase && prevMetadata.baseMembership != null) {
        nextMeta.baseMembership = prevMetadata.baseMembership;
    }
    if (nextTiers === undefined && Array.isArray(prevMetadata.tiers)) {
        nextMeta.tiers = prevMetadata.tiers;
    }
    const nextRows = extractMetadataTiers(nextMeta);
    for (const prev of prevRows) {
        const prevFee = BigInt(metadataTierMembershipFeeE6(prev));
        if (prevFee <= 0n)
            continue;
        const idx = metadataTierOnChainIndex(prev, 0);
        const prevDk = Number(prev.membershipDurationKind ?? 0);
        const next = nextRows.find((r) => metadataTierOnChainIndex(r, -1) === idx);
        if (!next) {
            return `Cannot remove published membership fee tier at index ${idx}`;
        }
        const nextFee = BigInt(metadataTierMembershipFeeE6(next));
        const nextDk = Number(next.membershipDurationKind ?? 0);
        if (nextFee !== prevFee || nextDk !== prevDk) {
            return `Membership fee and duration are locked for index ${idx} after first publish`;
        }
    }
    return null;
}
exports.MEMBERSHIP_FEE_CHECK_BALANCE_HINT = 'Active membership required. Purchase membership from Check Balance before top-up.';
