export type TopupPromotionRewardType = 'percent' | 'fixed'

export type TopupPromotionNormalized = {
	enabled: boolean
	validFrom?: string
	validTo?: string
	minimumTopupAmount: number
	rewardType: TopupPromotionRewardType
	rewardValue: number
}

export type CreateCardBonusRuleNormalized = {
	paymentAmount: number
	bonusValue: number
	bonusProportional?: boolean
}

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
	const min = parseAmount(o.minimumTopupAmount ?? o.minimum_topup_amount)
	const reward = parseAmount(o.rewardValue ?? o.reward_value)
	if (min == null || reward == null) {
		return {
			success: false,
			error: `${idxLabel} requires finite numeric minimumTopupAmount and rewardValue`,
		}
	}
	if (min <= 0 || reward <= 0) {
		return { success: false, error: `${idxLabel} minimumTopupAmount and rewardValue must be > 0` }
	}
	const rewardTypeRaw = String(o.rewardType ?? o.reward_type ?? '').trim().toLowerCase()
	// Missing / unknown → fixed (not percent).
	const rewardType: TopupPromotionRewardType =
		rewardTypeRaw === 'percent' ? 'percent' : 'fixed'
	if (rewardType === 'percent' && reward > 100) {
		return { success: false, error: `${idxLabel} percentage rewardValue cannot exceed 100` }
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
		},
	}
}

/**
 * Canonical → legacy bonusRule for POS:
 * - fixed: bonusValue = rewardValue, not proportional
 * - percent: bonusValue = paymentAmount * rewardValue / 100, proportional
 *   so `principal * bonusValue / paymentAmount` == `principal * rewardValue / 100`
 */
export function topupPromotionToBonusRule(
	promo: TopupPromotionNormalized,
): CreateCardBonusRuleNormalized | null {
	if (!promo.enabled) return null
	if (promo.rewardType === 'percent') {
		const bonusValue = Math.round(promo.minimumTopupAmount * promo.rewardValue) / 100
		if (bonusValue <= 0) return null
		return {
			paymentAmount: promo.minimumTopupAmount,
			bonusValue,
			bonusProportional: true,
		}
	}
	return {
		paymentAmount: promo.minimumTopupAmount,
		bonusValue: promo.rewardValue,
	}
}
