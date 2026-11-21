/**
 * P2c-0: end-to-end scenarios for the REAL Lab payout reporter against fake chain / beacon / signer services (see labE2e/fakeServers.test.ts).
 * Modes:  E2E_RECORD=1  writes labE2e/fixtures/<scenario>.golden.json (use only on the reference checkout: E2E_REPORTER_ROOT=<P1 HEAD worktree>);
 *         default       runs against E2E_REPORTER_ROOT (default: this checkout) and compares with the fixture, byte for byte after the documented normalization.
 * Slow group: set E2E=1 to run (default skipped in the normal lab suite).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIXTURE_DIR, canonicalResult, runScenario, type Scenario, type ScenarioResult, sha256 } from './labE2e/harness.test'
import { FakeChain } from './labE2e/fakeServers.test'
import { scenarios } from './labE2e/scenarios.test'

const enabled = process.env.E2E === '1' || process.env.E2E_RECORD === '1'
const record = process.env.E2E_RECORD === '1'

for (const s of scenarios) {
	test(`e2e ${s.name}`, { skip: enabled ? false : 'set E2E=1 to run the slow end-to-end group', timeout: 300_000 }, async () => {
		const r: ScenarioResult = await runScenario(s)
		assert.deepEqual(r.unknownRpcMethods, [], 'the fake chain served every RPC method the reporter used')
		const file = path.join(FIXTURE_DIR, `${s.name}.golden.json`)
		const text = JSON.stringify(JSON.parse(canonicalResult(r)), null, 2) + '\n'
		if (record) {
			fs.writeFileSync(file, text)
			process.stderr.write(`recorded ${file} sha256=${sha256(text)}\n`)
			return
		}
		assert.ok(fs.existsSync(file), `fixture ${file} exists (record it first)`)
		const golden = fs.readFileSync(file, 'utf8')
		if (text !== golden && process.env.E2E_ACTUAL_DIR) fs.writeFileSync(path.join(process.env.E2E_ACTUAL_DIR, `${s.name}.actual.json`), text)
		assert.equal(text, golden, `${s.name}: result equals the golden fixture`)
	})
}
void FakeChain
void ({} as Scenario)
