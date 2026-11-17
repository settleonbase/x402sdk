import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { TypedDataEncoder, getAddress, recoverAddress } from 'ethers'
import { canonicalHash } from './canonical'
import { ATTESTOR_ACCOUNT, FIRST_ARRAY_ACCOUNT, HdRoot, PM_ACCOUNT } from './hd'
import type { Keyring } from './keyring'

export type ArrayStatus = 'active' | 'retired'

/** One named key array, e.g. `settle_contractAdmin` → account 10, 4 keys. Names follow master.json. */
export type KeyArray = {
	name: string
	account: number
	count: number
	chains: number[]
	status: ArrayStatus
	addresses: string[]
	createdAt: string
	/** Account number this array replaced (rotation). */
	replaces?: number
	retiredAt?: string
}

export type RegistryBody = {
	version: 1
	pm: string
	attestor: string
	arrays: KeyArray[]
	updatedAt: string
}

export type RegistryFile = RegistryBody & { attestation: string }

const DOMAIN = { name: 'wallet-signer-registry', version: '1' }
const TYPES = { Registry: [{ name: 'contentHash', type: 'bytes32' }] }
export const ARRAY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function registryDigest(body: RegistryBody): string {
	return TypedDataEncoder.hash(DOMAIN, TYPES, { contentHash: canonicalHash(body) })
}

export function bodyOf(file: RegistryFile | RegistryBody): RegistryBody {
	const { attestation: _a, ...body } = file as RegistryFile
	return body as RegistryBody
}

export function signRegistry(keyring: Keyring, body: RegistryBody): RegistryFile {
	const sig = keyring.signDigest(keyring.attestorAddress, registryDigest(body)).serialized
	return { ...body, attestation: sig }
}

/** Returns a list of problems; empty means the registry matches this mnemonic. */
export function verifyRegistry(file: RegistryFile, hd: HdRoot): string[] {
	const problems: string[] = []
	const pm = hd.address(PM_ACCOUNT, 0)
	const attestor = hd.address(ATTESTOR_ACCOUNT, 0)
	if (getAddress(file.pm) !== pm) problems.push('pm address does not match mnemonic')
	if (getAddress(file.attestor) !== attestor) problems.push('attestor address does not match mnemonic')
	try {
		const signer = recoverAddress(registryDigest(bodyOf(file)), file.attestation)
		if (signer !== attestor) problems.push('attestation not signed by attestor')
	} catch {
		problems.push('attestation unreadable')
	}
	const seenNames = new Set<string>()
	const seenAccounts = new Set<number>()
	for (const arr of file.arrays) {
		if (!ARRAY_NAME_RE.test(arr.name)) problems.push(`bad array name ${arr.name}`)
		if (seenNames.has(arr.name) && arr.status === 'active') problems.push(`duplicate active array ${arr.name}`)
		if (arr.status === 'active') seenNames.add(arr.name)
		if (arr.account < FIRST_ARRAY_ACCOUNT) problems.push(`array ${arr.name} uses reserved account ${arr.account}`)
		if (seenAccounts.has(arr.account)) problems.push(`account ${arr.account} used twice`)
		seenAccounts.add(arr.account)
		if (arr.addresses.length !== arr.count) problems.push(`array ${arr.name} count/addresses mismatch`)
		for (let i = 0; i < arr.count; i++) {
			const want = hd.address(arr.account, i)
			if (!arr.addresses[i] || getAddress(arr.addresses[i]!) !== want) problems.push(`array ${arr.name}[${i}] address mismatch`)
		}
	}
	return problems
}

export function loadRegistry(path: string): RegistryFile | null {
	if (!existsSync(path)) return null
	return JSON.parse(readFileSync(path, 'utf8')) as RegistryFile
}

export function saveRegistry(path: string, file: RegistryFile): void {
	const tmp = `${path}.tmp`
	writeFileSync(tmp, `${JSON.stringify(file, null, '\t')}\n`, { mode: 0o640 })
	renameSync(tmp, path)
}

export function emptyRegistry(pm: string, attestor: string): RegistryBody {
	return { version: 1, pm, attestor, arrays: [], updatedAt: new Date().toISOString() }
}

export function activeArray(body: RegistryBody, name: string): KeyArray | undefined {
	return body.arrays.find((a) => a.name === name && a.status === 'active')
}

function nextAccount(body: RegistryBody): number {
	return body.arrays.reduce((max, a) => Math.max(max, a.account + 1), FIRST_ARRAY_ACCOUNT)
}

function checkChains(chains: number[]): number[] {
	if (!Array.isArray(chains) || chains.length === 0) throw new Error('chains required')
	for (const c of chains) if (!Number.isInteger(c) || c <= 0) throw new Error(`bad chain id ${c}`)
	return [...new Set(chains)].sort((a, b) => a - b)
}

function checkCount(count: number): number {
	if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('count must be 1..64')
	return count
}

/** New array on the next free account. Returns the new body (input is not mutated). */
export function addArray(body: RegistryBody, hd: HdRoot, name: string, count: number, chains: number[]): RegistryBody {
	if (!ARRAY_NAME_RE.test(name)) throw new Error('bad array name')
	if (activeArray(body, name)) throw new Error(`array ${name} already exists`)
	const account = nextAccount(body)
	const n = checkCount(count)
	const addresses = Array.from({ length: n }, (_, i) => hd.address(account, i))
	const arr: KeyArray = { name, account, count: n, chains: checkChains(chains), status: 'active', addresses, createdAt: new Date().toISOString() }
	return { ...body, arrays: [...body.arrays, arr], updatedAt: new Date().toISOString() }
}

/** More keys in the same account. Indexes only grow, never reused. */
export function growArray(body: RegistryBody, hd: HdRoot, name: string, count: number): RegistryBody {
	const arr = activeArray(body, name)
	if (!arr) throw new Error(`no active array ${name}`)
	const n = checkCount(count)
	if (n <= arr.count) throw new Error('count can only grow')
	const addresses = [...arr.addresses]
	for (let i = arr.count; i < n; i++) addresses.push(hd.address(arr.account, i))
	const arrays = body.arrays.map((a) => (a === arr ? { ...a, count: n, addresses } : a))
	return { ...body, arrays, updatedAt: new Date().toISOString() }
}

/** Retire the array's account and give the name a fresh account (same count and chains). */
export function rotateArray(body: RegistryBody, hd: HdRoot, name: string): RegistryBody {
	const arr = activeArray(body, name)
	if (!arr) throw new Error(`no active array ${name}`)
	const now = new Date().toISOString()
	const account = nextAccount(body)
	const addresses = Array.from({ length: arr.count }, (_, i) => hd.address(account, i))
	const arrays = body.arrays.map((a) => (a === arr ? { ...a, status: 'retired' as const, retiredAt: now } : a))
	arrays.push({ name, account, count: arr.count, chains: arr.chains, status: 'active', addresses, createdAt: now, replaces: arr.account })
	return { ...body, arrays, updatedAt: now }
}
