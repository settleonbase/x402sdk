import { ethers } from 'ethers'
import {
	CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_DEFAULT,
	CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_FORMATTING_LIB,
	CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
	CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB,
	CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
	CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
	CONET_BEAMIO_USER_CARD_REFERRER_LIB,
	CONET_BEAMIO_USER_CARD_TRANSFER_LIB,
	CONET_BEAMIO_USER_CARD_UPDATE_LIB,
	CONET_BEAMIO_USER_CARD_VIEWS_LIB,
	CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB,
	CONET_CARD_FACTORY,
	CONET_MAINNET_CHAIN_ID,
	CONET_REFERRER_REGISTRY_LIB,
} from './chainAddresses'
import type { BeamioUserCardLibraryAddresses } from './CCSA'
import { resolveBeamioConetHttpRpcUrl } from './util'

export type BeamioUserCardChainKey = 'base' | 'conet'

const chainByCardCache = new Map<string, BeamioUserCardChainKey>()

let cachedProviderConet: ethers.JsonRpcProvider | undefined

/** Merchant BeamioUserCard chain. Merchant cards are CoNET-only; do not fall back to Base. */
export function defaultMerchantUserCardChain(): BeamioUserCardChainKey {
	return 'conet'
}

export function chainIdForUserCardChain(_chain: BeamioUserCardChainKey): number {
	return CONET_MAINNET_CHAIN_ID
}

export function cardFactoryForUserCardChain(_chain: BeamioUserCardChainKey): string {
	return CONET_CARD_FACTORY
}

export function defaultMerchantProgramCardAddress(): string {
	return CONET_BEAMIO_USER_CARD_DEFAULT
}

export function providerForUserCardChain(_chain: BeamioUserCardChainKey): ethers.JsonRpcProvider {
	if (!cachedProviderConet) {
		cachedProviderConet = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), CONET_MAINNET_CHAIN_ID)
	}
	return cachedProviderConet
}

export function beamioUserCardLibrariesForChain(_chain: BeamioUserCardChainKey): BeamioUserCardLibraryAddresses {
	return {
		BeamioUserCardAdminGatewayLib: CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
		BeamioUserCardFaucetGatewayLib: CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
		BeamioUserCardFormattingLib: CONET_BEAMIO_USER_CARD_FORMATTING_LIB,
		BeamioUserCardGatewayMintLib: CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
		BeamioUserCardGovernanceLib: CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB,
		BeamioUserCardIssuedNftGatewayLib: CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
		BeamioUserCardModuleRouterLib: CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
		BeamioUserCardRedeemGatewayLib: CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
		BeamioUserCardReferrerLib: CONET_BEAMIO_USER_CARD_REFERRER_LIB,
		BeamioUserCardTransferLib: CONET_BEAMIO_USER_CARD_TRANSFER_LIB,
		BeamioUserCardUpdateLib: CONET_BEAMIO_USER_CARD_UPDATE_LIB,
		BeamioUserCardViewsLib: CONET_BEAMIO_USER_CARD_VIEWS_LIB,
		BeamioUserCardMembershipGateLib: CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB,
		ReferrerRegistryLib: CONET_REFERRER_REGISTRY_LIB,
	}
}

/** Resolve merchant BeamioUserCard chain. Only CoNET is accepted for merchant cards. */
export async function resolveUserCardChain(
	cardAddress: string,
	_fallback: BeamioUserCardChainKey = defaultMerchantUserCardChain()
): Promise<BeamioUserCardChainKey> {
	const addr = ethers.getAddress(cardAddress)
	const cached = chainByCardCache.get(addr.toLowerCase())
	if (cached) return cached

	const conetCode = await providerForUserCardChain('conet').getCode(addr)
	if (conetCode && conetCode !== '0x') {
		chainByCardCache.set(addr.toLowerCase(), 'conet')
		return 'conet'
	}
	return 'conet'
}

/** True when BeamioUserCard bytecode exists on CoNET (224422). Base-only legacy cards return false. */
export async function hasCoNETUserCardBytecode(cardAddress: string): Promise<boolean> {
	try {
		const addr = ethers.getAddress(cardAddress)
		const code = await providerForUserCardChain('conet').getCode(addr)
		return !!(code && code !== '0x')
	} catch {
		return false
	}
}

export type MerchantCardRelayContext = {
	chain: BeamioUserCardChainKey
	chainId: number
	provider: ethers.JsonRpcProvider
	cardFactory: string
	wallet: ethers.Wallet
}

export function settleRelayWalletForChain(
	SC: { walletBase: ethers.Wallet; walletConet: ethers.Wallet },
	chain: BeamioUserCardChainKey
): ethers.Wallet {
	return chain === 'conet' ? SC.walletConet : SC.walletBase
}

export async function merchantCardRelayContext(
	SC: { walletBase: ethers.Wallet; walletConet: ethers.Wallet },
	cardAddress?: string | null
): Promise<MerchantCardRelayContext> {
	const chain = cardAddress && ethers.isAddress(cardAddress)
		? await resolveUserCardChain(cardAddress)
		: defaultMerchantUserCardChain()
	return {
		chain,
		chainId: chainIdForUserCardChain(chain),
		provider: providerForUserCardChain(chain),
		cardFactory: cardFactoryForUserCardChain(chain),
		wallet: settleRelayWalletForChain(SC, chain),
	}
}
