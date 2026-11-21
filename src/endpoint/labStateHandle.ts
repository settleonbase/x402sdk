/**
 * The state handle of the Lab payout reporter (P2c-1 of PLAN-lab-signing-pools-BASELINE rev2; design DESIGN-P2c-wiring-map and errata C1-C6).
 *
 * The reporter reads and changes its state ONLY through this interface: the pending pool, the consumed set, the exited set, the scalars and the persist step. There are two implementations:
 *   - LegacyStateHandle (this file): exactly what the reporter did before - the in-memory LabClPayoutState object and the pending Map, `commit` = the existing whole-state write. Behaviour,
 *     order of effects and the files on disk are unchanged (the P2c-0 end-to-end fixture compares them).
 *   - the WAL handle (P2c-2): the same interface on top of LabPayoutStateCore and the write-ahead log.
 *
 * Rules every implementation keeps (errata C1): a write is applied at once (a later read in the same synchronous block sees it) and recorded for the next commit; `commit` returns a promise that
 * resolves when the change is durable; nothing external may happen before it resolves.
 * Node built-ins only.
 */

export type PendingLike = { eventKey: string; blockNumber: number; withdrawalIndex: number }

/** What a commit is for (WAL event labels; the legacy implementation ignores it). */
export type StateCommitLabel = 'scan' | 'intent' | 'hash' | 'settle' | 'release' | 'drop' | 'scalars' | 'halt'

/**
 * Commit scopes (design DESIGN-P2c-T1, replacing the C1 "tx round guard"): a scope marks a stretch of work whose writes must end up in ONE atomic event or in events of the allowed labels only.
 * 'scan'  - one scan window (writes span many awaits, one commit('scan') at the end); no other label may commit while it is open.
 * 'batch' - one flush batch; only the lifecycle's steps (intent, hash, settle, release) may commit inside it.
 * With no scope open any label may commit. A scope ends with commit(its own label) for 'scan', or closeScope() (always in a finally); leaving a scope without a commit KEEPS the buffered writes
 * (they are already applied in memory; the next commit of any label carries them, exactly as the legacy "persist later" did).
 */
export type ScopeLabel = 'scan' | 'batch'
const SCOPE_ALLOWS: Record<ScopeLabel, readonly StateCommitLabel[]> = { scan: ['scan'], batch: ['intent', 'hash', 'settle', 'release', 'drop'] }

/** The guard both implementations share: scope rules and the serial-tick assertion. */
export class HandleGuard {
	private scope: ScopeLabel | null = null
	private inTick = false
	openScope(label: ScopeLabel): void {
		if (this.scope !== null) throw new Error(`labStateHandle: scope '${this.scope}' is already open; cannot open '${label}'`)
		this.scope = label
	}
	closeScope(): void {
		this.scope = null
	}
	get openScopeLabel(): ScopeLabel | null {
		return this.scope
	}
	/** Throws when a commit of another kind is attempted inside an open scope; a commit with the scope's own label ('scan') closes it. */
	protected guardCommit(label: StateCommitLabel): void {
		if (this.scope !== null && !SCOPE_ALLOWS[this.scope].includes(label)) throw new Error(`labStateHandle: commit scope '${this.scope}' is open; commit '${label}' refused`)
	}
	protected scopeCommitted(label: StateCommitLabel): void {
		if (this.scope === 'scan' && label === 'scan') this.scope = null
	}
	enterTick(): void {
		if (this.inTick) throw new Error('labStateHandle: a tick is already running on this handle (ticks must be serial)')
		this.inTick = true
	}
	exitTick(): void {
		this.inTick = false
	}
	/** For paths that write outside a tick (shutdown): refuse while a tick is running instead of writing in parallel. */
	requireIdle(): void {
		if (this.inTick) throw new Error('labStateHandle: a tick is still running; refusing to write in parallel with it')
	}
}

export interface LabStateHandle<E extends PendingLike, S extends object> {
	openScope(label: ScopeLabel): void
	closeScope(): void
	enterTick(): void
	exitTick(): void
	requireIdle(): void
	// ---- reads
	readonly pendingSize: number
	pendingHas(key: string): boolean
	pendingGet(key: string): E | undefined
	pendingValues(): IterableIterator<E>
	readonly consumedSize: number
	consumedHas(key: string): boolean
	exitedHas(pubkey: string): boolean
	scalar<K extends keyof S>(name: K): S[K]
	// ---- writes (applied at once, recorded for the next commit)
	/** Adds the entries whose key is not pending yet (lower-cased key); returns how many were added. */
	pendingAdd(entries: E[]): number
	pendingDel(key: string): void
	consumedAdd(key: string): void
	exitedAdd(pubkey: string): void
	setScalar<K extends keyof S>(name: K, value: S[K]): void
	delScalar(name: keyof S): void
	// ---- durability
	commit(label: StateCommitLabel): Promise<void>
	/**
	 * Synchronous best-effort flush for the one place that cannot await: the halt path that is followed by process.exit. The legacy implementation writes the whole state (as haltDaemon always did, errors
	 * are the caller's to swallow). A log-based implementation may do nothing: whatever was not yet durable was never acted upon, so losing it equals a crash.
	 */
	haltFlush(): void
}

/** The legacy state object the handle wraps: the collections plus the scalars. */
export type LegacyStateShape<E extends PendingLike> = {
	consumedEventKeys: Record<string, true>
	exitedPubkeys: Record<string, true>
	pending?: unknown[]
} & Record<string, unknown> & { __entry?: E }

export type LegacyHandleDeps<E extends PendingLike> = {
	state: LegacyStateShape<E>
	pending: Map<string, E>
	/** The existing whole-state write (persistPending): rebuilds state.pending from the Map and writes the generation. Throws on failure. */
	persist: () => void
}

export class LegacyStateHandle<E extends PendingLike, S extends object> extends HandleGuard implements LabStateHandle<E, S> {
	constructor(private readonly d: LegacyHandleDeps<E>) {
		super()
	}

	get pendingSize(): number {
		return this.d.pending.size
	}
	pendingHas(key: string): boolean {
		return this.d.pending.has(key)
	}
	pendingGet(key: string): E | undefined {
		return this.d.pending.get(key)
	}
	pendingValues(): IterableIterator<E> {
		return this.d.pending.values()
	}
	get consumedSize(): number {
		return Object.keys(this.d.state.consumedEventKeys || {}).length
	}
	consumedHas(key: string): boolean {
		return Boolean(this.d.state.consumedEventKeys[key])
	}
	exitedHas(pubkey: string): boolean {
		return Boolean(this.d.state.exitedPubkeys[pubkey])
	}
	scalar<K extends keyof S>(name: K): S[K] {
		return (this.d.state as unknown as S)[name]
	}
	pendingAdd(entries: E[]): number {
		let added = 0
		for (const e of entries) {
			const key = e.eventKey.toLowerCase()
			if (this.d.pending.has(key)) continue
			this.d.pending.set(key, { ...e, eventKey: key })
			added++
		}
		return added
	}
	pendingDel(key: string): void {
		this.d.pending.delete(key)
	}
	consumedAdd(key: string): void {
		this.d.state.consumedEventKeys[key] = true
	}
	exitedAdd(pubkey: string): void {
		this.d.state.exitedPubkeys[pubkey.toLowerCase()] = true
	}
	setScalar<K extends keyof S>(name: K, value: S[K]): void {
		;(this.d.state as unknown as S)[name] = value
	}
	delScalar(name: keyof S): void {
		delete (this.d.state as unknown as S)[name]
	}
	haltFlush(): void {
		this.d.persist()
	}
	commit(label: StateCommitLabel): Promise<void> {
		try {
			this.guardCommit(label)
			this.d.persist()
			this.scopeCommitted(label)
		} catch (e) {
			return Promise.reject(e)
		}
		return Promise.resolve()
	}
}
