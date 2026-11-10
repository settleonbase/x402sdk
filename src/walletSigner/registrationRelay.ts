/**
 * registrationAdmin remote path. Off means the caller keeps the legacy admin wallets.
 * This module does not read master.json.
 */
import { Interface, JsonRpcProvider } from 'ethers'
import { WalletSignerClient, walletSignerFeatureEnabled } from './remoteSigner'

export const REGISTRATION_FEATURE = 'registration'
export const REGISTRATION_KEY_ARRAY = process.env.WALLET_SIGNER_REGISTRATION_ARRAY?.trim() || 'registrationAdmin'
export const REGISTRATION_PGP = process.env.WALLET_SIGNER_PGP_ADDRESS?.trim() || '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2'
export const REGISTRATION_ACCOUNT_REGISTRY = process.env.WALLET_SIGNER_ACCOUNT_REGISTRY?.trim() || '0xfFDc8d2021A41F4638Cb3eCf58B5155383EE9f6d'

const pgpIface = new Interface([
	'function addPublicPGPByAdmin(address wallet,string keyID,string publicKeyArmored,string encrypKeyArmored,string routeKeyID)',
])
const accountIface = new Interface([
	'function setAccountByAdmin(address wallet,(string accountName,string image,bool darkTheme,bool isUSDCFaucet,bool isETHFaucet,bool initialLoading,string firstName,string lastName,string pgpKeyID,string pgpKey) account)',
	'function setBase64NameByAdmin(bytes32 hash,string encrypto,string accountName,address wallet)',
])

export type RegistrationAccount = {
	accountName: string
	image: string
	darkTheme: boolean
	isUSDCFaucet: boolean
	isETHFaucet: boolean
	initialLoading: boolean
	firstName: string
	lastName: string
	pgpKeyID: string
	pgpKey: string
}

export function registrationRemoteEnabled(): boolean {
	return walletSignerFeatureEnabled(REGISTRATION_FEATURE)
}

export function registrationReadProvider(rpcUrl: string): JsonRpcProvider {
	const url = process.env.CONET_RPC_URL?.trim() || rpcUrl
	return new JsonRpcProvider(url, 224422, { staticNetwork: true })
}

export function encodeAddPublicPgp(input: {
	wallet: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
}): string {
	return pgpIface.encodeFunctionData('addPublicPGPByAdmin', [
		input.wallet,
		input.keyID,
		input.publicKeyArmored,
		input.encrypKeyArmored,
		input.routeKeyID,
	])
}

export function encodeSetAccountByAdmin(wallet: string, account: RegistrationAccount): string {
	return accountIface.encodeFunctionData('setAccountByAdmin', [wallet, account])
}

export function encodeSetBase64NameByAdmin(hash: string, encrypto: string, accountName: string, wallet: string): string {
	return accountIface.encodeFunctionData('setBase64NameByAdmin', [hash, encrypto, accountName, wallet])
}

/** Broadcast one already-authorized registration call. Value is always zero. */
export async function submitRegistrationCall(call: {
	to: string
	data: string
	gasLimit?: bigint
	idempotencyKey?: string
}): Promise<{ txHash: string }> {
	const client = WalletSignerClient.fromEnv()
	try {
		const res = await client.call<{ hash?: string }>('signer_sendTransaction', {
			keyArray: REGISTRATION_KEY_ARRAY,
			chainId: 224422,
			to: call.to,
			data: call.data,
			value: '0',
			gasLimit: (call.gasLimit ?? 500_000n).toString(),
			idempotencyKey: call.idempotencyKey,
		})
		if (!res?.hash) throw new Error('registration signer returned no hash')
		return { txHash: res.hash }
	} finally {
		client.close()
	}
}
