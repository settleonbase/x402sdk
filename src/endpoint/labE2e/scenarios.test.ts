/**
 * P2c-0 scenarios (data only; run by ../labE2e.test.ts). Chain layout: pool deploy block 100, CHUNK_BLOCKS 10, CHUNKS_PER_TICK 4.
 * The head advances by a plan (one value per eth_blockNumber call = one per tick).
 */
import { ethers } from 'ethers'
import { readSegmentedState, writeSegmentedState } from '../labClPayoutStateStore'
import type { Ctx, Scenario } from './harness.test'

export const eventKeyOf = (block: number, index: number): string => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(block), BigInt(index)]))

/** validator i (0..5) is a Lab validator with that pubkey; 6 is not Lab. */
export function seedValidators(ctx: Ctx): void {
	ctx.labPubkeys.forEach((pk, i) => ctx.beacon.validators.set(i, { pubkey: pk, status: 'active_ongoing' }))
	ctx.beacon.validators.set(6, { pubkey: ethers.hexlify(ethers.randomBytes(48)).toLowerCase(), status: 'active_ongoing' })
}

/** The head per tick: the first tick sees heads[0]; the child asks the fake chain for the next value at the start of every later scheduled tick (see childMain / FakeChain.tickHeads). */
export function headPlan(ctx: Ctx, heads: number[]): void {
	ctx.chain.tickHeads = heads
	ctx.chain.tickIndex = 0
	ctx.chain.head = heads[0]!
}

/** a few withdrawals of 1 gwei*k on the history range (100..120) and on the realtime range (>120) */
export function seedWithdrawals(ctx: Ctx): void {
	const hist: [number, number, number, bigint][] = [
		[102, 0, 0, 5_000_000n],
		[105, 0, 1, 7_000_000n],
		[105, 1, 2, 3_000_000n],
		[110, 0, 3, 11_000_000n],
		[117, 0, 4, 13_000_000n],
	]
	for (const [b, i, v, g] of hist) ctx.chain.addWithdrawal(b, { index: i, validatorIndex: v, amountGwei: g })
	const rt: [number, number, number, bigint][] = [
		[122, 0, 1, 2_000_000n],
		[124, 0, 2, 4_000_000n],
		[126, 0, 5, 6_000_000n],
	]
	for (const [b, i, v, g] of rt) ctx.chain.addWithdrawal(b, { index: i, validatorIndex: v, amountGwei: g })
	// noise: a non-Lab validator and a withdrawal to another address
	ctx.chain.addWithdrawal(108, { index: 0, validatorIndex: 6, amountGwei: 9_000_000n })
	ctx.chain.addWithdrawal(112, { index: 0, validatorIndex: 0, amountGwei: 1_000_000n, address: '0x00000000000000000000000000000000000000aa' })
}

const ENV_INVC = 'CONET_LAB_MINING_POOL_CL_PAYOUT_HISTORY_PAY_BEHIND_CURSOR'
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
const hist = (i: number, block: number, amountWei = '1000000000000000'): Record<string, unknown> => ({ eventKey: eventKeyOf(block, i), amount: amountWei, blockNumber: block, withdrawalIndex: i, pubkey: '0x' + '11'.repeat(48) })
/** A state as an earlier run could have left it: history entries on both sides of the history cursor. */
function seedAheadOfCursor(ctx: Ctx): void {
	ctx.seedState({
		lastBackfillProcessedBlock: 104,
		historyCursor: 104,
		realtimeCursor: 120,
		lastLiveHeadScanned: 120,
		freezeH: { height: 120, hash: ethers.keccak256(ethers.toUtf8Bytes('block:120')), frozenAt: new Date().toISOString() },
		pending: [hist(0, 101), hist(0, 103), hist(0, 109), hist(1, 109), hist(0, 115)],
		consumedEventKeys: {},
		exitedPubkeys: {},
	})
}

export const scenarios: Scenario[] = [
	{
		name: 's01_two_lines_pay',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '3' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 124, 128, 128])
			await ctx.run({ ticks: 4 })
		},
	},
	{
		// invariant C ON: history pays only up to the committed history cursor (104): blocks 101 and 103 are paid, 109 and 115 wait; the scan then advances the cursor and they become payable
		name: 's02_invariant_c_on',
		env: { [ENV_INVC]: '1', CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10', CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '1' },
		body: async (ctx) => {
			seedValidators(ctx)
			headPlan(ctx, [120, 120, 120])
			seedAheadOfCursor(ctx)
			await ctx.run({ ticks: 3 })
		},
	},
	{
		// the same state with the invariant OFF (default): everything pending is paid at once, as before P1
		name: 's03_invariant_c_off',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10', CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '1' },
		body: async (ctx) => {
			seedValidators(ctx)
			headPlan(ctx, [120, 120, 120])
			seedAheadOfCursor(ctx)
			await ctx.run({ ticks: 3 })
		},
	},
	{
		// gas above the cap: wait is recorded and nothing is paid (state keeps gasWaitStartedAt), then a forced flush once the wait is old enough
		name: 's04_gas_wait_then_force',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS: '60000' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 120])
			ctx.chain.gasPriceWei = 200_000_000n // above the 30,000,000 wei cap plus the 50,000,000 wei dust band
			await ctx.run({ ticks: 2 })
			// a later run finds a wait that started 10 minutes ago: force flush
			const st = readSegmentedState(ctx.stateDir) as Record<string, unknown>
			st.gasWaitStartedAt = ago(600_000)
			writeSegmentedState(ctx.stateDir, st)
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// the receipt says status 0: the batch is released and the daemon halts (exit 3); a restart then re-composes the same keys (same idempotency key: the signer returns the original hash)
		name: 's05_receipt_reverted',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			ctx.chain.receiptRule = () => 'reverted'
			await ctx.run({ ticks: 1 })
			ctx.chain.receiptRule = () => 'mined'
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// the receipt never shows (lost): after the wait the daemon halts with the in-flight record kept (exit 4); the restart resumes the SAME hash and settles when the receipt appears
		name: 's06_receipt_lost_then_restart',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10', CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			ctx.chain.receiptRule = () => 'none'
			await ctx.run({ ticks: 1, timeoutMs: 90_000 })
			ctx.chain.receiptRule = () => 'mined'
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// the receipt is late but arrives within the wait (first ask empty)
		name: 's07_receipt_delayed',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10', CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 124])
			ctx.chain.receiptRule = (_tx, ask) => (ask <= 1 ? 'none' : 'mined')
			await ctx.run({ ticks: 2, timeoutMs: 90_000 })
		},
	},
	{
		// the signer records the send and loses the connection (ACK lost): the daemon recovers the original hash by the idempotency key and settles
		name: 's08_signer_ack_lost',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			ctx.signer.mode = 'lose-ack'
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// the signer refuses (rejected): the batch stays in flight, nothing new is composed; after the signer recovers, a restart resumes and pays
		name: 's09_signer_rejected_then_ok',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			ctx.signer.mode = 'reject'
			await ctx.run({ ticks: 2 })
			ctx.signer.mode = 'ok'
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// guardian re-check at flush: a Lab validator gets a guardian with a beneficiary between the scan and the flush: its entries are held (not signed), the others are paid
		name: 's10_guardian_hold',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			const original = ctx.chain.onRequest
			let flipped = false
			ctx.chain.onRequest = async (method, params) => {
				await original?.(method, params)
				// the flush starts with the gas price read, after the scan: from here on validator 0 has a guardian with a beneficiary
				if (method === 'eth_gasPrice' && !flipped) {
					flipped = true
					ctx.chain.guardianOf.set(ethers.keccak256(ctx.labPubkeys[0]!).toLowerCase(), 7n)
					ctx.chain.beneficiaryOf.set('7', '0x00000000000000000000000000000000000000bb')
				}
			}
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// back-pressure: the history pool is above its level (10,000 entries seeded): the history line pauses, the realtime line still scans and pays
		name: 's11_backpressure',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_HISTORY: '10000', CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_ALL: '20000', CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '5', CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_MAX_BATCHES: '1' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 124])
			const pending: Record<string, unknown>[] = []
			for (let i = 0; i < 10_050; i++) pending.push(hist(i % 50, 101 + Math.floor(i / 50) % 18 + 1000 * Math.floor(i / 900), '1000000000000'))
			ctx.seedState({ lastBackfillProcessedBlock: 99, historyCursor: 99, realtimeCursor: 120, lastLiveHeadScanned: 120, freezeH: { height: 120, hash: ethers.keccak256(ethers.toUtf8Bytes('block:120')), frozenAt: new Date().toISOString() }, pending, consumedEventKeys: {}, exitedPubkeys: {} })
			await ctx.run({ ticks: 2 })
		},
	},
	{
		// consumed keys above the soft cap: oldest are pruned to the cold archive on the state write
		name: 's12_consumed_prune',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX: '10000', CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			const consumed: Record<string, true> = {}
			for (let i = 0; i < 10_300; i++) consumed[ethers.keccak256(ethers.toUtf8Bytes(`old-${i}`))] = true
			ctx.seedState({ lastBackfillProcessedBlock: 99, freezeH: undefined, pending: [], consumedEventKeys: consumed, exitedPubkeys: {} })
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// beacon 5xx for one Lab validator: the window is not advanced past the failure (unconfirmed), then the beacon recovers
		name: 's13_beacon_5xx',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 120, 120])
			ctx.beacon.failIndexes.add(2)
			await ctx.run({ ticks: 1 })
			ctx.beacon.failIndexes.clear()
			await ctx.run({ ticks: 2 })
		},
	},
	{
		// first-batch gate: MAX_SETTLED_BATCHES=1 stops after the first settled batch (exit 0); a second start with the gate already reached exits before any tick
		name: 's14_first_batch_gate',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10', CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_SETTLED_BATCHES: '1' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 124])
			await ctx.run({ ticks: 3 })
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// kill -9 right after the intent is persisted and the signer has the request but before it answers (the batch is in flight, the hash unknown to the daemon): restart recovers it by the idempotency key
		name: 's15_kill_after_signer_records',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			ctx.signer.afterRecord = () => {
				ctx.currentChild?.kill('SIGKILL')
			}
			await ctx.run({ ticks: 1 })
			ctx.signer.afterRecord = undefined
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// kill -9 when the first receipt is asked for (sent, not settled): restart resumes the same hash and settles without a second send
		name: 's16_kill_before_settle',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '10' },
		body: async (ctx) => {
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120])
			ctx.chain.receiptRule = () => {
				ctx.currentChild?.kill('SIGKILL')
				return 'none'
			}
			await ctx.run({ ticks: 1 })
			ctx.chain.receiptRule = () => 'mined'
			await ctx.run({ ticks: 1 })
		},
	},
	{
		// many more entries than one batch, both lines, several batches per tick, over many ticks: order and the per-line quotas
		name: 's17_many_batches_two_lines',
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '25', CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_MAX_BATCHES: '4', CONET_LAB_MINING_POOL_CL_PAYOUT_REALTIME_RESERVED: '1' },
		body: async (ctx) => {
			seedValidators(ctx)
			for (let b = 100; b < 120; b++) for (let i = 0; i < 10; i++) ctx.chain.addWithdrawal(b, { index: i, validatorIndex: (b + i) % 6, amountGwei: BigInt(1_000_000 + b * 10 + i) })
			for (let b = 121; b < 141; b++) for (let i = 0; i < 3; i++) ctx.chain.addWithdrawal(b, { index: i, validatorIndex: (b + i) % 6, amountGwei: BigInt(2_000_000 + b * 10 + i) })
			headPlan(ctx, [120, 130, 140, 140, 140, 140, 140, 140])
			await ctx.run({ ticks: 8 })
		},
	},
]
