/**
 * Wallet pool configuration of the Lab payout daemon (P4; design DESIGN-pools-P3-P4-onepager). A read-only JSON file named by CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_FILE:
 *   { "realtime": [ { "id", "socket", "keyArray", "address", "state": "active" | "draining" } ], "history": [ ... ] }
 * Rules checked at load (a violation refuses to start, nothing is guessed): ids are unique across both pools and use [A-Za-z0-9_.-] only (they become lane names and slot keys); every wallet
 * has its own address, key array and socket (no two wallets share any of the three, so no two wallets can ever sign for the same nonce stream); the address is a valid 0x address; the state is
 * 'active' or 'draining'; `minActive` (default 2, the plan's rule; tests pass 1) active wallets per pool, unless the pool is absent (the other pool then does not exist either: both or none).
 * A `draining` wallet finishes what it holds (slot) and claims nothing new. The file's sha256 goes into the start-up log line. No key material is read here.
 * Node built-ins only.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'

export type PoolLine = 'realtime' | 'history'
export type PoolWallet = { id: string; line: PoolLine; socket: string; keyArray: string; address: string; state: 'active' | 'draining' }
export type PoolConfig = { wallets: PoolWallet[]; sha256: string }

const ID_RE = /^[A-Za-z0-9_.-]{1,48}$/
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

export function parsePoolConfig(text: string, opts: { minActive?: number } = {}): PoolConfig {
	const minActive = opts.minActive ?? 2
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (e) {
		throw new Error(`labPoolConfig: not valid JSON: ${(e as Error).message}`)
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('labPoolConfig: the top level must be an object with "realtime" and "history" arrays')
	const o = raw as Record<string, unknown>
	for (const k of Object.keys(o)) if (k !== 'realtime' && k !== 'history') throw new Error(`labPoolConfig: unknown top-level key "${k}"`)
	const wallets: PoolWallet[] = []
	const seen = { id: new Set<string>(), address: new Set<string>(), keyArray: new Set<string>(), socket: new Set<string>() }
	for (const line of ['realtime', 'history'] as const) {
		const arr = o[line]
		if (!Array.isArray(arr) || arr.length === 0) throw new Error(`labPoolConfig: "${line}" must be a non-empty array (both pools or no pool file)`)
		let active = 0
		for (const w of arr) {
			if (!w || typeof w !== 'object') throw new Error(`labPoolConfig: ${line}: a wallet entry is not an object`)
			const r = w as Record<string, unknown>
			for (const k of Object.keys(r)) if (!['id', 'socket', 'keyArray', 'address', 'state'].includes(k)) throw new Error(`labPoolConfig: ${line}: unknown wallet field "${k}"`)
			const id = String(r.id ?? '')
			const socket = String(r.socket ?? '').trim()
			const keyArray = String(r.keyArray ?? '').trim()
			const address = String(r.address ?? '').trim()
			const state = r.state
			if (!ID_RE.test(id)) throw new Error(`labPoolConfig: ${line}: wallet id "${id}" must match ${ID_RE}`)
			if (!socket) throw new Error(`labPoolConfig: wallet ${id}: socket is empty`)
			if (!keyArray) throw new Error(`labPoolConfig: wallet ${id}: keyArray is empty`)
			if (!ADDR_RE.test(address)) throw new Error(`labPoolConfig: wallet ${id}: address is not a 0x address`)
			if (state !== 'active' && state !== 'draining') throw new Error(`labPoolConfig: wallet ${id}: state must be "active" or "draining"`)
			const addrLower = address.toLowerCase()
			if (seen.id.has(id)) throw new Error(`labPoolConfig: duplicate wallet id ${id}`)
			if (seen.address.has(addrLower)) throw new Error(`labPoolConfig: wallet ${id}: address already used by another wallet`)
			if (seen.keyArray.has(keyArray)) throw new Error(`labPoolConfig: wallet ${id}: keyArray already used by another wallet`)
			if (seen.socket.has(socket)) throw new Error(`labPoolConfig: wallet ${id}: socket already used by another wallet`)
			seen.id.add(id)
			seen.address.add(addrLower)
			seen.keyArray.add(keyArray)
			seen.socket.add(socket)
			if (state === 'active') active++
			wallets.push({ id, line, socket, keyArray, address, state })
		}
		if (active < minActive) throw new Error(`labPoolConfig: "${line}" has ${active} active wallet(s), at least ${minActive} required`)
	}
	return { wallets, sha256: createHash('sha256').update(text).digest('hex') }
}

export function loadPoolConfig(file: string, opts: { minActive?: number } = {}): PoolConfig {
	return parsePoolConfig(fs.readFileSync(file, 'utf8'), opts)
}
