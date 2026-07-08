import { ethers } from 'ethers'
import {
	CONET_BUINT,
	CONET_BUNIT_AIRDROP_ADDRESS,
	CONET_DEPRECATED_BUINT_ADDRESSES,
} from './chainAddresses'

const BUINT_BALANCE_OF_ALL_ABI = [
	'function balanceOfAll(address) view returns (uint256 total, uint256 free, uint256 paid)',
] as const

const BUNIT_AIRDROP_BALANCE_ABI = ['function getBUnitBalance(address account) view returns (uint256)'] as const

const BUNIT_DECIMALS = 6

export type BUnitBalanceSnapshot = {
	/** 可用于 consumeFromUser / 社交预检的余额（canonical BUint，经 Airdrop 读法） */
	feeUsable: number
	free: number
	paid: number
	/** 与 feeUsable 相同；保留 `total` 字段兼容旧客户端 */
	total: number
	/** 已废弃合约上的余额合计（不可用于网络扣费） */
	legacyDeprecatedTotal: number
	legacyDeprecatedByContract: Array<{ address: string; total: number }>
}

function units6ToNumber(raw: bigint): number {
	return Number(raw) / 10 ** BUNIT_DECIMALS
}

/** 读取 canonical BUint 明细 + 扣费可用余额 + 废弃合约余额（只读）。 */
export async function readBUnitBalanceSnapshot(
	provider: ethers.Provider,
	account: string
): Promise<BUnitBalanceSnapshot> {
	const normalized = ethers.getAddress(account)
	const airdrop = new ethers.Contract(CONET_BUNIT_AIRDROP_ADDRESS, BUNIT_AIRDROP_BALANCE_ABI, provider)
	const buint = new ethers.Contract(CONET_BUINT, BUINT_BALANCE_OF_ALL_ABI, provider)

	let feeUsableRaw = 0n
	let freeRaw = 0n
	let paidRaw = 0n
	try {
		feeUsableRaw = (await airdrop.getBUnitBalance(normalized)) as bigint
	} catch {
		feeUsableRaw = 0n
	}
	try {
		const [total, free, paid] = (await buint.balanceOfAll(normalized)) as [bigint, bigint, bigint]
		freeRaw = free
		paidRaw = paid
		if (feeUsableRaw === 0n && total > 0n) {
			feeUsableRaw = total
		}
	} catch {
		// keep feeUsable from airdrop path
	}

	const legacyDeprecatedByContract: Array<{ address: string; total: number }> = []
	let legacySumRaw = 0n
	for (const depRaw of CONET_DEPRECATED_BUINT_ADDRESSES) {
		if (!depRaw || !ethers.isAddress(depRaw)) continue
		const dep = ethers.getAddress(depRaw)
		if (dep.toLowerCase() === CONET_BUINT.toLowerCase()) continue
		try {
			const leg = new ethers.Contract(dep, BUINT_BALANCE_OF_ALL_ABI, provider)
			const [total] = (await leg.balanceOfAll(normalized)) as [bigint, bigint, bigint]
			if (total > 0n) {
				legacySumRaw += total
				legacyDeprecatedByContract.push({ address: dep, total: units6ToNumber(total) })
			}
		} catch {
			// skip unreadable legacy
		}
	}

	const feeUsable = units6ToNumber(feeUsableRaw)
	return {
		feeUsable,
		total: feeUsable,
		free: units6ToNumber(freeRaw),
		paid: units6ToNumber(paidRaw),
		legacyDeprecatedTotal: units6ToNumber(legacySumRaw),
		legacyDeprecatedByContract,
	}
}
