/**
 * P2d M3: the streaming snapshot loader used by WAL recovery (recoverPayoutState default loader 'stream') against the original whole-state loader ('whole'), on the same directories:
 * identical recovered state, and every refusal the whole-state loader has is still a refusal. Includes a version 2 directory written by the df78e6b writer (the old build) and a file that
 * changes while it is being read.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { canonicalJson, keySetHash, readManifest, streamCommittedForRecovery, writeSegmentedState, type GenerationSink } from './labClPayoutStateStore'
import { LabPayoutStateCore, type PendingEntry } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WalWriter, type WalOp } from './labWal'

const hex = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
const PK = (i: number): string => '0x' + createHash('sha256').update(`pk${i % 50}`).digest('hex') + 'ab'.repeat(16)
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'labstream-'))

function dataset(nPending: number, nConsumed: number): { pending: PendingEntry[]; consumed: string[]; exited: string[]; scalars: Record<string, unknown>; inFlight: Record<string, unknown> } {
	const nHist = Math.floor(nPending * 0.8)
	const pending = Array.from({ length: nPending }, (_, i) => ({ eventKey: hex(0x1000 + i), amount: String(1_000_000_000_000_000_000_000n + BigInt(i)), blockNumber: 2_000_000 + Math.floor(i / 13), withdrawalIndex: i % 13, pubkey: PK(i) })) as PendingEntry[]
	return {
		pending,
		consumed: Array.from({ length: nConsumed }, (_, i) => hex(0x900000 + i)),
		exited: [PK(1), PK(2), PK(3)],
		scalars: {
			freezeH: { height: 2_000_000 + Math.ceil(nHist / 13) - 1, hash: hex(77), frozenAt: '2026-11-21T00:00:00.000Z' },
			historyCursor: 2_000_010,
			realtimeCursor: 2_000_900,
			lastBackfillProcessedBlock: 2_000_010,
			cursorHighWater: { backfill: 2_000_010, listen: 2_000_900 },
			settledBatchCount: 12,
			gasWaitStartedAt: '2026-11-21T01:00:00.000Z',
		},
		inFlight: { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '3000', hash: hex(0xeee1), eventKeys: [hex(0x1000), hex(0x1001), hex(0x1002)] },
	}
}

const digest = (r: ReturnType<typeof recoverPayoutState>): string => {
	const c = r.core
	return canonicalJson({
		scalars: c.scalarsCopy(),
		inFlight: c.getInFlight(),
		pending: [...c.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: [...c.consumedKeys()],
		exited: [...c.exited.keys()].sort(),
		seq: c.lastAppliedSeq,
		snapshotSeq: r.snapshotSeq,
		replayed: r.replayed,
		manifestVersion: r.manifestVersion,
		histTotal: c.histTotal,
		histAhead: [2_000_000, 2_000_010, 2_000_500, 3_000_000].map((x) => c.histAhead(x)),
		freezeHeight: c.freezeHeight(),
		warnings: r.warnings,
	})
}
const both = (dir: string): { whole: string; stream: string } => ({
	whole: digest(recoverPayoutState(dir, { readOnly: true, loader: 'whole' })),
	stream: digest(recoverPayoutState(dir, { readOnly: true, loader: 'stream' })),
})

async function walDir(d: ReturnType<typeof dataset>, tail: number): Promise<string> {
	const dir = path.join(tmp(), 'state.v2')
	const core = new LabPayoutStateCore({ pending: d.pending, consumed: d.consumed, exited: d.exited, scalars: d.scalars, inFlight: d.inFlight })
	const src = core.freezeForSnapshot()
	const res = await writeSnapshotCooperative(src, { dir, mode: 'wal', segmentSize: 700 })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	if (tail > 0) {
		const wal = new WalWriter({ stateDir: dir, lastSeq: 0 })
		const ps: Promise<void>[] = []
		for (let e = 0; e < tail; e++) {
			const ops: WalOp[] = e % 2 === 0 ? [{ op: 'pendingAdd', entry: { eventKey: hex(0x50000 + e), amount: '5', blockNumber: 2_000_900 + e, withdrawalIndex: 1, pubkey: PK(e) } }, { op: 'scalarsSet', patch: { realtimeCursor: 2_000_901 + e } }] : [{ op: 'consumedAdd', key: hex(0xa00000 + e) }, { op: 'pendingDel', key: hex(0x1000 + e) }]
			ps.push(core.record(wal, 'scan', ops).durable)
		}
		await Promise.all(ps)
		await wal.close()
	}
	return dir
}
const v2Input = (d: ReturnType<typeof dataset>): Record<string, unknown> => ({
	...d.scalars,
	pending: d.pending as unknown as never[],
	consumedEventKeys: Object.fromEntries(d.consumed.map((k) => [k, true] as const)),
	exitedPubkeys: Object.fromEntries(d.exited.map((k) => [k, true] as const)),
	inFlightWithdraw: d.inFlight,
})

test('the streaming loader recovers exactly what the whole-state loader recovers: version 2 snapshot, version 3 snapshot, snapshot + log tail, with and without an in-flight record', async () => {
	const d = dataset(5000, 8000)
	const dirs: Record<string, string> = {}
	dirs.v2 = path.join(tmp(), 'state.v2')
	writeSegmentedState(dirs.v2, v2Input(d) as never, { segmentSize: 700 })
	dirs.wal = await walDir(d, 0)
	dirs.walTail = await walDir(d, 300)
	const noFlight = { ...d, inFlight: undefined as unknown as Record<string, unknown> }
	const v2n = path.join(tmp(), 'state.v2')
	const input = v2Input(noFlight) as Record<string, unknown>
	delete input.inFlightWithdraw
	writeSegmentedState(v2n, input as never, { segmentSize: 700 })
	dirs.v2NoFlight = v2n
	for (const [name, dir] of Object.entries(dirs)) {
		const r = both(dir)
		assert.equal(r.stream, r.whole, `${name}: recovered state differs between the loaders`)
	}
	const wt = recoverPayoutState(dirs.walTail!, { readOnly: true })
	assert.equal(wt.replayed, 300)
	assert.equal(wt.core.getInFlight() !== null, true)
	assert.equal(wt.core.consumedSize, 8000 + 150, 'the replayed consumedAdd events are on top of the streamed snapshot')
	for (const dir of Object.values(dirs)) fs.rmSync(path.dirname(dir), { recursive: true, force: true })
})

test('a version 2 directory written by the OLD builds writer (df78e6b) loads identically through both loaders', { skip: fs.existsSync(path.resolve(__dirname, '../../../lab-baseline-df78e6b/src/endpoint/labClPayoutStateStore.ts')) ? false : 'the df78e6b worktree is not present' }, () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const old = require(path.resolve(__dirname, '../../../lab-baseline-df78e6b/src/endpoint/labClPayoutStateStore.ts')) as { writeSegmentedState: (dir: string, input: unknown) => unknown }
	const d = dataset(3000, 4000)
	const dir = path.join(tmp(), 'state.v2')
	old.writeSegmentedState(dir, v2Input(d))
	const r = both(dir)
	assert.equal(r.stream, r.whole)
	const rec = recoverPayoutState(dir, { readOnly: true })
	assert.equal(rec.core.pendingSize, 3000)
	assert.equal(rec.core.consumedSize, 4000)
	assert.equal((rec.core.getInFlight() as { idempotencyKey?: string }).idempotencyKey, 'lab-withdrawNative:abc')
	fs.rmSync(path.dirname(dir), { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------- refusals
function genDirOf(dir: string): string {
	return path.join(dir, readManifest(dir).generation)
}
function expectBothRefuse(dir: string, why: RegExp, label: string): void {
	assert.throws(() => recoverPayoutState(dir, { readOnly: true, loader: 'whole' }), why, `${label}: whole loader`)
	assert.throws(() => recoverPayoutState(dir, { readOnly: true, loader: 'stream' }), why, `${label}: streaming loader`)
}
function fresh(): { dir: string; root: string } {
	const root = tmp()
	const dir = path.join(root, 'state.v2')
	writeSegmentedState(dir, v2Input(dataset(2000, 3000)) as never, { segmentSize: 400 })
	return { dir, root }
}

test('every refusal of the whole-state loader is also a refusal of the streaming loader: flipped byte, removed line, no final newline, wrong scalars, missing in-flight blob, duplicate key line', () => {
	const flip = (file: string): void => {
		const b = fs.readFileSync(file)
		b[Math.floor(b.length / 2)] ^= 0x01
		fs.writeFileSync(file, b)
	}
	{
		const t = fresh()
		flip(path.join(genDirOf(t.dir), readManifest(t.dir).consumed.file))
		expectBothRefuse(t.dir, /sha256 does not match manifest|invalid|JSON/, 'flipped byte in consumed')
		fs.rmSync(t.root, { recursive: true, force: true })
	}
	{
		const t = fresh()
		const seg = path.join(genDirOf(t.dir), readManifest(t.dir).pending.segments[1]!.file)
		const lines = fs.readFileSync(seg, 'utf8').split('\n').filter(Boolean)
		fs.writeFileSync(seg, lines.slice(1).join('\n') + '\n')
		expectBothRefuse(t.dir, /line count|byte count|sha256/, 'removed pending line')
		fs.rmSync(t.root, { recursive: true, force: true })
	}
	{
		const t = fresh()
		const f = path.join(genDirOf(t.dir), readManifest(t.dir).exited.file)
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n$/, ''))
		expectBothRefuse(t.dir, /trailing bytes without a final newline|sha256|byte count/, 'no final newline')
		fs.rmSync(t.root, { recursive: true, force: true })
	}
	{
		const t = fresh()
		const mf = path.join(t.dir, 'manifest.json')
		const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
		m.scalars.settledBatchCount = 999
		fs.writeFileSync(mf, JSON.stringify(m))
		expectBothRefuse(t.dir, /scalars sha256 does not match manifest/, 'scalars changed')
		fs.rmSync(t.root, { recursive: true, force: true })
	}
	{
		const t = fresh()
		fs.rmSync(path.join(t.dir, 'inflight'), { recursive: true, force: true })
		expectBothRefuse(t.dir, /in-flight blob directory missing/, 'in-flight blob missing')
		fs.rmSync(t.root, { recursive: true, force: true })
	}
	{
		// a duplicate key line that the manifest was made to agree with (counts, bytes, sha256 and key-set hash recomputed): only the duplicate rule can refuse it
		const t = fresh()
		const m = readManifest(t.dir)
		const f = path.join(genDirOf(t.dir), m.consumed.file)
		const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
		lines.push(lines[0]!)
		const text = lines.join('\n') + '\n'
		fs.writeFileSync(f, text)
		const mf = path.join(t.dir, 'manifest.json')
		const raw = JSON.parse(fs.readFileSync(mf, 'utf8'))
		raw.consumed.lines = lines.length
		raw.consumed.bytes = Buffer.byteLength(text)
		raw.consumed.sha256 = createHash('sha256').update(text).digest('hex')
		raw.consumed.keySetSha256 = keySetHash(lines.map((l) => JSON.parse(l) as string))
		fs.writeFileSync(mf, JSON.stringify(raw))
		expectBothRefuse(t.dir, /duplicate key line/, 'duplicate consumed key line')
		fs.rmSync(t.root, { recursive: true, force: true })
	}
})

test('a file that CHANGES WHILE IT IS READ is refused by the streaming loader (the digest is computed from the bytes as they are read)', () => {
	const root = tmp()
	const dir = path.join(root, 'state.v2')
	const d = dataset(40_000, 10) // pending segments of several MiB: the first 4 MiB chunk is read before the later bytes are touched
	writeSegmentedState(dir, v2Input(d) as never, { segmentSize: 40_000 })
	const m = readManifest(dir)
	const seg = path.join(genDirOf(dir), m.pending.segments[0]!.file)
	assert.ok(fs.statSync(seg).size > 6 * 1024 * 1024, `the pending segment is large enough (${fs.statSync(seg).size} bytes)`)
	// one hex digit of an eventKey far beyond the first 4 MiB chunk is flipped in place (same size, the JSON stays valid): only the digest of the bytes AS READ can notice it
	const bytes = fs.readFileSync(seg)
	const needle = Buffer.from('"eventKey":"0x')
	const at = bytes.indexOf(needle, 5 * 1024 * 1024) + needle.length
	assert.ok(at > 5 * 1024 * 1024)
	const flipped = bytes[at] === 0x30 ? 0x31 : 0x30
	let calls = 0
	const sink: GenerationSink = {
		begin: () => undefined,
		pending: () => {
			if (++calls === 3) {
				const fd = fs.openSync(seg, 'r+')
				fs.writeSync(fd, Buffer.from([flipped]), 0, 1, at)
				fs.closeSync(fd)
			}
		},
		consumed: () => true,
		exited: () => true,
	}
	assert.throws(() => streamCommittedForRecovery(dir, sink), /sha256 does not match manifest/)
	assert.ok(calls >= 3, 'the change happened while entries were being read')
	fs.rmSync(root, { recursive: true, force: true })
})

test('snapshot seq assertion (18a23d38): when the manifest read before the entries and the one the store reads afterwards name different snapshot seqs, recovery refuses with the labelled error', async () => {
	const d = dataset(300, 500)
	const dir = await walDir(d, 0)
	const manifestPath = path.join(dir, 'manifest.json')
	const text = fs.readFileSync(manifestPath, 'utf8')
	const m = JSON.parse(text) as { walSeq: number }
	assert.equal(typeof m.walSeq, 'number')
	// control: untouched, the recovery succeeds and reports that seq
	const ok = recoverPayoutState(dir, { readOnly: true, loader: 'stream' })
	assert.equal(ok.snapshotSeq, m.walSeq)
	// the FIRST read of manifest.json (the one that sets the core's lastAppliedSeq) sees walSeq+1: a manifest that changed between the two reads
	const realRead = fs.readFileSync
	let manifestReads = 0
	;(fs as unknown as { readFileSync: unknown }).readFileSync = ((p: unknown, ...a: unknown[]) => {
		const out = (realRead as (...x: unknown[]) => unknown)(p, ...a)
		if (String(p) === manifestPath && typeof out === 'string' && ++manifestReads === 1) return out.replace(/"walSeq":(\s*)\d+/, `"walSeq":$1${m.walSeq + 1}`)
		return out
	}) as typeof fs.readFileSync
	try {
		assert.throws(() => recoverPayoutState(dir, { readOnly: true, loader: 'stream' }), /labPayoutRecovery: snapshot seq \d+ \(manifest read before the entries\) != \d+ \(after\); the manifest changed while it was read/)
		assert.ok(manifestReads >= 2, `the manifest was read at least twice (${manifestReads})`)
	} finally {
		;(fs as unknown as { readFileSync: unknown }).readFileSync = realRead
	}
	// and the directory itself was not touched
	assert.equal(fs.readFileSync(manifestPath, 'utf8'), text)
	fs.rmSync(path.dirname(dir), { recursive: true, force: true })
})
