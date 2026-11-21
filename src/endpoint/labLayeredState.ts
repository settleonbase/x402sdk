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
 * Node built-ins only.
 */

/** A Map-like store with an optional snapshot overlay. */
export class LayeredMap<K, V> {
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
	 * frozen key with the same value is a no-op; with a different value it is moved to the end (tombstone + delta), because frozen is never mutated.
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
			this.tombs.add(k)
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
	freeze(): ReadonlyMap<K, V> {
		if (this.frozen !== null) throw new Error('LayeredMap: a snapshot is already in flight')
		this.frozen = this.base
		this.delta = new Map()
		this.tombs = new Set()
		return this.frozen
	}

	/** The frozen map while a snapshot is in flight (what the writer reads), else null. */
	frozenView(): ReadonlyMap<K, V> | null {
		return this.frozen
	}

	/** Delta and tombstone counts (metrics: peak overlay size). */
	overlaySize(): { delta: number; tombstones: number } {
		return { delta: this.delta.size, tombstones: this.tombs.size }
	}

	/**
	 * Finish the snapshot: apply the overlay to the frozen map (tombstones first, then delta in order) and make the result the base.
	 * `extraDeletes` are keys decided at snapshot time (the planned prune of the consumed set); they are applied with the tombstones.
	 * Synchronous and O(overlay + extraDeletes).
	 */
	merge(extraDeletes: Iterable<K> = []): void {
		if (this.frozen === null) throw new Error('LayeredMap: no snapshot in flight')
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
	abort(): void {
		this.merge([])
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
	freeze(): ReadonlyMap<K, true> {
		return this.m.freeze()
	}
	frozenView(): ReadonlyMap<K, true> | null {
		return this.m.frozenView()
	}
	overlaySize(): { delta: number; tombstones: number } {
		return this.m.overlaySize()
	}
	merge(extraDeletes: Iterable<K> = []): void {
		this.m.merge(extraDeletes)
	}
	abort(): void {
		this.m.abort()
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

	add(blockNumber: number): void {
		this.counts.set(blockNumber, (this.counts.get(blockNumber) ?? 0) + 1)
		this.total++
	}

	remove(blockNumber: number): void {
		const n = this.counts.get(blockNumber)
		if (n === undefined) return
		if (n <= 1) this.counts.delete(blockNumber)
		else this.counts.set(blockNumber, n - 1)
		this.total--
	}

	get histTotal(): number {
		return this.total
	}

	/** Entries in blocks strictly above the cursor. */
	ahead(cursor: number): number {
		let a = 0
		for (const [b, n] of this.counts) if (b > cursor) a += n
		return a
	}

	/** Rebuild from the pool (full pass) and report whether the incremental state had drifted. */
	reconcile(poolHistoryBlocks: Iterable<number>): { drifted: boolean; histTotal: number } {
		const fresh = new Map<number, number>()
		let total = 0
		for (const b of poolHistoryBlocks) {
			fresh.set(b, (fresh.get(b) ?? 0) + 1)
			total++
		}
		let drifted = total !== this.total || fresh.size !== this.counts.size
		if (!drifted) for (const [b, n] of fresh) if (this.counts.get(b) !== n) { drifted = true; break }
		this.counts.clear()
		for (const [b, n] of fresh) this.counts.set(b, n)
		this.total = total
		return { drifted, histTotal: total }
	}
}
