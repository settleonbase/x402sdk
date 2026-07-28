/**
 * GenesisNodeReferralVaultV1 — gasless Admin/L0/L1 redeem relay (Master pool).
 * L0 sets ratioBps (% of L0's 10% node bucket) when issuing L1 codes.
 */
import { ethers } from 'ethers'
import type { Response } from 'express'
import Colors from 'colors/safe'
import { logger } from './logger'
import { CONET_GENESIS_NODE_REFERRAL_VAULT } from './chainAddresses'
import { Settle_ContractPool, ensureSettleContractPoolInitialized } from './settleContractPool'

ensureSettleContractPoolInitialized()

const GENESIS_REFERRAL_REDEEM_ABI = [
	'function issueL0RedeemCodeFor(address admin,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
	'function cancelL0RedeemCodeFor(address admin,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
	'function claimL0RedeemCodeFor(address claimer,bytes secret,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
	'function issueL1RedeemCodeFor(address l0,bytes32 redeemHash,uint256 ratioBps,uint256 nonce,uint256 deadline,bytes signature)',
	'function cancelL1RedeemCodeFor(address l0,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
	'function claimL1RedeemCodeFor(address claimer,bytes secret,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
	'function setFoundationFor(address admin,address foundation,uint256 nonce,uint256 deadline,bytes signature)',
	'function setDefaultAdminPayoutFor(address admin,address payout,uint256 nonce,uint256 deadline,bytes signature)',
] as const

export type GenesisNodeReferralRedeemAction =
	| 'issueL0'
	| 'cancelL0'
	| 'claimL0'
	| 'issueL1'
	| 'cancelL1'
	| 'claimL1'
	| 'setFoundation'
	| 'setDefaultAdminPayout'

export const genesisNodeReferralRedeemPool: Array<{
	action: GenesisNodeReferralRedeemAction
	account: string
	redeemHash?: string
	payoutAddress?: string
	nonce: string
	deadline: string
	signature: string
	secret?: string
	ratioBps?: string
	res: Response
}> = []

export function kickGenesisNodeReferralRedeemRelay(): void {
	void genesisNodeReferralRedeemRelayProcess().catch((error: unknown) => {
		const msg = error instanceof Error ? error.message : String(error)
		logger(Colors.red('[genesisNodeReferralRedeemRelay] unhandled error:'), msg)
	})
}

function scheduleGenesisNodeReferralRedeemRelay(): void {
	if (genesisNodeReferralRedeemPool.length === 0) return
	if (Settle_ContractPool.length > 0) {
		kickGenesisNodeReferralRedeemRelay()
		return
	}
	setTimeout(() => kickGenesisNodeReferralRedeemRelay(), 3000)
}

export async function genesisNodeReferralRedeemRelayProcess(): Promise<void> {
	const job = genesisNodeReferralRedeemPool.shift()
	if (!job) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		genesisNodeReferralRedeemPool.unshift(job)
		return scheduleGenesisNodeReferralRedeemRelay()
	}
	try {
		const vault = new ethers.Contract(
			CONET_GENESIS_NODE_REFERRAL_VAULT,
			GENESIS_REFERRAL_REDEEM_ABI,
			SC.walletConet,
		)
		const account = ethers.getAddress(job.account)
		let tx: ethers.ContractTransactionResponse
		if (job.action === 'setFoundation') {
			tx = await vault.setFoundationFor!(
				account,
				ethers.getAddress(job.payoutAddress!),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 200_000 },
			)
		} else if (job.action === 'setDefaultAdminPayout') {
			tx = await vault.setDefaultAdminPayoutFor!(
				account,
				ethers.getAddress(job.payoutAddress!),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 200_000 },
			)
		} else if (job.action === 'issueL0') {
			tx = await vault.issueL0RedeemCodeFor!(
				account,
				job.redeemHash!,
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 400_000 },
			)
		} else if (job.action === 'cancelL0') {
			tx = await vault.cancelL0RedeemCodeFor!(
				account,
				job.redeemHash!,
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 300_000 },
			)
		} else if (job.action === 'claimL0') {
			tx = await vault.claimL0RedeemCodeFor!(
				account,
				ethers.toUtf8Bytes(job.secret ?? ''),
				job.redeemHash!,
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 500_000 },
			)
		} else if (job.action === 'issueL1') {
			tx = await vault.issueL1RedeemCodeFor!(
				account,
				job.redeemHash!,
				BigInt(job.ratioBps ?? '0'),
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 400_000 },
			)
		} else if (job.action === 'cancelL1') {
			tx = await vault.cancelL1RedeemCodeFor!(
				account,
				job.redeemHash!,
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 300_000 },
			)
		} else {
			tx = await vault.claimL1RedeemCodeFor!(
				account,
				ethers.toUtf8Bytes(job.secret ?? ''),
				job.redeemHash!,
				BigInt(job.nonce),
				BigInt(job.deadline),
				job.signature,
				{ gasLimit: 500_000 },
			)
		}
		const receipt = await tx.wait()
		if (receipt?.status !== 1) throw new Error(`${job.action} reverted`)
		if (job.res && !job.res.headersSent) {
			job.res.status(200).json({ success: true, txHash: tx.hash }).end()
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
		logger(Colors.red('[genesisNodeReferralRedeemRelay] failed:'), msg)
		if (job.res && !job.res.headersSent) {
			job.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		Settle_ContractPool.unshift(SC)
		scheduleGenesisNodeReferralRedeemRelay()
	}
}
