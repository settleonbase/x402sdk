/**
 * Normalize wallet EIP-3009 signatures for Base USDC `transferWithAuthorization`.
 * Coinbase Smart Wallet often returns ERC-6492 wraps (≈600+ bytes, leading
 * zero-padded factory address) — unwrap to the inner ECDSA before ecrecover.
 */

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
const SECP256K1_HALF_N = SECP256K1_N / 2n

/** ERC-6492 magic suffix (32 bytes). */
export const ERC6492_MAGIC_SUFFIX =
	'6492649264926492649264926492649264926492649264926492649264926492'

function padHex64(hexNo0x: string): string | null {
	const h = hexNo0x.replace(/^0x/i, '').toLowerCase()
	if (!/^[0-9a-f]+$/.test(h) || h.length > 64) return null
	return h.padStart(64, '0')
}

function recoverV27(vRaw: number): number | null {
	if (!Number.isFinite(vRaw) || vRaw < 0) return null
	if (vRaw === 0 || vRaw === 27) return 27
	if (vRaw === 1 || vRaw === 28) return 28
	/* EIP-155: v = chainId*2 + 35 + yParity → yParity = (v - 35) % 2 */
	if (vRaw >= 35) return (vRaw - 35) % 2 === 0 ? 27 : 28
	return null
}

/** True when hex ends with ERC-6492 magic (Coinbase Smart Wallet wraps). */
export function isErc6492SignatureHex(hex: string): boolean {
	const body = hex.replace(/^0x/i, '').toLowerCase()
	return body.length >= 192 + 64 && body.endsWith(ERC6492_MAGIC_SUFFIX)
}

/**
 * Unwrap `abi.encode(address factory, bytes factoryCalldata, bytes signature) || magic`.
 * Returns inner signature hex, or null if not ERC-6492 / malformed.
 * Coinbase Smart Wallet often uses factory=address(0) + empty calldata (leading 0x0000…).
 */
export function unwrapErc6492Signature(hex: string): string | null {
	const body = hex.replace(/^0x/i, '').toLowerCase()
	if (!isErc6492SignatureHex(`0x${body}`)) return null
	const encoded = body.slice(0, -64)
	if (encoded.length < 192 || encoded.length % 2 !== 0) return null
	const sigOffset = Number.parseInt(encoded.slice(128, 192), 16)
	if (!Number.isFinite(sigOffset) || sigOffset < 96) return null
	const sigOffsetHex = sigOffset * 2
	if (sigOffsetHex + 64 > encoded.length) return null
	const sigLen = Number.parseInt(encoded.slice(sigOffsetHex, sigOffsetHex + 64), 16)
	if (!Number.isFinite(sigLen) || sigLen <= 0 || sigLen > 2048) return null
	const sigStart = sigOffsetHex + 64
	const sigEnd = sigStart + sigLen * 2
	if (sigEnd > encoded.length) return null
	const inner = encoded.slice(sigStart, sigEnd)
	if (inner.length !== sigLen * 2 || !/^[0-9a-f]+$/.test(inner)) return null
	return `0x${inner}`
}

/**
 * ECDSA candidates from an ERC-6492 wrap (standard unwrap + trailing r||s||v before magic).
 * Coinbase sometimes nests a 65-byte ECDSA inside a longer inner blob.
 */
export function ecdsaCandidatesFromErc6492(hex: string): string[] {
	const body = hex.replace(/^0x/i, '').toLowerCase()
	if (!body.endsWith(ERC6492_MAGIC_SUFFIX) || body.length < 192 + 64) return []
	const out: string[] = []
	const seen = new Set<string>()
	const push = (c: string | null) => {
		if (!c) return
		const n = c.toLowerCase()
		if (seen.has(n)) return
		seen.add(n)
		out.push(c.startsWith('0x') ? c : `0x${c}`)
	}
	push(unwrapErc6492Signature(hex))
	const encoded = body.slice(0, -64)
	if (encoded.length >= 130) {
		push(`0x${encoded.slice(-130)}`)
		push(`0x${encoded.slice(-128)}`)
	}
	const inner = unwrapErc6492Signature(hex)
	if (inner) {
		const ib = inner.replace(/^0x/i, '')
		if (ib.length > 130) {
			push(`0x${ib.slice(-130)}`)
			push(`0x${ib.slice(-128)}`)
		}
	}
	return out
}

function normalizePlainEcdsaBody(hex: string): string | null {
	let candidate = hex.trim()
	if (!candidate) return null
	if (!candidate.startsWith('0x') && !candidate.startsWith('0X')) candidate = `0x${candidate}`
	if (!/^0x[0-9a-fA-F]+$/.test(candidate)) return null
	const body = candidate.slice(2)
	let rHex: string
	let sBig: bigint
	let vNum: number
	if (body.length === 128) {
		rHex = body.slice(0, 64)
		const yParityAndS = BigInt(`0x${body.slice(64, 128)}`)
		const yParity = Number((yParityAndS >> 255n) & 1n)
		sBig = yParityAndS & ((1n << 255n) - 1n)
		vNum = 27 + yParity
	} else if (body.length === 130) {
		rHex = body.slice(0, 64)
		sBig = BigInt(`0x${body.slice(64, 128)}`)
		vNum = parseInt(body.slice(128, 130), 16)
	} else if (body.length >= 132 && body.length <= 194 && body.length % 2 === 0) {
		rHex = body.slice(0, 64)
		sBig = BigInt(`0x${body.slice(64, 128)}`)
		vNum = parseInt(body.slice(128), 16)
	} else {
		return null
	}
	const v27 = recoverV27(vNum)
	if (v27 == null) return null
	vNum = v27
	if (sBig <= 0n || sBig >= SECP256K1_N) return null
	if (BigInt(`0x${rHex}`) === 0n) return null
	if (sBig > SECP256K1_HALF_N) {
		sBig = SECP256K1_N - sBig
		vNum = vNum === 27 ? 28 : 27
	}
	const sHex = padHex64(sBig.toString(16))
	if (!sHex) return null
	return `0x${rHex.toLowerCase()}${sHex}${vNum === 28 ? '1c' : '1b'}`
}

function normalizeEcdsaBody(hex: string): string | null {
	let candidate = hex.trim()
	if (!candidate) return null
	if (!candidate.startsWith('0x') && !candidate.startsWith('0X')) candidate = `0x${candidate}`
	if (!/^0x[0-9a-fA-F]+$/.test(candidate)) return null
	/* Peel ERC-6492 (Coinbase Smart Wallet ≈1218 hex, often leading 0x0000…). */
	if (isErc6492SignatureHex(candidate)) {
		for (const c of ecdsaCandidatesFromErc6492(candidate)) {
			const n = normalizePlainEcdsaBody(c)
			if (n) return n
		}
		return null
	}
	return normalizePlainEcdsaBody(candidate)
}

/**
 * Accept hex string, {r,s,v}, or {signature}. Return canonical 65-byte hex
 * `0x` + r(32) + s(32) + v(1b|1c), or null.
 */
export function normalizeEip3009WalletSignature(raw: unknown): string | null {
	if (raw == null) return null
	let candidate: unknown = raw
	if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
		const o = candidate as Record<string, unknown>
		if (typeof o.signature === 'string') candidate = o.signature
		else if (typeof o.r === 'string' && typeof o.s === 'string') {
			const r = padHex64(o.r)
			const s = padHex64(o.s)
			if (!r || !s) return null
			let vNum: number
			if (typeof o.v === 'number') vNum = o.v
			else if (typeof o.v === 'string') vNum = parseInt(o.v.replace(/^0x/i, ''), 16)
			else if (typeof o.yParity === 'number') vNum = 27 + (o.yParity & 1)
			else if (typeof o.yParity === 'string') vNum = 27 + (parseInt(o.yParity, 10) & 1)
			else return null
			const v27 = recoverV27(vNum)
			if (v27 == null) return null
			let sBig = BigInt(`0x${s}`)
			if (sBig <= 0n || sBig >= SECP256K1_N) return null
			if (BigInt(`0x${r}`) === 0n) return null
			let vOut = v27
			if (sBig > SECP256K1_HALF_N) {
				sBig = SECP256K1_N - sBig
				vOut = vOut === 27 ? 28 : 27
			}
			const sNorm = padHex64(sBig.toString(16))
			if (!sNorm) return null
			return `0x${r}${sNorm}${vOut === 28 ? '1c' : '1b'}`
		} else return null
	}
	if (typeof candidate !== 'string') return null
	return normalizeEcdsaBody(candidate)
}

/** User-facing hint when wallet returned ERC-6492 / contract sig USDC cannot verify. */
export const EIP3009_SMART_WALLET_SIG_HINT =
	'This wallet returned a Smart Wallet signature. Gasless USDC receive needs an EOA. Open Coinbase → switch to your private key wallet, or send USDC directly to your Beamio address.'
