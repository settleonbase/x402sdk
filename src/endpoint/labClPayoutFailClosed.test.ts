/**
 * Unit tests for LabPayoutFailClosedGate (B-3). No chain, no signer. Node built-ins only.
 * Compile with tsconfig.test.json and run with node --test.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'

test('B-3: a persist failure trips the gate; assertOpen then refuses every payment', () => {
	const alerts: string[] = []
	const gate = new LabPayoutFailClosedGate((m) => alerts.push(m))
	assert.equal(gate.tripped, false)
	gate.assertOpen('withdrawNative')

	gate.trip('persist', new Error('Invalid string length'))
	assert.equal(gate.tripped, true)
	assert.equal(gate.tripReason, 'persist: Invalid string length')
	assert.throws(() => gate.assertOpen('withdrawNative'), /fail-closed \(persist: Invalid string length\); refusing withdrawNative/)
	assert.equal(alerts.length, 1)
	assert.match(alerts[0], /^ALERT fail-closed/)
	assert.match(alerts[0], /No further payments/)
})

test('B-3: the first failure reason is kept; a later failure is still alerted and does not replace it', () => {
	const alerts: string[] = []
	const gate = new LabPayoutFailClosedGate((m) => alerts.push(m))
	gate.trip('persist', new Error('first'))
	gate.trip('persist', new Error('second'))
	assert.equal(gate.tripReason, 'persist: first')
	assert.equal(alerts.length, 2)
	assert.match(alerts[1], /persist: first/)
})

test('B-3: non-Error values are reported as text', () => {
	const gate = new LabPayoutFailClosedGate(() => undefined)
	gate.trip('persist', 'plain string failure')
	assert.equal(gate.tripReason, 'persist: plain string failure')
})
