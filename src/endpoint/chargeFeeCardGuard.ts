/**
 * 收费路径的卡与收款方核验（纯函数，无顶层副作用，可单独导入测试）。
 *
 * 规则（总 PM 裁定方案 D）：
 * - 费用卡 = 请求中的 merchantCardAddress，但必须是服务器核验过的绑定卡：绑定查询结果为 'bound'。
 * - 'not_bound' → pos_card_not_bound（4xx）；'unavailable' → 503 不可用。两者不可混淆。
 * - 纯 USDC（无 1155 资产）路径：收款方 to 必须是卡 owner 的 EOA/AA，或该卡有效绑定终端的 EOA/其 AA，否则 pos_payee_card_mismatch（4xx）。
 * - 没有任何默认卡回退，也没有 EOA 回退。
 */
import { ethers } from 'ethers'

export type ChargeFeeCardVerdict =
	| { ok: true; cardAddress: string }
	| { ok: false; status: 400 | 503; code: 'pos_card_not_bound' | 'pos_card_binding_unavailable' | 'pos_card_invalid'; error: string }

/**
 * lookupBinding：返回 true（存在绑定行）或 false（确定无绑定行）；抛出异常 => 503（不可用，与无绑定区分）。
 */
export const verifyChargeFeeCardBinding = async (params: {
	merchantCardAddress: string | null | undefined
	lookupBinding: (cardAddress: string) => Promise<boolean>
}): Promise<ChargeFeeCardVerdict> => {
	const raw = typeof params.merchantCardAddress === 'string' ? params.merchantCardAddress.trim() : ''
	if (!raw || !ethers.isAddress(raw)) {
		return { ok: false, status: 400, code: 'pos_card_invalid', error: 'merchantCardAddress is required and must be a valid address' }
	}
	const cardAddress = ethers.getAddress(raw)
	let bound: boolean
	try {
		bound = await params.lookupBinding(cardAddress)
	} catch {
		return { ok: false, status: 503, code: 'pos_card_binding_unavailable', error: 'terminal binding is temporarily unavailable' }
	}
	if (bound) return { ok: true, cardAddress }
	return { ok: false, status: 400, code: 'pos_card_not_bound', error: 'merchantCardAddress is not bound to a terminal' }
}

export type ChargePayeeVerdict =
	| { ok: true }
	| { ok: false; status: 400 | 503; code: 'pos_payee_card_mismatch' | 'pos_payee_resolve_unavailable'; error: string }

/**
 * 纯 USDC 路径：to 必须是下列之一，否则 400 pos_payee_card_mismatch：
 *  (a) 卡 owner 的 EOA，或 owner 在该卡 AA 工厂下的主 AA；
 *  (b) 该卡在 beamio_pos_terminal_admin_card 中有效绑定（is_active=true、tx_hash 非空）的任一终端 pos_eoa 本身，
 *      或该 pos_eoa 在该卡 AA 工厂下严格推导得到的 AA（由 resolveTerminalPayees 注入，已把两者展开为地址列表）。
 * 读取失败（owner、终端列表或 AA 推导）一律 503，不接受收款方。
 * resolveOwner / resolveTerminalPayees 注入；抛出即 503。
 */
export const verifyChargePayeeMatchesCardOwner = async (params: {
	to: string
	cardAddress: string
	resolveOwner: (cardAddress: string) => Promise<{ eoa: string; aa: string | null }>
	resolveTerminalPayees: (cardAddress: string) => Promise<string[]>
}): Promise<ChargePayeeVerdict> => {
	const unavailable = (): ChargePayeeVerdict => ({
		ok: false,
		status: 503,
		code: 'pos_payee_resolve_unavailable',
		error: 'card payee set is temporarily unavailable',
	})
	if (!ethers.isAddress(params.to)) {
		return { ok: false, status: 400, code: 'pos_payee_card_mismatch', error: 'payee address is invalid' }
	}
	const to = ethers.getAddress(params.to).toLowerCase()
	let owner: { eoa: string; aa: string | null }
	let ownerSet: string[]
	try {
		owner = await params.resolveOwner(params.cardAddress)
		const eoa = ethers.getAddress(owner.eoa).toLowerCase()
		const aa = owner.aa && ethers.isAddress(owner.aa) ? ethers.getAddress(owner.aa).toLowerCase() : null
		ownerSet = aa ? [eoa, aa] : [eoa]
	} catch {
		return unavailable()
	}
	if (ownerSet.includes(to)) return { ok: true }
	let terminalSet: string[]
	try {
		const raw = await params.resolveTerminalPayees(params.cardAddress)
		if (!Array.isArray(raw)) throw new Error('terminal payee set is not a list')
		terminalSet = raw.map((a) => ethers.getAddress(String(a)).toLowerCase())
	} catch {
		return unavailable()
	}
	if (terminalSet.includes(to)) return { ok: true }
	return { ok: false, status: 400, code: 'pos_payee_card_mismatch', error: 'payee is not the owner or an active bound terminal of this card' }
}
