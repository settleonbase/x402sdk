/**
 * Opens the WAL-mode state of the Lab payout reporter (P2c-2): refuse or bootstrap, recover, build the writer and the handle, and do the start-up alignment through the handle.
 * The reporter calls this once at start when CONET_LAB_MINING_POOL_CL_PAYOUT_WAL is on. No snapshot scheduling and no graceful stop to version 2 yet (P2c-3).
 */
import { inspectSegmentedDir, legacyStateFileExists } from './labClPayoutStateStore'
import { assertCursorMonotonic, assertNoSkippedHistory } from './labMiningPoolDualCursor'
import { recoverOrRefuse } from './labPayoutRecovery'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WalWriter } from './labWal'
import { WalStateHandle } from './labWalStateHandle'
import type { LabClPayoutState, SkimEntry } from './labLegacyState'

export type WalSession = {
	handle: WalStateHandle<SkimEntry, LabClPayoutState>
	core: LabPayoutStateCore
	wal: WalWriter
	/** max(lastListeningEndBlock + 1, scan floor): frozen at start. */
	sessionBackfillFloor: number
	settledBatchCount: number
	recovery: { snapshotSeq: number; replayed: number; warnings: string[] } | null
}

const norm = (raw: unknown): number | undefined => {
	if (raw == null) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

export async function openWalSession(opts: {
	stateDir: string
	/** The legacy single-file path: a state that only exists there must be migrated first (the reporter refuses, as in the legacy path). */
	legacyStateFile: string
	scanFloor: number
	log: (line: string) => void
	segmentBytes?: number
}): Promise<WalSession> {
	const status = inspectSegmentedDir(opts.stateDir)
	if (status === 'orphan') throw new Error(`[labMiningPoolClPayout] state dir has files but no committed manifest: ${opts.stateDir}; refusing to start with an empty state`)
	if (status === 'absent') {
		if (legacyStateFileExists(opts.legacyStateFile)) throw new Error(`[labMiningPoolClPayout] legacy single-file state ${opts.legacyStateFile} has no v2 state; run labClPayoutStateMigrate before the first WAL start`)
		// a first start with no state at all: a version 3 snapshot at seq 0 (what the legacy path starts from)
		const boot = new LabPayoutStateCore({ scalars: { lastBackfillProcessedBlock: opts.scanFloor - 1 } })
		const src = boot.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: opts.stateDir, mode: 'wal' })
		boot.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	}
	const rec = recoverOrRefuse(opts.stateDir, { log: opts.log })
	for (const w of rec.warnings) opts.log(`[labMiningPoolClPayout] ALERT WAL recovery warning: ${w}`)
	if (rec.warnings.length > 0) throw new Error('[labMiningPoolClPayout] WAL recovery reported warnings; refusing to start (operator check required)')
	const wal = new WalWriter({ stateDir: opts.stateDir, lastSeq: rec.writerLastSeq, segmentBytes: opts.segmentBytes })
	const handle = new WalStateHandle<SkimEntry, LabClPayoutState>({ core: rec.core, wal })
	opts.log(`[labMiningPoolClPayout] WAL mode: snapshotSeq=${rec.snapshotSeq} replayed=${rec.replayed} pending=${rec.core.pendingSize} consumed=${rec.core.consumedSize} nextSeq=${rec.writerLastSeq + 1}`)

	// start-up alignment, through the handle (the legacy path did this on its in-memory state)
	const hw = (handle.scalar('cursorHighWater') ?? {}) as { backfill?: number; listen?: number }
	assertCursorMonotonic('lastBackfillProcessedBlock (startup vs high-water)', hw.backfill, handle.scalar('lastBackfillProcessedBlock'))
	assertCursorMonotonic('lastListeningEndBlock (startup vs high-water)', hw.listen, handle.scalar('lastListeningEndBlock'))
	const lastListen = norm(handle.scalar('lastListeningEndBlock'))
	const sessionBackfillFloor = lastListen != null ? lastListen + 1 : opts.scanFloor
	if (handle.scalar('lastBackfillProcessedBlock') == null) {
		const legacy = norm((handle.scalar as (n: string) => unknown)('lastProcessedBlock'))
		handle.setScalar('lastBackfillProcessedBlock', legacy != null ? legacy : sessionBackfillFloor - 1)
	}
	if ((handle.scalar as (n: string) => unknown)('lastProcessedBlock') !== undefined) (handle.delScalar as (n: string) => void)('lastProcessedBlock')
	// R1: a scan floor above the history seed would silently skip blocks between them. Refuse to start instead.
	assertNoSkippedHistory(opts.scanFloor, handle.scalar('lastBackfillProcessedBlock'))
	if (handle.scalar('lastBackfillProcessedBlock') < sessionBackfillFloor - 1) handle.setScalar('lastBackfillProcessedBlock', sessionBackfillFloor - 1)
	await handle.commit('scalars')
	return { handle, core: rec.core, wal, sessionBackfillFloor, settledBatchCount: (handle.scalar('settledBatchCount') as number | undefined) ?? 0, recovery: { snapshotSeq: rec.snapshotSeq, replayed: rec.replayed, warnings: rec.warnings } }
}
