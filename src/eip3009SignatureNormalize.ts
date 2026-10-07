/**
 * Normalize wallet EIP-3009 / ECDSA signatures for Coinbase / WalletLink quirks:
 * - object wrappers ({ result }, { signature }, { r,s,v })
 * - Uint8Array / Buffer-like byte arrays
 * - missing 0x
 * - EIP-2098 compact (64 bytes)
 * - EIP-155 v with chainId (Base → 132+ hex: r||s||0x422d / 0x422e)
 * - high-s (ethers v6 verifyTypedData throws "non-canonical s")
 *
 * Returns 0x + 130 hex (r||s||v) with low-s and v ∈ {27,28}, or null.
 */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SECP256K1_HALF_N = SECP256K1_N / 2n

function padHex64(hexNo0x: string): string | null {
	let h = hexNo0x.replace(/^0x/i, '').toLowerCase()
	if (!/^[0-9a-f]+$/.test(h) || h.length > 64) return null
	while (h.length < 64) h = '0' + h
	return h
}

function bytesToHex(bytes: ArrayLike<number>): string {
	let out = '0x'
	for (let i = 0; i < bytes.length; i++) {
		out += (bytes[i]! & 0xff).toString(16).padStart(2, '0')
	}
	return out
}

/** Map wallet v (0/1, 27/28, or EIP-155) → 27 | 28. */
function recoverV27(vNum: number): number | null {
	if (!Number.isFinite(vNum) || vNum < 0) return null
	const n = Math.trunc(vNum)
	if (n === 0 || n === 1) return 27 + n
	if (n === 27 || n === 28) return n
	if (n >= 35) {
		/* EIP-155: v = chainId * 2 + 35 + yParity */
		return 27 + ((n - 35) % 2)
	}
	return null
}

export function normalizeEip3009WalletSignature(raw: unknown): string | null {
	let candidate: unknown = raw

	if (candidate instanceof Uint8Array) {
		candidate = bytesToHex(candidate)
	} else if (ArrayBuffer.isView(candidate) && (candidate as ArrayBufferView).byteLength > 0) {
		const view = candidate as ArrayBufferView
		candidate = bytesToHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
	} else if (candidate instanceof ArrayBuffer) {
		candidate = bytesToHex(new Uint8Array(candidate))
	}

	if (candidate && typeof candidate === 'object') {
		const obj = candidate as Record<string, unknown>
		if (typeof obj.result === 'string') candidate = obj.result
		else if (typeof obj.signature === 'string') candidate = obj.signature
		else if (typeof obj.data === 'string') candidate = obj.data
		else if (
			obj.type === 'Buffer' &&
			Array.isArray(obj.data) &&
			obj.data.every((x) => typeof x === 'number')
		) {
			candidate = bytesToHex(obj.data as number[])
		} else if (Array.isArray(candidate) && typeof candidate[0] === 'string') {
			candidate = candidate[0]
		} else if (
			Array.isArray(candidate) &&
			candidate.length >= 65 &&
			candidate.every((x) => typeof x === 'number')
		) {
			candidate = bytesToHex(candidate as number[])
		} else if (
			typeof obj.r === 'string' &&
			typeof obj.s === 'string' &&
			(obj.v !== undefined || obj.yParity !== undefined)
		) {
			const vr = padHex64(obj.r)
			const vs = padHex64(obj.s)
			if (!vr || !vs) return null
			let vv = Number(obj.v !== undefined ? obj.v : Number(obj.yParity) + 27)
			const recovered = recoverV27(vv)
			if (recovered == null) return null
			candidate = `0x${vr}${vs}${recovered === 28 ? '1c' : '1b'}`
		} else {
			return null
		}
	}

	if (typeof candidate !== 'string') return null
	let hex = candidate.trim()
	if (!hex) return null
	if (!hex.startsWith('0x') && !hex.startsWith('0X')) hex = `0x${hex}`
	if (!/^0x[0-9a-fA-F]+$/.test(hex)) return null
	const body = hex.slice(2)

	let rHex: string
	let sBig: bigint
	let vNum: number

	if (body.length === 128) {
		/* EIP-2098 compact: r || yParityAndS */
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
		/*
		 * Coinbase / some WalletLink builds return EIP-155 v (Base chainId → 2+ hex digits),
		 * so the total body is 132+ hex. Leading zeros in r are normal — not an empty sig.
		 */
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
	/* Reject all-zero r (not a valid secp256k1 signature component). */
	if (BigInt(`0x${rHex}`) === 0n) return null

	if (sBig > SECP256K1_HALF_N) {
		sBig = SECP256K1_N - sBig
		vNum = vNum === 27 ? 28 : 27
	}
	const sHex = padHex64(sBig.toString(16))
	if (!sHex) return null
	return `0x${rHex.toLowerCase()}${sHex}${vNum === 28 ? '1c' : '1b'}`
}
