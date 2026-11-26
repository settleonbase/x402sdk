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

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
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
	type SignerControlState,
	type SettleIntent,
	StateWriteUncertainError,
	applyReorgRollback,
	attachIntentToState,
	atomicWriteState,
	commitScanProgress,
	fixBoundaryAtStart,
	isHistoricalComplete,
	needsSpanSkip,
	skipHistoricalOverSpans,
	markIntentBroadcast,
	markIntentConfirmed,
	markIntentReplacedFailed,
	markIntentUncertain,
	migrateLegacyToDualCursor,
	planFlushOrder,
	planScanRanges,
	nextRebuildSeq,
	prepareRebuiltSettleIntent,
	prepareSettleIntent,
	rebuildSignerTxFromIntent,
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
	/** Flush job watchdog cap in ms (test only; production reads CONET_VALIDATOR_CL_FLUSH_JOB_WATCHDOG_MS). */
	flushJobWatchdogMs?: number
	/** Observe every committed scan window (test only). */
	onScanCommit?: (rec: { line: ScanLine; from: number; okThrough: number }) => void
	/** Observe a history skip over a realtime span (test only). */
	onSpanSkip?: (rec: { from: number; to: number }) => void
}
let flushTestHooks: FlushTestHooks = {}
export function __setFlushTestHooks(h: FlushTestHooks | null): void {
	flushTestHooks = h ?? {}
}

/** Stage-1 candidate remains hard-disabled; activation requires a separately reviewed source change. */
const CLAIM_REAL_SIGNER_TRANSPORT_ENABLED = false

function signerTransportAvailable(): boolean {
	return typeof flushTestHooks.signerSend === 'function' || CLAIM_REAL_SIGNER_TRANSPORT_ENABLED
}

async function sendSignerTx(tx: VdrSignerTx, socketPath: string): Promise<{ hash: string }> {
	if (flushTestHooks.signerSend) return flushTestHooks.signerSend(tx)
	if (!CLAIM_REAL_SIGNER_TRANSPORT_ENABLED) {
		throw new Error('SIGNER_TRANSPORT_DISABLED_IN_THIS_CANDIDATE')
	}
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

async function requireClaimChain(provider: ethers.JsonRpcProvider): Promise<void> {
	let network: ethers.Network
	try {
		network = await provider.getNetwork()
	} catch {
		throw new Error('RPC_CHAIN_ID_UNKNOWN')
	}
	if (network.chainId !== 224422n) throw new Error('RPC_CHAIN_ID_MISMATCH')
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
let stateWriteUncertain: StateWriteUncertainError | null = null
// Process-local cache version only. It is not a durable commit credential.
let reporterCacheVersion = 0
// True only when this process's latest cached object came from a successful atomicWriteState return.
let reporterCacheHasDurableWriteProof = false
/** Merge queue: every ledger write runs one at a time, each on the latest committed state. */
let stateQueue: Promise<unknown> = Promise.resolve()
type StateWriterLease = {
	readonly filePath: string
	readonly parentPath: string
	readonly parentDev: number
	readonly parentIno: number
	readonly lockDev: number
	readonly lockIno: number
	readonly ownerDev: number
	readonly ownerIno: number
	ledgerDev: number | null
	ledgerIno: number | null
	updateLedgerIdentity(): void
	readonly lockDir: string
	readonly ownerPath: string
	readonly ownerText: string
	release(): void
}
let residentStateWriterLease: StateWriterLease | null = null
let activeStateWriterLease: StateWriterLease | null = null
let residentWriterAcceptingMutations = false
const activeReporterJobs = new Set<Promise<void>>()
let reporterStopPromise: Promise<void> | null = null
let reporterStopping = false

/**
 * Candidate-local cross-process writer exclusion. The lock directory is adjacent to the canonical ledger path,
 * created atomically and deliberately left behind after a crash or uncertain write; stale locks require manual
 * recovery. Older binaries do not honor this lock, so this is not evidence that an uncoordinated old writer is absent.
 */
function acquireStateWriterLease(filePath: string): StateWriterLease {
	const absolute = path.resolve(filePath)
	const parent = fs.realpathSync(path.dirname(absolute))
	const parentStat = fs.statSync(parent)
	const canonicalFile = path.join(parent, path.basename(absolute))
	let ledgerIdentity: { dev: number; ino: number } | null = null
	try {
		const fileStat = fs.lstatSync(canonicalFile)
		if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) throw new Error('STATE_PATH_NOT_REGULAR_OR_UNIQUE')
		ledgerIdentity = { dev: fileStat.dev, ino: fileStat.ino }
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
	}
	const lockDir = path.join(parent, `.${path.basename(canonicalFile)}.claim-writer-lock`)
	try {
		fs.mkdirSync(lockDir, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
			throw new Error('STATE_WRITER_LOCKED; existing lock is never auto-cleared')
		}
		throw error
	}
	const token = randomBytes(32).toString('hex')
	const ownerPath = path.join(lockDir, 'owner.json')
	const ownerText = JSON.stringify({ pid: process.pid, token, ledger: canonicalFile }) + '\n'
	let fd: number | undefined
	let lockIdentity: { dev: number; ino: number } | undefined
	let ownerIdentity: { dev: number; ino: number } | undefined
	try {
		const lockFd = fs.openSync(lockDir, 'r')
		try {
			const lockFdStat = fs.fstatSync(lockFd)
			lockIdentity = { dev: lockFdStat.dev, ino: lockFdStat.ino }
		} finally { fs.closeSync(lockFd) }
		fd = fs.openSync(ownerPath, 'wx', 0o600)
		const ownerStat = fs.fstatSync(fd)
		ownerIdentity = { dev: ownerStat.dev, ino: ownerStat.ino }
		const lockStat = fs.lstatSync(lockDir)
		const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1
		if (!ownerStat.isFile() || ownerStat.nlink !== 1 || (ownerStat.mode & 0o777) !== 0o600 ||
			(euid >= 0 && ownerStat.uid !== euid) || lockStat.isSymbolicLink() || !lockStat.isDirectory() ||
			(lockStat.mode & 0o777) !== 0o700 || (euid >= 0 && lockStat.uid !== euid)) {
			throw new Error('STATE_WRITER_LOCK_MODE_OR_IDENTITY_INVALID')
		}
		fs.writeFileSync(fd, ownerText, 'utf8')
		fs.fsyncSync(fd)
		fs.closeSync(fd)
		fd = undefined
		const lockDirFd = fs.openSync(lockDir, 'r')
		try { fs.fsyncSync(lockDirFd) } finally { fs.closeSync(lockDirFd) }
		const parentFd = fs.openSync(parent, 'r')
		try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
	} catch (error) {
		if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* preserve cause */ } }
		// Keep the exclusive directory as a fail-closed recovery marker.
		throw new Error('STATE_WRITER_LOCK_SETUP_UNCERTAIN; lock retained', { cause: error })
	}
	let released = false
	if (!lockIdentity || !ownerIdentity) throw new Error('STATE_WRITER_LOCK_IDENTITY_UNAVAILABLE; lock retained')
	const assertOwned = (): void => {
		if (fs.realpathSync(path.dirname(canonicalFile)) !== parent) throw new Error('STATE_WRITER_PARENT_REBOUND; lock retained')
		const currentParent = fs.statSync(parent)
		const lockNow = fs.lstatSync(lockDir)
		const ownerNow = fs.lstatSync(ownerPath)
		if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino ||
			lockNow.dev !== lockIdentity.dev || lockNow.ino !== lockIdentity.ino || !lockNow.isDirectory() || lockNow.isSymbolicLink() || (lockNow.mode & 0o777) !== 0o700 ||
			ownerNow.dev !== ownerIdentity.dev || ownerNow.ino !== ownerIdentity.ino || !ownerNow.isFile() || ownerNow.isSymbolicLink() || (ownerNow.mode & 0o777) !== 0o600 ||
			fs.readFileSync(ownerPath, 'utf8') !== ownerText) {
			throw new Error('STATE_WRITER_OWNERSHIP_UNKNOWN; lock retained')
		}
		try {
			const ledgerNow = fs.lstatSync(canonicalFile)
			if (!ledgerNow.isFile() || ledgerNow.isSymbolicLink() || ledgerNow.nlink !== 1 ||
				ledgerNow.dev !== ledgerIdentity?.dev || ledgerNow.ino !== ledgerIdentity?.ino) {
				throw new Error('STATE_WRITER_LEDGER_IDENTITY_CHANGED; lock retained')
			}
		} catch (error) {
			if (!ledgerIdentity && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return
			throw error
		}
	}
	return {
		filePath: canonicalFile,
		parentPath: parent,
		parentDev: parentStat.dev,
		parentIno: parentStat.ino,
		lockDev: lockIdentity.dev,
		lockIno: lockIdentity.ino,
		ownerDev: ownerIdentity.dev,
		ownerIno: ownerIdentity.ino,
		ledgerDev: ledgerIdentity?.dev ?? null,
		ledgerIno: ledgerIdentity?.ino ?? null,
		updateLedgerIdentity(): void {
			const st = fs.lstatSync(canonicalFile)
			if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('STATE_WRITER_LEDGER_NOT_REGULAR_OR_UNIQUE')
			ledgerIdentity = { dev: st.dev, ino: st.ino }
			this.ledgerDev = st.dev
			this.ledgerIno = st.ino
		},
		lockDir,
		ownerPath,
		ownerText,
		release(): void {
			if (released) throw new Error('STATE_WRITER_LOCK_RELEASE_DUPLICATE')
			assertOwned()
			const lockStat = fs.lstatSync(lockDir)
			const ownerStat = fs.lstatSync(ownerPath)
			if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || (lockStat.mode & 0o777) !== 0o700 ||
				!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1 || (ownerStat.mode & 0o777) !== 0o600 ||
				fs.readFileSync(ownerPath, 'utf8') !== ownerText) {
				throw new Error('STATE_WRITER_LOCK_OWNERSHIP_UNKNOWN; lock retained')
			}
			fs.unlinkSync(ownerPath)
			fs.rmdirSync(lockDir)
			released = true
			const parentFd = fs.openSync(parent, 'r')
			try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
		},
	}
}

function assertStateWriterLeaseCurrent(): void {
	const lease = activeStateWriterLease ?? residentStateWriterLease
	if (!lease) return
	const parent = fs.realpathSync(path.dirname(lease.filePath))
	const parentStat = fs.statSync(lease.parentPath)
	const lockStat = fs.lstatSync(lease.lockDir)
	const ownerStat = fs.lstatSync(lease.ownerPath)
	const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1
	if (parent !== lease.parentPath || parentStat.dev !== lease.parentDev || parentStat.ino !== lease.parentIno ||
		lockStat.dev !== lease.lockDev || lockStat.ino !== lease.lockIno || !lockStat.isDirectory() || lockStat.isSymbolicLink() || (lockStat.mode & 0o777) !== 0o700 ||
		(euid >= 0 && lockStat.uid !== euid) || ownerStat.dev !== lease.ownerDev || ownerStat.ino !== lease.ownerIno || !ownerStat.isFile() || ownerStat.isSymbolicLink() ||
		(ownerStat.mode & 0o777) !== 0o600 || (euid >= 0 && ownerStat.uid !== euid) ||
		fs.readFileSync(lease.ownerPath, 'utf8') !== lease.ownerText) {
		throw new Error('STATE_WRITER_OWNERSHIP_UNKNOWN')
	}
	try {
		const ledgerStat = fs.lstatSync(lease.filePath)
		if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1 ||
			ledgerStat.dev !== lease.ledgerDev || ledgerStat.ino !== lease.ledgerIno) {
			throw new Error('STATE_WRITER_LEDGER_IDENTITY_CHANGED')
		}
	} catch (error) {
		if (lease.ledgerDev === null && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return
		throw error
	}
}

function resolveStateFile(): string {
	if (residentStateWriterLease) return residentStateWriterLease.filePath
	const configured = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-validator-cl-reward-payout-state.json')
	const absolute = path.resolve(configured)
	const parent = fs.realpathSync(path.dirname(absolute))
	const canonical = path.join(parent, path.basename(absolute))
	try {
		const st = fs.lstatSync(canonical)
		if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('STATE_PATH_NOT_REGULAR_OR_UNIQUE')
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
	}
	return canonical
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
	'signerControl',
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
const STATE_SIGNER_CONTROL_KEYS = new Set(['stop', 'permit'])
const STATE_SIGNER_PERMIT_KEYS = new Set(['id', 'status', 'intentId', 'idempotencyKey', 'requestFingerprint', 'replaces'])
const STATE_SIGNER_REPLACEMENT_KEYS = new Set(['idempotencyKey', 'txHash', 'requestFingerprint'])
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

function checkSignerControl(raw: unknown): void {
	if (!isPlainRecord(raw)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'signerControl must be an object')
	checkUnknownKeys(raw, STATE_SIGNER_CONTROL_KEYS, 'STATE_SIGNER_CONTROL_INVALID', 'signerControl')
	if (typeof raw.stop !== 'boolean') stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'signerControl.stop must be boolean')
	if (raw.permit === undefined) return
	const permit = raw.permit
	if (!isPlainRecord(permit)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'signerControl.permit must be an object')
	checkUnknownKeys(permit, STATE_SIGNER_PERMIT_KEYS, 'STATE_SIGNER_CONTROL_INVALID', 'signerControl.permit')
	if (typeof permit.id !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(permit.id)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.id invalid')
	if (permit.status !== 'available' && permit.status !== 'consumed') stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.status invalid')
	if (typeof permit.intentId !== 'string' || !/^intent:[A-Za-z0-9._:-]{1,96}$/.test(permit.intentId)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.intentId invalid')
	if (typeof permit.idempotencyKey !== 'string' || !/^vdr-settle:0x[0-9a-fA-F]{64}$/.test(permit.idempotencyKey)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.idempotencyKey invalid')
	if (!isHex32NonZero(permit.requestFingerprint)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.requestFingerprint invalid')
	if (permit.replaces !== undefined) {
		const replaces = permit.replaces
		if (!isPlainRecord(replaces)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.replaces must be an object')
		checkUnknownKeys(replaces, STATE_SIGNER_REPLACEMENT_KEYS, 'STATE_SIGNER_CONTROL_INVALID', 'signerControl.permit.replaces')
		if (typeof replaces.idempotencyKey !== 'string' || !/^vdr-settle:0x[0-9a-fA-F]{64}$/.test(replaces.idempotencyKey)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.replaces.idempotencyKey invalid')
		if (typeof replaces.txHash !== 'string' || !STATE_HEX32_RE.test(replaces.txHash)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.replaces.txHash invalid')
		if (!isHex32NonZero(replaces.requestFingerprint)) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'permit.replaces.requestFingerprint invalid')
	}
}

function checkSignerControlBinding(controlRaw: unknown, intentsRaw: unknown[]): void {
	if (controlRaw === undefined) return
	const control = controlRaw as SignerControlState
	const permit = control.permit
	if (!permit) return
	const intents = intentsRaw as SettleIntent[]
	const target = intents.find((item) => item.idempotencyKey === permit.idempotencyKey)
	if (permit.status === 'consumed') {
		if (!target || target.intentId !== permit.intentId || target.requestFingerprint !== permit.requestFingerprint) {
			stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'consumed permit has no matching durable intent')
		}
		return
	}
	if (target) stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'available permit target intent already exists')
	if (permit.replaces) {
		const replaced = intents.find((item) => item.idempotencyKey === permit.replaces!.idempotencyKey)
		if (!replaced || !OPEN_INTENT_STATUSES.has(replaced.status) || replaced.txHash !== permit.replaces.txHash ||
			replaced.requestFingerprint !== permit.replaces.requestFingerprint) {
			stateRefuse('STATE_SIGNER_CONTROL_INVALID', 'available replacement permit owner does not match live intent')
		}
	}
}

/**
 * Span and retired-boundary bookkeeping lives inside metrics (unknown metrics fields are tolerated by older loaders).
 * Spans must be sorted, disjoint, non-empty and at or below the current boundary; a span needs a boundary.
 */
function checkSpanMetrics(raw: Record<string, unknown>, boundaryH: number | null): void {
	const m = raw.metrics
	if (!isPlainRecord(m)) return
	if (m.realtimeSpans !== undefined) {
		if (!Array.isArray(m.realtimeSpans)) stateRefuse('STATE_SPAN_INVALID', 'metrics.realtimeSpans must be an array')
		let prevTo = -1
		m.realtimeSpans.forEach((s: unknown, i: number) => {
			const at = `metrics.realtimeSpans[${i}]`
			if (!isPlainRecord(s)) stateRefuse('STATE_SPAN_INVALID', `${at} is not an object`)
			checkUnknownKeys(s, new Set(['from', 'to']), 'STATE_SPAN_INVALID', at)
			const from = s.from
			const to = s.to
			if (!isIntAtLeast(from, 0) || !isIntAtLeast(to, 0) || from > to || from <= prevTo) {
				stateRefuse('STATE_SPAN_INVALID', `${at} invalid, unsorted or overlapping`)
			}
			if (boundaryH === null || to > boundaryH) stateRefuse('STATE_SPAN_INVALID', `${at} is above boundaryH or no boundaryH`)
			prevTo = to
		})
	}
	if (m.retiredBoundaries !== undefined) {
		if (!Array.isArray(m.retiredBoundaries)) stateRefuse('STATE_SPAN_INVALID', 'metrics.retiredBoundaries must be an array')
		m.retiredBoundaries.forEach((r: unknown, i: number) => {
			const at = `metrics.retiredBoundaries[${i}]`
			if (!isPlainRecord(r)) stateRefuse('STATE_SPAN_INVALID', `${at} is not an object`)
			if (
				!isIntAtLeast(r.blockNumber, 0) ||
				typeof r.blockHash !== 'string' ||
				!STATE_HEX32_RE.test(r.blockHash) ||
				!isIntAtLeast(r.historicalCursor, -1) ||
				!isIntAtLeast(r.realtimeCursor, -1) ||
				typeof r.retiredAt !== 'string'
			) {
				stateRefuse('STATE_SPAN_INVALID', `${at} invalid`)
			}
		})
	}
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
	if (raw.signerControl !== undefined) checkSignerControl(raw.signerControl)
	checkSignerControlBinding(raw.signerControl, raw.settleIntents as unknown[])
	checkSpanMetrics(raw, raw.boundaryH === null ? null : (raw.boundaryH as { blockNumber: number }).blockNumber)
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
	assertStateWriterLeaseCurrent()
	const file = resolveStateFile()
	const floor = resolveDeployBlockFloor()
	if (!fs.existsSync(file)) {
		if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ALLOW_FRESH_STATE === '1') {
			logger(Colors.yellow(`[validatorClRewardPayout] fresh state allowed (ALLOW_FRESH_STATE=1) file=${file}`))
			const fresh = migrateLegacyToDualCursor(null, floor)
			assertStateWriterLeaseCurrent()
			return fresh
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
	const loaded = migrateLegacyToDualCursor(raw as LegacyClPayoutState, floor)
	assertStateWriterLeaseCurrent()
	return loaded
}

/** Latest committed state. Synchronous: never hold the returned object across an await. */
function latestStateSync(): DualCursorState {
	assertStateWriterLeaseCurrent()
	const file = resolveStateFile()
	if (!stateCache || stateCache.file !== file) {
		stateCache = { file, state: loadState() }
		reporterCacheVersion += 1
		reporterCacheHasDurableWriteProof = false
		invalidatePreaggregatedProjection('cache-load')
	}
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
		const resident = residentStateWriterLease
		if (resident && !residentWriterAcceptingMutations) throw new Error('STATE_WRITER_DRAINING')
		const transient = resident === null
		const lease = resident ?? acquireStateWriterLease(resolveStateFile())
		if (transient) activeStateWriterLease = lease
		let preserveLease = false
		let primaryError: unknown
		try {
			if (stateWriteUncertain) throw stateWriteUncertain
			assertStateWriterLeaseCurrent()
			// One-off harness writers reload under the cross-process lock; the resident owns the ledger for its full life.
			if (transient) {
				stateCache = null
				invalidatePreaggregatedProjection('cross-process-lock-refresh')
			}
			// Any mutator entry may alter the current object; revoke preaggregation before calling it.
			reporterCacheHasDurableWriteProof = false
			reporterCacheVersion += 1
			invalidatePreaggregatedProjection('mutation-start')
			const base = latestStateSync()
			const next = fn(base)
			if (next === base) return base
			const file = lease.filePath
			const committed: DualCursorState = {
				...next,
				lastProcessedBlock: next.historicalCursor,
				updatedAt: new Date().toISOString(),
			}
			try {
				atomicWriteState(file, committed)
				lease.updateLedgerIdentity()
			} catch (error) {
				reporterCacheHasDurableWriteProof = false
				invalidatePreaggregatedProjection('write-uncertain')
				stateWriteUncertain = error instanceof StateWriteUncertainError
					? error
					: new StateWriteUncertainError('state write failed; future writes are blocked', false, { cause: error })
				preserveLease = true
				if (transient) residentStateWriterLease = lease
				throw stateWriteUncertain
			}
			stateCache = { file, state: committed }
			reporterCacheVersion += 1
			reporterCacheHasDurableWriteProof = true
			invalidatePreaggregatedProjection('commit')
			return committed
		} catch (error) {
			primaryError = error
			throw error
		} finally {
			if (transient && !preserveLease) {
				try {
					lease.release()
				} catch (releaseError) {
					stateWriteUncertain = new StateWriteUncertainError('writer lock release uncertain; future writes are blocked', true, { cause: releaseError })
					residentStateWriterLease = lease
					if (primaryError === undefined) throw stateWriteUncertain
				} finally {
					activeStateWriterLease = null
				}
			}
		}
	})
}

function hasAvailableSyntheticSignerPermit(state: DualCursorState): boolean {
	const control = state.signerControl
	return Boolean(
		signerTransportAvailable() && control && control.stop === false && control.permit?.status === 'available'
	)
}

function availablePermitReplacesIntent(state: DualCursorState, intent: SettleIntent): boolean {
	const control = state.signerControl
	const permit = control?.permit
	return Boolean(
		signerTransportAvailable() && control?.stop === false && permit?.status === 'available' && permit.replaces &&
		permit.replaces.idempotencyKey === intent.idempotencyKey &&
		permit.replaces.txHash === intent.txHash &&
		permit.replaces.requestFingerprint === intent.requestFingerprint
	)
}

function hasConsumedPermitForIntent(state: DualCursorState, idempotencyKey: string): boolean {
	const control = state.signerControl
	const permit = control?.permit
	if (!signerTransportAvailable() || control?.stop !== false || !permit || permit.status !== 'consumed' || permit.idempotencyKey !== idempotencyKey) return false
	const intent = state.settleIntents.find((item) => item.idempotencyKey === idempotencyKey)
	return Boolean(
		intent && intent.intentId === permit.intentId && intent.requestFingerprint === permit.requestFingerprint
	)
}

function canContinuePaymentRead(state: DualCursorState): boolean {
	const permit = state.signerControl?.permit
	return Boolean(permit && permit.status === 'consumed' && hasConsumedPermitForIntent(state, permit.idempotencyKey))
}

async function mutatePaymentState(
	fn: (latest: DualCursorState) => DualCursorState,
	intent: SettleIntent
): Promise<{ state: DualCursorState; allowed: boolean }> {
	let allowed = false
	const state = await mutateState((latest) => {
		const control = latest.signerControl
		const permit = control?.permit
		if (!signerTransportAvailable() || control?.stop !== false || !permit || permit.status !== 'consumed' ||
			permit.intentId !== intent.intentId || permit.idempotencyKey !== intent.idempotencyKey ||
			permit.requestFingerprint !== intent.requestFingerprint || !hasConsumedPermitForIntent(latest, intent.idempotencyKey)) return latest
		allowed = true
		return fn(latest)
	})
	return { state, allowed }
}

/** Re-read the ledger file inside the queue (tick start, harness). Fail-closed: loadState throws on any problem. */
function refreshStateFromDisk(): Promise<DualCursorState> {
	return enqueueStateJob(() => {
		const resident = residentStateWriterLease
		const transient = resident === null
		const lease = resident ?? acquireStateWriterLease(resolveStateFile())
		if (transient) activeStateWriterLease = lease
		let result: DualCursorState | undefined
		let primaryError: unknown
		try {
			assertStateWriterLeaseCurrent()
			stateCache = null
			invalidatePreaggregatedProjection('refresh')
			result = latestStateSync()
		} catch (error) {
			primaryError = error
		}
		if (transient) {
			try {
				lease.release()
			} catch (error) {
				stateWriteUncertain = new StateWriteUncertainError('writer lock release uncertain after refresh', false, { cause: error })
				residentStateWriterLease = lease
				primaryError ??= stateWriteUncertain
			} finally {
				activeStateWriterLease = null
			}
		}
		if (primaryError !== undefined) throw primaryError
		if (!result) throw new Error('STATE_REFRESH_RESULT_UNKNOWN')
		return result
	})
}

/**
 * Bounded, read-only projection for isolated engineering proof only. This is not a
 * service endpoint and deliberately refuses cache misses: its queue callback must
 * never call loadState()/latestStateSync(), perform disk I/O, or touch RPC/signer.
 */
const QUEUE_PROJECTION_MAX_PENDING = 4096
const QUEUE_PROJECTION_MAX_INTENTS = 4096
const QUEUE_PROJECTION_MAX_OWNER_KEYS = 4096
let engProjectionExpiredLateCallbacks = 0

type QueueProjectionLane = {
	pending: number
	openOwned: number
	structurallyAvailable: number
	selectedWithinQuota: number
	outsideQuota: number
	quotaSlots: number
	postPlanUnselectableCount: null
	postPlanUnselectableStatus: 'unknown'
}

export type ClaimQueueProjection =
	| {
			status: 'ok'
			source: 'reporter_state_queue_cache' | 'reporter_preaggregated_synthetic_snapshot'
			generation: number
			committedAt: string
			boundaryBlockNumber: number | null
			boundaryHashPresent: boolean
			historicalCursor: number
			realtimeCursor: number
			pendingCount: number
			openIntentCount: number
			realtime: QueueProjectionLane
			historical: QueueProjectionLane
			legacyPaymentFinality: 'unknown_hold'
		}
	| { status: 'unknown'; reason: string }

type SyntheticProjectionProof = {
	file: string
	stateRef: DualCursorState
	cacheVersion: number
	processGeneration: number
	epoch: number
	quotaVersion: string
	identity: string
	sha256: string
	token: string
}

type PreaggregateCapture = {
	proof: SyntheticProjectionProof
	stateRef: DualCursorState
}

type PreaggregateResponse =
	| { status: 'ok'; versionToken: string; projection: ClaimQueueProjection; payability: 'unknown'; legacyPaymentFinality: 'unknown_hold' }
	| { status: 'sealed'; versionToken: string }
	| { status: 'unknown'; reason: string }
type PreaggregateResult = PreaggregateResponse | { status: 'capture'; value: PreaggregateCapture }

const PREAGGREGATE_SYNTHETIC_MAX_BYTES = 1_048_576
const PREAGGREGATE_SYNTHETIC_MAX_MS = 250
let preaggregateSyntheticMode = false
let preaggregateEpoch = 0
let preaggregateProof: SyntheticProjectionProof | null = null
let preaggregateSummary: { token: string; value: ClaimQueueProjection } | null = null
let preaggregateFlight: { token: string; promise: Promise<PreaggregateResponse> } | null = null
let preaggregateBuildGateForTest: (() => Promise<void>) | null = null

function invalidatePreaggregatedProjection(_reason: string): void {
	preaggregateEpoch += 1
	preaggregateProof = null
	preaggregateSummary = null
}

function syntheticProjectionPath(file: string): boolean {
	const root = path.resolve(tmpdir())
	const full = path.resolve(file)
	const relative = path.relative(root, full)
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) &&
		path.basename(full) === 'synthetic-state.json' &&
		path.basename(path.dirname(full)).startsWith('claim-reporter-preaggregate-')
}

function statIdentity(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; uid: bigint; nlink: bigint; mode: bigint }): string {
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.uid, stat.nlink, stat.mode].map(String).join(':')
}

function currentProjectionQuotaVersion(): string {
	return `${resolveMaxEntriesPerTx()}|${resolveRealtimeFlushQuota()}|${resolveHistoricalFlushFloor()}`
}

function withinSyntheticProjectionBudget(state: DualCursorState): boolean {
	if (state.pending.length > QUEUE_PROJECTION_MAX_PENDING || state.settleIntents.length > QUEUE_PROJECTION_MAX_INTENTS) return false
	let estimatedBytes = 1024
	let nodes = 0
	const stack: unknown[] = [state]
	while (stack.length > 0) {
		if (++nodes > 20_000) return false
		const value = stack.pop()
		if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
			estimatedBytes += 16
		} else if (typeof value === 'string') {
			estimatedBytes += value.length * 6 + 8
		} else if (Array.isArray(value)) {
			if (value.length > QUEUE_PROJECTION_MAX_PENDING + QUEUE_PROJECTION_MAX_INTENTS + QUEUE_PROJECTION_MAX_OWNER_KEYS) return false
			for (const item of value) stack.push(item)
		} else if (typeof value === 'object') {
			for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
				estimatedBytes += key.length * 6 + 8
				stack.push(item)
			}
		} else return false
		if (estimatedBytes > PREAGGREGATE_SYNTHETIC_MAX_BYTES) return false
	}
	return true
}

function deepFreezeSyntheticJson(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value !== 'object') return true
	if (seen.has(value)) return false
	seen.add(value)
	const proto = Object.getPrototypeOf(value)
	if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false
	for (const child of Object.values(value as Record<string, unknown>)) {
		if (!deepFreezeSyntheticJson(child, seen)) return false
	}
	Object.freeze(value)
	return true
}

function readSyntheticSnapshot(file: string): { status: 'ok'; bytes: Buffer; identity: string; sha256: string } | { status: 'unknown'; reason: string } {
	if (!syntheticProjectionPath(file)) return { status: 'unknown', reason: 'synthetic_path_rejected' }
	const noFollow = fs.constants.O_NOFOLLOW
	if (typeof noFollow !== 'number') return { status: 'unknown', reason: 'nofollow_unavailable' }
	let fd: number | undefined
	try {
		const canonicalParent = fs.realpathSync(path.dirname(file))
		if (canonicalParent !== path.resolve(path.dirname(file))) return { status: 'unknown', reason: 'synthetic_parent_rebound' }
		const parentStat = fs.statSync(canonicalParent, { bigint: true })
		const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : -1n
		if (uid < 0n || parentStat.uid !== uid || (parentStat.mode & 0o077n) !== 0n) return { status: 'unknown', reason: 'synthetic_parent_owner_or_mode' }
		const pathBefore = fs.lstatSync(file, { bigint: true })
		if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1n || pathBefore.uid !== uid ||
			(pathBefore.mode & 0o022n) !== 0n || pathBefore.size < 1n || pathBefore.size > BigInt(PREAGGREGATE_SYNTHETIC_MAX_BYTES)) {
			return { status: 'unknown', reason: 'snapshot_metadata_unknown' }
		}
		fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
		const fdBefore = fs.fstatSync(fd, { bigint: true })
		if (!fdBefore.isFile() || fdBefore.nlink !== 1n || fdBefore.uid !== uid || (fdBefore.mode & 0o022n) !== 0n ||
			statIdentity(fdBefore) !== statIdentity(pathBefore)) return { status: 'unknown', reason: 'snapshot_identity_mismatch' }
		const capacity = Number(fdBefore.size) + 1
		const buffer = Buffer.alloc(capacity)
		let length = 0
		while (length < capacity) {
			const read = fs.readSync(fd, buffer, length, capacity - length, null)
			if (read === 0) break
			length += read
		}
		if (length !== Number(fdBefore.size) || length > PREAGGREGATE_SYNTHETIC_MAX_BYTES) return { status: 'unknown', reason: 'snapshot_size_changed' }
		const fdAfter = fs.fstatSync(fd, { bigint: true })
		const pathAfter = fs.lstatSync(file, { bigint: true })
		if (statIdentity(fdBefore) !== statIdentity(fdAfter) || statIdentity(fdBefore) !== statIdentity(pathAfter) || pathAfter.isSymbolicLink()) {
			return { status: 'unknown', reason: 'snapshot_changed_or_rebound' }
		}
		const bytes = buffer.subarray(0, length)
		const result = { status: 'ok' as const, bytes, identity: statIdentity(fdAfter), sha256: createHash('sha256').update(bytes).digest('hex') }
		fs.closeSync(fd)
		fd = undefined
		return result
	} catch {
		return { status: 'unknown', reason: 'snapshot_read_failed' }
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd) } catch { /* a close failure is handled below by the next read gate */ }
		}
	}
}

function preaggregateUnknown(reason: string): PreaggregateResponse {
	return { status: 'unknown', reason }
}

function preaggregateOk(versionToken: string, projection: ClaimQueueProjection): PreaggregateResponse {
	return {
		status: 'ok',
		versionToken,
		projection,
		payability: 'unknown',
		legacyPaymentFinality: 'unknown_hold',
	}
}

/**
 * Test-only synthetic commit seal. The default mode remains off. It accepts no path
 * argument and only seals a just-committed file in the fixed task-temp namespace.
 */
export async function __engHarnessEnableSyntheticPreaggregationForTest(): Promise<PreaggregateResponse> {
	const captured = await enqueueStateJob(() => {
		if (stateWriteUncertain) return preaggregateUnknown('state_write_uncertain')
		if (!reporterCacheHasDurableWriteProof) return preaggregateUnknown('durable_write_proof_missing')
		const cache = stateCache
		if (!cache) return preaggregateUnknown('cache_cold')
		if (cache.file !== resolveStateFile() || !syntheticProjectionPath(cache.file)) return preaggregateUnknown('synthetic_path_rejected')
		return {
			status: 'capture' as const,
			file: cache.file,
			stateRef: cache.state,
			cacheVersion: reporterCacheVersion,
			processGeneration: bootGen,
			epoch: preaggregateEpoch,
		}
	})
	if (captured.status !== 'capture') return captured
	if (!withinSyntheticProjectionBudget(captured.stateRef)) return preaggregateUnknown('resource_bound_exceeded')
	const fileSnapshot = readSyntheticSnapshot(captured.file)
	if (fileSnapshot.status !== 'ok') return fileSnapshot
	const quotaVersion = currentProjectionQuotaVersion()
	let expectedBytes: Buffer
	try {
		expectedBytes = Buffer.from(`${JSON.stringify(captured.stateRef, null, 2)}\n`, 'utf8')
	} catch {
		return preaggregateUnknown('snapshot_serialize_failed')
	}
	if (expectedBytes.length > PREAGGREGATE_SYNTHETIC_MAX_BYTES || !expectedBytes.equals(fileSnapshot.bytes)) {
		return preaggregateUnknown('snapshot_not_same_commit')
	}
	const token = createHash('sha256')
		.update(`${fileSnapshot.identity}|${fileSnapshot.sha256}|${captured.cacheVersion}|${captured.processGeneration}|${captured.epoch + 1}|${quotaVersion}`)
		.digest('hex')
	return enqueueStateJob(() => {
		if (stateWriteUncertain) return preaggregateUnknown('state_write_uncertain')
		if (currentProjectionQuotaVersion() !== quotaVersion) return preaggregateUnknown('quota_changed')
		if (preaggregateFlight) return preaggregateUnknown('rebuild_busy')
		const current = stateCache
		if (preaggregateEpoch !== captured.epoch || bootGen !== captured.processGeneration || reporterCacheVersion !== captured.cacheVersion ||
			!current || current.state !== captured.stateRef || current.file !== captured.file || current.file !== resolveStateFile()) {
			return preaggregateUnknown('commit_changed_during_seal')
		}
		preaggregateEpoch += 1
		preaggregateSyntheticMode = true
		const proof: SyntheticProjectionProof = {
			file: captured.file,
			stateRef: captured.stateRef,
			cacheVersion: captured.cacheVersion,
			processGeneration: captured.processGeneration,
			epoch: preaggregateEpoch,
			quotaVersion,
			identity: fileSnapshot.identity,
			sha256: fileSnapshot.sha256,
			token,
		}
		preaggregateProof = proof
		preaggregateSummary = null
		return { status: 'sealed', versionToken: token }
	})
}

/** Test-only global gate for proving default-off and revocation behavior. */
export function __engHarnessDisablePreaggregationForTest(): void {
	preaggregateSyntheticMode = false
	invalidatePreaggregatedProjection('disabled')
}

/** Test-only barrier runs outside the writer queue before bounded snapshot work. */
export function __engHarnessSetPreaggregateBuildGateForTest(gate: (() => Promise<void>) | null): void {
	preaggregateBuildGateForTest = gate
}

async function buildAndPublishPreaggregate(
	capture: PreaggregateCapture,
	deadline: number,
	isExpired: () => boolean,
): Promise<PreaggregateResponse> {
	const proof = capture.proof
	const gate = preaggregateBuildGateForTest
	preaggregateBuildGateForTest = null
	const fileSnapshot = readSyntheticSnapshot(proof.file)
	if (fileSnapshot.status !== 'ok') return fileSnapshot
	if (fileSnapshot.identity !== proof.identity || fileSnapshot.sha256 !== proof.sha256) return preaggregateUnknown('snapshot_changed_or_rebound')
	let parsed: DualCursorState
	try {
		parsed = JSON.parse(fileSnapshot.bytes.toString('utf8')) as DualCursorState
	} catch {
		return preaggregateUnknown('snapshot_parse_failed')
	}
	if (!withinSyntheticProjectionBudget(parsed)) return preaggregateUnknown('resource_bound_exceeded')
	if (!deepFreezeSyntheticJson(parsed)) return preaggregateUnknown('snapshot_not_freezable')
	if (parsed.boundaryH === null && parsed.pending.some((row) => row.scanLine === undefined)) {
		return preaggregateUnknown('boundary_inference_unknown')
	}
	if (currentProjectionQuotaVersion() !== proof.quotaVersion) return preaggregateUnknown('quota_changed')
	const computed = projectCommittedQueueState({ file: proof.file, state: parsed })
	if (computed.status !== 'ok') return computed
	if (isExpired() || performance.now() >= deadline) return preaggregateUnknown('queue_timeout')
	if (gate) await gate()
	if (isExpired() || performance.now() >= deadline) return preaggregateUnknown('queue_timeout')
	const projection = Object.freeze({
		...computed,
		source: 'reporter_preaggregated_synthetic_snapshot' as const,
		realtime: Object.freeze({ ...computed.realtime }),
		historical: Object.freeze({ ...computed.historical }),
	})
	return enqueueStateJob(() => {
		if (isExpired() || performance.now() >= deadline) return preaggregateUnknown('queue_timeout')
		if (!preaggregateSyntheticMode || preaggregateEpoch !== proof.epoch) return preaggregateUnknown('projection_revoked')
		if (stateWriteUncertain) return preaggregateUnknown('state_write_uncertain')
		if (currentProjectionQuotaVersion() !== proof.quotaVersion) return preaggregateUnknown('quota_changed')
		const current = stateCache
		if (!current || current.state !== proof.stateRef || current.file !== proof.file || current.file !== resolveStateFile() ||
			reporterCacheVersion !== proof.cacheVersion || bootGen !== proof.processGeneration || preaggregateProof?.token !== proof.token) {
			return preaggregateUnknown('commit_changed_during_rebuild')
		}
		preaggregateSummary = { token: proof.token, value: projection }
		return preaggregateOk(proof.token, projection)
	})
}

/**
 * Test-only read path: stateQueue captures/checks the version in O(1); bytes are
 * read and summarized outside that queue; publication returns through a version CAS.
 */
export async function __engHarnessReadPreaggregatedProjectionForTest(opts: {
	timeoutMs?: number
	expectedVersionToken?: string
} = {}): Promise<PreaggregateResponse> {
	const requested = opts.timeoutMs ?? 100
	if (!Number.isFinite(requested) || requested < 0) return preaggregateUnknown('timeout_invalid')
	const timeoutMs = Math.max(1, Math.min(PREAGGREGATE_SYNTHETIC_MAX_MS, Math.floor(requested)))
	const deadline = performance.now() + timeoutMs
	let expired = false
	let timer: NodeJS.Timeout | undefined
	const work = (async (): Promise<PreaggregateResponse> => {
		const captured: PreaggregateResult = await enqueueStateJob(() => {
			if (expired || performance.now() >= deadline) return preaggregateUnknown('queue_timeout')
			if (!preaggregateSyntheticMode) return preaggregateUnknown('projection_disabled')
			if (stateWriteUncertain) return preaggregateUnknown('state_write_uncertain')
			const cache = stateCache
			const proof = preaggregateProof
			if (!cache || !proof) return preaggregateUnknown('snapshot_credential_missing')
			if (proof.processGeneration !== bootGen || proof.cacheVersion !== reporterCacheVersion || proof.epoch !== preaggregateEpoch ||
				proof.stateRef !== cache.state || proof.file !== cache.file || cache.file !== resolveStateFile()) {
				return preaggregateUnknown('commit_identity_unknown')
			}
		if (currentProjectionQuotaVersion() !== proof.quotaVersion) return preaggregateUnknown('quota_changed')
		if (opts.expectedVersionToken && opts.expectedVersionToken !== proof.token) return preaggregateUnknown('version_mismatch')
		if (preaggregateSummary?.token === proof.token) {
			return preaggregateOk(proof.token, preaggregateSummary.value)
		}
		if (preaggregateFlight && preaggregateFlight.token !== proof.token) return preaggregateUnknown('rebuild_busy')
		return { status: 'capture', value: { proof, stateRef: cache.state } }
		})
		if (captured.status !== 'capture') return captured
		const capture = captured.value
		if (preaggregateFlight) {
			if (preaggregateFlight.token === capture.proof.token) return preaggregateFlight.promise
			return preaggregateUnknown('rebuild_busy')
		}
		const task = buildAndPublishPreaggregate(capture, deadline, () => expired).catch(() => preaggregateUnknown('projection_build_failed'))
		preaggregateFlight = { token: capture.proof.token, promise: task }
		try {
			return await task
		} finally {
			if (preaggregateFlight?.promise === task) preaggregateFlight = null
		}
	})()
	const timeout = new Promise<PreaggregateResponse>((resolve) => {
		timer = setTimeout(() => {
			expired = true
			resolve(preaggregateUnknown('queue_timeout'))
		}, timeoutMs)
	})
	const result = await Promise.race([work, timeout])
	if (result.status !== 'ok') {
		if (timer) clearTimeout(timer)
		return result
	}
	// A shared single-flight build can finish before this caller's own timer callback
	// gets an event-loop turn. Re-check this waiter's deadline and proof at delivery.
	const delivery = enqueueStateJob(() => {
		if (expired || performance.now() >= deadline) return preaggregateUnknown('queue_timeout')
		const proof = preaggregateProof
		if (!preaggregateSyntheticMode || !proof || proof.token !== result.versionToken || preaggregateEpoch !== proof.epoch) {
			return preaggregateUnknown('projection_revoked')
		}
		if (currentProjectionQuotaVersion() !== proof.quotaVersion) return preaggregateUnknown('quota_changed')
		return result
	})
	return Promise.race([delivery, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

type SyntheticUnixReaderStart =
	| { status: 'started'; close: () => Promise<void> }
	| { status: 'unknown'; reason: string }

/**
 * Test-only, default-off Unix framing around the same reporter projection.
 * A caller must explicitly opt into synthetic mode and provide a peer verifier;
 * no production startup path calls this function.
 */
export async function __engHarnessStartSyntheticProjectionUnixReaderForTest(opts: {
	enabled: boolean
	socketPath: string
	peerVerifier: (socket: net.Socket) => boolean | Promise<boolean>
}): Promise<SyntheticUnixReaderStart> {
	if (opts.enabled !== true) return { status: 'unknown', reason: 'reader_disabled' }
	if (typeof opts.peerVerifier !== 'function') return { status: 'unknown', reason: 'peer_verifier_missing' }
	const socketPath = path.resolve(opts.socketPath)
	const parent = path.dirname(socketPath)
	const root = path.resolve(tmpdir())
	const relative = path.relative(root, parent)
	if (path.basename(socketPath) !== 'projection.sock' || relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ||
		!path.basename(parent).startsWith('claim-reporter-preaggregate-')) {
		return { status: 'unknown', reason: 'synthetic_socket_path_rejected' }
	}
	try {
		if (fs.realpathSync(parent) !== parent) return { status: 'unknown', reason: 'synthetic_socket_parent_rebound' }
		const parentStat = fs.lstatSync(parent, { bigint: true })
		const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : -1n
		if (uid < 0n || !parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== uid ||
			(parentStat.mode & 0o077n) !== 0n) return { status: 'unknown', reason: 'synthetic_socket_parent_owner_or_mode' }
		try {
			fs.lstatSync(socketPath)
			return { status: 'unknown', reason: 'synthetic_socket_path_exists' }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unknown', reason: 'synthetic_socket_path_unreadable' }
		}
	} catch {
		return { status: 'unknown', reason: 'synthetic_socket_parent_unavailable' }
	}

	let active = false
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		if (active) {
			socket.destroy()
			return
		}
		active = true
		let finished = false
		let request = Buffer.alloc(0)
		const finish = (response: Record<string, unknown>) => {
			if (finished) return
			finished = true
			clearTimeout(timer)
			const body = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8')
			if (body.length > 4096) socket.end('{"status":"unknown","reason":"response_bound_exceeded"}\n')
			else socket.end(body)
		}
		const timer = setTimeout(() => {
			finish({ status: 'unknown', reason: 'request_timeout' })
			socket.destroy()
		}, 250)
		socket.on('error', () => finish({ status: 'unknown', reason: 'socket_error' }))
		void Promise.resolve().then(() => opts.peerVerifier(socket)).then((peerOk) => {
			if (!peerOk) {
				finish({ status: 'unknown', reason: 'peer_rejected' })
				socket.destroy()
				return
			}
			socket.on('data', (chunk: Buffer) => {
				if (request.length + chunk.length > 256) {
					finish({ status: 'unknown', reason: 'request_bound_exceeded' })
					socket.destroy()
					return
				}
				request = Buffer.concat([request, chunk])
			})
			socket.on('end', () => {
				if (finished) return
				if (request.length < 2 || request[request.length - 1] !== 0x0a || request.subarray(0, -1).includes(0x0a)) {
					finish({ status: 'unknown', reason: 'request_frame_invalid' })
					return
				}
				let frame: unknown
				try { frame = JSON.parse(request.toString('utf8').slice(0, -1)) } catch {
					finish({ status: 'unknown', reason: 'request_json_invalid' })
					return
				}
				if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
					finish({ status: 'unknown', reason: 'request_shape_invalid' })
					return
				}
				const value = frame as Record<string, unknown>
				const keys = Object.keys(value).sort().join(',')
				if ((keys !== 'op,v' && keys !== 'expectedVersionToken,op,v') || value.v !== 1 || value.op !== 'read' ||
					(value.expectedVersionToken !== undefined && (typeof value.expectedVersionToken !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedVersionToken)))) {
					finish({ status: 'unknown', reason: 'request_schema_invalid' })
					return
				}
				void __engHarnessReadPreaggregatedProjectionForTest({
					timeoutMs: 200,
					expectedVersionToken: value.expectedVersionToken as string | undefined,
				}).then((result) => {
					if (result.status !== 'ok') {
						const reason = result.status === 'unknown' ? result.reason : 'projection_not_available'
						finish({ status: 'unknown', reason: /^[a-z0-9_]{1,48}$/.test(reason) ? reason : 'projection_unknown' })
						return
					}
					const p = result.projection
					if (p.status !== 'ok') {
						finish({ status: 'unknown', reason: /^[a-z0-9_]{1,48}$/.test(p.reason) ? p.reason : 'projection_unknown' })
						return
					}
					finish({
						status: 'consistent', versionToken: result.versionToken, generation: p.generation, committedAt: p.committedAt,
						boundaryBlockNumber: p.boundaryBlockNumber, boundaryHashPresent: p.boundaryHashPresent,
						historicalCursor: p.historicalCursor, realtimeCursor: p.realtimeCursor, pendingCount: p.pendingCount,
						openIntentCount: p.openIntentCount, realtime: p.realtime, historical: p.historical,
						payability: 'unknown', legacyPaymentFinality: 'unknown_hold',
					})
				}).catch(() => finish({ status: 'unknown', reason: 'projection_failed' }))
			})
		}).catch(() => finish({ status: 'unknown', reason: 'peer_verification_failed' }))
		socket.on('close', () => {
			active = false
			clearTimeout(timer)
		})
	})
	server.maxConnections = 1
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(socketPath, resolve)
		})
		fs.chmodSync(socketPath, 0o600)
		const socketStat = fs.lstatSync(socketPath, { bigint: true })
		const uid = BigInt(process.getuid!())
		if (!socketStat.isSocket() || socketStat.uid !== uid || (socketStat.mode & 0o077n) !== 0n) throw new Error('socket_identity')
		return {
			status: 'started',
			close: async () => {
				await new Promise<void>((resolve) => server.close(() => resolve()))
				try {
					const current = fs.lstatSync(socketPath, { bigint: true })
					if (current.dev === socketStat.dev && current.ino === socketStat.ino && current.isSocket()) fs.unlinkSync(socketPath)
				} catch { /* leave unknown replacements untouched */ }
			},
		}
	} catch {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		return { status: 'unknown', reason: 'socket_start_failed' }
	}
}

function unknownQueueProjection(reason: string): ClaimQueueProjection {
	return { status: 'unknown', reason }
}

function projectCommittedQueueState(cache: { file: string; state: DualCursorState }): ClaimQueueProjection {
	const state = cache.state
	if (state.version !== 2 || !Array.isArray(state.pending) || !Array.isArray(state.settleIntents)) {
		return unknownQueueProjection('state_shape_unknown')
	}
	if (state.pending.length > QUEUE_PROJECTION_MAX_PENDING || state.settleIntents.length > QUEUE_PROJECTION_MAX_INTENTS) {
		return unknownQueueProjection('projection_bound_exceeded')
	}
	if (!Number.isSafeInteger(state.historicalCursor) || !Number.isSafeInteger(state.realtimeCursor) ||
		(state.boundaryH !== null && (!Number.isSafeInteger(state.boundaryH?.blockNumber) || state.boundaryH.blockNumber < 0 ||
			typeof state.boundaryH.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(state.boundaryH.blockHash)))) {
		return unknownQueueProjection('cursor_or_boundary_unknown')
	}
	if (typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) {
		return unknownQueueProjection('commit_time_unknown')
	}

	const owned = new Set<string>()
	let openIntentCount = 0
	let ownerKeyCount = 0
	for (const intent of state.settleIntents) {
		if (!intent || typeof intent.status !== 'string' || !['prepared', 'broadcast', 'uncertain', 'confirmed', 'failed'].includes(intent.status)) {
			return unknownQueueProjection('intent_shape_unknown')
		}
		if (!OPEN_INTENT_STATUSES.has(intent.status)) continue
		openIntentCount += 1
		if (!Array.isArray(intent.eventKeys)) return unknownQueueProjection('intent_owner_unknown')
		for (const rawKey of intent.eventKeys) {
			if (typeof rawKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(rawKey)) return unknownQueueProjection('intent_owner_unknown')
			ownerKeyCount += 1
			if (ownerKeyCount > QUEUE_PROJECTION_MAX_OWNER_KEYS) return unknownQueueProjection('projection_bound_exceeded')
			owned.add(rawKey.toLowerCase())
		}
	}

	const lanes: Record<ScanLine, { pending: number; openOwned: number; structurallyAvailable: number }> = {
	realtime: { pending: 0, openOwned: 0, structurallyAvailable: 0 },
	historical: { pending: 0, openOwned: 0, structurallyAvailable: 0 },
	}
	const seen = new Set<string>()
	for (const row of state.pending) {
		if (!row || typeof row.eventKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(row.eventKey) ||
			typeof row.guardianId !== 'string' || !/^[1-9][0-9]*$/.test(row.guardianId) ||
			typeof row.amount !== 'string' || !/^[1-9][0-9]*$/.test(row.amount) ||
			!Number.isSafeInteger(row.blockNumber) || row.blockNumber < 0 ||
			!Number.isSafeInteger(row.withdrawalIndex) || row.withdrawalIndex < 0 ||
			(row.scanLine !== undefined && row.scanLine !== 'historical' && row.scanLine !== 'realtime')) {
			return unknownQueueProjection('pending_shape_unknown')
		}
		const key = row.eventKey.toLowerCase()
		if (seen.has(key)) return unknownQueueProjection('pending_key_duplicate')
		seen.add(key)
		const line: ScanLine = row.scanLine ?? (!state.boundaryH || row.blockNumber <= state.boundaryH.blockNumber ? 'historical' : 'realtime')
		const lane = lanes[line]
		lane.pending += 1
		if (owned.has(key)) lane.openOwned += 1
		else lane.structurallyAvailable += 1
	}

	const maxEntries = resolveMaxEntriesPerTx()
	const realtimeQuota = resolveRealtimeFlushQuota()
	const historicalFloor = resolveHistoricalFlushFloor()
	const realtimeSlots = maxEntries * realtimeQuota
	const historicalSlots = maxEntries * historicalFloor
	const laneProjection = (line: ScanLine, slots: number): QueueProjectionLane => {
		const lane = lanes[line]
		const selectedWithinQuota = Math.min(lane.structurallyAvailable, slots)
		return {
			pending: lane.pending,
			openOwned: lane.openOwned,
			structurallyAvailable: lane.structurallyAvailable,
			selectedWithinQuota,
			outsideQuota: lane.structurallyAvailable - selectedWithinQuota,
			quotaSlots: slots,
			postPlanUnselectableCount: null,
			postPlanUnselectableStatus: 'unknown',
		}
	}
	return {
		status: 'ok',
		source: 'reporter_state_queue_cache',
		generation: bootGen,
		committedAt: state.updatedAt,
		boundaryBlockNumber: state.boundaryH?.blockNumber ?? null,
		boundaryHashPresent: Boolean(state.boundaryH?.blockHash),
		historicalCursor: state.historicalCursor,
		realtimeCursor: state.realtimeCursor,
		pendingCount: state.pending.length,
		openIntentCount,
		realtime: laneProjection('realtime', realtimeSlots),
		historical: laneProjection('historical', historicalSlots),
		legacyPaymentFinality: 'unknown_hold',
	}
}

/**
 * Isolated proof hook: one aggregate-only read through the actual reporter queue.
 * A timeout result is immutable; a late queued callback notices its deadline and
 * cannot return a stale projection. No public listener or production caller exists.
 */
function beginQueueProjection(opts: { timeoutMs?: number } = {}): {
	caller: Promise<ClaimQueueProjection>
	queued: Promise<ClaimQueueProjection>
} {
	const requestedGeneration = bootGen
	const requestedTimeout = opts.timeoutMs ?? 100
	if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0) {
		const invalid = Promise.resolve(unknownQueueProjection('timeout_invalid'))
		return { caller: invalid, queued: invalid }
	}
	const timeoutMs = Math.max(1, Math.min(250, Math.floor(requestedTimeout)))
	const deadline = performance.now() + timeoutMs
	let expired = false
	const queued = enqueueStateJob((): ClaimQueueProjection => {
		if (expired || performance.now() >= deadline) {
			engProjectionExpiredLateCallbacks += 1
			return unknownQueueProjection('expired_in_queue')
		}
		if (bootGen !== requestedGeneration) return unknownQueueProjection('generation_changed')
		if (stateWriteUncertain) return unknownQueueProjection('state_write_uncertain')
		const cache = stateCache
		if (!cache) return unknownQueueProjection('cache_cold')
		if (cache.file !== resolveStateFile()) return unknownQueueProjection('cache_file_drift')
		const projection = projectCommittedQueueState(cache)
		if (expired || performance.now() >= deadline) {
			engProjectionExpiredLateCallbacks += 1
			return unknownQueueProjection('expired_in_queue')
		}
		return projection
	}).catch(() => unknownQueueProjection('state_queue_error'))
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<ClaimQueueProjection>((resolve) => {
		timer = setTimeout(() => {
			expired = true
			resolve(unknownQueueProjection('queue_timeout'))
		}, timeoutMs)
	})
	const caller = Promise.race([queued, timeout]).finally(() => {
		if (timer) clearTimeout(timer)
	})
	return { caller, queued }
}

export function __engHarnessReadQueueProjection(opts: { timeoutMs?: number } = {}): Promise<ClaimQueueProjection> {
	return beginQueueProjection(opts).caller
}

/** Test-only view of the discarded queue result, to prove a late callback returns UNKNOWN. */
export async function __engHarnessReadQueueProjectionWithLateForTest(opts: { timeoutMs?: number } = {}): Promise<{
	caller: ClaimQueueProjection
	queued: ClaimQueueProjection
}> {
	const attempt = beginQueueProjection(opts)
	return { caller: await attempt.caller, queued: await attempt.queued }
}

/** Test-only queue barrier used to verify timeout/late-callback behavior without I/O. */
export function __engHarnessHoldStateQueueForTest(ms: number): Promise<void> {
	const boundedMs = Math.max(1, Math.min(100, Math.floor(ms)))
	const run = stateQueue.then(() => new Promise<void>((resolve) => setTimeout(resolve, boundedMs)))
	stateQueue = run.catch(() => undefined)
	return run
}

/** Test-only diagnostic proving that a timed-out late callback was discarded. */
export function __engHarnessProjectionExpiredLateCount(): number {
	return engProjectionExpiredLateCallbacks
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

function stateForFlushPlan(state: DualCursorState): DualCursorState {
	const eligible = signableKeySet(state)
	return { ...state, pending: state.pending.filter((row) => eligible.has(row.eventKey.toLowerCase())) }
}

function selectedPendingMatches(latest: DualCursorState, entries: PayoutEntry[]): boolean {
	const wanted = new Map(entries.map((entry) => [entry.eventKey.toLowerCase(), entry]))
	if (!entries.length || wanted.size !== entries.length) return false
	let matched = 0
	for (const row of latest.pending) {
		const entry = wanted.get(row.eventKey.toLowerCase())
		if (!entry) continue
		const parsed = entryFromJson(row)
		if (!parsed) return false
		const line = parsed.scanLine ?? (!latest.boundaryH || parsed.blockNumber <= latest.boundaryH.blockNumber ? 'historical' : 'realtime')
		if (
			parsed.guardianId !== entry.guardianId ||
			parsed.amount !== entry.amount ||
			parsed.eventKey !== entry.eventKey.toLowerCase() ||
			parsed.blockNumber !== entry.blockNumber ||
			parsed.withdrawalIndex !== entry.withdrawalIndex ||
			line !== (entry.scanLine ?? line)
		) return false
		matched += 1
	}
	return matched === entries.length
}

function removePendingEntriesIfCurrent(state: DualCursorState, entries: PayoutEntry[], applied?: { value: boolean }): DualCursorState {
	if (!selectedPendingMatches(state, entries)) return state
	const keys = new Set(entries.map((entry) => entry.eventKey.toLowerCase()))
	if (state.settleIntents.some((intent) => OPEN_INTENT_STATUSES.has(intent.status) && intent.eventKeys.some((key) => keys.has(key.toLowerCase())))) return state
	if (applied) applied.value = true
	return removePendingKeys(state, [...keys])
}

function intentMatchesEntries(intent: SettleIntent, entries: PayoutEntry[]): boolean {
	if (intent.eventKeys.length !== entries.length || intent.guardianIds.length !== entries.length || intent.amounts.length !== entries.length || intent.scanLines.length !== entries.length) return false
	return entries.every((entry, index) =>
		intent.eventKeys[index]?.toLowerCase() === entry.eventKey.toLowerCase() &&
		BigInt(intent.guardianIds[index] ?? '-1') === entry.guardianId &&
		BigInt(intent.amounts[index] ?? '-1') === entry.amount &&
		intent.scanLines[index] === (entry.scanLine ?? 'historical')
	)
}


async function persistIntentBeforeSign(
	intent: SettleIntent,
	entries: PayoutEntry[],
	replacing?: SettleIntent
): Promise<'persisted' | 'conflict' | 'uncertain' | 'blocked'> {
	if (stateWriteUncertain) return 'uncertain'
	let eligible = false
	let blocked = false
	try {
		await mutateState((latest) => {
			const control = latest.signerControl
			const permit = control?.permit
			if (!signerTransportAvailable() || !control || control.stop !== false || !permit || permit.status !== 'available') {
				blocked = true
				return latest
			}
			if (
				permit.intentId !== intent.intentId || permit.idempotencyKey !== intent.idempotencyKey ||
				permit.requestFingerprint !== intent.requestFingerprint
			) {
				blocked = true
				return latest
			}
			if (replacing) {
				if (!permit.replaces || permit.replaces.idempotencyKey !== replacing.idempotencyKey ||
					permit.replaces.txHash !== replacing.txHash ||
					permit.replaces.requestFingerprint !== replacing.requestFingerprint) {
					blocked = true
					return latest
				}
			} else if (permit.replaces !== undefined) {
				blocked = true
				return latest
			}
			if (!selectedPendingMatches(latest, entries) || !intentMatchesEntries(intent, entries)) return latest
			const allowedOwner = replacing?.idempotencyKey
			const owners = latest.settleIntents.filter((item) => OPEN_INTENT_STATUSES.has(item.status))
			const selectedKeys = new Set(entries.map((entry) => entry.eventKey.toLowerCase()))
			for (const item of owners) {
				if (item.idempotencyKey === allowedOwner) continue
				if (item.eventKeys.some((key) => selectedKeys.has(key.toLowerCase()))) return latest
			}
			if (replacing) {
				const liveOld = latest.settleIntents.find((item) => item.idempotencyKey === replacing.idempotencyKey)
				if (!liveOld || !OPEN_INTENT_STATUSES.has(liveOld.status)) return latest
				if (liveOld.status !== replacing.status || liveOld.txHash !== replacing.txHash ||
					liveOld.requestFingerprint !== replacing.requestFingerprint || liveOld.intentId !== replacing.intentId) return latest
				if (liveOld.eventKeys.length !== intent.eventKeys.length || !liveOld.eventKeys.every((key, index) => key.toLowerCase() === intent.eventKeys[index]?.toLowerCase())) return latest
			} else if (intent.eventKeys.length !== entries.length || !intent.eventKeys.every((key, index) => key.toLowerCase() === entries[index]?.eventKey.toLowerCase())) {
				return latest
			}
			// Any existing key, including failed, stays held until an explicit recovery decision.
			if (latest.settleIntents.some((item) => item.idempotencyKey === intent.idempotencyKey)) return latest
			const budgetWei = resolveFirstBatchBudgetWei()
			if (budgetWei != null) {
				try {
					if (remainingFirstBatchBudgetWei(latest, budgetWei) < batchSumWei(entries)) return latest
				} catch {
					return latest
				}
			}
			const base = replacing ? markIntentReplacedFailed(latest, replacing.idempotencyKey, `replaced_or_dropped:rebuilt:${intent.intentId}`) : latest
			try {
				eligible = true
				const withConsumedPermit: DualCursorState = {
					...base,
					signerControl: { ...control, permit: { ...permit, status: 'consumed' } },
				}
				return attachIntentToState(withConsumedPermit, intent)
			} catch {
				eligible = false
				return latest
			}
		})
	} catch (error) {
		if (stateWriteUncertain || error instanceof StateWriteUncertainError) return 'uncertain'
		throw error
	}
	return stateWriteUncertain ? 'uncertain' : eligible ? 'persisted' : blocked ? 'blocked' : 'conflict'
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

type StrictReceiptStatus = 0 | 1
const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/i
type FinalizedReceiptEvidence = { status: StrictReceiptStatus; blockNumber: number; blockHash: string }

async function getFinalizedReceiptEvidence(
	provider: ethers.JsonRpcProvider,
	receipt: ethers.TransactionReceipt,
	expectedHash: string,
	expectedTo: string
): Promise<FinalizedReceiptEvidence | null> {
	if (receipt.status !== 0 && receipt.status !== 1) return null
	if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || typeof receipt.blockHash !== 'string' || !BLOCK_HASH_RE.test(receipt.blockHash)) return null
	if (typeof receipt.hash !== 'string' || !BLOCK_HASH_RE.test(receipt.hash) || receipt.hash.toLowerCase() !== expectedHash.toLowerCase()) return null
	if (typeof receipt.to !== 'string' || receipt.to.toLowerCase() !== expectedTo.toLowerCase()) return null
	try {
		const [finalized, canonical] = await Promise.all([
			provider.getBlock('finalized'),
			provider.getBlock(receipt.blockNumber),
		])
		if (!finalized || !canonical || !Number.isSafeInteger(finalized.number) || !Number.isSafeInteger(canonical.number) || finalized.number < receipt.blockNumber || canonical.number !== receipt.blockNumber) return null
		if (!canonical.hash || !BLOCK_HASH_RE.test(canonical.hash) || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return null
		return { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash.toLowerCase() }
	} catch {
		return null
	}
}

async function intentConsumedAtFinalizedBlock(
	provider: ethers.JsonRpcProvider,
	to: string,
	eventKeys: string[],
	blockNumber: number,
	blockHash: string
): Promise<'consumed' | 'open' | 'partial' | 'unknown'> {
	if (!eventKeys.length) return 'unknown'
	try {
		const [headBefore, canonicalBefore] = await Promise.all([
			provider.getBlock('finalized'),
			provider.getBlock(blockNumber),
		])
		if (!headBefore || !Number.isSafeInteger(headBefore.number) || headBefore.number < blockNumber || !canonicalBefore || !Number.isSafeInteger(canonicalBefore.number) || canonicalBefore.number !== blockNumber || !canonicalBefore.hash || !BLOCK_HASH_RE.test(canonicalBefore.hash) || canonicalBefore.hash.toLowerCase() !== blockHash.toLowerCase()) return 'unknown'
		const contract = makeReadContract(to, provider)
		let allConsumed = true
		let anyConsumed = false
		for (const key of eventKeys) {
			const raw: unknown = await contract.consumedRewardEventKey!(key, { blockTag: blockNumber })
			if (typeof raw !== 'boolean') return 'unknown'
			if (raw) anyConsumed = true
			else allConsumed = false
		}
		const [headAfter, canonicalAfter] = await Promise.all([
			provider.getBlock('finalized'),
			provider.getBlock(blockNumber),
		])
		if (!headAfter || !Number.isSafeInteger(headAfter.number) || headAfter.number < blockNumber || !canonicalAfter || !Number.isSafeInteger(canonicalAfter.number) || canonicalAfter.number !== blockNumber || !canonicalAfter.hash || !BLOCK_HASH_RE.test(canonicalAfter.hash) || canonicalAfter.hash.toLowerCase() !== blockHash.toLowerCase()) return 'unknown'
		if (allConsumed) return 'consumed'
		return anyConsumed ? 'partial' : 'open'
	} catch {
		return 'unknown'
	}
}

async function intentConsumedOnChain(
	provider: ethers.JsonRpcProvider,
	to: string,
	eventKeys: string[]
): Promise<'consumed' | 'open' | 'partial' | 'unknown'> {
	try {
		const finalized = await provider.getBlock('finalized')
		if (!finalized?.hash || !BLOCK_HASH_RE.test(finalized.hash) || !Number.isSafeInteger(finalized.number) || finalized.number < 0) return 'unknown'
		return intentConsumedAtFinalizedBlock(provider, to, eventKeys, finalized.number, finalized.hash)
	} catch {
		return 'unknown'
	}
}

class ReceiptQueryUnknownError extends Error {
	constructor(cause: unknown) { super('receipt query failed', { cause }); this.name = 'ReceiptQueryUnknownError' }
}

async function waitForSignerReceipt(
	provider: ethers.JsonRpcProvider,
	hash: string,
	timeoutMs: number
): Promise<ethers.TransactionReceipt> {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		let receipt: ethers.TransactionReceipt | null
		try {
			receipt = await provider.getTransactionReceipt(hash)
		} catch (error) {
			throw new ReceiptQueryUnknownError(error)
		}
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

/**
 * Flush gate: only a key proven consumed at one stable canonical finalized block may be removed.
 * A latest=true/finalized=false disagreement is UNKNOWN and is never signed this tick.
 */
async function checkBatchUnconsumedFinalized(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	entries: PayoutEntry[]
): Promise<{ payable: PayoutEntry[]; consumed: PayoutEntry[]; unknown: PayoutEntry[] }> {
	const payable: PayoutEntry[] = []
	const consumed: PayoutEntry[] = []
	const unknown: PayoutEntry[] = []
	if (!entries.length) return { payable, consumed, unknown }
	let finalized: ethers.Block | null
	let canonical: ethers.Block | null
	try {
	finalized = await provider.getBlock('finalized')
	canonical = finalized && Number.isSafeInteger(finalized.number) ? await provider.getBlock(finalized.number) : null
	} catch {
		return { payable, consumed, unknown: [...entries] }
	}
	if (!finalized || !canonical || !Number.isSafeInteger(finalized.number) || finalized.number < 0 || canonical.number !== finalized.number || !finalized.hash || !canonical.hash || !BLOCK_HASH_RE.test(finalized.hash) || !BLOCK_HASH_RE.test(canonical.hash) || canonical.hash.toLowerCase() !== finalized.hash.toLowerCase()) {
		return { payable, consumed, unknown: [...entries] }
	}
	const blockNumber = finalized.number
	const blockHash = finalized.hash.toLowerCase()
	for (const entry of entries) {
		let latestRaw: unknown
		let finalizedRaw: unknown
		try {
			latestRaw = await readContract.consumedRewardEventKey!(entry.eventKey)
			finalizedRaw = await readContract.consumedRewardEventKey!(entry.eventKey, { blockTag: blockNumber })
		} catch {
			unknown.push(entry)
			continue
		}
		if (typeof latestRaw !== 'boolean' || typeof finalizedRaw !== 'boolean') {
			unknown.push(entry)
			continue
		}
		if (latestRaw !== finalizedRaw) {
			unknown.push(entry)
			continue
		}
		if (finalizedRaw) {
			consumed.push(entry)
			continue
		}
		if (latestRaw) {
			unknown.push(entry)
			continue
		}
		payable.push(entry)
	}
	try {
		const [headAfter, canonicalAfter] = await Promise.all([provider.getBlock('finalized'), provider.getBlock(blockNumber)])
		if (!headAfter || !Number.isSafeInteger(headAfter.number) || headAfter.number < blockNumber || !canonicalAfter || canonicalAfter.number !== blockNumber || !canonicalAfter.hash || !BLOCK_HASH_RE.test(canonicalAfter.hash) || canonicalAfter.hash.toLowerCase() !== blockHash) {
			return { payable: [], consumed: [], unknown: [...entries] }
		}
	} catch {
		return { payable: [], consumed: [], unknown: [...entries] }
	}
	return { payable, consumed, unknown }
}

type SubmitOutcome =
	| 'ok'
	| 'dry_run_no_send'
	| 'needs_split'
	| 'failed'
	| 'uncertain'
	| 'amount_blocked'
	| 'estimate_failed'
	| 'signer_blocked'
	| 'state_conflict'
	| 'state_write_uncertain'
	| 'receipt_unknown'
	| 'reverted'

function intentCoversPending(intent: SettleIntent, pending: Map<string, PayoutEntry>): boolean {
	return intent.eventKeys.every((k) => pending.has(k.toLowerCase()))
}

/** Pure: credit an intent confirmed with receipt status 1 once, and clear its pending keys. */
function creditConfirmedIntent(state: DualCursorState, intent: SettleIntent): DualCursorState {
	return removePendingKeys(markIntentConfirmed(state, intent.idempotencyKey, 1), intent.eventKeys)
}

function sameLiveIntent(live: SettleIntent | undefined, expected: SettleIntent, expectedTxHash = expected.txHash): live is SettleIntent {
	return Boolean(live && live.txHash === expectedTxHash && live.requestFingerprint === expected.requestFingerprint && live.data === expected.data && live.eventKeys.length === expected.eventKeys.length && live.eventKeys.every((key, index) => key.toLowerCase() === expected.eventKeys[index]?.toLowerCase()))
}

function hasOtherOpenOwner(state: DualCursorState, expected: SettleIntent): boolean {
	const keys = new Set(expected.eventKeys.map((key) => key.toLowerCase()))
	return state.settleIntents.some((item) => item.idempotencyKey !== expected.idempotencyKey && OPEN_INTENT_STATUSES.has(item.status) && item.eventKeys.some((key) => keys.has(key.toLowerCase())))
}

function creditCurrentIntent(state: DualCursorState, expected: SettleIntent, applied?: { value: boolean }, expectedTxHash = expected.txHash): DualCursorState {
	const live = state.settleIntents.find((item) => item.idempotencyKey === expected.idempotencyKey)
	if (!sameLiveIntent(live, expected, expectedTxHash) || hasOtherOpenOwner(state, expected)) return state
	if (!OPEN_INTENT_STATUSES.has(live.status) && live.status !== 'confirmed') return state
	const wanted = new Map(expected.eventKeys.map((key, index) => [key.toLowerCase(), index]))
	let found = 0
	for (const raw of state.pending) {
		const index = wanted.get(raw.eventKey.toLowerCase())
		if (index === undefined) continue
		const entry = entryFromJson(raw)
		if (!entry || entry.guardianId !== BigInt(expected.guardianIds[index] ?? '-1') || entry.amount !== BigInt(expected.amounts[index] ?? '-1') || (entry.scanLine ?? 'historical') !== expected.scanLines[index]) return state
		found += 1
	}
	if (found === 0 && live.status === 'confirmed') return state
	if (found !== wanted.size) return state
	if (applied) applied.value = true
	return creditConfirmedIntent(state, live)
}

function markCurrentIntentReverted(state: DualCursorState, expected: SettleIntent, applied?: { value: boolean }, expectedTxHash = expected.txHash): DualCursorState {
	const live = state.settleIntents.find((item) => item.idempotencyKey === expected.idempotencyKey)
	if (!sameLiveIntent(live, expected, expectedTxHash) || hasOtherOpenOwner(state, expected) || !OPEN_INTENT_STATUSES.has(live.status)) return state
	if (applied) applied.value = true
	return markIntentConfirmed(state, live.idempotencyKey, 0)
}

/**
 * Persist settle intent BEFORE broadcast. On ACK loss, rebuild the same
 * idempotencyKey + fingerprint — never invent a new batch.
 * Every state change is its own serial merge; signer and receipt awaits run outside the queue.
 */
async function submitPayoutBatchOnchain(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint,
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract
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
		return 'dry_run_no_send'
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
	// Recheck chain state after estimateGas and immediately before the serialized durable guard.
	const finalGate = await checkBatchUnconsumedFinalized(provider, readContract, entries)
	if (finalGate.consumed.length) {
		// This candidate never performs an unbound pre-intent ledger mutation. The explicit recovery lane
		// may reconcile consumed rows only under the exact already-consumed intent permit.
		return 'state_conflict'
	}
	if (finalGate.unknown.length || finalGate.payable.length !== entries.length) return 'receipt_unknown'
	// Persist against the latest state after every RPC/estimate await; signer is unreachable on a conflict or uncertain commit.
	const persisted = await persistIntentBeforeSign(intent, entries)
	if (persisted === 'blocked') return 'signer_blocked'
	if (persisted === 'conflict') return 'state_conflict'
	if (persisted === 'uncertain') return 'state_write_uncertain'

	const tx: VdrSignerTx = rebuildSignerTxFromIntent(intent, config.keyArray)

	logger(
		Colors.cyan(
			`[validatorClRewardPayout] PRE_SIGN ACCEPT eventKeys=${eventKeys.join(',')} batchSumWei=${amountGate.batchSumWei} capWei=${amountGate.capWei} n=${entries.length}`
		)
	)

	try {
		const { hash } = await sendSignerTx(tx, config.socketPath)
		const broadcast = await mutatePaymentState((s) => markIntentBroadcast(s, intent.idempotencyKey, hash), intent)
		if (!broadcast.allowed) return 'state_conflict'
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] settleNodeRewards sent via signer tx=${hash} waiting≤${resolveClaimTxWaitTimeoutMs()}ms n=${entries.length} eventKeys=${eventKeys.join(',')} gasPrice=${ethers.formatUnits(gasPriceWei, 'gwei')}gwei idem=${intent.idempotencyKey.slice(0, 24)}…`
			)
		)
		const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
		const receiptEvidence = await getFinalizedReceiptEvidence(provider, receipt, hash, contractAddr)
		if (!receiptEvidence) return 'receipt_unknown'
		const consumed = await intentConsumedAtFinalizedBlock(provider, intent.to, intent.eventKeys, receiptEvidence.blockNumber, receiptEvidence.blockHash)
		if (receiptEvidence.status === 1 && consumed !== 'consumed') return 'receipt_unknown'
		if (receiptEvidence.status === 0 && consumed !== 'open') return 'receipt_unknown'
		const applied = { value: false }
		const settled = await mutatePaymentState((s) => receiptEvidence.status === 1 ? creditCurrentIntent(s, intent, applied, hash) : markCurrentIntentReverted(s, intent, applied, hash), intent)
		if (!settled.allowed || !applied.value) return 'state_conflict'
		if (receiptEvidence.status === 0) return 'reverted'
		logger(Colors.green(`[validatorClRewardPayout] settleNodeRewards ok tx=${hash} n=${entries.length}`))
		return 'ok'
	} catch (e: unknown) {
		if (stateWriteUncertain || e instanceof StateWriteUncertainError) return 'state_write_uncertain'
		if (e instanceof ReceiptQueryUnknownError) return 'receipt_unknown'
		// Once the signer API has been invoked, an unstructured failure cannot prove no send occurred.
		await mutatePaymentState((s) => markIntentUncertain(s, intent.idempotencyKey, 'signer_outcome_unknown'), intent)
		logger(Colors.yellow(`[validatorClRewardPayout] signer outcome unknown after invocation; preserving intent idem=${intent.idempotencyKey.slice(0, 24)}…`))
		return 'uncertain'
	}
}

async function submitPayoutBatch(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint,
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract
): Promise<SubmitOutcome> {
	if (!entries.length) return 'ok'
	const outcome = await enqueueOnchainTxWork(
		CONET_VALIDATOR_NODE_ONCHAIN_LANE,
		`settleNodeRewards n=${entries.length}`,
		async () => submitPayoutBatchOnchain(contractAddr, entries, gasPriceWei, provider, readContract),
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
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract
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

	const outcome = await submitPayoutBatch(contractAddr, entries, gasPriceWei, provider, readContract)
	if (outcome === 'ok') {
		// Status=1 receipt credit and pending removal were committed atomically with the live intent check.
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
	if (outcome === 'dry_run_no_send') {
		logger(Colors.yellow(`[validatorClRewardPayout] dry-run accepted no transaction; leave pending unchanged n=${entries.length}`))
		return
	}

	if (outcome === 'uncertain') {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] leave batch in pending (ACK uncertain); keys stay owned by the open intent, held with no resend n=${entries.length}`
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
	if (outcome === 'estimate_failed' || outcome === 'signer_blocked' || outcome === 'state_conflict' || outcome === 'state_write_uncertain' || outcome === 'receipt_unknown' || outcome === 'reverted') {
		logger(
			Colors.red(
				`[validatorClRewardPayout] leave batch in pending after ${outcome}; no auto-split n=${entries.length}`
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
	await submitPayoutBatchAutoSplit(contractAddr, left, gasPriceWei, provider, readContract)
	await submitPayoutBatchAutoSplit(contractAddr, right, gasPriceWei, provider, readContract)
}

async function submitPayoutBatchAutoSplit(
	contractAddr: string,
	entries: PayoutEntry[],
	gasPriceWei: bigint,
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract
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
		await submitPayableBatch(contractAddr, pack, gasPriceWei, provider, readContract)
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
 * Provable only when the signer account's on-chain finalized nonce has moved past the tx nonce while
 * our hash still has no receipt: then another tx consumed that nonce (replacement) or ours was
 * dropped. A same-nonce tx mined elsewhere implies latest > nonce, so this single check covers both.
 * Any missing data or RPC error => 'wait'. Rebuild still requires finalized nonce advancement and intentConsumedOnChain === 'open'.
 */
export async function judgeTxReplacedOrDropped(
	provider: ethers.JsonRpcProvider,
	intent: Pick<SettleIntent, 'txHash' | 'to' | 'data'>
): Promise<'replaced_or_dropped' | 'wait'> {
	if (!intent.txHash) return 'wait'
	let tx: { hash?: string; from?: string | null; nonce?: number | null; to?: string | null; data?: string } | null
	try {
		tx = (await provider.getTransaction(intent.txHash)) as { hash?: string; from?: string | null; nonce?: number | null; to?: string | null; data?: string } | null
	} catch {
		return 'wait'
	}
	if (!tx || tx.hash?.toLowerCase() !== intent.txHash.toLowerCase() || !tx.from || typeof tx.nonce !== 'number' || !Number.isSafeInteger(tx.nonce) || tx.to?.toLowerCase() !== intent.to.toLowerCase() || tx.data?.toLowerCase() !== intent.data.toLowerCase()) return 'wait'
	let latest: number
	try {
		latest = Number(await provider.getTransactionCount(tx.from, 'finalized'))
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

const intentReplaceAlerted = new Set<string>()

/** One ALERT per replaced intent (txHash without receipt, signer nonce consumed). It is never re-sent under the old key. */
function alertReplacedOnce(intent: Pick<SettleIntent, 'idempotencyKey' | 'txHash'>): void {
	if (intentReplaceAlerted.has(intent.idempotencyKey)) return
	intentReplaceAlerted.add(intent.idempotencyKey)
	logger(
		Colors.red(
			`[validatorClRewardPayout] ALERT intent replaced/dropped: txHash=${intent.txHash} has no receipt and its nonce was consumed; rebuilding under a new idempotencyKey idem=${intent.idempotencyKey.slice(0, 24)}…`
		)
	)
}

/**
 * Rebuild a replaced batch under a NEW idempotencyKey. The old record stays as failed (audit, no budget reserve);
 * the new intent is persisted before it is signed. A failed send leaves the new intent uncertain.
 */
async function rebuildReplacedIntent(
	provider: ethers.JsonRpcProvider,
	prev: SettleIntent,
	config: { socketPath: string; keyArray: string } | null
): Promise<void> {
	if (!config) {
		logger(Colors.yellow(`[validatorClRewardPayout] replaced intent rebuild held: no signer configured idem=${prev.idempotencyKey.slice(0, 24)}…`))
		return
	}
	const seq = nextRebuildSeq(prev.intentId)
	const fresh = prepareRebuiltSettleIntent(prev, seq, config.keyArray)
	const pending = pendingMapFromState(peekLatestState())
	const entries = prev.eventKeys.map((key) => pending.get(key.toLowerCase())).filter((entry): entry is PayoutEntry => Boolean(entry))
	if (entries.length !== prev.eventKeys.length) {
		logger(Colors.yellow(`[validatorClRewardPayout] replaced intent rebuild held: pending snapshot changed idem=${prev.idempotencyKey.slice(0, 24)}…`))
		return
	}
	if (!intentMatchesEntries(fresh, entries)) {
		logger(Colors.yellow(`[validatorClRewardPayout] replaced intent rebuild held: calldata differs from live pending idem=${prev.idempotencyKey.slice(0, 24)}…`))
		return
	}
	const liveGate = await checkBatchUnconsumedFinalized(provider, makeReadContract(fresh.to, provider), entries)
	if (liveGate.consumed.length === entries.length && !liveGate.unknown.length) {
		const applied = { value: false }
		const credited = await mutatePaymentState((state) => creditCurrentIntent(state, prev, applied), prev)
		logger(Colors[credited.allowed && applied.value ? 'green' : 'yellow'](`[validatorClRewardPayout] replaced intent became consumed before rebuild; ${credited.allowed && applied.value ? 'credited without signing' : 'credit held by intent permit'} idem=${prev.idempotencyKey.slice(0, 24)}…`))
		return
	}
	if (liveGate.unknown.length || liveGate.consumed.length || liveGate.payable.length !== entries.length) {
		logger(Colors.yellow(`[validatorClRewardPayout] replaced intent rebuild held: finalized/latest key state changed or unknown idem=${prev.idempotencyKey.slice(0, 24)}…`))
		return
	}
	const persisted = await persistIntentBeforeSign(fresh, entries, prev)
	if (persisted !== 'persisted') {
		logger(Colors.yellow(`[validatorClRewardPayout] replaced intent rebuild held (${persisted}); no signer call idem=${prev.idempotencyKey.slice(0, 24)}…`))
		return
	}
	logger(
		Colors.yellow(
			`[validatorClRewardPayout] REBUILD replaced batch as r${seq} oldIdem=${prev.idempotencyKey.slice(0, 24)}… newIdem=${fresh.idempotencyKey.slice(0, 24)}…`
		)
	)
	try {
		const tx = rebuildSignerTxFromIntent(fresh, config.keyArray)
		const { hash } = await sendSignerTx(tx, config.socketPath)
		const broadcast = await mutatePaymentState((s) => markIntentBroadcast(s, fresh.idempotencyKey, hash), fresh)
		if (!broadcast.allowed) return
		const receipt = await waitForSignerReceipt(provider, hash, resolveClaimTxWaitTimeoutMs())
		const receiptEvidence = await getFinalizedReceiptEvidence(provider, receipt, hash, fresh.to)
		if (!receiptEvidence) return
		const consumed = await intentConsumedAtFinalizedBlock(provider, fresh.to, fresh.eventKeys, receiptEvidence.blockNumber, receiptEvidence.blockHash)
		if ((receiptEvidence.status === 1 && consumed !== 'consumed') || (receiptEvidence.status === 0 && consumed !== 'open')) return
		const applied = { value: false }
		const settled = await mutatePaymentState((s) => receiptEvidence.status === 1 ? creditCurrentIntent(s, fresh, applied, hash) : markCurrentIntentReverted(s, fresh, applied, hash), fresh)
		if (!settled.allowed || !applied.value) {
			logger(Colors.yellow(`[validatorClRewardPayout] rebuilt receipt held: live intent changed before credit idem=${fresh.idempotencyKey.slice(0, 24)}…`))
			return
		}
		if (receiptEvidence.status === 1) logger(Colors.green(`[validatorClRewardPayout] rebuilt batch r${seq} settled at finalized receipt tx=${hash}`))
		else logger(Colors.yellow(`[validatorClRewardPayout] rebuilt batch r${seq} reverted at finalized receipt tx=${hash}`))
	} catch (e: unknown) {
		if (stateWriteUncertain || e instanceof StateWriteUncertainError) {
			logger(Colors.red(`[validatorClRewardPayout] rebuilt intent state durability unknown; no further signer action idem=${fresh.idempotencyKey.slice(0, 24)}…`))
			return
		}
		const msg = (e as Error)?.message ?? String(e)
		await mutatePaymentState((s) => markIntentUncertain(s, fresh.idempotencyKey, `rebuild_unconfirmed:${msg.slice(0, 120)}`), fresh)
		logger(Colors.yellow(`[validatorClRewardPayout] rebuilt batch r${seq} deferred: ${msg}`))
	}
}

async function recoverOpenIntents(provider: ethers.JsonRpcProvider): Promise<void> {
	const entryState = peekLatestState()
	if (!canContinuePaymentRead(entryState) && !entryState.settleIntents.some((intent) => availablePermitReplacesIntent(entryState, intent))) {
		return
	}
	const open = peekLatestState().settleIntents.filter(
		(i) => i.status === 'broadcast' || i.status === 'uncertain' || i.status === 'prepared'
	)
	if (!open.length) return

	const config = flushTestHooks.signerConfig ?? readVdrSignerConfig()
	for (const snapshot of open) {
		// Re-read this intent from the latest state: an earlier step may already have settled it.
		const latestForGate = peekLatestState()
		const intent = latestForGate.settleIntents.find((i) => i.idempotencyKey === snapshot.idempotencyKey)
		if (!intent || !OPEN_INTENT_STATUSES.has(intent.status)) continue
		if (!hasConsumedPermitForIntent(latestForGate, intent.idempotencyKey) && !availablePermitReplacesIntent(latestForGate, intent)) continue

		if (!intentCoversPending(intent, pendingMapFromState(peekLatestState())) && intent.status === 'prepared') {
			// A prepared write may have reached the signer before its status update; partial pending mismatch is never auto-dropped.
			const onChainPrep = await intentConsumedOnChain(provider, intent.to, intent.eventKeys)
			if (onChainPrep === 'unknown' || onChainPrep === 'partial') {
				logger(Colors.yellow(`[validatorClRewardPayout] prepared intent on-chain status unknown; hold (no resend, no drop) idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			if (onChainPrep === 'consumed') {
				const applied = { value: false }
				const credited = await mutatePaymentState((s) => creditCurrentIntent(s, intent, applied), intent)
				logger(Colors[credited.allowed && applied.value ? 'green' : 'yellow'](`[validatorClRewardPayout] prepared intent ${credited.allowed && applied.value ? 'credited from finalized chain state' : 'credit held: live record changed or permit closed'} idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			logger(Colors.yellow(`[validatorClRewardPayout] prepared intent missing pending keys but finalized state is open; hold, do not drop/re-sign idem=${intent.idempotencyKey.slice(0, 24)}…`))
			continue
		}

		if (intent.txHash) {
			let receipt: ethers.TransactionReceipt | null
			try {
				receipt = await provider.getTransactionReceipt(intent.txHash)
			} catch {
				noteIntentWaiting(intent)
				logger(Colors.yellow(`[validatorClRewardPayout] receipt query failed; hold (no rebuild) idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			if (receipt) {
				const receiptEvidence = await getFinalizedReceiptEvidence(provider, receipt, intent.txHash, intent.to)
				if (!receiptEvidence) {
					noteIntentWaiting(intent)
					logger(Colors.yellow(`[validatorClRewardPayout] receipt status/finality unknown; hold (no rebuild) idem=${intent.idempotencyKey.slice(0, 24)}…`))
					continue
				}
				const consumed = await intentConsumedAtFinalizedBlock(provider, intent.to, intent.eventKeys, receiptEvidence.blockNumber, receiptEvidence.blockHash)
				if ((receiptEvidence.status === 1 && consumed !== 'consumed') || (receiptEvidence.status === 0 && consumed !== 'open')) {
					noteIntentWaiting(intent)
					logger(Colors.yellow(`[validatorClRewardPayout] receipt/event state inconsistent or unknown; hold idem=${intent.idempotencyKey.slice(0, 24)}…`))
					continue
				}
				const applied = { value: false }
				const recovered = await mutatePaymentState((s) => receiptEvidence.status === 1 ? creditCurrentIntent(s, intent, applied) : markCurrentIntentReverted(s, intent, applied), intent)
				logger(Colors[recovered.allowed && applied.value ? 'green' : 'yellow'](`[validatorClRewardPayout] ${recovered.allowed && applied.value ? 'recovered intent' : 'receipt credit held: live record changed or permit closed'} via finalized receipt status=${receiptEvidence.status} idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			// No receipt was returned; replacement logic below additionally requires finalized nonce advancement.
			const verdict = await judgeTxReplacedOrDropped(provider, intent)
			if (verdict !== 'replaced_or_dropped') {
				noteIntentWaiting(intent)
				logger(Colors.yellow(`[validatorClRewardPayout] intent txHash has no receipt; wait (no rebuild, no resend) idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			alertReplacedOnce(intent)
			const onChainR = await intentConsumedOnChain(provider, intent.to, intent.eventKeys)
			if (onChainR === 'unknown' || onChainR === 'partial') {
				logger(Colors.yellow(`[validatorClRewardPayout] replaced intent on-chain status ${onChainR}; hold (no rebuild, no resend) idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			if (onChainR === 'consumed') {
				const applied = { value: false }
				const credited = await mutatePaymentState((s) => creditCurrentIntent(s, intent, applied), intent)
				logger(Colors[credited.allowed && applied.value ? 'green' : 'yellow'](`[validatorClRewardPayout] replaced intent ${credited.allowed && applied.value ? 'credited from finalized chain state; no rebuild' : 'credit held: live record changed or permit closed'} idem=${intent.idempotencyKey.slice(0, 24)}…`))
				continue
			}
			// Open: the dead tx can never mine (its nonce is taken). Rebuild the batch under a NEW idempotencyKey.
			await rebuildReplacedIntent(provider, intent, config)
			continue
		}

		// Chain already settled this intent (ACK lost / SIGKILL before broadcast mark) — credit once, do not resend.
		const onChainAck = await intentConsumedOnChain(provider, intent.to, intent.eventKeys)
		if (onChainAck === 'unknown' || onChainAck === 'partial') {
			logger(Colors.yellow(`[validatorClRewardPayout] ACK-lost on-chain status unknown; hold (no resend) idem=${intent.idempotencyKey.slice(0, 24)}…`))
			continue
		}
		if (onChainAck === 'consumed') {
			const applied = { value: false }
			const credited = await mutatePaymentState((s) => creditCurrentIntent(s, intent, applied), intent)
			logger(Colors[credited.allowed && applied.value ? 'green' : 'yellow'](`[validatorClRewardPayout] ACK-lost intent ${credited.allowed && applied.value ? 'credited from finalized chain state; skip resend' : 'credit held: live record changed or permit closed'} idem=${intent.idempotencyKey.slice(0, 24)}…`))
			continue
		}

		// ACK lost and no txHash in hand: the daemon cannot tell whether the signer already signed this batch, and it
		// does not rely on the signer to dedupe a repeated idempotencyKey. Resending here could sign a second tx, so
		// the intent is HELD: no send, its keys stay owned, and the on-chain check above credits it once consumed.
		// A hold that lasts past the wait limit is reported once by noteIntentWaiting (ALERT). Manual handling only.
		noteIntentWaiting(intent)
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] ACK-lost intent without txHash: hold (no resend; keys stay owned) idem=${intent.idempotencyKey.slice(0, 24)}… status=${intent.status}`
			)
		)
	}
}

async function flushPendingBatches(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	contractAddr: string
): Promise<void> {
	// No payment-lane work (including bookkeeping writes) is admitted without an exact synthetic permit.
	// The durable permit is consumed only together with the matching intent in persistIntentBeforeSign.
	if (!hasAvailableSyntheticSignerPermit(peekLatestState())) return
	if (!peekLatestState().pending.length) {
		return
	}

	const maxGas = resolveMaxGasPriceWei()
	const gasDustWei = 50_000_000n
	const gasPrice = await readGasPriceWei(provider)
	if (gasPrice > maxGas + gasDustWei) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] candidate hold: gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei > max=${ethers.formatUnits(maxGas, 'gwei')} gwei ` +
					`(pending=${peekLatestState().pending.length}); no gas-wait ledger mutation in signer-control candidate`
			)
		)
		return
	}

	if (!peekLatestState().pending.length) {
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

	const flushPlan = planFlushOrder(stateForFlushPlan(peekLatestState()), {
		maxEntriesPerTx: resolveMaxEntriesPerTx(),
		realtimeQuota: resolveRealtimeFlushQuota(),
		historicalFloor: resolveHistoricalFlushFloor(),
	})
	const recorded = peekLatestState()

	const latencyAvg =
		flushPlan.realtimeLatencyMs.length > 0
			? Math.round(flushPlan.realtimeLatencyMs.reduce((a, b) => a + b, 0) / flushPlan.realtimeLatencyMs.length)
			: 0
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] flush plan rtBatches=${flushPlan.realtimeBatchCount} histBatches=${flushPlan.historicalBatchCount} ` +
				`historyProgressing=${flushPlan.historyStillProgressing ? 1 : 0} rtLatencyAvgMs=${latencyAvg} ` +
				`pending=${recorded.pending.length} histCursor=${recorded.historicalCursor} rtCursor=${recorded.realtimeCursor} ` +
					`gasPrice=${ethers.formatUnits(gasPrice, 'gwei')}gwei`
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
			const chk = await checkBatchUnconsumedFinalized(provider, readContract, sub)
			if (chk.consumed.length) {
				logger(Colors.yellow(`[validatorClRewardPayout] batch pre-check: ${chk.consumed.length} finalized consumed; retained until exact intent recovery`))
			}
			if (chk.unknown.length) {
				logger(Colors.yellow(`[validatorClRewardPayout] batch pre-check: ${chk.unknown.length} unknown (RPC error); not signed this tick`))
			}
			if (chk.payable.length) {
				// The RPC await above may have let a merge remove a key or own it: re-check against the latest state.
				const liveNow = signableKeySet(peekLatestState())
				const payable = chk.payable.filter((e) => liveNow.has(e.eventKey))
				if (payable.length) await submitPayoutBatchAutoSplit(contractAddr, payable, gasPrice, provider, readContract)
			}
		}
	}

	if (!peekLatestState().pending.length) {
		return
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
	flushTestHooks.onScanCommit?.({ line, from, okThrough })
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

/**
 * Flush job watchdog. A flush job that is still unsettled after the cap is ALERTed and counted, and the ALERT repeats
 * every cap while the job stays open. The watchdog only observes: it never releases the signing lane and never starts
 * a new job or re-signs a batch (a second signature for the same keys could pay twice). Manual handling only.
 * Default cap = 1 200 000 ms = 5 x one batch budget (flush 60 s + sign 60 s + receipt 120 s). A normal job takes seconds.
 */
const FLUSH_JOB_WATCHDOG_DEFAULT_MS = 1_200_000
type FlushJobWatch = {
	startedAt: number
	capMs: number
	alerts: number
	settled: boolean
	timer?: ReturnType<typeof setTimeout>
}
/** At most one flush job exists at a time (the flush lane), so one record is enough. */
let flushJobWatch: FlushJobWatch | null = null
/** ALERTs raised since process start (in memory; the ledger format is not changed). */
let flushWatchdogAlerts = 0

function resolveFlushJobWatchdogMs(): number {
	if (flushTestHooks.flushJobWatchdogMs !== undefined) return flushTestHooks.flushJobWatchdogMs
	const n = Number(process.env.CONET_VALIDATOR_CL_FLUSH_JOB_WATCHDOG_MS || FLUSH_JOB_WATCHDOG_DEFAULT_MS)
	return Number.isFinite(n) && n >= 60_000 ? Math.min(86_400_000, Math.floor(n)) : FLUSH_JOB_WATCHDOG_DEFAULT_MS
}

function formatWatchMs(ms: number): string {
	return ms < 1_000 ? `${Math.floor(ms)}ms` : `${Math.floor(ms / 1_000)}s`
}

function armFlushJobWatch(w: FlushJobWatch): void {
	w.timer = setTimeout(() => {
		if (w.settled) return
		w.alerts += 1
		flushWatchdogAlerts += 1
		logger(
			Colors.red(
				`[validatorClRewardPayout] ALERT flush job unsettled for ${formatWatchMs(Date.now() - w.startedAt)} ` +
					`(cap ${formatWatchMs(w.capMs)}; alert #${w.alerts}, total ${flushWatchdogAlerts}). ` +
					'Signing lane stays busy: not released, not re-signed. Manual check required.'
			)
		)
		armFlushJobWatch(w)
	}, w.capMs)
	w.timer.unref()
}

/** Read-only status for ops and tests: ALERT count since process start, and whether a flush job is open. */
export function flushWatchdogStatus(): { alerts: number; jobOpen: boolean; jobAgeMs: number; capMs: number | null } {
	return {
		alerts: flushWatchdogAlerts,
		jobOpen: flushJobWatch !== null,
		jobAgeMs: flushJobWatch ? Date.now() - flushJobWatch.startedAt : 0,
		capMs: flushJobWatch ? flushJobWatch.capMs : null,
	}
}

/** H is fixed once per process start. A restart (or a test restart via __engHarnessResetStateCache) starts a new generation. */
let bootFixed = false
let bootFixing: Promise<boolean> | null = null
let bootGen = 0

/** Hash of the block at height `n`, or '' when the block is missing, has another height, or its hash is malformed. */
function blockHashAtHeight(block: RpcBlock | null, n: number): string {
	if (!block || typeof block.number !== 'string' || typeof block.hash !== 'string') return ''
	let height: bigint
	try {
		height = BigInt(block.number)
	} catch {
		return ''
	}
	if (height !== BigInt(n)) return ''
	const hash = block.hash.toLowerCase()
	return /^0x[0-9a-f]{64}$/.test(hash) ? hash : ''
}

/**
 * Fix H for this process start from the live confirmed block (candidate = liveHead − depth). The block number and its
 * hash come from the same block. If that block cannot be read, or reports another height, the result is UNKNOWN:
 * nothing changes and nothing falls back to the tip hash.
 */
async function fixBoundaryFromLiveHead(
	provider: ethers.JsonRpcProvider,
	liveHead: number,
	depth: number,
	gen: number
): Promise<boolean> {
	const n = Math.max(0, liveHead - depth)
	const block = await fetchBlockWithWithdrawals(provider, n)
	const hash = blockHashAtHeight(block, n)
	if (!hash) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] H candidate ${n}: hash unavailable or height mismatch; UNKNOWN, boundary unchanged this step`
			)
		)
		return false
	}
	let held = false
	await mutateState((s) => {
		const fixed = fixBoundaryAtStart(s, { blockNumber: n, blockHash: hash })
		held = fixed.held
		return fixed.state
	})
	if (held) {
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] H candidate ${n} is below a ledger cursor; held until the head moves past it (H never goes backward)`
			)
		)
		return false
	}
	const after = peekLatestState()
	if (gen === bootGen) bootFixed = true
	logger(
		Colors.cyan(
			`[validatorClRewardPayout] fixed H=${n} hash=${hash.slice(0, 14)}… histCursor=${after.historicalCursor} ` +
				`rtCursor=${after.realtimeCursor} spans=${(after.metrics.realtimeSpans ?? []).length} depth=${depth}`
		)
	)
	return true
}

/**
 * Every scan step: (1) reorg check of the current boundary H. An unreadable block or a wrong height is UNKNOWN, never a
 * reorg. (2) Fix H once per process start, single-flight, so no line scans before H is fixed.
 * Returns false when H is not fixed yet; the step then does nothing.
 */
async function checkAndLockBoundary(provider: ethers.JsonRpcProvider, liveHead: number, depth: number): Promise<boolean> {
	const boundary = peekLatestState().boundaryH
	if (boundary) {
		const hBlock = await fetchBlockWithWithdrawals(provider, boundary.blockNumber)
		const hHash = blockHashAtHeight(hBlock, boundary.blockNumber)
		if (!hHash) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] reorg check H=${boundary.blockNumber}: hash unavailable or height mismatch; UNKNOWN, not a reorg`
				)
			)
		} else if (hHash !== boundary.blockHash) {
			logger(
				Colors.yellow(
					`[validatorClRewardPayout] reorg vs H=${boundary.blockNumber}: stored=${boundary.blockHash.slice(0, 12)}… live=${hHash.slice(0, 12)}…`
				)
			)
			// Roll back only the boundary this mismatch was detected on; otherwise leave the latest state alone.
			// Roll back to the safe point H-1: its hash is read from the live chain now. Unreadable => UNKNOWN, no rollback.
			const cut = boundary.blockNumber - 1
			const cutBlock = cut >= 0 ? await fetchBlockWithWithdrawals(provider, cut) : null
			const cutHash = cut >= 0 ? blockHashAtHeight(cutBlock, cut) : ''
			if (!cutHash) {
				logger(
					Colors.yellow(
						`[validatorClRewardPayout] reorg safe point ${cut}: hash unavailable or height mismatch; UNKNOWN, rollback deferred`
					)
				)
			} else {
				await mutateState((s) =>
					s.boundaryH &&
					s.boundaryH.blockNumber === boundary.blockNumber &&
					s.boundaryH.blockHash === boundary.blockHash
						? applyReorgRollback(s, boundary.blockNumber, { blockNumber: cut, blockHash: cutHash })
						: s
				)
				logger(
					Colors.yellow(
						`[validatorClRewardPayout] rolled back to safe point H=${cut} hash=${cutHash.slice(0, 14)}…; rows above it are rescanned`
					)
				)
			}
		}
	}
	if (bootFixed) return true
	if (!bootFixing) {
		const gen = bootGen
		bootFixing = fixBoundaryFromLiveHead(provider, liveHead, depth, gen).finally(() => {
			bootFixing = null
		})
	}
	return bootFixing
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
	if (!(await checkAndLockBoundary(provider, liveHead, depth))) return

	// History never scans a block a realtime span already completed: it jumps the cursor over the span (no RPC, no rows).
	if (kind === 'historical' && needsSpanSkip(peekLatestState())) {
		const before = peekLatestState()
		const after = await mutateState((s) => skipHistoricalOverSpans(s))
		flushTestHooks.onSpanSkip?.({ from: before.historicalCursor + 1, to: after.historicalCursor })
		logger(
			Colors.cyan(
				`[validatorClRewardPayout] history skipped realtime-complete span ${before.historicalCursor + 1}..${after.historicalCursor} (not rescanned)`
			)
		)
	}

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
	if (reporterStopping) return 'busy'
	if (workerBusy[kind]) return 'busy'
	if (kind === 'flush') {
		const state = peekLatestState()
		if (!hasAvailableSyntheticSignerPermit(state) && !canContinuePaymentRead(state)) return 'done'
	}
	workerBusy[kind] = true
	const run = ++workerRun[kind]
	// The flush job is watched from its start. The watchdog observes only (see armFlushJobWatch).
	const watch: FlushJobWatch | null =
		kind === 'flush' ? { startedAt: Date.now(), capMs: resolveFlushJobWatchdogMs(), alerts: 0, settled: false } : null
	if (watch) {
		flushJobWatch = watch
		armFlushJobWatch(watch)
	}
	const job = (async () => {
		const proxyAddr = resolveValidatorDepositRedeemAddress()
		if (!proxyAddr) {
			logger(Colors.yellow('[validatorClRewardPayout] CONET_VALIDATOR_DEPOSIT_REDEEM not configured — skip'))
			return
		}
		const provider = createClaimRpcProvider()
		await requireClaimChain(provider)
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
	activeReporterJobs.add(job)
	void job.then(() => activeReporterJobs.delete(job), () => activeReporterJobs.delete(job))
	if (watch) {
		void job.then(() => {
			watch.settled = true
			if (watch.timer !== undefined) clearTimeout(watch.timer)
			if (flushJobWatch === watch) flushJobWatch = null
			if (watch.alerts > 0) {
				logger(
					Colors.cyan(
						`[validatorClRewardPayout] flush job settled after ${formatWatchMs(Date.now() - watch.startedAt)} (ALERTed ${watch.alerts} time(s) before settling)`
					)
				)
			}
		})
	}
	const timeoutMs = resolveWorkerRpcTimeoutMs()
	let timer: ReturnType<typeof setTimeout> | undefined
	const outcome = await Promise.race<'done' | 'timeout'>([
		job.then(() => 'done' as const),
		new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), timeoutMs)
		}),
	])
	if (timer !== undefined) clearTimeout(timer)
	if (outcome === 'timeout' && kind === 'flush') {
		// The signing lane is never released while a batch may still be in the signer: the next flush step waits
		// for this job to settle (a timed-out batch is still signing or waiting for its receipt, so a second batch
		// must not start and must not take another nonce).
		void job.then(() => {
			workerBusy[kind] = false
			logger(Colors.cyan(`[validatorClRewardPayout] flush job settled after timeout; signing lane released`))
		})
		logger(
			Colors.yellow(
				`[validatorClRewardPayout] flush step exceeded ${timeoutMs}ms: signing lane stays busy until the job settles (no overlapping batch)`
			)
		)
	} else if (outcome === 'timeout') {
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
	if (reporterStopping || reporterStopPromise) throw new Error('STATE_WRITER_STOP_DRAIN_IN_PROGRESS')
	if (residentStateWriterLease) throw new Error('STATE_WRITER_LEASE_RETAINED; manual review required before restart')
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
	const lease = acquireStateWriterLease(resolveStateFile())
	residentStateWriterLease = lease
	try {
		const initialState = loadState()
		stateCache = { file: lease.filePath, state: initialState }
		reporterCacheVersion += 1
		reporterCacheHasDurableWriteProof = false
		invalidatePreaggregatedProjection('resident-start')
	} catch (e) {
		logger(Colors.red(`[validatorClRewardPayout] refusing to start: ${(e as Error).message} (state untouched)`))
		try {
			lease.release()
			residentStateWriterLease = null
		} catch {
			// Preserve the lease if its ownership or cleanup is uncertain.
		}
		throw e
	}
	residentWriterAcceptingMutations = true
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

/**
 * Hard-off resident for a stopped-payment fallback package. It takes the existing
 * cross-process writer lease, validates the exact persisted schema, sets the
 * durable STOP bit (migrating only the supported legacy schema), and keeps the
 * lease for its lifetime. It never starts scan or payout workers and does not
 * consult payment-enable or RPC environment variables.
 */
export function startStoppedPaymentFallback(): 'STOP_ALREADY_TRUE' | 'STOP_PERSISTED' | 'LEGACY_MIGRATED_AND_STOPPED' {
	if (payoutStarted || reporterStopping || reporterStopPromise || residentStateWriterLease || activeStateWriterLease || stateWriteUncertain) {
		throw new Error('STOPPED_FALLBACK_STATE_WRITER_ALREADY_ACTIVE')
	}
	const file = resolveStateFile()
	const lease = acquireStateWriterLease(file)
	residentStateWriterLease = lease
	activeStateWriterLease = lease
	let writeStarted = false
	try {
		assertStateWriterLeaseCurrent()
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
		let text: Buffer
		try {
			const before = fs.fstatSync(fd)
			// Covers the documented 261 MB ledger size with headroom while bounding
			// JSON parse/stringify memory use. Larger files fail closed before write.
			const maxBytes = 320 * 1024 * 1024
			if (!before.isFile() || before.nlink !== 1 || before.size < 2) {
				throw new Error('STOPPED_FALLBACK_STATE_FILE_METADATA_INVALID')
			}
			if (before.size > maxBytes) throw new Error('STOPPED_FALLBACK_STATE_FILE_TOO_LARGE')
			const buffer = Buffer.alloc(before.size + 1)
			let length = 0
			while (length < buffer.length) {
				const count = fs.readSync(fd, buffer, length, buffer.length - length, null)
				if (count === 0) break
				length += count
			}
			const after = fs.fstatSync(fd)
			if (length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
				after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
				after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink) {
				throw new Error('STOPPED_FALLBACK_STATE_FILE_CHANGED_DURING_READ')
			}
			text = buffer.subarray(0, length)
		} finally {
			fs.closeSync(fd)
		}
		assertStateWriterLeaseCurrent()
		let raw: unknown
		try {
			raw = JSON.parse(text.toString('utf8'))
		} catch {
			throw new Error('STOPPED_FALLBACK_STATE_PARSE_FAILED')
		}
		const floor = Math.max(-1, resolveDeployBlockFloor() - 1)
		assertLoadableState(raw, floor)
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('STOPPED_FALLBACK_STATE_ROOT_INVALID')
		const original = raw as Record<string, unknown>
		let next: DualCursorState
		let result: 'STOP_ALREADY_TRUE' | 'STOP_PERSISTED' | 'LEGACY_MIGRATED_AND_STOPPED'
		if (original.version === undefined) {
			const legacy = original as LegacyClPayoutState
			const migratedBase = migrateLegacyToDualCursor(legacy, resolveDeployBlockFloor())
			const migrated: DualCursorState = {
				...migratedBase,
				...(legacy.firstBatchSettledWei !== undefined ? { firstBatchSettledWei: legacy.firstBatchSettledWei } : {}),
				...(legacy.gasWaitStartedAt !== undefined ? { gasWaitStartedAt: legacy.gasWaitStartedAt } : {}),
				...(legacy.updatedAt !== undefined ? { updatedAt: legacy.updatedAt } : {}),
				...(legacy.scanTargetBlock !== undefined ? { scanTargetBlock: legacy.scanTargetBlock } : {}),
			}
			const oldPending = Array.isArray(original.pending) ? original.pending as Array<Record<string, unknown>> : []
			const pendingPreserved = migrated.pending.length === oldPending.length && oldPending.every((row, index) => {
				const nextRow = migrated.pending[index]
				try {
					return BigInt(String(row.guardianId)) === BigInt(nextRow.guardianId) &&
						BigInt(String(row.amount)) === BigInt(nextRow.amount) &&
						String(row.eventKey).toLowerCase() === nextRow.eventKey.toLowerCase() &&
						Number(row.blockNumber) === nextRow.blockNumber &&
						Number(row.withdrawalIndex) === nextRow.withdrawalIndex &&
						(row.scanLine ?? 'historical') === (nextRow.scanLine ?? 'historical') &&
						(row.enqueuedAtMs === undefined || row.enqueuedAtMs === nextRow.enqueuedAtMs)
				} catch {
					return false
				}
			})
			if (!pendingPreserved) {
				throw new Error('STOPPED_FALLBACK_LEGACY_PENDING_MISMATCH')
			}
			if ((original.firstBatchSettledWei !== undefined && migrated.firstBatchSettledWei !== original.firstBatchSettledWei) ||
				(original.gasWaitStartedAt !== undefined && migrated.gasWaitStartedAt !== original.gasWaitStartedAt) ||
				(original.updatedAt !== undefined && migrated.updatedAt !== original.updatedAt) ||
				(original.scanTargetBlock !== undefined && migrated.scanTargetBlock !== original.scanTargetBlock)) {
				throw new Error('STOPPED_FALLBACK_LEGACY_PAYLOAD_MISMATCH')
			}
			next = { ...migrated, signerControl: { stop: true } }
			result = 'LEGACY_MIGRATED_AND_STOPPED'
		} else {
			const control = original.signerControl as SignerControlState | undefined
			if (control?.stop === true) {
				next = original as unknown as DualCursorState
				result = 'STOP_ALREADY_TRUE'
			} else {
				next = {
					...(original as unknown as DualCursorState),
					signerControl: { ...(control ?? {}), stop: true },
				}
				result = 'STOP_PERSISTED'
			}
		}
		if (result !== 'STOP_ALREADY_TRUE') {
			assertLoadableState(next, floor)
			writeStarted = true
			atomicWriteState(file, next)
			lease.updateLedgerIdentity()
			stateCache = { file, state: next }
			reporterCacheVersion += 1
			reporterCacheHasDurableWriteProof = true
			invalidatePreaggregatedProjection('stopped-fallback-commit')
		}
		residentWriterAcceptingMutations = false
		return result
	} catch (error) {
		if (writeStarted || error instanceof StateWriteUncertainError) {
			stateWriteUncertain = error instanceof StateWriteUncertainError
				? error
				: new StateWriteUncertainError('stopped fallback commit uncertain; writer lease retained', true, { cause: error })
			residentStateWriterLease = lease
			residentWriterAcceptingMutations = false
			throw stateWriteUncertain
		}
		try {
			lease.release()
			residentStateWriterLease = null
		} catch (releaseError) {
			stateWriteUncertain = new StateWriteUncertainError('stopped fallback refusal; lease release uncertain', false, { cause: releaseError })
			residentStateWriterLease = lease
			throw stateWriteUncertain
		}
		throw error
	} finally {
		activeStateWriterLease = null
	}
}

export async function stopValidatorClRewardPayoutReporter(): Promise<void> {
	if (reporterStopPromise) return reporterStopPromise
	reporterStopping = true
	payoutStarted = false
	for (const kind of WORKER_KINDS) {
		const t = workerTimers[kind]
		if (t !== undefined) clearTimeout(t)
		delete workerTimers[kind]
	}
	reporterStopPromise = (async () => {
		while (activeReporterJobs.size > 0) await Promise.all([...activeReporterJobs])
		residentWriterAcceptingMutations = false
		await stateQueue
		if (stateWriteUncertain) throw new Error('STATE_WRITE_UNCERTAIN; resident writer lease retained')
		const lease = residentStateWriterLease
		if (lease) {
			lease.release()
			residentStateWriterLease = null
		}
	})()
	try {
		await reporterStopPromise
	} finally {
		if (!residentStateWriterLease && !stateWriteUncertain) {
			reporterStopping = false
			reporterStopPromise = null
		}
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
	await requireClaimChain(provider)
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

/**
 * Test harness: simulate a process restart by dropping the committed-state cache; the next read reloads the ledger file.
 * A restart also starts a new generation, so the next scan step fixes H again (as a new process does).
 */
export function __engHarnessResetStateCache(): void {
	stateCache = null
	reporterCacheHasDurableWriteProof = false
	reporterCacheVersion += 1
	preaggregateSyntheticMode = false
	preaggregateBuildGateForTest = null
	invalidatePreaggregatedProjection('cache-reset')
	bootGen += 1
	bootFixed = false
	bootFixing = null
}
