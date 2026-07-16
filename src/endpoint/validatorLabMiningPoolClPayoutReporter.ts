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
 *   - on-chain consumedRewardEventKey is false (guardian settleNodeRewards already paid)
 *
 * Payout: Redeem.withdrawNative(miningPool, batchTotal) via contract admin (onlyAdmin).
 * Idempotency: off-chain state consumedEventKeys + principal ceiling before each tx.
 *
 * Pending pool + gas gate (aligned with validatorClRewardPayoutReporter):
 *   - Scanned skim entries merge into a persisted pending pool; scan checkpoint advances without settle.
 *   - Flush when eth_gasPrice ≤ max (default 2 gwei); failed batches stay in pending.
 *   - If gas stays above max longer than force-wait (default 3 min), flush at live gasPrice anyway.
 *
 * Scan (parallel every tick / every process start):
 *   • listening — always scan current liveHead; when backfill has reached liveHead-1, persist lastListeningEndBlock=liveHead
 *   • backfill   — [sessionBackfillFloor .. liveHead-1] where sessionBackfillFloor = lastListeningEndBlock+1 | pool deploy block
 *
 * Next restart: backfill lower bound = persisted lastListeningEndBlock+1; upper bound = new liveHead-1 (dynamic).
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
import { enqueueOnchainTxWork, onchainTxLaneForSigner } from '../onchainTxSerialQueue'

function resolveLabRpcUrl(): string {
	return (
		process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
		process.env.CONET_RPC_URL?.trim() ||
		CONET_RPC_URL
	)
}

function resolveLabRedeemAddress(): string {
	const raw = process.env.CONET_VALIDATOR_DEPOSIT_REDEEM?.trim() || CONET_VALIDATOR_DEPOSIT_REDEEM
	try {
		const a = ethers.getAddress(raw)
		if (a === ethers.ZeroAddress) return CONET_VALIDATOR_DEPOSIT_REDEEM
		return a
	} catch {
		return CONET_VALIDATOR_DEPOSIT_REDEEM
	}
}

const VALIDATOR_STAKE_WEI = 32n * 10n ** 18n
/** Per-withdrawal skim ceiling: CL rewards are ≪ 1 CNET; anything ≥ floor is principal/exit, not skim. */
const DEFAULT_SKIM_MAX_WITHDRAWAL_WEI = 10n ** 18n

const LAB_SKIM_ELIGIBLE_STATUS = 'active_ongoing' as const

const READ_ABI = [
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
	'function getRewardPayoutStats() view returns (uint256 stakedCount, uint256 rewardPaidTotal, uint256 contractBalance, uint256 principalReserve)',
] as const

const WRITE_ABI = [
	'function withdrawNative(address to, uint256 amount) external',
	'function admins(address) view returns (bool)',
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

type LabPendingEntryJson = {
	eventKey: string
	amount: string
	blockNumber: number
	withdrawalIndex: number
	pubkey: string
}

type LabClPayoutState = {
	/** Backfill cursor (inclusive high-water within [sessionBackfillFloor .. liveHead-1]). */
	lastBackfillProcessedBlock: number
	/** @deprecated migrated to lastBackfillProcessedBlock */
	lastProcessedBlock?: number
	/** Listening checkpoint: next restart backfills from this block + 1. Set when backfill ≥ liveHead-1. */
	lastListeningEndBlock?: number
	/** Last liveHead block scanned by listening pass (tip tracking; may run ahead of backfill). */
	lastLiveHeadScanned?: number
	/** Unsettled skim entries (persisted); flushed when gas ≤ max or force-wait expires. */
	pending?: LabPendingEntryJson[]
	/**
	 * ISO timestamp when pending first hit gasPrice > max gate (persisted).
	 * Cleared when pending is empty or gas drops back under the cap.
	 */
	gasWaitStartedAt?: string
	consumedEventKeys: Record<string, true>
	exitedPubkeys: Record<string, true>
	updatedAt: string
}

type SkimEntry = {
	eventKey: string
	amount: bigint
	blockNumber: number
	withdrawalIndex: number
	pubkey: string
}

let labStarted = false
let labTimer: ReturnType<typeof setTimeout> | undefined
let labInFlight = false
let labPubkeySet = new Set<string>()
let labMiningPool = ''
let labManifestMtime = 0
let labPhaseLogged = false
let labSessionState: LabClPayoutState | undefined
/** Frozen at process start: max(lastListeningEndBlock+1, pool deploy block). */
let sessionBackfillFloor: number | undefined

function resolveManifestPath(): string {
	return (
		process.env.CONET_LAB_MINING_POOL_PUBKEYS_FILE?.trim() ||
		path.join(process.cwd(), 'deployments/conet-lab-mining-pool-pubkeys.json')
	)
}

function resolveStateFile(): string {
	return (
		process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-lab-mining-pool-cl-payout-state.json')
	)
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
	const gwei = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI || 2)
	const safe = Number.isFinite(gwei) && gwei > 0 ? gwei : 2
	return ethers.parseUnits(String(safe), 'gwei')
}

/** After this many ms waiting on high gas, force flush at live gasPrice (default 3 min). */
function resolveGasWaitForceMs(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS || 180_000)
	return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 180_000
}

function resolveWithdrawGasLimit(): number {
	const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT || 800_000)
	return Number.isFinite(n) && n >= 100_000 ? Math.min(8_000_000, Math.floor(n)) : 800_000
}

function clearGasWait(state: LabClPayoutState): boolean {
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

function skimEntryToJson(e: SkimEntry): LabPendingEntryJson {
	return {
		eventKey: e.eventKey.toLowerCase(),
		amount: e.amount.toString(),
		blockNumber: e.blockNumber,
		withdrawalIndex: e.withdrawalIndex,
		pubkey: e.pubkey.toLowerCase(),
	}
}

function skimEntryFromJson(raw: LabPendingEntryJson): SkimEntry | null {
	try {
		const eventKey = String(raw.eventKey || '').toLowerCase()
		if (!eventKey || eventKey === ethers.ZeroHash) return null
		const amount = BigInt(raw.amount)
		if (amount <= 0n) return null
		const blockNumber = Number(raw.blockNumber)
		const withdrawalIndex = Number(raw.withdrawalIndex)
		const pubkey = String(raw.pubkey || '').toLowerCase()
		if (!Number.isFinite(blockNumber) || !Number.isFinite(withdrawalIndex) || !pubkey) return null
		return { eventKey, amount, blockNumber, withdrawalIndex, pubkey }
	} catch {
		return null
	}
}

function loadPendingMap(state: LabClPayoutState): Map<string, SkimEntry> {
	const map = new Map<string, SkimEntry>()
	for (const raw of state.pending ?? []) {
		const e = skimEntryFromJson(raw)
		if (!e) continue
		map.set(e.eventKey, e)
	}
	return map
}

function persistPending(state: LabClPayoutState, pending: Map<string, SkimEntry>): void {
	state.pending = [...pending.values()]
		.sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
		.map(skimEntryToJson)
	writeState(state)
}

function mergeIntoPending(pending: Map<string, SkimEntry>, entries: SkimEntry[]): number {
	let added = 0
	for (const e of entries) {
		const key = e.eventKey.toLowerCase()
		if (pending.has(key)) continue
		pending.set(key, { ...e, eventKey: key })
		added++
	}
	return added
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

function markLabValidatorExited(state: LabClPayoutState, pubkey: string): void {
	state.exitedPubkeys[pubkey.toLowerCase()] = true
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
function resolveSessionBackfillFloor(state: LabClPayoutState): number {
	const lastListen = normalizeScanBlock(state.lastListeningEndBlock)
	if (lastListen != null) return lastListen + 1
	return resolveLabScanFloorBlock()
}

function migrateLegacyStateFields(state: LabClPayoutState): void {
	if (state.lastBackfillProcessedBlock == null) {
		const legacy = normalizeScanBlock(state.lastProcessedBlock)
		state.lastBackfillProcessedBlock =
			legacy != null ? legacy : resolveSessionBackfillFloor(state) - 1
	}
	delete state.lastProcessedBlock
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	delete (state as any).phase
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	delete (state as any).scanTargetBlock
}

function alignBackfillCursorForSession(state: LabClPayoutState, floor: number): void {
	if (state.lastBackfillProcessedBlock < floor - 1) {
		state.lastBackfillProcessedBlock = floor - 1
	}
}

function tryPersistListeningCheckpoint(state: LabClPayoutState, liveHead: number): void {
	const upper = resolveBackfillUpperBound(liveHead)
	if (state.lastBackfillProcessedBlock < upper) return
	if (state.lastLiveHeadScanned !== liveHead) return
	const prev = state.lastListeningEndBlock
	state.lastListeningEndBlock = liveHead
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

function readStateFromDisk(): LabClPayoutState {
	const file = resolveStateFile()
	const floor = resolveLabScanFloorBlock()
	const empty: LabClPayoutState = {
		lastBackfillProcessedBlock: floor - 1,
		consumedEventKeys: {},
		exitedPubkeys: {},
		updatedAt: new Date().toISOString(),
	}
	try {
		if (!fs.existsSync(file)) return empty
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LabClPayoutState
		const state: LabClPayoutState = {
			lastBackfillProcessedBlock:
				normalizeScanBlock(raw.lastBackfillProcessedBlock) ??
				normalizeScanBlock(raw.lastProcessedBlock) ??
				floor - 1,
			lastProcessedBlock: normalizeScanBlock(raw.lastProcessedBlock),
			lastListeningEndBlock: normalizeScanBlock(raw.lastListeningEndBlock),
			lastLiveHeadScanned: normalizeScanBlock(raw.lastLiveHeadScanned),
			pending: Array.isArray(raw.pending) ? raw.pending : [],
			gasWaitStartedAt:
				typeof raw.gasWaitStartedAt === 'string' && raw.gasWaitStartedAt.trim()
					? raw.gasWaitStartedAt.trim()
					: undefined,
			consumedEventKeys: raw.consumedEventKeys && typeof raw.consumedEventKeys === 'object' ? raw.consumedEventKeys : {},
			exitedPubkeys: raw.exitedPubkeys && typeof raw.exitedPubkeys === 'object' ? raw.exitedPubkeys : {},
			updatedAt: raw.updatedAt ?? new Date().toISOString(),
		}
		migrateLegacyStateFields(state)
		return state
	} catch (e: unknown) {
		logger(Colors.yellow(`[labMiningPoolClPayout] state reset: ${(e as Error)?.message ?? e}`))
		return empty
	}
}

/** Process boot: parallel listen+backfill; resume backfill cursor; freeze session floor from lastListeningEndBlock. */
function initLabSessionState(): LabClPayoutState {
	const state = readStateFromDisk()
	sessionBackfillFloor = resolveSessionBackfillFloor(state)
	alignBackfillCursorForSession(state, sessionBackfillFloor)
	writeState(state)
	return state
}

function getLabSessionState(): LabClPayoutState {
	if (!labSessionState) labSessionState = initLabSessionState()
	return labSessionState
}

function writeState(state: LabClPayoutState): void {
	const file = resolveStateFile()
	state.updatedAt = new Date().toISOString()
	if (!Array.isArray(state.pending)) state.pending = []
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
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
	labMiningPool =
		raw.miningPool?.trim() ||
		process.env.CONET_LAB_MINING_POOL_ADDRESS?.trim() ||
		'0x32bE583C8e778FFfC5107BF34820c2B225336201'
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
		if (!res.ok) {
			validatorPubkeyCache.set(validatorIndex, null)
			validatorStatusCache.set(validatorIndex, null)
			return { pubkey: null, status: null }
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
	} catch {
		return { pubkey: null, status: null }
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

function resolveAdminPrivateKey(): string | undefined {
	const file = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_ADMIN_PRIVATE_KEY_FILE?.trim()
	if (file && fs.existsSync(file)) {
		const pk = fs.readFileSync(file, 'utf8').trim()
		return pk.startsWith('0x') ? pk : `0x${pk}`
	}
	const inline = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_ADMIN_PRIVATE_KEY?.trim()
	if (inline) return inline.startsWith('0x') ? inline : `0x${inline}`

	const masterPath = path.join(homedir(), '.master.json')
	if (!fs.existsSync(masterPath)) return undefined
	try {
		const m = JSON.parse(fs.readFileSync(masterPath, 'utf8')) as Record<string, unknown>
		const pools = [
			...(Array.isArray(m.settle_contractAdmin) ? m.settle_contractAdmin : []),
			...(Array.isArray(m.beamio_Admins) ? m.beamio_Admins : []),
			...(Array.isArray(m.admin) ? m.admin : []),
		]
		for (const k of pools) {
			if (typeof k === 'string' && k.length > 0) {
				return k.startsWith('0x') ? k : `0x${k}`
			}
		}
	} catch {
		return undefined
	}
	return undefined
}

async function resolveMaxSkimPayoutWei(
	provider: ethers.JsonRpcProvider,
	redeemAddr: string,
	state: LabClPayoutState
): Promise<bigint> {
	const redeem = new ethers.Contract(redeemAddr, READ_ABI, provider)
	const stats = await redeem.getRewardPayoutStats!()
	const onChainReserve = BigInt(stats.principalReserve ?? stats[3] ?? 0)
	const balance = await provider.getBalance(redeemAddr)
	const exitedCount = Object.keys(state.exitedPubkeys).length
	const labActive = Math.max(0, labPubkeySet.size - exitedCount)
	const localReserve = VALIDATOR_STAKE_WEI * BigInt(labActive)
	const effectiveReserve = onChainReserve > localReserve ? onChainReserve : localReserve
	if (balance <= effectiveReserve) return 0n
	return balance - effectiveReserve
}

async function collectLabSkimEntriesForBlock(
	readContract: ethers.Contract,
	proxyLower: string,
	blockNumber: number,
	block: RpcBlock,
	state: LabClPayoutState
): Promise<SkimEntry[]> {
	const floorWei = resolveFullExitFloorWei()
	const entries: SkimEntry[] = []
	for (const w of block.withdrawals ?? []) {
		const addr = String(w.address ?? '').toLowerCase()
		if (addr !== proxyLower) continue
		const amountGwei = BigInt(String(w.amount ?? '0'))
		if (amountGwei <= 0n) continue
		const amountWei = amountGwei * 1_000_000_000n
		const validatorIndex = Number(w.validatorIndex)
		const withdrawalIndex = Number(w.index)
		if (!Number.isFinite(validatorIndex) || validatorIndex < 0) continue
		if (!Number.isFinite(withdrawalIndex) || withdrawalIndex < 0) continue

		const eventKey = withdrawalEventKey(blockNumber, withdrawalIndex)
		if (state.consumedEventKeys[eventKey]) continue
		if ((state.pending ?? []).some((p) => String(p.eventKey || '').toLowerCase() === eventKey.toLowerCase())) {
			continue
		}

		try {
			const consumedOnChain = await readContract.consumedRewardEventKey!(eventKey)
			if (consumedOnChain) {
				state.consumedEventKeys[eventKey] = true
				continue
			}
		} catch {
			continue
		}

		const { pubkey, status } = await fetchValidatorByIndex(validatorIndex)
		if (!pubkey || !labPubkeySet.has(pubkey)) continue

		if (isNonSkimWithdrawal(amountWei, floorWei)) {
			markLabValidatorExited(state, pubkey)
			state.consumedEventKeys[eventKey] = true
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] non-skim inflow (≥exit floor) block=${blockNumber} validator=${pubkey.slice(0, 14)}… amount=${ethers.formatEther(amountWei)} CNET status=${status ?? '?'}`
				)
			)
			continue
		}

		if (status !== LAB_SKIM_ELIGIBLE_STATUS) {
			markLabValidatorExited(state, pubkey)
			logger(
				Colors.gray(
					`[labMiningPoolClPayout] skip non-active validator block=${blockNumber} status=${status ?? '?'} pubkey=${pubkey.slice(0, 14)}…`
				)
			)
			continue
		}

		try {
			const pkHash = ethers.keccak256(pubkey)
			const guardianId = BigInt(await readContract.getNodeByValidatorPubkeyHash!(pkHash))
			if (guardianId > 0n) {
				const beneficiary = String(await readContract.guardianIdBeneficiary!(guardianId))
				// Active redeem guardian (beneficiary set) → validatorClRewardPayoutReporter on redeem listener host.
				if (beneficiary !== ethers.ZeroAddress) continue
			}
		} catch {
			continue
		}

		entries.push({ eventKey, amount: amountWei, blockNumber, withdrawalIndex, pubkey })
	}
	return entries
}

async function submitLabSkimBatch(
	provider: ethers.JsonRpcProvider,
	redeemAddr: string,
	entries: SkimEntry[],
	state: LabClPayoutState,
	gasPriceWei: bigint
): Promise<boolean> {
	if (!entries.length) return true
	const total = entries.reduce((a, e) => a + e.amount, 0n)
	if (total <= 0n) return true

	const maxPayout = await resolveMaxSkimPayoutWei(provider, redeemAddr, state)
	if (total > maxPayout) {
		logger(
			Colors.red(
				`[labMiningPoolClPayout] refuse batch total=${ethers.formatEther(total)} > maxSkim=${ethers.formatEther(maxPayout)}`
			)
		)
		return false
	}

	if (labDryRun()) {
		logger(
			Colors.cyan(
				`[labMiningPoolClPayout] dry-run withdrawNative(${labMiningPool}, ${ethers.formatEther(total)} CNET) n=${entries.length}`
			)
		)
		for (const e of entries) state.consumedEventKeys[e.eventKey] = true
		return true
	}

	const pk = resolveAdminPrivateKey()
	if (!pk) {
		logger(Colors.red('[labMiningPoolClPayout] missing contract admin key'))
		return false
	}

	const admin = new ethers.Wallet(pk, provider)
	const redeemWrite = new ethers.Contract(redeemAddr, WRITE_ABI, admin)
	if (!(await redeemWrite.admins!(admin.address))) {
		logger(Colors.red(`[labMiningPoolClPayout] signer ${admin.address} is not Redeem contract admin`))
		return false
	}

	const gasLimit = resolveWithdrawGasLimit()
	const intrinsicCost = BigInt(gasLimit) * gasPriceWei
	const bal = await provider.getBalance(admin.address)
	if (bal < intrinsicCost) {
		logger(
			Colors.yellow(
				`[labMiningPoolClPayout] skip flush: admin ${admin.address} balance=${ethers.formatEther(bal)} < intrinsic=${ethers.formatEther(intrinsicCost)} CNET`
			)
		)
		return false
	}

	const lane = onchainTxLaneForSigner(admin.address)
	try {
		await enqueueOnchainTxWork(
			lane,
			`labClSkim→pool n=${entries.length}`,
			async () => {
				// Legacy gasPrice: EIP-1559 tip=0 rejected on some CONET nodes; tip=1 can stall in mempool.
				const tx = await redeemWrite.withdrawNative!(labMiningPool, total, {
					gasLimit,
					gasPrice: gasPriceWei,
				})
				await tx.wait()
				logger(
					Colors.green(
						`[labMiningPoolClPayout] withdrawNative ok tx=${tx.hash} total=${ethers.formatEther(total)} CNET n=${entries.length}`
					)
				)
				for (const e of entries) state.consumedEventKeys[e.eventKey] = true
			},
			'[labMiningPoolClPayout]'
		)
		return true
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] withdrawNative failed: ${(e as Error)?.message ?? e}`))
		return false
	}
}

async function flushPendingLabBatches(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	redeemAddr: string,
	state: LabClPayoutState,
	pending: Map<string, SkimEntry>
): Promise<void> {
	if (!pending.size) {
		if (clearGasWait(state)) persistPending(state, pending)
		return
	}

	const maxGas = resolveMaxGasPriceWei()
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
					`[labMiningPoolClPayout] skip flush: gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei > max=${ethers.formatUnits(maxGas, 'gwei')} gwei ` +
						`wait ${formatWaitCountdown(elapsedMs, forceMs)} pending=${pending.size}`
				)
			)
			return
		}
		forceFlush = true
		logger(
			Colors.yellow(
				`[labMiningPoolClPayout] force flush: gas wait ${Math.floor(elapsedMs / 1000)}s ≥ ${Math.floor(forceMs / 1000)}s; ` +
					`ignoring max=${ethers.formatUnits(maxGas, 'gwei')} gwei, using live gasPrice=${ethers.formatUnits(gasPrice, 'gwei')} gwei (pending=${pending.size})`
			)
		)
	} else if (clearGasWait(state)) {
		persistPending(state, pending)
	}

	const ordered = [...pending.values()].sort(
		(a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex
	)
	const live: SkimEntry[] = []
	for (const e of ordered) {
		try {
			const consumed = Boolean(await readContract.consumedRewardEventKey!(e.eventKey))
			if (consumed) {
				state.consumedEventKeys[e.eventKey] = true
				pending.delete(e.eventKey)
				continue
			}
		} catch {
			/* keep entry */
		}
		live.push(e)
	}
	if (live.length !== ordered.length) {
		persistPending(state, pending)
		logger(
			Colors.cyan(
				`[labMiningPoolClPayout] dropped ${ordered.length - live.length} already-consumed eventKeys; pending=${pending.size}`
			)
		)
	}
	if (!live.length) {
		if (clearGasWait(state)) persistPending(state, pending)
		return
	}

	const maxPayout = await resolveMaxSkimPayoutWei(provider, redeemAddr, state)
	if (maxPayout <= 0n) {
		logger(
			Colors.yellow(
				`[labMiningPoolClPayout] skip flush: maxSkim=0 (principal reserve) pending=${pending.size}`
			)
		)
		return
	}

	// Pack prefix batches that fit under maxSkim (one withdrawNative per batch).
	const batches: SkimEntry[][] = []
	let cur: SkimEntry[] = []
	let curTotal = 0n
	for (const e of live) {
		if (e.amount > maxPayout) {
			logger(
				Colors.red(
					`[labMiningPoolClPayout] entry ${e.eventKey.slice(0, 14)}… amount=${ethers.formatEther(e.amount)} > maxSkim; leaving in pending`
				)
			)
			continue
		}
		if (cur.length && curTotal + e.amount > maxPayout) {
			batches.push(cur)
			cur = []
			curTotal = 0n
		}
		cur.push(e)
		curTotal += e.amount
	}
	if (cur.length) batches.push(cur)
	if (!batches.length) return

	logger(
		Colors.cyan(
			`[labMiningPoolClPayout] flush pending=${live.length} → ${batches.length} batch(es) ` +
				`gasPrice=${ethers.formatUnits(gasPrice, 'gwei')}gwei${forceFlush ? ' force=1' : ''}`
		)
	)

	for (const batch of batches) {
		const ok = await submitLabSkimBatch(provider, redeemAddr, batch, state, gasPrice)
		if (!ok) {
			logger(
				Colors.yellow(
					`[labMiningPoolClPayout] batch failed n=${batch.length}; remaining stay in pending pool (pending=${pending.size})`
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

async function processBlockRange(
	provider: ethers.JsonRpcProvider,
	readContract: ethers.Contract,
	redeemAddr: string,
	fromBlock: number,
	toBlock: number,
	state: LabClPayoutState,
	pending: Map<string, SkimEntry>
): Promise<{ okThrough: number | null; added: number; fetchFailed: boolean }> {
	const proxyLower = redeemAddr.toLowerCase()
	let okThrough: number | null = null
	let added = 0
	for (let bn = fromBlock; bn <= toBlock; bn++) {
		const block = await fetchBlockWithWithdrawals(provider, bn)
		if (!block) {
			return { okThrough, added, fetchFailed: true }
		}
		// Keep pending mirror on state so collectLabSkimEntriesForBlock can dedupe.
		state.pending = [...pending.values()].map(skimEntryToJson)
		const entries = await collectLabSkimEntriesForBlock(readContract, proxyLower, bn, block, state)
		added += mergeIntoPending(pending, entries)
		okThrough = bn
	}
	return { okThrough, added, fetchFailed: false }
}

function logSessionStartIfNeeded(state: LabClPayoutState, liveHead: number): void {
	if (labPhaseLogged) return
	labPhaseLogged = true
	const floor = sessionBackfillFloor ?? resolveSessionBackfillFloor(state)
	logger(
		Colors.cyan(
			`[labMiningPoolClPayout] parallel listen+backfill floor=${floor} backfill→${resolveBackfillUpperBound(liveHead)} (liveHead-1) listenHead=${liveHead} lastListen=${state.lastListeningEndBlock ?? 'none'} backfillCursor=${state.lastBackfillProcessedBlock}`
		)
	)
}

async function labPayoutTick(): Promise<void> {
	if (labInFlight) return
	labInFlight = true
	try {
		if (!loadManifestIfNeeded()) return

		const redeemAddr = resolveLabRedeemAddress()
		const provider = new ethers.JsonRpcProvider(resolveLabRpcUrl())
		const readContract = new ethers.Contract(redeemAddr, READ_ABI, provider)

		const state = getLabSessionState()
		const pending = loadPendingMap(state)
		const liveHead = Number(await provider.getBlockNumber())
		const floor = resolveLabScanFloorBlock()
		if (!Number.isFinite(liveHead) || liveHead < floor) return

		const backfillFloor = sessionBackfillFloor ?? resolveSessionBackfillFloor(state)
		const backfillUpper = resolveBackfillUpperBound(liveHead)

		logSessionStartIfNeeded(state, liveHead)

		// 1) Listening — always scan current chain head (does not wait for backfill).
		if (state.lastLiveHeadScanned !== liveHead) {
			const { okThrough, added, fetchFailed } = await processBlockRange(
				provider,
				readContract,
				redeemAddr,
				liveHead,
				liveHead,
				state,
				pending
			)
			if (!fetchFailed && okThrough === liveHead) {
				state.lastLiveHeadScanned = liveHead
				if (added > 0) {
					logger(
						Colors.cyan(
							`[labMiningPoolClPayout] listening queued +${added} (pending=${pending.size}) liveHead=${liveHead}`
						)
					)
				} else {
					logger(Colors.gray(`[labMiningPoolClPayout] listening liveHead=${liveHead}`))
				}
				persistPending(state, pending)
			}
		}

		// 2) Backfill — [sessionBackfillFloor .. liveHead-1] in chunks (parallel with listening).
		let backfillFrom = state.lastBackfillProcessedBlock + 1
		if (backfillFrom < backfillFloor) backfillFrom = backfillFloor
		if (backfillFrom <= backfillUpper) {
			const chunk = resolveChunkBlocks()
			const chunksPerTick = resolveChunksPerTick()
			const tickEnd = Math.min(backfillFrom + chunk * chunksPerTick - 1, backfillUpper)
			let from = backfillFrom
			while (from <= tickEnd) {
				const to = Math.min(from + chunk - 1, tickEnd)
				const { okThrough, added, fetchFailed } = await processBlockRange(
					provider,
					readContract,
					redeemAddr,
					from,
					to,
					state,
					pending
				)
				if (okThrough != null) {
					state.lastBackfillProcessedBlock = okThrough
					persistPending(state, pending)
					if (added > 0) {
						logger(
							Colors.cyan(
								`[labMiningPoolClPayout] backfill queued +${added} (pending=${pending.size}) ${from}-${okThrough} gap→head-1=${Math.max(0, backfillUpper - okThrough)}`
							)
						)
					} else {
						logger(
							Colors.gray(
								`[labMiningPoolClPayout] backfill ${from}-${okThrough} cursor=${okThrough} gap→head-1=${Math.max(0, backfillUpper - okThrough)}`
							)
						)
					}
				}
				if (fetchFailed || okThrough == null || okThrough < to) break
				from = to + 1
			}
		}

		await flushPendingLabBatches(provider, readContract, redeemAddr, state, pending)
		tryPersistListeningCheckpoint(state, liveHead)
		persistPending(state, pending)
	} catch (e: unknown) {
		logger(Colors.red(`[labMiningPoolClPayout] tick error: ${(e as Error)?.message ?? e}`))
	} finally {
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
	labSessionState = initLabSessionState()
	labStarted = true
	logger(
		Colors.cyan(
			`[labMiningPoolClPayout] starting pubkeys=${labPubkeySet.size} tick=${resolveTickMs()}ms ` +
				`maxGasGwei=${ethers.formatUnits(resolveMaxGasPriceWei(), 'gwei')} gasWaitForceMs=${resolveGasWaitForceMs()} pendingPool=on`
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
		const state = labSessionState ?? readStateFromDisk()
		const provider = new ethers.JsonRpcProvider(resolveLabRpcUrl())
		const liveHead = Number(await provider.getBlockNumber())
		if (Number.isFinite(liveHead)) {
			tryPersistListeningCheckpoint(state, liveHead)
		}
		writeState(state)
	} catch {
		/* best effort */
	}
}

export async function waitForLabMiningPoolClPayoutIdle(): Promise<void> {
	while (labInFlight) {
		await new Promise((r) => setTimeout(r, 250))
	}
}
