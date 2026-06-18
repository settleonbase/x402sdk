/**
 * Resolve EOA → AA：仅使用 **链上** `UserCardFactoryPaymaster._aaFactory()` 再 `beamioAccountOf(eoa)`（与发卡工厂绑定的新 AA 工厂一致）。
 *
 * **不再回退 `BASE_AA_FACTORY`（0x4b31…）**：该常量与当前卡工厂 `_aaFactory()` 常不一致，回退会解析到「旧部署」上的 AA，与 OpenContainer / getUIDAssets 卡路径分裂。
 */
import { ethers } from 'ethers'
import { BASE_CARD_FACTORY, CONET_AA_FACTORY } from '../chainAddresses'
import { providerForUserCardChain } from '../beamioUserCardChain'

const userCardFactoryPaymasterAbi = ['function _aaFactory() view returns (address)'] as const
const aaFactoryAbi = ['function beamioAccountOf(address) view returns (address)'] as const

export async function getAaFactoryAddressFromUserCardFactoryPaymaster(
	provider: ethers.Provider,
	userCardFactoryPaymaster: string = BASE_CARD_FACTORY
): Promise<string | null> {
	try {
		const fac = new ethers.Contract(userCardFactoryPaymaster, userCardFactoryPaymasterAbi, provider)
		const addr = await fac._aaFactory()
		if (!addr || addr === ethers.ZeroAddress) return null
		const code = await provider.getCode(addr)
		if (!code || code === '0x' || code.length <= 2) return null
		return ethers.getAddress(addr)
	} catch {
		return null
	}
}

async function beamioAaFromFactory(provider: ethers.Provider, eoa: string, aaFactoryAddr: string): Promise<string | null> {
	try {
		const eoaAddr = ethers.getAddress(eoa)
		const aaFactory = new ethers.Contract(aaFactoryAddr, aaFactoryAbi, provider)
		const primary = await aaFactory.beamioAccountOf(eoaAddr)
		if (!primary || primary === ethers.ZeroAddress) return null
		const code = await provider.getCode(primary)
		return code && code !== '0x' && code.length > 2 ? ethers.getAddress(primary) : null
	} catch {
		return null
	}
}

/** Prefer factory wired on UserCardFactoryPaymaster (matches getOwnershipByEOA / OpenContainer account). */
export async function resolveBeamioAaForEoaViaUserCardFactory(
	provider: ethers.Provider,
	eoa: string,
	userCardFactoryPaymaster: string = BASE_CARD_FACTORY
): Promise<string | null> {
	const aaFac = await getAaFactoryAddressFromUserCardFactoryPaymaster(provider, userCardFactoryPaymaster)
	if (!aaFac) return null
	return beamioAaFromFactory(provider, eoa, aaFac)
}

/** CoNET 224422：跨链同址 BEAMIO_AA_FACTORY 上查已部署 AA（须 getCode 非空）。新 AA 仅在此链部署。 */
export async function resolveBeamioAaOnConet(eoa: string): Promise<string | null> {
	const provider = providerForUserCardChain('conet')
	return beamioAaFromFactory(provider, eoa, CONET_AA_FACTORY)
}

/** 解析 EOA → AA：仅 CoNET（224422）；Base 不再部署或回退。`provider` 参数保留兼容，忽略链选择。 */
export async function resolveBeamioAaForEoaWithFallback(
	_provider: ethers.Provider,
	eoa: string,
	_userCardFactoryPaymaster?: string
): Promise<string | null> {
	return resolveBeamioAaOnConet(eoa)
}
