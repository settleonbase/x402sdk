/**
 * Forward-compat WAL guard: wal/ absent and empty are fine (behaviour of df78e6b), anything inside refuses to start.
 * Local temp dirs only.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WAL_DIR_NAME, assertNoWalEvents } from './labWalGuard'

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'labwalguard-'))
	try {
		fn(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test('WAL guard: no wal/ directory (and no state dir at all) is accepted', () => {
	withDir((dir) => {
		assert.equal(assertNoWalEvents(join(dir, 'state.v2')), 'absent', 'state dir does not exist yet')
		mkdirSync(join(dir, 'state.v2'))
		assert.equal(assertNoWalEvents(join(dir, 'state.v2')), 'absent')
	})
})

test('WAL guard: an empty wal/ directory is accepted', () => {
	withDir((dir) => {
		mkdirSync(join(dir, 'state.v2', WAL_DIR_NAME), { recursive: true })
		assert.equal(assertNoWalEvents(join(dir, 'state.v2')), 'empty')
	})
})

test('WAL guard: any entry in wal/ refuses to start, and the message says what to do', () => {
	withDir((dir) => {
		const wal = join(dir, 'state.v2', WAL_DIR_NAME)
		mkdirSync(wal, { recursive: true })
		writeFileSync(join(wal, 'wal-0000000000000001.log'), 'x')
		assert.throws(() => assertNoWalEvents(join(dir, 'state.v2')), /is not empty \(1 entry\).*Refusing to start.*gracefully.*wal\/ is empty/s)
		writeFileSync(join(wal, 'wal-0000000000000002.log'), 'y')
		assert.throws(() => assertNoWalEvents(join(dir, 'state.v2')), /2 entries/)
	})
})

test('WAL guard: a hidden file or a sub-directory also counts; a wal that is a file refuses to start', () => {
	withDir((dir) => {
		const wal = join(dir, 'state.v2', WAL_DIR_NAME)
		mkdirSync(wal, { recursive: true })
		writeFileSync(join(wal, '.hidden'), '')
		assert.throws(() => assertNoWalEvents(join(dir, 'state.v2')), /not empty/)
		rmSync(wal, { recursive: true, force: true })
		mkdirSync(join(wal, 'sub'), { recursive: true })
		assert.throws(() => assertNoWalEvents(join(dir, 'state.v2')), /not empty/)
		rmSync(wal, { recursive: true, force: true })
		writeFileSync(wal, 'not a dir')
		assert.throws(() => assertNoWalEvents(join(dir, 'state.v2')), /not a directory/)
	})
})

test('WAL guard: the daemon start calls it right after taking the state lock and before reading the state (source check)', () => {
	const src = readFileSync(join(__dirname, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	const lock = src.indexOf('labStateLock = acquireStateDirLock(')
	const guard = src.indexOf('assertNoWalEvents(resolveSegmentedStateDir())')
	const init = src.indexOf('labSessionState = initLabSessionState()', lock)
	assert.ok(lock > 0 && guard > lock && init > guard, 'order: lock, guard, state init')
	assert.doesNotMatch(src.slice(lock - 400, guard), /resolveHistoryPayBehindCursor|process\.env\.[A-Z_]*WAL/, 'the guard is not behind a flag')
})
