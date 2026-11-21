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
import { WAL_DIR, WAL_HEADER_BYTES, WalMidCorruptionError, decodeFrameAt, encodeFrame, scanWal, segmentFileName, type WalEvent, type WalOp } from './labWal'
import { RUN_ID_RE, repairMidCorruption } from './labWalRepair'

const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const ev = (seq: number, ops: WalOp[], t: string): WalEvent => ({ v: 1, seq, ts: '2026-11-21T00:00:00.000Z', t, ops })

/** A segment of 5 events: 1 scan, 2 intent, 3 hash, 4 settle, 5 scan; frame 3 is then damaged. Returns the file, the intact bytes, and the frame offsets. */
function world(): { root: string; stateDir: string; auditDir: string; file: string; intact: Buffer; damaged: Buffer; starts: number[] } {
	const root = mkdtempSync(join(tmpdir(), 'labwalrepair-'))
	const stateDir = join(root, 'state.v2')
	const auditDir = join(root, 'audit')
	mkdirSync(join(stateDir, WAL_DIR), { recursive: true })
	const rec = { batchId: 'b1', idempotencyKey: 'lab-withdrawNative:abc', line: 'history', amountWei: '1000', eventKeys: [key(1), key(2), key(3)] }
	const events = [
		ev(1, [{ op: 'pendingAdd', entry: { eventKey: key(1), blockNumber: 10 } }], 'scan'),
		ev(2, [{ op: 'inFlightSet', record: rec }], 'intent'),
		ev(3, [{ op: 'inFlightSet', record: { ...rec, hash: '0xdead' } }], 'hash'),
		ev(4, [{ op: 'consumedAdd', key: key(1) }, { op: 'consumedAdd', key: key(2) }, { op: 'pendingDel', key: key(1) }, { op: 'inFlightSet', record: null }], 'settle'),
		ev(5, [{ op: 'scalarsSet', patch: { historyCursor: 99 } }], 'scan'),
	]
	const file = join(stateDir, WAL_DIR, segmentFileName(1))
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
