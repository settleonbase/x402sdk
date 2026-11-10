/**
 * wallet-signer client: RemoteSigner (ethers v6 AbstractSigner) + JSON-RPC transport.
 *
 * Canonical copy: x402sdk src/walletSigner/remoteSigner.ts. CoNET-DL vendors an identical copy;
 * keep them in sync (only ethers + node built-ins, no other deps).
 *
 * Private keys never reach this process. `sendTransaction` asks the signer service to pick nonce,
 * fees, sign and broadcast (managed mode); the daemon only waits for the receipt.
 *
 * Env (daemon side):
 *   WALLET_SIGNER_URL        https://<signer-host>[:port]  or  unix:/run/wallet-signer/<name>.sock
 *   WALLET_SIGNER_CERT       client certificate (PEM)            — https only
 *   WALLET_SIGNER_KEY        client certificate private key (PEM) — https only
 *   WALLET_SIGNER_CA         CA that signed the signer's server certificate (private CA).
 *                            Leave unset when the server uses a public certificate (Let's Encrypt
 *                            behind nginx): Node's built-in root store is used then.
 *   WALLET_SIGNER_TOKEN_FILE optional bearer token file (second factor)
 *   WALLET_SIGNER_FEATURES   comma list of features switched to the signer, e.g. "chat,gbAirdrop,settle"
 */
import { readFileSync } from 'node:fs'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import {
	AbstractSigner,
	Transaction,
	TransactionResponse,
	TypedDataEncoder,
	getAddress,
	hexlify,
	makeError,
	resolveAddress,
	toUtf8Bytes,
	type Provider,
	type TransactionReceipt,
	type TransactionRequest,
	type TypedDataDomain,
	type TypedDataField,
} from 'ethers'

export const SignerCode = {
	LOCKED: -32001,
	UNAUTHORIZED: -32002,
	POLICY_DENIED: -32003,
	RATE_LIMITED: -32004,
	NO_IDLE_KEY: -32005,
	GAS_PRICE_TOO_HIGH: -32006,
	EXECUTION_REVERTED: -32007,
	NOT_FOUND: -32009,
	REGISTRY_MISMATCH: -32010,
	UPSTREAM: -32011,
	/** Client side: signer unreachable / TLS failure / timeout. */
	UNREACHABLE: -32099,
} as const

const RETRYABLE = new Set<number>([
	SignerCode.LOCKED,
	SignerCode.RATE_LIMITED,
	SignerCode.NO_IDLE_KEY,
	SignerCode.GAS_PRICE_TOO_HIGH,
	SignerCode.UPSTREAM,
	SignerCode.REGISTRY_MISMATCH,
	SignerCode.UNREACHABLE,
])

export class WalletSignerError extends Error {
	readonly signerCode: number
	readonly data?: unknown
	constructor(code: number, message: string, data?: unknown) {
		super(message)
		this.name = 'WalletSignerError'
		this.signerCode = code
		this.data = data
	}
	/** True when nothing was broadcast and the same request may be retried later. */
	get retryable(): boolean {
		return RETRYABLE.has(this.signerCode)
	}
}

/** True for "signer not available right now" errors (locked, busy, unreachable, rate limit). */
export function isSignerUnavailable(e: unknown): boolean {
	return e instanceof WalletSignerError && e.retryable
}

export function walletSignerFeatureEnabled(feature: string): boolean {
	const list = (process.env.WALLET_SIGNER_FEATURES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
	return list.includes(feature) || list.includes('all')
}

export type WalletSignerClientOptions = {
	url: string
	cert?: string | Buffer
	key?: string | Buffer
	/** Private CA for the server certificate. Omit to verify against Node's public root store. */
	ca?: string | Buffer
	token?: string
	timeoutMs?: number
	/** TLS servername override (defaults to the URL host). */
	servername?: string
}

const IDLE_SOCKET_MS = 4_000

class StaleSocketError extends Error {}

export class WalletSignerClient {
	private readonly opts: WalletSignerClientOptions
	private readonly agent: HttpsAgent | HttpAgent
	private nextId = 1

	constructor(opts: WalletSignerClientOptions) {
		this.opts = opts
		// Idle sockets are dropped after 4 s, before the server's 5 s keep-alive timeout closes them.
		if (opts.url.startsWith('unix:')) {
			this.agent = new HttpAgent({ keepAlive: true, timeout: IDLE_SOCKET_MS })
		} else {
			if (!opts.cert || !opts.key) throw new Error('wallet-signer: client cert and key are required for https')
			// Server verification is always on: a private CA if given, otherwise the public roots.
			this.agent = new HttpsAgent({
				keepAlive: true,
				timeout: IDLE_SOCKET_MS,
				cert: opts.cert,
				key: opts.key,
				...(opts.ca ? { ca: opts.ca } : {}),
				rejectUnauthorized: true,
				minVersion: 'TLSv1.3',
			})
		}
	}

	static fromEnv(env: NodeJS.ProcessEnv = process.env): WalletSignerClient {
		const url = env.WALLET_SIGNER_URL?.trim()
		if (!url) throw new Error('WALLET_SIGNER_URL not set')
		const read = (p?: string) => (p ? readFileSync(p) : undefined)
		const token = env.WALLET_SIGNER_TOKEN_FILE ? readFileSync(env.WALLET_SIGNER_TOKEN_FILE, 'utf8').trim() : undefined
		return new WalletSignerClient({
			url,
			cert: read(env.WALLET_SIGNER_CERT),
			key: read(env.WALLET_SIGNER_KEY),
			ca: read(env.WALLET_SIGNER_CA),
			token,
			servername: env.WALLET_SIGNER_SERVERNAME,
			timeoutMs: env.WALLET_SIGNER_TIMEOUT_MS ? Number(env.WALLET_SIGNER_TIMEOUT_MS) : undefined,
		})
	}

	/**
	 * A request on a reused keep-alive socket can hit a socket the server just closed (ECONNRESET
	 * before any byte was read). Such a request is retried once on a fresh socket, except a
	 * transaction without an idempotency key.
	 */
	async call<T = unknown>(method: string, params: unknown): Promise<T> {
		try {
			return await this.callOnce<T>(method, params)
		} catch (e) {
			const retryable = method !== 'signer_sendTransaction' || Boolean((params as { idempotencyKey?: string } | null)?.idempotencyKey)
			if (e instanceof StaleSocketError && retryable) return this.callOnce<T>(method, params)
			if (e instanceof StaleSocketError) throw new WalletSignerError(SignerCode.UNREACHABLE, e.message)
			throw e
		}
	}

	private callOnce<T>(method: string, params: unknown): Promise<T> {
		const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
		const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
		if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`
		const timeout = this.opts.timeoutMs ?? 60_000
		return new Promise<T>((resolve, reject) => {
			const onRes = (res: import('node:http').IncomingMessage) => {
				const chunks: Buffer[] = []
				res.on('data', (c: Buffer) => chunks.push(c))
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8')
					let parsed: { result?: T; error?: { code: number; message: string; data?: unknown } }
					try {
						parsed = JSON.parse(text)
					} catch {
						return reject(new WalletSignerError(SignerCode.UNREACHABLE, `wallet-signer HTTP ${res.statusCode}: bad response`))
					}
					if (parsed.error) return reject(new WalletSignerError(parsed.error.code, parsed.error.message, parsed.error.data))
					if (res.statusCode !== 200) return reject(new WalletSignerError(SignerCode.UNREACHABLE, `wallet-signer HTTP ${res.statusCode}`))
					resolve(parsed.result as T)
				})
			}
			let req
			if (this.opts.url.startsWith('unix:')) {
				req = httpRequest({ socketPath: this.opts.url.slice(5), path: '/rpc', method: 'POST', headers, agent: this.agent, timeout }, onRes)
			} else {
				const u = new URL(this.opts.url)
				req = httpsRequest(
					{
						host: u.hostname,
						port: u.port || 443,
						path: '/rpc',
						method: 'POST',
						headers,
						agent: this.agent as HttpsAgent,
						servername: this.opts.servername ?? u.hostname,
						timeout,
					},
					onRes,
				)
			}
			req.on('timeout', () => req.destroy(new Error('timeout')))
			req.on('error', (e: NodeJS.ErrnoException) => {
				const msg = `wallet-signer unreachable: ${e.message}`
				reject(req.reusedSocket && (e.code === 'ECONNRESET' || e.code === 'EPIPE') ? new StaleSocketError(msg) : new WalletSignerError(SignerCode.UNREACHABLE, msg))
			})
			req.end(body)
		})
	}

	status(): Promise<{ state: string; version: string; arrays: string[]; compromised: string[] }> {
		return this.call('signer_status', {})
	}

	accounts(keyArray: string, chainId?: number): Promise<string[]> {
		return this.call('signer_accounts', { keyArray, chainId })
	}

	compromised(): Promise<string[]> {
		return this.call('signer_compromised', {})
	}

	getTransaction(q: { idempotencyKey?: string; hash?: string }): Promise<ManagedTxRecord | null> {
		return this.call('signer_getTransaction', q)
	}

	close(): void {
		this.agent.destroy()
	}
}

export type ManagedTxRecord = {
	hash: string
	hashes: string[]
	from: string
	nonce: number
	chainId: number
	status: 'sent' | 'mined' | 'reverted' | 'stuck'
	blockNumber?: number
	idempotencyKey?: string
}

type SendResult = { hash: string; from: string; nonce: number; chainId: number; status: string; raw: string; duplicate?: boolean }

export type RemoteSignerOptions = {
	keyArray: string
	chainId: number
	/** Pin one key of the array. Without it the service picks the least busy key. */
	address?: string
	/** Sent with every transaction; the service returns the first result for a repeated key. */
	idempotencyKey?: string
}

/**
 * ethers Signer backed by wallet-signer. Use `.withIdempotencyKey(k)` per job so retries never
 * double-send, e.g. `new Contract(addr, abi, signer.withIdempotencyKey('epoch:123'))`.
 */
export class RemoteSigner extends AbstractSigner {
	readonly client: WalletSignerClient
	readonly options: RemoteSignerOptions
	/** Same as getAddress() for pinned signers; mirrors ethers.Wallet#address. */
	readonly address: string

	constructor(client: WalletSignerClient, options: RemoteSignerOptions, provider?: Provider | null) {
		super(provider ?? null)
		this.client = client
		this.options = { ...options, address: options.address ? getAddress(options.address) : undefined }
		this.address = this.options.address ?? ''
	}

	connect(provider: Provider | null): RemoteSigner {
		return new RemoteSigner(this.client, this.options, provider)
	}

	withIdempotencyKey(idempotencyKey: string): RemoteSigner {
		return new RemoteSigner(this.client, { ...this.options, idempotencyKey }, this.provider)
	}

	async getAddress(): Promise<string> {
		if (this.options.address) return this.options.address
		const list = await this.client.accounts(this.options.keyArray, this.options.chainId)
		if (!list[0]) throw new WalletSignerError(SignerCode.POLICY_DENIED, `no keys in ${this.options.keyArray}`)
		return getAddress(list[0])
	}

	async signTransaction(tx: TransactionRequest): Promise<string> {
		const pop = await this.populateTransaction(tx)
		const t = Transaction.from({ ...pop, from: undefined } as never)
		return this.client.call<string>('eth_signTransaction', [{ ...t.toJSON(), from: await this.getAddress(), chainId: Number(t.chainId) }])
	}

	async signMessage(message: string | Uint8Array): Promise<string> {
		const hex = typeof message === 'string' ? hexlify(toUtf8Bytes(message)) : hexlify(message)
		return this.client.call<string>('personal_sign', [hex, await this.getAddress()])
	}

	async signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string> {
		const resolved = await TypedDataEncoder.resolveNames(domain, types, value, async (name: string) => resolveAddress(name, this.provider))
		const payload = TypedDataEncoder.getPayload(resolved.domain, types, resolved.value)
		return this.client.call<string>('eth_signTypedData_v4', [await this.getAddress(), payload])
	}

	/** Managed send: the service assigns nonce/fees, signs and broadcasts. */
	async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
		const provider = this.provider
		if (!provider) throw new Error('RemoteSigner: provider required to send')
		if (tx.to == null) throw new WalletSignerError(SignerCode.POLICY_DENIED, 'contract creation not supported')
		const to = await resolveAddress(tx.to, provider)
		const res = await this.client.call<SendResult>('signer_sendTransaction', {
			keyArray: this.options.keyArray,
			chainId: this.options.chainId,
			from: this.options.address,
			to,
			data: tx.data ? hexlify(tx.data) : '0x',
			value: tx.value != null ? BigInt(tx.value).toString() : '0',
			gasLimit: tx.gasLimit != null ? BigInt(tx.gasLimit).toString() : undefined,
			idempotencyKey: this.options.idempotencyKey,
		})
		return new ManagedTransactionResponse(responseParams(res.raw), provider, this.client)
	}
}

function responseParams(raw: string): ConstructorParameters<typeof TransactionResponse>[0] {
	const t = Transaction.from(raw)
	return {
		blockNumber: null,
		blockHash: null,
		hash: t.hash!,
		index: 0,
		type: t.type ?? 0,
		to: t.to,
		from: t.from!,
		nonce: t.nonce,
		gasLimit: t.gasLimit,
		gasPrice: t.gasPrice ?? t.maxFeePerGas ?? 0n,
		maxPriorityFeePerGas: t.maxPriorityFeePerGas,
		maxFeePerGas: t.maxFeePerGas,
		maxFeePerBlobGas: null,
		data: t.data,
		value: t.value,
		chainId: t.chainId,
		signature: t.signature!,
		accessList: t.accessList,
		blobVersionedHashes: null,
		authorizationList: null,
	}
}

/**
 * The service may re-price a slow tx (same nonce, new hash). ethers' default wait() would then wait
 * on the old hash forever, so wait() asks the service which hash finally landed.
 */
export class ManagedTransactionResponse extends TransactionResponse {
	private readonly signerClient: WalletSignerClient

	constructor(params: ConstructorParameters<typeof TransactionResponse>[0], provider: Provider, client: WalletSignerClient) {
		super(params, provider)
		this.signerClient = client
	}

	async wait(confirms?: number, timeout?: number): Promise<null | TransactionReceipt> {
		const deadline = timeout ? Date.now() + timeout : Infinity
		const want = confirms ?? 1
		let hashes = [this.hash]
		for (;;) {
			let rec: ManagedTxRecord | null = null
			try {
				rec = await this.signerClient.getTransaction({ hash: this.hash })
			} catch {
				/* signer unreachable: fall back to the chain */
			}
			if (rec) hashes = rec.hashes?.length ? rec.hashes : [rec.hash]
			if (rec && rec.status === 'stuck') {
				throw makeError('transaction nonce consumed by another transaction', 'TRANSACTION_REPLACED', {
					cancelled: true,
					reason: 'replaced',
					replacement: null as never,
					hash: this.hash,
					receipt: null as never,
				})
			}
			for (const h of rec && rec.status !== 'sent' ? [rec.hash] : hashes) {
				const receipt = await this.provider.getTransactionReceipt(h)
				if (!receipt) continue
				if (want > 1 && (await receipt.confirmations()) < want) continue
				if (receipt.status === 0) {
					throw makeError('transaction execution reverted', 'CALL_EXCEPTION', {
						action: 'sendTransaction',
						data: null,
						reason: null,
						invocation: null,
						revert: null,
						transaction: { to: receipt.to, from: receipt.from, data: '' },
						receipt,
					})
				}
				return receipt
			}
			if (Date.now() > deadline) throw makeError('wait for transaction timeout', 'TIMEOUT', { operation: 'wait', reason: 'timeout', timeout: timeout ?? 0 } as never)
			await new Promise((r) => setTimeout(r, 1000))
		}
	}
}

/** A fixed set of pinned RemoteSigners for one key array (one job per key at a time). */
export class RemoteKeyArrayPool {
	private idle: RemoteSigner[] = []
	private all: RemoteSigner[] = []
	private ready?: Promise<void>

	constructor(
		readonly client: WalletSignerClient,
		readonly keyArray: string,
		readonly chainId: number,
		readonly provider: Provider,
	) {}

	init(): Promise<void> {
		if (!this.ready) {
			this.ready = this.client.accounts(this.keyArray, this.chainId).then((addrs) => {
				this.all = addrs.map((address) => new RemoteSigner(this.client, { keyArray: this.keyArray, chainId: this.chainId, address }, this.provider))
				this.idle = [...this.all]
			})
			this.ready.catch(() => {
				this.ready = undefined
			})
		}
		return this.ready
	}

	get size(): number {
		return this.all.length
	}

	get addresses(): string[] {
		return this.all.map((s) => s.address)
	}

	hasIdle(): boolean {
		return this.idle.length > 0
	}

	acquire(): RemoteSigner | undefined {
		return this.idle.shift()
	}

	release(s: RemoteSigner): void {
		const base = this.all.find((x) => x.address === s.address)
		if (base && !this.idle.includes(base)) this.idle.push(base)
	}
}

// ---------------------------------------------------------------------------
// Role reconciliation: grant new keys first, revoke leaked ones after; idempotent from chain state.
// ---------------------------------------------------------------------------

export type PlanStep = { chainId: number; to: string; data: string; call: string; signer: string; note: string }

export type RoleState = 'MISSING_GRANT' | 'GRANTED' | 'REVOKING' | 'CLEAN'

export type RoleReport = {
	id: string
	state: RoleState
	granted: string[]
	missing: string[]
	leakedHolding: string[]
	/** Steps someone else must sign (owner / existing admin). */
	externalPlan: PlanStep[]
}

export function summarizeRole(id: string, granted: string[], missing: string[], leakedHolding: string[], externalPlan: PlanStep[]): RoleReport {
	const state: RoleState = granted.length === 0 ? 'MISSING_GRANT' : leakedHolding.length > 0 ? 'REVOKING' : missing.length > 0 ? 'GRANTED' : 'CLEAN'
	return { id, state, granted, missing, leakedHolding, externalPlan }
}
