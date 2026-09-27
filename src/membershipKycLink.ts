import { ethers } from 'ethers'
import { getCardByAddress } from './db'
import { chainIdForUserCardChain, providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'
const KYC_ABI = [
	'function kycIpfsHashOf(address) view returns (bytes32)',
	'function isAdmin(address) view returns (bool)',
]

const LINK_WALLET_TYPES = {
	LinkKycIpfsHash: [
		{ name: 'wallet', type: 'address' },
		{ name: 'ipfsHash', type: 'bytes32' },
		{ name: 'deadline', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
	],
}

const LINK_ADMIN_TYPES = {
	LinkKycIpfsHashByAdmin: [
		{ name: 'wallet', type: 'address' },
		{ name: 'ipfsHash', type: 'bytes32' },
		{ name: 'deadline', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
	],
}

export const KYC_LINK_REQUIRED_ERROR =
	'Add your membership details before this membership can be issued.'

function kycEnabledFromMetadata(meta: unknown): boolean {
	if (!meta || typeof meta !== 'object') return false
	const share = (meta as { shareTokenMetadata?: unknown }).shareTokenMetadata
	if (!share || typeof share !== 'object') return false
	const kyc = (share as { kyc?: unknown }).kyc
	if (!kyc || typeof kyc !== 'object') return false
	return (kyc as { enabled?: unknown }).enabled === true
}

/** When the merchant published KYC and this wallet has no ciphertext hash, membership issue must stop. */
export async function assertMembershipKycLinked(
	cardAddress: string,
	wallet: string
): Promise<{ success: true } | { success: false; error: string }> {
	let enabled = false
	try {
		const row = await getCardByAddress(ethers.getAddress(cardAddress))
		enabled = kycEnabledFromMetadata(row?.metadata)
	} catch {
		return { success: true }
	}
	if (!enabled) return { success: true }
	try {
		const card = ethers.getAddress(cardAddress)
		const user = ethers.getAddress(wallet)
		const provider = providerForUserCardChain(await resolveUserCardChain(card))
		const contract = new ethers.Contract(card, KYC_ABI, provider)
		const hash = (await contract.kycIpfsHashOf(user)) as string
		if (!hash || hash === ethers.ZeroHash) {
			return { success: false, error: KYC_LINK_REQUIRED_ERROR }
		}
		return { success: true }
	} catch {
		/** Unbound module: do not treat a revert as "unlinked" for cards that cannot store the hash yet. */
		return { success: true }
	}
}

export async function linkMembershipKycPreCheck(body: {
	cardAddress?: string
	wallet?: string
	ipfsHash?: string
	deadline?: string | number
	nonce?: string | number
	signature?: string
	signerKind?: string
}): Promise<{ success: boolean; error?: string; preChecked?: Record<string, unknown> }> {
	try {
		const card = ethers.getAddress(String(body.cardAddress || ''))
		const wallet = ethers.getAddress(String(body.wallet || ''))
		const ipfsHash = ethers.hexlify(ethers.getBytes(String(body.ipfsHash || '')))
		if (ipfsHash.length !== 66 || ipfsHash === ethers.ZeroHash) {
			return { success: false, error: 'Invalid membership information reference.' }
		}
		const deadline = BigInt(body.deadline ?? 0)
		const nonce = BigInt(body.nonce ?? 0)
		const signature = String(body.signature || '')
		if (deadline <= BigInt(Math.floor(Date.now() / 1000))) {
			return { success: false, error: 'Membership information signature expired.' }
		}
		const chain = await resolveUserCardChain(card)
		const provider = providerForUserCardChain(chain)
		const factory = (await new ethers.Contract(
			card,
			['function factoryGateway() view returns (address)'],
			provider
		).factoryGateway()) as string
		const domain = {
			name: 'BeamioUserCardFactory',
			version: '1',
			chainId: chainIdForUserCardChain(chain),
			verifyingContract: factory,
		}
		const admin = body.signerKind === 'admin'
		const types = admin ? LINK_ADMIN_TYPES : LINK_WALLET_TYPES
		const message = { wallet, ipfsHash, deadline, nonce }
		const recovered = ethers.verifyTypedData(domain, types, message, signature)
		if (!admin && recovered.toLowerCase() !== wallet.toLowerCase()) {
			return { success: false, error: 'Membership information signature does not match this wallet.' }
		}
		if (admin) {
			const provider = providerForUserCardChain(chain)
			const contract = new ethers.Contract(card, KYC_ABI, provider)
			const ok = (await contract.isAdmin(recovered)) as boolean
			if (!ok) return { success: false, error: 'Signer is not a merchant admin.' }
		}
		const iface = new ethers.Interface([
			'function linkKycIpfsHashWithSignature(address wallet,bytes32 ipfsHash,uint256 deadline,uint256 nonce,bytes signature)',
			'function linkKycIpfsHashByAdmin(address wallet,bytes32 ipfsHash,uint256 deadline,uint256 nonce,bytes adminSignature)',
		])
		const cardCallData = admin
			? iface.encodeFunctionData('linkKycIpfsHashByAdmin', [wallet, ipfsHash, deadline, nonce, signature])
			: iface.encodeFunctionData('linkKycIpfsHashWithSignature', [wallet, ipfsHash, deadline, nonce, signature])
		return {
			success: true,
			preChecked: { cardAddress: card, cardCallData, label: 'linkMembershipKyc' },
		}
	} catch {
		return { success: false, error: 'Could not verify the membership information signature.' }
	}
}
