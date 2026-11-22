/**
 * C5 (P2c-2): random kill -9 of the REAL reporter in WAL mode against the simulated chain / beacon / signer. Per round: one or two kills at a seeded random point, then a clean run to the end.
 * Asserted for every round: every event key is paid by AT MOST ONE transaction (harness assertPaidAtMostOnce, which also refuses blind sends), every expected key is paid EXACTLY once by the end
 * (no key is never paid), no noise key is paid, the clean run exits 0, and the recovered logical state has no pending entry left and every expected key consumed.
 * Kill-point classes (deterministic hooks inside the fake servers, so each class really happens):
 *   intent-not-sent   the signer has received the send request, the intent is in the log, the send is not recorded (signer.beforeRecord)
 *   sent-not-settled  the signer recorded the send, the reporter has not settled (signer.afterRecord)
 *   receipt-asked     the reporter asks for the receipt of a sent transaction (chain.receiptRule)
 *   after-scan        right after a scan event is logged (queued / scan-summary line)
 *   after-settle      right after a "withdrawNative ok" line
 *   after-snapshot  right after a "snapshot committed" line (odd seeds snapshot after every tick: interval 1 ms; even seeds use the 10 min default)
 *   at-start        when the reporter has loaded its manifest, i.e. inside the first-start bootstrap window (found a real bug: a killed first bootstrap left an orphan state dir)
 *   random-ms         a random moment (startup, mid-tick, between ticks)
 * C5_DECOUPLED=1 runs the same rounds with the P3 decoupled payment worker (scan and payment as separate actors on the same log).
 * Reproduce a round: C5_SEED=<seed> C5_ROUNDS=1 (the round's seed is printed on failure). More rounds: C5_ROUNDS=200.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { runScenario, type Ctx, type Scenario } from './labE2e/harness.test'
import { eventKeyOf, headPlan, seedValidators, seedWithdrawals } from './labE2e/scenarios.test'

type KillClass = 'intent-not-sent' | 'sent-not-settled' | 'receipt-asked' | 'after-scan' | 'after-settle' | 'at-start' | 'after-snapshot' | 'random-ms'
const CLASSES: KillClass[] = ['intent-not-sent', 'sent-not-settled', 'receipt-asked', 'after-scan', 'after-settle', 'at-start', 'after-snapshot', 'random-ms']

function mulberry32(a: number): () => number {
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const EXPECTED = [
	[102, 0], [105, 0], [105, 1], [110, 0], [117, 0], // history
	[122, 0], [124, 0], [126, 0], // realtime
].map(([b, i]) => eventKeyOf(b!, i!)).sort()

const TALLY: Record<string, { planned: number; fired: number }> = {}

async function killedRun(ctx: Ctx, cls: KillClass, nth: number, randomMs: number): Promise<void> {
	let n = 0
	const hit = (): boolean => ++n === nth
	const kill = (): void => void ctx.currentChild?.kill('SIGKILL')
	ctx.signer.beforeRecord = undefined
	ctx.signer.afterRecord = undefined
	ctx.chain.receiptRule = () => 'mined'
	let killWhen: Parameters<Ctx['run']>[0]['killWhen']
	let timer: NodeJS.Timeout | undefined
	if (cls === 'intent-not-sent') ctx.signer.beforeRecord = () => void (hit() && kill())
	else if (cls === 'sent-not-settled') ctx.signer.afterRecord = () => void (hit() && kill())
	else if (cls === 'receipt-asked') ctx.chain.receiptRule = () => (hit() ? (kill(), 'none') : 'mined')
	else if (cls === 'after-scan') killWhen = (ev) => ev.kind === 'log' && /\] (history|realtime) queued \+|scan-summary line=/.test(ev.line) && hit()
	else if (cls === 'after-snapshot') killWhen = (ev) => ev.kind === 'log' && /snapshot committed walSeq=/.test(ev.line) && hit()
	else if (cls === 'at-start') killWhen = (ev) => ev.kind === 'log' && /loaded manifest pubkeys=/.test(ev.line) && hit()
	else if (cls === 'after-settle') killWhen = (ev) => ev.kind === 'log' && /withdrawNative ok hash=/.test(ev.line) && hit()
	else timer = setTimeout(kill, randomMs)
	try {
		const rr = await ctx.run({ ticks: 4, killWhen })
		const t = (TALLY[cls] ??= { planned: 0, fired: 0 })
		t.planned++
		if (rr.killed || rr.signal === 'SIGKILL') t.fired++
	} finally {
		if (timer) clearTimeout(timer)
		ctx.signer.beforeRecord = undefined
		ctx.signer.afterRecord = undefined
		ctx.chain.receiptRule = () => 'mined'
	}
}

function roundScenario(seed: number): Scenario {
	return {
		name: `c5_round_${seed}`,
		env: { CONET_LAB_MINING_POOL_CL_PAYOUT_FLUSH_BATCH_ENTRIES: '2', ...(seed % 2 === 1 ? { CONET_LAB_MINING_POOL_CL_PAYOUT_WAL_SNAPSHOT_INTERVAL_MS: '1' } : {}) },
		body: async (ctx) => {
			const rnd = mulberry32(seed)
			seedValidators(ctx)
			seedWithdrawals(ctx)
			headPlan(ctx, [120, 124, 128, 128, 128, 128, 128, 128, 128])
			const kills = rnd() < 0.4 ? 2 : 1
			for (let k = 0; k < kills; k++) {
				const cls = CLASSES[Math.floor(rnd() * CLASSES.length)]!
				const nth = cls === 'at-start' ? 1 : 1 + Math.floor(rnd() * 3)
				const randomMs = 40 + Math.floor(rnd() * 860) // a whole child run (start, 4 compressed ticks, drain) takes about one second
				process.stderr.write(`c5 seed=${seed} kill#${k + 1} class=${cls} nth=${nth}${cls === 'random-ms' ? ` ms=${randomMs}` : ''}\n`)
				await killedRun(ctx, cls, nth, randomMs)
			}
			await ctx.run({ ticks: 6 })
		},
	}
}

after(() => {
	process.stderr.write(`c5 coverage (planned / really killed): ${JSON.stringify(TALLY)}\n`)
	if (Number(process.env.C5_ROUNDS ?? 18) >= 40) for (const c of CLASSES) assert.ok((TALLY[c]?.fired ?? 0) > 0, `kill class ${c} never really fired`)
})

const BASE = Number(process.env.C5_SEED ?? 20261121)
const ROUNDS = Number(process.env.C5_ROUNDS ?? 18)
for (let r = 0; r < ROUNDS; r++) {
	const seed = BASE + r
	test(`C5 WAL${process.env.C5_DECOUPLED === '1' ? ' (decoupled payment worker)' : ''} random kill round seed=${seed}: each event key paid exactly once, none left unpaid`, { timeout: 400_000 }, async () => {
		const res = await runScenario(roundScenario(seed), undefined, { walMode: true, decoupled: process.env.C5_DECOUPLED === '1' })
		assert.deepEqual(res.unknownRpcMethods, [])
		const last = res.exits[res.exits.length - 1]!
		assert.equal(last.killed, false, 'the clean run was not killed')
		assert.equal(last.code, 0, `the clean run exits 0 (exits ${JSON.stringify(res.exits)}; stray output: ${JSON.stringify(res.strayOutput.slice(-12))}; last run lines: ${JSON.stringify(res.logs[res.logs.length - 1]!.slice(-12))})`)
		assert.deepEqual(Object.keys(res.paymentsPerEventKey).sort(), EXPECTED, 'exactly the expected event keys were paid (no noise key, no key left unpaid)')
		for (const [k, n] of Object.entries(res.paymentsPerEventKey)) assert.equal(n, 1, `event key ${k} paid ${n} times`)
		assert.ok(res.logical, 'a recovered state exists')
		assert.equal(res.logical!.pending.length, 0, 'nothing left pending')
		for (const k of EXPECTED) assert.ok(res.logical!.consumed.includes(k), `consumed has ${k}`)
	})
}
