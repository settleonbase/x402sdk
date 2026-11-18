import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { cursorIfBlockConfirmed, partitionByPaidKey } from './clPaidKeyGate'

const paid = { eventKey: '0x' + 'aa'.repeat(32) }
const unpaid = { eventKey: '0x' + 'bb'.repeat(32) }
const fault = { eventKey: '0x' + 'cc'.repeat(32) }

test('paid, unpaid, and unconfirmed stay in three classes', async () => {
	const split = await partitionByPaidKey([paid, unpaid, fault], async (eventKey) => {
		if (eventKey === paid.eventKey) return true
		if (eventKey === unpaid.eventKey) return false
		throw new Error('rpc down')
	})
	assert.deepEqual(split.alreadyPaid.map((e) => e.eventKey), [paid.eventKey])
	assert.deepEqual(split.payable.map((e) => e.eventKey), [unpaid.eventKey])
	assert.deepEqual(split.unconfirmed.map((e) => e.eventKey), [fault.eventKey])
	assert.equal(split.errors[0]?.message, 'rpc down')
	assert.equal(split.payable.includes(fault), false)
})

test('after the view recovers, the same key is payable once, then paid', async () => {
	let consumed = false
	const first = await partitionByPaidKey([unpaid], async () => {
		throw new Error('timeout')
	})
	assert.equal(first.payable.length, 0)
	assert.equal(first.unconfirmed.length, 1)

	const second = await partitionByPaidKey(first.unconfirmed, async () => consumed)
	assert.deepEqual(second.payable.map((e) => e.eventKey), [unpaid.eventKey])
	consumed = true
	const third = await partitionByPaidKey(second.payable, async () => consumed)
	assert.equal(third.payable.length, 0)
	assert.deepEqual(third.alreadyPaid.map((e) => e.eventKey), [unpaid.eventKey])
})

test('a failed paid-key view does not move the old cursor', () => {
	const cursor = cursorIfBlockConfirmed(2010028, 2010029, false)
	assert.equal(cursor, 2010028)
	assert.equal(cursorIfBlockConfirmed(cursor, 2010029, true), 2010029)
})
