/**
 * BeamioAgentReferrerRegistry — gasless EIP-712 relay (Master Conet pool).
 *
 * Ops: RegisterAgent (self), RegisterTemp (agent), RegisterMerchant (agent),
 * RegisterReferrer (referee under introducer). Cluster verifies; Master pays gas.
 */
import { ethers } from 'ethers'
import type { Response } from 'express'
import Colors from 'colors/safe'
import { logger } from './logger'
import { CONET_AGENT_REFERRER_REGISTRY } from './chainAddresses'
import {
	ensureSettleContractPoolInitialized,
	hasIdleSettleConet,
	shiftSettleConet,
	unshiftSettleConet,
} from './settleContractPool'

ensureSettleContractPoolInitialized()

export const AGENT_REFERRER_EIP712_DOMAIN = {
	name: 'BeamioAgentReferrerRegistry',
	version: '1',
	chainId: 224422,
	verifyingContract: CONET_AGENT_REFERRER_REGISTRY,
} as const

/** Mutable TypedDataField[] — ethers verifyTypedData / signTypedData reject readonly `as const` (TS4104). */
export const AGENT_REFERRER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
	RegisterAgent: [
		{ name: 'agent', type: 'address' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
	RegisterTemp: [
		{ name: 'agent', type: 'address' },
		{ name: 'temp', type: 'address' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
	RegisterMerchant: [
		{ name: 'agent', type: 'address' },
		{ name: 'merchant', type: 'address' },
		{ name: 'temp', type: 'address' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
	RegisterReferrer: [
		{ name: 'introducer', type: 'address' },
		{ name: 'referee', type: 'address' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

const REGISTRY_WRITE_ABI = [
	'function registerAgentWithSig(address agent,uint256 nonce,uint256 deadline,bytes signature)',
	'function registerTempWithSig(address agent,address temp,uint256 nonce,uint256 deadline,bytes signature)',
	'function registerMerchantWithSig(address agent,address merchant,address temp,uint256 nonce,uint256 deadline,bytes signature)',
	'function registerReferrerWithSig(address introducer,address referee,uint256 nonce,uint256 deadline,bytes signature)',
] as const

export type AgentReferrerOp = 'registerAgent' | 'registerTemp' | 'registerMerchant' | 'registerReferrer'

type AgentReferrerJob = {
	op: AgentReferrerOp
	agent?: string
	temp?: string
	merchant?: string
	introducer?: string
	referee?: string
	nonce: string
	deadline: string
	signature: string
	requestKey: string
	signatureKey: string
	waiters: Response[]
}

type AgentReferrerRequestState = {
	requestKey: string
	signatureKey: string
	status: 'queued' | 'inflight' | 'success' | 'failed'
	txHash?: string
	error?: string
	waiters: Response[]
}

export const agentReferrerPool: AgentReferrerJob[] = []
const agentReferrerStates = new Map<string, AgentReferrerRequestState>()
const agentReferrerInFlightKeys = new Set<string>()
let agentReferrerDrainRunning = false
let agentReferrerRetryTimer: ReturnType<typeof setTimeout> | undefined
const RETRY_MS = 3000
const STATE_TTL_MS = 60_000

function respond(res: Response, status: number, body: Record<string, unknown>): void {
	if (!res.headersSent) res.status(status).json(body).end()
}

function respondToWaiters(waiters: Response[], status: number, body: Record<string, unknown>): void {
	for (const res of waiters.splice(0)) respond(res, status, body)
}

function forgetStateLater(requestKey: string, state: AgentReferrerRequestState): void {
	setTimeout(() => {
		if (agentReferrerStates.get(requestKey) === state) agentReferrerStates.delete(requestKey)
	}, STATE_TTL_MS)
}

function signerKeyForJob(job: AgentReferrerJob): string {
	if (job.op === 'registerReferrer') return (job.referee || '').toLowerCase()
	return (job.agent || '').toLowerCase()
}

function scheduleDrain(): void {
	if (agentReferrerPool.length === 0 || agentReferrerRetryTimer !== undefined) return
	agentReferrerRetryTimer = setTimeout(() => {
		agentReferrerRetryTimer = undefined
		drainAgentReferrerRelay()
	}, RETRY_MS)
}

function pickJobIndex(inFlight: Set<string>): number {
	for (let i = 0; i < agentReferrerPool.length; i++) {
		const key = signerKeyForJob(agentReferrerPool[i]!)
		if (!inFlight.has(key)) return i
	}
	return -1
}

function drainAgentReferrerRelay(): void {
	if (agentReferrerDrainRunning) return
	agentReferrerDrainRunning = true
	try {
		while (hasIdleSettleConet()) {
			const index = pickJobIndex(agentReferrerInFlightKeys)
			if (index < 0) break
			const [job] = agentReferrerPool.splice(index, 1)
			if (!job) break
			const SC = shiftSettleConet()
			if (!SC) {
				agentReferrerPool.unshift(job)
				break
			}
			const sk = signerKeyForJob(job)
			agentReferrerInFlightKeys.add(sk)
			const state = agentReferrerStates.get(job.requestKey)
			if (state) state.status = 'inflight'
			void relayJob(job, SC)
		}
	} finally {
		agentReferrerDrainRunning = false
	}
	if (agentReferrerPool.length > 0 && !hasIdleSettleConet()) scheduleDrain()
}

export function kickAgentReferrerRelay(): void {
	drainAgentReferrerRelay()
}

export function enqueueAgentReferrerRelay(input: {
	op: AgentReferrerOp
	agent?: string
	temp?: string
	merchant?: string
	introducer?: string
	referee?: string
	nonce: string
	deadline: string
	signature: string
	res: Response
}): void {
	const requestKey = `${input.op}:${input.nonce}:${(input.agent || input.referee || '').toLowerCase()}`
	const signatureKey = input.signature.toLowerCase()
	const existing = agentReferrerStates.get(requestKey)
	if (existing) {
		if (existing.signatureKey !== signatureKey) {
			respond(input.res, 409, { success: false, error: 'Conflicting request for the same signer nonce' })
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

	const state: AgentReferrerRequestState = {
		requestKey,
		signatureKey,
		status: 'queued',
		waiters: [input.res],
	}
	agentReferrerStates.set(requestKey, state)
	agentReferrerPool.push({
		op: input.op,
		agent: input.agent,
		temp: input.temp,
		merchant: input.merchant,
		introducer: input.introducer,
		referee: input.referee,
		nonce: input.nonce,
		deadline: input.deadline,
		signature: input.signature,
		requestKey,
		signatureKey,
		waiters: state.waiters,
	})
	drainAgentReferrerRelay()
}

async function relayJob(
	job: AgentReferrerJob,
	SC: ReturnType<typeof shiftSettleConet>,
): Promise<void> {
	if (!SC) {
		agentReferrerPool.unshift(job)
		agentReferrerInFlightKeys.delete(signerKeyForJob(job))
		return drainAgentReferrerRelay()
	}
	const state = agentReferrerStates.get(job.requestKey)
	try {
		const registry = new ethers.Contract(
			CONET_AGENT_REFERRER_REGISTRY,
			REGISTRY_WRITE_ABI,
			SC.walletConet,
		)
		let tx: ethers.ContractTransactionResponse
		const gas = { gasLimit: 220_000 }
		if (job.op === 'registerAgent') {
			tx = await registry.registerAgentWithSig!(
				ethers.getAddress(job.agent!),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				gas,
			)
		} else if (job.op === 'registerTemp') {
			tx = await registry.registerTempWithSig!(
				ethers.getAddress(job.agent!),
				ethers.getAddress(job.temp!),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				gas,
			)
		} else if (job.op === 'registerMerchant') {
			tx = await registry.registerMerchantWithSig!(
				ethers.getAddress(job.agent!),
				ethers.getAddress(job.merchant!),
				ethers.getAddress(job.temp || ethers.ZeroAddress),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				gas,
			)
		} else {
			tx = await registry.registerReferrerWithSig!(
				ethers.getAddress(job.introducer!),
				ethers.getAddress(job.referee!),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				gas,
			)
		}
		const receipt = await tx.wait()
		if (receipt?.status !== 1) throw new Error(`${job.op} reverted`)
		if (state) {
			state.status = 'success'
			state.txHash = tx.hash
			respondToWaiters(state.waiters, 200, { success: true, txHash: tx.hash, op: job.op })
			forgetStateLater(job.requestKey, state)
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
		logger(Colors.red(`[agentReferrerRelay] ${job.op} failed:`), msg)
		if (state) {
			state.status = 'failed'
			state.error = msg
			respondToWaiters(state.waiters, 400, { success: false, error: msg, op: job.op })
			forgetStateLater(job.requestKey, state)
		}
	} finally {
		unshiftSettleConet(SC)
		agentReferrerInFlightKeys.delete(signerKeyForJob(job))
		drainAgentReferrerRelay()
	}
}
