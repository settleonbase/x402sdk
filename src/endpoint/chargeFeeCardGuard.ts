/**
 * 收费路径的卡与收款方核验（纯函数，无顶层副作用，可单独导入测试）。
 *
 * 规则（总 PM 裁定方案 D）：
 * - 费用卡 = 请求中的 merchantCardAddress，但必须是服务器核验过的绑定卡：绑定查询结果为 'bound'。
 * - 'not_bound' → pos_card_not_bound（4xx）；'unavailable' → 503 不可用。两者不可混淆。
 * - 纯 USDC（无 1155 资产）路径：收款方 to 必须等于该卡 owner 的 AA 或 EOA，否则 pos_payee_card_mismatch（4xx）。
 * - 没有任何默认卡回退，也没有 EOA 回退。
 */
import { ethers } from 'ethers'

export type ChargeBindingState = 'bound' | 'not_bound' | 'unavailable'

export type ChargeFeeCardVerdict =
	| { ok: true; cardAddress: string }
	| { ok: false; status: 400 | 503; code: 'pos_card_not_bound' | 'pos_card_binding_unavailable' | 'pos_card_invalid'; error: string }

export const verifyChargeFeeCardBinding = async (params: {
	merchantCardAddress: string | null | undefined
	lookupBinding: (cardAddress: string) => Promise<ChargeBindingState>
}): Promise<ChargeFeeCardVerdict> => {
	const raw = typeof params.merchantCardAddress === 'string' ? params.merchantCardAddress.trim() : ''
	if (!raw || !ethers.isAddress(raw)) {
		return { ok: false, status: 400, code: 'pos_card_invalid', error: 'merchantCardAddress is required and must be a valid address' }
	}
	const cardAddress = ethers.getAddress(raw)
	const state = await params.lookupBinding(cardAddress)
	if (state === 'bound') return { ok: true, cardAddress }
	if (state === 'not_bound') {
		return { ok: false, status: 400, code: 'pos_card_not_bound', error: 'merchantCardAddress is not bound to a terminal' }
	}
	return { ok: false, status: 503, code: 'pos_card_binding_unavailable', error: 'terminal binding is temporarily unavailable' }
}

export type ChargePayeeVerdict =
	| { ok: true }
	| { ok: false; status: 400 | 503; code: 'pos_payee_card_mismatch' | 'pos_payee_resolve_unavailable'; error: string }

/**
 * 纯 USDC 路径：to 必须等于卡 owner 的 AA 或 EOA。
 * resolveOwner 注入：返回 { eoa, aa }；读取失败抛错 → 503（不回退，不放行）。
 */
export const verifyChargePayeeMatchesCardOwner = async (params: {
	to: string
	cardAddress: string
	resolveOwner: (cardAddress: string) => Promise<{ eoa: string; aa: string | null }>
}): Promise<ChargePayeeVerdict> => {
	if (!ethers.isAddress(params.to)) {
		return { ok: false, status: 400, code: 'pos_payee_card_mismatch', error: 'payee address is invalid' }
	}
	let owner: { eoa: string; aa: string | null }
	try {
		owner = await params.resolveOwner(params.cardAddress)
	} catch {
		return { ok: false, status: 503, code: 'pos_payee_resolve_unavailable', error: 'card owner is temporarily unavailable' }
	}
	const to = ethers.getAddress(params.to).toLowerCase()
	const eoa = ethers.getAddress(owner.eoa).toLowerCase()
	const aa = owner.aa && ethers.isAddress(owner.aa) ? ethers.getAddress(owner.aa).toLowerCase() : null
	if (to === eoa || (aa !== null && to === aa)) return { ok: true }
	return { ok: false, status: 400, code: 'pos_payee_card_mismatch', error: 'payee is not the owner of the bound terminal card' }
}
