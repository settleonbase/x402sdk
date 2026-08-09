/**
 * ChatIndexRegistry — gasless encrypted-chat-history index pointer relay (Master pool).
 *
 * A wallet signs `SetPointer(owner,indexHash,ts,seq,nonce)` offline (EIP-712). ANYONE may submit
 * that signed update; this relayer (Master settle pool) pays gas. Only the owner's signature can
 * move the owner's pointer, so the write right is protected by the private key.
 */
import { ethers } from 'ethers'
import type { Response } from 'express'
import Colors from 'colors/safe'
import { logger } from './logger'
import { CONET_CHAT_INDEX_REGISTRY } from './chainAddresses'
import {
	ensureSettleContractPoolInitialized,
	hasIdleSettleConet,
	shiftSettleConet,
	unshiftSettleConet,
} from './settleContractPool'

ensureSettleContractPoolInitialized()

const CHAT_INDEX_REGISTRY_ABI = [
	'function setPointerWithSig(address owner,bytes32 indexHash,uint64 ts,uint64 seq,uint256 nonce,bytes signature)',
] as const

export const chatIndexPointerPool: Array<{
	owner: string
	indexHash: string
	ts: string
	seq: string
	nonce: string
	signature: string
	res: Response
}> = []

export function kickChatIndexPointerRelay(): void {
	void chatIndexPointerRelayProcess().catch((error: unknown) => {
		const msg = error instanceof Error ? error.message : String(error)
		logger(Colors.red('[chatIndexPointerRelay] unhandled error:'), msg)
	})
}

function scheduleChatIndexPointerRelay(): void {
	if (chatIndexPointerPool.length === 0) return
	if (hasIdleSettleConet()) {
		kickChatIndexPointerRelay()
		return
	}
	setTimeout(() => kickChatIndexPointerRelay(), 3000)
}

export async function chatIndexPointerRelayProcess(): Promise<void> {
	const job = chatIndexPointerPool.shift()
	if (!job) return
	const SC = shiftSettleConet()
	if (!SC) {
		chatIndexPointerPool.unshift(job)
		return scheduleChatIndexPointerRelay()
	}
	try {
		const registry = new ethers.Contract(
			CONET_CHAT_INDEX_REGISTRY,
			CHAT_INDEX_REGISTRY_ABI,
			SC.walletConet,
		)
		const tx: ethers.ContractTransactionResponse = await registry.setPointerWithSig!(
			ethers.getAddress(job.owner),
			job.indexHash,
			BigInt(job.ts),
			BigInt(job.seq),
			BigInt(job.nonce),
			job.signature,
			{ gasLimit: 150_000 },
		)
		const receipt = await tx.wait()
		if (receipt?.status !== 1) throw new Error('setPointerWithSig reverted')
		if (job.res && !job.res.headersSent) {
			job.res.status(200).json({ success: true, txHash: tx.hash }).end()
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
		logger(Colors.red('[chatIndexPointerRelay] failed:'), msg)
		if (job.res && !job.res.headersSent) {
			job.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		unshiftSettleConet(SC)
		scheduleChatIndexPointerRelay()
	}
}
