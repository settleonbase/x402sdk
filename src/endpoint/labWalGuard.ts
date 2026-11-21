/**
 * Forward-compatibility guard for the planned write-ahead log (P2, PLAN-lab-signing-pools-BASELINE rev2 §3 P2 and the P2 design).
 *
 * A build that does not know the WAL would read only the snapshot and silently ignore events that were written to `wal/` but never
 * merged into a snapshot. So this build refuses to start while `<stateDir>/wal/` holds anything: the operator must first stop the newer
 * build gracefully (final snapshot, WAL emptied) and check that `wal/` is empty. With `wal/` absent or an empty directory the behaviour is
 * exactly that of df78e6b. The guard is always on; it is not behind a flag.
 *
 * Node built-ins only.
 */
import fs from 'node:fs'
import path from 'node:path'

export const WAL_DIR_NAME = 'wal'

export type WalGuardStatus = 'absent' | 'empty'

/** Throws when `<stateDir>/wal` exists and is not an empty directory. Returns 'absent' or 'empty' otherwise. */
export function assertNoWalEvents(stateDir: string): WalGuardStatus {
	const walDir = path.join(stateDir, WAL_DIR_NAME)
	let st: fs.Stats
	try {
		st = fs.lstatSync(walDir)
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent'
		throw new Error(`[labMiningPoolClPayout] cannot inspect ${walDir}: ${e instanceof Error ? e.message : String(e)}; refusing to start (unknown WAL state)`)
	}
	if (!st.isDirectory()) {
		throw new Error(`[labMiningPoolClPayout] ${walDir} exists and is not a directory; refusing to start (unknown WAL state)`)
	}
	let names: string[]
	try {
		names = fs.readdirSync(walDir)
	} catch (e: unknown) {
		throw new Error(`[labMiningPoolClPayout] cannot read ${walDir}: ${e instanceof Error ? e.message : String(e)}; refusing to start (unknown WAL state)`)
	}
	if (names.length > 0) {
		throw new Error(
			`[labMiningPoolClPayout] ${walDir} is not empty (${names.length} entr${names.length === 1 ? 'y' : 'ies'}): this build does not read the write-ahead log and would silently ignore its events. ` +
				'Refusing to start. Stop the newer build gracefully (final snapshot, WAL emptied), check that wal/ is empty, then start this build.'
		)
	}
	return 'empty'
}
