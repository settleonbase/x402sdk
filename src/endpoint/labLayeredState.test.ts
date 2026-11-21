/**
 * P2b-1: layered views (frozen + delta + tombstones) against a plain Map, insertion order, merge with a planned prune, one snapshot at a time,
 * and the per-block history counts. Pure in-memory tests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HistoryBlockCounts, LayeredMap, LayeredSet } from './labLayeredState'

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
	const frozen = a.freeze()
	assert.deepEqual([...frozen.keys()], ['k1', 'k2', 'k3'])
	a.delete('k2')
	a.set('k4', 4)
	a.delete('k1')
	a.set('k1', 11) // deleted and re-added: visible again, at the end
	assert.equal(a.size, 3) // k2 deleted; k3 kept; k4 new; k1 deleted and re-added
	assert.deepEqual([...a.keys()], ['k3', 'k4', 'k1'])
	assert.equal(a.get('k1'), 11)
	assert.equal(a.has('k2'), false)
	assert.deepEqual([...frozen.entries()], [['k1', 1], ['k2', 2], ['k3', 3]], 'the frozen map is untouched while the writer reads it')
	a.merge()
	assert.deepEqual([...a.entries()], [['k3', 3], ['k4', 4], ['k1', 11]])
	assert.equal(a.isFrozen, false)
	assert.equal(a.size, 3)
})

test('layered map: size is consistent through every overlay state (delete of a delta key, double delete, tombstone then re-add)', () => {
	const a = new LayeredMap<string, number>([['a', 1], ['b', 2]])
	a.freeze()
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
	a.merge()
	assert.deepEqual([...a.entries()], [['b', 2], ['a', 1]])
})

test('layered map: only one snapshot in flight; merge or abort without one throws; abort keeps every overlay change', () => {
	const a = new LayeredMap<string, number>([['a', 1]])
	assert.throws(() => a.merge(), /no snapshot in flight/)
	a.freeze()
	assert.throws(() => a.freeze(), /already in flight/)
	a.set('b', 2)
	a.delete('a')
	a.abort()
	assert.deepEqual([...a.entries()], [['b', 2]])
	assert.equal(a.isFrozen, false)
	a.freeze() // can start again after an abort
	a.merge()
})

test('layered map: merge applies a planned prune, but not to a key that was deleted and re-added after the freeze', () => {
	const a = new LayeredMap<string, number>([['old1', 1], ['old2', 2], ['old3', 3], ['mid', 4]])
	a.freeze()
	a.delete('old2')
	a.set('old2', 22) // re-added after the freeze
	a.set('new', 5)
	a.merge(['old1', 'old2', 'old3'])
	assert.deepEqual([...a.entries()], [['mid', 4], ['old2', 22], ['new', 5]], 'old1 and old3 pruned; the re-added old2 survives; order is frozen then delta')
})

test('layered map: 300 random operation streams with freeze / merge / abort cycles equal a plain Map at every step (insertion order included)', () => {
	const r = rng(2024)
	for (let c = 0; c < 300; c++) {
		const layered = new LayeredMap<string, number>()
		const model = new Map<string, number>()
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
				// plain Map.set keeps position of an existing key; the layered map moves a changed frozen key to the end: use set only with new keys or equal values
				// while a snapshot is in flight so both have the same order semantics (the daemon never changes the value of an existing key)
				if (frozenKeys !== null && existed && !sameVal && !addedAfterFreeze.has(k)) continue
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
				layered.freeze()
				frozenKeys = new Set(model.keys())
				addedAfterFreeze = new Set()
				plannedPrune = [...model.keys()].filter(() => r() < 0.2)
			} else if (x < 0.9 && frozenKeys !== null) {
				layered.merge(plannedPrune)
				for (const p of plannedPrune) if (!addedAfterFreeze.has(p)) model.delete(p)
				frozenKeys = null
				plannedPrune = []
			} else if (x < 0.93 && frozenKeys !== null) {
				layered.abort()
				frozenKeys = null
				plannedPrune = []
			}
			// a re-add after a delete of a frozen key must count as "added after the freeze" for the prune protection
			if (frozenKeys !== null) for (const key of model.keys()) if (!frozenKeys.has(key)) addedAfterFreeze.add(key)
			same(layered, model, `case ${c} step ${step}`)
		}
	}
})

test('layered set: insertion order survives freeze and merge; add of an existing key is a no-op; prune order = oldest first', () => {
	const s = new LayeredSet<string>(['a', 'b', 'c'])
	s.add('b')
	assert.deepEqual([...s], ['a', 'b', 'c'])
	s.freeze()
	s.add('d')
	s.delete('a')
	s.add('a') // moved to the end like delete + add
	s.add('e')
	assert.deepEqual([...s.keys()], ['b', 'c', 'd', 'a', 'e'])
	assert.equal(s.size, 5)
	s.merge(['b']) // the planned prune takes the oldest
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
			c.remove(vb)
		}
	}
	const recount = (cursor: number): number => [...pool.values()].filter((b) => b > cursor).length
	assert.equal(c.histTotal, pool.size)
	for (const cur of [0, 999, 1000, 1150, 1299, 1300, 5000]) assert.equal(c.ahead(cur), recount(cur), `ahead(${cur})`)
	assert.deepEqual(c.reconcile(pool.values()), { drifted: false, histTotal: pool.size })
	// drift: a removal that never reached the counts
	const [k0, b0] = [...pool.entries()][0]!
	pool.delete(k0)
	void b0
	const rec = c.reconcile(pool.values())
	assert.equal(rec.drifted, true)
	assert.equal(c.histTotal, pool.size)
	for (const cur of [0, 1150, 5000]) assert.equal(c.ahead(cur), recount(cur))
	// removing an unknown block is a no-op
	c.remove(424242)
	assert.equal(c.histTotal, pool.size)
})
