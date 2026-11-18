/**
 * 收费准入（纯模块，无顶层副作用）。Cluster 预检与 Master 中继共用同一顺序：
 *   1) selectChargeCard（选卡，含 B1/B2/B4，地址规范化）；
 *   2) verifyChargeFeeCardBinding（绑定核验：无绑定 4xx，读取失败 503）；
 *   3) 纯 USDC 时 verifyChargePayeeMatchesCardOwner（收款方必须为卡 owner 的 EOA 或 AA）。
 * 任何依赖抛出的异常都映射为 503（pos_admission_unavailable），不会落成 500。
 * 依赖（绑定查询、owner 只读解析）全部由调用方注入。
 */
import { selectChargeCard, type ChargeSelectionItem } from './chargeCardSelection'
import { verifyChargeFeeCardBinding, verifyChargePayeeMatchesCardOwner } from './chargeFeeCardGuard'

export type ChargeGateCode =
	| 'pos_card_invalid'
	| 'pos_payee_card_mismatch'
	| 'pos_card_not_bound'
	| 'pos_card_binding_unavailable'
	| 'pos_payee_resolve_unavailable'
	| 'pos_admission_unavailable'

export type ChargeGateReject = { ok: false; status: 400 | 503; code: ChargeGateCode; error: string }

export type ChargeAdmission = Readonly<{
	ok: true
	/** 经核验并 checksum 规范化的卡地址；之后的收款方改写、费用卡与中继上下文都必须使用它。 */
	cardAddress: string
	/** 请求含非 CCSA 的 kind=1 资产（卡内资产收款）。为 true 时收款方由卡 owner 改写，不做 to 核验。 */
	hasNonCcsaErc1155: boolean
}>

export type ChargeAdmissionDeps = {
	/** 返回 true：存在有效绑定；false：确定无绑定；抛出：不可用。 */
	lookupBinding: (cardAddress: string) => Promise<boolean>
	/** 只读解析卡 owner 的 EOA 与 AA（不发交易）；读取失败抛出。 */
	resolveOwner: (cardAddress: string) => Promise<{ eoa: string; aa: string | null }>
}

export const admitChargeRequest = async (
	input: {
		merchantCardAddress: string | null | undefined
		items: readonly ChargeSelectionItem[]
		to: string | null | undefined
		ccsaAddress: string
	},
	deps: ChargeAdmissionDeps
): Promise<ChargeAdmission | ChargeGateReject> => {
	try {
		const selected = selectChargeCard({
			merchantCardAddress: input.merchantCardAddress,
			items: input.items,
			ccsaAddress: input.ccsaAddress,
		})
		if (!selected.ok) return { ok: false, status: selected.status, code: selected.code, error: selected.error }

		const bound = await verifyChargeFeeCardBinding({
			merchantCardAddress: selected.cardAddress,
			lookupBinding: deps.lookupBinding,
		})
		if (!bound.ok) return { ok: false, status: bound.status, code: bound.code, error: bound.error }

		if (!selected.hasNonCcsaErc1155) {
			const payee = await verifyChargePayeeMatchesCardOwner({
				to: String(input.to ?? ''),
				cardAddress: bound.cardAddress,
				resolveOwner: deps.resolveOwner,
			})
			if (!payee.ok) return { ok: false, status: payee.status, code: payee.code, error: payee.error }
		}

		return Object.freeze({
			ok: true as const,
			cardAddress: bound.cardAddress,
			hasNonCcsaErc1155: selected.hasNonCcsaErc1155,
		})
	} catch {
		return { ok: false, status: 503, code: 'pos_admission_unavailable', error: 'charge admission is temporarily unavailable' }
	}
}
