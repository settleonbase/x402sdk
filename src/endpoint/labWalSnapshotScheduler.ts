/**
 * Snapshot scheduler of the WAL-mode Lab payout daemon (P2c-3).
 *
 * A snapshot is due when the last committed one is at least `intervalMs` old (default 10 min) or the log has grown past `walMaxBytes` (default 256 MiB). At most ONE snapshot runs at a time: a due
 * snapshot that finds the previous one still running is skipped and counted (operator alert). A snapshot never touches the events that are already fsynced: any failure (including an aborted or
 * failed archive write) ends in `finishSnapshot(committed:false)`, an ALERT line, and a backoff before the next try. After a commit the log segments the snapshot covers are removed.
 *
 * Every operator-facing line that needs attention contains "ALERT" (the reporter prints those in red; the unit and E2E tests assert them):
 *   - snapshot failed / skipped because the previous is still running
 *   - consumed archive failed (the snapshot committed, nothing was pruned this time)
 *   - the log is more than twice the size limit (snapshots are not keeping up)
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeSnapshotCooperative, type SnapshotWriteOptions, type SnapshotStats } from './labSnapshotWriter'
import { listSegments, WAL_DIR, type WalWriter } from './labWal'
import type { LabPayoutStateCore } from './labPayoutStateCore'

export const SNAPSHOT_DEFAULT_INTERVAL_MS = 10 * 60_000
export const SNAPSHOT_DEFAULT_WAL_MAX_BYTES = 256 * 1024 * 1024
const RETRY_BACKOFF_MS = 120_000
const SIZE_ALERT_EVERY_MS = 10 * 60_000

export type SchedulerOptions = {
	core: LabPayoutStateCore
	wal: WalWriter
	stateDir: string
	log: (line: string) => void
	intervalMs?: number
	walMaxBytes?: number
	consumedCap?: number
	archive?: (keys: string[]) => void
	now?: () => number
	/** Test seams. */
	walBytes?: () => number
	writeOptions?: Partial<SnapshotWriteOptions>
	/** Called once with each finished attempt (tests). */
	onFinished?: (r: { committed: boolean; walSeq: number; stats?: SnapshotStats; error?: string }) => void
}

export type SchedulerStats = {
	started: number
	committed: number
	failed: number
	skippedBusy: number
	archiveFailed: number
	lastCommittedAt: number | null
	lastError: string | null
}

export function walTotalBytes(stateDir: string): number {
	const dir = path.join(stateDir, WAL_DIR)
	let total = 0
	for (const s of listSegments(dir)) {
		try {
			total += fs.statSync(path.join(dir, s.file)).size
		} catch {
			/* a segment removed meanwhile */
		}
	}
	return total
}

export class WalSnapshotScheduler {
	readonly stats: SchedulerStats = { started: 0, committed: 0, failed: 0, skippedBusy: 0, archiveFailed: 0, lastCommittedAt: null, lastError: null }
	private cur: Promise<void> | null = null
	private stopped = false
	private readonly intervalMs: number
	private readonly walMaxBytes: number
	private readonly now: () => number
	private lastCommitAt: number
	private nextTryAt = 0
	private lastSizeAlertAt = -Infinity

	constructor(private readonly o: SchedulerOptions) {
		this.intervalMs = o.intervalMs ?? SNAPSHOT_DEFAULT_INTERVAL_MS
		this.walMaxBytes = o.walMaxBytes ?? SNAPSHOT_DEFAULT_WAL_MAX_BYTES
		this.now = o.now ?? Date.now
		this.lastCommitAt = this.now() // a fresh start counts as "just snapshotted": the recovery that preceded it is not a reason to snapshot at once
	}

	get inFlight(): boolean {
		return this.cur !== null
	}

	private bytes(): number {
		return this.o.walBytes ? this.o.walBytes() : walTotalBytes(this.o.stateDir)
	}

	/** Why a snapshot is due now, or null. */
	due(): 'interval' | 'wal-size' | null {
		const t = this.now()
		if (t < this.nextTryAt) return null
		if (this.bytes() > this.walMaxBytes) return 'wal-size'
		if (t - this.lastCommitAt >= this.intervalMs) return 'interval'
		return null
	}

	/** Cheap; the daemon calls it at the end of every tick. Starts a snapshot when one is due and none is running; never throws. */
	poke(): void {
		if (this.stopped) return
		try {
			const bytes = this.bytes()
			if (bytes > this.walMaxBytes * 2 && this.now() - this.lastSizeAlertAt >= SIZE_ALERT_EVERY_MS) {
				this.lastSizeAlertAt = this.now()
				this.o.log(`[labMiningPoolClPayout] ALERT WAL is ${(bytes / 1048576).toFixed(1)} MiB, more than twice the ${(this.walMaxBytes / 1048576).toFixed(0)} MiB limit: snapshots are not keeping up (committed=${this.stats.committed} failed=${this.stats.failed} skippedBusy=${this.stats.skippedBusy})`)
			}
			const reason = this.due()
			if (!reason) return
			if (this.cur) {
				this.stats.skippedBusy++
				if (this.stats.skippedBusy === 1 || this.stats.skippedBusy % 10 === 0) {
					this.o.log(`[labMiningPoolClPayout] ALERT snapshot due (${reason}) but the previous one is still running; skipped (skippedBusy=${this.stats.skippedBusy})`)
				}
				return
			}
			this.cur = this.run(reason).finally(() => {
				this.cur = null
			})
		} catch (e) {
			this.o.log(`[labMiningPoolClPayout] ALERT snapshot scheduler error: ${(e as Error)?.message ?? e}`)
		}
	}

	/** No new snapshot starts after this; resolves when the running one (if any) has finished (either way). */
	async stop(): Promise<void> {
		this.stopped = true
		if (this.cur) await this.cur
	}

	private async run(reason: string): Promise<void> {
		const { core, wal, stateDir } = this.o
		this.stats.started++
		const src = core.freezeForSnapshot()
		try {
			const res = await writeSnapshotCooperative(src, {
				dir: stateDir,
				mode: 'wal',
				consumedCap: this.o.consumedCap,
				archive: this.o.archive,
				waitDurable: (seq) => wal.whenDurable(seq),
				...this.o.writeOptions,
			})
			core.finishSnapshot(src, { committed: true, prunedKeys: res.prunedKeys, frozenHistCounts: res.frozenHistCounts })
			const removed = wal.truncateThrough(src.walSeq)
			this.stats.committed++
			this.stats.lastCommittedAt = this.now()
			this.lastCommitAt = this.now()
			if (res.stats.archiveFailed) {
				this.stats.archiveFailed++
				this.o.log(`[labMiningPoolClPayout] ALERT consumed archive failed: the snapshot at walSeq ${src.walSeq} committed but nothing was pruned this time (archiveFailed=${this.stats.archiveFailed})`)
			}
			this.o.log(`[labMiningPoolClPayout] snapshot committed walSeq=${src.walSeq} reason=${reason} slices=${res.stats.slices} maxSliceMs=${res.stats.maxSliceMs.toFixed(0)} totalMs=${res.stats.totalMs.toFixed(0)} pending=${res.stats.pendingLines} consumed=${res.stats.consumedLines} pruned=${res.prunedKeys.length} removedSegments=${removed.length}`)
			this.o.onFinished?.({ committed: true, walSeq: src.walSeq, stats: res.stats })
		} catch (e) {
			core.finishSnapshot(src, { committed: false })
			const msg = (e as Error)?.message ?? String(e)
			this.stats.failed++
			this.stats.lastError = msg
			this.nextTryAt = this.now() + Math.min(this.intervalMs, RETRY_BACKOFF_MS)
			this.o.log(`[labMiningPoolClPayout] ALERT snapshot failed (${reason}): ${msg}; the events already fsynced are unaffected, next try in ${Math.round(Math.min(this.intervalMs, RETRY_BACKOFF_MS) / 1000)}s`)
			this.o.onFinished?.({ committed: false, walSeq: src.walSeq, error: msg })
		}
	}
}
