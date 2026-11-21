/**
 * Test support for the WAL-mode state tests: a reference model made of plain Maps (no layers, no snapshots) that applies the same ops through applyOps, and canonical views of the
 * layered core and of the model for exact comparison. Not imported by production code.
 */
import { canonicalJson } from './labClPayoutStateStore'
import type { LabPayoutStateCore } from './labPayoutStateCore'
import { applyOps, type WalApplyTarget, type WalOp } from './labWal'

/** The reference: plain Maps, no layers, no snapshots. Same op semantics through applyOps. */
export class Model implements WalApplyTarget {
	pending = new Map<string, Record<string, unknown>>()
	consumed: string[] = []
	private consumedSet = new Set<string>()
	exited = new Set<string>()
	scalars: Record<string, unknown> = {}
	inFlight: Record<string, unknown> | null = null
	pendingHas = (k: string): boolean => this.pending.has(k)
	pendingSet = (e: { eventKey: string } & Record<string, unknown>): void => void this.pending.set(e.eventKey, e)
	pendingDelete = (k: string): void => void this.pending.delete(k)
	consumedAdd = (k: string): void => {
		if (!this.consumedSet.has(k)) {
			this.consumedSet.add(k)
			this.consumed.push(k)
		}
	}
	exitedAdd = (k: string): void => void this.exited.add(k)
	getScalar = (n: string): unknown => this.scalars[n]
	setScalar = (n: string, v: unknown): void => void (this.scalars[n] = v)
	deleteScalar = (n: string): void => void delete this.scalars[n]
	setInFlight = (r: Record<string, unknown> | null): void => void (this.inFlight = r)
	apply(ops: WalOp[]): void {
		applyOps(this, ops)
	}
}

export function view(core: LabPayoutStateCore): string {
	return canonicalJson({
		pending: [...core.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: [...core.consumedKeys()],
		exited: [...core.exited.keys()].sort(),
		scalars: core.scalarsCopy(),
		inFlight: core.getInFlight(),
	})
}
export function modelView(m: Model): string {
	return canonicalJson({
		pending: [...m.pending.values()].map((e) => ({ ...e })).sort((a, b) => ((a.eventKey as string) < (b.eventKey as string) ? -1 : 1)),
		consumed: m.consumed,
		exited: [...m.exited].sort(),
		scalars: m.scalars,
		inFlight: m.inFlight,
	})
}

