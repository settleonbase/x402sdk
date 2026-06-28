import { ethers } from 'ethers'
import type { Response } from 'express'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { masterSetup, resolveBeamioConetHttpRpcUrl } from '../util'
import {
	CONET_DEPOSIT_CONTRACT,
	CONET_MAINNET_CHAIN_ID,
	CONET_VALIDATOR_DEPOSIT_FUNDER,
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK,
	CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN,
	CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN,
	CONET_VALIDATOR_NODE_IP,
	CONET_VALIDATOR_NODE_REWARD_INDEXER,
	CONET_VALIDATOR_REFERRER_EXTENSION,
	CONET_GUARDIAN_NODES_INFO_V6,
} from '../chainAddresses'
import { Settle_ContractPool, ensureSettleContractPoolInitialized } from '../settleContractPool'

ensureSettleContractPoolInitialized()

const VALIDATOR_REDEEM_VERSION = 'validator-deposit-redeem-v1'
const VALIDATOR_STAKE_WEI = 32n * 10n ** 18n
const MAX_REDEEM_CODE_BYTES = 512
const MAX_IP_BYTES = 64
const DEFAULT_NEW_CONET_DIR = '/Users/peter/Downloads/seguro-pro/CoNET-DL-master/newCoNET'

const VALIDATOR_DEPOSIT_REDEEM_ABI = [
	'event ValidatorRedeemClaimed(bytes32 indexed requestId, bytes32 indexed codeHash, address indexed claimer, address beneficiary, uint256 validatorCount, string targetNodeIp, string[] conetDepinNodeIps, uint256 gbMiningNodeCount)',
	'function createRedeemFor(address admin, bytes32 codeHash, address allowedClaimer, address referrer, uint256 validatorCount, string targetNodeIp, uint256 gbMiningNodeCount, uint256 validAfter, uint256 validBefore, uint256 nonce, uint256 deadline, bytes signature) external',
	'function cancelRedeemFor(address admin, bytes32 codeHash, uint256 nonce, uint256 deadline, bytes signature) external',
	'function claimRedeemFor(address claimer, address beneficiary, string code, uint256 deadline, bytes signature) external returns (bytes32)',
	'function referrerExtension() view returns (address)',
	'function grantReferrerRewardNodes(address referrer, uint256 count) external',
	'function getReferrerRewardNodes(address referrer) view returns (uint256[] guardianNodeIds, address[] nodeWallets, string[] depinNodeIps)',
	'function redeemAdminNonces(address account) view returns (uint256)',
	'function redeemAdmins(address account) view returns (bool)',
	'function admins(address account) view returns (bool)',
	'function getRedeem(bytes32 codeHash) view returns (address allowedClaimer, address referrer, uint256 validatorCount, string targetNodeIp, uint256 gbMiningNodeCount, uint64 validAfter, uint64 validBefore, bool active, bool consumed)',
	'function registerNodeValidators(address[] nodeWallets, bytes[] pubkeys) external',
	'function getNodeValidator(address nodeWallet) view returns (bytes pubkey, address withdrawalBeneficiary, uint64 registeredAt, uint64 exitedAt, bool active)',
	'function getBeneficiaryNodeBundle(address beneficiary) view returns (tuple(address beneficiary, uint256[] guardianNodeIds, string[] depinNodeIps, address[] nodeWallets, bytes[] validatorPubkeys, bool[] validatorActive, uint256 validatorNodeCount, uint256 gbMiningNodeCount, uint256 claimCount, uint256 nativeBalance, uint256 gbBalance, uint256 usdcBalance))',
	'function resolveNodeBundle(address maybeWallet, string conetDepinNodeIp) view returns (tuple(address beneficiary, uint256[] guardianNodeIds, string[] depinNodeIps, address[] nodeWallets, bytes[] validatorPubkeys, bool[] validatorActive, uint256 validatorNodeCount, uint256 gbMiningNodeCount, uint256 claimCount, uint256 nativeBalance, uint256 gbBalance, uint256 usdcBalance))',
	'function resolveUnifiedIncomeStats(address maybeWallet, string conetDepinNodeIp, uint256 anchorTs) view returns (tuple(address beneficiary, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) gbBeneficiary, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) cnetBeneficiary, tuple(address nodeWallet, string depinNodeIp, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) gb, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) cnet)[] nodes))',
	'function transferNodes(address fromBeneficiary, address toBeneficiary, address[] nodeWallets, uint256 nonce, uint256 deadline, bytes signature) external',
	'function getTransferNodesDigest(address fromBeneficiary, address toBeneficiary, address[] nodeWallets, uint256 nonce, uint256 deadline) view returns (bytes32)',
	'function beneficiaryNonces(address account) view returns (uint256)',
	'function getBeneficiaryByNodeWallet(address nodeWallet) view returns (address beneficiary)',
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (address nodeWallet)',
	'function createTransferOrder(address seller, address[] nodeWallets, uint256 priceUsdc6, uint256 nonce, uint256 deadline, bytes signature) external returns (uint256 orderId)',
	'function cancelTransferOrder(uint256 orderId, address seller, uint256 nonce, uint256 deadline, bytes signature) external',
	'function fulfillTransferOrder(uint256 orderId, address buyer, uint256 nonce, uint256 deadline, bytes signature, uint256 payValidAfter, uint256 payValidBefore, bytes32 payNonce, bytes paySignature) external',
	'function getTransferOrder(uint256 orderId) view returns (address seller, address[] nodeWallets, uint256 priceUsdc6, bool active, address buyer, uint64 createdAt, uint64 filledAt)',
	'function nodeOrder(address nodeWallet) view returns (uint256)',
	'function usdcToken() view returns (address)',
	'function setDepositContract(address depositContract_) external',
	'function depositContract() view returns (address)',
	'function selfWithdrawalCredentials() view returns (bytes32)',
	'function stakedValidatorCountOf(address beneficiary) view returns (uint256)',
	'function fundedDepositTotal() view returns (uint256)',
	'function exitSettledPubkey(bytes32 pubkeyHash) view returns (bool)',
	'function fundAndDepositValidators(address[] nodeWallets, bytes[] pubkeys, bytes[] withdrawalCredentials, bytes[] signatures, bytes32[] depositDataRoots) external',
	'function requestFullExit(address beneficiary, address[] nodeWallets, uint256 nonce, uint256 deadline, bytes signature) external',
	'function settleFullExitPayout(address beneficiary, address[] nodeWallets) external',
	'function getRequestFullExitDigest(address beneficiary, address[] nodeWallets, uint256 nonce, uint256 deadline) view returns (bytes32)',
	'function rewardIndexer() view returns (address)',
	'function getClaimRedeemDigest(address claimer, bytes32 codeHash, address beneficiary, uint256 deadline) view returns (bytes32)',
	'function nextGuardianAllocId() view returns (uint256)',
	'function guardianAllocStartId() view returns (uint256)',
	'function guardianIdBeneficiary(uint256 nodeId) view returns (address)',
	'function nodeWalletBeneficiary(address nodeWallet) view returns (address)',
	'function setRewardIndexer(address rewardIndexer_) external',
	'event RewardIndexerConfigured(address indexed rewardIndexer)',
	'event TransferOrderCreated(uint256 indexed orderId, address indexed seller, uint256 priceUsdc6, address[] nodeWallets)',
	'event TransferOrderCancelled(uint256 indexed orderId, address indexed seller)',
	'event TransferOrderFilled(uint256 indexed orderId, address indexed seller, address indexed buyer, uint256 priceUsdc6)',
	'event NodesTransferred(address indexed fromBeneficiary, address indexed toBeneficiary, address[] nodeWallets)',
	'event NodeValidatorBeneficiaryUpdated(address indexed nodeWallet, bytes32 indexed pubkeyHash, address indexed fromBeneficiary, address toBeneficiary)',
	'event ValidatorDeposited(address indexed nodeWallet, address indexed beneficiary, bytes32 indexed pubkeyHash, uint256 amount)',
	'event FullExitRequested(address indexed beneficiary, address[] nodeWallets)',
	'event FullExitSettled(address indexed beneficiary, uint256 validatorCount, uint256 amount)',
	// Retired (no longer emitted; kept for back-compat decoding of historical logs).
	'event NodeValidatorExitRequested(address indexed nodeWallet, bytes32 indexed pubkeyHash, address indexed fromBeneficiary, address toBeneficiary)',
] as const

const VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI = [
	'function REFERRER_NODES_PER_REWARD() view returns (uint256)',
	'function referrerOfBeneficiary(address beneficiary) view returns (address)',
	'function referrerReferralNodeTotal(address referrer) view returns (uint256)',
	'function referrerRewardMilestonePaid(address referrer) view returns (uint256)',
	'function getReferrerReferredBeneficiaryCount(address referrer) view returns (uint256)',
	'function getReferrerReferredBeneficiaries(address referrer, uint256 offset, uint256 limit) view returns (address[])',
	'function getReferrerSummary(address referrer) view returns (uint256 referredBeneficiaryCount, uint256 referralNodeTotal, uint256 rewardMilestonePaid, uint256 pendingRewardNodes, uint256 referredNodesOwnedTotal)',
	'function resolveReferrerDetail(address referrer, uint256 beneficiaryOffset, uint256 beneficiaryLimit) view returns (address[] referredBeneficiaries, uint256 referralNodeTotal, uint256 rewardNodesGranted, uint256 pendingRewardNodes, tuple(uint256 guardianNodeId, address nodeWallet, string depinNodeIp)[] rewardNodes)',
] as const

/**
 * ValidatorNodeRewardIndexer — standalone per-node / per-beneficiary hourly CNET reward ledger + period stats.
 * All reads here are RPC-direct (no centralized API), per the project RPC-first rule. The relayer write
 * (reportNodeRewardHourly) is the only gas-sponsored on-chain action and goes through a Settle wallet.
 */
const VALIDATOR_NODE_REWARD_INDEXER_ABI = [
	'function admins(address account) view returns (bool)',
	'function redeem() view returns (address)',
	'function reportNodeRewardHourly(address[] nodeWallets, uint256[] hourIds, uint256[] hourlyRewards) external',
	'function nodeHourlyReward(address nodeWallet, uint256 hourId) view returns (uint256)',
	'function beneficiaryHourlyReward(address beneficiary, uint256 hourId) view returns (uint256)',
	'function nodeCumulativeReward(address nodeWallet) view returns (uint256)',
	'function beneficiaryCumulativeReward(address beneficiary) view returns (uint256)',
	'function totalCumulativeReward() view returns (uint256)',
	'function nodeFirstHour(address nodeWallet) view returns (uint64)',
	'function nodeLastHour(address nodeWallet) view returns (uint64)',
	'function beneficiaryFirstHour(address beneficiary) view returns (uint64)',
	'function beneficiaryLastHour(address beneficiary) view returns (uint64)',
	'function getNodeRewardBetween(address nodeWallet, uint256 startTs, uint256 endTs) view returns (uint256)',
	'function getBeneficiaryRewardBetween(address beneficiary, uint256 startTs, uint256 endTs) view returns (uint256)',
	'function getNodePeriodReports(address nodeWallet, uint8 periodType, uint256 periods, uint256 anchorTs) view returns (tuple(uint256 periodStart, uint256 periodEnd, uint256 reward)[])',
	'function getBeneficiaryPeriodReports(address beneficiary, uint8 periodType, uint256 periods, uint256 anchorTs) view returns (tuple(uint256 periodStart, uint256 periodEnd, uint256 reward)[])',
	'function getNodeRewardSummary(address nodeWallet, uint256 anchorTs) view returns (uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year)',
	'function getBeneficiaryRewardSummary(address beneficiary, uint256 anchorTs) view returns (uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year)',
	'event NodeRewardHourSet(address indexed nodeWallet, address indexed beneficiary, uint256 indexed hourId, uint256 reward)',
] as const

/** Reward indexer period type ids (mirror ValidatorNodeRewardIndexer / AdminStatsPeriodLib). */
export const REWARD_PERIOD = { HOUR: 0, DAY: 1, WEEK: 2, MONTH: 3, QUARTER: 4, YEAR: 5 } as const
export type RewardPeriodType = (typeof REWARD_PERIOD)[keyof typeof REWARD_PERIOD]

export type ValidatorRedeemState = {
	requestId: string
	codeHash: string
	claimer: string
	beneficiary: string
	validatorCount: string
	targetNodeIp: string
	conetDepinNodeIps: string[]
	gbMiningNodeCount: string
	status: 'received' | 'running' | 'succeeded' | 'failed' | 'ignored'
	createdAt: string
	updatedAt: string
	error?: string
	stages: Record<string, { ok: boolean; at: string; detail?: string }>
	depositPrivateKeyFile?: string
	/** BLS pubkeys deployed in the claim's fund-and-deposit step (for register retry). */
	deployedPubkeys?: string[]
}

type StateFile = Record<string, ValidatorRedeemState>

let cachedConetProvider: ethers.JsonRpcProvider | undefined

/** CoNET JSON-RPC for listener + redeem paths; longer timeout + staticNetwork to survive public RPC blips. */
function conetProvider(): ethers.JsonRpcProvider {
	if (cachedConetProvider) return cachedConetProvider
	const url = resolveBeamioConetHttpRpcUrl()
	const fetchReq = new ethers.FetchRequest(url)
	const timeoutMs = Math.max(
		15_000,
		Number(process.env.CONET_RPC_HTTP_TIMEOUT_MS || 60_000) || 60_000
	)
	fetchReq.timeout = timeoutMs
	const network = ethers.Network.from(CONET_MAINNET_CHAIN_ID)
	const pollingInterval = Math.max(
		4_000,
		Number(process.env.CONET_LISTENER_POLLING_MS || 12_000) || 12_000
	)
	cachedConetProvider = new ethers.JsonRpcProvider(fetchReq, network, {
		staticNetwork: network,
		batchMaxCount: 1,
		pollingInterval,
	})
	return cachedConetProvider
}

function normalizeIp(raw: string): string {
	return raw.trim().toLowerCase()
}

function isValidIpLike(raw: string): boolean {
	const ip = normalizeIp(raw)
	if (!ip || ip.length > MAX_IP_BYTES) return false
	if (!/^[a-z0-9.:-]+$/.test(ip)) return false
	return true
}

function codeHashOf(code: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(code))
}

const GUARDIAN_NODES_ALLOC_ABI = [
	'function id2ip(uint256 id) view returns (string)',
	'function idOwner(uint256 id) view returns (address)',
	'function ipaddress2owner(string ip) view returns (address)',
	'function ipaddressExisting(string ip) view returns (bool)',
] as const

function formatEthersRevert(e: unknown): string {
	const err = e as { reason?: string; shortMessage?: string; message?: string }
	if (typeof err?.reason === 'string' && err.reason.trim()) return err.reason.trim()
	if (typeof err?.shortMessage === 'string' && err.shortMessage.trim()) return err.shortMessage.trim()
	if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim()
	return 'Claim would revert on-chain'
}

/** Mirrors on-chain guardian allocation checks before claimRedeemFor (RPC-direct). */
export async function validatorDepositRedeemClaimAllocationPreflight(
	beneficiary: string,
	validatorCount: bigint
): Promise<{ ok: true } | { ok: false; error: string }> {
	const redeemAddr = resolveValidatorDepositRedeemAddress()
	if (!redeemAddr) return { ok: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (validatorCount <= 0n) return { ok: true }

	const provider = conetProvider()
	const redeem = new ethers.Contract(redeemAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
	const guardian = new ethers.Contract(CONET_GUARDIAN_NODES_INFO_V6, GUARDIAN_NODES_ALLOC_ABI, provider)
	const ben = ethers.getAddress(beneficiary)

	let nextId = (await redeem.nextGuardianAllocId!()) as bigint
	const startId = (await redeem.guardianAllocStartId!()) as bigint

	for (let need = 0n; need < validatorCount; need++) {
		let resolved = false
		while (!resolved) {
			if (nextId < startId) {
				return { ok: false, error: 'Guardian allocation pool exhausted (before pool start id)' }
			}
			const idOwner = ethers.getAddress((await redeem.guardianIdBeneficiary!(nextId)) as string)
			if (idOwner !== ethers.ZeroAddress) {
				nextId++
				continue
			}
			const ip = String(await guardian.id2ip!(nextId))
			if (!ip || ip.length === 0) {
				return { ok: false, error: `Guardian node id ${nextId.toString()} has no IP` }
			}
			const ipOk = Boolean(await guardian.ipaddressExisting!(ip))
			if (!ipOk) {
				return { ok: false, error: `Guardian IP ${ip} is not registered on-chain` }
			}
			let nodeWallet = ethers.getAddress((await guardian.idOwner!(nextId)) as string)
			if (nodeWallet === ethers.ZeroAddress) {
				nodeWallet = ethers.getAddress((await guardian.ipaddress2owner!(ip)) as string)
			}
			if (nodeWallet === ethers.ZeroAddress) {
				return { ok: false, error: `Guardian node id ${nextId.toString()} has no operator wallet` }
			}
			const walletBen = ethers.getAddress((await redeem.nodeWalletBeneficiary!(nodeWallet)) as string)
			if (walletBen !== ethers.ZeroAddress && walletBen.toLowerCase() !== ben.toLowerCase()) {
				return {
					ok: false,
					error:
						'DePIN operator wallet is already bound to another beneficiary (ValidatorRedeem: node wallet other beneficiary). Redeploy ValidatorDepositRedeem with the shared-operator fix, or claim with the same beneficiary wallet as the prior claim.',
				}
			}
			resolved = true
			nextId++
		}
	}
	return { ok: true }
}

export function resolveValidatorDepositRedeemAddress(): string | null {
	const raw = process.env.CONET_VALIDATOR_DEPOSIT_REDEEM?.trim() || CONET_VALIDATOR_DEPOSIT_REDEEM
	if (!raw) return null
	try {
		const a = ethers.getAddress(raw)
		return a === ethers.ZeroAddress ? null : a
	} catch {
		return null
	}
}

/** Reads {referrerExtension} from env / chainAddresses, else main redeem contract (RPC-direct). */
export async function resolveValidatorReferrerExtensionAddress(): Promise<string | null> {
	const raw = process.env.CONET_VALIDATOR_REFERRER_EXTENSION?.trim() || CONET_VALIDATOR_REFERRER_EXTENSION
	if (raw) {
		try {
			const a = ethers.getAddress(raw)
			if (a !== ethers.ZeroAddress) return a
		} catch {
			/* fall through to on-chain lookup */
		}
	}
	const main = resolveValidatorDepositRedeemAddress()
	if (!main) return null
	try {
		const c = new ethers.Contract(main, ['function referrerExtension() view returns (address)'], conetProvider())
		const ext = ethers.getAddress(String(await c.referrerExtension!()))
		return ext === ethers.ZeroAddress ? null : ext
	} catch {
		return null
	}
}

/**
 * Resolve the ValidatorNodeRewardIndexer address. Prefers the explicit env / chainAddresses value; if unset,
 * reads it on-chain from the main ValidatorDepositRedeem contract's {rewardIndexer} pointer (RPC-direct).
 */
export async function resolveValidatorNodeRewardIndexerAddress(): Promise<string | null> {
	const raw = process.env.CONET_VALIDATOR_NODE_REWARD_INDEXER?.trim() || CONET_VALIDATOR_NODE_REWARD_INDEXER
	if (raw) {
		try {
			const a = ethers.getAddress(raw)
			if (a !== ethers.ZeroAddress) return a
		} catch {
			/* fall through to on-chain lookup */
		}
	}
	const main = resolveValidatorDepositRedeemAddress()
	if (!main) return null
	try {
		const c = new ethers.Contract(main, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
		const a = ethers.getAddress(await c.rewardIndexer())
		return a === ethers.ZeroAddress ? null : a
	} catch {
		return null
	}
}

// ---- ValidatorNodeRewardIndexer: RPC-direct reads + relayer write ------------------------------------

export type RewardSummary = {
	/** cumulative CNET reward since first reported hour (18-decimal string) */
	cumulative: string
	/** current hour bucket total */
	hour: string
	/** current UTC day total */
	day: string
	/** current ISO week (Mon-start) total */
	week: string
	/** current calendar month total */
	month: string
	/** current calendar year total */
	year: string
}

export type RewardPeriodReport = {
	/** inclusive unix start of the period (seconds) */
	periodStart: number
	/** inclusive unix end of the period (seconds) */
	periodEnd: number
	/** CNET reward summed over the period (18-decimal string) */
	reward: string
}

/** GB or CNET income bucket totals (18-decimal raw + formatted strings). */
export type IncomeTotals = {
	cumulative: string
	hour: string
	day: string
	week: string
	month: string
	year: string
}

export type NodeIncomeRow = {
	nodeWallet: string
	depinNodeIp: string
	gb: IncomeTotals
	cnet: IncomeTotals
}

/** Unified GB + CNET income snapshot from {resolveUnifiedIncomeStats}. */
export type UnifiedIncomeStats = {
	beneficiary: string | null
	gbBeneficiary: IncomeTotals
	cnetBeneficiary: IncomeTotals
	nodes: NodeIncomeRow[]
}

function incomeTotalsFromTuple(t: { cumulative: bigint; hour: bigint; day: bigint; week: bigint; month: bigint; year: bigint } | bigint[]): IncomeTotals {
	return rewardSummaryFromTuple(t)
}

function rewardSummaryFromTuple(t: { cumulative: bigint; hour: bigint; day: bigint; week: bigint; month: bigint; year: bigint } | bigint[]): RewardSummary {
	const v = (k: keyof RewardSummary, i: number): string =>
		((Array.isArray(t) ? t[i] : (t as Record<string, bigint>)[k]) ?? 0n).toString()
	return {
		cumulative: v('cumulative', 0),
		hour: v('hour', 1),
		day: v('day', 2),
		week: v('week', 3),
		month: v('month', 4),
		year: v('year', 5),
	}
}

function rewardPeriodReportsFromTuples(rows: Array<{ periodStart: bigint; periodEnd: bigint; reward: bigint } | bigint[]>): RewardPeriodReport[] {
	return (rows || []).map((r) => ({
		periodStart: Number(Array.isArray(r) ? r[0] : r.periodStart),
		periodEnd: Number(Array.isArray(r) ? r[1] : r.periodEnd),
		reward: (Array.isArray(r) ? r[2] : r.reward).toString(),
	}))
}

async function rewardIndexerReadContract(): Promise<{ ok: true; c: ethers.Contract; address: string } | { ok: false; error: string }> {
	const address = await resolveValidatorNodeRewardIndexerAddress()
	if (!address) return { ok: false as const, error: 'ValidatorNodeRewardIndexer not configured' }
	return { ok: true as const, c: new ethers.Contract(address, VALIDATOR_NODE_REWARD_INDEXER_ABI, conetProvider()), address }
}

/**
 * One-shot CNET reward summary for a BENEFICIARY across ALL its staked nodes (total income):
 * cumulative + current hour/day/week/month/year. RPC-direct, no centralized API.
 * @param anchorTs optional anchor unix seconds (0 / omit = now).
 */
export async function validatorRewardReadBeneficiarySummary(
	beneficiary: string,
	anchorTs = 0
): Promise<{ ok: true; beneficiary: string; summary: RewardSummary } | { ok: false; error: string }> {
	let addr: string
	try {
		addr = ethers.getAddress(beneficiary)
	} catch {
		return { ok: false as const, error: 'bad beneficiary address' }
	}
	const r = await rewardIndexerReadContract()
	if (!r.ok) return r
	try {
		const t = await r.c.getBeneficiaryRewardSummary!(addr, BigInt(anchorTs || 0))
		return { ok: true as const, beneficiary: addr, summary: rewardSummaryFromTuple(t) }
	} catch (ex) {
		return { ok: false as const, error: `reward summary read failed: ${(ex as Error).message}` }
	}
}

/** One-shot CNET reward summary for a single NODE wallet (per-node income). RPC-direct. */
export async function validatorRewardReadNodeSummary(
	nodeWallet: string,
	anchorTs = 0
): Promise<{ ok: true; nodeWallet: string; summary: RewardSummary } | { ok: false; error: string }> {
	let addr: string
	try {
		addr = ethers.getAddress(nodeWallet)
	} catch {
		return { ok: false as const, error: 'bad node wallet address' }
	}
	const r = await rewardIndexerReadContract()
	if (!r.ok) return r
	try {
		const t = await r.c.getNodeRewardSummary!(addr, BigInt(anchorTs || 0))
		return { ok: true as const, nodeWallet: addr, summary: rewardSummaryFromTuple(t) }
	} catch (ex) {
		return { ok: false as const, error: `node reward summary read failed: ${(ex as Error).message}` }
	}
}

/**
 * Single eth_call to ValidatorDepositRedeem.resolveUnifiedIncomeStats:
 * beneficiary GB (ConetGB1155) + CNET (ValidatorNodeRewardIndexer) totals and per-node rows.
 * Contract internally staticcalls gbToken + rewardIndexer — no centralized read API.
 */
export async function validatorDepositRedeemReadUnifiedIncomeStats(
	ipOrWallet: string,
	anchorTs = 0
): Promise<{ ok: true; query: string; stats: UnifiedIncomeStats } | { ok: false; error: string }> {
	const main = resolveValidatorDepositRedeemAddress()
	if (!main) return { ok: false as const, error: 'no validator redeem contract configured' }
	const raw = String(ipOrWallet ?? '').trim()
	if (!raw) return { ok: false as const, error: 'empty query' }
	const isAddr = ethers.isAddress(raw)
	const maybeWallet = isAddr ? ethers.getAddress(raw) : ethers.ZeroAddress
	const ip = isAddr ? '' : normalizeIp(raw)
	try {
		const c = new ethers.Contract(main, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
		const r = await c.resolveUnifiedIncomeStats!(maybeWallet, ip, BigInt(Math.max(0, anchorTs)))
		const beneficiaryAddr = ethers.getAddress(String(r.beneficiary ?? r[0]))
		const beneficiary = beneficiaryAddr === ethers.ZeroAddress ? null : beneficiaryAddr
		const gbBeneficiary = incomeTotalsFromTuple(r.gbBeneficiary ?? r[1])
		const cnetBeneficiary = incomeTotalsFromTuple(r.cnetBeneficiary ?? r[2])
		const nodeRows = (r.nodes ?? r[3] ?? []) as Array<Record<string, unknown> | unknown[]>
		const nodes: NodeIncomeRow[] = nodeRows.map((row) => {
			const nr = row as Record<string, unknown>
			const nArr = row as unknown[]
			const nGet = (name: string, idx: number): unknown => (nr[name] !== undefined ? nr[name] : nArr[idx])
			return {
				nodeWallet: ethers.getAddress(String(nGet('nodeWallet', 0))),
				depinNodeIp: normalizeIp(String(nGet('depinNodeIp', 1))),
				gb: incomeTotalsFromTuple(nGet('gb', 2) as bigint[]),
				cnet: incomeTotalsFromTuple(nGet('cnet', 3) as bigint[]),
			}
		})
		return { ok: true as const, query: raw, stats: { beneficiary, gbBeneficiary, cnetBeneficiary, nodes } }
	} catch (ex) {
		return { ok: false as const, error: `resolveUnifiedIncomeStats read failed: ${(ex as Error).message}` }
	}
}

export type ReferrerRewardNodeDetail = {
	guardianNodeId: string
	nodeWallet: string
	depinNodeIp: string
}

export type ReferrerDetail = {
	referrer: string
	referredBeneficiaries: string[]
	referralNodeTotal: string
	rewardNodesGranted: string
	pendingRewardNodes: string
	nodesPerReward: string
	rewardNodes: ReferrerRewardNodeDetail[]
}

function parseReferrerRewardNodeRows(raw: unknown): ReferrerRewardNodeDetail[] {
	if (!Array.isArray(raw)) return []
	return raw.map((row) => {
		const r = row as Record<string, unknown> | unknown[]
		const get = (name: string, idx: number): unknown =>
			r && typeof r === 'object' && !Array.isArray(r) && name in r ? (r as Record<string, unknown>)[name] : (r as unknown[])[idx]
		return {
			guardianNodeId: String(get('guardianNodeId', 0) ?? '0'),
			nodeWallet: ethers.getAddress(String(get('nodeWallet', 1))),
			depinNodeIp: normalizeIp(String(get('depinNodeIp', 2) ?? '')),
		}
	})
}

/** RPC-direct referrer detail (extension.resolveReferrerDetail + reward node rows from redeem host). */
export async function validatorDepositRedeemReadReferrerDetail(
	referrer: string,
	opts?: { beneficiaryOffset?: number; beneficiaryLimit?: number }
): Promise<{ ok: true; detail: ReferrerDetail } | { ok: false; error: string }> {
	const ext = await resolveValidatorReferrerExtensionAddress()
	if (!ext) return { ok: false as const, error: 'no validator referrer extension configured' }
	let addr: string
	try {
		addr = ethers.getAddress(referrer)
	} catch {
		return { ok: false as const, error: 'bad referrer address' }
	}
	const beneficiaryOffset = Math.max(0, opts?.beneficiaryOffset ?? 0)
	const beneficiaryLimit = Math.max(0, opts?.beneficiaryLimit ?? 0)
	try {
		const c = new ethers.Contract(ext, VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI, conetProvider())
		const [detail, nodesPerReward] = await Promise.all([
			c.resolveReferrerDetail!(addr, BigInt(beneficiaryOffset), BigInt(beneficiaryLimit)),
			c.REFERRER_NODES_PER_REWARD!(),
		])
		return {
			ok: true as const,
			detail: {
				referrer: addr,
				referredBeneficiaries: ((detail[0] as string[]) ?? []).map((a) => ethers.getAddress(a)),
				referralNodeTotal: (detail[1] as bigint).toString(),
				rewardNodesGranted: (detail[2] as bigint).toString(),
				pendingRewardNodes: (detail[3] as bigint).toString(),
				nodesPerReward: (nodesPerReward as bigint).toString(),
				rewardNodes: parseReferrerRewardNodeRows(detail[4]),
			},
		}
	} catch (ex) {
		return { ok: false as const, error: `referrer detail read failed: ${(ex as Error).message}` }
	}
}

export type ReferrerSummary = {
	referrer: string
	referredBeneficiaryCount: string
	referralNodeTotal: string
	rewardMilestonePaid: string
	pendingRewardNodes: string
	referredNodesOwnedTotal: string
	nodesPerReward: string
}

/** RPC-direct referrer dashboard (introduced wallets + node totals + reward progress). */
export async function validatorDepositRedeemReadReferrerSummary(
	referrer: string
): Promise<{ ok: true; summary: ReferrerSummary } | { ok: false; error: string }> {
	const ext = await resolveValidatorReferrerExtensionAddress()
	if (!ext) return { ok: false as const, error: 'no validator referrer extension configured' }
	let addr: string
	try {
		addr = ethers.getAddress(referrer)
	} catch {
		return { ok: false as const, error: 'bad referrer address' }
	}
	try {
		const c = new ethers.Contract(ext, VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI, conetProvider())
		const [summaryTuple, nodesPerReward] = await Promise.all([c.getReferrerSummary!(addr), c.REFERRER_NODES_PER_REWARD!()])
		const s = summaryTuple as bigint[]
		return {
			ok: true as const,
			summary: {
				referrer: addr,
				referredBeneficiaryCount: s[0].toString(),
				referralNodeTotal: s[1].toString(),
				rewardMilestonePaid: s[2].toString(),
				pendingRewardNodes: s[3].toString(),
				referredNodesOwnedTotal: s[4].toString(),
				nodesPerReward: (nodesPerReward as bigint).toString(),
			},
		}
	} catch (ex) {
		return { ok: false as const, error: `referrer summary read failed: ${(ex as Error).message}` }
	}
}

export async function validatorDepositRedeemReadReferrerReferredBeneficiaries(
	referrer: string,
	offset = 0,
	limit = 50
): Promise<{ ok: true; beneficiaries: string[] } | { ok: false; error: string }> {
	const ext = await resolveValidatorReferrerExtensionAddress()
	if (!ext) return { ok: false as const, error: 'no validator referrer extension configured' }
	let addr: string
	try {
		addr = ethers.getAddress(referrer)
	} catch {
		return { ok: false as const, error: 'bad referrer address' }
	}
	try {
		const c = new ethers.Contract(ext, VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI, conetProvider())
		const rows = (await c.getReferrerReferredBeneficiaries!(addr, BigInt(offset), BigInt(limit))) as string[]
		return { ok: true as const, beneficiaries: rows.map((a) => ethers.getAddress(a)) }
	} catch (ex) {
		return { ok: false as const, error: `referrer beneficiaries read failed: ${(ex as Error).message}` }
	}
}

/**
 * Beneficiary total income + a per-node breakdown in one call: resolves the beneficiary's node bundle from the
 * main contract, then fetches each node's CNET summary plus the beneficiary aggregate. RPC-direct.
 * @deprecated Prefer {validatorDepositRedeemReadUnifiedIncomeStats} for GB + CNET in one eth_call.
 */
export async function validatorRewardReadBeneficiaryWithNodes(
	beneficiary: string,
	anchorTs = 0
): Promise<
	| { ok: true; beneficiary: string; total: RewardSummary; nodes: Array<{ nodeWallet: string; depinNodeIp: string; summary: RewardSummary }> }
	| { ok: false; error: string }
> {
	let addr: string
	try {
		addr = ethers.getAddress(beneficiary)
	} catch {
		return { ok: false as const, error: 'bad beneficiary address' }
	}
	const main = resolveValidatorDepositRedeemAddress()
	if (!main) return { ok: false as const, error: 'no validator redeem contract configured' }
	const r = await rewardIndexerReadContract()
	if (!r.ok) return r
	try {
		const cMain = new ethers.Contract(main, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
		const bundle = await cMain.getBeneficiaryNodeBundle!(addr)
		const wallets = (bundle.nodeWallets as string[]) || []
		const ips = (bundle.depinNodeIps as string[]) || []
		const anchor = BigInt(anchorTs || 0)
		const total = rewardSummaryFromTuple(await r.c.getBeneficiaryRewardSummary!(addr, anchor))
		const nodes = await Promise.all(
			wallets.map(async (w, i) => {
				const nodeWallet = ethers.getAddress(w)
				const summary = rewardSummaryFromTuple(await r.c.getNodeRewardSummary!(nodeWallet, anchor))
				return { nodeWallet, depinNodeIp: normalizeIp(ips[i] || ''), summary }
			})
		)
		return { ok: true as const, beneficiary: addr, total, nodes }
	} catch (ex) {
		return { ok: false as const, error: `beneficiary reward breakdown read failed: ${(ex as Error).message}` }
	}
}

/** Period (hour/day/week/month/quarter/year) CNET reward series for a NODE, newest first. RPC-direct. */
export async function validatorRewardReadNodePeriods(
	nodeWallet: string,
	periodType: RewardPeriodType,
	periods: number,
	anchorTs = 0
): Promise<{ ok: true; nodeWallet: string; reports: RewardPeriodReport[] } | { ok: false; error: string }> {
	let addr: string
	try {
		addr = ethers.getAddress(nodeWallet)
	} catch {
		return { ok: false as const, error: 'bad node wallet address' }
	}
	const r = await rewardIndexerReadContract()
	if (!r.ok) return r
	try {
		const rows = await r.c.getNodePeriodReports!(addr, periodType, BigInt(periods), BigInt(anchorTs || 0))
		return { ok: true as const, nodeWallet: addr, reports: rewardPeriodReportsFromTuples(rows) }
	} catch (ex) {
		return { ok: false as const, error: `node period reports read failed: ${(ex as Error).message}` }
	}
}

/** Period CNET reward series for a BENEFICIARY (all nodes aggregated), newest first. RPC-direct. */
export async function validatorRewardReadBeneficiaryPeriods(
	beneficiary: string,
	periodType: RewardPeriodType,
	periods: number,
	anchorTs = 0
): Promise<{ ok: true; beneficiary: string; reports: RewardPeriodReport[] } | { ok: false; error: string }> {
	let addr: string
	try {
		addr = ethers.getAddress(beneficiary)
	} catch {
		return { ok: false as const, error: 'bad beneficiary address' }
	}
	const r = await rewardIndexerReadContract()
	if (!r.ok) return r
	try {
		const rows = await r.c.getBeneficiaryPeriodReports!(addr, periodType, BigInt(periods), BigInt(anchorTs || 0))
		return { ok: true as const, beneficiary: addr, reports: rewardPeriodReportsFromTuples(rows) }
	} catch (ex) {
		return { ok: false as const, error: `beneficiary period reports read failed: ${(ex as Error).message}` }
	}
}

/**
 * Relayer write: feed off-chain measured hourly CNET reward into the indexer (idempotent set-absolute per hour
 * bucket). Only a redeem admin in {Settle_ContractPool} pays CNET gas; this MOVES NO USER FUNDS. The contract
 * pins each (node, hour)'s beneficiary on first report so a later node transfer never re-attributes past hours.
 * @param entries parallel arrays: node wallet, UTC hourId (unix/3600), absolute CNET reward (18-decimal bigint/string).
 */
export async function validatorRewardReportHourly(
	entries: Array<{ nodeWallet: string; hourId: number | bigint; hourlyReward: bigint | string }>
): Promise<{ ok: true; txHash: string; count: number } | { ok: false; error: string }> {
	if (!entries.length) return { ok: false as const, error: 'empty entries' }
	const address = await resolveValidatorNodeRewardIndexerAddress()
	if (!address) return { ok: false as const, error: 'ValidatorNodeRewardIndexer not configured' }
	if (!Settle_ContractPool.length) return { ok: false as const, error: 'no relayer wallet available (Settle pool empty)' }

	let nodeWallets: string[]
	let hourIds: bigint[]
	let rewards: bigint[]
	try {
		nodeWallets = entries.map((e) => ethers.getAddress(e.nodeWallet))
		hourIds = entries.map((e) => BigInt(e.hourId))
		rewards = entries.map((e) => BigInt(e.hourlyReward))
	} catch (ex) {
		return { ok: false as const, error: `bad entry: ${(ex as Error).message}` }
	}

	const txHash = await withSettleWallet('validatorRewardReportHourly', async (sc) => {
		const c = new ethers.Contract(address, VALIDATOR_NODE_REWARD_INDEXER_ABI, sc.walletConet)
		const tx = await c.reportNodeRewardHourly!(nodeWallets, hourIds, rewards, { gasLimit: 4_000_000 })
		await tx.wait()
		return tx.hash as string
	})
	if (!txHash) return { ok: false as const, error: 'relayer submit failed' }
	return { ok: true as const, txHash, count: entries.length }
}

export function resolveValidatorNodeIp(): string {
	return normalizeIp(
		process.env.CONET_VALIDATOR_NODE_IP?.trim() ||
			masterSetup.validatorDeposit?.nodeIp?.trim() ||
			CONET_VALIDATOR_NODE_IP ||
			''
	)
}

function resolveNewCoNETDir(): string {
	return process.env.CONET_VALIDATOR_NEWCONET_DIR?.trim() || masterSetup.validatorDeposit?.newCoNETDir?.trim() || DEFAULT_NEW_CONET_DIR
}

function resolveStateFile(): string {
	return (
		process.env.CONET_VALIDATOR_REDEEM_STATE_FILE?.trim() ||
		masterSetup.validatorDeposit?.stateFile?.trim() ||
		path.join(homedir(), '.conet-validator-redeem-state.json')
	)
}

function resolveDepositPrivateKeyFile(): string {
	return (
		process.env.CONET_VALIDATOR_REDEEM_ADMIN_PRIVATE_KEY_FILE?.trim() ||
		process.env.CONET_VALIDATOR_DEPOSIT_PRIVATE_KEY_FILE?.trim() ||
		masterSetup.validatorDeposit?.privateKeyFile?.trim() ||
		''
	)
}

/** Prysm validator keystore password — same value used by deposit CLI on this node. */
function resolveKeystorePasswordFile(): string {
	return (
		process.env.CONET_VALIDATOR_KEYSTORE_PASSWORD_FILE?.trim() ||
		path.join(resolveNewCoNETDir(), 'secrets/validator_keystore_password.txt')
	)
}

function resolveKeystorePassword(): string {
	const inline = process.env.KEYSTORE_PASSWORD?.trim()
	if (inline) return inline
	const file = resolveKeystorePasswordFile()
	if (file && fs.existsSync(file)) {
		return fs.readFileSync(file, 'utf8').trim()
	}
	return ''
}

/** Prysm wallet password (distinct from validator keystore password on some nodes). */
function resolveWalletPasswordFile(): string {
	return (
		process.env.CONET_VALIDATOR_WALLET_PASSWORD_FILE?.trim() ||
		path.join(resolveNewCoNETDir(), 'secrets/prysm_wallet_password.txt')
	)
}

function resolveWalletPassword(): string {
	const inline = process.env.WALLET_PASSWORD?.trim()
	if (inline) return inline
	const file = resolveWalletPasswordFile()
	if (file && fs.existsSync(file)) {
		return fs.readFileSync(file, 'utf8').trim()
	}
	return ''
}

function loadRedeemAdminWallet(): ethers.Wallet {
	const file = resolveDepositPrivateKeyFile()
	if (!file || !fs.existsSync(file)) {
		throw new Error(
			'CONET_VALIDATOR_REDEEM_ADMIN_PRIVATE_KEY_FILE (or CONET_VALIDATOR_DEPOSIT_PRIVATE_KEY_FILE) missing; required for fundAndDepositValidators'
		)
	}
	const raw = fs.readFileSync(file, 'utf8').trim()
	const pk = raw.startsWith('0x') ? raw : `0x${raw}`
	const wallet = new ethers.Wallet(pk, conetProvider())
	if (wallet.address.toLowerCase() !== CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN.toLowerCase()) {
		throw new Error(
			`redeem admin key mismatch: expected ${CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN}, got ${wallet.address}`
		)
	}
	return wallet
}

function validatorDryRun(): boolean {
	const env = process.env.CONET_VALIDATOR_REDEEM_DRY_RUN?.trim().toLowerCase()
	if (env === '1' || env === 'true' || env === 'yes') return true
	if (env === '0' || env === 'false' || env === 'no') return false
	return Boolean(masterSetup.validatorDeposit?.dryRun)
}

function readStateFile(): StateFile {
	const file = resolveStateFile()
	if (!fs.existsSync(file)) return {}
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8')) as StateFile
	} catch {
		return {}
	}
}

function writeStateFile(state: StateFile): void {
	const file = resolveStateFile()
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

type ListenerBlockCheckpoint = {
	contractAddress: string
	lastProcessedBlock: number
	updatedAt: string
}

function resolveListenerBlockFile(): string {
	return (
		process.env.CONET_VALIDATOR_REDEEM_LISTENER_BLOCK_FILE?.trim() ||
		path.join(homedir(), '.conet-validator-redeem-listener-block.json')
	)
}

function loadListenerBlockCheckpoint(contract: string, deployFloor: number): number | null {
	const file = resolveListenerBlockFile()
	if (!fs.existsSync(file)) return null
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as ListenerBlockCheckpoint
		if (!raw?.contractAddress || typeof raw.lastProcessedBlock !== 'number') return null
		if (ethers.getAddress(raw.contractAddress).toLowerCase() !== ethers.getAddress(contract).toLowerCase()) {
			return null
		}
		const block = Math.floor(raw.lastProcessedBlock)
		if (block < deployFloor) {
			logger(
				Colors.yellow(
					`[validatorDepositRedeemListener] ignore checkpoint block ${block} < deployFloor ${deployFloor}`
				)
			)
			return null
		}
		return block
	} catch {
		return null
	}
}

function saveListenerBlockCheckpoint(contract: string, blockNumber: number): void {
	const file = resolveListenerBlockFile()
	const deployFloor = resolveListenerDeployBlockFloor()
	const block = Math.floor(blockNumber)
	if (block < deployFloor) return
	const prev = loadListenerBlockCheckpoint(contract, deployFloor)
	if (prev != null && block <= prev) return
	const payload: ListenerBlockCheckpoint = {
		contractAddress: ethers.getAddress(contract),
		lastProcessedBlock: block,
		updatedAt: new Date().toISOString(),
	}
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
}

function noteListenerBlock(contract: string, blockNumber: number): void {
	if (!Number.isFinite(blockNumber) || blockNumber < 0) return
	saveListenerBlockCheckpoint(contract, blockNumber)
}

/** Hard minimum block for eth_getLogs — never scan below ValidatorDepositRedeem deploy block. */
function resolveListenerDeployBlockFloor(): number {
	const env =
		process.env.CONET_VALIDATOR_REDEEM_LISTENER_DEPLOY_BLOCK?.trim() ||
		process.env.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK?.trim()
	if (env) {
		const n = Number(env)
		if (Number.isFinite(n) && n >= 0) return Math.floor(n)
		throw new Error(`invalid CONET_VALIDATOR_REDEEM_LISTENER_DEPLOY_BLOCK: ${env}`)
	}
	return CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK
}

/** Safety clamp when issuing getLogs only — routine resume cursor stays at last checkpoint + 1. */
function listenerBackfillFromBlock(requestedFrom: number, deployFloor: number): number {
	const from = Math.floor(requestedFrom)
	if (from < deployFloor) {
		logger(
			Colors.yellow(
				`[validatorDepositRedeemListener] backfill safety clamp ${from} -> ${deployFloor} (deploy floor)`
			)
		)
		return deployFloor
	}
	return from
}

function upsertState(requestId: string, update: (current?: ValidatorRedeemState) => ValidatorRedeemState): ValidatorRedeemState {
	const all = readStateFile()
	const next = update(all[requestId])
	all[requestId] = next
	writeStateFile(all)
	return next
}

export function getValidatorDepositRedeemStatus(requestId: string): ValidatorRedeemState | null {
	if (!ethers.isHexString(requestId, 32)) return null
	return readStateFile()[requestId.toLowerCase()] || null
}

export function validatorDepositRedeemConfig() {
	const contract = resolveValidatorDepositRedeemAddress()
	const nodeIp = resolveValidatorNodeIp()
	const privateKeyFile = resolveDepositPrivateKeyFile()
	return {
		success: true,
		version: VALIDATOR_REDEEM_VERSION,
		chainId: CONET_MAINNET_CHAIN_ID,
		contract,
		nodeIp,
		depositContract: CONET_DEPOSIT_CONTRACT,
		depositFunder: CONET_VALIDATOR_DEPOSIT_FUNDER,
		contractAdminAddress: CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN,
		redeemAdminAddress: CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN,
		depositMode: 'contract_balance_fundAndDepositValidators',
		newCoNETDir: resolveNewCoNETDir(),
		stateFile: resolveStateFile(),
		listenerBlockFile: resolveListenerBlockFile(),
		listenerDeployBlockFloor: resolveListenerDeployBlockFloor(),
		listenerLastProcessedBlock: contract ? loadListenerBlockCheckpoint(contract, resolveListenerDeployBlockFloor()) : null,
		dryRun: validatorDryRun(),
		depositPrivateKeyFileConfigured: Boolean(privateKeyFile),
		listenerEnabled: process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1',
	}
}

export function validatorDepositRedeemEip712Domain(verifyingContract: string) {
	return {
		name: 'ValidatorDepositRedeem',
		version: '1',
		chainId: CONET_MAINNET_CHAIN_ID,
		verifyingContract: ethers.getAddress(verifyingContract),
	} as const
}

export const validatorDepositRedeemCreateTypes: Record<string, { name: string; type: string }[]> = {
	CreateRedeem: [
		{ name: 'admin', type: 'address' },
		{ name: 'codeHash', type: 'bytes32' },
		{ name: 'allowedClaimer', type: 'address' },
		{ name: 'referrer', type: 'address' },
		{ name: 'validatorCount', type: 'uint256' },
		{ name: 'targetNodeIp', type: 'string' },
		{ name: 'gbMiningNodeCount', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorDepositRedeemCancelTypes: Record<string, { name: string; type: string }[]> = {
	CancelRedeem: [
		{ name: 'admin', type: 'address' },
		{ name: 'codeHash', type: 'bytes32' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorDepositRedeemClaimTypes: Record<string, { name: string; type: string }[]> = {
	ClaimRedeem: [
		{ name: 'claimer', type: 'address' },
		{ name: 'codeHash', type: 'bytes32' },
		{ name: 'beneficiary', type: 'address' },
		{ name: 'referrer', type: 'address' },
		{ name: 'validatorCount', type: 'uint256' },
		{ name: 'targetNodeIp', type: 'string' },
		{ name: 'gbMiningNodeCount', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorDepositRedeemTransferTypes: Record<string, { name: string; type: string }[]> = {
	TransferNodes: [
		{ name: 'fromBeneficiary', type: 'address' },
		{ name: 'toBeneficiary', type: 'address' },
		{ name: 'nodeWallets', type: 'address[]' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorCreateTransferOrderTypes: Record<string, { name: string; type: string }[]> = {
	CreateTransferOrder: [
		{ name: 'seller', type: 'address' },
		{ name: 'nodeWallets', type: 'address[]' },
		{ name: 'priceUsdc6', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorCancelTransferOrderTypes: Record<string, { name: string; type: string }[]> = {
	CancelTransferOrder: [
		{ name: 'seller', type: 'address' },
		{ name: 'orderId', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export const validatorFulfillTransferOrderTypes: Record<string, { name: string; type: string }[]> = {
	FulfillTransferOrder: [
		{ name: 'buyer', type: 'address' },
		{ name: 'orderId', type: 'uint256' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

/** CoNET-USDC（FactoryERC20 / EIP20Permit3009）EIP-3009 TransferWithAuthorization typed data. */
export const usdcTransferWithAuthorizationTypes: Record<string, { name: string; type: string }[]> = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export async function validatorDepositRedeemReadAdminNonce(adminAddress: string): Promise<{ ok: true; nonce: string } | { ok: false; error: string }> {
	const addr = resolveValidatorDepositRedeemAddress()
	if (!addr) return { ok: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!ethers.isAddress(adminAddress)) return { ok: false, error: 'Invalid admin' }
	const c = new ethers.Contract(addr, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	try {
		const n = await c.redeemAdminNonces!(ethers.getAddress(adminAddress))
		return { ok: true, nonce: (n as bigint).toString() }
	} catch (e: any) {
		return { ok: false, error: e?.shortMessage ?? e?.message ?? 'redeemAdminNonces failed' }
	}
}

// NOTE: 链上「节点档案 / 受益人反查」读路径已下沉到各客户端，直连 RPC（见 beamio-rpc-first-no-centralized-api.mdc）。
// 参考客户端实现：src/SilentPassUI/src/services/validatorWalletNodeProfile.ts（fetchValidatorWalletNodeProfile / fetchNodeBeneficiaryProfile）。
// x402sdk 仅保留「代付 gas 的链上写」路径（createRedeemFor / claimRedeemFor relay 等）。

function parseUintField(name: string, value: unknown): bigint | string {
	try {
		const n = BigInt(String(value ?? ''))
		if (n < 0n) return `${name} must be non-negative`
		return n
	} catch {
		return `Invalid ${name}`
	}
}

/** Cluster must reject expired EIP-712 deadlines before Master relay (matches on-chain `block.timestamp <= deadline`). */
function clusterRejectIfSignatureDeadlineExpired(deadline: bigint): { success: false; error: 'Signature expired' } | null {
	const now = BigInt(Math.floor(Date.now() / 1000))
	if (deadline < now) return { success: false, error: 'Signature expired' }
	return null
}

export async function validatorDepositRedeemCreateClusterPreCheck(body: {
	admin?: string
	codeHash?: string
	allowedClaimer?: string
	referrer?: string
	validatorCount?: unknown
	targetNodeIp?: string
	gbMiningNodeCount?: unknown
	validAfter?: unknown
	validBefore?: unknown
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.admin || !ethers.isAddress(body.admin)) return { success: false as const, error: 'Invalid admin' }
	const admin = ethers.getAddress(body.admin)
	const codeHash = typeof body.codeHash === 'string' && ethers.isHexString(body.codeHash, 32) ? body.codeHash : ''
	if (!codeHash) return { success: false as const, error: 'Invalid codeHash' }
	const allowedClaimer =
		typeof body.allowedClaimer === 'string' && body.allowedClaimer.trim()
			? ethers.getAddress(body.allowedClaimer)
			: ethers.ZeroAddress
	let referrer = ethers.ZeroAddress
	if (typeof body.referrer === 'string' && body.referrer.trim()) {
		if (!ethers.isAddress(body.referrer)) return { success: false as const, error: 'Invalid referrer' }
		referrer = ethers.getAddress(body.referrer)
	}
	const validatorCount = parseUintField('validatorCount', body.validatorCount)
	if (typeof validatorCount === 'string' || validatorCount <= 0n) return { success: false as const, error: typeof validatorCount === 'string' ? validatorCount : 'validatorCount must be positive' }
	const targetNodeIp = normalizeIp(body.targetNodeIp || '')
	if (!isValidIpLike(targetNodeIp)) return { success: false as const, error: 'Invalid targetNodeIp' }
	// All redeems auto-allocate Guardian nodes at claim time; no manual DePIN IP list is accepted.
	const gbMiningNodeCount = parseUintField('gbMiningNodeCount', body.gbMiningNodeCount ?? validatorCount.toString())
	if (typeof gbMiningNodeCount === 'string') return { success: false as const, error: gbMiningNodeCount }
	const validAfter = parseUintField('validAfter', body.validAfter ?? '0')
	const validBefore = parseUintField('validBefore', body.validBefore ?? '0')
	const nonce = parseUintField('nonce', body.nonce)
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof validAfter === 'string' || typeof validBefore === 'string' || typeof nonce === 'string' || typeof deadline === 'string') {
		return { success: false as const, error: 'Invalid time or nonce fields' }
	}
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }

	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const [isAdmin, chainNonce, referrerExt] = await Promise.all([
		read.redeemAdmins!(admin),
		read.redeemAdminNonces!(admin),
		referrer !== ethers.ZeroAddress ? read.referrerExtension!() : Promise.resolve(ethers.ZeroAddress),
	])
	if (!isAdmin) return { success: false as const, error: 'Not a redeem admin' }
	if ((chainNonce as bigint) !== nonce) return { success: false as const, error: 'Stale nonce; refresh and sign again' }
	const expiredCreate = clusterRejectIfSignatureDeadlineExpired(deadline)
	if (expiredCreate) return expiredCreate
	if (referrer !== ethers.ZeroAddress && ethers.getAddress(String(referrerExt)) === ethers.ZeroAddress) {
		return { success: false as const, error: 'Referrer extension not configured on chain' }
	}

	const message = {
		admin,
		codeHash,
		allowedClaimer,
		referrer,
		validatorCount,
		targetNodeIp,
		gbMiningNodeCount,
		validAfter,
		validBefore,
		nonce,
		deadline,
	}
	const recovered = ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), validatorDepositRedeemCreateTypes, message, signature)
	if (recovered.toLowerCase() !== admin.toLowerCase()) return { success: false as const, error: 'Signer is not admin' }
	return { success: true as const, preChecked: { contract, ...message, signature } }
}

export async function validatorDepositRedeemCancelClusterPreCheck(body: {
	admin?: string
	codeHash?: string
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.admin || !ethers.isAddress(body.admin)) return { success: false as const, error: 'Invalid admin' }
	const admin = ethers.getAddress(body.admin)
	const codeHash = typeof body.codeHash === 'string' && ethers.isHexString(body.codeHash, 32) ? body.codeHash : ''
	if (!codeHash) return { success: false as const, error: 'Invalid codeHash' }
	const nonce = parseUintField('nonce', body.nonce)
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof nonce === 'string' || typeof deadline === 'string') return { success: false as const, error: 'Invalid nonce or deadline' }
	const expiredCancel = clusterRejectIfSignatureDeadlineExpired(deadline)
	if (expiredCancel) return expiredCancel
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }
	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const [isAdmin, chainNonce] = await Promise.all([read.redeemAdmins!(admin), read.redeemAdminNonces!(admin)])
	if (!isAdmin) return { success: false as const, error: 'Not a redeem admin' }
	if ((chainNonce as bigint) !== nonce) return { success: false as const, error: 'Stale nonce; refresh and sign again' }
	const recovered = ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), validatorDepositRedeemCancelTypes, { admin, codeHash, nonce, deadline }, signature)
	if (recovered.toLowerCase() !== admin.toLowerCase()) return { success: false as const, error: 'Signer is not admin' }
	return { success: true as const, preChecked: { contract, admin, codeHash, nonce, deadline, signature } }
}

export async function validatorDepositRedeemClaimClusterPreCheck(body: {
	claimer?: string
	beneficiary?: string
	code?: string
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.claimer || !ethers.isAddress(body.claimer)) return { success: false as const, error: 'Invalid claimer' }
	if (!body.beneficiary || !ethers.isAddress(body.beneficiary)) return { success: false as const, error: 'Invalid beneficiary' }
	const claimer = ethers.getAddress(body.claimer)
	const beneficiary = ethers.getAddress(body.beneficiary)
	const code = typeof body.code === 'string' ? body.code : ''
	if (!code || ethers.toUtf8Bytes(code).length > MAX_REDEEM_CODE_BYTES) return { success: false as const, error: 'Invalid code' }
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof deadline === 'string') return { success: false as const, error: deadline }
	const expiredClaim = clusterRejectIfSignatureDeadlineExpired(deadline)
	if (expiredClaim) return expiredClaim
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }
	const codeHash = codeHashOf(code)
	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const redeem = await read.getRedeem!(codeHash)
	const allowedClaimer = ethers.getAddress(redeem[0])
	const referrer = ethers.getAddress(redeem[1])
	const validatorCount = redeem[2] as bigint
	const targetNodeIp = normalizeIp(redeem[3] as string)
	const gbMiningNodeCount = redeem[4] as bigint
	const active = Boolean(redeem[7])
	const consumed = Boolean(redeem[8])
	if (!active || consumed) return { success: false as const, error: 'Redeem not active' }
	if (allowedClaimer !== ethers.ZeroAddress && allowedClaimer.toLowerCase() !== claimer.toLowerCase()) {
		return { success: false as const, error: 'Claimer not allowed' }
	}
	if (referrer !== ethers.ZeroAddress && referrer.toLowerCase() === beneficiary.toLowerCase()) {
		return { success: false as const, error: 'Referrer cannot equal beneficiary' }
	}
	// DePIN node IPs are auto-allocated from Guardian on-chain at claim; nothing to verify here.
	const recovered = ethers.verifyTypedData(
		validatorDepositRedeemEip712Domain(contract),
		validatorDepositRedeemClaimTypes,
		{
			claimer,
			codeHash,
			beneficiary,
			referrer,
			validatorCount,
			targetNodeIp,
			gbMiningNodeCount,
			deadline,
		},
		signature
	)
	if (recovered.toLowerCase() !== claimer.toLowerCase()) return { success: false as const, error: 'Signer is not claimer' }

	const alloc = await validatorDepositRedeemClaimAllocationPreflight(beneficiary, validatorCount as bigint)
	if (!alloc.ok) return { success: false as const, error: alloc.error }

	try {
		await read.claimRedeemFor!.staticCall(claimer, beneficiary, code, deadline, signature)
	} catch (e: unknown) {
		return { success: false as const, error: formatEthersRevert(e) }
	}

	return { success: true as const, preChecked: { contract, claimer, beneficiary, referrer, code, deadline, signature } }
}

export async function validatorDepositRedeemTransferClusterPreCheck(body: {
	fromBeneficiary?: string
	toBeneficiary?: string
	nodeWallets?: unknown
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.fromBeneficiary || !ethers.isAddress(body.fromBeneficiary)) return { success: false as const, error: 'Invalid fromBeneficiary' }
	if (!body.toBeneficiary || !ethers.isAddress(body.toBeneficiary)) return { success: false as const, error: 'Invalid toBeneficiary' }
	const fromBeneficiary = ethers.getAddress(body.fromBeneficiary)
	const toBeneficiary = ethers.getAddress(body.toBeneficiary)
	if (fromBeneficiary.toLowerCase() === toBeneficiary.toLowerCase()) return { success: false as const, error: 'Same beneficiary' }
	if (!Array.isArray(body.nodeWallets) || body.nodeWallets.length === 0) return { success: false as const, error: 'Empty nodeWallets' }
	let nodeWallets: string[]
	try {
		nodeWallets = (body.nodeWallets as unknown[]).map((a) => ethers.getAddress(String(a)))
	} catch {
		return { success: false as const, error: 'Invalid nodeWallets' }
	}
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof deadline === 'string') return { success: false as const, error: deadline }
	const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline)
	if (expiredTransfer) return expiredTransfer
	const nonce = parseUintField('nonce', body.nonce)
	if (typeof nonce === 'string') return { success: false as const, error: nonce }
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }

	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const onchainNonce = (await read.beneficiaryNonces!(fromBeneficiary)) as bigint
	if (onchainNonce !== nonce) return { success: false as const, error: `Bad nonce (expected ${onchainNonce.toString()})` }

	// Every node must currently belong to fromBeneficiary (strict 1:1 ownership).
	for (const nodeWallet of nodeWallets) {
		const owner = ethers.getAddress(await read.getBeneficiaryByNodeWallet!(nodeWallet))
		if (owner.toLowerCase() !== fromBeneficiary.toLowerCase()) {
			return { success: false as const, error: `Node ${nodeWallet} not owned by fromBeneficiary` }
		}
	}

	const recovered = ethers.verifyTypedData(
		validatorDepositRedeemEip712Domain(contract),
		validatorDepositRedeemTransferTypes,
		{ fromBeneficiary, toBeneficiary, nodeWallets, nonce, deadline },
		signature
	)
	if (recovered.toLowerCase() !== fromBeneficiary.toLowerCase()) return { success: false as const, error: 'Signer is not fromBeneficiary' }

	return {
		success: true as const,
		preChecked: { contract, fromBeneficiary, toBeneficiary, nodeWallets, nonce, deadline, signature },
	}
}

export async function createTransferOrderClusterPreCheck(body: {
	seller?: string
	nodeWallets?: unknown
	priceUsdc6?: unknown
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.seller || !ethers.isAddress(body.seller)) return { success: false as const, error: 'Invalid seller' }
	const seller = ethers.getAddress(body.seller)
	if (!Array.isArray(body.nodeWallets) || body.nodeWallets.length === 0) return { success: false as const, error: 'Empty nodeWallets' }
	let nodeWallets: string[]
	try {
		nodeWallets = (body.nodeWallets as unknown[]).map((a) => ethers.getAddress(String(a)))
	} catch {
		return { success: false as const, error: 'Invalid nodeWallets' }
	}
	const priceUsdc6 = parseUintField('priceUsdc6', body.priceUsdc6)
	if (typeof priceUsdc6 === 'string') return { success: false as const, error: priceUsdc6 }
	if (priceUsdc6 <= 0n) return { success: false as const, error: 'Price must be > 0' }
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof deadline === 'string') return { success: false as const, error: deadline }
	const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline)
	if (expiredTransfer) return expiredTransfer
	const nonce = parseUintField('nonce', body.nonce)
	if (typeof nonce === 'string') return { success: false as const, error: nonce }
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }

	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const onchainNonce = (await read.beneficiaryNonces!(seller)) as bigint
	if (onchainNonce !== nonce) return { success: false as const, error: `Bad nonce (expected ${onchainNonce.toString()})` }
	for (const nodeWallet of nodeWallets) {
		const owner = ethers.getAddress(await read.getBeneficiaryByNodeWallet!(nodeWallet))
		if (owner.toLowerCase() !== seller.toLowerCase()) return { success: false as const, error: `Node ${nodeWallet} not owned by seller` }
		const listed = (await read.nodeOrder!(nodeWallet)) as bigint
		if (listed !== 0n) return { success: false as const, error: `Node ${nodeWallet} already listed (order ${listed.toString()})` }
	}
	const recovered = ethers.verifyTypedData(
		validatorDepositRedeemEip712Domain(contract),
		validatorCreateTransferOrderTypes,
		{ seller, nodeWallets, priceUsdc6, nonce, deadline },
		signature
	)
	if (recovered.toLowerCase() !== seller.toLowerCase()) return { success: false as const, error: 'Signer is not seller' }
	return { success: true as const, preChecked: { contract, seller, nodeWallets, priceUsdc6, nonce, deadline, signature } }
}

export async function cancelTransferOrderClusterPreCheck(body: {
	orderId?: unknown
	seller?: string
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.seller || !ethers.isAddress(body.seller)) return { success: false as const, error: 'Invalid seller' }
	const seller = ethers.getAddress(body.seller)
	const orderId = parseUintField('orderId', body.orderId)
	if (typeof orderId === 'string') return { success: false as const, error: orderId }
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof deadline === 'string') return { success: false as const, error: deadline }
	const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline)
	if (expiredTransfer) return expiredTransfer
	const nonce = parseUintField('nonce', body.nonce)
	if (typeof nonce === 'string') return { success: false as const, error: nonce }
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }

	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const order = await read.getTransferOrder!(orderId)
	if (!Boolean(order[3])) return { success: false as const, error: 'Order not active' }
	if (ethers.getAddress(order[0]).toLowerCase() !== seller.toLowerCase()) return { success: false as const, error: 'Not order seller' }
	const onchainNonce = (await read.beneficiaryNonces!(seller)) as bigint
	if (onchainNonce !== nonce) return { success: false as const, error: `Bad nonce (expected ${onchainNonce.toString()})` }
	const recovered = ethers.verifyTypedData(
		validatorDepositRedeemEip712Domain(contract),
		validatorCancelTransferOrderTypes,
		{ seller, orderId, nonce, deadline },
		signature
	)
	if (recovered.toLowerCase() !== seller.toLowerCase()) return { success: false as const, error: 'Signer is not seller' }
	return { success: true as const, preChecked: { contract, orderId, seller, nonce, deadline, signature } }
}

export async function fulfillTransferOrderClusterPreCheck(body: {
	orderId?: unknown
	buyer?: string
	nonce?: unknown
	deadline?: unknown
	signature?: unknown
	payValidAfter?: unknown
	payValidBefore?: unknown
	payNonce?: unknown
	paySignature?: unknown
}) {
	const contract = resolveValidatorDepositRedeemAddress()
	if (!contract) return { success: false as const, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' }
	if (!body.buyer || !ethers.isAddress(body.buyer)) return { success: false as const, error: 'Invalid buyer' }
	const buyer = ethers.getAddress(body.buyer)
	const orderId = parseUintField('orderId', body.orderId)
	if (typeof orderId === 'string') return { success: false as const, error: orderId }
	const deadline = parseUintField('deadline', body.deadline)
	if (typeof deadline === 'string') return { success: false as const, error: deadline }
	const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline)
	if (expiredTransfer) return expiredTransfer
	const nonce = parseUintField('nonce', body.nonce)
	if (typeof nonce === 'string') return { success: false as const, error: nonce }
	const signature = typeof body.signature === 'string' ? body.signature.trim() : ''
	if (!ethers.isHexString(signature) || ethers.dataLength(signature) < 64) return { success: false as const, error: 'Invalid signature' }

	// EIP-3009 payment authorization fields (zero-approve).
	const payValidAfter = parseUintField('payValidAfter', body.payValidAfter)
	if (typeof payValidAfter === 'string') return { success: false as const, error: payValidAfter }
	const payValidBefore = parseUintField('payValidBefore', body.payValidBefore)
	if (typeof payValidBefore === 'string') return { success: false as const, error: payValidBefore }
	const nowSec = BigInt(Math.floor(Date.now() / 1000))
	if (payValidBefore <= nowSec) return { success: false as const, error: 'Payment authorization expired' }
	const payNonce = typeof body.payNonce === 'string' ? body.payNonce.trim() : ''
	if (!ethers.isHexString(payNonce, 32)) return { success: false as const, error: 'Invalid payNonce' }
	const paySignature = typeof body.paySignature === 'string' ? body.paySignature.trim() : ''
	if (!ethers.isHexString(paySignature) || ethers.dataLength(paySignature) < 64) return { success: false as const, error: 'Invalid paySignature' }

	const read = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider())
	const order = await read.getTransferOrder!(orderId)
	if (!Boolean(order[3])) return { success: false as const, error: 'Order not active' }
	const seller = ethers.getAddress(order[0])
	const priceUsdc6 = order[2] as bigint
	if (seller.toLowerCase() === buyer.toLowerCase()) return { success: false as const, error: 'Buyer is seller' }
	const onchainNonce = (await read.beneficiaryNonces!(buyer)) as bigint
	if (onchainNonce !== nonce) return { success: false as const, error: `Bad nonce (expected ${onchainNonce.toString()})` }

	// Buyer must hold enough CoNET-USDC; with EIP-3009 no approve/allowance is required.
	const usdcAddr = ethers.getAddress(await read.usdcToken!())
	if (usdcAddr === ethers.ZeroAddress) return { success: false as const, error: 'USDC token unset' }
	const usdc = new ethers.Contract(
		usdcAddr,
		[
			'function balanceOf(address) view returns (uint256)',
			'function name() view returns (string)',
			'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
		],
		conetProvider()
	)
	const bal = (await usdc.balanceOf!(buyer)) as bigint
	if (bal < priceUsdc6) return { success: false as const, error: 'Insufficient CoNET-USDC balance' }
	const authUsed = (await usdc.authorizationState!(buyer, payNonce)) as boolean
	if (authUsed) return { success: false as const, error: 'Payment authorization already used' }

	// Verify the buyer's fulfill binding signature (ValidatorDepositRedeem domain).
	const recovered = ethers.verifyTypedData(
		validatorDepositRedeemEip712Domain(contract),
		validatorFulfillTransferOrderTypes,
		{ buyer, orderId, nonce, deadline },
		signature
	)
	if (recovered.toLowerCase() !== buyer.toLowerCase()) return { success: false as const, error: 'Signer is not buyer' }

	// Verify the EIP-3009 payment authorization (CoNET-USDC token domain): buyer -> seller priceUsdc6.
	const tokenName = (await usdc.name!()) as string
	const usdcDomain = { name: tokenName, version: '1', chainId: validatorDepositRedeemEip712Domain(contract).chainId, verifyingContract: usdcAddr }
	const payRecovered = ethers.verifyTypedData(
		usdcDomain,
		usdcTransferWithAuthorizationTypes,
		{ from: buyer, to: seller, value: priceUsdc6, validAfter: payValidAfter, validBefore: payValidBefore, nonce: payNonce },
		paySignature
	)
	if (payRecovered.toLowerCase() !== buyer.toLowerCase()) return { success: false as const, error: 'Payment signer is not buyer' }

	return {
		success: true as const,
		preChecked: { contract, orderId, buyer, nonce, deadline, signature, payValidAfter, payValidBefore, payNonce, paySignature },
	}
}

export type ValidatorDepositRedeemCreatePayload = {
	contract: string
	admin: string
	codeHash: string
	allowedClaimer: string
	referrer: string
	validatorCount: bigint
	targetNodeIp: string
	gbMiningNodeCount: bigint
	validAfter: bigint
	validBefore: bigint
	nonce: bigint
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorDepositRedeemCancelPayload = {
	contract: string
	admin: string
	codeHash: string
	nonce: bigint
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorDepositRedeemClaimPayload = {
	contract: string
	claimer: string
	beneficiary: string
	referrer: string
	code: string
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorDepositRedeemTransferPayload = {
	contract: string
	fromBeneficiary: string
	toBeneficiary: string
	nodeWallets: string[]
	nonce: bigint
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorCreateTransferOrderPayload = {
	contract: string
	seller: string
	nodeWallets: string[]
	priceUsdc6: bigint
	nonce: bigint
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorCancelTransferOrderPayload = {
	contract: string
	orderId: bigint
	seller: string
	nonce: bigint
	deadline: bigint
	signature: string
	res?: Response
}

export type ValidatorFulfillTransferOrderPayload = {
	contract: string
	orderId: bigint
	buyer: string
	nonce: bigint
	deadline: bigint
	signature: string
	payValidAfter: bigint
	payValidBefore: bigint
	payNonce: string
	paySignature: string
	res?: Response
}

export const validatorDepositRedeemCreatePool: ValidatorDepositRedeemCreatePayload[] = []
export const validatorDepositRedeemCancelPool: ValidatorDepositRedeemCancelPayload[] = []
export const validatorDepositRedeemClaimPool: ValidatorDepositRedeemClaimPayload[] = []
export const validatorDepositRedeemTransferPool: ValidatorDepositRedeemTransferPayload[] = []
export const validatorCreateTransferOrderPool: ValidatorCreateTransferOrderPayload[] = []
export const validatorCancelTransferOrderPool: ValidatorCancelTransferOrderPayload[] = []
export const validatorFulfillTransferOrderPool: ValidatorFulfillTransferOrderPayload[] = []

async function withSettleWallet<T>(poolName: string, fn: (wallet: (typeof Settle_ContractPool)[number]) => Promise<T>): Promise<T | undefined> {
	if (!Settle_ContractPool.length) return undefined
	const sc = Settle_ContractPool.shift()
	if (!sc) return undefined
	try {
		return await fn(sc)
	} finally {
		Settle_ContractPool.unshift(sc)
	}
}

export const validatorDepositRedeemCreateProcess = async () => {
	const obj = validatorDepositRedeemCreatePool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorDepositRedeemCreatePool.unshift(obj)
		return setTimeout(() => void validatorDepositRedeemCreateProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorDepositRedeemCreate', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.createRedeemFor!(
				obj.admin,
				obj.codeHash,
				obj.allowedClaimer,
				obj.referrer,
				obj.validatorCount,
				obj.targetNodeIp,
				obj.gbMiningNodeCount,
				obj.validAfter,
				obj.validBefore,
				obj.nonce,
				obj.deadline,
				obj.signature,
				{ gasLimit: 1_800_000 }
			)
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorDepositRedeemCreateProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorDepositRedeemCreateProcess(), 3000)
	}
}

export const validatorDepositRedeemCancelProcess = async () => {
	const obj = validatorDepositRedeemCancelPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorDepositRedeemCancelPool.unshift(obj)
		return setTimeout(() => void validatorDepositRedeemCancelProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorDepositRedeemCancel', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.cancelRedeemFor!(obj.admin, obj.codeHash, obj.nonce, obj.deadline, obj.signature, { gasLimit: 700_000 })
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorDepositRedeemCancelProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorDepositRedeemCancelProcess(), 3000)
	}
}

export const validatorDepositRedeemClaimProcess = async () => {
	const obj = validatorDepositRedeemClaimPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorDepositRedeemClaimPool.unshift(obj)
		return setTimeout(() => void validatorDepositRedeemClaimProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorDepositRedeemClaim', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.claimRedeemFor!(obj.claimer, obj.beneficiary, obj.code, obj.deadline, obj.signature, { gasLimit: 1_800_000 })
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorDepositRedeemClaimProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorDepositRedeemClaimProcess(), 3000)
	}
}

export const validatorDepositRedeemTransferProcess = async () => {
	const obj = validatorDepositRedeemTransferPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorDepositRedeemTransferPool.unshift(obj)
		return setTimeout(() => void validatorDepositRedeemTransferProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorDepositRedeemTransfer', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.transferNodes!(
				obj.fromBeneficiary,
				obj.toBeneficiary,
				obj.nodeWallets,
				obj.nonce,
				obj.deadline,
				obj.signature,
				{ gasLimit: 3_000_000 }
			)
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorDepositRedeemTransferProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorDepositRedeemTransferProcess(), 3000)
	}
}

export const validatorCreateTransferOrderProcess = async () => {
	const obj = validatorCreateTransferOrderPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorCreateTransferOrderPool.unshift(obj)
		return setTimeout(() => void validatorCreateTransferOrderProcess(), 3000)
	}
	try {
		const result = await withSettleWallet('validatorCreateTransferOrder', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.createTransferOrder!(
				obj.seller,
				obj.nodeWallets,
				obj.priceUsdc6,
				obj.nonce,
				obj.deadline,
				obj.signature,
				{ gasLimit: 3_000_000 }
			)
			const receipt = await tx.wait()
			// Parse orderId from the TransferOrderCreated event.
			let orderId: string | undefined
			for (const log of receipt?.logs ?? []) {
				try {
					const parsed = c.interface.parseLog(log)
					if (parsed?.name === 'TransferOrderCreated') {
						orderId = (parsed.args[0] as bigint).toString()
						break
					}
				} catch {
					// not our event
				}
			}
			return { txHash: tx.hash as string, orderId }
		})
		if (!result) throw new Error('No settle wallet available')
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, ...result }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorCreateTransferOrderProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorCreateTransferOrderProcess(), 3000)
	}
}

export const validatorCancelTransferOrderProcess = async () => {
	const obj = validatorCancelTransferOrderPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorCancelTransferOrderPool.unshift(obj)
		return setTimeout(() => void validatorCancelTransferOrderProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorCancelTransferOrder', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.cancelTransferOrder!(obj.orderId, obj.seller, obj.nonce, obj.deadline, obj.signature, { gasLimit: 2_000_000 })
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorCancelTransferOrderProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorCancelTransferOrderProcess(), 3000)
	}
}

export const validatorFulfillTransferOrderProcess = async () => {
	const obj = validatorFulfillTransferOrderPool.shift()
	if (!obj) return
	if (!Settle_ContractPool.length) {
		validatorFulfillTransferOrderPool.unshift(obj)
		return setTimeout(() => void validatorFulfillTransferOrderProcess(), 3000)
	}
	try {
		const txHash = await withSettleWallet('validatorFulfillTransferOrder', async (sc) => {
			const c = new ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await c.fulfillTransferOrder!(
				obj.orderId,
				obj.buyer,
				obj.nonce,
				obj.deadline,
				obj.signature,
				obj.payValidAfter,
				obj.payValidBefore,
				obj.payNonce,
				obj.paySignature,
				{ gasLimit: 3_000_000 },
			)
			await tx.wait()
			return tx.hash as string
		})
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash }).end()
	} catch (e: any) {
		const msg = e?.shortMessage ?? e?.message ?? String(e)
		logger(Colors.red('[validatorFulfillTransferOrderProcess] failed:'), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		setTimeout(() => void validatorFulfillTransferOrderProcess(), 3000)
	}
}

const activeRunCommandChildren = new Set<ChildProcess>()

function runCommand(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
		activeRunCommandChildren.add(child)
		const detach = () => {
			activeRunCommandChildren.delete(child)
		}
		let out = ''
		child.stdout.on('data', (d) => {
			out += d.toString()
		})
		child.stderr.on('data', (d) => {
			out += d.toString()
		})
		child.on('error', (err) => {
			detach()
			reject(err)
		})
		child.on('close', (code) => {
			detach()
			if (code === 0) return resolve(out.slice(-4000))
			reject(new Error(`${label} exited ${code}: ${out.slice(-4000)}`))
		})
	})
}

/** Active bash helper scripts (08_import, generate, exit, …) spawned via runCommand. */
export function getActiveRunCommandChildCount(): number {
	return activeRunCommandChildren.size
}

/** Wait for in-flight runCommand children before listener exit (systemctl restart grace). */
export async function waitForRunCommandChildren(timeoutMs?: number): Promise<void> {
	const grace = timeoutMs ?? Number(process.env.CONET_VALIDATOR_LISTENER_STOP_GRACE_MS || 120_000)
	if (!Number.isFinite(grace) || grace <= 0 || activeRunCommandChildren.size === 0) return
	const deadline = Date.now() + grace
	while (activeRunCommandChildren.size > 0) {
		if (Date.now() >= deadline) {
			logger(
				Colors.yellow(
					`[validatorDepositRedeem] waitForRunCommandChildren timeout (${grace}ms); ${activeRunCommandChildren.size} child(ren) still running`
				)
			)
			return
		}
		await new Promise((r) => setTimeout(r, 200))
	}
}

/**
 * Read the last {count} validator BLS pubkeys appended to a staking deposit-cli style JSON file.
 * The generate script APPENDS {validatorCount} entries per claim, so this claim's validators are the tail.
 * Returns 0x-prefixed 48-byte pubkeys; empty array if the file is unreadable or malformed.
 */
function readLastNDepositPubkeys(depositFile: string, count: number): string[] {
	if (count <= 0 || !fs.existsSync(depositFile)) return []
	try {
		const parsed = JSON.parse(fs.readFileSync(depositFile, 'utf8'))
		const arr = Array.isArray(parsed) ? parsed : []
		const tail = arr.slice(-count)
		const out: string[] = []
		for (const entry of tail) {
			try {
				out.push(hexBytesField(entry?.pubkey, 48, 'pubkey'))
			} catch {
				// skip pubkey-only / malformed tail entries
			}
		}
		return out
	} catch {
		return []
	}
}

type DepositJsonEntry = {
	pubkey: string
	withdrawalCredentials: string
	signature: string
	depositDataRoot: string
}

function hexBytesField(raw: unknown, byteLen: number, label: string): string {
	const t = String(raw ?? '').trim().toLowerCase()
	const hex = t.startsWith('0x') ? t.slice(2) : t
	if (!/^[0-9a-f]+$/.test(hex) || hex.length !== byteLen * 2) {
		throw new Error(`invalid ${label}: expected ${byteLen} bytes hex`)
	}
	return `0x${hex}`
}

function readLastNDepositEntries(depositFile: string, count: number): DepositJsonEntry[] {
	if (count <= 0 || !fs.existsSync(depositFile)) return []
	const parsed = JSON.parse(fs.readFileSync(depositFile, 'utf8'))
	const arr = Array.isArray(parsed) ? parsed : []
	const tail = arr.slice(-count)
	const out: DepositJsonEntry[] = []
	for (const entry of tail) {
		out.push({
			pubkey: hexBytesField(entry?.pubkey, 48, 'pubkey'),
			withdrawalCredentials: hexBytesField(
				entry?.withdrawal_credentials ?? entry?.withdrawalCredentials,
				32,
				'withdrawal_credentials'
			),
			signature: hexBytesField(entry?.signature, 96, 'signature'),
			depositDataRoot: hexBytesField(entry?.deposit_data_root ?? entry?.depositDataRoot, 32, 'deposit_data_root'),
		})
	}
	return out
}

/** Resolve DePIN node wallets (1:1 with claim IPs) for the last N deposit entries. */
async function resolveNodeWalletsForClaim(state: ValidatorRedeemState, count: number): Promise<string[]> {
	const contractAddr = resolveValidatorDepositRedeemAddress()
	if (!contractAddr) throw new Error('no validator redeem contract configured')
	const provider = conetProvider()
	const cRead = new ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
	const bundle = await cRead.getBeneficiaryNodeBundle!(state.beneficiary)
	const bundleIps = (bundle.depinNodeIps as string[]).map(normalizeIp)
	const bundleWallets = bundle.nodeWallets as string[]
	const ipToWallet = new Map<string, string>()
	bundleIps.forEach((ip, i) => {
		if (ip && bundleWallets[i] && bundleWallets[i] !== ethers.ZeroAddress) ipToWallet.set(ip, bundleWallets[i])
	})
	const claimIps = state.conetDepinNodeIps.map(normalizeIp)
	const wallets: string[] = []
	for (let i = 0; i < count; i++) {
		const ip = claimIps[i]
		const wallet = ip ? ipToWallet.get(ip) : undefined
		if (!wallet) throw new Error(`no DePIN node wallet for ip=${ip ?? '?'}`)
		wallets.push(ethers.getAddress(wallet))
	}
	return wallets
}

/**
 * Submit validators via ValidatorDepositRedeem.fundAndDepositValidators: 32 CNET/validator from contract
 * balance; redeem admin (38.102.85.33) signs and pays gas only.
 */
async function fundAndDepositViaContract(
	state: ValidatorRedeemState,
	mark: (stage: string, ok: boolean, detail?: string) => void
): Promise<void> {
	const contractAddr = resolveValidatorDepositRedeemAddress()
	if (!contractAddr) return mark('fund-and-deposit', false, 'no validator redeem contract configured')
	const count = Number(state.validatorCount)
	if (!Number.isFinite(count) || count <= 0) return mark('fund-and-deposit', true, 'no validators to deposit')

	const depositFile = path.join(resolveNewCoNETDir(), 'validator_deposits.json')
	let entries: DepositJsonEntry[]
	try {
		entries = readLastNDepositEntries(depositFile, count)
	} catch (e: any) {
		return mark('fund-and-deposit', false, e?.message ?? String(e))
	}
	if (entries.length !== count) {
		return mark('fund-and-deposit', false, `deposit entries ${entries.length} != validatorCount ${count}`)
	}

	const provider = conetProvider()
	const cRead = new ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
	const selfCred: string = await cRead.selfWithdrawalCredentials!()
	for (const e of entries) {
		const wc = ethers.hexlify(e.withdrawalCredentials).toLowerCase()
		if (wc !== String(selfCred).toLowerCase()) {
			return mark(
				'fund-and-deposit',
				false,
				`withdrawal_credentials must equal contract selfWithdrawalCredentials (${selfCred}); regenerate with WITHDRAWAL_ADDRESS=contract`
			)
		}
	}

	let nodeWallets: string[]
	try {
		nodeWallets = await resolveNodeWalletsForClaim(state, count)
	} catch (e: any) {
		return mark('fund-and-deposit', false, e?.message ?? String(e))
	}

	const need = VALIDATOR_STAKE_WEI * BigInt(count)
	const bal = await provider.getBalance(contractAddr)
	if (bal < need) {
		return mark(
			'fund-and-deposit',
			false,
			`ValidatorDepositRedeem balance ${ethers.formatEther(bal)} CNET < ${ethers.formatEther(need)} needed (${count}×32)`
		)
	}

	const admin = loadRedeemAdminWallet()
	const cw = new ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, admin)
	const tx = await cw.fundAndDepositValidators!(
		nodeWallets,
		entries.map((e) => e.pubkey),
		entries.map((e) => e.withdrawalCredentials),
		entries.map((e) => e.signature),
		entries.map((e) => e.depositDataRoot),
		{ gasLimit: 800_000 + 350_000 * count }
	)
	const receipt = await tx.wait()
	const deployedPubkeys = entries.map((e) => e.pubkey)
	mark(
		'fund-and-deposit',
		true,
		`deposited ${count} validators from contract balance; tx=${receipt?.hash ?? tx.hash}; admin=${admin.address}`
	)
	upsertState(state.requestId, (cur) => ({
		...(cur || state),
		deployedPubkeys,
		updatedAt: new Date().toISOString(),
	}))
}

/**
 * After validators are deployed for a claimed beneficiary, pair each allocated DePIN node wallet (1:1) with a
 * deployed validator pubkey and register the binding on chain (withdrawal -> beneficiary). The deployment node's
 * relayer (a redeem admin in {Settle_ContractPool}) submits and pays CNET gas. Failures here do NOT roll back the
 * deployment (validators already exist); the stage is marked so it can be retried later.
 */
async function registerDeployedValidators(
	state: ValidatorRedeemState,
	mark: (stage: string, ok: boolean, detail?: string) => void
): Promise<void> {
	const contractAddr = resolveValidatorDepositRedeemAddress()
	if (!contractAddr) return mark('register-validators', false, 'no validator redeem contract configured')
	const count = Number(state.validatorCount)
	if (!Number.isFinite(count) || count <= 0) return mark('register-validators', true, 'no validators to register')

	const depositFile = path.join(resolveNewCoNETDir(), 'validator_deposits.json')
	let pubkeys = (state.deployedPubkeys ?? []).slice(0, count)
	if (pubkeys.length !== count) {
		pubkeys = readLastNDepositPubkeys(depositFile, count)
	}
	if (pubkeys.length !== count) {
		return mark('register-validators', false, `deposit pubkeys ${pubkeys.length} != validatorCount ${count}`)
	}

	const provider = conetProvider()
	const cRead = new ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
	const bundle = await cRead.getBeneficiaryNodeBundle!(state.beneficiary)
	const bundleIps = (bundle.depinNodeIps as string[]).map(normalizeIp)
	const bundleWallets = bundle.nodeWallets as string[]
	const ipToWallet = new Map<string, string>()
	bundleIps.forEach((ip, i) => {
		if (ip && bundleWallets[i] && bundleWallets[i] !== ethers.ZeroAddress) ipToWallet.set(ip, bundleWallets[i])
	})

	// Pair this claim's allocated DePIN node wallets (from the event IP list) with deployed validator pubkeys.
	const claimIps = state.conetDepinNodeIps.map(normalizeIp)
	const pairs: { wallet: string; pubkey: string }[] = []
	for (let i = 0; i < pubkeys.length; i++) {
		const ip = claimIps[i]
		const wallet = ip ? ipToWallet.get(ip) : undefined
		if (wallet) pairs.push({ wallet, pubkey: pubkeys[i] })
	}
	if (!pairs.length) return mark('register-validators', false, 'no DePIN node wallets resolved for this claim')

	const pending: { wallet: string; pubkey: string }[] = []
	for (const p of pairs) {
		const pkHash = ethers.keccak256(p.pubkey)
		const bound = ethers.getAddress(await cRead.getNodeByValidatorPubkeyHash!(pkHash))
		if (bound !== ethers.ZeroAddress && bound.toLowerCase() === p.wallet.toLowerCase()) continue
		if (bound !== ethers.ZeroAddress && bound.toLowerCase() !== p.wallet.toLowerCase()) {
			return mark('register-validators', false, `pubkey already bound to ${bound}`)
		}
		pending.push(p)
	}
	if (!pending.length) {
		return mark('register-validators', true, `already registered ${pairs.length} validators on chain`)
	}

	const txHash = await withSettleWallet('registerNodeValidators', async (sc) => {
		const cw = new ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
		const tx = await cw.registerNodeValidators!(
			pending.map((p) => p.wallet),
			pending.map((p) => p.pubkey),
			{ gasLimit: 2_500_000 }
		)
		await tx.wait()
		return tx.hash as string
	})
	if (!txHash) return mark('register-validators', false, 'no relayer wallet available (Settle pool empty)')
	mark('register-validators', true, `registered ${pending.length} validators; tx=${txHash}`)
}

/** Manual / retry: register validators for succeeded redeem claims missing register-validators stage. */
export async function retryRegisterDeployedValidatorsForRedeemState(): Promise<
	Array<{ requestId: string; ok: boolean; detail: string }>
> {
	const stateFile = resolveStateFile()
	if (!fs.existsSync(stateFile)) return []
	const all = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, ValidatorRedeemState>
	const results: Array<{ requestId: string; ok: boolean; detail: string }> = []
	for (const [requestId, state] of Object.entries(all)) {
		if (state?.status !== 'succeeded') continue
		if (state.stages?.['register-validators']?.ok) {
			results.push({ requestId, ok: true, detail: 'already registered' })
			continue
		}
		const stages: ValidatorRedeemState['stages'] = { ...(state.stages || {}) }
		const mark = (stage: string, ok: boolean, detail?: string) => {
			stages[stage] = { ok, at: new Date().toISOString(), detail }
		}
		try {
			await registerDeployedValidators({ ...state, requestId, stages }, mark)
			const ok = Boolean(stages['register-validators']?.ok)
			results.push({ requestId, ok, detail: stages['register-validators']?.detail ?? 'unknown' })
			upsertState(requestId, (cur) => ({
				...(cur || state),
				stages,
				updatedAt: new Date().toISOString(),
			}))
		} catch (e: unknown) {
			const detail = (e as Error)?.message ?? String(e)
			mark('register-validators', false, detail)
			results.push({ requestId, ok: false, detail })
			upsertState(requestId, (cur) => ({
				...(cur || state),
				stages,
				updatedAt: new Date().toISOString(),
			}))
		}
	}
	return results
}

/** True if the deposit-cli JSON file contains a validator entry whose pubkey matches {pubkeyHex} (0x..). */
function depositFileHasPubkey(depositFile: string, pubkeyHex: string): boolean {
	try {
		if (!fs.existsSync(depositFile)) return false
		const want = pubkeyHex.toLowerCase().replace(/^0x/, '')
		const arr = JSON.parse(fs.readFileSync(depositFile, 'utf8'))
		if (!Array.isArray(arr)) return false
		return arr.some((e) => String(e?.pubkey ?? '').toLowerCase().replace(/^0x/, '') === want)
	} catch {
		return false
	}
}

/**
 * Transfer step on the validator node (staking-custody model): when a {NodeValidatorBeneficiaryUpdated}
 * event names a validator this node deployed, HOT-UPDATE its fee_recipient to the new economic beneficiary.
 * The validator is NOT exited and NOT redeployed: same BLS pubkey, withdrawal_credentials stay pointed at
 * the ValidatorDepositRedeem contract (immutable custody). Only the execution-layer fee_recipient changes.
 * Best-effort: missing scripts / dry-run only record stages and never throw out of the listener.
 */
async function executeFeeRecipientHotUpdate(args: {
	contract: string
	nodeWallet: string
	toBeneficiary: string
	pubkeyHash: string
}): Promise<void> {
	const rid = `feerecipient:${args.nodeWallet.toLowerCase()}:${args.pubkeyHash.toLowerCase()}`
	const flightKey = `feerecipient:${rid}`
	if (!tryBeginListenerEvent(flightKey)) return
	try {
		const prior = getValidatorDepositRedeemStatus(rid)
		if (prior?.status === 'succeeded' || prior?.status === 'running') return
		const base: ValidatorRedeemState = {
			requestId: rid,
			codeHash: '',
			claimer: args.nodeWallet,
			beneficiary: args.toBeneficiary,
			validatorCount: '1',
			targetNodeIp: resolveValidatorNodeIp(),
			conetDepinNodeIps: [],
			gbMiningNodeCount: '0',
			status: 'received',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stages: {},
		}
		const mark = (stage: string, ok: boolean, detail?: string) =>
			upsertState(rid, (cur) => ({
				...(cur || base),
				status: ok ? 'running' : 'failed',
				updatedAt: new Date().toISOString(),
				error: ok ? cur?.error : detail,
				stages: { ...(cur?.stages || base.stages), [stage]: { ok, at: new Date().toISOString(), detail } },
			}))

		const provider = conetProvider()
		const cRead = new ethers.Contract(args.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
		const onchain = await cRead.getNodeValidator!(args.nodeWallet)
		const pubkey = String(onchain?.[0] ?? onchain?.pubkey ?? '').toLowerCase()
		const newCoNETDir = resolveNewCoNETDir()
		const depositFile = path.join(newCoNETDir, 'validator_deposits.json')

		if (!pubkey || pubkey === '0x' || !depositFileHasPubkey(depositFile, pubkey)) {
			return
		}
		mark('feerecipient-matched', true, `nodeWallet=${args.nodeWallet} -> ${args.toBeneficiary}`)

		if (validatorDryRun()) {
			mark('dry-run', true, 'skipped fee_recipient hot-update')
			upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }))
			return
		}

		const env = {
			...process.env,
			VALIDATOR_PUBKEY: pubkey,
			EXIT_VALIDATOR_PUBKEY: pubkey,
			FEE_RECIPIENT: args.toBeneficiary,
			FEE_RECIPIENT_ADDRESS: args.toBeneficiary,
			RPC_URL: process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || masterSetup.validatorDeposit?.rpcUrl || resolveBeamioConetHttpRpcUrl(),
			CHAIN_ID: String(CONET_MAINNET_CHAIN_ID),
		}

		const feeScript = process.env.CONET_VALIDATOR_FEE_RECIPIENT_SCRIPT?.trim() || './07_update_fee_recipient.sh'
		if (fs.existsSync(path.join(newCoNETDir, feeScript))) {
			const out = await runCommand('update fee_recipient', 'bash', [feeScript], newCoNETDir, env)
			mark('feerecipient-update', true, out)
			upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }))
		} else {
			mark('feerecipient-update', false, `fee_recipient script missing: ${feeScript} (manual hot-update required)`)
		}
	} finally {
		endListenerEvent(flightKey)
	}
}

/**
 * Full-exit step on the validator node: when a {FullExitRequested} event names node wallets whose validators
 * this node deployed, exit each validator. The 32-CNET principal auto-returns to the ValidatorDepositRedeem
 * contract (0x01 withdrawal target). After broadcasting the exit, the relayer calls {settleFullExitPayout}
 * which advances 32×count CNET from the contract pool to the beneficiary. Best-effort; never throws out.
 */
async function executeValidatorFullExit(args: {
	contract: string
	beneficiary: string
	nodeWallets: string[]
}): Promise<void> {
	const rid = `fullexit:${args.beneficiary.toLowerCase()}:${args.nodeWallets.map((w) => w.toLowerCase()).join(',')}`
	const flightKey = `fullexit:${rid}`
	if (!tryBeginListenerEvent(flightKey)) return
	try {
		const prior = getValidatorDepositRedeemStatus(rid)
		if (prior?.status === 'succeeded' || prior?.status === 'running') return
		const base: ValidatorRedeemState = {
			requestId: rid,
			codeHash: '',
			claimer: args.beneficiary,
			beneficiary: args.beneficiary,
			validatorCount: String(args.nodeWallets.length),
			targetNodeIp: resolveValidatorNodeIp(),
			conetDepinNodeIps: [],
			gbMiningNodeCount: '0',
			status: 'received',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stages: {},
		}
		const mark = (stage: string, ok: boolean, detail?: string) =>
			upsertState(rid, (cur) => ({
				...(cur || base),
				status: ok ? 'running' : 'failed',
				updatedAt: new Date().toISOString(),
				error: ok ? cur?.error : detail,
				stages: { ...(cur?.stages || base.stages), [stage]: { ok, at: new Date().toISOString(), detail } },
			}))

		const provider = conetProvider()
		const cRead = new ethers.Contract(args.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
		const newCoNETDir = resolveNewCoNETDir()
		const depositFile = path.join(newCoNETDir, 'validator_deposits.json')

		const localNodeWallets: string[] = []
		for (const nodeWallet of args.nodeWallets) {
			try {
				const onchain = await cRead.getNodeValidator!(nodeWallet)
				const pubkey = String(onchain?.[0] ?? onchain?.pubkey ?? '').toLowerCase()
				if (pubkey && pubkey !== '0x' && depositFileHasPubkey(depositFile, pubkey)) {
					localNodeWallets.push(nodeWallet)
				}
			} catch {
				// ignore unreadable node
			}
		}
		if (!localNodeWallets.length) return
		mark('fullexit-matched', true, `local nodeWallets=${localNodeWallets.join(',')}`)

		if (validatorDryRun()) {
			mark('dry-run', true, 'skipped exit + settle')
			upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }))
			return
		}

		const baseEnv = {
			...process.env,
			RPC_URL: process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || masterSetup.validatorDeposit?.rpcUrl || resolveBeamioConetHttpRpcUrl(),
			CHAIN_ID: String(CONET_MAINNET_CHAIN_ID),
			DEPOSIT_CONTRACT: CONET_DEPOSIT_CONTRACT,
		}
		const exitScript = process.env.CONET_VALIDATOR_EXIT_SCRIPT?.trim() || './06_exit_validator.sh'
		if (!fs.existsSync(path.join(newCoNETDir, exitScript))) {
			mark('fullexit-exit', false, `exit script missing: ${exitScript} (manual exit required)`)
			return
		}

		for (const nodeWallet of localNodeWallets) {
			const onchain = await cRead.getNodeValidator!(nodeWallet)
			const pubkey = String(onchain?.[0] ?? onchain?.pubkey ?? '').toLowerCase()
			const out = await runCommand(`exit validator ${pubkey.slice(0, 12)}`, 'bash', [exitScript], newCoNETDir, {
				...baseEnv,
				EXIT_VALIDATOR_PUBKEY: pubkey,
			})
			mark(`fullexit-exit-${pubkey.slice(2, 12)}`, true, out)
		}

		const txHash = await withSettleWallet('settleFullExitPayout', async (sc) => {
			const cw = new ethers.Contract(args.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet)
			const tx = await cw.settleFullExitPayout!(args.beneficiary, localNodeWallets, { gasLimit: 1_500_000 })
			await tx.wait()
			return tx.hash as string
		})
		if (txHash) {
			mark('fullexit-settle', true, `tx=${txHash}`)
			upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }))
		} else {
			mark('fullexit-settle', false, 'settle deferred (pool insufficient or no relayer); will retry')
		}
	} finally {
		endListenerEvent(flightKey)
	}
}

async function executeValidatorRedeem(state: ValidatorRedeemState): Promise<void> {
	const requestId = state.requestId.toLowerCase()
	const dryRun = validatorDryRun()
	const newCoNETDir = resolveNewCoNETDir()
	const depositPrivateKeyFile = resolveDepositPrivateKeyFile()
	const contractAddr = resolveValidatorDepositRedeemAddress()
	if (!fs.existsSync(newCoNETDir)) throw new Error(`newCoNET dir missing: ${newCoNETDir}`)
	if (!contractAddr) throw new Error('ValidatorDepositRedeem contract not configured')
	if (!dryRun && (!depositPrivateKeyFile || !fs.existsSync(depositPrivateKeyFile))) {
		throw new Error(
			'CONET_VALIDATOR_REDEEM_ADMIN_PRIVATE_KEY_FILE missing; fundAndDepositValidators requires redeem admin key (key_38.102.85.33)'
		)
	}
	const keystorePassword = resolveKeystorePassword()
	if (!dryRun && !keystorePassword) {
		throw new Error(
			'KEYSTORE_PASSWORD or CONET_VALIDATOR_KEYSTORE_PASSWORD_FILE missing; required for 01_generate_append_validator_deposits.sh (must match validator keystore password on this node)'
		)
	}
	const walletPassword = resolveWalletPassword()
	if (!dryRun && !walletPassword) {
		throw new Error(
			'WALLET_PASSWORD or CONET_VALIDATOR_WALLET_PASSWORD_FILE missing; required for 01_generate_append_validator_deposits.sh (Prysm wallet password on this node)'
		)
	}

	const env = {
		...process.env,
		KEYSTORE_PASSWORD: keystorePassword,
		WALLET_PASSWORD: walletPassword,
		VALIDATOR_COUNT: state.validatorCount,
		// Withdrawal credentials must point at ValidatorDepositRedeem (0x01 + contract), not beneficiary EOA.
		WITHDRAWAL_ADDRESS_RAW: contractAddr,
		CONFIRM_OVERRIDE_WITHDRAWAL_ADDRESS: 'YES',
		// 01_generate_append_validator_deposits.sh: skip "Type REPLACE" prompt when prior local output exists.
		CONFIRM_REPLACE: 'REPLACE',
		// EthStaker deposit CLI: no TTY prompts (listener stdin is ignored).
		DEPOSIT_NON_INTERACTIVE: process.env.CONET_VALIDATOR_DEPOSIT_NON_INTERACTIVE?.trim() === 'NO' ? '' : 'YES',
		PRIVATE_KEY_FILE: depositPrivateKeyFile,
		DEPOSIT_DATA_FILE: path.join(newCoNETDir, 'validator_deposits.json'),
		RPC_URL: process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || masterSetup.validatorDeposit?.rpcUrl || resolveBeamioConetHttpRpcUrl(),
		CHAIN_ID: String(CONET_MAINNET_CHAIN_ID),
		DEPOSIT_CONTRACT: CONET_DEPOSIT_CONTRACT,
	}

	const mark = (stage: string, ok: boolean, detail?: string) => {
		upsertState(requestId, (cur) => ({
			...(cur || state),
			status: ok ? 'running' : 'failed',
			updatedAt: new Date().toISOString(),
			error: ok ? cur?.error : detail,
			stages: { ...(cur?.stages || state.stages), [stage]: { ok, at: new Date().toISOString(), detail } },
			depositPrivateKeyFile: depositPrivateKeyFile || undefined,
		}))
	}

	mark('depin-gb-assignment', true, `beneficiary=${state.beneficiary}; depinIps=${state.conetDepinNodeIps.join(',')}; gbMiningNodeCount=${state.gbMiningNodeCount}`)
	if (dryRun) {
		mark('dry-run', true, 'skipped scripts and deposits')
		return
	}

	const generateOut = await runCommand(
		'generate validators',
		'bash',
		['./01_generate_append_validator_deposits_listener.sh'],
		newCoNETDir,
		env
	)
	mark('generate-validators', true, generateOut)

	// Password files must stay stable for Prysm wallet; re-read after wrapper restore.
	const importKeystorePassword = resolveKeystorePassword()
	const importWalletPassword = resolveWalletPassword()

	await fundAndDepositViaContract(state, mark)
	await registerDeployedValidators(state, mark)

	const prysmValidatorBinary =
		process.env.PRYSM_VALIDATOR_BINARY?.trim() ||
		path.join(newCoNETDir, 'dependencies/prysm-v7.1.5/validator')
	const importEnv = {
		...env,
		KEYSTORE_PASSWORD: importKeystorePassword,
		WALLET_PASSWORD: importWalletPassword,
		KEYSTORE_PASSWORD_FILE: resolveKeystorePasswordFile(),
		WALLET_PASSWORD_FILE: resolveWalletPasswordFile(),
		PRYSM_VALIDATOR_BINARY: prysmValidatorBinary,
		RELOAD_VALIDATOR_AFTER_IMPORT:
			process.env.CONET_VALIDATOR_RELOAD_VALIDATOR_AFTER_IMPORT?.trim().toUpperCase() === 'NO' ? 'NO' : 'YES',
	}

	const skipImport = process.env.CONET_VALIDATOR_SKIP_IMPORT?.trim().toUpperCase() === 'YES'
	if (skipImport) {
		mark('import-validator-keys', true, 'skipped (CONET_VALIDATOR_SKIP_IMPORT=YES)')
	} else {
		const importOut = await runCommand(
			'import append validator keys',
			'bash',
			['./08_import_append_validator_keys.sh'],
			newCoNETDir,
			importEnv
		)
		mark('import-validator-keys', true, importOut)
	}

	// Optional full beacon+validator restart (does NOT import keys). Default skip — import script reloads validator only.
	const skipBeaconRestart = process.env.CONET_VALIDATOR_SKIP_BEACON_RESTART?.trim().toUpperCase() !== 'NO'
	if (skipBeaconRestart) {
		mark(
			'restart-beacon-validator',
			true,
			'skipped (set CONET_VALIDATOR_SKIP_BEACON_RESTART=NO to run 05_restart_beacon_validator.sh)'
		)
		return
	}

	const restartEnv = {
		...importEnv,
		PRYSM_BEACON_BINARY:
			process.env.PRYSM_BEACON_BINARY?.trim() ||
			path.join(newCoNETDir, 'dependencies/prysm-v7.1.5/beacon-chain'),
	}
	const restartOut = await runCommand('restart beacon validator', 'bash', ['./05_restart_beacon_validator.sh'], newCoNETDir, restartEnv)
	mark('restart-beacon-validator', true, restartOut)
}

let listenerStarted = false

/** First block handled by live subscription; blocks below this are backfill-only. Set after live attach. */
let liveListenFromBlock = 0

function shouldHandleLiveListenerBlock(blockNumber: number): boolean {
	// Before boundary is resolved, accept live events (dedup handles any overlap with backfill).
	if (liveListenFromBlock <= 0) return true
	return blockNumber >= liveListenFromBlock
}

/** Prevents duplicate work when backfill and live subscription overlap on the same event. */
const listenerEventInFlight = new Set<string>()

function tryBeginListenerEvent(key: string): boolean {
	if (listenerEventInFlight.has(key)) return false
	listenerEventInFlight.add(key)
	return true
}

function endListenerEvent(key: string): void {
	listenerEventInFlight.delete(key)
}

const LISTENER_EVENT_NAMES = [
	'ValidatorRedeemClaimed',
	'NodeValidatorBeneficiaryUpdated',
	'FullExitRequested',
] as const

const VALIDATOR_DEPOSIT_REDEEM_IFACE = new ethers.Interface(VALIDATOR_DEPOSIT_REDEEM_ABI)

function isStaleRunningRedeemState(existing: { status?: string; updatedAt?: string } | undefined): boolean {
	if (!existing || existing.status !== 'running') return false
	const updatedAt = Date.parse(existing.updatedAt || '')
	const staleMs = Number(process.env.CONET_VALIDATOR_REDEEM_STALE_RUNNING_MS || 10 * 60 * 1000)
	if (!Number.isFinite(updatedAt) || staleMs <= 0) return false
	return Date.now() - updatedAt >= staleMs
}

async function handleValidatorRedeemClaimedEvent(
	contract: string,
	nodeIp: string,
	args: {
		requestId: string
		codeHash: string
		claimer: string
		beneficiary: string
		validatorCount: string
		targetNodeIp: string
		conetDepinNodeIps: string[]
		gbMiningNodeCount: string
	},
	blockNumber: number
): Promise<void> {
	noteListenerBlock(contract, blockNumber)
	const target = normalizeIp(args.targetNodeIp)
	const rid = args.requestId.toLowerCase()
	const flightKey = `claim:${rid}`
	if (!tryBeginListenerEvent(flightKey)) return
	try {
		if (target !== nodeIp) {
			upsertState(rid, () => ({
				requestId: rid,
				codeHash: args.codeHash,
				claimer: ethers.getAddress(args.claimer),
				beneficiary: ethers.getAddress(args.beneficiary),
				validatorCount: args.validatorCount,
				targetNodeIp: target,
				conetDepinNodeIps: args.conetDepinNodeIps.map(normalizeIp),
				gbMiningNodeCount: args.gbMiningNodeCount,
				status: 'ignored',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				stages: { filter: { ok: true, at: new Date().toISOString(), detail: `target ${target} != local ${nodeIp}` } },
			}))
			return
		}
		const existing = getValidatorDepositRedeemStatus(rid)
		if (existing?.status === 'succeeded') return
		if (existing?.status === 'running' && !isStaleRunningRedeemState(existing)) return
		if (existing?.status === 'running' && isStaleRunningRedeemState(existing)) {
			logger(Colors.yellow(`[validatorDepositRedeemListener] retry stale running claim ${rid.slice(0, 12)}…`))
		}
		const next = upsertState(rid, () => ({
			requestId: rid,
			codeHash: args.codeHash,
			claimer: ethers.getAddress(args.claimer),
			beneficiary: ethers.getAddress(args.beneficiary),
			validatorCount: args.validatorCount,
			targetNodeIp: target,
			conetDepinNodeIps: args.conetDepinNodeIps.map(normalizeIp),
			gbMiningNodeCount: args.gbMiningNodeCount,
			status: 'received',
			createdAt: existing?.createdAt || new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stages: { event: { ok: true, at: new Date().toISOString(), detail: `block=${blockNumber}` } },
		}))
		try {
			upsertState(rid, (cur) => ({ ...(cur || next), status: 'running', updatedAt: new Date().toISOString() }))
			await executeValidatorRedeem(next)
			upsertState(rid, (cur) => ({ ...(cur || next), status: 'succeeded', updatedAt: new Date().toISOString() }))
		} catch (e: any) {
			const msg = e?.message ?? String(e)
			logger(Colors.red('[validatorDepositRedeemListener] execute failed:'), msg)
			upsertState(rid, (cur) => ({ ...(cur || next), status: 'failed', error: msg, updatedAt: new Date().toISOString() }))
		}
	} finally {
		endListenerEvent(flightKey)
	}
}

async function dispatchValidatorDepositRedeemListenerLog(
	contract: string,
	nodeIp: string,
	parsed: ethers.LogDescription,
	blockNumber: number
): Promise<void> {
	switch (parsed.name) {
		case 'ValidatorRedeemClaimed':
			await handleValidatorRedeemClaimedEvent(
				contract,
				nodeIp,
				{
					requestId: String(parsed.args.requestId),
					codeHash: String(parsed.args.codeHash),
					claimer: String(parsed.args.claimer),
					beneficiary: String(parsed.args.beneficiary),
					validatorCount: String(parsed.args.validatorCount),
					targetNodeIp: String(parsed.args.targetNodeIp),
					conetDepinNodeIps: (parsed.args.conetDepinNodeIps as string[]) || [],
					gbMiningNodeCount: String(parsed.args.gbMiningNodeCount),
				},
				blockNumber
			)
			return
		case 'NodeValidatorBeneficiaryUpdated':
			noteListenerBlock(contract, blockNumber)
			await executeFeeRecipientHotUpdate({
				contract,
				nodeWallet: ethers.getAddress(String(parsed.args.nodeWallet)),
				toBeneficiary: ethers.getAddress(String(parsed.args.toBeneficiary)),
				pubkeyHash: String(parsed.args.pubkeyHash),
			})
			return
		case 'FullExitRequested':
			noteListenerBlock(contract, blockNumber)
			await executeValidatorFullExit({
				contract,
				beneficiary: ethers.getAddress(String(parsed.args.beneficiary)),
				nodeWallets: (parsed.args.nodeWallets as string[]).map((w) => ethers.getAddress(String(w))),
			})
			return
		default:
			return
	}
}

async function backfillValidatorDepositRedeemListenerEvents(
	contract: string,
	nodeIp: string,
	fromBlock: number,
	toBlock: number,
	deployFloor: number
): Promise<void> {
	const safeFrom = listenerBackfillFromBlock(fromBlock, deployFloor)
	if (safeFrom > toBlock) return
	const provider = conetProvider()
	const topics = LISTENER_EVENT_NAMES.map((name) => VALIDATOR_DEPOSIT_REDEEM_IFACE.getEvent(name)!.topicHash)
	const chunk = Math.max(1, Number(process.env.CONET_VALIDATOR_REDEEM_LISTENER_LOG_CHUNK || 2000))
	logger(
		Colors.cyan(
			`[validatorDepositRedeemListener] backfill blocks ${safeFrom}..${toBlock} (chunk=${chunk}) contract=${contract}`
		)
	)
	for (let start = safeFrom; start <= toBlock; start += chunk) {
		const end = Math.min(toBlock, start + chunk - 1)
		let logs: ethers.Log[]
		try {
			logs = await provider.getLogs({
				address: contract,
				fromBlock: start,
				toBlock: end,
				topics: [topics],
			})
		} catch (e: any) {
			const msg = e?.message ?? String(e)
			logger(Colors.red(`[validatorDepositRedeemListener] getLogs failed ${start}-${end}:`), msg)
			throw e
		}
		logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
		for (const log of logs) {
			let parsed: ethers.LogDescription | null
			try {
				parsed = VALIDATOR_DEPOSIT_REDEEM_IFACE.parseLog(log)
			} catch {
				continue
			}
			if (!parsed) continue
			await dispatchValidatorDepositRedeemListenerLog(contract, nodeIp, parsed, log.blockNumber)
		}
		saveListenerBlockCheckpoint(contract, end)
		logger(Colors.green(`[validatorDepositRedeemListener] backfill checkpoint block ${end}/${toBlock}`))
	}
}

async function runValidatorDepositRedeemListenerBackfill(
	contract: string,
	nodeIp: string,
	priorSaved: number | null,
	backfillToBlock: number,
	deployFloor: number,
	liveFromBlock: number
): Promise<void> {
	let fromBlock: number | null = null
	if (priorSaved != null) {
		fromBlock = priorSaved + 1
	} else {
		const envFrom = process.env.CONET_VALIDATOR_REDEEM_LISTENER_FROM_BLOCK?.trim()
		if (envFrom) {
			const catchupFrom = Number(envFrom)
			if (!Number.isFinite(catchupFrom) || catchupFrom < 0) {
				throw new Error(`invalid CONET_VALIDATOR_REDEEM_LISTENER_FROM_BLOCK: ${envFrom}`)
			}
			fromBlock = Math.floor(catchupFrom)
		}
	}

	if (fromBlock == null) {
		logger(
			Colors.cyan(
				`[validatorDepositRedeemListener] backfill skipped: no prior checkpoint (live from block ${liveFromBlock})`
			)
		)
		return
	}

	if (fromBlock > backfillToBlock) {
		logger(
			Colors.cyan(
				`[validatorDepositRedeemListener] backfill skipped: gap empty (${fromBlock} > ${backfillToBlock}, live from ${liveFromBlock})`
			)
		)
		return
	}

	logger(
		Colors.cyan(
			`[validatorDepositRedeemListener] backfill ${fromBlock}..${backfillToBlock} (prior=${priorSaved ?? 'none'}, live from ${liveFromBlock}, deployFloor=${deployFloor})`
		)
	)
	await backfillValidatorDepositRedeemListenerEvents(contract, nodeIp, fromBlock, backfillToBlock, deployFloor)
}

function attachValidatorDepositRedeemLiveListeners(
	c: ethers.Contract,
	contract: string,
	nodeIp: string
): void {
	logger(Colors.green(`[validatorDepositRedeemListener] attaching live listeners contract=${contract} nodeIp=${nodeIp}`))

	c.on('ValidatorRedeemClaimed', (requestId, codeHash, claimer, beneficiary, validatorCount, targetNodeIp, conetDepinNodeIps, gbMiningNodeCount, ev) => {
		const blockNumber = (ev as { log?: { blockNumber?: number } })?.log?.blockNumber ?? 0
		if (!shouldHandleLiveListenerBlock(blockNumber)) return
		void handleValidatorRedeemClaimedEvent(
			contract,
			nodeIp,
			{
				requestId: String(requestId),
				codeHash: String(codeHash),
				claimer: String(claimer),
				beneficiary: String(beneficiary),
				validatorCount: String(validatorCount),
				targetNodeIp: String(targetNodeIp),
				conetDepinNodeIps: (conetDepinNodeIps as string[]) || [],
				gbMiningNodeCount: String(gbMiningNodeCount),
			},
			blockNumber
		).catch((e: any) => {
			logger(Colors.red('[validatorDepositRedeemListener] live ValidatorRedeemClaimed failed:'), e?.message ?? String(e))
		})
	})

	c.on('NodeValidatorBeneficiaryUpdated', (nodeWallet, pubkeyHash, _fromBeneficiary, toBeneficiary, ev) => {
		const blockNumber = (ev as { log?: { blockNumber?: number } })?.log?.blockNumber ?? 0
		if (!shouldHandleLiveListenerBlock(blockNumber)) return
		noteListenerBlock(contract, blockNumber)
		void executeFeeRecipientHotUpdate({
			contract,
			nodeWallet: ethers.getAddress(String(nodeWallet)),
			toBeneficiary: ethers.getAddress(String(toBeneficiary)),
			pubkeyHash: String(pubkeyHash),
		}).catch((e: any) => {
			logger(Colors.red('[validatorDepositRedeemListener] fee_recipient hot-update failed:'), e?.message ?? String(e))
		})
	})

	c.on('FullExitRequested', (beneficiary, nodeWallets, ev) => {
		const blockNumber = (ev as { log?: { blockNumber?: number } })?.log?.blockNumber ?? 0
		if (!shouldHandleLiveListenerBlock(blockNumber)) return
		noteListenerBlock(contract, blockNumber)
		void executeValidatorFullExit({
			contract,
			beneficiary: ethers.getAddress(String(beneficiary)),
			nodeWallets: (nodeWallets as string[]).map((w) => ethers.getAddress(String(w))),
		}).catch((e: any) => {
			logger(Colors.red('[validatorDepositRedeemListener] full exit failed:'), e?.message ?? String(e))
		})
	})
}

/** After live attach: next block live owns; checkpoint = that block - 1; backfill fills only below. */
async function resolveLiveListenBoundary(provider: ethers.JsonRpcProvider): Promise<{
	liveListenFromBlock: number
	checkpointBlock: number
}> {
	const head = await provider.getBlockNumber()
	const liveFrom = head + 1
	return { liveListenFromBlock: liveFrom, checkpointBlock: liveFrom - 1 }
}

async function bootstrapValidatorDepositRedeemListener(): Promise<void> {
	const contract = resolveValidatorDepositRedeemAddress()
	const nodeIp = resolveValidatorNodeIp()
	if (!contract || !nodeIp) {
		logger(Colors.red('[validatorDepositRedeemListener] missing contract or nodeIp'))
		return
	}
	const provider = conetProvider()
	const deployFloor = resolveListenerDeployBlockFloor()
	const priorSaved = loadListenerBlockCheckpoint(contract, deployFloor)

	const c = new ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider)
	attachValidatorDepositRedeemLiveListeners(c, contract, nodeIp)

	const { liveListenFromBlock: liveFrom, checkpointBlock } = await resolveLiveListenBoundary(provider)
	liveListenFromBlock = liveFrom
	saveListenerBlockCheckpoint(contract, checkpointBlock)
	logger(
		Colors.green(
			`[validatorDepositRedeemListener] live from block ${liveFrom}; checkpoint=${checkpointBlock} (prior=${priorSaved ?? 'none'})`
		)
	)

	void runValidatorDepositRedeemListenerBackfill(
		contract,
		nodeIp,
		priorSaved,
		checkpointBlock,
		deployFloor,
		liveFrom
	).catch((e: any) => {
		logger(Colors.red('[validatorDepositRedeemListener] backfill failed:'), e?.message ?? String(e))
	})
}

export function startValidatorDepositRedeemListener(): void {
	if (listenerStarted) return
	listenerStarted = true
	if (process.env.CONET_VALIDATOR_REDEEM_LISTENER !== '1') {
		logger(Colors.yellow('[validatorDepositRedeemListener] disabled; set CONET_VALIDATOR_REDEEM_LISTENER=1'))
		return
	}
	void bootstrapValidatorDepositRedeemListener().catch((e: any) => {
		logger(Colors.red('[validatorDepositRedeemListener] bootstrap failed:'), e?.message ?? String(e))
	})
}
