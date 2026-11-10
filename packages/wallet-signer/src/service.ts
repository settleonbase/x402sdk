import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Transaction, TypedDataEncoder, getAddress, isAddress, type TypedDataField } from 'ethers'
import { DefaultAlerter, type Alerter } from './alerts'
import { AuditLog } from './audit'
import { canonicalHash } from './canonical'
import { paths, type Config } from './config'
import { ErrorCode, SignerError, denied } from './errors'
import { GasKeeper } from './gasKeeper'
import { HdRoot } from './hd'
import { Keyring } from './keyring'
import { Policy } from './policy'
import { RateLimiter } from './rateLimit'
import {
	addArray,
	bodyOf,
	emptyRegistry,
	growArray,
	loadRegistry,
	rotateArray,
	saveRegistry,
	signRegistry,
	verifyRegistry,
	type RegistryFile,
} from './registry'
import { TxManager, type SendResult, type TxRecord } from './txManager'
import { TypedDataReplayLog, resolveTypedDataNonce } from './typedDataReplay'
import { openVault, readVaultFile } from './vault'

export type ServiceState = 'locked' | 'unlocked' | 'registry_mismatch'

export type SendParams = {
	keyArray: string
	chainId: number
	from?: string
	to: string
	data: string
	value?: string
	gasLimit?: string
	idempotencyKey?: string
}

export const VERSION = '0.1.0'

export class SignerService {
	state: ServiceState = 'locked'
	readonly keyring = new Keyring()
	readonly audit: AuditLog
	readonly alerter: Alerter
	readonly txm: TxManager
	readonly typedDataReplay: TypedDataReplayLog
	readonly gasKeeper: GasKeeper
	policy: Policy
	private hd: HdRoot | null = null
	private registry: RegistryFile | null = null
	private compromised = new Set<string>()
	private disabledClients = new Set<string>()
	private rate = new RateLimiter()
	private failedUnlocks = 0
	private nextUnlockAt = 0
	private readonly p: ReturnType<typeof paths>

	constructor(readonly config: Config, alerter?: Alerter) {
		this.p = paths(config)
		this.alerter = alerter ?? new DefaultAlerter(config.alerts)
		this.audit = new AuditLog(this.p.audit)
		this.policy = Policy.load(config.policyFile)
		this.loadCompromised()
		if (existsSync(this.p.clientState)) {
			for (const c of JSON.parse(readFileSync(this.p.clientState, 'utf8')) as string[]) this.disabledClients.add(c)
		}
		this.registry = loadRegistry(this.p.registry)
		this.txm = new TxManager(config.chains, this.keyring, this.audit, this.alerter, this.p.journal, config.keyWaitMs)
		this.typedDataReplay = new TypedDataReplayLog(this.p.typedDataReplay)
		this.gasKeeper = new GasKeeper(
			config.gasKeeper.chains,
			config.gasKeeper.intervalMs,
			this.txm,
			this.keyring,
			() => (this.registry ? bodyOf(this.registry) : null),
			() => this.compromised,
			this.alerter,
			this.audit,
			this.p.gasState,
		)
		this.audit.write({ event: 'service.start', version: VERSION, policyHash: this.policy.hash })
	}

	start(): void {
		// Poll receipts only. Rebroadcast and the gas keeper stay off until unlock().
		this.txm.start()
		this.alerter.send('warn', 'locked', 'wallet-signer started LOCKED; run wsctl unlock')
	}

	stop(): void {
		this.txm.stop()
		this.gasKeeper.stop()
		this.lock('shutdown')
	}

	// ---------- admin ----------

	status(): Record<string, unknown> {
		return {
			version: VERSION,
			state: this.state,
			pm: this.registry?.pm ?? null,
			registryHash: this.registry ? canonicalHash(this.registry) : null,
			policyHash: this.policy.hash,
			arrays: (this.registry?.arrays ?? []).map((a) => ({ name: a.name, account: a.account, count: a.count, chains: a.chains, status: a.status })),
			disabledClients: [...this.disabledClients],
			compromisedCount: this.compromised.size,
			stuckTx: this.txm.stuck().map((r) => ({ id: r.id, hash: r.hash, array: r.array })),
		}
	}

	async unlock(password: string): Promise<Record<string, unknown>> {
		if (this.state === 'unlocked') return { ...this.fingerprint(), already: true }
		const now = Date.now()
		if (now < this.nextUnlockAt) throw new SignerError(ErrorCode.RATE_LIMITED, `retry after ${Math.ceil((this.nextUnlockAt - now) / 1000)}s`)
		if (!existsSync(this.p.vault)) throw new SignerError(ErrorCode.NOT_FOUND, 'no vault; run wsctl init')
		let opened
		try {
			opened = await openVault(readVaultFile(this.p.vault), password)
		} catch {
			this.failedUnlocks++
			this.nextUnlockAt = Date.now() + Math.min(300_000, 1000 * 2 ** (this.failedUnlocks - 1))
			this.audit.write({ event: 'unlock.fail', failures: this.failedUnlocks })
			if (this.failedUnlocks >= 3) this.alerter.send('critical', 'unlock-fail', `${this.failedUnlocks} failed unlock attempts`)
			throw new SignerError(ErrorCode.UNAUTHORIZED, 'wrong password')
		}
		const hd = HdRoot.fromEntropy(opened.entropy)
		opened.entropy.fill(0)
		let reg = this.registry
		if (reg) {
			const problems = verifyRegistry(reg, hd)
			if (problems.length > 0) {
				hd.wipe()
				this.state = 'registry_mismatch'
				this.audit.write({ event: 'unlock.registry_mismatch', problems })
				this.alerter.send('critical', 'registry-mismatch', `registry does not match vault: ${problems.join('; ')}`)
				throw new SignerError(ErrorCode.REGISTRY_MISMATCH, 'registry does not match the vault', problems)
			}
		}
		this.keyring.load(hd, reg)
		if (!reg) {
			reg = signRegistry(this.keyring, emptyRegistry(this.keyring.pmAddress, this.keyring.attestorAddress))
			saveRegistry(this.p.registry, reg)
			this.registry = reg
		}
		this.hd = hd
		this.state = 'unlocked'
		this.failedUnlocks = 0
		this.nextUnlockAt = 0
		this.audit.write({ event: 'unlock.ok', pm: reg.pm, registryHash: canonicalHash(reg) })
		this.alerter.send('info', 'unlocked', `wallet-signer unlocked (PM ${reg.pm})`)
		if (this.config.gasKeeper.enabled) this.gasKeeper.start()
		return this.fingerprint()
	}

	lock(reason = 'admin'): void {
		this.gasKeeper.stop()
		this.keyring.wipe()
		this.hd?.wipe()
		this.hd = null
		if (this.state === 'unlocked') this.state = 'locked'
		this.audit.write({ event: 'lock', reason })
	}

	fingerprint(): Record<string, unknown> {
		return { pm: this.registry?.pm, attestor: this.registry?.attestor, registryHash: this.registry ? canonicalHash(this.registry) : null }
	}

	listArrays(): unknown {
		return (this.registry?.arrays ?? []).map((a) => ({ ...a }))
	}

	arrayAdd(name: string, count: number, chains: number[]): unknown {
		const { hd, reg } = this.mutable()
		const body = addArray(bodyOf(reg), hd, name, count, chains)
		return this.commitRegistry(body, 'array.add', name)
	}

	arrayGrow(name: string, count: number): unknown {
		const { hd, reg } = this.mutable()
		return this.commitRegistry(growArray(bodyOf(reg), hd, name, count), 'array.grow', name)
	}

	arrayRotate(name: string): unknown {
		const { hd, reg } = this.mutable()
		return this.commitRegistry(rotateArray(bodyOf(reg), hd, name), 'array.rotate', name)
	}

	reloadPolicy(): unknown {
		const next = Policy.load(this.config.policyFile)
		const prev = this.policy.hash
		this.policy = next
		this.loadCompromised()
		this.audit.write({ event: 'policy.reload', prev, next: next.hash, clients: next.clients() })
		return { prev, next: next.hash, clients: next.clients(), compromised: this.compromised.size }
	}

	setClientDisabled(name: string, disabled: boolean): unknown {
		if (disabled) this.disabledClients.add(name)
		else this.disabledClients.delete(name)
		writeFileSync(this.p.clientState, JSON.stringify([...this.disabledClients]), { mode: 0o640 })
		this.audit.write({ event: disabled ? 'client.disable' : 'client.enable', client: name })
		return { disabled: [...this.disabledClients] }
	}

	private mutable(): { hd: HdRoot; reg: RegistryFile } {
		if (this.state !== 'unlocked' || !this.hd || !this.registry) throw new SignerError(ErrorCode.LOCKED, 'unlock first')
		return { hd: this.hd, reg: this.registry }
	}

	private commitRegistry(body: ReturnType<typeof bodyOf>, event: string, name: string): unknown {
		const file = signRegistry(this.keyring, body)
		saveRegistry(this.p.registry, file)
		this.registry = file
		this.keyring.load(this.hd!, file)
		this.audit.write({ event, name, registryHash: canonicalHash(file) })
		return file.arrays.filter((a) => a.name === name)
	}

	private loadCompromised(): void {
		this.compromised.clear()
		if (!existsSync(this.config.compromisedFile)) return
		const list = JSON.parse(readFileSync(this.config.compromisedFile, 'utf8')) as { addresses?: string[] } | string[]
		const arr = Array.isArray(list) ? list : (list.addresses ?? [])
		for (const a of arr) if (isAddress(a)) this.compromised.add(a.toLowerCase())
	}

	compromisedList(): string[] {
		return [...this.compromised].map((a) => getAddress(a))
	}

	// ---------- client ops ----------

	authorizeClient(name: string): void {
		const cp = this.policy.client(name)
		if (!cp || cp.disabled || this.disabledClients.has(name)) throw new SignerError(ErrorCode.UNAUTHORIZED, 'client not allowed')
	}

	private requireUnlocked(): RegistryFile {
		if (this.state === 'registry_mismatch') throw new SignerError(ErrorCode.REGISTRY_MISMATCH, 'registry mismatch; signer refuses to sign')
		if (this.state !== 'unlocked' || !this.registry) throw new SignerError(ErrorCode.LOCKED, 'signer locked')
		return this.registry
	}

	private activeAddresses(array: string): string[] {
		const arr = this.registry?.arrays.find((a) => a.name === array && a.status === 'active')
		if (!arr) throw denied(`key array ${array} does not exist in the registry`)
		return arr.addresses.map((a) => getAddress(a))
	}

	private registrySet(): Set<string> {
		return new Set((this.registry?.arrays ?? []).filter((a) => a.status === 'active').flatMap((a) => a.addresses.map((x) => x.toLowerCase())))
	}

	private takeRate(client: string, array: string, rate?: { perMinute?: number; perDay?: number }): void {
		if (!this.rate.take(`${client}/${array}`, rate?.perMinute, rate?.perDay)) {
			this.audit.write({ event: 'deny', client, array, reason: 'rate' })
			throw new SignerError(ErrorCode.RATE_LIMITED, 'rate limit')
		}
	}

	/** Addresses of a key array this client may use. Works while locked (registry is public). */
	accounts(client: string, keyArray?: string, chainId?: number): string[] {
		if (keyArray) {
			this.policy.grant(client, keyArray, chainId)
			return this.activeAddresses(keyArray)
		}
		return this.policy.arraysOf(client).flatMap((a) => {
			try {
				return this.activeAddresses(a)
			} catch {
				return []
			}
		})
	}

	async sendTransaction(client: string, p: SendParams): Promise<SendResult> {
		this.requireUnlocked()
		const chainId = Number(p.chainId)
		const value = BigInt(p.value ?? '0')
		const gasLimit = p.gasLimit !== undefined ? BigInt(p.gasLimit) : undefined
		if (typeof p.keyArray !== 'string' || typeof p.to !== 'string' || typeof p.data !== 'string') throw new SignerError(ErrorCode.INVALID_PARAMS, 'keyArray, to, data required')
		if (p.idempotencyKey !== undefined && (typeof p.idempotencyKey !== 'string' || p.idempotencyKey.length > 200)) throw new SignerError(ErrorCode.INVALID_PARAMS, 'bad idempotencyKey')
		let decision
		try {
			decision = this.policy.checkCall(
				{ client, array: p.keyArray, chainId, to: p.to, data: p.data, value, gasLimit },
				{ compromised: this.compromised, registry: this.registrySet() },
			)
		} catch (e) {
			this.audit.write({ event: 'deny', client, array: p.keyArray, chainId, to: p.to, selector: p.data?.slice(0, 10), reason: (e as Error).message })
			throw e
		}
		// Hard rule: never send value to a compromised address.
		if (value > 0n && this.compromised.has(p.to.toLowerCase())) throw denied('value transfer to a compromised address')
		const g = decision.grant
		this.takeRate(client, p.keyArray, g.rate)
		const capGwei = g.maxGasPriceGwei?.[String(chainId)]
		return this.txm.send({
			client,
			array: p.keyArray,
			chainId,
			candidates: this.activeAddresses(p.keyArray),
			from: p.from,
			to: p.to,
			data: p.data,
			value,
			gasLimit,
			maxGas: decision.maxGas !== undefined ? BigInt(decision.maxGas) : undefined,
			idempotencyKey: p.idempotencyKey,
			maxGasPriceWei: capGwei !== undefined ? BigInt(Math.round(capGwei * 1e9)) : undefined,
			maxInflightPerKey: g.maxInflightPerKey ?? 1,
			dailyBudgetWei: g.dailyGasBudgetWei?.[String(chainId)] !== undefined ? BigInt(g.dailyGasBudgetWei[String(chainId)]!) : undefined,
			method: decision.method,
			args: decision.args,
		})
	}

	/** Sign-only: the caller owns nonce and fees. Needs allowSignOnly in policy. */
	signTransaction(client: string, txReq: Record<string, unknown>): string {
		this.requireUnlocked()
		const from = String(txReq.from ?? '')
		const info = isAddress(from) ? this.keyring.info(from) : undefined
		if (!info || info.role !== 'array' || !info.array) throw denied('from is not a key array address')
		const tx = Transaction.from({ ...(txReq as object), from: undefined } as never)
		const chainId = Number(tx.chainId)
		const g = this.policy.grant(client, info.array, chainId)
		if (!g.allowSignOnly) throw denied('sign-only transactions are not enabled for this array')
		if (!this.activeAddresses(info.array).includes(getAddress(from))) throw denied('key array retired')
		this.policy.checkCall(
			{ client, array: info.array, chainId, to: tx.to ?? '', data: tx.data, value: tx.value, gasLimit: tx.gasLimit },
			{ compromised: this.compromised, registry: this.registrySet() },
		)
		this.takeRate(client, info.array, g.rate)
		const raw = this.keyring.signTransaction(from, tx)
		this.audit.write({ event: 'sign.tx', client, array: info.array, chainId, from, to: tx.to, nonce: tx.nonce, hash: Transaction.from(raw).hash })
		return raw
	}

	async signTypedData(client: string, address: string, typed: { domain: Record<string, unknown>; types: Record<string, TypedDataField[]>; primaryType?: string; message: Record<string, unknown> }): Promise<string> {
		this.requireUnlocked()
		const info = isAddress(address) ? this.keyring.info(address) : undefined
		if (!info || info.role !== 'array' || !info.array) throw denied('address is not a key array address')
		if (!this.activeAddresses(info.array).includes(getAddress(address))) throw denied('key array retired')
		const types = { ...typed.types }
		delete (types as Record<string, unknown>).EIP712Domain
		let derived: string
		try {
			derived = TypedDataEncoder.getPrimaryType(types)
		} catch {
			this.audit.write({ event: 'deny', client, array: info.array, reason: 'typed data types do not define a single root' })
			throw denied('typed data types do not define a single root')
		}
		if (typed.primaryType !== undefined && typed.primaryType !== derived) {
			this.audit.write({ event: 'deny', client, array: info.array, primaryType: typed.primaryType, reason: 'primaryType does not match the type definition' })
			throw denied('primaryType does not match the type definition')
		}
		let g
		try {
			g = this.policy.checkTypedData(client, info.array, typed.domain, types, derived, typed.message)
		} catch (e) {
			this.audit.write({ event: 'deny', client, array: info.array, primaryType: derived, reason: (e as Error).message })
			throw e
		}
		const binding = resolveTypedDataNonce(address, typed.domain, derived, typed.message)
		if (!binding) {
			this.audit.write({ event: 'deny', client, array: info.array, primaryType: derived, reason: 'typed data nonce namespace is not verified' })
			throw denied('typed data nonce namespace is not verified for this schema')
		}
		const reserved = this.typedDataReplay.reserve(binding)
		if (reserved.mode === 'replay') {
			this.audit.write({ event: 'sign.typed.replay', client, array: info.array, address, primaryType: derived, verifyingContract: typed.domain.verifyingContract, chainId: typed.domain.chainId })
			return reserved.signature
		}
		if (reserved.mode === 'wait') {
			const sig = await reserved.promise
			this.audit.write({ event: 'sign.typed.replay', client, array: info.array, address, primaryType: derived, verifyingContract: typed.domain.verifyingContract, chainId: typed.domain.chainId })
			return sig
		}
		try {
			this.takeRate(client, info.array, g.rate)
			const sig = this.keyring.signTypedData(address, typed.domain, types, typed.message)
			this.typedDataReplay.commit(binding, reserved.token, sig)
			reserved.resolve(sig)
			this.audit.write({ event: 'sign.typed', client, array: info.array, address, primaryType: derived, verifyingContract: typed.domain.verifyingContract, chainId: typed.domain.chainId })
			return sig
		} catch (e) {
			this.typedDataReplay.abort(binding.id, reserved.token)
			reserved.reject(e)
			throw e
		}
	}

	personalSign(client: string, message: string, address: string): string {
		this.requireUnlocked()
		const info = isAddress(address) ? this.keyring.info(address) : undefined
		if (!info || info.role !== 'array' || !info.array) throw denied('address is not a key array address')
		const g = this.policy.grant(client, info.array)
		if (!g.allowPersonalSign) throw denied('personal_sign is not enabled for this array')
		this.takeRate(client, info.array, g.rate)
		const sig = this.keyring.signMessage(address, message.startsWith('0x') ? Buffer.from(message.slice(2), 'hex') : message)
		this.audit.write({ event: 'sign.message', client, array: info.array, address })
		return sig
	}

	getTransaction(client: string, q: { idempotencyKey?: string; hash?: string }): Partial<TxRecord> | null {
		const r = this.txm.get({ ...q, client })
		if (!r || r.client !== client) return null
		const { raw: _raw, data: _data, ...rest } = r
		return rest
	}
}
