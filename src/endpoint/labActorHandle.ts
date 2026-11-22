/**
 * Concurrent-actor state handles for the Lab payout daemon (P3 of PLAN-lab-signing-pools-BASELINE rev2; design DESIGN-pools-P3-P4-onepager v1 + v2 conditions).
 *
 * Several actors (the scan loop, one payment worker per wallet) share ONE core and ONE write-ahead log. Each actor sees the core plus its own uncommitted writes (its overlay) and nothing of the
 * other actors' uncommitted writes. A commit turns the actor's overlay into ONE atomic event: build the ops, append them and apply them to the core in the same synchronous block
 * (LabPayoutStateCore.record), then wait for durability. So the core always equals a prefix of the log (no half scan window, no op that a crash would lose is ever visible to a payer), and a snapshot may
 * freeze at any time.
 *
 * Writes that depend on the committed value are computed AT COMMIT, in that synchronous block (never from what the actor read earlier):
 *   incScalar         committed value + delta   (settledBatchCount: two wallets each settling N batches end at 2N)
 *   setScalarIfUnset  set only if the committed value is unset (gasWaitStartedAt: the first actor starts the clock)
 *   cursorHighWater   max of the committed high-water, the committed cursors and the cursors this commit sets
 * A pendingAdd whose key has become consumed (or pending) since the actor looked is dropped at commit: consumed wins, a paid key never returns to the pool.
 *
 * Scopes are per actor (HandleGuard is per ActorView): a second scope on the SAME actor is refused, scopes of different actors interleave freely.
 * Node built-ins only.
 */
import { assertCursorMonotonic } from './labMiningPoolDualCursor'
import { HandleGuard, type LabStateHandle, type PendingLike, type StateCommitLabel } from './labStateHandle'
import type { LabPayoutStateCore } from './labPayoutStateCore'
import type { WalOp } from './labWal'

export type ActorHubDeps = {
	core: LabPayoutStateCore
	wal: { append(t: string, ops: WalOp[]): { seq: number; durable: Promise<void> }; whenDurable(seq: number): Promise<void>; readonly lastSeq: number }
	/** The log refused an append: the memory is ahead of the log. Default: stderr and exit(70) (fail-stop, as the single-actor handle). */
	onFatal?: (err: Error) => void
	log?: (line: string) => void
	/** Keys that must not be (re)added to the pending pool at commit although they are not consumed: the union of the wallets' in-flight batches (P4). */
	reserved?: (key: string) => boolean
}

const IN_FLIGHT = 'inFlightWithdraw'
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

type ScalarWrite = { set?: unknown; del?: true; inc?: number; ifUnset?: unknown }

export class ActorHub<E extends PendingLike, S extends object> {
	private readonly byName = new Map<string, ActorView<E, S>>()
	readonly onFatal: (err: Error) => void
	/** Counters for the journal and the tests. */
	stats = { commits: 0, emptyCommits: 0, droppedConsumedAdds: 0, droppedReservedAdds: 0 }
	constructor(readonly d: ActorHubDeps) {
		this.onFatal =
			d.onFatal ??
			((err) => {
				process.stderr.write(`[labActorHandle] FATAL ${err.message}; exiting (fail-stop)\n`)
				process.exit(70)
			})
	}
	/** The handle of one actor; the same name returns the same view. */
	actor(name: string): ActorView<E, S> {
		let a = this.byName.get(name)
		if (!a) {
			a = new ActorView<E, S>(this, name)
			this.byName.set(name, a)
		}
		return a
	}
	get actorNames(): string[] {
		return [...this.byName.keys()]
	}
	/**
	 * Snapshot gate: the core never holds a write that is not in the log, so there is nothing to wait for (the single-actor handle's K4 gate does not apply). Kept as a function so the
	 * scheduler's wiring is the same shape.
	 */
	hasUncommittedWrites(): boolean {
		return false
	}
	/** Diagnostics only: some actor holds writes it has not committed yet. */
	anyOverlay(): boolean {
		for (const a of this.byName.values()) if (a.overlayCount() > 0) return true
		return false
	}
}

export class ActorView<E extends PendingLike, S extends object> extends HandleGuard implements LabStateHandle<E, S> {
	private ops: WalOp[] = []
	/** key -> entry (added in this overlay) or null (deleted in this overlay). */
	private ovPending = new Map<string, ({ eventKey: string } & Record<string, unknown>) | null>()
	private ovConsumed = new Set<string>()
	private ovExited = new Set<string>()
	private sc = new Map<string, ScalarWrite>()
	/** undefined = not read yet; null = no record; object = the live mutable copy of the in-flight record. */
	private live: Record<string, unknown> | null | undefined = undefined
	private carried = 0

	constructor(
		private readonly hub: ActorHub<E, S>,
		readonly name: string
	) {
		super()
	}
	private get core(): LabPayoutStateCore {
		return this.hub.d.core
	}

	overlayCount(): number {
		return this.ops.length + this.sc.size + (this.live !== undefined && JSON.stringify(this.live) !== JSON.stringify(this.core.getInFlight()) ? 1 : 0)
	}

	// ------------------------------------------------------------------ reads: the core plus this actor's own overlay
	private viewHasPending(key: string): boolean {
		const o = this.ovPending.get(key)
		if (o !== undefined) return o !== null
		return this.core.pendingHas(key)
	}
	get pendingSize(): number {
		let n = this.core.pendingSize
		for (const [k, v] of this.ovPending) {
			const inCore = this.core.pendingHas(k)
			if (v !== null && !inCore) n++
			else if (v === null && inCore) n--
		}
		return n
	}
	pendingHas(key: string): boolean {
		return this.viewHasPending(key)
	}
	pendingGet(key: string): E | undefined {
		const o = this.ovPending.get(key)
		if (o !== undefined) return (o ?? undefined) as unknown as E | undefined
		return this.core.pendingGet(key) as unknown as E | undefined
	}
	*pendingValues(): IterableIterator<E> {
		for (const e of this.core.pendingEntries()) {
			const o = this.ovPending.get(e.eventKey)
			if (o === undefined) yield e as unknown as E
			else if (o !== null) yield o as unknown as E
		}
		for (const [k, v] of this.ovPending) if (v !== null && !this.core.pendingHas(k)) yield v as unknown as E
	}
	get consumedSize(): number {
		let n = this.core.consumedSize
		for (const k of this.ovConsumed) if (!this.core.consumedHas(k)) n++
		return n
	}
	consumedHas(key: string): boolean {
		return this.ovConsumed.has(key) || this.core.consumedHas(key)
	}
	exitedHas(pubkey: string): boolean {
		return this.ovExited.has(pubkey) || this.core.exitedHas(pubkey)
	}
	scalar<K extends keyof S>(name: K): S[K] {
		const n = name as string
		if (n === IN_FLIGHT) {
			if (this.live === undefined) {
				const cur = this.core.getInFlight()
				this.live = cur ? clone(cur as Record<string, unknown>) : null
			}
			return (this.live ?? undefined) as S[K]
		}
		const w = this.sc.get(n)
		const committed = this.core.getScalar(n)
		if (!w) return committed as S[K]
		if (w.del) return undefined as S[K]
		if (w.set !== undefined) return w.set as S[K]
		if (w.inc !== undefined) return ((typeof committed === 'number' ? committed : 0) + w.inc) as unknown as S[K]
		if (w.ifUnset !== undefined) return (committed === undefined ? w.ifUnset : committed) as S[K]
		return committed as S[K]
	}

	// ------------------------------------------------------------------ writes: into the overlay only
	pendingAdd(entries: E[]): number {
		let added = 0
		for (const e of entries) {
			const key = e.eventKey.toLowerCase()
			if (this.viewHasPending(key)) continue
			const raw = e as unknown as Record<string, unknown>
			const entry = { ...raw, eventKey: key, amount: String(raw.amount), pubkey: typeof raw.pubkey === 'string' ? raw.pubkey.toLowerCase() : raw.pubkey } as { eventKey: string } & Record<string, unknown>
			this.ops.push({ op: 'pendingAdd', entry })
			this.ovPending.set(key, entry)
			added++
		}
		return added
	}
	pendingDel(key: string): void {
		if (!this.viewHasPending(key)) return
		this.ops.push({ op: 'pendingDel', key })
		this.ovPending.set(key, null)
	}
	consumedAdd(key: string): void {
		this.ops.push({ op: 'consumedAdd', key })
		this.ovConsumed.add(key)
	}
	exitedAdd(pubkey: string): void {
		const k = pubkey.toLowerCase()
		this.ops.push({ op: 'exitedAdd', pubkey: k })
		this.ovExited.add(k)
	}
	setScalar<K extends keyof S>(name: K, value: S[K]): void {
		if (value === undefined) return this.delScalar(name)
		const n = name as string
		if (n === IN_FLIGHT) {
			this.live = value as unknown as Record<string, unknown>
			return
		}
		// checked BEFORE it is recorded: a refused value changes nothing (against the committed high-water and this actor's own earlier writes)
		if (n === 'lastBackfillProcessedBlock' || n === 'lastListeningEndBlock') {
			const hw = (this.core.getScalar('cursorHighWater') ?? {}) as { backfill?: number; listen?: number }
			assertCursorMonotonic(n, n === 'lastBackfillProcessedBlock' ? hw.backfill : hw.listen, value as number)
		}
		this.sc.set(n, { set: clone(value) })
	}
	delScalar(name: keyof S): void {
		const n = name as string
		if (n === IN_FLIGHT) {
			this.live = null
			return
		}
		this.sc.set(n, { del: true })
	}
	incScalar<K extends keyof S>(name: K, delta: number): void {
		const n = name as string
		const w = this.sc.get(n)
		if (!w) this.sc.set(n, { inc: delta })
		else if (w.set !== undefined && typeof w.set === 'number') w.set += delta
		else if (w.del) this.sc.set(n, { set: delta })
		else if (w.inc !== undefined) w.inc += delta
		else if (w.ifUnset !== undefined && typeof w.ifUnset === 'number') this.sc.set(n, { set: delta })
		else this.sc.set(n, { inc: delta })
	}
	setScalarIfUnset<K extends keyof S>(name: K, value: S[K]): void {
		const n = name as string
		if (!this.sc.has(n)) this.sc.set(n, { ifUnset: clone(value) })
	}

	/** Leaving a scope with uncommitted writes keeps them in the overlay: the next commit of this actor carries them (and says so in the log). */
	override closeScope(): void {
		if (this.openScopeLabel !== null) this.carried += this.ops.length + this.sc.size
		super.closeScope()
	}

	// ------------------------------------------------------------------ durability
	/** Builds this actor's single event against the CURRENT committed core. Synchronous: the caller records it in the same block. */
	private buildOps(): WalOp[] {
		const out: WalOp[] = []
		const consumedHere = new Set<string>()
		for (const op of this.ops) {
			if (op.op === 'consumedAdd') consumedHere.add(op.key)
			if (op.op === 'pendingAdd') {
				const k = op.entry.eventKey
				if (this.core.consumedHas(k) || consumedHere.has(k)) {
					this.hub.stats.droppedConsumedAdds++
					continue
				}
				if (this.hub.d.reserved?.(k)) {
					this.hub.stats.droppedReservedAdds++
					continue
				}
			}
			out.push(op)
		}
		const patch: Record<string, unknown> = {}
		const dels: string[] = []
		for (const [n, w] of this.sc) {
			const committed = this.core.getScalar(n)
			if (w.del) dels.push(n)
			else if (w.set !== undefined) patch[n] = w.set
			else if (w.inc !== undefined) patch[n] = (typeof committed === 'number' ? committed : 0) + w.inc
			else if (w.ifUnset !== undefined && committed === undefined) patch[n] = w.ifUnset
		}
		if (this.live !== undefined) {
			const cur = this.core.getInFlight()
			if (JSON.stringify(this.live) !== JSON.stringify(cur)) out.push({ op: 'inFlightSet', record: this.live === null ? null : clone(this.live) })
		}
		// the persisted cursor high-water follows the cursors (what the legacy write did on every persist), computed from the committed values
		const hw = (this.core.getScalar('cursorHighWater') ?? {}) as { backfill?: number; listen?: number }
		const num = (v: unknown): number => (typeof v === 'number' ? v : -1)
		const nb = Math.max(hw.backfill ?? -1, num(this.core.getScalar('lastBackfillProcessedBlock')), num(patch.lastBackfillProcessedBlock))
		const nl = Math.max(hw.listen ?? -1, num(this.core.getScalar('lastListeningEndBlock')), num(patch.lastListeningEndBlock))
		if (nb !== (hw.backfill ?? -1) || nl !== (hw.listen ?? -1)) patch.cursorHighWater = { backfill: nb, listen: nl }
		if (Object.keys(patch).length > 0) out.push({ op: 'scalarsSet', patch })
		if (dels.length > 0) out.push({ op: 'scalarsDel', names: dels })
		return out
	}

	private clearOverlay(): void {
		this.ops = []
		this.ovPending = new Map()
		this.ovConsumed = new Set()
		this.ovExited = new Set()
		this.sc = new Map()
		this.live = undefined
	}

	async commit(label: StateCommitLabel): Promise<void> {
		this.guardCommit(label)
		const ops = this.buildOps()
		if (this.carried > 0) {
			this.hub.d.log?.(`[labMiningPoolClPayout] actor ${this.name}: carried ${this.carried} ops from an aborted scope into the '${label}' commit`)
			this.carried = 0
		}
		this.hub.stats.commits++
		if (ops.length === 0) {
			this.hub.stats.emptyCommits++
			this.clearOverlay()
			await this.hub.d.wal.whenDurable(this.hub.d.wal.lastSeq)
			this.scopeCommitted(label)
			return
		}
		const r = this.core.record(this.hub.d.wal, label, ops)
		this.clearOverlay()
		if (r.seq < 0) {
			void r.durable.catch(() => undefined)
			const err = new Error(`labActorHandle: the log refused the '${label}' event of actor ${this.name} (${ops.length} ops); memory is not ahead of the log, but the actor cannot continue`)
			this.hub.onFatal(err)
			throw err
		}
		await r.durable
		this.scopeCommitted(label)
	}

	haltFlush(): void {
		try {
			const ops = this.buildOps()
			if (ops.length > 0) void this.core.record(this.hub.d.wal, 'halt', ops).durable.catch(() => undefined)
			this.clearOverlay()
		} catch {
			/* exiting anyway */
		}
	}
}
