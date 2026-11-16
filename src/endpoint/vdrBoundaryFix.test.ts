/**
 * Pure tests for per-start boundary fixing and realtime spans (no RPC, no files, no network).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ethers } from 'ethers'
import {
	applyReorgRollback,
	createInitialDualCursorState,
	fixBoundaryAtStart,
	needsSpanSkip,
	planScanRanges,
	skipHistoricalOverSpans,
	type DualCursorState,
} from './vdrDualCursor.js'
import { assertLoadableState } from './validatorClRewardPayoutReporter.js'

const hashOf = (n: number): string => ethers.id(`block:${n}`).toLowerCase()

function withState(p: Partial<DualCursorState> & { H?: number | null }): DualCursorState {
	const base = createInitialDualCursorState(1)
	const H = p.H === undefined ? null : p.H
	const { H: _h, ...rest } = p
	return {
		...base,
		...rest,
		boundaryH: H === null ? null : { blockNumber: H, blockHash: hashOf(H) },
	}
}

test('fixBoundaryAtStart: a candidate below the realtime cursor is held and changes nothing', () => {
	const s = withState({ H: 98, historicalCursor: 40, realtimeCursor: 108 })
	const r = fixBoundaryAtStart(s, { blockNumber: 107, blockHash: hashOf(107) })
	assert.equal(r.held, true)
	assert.equal(r.state, s)
})

test('fixBoundaryAtStart: realtime past the old H leaves a span (oldH, realtime] and retires the old H', () => {
	const s = withState({ H: 98, historicalCursor: 40, realtimeCursor: 108 })
	const r = fixBoundaryAtStart(s, { blockNumber: 110, blockHash: hashOf(110) })
	assert.equal(r.held, false)
	assert.deepEqual(r.state.boundaryH, { blockNumber: 110, blockHash: hashOf(110) })
	assert.equal(r.state.realtimeCursor, 110, 'realtime starts at the new H (first block H+1)')
	assert.equal(r.state.historicalCursor, 40, 'history cursor is not touched')
	assert.deepEqual(r.state.metrics.realtimeSpans, [{ from: 99, to: 108 }])
	assert.equal(r.state.metrics.retiredBoundaries?.length, 1)
	assert.equal(r.state.metrics.retiredBoundaries?.[0]?.blockNumber, 98, 'the old H is kept')
	assert.equal(r.state.metrics.retiredBoundaries?.[0]?.realtimeCursor, 108)
})

test('fixBoundaryAtStart: realtime exactly at the old H leaves no span; the old H is still retired', () => {
	const s = withState({ H: 58, historicalCursor: 58, realtimeCursor: 58 })
	const r = fixBoundaryAtStart(s, { blockNumber: 98, blockHash: hashOf(98) })
	assert.deepEqual(r.state.metrics.realtimeSpans, [])
	assert.equal(r.state.metrics.retiredBoundaries?.[0]?.blockNumber, 58)
})

test('fixBoundaryAtStart: successive starts append spans in order, never overlapping', () => {
	let s = withState({ H: 50, historicalCursor: 20, realtimeCursor: 60 })
	s = fixBoundaryAtStart(s, { blockNumber: 70, blockHash: hashOf(70) }).state // span (50, 60]
	s = { ...s, realtimeCursor: 85 } // realtime ran to 85 under H=70
	s = fixBoundaryAtStart(s, { blockNumber: 90, blockHash: hashOf(90) }).state // span (70, 85]
	assert.deepEqual(s.metrics.realtimeSpans, [
		{ from: 51, to: 60 },
		{ from: 71, to: 85 },
	])
	assert.equal(s.boundaryH?.blockNumber, 90)
})

test('planScanRanges: history windows never cross a realtime span and never start inside one', () => {
	const s = withState({
		H: 108,
		historicalCursor: 40,
		realtimeCursor: 108,
		metrics: { ...createInitialDualCursorState(1).metrics, realtimeSpans: [{ from: 99, to: 108 }] },
	})
	const plan = planScanRanges(s, 110, { historicalChunk: 1000 })
	assert.deepEqual(plan.historical, { from: 41, to: 98 }, 'the window stops before the span')
	const atSpan = { ...s, historicalCursor: 98 }
	assert.equal(needsSpanSkip(atSpan), true)
	assert.equal(planScanRanges(atSpan, 110).historical, null, 'no window may start inside a span')
	const skipped = skipHistoricalOverSpans(atSpan)
	assert.equal(skipped.historicalCursor, 108)
	assert.deepEqual(skipped.metrics.realtimeSpans, [])
	assert.equal(needsSpanSkip(skipped), false)
	assert.equal(skipHistoricalOverSpans(skipped), skipped, 'nothing to skip returns the same object')
})

test('skipHistoricalOverSpans: adjacent spans are crossed in one step; spans not yet reached stay', () => {
	const s = withState({
		H: 200,
		historicalCursor: 40,
		realtimeCursor: 200,
		metrics: { ...createInitialDualCursorState(1).metrics, realtimeSpans: [{ from: 41, to: 60 }, { from: 61, to: 70 }, { from: 150, to: 160 }] },
	})
	const skipped = skipHistoricalOverSpans(s)
	assert.equal(skipped.historicalCursor, 70)
	assert.deepEqual(skipped.metrics.realtimeSpans, [{ from: 150, to: 160 }])
})

test('applyReorgRollback: spans above the cut are trimmed so history scans them again', () => {
	const s = withState({
		H: 108,
		historicalCursor: 40,
		realtimeCursor: 108,
		metrics: { ...createInitialDualCursorState(1).metrics, realtimeSpans: [{ from: 99, to: 108 }] },
	})
	const r = applyReorgRollback(s, 103, hashOf(103), hashOf(1))
	assert.deepEqual(r.metrics.realtimeSpans, [{ from: 99, to: 102 }])
})

test('assertLoadableState accepts valid spans and refuses overlapping, unsorted, or above-H spans', () => {
	const base = (spans: unknown, H: number | null = 108) => ({
		version: 2,
		boundaryH: H === null ? null : { blockNumber: H, blockHash: hashOf(H) },
		historicalCursor: 40,
		realtimeCursor: H ?? 40,
		pending: [],
		settleIntents: [],
		metrics: { realtimeSpans: spans },
	})
	assert.doesNotThrow(() => assertLoadableState(base([{ from: 99, to: 100 }, { from: 101, to: 108 }])))
	assert.throws(() => assertLoadableState(base([{ from: 99, to: 105 }, { from: 103, to: 108 }])), /STATE_SPAN_INVALID/)
	assert.throws(() => assertLoadableState(base([{ from: 101, to: 105 }, { from: 99, to: 100 }])), /STATE_SPAN_INVALID/)
	assert.throws(() => assertLoadableState(base([{ from: 99, to: 109 }])), /STATE_SPAN_INVALID/)
	assert.throws(() => assertLoadableState(base([{ from: 99, to: 100 }], null)), /STATE_SPAN_INVALID/)
	assert.throws(() => assertLoadableState(base([{ from: 99, to: 100, extra: 1 }])), /STATE_SPAN_INVALID/)
})
