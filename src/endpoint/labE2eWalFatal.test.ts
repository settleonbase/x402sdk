/**
 * S2 (reviewer clarification on T1): when the log refuses an event (here: over the frame limit, CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_MAX_FRAME_BYTES) the REAL reporter process must terminate
 * (memory is already ahead of the log) and nothing may be sent afterwards. Then a restart on the same state without the limit must finish the work with every event key paid exactly once.
 *   limit 800   : the intent event of the first batch is refused -> exit 70, no signer request, no chain send
 *   limit 1000  : the intent passes and the send happens; a LATER lifecycle event is refused -> exit 70, exactly the one send, no second send; the durable intent covers the sent keys
 * (the limits were found by sweeping with 1-block chunks so that the scan events stay small: 600/700 refuse a scan event, 800 the intent, 900-1100 a later step, 1200 nothing)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runScenario, type Ctx, type Scenario } from './labE2e/harness.test'
import { eventKeyOf, headPlan, seedValidators, seedWithdrawals } from './labE2e/scenarios.test'

const EXPECTED = [[102, 0], [105, 0], [105, 1], [110, 0], [117, 0], [122, 0], [124, 0], [126, 0]].map(([b, i]) => eventKeyOf(b!, i!)).sort()
const ENV = { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '8', CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNK_BLOCKS: '1', CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '30' }

function scenario(limit: number, observe: (ctx: Ctx) => void): Scenario {
	return {
		name: `s2_overlimit_${limit}`,
		env: ENV,
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 124, 128, 128, 128, 128])
			await ctx.run({ ticks: 4, env: { CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_MAX_FRAME_BYTES: String(limit) } })
			observe(ctx)
			await ctx.run({ ticks: 6, env: { CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_MAX_FRAME_BYTES: '' } })
		},
	}
}

for (const [limit, sendsBeforeStop] of [[800, 0], [1000, 1]] as const) {
	test(`S2 WAL: an event the log refuses (limit ${limit} bytes) stops the real process (exit 70) with ${sendsBeforeStop} send(s) so far; a restart without the limit pays every key exactly once`, { timeout: 300_000 }, async () => {
		let sendsAtStop = -1
		const res = await runScenario(scenario(limit, (ctx) => void (sendsAtStop = ctx.chain.sent.size)), undefined, { walMode: true })
		assert.deepEqual(res.unknownRpcMethods, [])
		assert.equal(res.exits[0]!.code, 70, 'the first run terminated through the fail-stop (exit 70), it did not carry on')
		assert.equal(res.exits[0]!.killed, false)
		assert.ok(res.strayOutput.some((l) => /\[labWalStateHandle\] FATAL .*refused/.test(l)), `the fatal line was written: ${JSON.stringify(res.strayOutput)}`)
		assert.equal(sendsAtStop, sendsBeforeStop, 'no send after the refused event')
		assert.equal(res.exits[1]!.code, 0, 'the restart without the limit finishes')
		assert.deepEqual(Object.keys(res.paymentsPerEventKey).sort(), EXPECTED, 'every expected key is paid after the restart')
		for (const [k, n] of Object.entries(res.paymentsPerEventKey)) assert.equal(n, 1, `event key ${k} paid ${n} times`)
		assert.equal(res.logical!.pending.length, 0)
	})
}
