import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

export type QuoteLock = {
	acquired: true
	release: () => void
}

function holderAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return true
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== 'ESRCH'
	}
}

function reclaimIfDead(lockPath: string): boolean {
	let text: string
	try {
		text = readFileSync(lockPath, 'utf8').trim()
	} catch {
		return false
	}
	const pid = Number(text)
	if (holderAlive(pid)) return false
	try {
		unlinkSync(lockPath)
		return true
	} catch {
		return false
	}
}

/**
 * Exclusive lock for one quote attempt. A live holder makes the second
 * attempt leave without sending. A dead pid may be reclaimed once.
 */
export function acquireQuoteLock(lockPath: string): QuoteLock | { acquired: false } {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath, 'wx', 0o600)
			writeSync(fd, `${process.pid}\n`)
			return {
				acquired: true,
				release: () => {
					try {
						closeSync(fd)
					} catch {
						/* already closed */
					}
					try {
						if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath)
					} catch {
						/* another owner, or already removed */
					}
				},
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
			if (attempt === 0 && reclaimIfDead(lockPath)) continue
			return { acquired: false }
		}
	}
	return { acquired: false }
}
