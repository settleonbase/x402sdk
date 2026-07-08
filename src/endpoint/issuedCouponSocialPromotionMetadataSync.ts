import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { normalizeCouponCategoryOnTierProperties, normalizeCouponSeriesMetadataJson } from '../couponMetadataCategory'
import {
	getCardByAddress,
	getNftTierMetadataByCardAndToken,
	getSeriesByCardAndTokenId,
	updateSeriesMetadataByCardAndToken,
	upsertNftTierMetadata,
} from '../db'
import { invalidateIssuedCouponSeriesQueryCachesForCard } from './issuedCouponSeriesQueryCache'

export type CouponSocialPromotionJson = Record<string, unknown> | null

function setOrDeleteSocialPromotionField(
	target: Record<string, unknown>,
	socialPromotion: CouponSocialPromotionJson | undefined
): void {
	if (socialPromotion != null && typeof socialPromotion === 'object' && !Array.isArray(socialPromotion)) {
		target.socialPromotion = socialPromotion
		return
	}
	delete target.socialPromotion
}

function mergeSocialPromotionIntoSeriesMetadata(
	seriesMeta: Record<string, unknown>,
	socialPromotion: CouponSocialPromotionJson | undefined
): Record<string, unknown> {
	const nextSeriesMeta = normalizeCouponSeriesMetadataJson({ ...seriesMeta })
	setOrDeleteSocialPromotionField(nextSeriesMeta, socialPromotion)
	if (nextSeriesMeta.properties && typeof nextSeriesMeta.properties === 'object' && !Array.isArray(nextSeriesMeta.properties)) {
		const props = normalizeCouponCategoryOnTierProperties({
			...(nextSeriesMeta.properties as Record<string, unknown>),
		})
		if (props.beamioCoupon && typeof props.beamioCoupon === 'object' && !Array.isArray(props.beamioCoupon)) {
			const beamioCoupon = { ...(props.beamioCoupon as Record<string, unknown>) }
			setOrDeleteSocialPromotionField(beamioCoupon, socialPromotion)
			props.beamioCoupon = beamioCoupon
		}
		nextSeriesMeta.properties = props
	}
	return nextSeriesMeta
}

function mergeSocialPromotionIntoTierMetadata(
	tierMeta: Record<string, unknown>,
	socialPromotion: CouponSocialPromotionJson | undefined
): Record<string, unknown> {
	const nextTierMeta = { ...tierMeta }
	const tierProps = normalizeCouponCategoryOnTierProperties(
		nextTierMeta.properties && typeof nextTierMeta.properties === 'object' && !Array.isArray(nextTierMeta.properties)
			? { ...(nextTierMeta.properties as Record<string, unknown>) }
			: {}
	)
	const beamioCoupon =
		tierProps.beamioCoupon && typeof tierProps.beamioCoupon === 'object' && !Array.isArray(tierProps.beamioCoupon)
			? { ...(tierProps.beamioCoupon as Record<string, unknown>) }
			: {}
	setOrDeleteSocialPromotionField(beamioCoupon, socialPromotion)
	if (Object.keys(beamioCoupon).length > 0) {
		tierProps.beamioCoupon = beamioCoupon
	}
	nextTierMeta.properties = tierProps
	return nextTierMeta
}

function readCouponSocialPromotionFromShareRow(row: Record<string, unknown>): CouponSocialPromotionJson | undefined {
	if (!('socialPromotion' in row)) return undefined
	const raw = row.socialPromotion
	if (raw == null) return null
	if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
	return undefined
}

/** Sync one issued coupon's socialPromotion into beamio_nft_series + beamio_nft_tier_metadata. */
export async function syncIssuedCouponSocialPromotionMetadata(params: {
	cardAddress: string
	cardOwner: string
	couponId: string
	issuedTokenId: string
	socialPromotion: CouponSocialPromotionJson | undefined
	invalidateQueryCaches?: boolean
}): Promise<{ success: boolean; error?: string; seriesUpdated: boolean; tierUpdated: boolean }> {
	try {
		const cardNorm = ethers.getAddress(params.cardAddress)
		const couponId = String(params.couponId ?? '').trim()
		const tokenIdNorm = String(BigInt(String(params.issuedTokenId).trim()))
		if (!couponId) {
			return { success: false, error: 'couponId is required', seriesUpdated: false, tierUpdated: false }
		}

		const socialPromotion = params.socialPromotion
		let seriesUpdated = false
		let tierUpdated = false

		const series = await getSeriesByCardAndTokenId(cardNorm, tokenIdNorm)
		if (series) {
			const seriesMetaObj =
				series.metadata && typeof series.metadata === 'object' && !Array.isArray(series.metadata)
					? (series.metadata as Record<string, unknown>)
					: {}
			const nextSeriesMeta = mergeSocialPromotionIntoSeriesMetadata(seriesMetaObj, socialPromotion)
			seriesUpdated = await updateSeriesMetadataByCardAndToken({
				cardAddress: cardNorm,
				tokenId: tokenIdNorm,
				metadataJson: nextSeriesMeta,
			})
			if (seriesUpdated) {
				logger(
					Colors.green(
						`[syncIssuedCouponSocialPromotion] beamio_nft_series updated card=${cardNorm} tokenId=${tokenIdNorm} couponId=${couponId}`
					)
				)
			}
		} else {
			logger(
				Colors.yellow(
					`[syncIssuedCouponSocialPromotion] no beamio_nft_series row card=${cardNorm} tokenId=${tokenIdNorm}`
				)
			)
		}

		const tierMeta = await getNftTierMetadataByCardAndToken(cardNorm, Number(tokenIdNorm))
		if (tierMeta && typeof tierMeta === 'object') {
			const nextTierMeta = mergeSocialPromotionIntoTierMetadata(tierMeta as Record<string, unknown>, socialPromotion)
			await upsertNftTierMetadata({
				cardAddress: cardNorm,
				cardOwner: params.cardOwner,
				tokenId: Number(tokenIdNorm),
				metadataJson: nextTierMeta,
			})
			tierUpdated = true
			logger(
				Colors.green(
					`[syncIssuedCouponSocialPromotion] nft_tier_metadata upserted card=${cardNorm} tokenId=${tokenIdNorm}`
				)
			)
		}

		if (params.invalidateQueryCaches !== false) {
			invalidateIssuedCouponSeriesQueryCachesForCard(cardNorm, tokenIdNorm)
		}

		if (!seriesUpdated && !tierUpdated) {
			return {
				success: false,
				error: 'No issued coupon series or tier metadata row found to sync social promotion.',
				seriesUpdated: false,
				tierUpdated: false,
			}
		}

		return { success: true, seriesUpdated, tierUpdated }
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red(`[syncIssuedCouponSocialPromotion] failed: ${msg}`))
		return { success: false, error: msg, seriesUpdated: false, tierUpdated: false }
	}
}

/** After card-level shareTokenMetadata publish, mirror each issued coupon's socialPromotion to series/tier rows. */
export async function syncAllIssuedCouponSocialPromotionFromShareMetadata(params: {
	cardAddress: string
	cardOwner: string
	shareTokenMetadata: Record<string, unknown>
}): Promise<{ syncedTokenIds: string[]; errors: string[] }> {
	const coupons = params.shareTokenMetadata.coupons
	if (!Array.isArray(coupons)) {
		return { syncedTokenIds: [], errors: [] }
	}

	const syncedTokenIds: string[] = []
	const errors: string[] = []

	for (const raw of coupons) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
		const row = raw as Record<string, unknown>
		const issuedTokenId = String(row.issuedTokenId ?? '').trim()
		if (!issuedTokenId || !/^\d+$/.test(issuedTokenId)) continue
		if (!('socialPromotion' in row)) continue

		const couponId = String(row.couponId ?? row.id ?? '').trim()
		if (!couponId) continue

		const socialPromotion = readCouponSocialPromotionFromShareRow(row)
		const res = await syncIssuedCouponSocialPromotionMetadata({
			cardAddress: params.cardAddress,
			cardOwner: params.cardOwner,
			couponId,
			issuedTokenId,
			socialPromotion,
			invalidateQueryCaches: true,
		})
		if (res.success) {
			syncedTokenIds.push(issuedTokenId)
		} else if (res.error) {
			errors.push(`${issuedTokenId}: ${res.error}`)
		}
	}

	return { syncedTokenIds, errors }
}
