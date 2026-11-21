/**
 * Flush-time guardian re-check: held / unconfirmed / kept, caching, concurrency bound, order, identity of the counts.
 * Fakes only. No RPC.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ethers } from 'ethers'
import { partitionByGuardianBeneficiary } from './labFlushGuardian'
import { formatFlushSummary, newLabFlushCounters } from './labScanSummary'

const pk = (n: number): string => `0x${n.toString(16).padStart(96, '0')}`
const BEN = '0x00000000000000000000000000000000000000aa'
type E = { eventKey: string; pubkey: string }
const entry = (i: number, p: string): E => ({ eventKey: `0x${i.toString(16).padStart(64, '0')}`, pubkey: p })
const hashOf = (p: string): string => ethers.keccak256(p)

test('E: a pubkey that gained a beneficiary is held, a failing read is unconfirmed, the rest is kept; order preserved', async () => {
	const flipped = pk(1)
	const failing = pk(2)
	const entries = [entry(0, pk(3)), entry(1, flipped), entry(2, pk(3)), entry(3, failing), entry(4, flipped), entry(5, pk(4))]
	const r = await partitionByGuardianBeneficiary(entries, async (h) => {
		if (h === hashOf(flipped)) return BEN
		if (h === hashOf(failing)) throw new Error('rpc down')
		return ethers.ZeroAddress
	})
	assert.deepEqual(r.keep.map((e) => e.eventKey), [entries[0]!.eventKey, entries[2]!.eventKey, entries[5]!.eventKey])
	assert.deepEqual(r.held.map((e) => e.eventKey), [entries[1]!.eventKey, entries[4]!.eventKey])
	assert.deepEqual(r.unconfirmed.map((e) => e.eventKey), [entries[3]!.eventKey])
	assert.equal(r.keep.length + r.held.length + r.unconfirmed.length, entries.length, 'every entry lands in exactly one list')
})

test('E: one read per distinct pubkey, never more than the concurrency in flight', async () => {
	const entries: E[] = []
	for (let i = 0; i < 200; i++) entries.push(entry(i, pk(i % 40)))
	let calls = 0
	let inFlight = 0
	let peak = 0
	const r = await partitionByGuardianBeneficiary(
		entries,
		async () => {
			calls++
			inFlight++
			peak = Math.max(peak, inFlight)
			await new Promise((res) => setTimeout(res, 5))
			inFlight--
			return ethers.ZeroAddress
		},
		8
	)
	assert.equal(calls, 40)
	assert.ok(peak <= 8 && peak > 1, `peak ${peak}`)
	assert.equal(r.keep.length, 200)
})

test('E: nothing to check is a no-op; held entries are not consumed (the function only partitions)', async () => {
	const none = await partitionByGuardianBeneficiary([], async () => ethers.ZeroAddress)
	assert.deepEqual(none, { keep: [], held: [], unconfirmed: [] })
	const entries = [entry(0, pk(1))]
	const snapshot = JSON.stringify(entries)
	const r = await partitionByGuardianBeneficiary(entries, async () => BEN)
	assert.equal(r.held.length, 1)
	assert.equal(JSON.stringify(entries), snapshot, 'inputs are untouched; the caller leaves held entries in the pending pool')
})

test('E: flush-summary carries guardianHeld and the identity inspect = dropped + unconfirmed + guardianHeld + held + signable', () => {
	const f = newLabFlushCounters()
	Object.assign(f, { inspect: 200, pendingAtInspect: 1_000_000, droppedChainConsumed: 7, unconfirmed: 3, guardianHeld: 5, held: 0, signable: 185, batches: 2 })
	assert.equal(f.inspect, f.droppedChainConsumed + f.unconfirmed + f.guardianHeld + f.held + f.signable)
	const line = formatFlushSummary(f, 185)!
	assert.match(line, /^flush-summary inspect=200\/1000000 droppedChainConsumed=7 unconfirmed=3 guardianHeld=5 held=0 signable=185 batches=2 settledEntries=185 consumedDelta=192 failed=0 inspectRealtime=0 inspectHistory=0 pendingRealtime=0 pendingHistory=0$/)
	assert.doesNotMatch(line, /0x/)
})
