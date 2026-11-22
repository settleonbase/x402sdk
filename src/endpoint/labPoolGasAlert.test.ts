/** G1-G4: the per-wallet gas-shortage alarm (labPoolGasAlert.ts): N=3 failed passes in a row, or an error that reads like a balance shortage at once; at most one line per minute; ok resets; it only reports. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GasAlertTracker, INSUFFICIENT_RE } from './labPoolGasAlert'

test('G1: three failed sends in a row alert (the first two do not); a good send resets the streak', () => {
	const t = new GasAlertTracker()
	assert.equal(t.onSendFailure('upstream hiccup', 0), undefined)
	assert.equal(t.onSendFailure('upstream hiccup', 1000), undefined)
	const a = t.onSendFailure('upstream hiccup', 2000)
	assert.ok(a && !a.shortage && /3 pass/.test(a.text))
	t.onOk()
	assert.equal(t.streak, 0)
	assert.equal(t.onSendFailure('upstream hiccup', 3_000_000), undefined, 'after a reset the count starts again')
	assert.equal(t.onSendFailure('upstream hiccup', 3_001_000), undefined)
	assert.ok(t.onSendFailure('upstream hiccup', 3_002_000))
})

test('G2: an error that reads like a balance shortage alerts at the FIRST failure', () => {
	for (const m of ['insufficient funds for gas * price + value', 'Insufficient balance', 'gas required exceeds allowance', 'not enough gas', 'sender exceeds balance', 'lack of funds', 'insufficient native token']) {
		const t = new GasAlertTracker()
		const a = t.onSendFailure(m, 0)
		assert.ok(a && a.shortage, m)
	}
	for (const m of ['upstream hiccup', 'POLICY_DENIED: rejected', 'signer socket timed out', 'ECONNREFUSED'])
		assert.ok(!INSUFFICIENT_RE.test(m), m)
})

test('G3: at most one alert per minute per wallet; it speaks again after the minute', () => {
	const t = new GasAlertTracker()
	assert.ok(t.onSendFailure('insufficient funds', 0))
	assert.equal(t.onSendFailure('insufficient funds', 10_000), undefined)
	assert.equal(t.onSendFailure('insufficient funds', 59_999), undefined)
	assert.ok(t.onSendFailure('insufficient funds', 60_000))
})

test('G4: trackers are independent per wallet', () => {
	const a = new GasAlertTracker()
	const b = new GasAlertTracker()
	assert.ok(a.onSendFailure('insufficient funds', 0))
	assert.ok(b.onSendFailure('insufficient funds', 0))
	a.onOk()
	assert.equal(b.streak, 1)
})
