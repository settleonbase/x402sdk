/**
 * Private deny list for the Lab payout path. The concrete values (disabled admin addresses, the Claim/VDR payout
 * socket and key array names) live in a private file outside the repository. The file is named by
 * CONET_LAB_DENY_LIST_FILE and is JSON: { "addresses": [...], "sockets": [...], "keyArrays": [...] }.
 *
 * Fail closed: when the variable is unset, the file is missing or unreadable, or its shape is wrong, every check
 * that needs the list throws, and the daemon refuses to start.
 */
import fs from 'node:fs'
import { ethers } from 'ethers'

export type LabDenyList = {
	/** Lowercase addresses that the Lab path must never use or restore. */
	addresses: string[]
	/** Exact socket paths that the Lab path must never connect to. */
	sockets: string[]
	/** Exact key array names that the Lab path must never use. */
	keyArrays: string[]
}

let cache: { file: string; mtimeMs: number; list: LabDenyList } | null = null

function strings(v: unknown, field: string): string[] {
	if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim() !== '')) {
		throw new Error(`lab deny list: "${field}" must be an array of non-empty strings (fail closed)`)
	}
	return v.map((x) => x.trim())
}

export function loadLabDenyList(env: NodeJS.ProcessEnv = process.env): LabDenyList {
	const file = env.CONET_LAB_DENY_LIST_FILE?.trim() ?? ''
	if (!file) {
		throw new Error('CONET_LAB_DENY_LIST_FILE is not set: the private deny list is required (fail closed)')
	}
	let mtimeMs: number
	try {
		mtimeMs = fs.statSync(file).mtimeMs
	} catch {
		throw new Error('lab deny list file is missing or unreadable (fail closed)')
	}
	if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.list
	let raw: unknown
	try {
		raw = JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch {
		throw new Error('lab deny list file is not valid JSON (fail closed)')
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('lab deny list must be a JSON object (fail closed)')
	}
	const obj = raw as Record<string, unknown>
	const addresses = strings(obj.addresses ?? [], 'addresses').map((a) => {
		try {
			return ethers.getAddress(a).toLowerCase()
		} catch {
			throw new Error('lab deny list: an address entry is not a valid address (fail closed)')
		}
	})
	const list: LabDenyList = {
		addresses,
		sockets: strings(obj.sockets ?? [], 'sockets'),
		keyArrays: strings(obj.keyArrays ?? [], 'keyArrays'),
	}
	cache = { file, mtimeMs, list }
	return list
}
