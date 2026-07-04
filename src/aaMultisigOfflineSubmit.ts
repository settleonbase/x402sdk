/**
 * AA Smart Wallet multisig offline sign/reject API — Cluster precheck (0.1 B-Unit + inner validation).
 */
import { ethers } from 'ethers'
import { BEAMIO_AA_FACTORY, CONET_BUNIT_AIRDROP_ADDRESS } from './chainAddresses'
import { resolveBeamioConetHttpRpcUrl } from './util'

export const BEAMIO_AA_MULTISIG_TYPE = 'beamio_aa_multisig_v1' as const

/** 与 Discover 社交互动一致：每笔 0.1 B-Unit。 */
export const AA_MULTISIG_OFFLINE_SUBMIT_BUNIT_UNITS6 = 100_000n

const JSONRPC_NO_BATCH = { batchMaxCount: 1, batchStallTime: 0 } as const
const providerConet = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), undefined, JSONRPC_NO_BATCH)

const AA_FACTORY_READ_ABI = ['function beamioAccountOf(address) view returns (address)']

async function pickOfflineSubmitBunitConsumer(
	submitterEoa: string,
	aaAccount: string
): Promise<{ ok: true; consumer: string } | { ok: false; error: string }> {
	const feeBUnits6 = AA_MULTISIG_OFFLINE_SUBMIT_BUNIT_UNITS6
	const eoaN = ethers.getAddress(submitterEoa)
	const bunitAirdropRead = new ethers.Contract(
		CONET_BUNIT_AIRDROP_ADDRESS,
		['function getBUnitBalance(address) view returns (uint256)'],
		providerConet
	)
	const balEoa = (await bunitAirdropRead.getBUnitBalance(eoaN)) as bigint
	if (balEoa >= feeBUnits6) {
		return { ok: true, consumer: eoaN }
	}
	const tryAa = async (aaRaw: string): Promise<{ ok: true; consumer: string } | null> => {
		if (!aaRaw || !ethers.isAddress(aaRaw)) return null
		const aaN = ethers.getAddress(aaRaw)
		if (aaN.toLowerCase() === eoaN.toLowerCase()) return null
		const balAa = (await bunitAirdropRead.getBUnitBalance(aaN)) as bigint
		if (balAa >= feeBUnits6) return { ok: true, consumer: aaN }
		return null
	}
	if (ethers.isAddress(aaAccount)) {
		const hit = await tryAa(aaAccount)
		if (hit) return hit
	}
	try {
		const factory = new ethers.Contract(BEAMIO_AA_FACTORY, AA_FACTORY_READ_ABI, providerConet)
		const linkedAa = (await factory.beamioAccountOf(eoaN)) as string
		if (linkedAa && ethers.isAddress(linkedAa) && linkedAa !== ethers.ZeroAddress) {
			const hit = await tryAa(linkedAa)
			if (hit) return hit
		}
	} catch {
		/* ignore factory read failure */
	}
	return {
		ok: false,
		error: `Insufficient B-Units: need ${Number(feeBUnits6) / 1e6} B-Units (EOA balance ${Number(balEoa) / 1e6})`,
	}
}

export async function aaMultisigOfflineSubmitBunitPreCheck(
	submitterEoa: string,
	aaAccount: string
): Promise<{ success: true; feePayer: string; feeAmount: bigint } | { success: false; error: string }> {
	const picked = await pickOfflineSubmitBunitConsumer(submitterEoa, aaAccount)
	if (!picked.ok) return { success: false, error: picked.error }
	return { success: true, feePayer: picked.consumer, feeAmount: AA_MULTISIG_OFFLINE_SUBMIT_BUNIT_UNITS6 }
}

export type AaMultisigOfflineSubmitAction = 'sign' | 'reject'

export type AaMultisigOfflineSubmitInner = {
	type: typeof BEAMIO_AA_MULTISIG_TYPE
	action: AaMultisigOfflineSubmitAction
	taskId: string
	aaAccount: string
	sendId: string
	createdAt: number
	signerEoa: string
	userOpHash?: string
	signature?: string
	reason?: string
}

export type AaMultisigOfflineSubmitForwardBody = {
	inner: AaMultisigOfflineSubmitInner
	submitterEoa: string
	feePayer: string
	feeAmount: string
	dedupeKey: string
}

const AA_THRESHOLD_MANAGER_ABI = ['function isThresholdManager(address) view returns (bool)']

function verifyUserOpSignature(signerEoa: string, userOpHash: string, signature: string): boolean {
	try {
		const recovered = ethers.verifyMessage(ethers.getBytes(userOpHash), signature)
		return recovered.toLowerCase() === signerEoa.toLowerCase()
	} catch {
		return false
	}
}

function parseInner(raw: unknown): AaMultisigOfflineSubmitInner | null {
	if (!raw || typeof raw !== 'object') return null
	const o = raw as Record<string, unknown>
	if (o.type !== BEAMIO_AA_MULTISIG_TYPE) return null
	if (o.action !== 'sign') return null
	if (typeof o.taskId !== 'string' || !o.taskId.trim()) return null
	if (typeof o.aaAccount !== 'string' || !ethers.isAddress(o.aaAccount)) return null
	if (typeof o.sendId !== 'string' || !o.sendId.trim()) return null
	if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return null
	if (typeof o.signerEoa !== 'string' || !ethers.isAddress(o.signerEoa)) return null
	const inner: AaMultisigOfflineSubmitInner = {
		type: BEAMIO_AA_MULTISIG_TYPE,
		action: o.action,
		taskId: o.taskId.trim(),
		aaAccount: ethers.getAddress(o.aaAccount),
		sendId: o.sendId.trim(),
		createdAt: o.createdAt,
		signerEoa: ethers.getAddress(o.signerEoa),
	}
	if (o.action === 'sign') {
		if (typeof o.userOpHash !== 'string' || !ethers.isHexString(o.userOpHash) || ethers.dataLength(o.userOpHash) !== 32) {
			return null
		}
		if (typeof o.signature !== 'string' || !o.signature.startsWith('0x') || o.signature.length < 132) {
			return null
		}
		inner.userOpHash = o.userOpHash
		inner.signature = o.signature
	}
	return inner
}

export function buildAaMultisigOfflineSubmitDedupeKey(inner: AaMultisigOfflineSubmitInner): string {
	const signer = inner.signerEoa.toLowerCase()
	const hash = (inner.userOpHash ?? '').toLowerCase()
	return `${inner.taskId}:${inner.action}:${signer}:${hash}`
}

async function assertSignerIsThresholdManager(aaAccount: string, signerEoa: string, provider: ethers.Provider): Promise<string | null> {
	try {
		const aa = new ethers.Contract(aaAccount, AA_THRESHOLD_MANAGER_ABI, provider)
		const ok = (await aa.isThresholdManager(signerEoa)) as boolean
		if (!ok) return 'Signer is not a Smart Wallet threshold manager'
		return null
	} catch (e: unknown) {
		const err = e as { message?: string; shortMessage?: string }
		return `Smart Wallet manager check failed: ${err?.shortMessage ?? err?.message ?? String(e)}`
	}
}

/** Cluster：离线签字/拒绝提交 — 校验 inner + submitter B-Unit ≥ 0.1。 */
export async function aaMultisigOfflineSubmitPreCheck(body: {
	inner?: unknown
	submitterEoa?: string
}): Promise<{ success: true; preChecked: AaMultisigOfflineSubmitForwardBody } | { success: false; error: string }> {
	const inner = parseInner(body.inner)
	if (!inner) {
		return { success: false, error: 'Invalid multisig sign packet (expected beamio_aa_multisig_v1 action=sign)' }
	}
	if (!body.submitterEoa || !ethers.isAddress(body.submitterEoa)) {
		return { success: false, error: 'Invalid submitterEoa' }
	}
	const submitterEoa = ethers.getAddress(body.submitterEoa)
	if (submitterEoa.toLowerCase() !== inner.signerEoa.toLowerCase()) {
		return { success: false, error: 'submitterEoa must match inner.signerEoa' }
	}
	if (inner.action === 'sign') {
		if (!inner.userOpHash || !inner.signature) {
			return { success: false, error: 'sign packet requires userOpHash and signature' }
		}
		if (!verifyUserOpSignature(inner.signerEoa, inner.userOpHash, inner.signature)) {
			return { success: false, error: 'Invalid UserOp signature for signerEoa' }
		}
	}
	const managerErr = await assertSignerIsThresholdManager(inner.aaAccount, inner.signerEoa, providerConet)
	if (managerErr) return { success: false, error: managerErr }

	const bunitCheck = await aaMultisigOfflineSubmitBunitPreCheck(submitterEoa, inner.aaAccount)
	if (!bunitCheck.success) {
		return { success: false, error: bunitCheck.error }
	}
	return {
		success: true,
		preChecked: {
			inner,
			submitterEoa,
			feePayer: bunitCheck.feePayer,
			feeAmount: String(bunitCheck.feeAmount),
			dedupeKey: buildAaMultisigOfflineSubmitDedupeKey(inner),
		},
	}
}
