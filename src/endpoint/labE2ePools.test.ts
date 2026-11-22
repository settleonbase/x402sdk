/**
 * P4 B2 end-to-end: the REAL reporter with a wallet pool (two lines, W wallets each, one fake signer and one lane per wallet) against the simulated chain / beacon. Asserted on the chain / signer side:
 * every payable event key is paid exactly once, the wei add up, every wallet of a line really paid (counted per fake signer), no wallet ever had two sends in progress, the slots are all clear at the end and
 * the recovered state has nothing pending. Run: node --import tsx --test src/endpoint/labE2ePools.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoverPayoutState } from './labPayoutRecovery'
import { runScenario, type Ctx, type Scenario } from './labE2e/harness.test'
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
function buildWorld(ctx: Ctx, seed: number): { expected: Map<string, bigint>; totalGwei: bigint } {
	const rnd = mulberry32(seed)
	const expected = new Map<string, bigint>()
	let total = 0n
	for (let block = 100; block <= 700; block++) {
		const n = rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 5)
		for (let i = 0; i < n; i++) {
			const validatorIndex = Math.floor(rnd() * 7)
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

async function poolRun(rt: number, hist: number, seed: number) {
	let world!: ReturnType<typeof buildWorld>
	let slotCount = -1
	let pendingLeft = -1
	let perWallet: Record<string, { txs: number; maxConcurrentSends: number }> = {}
	const s: Scenario = {
		name: `pools_${rt}x${hist}_${seed}`,
		env: {
			CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '12',
			CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '12',
			CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000',
		},
		body: async (ctx) => {
			seedValidators(ctx)
			world = buildWorld(ctx, seed)
			headPlan(ctx, [400, 460, 520, 580, 640, 700, 700, 700, 700, 700, 700, 700])
			await ctx.run({ ticks: 10, timeoutMs: 240_000 })
			const rec = recoverPayoutState(ctx.stateDir, { readOnly: true })
			slotCount = rec.core.slotCount
			pendingLeft = rec.core.pendingSize
			const byWallet: Record<string, { txs: number; maxConcurrentSends: number }> = {}
			for (const [id, sg] of ctx.poolSigners) byWallet[id] = { txs: sg.requests.filter((r) => r.method === 'signer_sendTransaction').length, maxConcurrentSends: sg.maxConcurrentSends }
			perWallet = byWallet
		},
	}
	const result = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: rt, history: hist, sendDelayMs: 30 } })
	return { result, world, slotCount, pendingLeft, perWallet }
}

for (const [rt, hist] of [[1, 1], [2, 2]] as const) {
	test(`pool ${rt} realtime x ${hist} history wallet(s): every payable key paid once to the wei, every wallet paid, no wallet had two sends at once, slots clear, nothing pending`, { timeout: 400_000 }, async () => {
		const r = await poolRun(rt, hist, 777)
		assert.deepEqual(r.result.unknownRpcMethods, [])
		assert.equal(r.result.exits[r.result.exits.length - 1]!.code, 0)
		assert.deepEqual(Object.keys(r.result.paymentsPerEventKey).sort(), [...r.world.expected.keys()].sort(), 'exactly the payable keys were paid')
		for (const [k, n] of Object.entries(r.result.paymentsPerEventKey)) assert.equal(n, 1, `key ${k} paid ${n} times`)
		const paidWei = r.result.chainSent.reduce((a, t) => a + BigInt(t.amountWei), 0n)
		assert.equal(paidWei, r.world.totalGwei * 1_000_000_000n, 'the wei add up')
		assert.equal(r.slotCount, 0, 'all slots clear')
		assert.equal(r.pendingLeft, 0, 'nothing pending')
		for (const [id, w] of Object.entries(r.perWallet)) {
			assert.ok(w.txs >= 1, `wallet ${id} paid at least one batch (${w.txs})`)
			assert.equal(w.maxConcurrentSends, 1, `wallet ${id}: never two sends in progress`)
		}
		process.stderr.write(`pools ${rt}x${hist}: ${r.world.expected.size} keys, ${r.result.chainSent.length} txs, per wallet ${JSON.stringify(r.perWallet)}\n`)
	})
}
