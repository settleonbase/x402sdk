import { HDKey } from '@scure/bip32'
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { computeAddress, getAddress, hexlify } from 'ethers'

/** m/44'/60'/0'/0/0 — the PM key: gas source, receives the user's CNET. */
export const PM_ACCOUNT = 0
/** m/44'/60'/1'/0/0 — signs the registry only. Never holds funds. */
export const ATTESTOR_ACCOUNT = 1
/** Key arrays get hardened accounts from 10 upward (2–9 reserved). */
export const FIRST_ARRAY_ACCOUNT = 10

export function bip44Path(account: number, index: number): string {
	if (!Number.isInteger(account) || account < 0 || account >= 2 ** 31) throw new Error('bad account')
	if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) throw new Error('bad index')
	return `m/44'/60'/${account}'/0/${index}`
}

export type DerivedKey = {
	account: number
	index: number
	path: string
	address: string
	/** Raw 32-byte key. Callers wipe it with fill(0) when done. */
	priv: Uint8Array
}

/**
 * HD root held only while the vault is unlocked. Uses @scure/bip32 so key material stays in
 * Uint8Array and can be wiped (ethers HDNodeWallet keeps hex strings).
 */
export class HdRoot {
	private root: HDKey | null

	private constructor(seed: Uint8Array) {
		this.root = HDKey.fromMasterSeed(seed)
		seed.fill(0)
	}

	static fromEntropy(entropy: Uint8Array): HdRoot {
		const phrase = entropyToMnemonic(entropy, wordlist)
		return new HdRoot(mnemonicToSeedSync(phrase))
	}

	derive(account: number, index: number): DerivedKey {
		if (!this.root) throw new Error('HD root wiped')
		const path = bip44Path(account, index)
		const child = this.root.derive(path)
		if (!child.privateKey || !child.publicKey) throw new Error('derivation failed')
		const priv = Uint8Array.from(child.privateKey)
		const address = getAddress(computeAddress(hexlify(child.publicKey)))
		child.wipePrivateData()
		return { account, index, path, address, priv }
	}

	/** Address only; the private key is wiped before returning. */
	address(account: number, index: number): string {
		const k = this.derive(account, index)
		k.priv.fill(0)
		return k.address
	}

	wipe(): void {
		this.root?.wipePrivateData()
		this.root = null
	}
}

/** 24 words (256-bit entropy) from the OS CSPRNG. */
export function newMnemonic(): string {
	return generateMnemonic(wordlist, 256)
}

export function isValidMnemonic(phrase: string): boolean {
	return validateMnemonic(phrase, wordlist)
}

export function mnemonicToEntropyBytes(phrase: string): Uint8Array {
	if (!validateMnemonic(phrase, wordlist)) throw new Error('invalid mnemonic')
	return mnemonicToEntropy(phrase, wordlist)
}

export { wordlist }
