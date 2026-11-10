import { Interface, getAddress, id, isAddress } from 'ethers'
import { chatWritesStopped } from './chatWriteStopGate'
import type { SettleRelayLookup } from './settleRemoteRelay'

/** Old settle admin array. The isolated chat relay must not use this name. */
export const SETTLE_ADMIN_KEY_ARRAY = 'settle_contractAdmin'

/** CoNET chain for the chat index pointer relay. */
export const CHAT_POINTER_CHAIN_ID = 224422

/**
 * Public ChatIndexRegistry proxy. Tests and review docs use this placeholder.
 * Production must set WALLET_SIGNER_CHAT_POINTER_CONTRACT explicitly.
 */
export const CHAT_POINTER_CONTRACT_PLACEHOLDER = '0x1511Caa71081C84d8a591490D1b83879088EED72'

export const CHAT_POINTER_METHOD = 'setPointerWithSig(address,bytes32,uint64,uint64,uint256,bytes)'

/** Reviewed gas cap for this one call. Calls above it are denied. */
export const CHAT_POINTER_MAX_GAS = 300_000n

const CHAT_POINTER_SELECTOR = id(CHAT_POINTER_METHOD).slice(0, 10).toLowerCase()

export type ChatPointerRelayConfig = {
	keyArray: string
	contract: string
	chainId: typeof CHAT_POINTER_CHAIN_ID
}

export type ChatPointerConfigError = {
	ok: false
	code: 'missing_key_array' | 'missing_contract' | 'points_at_settle_admin' | 'bad_contract'
	error: string
}

export function resolveChatPointerRelayConfig(env: NodeJS.ProcessEnv = process.env): { ok: true; config: ChatPointerRelayConfig } | ChatPointerConfigError {
	const keyArray = env.WALLET_SIGNER_CHAT_POINTER_ARRAY?.trim() ?? ''
	if (!keyArray) {
		return {
			ok: false,
			code: 'missing_key_array',
			error: 'WALLET_SIGNER_CHAT_POINTER_ARRAY is required for the isolated chat relay',
		}
	}
	const forbidden = new Set<string>([SETTLE_ADMIN_KEY_ARRAY.toLowerCase()])
	const settleAlias = env.WALLET_SIGNER_SETTLE_ARRAY?.trim()
	if (settleAlias) forbidden.add(settleAlias.toLowerCase())
	if (forbidden.has(keyArray.toLowerCase())) {
		return {
			ok: false,
			code: 'points_at_settle_admin',
			error: `isolated chat relay refuses key array ${keyArray}; it must not be the settle admin array`,
		}
	}
	const contractRaw = env.WALLET_SIGNER_CHAT_POINTER_CONTRACT?.trim() ?? ''
	if (!contractRaw) {
		return {
			ok: false,
			code: 'missing_contract',
			error: 'WALLET_SIGNER_CHAT_POINTER_CONTRACT is required for the isolated chat relay',
		}
	}
	if (!isAddress(contractRaw)) {
		return { ok: false, code: 'bad_contract', error: 'WALLET_SIGNER_CHAT_POINTER_CONTRACT is not an address' }
	}
	return {
		ok: true,
		config: { keyArray, contract: getAddress(contractRaw), chainId: CHAT_POINTER_CHAIN_ID },
	}
}

export function authorizeChatPointerCall(
	config: ChatPointerRelayConfig,
	call: { to: string; data: string; chainId: number; value?: bigint; gasLimit?: bigint },
): { ok: true } | { ok: false; error: string } {
	if (call.chainId !== config.chainId) return { ok: false, error: 'chat pointer relay denies this chain' }
	if (!isAddress(call.to) || getAddress(call.to) !== config.contract) {
		return { ok: false, error: 'chat pointer relay denies this contract' }
	}
	if ((call.value ?? 0n) !== 0n) return { ok: false, error: 'chat pointer relay denies value' }
	if (call.gasLimit !== undefined && call.gasLimit > CHAT_POINTER_MAX_GAS) {
		return { ok: false, error: `chat pointer relay denies gas above ${CHAT_POINTER_MAX_GAS}` }
	}
	const selector = (call.data ?? '0x').slice(0, 10).toLowerCase()
	if (selector !== CHAT_POINTER_SELECTOR) return { ok: false, error: 'chat pointer relay allows only setPointerWithSig' }
	return { ok: true }
}

export type ChatPointerHttpBody = {
	owner?: string
	indexHash?: string
	ts?: string
	seq?: string
	nonce?: string
	signature?: string
}

export type ChatPointerHttpDeps = {
	isolationActive: boolean
	env?: NodeJS.ProcessEnv
	lookup: SettleRelayLookup
	readLegacyKeys: () => readonly string[]
	send: (call: { to: string; data: string; chainId: number; value: bigint; gasLimit: bigint }) => Promise<{ txHash: string }>
}

export type ChatPointerHttpResult =
	| { deferred: true }
	| { deferred: false; status: number; json: Record<string, unknown> }

const pointerIface = new Interface([`function ${CHAT_POINTER_METHOD}`])

/**
 * HTTP entry for POST /setChatIndexPointer when the isolated relay is on.
 * Isolation off defers to the legacy enqueue and does not touch the signer or legacy keys.
 * Isolation on never defers: missing config, the settle admin array, signer failure, and
 * any call other than setPointerWithSig are refused without reading legacy keys.
 */
export async function handleSetChatIndexPointerHttp(body: ChatPointerHttpBody, deps: ChatPointerHttpDeps): Promise<ChatPointerHttpResult> {
	// Stopped writes never defer. Deferral is the legacy enqueue, which reads the old pool.
	if (chatWritesStopped(deps.env)) {
		return {
			deferred: false,
			status: 503,
			json: {
				success: false,
				error: 'chat_writes_stopped',
				code: 'chat_writes_stopped',
				retryable: false,
				legacyFallback: false,
			},
		}
	}
	if (!deps.isolationActive) return { deferred: true }
	if (!body.owner || !body.indexHash || body.ts == null || body.seq == null || body.nonce == null || !body.signature) {
		return { deferred: false, status: 400, json: { success: false, error: 'Missing chat index pointer fields' } }
	}
	if (!isAddress(body.owner)) {
		return { deferred: false, status: 400, json: { success: false, error: 'Invalid chat index pointer owner' } }
	}
	const resolved = resolveChatPointerRelayConfig(deps.env)
	if (!resolved.ok) {
		return {
			deferred: false,
			status: 503,
			json: { success: false, retryable: false, error: resolved.error, code: resolved.code },
		}
	}
	let data: string
	try {
		data = pointerIface.encodeFunctionData('setPointerWithSig', [
			getAddress(body.owner),
			body.indexHash,
			BigInt(body.ts),
			BigInt(body.seq),
			BigInt(body.nonce),
			body.signature,
		])
	} catch {
		return { deferred: false, status: 400, json: { success: false, error: 'Invalid chat index pointer fields' } }
	}
	const call = {
		to: resolved.config.contract,
		data,
		chainId: resolved.config.chainId,
		value: 0n,
		gasLimit: 150_000n,
	}
	const allowed = authorizeChatPointerCall(resolved.config, call)
	if (!allowed.ok) {
		return { deferred: false, status: 403, json: { success: false, error: allowed.error } }
	}
	let accounts: string[]
	try {
		accounts = await deps.lookup.accounts(resolved.config.keyArray, resolved.config.chainId)
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e)
		return {
			deferred: false,
			status: 503,
			json: { success: false, retryable: true, error: 'signer_unavailable', detail },
		}
	}
	if (accounts.length === 0) {
		return {
			deferred: false,
			status: 503,
			json: { success: false, retryable: true, error: 'signer_unavailable', detail: 'no keys' },
		}
	}
	try {
		const sent = await deps.send(call)
		return { deferred: false, status: 200, json: { success: true, txHash: sent.txHash } }
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e)
		const unavailable = /signer_unavailable|ECONNREFUSED|unavailable/i.test(detail)
		return {
			deferred: false,
			status: unavailable ? 503 : 400,
			json: { success: false, retryable: unavailable, error: unavailable ? 'signer_unavailable' : detail },
		}
	}
}
