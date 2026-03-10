import { createCipheriv, createDecipheriv } from 'node:crypto'
import type express from 'express'
import { masterSetup } from './util'
import { getBeamioSunLastCounterByUid, upsertBeamioSunLastCounterByUid } from './db'

export interface BeamioSunCounterState {
	uidHex: string
	lastCounterHex: string | null
}

export interface VerifyBeamioSunResult {
	url: string
	uidHex: string
	counterHex: string
	counterValue: number
	tagIdHex: string
	version: number
	eHex: string
	cHex: string
	mHex: string | null
	expectedMacHex: string
	macInputAscii: string
	macLayout: 'uid_c_e_m' | 'e_c_m_uid_suffix'
	payloadLayout: 'uidCtrTagId' | 'tagIdOnly'
	macValid: boolean
	tagIdMatchesExpected: boolean
	counterFresh: boolean
	embeddedUidMatchesInput: boolean
	embeddedCounterMatchesInput: boolean
	valid: boolean
	counterState?: BeamioSunCounterState | null
}

const hexToBytes = (hex: string): Buffer => Buffer.from(hex, 'hex')
const bytesToHex = (data: Uint8Array): string => Buffer.from(data).toString('hex').toUpperCase()
const ENC_SV_PREFIX = hexToBytes('C33C00010080')
const MAC_SV_PREFIX = hexToBytes('3CC300010080')

const normalizeHex = (value: string, expectedLength?: number): string => {
	const hex = value.trim().replace(/\s+/g, '').toUpperCase()
	if (!hex || hex.length % 2 !== 0 || /[^0-9A-F]/.test(hex)) {
		throw new Error(`Invalid hex string: ${value}`)
	}
	if (expectedLength != null && hex.length !== expectedLength) {
		throw new Error(`Expected hex length ${expectedLength}, got ${hex.length}: ${value}`)
	}
	return hex
}

export const getQueryParam = (url: string, key: string): string | null => {
	const marker = `${key}=`
	const idx = url.indexOf(marker)
	if (idx < 0) return null
	const start = idx + marker.length
	const end = url.indexOf('&', start)
	return url.substring(start, end < 0 ? url.length : end)
}

const getBeamioSunConfig = () => {
	const cfg = (masterSetup as IMasterSetup & {
		beamio_nfc?: {
			key0Hex?: string
			key2Hex?: string
		}
	}).beamio_nfc
	if (!cfg?.key2Hex) {
		throw new Error('masterSetup.beamio_nfc.key2Hex is required')
	}
	return cfg
}

const aesEcbEncrypt = (key: Buffer, block16: Buffer): Buffer => {
	const cipher = createCipheriv('aes-128-ecb', key, null)
	cipher.setAutoPadding(false)
	return Buffer.concat([cipher.update(block16), cipher.final()])
}

const aesCbcDecryptNoPadding = (ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer => {
	const cipher = createDecipheriv('aes-128-cbc', key, iv)
	cipher.setAutoPadding(false)
	return Buffer.concat([cipher.update(ciphertext), cipher.final()])
}

const leftShiftOneBit = (input: Buffer): Buffer => {
	const out = Buffer.alloc(16, 0)
	let carry = 0
	for (let i = 15; i >= 0; i -= 1) {
		const b = input[i]
		out[i] = ((b << 1) & 0xFF) | carry
		carry = (b & 0x80) !== 0 ? 1 : 0
	}
	return out
}

const xorInto = (out: Buffer, a: Buffer, b: Buffer) => {
	for (let i = 0; i < 16; i += 1) out[i] = a[i] ^ b[i]
}

const xor16 = (a: Buffer, b: Buffer): Buffer => {
	const out = Buffer.alloc(16, 0)
	xorInto(out, a, b)
	return out
}

const cmacSubkeys = (l: Buffer): [Buffer, Buffer] => {
	const k1 = leftShiftOneBit(l)
	if ((l[0] & 0x80) !== 0) k1[15] ^= 0x87
	const k2 = leftShiftOneBit(k1)
	if ((k1[0] & 0x80) !== 0) k2[15] ^= 0x87
	return [Buffer.from(k1), Buffer.from(k2)]
}

const aesCmac = (key: Buffer, message: Buffer): Buffer => {
	const zero = Buffer.alloc(16, 0)
	const l = aesEcbEncrypt(key, zero)
	const [k1, k2] = cmacSubkeys(l)
	const blockCount = message.length === 0 ? 1 : Math.ceil(message.length / 16)
	const lastComplete = message.length > 0 && message.length % 16 === 0
	const mLast = Buffer.alloc(16, 0)

	if (lastComplete) {
		const last = message.subarray((blockCount - 1) * 16, blockCount * 16)
		xorInto(mLast, Buffer.from(last), k1)
	} else {
		const start = (blockCount - 1) * 16
		const last = Buffer.alloc(16, 0)
		const remain = start < message.length ? message.subarray(start) : Buffer.alloc(0)
		Buffer.from(remain).copy(last, 0)
		last[remain.length] = 0x80
		xorInto(mLast, last, k2)
	}

	let x: any = Buffer.alloc(16, 0)
	for (let i = 0; i < blockCount - 1; i += 1) {
		const block = Buffer.from(message.subarray(i * 16, (i + 1) * 16))
		x = aesEcbEncrypt(key, xor16(x, block))
	}
	return aesEcbEncrypt(key, xor16(x, mLast))
}

const truncateMac16To8 = (full: Buffer): Buffer => Buffer.from([
	full[1], full[3], full[5], full[7],
	full[9], full[11], full[13], full[15]
])

const deriveSdmEncIv = (sessionEncKey: Buffer, ctrLsb: Buffer): Buffer => {
	const ivInput = Buffer.alloc(16, 0)
	ctrLsb.copy(ivInput, 0)
	return aesEcbEncrypt(sessionEncKey, ivInput)
}

const decodePlainPayload = (plain: Buffer, uidHex: string, cHex: string) => {
	const embeddedUidHex = bytesToHex(plain.subarray(0, 7))
	const embeddedCounterMsbHex = bytesToHex(Buffer.from(plain.subarray(7, 10)).reverse())
	if (embeddedUidHex === uidHex && embeddedCounterMsbHex === cHex) {
		return {
			payloadLayout: 'uidCtrTagId' as const,
			tagIdHex: bytesToHex(plain.subarray(10, 18)),
			version: plain[18],
			embeddedUidMatchesInput: true,
			embeddedCounterMatchesInput: true
		}
	}
	return {
		payloadLayout: 'tagIdOnly' as const,
		tagIdHex: bytesToHex(plain.subarray(0, 8)),
		version: plain[8],
		embeddedUidMatchesInput: false,
		embeddedCounterMatchesInput: false
	}
}

const deriveMacInputAscii = (url: string, uidHex: string, cHex: string, eHex: string): {
	macInputAscii: string
	macLayout: 'uid_c_e_m' | 'e_c_m_uid_suffix'
} => {
	const uidPos = url.indexOf('uid=')
	const cPos = url.indexOf('c=')
	const ePos = url.indexOf('e=')
	const mPos = url.indexOf('m=')

	if (uidPos >= 0 && cPos > uidPos && ePos > cPos && mPos > ePos) {
		return {
			macInputAscii: `${uidHex}&c=${cHex}&e=${eHex}&m=`,
			macLayout: 'uid_c_e_m'
		}
	}

	return {
		macInputAscii: `${eHex}&c=${cHex}&m=`,
		macLayout: 'e_c_m_uid_suffix'
	}
}

export const verifyBeamioSunUrl = async (url: string): Promise<VerifyBeamioSunResult> => {
	const cfg = getBeamioSunConfig()
	const uidHex = normalizeHex(getQueryParam(url, 'uid') ?? '', 14)
	const eHex = normalizeHex(getQueryParam(url, 'e') ?? '', 64)
	const cHex = normalizeHex(getQueryParam(url, 'c') ?? '', 6)
	const mHexRaw = getQueryParam(url, 'm')
	const mHex = mHexRaw ? normalizeHex(mHexRaw, 16) : null

	const lastCounterHex = await getBeamioSunLastCounterByUid(uidHex)
	const counterState: BeamioSunCounterState = {
		uidHex,
		lastCounterHex
	}
	const uid = hexToBytes(uidHex)
	const counterMsb = hexToBytes(cHex)
	const counterLsb = Buffer.from(counterMsb).reverse()
	const key2 = hexToBytes(normalizeHex(cfg.key2Hex, 32))
	const sesEncKey = aesCmac(key2, Buffer.concat([ENC_SV_PREFIX, uid, counterLsb]))
	const sesMacKey = aesCmac(key2, Buffer.concat([MAC_SV_PREFIX, uid, counterLsb]))
	const iv = deriveSdmEncIv(sesEncKey, counterLsb)
	const plain = aesCbcDecryptNoPadding(hexToBytes(eHex), sesEncKey, iv)
	if (plain.length !== 32) {
		throw new Error(`Decrypted SDMENCFileData must be 32 bytes, got ${plain.length}`)
	}

	const payload = decodePlainPayload(plain, uidHex, cHex)
	const { macInputAscii, macLayout } = deriveMacInputAscii(url, uidHex, cHex, eHex)
	const expectedMacHex = bytesToHex(truncateMac16To8(aesCmac(sesMacKey, Buffer.from(macInputAscii, 'ascii'))))
	const counterValue = parseInt(cHex, 16)
	const macValid = mHex != null && expectedMacHex === mHex
	const tagIdMatchesExpected = true
	const counterFresh = !lastCounterHex || counterValue > parseInt(lastCounterHex, 16)

	return {
		url,
		uidHex,
		counterHex: cHex,
		counterValue,
		tagIdHex: payload.tagIdHex,
		version: payload.version,
		eHex,
		cHex,
		mHex,
		expectedMacHex,
		macInputAscii,
		macLayout,
		payloadLayout: payload.payloadLayout,
		macValid,
		tagIdMatchesExpected,
		counterFresh,
		embeddedUidMatchesInput: payload.embeddedUidMatchesInput,
		embeddedCounterMatchesInput: payload.embeddedCounterMatchesInput,
		valid: macValid && tagIdMatchesExpected && counterFresh && (
			payload.payloadLayout === 'tagIdOnly' || (payload.embeddedUidMatchesInput && payload.embeddedCounterMatchesInput)
		),
		counterState
	}
}

export const verifyBeamioSunRequest = async (req: express.Request, res: express.Response) => {
	try {
		const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
		const result = await verifyBeamioSunUrl(url)
		if (result.valid) {
			await upsertBeamioSunLastCounterByUid({
				uid: result.uidHex,
				lastCounterHex: result.counterHex
			})
		}
		return res.status(result.valid ? 200 : 403).json(result).end()
	} catch (e: any) {
		return res.status(403).json({
			success: false,
			error: e?.message ?? String(e)
		}).end()
	}
}
