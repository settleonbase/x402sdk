export type TopupPromotionRewardType = 'percent' | 'fixed'

export type TopupPromotionFixedTierNormalized = {
	topupAmount: number
	bonusAmount: number
}

export type TopupPromotionNormalized = {
	enabled: boolean
	validFrom?: string
	validTo?: string
	minimumTopupAmount: number
	rewardType: TopupPromotionRewardType
	rewardValue: number
	/** Fixed / Tiered Fixed rows; POS expands each to a bonusRules[] entry. */
	fixedTiers?: TopupPromotionFixedTierNormalized[]
}

export type CreateCardBonusRuleNormalized = {
	paymentAmount: number
	bonusValue: number
	bonusProportional?: boolean
}

export const TOPUP_PROMOTION_FIXED_TIERS_MAX = 32

function parseAmount(raw: unknown): number | null {
	if (raw == null || raw === '') return null
	const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(/,/g, '').trim())
	if (!Number.isFinite(n) || n < 0) return null
	return Math.round(n * 100) / 100
}

function parseYmd(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined
	const t = raw.trim()
	if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined
	return t
}

function approxEq(a: number, b: number): boolean {
	return Math.abs(a - b) < 0.005
}

function normalizeFixedTiers(
	raw: unknown,
	idxLabel: string,
): { success: true; tiers: TopupPromotionFixedTierNormalized[] } | { success: false; error: string } {
	if (raw == null) return { success: true, tiers: [] }
	if (!Array.isArray(raw)) {
		return { success: false, error: `${idxLabel}.fixedTiers must be an array if provided` }
	}
	if (raw.length > TOPUP_PROMOTION_FIXED_TIERS_MAX) {
		return {
			success: false,
			error: `${idxLabel}.fixedTiers must have at most ${TOPUP_PROMOTION_FIXED_TIERS_MAX} entries`,
		}
	}
	const out: TopupPromotionFixedTierNormalized[] = []
	const seen = new Set<number>()
	for (let i = 0; i < raw.length; i++) {
		const row = raw[i]
		if (!row || typeof row !== 'object') {
			return { success: false, error: `${idxLabel}.fixedTiers[${i}] must be an object` }
		}
		const o = row as Record<string, unknown>
		const topup = parseAmount(o.topupAmount ?? o.topup_amount ?? o.paymentAmount)
		const bonus = parseAmount(o.bonusAmount ?? o.bonus_amount ?? o.bonusValue)
		if (topup == null || bonus == null || topup <= 0 || bonus <= 0) {
			return {
				success: false,
				error: `${idxLabel}.fixedTiers[${i}] requires topupAmount and bonusAmount > 0`,
			}
		}
		const key = Math.round(topup * 100)
		if (seen.has(key)) {
			return { success: false, error: `${idxLabel}.fixedTiers must have unique topupAmount values` }
		}
		seen.add(key)
		out.push({ topupAmount: topup, bonusAmount: bonus })
	}
	out.sort((a, b) => a.topupAmount - b.topupAmount)
	return { success: true, tiers: out }
}

/**
 * Heal legacy buggy encode: `rewardType: percent` + unscaled `bonusValue === rewardValue`
 * (should have been `paymentAmount * rewardValue / 100`). Treat as **fixed**.
 */
export function healTopupPromotionRewardType(
	promo: TopupPromotionNormalized,
	legacyBonus?: CreateCardBonusRuleNormalized | null,
): TopupPromotionNormalized {
	if (promo.rewardType !== 'percent') return promo
	const min = promo.minimumTopupAmount
	const reward = promo.rewardValue
	if (!(min > 0) || !(reward > 0)) return promo
	const scaled = Math.round(min * reward) / 100
	if (!legacyBonus) return promo
	const bv = legacyBonus.bonusValue
	if (!legacyBonus.bonusProportional && approxEq(bv, reward)) {
		return { ...promo, rewardType: 'fixed' }
	}
	if (legacyBonus.bonusProportional && approxEq(bv, reward) && !approxEq(bv, scaled)) {
		return { ...promo, rewardType: 'fixed' }
	}
	return promo
}

export function normalizeTopupPromotionEntry(
	raw: unknown,
	idxLabel: string,
): { success: true; promotion: TopupPromotionNormalized } | { success: false; error: string } {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: `${idxLabel} must be an object` }
	}
	const o = raw as Record<string, unknown>
	const tiersParsed = normalizeFixedTiers(o.fixedTiers ?? o.fixed_tiers, idxLabel)
	if (!tiersParsed.success) return tiersParsed
	const tiers = tiersParsed.tiers

	let min = parseAmount(o.minimumTopupAmount ?? o.minimum_topup_amount)
	let reward = parseAmount(o.rewardValue ?? o.reward_value)
	const rewardTypeRaw = String(o.rewardType ?? o.reward_type ?? '').trim().toLowerCase()
	// Missing / unknown → fixed (not percent).
	const rewardType: TopupPromotionRewardType =
		rewardTypeRaw === 'percent' ? 'percent' : 'fixed'

	if (rewardType === 'fixed' && tiers.length > 0) {
		if (min == null || min <= 0) min = tiers[0].topupAmount
		if (reward == null || reward <= 0) reward = tiers[0].bonusAmount
	}

	if (min == null || reward == null) {
		return {
			success: false,
			error: `${idxLabel} requires finite numeric minimumTopupAmount and rewardValue (or fixedTiers)`,
		}
	}
	if (min <= 0 || reward <= 0) {
		return { success: false, error: `${idxLabel} minimumTopupAmount and rewardValue must be > 0` }
	}
	if (rewardType === 'percent' && reward > 100) {
		return { success: false, error: `${idxLabel} percentage rewardValue cannot exceed 100` }
	}
	if (rewardType === 'fixed' && tiers.length === 0) {
		// Single-tier compat: synthesize from min/reward.
	}

	const from = parseYmd(o.validFrom ?? o.valid_from)
	const to = parseYmd(o.validTo ?? o.valid_to)
	if (typeof o.validFrom === 'string' && o.validFrom.trim() && !from) {
		return { success: false, error: `${idxLabel} validFrom must be YYYY-MM-DD` }
	}
	if (typeof o.validTo === 'string' && o.validTo.trim() && !to) {
		return { success: false, error: `${idxLabel} validTo must be YYYY-MM-DD` }
	}
	if (from && to && from > to) {
		return { success: false, error: `${idxLabel} validFrom cannot be after validTo` }
	}
	const enabled = o.enabled === false ? false : true
	return {
		success: true,
		promotion: {
			enabled,
			...(from ? { validFrom: from } : {}),
			...(to ? { validTo: to } : {}),
			minimumTopupAmount: min,
			rewardType,
			rewardValue: reward,
			...(rewardType === 'fixed' && tiers.length > 0 ? { fixedTiers: tiers } : {}),
		},
	}
}

/**
 * Canonical → legacy bonusRules for POS:
 * - percent: one proportional rule (bonusValue = payment * pct / 100)
 * - fixed / tiered: one non-proportional rule per tier (highest qualifying wins on POS)
 */
export function topupPromotionToBonusRules(
	promo: TopupPromotionNormalized,
): CreateCardBonusRuleNormalized[] {
	if (!promo.enabled) return []
	if (promo.rewardType === 'percent') {
		const bonusValue = Math.round(promo.minimumTopupAmount * promo.rewardValue) / 100
		if (bonusValue <= 0) return []
		return [
			{
				paymentAmount: promo.minimumTopupAmount,
				bonusValue,
				bonusProportional: true,
			},
		]
	}
	const tiers =
		promo.fixedTiers && promo.fixedTiers.length > 0
			? [...promo.fixedTiers].sort((a, b) => a.topupAmount - b.topupAmount)
			: [
					{
						topupAmount: promo.minimumTopupAmount,
						bonusAmount: promo.rewardValue,
					},
				]
	return tiers
		.filter((t) => t.topupAmount > 0 && t.bonusAmount > 0)
		.map((t) => ({
			paymentAmount: t.topupAmount,
			bonusValue: t.bonusAmount,
		}))
}

/** @deprecated Prefer {@link topupPromotionToBonusRules}; returns first rule only. */
export function topupPromotionToBonusRule(
	promo: TopupPromotionNormalized,
): CreateCardBonusRuleNormalized | null {
	return topupPromotionToBonusRules(promo)[0] ?? null
}
