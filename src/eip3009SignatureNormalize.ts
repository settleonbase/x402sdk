/**
 * Normalize wallet EIP-3009 / ECDSA signatures for Coinbase / WalletLink quirks:
 * - object wrappers ({ result }, { signature }, { r,s,v })
 * - missing 0x
 * - EIP-2098 compact (64 bytes)
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

export function normalizeEip3009WalletSignature(raw: unknown): string | null {
	let candidate: unknown = raw
	if (candidate && typeof candidate === 'object') {
		const obj = candidate as Record<string, unknown>
		if (typeof obj.result === 'string') candidate = obj.result
		else if (typeof obj.signature === 'string') candidate = obj.signature
		else if (typeof obj.data === 'string') candidate = obj.data
		else if (Array.isArray(candidate) && typeof candidate[0] === 'string') candidate = candidate[0]
		else if (
			typeof obj.r === 'string' &&
			typeof obj.s === 'string' &&
			(obj.v !== undefined || obj.yParity !== undefined)
		) {
			const vr = padHex64(obj.r)
			const vs = padHex64(obj.s)
			if (!vr || !vs) return null
			let vv = Number(obj.v !== undefined ? obj.v : Number(obj.yParity) + 27)
			if (vv === 0 || vv === 1) vv += 27
			candidate = `0x${vr}${vs}${vv === 28 ? '1c' : '1b'}`
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
		rHex = body.slice(0, 64)
		const yParityAndS = BigInt(`0x${body.slice(64, 128)}`)
		const yParity = Number((yParityAndS >> 255n) & 1n)
		sBig = yParityAndS & ((1n << 255n) - 1n)
		vNum = 27 + yParity
	} else if (body.length === 130) {
		rHex = body.slice(0, 64)
		sBig = BigInt(`0x${body.slice(64, 128)}`)
		vNum = parseInt(body.slice(128, 130), 16)
		if (vNum === 0 || vNum === 1) vNum += 27
	} else {
		return null
	}
	if (vNum !== 27 && vNum !== 28) return null
	if (sBig <= 0n || sBig >= SECP256K1_N) return null
	if (sBig > SECP256K1_HALF_N) {
		sBig = SECP256K1_N - sBig
		vNum = vNum === 27 ? 28 : 27
	}
	const sHex = padHex64(sBig.toString(16))
	if (!sHex) return null
	return `0x${rHex.toLowerCase()}${sHex}${vNum === 28 ? '1c' : '1b'}`
}
