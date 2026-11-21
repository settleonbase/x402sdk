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

test('C5 finding: the lock file is never half-written - a crash between writing the body and publishing it leaves NO lock (the next start succeeds); a stale temp file of a dead pid is cleaned up, a live one is left', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsl-'))
	const stateDir = path.join(dir, 'state.v2')
	const realLink = fs.linkSync
	try {
		;(fs as unknown as { linkSync: unknown }).linkSync = () => {
			throw Object.assign(new Error('simulated crash before the lock is published'), { code: 'EIO' })
		}
		assert.throws(() => acquireStateDirLock(stateDir), /simulated crash/)
	} finally {
		;(fs as unknown as { linkSync: unknown }).linkSync = realLink
	}
	const lockFile = stateDirLockPath(stateDir)
	assert.equal(fs.existsSync(lockFile), false, 'no (empty or partial) lock file exists after the interrupted acquire')
	// a temp file left by a killed process: removed (dead pid 2147483000); one of a live pid (this process's parent) is left alone
	const stale = `${lockFile}.tmp.2147483000.abcdef`
	const live = `${lockFile}.tmp.${process.ppid}.abcdef`
	fs.writeFileSync(stale, '')
	fs.writeFileSync(live, '')
	const lock = acquireStateDirLock(stateDir)
	try {
		assert.equal(fs.existsSync(stale), false, 'stale temp file removed')
		assert.equal(fs.existsSync(live), true, 'a temp file of a live pid is not touched')
		const body = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
		assert.equal(body.pid, process.pid)
		assert.equal(typeof body.token, 'string')
		assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp.' + process.pid + '.')).length, 0, 'this acquire left no temp file behind')
	} finally {
		lock.release()
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
