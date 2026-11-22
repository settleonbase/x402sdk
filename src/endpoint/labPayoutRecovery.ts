/**
 * Recovery and graceful stop for the WAL-mode Lab payout state (P2b-2; P2 design §5/§7, errata W1, W3, Y1, V5a). Not wired into the daemon yet (P2c).
 *
 * recoverPayoutState(stateDir)
 *   1. load the committed snapshot strictly (manifest version 2 or 3, no fallback to an empty state);
 *   2. snapshotSeq = manifest.walSeq (version 3) | scalars.walSeq (version 2 downgrade snapshot, informational) | 0 (the WAL was never on);
 *   3. scan the log after snapshotSeq (torn tail repaired, mid-log damage REFUSES: WalMidCorruptionError propagates, the daemon only alerts and exits);
 *   4. complete interrupted work: remove the segments that lie entirely inside the snapshot (a graceful stop whose downgrade manifest was committed but whose files were not yet deleted,
 *      or a crash between the manifest commit and the truncation). Without this a leftover file would keep blocking the P1 guard (wal/ non-empty = refuse);
 *   5. post-replay self-checks, returned as warnings (the daemon decides): maxPaidHistoryBlock <= historyCursor, in-flight keys pending or consumed.
 *   Recovery never prunes (pruning happens only in a snapshot).
 *
 * gracefulStopToV2(core, wal, stateDir)
 *   drain the log, write a version 2 DOWNGRADE snapshot (walSeq as the informational scalar), read the manifest back and check version===2 and the walSeq, then remove EVERY segment file
 *   (no empty file left behind). A failure at any step leaves the log in place (the P1 guard then refuses a rollback start, which is the point).
 */
import path from 'node:path'
import { SEGMENTED_STATE_VERSION, SEGMENTED_STATE_VERSION_WAL, inspectSegmentedDir, loadCommittedForRecovery, readManifest, streamCommittedForRecovery, type GenerationSink, type SegmentedManifest } from './labClPayoutStateStore'
import { LabPayoutStateCore, type PendingEntry } from './labPayoutStateCore'
import { writeSnapshotCooperative, type SnapshotStats, type SnapshotWriteOptions } from './labSnapshotWriter'
import { WAL_DIR, WalMidCorruptionError, WalWriter, formatWalMidCorruptionAlert, listSegments, nodeWalFs, removeWalSegmentsThrough, scanWal, type ScanResult, type WalFs } from './labWal'

export type RecoveryResult = {
	core: LabPayoutStateCore
	snapshotSeq: number
	manifestVersion: 2 | 3
	scan: ScanResult
	/** Events applied on top of the snapshot. */
	replayed: number
	/** Segment files that lay entirely inside the snapshot and were removed. */
	cleanedSegments: string[]
	/** Where the new WalWriter continues: max(snapshotSeq, last valid seq in the log). */
	writerLastSeq: number
	warnings: string[]
	durationMs: number
}

const NOT_SCALARS: ReadonlySet<string> = new Set(['pending', 'consumedEventKeys', 'exitedPubkeys', 'inFlightWithdraw', 'inFlightByWallet'])

/** The per-wallet slots stored in a snapshot's scalars (P4); anything that is not an object of objects is ignored (a snapshot without pools has none). */
function slotsOf(v: unknown): Record<string, Record<string, unknown>> | undefined {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
	const out: Record<string, Record<string, unknown>> = {}
	for (const [w, r] of Object.entries(v as Record<string, unknown>)) if (r && typeof r === 'object') out[w] = r as Record<string, unknown>
	return out
}

export function recoverPayoutState(
	stateDir: string,
	opts: {
		onDrift?: (what: string) => void
		maxFrameBytes?: number
		fs?: WalFs
		/** Offline tools: change nothing on disk - no torn-tail truncation, no removal of covered segments. A torn tail is reported through scan.truncatedBytes > 0. */
		readOnly?: boolean
		/**
		 * How the snapshot is loaded. 'stream' (default, P2d M3): every entry goes straight into the layered structures, no whole-state copies. 'whole': the original loader that reads the whole
		 * state into arrays and a Record first; kept so that the two can be compared on the same directories (differential tests) and as a fallback for offline tools.
		 * It can be deleted (with labStreamRecovery.test.ts's differential part) once the streaming loader has run in production for a release cycle and no offline tool passes 'whole'.
		 */
		loader?: 'stream' | 'whole'
	} = {}
): RecoveryResult {
	const t0 = process.hrtime.bigint()
	const status = inspectSegmentedDir(stateDir)
	if (status !== 'committed') throw new Error(`labPayoutRecovery: ${stateDir} has no committed snapshot (${status}); refusing to start from an empty state`)
	let manifest: SegmentedManifest
	let snapshotSeq: number
	let core: LabPayoutStateCore
	if ((opts.loader ?? 'stream') === 'whole') {
		const loaded = loadCommittedForRecovery(stateDir)
		manifest = loaded.manifest
		snapshotSeq = loaded.snapshotSeq
		const state = loaded.state
		const scalars: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(state)) if (!NOT_SCALARS.has(k)) scalars[k] = v
		delete scalars.walSeq // informational in a version 2 manifest; the real value is snapshotSeq
		const rec = (state as Record<string, unknown>).inFlightWithdraw
		core = new LabPayoutStateCore(
			{
				pending: state.pending as PendingEntry[],
				consumed: Object.keys(state.consumedEventKeys),
				exited: Object.keys(state.exitedPubkeys),
				scalars,
				inFlight: rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : null,
				slots: slotsOf((state as Record<string, unknown>).inFlightByWallet),
				lastAppliedSeq: snapshotSeq,
			},
			{ onDrift: opts.onDrift }
		)
	} else {
		let c: LabPayoutStateCore | undefined
		let seq = 0
		const sink: GenerationSink = {
			begin(all) {
				const scalars: Record<string, unknown> = {}
				for (const [k, v] of Object.entries(all)) if (!NOT_SCALARS.has(k)) scalars[k] = v
				delete scalars.walSeq
				const rec = all.inFlightWithdraw
				// the snapshot seq is known from the manifest before the entries are read
				c = new LabPayoutStateCore({ scalars, inFlight: rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : null, slots: slotsOf(all.inFlightByWallet), lastAppliedSeq: seq }, { onDrift: opts.onDrift })
			},
			pending: (rec) => c!.pendingSet(rec as unknown as PendingEntry),
			consumed: (k) => {
				const before = c!.consumedSize
				c!.consumedAdd(k)
				return c!.consumedSize > before
			},
			exited: (k) => {
				const before = c!.exitedSize
				c!.exitedAdd(k)
				return c!.exitedSize > before
			},
		}
		const m = readManifest(stateDir)
		const informational = m.scalars.walSeq
		seq = m.version === SEGMENTED_STATE_VERSION_WAL ? (m.walSeq as number) : typeof informational === 'number' ? informational : 0
		const loaded = streamCommittedForRecovery(stateDir, sink)
		manifest = loaded.manifest
		snapshotSeq = loaded.snapshotSeq
		// the seq was computed twice (before the entries are read, to create the core, and by the store afterwards): they must agree
		if (snapshotSeq !== seq) throw new Error(`labPayoutRecovery: snapshot seq ${seq} (manifest read before the entries) != ${snapshotSeq} (after); the manifest changed while it was read`)
		core = c!
	}
	let replayed = 0
	const scan = scanWal(stateDir, {
		afterSeq: snapshotSeq,
		maxFrameBytes: opts.maxFrameBytes,
		repair: opts.readOnly ? false : undefined,
		onEvent: (ev) => {
			core.applyEvent(ev)
			replayed++
		},
	})
	const cleaned = opts.readOnly ? [] : removeWalSegmentsThrough(stateDir, snapshotSeq, scan.lastSeq, opts.fs ?? nodeWalFs)
	const warnings = postReplayChecks(core)
	return {
		core,
		snapshotSeq,
		manifestVersion: manifest.version,
		scan,
		replayed,
		cleanedSegments: cleaned,
		writerLastSeq: Math.max(snapshotSeq, scan.lastSeq),
		warnings,
		durationMs: Number(process.hrtime.bigint() - t0) / 1e6,
	}
}

/**
 * What the daemon calls at start (P2c): recovery, and on mid-log WAL damage ONLY alert and refuse. It never calls the repair command and never truncates; the operator runs
 * labWalRepair offline with a run id and the written approval (review R5). `exit` is injectable for tests; the default exits with 78 (configuration/data error).
 */
export function recoverOrRefuse(
	stateDir: string,
	opts: { log?: (line: string) => void; exit?: (code: number) => never; onDrift?: (what: string) => void } = {}
): RecoveryResult {
	const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`))
	const exit = opts.exit ?? ((c: number): never => process.exit(c))
	try {
		return recoverPayoutState(stateDir, { onDrift: opts.onDrift })
	} catch (e) {
		if (e instanceof WalMidCorruptionError) {
			log(formatWalMidCorruptionAlert(e))
			return exit(78)
		}
		throw e
	}
}

/** Design §5 self-checks. Warnings, not exceptions: the daemon alerts and the operator decides. */
export function postReplayChecks(core: LabPayoutStateCore): string[] {
	const w: string[] = []
	const maxPaid = core.getScalar('maxPaidHistoryBlock')
	const cursor = core.getScalar('historyCursor')
	if (typeof maxPaid === 'number' && typeof cursor === 'number' && maxPaid > cursor) {
		w.push(`invariant C: maxPaidHistoryBlock ${maxPaid} is above historyCursor ${cursor} after replay`)
	}
	const inflight = core.getInFlight()
	const keys = inflight && Array.isArray(inflight.eventKeys) ? (inflight.eventKeys as unknown[]) : []
	const lost = keys.filter((k) => typeof k !== 'string' || (!core.pendingHas(k) && !core.consumedHas(k)))
	if (lost.length > 0) w.push(`in-flight record names ${lost.length} key(s) that are neither pending nor consumed`)
	return w
}

export type GracefulStopOptions = Pick<SnapshotWriteOptions, 'sliceMs' | 'yieldFn' | 'consumedCap' | 'archive' | 'hooks' | 'fs' | 'segmentSize' | 'now' | 'onSlice'> & {
	/** Test hook between the verified downgrade manifest and the removal of the segment files (throw to simulate the crash there). */
	beforeRemoveSegments?: () => void
}

export type GracefulStopResult = {
	walSeq: number
	manifest: SegmentedManifest
	removedSegments: number
	stats: SnapshotStats
	prunedKeys: number
}

export async function gracefulStopToV2(core: LabPayoutStateCore, wal: WalWriter, stateDir: string, opts: GracefulStopOptions = {}): Promise<GracefulStopResult> {
	if (core.snapshotInFlight) throw new Error('labPayoutRecovery: a snapshot is still in flight; finish or abort it before the graceful stop')
	if (core.lastAppliedSeq !== wal.lastSeq) {
		throw new Error(`labPayoutRecovery: memory is at seq ${core.lastAppliedSeq} but the log is at ${wal.lastSeq}; stop producing events before the graceful stop`)
	}
	// P4: a version 2 snapshot cannot carry per-wallet slots (an old build would ignore them and could pay a batch twice): refuse, keep the log, which an old build then refuses to start from
	if (core.slotCount > 0) throw new Error(`labPayoutRecovery: ${core.slotCount} wallet slot(s) still hold an in-flight batch; no version 2 downgrade snapshot is possible (settle or resolve them first: labWalResolveInFlight); the log is kept`)
	await wal.whenDurable(wal.lastSeq) // drain: every event is fsynced before the final snapshot
	const src = core.freezeForSnapshot()
	let res
	try {
		res = await writeSnapshotCooperative(src, {
			dir: stateDir,
			mode: 'downgrade',
			sliceMs: opts.sliceMs,
			yieldFn: opts.yieldFn,
			consumedCap: opts.consumedCap,
			archive: opts.archive,
			hooks: opts.hooks,
			fs: opts.fs,
			segmentSize: opts.segmentSize,
			now: opts.now,
			onSlice: opts.onSlice,
			waitDurable: (seq) => wal.whenDurable(seq),
		})
	} catch (e) {
		core.finishSnapshot(src, { committed: false })
		throw e
	}
	core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
	// read back (errata W1/X5): the committed manifest must be version 2 and must name this walSeq, otherwise an old reader could not start
	const m = readManifest(stateDir)
	if (m.version !== SEGMENTED_STATE_VERSION || m.walSeq !== undefined || m.scalars.walSeq !== src.walSeq) {
		throw new Error(`labPayoutRecovery: the downgrade snapshot did not read back as version 2 with walSeq ${src.walSeq}; the log is left in place`)
	}
	opts.beforeRemoveSegments?.()
	const walDir = path.join(stateDir, WAL_DIR)
	const before = listSegments(walDir).length
	await wal.closeAndRemoveAll()
	const left = listSegments(walDir)
	if (left.length > 0) throw new Error(`labPayoutRecovery: ${left.length} WAL segment file(s) remain after the graceful stop`)
	return { walSeq: src.walSeq, manifest: m, removedSegments: before, stats: res.stats, prunedKeys: res.prunedKeys.length }
}
