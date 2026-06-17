import { ethers } from 'ethers'
import {
	BASE_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
	BASE_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
	BASE_BEAMIO_USER_CARD_FORMATTING_LIB,
	BASE_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
	BASE_BEAMIO_USER_CARD_GOVERNANCE_LIB,
	BASE_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
	BASE_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
	BASE_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
	BASE_BEAMIO_USER_CARD_REFERRER_LIB,
	BASE_BEAMIO_USER_CARD_TRANSFER_LIB,
	BASE_BEAMIO_USER_CARD_UPDATE_LIB,
	BASE_BEAMIO_USER_CARD_VIEWS_LIB,
	BASE_CARD_FACTORY,
	BASE_CCSA_CARD_ADDRESS,
	BASE_MAINNET_CHAIN_ID,
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
	CONET_CARD_FACTORY,
	CONET_MAINNET_CHAIN_ID,
	CONET_REFERRER_REGISTRY_LIB,
} from './chainAddresses'
import type { BeamioUserCardLibraryAddresses } from './CCSA'
import { resolveBeamioBaseHttpRpcUrl, resolveBeamioConetHttpRpcUrl } from './util'

export type BeamioUserCardChainKey = 'base' | 'conet'

const chainByCardCache = new Map<string, BeamioUserCardChainKey>()

let cachedProviderBase: ethers.JsonRpcProvider | undefined
let cachedProviderConet: ethers.JsonRpcProvider | undefined

/** Merchant createCard / Charge default chain. Override with BEAMIO_MERCHANT_USER_CARD_CHAIN=base for rollback. */
export function defaultMerchantUserCardChain(): BeamioUserCardChainKey {
	const raw = typeof process !== 'undefined' ? process.env?.BEAMIO_MERCHANT_USER_CARD_CHAIN?.trim().toLowerCase() : ''
	return raw === 'base' ? 'base' : 'conet'
}

export function chainIdForUserCardChain(chain: BeamioUserCardChainKey): number {
	return chain === 'conet' ? CONET_MAINNET_CHAIN_ID : BASE_MAINNET_CHAIN_ID
}

export function cardFactoryForUserCardChain(chain: BeamioUserCardChainKey): string {
	return chain === 'conet' ? CONET_CARD_FACTORY : BASE_CARD_FACTORY
}

export function defaultMerchantProgramCardAddress(): string {
	return defaultMerchantUserCardChain() === 'conet'
		? CONET_BEAMIO_USER_CARD_DEFAULT
		: BASE_CCSA_CARD_ADDRESS
}

export function providerForUserCardChain(chain: BeamioUserCardChainKey): ethers.JsonRpcProvider {
	if (chain === 'conet') {
		if (!cachedProviderConet) {
			cachedProviderConet = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), CONET_MAINNET_CHAIN_ID)
		}
		return cachedProviderConet
	}
	if (!cachedProviderBase) {
		cachedProviderBase = new ethers.JsonRpcProvider(resolveBeamioBaseHttpRpcUrl(), BASE_MAINNET_CHAIN_ID)
	}
	return cachedProviderBase
}

export function beamioUserCardLibrariesForChain(chain: BeamioUserCardChainKey): BeamioUserCardLibraryAddresses {
	if (chain === 'conet') {
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
			ReferrerRegistryLib: CONET_REFERRER_REGISTRY_LIB,
		}
	}
	return {
		BeamioUserCardAdminGatewayLib: BASE_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
		BeamioUserCardFaucetGatewayLib: BASE_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
		BeamioUserCardFormattingLib: BASE_BEAMIO_USER_CARD_FORMATTING_LIB,
		BeamioUserCardGatewayMintLib: BASE_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
		BeamioUserCardGovernanceLib: BASE_BEAMIO_USER_CARD_GOVERNANCE_LIB,
		BeamioUserCardIssuedNftGatewayLib: BASE_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
		BeamioUserCardModuleRouterLib: BASE_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
		BeamioUserCardRedeemGatewayLib: BASE_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
		BeamioUserCardReferrerLib: BASE_BEAMIO_USER_CARD_REFERRER_LIB,
		BeamioUserCardTransferLib: BASE_BEAMIO_USER_CARD_TRANSFER_LIB,
		BeamioUserCardUpdateLib: BASE_BEAMIO_USER_CARD_UPDATE_LIB,
		BeamioUserCardViewsLib: BASE_BEAMIO_USER_CARD_VIEWS_LIB,
	}
}

/** Detect which chain hosts a BeamioUserCard; falls back to merchant default when bytecode missing on both. */
export async function resolveUserCardChain(
	cardAddress: string,
	fallback: BeamioUserCardChainKey = defaultMerchantUserCardChain()
): Promise<BeamioUserCardChainKey> {
	const addr = ethers.getAddress(cardAddress)
	const cached = chainByCardCache.get(addr.toLowerCase())
	if (cached) return cached

	const conetCode = await providerForUserCardChain('conet').getCode(addr)
	if (conetCode && conetCode !== '0x') {
		chainByCardCache.set(addr.toLowerCase(), 'conet')
		return 'conet'
	}
	const baseCode = await providerForUserCardChain('base').getCode(addr)
	if (baseCode && baseCode !== '0x') {
		chainByCardCache.set(addr.toLowerCase(), 'base')
		return 'base'
	}
	return fallback
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
