/**
 * The money guard of the wallet pools with MIN_VDR_BALANCE_RESERVE_WEI = 0 (project decision: the reserve is 0, so the claim rule is the ONLY guard: claimable = the VDR's real balance minus what every wallet of
 * both lines has claimed but not booked or has in flight; a failed balance read means no claim). REAL reporter in pool mode, fake chain whose balance FALLS when a withdrawNative is mined, per-wallet fake signers.
 *   A  balance for only N batches, pool 2x2: chain-side cumulative payout <= the initial balance; at EVERY send the sent-but-unbooked plus booked total <= the balance; "refuse batch" appears, no wallet is
 *      isolated, the keys the balance cannot cover stay pending, every key at most once to the wei
 *   B  balance read failing for a whole run: zero signer requests, no slot; after the read works again everything is paid once
 *   C  the realtime and the history wallet race for a balance that covers exactly one batch: exactly one batch is paid, the other wallet refuses, total <= balance, nothing isolated
 *   C2 deterministic version of C: the first two balance reads are held until both wallets are inside the claim window; only the claims of the others can keep them from both sending
 *   S  deterministic: a COMMITTED slot of one wallet (receipt late) keeps the other wallet from sending though the balance is not deducted yet
 *   E  boundary: a balance exactly equal to one batch pays it
 *   GAS1/GAS2 the per-wallet gas-shortage alarm (immediate on an 'insufficient funds' text, from the third failed pass otherwise; no isolation, no hand-over)
 *   D  with a low balance, kill -9 after a send, a lost ACK and a late receipt: no key twice, total <= balance
 *   input: negative, fractional, hex or text values refuse the start (exit 1, nothing converted); 0 starts and is read back in `config minVdrBalanceReserveWei=0`
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ethers } from 'ethers'
import { recoverPayoutState } from './labPayoutRecovery'
import { runScenario, type Ctx, type Scenario, type ScenarioResult } from './labE2e/harness.test'
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
type World = { expected: Map<string, bigint>; totalWei: bigint }
function buildWorld(ctx: Ctx, seed: number): World {
	const rnd = mulberry32(seed)
	const expected = new Map<string, bigint>()
	let total = 0n
	for (let block = 100; block <= 400; block++) {
		const n = rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 4)
		for (let i = 0; i < n; i++) {
			const validatorIndex = Math.floor(rnd() * 7)
			const toOther = rnd() < 0.07
			const amountGwei = BigInt(1_000_000 + Math.floor(rnd() * 9_000_000))
			ctx.chain.addWithdrawal(block, { index: i, validatorIndex, amountGwei, ...(toOther ? { address: OTHER } : {}) })
			if (validatorIndex < 6 && !toOther) {
				expected.set(eventKeyOf(block, i), amountGwei * 1_000_000_000n)
				total += amountGwei * 1_000_000_000n
			}
		}
	}
	return { expected, totalWei: total }
}
const BASE_ENV = {
	CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '12',
	CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '12',
	CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000',
}
const HEADS = [250, 300, 350, 400, 400, 400, 400, 400, 400, 400, 400, 400]

async function run(name: string, rt: number, hist: number, body: (ctx: Ctx, w: World) => Promise<void>, env: Record<string, string> = {}): Promise<{ res: ScenarioResult; world: World; slots: number; pending: number }> {
	let world!: World
	let slots = -1
	let pending = -1
	const s: Scenario = {
		name,
		env: { ...BASE_ENV, ...env },
		body: async (ctx) => {
			seedValidators(ctx)
			world = buildWorld(ctx, 31337)
			headPlan(ctx, HEADS)
			await body(ctx, world)
			const core = recoverPayoutState(ctx.stateDir, { readOnly: true }).core
			slots = core.slotCount
			pending = core.pendingSize
		},
	}
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: rt, history: hist, sendDelayMs: 15 } })
	return { res, world, slots, pending }
}
const minedTotal = (ctx: Ctx): bigint => [...ctx.chain.sent.values()].filter((t) => t.mined && t.status === 1).reduce((a, t) => a + t.amountWei, 0n)
function atMostOnce(res: ScenarioResult, world: World, label: string): void {
	for (const [k, n] of Object.entries(res.paymentsPerEventKey)) {
		assert.equal(n, 1, `${label}: key ${k} in ${n} transactions`)
		assert.ok(world.expected.has(k), `${label}: unexpected key ${k}`)
	}
	// every transaction's amount is the sum of its keys to the wei
	for (const t of res.chainSent) assert.ok(BigInt(t.amountWei) > 0n)
}

/** Records, at every send the pool signers accept, the running total of everything sent so far (booked or not): it must never exceed the initial balance. */
function trackSent(ctx: Ctx, initial: bigint): { max: () => bigint } {
	let running = 0n
	let max = 0n
	for (const sg of ctx.poolSigners.values())
		sg.afterRecord = (tx) => {
			void tx
			// the amount of the transaction just recorded
			const last = [...ctx.chain.sent.values()].at(-1)
			if (last) running += last.amountWei
			if (running > max) max = running
		}
	void initial
	return { max: () => max }
}

test('A: balance for about 35% of what is owed, pool 2x2: payout and everything in flight never exceed the balance; refuse batch appears; nobody is isolated; the uncovered keys stay pending; every key at most once', { timeout: 300_000 }, async () => {
	let initial = 0n
	let sentMax = 0n
	let paid = 0n
	let balanceEnd = 0n
	const r = await run('pm_a', 2, 2, async (ctx, w) => {
		initial = (w.totalWei * 35n) / 100n
		ctx.chain.balanceWei = initial
		const t = trackSent(ctx, initial)
		ctx.chain.onRequest = async () => void (await new Promise((res) => setTimeout(res, 1)))
		await ctx.run({ ticks: 14, timeoutMs: 240_000 })
		sentMax = t.max()
		paid = minedTotal(ctx)
		balanceEnd = ctx.chain.balanceWei
	})
	assert.ok(sentMax <= initial, `at some send the running total sent (${sentMax}) exceeded the balance (${initial})`)
	assert.ok(paid <= initial, `chain-side payout ${paid} > initial balance ${initial}`)
	assert.ok(balanceEnd >= 0n, 'the contract balance never went negative')
	assert.ok(paid > 0n, 'something was paid')
	assert.ok(r.res.logs.flat().some((l) => l.includes('refuse batch')), 'a batch was refused for lack of balance')
	assert.ok(!r.res.logs.flat().some((l) => /wallet \S+ isolated/.test(l)), 'no wallet was isolated by the shortage')
	assert.ok(r.pending > 0, 'the keys the balance could not cover are still pending')
	assert.equal(r.slots, 0)
	atMostOnce(r.res, r.world, 'A')
	process.stderr.write(`money A: initial=${initial} paid=${paid} maxSentRunning=${sentMax} pendingLeft=${r.pending}\n`)
})

test('B: balance reads failing for a whole run: zero signer requests and no slot; once the read works everything is paid, every key once', { timeout: 300_000 }, async () => {
	let failing = true
	let slotsDuring = -1
	let sendsDuring = -1
	const r = await run('pm_b', 2, 1, async (ctx) => {
		ctx.chain.onRequest = async (m) => (m === 'eth_getBalance' && failing ? { status: 500 } : undefined)
		await ctx.run({ ticks: 12, timeoutMs: 200_000 })
		slotsDuring = recoverPayoutState(ctx.stateDir, { readOnly: true }).core.slotCount
		sendsDuring = [...ctx.poolSigners.values()].reduce((a, sg) => a + sg.requests.filter((q) => q.method === 'signer_sendTransaction').length, 0)
		failing = false
		await ctx.run({ ticks: 12, timeoutMs: 200_000 })
	})
	assert.equal(sendsDuring, 0, 'no send while the balance cannot be read')
	assert.equal(slotsDuring, 0, 'no slot was created while the balance cannot be read')
	assert.deepEqual(Object.keys(r.res.paymentsPerEventKey).sort(), [...r.world.expected.keys()].sort(), 'afterwards every payable key was paid')
	atMostOnce(r.res, r.world, 'B')
	assert.equal(r.slots, 0)
	assert.equal(r.pending, 0)
})

test('C: the realtime wallet and the history wallet race for a balance that covers exactly ONE batch: exactly one batch is paid, the other refuses, total <= balance, nobody is isolated', { timeout: 300_000 }, async () => {
	let paid = 0n
	let initial = 0n
	let pendingKeys = 0
	let batches = 0
	const s: Scenario = {
		name: 'pm_c',
		env: { ...BASE_ENV },
		body: async (ctx) => {
			seedValidators(ctx)
			headPlan(ctx, [300, 300, 300, 300, 300, 300, 300, 300])
			ctx.chain.head = 300
			const amount = 5_000_000_000_000_000n // 0.005 CNET per entry; a batch of 12 = 0.06 CNET
			const mk = (i: number, block: number): Record<string, unknown> => ({ eventKey: ethers.keccak256(ethers.toUtf8Bytes(`pm-c-${i}`)), amount: amount.toString(), blockNumber: block, withdrawalIndex: i, pubkey: ctx.labPubkeys[0] })
			ctx.seedState({
				lastBackfillProcessedBlock: 300,
				historyCursor: 300,
				realtimeCursor: 300,
				lastLiveHeadScanned: 300,
				freezeH: { height: 300, hash: ctx.chain.blockHash(300), frozenAt: new Date().toISOString() },
				pending: [...Array.from({ length: 12 }, (_, i) => mk(i, 200 + i)), ...Array.from({ length: 12 }, (_, i) => mk(100 + i, 310 + i))], // 12 history (<= H) and 12 realtime (> H)
				consumedEventKeys: {},
				exitedPubkeys: {},
			})
			initial = 12n * amount + 1_000_000_000_000_000n // one batch plus a bit, not two
			ctx.chain.balanceWei = initial
			await ctx.run({ ticks: 8, timeoutMs: 200_000 })
			paid = minedTotal(ctx)
			batches = ctx.chain.sent.size
			pendingKeys = recoverPayoutState(ctx.stateDir, { readOnly: true }).core.pendingSize
		},
	}
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: 1, history: 1, sendDelayMs: 15 } })
	assert.equal(batches, 1, `exactly one batch was sent (${batches})`)
	assert.ok(paid <= initial, `paid ${paid} > balance ${initial}`)
	assert.equal(pendingKeys, 12, 'the other line\'s 12 keys are still pending')
	assert.ok(res.logs.flat().some((l) => l.includes('refuse batch')), 'the other wallet refused')
	assert.ok(!res.logs.flat().some((l) => /wallet \S+ isolated/.test(l)))
	for (const [, n] of Object.entries(res.paymentsPerEventKey)) assert.equal(n, 1)
	assert.equal(res.exits[res.exits.length - 1]!.code, 0)
})

test('C2 (deterministic): both wallets have CLAIMED and are blocked inside the balance read when it is released together: the claims of the others alone must keep both from sending - at most one batch is paid, total <= balance', { timeout: 300_000 }, async () => {
	// Review r3: C alone depends on natural scheduling. Here the balance read of the first two asks is held until both are pending, so both wallets are inside the claim window at the same instant
	// (slots are still empty: only the other wallet's CLAIM can tell them apart). Without the claims term both would read the full balance and both would send.
	let paid = 0n
	let initial = 0n
	let batches = 0
	let barrierBothArrived = false
	let sendsWhileHeld = -1
	const s: Scenario = {
		name: 'pm_c2',
		env: { ...BASE_ENV },
		body: async (ctx) => {
			seedValidators(ctx)
			headPlan(ctx, [300, 300, 300, 300, 300, 300, 300, 300])
			ctx.chain.head = 300
			const amount = 5_000_000_000_000_000n
			const mk = (i: number, block: number): Record<string, unknown> => ({ eventKey: ethers.keccak256(ethers.toUtf8Bytes(`pm-c2-${i}`)), amount: amount.toString(), blockNumber: block, withdrawalIndex: i, pubkey: ctx.labPubkeys[0] })
			ctx.seedState({
				lastBackfillProcessedBlock: 300,
				historyCursor: 300,
				realtimeCursor: 300,
				lastLiveHeadScanned: 300,
				freezeH: { height: 300, hash: ctx.chain.blockHash(300), frozenAt: new Date().toISOString() },
				pending: [...Array.from({ length: 12 }, (_, i) => mk(i, 200 + i)), ...Array.from({ length: 12 }, (_, i) => mk(100 + i, 310 + i))],
				consumedEventKeys: {},
				exitedPubkeys: {},
			})
			initial = 12n * amount + 1_000_000_000_000_000n
			ctx.chain.balanceWei = initial
			let arrived = 0
			let released = false
			ctx.chain.onRequest = async (m) => {
				if (m !== 'eth_getBalance' || released) return
				arrived++
				if (arrived > 2) return
				const t0 = Date.now()
				while (arrived < 2 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 5))
				if (arrived >= 2 && !released) {
					barrierBothArrived = true
					sendsWhileHeld = [...ctx.poolSigners.values()].reduce((a, sg) => a + sg.requests.filter((q) => q.method === 'signer_sendTransaction').length, 0)
					released = true
				}
			}
			await ctx.run({ ticks: 8, timeoutMs: 200_000 })
			paid = minedTotal(ctx)
			batches = ctx.chain.sent.size
		},
	}
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: 1, history: 1, sendDelayMs: 15 } })
	assert.ok(barrierBothArrived, 'both wallets were inside the balance read at the same time (the test is valid)')
	assert.equal(sendsWhileHeld, 0, 'nothing was sent before the reads were released')
	assert.equal(batches, 1, `exactly one batch is paid, ${batches} were sent (without the other wallets' claims both read the full balance)`)
	assert.ok(paid <= initial, `paid ${paid} > balance ${initial}`)
	assert.ok(res.logs.flat().some((l) => l.includes('refuse batch') && /others=0\.0[0-9]/.test(l)), 'a wallet refused because the OTHER wallet\'s claim was subtracted (others > 0 in the line)')
	for (const [, n] of Object.entries(res.paymentsPerEventKey)) assert.equal(n, 1)
	assert.ok(!res.logs.flat().some((l) => /wallet \S+ isolated/.test(l)))
})

test('S (deterministic): wallet A has a COMMITTED slot (sent, receipt late) and wallet B reads the balance only after that send: the balance is not deducted yet, only the slot amount keeps B from sending - exactly one batch is paid', { timeout: 300_000 }, async () => {
	let paid = 0n
	let initial = 0n
	let batches = 0
	let heldThenReleasedAfterSend = false
	const s: Scenario = {
		name: 'pm_s',
		env: { ...BASE_ENV },
		body: async (ctx) => {
			seedValidators(ctx)
			headPlan(ctx, [300, 300, 300, 300, 300, 300, 300, 300])
			ctx.chain.head = 300
			const amount = 5_000_000_000_000_000n
			const mk = (i: number, block: number): Record<string, unknown> => ({ eventKey: ethers.keccak256(ethers.toUtf8Bytes(`pm-s-${i}`)), amount: amount.toString(), blockNumber: block, withdrawalIndex: i, pubkey: ctx.labPubkeys[0] })
			ctx.seedState({
				lastBackfillProcessedBlock: 300,
				historyCursor: 300,
				realtimeCursor: 300,
				lastLiveHeadScanned: 300,
				freezeH: { height: 300, hash: ctx.chain.blockHash(300), frozenAt: new Date().toISOString() },
				pending: [...Array.from({ length: 12 }, (_, i) => mk(i, 200 + i)), ...Array.from({ length: 12 }, (_, i) => mk(100 + i, 310 + i))],
				consumedEventKeys: {},
				exitedPubkeys: {},
			})
			initial = 12n * amount + 1_000_000_000_000_000n // one batch plus a bit: a second batch only fits if the first one's money is not subtracted
			ctx.chain.balanceWei = initial
			// the receipt of the first transaction stays empty for a while: its slot is committed, the balance is NOT deducted yet
			ctx.chain.receiptRule = (_tx, ask) => (ask <= 12 ? 'none' : 'mined')
			// the first balance read passes (the wallet that gets to send first); every later one is held until that send exists
			let firstPassed = false
			ctx.chain.onRequest = async (m) => {
				if (m !== 'eth_getBalance') return
				if (!firstPassed) {
					firstPassed = true
					return
				}
				const t0 = Date.now()
				while (ctx.chain.sent.size === 0 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 5))
				if (ctx.chain.sent.size >= 1) heldThenReleasedAfterSend = true
			}
			await ctx.run({ ticks: 8, timeoutMs: 200_000 })
			paid = minedTotal(ctx)
			batches = ctx.chain.sent.size
		},
	}
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: 1, history: 1, sendDelayMs: 15 } })
	assert.ok(heldThenReleasedAfterSend, 'a balance read was held until the first send existed (the test is valid)')
	assert.equal(batches, 1, `exactly one batch is sent (${batches}); without the slot amount the second wallet would read the full balance and send too`)
	assert.ok(paid <= initial, `paid ${paid} > balance ${initial}`)
	assert.ok(res.logs.flat().some((l) => l.includes('refuse batch') && /others=0\.06/.test(l)), 'the other wallet refused because of the committed slot (others = 0.06)')
	for (const [, n] of Object.entries(res.paymentsPerEventKey)) assert.equal(n, 1)
})

test('E (boundary): a balance EXACTLY equal to one batch pays it (one wei less would not); the other wallet refuses', { timeout: 300_000 }, async () => {
	let paid = 0n
	let initial = 0n
	let batches = 0
	const s: Scenario = {
		name: 'pm_e',
		env: { ...BASE_ENV },
		body: async (ctx) => {
			seedValidators(ctx)
			headPlan(ctx, [300, 300, 300, 300, 300, 300, 300, 300])
			ctx.chain.head = 300
			const amount = 5_000_000_000_000_000n
			const mk = (i: number, block: number): Record<string, unknown> => ({ eventKey: ethers.keccak256(ethers.toUtf8Bytes(`pm-e-${i}`)), amount: amount.toString(), blockNumber: block, withdrawalIndex: i, pubkey: ctx.labPubkeys[0] })
			ctx.seedState({
				lastBackfillProcessedBlock: 300,
				historyCursor: 300,
				realtimeCursor: 300,
				lastLiveHeadScanned: 300,
				freezeH: { height: 300, hash: ctx.chain.blockHash(300), frozenAt: new Date().toISOString() },
				pending: [...Array.from({ length: 12 }, (_, i) => mk(i, 200 + i)), ...Array.from({ length: 12 }, (_, i) => mk(100 + i, 310 + i))],
				consumedEventKeys: {},
				exitedPubkeys: {},
			})
			initial = 12n * amount // exactly one batch of 12, nothing to spare
			ctx.chain.balanceWei = initial
			await ctx.run({ ticks: 8, timeoutMs: 200_000 })
			paid = minedTotal(ctx)
			batches = ctx.chain.sent.size
		},
	}
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: 1, history: 1, sendDelayMs: 15 } })
	assert.equal(batches, 1, `exactly one batch is paid (${batches})`)
	assert.equal(paid, initial, 'the balance was paid out to the wei')
	assert.ok(res.logs.flat().some((l) => l.includes('refuse batch')), 'the other wallet refused')
	for (const [, n] of Object.entries(res.paymentsPerEventKey)) assert.equal(n, 1)
})

test('GAS1: a wallet whose signer answers "insufficient funds" alerts at once, holds its batch in its slot, is not isolated, does not hand the batch over; the healthy wallet keeps paying', { timeout: 300_000 }, async () => {
	let alerts: string[] = []
	let slotsAtEnd = -1
	let rt2Sends = -1
	const r = await run('pm_gas1', 2, 1, async (ctx) => {
		ctx.poolSigners.get('rt2')!.mode = 'nogas'
		await ctx.run({ ticks: 14, timeoutMs: 120_000 })
		slotsAtEnd = recoverPayoutState(ctx.stateDir, { readOnly: true }).core.slotCount
		rt2Sends = ctx.poolSigners.get('rt2')!.requests.filter((q) => q.method === 'signer_sendTransaction').length
	})
	alerts = r.res.logs.flat().filter((l) => l.includes('ALERT wallet rt2') && l.includes('balance shortage'))
	assert.ok(alerts.length >= 1, 'an ALERT naming wallet rt2 and the balance shortage')
	assert.ok(alerts.length <= 2, `at most one alert per minute per wallet (${alerts.length} in a run of seconds)`)
	assert.ok(rt2Sends >= 1, 'rt2 did try to send')
	assert.ok(!r.res.logs.flat().some((l) => /wallet rt2 isolated/.test(l)), 'not isolated')
	assert.ok(r.res.logs.flat().every((l) => !(l.includes('ALERT wallet rt1') && l.includes('send failed'))), 'the healthy wallet raised no gas alert')
	assert.ok(slotsAtEnd >= 1, 'rt2 still holds its batch')
	assert.ok(Object.keys(r.res.paymentsPerEventKey).length > 0, 'the healthy wallet paid')
	atMostOnce(r.res, r.world, 'GAS1')
})

test('GAS2: a non-gas send failure alerts only from the THIRD failed pass in a row', { timeout: 300_000 }, async () => {
	const r = await run('pm_gas2', 2, 1, async (ctx) => {
		ctx.poolSigners.get('rt2')!.mode = 'flaky'
		await ctx.run({ ticks: 14, timeoutMs: 120_000 })
	})
	const lines = r.res.logs.flat()
	const firstAlert = lines.findIndex((l) => l.includes('ALERT wallet rt2') && l.includes('send failed'))
	assert.ok(firstAlert >= 0, 'rt2 alerted after repeated failures')
	const unresolvedBefore = lines.slice(0, firstAlert).filter((l) => l.includes('withdrawNative send unresolved') && l.includes('in-flight batch kept')).length
	assert.ok(unresolvedBefore >= 2, `the alert came after at least two failed passes (${unresolvedBefore})`)
	assert.ok(!lines.some((l) => l.includes('balance shortage')), 'a non-gas error is not called a balance shortage')
	assert.ok(!lines.some((l) => /wallet rt2 isolated/.test(l)))
})

test('D1: low balance and kill -9 right after a send: the restart resumes, no key twice, total <= balance', { timeout: 300_000 }, async () => {
	let initial = 0n
	let paid = 0n
	const r = await run('pm_d1', 2, 1, async (ctx, w) => {
		initial = (w.totalWei * 50n) / 100n
		ctx.chain.balanceWei = initial
		const rt1 = ctx.poolSigners.get('rt1')!
		let fired = 0
		rt1.afterRecord = () => {
			if (fired++ === 0) ctx.currentChild?.kill('SIGKILL')
		}
		await ctx.run({ ticks: 12, timeoutMs: 120_000 })
		rt1.afterRecord = undefined
		await ctx.run({ ticks: 12, timeoutMs: 200_000 })
		paid = minedTotal(ctx)
	})
	assert.equal(r.res.exits[0]!.signal, 'SIGKILL')
	assert.ok(paid <= initial, `paid ${paid} > ${initial}`)
	atMostOnce(r.res, r.world, 'D1')
	assert.equal(r.slots, 0)
})

test('D2: low balance and a lost ACK across a restart: the recorded send is recovered, no key twice, total <= balance', { timeout: 300_000 }, async () => {
	let initial = 0n
	let paid = 0n
	const r = await run('pm_d2', 2, 1, async (ctx, w) => {
		initial = (w.totalWei * 50n) / 100n
		ctx.chain.balanceWei = initial
		const sg = ctx.poolSigners.get('rt2')!
		sg.mode = 'lose-ack'
		await ctx.run({ ticks: 12, timeoutMs: 120_000, killWhen: () => sg.acksLost >= 1 })
		assert.ok(sg.acksLost >= 1)
		sg.mode = 'ok'
		await ctx.run({ ticks: 12, timeoutMs: 200_000 })
		paid = minedTotal(ctx)
		assert.ok(sg.duplicateSends + sg.getTransactionCalls >= 1, 'recovered through the signer')
	})
	assert.ok(paid <= initial, `paid ${paid} > ${initial}`)
	atMostOnce(r.res, r.world, 'D2')
	assert.equal(r.slots, 0)
})

test('D3: low balance and a late receipt in-process: the slot is kept and resumed, no key twice, total <= balance', { timeout: 300_000 }, async () => {
	let initial = 0n
	let paid = 0n
	const r = await run(
		'pm_d3',
		2,
		1,
		async (ctx, w) => {
			initial = (w.totalWei * 50n) / 100n
			ctx.chain.balanceWei = initial
			let slow: string | undefined
			ctx.chain.receiptRule = (tx, ask) => {
				slow ??= tx.idempotencyKey
				return tx.idempotencyKey === slow && ask <= 12 ? 'none' : 'mined'
			}
			await ctx.run({ ticks: 12, timeoutMs: 200_000 })
			paid = minedTotal(ctx)
			assert.ok(ctx.chain.emptyReceipts >= 1)
		},
		{ CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000' }
	)
	assert.ok(paid <= initial, `paid ${paid} > ${initial}`)
	atMostOnce(r.res, r.world, 'D3')
	assert.equal(r.slots, 0)
})

test('input: negative, fractional, hex and text reserve values refuse the start (exit 1, the message names the variable); 0 starts and is read back as `config minVdrBalanceReserveWei=0`', { timeout: 300_000 }, async () => {
	const outcomes: Record<string, { code: number | null; msg: boolean }> = {}
	let zeroLog = false
	await run('pm_input', 2, 1, async (ctx) => {
		for (const bad of ['-1', '1.5', '0x10', 'abc', '1e18']) {
			const r = await ctx.run({ ticks: 3, timeoutMs: 60_000, env: { CONET_LAB_MINING_POOL_CL_PAYOUT_MIN_VDR_BALANCE_RESERVE_WEI: bad } })
			outcomes[bad] = { code: r.code, msg: r.lines.some((l) => l.includes('MIN_VDR_BALANCE_RESERVE_WEI must be a non-negative integer')) }
		}
		const ok = await ctx.run({ ticks: 3, timeoutMs: 60_000, env: { CONET_LAB_MINING_POOL_CL_PAYOUT_MIN_VDR_BALANCE_RESERVE_WEI: '0' } })
		zeroLog = ok.lines.some((l) => l.includes('config minVdrBalanceReserveWei=0'))
		assert.equal(ok.code, 0)
	})
	for (const [bad, o] of Object.entries(outcomes)) {
		assert.equal(o.code, 1, `value "${bad}" must refuse the start`)
		assert.ok(o.msg, `the refusal for "${bad}" names the variable and the rule`)
	}
	assert.ok(zeroLog, 'the effective value 0 is read back on its own line')
})

test('TICKMODE: a bad CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MODE refuses the start (exit 1, the message names the variable); fixed and continuous start and say so in the start line', { timeout: 300_000 }, async () => {
	const out: Record<string, { code: number | null; msg: boolean; line: string | undefined }> = {}
	await run('pm_tickmode', 2, 1, async (ctx) => {
		for (const mode of ['bogus', 'Continuous', 'true', 'fixed', 'continuous']) {
			const r = await ctx.run({ ticks: 3, timeoutMs: 60_000, env: { CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MODE: mode } })
			out[mode] = { code: r.code, msg: r.lines.some((l) => l.includes('TICK_MODE must be "fixed" or "continuous"')), line: r.lines.find((l) => l.includes('starting dual-cursor+withdrawNative')) }
		}
	})
	for (const bad of ['bogus', 'Continuous', 'true']) {
		assert.equal(out[bad]!.code, 1, `TICK_MODE=${bad} must refuse the start`)
		assert.ok(out[bad]!.msg, `the refusal for ${bad} names the variable and the rule`)
		assert.equal(out[bad]!.line, undefined, 'no start line, nothing ran')
	}
	assert.equal(out.fixed!.code, 0)
	assert.match(out.fixed!.line ?? '', /tickMode=fixed idleBackoffMs=/)
	assert.equal(out.continuous!.code, 0)
	assert.match(out.continuous!.line ?? '', /tickMode=continuous idleBackoffMs=/)
})
