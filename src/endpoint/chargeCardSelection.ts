/**
 * 收费路径的唯一选卡函数（纯函数，无顶层副作用）。预检（Cluster）、扣费（Master）、中继上下文三者共用。
 *
 * 输入：请求中的 merchantCardAddress 与 items。输出：同一张经核验的卡（或拒绝）。
 * - 不回退默认卡（B4），地址统一 getAddress 规范化。
 * - CCSA 资产不参与选卡与收款方改写（B2）。
 * - 所有非 CCSA 的 kind=1 资产必须等于 merchantCardAddress，否则拒绝（B1）。
 * - 绑定核验（是否为已绑定商户卡）由调用方在调用本函数之前完成（见 chargeFeeCardGuard.ts）。
 */
import { ethers } from 'ethers'

export type ChargeSelectionItem = { kind: number; asset: string }

/** 非 CCSA 的 ERC1155（kind=1）资产。 */
export const chargeNonCcsaErc1155Assets = (items: readonly ChargeSelectionItem[], ccsaAddress: string): string[] => {
	const ccsa = ethers.getAddress(ccsaAddress).toLowerCase()
	const out: string[] = []
	for (const it of items) {
		if (Number(it.kind) !== 1) continue
		let a: string
		try {
			a = ethers.getAddress(String(it.asset).trim())
		} catch {
			continue
		}
		if (a.toLowerCase() === ccsa) continue
		out.push(a)
	}
	return out
}

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
	const erc1155 = chargeNonCcsaErc1155Assets(params.items, params.ccsaAddress)
	for (const a of erc1155) {
		if (a.toLowerCase() !== cardAddress.toLowerCase()) {
			return { ok: false, status: 400, code: 'pos_payee_card_mismatch', error: 'ERC1155 item asset does not match merchantCardAddress' }
		}
	}
	return { ok: true, cardAddress, hasNonCcsaErc1155: erc1155.length > 0 }
}
