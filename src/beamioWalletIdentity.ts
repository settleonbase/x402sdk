/**
 * Resolve a pasted wallet address to canonical Beamio EOA + optional CoNET AA.
 * Used by search-users (address query) and multisig co-signer flows.
 */
import { ethers } from 'ethers'
import { CONET_AA_FACTORY, CONET_RPC_URL } from './chainAddresses'
import { resolveBeamioAaOnConet } from './endpoint/resolveBeamioAaViaUserCardFactory'
import { resolveBeamioBaseHttpRpcUrl } from './util'

export type BeamioWalletIdentity = {
	queriedAddress: string
	eoa: string
	aaAccount: string | null
	inputKind: 'eoa' | 'aa' | 'contract'
}

const aaFactoryAbi = [
	'function isBeamioAccount(address) view returns (bool)',
	'function beamioAccountOf(address) view returns (address)',
] as const
const ownerAbi = ['function owner() view returns (address)'] as const

async function readContractOwner(provider: ethers.Provider, addr: string): Promise<string | null> {
	try {
		const c = new ethers.Contract(addr, ownerAbi, provider)
		const o = (await c.owner()) as string
		if (!o || o === ethers.ZeroAddress) return null
		return ethers.getAddress(o)
	} catch {
		return null
	}
}

async function readIsBeamioAccount(provider: ethers.Provider, addr: string): Promise<boolean> {
	try {
		const fac = new ethers.Contract(CONET_AA_FACTORY, aaFactoryAbi, provider)
		return Boolean(await fac.isBeamioAccount(addr))
	} catch {
		return false
	}
}

/** CoNET getCode + factory isBeamioAccount + owner() → EOA; beamioAccountOf(eoa) → AA. */
export async function resolveBeamioWalletIdentityFromAddress(
	input: string,
	opts?: { conetProvider?: ethers.Provider; baseProvider?: ethers.Provider }
): Promise<BeamioWalletIdentity | null> {
	if (!ethers.isAddress(input)) return null
	const queriedAddress = ethers.getAddress(input)
	const conet = opts?.conetProvider ?? new ethers.JsonRpcProvider(CONET_RPC_URL)
	const base = opts?.baseProvider ?? new ethers.JsonRpcProvider(resolveBeamioBaseHttpRpcUrl())

	let code = ''
	try {
		code = await conet.getCode(queriedAddress)
	} catch {
		code = ''
	}
	const isContract = Boolean(code && code !== '0x' && code.length > 2)

	if (!isContract) {
		const aaAccount = await resolveBeamioAaOnConet(queriedAddress)
		return { queriedAddress, eoa: queriedAddress, aaAccount, inputKind: 'eoa' }
	}

	const isBeamioAa = await readIsBeamioAccount(conet, queriedAddress)
	let owner = await readContractOwner(conet, queriedAddress)
	if (!owner) {
		owner = await readContractOwner(base, queriedAddress)
	}

	if (owner) {
		const aaFromEoa = await resolveBeamioAaOnConet(owner)
		const aaAccount =
			aaFromEoa && aaFromEoa.toLowerCase() === queriedAddress.toLowerCase()
				? aaFromEoa
				: aaFromEoa ?? (isBeamioAa ? queriedAddress : null)
		return {
			queriedAddress,
			eoa: owner,
			aaAccount,
			inputKind: isBeamioAa || aaAccount === queriedAddress ? 'aa' : 'contract',
		}
	}

	if (isBeamioAa) {
		return {
			queriedAddress,
			eoa: queriedAddress,
			aaAccount: queriedAddress,
			inputKind: 'aa',
		}
	}

	return {
		queriedAddress,
		eoa: queriedAddress,
		aaAccount: null,
		inputKind: 'contract',
	}
}
