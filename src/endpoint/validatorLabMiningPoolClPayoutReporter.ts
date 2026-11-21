/**
 * CL consensus-layer skim → ConetLabMiningPool for manual Lab staking validators (no guardian ledger).
 *
 * Scans EL block withdrawals credited to ValidatorDepositRedeem, maps validatorIndex → pubkey,
 * pays only when:
 *   - pubkey is in Lab manifest (deployments/conet-lab-mining-pool-pubkeys.json)
 *   - beacon status is active_ongoing only (active_exiting / withdrawn → no skim)
 *   - single withdrawal amount below exit floor (default 1 CNET; CL skim ≪ 1 CNET, exit principal ~32 CNET)
 *   - no active redeem beneficiary (guardianId==0 OR guardianIdBeneficiary==0 after adminRelease)
 *     OR pubkey not in manifest with active beneficiary (redeem stack on 85.33 handles those)
 *   - on-chain consumedRewardEventKey is false (a prior settleNodeRewards already took this key)
 *   - the key is not already in the local consumedEventKeys map
 *
 * Payout (same call as the running legacy daemon, signer instead of a hot key):
 *   Redeem.withdrawNative(miningPool, batchTotal) via dedicated unix socket.
 *   Env: CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET + KEY_ARRAY.
 *   Not LabMiningPoolPayoutExecutor.payoutBatch — that call is not on the running daemon.
 *   FORBIDDEN: import the legacy hot key; <claim-key-array>; /run/wallet-signer-vdr/<claim-payout-socket>.
 *
 * Idempotency:
 *   local consumedEventKeys after a confirmed withdrawNative receipt; signer idempotencyKey
 *   plus request fingerprint (ACK-lost recovery via signer_getTransaction).
 *   withdrawNative does not set consumedRewardEventKey. A consumed map at the 200000 cap
 *   holds history lines pending (CONET_LAB_MINING_POOL_CL_PAYOUT_RELEASE_HISTORY is not set).
 *   CONET_LAB_MINING_POOL_CL_PAYOUT_REVIEW_HOLD_BEFORE_BLOCK, when set, holds that block and earlier.
 *
 * Dual-cursor H:
 *   freeze H at start; history = continuousCoverage+1→H; realtime = H+1→tip (fill tip jumps).
 *   Same source eventKey namespace; A2 realtime reserved quota; history keeps advancing.
 *
 * Pending pool + gas gate (aligned with validatorClRewardPayoutReporter):
 *   - Scanned skim entries merge into a persisted pending pool; scan checkpoint advances without settle.
 *   - Flush when eth_gasPrice ≤ max (default 2 gwei); failed batches stay in pending.
 *   - If gas stays above max longer than force-wait (default 3 min), flush at live gasPrice anyway.
 *
 * State format v2 (labClPayoutStateStore.ts): segmented directory "<stateFile without .json>.v2".
 *   - Reads fail closed. A verification error throws. An existing file never becomes an empty state.
 *   - The legacy single file (<stateFile>) is refused for writes. Migrate it first with
 *     labClPayoutStateMigrate.ts (dry-run, then --apply) while this daemon is stopped.
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import {
	CONET_LAB_MINING_POOL_DEPLOY_BLOCK,
	CONET_RPC_URL,
	CONET_VALIDATOR_DEPOSIT_REDEEM,
} from '../chainAddresses'
import { enqueueOnchainTxWork } from '../onchainTxSerialQueue'
import {
	classifyPendingLine,
	ensureFreezeH,
	formatHistoryProgress,
	formatRealtimeLatency,
	nextHistoryWindow,
	nextRealtimeWindow,
	scheduleFlushBatches,
	assertNoSkippedHistory,
	resolveConsumedKeysCap,
	shouldStopAfterSettled,
	historyHeldFor,
	seedCursorsFromLegacy,
	type LabFreezeH,
	type LabScanLine,
} from './labMiningPoolDualCursor'
import {
	resolveFixedLabMiningPool,
	verifyLabSignerBoundAddress,
	sendConfiguredLabWithdrawNative,
} from './labMiningPoolPayoutSigner'
import { beaconHttpIsUnconfirmed, PaidKeyViewUnconfirmed } from './clPaidKeyGate'
import {
	newLabScanCounters,
	newLabFlushCounters,
	formatScanSummary,
	formatFlushSummary,
	type LabScanCounters,
} from './labScanSummary'
import { resolvePendingHighWater, decideLinePauses } from './labBackpressure'
import {
	resolveHistoryPayBehindCursor,
	historyMaxBlockFor,
	countHistoryAhead,
	planInvariantCFlush,
	settleKeysAndAdvance,
	frontLead,
	ScanBottleneckTracker,
} from './labInvariantC'
import { partitionByGuardianBeneficiary } from './labFlushGuardian'
import { mapWithConcurrency, resolveReadConcurrency, settle } from './labParallel'
import { selectFlushCandidates } from './labFlushSelect'
import { segmentedDirForLegacy } from './labClPayoutStateStore'
import {
	assertPinnedRedeem,
	gasLimitFromEnv,
	gasWaitForceFromEnv,
	maxGasWeiFromEnv,
	startupConfigLine,
} from './labStartupConfig'
import { acquireStateDirLock, type StateDirLock } from './labClPayoutStateLock'
import { assertNoWalEvents } from './labWalGuard'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import type { LabStateHandle } from './labStateHandle'
import { createLegacyStateStore, type LabClPayoutState, type SkimEntry, type LabPendingEntryJson } from './labLegacyState'
import {
	resumeLabWithdrawInFlight,
	sameEventKeys,
	submitWithdrawBatchDurably,
	type LabInFlightWithdraw,
	type LabLifecycleDeps,
} from './labClPayoutBatchLifecycle'

/** The reporter reads and changes its state only through this handle (labStateHandle.ts). */
type LabHandle = LabStateHandle<SkimEntry, LabClPayoutState>

/** Fixed lane for Lab executor payouts (signer EOA is opaque behind socket). */
const LAB_MINING_POOL_ONCHAIN_LANE = 'lab-mining-pool-executor-payout'

function resolveLabRpcUrl(): string {
	return (
		process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
		process.env.CONET_RPC_URL?.trim() ||
		CONET_RPC_URL
	)
}

/** Per-HTTP RPC timeout (ethers FetchRequest). Env existed in systemd but was previously unused. */
function resolveRpcHttpTimeoutMs(): number {
	const n = Number(process.env.CONET_RPC_HTTP_TIMEOUT_MS || 30_000)
	return Number.isFinite(n) && n >= 5_000 ? Math.min(300_000, Math.floor(n)) : 30_000
}

/** Max wait for a single withdrawNative receipt after signer broadcast. */
function resolveTxWaitTimeoutMs(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS || 120_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.min(600_000, Math.floor(n)) : 120_000
}

function createLabRpcProvider(): ethers.JsonRpcProvider {
	const url = resolveLabRpcUrl()
	const req = new ethers.FetchRequest(url)
	req.timeout = resolveRpcHttpTimeoutMs()
	// Avoid HTTP batching quirks on local geth; one method per request.
	return new ethers.JsonRpcProvider(req, undefined, { staticNetwork: true, batchMaxCount: 1 })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			}
		)
	})
}

/**
 * Wait for a signer-broadcast hash with a hard deadline.
 * On timeout leave entries in pending (caller must not mark consumed).
 * NOTE: withdrawNative does not set consumedRewardEventKey.
 * Lab consumption is the local consumedEventKeys map plus a confirmed signer receipt.
 */
async function waitForSignerReceiptByHash(
	provider: ethers.JsonRpcProvider,
	hash: string,
	timeoutMs: number
): Promise<ethers.TransactionReceipt> {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		try {
			const receipt = await provider.getTransactionReceipt(hash)
			if (receipt) return receipt
		} catch {
			/* retry */
		}
		await new Promise((resolve) => setTimeout(resolve, 1_500))
	}
	throw new Error(`signer tx receipt timed out hash=${hash}`)
}

/** The Lab redeem is pinned (round-4 F5). The env override is checked at startup, not used. */
function resolveLabRedeemAddress(): string {
	return CONET_VALIDATOR_DEPOSIT_REDEEM
}

/** Per-withdrawal skim ceiling: CL rewards are ≪ 1 CNET; anything ≥ floor is principal/exit, not skim. */
const DEFAULT_SKIM_MAX_WITHDRAWAL_WEI = 10n ** 18n

const LAB_SKIM_ELIGIBLE_STATUS = 'active_ongoing' as const

const READ_ABI = [
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
] as const

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

type LabManifest = {
	pubkeys?: string[]
	miningPool?: string
}

let labStarted = false
let labTimer: ReturnType<typeof setTimeout> | undefined
let labInFlight = false
let labPubkeySet = new Set<string>()
let labMiningPool = ''
let labManifestMtime = 0
let labPhaseLogged = false
let labSessionState: LabClPayoutState | undefined
/** Back-pressure state of the two scan lines (labBackpressure.ts). */
let labHistoryPaused = false
let labRealtimePaused = false
/** History cursor as last persisted (invariant C uses this, never an uncommitted in-memory value). undefined until the first persist of this process. */
let labCommittedHistoryCursor: number | null | undefined
/** The maxPaidHistoryBlock merge ran for this process (review M1: once per start, covers an off -> on switch). */
let labInvariantCInitDone = false
/** "Scan is the bottleneck" streak for invariant C (informational alert, not the back-pressure pause). */
const labScanBottleneck = new ScanBottleneckTracker()
/** Entries marked consumed by settled batches since the process started (flush-summary settledEntries is a delta of this). */
let labSettledEntriesTotal = 0
/** Single-writer lock on the v2 state dir, held from start until process exit. */
let labStateLock: StateDirLock | undefined
/** Set on the first state write failure. Blocks every later payment in this process (B-3). */
const labGate = new LabPayoutFailClosedGate((m) => logger(Colors.red(`[labMiningPoolClPayout] ${m}`)))
const legacyStore = createLegacyStateStore({
	stateFile: () => resolveStateFile(),
	segmentedDir: () => resolveSegmentedStateDir(),
	consumedCap: () => resolveConsumedKeysPersistMax(),
	scanFloor: () => resolveLabScanFloorBlock(),
	tripPersist: (e) => labGate.trip('persist', e),
	logger: (...a) => logger(...(a as [unknown])),
})
export const pruneConsumedEventKeys = legacyStore.pruneConsumedEventKeys

/** Frozen at process start: max(lastListeningEndBlock+1, pool deploy block). */
let sessionBackfillFloor: number | undefined

function resolveManifestPath(): string {
	return (
		process.env.CONET_LAB_MINING_POOL_PUBKEYS_FILE?.trim() ||
		path.join(process.cwd(), 'deployments/conet-lab-mining-pool-pubkeys.json')
	)
}

/**
 * Legacy single-file path. Kept only as the migration source: with format v2 in place,
 * the daemon reads and writes the segmented directory instead (see labClPayoutStateStore).
 */
function resolveStateFile(): string {
	return (
		process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-lab-mining-pool-cl-payout-state.json')
	)
}

/** v2 segmented state directory, derived from the legacy path ("x.json" -> "x.v2"). */
function resolveSegmentedStateDir(): string {
	return segmentedDirForLegacy(resolveStateFile())
}

function resolveBeaconRestUrl(): string {
	return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '')
}

function resolveTickMs(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS || 60_000)
	return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000
}

function resolveChunkBlocks(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNK_BLOCKS || 32)
	return Number.isFinite(n) && n >= 1 ? Math.min(512, Math.floor(n)) : 32
}

function resolveChunksPerTick(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK || 1)
	return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 1
}

/**
 * Only submit when eth_gasPrice ≤ this many gwei (default 2).
 * CONET often sits at exactly 2.0 gwei — use ≤ not <.
 */
function resolveMaxGasPriceWei(): bigint {
	return maxGasWeiFromEnv(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_WEI, process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI).value
}

/** After this many ms waiting on high gas, force flush at live gasPrice (default 3 min). */
function resolveGasWaitForceMs(): number {
	return gasWaitForceFromEnv(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS).value
}

/** Same default and ceiling as the running legacy resolveWithdrawGasLimit. */
function resolvePayoutGasLimit(): number {
	return gasLimitFromEnv(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT).value
}

/** A2: reserved realtime batches per flush tick (history still advances after). */
function resolveRealtimeReservedBatches(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_REALTIME_RESERVED || 1)
	return Number.isFinite(n) && n >= 0 ? Math.min(16, Math.floor(n)) : 1
}

function ensureDualCursors(h: LabHandle, tipHeight: number, tipHash: string): LabFreezeH {
	const freeze = ensureFreezeH(h.scalar('freezeH') ?? null, tipHeight, tipHash)
	h.setScalar('freezeH', freeze)
	if (h.scalar('historyCursor') == null || h.scalar('realtimeCursor') == null) {
		const seeded = seedCursorsFromLegacy({
			freezeH: freeze,
			lastListeningEndBlock: h.scalar('lastListeningEndBlock'),
			lastBackfillProcessedBlock: h.scalar('lastBackfillProcessedBlock'),
			scanFloor: resolveLabScanFloorBlock(),
		})
		if (h.scalar('historyCursor') == null) h.setScalar('historyCursor', seeded.historyCursor)
		if (h.scalar('realtimeCursor') == null) h.setScalar('realtimeCursor', seeded.realtimeCursor)
	}
	return freeze
}

/** Cap of oldest pending entries inspected per tick (sequential on-chain consumed checks). */
function resolveFlushMaxEntries(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_MAX_ENTRIES || 200)
	return Number.isFinite(n) && n >= 1 ? Math.min(50_000, Math.floor(n)) : 200
}

function resolveFlushBatchEntries(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES || 100)
	return Number.isFinite(n) && n >= 1 ? Math.min(20_000, Math.floor(n)) : 100 // lower bound 1 (one key per batch)
}

/** Optional one-shot limit: after this many settled batches the daemon persists and exits 0 (not restarted by Restart=on-failure). Unset = no limit. */
function resolveMaxSettledBatches(): number | null {
	const raw = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_SETTLED_BATCHES?.trim()
	if (!raw) return null
	const n = Number(raw)
	return Number.isInteger(n) && n >= 1 ? n : null
}

/** The settled count is persisted in the same write as the consumed set (lifecycle countSettled). Exit only after that write. */
function noteSettledBatch(h: LabHandle): void {
	const max = resolveMaxSettledBatches()
	if (shouldStopAfterSettled(h.scalar('settledBatchCount') ?? 0, max)) {
		logger(Colors.cyan(`[labMiningPoolClPayout] MAX_SETTLED_BATCHES=${max} reached (persisted); exiting 0`))
		stopValidatorLabMiningPoolClPayoutReporter()
		process.exit(0)
	}
}

function haltDaemon(h: LabHandle, code: number, reason: string): void {
	logger(Colors.red(`[labMiningPoolClPayout] HALT (exit ${code}): ${reason}`))
	try {
		h.haltFlush()
	} catch {
		/* the state was already persisted by the lifecycle write; exit regardless */
	}
	stopValidatorLabMiningPoolClPayoutReporter()
	process.exit(code)
}

function resolveFlushMaxBatches(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_MAX_BATCHES || 2)
	return Number.isFinite(n) && n >= 1 ? Math.min(32, Math.floor(n)) : 2
}

/**
 * Soft cap for persisted consumedEventKeys. withdrawNative does not set
 * consumedRewardEventKey. Keys still in the map were locally consumed.
 * Keys dropped by the cap are unknown and stay itemized in pending.
 * The cap bounds the consumed set size. The v2 writer streams, so this is no longer a V8 string-length workaround.
 */
function resolveConsumedKeysPersistMax(): number {
	return resolveConsumedKeysCap(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX)
}

/** Inclusive block watermark. Unset means no extra block hold. Not a stake-count gate. */
function resolveReviewHoldBeforeBlock(): number | null {
	const raw = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_REVIEW_HOLD_BEFORE_BLOCK?.trim()
	if (!raw) return null
	const n = Number(raw)
	if (!Number.isFinite(n) || n < 0) return null
	return Math.floor(n)
}

/**
 * A full consumed map may have dropped older keys. Those history lines stay
 * pending unless an explicit release is set. Realtime lines are not held here.
 */
function historyReviewHeld(h: LabHandle): boolean {
	// The cap no longer holds history: oldest consumed keys are pruned instead (see labConsumedPrune.planPrune: soft cap, prune to 90%, cold archive).
	return historyHeldFor(
		h.consumedSize,
		resolveConsumedKeysPersistMax(),
		process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_RELEASE_HISTORY === '1'
	)
}

function clearGasWait(h: LabHandle): boolean {
	if (!h.scalar('gasWaitStartedAt')) return false
	h.delScalar('gasWaitStartedAt')
	return true
}

function formatWaitCountdown(elapsedMs: number, forceMs: number): string {
	const leftMs = Math.max(0, forceMs - elapsedMs)
	const elapsedSec = Math.floor(elapsedMs / 1000)
	const leftSec = Math.ceil(leftMs / 1000)
	const forceSec = Math.floor(forceMs / 1000)
	return `${elapsedSec}s/${forceSec}s (force in ${leftSec}s)`
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

function resolveFullExitFloorWei(): bigint {
	const raw = process.env.CONET_LAB_MINING_POOL_CL_FULL_EXIT_FLOOR_WEI?.trim()
	if (raw) {
		try {
			return BigInt(raw)
		} catch {
			/* fall through */
		}
	}
	return DEFAULT_SKIM_MAX_WITHDRAWAL_WEI
}

/** True when EL withdrawal is too large to be CL skim (treat as exit/principal inflow). */
function isNonSkimWithdrawal(amountWei: bigint, floorWei: bigint): boolean {
	return amountWei >= floorWei
}

function resolveLabScanFloorBlock(): number {
	const env =
		process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK?.trim() ||
		process.env.CONET_LAB_MINING_POOL_DEPLOY_BLOCK?.trim()
	if (env) {
		const n = Number(env)
		if (Number.isFinite(n) && n >= 0) return Math.floor(n)
	}
	return CONET_LAB_MINING_POOL_DEPLOY_BLOCK
}

function resolveBackfillUpperBound(liveHead: number): number {
	return Math.max(0, liveHead - 1)
}

function normalizeScanBlock(raw: unknown): number | undefined {
	if (raw == null) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/** Inclusive first block for backfill on this process start. */
function resolveSessionBackfillFloor(lastListeningEndBlock: unknown): number {
	const lastListen = normalizeScanBlock(lastListeningEndBlock)
	if (lastListen != null) return lastListen + 1
	return resolveLabScanFloorBlock()
}

/** Last paid reward source block (candidate basis). The history line starts at this value + 1 on migration. */
function alignBackfillCursorForSession(state: LabClPayoutState, floor: number): void {
	if (state.lastBackfillProcessedBlock < floor - 1) {
		state.lastBackfillProcessedBlock = floor - 1
	}
}

function tryPersistListeningCheckpoint(h: LabHandle, liveHead: number): void {
	const upper = resolveBackfillUpperBound(liveHead)
	if (h.scalar('lastBackfillProcessedBlock') < upper) return
	if (h.scalar('lastLiveHeadScanned') !== liveHead) return
	const prev = h.scalar('lastListeningEndBlock')
	h.setScalar('lastListeningEndBlock', liveHead)
	if (prev !== liveHead) {
		logger(
			Colors.green(
				`[labMiningPoolClPayout] listening checkpoint lastListeningEndBlock=${liveHead} (backfill≥${upper})`
			)
		)
	}
}

function labEnabled(): boolean {
	return ['1', 'true', 'yes'].includes(String(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT || '').toLowerCase())
}

function labDryRun(): boolean {
	const v = (process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase()
	return v === '1' || v === 'true' || v === 'yes'
}

/** Process boot: parallel listen+backfill; resume backfill cursor; freeze session floor from lastListeningEndBlock. */
function initLabSessionState(): LabClPayoutState {
	const state = legacyStore.readStateFromDisk()
	sessionBackfillFloor = resolveSessionBackfillFloor(state.lastListeningEndBlock)
	// R1: a scan floor above the history seed would silently skip blocks between them. Refuse to start instead.
	assertNoSkippedHistory(resolveLabScanFloorBlock(), state.lastBackfillProcessedBlock)
	alignBackfillCursorForSession(state, sessionBackfillFloor)
	legacyStore.writeState(state)
	return state
}

function getLabSessionState(): LabClPayoutState {
	if (!labSessionState) labSessionState = initLabSessionState()
	return labSessionState
}

function loadManifestIfNeeded(force = false): boolean {
	const file = resolveManifestPath()
	if (!fs.existsSync(file)) {
		logger(Colors.yellow(`[labMiningPoolClPayout] manifest missing: ${file} (run aggregateLabMiningPoolPubkeys.mjs)`))
		return false
	}
	const st = fs.statSync(file)
	if (!force && st.mtimeMs === labManifestMtime && labPubkeySet.size > 0) return true
	const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LabManifest
	const pubkeys = Array.isArray(raw.pubkeys) ? raw.pubkeys : []
	if (!pubkeys.length) {
		logger(Colors.yellow(`[labMiningPoolClPayout] manifest has no pubkeys: ${file}`))
		return false
	}
	labPubkeySet = new Set(pubkeys.map((p) => ethers.hexlify(ethers.getBytes(p.startsWith('0x') ? p : `0x${p}`)).toLowerCase()))
	// B-4: the payee is fixed. Manifest or env may only restate it; any other value throws.
	labMiningPool = resolveFixedLabMiningPool({
		manifestPool: raw.miningPool,
		envPool: process.env.CONET_LAB_MINING_POOL_ADDRESS,
	})
	labManifestMtime = st.mtimeMs
	logger(
		Colors.cyan(
			`[labMiningPoolClPayout] loaded manifest pubkeys=${labPubkeySet.size} pool=${labMiningPool.slice(0, 10)}…`
		)
	)
	return true
}

const validatorPubkeyCache = new Map<number, string | null>()
const validatorStatusCache = new Map<number, string | null>()

async function fetchValidatorByIndex(validatorIndex: number): Promise<{ pubkey: string | null; status: string | null }> {
	if (validatorPubkeyCache.has(validatorIndex)) {
		return {
			pubkey: validatorPubkeyCache.get(validatorIndex) ?? null,
			status: validatorStatusCache.get(validatorIndex) ?? null,
		}
	}
	const base = resolveBeaconRestUrl()
	const url = `${base}/eth/v1/beacon/states/head/validators/${validatorIndex}`
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(25_000) })
		if (!res.ok || beaconHttpIsUnconfirmed(res.status)) {
			throw new Error(`validator index ${validatorIndex} beacon HTTP ${res.status}`)
		}
		const json = (await res.json()) as {
			data?: { validator?: { pubkey?: string }; status?: string }
		}
		const pkRaw = json?.data?.validator?.pubkey?.trim()
		const status = json?.data?.status?.trim()?.toLowerCase() || null
		let pubkey: string | null = null
		if (pkRaw) {
			pubkey = ethers.hexlify(ethers.getBytes(pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`)).toLowerCase()
		}
		validatorPubkeyCache.set(validatorIndex, pubkey)
		validatorStatusCache.set(validatorIndex, status)
		return { pubkey, status }
	} catch (err: unknown) {
		if (err instanceof Error && err.message.startsWith('validator index ')) throw err
		throw new Error(
			`validator index ${validatorIndex} beacon read failed: ${err instanceof Error ? err.message : String(err)}`
		)
	}
}

async function fetchBlockWithWithdrawals(
	provider: ethers.JsonRpcProvider,
	blockNumber: number
): Promise<RpcBlock | null> {
	try {
		const hex = ethers.toQuantity(blockNumber)
		return (await provider.send('eth_getBlockByNumber', [hex, false])) as RpcBlock | null
	} catch {
		return null
	}
}

function withdrawalEventKey(blockNumber: number, withdrawalIndex: number): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(blockNumber), BigInt(withdrawalIndex)])
	)
}

/**
 * Everything the per-withdrawal classification reads from outside. The defaults are the live reads; tests inject fakes.
 * Order of use (P1): the Lab pubkey filter comes first, so a withdrawal of any other validator never causes a chain read
 * and is never recorded in consumedEventKeys. Only a Lab pubkey is checked against the on-chain paid-key view, and that
 * check still happens before any entry can reach the pending pool.
 */
export type LabScanDeps = {
	/** consumedRewardEventKey(eventKey) on the VDR. Throws when the view cannot be read. */
	chainConsumed: (eventKey: string) => Promise<boolean>
	fetchValidator: (validatorIndex: number) => Promise<{ pubkey: string | null; status: string | null }>
	isLabPubkey: (pubkey: string) => boolean
	/** guardianIdBeneficiary of the pubkey's guardian; the zero address when the pubkey has no guardian. */
	guardianBeneficiary: (pubkeyHash: string) => Promise<string>
	exitFloorWei: () => bigint
}

function defaultLabScanDeps(readContract: ethers.Contract): LabScanDeps {
	return {
		chainConsumed: async (eventKey) => Boolean(await readContract.consumedRewardEventKey!(eventKey)),
		fetchValidator: fetchValidatorByIndex,
		isLabPubkey: (pubkey) => labPubkeySet.has(pubkey),
		guardianBeneficiary: async (pubkeyHash) => {
			const guardianId = BigInt(await readContract.getNodeByValidatorPubkeyHash!(pubkeyHash))
			if (guardianId <= 0n) return ethers.ZeroAddress
			return String(await readContract.guardianIdBeneficiary!(guardianId))
		},
		exitFloorWei: resolveFullExitFloorWei,
	}
}

export async function collectLabSkimEntriesForBlock(
	readContract: ethers.Contract,
	proxyLower: string,
	blockNumber: number,
	block: RpcBlock,
	h: LabHandle,
	counters: LabScanCounters = newLabScanCounters(),
	depsOverride?: Partial<LabScanDeps>,
	concurrency: number = resolveReadConcurrency()
): Promise<SkimEntry[]> {
	const deps: LabScanDeps = { ...defaultLabScanDeps(readContract), ...depsOverride }
	const floorWei = deps.exitFloorWei()

	// Phase A (no reads): classify what needs no read, in block order.
	type Candidate = { eventKey: string; amountWei: bigint; validatorIndex: number; withdrawalIndex: number }
	type Item = { kind: 'invalid' } | { kind: 'local' } | { kind: 'candidate'; c: Candidate }
	const items: Item[] = []
	for (const w of block.withdrawals ?? []) {
		const addr = String(w.address ?? '').toLowerCase()
		if (addr !== proxyLower) continue
		const amountGwei = BigInt(String(w.amount ?? '0'))
		if (amountGwei <= 0n) continue
		const amountWei = amountGwei * 1_000_000_000n
		const validatorIndex = Number(w.validatorIndex)
		const withdrawalIndex = Number(w.index)
		if (!Number.isFinite(validatorIndex) || validatorIndex < 0 || !Number.isFinite(withdrawalIndex) || withdrawalIndex < 0) {
			items.push({ kind: 'invalid' })
			continue
		}
		const eventKey = withdrawalEventKey(blockNumber, withdrawalIndex)
		if (h.consumedHas(eventKey) || h.pendingHas(eventKey.toLowerCase())) {
			items.push({ kind: 'local' })
			continue
		}
		items.push({ kind: 'candidate', c: { eventKey, amountWei, validatorIndex, withdrawalIndex } })
	}
	const cands = items.flatMap((it) => (it.kind === 'candidate' ? [it.c] : []))

	// Phase B (reads, bounded parallel, results kept per candidate; a failed read is decided at its own turn in phase C).
	const fetched = await mapWithConcurrency(cands, concurrency, (c) => settle(deps.fetchValidator(c.validatorIndex)))
	const isLab = (i: number): string | null => {
		const f = fetched[i]!
		return f.ok && f.value.pubkey && deps.isLabPubkey(f.value.pubkey) ? f.value.pubkey : null
	}
	const chain = await mapWithConcurrency(cands, concurrency, (c, i) => (isLab(i) ? settle(deps.chainConsumed(c.eventKey)) : Promise.resolve(null)))
	const needsGuardian = (i: number): string | null => {
		const pubkey = isLab(i)
		const ch = chain[i]
		const f = fetched[i]
		if (!pubkey || !ch || !ch.ok || ch.value || !f || !f.ok) return null
		if (isNonSkimWithdrawal(cands[i]!.amountWei, floorWei)) return null
		if (f.value.status !== LAB_SKIM_ELIGIBLE_STATUS) return null
		return pubkey
	}
	const guardian = await mapWithConcurrency(cands, concurrency, (_c, i) => {
		const pubkey = needsGuardian(i)
		return pubkey ? settle(deps.guardianBeneficiary(ethers.keccak256(pubkey))) : Promise.resolve(null)
	})
	const unconfirmed = (eventKey: string, error: unknown): PaidKeyViewUnconfirmed =>
		new PaidKeyViewUnconfirmed(eventKey, error instanceof Error ? error.message : String(error))

	// Phase C: decide in block order with the exact rules and side effects of the sequential code.
	const entries: SkimEntry[] = []
	let ci = 0
	for (const it of items) {
		counters.proxyWithdrawals++
		if (it.kind === 'invalid') {
			counters.invalid++
			continue
		}
		if (it.kind === 'local') {
			counters.localHit++
			continue
		}
		const i = ci++
		const c = it.c
		const f = fetched[i]!
		if (!f.ok) throw unconfirmed(c.eventKey, f.error)
		const { pubkey, status } = f.value
		if (!pubkey || !deps.isLabPubkey(pubkey)) {
			counters.nonLab++
			continue
		}
		const ch = chain[i]!
		if (!ch.ok) throw unconfirmed(c.eventKey, ch.error)
		if (ch.value) {
			h.consumedAdd(c.eventKey)
			counters.labChainConsumed++
			continue
		}
		if (isNonSkimWithdrawal(c.amountWei, floorWei)) {
			h.exitedAdd(pubkey)
			h.consumedAdd(c.eventKey)
			counters.nonSkim++
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] non-skim inflow (≥exit floor) block=${blockNumber} validator=${pubkey.slice(0, 14)}… amount=${ethers.formatEther(c.amountWei)} CNET status=${status ?? '?'}`
				)
			)
			continue
		}
		if (status !== LAB_SKIM_ELIGIBLE_STATUS) {
			h.exitedAdd(pubkey)
			counters.nonActive++
			logger(
				Colors.gray(
					`[labMiningPoolClPayout] skip non-active validator block=${blockNumber} status=${status ?? '?'} pubkey=${pubkey.slice(0, 14)}…`
				)
			)
			continue
		}
		const g = guardian[i]!
		if (!g.ok) throw unconfirmed(c.eventKey, g.error)
		// Active redeem guardian (beneficiary set) → validatorClRewardPayoutReporter on redeem listener host.
		if (g.value !== ethers.ZeroAddress) {
			counters.guardianBeneficiary++
			continue
		}
		entries.push({ eventKey: c.eventKey, amount: c.amountWei, blockNumber, withdrawalIndex: c.withdrawalIndex, pubkey })
	}
	return entries
}

/**
 * Wiring from the Lab lifecycle (labClPayoutBatchLifecycle) to this daemon. Signer and receipt calls
 * run inside the caller's lane job. They must not call enqueueOnchainTxWork again (nested lane deadlock).
 */

function makeLabLifecycleDeps(
	h: LabHandle,
	provider: ethers.JsonRpcProvider,
	gasPriceWei: bigint
): LabLifecycleDeps {
	return {
		gate: labGate,
		getInFlight: () => h.scalar('inFlightWithdraw') ?? null,
		setInFlight: (v) => {
			if (v) h.setScalar('inFlightWithdraw', v)
			else h.delScalar('inFlightWithdraw')
		},
		persist: (step) => h.commit(step),
		countSettled: () => {
			h.setScalar('settledBatchCount', (h.scalar('settledBatchCount') ?? 0) + 1)
		},
		stopBeforeSend: () => shouldStopAfterSettled(h.scalar('settledBatchCount') ?? 0, resolveMaxSettledBatches()),
		halt: (code, reason) => haltDaemon(h, code, reason),
		send: async (rec) => {
			// One send. No recovery and no retry here: the lifecycle holds an unknown outcome (B-2).
			const sent = await sendConfiguredLabWithdrawNative({
				redeem: rec.redeem,
				pool: rec.pool,
				amount: BigInt(rec.amountWei),
				eventKeys: rec.eventKeys,
				gasLimit: resolvePayoutGasLimit(),
				expectedIdempotencyKey: rec.idempotencyKey,
			})
			logger(
				Colors.cyan(
					`[labMiningPoolClPayout] withdrawNative sent via signer tx=${sent.hash} line=${rec.line} ` +
						`recovered=${sent.recoveredFromJournal ? 1 : 0} n=${rec.eventKeys.length} gasPrice=${ethers.formatUnits(gasPriceWei, 'gwei')}gwei`
				)
			)
			return { hash: sent.hash }
		},
		// Round-5 F1: read on every new composition, before the intent is persisted. Not cached per process.
		confirmBeforeSend: async () => {
			await verifyLabSignerBoundAddress(process.env)
		},
		waitReceipt: async (hash) => {
			try {
				const receipt = await waitForSignerReceiptByHash(provider, hash, resolveTxWaitTimeoutMs())
				return { status: receipt.status === 1 ? 1 : 0 }
			} catch {
				// Timeout: unresolved. The caller keeps the in-flight record and sends nothing new.
				return null
			}
		},
		settle: (keys) => {
			labSettledEntriesTotal += keys.length
			settleKeysAndAdvance(h, keys, resolveHistoryPayBehindCursor())
		},
		log: (line) => logger(Colors.cyan(`[labMiningPoolClPayout] ${line}`)),
	}
}

async function submitLabSkimBatch(
	provider: ethers.JsonRpcProvider,
	redeemAddr: string,
	entries: SkimEntry[],
	h: LabHandle,
	gasPriceWei: bigint,
	line: LabScanLine
): Promise<boolean> {
	if (!entries.length) return true
	const total = entries.reduce((a, e) => a + BigInt(e.amount), 0n)
	if (total <= 0n) return true
	// B-3: after a persist failure this process never sends another withdrawNative.
	labGate.assertOpen('withdrawNative')

	const balance = await provider.getBalance(redeemAddr)
	if (total > balance) {
		logger(
			Colors.red(
				`[labMiningPoolClPayout] refuse batch total=${ethers.formatEther(total)} > balance=${ethers.formatEther(balance)}`
			)
		)
		return false
	}

	const eventKeys = entries.map((e) => e.eventKey.toLowerCase())

	if (labDryRun()) {
		logger(
			Colors.yellow(
				`[labMiningPoolClPayout] DRY_RUN set; not broadcasting and not marking consumed n=${entries.length} line=${line} total=${ethers.formatEther(total)} payee=${labMiningPool} keys=${eventKeys.join(',')}`
			)
		)
		return false
	}

	h.openScope('batch') // one flush batch: only the lifecycle's steps may commit inside it (design T1)
	try {
		const outcome = await enqueueOnchainTxWork(
			LAB_MINING_POOL_ONCHAIN_LANE,
			`lab withdrawNative n=${entries.length} line=${line}`,
			() =>
				submitWithdrawBatchDurably(makeLabLifecycleDeps(h, provider, gasPriceWei), {
					redeem: redeemAddr,
					pool: labMiningPool,
					amount: total,
					eventKeys,
					line,
				}),
			'[labMiningPoolClPayout]'
		)
		if (outcome === 'settled') noteSettledBatch(h)
		return outcome === 'settled'
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] withdrawNative failed: ${(e as Error)?.message ?? e}`))
		return false
	} finally {
		h.closeScope()
	}
}

async function flushPendingLabBatches(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	redeemAddr: string,
	h: LabHandle
): Promise<void> {
	if (!h.pendingSize && !h.scalar('inFlightWithdraw')) {
		if (clearGasWait(h)) await h.commit('scalars')
		return
	}
	// One journal line per flush that inspected entries or settled a batch (integers only; see labScanSummary.ts).
	const fc = newLabFlushCounters()
	const settledBefore = labSettledEntriesTotal
	const emitFlushSummary = (): void => {
		const text = formatFlushSummary(fc, labSettledEntriesTotal - settledBefore)
		if (text) logger(Colors.cyan(`[labMiningPoolClPayout] ${text}`))
	}

	const maxGas = resolveMaxGasPriceWei()
	const gasDustWei = 50_000_000n // 0.05 gwei
	const gasPrice = await readGasPriceWei(provider)
	const forceMs = resolveGasWaitForceMs()
	let forceFlush = false

	if (gasPrice > maxGas + gasDustWei) {
		const now = Date.now()
		if (!h.scalar('gasWaitStartedAt')) {
			h.setScalar('gasWaitStartedAt', new Date(now).toISOString())
			await h.commit('scalars')
		}
		const startedMs = Date.parse(h.scalar('gasWaitStartedAt') as string)
		const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : forceMs
		if (elapsedMs < forceMs) {
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] skip flush: gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei > max=${ethers.formatUnits(maxGas, 'gwei')} gwei ` +
						`wait ${formatWaitCountdown(elapsedMs, forceMs)} pending=${h.pendingSize}`
				)
			)
			return
		}
		forceFlush = true
		logger(
			Colors.yellow(
				`[labMiningPoolClPayout] force flush: gas wait ${Math.floor(elapsedMs / 1000)}s ≥ ${Math.floor(forceMs / 1000)}s; ` +
					`ignoring max=${ethers.formatUnits(maxGas, 'gwei')} gwei, using live gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei (pending=${h.pendingSize})`
			)
		)
	} else if (clearGasWait(h)) {
		await h.commit('scalars')
	}

	// B-2: settle or resume an unresolved withdrawNative batch before composing anything new.
	if (h.scalar('inFlightWithdraw')) {
		const flight = await enqueueOnchainTxWork(
			LAB_MINING_POOL_ONCHAIN_LANE,
			'lab withdrawNative in-flight',
			() => resumeLabWithdrawInFlight(makeLabLifecycleDeps(h, provider, gasPrice)),
			'[labMiningPoolClPayout]'
		)
		if (flight === 'pending') return
		if (flight === 'settled') noteSettledBatch(h)
	}

	const flushMax = resolveFlushMaxEntries()
	const batchEntries = resolveFlushBatchEntries()
	const maxBatches = resolveFlushMaxBatches()
	const freezeForSelect = h.scalar('freezeH')?.height
	// Invariant C (labInvariantC.ts): history candidates only up to the committed cursor. Off by default (single-wallet mode): nothing changes.
	const invC = resolveHistoryPayBehindCursor() && freezeForSelect != null
	const invPlan = planInvariantCFlush({
		flagOn: invC,
		freezeH: freezeForSelect,
		committedHistoryCursor: labCommittedHistoryCursor,
		maxPaidHistoryBlock: h.scalar('maxPaidHistoryBlock'),
		initDone: labInvariantCInitDone,
		pending: h.pendingValues(),
	})
	labInvariantCInitDone = invPlan.initDone
	if (invC) {
		h.setScalar('maxPaidHistoryBlock', invPlan.maxPaidHistoryBlock)
		if (invPlan.stateChanged) await h.commit('scalars')
		for (const line of invPlan.logs) {
			const text = `[labMiningPoolClPayout] ${line}`
			logger(line.startsWith('ALERT') ? Colors.red(text) : line.startsWith('WARN') ? Colors.yellow(text) : Colors.cyan(text))
		}
	}
	const historyMaxBlock = invPlan.historyMaxBlock
	// Realtime reserved quota first, then history (see labFlushSelect.ts). Without a freeze height the line cannot be told: oldest-first as before.
	const selection = selectFlushCandidates(h.pendingValues(), {
		freezeH: freezeForSelect ?? Number.MAX_SAFE_INTEGER,
		flushMax,
		realtimeQuota: freezeForSelect == null ? 0 : resolveRealtimeReservedBatches() * batchEntries,
		historyFloor: batchEntries,
		historyHeld: freezeForSelect != null && historyReviewHeld(h),
		historyMaxBlock,
	})
	const ordered = selection.ordered
	fc.inspectRealtime = selection.realtimeInspected
	fc.inspectHistory = selection.historyInspected
	fc.pendingRealtime = selection.realtimePending
	fc.pendingHistory = selection.historyPending
	if (invC) {
		fc.invariantC = {
			pendingHistoryPayable: selection.historyPayablePending,
			pendingHistoryAhead: selection.historyAheadPending,
			histAheadHeld: selection.historyAheadPending,
			histCursor: labCommittedHistoryCursor ?? null,
			maxPaidHistoryBlock: h.scalar('maxPaidHistoryBlock') ?? null,
			frontLead: frontLead(h.scalar('maxPaidHistoryBlock'), labCommittedHistoryCursor) ?? null,
		}
		// Informational alert (not the back-pressure pause): nothing payable in history, entries ahead of the cursor, and the (single) wallet idle.
		if (
			labScanBottleneck.observe(
				{ payableHistoryCandidates: selection.historyPayablePending, historyAhead: selection.historyAheadPending, idleHistoryWallet: !h.scalar('inFlightWithdraw') },
				Date.now()
			)
		) {
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] ALERT scan is the bottleneck: no payable history candidate, ${selection.historyAheadPending} history entries ahead of cursor ${labCommittedHistoryCursor ?? 'unset'}, wallet idle`
				)
			)
		}
	}
	let live: SkimEntry[] = []
	let droppedConsumed = 0
	let unconfirmed = 0
	// The paid-key reads are independent; they run with bounded parallelism and are applied in the original order.
	const paidKeyReads = await mapWithConcurrency(ordered, resolveReadConcurrency(), (e) =>
		settle((async () => Boolean(await readContract.consumedRewardEventKey!(e.eventKey)))())
	)
	for (let i = 0; i < ordered.length; i++) {
		const e = ordered[i]!
		const r = paidKeyReads[i]!
		if (!r.ok) {
			unconfirmed++
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] flush paid-key view unconfirmed eventKey=${e.eventKey} ${
						r.error instanceof Error ? r.error.message : String(r.error)
					}; left pending, not signed`
				)
			)
			continue
		}
		if (r.value) {
			h.consumedAdd(e.eventKey)
			h.pendingDel(e.eventKey)
			droppedConsumed++
			continue
		}
		live.push(e)
	}
	fc.inspect = ordered.length
	fc.pendingAtInspect = h.pendingSize + droppedConsumed
	fc.droppedChainConsumed = droppedConsumed
	fc.unconfirmed = unconfirmed
	if (droppedConsumed > 0 || unconfirmed > 0) {
		await h.commit('drop')
		logger(
			Colors.cyan(
				`[labMiningPoolClPayout] flush paid-key dropped=${droppedConsumed} unconfirmed=${unconfirmed} pending=${h.pendingSize}`
			)
		)
	}
	// Guardian re-check right before signing (see labFlushGuardian.ts): an entry whose pubkey now has an active beneficiary
	// belongs to the redeem stack. It stays pending and is not marked consumed.
	{
		const guardian = await partitionByGuardianBeneficiary(live, defaultLabScanDeps(readContract).guardianBeneficiary)
		fc.guardianHeld = guardian.held.length
		fc.unconfirmed += guardian.unconfirmed.length
		if (guardian.held.length > 0 || guardian.unconfirmed.length > 0) {
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] flush guardian re-check held=${guardian.held.length} unconfirmed=${guardian.unconfirmed.length}; left pending, not signed`
				)
			)
		}
		live = guardian.keep
	}
	if (!live.length) {
		if (clearGasWait(h)) await h.commit('scalars')
		emitFlushSummary()
		return
	}

	const freezeH = h.scalar('freezeH')?.height
	if (freezeH == null) {
		logger(Colors.yellow('[labMiningPoolClPayout] skip flush: freezeH not set yet'))
		emitFlushSummary()
		return
	}

	const holdBefore = resolveReviewHoldBeforeBlock()
	const holdHistory = historyReviewHeld(h)
	const signable = live.filter((e) => {
		if (holdBefore != null && e.blockNumber <= holdBefore) return false
		if (holdHistory && classifyPendingLine(e.blockNumber, freezeH) === 'history') return false
		return true
	})
	const held = live.length - signable.length
	if (held > 0) {
		logger(
			Colors.yellow(
				`[labMiningPoolClPayout] review-hold n=${held} pending=${h.pendingSize} historyAtCap=${holdHistory} holdBefore=${holdBefore ?? 'unset'}; left pending, not signed`
			)
		)
	}
	fc.held = held
	fc.signable = signable.length
	if (!signable.length) {
		emitFlushSummary()
		return
	}

	// Pack per-line batches. withdrawNative has no 32×count floor. A batch larger than
	// the contract balance is refused inside submit and left pending.
	type LinedBatch = { line: LabScanLine; entries: SkimEntry[] }
	const packLine = (line: LabScanLine, entries: SkimEntry[]): LinedBatch[] => {
		const out: LinedBatch[] = []
		let cur: SkimEntry[] = []
		for (const e of entries) {
			if (cur.length >= batchEntries) {
				out.push({ line, entries: cur })
				cur = []
			}
			cur.push(e)
		}
		if (cur.length) out.push({ line, entries: cur })
		return out
	}

	const historyLive = signable.filter((e) => classifyPendingLine(e.blockNumber, freezeH) === 'history')
	const realtimeLive = signable.filter((e) => classifyPendingLine(e.blockNumber, freezeH) === 'realtime')
	const packed = [...packLine('realtime', realtimeLive), ...packLine('history', historyLive)]
	const reserved = resolveRealtimeReservedBatches()
	const scheduled = scheduleFlushBatches(packed, reserved)
	const batches = scheduled.ordered.slice(0, maxBatches)
	fc.batches = batches.length
	if (!batches.length) {
		emitFlushSummary()
		return
	}

	const tipBlock = Number(await provider.getBlockNumber().catch(() => freezeH))
	const oldestRt = realtimeLive.length
		? Math.min(...realtimeLive.map((e) => e.blockNumber))
		: null
	const lat = formatRealtimeLatency({ tipBlock, oldestRealtimePendingBlock: oldestRt })
	const histCursor = h.scalar('historyCursor') ?? freezeH
	const prog = formatHistoryProgress(histCursor, freezeH)
	logger(
		Colors.cyan(
			`[labMiningPoolClPayout] flush inspect=${ordered.length}/${h.pendingSize} live=${live.length} → ${batches.length} batch(es) ` +
				`A2 rtFirst=${scheduled.realtimeFirst} hist=${scheduled.historyCount} reserved=${reserved} ` +
				`rtLatency tipGap=${lat.tipGapBlocks} histProgress remaining=${prog.remaining} pct=${prog.pct}% ` +
				`(maxEntries=${flushMax} batchEntries=${batchEntries} maxBatches=${maxBatches}) ` +
				`gasPrice=${ethers.formatUnits(gasPrice, 'gwei')}gwei${forceFlush ? ' force=1' : ''}`
		)
	)

	for (const batch of batches) {
		const ok = await submitLabSkimBatch(
			provider,
			redeemAddr,
			batch.entries,
			h,
			gasPrice,
			batch.line
		)
		if (!ok) {
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] batch failed line=${batch.line} n=${batch.entries.length}; remaining stay in pending pool (pending=${h.pendingSize})`
				)
			)
			await h.commit('scalars')
			fc.failed = true
			emitFlushSummary()
			return
		}
		for (const e of batch.entries) h.pendingDel(e.eventKey)
		await h.commit('settle')
	}

	if (!h.pendingSize && clearGasWait(h)) await h.commit('scalars')
	emitFlushSummary()
}

async function processBlockRange(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	redeemAddr: string,
	fromBlock: number,
	toBlock: number,
	h: LabHandle,
	counters: LabScanCounters
): Promise<{ okThrough: number | null; added: number; fetchFailed: boolean; unconfirmed: boolean }> {
	const proxyLower = redeemAddr.toLowerCase()
	let okThrough: number | null = null
	let added = 0
	// The next block is requested while the current one is classified (fetchBlockWithWithdrawals never rejects).
	let nextBlock: Promise<RpcBlock | null> | null = fromBlock <= toBlock ? fetchBlockWithWithdrawals(provider, fromBlock) : null
	for (let bn = fromBlock; bn <= toBlock; bn++) {
		const block = await nextBlock
		nextBlock = bn + 1 <= toBlock ? fetchBlockWithWithdrawals(provider, bn + 1) : null
		if (!block) {
			return { okThrough, added, fetchFailed: true, unconfirmed: false }
		}
		let entries: SkimEntry[]
		try {
			entries = await collectLabSkimEntriesForBlock(
				readContract,
				proxyLower,
				bn,
				block,
				h,
				counters
			)
		} catch (err: unknown) {
			if (err instanceof PaidKeyViewUnconfirmed) {
				logger(
					Colors.yellow(
						`[labMiningPoolClPayout] paid-key view unconfirmed block=${bn} eventKey=${err.eventKey} ${err.message}; cursor stays ${okThrough ?? 'unset'}`
					)
				)
				return { okThrough, added, fetchFailed: false, unconfirmed: true }
			}
			throw err
		}
		const merged = h.pendingAdd(entries)
		added += merged
		counters.added += merged
		counters.blocks++
		okThrough = bn
	}
	return { okThrough, added, fetchFailed: false, unconfirmed: false }
}

function logSessionStartIfNeeded(h: LabHandle, liveHead: number, freeze: LabFreezeH): void {
	if (labPhaseLogged) return
	labPhaseLogged = true
	const floor = sessionBackfillFloor ?? resolveSessionBackfillFloor(h.scalar('lastListeningEndBlock'))
	logger(
		Colors.cyan(
			`[labMiningPoolClPayout] dual-cursor H=${freeze.height} frozenAt=${freeze.frozenAt} ` +
				`historyCursor=${h.scalar('historyCursor')} realtimeCursor=${h.scalar('realtimeCursor')} ` +
				`floor=${floor} liveHead=${liveHead} (legacy listen=${h.scalar('lastListeningEndBlock') ?? 'none'} backfill=${h.scalar('lastBackfillProcessedBlock')})`
		)
	)
}

/** One scan window = one commit scope: all its writes end up in the single commit('scan') at its end (design T1); the scope is closed on every exit, keeping buffered writes if no commit happened. */
async function scanWindowAndAdvance(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	redeemAddr: string,
	from: number,
	to: number,
	h: LabHandle,
	line: LabScanLine,
	counters: LabScanCounters
): Promise<{ okThrough: number | null; added: number }> {
	h.openScope('scan')
	try {
		return await scanWindowAndAdvanceInner(provider, readContract, redeemAddr, from, to, h, line, counters)
	} finally {
		h.closeScope()
	}
}

async function scanWindowAndAdvanceInner(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	redeemAddr: string,
	from: number,
	to: number,
	h: LabHandle,
	line: LabScanLine,
	counters: LabScanCounters
): Promise<{ okThrough: number | null; added: number }> {
	const { okThrough, added, fetchFailed, unconfirmed } = await processBlockRange(
		provider,
		readContract,
		redeemAddr,
		from,
		to,
		h,
		counters
	)
	if (counters.from == null) counters.from = from
	if (okThrough != null) counters.through = okThrough
	if (fetchFailed) counters.fetchFailed = true
	if (unconfirmed) counters.unconfirmed = true
	if (okThrough != null) {
		// Cursor + enqueue are persisted together (anti-power-loss).
		if (line === 'history') {
			h.setScalar('historyCursor', okThrough)
			h.setScalar('lastBackfillProcessedBlock', Math.max(h.scalar('lastBackfillProcessedBlock'), okThrough))
		} else {
			h.setScalar('realtimeCursor', okThrough)
			h.setScalar('lastLiveHeadScanned', Math.max(h.scalar('lastLiveHeadScanned') ?? 0, okThrough))
		}
		await h.commit('scan')
		if (line === 'history') labCommittedHistoryCursor = h.scalar('historyCursor') ?? null
		const label = line === 'history' ? 'history' : 'realtime'
		if (added > 0) {
			logger(
				Colors.cyan(
					`[labMiningPoolClPayout] ${label} queued +${added} (pending=${h.pendingSize}) ${from}-${okThrough}`
				)
			)
		} else {
			logger(Colors.gray(`[labMiningPoolClPayout] ${label} ${from}-${okThrough}`))
		}
	}
	if (fetchFailed) {
		logger(Colors.yellow(`[labMiningPoolClPayout] ${line} fetch failed at ${from}-${to}; cursor not advanced past okThrough=${okThrough}`))
	}
	return { okThrough, added }
}

/** One journal line per scan line and tick (integers only). Silent when the tick processed no block and nothing failed. */
function logScanSummary(line: LabScanLine, counters: LabScanCounters): void {
	const text = formatScanSummary(line, counters)
	if (text) logger(Colors.cyan(`[labMiningPoolClPayout] ${text}`))
}

async function labPayoutTick(): Promise<void> {
	if (labInFlight) return
	if (labGate.tripped) {
		logger(Colors.red(`[labMiningPoolClPayout] ALERT tick skipped: fail-closed (${labGate.tripReason})`))
		return
	}
	labInFlight = true
	let tickHandle: LabHandle | undefined
	try {
		if (!loadManifestIfNeeded()) return

		const redeemAddr = resolveLabRedeemAddress()
		const provider = createLabRpcProvider()
		const readContract = new ethers.Contract(redeemAddr, READ_ABI, provider)

		const state = getLabSessionState()
		const h: LabHandle = legacyStore.newHandle(state)
		tickHandle = h
		h.enterTick()
		const liveHead = Number(await provider.getBlockNumber())
		const floor = resolveLabScanFloorBlock()
		if (!Number.isFinite(liveHead) || liveHead < floor) return

		const tipBlock = await provider.getBlock(liveHead)
		const tipHash = tipBlock?.hash
		if (!tipHash || !/^0x[0-9a-fA-F]{64}$/.test(tipHash)) {
			logger(Colors.yellow(`[labMiningPoolClPayout] skip tick: tip hash missing at ${liveHead}`))
			return
		}
		const freeze = ensureDualCursors(h, liveHead, tipHash)
		await h.commit('scalars')
		labCommittedHistoryCursor = h.scalar('historyCursor') ?? null
		logSessionStartIfNeeded(h, liveHead, freeze)

		const chunk = resolveChunkBlocks()
		const chunksPerTick = resolveChunksPerTick()

		// Back-pressure: the pending pool must stay below its memory ceiling. A paused line only postpones scanning.
		const highWater = resolvePendingHighWater()
		// Invariant C: history entries ahead of the committed cursor are not payable yet; the history pause must not count them (labBackpressure.ts).
		const invC = resolveHistoryPayBehindCursor()
		let histTotal = 0
		let histAhead = 0
		if (invC) ({ histTotal, histAhead } = countHistoryAhead(h.pendingValues(), freeze.height, labCommittedHistoryCursor))
		const pauses = decideLinePauses({ history: labHistoryPaused, realtime: labRealtimePaused }, h.pendingSize, highWater, histAhead)
		labHistoryPaused = pauses.history
		labRealtimePaused = pauses.realtime

		// 1) Realtime line first (tip-fill) — reserved capacity for latency.
		const rtCounters = newLabScanCounters()
		if (labRealtimePaused) rtCounters.paused = true
		if (!labRealtimePaused) {
			let windows = 0
			while (windows < chunksPerTick) {
				const w = nextRealtimeWindow(h.scalar('realtimeCursor') ?? freeze.height, freeze.height, liveHead, chunk)
				if (!w) break
				await scanWindowAndAdvance(
					provider,
					readContract,
					redeemAddr,
					w.from,
					w.to,
					h,
					'realtime',
					rtCounters
				)
				windows++
				if ((h.scalar('realtimeCursor') ?? 0) < w.to) break
			}
		}
		logScanSummary('realtime', rtCounters)

		// 2) History line keeps advancing toward H (must not stall forever behind realtime).
		const hiCounters = newLabScanCounters()
		if (labHistoryPaused) hiCounters.paused = true
		if (!labHistoryPaused) {
			let windows = 0
			while (windows < chunksPerTick) {
				const w = nextHistoryWindow(h.scalar('historyCursor') ?? floor - 1, freeze.height, chunk)
				if (!w) break
				await scanWindowAndAdvance(
					provider,
					readContract,
					redeemAddr,
					w.from,
					w.to,
					h,
					'history',
					hiCounters
				)
				windows++
				if ((h.scalar('historyCursor') ?? 0) < w.to) break
			}
		}
		logScanSummary('history', hiCounters)

		const prog = formatHistoryProgress(h.scalar('historyCursor') ?? freeze.height, freeze.height)
		const lat = formatRealtimeLatency({
			tipBlock: liveHead,
			oldestRealtimePendingBlock: [...h.pendingValues()]
				.filter((e) => classifyPendingLine(e.blockNumber, freeze.height) === 'realtime')
				.reduce<number | null>((m, e) => (m == null ? e.blockNumber : Math.min(m, e.blockNumber)), null),
		})
		logger(
			Colors.gray(
				`[labMiningPoolClPayout] progress hist remaining=${prog.remaining} pct=${prog.pct}% ` +
					`rt tipGap=${lat.tipGapBlocks} pending=${h.pendingSize}` +
					(invC ? ` histPayable=${histTotal - histAhead} histAhead=${histAhead}` : '')
			)
		)

		await flushPendingLabBatches(provider, readContract, redeemAddr, h)
		tryPersistListeningCheckpoint(h, liveHead)
		await h.commit('scalars')
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] tick error: ${(e as Error)?.message ?? e}`))
	} finally {
		tickHandle?.exitTick()
		labInFlight = false
	}
}

function scheduleNextLabTick(): void {
	if (!labStarted) return
	labTimer = setTimeout(async () => {
		await labPayoutTick()
		scheduleNextLabTick()
	}, resolveTickMs())
}

export function startValidatorLabMiningPoolClPayoutReporter(): void {
	if (labStarted) return
	if (!labEnabled()) {
		logger(Colors.yellow('[labMiningPoolClPayout] disabled (set CONET_LAB_MINING_POOL_CL_PAYOUT=1)'))
		return
	}
	if (!loadManifestIfNeeded(true)) return
	// Refuses to start when another live process holds the state dir (throws, daemon exits).
	assertPinnedRedeem(process.env.CONET_VALIDATOR_DEPOSIT_REDEEM, CONET_VALIDATOR_DEPOSIT_REDEEM)
	labStateLock = acquireStateDirLock(resolveSegmentedStateDir())
	// Forward-compat guard (always on): events in wal/ would be silently ignored by this build, so refuse to start (labWalGuard.ts).
	assertNoWalEvents(resolveSegmentedStateDir())
	labSessionState = initLabSessionState()
	// Start check: a one-shot limit already reached exits cleanly before the first tick.
	if (shouldStopAfterSettled(labSessionState.settledBatchCount ?? 0, resolveMaxSettledBatches())) {
		logger(Colors.cyan('[labMiningPoolClPayout] MAX_SETTLED_BATCHES already reached at start; exiting 0 before any tick'))
		process.exit(0)
	}
	labStarted = true
	logger(
		Colors.cyan(
			`[labMiningPoolClPayout] starting dual-cursor+withdrawNative pubkeys=${labPubkeySet.size} tick=${resolveTickMs()}ms ` +
				`${startupConfigLine()} ` +
				`realtimeReserved=${resolveRealtimeReservedBatches()} ` +
				`rpcHttpTimeoutMs=${resolveRpcHttpTimeoutMs()} txWaitTimeoutMs=${resolveTxWaitTimeoutMs()} pendingPool=on`
		)
	)
	void labPayoutTick().finally(() => scheduleNextLabTick())
}

export function stopValidatorLabMiningPoolClPayoutReporter(): void {
	labStarted = false
	labSessionState = undefined
	sessionBackfillFloor = undefined
	labPhaseLogged = false
	if (labTimer !== undefined) {
		clearTimeout(labTimer)
		labTimer = undefined
	}
}

/** Persist listening checkpoint before process exit (next restart backfills from lastListeningEndBlock+1). */
export async function flushLabMiningPoolListeningCheckpoint(): Promise<void> {
	try {
		const state = labSessionState ?? legacyStore.readStateFromDisk()
		const provider = createLabRpcProvider()
		const liveHead = Number(await provider.getBlockNumber())
		if (Number.isFinite(liveHead)) {
			tryPersistListeningCheckpoint(legacyStore.newHandle(state, { loadPending: false }), liveHead)
		}
		legacyStore.writeState(state)
	} catch {
		/* best effort */
	}
}

/** Bounded idle wait so SIGTERM cannot hang forever behind a stuck tx.wait. */
export async function waitForLabMiningPoolClPayoutIdle(maxWaitMs = 90_000): Promise<void> {
	const started = Date.now()
	while (labInFlight) {
		if (Date.now() - started >= maxWaitMs) {
			logger(
				Colors.red(
					`[labMiningPoolClPayout] idle wait timeout ${maxWaitMs}ms (labInFlight still true); continuing shutdown`
				)
			)
			return
		}
		await new Promise((r) => setTimeout(r, 250))
	}
}
