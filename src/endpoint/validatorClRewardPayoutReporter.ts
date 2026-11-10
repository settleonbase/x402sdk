/**
 * CL consensus-layer skim payout reporter: scans execution-layer block withdrawals
 * credited to ValidatorDepositRedeem proxy, maps validatorIndex → guardianId → current beneficiary,
 * and calls {settleNodeRewards} on-chain (idempotent eventKey per withdrawal).
 *
 * Restart / catch-up semantics (see beamio-chain-listener-block-scan-ceiling.mdc):
 * - Each scan session snapshots chain head once into state.scanTargetBlock (ceiling).
 * - While lastProcessedBlock < scanTargetBlock, ticks only advance toward that ceiling — never
 *   re-read live head and extend the range mid-catch-up (restart-safe).
 * - After caught up, the next tick starts a new session with a fresh scanTargetBlock = live head.
 * - Each tick processes at most CHUNKS_PER_TICK × CHUNK_BLOCKS blocks (default 1×32).
 *
 * Pending pool + cross-block batching:
 * - Scanned withdrawals are merged into a persisted pending pool (dedupe by eventKey).
 * - Checkpoint advances after a block is successfully scanned into the pool (settle may lag).
 * - Flush submits settleNodeRewards through the dedicated signer socket
 *   (signer_sendTransaction). Missing socket or keyArray fails closed.
 *   There is no Settle_ConetPool / withSettleWallet fallback.
 * - If estimateGas / submit fails for n>1, auto-bisect and retry both halves (never stall the
 *   whole pending pool on one oversized batch). A singleton that still fails is skipped for this
 *   flush round and retried later; remaining batches continue.
 * - If gas stays above max for longer than the force-wait window (default 3 min), flush anyway
 *   at the live gasPrice to drain the pending pool (countdown logged while waiting).
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { masterSetup, resolveBeamioConetHttpRpcUrl } from '../util'
import { CONET_VALIDATOR_NODE_ONCHAIN_LANE, enqueueOnchainTxWork } from '../onchainTxSerialQueue'
import {
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK,
} from '../chainAddresses'
import { resolveValidatorDepositRedeemAddress } from './validatorDepositRedeem'
import { readVdrSignerConfig, sendConfiguredSettle } from './vdrPayoutSigner'

const PAYOUT_ABI = [
	'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys) external',
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
] as const

function resolveClaimRpcUrl(): string {
	return (
		process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
		masterSetup.validatorDeposit?.rpcUrl ||
		resolveBeamioConetHttpRpcUrl()
	)
}

function resolveClaimRpcHttpTimeoutMs(): number {
	const n = Number(process.env.CONET_RPC_HTTP_TIMEOUT_MS || 60_000)
	return Number.isFinite(n) && n >= 5_000 ? Math.min(300_000, Math.floor(n)) : 60_000
}

function resolveClaimTxWaitTimeoutMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_TX_WAIT_MS || 120_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.min(600_000, Math.floor(n)) : 120_000
}

function createClaimRpcProvider(): ethers.JsonRpcProvider {
	const req = new ethers.FetchRequest(resolveClaimRpcUrl())
	req.timeout = resolveClaimRpcHttpTimeoutMs()
	return new ethers.JsonRpcProvider(req, undefined, { staticNetwork: true, batchMaxCount: 1 })
}

type PendingEntryJson = {
	guardianId: string
	amount: string
	eventKey: string
	blockNumber: number
	withdrawalIndex: number
}

type ClPayoutState = {
	lastProcessedBlock: number
	/** Chain head snapshot at scan-session start; catch-up scans through this block only. */
	scanTargetBlock?: number
	/** Unsettled payout entries keyed by eventKey (persisted across restarts). */
	pending?: PendingEntryJson[]
	/**
	 * Withdrawals whose validator index could not be mapped to a pubkey.
	 * The scan cursor stays before their block so the next tick retries them.
	 */
	retryQueue?: UnresolvedWithdrawal[]
	/**
	 * ISO timestamp when pending first hit a gasPrice > max gate (persisted).
	 * Cleared when pending is empty or gas drops back under the cap.
	 */
	gasWaitStartedAt?: string
	updatedAt: string
}

type BlockWithdrawal = {
	index: string
	validatorIndex: string
	address: string
	amount: string
}

type RpcBlock = {
	number?: string
	withdrawals?: BlockWithdrawal[]
}

type PayoutEntry = {
	guardianId: bigint
	amount: bigint
	eventKey: string
	blockNumber: number
	withdrawalIndex: number
}

export type UnresolvedWithdrawal = {
	blockNumber: number
	withdrawalIndex: number
	validatorIndex: number
}

type BlockScan = {
	entries: PayoutEntry[]
	unresolved: UnresolvedWithdrawal[]
}

let payoutStarted = false
let payoutTimer: ReturnType<typeof setTimeout> | undefined
let payoutInFlight = false

function resolveStateFile(): string {
	return (
		process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-validator-cl-reward-payout-state.json')
	)
}

function resolveBeaconRestUrl(): string {
	return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '')
}

function resolveTickMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_TICK_MS || 60_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000
}

function resolveChunkBlocks(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNK_BLOCKS || 32)
	return Number.isFinite(n) && n >= 1 ? Math.min(512, Math.floor(n)) : 32
}

/** Max eth_getBlock chunks processed per tick (default 1 — avoids monopolizing on-chain queue). */
function resolveChunksPerTick(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNKS_PER_TICK || 1)
	return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 1
}

/** Hard cap on entries per settleNodeRewards tx (before gas/calldata split). */
function resolveMaxEntriesPerTx(): number {
	// Measured on CONET mainnet (2026-08): n=40 estimateGas ≈ 2.29M > 2M gasLimit (OOG);
	// n=64 ≈ 2.43M; n=48 ≈ 1.83M. Default 29 keeps ~1.66M est + 20% buffer under 2M.
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES || 29)
	return Number.isFinite(n) && n >= 1 ? Math.min(256, Math.floor(n)) : 29
}

function resolveGasLimit(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT || 2_000_000)
	return Number.isFinite(n) && n >= 100_000 ? Math.min(8_000_000, Math.floor(n)) : 2_000_000
}

/** Conservative gas model for pre-split (mainnet estimateGas ≈ 100k + ~55k/entry incl. period accumulate). */
function resolveGasBase(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_BASE || 100_000)
	return Number.isFinite(n) && n >= 21_000 ? Math.floor(n) : 100_000
}

function resolveGasPerEntry(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_PER_ENTRY || 55_000)
	return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : 55_000
}

/** Max calldata bytes per tx (RPC / node limits); leave headroom under common 128KiB caps. */
function resolveMaxCalldataBytes(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_CALLDATA_BYTES || 48_000)
	return Number.isFinite(n) && n >= 2_000 ? Math.min(100_000, Math.floor(n)) : 48_000
}

/** Approx ABI encoding size per entry across three dynamic arrays. */
function resolveCalldataBytesPerEntry(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CALLDATA_PER_ENTRY || 128)
	return Number.isFinite(n) && n >= 64 ? Math.floor(n) : 128
}

/**
 * Only submit when eth_gasPrice ≤ this many gwei (default 2).
 * CONET often sits at exactly 2.0 gwei — use ≤ not <.
 */
function resolveMaxGasPriceWei(): bigint {
	const gwei = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_GAS_PRICE_GWEI || 2)
	const safe = Number.isFinite(gwei) && gwei > 0 ? gwei : 2
	return ethers.parseUnits(String(safe), 'gwei')
}

/** After this many ms waiting on high gas, force flush at live gasPrice (default 3 min). */
function resolveGasWaitForceMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_WAIT_FORCE_MS || 180_000)
	return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 180_000
}

function clearGasWait(state: ClPayoutState): boolean {
	if (!state.gasWaitStartedAt) return false
	delete state.gasWaitStartedAt
	return true
}

function formatWaitCountdown(elapsedMs: number, forceMs: number): string {
	const leftMs = Math.max(0, forceMs - elapsedMs)
	const elapsedSec = Math.floor(elapsedMs / 1000)
	const leftSec = Math.ceil(leftMs / 1000)
	const forceSec = Math.floor(forceMs / 1000)
	return `${elapsedSec}s/${forceSec}s (force in ${leftSec}s)`
}

function normalizeRetryQueue(raw: unknown): UnresolvedWithdrawal[] | undefined {
	if (!Array.isArray(raw)) return undefined
	const out: UnresolvedWithdrawal[] = []
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue
		const row = item as UnresolvedWithdrawal
		const blockNumber = Number(row.blockNumber)
		const withdrawalIndex = Number(row.withdrawalIndex)
		const validatorIndex = Number(row.validatorIndex)
		if (!Number.isInteger(blockNumber) || blockNumber < 0) continue
		if (!Number.isInteger(withdrawalIndex) || withdrawalIndex < 0) continue
		if (!Number.isInteger(validatorIndex) || validatorIndex < 0) continue
		out.push({ blockNumber, withdrawalIndex, validatorIndex })
	}
	return out
}

function normalizeScanTargetBlock(raw: unknown): number | undefined {
	if (raw == null) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/** True when catch-up to the persisted ceiling is complete (or no ceiling yet). */
function isScanCatchUpComplete(state: ClPayoutState): boolean {
	const target = normalizeScanTargetBlock(state.scanTargetBlock)
	if (target == null) return true
	return state.lastProcessedBlock >= target
}

function payoutDryRun(): boolean {
	const v = (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase()
	return v === '1' || v === 'true' || v === 'yes'
}

function payoutEnabled(): boolean {
	if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT === '0') return false
	if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT === '1') return true
	return process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1'
}

function resolveDeployBlockFloor(): number {
	const env =
		process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK?.trim() ||
		process.env.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK?.trim()
	if (env) {
		const n = Number(env)
		if (Number.isFinite(n) && n >= 0) return Math.floor(n)
	}
	return CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK
}

function entryToJson(e: PayoutEntry): PendingEntryJson {
	return {
		guardianId: e.guardianId.toString(),
		amount: e.amount.toString(),
		eventKey: e.eventKey.toLowerCase(),
		blockNumber: e.blockNumber,
		withdrawalIndex: e.withdrawalIndex,
	}
}

function entryFromJson(raw: PendingEntryJson): PayoutEntry | null {
	try {
		const eventKey = String(raw.eventKey || '').toLowerCase()
		if (!eventKey || eventKey === ethers.ZeroHash) return null
		const guardianId = BigInt(raw.guardianId)
		const amount = BigInt(raw.amount)
		if (guardianId <= 0n || amount <= 0n) return null
		const blockNumber = Number(raw.blockNumber)
		const withdrawalIndex = Number(raw.withdrawalIndex)
		if (!Number.isFinite(blockNumber) || !Number.isFinite(withdrawalIndex)) return null
		return { guardianId, amount, eventKey, blockNumber, withdrawalIndex }
	} catch {
		return null
	}
}

function loadPendingMap(state: ClPayoutState): Map<string, PayoutEntry> {
	const map = new Map<string, PayoutEntry>()
	for (const raw of state.pending ?? []) {
		const e = entryFromJson(raw)
		if (!e) continue
		map.set(e.eventKey, e)
	}
	return map
}

function persistPending(state: ClPayoutState, pending: Map<string, PayoutEntry>): void {
	state.pending = [...pending.values()]
		.sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
		.map(entryToJson)
	writeState(state)
}

function mergeIntoPending(pending: Map<string, PayoutEntry>, entries: PayoutEntry[]): number {
	let added = 0
	for (const e of entries) {
		const key = e.eventKey.toLowerCase()
		if (pending.has(key)) continue
		pending.set(key, { ...e, eventKey: key })
		added++
	}
	return added
}

/**
 * Split entries so each batch respects max entries, estimated gas, and calldata size.
 * Never returns a batch larger than the configured on-chain interaction limits.
 */
function splitEntriesForOnchain(entries: PayoutEntry[]): PayoutEntry[][] {
	if (!entries.length) return []
	const maxEntries = resolveMaxEntriesPerTx()
	const gasLimit = resolveGasLimit()
	const gasBase = resolveGasBase()
	const gasPer = resolveGasPerEntry()
	const maxCalldata = resolveMaxCalldataBytes()
	const calldataPer = resolveCalldataBytesPerEntry()
	// Keep ~15% gas headroom under configured gasLimit.
	const gasBudget = Math.floor(gasLimit * 0.85)
	const maxByGas = Math.max(1, Math.floor((gasBudget - gasBase) / gasPer))
	const maxByCalldata = Math.max(1, Math.floor((maxCalldata - 512) / calldataPer))
	const chunkSize = Math.max(1, Math.min(maxEntries, maxByGas, maxByCalldata))

	const batches: PayoutEntry[][] = []
	for (let i = 0; i < entries.length; i += chunkSize) {
		batches.push(entries.slice(i, i + chunkSize))
	}
	return batches
}

/** estimateGas + 20% headroom; returns null when buffered estimate exceeds configured gasLimit. */
async function resolveSubmitGasLimit(
	contract: ethers.Contract,
	guardianIds: bigint[],
	amounts: bigint[],
	eventKeys: string[]
): Promise<number | null> {
	const cap = resolveGasLimit()
	try {
		const est = await contract.settleNodeRewards!.estimateGas(guardianIds, amounts, eventKeys)
		const buffered = (est * 120n) / 100n + 50_000n
		if (buffered > BigInt(cap)) return null
		return Number(buffered)
	} catch {
		return cap
	}
}

function readState(): ClPayoutState {
	const file = resolveStateFile()
	try {
		if (!fs.existsSync(file)) {
			return { lastProcessedBlock: resolveDeployBlockFloor() - 1, pending: [], updatedAt: new Date().toISOString() }
		}
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ClPayoutState
		const floor = resolveDeployBlockFloor()
		const last = Number(raw.lastProcessedBlock)
		if (!Number.isFinite(last)) {
			return { lastProcessedBlock: floor - 1, pending: [], updatedAt: new Date().toISOString() }
		}
		const scanTargetBlock = normalizeScanTargetBlock(raw.scanTargetBlock)
		const pending = Array.isArray(raw.pending) ? raw.pending : []
		const retryQueue = normalizeRetryQueue(raw.retryQueue)
		const gasWaitStartedAt =
			typeof raw.gasWaitStartedAt === 'string' && raw.gasWaitStartedAt.trim()
				? raw.gasWaitStartedAt.trim()
				: undefined
		return {
			lastProcessedBlock: Math.max(floor - 1, Math.floor(last)),
			scanTargetBlock,
			pending,
			retryQueue,
			gasWaitStartedAt,
			updatedAt: raw.updatedAt ?? new Date().toISOString(),
		}
	} catch (e: unknown) {
		logger(Colors.yellow(`[validatorClRewardPayout] state reset: ${(e as Error)?.message ?? e}`))
		return { lastProcessedBlock: resolveDeployBlockFloor() - 1, pending: [], updatedAt: new Date().toISOString() }
	}
}

function writeState(state: ClPayoutState): void {
	const file = resolveStateFile()
	state.updatedAt = new Date().toISOString()
	if (!Array.isArray(state.pending)) state.pending = []
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

const validatorPubkeyCache = new Map<number, string | null>()

async function fetchValidatorPubkeyByIndex(validatorIndex: number): Promise<string | null> {
	const cached = validatorPubkeyCache.get(validatorIndex)
	if (cached) return cached
	const base = resolveBeaconRestUrl()
	const url = `${base}/eth/v1/beacon/states/head/validators/${validatorIndex}`
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
		if (!res.ok) return null
		const json = (await res.json()) as { data?: { validator?: { pubkey?: string } } }
		const pk = json?.data?.validator?.pubkey?.trim()
		if (!pk) return null
		const normalized = ethers.hexlify(ethers.getBytes(pk.startsWith('0x') ? pk : `0x${pk}`)).toLowerCase()
		validatorPubkeyCache.set(validatorIndex, normalized)
		return normalized
	} catch {
		return null
	}
}

async function fetchBlockWithWithdrawals(
	provider: ethers.JsonRpcProvider,
	blockNumber: number
): Promise<RpcBlock | null> {
	try {
		const hex = ethers.toQuantity(blockNumber)
		const block = (await provider.send('eth_getBlockByNumber', [hex, false])) as RpcBlock | null
		return block
	} catch {
		return null
	}
}

function withdrawalEventKey(blockNumber: number, withdrawalIndex: number): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(blockNumber), BigInt(withdrawalIndex)])
	)
}

async function resolvePayableGuardianId(
	contract: ethers.Contract,
	pubkey: string
): Promise<bigint | null | 'unresolved'> {
	const pkHash = ethers.keccak256(pubkey)
	try {
		const guardianId = await contract.getNodeByValidatorPubkeyHash!(pkHash)
		const gid = BigInt(guardianId)
		if (gid <= 0n) return null
		// adminRelease clears beneficiary; legacy pubkey→gid mapping may remain (Lab 136 341–476).
		const beneficiary = String(await contract.guardianIdBeneficiary!(gid))
		if (beneficiary === ethers.ZeroAddress) return null
		return gid
	} catch {
		return 'unresolved'
	}
}

async function collectPayoutEntriesForBlock(
	contract: ethers.Contract,
	proxyLower: string,
	blockNumber: number,
	block: RpcBlock,
	lookupPubkey: (validatorIndex: number) => Promise<string | null>
): Promise<BlockScan> {
	const withdrawals = block.withdrawals ?? []
	const entries: PayoutEntry[] = []
	const unresolved: UnresolvedWithdrawal[] = []
	for (const w of withdrawals) {
		const addr = String(w.address ?? '').toLowerCase()
		if (addr !== proxyLower) continue
		const amountGwei = BigInt(String(w.amount ?? '0'))
		if (amountGwei <= 0n) continue
		const amountWei = amountGwei * 1_000_000_000n
		const validatorIndex = Number(w.validatorIndex)
		if (!Number.isFinite(validatorIndex) || validatorIndex < 0) continue
		const withdrawalIndex = Number(w.index)
		if (!Number.isFinite(withdrawalIndex) || withdrawalIndex < 0) continue

		const pubkey = await lookupPubkey(validatorIndex)
		if (!pubkey) {
			unresolved.push({ blockNumber, withdrawalIndex, validatorIndex })
			continue
		}
		const guardianId = await resolvePayableGuardianId(contract, pubkey)
		if (guardianId === 'unresolved') {
			unresolved.push({ blockNumber, withdrawalIndex, validatorIndex })
			continue
		}
		if (guardianId == null) continue

		entries.push({
			guardianId,
			amount: amountWei,
			eventKey: withdrawalEventKey(blockNumber, withdrawalIndex).toLowerCase(),
			blockNumber,
			withdrawalIndex,
		})
	}
	return { entries, unresolved }
}

async function waitForSignerReceipt(
	provider: ethers.JsonRpcProvider,
	hash: string,
	timeoutMs: number
): Promise<ethers.TransactionReceipt> {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const receipt = await provider.getTransactionReceipt(hash)
		if (receipt) return receipt
		await new Promise((resolve) => setTimeout(resolve, 1_500))
	}
	throw new Error(`signer tx receipt timed out hash=${hash}`)
}

async function readGasPriceWei(provider: ethers.JsonRpcProvider): Promise<bigint> {
	try {
		const fee = await provider.getFeeData()
		if (fee.gasPrice != null && fee.gasPrice > 0n) return fee.gasPrice
		if (fee.maxFeePerGas != null && fee.maxFeePerGas > 0n) return fee.maxFeePerGas
	} catch {
		/* fall through */
	}
	const hex = (await provider.send('eth_gasPrice', [])) as string
	return BigInt(hex)
}

async function filterUnconsumed(
	readContract: ethers.Contract,
	entries: PayoutEntry[]
): Promise<PayoutEntry[]> {
	const out: PayoutEntry[] = []
	for (const e of entries) {
		try {
			const consumed = Boolean(await readContract.consumedRewardEventKey!(e.eventKey))
			if (consumed) continue
		} catch {
			// If the read fails, keep the entry and let the chain reject duplicates.
		}
		out.push(e)
	}
	return out
}

/** Outcome of one on-chain settle attempt (before auto-bisect). */
type SubmitOutcome = 'ok' | 'needs_split' | 'failed'

async function submitPayoutBatchOnchain(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint
): Promise<SubmitOutcome> {
	if (!entries.length) return 'ok'
	const guardianIds = entries.map((e) => e.guardianId)
	const amounts = entries.map((e) => e.amount)
	const eventKeys = entries.map((e) => e.eventKey)

	if (payoutDryRun()) {
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] dry-run settleNodeRewards n=${entries.length} total=${ethers.formatEther(
					amounts.reduce((a, b) => a + b, 0n)
				)} CNET`
			)
		)
		return 'ok'
	}

	if (!readVdrSignerConfig()) {
		logger(
			Colors.red(
				'[validatorClRewardPayout] refuse settleNodeRewards: signer socket or keyArray is not configured'
			)
		)
		return 'failed'
	}

	const provider = createClaimRpcProvider()
	const readContract = new ethers.Contract(contractAddr, PAYOUT_ABI, provider)
	const gasLimit = await resolveSubmitGasLimit(readContract, guardianIds, amounts, eventKeys)
	if (gasLimit == null) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] estimateGas+20% exceeds gasLimit=${resolveGasLimit()} for n=${entries.length} — will auto-split`
			)
		)
		return 'needs_split'
	}

	try {
		const { hash } = await sendConfiguredSettle({
			to: contractAddr,
			guardianIds,
			amounts,
			eventKeys,
			gasLimit,
		})
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] settleNodeRewards sent via signer tx=${hash} waiting≤${resolveClaimTxWaitTimeoutMs()}ms n=${entries.length} gasPrice=${ethers.formatUnits(gasPriceWei, 'gwei')}gwei`
			)
		)
		const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
		if (receipt.status !== 1) {
			throw new Error(`settleNodeRewards reverted status=${receipt.status} hash=${hash}`)
		}
		logger(Colors.green(`[validatorClRewardPayout] settleNodeRewards ok tx=${hash} n=${entries.length}`))
		return 'ok'
	} catch (e: unknown) {
		logger(Colors.red(`[validatorClRewardPayout] settleNodeRewards signer failed: ${(e as Error)?.message ?? e}`))
		return 'failed'
	}
}

async function submitPayoutBatch(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint
): Promise<SubmitOutcome> {
	if (!entries.length) return 'ok'
	const outcome = await enqueueOnchainTxWork(
		CONET_VALIDATOR_NODE_ONCHAIN_LANE,
		`settleNodeRewards n=${entries.length}`,
		async () => submitPayoutBatchOnchain(contractAddr, entries, gasPriceWei),
		'[validatorClRewardPayout]'
	)
	return outcome ?? 'failed'
}

/**
 * Submit a batch; on estimate/tx failure with n>1, bisect and retry both halves.
 * Singleton hard-failures stay in pending for a later tick so the rest of the pool can drain.
 */
async function submitPayoutBatchAutoSplit(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint,
	state: ClPayoutState,
	pending: Map<string, PayoutEntry>
): Promise<void> {
	if (!entries.length) return

	const outcome = await submitPayoutBatch(contractAddr, entries, gasPriceWei)
	if (outcome === 'ok') {
		for (const e of entries) pending.delete(e.eventKey)
		persistPending(state, pending)
		return
	}

	if (entries.length === 1) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] singleton settle failed (${outcome}); leave in pending and continue (eventKey=${entries[0]!.eventKey.slice(0, 18)}…)`
			)
		)
		return
	}

	const mid = Math.max(1, Math.floor(entries.length / 2))
	const left = entries.slice(0, mid)
	const right = entries.slice(mid)
	logger(
		Colors.yellow(
			`[validatorClRewardPayout] auto-split n=${entries.length} → ${left.length}+${right.length} (reason=${outcome})`
		)
	)
	await submitPayoutBatchAutoSplit(contractAddr, left, gasPriceWei, state, pending)
	await submitPayoutBatchAutoSplit(contractAddr, right, gasPriceWei, state, pending)
}

/**
 * Scan [fromBlock, toBlock] into the pending pool. Advances through contiguous
 * blocks whose VDR withdrawals are fully mapped. A missing pubkey stops the
 * cursor before that block and returns the withdrawal on the retry queue.
 * Does not submit on-chain — flushPendingBatches does that.
 */
export async function scanBlocksIntoPending(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	proxyAddr: string,
	fromBlock: number,
	toBlock: number,
	pending: Map<string, PayoutEntry>,
	lookupPubkey: (validatorIndex: number) => Promise<string | null> = fetchValidatorPubkeyByIndex
): Promise<{ okThrough: number | null; added: number; fetchFailed: boolean; unresolved: UnresolvedWithdrawal[] }> {
	const proxyLower = proxyAddr.toLowerCase()
	let okThrough: number | null = null
	let added = 0
	const unresolved: UnresolvedWithdrawal[] = []
	for (let bn = fromBlock; bn <= toBlock; bn++) {
		const block = await fetchBlockWithWithdrawals(provider, bn)
		if (!block) {
			return { okThrough, added, fetchFailed: true, unresolved }
		}
		const scanned = await collectPayoutEntriesForBlock(readContract, proxyLower, bn, block, lookupPubkey)
		added += mergeIntoPending(pending, scanned.entries)
		if (scanned.unresolved.length) {
			unresolved.push(...scanned.unresolved)
			return { okThrough, added, fetchFailed: false, unresolved }
		}
		okThrough = bn
	}
	return { okThrough, added, fetchFailed: false, unresolved }
}

async function flushPendingBatches(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	contractAddr: string,
	state: ClPayoutState,
	pending: Map<string, PayoutEntry>
): Promise<void> {
	if (!pending.size) {
		if (clearGasWait(state)) persistPending(state, pending)
		return
	}

	const maxGas = resolveMaxGasPriceWei()
	// CONET often reports eth_gasPrice as 2.000000007 gwei — allow tiny dust above configured max.
	const gasDustWei = 50_000_000n // 0.05 gwei
	const gasPrice = await readGasPriceWei(provider)
	const forceMs = resolveGasWaitForceMs()
	let forceFlush = false

	if (gasPrice > maxGas + gasDustWei) {
		const now = Date.now()
		if (!state.gasWaitStartedAt) {
			state.gasWaitStartedAt = new Date(now).toISOString()
			persistPending(state, pending)
		}
		const startedMs = Date.parse(state.gasWaitStartedAt)
		const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : forceMs
		if (elapsedMs < forceMs) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] skip flush: gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei > max=${ethers.formatUnits(maxGas, 'gwei')} gwei ` +
						`wait ${formatWaitCountdown(elapsedMs, forceMs)} pending=${pending.size}`
				)
			)
			return
		}
		forceFlush = true
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] force flush: gas wait ${Math.floor(elapsedMs / 1000)}s ≥ ${Math.floor(forceMs / 1000)}s; ` +
					`ignoring max=${ethers.formatUnits(maxGas, 'gwei')} gwei, using live gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei (pending=${pending.size})`
			)
		)
	} else if (clearGasWait(state)) {
		persistPending(state, pending)
	}

	const ordered = [...pending.values()].sort(
		(a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex
	)
	const live = await filterUnconsumed(readContract, ordered)
	if (live.length !== ordered.length) {
		const liveKeys = new Set(live.map((e) => e.eventKey))
		for (const e of ordered) {
			if (!liveKeys.has(e.eventKey)) pending.delete(e.eventKey)
		}
		persistPending(state, pending)
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] dropped ${ordered.length - live.length} already-consumed eventKeys; pending=${pending.size}`
			)
		)
	}
	if (!live.length) {
		if (clearGasWait(state)) persistPending(state, pending)
		return
	}

	const batches = splitEntriesForOnchain(live)
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] flush pending=${live.length} → ${batches.length} batch(es) ` +
				`(maxEntries=${resolveMaxEntriesPerTx()} estGas/entry=${resolveGasPerEntry()} gasLimit=${resolveGasLimit()} ` +
				`gasPrice=${ethers.formatUnits(gasPrice, 'gwei')}gwei${forceFlush ? ' force=1' : ''})`
		)
	)

	for (const batch of batches) {
		// Heuristic pre-split is a first cut; real estimateGas may still exceed gasLimit.
		// Always go through auto-split so oversized / reverted batches bisect instead of stalling.
		await submitPayoutBatchAutoSplit(contractAddr, batch, gasPrice, state, pending)
	}

	if (!pending.size && clearGasWait(state)) persistPending(state, pending)
}

async function payoutTick(): Promise<void> {
	if (payoutInFlight) return
	payoutInFlight = true
	try {
		const proxyAddr = resolveValidatorDepositRedeemAddress()
		if (!proxyAddr) {
			logger(Colors.yellow('[validatorClRewardPayout] CONET_VALIDATOR_DEPOSIT_REDEEM not configured — skip'))
			return
		}

		const provider = createClaimRpcProvider()
		const readContract = new ethers.Contract(proxyAddr, PAYOUT_ABI, provider)

		const floor = resolveDeployBlockFloor()
		const state = readState()
		const pending = loadPendingMap(state)
		const liveHead = Number(await provider.getBlockNumber())
		if (!Number.isFinite(liveHead) || liveHead < floor) return

		// New scan session: snapshot live head once as ceiling. Restart mid-catch-up keeps the prior ceiling.
		if (isScanCatchUpComplete(state)) {
			if (state.scanTargetBlock !== liveHead) {
				state.scanTargetBlock = liveHead
				persistPending(state, pending)
				logger(
					Colors.cyan(
						`[validatorClRewardPayout] new scan session scanTargetBlock=${liveHead} (lastProcessed=${state.lastProcessedBlock} pending=${pending.size})`
					)
				)
			}
		} else {
			logger(
				Colors.cyan(
					`[validatorClRewardPayout] catch-up toward scanTargetBlock=${state.scanTargetBlock} (lastProcessed=${state.lastProcessedBlock}, liveHead=${liveHead}, pending=${pending.size})`
				)
			)
		}

		const scanTargetBlock = state.scanTargetBlock ?? liveHead
		let from = Math.max(floor, state.lastProcessedBlock + 1)
		if (from <= scanTargetBlock) {
			const chunk = resolveChunkBlocks()
			const chunksPerTick = resolveChunksPerTick()
			const maxBlocksThisTick = chunk * chunksPerTick
			const tickEnd = Math.min(from + maxBlocksThisTick - 1, scanTargetBlock)

			logger(
				Colors.cyan(
					`[validatorClRewardPayout] scan blocks ${from}..${tickEnd} (target=${scanTargetBlock}, liveHead=${liveHead}, floor=${floor}, proxy=${proxyAddr.slice(0, 10)}…)`
				)
			)

			while (from <= tickEnd) {
				const to = Math.min(from + chunk - 1, tickEnd)
				const { okThrough, added, fetchFailed, unresolved } = await scanBlocksIntoPending(
					provider,
					readContract,
					proxyAddr,
					from,
					to,
					pending
				)
				if (okThrough != null) state.lastProcessedBlock = okThrough
				state.retryQueue = unresolved
				if (okThrough != null || added > 0 || unresolved.length > 0) {
					persistPending(state, pending)
					if (added > 0) {
						logger(
							Colors.cyan(
								`[validatorClRewardPayout] queued +${added} into pending (pending=${pending.size}) through ${from}..${okThrough ?? from - 1}`
							)
						)
					}
				}
				if (unresolved.length > 0) {
					logger(
						Colors.yellow(
							`[validatorClRewardPayout] scan stop before block ${unresolved[0]!.blockNumber}: ${unresolved.length} pubkey mapping(s) unresolved; will retry next tick`
						)
					)
					break
				}
				if (fetchFailed || okThrough == null || okThrough < to) {
					logger(
						Colors.yellow(
							`[validatorClRewardPayout] scan stop at ${okThrough ?? from - 1} (fetch failed); will retry next tick`
						)
					)
					break
				}
				from = to + 1
			}
		}

		await flushPendingBatches(provider, readContract, proxyAddr, state, pending)
	} catch (e: unknown) {
		logger(Colors.red(`[validatorClRewardPayout] tick error: ${(e as Error)?.message ?? e}`))
	} finally {
		payoutInFlight = false
	}
}

function scheduleNextPayoutTick(): void {
	if (!payoutStarted) return
	payoutTimer = setTimeout(async () => {
		await payoutTick()
		scheduleNextPayoutTick()
	}, resolveTickMs())
}

export function startValidatorClRewardPayoutReporter(): void {
	if (payoutStarted) return
	if (!payoutEnabled()) {
		logger(Colors.yellow('[validatorClRewardPayout] disabled (set CONET_VALIDATOR_CL_REWARD_PAYOUT=1)'))
		return
	}
	payoutStarted = true
	const proxy = resolveValidatorDepositRedeemAddress() || CONET_VALIDATOR_DEPOSIT_REDEEM
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] starting proxy=${proxy || 'unset'} floor=${resolveDeployBlockFloor()} tick=${resolveTickMs()}ms ` +
				`maxEntries=${resolveMaxEntriesPerTx()} maxGasGwei=${ethers.formatUnits(resolveMaxGasPriceWei(), 'gwei')} ` +
				`gasWaitForceMs=${resolveGasWaitForceMs()} pendingPool=on`
		)
	)
	void payoutTick().finally(() => scheduleNextPayoutTick())
}

export function stopValidatorClRewardPayoutReporter(): void {
	payoutStarted = false
	if (payoutTimer !== undefined) {
		clearTimeout(payoutTimer)
		payoutTimer = undefined
	}
}
