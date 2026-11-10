import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Append-only transaction journal. A line is durable only after the file data is
 * fsync'd. A newly created file also fsyncs its directory so the name survives a crash.
 * A torn tail is discarded before the next line is added. Lines that do not parse are
 * ignored on read, which keeps journals written before request hashes existed.
 */
export function parseJournal(text: string): unknown[] {
	const records: unknown[] = []
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		try {
			records.push(JSON.parse(line) as unknown)
		} catch {
			/* torn or partial line */
		}
	}
	return records
}

export function appendDurableJournalLine(path: string, line: string): void {
	if (!line.endsWith('\n')) throw new Error('tx journal line must end with a newline')
	repairTornTail(path)
	const created = !existsSync(path)
	const fd = openSync(path, 'a', 0o640)
	try {
		writeAll(fd, Buffer.from(line, 'utf8'))
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	if (!created) return
	try {
		fsyncDirectory(dirname(path))
	} catch (err) {
		try { unlinkSync(path) } catch { /* the failed name must not become the next intent */ }
		const detail = err instanceof Error ? err.message : String(err)
		throw new Error(`tx journal directory sync failed: ${detail}`)
	}
}

function writeAll(fd: number, buf: Buffer): void {
	let offset = 0
	while (offset < buf.length) {
		const wrote = writeSync(fd, buf, offset)
		if (wrote <= 0) throw new Error('tx journal short write')
		offset += wrote
	}
}

/** Drop a trailing partial line so the next append cannot glue itself to it. */
function repairTornTail(path: string): void {
	if (!existsSync(path)) return
	const fd = openSync(path, 'r+')
	try {
		const size = fstatSync(fd).size
		if (size === 0) return
		const last = Buffer.alloc(1)
		readSync(fd, last, 0, 1, size - 1)
		if (last[0] === 0x0a) return
		let pos = size
		let newlineAt = -1
		while (pos > 0 && newlineAt < 0) {
			const n = Math.min(8192, pos)
			pos -= n
			const chunk = Buffer.alloc(n)
			readSync(fd, chunk, 0, n, pos)
			for (let i = n - 1; i >= 0; i--) {
				if (chunk[i] === 0x0a) {
					newlineAt = pos + i
					break
				}
			}
		}
		ftruncateSync(fd, newlineAt + 1)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
}

function fsyncDirectory(dir: string): void {
	const fd = openSync(dir, 'r')
	try {
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
}
