/**
 * PM-issued addAdmin for a reviewed dedicated wallet (admin socket only).
 * Fixed: contract, selector, chain, value 0. The target must be on the reviewed allowlist in config.
 * Each target is granted at most once. Nonces are allocated by TxManager, the same per-address lock
 * GasKeeper uses, so the grant and gas top-ups never race for the PM nonce.
 * The PM key never leaves the signer. A lost receipt is reconciled by idempotency key and hash, never re-signed.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Interface, getAddress, isAddress } from 'ethers'
import { denied, ErrorCode, SignerError } from './errors'

export const PM_GRANT_VDR = '0xc71e246DD78B37C2fABc905D340932F28F503433'
export const PM_GRANT_CHAIN_ID = 224422
export const PM_GRANT_SELECTOR = '0x70480275' // addAdmin(address)
export const PM_GRANT_GAS_CAP = 150000n
/** Upper bound on the market price the grant will pay (0.03 Gwei). Enforced by TxManager.fees on the send path. */
export const PM_GRANT_MAX_GAS_PRICE_WEI = 30_000_000n
export const PM_GRANT_CLIENT = 'pm-grant-admin'
export const PM_GRANT_ARRAY = 'PM'

const IFACE = new Interface(['function addAdmin(address account)', 'function admins(address) view returns (bool)'])

/** denyAddresses: addresses that are never granted. Supplied by the private configuration; required when enabled (fail closed). */
export type PmGrantConfig = { enabled: boolean; targets: string[]; denyAddresses?: string[]; maxGasPriceWei?: string }
export type PmGrantStatus = 'pending' | 'aborted' | 'sent' | 'confirmed' | 'failed' | 'uncertain'
export type PmGrantRecord = {
	status: PmGrantStatus
	idempotencyKey: string
	pmAddress: string
	readsBefore?: { pmAdmin: boolean; targetAdmin: boolean }
	hash?: string
	at: string
}
export type PmGrantReader = {
	call(to: string, data: string, from?: string): Promise<string>
	getBalance(a: string): Promise<bigint>
	feeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
	estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint>
	receipt(hash: string): Promise<{ status: string | null } | null>
}
export type PmGrantSend = (req: {
	client: string; array: string; chainId: number; candidates: string[]; to: string; data: string; value: bigint
	gasLimit: bigint; maxGas: bigint; idempotencyKey: string; maxInflightPerKey: number; method: string; maxGasPriceWei: bigint
}) => Promise<{ hash: string | null; from: string; status: string }>
export type PmGrantDeps = {
	cfg: PmGrantConfig | undefined
	statePath: string
	pmAddress: string
	reader: PmGrantReader
	send: PmGrantSend
	/** Looks up a journaled tx by idempotency key. Returns hash if one exists. */
	journalHash(idempotencyKey: string): string | null
	audit(e: Record<string, unknown>): void
	now?: () => Date
}

/** One process-wide gate for every PM grant. Taken before any state read, so no two grants can interleave. */
let gate: Promise<unknown> = Promise.resolve()
export function pmGrantSerial<T>(fn: () => Promise<T>): Promise<T> {
	const run = gate.then(fn, fn)
	gate = run.catch(() => undefined)
	return run
}

/** Pure target check. Returns the checksum address or throws. */
export function checkPmGrantTarget(target: unknown, pmAddress: string, cfg: PmGrantConfig | undefined): string {
	if (!cfg || cfg.enabled !== true) throw denied('pm grant admin is disabled')
	if (typeof target !== 'string' || !isAddress(target)) throw new SignerError(ErrorCode.INVALID_PARAMS, 'target must be an address')
	const addr = getAddress(target)
	const low = addr.toLowerCase()
	if (low === '0x0000000000000000000000000000000000000000') throw denied('zero address')
	const deny = new Set((cfg.denyAddresses ?? []).map((a) => getAddress(a).toLowerCase()))
	if (deny.size === 0) throw denied('deny list not configured; refusing (fail closed)')
	if (deny.has(low)) throw denied('address is on the deny list')
	if (low === PM_GRANT_VDR.toLowerCase()) throw denied('target is the contract itself')
	if (low === getAddress(pmAddress).toLowerCase()) throw denied('target is the PM address')
	const allowed = new Set(cfg.targets.map((t) => getAddress(t).toLowerCase()))
	if (!allowed.has(low)) throw denied('target is not on the reviewed allowlist')
	return addr
}

/** Production cap is 0.03 Gwei. A config value may override it; the override is audited by the caller. */
export function capWei(cfg: PmGrantConfig | undefined): bigint {
	return cfg?.maxGasPriceWei !== undefined ? BigInt(cfg.maxGasPriceWei) : PM_GRANT_MAX_GAS_PRICE_WEI
}

function readState(path: string): Record<string, PmGrantRecord> {
	if (!existsSync(path)) return {}
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, PmGrantRecord>
}
function writeState(path: string, s: Record<string, PmGrantRecord>): void {
	const tmp = `${path}.tmp`
	writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
	renameSync(tmp, path)
}
const keyFor = (target: string) => `pm-grant:${PM_GRANT_CHAIN_ID}:${target.toLowerCase()}`

/** Grant one target. Refusals throw before any signing. Intent is durable before the first await. */
export function runPmGrantAdmin(deps: PmGrantDeps, targetIn: unknown): Promise<{ target: string; hash: string | null; status: PmGrantStatus }> {
	return pmGrantSerial(async () => {
		const now = deps.now ?? (() => new Date())
		const target = checkPmGrantTarget(targetIn, deps.pmAddress, deps.cfg)
		const key = keyFor(target)
		const state = readState(deps.statePath)
		const prior = state[target.toLowerCase()]
		// aborted = failed before any broadcast: no transaction exists, so a retry cannot double-pay.
		if (prior && prior.status !== 'aborted') throw denied(`target already granted or in flight (${prior.status}); use reconcile`)
		// Durable intent before any await.
		state[target.toLowerCase()] = { status: 'pending', idempotencyKey: key, pmAddress: deps.pmAddress, at: now().toISOString() }
		writeState(deps.statePath, state)

		// Everything up to the send is pre-broadcast. Any failure here aborts the attempt and leaves it retryable.
		const abort = (msg: string | null, err?: unknown): never => {
			state[target.toLowerCase()] = { ...state[target.toLowerCase()]!, status: 'aborted' }
			writeState(deps.statePath, state)
			deps.audit({ event: 'pm.grantAdmin.aborted', target, reason: msg ?? String(err) })
			if (msg !== null) throw denied(msg)
			throw err
		}
		let data = '0x'
		let gasLimit = 0n
		let fee = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
		let reads = { pmAdmin: false, targetAdmin: false }
		try {
			const pmAdmin = BigInt(await deps.reader.call(PM_GRANT_VDR, IFACE.encodeFunctionData('admins', [deps.pmAddress]))) === 1n
			const targetAdmin = BigInt(await deps.reader.call(PM_GRANT_VDR, IFACE.encodeFunctionData('admins', [target]))) === 1n
			reads = { pmAdmin, targetAdmin }
			state[target.toLowerCase()] = { ...state[target.toLowerCase()]!, readsBefore: reads }
			writeState(deps.statePath, state)
			deps.audit({ event: 'pm.grantAdmin.reads', target, ...reads })
			if (!pmAdmin) abort('PM is not an admin on chain')
			if (targetAdmin) abort('target is already an admin on chain')
			data = IFACE.encodeFunctionData('addAdmin', [target])
			if (data.slice(0, 10) !== PM_GRANT_SELECTOR) throw new SignerError(ErrorCode.INTERNAL, 'selector drift')
			await deps.reader.call(PM_GRANT_VDR, data, deps.pmAddress) // simulation from PM
			gasLimit = await deps.reader.estimateGas({ from: deps.pmAddress, to: PM_GRANT_VDR, data })
			if (gasLimit > PM_GRANT_GAS_CAP) abort(`gas estimate ${gasLimit} above cap ${PM_GRANT_GAS_CAP}`)
			fee = await deps.reader.feeData()
			const need = gasLimit * fee.maxFeePerGas
			const bal = await deps.reader.getBalance(deps.pmAddress)
			if (bal < need) abort(`PM balance ${bal} below worst-case ${need}`)
		} catch (e) {
			if (e instanceof SignerError && e.code !== ErrorCode.UPSTREAM) throw e
			abort(null, e)
		}

		// Hash of the signed tx is durable before broadcast. TxManager journals it under the same key.
		state[target.toLowerCase()] = { ...state[target.toLowerCase()]!, status: 'sent' }
		writeState(deps.statePath, state)
		let res: { hash: string | null; from: string; status: string }
		try {
			res = await deps.send({
				client: PM_GRANT_CLIENT, array: PM_GRANT_ARRAY, chainId: PM_GRANT_CHAIN_ID, candidates: [deps.pmAddress],
				to: PM_GRANT_VDR, data, value: 0n, gasLimit, maxGas: PM_GRANT_GAS_CAP, idempotencyKey: key,
				maxInflightPerKey: 1, method: 'pm.grantAdmin', maxGasPriceWei: capWei(deps.cfg),
			})
		} catch (e) {
			// Price cap refusal happens before signing and broadcast: no transaction exists, so the attempt is retryable.
			if (e instanceof SignerError && e.code === ErrorCode.GAS_PRICE_TOO_HIGH) abort(null, e)
			// Anything else is ambiguous: the tx may or may not have reached the network. Do not re-sign. Reconcile by key.
			state[target.toLowerCase()] = { ...state[target.toLowerCase()]!, status: 'uncertain' }
			writeState(deps.statePath, state)
			deps.audit({ event: 'pm.grantAdmin.uncertain', target, idempotencyKey: key })
			throw new SignerError(ErrorCode.UPSTREAM, 'send outcome unknown; target marked uncertain, reconcile by key, no re-sign')
		}
		if (getAddress(res.from) !== getAddress(deps.pmAddress)) {
			state[target.toLowerCase()] = { ...state[target.toLowerCase()]!, status: 'uncertain' }
			writeState(deps.statePath, state)
			throw new SignerError(ErrorCode.INTERNAL, 'signer address is not PM; refused')
		}
		state[target.toLowerCase()] = { ...state[target.toLowerCase()]!, status: 'sent', hash: res.hash ?? undefined }
		writeState(deps.statePath, state)
		deps.audit({ event: 'pm.grantAdmin.sent', target, hash: res.hash, idempotencyKey: key, ...reads, gasLimit: gasLimit.toString() })
		return { target, hash: res.hash, status: 'sent' }
	})
}

/** Reconcile a target that is pending, sent or uncertain. Reads chain state; never signs. */
export function reconcilePmGrant(deps: PmGrantDeps, targetIn: unknown): Promise<{ target: string; status: PmGrantStatus }> {
	return pmGrantSerial(async () => {
		const target = checkPmGrantTarget(targetIn, deps.pmAddress, deps.cfg)
		const state = readState(deps.statePath)
		const rec = state[target.toLowerCase()]
		if (!rec) throw denied('no grant record for this target')
		if (rec.status === 'confirmed' || rec.status === 'failed') return { target, status: rec.status }
		const hash = rec.hash ?? deps.journalHash(rec.idempotencyKey)
		let next: PmGrantStatus = rec.status
		if (BigInt(await deps.reader.call(PM_GRANT_VDR, IFACE.encodeFunctionData('admins', [target]))) === 1n) next = 'confirmed'
		else if (hash) {
			const r = await deps.reader.receipt(hash)
			if (r && r.status === '0x1') next = 'confirmed'
			else if (r && r.status === '0x0') next = 'failed'
		}
		state[target.toLowerCase()] = { ...rec, status: next, hash: hash ?? rec.hash }
		writeState(deps.statePath, state)
		deps.audit({ event: 'pm.grantAdmin.reconciled', target, status: next, hash: hash ?? null })
		return { target, status: next }
	})
}
