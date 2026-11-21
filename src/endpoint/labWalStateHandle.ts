/**
 * The WAL implementation of the Lab state handle (P2c-2): the same interface as LegacyStateHandle on top of LabPayoutStateCore and the write-ahead log.
 *
 * Writes are applied to the core AT ONCE (a later read in the same synchronous block sees them) and recorded in a buffer; commit(label) turns the whole buffer into ONE atomic event
 * (design T1: a scan window = one event, a lifecycle step = one event), appends it, and resolves when it is durable. Nothing external may happen before that.
 * Scalars set several times between two commits are coalesced into one scalarsSet; the in-flight record is a live mutable copy (the lifecycle changes it in place, e.g. rec.hash = ...) that is
 * compared with the core's copy at commit and journaled as inFlightSet when it differs; cursor monotonicity is checked BEFORE a value is applied (review C1 point 2).
 * An append that is refused (log dead, event too large) is fatal: memory would be ahead of the log, so onFatal runs (default: exit non-zero, W2 fail-stop).
 */
import { assertCursorMonotonic } from './labMiningPoolDualCursor'
import { HandleGuard, type LabStateHandle, type PendingLike, type StateCommitLabel } from './labStateHandle'
import type { LabPayoutStateCore, PendingEntry } from './labPayoutStateCore'
import type { WalOp } from './labWal'

export type WalHandleDeps = {
	core: LabPayoutStateCore
	wal: { append(t: string, ops: WalOp[]): { seq: number; durable: Promise<void> }; whenDurable(seq: number): Promise<void>; readonly lastSeq: number }
	/** Called when the log refused an append (the memory is ahead of the log). Default: log and exit(70). */
	onFatal?: (err: Error) => void
	/** Operator log line sink (S3: "carried N ops from an aborted scope"). */
	log?: (line: string) => void
}

const IN_FLIGHT = 'inFlightWithdraw'
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export class WalStateHandle<E extends PendingLike, S extends object> extends HandleGuard implements LabStateHandle<E, S> {
	private buf: WalOp[] = []
	private patch: Record<string, unknown> = {}
	private dels = new Set<string>()
	/** undefined = not read yet; null = no record; object = the live mutable copy of the in-flight record. */
	private live: Record<string, unknown> | null | undefined = undefined
	private readonly onFatal: (err: Error) => void
	/** Ops that were still buffered when a scope was left without its commit (an exception inside the window): the next commit of any label carries them (S3). */
	private carried = 0

	constructor(private readonly d: WalHandleDeps) {
		super()
		this.onFatal =
			d.onFatal ??
			((err) => {
				process.stderr.write(`[labWalStateHandle] FATAL ${err.message}; exiting (fail-stop)\n`)
				process.exit(70)
			})
	}

	// ------------------------------------------------------------------ reads
	get pendingSize(): number {
		return this.d.core.pendingSize
	}
	pendingHas(key: string): boolean {
		return this.d.core.pendingHas(key)
	}
	pendingGet(key: string): E | undefined {
		return this.d.core.pendingGet(key) as unknown as E | undefined
	}
	pendingValues(): IterableIterator<E> {
		return this.d.core.pendingEntries() as unknown as IterableIterator<E>
	}
	get consumedSize(): number {
		return this.d.core.consumedSize
	}
	consumedHas(key: string): boolean {
		return this.d.core.consumedHas(key)
	}
	exitedHas(pubkey: string): boolean {
		return this.d.core.exitedHas(pubkey)
	}
	scalar<K extends keyof S>(name: K): S[K] {
		if (name === IN_FLIGHT) {
			if (this.live === undefined) {
				const cur = this.d.core.getInFlight()
				this.live = cur ? clone(cur as Record<string, unknown>) : null
			}
			return (this.live ?? undefined) as S[K]
		}
		return this.d.core.getScalar(name as string) as S[K]
	}

	// ------------------------------------------------------------------ writes
	pendingAdd(entries: E[]): number {
		let added = 0
		for (const e of entries) {
			const key = e.eventKey.toLowerCase()
			if (this.d.core.pendingHas(key)) continue
			const raw = e as unknown as Record<string, unknown>
			const entry = { ...raw, eventKey: key, amount: String(raw.amount), pubkey: typeof raw.pubkey === 'string' ? raw.pubkey.toLowerCase() : raw.pubkey } as { eventKey: string } & Record<string, unknown>
			this.buf.push({ op: 'pendingAdd', entry })
			this.d.core.pendingSet(entry)
			added++
		}
		return added
	}
	pendingDel(key: string): void {
		if (!this.d.core.pendingHas(key)) return
		this.buf.push({ op: 'pendingDel', key })
		this.d.core.pendingDelete(key)
	}
	consumedAdd(key: string): void {
		this.buf.push({ op: 'consumedAdd', key })
		this.d.core.consumedAdd(key)
	}
	exitedAdd(pubkey: string): void {
		const k = pubkey.toLowerCase()
		this.buf.push({ op: 'exitedAdd', pubkey: k })
		this.d.core.exitedAdd(k)
	}
	setScalar<K extends keyof S>(name: K, value: S[K]): void {
		if (value === undefined) return this.delScalar(name)
		if (name === IN_FLIGHT) {
			this.live = value as unknown as Record<string, unknown>
			return
		}
		const n = name as string
		// checked BEFORE it is applied: a refused value changes nothing
		if (n === 'lastBackfillProcessedBlock' || n === 'lastListeningEndBlock') {
			const hw = (this.d.core.getScalar('cursorHighWater') ?? {}) as { backfill?: number; listen?: number }
			assertCursorMonotonic(n, n === 'lastBackfillProcessedBlock' ? hw.backfill : hw.listen, value as number)
		}
		this.patch[n] = clone(value)
		this.dels.delete(n)
		this.d.core.setScalar(n, value)
	}
	delScalar(name: keyof S): void {
		if (name === IN_FLIGHT) {
			this.live = null
			return
		}
		const n = name as string
		delete this.patch[n]
		this.dels.add(n)
		this.d.core.deleteScalar(n)
	}

	/**
	 * S3: leaving a scope with uncommitted writes keeps them (they are already applied to the core, so dropping them would put memory ahead of the log); the next commit of any label carries them
	 * into its event, and says so in the log.
	 */
	override closeScope(): void {
		if (this.openScopeLabel !== null) this.carried += this.buf.length + Object.keys(this.patch).length + this.dels.size
		super.closeScope()
	}

	/**
	 * K4: true when something applied to the core is NOT yet in the log (buffered adds/dels/scalars, or an in-flight record changed in place). A snapshot freezes the core as it is, so the scheduler
	 * freezes only when this is false: otherwise the snapshot could contain a write whose event a crash would lose.
	 */
	hasUncommittedWrites(): boolean {
		if (this.buf.length > 0 || Object.keys(this.patch).length > 0 || this.dels.size > 0) return true
		if (this.live !== undefined && JSON.stringify(this.live) !== JSON.stringify(this.d.core.getInFlight())) return true
		return false
	}

	// ------------------------------------------------------------------ durability
	private pendingOps(): WalOp[] {
		const ops = this.buf.slice()
		// the in-flight record: the lifecycle changes the live copy in place; journal it when it differs from the core's copy
		if (this.live !== undefined) {
			const cur = this.d.core.getInFlight()
			if (JSON.stringify(this.live) !== JSON.stringify(cur)) {
				const rec = this.live === null ? null : clone(this.live)
				ops.push({ op: 'inFlightSet', record: rec })
				this.d.core.setInFlight(rec)
			}
		}
		// the persisted cursor high-water follows the cursors (what the legacy write did on every persist)
		const hw = (this.d.core.getScalar('cursorHighWater') ?? {}) as { backfill?: number; listen?: number }
		const nb = Math.max(hw.backfill ?? -1, (this.d.core.getScalar('lastBackfillProcessedBlock') as number | undefined) ?? -1)
		const nl = Math.max(hw.listen ?? -1, (this.d.core.getScalar('lastListeningEndBlock') as number | undefined) ?? -1)
		if (nb !== (hw.backfill ?? -1) || nl !== (hw.listen ?? -1)) {
			this.patch.cursorHighWater = { backfill: nb, listen: nl }
			this.d.core.setScalar('cursorHighWater', this.patch.cursorHighWater)
		}
		if (Object.keys(this.patch).length > 0) ops.push({ op: 'scalarsSet', patch: this.patch })
		if (this.dels.size > 0) ops.push({ op: 'scalarsDel', names: [...this.dels] })
		return ops
	}

	async commit(label: StateCommitLabel): Promise<void> {
		this.guardCommit(label)
		const ops = this.pendingOps()
		if (this.carried > 0) {
			this.d.log?.(`[labMiningPoolClPayout] carried ${this.carried} ops from an aborted scope into the '${label}' commit`)
			this.carried = 0
		}
		if (ops.length === 0) {
			// no event, but still a barrier: everything applied before this point is durable when it resolves (the log is ordered, so this is cheap)
			await this.d.wal.whenDurable(this.d.wal.lastSeq)
			this.scopeCommitted(label)
			return
		}
		const r = this.d.core.record(this.d.wal, label, ops)
		this.buf = []
		this.patch = {}
		this.dels = new Set()
		if (r.seq < 0) {
			void r.durable.catch(() => undefined) // the refusal is reported below; the rejected promise must not surface as an unhandled rejection too
			const err = new Error(`labWalStateHandle: the log refused the '${label}' event (${ops.length} ops); memory is ahead of the log`)
			this.onFatal(err)
			throw err
		}
		await r.durable
		this.scopeCommitted(label)
	}

	haltFlush(): void {
		// best effort and synchronous: queue whatever is buffered; whatever is not durable when the process exits was never acted upon (equal to a crash)
		try {
			const ops = this.pendingOps()
			if (ops.length > 0) void this.d.core.record(this.d.wal, 'halt', ops).durable.catch(() => undefined)
		} catch {
			/* exiting anyway */
		}
	}
}

export type { PendingEntry }
