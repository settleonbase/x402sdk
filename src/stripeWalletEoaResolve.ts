import { ethers } from 'ethers'
import { BASE_AA_FACTORY, CONET_AA_FACTORY, CONET_AA_FACTORY_V2, CONET_RPC_URL } from './chainAddresses'

const BASE_RPC_HTTP_DEFAULT = 'https://base-rpc.conet.network'

const AA_FACTORY_RESOLVE_ABI = [
	'function beamioAccountOf(address) view returns (address)',
	'function primaryAccountOf(address) view returns (address)',
] as const

/**
 * Stripe Crypto Onramp 创建时锁定收款 EOA。客户端可能把 Beamio AA（与 profile keyID 相同）当作 wallet 传入。
 * 先在 Base 上校验；若该地址在 Base 无 code（Consumer AA 仅 CoNET），再在 CoNET 上用 V1/V2 Factory 解析 owner。
 * RPC 失败时回退原地址（不得把失败当成「无 owner」清空）。
 *
 * Merchant Kit 等仍可用本函数。Onramp 购买成功以 Stripe `fulfillment_complete` 为准，
 * **不要**在 createSession 里走这条（会打 `base-rpc.conet.network`，追头时可能卡住 Opening）。
 */
export async function resolveStripeMintRecipientEoaOnBase(walletAddress: string): Promise<string> {
	const addr = ethers.getAddress(walletAddress)
	const fromBase = await tryResolveAaOwnerOnChain(addr, resolveBaseRpc(), [BASE_AA_FACTORY])
	if (fromBase) {
		return fromBase
	}
	const fromConet = await tryResolveAaOwnerOnChain(addr, resolveConetRpc(), [
		CONET_AA_FACTORY,
		CONET_AA_FACTORY_V2,
	])
	if (fromConet) {
		return fromConet
	}
	return addr
}

const ONRAMP_CONET_RESOLVE_MS = 2_000

/**
 * Onramp create：不打 Base RPC。客户端应传 EOA（`keyID`）。
 * 若误传 CoNET AA，最多等 2s 解析 owner；超时 / 失败回退原地址。
 * 购买 loading→success 只信 Stripe，不读 Base 余额。
 */
export async function resolveStripeOnrampRecipientEoa(walletAddress: string): Promise<string> {
	const addr = ethers.getAddress(walletAddress)
	const fromConet = await withTimeout(
		tryResolveAaOwnerOnChain(addr, resolveConetRpc(), [CONET_AA_FACTORY, CONET_AA_FACTORY_V2]),
		ONRAMP_CONET_RESOLVE_MS
	)
	return fromConet ?? addr
}

function withTimeout<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms)
		void work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			() => {
				clearTimeout(timer)
				resolve(null)
			}
		)
	})
}

function resolveBaseRpc(): string {
	return (
		(typeof process !== 'undefined' && process.env.BASE_RPC_URL?.trim()) || BASE_RPC_HTTP_DEFAULT
	).replace(/\/$/, '')
}

function resolveConetRpc(): string {
	return (
		(typeof process !== 'undefined' && process.env.CONET_RPC_URL?.trim()) || CONET_RPC_URL
	).replace(/\/$/, '')
}

/**
 * 若 `addr` 是该链上 Beamio AA 且 Factory 确认归属，返回 owner EOA；否则 `null`。
 * RPC / 解析失败返回 `null`（调用方回退原地址）。
 */
async function tryResolveAaOwnerOnChain(
	addr: string,
	rpcUrl: string,
	factoryAddresses: string[]
): Promise<string | null> {
	const provider = new ethers.JsonRpcProvider(rpcUrl)
	let code: string
	try {
		code = await provider.getCode(addr)
	} catch {
		return null
	}
	if (!code || code === '0x') {
		return null
	}
	const acct = new ethers.Contract(addr, ['function owner() view returns (address)'], provider)
	let ownerRaw: string
	try {
		ownerRaw = await acct.owner()
	} catch {
		return null
	}
	if (!ownerRaw || ownerRaw === ethers.ZeroAddress) {
		return null
	}
	let ownerAddr: string
	try {
		ownerAddr = ethers.getAddress(ownerRaw)
	} catch {
		return null
	}
	for (const factory of factoryAddresses) {
		const fac = new ethers.Contract(factory, AA_FACTORY_RESOLVE_ABI, provider)
		try {
			let aa = await fac.beamioAccountOf(ownerAddr)
			if (!aa || aa === ethers.ZeroAddress) {
				aa = await fac.primaryAccountOf(ownerAddr).catch(() => ethers.ZeroAddress)
			}
			if (aa && aa !== ethers.ZeroAddress && ethers.getAddress(aa) === addr) {
				return ownerAddr
			}
		} catch {
			/* not this factory */
		}
	}
	return null
}
