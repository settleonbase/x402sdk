import { SigningKey, Transaction, TypedDataEncoder, hashMessage, type Signature, type TypedDataDomain, type TypedDataField } from 'ethers'
import { ATTESTOR_ACCOUNT, HdRoot, PM_ACCOUNT } from './hd'
import type { RegistryBody } from './registry'

export type KeyRole = 'pm' | 'attestor' | 'array'

type Entry = {
	role: KeyRole
	array?: string
	account: number
	index: number
	address: string
	priv: Uint8Array
}

/**
 * Unlocked key material. Raw keys live in Uint8Array and are wiped on lock(). A SigningKey is
 * built per signature and dropped (ethers keeps a hex copy inside it; that copy is short-lived
 * garbage — the best JS can do).
 */
export class Keyring {
	private entries = new Map<string, Entry>()
	pmAddress = ''
	attestorAddress = ''

	load(hd: HdRoot, registry: RegistryBody | null): void {
		this.wipe()
		const pm = hd.derive(PM_ACCOUNT, 0)
		this.put({ role: 'pm', ...pm })
		this.pmAddress = pm.address
		const att = hd.derive(ATTESTOR_ACCOUNT, 0)
		this.put({ role: 'attestor', ...att })
		this.attestorAddress = att.address
		for (const arr of registry?.arrays ?? []) {
			for (let i = 0; i < arr.count; i++) {
				const k = hd.derive(arr.account, i)
				this.put({ role: 'array', array: arr.name, ...k })
			}
		}
	}

	addArrayKeys(hd: HdRoot, name: string, account: number, from: number, to: number): string[] {
		const out: string[] = []
		for (let i = from; i < to; i++) {
			const k = hd.derive(account, i)
			this.put({ role: 'array', array: name, ...k })
			out.push(k.address)
		}
		return out
	}

	private put(e: Entry): void {
		const key = e.address.toLowerCase()
		const prev = this.entries.get(key)
		if (prev) prev.priv.fill(0)
		this.entries.set(key, { role: e.role, array: e.array, account: e.account, index: e.index, address: e.address, priv: e.priv })
	}

	get unlocked(): boolean {
		return this.entries.size > 0
	}

	info(address: string): Omit<Entry, 'priv'> | undefined {
		const e = this.entries.get(address.toLowerCase())
		if (!e) return undefined
		const { priv: _priv, ...rest } = e
		return rest
	}

	private require(address: string): Entry {
		const e = this.entries.get(address.toLowerCase())
		if (!e) throw new Error('unknown or locked key')
		return e
	}

	signDigest(address: string, digest: string): Signature {
		const e = this.require(address)
		return new SigningKey(e.priv).sign(digest)
	}

	signTransaction(address: string, tx: Transaction): string {
		const e = this.require(address)
		if (tx.from && tx.from.toLowerCase() !== e.address.toLowerCase()) throw new Error('tx.from mismatch')
		const clone = tx.clone()
		clone.signature = this.signDigest(address, clone.unsignedHash)
		return clone.serialized
	}

	signTypedData(
		address: string,
		domain: TypedDataDomain,
		types: Record<string, TypedDataField[]>,
		value: Record<string, unknown>,
	): string {
		return this.signDigest(address, TypedDataEncoder.hash(domain, types, value)).serialized
	}

	signMessage(address: string, message: string | Uint8Array): string {
		return this.signDigest(address, hashMessage(message)).serialized
	}

	wipe(): void {
		for (const e of this.entries.values()) e.priv.fill(0)
		this.entries.clear()
		this.pmAddress = ''
		this.attestorAddress = ''
	}
}
