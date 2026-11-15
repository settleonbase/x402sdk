/**
 * CL consensus-layer skim payout reporter (VDR production dual-cursor).
 *
 * Dual-line scan (PM-VDR-DUAL-CURSOR-H-2026-11-10):
 * - Lock H = tip−depth once (blockNumber + blockHash); history scans cursor+1…H;
 *   realtime scans H+1…safeTip filling every missing block.
 * - Shared pending + same on-chain eventKey namespace; single settler lane.
 * - Realtime flush priority + historical floor so backlog cannot starve either line.
 * - Enqueue+cursor and settle intents persist via atomic fsync rename.
 * - ACK-lost recovery reuses signer idempotencyKey + request fingerprint (no blind resend).
 *
 * Gas: default 2500000 matches the running .22 unit. Do not clamp to the old 800000 note.
 * Amount: FORCE_BLOCK before settle broadcast — CONET_VDR_PAYOUT_MAX_AMOUNT_WEI
 * defaults to CAP_B 44885338300000000 (0.0448853383 CNET). An entry with
 * amount > CAP is held pending (pre-sign, signer never sees that eventKey,
 * no calldata). Sibling entries each ≤ CAP are packed so every settle tx
 * sum ≤ CAP and count ≤ maxEntries (default 29). A single over-CAP amount
 * is never split into under-CAP txs.
 *
 * First-batch cumulative wei budget (default = CAP_B): selectEntriesUnderFirstBatchBudget
 * takes only rows that fit remainingFirstBatchBudgetWei (settled + in-flight reserve).
 * Deferred rows stay pending (no pool wipe). CONET_VDR_FIRST_BATCH_BUDGET_WEI=0 disables
 * the cumulative gate (per-pack CAP + peel still apply). Per-tx n ≤ resolveMaxEntriesPerTx.
 *
 * Live cutover NOT performed here — enablement remains env-gated for
 * project-owner approval.
 *
 * Observe/enqueue (no sign, no broadcast):
 *   CONET_VALIDATOR_CL_REWARD_PAYOUT_OBSERVE_ENQUEUE=1
 *   CONET_VALIDATOR_CL_REWARD_PAYOUT_OBSERVE_STATE_FILE=<path>
 * Scan, event dedupe, and this mode's own dual cursors still advance.
 * recoverOpenIntents resend and flushPendingBatches are disabled.
 * The signer socket is never loaded. The production state file is not written.
 * This mode starts even when CONET_VALIDATOR_CL_REWARD_PAYOUT=0, and it wins
 * over DRY_RUN (pending is not cleared; uncertain intents are not resent).
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { CONET_VALIDATOR_NODE_ONCHAIN_LANE, enqueueOnchainTxWork } from '../onchainTxSerialQueue'
import {
	CONET_RPC_URL,
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK,
} from '../chainAddresses'
import { partitionByPaidKey } from './clPaidKeyGate'
import {
	buildVdrSignerTx,
	readVdrSignerConfig,
	signerSendOnce,
	type VdrSignerTx,
} from './vdrPayoutSigner'
import {
	type DualCursorState,
	type PendingEntryJson,
	type ScanLine,
	type SettleIntent,
	applyReorgRollback,
	attachIntentToState,
	atomicWriteState,
	commitScanProgress,
	ensureBoundaryH,
	isHistoricalComplete,
	markIntentBroadcast,
	markIntentConfirmed,
	markIntentFailed,
	markIntentUncertain,
	migrateLegacyToDualCursor,
	planFlushOrder,
	planScanRanges,
	prepareSettleIntent,
	rebuildSignerTxFromIntent,
	reconcileAckLostIntent,
	recordRealtimeLatency,
	remainingFirstBatchBudgetWei,
	removePendingKeys,
	resolveConfirmationDepth,
	resolveHistoricalFlushFloor,
	resolveRealtimeFlushQuota,
	withdrawalEventKey,
} from './vdrDualCursor'

const PAYOUT_ABI = [
	'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys) external',
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
] as const

/** Local copy so this module does not import validatorDepositRedeem (settle-pool init). */
function resolveValidatorDepositRedeemAddress(): string | null {
	const raw = (process.env.CONET_VALIDATOR_DEPOSIT_REDEEM || CONET_VALIDATOR_DEPOSIT_REDEEM || '').trim()
	if (!raw) return null
	try {
		const addr = ethers.getAddress(raw)
		return addr === ethers.ZeroAddress ? null : addr
	} catch {
		return null
	}
}

function resolveClaimRpcUrl(): string {
	return (
		process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
		process.env.CONET_RPC_URL?.trim() ||
		CONET_RPC_URL
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

type BlockWithdrawal = {
	index: string
	validatorIndex: string
	address: string
	amount: string
}

type RpcBlock = {
	number?: string
	hash?: string
	withdrawals?: BlockWithdrawal[]
}

type PayoutEntry = {
	guardianId: bigint
	amount: bigint
	eventKey: string
	blockNumber: number
	withdrawalIndex: number
	scanLine?: ScanLine
	enqueuedAtMs?: number
}

function batchSumWei(entries: PayoutEntry[]): bigint {
	return entries.reduce((a, e) => a + e.amount, 0n)
}

/** Below/equal CAP → ok; above → amount_cap_block (caller must not sign/broadcast/split). */
function assertAmountCapOrAbort(entries: PayoutEntry[]): {
	ok: true
	batchSumWei: string
	capWei: string
} | {
	ok: false
	reason: 'amount_cap_block'
	batchSumWei: string
	capWei: string
} {
	const capWei = resolveMaxAmountWei()
	const sum = batchSumWei(entries)
	if (sum > capWei) {
		return {
			ok: false,
			reason: 'amount_cap_block',
			batchSumWei: sum.toString(),
			capWei: capWei.toString(),
		}
	}
	return { ok: true, batchSumWei: sum.toString(), capWei: capWei.toString() }
}

let payoutStarted = false
let payoutTimer: ReturnType<typeof setTimeout> | undefined
let payoutInFlight = false
/** Mutable dual-cursor working copy for the current tick (persisted after mutations). */
let workingState: DualCursorState | null = null

/**
 * Scan + durable enqueue only. No recover resend, no flush, no signer socket.
 * Independent state file; production cursors stay byte-stable.
 */
function payoutObserveEnqueue(): boolean {
	const v = (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_OBSERVE_ENQUEUE || '').trim().toLowerCase()
	return v === '1' || v === 'true' || v === 'yes'
}

function resolveProductionStateFile(): string {
	return (
		process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-validator-cl-reward-payout-state.json')
	)
}

let observeProductionStatePath: string | null = null
let observeProductionStateBytes: Buffer | null = null
let observeProductionStateMissing = false

function assertObserveEnqueueConfig(): void {
	const observeFile = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_OBSERVE_STATE_FILE?.trim()
	if (!observeFile) {
		throw new Error(
			'[validatorClRewardPayout] observe/enqueue requires CONET_VALIDATOR_CL_REWARD_PAYOUT_OBSERVE_STATE_FILE'
		)
	}
	const prod = resolveProductionStateFile()
	if (path.resolve(observeFile) === path.resolve(prod)) {
		throw new Error(
			'[validatorClRewardPayout] observe state file must not be the production payout state file'
		)
	}
	observeProductionStatePath = prod
	if (fs.existsSync(prod)) {
		observeProductionStateBytes = fs.readFileSync(prod)
		observeProductionStateMissing = false
	} else {
		observeProductionStateBytes = null
		observeProductionStateMissing = true
	}
	logger(
		Colors.cyan(
			'[validatorClRewardPayout] observe/enqueue startup: recover resend OFF, flush OFF, signer NOT loaded, production cursors protected'
		)
	)
}

function assertProductionCursorsUntouched(): void {
	if (!payoutObserveEnqueue() || !observeProductionStatePath) return
	const prod = observeProductionStatePath
	if (observeProductionStateMissing) {
		if (fs.existsSync(prod)) {
			throw new Error('[validatorClRewardPayout] observe/enqueue created the production payout state file')
		}
		return
	}
	const now = fs.readFileSync(prod)
	if (!observeProductionStateBytes || !now.equals(observeProductionStateBytes)) {
		throw new Error('[validatorClRewardPayout] observe/enqueue mutated production payout cursors')
	}
}

function resolveStateFile(): string {
	if (payoutObserveEnqueue()) {
		const observeFile = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_OBSERVE_STATE_FILE?.trim()
		if (!observeFile) {
			throw new Error(
				'[validatorClRewardPayout] observe/enqueue requires CONET_VALIDATOR_CL_REWARD_PAYOUT_OBSERVE_STATE_FILE'
			)
		}
		const prod = resolveProductionStateFile()
		if (path.resolve(observeFile) === path.resolve(prod)) {
			throw new Error('[validatorClRewardPayout] observe state file collides with production payout state')
		}
		return observeFile
	}
	return resolveProductionStateFile()
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

function resolveChunksPerTick(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNKS_PER_TICK || 1)
	return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 1
}

function resolveMaxEntriesPerTx(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES || 29)
	return Number.isFinite(n) && n >= 1 ? Math.min(256, Math.floor(n)) : 29
}

/**
 * Running .22 unit sets CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT=2500000.
 * The signer grant is maxGas=2000000, so this request stays refused until that
 * grant is raised to 2500000. Do not add a higher ceiling.
 */
const VDR_PAYOUT_GAS_LIMIT = 2_500_000

/** CAP_B — first-batch executable amount hard gate (wei). */
const VDR_PAYOUT_MAX_AMOUNT_WEI_DEFAULT = 44_885_338_300_000_000n

function resolveGasLimit(): number {
	const raw = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT?.trim()
	if (raw && raw !== String(VDR_PAYOUT_GAS_LIMIT)) {
		throw new Error(
			`CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT must be ${VDR_PAYOUT_GAS_LIMIT} (running unit); refusing a different limit`
		)
	}
	return VDR_PAYOUT_GAS_LIMIT
}

/**
 * Max CNET (wei) allowed in one settleNodeRewards broadcast.
 * Unset / invalid / 0 → CAP_B (gate cannot be disabled by accident).
 */
function resolveMaxAmountWei(): bigint {
	const raw = process.env.CONET_VDR_PAYOUT_MAX_AMOUNT_WEI?.trim()
	if (!raw) return VDR_PAYOUT_MAX_AMOUNT_WEI_DEFAULT
	try {
		const v = BigInt(raw)
		return v > 0n ? v : VDR_PAYOUT_MAX_AMOUNT_WEI_DEFAULT
	} catch {
		return VDR_PAYOUT_MAX_AMOUNT_WEI_DEFAULT
	}
}

/**
 * First-batch cumulative wei budget (settled + in-flight reserve).
 * Unset → CAP_B. Explicit `0` disables cumulative select (peel/pack still enforce per-pack CAP).
 */
function resolveFirstBatchBudgetWei(): bigint | null {
	const raw = process.env.CONET_VDR_FIRST_BATCH_BUDGET_WEI?.trim()
	if (raw === undefined || raw === '') return resolveMaxAmountWei()
	try {
		const v = BigInt(raw)
		if (v === 0n) return null
		return v > 0n ? v : resolveMaxAmountWei()
	} catch {
		return resolveMaxAmountWei()
	}
}

/**
 * Take payable rows that fit remaining first-batch budget; deferred stay in pending.
 * Does not wipe the pool. Empty selected when budget exhausted.
 */
function selectEntriesUnderFirstBatchBudget(
	entries: PayoutEntry[],
	state: DualCursorState,
	budgetWei: bigint
): { selected: PayoutEntry[]; deferred: PayoutEntry[]; remainingWei: string } {
	let remaining = remainingFirstBatchBudgetWei(state, budgetWei)
	const selected: PayoutEntry[] = []
	const deferred: PayoutEntry[] = []
	for (const e of entries) {
		if (e.amount <= remaining) {
			selected.push(e)
			remaining -= e.amount
		} else {
			deferred.push(e)
		}
	}
	return { selected, deferred, remainingWei: remaining.toString() }
}

function resolveGasBase(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_BASE || 100_000)
	return Number.isFinite(n) && n >= 21_000 ? Math.floor(n) : 100_000
}

function resolveGasPerEntry(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_PER_ENTRY || 55_000)
	return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : 55_000
}

function resolveMaxCalldataBytes(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_CALLDATA_BYTES || 48_000)
	return Number.isFinite(n) && n >= 2_000 ? Math.min(100_000, Math.floor(n)) : 48_000
}

function resolveCalldataBytesPerEntry(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CALLDATA_PER_ENTRY || 128)
	return Number.isFinite(n) && n >= 64 ? Math.floor(n) : 128
}

/**
 * Default pause line: 30_000_000 wei (0.03 Gwei). High gas is strict `> max`
 * (equal is not high). Prefer WEI env; GWEI remains a compatibility override.
 * See `.cursor/rules/conet-vdr-cl-reward-gas-threshold-300s.mdc`.
 */
function resolveMaxGasPriceWei(): bigint {
	const weiRaw = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_GAS_PRICE_WEI?.trim()
	if (weiRaw) {
		try {
			const w = BigInt(weiRaw)
			if (w > 0n) return w
		} catch {
			/* fall through */
		}
	}
	const gweiRaw = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_GAS_PRICE_GWEI?.trim()
	if (gweiRaw) {
		const gwei = Number(gweiRaw)
		if (Number.isFinite(gwei) && gwei > 0) return ethers.parseUnits(String(gwei), 'gwei')
	}
	return 30_000_000n
}

function resolveGasWaitForceMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_WAIT_FORCE_MS || 300_000)
	return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 300_000
}

function clearGasWait(state: DualCursorState): boolean {
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
		scanLine: e.scanLine,
		enqueuedAtMs: e.enqueuedAtMs,
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
		const scanLine: ScanLine | undefined =
			raw.scanLine === 'historical' || raw.scanLine === 'realtime' ? raw.scanLine : undefined
		return {
			guardianId,
			amount,
			eventKey,
			blockNumber,
			withdrawalIndex,
			scanLine,
			enqueuedAtMs: Number.isFinite(Number(raw.enqueuedAtMs)) ? Number(raw.enqueuedAtMs) : undefined,
		}
	} catch {
		return null
	}
}

function loadState(): DualCursorState {
	const file = resolveStateFile()
	const floor = resolveDeployBlockFloor()
	try {
		if (!fs.existsSync(file)) {
			return migrateLegacyToDualCursor(null, floor)
		}
		const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
		return migrateLegacyToDualCursor(raw, floor)
	} catch (e: unknown) {
		logger(Colors.yellow(`[validatorClRewardPayout] state reset: ${(e as Error)?.message ?? e}`))
		return migrateLegacyToDualCursor(null, floor)
	}
}

function persistState(state: DualCursorState): void {
	const target = resolveStateFile()
	if (payoutObserveEnqueue()) {
		const prod = resolveProductionStateFile()
		if (path.resolve(target) === path.resolve(prod)) {
			throw new Error('[validatorClRewardPayout] observe/enqueue refuses to write production payout state')
		}
	}
	workingState = state
	atomicWriteState(target, state)
	if (payoutObserveEnqueue()) assertProductionCursorsUntouched()
}

function syncPendingOntoState(state: DualCursorState, pending: Map<string, PayoutEntry>): DualCursorState {
	const next: DualCursorState = {
		...state,
		pending: [...pending.values()]
			.sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
			.map(entryToJson),
		updatedAt: new Date().toISOString(),
		lastProcessedBlock: state.historicalCursor,
	}
	persistState(next)
	return next
}

function pendingMapFromState(state: DualCursorState): Map<string, PayoutEntry> {
	const map = new Map<string, PayoutEntry>()
	for (const raw of state.pending) {
		const e = entryFromJson(raw)
		if (!e) continue
		map.set(e.eventKey, e)
	}
	return map
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

function splitEntriesForOnchain(entries: PayoutEntry[]): PayoutEntry[][] {
	if (!entries.length) return []
	const maxEntries = resolveMaxEntriesPerTx()
	const gasLimit = resolveGasLimit()
	const gasBase = resolveGasBase()
	const gasPer = resolveGasPerEntry()
	const maxCalldata = resolveMaxCalldataBytes()
	const calldataPer = resolveCalldataBytesPerEntry()
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
	block: RpcBlock,
	scanLine: ScanLine
): Promise<PayoutEntry[]> {
	const withdrawals = block.withdrawals ?? []
	const entries: PayoutEntry[] = []
	const nowMs = Date.now()
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
			scanLine,
			enqueuedAtMs: nowMs,
		})
	}
	return entries
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
	// Isolate-only override. Production must not set TEST_GAS_PRICE_WEI.
	const testRaw = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_TEST_GAS_PRICE_WEI?.trim()
	if (testRaw) {
		try {
			const w = BigInt(testRaw)
			if (w > 0n) return w
		} catch {
			/* fall through to live fee */
		}
	}
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

/**
 * Force-path: pick one beneficiary wallet's unpaid entries (earliest block/index),
 * capped by existing maxEntries / amount CAP gates at submit time.
 * Does NOT implement one internal transfer — still settleNodeRewards per-index calls.
 */
async function pickSameWalletForceEntries(
	readContract: ethers.Contract,
	pending: Map<string, PayoutEntry>
): Promise<PayoutEntry[]> {
	const sorted = [...pending.values()].sort(
		(a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex
	)
	type Row = { entry: PayoutEntry; beneficiary: string }
	const rows: Row[] = []
	for (const e of sorted) {
		try {
			const beneficiary = String(await readContract.guardianIdBeneficiary!(e.guardianId)).toLowerCase()
			if (!beneficiary || beneficiary === ethers.ZeroAddress.toLowerCase()) continue
			rows.push({ entry: e, beneficiary })
		} catch {
			continue
		}
	}
	if (!rows.length) return []
	const firstBen = rows[0]!.beneficiary
	const maxN = resolveMaxEntriesPerTx()
	return rows
		.filter((r) => r.beneficiary === firstBen)
		.slice(0, maxN)
		.map((r) => r.entry)
}

async function filterUnconsumed(readContract: ethers.Contract, entries: PayoutEntry[]) {
	const split = await partitionByPaidKey(entries, async (eventKey) =>
		Boolean(await readContract.consumedRewardEventKey!(eventKey))
	)
	for (const err of split.errors) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] paid-key view unconfirmed eventKey=${err.eventKey} ${err.message}; left pending, not signed`
			)
		)
	}
	return split
}

type SubmitOutcome = 'ok' | 'needs_split' | 'failed' | 'uncertain' | 'amount_blocked'

function intentCoversPending(intent: SettleIntent, pending: Map<string, PayoutEntry>): boolean {
	return intent.eventKeys.every((k) => pending.has(k.toLowerCase()))
}

/**
 * Persist settle intent BEFORE broadcast. On ACK loss, rebuild the same
 * idempotencyKey + fingerprint — never invent a new batch.
 */
async function submitPayoutBatchOnchain(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint
): Promise<SubmitOutcome> {
	if (!entries.length) return 'ok'
	const guardianIds = entries.map((e) => e.guardianId)
	const amounts = entries.map((e) => e.amount)
	const eventKeys = entries.map((e) => e.eventKey)
	const scanLines = entries.map((e) => e.scanLine ?? 'historical') as ScanLine[]

	if (payoutObserveEnqueue()) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] observe/enqueue refuse sign/broadcast n=${entries.length} — pending retained, signer not loaded`
			)
		)
		return 'failed'
	}

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

	const amountGate = assertAmountCapOrAbort(entries)
	if (!amountGate.ok) {
		logger(
			Colors.red(
				`[validatorClRewardPayout] FORCE_BLOCK amount_cap_block n=${entries.length} batchSumWei=${amountGate.batchSumWei} capWei=${amountGate.capWei} — no sign/broadcast`
			)
		)
		return 'amount_blocked'
	}

	const config = readVdrSignerConfig()
	if (!config) {
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

	let state = workingState ?? loadState()
	const intent = prepareSettleIntent({
		to: contractAddr,
		guardianIds,
		amounts,
		eventKeys,
		gasLimit,
		keyArray: config.keyArray,
		scanLines,
	})
	state = attachIntentToState(state, intent)
	persistState(state)

	const tx: VdrSignerTx = rebuildSignerTxFromIntent(intent, config.keyArray)

	logger(
		Colors.cyan(
			`[validatorClRewardPayout] PRE_SIGN ACCEPT eventKeys=${eventKeys.join(',')} batchSumWei=${amountGate.batchSumWei} capWei=${amountGate.capWei} n=${entries.length}`
		)
	)

	try {
		const { hash } = await signerSendOnce(tx, config.socketPath)
		state = markIntentBroadcast(workingState ?? state, intent.idempotencyKey, hash)
		persistState(state)
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] settleNodeRewards sent via signer tx=${hash} waiting≤${resolveClaimTxWaitTimeoutMs()}ms n=${entries.length} eventKeys=${eventKeys.join(',')} gasPrice=${ethers.formatUnits(gasPriceWei, 'gwei')}gwei idem=${intent.idempotencyKey.slice(0, 24)}…`
			)
		)
		const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
		state = markIntentConfirmed(workingState ?? state, intent.idempotencyKey, receipt.status ?? 0)
		persistState(state)
		if (receipt.status !== 1) {
			throw new Error(`settleNodeRewards reverted status=${receipt.status} hash=${hash}`)
		}
		logger(Colors.green(`[validatorClRewardPayout] settleNodeRewards ok tx=${hash} n=${entries.length}`))
		return 'ok'
	} catch (e: unknown) {
		const msg = (e as Error)?.message ?? String(e)
		const ackLost = /timed out|ECONNRESET|socket|ACK|no transaction hash/i.test(msg)
		if (ackLost) {
			state = markIntentUncertain(
				workingState ?? state,
				intent.idempotencyKey,
				`ack_lost_after_broadcast:${msg.slice(0, 120)}`
			)
			persistState(state)
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] ACK uncertain after broadcast; preserving intent idem=${intent.idempotencyKey.slice(0, 24)}… fp=${intent.requestFingerprint.slice(0, 18)}…`
				)
			)
			return 'uncertain'
		}
		state = markIntentFailed(
			workingState ?? state,
			intent.idempotencyKey,
			`signer_failed:${msg.slice(0, 120)}`
		)
		persistState(state)
		logger(Colors.red(`[validatorClRewardPayout] settleNodeRewards signer failed: ${msg}`))
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
 * Drop individually over-cap rows out of the signer path. They stay in `pending`.
 * Does not split one row's amount.
 */
function peelIndividuallyOverCap(entries: PayoutEntry[]): { payable: PayoutEntry[]; blocked: PayoutEntry[] } {
	const capWei = resolveMaxAmountWei()
	const payable: PayoutEntry[] = []
	const blocked: PayoutEntry[] = []
	for (const e of entries) {
		if (e.amount > capWei) blocked.push(e)
		else payable.push(e)
	}
	return { payable, blocked }
}

/**
 * Pack already-under-cap rows so each broadcast sum ≤ CAP and count ≤ max entries
 * (default 29). Never splits a single amount.
 */
function packEntriesUnderAmountCap(entries: PayoutEntry[]): PayoutEntry[][] {
	const capWei = resolveMaxAmountWei()
	const maxN = resolveMaxEntriesPerTx()
	const packs: PayoutEntry[][] = []
	let cur: PayoutEntry[] = []
	let sum = 0n
	for (const e of entries) {
		if (cur.length > 0 && (cur.length >= maxN || sum + e.amount > capWei)) {
			packs.push(cur)
			cur = []
			sum = 0n
		}
		cur.push(e)
		sum += e.amount
	}
	if (cur.length) packs.push(cur)
	return packs
}

async function submitPayableBatch(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint,
	pending: Map<string, PayoutEntry>
): Promise<void> {
	if (!entries.length) return
	if (payoutObserveEnqueue()) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] observe/enqueue skip payable submit n=${entries.length} — pending retained, signer not loaded`
			)
		)
		return
	}

	// Defense in depth: a pack that still exceeds CAP is not signed and is not
	// amount-bisected (that would be an over-cap bypass).
	const preGate = assertAmountCapOrAbort(entries)
	if (!preGate.ok) {
		logger(
			Colors.red(
				`[validatorClRewardPayout] FORCE_BLOCK amount_cap_block (pre-sign pack) n=${entries.length} batchSumWei=${preGate.batchSumWei} capWei=${preGate.capWei} — leave pending, no broadcast`
			)
		)
		return
	}

	const outcome = await submitPayoutBatch(contractAddr, entries, gasPriceWei)
	if (outcome === 'ok') {
		for (const e of entries) pending.delete(e.eventKey)
		let state = workingState ?? loadState()
		state = removePendingKeys(state, entries.map((e) => e.eventKey))
		state = syncPendingOntoState(state, pending)
		return
	}

	if (outcome === 'uncertain') {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] leave batch in pending (ACK uncertain); will recover via idempotencyKey next tick n=${entries.length}`
			)
		)
		return
	}

	if (outcome === 'amount_blocked') {
		logger(
			Colors.red(
				`[validatorClRewardPayout] leave batch in pending after amount_cap_block; no amount auto-split n=${entries.length}`
			)
		)
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
			`[validatorClRewardPayout] gas/calldata auto-split n=${entries.length} → ${left.length}+${right.length} (reason=${outcome})`
		)
	)
	await submitPayoutBatchAutoSplit(contractAddr, left, gasPriceWei, pending)
	await submitPayoutBatchAutoSplit(contractAddr, right, gasPriceWei, pending)
}

async function submitPayoutBatchAutoSplit(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint,
	pending: Map<string, PayoutEntry>
): Promise<void> {
	if (!entries.length) return

	const { payable, blocked } = peelIndividuallyOverCap(entries)
	for (const e of blocked) {
		logger(
			Colors.red(
				`[validatorClRewardPayout] FORCE_BLOCK amount_cap_block (pre-sign) eventKey=${e.eventKey} amountWei=${e.amount} capWei=${resolveMaxAmountWei()} — leave this key pending, no sign, no broadcast`
			)
		)
	}
	if (!payable.length) return

	const budgetWei = resolveFirstBatchBudgetWei()
	let toPack = payable
	if (budgetWei != null) {
		const state = workingState ?? loadState()
		const { selected, deferred, remainingWei } = selectEntriesUnderFirstBatchBudget(
			payable,
			state,
			budgetWei
		)
		if (deferred.length) {
			logger(
				Colors.magenta(
					`[validatorClRewardPayout] first_batch_budget_hold deferred=${deferred.length} selected=${selected.length} ` +
						`budgetWei=${budgetWei} remainingWei=${remainingWei} — deferred stay pending (no pool wipe)`
				)
			)
		}
		if (!selected.length) return
		toPack = selected
	}

	for (const pack of packEntriesUnderAmountCap(toPack)) {
		await submitPayableBatch(contractAddr, pack, gasPriceWei, pending)
	}
}

async function scanBlocksIntoPending(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	proxyAddr: string,
	fromBlock: number,
	toBlock: number,
	scanLine: ScanLine,
	pending: Map<string, PayoutEntry>
): Promise<{ okThrough: number | null; okThroughHash?: string; added: number; fetchFailed: boolean }> {
	const proxyLower = proxyAddr.toLowerCase()
	let okThrough: number | null = null
	let okThroughHash: string | undefined
	let added = 0
	for (let bn = fromBlock; bn <= toBlock; bn++) {
		const block = await fetchBlockWithWithdrawals(provider, bn)
		if (!block) {
			return { okThrough, okThroughHash, added, fetchFailed: true }
		}
		const entries = await collectPayoutEntriesForBlock(readContract, proxyLower, bn, block, scanLine)
		added += mergeIntoPending(pending, entries)
		okThrough = bn
		okThroughHash = typeof block.hash === 'string' ? block.hash.toLowerCase() : undefined
	}
	return { okThrough, okThroughHash, added, fetchFailed: false }
}

/**
 * Recover open intents after power-loss / ACK loss using persisted idempotencyKey + fingerprint.
 * Does NOT invent a new batch; rebuilds the original signer tx.
 */
async function recoverOpenIntents(
	provider: ethers.JsonRpcProvider,
	pending: Map<string, PayoutEntry>
): Promise<void> {
	if (payoutObserveEnqueue()) {
		logger(
			Colors.yellow(
				'[validatorClRewardPayout] observe/enqueue skip recoverOpenIntents resend — intents retained, signer not loaded'
			)
		)
		return
	}
	let state = workingState ?? loadState()
	const open = state.settleIntents.filter((i) => i.status === 'broadcast' || i.status === 'uncertain' || i.status === 'prepared')
	if (!open.length) return

	const config = readVdrSignerConfig()
	for (const intent of open) {
		if (!intentCoversPending(intent, pending) && intent.status === 'prepared') {
			// Prepared but never broadcast and entries gone — drop stale intent.
			state = {
				...state,
				settleIntents: state.settleIntents.filter((i) => i.idempotencyKey !== intent.idempotencyKey),
				updatedAt: new Date().toISOString(),
			}
			persistState(state)
			continue
		}

		if (intent.txHash) {
			try {
				const receipt = await provider.getTransactionReceipt(intent.txHash)
				if (receipt) {
					state = markIntentConfirmed(state, intent.idempotencyKey, receipt.status ?? 0)
					if (receipt.status === 1) {
						for (const k of intent.eventKeys) pending.delete(k.toLowerCase())
						state = removePendingKeys(state, intent.eventKeys)
					}
					state = syncPendingOntoState(state, pending)
					logger(
						Colors.green(
							`[validatorClRewardPayout] recovered intent via txHash receipt status=${receipt.status} idem=${intent.idempotencyKey.slice(0, 24)}…`
						)
					)
					continue
				}
			} catch {
				/* keep trying */
			}
		}

		// ACK lost: rebuild original batch from fingerprint; only resend same idempotencyKey.
		if (!config) {
			const r = reconcileAckLostIntent(state, intent.idempotencyKey, { safeToResend: false })
			state = r.state
			persistState(state)
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] ACK-lost intent held (no signer); refuse blind resend idem=${intent.idempotencyKey.slice(0, 24)}…`
				)
			)
			continue
		}

		try {
			const tx = rebuildSignerTxFromIntent(intent, config.keyArray)
			const { hash } = await signerSendOnce(tx, config.socketPath)
			const r = reconcileAckLostIntent(state, intent.idempotencyKey, { txHash: hash, safeToResend: true })
			state = r.state
			persistState(state)
			const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
			state = markIntentConfirmed(workingState ?? state, intent.idempotencyKey, receipt.status ?? 0)
			if (receipt.status === 1) {
				for (const k of intent.eventKeys) pending.delete(k.toLowerCase())
				state = removePendingKeys(workingState ?? state, intent.eventKeys)
			}
			state = syncPendingOntoState(workingState ?? state, pending)
			logger(
				Colors.green(
					`[validatorClRewardPayout] ACK-lost recovered ORIGINAL batch tx=${hash} idem=${intent.idempotencyKey.slice(0, 24)}… fp=${intent.requestFingerprint.slice(0, 18)}…`
				)
			)
		} catch (e: unknown) {
			const r = reconcileAckLostIntent(state, intent.idempotencyKey, { safeToResend: false })
			state = r.state
			persistState(state)
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] ACK-lost recovery deferred: ${(e as Error)?.message ?? e}`
				)
			)
		}
	}
}

async function flushPendingBatches(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	contractAddr: string,
	pending: Map<string, PayoutEntry>
): Promise<void> {
	if (payoutObserveEnqueue()) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] observe/enqueue skip flushPendingBatches pending=${pending.size} — no signer, events retained`
			)
		)
		return
	}
	let state = workingState ?? loadState()
	if (!pending.size) {
		if (clearGasWait(state)) state = syncPendingOntoState(state, pending)
		return
	}

	const maxGas = resolveMaxGasPriceWei()
	const gasPrice = await readGasPriceWei(provider)
	const forceMs = resolveGasWaitForceMs()
	// Strict `>` only — equal to maxGas is NOT high gas (no +50_000_000 dust).
	const gasHigh = gasPrice > maxGas
	let forceFlush = false

	if (gasHigh) {
		const now = Date.now()
		if (!state.gasWaitStartedAt) {
			state = { ...state, gasWaitStartedAt: new Date(now).toISOString() }
			state = syncPendingOntoState(state, pending)
		}
		const startedMs = Date.parse(state.gasWaitStartedAt!)
		const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : forceMs
		if (elapsedMs < forceMs) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] pause auto-pay: gasPrice=${gasPrice.toString()} wei > max=${maxGas.toString()} wei ` +
						`wait ${formatWaitCountdown(elapsedMs, forceMs)} pending=${pending.size}`
				)
			)
			return
		}
		forceFlush = true
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] force same-wallet merge: gas wait ${Math.floor(elapsedMs / 1000)}s ≥ ${Math.floor(forceMs / 1000)}s; ` +
					`live gasPrice=${gasPrice.toString()} wei pending=${pending.size} (one settleNodeRewards; multi internal call{value})`
			)
		)
	} else if (clearGasWait(state)) {
		// Dropped to ≤ maxGas → resume ordinary auto-pay immediately (no 300s wait).
		state = syncPendingOntoState(state, pending)
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] gas ≤ max (${gasPrice.toString()} ≤ ${maxGas.toString()} wei) — resume ordinary auto-pay`
			)
		)
	}

	// Sync map → state so planFlushOrder sees scanLine tags.
	state = syncPendingOntoState(workingState ?? state, pending)

	const split = await filterUnconsumed(
		readContract,
		[...pending.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
	)
	const blocked = new Set(split.unconfirmed.map((e) => e.eventKey.toLowerCase()))
	if (split.alreadyPaid.length) {
		const dropped = split.alreadyPaid.map((e) => e.eventKey)
		for (const k of dropped) pending.delete(k)
		state = removePendingKeys(workingState ?? state, dropped)
		state = syncPendingOntoState(state, pending)
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] dropped already-consumed eventKeys; pending=${pending.size}`
			)
		)
	}
	if (blocked.size) {
		state = syncPendingOntoState(workingState ?? state, pending)
		persistState(state)
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] ${blocked.size} pending kept unsigned until paid-key view succeeds`
			)
		)
	}
	if (!pending.size) {
		if (clearGasWait(state)) state = syncPendingOntoState(workingState ?? state, pending)
		return
	}

	state = syncPendingOntoState(workingState ?? state, pending)

	if (forceFlush) {
		const forceBatch = (await pickSameWalletForceEntries(readContract, pending)).filter(
			(e) => !blocked.has(e.eventKey.toLowerCase())
		)
		if (!forceBatch.length) {
			logger(Colors.yellow(`[validatorClRewardPayout] force flush: no resolvable beneficiary — skip`))
			return
		}
		// Reset 300s window so a second force cannot fire in the same window (persist across restart via state).
		state = { ...state, gasWaitStartedAt: new Date().toISOString() }
		state = syncPendingOntoState(state, pending)
		persistState(state)
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] force plan n=${forceBatch.length} eventKeys=${forceBatch.map((e) => e.eventKey).join(',')} ` +
					`gasPrice=${gasPrice.toString()}wei (contract still per-index call{value}; see CONTRACT-DIFF-SETTLE-AGGREGATE-TRANSFER)`
			)
		)
		for (const sub of splitEntriesForOnchain(forceBatch)) {
			await submitPayoutBatchAutoSplit(contractAddr, sub, gasPrice, pending)
		}
		state = workingState ?? state
		persistState(state)
		return
	}

	const flushPlan = planFlushOrder(state, {
		maxEntriesPerTx: resolveMaxEntriesPerTx(),
		realtimeQuota: resolveRealtimeFlushQuota(),
		historicalFloor: resolveHistoricalFlushFloor(),
	})
	state = recordRealtimeLatency(state, flushPlan.realtimeLatencyMs)
	persistState(state)

	const latencyAvg =
		flushPlan.realtimeLatencyMs.length > 0
			? Math.round(flushPlan.realtimeLatencyMs.reduce((a, b) => a + b, 0) / flushPlan.realtimeLatencyMs.length)
			: 0
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] flush plan rtBatches=${flushPlan.realtimeBatchCount} histBatches=${flushPlan.historicalBatchCount} ` +
				`historyProgressing=${flushPlan.historyStillProgressing ? 1 : 0} rtLatencyAvgMs=${latencyAvg} ` +
				`pending=${pending.size} histCursor=${state.historicalCursor} rtCursor=${state.realtimeCursor} ` +
				`gasPrice=${gasPrice.toString()}wei`
		)
	)

	for (const batchJson of flushPlan.batches) {
		const batch: PayoutEntry[] = []
		for (const j of batchJson) {
			const e = entryFromJson(j)
			if (e && pending.has(e.eventKey) && !blocked.has(e.eventKey.toLowerCase())) batch.push(e)
		}
		if (!batch.length) continue
		// Further split by gas/calldata heuristics, then auto-bisect on estimate failure.
		for (const sub of splitEntriesForOnchain(batch)) {
			await submitPayoutBatchAutoSplit(contractAddr, sub, gasPrice, pending)
		}
	}

	state = workingState ?? state
	if (!pending.size && clearGasWait(state)) {
		syncPendingOntoState(state, pending)
	}
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
		let state = loadState()
		workingState = state
		const pending = pendingMapFromState(state)
		const liveHead = Number(await provider.getBlockNumber())
		if (!Number.isFinite(liveHead) || liveHead < floor) return

		if (payoutObserveEnqueue()) {
			logger(Colors.yellow('[validatorClRewardPayout] observe/enqueue outer-skip recoverOpenIntents'))
		} else {
			await recoverOpenIntents(provider, pending)
		}
		state = workingState ?? loadState()

		const depth = resolveConfirmationDepth()
		const tipBlock = await fetchBlockWithWithdrawals(provider, liveHead)
		if (!tipBlock?.hash) {
			logger(Colors.yellow(`[validatorClRewardPayout] tip hash unavailable at ${liveHead}; skip tick`))
			return
		}

		// Reorg check on locked H / realtime tip when hash mismatches.
		if (state.boundaryH) {
			const hBlock = await fetchBlockWithWithdrawals(provider, state.boundaryH.blockNumber)
			const hHash = typeof hBlock?.hash === 'string' ? hBlock.hash.toLowerCase() : ''
			if (hHash && hHash !== state.boundaryH.blockHash) {
				logger(
					Colors.yellow(
						`[validatorClRewardPayout] reorg vs H=${state.boundaryH.blockNumber}: stored=${state.boundaryH.blockHash.slice(0, 12)}… live=${hHash.slice(0, 12)}…`
					)
				)
				state = applyReorgRollback(
					state,
					state.boundaryH.blockNumber,
					state.boundaryH.blockHash,
					hHash
				)
				state = syncPendingOntoState(state, pendingMapFromState(state))
				// Refresh pending after reorg drop.
				pending.clear()
				for (const [k, v] of pendingMapFromState(state)) pending.set(k, v)
			}
		}

		// H locks at confirmed tip (liveHead - depth); persist that block's own hash.
		const prospectiveH = Math.max(0, liveHead - depth, state.historicalCursor)
		const hLockBlock = await fetchBlockWithWithdrawals(provider, prospectiveH)
		const hLockHash =
			typeof hLockBlock?.hash === 'string' ? hLockBlock.hash.toLowerCase() : String(tipBlock.hash).toLowerCase()
		if (!/^0x[0-9a-f]{64}$/.test(hLockHash)) {
			logger(Colors.yellow(`[validatorClRewardPayout] H block ${prospectiveH} hash unavailable; skip tick`))
			return
		}
		const locked = ensureBoundaryH(state, liveHead, hLockHash, depth)
		state = locked.state
		if (locked.lockedNow) {
			persistState(state)
			logger(
				Colors.cyan(
					`[validatorClRewardPayout] locked H=${state.boundaryH!.blockNumber} hash=${state.boundaryH!.blockHash.slice(0, 14)}… ` +
						`histCursor=${state.historicalCursor} rtCursor=${state.realtimeCursor} depth=${depth}`
				)
			)
		}

		const chunk = resolveChunkBlocks()
		const chunksPerTick = resolveChunksPerTick()
		const histBudget = chunk * chunksPerTick
		const rtBudget = chunk * chunksPerTick
		const plan = planScanRanges(state, liveHead, {
			confirmationDepth: depth,
			historicalChunk: histBudget,
			realtimeChunk: rtBudget,
		})

		logger(
			Colors.cyan(
				`[validatorClRewardPayout] dual-scan H=${state.boundaryH?.blockNumber ?? 'n/a'} ` +
					`hist=${plan.historical ? `${plan.historical.from}..${plan.historical.to}` : 'done'} ` +
					`rt=${plan.realtime ? `${plan.realtime.from}..${plan.realtime.to}` : 'caught-up'} ` +
					`safeTip=${plan.tipForPlan} liveHead=${liveHead} pending=${pending.size} ` +
					`histComplete=${isHistoricalComplete(state) ? 1 : 0}`
			)
		)

		if (plan.historical) {
			const { from, to } = plan.historical
			const { okThrough, okThroughHash, added, fetchFailed } = await scanBlocksIntoPending(
				provider,
				readContract,
				proxyAddr,
				from,
				to,
				'historical',
				pending
			)
			if (okThrough != null) {
				const jsonEntries = [...pending.values()]
					.filter((e) => e.blockNumber >= from && e.blockNumber <= okThrough && e.scanLine === 'historical')
					.filter((e) => e.blockNumber >= from) // already in map; commit uses entries list for merge
					.map(entryToJson)
				// Only newly scanned range entries for this commit — use ones with matching blocks.
				const commitEntries = jsonEntries.filter((e) => e.blockNumber >= from && e.blockNumber <= okThrough)
				state = commitScanProgress(workingState ?? state, {
					line: 'historical',
					okThrough,
					entries: commitEntries,
					okThroughHash,
				})
				// Re-sync pending from commit (dedupe) then overlay live map extras.
				const after = pendingMapFromState(state)
				for (const [k, v] of pending) {
					if (!after.has(k)) after.set(k, v)
				}
				pending.clear()
				for (const [k, v] of after) pending.set(k, v)
				state = syncPendingOntoState(state, pending)
				if (added > 0) {
					logger(
						Colors.cyan(
							`[validatorClRewardPayout] historical +${added} pending=${pending.size} through ${from}..${okThrough}`
						)
					)
				}
			}
			if (fetchFailed || okThrough == null || (okThrough != null && okThrough < to)) {
				logger(
					Colors.yellow(
						`[validatorClRewardPayout] historical scan stop at ${okThrough ?? from - 1}; retry next tick`
					)
				)
			}
		}

		if (plan.realtime) {
			const { from, to } = plan.realtime
			const { okThrough, okThroughHash, added, fetchFailed } = await scanBlocksIntoPending(
				provider,
				readContract,
				proxyAddr,
				from,
				to,
				'realtime',
				pending
			)
			if (okThrough != null) {
				const commitEntries = [...pending.values()]
					.filter((e) => e.scanLine === 'realtime' && e.blockNumber >= from && e.blockNumber <= okThrough)
					.map(entryToJson)
				state = commitScanProgress(workingState ?? state, {
					line: 'realtime',
					okThrough,
					entries: commitEntries,
					okThroughHash,
				})
				const after = pendingMapFromState(state)
				for (const [k, v] of pending) {
					if (!after.has(k)) after.set(k, v)
				}
				pending.clear()
				for (const [k, v] of after) pending.set(k, v)
				state = syncPendingOntoState(state, pending)
				if (added > 0) {
					logger(
						Colors.cyan(
							`[validatorClRewardPayout] realtime +${added} pending=${pending.size} through ${from}..${okThrough}`
						)
					)
				}
			}
			if (fetchFailed || okThrough == null || (okThrough != null && okThrough < to)) {
				logger(
					Colors.yellow(
						`[validatorClRewardPayout] realtime scan stop at ${okThrough ?? from - 1}; retry next tick`
					)
				)
			}
		}

		if (payoutObserveEnqueue()) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] observe/enqueue outer-skip flushPendingBatches pending=${pending.size}`
				)
			)
			logger(
				Colors.cyan(
					`[validatorClRewardPayout] observe/enqueue tick-done pending=${pending.size} recoverSkipped=1 flushSkipped=1 signerLoaded=0`
				)
			)
		} else {
			await flushPendingBatches(provider, readContract, proxyAddr, pending)
		}
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
	if (payoutObserveEnqueue()) {
		assertObserveEnqueueConfig()
	} else if (!payoutEnabled()) {
		logger(Colors.yellow('[validatorClRewardPayout] disabled (set CONET_VALIDATOR_CL_REWARD_PAYOUT=1)'))
		return
	}
	payoutStarted = true
	const proxy = resolveValidatorDepositRedeemAddress() || CONET_VALIDATOR_DEPOSIT_REDEEM
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] starting dual-cursor proxy=${proxy || 'unset'} floor=${resolveDeployBlockFloor()} tick=${resolveTickMs()}ms ` +
				`maxEntries=${resolveMaxEntriesPerTx()} maxGasGwei=${ethers.formatUnits(resolveMaxGasPriceWei(), 'gwei')} ` +
				`gasWaitForceMs=${resolveGasWaitForceMs()} rtQuota=${resolveRealtimeFlushQuota()} histFloor=${resolveHistoricalFlushFloor()} ` +
				`confirmDepth=${resolveConfirmationDepth()} pendingPool=on`
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

/** Test/ops helper: load migrated dual-cursor state without starting the daemon. */
export function peekValidatorClRewardPayoutState(): DualCursorState {
	return loadState()
}
