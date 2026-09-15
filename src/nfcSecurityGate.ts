import { ethers } from 'ethers'
import { getNfcRecipientAddressByTagId, getNfcCardPosAdminGateByTagId } from './db'
import { verifyAndPersistBeamioSunUrl, type VerifyBeamioSunResult } from './BeamioSun'

export type NfcSunInput = {
	uid?: unknown
	e?: unknown
	c?: unknown
	m?: unknown
}

export type NfcSecurityGateOptions = {
	/**
	 * NFC provisioning is allowed only for read/provision entry points.
	 * Mutation paths must leave this false so an unlinked tag cannot continue.
	 */
	allowUnlinked?: boolean
	requirePosAdmin?: boolean
	expectedLinkedEoa?: string
}

type NfcPosAdminGateResult = { ok: true } | { ok: false; code?: string; message?: string }

export type NfcSecurityGateResult =
	| {
			ok: true
			uidHex: string
			tagIdHex: string
			linkedEOA: string | null
			sun: VerifyBeamioSunResult
			posAdminGate?: NfcPosAdminGateResult
	  }
	| {
			ok: false
			statusCode: 400 | 403
			error: string
			errorCode?: string
			macValid?: boolean
			counterFresh?: boolean
	  }

const NFC_UID_RE = /^[0-9A-Fa-f]{14}$/
const NFC_E_RE = /^[0-9A-Fa-f]{64}$/
const NFC_C_RE = /^[0-9A-Fa-f]{6}$/
const NFC_M_RE = /^[0-9A-Fa-f]{16}$/

function readNfcFields(input: NfcSunInput): {
	uid: string
	e: string
	c: string
	m: string
} | NfcSecurityGateResult {
	const uid = typeof input.uid === 'string' ? input.uid.trim() : ''
	const e = typeof input.e === 'string' ? input.e.trim() : ''
	const c = typeof input.c === 'string' ? input.c.trim() : ''
	const m = typeof input.m === 'string' ? input.m.trim() : ''
	if (!NFC_UID_RE.test(uid)) {
		return { ok: false, statusCode: 400, error: 'Invalid NFC UID (expected 14 hexadecimal characters)' }
	}
	if (!NFC_E_RE.test(e) || !NFC_C_RE.test(c) || !NFC_M_RE.test(m)) {
		return {
			ok: false,
			statusCode: 403,
			error: 'NFC UID requires SUN params (e=64 hex, c=6 hex, m=16 hex) for verification.',
		}
	}
	return { uid, e, c, m }
}

/**
 * Canonical NFC authorization gate for every mutation flow.
 *
 * The caller must await this before reading balances, accepting a signature,
 * settling USDC, or enqueueing a Master write. It deliberately does not
 * return a private key or any signing material.
 */
export async function verifyNfcSecurityGate(
	input: NfcSunInput,
	options: NfcSecurityGateOptions = {},
): Promise<NfcSecurityGateResult> {
	const fields = readNfcFields(input)
	if ('ok' in fields && !fields.ok) return fields

	const { uid, e, c, m } = fields as { uid: string; e: string; c: string; m: string }
	try {
		const sun = await verifyAndPersistBeamioSunUrl(
			`https://beamio.app/api/sun?uid=${uid}&c=${c}&e=${e}&m=${m}`,
		)
		if (!sun.valid) {
			return {
				ok: false,
				statusCode: 403,
				error: 'SUN verification failed',
				macValid: sun.macValid,
				counterFresh: sun.counterFresh,
			}
		}

		const linkedRaw = await getNfcRecipientAddressByTagId(sun.tagIdHex)
		const linkedEOA =
			linkedRaw && ethers.isAddress(linkedRaw) ? ethers.getAddress(linkedRaw) : null
		if (!linkedEOA && !options.allowUnlinked) {
			return {
				ok: false,
				statusCode: 403,
				error: 'NFC card is not linked to a wallet',
				errorCode: 'NFC_LINKED_EOA_REQUIRED',
			}
		}
		if (
			linkedEOA &&
			options.expectedLinkedEoa &&
			(!ethers.isAddress(options.expectedLinkedEoa) ||
				linkedEOA.toLowerCase() !== ethers.getAddress(options.expectedLinkedEoa).toLowerCase())
		) {
			return {
				ok: false,
				statusCode: 403,
				error: 'NFC linked wallet does not match the requested wallet',
				errorCode: 'NFC_LINKED_EOA_MISMATCH',
			}
		}

		if (options.requirePosAdmin) {
			const gate = await getNfcCardPosAdminGateByTagId(sun.tagIdHex)
			if (!gate.ok) {
				return {
					ok: false,
					statusCode: 403,
					error: gate.message,
					errorCode: gate.code,
				}
			}
		}

		return {
			ok: true,
			uidHex: uid,
			tagIdHex: sun.tagIdHex,
			linkedEOA,
			sun,
			...(options.requirePosAdmin ? { posAdminGate: { ok: true as const } } : {}),
		}
	} catch (error) {
		return {
			ok: false,
			statusCode: 403,
			error: `NFC security verification error: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}
