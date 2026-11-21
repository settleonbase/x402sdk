/**
 * The read-only restore check (runbook H3): it reports what a start would recover and PROVES it wrote nothing - including the cases where a real start would truncate a torn tail and
 * delete covered segments.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WAL_DIR, WalWriter, listSegments } from './labWal'
import { restoreCheck, treeFingerprint } from './labPayoutRestoreCheck'
import { opsForSeq } from './labWalKillChild'

const fatal = (e: Error): void => {
	throw e
}

async function build(): Promise<{ root: string; stateDir: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labrestore-'))
	const stateDir = path.join(root, 'state.v2')
	const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
	let src = core.freezeForSnapshot()
	let res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 400, onFatal: fatal })
	const ps: Promise<void>[] = []
	for (let i = 0; i < 30; i++) ps.push(core.record(wal, 't', opsForSeq(5, wal.lastSeq + 1)).durable)
	await Promise.all(ps)
	// a snapshot that covers events 1..30 but whose truncation never ran: covered segments remain
	src = core.freezeForSnapshot()
	res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
	core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
	for (let i = 0; i < 6; i++) ps.push(core.record(wal, 't', opsForSeq(5, wal.lastSeq + 1)).durable)
	await Promise.all(ps)
	await wal.close()
	return { root, stateDir }
}

test('restore check reports the recovery and changes NOTHING, even with a torn tail and covered segments that a real start would clean', async () => {
	const { root, stateDir } = await build()
	try {
		const segs = listSegments(path.join(stateDir, WAL_DIR))
		assert.ok(segs.length >= 3)
		// a torn tail on the last segment
		const last = path.join(stateDir, WAL_DIR, segs[segs.length - 1]!.file)
		fs.appendFileSync(last, Buffer.from([0x57, 0x4c, 0x40, 0, 0, 0, 9, 9]))
		const before = treeFingerprint(stateDir)
		const r = restoreCheck(stateDir)
		assert.equal(r.unchanged, true)
		assert.equal(r.fingerprintBefore, before)
		assert.equal(treeFingerprint(stateDir), before, 'the tree is byte-for-byte and mtime-for-mtime the same afterwards')
		assert.equal(r.manifestVersion, 3)
		assert.equal(r.snapshotSeq, 30)
		assert.equal(r.replayed, 6)
		assert.equal(r.lastSeqInLog, 36)
		assert.equal(r.nextEventSeq, 37)
		assert.equal(r.tornTailBytes, 8, 'the torn tail is reported, not repaired')
		assert.ok(r.wouldCleanSegments.length >= 1, 'covered segments are listed, not deleted')
		for (const f of r.wouldCleanSegments) assert.ok(fs.existsSync(path.join(stateDir, WAL_DIR, f)), `${f} still exists`)
		assert.equal(r.lockPresent, false)
		assert.deepEqual(r.warnings, [])
		// a real recovery on a copy does what the report said it would
		const copy = path.join(root, 'copy')
		fs.cpSync(stateDir, copy, { recursive: true })
		const { recoverPayoutState } = await import('./labPayoutRecovery')
		const real = recoverPayoutState(copy)
		assert.deepEqual(real.cleanedSegments.sort(), r.wouldCleanSegments.slice().sort())
		assert.equal(real.scan.truncatedBytes, 8)
		assert.equal(real.writerLastSeq + 1, r.nextEventSeq)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test('restore check: a lock file next to the state dir is reported; mid-log damage throws and still changes nothing', async () => {
	const { root, stateDir } = await build()
	try {
		fs.writeFileSync(`${stateDir}.lock`, '{"pid":1}')
		assert.equal(restoreCheck(stateDir).lockPresent, true)
		fs.rmSync(`${stateDir}.lock`)
		const segs = listSegments(path.join(stateDir, WAL_DIR))
		const file = path.join(stateDir, WAL_DIR, segs[0]!.file) // a segment that is not the last: a bad frame there is refused
		const buf = fs.readFileSync(file)
		buf[12] = buf[12]! ^ 0x55
		fs.writeFileSync(file, buf)
		const before = treeFingerprint(stateDir)
		assert.throws(() => restoreCheck(stateDir), /refusing to start|not the last|valid frame/i)
		assert.equal(treeFingerprint(stateDir), before)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test('restore check CLI: prints the JSON report, exits 0 when nothing changed; wrong arguments exit 2', async () => {
	const { root, stateDir } = await build()
	try {
		const script = join(__dirname, 'labPayoutRestoreCheck.ts')
		const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
		const run = (a: string[]) => spawnSync(process.execPath, [...loader, script, ...a], { encoding: 'utf8' })
		const ok = run(['--state-dir', stateDir])
		assert.equal(ok.status, 0, ok.stderr)
		const j = JSON.parse(ok.stdout)
		assert.equal(j.unchanged, true)
		assert.equal(j.snapshotSeq, 30)
		assert.equal(run([]).status, 2)
		assert.equal(run(['--state-dir']).status, 2)
		assert.equal(run(['--state-dir', stateDir, '--fix']).status, 2)
		const src = fs.readFileSync(script, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		assert.doesNotMatch(src, /process\.env|writeFileSync|unlinkSync|rmSync|ftruncate|truncateSync|renameSync|appendFileSync|mkdirSync|writeSync|openSync\([^)]*'(w|a|r\+)'/, 'the tool contains no write call at all')
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})
