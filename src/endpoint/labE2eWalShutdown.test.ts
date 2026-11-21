/**
 * P2c-3 on the REAL reporter in WAL mode against the simulated chain / signer:
 *  1. snapshots in the loop: with a 1 ms snapshot interval a snapshot runs after every tick; the result (signer requests, per-key payments, logical state) still equals the legacy golden;
 *  2. consumed prune: a seeded state with 10,300 consumed keys (cap 10,000) is pruned at snapshot/stop time, the oldest keys go to the cold archive in order, nothing else changes;
 *  3. archiveFailed is an operator-visible ALERT line from the daemon (archive directory blocked), the state stays complete and the daemon still exits 0;
 *  4. graceful stop with a tick that does not end: no downgrade snapshot, exit 1, ALERT, the log is kept; an old build refuses to start from it; a WAL restart resumes and pays exactly once.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ethers } from 'ethers'
import { assertNoWalEvents } from './labWalGuard'
import { consumedArchiveDir } from './labConsumedPrune'
import { FIXTURE_DIR, runScenario, type ScenarioResult } from './labE2e/harness.test'
import { eventKeyOf, headPlan, scenarios, seedValidators, seedWithdrawals } from './labE2e/scenarios.test'

const golden = (name: string): ScenarioResult & { logs: string[][] } => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.golden.json`), 'utf8'))
const noiseLine = (l: string): boolean => /^\[labMiningPoolClPayout\] (WAL mode:|WAL graceful stop:|snapshot committed)/.test(l)
const stripUpdatedAt = (v: unknown): unknown => {
	if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'updatedAt').map(([k, x]) => [k, stripUpdatedAt(x)]))
	return v
}

for (const name of ['s01_two_lines_pay', 's05_receipt_reverted', 's06_receipt_lost_then_restart', 's17_many_batches_two_lines']) {
	test(`WAL with a snapshot after every tick: ${name} equals the legacy golden`, { timeout: 300_000 }, async () => {
		const s = scenarios.find((x) => x.name === name)!
		const g = golden(name)
		const r = await runScenario({ ...s, env: { ...(s.env ?? {}), CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_SNAPSHOT_INTERVAL_MS: '1' } }, undefined, { walMode: true })
		assert.deepEqual(r.unknownRpcMethods, [])
		assert.deepEqual(r.signerRequests, g.signerRequests)
		assert.deepEqual(r.paymentsPerEventKey, g.paymentsPerEventKey)
		assert.deepEqual(r.logs.map((run) => run.filter((l) => !noiseLine(l))), g.logs)
		assert.ok(r.logs.flat().some((l) => /snapshot committed walSeq=/.test(l)), 'snapshots really ran in the loop')
		const gs = g.state as unknown as { scalars: unknown; pending: unknown[]; consumed: string[]; exited: string[] }
		assert.deepEqual(stripUpdatedAt(r.logical!.scalars), stripUpdatedAt(gs.scalars))
		assert.deepEqual(r.logical!.pending, gs.pending)
		assert.deepEqual(r.logical!.consumed, gs.consumed)
		assert.deepEqual(r.layout, { manifestVersion: 2, walSegments: 0 })
	})
}

test('WAL consumed prune (s12 shape): over the cap the oldest keys are archived in order and dropped at snapshot/stop time; everything else equals the legacy golden', { timeout: 300_000 }, async () => {
	const g = golden('s12_consumed_prune')
	const old = Array.from({ length: 10_300 }, (_, i) => ethers.keccak256(ethers.toUtf8Bytes(`old-${i}`)))
	let archived: string[] = []
	const r = await runScenario(
		{
			name: 's12_wal',
			env: { CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX: '10000', CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
			body: async (ctx) => {
				seedValidators(ctx)
				seedWithdrawals(ctx)
				headPlan(ctx, [120])
				ctx.seedState({ lastBackfillProcessedBlock: 99, freezeH: undefined, pending: [], consumedEventKeys: Object.fromEntries(old.map((k) => [k, true])), exitedPubkeys: {} })
				await ctx.run({ ticks: 1 })
				const dir = consumedArchiveDir(ctx.stateFile)
				for (const f of fs.readdirSync(dir).sort()) archived = archived.concat(fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string))
			},
		},
		undefined,
		{ walMode: true }
	)
	assert.deepEqual(r.signerRequests, g.signerRequests)
	assert.deepEqual(r.paymentsPerEventKey, g.paymentsPerEventKey)
	const gs = g.state as unknown as { scalars: unknown; pending: unknown[]; consumed: string[]; exited: string[] }
	assert.deepEqual(stripUpdatedAt(r.logical!.scalars), stripUpdatedAt(gs.scalars))
	assert.deepEqual(r.logical!.pending, gs.pending)
	// the legacy path prunes at its first write (10,300 -> 9,000) and then adds the 5 paid keys (9,005); WAL prunes when the snapshot is written, after those 5 were added (10,305 -> 9,000): both are
	// "oldest first, down to 90% of the cap", only the moment differs, so the final sets differ by exactly the 5 oldest survivors
	const fresh = gs.consumed.slice(-5)
	const expected = [...old, ...fresh].slice(-9000)
	assert.deepEqual(r.logical!.consumed, expected, 'the newest 9,000 keys remain, in insertion order')
	assert.deepEqual(archived, [...old, ...fresh].slice(0, 10_305 - 9000), 'the dropped keys, oldest first, are in the cold archive')
})

test('archiveFailed reaches the operator: with the archive directory blocked the daemon prints an ALERT, keeps every key, and still exits 0', { timeout: 300_000 }, async () => {
	const old = Array.from({ length: 10_300 }, (_, i) => ethers.keccak256(ethers.toUtf8Bytes(`old-${i}`)))
	const r = await runScenario(
		{
			name: 'archive_blocked',
			env: { CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX: '10000', CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10', CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_SNAPSHOT_INTERVAL_MS: '1' },
			body: async (ctx) => {
				seedValidators(ctx)
				seedWithdrawals(ctx)
				headPlan(ctx, [120, 124, 128])
				ctx.seedState({ lastBackfillProcessedBlock: 99, freezeH: undefined, pending: [], consumedEventKeys: Object.fromEntries(old.map((k) => [k, true])), exitedPubkeys: {} })
				fs.writeFileSync(consumedArchiveDir(ctx.stateFile), 'a regular file where the archive directory should be')
				await ctx.run({ ticks: 3 })
			},
		},
		undefined,
		{ walMode: true }
	)
	const lines = r.logs.flat()
	assert.ok(lines.some((l) => /ALERT consumed archive failed/.test(l)), `the alert is in the daemon output: ${JSON.stringify(lines.filter((l) => /snapshot|archive|WAL/.test(l)).slice(-6))}`)
	assert.equal(r.exits[0]!.code, 0)
	assert.ok(r.logical!.consumed.length >= 10_300, 'nothing was pruned (the keys stay while they cannot be archived)')
	for (const k of old) assert.ok(r.logical!.consumed.includes(k))
})

test('graceful stop while a tick does not end: no downgrade snapshot, exit 1, the log is kept (an old build refuses it), and a WAL restart resumes and pays every key exactly once', { timeout: 300_000 }, async () => {
	const expected = [[102, 0], [105, 0], [105, 1], [110, 0], [117, 0], [122, 0], [124, 0], [126, 0]].map(([b, i]) => eventKeyOf(b!, i!)).sort()
	let guardError = ''
	let layoutAfterStop: unknown
	const r = await runScenario(
		{
			name: 'stop_with_stuck_tick',
			env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10', E2E_SHUTDOWN_WAIT_MS: '400' },
			body: async (ctx) => {
				seedValidators(ctx)
				seedWithdrawals(ctx)
				headPlan(ctx, [120, 124, 128, 128, 128, 128])
				// the first receipt query is where the tick is stuck: SIGTERM arrives there, the receipt never comes
				let termSent = false
				ctx.chain.receiptRule = () => {
					if (!termSent) {
						termSent = true
						ctx.currentChild?.kill('SIGTERM')
					}
					return 'none'
				}
				await ctx.run({ ticks: 4 })
				layoutAfterStop = (await import('./labE2e/harness.test')).digestLayout(ctx.stateDir)
				try {
					assertNoWalEvents(ctx.stateDir)
				} catch (e) {
					guardError = (e as Error).message
				}
				ctx.chain.receiptRule = () => 'mined'
				await ctx.run({ ticks: 6 })
			},
		},
		undefined,
		{ walMode: true }
	)
	assert.equal(r.exits[0]!.code, 1, 'the first run ended with exit 1')
	assert.ok(r.logs[0]!.some((l) => /ALERT WAL graceful stop skipped: a tick was still running/.test(l)))
	assert.equal((layoutAfterStop as { manifestVersion: number }).manifestVersion, 3, 'no downgrade snapshot was written')
	assert.ok((layoutAfterStop as { walSegments: number }).walSegments > 0, 'the log is kept')
	assert.match(guardError, /refus/i, 'an old build (P1 guard) refuses to start from the kept log')
	assert.equal(r.exits[1]!.code, 0)
	assert.deepEqual(Object.keys(r.paymentsPerEventKey).sort(), expected)
	for (const [k, n] of Object.entries(r.paymentsPerEventKey)) assert.equal(n, 1, `event key ${k} paid ${n} times`)
	assert.equal(r.logical!.pending.length, 0)
})
