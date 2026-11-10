import { request as httpRequest } from 'node:http'
import { ethers } from 'ethers'

/**
 * Lab CL skim → LabMiningPoolPayoutExecutor via dedicated unix socket.
 * Fail-closed: no private-key path, no VDR withdrawNative, no Settle_ConetPool.
 *
 * Canonical path: payoutBatch(batchId, eventKeys, amount) — on-chain batch + eventKey idempotency.
 * Legacy path: payout(amount) — fixtures / migration only (NO on-chain batch key).
 *
 * Power-loss / ACK-lost: durable idempotencyKey + request fingerprint; recover via
 * signer_getTransaction (original broadcast hash — never RPC mock success).
 *
 * Env (required for live payout):
 *   CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET  e.g. /run/wallet-signer-lab-mining-pool/lab-payout.sock
 *   CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY      e.g. lab_mining_pool_payout
 *   CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR          deployed LabMiningPoolPayoutExecutor address
 *
 * Forbidden reuse: /run/wallet-signer-vdr/vdr-payout.sock, beamio_vdr_payout, VDR PAY EOA.
 */

const PAYOUT_IFACE = new ethers.Interface(['function payout(uint256 amount)'])
const PAYOUT_BATCH_IFACE = new ethers.Interface([
	'function payoutBatch(bytes32 batchId, bytes32[] calldata eventKeys, uint256 amount)',
])

export const LAB_PAYOUT_CHAIN_ID = 224422 as const
export const PAYOUT_SELECTOR = PAYOUT_IFACE.getFunction('payout')!.selector.toLowerCase()
/** keccak256("payoutBatch(bytes32,bytes32[],uint256)")[:4] */
export const PAYOUT_BATCH_SELECTOR = PAYOUT_BATCH_IFACE.getFunction('payoutBatch')!.selector.toLowerCase()
export const LAB_PAYOUT_BATCH_SELECTOR = PAYOUT_BATCH_SELECTOR

/** Forbidden production VDR payout socket (must never be used by Lab daemon). */
export const FORBIDDEN_VDR_PAYOUT_SOCKET = '/run/wallet-signer-vdr/vdr-payout.sock'
/** Forbidden VDR PAY key array name. */
export const FORBIDDEN_VDR_KEY_ARRAY = 'beamio_vdr_payout'

export type LabPayoutSignerConfig = {
	socketPath: string
	keyArray: string
	executor: string
}

export type LabPayoutSignerTx = {
	keyArray: string
	chainId: typeof LAB_PAYOUT_CHAIN_ID
	to: string
	data: string
	value: '0'
	gasLimit: string
	idempotencyKey: string
}

type RpcError = { code?: number; message?: string }
type RpcBody = {
	result?: { hash?: unknown; status?: unknown; found?: unknown; duplicate?: unknown }
	error?: RpcError
}

export function readLabPayoutSignerConfig(
	env: NodeJS.ProcessEnv = process.env
): LabPayoutSignerConfig | null {
	const socketPath = env.CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET?.trim() ?? ''
	const keyArray = env.CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY?.trim() ?? ''
	const executorRaw = env.CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR?.trim() ?? ''
	if (!socketPath || !keyArray || !executorRaw) return null
	if (socketPath === FORBIDDEN_VDR_PAYOUT_SOCKET) {
		throw new Error('lab payout refuses forbidden VDR socket vdr-payout.sock')
	}
	if (keyArray === FORBIDDEN_VDR_KEY_ARRAY) {
		throw new Error('lab payout refuses forbidden VDR key array beamio_vdr_payout')
	}
	if (socketPath.includes('vdr-payout') || keyArray === 'vdr_payout') {
		throw new Error('lab payout refuses VDR sock/keyArray')
	}
	let executor: string
	try {
		executor = ethers.getAddress(executorRaw)
	} catch {
		throw new Error('CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR is not a valid address')
	}
	if (executor === ethers.ZeroAddress) {
		throw new Error('CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR must not be zero')
	}
	return { socketPath, keyArray, executor }
}

export function encodeLabExecutorPayout(amount: bigint): string {
	if (amount <= 0n) throw new Error('payout amount must be > 0')
	const data = PAYOUT_IFACE.encodeFunctionData('payout', [amount])
	if (!data.toLowerCase().startsWith(PAYOUT_SELECTOR)) {
		throw new Error('payout selector drifted')
	}
	return data
}

export type LabPayoutBatchParams = {
	batchId: string
	eventKeys: string[]
	amount: bigint
}

/** Stable batchId from sorted event keys (same keys → same batchId across restarts). */
export function labBatchIdFromEventKeys(eventKeys: string[]): string {
	const sorted = [...eventKeys].map((k) => k.toLowerCase()).sort()
	return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ v: 1, eventKeys: sorted })))
}

export function labPayoutRequestFingerprint(input: {
	executor: string
	batchId: string
	eventKeys: string[]
	amount: bigint
	chainId?: number
}): string {
	const payload = {
		v: 1 as const,
		chainId: input.chainId ?? LAB_PAYOUT_CHAIN_ID,
		executor: ethers.getAddress(input.executor).toLowerCase(),
		batchId: input.batchId.toLowerCase(),
		eventKeys: [...input.eventKeys].map((k) => k.toLowerCase()).sort(),
		amountWei: input.amount.toString(),
	}
	return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)))
}

export function labPayoutBatchIdempotencyKey(fingerprint: string): string {
	const fp = fingerprint.startsWith('0x') ? fingerprint.slice(2) : fingerprint
	return `lab-executor-payoutBatch:${fp.toLowerCase()}`
}

export function encodeLabPayoutBatchCalldata(params: LabPayoutBatchParams): string {
	if (params.amount <= 0n) throw new Error('payoutBatch amount must be > 0')
	if (!params.eventKeys.length) throw new Error('payoutBatch requires eventKeys')
	const batchId = ethers.hexlify(ethers.getBytes(params.batchId))
	const eventKeys = params.eventKeys.map((k) => ethers.hexlify(ethers.getBytes(k)))
	const data = PAYOUT_BATCH_IFACE.encodeFunctionData('payoutBatch', [
		batchId,
		eventKeys,
		params.amount,
	])
	if (!data.toLowerCase().startsWith(PAYOUT_BATCH_SELECTOR)) {
		throw new Error(`payoutBatch selector drifted: ${data.slice(0, 10)}`)
	}
	return data
}

/**
 * Legacy amount-only path. LabMiningPoolPayoutExecutor.payout(uint256) has NO on-chain batch key.
 * Production Lab daemon must use buildLabPayoutBatchSignerTx / sendConfiguredLabExecutorPayoutBatch.
 */
export function buildLabPayoutSignerTx(input: {
	keyArray: string
	executor: string
	amount: bigint
	gasLimit: number
	/** Optional off-chain batch fingerprint (eventKeys hash); not enforced on-chain. */
	batchFingerprint?: string
}): LabPayoutSignerTx {
	if (!input.keyArray.trim()) throw new Error('lab payout signer keyArray is not configured')
	if (!Number.isInteger(input.gasLimit) || input.gasLimit < 1) {
		throw new Error('gasLimit must be a positive integer')
	}
	const data = encodeLabExecutorPayout(input.amount)
	const fp =
		input.batchFingerprint?.trim() ||
		ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [input.amount]))
	return {
		keyArray: input.keyArray,
		chainId: LAB_PAYOUT_CHAIN_ID,
		to: ethers.getAddress(input.executor),
		data,
		value: '0',
		gasLimit: String(input.gasLimit),
		idempotencyKey: `lab-executor-payout:${fp}`,
	}
}

/** Canonical batch path — durable idempotencyKey from request fingerprint. */
export function buildLabPayoutBatchSignerTx(input: {
	keyArray: string
	executor: string
	batchId: string
	eventKeys: string[]
	amount: bigint
	gasLimit: number
}): LabPayoutSignerTx & { requestFingerprint: string } {
	if (!input.keyArray.trim()) throw new Error('lab payout signer keyArray is not configured')
	if (!Number.isInteger(input.gasLimit) || input.gasLimit < 1) {
		throw new Error('gasLimit must be a positive integer')
	}
	const data = encodeLabPayoutBatchCalldata({
		batchId: input.batchId,
		eventKeys: input.eventKeys,
		amount: input.amount,
	})
	const requestFingerprint = labPayoutRequestFingerprint({
		executor: input.executor,
		batchId: input.batchId,
		eventKeys: input.eventKeys,
		amount: input.amount,
	})
	return {
		keyArray: input.keyArray,
		chainId: LAB_PAYOUT_CHAIN_ID,
		to: ethers.getAddress(input.executor),
		data,
		value: '0',
		gasLimit: String(input.gasLimit),
		idempotencyKey: labPayoutBatchIdempotencyKey(requestFingerprint),
		requestFingerprint,
	}
}

function labSignerRpc(
	socketPath: string,
	method: string,
	params: unknown
): Promise<RpcBody['result']> {
	if (!socketPath.trim()) return Promise.reject(new Error('lab payout signer socket is not configured'))
	if (socketPath === FORBIDDEN_VDR_PAYOUT_SOCKET) {
		return Promise.reject(new Error('lab payout refuses forbidden VDR socket'))
	}
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method,
		params,
	})
	return new Promise((resolve, reject) => {
		let settled = false
		const fail = (message: string) => {
			if (settled) return
			settled = true
			reject(new Error(message))
		}
		const req = httpRequest(
			{
				socketPath,
				path: '/rpc',
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(body),
				},
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					let parsed: RpcBody
					try {
						parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcBody
					} catch {
						fail('signer response was not JSON')
						return
					}
					if (parsed.error) {
						fail(parsed.error.message || 'signer refused')
						return
					}
					if (settled) return
					settled = true
					resolve(parsed.result)
				})
			}
		)
		req.setTimeout(60_000, () => {
			req.destroy()
			fail('signer socket timed out')
		})
		req.on('error', (err: NodeJS.ErrnoException) => {
			fail(`signer socket failed: ${err.message}`)
		})
		req.end(body)
	})
}

export function labPayoutSignerSendOnce(
	tx: LabPayoutSignerTx,
	socketPath: string
): Promise<{ hash: string; duplicate?: boolean }> {
	if (tx.value !== '0') return Promise.reject(new Error('native value must be 0'))
	if (tx.chainId !== LAB_PAYOUT_CHAIN_ID) return Promise.reject(new Error('chainId must be 224422'))
	const sel = tx.data.slice(0, 10).toLowerCase()
	if (sel !== PAYOUT_SELECTOR && sel !== PAYOUT_BATCH_SELECTOR) {
		return Promise.reject(new Error(`refusing selector ${sel}`))
	}
	return labSignerRpc(socketPath, 'signer_sendTransaction', tx).then((result) => {
		const hash = result?.hash
		if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
			throw new Error('signer response had no transaction hash')
		}
		return { hash, duplicate: Boolean(result?.duplicate) }
	})
}

/**
 * Look up prior broadcast by durable idempotencyKey (ACK-lost after broadcast recovery).
 * Returns original hash when signer journal still holds the send — never invents success.
 */
export async function recoverLabPayoutHashByIdempotencyKey(
	socketPath: string,
	idempotencyKey: string
): Promise<{ hash: string; status?: string } | null> {
	try {
		const row = await labSignerRpc(socketPath, 'signer_getTransaction', { idempotencyKey })
		const hash = typeof row?.hash === 'string' ? row.hash.trim() : ''
		if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
		return {
			hash,
			status: typeof row?.status === 'string' ? row.status : undefined,
		}
	} catch {
		return null
	}
}

export async function sendConfiguredLabExecutorPayout(input: {
	amount: bigint
	gasLimit: number
	batchFingerprint?: string
	env?: NodeJS.ProcessEnv
}): Promise<{ hash: string; executor: string }> {
	const config = readLabPayoutSignerConfig(input.env)
	if (!config) {
		throw new Error(
			'lab payout signer socket, keyArray, or CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR is not configured'
		)
	}
	const tx = buildLabPayoutSignerTx({
		keyArray: config.keyArray,
		executor: config.executor,
		amount: input.amount,
		gasLimit: input.gasLimit,
		batchFingerprint: input.batchFingerprint,
	})
	const { hash } = await labPayoutSignerSendOnce(tx, config.socketPath)
	return { hash, executor: config.executor }
}

export type LabSendPayoutBatchResult = {
	hash: string
	executor: string
	duplicate: boolean
	idempotencyKey: string
	requestFingerprint: string
	batchId: string
	recoveredFromJournal: boolean
}

/**
 * Canonical Lab skim send: payoutBatch + durable idempotencyKey.
 * On transport failure after possible broadcast, recovers original hash via
 * signer_getTransaction(idempotencyKey) — never mocks RPC success.
 */
export async function sendConfiguredLabExecutorPayoutBatch(input: {
	batchId: string
	eventKeys: string[]
	amount: bigint
	gasLimit: number
	env?: NodeJS.ProcessEnv
	/** Prefer recovering journal before a new send (crash / ACK-lost path). */
	preferRecoverFirst?: boolean
}): Promise<LabSendPayoutBatchResult> {
	const config = readLabPayoutSignerConfig(input.env)
	if (!config) {
		throw new Error(
			'lab payout signer socket, keyArray, or CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR is not configured'
		)
	}
	const tx = buildLabPayoutBatchSignerTx({
		keyArray: config.keyArray,
		executor: config.executor,
		batchId: input.batchId,
		eventKeys: input.eventKeys,
		amount: input.amount,
		gasLimit: input.gasLimit,
	})
	const finish = (
		hash: string,
		duplicate: boolean,
		recoveredFromJournal: boolean
	): LabSendPayoutBatchResult => ({
		hash,
		executor: config.executor,
		duplicate,
		idempotencyKey: tx.idempotencyKey,
		requestFingerprint: tx.requestFingerprint,
		batchId: input.batchId.toLowerCase(),
		recoveredFromJournal,
	})

	if (input.preferRecoverFirst) {
		const prior = await recoverLabPayoutHashByIdempotencyKey(config.socketPath, tx.idempotencyKey)
		if (prior) return finish(prior.hash, true, true)
	}

	try {
		const sent = await labPayoutSignerSendOnce(tx, config.socketPath)
		return finish(sent.hash, Boolean(sent.duplicate), false)
	} catch (sendErr: unknown) {
		const prior = await recoverLabPayoutHashByIdempotencyKey(config.socketPath, tx.idempotencyKey)
		if (prior) return finish(prior.hash, true, true)
		throw sendErr
	}
}
