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
 * - Flush submits settleNodeRewards in split batches when gasPrice ≤ max and settle wallet
 *   has enough balance for gasLimit × gasPrice; failed batches stay in the pool.
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
import { Settle_ContractPool, ensureSettleContractPoolInitialized } from '../settleContractPool'
import { CONET_VALIDATOR_NODE_ONCHAIN_LANE, enqueueOnchainTxWork } from '../onchainTxSerialQueue'
import {
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK,
} from '../chainAddresses'
import { resolveValidatorDepositRedeemAddress } from './validatorDepositRedeem'

ensureSettleContractPoolInitialized()

const PAYOUT_ABI = [
	'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys) external',
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
] as const

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
	// Measured on CONET mainnet: n=64 ≈ 2.43M gas > default 2M limit (reverts); n=48 ≈ 1.83M.
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES || 40)
	return Number.isFinite(n) && n >= 1 ? Math.min(256, Math.floor(n)) : 40
}

function resolveGasLimit(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT || 2_000_000)
	return Number.isFinite(n) && n >= 100_000 ? Math.min(8_000_000, Math.floor(n)) : 2_000_000
}

/** Conservative gas model for pre-split (mainnet estimateGas ≈ 93k + ~37k/entry). */
function resolveGasBase(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_BASE || 100_000)
	return Number.isFinite(n) && n >= 21_000 ? Math.floor(n) : 100_000
}

function resolveGasPerEntry(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_PER_ENTRY || 40_000)
	return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : 40_000
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

function estimateBatchGas(n: number): number {
	return resolveGasBase() + resolveGasPerEntry() * n
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
		const gasWaitStartedAt =
			typeof raw.gasWaitStartedAt === 'string' && raw.gasWaitStartedAt.trim()
				? raw.gasWaitStartedAt.trim()
				: undefined
		return {
			lastProcessedBlock: Math.max(floor - 1, Math.floor(last)),
			scanTargetBlock,
			pending,
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
	if (validatorPubkeyCache.has(validatorIndex)) {
		return validatorPubkeyCache.get(validatorIndex) ?? null
	}
	const base = resolveBeaconRestUrl()
	const url = `${base}/eth/v1/beacon/states/head/validators/${validatorIndex}`
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
		if (!res.ok) {
			validatorPubkeyCache.set(validatorIndex, null)
			return null
		}
		const json = (await res.json()) as { data?: { validator?: { pubkey?: string } } }
		const pk = json?.data?.validator?.pubkey?.trim()
		if (!pk) {
			validatorPubkeyCache.set(validatorIndex, null)
			return null
		}
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

async function resolveGuardianIdForWithdrawal(
	contract: ethers.Contract,
	validatorIndex: number
): Promise<bigint | null> {
	const pubkey = await fetchValidatorPubkeyByIndex(validatorIndex)
	if (!pubkey) return null

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
		return null
	}
}

async function collectPayoutEntriesForBlock(
	contract: ethers.Contract,
	proxyLower: string,
	blockNumber: number,
	block: RpcBlock
): Promise<PayoutEntry[]> {
	const withdrawals = block.withdrawals ?? []
	const entries: PayoutEntry[] = []
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

		const guardianId = await resolveGuardianIdForWithdrawal(contract, validatorIndex)
		if (guardianId == null) continue

		entries.push({
			guardianId,
			amount: amountWei,
			eventKey: withdrawalEventKey(blockNumber, withdrawalIndex).toLowerCase(),
			blockNumber,
			withdrawalIndex,
		})
	}
	return entries
}

async function withSettleWallet<T>(label: string, fn: (wallet: (typeof Settle_ContractPool)[number]) => Promise<T>): Promise<T | undefined> {
	if (!Settle_ContractPool.length) return undefined
	const sc = Settle_ContractPool.shift()
	if (!sc) return undefined
	try {
		return await fn(sc)
	} catch (e: unknown) {
		logger(Colors.red(`[validatorClRewardPayout] ${label} failed: ${(e as Error)?.message ?? e}`))
		return undefined
	} finally {
		Settle_ContractPool.unshift(sc)
	}
}

function peekSettleWalletAddress(): string | null {
	const sc = Settle_ContractPool[0]
	const addr = sc?.walletConet?.address
	return addr ? ethers.getAddress(addr) : null
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

async function submitPayoutBatchOnchain(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint
): Promise<boolean> {
	if (!entries.length) return true
	const guardianIds = entries.map((e) => e.guardianId)
	const amounts = entries.map((e) => e.amount)
	const eventKeys = entries.map((e) => e.eventKey)
	const gasLimit = resolveGasLimit()

	if (payoutDryRun()) {
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] dry-run settleNodeRewards n=${entries.length} total=${ethers.formatEther(
					amounts.reduce((a, b) => a + b, 0n)
				)} CNET`
			)
		)
		return true
	}

	const txHash = await withSettleWallet('settleNodeRewards', async (sc) => {
		const c = new ethers.Contract(contractAddr, PAYOUT_ABI, sc.walletConet)
		// Prefer legacy gasPrice: EIP-1559 tip=0 is rejected by some CONET nodes
		// ("tip cap 0, minimum needed 1"); tip=1 wei can enter mempool but never mine
		// while eth_gasPrice stays ~2 gwei. Legacy gasPrice matches the network quote.
		const tx = await c.settleNodeRewards!(guardianIds, amounts, eventKeys, {
			gasLimit,
			gasPrice: gasPriceWei,
		})
		await tx.wait()
		return tx.hash as string
	})

	if (txHash) {
		logger(Colors.green(`[validatorClRewardPayout] settleNodeRewards ok tx=${txHash} n=${entries.length}`))
		return true
	}
	return false
}

async function submitPayoutBatch(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint
): Promise<boolean> {
	if (!entries.length) return true
	return enqueueOnchainTxWork(
		CONET_VALIDATOR_NODE_ONCHAIN_LANE,
		`settleNodeRewards n=${entries.length}`,
		async () => submitPayoutBatchOnchain(contractAddr, entries, gasPriceWei),
		'[validatorClRewardPayout]'
	)
}

/**
 * Scan [fromBlock, toBlock] into the pending pool. Advances through contiguous
 * successfully-fetched blocks; stops (without advancing past) the first fetch failure.
 * Does not submit on-chain — flushPendingBatches does that.
 */
async function scanBlocksIntoPending(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	proxyAddr: string,
	fromBlock: number,
	toBlock: number,
	pending: Map<string, PayoutEntry>
): Promise<{ okThrough: number | null; added: number; fetchFailed: boolean }> {
	const proxyLower = proxyAddr.toLowerCase()
	let okThrough: number | null = null
	let added = 0
	for (let bn = fromBlock; bn <= toBlock; bn++) {
		const block = await fetchBlockWithWithdrawals(provider, bn)
		if (!block) {
			return { okThrough, added, fetchFailed: true }
		}
		const entries = await collectPayoutEntriesForBlock(readContract, proxyLower, bn, block)
		added += mergeIntoPending(pending, entries)
		okThrough = bn
	}
	return { okThrough, added, fetchFailed: false }
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

	const gasLimit = BigInt(resolveGasLimit())
	const intrinsicCost = gasLimit * gasPrice
	const settleAddr = peekSettleWalletAddress()
	if (!settleAddr) {
		logger(Colors.yellow(`[validatorClRewardPayout] skip flush: no settle wallet in pool (pending=${pending.size})`))
		return
	}
	const balance = await provider.getBalance(settleAddr)
	if (balance < intrinsicCost) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] skip flush: settle ${settleAddr} balance=${ethers.formatEther(balance)} < intrinsic=${ethers.formatEther(intrinsicCost)} CNET (gasLimit=${gasLimit}×${ethers.formatUnits(gasPrice, 'gwei')}gwei, pending=${pending.size})`
			)
		)
		return
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
		const est = estimateBatchGas(batch.length)
		if (est > resolveGasLimit()) {
			// Should not happen after split; force singleton re-split as safety.
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] batch n=${batch.length} estGas=${est} exceeds gasLimit; re-splitting`
				)
			)
			const safer = splitEntriesForOnchain(batch)
			for (const sub of safer) {
				const ok = await submitPayoutBatch(contractAddr, sub, gasPrice)
				if (!ok) {
					logger(
						Colors.yellow(
							`[validatorClRewardPayout] batch failed n=${sub.length}; remaining stay in pending pool`
						)
					)
					persistPending(state, pending)
					return
				}
				for (const e of sub) pending.delete(e.eventKey)
				persistPending(state, pending)
			}
			continue
		}

		// Re-check balance before each batch (prior tx may have spent gas).
		const balNow = await provider.getBalance(settleAddr)
		if (balNow < intrinsicCost) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] stop flush mid-way: balance=${ethers.formatEther(balNow)} < intrinsic=${ethers.formatEther(intrinsicCost)} (pending=${pending.size})`
				)
			)
			persistPending(state, pending)
			return
		}

		const ok = await submitPayoutBatch(contractAddr, batch, gasPrice)
		if (!ok) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] batch failed n=${batch.length}; remaining stay in pending pool (pending=${pending.size})`
				)
			)
			persistPending(state, pending)
			return
		}
		for (const e of batch) pending.delete(e.eventKey)
		persistPending(state, pending)
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

		const provider = new ethers.JsonRpcProvider(
			process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
				masterSetup.validatorDeposit?.rpcUrl ||
				resolveBeamioConetHttpRpcUrl()
		)
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
				const { okThrough, added, fetchFailed } = await scanBlocksIntoPending(
					provider,
					readContract,
					proxyAddr,
					from,
					to,
					pending
				)
				if (okThrough != null) {
					state.lastProcessedBlock = okThrough
					persistPending(state, pending)
					if (added > 0) {
						logger(
							Colors.cyan(
								`[validatorClRewardPayout] queued +${added} into pending (pending=${pending.size}) through ${from}..${okThrough}`
							)
						)
					}
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
