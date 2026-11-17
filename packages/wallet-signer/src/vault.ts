import { readFileSync } from 'node:fs'
import { decryptKeystoreJson, encryptKeystoreJson, getBytes, hexlify, isKeystoreJson } from 'ethers'
import { HdRoot, PM_ACCOUNT, bip44Path } from './hd'

/** Production scrypt cost: N=2^18, r=8, p=1 (~256 MB, a few seconds per unlock). */
export const DEFAULT_SCRYPT_N = 2 ** 18

/**
 * The vault is a standard Web3 Secret Storage v3 file with the ethers `x-ethers` mnemonic
 * extension. Its address / key are the PM key (m/44'/60'/0'/0/0), so a recovery drill on any
 * machine is `ethers.Wallet.fromEncryptedJson(json, password)` and checking the PM address.
 */
export async function createVaultJson(entropy: Uint8Array, password: string, scryptN = DEFAULT_SCRYPT_N): Promise<string> {
	if (password.length < 12) throw new Error('password too short (min 12 characters)')
	const hd = HdRoot.fromEntropy(Uint8Array.from(entropy))
	const pm = hd.derive(PM_ACCOUNT, 0)
	try {
		return await encryptKeystoreJson(
			{
				address: pm.address,
				privateKey: hexlify(pm.priv),
				mnemonic: { entropy: hexlify(entropy), path: bip44Path(PM_ACCOUNT, 0), locale: 'en' },
			},
			password,
			{ scrypt: { N: scryptN, r: 8, p: 1 } },
		)
	} finally {
		pm.priv.fill(0)
		hd.wipe()
	}
}

export type OpenedVault = { entropy: Uint8Array; pmAddress: string }

/** Throws on a wrong password (MAC mismatch). */
export async function openVault(json: string, password: string): Promise<OpenedVault> {
	if (!isKeystoreJson(json)) throw new Error('vault file is not a keystore v3 JSON')
	const acct = await decryptKeystoreJson(json, password)
	if (!acct.mnemonic?.entropy) throw new Error('vault has no mnemonic')
	const entropy = getBytes(acct.mnemonic.entropy)
	// Cross-check: the mnemonic must derive the PM address stored in the file.
	const hd = HdRoot.fromEntropy(Uint8Array.from(entropy))
	try {
		const pm = hd.address(PM_ACCOUNT, 0)
		if (pm.toLowerCase() !== acct.address.toLowerCase()) throw new Error('vault mnemonic does not match its address')
	} finally {
		hd.wipe()
	}
	return { entropy, pmAddress: acct.address }
}

export function vaultAddress(json: string): string {
	const parsed = JSON.parse(json) as { address?: string }
	if (!parsed.address) throw new Error('vault has no address field')
	return parsed.address.startsWith('0x') ? parsed.address : `0x${parsed.address}`
}

export function readVaultFile(path: string): string {
	return readFileSync(path, 'utf8')
}
