/**
 * Unit tests for the single-writer lock (labClPayoutStateLock). No chain, no RPC, no signer.
 * The cross-process case starts a real second node process with spawnSync.
 * Compile with tsconfig.test.json and run with node --test (see labClPayoutStateStore.test.ts).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { acquireStateDirLock, stateDirLockPath } from './labClPayoutStateLock'
import { assertSegmentedCommitFenceClear, SEGMENTED_COMMIT_FENCE_FILE } from './labClPayoutStateStore'

function withRoot(fn: (root: string) => void): void {
	const base = process.env.LAB_STATE_TEST_ROOT?.trim() || os.tmpdir()
	fs.mkdirSync(base, { recursive: true })
	const root = fs.mkdtempSync(path.join(base, 'lab-lock-test-'))
	try {
		fn(root)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
}

test('B-1: a second process cannot take the state-dir lock; the refusal names the live holder', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		const lock = acquireStateDirLock(stateDir)
		try {
			assert.throws(() => acquireStateDirLock(stateDir), /already held by this process/)
			const modPath = path.join(__dirname, 'labClPayoutStateLock.js')
			const script =
				`const m = require(${JSON.stringify(modPath)}); ` +
				`try { m.acquireStateDirLock(${JSON.stringify(stateDir)}); console.log('ACQUIRED'); process.exit(0) } ` +
				`catch (e) { console.error(e.message); process.exit(3) }`
			const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
			assert.equal(r.status, 3, `second process must be refused. stdout=${r.stdout} stderr=${r.stderr}`)
			assert.match(r.stderr, new RegExp(`held by live pid ${process.pid} `))
			assert.match(r.stderr, /refusing to start a second writer/)
		} finally {
			lock.release()
		}
		const again = acquireStateDirLock(stateDir)
		again.release()
		assert.equal(fs.existsSync(stateDirLockPath(stateDir)), false, 'released lock file is removed')
	})
})

test('commit durability fence blocks stale-lock reclaim and the exit hook preserves the writer lock', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		fs.mkdirSync(stateDir)
		const lockModule = path.join(__dirname, 'labClPayoutStateLock.js')
		const lockSource = path.join(__dirname, 'labClPayoutStateLock.ts')
		const modulePath = fs.existsSync(lockModule) ? lockModule : lockSource
		const childArgs: string[] = []
		const tsHook = process.env.LAB_STATE_TEST_TS_HOOK
		if (tsHook) childArgs.push('--require', tsHook)
		childArgs.push('-e',
			"const fs=require('node:fs');const path=require('node:path');const m=require(process.argv[1]);const d=process.argv[2];m.acquireStateDirLock(d);fs.writeFileSync(path.join(d,process.argv[3]),'synthetic fence\\n');process.exit(0)",
			modulePath, stateDir, SEGMENTED_COMMIT_FENCE_FILE)
		const child = spawnSync(process.execPath, childArgs, { encoding: 'utf8', timeout: 5_000 })
		assert.equal(child.status, 0, child.stderr)
		const lockFile = stateDirLockPath(stateDir)
		const original = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; token: string }
		assert.notEqual(original.pid, process.pid)
		assert.equal(fs.existsSync(path.join(stateDir, SEGMENTED_COMMIT_FENCE_FILE)), true)
		assert.throws(() => acquireStateDirLock(stateDir), /commit durability unknown/)
		assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), original, 'fenced dead lock is not reclaimed')
	})
})

test('B-1: a lock left by a dead process is reclaimed', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		const dead = spawnSync(process.execPath, ['-e', '0'])
		assert.equal(typeof dead.pid, 'number')
		fs.writeFileSync(stateDirLockPath(stateDir), `${JSON.stringify({ pid: dead.pid, token: 'stale-token' })}\n`)
		const lock = acquireStateDirLock(stateDir)
		assert.notEqual(lock.token, 'stale-token')
		lock.release()
	})
})

test('B-1: release removes only a lock this instance still owns', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		const lock = acquireStateDirLock(stateDir)
		fs.writeFileSync(stateDirLockPath(stateDir), `${JSON.stringify({ pid: process.pid, token: 'someone-else' })}\n`)
		lock.release()
		assert.equal(JSON.parse(fs.readFileSync(stateDirLockPath(stateDir), 'utf8')).token, 'someone-else')
		fs.rmSync(stateDirLockPath(stateDir))
	})
})

test('B-1: an unreadable lock body is refused (fail closed, never reclaimed)', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		fs.writeFileSync(stateDirLockPath(stateDir), 'not json')
		assert.throws(() => acquireStateDirLock(stateDir), /unreadable/)
		assert.equal(fs.readFileSync(stateDirLockPath(stateDir), 'utf8'), 'not json', 'the unknown lock is left in place')
		fs.rmSync(stateDirLockPath(stateDir))
	})
})

/**
 * Deterministic interleaving (from the independent review, lock-toctou.cjs). The winner reads the stale
 * token twice: once to find the dead holder, and once more, its "again" re-read. A racing reclaimer starts
 * right after that second read, before the winner's rm. The racer must be refused, and exactly one writer
 * may hold the lock afterwards. Without the reclaim file (mutant), the racer takes the lock and the winner's
 * rm deletes it, so two writers hold the lock. That is the failure this test catches.
 */
test('B-1 (TOCTOU): a racing reclaimer of the same stale lock is refused; exactly one writer holds the lock', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		const lockFile = stateDirLockPath(stateDir)
		fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 999999, token: 'STALE-TOKEN' })}\n`)
		const fsMut = fs as unknown as { readFileSync: (...args: unknown[]) => unknown }
		const origRead = fsMut.readFileSync.bind(fs) as (...args: unknown[]) => unknown
		let lockReads = 0
		const racer: { acquired: boolean; error: string } = { acquired: false, error: '' }
		const hook = (file: unknown, ...rest: unknown[]): unknown => {
			const text = origRead(file, ...rest)
			if (file === lockFile) {
				lockReads++
				if (lockReads === 2) {
					fsMut.readFileSync = origRead
					try {
						const r = acquireStateDirLock(stateDir)
						racer.acquired = true
						r.release()
					} catch (e) {
						racer.error = (e as Error).message
					} finally {
						fsMut.readFileSync = hook
					}
				}
			}
			return text
		}
		fsMut.readFileSync = hook
		let winner: ReturnType<typeof acquireStateDirLock>
		try {
			winner = acquireStateDirLock(stateDir)
		} finally {
			fsMut.readFileSync = origRead
		}
		try {
			assert.equal(lockReads >= 2, true, 'the race window was reached')
			assert.equal(racer.acquired, false, 'a racing reclaimer must not take the lock')
			assert.match(racer.error, /reclaim already in progress/)
			const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; token: string }
			assert.equal(holder.pid, process.pid)
			assert.notEqual(holder.token, 'STALE-TOKEN')
			assert.equal(fs.existsSync(`${lockFile}.reclaim`), false, 'the reclaim file is removed after the reclaim')
		} finally {
			winner.release()
		}
		assert.equal(fs.existsSync(lockFile), false)
	})
})

test('a fence created after the stale token re-read prevents reclaim from removing the old lock', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		fs.mkdirSync(stateDir)
		const lockFile = stateDirLockPath(stateDir)
		const fenceFile = path.join(stateDir, SEGMENTED_COMMIT_FENCE_FILE)
		const stale = { pid: 999999, token: 'STALE-TOKEN' }
		fs.writeFileSync(lockFile, `${JSON.stringify(stale)}\n`)
		const fsMut = fs as unknown as { readFileSync: (...args: unknown[]) => unknown }
		const origRead = fsMut.readFileSync.bind(fs) as (...args: unknown[]) => unknown
		let lockReads = 0
		fsMut.readFileSync = (file: unknown, ...rest: unknown[]): unknown => {
			const value = origRead(file, ...rest)
			if (file === lockFile && ++lockReads === 2) {
				fs.writeFileSync(fenceFile, 'synthetic durable-fence race\n')
			}
			return value
		}
		try {
			assert.throws(() => acquireStateDirLock(stateDir), /commit durability unknown/)
		} finally {
			fsMut.readFileSync = origRead
		}
		assert.equal(lockReads, 2, 'the fence was inserted immediately after the reclaim token re-read')
		assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), stale, 'the original lock is preserved')
		assert.equal(fs.existsSync(fenceFile), true)
		assert.equal(fs.existsSync(`${lockFile}.reclaim`), false)
	})
})

test('release retains the lock when the fence is unlinked but process-local durability is UNKNOWN', () => {
	withRoot((root) => {
		const stateDir = path.join(root, 'state.v2')
		fs.mkdirSync(stateDir)
		const fenceFile = path.join(stateDir, SEGMENTED_COMMIT_FENCE_FILE)
		const lock = acquireStateDirLock(stateDir)
		fs.writeFileSync(fenceFile, 'synthetic fence before failed parent fsync\n')
		assert.throws(() => assertSegmentedCommitFenceClear(stateDir), /commit durability unknown/)
		fs.rmSync(fenceFile)
		lock.release()
		assert.equal(fs.existsSync(lock.file), true, 'the in-memory UNKNOWN latch retains the lock without a marker')
	})
})
