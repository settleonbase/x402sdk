/**
 * Discover treasuryBridge fulfill (after Base USDC x402 settle → GENESIS_NODE_BRIDGE_INITIATOR):
 * 1) initiateLockMint CONET-USDC → card.owner()
 * 2) optional stageMembershipFeePurchase (first issue / upgrade)
 * 3) mintPointsForProtocolUsdcSettlement(recipientEOA, points6) via EntryPoint (gateway accounting)
 * Idempotent on USDC_tx.
 */
import { ethers } from 'ethers'
import type { Response } from 'express'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import Colors from 'colors/safe'
import { logger } from '../logger'
import {
	CONET_BUNIT_AIRDROP_ADDRESS,
	CONET_MAINNET_CHAIN_ID,
	CONET_TREASURY,
	CONET_USDC,
	USDC_BASE,
} from '../chainAddresses'
import {
	hasIdleGenesisInitiatorBase,
	withGenesisBridgeInitiatorBase,
	Settle_ContractPool,
	ensureSettleContractPoolInitialized,
	shiftSettleConet,
	unshiftSettleConet,
	type SettleContractPoolEntry,
} from '../settleContractPool'
import {
	calcTopupFixedBUnitFee,
	checkBusinessRelayTxSuccessful,
	ensureAAForEOAOnCard,
	mintPointsForProtocolUsdcSettlementViaEntryPoint,
	relayUserCardCallViaEntryPoint,
	resolveCardOwnerToEOA,
	type NfcTopupMembershipFeeStage,
} from '../MemberCard'
import { resolveUserCardChain } from '../beamioUserCardChain'
import { insertMemberTopupEvent } from '../db'

ensureSettleContractPoolInitialized()

const TREASURY_LOCK_MINT_ABI = [
	'function initiateLockMint(uint256 destinationChainId,address sourceAsset,address destinationAsset,address[] beneficiaries,uint256[] amounts,bytes32 sourceTxHash,uint256 nonce,address callbackTarget) returns (bytes32)',
	'function destinationFeeBps(uint256 destinationChainId) view returns (uint256)',
] as const

const ERC20_APPROVE_ABI = [
	'function approve(address spender,uint256 amount) returns (bool)',
	'function allowance(address owner,address spender) view returns (uint256)',
	'function balanceOf(address account) view returns (uint256)',
] as const

const ASSET_MODE_LOCK_MINT = 1
const SHIFT_POLL_MS = 300
const SHIFT_MAX_WAIT_MS = 120_000

async function shiftSettleConetForWrite(logTag: string): Promise<SettleContractPoolEntry> {
	const deadline = Date.now() + SHIFT_MAX_WAIT_MS
	while (Date.now() < deadline) {
		const SC = shiftSettleConet()
		if (SC) return SC
		await new Promise((r) => setTimeout(r, SHIFT_POLL_MS))
	}
	throw new Error(`${logTag}: Settle_ConetPool busy`)
}

function computeLockMintOperationId(params: {
	sourceChainId: bigint
	destinationChainId: bigint
	sourceTreasury: string
	sourceAsset: string
	destinationAsset: string
	beneficiaries: string[]
	amounts: bigint[]
	grossAmount: bigint
	feeAmount: bigint
	sourceTxHash: string
	nonce: bigint
	callbackTarget: string
}): string {
	const coder = ethers.AbiCoder.defaultAbiCoder()
	const beneficiariesHash = ethers.keccak256(
		coder.encode(['address[]', 'uint256[]'], [params.beneficiaries, params.amounts]),
	)
	return ethers.keccak256(
		coder.encode(
			[
				'uint256',
				'uint256',
				'address',
				'address',
				'address',
				'bytes32',
				'uint8',
				'uint256',
				'uint256',
				'bytes32',
				'uint256',
				'address',
			],
			[
				params.sourceChainId,
				params.destinationChainId,
				params.sourceTreasury,
				params.sourceAsset,
				params.destinationAsset,
				beneficiariesHash,
				ASSET_MODE_LOCK_MINT,
				params.grossAmount,
				params.feeAmount,
				params.sourceTxHash,
				params.nonce,
				params.callbackTarget,
			],
		),
	)
}

export type TreasuryBridgeFulfillPayload = {
	cardAddress: string
	cardOwner: string
	recipientEOA: string
	points6: string
	payer?: string
	USDC_tx: string
	usdcAmount6: string
	currency?: string
	currencyAmount?: string
	membershipFeeStage?: NfcTopupMembershipFeeStage
	res?: Response
}

type TreasuryBridgeFulfillRecord = {
	cardAddress: string
	cardOwner: string
	recipientEOA: string
	payer: string
	USDC_tx: string
	usdcAmount6: string
	points6: string
	operationId: string
	lockMintTxHash: string
	mintTxHash?: string
	fulfilledAt: string
}

export const treasuryBridgeFulfillPool: TreasuryBridgeFulfillPayload[] = []

function resolveFulfillFile(): string {
	return (
		process.env.CONET_TREASURY_BRIDGE_FULFILL_FILE?.trim() ||
		path.join(homedir(), '.conet-treasury-bridge-fulfill.json')
	)
}

function readFulfillFile(): Record<string, TreasuryBridgeFulfillRecord> {
	const file = resolveFulfillFile()
	if (!fs.existsSync(file)) return {}
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, TreasuryBridgeFulfillRecord>
	} catch {
		return {}
	}
}

function writeFulfillRecord(record: TreasuryBridgeFulfillRecord): void {
	const file = resolveFulfillFile()
	const all = readFulfillFile()
	all[record.USDC_tx.toLowerCase()] = record
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf-8')
}

function lookupFulfill(usdcTx: string): TreasuryBridgeFulfillRecord | null {
	const key = usdcTx.trim().toLowerCase()
	if (!key) return null
	return readFulfillFile()[key] || null
}

export function kickTreasuryBridgeFulfillPoolPress(): void {
	void treasuryBridgeFulfillProcess().catch((e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red('[treasuryBridgeFulfillProcess] kick error:'), msg)
	})
}

function scheduleTreasuryBridgeFulfillPoolPress(): void {
	if (treasuryBridgeFulfillPool.length === 0) return
	if (hasIdleGenesisInitiatorBase()) kickTreasuryBridgeFulfillPoolPress()
	else setTimeout(() => kickTreasuryBridgeFulfillPoolPress(), 3000)
}

export const treasuryBridgeFulfillProcess = async () => {
	const obj = treasuryBridgeFulfillPool.shift()
	if (!obj) return
	if (!hasIdleGenesisInitiatorBase()) {
		treasuryBridgeFulfillPool.unshift(obj)
		return setTimeout(() => void treasuryBridgeFulfillProcess(), 3000)
	}

	const usdcTx = String(obj.USDC_tx ?? '').trim()
	try {
		if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) throw new Error('Invalid USDC_tx')
		if (!ethers.isAddress(obj.cardAddress)) throw new Error('Invalid cardAddress')
		if (!ethers.isAddress(obj.cardOwner)) throw new Error('Invalid cardOwner')
		if (!ethers.isAddress(obj.recipientEOA)) throw new Error('Invalid recipientEOA')
		const lockAmount = BigInt(String(obj.usdcAmount6 ?? '0'))
		if (lockAmount <= 0n) throw new Error('Invalid usdcAmount6')
		const points6 = BigInt(String(obj.points6 ?? '0'))
		if (points6 <= 0n) throw new Error('Invalid points6')

		const cardAddress = ethers.getAddress(obj.cardAddress)
		const cardOwner = ethers.getAddress(obj.cardOwner)
		const recipientEOA = ethers.getAddress(obj.recipientEOA)

		const existing = lookupFulfill(usdcTx)
		if (existing?.mintTxHash) {
			logger(
				Colors.cyan(
					`[treasuryBridgeFulfill] idempotent hit USDC_tx=${usdcTx.slice(0, 12)}… mint=${existing.mintTxHash.slice(0, 12)}…`,
				),
			)
			if (obj.res && !obj.res.headersSent) {
				obj.res
					.status(200)
					.json({
						success: true,
						idempotent: true,
						USDC_tx: existing.USDC_tx,
						lockMintTxHash: existing.lockMintTxHash,
						mintTxHash: existing.mintTxHash,
					})
					.end()
			}
			return
		}

		let lockMintTxHash = existing?.lockMintTxHash
		let operationId = existing?.operationId
		if (!lockMintTxHash || !operationId) {
			const treasury = ethers.getAddress(CONET_TREASURY)
			const sourceTxHash = usdcTx as `0x${string}`
			const nonce = BigInt(ethers.hexlify(ethers.randomBytes(16)))
			const bridgeResult = await withGenesisBridgeInitiatorBase(async (sc) => {
				const baseProvider = sc.walletBase.provider!
				const treasuryRead = new ethers.Contract(treasury, TREASURY_LOCK_MINT_ABI, baseProvider)
				const feeBps = (await treasuryRead.destinationFeeBps!(CONET_MAINNET_CHAIN_ID)) as bigint
				const feeAmount = (lockAmount * feeBps) / 10_000n
				const beneficiaries = [cardOwner]
				const amounts = [lockAmount]
				const opId = computeLockMintOperationId({
					sourceChainId: 8453n,
					destinationChainId: BigInt(CONET_MAINNET_CHAIN_ID),
					sourceTreasury: treasury,
					sourceAsset: ethers.getAddress(USDC_BASE),
					destinationAsset: ethers.getAddress(CONET_USDC),
					beneficiaries,
					amounts,
					grossAmount: lockAmount,
					feeAmount,
					sourceTxHash,
					nonce,
					callbackTarget: ethers.ZeroAddress,
				})
				const usdc = new ethers.Contract(USDC_BASE, ERC20_APPROVE_ABI, sc.walletBase)
				const needApprove = lockAmount + feeAmount
				const bal = (await usdc.balanceOf!(sc.walletBase.address)) as bigint
				if (bal < needApprove) {
					throw new Error(
						`Bridge initiator USDC balance ${bal.toString()} < required ${needApprove.toString()}`,
					)
				}
				const allowance = (await usdc.allowance!(sc.walletBase.address, treasury)) as bigint
				if (allowance < needApprove) {
					const approveTx = await usdc.approve!(treasury, needApprove)
					await approveTx.wait()
				}
				const treasuryWrite = new ethers.Contract(treasury, TREASURY_LOCK_MINT_ABI, sc.walletBase)
				const mintTx = await treasuryWrite.initiateLockMint!(
					CONET_MAINNET_CHAIN_ID,
					ethers.getAddress(USDC_BASE),
					ethers.getAddress(CONET_USDC),
					beneficiaries,
					amounts,
					sourceTxHash,
					nonce,
					ethers.ZeroAddress,
					{ gasLimit: 500_000 },
				)
				const mintReceipt = await mintTx.wait()
				if (mintReceipt?.status !== 1) throw new Error('initiateLockMint reverted')
				return { operationId: opId, lockMintTxHash: mintTx.hash as string }
			})
			lockMintTxHash = bridgeResult.lockMintTxHash
			operationId = bridgeResult.operationId
			writeFulfillRecord({
				cardAddress,
				cardOwner,
				recipientEOA,
				payer: ethers.isAddress(obj.payer) ? ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
				USDC_tx: usdcTx,
				usdcAmount6: lockAmount.toString(),
				points6: points6.toString(),
				operationId,
				lockMintTxHash,
				fulfilledAt: new Date().toISOString(),
			})
			logger(
				Colors.green(
					`[treasuryBridgeFulfill] LockMint OK USDC_tx=${usdcTx.slice(0, 12)}… owner=${cardOwner.slice(0, 10)}… lockMint=${lockMintTxHash.slice(0, 12)}…`,
				),
			)
		}

		const SC = await shiftSettleConetForWrite('treasuryBridgeFulfill.mint')
		let mintTxHash = ''
		try {
			const stage = obj.membershipFeeStage
			if (stage) {
				const stageRecipient = ethers.getAddress(stage.recipientEOA)
				if (stageRecipient.toLowerCase() !== recipientEOA.toLowerCase()) {
					throw new Error('membershipFeeStage recipient mismatch with treasuryBridge mint')
				}
				if (stage.pointsCredit6 !== points6) {
					throw new Error('membershipFeeStage pointsCredit6 mismatch with treasuryBridge points6')
				}
				const stageIface = new ethers.Interface([
					'function stageMembershipFeePurchase(address user, uint256 tierIndex, uint256 feePaid6, uint256 pointsCredit6)',
					'function stageMembershipFeePurchaseWithBootstrap(address user, uint256 tierIndex, uint256 feePaid6, uint256 pointsCredit6, uint8 durationKind)',
				])
				const useBootstrap = Boolean(stage.bootstrapOnChain)
				const stageCallData = useBootstrap
					? stageIface.encodeFunctionData('stageMembershipFeePurchaseWithBootstrap', [
							stageRecipient,
							BigInt(stage.tierIndex),
							stage.feePaid6,
							stage.pointsCredit6,
							Number(stage.durationKind ?? 0),
						])
					: stageIface.encodeFunctionData('stageMembershipFeePurchase', [
							stageRecipient,
							BigInt(stage.tierIndex),
							stage.feePaid6,
							stage.pointsCredit6,
						])
				const stageChain = await resolveUserCardChain(cardAddress)
				const stageTx = await relayUserCardCallViaEntryPoint({
					SC,
					chain: stageChain,
					cardAddress,
					cardCallData: stageCallData,
					logTag: useBootstrap
						? 'treasuryBridgeFulfill:stageMembershipFeePurchaseWithBootstrap'
						: 'treasuryBridgeFulfill:stageMembershipFeePurchase',
				})
				const stageReceipt = await stageTx.wait()
				const stageOk = checkBusinessRelayTxSuccessful(stageReceipt ?? undefined, {
					logTag: useBootstrap
						? 'treasuryBridgeFulfill:stageMembershipFeePurchaseWithBootstrap'
						: 'treasuryBridgeFulfill:stageMembershipFeePurchase',
				})
				if (!stageOk.ok) {
					throw new Error(
						`${useBootstrap ? 'stageMembershipFeePurchaseWithBootstrap' : 'stageMembershipFeePurchase'} failed on-chain: ${stageTx.hash} (${stageOk.reason})`,
					)
				}
				logger(
					Colors.cyan(
						`[treasuryBridgeFulfill] ${useBootstrap ? 'stageMembershipFeePurchaseWithBootstrap' : 'stageMembershipFeePurchase'} tx=${stageTx.hash} tier=${stage.tierIndex} fee6=${stage.feePaid6} points6=${stage.pointsCredit6} user=${stageRecipient}`,
					),
				)
			}
			const { mintTx } = await mintPointsForProtocolUsdcSettlementViaEntryPoint({
				cardAddress,
				recipientEOA,
				points6,
				SC,
				logTag: 'treasuryBridgeFulfill.mint',
			})
			const mintReceipt = await mintTx.wait().catch(() => null)
			const mintCheck = checkBusinessRelayTxSuccessful(mintReceipt ?? undefined, {
				logTag: 'treasuryBridgeFulfill.mint',
			})
			if (!mintCheck.ok) {
				throw new Error(`protocol mint failed: ${mintTx.hash} (${mintCheck.reason})`)
			}
			mintTxHash = mintTx.hash
			logger(
				Colors.green(
					`[treasuryBridgeFulfill] protocol mint OK card=${cardAddress.slice(0, 10)}… recipient=${recipientEOA.slice(0, 10)}… points6=${points6} mint=${mintTxHash.slice(0, 12)}…`,
				),
			)
		} finally {
			unshiftSettleConet(SC)
		}

		writeFulfillRecord({
			cardAddress,
			cardOwner,
			recipientEOA,
			payer: ethers.isAddress(obj.payer) ? ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
			USDC_tx: usdcTx,
			usdcAmount6: lockAmount.toString(),
			points6: points6.toString(),
			operationId: operationId!,
			lockMintTxHash: lockMintTxHash!,
			mintTxHash,
			fulfilledAt: new Date().toISOString(),
		})

		void consumeTreasuryBridgeBunitInBackground({
			cardAddress,
			cardOwner,
			USDC_tx: usdcTx,
		}).catch((e: unknown) => {
			const msg = e instanceof Error ? e.message : String(e)
			logger(Colors.yellow(`[treasuryBridgeFulfill] B-Unit background: ${msg}`))
		})

		void insertMemberTopupEvent({
			cardAddress,
			baseTxHash: mintTxHash,
			memberEoa: recipientEOA,
			memberAa: recipientEOA,
			tierTokenId: '0',
			topupSource: 'usdcPurchasingCard',
			topupCategory: 'usdcTopupCard',
			pointsE6: points6,
			usdcE6: lockAmount,
			originatingUsdcTx: usdcTx,
		}).catch((e: unknown) => {
			const msg = e instanceof Error ? e.message : String(e)
			logger(Colors.yellow(`[treasuryBridgeFulfill] insertMemberTopupEvent: ${msg}`))
		})

		if (obj.res && !obj.res.headersSent) {
			obj.res
				.status(200)
				.json({
					success: true,
					USDC_tx: usdcTx,
					operationId,
					lockMintTxHash,
					mintTxHash,
					cardOwner,
					recipientEOA,
					points6: points6.toString(),
				})
				.end()
		}
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		if (String(msg).includes('GENESIS_BRIDGE_INITIATOR_BASE_BUSY')) {
			treasuryBridgeFulfillPool.unshift(obj)
			return
		}
		logger(Colors.red('[treasuryBridgeFulfillProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		scheduleTreasuryBridgeFulfillPoolPress()
	}
}

async function consumeTreasuryBridgeBunitInBackground(args: {
	cardAddress: string
	cardOwner: string
	USDC_tx: string
}): Promise<void> {
	const { feeBUnits6 } = calcTopupFixedBUnitFee()
	if (feeBUnits6 <= 0n) return
	const provider = Settle_ContractPool[0]?.walletConet?.provider
	if (!provider) return
	const ownerResolved = await resolveCardOwnerToEOA(provider, args.cardOwner)
	const feePayer = ownerResolved.success ? ownerResolved.cardOwner : ethers.getAddress(args.cardOwner)
	const SC = await shiftSettleConetForWrite('treasuryBridgeFulfill.bunit')
	try {
		const bunit = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
			SC.walletConet,
		)
		const baseHash = args.USDC_tx as `0x${string}`
		const consumeTx = await bunit.consumeFromUser(feePayer, feeBUnits6, baseHash, 0n, 2n, {
			gasLimit: 2_500_000,
		})
		await consumeTx.wait()
		logger(
			Colors.cyan(
				`[treasuryBridgeFulfill] consumeFromUser ok: ${Number(feeBUnits6) / 1e6} B-Units from ${feePayer} base=${args.USDC_tx.slice(0, 12)}…`,
			),
		)
	} finally {
		unshiftSettleConet(SC)
	}
}
