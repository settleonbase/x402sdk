/**
 * Owner-authorized one-shot: PM → VDR payout `0.1` CNET on CoNET 224422.
 *
 * Locked amount/from/to. Not Gas Keeper. Does not expand the recipient whitelist.
 * Production enable requires config.pmOneShot.enabled === true (default off) and
 * an independent project-owner vault-password proof on every execute RPC
 * (shared admin.sock ACL alone is not sufficient).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { getAddress } from 'ethers'
import type { AuditLog } from './audit'
import { ErrorCode, SignerError, denied } from './errors'
import { worstCaseNativeTransferGasWei, worstFeeWei } from './gasKeeper'
import type { Keyring } from './keyring'
import type { SendResult, TxManager } from './txManager'

export const PM_ONESHOT_CLIENT = 'pm-oneshot-tty'
export const PM_ONESHOT_METHOD = 'pm.oneshot.vdr-gas-0.1'
export const PM_ONESHOT_IDEMPOTENCY_KEY = 'vdr-pm-gas-topup-0.1cnet-2026-11-10'
export const PM_ONESHOT_CHAIN_ID = 224422
/** Locked: 0.1 CNET. */
export const PM_ONESHOT_VALUE_WEI = 100_000_000_000_000_000n
export const PM_ONESHOT_FROM = getAddress('0xc3d6d244c2833817210F6894C987fB129e731391')
export const PM_ONESHOT_TO = getAddress('0x22536672D28f1755f97271D8d1eA4a35cab15A45')
export const PM_ONESHOT_GAS_LIMIT = 21_000n

export type PmOneShotConfig = {
	/** Default false / omitted. Owner must flip on for the approved broadcast window. */
	enabled: boolean
	/**
	 * Wei ceiling for gasPrice / maxFeePerGas. Required whenever enabled is true.
	 * Example: `"2000000000"` = 2 gwei.
	 */
	maxGasPriceWei: string
}

export type PmOneShotState = {
	v: 1
	idempotencyKey: string
	chainId: number
	from: string
	to: string
	valueWei: string
	/** armed | sent | mined | refused | aborted | uncertain */
	status: string
	/** False after arm / uncertain submit — operator must not treat as safe resend. */
	safeToResend: boolean
	ownerAuthVerified?: boolean
	preflight?: Record<string, unknown>
	hash?: string
	nonce?: number
	updatedAt: string
	note?: string
}

export type PmOneShotChainReader = {
	getBalance(address: string): Promise<bigint>
	getTransactionCount(address: string, blockTag?: string): Promise<number>
	getCode(address: string): Promise<string>
	getFeeData(): Promise<{ gasPrice: bigint | null; maxFeePerGas: bigint | null }>
}

export function normalizePmOneShot(raw: unknown): PmOneShotConfig | undefined {
	if (raw == null) return undefined
	if (typeof raw !== 'object') throw new Error('config: pmOneShot must be an object')
	const o = raw as Record<string, unknown>
	const enabled = o.enabled === true
	const maxRaw = o.maxGasPriceWei
	if (enabled) {
		if (typeof maxRaw !== 'string' || !/^\d+$/.test(maxRaw) || BigInt(maxRaw) <= 0n) {
			throw new Error('config: pmOneShot.enabled requires positive integer maxGasPriceWei (wei string)')
		}
		return { enabled: true, maxGasPriceWei: maxRaw }
	}
	if (maxRaw !== undefined) {
		if (typeof maxRaw !== 'string' || !/^\d+$/.test(maxRaw)) {
			throw new Error('config: pmOneShot.maxGasPriceWei must be a wei integer string when set')
		}
		return { enabled: false, maxGasPriceWei: maxRaw }
	}
	return { enabled: false, maxGasPriceWei: '0' }
}

export function lockedPmOneShotParams(): Record<string, unknown> {
	return {
		chainId: PM_ONESHOT_CHAIN_ID,
		from: PM_ONESHOT_FROM,
		to: PM_ONESHOT_TO,
		valueWei: PM_ONESHOT_VALUE_WEI.toString(),
		valueHuman: '0.1 CNET',
		data: '0x',
		gasLimit: PM_ONESHOT_GAS_LIMIT.toString(),
		client: PM_ONESHOT_CLIENT,
		method: PM_ONESHOT_METHOD,
		idempotencyKey: PM_ONESHOT_IDEMPOTENCY_KEY,
		requiresOwnerVaultPassword: true,
		safeToResendRule: 'armed_or_uncertain_never_safe',
	}
}

export function loadPmOneShotState(path: string): PmOneShotState | null {
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as PmOneShotState
	} catch {
		return null
	}
}

function savePmOneShotState(path: string, state: PmOneShotState): void {
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 })
	renameSync(tmp, path)
}

export function pmOneShotStatus(path: string, enabled: boolean, maxGasPriceWei?: string): Record<string, unknown> {
	const state = loadPmOneShotState(path)
	return {
		enabled,
		maxGasPriceWei: maxGasPriceWei && maxGasPriceWei !== '0' ? maxGasPriceWei : null,
		lockedParams: lockedPmOneShotParams(),
		state,
		safeToResend: state ? state.safeToResend === true && !blocksResend(state) : true,
		note:
			'Execute RPC requires project-owner vault password on every call (admin.sock membership alone is insufficient). Do not delete state or journal on rollback.',
	}
}

function blocksResend(state: PmOneShotState): boolean {
	if (state.hash) return true
	if (state.status === 'sent' || state.status === 'mined' || state.status === 'uncertain') return true
	if (state.status === 'armed' && state.safeToResend === false) return true
	return false
}

/**
 * Abort local marker only when no hash and status is armed/refused/aborted.
 * Never deletes the state file or TxManager journal. Uncertain/sent/mined refuse abort.
 */
export function abortPmOneShotIfUnsent(path: string): Record<string, unknown> {
	const cur = loadPmOneShotState(path)
	if (!cur) return { aborted: false, reason: 'no-state' }
	if (cur.hash) {
		throw denied('oneshot already broadcast; on-chain rollback is impossible; do not resend', {
			hash: cur.hash,
			status: cur.status,
			safeToResend: false,
		})
	}
	if (cur.status === 'uncertain') {
		throw denied('oneshot submit is uncertain; do not abort for resend; investigate chain/journal; keep idempotency logs', {
			status: cur.status,
			safeToResend: false,
		})
	}
	if (cur.status === 'sent' || cur.status === 'mined') {
		throw denied('oneshot already terminal on marker; refuse abort', { status: cur.status, safeToResend: false })
	}
	const next: PmOneShotState = {
		...cur,
		status: 'aborted',
		safeToResend: false,
		updatedAt: new Date().toISOString(),
		note: 'aborted before broadcast; state file retained; journal not deleted; not marked safe to resend',
	}
	savePmOneShotState(path, next)
	return { aborted: true, state: next, safeToResend: false }
}

export async function runPmOneShotPreflight(opts: {
	reader: PmOneShotChainReader
	pmAddress: string
	maxGasPriceWei: bigint
}): Promise<Record<string, unknown>> {
	const from = getAddress(opts.pmAddress)
	if (from !== PM_ONESHOT_FROM) {
		throw denied('vault PM address does not match locked oneshot from', { livePm: from, expected: PM_ONESHOT_FROM })
	}
	const to = PM_ONESHOT_TO
	const [balance, noncePending, nonceLatest, code, fee] = await Promise.all([
		opts.reader.getBalance(from),
		opts.reader.getTransactionCount(from, 'pending'),
		opts.reader.getTransactionCount(from, 'latest'),
		opts.reader.getCode(to),
		opts.reader.getFeeData(),
	])
	const codeNorm = (code || '0x').toLowerCase()
	if (codeNorm !== '0x' && codeNorm !== '0x0') {
		throw denied('recipient has contract code; locked oneshot requires empty EOA code', { to, code: codeNorm.slice(0, 66) })
	}
	const worst = worstFeeWei(fee.gasPrice, fee.maxFeePerGas)
	if (worst !== undefined && worst > opts.maxGasPriceWei) {
		throw denied('market gas above maxGasPriceWei', {
			worstFeeWei: worst.toString(),
			maxGasPriceWei: opts.maxGasPriceWei.toString(),
		})
	}
	const gasReserve = worstCaseNativeTransferGasWei(fee.gasPrice, fee.maxFeePerGas) ?? PM_ONESHOT_GAS_LIMIT * opts.maxGasPriceWei
	const need = PM_ONESHOT_VALUE_WEI + gasReserve
	if (balance < need) {
		throw denied('PM balance below 0.1 CNET + gas reserve', {
			balance: balance.toString(),
			need: need.toString(),
			valueWei: PM_ONESHOT_VALUE_WEI.toString(),
			gasReserveWei: gasReserve.toString(),
		})
	}
	return {
		from,
		to,
		balanceWei: balance.toString(),
		needWei: need.toString(),
		gasReserveWei: gasReserve.toString(),
		noncePending,
		nonceLatest,
		recipientCode: '0x',
		gasPriceWei: fee.gasPrice?.toString() ?? null,
		maxFeePerGasWei: fee.maxFeePerGas?.toString() ?? null,
		maxGasPriceWei: opts.maxGasPriceWei.toString(),
		checkedAt: new Date().toISOString(),
	}
}

/**
 * Broadcast the locked transfer. Caller must already have verified owner vault password
 * (proveOwnerAuth) — this function does not accept or log secrets.
 */
export async function runPmOneShotVdrGas0_1(opts: {
	enabled: boolean
	maxGasPriceWei: string
	statePath: string
	unlocked: boolean
	ownerAuthVerified: boolean
	pmAddress: string
	keyring: Keyring
	txm: TxManager
	reader: PmOneShotChainReader
	audit: AuditLog
}): Promise<Record<string, unknown>> {
	if (!opts.enabled) {
		throw denied('pm oneshot entry is disabled; project-owner enable approval required before broadcast', {
			configKey: 'pmOneShot.enabled',
		})
	}
	if (!opts.ownerAuthVerified) {
		throw denied('project-owner authorization proof required; vault password must be verified server-side', {
			cmd: PM_ONESHOT_METHOD,
		})
	}
	if (!/^\d+$/.test(opts.maxGasPriceWei) || BigInt(opts.maxGasPriceWei) <= 0n) {
		throw denied('pmOneShot.maxGasPriceWei missing or invalid', { maxGasPriceWei: opts.maxGasPriceWei })
	}
	const maxGasPriceWei = BigInt(opts.maxGasPriceWei)
	if (!opts.unlocked) throw new SignerError(ErrorCode.LOCKED, 'vault locked; unlock on TTY first')
	if (!opts.keyring.unlocked) throw new SignerError(ErrorCode.LOCKED, 'keyring locked')

	const livePm = getAddress(opts.pmAddress)
	if (livePm !== PM_ONESHOT_FROM) {
		throw denied('vault PM address does not match locked oneshot from', { livePm, expected: PM_ONESHOT_FROM })
	}

	const existing = loadPmOneShotState(opts.statePath)
	if (existing && blocksResend(existing)) {
		opts.audit.write({
			event: 'pm.oneshot.dedupe',
			status: existing.status,
			hash: existing.hash ?? null,
			safeToResend: false,
		})
		throw denied('durable oneshot already recorded or uncertain; refusing second broadcast', {
			status: existing.status,
			hash: existing.hash ?? null,
			safeToResend: false,
			message: 'armed/uncertain/sent are not safe to resend; do not delete idempotency logs',
		})
	}

	const journalHit = opts.txm.get({ idempotencyKey: PM_ONESHOT_IDEMPOTENCY_KEY, client: PM_ONESHOT_CLIENT })
	if (journalHit && (journalHit.status === 'sent' || journalHit.status === 'mined' || journalHit.status === 'stuck')) {
		opts.audit.write({
			event: 'pm.oneshot.dedupe_journal',
			hash: journalHit.hash,
			status: journalHit.status,
			safeToResend: false,
		})
		throw denied('TxManager journal already has this oneshot; refusing duplicate payment', {
			hash: journalHit.hash,
			status: journalHit.status,
			safeToResend: false,
		})
	}

	const preflight = await runPmOneShotPreflight({
		reader: opts.reader,
		pmAddress: livePm,
		maxGasPriceWei,
	})

	const armed: PmOneShotState = {
		v: 1,
		idempotencyKey: PM_ONESHOT_IDEMPOTENCY_KEY,
		chainId: PM_ONESHOT_CHAIN_ID,
		from: PM_ONESHOT_FROM,
		to: PM_ONESHOT_TO,
		valueWei: PM_ONESHOT_VALUE_WEI.toString(),
		status: 'armed',
		safeToResend: false,
		ownerAuthVerified: true,
		preflight,
		nonce: Number(preflight.noncePending),
		updatedAt: new Date().toISOString(),
		note: 'armed after owner auth + preflight; not safe to resend if submit outcome is unclear',
	}
	savePmOneShotState(opts.statePath, armed)
	opts.audit.write({
		event: 'pm.oneshot.arm',
		idempotencyKey: PM_ONESHOT_IDEMPOTENCY_KEY,
		ownerAuthVerified: true,
		nonce: armed.nonce,
		safeToResend: false,
	})

	let result: SendResult
	try {
		result = await opts.txm.send({
			client: PM_ONESHOT_CLIENT,
			array: 'PM',
			chainId: PM_ONESHOT_CHAIN_ID,
			candidates: [PM_ONESHOT_FROM],
			from: PM_ONESHOT_FROM,
			to: PM_ONESHOT_TO,
			data: '0x',
			value: PM_ONESHOT_VALUE_WEI,
			gasLimit: PM_ONESHOT_GAS_LIMIT,
			maxGas: PM_ONESHOT_GAS_LIMIT,
			maxGasPriceWei,
			idempotencyKey: PM_ONESHOT_IDEMPOTENCY_KEY,
			maxInflightPerKey: 1,
			method: PM_ONESHOT_METHOD,
			args: [],
			skipSimulation: true,
			// Internal PM maintenance sends must not re-enter the post-sign auto-Gas hook.
			skipPostSignCheck: true,
		})
	} catch (e) {
		// After arm, any failure is treated as submit-uncertain: never mark safe to resend.
		const uncertain: PmOneShotState = {
			...armed,
			status: 'uncertain',
			safeToResend: false,
			updatedAt: new Date().toISOString(),
			note: `submit uncertain after arm: ${e instanceof Error ? e.message : String(e)}; investigate chain + journal; do not resend; do not delete state/journal`,
		}
		savePmOneShotState(opts.statePath, uncertain)
		opts.audit.write({
			event: 'pm.oneshot.uncertain',
			error: e instanceof Error ? e.message : String(e),
			idempotencyKey: PM_ONESHOT_IDEMPOTENCY_KEY,
			safeToResend: false,
		})
		throw e
	}

	const sent: PmOneShotState = {
		...armed,
		status: result.status === 'mined' ? 'mined' : 'sent',
		safeToResend: false,
		hash: result.hash,
		nonce: result.nonce,
		updatedAt: new Date().toISOString(),
		note: result.duplicate ? 'idempotent replay of prior send' : 'broadcast accepted by TxManager',
	}
	savePmOneShotState(opts.statePath, sent)
	opts.audit.write({
		event: 'pm.oneshot.sent',
		hash: result.hash,
		nonce: result.nonce,
		duplicate: result.duplicate === true,
		safeToResend: false,
	})
	return {
		ok: true,
		safeToResend: false,
		result: {
			hash: result.hash,
			from: result.from,
			nonce: result.nonce,
			chainId: result.chainId,
			status: result.status,
			idempotencyKey: result.idempotencyKey,
			duplicate: result.duplicate,
		},
		state: sent,
		lockedParams: lockedPmOneShotParams(),
		preflight,
	}
}
