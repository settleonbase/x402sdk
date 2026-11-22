/**
 * Write-ahead log for the Lab CL payout state (P2a of PLAN-lab-signing-pools-BASELINE rev2, with the P2 design errata W1-W7).
 * Frame codec, segment writer with group commit, recovery scan, and the op replay engine. Not wired into the daemon yet.
 *
 * Layout: `<stateDir>/wal/wal-<firstSeq as 16 hex digits>.log`, rotated by size.
 * Frame: [magic 'W''L' (2 B)] [len u32 LE] [crc32c u32 LE of the payload] [payload = UTF-8 JSON of one WalEvent].
 * One event = one atomic group of idempotent ops; replay applies the whole group or none of it.
 *
 * Rules enforced here (errata):
 *  - W2 fail-stop: a write or fsync failure calls `onFatal` (default: exit the process, non-zero) and the writer is dead; nothing is retried.
 *  - W3 torn tail: frames are scanned from the start of each segment; only the LAST segment may be truncated at its first bad frame; a bad frame
 *    in an earlier segment, a seq gap, or a first frame whose seq differs from the file name refuses to start. `len` has an upper bound.
 *  - A new segment file is fsynced together with its directory; a graceful stop can remove every segment (no empty file left behind).
 *  - Group commit: every append made in the same turn of the event loop shares one write and one fsync; a promise resolves only after the fsync.
 *
 * Node built-ins only. No WebSocket.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The filesystem calls the log makes, so tests can inject a volatile page cache (data lost until fsync), ENOSPC and fsync failures (review Z3, errata W7). */
export interface WalFs {
	mkdirSync(p: string, o: { recursive: boolean; mode: number }): void
	openSync(p: string, flags: string, mode?: number): number
	fsyncSync(fd: number): void
	closeSync(fd: number): void
	writeSync(fd: number, buf: Buffer, offset: number, length: number): number
	fstatSync(fd: number): { size: number }
	unlinkSync(p: string): void
	readdirSync(p: string): string[]
}
export const nodeWalFs: WalFs = {
	mkdirSync: (p, o) => void fs.mkdirSync(p, o),
	openSync: (p, f, m) => fs.openSync(p, f, m),
	fsyncSync: (fd) => fs.fsyncSync(fd),
	closeSync: (fd) => fs.closeSync(fd),
	writeSync: (fd, b, o, l) => fs.writeSync(fd, b, o, l),
	fstatSync: (fd) => fs.fstatSync(fd),
	unlinkSync: (p) => fs.unlinkSync(p),
	readdirSync: (p) => fs.readdirSync(p),
}

export const WAL_DIR = 'wal'
export const WAL_FRAME_MAGIC0 = 0x57 // 'W'
export const WAL_FRAME_MAGIC1 = 0x4c // 'L'
export const WAL_HEADER_BYTES = 10
export const WAL_DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const WAL_DEFAULT_SEGMENT_BYTES = 64 * 1024 * 1024
const SEGMENT_RE = /^wal-([0-9a-f]{16})\.log$/

// ------------------------------------------------------------------ CRC32C (Castagnoli)
const CRC_TABLE = (() => {
	const t = new Uint32Array(256)
	for (let i = 0; i < 256; i++) {
		let c = i
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1
		t[i] = c >>> 0
	}
	return t
})()

export function crc32c(data: Uint8Array): number {
	let c = 0xffffffff
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

// ------------------------------------------------------------------ events and ops
/** Primitive ops. Every op is idempotent; countSettled is deliberately absent: the settled count travels as an absolute max-merged scalar. */
export type WalOp =
	| { op: 'pendingAdd'; entry: { eventKey: string } & Record<string, unknown> }
	| { op: 'pendingDel'; key: string }
	| { op: 'consumedAdd'; key: string }
	| { op: 'exitedAdd'; pubkey: string }
	| { op: 'scalarsSet'; patch: Record<string, unknown> }
	/** Delete scalars (JSON drops undefined, and the daemon deletes e.g. gasWaitStartedAt): an explicit op so a replay cannot resurrect them. Idempotent. */
	| { op: 'scalarsDel'; names: string[] }
	| { op: 'inFlightSet'; record: Record<string, unknown> | null }
	/** P4: the in-flight batch of ONE wallet (its slot); null clears it. Idempotent (a slot is replaced as a whole). */
	| { op: 'slotSet'; wallet: string; record: Record<string, unknown> | null }

export type WalEvent = { v: 1; seq: number; ts: string; t: string; ops: WalOp[] }

/** Scalars merged by max on every application (cursors, high-waters, the absolute settled count): replay can never move them backwards. */
export const WAL_MAX_MERGE_SCALARS: ReadonlySet<string> = new Set([
	'historyCursor',
	'realtimeCursor',
	'lastBackfillProcessedBlock',
	'lastListeningEndBlock',
	'lastLiveHeadScanned',
	'maxPaidHistoryBlock',
	'settledBatchCount',
])

export class WalCorruptError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'WalCorruptError'
	}
}

/**
 * Damage in the middle of the last segment with valid frames after it (review Z1). scanWal ALWAYS refuses this and never truncates: the only way past it is the
 * offline, one-shot, audited repair command (labWalRepair.ts), which needs a run id and a written approval and is never driven by an environment variable.
 */
export class WalMidCorruptionError extends WalCorruptError {
	constructor(
		message: string,
		readonly file: string,
		readonly badOffset: number,
		readonly reason: string,
		readonly laterFrameOffsets: number[],
		/** Seq of the last intact frame before the damage (0 if none): the next event written after any repair gets lastGoodSeq + 1, so the dropped seqs are reused. */
		readonly lastGoodSeq: number
	) {
		super(message)
		this.name = 'WalMidCorruptionError'
	}
}

// ------------------------------------------------------------------ frame codec
export function encodeFrame(event: WalEvent, maxFrameBytes = WAL_DEFAULT_MAX_FRAME_BYTES): Buffer {
	const payload = Buffer.from(JSON.stringify(event), 'utf8')
	if (payload.length > maxFrameBytes) throw new Error(`labWal: event ${event.seq} is ${payload.length} bytes, over the frame limit ${maxFrameBytes}`)
	const head = Buffer.allocUnsafe(WAL_HEADER_BYTES)
	head[0] = WAL_FRAME_MAGIC0
	head[1] = WAL_FRAME_MAGIC1
	head.writeUInt32LE(payload.length, 2)
	head.writeUInt32LE(crc32c(payload), 6)
	return Buffer.concat([head, payload])
}

export type DecodeResult =
	| { ok: true; event: WalEvent; end: number }
	/** `end` of input reached cleanly (no bytes left). */
	| { ok: false; reason: 'eof'; at: number }
	| { ok: false; reason: 'short-header' | 'bad-magic' | 'bad-length' | 'short-payload' | 'bad-crc' | 'bad-json' | 'bad-event'; at: number }

export function decodeFrameAt(buf: Buffer, at: number, maxFrameBytes = WAL_DEFAULT_MAX_FRAME_BYTES): DecodeResult {
	if (at >= buf.length) return { ok: false, reason: 'eof', at }
	if (buf.length - at < WAL_HEADER_BYTES) return { ok: false, reason: 'short-header', at }
	if (buf[at] !== WAL_FRAME_MAGIC0 || buf[at + 1] !== WAL_FRAME_MAGIC1) return { ok: false, reason: 'bad-magic', at }
	const len = buf.readUInt32LE(at + 2)
	if (len === 0 || len > maxFrameBytes) return { ok: false, reason: 'bad-length', at }
	if (buf.length - at - WAL_HEADER_BYTES < len) return { ok: false, reason: 'short-payload', at }
	const payload = buf.subarray(at + WAL_HEADER_BYTES, at + WAL_HEADER_BYTES + len)
	if (crc32c(payload) !== buf.readUInt32LE(at + 6)) return { ok: false, reason: 'bad-crc', at }
	let event: unknown
	try {
		event = JSON.parse(payload.toString('utf8'))
	} catch {
		return { ok: false, reason: 'bad-json', at }
	}
	if (!isWalEvent(event)) return { ok: false, reason: 'bad-event', at }
	return { ok: true, event, end: at + WAL_HEADER_BYTES + len }
}

function isWalEvent(v: unknown): v is WalEvent {
	if (typeof v !== 'object' || v === null) return false
	const e = v as Record<string, unknown>
	return e.v === 1 && Number.isSafeInteger(e.seq) && (e.seq as number) >= 1 && typeof e.t === 'string' && typeof e.ts === 'string' && Array.isArray(e.ops)
}

// ------------------------------------------------------------------ segment files
export function segmentFileName(firstSeq: number): string {
	return `wal-${firstSeq.toString(16).padStart(16, '0')}.log`
}

export function listSegments(walDir: string, fsx: Pick<WalFs, 'readdirSync'> = nodeWalFs): { file: string; firstSeq: number }[] {
	let names: string[]
	try {
		names = fsx.readdirSync(walDir)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw e
	}
	const out: { file: string; firstSeq: number }[] = []
	for (const n of names) {
		const m = SEGMENT_RE.exec(n)
		if (!m) throw new WalCorruptError(`labWal: unexpected entry ${JSON.stringify(n)} in ${walDir}; refusing to guess`)
		out.push({ file: n, firstSeq: parseInt(m[1]!, 16) })
	}
	out.sort((a, b) => a.firstSeq - b.firstSeq)
	return out
}

function fsyncDir(dir: string, fsx: Pick<WalFs, 'openSync' | 'fsyncSync' | 'closeSync'> = nodeWalFs): void {
	const fd = fsx.openSync(dir, 'r')
	try {
		fsx.fsyncSync(fd)
	} finally {
		fsx.closeSync(fd)
	}
}

/**
 * Recovery-time cleanup, before any writer exists (review V5a): remove every segment whose events are all <= throughSeq (they are inside the committed snapshot). `lastSeqInLog` is the
 * scan's lastSeq; the last segment ends there. This completes an interrupted graceful stop (downgrade manifest committed, segment files not yet deleted) and a crash between the manifest
 * commit and the truncation. A segment with any event above throughSeq is kept. Returns the removed file names; fsyncs the directory when it removed something.
 */
export function removeWalSegmentsThrough(stateDir: string, throughSeq: number, lastSeqInLog: number, fsx: WalFs = nodeWalFs): string[] {
	const walDir = path.join(stateDir, WAL_DIR)
	const segs = listSegments(walDir, fsx)
	const removed: string[] = []
	for (let i = 0; i < segs.length; i++) {
		const lastInSeg = i + 1 < segs.length ? segs[i + 1]!.firstSeq - 1 : Math.max(lastSeqInLog, segs[i]!.firstSeq - 1)
		if (lastInSeg <= throughSeq) {
			fsx.unlinkSync(path.join(walDir, segs[i]!.file))
			removed.push(segs[i]!.file)
		}
	}
	if (removed.length > 0) fsyncDir(walDir, fsx)
	return removed
}

// ------------------------------------------------------------------ recovery scan
export type ScanResult = {
	/** Events handed to onEvent (seq > afterSeq). */
	applied: number
	/** Highest valid seq found in the log (0 when empty); may be <= afterSeq. */
	lastSeq: number
	/** Bytes cut from the tail of the last segment (0 when the log ended cleanly). */
	truncatedBytes: number
	segments: number
}

/**
 * Scan every segment in order and hand each valid event with seq > afterSeq to `onEvent`.
 * The log must continue from afterSeq: the first segment cannot start after afterSeq+1 (a gap loses events). Events at or below afterSeq are
 * skipped (already in the snapshot). Only the last segment may end in a torn frame; that tail is truncated (and fsynced) unless `repair` is false.
 */
/**
 * Resync probe (review Z1): after a bad frame, look through the rest of the segment for any frame that passes magic, length, CRC and JSON checks.
 * A torn write can only damage the END of the log (the last write that never finished its fsync), so a valid frame AFTER the damage means the damage is in
 * the middle: those later frames may be acknowledged events (an intent whose transaction was already sent). Returns the offsets of the valid frames found.
 */
export function probeValidFramesAfter(buf: Buffer, badAt: number, maxFrameBytes = WAL_DEFAULT_MAX_FRAME_BYTES): number[] {
	const found: number[] = []
	let o = badAt + 1
	while (o + WAL_HEADER_BYTES <= buf.length) {
		if (buf[o] === WAL_FRAME_MAGIC0 && buf[o + 1] === WAL_FRAME_MAGIC1) {
			const r = decodeFrameAt(buf, o, maxFrameBytes)
			if (r.ok) {
				found.push(o)
				o = r.end
				continue
			}
		}
		o++
	}
	return found
}

export function scanWal(
	stateDir: string,
	opts: {
		afterSeq: number
		onEvent: (e: WalEvent) => void
		maxFrameBytes?: number
		repair?: boolean
	}
): ScanResult {
	const walDir = path.join(stateDir, WAL_DIR)
	const maxFrame = opts.maxFrameBytes ?? WAL_DEFAULT_MAX_FRAME_BYTES
	const segs = listSegments(walDir)
	let applied = 0
	let lastSeq = 0
	let truncatedBytes = 0
	let expected: number | null = null
	if (segs.length > 0 && segs[0]!.firstSeq > opts.afterSeq + 1) {
		throw new WalCorruptError(`labWal: the first segment starts at seq ${segs[0]!.firstSeq} but the snapshot ends at seq ${opts.afterSeq}: events ${opts.afterSeq + 1}..${segs[0]!.firstSeq - 1} are missing`)
	}
	for (let si = 0; si < segs.length; si++) {
		const seg = segs[si]!
		const isLast = si === segs.length - 1
		const file = path.join(walDir, seg.file)
		// R6: a jump FORWARD is accepted only when every missing seq lies inside the snapshot (seq <= afterSeq): that is what an audited repair leaves behind when the
		// snapshot was ahead of the damaged frame. A jump that hides an event above the snapshot, and any overlap, still refuses.
		if (expected !== null && seg.firstSeq !== expected && !(seg.firstSeq > expected && seg.firstSeq <= opts.afterSeq + 1)) {
			throw new WalCorruptError(`labWal: segment ${seg.file} starts at seq ${seg.firstSeq} but the previous segment ended at seq ${expected - 1}`)
		}
		const buf = fs.readFileSync(file)
		let at = 0
		let next = seg.firstSeq
		for (;;) {
			const r = decodeFrameAt(buf, at, maxFrame)
			if (r.ok) {
				if (r.event.seq !== next) {
					if (isLast) {
						// a good frame with the wrong seq is not a torn write: refuse
						throw new WalCorruptError(`labWal: ${seg.file} offset ${at}: frame seq ${r.event.seq}, expected ${next}`)
					}
					throw new WalCorruptError(`labWal: ${seg.file} offset ${at}: frame seq ${r.event.seq}, expected ${next}`)
				}
				if (r.event.seq > opts.afterSeq) {
					opts.onEvent(r.event)
					applied++
				}
				lastSeq = r.event.seq
				next++
				at = r.end
				continue
			}
			if (r.reason === 'eof') break
			// a bad frame
			if (!isLast) throw new WalCorruptError(`labWal: ${seg.file} offset ${at}: ${r.reason} in a segment that is not the last; refusing to start`)
			// Z1: a valid frame after the damage is mid-log corruption, not a torn tail: refuse (unless the operator accepts the loss)
			const later = probeValidFramesAfter(buf, at, maxFrame)
			if (later.length > 0) {
				throw new WalMidCorruptionError(
					`labWal: ${seg.file} offset ${at}: ${r.reason}, and ${later.length} valid frame(s) follow it (first at offset ${later[0]}). ` +
						'That is damage in the middle of the log, not a torn tail: those frames may be acknowledged events. Refusing to start and not truncating. ' +
						'The only way forward is the offline audited repair command (labWalRepair) with a run id and the written approval.',
					path.join(walDir, seg.file),
					at,
					r.reason,
					later,
					// R8: when the damaged frame is the FIRST of its segment, no frame of this segment was scanned yet: the last intact seq is the one just before the segment's first
					Math.max(lastSeq, seg.firstSeq - 1)
				)
			}
			truncatedBytes = buf.length - at
			if (opts.repair !== false) {
				const fd = fs.openSync(file, 'r+')
				try {
					fs.ftruncateSync(fd, at)
					fs.fsyncSync(fd)
				} finally {
					fs.closeSync(fd)
				}
			}
			break
		}
		expected = next
	}
	return { applied, lastSeq, truncatedBytes, segments: segs.length }
}

// ------------------------------------------------------------------ writer with group commit
export type WalWriterHooks = {
	/** Called with the bytes right before they are written. Throw to simulate a failed write. */
	beforeWrite?: (bytes: Buffer, segFile: string) => void
	/** If set, only this many bytes of the batch are written before the (simulated) failure is thrown. */
	partialWrite?: (bytes: Buffer, segFile: string) => number | null
	/** Called right before fsync of the segment. Throw to simulate a failed fsync. */
	beforeSync?: (segFile: string) => void
	/** Called right before the directory fsync after a new segment file. */
	beforeDirSync?: (dir: string) => void
	/** Counters for tests. */
	onSync?: (segFile: string) => void
}

export type WalWriterOptions = {
	stateDir: string
	/** Seq of the last event already durable (snapshot or log). The next event gets lastSeq+1. */
	lastSeq: number
	segmentBytes?: number
	maxFrameBytes?: number
	/** W2: called once on a write or fsync failure. Default: log and exit(70). The writer is dead afterwards. */
	onFatal?: (err: Error) => void
	hooks?: WalWriterHooks
	now?: () => Date
	/** Test double for the filesystem (default: node:fs). */
	fs?: WalFs
}

type Queued = { frame: Buffer; seq: number; resolve: () => void; reject: (e: Error) => void }

export class WalWriter {
	private readonly walDir: string
	private readonly segmentBytes: number
	private readonly maxFrame: number
	private readonly onFatal: (err: Error) => void
	private readonly hooks: WalWriterHooks
	private readonly now: () => Date
	private readonly fsx: WalFs
	private lastAssigned: number
	private durable = 0
	private waiters: { seq: number; resolve: () => void; reject: (e: Error) => void }[] = []
	private queue: Queued[] = []
	private flushing = false
	private scheduled = false
	private fd: number | null = null
	private segFile = ''
	private segFirstSeq = 0
	private segSize = 0
	private segFrames = 0
	private dead: Error | null = null
	private fsyncCount = 0

	constructor(opts: WalWriterOptions) {
		this.walDir = path.join(opts.stateDir, WAL_DIR)
		this.segmentBytes = opts.segmentBytes ?? WAL_DEFAULT_SEGMENT_BYTES
		this.maxFrame = opts.maxFrameBytes ?? WAL_DEFAULT_MAX_FRAME_BYTES
		this.lastAssigned = opts.lastSeq
		this.durable = opts.lastSeq // everything up to the snapshot / the scanned log is durable by definition
		this.fsx = opts.fs ?? nodeWalFs
		this.hooks = opts.hooks ?? {}
		this.now = opts.now ?? (() => new Date())
		this.onFatal =
			opts.onFatal ??
			((err) => {
				process.stderr.write(`[labWal] FATAL ${err.message}; exiting (fail-stop)\n`)
				process.exit(70)
			})
	}

	get syncCount(): number {
		return this.fsyncCount
	}
	get lastSeq(): number {
		return this.lastAssigned
	}
	/** Highest seq whose fsync has completed. */
	get durableSeq(): number {
		return this.durable
	}
	/**
	 * Resolves once every event up to `seq` has been fsynced (the snapshot commit waits on this so a snapshot never gets ahead of the log); rejects if the writer died first.
	 */
	whenDurable(seq: number): Promise<void> {
		if (this.durable >= seq) return Promise.resolve()
		if (this.dead) return Promise.reject(this.dead)
		return new Promise<void>((resolve, reject) => {
			this.waiters.push({ seq, resolve, reject })
		})
	}
	private releaseWaiters(): void {
		if (this.waiters.length === 0) return
		const rest: typeof this.waiters = []
		for (const w of this.waiters) {
			if (w.seq <= this.durable) w.resolve()
			else rest.push(w)
		}
		this.waiters = rest
	}
	get isDead(): boolean {
		return this.dead !== null
	}

	/**
	 * Assign the next seq, queue the event, and return a promise that resolves after the fsync that made it durable.
	 * The caller applies the event to memory in the same synchronous block BEFORE awaiting; external effects wait for the promise.
	 */
	append(t: string, ops: WalOp[]): { seq: number; durable: Promise<void> } {
		if (this.dead) return { seq: -1, durable: Promise.reject(this.dead) }
		const seq = ++this.lastAssigned
		const event: WalEvent = { v: 1, seq, ts: this.now().toISOString(), t, ops }
		let frame: Buffer
		try {
			frame = encodeFrame(event, this.maxFrame)
		} catch (e) {
			this.lastAssigned--
			return { seq: -1, durable: Promise.reject(e instanceof Error ? e : new Error(String(e))) }
		}
		const durable = new Promise<void>((resolve, reject) => {
			this.queue.push({ frame, seq, resolve, reject })
		})
		this.schedule()
		return { seq, durable }
	}

	private schedule(): void {
		if (this.scheduled || this.flushing) return
		this.scheduled = true
		setImmediate(() => {
			this.scheduled = false
			void this.flush()
		})
	}

	private openSegment(firstSeq: number): void {
		this.fsx.mkdirSync(this.walDir, { recursive: true, mode: 0o700 })
		const file = segmentFileName(firstSeq)
		const full = path.join(this.walDir, file)
		const fd = this.fsx.openSync(full, 'a', 0o600)
		// a new file must survive a crash together with its directory entry
		this.hooks.beforeSync?.(file)
		this.fsx.fsyncSync(fd)
		this.hooks.beforeDirSync?.(this.walDir)
		fsyncDir(this.walDir, this.fsx)
		this.fd = fd
		this.segFile = file
		this.segFirstSeq = firstSeq
		this.segSize = this.fsx.fstatSync(fd).size
		this.segFrames = 0
	}

	private closeSegment(): void {
		if (this.fd !== null) {
			try {
				this.fsx.closeSync(this.fd)
			} catch {
				/* closing a segment is best effort */
			}
			this.fd = null
		}
	}

	private async flush(): Promise<void> {
		if (this.flushing) return
		this.flushing = true
		try {
			while (this.queue.length > 0 && !this.dead) {
				const batch = this.queue
				this.queue = []
				try {
					this.writeBatch(batch)
				} catch (e) {
					const err = e instanceof Error ? e : new Error(String(e))
					this.dead = err
					this.closeSegment()
					for (const q of batch) q.reject(err)
					for (const q of this.queue.splice(0)) q.reject(err)
					for (const w of this.waiters.splice(0)) w.reject(err)
					this.onFatal(err)
					return
				}
				this.durable = batch[batch.length - 1]!.seq
				for (const q of batch) q.resolve()
				this.releaseWaiters()
				await Promise.resolve()
			}
		} finally {
			this.flushing = false
			if (this.queue.length > 0 && !this.dead) this.schedule()
		}
	}

	/** Write every queued frame (rotating when a segment is full), then fsync each touched segment once. Synchronous: any throw is fatal. */
	private writeBatch(batch: Queued[]): void {
		const touched = new Set<string>()
		let i = 0
		while (i < batch.length) {
			const first = batch[i]!
			if (this.fd === null) this.openSegment(first.seq)
			else if (this.segFrames > 0 && this.segSize + first.frame.length > this.segmentBytes) {
				// seal the current segment (its frames are fsynced before the next file is created) and start the next one
				this.syncCurrent()
				touched.delete(this.segFile)
				this.closeSegment()
				this.openSegment(first.seq)
			}
			// take as many frames as fit in this segment (at least one)
			let end = i
			let bytes = 0
			while (end < batch.length) {
				const f = batch[end]!.frame
				if (end > i && this.segSize + bytes + f.length > this.segmentBytes) break
				bytes += f.length
				end++
			}
			const buf = Buffer.concat(batch.slice(i, end).map((q) => q.frame))
			this.hooks.beforeWrite?.(buf, this.segFile)
			const partial = this.hooks.partialWrite?.(buf, this.segFile)
			if (partial !== undefined && partial !== null) {
				this.fsx.writeSync(this.fd!, buf, 0, Math.max(0, Math.min(partial, buf.length)))
				throw new Error('labWal: simulated partial write')
			}
			let off = 0
			while (off < buf.length) off += this.fsx.writeSync(this.fd!, buf, off, buf.length - off)
			this.segSize += buf.length
			this.segFrames += end - i
			touched.add(this.segFile)
			i = end
		}
		if (touched.size > 0) this.syncCurrent()
	}

	private syncCurrent(): void {
		if (this.fd === null) return
		this.hooks.beforeSync?.(this.segFile)
		this.fsx.fsyncSync(this.fd)
		this.fsyncCount++
		this.hooks.onSync?.(this.segFile)
	}

	/** Remove every segment file whose events are all <= throughSeq (the snapshot's walSeq). The segment being written is kept unless it is fully covered. */
	truncateThrough(throughSeq: number): string[] {
		const segs = listSegments(this.walDir, this.fsx)
		const removed: string[] = []
		for (let i = 0; i < segs.length; i++) {
			const nextFirst = i + 1 < segs.length ? segs[i + 1]!.firstSeq : this.lastAssigned + 1
			const lastInSeg = nextFirst - 1
			if (lastInSeg <= throughSeq) {
				if (segs[i]!.file === this.segFile) this.closeSegment()
				this.fsx.unlinkSync(path.join(this.walDir, segs[i]!.file))
				removed.push(segs[i]!.file)
			}
		}
		if (removed.length > 0) fsyncDir(this.walDir, this.fsx)
		return removed
	}

	/** Graceful stop: wait for queued events, then remove EVERY segment file (a rollback needs wal/ empty, with no empty file left behind). */
	async closeAndRemoveAll(): Promise<void> {
		while (this.queue.length > 0 || this.flushing || this.scheduled) await new Promise((r) => setImmediate(r))
		this.closeSegment()
		for (const s of listSegments(this.walDir, this.fsx)) this.fsx.unlinkSync(path.join(this.walDir, s.file))
		try {
			fsyncDir(this.walDir, this.fsx)
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
		}
	}

	/** Stop writing, keep the files (a crash-like stop for tests, or before a final snapshot). */
	async close(): Promise<void> {
		while (this.queue.length > 0 || this.flushing || this.scheduled) await new Promise((r) => setImmediate(r))
		this.closeSegment()
	}
}

// ------------------------------------------------------------------ replay engine
/** What replay writes into. The daemon's layered state (P2b) and the in-memory model in the tests both implement it. */
export interface WalApplyTarget {
	pendingHas(key: string): boolean
	pendingSet(entry: { eventKey: string } & Record<string, unknown>): void
	pendingDelete(key: string): void
	consumedAdd(key: string): void
	exitedAdd(pubkey: string): void
	getScalar(name: string): unknown
	setScalar(name: string, value: unknown): void
	deleteScalar(name: string): void
	setInFlight(record: Record<string, unknown> | null): void
	/** P4 per-wallet slots; absent on targets that predate pools (an event with a slotSet op then fails loudly in applyOps). */
	setSlot?(wallet: string, record: Record<string, unknown> | null): void
}

/** Apply one event's ops. Every op is idempotent; applying an event twice leaves the state unchanged. */
export function applyOps(target: WalApplyTarget, ops: readonly WalOp[]): void {
	for (const op of ops) {
		switch (op.op) {
			case 'pendingAdd':
				if (!target.pendingHas(op.entry.eventKey)) target.pendingSet(op.entry)
				break
			case 'pendingDel':
				target.pendingDelete(op.key)
				break
			case 'consumedAdd':
				target.consumedAdd(op.key)
				break
			case 'exitedAdd':
				target.exitedAdd(op.pubkey)
				break
			case 'scalarsSet':
				for (const [k, v] of Object.entries(op.patch)) {
					if (WAL_MAX_MERGE_SCALARS.has(k) && typeof v === 'number') {
						const cur = target.getScalar(k)
						target.setScalar(k, typeof cur === 'number' ? Math.max(cur, v) : v)
					} else target.setScalar(k, v)
				}
				break
			case 'scalarsDel':
				for (const n of op.names) target.deleteScalar(n)
				break
			case 'inFlightSet':
				target.setInFlight(op.record)
				break
			case 'slotSet':
				if (!target.setSlot) throw new WalCorruptError('labWal: a slotSet event on a target without per-wallet slots')
				target.setSlot(op.wallet, op.record)
				break
			default: {
				const never: never = op
				throw new WalCorruptError(`labWal: unknown op ${JSON.stringify(never)}`)
			}
		}
	}
}

/**
 * The journal line the daemon prints when the log has mid-log damage (P2c uses it; the daemon only refuses to start and alerts, it never calls the repair command).
 */
export function formatWalMidCorruptionAlert(e: WalMidCorruptionError): string {
	return (
		`[labMiningPoolClPayout] ALERT WAL damaged in the middle: ${path.basename(e.file)} offset ${e.badOffset} (${e.reason}), ${e.laterFrameOffsets.length} valid frame(s) after it, ` +
		`last intact seq ${e.lastGoodSeq}. Refusing to start; nothing was truncated; no automatic repair. ` +
		'Offline only: labWalRepair with a run id and the PM written approval, after checking every intent in the cut frames against the signer record and the chain.'
	)
}
