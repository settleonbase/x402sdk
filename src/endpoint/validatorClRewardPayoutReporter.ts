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

function persistState(state: DualCursorState): void {
	workingState = state
	atomicWriteState(resolveStateFile(), state)
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
		let flag: boolean
		try {
			flag = Boolean(await readContract.consumedRewardEventKey!(e.eventKey))
		} catch {
			unknown.push(e)
			continue
		}
		if (flag) consumed.push(e)
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
async function allIntentEventKeysConsumedOnChain(
	provider: ethers.JsonRpcProvider,
	to: string,
	eventKeys: string[]
): Promise<boolean> {
	if (!eventKeys.length) return false
	const c = new ethers.Contract(to, PAYOUT_ABI, provider)
	for (const k of eventKeys) {
		try {
			if (!Boolean(await c.consumedRewardEventKey!(k))) return false
		} catch {
			return false
		}
	}
	return true
}

/** Credit firstBatchSettledWei once + clear pending keys for a settled intent. */
function creditConfirmedIntentAndClearPending(
	state: DualCursorState,
	pending: Map<string, PayoutEntry>,
	intent: SettleIntent
): DualCursorState {
	let next = markIntentConfirmed(state, intent.idempotencyKey, 1)
	for (const k of intent.eventKeys) pending.delete(k.toLowerCase())
	next = removePendingKeys(next, intent.eventKeys)
	return syncPendingOntoState(next, pending)
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
		// Chain local `state` after each mutation — never re-take stale workingState snapshot.
		state = markIntentBroadcast(state, intent.idempotencyKey, hash)
		persistState(state)
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] settleNodeRewards sent via signer tx=${hash} waiting≤${resolveClaimTxWaitTimeoutMs()}ms n=${entries.length} eventKeys=${eventKeys.join(',')} gasPrice=${ethers.formatUnits(gasPriceWei, 'gwei')}gwei idem=${intent.idempotencyKey.slice(0, 24)}…`
			)
		)
		const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
		state = markIntentConfirmed(state, intent.idempotencyKey, receipt.status ?? 0)
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
				state,
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
		state = markIntentFailed(state, intent.idempotencyKey, `signer_failed:${msg.slice(0, 120)}`)
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
	let state = workingState ?? loadState()
	const open = state.settleIntents.filter((i) => i.status === 'broadcast' || i.status === 'uncertain' || i.status === 'prepared')
	if (!open.length) return

	const config = readVdrSignerConfig()
	for (const intent of open) {
		if (!intentCoversPending(intent, pending) && intent.status === 'prepared') {
			// Pending keys gone — credit if chain already consumed; else drop stale intent.
			if (await allIntentEventKeysConsumedOnChain(provider, intent.to, intent.eventKeys)) {
				state = creditConfirmedIntentAndClearPending(state, pending, intent)
				persistState(state)
				logger(
					Colors.green(
						`[validatorClRewardPayout] prepared intent credited via on-chain consumed (pending cleared) idem=${intent.idempotencyKey.slice(0, 24)}…`
					)
				)
				continue
			}
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
					// Same local `state` → credit + clear pending (never re-take workingState).
					if (receipt.status === 1) {
						state = creditConfirmedIntentAndClearPending(state, pending, intent)
					} else {
						state = markIntentConfirmed(state, intent.idempotencyKey, receipt.status ?? 0)
						state = syncPendingOntoState(state, pending)
					}
					persistState(state)
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

		// Chain already settled this intent (ACK lost / SIGKILL before broadcast mark) — credit once, do not resend.
		if (await allIntentEventKeysConsumedOnChain(provider, intent.to, intent.eventKeys)) {
			state = creditConfirmedIntentAndClearPending(state, pending, intent)
			persistState(state)
			logger(
				Colors.green(
					`[validatorClRewardPayout] ACK-lost intent credited via on-chain consumed; skip resend idem=${intent.idempotencyKey.slice(0, 24)}…`
				)
			)
			continue
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
			// Chain local `state` — never re-take workingState after confirm.
			if (receipt.status === 1) {
				state = creditConfirmedIntentAndClearPending(state, pending, intent)
			} else {
				state = markIntentConfirmed(state, intent.idempotencyKey, receipt.status ?? 0)
				state = syncPendingOntoState(state, pending)
			}
			persistState(state)
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
	let state = workingState ?? loadState()
	if (!pending.size) {
		if (clearGasWait(state)) state = syncPendingOntoState(state, pending)
		return
	}

	const maxGas = resolveMaxGasPriceWei()
	const gasDustWei = 50_000_000n
	const gasPrice = await readGasPriceWei(provider)
	const forceMs = resolveGasWaitForceMs()
	let forceFlush = false

	if (gasPrice > maxGas + gasDustWei) {
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
		state = syncPendingOntoState(state, pending)
	}

	// Sync map → state so planFlushOrder sees scanLine tags.
	state = syncPendingOntoState(state, pending)

	if (!pending.size) {
		if (clearGasWait(state)) state = syncPendingOntoState(state, pending)
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
			const outOfList = [...pending.keys()].filter((k) => !issueAllowSet!.has(k.toLowerCase()))
			if (outOfList.length) {
				logger(
					Colors.yellow(
						`[validatorClRewardPayout] allowlist skip issue outOfList=${outOfList.length} (retain pending); packHash=${allowGate.packHash.slice(0, 16)}…`
					)
				)
			}
		}
	}

	state = syncPendingOntoState(state, pending)
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
				`gasPrice=${ethers.formatUnits(gasPrice, 'gwei')}gwei${forceFlush ? ' force=1' : ''}`
		)
	)

	for (const batchJson of flushPlan.batches) {
		const batch: PayoutEntry[] = []
		for (const j of batchJson) {
			const e = entryFromJson(j)
			if (!e || !pending.has(e.eventKey)) continue
			if (issueAllowSet && !issueAllowSet.has(e.eventKey.toLowerCase())) continue
			batch.push(e)
		}
		if (!batch.length) continue
		// Further split by gas/calldata heuristics; over_cap may auto-bisect; estimate_failed does not.
		for (const sub of splitEntriesForOnchain(batch)) {
			const chk = await checkBatchUnconsumed(readContract, sub)
			if (chk.consumed.length) {
				const ck = chk.consumed.map((e) => e.eventKey)
				for (const k of ck) pending.delete(k)
				state = removePendingKeys(state, ck)
				state = syncPendingOntoState(state, pending)
				workingState = state
				persistState(state)
				logger(Colors.cyan(`[validatorClRewardPayout] batch pre-check: ${ck.length} already consumed; removed from pending`))
			}
			if (chk.unknown.length) {
				logger(Colors.yellow(`[validatorClRewardPayout] batch pre-check: ${chk.unknown.length} unknown (RPC error); not signed this tick`))
			}
			if (chk.payable.length) {
				await submitPayoutBatchAutoSplit(contractAddr, chk.payable, gasPrice, pending)
			}
		}
	}

	// Submits persist via workingState — re-take after batches so settledWei is not lost.
	state = workingState ?? loadState()
	if (!pending.size && clearGasWait(state)) {
		state = syncPendingOntoState(state, pending)
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

		await recoverOpenIntents(provider, pending)
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
				state = commitScanProgress(state, {
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
				state = commitScanProgress(state, {
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

		await flushPendingBatches(provider, readContract, proxyAddr, pending)
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
	let pending: Map<string, PayoutEntry>
	let aborted = false
	if (opts.resumeFromState) {
		const state = loadState()
		pending = pendingMapFromState(state)
	} else {
		pending = new Map<string, PayoutEntry>()
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
			pending.set(e.eventKey, e)
		}
		const initialSettled = opts.initialFirstBatchSettledWei?.trim() ?? ''
		const settledPatch =
			initialSettled.length > 0
				? { firstBatchSettledWei: initialSettled }
				: opts.resetFirstBatchSettled !== false
					? { firstBatchSettledWei: '0' }
					: {}
		let state = loadState()
		state = {
			...state,
			pending: [],
			settleIntents: [],
			...settledPatch,
			updatedAt: new Date().toISOString(),
		}
		state = syncPendingOntoState(state, pending)
	}
	const provider = createClaimRpcProvider()
	if (opts.resumeFromState) {
		// Mid-restart / ACK-loss path: rebuild original idempotencyKey batches before flush.
		await recoverOpenIntents(provider, pending)
	}
	const readContract = new ethers.Contract(opts.contractAddr, PAYOUT_ABI, provider)
	try {
		await flushPendingBatches(provider, readContract, opts.contractAddr, pending)
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		if (!msg.includes('ENG_ABORT_AFTER_SUCCESSFUL_SETTLES')) throw e
		aborted = true
		logger(Colors.yellow(`[validatorClRewardPayout] eng harness power-cut: ${msg}`))
		// Keep SAME local state: assign sync result (never discard workingState ?? loadState()).
		workingState = syncPendingOntoState(workingState ?? loadState(), pending)
		persistState(workingState)
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
