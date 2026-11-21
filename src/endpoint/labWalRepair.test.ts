/**
 * The offline, one-shot, audited repair of mid-log WAL damage (review Z1, PM decision): never a standing setting, a run id and an approval are required,
 * the audit is written outside the state dir before anything is cut, and after the repair the default is "refuse" again. Local temp dirs only.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { acquireStateDirLock } from './labClPayoutStateLock'
import { WAL_DIR, WAL_HEADER_BYTES, WalMidCorruptionError, WalWriter, decodeFrameAt, encodeFrame, formatWalMidCorruptionAlert, scanWal, segmentFileName, type WalEvent, type WalOp } from './labWal'
import { MAX_LISTED_UNDECODABLE, RUN_ID_RE, inferUndecodable, minMax, parseCliArgs, readSnapshotWalSeq, realpathOrAncestor, repairMidCorruption } from './labWalRepair'

const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const ev = (seq: number, ops: WalOp[], t: string): WalEvent => ({ v: 1, seq, ts: '2026-11-21T00:00:00.000Z', t, ops })

/** A segment of 5 events: 1 scan, 2 intent, 3 hash, 4 settle, 5 scan; frame 3 is then damaged. Returns the file, the intact bytes, and the frame offsets. */
type WorldOpts = { firstSeq?: number; walSeq?: number; manifest?: 'v3' | 'v2' | 'none' | 'badjson' | 'nowalseq' | 'v1' }
function world(o: WorldOpts = {}): { root: string; stateDir: string; auditDir: string; file: string; intact: Buffer; damaged: Buffer; starts: number[] } {
	const firstSeq = o.firstSeq ?? 1
	const base = firstSeq - 1
	const root = mkdtempSync(join(tmpdir(), 'labwalrepair-'))
	const stateDir = join(root, 'state.v2')
	const auditDir = join(root, 'audit')
	mkdirSync(join(stateDir, WAL_DIR), { recursive: true })
	// the committed manifest the repair reads its scan start from (review R1): the snapshot contains everything up to firstSeq - 1
	const mf = o.manifest ?? 'v3'
	const mpath = join(stateDir, 'manifest.json')
	const snapSeq = o.walSeq ?? base
	if (mf === 'v3') writeFileSync(mpath, JSON.stringify({ version: 3, walSeq: snapSeq, generation: 'gen-1' }))
	else if (mf === 'v2') writeFileSync(mpath, JSON.stringify({ version: 2, generation: 'gen-1', scalars: { walSeq: snapSeq } }))
	else if (mf === 'badjson') writeFileSync(mpath, '{not json')
	else if (mf === 'nowalseq') writeFileSync(mpath, JSON.stringify({ version: 3, generation: 'gen-1' }))
	else if (mf === 'v1') writeFileSync(mpath, JSON.stringify({ version: 1, walSeq: base }))
	const rec = { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '1000', eventKeys: [key(1), key(2), key(3)] }
	const events = [
		ev(base + 1, [{ op: 'pendingAdd', entry: { eventKey: key(1), blockNumber: 10 } }], 'scan'),
		ev(base + 2, [{ op: 'inFlightSet', record: rec }], 'intent'),
		ev(base + 3, [{ op: 'inFlightSet', record: { ...rec, hash: '0xdead' } }], 'hash'),
		ev(base + 4, [{ op: 'consumedAdd', key: key(1) }, { op: 'consumedAdd', key: key(2) }, { op: 'pendingDel', key: key(1) }, { op: 'inFlightSet', record: null }], 'settle'),
		ev(base + 5, [{ op: 'scalarsSet', patch: { historyCursor: 99 } }], 'scan'),
	]
	const file = join(stateDir, WAL_DIR, segmentFileName(firstSeq))
	const intact = Buffer.concat(events.map((e) => encodeFrame(e)))
	writeFileSync(file, intact)
	const starts: number[] = []
	let at = 0
	for (let i = 0; i < 5; i++) {
		starts.push(at)
		const d = decodeFrameAt(intact, at)
		assert.ok(d.ok)
		if (d.ok) at = d.end
	}
	const damaged = Buffer.from(intact)
	damaged[starts[2]! + WAL_HEADER_BYTES + 2] = damaged[starts[2]! + WAL_HEADER_BYTES + 2]! ^ 0x40
	writeFileSync(file, damaged)
	return { root, stateDir, auditDir, file, intact, damaged, starts }
}
const done = (root: string): void => rmSync(root, { recursive: true, force: true })
const RUN = 'run-20261121-01'

test('repair: a run id is mandatory and well formed; nothing is touched without it', () => {
	const w = world()
	try {
		for (const bad of ['', 'short', 'has space in it', 'x'.repeat(65), '../../etc/passwd']) {
			assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: bad, approval: 'PM-2026-11-21-01' }), /run id is required/)
		}
		assert.equal(RUN_ID_RE.test(RUN), true)
		assert.deepEqual(readFileSync(w.file), w.damaged, 'the log was not touched')
		assert.equal(existsSync(w.auditDir), false, 'no audit was written')
	} finally {
		done(w.root)
	}
})

test('repair: an approval reference is mandatory; the audit directory must be outside the state directory', () => {
	const w = world()
	try {
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: '' }), /approval reference/)
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: join(w.stateDir, 'audit'), runId: RUN, approval: 'PM-2026-11-21-01' }), /OUTSIDE the state directory/)
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.stateDir, runId: RUN, approval: 'PM-2026-11-21-01' }), /OUTSIDE the state directory/)
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: '', runId: RUN, approval: 'PM-2026-11-21-01' }), /audit directory is required/)
		assert.deepEqual(readFileSync(w.file), w.damaged)
	} finally {
		done(w.root)
	}
})

test('repair: --dry-run reports the audit and changes nothing (no audit file, no truncation)', () => {
	const w = world()
	try {
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		assert.equal(r.status, 'dry-run')
		if (r.status === 'dry-run') {
			assert.equal(r.audit.validFramesDropped, 2)
			assert.equal(r.audit.badOffset, w.starts[2])
		}
		assert.deepEqual(readFileSync(w.file), w.damaged)
		assert.equal(existsSync(w.auditDir), false)
	} finally {
		done(w.root)
	}
})

test('repair: the audit (outside the state dir) lists the cut offset, the dropped frames with seq and type, and the decodable intents with their idempotency keys; then the log is cut', () => {
	const w = world()
	try {
		// before: the default refuses
		assert.throws(() => scanWal(w.stateDir, { afterSeq: 0, onEvent: () => undefined }), WalMidCorruptionError)
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', now: () => new Date('2026-11-21T15:00:00Z') })
		assert.equal(r.status, 'repaired')
		if (r.status !== 'repaired') return
		assert.equal(r.auditFile, join(w.auditDir, `wal-midcorruption-${RUN}.json`))
		const a = JSON.parse(readFileSync(r.auditFile, 'utf8'))
		assert.equal(a.runId, RUN)
		assert.equal(a.approval, 'PM-2026-11-21-01')
		assert.equal(a.at, '2026-11-21T15:00:00.000Z')
		assert.equal(a.badOffset, w.starts[2])
		assert.equal(a.bytesCut, w.damaged.length - w.starts[2]!)
		assert.equal(a.validFramesDropped, 2)
		assert.deepEqual(a.frames.map((f: { seq: number; t: string }) => [f.seq, f.t]), [[4, 'settle'], [5, 'scan']])
		assert.equal(a.frames[0].settledKeyCount, 2)
		assert.equal(r.audit.frames.length, 2)
		// the audit lives outside the state dir
		assert.equal(r.auditFile.startsWith(w.stateDir), false)
		// the log was cut at the bad frame: it now scans cleanly up to seq 2
		assert.equal(readFileSync(w.file).length, w.starts[2])
		const got: number[] = []
		const res = scanWal(w.stateDir, { afterSeq: 0, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, [1, 2])
		assert.equal(res.truncatedBytes, 0)
	} finally {
		done(w.root)
	}
})

test('repair: a frame that carries an intent is listed with its idempotency key, batch, line, amount and key count (the operator checks these against the signer and the chain)', () => {
	const w = world()
	try {
		// damage frame 1 (the scan) so that frames 2 (intent), 3 (hash), 4, 5 follow the damage
		const d = Buffer.from(w.intact)
		d[w.starts[0]! + WAL_HEADER_BYTES + 1] = d[w.starts[0]! + WAL_HEADER_BYTES + 1]! ^ 0x01
		writeFileSync(w.file, d)
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		assert.equal(r.status, 'dry-run')
		if (r.status !== 'dry-run') return
		assert.equal(r.audit.validFramesDropped, 4)
		const intent = r.audit.frames.find((f) => f.t === 'intent')!
		assert.deepEqual(intent.intents, [{ batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '1000', eventKeyCount: 3, hash: undefined }])
		const hashFrame = r.audit.frames.find((f) => f.t === 'hash')!
		assert.equal(hashFrame.intents[0]!.hash, '0xdead')
	} finally {
		done(w.root)
	}
})

test('repair: one-shot. Using it twice with the same run id fails (the audit exists); after the repair a NEW mid-log damage is refused again by default; an ordinary torn tail and a clean log are "nothing to repair"', () => {
	const w = world()
	try {
		const r1 = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		assert.equal(r1.status, 'repaired')
		// the same run id again: nothing to repair now, and a second repair with the same id could not overwrite the audit
		assert.equal(repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' }).status, 'nothing-to-repair')
		// new damage in the middle again: scanWal refuses again (nothing was enabled by the first use)
		writeFileSync(w.file, w.damaged)
		assert.throws(() => scanWal(w.stateDir, { afterSeq: 0, onEvent: () => undefined }), WalMidCorruptionError)
		// repairing it with the SAME run id must fail because the audit file already exists (exclusive create) and must not cut anything
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' }), /EEXIST/)
		assert.deepEqual(readFileSync(w.file), w.damaged, 'a failed audit write cuts nothing')
		// a torn tail (no valid frame after the damage) is not this command's business
		writeFileSync(w.file, Buffer.concat([w.intact.subarray(0, w.starts[3]!), w.intact.subarray(w.starts[3]!, w.starts[3]! + 7)]))
		assert.equal(repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: 'run-20261121-02', approval: 'PM-2026-11-21-01' }).status, 'nothing-to-repair')
	} finally {
		done(w.root)
	}
})

test('repair: there is no standing switch. scanWal ignores any option or environment variable, and neither labWal.ts nor labWalRepair.ts reads the environment', () => {
	const w = world()
	try {
		const saved = { a: process.env.CONET_LAB_WAL_ACCEPT_MID_CORRUPTION, b: process.env.ACCEPT_MID_CORRUPTION_TRUNCATION }
		process.env.CONET_LAB_WAL_ACCEPT_MID_CORRUPTION = '1'
		process.env.ACCEPT_MID_CORRUPTION_TRUNCATION = '1'
		try {
			assert.throws(() => scanWal(w.stateDir, { afterSeq: 0, onEvent: () => undefined }), WalMidCorruptionError)
			assert.deepEqual(readFileSync(w.file), w.damaged, 'nothing was cut')
		} finally {
			if (saved.a === undefined) delete process.env.CONET_LAB_WAL_ACCEPT_MID_CORRUPTION
			else process.env.CONET_LAB_WAL_ACCEPT_MID_CORRUPTION = saved.a
			if (saved.b === undefined) delete process.env.ACCEPT_MID_CORRUPTION_TRUNCATION
			else process.env.ACCEPT_MID_CORRUPTION_TRUNCATION = saved.b
		}
		for (const f of ['labWal.ts', 'labWalRepair.ts']) {
			const src = readFileSync(join(__dirname, f), 'utf8')
			assert.doesNotMatch(src, /process\.env/, `${f} must not read the environment`)
		}
		const walSrc = readFileSync(join(__dirname, 'labWal.ts'), 'utf8')
		assert.doesNotMatch(walSrc, /acceptMidCorruptionTruncation/, 'the old option is gone')
		// the daemon must not know the repair command
		const reporter = readFileSync(join(__dirname, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
		assert.doesNotMatch(reporter, /labWalRepair|repairMidCorruption/)
	} finally {
		done(w.root)
	}
})

test('repair CLI: without --run-id it exits 2 and touches nothing; with the arguments it repairs; the daemon environment is irrelevant', () => {
	const w = world()
	try {
		const script = join(__dirname, 'labWalRepair.ts')
		const loader = process.execArgv.some((a) => a.includes('tsx'))
			? [...process.execArgv]
			: ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
		const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [...loader, script, ...args], { encoding: 'utf8', env })
		const noRun = run(['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--approval', 'PM-2026-11-21-01'])
		assert.equal(noRun.status, 2)
		assert.match(noRun.stderr, /run id is required/)
		assert.deepEqual(readFileSync(w.file), w.damaged)
		const ok = run(['--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', RUN, '--approval', 'PM-2026-11-21-01'], { ...process.env, CONET_LAB_WAL_ACCEPT_MID_CORRUPTION: '0' })
		assert.equal(ok.status, 0, ok.stderr)
		assert.equal(JSON.parse(ok.stdout).status, 'repaired')
		assert.equal(readFileSync(w.file).length, w.starts[2])
		assert.ok(existsSync(join(w.auditDir, `wal-midcorruption-${RUN}.json`)))
	} finally {
		done(w.root)
	}
})

// ------------------------------------------------------------ the extra gates (independent review points 1-6)
test('repair gate 1: it takes the state-directory lock and refuses while that lock is held (a running daemon); dry-run does not need it; the lock is released afterwards', () => {
	const w = world()
	try {
		const held = acquireStateDirLock(w.stateDir)
		try {
			assert.throws(
				() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' }),
				/cannot take the state directory lock.*stop the daemon first.*Nothing was changed/s
			)
			assert.deepEqual(readFileSync(w.file), w.damaged, 'nothing was cut while the lock was held')
			assert.equal(existsSync(w.auditDir), false, 'no audit was written either')
			// a dry run only reads
			assert.equal(repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true }).status, 'dry-run')
		} finally {
			held.release()
		}
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		assert.equal(r.status, 'repaired')
		// the repair released its lock: the daemon (or anyone) can take it now
		const again = acquireStateDirLock(w.stateDir)
		again.release()
	} finally {
		done(w.root)
	}
})

test('repair gate 2: the cut bytes are stored whole beside the audit (sha256 in the audit); the audit says the dropped seqs are reused and that the approval is not verifiable', async () => {
	const w = world()
	try {
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		assert.equal(r.status, 'repaired')
		if (r.status !== 'repaired') return
		const a = JSON.parse(readFileSync(r.auditFile, 'utf8'))
		const tailPath = join(w.auditDir, a.tailFile)
		assert.equal(a.tailFile, `wal-midcorruption-${RUN}.tail.bin`)
		const tail = readFileSync(tailPath)
		assert.deepEqual(tail, w.damaged.subarray(w.starts[2]!), 'the raw bytes from the bad offset to the end of the segment')
		assert.equal(a.tailBytes, tail.length)
		assert.equal(a.tailSha256, createHash('sha256').update(tail).digest('hex'))
		assert.equal(a.lastGoodSeq, 2)
		assert.deepEqual(a.droppedSeqs, { first: 4, last: 5, count: 2 })
		assert.match(a.seqReuseNote, /continues at seq 3.*reused by different events/s)
		assert.equal(a.approvalVerified, false)
		assert.match(a.approvalNote, /plain string.*cannot verify it technically/s)
		// the dropped seq is really reused: the next event gets seq 3 and the log stays consistent
		const wr = new WalWriter({ stateDir: w.stateDir, lastSeq: 2 })
		const ap = wr.append('scan', [{ op: 'consumedAdd', key: key(77) }])
		assert.equal(ap.seq, 3)
		await ap.durable
		await wr.close()
		const seqs: number[] = []
		scanWal(w.stateDir, { afterSeq: 0, onEvent: (e) => seqs.push(e.seq) })
		assert.deepEqual(seqs, [1, 2, 3])
	} finally {
		done(w.root)
	}
})

test('repair gate 3: a failed audit write, an existing audit file, or a crash between the audit and the cut leaves the log untouched; a repeated run id is refused', () => {
	const w = world()
	try {
		// (a) the audit directory cannot be created (a file is in the way): fails before anything is cut
		const blocker = join(w.root, 'blocker')
		writeFileSync(blocker, 'x')
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: join(blocker, 'audit'), runId: RUN, approval: 'PM-2026-11-21-01' }))
		assert.deepEqual(readFileSync(w.file), w.damaged)
		// (b) the audit directory is not writable
		mkdirSync(w.auditDir, { recursive: true })
		chmodSync(w.auditDir, 0o500)
		let wrote = true
		try {
			writeFileSync(join(w.auditDir, 'probe'), 'x')
		} catch {
			wrote = false
		}
		if (!wrote) {
			assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' }))
			assert.deepEqual(readFileSync(w.file), w.damaged, 'an unwritable audit directory cuts nothing')
		}
		chmodSync(w.auditDir, 0o700)
		// (c) a crash after the audit is durable and before the cut: the log is untouched, the audit and the raw bytes exist
		assert.throws(
			() =>
				repairMidCorruption({
					stateDir: w.stateDir,
					auditDir: w.auditDir,
					runId: RUN,
					approval: 'PM-2026-11-21-01',
					hooks: {
						beforeTruncate: () => {
							throw new Error('simulated crash before the cut')
						},
					},
				}),
			/simulated crash before the cut/
		)
		assert.deepEqual(readFileSync(w.file), w.damaged)
		assert.ok(existsSync(join(w.auditDir, `wal-midcorruption-${RUN}.json`)))
		assert.equal(statSync(join(w.auditDir, `wal-midcorruption-${RUN}.tail.bin`)).size, w.damaged.length - w.starts[2]!)
		// (d) the same run id again is refused (audit exists) and cuts nothing; a new run id works
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' }), /EEXIST/)
		assert.deepEqual(readFileSync(w.file), w.damaged)
		assert.equal(repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: 'run-20261121-02', approval: 'PM-2026-11-21-01' }).status, 'repaired')
	} finally {
		done(w.root)
	}
})

test('repair gate 4: after a repair the log starts cleanly and equals the reference for the intact prefix; the daemon-side alert text names the damage and says there is no automatic repair', () => {
	const w = world()
	try {
		// the alert text the daemon prints (it only refuses to start and alerts)
		let mid: WalMidCorruptionError | null = null
		try {
			scanWal(w.stateDir, { afterSeq: 0, onEvent: () => undefined })
		} catch (e) {
			mid = e as WalMidCorruptionError
		}
		assert.ok(mid instanceof WalMidCorruptionError)
		const alert = formatWalMidCorruptionAlert(mid!)
		assert.match(alert, /^\[labMiningPoolClPayout\] ALERT WAL damaged in the middle: wal-0000000000000001\.log offset \d+ \(bad-crc\), 2 valid frame\(s\) after it, last intact seq 2\./)
		assert.match(alert, /Refusing to start; nothing was truncated; no automatic repair\./)
		assert.match(alert, /Offline only: labWalRepair with a run id and the PM written approval/)
		// repair, then a clean start equal to the intact prefix
		repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		const got: WalEvent[] = []
		const res = scanWal(w.stateDir, { afterSeq: 0, onEvent: (e) => got.push(e) })
		assert.equal(res.truncatedBytes, 0)
		assert.deepEqual(got.map((e) => [e.seq, e.t]), [[1, 'scan'], [2, 'intent']])
		const reference = Buffer.concat([encodeFrame(ev(1, [{ op: 'pendingAdd', entry: { eventKey: key(1), blockNumber: 10 } }], 'scan')), encodeFrame(ev(2, [{ op: 'inFlightSet', record: { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '1000', eventKeys: [key(1), key(2), key(3)] } }], 'intent'))])
		assert.deepEqual(readFileSync(w.file), reference, 'the file equals the encoding of the intact prefix, byte for byte')
	} finally {
		done(w.root)
	}
})

// ------------------------------------------------------------ review R1-R5 (second review receipt c289bfc3)
test('R1: the scan starts AFTER the snapshot. A log whose first segment starts at seq 101 (snapshot walSeq 100) is repaired; afterSeq 0 would have refused it', () => {
	const w = world({ firstSeq: 101 })
	try {
		// the old behaviour, for the record: a scan from 0 refuses with a missing-events error, so the repair command could never work after the first snapshot
		assert.throws(() => scanWal(w.stateDir, { afterSeq: 0, onEvent: () => undefined }), /first segment starts at seq 101 but the snapshot ends at seq 0/)
		assert.throws(() => scanWal(w.stateDir, { afterSeq: 100, onEvent: () => undefined }), WalMidCorruptionError)
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		assert.equal(r.status, 'repaired')
		if (r.status !== 'repaired') return
		assert.equal(r.audit.snapshotWalSeq, 100)
		assert.equal(r.audit.manifestVersion, 3)
		assert.equal(r.audit.lastGoodSeq, 102, 'frames 101 and 102 are intact; 103 is the damaged one')
		assert.deepEqual(r.audit.droppedSeqs, { first: 104, last: 105, count: 2 })
		assert.equal(readFileSync(w.file).length, w.starts[2])
		// the repaired log scans cleanly from the snapshot seq
		const got: number[] = []
		scanWal(w.stateDir, { afterSeq: 100, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, [101, 102])
	} finally {
		done(w.root)
	}
})

test('R1: the scan start comes from the manifest: a version 2 downgrade manifest (scalars.walSeq) works too', () => {
	const w = world({ firstSeq: 101, manifest: 'v2' })
	try {
		assert.equal(readSnapshotWalSeq(w.stateDir).walSeq, 100)
		assert.equal(readSnapshotWalSeq(w.stateDir).version, 2)
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		assert.equal(r.status, 'dry-run')
		if (r.status === 'dry-run') assert.equal(r.audit.snapshotWalSeq, 100)
	} finally {
		done(w.root)
	}
})

test('R1: a manifest that is missing, unreadable, of another version or without a valid walSeq REFUSES the repair; nothing is audited or cut', () => {
	for (const m of ['none', 'badjson', 'nowalseq', 'v1'] as const) {
		const w = world({ manifest: m })
		try {
			assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' }), /labWalRepair: .*nothing is repaired/s, `manifest ${m}`)
			assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true }), /nothing is repaired/, `dry-run with manifest ${m}`)
			assert.deepEqual(readFileSync(w.file), w.damaged, `manifest ${m}: the log was not touched`)
			assert.equal(existsSync(w.auditDir), false, `manifest ${m}: no audit was written`)
		} finally {
			done(w.root)
		}
	}
	const w = world()
	try {
		for (const bad of [-1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 2]) {
			writeFileSync(join(w.stateDir, 'manifest.json'), JSON.stringify({ version: 3, walSeq: bad }))
			assert.throws(() => readSnapshotWalSeq(w.stateDir), /no valid walSeq/, `walSeq ${String(bad)}`)
		}
	} finally {
		done(w.root)
	}
})

test('R2: the segment must still equal what was scanned at the moment of the cut; an append or a same-length change between audit and cut aborts without cutting', () => {
	const w = world()
	try {
		assert.throws(
			() =>
				repairMidCorruption({
					stateDir: w.stateDir,
					auditDir: w.auditDir,
					runId: RUN,
					approval: 'PM-2026-11-21-01',
					hooks: { beforeTruncate: () => appendFileSync(w.file, Buffer.from([0x57, 0x4c, 0, 0])) },
				}),
			/segment changed after it was scanned.*nothing was cut/s
		)
		assert.equal(readFileSync(w.file).length, w.damaged.length + 4, 'the log was not cut')
		assert.ok(existsSync(join(w.auditDir, `wal-midcorruption-${RUN}.json`)), 'the audit stays as evidence of the attempt')
		writeFileSync(w.file, w.damaged)
		const other = 'run-20261121-02'
		assert.throws(
			() =>
				repairMidCorruption({
					stateDir: w.stateDir,
					auditDir: w.auditDir,
					runId: other,
					approval: 'PM-2026-11-21-01',
					hooks: {
						beforeTruncate: () => {
							const b = Buffer.from(readFileSync(w.file))
							b[b.length - 1] = b[b.length - 1]! ^ 0xff
							writeFileSync(w.file, b)
						},
					},
				}),
			/segment changed after it was scanned/
		)
		assert.equal(readFileSync(w.file).length, w.damaged.length)
		const a = JSON.parse(readFileSync(join(w.auditDir, `wal-midcorruption-${other}.json`), 'utf8'))
		assert.equal(a.segmentBytesBefore, w.damaged.length)
		assert.equal(a.segmentSha256Before, createHash('sha256').update(w.damaged).digest('hex'))
	} finally {
		done(w.root)
	}
})

test('R3: the audit records the sha256 of the whole segment before the cut and of the cut part; the cut part is stored byte for byte', () => {
	const w = world()
	try {
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		assert.equal(r.status, 'repaired')
		if (r.status !== 'repaired') return
		assert.equal(r.audit.segmentBytesBefore, w.damaged.length)
		assert.equal(r.audit.segmentSha256Before, createHash('sha256').update(w.damaged).digest('hex'))
		const tail = readFileSync(join(w.auditDir, r.audit.tailFile!))
		assert.deepEqual(tail, w.damaged.subarray(w.starts[2]!))
		assert.equal(r.audit.tailSha256, createHash('sha256').update(tail).digest('hex'))
		assert.equal(r.audit.manifestSha256, createHash('sha256').update(readFileSync(join(w.stateDir, 'manifest.json'))).digest('hex'))
		assert.deepEqual(Buffer.concat([readFileSync(w.file), tail]), w.damaged, 'intact prefix + stored cut part = the original segment')
	} finally {
		done(w.root)
	}
})

test('R4: the audit directory is compared after realpath: a symlink into the state directory is refused (also when it does not exist yet); a symlink as the audit directory itself is refused', () => {
	const w = world()
	try {
		const link = join(w.root, 'linkToState')
		symlinkSync(w.stateDir, link)
		for (const bad of [join(link, 'audit'), join(link, WAL_DIR, 'x'), link]) {
			assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: bad, runId: RUN, approval: 'PM-2026-11-21-01' }), /OUTSIDE the state directory|symbolic link/, bad)
			assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: bad, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true }), /OUTSIDE the state directory|symbolic link/, `dry-run ${bad}`)
		}
		assert.equal(readdirSync(join(w.stateDir, WAL_DIR)).length, 1, 'no audit file was written into the WAL directory')
		assert.equal(existsSync(join(w.stateDir, 'audit')), false, 'nothing was created inside the state directory')
		const stateViaLink = join(w.root, 'stateAlias')
		symlinkSync(w.stateDir, stateViaLink)
		const elsewhere = join(w.root, 'elsewhere')
		mkdirSync(elsewhere)
		const auditLink = join(w.root, 'auditLink')
		symlinkSync(elsewhere, auditLink)
		assert.throws(() => repairMidCorruption({ stateDir: stateViaLink, auditDir: auditLink, runId: RUN, approval: 'PM-2026-11-21-01' }), /symbolic link/)
		assert.throws(() => repairMidCorruption({ stateDir: stateViaLink, auditDir: join(w.stateDir, 'audit2'), runId: RUN, approval: 'PM-2026-11-21-01' }), /OUTSIDE the state directory/)
		assert.throws(() => repairMidCorruption({ stateDir: w.stateDir, auditDir: w.root, runId: RUN, approval: 'PM-2026-11-21-01' }), /OUTSIDE the state directory/, 'an audit directory that contains the state directory is refused too')
		assert.deepEqual(readFileSync(w.file), w.damaged)
		assert.equal(repairMidCorruption({ stateDir: stateViaLink, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' }).status, 'repaired', 'a plain sibling works, also when the state dir is given through an alias')
	} finally {
		done(w.root)
	}
})

test('R4: realpathOrAncestor resolves symlinks in the existing part and appends the missing tail', () => {
	const w = world()
	try {
		const link = join(w.root, 'lnk')
		symlinkSync(w.stateDir, link)
		assert.equal(realpathOrAncestor(join(link, 'not', 'there')), join(realpathOrAncestor(w.stateDir), 'not', 'there'))
	} finally {
		done(w.root)
	}
})

test('R5: CLI arguments are strict - a value that starts with -- is refused (--run-id --approval x), repeated and unknown flags are refused; the CLI exits 2 and touches nothing', () => {
	assert.throws(() => parseCliArgs(['--run-id', '--approval', 'x']), /--run-id needs a value/)
	assert.throws(() => parseCliArgs(['--state-dir']), /needs a value \(got nothing\)/)
	assert.throws(() => parseCliArgs(['--run-id', 'a', '--run-id', 'b']), /given twice/)
	assert.throws(() => parseCliArgs(['--force']), /unknown argument/)
	assert.throws(() => parseCliArgs(['stray']), /unknown argument/)
	assert.deepEqual(parseCliArgs(['--state-dir', '/s', '--audit-dir', '/a', '--run-id', 'run-12345678', '--approval', 'PM-1', '--dry-run']), {
		values: { '--state-dir': '/s', '--audit-dir': '/a', '--run-id': 'run-12345678', '--approval': 'PM-1' },
		dryRun: true,
	})
	const w = world()
	try {
		const script = join(__dirname, 'labWalRepair.ts')
		const loader = process.execArgv.some((a) => a.includes('tsx'))
			? [...process.execArgv]
			: ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
		const r = spawnSync(process.execPath, [...loader, script, '--state-dir', w.stateDir, '--audit-dir', w.auditDir, '--run-id', '--approval', 'PM-2026-11-21-01'], { encoding: 'utf8' })
		assert.equal(r.status, 2)
		assert.match(r.stderr, /--run-id needs a value/)
		assert.deepEqual(readFileSync(w.file), w.damaged)
		assert.equal(existsSync(w.auditDir), false)
	} finally {
		done(w.root)
	}
})

// ------------------------------------------------------------ review R6: the snapshot is AHEAD of the damaged frame
test('R6: snapshot walSeq 104, frames 101..105, frame 103 damaged: the repair splits the dropped frames into covered (104) and lost (105), the daemon continues at 105, the new event is NOT swallowed as "already in the snapshot", and the log scans cleanly', async () => {
	const w = world({ firstSeq: 101, walSeq: 104 })
	try {
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		assert.equal(r.status, 'repaired')
		if (r.status !== 'repaired') return
		assert.equal(r.audit.lastGoodSeq, 102)
		assert.equal(r.audit.snapshotWalSeq, 104)
		assert.deepEqual(r.audit.droppedCoveredBySnapshot, { count: 1, seqs: [104] })
		assert.deepEqual(r.audit.droppedBeyondSnapshot, { count: 1, seqs: [105] })
		assert.equal(r.audit.nextEventSeq, 105)
		assert.match(r.audit.seqReuseNote, /continues at seq 105/)
		assert.match(r.audit.seqReuseNote, /1 lie above it and ARE lost/)
		// the repaired log (frames 101, 102) scans from the snapshot seq
		const first: number[] = []
		const res = scanWal(w.stateDir, { afterSeq: 104, onEvent: (e) => first.push(e.seq) })
		assert.deepEqual(first, [])
		assert.equal(res.lastSeq, 102)
		// recovery's writer start is max(scan.lastSeq, walSeq); its first event is seq 105 in a new segment
		const wal = new WalWriter({ stateDir: w.stateDir, lastSeq: Math.max(res.lastSeq, 104), onFatal: (e) => { throw e } })
		const { seq, durable } = wal.append('t', [{ op: 'consumedAdd', key: 'after-repair' }])
		assert.equal(seq, 105)
		await durable
		await wal.close()
		// the old covered segment (ends at 102) and the new one (starts at 105) are both there: the forward jump 103..104 lies inside the snapshot and is accepted
		assert.equal(readdirSync(join(w.stateDir, WAL_DIR)).length, 2)
		const got: number[] = []
		scanWal(w.stateDir, { afterSeq: 104, onEvent: (e) => got.push(e.seq) })
		assert.deepEqual(got, [105], 'the event written after the repair is delivered, not dropped')
		// a LATER snapshot (walSeq 110) still accepts it: the gap only gets more covered
		scanWal(w.stateDir, { afterSeq: 110, onEvent: () => undefined })
	} finally {
		done(w.root)
	}
})

test('R6: a forward jump that hides an event ABOVE the snapshot still refuses; so does an overlap', async () => {
	const w = world({ firstSeq: 101, walSeq: 100 })
	try {
		// no damage here: cut the segment to frames 101..102 (intact) and add a second segment that starts at 106 (events 103..105 missing, all above the snapshot at 100)
		writeFileSync(w.file, w.intact.subarray(0, w.starts[2]))
		const segB = join(w.stateDir, WAL_DIR, segmentFileName(106))
		writeFileSync(segB, encodeFrame(ev(106, [{ op: 'consumedAdd', key: 'x' }], 'scan')))
		assert.throws(() => scanWal(w.stateDir, { afterSeq: 100, onEvent: () => undefined }), /segment .* starts at seq 106 but the previous segment ended at seq 102/)
		// with the snapshot at 105 the same jump is inside the snapshot: accepted
		assert.doesNotThrow(() => scanWal(w.stateDir, { afterSeq: 105, onEvent: () => undefined }))
		// an overlap (second segment starts at 102) refuses whatever the snapshot is
		rmSync(segB)
		writeFileSync(join(w.stateDir, WAL_DIR, segmentFileName(102)), encodeFrame(ev(102, [{ op: 'consumedAdd', key: 'y' }], 'scan')))
		assert.throws(() => scanWal(w.stateDir, { afterSeq: 500, onEvent: () => undefined }), /starts at seq 102 but the previous segment ended at seq 102/)
	} finally {
		done(w.root)
	}
})

test('R6: snapshot at or behind the last intact frame (the ordinary case) keeps lastGoodSeq + 1; a snapshot beyond ALL frames covers every dropped frame and loses none', () => {
	const a = world({ firstSeq: 101, walSeq: 100 })
	const b = world({ firstSeq: 101, walSeq: 110 })
	try {
		const ra = repairMidCorruption({ stateDir: a.stateDir, auditDir: a.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		const rb = repairMidCorruption({ stateDir: b.stateDir, auditDir: b.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		if (ra.status !== 'dry-run' || rb.status !== 'dry-run') throw new Error('expected dry runs')
		assert.equal(ra.audit.nextEventSeq, 103)
		assert.deepEqual(ra.audit.droppedBeyondSnapshot.seqs, [104, 105])
		assert.equal(ra.audit.droppedCoveredBySnapshot.count, 0)
		assert.equal(rb.audit.nextEventSeq, 111)
		assert.equal(rb.audit.droppedBeyondSnapshot.count, 0)
		assert.deepEqual(rb.audit.droppedCoveredBySnapshot.seqs, [104, 105])
	} finally {
		done(a.root)
		done(b.root)
	}
})

// ------------------------------------------------------------ review R7: the damaged frame itself is a lost event too
test('R7: the damaged frame is listed as an undecodable event with its inferred seq, byte range and the snapshot split; "at least N lost" counts it; two damaged frames are both found', () => {
	// walSeq 102, frames 101..105, frame 103 damaged: 104, 105 decodable and lost; 103 undecodable and lost
	const a = world({ firstSeq: 101, walSeq: 102 })
	try {
		const r = repairMidCorruption({ stateDir: a.stateDir, auditDir: a.auditDir, runId: RUN, approval: 'PM-2026-11-21-01' })
		assert.equal(r.status, 'repaired')
		if (r.status !== 'repaired') return
		assert.deepEqual(r.audit.droppedBeyondSnapshot.seqs, [104, 105])
		assert.equal(r.audit.undecodableEvents.count, 1)
		assert.deepEqual(r.audit.undecodableEvents.seqs, [103])
		assert.deepEqual(r.audit.undecodableEvents.lostBeyondSnapshot, [103])
		assert.deepEqual(r.audit.undecodableEvents.coveredBySnapshot, [])
		assert.deepEqual(r.audit.undecodableEvents.byteRanges, [{ from: a.starts[2], to: a.starts[3] }])
		assert.match(r.audit.undecodableEvents.note, /AT LEAST 1 event\(s\) above the snapshot could not be decoded.*reconcile EVERY transaction/s)
		assert.equal(r.audit.lostEventsAtLeast, 3, '103 (undecodable) + 104 + 105')
		assert.equal(r.audit.lastGoodEventTs, '2026-11-21T00:00:00.000Z', 'the time of the last intact event (102)')
		assert.ok(!Number.isNaN(Date.parse(r.audit.segmentMtime)))
		const onDisk = JSON.parse(readFileSync(r.auditFile, 'utf8'))
		assert.deepEqual(onDisk.undecodableEvents.seqs, [103])
	} finally {
		done(a.root)
	}
	// the same damage with the snapshot at 104: the damaged frame 103 lies inside the snapshot, nothing is lost for it
	const b = world({ firstSeq: 101, walSeq: 104 })
	try {
		const r = repairMidCorruption({ stateDir: b.stateDir, auditDir: b.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		if (r.status !== 'dry-run') throw new Error('expected a dry run')
		assert.deepEqual(r.audit.undecodableEvents.coveredBySnapshot, [103])
		assert.deepEqual(r.audit.undecodableEvents.lostBeyondSnapshot, [])
		assert.match(r.audit.undecodableEvents.note, /inside the snapshot.*nothing is lost/s)
		assert.equal(r.audit.lostEventsAtLeast, 1, 'only 105 is lost')
	} finally {
		done(b.root)
	}
	// two damaged frames (102 and 104): both are undecodable, the intact 103 and 105 are listed as decodable
	const c = world({ firstSeq: 101, walSeq: 100 })
	try {
		const buf = Buffer.from(c.damaged)
		buf[c.starts[3]! + WAL_HEADER_BYTES + 2] = buf[c.starts[3]! + WAL_HEADER_BYTES + 2]! ^ 0x40
		buf[c.starts[1]! + WAL_HEADER_BYTES + 2] = buf[c.starts[1]! + WAL_HEADER_BYTES + 2]! ^ 0x40
		buf[c.starts[2]! + WAL_HEADER_BYTES + 2] = c.intact[c.starts[2]! + WAL_HEADER_BYTES + 2]! // frame 103 intact again
		writeFileSync(c.file, buf)
		const r = repairMidCorruption({ stateDir: c.stateDir, auditDir: c.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		if (r.status !== 'dry-run') throw new Error('expected a dry run')
		assert.equal(r.audit.lastGoodSeq, 101)
		assert.deepEqual(r.audit.frames.map((f) => f.seq), [103, 105])
		assert.deepEqual(r.audit.undecodableEvents.seqs, [102, 104])
		assert.equal(r.audit.undecodableEvents.byteRanges.length, 2)
		assert.equal(r.audit.lostEventsAtLeast, 4, '102, 103, 104, 105')
	} finally {
		done(c.root)
	}
})

// ------------------------------------------------------------ review R8: the damaged frame is the FIRST frame of its segment
test('R8: a damaged first frame reports lastGoodSeq = firstSeq - 1 (not 0): no fake seqs, exact counts, and a huge span never enumerates the list', () => {
	const w = world({ firstSeq: 101, walSeq: 100 })
	try {
		const buf = Buffer.from(w.intact)
		buf[w.starts[0]! + WAL_HEADER_BYTES + 2] = buf[w.starts[0]! + WAL_HEADER_BYTES + 2]! ^ 0x40 // frame 101 damaged
		writeFileSync(w.file, buf)
		const r = repairMidCorruption({ stateDir: w.stateDir, auditDir: w.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		if (r.status !== 'dry-run') throw new Error('expected a dry run')
		assert.equal(r.audit.lastGoodSeq, 100, 'the seq just before the segment, not 0')
		assert.deepEqual(r.audit.frames.map((f) => f.seq), [102, 103, 104, 105])
		assert.deepEqual(r.audit.undecodableEvents.seqs, [101])
		assert.equal(r.audit.undecodableEvents.count, 1)
		assert.equal(r.audit.undecodableEvents.lostCount, 1)
		assert.equal(r.audit.undecodableEvents.listTruncated, false)
		assert.equal(r.audit.nextEventSeq, 101)
		assert.equal(r.audit.lostEventsAtLeast, 5)
	} finally {
		done(w.root)
	}
	// the same with the very first segment of a log whose snapshot is far ahead of the log start: the old code would have said lastGoodSeq 0 and enumerated ~500k fake seqs
	const v = world({ firstSeq: 1, walSeq: 0 })
	try {
		const buf = Buffer.from(v.intact)
		buf[v.starts[0]! + WAL_HEADER_BYTES + 2] = buf[v.starts[0]! + WAL_HEADER_BYTES + 2]! ^ 0x40
		writeFileSync(v.file, buf)
		const r = repairMidCorruption({ stateDir: v.stateDir, auditDir: v.auditDir, runId: RUN, approval: 'PM-2026-11-21-01', dryRun: true })
		if (r.status !== 'dry-run') throw new Error('expected a dry run')
		assert.equal(r.audit.lastGoodSeq, 0)
		assert.deepEqual(r.audit.undecodableEvents.seqs, [1])
	} finally {
		done(v.root)
	}
})

test('R8: the undecodable list is bounded - a huge span reports exact counts and the range, not the list; the covered/lost split stays exact', () => {
	// last intact 100, decodable later frames 500001 and 500003, snapshot at 400000: 500000 seqs between, 2 decodable
	const big = inferUndecodable(100, [500001, 500003], 400000)
	assert.equal(big.listTruncated, true)
	assert.deepEqual(big.seqs, [])
	assert.equal(big.span, 500003 - 100)
	assert.equal(big.count, 500003 - 100 - 2)
	assert.equal(big.coveredCount, 400000 - 100, 'seqs 101..400000 are inside the snapshot and none of them is decodable')
	assert.equal(big.lostCount, big.count - big.coveredCount)
	// small span: the lists are present and agree with the counts
	const small = inferUndecodable(100, [102, 104], 102)
	assert.deepEqual(small.seqs, [101, 103])
	assert.deepEqual(small.coveredList, [101])
	assert.deepEqual(small.lostList, [103])
	assert.equal(small.coveredCount, 1)
	assert.equal(small.lostCount, 1)
	assert.equal(small.listTruncated, false)
	// nothing decodable after the damage
	const none = inferUndecodable(100, [], 50)
	assert.equal(none.count, 0)
	assert.equal(none.span, 0)
	// the counts agree with the lists for random inputs
	for (let seed = 1; seed <= 200; seed++) {
		let x = seed
		const r = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 0x100000000)
		const last = Math.floor(r() * 50)
		const decoded: number[] = []
		for (let q = last + 1; q <= last + 40; q++) if (r() < 0.5) decoded.push(q)
		const wal = Math.floor(r() * 90)
		const full = inferUndecodable(last, decoded, wal, 1000)
		assert.equal(full.seqs.length, full.count, `seed ${seed}`)
		assert.equal(full.coveredList.length, full.coveredCount, `seed ${seed}`)
		assert.equal(full.lostList.length, full.lostCount, `seed ${seed}`)
		const cnt = inferUndecodable(last, decoded, wal, 0)
		if (full.span > 0) assert.equal(cnt.listTruncated, true)
		assert.equal(cnt.count, full.count)
		assert.equal(cnt.coveredCount, full.coveredCount)
		assert.equal(cnt.lostCount, full.lostCount)
	}
})

test('minMax is stack-safe on a huge array (Math.min(...a) would overflow the call stack) and agrees with the spread form on small ones; inferUndecodable survives 500k decoded seqs', () => {
	assert.equal(minMax([]), null)
	assert.deepEqual(minMax([5]), { min: 5, max: 5 })
	assert.deepEqual(minMax([3, 9, 1, 7]), { min: 1, max: 9 })
	const big = Array.from({ length: 500_000 }, (_, i) => 1000 + i)
	assert.throws(() => Math.max(...big), RangeError, 'the spread form really overflows here')
	assert.deepEqual(minMax(big), { min: 1000, max: 500_999 })
	const r = inferUndecodable(999, big, 0)
	assert.equal(r.span, 500_000)
	assert.equal(r.count, 0)
	assert.equal(r.listTruncated, true)
})
