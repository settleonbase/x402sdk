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

/**
 * Walk Beamio AA `owner()` until a non-AA address (true EOA).
 * Prevents treating a nested AA's owner (primary AA) as the EOA.
 */
export async function unwrapTrueEoaFromBeamioAa(
	maybeAaOrEoa: string,
	conet: ethers.Provider,
	maxDepth = 8
): Promise<string> {
	let cur = ethers.getAddress(maybeAaOrEoa)
	for (let depth = 0; depth < maxDepth; depth++) {
		const isAcct = await readIsBeamioAccount(conet, cur)
		if (!isAcct) return cur
		const owner = await readContractOwner(conet, cur)
		if (!owner || owner.toLowerCase() === cur.toLowerCase()) return cur
		cur = owner
	}
	return cur
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
	if (isBeamioAa) {
		const trueEoa = await unwrapTrueEoaFromBeamioAa(queriedAddress, conet)
		const aaFromEoa = await resolveBeamioAaOnConet(trueEoa)
		return {
			queriedAddress,
			eoa: trueEoa,
			aaAccount: aaFromEoa ?? queriedAddress,
			inputKind: 'aa',
		}
	}

	let owner = await readContractOwner(conet, queriedAddress)
	if (!owner) {
		owner = await readContractOwner(base, queriedAddress)
	}

	if (owner) {
		const trueEoa = await unwrapTrueEoaFromBeamioAa(owner, conet)
		const aaFromEoa = await resolveBeamioAaOnConet(trueEoa)
		return {
			queriedAddress,
			eoa: trueEoa,
			aaAccount: aaFromEoa,
			inputKind: 'contract',
		}
	}

	return {
		queriedAddress,
		eoa: queriedAddress,
		aaAccount: null,
		inputKind: 'contract',
	}
}
