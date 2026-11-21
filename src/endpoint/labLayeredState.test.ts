/**
 * P2b-1: layered views (frozen + delta + tombstones) against a plain Map, insertion order, merge with a planned prune, one snapshot at a time,
 * and the per-block history counts. Pure in-memory tests.
 * Review L1-L4: a changed value of a frozen key throws (the model test expects the throw, it does not skip the step), values are deep-frozen by the callers,
 * a generation token guards merge/abort and the writer's iteration, and history-count drift is counted and reported.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HistoryBlockCounts, LayeredMap, LayeredSet, type FreezeHandle } from './labLayeredState'

function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 0x100000000
	}
}

const same = (a: LayeredMap<string, number>, m: Map<string, number>, label: string): void => {
	assert.equal(a.size, m.size, `${label}: size`)
	assert.deepEqual([...a.entries()], [...m.entries()], `${label}: entries in insertion order`)
	assert.deepEqual([...a.keys()], [...m.keys()], `${label}: keys`)
	assert.deepEqual([...a.values()], [...m.values()], `${label}: values`)
	for (const k of m.keys()) {
		assert.equal(a.has(k), true, `${label}: has ${k}`)
		assert.equal(a.get(k), m.get(k), `${label}: get ${k}`)
	}
}

test('layered map: no snapshot = a plain Map', () => {
	const a = new LayeredMap<string, number>([['a', 1], ['b', 2]])
	assert.equal(a.size, 2)
	a.set('c', 3).set('a', 9)
	assert.deepEqual([...a.entries()], [['a', 9], ['b', 2], ['c', 3]], 'an existing key keeps its position')
	assert.equal(a.delete('b'), true)
	assert.equal(a.delete('b'), false)
	assert.equal(a.has('b'), false)
	assert.equal(a.get('zzz'), undefined)
})

test('layered map: while frozen, reads see frozen + delta - tombstones; frozen is never mutated; re-add after delete is visible and moves to the end', () => {
	const a = new LayeredMap<string, number>([['k1', 1], ['k2', 2], ['k3', 3]])
	const h = a.freeze()
	assert.deepEqual([...h.view.keys()], ['k1', 'k2', 'k3'])
	a.delete('k2')
	a.set('k4', 4)
	a.delete('k1')
	a.set('k1', 11) // deleted and re-added: visible again, at the end
	assert.equal(a.size, 3) // k2 deleted; k3 kept; k4 new; k1 deleted and re-added
	assert.deepEqual([...a.keys()], ['k3', 'k4', 'k1'])
	assert.equal(a.get('k1'), 11)
	assert.equal(a.has('k2'), false)
	assert.deepEqual([...h.entries()], [['k1', 1], ['k2', 2], ['k3', 3]], 'the frozen map is untouched while the writer reads it')
	a.merge(h.token)
	assert.deepEqual([...a.entries()], [['k3', 3], ['k4', 4], ['k1', 11]])
	assert.equal(a.isFrozen, false)
	assert.equal(a.size, 3)
})

test('layered map: size is consistent through every overlay state (delete of a delta key, double delete, tombstone then re-add)', () => {
	const a = new LayeredMap<string, number>([['a', 1], ['b', 2]])
	const h = a.freeze()
	a.set('c', 3)
	assert.equal(a.size, 3)
	assert.equal(a.delete('c'), true)
	assert.equal(a.size, 2)
	assert.equal(a.delete('a'), true)
	assert.equal(a.delete('a'), false)
	assert.equal(a.size, 1)
	a.set('a', 1)
	assert.equal(a.size, 2)
	assert.deepEqual([...a.keys()], ['b', 'a'])
	assert.deepEqual(a.overlaySize(), { delta: 1, tombstones: 1 })
	a.merge(h.token)
	assert.deepEqual([...a.entries()], [['b', 2], ['a', 1]])
})

test('layered map: only one snapshot in flight; merge or abort without one throws; abort keeps every overlay change', () => {
	const a = new LayeredMap<string, number>([['a', 1]])
	assert.throws(() => a.merge(1), /no snapshot in flight/)
	assert.throws(() => a.abort(1), /no snapshot in flight/)
	const h = a.freeze()
	assert.throws(() => a.freeze(), /already in flight/)
	a.set('b', 2)
	a.delete('a')
	a.abort(h.token)
	assert.deepEqual([...a.entries()], [['b', 2]])
	assert.equal(a.isFrozen, false)
	const h2 = a.freeze() // can start again after an abort
	a.merge(h2.token)
})

test('layered map: merge applies a planned prune, but not to a key that was deleted and re-added after the freeze', () => {
	const a = new LayeredMap<string, number>([['old1', 1], ['old2', 2], ['old3', 3], ['mid', 4]])
	const h = a.freeze()
	a.delete('old2')
	a.set('old2', 22) // re-added after the freeze
	a.set('new', 5)
	a.merge(h.token, ['old1', 'old2', 'old3'])
	assert.deepEqual([...a.entries()], [['mid', 4], ['old2', 22], ['new', 5]], 'old1 and old3 pruned; the re-added old2 survives; order is frozen then delta')
})

test('L1: set() of an existing frozen key with a DIFFERENT value throws and changes nothing; the same value is a no-op; delete + set is the way to replace', () => {
	const a = new LayeredMap<string, number>([['a', 1], ['b', 2], ['c', 3]])
	const h = a.freeze()
	assert.throws(() => a.set('a', 9), /different value while a snapshot is in flight/)
	assert.deepEqual([...a.entries()], [['a', 1], ['b', 2], ['c', 3]], 'a refused set leaves the view untouched')
	assert.deepEqual(a.overlaySize(), { delta: 0, tombstones: 0 })
	a.set('a', 1) // same value: no-op
	assert.deepEqual(a.overlaySize(), { delta: 0, tombstones: 0 })
	a.delete('b')
	assert.doesNotThrow(() => a.set('b', 22), 'a key deleted in this snapshot may be set again (it lives in delta)')
	assert.deepEqual([...a.entries()], [['a', 1], ['c', 3], ['b', 22]])
	assert.doesNotThrow(() => a.set('b', 23), 'a delta key may change value freely')
	a.merge(h.token)
	assert.deepEqual([...a.entries()], [['a', 1], ['c', 3], ['b', 23]])
	// object values: any other object counts as different, the same reference is a no-op
	const o = new LayeredMap<string, { n: number }>()
	const v1 = Object.freeze({ n: 1 })
	o.set('x', v1)
	const ho = o.freeze()
	assert.doesNotThrow(() => o.set('x', v1))
	assert.throws(() => o.set('x', Object.freeze({ n: 1 })), /different value/, 'an equal-looking new object is a different value')
	o.merge(ho.token)
})

test('L2: values reach the writer through the frozen view unchanged; callers hold Object.freeze values, so an in-place change is rejected instead of leaking into the snapshot', () => {
	const a = new LayeredMap<string, { amount: string }>()
	a.set('p1', Object.freeze({ amount: '10' }))
	const h = a.freeze()
	const v = h.view.get('p1')!
	assert.throws(() => {
		'use strict'
		;(v as { amount: string }).amount = '99'
	}, TypeError, 'a frozen value cannot be mutated in place')
	assert.equal([...h.entries()][0]![1].amount, '10', 'the writer still reads the value at freeze time')
	// the supported update is delete + set with a new value, which lands in the overlay and not in the snapshot
	a.delete('p1')
	a.set('p1', Object.freeze({ amount: '20' }))
	assert.equal([...h.entries()][0]![1].amount, '10')
	assert.equal(a.get('p1')!.amount, '20')
	a.merge(h.token)
	assert.equal(a.get('p1')!.amount, '20')
})

test('L3: merge/abort check the generation token; a stale token throws; the writer\'s iteration stops (throws) when the snapshot is merged or aborted under it', () => {
	const a = new LayeredMap<string, number>()
	for (let i = 0; i < 10; i++) a.set(`k${i}`, i)
	const h1 = a.freeze()
	assert.equal(h1.isValid(), true)
	assert.throws(() => a.merge(h1.token + 1), /stale snapshot token/)
	assert.throws(() => a.abort(h1.token + 1), /stale snapshot token/)
	assert.equal(a.isFrozen, true, 'a refused merge leaves the snapshot in flight')
	assert.equal(h1.isValid(), true)
	// the writer is half way through when the owner aborts: the writer must not read a half-merged map
	const it = h1.entries()
	const got: string[] = []
	for (let i = 0; i < 4; i++) got.push(it.next().value![0])
	a.set('late', 99)
	a.delete('k0')
	a.abort(h1.token)
	assert.equal(h1.isValid(), false)
	assert.throws(() => it.next(), /merged or aborted while the writer was still reading it/)
	assert.deepEqual(got, ['k0', 'k1', 'k2', 'k3'], 'what was read before the abort was a consistent prefix')
	assert.throws(() => a.merge(h1.token), /no snapshot in flight/, 'the old token is dead after the merge')
	// the next snapshot has a new token; the old handle stays invalid even though a snapshot is in flight again
	const h2 = a.freeze()
	assert.notEqual(h2.token, h1.token)
	assert.equal(h1.isValid(), false)
	assert.equal(h2.isValid(), true)
	assert.throws(() => a.merge(h1.token), /stale snapshot token/)
	assert.throws(() => [...h1.entries()], /merged or aborted/)
	a.merge(h2.token)
	assert.equal(h2.isValid(), false)
	// LayeredSet mirrors it
	const s = new LayeredSet<string>(['x', 'y'])
	const hs = s.freeze()
	assert.throws(() => s.merge(hs.token + 5), /stale snapshot token/)
	s.merge(hs.token)
	assert.equal(hs.isValid(), false)
})

test('layered map: 300 random operation streams with freeze / merge / abort cycles equal a plain Map at every step (insertion order included; changed frozen values must throw)', () => {
	const r = rng(2024)
	let throwsSeen = 0
	for (let c = 0; c < 300; c++) {
		const layered = new LayeredMap<string, number>()
		const model = new Map<string, number>()
		let handle: FreezeHandle<string, number> | null = null
		let frozenKeys: Set<string> | null = null
		let addedAfterFreeze = new Set<string>()
		let plannedPrune: string[] = []
		for (let step = 0; step < 120; step++) {
			const x = r()
			const k = `k${Math.floor(r() * 25)}`
			if (x < 0.4) {
				const v = Math.floor(r() * 3)
				const existed = model.has(k)
				const sameVal = existed && model.get(k) === v
				// the layered map refuses a CHANGED value of a key that is in the frozen part (review L1); the model run expects exactly that throw
				if (frozenKeys !== null && existed && !sameVal && !addedAfterFreeze.has(k)) {
					assert.throws(() => layered.set(k, v), /different value while a snapshot is in flight/, `case ${c} step ${step}: changed frozen value throws`)
					throwsSeen++
					same(layered, model, `case ${c} step ${step} after the refused set`)
					continue
				}
				layered.set(k, v)
				model.set(k, v)
				if (frozenKeys !== null && !existed) addedAfterFreeze.add(k)
			} else if (x < 0.65) {
				const d1 = layered.delete(k)
				const d2 = model.delete(k)
				assert.equal(d1, d2, `case ${c} step ${step}: delete result`)
				if (frozenKeys !== null) addedAfterFreeze.delete(k)
				// a deleted key that is set again later counts as added after the freeze (handled by the existed check above)
			} else if (x < 0.8 && frozenKeys === null) {
				handle = layered.freeze()
				frozenKeys = new Set(model.keys())
				addedAfterFreeze = new Set()
				plannedPrune = [...model.keys()].filter(() => r() < 0.2)
			} else if (x < 0.9 && frozenKeys !== null && handle !== null) {
				layered.merge(handle.token, plannedPrune)
				for (const p of plannedPrune) if (!addedAfterFreeze.has(p)) model.delete(p)
				assert.equal(handle.isValid(), false)
				frozenKeys = null
				handle = null
				plannedPrune = []
			} else if (x < 0.93 && frozenKeys !== null && handle !== null) {
				layered.abort(handle.token)
				frozenKeys = null
				handle = null
				plannedPrune = []
			}
			// a re-add after a delete of a frozen key must count as "added after the freeze" for the prune protection
			if (frozenKeys !== null) for (const key of model.keys()) if (!frozenKeys.has(key)) addedAfterFreeze.add(key)
			same(layered, model, `case ${c} step ${step}`)
		}
	}
	assert.ok(throwsSeen > 50, `the stream exercised the refused-set path (${throwsSeen} times)`)
})

test('layered set: insertion order survives freeze and merge; add of an existing key is a no-op; prune order = oldest first', () => {
	const s = new LayeredSet<string>(['a', 'b', 'c'])
	s.add('b')
	assert.deepEqual([...s], ['a', 'b', 'c'])
	const h = s.freeze()
	s.add('d')
	s.delete('a')
	s.add('a') // moved to the end like delete + add
	s.add('e')
	assert.deepEqual([...s.keys()], ['b', 'c', 'd', 'a', 'e'])
	assert.equal(s.size, 5)
	s.merge(h.token, ['b']) // the planned prune takes the oldest
	assert.deepEqual([...s], ['c', 'd', 'a', 'e'])
	assert.equal(s.size, 4)
})

test('history block counts: add/remove/ahead match a recount; reconcile reports drift and then agrees with the pool', () => {
	const r = rng(8)
	const c = new HistoryBlockCounts()
	const pool = new Map<string, number>()
	for (let i = 0; i < 2000; i++) {
		const b = 1000 + Math.floor(r() * 300)
		const key = `e${i}`
		pool.set(key, b)
		c.add(b)
		if (r() < 0.4) {
			const [victim, vb] = [...pool.entries()][Math.floor(r() * pool.size)]!
			pool.delete(victim)
			assert.equal(c.remove(vb), true)
		}
	}
	const recount = (cursor: number): number => [...pool.values()].filter((b) => b > cursor).length
	assert.equal(c.histTotal, pool.size)
	for (const cur of [0, 999, 1000, 1150, 1299, 1300, 5000]) assert.equal(c.ahead(cur), recount(cur), `ahead(${cur})`)
	assert.deepEqual(c.reconcile(pool.values()), { drifted: false, histTotal: pool.size })
	assert.equal(c.driftEvents, 0, 'no drift while the counts follow the pool')
	// drift: a removal that never reached the counts
	const [k0] = [...pool.entries()][0]!
	pool.delete(k0)
	const rec = c.reconcile(pool.values())
	assert.equal(rec.drifted, true)
	assert.equal(c.driftEvents, 1)
	assert.equal(c.histTotal, pool.size)
	for (const cur of [0, 1150, 5000]) assert.equal(c.ahead(cur), recount(cur))
})

test('L4: remove of a block that has no count is drift at once (counted, reported, returns false) and changes no total; reconcile mismatches are counted too', () => {
	const seen: string[] = []
	const c = new HistoryBlockCounts((what) => seen.push(what))
	c.add(100)
	c.add(100)
	c.add(101)
	assert.equal(c.remove(424242), false)
	assert.equal(c.driftEvents, 1)
	assert.deepEqual(seen, ['remove of block 424242 with no count'])
	assert.equal(c.histTotal, 3, 'an unknown remove does not change the total')
	assert.equal(c.remove(101), true)
	assert.equal(c.remove(101), false, 'a second removal of the same single entry is drift too')
	assert.equal(c.driftEvents, 2)
	assert.equal(c.ahead(0), 2)
	// reconcile against a pool that differs
	const rec = c.reconcile([100, 100, 100])
	assert.equal(rec.drifted, true)
	assert.equal(c.driftEvents, 3)
	assert.equal(seen[seen.length - 1], 'reconcile mismatch')
	assert.equal(c.histTotal, 3)
	assert.equal(c.reconcile([100, 100, 100]).drifted, false)
	assert.equal(c.driftEvents, 3, 'a clean reconcile adds no drift')
})

test('L4: ahead() over ~125k distinct blocks stays in the sub-millisecond-to-few-ms range (once per tick is cheap; the doc says never per key)', () => {
	const c = new HistoryBlockCounts()
	for (let b = 1; b <= 125000; b++) {
		c.add(b)
		if (b % 13 === 0) c.add(b)
	}
	const t0 = process.hrtime.bigint()
	let x = 0
	for (let i = 0; i < 20; i++) x += c.ahead(60000 + i)
	const msPer = Number(process.hrtime.bigint() - t0) / 1e6 / 20
	assert.ok(x > 0)
	assert.ok(msPer < 25, `ahead() took ${msPer.toFixed(2)} ms per call`)
})
