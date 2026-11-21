/**
 * P1 scan order: the Lab pubkey filter runs before any chain read, and only Lab keys are ever recorded in consumedEventKeys.
 * Differential tests against the previous implementation (labScanLegacyReference.test.ts): the set of entries that can be paid is
 * identical; the only differences are (a) non-Lab keys that are consumed on chain are no longer recorded, (b) fewer chain reads.
 * Fakes only. No RPC, no beacon, no socket.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ethers } from 'ethers'
import { PaidKeyViewUnconfirmed } from './clPaidKeyGate'
import { collectLabSkimEntriesForBlock, type LabScanDeps } from './validatorLabMiningPoolClPayoutReporter'
import { eventKeyOf, legacyCollect } from './labScanLegacyReference.test'
import {
	formatFlushSummary,
	formatScanSummary,
	newLabFlushCounters,
	newLabScanCounters,
	scanConsumedDelta,
} from './labScanSummary'

const PROXY = '0xc71e246dd78b37c2fabc905d340932f28f503433'
const OTHER_ADDR = '0x0000000000000000000000000000000000000001'
const FLOOR = 10n ** 18n // 1 CNET
const pk = (n: number): string => `0x${n.toString(16).padStart(96, '0')}`

type Validator = { pubkey: string | null; status: string | null }
type World = {
	validators: Map<number, Validator>
	lab: Set<string>
	chainConsumed: Set<string>
	guardianBeneficiary: Map<string, string> // keccak(pubkey) -> beneficiary
	chainError: Set<string>
	beaconError: Set<number>
}
type Calls = { chain: number; beacon: number; guardian: number }

function world(): World {
	return { validators: new Map(), lab: new Set(), chainConsumed: new Set(), guardianBeneficiary: new Map(), chainError: new Set(), beaconError: new Set() }
}
function depsFor(w: World, calls: Calls): LabScanDeps {
	return {
		chainConsumed: async (k) => {
			calls.chain++
			if (w.chainError.has(k)) throw new Error('rpc down')
			return w.chainConsumed.has(k)
		},
		fetchValidator: async (i) => {
			calls.beacon++
			if (w.beaconError.has(i)) throw new Error('beacon down')
			return w.validators.get(i) ?? { pubkey: null, status: null }
		},
		isLabPubkey: (p) => w.lab.has(p),
		guardianBeneficiary: async (h) => {
			calls.guardian++
			return w.guardianBeneficiary.get(h) ?? ethers.ZeroAddress
		},
		exitFloorWei: () => FLOOR,
	}
}
type Wd = { address?: string; amount?: string; validatorIndex: number; index: number }
const gwei = (cnet: number): string => String(Math.round(cnet * 1e9)) // amount field is in gwei
const wd = (index: number, validatorIndex: number, amountCnet = 0.001, address = PROXY): Wd => ({ address, amount: gwei(amountCnet), validatorIndex, index })

function freshState(): { consumedEventKeys: Record<string, true>; exitedPubkeys: Record<string, true> } {
	return { consumedEventKeys: {}, exitedPubkeys: {} }
}
const noContract = {} as never // the fakes replace every read; the contract is never touched

async function runNew(w: World, block: number, wds: Wd[], state = freshState(), pending = new Map<string, never>()) {
	const calls: Calls = { chain: 0, beacon: 0, guardian: 0 }
	const counters = newLabScanCounters()
	const out = await collectLabSkimEntriesForBlock(noContract, PROXY, block, { withdrawals: wds } as never, state as never, pending as never, counters, depsFor(w, calls))
	return { entries: out, state, calls, counters }
}
async function runOld(w: World, block: number, wds: Wd[], state = freshState(), pending = new Map<string, never>()) {
	const calls: Calls = { chain: 0, beacon: 0, guardian: 0 }
	const out = await legacyCollect(PROXY, block, { withdrawals: wds } as never, state as never, pending as never, depsFor(w, calls))
	return { entries: out, state, calls }
}
const keys = (xs: Array<{ eventKey: string }>): string[] => xs.map((e) => e.eventKey).sort()
const B = 100

function labValidator(w: World, index: number, n: number, status = 'active_ongoing'): string {
	const p = pk(n)
	w.validators.set(index, { pubkey: p, status })
	w.lab.add(p)
	return p
}
function foreignValidator(w: World, index: number, n: number): string {
	const p = pk(n)
	w.validators.set(index, { pubkey: p, status: 'active_ongoing' })
	return p
}

test('matrix: only "non-Lab key already consumed on chain" differs, and only in what is recorded and how many reads', async () => {
	const w = world()
	labValidator(w, 1, 1) // payable Lab key
	labValidator(w, 2, 2) // Lab key already consumed on chain
	foreignValidator(w, 3, 3) // non-Lab, consumed on chain
	foreignValidator(w, 4, 4) // non-Lab, not consumed
	const ben = labValidator(w, 5, 5) // Lab key with an active guardian beneficiary
	w.guardianBeneficiary.set(ethers.keccak256(ben), '0x00000000000000000000000000000000000000aa')
	labValidator(w, 6, 6, 'active_exiting') // Lab, not active
	labValidator(w, 7, 7) // Lab, withdrawal at/above the exit floor
	const wds = [wd(0, 1), wd(1, 2), wd(2, 3), wd(3, 4), wd(4, 5), wd(5, 6), wd(6, 7, 32), wd(7, 1, 0, PROXY), wd(8, 1, 0.001, OTHER_ADDR), wd(9, -1), wd(-5, 3)]
	w.chainConsumed.add(eventKeyOf(B, 1))
	w.chainConsumed.add(eventKeyOf(B, 2))
	const oldR = await runOld(w, B, wds)
	const newR = await runNew(w, B, wds)
	assert.deepEqual(keys(newR.entries), keys(oldR.entries), 'the set of payable entries is identical')
	assert.deepEqual(keys(newR.entries), [eventKeyOf(B, 0)])
	assert.ok(!keys(newR.entries).includes(eventKeyOf(B, 1)), 'a Lab key consumed on chain must not reach pending')
	assert.deepEqual(newR.state.exitedPubkeys, oldR.state.exitedPubkeys, 'exited validators are identical')
	const oldConsumed = Object.keys(oldR.state.consumedEventKeys).sort()
	const newConsumed = Object.keys(newR.state.consumedEventKeys).sort()
	// index 1 (Lab, chain), 6 (non-skim); index 2 (foreign, chain) only in the old code
	assert.deepEqual(newConsumed, [eventKeyOf(B, 1), eventKeyOf(B, 6)].sort())
	assert.deepEqual(oldConsumed, [eventKeyOf(B, 1), eventKeyOf(B, 2), eventKeyOf(B, 6)].sort())
	assert.equal(oldR.calls.chain, 7, 'old: one chain read per proxy withdrawal that was not locally hit')
	assert.equal(newR.calls.chain, 5, 'new: one chain read per Lab withdrawal that was not locally hit (non-Lab: none)')
	const c = newR.counters
	assert.equal(c.proxyWithdrawals, 9, 'zero amount and a foreign address are not proxy withdrawals; the two with an unusable index are')
	assert.equal(c.invalid, 2)
	assert.equal(c.nonLab, 2)
	assert.equal(c.labChainConsumed, 1)
	assert.equal(c.nonSkim, 1)
	assert.equal(c.nonActive, 1)
	assert.equal(c.guardianBeneficiary, 1)
	assert.equal(scanConsumedDelta(c), Object.keys(newR.state.consumedEventKeys).length, 'consumedDelta equals the consumed growth')
	assert.equal(c.invalid + c.localHit + c.nonLab + c.labChainConsumed + c.nonSkim + c.nonActive + c.guardianBeneficiary + newR.entries.length, c.proxyWithdrawals)
	// the journal line carries exactly these numbers
	c.blocks = 1; c.from = B; c.through = B; c.added = newR.entries.length
	assert.equal(
		formatScanSummary('history', c),
		'scan-summary line=history blocks=100-100 n=1 proxyWithdrawals=9 invalid=2 localHit=0 nonLab=2 labChainConsumed=1 nonSkim=1 nonActive=1 guardianBeneficiary=1 added=1 consumedDelta=2 fetchFailed=0 unconfirmed=0 paused=0'
	)
})

test('local consumed and pending hits cost no read at all, before and after', async () => {
	const w = world()
	labValidator(w, 1, 1)
	const state = freshState()
	state.consumedEventKeys[eventKeyOf(B, 0)] = true
	const pend = new Map<string, never>([[eventKeyOf(B, 1).toLowerCase(), {} as never]])
	const r = await runNew(w, B, [wd(0, 1), wd(1, 1)], state, pend)
	assert.equal(r.calls.chain + r.calls.beacon + r.calls.guardian, 0)
	assert.equal(r.counters.localHit, 2)
	assert.equal(r.entries.length, 0)
})

test('a Lab key is still read against the chain before it can reach pending', async () => {
	const w = world()
	labValidator(w, 1, 1)
	w.chainConsumed.add(eventKeyOf(B, 0))
	const r = await runNew(w, B, [wd(0, 1)])
	assert.equal(r.entries.length, 0, 'not queued')
	assert.equal(r.calls.chain, 1)
	assert.equal(r.state.consumedEventKeys[eventKeyOf(B, 0)], true)
})

test('failure semantics are unchanged: chain read error on a Lab key and beacon error both throw PaidKeyViewUnconfirmed', async () => {
	const w = world()
	labValidator(w, 1, 1)
	w.chainError.add(eventKeyOf(B, 0))
	await assert.rejects(runNew(w, B, [wd(0, 1)]), PaidKeyViewUnconfirmed)
	await assert.rejects(runOld(w, B, [wd(0, 1)]), PaidKeyViewUnconfirmed)
	const w2 = world()
	labValidator(w2, 1, 1)
	w2.beaconError.add(1)
	await assert.rejects(runNew(w2, B, [wd(0, 1)]), PaidKeyViewUnconfirmed)
	await assert.rejects(runOld(w2, B, [wd(0, 1)]), PaidKeyViewUnconfirmed)
})

test('a chain read error on a non-Lab key no longer blocks the scan (no read is made for it)', async () => {
	const w = world()
	foreignValidator(w, 1, 1)
	w.chainError.add(eventKeyOf(B, 0))
	const r = await runNew(w, B, [wd(0, 1)])
	assert.equal(r.entries.length, 0)
	assert.equal(r.calls.chain, 0)
	await assert.rejects(runOld(w, B, [wd(0, 1)]), PaidKeyViewUnconfirmed)
})

test('a validator the beacon has no pubkey for is skipped and counted as non-Lab', async () => {
	const w = world()
	w.validators.set(9, { pubkey: null, status: null })
	const r = await runNew(w, B, [wd(0, 9)])
	assert.equal(r.counters.nonLab, 1)
	assert.equal(r.calls.chain, 0)
})

test('differential property: random blocks, identical payable set and exited set; consumed differs only by non-Lab chain-consumed keys', async () => {
	let seed = 12345
	const rnd = (n: number): number => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed % n
	}
	for (let round = 0; round < 40; round++) {
		const w = world()
		const wds: Wd[] = []
		const nonLabChain: string[] = []
		for (let i = 0; i < 60; i++) {
			const vi = 1000 + i
			const kind = rnd(7)
			if (kind === 0) foreignValidator(w, vi, vi)
			else if (kind === 1) { foreignValidator(w, vi, vi) }
			else if (kind === 2) labValidator(w, vi, vi)
			else if (kind === 3) labValidator(w, vi, vi, 'active_exiting')
			else if (kind === 4) { const p = labValidator(w, vi, vi); w.guardianBeneficiary.set(ethers.keccak256(p), '0x00000000000000000000000000000000000000bb') }
			else if (kind === 5) labValidator(w, vi, vi)
			else w.validators.set(vi, { pubkey: null, status: null })
			const amount = rnd(10) === 0 ? 32 : 0.001
			const invalid = rnd(25) === 0
			wds.push(invalid ? wd(i, -1, amount) : wd(i, vi, amount))
			const ek = eventKeyOf(500 + round, i)
			if (rnd(3) === 0) {
				w.chainConsumed.add(ek)
				const v = w.validators.get(vi)!
				if (!invalid && (!v.pubkey || !w.lab.has(v.pubkey))) nonLabChain.push(ek)
			}
		}
		const oldR = await runOld(w, 500 + round, wds)
		const newR = await runNew(w, 500 + round, wds)
		assert.deepEqual(keys(newR.entries), keys(oldR.entries), `round ${round}: payable set`)
		assert.deepEqual(newR.state.exitedPubkeys, oldR.state.exitedPubkeys, `round ${round}: exited`)
		const removed = Object.keys(oldR.state.consumedEventKeys).filter((k) => !newR.state.consumedEventKeys[k]).sort()
		assert.deepEqual(removed, [...nonLabChain].sort(), `round ${round}: only non-Lab chain-consumed keys are no longer recorded`)
		for (const k of Object.keys(newR.state.consumedEventKeys)) assert.ok(oldR.state.consumedEventKeys[k], `round ${round}: nothing new is recorded`)
		assert.equal(scanConsumedDelta(newR.counters), Object.keys(newR.state.consumedEventKeys).length)
		assert.ok(newR.calls.chain <= oldR.calls.chain)
		// the summary line is consistent with the counters and with the identity
		const c = newR.counters
		c.blocks = 1; c.from = 500 + round; c.through = 500 + round; c.added = newR.entries.length
		const line = formatScanSummary('realtime', c)!
		const field = (name: string): number => Number(new RegExp(` ${name}=(\\d+)`).exec(line)![1])
		assert.equal(field('proxyWithdrawals'), field('invalid') + field('localHit') + field('nonLab') + field('labChainConsumed') + field('nonSkim') + field('nonActive') + field('guardianBeneficiary') + field('added'), `round ${round}: identity on the printed line`)
		assert.equal(field('consumedDelta'), Object.keys(newR.state.consumedEventKeys).length, `round ${round}: consumedDelta on the printed line`)
	}
})

test('scan-summary and flush-summary: integers only, no key, no pubkey, identity holds, empty ticks are silent', () => {
	const c = newLabScanCounters()
	assert.equal(formatScanSummary('history', c), null)
	Object.assign(c, { blocks: 256, from: 2009263, through: 2009519, proxyWithdrawals: 4110, invalid: 0, nonLab: 708, labChainConsumed: 226, nonSkim: 1, nonActive: 2, guardianBeneficiary: 3, added: 3170, localHit: 0 })
	const line = formatScanSummary('history', c)!
	assert.match(line, /^scan-summary line=history blocks=2009263-2009519 n=256 proxyWithdrawals=4110 invalid=0 localHit=0 nonLab=708 labChainConsumed=226 nonSkim=1 nonActive=2 guardianBeneficiary=3 added=3170 consumedDelta=227 fetchFailed=0 unconfirmed=0 paused=0$/)
	assert.doesNotMatch(line, /0x/)
	const f = newLabFlushCounters()
	assert.equal(formatFlushSummary(f, 0), null)
	Object.assign(f, { inspect: 200, pendingAtInspect: 1636106, droppedChainConsumed: 7, unconfirmed: 1, guardianHeld: 0, held: 0, signable: 192, batches: 2 })
	const fl = formatFlushSummary(f, 200)!
	assert.match(fl, /^flush-summary inspect=200\/1636106 droppedChainConsumed=7 unconfirmed=1 guardianHeld=0 held=0 signable=192 batches=2 settledEntries=200 consumedDelta=207 failed=0 inspectRealtime=0 inspectHistory=0 pendingRealtime=0 pendingHistory=0$/)
	assert.doesNotMatch(fl, /0x/)
	assert.match(formatScanSummary('realtime', Object.assign(newLabScanCounters(), { fetchFailed: true }))!, /fetchFailed=1/)
	assert.match(formatScanSummary('realtime', Object.assign(newLabScanCounters(), { unconfirmed: true }))!, /unconfirmed=1/)
	// a range without any proxy withdrawal still prints (blocks were scanned), so the journal shows the cursor moving
	const quiet = newLabScanCounters()
	Object.assign(quiet, { blocks: 5, from: 10, through: 14 })
	assert.match(formatScanSummary('realtime', quiet)!, /^scan-summary line=realtime blocks=10-14 n=5 proxyWithdrawals=0 invalid=0 /)
})
