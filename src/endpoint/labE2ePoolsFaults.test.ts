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
			let slow: string | undefined
			// the FIRST transaction's receipt stays empty for its first 12 asks (its wallet's 15 s wait ends empty: halt 4, slot kept), then it shows; every other transaction is mined at once
			ctx.chain.receiptRule = (tx, ask) => {
				slow ??= tx.idempotencyKey
				return tx.idempotencyKey === slow && ask <= 12 ? 'none' : 'mined'
			}
			await ctx.run({ ticks: 10, timeoutMs: 180_000 })
			assert.ok(ctx.chain.emptyReceipts >= 1, `a receipt was really withheld (${ctx.chain.emptyReceipts})`)
		},
		{ CONET_LAB_MINING_POOL_CL_PAYOUT_TX_WAIT_MS: '15000' }
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
	// the reverted transaction carries its keys once (no retry by another wallet: quarantined); every other payable key was paid by exactly one MINED transaction
	const rev = new Set(revertedKeys)
	assert.deepEqual(Object.keys(r.res.paymentsPerEventKey).sort(), [...r.world.expected.keys()].sort(), 'every payable key appears in exactly one transaction (the reverted batch included)')
	for (const [k, n] of Object.entries(r.res.paymentsPerEventKey)) assert.equal(n, 1, `key ${k} in ${n} transactions`)
	const mined = r.res.chainSent.filter((t) => t.mined)
	assert.equal(r.res.chainSent.length - mined.length, 0, 'every transaction got a receipt')
	assert.equal(r.end.slots, 0, 'no slot held')
	assert.equal(r.end.pending, rev.size, 'exactly the quarantined batch is still pending')
	assert.equal(r.res.exits[r.res.exits.length - 1]!.code, 0)
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
	const res = await runScenario(s, undefined, { walMode: true, decoupled: true, pools: { realtime: 2, history: 1, sendDelayMs: 20, legacyMatch: true, legacyWallet: 'hi1', ...poolOpts } })
	return { res, world, end, manifestVersionAfterRefusal }
}

test('migration, one matching wallet: the legacy in-flight record moves into the slot of the wallet with the same address and key array and is resumed; every key once', { timeout: 300_000 }, async () => {
	const r = await legacyInFlightRun('pf_mig_match', async (ctx) => {
		await ctx.run({ ticks: 10, timeoutMs: 180_000 }) // pool mode
	}, {})
	assert.equal(r.res.exits[0]!.signal, 'SIGKILL')
	assert.ok(r.res.logs[1]!.some((l) => l.includes('migrated the legacy in-flight record')), `migrated; run 2 lines: ${JSON.stringify(r.res.logs[1]!.slice(0, 14))} stray: ${JSON.stringify(r.res.strayOutput.slice(0, 6))} exits ${JSON.stringify(r.res.exits)}`)
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
		await ctx.run({ ticks: 60, timeoutMs: 280_000, env: PLAIN_ENV }) // the plain daemon still starts from it (two small batches per tick: many ticks)
	}, { keyArrayOfRt1: 'some_other_key_array' })
	assert.equal(versionAfter, 2, 'a refused pool start leaves the version 2 manifest alone')
	assert.equal(inFlightAfter, true, 'and the in-flight record')
	reconcile(r.res, r.world, r.end, 'migration refused, then the plain daemon')
})

// ---------------------------------------------------------------- adding and removing wallets across restarts
test('pool changes across restarts: a wallet that holds a slot cannot be removed (refused, nothing converted or lost), a draining wallet finishes its slot and claims nothing new, a wallet added later takes work; every key once', { timeout: 400_000 }, async () => {
	let slotAfterKill = ''
	let rt2SendsBefore = 0
	const r = await run('pf_pool_changes', POOL(3, 1), async (ctx) => {
		const poolsFile = path.join(ctx.dir, 'pools.json')
		const full = JSON.parse(fs.readFileSync(poolsFile, 'utf8')) as { realtime: { id: string; state: string }[]; history: unknown[] }
		const without = (ids: string[]) => ({ ...full, realtime: full.realtime.filter((w) => !ids.includes(w.id)) })
		const write = (v: unknown): void => fs.writeFileSync(poolsFile, JSON.stringify(v))
		// run 1: wallets rt1 and rt2 only; killed when rt2's send is recorded (its slot is committed, the ACK never arrives)
		write(without(['rt3']))
		const rt2 = ctx.poolSigners.get('rt2')!
		let fired = 0
		rt2.afterRecord = () => {
			if (fired++ === 0) ctx.currentChild?.kill('SIGKILL')
		}
		await ctx.run({ ticks: 10, timeoutMs: 120_000 })
		rt2.afterRecord = undefined
		const slots = [...recoverPayoutState(ctx.stateDir, { readOnly: true }).core.slotEntries()].map(([w]) => w)
		slotAfterKill = slots.join(',')
		assert.ok(slots.includes('rt2'), `rt2 holds a slot after the kill (${slots.join(',')})`)
		rt2SendsBefore = rt2.sends.length
		// run 2: rt2 removed from the file while it holds a slot -> refused, state untouched
		write(without(['rt2', 'rt3']))
		const refused = await ctx.run({ ticks: 4, timeoutMs: 60_000 })
		assert.equal(refused.code, 1)
		assert.ok(refused.lines.some((l) => l.includes('holds an in-flight slot of wallet rt2') && l.includes('refusing to start')), 'the refusal names the wallet')
		assert.deepEqual([...recoverPayoutState(ctx.stateDir, { readOnly: true }).core.slotEntries()].map(([w]) => w).sort(), slots.sort(), 'the slots are untouched by the refused start')
		// run 3: rt2 draining (finishes its slot, claims nothing new), rt3 added
		const drain = JSON.parse(JSON.stringify(full)) as typeof full
		drain.realtime.find((w) => w.id === 'rt2')!.state = 'draining'
		write(drain)
		await ctx.run({ ticks: 10, timeoutMs: 180_000 })
		const rt3 = ctx.poolSigners.get('rt3')!
		assert.ok(rt3.sends.length >= 1, `the added wallet rt3 paid (${rt3.sends.length})`)
		// a draining wallet may re-send its recorded batch (idempotent, same key) but claims no new one: at most ONE new send request keys from rt2 after the restart
		const newSends = rt2.sends.length - rt2SendsBefore
		assert.ok(newSends <= 1, `draining wallet rt2 made ${newSends} sends after the restart (only the resumed batch is allowed)`)
		process.stderr.write(`pf pool changes: slots after kill ${slotAfterKill}; rt2 sends after restart ${newSends}; rt3 sends ${rt3.sends.length}\n`)
	})
	reconcile(r.res, r.world, r.end, 'pool changes')
})

test('migration, crash between its two commits (the slot of the wallet was committed, the legacy record not yet cleared): the next start repairs it - the record exists once (in the slot), the batch is resumed, every key once', { timeout: 300_000 }, async () => {
	const r = await legacyInFlightRun('pf_mig_between', async (ctx) => {
		// the state the first commit of the migration leaves behind, built exactly as the daemon would: convert the v2 directory, commit the slot, leave the legacy scalar in place, stop
		const legacy = (readSegmentedState(ctx.stateDir) as { inFlightWithdraw?: Record<string, unknown> }).inFlightWithdraw
		assert.ok(legacy && legacy.line === 'history', 'the plain daemon left a history in-flight record')
		const session = await openWalSession({ stateDir: ctx.stateDir, legacyStateFile: ctx.stateFile, scanFloor: 100, log: () => undefined })
		const h = session.hub.actor('pay:hi1')
		h.setSlot('hi1', legacy!)
		await h.commit('intent')
		await session.scheduler.stop()
		await session.wal.close()
		const core = recoverPayoutState(ctx.stateDir, { readOnly: true }).core
		assert.ok(core.getSlot('hi1') && core.getInFlight(), 'both the slot and the legacy record exist now (the crash window)')
		await ctx.run({ ticks: 10, timeoutMs: 180_000 }) // pool mode
		const after = recoverPayoutState(ctx.stateDir, { readOnly: true }).core
		assert.equal(after.getInFlight(), null, 'the legacy record is gone')
	}, {})
	assert.ok(r.res.logs[1]!.some((l) => l.includes('migrated the legacy in-flight record')), 'the repair ran')
	reconcile(r.res, r.world, r.end, 'migration between commits')
})

// ---------------------------------------------------------------- the authorization read-back gate
test('a wallet that is not a VDR admin claims and sends nothing (ALERT, no signer request at all) until admins(address)=true; once granted it takes work; every key once', { timeout: 300_000 }, async () => {
	const r = await run('pf_admin_gate', POOL(2, 1), async (ctx) => {
		const addr = (id: string): string => (JSON.parse(fs.readFileSync(path.join(ctx.dir, 'pools.json'), 'utf8')) as { realtime: { id: string; address: string }[]; history: { id: string; address: string }[] }).realtime.concat((JSON.parse(fs.readFileSync(path.join(ctx.dir, 'pools.json'), 'utf8')) as { history: { id: string; address: string }[] }).history).find((w) => w.id === id)!.address.toLowerCase()
		const all = ['rt1', 'rt2', 'hi1'].map(addr)
		ctx.chain.adminAddrs = new Set(all.filter((a) => a !== addr('rt2'))) // rt2 is not an admin (yet)
		let calls = 0
		let granted = false
		ctx.chain.onRequest = async () => {
			calls++
			if (calls > 700 && !granted) {
				granted = true
				ctx.chain.adminAddrs!.add(addr('rt2')) // the grant happens mid-run (by the PM wallet, outside the daemon)
			}
			await new Promise((res) => setTimeout(res, 3))
		}
		const rt2 = ctx.poolSigners.get('rt2')!
		await ctx.run({ ticks: 14, timeoutMs: 200_000 })
		assert.ok(granted, 'the grant was made during the run')
		assert.ok(rt2.sends.length >= 1, `after the grant rt2 took work (${rt2.sends.length} sends)`)
	})
	assert.ok(r.res.logs.flat().some((l) => l.includes('ALERT wallet rt2') && l.includes('is not a VDR admin')), 'the ALERT names the wallet')
	reconcile(r.res, r.world, r.end, 'admin gate')
})

test('a wallet that is never an admin never reaches its signer: zero requests on its socket, the others pay every key', { timeout: 300_000 }, async () => {
	const r = await run('pf_admin_never', POOL(2, 1), async (ctx) => {
		const pools = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'pools.json'), 'utf8')) as { realtime: { id: string; address: string }[]; history: { id: string; address: string }[] }
		const others = [...pools.realtime, ...pools.history].filter((w) => w.id !== 'rt2').map((w) => w.address.toLowerCase())
		ctx.chain.adminAddrs = new Set(others)
		await ctx.run({ ticks: 12, timeoutMs: 200_000 })
		const rt2 = ctx.poolSigners.get('rt2')!
		assert.equal(rt2.requests.length, 0, `rt2's signer saw ${rt2.requests.length} requests (not even signer_getAddress: nothing is read from a wallet that is not authorized)`)
	})
	reconcile(r.res, r.world, r.end, 'admin never')
})
