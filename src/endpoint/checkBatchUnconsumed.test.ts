/**
 * Per-batch pre-sign check: reads only the keys of the batch, and an RPC error is UNKNOWN
 * (never treated as unconsumed). Uses a counting stub contract; no network, no socket, no signer.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ethers } from 'ethers'
import { checkBatchUnconsumed } from './validatorClRewardPayoutReporter.js'

type Entry = Parameters<typeof checkBatchUnconsumed>[1][number]
const mk = (i: number): Entry =>
	({ eventKey: '0x' + i.toString(16).padStart(64, '0'), guardianId: '1', amount: '1', blockNumber: i, withdrawalIndex: 0 }) as unknown as Entry

function stub(consumed: Set<string>, failing: Set<string>) {
	const calls: string[] = []
	const c = {
		consumedRewardEventKey: async (k: string) => {
			calls.push(k)
			if (failing.has(k)) throw new Error('simulated RPC failure')
			return consumed.has(k)
		},
	}
	return { contract: c as unknown as ethers.Contract, calls }
}

test('reads only the batch keys, not the whole queue (no full-queue serial sweep)', async () => {
	const queue = Array.from({ length: 55668 }, (_, i) => mk(i))
	const batch = queue.slice(0, 10)
	const { contract, calls } = stub(new Set(), new Set())
	const r = await checkBatchUnconsumed(contract, batch)
	assert.equal(calls.length, 10)
	assert.equal(r.payable.length, 10)
	assert.equal(r.consumed.length, 0)
	assert.equal(r.unknown.length, 0)
})

test('an already-consumed key is reported as consumed and is not payable', async () => {
	const batch = [mk(1), mk(2), mk(3)]
	const { contract } = stub(new Set([batch[1]!.eventKey]), new Set())
	const r = await checkBatchUnconsumed(contract, batch)
	assert.deepEqual(r.consumed.map((e) => e.eventKey), [batch[1]!.eventKey])
	assert.deepEqual(r.payable.map((e) => e.eventKey), [batch[0]!.eventKey, batch[2]!.eventKey])
})

test('an RPC error is UNKNOWN, never treated as unconsumed (fix for former catch-keeps-entry)', async () => {
	const batch = [mk(1), mk(2)]
	const { contract } = stub(new Set(), new Set([batch[0]!.eventKey]))
	const r = await checkBatchUnconsumed(contract, batch)
	assert.deepEqual(r.unknown.map((e) => e.eventKey), [batch[0]!.eventKey])
	assert.deepEqual(r.payable.map((e) => e.eventKey), [batch[1]!.eventKey])
	assert.equal(r.payable.some((e) => e.eventKey === batch[0]!.eventKey), false)
})
