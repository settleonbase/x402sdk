/**
 * P4 C: fault matrix of the wallet pools on the REAL reporter (pool mode, per-wallet fake signers). Every fault is injected from the fake-service side and counted there (acksLost, duplicateSends,
 * getTransactionCalls, emptyReceipts, the signer journals); the end state of every scenario is the same: every payable key paid by exactly ONE transaction, the wei add up, no slot held, nothing pending
 * (except where a quarantine is the point). Scenarios: kill -9 after a wallet's send was recorded (per wallet), lost ACK across a restart, late receipt in-process, a status-0 receipt isolating ONE
 * wallet while the others go on (and the poison batch quarantined), SIGTERM during payment and during a scan, the one-shot exit with a busy scan tick, and the migration of a legacy single in-flight
 * record (match / no match / the state a crash between the two migration commits leaves).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { openWalSession } from './labWalSession'
import { recoverPayoutState } from './labPayoutRecovery'
import { readSegmentedState } from './labClPayoutStateStore'
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
type World = { expected: Map<string, bigint>; totalGwei: bigint }
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
				expected.set(eventKeyOf(block, i), amountGwei)
				total += amountGwei
			}
		}
	}
	return { expected, totalGwei: total }
}
const BASE_ENV = {
	CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '12',
	CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK: '12',
	CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000',
}
const HEADS = [250, 300, 350, 400, 400, 400, 400, 400, 400, 400, 400, 400]
const PLAIN_ENV = { CONET_LAB_MINING_POOL_CL_PAYOUT_POOLS_FILE: '', CONET_LAB_MINING_POOL_CL_PAYOUT_DECOUPLED: '', CONET_LAB_MINING_POOL_CL_PAYOUT_WAL: '' }

type End = { slots: number; pending: number; consumedAll: boolean }
function endState(ctx: Ctx, world: World): End {
	const core = recoverPayoutState(ctx.stateDir, { readOnly: true }).core
	return { slots: core.slotCount, pending: core.pendingSize, consumedAll: [...world.expected.keys()].every((k) => core.consumedHas(k)) }
}
function reconcile(res: ScenarioResult, world: World, end: End, label: string, opts: { except?: Set<string> } = {}): void {
	assert.deepEqual(res.unknownRpcMethods, [], label)
	const expected = [...world.expected.keys()].filter((k) => !opts.except?.has(k)).sort()
	assert.deepEqual(Object.keys(res.paymentsPerEventKey).sort(), expected, `${label}: exactly the payable keys were paid`)
	for (const [k, n] of Object.entries(res.paymentsPerEventKey)) assert.equal(n, 1, `${label}: key ${k} paid ${n} times`)
	const want = expected.reduce((a, k) => a + world.expected.get(k)!, 0n) * 1_000_000_000n
	assert.equal(res.chainSent.reduce((a, t) => a + BigInt(t.amountWei), 0n), want, `${label}: the wei add up`)
	assert.equal(end.slots, 0, `${label}: no slot held`)
	if (!opts.except) assert.equal(end.pending, 0, `${label}: nothing pending`)
	assert.equal(res.exits[res.exits.length - 1]!.code, 0, `${label}: the last run ended cleanly`)
}
const POOL = (rt = 2, hist = 1) => ({ realtime: rt, history: hist, sendDelayMs: 20 })

async function run(name: string, pools: ReturnType<typeof POOL> | undefined, body: (ctx: Ctx, w: World) => Promise<void>, env: Record<string, string> = {}, decoupledOnly = false): Promise<{ res: ScenarioResult; world: World; end: End }> {
	let world!: World
	let end!: End
	const s: Scenario = {
		name,
		env: { ...BASE_ENV, ...env },
		body: async (ctx) => {
			seedValidators(ctx)
			world = buildWorld(ctx, 31337)
			headPlan(ctx, HEADS)
			await body(ctx, world)
			end = endState(ctx, world)
		},
	}
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, ...(pools ? { pools } : {}) })
	void decoupledOnly
	return { res, world, end }
}

for (const target of ['rt1', 'rt2', 'hi1']) {
	test(`kill -9 right after wallet ${target}'s send was recorded, restart: the batch is resumed through the signer (duplicate or lookup counted on the signer side), every key once`, { timeout: 300_000 }, async () => {
		const r = await run(`pf_kill_${target}`, POOL(), async (ctx) => {
			const sg = ctx.poolSigners.get(target)!
			let fired = 0
			sg.afterRecord = () => {
				if (fired++ === 0) ctx.currentChild?.kill('SIGKILL')
			}
			await ctx.run({ ticks: 10, timeoutMs: 120_000 })
			sg.afterRecord = undefined
			await ctx.run({ ticks: 8, timeoutMs: 180_000 })
			const dups = [...ctx.poolSigners.values()].reduce((a, x) => a + x.duplicateSends + x.getTransactionCalls, 0)
			assert.ok(dups >= 1, `the recorded-but-unacknowledged send was recovered through the signer (duplicates+lookups ${dups})`)
			process.stderr.write(`pf kill ${target}: duplicateSends=${[...ctx.poolSigners.values()].map((x) => x.duplicateSends).join('/')} lookups=${[...ctx.poolSigners.values()].map((x) => x.getTransactionCalls).join('/')}\n`)
		})
		assert.equal(r.res.exits[0]!.signal, 'SIGKILL')
		reconcile(r.res, r.world, r.end, `kill ${target}`)
	})
}

test('lost ACK on wallet rt2 across a restart: the connection is really dropped (counted on the signer), the restart recovers the recorded send, every key once', { timeout: 300_000 }, async () => {
	const r = await run('pf_lostack', POOL(), async (ctx) => {
		const sg = ctx.poolSigners.get('rt2')!
		sg.mode = 'lose-ack'
		await ctx.run({ ticks: 10, timeoutMs: 120_000, killWhen: () => sg.acksLost >= 1 })
		assert.ok(sg.acksLost >= 1, 'an ACK was really lost')
		sg.mode = 'ok'
		await ctx.run({ ticks: 8, timeoutMs: 180_000 })
		assert.ok(sg.duplicateSends + sg.getTransactionCalls >= 1, `recovered through the signer (${sg.duplicateSends}+${sg.getTransactionCalls})`)
	})
	reconcile(r.res, r.world, r.end, 'lost ack')
})

test('late receipt in-process: the receipt shows after several empty asks (counted on the chain), the wallet keeps its slot and resumes it on the next pass, no restart, every key once', { timeout: 300_000 }, async () => {
	const r = await run(
		'pf_late',
		POOL(),
		async (ctx) => {
			let asks = 0
			ctx.chain.receiptRule = () => (++asks <= 6 ? 'none' : 'mined')
			await ctx.run({ ticks: 10, timeoutMs: 180_000 })
			assert.ok(ctx.chain.emptyReceipts >= 1, `a receipt was really withheld (${ctx.chain.emptyReceipts})`)
		},
		{ CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '2500' }
	)
	reconcile(r.res, r.world, r.end, 'late receipt')
	assert.ok(r.res.logs.some((l) => l.some((x) => x.includes('the slot stays and the next pass resumes it'))), 'the wallet-level halt(4) path ran')
})

test('a status-0 receipt isolates ONE wallet (ALERT), its batch is quarantined, the other wallets keep paying every other key exactly once', { timeout: 300_000 }, async () => {
	let revertedKeys: string[] = []
	const r = await run('pf_status0', POOL(2, 1), async (ctx) => {
		const rt1 = ctx.poolSigners.get('rt1')!
		let first: string | undefined
		ctx.chain.receiptRule = (tx) => {
			if (rt1.byKey.has(tx.idempotencyKey)) {
				first ??= tx.idempotencyKey
				if (tx.idempotencyKey === first) return 'reverted'
			}
			return 'mined'
		}
		await ctx.run({ ticks: 10, timeoutMs: 180_000 })
		revertedKeys = [...ctx.chain.sent.values()].filter((t) => t.idempotencyKey === first).flatMap((t) => t.eventKeys)
	})
	assert.ok(revertedKeys.length > 0, 'a batch really came back with status 0')
	const logs = r.res.logs.flat()
	assert.ok(logs.some((l) => l.includes('wallet rt1 isolated')), 'wallet rt1 isolated')
	assert.ok(logs.some((l) => l.includes('ALERT quarantined')), 'the poison batch was quarantined')
	assert.ok(!logs.some((l) => l.includes('wallet rt2 isolated')), 'only the wallet that saw the revert is isolated')
	reconcile(r.res, r.world, { ...r.end }, 'status 0', { except: new Set(revertedKeys) })
	// the reverted tx was NOT counted as paid (its keys stay pending, quarantined)
	assert.ok(r.end.pending >= revertedKeys.length)
})

test('SIGTERM while a wallet is paying: the stop waits for the pass, the exit is clean or keeps the log (never loses a send), a restart finishes: every key once', { timeout: 300_000 }, async () => {
	const r = await run('pf_term_pay', POOL(), async (ctx) => {
		await ctx.run({ ticks: 12, timeoutMs: 120_000, termWhen: (e) => e.kind === 'signer' && e.method === 'signer_sendTransaction' })
		await ctx.run({ ticks: 8, timeoutMs: 180_000 })
	})
	const first = r.res.exits[0]!
	assert.ok(first.code === 0 || first.code === 1, `first run exit ${JSON.stringify(first)}`)
	process.stderr.write(`pf term-pay: first run exit code ${first.code} signal ${first.signal}\n`)
	reconcile(r.res, r.world, r.end, 'sigterm pay')
})

test('SIGTERM in the middle of a scan tick (slow chain): the stop waits for the tick, a restart finishes: every key once', { timeout: 300_000 }, async () => {
	const r = await run('pf_term_scan', POOL(), async (ctx) => {
		let calls = 0
		ctx.chain.onRequest = async () => {
			calls++
			if (calls === 60) ctx.currentChild?.kill('SIGTERM')
			await new Promise((res) => setTimeout(res, 3))
		}
		await ctx.run({ ticks: 12, timeoutMs: 120_000 })
		ctx.chain.onRequest = async () => undefined
		await ctx.run({ ticks: 8, timeoutMs: 180_000 })
	})
	assert.ok(r.res.exits[0]!.code === 0 || r.res.exits[0]!.code === 1)
	reconcile(r.res, r.world, r.end, 'sigterm scan')
})

test('one-shot exit (MAX_SETTLED_BATCHES) while a scan tick is still running and the idle wait runs out: the process exits non-zero like a crash, the restart finds a consistent state and pays every key once', { timeout: 300_000 }, async () => {
	const r = await run(
		'pf_max_busy',
		undefined,
		async (ctx) => {
			ctx.chain.onRequest = async () => void (await new Promise((res) => setTimeout(res, 40))) // a scan tick takes seconds
			await ctx.run({ ticks: 12, timeoutMs: 120_000, env: { CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_SETTLED_BATCHES: '1', CONET_LAB_MINING_POOL_CL_PAYOUT_SHUTDOWN_IDLE_WAIT_MS: '300' } })
			ctx.chain.onRequest = async () => undefined
			await ctx.run({ ticks: 10, timeoutMs: 180_000 })
		},
		{}
	)
	process.stderr.write(`pf max-busy: first run exit ${JSON.stringify(r.res.exits[0])}\n`)
	assert.notEqual(r.res.exits[0]!.signal, 'SIGKILL')
	reconcile(r.res, r.world, r.end, 'max settled busy')
})

// ---------------------------------------------------------------- migration of a legacy single in-flight record
async function legacyInFlightRun(label: string, afterFirst: (ctx: Ctx, world: World) => Promise<void>, poolOpts: { keyArrayOfRt1?: string }): Promise<{ res: ScenarioResult; world: World; end: End; manifestVersionAfterRefusal?: number }> {
	let world!: World
	let end!: End
	let manifestVersionAfterRefusal: number | undefined
	const s: Scenario = {
		name: label,
		env: { ...BASE_ENV },
		body: async (ctx) => {
			seedValidators(ctx)
			world = buildWorld(ctx, 4242)
			headPlan(ctx, HEADS)
			// run 1: the PLAIN daemon (version 2 state, coupled), killed when the signer has the request and the intent is persisted but nothing is recorded
			ctx.signer.beforeRecord = () => ctx.currentChild?.kill('SIGKILL')
			await ctx.run({ ticks: 10, timeoutMs: 120_000, env: PLAIN_ENV })
			ctx.signer.beforeRecord = undefined
			const m = JSON.parse(fs.readFileSync(path.join(ctx.stateDir, 'manifest.json'), 'utf8')) as { version: number }
			assert.equal(m.version, 2, 'the plain daemon left a version 2 state')
			await afterFirst(ctx, world)
			end = endState(ctx, world)
			void manifestVersionAfterRefusal
		},
	}
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: 2, history: 1, sendDelayMs: 20, legacyMatch: true, ...poolOpts } })
	return { res, world, end, manifestVersionAfterRefusal }
}

test('migration, one matching wallet: the legacy in-flight record moves into the slot of the wallet with the same address and key array and is resumed; every key once', { timeout: 300_000 }, async () => {
	const r = await legacyInFlightRun('pf_mig_match', async (ctx) => {
		await ctx.run({ ticks: 10, timeoutMs: 180_000 }) // pool mode
	}, {})
	assert.equal(r.res.exits[0]!.signal, 'SIGKILL')
	assert.ok(r.res.logs[1]!.some((l) => l.includes('migrated the legacy in-flight record')), 'migrated')
	reconcile(r.res, r.world, r.end, 'migration match')
})

test('migration, no matching wallet: the start is refused (exit 1) BEFORE the version 2 state is converted - the directory is still the plain version 2 state with its in-flight record - and the plain daemon then finishes the job; every key once', { timeout: 300_000 }, async () => {
	let versionAfter = -1
	let inFlightAfter = false
	const r = await legacyInFlightRun('pf_mig_nomatch', async (ctx) => {
		const refused = await ctx.run({ ticks: 4, timeoutMs: 60_000 }) // pool mode with a wallet whose key array differs: refused
		assert.equal(refused.code, 1, 'start refused')
		assert.ok(refused.lines.some((l) => l.includes('matches 0 wallet(s)') && l.includes('refusing to start')), 'the refusal names the record')
		versionAfter = (JSON.parse(fs.readFileSync(path.join(ctx.stateDir, 'manifest.json'), 'utf8')) as { version: number }).version
		inFlightAfter = Boolean((readSegmentedState(ctx.stateDir) as { inFlightWithdraw?: unknown }).inFlightWithdraw)
		await ctx.run({ ticks: 10, timeoutMs: 180_000, env: PLAIN_ENV }) // the plain daemon still starts from it
	}, { keyArrayOfRt1: 'some_other_key_array' })
	assert.equal(versionAfter, 2, 'a refused pool start leaves the version 2 manifest alone')
	assert.equal(inFlightAfter, true, 'and the in-flight record')
	reconcile(r.res, r.world, r.end, 'migration refused, then the plain daemon')
})
