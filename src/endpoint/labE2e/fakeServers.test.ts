/**
 * P2c-0 test fixture (NOT part of the production build: *.test.ts is excluded by tsconfig; HTTP and unix sockets only, no WebSocket).
 * Three fake services that a REAL, unmodified Lab payout reporter talks to through its environment variables:
 *   FakeChain   an HTTP JSON-RPC server with a scripted in-memory chain (blocks with withdrawals, the VDR's three read functions, receipts, balance, gas),
 *   FakeBeacon  an HTTP REST server for /eth/v1/beacon/states/head/validators/<i>,
 *   FakeSigner  an HTTP-over-unix-socket server with the signer's idempotency semantics (same key + same request = the original hash, same key + other request = refused).
 * They model the behaviour the reporter relies on; they prove "the same before and after a refactor", not "the same as the real chain and signer".
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { ethers } from 'ethers'

export const REDEEM = '0xc71e246DD78B37C2fABc905D340932F28F503433'
export const POOL = '0x32bE583C8e778FFfC5107BF34820c2B225336201'
export const SIGNER_ADDRESS = '0x00000000000000000000000000000000000a11ce'
export const KEY_ARRAY = 'lab_e2e_payout'
const WITHDRAW_NATIVE_IFACE = new ethers.Interface(['function withdrawNative(address pool, uint256 amount)'])
const VDR_IFACE = new ethers.Interface([
	'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
	'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
	'function consumedRewardEventKey(bytes32 key) view returns (bool)',
])

export type Withdrawal = { index: number; validatorIndex: number; address: string; amountGwei: bigint }
export type SentTx = { eventKeys: string[]; hash: string; idempotencyKey: string; to: string; data: string; value: string; gasLimit: string; keyArray: string; chainId: number; amountWei: bigint; status: 0 | 1 | null; mined: boolean }

const hex = (n: number | bigint): string => '0x' + BigInt(n).toString(16)
const hash32 = (s: string): string => ethers.keccak256(ethers.toUtf8Bytes(s))

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => chunks.push(c))
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

// ------------------------------------------------------------------ chain
export class FakeChain {
	head = 0
	gasPriceWei = 1_000_000n
	priorityWei: bigint | null = 1_000n
	baseFeeWei = 400_000n
	/** Balance of the redeem contract (must cover each batch). */
	balanceWei = 10n ** 24n
	withdrawals = new Map<number, Withdrawal[]>()
	/** validator index -> guardian id (0 = none) and guardian id -> beneficiary. */
	guardianOf = new Map<string, bigint>()
	beneficiaryOf = new Map<string, string>()
	consumedOnChain = new Set<string>()
	sent = new Map<string, SentTx>()
	/** What a receipt request returns for a hash: decided by a rule so scenarios can delay, lose or revert. */
	receiptRule: (tx: SentTx, askCount: number) => 'mined' | 'none' | 'reverted' = () => 'mined'
	receiptAsks = new Map<string, number>()
	/** Counted on the chain side (not by a test hook): receipt asks answered with "no receipt yet". */
	emptyReceipts = 0
	rpcLog: string[] = []
	/** Highest number of JSON-RPC requests being handled at the same moment (counted here, on the chain side). */
	maxConcurrentRpc = 0
	/** Withdrawals for a block that has none in the explicit map (deterministic synthetic load, P4 measurements). */
	withdrawalGen?: (n: number) => Withdrawal[]
	private autoHeadTimer?: ReturnType<typeof setInterval>
	private rpcInProgress = 0
	unknownMethods: string[] = []
	/** Called on every request (fault injection: delay, kill, 5xx). Return a status to short-circuit. */
	onRequest?: (method: string, params: unknown[]) => Promise<void | { status: number }>
	/** The head per tick (set by the scenario); the child asks for the next one over HTTP at the start of every scheduled tick (/e2e/tick), so the head never depends on how many RPC calls a tick makes. */
	tickHeads: number[] = []
	tickIndex = 0
	private server?: http.Server
	url = ''

	blockHash(n: number): string {
		return hash32(`block:${n}`)
	}
	private blockObj(n: number): Record<string, unknown> {
		const w = this.withdrawals.get(n) ?? this.withdrawalGen?.(n) ?? []
		return {
			number: hex(n),
			hash: this.blockHash(n),
			parentHash: n > 0 ? this.blockHash(n - 1) : ethers.ZeroHash,
			timestamp: hex(1_700_000_000 + n * 2),
			nonce: '0x0000000000000000',
			difficulty: '0x0',
			gasLimit: hex(30_000_000),
			gasUsed: '0x0',
			miner: ethers.ZeroAddress,
			extraData: '0x',
			baseFeePerGas: hex(this.baseFeeWei),
			mixHash: ethers.ZeroHash,
			transactions: [],
			uncles: [],
			sha3Uncles: ethers.ZeroHash,
			stateRoot: ethers.ZeroHash,
			receiptsRoot: ethers.ZeroHash,
			transactionsRoot: ethers.ZeroHash,
			logsBloom: '0x' + '00'.repeat(256),
			size: '0x100',
			withdrawals: w.map((x) => ({ index: hex(x.index), validatorIndex: hex(x.validatorIndex), address: x.address, amount: hex(x.amountGwei) })),
			withdrawalsRoot: ethers.ZeroHash,
		}
	}
	private receiptObj(tx: SentTx, status: 0 | 1): Record<string, unknown> {
		return {
			to: tx.to,
			from: SIGNER_ADDRESS,
			contractAddress: null,
			transactionIndex: '0x0',
			gasUsed: hex(60_000),
			logsBloom: '0x' + '00'.repeat(256),
			blockHash: this.blockHash(this.head),
			transactionHash: tx.hash,
			logs: [],
			blockNumber: hex(this.head),
			cumulativeGasUsed: hex(60_000),
			effectiveGasPrice: hex(this.gasPriceWei),
			status: hex(status),
			type: '0x2',
		}
	}
	private async handleRpc(method: string, params: unknown[]): Promise<unknown> {
		this.rpcLog.push(method)
		switch (method) {
			case 'eth_chainId':
				return hex(224422)
			case 'net_version':
				return '224422'
			case 'eth_blockNumber':
				return hex(this.head)
			case 'eth_getBlockByNumber': {
				const tag = String(params[0])
				const n = tag === 'latest' || tag === 'pending' ? this.head : Number(BigInt(tag))
				if (n > this.head) return null
				return this.blockObj(n)
			}
			case 'eth_getBalance':
				return hex(this.balanceWei)
			case 'eth_gasPrice':
				return hex(this.gasPriceWei)
			case 'eth_maxPriorityFeePerGas':
				if (this.priorityWei === null) throw Object.assign(new Error('method not found'), { code: -32601 })
				return hex(this.priorityWei)
			case 'eth_call': {
				const call = params[0] as { to?: string; data?: string }
				const data = String(call.data ?? '')
				const sel = data.slice(0, 10).toLowerCase()
				const parsed = VDR_IFACE.parseTransaction({ data })
				if (!parsed) throw new Error(`eth_call: unknown selector ${sel}`)
				if (parsed.name === 'getNodeByValidatorPubkeyHash') return VDR_IFACE.encodeFunctionResult('getNodeByValidatorPubkeyHash', [this.guardianOf.get(String(parsed.args[0]).toLowerCase()) ?? 0n])
				if (parsed.name === 'guardianIdBeneficiary') return VDR_IFACE.encodeFunctionResult('guardianIdBeneficiary', [this.beneficiaryOf.get(String(parsed.args[0])) ?? ethers.ZeroAddress])
				return VDR_IFACE.encodeFunctionResult('consumedRewardEventKey', [this.consumedOnChain.has(String(parsed.args[0]).toLowerCase())])
			}
			case 'eth_getTransactionReceipt': {
				const h = String(params[0]).toLowerCase()
				const tx = this.sent.get(h)
				if (!tx) return null
				const ask = (this.receiptAsks.get(h) ?? 0) + 1
				this.receiptAsks.set(h, ask)
				const rule = this.receiptRule(tx, ask)
				if (rule === 'none') {
					this.emptyReceipts++
					return null
				}
				const status: 0 | 1 = rule === 'reverted' ? 0 : 1
				tx.status = status
				tx.mined = true
				return this.receiptObj(tx, status)
			}
			default:
				this.unknownMethods.push(method)
				throw Object.assign(new Error(`method ${method} not available in the fake chain`), { code: -32601 })
		}
	}
	async start(): Promise<void> {
		this.server = http.createServer(async (req, res) => {
			this.rpcInProgress++
			this.maxConcurrentRpc = Math.max(this.maxConcurrentRpc, this.rpcInProgress)
			res.on('close', () => void this.rpcInProgress--)
			if ((req.url ?? '').startsWith('/e2e/tick')) {
				this.tickIndex++
				if (this.tickHeads.length > 0) this.head = this.tickHeads[Math.min(this.tickIndex, this.tickHeads.length - 1)]!
				res.end(JSON.stringify({ tick: this.tickIndex, head: this.head }))
				return
			}
			try {
				const body = JSON.parse(await readBody(req)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[]
				const one = async (q: { id: number; method: string; params: unknown[] }): Promise<Record<string, unknown>> => {
					const short = await this.onRequest?.(q.method, q.params ?? [])
					if (short) return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: `injected ${short.status}` } }
					try {
						return { jsonrpc: '2.0', id: q.id, result: await this.handleRpc(q.method, q.params ?? []) }
					} catch (e) {
						const err = e as { code?: number; message?: string }
						return { jsonrpc: '2.0', id: q.id, error: { code: err.code ?? -32000, message: err.message ?? 'error' } }
					}
				}
				const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify(out))
			} catch {
				res.statusCode = 400
				res.end('bad request')
			}
		})
		await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
		this.url = `http://127.0.0.1:${(this.server!.address() as net.AddressInfo).port}`
	}
	/** The head grows by one block every intervalMs of real time (a chain that keeps producing while the daemon works). */
	startAutoHead(intervalMs: number): void {
		this.autoHeadTimer = setInterval(() => void this.head++, intervalMs)
	}
	async stop(): Promise<void> {
		if (this.autoHeadTimer) clearInterval(this.autoHeadTimer)
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
	}
	/** Add a withdrawal to the proxy address in block n. */
	addWithdrawal(n: number, w: { index: number; validatorIndex: number; amountGwei: bigint; address?: string }): void {
		const list = this.withdrawals.get(n) ?? []
		list.push({ index: w.index, validatorIndex: w.validatorIndex, address: w.address ?? REDEEM, amountGwei: w.amountGwei })
		this.withdrawals.set(n, list)
	}
}

// ------------------------------------------------------------------ beacon
export class FakeBeacon {
	validators = new Map<number, { pubkey: string; status: string }>()
	failIndexes = new Set<number>()
	requests: number[] = []
	private server?: http.Server
	url = ''
	async start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			const m = /\/eth\/v1\/beacon\/states\/head\/validators\/(\d+)$/.exec(req.url ?? '')
			if (!m) {
				res.statusCode = 404
				res.end('{}')
				return
			}
			const i = Number(m[1])
			this.requests.push(i)
			if (this.failIndexes.has(i)) {
				res.statusCode = 503
				res.end('{}')
				return
			}
			const v = this.validators.get(i)
			if (!v) {
				res.statusCode = 404
				res.end('{}')
				return
			}
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify({ data: { index: String(i), status: v.status, validator: { pubkey: v.pubkey } } }))
		})
		await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
		this.url = `http://127.0.0.1:${(this.server!.address() as net.AddressInfo).port}`
	}
	async stop(): Promise<void> {
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
	}
}

// ------------------------------------------------------------------ signer
export type SignerRequest = { method: string; params: Record<string, unknown> | undefined }
export class FakeSigner {
	requests: SignerRequest[] = []
	byKey = new Map<string, { fingerprint: string; hash: string }>()
	/** 'ok', 'reject' (never broadcast, signer refuses), 'lose-ack' (records the tx, then drops the connection without answering), 'down'. */
	mode: 'ok' | 'reject' | 'lose-ack' | 'down' = 'ok'
	/** How many times a connection was REALLY dropped without an answer in 'lose-ack' mode (a hook that sets the mode too late or resets it too early shows up as 0). */
	acksLost = 0
	/** Counted on the signer side: a send repeated with an idempotency key it already recorded (answered with the original hash), and signer_getTransaction lookups. */
	duplicateSends = 0
	getTransactionCalls = 0
	/** Fault injection hooks, called before / after the signer records a send. */
	beforeRecord?: (tx: Record<string, unknown>) => void
	afterRecord?: (tx: Record<string, unknown>, hash: string) => void
	/** Reads the event keys of the batch behind a send from the daemon's persisted in-flight record (the intent is persisted before the send). Set by the harness. */
	eventKeysOf?: (idempotencyKey: string) => string[]
	private server?: http.Server
	private counter = 0
	socketPath = ''
	/** The address this signer answers to signer_getAddress (P4 pools: one signer per wallet). */
	address = SIGNER_ADDRESS
	/** Highest number of sends this signer had in progress at the same time (counted here, on the signer side). */
	maxConcurrentSends = 0
	private sendsInProgress = 0
	/** Artificial latency of a send (ms), to model signing/confirmation time of a real signer. */
	sendDelayMs = 0
	/** Every send this signer accepted: when (ms, monotonic) and how many event keys it carried (counted on the signer side). */
	sends: { tMs: number; n: number }[] = []
	constructor(private readonly chain: FakeChain) {}
	async start(dir: string, name = 'signer'): Promise<void> {
		this.socketPath = path.join(dir, `${name}.sock`)
		try {
			fs.rmSync(this.socketPath, { force: true })
		} catch {
			/* none */
		}
		this.server = http.createServer(async (req, res) => {
			const body = JSON.parse(await readBody(req)) as { id: number; method: string; params: Record<string, unknown> }
			this.requests.push({ method: body.method, params: body.params })
			const reply = (result: unknown): void => {
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
			}
			const fail = (message: string): void => {
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } }))
			}
			if (this.mode === 'down') {
				req.socket.destroy()
				return
			}
			if (body.method === 'signer_getAddress') return reply(this.address)
			if (body.method === 'signer_getTransaction') {
				this.getTransactionCalls++
				const key = String((body.params as { idempotencyKey?: string }).idempotencyKey)
				const row = this.byKey.get(key)
				return reply(row ? { hash: row.hash, status: this.chain.sent.get(row.hash)?.mined ? 'mined' : 'sent' } : null)
			}
			if (body.method === 'signer_sendTransaction') {
				this.sendsInProgress++
				this.maxConcurrentSends = Math.max(this.maxConcurrentSends, this.sendsInProgress)
				res.on('close', () => void this.sendsInProgress--)
				if (this.sendDelayMs > 0) await new Promise((r) => setTimeout(r, this.sendDelayMs))
				const tx = body.params
				const key = String(tx.idempotencyKey)
				const fingerprint = hash32(JSON.stringify([tx.keyArray, tx.chainId, tx.to, tx.data, tx.value, tx.gasLimit]))
				const prior = this.byKey.get(key)
				if (prior) {
					if (prior.fingerprint !== fingerprint) return fail('idempotency key already used for a different request')
					this.duplicateSends++
					return reply({ hash: prior.hash, duplicate: true })
				}
				if (this.mode === 'reject') return fail('POLICY_DENIED: rejected by the fake signer')
				this.beforeRecord?.(tx)
				const hash = hash32(`tx:${++this.counter}:${key}`)
				this.byKey.set(key, { fingerprint, hash })
				const dec = WITHDRAW_NATIVE_IFACE.decodeFunctionData('withdrawNative', String(tx.data))
				this.chain.sent.set(hash.toLowerCase(), { eventKeys: this.eventKeysOf?.(key) ?? [], hash, idempotencyKey: key, to: String(tx.to), data: String(tx.data), value: String(tx.value), gasLimit: String(tx.gasLimit), keyArray: String(tx.keyArray), chainId: Number(tx.chainId), amountWei: BigInt(dec[1]), status: null, mined: false })
				this.afterRecord?.(tx, hash)
				this.sends.push({ tMs: Number(process.hrtime.bigint() / 1_000_000n), n: this.chain.sent.get(hash.toLowerCase())?.eventKeys.length ?? 0 })
				if (this.mode === 'lose-ack') {
					this.acksLost++
					req.socket.destroy()
					return
				}
				return reply({ hash })
			}
			return fail(`unknown signer method ${body.method}`)
		})
		await new Promise<void>((r) => this.server!.listen(this.socketPath, r))
	}
	async stop(): Promise<void> {
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
	}
}
