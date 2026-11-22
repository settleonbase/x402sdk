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
import { loadPoolConfig, type PoolConfig, type PoolWallet } from './labPoolConfig'
import { BudgetedJsonRpcProvider, RpcBudget, rpcSource } from './labRpcBudget'
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
import { gracefulStopWalSession, openWalSession, type SnapshotConfig, type WalSession } from './labWalSession'
import { appendConsumedArchive, consumedArchiveDir } from './labConsumedPrune'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import type { ActorView } from './labActorHandle'
import type { LabPayoutStateCore } from './labPayoutStateCore'
import type { LabStateHandle } from './labStateHandle'
import { createLegacyStateStore, type LabClPayoutState, type SkimEntry, type LabPendingEntryJson } from './labLegacyState'
import { LabTickLoop, type LabTickOutcome } from './labTickLoop'
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

/**
 * Global RPC budget (P3): off by default (the coupled and the single-wallet decoupled paths read as before); the pool mode turns it on (total 16, 2 guaranteed per source: scan, pay-rt, pay-hist),
 * CONET_LAB_MINING_POOL_CL_PAYOUT_RPC_BUDGET_TOTAL / _MIN set it explicitly (a total of 0 switches it off). Every read goes through createLabRpcProvider's provider, so every read takes a slot.
 */
let labRpcBudget: RpcBudget | undefined
function resolveRpcBudget(): RpcBudget | undefined {
	if (labRpcBudget) return labRpcBudget
	const raw = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_RPC_BUDGET_TOTAL?.trim()
	const pools = Boolean(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_FILE?.trim())
	const total = raw !== undefined && raw !== '' ? Number(raw) : pools ? 16 : 0
	if (!Number.isInteger(total) || total < 1) return undefined
	const minRaw = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_RPC_BUDGET_MIN)
	labRpcBudget = new RpcBudget(total, Number.isInteger(minRaw) && minRaw >= 0 ? minRaw : 2)
	return labRpcBudget
}

function createLabRpcProvider(): ethers.JsonRpcProvider {
	const url = resolveLabRpcUrl()
	const req = new ethers.FetchRequest(url)
	req.timeout = resolveRpcHttpTimeoutMs()
	// Avoid HTTP batching quirks on local geth; one method per request. The ONLY provider the daemon creates: every request takes a slot from the global budget (labRpcBudget.ts).
	return new BudgetedJsonRpcProvider(req, undefined, { staticNetwork: true, batchMaxCount: 1 }, resolveRpcBudget())
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
/** Set by stop; a WAL start that is still opening its session must then not begin ticking (the shutdown converts the opened session instead). */
let labStopRequested = false
let labWalStarting: Promise<void> | null = null
let labInFlight = false
/** P3 decoupled mode: the payment worker's own in-flight flag, timers and wake-up (the scan tick above never pays in this mode). */
let labPayInFlight = false
let labPayTimer: ReturnType<typeof setTimeout> | undefined
let labPayRunning = false
let labPayWakeQueued = false
/** P4 wallet pools (decoupled mode only): one payment loop per wallet. */
type PoolActor = ActorView<SkimEntry, LabClPayoutState>
type PoolWalletState = { w: PoolWallet; running: boolean; wakeQueued: boolean; timer?: ReturnType<typeof setTimeout>; isolated?: string; passes: number; settledBatches: number }
let labPool: { cfg: PoolConfig; wallets: PoolWalletState[] } | undefined
/** Serial tick loop (labTickLoop.ts): working ticks continue at once, idle/fault/skipped ticks wait resolveTickMs(). Used by EVERY mode: the coupled tick, the decoupled scan tick and the pool's scan tick; the payment loops (wakePayWorker / wakePoolWallet) are separate and wait PAY_IDLE_MS, not TICK_MS. */
const labLoop = new LabTickLoop({ tick: () => labPayoutTick(), backoffMs: () => resolveTickMs() })
let labPubkeySet = new Set<string>()
let labMiningPool = ''
let labManifestMtime = 0
let labPhaseLogged = false
let labSessionState: LabClPayoutState | undefined
/** WAL mode (CONET_LAB_MINING_POOL_CL_PAYOUT_WAL): the recovered state, the log writer and the long-lived handle. Undefined = the legacy whole-state path. */
let labWalSession: WalSession | undefined
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

/**
 * TICK_MS (CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS) since the continuous tick loop: the wait after a tick that made no progress (idle, fault, skipped; see labTickLoop.ts). A tick that
 * made progress is followed at once, without any wait. Default 60 s and the "< 15 000 falls back to 60 000" check are unchanged, so idle and persistent faults wait exactly what every tick waited before.
 */
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

/** P3: payment worker decoupled from the scan tick (needs WAL mode). Off = the coupled tick of P2, unchanged. */
function labDecoupled(): boolean {
	return process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_DECOUPLED === '1'
}
/** How long an idle payment worker waits before looking again (a scan commit that added pending entries wakes it earlier). */
function resolvePayIdleMs(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_PAY_IDLE_MS)
	return Number.isFinite(n) && n >= 50 ? Math.floor(n) : 5_000
}

/** How long the one-shot exit of a decoupled daemon waits for the running scan tick (default 90 s; tunable so the over-wait path can be exercised end to end). */
function resolveShutdownIdleWaitMs(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_SHUTDOWN_IDLE_WAIT_MS)
	return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 90_000
}

/** The settled count is persisted in the same write as the consumed set (lifecycle countSettled). Exit only after that write. */
async function noteSettledBatch(h: LabHandle): Promise<void> {
	const max = resolveMaxSettledBatches()
	if (shouldStopAfterSettled(h.scalar('settledBatchCount') ?? 0, max)) {
		logger(Colors.cyan(`[labMiningPoolClPayout] MAX_SETTLED_BATCHES=${max} reached (persisted); exiting 0`))
		stopValidatorLabMiningPoolClPayoutReporter()
		if (labWalSession) {
			// WAL mode: this tick ends here (the process exits and nothing below runs), so it leaves the tick and the batch scope, then the same graceful stop as SIGTERM
			h.closeScope()
			h.exitTick()
			// decoupled: the scan tick may still be running; the graceful stop is only legal when it has ended (this payment tick is the caller, so it is not waited for)
			const scanIdle = labDecoupled() ? await waitForLabMiningPoolClPayoutIdle(resolveShutdownIdleWaitMs(), { exceptPay: true }) : true
			if (!scanIdle) process.exit(1)
			const code = await gracefulStopWalSession(labWalSession, { stateDir: resolveSegmentedStateDir(), tickIdle: true, log: walLog })
			process.exit(code)
		}
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

/** The write-ahead-log state path. Off by default: the legacy whole-state path is then byte for byte what it was. */
function labWalMode(): boolean {
	return ['1', 'true', 'yes', 'on'].includes(String(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_WAL || '').trim().toLowerCase())
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
	gasPriceWei: bigint,
	pool?: { ws: PoolWalletState; handle: PoolActor }
): LabLifecycleDeps {
	const env = pool ? walletEnv(pool.ws.w) : undefined
	return {
		gate: labGate,
		getInFlight: () => (pool ? (pool.handle.slot(pool.ws.w.id) as never) : h.scalar('inFlightWithdraw')) ?? null,
		setInFlight: (v) => {
			if (pool) pool.handle.setSlot(pool.ws.w.id, (v as Record<string, unknown> | null) ?? null)
			else if (v) h.setScalar('inFlightWithdraw', v)
			else h.delScalar('inFlightWithdraw')
		},
		persist: (step) => h.commit(step),
		countSettled: () => {
			h.incScalar('settledBatchCount', 1)
		},
		stopBeforeSend: () => shouldStopAfterSettled(h.scalar('settledBatchCount') ?? 0, resolveMaxSettledBatches()),
		halt: (code, reason) => (pool ? isolatePoolWallet(pool.ws, code, reason) : haltDaemon(h, code, reason)),
		send: async (rec) => {
			// One send. No recovery and no retry here: the lifecycle holds an unknown outcome (B-2).
			const sent = await sendConfiguredLabWithdrawNative({
				redeem: rec.redeem,
				pool: rec.pool,
				amount: BigInt(rec.amountWei),
				eventKeys: rec.eventKeys,
				gasLimit: resolvePayoutGasLimit(),
				expectedIdempotencyKey: rec.idempotencyKey,
				...(env ? { env } : {}),
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
			await verifyLabSignerBoundAddress(env ?? process.env)
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
		if (outcome === 'settled') await noteSettledBatch(h)
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
			h.setScalarIfUnset('gasWaitStartedAt', new Date(now).toISOString())
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
		if (flight === 'settled') await noteSettledBatch(h)
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

/**
 * One tick. Resolves with what it did, for the loop's choice between "next tick at once" and "wait resolveTickMs()":
 *   progress  a scan advanced at least one block, or a payment batch settled entries (state moved, more work may be waiting)
 *   idle      nothing to scan, nothing paid (caught up, back-pressure pause, gas wait, held entries: no state moved)
 *   fault     the tick threw, the tip hash was missing, or a scan stopped on an RPC failure without advancing
 *   skipped   another tick still in flight, the fail-closed gate is tripped, or the manifest could not be loaded
 */
async function labPayoutTick(): Promise<LabTickOutcome> {
	return rpcSource.run('scan', () => labPayoutTickBody())
}

async function labPayoutTickBody(): Promise<LabTickOutcome> {
	if (labInFlight) return 'skipped'
	if (labGate.tripped) {
		logger(Colors.red(`[labMiningPoolClPayout] ALERT tick skipped: fail-closed (${labGate.tripReason})`))
		return 'skipped'
	}
	labInFlight = true
	let tickHandle: LabHandle | undefined
	try {
		if (!loadManifestIfNeeded()) return 'skipped'
		const settledBefore = labSettledEntriesTotal

		const redeemAddr = resolveLabRedeemAddress()
		const provider = createLabRpcProvider()
		const readContract = new ethers.Contract(redeemAddr, READ_ABI, provider)

		const decoupled = labDecoupled() && labWalSession !== undefined
		const h: LabHandle = decoupled ? labWalSession!.hub.actor('scan') : labWalSession ? labWalSession.handle : legacyStore.newHandle(getLabSessionState())
		tickHandle = h
		h.enterTick()
		const liveHead = Number(await provider.getBlockNumber())
		const floor = resolveLabScanFloorBlock()
		if (!Number.isFinite(liveHead) || liveHead < floor) return 'idle'

		const tipBlock = await provider.getBlock(liveHead)
		const tipHash = tipBlock?.hash
		if (!tipHash || !/^0x[0-9a-fA-F]{64}$/.test(tipHash)) {
			logger(Colors.yellow(`[labMiningPoolClPayout] skip tick: tip hash missing at ${liveHead}`))
			return 'fault'
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

		if (!decoupled) await flushPendingLabBatches(provider, readContract, redeemAddr, h)
		tryPersistListeningCheckpoint(h, liveHead)
		await h.commit('scalars')
		if (decoupled) wakePayWorker() // what this tick queued is committed: the payer may look now
		// progress = the scan advanced a block, or (coupled mode only: the same tick pays) a batch settled; in the decoupled and pool modes settlements happen on the payment loops and are not this tick's progress
		if (rtCounters.blocks > 0 || hiCounters.blocks > 0 || (!decoupled && labSettledEntriesTotal > settledBefore)) return 'progress'
		if (rtCounters.fetchFailed || rtCounters.unconfirmed || hiCounters.fetchFailed || hiCounters.unconfirmed) return 'fault'
		return 'idle'
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] tick error: ${(e as Error)?.message ?? e}`))
		return 'fault'
	} finally {
		tickHandle?.exitTick()
		labInFlight = false
		labWalSession?.scheduler.poke() // snapshot when due (interval / log size); at most one runs, failures are alerts, never exceptions
	}
}

/**
 * One payment pass of the decoupled worker: the same flush the coupled tick ran after its scan, on its own actor handle (it sees only committed pending entries). Returns true when a batch settled
 * (more work may be waiting: the worker continues at once), false otherwise (idle, gas wait, held entries, a fault: it waits PAY_IDLE_MS or a wake-up).
 */
async function labPayTick(): Promise<boolean> {
	return rpcSource.run('pay', () => labPayTickBody())
}

async function labPayTickBody(): Promise<boolean> {
	if (labPayInFlight) return false
	if (labGate.tripped) {
		logger(Colors.red(`[labMiningPoolClPayout] ALERT pay tick skipped: fail-closed (${labGate.tripReason})`))
		return false
	}
	const session = labWalSession
	if (!session) return false
	labPayInFlight = true
	let h: LabHandle | undefined
	try {
		if (!loadManifestIfNeeded()) return false
		const redeemAddr = resolveLabRedeemAddress()
		const provider = createLabRpcProvider()
		const readContract = new ethers.Contract(redeemAddr, READ_ABI, provider)
		h = session.hub.actor('pay')
		h.enterTick()
		const settledBefore = labSettledEntriesTotal
		await flushPendingLabBatches(provider, readContract, redeemAddr, h)
		await h.commit('scalars')
		return labSettledEntriesTotal > settledBefore
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] pay tick error: ${(e as Error)?.message ?? e}`))
		return false
	} finally {
		h?.exitTick()
		labPayInFlight = false
		session.scheduler.poke()
	}
}

function walletEnv(w: PoolWallet): NodeJS.ProcessEnv {
	return {
		...process.env,
		CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: w.socket,
		CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: w.keyArray,
		CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS: w.address,
	}
}
const poolLane = (w: PoolWallet): string => `${LAB_MINING_POOL_ONCHAIN_LANE}:${w.id}`

/** Wallet-level halt: receipt unknown (4) only logs - the slot stays, the next pass resumes the same hash; status 0 (3) isolates THIS wallet (its slot is released by the lifecycle, an operator looks), the others go on. */
function isolatePoolWallet(ws: PoolWalletState, code: number, reason: string): void {
	if (code === 4) {
		logger(Colors.yellow(`[labMiningPoolClPayout] wallet ${ws.w.id}: ${reason}; the slot stays and the next pass resumes it`))
		return
	}
	ws.isolated = `exit ${code}: ${reason}`
	logger(Colors.red(`[labMiningPoolClPayout] ALERT wallet ${ws.w.id} isolated (${ws.isolated}); the other wallets keep paying`))
}

const resolveMinVdrBalanceReserveWei = (): bigint => {
	const raw = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_MIN_VDR_BALANCE_RESERVE_WEI?.trim()
	if (raw === undefined || raw === '') throw new Error('[labMiningPoolClPayout] pool mode needs CONET_LAB_MINING_POOL_CL_PAYOUT_MIN_VDR_BALANCE_RESERVE_WEI (no default)')
	return BigInt(raw)
}

/**
 * Poison-batch quarantine (review F-B2): keys of a batch that came back with receipt status 0, or that were refused / failed twice, are not offered to the next wallet of the line (it would burn wallet
 * after wallet on the same poison). They stay pending, are excluded from every wallet's selection until the process restarts, and an ALERT names them. An operator looks.
 */
const labQuarantine = new Set<string>()
const labFailStreak = new Map<string, number>()
function quarantineKeys(wallet: string, keys: string[], why: string): void {
	for (const k of keys) labQuarantine.add(k)
	logger(Colors.red(`[labMiningPoolClPayout] ALERT quarantined ${keys.length} event key(s) after ${why} (wallet ${wallet}); no wallet will claim them until a restart; first key ${keys[0]}`))
}

/** The oldest `batchEntries` payable pending entries of the wallet's line that no wallet holds. Synchronous: the caller claims them in the same block. */
function selectForWallet(h: PoolActor, ws: PoolWalletState, hubIsReserved: (k: string) => boolean): SkimEntry[] {
	const freezeH = h.scalar('freezeH')?.height
	if (freezeH == null) return []
	const cap = resolveFlushBatchEntries()
	const invC = resolveHistoryPayBehindCursor()
	const holdBefore = resolveReviewHoldBeforeBlock()
	const holdHistory = ws.w.line === 'history' && historyReviewHeld(h)
	if (holdHistory) return []
	const out: SkimEntry[] = []
	const byPos = (a: SkimEntry, b: SkimEntry): number => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex
	for (const e of h.pendingValues()) {
		if (classifyPendingLine(e.blockNumber, freezeH) !== ws.w.line) continue
		if (hubIsReserved(e.eventKey.toLowerCase()) || labQuarantine.has(e.eventKey.toLowerCase())) continue
		if (holdBefore != null && e.blockNumber <= holdBefore) continue
		if (ws.w.line === 'history' && invC && (labCommittedHistoryCursor == null || e.blockNumber > labCommittedHistoryCursor)) continue
		if (out.length >= cap && byPos(e, out[out.length - 1]!) >= 0) continue
		let lo = 0
		let hi = out.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (byPos(out[mid]!, e) <= 0) lo = mid + 1
			else hi = mid
		}
		out.splice(lo, 0, e)
		if (out.length > cap) out.pop()
	}
	return out
}

/**
 * One pass of ONE wallet (design P4): resume the wallet's committed slot, else claim a batch of its line, check it (paid-key view, guardian), check the money the wallet may spend, and run the
 * lifecycle on the wallet's own lane with the wallet's own signer. Returns true when a batch settled.
 */
async function poolWalletPass(ws: PoolWalletState): Promise<boolean> {
	return rpcSource.run(ws.w.line === 'realtime' ? 'pay-rt' : 'pay-hist', () => poolWalletPassBody(ws))
}

async function poolWalletPassBody(ws: PoolWalletState): Promise<boolean> {
	const w = ws.w
	if (ws.isolated) return false
	if (labGate.tripped) {
		logger(Colors.red(`[labMiningPoolClPayout] ALERT pay pass skipped (${w.id}): fail-closed (${labGate.tripReason})`))
		return false
	}
	const session = labWalSession
	if (!session || !labPool) return false
	const hub = session.hub
	if (!loadManifestIfNeeded()) return false
	const redeemAddr = resolveLabRedeemAddress()
	const provider = createLabRpcProvider()
	const readContract = new ethers.Contract(redeemAddr, READ_ABI, provider)
	const h = hub.actor(`pay:${w.id}`)
	h.enterTick()
	ws.passes++
	const lifeDeps = (gasPrice: bigint): LabLifecycleDeps => makeLabLifecycleDeps(h, provider, gasPrice, { ws, handle: h })
	try {
		const gasPrice = await readGasPriceWei(provider)
		// a committed slot (a restart, or an unknown outcome): resume it first; nothing new is composed while it is unresolved
		if (h.slot(w.id)) {
			const flight = await enqueueOnchainTxWork(poolLane(w), `lab withdrawNative in-flight ${w.id}`, () => resumeLabWithdrawInFlight(lifeDeps(gasPrice)), '[labMiningPoolClPayout]')
			if (flight === 'settled') {
				ws.settledBatches++
				await noteSettledBatch(h)
				return true
			}
			if (flight === 'pending') return false
		}
		if (w.state === 'draining') return false
		// gas gate (the clock is shared: the first wallet to see the wait starts it)
		const maxGas = resolveMaxGasPriceWei()
		const gasDustWei = 50_000_000n
		if (gasPrice > maxGas + gasDustWei) {
			const now = Date.now()
			if (!h.scalar('gasWaitStartedAt')) {
				h.setScalarIfUnset('gasWaitStartedAt', new Date(now).toISOString())
				await h.commit('scalars')
			}
			const startedMs = Date.parse(h.scalar('gasWaitStartedAt') as string)
			const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : resolveGasWaitForceMs()
			if (elapsedMs < resolveGasWaitForceMs()) return false
		} else if (clearGasWait(h)) await h.commit('scalars')
		// claim: select and reserve in ONE synchronous block
		const picked = selectForWallet(h, ws, (k) => hub.isReserved(k))
		if (picked.length === 0) return false
		const total = picked.reduce((a, e) => a + BigInt(e.amount), 0n)
		const maxK = resolveMaxSettledBatches()
		if (maxK != null && ((h.scalar('settledBatchCount') ?? 0) + session.core.slotCount + hub.claimCount) >= maxK) return false
		if (!hub.claim(w.id, picked.map((e) => e.eventKey.toLowerCase()), total)) return false
		try {
			// the paid-key view and the guardian re-check of every claimed entry (reads, in parallel)
			const reads = await mapWithConcurrency(picked, resolveReadConcurrency(), (e) => settle((async () => Boolean(await readContract.consumedRewardEventKey!(e.eventKey)))()))
			let live: SkimEntry[] = []
			let dropped = 0
			for (let i = 0; i < picked.length; i++) {
				const e = picked[i]!
				const r = reads[i]!
				if (!r.ok) continue
				if (r.value) {
					h.consumedAdd(e.eventKey)
					h.pendingDel(e.eventKey)
					dropped++
					continue
				}
				live.push(e)
			}
			if (dropped > 0) await h.commit('drop')
			const guardian = await partitionByGuardianBeneficiary(live, defaultLabScanDeps(readContract).guardianBeneficiary)
			live = guardian.keep
			if (live.length === 0) return false
			// the money this wallet may spend: balance - reserve - what every other wallet holds in flight or has claimed
			const balance = await provider.getBalance(redeemAddr)
			const others = session.core.slotsAmountWei() + hub.claimedAmountExcept(w.id)
			const reserve = resolveMinVdrBalanceReserveWei()
			const available = balance > reserve + others ? balance - reserve - others : 0n
			const liveTotal = live.reduce((a, e) => a + BigInt(e.amount), 0n)
			if (liveTotal > available) {
				logger(Colors.red(`[labMiningPoolClPayout] wallet ${w.id}: refuse batch total=${ethers.formatEther(liveTotal)} > available=${ethers.formatEther(available)} (balance=${ethers.formatEther(balance)} others=${ethers.formatEther(others)})`))
				return false
			}
			labGate.assertOpen('withdrawNative')
			if (labDryRun()) return false
			h.openScope('batch')
			try {
				const outcome = await enqueueOnchainTxWork(
					poolLane(w),
					`lab withdrawNative ${w.id} n=${live.length} line=${w.line}`,
					() => submitWithdrawBatchDurably(lifeDeps(gasPrice), { redeem: redeemAddr, pool: labMiningPool, amount: liveTotal, eventKeys: live.map((e) => e.eventKey.toLowerCase()), line: w.line }),
					'[labMiningPoolClPayout]'
				)
				const liveKeys = live.map((e) => e.eventKey.toLowerCase())
				const streakKey = liveKeys.join(',')
				if (outcome === 'settled') {
					ws.settledBatches++
					labFailStreak.delete(streakKey)
					await noteSettledBatch(h)
				} else if (outcome === 'reverted') quarantineKeys(w.id, liveKeys, 'a receipt with status 0')
				else if (outcome === 'refused') {
					const n = (labFailStreak.get(streakKey) ?? 0) + 1
					labFailStreak.set(streakKey, n)
					if (n >= 2) quarantineKeys(w.id, liveKeys, `${n} refusals before broadcast`)
				}
				return outcome === 'settled'
			} catch (e: unknown) {
				logger(Colors.red(`[labMiningPoolClPayout] wallet ${w.id}: withdrawNative failed: ${(e as Error)?.message ?? e}`))
				const streakKey = live.map((x) => x.eventKey.toLowerCase()).join(',')
				const n = (labFailStreak.get(streakKey) ?? 0) + 1
				labFailStreak.set(streakKey, n)
				if (n >= 2) quarantineKeys(w.id, live.map((x) => x.eventKey.toLowerCase()), `${n} failed attempts`)
				return false
			} finally {
				h.closeScope()
			}
		} finally {
			hub.releaseClaim(w.id) // a committed slot is the reservation from here on; after an abort nothing is
		}
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] wallet ${w.id} pass error: ${(e as Error)?.message ?? e}`))
		return false
	} finally {
		h.exitTick()
		session.scheduler.poke()
	}
}

/** One wallet's loop: a pass, at once again after a pass that settled something or when a wake-up came meanwhile, otherwise after the idle wait. */
function wakePoolWallet(ws: PoolWalletState): void {
	if (!labStarted || ws.isolated) return
	if (ws.running) {
		ws.wakeQueued = true
		return
	}
	if (ws.timer !== undefined) {
		clearTimeout(ws.timer)
		ws.timer = undefined
	}
	ws.running = true
	void (async () => {
		try {
			let again = true
			while (again && labStarted && !ws.isolated) {
				ws.wakeQueued = false
				const progressed = await poolWalletPass(ws)
				again = progressed || ws.wakeQueued
				if (again) await new Promise((r) => setImmediate(r))
			}
		} finally {
			ws.running = false
			if (labStarted && !ws.isolated) ws.timer = setTimeout(() => wakePoolWallet(ws), labGate.tripped ? Math.max(60_000, resolvePayIdleMs()) : resolvePayIdleMs())
		}
	})()
}

/** Runs the payment worker once now (a scan commit or the idle timer asked for it); at most one pass at a time; continues at once after a pass that settled something. */
function wakePayWorker(): void {
	if (labPool) {
		for (const ws of labPool.wallets) wakePoolWallet(ws)
		return
	}
	if (!labStarted || !labDecoupled()) return
	if (labPayRunning) {
		labPayWakeQueued = true // the running pass will look again when it ends
		return
	}
	if (labPayTimer !== undefined) {
		clearTimeout(labPayTimer)
		labPayTimer = undefined
	}
	labPayRunning = true
	void (async () => {
		try {
			let again = true
			while (again && labStarted) {
				labPayWakeQueued = false
				const progressed = await labPayTick()
				again = progressed || labPayWakeQueued
				if (again) await new Promise((r) => setImmediate(r))
			}
		} finally {
			labPayRunning = false
			// a tripped fail-closed gate is not worth looking at every few seconds (one ALERT per minute, like the scan tick)
			if (labStarted) labPayTimer = setTimeout(() => wakePayWorker(), labGate.tripped ? Math.max(60_000, resolvePayIdleMs()) : resolvePayIdleMs())
		}
	})()
}

export function startValidatorLabMiningPoolClPayoutReporter(): void {
	if (labStarted || labWalStarting) return
	labStopRequested = false
	if (!labEnabled()) {
		logger(Colors.yellow('[labMiningPoolClPayout] disabled (set CONET_LAB_MINING_POOL_CL_PAYOUT=1)'))
		return
	}
	if (process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_FILE?.trim() && !labDecoupled()) throw new Error('[labMiningPoolClPayout] CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_FILE needs CONET_LAB_MINING_POOL_CL_PAYOUT_DECOUPLED=1')
	if (labDecoupled() && !labWalMode()) throw new Error('[labMiningPoolClPayout] CONET_LAB_MINING_POOL_CL_PAYOUT_DECOUPLED=1 needs WAL mode (CONET_LAB_MINING_POOL_CL_PAYOUT_WAL=1): the decoupled actors share the log')
	if (!loadManifestIfNeeded(true)) return
	// Refuses to start when another live process holds the state dir (throws, daemon exits).
	assertPinnedRedeem(process.env.CONET_VALIDATOR_DEPOSIT_REDEEM, CONET_VALIDATOR_DEPOSIT_REDEEM)
	labStateLock = acquireStateDirLock(resolveSegmentedStateDir())
	// S4: start-up alignment (initLabSessionState / the WAL session's alignment) is only legal before any tick has begun; a tick already running here is a bug, not a race to tolerate
	if (labInFlight) throw new Error('[labMiningPoolClPayout] start while a tick is running')
	if (labWalMode()) {
		labWalStarting = startWalMode().finally(() => {
			labWalStarting = null
		})
		return
	}
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
			`[labMiningPoolClPayout] starting dual-cursor+withdrawNative pubkeys=${labPubkeySet.size} tickMode=continuous idleBackoffMs=${resolveTickMs()} (TICK_MS: wait after an idle/fault/skipped tick only, a working tick is followed at once) ` +
				`${startupConfigLine()} ` +
				`realtimeReserved=${resolveRealtimeReservedBatches()} ` +
				`rpcHttpTimeoutMs=${resolveRpcHttpTimeoutMs()} txWaitTimeoutMs=${resolveTxWaitTimeoutMs()} pendingPool=on`
		)
	)
	labLoop.start()
}

const walLog = (line: string): void => logger(line.includes('ALERT') ? Colors.red(line) : Colors.cyan(line))

/** Snapshot cadence and the consumed prune of the WAL mode; the same cap and cold archive the legacy path uses. */
function resolveSnapshotConfig(): SnapshotConfig {
	const i = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_SNAPSHOT_INTERVAL_MS)
	const b = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_SNAPSHOT_MAX_BYTES)
	return {
		intervalMs: Number.isFinite(i) && i >= 1 ? Math.floor(i) : undefined,
		walMaxBytes: Number.isFinite(b) && b >= 1 ? Math.floor(b) : undefined,
		consumedCap: resolveConsumedKeysPersistMax(),
		archive: (keys) => void appendConsumedArchive(consumedArchiveDir(resolveStateFile()), keys),
	}
}

/** Test seam: pause the WAL session open this many ms (default none) so the stop-while-opening race is hit deterministically. */
function resolveWalOpenPauseMs(): number | undefined {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_OPEN_PAUSE_MS)
	return Number.isFinite(n) && n > 0 ? Math.min(5000, Math.floor(n)) : undefined
}

/** Test/ops tunable: refuse (fatally) any single log event above this many bytes; unset = the log's 16 MiB. */
function resolveWalMaxFrameBytes(): number | undefined {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_MAX_FRAME_BYTES)
	return Number.isFinite(n) && n >= 256 ? Math.floor(n) : undefined
}

/**
 * P4 start-up: load the pool file (if any), match the wallet slots in the recovered state against it and migrate a legacy single in-flight record into the slot of the wallet it belongs to
 * (the wallet of its line whose address is the old single SIGNER_ADDRESS). A slot of a wallet that is not in the file, a legacy record without exactly one matching wallet, or slots present
 * while no pool file is given REFUSE the start (fail-closed; nothing is guessed). The refusal names the record and points at the offline in-flight resolver.
 */
type PoolPlan = { cfg: PoolConfig; migrate?: { wallet: PoolWallet; legacy: Record<string, unknown> } }
/**
 * The refusals of the pool start-up as a pure check on the recovered core (nothing is written): run BEFORE a version 2 state is converted to version 3, so a refused start leaves the plain
 * version 2 directory exactly as it was (an old build can still start from it).
 */
function planPools(core: LabPayoutStateCore): PoolPlan | undefined {
	const file = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_FILE?.trim()
	if (!file) {
		if (core.slotCount > 0) throw new Error(`wallet slots hold in-flight batches (${[...core.slotEntries()].map(([w]) => w).join(',')}) but no pool file is configured; resolve them with the offline in-flight resolver or configure the pools`)
		return undefined
	}
	const minRaw = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_MIN_ACTIVE)
	const cfg = loadPoolConfig(file, { minActive: Number.isInteger(minRaw) && minRaw >= 1 ? minRaw : 2 })
	resolveMinVdrBalanceReserveWei() // required in pool mode, no default
	const ids = new Set(cfg.wallets.map((w) => w.id))
	for (const [w] of core.slotEntries()) if (!ids.has(w)) throw new Error(`the state holds an in-flight slot of wallet ${w}, which is not in the pool file (sha256 ${cfg.sha256}); refusing to start`)
	const legacy = core.getInFlight() as Record<string, unknown> | null
	if (!legacy) return { cfg }
	const addr = (process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS ?? '').trim().toLowerCase()
	const oldKeyArray = (process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY ?? '').trim()
	// the record's idempotency key was derived from the old key array: only the wallet with the SAME address and key array can resume it (any other would refuse the resume before any send)
	const cands = cfg.wallets.filter((w) => w.line === legacy.line && w.address.toLowerCase() === addr && w.keyArray === oldKeyArray)
	if (cands.length !== 1) {
		throw new Error(
			`a legacy single in-flight record (idempotencyKey ${String(legacy.idempotencyKey)}, line ${String(legacy.line)}, ${((legacy.eventKeys as unknown[]) ?? []).length} event keys, signer address ${addr || 'unset'}) matches ${cands.length} wallet(s) of the pool file by line, the old SIGNER_ADDRESS and the old KEY_ARRAY (${oldKeyArray || 'unset'}); refusing to start. Resolve it with the offline in-flight resolver first`
		)
	}
	return { cfg, migrate: { wallet: cands[0]!, legacy } }
}

/** P4 start-up after the session is open: migrate a legacy single in-flight record into its wallet's slot (two commits: the slot first, then the legacy record is cleared; a crash between them is repaired by the same code on the next start) and create the wallet loops. */
async function setupPools(session: NonNullable<typeof labWalSession>, plan: PoolPlan | undefined): Promise<void> {
	if (!plan) return
	const { cfg, migrate } = plan
	if (migrate) {
		if (process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_DRY_RUN === '1') {
			logger(Colors.cyan(`[labMiningPoolClPayout] pools dry-run: the legacy in-flight record ${String(migrate.legacy.idempotencyKey)} would move into the slot of wallet ${migrate.wallet.id}; nothing was changed`))
			process.exit(0)
		}
		const h = session.hub.actor(`pay:${migrate.wallet.id}`)
		h.setSlot(migrate.wallet.id, migrate.legacy)
		await h.commit('intent')
		const old = session.handle
		old.enterTick()
		try {
			old.delScalar('inFlightWithdraw')
			await old.commit('scalars')
		} finally {
			old.exitTick()
		}
		logger(Colors.cyan(`[labMiningPoolClPayout] migrated the legacy in-flight record ${String(migrate.legacy.idempotencyKey)} into the slot of wallet ${migrate.wallet.id}`))
	}
	labPool = { cfg, wallets: cfg.wallets.map((w) => ({ w, running: false, wakeQueued: false, passes: 0, settledBatches: 0 })) }
	logger(Colors.cyan(`[labMiningPoolClPayout] pools: ${cfg.wallets.map((w) => `${w.id}(${w.line},${w.state})`).join(' ')} file sha256=${cfg.sha256}`))
}

/** WAL-mode start: recover (or bootstrap) the state, then the same start check and first tick as the legacy path. A failure refuses to start (exit 1). */
async function startWalMode(): Promise<void> {
	let poolPlan: PoolPlan | undefined
	try {
		labWalSession = await openWalSession({
			stateDir: resolveSegmentedStateDir(),
			legacyStateFile: resolveStateFile(),
			scanFloor: resolveLabScanFloorBlock(),
			log: walLog,
			maxFrameBytes: resolveWalMaxFrameBytes(),
			snapshot: resolveSnapshotConfig(),
			openPauseMs: resolveWalOpenPauseMs(),
			beforeConvert: (core) => void (poolPlan = planPools(core)),
		})
		sessionBackfillFloor = labWalSession.sessionBackfillFloor
		await setupPools(labWalSession, poolPlan)
		if (labStopRequested) {
			logger(Colors.yellow('[labMiningPoolClPayout] stop requested while the WAL session was opening; no tick is started (the shutdown converts the opened session)'))
			return
		}
		if (shouldStopAfterSettled(labWalSession.settledBatchCount, resolveMaxSettledBatches())) {
			logger(Colors.cyan('[labMiningPoolClPayout] MAX_SETTLED_BATCHES already reached at start; exiting 0 before any tick'))
			process.exit(await gracefulStopWalSession(labWalSession, { stateDir: resolveSegmentedStateDir(), tickIdle: true, log: walLog }))
		}
		labStarted = true
		logger(
			Colors.cyan(
				`[labMiningPoolClPayout] starting dual-cursor+withdrawNative pubkeys=${labPubkeySet.size} tickMode=continuous idleBackoffMs=${resolveTickMs()} (TICK_MS: wait after an idle/fault/skipped tick only, a working tick is followed at once) ` +
					`${startupConfigLine()} ` +
					`realtimeReserved=${resolveRealtimeReservedBatches()} ` +
					`rpcHttpTimeoutMs=${resolveRpcHttpTimeoutMs()} txWaitTimeoutMs=${resolveTxWaitTimeoutMs()} pendingPool=on` +
					(labDecoupled() ? ` decoupled=on payIdleMs=${resolvePayIdleMs()}` : '')
			)
		)
		labLoop.start()
		if (labDecoupled()) wakePayWorker()
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] WAL start refused: ${(e as Error)?.message ?? e}`))
		process.exit(1)
	}
}

export function stopValidatorLabMiningPoolClPayoutReporter(): void {
	// first: nothing may be re-armed any more; a tick that is running now finishes (labInFlight) without re-arming
	labLoop.stop()
	labStopRequested = true
	labStarted = false
	labSessionState = undefined
	sessionBackfillFloor = undefined
	labPhaseLogged = false
	if (labPayTimer !== undefined) {
		clearTimeout(labPayTimer)
		labPayTimer = undefined
	}
	for (const ws of labPool?.wallets ?? []) {
		if (ws.timer !== undefined) clearTimeout(ws.timer)
		ws.timer = undefined
	}
}

/** Persist listening checkpoint before process exit (next restart backfills from lastListeningEndBlock+1). */
export async function flushLabMiningPoolListeningCheckpoint(opts: { tickIdle?: boolean } = {}): Promise<number> {
	if (labRpcBudget) logger(Colors.cyan(`[labMiningPoolClPayout] rpc budget total=${labRpcBudget.total} min=${labRpcBudget.minPerSource} ${JSON.stringify(labRpcBudget.stats())}`))
	if (labWalSession) {
		const s = labWalSession
		const tickIdle = opts.tickIdle ?? (!labInFlight && !labPayInFlight && !(labPool?.wallets.some((w) => w.running) ?? false))
		try {
			if (tickIdle) {
				s.handle.requireIdle() // a tick that is still running means no write in parallel with it
				const provider = createLabRpcProvider()
				const liveHead = Number(await provider.getBlockNumber())
				if (Number.isFinite(liveHead)) tryPersistListeningCheckpoint(s.handle, liveHead)
			}
		} catch {
			/* best effort: the checkpoint only saves a re-scan; the graceful stop below decides the exit code */
		}
		const code = await gracefulStopWalSession(s, { stateDir: resolveSegmentedStateDir(), tickIdle, log: walLog })
		if (code === 0) labWalSession = undefined
		return code
	}
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
	return 0
}

/** Bounded idle wait so SIGTERM cannot hang forever behind a stuck tx.wait. */
export async function waitForLabMiningPoolClPayoutIdle(maxWaitMs = 90_000, opts: { exceptPay?: boolean } = {}): Promise<boolean> {
	const started = Date.now()
	while (labInFlight || (!opts.exceptPay && (labPayInFlight || labPayRunning || (labPool?.wallets.some((w) => w.running) ?? false)))) {
		if (Date.now() - started >= maxWaitMs) {
			logger(
				Colors.red(
					`[labMiningPoolClPayout] idle wait timeout ${maxWaitMs}ms (labInFlight still true); continuing shutdown`
				)
			)
			return false
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	return true
}

/**
 * The shutdown sequence of the daemon (SIGINT/SIGTERM and the E2E child): stop the scheduler first, wait (bounded) for the tick that is running, then persist. In WAL mode a tick that did not end
 * in time gets no downgrade snapshot (exit 1, log kept). Returns the process exit code.
 */
export async function shutdownLabMiningPoolClPayout(maxWaitMs = 90_000): Promise<number> {
	stopValidatorLabMiningPoolClPayoutReporter()
	if (labWalStarting) await labWalStarting.catch(() => undefined) // a start still opening its session finishes first (and starts no tick, see labStopRequested)
	const idle = await waitForLabMiningPoolClPayoutIdle(maxWaitMs)
	return flushLabMiningPoolListeningCheckpoint({ tickIdle: idle })
}
