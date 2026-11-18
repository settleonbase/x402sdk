/**
 * 收费路径的唯一选卡函数（纯函数，无顶层副作用）。Cluster 预检、Master 扣费与中继上下文三者共用。
 *
 * 输入：请求中的 merchantCardAddress 与 items。输出：同一张卡（或拒绝）。
 * - 不回退默认卡（B4），地址统一 getAddress 规范化；缺失或格式错误一律拒绝。
 * - CCSA 资产不参与选卡与收款方改写（B2）。
 * - 所有非 CCSA 的 kind=1 资产必须等于 merchantCardAddress，否则拒绝（B1）。
 * - 非 CCSA 的 kind=1 资产若不是合法地址，直接拒绝（fail closed，不得跳过）。
 * - 绑定核验（是否为已绑定商户卡）与收款方核验由调用方在本函数之后完成（见 chargeRelayGate.ts）。
 */
import { ethers } from 'ethers'

export type ChargeSelectionItem = { kind: number; asset: string }

export type ChargeCardSelectionVerdict =
	| { ok: true; cardAddress: string; hasNonCcsaErc1155: boolean }
	| { ok: false; status: 400; code: 'pos_card_invalid' | 'pos_payee_card_mismatch'; error: string }

export const selectChargeCard = (params: {
	merchantCardAddress: string | null | undefined
	items: readonly ChargeSelectionItem[]
	ccsaAddress: string
}): ChargeCardSelectionVerdict => {
	const raw = typeof params.merchantCardAddress === 'string' ? params.merchantCardAddress.trim() : ''
	if (!raw || !ethers.isAddress(raw)) {
		return { ok: false, status: 400, code: 'pos_card_invalid', error: 'merchantCardAddress is required and must be a valid address' }
	}
	const cardAddress = ethers.getAddress(raw)
	const ccsa = ethers.getAddress(params.ccsaAddress).toLowerCase()
	let hasNonCcsaErc1155 = false
	for (const it of params.items) {
		if (Number(it.kind) !== 1) continue
		let asset: string
		try {
			asset = ethers.getAddress(String(it.asset).trim())
		} catch {
			return { ok: false, status: 400, code: 'pos_card_invalid', error: 'ERC1155 item asset is not a valid address' }
		}
		if (asset.toLowerCase() === ccsa) continue
		if (asset.toLowerCase() !== cardAddress.toLowerCase()) {
			return { ok: false, status: 400, code: 'pos_payee_card_mismatch', error: 'ERC1155 item asset does not match merchantCardAddress' }
		}
		hasNonCcsaErc1155 = true
	}
	return { ok: true, cardAddress, hasNonCcsaErc1155 }
}
