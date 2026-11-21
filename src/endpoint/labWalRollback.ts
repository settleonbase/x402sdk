/**
 * Offline rollback conversion (errata C6, P5 prerequisite): turns the state directory of a STOPPED WAL-mode daemon back into a plain version 2 state that an older build (P1 and df78e6b) can
 * start from, without starting the daemon. When the WAL daemon cannot start or must be given up, the P1 guard makes every older build refuse a directory that still has log events (on purpose);
 * this command is the way out.
 *
 * Steps (stop at the first failure, the log is only removed after everything else checked out):
 *   1. refuse unless: run id, approval reference, an audit directory outside the state dir; the state-directory lock (the daemon's) is taken; recovery is read-only and clean (no mid-log damage, no torn
 *      tail, no recovery warning). A directory that is already a plain version 2 state with no log is reported as "nothing to do".
 *   2. the audit is written FIRST (outside the state dir, exclusive create, fsync): what was found (snapshot seq, last seq, counts, the in-flight record) and what will be done.
 *   3. the version 2 downgrade snapshot of the recovered state is written and committed (gracefulStopToV2: no consumed prune, no archive - a faithful conversion), read back as version 2 naming the
 *      right walSeq, then the log segments are removed.
 *   4. verification against the state BEFORE: the recovered logical state of the converted directory (pending set, consumed keys in order, exited keys, scalars without the informational walSeq,
 *      the in-flight record) must be identical; the plain version 2 reader (what the old build uses) must read it; the P1 guard must pass. Then a .done.json is written.
 * The in-flight record, if any, is converted as it is: the older build resumes it with its own idempotent path. `--dry-run` reads and prints the plan and writes nothing (no lock).
 * The daemon does not reference this command and no environment variable can enable it.
 *
 * Usage: node labWalRollback.js --state-dir <dir> --audit-dir <dir outside> --run-id <id> --approval <ref> [--dry-run]
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { acquireStateDirLock } from './labClPayoutStateLock'
import { canonicalJson, readManifest, readSegmentedState } from './labClPayoutStateStore'
import { gracefulStopToV2, recoverPayoutState } from './labPayoutRecovery'
import type { LabPayoutStateCore } from './labPayoutStateCore'
import { WAL_DIR, WalMidCorruptionError, WalWriter, listSegments } from './labWal'
import { assertNoWalEvents } from './labWalGuard'
import { RUN_ID_RE, assertAuditDirOutside } from './labWalRepair'

export type RollbackHooks = {
	/** Test hook after the audit is written and before anything in the state dir changes. */
	beforeConvert?: () => void
	/** Test hook between the verified version 2 manifest and the removal of the log segments (throw to simulate the crash there). */
	beforeRemoveSegments?: () => void
	/** Test hook after the log is removed and before the verification (tamper with the converted directory to prove the verification can fail). */
	beforeVerify?: () => void
	/** Test seam: the plain version 2 reader used for the read-back (default readSegmentedState). A test returns a valid-looking but different state to prove the comparison, not the store's own checksum, catches it. */
	plainReader?: (stateDir: string) => unknown
}

export type RollbackOptions = {
	stateDir: string
	auditDir: string
	runId: string
	approval: string
	dryRun?: boolean
	now?: () => Date
	hooks?: RollbackHooks
}

export type RollbackAudit = {
	runId: string
	approval: string
	approvalVerified: false
	approvalNote: string
	at: string
	dryRun: boolean
	stateDir: string
	manifestVersionBefore: number
	snapshotWalSeq: number
	lastSeqBefore: number
	replayedEvents: number
	logSegments: number
	counts: { pending: number; consumed: number; exited: number }
	inFlight: { present: boolean; idempotencyKey?: string; hash?: string; eventKeyCount?: number }
	plan: string
}

export type RollbackResult =
	| { status: 'nothing-to-do'; reason: string }
	| { status: 'dry-run'; audit: RollbackAudit }
	| { status: 'converted'; audit: RollbackAudit; auditFile: string; doneFile: string; walSeq: number; removedSegments: number; checks: Record<string, boolean | string | number> }

/** What an old build must see after the conversion, in one canonical string. `walSeq` is informational in a version 2 manifest and left out. */
export function logicalDigest(core: LabPayoutStateCore): string {
	const scalars = core.scalarsCopy()
	delete scalars.walSeq
	return canonicalJson({
		scalars,
		inFlight: core.getInFlight(),
		pending: [...core.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: [...core.consumedKeys()],
		exited: [...core.exited.keys()].sort(),
	})
}

export async function rollbackToV2(opts: RollbackOptions): Promise<RollbackResult> {
	if (!opts.runId || !RUN_ID_RE.test(opts.runId)) throw new Error('labWalRollback: a run id is required (letters, digits, . _ -, 8 to 64 characters)')
	if (!opts.approval || opts.approval.trim().length < 3) throw new Error('labWalRollback: the approval reference (the written release) is required')
	if (!opts.stateDir) throw new Error('labWalRollback: a state directory is required')
	if (!opts.auditDir) throw new Error('labWalRollback: an audit directory is required')
	assertAuditDirOutside(opts.stateDir, opts.auditDir)
	let lock: { release: () => void } | null = null
	if (!opts.dryRun) {
		try {
			lock = acquireStateDirLock(opts.stateDir)
		} catch (e) {
			throw new Error(`labWalRollback: cannot take the state directory lock (${e instanceof Error ? e.message : String(e)}); stop the daemon first. Nothing was changed`)
		}
	}
	try {
		return await rollbackLocked(opts)
	} finally {
		lock?.release()
	}
}

async function rollbackLocked(opts: RollbackOptions): Promise<RollbackResult> {
	const now = opts.now ?? (() => new Date())
	let manifest
	try {
		manifest = readManifest(opts.stateDir)
	} catch (e) {
		throw new Error(`labWalRollback: no committed manifest in ${opts.stateDir} (${e instanceof Error ? e.message : String(e)}). Nothing was changed`)
	}
	const walDir = path.join(opts.stateDir, WAL_DIR)
	const segs = listSegments(walDir)
	if (manifest.version === 2 && segs.length === 0) return { status: 'nothing-to-do', reason: 'the state is already a plain version 2 state with no log; an older build can start from it' }

	let rec
	try {
		rec = recoverPayoutState(opts.stateDir, { readOnly: true })
	} catch (e) {
		if (e instanceof WalMidCorruptionError) throw new Error('labWalRollback: the log has damage in the middle; run the audited repair first. Nothing was changed')
		throw e
	}
	if (rec.scan.truncatedBytes > 0) throw new Error(`labWalRollback: the log ends in a torn tail (${rec.scan.truncatedBytes} bytes); repair first. Nothing was changed`)
	if (rec.warnings.length > 0) throw new Error(`labWalRollback: recovery reported warnings (${rec.warnings.join('; ')}); resolve them first. Nothing was changed`)
	const core = rec.core
	const before = logicalDigest(core)
	const inFlight = core.getInFlight() as Record<string, unknown> | null
	const audit: RollbackAudit = {
		runId: opts.runId,
		approval: opts.approval,
		approvalVerified: false,
		approvalNote: 'The approval reference is a plain string. This command cannot verify it technically; the receipt must say so and the written release must be kept by the PM.',
		at: now().toISOString(),
		dryRun: opts.dryRun === true,
		stateDir: path.resolve(opts.stateDir),
		manifestVersionBefore: manifest.version,
		snapshotWalSeq: rec.snapshotSeq,
		lastSeqBefore: rec.writerLastSeq,
		replayedEvents: rec.replayed,
		logSegments: segs.length,
		counts: { pending: core.pendingSize, consumed: core.consumedSize, exited: core.exitedSize },
		inFlight: inFlight
			? { present: true, idempotencyKey: typeof inFlight.idempotencyKey === 'string' ? inFlight.idempotencyKey : undefined, hash: typeof inFlight.hash === 'string' ? inFlight.hash : undefined, eventKeyCount: Array.isArray(inFlight.eventKeys) ? inFlight.eventKeys.length : undefined }
			: { present: false },
		plan: `Write a version 2 snapshot of the recovered state at walSeq ${rec.writerLastSeq} (no prune), read it back, remove ${segs.length} log segment(s), then compare the logical state before and after.${inFlight ? ' The in-flight record is converted as it is; the older build resumes it with its own idempotent path.' : ''}`,
	}
	if (opts.dryRun) return { status: 'dry-run', audit }

	fs.mkdirSync(opts.auditDir, { recursive: true, mode: 0o700 })
	const writeExclusive = (name: string, data: string): string => {
		const file = path.join(opts.auditDir, name)
		const fd = fs.openSync(file, 'wx', 0o600)
		try {
			const b = Buffer.from(data, 'utf8')
			let off = 0
			while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off)
			fs.fsyncSync(fd)
		} finally {
			fs.closeSync(fd)
		}
		return file
	}
	const auditName = `wal-rollback-${opts.runId}.json`
	if (fs.existsSync(path.join(opts.auditDir, auditName))) throw new Error(`labWalRollback: run id ${opts.runId} was already used (audit file exists); use a new run id. Nothing was changed`)
	const auditFile = writeExclusive(auditName, JSON.stringify(audit, null, 2) + '\n')
	const dfd = fs.openSync(opts.auditDir, 'r')
	try {
		fs.fsyncSync(dfd)
	} finally {
		fs.closeSync(dfd)
	}
	opts.hooks?.beforeConvert?.()
	assertAuditDirOutside(opts.stateDir, opts.auditDir)

	const wal = new WalWriter({ stateDir: opts.stateDir, lastSeq: rec.writerLastSeq, onFatal: (e) => { throw e } })
	const stop = await gracefulStopToV2(core, wal, opts.stateDir, { beforeRemoveSegments: opts.hooks?.beforeRemoveSegments })

	opts.hooks?.beforeVerify?.()
	// verification against the state before
	const checks: Record<string, boolean | string | number> = {}
	const after = recoverPayoutState(opts.stateDir, { readOnly: true })
	checks.manifestVersion = readManifest(opts.stateDir).version
	checks.logSegmentsLeft = listSegments(walDir).length
	checks.logicalStateIdentical = logicalDigest(after.core) === before
	// K2: what an older build reads with the PLAIN version 2 reader must equal the recovered state in full, not just in count: the pending key set, the consumed keys IN ORDER, the exited keys,
	// the in-flight record as a whole, and every pending entry
	let plainReaderOk = false
	try {
		const plain = (opts.hooks?.plainReader ?? readSegmentedState)(opts.stateDir) as { pending?: ({ eventKey: string } & Record<string, unknown>)[]; consumedEventKeys?: Record<string, true>; exitedPubkeys?: Record<string, true>; inFlightWithdraw?: unknown }
		const pendingNow = [...core.pendingEntries()].map((e) => e.eventKey).sort()
		const plainPending = (plain.pending ?? []).map((e) => e.eventKey).sort()
		const plainConsumed = Object.keys(plain.consumedEventKeys ?? {})
		const plainExited = Object.keys(plain.exitedPubkeys ?? {}).sort()
		checks.plainPendingKeysEqual = canonicalJson(plainPending) === canonicalJson(pendingNow)
		checks.plainConsumedOrderEqual = canonicalJson(plainConsumed) === canonicalJson([...core.consumedKeys()])
		checks.plainExitedEqual = canonicalJson(plainExited) === canonicalJson([...core.exited.keys()].sort())
		checks.plainInFlightEqual = canonicalJson(plain.inFlightWithdraw ?? null) === canonicalJson(core.getInFlight())
		const entriesNow = new Map([...core.pendingEntries()].map((e) => [e.eventKey, canonicalJson({ ...e })]))
		checks.plainPendingEntriesEqual = (plain.pending ?? []).every((e) => entriesNow.get(e.eventKey) === canonicalJson({ ...e }))
		checks.plainReaderConsumed = plainConsumed.length
		plainReaderOk = checks.plainPendingKeysEqual === true && checks.plainConsumedOrderEqual === true && checks.plainExitedEqual === true && checks.plainInFlightEqual === true && checks.plainPendingEntriesEqual === true
	} catch (e) {
		checks.plainReaderError = e instanceof Error ? e.message : String(e)
	}
	checks.plainReaderOk = plainReaderOk
	let guard = ''
	try {
		guard = assertNoWalEvents(opts.stateDir)
	} catch (e) {
		guard = `refused: ${e instanceof Error ? e.message : String(e)}`
	}
	checks.p1GuardStatus = guard
	const ok = checks.manifestVersion === 2 && checks.logSegmentsLeft === 0 && checks.logicalStateIdentical === true && plainReaderOk && (guard === 'absent' || guard === 'empty') && checks.plainReaderConsumed === core.consumedSize
	if (!ok) throw new Error(`labWalRollback: the converted directory did not verify (${JSON.stringify(checks)}); the audit is at ${auditFile}. Do not start any build before checking it`)
	const done = { runId: opts.runId, walSeq: stop.walSeq, removedSegments: stop.removedSegments, checks, logicalStateSha256: createHash('sha256').update(before).digest('hex') }
	const doneFile = writeExclusive(`wal-rollback-${opts.runId}.done.json`, JSON.stringify(done, null, 2) + '\n')
	return { status: 'converted', audit, auditFile, doneFile, walSeq: stop.walSeq, removedSegments: stop.removedSegments, checks }
}

if (require.main === module) {
	// Arguments only: no environment variable is read, so no standing setting can enable this.
	void (async () => {
		try {
			const argv = process.argv.slice(2)
			const valueFlags = ['--state-dir', '--audit-dir', '--run-id', '--approval']
			const values: Record<string, string> = {}
			let dryRun = false
			for (let i = 0; i < argv.length; i++) {
				const a = argv[i]!
				if (a === '--dry-run') dryRun = true
				else if (valueFlags.includes(a)) {
					const v = argv[i + 1]
					if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value (got ${v === undefined ? 'nothing' : `"${v}"`})`)
					if (a in values) throw new Error(`${a} given twice`)
					values[a] = v
					i++
				} else throw new Error(`unknown argument "${a}"`)
			}
			const r = await rollbackToV2({ stateDir: values['--state-dir'] ?? '', auditDir: values['--audit-dir'] ?? '', runId: values['--run-id'] ?? '', approval: values['--approval'] ?? '', dryRun })
			process.stdout.write(JSON.stringify(r, null, 2) + '\n')
			process.exit(0)
		} catch (e) {
			process.stderr.write(`labWalRollback: ${e instanceof Error ? e.message : String(e)}\n`)
			process.exit(2)
		}
	})()
}
