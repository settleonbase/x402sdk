import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach } from 'node:test'
import {
	guardBUnitConsume,
	isPaymentIntakePaused,
	PAYMENT_INTAKE_PAUSED_CODE,
	recordPausedIntake,
} from './paymentIntakePause.js'

const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pip-')), 'held.jsonl')
const lines = () => (fs.existsSync(journal) ? fs.readFileSync(journal, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

describe('payment intake pause', () => {
	beforeEach(() => {
		process.env.BEAMIO_PAYMENT_INTAKE_PAUSE_JOURNAL = journal
		fs.rmSync(journal, { force: true })
	})

	it('is off unless the switch is set', () => {
		delete process.env.BEAMIO_PAYMENT_INTAKE_PAUSE
		assert.equal(isPaymentIntakePaused(), false)
		for (const v of ['1', 'true', 'YES', 'on']) {
			process.env.BEAMIO_PAYMENT_INTAKE_PAUSE = v
			assert.equal(isPaymentIntakePaused(), true, v)
		}
		process.env.BEAMIO_PAYMENT_INTAKE_PAUSE = '0'
		assert.equal(isPaymentIntakePaused(), false)
	})

	it('passes the real contract through when not paused', () => {
		delete process.env.BEAMIO_PAYMENT_INTAKE_PAUSE
		const c = { consumeFromUser: () => 'sent' }
		assert.equal(guardBUnitConsume(c, 't'), c)
		assert.equal(lines().length, 0)
	})

	it('holds consumeFromUser when paused: no call, journaled, rejects with the pause code', async () => {
		process.env.BEAMIO_PAYMENT_INTAKE_PAUSE = '1'
		let called = 0
		const c = { consumeFromUser: (..._a: unknown[]) => { called++; return Promise.resolve('sent') } }
		await assert.rejects(
			guardBUnitConsume(c, 'site:1').consumeFromUser('0xabc', 20_000_000n, '0xhash', 0n, 2n),
			(e: Error) => e.message.startsWith(PAYMENT_INTAKE_PAUSED_CODE),
		)
		assert.equal(called, 0)
		const [row] = lines()
		assert.equal(row.kind, 'bunitConsume:site:1')
		assert.equal(row.data.amount, '20000000')
		assert.equal(row.data.sourceHash, '0xhash')
		assert.equal(row.data.kind, '2')
	})

	it('appends, never truncates', () => {
		recordPausedIntake('a', { n: 1 })
		recordPausedIntake('b', { n: 2n })
		assert.deepEqual(lines().map((r) => [r.kind, r.data.n]), [['a', 1], ['b', '2']])
	})
})
