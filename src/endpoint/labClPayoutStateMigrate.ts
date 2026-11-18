/**
 * Explicit one-shot migration: Lab CL payout legacy single-file state -> v2 segmented directory.
 *
 * Run only while the payout daemon is STOPPED. The daemon never migrates on its own.
 *
 *   node build/endpoint/labClPayoutStateMigrate.js --state-file <legacy.json>            # dry-run (default)
 *   node build/endpoint/labClPayoutStateMigrate.js --state-file <legacy.json> --apply    # write + verify + commit
 *
 * --state-file defaults to CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE, then
 * ~/.conet-lab-mining-pool-cl-payout-state.json. The v2 directory is "<base>.v2".
 * Output contains counts, hashes and paths only. No eventKey or pubkey values are printed.
 * The legacy file is only read. A verified copy goes to "<legacy>.legacy-<sha16>.json".
 */
import path from 'node:path'
import { homedir } from 'node:os'
import {
	dryRunLegacyMigration,
	migrateLegacyToSegmented,
	segmentedDirForLegacy,
} from './labClPayoutStateStore'
import { acquireStateDirLock } from './labClPayoutStateLock'

type CliArgs = {
	stateFile: string
	apply: boolean
	segmentSize?: number
}

function usage(): string {
	return [
		'usage: labClPayoutStateMigrate [--state-file <legacy.json>] [--dry-run | --apply] [--segment-size <n>]',
		'  default is --dry-run (read and verify only, no writes).',
	].join('\n')
}

export function parseArgs(argv: string[]): CliArgs {
	let stateFile: string | undefined
	let apply = false
	let dryRun = false
	let segmentSize: number | undefined
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--state-file') {
			stateFile = argv[++i]
		} else if (a.startsWith('--state-file=')) {
			stateFile = a.slice('--state-file='.length)
		} else if (a === '--apply') {
			apply = true
		} else if (a === '--dry-run') {
			dryRun = true
		} else if (a === '--segment-size') {
			segmentSize = Number(argv[++i])
		} else if (a === '--help' || a === '-h') {
			throw new Error(usage())
		} else {
			throw new Error(`unknown argument: ${a}\n${usage()}`)
		}
	}
	if (apply && dryRun) throw new Error(`use either --dry-run or --apply, not both\n${usage()}`)
	const resolved =
		stateFile?.trim() ||
		process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE?.trim() ||
		path.join(homedir(), '.conet-lab-mining-pool-cl-payout-state.json')
	if (segmentSize !== undefined && (!Number.isSafeInteger(segmentSize) || segmentSize < 1)) {
		throw new Error('--segment-size must be a positive integer')
	}
	return { stateFile: resolved, apply, segmentSize }
}

export function runMigration(args: CliArgs): unknown {
	const targetDir = segmentedDirForLegacy(args.stateFile)
	if (!args.apply) {
		return { mode: 'dry-run', ...dryRunLegacyMigration(args.stateFile, targetDir), written: false }
	}
	// Apply writes the v2 dir, so it takes the same single-writer lock as the daemon.
	const lock = acquireStateDirLock(targetDir)
	try {
		const result = migrateLegacyToSegmented(args.stateFile, targetDir, { segmentSize: args.segmentSize })
		return { mode: 'apply', ...result, written: true }
	} finally {
		lock.release()
	}
}

if (require.main === module) {
	try {
		const out = runMigration(parseArgs(process.argv.slice(2)))
		console.log(JSON.stringify(out, null, 2))
	} catch (e: unknown) {
		console.error(`[labClPayoutStateMigrate] ${e instanceof Error ? e.message : String(e)}`)
		process.exitCode = 1
	}
}
