/**
 * Lab CL payout state, format v2 (segmented, streamed).
 *
 * Why: the v1 single file was written with JSON.stringify(whole state). Once the text
 * passes V8's max string length (536,870,888 chars) the save throws "Invalid string length"
 * on every tick, so the payout daemon stops paying. This store never builds one big string.
 *
 * On-disk layout (stateDir = legacy state file path without a trailing ".json", plus ".v2"):
 *   manifest.json                 the only commit point (tmp + fsync + rename)
 *   gen-<UTC>-<rand12>/           one directory per write generation, never referenced until committed
 *     pending-NNNNNN.jsonl        one pending entry (JSON object) per line, segmentSize lines per file
 *     consumed.jsonl              one consumedEventKeys key (JSON string) per line; value is always true
 *     exited.jsonl                one exitedPubkeys key (JSON string) per line; value is always true
 *
 * Every other top-level field (cursors, freezeH, updatedAt, ...) is kept verbatim in
 * manifest.scalars. Reads verify each file by line count, byte count and sha256, and verify
 * the key-set hashes. Any mismatch throws. Nothing falls back to an empty state.
 *
 * Node built-ins only. No WebSocket. No dependency on the reporter.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export const SEGMENTED_STATE_FORMAT = 'beamio-lab-clpayout-state' as const
export const SEGMENTED_STATE_VERSION = 2 as const
/**
 * WAL mode (P2, errata W1): the manifest is version 3 and carries `walSeq` (the last WAL event the snapshot contains) and `walFormat` at the top level. The directory layout
 * is the same as version 2. A reader that only knows version 2 (df78e6b, P1) refuses a version 3 manifest, which is the point: such a reader would silently lose the WAL events.
 * A graceful stop writes a version 2 DOWNGRADE snapshot instead; it carries `walSeq` only as the informational scalar `scalars.walSeq` (review Y1).
 */
export const SEGMENTED_STATE_VERSION_WAL = 3 as const
export const WAL_MANIFEST_FORMAT = 1 as const
export const SEGMENTED_MANIFEST_FILE = 'manifest.json'
export const DEFAULT_PENDING_SEGMENT_SIZE = 100_000
/** V8 max string length on 64-bit builds. The legacy single file must stay below this for one JSON.parse. */
export const V8_MAX_STRING_LENGTH = 536_870_888

export const CONSUMED_FILE = 'consumed.jsonl'
export const EXITED_FILE = 'exited.jsonl'
const WRITE_BATCH_CHARS = 4 * 1024 * 1024
const READ_CHUNK_BYTES = 4 * 1024 * 1024
const GENERATION_RE = /^gen-\d{8}T\d{6}Z-[0-9a-f]{12}$/
const SEGMENT_FILE_RE = /^pending-\d{6}\.jsonl$/
const SHA256_RE = /^[0-9a-f]{64}$/
const IN_FLIGHT_SEGMENT_RE = /^key-\d{6}\.jsonl$/
const INFLIGHT_DIR = 'inflight'
/** Per keys-array cache of the blob that holds it. Keyed by object identity, so an unchanged record is free. */
const inflightCache = new WeakMap<string[], { dir: string; ref: InFlightKeysRef }>()
const RESERVED_FIELDS: ReadonlySet<string> = new Set(['pending', 'consumedEventKeys', 'exitedPubkeys'])

export type PendingRecord = { eventKey: string } & Record<string, unknown>

export type SegmentedStateInput = {
	pending?: PendingRecord[]
	consumedEventKeys?: Record<string, true>
	exitedPubkeys?: Record<string, true>
} & Record<string, unknown>

export type SegmentedState = {
	pending: PendingRecord[]
	consumedEventKeys: Record<string, true>
	exitedPubkeys: Record<string, true>
} & Record<string, unknown>

export type FileDigest = { lines: number; bytes: number; sha256: string }
export type SegmentRef = FileDigest & { file: string }
export type KeyFileRef = FileDigest & { file: string; keySetSha256: string }
/** In-flight eventKeys blob: id names inflight/<id>/, count and keySetSha256 are checked on read. */
export type InFlightKeysRef = { id: string; count: number; keySetSha256: string; segments: SegmentRef[] }

export type SegmentedManifest = {
	format: typeof SEGMENTED_STATE_FORMAT
	version: typeof SEGMENTED_STATE_VERSION | typeof SEGMENTED_STATE_VERSION_WAL
	/** Version 3 only: the seq of the last WAL event contained in this snapshot. */
	walSeq?: number
	/** Version 3 only. */
	walFormat?: typeof WAL_MANIFEST_FORMAT
	generation: string
	previousGeneration: string | null
	writtenAt: string
	segmentSize: number
	scalars: Record<string, unknown>
	scalarsSha256: string
	pending: { count: number; keySetSha256: string; segments: SegmentRef[] }
	consumed: KeyFileRef
	exited: KeyFileRef
	/** Present only while an in-flight withdrawal record exists (B-2d). */
	inFlightKeys?: InFlightKeysRef
}

export type WriteHooks = {
	/** Called after each data file is renamed into place. Throw to simulate a crash mid-write. */
	afterFile?: (relPath: string) => void
	/** Called with the manifest right before the commit rename. Throw to simulate a crash before commit. */
	beforeCommit?: (manifest: SegmentedManifest) => void
	/**
	 * Called after the manifest is written and fsynced to its staging file, before the rename that
	 * makes it visible. Throw to simulate a crash at the commit point.
	 */
	beforeManifestRename?: (stagedFile: string) => void
}

export type WriteOptions = {
	segmentSize?: number
	hooks?: WriteHooks
	now?: Date
}

export type PreparedGeneration = {
	dir: string
	generation: string
	genDir: string
	manifest: SegmentedManifest
}

export type CommitResult = {
	generation: string
	previousGeneration: string | null
	removed: string[]
}

export type InspectStatus = 'absent' | 'committed' | 'orphan'

export type StateSummary = {
	scalarFields: string[]
	scalarsSha256: string
	pendingCount: number
	pendingKeySetSha256: string
	pendingDuplicateKeys: number
	consumedCount: number
	consumedKeySetSha256: string
	exitedCount: number
	exitedKeySetSha256: string
	/** Pending entries whose eventKey is also in consumedEventKeys. Must be 0 before migrating. */
	pendingConsumedOverlap: number
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function bad(label: string, why: string): Error {
	return new Error(`labClPayoutStateStore: ${label}: ${why}`)
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonNegInt(v: unknown): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function isPosInt(v: unknown): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
}

function isSha256Hex(v: unknown): v is string {
	return typeof v === 'string' && SHA256_RE.test(v)
}

function isEnoent(e: unknown): boolean {
	return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Existence check that fails closed. Only ENOENT means "absent". Any other stat error
 * (EACCES, EIO, ENOTDIR, ...) is thrown. fs.existsSync must not be used for state decisions,
 * because it reports every error as "absent".
 */
export function pathExistsStrict(p: string): boolean {
	try {
		fs.statSync(p)
		return true
	} catch (e) {
		if (isEnoent(e)) return false
		throw e
	}
}

function isGenerationId(v: unknown): v is string {
	return typeof v === 'string' && GENERATION_RE.test(v)
}

function isFileDigestLike(v: unknown): v is FileDigest & { file: string } {
	return (
		isPlainObject(v) &&
		typeof v.file === 'string' &&
		isNonNegInt(v.lines) &&
		isNonNegInt(v.bytes) &&
		isSha256Hex(v.sha256)
	)
}

export function sha256Hex(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex')
}

/** Streaming sha256 of a file (no full-file buffer). */
export function sha256File(file: string): string {
	const fd = fs.openSync(file, 'r')
	try {
		const hash = createHash('sha256')
		const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
		for (;;) {
			const n = fs.readSync(fd, chunk, 0, chunk.length, null)
			if (n === 0) break
			hash.update(chunk.subarray(0, n))
		}
		return hash.digest('hex')
	} finally {
		fs.closeSync(fd)
	}
}

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Used for scalar hashes and
 * for record-level equality checks during migration.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return 'null'
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>
		const keys = Object.keys(obj).sort()
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
	}
	const s = JSON.stringify(value)
	if (s === undefined) throw new Error(`canonicalJson: unsupported value type ${typeof value}`)
	return s
}

/**
 * Key-set hash: sort the keys by UTF-16 code unit, join each with "\n" (including the last one),
 * sha256 over the UTF-8 bytes. The empty set hashes to sha256(""). Multiset: duplicates count.
 */
export function keySetHash(keys: Iterable<string>): string {
	const sorted = Array.from(keys)
	for (const k of sorted) {
		if (typeof k !== 'string') throw new Error('keySetHash: non-string key')
	}
	sorted.sort()
	const hash = createHash('sha256')
	for (const k of sorted) {
		hash.update(k, 'utf8')
		hash.update('\n', 'utf8')
	}
	return hash.digest('hex')
}

function checkTrueMap(map: unknown, label: string): asserts map is Record<string, true> {
	if (!isPlainObject(map)) throw new Error(`labClPayoutStateStore: ${label} must be an object`)
	for (const k of Object.keys(map)) {
		if (k === '' || k === '__proto__') throw new Error(`labClPayoutStateStore: ${label} has an invalid key`)
		if (map[k] !== true) throw new Error(`labClPayoutStateStore: ${label} has a value other than true`)
	}
}

/** Every top-level field except the three collections, copied through JSON so undefined is dropped. */
export function extractScalars(state: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const k of Object.keys(state)) {
		if (RESERVED_FIELDS.has(k)) continue
		if (k === '__proto__') throw new Error('labClPayoutStateStore: __proto__ is not a valid field name')
		const json = JSON.stringify(state[k])
		if (json === undefined) continue
		out[k] = JSON.parse(json)
	}
	return out
}

function normalizeForWrite(input: SegmentedStateInput): {
	scalars: Record<string, unknown>
	pending: PendingRecord[]
	consumed: Record<string, true>
	exited: Record<string, true>
	/** eventKeys of the in-flight record, written as their own blob. Null when there is no in-flight record. */
	inFlightKeys: string[] | null
	inFlightIdempotencyKey: string | null
} {
	if (!isPlainObject(input)) throw new Error('labClPayoutStateStore: state must be an object')
	const pending = input.pending ?? []
	if (!Array.isArray(pending)) throw new Error('labClPayoutStateStore: pending must be an array')
	for (const e of pending) {
		if (!isPlainObject(e) || typeof e.eventKey !== 'string' || e.eventKey === '') {
			throw new Error('labClPayoutStateStore: every pending entry must be an object with a non-empty string eventKey')
		}
	}
	const consumed = input.consumedEventKeys ?? {}
	const exited = input.exitedPubkeys ?? {}
	checkTrueMap(consumed, 'consumedEventKeys')
	checkTrueMap(exited, 'exitedPubkeys')
	const rec = input.inFlightWithdraw
	if (isPlainObject(rec) && Array.isArray(rec.eventKeys)) {
		const keys = rec.eventKeys as unknown[]
		for (const k of keys) {
			if (typeof k !== 'string' || k === '') throw new Error('labClPayoutStateStore: in-flight eventKeys must be non-empty strings')
		}
		// Strip eventKeys before extractScalars, so the (large) key array is never serialized into the manifest.
		const restRec: Record<string, unknown> = { ...rec }
		delete restRec.eventKeys
		return {
			scalars: extractScalars({ ...input, inFlightWithdraw: restRec }),
			pending,
			consumed,
			exited,
			inFlightKeys: keys as string[],
			inFlightIdempotencyKey: typeof rec.idempotencyKey === 'string' ? rec.idempotencyKey : null,
		}
	}
	return { scalars: extractScalars(input), pending, consumed, exited, inFlightKeys: null, inFlightIdempotencyKey: null }
}

export function normalizeSegmentSize(v: number | undefined): number {
	if (v === undefined) return DEFAULT_PENDING_SEGMENT_SIZE
	if (!isPosInt(v)) throw new Error('labClPayoutStateStore: segmentSize must be a positive integer')
	return v
}

/** Generation ids created by this process. Only these may be pruned by this process. */
const ownGenerations = new Set<string>()

/** For the cooperative snapshot writer: create dir/<new generation>/ and register it as created by this process (so the commit's prune may remove an old one). */
export function beginGenerationDir(dir: string, now: Date): { generation: string; genDir: string } {
	const generation = newGenerationId(now)
	ownGenerations.add(generation)
	const genDir = path.join(dir, generation)
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	fs.mkdirSync(genDir, { mode: 0o700 })
	return { generation, genDir }
}

export function newGenerationId(now: Date): string {
	const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
	return `gen-${stamp.slice(0, 8)}T${stamp.slice(9)}-${randomBytes(6).toString('hex')}`
}

function writeAllSync(fd: number, buf: Buffer): void {
	let off = 0
	while (off < buf.length) {
		off += fs.writeSync(fd, buf, off, buf.length - off)
	}
}

function fsyncDirBestEffort(dir: string): void {
	try {
		const fd = fs.openSync(dir, 'r')
		try {
			fs.fsyncSync(fd)
		} finally {
			fs.closeSync(fd)
		}
	} catch {
		/* not supported on every platform; the file-level fsync already happened */
	}
}

/** fsync a directory. Throws on failure. Used before a commit, where a failure must abort it. */
export function fsyncDirStrict(dir: string): void {
	const fd = fs.openSync(dir, 'r')
	try {
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
}

function writeFileDurable(file: string, text: string): void {
	const fd = fs.openSync(file, 'w', 0o600)
	try {
		writeAllSync(fd, Buffer.from(text, 'utf8'))
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
}

/**
 * Write one JSONL file in batches of about WRITE_BATCH_CHARS characters, fsync, then rename.
 * Never joins the whole file into one string.
 */
function writeJsonlFile(file: string, lines: Iterable<string>): FileDigest {
	const tmp = `${file}.tmp.${process.pid}`
	const fd = fs.openSync(tmp, 'w', 0o600)
	const hash = createHash('sha256')
	let count = 0
	let bytes = 0
	try {
		let batch = ''
		const flush = (): void => {
			if (batch.length === 0) return
			const buf = Buffer.from(batch, 'utf8')
			batch = ''
			writeAllSync(fd, buf)
			hash.update(buf)
			bytes += buf.length
		}
		for (const line of lines) {
			if (line.includes('\n')) throw new Error('labClPayoutStateStore: jsonl line must not contain a newline')
			batch += line
			batch += '\n'
			count++
			if (batch.length >= WRITE_BATCH_CHARS) flush()
		}
		flush()
		fs.fsyncSync(fd)
	} catch (e) {
		try {
			fs.closeSync(fd)
		} catch {
			/* already closed */
		}
		try {
			fs.rmSync(tmp, { force: true })
		} catch {
			/* best effort */
		}
		throw e
	}
	fs.closeSync(fd)
	fs.renameSync(tmp, file)
	return { lines: count, bytes, sha256: hash.digest('hex') }
}

function* jsonObjectLines(items: readonly unknown[]): Generator<string> {
	for (const item of items) yield JSON.stringify(item)
}

function* jsonStringLines(keys: readonly string[]): Generator<string> {
	for (const k of keys) yield JSON.stringify(k)
}

/**
 * Stream a JSONL file: read in chunks, split on 0x0A bytes (never inside UTF-8 multibyte
 * sequences), and hash every byte. Returns the measured digest. A missing final newline throws.
 */
function streamJsonlFile(file: string, onLine: (line: string) => void): FileDigest {
	const fd = fs.openSync(file, 'r')
	try {
		const hash = createHash('sha256')
		const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
		let carry: Buffer | null = null
		let lines = 0
		let bytes = 0
		for (;;) {
			const n = fs.readSync(fd, chunk, 0, chunk.length, null)
			if (n === 0) break
			bytes += n
			const part = chunk.subarray(0, n)
			hash.update(part)
			const data: Buffer = carry ? Buffer.concat([carry, part]) : part
			let start = 0
			for (;;) {
				const idx = data.indexOf(0x0a, start)
				if (idx < 0) break
				onLine(data.toString('utf8', start, idx))
				lines++
				start = idx + 1
			}
			carry = start < data.length ? Buffer.from(data.subarray(start)) : null
		}
		if (carry) throw new Error(`labClPayoutStateStore: ${file}: trailing bytes without a final newline`)
		return { lines, bytes, sha256: hash.digest('hex') }
	} finally {
		fs.closeSync(fd)
	}
}

function verifyDigest(label: string, got: FileDigest, expect: FileDigest): void {
	if (got.lines !== expect.lines) {
		throw bad(label, `line count ${got.lines} != manifest ${expect.lines}`)
	}
	if (got.bytes !== expect.bytes) {
		throw bad(label, `byte count ${got.bytes} != manifest ${expect.bytes}`)
	}
	if (got.sha256 !== expect.sha256) {
		throw bad(label, 'sha256 does not match manifest')
	}
}

export function removeGenerationDir(dir: string, genDir: string): void {
	const name = path.basename(genDir)
	if (path.dirname(path.resolve(genDir)) !== path.resolve(dir) || !GENERATION_RE.test(name)) return
	try {
		fs.rmSync(genDir, { recursive: true, force: true })
	} catch {
		/* best effort; an unreferenced generation is ignored by readers */
	}
}

/**
 * Remove unreferenced generations and manifest tmp files that THIS process created. Entries made by
 * another process, or by an earlier run, are never touched (they may belong to a live writer). Never throws.
 */
function pruneGenerations(dir: string, keep: ReadonlyArray<string | null>): string[] {
	const removed: string[] = []
	let entries: string[] = []
	try {
		entries = fs.readdirSync(dir)
	} catch {
		return removed
	}
	const keepSet = new Set(keep.filter((x): x is string => typeof x === 'string'))
	const ownManifestTmp = `${SEGMENTED_MANIFEST_FILE}.tmp.${process.pid}`
	for (const name of entries) {
		if (keepSet.has(name)) continue
		const mine = name === ownManifestTmp || (GENERATION_RE.test(name) && ownGenerations.has(name))
		if (!mine) continue
		try {
			fs.rmSync(path.join(dir, name), { recursive: true, force: true })
			ownGenerations.delete(name)
			removed.push(name)
		} catch {
			/* best effort */
		}
	}
	return removed
}

// ---------------------------------------------------------------------------
// Paths and inspection
// ---------------------------------------------------------------------------

/** v2 state directory derived from the legacy single-file path: "x.json" -> "x.v2". */
export function segmentedDirForLegacy(legacyFile: string): string {
	const base = legacyFile.endsWith('.json') ? legacyFile.slice(0, -'.json'.length) : legacyFile
	return `${base}.v2`
}

/**
 * absent: no dir, or an empty dir.
 * committed: manifest.json exists (authoritative; reads must verify it).
 * orphan: entries exist but there is no manifest. Never treat this as an empty state.
 */
export function inspectSegmentedDir(dir: string): InspectStatus {
	if (!pathExistsStrict(dir)) return 'absent'
	if (pathExistsStrict(path.join(dir, SEGMENTED_MANIFEST_FILE))) return 'committed'
	return fs.readdirSync(dir).length > 0 ? 'orphan' : 'absent'
}

/** Legacy single-file state: true when present, false only on ENOENT, throws on any other error. */
export function legacyStateFileExists(file: string): boolean {
	return pathExistsStrict(file)
}

// ---------------------------------------------------------------------------
// Write path: generation first, manifest commit last
// ---------------------------------------------------------------------------

/**
 * Write every data file of a new generation directory. Nothing becomes visible to readers
 * until commitGeneration() renames the manifest. On failure the generation dir is removed.
 */
export function writeGeneration(dir: string, input: SegmentedStateInput, opts: WriteOptions = {}): PreparedGeneration {
	const segmentSize = normalizeSegmentSize(opts.segmentSize)
	const st = normalizeForWrite(input)
	const now = opts.now ?? new Date()
	const generation = newGenerationId(now)
	ownGenerations.add(generation)
	const genDir = path.join(dir, generation)
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	fs.mkdirSync(genDir, { mode: 0o700 })
	try {
		let inFlightRef: InFlightKeysRef | undefined
		if (st.inFlightKeys) {
			if (!st.inFlightIdempotencyKey) throw bad(dir, 'in-flight record has no idempotencyKey')
			inFlightRef = writeInFlightBlob(dir, st.inFlightKeys, st.inFlightIdempotencyKey, segmentSize)
		}
		const segments: SegmentRef[] = []
		for (let start = 0, idx = 0; start < st.pending.length; start += segmentSize, idx++) {
			const file = `pending-${String(idx).padStart(6, '0')}.jsonl`
			const slice = st.pending.slice(start, start + segmentSize)
			const digest = writeJsonlFile(path.join(genDir, file), jsonObjectLines(slice))
			segments.push({ file, ...digest })
			opts.hooks?.afterFile?.(`${generation}/${file}`)
		}
		const consumedKeys = Object.keys(st.consumed)
		const consumedDigest = writeJsonlFile(path.join(genDir, CONSUMED_FILE), jsonStringLines(consumedKeys))
		opts.hooks?.afterFile?.(`${generation}/${CONSUMED_FILE}`)
		const exitedKeys = Object.keys(st.exited)
		const exitedDigest = writeJsonlFile(path.join(genDir, EXITED_FILE), jsonStringLines(exitedKeys))
		opts.hooks?.afterFile?.(`${generation}/${EXITED_FILE}`)

		const manifest: SegmentedManifest = {
			format: SEGMENTED_STATE_FORMAT,
			version: SEGMENTED_STATE_VERSION,
			generation,
			previousGeneration: null,
			writtenAt: now.toISOString(),
			segmentSize,
			scalars: st.scalars,
			scalarsSha256: sha256Hex(canonicalJson(st.scalars)),
			pending: {
				count: st.pending.length,
				keySetSha256: keySetHash(st.pending.map((e) => e.eventKey)),
				segments,
			},
			consumed: { file: CONSUMED_FILE, ...consumedDigest, keySetSha256: keySetHash(consumedKeys) },
			exited: { file: EXITED_FILE, ...exitedDigest, keySetSha256: keySetHash(exitedKeys) },
			...(inFlightRef ? { inFlightKeys: inFlightRef } : {}),
		}
		return { dir, generation, genDir, manifest }
	} catch (e) {
		removeGenerationDir(dir, genDir)
		throw e
	}
}

function readCommittedGenerationId(dir: string): string | null {
	if (!pathExistsStrict(path.join(dir, SEGMENTED_MANIFEST_FILE))) return null
	return readManifest(dir).generation
}

/**
 * Commit point. The manifest is written to a tmp file, fsynced, then renamed over manifest.json.
 * Before the rename, any failure removes the prepared generation. After the rename, nothing here throws.
 */
export function commitGeneration(prepared: PreparedGeneration, opts: WriteOptions = {}): CommitResult {
	const { dir, generation, genDir } = prepared
	const manifestPath = path.join(dir, SEGMENTED_MANIFEST_FILE)
	const tmp = `${manifestPath}.tmp.${process.pid}`
	let previous: string | null = null
	let toCommit: SegmentedManifest
	try {
		previous = readCommittedGenerationId(dir)
		toCommit = {
			...prepared.manifest,
			previousGeneration: previous !== null && previous !== generation ? previous : null,
		}
		// The manifest must not name a generation whose directory entries can still be lost.
		// Make the segment renames inside genDir durable, then genDir's own entry in dir.
		// Unlike the post-rename fsync below, a failure here aborts the commit.
		fsyncDirStrict(genDir)
		fsyncDirStrict(dir)
		opts.hooks?.beforeCommit?.(toCommit)
		writeFileDurable(tmp, `${JSON.stringify(toCommit, null, 2)}\n`)
		opts.hooks?.beforeManifestRename?.(tmp)
		fs.renameSync(tmp, manifestPath)
	} catch (e) {
		try {
			fs.rmSync(tmp, { force: true })
		} catch {
			/* best effort */
		}
		removeGenerationDir(dir, genDir)
		throw e
	}
	fsyncDirBestEffort(dir)
	const keep: Array<string | null> = [generation, toCommit.previousGeneration]
	const removed = pruneGenerations(dir, keep)
	pruneInFlightBlobs(dir, toCommit.inFlightKeys?.id ?? null)
	return { generation, previousGeneration: toCommit.previousGeneration, removed }
}

/** Write a generation and commit it. A pre-commit failure leaves the previous committed state readable. */
export function writeSegmentedState(dir: string, input: SegmentedStateInput, opts: WriteOptions = {}): CommitResult {
	const prepared = writeGeneration(dir, input, opts)
	return commitGeneration(prepared, opts)
}

// ---------------------------------------------------------------------------
// Read path: strict verification, no empty fallback
// ---------------------------------------------------------------------------

function parseManifest(raw: unknown, label: string): SegmentedManifest {
	if (!isPlainObject(raw)) throw bad(label, 'manifest is not an object')
	if (raw.format !== SEGMENTED_STATE_FORMAT) throw bad(label, 'unknown format')
	if (raw.version !== SEGMENTED_STATE_VERSION && raw.version !== SEGMENTED_STATE_VERSION_WAL) throw bad(label, 'unsupported version')
	if (raw.version === SEGMENTED_STATE_VERSION_WAL) {
		if (!isNonNegInt(raw.walSeq)) throw bad(label, 'version 3 manifest without a valid walSeq')
		if (raw.walFormat !== WAL_MANIFEST_FORMAT) throw bad(label, 'unsupported walFormat')
	} else if (raw.walSeq !== undefined || raw.walFormat !== undefined) {
		throw bad(label, 'a version 2 manifest must not carry walSeq/walFormat at the top level (the downgrade snapshot keeps it in scalars.walSeq)')
	}
	if (!isGenerationId(raw.generation)) throw bad(label, 'bad generation id')
	if (raw.previousGeneration !== null && !isGenerationId(raw.previousGeneration)) {
		throw bad(label, 'bad previousGeneration')
	}
	if (typeof raw.writtenAt !== 'string') throw bad(label, 'bad writtenAt')
	if (!isPosInt(raw.segmentSize)) throw bad(label, 'bad segmentSize')
	const scalars = raw.scalars
	if (!isPlainObject(scalars)) throw bad(label, 'scalars missing')
	for (const k of Object.keys(scalars)) {
		if (RESERVED_FIELDS.has(k) || k === '__proto__') throw bad(label, 'reserved field inside scalars')
	}
	if (raw.version === SEGMENTED_STATE_VERSION && scalars.walSeq !== undefined && !isNonNegInt(scalars.walSeq)) {
		throw bad(label, 'scalars.walSeq (informational, version 2 downgrade snapshot) is not a non-negative integer')
	}
	if (!isSha256Hex(raw.scalarsSha256)) throw bad(label, 'bad scalarsSha256')
	const pending = raw.pending
	if (!isPlainObject(pending)) throw bad(label, 'pending block missing')
	if (!isNonNegInt(pending.count) || !isSha256Hex(pending.keySetSha256) || !Array.isArray(pending.segments)) {
		throw bad(label, 'bad pending block')
	}
	const seen = new Set<string>()
	let total = 0
	for (const seg of pending.segments) {
		if (!isFileDigestLike(seg) || !SEGMENT_FILE_RE.test(seg.file) || seen.has(seg.file)) {
			throw bad(label, 'bad segment reference')
		}
		seen.add(seg.file)
		total += seg.lines
	}
	if (total !== pending.count) throw bad(label, 'segment line total does not match pending.count')
	for (const [name, ref, file] of [
		['consumed', raw.consumed, CONSUMED_FILE],
		['exited', raw.exited, EXITED_FILE],
	] as const) {
		if (!isFileDigestLike(ref) || ref.file !== file || !isSha256Hex((ref as Record<string, unknown>).keySetSha256)) {
			throw bad(label, `bad ${name} reference`)
		}
	}
	if (raw.inFlightKeys !== undefined) {
		const ik = raw.inFlightKeys
		if (!isPlainObject(ik) || !isSha256Hex(ik.id) || !isNonNegInt(ik.count) || !isSha256Hex(ik.keySetSha256) || !Array.isArray(ik.segments)) {
			throw bad(label, 'bad inFlightKeys block')
		}
		const names = new Set<string>()
		let lines = 0
		for (const seg of ik.segments) {
			if (!isFileDigestLike(seg) || !IN_FLIGHT_SEGMENT_RE.test(seg.file) || names.has(seg.file)) throw bad(label, 'bad in-flight segment reference')
			names.add(seg.file)
			lines += seg.lines
		}
		if (lines !== ik.count) throw bad(label, 'in-flight segment line total does not match count')
	}
	return raw as unknown as SegmentedManifest
}

/** Read and validate manifest.json. Throws if missing or invalid. */
export function readManifest(dir: string): SegmentedManifest {
	const file = path.join(dir, SEGMENTED_MANIFEST_FILE)
	let text: string
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch (e) {
		throw new Error(`labClPayoutStateStore: no committed manifest at ${file}: ${errMsg(e)}`)
	}
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		throw bad(file, 'manifest is not valid JSON')
	}
	return parseManifest(raw, file)
}

function readKeyFile(genDir: string, ref: KeyFileRef): Record<string, true> {
	const keys: string[] = []
	const map: Record<string, true> = {}
	const label = path.join(genDir, ref.file)
	const got = streamJsonlFile(label, (line) => {
		const k: unknown = JSON.parse(line)
		if (typeof k !== 'string' || k === '' || k === '__proto__') throw bad(label, 'invalid key line')
		if (Object.prototype.hasOwnProperty.call(map, k)) throw bad(label, 'duplicate key line')
		map[k] = true
		keys.push(k)
	})
	verifyDigest(label, got, ref)
	if (keySetHash(keys) !== ref.keySetSha256) throw bad(label, 'key-set hash does not match manifest')
	return map
}

// ---------------------------------------------------------------------------
// In-flight withdrawal eventKeys (B-2d): stored once, as their own blob, not inside the manifest.
// Only the record's metadata stays in manifest.scalars. Each commit references the same blob, so the
// eventKeys are not re-serialized or rewritten on every tick.
// ---------------------------------------------------------------------------

function inFlightBlobId(idempotencyKey: string, count: number, keySetSha256: string): string {
	return sha256Hex(canonicalJson({ idempotencyKey, count, keySetSha256 }))
}

/** Read every key file of a blob directory, verifying each by digest. Keys come back in file order. */
function scanBlobFiles(blobDir: string): { segments: SegmentRef[]; keys: string[] } {
	const keys: string[] = []
	const segments: SegmentRef[] = []
	for (const file of fs.readdirSync(blobDir).filter((n) => IN_FLIGHT_SEGMENT_RE.test(n)).sort()) {
		const label = path.join(blobDir, file)
		const digest = streamJsonlFile(label, (line) => {
			const k: unknown = JSON.parse(line)
			if (typeof k !== 'string' || k === '' || k === '__proto__') throw bad(label, 'invalid in-flight key line')
			keys.push(k)
		})
		segments.push({ file, ...digest })
	}
	return { segments, keys }
}

/**
 * Write the in-flight eventKeys as a blob (tmp dir, fsync, rename), read it back and compare. An existing blob
 * with the same id is verified, not rewritten. The result is cached per keys array object, so later ticks
 * that carry the same record reuse it without any I/O.
 */
export function writeInFlightBlob(dir: string, keys: string[], idempotencyKey: string, segmentSize: number): InFlightKeysRef {
	const hit = inflightCache.get(keys)
	if (hit && hit.dir === dir && pathExistsStrict(path.join(dir, INFLIGHT_DIR, hit.ref.id))) return hit.ref
	const keySetSha256 = keySetHash(keys)
	const id = inFlightBlobId(idempotencyKey, keys.length, keySetSha256)
	const invDir = path.join(dir, INFLIGHT_DIR)
	const blobDir = path.join(invDir, id)
	fs.mkdirSync(invDir, { recursive: true, mode: 0o700 })
	if (!pathExistsStrict(blobDir)) {
		const tmpDir = path.join(invDir, `.tmp-${id}-${process.pid}-${randomBytes(4).toString('hex')}`)
		fs.mkdirSync(tmpDir, { mode: 0o700 })
		try {
			for (let start = 0, idx = 0; start < keys.length; start += segmentSize, idx++) {
				const file = `key-${String(idx).padStart(6, '0')}.jsonl`
				writeJsonlFile(path.join(tmpDir, file), jsonStringLines(keys.slice(start, start + segmentSize)))
			}
			fsyncDirStrict(tmpDir)
			fs.renameSync(tmpDir, blobDir)
			fsyncDirStrict(invDir)
		} catch (e) {
			fs.rmSync(tmpDir, { recursive: true, force: true })
			throw e
		}
	}
	const onDisk = scanBlobFiles(blobDir)
	if (onDisk.keys.length !== keys.length || keySetHash(onDisk.keys) !== keySetSha256) {
		throw bad(blobDir, 'in-flight blob does not match its record')
	}
	const ref: InFlightKeysRef = { id, count: keys.length, keySetSha256, segments: onDisk.segments }
	inflightCache.set(keys, { dir, ref })
	return ref
}

/** Verify and load the in-flight eventKeys named by a committed manifest. Throws on any mismatch. */
function readInFlightKeys(dir: string, ref: InFlightKeysRef, idempotencyKey: string): string[] {
	const blobDir = path.join(dir, INFLIGHT_DIR, ref.id)
	if (!pathExistsStrict(blobDir)) throw bad(blobDir, 'in-flight blob directory missing')
	if (inFlightBlobId(idempotencyKey, ref.count, ref.keySetSha256) !== ref.id) {
		throw bad(blobDir, 'in-flight blob id does not match its record')
	}
	const keys: string[] = []
	for (const seg of ref.segments) {
		const label = path.join(blobDir, seg.file)
		const got = streamJsonlFile(label, (line) => {
			const k: unknown = JSON.parse(line)
			if (typeof k !== 'string' || k === '' || k === '__proto__') throw bad(label, 'invalid in-flight key line')
			keys.push(k)
		})
		verifyDigest(label, got, seg)
	}
	if (keys.length !== ref.count) throw bad(blobDir, `in-flight key count ${keys.length} != manifest ${ref.count}`)
	if (keySetHash(keys) !== ref.keySetSha256) throw bad(blobDir, 'in-flight key-set hash does not match manifest')
	return keys
}

/** After a commit: remove every entry under inflight/ except the one the committed manifest references. Never throws. */
function pruneInFlightBlobs(dir: string, keepId: string | null): string[] {
	const invDir = path.join(dir, INFLIGHT_DIR)
	let names: string[] = []
	try {
		names = fs.readdirSync(invDir)
	} catch {
		return []
	}
	const removed: string[] = []
	for (const name of names) {
		if (name === keepId) continue
		try {
			fs.rmSync(path.join(invDir, name), { recursive: true, force: true })
			removed.push(name)
		} catch {
			/* best effort: an unreferenced blob is ignored by readers and retried on the next commit */
		}
	}
	return removed
}

/** Verify and load one committed generation named by an already-validated manifest. */
export function readGenerationFromManifest(dir: string, manifest: SegmentedManifest): SegmentedState {
	const genDir = path.join(dir, manifest.generation)
	if (!pathExistsStrict(genDir)) throw bad(genDir, 'generation directory missing')
	if (sha256Hex(canonicalJson(manifest.scalars)) !== manifest.scalarsSha256) {
		throw bad(genDir, 'scalars sha256 does not match manifest')
	}
	const pending: PendingRecord[] = []
	const pendingKeys: string[] = []
	for (const seg of manifest.pending.segments) {
		const label = path.join(genDir, seg.file)
		const got = streamJsonlFile(label, (line) => {
			const rec: unknown = JSON.parse(line)
			if (!isPlainObject(rec) || typeof rec.eventKey !== 'string' || rec.eventKey === '') {
				throw bad(label, 'invalid pending record')
			}
			pending.push(rec as PendingRecord)
			pendingKeys.push(rec.eventKey)
		})
		verifyDigest(label, got, seg)
	}
	if (pending.length !== manifest.pending.count) {
		throw bad(genDir, `pending count ${pending.length} != manifest ${manifest.pending.count}`)
	}
	if (keySetHash(pendingKeys) !== manifest.pending.keySetSha256) {
		throw bad(genDir, 'pending key-set hash does not match manifest')
	}
	const consumed = readKeyFile(genDir, manifest.consumed)
	const exited = readKeyFile(genDir, manifest.exited)
	const scalars: Record<string, unknown> = { ...manifest.scalars }
	if (manifest.inFlightKeys) {
		const rec = scalars.inFlightWithdraw
		if (!isPlainObject(rec) || typeof rec.idempotencyKey !== 'string') throw bad(genDir, 'in-flight blob has no matching record')
		const keys = readInFlightKeys(dir, manifest.inFlightKeys, rec.idempotencyKey)
		inflightCache.set(keys, { dir, ref: manifest.inFlightKeys })
		scalars.inFlightWithdraw = { ...rec, eventKeys: keys }
	}
	return {
		...scalars,
		pending,
		consumedEventKeys: consumed,
		exitedPubkeys: exited,
	}
}

/**
 * Load the committed state. Throws when the manifest is missing, unreadable, or any file or hash
 * does not match. There is no fallback to an empty state.
 */
export function readSegmentedState(dir: string): SegmentedState {
	const manifest = readManifest(dir)
	if (manifest.version === SEGMENTED_STATE_VERSION_WAL) {
		// a plain state read would drop every WAL event after the snapshot: only the recovery path (loadCommittedForRecovery) may read a WAL-mode state
		throw bad(dir, `manifest version ${manifest.version} is a WAL-mode snapshot (walSeq ${manifest.walSeq}); replay the WAL (recovery) or gracefully stop the WAL-mode daemon to get a version 2 snapshot`)
	}
	return readGenerationFromManifest(dir, manifest)
}

/** The state a WAL-aware recovery starts from: the committed snapshot (version 2 or 3) and the seq it contains. Version 2 without walSeq = 0 (the WAL was never on). */
export function loadCommittedForRecovery(dir: string): { manifest: SegmentedManifest; state: SegmentedState; snapshotSeq: number } {
	const manifest = readManifest(dir)
	const state = readGenerationFromManifest(dir, manifest)
	const informational = manifest.scalars.walSeq
	const snapshotSeq = manifest.version === SEGMENTED_STATE_VERSION_WAL ? (manifest.walSeq as number) : typeof informational === 'number' ? informational : 0
	return { manifest, state, snapshotSeq }
}

// ---------------------------------------------------------------------------
// Summaries and migration from the legacy single file
// ---------------------------------------------------------------------------

export function summarizeState(state: Record<string, unknown>): StateSummary {
	const pending = Array.isArray(state.pending) ? (state.pending as PendingRecord[]) : []
	const consumed = isPlainObject(state.consumedEventKeys) ? state.consumedEventKeys : {}
	const exited = isPlainObject(state.exitedPubkeys) ? state.exitedPubkeys : {}
	const pendingKeys = pending.map((e) => {
		if (!isPlainObject(e) || typeof e.eventKey !== 'string') throw new Error('summarizeState: pending entry without eventKey')
		return e.eventKey
	})
	const consumedKeys = Object.keys(consumed)
	const exitedKeys = Object.keys(exited)
	const consumedLower = new Set(consumedKeys.map((k) => k.toLowerCase()))
	let overlap = 0
	for (const k of pendingKeys) {
		if (consumedLower.has(k.toLowerCase())) overlap++
	}
	return {
		scalarFields: Object.keys(extractScalars(state)).sort(),
		scalarsSha256: sha256Hex(canonicalJson(extractScalars(state))),
		pendingCount: pendingKeys.length,
		pendingKeySetSha256: keySetHash(pendingKeys),
		pendingDuplicateKeys: pendingKeys.length - new Set(pendingKeys).size,
		consumedCount: consumedKeys.length,
		consumedKeySetSha256: keySetHash(consumedKeys),
		exitedCount: exitedKeys.length,
		exitedKeySetSha256: keySetHash(exitedKeys),
		pendingConsumedOverlap: overlap,
	}
}

export type LegacyLoad = {
	file: string
	bytes: number
	sha256: string
	state: SegmentedState
	/** Collections absent in the legacy file and defaulted to empty for migration. */
	defaulted: string[]
}

function normalizeLegacyShape(raw: unknown, defaulted: string[]): SegmentedState {
	if (!isPlainObject(raw)) throw new Error('labClPayoutStateStore: legacy state root is not an object')
	const out: Record<string, unknown> = {}
	for (const k of Object.keys(raw)) {
		if (k === '__proto__') throw new Error('labClPayoutStateStore: legacy state has a __proto__ key')
		out[k] = raw[k]
	}
	if (out.pending === undefined) {
		out.pending = []
		defaulted.push('pending')
	} else if (!Array.isArray(out.pending)) {
		throw new Error('labClPayoutStateStore: legacy pending is not an array')
	}
	if (out.consumedEventKeys === undefined) {
		out.consumedEventKeys = {}
		defaulted.push('consumedEventKeys')
	}
	if (out.exitedPubkeys === undefined) {
		out.exitedPubkeys = {}
		defaulted.push('exitedPubkeys')
	}
	checkTrueMap(out.consumedEventKeys, 'legacy consumedEventKeys')
	checkTrueMap(out.exitedPubkeys, 'legacy exitedPubkeys')
	return out as SegmentedState
}

/**
 * Read the legacy single file verbatim (pretty or compact JSON). It must be smaller than
 * V8_MAX_STRING_LENGTH. The file is only read.
 */
export function loadLegacyStateFile(file: string): LegacyLoad {
	const st = fs.statSync(file)
	if (!st.isFile()) throw new Error(`labClPayoutStateStore: legacy state is not a regular file: ${file}`)
	if (st.size >= V8_MAX_STRING_LENGTH) {
		throw new Error(
			`labClPayoutStateStore: legacy state is ${st.size} bytes; one JSON.parse needs fewer than ${V8_MAX_STRING_LENGTH} chars`
		)
	}
	const buf = fs.readFileSync(file)
	const sha256 = sha256Hex(buf)
	const raw: unknown = JSON.parse(buf.toString('utf8'))
	const defaulted: string[] = []
	const state = normalizeLegacyShape(raw, defaulted)
	return { file, bytes: buf.length, sha256, state, defaulted }
}

/** Backup name: "<stateFile>.legacy-<first 16 hex of sha256>.json". */
export function legacyBackupPathFor(legacyFile: string, sha256: string): string {
	return `${legacyFile}.legacy-${sha256.slice(0, 16)}.json`
}

function ensureLegacyBackup(legacyFile: string, sha256: string): string {
	const backup = legacyBackupPathFor(legacyFile, sha256)
	if (pathExistsStrict(backup)) {
		if (sha256File(backup) !== sha256) throw new Error(`labClPayoutStateStore: backup exists with different content: ${backup}`)
		return backup
	}
	const tmp = `${backup}.tmp.${process.pid}`
	try {
		fs.rmSync(tmp, { force: true })
		fs.copyFileSync(legacyFile, tmp, fs.constants.COPYFILE_EXCL)
		const fd = fs.openSync(tmp, 'r')
		try {
			fs.fsyncSync(fd)
		} finally {
			fs.closeSync(fd)
		}
		if (sha256File(tmp) !== sha256) throw new Error('labClPayoutStateStore: backup copy sha256 mismatch')
		fs.linkSync(tmp, backup)
	} finally {
		try {
			fs.rmSync(tmp, { force: true })
		} catch {
			/* best effort */
		}
	}
	return backup
}

/** Throws with counts and indexes only. No eventKey or pubkey values appear in messages. */
function assertSameState(expected: SegmentedState, actual: SegmentedState): StateSummary {
	const a = summarizeState(expected)
	const b = summarizeState(actual)
	const pairs: Array<[keyof StateSummary, unknown, unknown]> = [
		['scalarsSha256', a.scalarsSha256, b.scalarsSha256],
		['pendingCount', a.pendingCount, b.pendingCount],
		['pendingKeySetSha256', a.pendingKeySetSha256, b.pendingKeySetSha256],
		['consumedCount', a.consumedCount, b.consumedCount],
		['consumedKeySetSha256', a.consumedKeySetSha256, b.consumedKeySetSha256],
		['exitedCount', a.exitedCount, b.exitedCount],
		['exitedKeySetSha256', a.exitedKeySetSha256, b.exitedKeySetSha256],
	]
	for (const [name, x, y] of pairs) {
		if (x !== y) throw new Error(`labClPayoutStateStore: verification mismatch on ${String(name)}`)
	}
	for (let i = 0; i < expected.pending.length; i++) {
		if (canonicalJson(expected.pending[i]) !== canonicalJson(actual.pending[i])) {
			throw new Error(`labClPayoutStateStore: verification mismatch on pending record index ${i}`)
		}
	}
	const ek = Object.keys(expected.consumedEventKeys)
	const ak = Object.keys(actual.consumedEventKeys)
	for (let i = 0; i < ek.length; i++) {
		if (ek[i] !== ak[i]) throw new Error(`labClPayoutStateStore: verification mismatch on consumed index ${i}`)
	}
	const ex = Object.keys(expected.exitedPubkeys)
	const ax = Object.keys(actual.exitedPubkeys)
	for (let i = 0; i < ex.length; i++) {
		if (ex[i] !== ax[i]) throw new Error(`labClPayoutStateStore: verification mismatch on exited index ${i}`)
	}
	return b
}

export type LegacyMigrationDryRun = {
	legacyFile: string
	legacyBytes: number
	legacySha256: string
	legacyBackupPath: string
	legacyBackupState: 'absent' | 'present-same' | 'present-different'
	targetDir: string
	targetStatus: InspectStatus
	defaultedFields: string[]
	summary: StateSummary
	/** Non-null when --apply would refuse. */
	refuseReason: string | null
}

function initialHistoryState(state: SegmentedState, firstBlock?: number): SegmentedState {
	if (firstBlock === undefined) return state
	if (!Number.isSafeInteger(firstBlock) || firstBlock < 1) {
		throw new Error('labClPayoutStateStore: initial history block must be a positive safe integer')
	}
	if (state.historyCursor != null || state.realtimeCursor != null || state.freezeH != null) {
		throw new Error('labClPayoutStateStore: refusing to replace initialized dual cursors during migration')
	}
	// A persisted history cursor takes precedence over the legacy backfill and listening fields at startup.
	return { ...state, historyCursor: firstBlock - 1 }
}

/** Read-only check. Writes nothing. */
export function dryRunLegacyMigration(
	legacyFile: string,
	targetDir: string,
	initialHistoryBlock?: number
): LegacyMigrationDryRun {
	const load = loadLegacyStateFile(legacyFile)
	const summary = summarizeState(initialHistoryState(load.state, initialHistoryBlock))
	const backupPath = legacyBackupPathFor(legacyFile, load.sha256)
	let backupState: LegacyMigrationDryRun['legacyBackupState'] = 'absent'
	if (pathExistsStrict(backupPath)) {
		backupState = sha256File(backupPath) === load.sha256 ? 'present-same' : 'present-different'
	}
	const targetStatus = inspectSegmentedDir(targetDir)
	let refuseReason: string | null = null
	if (targetStatus === 'committed') refuseReason = 'target already has a committed v2 manifest'
	else if (summary.pendingConsumedOverlap > 0) {
		refuseReason = `${summary.pendingConsumedOverlap} pending entries are also in consumedEventKeys`
	} else if (backupState === 'present-different') refuseReason = 'backup path exists with different content'
	return {
		legacyFile,
		legacyBytes: load.bytes,
		legacySha256: load.sha256,
		legacyBackupPath: backupPath,
		legacyBackupState: backupState,
		targetDir,
		targetStatus,
		defaultedFields: load.defaulted,
		summary,
		refuseReason,
	}
}

export type LegacyMigrationResult = {
	legacyFile: string
	legacySha256: string
	legacyBackupPath: string
	targetDir: string
	generation: string
	previousGeneration: string | null
	summary: StateSummary
	verified: true
}

/**
 * Explicit migration (never called by the daemon).
 * Order: refuse if target is committed or pending overlaps consumed -> back up the legacy file
 * (verified copy, the original is not modified) -> write a generation -> reread and compare
 * against the in-memory legacy state -> commit the manifest -> reread from disk and compare
 * again. Any failure before or after the commit leaves the legacy file as the authority:
 * the manifest is removed on a post-commit failure.
 */
export function migrateLegacyToSegmented(
	legacyFile: string,
	targetDir: string,
	opts: { segmentSize?: number; initialHistoryBlock?: number } = {}
): LegacyMigrationResult {
	if (inspectSegmentedDir(targetDir) === 'committed') {
		throw new Error(`labClPayoutStateStore: refusing to migrate; ${targetDir} already has a committed manifest`)
	}
	const load = loadLegacyStateFile(legacyFile)
	const candidate = initialHistoryState(load.state, opts.initialHistoryBlock)
	const pre = summarizeState(candidate)
	if (pre.pendingConsumedOverlap > 0) {
		throw new Error(
			`labClPayoutStateStore: refusing to migrate; ${pre.pendingConsumedOverlap} pending entries are also in consumedEventKeys`
		)
	}
	const backupPath = ensureLegacyBackup(legacyFile, load.sha256)
	if (sha256File(legacyFile) !== load.sha256) {
		throw new Error('labClPayoutStateStore: legacy state changed while migrating; nothing committed')
	}
	const prepared = writeGeneration(targetDir, candidate, { segmentSize: opts.segmentSize })
	try {
		assertSameState(candidate, readGenerationFromManifest(targetDir, prepared.manifest))
	} catch (e) {
		removeGenerationDir(targetDir, prepared.genDir)
		throw e
	}
	const commit = commitGeneration(prepared, {})
	const manifestPath = path.join(targetDir, SEGMENTED_MANIFEST_FILE)
	let summary: StateSummary
	try {
		summary = assertSameState(candidate, readSegmentedState(targetDir))
		if (sha256File(legacyFile) !== load.sha256) {
			throw new Error('labClPayoutStateStore: legacy state changed during migration')
		}
	} catch (e) {
		// Restore the legacy file as the only authority.
		try {
			fs.rmSync(manifestPath, { force: true })
		} catch {
			/* best effort */
		}
		removeGenerationDir(targetDir, prepared.genDir)
		throw e
	}
	return {
		legacyFile,
		legacySha256: load.sha256,
		legacyBackupPath: backupPath,
		targetDir,
		generation: commit.generation,
		previousGeneration: commit.previousGeneration,
		summary,
		verified: true,
	}
}
