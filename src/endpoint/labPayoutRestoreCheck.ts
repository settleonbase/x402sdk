/**
 * Read-only restore check (runbook H3): what would the daemon recover from this state directory, without changing anything.
 *
 * It runs the same recovery as the daemon (committed snapshot + WAL replay) in `readOnly` mode: no torn-tail truncation, no removal of segments that lie inside the snapshot, no lock file, no
 * new file anywhere. To PROVE it wrote nothing it fingerprints the whole state directory tree (relative path, size, mtime in ns, and the sha256 of every file under wal/ and the manifest) before
 * and after, and fails (exit 3) when anything differs. Use it on a stopped daemon's state directory (a lock file next to it is reported as `lockPresent`).
 *
 * Usage: node labPayoutRestoreCheck.js --state-dir <dir>
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { recoverPayoutState } from './labPayoutRecovery'
import { WAL_DIR, WalMidCorruptionError, formatWalMidCorruptionAlert, listSegments } from './labWal'

export type RestoreReport = {
	stateDir: string
	lockPresent: boolean
	manifestVersion: 2 | 3
	snapshotSeq: number
	lastSeqInLog: number
	replayed: number
	tornTailBytes: number
	segments: number
	/** Segment files that lie entirely inside the snapshot: a real start would delete them (this check does not). */
	wouldCleanSegments: string[]
	pending: number
	consumed: number
	exited: number
	histTotal: number
	scalars: Record<string, unknown>
	inFlight: { batchId?: string; idempotencyKey?: string; line?: string; amountWei?: string; eventKeyCount?: number; hash?: string } | null
	warnings: string[]
	/** The next event seq a WAL-mode daemon would assign: max(snapshotSeq, lastSeqInLog) + 1. */
	nextEventSeq: number
	fingerprintBefore: string
	fingerprintAfter: string
	unchanged: boolean
}

/** Fingerprint of the whole tree: path, size, mtime (ns) of every entry; sha256 of the manifest and of every WAL file. Fast for the big generation files (no content hash there). */
export function treeFingerprint(root: string): string {
	const h = createHash('sha256')
	const walk = (dir: string, rel: string): void => {
		const names = fs.readdirSync(dir).sort()
		for (const n of names) {
			const p = path.join(dir, n)
			const r = path.join(rel, n)
			const st = fs.lstatSync(p, { bigint: true })
			h.update(`${r}\0${st.isDirectory() ? 'd' : 'f'}\0${st.size}\0${st.mtimeNs}\0`)
			if (st.isDirectory()) walk(p, r)
			else if (r === 'manifest.json' || r.startsWith(`${WAL_DIR}${path.sep}`)) h.update(fs.readFileSync(p))
		}
	}
	walk(root, '')
	return h.digest('hex')
}

export function restoreCheck(stateDir: string): RestoreReport {
	if (!stateDir) throw new Error('labPayoutRestoreCheck: a state directory is required')
	const before = treeFingerprint(stateDir)
	const lockPresent = fs.existsSync(`${stateDir}.lock`)
	const rec = recoverPayoutState(stateDir, { readOnly: true })
	const segs = listSegments(path.join(stateDir, WAL_DIR))
	const would: string[] = []
	for (let i = 0; i < segs.length; i++) {
		const lastInSeg = i + 1 < segs.length ? segs[i + 1]!.firstSeq - 1 : Math.max(rec.scan.lastSeq, segs[i]!.firstSeq - 1)
		if (lastInSeg <= rec.snapshotSeq) would.push(segs[i]!.file)
	}
	const core = rec.core
	const inflight = core.getInFlight()
	const scalars: Record<string, unknown> = {}
	for (const k of ['historyCursor', 'realtimeCursor', 'maxPaidHistoryBlock', 'settledBatchCount', 'lastListeningEndBlock', 'lastBackfillProcessedBlock']) scalars[k] = core.getScalar(k)
	scalars.freezeHeight = core.freezeHeight()
	const after = treeFingerprint(stateDir)
	return {
		stateDir: path.resolve(stateDir),
		lockPresent,
		manifestVersion: rec.manifestVersion,
		snapshotSeq: rec.snapshotSeq,
		lastSeqInLog: rec.scan.lastSeq,
		replayed: rec.replayed,
		tornTailBytes: rec.scan.truncatedBytes,
		segments: rec.scan.segments,
		wouldCleanSegments: would,
		pending: core.pendingSize,
		consumed: core.consumedSize,
		exited: core.exitedSize,
		histTotal: core.histTotal,
		scalars,
		inFlight: inflight
			? {
					batchId: typeof inflight.batchId === 'string' ? inflight.batchId : undefined,
					idempotencyKey: typeof inflight.idempotencyKey === 'string' ? inflight.idempotencyKey : undefined,
					line: typeof inflight.line === 'string' ? inflight.line : undefined,
					amountWei: typeof inflight.amountWei === 'string' ? inflight.amountWei : undefined,
					eventKeyCount: Array.isArray(inflight.eventKeys) ? inflight.eventKeys.length : undefined,
					hash: typeof inflight.hash === 'string' ? inflight.hash : undefined,
				}
			: null,
		warnings: rec.warnings,
		nextEventSeq: rec.writerLastSeq + 1,
		fingerprintBefore: before,
		fingerprintAfter: after,
		unchanged: before === after,
	}
}

if (require.main === module) {
	try {
		const i = process.argv.indexOf('--state-dir')
		const v = i >= 0 ? process.argv[i + 1] : undefined
		if (!v || v.startsWith('--') || process.argv.length !== 4) throw new Error('usage: --state-dir <dir> (no other arguments)')
		const r = restoreCheck(v)
		process.stdout.write(JSON.stringify(r, null, 2) + '\n')
		process.exit(r.unchanged ? 0 : 3)
	} catch (e) {
		if (e instanceof WalMidCorruptionError) {
			process.stderr.write(`${formatWalMidCorruptionAlert(e)}\n`)
			process.exit(2)
		}
		process.stderr.write(`labPayoutRestoreCheck: ${e instanceof Error ? e.message : String(e)}\n`)
		process.exit(2)
	}
}
