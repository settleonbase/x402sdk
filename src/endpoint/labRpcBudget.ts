/**
 * Global RPC budget of the Lab payout daemon (P3; design DESIGN-pools-P3-P4-onepager v2 section 2). Every read the daemon makes goes through ONE provider class (BudgetedJsonRpcProvider), whose
 * _send takes a slot from this budget, so "all reads go through the budget" holds by construction (labRpcBudget.test.ts also ratchets the source: no other provider is created).
 *
 * Properties (each has a test): at no moment more than `total` requests are in flight; while a source has waiters and fewer than `minPerSource` in flight it is served before any other source
 * (a saturating source cannot starve the others); beyond the guaranteed share the sources are served in round-robin order; a request is granted FIFO within its source; a release always lets
 * the next waiter in. The source of a request is the AsyncLocalStorage value set by `rpcSource.run(name, fn)` around the loop that issues it ('scan', 'pay-rt', 'pay-hist', otherwise 'other').
 * Node built-ins and ethers only.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { ethers } from 'ethers'

export const rpcSource = new AsyncLocalStorage<string>()

type Waiter = { resolve: (release: () => void) => void }
export type RpcBudgetStats = { inFlight: number; maxInFlight: number; granted: number; perSource: Record<string, { inFlight: number; maxInFlight: number; granted: number; waitedMs: number; waiting: number }> }

export class RpcBudget {
	private inFlight = 0
	private maxInFlight = 0
	private granted = 0
	private readonly q = new Map<string, { waiters: { w: Waiter; since: number }[]; inFlight: number; max: number; granted: number; waitedMs: number }>()
	private order: string[] = []
	private rr = 0
	constructor(
		readonly total: number,
		readonly minPerSource: number
	) {
		if (!Number.isInteger(total) || total < 1) throw new Error('RpcBudget: total must be a positive integer')
		if (!Number.isInteger(minPerSource) || minPerSource < 0) throw new Error('RpcBudget: minPerSource must be a non-negative integer')
	}
	private src(name: string) {
		let s = this.q.get(name)
		if (!s) {
			s = { waiters: [], inFlight: 0, max: 0, granted: 0, waitedMs: 0 }
			this.q.set(name, s)
			this.order.push(name)
		}
		return s
	}
	acquire(source: string): Promise<() => void> {
		const s = this.src(source)
		return new Promise((resolve) => {
			s.waiters.push({ w: { resolve }, since: Date.now() })
			this.pump()
		})
	}
	private grant(name: string): void {
		const s = this.q.get(name)!
		const item = s.waiters.shift()!
		s.waitedMs += Date.now() - item.since
		s.inFlight++
		s.max = Math.max(s.max, s.inFlight)
		s.granted++
		this.inFlight++
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
		this.granted++
		let done = false
		item.w.resolve(() => {
			if (done) return
			done = true
			s.inFlight--
			this.inFlight--
			this.pump()
		})
	}
	private pump(): void {
		while (this.inFlight < this.total) {
			// 1) a source below its guaranteed share with a waiter goes first (the one with the fewest in flight, ties in registration order)
			let pick: string | undefined
			let best = Infinity
			for (const name of this.order) {
				const s = this.q.get(name)!
				if (s.waiters.length > 0 && s.inFlight < this.minPerSource && s.inFlight < best) {
					pick = name
					best = s.inFlight
				}
			}
			// 2) otherwise round-robin over the sources that have waiters
			if (pick === undefined) {
				for (let i = 0; i < this.order.length; i++) {
					const name = this.order[(this.rr + i) % this.order.length]!
					if (this.q.get(name)!.waiters.length > 0) {
						pick = name
						this.rr = (this.rr + i + 1) % this.order.length
						break
					}
				}
			}
			if (pick === undefined) return
			this.grant(pick)
		}
	}
	stats(): RpcBudgetStats {
		const perSource: RpcBudgetStats['perSource'] = {}
		for (const [n, s] of this.q) perSource[n] = { inFlight: s.inFlight, maxInFlight: s.max, granted: s.granted, waitedMs: s.waitedMs, waiting: s.waiters.length }
		return { inFlight: this.inFlight, maxInFlight: this.maxInFlight, granted: this.granted, perSource }
	}
}

/** The one provider class of the daemon: every JSON-RPC request takes a budget slot for the duration of the HTTP call. */
export class BudgetedJsonRpcProvider extends ethers.JsonRpcProvider {
	constructor(
		req: ethers.FetchRequest,
		network: ethers.Networkish | undefined,
		opts: ethers.JsonRpcApiProviderOptions,
		private readonly budget: RpcBudget | undefined
	) {
		super(req, network, opts)
	}
	override async _send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<ethers.JsonRpcResult[]> {
		if (!this.budget) return super._send(payload)
		const release = await this.budget.acquire(rpcSource.getStore() ?? 'other')
		try {
			return await super._send(payload)
		} finally {
			release()
		}
	}
}
