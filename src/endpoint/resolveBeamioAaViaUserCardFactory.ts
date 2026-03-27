/**
 * Resolve EOA → AA the same way BeamioUserCard does: UserCardFactoryPaymaster._aaFactory() then beamioAccountOf(eoa).
 * Falls back to BASE_AA_FACTORY when _aaFactory is unavailable (aligns with chainAddresses / provision tooling).
 */
import { ethers } from 'ethers'
import { BASE_AA_FACTORY, BASE_CARD_FACTORY } from '../chainAddresses'

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

/** Try User Card factory path first, then config BASE_AA_FACTORY. */
export async function resolveBeamioAaForEoaWithFallback(
	provider: ethers.Provider,
	eoa: string,
	userCardFactoryPaymaster: string = BASE_CARD_FACTORY
): Promise<string | null> {
	const primary = await resolveBeamioAaForEoaViaUserCardFactory(provider, eoa, userCardFactoryPaymaster)
	if (primary) return primary
	return beamioAaFromFactory(provider, eoa, BASE_AA_FACTORY)
}
