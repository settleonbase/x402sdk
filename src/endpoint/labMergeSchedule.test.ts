/**
 * Merge cross checks (the cancel-the-fixed-wait patch together with the wallet pools), on the REAL reporter in pool mode with REAL (uncompressed) TICK_MS = 15 000 ms, counted on the fake services' side and from
 * the child's own markers: (a) while there is scan work the scan ticks follow each other with no wait (no TICK_MS timer is armed); (b) in a caught-up world the scan waits one TICK_MS per tick - a handful of ticks
 * in several seconds, not a busy loop - while the wallets keep making passes every PAY_IDLE_MS (the payment loops do not depend on TICK_MS).
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { runCurve, type Opts } from './labPoolsMeasure/curve.test'

const base = (over: Partial<Opts>): Opts => ({ mode: 'slope', rt: 2, hist: 1, runMs: 6000, latencyMs: 2, sendDelayMs: 5, receiptEmpty: 0, blockMs: 60_000, arrival: 0, seedPending: 0, waitMs: 15_000, fieldFactor: 1, budget: 16, root: path.resolve(__dirname, '../..'), ...over })

test('merge (a): with scan work pending the scan ticks run back to back - many ticks in a few seconds and no TICK_MS wait armed', { timeout: 120_000 }, async () => {
	// history backlog of 4 900 blocks, nothing arrives: every tick scans a window (progress), the loop never waits
	const r = await runCurve({ ...base({}), waitMs: 'real' as never })
	assert.equal(r.exit, 0)
	assert.ok(r.counts.scanTicks >= 6, `scan ticks in 6 s: ${r.counts.scanTicks}`)
	assert.equal(r.counts.scanWaits, 0, 'no TICK_MS timer was armed while every tick made progress')
})

test('merge (b): caught up (nothing to scan) the scan waits TICK_MS - at most a couple of ticks in 6 s - while the wallets keep passing every PAY_IDLE_MS', { timeout: 120_000 }, async () => {
	// the head is at the freeze height and does not move: after the first scans nothing is left
	const r = await runCurve({ ...base({ mode: 'cap', seedPending: 0 }), waitMs: 'real' as never })
	assert.equal(r.exit, 0)
	assert.ok(r.counts.scanTicks <= 3, `scan ticks while caught up: ${r.counts.scanTicks}`)
	assert.ok(r.counts.scanWaits >= 1 && r.counts.scanWaits <= 3, `TICK_MS timers armed: ${r.counts.scanWaits}`)
	assert.ok(r.counts.walletPasses >= 60, `wallet passes in 6 s with a 50 ms idle wait and 3 wallets: ${r.counts.walletPasses}`)
	process.stderr.write(`merge (b): scanTicks=${r.counts.scanTicks} scanWaits=${r.counts.scanWaits} walletPasses=${r.counts.walletPasses}\n`)
})

test('merge (c): TICK_MODE=fixed (the deployed default): a working scan tick is followed by ONE TICK_MS wait - only a couple of ticks in 6 s although there is scan work; the wallets still pass every PAY_IDLE_MS', { timeout: 120_000 }, async () => {
	const r = await runCurve({ ...base({}), waitMs: 'real' as never, tickMode: 'fixed' })
	assert.equal(r.exit, 0)
	assert.ok(r.counts.scanTicks <= 3, `scan ticks in 6 s in fixed mode with scan work: ${r.counts.scanTicks} (continuous mode makes 6 or more)`)
	assert.ok(r.counts.scanWaits >= 1, `a TICK_MS timer was armed after the working tick: ${r.counts.scanWaits}`)
	assert.ok(r.counts.walletPasses >= 20, `wallet passes: ${r.counts.walletPasses} (the payment loops do not depend on TICK_MS)`)
})
