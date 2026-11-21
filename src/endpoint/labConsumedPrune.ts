/**
 * Soft cap for the persisted consumed set: prune with hysteresis and archive what is dropped.
 *
 * Why dropping old consumed keys is safe (and where the safety really comes from):
 *  - consumedEventKeys only guards against a scan cursor going backwards and re-queueing a key that was already paid.
 *    Both cursors only move forward (assertCursorMonotonic, cursorHighWater) and are persisted together with the pending pool.
 *  - A key that is still pending is never dropped (planPrune skips it).
 *  - An in-flight batch lives in its own record (inFlightWithdraw and its inflight/<id> key file), not in consumed.
 *  - The state store keeps only the current and the previous generation.
 * Dropped keys are appended to a cold archive (never read back, never deleted by the daemon), so the audit trail stays complete.
 */
import fs from 'node:fs'
import path from 'node:path'

export const CONSUMED_PRUNE_TARGET_RATIO = 0.9

/**
 * Keys to drop once the map exceeds `cap`: the oldest in insertion order, skipping pending keys, until the size is
 * floor(cap * ratio). Returns [] while the map is within the cap (hysteresis: no pruning on every write).
 */
export function planPrune(
	keysInInsertionOrder: string[],
	pendingKeysLower: Set<string>,
	cap: number,
	ratio: number = CONSUMED_PRUNE_TARGET_RATIO
): string[] {
	if (keysInInsertionOrder.length <= cap) return []
	const target = Math.max(0, Math.floor(cap * ratio))
	const excess = keysInInsertionOrder.length - target
	const out: string[] = []
	for (const k of keysInInsertionOrder) {
		if (out.length >= excess) break
		if (pendingKeysLower.has(k.toLowerCase())) continue
		out.push(k)
	}
	return out
}

/** `<state file without .json>.consumed-archive`, next to the v2 directory (outside it, so no state check or generation prune can touch it). */
export function consumedArchiveDir(stateFile: string): string {
	return `${stateFile.replace(/\.json$/i, '')}.consumed-archive`
}

/** Append the dropped keys, one JSON string per line, to the archive file of the current UTC day. Throws on any failure. */
export function appendConsumedArchive(archiveDir: string, keys: string[], now: Date = new Date()): string {
	if (!keys.length) return ''
	fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
	const day = now.toISOString().slice(0, 10).replace(/-/g, '')
	const file = path.join(archiveDir, `consumed-${day}.jsonl`)
	const fd = fs.openSync(file, 'a', 0o600)
	try {
		let buf = ''
		for (const k of keys) {
			buf += `${JSON.stringify(k)}\n`
			if (buf.length >= 1 << 20) {
				fs.writeSync(fd, buf)
				buf = ''
			}
		}
		if (buf) fs.writeSync(fd, buf)
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
	return file
}
