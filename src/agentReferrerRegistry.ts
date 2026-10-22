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
import { CONET_AGENT_REFERRER_REGISTRY, CONET_BUINT } from './chainAddresses'
import {
	ensureSettleContractPoolInitialized,
	hasIdleSettleConet,
	shiftSettleConet,
	unshiftSettleConet,
} from './settleContractPool'
import { upsertAgentInviteReferee } from './agentInviteReferrerDb'

/** Free B-Unit airdrop when an agent temp creates a merchant card (1 B-Unit = 1e6). */
export const AGENT_CREATE_CARD_FREE_BUNIT_UNITS6 = 200_000_000n // 200 free B-Unit → merchant card contract
/** Free B-Unit airdrop when agent hands off a merchant card (1 B-Unit = 1e6). */
export const AGENT_HANDOFF_FREE_BUNIT_UNITS6 = 1_000_000_000n // 1000 free B-Unit → merchant EOA
/** CNET gas for temp wallet to call Ownable.transferOwnership during agent card claim. */
export const AGENT_CARD_CLAIM_FUND_WEI = ethers.parseEther('0.01')

ensureSettleContractPoolInitialized()

/** In-process idempotency: card already received handoff 1000 free B-Unit this process. */
const handoffBunitMintedCards = new Set<string>()

export function wasHandoffBunitMinted(cardAddress: string): boolean {
	try {
		return handoffBunitMintedCards.has(ethers.getAddress(cardAddress).toLowerCase())
	} catch {
		return false
	}
}

function markHandoffBunitMinted(cardAddress: string): void {
	handoffBunitMintedCards.add(ethers.getAddress(cardAddress).toLowerCase())
}

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
		{ name: 'card', type: 'address' },
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
	'function registerMerchantWithSig(address agent,address merchant,address temp,address card,uint256 nonce,uint256 deadline,bytes signature)',
	'function registerReferrerWithSig(address introducer,address referee,uint256 nonce,uint256 deadline,bytes signature)',
] as const

const BUNIT_REWARD_ABI = ['function mintReward(address to, uint256 amount)'] as const

export type AgentReferrerOp = 'registerAgent' | 'registerTemp' | 'registerMerchant' | 'registerReferrer'

type AgentReferrerJob = {
	op: AgentReferrerOp
	agent?: string
	temp?: string
	merchant?: string
	card?: string
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

/**
 * Background: 200 free B-Unit to the merchant card contract after temp/agent create succeeds.
 * Call after HTTP create response; failure must not affect create success.
 * Only runs when `agentOfTemp(cardOwner) != 0` (card created under an agent temp).
 */
export function airdropAgentCreateCardFreeBunit(cardAddress: string, cardOwner: string): void {
	void (async () => {
		const card = ethers.getAddress(cardAddress)
		const owner = ethers.getAddress(cardOwner)
		const SC = shiftSettleConet()
		if (!SC) {
			logger(
				Colors.yellow(
					`[agentReferrerRelay] create-card free B-Unit skipped (settle busy) card=${card} owner=${owner}`,
				),
			)
			return
		}
		try {
			const registry = new ethers.Contract(
				CONET_AGENT_REFERRER_REGISTRY,
				['function agentOfTemp(address) view returns (address)'],
				SC.walletConet,
			)
			const agent = (await registry.agentOfTemp!(owner)) as string
			if (!agent || agent === ethers.ZeroAddress) return

			const bunit = new ethers.Contract(CONET_BUINT, BUNIT_REWARD_ABI, SC.walletConet)
			const tx = await bunit.mintReward!(card, AGENT_CREATE_CARD_FREE_BUNIT_UNITS6)
			const receipt = await tx.wait()
			if (receipt?.status !== 1) throw new Error('mintReward reverted')
			logger(
				Colors.green(
					`[agentReferrerRelay] create-card free B-Unit ok card=${card} agent=${agent} units=200 tx=${tx.hash}`,
				),
			)
		} catch (e: unknown) {
			const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
			logger(Colors.yellow(`[agentReferrerRelay] create-card free B-Unit failed: ${msg}`))
		} finally {
			unshiftSettleConet(SC)
		}
	})()
}

/**
 * Background: 1000 free B-Unit to the **merchant** EOA after handoff is confirmed.
 * Skips if this process already minted for the same card (claimComplete + registerMerchant race).
 */
function airdropAgentHandoffFreeBunit(merchantEoa: string, cardAddress: string): void {
	void (async () => {
		const merchant = ethers.getAddress(merchantEoa)
		const card = ethers.getAddress(cardAddress)
		const cardKey = card.toLowerCase()
		if (handoffBunitMintedCards.has(cardKey)) {
			logger(
				Colors.cyan(
					`[agentReferrerRelay] handoff free B-Unit skipped (already minted) merchant=${merchant} card=${card}`,
				),
			)
			return
		}
		const SC = shiftSettleConet()
		if (!SC) {
			logger(
				Colors.yellow(
					`[agentReferrerRelay] handoff free B-Unit skipped (settle busy) merchant=${merchant} card=${card}`,
				),
			)
			return
		}
		try {
			const bunit = new ethers.Contract(CONET_BUINT, BUNIT_REWARD_ABI, SC.walletConet)
			const tx = await bunit.mintReward!(merchant, AGENT_HANDOFF_FREE_BUNIT_UNITS6)
			const receipt = await tx.wait()
			if (receipt?.status !== 1) throw new Error('mintReward reverted')
			markHandoffBunitMinted(card)
			logger(
				Colors.green(
					`[agentReferrerRelay] handoff free B-Unit ok merchant=${merchant} card=${card} units=1000 tx=${tx.hash}`,
				),
			)
		} catch (e: unknown) {
			const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
			logger(Colors.yellow(`[agentReferrerRelay] handoff free B-Unit failed: ${msg}`))
		} finally {
			unshiftSettleConet(SC)
		}
	})()
}

/**
 * Sync mint 1000 free B-Unit to merchant (claimComplete path). Returns txHash or null if skipped/busy/failed.
 */
async function mintHandoffFreeBunitToMerchantSync(
	merchantEoa: string,
	cardAddress: string,
): Promise<{ txHash?: string; skipped?: boolean; error?: string }> {
	const merchant = ethers.getAddress(merchantEoa)
	const card = ethers.getAddress(cardAddress)
	const cardKey = card.toLowerCase()
	if (handoffBunitMintedCards.has(cardKey)) {
		return { skipped: true }
	}
	const SC = shiftSettleConet()
	if (!SC) {
		return { error: 'Settle pool busy' }
	}
	try {
		const bunit = new ethers.Contract(CONET_BUINT, BUNIT_REWARD_ABI, SC.walletConet)
		const tx = await bunit.mintReward!(merchant, AGENT_HANDOFF_FREE_BUNIT_UNITS6)
		const receipt = await tx.wait()
		if (receipt?.status !== 1) throw new Error('mintReward reverted')
		markHandoffBunitMinted(card)
		logger(
			Colors.green(
				`[agentCardClaim] handoff free B-Unit ok merchant=${merchant} card=${card} units=1000 tx=${tx.hash}`,
			),
		)
		return { txHash: tx.hash }
	} catch (e: unknown) {
		const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
		logger(Colors.yellow(`[agentCardClaim] handoff free B-Unit failed: ${msg}`))
		return { error: msg }
	} finally {
		unshiftSettleConet(SC)
	}
}

/** Master: send CNET gas to temp so it can transferOwnership. Body pre-checked by Cluster. */
export async function agentCardClaimFundTempProcess(
	body: { temp: string; agent?: string; card?: string },
	res: Response,
): Promise<void> {
	const temp = ethers.getAddress(String(body.temp ?? ''))
	const SC = shiftSettleConet()
	if (!SC) {
		respond(res, 503, { success: false, error: 'Settle pool busy' })
		return
	}
	try {
		const bal = await SC.walletConet.provider!.getBalance(temp)
		if (bal >= AGENT_CARD_CLAIM_FUND_WEI / 2n) {
			respond(res, 200, { success: true, alreadyFunded: true, balance: bal.toString() })
			return
		}
		const tx = await SC.walletConet.sendTransaction({
			to: temp,
			value: AGENT_CARD_CLAIM_FUND_WEI,
		})
		const receipt = await tx.wait()
		if (receipt?.status !== 1) throw new Error('fund temp reverted')
		logger(Colors.green(`[agentCardClaim] fundTemp ok temp=${temp} wei=${AGENT_CARD_CLAIM_FUND_WEI} tx=${tx.hash}`))
		respond(res, 200, { success: true, txHash: tx.hash })
	} catch (e: unknown) {
		const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
		logger(Colors.red(`[agentCardClaim] fundTemp failed:`), msg)
		respond(res, 400, { success: false, error: msg })
	} finally {
		unshiftSettleConet(SC)
	}
}

/** Master: mint 1000 free B-Unit to merchant after ownership transfer. Body pre-checked by Cluster. */
export async function agentCardClaimCompleteProcess(
	body: { merchant: string; card: string; agent?: string; temp?: string },
	res: Response,
): Promise<void> {
	const merchant = ethers.getAddress(String(body.merchant ?? ''))
	const card = ethers.getAddress(String(body.card ?? ''))
	const result = await mintHandoffFreeBunitToMerchantSync(merchant, card)
	if (result.skipped) {
		respond(res, 200, { success: true, duplicate: true })
		return
	}
	if (result.error) {
		respond(res, 400, { success: false, error: result.error })
		return
	}
	respond(res, 200, { success: true, txHash: result.txHash })
}

export function enqueueAgentReferrerRelay(input: {
	op: AgentReferrerOp
	agent?: string
	temp?: string
	merchant?: string
	card?: string
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
		card: input.card,
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
				ethers.getAddress(job.card!),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 320_000 },
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
		if (job.op === 'registerReferrer' && job.introducer && job.referee) {
			void upsertAgentInviteReferee({
				introducer: job.introducer,
				referee: job.referee,
				txHash: tx.hash,
			}).catch(() => {})
		}
		if (job.op === 'registerMerchant' && job.merchant && job.card) {
			airdropAgentHandoffFreeBunit(job.merchant, job.card)
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
