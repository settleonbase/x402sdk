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
import {
	chatIndexPointerOwnerKey,
	chatIndexPointerRequestKey,
	pickChatIndexPointerJobIndex,
} from './chatIndexPointerScheduling'

ensureSettleContractPoolInitialized()

const CHAT_INDEX_REGISTRY_ABI = [
	'function setPointerWithSig(address owner,bytes32 indexHash,uint64 ts,uint64 seq,uint256 nonce,bytes signature)',
] as const

type ChatIndexPointerJob = {
	owner: string
	indexHash: string
	ts: string
	seq: string
	nonce: string
	signature: string
	requestKey: string
	signatureKey: string
	waiters: Response[]
}

type ChatIndexPointerRequestState = {
	requestKey: string
	signatureKey: string
	status: 'queued' | 'inflight' | 'success' | 'failed'
	txHash?: string
	error?: string
	waiters: Response[]
}

/** Pending jobs are intentionally shared with the Master router for observability. */
export const chatIndexPointerPool: ChatIndexPointerJob[] = []

const chatIndexPointerStates = new Map<string, ChatIndexPointerRequestState>()
const chatIndexPointerInFlightOwners = new Set<string>()
let chatIndexPointerDrainRunning = false
let chatIndexPointerRetryTimer: ReturnType<typeof setTimeout> | undefined
const CHAT_INDEX_POINTER_RETRY_MS = 3000
const CHAT_INDEX_POINTER_STATE_TTL_MS = 60_000

function respond(res: Response, status: number, body: Record<string, unknown>): void {
	if (!res.headersSent) res.status(status).json(body).end()
}

function respondToWaiters(
	waiters: Response[],
	status: number,
	body: Record<string, unknown>,
): void {
	for (const res of waiters.splice(0)) respond(res, status, body)
}

function forgetStateLater(requestKey: string, state: ChatIndexPointerRequestState): void {
	setTimeout(() => {
		if (chatIndexPointerStates.get(requestKey) === state) chatIndexPointerStates.delete(requestKey)
	}, CHAT_INDEX_POINTER_STATE_TTL_MS)
}

function scheduleChatIndexPointerRelay(): void {
	if (chatIndexPointerPool.length === 0 || chatIndexPointerRetryTimer !== undefined) return
	chatIndexPointerRetryTimer = setTimeout(() => {
		chatIndexPointerRetryTimer = undefined
		drainChatIndexPointerRelay()
	}, CHAT_INDEX_POINTER_RETRY_MS)
}

function drainChatIndexPointerRelay(): void {
	if (chatIndexPointerDrainRunning) return
	chatIndexPointerDrainRunning = true
	try {
		while (hasIdleSettleConet()) {
			const index = pickChatIndexPointerJobIndex(
				chatIndexPointerPool,
				chatIndexPointerInFlightOwners,
			)
			if (index < 0) break
			const [job] = chatIndexPointerPool.splice(index, 1)
			if (!job) break
			const SC = shiftSettleConet()
			if (!SC) {
				chatIndexPointerPool.unshift(job)
				break
			}
			chatIndexPointerInFlightOwners.add(chatIndexPointerOwnerKey(job.owner))
			const state = chatIndexPointerStates.get(job.requestKey)
			if (state) state.status = 'inflight'
			void relayChatIndexPointerJob(job, SC)
		}
	} finally {
		chatIndexPointerDrainRunning = false
	}
	if (chatIndexPointerPool.length > 0 && !hasIdleSettleConet()) scheduleChatIndexPointerRelay()
}

export function enqueueChatIndexPointerRelay(input: {
	owner: string
	indexHash: string
	ts: string
	seq: string
	nonce: string
	signature: string
	res: Response
}): void {
	const owner = ethers.getAddress(input.owner)
	const requestKey = chatIndexPointerRequestKey(owner, input.nonce)
	const signatureKey = input.signature.toLowerCase()
	const existing = chatIndexPointerStates.get(requestKey)
	if (existing) {
		if (existing.signatureKey !== signatureKey) {
			respond(input.res, 409, {
				success: false,
				error: 'Conflicting chat pointer request for the same owner nonce',
			})
			return
		}
		if (existing.status === 'success') {
			respond(input.res, 200, { success: true, txHash: existing.txHash, duplicate: true })
			return
		}
		if (existing.status === 'failed') {
			respond(input.res, 400, { success: false, error: existing.error ?? 'Relay failed', duplicate: true })
			return
		}
		existing.waiters.push(input.res)
		return
	}

	const state: ChatIndexPointerRequestState = {
		requestKey,
		signatureKey,
		status: 'queued',
		waiters: [input.res],
	}
	chatIndexPointerStates.set(requestKey, state)
	chatIndexPointerPool.push({
		owner,
		indexHash: input.indexHash,
		ts: input.ts,
		seq: input.seq,
		nonce: input.nonce,
		signature: input.signature,
		requestKey,
		signatureKey,
		waiters: state.waiters,
	})
	drainChatIndexPointerRelay()
}

export function kickChatIndexPointerRelay(): void {
	drainChatIndexPointerRelay()
}

async function relayChatIndexPointerJob(job: ChatIndexPointerJob, SC: ReturnType<typeof shiftSettleConet>): Promise<void> {
	if (!SC) {
		chatIndexPointerPool.unshift(job)
		chatIndexPointerInFlightOwners.delete(chatIndexPointerOwnerKey(job.owner))
		return drainChatIndexPointerRelay()
	}
	const state = chatIndexPointerStates.get(job.requestKey)
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
		if (state) {
			state.status = 'success'
			state.txHash = tx.hash
			respondToWaiters(state.waiters, 200, { success: true, txHash: tx.hash })
			forgetStateLater(job.requestKey, state)
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
		logger(Colors.red('[chatIndexPointerRelay] failed:'), msg)
		if (state) {
			state.status = 'failed'
			state.error = msg
			respondToWaiters(state.waiters, 400, { success: false, error: msg })
			forgetStateLater(job.requestKey, state)
		}
	} finally {
		unshiftSettleConet(SC)
		chatIndexPointerInFlightOwners.delete(chatIndexPointerOwnerKey(job.owner))
		drainChatIndexPointerRelay()
	}
}
