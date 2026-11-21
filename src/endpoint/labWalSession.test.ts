/** P2c-2: the WAL session's start-up refusals and the crash-safe first-start bootstrap (found by the C5 random kill test). */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openWalSession, WAL_BOOTSTRAP_MARKER } from './labWalSession'

function tmp(): { root: string; stateDir: string; legacy: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labwalsession-'))
	return { root, stateDir: path.join(root, 'state.v2'), legacy: path.join(root, 'state.json') }
}
const open = (t: { stateDir: string; legacy: string }, logs: string[] = []) => openWalSession({ stateDir: t.stateDir, legacyStateFile: t.legacy, scanFloor: 100, log: (l) => logs.push(l) })

test('a clean first start bootstraps a version 3 snapshot, leaves no marker, and a second start recovers it', async () => {
	const t = tmp()
	const s = await open(t)
	await s.wal.close()
	assert.equal(fs.existsSync(path.join(t.stateDir, WAL_BOOTSTRAP_MARKER)), false)
	assert.equal(JSON.parse(fs.readFileSync(path.join(t.stateDir, 'manifest.json'), 'utf8')).version, 3)
	const s2 = await open(t)
	await s2.wal.close()
	assert.equal(s2.handle.scalar('lastBackfillProcessedBlock'), 99)
	fs.rmSync(t.root, { recursive: true, force: true })
})

test('a bootstrap killed before its manifest commit (marker + partial generation) is discarded and redone', async () => {
	const t = tmp()
	fs.mkdirSync(path.join(t.stateDir, 'gen-20261121T000000Z-aaaaaaaaaaaa'), { recursive: true })
	fs.writeFileSync(path.join(t.stateDir, 'gen-20261121T000000Z-aaaaaaaaaaaa', 'pending-0.jsonl'), 'partial')
	fs.writeFileSync(path.join(t.stateDir, WAL_BOOTSTRAP_MARKER), 'x')
	const logs: string[] = []
	const s = await open(t, logs)
	await s.wal.close()
	assert.ok(logs.some((l) => /bootstrap was interrupted/.test(l)))
	assert.equal(fs.existsSync(path.join(t.stateDir, 'gen-20261121T000000Z-aaaaaaaaaaaa')), false)
	assert.equal(fs.existsSync(path.join(t.stateDir, WAL_BOOTSTRAP_MARKER)), false)
	fs.rmSync(t.root, { recursive: true, force: true })
})

test('an orphan dir WITHOUT the marker still refuses (it could be a lost state)', async () => {
	const t = tmp()
	fs.mkdirSync(path.join(t.stateDir, 'gen-20261121T000000Z-bbbbbbbbbbbb'), { recursive: true })
	await assert.rejects(() => open(t), /no committed manifest/)
	assert.equal(fs.existsSync(path.join(t.stateDir, 'gen-20261121T000000Z-bbbbbbbbbbbb')), true, 'nothing was deleted')
	fs.rmSync(t.root, { recursive: true, force: true })
})

test('a marker next to a non-empty wal/ is not a partial bootstrap: refuse and delete nothing', async () => {
	const t = tmp()
	fs.mkdirSync(path.join(t.stateDir, 'wal'), { recursive: true })
	fs.writeFileSync(path.join(t.stateDir, 'wal', 'wal-0000000001.log'), 'frames')
	fs.writeFileSync(path.join(t.stateDir, WAL_BOOTSTRAP_MARKER), 'x')
	await assert.rejects(() => open(t), /not a partial bootstrap/)
	assert.equal(fs.existsSync(path.join(t.stateDir, 'wal', 'wal-0000000001.log')), true)
	fs.rmSync(t.root, { recursive: true, force: true })
})

test('a marker next to a committed manifest (killed between commit and removal) is just removed', async () => {
	const t = tmp()
	const s = await open(t)
	await s.wal.close()
	fs.writeFileSync(path.join(t.stateDir, WAL_BOOTSTRAP_MARKER), 'x')
	const s2 = await open(t)
	await s2.wal.close()
	assert.equal(fs.existsSync(path.join(t.stateDir, WAL_BOOTSTRAP_MARKER)), false)
	fs.rmSync(t.root, { recursive: true, force: true })
})

test('a legacy single-file state with no v2 state refuses and creates nothing', async () => {
	const t = tmp()
	fs.writeFileSync(t.legacy, '{}')
	await assert.rejects(() => open(t), /labClPayoutStateMigrate/)
	assert.equal(fs.existsSync(t.stateDir), false)
	fs.rmSync(t.root, { recursive: true, force: true })
})

test('S4: the start-up alignment runs inside enterTick/exitTick (finally) and leaves the handle idle; the reporter refuses to start while a tick is running; shutdown writes go through requireIdle', async () => {
	const t = tmp()
	const s = await open(t)
	await s.wal.close()
	assert.doesNotThrow(() => s.handle.requireIdle(), 'no tick is marked running after the start-up alignment')
	s.handle.enterTick()
	assert.throws(() => s.handle.enterTick(), /ticks must be serial/, 'a tick entering while the alignment still held the mark would be refused the same way')
	s.handle.exitTick()
	fs.rmSync(t.root, { recursive: true, force: true })
	const session = fs.readFileSync(path.join(__dirname, 'labWalSession.ts'), 'utf8')
	assert.match(session, /handle\.enterTick\(\)\s*\n\s*let sessionBackfillFloor[\s\S]*?try \{[\s\S]*?await handle\.commit\('scalars'\)\s*\n\s*\} finally \{\s*\n\s*handle\.exitTick\(\)/, 'alignment is wrapped in enterTick ... finally exitTick')
	const reporter = fs.readFileSync(path.join(__dirname, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	assert.match(reporter, /if \(labInFlight\) throw new Error\('\[labMiningPoolClPayout\] start while a tick is running'\)\s*\n\s*if \(labWalMode\(\)\)/, 'the start refuses while a tick runs, before either start path')
	assert.match(reporter, /s\.handle\.requireIdle\(\)/, 'the WAL shutdown flush refuses to write in parallel with a tick')
	assert.match(session, /await s\.scheduler\.stop\(\)[\s\S]*?tickIdle[\s\S]*?s\.handle\.requireIdle\(\)[\s\S]*?gracefulStopToV2/, 'the graceful stop stops the scheduler, checks the tick is idle, requires idle, then converts')
})
