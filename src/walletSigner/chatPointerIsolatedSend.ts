import { Interface } from 'ethers'
import { chatIndexPointerRequestKey } from '../chatIndexPointerScheduling'
import {
	chatWritesStopped,
	decideRemoteChatToken,
	releaseRemoteChatToken,
	retainRemoteChatToken,
	type ChatPointerSettlement,
} from './chatWriteStopGate'
import { holdIsolatedChatRelay, releaseIsolatedChatRelay, takeIsolatedChatRelay } from './isolatedChatRelayPool'
import { RemoteSigner } from './remoteSigner'

const pointerIface = new Interface([
	'function setPointerWithSig(address owner,bytes32 indexHash,uint64 ts,uint64 seq,uint256 nonce,bytes signature)',
])

/**
 * Same key the queued chat relay already uses: `chat:` plus owner and pointer nonce.
 * The nonce is the decimal integer in the calldata, which is the client string for a canonical decimal.
 */
export function chatPointerIdempotencyKey(owner: string, nonce: string): string {
	return `chat:${chatIndexPointerRequestKey(owner, nonce)}`
}

export function chatPointerIdempotencyKeyFromCalldata(data: string): string {
	let decoded: ReturnType<typeof pointerIface.decodeFunctionData>
	try {
		decoded = pointerIface.decodeFunctionData('setPointerWithSig', data)
	} catch {
		throw new Error('isolated chat pointer requires setPointerWithSig calldata')
	}
	const nonce = decoded[4] as bigint
	return chatPointerIdempotencyKey(String(decoded[0]), nonce.toString())
}

/** One in-flight send per pointer key. Concurrent callers share it and do not take a second signer. */
const isolatedInflight = new Map<string, Promise<{ txHash: string }>>()

/** Broadcast one already-authorized setPointerWithSig. Empty isolated roster is signer_unavailable. */
export async function submitIsolatedChatPointer(call: {
	to: string
	data: string
	value: bigint
	gasLimit: bigint
}): Promise<{ txHash: string }> {
	const key = chatPointerIdempotencyKeyFromCalldata(call.data)
	const existing = isolatedInflight.get(key)
	if (existing) return existing
	if (chatWritesStopped()) throw new Error('chat_writes_stopped')
	const pending = sendIsolatedChatPointer(call).finally(() => {
		if (isolatedInflight.get(key) === pending) isolatedInflight.delete(key)
	})
	isolatedInflight.set(key, pending)
	return pending
}

async function sendIsolatedChatPointer(call: {
	to: string
	data: string
	value: bigint
	gasLimit: bigint
}): Promise<{ txHash: string }> {
	const key = chatPointerIdempotencyKeyFromCalldata(call.data)
	const signer = takeIsolatedChatRelay()
	if (!signer) throw new Error('signer_unavailable')
	let settlement: ChatPointerSettlement = 'not-sent'
	try {
		// Ledger write happens only after a signer is held, and before send.
		// A failed write returns the signer in finally and does not broadcast.
		retainRemoteChatToken({
			idempotencyKey: key,
			owner: ownerFromCalldata(call.data),
			pointerNonce: nonceFromCalldata(call.data),
			phase: 'unconfirmed',
		})
		// Do not pin the idle relayer. The chat: key identifies the pointer update, and a
		// different from would make a retry or a concurrent send look like another request.
		const bound = new RemoteSigner(signer.client, {
			keyArray: signer.options.keyArray,
			chainId: signer.options.chainId,
			idempotencyKey: key,
		}, signer.provider)
		const tx = await bound.sendTransaction({
			to: call.to,
			data: call.data,
			value: call.value,
			gasLimit: call.gasLimit,
		})
		settlement = 'unconfirmed'
		let receipt: { status?: number | null } | null
		try {
			receipt = await tx.wait()
		} catch {
			settlement = 'abandoned'
			retainRemoteChatToken({
				idempotencyKey: key,
				owner: ownerFromCalldata(call.data),
				pointerNonce: nonceFromCalldata(call.data),
				phase: 'abandoned',
			})
			throw new Error('chat_pointer_unreconciled')
		}
		if (receipt?.status !== 1) {
			const phase = receipt ? 'abandoned' : 'unconfirmed'
			settlement = phase
			retainRemoteChatToken({
				idempotencyKey: key,
				owner: ownerFromCalldata(call.data),
				pointerNonce: nonceFromCalldata(call.data),
				phase,
			})
			throw new Error('chat_pointer_unreconciled')
		}
		settlement = 'confirmed'
		releaseRemoteChatToken(key)
		return { txHash: tx.hash }
	} finally {
		const decision = decideRemoteChatToken(settlement)
		if (decision.releaseToken) releaseIsolatedChatRelay(signer)
		else holdIsolatedChatRelay(signer)
	}
}

function ownerFromCalldata(data: string): string {
	return String(pointerIface.decodeFunctionData('setPointerWithSig', data)[0])
}

function nonceFromCalldata(data: string): string {
	return (pointerIface.decodeFunctionData('setPointerWithSig', data)[4] as bigint).toString()
}
