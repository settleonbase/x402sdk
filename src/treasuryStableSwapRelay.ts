/**
 * ConetTreasuryPeer 本链离线签字 StableSwap — Master Settle_ContractPool 代付。
 * Cluster 完成预检后入队；Master 调用 Offline.bridgeStableSwapWithSignature。
 */
import { ethers } from 'ethers'
import type { Response } from 'express'
import Colors from 'colors/safe'
import { logger } from './logger'
import {
	CONET_TREASURY_CREATE2,
	CONET_TREASURY_PEER,
	CONET_TREASURY_PEER_STABLE_SWAP_OFFLINE,
	CONET_USDC,
} from './chainAddresses'
import { Settle_ContractPool, ensureSettleContractPoolInitialized } from './settleContractPool'

ensureSettleContractPoolInitialized()

export const CONET_STABLE_SWAP_CHAIN_ID = 224422n
export const CANONICAL_GB_ERC20 = 1
export const CANONICAL_USDC_ERC20 = 2
export const CANONICAL_BUINT_ERC20 = 3

const OFFLINE_ABI = [
	'function bridgeStableSwapWithSignature(address user,uint8 burnAssetKind,uint256 amount,uint256 destinationChainId,address recipient,uint8 creditAssetKind,uint256 minCreditAmount,uint256 nonce,uint256 deadline,bytes signature)',
] as const

const USDC_PERMIT_ABI = [
	'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
] as const

export type TreasuryStableSwapJob = {
	user: string
	burnAssetKind: number
	amount: string
	destinationChainId: string
	recipient: string
	creditAssetKind: number
	minCreditAmount: string
	nonce: string
	deadline: string
	signature: string
	/** optional EIP-2612 permit for USDC → Treasury (spender = CONET_TREASURY_CREATE2) */
	permit?: {
		value: string
		deadline: string
		v: number
		r: string
		s: string
	}
	res: Response
}

export const treasuryStableSwapPool: TreasuryStableSwapJob[] = []

export function kickTreasuryStableSwapRelay(): void {
	void treasuryStableSwapRelayProcess().catch((error: unknown) => {
		const msg = error instanceof Error ? error.message : String(error)
		logger(Colors.red('[treasuryStableSwapRelay] unhandled error:'), msg)
	})
}

function scheduleTreasuryStableSwapRelay(): void {
	if (treasuryStableSwapPool.length === 0) return
	if (Settle_ContractPool.length > 0) {
		kickTreasuryStableSwapRelay()
		return
	}
	setTimeout(() => kickTreasuryStableSwapRelay(), 3000)
}

export async function treasuryStableSwapRelayProcess(): Promise<void> {
	const job = treasuryStableSwapPool.shift()
	if (!job) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		treasuryStableSwapPool.unshift(job)
		return scheduleTreasuryStableSwapRelay()
	}
	try {
		if (job.permit) {
			const usdc = new ethers.Contract(CONET_USDC, USDC_PERMIT_ABI, SC.walletConet)
			const ptx = await usdc.permit!(
				ethers.getAddress(job.user),
				CONET_TREASURY_CREATE2,
				BigInt(job.permit.value),
				BigInt(job.permit.deadline),
				job.permit.v,
				job.permit.r,
				job.permit.s,
				{ gasLimit: 120_000 },
			)
			const prec = await ptx.wait()
			if (prec?.status !== 1) throw new Error('USDC permit reverted')
		}

		const offline = new ethers.Contract(
			CONET_TREASURY_PEER_STABLE_SWAP_OFFLINE,
			OFFLINE_ABI,
			SC.walletConet,
		)
		const tx = await offline.bridgeStableSwapWithSignature!(
			ethers.getAddress(job.user),
			job.burnAssetKind,
			BigInt(job.amount),
			BigInt(job.destinationChainId),
			ethers.getAddress(job.recipient),
			job.creditAssetKind,
			BigInt(job.minCreditAmount),
			BigInt(job.nonce),
			BigInt(job.deadline),
			job.signature,
			{ gasLimit: 800_000 },
		)
		const receipt = await tx.wait()
		if (receipt?.status !== 1) throw new Error('bridgeStableSwapWithSignature reverted')
		if (job.res && !job.res.headersSent) {
			job.res
				.status(200)
				.json({
					success: true,
					txHash: tx.hash,
					peer: CONET_TREASURY_PEER,
					offline: CONET_TREASURY_PEER_STABLE_SWAP_OFFLINE,
				})
				.end()
		}
	} catch (e: unknown) {
		const msg =
			e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
		logger(Colors.red('[treasuryStableSwapRelay] failed:'), msg)
		if (job.res && !job.res.headersSent) {
			job.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		Settle_ContractPool.unshift(SC)
		scheduleTreasuryStableSwapRelay()
	}
}

/** EIP-712 domain / types for client + Cluster (verifyingContract = Peer). */
export function treasuryStableSwapEip712Domain() {
	return {
		name: 'ConetTreasuryPeer',
		version: '1',
		chainId: Number(CONET_STABLE_SWAP_CHAIN_ID),
		verifyingContract: CONET_TREASURY_PEER,
	}
}

export const TREASURY_STABLE_SWAP_TYPES: Record<string, ethers.TypedDataField[]> = {
	StableSwap: [
		{ name: 'user', type: 'address' },
		{ name: 'burnAssetKind', type: 'uint8' },
		{ name: 'amount', type: 'uint256' },
		{ name: 'destinationChainId', type: 'uint256' },
		{ name: 'recipient', type: 'address' },
		{ name: 'creditAssetKind', type: 'uint8' },
		{ name: 'minCreditAmount', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export function isLocalUsdcStableSwapPair(burnKind: number, creditKind: number): boolean {
	if (burnKind === creditKind) return false
	if (burnKind < CANONICAL_GB_ERC20 || burnKind > CANONICAL_BUINT_ERC20) return false
	if (creditKind < CANONICAL_GB_ERC20 || creditKind > CANONICAL_BUINT_ERC20) return false
	return burnKind === CANONICAL_USDC_ERC20 || creditKind === CANONICAL_USDC_ERC20
}
