/**
 * The Lab payout state container for WAL mode (P2b-2 of PLAN-lab-signing-pools-BASELINE rev2; P2 design §2/§4/§6, errata W1, W4, W5, W6).
 *
 * It owns the three collections as layered views (labLayeredState.ts), the scalars, the in-flight withdrawal record and the per-block history counts, and it is the
 * apply target of the WAL replay engine (WalApplyTarget). The daemon wiring (P2c) changes state ONLY through record() (append the event, then apply it in the same synchronous block)
 * or through replay; it never touches the maps directly (the W6 source test keeps it that way).
 *
 * Snapshot life cycle (cooperative, one in flight):
 *   freezeForSnapshot()  O(1) + a copy of the scalars and of the block counts: the three collections become frozen, writes go to the overlay
 *   ... the snapshot writer reads the frozen views in slices (labSnapshotWriter.ts), then commits the manifest ...
 *   finishSnapshot()     merge (synchronous, O(overlay + planned prune)) after a commit, abort (overlay folded back, nothing pruned) after a failure
 *
 * Values are immutable: pending entries and the in-flight record are deep-frozen when they enter. A change is delete + set, never an in-place edit (review L2).
 * Node built-ins only.
 */
import { HistoryBlockCounts, LayeredMap, LayeredSet, type FreezeHandle } from './labLayeredState'
import { applyOps, type WalApplyTarget, type WalEvent, type WalOp } from './labWal'

export type PendingEntry = Readonly<{ eventKey: string } & Record<string, unknown>>
export type InFlightRecord = Readonly<Record<string, unknown>>

/** Scalar names that belong to the collections or to the in-flight record, never to the plain scalars. */
const RESERVED_SCALARS: ReadonlySet<string> = new Set(['pending', 'consumedEventKeys', 'exitedPubkeys', 'inFlightWithdraw', 'inFlightByWallet', '__proto__'])

export function deepFreeze<T>(v: T): T {
	if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v
	for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
	return Object.freeze(v)
}

/** JSON round trip: a fresh, independent copy of the plain-JSON value (what a snapshot stores); drops undefined like the state store does. */
function jsonClone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T
}

export type CoreInit = {
	/** P4: the per-wallet in-flight slots of the loaded snapshot. */
	slots?: Record<string, InFlightRecord>
	pending?: Iterable<PendingEntry>
	/** In insertion (oldest first) order: that is the prune order. */
	consumed?: Iterable<string>
	exited?: Iterable<string>
	scalars?: Record<string, unknown>
	inFlight?: InFlightRecord | null
	/** Seq of the last WAL event contained in the loaded snapshot; replay continues after it. */
	lastAppliedSeq?: number
}

export type SnapshotSource = {
	/** The seq of the last event applied to memory at the freeze: the snapshot contains exactly the events up to it. */
	walSeq: number
	/** Independent copy of the scalars, with the in-flight record under `inFlightWithdraw` (when there is one). */
	scalars: Record<string, unknown>
	pending: FreezeHandle<string, PendingEntry>
	consumed: FreezeHandle<string, true>
	exited: FreezeHandle<string, true>
	/** Copy of the per-block history counts at the freeze instant; the writer's own count of the frozen pending view must equal it (W5). */
	countsAtFreeze: Map<number, number>
	/** The history/realtime boundary at the freeze (scalars.freezeH.height) or null. The writer classifies pending entries with it. */
	freezeH: number | null
}

export type SnapshotOutcome =
	| { committed: true; prunedKeys: string[]; frozenHistCounts?: Map<number, number> }
	| { committed: false }

export interface WalAppender {
	append(t: string, ops: WalOp[]): { seq: number; durable: Promise<void> }
}

export class LabPayoutStateCore implements WalApplyTarget {
	readonly pending = new LayeredMap<string, PendingEntry>()
	readonly consumed = new LayeredSet<string>()
	readonly exited = new LayeredSet<string>()
	readonly counts: HistoryBlockCounts
	private scalars: Record<string, unknown> = {}
	private inFlight: InFlightRecord | null = null
	/** P4: one in-flight batch per wallet, and the owner of every event key that is in one (the reserved set). */
	private readonly slots = new Map<string, InFlightRecord>()
	private readonly slotKeyOwner = new Map<string, string>()
	private appliedSeq = 0
	private snap: SnapshotSource | null = null
	/** Snapshot statistics for the journal. */
	stats = { snapshotsStarted: 0, snapshotsCommitted: 0, snapshotsAborted: 0, peakPendingDelta: 0, peakPendingTombstones: 0, peakConsumedDelta: 0 }

	constructor(init: CoreInit = {}, opts: { onDrift?: (what: string) => void } = {}) {
		this.counts = new HistoryBlockCounts(opts.onDrift)
		for (const e of init.pending ?? []) this.pending.set(e.eventKey, deepFreeze(e))
		for (const k of init.consumed ?? []) this.consumed.add(k)
		for (const k of init.exited ?? []) this.exited.add(k)
		for (const [k, v] of Object.entries(init.scalars ?? {})) this.setScalar(k, v)
		this.inFlight = init.inFlight ? deepFreeze(init.inFlight) : null
		for (const [w, rec] of Object.entries(init.slots ?? {})) this.setSlot(w, rec)
		this.appliedSeq = init.lastAppliedSeq ?? 0
		this.rebuildCounts()
	}

	// ------------------------------------------------------------------ reads (the daemon's only way to look at the state)
	get lastAppliedSeq(): number {
		return this.appliedSeq
	}
	get snapshotInFlight(): boolean {
		return this.snap !== null
	}
	get pendingSize(): number {
		return this.pending.size
	}
	get consumedSize(): number {
		return this.consumed.size
	}
	get exitedSize(): number {
		return this.exited.size
	}
	pendingHas(key: string): boolean {
		return this.pending.has(key)
	}
	pendingGet(key: string): PendingEntry | undefined {
		return this.pending.get(key)
	}
	pendingEntries(): IterableIterator<PendingEntry> {
		return this.pending.values()
	}
	consumedHas(key: string): boolean {
		return this.consumed.has(key)
	}
	consumedKeys(): IterableIterator<string> {
		return this.consumed.keys()
	}
	exitedHas(pubkey: string): boolean {
		return this.exited.has(pubkey)
	}
	getScalar(name: string): unknown {
		return this.scalars[name]
	}
	getInFlight(): InFlightRecord | null {
		return this.inFlight
	}
	// ---- P4 per-wallet slots
	getSlot(wallet: string): InFlightRecord | null {
		return this.slots.get(wallet) ?? null
	}
	get slotCount(): number {
		return this.slots.size
	}
	slotEntries(): IterableIterator<[string, InFlightRecord]> {
		return this.slots.entries()
	}
	/** The wallet whose in-flight batch holds this event key (reserved: no other wallet may claim it, a rescan must not re-add it), or undefined. */
	slotOwnerOfKey(key: string): string | undefined {
		return this.slotKeyOwner.get(key)
	}
	/** Sum of the amounts (wei) of all slots: money that is out of the redeem contract's balance but not yet settled. */
	slotsAmountWei(): bigint {
		let n = 0n
		for (const r of this.slots.values()) n += BigInt(String((r as Record<string, unknown>).amountWei ?? '0'))
		return n
	}
	/** An independent copy of the plain scalars (not the in-flight record). */
	scalarsCopy(): Record<string, unknown> {
		return jsonClone(this.scalars)
	}
	get histTotal(): number {
		return this.counts.histTotal
	}
	/** History entries beyond `cursor` (not payable yet). About 0.7 ms: once per tick. */
	histAhead(cursor: number): number {
		return this.counts.ahead(cursor)
	}

	// ------------------------------------------------------------------ history classification (W5)
	freezeHeight(): number | null {
		const f = this.scalars.freezeH as { height?: unknown } | undefined
		return f && typeof f.height === 'number' && Number.isFinite(f.height) ? f.height : null
	}
	private histBlock(entry: PendingEntry, freezeH: number | null = this.freezeHeight()): number | null {
		const b = entry.blockNumber
		if (typeof b !== 'number' || freezeH === null || b > freezeH) return null
		return b
	}
	private rebuildCounts(): void {
		const fh = this.freezeHeight()
		const blocks: number[] = []
		for (const e of this.pending.values()) {
			const b = this.histBlock(e, fh)
			if (b !== null) blocks.push(b)
		}
		this.counts.rebuild(blocks)
	}

	// ------------------------------------------------------------------ WalApplyTarget (replay and live apply share it)
	pendingSet(entry: { eventKey: string } & Record<string, unknown>): void {
		const frozen = deepFreeze(entry) as PendingEntry
		const existing = this.pending.get(frozen.eventKey)
		if (existing !== undefined) {
			if (existing === frozen) return
			this.pendingDelete(frozen.eventKey) // a replaced value is delete + set (values are immutable)
		}
		this.pending.set(frozen.eventKey, frozen)
		const b = this.histBlock(frozen)
		if (b !== null) this.counts.add(b)
	}
	pendingDelete(key: string): void {
		const existing = this.pending.get(key)
		if (existing === undefined) return // idempotent
		this.pending.delete(key)
		const b = this.histBlock(existing)
		if (b !== null) this.counts.remove(b)
	}
	consumedAdd(key: string): void {
		this.consumed.add(key)
	}
	exitedAdd(pubkey: string): void {
		this.exited.add(pubkey)
	}
	setScalar(name: string, value: unknown): void {
		if (RESERVED_SCALARS.has(name)) throw new Error(`labPayoutStateCore: ${name} is not a plain scalar`)
		const before = name === 'freezeH' ? this.freezeHeight() : null
		this.scalars[name] = value === undefined ? undefined : jsonClone(value)
		if (value === undefined) delete this.scalars[name]
		if (name === 'freezeH' && this.freezeHeight() !== before) this.rebuildCounts() // the history/realtime classification moved
	}
	deleteScalar(name: string): void {
		if (RESERVED_SCALARS.has(name)) throw new Error(`labPayoutStateCore: ${name} is not a plain scalar`)
		const had = name === 'freezeH' ? this.freezeHeight() : null
		delete this.scalars[name]
		if (name === 'freezeH' && had !== null) this.rebuildCounts()
	}
	setInFlight(record: Record<string, unknown> | null): void {
		this.inFlight = record === null ? null : deepFreeze(jsonClone(record))
	}
	setSlot(wallet: string, record: Record<string, unknown> | null): void {
		const old = this.slots.get(wallet)
		if (old) for (const k of ((old as Record<string, unknown>).eventKeys as string[] | undefined) ?? []) if (this.slotKeyOwner.get(k) === wallet) this.slotKeyOwner.delete(k)
		if (record === null) {
			this.slots.delete(wallet)
			return
		}
		const frozen = deepFreeze(jsonClone(record))
		this.slots.set(wallet, frozen)
		for (const k of ((frozen as Record<string, unknown>).eventKeys as string[] | undefined) ?? []) this.slotKeyOwner.set(k, wallet)
	}

	/** Replay: apply one event read from the log. Events at or below the loaded snapshot are filtered by the scan (afterSeq), not here. */
	applyEvent(ev: WalEvent): void {
		if (ev.seq <= this.appliedSeq) return // already contained (a replay overlap); every op is idempotent anyway
		applyOps(this, ev.ops)
		this.appliedSeq = ev.seq
	}

	/**
	 * Live path: append the event to the log and apply it to memory in the same synchronous block. Nothing external may happen before `durable` resolves.
	 * A refused append (writer dead, event too large) applies nothing.
	 */
	record(wal: WalAppender, t: string, ops: WalOp[]): { seq: number; durable: Promise<void> } {
		const r = wal.append(t, ops)
		if (r.seq < 0) return r
		applyOps(this, ops)
		this.appliedSeq = r.seq
		return r
	}

	// ------------------------------------------------------------------ cooperative snapshot
	freezeForSnapshot(): SnapshotSource {
		if (this.snap) throw new Error('labPayoutStateCore: a snapshot is already in flight')
		const scalars = this.scalarsCopy()
		if (this.inFlight) scalars.inFlightWithdraw = jsonClone(this.inFlight)
		if (this.slots.size > 0) scalars.inFlightByWallet = Object.fromEntries([...this.slots.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([w, r]) => [w, jsonClone(r)]))
		const pending = this.pending.freeze()
		let consumed: FreezeHandle<string, true>
		let exited: FreezeHandle<string, true>
		try {
			consumed = this.consumed.freeze()
			try {
				exited = this.exited.freeze()
			} catch (e) {
				this.consumed.abort(consumed.token)
				throw e
			}
		} catch (e) {
			this.pending.abort(pending.token)
			throw e
		}
		this.snap = { walSeq: this.appliedSeq, scalars, pending, consumed, exited, countsAtFreeze: this.counts.copyCounts(), freezeH: this.freezeHeight() }
		this.stats.snapshotsStarted++
		return this.snap
	}

	private notePeaks(): void {
		const p = this.pending.overlaySize()
		const c = this.consumed.overlaySize()
		this.stats.peakPendingDelta = Math.max(this.stats.peakPendingDelta, p.delta)
		this.stats.peakPendingTombstones = Math.max(this.stats.peakPendingTombstones, p.tombstones)
		this.stats.peakConsumedDelta = Math.max(this.stats.peakConsumedDelta, c.delta)
	}

	/**
	 * End the snapshot. After a commit: fold the overlay into the frozen maps, apply the planned prune (not to a key that is pending again or was re-added to consumed after the
	 * freeze), and reconcile the block counts against the writer's own count. After a failure: fold the overlay back and prune nothing. Synchronous.
	 */
	finishSnapshot(src: SnapshotSource, outcome: SnapshotOutcome): { pruned: number; drift: boolean } {
		if (this.snap !== src) throw new Error('labPayoutStateCore: finishSnapshot with a snapshot that is not the one in flight')
		this.notePeaks()
		let pruned = 0
		let drift = false
		if (outcome.committed) {
			// a key that became pending after the freeze is not covered by the planner's pending check: protect it here
			const lateLower = new Set<string>()
			for (const k of this.pending.deltaKeys()) lateLower.add(k.toLowerCase())
			const dropList = outcome.prunedKeys.filter((k) => !lateLower.has(k.toLowerCase()))
			this.pending.merge(src.pending.token)
			this.consumed.merge(src.consumed.token, dropList)
			this.exited.merge(src.exited.token)
			pruned = dropList.length
			if (outcome.frozenHistCounts) drift = this.counts.reconcileFrozen(src.countsAtFreeze, outcome.frozenHistCounts).drifted
			this.stats.snapshotsCommitted++
		} else {
			this.pending.abort(src.pending.token)
			this.consumed.abort(src.consumed.token)
			this.exited.abort(src.exited.token)
			this.stats.snapshotsAborted++
		}
		this.snap = null
		return { pruned, drift }
	}
}
