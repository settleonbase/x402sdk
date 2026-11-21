/**
 * P2a: WAL frame codec, segment writer (group commit, rotation, fail-stop), recovery scan (torn tail rules), replay engine, and a model check.
 * Local temp dirs only. No RPC, no daemon.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	WAL_DEFAULT_MAX_FRAME_BYTES,
	WAL_DIR,
	WAL_HEADER_BYTES,
	WAL_MAX_MERGE_SCALARS,
	WalCorruptError,
	WalWriter,
	applyOps,
	crc32c,
	decodeFrameAt,
	encodeFrame,
	listSegments,
	scanWal,
	segmentFileName,
	type WalApplyTarget,
	type WalEvent,
	type WalOp,
} from './labWal'
import { opsForSeq } from './labWalKillChild'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'labwal-'))
}
const done = (dir: string): void => rmSync(dir, { recursive: true, force: true })
const ev = (seq: number, ops: WalOp[] = [], t = 'x'): WalEvent => ({ v: 1, seq, ts: '2026-11-21T00:00:00.000Z', t, ops })
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`

function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 0x100000000
	}
}

/** In-memory state implementing the replay target; also the reference model for the property test. */
class Model implements WalApplyTarget {
	pending = new Map<string, Record<string, unknown>>()
	consumed: string[] = []
	consumedSet = new Set<string>()
	exited = new Set<string>()
	scalars: Record<string, unknown> = {}
	inFlight: Record<string, unknown> | null = null
	pendingHas(k: string): boolean {
		return this.pending.has(k)
	}
	pendingSet(e: { eventKey: string } & Record<string, unknown>): void {
		this.pending.set(e.eventKey, e)
	}
	pendingDelete(k: string): void {
		this.pending.delete(k)
	}
	consumedAdd(k: string): void {
		if (!this.consumedSet.has(k)) {
			this.consumedSet.add(k)
			this.consumed.push(k)
		}
	}
	exitedAdd(p: string): void {
		this.exited.add(p)
	}
	getScalar(n: string): unknown {
		return this.scalars[n]
	}
	setScalar(n: string, v: unknown): void {
		this.scalars[n] = v
	}
	deleteScalar(n: string): void {
		delete this.scalars[n]
	}
	setInFlight(r: Record<string, unknown> | null): void {
		this.inFlight = r
	}
	snapshot(): string {
		return JSON.stringify({
			pending: [...this.pending.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
			consumed: this.consumed,
			exited: [...this.exited].sort(),
			scalars: Object.fromEntries(Object.entries(this.scalars).sort(([a], [b]) => (a < b ? -1 : 1))),
			inFlight: this.inFlight,
		})
	}
}

// ------------------------------------------------------------ CRC and frame codec
test('crc32c: the standard check value, and an empty input', () => {
	assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283)
	assert.equal(crc32c(Buffer.alloc(0)), 0)
})

test('frame: round trip; any flipped byte (magic, length, crc, payload) is caught; an over-limit length is a bad frame', () => {
	const e = ev(7, [{ op: 'consumedAdd', key: key(1) }])
	const f = encodeFrame(e)
	const ok = decodeFrameAt(f, 0)
	assert.ok(ok.ok)
	if (ok.ok) {
		assert.deepEqual(ok.event, e)
		assert.equal(ok.end, f.length)
	}
	for (let i = 0; i < f.length; i++) {
		const b = Buffer.from(f)
		b[i] = b[i]! ^ 0x01
		const r = decodeFrameAt(b, 0)
		assert.equal(r.ok, false, `flip at byte ${i} must be caught`)
	}
	assert.deepEqual(decodeFrameAt(f.subarray(0, 4), 0), { ok: false, reason: 'short-header', at: 0 })
	assert.deepEqual(decodeFrameAt(f.subarray(0, f.length - 1), 0), { ok: false, reason: 'short-payload', at: 0 })
	assert.deepEqual(decodeFrameAt(Buffer.alloc(0), 0), { ok: false, reason: 'eof', at: 0 })
	const big = Buffer.from(f)
	big.writeUInt32LE(WAL_DEFAULT_MAX_FRAME_BYTES + 1, 2)
	assert.deepEqual(decodeFrameAt(big, 0), { ok: false, reason: 'bad-length', at: 0 })
	const zero = Buffer.from(f)
	zero.writeUInt32LE(0, 2)
	assert.deepEqual(decodeFrameAt(zero, 0), { ok: false, reason: 'bad-length', at: 0 })
	assert.throws(() => encodeFrame(ev(1, [{ op: 'scalarsSet', patch: { x: 'y'.repeat(100) } }]), 50), /over the frame limit/)
})

// ------------------------------------------------------------ writer
test('writer: events appended in one turn share one fsync; the promise resolves only after it; the log reads back in order', async () => {
	const dir = tmp()
	try {
		const w = new WalWriter({ stateDir: dir, lastSeq: 0 })
		const ps = [1, 2, 3, 4, 5].map((i) => w.append('t', [{ op: 'consumedAdd', key: key(i) }]).durable)
		assert.equal(w.syncCount, 0, 'nothing is durable before the flush')
		await Promise.all(ps)
		assert.equal(w.syncCount, 1, 'one group commit for five events')
		await w.close()
		const got: number[] = []
		const r = scanWal(dir, { afterSeq: 0, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, [1, 2, 3, 4, 5])
		assert.deepEqual(r, { droppedValidFrames: 0, applied: 5, lastSeq: 5, truncatedBytes: 0, segments: 1 })
	} finally {
		done(dir)
	}
})

test('writer: seq continues from lastSeq; rotation by size starts the next file at its first seq; a new file is fsynced with its directory', async () => {
	const dir = tmp()
	try {
		const dirSyncs: string[] = []
		const w = new WalWriter({ stateDir: dir, lastSeq: 40, segmentBytes: 400, hooks: { beforeDirSync: (d) => dirSyncs.push(d) } })
		for (let i = 0; i < 30; i++) {
			const a = w.append('t', [{ op: 'consumedAdd', key: key(i) }])
			assert.equal(a.seq, 41 + i)
			await a.durable
		}
		await w.close()
		const segs = listSegments(join(dir, WAL_DIR))
		assert.ok(segs.length > 2, `rotated into several segments (${segs.length})`)
		assert.equal(segs[0]!.firstSeq, 41)
		assert.equal(dirSyncs.length, segs.length, 'one directory fsync per new segment file')
		for (const s of segs) assert.ok(statSync(join(dir, WAL_DIR, s.file)).size <= 400 + 200, 'segments stay near the size limit')
		const got: number[] = []
		scanWal(dir, { afterSeq: 40, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, Array.from({ length: 30 }, (_, i) => 41 + i))
	} finally {
		done(dir)
	}
})

test('writer W2: a failed fsync is fatal once, the writer is dead, queued and later appends are rejected, nothing is retried', async () => {
	const dir = tmp()
	try {
		const fatal: Error[] = []
		let failNext = false
		const w = new WalWriter({
			stateDir: dir,
			lastSeq: 0,
			onFatal: (e) => fatal.push(e),
			hooks: {
				beforeSync: (f) => {
					if (failNext && f.startsWith('wal-')) throw new Error('simulated fsync failure')
				},
			},
		})
		await w.append('t', [{ op: 'consumedAdd', key: key(1) }]).durable
		failNext = true
		const p2 = w.append('t', [{ op: 'consumedAdd', key: key(2) }]).durable
		const p3 = w.append('t', [{ op: 'consumedAdd', key: key(3) }]).durable
		await assert.rejects(p2, /simulated fsync failure/)
		await assert.rejects(p3, /simulated fsync failure/)
		assert.equal(fatal.length, 1)
		assert.equal(w.isDead, true)
		await assert.rejects(w.append('t', []).durable, /simulated fsync failure/)
		assert.equal(fatal.length, 1, 'fatal is reported once')
	} finally {
		done(dir)
	}
})

test('writer W2/W3: a partial write then failure leaves a torn tail that recovery truncates; the events before it survive', async () => {
	const dir = tmp()
	try {
		let partial = false
		const w = new WalWriter({
			stateDir: dir,
			lastSeq: 0,
			onFatal: () => undefined,
			hooks: { partialWrite: (buf) => (partial ? Math.floor(buf.length / 2) : null) },
		})
		await w.append('t', [{ op: 'consumedAdd', key: key(1) }]).durable
		await w.append('t', [{ op: 'consumedAdd', key: key(2) }]).durable
		partial = true
		await assert.rejects(w.append('t', [{ op: 'consumedAdd', key: key(3) }]).durable, /simulated partial write/)
		assert.equal(w.isDead, true)
		const got: number[] = []
		const r = scanWal(dir, { afterSeq: 0, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, [1, 2])
		assert.ok(r.truncatedBytes > 0, 'the torn half frame was cut')
		// after the repair the file ends on a frame boundary: a second scan is clean
		const r2 = scanWal(dir, { afterSeq: 0, onEvent: () => undefined })
		assert.equal(r2.truncatedBytes, 0)
		assert.equal(r2.lastSeq, 2)
	} finally {
		done(dir)
	}
})

test('writer: truncateThrough removes only fully covered segments; closeAndRemoveAll leaves wal/ empty (no empty file)', async () => {
	const dir = tmp()
	try {
		const w = new WalWriter({ stateDir: dir, lastSeq: 0, segmentBytes: 300 })
		for (let i = 0; i < 25; i++) await w.append('t', [{ op: 'consumedAdd', key: key(i) }]).durable
		const before = listSegments(join(dir, WAL_DIR))
		assert.ok(before.length >= 3)
		const through = before[1]!.firstSeq - 1 // everything in the first segment
		const removed = w.truncateThrough(through)
		assert.deepEqual(removed, [before[0]!.file])
		const after = listSegments(join(dir, WAL_DIR))
		assert.equal(after[0]!.firstSeq, before[1]!.firstSeq)
		// the log still scans cleanly from the cut point
		const got: number[] = []
		scanWal(dir, { afterSeq: through, onEvent: (e) => got.push(e.seq) })
		assert.equal(got[0], through + 1)
		assert.equal(got[got.length - 1], 25)
		// a snapshot that covers everything removes every segment, including the one being written
		assert.deepEqual(w.truncateThrough(25).length, after.length)
		assert.deepEqual(readdirSync(join(dir, WAL_DIR)), [])
		const w2 = new WalWriter({ stateDir: dir, lastSeq: 25 })
		await w2.append('t', [{ op: 'consumedAdd', key: key(99) }]).durable
		await w2.closeAndRemoveAll()
		assert.deepEqual(readdirSync(join(dir, WAL_DIR)), [], 'graceful stop leaves wal/ empty, no empty file')
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------ recovery rules
function writeSeg(dir: string, firstSeq: number, seqs: number[], extra?: Buffer): string {
	const walDir = join(dir, WAL_DIR)
	mkdirSync(walDir, { recursive: true })
	const file = join(walDir, segmentFileName(firstSeq))
	writeFileSync(file, Buffer.concat([...seqs.map((s) => encodeFrame(ev(s, [{ op: 'consumedAdd', key: key(s) }]))), ...(extra ? [extra] : [])]))
	return file
}

test('recovery: events at or below afterSeq are skipped; an empty log and a missing wal/ are fine', () => {
	const dir = tmp()
	try {
		assert.deepEqual(scanWal(dir, { afterSeq: 0, onEvent: () => assert.fail('no events') }), { droppedValidFrames: 0, applied: 0, lastSeq: 0, truncatedBytes: 0, segments: 0 })
		writeSeg(dir, 1, [1, 2, 3, 4, 5])
		const got: number[] = []
		const r = scanWal(dir, { afterSeq: 3, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, [4, 5])
		assert.equal(r.lastSeq, 5)
		// an empty last segment (created, nothing written) is accepted
		writeFileSync(join(dir, WAL_DIR, segmentFileName(6)), '')
		assert.equal(scanWal(dir, { afterSeq: 5, onEvent: () => assert.fail('nothing new') }).segments, 2)
	} finally {
		done(dir)
	}
})

test('recovery W3: a torn tail in the LAST segment is truncated; every kind of tail damage is handled', () => {
	const dir = tmp()
	try {
		const f = writeSeg(dir, 1, [1, 2, 3])
		const good = readFileSync(f)
		const frame4 = encodeFrame(ev(4))
		for (const [label, tail] of [
			['half a frame', frame4.subarray(0, Math.floor(frame4.length / 2))],
			['only a header', frame4.subarray(0, WAL_HEADER_BYTES)],
			['3 bytes', frame4.subarray(0, 3)],
			['garbage', Buffer.from('zzzzzzzzzzzzzzzzzzzz')],
			['a corrupted frame', (() => { const b = Buffer.from(frame4); b[b.length - 1] = b[b.length - 1]! ^ 0xff; return b })()],
		] as const) {
			writeFileSync(f, Buffer.concat([good, tail]))
			const got: number[] = []
			const r = scanWal(dir, { afterSeq: 0, onEvent: (e) => got.push(e.seq) })
			assert.deepEqual(got, [1, 2, 3], label)
			assert.equal(r.truncatedBytes, tail.length, label)
			assert.deepEqual(readFileSync(f), good, `${label}: the file is cut back to the last good frame`)
		}
		// repair:false reports but does not cut
		writeFileSync(f, Buffer.concat([good, frame4.subarray(0, 5)]))
		const r = scanWal(dir, { afterSeq: 0, onEvent: () => undefined, repair: false })
		assert.equal(r.truncatedBytes, 5)
		assert.equal(readFileSync(f).length, good.length + 5)
	} finally {
		done(dir)
	}
})

test('recovery W3: a bad frame in an EARLIER segment, a seq gap, a wrong first seq, or a stray file all refuse to start', () => {
	const dir = tmp()
	try {
		// bad frame in a segment that is not the last
		const f1 = writeSeg(dir, 1, [1, 2], Buffer.from('torn'))
		writeSeg(dir, 3, [3, 4])
		assert.throws(() => scanWal(dir, { afterSeq: 0, onEvent: () => undefined }), WalCorruptError)
		assert.ok(readFileSync(f1).length > 0, 'nothing was repaired on refusal')
		rmSync(join(dir, WAL_DIR), { recursive: true })
		// seq gap between segments
		writeSeg(dir, 1, [1, 2])
		writeSeg(dir, 4, [4, 5])
		assert.throws(() => scanWal(dir, { afterSeq: 0, onEvent: () => undefined }), /previous segment ended at seq 2/)
		rmSync(join(dir, WAL_DIR), { recursive: true })
		// the first segment starts after the snapshot: events are missing
		writeSeg(dir, 10, [10, 11])
		assert.throws(() => scanWal(dir, { afterSeq: 5, onEvent: () => undefined }), /events 6\.\.9 are missing/)
		// ... but starting exactly at afterSeq+1 is fine
		assert.equal(scanWal(dir, { afterSeq: 9, onEvent: () => undefined }).lastSeq, 11)
		rmSync(join(dir, WAL_DIR), { recursive: true })
		// a good frame whose seq does not match the file position
		const f = writeSeg(dir, 1, [1, 2])
		appendFileSync(f, encodeFrame(ev(9)))
		assert.throws(() => scanWal(dir, { afterSeq: 0, onEvent: () => undefined }), /frame seq 9, expected 3/)
		rmSync(join(dir, WAL_DIR), { recursive: true })
		// a stray entry in wal/
		writeSeg(dir, 1, [1])
		writeFileSync(join(dir, WAL_DIR, 'note.txt'), 'x')
		assert.throws(() => scanWal(dir, { afterSeq: 0, onEvent: () => undefined }), /unexpected entry/)
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------ replay engine
test('replay: every op is idempotent; max-merge scalars never go backwards; an existing pending entry is not overwritten', () => {
	const m = new Model()
	const ops: WalOp[] = [
		{ op: 'pendingAdd', entry: { eventKey: key(1), blockNumber: 10 } },
		{ op: 'pendingAdd', entry: { eventKey: key(2), blockNumber: 11 } },
		{ op: 'pendingDel', key: key(2) },
		{ op: 'consumedAdd', key: key(2) },
		{ op: 'consumedAdd', key: key(3) },
		{ op: 'exitedAdd', pubkey: '0xaa' },
		{ op: 'scalarsSet', patch: { historyCursor: 100, gasWaitStartedAt: 'x', maxPaidHistoryBlock: 50, settledBatchCount: 4 } },
		{ op: 'inFlightSet', record: { batchId: 'b1' } },
	]
	applyOps(m, ops)
	const once = m.snapshot()
	applyOps(m, ops)
	assert.equal(m.snapshot(), once, 'applying the same event twice changes nothing')
	// a lower value never lowers a max-merge scalar; a plain scalar is overwritten
	applyOps(m, [{ op: 'scalarsSet', patch: { historyCursor: 90, maxPaidHistoryBlock: 10, settledBatchCount: 2, gasWaitStartedAt: 'y' } }])
	assert.equal(m.scalars.historyCursor, 100)
	assert.equal(m.scalars.maxPaidHistoryBlock, 50)
	assert.equal(m.scalars.settledBatchCount, 4)
	assert.equal(m.scalars.gasWaitStartedAt, 'y')
	applyOps(m, [{ op: 'scalarsSet', patch: { historyCursor: 120 } }])
	assert.equal(m.scalars.historyCursor, 120)
	// re-adding an existing pending key keeps the first entry
	applyOps(m, [{ op: 'pendingAdd', entry: { eventKey: key(1), blockNumber: 999 } }])
	assert.equal((m.pending.get(key(1)) as { blockNumber: number }).blockNumber, 10)
	// the consumed order is the insertion order and has no duplicates
	assert.deepEqual(m.consumed, [key(2), key(3)])
	assert.ok(WAL_MAX_MERGE_SCALARS.has('historyCursor') && WAL_MAX_MERGE_SCALARS.has('maxPaidHistoryBlock') && WAL_MAX_MERGE_SCALARS.has('settledBatchCount'))
})

// ------------------------------------------------------------ model check: write, rotate, crash anywhere, recover == reference
function randomEvent(r: () => number, seq: number): WalOp[] {
	const ops: WalOp[] = []
	const n = 1 + Math.floor(r() * 4)
	for (let i = 0; i < n; i++) {
		const k = key(Math.floor(r() * 40))
		const x = r()
		if (x < 0.3) ops.push({ op: 'pendingAdd', entry: { eventKey: k, blockNumber: Math.floor(r() * 1000) } })
		else if (x < 0.5) ops.push({ op: 'pendingDel', key: k })
		else if (x < 0.7) ops.push({ op: 'consumedAdd', key: k })
		else if (x < 0.75) ops.push({ op: 'exitedAdd', pubkey: `0x${Math.floor(r() * 9)}` })
		else if (x < 0.9) ops.push({ op: 'scalarsSet', patch: { historyCursor: Math.floor(r() * 5000), note: `n${seq}` } })
		else ops.push({ op: 'inFlightSet', record: r() < 0.3 ? null : { batchId: `b${Math.floor(r() * 5)}` } })
	}
	return ops
}

test('model: random event streams, small segments, a crash (cut) at a random byte of the log, recovery equals the reference applied to the intact prefix (80 cases)', async () => {
	const r = rng(99)
	for (let c = 0; c < 80; c++) {
		const dir = tmp()
		try {
			const w = new WalWriter({ stateDir: dir, lastSeq: 0, segmentBytes: 250 + Math.floor(r() * 600) })
			const events: WalEvent[] = []
			const total = 5 + Math.floor(r() * 40)
			for (let s = 1; s <= total; s++) {
				const ops = randomEvent(r, s)
				const a = w.append('t', ops)
				events.push({ v: 1, seq: s, ts: '', t: 't', ops })
				if (r() < 0.5) await a.durable
			}
			await w.close()
			// crash: cut the LAST segment at a random byte (a torn tail), keep everything else
			const segs = listSegments(join(dir, WAL_DIR))
			const lastFile = join(dir, WAL_DIR, segs[segs.length - 1]!.file)
			const buf = readFileSync(lastFile)
			const cut = Math.floor(r() * (buf.length + 1))
			writeFileSync(lastFile, buf.subarray(0, cut))
			// reference: the events of all frames that are fully intact after the cut
			const model = new Model()
			const target = new Model()
			let lastApplied = 0
			const res = scanWal(dir, { afterSeq: 0, onEvent: (e) => { applyOps(target, e.ops); lastApplied = e.seq } })
			for (const e of events) {
				if (e.seq > lastApplied) break
				applyOps(model, e.ops)
			}
			assert.equal(target.snapshot(), model.snapshot(), `case ${c}: recovered state equals the reference prefix`)
			assert.equal(res.lastSeq, lastApplied)
			// the repaired log scans again with the same result
			const again = new Model()
			scanWal(dir, { afterSeq: 0, onEvent: (e) => applyOps(again, e.ops) })
			assert.equal(again.snapshot(), model.snapshot(), `case ${c}: second recovery is identical`)
			// and appending continues from the recovered seq without a gap
			const w2 = new WalWriter({ stateDir: dir, lastSeq: lastApplied })
			await w2.append('t', [{ op: 'consumedAdd', key: key(1000 + c) }]).durable
			await w2.close()
			let n = 0
			const seqs: number[] = []
			scanWal(dir, { afterSeq: 0, onEvent: (e) => { seqs.push(e.seq); n++ } })
			assert.equal(n, lastApplied + 1)
			assert.deepEqual(seqs, Array.from({ length: n }, (_, i) => i + 1), `case ${c}: no gap after recovery`)
		} finally {
			done(dir)
		}
	}
})

test('model: replay from a snapshot point equals replay from zero (skipping events <= afterSeq changes nothing for idempotent ops)', async () => {
	const r = rng(5)
	const dir = tmp()
	try {
		const w = new WalWriter({ stateDir: dir, lastSeq: 0, segmentBytes: 700 })
		const all: WalEvent[] = []
		for (let s = 1; s <= 60; s++) {
			const ops = randomEvent(r, s)
			all.push({ v: 1, seq: s, ts: '', t: 't', ops })
			await w.append('t', ops).durable
		}
		await w.close()
		for (const snapAt of [0, 1, 17, 59, 60]) {
			const snap = new Model()
			for (const e of all) if (e.seq <= snapAt) applyOps(snap, e.ops)
			scanWal(dir, { afterSeq: snapAt, onEvent: (e) => applyOps(snap, e.ops) })
			const full = new Model()
			for (const e of all) applyOps(full, e.ops)
			assert.equal(snap.snapshot(), full.snapshot(), `snapshot at ${snapAt}`)
		}
		assert.ok(existsSync(join(dir, WAL_DIR)))
	} finally {
		done(dir)
	}
})

// ------------------------------------------------------------ real process kill -9 (W7)
/**
 * Node arguments for the child (review Z4): reuse the parent's execArgv when it already carries tsx (`tsx --test` passes absolute --require/--import paths, so the child
 * needs no node_modules above its cwd); otherwise fall back to the absolute tsx loader resolved from the test file.
 */
function childNodeArgs(): string[] {
	if (process.execArgv.some((a) => a.includes('tsx'))) return [...process.execArgv]
	try {
		return ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
	} catch {
		return ['--import', 'tsx']
	}
}

test('kill -9: a child appends durable events as fast as it can and is SIGKILLed at random moments; every event it reported durable is in the recovered log, the log is a clean prefix, and recovery equals the reference (12 rounds)', async () => {
	const r = rng(314159)
	for (let round = 0; round < 12; round++) {
		const dir = tmp()
		try {
			const seed = 1000 + round
			const child = spawn(process.execPath, [...childNodeArgs(), join(__dirname, 'labWalKillChild.ts'), dir, String(seed), String(2048 + Math.floor(r() * 4096))], {
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			let reported = 0
			let carry = ''
			child.stdout.on('data', (d: Buffer) => {
				carry += d.toString('utf8')
				let nl: number
				while ((nl = carry.indexOf('\n')) >= 0) {
					const line = carry.slice(0, nl)
					carry = carry.slice(nl + 1)
					const m = /^durable (\d+)$/.exec(line)
					if (m) reported = Math.max(reported, Number(m[1]))
				}
			})
			let stderr = ''
			child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
			const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
			// wait until it has made progress, then kill at a random moment
			const t0 = Date.now()
			while (reported < 5 && Date.now() - t0 < 8000) await new Promise((res) => setTimeout(res, 20))
			assert.ok(reported >= 5, `round ${round}: the child made progress (reported=${reported}) ${stderr}`)
			await new Promise((res) => setTimeout(res, Math.floor(r() * 150)))
			child.kill('SIGKILL')
			await exited
			const acknowledged = reported
			// recovery
			const model = new Model()
			const target = new Model()
			let last = 0
			const res = scanWal(dir, { afterSeq: 0, onEvent: (e) => { applyOps(target, e.ops); last = e.seq } })
			assert.ok(last >= acknowledged, `round ${round}: acknowledged ${acknowledged} but recovered only ${last}: a durable event was lost`)
			for (let s = 1; s <= last; s++) applyOps(model, opsForSeq(seed, s))
			assert.equal(target.snapshot(), model.snapshot(), `round ${round}: recovered state equals the reference`)
			assert.equal(scanWal(dir, { afterSeq: 0, onEvent: () => undefined }).truncatedBytes, 0, `round ${round}: the repaired log is clean`)
			assert.ok(res.segments >= 1)
		} finally {
			done(dir)
		}
	}
})

// ------------------------------------------------------------ review Z1 / Z2
test('Z1: damage in the MIDDLE of the last segment with valid frames after it refuses to start and truncates nothing; damage that runs to the end of the file is a torn tail', () => {
	const dir = tmp()
	try {
		const f = writeSeg(dir, 1, [1, 2, 3, 4, 5])
		const intact = readFileSync(f)
		// find the byte range of frame 3 and flip one payload byte
		let at = 0
		const starts: number[] = []
		for (let i = 0; i < 5; i++) {
			starts.push(at)
			const d = decodeFrameAt(intact, at)
			assert.ok(d.ok)
			if (d.ok) at = d.end
		}
		const damaged = Buffer.from(intact)
		damaged[starts[2]! + WAL_HEADER_BYTES + 2] = damaged[starts[2]! + WAL_HEADER_BYTES + 2]! ^ 0x40
		writeFileSync(f, damaged)
		assert.throws(() => scanWal(dir, { afterSeq: 0, onEvent: () => undefined }), (e: unknown) => e instanceof WalCorruptError && /2 valid frame\(s\) follow it/.test(e.message) && new RegExp(`offset ${starts[2]}`).test(e.message))
		assert.deepEqual(readFileSync(f), damaged, 'nothing was truncated on refusal')
		// the same damage with the frames after it ALSO gone (the bad region reaches the end of the file): a torn tail, truncated
		writeFileSync(f, damaged.subarray(0, starts[3]!))
		const got: number[] = []
		const r = scanWal(dir, { afterSeq: 0, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, [1, 2])
		assert.equal(r.droppedValidFrames, 0)
		assert.equal(r.truncatedBytes, starts[3]! - starts[2]!)
		// the operator override: accepts the loss, truncates, and reports how many valid frames were dropped
		writeFileSync(f, damaged)
		const r2 = scanWal(dir, { afterSeq: 0, onEvent: () => undefined, acceptMidCorruptionTruncation: true })
		assert.equal(r2.droppedValidFrames, 2)
		assert.equal(r2.lastSeq, 2)
		assert.equal(readFileSync(f).length, starts[2]!)
		// a bad HEADER (not payload) in the middle is caught the same way
		writeFileSync(f, intact)
		const hdr = Buffer.from(intact)
		hdr[starts[1]!] = 0x00 // magic of frame 2
		writeFileSync(f, hdr)
		assert.throws(() => scanWal(dir, { afterSeq: 0, onEvent: () => undefined }), /3 valid frame\(s\) follow it/)
	} finally {
		done(dir)
	}
})

test('Z1: a torn tail that merely ends the last segment is still truncated (no valid frame after it), and a probe of random garbage finds nothing', () => {
	const dir = tmp()
	try {
		const f = writeSeg(dir, 1, [1, 2, 3])
		const good = readFileSync(f)
		const r = rng(77)
		const junk = Buffer.alloc(500)
		for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(r() * 256)
		writeFileSync(f, Buffer.concat([good, junk]))
		const res = scanWal(dir, { afterSeq: 0, onEvent: () => undefined })
		assert.equal(res.truncatedBytes, 500)
		assert.equal(res.droppedValidFrames, 0)
		assert.deepEqual(readFileSync(f), good)
	} finally {
		done(dir)
	}
})

test('Z2: scalarsDel deletes scalars, is idempotent, and a replay cannot resurrect a deleted scalar; set-after-delete in the next event brings it back', () => {
	const m = new Model()
	const e1: WalOp[] = [{ op: 'scalarsSet', patch: { gasWaitStartedAt: '2026-11-21T00:00:00Z', keep: 1 } }]
	const e2: WalOp[] = [{ op: 'scalarsDel', names: ['gasWaitStartedAt', 'neverSet'] }]
	applyOps(m, e1)
	applyOps(m, e2)
	assert.equal('gasWaitStartedAt' in m.scalars, false)
	assert.equal(m.scalars.keep, 1)
	applyOps(m, e2)
	assert.equal('gasWaitStartedAt' in m.scalars, false, 'idempotent')
	// the log replayed in order (set, then delete) ends without the scalar, like the live run
	const replay = new Model()
	for (const e of [e1, e2]) applyOps(replay, e)
	assert.equal(replay.snapshot(), m.snapshot())
	// set after delete in a later event restores it
	applyOps(m, [{ op: 'scalarsSet', patch: { gasWaitStartedAt: 'again' } }])
	assert.equal(m.scalars.gasWaitStartedAt, 'again')
	// through the real log as well
	const dir = tmp()
	return (async () => {
		try {
			const w = new WalWriter({ stateDir: dir, lastSeq: 0 })
			await w.append('t', e1).durable
			await w.append('t', e2).durable
			await w.close()
			const viaLog = new Model()
			scanWal(dir, { afterSeq: 0, onEvent: (e) => applyOps(viaLog, e.ops) })
			assert.equal('gasWaitStartedAt' in viaLog.scalars, false)
			assert.equal(viaLog.scalars.keep, 1)
		} finally {
			done(dir)
		}
	})()
})
