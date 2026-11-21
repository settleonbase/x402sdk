/**
 * P2c-4: a long scan-and-pay scenario on the simulated chain / beacon / signer (isolated, no .77, no network), run ONCE with the switch off (legacy state) and ONCE with it on (WAL, a snapshot after
 * every tick), with faults in the middle, and reconciled:
 *   - the world: 600 blocks (100..700), 0-3 withdrawals per block, 6 Lab validators + one non-Lab validator + 7% to another address, random amounts; history 100..400 (the first tick freezes at 400),
 *     the head then walks to 700 so history and realtime both run, several batches per tick;
 *   - the faults, the same script in both modes, each REALLY triggered and counted: kill -9 right after the 3rd recorded send; a lost signer ACK on the 2nd new send of the next run together with a kill -9
 *     at that moment; a kill -9 at the first empty receipt ask (the next run resumes the sent-not-settled batch); then, in one process, a lost ACK again and a late receipt (first ask empty), resolved
 *     in-process; then a clean run to the end; one variant with invariant C on;
 *   - the reconciliation per mode: exactly the expected event keys paid, each by ONE transaction, the paid amounts add up to the withdrawals' sum to the wei, nothing pending, every expected key consumed;
 *   - and legacy vs WAL against each other: the same signer request sequence (same batches in the same order), the same per-key payments, the same final logical state.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digestLogical, runScenario, type Ctx, type Scenario, type ScenarioResult } from './labE2e/harness.test'
import { eventKeyOf, headPlan, seedValidators } from './labE2e/scenarios.test'

const OTHER = '0x00000000000000000000000000000000000000aa'
function mulberry32(a: number): () => number {
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type World = { expected: Map<string, bigint>; totalGwei: bigint }
function buildWorld(ctx: Ctx, seed: number): World {
	const rnd = mulberry32(seed)
	const expected = new Map<string, bigint>()
	let total = 0n
	for (let block = 100; block <= 700; block++) {
		const n = rnd() < 0.45 ? 0 : 1 + Math.floor(rnd() * 3)
		for (let i = 0; i < n; i++) {
			const validatorIndex = Math.floor(rnd() * 7) // 6 = a validator that is not a Lab validator
			const toOther = rnd() < 0.07
			const amountGwei = BigInt(1_000_000 + Math.floor(rnd() * 9_000_000))
			ctx.chain.addWithdrawal(block, { index: i, validatorIndex, amountGwei, ...(toOther ? { address: OTHER } : {}) })
			if (validatorIndex < 6 && !toOther) {
				expected.set(eventKeyOf(block, i), amountGwei)
				total += amountGwei
			}
		}
	}
	return { expected, totalGwei: total }
}

type Faults = { acksLostTotal: number; acksLostAfterRun2: number; receiptKills: number }
type Outcome = { result: ScenarioResult; world: World; finalLogical: ReturnType<typeof digestLogical>; faults: Faults }

async function runMode(seed: number, walMode: boolean, invariantC: boolean): Promise<Outcome> {
	let world!: World
	let finalLogical: ReturnType<typeof digestLogical> = null
	let faults: Faults = { acksLostTotal: 0, acksLostAfterRun2: 0, receiptKills: 0 }
	const heads = [400, 460, 520, 580, 640, 700, 700, 700, 700, 700, 700, 700, 700, 700, 700, 700]
	const s: Scenario = {
		name: `long_${seed}_${walMode ? 'wal' : 'legacy'}${invariantC ? '_c' : ''}`,
		env: {
			CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '20',
			CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_MAX_BATCHES: '3',
			CONET_LAB_MINING_POOL_CL_PAYOUT_REALTIME_RESERVED: '1',
			CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '12',
			CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000',
			...(invariantC ? { CONET_LAB_MINING_POOL_CL_PAYOUT_HISTORY_PAY_BEHIND_CURSOR: '1' } : {}),
			...(walMode ? { CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_SNAPSHOT_INTERVAL_MS: '1' } : {}),
		},
		body: async (ctx) => {
			seedValidators(ctx)
			world = buildWorld(ctx, seed)
			headPlan(ctx, heads)
			// Every fault below is REALLY triggered and counted (a reviewer found the first version's lost ACK never fired: the hook reset the mode before the fake signer looked at it).
			// run 1: kill -9 right after the 3rd recorded send (sent, not settled, across a restart)
			let recorded = 0
			ctx.signer.afterRecord = () => {
				if (++recorded === 3) ctx.currentChild?.kill('SIGKILL')
			}
			await ctx.run({ ticks: 6, timeoutMs: 120_000 })
			// run 2: the signer records the 2nd NEW send of this run, drops the connection without an answer (ACK lost) AND the process is killed at that moment: the next run recovers from a state
			// whose last send was recorded by the signer but never acknowledged
			let n2 = 0
			let armed2 = false
			ctx.signer.beforeRecord = () => {
				if (++n2 === 2) armed2 = true
			}
			ctx.signer.afterRecord = () => {
				if (armed2) {
					armed2 = false
					ctx.signer.mode = 'lose-ack' // the fake signer checks the mode right after this hook and drops the connection
					ctx.currentChild?.kill('SIGKILL')
				}
			}
			await ctx.run({ ticks: 4, timeoutMs: 120_000 })
			ctx.signer.mode = 'ok'
			const lostAfterRun2 = ctx.signer.acksLost
			// run 3: the first receipt ask of the first transaction comes back empty AND the process is killed at that moment: the next run resumes the sent-not-settled batch from the state
			ctx.signer.beforeRecord = undefined
			ctx.signer.afterRecord = undefined
			let killedOnReceipt = 0
			ctx.chain.receiptRule = () => {
				if (killedOnReceipt === 0) {
					killedOnReceipt++
					ctx.currentChild?.kill('SIGKILL')
					return 'none'
				}
				return 'mined'
			}
			await ctx.run({ ticks: 4, timeoutMs: 120_000 })
			const receiptKills = killedOnReceipt
			// run 4 (same process, no kill): a lost ACK again, resolved in-process by the idempotency key, and a late receipt (first ask of every transaction empty) resolved by re-asking
			let n4 = 0
			let armed4 = false
			ctx.signer.beforeRecord = () => {
				n4++
				if (n4 === 2) armed4 = true
				else if (n4 > 2) ctx.signer.mode = 'ok'
			}
			ctx.signer.afterRecord = () => {
				if (armed4) {
					armed4 = false
					ctx.signer.mode = 'lose-ack'
				}
			}
			ctx.chain.receiptRule = (_tx, ask) => (ask <= 1 ? 'none' : 'mined')
			await ctx.run({ ticks: 5, timeoutMs: 180_000 })
			ctx.signer.mode = 'ok'
			ctx.signer.beforeRecord = undefined
			ctx.signer.afterRecord = undefined
			// run 5: clean, to the end
			ctx.chain.receiptRule = () => 'mined'
			await ctx.run({ ticks: 8, timeoutMs: 180_000 })
			faults = { acksLostTotal: ctx.signer.acksLost, acksLostAfterRun2: lostAfterRun2, receiptKills }
			finalLogical = digestLogical(ctx.stateDir)
		},
	}
	const result = await runScenario(s, undefined, { walMode })
	return { result, world, finalLogical, faults }
}

function reconcile(o: Outcome, label: string): void {
	const { result, world } = o
	assert.deepEqual(result.unknownRpcMethods, [], label)
	assert.ok(world.expected.size > 300, `${label}: a long scenario (${world.expected.size} payable withdrawals)`)
	assert.ok(result.chainSent.length >= 15, `${label}: many batches (${result.chainSent.length} transactions)`)
	process.stderr.write(`long ${label}: ${world.expected.size} payable withdrawals, ${result.chainSent.length} transactions, ${result.exits.length} runs\n`)
	assert.deepEqual(Object.keys(result.paymentsPerEventKey).sort(), [...world.expected.keys()].sort(), `${label}: exactly the payable event keys were paid (no noise key, none left unpaid)`)
	for (const [k, n] of Object.entries(result.paymentsPerEventKey)) assert.equal(n, 1, `${label}: key ${k} paid ${n} times`)
	const paidWei = result.chainSent.reduce((a, t) => a + BigInt(t.amountWei), 0n)
	assert.equal(paidWei, world.totalGwei * 1_000_000_000n, `${label}: the paid amounts add up to the withdrawals' sum to the wei`)
	assert.equal(result.exits[result.exits.length - 1]!.code, 0, `${label}: the last run ended cleanly`)
	// the faults really happened (a reviewer found the first version's lost ACK never fired): kill -9 in runs 1, 2 and 3; connections really dropped at least twice (run 2 across a restart, run 4 in-process);
	// the receipt-time kill really happened once
	for (const i of [0, 1, 2]) assert.equal(result.exits[i]!.signal, 'SIGKILL', `${label}: run ${i + 1} was killed by kill -9`)
	assert.ok(o.faults.acksLostAfterRun2 >= 1, `${label}: the ACK was really lost across a restart (run 2): ${o.faults.acksLostAfterRun2}`)
	assert.ok(o.faults.acksLostTotal >= 2, `${label}: the ACK was really lost again in-process (run 4): ${o.faults.acksLostTotal} in total`)
	assert.equal(o.faults.receiptKills, 1, `${label}: the process was killed at the first empty receipt ask`)
	assert.ok(o.finalLogical, label)
	assert.equal(o.finalLogical!.pending.length, 0, `${label}: nothing left pending`)
	for (const k of world.expected.keys()) assert.ok(o.finalLogical!.consumed.includes(k), `${label}: ${k} consumed`)
}

for (const [seed, invC] of [[4242, false], [4343, true]] as const) {
	test(`long scenario seed ${seed}${invC ? ' (invariant C on)' : ''}: switch off and switch on both reconcile, and agree with each other`, { timeout: 590_000 }, async () => {
		const legacy = await runMode(seed, false, invC)
		reconcile(legacy, 'legacy')
		const wal = await runMode(seed, true, invC)
		reconcile(wal, 'wal')
		assert.deepEqual(wal.result.signerRequests, legacy.result.signerRequests, 'the same batches in the same order')
		assert.deepEqual(wal.result.paymentsPerEventKey, legacy.result.paymentsPerEventKey)
		assert.deepEqual(wal.result.chainSent, legacy.result.chainSent)
		const stripUpdatedAt = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'updatedAt').map(([k, x]) => [k, stripUpdatedAt(x)])) : v)
		assert.deepEqual(wal.finalLogical!.pending, legacy.finalLogical!.pending)
		assert.deepEqual(wal.finalLogical!.exited, legacy.finalLogical!.exited)
		assert.deepEqual(new Set(wal.finalLogical!.consumed), new Set(legacy.finalLogical!.consumed), 'the same consumed set')
		assert.deepEqual(stripUpdatedAt(wal.finalLogical!.scalars), stripUpdatedAt(legacy.finalLogical!.scalars))
		assert.deepEqual(wal.result.layout, { manifestVersion: 2, walSegments: 0 })
	})
}
