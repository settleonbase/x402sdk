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
 * Gas: resolveGasLimit default/hard-cap ≤800000 (signer maxGas stays 800000).
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
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { CONET_VALIDATOR_NODE_ONCHAIN_LANE, enqueueOnchainTxWork } from '../onchainTxSerialQueue'
import {
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK,
} from '../chainAddresses'
/** Pure env config (no ../util, no ~/.master.json). Fail closed when missing or not http(s). */
function requireClaimRpcUrlEnv(): string {
	const raw = process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ?? ''
	if (!raw) throw new Error('CONET_VALIDATOR_DEPOSIT_RPC_URL is required (master.json is not read)')
	if (!/^https?:\/\//i.test(raw)) throw new Error('CONET_VALIDATOR_DEPOSIT_RPC_URL must be http(s); ws/wss refused')
	return raw
}

function resolveValidatorDepositRedeemAddress(): string | null {
	const raw = process.env.CONET_VALIDATOR_DEPOSIT_REDEEM?.trim() || CONET_VALIDATOR_DEPOSIT_REDEEM
	if (!raw) return null
	try {
		const a = ethers.getAddress(raw)
		return a === ethers.ZeroAddress ? null : a
	} catch {
		return null
	}
}
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
	type LegacyClPayoutState,
} from './vdrDualCursor'

const PAYOUT_ABI = [
	'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys) external',
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
] as const

function resolveClaimRpcUrl(): string {
	return requireClaimRpcUrlEnv()
}

function resolveClaimRpcHttpTimeoutMs(): number {
	const n = Number(process.env.CONET_RPC_HTTP_TIMEOUT_MS || 60_000)
	return Number.isFinite(n) && n >= 5_000 ? Math.min(300_000, Math.floor(n)) : 60_000
}

function resolveClaimTxWaitTimeoutMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_TX_WAIT_MS || 120_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.min(600_000, Math.floor(n)) : 120_000
}

/** Test-only seams (unit/integration tests inject stub provider, read contract and signer). Empty in production. */
export type FlushTestHooks = {
	provider?: unknown
	contract?: (addr: string) => unknown
	signerConfig?: { socketPath: string; keyArray: string }
	signerSend?: (tx: VdrSignerTx) => Promise<{ hash: string }>
	workerTimeoutMs?: number
}
let flushTestHooks: FlushTestHooks = {}
export function __setFlushTestHooks(h: FlushTestHooks | null): void {
	flushTestHooks = h ?? {}
}

async function sendSignerTx(tx: VdrSignerTx, socketPath: string): Promise<{ hash: string }> {
	if (flushTestHooks.signerSend) return flushTestHooks.signerSend(tx)
	return signerSendOnce(tx, socketPath)
}

function makeReadContract(addr: string, provider: ethers.JsonRpcProvider): ethers.Contract {
	if (flushTestHooks.contract) return flushTestHooks.contract(addr) as ethers.Contract
	return new ethers.Contract(addr, PAYOUT_ABI, provider)
}

function createClaimRpcProvider(): ethers.JsonRpcProvider {
	if (flushTestHooks.provider) return flushTestHooks.provider as ethers.JsonRpcProvider
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
/**
 * Committed-state cache: the last state written by mutateState, or the ledger file loaded once.
 * It is never rebuilt from the in-memory pending Map; pending lives only in state.pending.
 */
let stateCache: { file: string; state: DualCursorState } | null = null
/** Merge queue: every ledger write runs one at a time, each on the latest committed state. */
let stateQueue: Promise<unknown> = Promise.resolve()

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

function resolveChunksPerTick(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNKS_PER_TICK || 1)
	return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 1
}

function resolveMaxEntriesPerTx(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES || 29)
	return Number.isFinite(n) && n >= 1 ? Math.min(256, Math.floor(n)) : 29
}

/** Default gasLimit ceiling (unchanged from .77 baseline). Raised only when CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT is set explicitly. */
const VDR_PAYOUT_GAS_LIMIT_DEFAULT = 800_000
/** Maximum ceiling for an explicit tier; signer policy maxGas must be set to the same value. */
const VDR_PAYOUT_GAS_LIMIT_TIER_MAX = 2_000_000

/** CAP_B — first-batch executable amount hard gate (wei). */
const VDR_PAYOUT_MAX_AMOUNT_WEI_DEFAULT = 44_885_338_300_000_000n

function resolveGasLimit(): number {
	const raw = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT?.trim()
	if (!raw) return VDR_PAYOUT_GAS_LIMIT_DEFAULT
	const n = Number(raw)
	return Number.isFinite(n) && n >= 100_000
		? Math.min(VDR_PAYOUT_GAS_LIMIT_TIER_MAX, Math.floor(n))
		: VDR_PAYOUT_GAS_LIMIT_DEFAULT
}

/**
 * Pack-hash allowlist (1712Z): listHash = sha256(utf8(newline-joined lowercase eventKeys)).
 * CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH + CONET_VALIDATOR_CL_REWARD_PAYOUT_ALLOWLIST_FILE.
 * Out-of-list pending keys are NOT issued and remain in the queue unchanged.
 */
function sha256HexUtf8(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function computeAllowlistPackHash(keys: readonly string[]): string {
	const normalized = keys.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
	return sha256HexUtf8(normalized.join('\n'))
}

function resolveConfiguredPackHash(): string | null {
	const raw = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH?.trim().toLowerCase() ?? ''
	if (!raw) return null
	if (!/^[0-9a-f]{64}$/.test(raw)) {
		throw new Error(`invalid CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH=${raw}`)
	}
	return raw
}

function resolveAllowlistFilePath(): string | null {
	const raw = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ALLOWLIST_FILE?.trim() ?? ''
	return raw || null
}

function loadAllowlistKeysFromFileSync(filePath: string): string[] {
	const text = fs.readFileSync(filePath, 'utf8')
	return text
		.split(/\r?\n/)
		.map((line) => line.trim().toLowerCase())
		.filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * estimateGas `from` — required (1712Z fail-closed). Catch must NOT return cap.
 * CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM or CONET_VALIDATOR_CL_REWARD_PAYOUT_FROM.
 */
function resolveEstimateGasFrom(): string | null {
	const raw =
		process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM?.trim() ||
		process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_FROM?.trim() ||
		''
	if (!raw) return null
	try {
		return ethers.getAddress(raw)
	} catch {
		throw new Error(`invalid estimateGas from address=${raw}`)
	}
}

type SubmitGasResolve =
	| { ok: true; gasLimit: number }
	| { ok: false; reason: 'over_cap'; estimate: bigint; gasLimit: number }
	| { ok: false; reason: 'estimate_failed'; message: string }
	| { ok: false; reason: 'missing_from' }

/**
 * Load allowlist when PACK_HASH is set. File hash must equal env hash or flush aborts.
 * Returns null when allowlist gating is off (no PACK_HASH).
 */
function loadRuntimeAllowlistOrAbort():
	| { gated: false }
	| { gated: true; allowSet: Set<string>; packHash: string }
	| { gated: true; abort: true; reason: string } {
	const packHash = resolveConfiguredPackHash()
	if (!packHash) return { gated: false }
	const filePath = resolveAllowlistFilePath()
	if (!filePath) {
		return { gated: true, abort: true, reason: 'PACK_HASH set but ALLOWLIST_FILE missing' }
	}
	if (!fs.existsSync(filePath)) {
		return { gated: true, abort: true, reason: `ALLOWLIST_FILE not found: ${filePath}` }
	}
	const keys = loadAllowlistKeysFromFileSync(filePath)
	const fileHash = computeAllowlistPackHash(keys)
	if (fileHash !== packHash) {
		return {
			gated: true,
			abort: true,
			reason: `pack hash mismatch file=${fileHash} env=${packHash}`,
		}
	}
	return { gated: true, allowSet: new Set(keys), packHash }
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

function resolveMaxGasPriceWei(): bigint {
	const gwei = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_GAS_PRICE_GWEI || 2)
	const safe = Number.isFinite(gwei) && gwei > 0 ? gwei : 2
	return ethers.parseUnits(String(safe), 'gwei')
}

function resolveGasWaitForceMs(): number {
	const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_WAIT_FORCE_MS || 180_000)
	return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 180_000
}

/** Pure: the same state without gasWaitStartedAt; returns the input object when there is nothing to clear. */
function withGasWaitCleared(state: DualCursorState): DualCursorState {
	if (!state.gasWaitStartedAt) return state
	const { gasWaitStartedAt: _cleared, ...rest } = state
	return rest
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

const STATE_V2_KEYS = new Set([
	'version',
	'boundaryH',
	'historicalCursor',
	'realtimeCursor',
	'pending',
	'settleIntents',
	'gasWaitStartedAt',
	'firstBatchSettledWei',
	'metrics',
	'updatedAt',
	'lastProcessedBlock',
	'scanTargetBlock',
])
const STATE_LEGACY_KEYS = new Set([
	'lastProcessedBlock',
	'scanTargetBlock',
	'pending',
	'gasWaitStartedAt',
	'firstBatchSettledWei',
	'updatedAt',
])
const STATE_PENDING_KEYS = new Set([
	'guardianId',
	'amount',
	'eventKey',
	'blockNumber',
	'withdrawalIndex',
	'scanLine',
	'enqueuedAtMs',
])
const STATE_INTENT_KEYS = new Set([
	'intentId',
	'status',
	'createdAt',
	'updatedAt',
	'to',
	'guardianIds',
	'amounts',
	'eventKeys',
	'gasLimit',
	'idempotencyKey',
	'requestFingerprint',
	'data',
	'scanLines',
	'txHash',
	'receiptStatus',
	'note',
])
const STATE_BOUNDARY_KEYS = new Set(['blockNumber', 'blockHash'])
const STATE_INTENT_STATUSES = new Set(['prepared', 'broadcast', 'confirmed', 'uncertain', 'failed'])
const STATE_HEX32_RE = /^0x[0-9a-fA-F]{64}$/
const STATE_ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const STATE_HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/
const STATE_DEC_RE = /^(?:0|[1-9][0-9]*)$/
const STATE_SETTLE_SELECTOR = '0x21c7587a'

function stateRefuse(code: string, msg: string): never {
	throw new Error(`[reason=${code}] ${msg}`)
}
function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isIntAtLeast(v: unknown, min: number): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= min
}
function isDecPositive(v: unknown): boolean {
	return typeof v === 'string' && STATE_DEC_RE.test(v) && v !== '0'
}
function isHex32NonZero(v: unknown): boolean {
	return typeof v === 'string' && STATE_HEX32_RE.test(v) && v.toLowerCase() !== ethers.ZeroHash
}
function checkUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, code: string, where: string): void {
	for (const k of Object.keys(obj)) {
		if (!allowed.has(k)) stateRefuse(code, `${where} has unknown field "${k}"`)
	}
}
function checkPendingRows(rows: unknown[]): void {
	const seen = new Set<string>()
	rows.forEach((row, i) => {
		const at = `pending[${i}]`
		if (!isPlainRecord(row)) stateRefuse('STATE_PENDING_INVALID', `${at} is not an object`)
		checkUnknownKeys(row, STATE_PENDING_KEYS, 'STATE_PENDING_INVALID', at)
		if (!isHex32NonZero(row.eventKey)) stateRefuse('STATE_PENDING_INVALID', `${at}.eventKey invalid`)
		const key = (row.eventKey as string).toLowerCase()
		if (seen.has(key)) stateRefuse('STATE_PENDING_INVALID', `${at}.eventKey duplicated`)
		seen.add(key)
		if (!isDecPositive(row.guardianId)) stateRefuse('STATE_PENDING_INVALID', `${at}.guardianId invalid`)
		if (!isDecPositive(row.amount)) stateRefuse('STATE_PENDING_INVALID', `${at}.amount invalid`)
		if (!isIntAtLeast(row.blockNumber, 0)) stateRefuse('STATE_PENDING_INVALID', `${at}.blockNumber invalid`)
		if (!isIntAtLeast(row.withdrawalIndex, 0)) stateRefuse('STATE_PENDING_INVALID', `${at}.withdrawalIndex invalid`)
		if (row.scanLine !== undefined && row.scanLine !== 'historical' && row.scanLine !== 'realtime') {
			stateRefuse('STATE_PENDING_INVALID', `${at}.scanLine invalid`)
		}
		if (row.enqueuedAtMs !== undefined && (typeof row.enqueuedAtMs !== 'number' || !Number.isFinite(row.enqueuedAtMs))) {
			stateRefuse('STATE_PENDING_INVALID', `${at}.enqueuedAtMs invalid`)
		}
	})
}
function checkIntentRows(rows: unknown[]): void {
	const ids = new Set<string>()
	rows.forEach((row, i) => {
		const at = `settleIntents[${i}]`
		if (!isPlainRecord(row)) stateRefuse('STATE_INTENT_INVALID', `${at} is not an object`)
		checkUnknownKeys(row, STATE_INTENT_KEYS, 'STATE_INTENT_INVALID', at)
		const idem = row.idempotencyKey
		if (typeof idem !== 'string' || !/^vdr-settle:0x[0-9a-fA-F]{64}$/.test(idem)) {
			stateRefuse('STATE_INTENT_INVALID', `${at}.idempotencyKey invalid`)
		}
		if (ids.has(idem)) stateRefuse('STATE_INTENT_INVALID', `${at}.idempotencyKey duplicated`)
		ids.add(idem)
		if (typeof row.intentId !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') {
			stateRefuse('STATE_INTENT_INVALID', `${at} intentId/createdAt/updatedAt must be strings`)
		}
		if (typeof row.status !== 'string' || !STATE_INTENT_STATUSES.has(row.status)) {
			stateRefuse('STATE_INTENT_INVALID', `${at}.status invalid`)
		}
		if (typeof row.to !== 'string' || !STATE_ADDR_RE.test(row.to)) stateRefuse('STATE_INTENT_INVALID', `${at}.to invalid`)
		if (typeof row.data !== 'string' || !STATE_HEX_RE.test(row.data) || !row.data.toLowerCase().startsWith(STATE_SETTLE_SELECTOR)) {
			stateRefuse('STATE_INTENT_INVALID', `${at}.data is not settleNodeRewards calldata`)
		}
		if (!isHex32NonZero(row.requestFingerprint)) stateRefuse('STATE_INTENT_INVALID', `${at}.requestFingerprint invalid`)
		if (!isIntAtLeast(row.gasLimit, 1)) stateRefuse('STATE_INTENT_INVALID', `${at}.gasLimit invalid`)
		const gids = row.guardianIds
		const amts = row.amounts
		const keys = row.eventKeys
		const lines = row.scanLines
		if (!Array.isArray(gids) || !Array.isArray(amts) || !Array.isArray(keys) || !Array.isArray(lines)) {
			stateRefuse('STATE_INTENT_INVALID', `${at} guardianIds/amounts/eventKeys/scanLines must be arrays`)
		}
		if (gids.length === 0 || gids.length !== amts.length || gids.length !== keys.length || lines.length !== keys.length) {
			stateRefuse('STATE_INTENT_INVALID', `${at} array lengths differ or are empty`)
		}
		for (const g of gids) if (!isDecPositive(g)) stateRefuse('STATE_INTENT_INVALID', `${at}.guardianIds entry invalid`)
		for (const a of amts) if (!isDecPositive(a)) stateRefuse('STATE_INTENT_INVALID', `${at}.amounts entry invalid`)
		for (const k of keys) if (!isHex32NonZero(k)) stateRefuse('STATE_INTENT_INVALID', `${at}.eventKeys entry invalid`)
		for (const l of lines) {
			if (l !== 'historical' && l !== 'realtime') stateRefuse('STATE_INTENT_INVALID', `${at}.scanLines entry invalid`)
		}
		if (row.txHash !== undefined && !(typeof row.txHash === 'string' && STATE_HEX32_RE.test(row.txHash))) {
			stateRefuse('STATE_INTENT_INVALID', `${at}.txHash invalid`)
		}
		if (row.receiptStatus !== undefined && row.receiptStatus !== 0 && row.receiptStatus !== 1) {
			stateRefuse('STATE_INTENT_INVALID', `${at}.receiptStatus invalid`)
		}
		if (row.status === 'confirmed' && row.receiptStatus !== 1) stateRefuse('STATE_INTENT_INVALID', `${at} confirmed without receiptStatus 1`)
		if (row.status === 'failed' && row.receiptStatus === 1) stateRefuse('STATE_INTENT_INVALID', `${at} failed with receiptStatus 1`)
		if (row.note !== undefined && typeof row.note !== 'string') stateRefuse('STATE_INTENT_INVALID', `${at}.note invalid`)
	})
}

/**
 * Pure, fail-closed schema check run before any migration. Throws `[reason=CODE] ...` on the first problem.
 * cursorMin = deploy floor − 1 (never below −1); cursors below it are refused, not clamped.
 * Legacy single-cursor shape is accepted only when it has no version and only recognised fields.
 */
export function assertLoadableState(raw: unknown, cursorMin = -1): void {
	if (!isPlainRecord(raw)) stateRefuse('STATE_ROOT_NOT_OBJECT', 'state root is not a JSON object')
	if (raw.version === undefined) {
		checkUnknownKeys(raw, STATE_LEGACY_KEYS, 'STATE_LEGACY_UNRECOGNISED', 'legacy state')
		if (!isIntAtLeast(raw.lastProcessedBlock, cursorMin)) {
			stateRefuse('STATE_SCHEMA_INVALID', 'legacy state requires lastProcessedBlock (integer at or above floor)')
		}
		if (raw.pending !== undefined) {
			if (!Array.isArray(raw.pending)) stateRefuse('STATE_PENDING_INVALID', 'legacy pending must be an array')
			checkPendingRows(raw.pending)
		}
		if (raw.scanTargetBlock !== undefined && !isIntAtLeast(raw.scanTargetBlock, 0)) {
			stateRefuse('STATE_SCHEMA_INVALID', 'legacy scanTargetBlock invalid')
		}
		if (raw.firstBatchSettledWei !== undefined && !(typeof raw.firstBatchSettledWei === 'string' && STATE_DEC_RE.test(raw.firstBatchSettledWei))) {
			stateRefuse('STATE_SCHEMA_INVALID', 'legacy firstBatchSettledWei invalid')
		}
		if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'string') stateRefuse('STATE_SCHEMA_INVALID', 'legacy updatedAt invalid')
		if (raw.gasWaitStartedAt !== undefined && typeof raw.gasWaitStartedAt !== 'string') {
			stateRefuse('STATE_SCHEMA_INVALID', 'legacy gasWaitStartedAt invalid')
		}
		return
	}
	if (raw.version !== 2) stateRefuse('STATE_VERSION_UNSUPPORTED', `version=${String(raw.version)} (only 2, or legacy without version)`)
	checkUnknownKeys(raw, STATE_V2_KEYS, 'STATE_UNKNOWN_FIELD', 'state')
	for (const k of ['boundaryH', 'historicalCursor', 'realtimeCursor', 'pending', 'settleIntents']) {
		if (!(k in raw)) stateRefuse('STATE_SCHEMA_INVALID', `missing required field ${k}`)
	}
	if (!isIntAtLeast(raw.historicalCursor, cursorMin)) stateRefuse('STATE_CURSOR_INVALID', 'historicalCursor must be an integer at or above floor')
	if (!isIntAtLeast(raw.realtimeCursor, cursorMin)) stateRefuse('STATE_CURSOR_INVALID', 'realtimeCursor must be an integer at or above floor')
	const hist = raw.historicalCursor
	const rt = raw.realtimeCursor
	if (raw.boundaryH === null) {
		if (hist !== rt) stateRefuse('STATE_RELATION_INVALID', 'boundaryH null requires historicalCursor === realtimeCursor')
	} else {
		const b = raw.boundaryH
		if (!isPlainRecord(b)) stateRefuse('STATE_BOUNDARY_INVALID', 'boundaryH must be null or an object')
		checkUnknownKeys(b, STATE_BOUNDARY_KEYS, 'STATE_BOUNDARY_INVALID', 'boundaryH')
		if (!isIntAtLeast(b.blockNumber, 0) || typeof b.blockHash !== 'string' || !STATE_HEX32_RE.test(b.blockHash)) {
			stateRefuse('STATE_BOUNDARY_INVALID', 'boundaryH needs integer blockNumber and 0x-prefixed 32-byte blockHash')
		}
		const H = b.blockNumber as number
		if (hist > H) stateRefuse('STATE_RELATION_INVALID', 'historicalCursor is above boundaryH')
		if (rt < H) stateRefuse('STATE_RELATION_INVALID', 'realtimeCursor is below boundaryH')
	}
	if (!Array.isArray(raw.pending)) stateRefuse('STATE_PENDING_INVALID', 'pending must be an array')
	checkPendingRows(raw.pending)
	if (!Array.isArray(raw.settleIntents)) stateRefuse('STATE_INTENT_INVALID', 'settleIntents must be an array')
	checkIntentRows(raw.settleIntents)
	if (raw.firstBatchSettledWei !== undefined && !(typeof raw.firstBatchSettledWei === 'string' && STATE_DEC_RE.test(raw.firstBatchSettledWei))) {
		stateRefuse('STATE_SCHEMA_INVALID', 'firstBatchSettledWei invalid')
	}
	if (raw.metrics !== undefined && !isPlainRecord(raw.metrics)) stateRefuse('STATE_SCHEMA_INVALID', 'metrics must be an object')
	if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'string') stateRefuse('STATE_SCHEMA_INVALID', 'updatedAt invalid')
	if (raw.gasWaitStartedAt !== undefined && typeof raw.gasWaitStartedAt !== 'string') stateRefuse('STATE_SCHEMA_INVALID', 'gasWaitStartedAt invalid')
	if (raw.lastProcessedBlock !== undefined && !isIntAtLeast(raw.lastProcessedBlock, cursorMin)) {
		stateRefuse('STATE_CURSOR_INVALID', 'lastProcessedBlock invalid')
	}
	if (raw.scanTargetBlock !== undefined && !isIntAtLeast(raw.scanTargetBlock, 0)) stateRefuse('STATE_SCHEMA_INVALID', 'scanTargetBlock invalid')
}

/** Fail-closed state load: any read/parse/schema failure refuses (reason code in message). Never resets. */
function loadState(): DualCursorState {
	const file = resolveStateFile()
	const floor = resolveDeployBlockFloor()
	if (!fs.existsSync(file)) {
		if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ALLOW_FRESH_STATE === '1') {
			logger(Colors.yellow(`[validatorClRewardPayout] fresh state allowed (ALLOW_FRESH_STATE=1) file=${file}`))
			return migrateLegacyToDualCursor(null, floor)
		}
		throw new Error(`[reason=STATE_MISSING] state file missing (ALLOW_FRESH_STATE not set): ${file}`)
	}
	let text: string
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch (e: unknown) {
		throw new Error(`[reason=STATE_READ_FAILED] ${(e as Error)?.message ?? e} file=${file}`)
	}
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (e: unknown) {
		throw new Error(`[reason=STATE_PARSE_FAILED] ${(e as Error)?.message ?? e} file=${file}`)
	}
	try {
		assertLoadableState(raw, Math.max(-1, floor - 1))
	} catch (e: unknown) {
		throw new Error(`${(e as Error)?.message ?? e} file=${file}`)
	}
	return migrateLegacyToDualCursor(raw as LegacyClPayoutState, floor)
}

/** Latest committed state. Synchronous: never hold the returned object across an await. */
function latestStateSync(): DualCursorState {
	const file = resolveStateFile()
	if (!stateCache || stateCache.file !== file) stateCache = { file, state: loadState() }
	return stateCache.state
}

/** Synchronous read of the latest committed state, for decisions with no await before their use. */
export function peekLatestState(): DualCursorState {
	return latestStateSync()
}

/** Run one job after every earlier job has settled; a rejected job does not block the queue. */
function enqueueStateJob<T>(job: () => T): Promise<T> {
	const run = stateQueue.then(job)
	stateQueue = run.catch(() => undefined)
	return run
}

/**
 * Serial state merge: the only writer of the ledger file.
 * `fn` is synchronous (no await, no RPC): it receives the latest committed state and returns the next one.
 * Returning the same object means "no change" and skips the write. Callers do RPC / sign / broadcast
 * outside and merge the result here, so no state is held across an await.
 */
export function mutateState(fn: (latest: DualCursorState) => DualCursorState): Promise<DualCursorState> {
	return enqueueStateJob(() => {
		const base = latestStateSync()
		const next = fn(base)
		if (next === base) return base
		const file = resolveStateFile()
		const committed: DualCursorState = {
			...next,
			lastProcessedBlock: next.historicalCursor,
			updatedAt: new Date().toISOString(),
		}
		atomicWriteState(file, committed)
		stateCache = { file, state: committed }
		return committed
	})
}

/** Re-read the ledger file inside the queue (tick start, harness). Fail-closed: loadState throws on any problem. */
function refreshStateFromDisk(): Promise<DualCursorState> {
	return enqueueStateJob(() => {
		stateCache = null
		return latestStateSync()
	})
}

/** Derived view of state.pending keyed by eventKey. Read-only: it is never written back. */
function pendingMapFromState(state: DualCursorState): Map<string, PayoutEntry> {
	const map = new Map<string, PayoutEntry>()
	for (const raw of state.pending) {
		const e = entryFromJson(raw)
		if (!e) continue
		map.set(e.eventKey, e)
	}
	return map
}

const OPEN_INTENT_STATUSES: ReadonlySet<string> = new Set(['prepared', 'broadcast', 'uncertain'])

/** Keys that may be issued now: pending in the latest state and not owned by an open intent. */
function signableKeySet(state: DualCursorState): Set<string> {
	const inflight = new Set(
		state.settleIntents
			.filter((i) => OPEN_INTENT_STATUSES.has(i.status))
			.flatMap((i) => i.eventKeys.map((k) => k.toLowerCase()))
	)
	return new Set(state.pending.map((p) => p.eventKey.toLowerCase()).filter((k) => !inflight.has(k)))
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

/**
 * Fail-closed estimateGas (1712Z): `from` required; buffer = floor(est×1.2)+50000.
 * Catch MUST NOT return cap — abort / do not sign (estimate_failed).
 * over_cap → needs_split path; estimate_failed → leave pending, no bisect.
 */
async function resolveSubmitGasLimit(
	contract: ethers.Contract,
	guardianIds: bigint[],
	amounts: bigint[],
	eventKeys: string[]
): Promise<SubmitGasResolve> {
	const from = resolveEstimateGasFrom()
	if (!from) return { ok: false, reason: 'missing_from' }
	const cap = resolveGasLimit()
	try {
		const est = await contract.settleNodeRewards!.estimateGas(guardianIds, amounts, eventKeys, {
			from,
		})
		const buffered = (est * 120n) / 100n + 50_000n
		if (buffered > BigInt(cap)) {
			return { ok: false, reason: 'over_cap', estimate: est, gasLimit: cap }
		}
		return { ok: true, gasLimit: Number(buffered) }
	} catch (e: unknown) {
		const message = (e as Error)?.message ?? String(e)
		return { ok: false, reason: 'estimate_failed', message: message.slice(0, 240) }
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
 * Per-batch pre-sign check (replaces the former whole-queue serial sweep).
 * Only the keys of the batch about to be signed are read. A read that throws is
 * UNKNOWN: the key is never treated as unconsumed, is not signed this tick, and stays pending.
 * The on-chain consumedRewardEventKey guard in ValidatorDepositRedeemRewardLib is unchanged.
 */
export async function checkBatchUnconsumed(
	readContract: ethers.Contract,
	entries: PayoutEntry[]
): Promise<{ payable: PayoutEntry[]; consumed: PayoutEntry[]; unknown: PayoutEntry[] }> {
	const payable: PayoutEntry[] = []
	const consumed: PayoutEntry[] = []
	const unknown: PayoutEntry[] = []
	for (const e of entries) {
		let raw: unknown
		try {
			raw = await readContract.consumedRewardEventKey!(e.eventKey)
		} catch {
			unknown.push(e)
			continue
		}
		// Only a real boolean may enter the consumed / unconsumed branches (R4 B3).
		if (typeof raw !== 'boolean') {
			unknown.push(e)
			continue
		}
		if (raw) consumed.push(e)
		else payable.push(e)
	}
	return { payable, consumed, unknown }
}

type SubmitOutcome =
	| 'ok'
	| 'needs_split'
	| 'failed'
	| 'uncertain'
	| 'amount_blocked'
	| 'estimate_failed'

function intentCoversPending(intent: SettleIntent, pending: Map<string, PayoutEntry>): boolean {
	return intent.eventKeys.every((k) => pending.has(k.toLowerCase()))
}

/** True when every intent eventKey is already consumed on-chain (ACK-lost / SIGKILL before local confirm). */
async function intentConsumedOnChain(
	provider: ethers.JsonRpcProvider,
	to: string,
	eventKeys: string[]
): Promise<'consumed' | 'open' | 'unknown'> {
	if (!eventKeys.length) return 'unknown'
	const c = makeReadContract(to, provider)
	let allConsumed = true
	let sawUnknown = false
	for (const k of eventKeys) {
		let raw: unknown
		try {
			raw = await c.consumedRewardEventKey!(k)
		} catch {
			sawUnknown = true
			continue
		}
		if (typeof raw !== 'boolean') {
			sawUnknown = true
			continue
		}
		if (!raw) allConsumed = false
	}
	// Any read failure or non-boolean result is UNKNOWN: never treated as unconsumed (R4 B2).
	if (sawUnknown) return 'unknown'
	return allConsumed ? 'consumed' : 'open'
}

/** Pure: credit an intent confirmed with receipt status 1 once, and clear its pending keys. */
function creditConfirmedIntent(state: DualCursorState, intent: SettleIntent): DualCursorState {
	return removePendingKeys(markIntentConfirmed(state, intent.idempotencyKey, 1), intent.eventKeys)
}

/**
 * Persist settle intent BEFORE broadcast. On ACK loss, rebuild the same
 * idempotencyKey + fingerprint — never invent a new batch.
 * Every state change is its own serial merge; signer and receipt awaits run outside the queue.
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

	const config = flushTestHooks.signerConfig ?? readVdrSignerConfig()
	if (!config) {
		logger(
			Colors.red(
				'[validatorClRewardPayout] refuse settleNodeRewards: signer socket or keyArray is not configured'
			)
		)
		return 'failed'
	}

	const provider = createClaimRpcProvider()
	const readContract = makeReadContract(contractAddr, provider)
	const gasResolve = await resolveSubmitGasLimit(readContract, guardianIds, amounts, eventKeys)
	if (!gasResolve.ok) {
		if (gasResolve.reason === 'over_cap') {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] estimateGas+20% exceeds gasLimit=${gasResolve.gasLimit} for n=${entries.length} est=${gasResolve.estimate.toString()} — will auto-split`
				)
			)
			return 'needs_split'
		}
		if (gasResolve.reason === 'missing_from') {
			logger(
				Colors.red(
					'[validatorClRewardPayout] estimateGas missing from — set CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM; abort sign'
				)
			)
			return 'estimate_failed'
		}
		logger(
			Colors.red(
				`[validatorClRewardPayout] estimateGas failed (fail-closed, no cap fallback) n=${entries.length}: ${gasResolve.message} — leave pending, do not sign`
			)
		)
		return 'estimate_failed'
	}
	const gasLimit = gasResolve.gasLimit

	const intent = prepareSettleIntent({
		to: contractAddr,
		guardianIds,
		amounts,
		eventKeys,
		gasLimit,
		keyArray: config.keyArray,
		scanLines,
	})
	// Durable before broadcast: merge the prepared intent into the latest state, then sign.
	await mutateState((s) => attachIntentToState(s, intent))

	const tx: VdrSignerTx = rebuildSignerTxFromIntent(intent, config.keyArray)

	logger(
		Colors.cyan(
			`[validatorClRewardPayout] PRE_SIGN ACCEPT eventKeys=${eventKeys.join(',')} batchSumWei=${amountGate.batchSumWei} capWei=${amountGate.capWei} n=${entries.length}`
		)
	)

	try {
		const { hash } = await sendSignerTx(tx, config.socketPath)
		await mutateState((s) => markIntentBroadcast(s, intent.idempotencyKey, hash))
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] settleNodeRewards sent via signer tx=${hash} waiting≤${resolveClaimTxWaitTimeoutMs()}ms n=${entries.length} eventKeys=${eventKeys.join(',')} gasPrice=${ethers.formatUnits(gasPriceWei, 'gwei')}gwei idem=${intent.idempotencyKey.slice(0, 24)}…`
			)
		)
		const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
		await mutateState((s) => markIntentConfirmed(s, intent.idempotencyKey, receipt.status ?? 0))
		if (receipt.status !== 1) {
			throw new Error(`settleNodeRewards reverted status=${receipt.status} hash=${hash}`)
		}
		logger(Colors.green(`[validatorClRewardPayout] settleNodeRewards ok tx=${hash} n=${entries.length}`))
		return 'ok'
	} catch (e: unknown) {
		const msg = (e as Error)?.message ?? String(e)
		const ackLost = /timed out|ECONNRESET|socket|ACK|no transaction hash/i.test(msg)
		if (ackLost) {
			await mutateState((s) =>
				markIntentUncertain(s, intent.idempotencyKey, `ack_lost_after_broadcast:${msg.slice(0, 120)}`)
			)
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] ACK uncertain after broadcast; preserving intent idem=${intent.idempotencyKey.slice(0, 24)}… fp=${intent.requestFingerprint.slice(0, 18)}…`
				)
			)
			return 'uncertain'
		}
		await mutateState((s) => markIntentFailed(s, intent.idempotencyKey, `signer_failed:${msg.slice(0, 120)}`))
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
	gasPriceWei: bigint
): Promise<void> {
	if (!entries.length) return

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
		// Merge into the latest state; a key that is already gone is a no-op.
		const settledKeys = entries.map((e) => e.eventKey)
		await mutateState((s) => removePendingKeys(s, settledKeys))
		// 1712Z Anvil mid-restart: optional abort after N successful settles.
		if (engAbortAfterSuccessfulSettles != null) {
			engSuccessfulSettles += 1
			if (engSuccessfulSettles >= engAbortAfterSuccessfulSettles) {
				throw new Error(
					`ENG_ABORT_AFTER_SUCCESSFUL_SETTLES n=${engSuccessfulSettles} limit=${engAbortAfterSuccessfulSettles}`
				)
			}
		}
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

	// 1712Z: estimate_failed must NOT auto-bisect (distinct from over_cap → needs_split).
	if (outcome === 'estimate_failed') {
		logger(
			Colors.red(
				`[validatorClRewardPayout] leave batch in pending after estimate_failed; no auto-split n=${entries.length}`
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
	await submitPayoutBatchAutoSplit(contractAddr, left, gasPriceWei)
	await submitPayoutBatchAutoSplit(contractAddr, right, gasPriceWei)
}

async function submitPayoutBatchAutoSplit(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint
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
		// Synchronous read of the latest committed state; the decision is taken before any await.
		const { selected, deferred, remainingWei } = selectEntriesUnderFirstBatchBudget(
			payable,
			peekLatestState(),
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
		await submitPayableBatch(contractAddr, pack, gasPriceWei)
	}
}

/**
 * Fetch and collect payout rows for a block range. Read-only: returns rows instead of touching state.
 * The caller merges rows through commitScanRange, which is the only path that moves a cursor.
 */
async function scanBlocksIntoPending(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	proxyAddr: string,
	fromBlock: number,
	toBlock: number,
	scanLine: ScanLine
): Promise<{ okThrough: number | null; okThroughHash?: string; scanned: PayoutEntry[]; fetchFailed: boolean }> {
	const proxyLower = proxyAddr.toLowerCase()
	let okThrough: number | null = null
	let okThroughHash: string | undefined
	const scanned: PayoutEntry[] = []
	for (let bn = fromBlock; bn <= toBlock; bn++) {
		const block = await fetchBlockWithWithdrawals(provider, bn)
		if (!block) {
			return { okThrough, okThroughHash, scanned, fetchFailed: true }
		}
		const entries = await collectPayoutEntriesForBlock(readContract, proxyLower, bn, block, scanLine)
		scanned.push(...entries)
		okThrough = bn
		okThroughHash = typeof block.hash === 'string' ? block.hash.toLowerCase() : undefined
	}
	return { okThrough, okThroughHash, scanned, fetchFailed: false }
}

/**
 * Recover open intents after power-loss / ACK loss using persisted idempotencyKey + fingerprint.
 * Does NOT invent a new batch; rebuilds the original signer tx.
 */
/**
 * Replace/drop judgment for an intent whose txHash has no receipt (R4 B2 follow-up).
 * Provable only when the signer account's on-chain nonce has moved past the tx nonce while
 * our hash still has no receipt: then another tx consumed that nonce (replacement) or ours was
 * dropped. A same-nonce tx mined elsewhere implies latest > nonce, so this single check covers both.
 * Any missing data or RPC error => 'wait'. Rebuild still requires intentConsumedOnChain === 'open'.
 */
export async function judgeTxReplacedOrDropped(
	provider: ethers.JsonRpcProvider,
	intent: Pick<SettleIntent, 'txHash'>
): Promise<'replaced_or_dropped' | 'wait'> {
	if (!intent.txHash) return 'wait'
	let tx: { from?: string | null; nonce?: number | null } | null
	try {
		tx = (await provider.getTransaction(intent.txHash)) as { from?: string | null; nonce?: number | null } | null
	} catch {
		return 'wait'
	}
	if (!tx || !tx.from || typeof tx.nonce !== 'number' || !Number.isSafeInteger(tx.nonce)) return 'wait'
	let latest: number
	try {
		latest = Number(await provider.getTransactionCount(tx.from, 'latest'))
	} catch {
		return 'wait'
	}
	if (!Number.isSafeInteger(latest)) return 'wait'
	return latest > tx.nonce ? 'replaced_or_dropped' : 'wait'
}

const intentWaitSince = new Map<string, number>()
const intentWaitAlerted = new Set<string>()

/** Record waiting time for an intent; alert once past the limit. Never resends. */
function noteIntentWaiting(intent: Pick<SettleIntent, 'idempotencyKey'>): void {
	const now = Date.now()
	const first = intentWaitSince.get(intent.idempotencyKey) ?? now
	intentWaitSince.set(intent.idempotencyKey, first)
	const limitRaw = Number(process.env.CONET_VALIDATOR_CL_INTENT_WAIT_ALERT_MS || 1_800_000)
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 1_800_000
	if (now - first >= limit && !intentWaitAlerted.has(intent.idempotencyKey)) {
		intentWaitAlerted.add(intent.idempotencyKey)
		logger(
			Colors.red(
				`[validatorClRewardPayout] ALERT intent still without receipt after ${Math.floor((now - first) / 1000)}s; not resending idem=${intent.idempotencyKey.slice(0, 24)}…`
			)
		)
	}
}

async function recoverOpenIntents(provider: ethers.JsonRpcProvider): Promise<void> {
	const open = peekLatestState().settleIntents.filter(
		(i) => i.status === 'broadcast' || i.status === 'uncertain' || i.status === 'prepared'
	)
	if (!open.length) return

	const config = flushTestHooks.signerConfig ?? readVdrSignerConfig()
	for (const snapshot of open) {
		// Re-read this intent from the latest state: an earlier step may already have settled it.
		const intent = peekLatestState().settleIntents.find((i) => i.idempotencyKey === snapshot.idempotencyKey)
		if (!intent || !OPEN_INTENT_STATUSES.has(intent.status)) continue

		if (!intentCoversPending(intent, pendingMapFromState(peekLatestState())) && intent.status === 'prepared') {
			// Pending keys gone — credit if chain already consumed; else drop stale intent.
			const onChainPrep = await intentConsumedOnChain(provider, intent.to, intent.eventKeys)
			if (onChainPrep === 'unknown') {
				logger(Colors.yellow(`[validatorClRewardPayout] prepared intent on-chain status unknown; hold (no resend, no drop) idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			if (onChainPrep === 'consumed') {
				await mutateState((s) => creditConfirmedIntent(s, intent))
				logger(
					Colors.green(
						`[validatorClRewardPayout] prepared intent credited via on-chain consumed (pending cleared) idem=${intent.idempotencyKey.slice(0, 24)}…`
					)
				)
				continue
			}
			// Drop only while the intent is still prepared in the latest state.
			await mutateState((s) => ({
				...s,
				settleIntents: s.settleIntents.filter(
					(i) => !(i.idempotencyKey === intent.idempotencyKey && i.status === 'prepared')
				),
				updatedAt: new Date().toISOString(),
			}))
			continue
		}

		if (intent.txHash) {
			try {
				const receipt = await provider.getTransactionReceipt(intent.txHash)
				if (receipt) {
					// Status 1 credits once and clears pending; a reverted receipt keeps pending keys.
					await mutateState((s) =>
						receipt.status === 1
							? creditConfirmedIntent(s, intent)
							: markIntentConfirmed(s, intent.idempotencyKey, receipt.status ?? 0)
					)
					logger(
						Colors.green(
							`[validatorClRewardPayout] recovered intent via txHash receipt status=${receipt.status} idem=${intent.idempotencyKey.slice(0, 24)}…`
						)
					)
					continue
				}
			} catch {
				/* receipt query failed: unknown, hold below */
			}
			// txHash present without a receipt: only a provable replace/drop may proceed to rebuild (checked below).
			const verdict = await judgeTxReplacedOrDropped(provider, intent)
			if (verdict !== 'replaced_or_dropped') {
				noteIntentWaiting(intent)
				logger(Colors.yellow(`[validatorClRewardPayout] intent txHash has no receipt; wait (no rebuild, no resend) idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			logger(Colors.yellow(`[validatorClRewardPayout] intent txHash replaced/dropped (signer nonce consumed without receipt); verifying on-chain before rebuild idem=${intent.idempotencyKey.slice(0, 24)}…`))
			// Falls through: rebuild only if intentConsumedOnChain === 'open' (below).
		}

		// Chain already settled this intent (ACK lost / SIGKILL before broadcast mark) — credit once, do not resend.
		const onChainAck = await intentConsumedOnChain(provider, intent.to, intent.eventKeys)
		if (onChainAck === 'unknown') {
			logger(Colors.yellow(`[validatorClRewardPayout] ACK-lost on-chain status unknown; hold (no resend) idem=${intent.idempotencyKey.slice(0, 24)}…`))
			continue
		}
		if (onChainAck === 'consumed') {
			await mutateState((s) => creditConfirmedIntent(s, intent))
			logger(
				Colors.green(
					`[validatorClRewardPayout] ACK-lost intent credited via on-chain consumed; skip resend idem=${intent.idempotencyKey.slice(0, 24)}…`
				)
			)
			continue
		}

		// ACK lost: rebuild original batch from fingerprint; only resend same idempotencyKey.
		if (!config) {
			await mutateState((s) => reconcileAckLostIntent(s, intent.idempotencyKey, { safeToResend: false }).state)
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] ACK-lost intent held (no signer); refuse blind resend idem=${intent.idempotencyKey.slice(0, 24)}…`
				)
			)
			continue
		}

		try {
			const tx = rebuildSignerTxFromIntent(intent, config.keyArray)
			const { hash } = await sendSignerTx(tx, config.socketPath)
			await mutateState((s) => reconcileAckLostIntent(s, intent.idempotencyKey, { txHash: hash, safeToResend: true }).state)
			const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
			await mutateState((s) =>
				receipt.status === 1
					? creditConfirmedIntent(s, intent)
					: markIntentConfirmed(s, intent.idempotencyKey, receipt.status ?? 0)
			)
			logger(
				Colors.green(
					`[validatorClRewardPayout] ACK-lost recovered ORIGINAL batch tx=${hash} idem=${intent.idempotencyKey.slice(0, 24)}… fp=${intent.requestFingerprint.slice(0, 18)}…`
				)
			)
		} catch (e: unknown) {
			await mutateState((s) => reconcileAckLostIntent(s, intent.idempotencyKey, { safeToResend: false }).state)
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
	contractAddr: string
): Promise<void> {
	if (!peekLatestState().pending.length) {
		await mutateState((s) => withGasWaitCleared(s))
		return
	}

	const maxGas = resolveMaxGasPriceWei()
	const gasDustWei = 50_000_000n
	const gasPrice = await readGasPriceWei(provider)
	const forceMs = resolveGasWaitForceMs()
	let forceFlush = false

	if (gasPrice > maxGas + gasDustWei) {
		const now = Date.now()
		const waited = await mutateState((s) =>
			s.gasWaitStartedAt ? s : { ...s, gasWaitStartedAt: new Date(now).toISOString() }
		)
		const startedMs = Date.parse(waited.gasWaitStartedAt!)
		const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : forceMs
		if (elapsedMs < forceMs) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] skip flush: gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei > max=${ethers.formatUnits(maxGas, 'gwei')} gwei ` +
						`wait ${formatWaitCountdown(elapsedMs, forceMs)} pending=${waited.pending.length}`
				)
			)
			return
		}
		forceFlush = true
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] force flush: gas wait ${Math.floor(elapsedMs / 1000)}s ≥ ${Math.floor(forceMs / 1000)}s; ` +
					`ignoring max=${ethers.formatUnits(maxGas, 'gwei')} gwei, using live gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei (pending=${waited.pending.length})`
			)
		)
	} else {
		await mutateState((s) => withGasWaitCleared(s))
	}

	if (!peekLatestState().pending.length) {
		await mutateState((s) => withGasWaitCleared(s))
		return
	}

	// 1712Z pack-hash allowlist: out-of-list keys stay in pending unchanged (not issued).
	const allowGate = loadRuntimeAllowlistOrAbort()
	let issueAllowSet: Set<string> | null = null
	if (allowGate.gated) {
		if ('abort' in allowGate && allowGate.abort) {
			logger(
				Colors.red(
					`[validatorClRewardPayout] allowlist abort flush (${allowGate.reason}); leave all pending unchanged`
				)
			)
			return
		}
		if ('allowSet' in allowGate) {
			issueAllowSet = allowGate.allowSet
			const outOfList = [...pendingMapFromState(peekLatestState()).keys()].filter(
				(k) => !issueAllowSet!.has(k.toLowerCase())
			)
			if (outOfList.length) {
				logger(
					Colors.yellow(
						`[validatorClRewardPayout] allowlist skip issue outOfList=${outOfList.length} (retain pending); packHash=${allowGate.packHash.slice(0, 16)}…`
					)
				)
			}
		}
	}

	const flushPlan = planFlushOrder(peekLatestState(), {
		maxEntriesPerTx: resolveMaxEntriesPerTx(),
		realtimeQuota: resolveRealtimeFlushQuota(),
		historicalFloor: resolveHistoricalFlushFloor(),
	})
	const recorded = await mutateState((s) => recordRealtimeLatency(s, flushPlan.realtimeLatencyMs))

	const latencyAvg =
		flushPlan.realtimeLatencyMs.length > 0
			? Math.round(flushPlan.realtimeLatencyMs.reduce((a, b) => a + b, 0) / flushPlan.realtimeLatencyMs.length)
			: 0
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] flush plan rtBatches=${flushPlan.realtimeBatchCount} histBatches=${flushPlan.historicalBatchCount} ` +
				`historyProgressing=${flushPlan.historyStillProgressing ? 1 : 0} rtLatencyAvgMs=${latencyAvg} ` +
				`pending=${recorded.pending.length} histCursor=${recorded.historicalCursor} rtCursor=${recorded.realtimeCursor} ` +
				`gasPrice=${ethers.formatUnits(gasPrice, 'gwei')}gwei${forceFlush ? ' force=1' : ''}`
		)
	)

	for (const batchJson of flushPlan.batches) {
		// Latest view before each batch: keys settled or owned by an open intent since the plan was made are skipped.
		const live = signableKeySet(peekLatestState())
		const batch: PayoutEntry[] = []
		for (const j of batchJson) {
			const e = entryFromJson(j)
			if (!e || !live.has(e.eventKey)) continue
			if (issueAllowSet && !issueAllowSet.has(e.eventKey.toLowerCase())) continue
			batch.push(e)
		}
		if (!batch.length) continue
		// Further split by gas/calldata heuristics; over_cap may auto-bisect; estimate_failed does not.
		for (const sub of splitEntriesForOnchain(batch)) {
			const chk = await checkBatchUnconsumed(readContract, sub)
			if (chk.consumed.length) {
				const ck = chk.consumed.map((e) => e.eventKey)
				await mutateState((s) => removePendingKeys(s, ck))
				logger(Colors.cyan(`[validatorClRewardPayout] batch pre-check: ${ck.length} already consumed; removed from pending`))
			}
			if (chk.unknown.length) {
				logger(Colors.yellow(`[validatorClRewardPayout] batch pre-check: ${chk.unknown.length} unknown (RPC error); not signed this tick`))
			}
			if (chk.payable.length) {
				// The RPC await above may have let a merge remove a key or own it: re-check against the latest state.
				const liveNow = signableKeySet(peekLatestState())
				const payable = chk.payable.filter((e) => liveNow.has(e.eventKey))
				if (payable.length) await submitPayoutBatchAutoSplit(contractAddr, payable, gasPrice)
			}
		}
	}

	if (!peekLatestState().pending.length) {
		await mutateState((s) => withGasWaitCleared(s))
	}
}

/** Merge one scanned range into the latest state (cursor advance plus new rows). Returns the count of rows newly added. */
async function commitScanRange(
	line: ScanLine,
	from: number,
	okThrough: number,
	okThroughHash: string | undefined,
	scanned: PayoutEntry[]
): Promise<number> {
	const rows = scanned
		.filter((e) => e.scanLine === line && e.blockNumber >= from && e.blockNumber <= okThrough)
		.map(entryToJson)
	let added = 0
	await mutateState((s) => {
		const next = commitScanProgress(s, { line, okThrough, entries: rows, okThroughHash })
		added = next.pending.length - s.pending.length
		return next
	})
	return added
}

type WorkerKind = 'historical' | 'realtime' | 'flush'
const WORKER_KINDS: readonly WorkerKind[] = ['historical', 'realtime', 'flush']
/** Independent workers: historical scan line, realtime scan line, and one flush (signing) lane. */
const workerBusy: Record<WorkerKind, boolean> = { historical: false, realtime: false, flush: false }
const workerRun: Record<WorkerKind, number> = { historical: 0, realtime: 0, flush: 0 }
const workerTimers: Partial<Record<WorkerKind, ReturnType<typeof setTimeout>>> = {}

function resolveWorkerRpcTimeoutMs(): number {
	return flushTestHooks.workerTimeoutMs ?? resolveClaimRpcHttpTimeoutMs()
}

/** Check the locked H against the chain and lock it once (idempotent). Returns false when no H hash is available. */
async function checkAndLockBoundary(
	provider: ethers.JsonRpcProvider,
	liveHead: number,
	tipHash: string,
	depth: number
): Promise<boolean> {
	const boundary = peekLatestState().boundaryH
	if (boundary) {
		const hBlock = await fetchBlockWithWithdrawals(provider, boundary.blockNumber)
		const hHash = typeof hBlock?.hash === 'string' ? hBlock.hash.toLowerCase() : ''
		if (hHash && hHash !== boundary.blockHash) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] reorg vs H=${boundary.blockNumber}: stored=${boundary.blockHash.slice(0, 12)}… live=${hHash.slice(0, 12)}…`
				)
			)
			// Roll back only the boundary this mismatch was detected on; otherwise leave the latest state alone.
			await mutateState((s) =>
				s.boundaryH &&
				s.boundaryH.blockNumber === boundary.blockNumber &&
				s.boundaryH.blockHash === boundary.blockHash
					? applyReorgRollback(s, boundary.blockNumber, boundary.blockHash, hHash)
					: s
			)
		}
	}
	// H locks at confirmed tip (liveHead - depth); persist that block's own hash.
	const prospectiveH = Math.max(0, liveHead - depth, peekLatestState().historicalCursor)
	const hLockBlock = await fetchBlockWithWithdrawals(provider, prospectiveH)
	const hLockHash = typeof hLockBlock?.hash === 'string' ? hLockBlock.hash.toLowerCase() : tipHash.toLowerCase()
	if (!/^0x[0-9a-f]{64}$/.test(hLockHash)) {
		logger(Colors.yellow(`[validatorClRewardPayout] H block ${prospectiveH} hash unavailable; skip scan step`))
		return false
	}
	let lockedNow = false
	await mutateState((s) => {
		const locked = ensureBoundaryH(s, liveHead, hLockHash, depth)
		lockedNow = locked.lockedNow
		return locked.state
	})
	if (lockedNow) {
		const locked = peekLatestState()
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] locked H=${locked.boundaryH!.blockNumber} hash=${locked.boundaryH!.blockHash.slice(0, 14)}… ` +
					`histCursor=${locked.historicalCursor} rtCursor=${locked.realtimeCursor} depth=${depth}`
			)
		)
	}
	return true
}

/** One scan step of one line. Its RPC reads run outside the queue; the result is merged as one serial commit. */
async function scanLineStep(
	kind: 'historical' | 'realtime',
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	proxyAddr: string
): Promise<void> {
	const floor = resolveDeployBlockFloor()
	const liveHead = Number(await provider.getBlockNumber())
	if (!Number.isFinite(liveHead) || liveHead < floor) return
	const depth = resolveConfirmationDepth()
	const tipBlock = await fetchBlockWithWithdrawals(provider, liveHead)
	if (!tipBlock?.hash) {
		logger(Colors.yellow(`[validatorClRewardPayout] tip hash unavailable at ${liveHead}; skip ${kind} step`))
		return
	}
	if (!(await checkAndLockBoundary(provider, liveHead, String(tipBlock.hash), depth))) return

	const chunk = resolveChunkBlocks() * resolveChunksPerTick()
	const plan = planScanRanges(peekLatestState(), liveHead, {
		confirmationDepth: depth,
		historicalChunk: chunk,
		realtimeChunk: chunk,
	})
	const range = kind === 'historical' ? plan.historical : plan.realtime
	if (!range) return
	const { from, to } = range
	const { okThrough, okThroughHash, scanned, fetchFailed } = await scanBlocksIntoPending(
		provider,
		readContract,
		proxyAddr,
		from,
		to,
		kind
	)
	if (okThrough != null) {
		const added = await commitScanRange(kind, from, okThrough, okThroughHash, scanned)
		if (added > 0) {
			logger(
				Colors.cyan(
					`[validatorClRewardPayout] ${kind} +${added} pending=${peekLatestState().pending.length} through ${from}..${okThrough}`
				)
			)
		}
	}
	if (fetchFailed || okThrough == null || okThrough < to) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] ${kind} scan stop at ${okThrough ?? from - 1}; retry next step`
			)
		)
	}
}

/**
 * Run one step of one worker under its own RPC timeout. A step that exceeds the timeout is logged as UNKNOWN
 * and released at once, so the worker retries on its next schedule; the other workers never wait for it.
 * A stale step that finishes later merges through the same serial queue, and cursors never move backward.
 */
async function runWorkerStep(kind: WorkerKind): Promise<'done' | 'busy' | 'timeout'> {
	if (workerBusy[kind]) return 'busy'
	workerBusy[kind] = true
	const run = ++workerRun[kind]
	const job = (async () => {
		const proxyAddr = resolveValidatorDepositRedeemAddress()
		if (!proxyAddr) {
			logger(Colors.yellow('[validatorClRewardPayout] CONET_VALIDATOR_DEPOSIT_REDEEM not configured — skip'))
			return
		}
		const provider = createClaimRpcProvider()
		const readContract = makeReadContract(proxyAddr, provider)
		if (kind === 'flush') {
			await recoverOpenIntents(provider)
			await flushPendingBatches(provider, readContract, proxyAddr)
		} else {
			await scanLineStep(kind, provider, readContract, proxyAddr)
		}
	})().catch((e: unknown) => {
		logger(Colors.red(`[validatorClRewardPayout] ${kind} worker error: ${(e as Error)?.message ?? e}`))
	})
	const timeoutMs = resolveWorkerRpcTimeoutMs()
	let timer: ReturnType<typeof setTimeout> | undefined
	const outcome = await Promise.race<'done' | 'timeout'>([
		job.then(() => 'done' as const),
		new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), timeoutMs)
		}),
	])
	if (timer !== undefined) clearTimeout(timer)
	if (outcome === 'timeout') {
		workerRun[kind]++
		workerBusy[kind] = false
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] ${kind} step exceeded ${timeoutMs}ms: UNKNOWN, deferred to next step (other workers unaffected)`
			)
		)
	} else if (workerRun[kind] === run) {
		workerBusy[kind] = false
	}
	return outcome
}

/** Sequential runner (harness / tests): one step of each worker in order. The timers never use it. */
async function payoutTick(): Promise<void> {
	await runWorkerStep('historical')
	await runWorkerStep('realtime')
	await runWorkerStep('flush')
}

function scheduleWorker(kind: WorkerKind): void {
	if (!payoutStarted) return
	workerTimers[kind] = setTimeout(async () => {
		await runWorkerStep(kind)
		scheduleWorker(kind)
	}, resolveTickMs())
}

/** Test/ops harness: run one step of a single worker (used to drive workers concurrently in tests). */
export function __engHarnessRunWorkerOnce(kind: WorkerKind): Promise<'done' | 'busy' | 'timeout'> {
	return runWorkerStep(kind)
}

export function startValidatorClRewardPayoutReporter(): void {
	if (payoutStarted) return
	if (!payoutEnabled()) {
		logger(Colors.yellow('[validatorClRewardPayout] disabled (set CONET_VALIDATOR_CL_REWARD_PAYOUT=1)'))
		return
	}
	// Fail closed at start when the RPC env is missing or not http(s); never fall back to master.json.
	try {
		requireClaimRpcUrlEnv()
	} catch (e) {
		logger(Colors.red(`[validatorClRewardPayout] refusing to start: ${(e as Error).message}`))
		return
	}
	// Fail closed when the state file is missing (unless ALLOW_FRESH_STATE=1) or unreadable/corrupt.
	// Throws so the resident entry exits non-zero; the state file is never written on this path.
	try {
		loadState()
	} catch (e) {
		logger(Colors.red(`[validatorClRewardPayout] refusing to start: ${(e as Error).message} (state untouched)`))
		throw e
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
	for (const kind of WORKER_KINDS) {
		void runWorkerStep(kind).finally(() => scheduleWorker(kind))
	}
}

export function stopValidatorClRewardPayoutReporter(): void {
	payoutStarted = false
	for (const kind of WORKER_KINDS) {
		const t = workerTimers[kind]
		if (t !== undefined) clearTimeout(t)
		delete workerTimers[kind]
	}
}

/** Test/ops helper: load migrated dual-cursor state without starting the daemon. */
export function peekValidatorClRewardPayoutState(): DualCursorState {
	return loadState()
}

/** 1712Z Anvil/eng: abort flush after N successful on-chain settles (simulate power-cut). */
let engAbortAfterSuccessfulSettles: number | null = null
let engSuccessfulSettles = 0

export function __engHarnessSetAbortAfterSuccessfulSettles(n: number | null): void {
	engAbortAfterSuccessfulSettles = n === null ? null : Math.max(0, Math.floor(n))
	engSuccessfulSettles = 0
}

export type EngHarnessPendingSeed = {
	guardianId: string
	amount: string
	eventKey: string
	blockNumber: number
	withdrawalIndex: number
	scanLine?: ScanLine
}

/**
 * 1712Z Anvil harness: seed pending (or resume from state file) and run one flushPendingBatches.
 * Does not start the background tick loop. productionMutate=false (local only).
 */
export async function __engHarnessFlushPendingOnce(opts: {
	contractAddr: string
	seeds?: EngHarnessPendingSeed[]
	/** When true, do not replace pending — resume from durable state file (mid-restart). */
	resumeFromState?: boolean
	/** Reset firstBatchSettledWei to 0 when seeding (default true for fresh seed). */
	resetFirstBatchSettled?: boolean
	/**
	 * Seed firstBatchSettledWei to a prior paid cumulative (wei string).
	 * Takes precedence over resetFirstBatchSettled when seeding.
	 * Resume path ignores this and keeps durable state.
	 */
	initialFirstBatchSettledWei?: string
}): Promise<{
	pendingKeys: string[]
	pendingCount: number
	aborted: boolean
	firstBatchSettledWei: string
}> {
	let aborted = false
	if (opts.resumeFromState) {
		await refreshStateFromDisk()
	} else {
		// Seeds replace the ledger's pending rows and intents (harness only); rows are kept in ledger order.
		const seeded = new Map<string, PayoutEntry>()
		for (const s of opts.seeds ?? []) {
			const e = entryFromJson({
				guardianId: s.guardianId,
				amount: s.amount,
				eventKey: s.eventKey,
				blockNumber: s.blockNumber,
				withdrawalIndex: s.withdrawalIndex,
				scanLine: s.scanLine ?? 'historical',
				enqueuedAtMs: Date.now(),
			})
			if (!e) continue
			seeded.set(e.eventKey, e)
		}
		const rows = [...seeded.values()]
			.sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
			.map(entryToJson)
		const initialSettled = opts.initialFirstBatchSettledWei?.trim() ?? ''
		const settledPatch =
			initialSettled.length > 0
				? { firstBatchSettledWei: initialSettled }
				: opts.resetFirstBatchSettled !== false
					? { firstBatchSettledWei: '0' }
					: {}
		await refreshStateFromDisk()
		await mutateState((s) => ({
			...s,
			pending: rows,
			settleIntents: [],
			...settledPatch,
			updatedAt: new Date().toISOString(),
		}))
	}
	const provider = createClaimRpcProvider()
	if (opts.resumeFromState) {
		// Mid-restart / ACK-loss path: rebuild original idempotencyKey batches before flush.
		await recoverOpenIntents(provider)
	}
	const readContract = makeReadContract(opts.contractAddr, provider)
	try {
		await flushPendingBatches(provider, readContract, opts.contractAddr)
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		if (!msg.includes('ENG_ABORT_AFTER_SUCCESSFUL_SETTLES')) throw e
		aborted = true
		logger(Colors.yellow(`[validatorClRewardPayout] eng harness power-cut: ${msg}`))
	}
	// Always re-read after flush/recover so firstBatchSettledWei reflects confirm credits.
	const after = peekValidatorClRewardPayoutState()
	const keys = after.pending.map((p) => String(p.eventKey || '').toLowerCase()).filter(Boolean)
	return {
		pendingKeys: keys,
		pendingCount: keys.length,
		aborted,
		firstBatchSettledWei: String(after.firstBatchSettledWei ?? '0'),
	}
}

/** Test/ops harness: run one full tick (scan + flush) without the background timer. */
export async function __engHarnessRunTickOnce(): Promise<void> {
	await payoutTick()
}

/** Test harness: simulate a process restart by dropping the committed-state cache; the next read reloads the ledger file. */
export function __engHarnessResetStateCache(): void {
	stateCache = null
}
