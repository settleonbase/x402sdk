import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { beaconHttpIsUnconfirmed, cursorIfBlockConfirmed } from './clPaidKeyGate'

const NON_2XX = [100, 199, 301, 302, 400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504]

test('definite beacon non-2xx is unconfirmed and 200 is a completed read', () => {
	for (const status of NON_2XX) {
		assert.equal(beaconHttpIsUnconfirmed(status), true, `status ${status}`)
	}
	assert.equal(beaconHttpIsUnconfirmed(200), false)
	assert.equal(beaconHttpIsUnconfirmed(204), false)
	assert.equal(beaconHttpIsUnconfirmed(Number.NaN), true)
})

test('a beacon fault does not move the cursor past the last confirmed block', () => {
	assert.equal(cursorIfBlockConfirmed(2010028, 2010029, false), 2010028)
	assert.equal(cursorIfBlockConfirmed(null, 2010029, false), null)
	assert.equal(cursorIfBlockConfirmed(2010028, 2010029, true), 2010029)
})

test('fetchValidatorByIndex throws on every non-2xx and does not cache a null pubkey', () => {
	const src = readFileSync(
		path.join(process.env.LAB_SRC_DIR || __dirname, 'validatorLabMiningPoolClPayoutReporter.ts'),
		'utf8'
	)
	const start = src.indexOf('async function fetchValidatorByIndex')
	const end = src.indexOf('async function fetchBlockWithWithdrawals')
	assert.ok(start >= 0 && end > start)
	const fn = src.slice(start, end)
	const branch = fn.slice(fn.indexOf('if (!res.ok'), fn.indexOf('const json'))
	assert.match(branch, /beaconHttpIsUnconfirmed\(res\.status\)/)
	assert.match(branch, /beacon HTTP \$\{res\.status\}/)
	assert.equal(branch.includes('validatorPubkeyCache.set'), false)
	assert.equal(branch.includes('return { pubkey: null, status: null }'), false)
	assert.match(src, /throw new PaidKeyViewUnconfirmed/)
})
