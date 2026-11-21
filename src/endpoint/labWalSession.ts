/**
 * Opens the WAL-mode state of the Lab payout reporter (P2c-2): refuse or bootstrap, recover, build the writer and the handle, and do the start-up alignment through the handle.
 * The reporter calls this once at start when CONET_LAB_MINING_POOL_CL_PAYOUT_WAL is on. No snapshot scheduling and no graceful stop to version 2 yet (P2c-3).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fsyncDirStrict, inspectSegmentedDir, legacyStateFileExists } from './labClPayoutStateStore'
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

/**
 * First-start bootstrap marker (found by the C5 random kill test): the very first start writes a version 3 snapshot into an empty state dir, and a kill -9 between the first generation file
 * and the manifest commit leaves a dir that has files but no manifest - which every start refuses as "orphan" (rightly: it could be a lost state). The marker is created (and fsynced) FIRST in
 * the empty dir and removed only after the manifest is committed, so "marker present, no manifest" proves every file in the dir came from this bootstrap and nothing was ever committed.
 * Only then is the partial bootstrap discarded and redone; any other orphan still refuses. A marker next to a committed manifest (killed between commit and removal) is simply removed.
 */
export const WAL_BOOTSTRAP_MARKER = '.wal-bootstrap-in-progress'

function placeBootstrapMarker(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	const fd = fs.openSync(path.join(dir, WAL_BOOTSTRAP_MARKER), 'w', 0o600)
	try {
		fs.writeSync(fd, 'bootstrap of the first version 3 snapshot in progress; safe to discard everything else in this directory\n')
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
	fsyncDirStrict(dir)
}

function removeBootstrapMarker(dir: string): void {
	fs.rmSync(path.join(dir, WAL_BOOTSTRAP_MARKER), { force: true })
	fsyncDirStrict(dir)
}

/** The partial result of a killed bootstrap: refuse if anything in the dir could be a committed log (a non-empty wal/), otherwise remove every entry but the marker. */
function discardPartialBootstrap(dir: string, log: (line: string) => void): void {
	const walDir = path.join(dir, 'wal')
	if (fs.existsSync(walDir) && fs.readdirSync(walDir).length > 0) throw new Error(`[labMiningPoolClPayout] bootstrap marker present but ${walDir} is not empty: not a partial bootstrap, refusing to start (operator check required)`)
	const removed: string[] = []
	for (const name of fs.readdirSync(dir)) {
		if (name === WAL_BOOTSTRAP_MARKER) continue
		fs.rmSync(path.join(dir, name), { recursive: true, force: true })
		removed.push(name)
	}
	fsyncDirStrict(dir)
	log(`[labMiningPoolClPayout] WAL bootstrap was interrupted before its manifest commit; discarded the partial files (${removed.join(', ') || 'none'}) and redo it`)
}

export async function openWalSession(opts: {
	stateDir: string
	/** The legacy single-file path: a state that only exists there must be migrated first (the reporter refuses, as in the legacy path). */
	legacyStateFile: string
	scanFloor: number
	log: (line: string) => void
	segmentBytes?: number
	/** Refuse (fatally) any single event above this size; default the log's 16 MiB. Tunable so the over-limit stop can be exercised end to end. */
	maxFrameBytes?: number
}): Promise<WalSession> {
	let status = inspectSegmentedDir(opts.stateDir)
	const markerPath = path.join(opts.stateDir, WAL_BOOTSTRAP_MARKER)
	const markerThere = status !== 'absent' && fs.existsSync(markerPath)
	if (status === 'committed' && markerThere) removeBootstrapMarker(opts.stateDir)
	if (status === 'orphan' && markerThere) {
		discardPartialBootstrap(opts.stateDir, opts.log)
		status = 'absent'
	}
	if (status === 'orphan') throw new Error(`[labMiningPoolClPayout] state dir has files but no committed manifest: ${opts.stateDir}; refusing to start with an empty state`)
	if (status === 'absent') {
		if (legacyStateFileExists(opts.legacyStateFile)) throw new Error(`[labMiningPoolClPayout] legacy single-file state ${opts.legacyStateFile} has no v2 state; run labClPayoutStateMigrate before the first WAL start`)
		// a first start with no state at all: a version 3 snapshot at seq 0 (what the legacy path starts from); the marker makes a kill during it recoverable
		placeBootstrapMarker(opts.stateDir)
		const boot = new LabPayoutStateCore({ scalars: { lastBackfillProcessedBlock: opts.scanFloor - 1 } })
		const src = boot.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: opts.stateDir, mode: 'wal' })
		boot.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		removeBootstrapMarker(opts.stateDir)
	}
	const rec = recoverOrRefuse(opts.stateDir, { log: opts.log })
	for (const w of rec.warnings) opts.log(`[labMiningPoolClPayout] ALERT WAL recovery warning: ${w}`)
	if (rec.warnings.length > 0) throw new Error('[labMiningPoolClPayout] WAL recovery reported warnings; refusing to start (operator check required)')
	const wal = new WalWriter({ stateDir: opts.stateDir, lastSeq: rec.writerLastSeq, segmentBytes: opts.segmentBytes, maxFrameBytes: opts.maxFrameBytes })
	const handle = new WalStateHandle<SkimEntry, LabClPayoutState>({ core: rec.core, wal, log: opts.log })
	opts.log(`[labMiningPoolClPayout] WAL mode: snapshotSeq=${rec.snapshotSeq} replayed=${rec.replayed} pending=${rec.core.pendingSize} consumed=${rec.core.consumedSize} nextSeq=${rec.writerLastSeq + 1}`)

	// start-up alignment, through the handle (the legacy path did this on its in-memory state). S4: it happens before the first tick; enterTick makes that an assertion (no tick may be running).
	handle.enterTick()
	let sessionBackfillFloor = opts.scanFloor
	try {
		const hw = (handle.scalar('cursorHighWater') ?? {}) as { backfill?: number; listen?: number }
		assertCursorMonotonic('lastBackfillProcessedBlock (startup vs high-water)', hw.backfill, handle.scalar('lastBackfillProcessedBlock'))
		assertCursorMonotonic('lastListeningEndBlock (startup vs high-water)', hw.listen, handle.scalar('lastListeningEndBlock'))
		const lastListen = norm(handle.scalar('lastListeningEndBlock'))
		sessionBackfillFloor = lastListen != null ? lastListen + 1 : opts.scanFloor
		if (handle.scalar('lastBackfillProcessedBlock') == null) {
			const legacy = norm((handle.scalar as (n: string) => unknown)('lastProcessedBlock'))
			handle.setScalar('lastBackfillProcessedBlock', legacy != null ? legacy : sessionBackfillFloor - 1)
		}
		if ((handle.scalar as (n: string) => unknown)('lastProcessedBlock') !== undefined) (handle.delScalar as (n: string) => void)('lastProcessedBlock')
		// R1: a scan floor above the history seed would silently skip blocks between them. Refuse to start instead.
		assertNoSkippedHistory(opts.scanFloor, handle.scalar('lastBackfillProcessedBlock'))
		if (handle.scalar('lastBackfillProcessedBlock') < sessionBackfillFloor - 1) handle.setScalar('lastBackfillProcessedBlock', sessionBackfillFloor - 1)
		await handle.commit('scalars')
	} finally {
		handle.exitTick()
	}
	return { handle, core: rec.core, wal, sessionBackfillFloor, settledBatchCount: (handle.scalar('settledBatchCount') as number | undefined) ?? 0, recovery: { snapshotSeq: rec.snapshotSeq, replayed: rec.replayed, warnings: rec.warnings } }
}
