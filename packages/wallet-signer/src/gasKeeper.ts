import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { formatEther, getAddress } from 'ethers'
import type { Alerter } from './alerts'
import type { AuditLog } from './audit'
import type { GasKeeperChain } from './config'
import type { Keyring } from './keyring'
import { errorMessage } from './redact'
import type { RegistryBody } from './registry'
import type { TxManager } from './txManager'

/** Plain native transfer gas. The PM must keep at least this times the worst fee. */
export const NATIVE_TOPUP_GAS_LIMIT = 21_000n

/** Internal role that signs PM top-ups. Not a daemon client and not an admin-socket identity. */
export const GAS_KEEPER_CLIENT = 'gas-keeper'

/** Quote daemon. It may use its own RPC socket. It cannot open the gas-keeper path. */
export const ORACLE_DAEMON_CLIENT = 'oracle-daemon'

/**
 * BeamioOracle on CoNET. A phase-2 top-up reaches this address only when that
 * chain's business-wallet whitelist lists it. Wide pool sweeps are not this phase.
 */
export const ORACLE_GAS_WALLET = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'

const GAS_TOPUP_RPC_METHODS = new Set(['gas.run', 'gas_run', 'signer_gasRun', 'signer_topup', 'signer_gasStatus'])

/** Client RPC has no gas-keeper method. oracle-daemon is refused by name. */
export function gasTopupRpcRefusal(method: string, client: string): 'oracle-daemon' | 'client-rpc' | null {
	if (!GAS_TOPUP_RPC_METHODS.has(method)) return null
	if (client === ORACLE_DAEMON_CLIENT) return 'oracle-daemon'
	return 'client-rpc'
}

/** Admin `gas run` takes no caller and no target. It cannot be aimed by oracle-daemon. */
export function adminGasRunRefusal(args: Record<string, unknown>): 'oracle-daemon' | 'caller-or-target' | null {
	if (args.client === ORACLE_DAEMON_CLIENT) return 'oracle-daemon'
	if ('client' in args || 'address' in args || 'to' in args || 'wallets' in args) return 'caller-or-target'
	return null
}

export function explicitBusinessWallets(cfg: GasKeeperChain): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const raw of cfg.wallets ?? []) {
		const addr = getAddress(raw)
		const key = addr.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(addr)
	}
	return out
}

export type SpendStatus = 'pending' | 'settled' | 'released'

export type SpendRow = {
	idempotencyKey: string
	chainId: string
	address: string
	amountWei: string
	recordedAt: string
	status: SpendStatus
	attempt: number
	hash?: string
}

type KeeperState = { version: 2; spend: SpendRow[] }

type TopupReceipt = { hash?: string; status?: string; duplicate?: boolean }

/**
 * Tops up explicit business wallets from the PM key only.
 * An empty whitelist tops up nobody. Active registry arrays are not a funding list.
 * Hard rules: whitelist, explicit budget, never a compromised address, one open top-up per address,
 * per-address daily cap, and a chain total that is not refilled by rewriting the UTC day.
 * Locked signers do not sign. oracle-daemon cannot invoke this over RPC or the admin socket.
 */
export class GasKeeper {
	private timer?: ReturnType<typeof setTimeout>
	private stopped = true
	private running = false

	constructor(
		private readonly chains: Record<string, GasKeeperChain>,
		private readonly intervalMs: number,
		private readonly txm: TxManager,
		private readonly keyring: Keyring,
		private readonly registry: () => RegistryBody | null,
		private readonly compromised: () => Set<string>,
		private readonly alerter: Alerter,
		private readonly audit: AuditLog,
		private readonly statePath: string,
	) {}

	start(): void {
		if (this.timer !== undefined || !this.keyring.unlocked) return
		this.stopped = false
		const schedule = (): void => {
			if (this.stopped || !this.keyring.unlocked) return
			this.timer = setTimeout(() => {
				this.timer = undefined
				void this.runOnce().finally(() => schedule())
			}, this.intervalMs)
		}
		schedule()
		void this.runOnce()
	}

	stop(): void {
		this.stopped = true
		if (this.timer !== undefined) clearTimeout(this.timer)
		this.timer = undefined
	}

	async status(): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {}
		const reg = this.registry()
		if (!reg) return out
		for (const idStr of Object.keys(this.chains)) {
			const chainId = Number(idStr)
			const p = this.txm.provider(chainId)
			const rows: Record<string, string> = { PM: formatEther(await p.getBalance(reg.pm)) }
			for (const arr of reg.arrays.filter((a) => a.status === 'active' && a.chains.includes(chainId))) {
				for (let i = 0; i < arr.addresses.length; i++) rows[`${arr.name}[${i}] ${arr.addresses[i]}`] = formatEther(await p.getBalance(arr.addresses[i]!))
			}
			out[idStr] = rows
		}
		return out
	}

	async runOnce(): Promise<void> {
		if (this.running || !this.keyring.unlocked) return
		const reg = this.registry()
		if (!reg) return
		this.running = true
		try {
			for (const [idStr, cfg] of Object.entries(this.chains)) {
				await this.runChain(Number(idStr), cfg, reg).catch((e: unknown) => {
					process.stderr.write(`[gas] chain ${idStr}: ${errorMessage(e)}\n`)
				})
			}
		} finally {
			this.running = false
		}
	}

	private async runChain(chainId: number, cfg: GasKeeperChain, reg: RegistryBody): Promise<void> {
		// The oracle contract address is the same on Base. This phase funds CoNET only.
		if (chainId === 8453) {
			this.alerter.send('warn', `topup-chain-refused:${chainId}`, `gas keeper does not top up chain ${chainId}`)
			return
		}
		const wallets = explicitBusinessWallets(cfg)
		if (wallets.length === 0) {
			this.alerter.send('warn', `topup-whitelist-empty:${chainId}`, `gas keeper chain ${chainId} has no business-wallet whitelist`)
			return
		}
		if (cfg.budgetWei === undefined) {
			this.alerter.send('warn', `topup-budget-unset:${chainId}`, `gas keeper chain ${chainId} has no explicit budget`)
			return
		}
		const budget = BigInt(cfg.budgetWei)
		const p = this.txm.provider(chainId)
		const pm = getAddress(reg.pm)
		let pmBal = await p.getBalance(pm)
		if (pmBal < BigInt(cfg.pmCriticalWei)) this.alerter.send('critical', `pm-low:${chainId}`, `PM ${pm} balance ${formatEther(pmBal)} on chain ${chainId}`)
		else if (pmBal < BigInt(cfg.pmWarnWei)) this.alerter.send('warn', `pm-low:${chainId}`, `PM ${pm} balance ${formatEther(pmBal)} on chain ${chainId}`)

		const state = this.loadState()
		if (!state) return
		let gasReserve: bigint
		try {
			const fee = await p.getFeeData()
			const reserve = worstCaseNativeTransferGasWei(fee.gasPrice, fee.maxFeePerGas)
			if (reserve === undefined) {
				this.alerter.send('critical', `pm-gas-unknown:${chainId}`, `PM top-up on chain ${chainId} needs a gas price before it can reserve gas`)
				return
			}
			gasReserve = reserve
		} catch (e) {
			this.alerter.send('critical', `pm-gas-unknown:${chainId}`, `PM top-up on chain ${chainId} could not read the gas price: ${errorMessage(e)}`)
			return
		}

		const bad = this.compromised()
		const min = BigInt(cfg.minWei)
		const target = BigInt(cfg.targetWei)
		const chainKey = String(chainId)
		const nowIso = new Date().toISOString()
		const targets = wallets
			.filter((addr) => addr.toLowerCase() !== pm.toLowerCase())
			.sort((x, y) => this.txm.inflightCount(chainId, y) - this.txm.inflightCount(chainId, x))

		for (const addr of targets) {
			if (!this.keyring.unlocked) return
			const address = addr.toLowerCase()
			const open = openRow(state, chainKey, address)
			if (open) {
				const gate = this.settleOpenRow(open)
				this.saveState(state)
				if (gate === 'busy') continue
				if (gate === 'resume') {
					if (pmBal < BigInt(open.amountWei) + gasReserve) {
						this.alerter.send('critical', `pm-empty:${chainId}`, `PM cannot cover top-up of ${addr} plus gas`)
						return
					}
					const sent = await this.broadcast(state, chainId, pm, addr, open)
					if (sent) pmBal -= BigInt(open.amountWei) + gasReserve
					continue
				}
			}
			if (bad.has(address)) {
				this.alerter.send('warn', `topup-rejected:${chainKey}:${address}`, `${addr} is compromised`)
				continue
			}
			const bal = await p.getBalance(addr)
			if (bal >= min) continue
			const amount = target - bal
			if (amount <= 0n) continue
			const used = gasKeeperUsage(state.spend, chainKey, address, nowIso)
			if (used.addressDaily + amount > BigInt(cfg.perAddressDailyWei)) {
				this.alerter.send('warn', `topup-cap:${chainKey}:${address}`, `${addr} hit its daily top-up cap`)
				continue
			}
			if (used.globalDaily + amount > BigInt(cfg.globalDailyWei)) {
				this.alerter.send('warn', `topup-global-cap:${chainId}`, `global daily top-up cap reached on chain ${chainId}`)
				return
			}
			// Prior days stay in the total. A new UTC date does not mint another globalDailyWei.
			if (used.globalTotal + amount > BigInt(cfg.globalDailyWei)) {
				this.alerter.send('warn', `topup-total-cap:${chainId}`, `total top-up budget reached on chain ${chainId}`)
				return
			}
			if (used.globalTotal + amount > budget) {
				this.alerter.send('warn', `topup-budget:${chainId}`, `explicit top-up budget reached on chain ${chainId}`)
				return
			}
			if (pmBal < amount + gasReserve) {
				this.alerter.send('critical', `pm-empty:${chainId}`, `PM cannot cover top-up of ${addr} plus gas`)
				return
			}
			const attempt = nextAttempt(state, chainKey, address)
			const row: SpendRow = {
				idempotencyKey: gasKeeperTopupIdempotencyKey(chainId, address, attempt),
				chainId: chainKey,
				address,
				amountWei: amount.toString(),
				recordedAt: nowIso,
				status: 'pending',
				attempt,
			}
			state.spend.push(row)
			// Durable before broadcast so a restart cannot mint a second attempt.
			this.saveState(state)
			const sent = await this.broadcast(state, chainId, pm, addr, row)
			if (sent) pmBal -= amount + gasReserve
		}
	}

	/** 'busy' = unconfirmed, do not send. 'resume' = intent was saved but not broadcast. 'clear' = terminal. */
	private settleOpenRow(row: SpendRow): 'busy' | 'resume' | 'clear' {
		const rec = this.lookup(row)
		if (!rec) {
			if (row.hash) return 'busy'
			return 'resume'
		}
		if (rec.hash) row.hash = rec.hash
		if (rec.status === 'sent' || rec.status === 'stuck' || rec.status === undefined) return 'busy'
		if (rec.status === 'mined') {
			row.status = 'settled'
			return 'clear'
		}
		if (rec.status === 'reverted' || rec.status === 'rejected') {
			row.status = 'released'
			return 'clear'
		}
		return 'busy'
	}

	private lookup(row: SpendRow): TopupReceipt | undefined {
		const byKey = this.txm.get({ idempotencyKey: row.idempotencyKey, client: GAS_KEEPER_CLIENT })
		if (byKey) return byKey
		if (!row.hash) return undefined
		return this.txm.get({ hash: row.hash })
	}

	private async broadcast(state: KeeperState, chainId: number, pm: string, addr: string, row: SpendRow): Promise<boolean> {
		if (!this.keyring.unlocked) return false
		const source = getAddress(pm)
		try {
			const res = await this.txm.send({
				client: GAS_KEEPER_CLIENT,
				array: 'PM',
				chainId,
				candidates: [source],
				to: addr,
				data: '0x',
				value: BigInt(row.amountWei),
				gasLimit: NATIVE_TOPUP_GAS_LIMIT,
				maxInflightPerKey: 4,
				skipSimulation: true,
				idempotencyKey: row.idempotencyKey,
				method: 'topup',
			})
			if (res.hash) row.hash = res.hash
			if (res.status === 'mined') row.status = 'settled'
			else if (res.status === 'reverted' || res.status === 'rejected') row.status = 'released'
			else row.status = 'pending'
			this.saveState(state)
			if (row.status === 'released') return false
			if (!res.duplicate) {
				this.audit.write({ event: 'gas.topup', chainId, array: 'PM', to: addr, amountWei: row.amountWei, hash: res.hash, idempotencyKey: row.idempotencyKey })
			}
			return true
		} catch (e) {
			const rec = this.lookup(row)
			if (rec && (rec.status === 'sent' || rec.status === 'stuck' || rec.status === undefined) && rec.hash) {
				row.hash = rec.hash
				row.status = 'pending'
				this.saveState(state)
				this.alerter.send('warn', `topup-unconfirmed:${row.chainId}:${row.address}`, `top-up of ${addr} is still unconfirmed`)
				return true
			}
			if (!rec && !row.hash) {
				row.status = 'released'
				this.saveState(state)
			}
			this.alerter.send('warn', `topup-fail:${row.chainId}:${row.address}`, `top-up of ${addr} failed: ${errorMessage(e)}`)
			return false
		}
	}

	private loadState(): KeeperState | null {
		if (!existsSync(this.statePath)) return { version: 2, spend: [] }
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
			const state = normalizeKeeperState(parsed)
			if (!state) {
				this.alerter.send('critical', 'gas-state', 'gas keeper state is unreadable; top-ups paused')
				return null
			}
			return state
		} catch (e) {
			this.alerter.send('critical', 'gas-state', `gas keeper state is unreadable; top-ups paused: ${errorMessage(e)}`)
			return null
		}
	}

	private saveState(s: KeeperState): void {
		const tmp = `${this.statePath}.${process.pid}.tmp`
		writeFileSync(tmp, JSON.stringify(s), { mode: 0o640 })
		renameSync(tmp, this.statePath)
	}
}

/** Highest known fee, at least the legacy gas price, times the native transfer limit. */
export function worstCaseNativeTransferGasWei(gasPrice?: bigint | null, maxFeePerGas?: bigint | null): bigint | undefined {
	const prices = [gasPrice, maxFeePerGas].filter((price): price is bigint => typeof price === 'bigint' && price > 0n)
	if (prices.length === 0) return undefined
	const worst = prices.reduce((highest, price) => (price > highest ? price : highest))
	return NATIVE_TOPUP_GAS_LIMIT * worst
}

/** Stable across restarts. The attempt number changes only after the previous top-up is terminal. */
export function gasKeeperTopupIdempotencyKey(chainId: number, address: string, attempt: number): string {
	if (!Number.isInteger(attempt) || attempt < 1) throw new Error('bad top-up attempt')
	return `topup:${chainId}:${address.toLowerCase()}:${attempt}`
}

export function gasKeeperUsage(rows: readonly SpendRow[], chainId: string, address: string, nowIso: string): { addressDaily: bigint; globalDaily: bigint; globalTotal: bigint } {
	const today = nowIso.slice(0, 10)
	let addressDaily = 0n
	let globalDaily = 0n
	let globalTotal = 0n
	for (const row of rows) {
		if (row.chainId !== chainId || row.status === 'released') continue
		const amount = BigInt(row.amountWei)
		globalTotal += amount
		const onToday = row.recordedAt.slice(0, 10) === today
		const reserved = row.status === 'pending'
		if (onToday || reserved) globalDaily += amount
		if (row.address === address && (onToday || reserved)) addressDaily += amount
	}
	return { addressDaily, globalDaily, globalTotal }
}

export function normalizeKeeperState(parsed: unknown): KeeperState | null {
	if (!parsed || typeof parsed !== 'object') return null
	const obj = parsed as Record<string, unknown>
	if (obj.version === 2 && Array.isArray(obj.spend)) {
		const spend: SpendRow[] = []
		for (const raw of obj.spend) {
			const row = parseSpendRow(raw)
			if (!row) return null
			spend.push(row)
		}
		return { version: 2, spend }
	}
	if (typeof obj.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.day)) return migrateDayState(obj)
	return null
}

function openRow(state: KeeperState, chainId: string, address: string): SpendRow | undefined {
	return state.spend.find((row) => row.chainId === chainId && row.address === address && row.status === 'pending')
}

function nextAttempt(state: KeeperState, chainId: string, address: string): number {
	let max = 0
	for (const row of state.spend) {
		if (row.chainId === chainId && row.address === address && row.attempt > max) max = row.attempt
	}
	return max + 1
}

function migrateDayState(obj: Record<string, unknown>): KeeperState | null {
	const day = obj.day as string
	const recordedAt = `${day}T00:00:00.000Z`
	const spend: SpendRow[] = []
	const per = obj.perAddress
	if (per !== undefined && (typeof per !== 'object' || per === null || Array.isArray(per))) return null
	const byChain = new Map<string, bigint>()
	for (const [pk, raw] of Object.entries((per ?? {}) as Record<string, unknown>)) {
		const amount = parseWei(raw)
		const sep = pk.indexOf(':')
		if (amount === null || sep <= 0) return null
		const chainId = pk.slice(0, sep)
		const address = pk.slice(sep + 1).toLowerCase()
		spend.push({
			idempotencyKey: `migrated:${pk}`,
			chainId,
			address,
			amountWei: amount.toString(),
			recordedAt,
			status: 'settled',
			attempt: 0,
		})
		byChain.set(chainId, (byChain.get(chainId) ?? 0n) + amount)
	}
	const global = obj.global
	if (global !== undefined && (typeof global !== 'object' || global === null || Array.isArray(global))) return null
	for (const [chainId, raw] of Object.entries((global ?? {}) as Record<string, unknown>)) {
		const amount = parseWei(raw)
		if (amount === null) return null
		const already = byChain.get(chainId) ?? 0n
		if (amount > already) {
			spend.push({
				idempotencyKey: `migrated-global:${chainId}`,
				chainId,
				address: '',
				amountWei: (amount - already).toString(),
				recordedAt,
				status: 'settled',
				attempt: 0,
			})
		}
	}
	return { version: 2, spend }
}

function parseSpendRow(raw: unknown): SpendRow | null {
	if (!raw || typeof raw !== 'object') return null
	const row = raw as Record<string, unknown>
	const amount = parseWei(row.amountWei)
	if (amount === null) return null
	if (typeof row.idempotencyKey !== 'string' || row.idempotencyKey.length === 0 || row.idempotencyKey.length > 200) return null
	if (typeof row.chainId !== 'string' || typeof row.address !== 'string') return null
	if (typeof row.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.recordedAt)) return null
	if (row.status !== 'pending' && row.status !== 'settled' && row.status !== 'released') return null
	if (typeof row.attempt !== 'number' || !Number.isInteger(row.attempt) || row.attempt < 0) return null
	if (row.hash !== undefined && typeof row.hash !== 'string') return null
	return {
		idempotencyKey: row.idempotencyKey,
		chainId: row.chainId,
		address: row.address.toLowerCase(),
		amountWei: amount.toString(),
		recordedAt: row.recordedAt,
		status: row.status,
		attempt: row.attempt,
		hash: row.hash,
	}
}

function parseWei(raw: unknown): bigint | null {
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
	return BigInt(raw)
}
