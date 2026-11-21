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

export type StateDirLock = {
	file: string
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

function releaseIfOwner(file: string, token: string): void {
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
function reclaimStaleLock(file: string, stale: { pid: number; token: string }): void {
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

/** Temp files of an acquire that was killed before it published its lock (names `<lock>.tmp.<pid>.<token>`): removed when their pid is dead. Best effort, never throws. */
function removeStaleTempFiles(file: string): void {
	try {
		const dir = path.dirname(file)
		const prefix = `${path.basename(file)}.tmp.`
		for (const name of fs.readdirSync(dir)) {
			if (!name.startsWith(prefix)) continue
			const pid = Number(name.slice(prefix.length).split('.')[0])
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isProcessAlive(pid)) fs.rmSync(path.join(dir, name), { force: true })
		}
	} catch {
		/* a leftover temp file is harmless */
	}
}

/**
 * Take the writer lock for a state dir. Throws when another live process holds it, when this
 * process already holds it, or when the lock body is unreadable. Never waits.
 */
export function acquireStateDirLock(stateDir: string): StateDirLock {
	const file = stateDirLockPath(stateDir)
	removeStaleTempFiles(file)
	for (let attempt = 0; attempt < 3; attempt++) {
		const token = randomBytes(12).toString('hex')
		// The lock file must never be observable half-written (found by the C5 random kill test: a kill -9 between the exclusive create and the write left an EMPTY lock file, which every later start
		// refuses as "unreadable" until an operator removes it). So the body is written and fsynced into a private temp file first and then published with link(), which is atomic and fails with
		// EEXIST exactly like the exclusive create did. A crash before the link leaves only the temp file (no lock); one after it leaves a complete lock.
		const tmp = `${file}.tmp.${process.pid}.${token}`
		try {
			const fd = fs.openSync(tmp, 'wx', 0o600)
			try {
				const body = Buffer.from(`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, 'utf8')
				let off = 0
				while (off < body.length) off += fs.writeSync(fd, body, off, body.length - off)
				fs.fsyncSync(fd)
			} finally {
				fs.closeSync(fd)
			}
			try {
				fs.linkSync(tmp, file)
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code
				if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EPERM' || code === 'EXDEV' || code === 'ENOSYS' || code === 'EMLINK') {
					throw new Error(`lab state lock: link() failed with ${code} (${(e as Error).message}); the file system of the state directory must support hard links (the lock is published atomically with link())`)
				}
				throw e
			}
			const lock: StateDirLock = { file, token, release: () => releaseIfOwner(file, token) }
			held.set(file, lock)
			installExitHook()
			return lock
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
		} finally {
			// whatever failed above (open, write, fsync, link), this process's temp file does not outlive the attempt (already gone after a successful link)
			fs.rmSync(tmp, { force: true })
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
		reclaimStaleLock(file, holder)
	}
	throw new Error(`could not acquire lab state lock: ${file}`)
}
