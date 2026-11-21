/**
 * Cooperative snapshot writer (P2b-2; P2 design §4, errata W1/W4/W5).
 *
 * It writes the SAME on-disk layout as the whole-state writer of labClPayoutStateStore.ts (manifest + generation directory with pending-NNNNNN.jsonl, consumed.jsonl, exited.jsonl),
 * but reads the frozen layered views in slices of about `sliceMs` and yields to the event loop between slices, so a snapshot of ~1.7M pending + ~3M consumed never blocks
 * payments or scans for long. Nothing becomes visible before the manifest rename (commitGeneration), exactly as before.
 *
 * Modes:
 *   'wal'        manifest version 3 with top-level walSeq/walFormat (the running WAL-mode daemon)
 *   'downgrade'  manifest version 2 whose walSeq is the informational scalar scalars.walSeq (graceful stop: readable by df78e6b and P1; review Y1)
 *
 * The key-set hashes of the manifest are defined over the SORTED keys (keySetHash). To stay compatible, and still never sort 3M strings in one go, keys are sorted in chunks
 * of 64k (a few ms each) and merged k-way in slices (CooperativeKeySetHasher); the result is byte-identical to keySetHash (tested).
 *
 * The consumed prune (oldest first, never a key that is pending, down to 90% of the cap) is planned on the frozen views, cooperatively, and only when the cap is exceeded; the dropped keys
 * are appended to the cold archive BEFORE the manifest commit (an archive failure means: no prune this time, an alert, never a lost key).
 *
 * Failure: any throw before the commit removes the generation directory and leaves the previous committed state readable; the caller then aborts the layered views (no prune).
 * Node built-ins only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
	CONSUMED_FILE,
	EXITED_FILE,
	SEGMENTED_STATE_FORMAT,
	SEGMENTED_STATE_VERSION,
	SEGMENTED_STATE_VERSION_WAL,
	WAL_MANIFEST_FORMAT,
	beginGenerationDir,
	canonicalJson,
	commitGeneration,
	extractScalars,
	normalizeSegmentSize,
	removeGenerationDir,
	sha256Hex,
	writeInFlightBlob,
	type CommitResult,
	type FileDigest,
	type InFlightKeysRef,
	type SegmentRef,
	type SegmentedManifest,
	type WriteHooks,
} from './labClPayoutStateStore'
import { CONSUMED_PRUNE_TARGET_RATIO } from './labConsumedPrune'
import type { SnapshotSource } from './labPayoutStateCore'

export class SnapshotAbortedError extends Error {
	constructor(why: string) {
		super(`labSnapshotWriter: snapshot aborted: ${why}`)
	}
}

/** The few filesystem calls the writer makes, so tests can inject ENOSPC, fsync failures and slow disks. */
export interface SnapshotFs {
	openSync(file: string, flags: string, mode?: number): number
	writeSync(fd: number, buf: Buffer, offset: number, length: number): number
	fsyncSync(fd: number): void
	closeSync(fd: number): void
	renameSync(from: string, to: string): void
	rmSync(file: string, opts: { force: boolean; recursive?: boolean }): void
}
export const nodeSnapshotFs: SnapshotFs = {
	openSync: (f, fl, m) => fs.openSync(f, fl, m),
	writeSync: (fd, b, o, l) => fs.writeSync(fd, b, o, l),
	fsyncSync: (fd) => fs.fsyncSync(fd),
	closeSync: (fd) => fs.closeSync(fd),
	renameSync: (a, b) => fs.renameSync(a, b),
	rmSync: (f, o) => fs.rmSync(f, o),
}

export type SnapshotStats = {
	slices: number
	/** Longest stretch of synchronous work between two yields, in ms. */
	maxSliceMs: number
	totalMs: number
	pendingLines: number
	consumedLines: number
	exitedLines: number
	bytes: number
	prunePlanned: number
	archiveFailed: boolean
}

export type SnapshotWriteOptions = {
	dir: string
	mode: 'wal' | 'downgrade'
	segmentSize?: number
	/** Target length of one synchronous slice (default 50 ms). */
	sliceMs?: number
	/** What gives the event loop a turn between slices (default setImmediate). Tests use it to run work "concurrently" at every yield. */
	yieldFn?: () => Promise<void>
	now?: Date
	fs?: SnapshotFs
	/** Consumed soft cap (CONSUMED_KEYS_MAX); absent = never prune. The prune target is CONSUMED_PRUNE_TARGET_RATIO of it. */
	consumedCap?: number
	/** Append the keys to the cold archive durably. Called in chunks before the commit. A throw = no prune this time. */
	archive?: (keys: string[]) => void
	/** Awaited right before the commit (the WAL must be durable up to src.walSeq, so the snapshot never gets ahead of the log). A rejection aborts the snapshot. */
	waitDurable?: (walSeq: number) => Promise<void>
	hooks?: WriteHooks
	/** Called after each slice with its duration. */
	onSlice?: (ms: number, sliceNumber: number) => void
}

export type SnapshotWriteResult = {
	commit: CommitResult
	manifest: SegmentedManifest
	prunedKeys: string[]
	/** The writer's own count of history blocks in the frozen pending view, for HistoryBlockCounts.reconcileFrozen. */
	frozenHistCounts: Map<number, number>
	stats: SnapshotStats
}

const WRITE_BATCH_CHARS = 1 << 20
const ARCHIVE_CHUNK = 50_000
const SORT_CHUNK = 65_536
const TIME_CHECK_EVERY = 256

// ------------------------------------------------------------------ slicing
class Slicer {
	slices = 0
	maxSliceMs = 0
	private sliceStart = process.hrtime.bigint()
	private counter = 0
	constructor(
		private readonly sliceMs: number,
		private readonly yieldFn: () => Promise<void>,
		private readonly alive: () => boolean,
		private readonly onSlice?: (ms: number, n: number) => void
	) {}

	private ms(): number {
		return Number(process.hrtime.bigint() - this.sliceStart) / 1e6
	}

	/** Call once per item of work: checks the clock every TIME_CHECK_EVERY items and yields when the slice is used up. */
	async tick(): Promise<void> {
		if (++this.counter < TIME_CHECK_EVERY) return
		this.counter = 0
		if (this.ms() >= this.sliceMs) await this.yieldNow()
	}

	async yieldNow(): Promise<void> {
		const used = this.ms()
		this.slices++
		if (used > this.maxSliceMs) this.maxSliceMs = used
		this.onSlice?.(used, this.slices)
		await this.yieldFn()
		if (!this.alive()) throw new SnapshotAbortedError('the layered views were merged or aborted while the writer was running')
		this.sliceStart = process.hrtime.bigint()
	}

	finish(): void {
		const used = this.ms()
		if (used > this.maxSliceMs) this.maxSliceMs = used
	}
}

// ------------------------------------------------------------------ jsonl files
class JsonlFile {
	private fd: number | null
	private readonly tmp: string
	private batch = ''
	private readonly hash = createHash('sha256')
	lines = 0
	bytes = 0
	constructor(
		private readonly fsx: SnapshotFs,
		private readonly file: string
	) {
		this.tmp = `${file}.tmp.${process.pid}`
		this.fd = fsx.openSync(this.tmp, 'w', 0o600)
	}
	append(line: string): void {
		if (line.includes('\n')) throw new Error('labSnapshotWriter: jsonl line must not contain a newline')
		this.batch += line
		this.batch += '\n'
		this.lines++
		if (this.batch.length >= WRITE_BATCH_CHARS) this.flush()
	}
	private flush(): void {
		if (this.batch.length === 0) return
		const buf = Buffer.from(this.batch, 'utf8')
		this.batch = ''
		let off = 0
		while (off < buf.length) off += this.fsx.writeSync(this.fd!, buf, off, buf.length - off)
		this.hash.update(buf)
		this.bytes += buf.length
	}
	/** fsync, close, rename into place; returns the digest the manifest records. */
	finish(): FileDigest {
		this.flush()
		this.fsx.fsyncSync(this.fd!)
		const fd = this.fd!
		this.fd = null
		this.fsx.closeSync(fd)
		this.fsx.renameSync(this.tmp, this.file)
		return { lines: this.lines, bytes: this.bytes, sha256: this.hash.digest('hex') }
	}
	abort(): void {
		if (this.fd !== null) {
			try {
				this.fsx.closeSync(this.fd)
			} catch {
				/* already closed */
			}
			this.fd = null
		}
		try {
			this.fsx.rmSync(this.tmp, { force: true })
		} catch {
			/* best effort */
		}
	}
}

// ------------------------------------------------------------------ keySetHash, cooperatively
/**
 * Same value as labClPayoutStateStore.keySetHash(keys): sha256 over the keys sorted by UTF-16 code unit, each followed by "\n". Chunks of 64k are sorted as they arrive; digest() merges them k-way
 * in slices. Duplicates count (multiset), exactly like the original.
 */
export class CooperativeKeySetHasher {
	private chunks: string[][] = []
	private cur: string[] = []
	count = 0
	add(key: string): void {
		this.cur.push(key)
		this.count++
		if (this.cur.length >= SORT_CHUNK) {
			this.cur.sort()
			this.chunks.push(this.cur)
			this.cur = []
		}
	}
	async digest(slicer: Slicer | null): Promise<string> {
		if (this.cur.length > 0) {
			this.cur.sort()
			this.chunks.push(this.cur)
			this.cur = []
		}
		const hash = createHash('sha256')
		const chunks = this.chunks
		const pos = new Int32Array(chunks.length)
		// binary min-heap of chunk indexes ordered by the chunk's current key
		const heap: number[] = []
		const less = (a: number, b: number): boolean => chunks[a]![pos[a]!]! < chunks[b]![pos[b]!]!
		const up = (i: number): void => {
			while (i > 0) {
				const p = (i - 1) >> 1
				if (!less(heap[i]!, heap[p]!)) break
				;[heap[i], heap[p]] = [heap[p]!, heap[i]!]
				i = p
			}
		}
		const down = (i: number): void => {
			for (;;) {
				const l = 2 * i + 1
				const r = l + 1
				let m = i
				if (l < heap.length && less(heap[l]!, heap[m]!)) m = l
				if (r < heap.length && less(heap[r]!, heap[m]!)) m = r
				if (m === i) break
				;[heap[i], heap[m]] = [heap[m]!, heap[i]!]
				i = m
			}
		}
		for (let i = 0; i < chunks.length; i++) {
			if (chunks[i]!.length > 0) {
				heap.push(i)
				up(heap.length - 1)
			}
		}
		let buf = ''
		while (heap.length > 0) {
			const top = heap[0]!
			buf += chunks[top]![pos[top]!]!
			buf += '\n'
			if (buf.length >= 65_536) {
				hash.update(buf, 'utf8')
				buf = ''
			}
			pos[top]!++
			if (pos[top]! >= chunks[top]!.length) {
				const last = heap.pop()!
				if (heap.length > 0) {
					heap[0] = last
					down(0)
				}
			} else down(0)
			if (slicer) await slicer.tick()
		}
		if (buf.length > 0) hash.update(buf, 'utf8')
		this.chunks = []
		return hash.digest('hex')
	}
}

// ------------------------------------------------------------------ prune planning on the frozen views
/**
 * Same result as labConsumedPrune.planPrune(keysInInsertionOrder, pendingKeysLower, cap, ratio) but cooperative, and the lowercase-pending set is only built when the cap is exceeded.
 */
export async function planPruneCooperative(
	consumed: ReadonlyMap<string, unknown>,
	pending: ReadonlyMap<string, unknown>,
	cap: number,
	slicer: Slicer | null,
	ratio: number = CONSUMED_PRUNE_TARGET_RATIO
): Promise<string[]> {
	if (consumed.size <= cap) return []
	const target = Math.max(0, Math.floor(cap * ratio))
	const excess = consumed.size - target
	const pendingLower = new Set<string>()
	for (const k of pending.keys()) {
		pendingLower.add(k.toLowerCase())
		if (slicer) await slicer.tick()
	}
	const out: string[] = []
	for (const k of consumed.keys()) {
		if (out.length >= excess) break
		if (!pendingLower.has(k.toLowerCase())) out.push(k)
		if (slicer) await slicer.tick()
	}
	return out
}

// ------------------------------------------------------------------ the writer
function stripInFlightKeys(scalars: Record<string, unknown>): { scalars: Record<string, unknown>; keys: string[] | null; idempotencyKey: string | null } {
	const rec = scalars.inFlightWithdraw
	if (rec !== null && typeof rec === 'object' && !Array.isArray(rec) && Array.isArray((rec as Record<string, unknown>).eventKeys)) {
		const keys = (rec as Record<string, unknown>).eventKeys as unknown[]
		for (const k of keys) if (typeof k !== 'string' || k === '') throw new Error('labSnapshotWriter: in-flight eventKeys must be non-empty strings')
		const rest: Record<string, unknown> = { ...(rec as Record<string, unknown>) }
		delete rest.eventKeys
		const idem = (rec as Record<string, unknown>).idempotencyKey
		return { scalars: extractScalars({ ...scalars, inFlightWithdraw: rest }), keys: keys as string[], idempotencyKey: typeof idem === 'string' ? idem : null }
	}
	return { scalars: extractScalars(scalars), keys: null, idempotencyKey: null }
}

export async function writeSnapshotCooperative(src: SnapshotSource, opts: SnapshotWriteOptions): Promise<SnapshotWriteResult> {
	const t0 = process.hrtime.bigint()
	const fsx = opts.fs ?? nodeSnapshotFs
	const segmentSize = normalizeSegmentSize(opts.segmentSize)
	const sliceMs = opts.sliceMs ?? 50
	const yieldFn = opts.yieldFn ?? (() => new Promise<void>((r) => setImmediate(r)))
	const alive = (): boolean => src.pending.isValid() && src.consumed.isValid() && src.exited.isValid()
	const slicer = new Slicer(sliceMs, yieldFn, alive, opts.onSlice)
	if (!alive()) throw new SnapshotAbortedError('the snapshot handles are no longer valid')
	const now = opts.now ?? new Date()
	const { generation, genDir } = beginGenerationDir(opts.dir, now)
	const open: JsonlFile[] = []
	const track = (f: JsonlFile): JsonlFile => {
		open.push(f)
		return f
	}
	const stats: SnapshotStats = { slices: 0, maxSliceMs: 0, totalMs: 0, pendingLines: 0, consumedLines: 0, exitedLines: 0, bytes: 0, prunePlanned: 0, archiveFailed: false }
	try {
		const { scalars: manifestScalars, keys: inFlightKeys, idempotencyKey } = stripInFlightKeys(src.scalars)
		delete manifestScalars.walSeq // the seq travels in the manifest (version 3) or as the informational scalar added below (version 2 downgrade)
		let inFlightRef: InFlightKeysRef | undefined
		if (inFlightKeys) {
			if (!idempotencyKey) throw new Error('labSnapshotWriter: in-flight record has no idempotencyKey')
			inFlightRef = writeInFlightBlob(opts.dir, inFlightKeys, idempotencyKey, segmentSize)
		}

		// 1. the consumed prune, planned on the frozen views; archived durably before anything is committed
		let prunedKeys: string[] = []
		if (opts.consumedCap !== undefined) {
			prunedKeys = await planPruneCooperative(src.consumed.view, src.pending.view, opts.consumedCap, slicer)
			stats.prunePlanned = prunedKeys.length
			if (prunedKeys.length > 0) {
				if (!opts.archive) {
					prunedKeys = [] // nowhere to archive: never drop a key silently
				} else {
					try {
						for (let i = 0; i < prunedKeys.length; i += ARCHIVE_CHUNK) {
							opts.archive(prunedKeys.slice(i, i + ARCHIVE_CHUNK))
							await slicer.yieldNow()
						}
					} catch (e) {
						if (e instanceof SnapshotAbortedError) throw e
						stats.archiveFailed = true // archive failure = no prune this time (the keys stay in consumed), the snapshot itself goes on
						prunedKeys = []
					}
				}
			}
		}
		const pruneSet = new Set(prunedKeys)

		// 2. pending: frozen insertion order, files of at most segmentSize lines (W4); the history blocks are counted on the way (W5)
		const frozenHistCounts = new Map<number, number>()
		const pendingHasher = new CooperativeKeySetHasher()
		const segments: SegmentRef[] = []
		let segIdx = 0
		let cur: JsonlFile | null = null
		let curName = ''
		const closeSegment = (): void => {
			if (cur === null) return
			const digest = cur.finish()
			segments.push({ file: curName, ...digest })
			stats.bytes += digest.bytes
			opts.hooks?.afterFile?.(`${generation}/${curName}`)
			cur = null
		}
		for (const [key, entry] of src.pending.entries()) {
			if (cur === null) {
				curName = `pending-${String(segIdx++).padStart(6, '0')}.jsonl`
				cur = track(new JsonlFile(fsx, path.join(genDir, curName)))
			}
			cur.append(JSON.stringify(entry))
			pendingHasher.add(key)
			stats.pendingLines++
			const b = (entry as { blockNumber?: unknown }).blockNumber
			if (src.freezeH !== null && typeof b === 'number' && b <= src.freezeH) frozenHistCounts.set(b, (frozenHistCounts.get(b) ?? 0) + 1)
			if (cur.lines >= segmentSize) closeSegment()
			await slicer.tick()
		}
		closeSegment()

		// 3. consumed (minus the planned prune) and exited, in insertion order
		const writeKeyFile = async (file: string, source: IterableIterator<[string, true]>, skip: ReadonlySet<string> | null): Promise<{ digest: FileDigest; keySetSha256: string; lines: number }> => {
			const f = track(new JsonlFile(fsx, path.join(genDir, file)))
			const hasher = new CooperativeKeySetHasher()
			for (const [k] of source) {
				if (skip !== null && skip.has(k)) continue
				f.append(JSON.stringify(k))
				hasher.add(k)
				await slicer.tick()
			}
			const digest = f.finish()
			stats.bytes += digest.bytes
			opts.hooks?.afterFile?.(`${generation}/${file}`)
			const keySetSha256 = await hasher.digest(slicer)
			return { digest, keySetSha256, lines: digest.lines }
		}
		const consumedOut = await writeKeyFile(CONSUMED_FILE, src.consumed.entries(), pruneSet)
		stats.consumedLines = consumedOut.lines
		const exitedOut = await writeKeyFile(EXITED_FILE, src.exited.entries(), null)
		stats.exitedLines = exitedOut.lines

		const pendingKeySetSha256 = await pendingHasher.digest(slicer)
		const scalarsForManifest: Record<string, unknown> = { ...manifestScalars }
		if (opts.mode === 'downgrade') scalarsForManifest.walSeq = src.walSeq
		const manifest: SegmentedManifest = {
			format: SEGMENTED_STATE_FORMAT,
			version: opts.mode === 'wal' ? SEGMENTED_STATE_VERSION_WAL : SEGMENTED_STATE_VERSION,
			...(opts.mode === 'wal' ? { walSeq: src.walSeq, walFormat: WAL_MANIFEST_FORMAT } : {}),
			generation,
			previousGeneration: null,
			writtenAt: now.toISOString(),
			segmentSize,
			scalars: scalarsForManifest,
			scalarsSha256: sha256Hex(canonicalJson(scalarsForManifest)),
			pending: { count: stats.pendingLines, keySetSha256: pendingKeySetSha256, segments },
			consumed: { file: CONSUMED_FILE, ...consumedOut.digest, keySetSha256: consumedOut.keySetSha256 },
			exited: { file: EXITED_FILE, ...exitedOut.digest, keySetSha256: exitedOut.keySetSha256 },
			...(inFlightRef ? { inFlightKeys: inFlightRef } : {}),
		}
		slicer.finish()

		// 4. the snapshot must never get ahead of the log: wait until the events up to walSeq are durable, then check the views are still ours and commit
		if (opts.waitDurable) await opts.waitDurable(src.walSeq)
		if (!alive()) throw new SnapshotAbortedError('the layered views were merged or aborted before the commit')
		const commit = commitGeneration({ dir: opts.dir, generation, genDir, manifest }, { hooks: opts.hooks })
		stats.slices = slicer.slices
		stats.maxSliceMs = slicer.maxSliceMs
		stats.totalMs = Number(process.hrtime.bigint() - t0) / 1e6
		return { commit, manifest, prunedKeys, frozenHistCounts, stats }
	} catch (e) {
		for (const f of open) f.abort()
		removeGenerationDir(opts.dir, genDir)
		throw e
	}
}
