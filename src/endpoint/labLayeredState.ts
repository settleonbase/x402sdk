/**
 * Layered views for the Lab payout state (P2b-1 of PLAN-lab-signing-pools-BASELINE rev2, P2 design §2 and errata W4/W6).
 *
 * While a snapshot is being written the live state must not change underneath the writer, and the daemon must not stop. So the live maps become
 * `frozen` (read-only by convention) and every change goes to an overlay: `delta` (new or re-added keys) and `tombstones` (keys of `frozen` that were deleted).
 *   read   : delta first, then not-a-tombstone, then frozen
 *   write  : only delta / tombstones (a key present in frozen is never mutated)
 *   merge  : apply tombstones to frozen, then delta in its insertion order; the result is the new base
 * With no snapshot in flight the base map is used directly (no overlay cost).
 *
 * Iteration order is the insertion order of an ordinary Map in every state: frozen order (minus tombstones and keys that were deleted and re-added), then delta order.
 * That matters for the consumed set: prune takes the OLDEST keys first (labConsumedPrune.ts), so the order must survive freeze, merge and recovery (errata W4).
 *
 * Rules the daemon wiring must keep (independent review L1-L4):
 *  - VALUES ARE IMMUTABLE. The freeze is shallow: a value changed in place after freeze() would leak into the snapshot being written. Update by replacing the value
 *    (delete, then set), never by mutating it. set() on an existing frozen key with a different value throws; the wiring tests run pending and exited values through
 *    Object.freeze. Scalars and the in-flight record are NOT kept in a LayeredMap: they are small, copied at freeze time and carried by the log.
 *  - freeze() returns a handle with a generation token. merge(token) and abort(token) check it; the writer checks handle.isValid() on every slice and stops when the
 *    snapshot was merged or aborted under it, so it can never read a half-merged map.
 *  - HistoryBlockCounts.ahead() sums ~125k blocks (about 0.7 ms): once per tick, never per key.
 *
 * Node built-ins only.
 */

/** What freeze() returns: the read-only map for the writer plus a token that merge/abort must present. */
export type FreezeHandle<K, V> = {
	token: number
	view: ReadonlyMap<K, V>
	/** True until the snapshot is merged or aborted (or another freeze replaced it). The writer checks this on every slice. */
	isValid(): boolean
	/** Iterate the frozen entries; throws if the snapshot was merged/aborted while iterating. */
	entries(): IterableIterator<[K, V]>
}

/** A Map-like store with an optional snapshot overlay. */
export class LayeredMap<K, V> {
	private gen = 0
	private base: Map<K, V>
	private frozen: Map<K, V> | null = null
	private delta = new Map<K, V>()
	private tombs = new Set<K>()

	constructor(initial?: Iterable<readonly [K, V]>) {
		this.base = new Map<K, V>(initial)
	}

	get isFrozen(): boolean {
		return this.frozen !== null
	}

	get size(): number {
		if (this.frozen === null) return this.base.size
		return this.frozen.size - this.tombs.size + this.delta.size
	}

	has(k: K): boolean {
		if (this.frozen === null) return this.base.has(k)
		if (this.delta.has(k)) return true
		if (this.tombs.has(k)) return false
		return this.frozen.has(k)
	}

	get(k: K): V | undefined {
		if (this.frozen === null) return this.base.get(k)
		const d = this.delta.get(k)
		if (d !== undefined || this.delta.has(k)) return d
		if (this.tombs.has(k)) return undefined
		return this.frozen.get(k)
	}

	/**
	 * Set a key. Without a snapshot this is Map.set (an existing key keeps its position). With a snapshot in flight a new key goes to delta; an existing
	 * frozen key with the SAME value (===) is a no-op; with a DIFFERENT value (any other object counts as different) it THROWS (review L1): a plain Map would keep the
	 * key's position while the overlay would move it, so the layered map refuses the operation instead of silently ordering differently. Callers check has() first
	 * and replace a value with delete + set.
	 */
	set(k: K, v: V): this {
		if (this.frozen === null) {
			this.base.set(k, v)
			return this
		}
		if (this.delta.has(k)) {
			this.delta.set(k, v)
			return this
		}
		if (this.frozen.has(k) && !this.tombs.has(k)) {
			if (this.frozen.get(k) === v) return this
			throw new Error('LayeredMap: set() of an existing key with a different value while a snapshot is in flight; values are immutable, delete the key first')
		}
		this.delta.set(k, v)
		return this
	}

	delete(k: K): boolean {
		if (this.frozen === null) return this.base.delete(k)
		if (this.delta.delete(k)) return true
		if (this.frozen.has(k) && !this.tombs.has(k)) {
			this.tombs.add(k)
			return true
		}
		return false
	}

	/** Insertion order: the underlying maps' order, frozen first (skipping tombstones), then delta. */
	*keys(): IterableIterator<K> {
		if (this.frozen === null) {
			yield* this.base.keys()
			return
		}
		for (const k of this.frozen.keys()) if (!this.tombs.has(k)) yield k
		yield* this.delta.keys()
	}

	*values(): IterableIterator<V> {
		if (this.frozen === null) {
			yield* this.base.values()
			return
		}
		for (const [k, v] of this.frozen) if (!this.tombs.has(k)) yield v
		yield* this.delta.values()
	}

	*entries(): IterableIterator<[K, V]> {
		if (this.frozen === null) {
			yield* this.base.entries()
			return
		}
		for (const [k, v] of this.frozen) if (!this.tombs.has(k)) yield [k, v]
		yield* this.delta.entries()
	}

	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.entries()
	}

	/**
	 * Start a snapshot: the live base becomes read-only `frozen` and is returned for the writer; a fresh overlay takes the writes.
	 * Only one snapshot may be in flight (the caller skips and alerts otherwise); freezing twice throws.
	 */
	freeze(): FreezeHandle<K, V> {
		if (this.frozen !== null) throw new Error('LayeredMap: a snapshot is already in flight')
		this.frozen = this.base
		this.delta = new Map()
		this.tombs = new Set()
		const token = ++this.gen
		const view = this.frozen
		const self = this
		return {
			token,
			view,
			isValid: () => self.frozen === view && self.gen === token,
			*entries() {
				const it = view.entries()
				for (;;) {
					if (!(self.frozen === view && self.gen === token)) throw new Error('LayeredMap: the snapshot was merged or aborted while the writer was still reading it')
					const n = it.next()
					if (n.done) return
					yield n.value
				}
			},
		}
	}

	/** Delta and tombstone counts (metrics: peak overlay size). */
	overlaySize(): { delta: number; tombstones: number } {
		return { delta: this.delta.size, tombstones: this.tombs.size }
	}

	/** Keys added (or re-added) since the freeze, in insertion order. Small by construction (the overlay); empty without a snapshot in flight. */
	deltaKeys(): IterableIterator<K> {
		return this.delta.keys()
	}

	/**
	 * Finish the snapshot: apply the overlay to the frozen map (tombstones first, then delta in order) and make the result the base.
	 * `extraDeletes` are keys decided at snapshot time (the planned prune of the consumed set); they are applied with the tombstones.
	 * Synchronous and O(overlay + extraDeletes).
	 */
	merge(token: number, extraDeletes: Iterable<K> = []): void {
		if (this.frozen === null) throw new Error('LayeredMap: no snapshot in flight')
		if (token !== this.gen) throw new Error('LayeredMap: stale snapshot token')
		const f = this.frozen
		for (const k of this.tombs) f.delete(k)
		for (const k of extraDeletes) {
			// a pruned key that was re-added after the freeze lives in delta and must not be deleted by the prune of its older copy
			if (!this.delta.has(k)) f.delete(k)
		}
		for (const [k, v] of this.delta) {
			f.delete(k) // a re-added key moves to the end, exactly as delete + set does in a plain Map
			f.set(k, v)
		}
		this.base = f
		this.frozen = null
		this.delta = new Map()
		this.tombs = new Set()
	}

	/** Abandon the snapshot without writing it (the writer failed): same result as merge with no extra deletes. */
	abort(token: number): void {
		this.merge(token, [])
	}
}

/** An insertion-ordered set (the consumed keys, the exited pubkeys) on top of LayeredMap. */
export class LayeredSet<K> {
	private readonly m = new LayeredMap<K, true>()
	constructor(initial?: Iterable<K>) {
		if (initial) for (const k of initial) this.m.set(k, true)
	}
	get size(): number {
		return this.m.size
	}
	get isFrozen(): boolean {
		return this.m.isFrozen
	}
	has(k: K): boolean {
		return this.m.has(k)
	}
	add(k: K): this {
		if (!this.m.has(k)) this.m.set(k, true)
		return this
	}
	delete(k: K): boolean {
		return this.m.delete(k)
	}
	keys(): IterableIterator<K> {
		return this.m.keys()
	}
	[Symbol.iterator](): IterableIterator<K> {
		return this.m.keys()
	}
	freeze(): FreezeHandle<K, true> {
		return this.m.freeze()
	}
	overlaySize(): { delta: number; tombstones: number } {
		return this.m.overlaySize()
	}
	deltaKeys(): IterableIterator<K> {
		return this.m.deltaKeys()
	}
	merge(token: number, extraDeletes: Iterable<K> = []): void {
		this.m.merge(token, extraDeletes)
	}
	abort(token: number): void {
		this.m.abort(token)
	}
}

/**
 * Per-block counts of history entries in the pending pool (errata W5). The "ahead of the cursor" stock changes as the cursor moves, so a single counter
 * cannot hold it: keep a count per block and sum the blocks above the cursor on demand (about 125k distinct blocks, microseconds). Reconciled against the pool
 * at every snapshot; a mismatch is reported and the full count wins.
 */
export class HistoryBlockCounts {
	private readonly counts = new Map<number, number>()
	private total = 0
	/** Removals of a block that had no count, plus reconcile mismatches: any non-zero value means the incremental state had drifted (review L4). */
	driftEvents = 0

	constructor(private readonly onDrift?: (what: string) => void) {}

	add(blockNumber: number): void {
		this.counts.set(blockNumber, (this.counts.get(blockNumber) ?? 0) + 1)
		this.total++
	}

	remove(blockNumber: number): boolean {
		const n = this.counts.get(blockNumber)
		if (n === undefined) {
			// the pool lost an entry the counts never saw: drift, reported at once, never silent
			this.driftEvents++
			this.onDrift?.(`remove of block ${blockNumber} with no count`)
			return false
		}
		if (n <= 1) this.counts.delete(blockNumber)
		else this.counts.set(blockNumber, n - 1)
		this.total--
		return true
	}

	get histTotal(): number {
		return this.total
	}

	/** Replace the counts from a full pass WITHOUT counting drift: used when the classification itself changed (freezeH moved) and at start-up. */
	rebuild(poolHistoryBlocks: Iterable<number>): void {
		this.counts.clear()
		let total = 0
		for (const b of poolHistoryBlocks) {
			this.counts.set(b, (this.counts.get(b) ?? 0) + 1)
			total++
		}
		this.total = total
	}

	/** A copy of the per-block counts, taken at freeze time (about 125k entries, a few ms). */
	copyCounts(): Map<number, number> {
		return new Map(this.counts)
	}

	/**
	 * Snapshot-time reconcile that costs the event loop nothing extra (errata W5): the writer counts the history blocks of the FROZEN pending view while it writes the
	 * file; `atFreeze` is the copy of the counts taken at the same instant, so the two describe the same state and must be equal. Any difference is drift: it is
	 * counted, reported, and the difference is added to the LIVE counts (which have moved on since the freeze). Returns whether drift was found.
	 */
	reconcileFrozen(atFreeze: ReadonlyMap<number, number>, frozenFresh: ReadonlyMap<number, number>): { drifted: boolean; corrected: number } {
		let corrected = 0
		const blocks = new Set<number>([...atFreeze.keys(), ...frozenFresh.keys()])
		for (const b of blocks) {
			const diff = (frozenFresh.get(b) ?? 0) - (atFreeze.get(b) ?? 0)
			if (diff === 0) continue
			corrected += Math.abs(diff)
			const next = (this.counts.get(b) ?? 0) + diff
			if (next > 0) this.counts.set(b, next)
			else this.counts.delete(b)
			this.total += diff
		}
		if (corrected > 0) {
			this.driftEvents++
			this.onDrift?.(`snapshot reconcile: ${corrected} entries of difference`)
		}
		return { drifted: corrected > 0, corrected }
	}

	/** Entries in blocks strictly above the cursor. About 0.7 ms for 125k blocks: call it once per tick, never per key. */
	ahead(cursor: number): number {
		let a = 0
		for (const [b, n] of this.counts) if (b > cursor) a += n
		return a
	}

	/** Rebuild from the pool (full pass) and report whether the incremental state had drifted. The input must iterate the LIVE view (frozen + delta - tombstones). */
	reconcile(poolHistoryBlocks: Iterable<number>): { drifted: boolean; histTotal: number } {
		const fresh = new Map<number, number>()
		let total = 0
		for (const b of poolHistoryBlocks) {
			fresh.set(b, (fresh.get(b) ?? 0) + 1)
			total++
		}
		let drifted = total !== this.total || fresh.size !== this.counts.size
		if (!drifted) for (const [b, n] of fresh) if (this.counts.get(b) !== n) { drifted = true; break }
		if (drifted) {
			this.driftEvents++
			this.onDrift?.('reconcile mismatch')
		}
		this.counts.clear()
		for (const [b, n] of fresh) this.counts.set(b, n)
		this.total = total
		return { drifted, histTotal: total }
	}
}
