/**
 * B2 bounded parallel reads. The parallel scan must make exactly the decisions of the sequential scan: same entries, same
 * consumed and exited sets, same counters, and on a failed read the same error at the same item with the same state changes made
 * by the items before it. Fakes only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ethers } from 'ethers'
import { PaidKeyViewUnconfirmed } from './clPaidKeyGate'
import { collectLabSkimEntriesForBlock, type LabScanDeps } from './validatorLabMiningPoolClPayoutReporter'
import { eventKeyOf } from './labScanLegacyReference.test'
import { sequentialCollect } from './labScanSequentialReference.test'
import { mapWithConcurrency, resolveReadConcurrency, settle, READ_CONCURRENCY_DEFAULT, READ_CONCURRENCY_MAX } from './labParallel'
import { newLabScanCounters } from './labScanSummary'

const PROXY = '0xc71e246dd78b37c2fabc905d340932f28f503433'
const FLOOR = 10n ** 18n
const pk = (n: number): string => `0x${n.toString(16).padStart(96, '0')}`
const BEN = '0x00000000000000000000000000000000000000aa'
const noContract = {} as never

test('mapWithConcurrency: input order, bounded in flight, empty input', async () => {
	assert.deepEqual(await mapWithConcurrency([], 8, async () => 1), [])
	let inFlight = 0
	let peak = 0
	const out = await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 5, async (x) => {
		inFlight++
		peak = Math.max(peak, inFlight)
		await new Promise((r) => setTimeout(r, 3 + (x % 4)))
		inFlight--
		return x * 2
	})
	assert.deepEqual(out, Array.from({ length: 50 }, (_, i) => i * 2))
	assert.ok(peak <= 5 && peak > 1, `peak ${peak}`)
})

test('settle turns a rejection into a value; resolveReadConcurrency has a default, a clamp and a floor', async () => {
	const bad = await settle(Promise.reject(new Error('x')))
	assert.equal(bad.ok, false)
	assert.equal((await settle(Promise.resolve(7))).ok, true)
	assert.equal(resolveReadConcurrency({}), READ_CONCURRENCY_DEFAULT)
	assert.equal(resolveReadConcurrency({ CONET_LAB_MINING_POOL_CL_PAYOUT_READ_CONCURRENCY: '4' }), 4)
	assert.equal(resolveReadConcurrency({ CONET_LAB_MINING_POOL_CL_PAYOUT_READ_CONCURRENCY: '999' }), READ_CONCURRENCY_MAX)
	assert.equal(resolveReadConcurrency({ CONET_LAB_MINING_POOL_CL_PAYOUT_READ_CONCURRENCY: '0' }), READ_CONCURRENCY_DEFAULT)
	assert.equal(resolveReadConcurrency({ CONET_LAB_MINING_POOL_CL_PAYOUT_READ_CONCURRENCY: 'x' }), READ_CONCURRENCY_DEFAULT)
})

type World = {
	validators: Map<number, { pubkey: string | null; status: string | null }>
	lab: Set<string>
	chainConsumed: Set<string>
	beneficiary: Map<string, string>
	beaconErr: Set<number>
	chainErr: Set<string>
	guardianErr: Set<string>
}
function world(): World {
	return { validators: new Map(), lab: new Set(), chainConsumed: new Set(), beneficiary: new Map(), beaconErr: new Set(), chainErr: new Set(), guardianErr: new Set() }
}
function depsFor(w: World, delayMs = 0, track?: { inFlight: number; peak: number }): LabScanDeps {
	const wrap = async <T>(fn: () => T): Promise<T> => {
		if (track) {
			track.inFlight++
			track.peak = Math.max(track.peak, track.inFlight)
		}
		if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
		if (track) track.inFlight--
		return fn()
	}
	return {
		chainConsumed: (k) => wrap(() => { if (w.chainErr.has(k)) throw new Error('chain down'); return w.chainConsumed.has(k) }),
		fetchValidator: (i) => wrap(() => { if (w.beaconErr.has(i)) throw new Error('beacon down'); return w.validators.get(i) ?? { pubkey: null, status: null } }),
		isLabPubkey: (p) => w.lab.has(p),
		guardianBeneficiary: (h) => wrap(() => { if (w.guardianErr.has(h)) throw new Error('guardian down'); return w.beneficiary.get(h) ?? ethers.ZeroAddress }),
		exitFloorWei: () => FLOOR,
	}
}
type Wd = { address?: string; amount?: string; validatorIndex: number; index: number }
const wd = (index: number, validatorIndex: number, cnet = 0.001, address = PROXY): Wd => ({ address, amount: String(Math.round(cnet * 1e9)), validatorIndex, index })
const fresh = () => ({ consumedEventKeys: {} as Record<string, true>, exitedPubkeys: {} as Record<string, true> })

async function runBoth(w: World, block: number, wds: Wd[], pendingKeys: string[] = [], consumedKeys: string[] = []) {
	const mk = () => {
		const s = fresh()
		for (const k of consumedKeys) s.consumedEventKeys[k] = true
		return { s, p: new Map<string, never>(pendingKeys.map((k) => [k.toLowerCase(), {} as never])) }
	}
	const a = mk()
	const b = mk()
	const ca = newLabScanCounters()
	const cb = newLabScanCounters()
	let ea: unknown
	let eb: unknown
	let ra: unknown[] = []
	let rb: unknown[] = []
	try { ra = await sequentialCollect(PROXY, block, { withdrawals: wds } as never, a.s as never, a.p as never, ca, depsFor(w)) } catch (e) { ea = e }
	try { rb = await collectLabSkimEntriesForBlock(noContract, PROXY, block, { withdrawals: wds } as never, b.s as never, b.p as never, cb, depsFor(w), 8) } catch (e) { eb = e }
	return { a, b, ca, cb, ea, eb, ra, rb }
}

test('differential: parallel and sequential agree on entries, state, counters and the first failure (random blocks with injected read errors)', async () => {
	let seed = 4242
	const rnd = (n: number): number => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed % n
	}
	let errorsSeen = 0
	for (let round = 0; round < 120; round++) {
		const w = world()
		const wds: Wd[] = []
		const block = 700 + round
		for (let i = 0; i < 16; i++) {
			const vi = 5000 + round * 20 + i
			const kind = rnd(8)
			if (kind === 0) w.validators.set(vi, { pubkey: pk(vi), status: 'active_ongoing' })
			else if (kind === 7) w.validators.set(vi, { pubkey: null, status: null })
			else {
				w.validators.set(vi, { pubkey: pk(vi), status: kind === 3 ? 'active_exiting' : 'active_ongoing' })
				w.lab.add(pk(vi))
				if (kind === 4) w.beneficiary.set(ethers.keccak256(pk(vi)), BEN)
			}
			const ek = eventKeyOf(block, i)
			if (rnd(4) === 0) w.chainConsumed.add(ek)
			if (rnd(30) === 0) w.beaconErr.add(vi)
			if (rnd(30) === 0) w.chainErr.add(ek)
			if (rnd(30) === 0) w.guardianErr.add(ethers.keccak256(pk(vi)))
			const amount = rnd(9) === 0 ? 32 : 0.001
			wds.push(rnd(40) === 0 ? wd(i, -1, amount) : rnd(60) === 0 ? wd(i, vi, 0, PROXY) : wd(i, vi, amount))
		}
		const consumedKeys = rnd(5) === 0 ? [eventKeyOf(block, 2)] : []
		const pendingKeys = rnd(5) === 0 ? [eventKeyOf(block, 3)] : []
		const r = await runBoth(w, block, wds, pendingKeys, consumedKeys)
		if (r.ea || r.eb) {
			errorsSeen++
			assert.ok(r.ea instanceof PaidKeyViewUnconfirmed && r.eb instanceof PaidKeyViewUnconfirmed, `round ${round}: both fail`)
			assert.equal((r.eb as PaidKeyViewUnconfirmed).eventKey, (r.ea as PaidKeyViewUnconfirmed).eventKey, `round ${round}: same failing item`)
			assert.equal((r.eb as Error).message, (r.ea as Error).message, `round ${round}: same message`)
		}
		assert.deepEqual(r.b.s.consumedEventKeys, r.a.s.consumedEventKeys, `round ${round}: consumed`)
		assert.deepEqual(r.b.s.exitedPubkeys, r.a.s.exitedPubkeys, `round ${round}: exited`)
		assert.deepEqual(r.cb, r.ca, `round ${round}: counters`)
		assert.deepEqual((r.rb as Array<{ eventKey: string }>).map((e) => e.eventKey), (r.ra as Array<{ eventKey: string }>).map((e) => e.eventKey), `round ${round}: entries`)
	}
	assert.ok(errorsSeen >= 5, `the random run must include failures (saw ${errorsSeen})`)
})

test('parallel is faster and stays within the concurrency bound', async () => {
	const w = world()
	const wds: Wd[] = []
	for (let i = 0; i < 16; i++) {
		w.validators.set(100 + i, { pubkey: pk(100 + i), status: 'active_ongoing' })
		w.lab.add(pk(100 + i))
		wds.push(wd(i, 100 + i))
	}
	const t1 = Date.now()
	await sequentialCollect(PROXY, 900, { withdrawals: wds } as never, fresh() as never, new Map() as never, newLabScanCounters(), depsFor(w, 20))
	const seq = Date.now() - t1
	const track = { inFlight: 0, peak: 0 }
	const t2 = Date.now()
	const out = await collectLabSkimEntriesForBlock(noContract, PROXY, 900, { withdrawals: wds } as never, fresh() as never, new Map() as never, newLabScanCounters(), depsFor(w, 20, track), 4)
	const par = Date.now() - t2
	assert.equal(out.length, 16)
	assert.ok(track.peak <= 4 && track.peak > 1, `peak ${track.peak}`)
	assert.ok(par * 2.5 < seq, `parallel ${par} ms vs sequential ${seq} ms`)
})
