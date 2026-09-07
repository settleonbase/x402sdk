"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncIssuedCouponSocialPromotionMetadata = syncIssuedCouponSocialPromotionMetadata;
exports.syncAllIssuedCouponSocialPromotionFromShareMetadata = syncAllIssuedCouponSocialPromotionFromShareMetadata;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const couponMetadataCategory_1 = require("../couponMetadataCategory");
const db_1 = require("../db");
const issuedCouponSeriesQueryCache_1 = require("./issuedCouponSeriesQueryCache");
function setOrDeleteSocialPromotionField(target, socialPromotion) {
    if (socialPromotion != null && typeof socialPromotion === 'object' && !Array.isArray(socialPromotion)) {
        target.socialPromotion = socialPromotion;
        return;
    }
    delete target.socialPromotion;
}
function mergeSocialPromotionIntoSeriesMetadata(seriesMeta, socialPromotion) {
    const nextSeriesMeta = (0, couponMetadataCategory_1.normalizeCouponSeriesMetadataJson)({ ...seriesMeta });
    setOrDeleteSocialPromotionField(nextSeriesMeta, socialPromotion);
    if (nextSeriesMeta.properties && typeof nextSeriesMeta.properties === 'object' && !Array.isArray(nextSeriesMeta.properties)) {
        const props = (0, couponMetadataCategory_1.normalizeCouponCategoryOnTierProperties)({
            ...nextSeriesMeta.properties,
        });
        if (props.beamioCoupon && typeof props.beamioCoupon === 'object' && !Array.isArray(props.beamioCoupon)) {
            const beamioCoupon = { ...props.beamioCoupon };
            setOrDeleteSocialPromotionField(beamioCoupon, socialPromotion);
            props.beamioCoupon = beamioCoupon;
        }
        nextSeriesMeta.properties = props;
    }
    return nextSeriesMeta;
}
function mergeSocialPromotionIntoTierMetadata(tierMeta, socialPromotion) {
    const nextTierMeta = { ...tierMeta };
    const tierProps = (0, couponMetadataCategory_1.normalizeCouponCategoryOnTierProperties)(nextTierMeta.properties && typeof nextTierMeta.properties === 'object' && !Array.isArray(nextTierMeta.properties)
        ? { ...nextTierMeta.properties }
        : {});
    const beamioCoupon = tierProps.beamioCoupon && typeof tierProps.beamioCoupon === 'object' && !Array.isArray(tierProps.beamioCoupon)
        ? { ...tierProps.beamioCoupon }
        : {};
    setOrDeleteSocialPromotionField(beamioCoupon, socialPromotion);
    if (Object.keys(beamioCoupon).length > 0) {
        tierProps.beamioCoupon = beamioCoupon;
    }
    nextTierMeta.properties = tierProps;
    return nextTierMeta;
}
function readCouponSocialPromotionFromShareRow(row) {
    if (!('socialPromotion' in row))
        return undefined;
    const raw = row.socialPromotion;
    if (raw == null)
        return null;
    if (typeof raw === 'object' && !Array.isArray(raw))
        return raw;
    return undefined;
}
/** Sync one issued coupon's socialPromotion into beamio_nft_series + beamio_nft_tier_metadata. */
async function syncIssuedCouponSocialPromotionMetadata(params) {
    try {
        const cardNorm = ethers_1.ethers.getAddress(params.cardAddress);
        const couponId = String(params.couponId ?? '').trim();
        const tokenIdNorm = String(BigInt(String(params.issuedTokenId).trim()));
        if (!couponId) {
            return { success: false, error: 'couponId is required', seriesUpdated: false, tierUpdated: false };
        }
        const socialPromotion = params.socialPromotion;
        let seriesUpdated = false;
        let tierUpdated = false;
        const series = await (0, db_1.getSeriesByCardAndTokenId)(cardNorm, tokenIdNorm);
        if (series) {
            const seriesMetaObj = series.metadata && typeof series.metadata === 'object' && !Array.isArray(series.metadata)
                ? series.metadata
                : {};
            const nextSeriesMeta = mergeSocialPromotionIntoSeriesMetadata(seriesMetaObj, socialPromotion);
            seriesUpdated = await (0, db_1.updateSeriesMetadataByCardAndToken)({
                cardAddress: cardNorm,
                tokenId: tokenIdNorm,
                metadataJson: nextSeriesMeta,
            });
            if (seriesUpdated) {
                (0, logger_1.logger)(safe_1.default.green(`[syncIssuedCouponSocialPromotion] beamio_nft_series updated card=${cardNorm} tokenId=${tokenIdNorm} couponId=${couponId}`));
            }
        }
        else {
            (0, logger_1.logger)(safe_1.default.yellow(`[syncIssuedCouponSocialPromotion] no beamio_nft_series row card=${cardNorm} tokenId=${tokenIdNorm}`));
        }
        const tierMeta = await (0, db_1.getNftTierMetadataByCardAndToken)(cardNorm, Number(tokenIdNorm));
        if (tierMeta && typeof tierMeta === 'object') {
            const nextTierMeta = mergeSocialPromotionIntoTierMetadata(tierMeta, socialPromotion);
            await (0, db_1.upsertNftTierMetadata)({
                cardAddress: cardNorm,
                cardOwner: params.cardOwner,
                tokenId: Number(tokenIdNorm),
                metadataJson: nextTierMeta,
            });
            tierUpdated = true;
            (0, logger_1.logger)(safe_1.default.green(`[syncIssuedCouponSocialPromotion] nft_tier_metadata upserted card=${cardNorm} tokenId=${tokenIdNorm}`));
        }
        if (params.invalidateQueryCaches !== false) {
            (0, issuedCouponSeriesQueryCache_1.invalidateIssuedCouponSeriesQueryCachesForCard)(cardNorm, tokenIdNorm);
        }
        if (!seriesUpdated && !tierUpdated) {
            return {
                success: false,
                error: 'No issued coupon series or tier metadata row found to sync social promotion.',
                seriesUpdated: false,
                tierUpdated: false,
            };
        }
        return { success: true, seriesUpdated, tierUpdated };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red(`[syncIssuedCouponSocialPromotion] failed: ${msg}`));
        return { success: false, error: msg, seriesUpdated: false, tierUpdated: false };
    }
}
/** After card-level shareTokenMetadata publish, mirror each issued coupon's socialPromotion to series/tier rows. */
async function syncAllIssuedCouponSocialPromotionFromShareMetadata(params) {
    const coupons = params.shareTokenMetadata.coupons;
    if (!Array.isArray(coupons)) {
        return { syncedTokenIds: [], errors: [] };
    }
    const syncedTokenIds = [];
    const errors = [];
    for (const raw of coupons) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const row = raw;
        const issuedTokenId = String(row.issuedTokenId ?? '').trim();
        if (!issuedTokenId || !/^\d+$/.test(issuedTokenId))
            continue;
        if (!('socialPromotion' in row))
            continue;
        const couponId = String(row.couponId ?? row.id ?? '').trim();
        if (!couponId)
            continue;
        const socialPromotion = readCouponSocialPromotionFromShareRow(row);
        const res = await syncIssuedCouponSocialPromotionMetadata({
            cardAddress: params.cardAddress,
            cardOwner: params.cardOwner,
            couponId,
            issuedTokenId,
            socialPromotion,
            invalidateQueryCaches: true,
        });
        if (res.success) {
            syncedTokenIds.push(issuedTokenId);
        }
        else if (res.error) {
            errors.push(`${issuedTokenId}: ${res.error}`);
        }
    }
    return { syncedTokenIds, errors };
}
