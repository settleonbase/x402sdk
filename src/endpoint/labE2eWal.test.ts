/**
 * P2c-2: the same end-to-end scenarios with the reporter in WAL mode (CONET_LAB_MINING_POOL_CL_PAYOUT_WAL=1), compared with the LEGACY golden results (recorded on the P1 HEAD).
 * The comparison is on LOGICAL state (the daemon's recovered pending set, consumed keys in order, exited keys, scalars), the signer's request sequence, the per-event-key payments and the key
 * log lines - not on file digests (a log has no pending/consumed files). Documented differences, nothing else is relaxed:
 *   - s12_consumed_prune is excluded: the consumed prune happens at SNAPSHOT time in WAL mode (P2c-3), the legacy path prunes on every write;
 *   - the line "WAL mode: snapshotSeq=..." is added at each start and removed before comparing;
 *   - the state scalar `updatedAt` is not kept in WAL mode (the snapshot writer does not record it).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIXTURE_DIR, runScenario, type ScenarioResult } from './labE2e/harness.test'
import { scenarios } from './labE2e/scenarios.test'

const EXCLUDED = new Set(['s12_consumed_prune'])
const dropWalLines = (logs: string[][]): string[][] => logs.map((run) => run.filter((l) => !l.startsWith('[labMiningPoolClPayout] WAL mode:')))
const stripUpdatedAt = (v: unknown): unknown => {
	if (v && typeof v === 'object' && !Array.isArray(v)) {
		const o: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'updatedAt') o[k] = stripUpdatedAt(x)
		return o
	}
	return v
}

for (const s of scenarios) {
	if (EXCLUDED.has(s.name)) continue
	test(`e2e WAL mode ${s.name}: logical state, signer requests, per-event-key payments and key log lines equal the legacy golden`, { timeout: 300_000 }, async () => {
		const golden = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${s.name}.golden.json`), 'utf8')) as ScenarioResult & { logs: string[][] }
		const r = await runScenario(s, undefined, { walMode: true })
		delete r.rpcLog
		assert.deepEqual(r.unknownRpcMethods, [])
		assert.deepEqual(r.strayOutput, [])
		assert.deepEqual(r.signerRequests, golden.signerRequests, 'the signer received the same requests in the same order')
		assert.deepEqual(r.paymentsPerEventKey, golden.paymentsPerEventKey, 'every event key paid exactly as many times as in the legacy run (at most once)')
		assert.deepEqual(r.chainSent, golden.chainSent)
		assert.deepEqual(r.exits, golden.exits)
		assert.deepEqual(dropWalLines(r.logs), golden.logs, 'the reporter logged the same key lines')
		const g = golden.state as unknown as { scalars: unknown; pending: unknown[]; consumed: string[]; exited: string[] }
		assert.ok(r.logical, 'a recovered state exists')
		assert.deepEqual(stripUpdatedAt(r.logical!.scalars), stripUpdatedAt(g.scalars), 'scalars')
		assert.deepEqual(r.logical!.pending, g.pending, 'pending set')
		assert.deepEqual(r.logical!.consumed, g.consumed, 'consumed keys in insertion order')
		assert.deepEqual(r.logical!.exited, g.exited)
	})
}
