import { existsSync, readFileSync } from 'node:fs'
import { JsonRpcProvider, Network, Transaction, getAddress, type TransactionRequest } from 'ethers'
import { canonicalHash } from './canonical'
import type { Alerter } from './alerts'
import type { AuditLog } from './audit'
import { bigintReplacer } from './audit'
import type { ChainConfig } from './config'
import { ErrorCode, SignerError } from './errors'
import type { Keyring } from './keyring'
import { errorMessage } from './redact'
import { appendDurableJournalLine, parseJournal } from './txJournal'

export type SendRequest = {
	client: string
	array: string
	chainId: number
	/** Keys the service may pick from (the array's active addresses). */
	candidates: string[]
	/** Pin one key (must be a candidate). */
	from?: string
	to: string
	data: string
	value: bigint
	gasLimit?: bigint
	/** Policy gas ceiling, applied after estimation too. */
	maxGas?: bigint
	idempotencyKey?: string
	maxGasPriceWei?: bigint
	maxInflightPerKey: number
	dailyBudgetWei?: bigint
	method?: string
	args?: string[]
	/** Skip eth_call simulation (plain value transfers from the gas keeper). */
	skipSimulation?: boolean
}

export type TxStatus = 'sent' | 'mined' | 'reverted' | 'stuck' | 'rejected'

export type TxRecord = {
	id: string
	idempotencyKey?: string
	client: string
	array: string
	chainId: number
	from: string
	to: string
	data: string
	value: string
	nonce: number
	gasLimit: string
	type: number
	gasPrice?: string
	maxFeePerGas?: string
	maxPriorityFeePerGas?: string
	hash: string
	hashes: string[]
	/**
	 * keccak256 of the canonical send request. Absent on journals written before
	 * the request was bound to the idempotency key; those rows match the fields
	 * they stored and ignore a later gasLimit.
	 */
	requestHash?: string
	/** Latest signed tx (public data) so it can be rebroadcast after a restart. */
	raw: string
	status: TxStatus
	resends: number
	createdAt: string
	updatedAt: string
	lastSentAt: number
	blockNumber?: number
	gasUsed?: string
	feeWei?: string
	/**
	 * Wei reserved against the UTC day of updatedAt.
	 * Absent on journals written before reservation; those pending rows are
	 * rebuilt from gasLimit and the stored gas price, or they block the key.
	 */
	budgetWei?: string
	/** Policy max fee copied so a restarted resend still obeys maxGasPriceGwei. */
	feeCapWei?: string
	dailyBudgetWei?: string
	method?: string
}

export type SendResult = Pick<TxRecord, 'hash' | 'from' | 'nonce' | 'chainId' | 'status' | 'idempotencyKey' | 'raw'> & {
	duplicate?: boolean
}

type AddrState = { next: number | null; floor: number; inflight: Set<string>; lock: Promise<unknown> }
type ChainCtx = { chainId: number; provider: JsonRpcProvider; cfg: Required<Omit<ChainConfig, 'rpcUrls'>> }

const BUMP_NUM = 1125n
const BUMP_DEN = 1000n

export class TxManager {
	private chains = new Map<number, ChainCtx>()
	private addr = new Map<string, AddrState>()
	private records = new Map<string, TxRecord>()
	private byKey = new Map<string, string>()
	private pending = new Map<string, { fingerprint: string; promise: Promise<SendResult> }>()
	private spent = new Map<string, bigint>()
	/** Today's pending rows whose gas price cannot be rebuilt. Key is chain:from. */
	private unpriced = new Set<string>()
	private timer?: ReturnType<typeof setInterval>
	private ticking = false

	constructor(
		chainCfg: Record<string, ChainConfig>,
		private readonly keyring: Keyring,
		private readonly audit: AuditLog,
		private readonly alerter: Alerter,
		private readonly journalPath: string,
		private readonly keyWaitMs: number,
	) {
		for (const [idStr, cfg] of Object.entries(chainCfg)) {
			const chainId = Number(idStr)
			const url = cfg.rpcUrls[0]
			if (!url) throw new Error(`chain ${chainId}: rpcUrls required`)
			const provider = new JsonRpcProvider(url, chainId, { staticNetwork: Network.from(chainId), batchMaxCount: 1 })
			this.chains.set(chainId, {
				chainId,
				provider,
				cfg: { resendAfterMs: cfg.resendAfterMs ?? 60_000, maxResends: cfg.maxResends ?? 3, receiptPollMs: cfg.receiptPollMs ?? 2_000 },
			})
		}
		this.loadJournal()
	}

	provider(chainId: number): JsonRpcProvider {
		return this.chain(chainId).provider
	}

	chainIds(): number[] {
		return [...this.chains.keys()]
	}

	start(): void {
		if (this.timer) return
		const poll = Math.min(...[...this.chains.values()].map((c) => c.cfg.receiptPollMs))
		this.timer = setInterval(() => void this.tick(), poll)
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}

	inflightCount(chainId: number, address: string): number {
		return this.state(chainId, address).inflight.size
	}

	spentToday(chainId: number, address: string): bigint {
		return this.spent.get(spendKey(chainId, address)) ?? 0n
	}

	get(query: { idempotencyKey?: string; hash?: string; client?: string }): TxRecord | undefined {
		if (query.idempotencyKey) {
			if (query.client) {
				const id = this.byKey.get(idempotencyScopeId(query.client, query.idempotencyKey))
				return id ? this.records.get(id) : undefined
			}
			for (const rec of this.records.values()) {
				if (rec.idempotencyKey === query.idempotencyKey) return rec
			}
			return undefined
		}
		if (query.hash) {
			const h = query.hash.toLowerCase()
			for (const r of this.records.values()) if (r.hashes.some((x) => x.toLowerCase() === h)) return r
		}
		return undefined
	}

	recent(limit: number): TxRecord[] {
		return [...this.records.values()].sort((a, b) => b.lastSentAt - a.lastSentAt).slice(0, limit)
	}

	stuck(): TxRecord[] {
		const now = Date.now()
		return [...this.records.values()].filter((r) => r.status === 'sent' && now - r.lastSentAt > 120_000)
	}

	async send(req: SendRequest): Promise<SendResult> {
		const key = req.idempotencyKey
		if (!key) return this.doSend(req)
		const scope = idempotencyScopeId(req.client, key)
		const fingerprint = requestFingerprint(req)
		const existing = this.get({ idempotencyKey: key, client: req.client })
		// Reverted and explicitly rejected attempts had no effect, so the same key may try again.
		// stuck means another transaction occupies the nonce: keep the key and the reservation.
		if (existing && existing.status !== 'reverted' && existing.status !== 'rejected') {
			assertSameIdempotentRequest(existing, req, fingerprint)
			return { ...summary(existing), duplicate: true }
		}
		const inFlight = this.pending.get(scope)
		if (inFlight) {
			if (inFlight.fingerprint !== fingerprint) throw differentRequest()
			return { ...(await inFlight.promise), duplicate: true }
		}
		let resolveInflight!: (value: SendResult) => void
		let rejectInflight!: (reason: unknown) => void
		const promise = new Promise<SendResult>((resolve, reject) => {
			resolveInflight = resolve
			rejectInflight = reject
		})
		void promise.catch(() => undefined)
		this.pending.set(scope, { fingerprint, promise })
		const run = this.doSend(req)
		void run.then(resolveInflight, rejectInflight)
		try {
			return await run
		} finally {
			if (this.pending.get(scope)?.promise === promise) this.pending.delete(scope)
		}
	}

	private async doSend(req: SendRequest): Promise<SendResult> {
		const ctx = this.chain(req.chainId)
		const reservation = `reserve:${Math.random().toString(36).slice(2)}`
		const from = await this.reserveKey(req, reservation)
		const st = this.state(req.chainId, from)
		let reserved = true
		try {
			const base: TransactionRequest = { from, to: req.to, data: req.data, value: req.value, chainId: req.chainId }
			if (!req.skipSimulation) await this.simulate(ctx, { ...base, gasLimit: req.gasLimit })
			let gasLimit = req.gasLimit
			if (gasLimit === undefined) {
				try {
					gasLimit = ((await ctx.provider.estimateGas(base)) * 120n) / 100n
				} catch (e) {
					throw new SignerError(ErrorCode.EXECUTION_REVERTED, `estimateGas failed: ${errorMessage(e)}`)
				}
			}
			if (req.maxGas !== undefined && gasLimit > req.maxGas) {
				throw new SignerError(ErrorCode.POLICY_DENIED, `gas ${gasLimit} above policy max ${req.maxGas}`)
			}
			const fees = await this.fees(ctx, req.maxGasPriceWei)
			const priceForBudget = fees.maxFeePerGas ?? fees.gasPrice ?? 0n
			const budgetCost = gasLimit * priceForBudget
			const worstCaseWei = gasLimit * priceForBudget + req.value
			let balance: bigint
			try {
				balance = await ctx.provider.getBalance(from)
			} catch (e) {
				throw new SignerError(ErrorCode.UPSTREAM, `balance read failed: ${errorMessage(e)}`)
			}
			if (balance < worstCaseWei) {
				const reason = `skip: balance ${balance} below worst-case gas ${worstCaseWei} (gasLimit ${gasLimit} * gasPrice ${priceForBudget} + value ${req.value})`
				this.audit.write({
					event: 'tx.skip',
					client: req.client,
					array: req.array,
					chainId: req.chainId,
					from,
					to: getAddress(req.to),
					reason,
					balanceWei: balance.toString(),
					worstCaseWei: worstCaseWei.toString(),
					gasLimit: gasLimit.toString(),
					gasPrice: priceForBudget.toString(),
					value: req.value.toString(),
				})
				this.alerter.send('warn', `gas-skip:${from}`, reason)
				throw new SignerError(ErrorCode.RATE_LIMITED, reason)
			}
			let budgetHeld = 0n
			if (req.dailyBudgetWei !== undefined) {
				const block = this.reserveOrExplain(req.chainId, from, budgetCost, req.dailyBudgetWei)
				if (block) {
					this.alerter.send('warn', `budget:${req.chainId}:${from}`, `${block} for ${req.array} ${from}`)
					throw new SignerError(ErrorCode.RATE_LIMITED, block)
				}
				budgetHeld = budgetCost
			}
			try {
				const rec = await this.withLock(st, async () => {
					if (st.next === null) st.next = await ctx.provider.getTransactionCount(from, 'pending')
					if (st.next < st.floor) st.next = st.floor
					const nonce = st.next++
					const tx = Transaction.from({
						type: fees.type,
						chainId: req.chainId,
						nonce,
						to: req.to,
						data: req.data,
						value: req.value,
						gasLimit,
						...(fees.type === 2
							? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
							: { gasPrice: fees.gasPrice }),
					})
					const raw = this.keyring.signTransaction(from, tx)
					const hash = Transaction.from(raw).hash!
					const now = new Date().toISOString()
					const signed: TxRecord = {
						id: `${req.chainId}:${from.toLowerCase()}:${nonce}`,
						idempotencyKey: req.idempotencyKey,
						client: req.client,
						array: req.array,
						chainId: req.chainId,
						from,
						to: getAddress(req.to),
						data: req.data,
						value: req.value.toString(),
						nonce,
						gasLimit: gasLimit.toString(),
						type: fees.type,
						gasPrice: fees.gasPrice?.toString(),
						maxFeePerGas: fees.maxFeePerGas?.toString(),
						maxPriorityFeePerGas: fees.maxPriorityFeePerGas?.toString(),
						hash,
						hashes: [hash],
						requestHash: requestFingerprint(req),
						raw,
						status: 'sent',
						resends: 0,
						createdAt: now,
						updatedAt: now,
						lastSentAt: Date.now(),
						budgetWei: req.dailyBudgetWei !== undefined ? budgetCost.toString() : undefined,
						feeCapWei: req.maxGasPriceWei?.toString(),
						dailyBudgetWei: req.dailyBudgetWei?.toString(),
						method: req.method,
					}
					st.inflight.delete(reservation)
					reserved = false
					st.inflight.add(signed.id)
					try {
						this.save(signed)
					} catch (err) {
						st.inflight.delete(signed.id)
						st.next = nonce
						throw err
					}
					budgetHeld = 0n
					await this.broadcastOrRecover(ctx, st, signed)
					return signed
				})
				this.audit.write({
					event: 'tx.sent',
					client: req.client,
					array: req.array,
					chainId: req.chainId,
					from,
					to: rec.to,
					method: req.method,
					args: req.args,
					nonce: rec.nonce,
					gasLimit: rec.gasLimit,
					hash: rec.hash,
					idempotencyKey: req.idempotencyKey,
				})
				return summary(rec)
			} finally {
				if (budgetHeld !== 0n) this.releaseSpend(req.chainId, from, budgetHeld)
			}
		} finally {
			if (reserved) st.inflight.delete(reservation)
		}
	}

	/**
	 * A JSON-RPC error does not prove the node dropped the tx. already known, nonce too low,
	 * and gateway failures keep the saved task. The nonce is reused only after the hash is
	 * absent, the account nonce is still available, the error is a definite refusal, and no
	 * later task holds a higher nonce.
	 */
	private async broadcastOrRecover(ctx: ChainCtx, st: AddrState, rec: TxRecord): Promise<void> {
		const first = await this.broadcastOnce(ctx, rec)
		if (first === 'accepted') return
		if (first === 'absent-reject') {
			this.abandonRejected(st, rec)
			throw new SignerError(ErrorCode.UPSTREAM, 'broadcast rejected')
		}
		const second = await this.broadcastOnce(ctx, rec)
		if (second === 'accepted') return
		// The first attempt was already uncertain. A later miss or insufficient funds
		// does not prove the earlier broadcast was dropped.
		throw new SignerError(ErrorCode.UPSTREAM, 'broadcast uncertain')
	}

	private async broadcastOnce(ctx: ChainCtx, rec: TxRecord): Promise<'accepted' | 'absent-reject' | 'keep'> {
		try {
			await ctx.provider.broadcastTransaction(rec.raw)
			return 'accepted'
		} catch (e) {
			if (rpcText(e).includes('already known')) return 'accepted'
			const seen = await this.reconcileNonce(ctx, rec)
			if (seen === 'ours') return 'accepted'
			if (seen === 'absent' && isDefiniteReject(e)) {
				if (rpcText(e).includes('insufficient funds')) {
					this.alerter.send('warn', `funds:${rec.from}`, `broadcast rejected: insufficient funds for ${rec.from}`)
				}
				return 'absent-reject'
			}
			return 'keep'
		}
	}

	/**
	 * After latest nonce moves and none of our receipts are visible: original hash,
	 * a later hash we signed, an unidentified occupant, or an RPC lookup that failed.
	 * A failed lookup does not become "other".
	 */
	private async identifyNonce(ctx: ChainCtx, rec: TxRecord): Promise<'original' | 'replacement' | 'other' | 'unknown'> {
		if (rec.hashes.length === 0) return 'unknown'
		let missing = 0
		for (let i = 0; i < rec.hashes.length; i++) {
			try {
				const tx = await ctx.provider.getTransaction(rec.hashes[i]!)
				if (tx) return i === 0 ? 'original' : 'replacement'
				missing++
			} catch {
				return 'unknown'
			}
		}
		return missing === rec.hashes.length ? 'other' : 'unknown'
	}

	/** ours: this hash is in the pool or a block. nonce-used: the account nonce moved on. absent: still free. */
	private async reconcileNonce(ctx: ChainCtx, rec: TxRecord): Promise<'ours' | 'nonce-used' | 'absent' | 'unknown'> {
		try {
			const tx = await ctx.provider.getTransaction(rec.hash)
			if (tx) return 'ours'
		} catch {
			return 'unknown'
		}
		try {
			const pending = await ctx.provider.getTransactionCount(rec.from, 'pending')
			const latest = await ctx.provider.getTransactionCount(rec.from, 'latest')
			if (pending > rec.nonce || latest > rec.nonce) return 'nonce-used'
			return 'absent'
		} catch {
			return 'unknown'
		}
	}

	/** The node refused this raw. Free the tip nonce so the next send is not stuck behind it. */
	private abandonRejected(st: AddrState, rec: TxRecord): void {
		this.releaseCounted(rec)
		st.inflight.delete(rec.id)
		const higher = [...this.records.values()].some(
			(row) => row.id !== rec.id && row.status === 'sent' && row.chainId === rec.chainId && row.from.toLowerCase() === rec.from.toLowerCase() && row.nonce > rec.nonce,
		)
		if (!higher && st.next === rec.nonce + 1) st.next = rec.nonce
		this.save({
			...rec,
			status: 'rejected',
			budgetWei: '0',
			updatedAt: new Date().toISOString(),
		})
	}

	private async reserveKey(req: SendRequest, reservation: string): Promise<string> {
		const candidates = req.candidates.map((a) => getAddress(a))
		if (candidates.length === 0) throw new SignerError(ErrorCode.POLICY_DENIED, 'no keys in array')
		let pool = candidates
		if (req.from) {
			const want = getAddress(req.from)
			if (!candidates.includes(want)) throw new SignerError(ErrorCode.POLICY_DENIED, `from ${want} is not in ${req.array}`)
			pool = [want]
		}
		const max = Math.max(1, req.maxInflightPerKey)
		const deadline = Date.now() + this.keyWaitMs
		for (;;) {
			let best: string | undefined
			let bestN = Infinity
			for (const a of pool) {
				const n = this.state(req.chainId, a).inflight.size
				if (n < max && n < bestN) {
					best = a
					bestN = n
				}
			}
			if (best) {
				this.state(req.chainId, best).inflight.add(reservation)
				return best
			}
			if (Date.now() >= deadline) throw new SignerError(ErrorCode.NO_IDLE_KEY, `all keys of ${req.array} busy`)
			await sleep(200)
		}
	}

	private async simulate(ctx: ChainCtx, tx: TransactionRequest): Promise<void> {
		try {
			await ctx.provider.call(tx)
		} catch (e) {
			const err = e as { code?: string; data?: string; reason?: string }
			if (err.code === 'CALL_EXCEPTION') {
				throw new SignerError(ErrorCode.EXECUTION_REVERTED, `simulation reverted: ${errorMessage(e)}`, { data: err.data })
			}
			throw new SignerError(ErrorCode.UPSTREAM, `simulation failed: ${errorMessage(e)}`)
		}
	}

	private async fees(
		ctx: ChainCtx,
		cap?: bigint,
	): Promise<{ type: number; gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
		let fee
		try {
			fee = await ctx.provider.getFeeData()
		} catch (e) {
			throw new SignerError(ErrorCode.UPSTREAM, `fee data: ${errorMessage(e)}`)
		}
		const market = fee.gasPrice ?? fee.maxFeePerGas ?? 0n
		if (cap !== undefined && market > cap) {
			throw new SignerError(ErrorCode.GAS_PRICE_TOO_HIGH, `gas price ${market} above cap ${cap}`)
		}
		if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
			let maxFee = fee.maxFeePerGas
			if (cap !== undefined && maxFee > cap) maxFee = cap
			const prio = fee.maxPriorityFeePerGas > maxFee ? maxFee : fee.maxPriorityFeePerGas
			return { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio }
		}
		return { type: 0, gasPrice: market }
	}

	private async tick(): Promise<void> {
		if (this.ticking) return
		this.ticking = true
		try {
			for (const rec of [...this.records.values()]) {
				if (rec.status !== 'sent') continue
				await this.track(rec).catch((e: unknown) => {
					process.stderr.write(`[tx] track ${rec.id}: ${errorMessage(e)}\n`)
				})
			}
		} finally {
			this.ticking = false
		}
	}

	private async track(rec: TxRecord): Promise<void> {
		const ctx = this.chains.get(rec.chainId)
		if (!ctx) return
		for (const h of rec.hashes) {
			const r = await ctx.provider.getTransactionReceipt(h)
			if (!r) continue
			const fee = r.gasUsed * (r.gasPrice ?? 0n)
			this.releaseCounted(rec)
			this.addSpend(rec.chainId, rec.from, fee)
			const updated: TxRecord = {
				...rec,
				hash: h,
				status: r.status === 1 ? 'mined' : 'reverted',
				blockNumber: r.blockNumber,
				gasUsed: r.gasUsed.toString(),
				feeWei: fee.toString(),
				budgetWei: fee.toString(),
				updatedAt: new Date().toISOString(),
			}
			this.state(rec.chainId, rec.from).inflight.delete(rec.id)
			this.save(updated)
			this.refreshUnpriced(rec.chainId, rec.from)
			this.audit.write({ event: `tx.${updated.status}`, client: rec.client, array: rec.array, chainId: rec.chainId, from: rec.from, hash: h, nonce: rec.nonce, gasUsed: updated.gasUsed, blockNumber: r.blockNumber })
			return
		}
		const age = Date.now() - rec.lastSentAt
		if (age < ctx.cfg.resendAfterMs) return
		const latest = await ctx.provider.getTransactionCount(rec.from, 'latest')
		if (latest > rec.nonce) {
			const who = await this.identifyNonce(ctx, rec)
			if (who === 'original' || who === 'replacement' || who === 'unknown') return
			const updated: TxRecord = { ...rec, status: 'stuck', updatedAt: new Date().toISOString() }
			this.state(rec.chainId, rec.from).inflight.delete(rec.id)
			this.state(rec.chainId, rec.from).next = null
			this.save(updated)
			this.audit.write({ event: 'tx.stuck', client: rec.client, array: rec.array, chainId: rec.chainId, from: rec.from, nonce: rec.nonce, hash: rec.hash, reason: 'unidentified nonce occupant' })
			this.alerter.send('critical', `replaced:${rec.id}`, `nonce ${rec.nonce} of ${rec.from} was consumed by a transaction that is not this task`)
			return
		}
		if (!this.keyring.unlocked) {
			// Receipt reads above are allowed while locked. Do not rebroadcast or reprice.
			if (age > ctx.cfg.resendAfterMs * (ctx.cfg.maxResends + 2)) {
				this.alerter.send('warn', `stuck:${rec.id}`, `${rec.array} tx nonce ${rec.nonce} pending for ${Math.round(age / 1000)}s`)
			}
			return
		}
		if (rec.resends >= ctx.cfg.maxResends) {
			// Keep the same signed tx. This is not a new task.
			await ctx.provider.broadcastTransaction(rec.raw).catch(() => undefined)
			if (age > ctx.cfg.resendAfterMs * (ctx.cfg.maxResends + 2)) {
				this.alerter.send('warn', `stuck:${rec.id}`, `${rec.array} tx nonce ${rec.nonce} pending for ${Math.round(age / 1000)}s`)
			}
			return
		}
		const cap = rec.feeCapWei !== undefined ? BigInt(rec.feeCapWei) : undefined
		const oldPrice = rec.type === 2 ? BigInt(rec.maxFeePerGas ?? '0') : BigInt(rec.gasPrice ?? '0')
		const nextPrice = cappedBump(oldPrice, cap)
		if (nextPrice <= oldPrice) {
			await ctx.provider.broadcastTransaction(rec.raw).catch(() => undefined)
			return
		}
		const gasLimit = BigInt(rec.gasLimit)
		const delta = gasLimit * (nextPrice - oldPrice)
		let deltaHeld = 0n
		if (rec.dailyBudgetWei !== undefined) {
			if (!this.tryReserve(rec.chainId, rec.from, delta, BigInt(rec.dailyBudgetWei))) {
				this.audit.write({ event: 'tx.resend.budget', client: rec.client, array: rec.array, from: rec.from, nonce: rec.nonce, id: rec.id })
				this.save({ ...rec, lastSentAt: Date.now(), updatedAt: new Date().toISOString() })
				return
			}
			deltaHeld = delta
		}
		const nextPriority = rec.type === 2 ? cappedBump(BigInt(rec.maxPriorityFeePerGas ?? '0'), nextPrice) : undefined
		const tx = Transaction.from({
			type: rec.type,
			chainId: rec.chainId,
			nonce: rec.nonce,
			to: rec.to,
			data: rec.data,
			value: BigInt(rec.value),
			gasLimit,
			...(rec.type === 2
				? { maxFeePerGas: nextPrice, maxPriorityFeePerGas: nextPriority }
				: { gasPrice: nextPrice }),
		})
		const raw = this.keyring.signTransaction(rec.from, tx)
		const hash = Transaction.from(raw).hash!
		try {
			await ctx.provider.broadcastTransaction(raw)
		} catch (e) {
			if (deltaHeld !== 0n) this.releaseSpend(rec.chainId, rec.from, deltaHeld)
			process.stderr.write(`[tx] resend ${rec.id}: ${errorMessage(e)}\n`)
			return
		}
		const updated: TxRecord = {
			...rec,
			hash,
			hashes: [...rec.hashes, hash],
			raw,
			resends: rec.resends + 1,
			gasPrice: tx.gasPrice?.toString() ?? rec.gasPrice,
			maxFeePerGas: tx.maxFeePerGas?.toString() ?? rec.maxFeePerGas,
			maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString() ?? rec.maxPriorityFeePerGas,
			budgetWei: rec.dailyBudgetWei !== undefined ? ((rec.budgetWei ? BigInt(rec.budgetWei) : 0n) + deltaHeld).toString() : rec.budgetWei,
			lastSentAt: Date.now(),
			updatedAt: new Date().toISOString(),
		}
		this.save(updated)
		this.audit.write({ event: 'tx.resent', client: rec.client, array: rec.array, from: rec.from, nonce: rec.nonce, hash, resends: updated.resends })
	}

	private chain(chainId: number): ChainCtx {
		const c = this.chains.get(chainId)
		if (!c) throw new SignerError(ErrorCode.POLICY_DENIED, `chain ${chainId} not configured`)
		return c
	}

	private state(chainId: number, address: string): AddrState {
		const k = `${chainId}:${address.toLowerCase()}`
		let s = this.addr.get(k)
		if (!s) {
			s = { next: null, floor: 0, inflight: new Set(), lock: Promise.resolve() }
			this.addr.set(k, s)
		}
		return s
	}

	private async withLock<T>(st: AddrState, fn: () => Promise<T>): Promise<T> {
		const run = st.lock.then(fn, fn)
		st.lock = run.catch(() => undefined)
		return run
	}

	private save(rec: TxRecord): void {
		// Durable intent first. A failed fsync must not publish the idempotency key or broadcast.
		try {
			appendDurableJournalLine(this.journalPath, `${JSON.stringify(rec, bigintReplacer)}\n`)
		} catch (err) {
			throw new SignerError(ErrorCode.UPSTREAM, `tx journal persist failed: ${errorMessage(err)}`)
		}
		this.records.set(rec.id, rec)
		if (rec.idempotencyKey) this.byKey.set(idempotencyScopeId(rec.client, rec.idempotencyKey), rec.id)
	}

	private addSpend(chainId: number, address: string, wei: bigint): void {
		const k = spendKey(chainId, address)
		this.spent.set(k, (this.spent.get(k) ?? 0n) + wei)
	}

	/** Check and add with no await between them, so concurrent sends cannot both pass. */
	private tryReserve(chainId: number, address: string, cost: bigint, budget: bigint): boolean {
		if (this.unpriced.has(unpricedKey(chainId, address))) return false
		if (cost < 0n) return false
		if (this.spentToday(chainId, address) + cost > budget) return false
		this.addSpend(chainId, address, cost)
		return true
	}

	private reserveOrExplain(chainId: number, address: string, cost: bigint, budget: bigint): string | undefined {
		if (this.unpriced.has(unpricedKey(chainId, address))) return 'pending transaction gas price cannot be reconstructed'
		if (!this.tryReserve(chainId, address, cost, budget)) return 'daily gas budget reached'
		return undefined
	}

	private refreshUnpriced(chainId: number, from: string): void {
		const key = unpricedKey(chainId, from)
		const today = new Date().toISOString().slice(0, 10)
		let blocked = false
		for (const rec of this.records.values()) {
			if (rec.chainId !== chainId || rec.from.toLowerCase() !== from.toLowerCase()) continue
			if (rec.updatedAt.slice(0, 10) !== today) continue
			if (rec.status !== 'sent' && rec.status !== 'stuck') continue
			if (journalReservationWei(rec) === 'unknown') blocked = true
		}
		if (blocked) this.unpriced.add(key)
		else this.unpriced.delete(key)
	}

	/** Drop the wei loadJournal or tryReserve already added for this row. */
	private releaseCounted(rec: TxRecord): void {
		if (rec.updatedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10)) return
		const hold = journalReservationWei(rec)
		if (typeof hold === 'bigint' && hold > 0n) this.releaseSpend(rec.chainId, rec.from, hold)
	}

	private releaseSpend(chainId: number, address: string, cost: bigint): void {
		const k = spendKey(chainId, address)
		const next = (this.spent.get(k) ?? 0n) - cost
		this.spent.set(k, next > 0n ? next : 0n)
	}

	private loadJournal(): void {
		if (!existsSync(this.journalPath)) return
		const today = new Date().toISOString().slice(0, 10)
		for (const rec of parseJournal(readFileSync(this.journalPath, 'utf8')) as TxRecord[]) {
			this.records.set(rec.id, rec)
			if (rec.idempotencyKey && rec.client) this.byKey.set(idempotencyScopeId(rec.client, rec.idempotencyKey), rec.id)
		}
		for (const rec of this.records.values()) {
			if (rec.status === 'sent' || rec.status === 'stuck') {
				const st = this.state(rec.chainId, rec.from)
				if (rec.status === 'sent') st.inflight.add(rec.id)
				const floor = rec.nonce + 1
				if (floor > st.floor) st.floor = floor
			}
			if (rec.updatedAt.slice(0, 10) !== today) continue
			const hold = journalReservationWei(rec)
			if (hold === 'unknown') {
				if (rec.status === 'sent' || rec.status === 'stuck') this.unpriced.add(unpricedKey(rec.chainId, rec.from))
				continue
			}
			if (hold > 0n) this.addSpend(rec.chainId, rec.from, hold)
		}
	}
}

/**
 * Conservative wei to count for a journal row.
 * Pending rows without budgetWei use gasLimit times the highest stored price.
 * 'unknown' means a pending row cannot be priced and must block that key.
 */
export function journalReservationWei(rec: TxRecord): bigint | 'unknown' {
	if (rec.budgetWei !== undefined && rec.budgetWei !== '') {
		try {
			return BigInt(rec.budgetWei)
		} catch {
			return 'unknown'
		}
	}
	if ((rec.status === 'mined' || rec.status === 'reverted') && rec.feeWei) {
		try {
			return BigInt(rec.feeWei)
		} catch {
			return 'unknown'
		}
	}
	if (rec.status !== 'sent' && rec.status !== 'stuck') return 0n
	const price = conservativeGasPrice(rec)
	if (price === undefined || rec.gasLimit === undefined || rec.gasLimit === '') return 'unknown'
	try {
		return BigInt(rec.gasLimit) * price
	} catch {
		return 'unknown'
	}
}

function conservativeGasPrice(rec: TxRecord): bigint | undefined {
	const prices: bigint[] = []
	for (const raw of [rec.gasPrice, rec.maxFeePerGas]) {
		if (raw === undefined || raw === '') continue
		try {
			prices.push(BigInt(raw))
		} catch {
			/* ignore a corrupt field and keep a usable sibling */
		}
	}
	if (prices.length === 0) return undefined
	return prices.reduce((highest, price) => (price > highest ? price : highest))
}

function unpricedKey(chainId: number, address: string): string {
	return `${chainId}:${address.toLowerCase()}`
}

function rpcText(e: unknown): string {
	const err = e as {
		error?: { message?: string }
		info?: { error?: { message?: string } }
		shortMessage?: string
		message?: string
	}
	return `${err.error?.message ?? ''} ${err.info?.error?.message ?? ''} ${err.shortMessage ?? ''} ${err.message ?? ''}`.toLowerCase()
}

/** Permanent node refusals. already known, nonce too low, and gateway errors are not in this list. */
function isDefiniteReject(e: unknown): boolean {
	const msg = rpcText(e)
	if (!msg.trim()) return false
	if (msg.includes('already known') || msg.includes('nonce too low') || msg.includes('nonce has already been used')) return false
	if (msg.includes('gateway') || msg.includes('timeout') || msg.includes('temporarily') || msg.includes('bad gateway')) return false
	return (
		msg.includes('insufficient funds') ||
		msg.includes('intrinsic gas too low') ||
		msg.includes('exceeds block gas limit') ||
		msg.includes('invalid chain id') ||
		msg.includes('invalid sender')
	)
}

function cappedBump(current: bigint, cap?: bigint): bigint {
	let next = (current * BUMP_NUM) / BUMP_DEN + 1n
	if (cap !== undefined && next > cap) next = cap
	return next
}

function spendKey(chainId: number, address: string): string {
	return `${new Date().toISOString().slice(0, 10)}:${chainId}:${address.toLowerCase()}`
}

/** Caller identity plus the key. Another client reusing the same string is a different slot. */
export function idempotencyScopeId(client: string, key: string): string {
	return `${client}\n${key}`
}

/** Canonical request bound to an idempotency key. gasLimit is null when the caller omitted it. */
export function requestFingerprint(req: {
	array: string
	chainId: number
	to: string
	data: string
	value: bigint
	gasLimit?: bigint
	from?: string
}): string {
	return canonicalHash({
		array: req.array,
		chainId: req.chainId,
		to: getAddress(req.to),
		data: req.data.toLowerCase(),
		value: req.value.toString(),
		gasLimit: req.gasLimit === undefined ? null : req.gasLimit.toString(),
		from: req.from ? getAddress(req.from) : null,
	})
}

function differentRequest(): SignerError {
	return new SignerError(ErrorCode.POLICY_DENIED, 'idempotency key already used for a different request')
}

function assertSameIdempotentRequest(existing: TxRecord, req: SendRequest, fingerprint: string): void {
	if (existing.client !== req.client) throw differentRequest()
	if (existing.requestHash) {
		if (existing.requestHash !== fingerprint) throw differentRequest()
		return
	}
	if (existing.array !== req.array || existing.chainId !== req.chainId) throw differentRequest()
	if (getAddress(existing.to) !== getAddress(req.to)) throw differentRequest()
	if (existing.data.toLowerCase() !== req.data.toLowerCase()) throw differentRequest()
	if (BigInt(existing.value) !== req.value) throw differentRequest()
	if (req.from && getAddress(existing.from) !== getAddress(req.from)) throw differentRequest()
}

function summary(r: TxRecord): SendResult {
	return { hash: r.hash, from: r.from, nonce: r.nonce, chainId: r.chainId, status: r.status, idempotencyKey: r.idempotencyKey, raw: r.raw }
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}
