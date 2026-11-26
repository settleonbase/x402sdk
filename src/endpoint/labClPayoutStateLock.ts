/**
 * Single-writer lock for a Lab CL payout state directory (format v2).
 *
 * The lock is a sibling file "<stateDir>.lock", created with O_EXCL and holding {pid, token}.
 * It is outside the state dir on purpose: an extra entry inside the dir would make an empty
 * state look like an orphan. Only one process may hold it. A second process that finds a live
 * holder is refused. A lock left by a dead process is reclaimed. A lock with an unreadable body
 * is refused (fail closed). Node built-ins only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertSegmentedCommitFenceClear, SEGMENTED_COMMIT_FENCE_FILE } from './labClPayoutStateStore'

export type StateDirLock = {
	file: string
	stateDir: string
	token: string
	release: () => void
}

const held = new Map<string, StateDirLock>()
let exitHookInstalled = false

export function stateDirLockPath(stateDir: string): string {
	return `${stateDir}.lock`
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		// EPERM: the process exists but belongs to another user. Treat as alive.
		return (e as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** null when the file is absent. pid -1 when the body is unreadable (holder unknown). */
function readHolder(file: string): { pid: number; token: string } | null {
	let text: string
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw e
	}
	try {
		const raw = JSON.parse(text) as { pid?: unknown; token?: unknown }
		if (Number.isSafeInteger(raw.pid) && typeof raw.token === 'string' && raw.token.length > 0) {
			return { pid: raw.pid as number, token: raw.token }
		}
	} catch {
		/* fall through: unreadable body */
	}
	return { pid: -1, token: '' }
}

function commitFenceBlocksRelease(stateDir: string): boolean {
	try {
		assertSegmentedCommitFenceClear(stateDir)
		return false
	} catch {
		// This also observes the process-local UNKNOWN latch if the marker was unlinked
		// but the following directory fsync failed. Retain the lock on every uncertain result.
		return true
	}
}

function releaseIfOwner(file: string, token: string, stateDir: string): void {
	if (commitFenceBlocksRelease(stateDir)) return
	const holder = readHolder(file)
	if (holder && holder.token === token) {
		try {
			fs.rmSync(file, { force: true })
		} catch {
			/* best effort */
		}
	}
	held.delete(file)
}

function installExitHook(): void {
	if (exitHookInstalled) return
	exitHookInstalled = true
	process.once('exit', () => {
		for (const lock of [...held.values()]) lock.release()
	})
}

/**
 * Reclaim a lock whose holder is dead (B-1 TOCTOU fix, candidate, pre-launch gate).
 *
 * The token re-read and the rm run while holding a second O_EXCL file, "<lock>.reclaim". Without it,
 * a second process can reclaim the same stale lock and take a live lock between our re-read and our rm;
 * our rm then deletes that live lock and two writers run. The second reclaimer is refused here instead.
 * A reclaim file that already exists refuses the start. A reclaim file left by a crash is never removed
 * automatically: an operator removes it only after confirming that no writer is running.
 */
function reclaimStaleLock(file: string, stale: { pid: number; token: string }, stateDir: string): void {
	const reclaim = `${file}.reclaim`
	let fd: number
	try {
		fd = fs.openSync(reclaim, 'wx', 0o600)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new Error(
				`lab state lock reclaim already in progress or left behind: ${reclaim}; refusing to start. ` +
					'Remove it only after confirming no writer is running'
			)
		}
		throw e
	}
	try {
		const body = Buffer.from(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
		fs.writeSync(fd, body, 0, body.length, null)
	} catch (e) {
		try {
			fs.closeSync(fd)
		} catch {
			/* already closed */
		}
		fs.rmSync(reclaim, { force: true })
		throw e
	}
	fs.closeSync(fd)
	try {
		const again = readHolder(file)
		if (again && again.token === stale.token) {
			// The stale token may still be current while its writer records a durability fence.
			// Recheck immediately before removing the lock; a fence means preserve this lock.
			assertSegmentedCommitFenceClear(stateDir)
			try {
				fs.rmSync(file, { force: true })
			} catch {
				/* retried on the next attempt */
			}
		}
	} finally {
		try {
			fs.rmSync(reclaim, { force: true })
		} catch {
			/* left behind: the next start refuses, and an operator removes it */
		}
	}
}

/**
 * Take the writer lock for a state dir. Throws when another live process holds it, when this
 * process already holds it, or when the lock body is unreadable. Never waits.
 */
export function acquireStateDirLock(stateDir: string): StateDirLock {
	const file = stateDirLockPath(stateDir)
	// Refuse before inspecting/reclaiming a dead lock from an uncertain generation.
	assertSegmentedCommitFenceClear(stateDir)
	for (let attempt = 0; attempt < 3; attempt++) {
		assertSegmentedCommitFenceClear(stateDir)
		const token = randomBytes(12).toString('hex')
		try {
			const fd = fs.openSync(file, 'wx', 0o600)
			try {
				const body = Buffer.from(`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, 'utf8')
				let off = 0
				while (off < body.length) off += fs.writeSync(fd, body, off, body.length - off)
			} finally {
				fs.closeSync(fd)
			}
			const lock: StateDirLock = { file, stateDir, token, release: () => releaseIfOwner(file, token, stateDir) }
			held.set(file, lock)
			installExitHook()
			// A fence may appear between the initial check and successful lock creation.
			// Leave this lock held if it did; process exit also preserves it while fenced.
			assertSegmentedCommitFenceClear(stateDir)
			return lock
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
		}
		const holder = readHolder(file)
		if (holder === null) continue
		if (holder.pid === process.pid) {
			throw new Error(`lab state lock already held by this process: ${file}`)
		}
		if (holder.pid < 0) {
			throw new Error(
				`lab state lock file is unreadable: ${file}; refusing to start. Remove it only after confirming no writer is running`
			)
		}
		if (isProcessAlive(holder.pid)) {
			throw new Error(
				`lab state lock held by live pid ${holder.pid} (${file}); refusing to start a second writer on the same state dir`
			)
		}
		// Holder is dead. Reclaim only under the reclaim file, and only if the token is still the stale one.
		reclaimStaleLock(file, holder, stateDir)
	}
	throw new Error(`could not acquire lab state lock: ${file}`)
}
