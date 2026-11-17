import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { getAddress, isHexString } from 'ethers'
import { canonicalHash } from './canonical'
import { ErrorCode, SignerError } from './errors'

/**
 * Persistent replay guard for eth_signTypedData_v4.
 *
 * The key is the signing account only when the contract nonce mapping includes it,
 * plus the EIP-712 domain and the contract's actual nonce tuple. Client name, key-array
 * name, and any request idempotency key are not part of the key.
 *
 * Verified against BeamioUserCardFactoryPaymasterV07:
 * - ExecuteForAdmin: usedAdminExecuteNonces[keccak256(card, signer, nonce)]
 * - ExecuteForOwner: usedOwnerExecuteNonces[keccak256(card, nonce)]
 * - ClearAdminMintCounter: usedClearAdminMintCounterNonces[keccak256(card, subordinate, nonce)]
 *
 * The chain marks the nonce only after the deadline check. An expired reservation therefore
 * does not burn the nonce and may be replaced. Journals written before this file existed
 * have no reservations. Lines without namespace, contentHash, signature, and expiresAt are ignored.
 */
export type TypedDataNonceBinding = {
	id: string
	contentHash: string
	expiresAt: number
	primaryType: string
	signer: string
}

type ReplayRecord = TypedDataNonceBinding & { signature: string }

type ReserveFresh = {
	mode: 'fresh'
	token: symbol
	resolve: (signature: string) => void
	reject: (reason: unknown) => void
}
type ReserveReplay = { mode: 'replay'; signature: string }
type ReserveWait = { mode: 'wait'; promise: Promise<string> }

const VERIFIED = new Set(['ExecuteForAdmin', 'ExecuteForOwner', 'ClearAdminMintCounter'])

export function resolveTypedDataNonce(
	signer: string,
	domain: Record<string, unknown>,
	primaryType: string,
	message: Record<string, unknown>,
): TypedDataNonceBinding | null {
	if (!VERIFIED.has(primaryType)) return null
	const signerAddress = getAddress(signer)
	const domainId = {
		name: requiredString(domain.name, 'domain.name'),
		version: requiredString(domain.version, 'domain.version'),
		chainId: Number(domain.chainId),
		verifyingContract: getAddress(requiredString(domain.verifyingContract, 'domain.verifyingContract')),
		...(domain.salt != null ? { salt: String(domain.salt) } : {}),
	}
	const deadline = BigInt(message.deadline as string | number | bigint)
	const expiresAt = Number(deadline)
	const nonce = bytes32(message.nonce, 'nonce')
	const cardAddress = getAddress(requiredString(message.cardAddress, 'cardAddress'))
	const scope: Record<string, unknown> = {
		primaryType,
		...domainId,
		cardAddress,
		nonce,
	}
	if (primaryType === 'ExecuteForAdmin') scope.signer = signerAddress
	if (primaryType === 'ClearAdminMintCounter') {
		scope.subordinate = getAddress(requiredString(message.subordinate, 'subordinate'))
	}
	const contentHash = canonicalHash({
		domain: domainId,
		message: normalizeMessage(message),
		signer: signerAddress,
	})
	return { id: canonicalHash(scope), contentHash, expiresAt, primaryType, signer: signerAddress }
}

export class TypedDataReplayLog {
	private records = new Map<string, ReplayRecord>()
	private pending = new Map<string, { token: symbol; contentHash: string; promise: Promise<string> }>()

	constructor(private readonly path: string) {
		this.load()
	}

	reserve(binding: TypedDataNonceBinding): ReserveFresh | ReserveReplay | ReserveWait {
		const now = Math.floor(Date.now() / 1000)
		const existing = this.records.get(binding.id)
		if (existing && existing.expiresAt > now) {
			if (existing.contentHash !== binding.contentHash) throw differentContent()
			return { mode: 'replay', signature: existing.signature }
		}
		if (existing) this.records.delete(binding.id)
		const inflight = this.pending.get(binding.id)
		if (inflight) {
			if (inflight.contentHash !== binding.contentHash) throw differentContent()
			return { mode: 'wait', promise: inflight.promise }
		}
		let resolve!: (signature: string) => void
		let reject!: (reason: unknown) => void
		const promise = new Promise<string>((res, rej) => {
			resolve = res
			reject = rej
		})
		const token = Symbol('typed-data-replay')
		this.pending.set(binding.id, { token, contentHash: binding.contentHash, promise })
		return { mode: 'fresh', token, resolve, reject }
	}

	commit(binding: TypedDataNonceBinding, token: symbol, signature: string): void {
		const inflight = this.pending.get(binding.id)
		if (!inflight || inflight.token !== token) return
		this.pending.delete(binding.id)
		const row: ReplayRecord = { ...binding, signature }
		this.records.set(binding.id, row)
		appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o640 })
	}

	abort(id: string, token: symbol): void {
		const inflight = this.pending.get(id)
		if (inflight?.token === token) this.pending.delete(id)
	}

	private load(): void {
		if (!existsSync(this.path)) return
		for (const line of readFileSync(this.path, 'utf8').split('\n')) {
			if (!line.trim()) continue
			try {
				const row = JSON.parse(line) as Partial<ReplayRecord>
				if (!row.id || !row.contentHash || !row.signature || typeof row.expiresAt !== 'number' || !row.signer || !row.primaryType) continue
				this.records.set(row.id, row as ReplayRecord)
			} catch {
				/* torn or pre-migration line */
			}
		}
	}
}

function differentContent(): SignerError {
	return new SignerError(ErrorCode.POLICY_DENIED, 'typed data nonce already reserved for different content')
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new SignerError(ErrorCode.INVALID_PARAMS, `typed data ${name} is required`)
	}
	return value
}

function bytes32(value: unknown, name: string): string {
	const raw = requiredString(value, name)
	if (!isHexString(raw, 32)) throw new SignerError(ErrorCode.INVALID_PARAMS, `typed data ${name} must be bytes32`)
	return raw.toLowerCase()
}

function normalizeMessage(message: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(message)) {
		const value = message[key]
		if (typeof value === 'bigint') out[key] = value.toString()
		else if (typeof value === 'string' && value.startsWith('0x')) out[key] = value.toLowerCase()
		else out[key] = value
	}
	if (typeof out.cardAddress === 'string') out.cardAddress = getAddress(out.cardAddress)
	if (typeof out.subordinate === 'string') out.subordinate = getAddress(out.subordinate)
	return out
}
