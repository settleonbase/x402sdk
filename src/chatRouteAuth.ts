/**
 * `POST /api/regiestChatRoute` caller authentication.
 *
 * The master writes the record with an operator wallet (`addPublicPGPByAdmin`),
 * so the request itself must prove that the owner of `wallet` asked for it.
 * The client signs the message below with the wallet key (EIP-191
 * personal_sign). Cluster precheck and master both verify it; the master also
 * rejects a nonce it has already accepted.
 *
 * Signed message (lines joined with "\n"):
 *   Beamio regiestChatRoute
 *   wallet:<lowercase address>
 *   keyID:<keyID>
 *   publicKeyArmoredHash:<keccak256(utf8(publicKeyArmored))>
 *   encrypKeyArmoredHash:<keccak256(utf8(encrypKeyArmored))>
 *   routeKeyID:<routeKeyID>
 *   timestamp:<unix ms>
 *   nonce:<0x + 32 hex>
 *
 * All string fields are trimmed before hashing and before writing on chain.
 */
import { ethers } from 'ethers'

export const CHAT_ROUTE_SIGN_MAX_SKEW_MS = 10 * 60 * 1000

export type RegiestChatRoutePayload = {
	wallet: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
	timestamp: number
	nonce: string
	signature: string
}

export type RegiestChatRouteCheck =
	| { ok: true; payload: RegiestChatRoutePayload }
	| { ok: false; status: number; error: string }

const NONCE_RE = /^0x[0-9a-fA-F]{32}$/
const MAX_FIELD_LEN = 64 * 1024

export function buildRegiestChatRouteMessage(p: {
	wallet: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
	timestamp: number
	nonce: string
}): string {
	return [
		'Beamio regiestChatRoute',
		`wallet:${p.wallet.toLowerCase()}`,
		`keyID:${p.keyID}`,
		`publicKeyArmoredHash:${ethers.keccak256(ethers.toUtf8Bytes(p.publicKeyArmored))}`,
		`encrypKeyArmoredHash:${ethers.keccak256(ethers.toUtf8Bytes(p.encrypKeyArmored))}`,
		`routeKeyID:${p.routeKeyID}`,
		`timestamp:${p.timestamp}`,
		`nonce:${p.nonce.toLowerCase()}`,
	].join('\n')
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Format + timestamp + signature check. Same code runs on cluster and master. */
export function regiestChatRoutePreCheck(body: any, now: number = Date.now()): RegiestChatRouteCheck {
	const walletRaw = str(body?.wallet)
	if (!ethers.isAddress(walletRaw) || walletRaw.toLowerCase() === ethers.ZeroAddress) {
		return { ok: false, status: 400, error: 'Invalid wallet' }
	}
	const wallet = walletRaw.toLowerCase()
	const keyID = str(body?.keyID)
	const publicKeyArmored = str(body?.publicKeyArmored)
	const encrypKeyArmored = str(body?.encrypKeyArmored)
	const routeKeyID = str(body?.routeKeyID)
	if (!keyID) return { ok: false, status: 400, error: 'Missing or invalid keyID' }
	if (!publicKeyArmored) return { ok: false, status: 400, error: 'Missing or invalid publicKeyArmored' }
	if (!encrypKeyArmored) return { ok: false, status: 400, error: 'Missing or invalid encrypKeyArmored' }
	if (!routeKeyID) return { ok: false, status: 400, error: 'Missing or invalid routeKeyID' }
	for (const f of [keyID, publicKeyArmored, encrypKeyArmored, routeKeyID]) {
		if (f.length > MAX_FIELD_LEN) return { ok: false, status: 400, error: 'Field too long' }
	}
	if (/[\r\n]/.test(keyID) || /[\r\n]/.test(routeKeyID)) {
		return { ok: false, status: 400, error: 'Invalid keyID or routeKeyID' }
	}

	const signature = str(body?.signature)
	if (!signature) return { ok: false, status: 401, error: 'Missing signature' }
	const nonce = str(body?.nonce)
	if (!NONCE_RE.test(nonce)) return { ok: false, status: 400, error: 'Invalid nonce' }
	const ts = typeof body?.timestamp === 'number' ? body.timestamp : Number(body?.timestamp)
	if (!Number.isSafeInteger(ts) || ts < 1e12) {
		return { ok: false, status: 400, error: 'Invalid timestamp (unix ms)' }
	}
	if (Math.abs(now - ts) > CHAT_ROUTE_SIGN_MAX_SKEW_MS) {
		return { ok: false, status: 401, error: 'Expired timestamp' }
	}

	const message = buildRegiestChatRouteMessage({
		wallet,
		keyID,
		publicKeyArmored,
		encrypKeyArmored,
		routeKeyID,
		timestamp: ts,
		nonce,
	})
	let recovered = ''
	try {
		recovered = ethers.verifyMessage(message, signature).toLowerCase()
	} catch {
		return { ok: false, status: 401, error: 'Invalid signature' }
	}
	if (recovered !== wallet) {
		return { ok: false, status: 403, error: 'Signature does not match wallet' }
	}
	return {
		ok: true,
		payload: {
			wallet,
			keyID,
			publicKeyArmored,
			encrypKeyArmored,
			routeKeyID,
			timestamp: ts,
			nonce: nonce.toLowerCase(),
			signature,
		},
	}
}

/**
 * Accepted nonces, kept for the timestamp window. Anything older than the
 * window is already rejected by the timestamp check, so the set stays small.
 * In memory only: a master restart clears it, which reopens at most the last
 * 10 minutes of the owner's own signed requests.
 */
export class ChatRouteReplayGuard {
	private seen = new Map<string, number>()
	private readonly windowMs: number
	constructor(windowMs: number = CHAT_ROUTE_SIGN_MAX_SKEW_MS) {
		this.windowMs = windowMs
	}

	/** true = first use (now recorded); false = replay. */
	claim(wallet: string, nonce: string, timestamp: number, now: number = Date.now()): boolean {
		this.prune(now)
		const key = `${wallet.toLowerCase()}:${nonce.toLowerCase()}`
		if (this.seen.has(key)) return false
		// Keep until the request can no longer pass the timestamp check.
		this.seen.set(key, Math.max(now, timestamp) + this.windowMs)
		return true
	}

	/** Forget a claimed nonce, e.g. when the chain write was never sent, so the owner can retry. */
	release(wallet: string, nonce: string): void {
		this.seen.delete(`${wallet.toLowerCase()}:${nonce.toLowerCase()}`)
	}

	private prune(now: number) {
		for (const [k, exp] of this.seen) {
			if (exp <= now) this.seen.delete(k)
		}
	}

	get size(): number {
		return this.seen.size
	}
}
