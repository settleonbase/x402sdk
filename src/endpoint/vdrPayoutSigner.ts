import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { ethers } from 'ethers'

/** Live reporter settle signature. View calls are not signed. */
const SETTLE_IFACE = new ethers.Interface([
	'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys)',
])

export const VDR_CHAIN_ID = 224422 as const
export const SETTLE_SELECTOR = SETTLE_IFACE.getFunction('settleNodeRewards')!.selector.toLowerCase()
export const SETTLE_ENTRY_MIN = 1
export const SETTLE_ENTRY_MAX = 29

/** Strict ABI: three equal-length arrays, and only 1..29 entries. Refused before any socket write. */
export function assertSettleBatchShape(
	guardianIds: readonly bigint[],
	amounts: readonly bigint[],
	eventKeys: readonly string[]
): void {
	const count = guardianIds.length
	if (amounts.length !== count || eventKeys.length !== count) {
		throw new Error('settleNodeRewards ABI requires three arrays of equal length')
	}
	if (count < SETTLE_ENTRY_MIN || count > SETTLE_ENTRY_MAX) {
		throw new Error(`settleNodeRewards entry count must be 1..29, got ${count}`)
	}
}

export type VdrSignerConfig = {
	socketPath: string
	keyArray: string
}

export type VdrSignerTx = {
	keyArray: string
	chainId: typeof VDR_CHAIN_ID
	to: string
	data: string
	value: '0'
	gasLimit: string
	idempotencyKey: string
}

export class SignerOutcomeUnknownError extends Error {
	constructor(reason: string) {
		super(`signer outcome unknown: ${reason}`)
		this.name = 'SignerOutcomeUnknownError'
	}
}

/** Parse only a complete, correlated JSON-RPC success. Any other reply may follow an accepted send. */
export function parseSignerSendResponse(raw: string): { hash: string } {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new SignerOutcomeUnknownError('malformed_json')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SignerOutcomeUnknownError('invalid_shape')
	const body = parsed as Record<string, unknown>
	if (body.jsonrpc !== '2.0' || body.id !== 1) throw new SignerOutcomeUnknownError('uncorrelated_response')
	if (Object.hasOwn(body, 'error')) throw new SignerOutcomeUnknownError('rpc_error')
	if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new SignerOutcomeUnknownError('missing_result')
	const hash = (body.result as Record<string, unknown>).hash
	if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new SignerOutcomeUnknownError('invalid_tx_hash')
	return { hash }
}

/** Settle one complete HTTP response; disconnects and partial replies stay UNKNOWN. */
export function readSignerHttpResponse(res: IncomingMessage): Promise<{ hash: string }> {
	return new Promise((resolve, reject) => {
		let settled = false
		const chunks: Buffer[] = []
		const fail = (reason: string) => {
			if (settled) return
			settled = true
			reject(new SignerOutcomeUnknownError(reason))
		}
		res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
		res.on('aborted', () => fail('response_aborted'))
		res.on('error', () => fail('response_error'))
		res.on('end', () => {
			if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
				fail('http_status_unknown')
				return
			}
			let result: { hash: string }
			try {
				result = parseSignerSendResponse(Buffer.concat(chunks).toString('utf8'))
			} catch (error) {
				fail(error instanceof SignerOutcomeUnknownError ? error.message.replace(/^signer outcome unknown: /, '') : 'response_parse_error')
				return
			}
			if (settled) return
			settled = true
			resolve(result)
		})
	})
}

export function readVdrSignerConfig(
	env: NodeJS.ProcessEnv = process.env
): VdrSignerConfig | null {
	const socketPath = env.CONET_VALIDATOR_CL_REWARD_PAYOUT_SIGNER_SOCKET?.trim() ?? ''
	const keyArray = env.CONET_VALIDATOR_CL_REWARD_PAYOUT_KEY_ARRAY?.trim() ?? ''
	if (!socketPath || !keyArray) return null
	return { socketPath, keyArray }
}

export function encodeSettleNodeRewards(
	guardianIds: bigint[],
	amounts: bigint[],
	eventKeys: string[]
): string {
	assertSettleBatchShape(guardianIds, amounts, eventKeys)
	const data = SETTLE_IFACE.encodeFunctionData('settleNodeRewards', [guardianIds, amounts, eventKeys])
	if (!data.toLowerCase().startsWith(SETTLE_SELECTOR)) {
		throw new Error('settleNodeRewards selector drifted')
	}
	return data
}

export function buildVdrSignerTx(input: {
	keyArray: string
	to: string
	guardianIds: bigint[]
	amounts: bigint[]
	eventKeys: string[]
	gasLimit: number
}): VdrSignerTx {
	if (!input.keyArray.trim()) throw new Error('vdr payout signer keyArray is not configured')
	if (!Number.isInteger(input.gasLimit) || input.gasLimit < 1) {
		throw new Error('gasLimit must be a positive integer')
	}
	const data = encodeSettleNodeRewards(input.guardianIds, input.amounts, input.eventKeys)
	return {
		keyArray: input.keyArray,
		chainId: VDR_CHAIN_ID,
		to: ethers.getAddress(input.to),
		data,
		value: '0',
		gasLimit: String(input.gasLimit),
		idempotencyKey: `vdr-settle:${ethers.keccak256(data)}`,
	}
}

/**
 * One JSON-RPC signer_sendTransaction on a dedicated Unix socket.
 * There is no Settle_ConetPool fallback. Native value other than "0" is refused
 * before the socket is used; the signer is still expected to refuse it.
 */
export function signerSendOnce(tx: VdrSignerTx, socketPath: string): Promise<{ hash: string }> {
	if (!socketPath.trim()) return Promise.reject(new Error('vdr payout signer socket is not configured'))
	if (tx.value !== '0') return Promise.reject(new Error('native value must be 0'))
	if (tx.chainId !== VDR_CHAIN_ID) return Promise.reject(new Error('chainId must be 224422'))
	if (!tx.data.toLowerCase().startsWith(SETTLE_SELECTOR)) {
		return Promise.reject(new Error(`refusing selector ${tx.data.slice(0, 10)}`))
	}
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'signer_sendTransaction',
		params: tx,
	})
	return new Promise((resolve, reject) => {
		let settled = false
		const fail = (reason: string) => {
			if (settled) return
			settled = true
			reject(new SignerOutcomeUnknownError(reason))
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
			(res) => { void readSignerHttpResponse(res).then(resolve, reject) }
		)
		req.setTimeout(60_000, () => {
			fail('request_timeout')
			req.destroy()
		})
		req.on('error', () => fail('request_error'))
		req.on('abort', () => fail('request_aborted'))
		req.end(body)
	})
}

export async function sendConfiguredSettle(input: {
	to: string
	guardianIds: bigint[]
	amounts: bigint[]
	eventKeys: string[]
	gasLimit: number
	env?: NodeJS.ProcessEnv
}): Promise<{ hash: string }> {
	const config = readVdrSignerConfig(input.env)
	if (!config) throw new Error('vdr payout signer socket or keyArray is not configured')
	const tx = buildVdrSignerTx({ ...input, keyArray: config.keyArray })
	return signerSendOnce(tx, config.socketPath)
}
