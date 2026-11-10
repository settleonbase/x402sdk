/**
 * x402sdk glue for wallet-signer. Features switch one by one via WALLET_SIGNER_FEATURES
 * ("chat", "gbAirdrop", "registration"); anything not listed keeps the legacy master.json wallets.
 */
import { JsonRpcProvider } from 'ethers'
import { resolveBeamioConetHttpRpcUrl } from '../util'
import { RemoteKeyArrayPool, WalletSignerClient, walletSignerFeatureEnabled } from './remoteSigner'

export const CONET_CHAIN_ID = 224422

/**
 * Optional chat array name. Blank unless WALLET_SIGNER_CHAT_ARRAY is set.
 * Do not default this to settle_contractAdmin. Callers use explicitChatRelayArray()
 * and refuse the settle admin name instead of falling back to the legacy pool.
 */
export const CHAT_RELAY_KEY_ARRAY = process.env.WALLET_SIGNER_CHAT_ARRAY?.trim() || ''
export const GB_AIRDROP_KEY_ARRAY = process.env.WALLET_SIGNER_GB_AIRDROP_ARRAY?.trim() || 'gbDepinAirdropAdmin'

let client: WalletSignerClient | undefined
let conetProvider: JsonRpcProvider | undefined
const pools = new Map<string, RemoteKeyArrayPool>()

export function walletSignerFor(feature: 'chat' | 'gbAirdrop' | 'registration'): boolean {
	return walletSignerFeatureEnabled(feature)
}

export function walletSignerClient(): WalletSignerClient {
	if (!client) client = WalletSignerClient.fromEnv()
	return client
}

function provider(): JsonRpcProvider {
	if (!conetProvider) {
		const url = process.env.CONET_RPC_URL?.trim() || resolveBeamioConetHttpRpcUrl()
		conetProvider = new JsonRpcProvider(url, CONET_CHAIN_ID, { batchMaxCount: 1, staticNetwork: true })
	}
	return conetProvider
}

export function conetSignerPool(keyArray: string): RemoteKeyArrayPool {
	let p = pools.get(keyArray)
	if (!p) {
		p = new RemoteKeyArrayPool(walletSignerClient(), keyArray, CONET_CHAIN_ID, provider())
		pools.set(keyArray, p)
	}
	return p
}
