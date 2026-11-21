/**
 * The legacy (whole-state) persistence of the Lab payout reporter, moved out of the reporter in P2c-1 so that the reporter itself has no direct access to the pending / consumed / exited
 * collections (errata W6). Behaviour is exactly what the reporter did before: the state object is read from the v2 segmented directory, changed in memory and written whole by writeState.
 * Everything the reporter owns (paths, the cap, the scan floor, the fail-closed gate, the logger) comes in through LegacyStoreEnv.
 */
import fs from 'node:fs'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { assertCursorMonotonic, assertNoRemigration } from './labMiningPoolDualCursor'
import type { LabFreezeH } from './labMiningPoolDualCursor'
import { planPrune, consumedArchiveDir, appendConsumedArchive } from './labConsumedPrune'
import { inspectSegmentedDir, legacyStateFileExists, readSegmentedState, writeSegmentedState } from './labClPayoutStateStore'
import type { LabInFlightWithdraw } from './labClPayoutBatchLifecycle'
import { LegacyStateHandle } from './labStateHandle'

export type LabPendingEntryJson = {
	eventKey: string
	amount: string
	blockNumber: number
	withdrawalIndex: number
	pubkey: string
}

export type LabClPayoutState = {
	/** Backfill cursor (inclusive high-water within [sessionBackfillFloor .. liveHead-1]). */
	lastBackfillProcessedBlock: number
	/** @deprecated migrated to lastBackfillProcessedBlock */
	lastProcessedBlock?: number
	/** Listening checkpoint: next restart backfills from this block + 1. Set when backfill ≥ liveHead-1. */
	lastListeningEndBlock?: number
	/** Last liveHead block scanned by listening pass (tip tracking; may run ahead of backfill). */
	lastLiveHeadScanned?: number
	/** Dual-cursor freeze H (height + hash); set once, never moves. */
	freezeH?: LabFreezeH | null
	/** Inclusive last fully scanned history block (next = historyCursor + 1). */
	historyCursor?: number
	/** Inclusive last fully scanned realtime block (next = realtimeCursor + 1). */
	realtimeCursor?: number
	/** Unsettled skim entries (persisted); flushed when gas ≤ max or force-wait expires. */
	pending?: LabPendingEntryJson[]
	/**
	 * ISO timestamp when pending first hit gasPrice > max gate (persisted).
	 * Cleared when pending is empty or gas drops back under the cap.
	 */
	gasWaitStartedAt?: string
	/** Settled withdrawNative batches (persisted). Used by the optional one-shot limit MAX_SETTLED_BATCHES. */
	settledBatchCount?: number
	/** Monotonic high-water of the persisted cursors. A write or a startup below it is refused (cursor guard). */
	cursorHighWater?: { backfill?: number; listen?: number }
	/** withdrawNative batch composed and not yet settled (B-2). Written before the signer is asked to send. */
	inFlightWithdraw?: LabInFlightWithdraw | null
	/**
	 * Invariant C (labInvariantC.ts): monotonic high-water of the block of paid history entries. Only maintained while the invariant is on
	 * (HISTORY_PAY_BEHIND_CURSOR); absent otherwise. Must stay <= the committed history cursor.
	 */
	maxPaidHistoryBlock?: number
	consumedEventKeys: Record<string, true>
	exitedPubkeys: Record<string, true>
	updatedAt: string
}

export type SkimEntry = {
	eventKey: string
	/** bigint in the legacy in-memory pool; a decimal string when the entry comes from the WAL state (JSON events carry no bigint). Convert with BigInt(e.amount) where a number is needed. */
	amount: bigint | string
	blockNumber: number
	withdrawalIndex: number
	pubkey: string
}

export type LegacyStoreEnv = {
	stateFile(): string
	segmentedDir(): string
	consumedCap(): number
	scanFloor(): number
	/** The fail-closed gate: called with the error when a state write failed (B-3). */
	tripPersist(e: unknown): void
	logger(...args: unknown[]): void
}

const LAB_MIGRATION_SEED_LAST_PAID_REWARD_SOURCE_BLOCK = 2009199

function normalizeScanBlock(raw: unknown): number | undefined {
	if (raw == null) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

export function createLegacyStateStore(env: LegacyStoreEnv) {
	/** Inclusive first block for backfill on this process start. */
	function sessionBackfillFloor(lastListeningEndBlock: unknown): number {
		const lastListen = normalizeScanBlock(lastListeningEndBlock)
		if (lastListen != null) return lastListen + 1
		return env.scanFloor()
	}

	function pruneConsumedEventKeys(state: LabClPayoutState): number {
		const max = env.consumedCap()
		const keys = Object.keys(state.consumedEventKeys || {})
		if (keys.length <= max) return 0
		const pendingKeys = new Set((state.pending || []).map((e) => e.eventKey.toLowerCase()))
		const dropList = planPrune(keys, pendingKeys, max)
		if (!dropList.length) return 0
		// The dropped keys go to the cold archive first. If that fails nothing is pruned this time (retried at the next write).
		try {
			appendConsumedArchive(consumedArchiveDir(env.stateFile()), dropList)
		} catch (err: unknown) {
			env.logger(
				Colors.red(
					`[labMiningPoolClPayout] ALERT consumed archive failed (${dropList.length} keys not archived, nothing pruned): ${(err as Error)?.message ?? err}`
				)
			)
			return 0
		}
		const drop = new Set(dropList)
		const next: Record<string, true> = {}
		for (const k of keys) if (!drop.has(k)) next[k] = true
		state.consumedEventKeys = next
		return drop.size
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


	function migrateLegacyStateFields(state: LabClPayoutState): void {
		if (state.lastBackfillProcessedBlock == null) {
			const legacy = normalizeScanBlock(state.lastProcessedBlock)
			state.lastBackfillProcessedBlock =
				legacy != null ? legacy : sessionBackfillFloor(state.lastListeningEndBlock) - 1
		}
		delete state.lastProcessedBlock
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		delete (state as any).phase
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		delete (state as any).scanTargetBlock
	}

	/**
	 * Load persisted state. Fail closed: any read, parse or verification error throws, and the
	 * daemon does not start. It never returns an empty state for an existing file. Empty is only
	 * returned for a first start with no state at all.
	 */
	function readStateFromDisk(): LabClPayoutState {
		const file = env.stateFile()
		const dir = env.segmentedDir()
		const floor = env.scanFloor()
		const dirStatus = inspectSegmentedDir(dir)
		if (dirStatus === 'committed') {
			const state = readSegmentedState(dir) as unknown as LabClPayoutState
			migrateLegacyStateFields(state)
			// Startup cursor guard: a stored cursor below its persisted high-water mark means a rollback; refuse to start.
			const hw = state.cursorHighWater
			if (hw) {
				assertCursorMonotonic('lastBackfillProcessedBlock (startup vs high-water)', hw.backfill, state.lastBackfillProcessedBlock)
				assertCursorMonotonic('lastListeningEndBlock (startup vs high-water)', hw.listen, state.lastListeningEndBlock)
			}
			return state
		}
		// Orphan or committed v2 state beside a legacy file: refuse before any legacy path is considered.
		if (dirStatus === 'orphan') {
			throw new Error(
				`[labMiningPoolClPayout] state dir has files but no committed manifest: ${dir}; refusing to start with an empty state`
			)
		}
		assertNoRemigration(dirStatus, legacyStateFileExists(file))
		if (legacyStateFileExists(file)) {
			// Legacy single file: no manifest yet. Parse strictly. writeState() refuses to write
			// in this state, so startup stops until labClPayoutStateMigrate --apply has run.
			const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
				throw new Error(`[labMiningPoolClPayout] legacy state is not a JSON object: ${file}`)
			}
			const legacy = raw as LabClPayoutState
			const consumedOk =
				legacy.consumedEventKeys && typeof legacy.consumedEventKeys === 'object' && !Array.isArray(legacy.consumedEventKeys)
			if (!consumedOk) {
				throw new Error(`[labMiningPoolClPayout] legacy state has no consumedEventKeys object: ${file}`)
			}
			const state: LabClPayoutState = {
				// Migration seed: the last PAID reward source block (2,009,199), so the history line scans from 2,009,200 inclusive.
				// Not the legacy ledger's lastBackfillProcessedBlock, not a payment inclusion block. Paid status is NOT read from the chain
				// for withdrawNative: the chain only exposes consumedRewardEventKey for settleNodeRewards. withdrawNative-paid keys are
				// checked against the frozen ledger consumedEventKeys (see labMiningPoolDualCursor / the migration receipt).
				lastBackfillProcessedBlock: LAB_MIGRATION_SEED_LAST_PAID_REWARD_SOURCE_BLOCK,
				lastProcessedBlock: normalizeScanBlock(legacy.lastProcessedBlock),
				lastListeningEndBlock: normalizeScanBlock(legacy.lastListeningEndBlock),
				lastLiveHeadScanned: normalizeScanBlock(legacy.lastLiveHeadScanned),
				pending: Array.isArray(legacy.pending) ? legacy.pending : [],
				gasWaitStartedAt:
					typeof legacy.gasWaitStartedAt === 'string' && legacy.gasWaitStartedAt.trim()
						? legacy.gasWaitStartedAt.trim()
						: undefined,
				consumedEventKeys: legacy.consumedEventKeys,
				exitedPubkeys:
					legacy.exitedPubkeys && typeof legacy.exitedPubkeys === 'object' ? legacy.exitedPubkeys : {},
				updatedAt: legacy.updatedAt ?? new Date().toISOString(),
			}
			migrateLegacyStateFields(state)
			return state
		}
		return {
			lastBackfillProcessedBlock: floor - 1,
			consumedEventKeys: {},
			exitedPubkeys: {},
			updatedAt: new Date().toISOString(),
		}
	}

	/**
	 * Persist state as a v2 segmented generation (see labClPayoutStateStore).
	 * Refuses to write while only the legacy single file exists: run labClPayoutStateMigrate first.
	 * This check runs before any in-memory mutation.
	 */
	function writeState(state: LabClPayoutState): void {
		try {
			writeStateOrThrow(state)
		} catch (e: unknown) {
			env.tripPersist(e)
			throw e
		}
	}

	function writeStateOrThrow(state: LabClPayoutState): void {
		const legacyFile = env.stateFile()
		const dir = env.segmentedDir()
		if (inspectSegmentedDir(dir) !== 'committed' && legacyStateFileExists(legacyFile)) {
			throw new Error(
				`[labMiningPoolClPayout] refusing to write: legacy single-file state ${legacyFile} has no v2 manifest; ` +
					'stop the daemon and run labClPayoutStateMigrate (dry-run, then --apply)'
			)
		}
		state.updatedAt = new Date().toISOString()
		if (!Array.isArray(state.pending)) state.pending = []
		if (!state.consumedEventKeys || typeof state.consumedEventKeys !== 'object') state.consumedEventKeys = {}
		if (!state.exitedPubkeys || typeof state.exitedPubkeys !== 'object') state.exitedPubkeys = {}
		// Cursor high-water: a write must not move a persisted cursor backwards; the high-water mark only rises.
		const hw = state.cursorHighWater ?? {}
		assertCursorMonotonic('lastBackfillProcessedBlock', hw.backfill, state.lastBackfillProcessedBlock)
		assertCursorMonotonic('lastListeningEndBlock', hw.listen, state.lastListeningEndBlock)
		state.cursorHighWater = {
			backfill: Math.max(hw.backfill ?? -1, state.lastBackfillProcessedBlock ?? -1),
			listen: Math.max(hw.listen ?? -1, state.lastListeningEndBlock ?? -1),
		}
		const pruned = pruneConsumedEventKeys(state)
		// Cap hits every flush; avoid journal spam (log only large prunes).
		if (pruned >= 1_000) {
			env.logger(
				Colors.yellow(
					`[labMiningPoolClPayout] pruned ${pruned} oldest consumedEventKeys (persistMax=${env.consumedCap()})`
				)
			)
		}
		// Streamed, segmented write. The whole state is never JSON.stringify'd as one string.
		writeSegmentedState(dir, state)
	}


	/**
	 * The handle the reporter works through for one tick: the pending pool is loaded into a Map (as before) and `commit` is the whole-state write.
	 * `loadPending: false` gives a handle for scalar access only (the shutdown checkpoint), which never touches the pool.
	 */
	function newHandle(state: LabClPayoutState, opts: { loadPending?: boolean } = {}): LegacyStateHandle<SkimEntry, LabClPayoutState> {
		const pending = opts.loadPending === false ? new Map<string, SkimEntry>() : loadPendingMap(state)
		return new LegacyStateHandle<SkimEntry, LabClPayoutState>({ state: state as never, pending, persist: () => (opts.loadPending === false ? writeState(state) : persistPending(state, pending)) })
	}

	return { pruneConsumedEventKeys, readStateFromDisk, writeState, newHandle }
}
