import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Interface, getAddress, id } from 'ethers'
import {
	CHAT_POINTER_CONTRACT_PLACEHOLDER,
	CHAT_POINTER_MAX_GAS,
	CHAT_POINTER_METHOD,
	authorizeChatPointerCall,
	handleSetChatIndexPointerHttp,
	resolveChatPointerRelayConfig,
	type ChatPointerHttpDeps,
	type ChatPointerRelayConfig,
} from './chatPointerRelayGate'
import { chatRelayRoute, settleGasRelayEnabled, settleGasRelayIsolationActive, settleLegacyPrivateKeyClosed } from './settleLegacyKeyGate'
import { chooseLowPrivRelaySlot, loadSettleRelayRoster, runLowPrivGasRelayAttempt, type LowPrivRelayState } from './settleRemoteRelay'
import { placeSettleRemoteKeys } from './settleRemoteRoster'

const PREV = process.env.WALLET_SIGNER_FEATURES

function setFeatures(value: string | undefined): void {
	if (value === undefined) delete process.env.WALLET_SIGNER_FEATURES
	else process.env.WALLET_SIGNER_FEATURES = value
}

test('settle remote mode closes legacy private-key reads', () => {
	try {
		setFeatures(undefined)
		assert.equal(settleLegacyPrivateKeyClosed('executeForAdmin admin signature'), null)
		setFeatures('chat,gbAirdrop')
		assert.equal(settleLegacyPrivateKeyClosed('executeForAdmin admin signature'), null)
		setFeatures('settle')
		const closed = settleLegacyPrivateKeyClosed('executeForAdmin admin signature')
		assert.ok(closed)
		assert.match(closed!, /will not read legacy settle private keys/)
		assert.match(closed!, /admin signatures need a separate key array/)
		assert.match(closed!, /gas relay uses the signer pool/)
		setFeatures('chat, settle ,epoch')
		assert.match(settleLegacyPrivateKeyClosed('factory paymaster admin init')!, /factory paymaster admin init/)
		setFeatures('all')
		assert.match(settleLegacyPrivateKeyClosed('guardian oracle')!, /guardian oracle/)
	} finally {
		setFeatures(PREV)
	}
})

test('settle remote roster puts only Base-authorized keys in the Base pool', () => {
	const conetOnly = '0x0000000000000000000000000000000000000001'
	const both = '0x000000000000000000000000000000000000000A'
	const baseOnly = '0x00000000000000000000000000000000000000BB'
	const placed = placeSettleRemoteKeys(
		[both, conetOnly, both.toLowerCase()],
		[both.toLowerCase(), baseOnly],
	)
	assert.deepEqual(placed, [
		{ address: both, conet: true, base: true },
		{ address: conetOnly, conet: true, base: false },
	])
	assert.equal(placed.filter((row) => row.base).length, 1)
	assert.equal(placeSettleRemoteKeys([], [baseOnly]).length, 0)
})

test('settle gas relay fails closed when the signer is unreachable', async () => {
	let legacyReads = 0
	const fakeKey = `0x${'ab'.repeat(32)}`
	const result = await loadSettleRelayRoster({
		remote: true,
		keyArray: 'settle_contractAdmin',
		conetChainId: 224422,
		baseChainId: 8453,
		lookup: {
			async accounts() {
				throw new Error('connect ECONNREFUSED 127.0.0.1:1')
			},
		},
		readLegacyKeys: () => {
			legacyReads += 1
			return [fakeKey]
		},
	})
	assert.equal(result.ok, false)
	if (result.ok) return
	assert.equal(result.mode, 'remote')
	assert.equal(result.code, 'signer_unavailable')
	assert.match(result.error, /wallet-signer unavailable for settle gas relay/)
	assert.match(result.error, /ECONNREFUSED/)
	assert.equal(result.legacyKeyReads, 0)
	assert.equal(legacyReads, 0)
	assert.equal(result.error.includes(fakeKey), false)
})

test('settle gas relay does not read legacy keys when the signer answers', async () => {
	let legacyReads = 0
	const conetOnly = '0x0000000000000000000000000000000000000001'
	const both = '0x000000000000000000000000000000000000000A'
	const result = await loadSettleRelayRoster({
		remote: true,
		keyArray: 'settle_contractAdmin',
		conetChainId: 224422,
		baseChainId: 8453,
		lookup: {
			async accounts(_keyArray: string, chainId: number) {
				if (chainId === 8453) throw new Error('base grant lookup failed')
				return [both, conetOnly]
			},
		},
		readLegacyKeys: () => {
			legacyReads += 1
			return [`0x${'cd'.repeat(32)}`]
		},
	})
	assert.equal(legacyReads, 0)
	assert.equal(result.ok, true)
	if (!result.ok) return
	assert.equal(result.mode, 'remote')
	if (result.mode !== 'remote') return
	assert.equal(result.legacyKeyReads, 0)
	assert.equal(result.placed.length, 2)
	assert.equal(result.placed.every((row) => row.conet && row.base === false), true)
})

test('settle gas relay does not fall back when the signer returns no keys', async () => {
	let legacyReads = 0
	const result = await loadSettleRelayRoster({
		remote: true,
		keyArray: 'settle_contractAdmin',
		conetChainId: 224422,
		baseChainId: 8453,
		lookup: {
			async accounts() {
				return []
			},
		},
		readLegacyKeys: () => {
			legacyReads += 1
			return [`0x${'11'.repeat(32)}`]
		},
	})
	assert.equal(legacyReads, 0)
	assert.equal(result.ok, false)
	if (result.ok) return
	assert.equal(result.code, 'no_remote_keys')
	assert.match(result.error, /no keys in settle_contractAdmin/)
	assert.equal(result.legacyKeyReads, 0)
})

test('settle and all do not arm the isolated gas relay', () => {
	try {
		setFeatures(undefined)
		assert.equal(settleGasRelayEnabled(), false)
		assert.equal(settleGasRelayIsolationActive(), false)
		assert.equal(settleLegacyPrivateKeyClosed('base token relay'), null)
		setFeatures('settleGasRelay')
		assert.equal(settleGasRelayEnabled(), true)
		assert.equal(settleGasRelayIsolationActive(), true)
		assert.equal(settleLegacyPrivateKeyClosed('executeForAdmin admin signature'), null)
		assert.equal(settleLegacyPrivateKeyClosed('guardian oracle'), null)
		assert.equal(settleLegacyPrivateKeyClosed('base usdc charge relay'), null)
		assert.equal(settleLegacyPrivateKeyClosed('fuel pack fulfillment'), null)
		setFeatures('settle')
		assert.equal(settleGasRelayIsolationActive(), false)
		assert.match(settleLegacyPrivateKeyClosed('merchant kit fulfillment')!, /closed/)
		setFeatures('all')
		assert.equal(settleGasRelayEnabled(), false)
		assert.equal(settleGasRelayIsolationActive(), false)
		assert.match(settleLegacyPrivateKeyClosed('base token relay')!, /closed/)
		setFeatures('all,settleGasRelay')
		assert.equal(settleGasRelayEnabled(), true)
		assert.equal(settleGasRelayIsolationActive(), false)
	} finally {
		setFeatures(PREV)
	}
})

test('isolated gas relay fails closed, then recovers without a legacy fallback', async () => {
	const state: LowPrivRelayState = { placed: [] }
	let legacyReads = 0
	let lookups = 0
	const address = '0x0000000000000000000000000000000000000001'
	const lookup = {
		async accounts(_keyArray: string, chainId: number) {
			lookups += 1
			if (lookups === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:1')
			if (chainId === 8453) return []
			return [address]
		},
	}
	const readLegacyKeys = () => {
		legacyReads += 1
		return [`0x${'ab'.repeat(32)}`]
	}
	const common = {
		keyArray: 'settle_contractAdmin',
		conetChainId: 224422,
		baseChainId: 8453,
		lookup,
		readLegacyKeys,
		state,
	}
	const off = await runLowPrivGasRelayAttempt({ ...common, isolationEnabled: false })
	assert.equal(off.ok, false)
	if (!off.ok) assert.equal(off.code, 'isolation_off')
	assert.equal(lookups, 0)
	assert.equal(legacyReads, 0)
	assert.deepEqual(chooseLowPrivRelaySlot({ isolationEnabled: false, remoteConetAddresses: [], legacyIdle: true }), { use: 'legacy' })

	const failed = await runLowPrivGasRelayAttempt({ ...common, isolationEnabled: true })
	assert.equal(failed.ok, false)
	if (failed.ok || failed.code === 'isolation_off') throw new Error('expected signer_unavailable')
	assert.equal(failed.code, 'signer_unavailable')
	assert.match(failed.error, /ECONNREFUSED/)
	assert.equal(state.placed.length, 0)
	assert.equal(legacyReads, 0)
	assert.deepEqual(
		chooseLowPrivRelaySlot({ isolationEnabled: true, remoteConetAddresses: state.placed.map((row) => row.address), legacyIdle: true }),
		{ use: 'unavailable' },
	)

	const ready = await runLowPrivGasRelayAttempt({ ...common, isolationEnabled: true })
	assert.equal(ready.ok, true)
	if (ready.ok) {
		assert.equal(ready.code, 'ready')
		assert.equal(ready.legacyKeyReads, 0)
		assert.equal(ready.placed.length, 1)
		assert.equal(ready.placed[0]?.base, false)
	}
	assert.equal(legacyReads, 0)
	assert.deepEqual(
		chooseLowPrivRelaySlot({ isolationEnabled: true, remoteConetAddresses: state.placed.map((row) => row.address), legacyIdle: true }),
		{ use: 'remote', address },
	)
})

const POINTER_ENV = ['WALLET_SIGNER_CHAT_POINTER_ARRAY', 'WALLET_SIGNER_CHAT_POINTER_CONTRACT', 'WALLET_SIGNER_SETTLE_ARRAY'] as const

function snapshotPointerEnv(): Record<string, string | undefined> {
	return Object.fromEntries(POINTER_ENV.map((key) => [key, process.env[key]]))
}

function restorePointerEnv(saved: Record<string, string | undefined>): void {
	for (const key of POINTER_ENV) {
		const value = saved[key]
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
}

const pointerOwner = '0x0000000000000000000000000000000000000001'
const pointerHash = `0x${'11'.repeat(32)}`
const pointerSig = `0x${'ab'.repeat(65)}`
const pointerBody = {
	owner: pointerOwner,
	indexHash: pointerHash,
	ts: '1700000000000',
	seq: '1',
	nonce: '0',
	signature: pointerSig,
}
const pointerIface = new Interface([`function ${CHAT_POINTER_METHOD}`])

function pointerDeps(overrides: Partial<ChatPointerHttpDeps> & Pick<ChatPointerHttpDeps, 'lookup' | 'readLegacyKeys' | 'send'>): ChatPointerHttpDeps {
	return { isolationActive: true, env: process.env, ...overrides }
}

test('chat settle and all switch priority', () => {
	try {
		setFeatures(undefined)
		assert.equal(chatRelayRoute(), 'legacy')
		assert.equal(settleGasRelayIsolationActive(), false)
		setFeatures('gbAirdrop')
		assert.equal(chatRelayRoute(), 'legacy')
		setFeatures('chat')
		assert.equal(chatRelayRoute(), 'chat-feature')
		assert.equal(settleGasRelayIsolationActive(), false)
		setFeatures('settleGasRelay')
		assert.equal(chatRelayRoute(), 'isolated-chat-pointer')
		assert.equal(settleGasRelayIsolationActive(), true)
		assert.equal(settleLegacyPrivateKeyClosed('executeForAdmin admin signature'), null)
		setFeatures('settleGasRelay,chat')
		assert.equal(chatRelayRoute(), 'isolated-chat-pointer')
		setFeatures('settle')
		assert.equal(chatRelayRoute(), 'broad-settle')
		assert.equal(settleGasRelayIsolationActive(), false)
		setFeatures('all')
		assert.equal(chatRelayRoute(), 'broad-settle')
		setFeatures('all,settleGasRelay')
		assert.equal(chatRelayRoute(), 'broad-settle')
		assert.equal(settleGasRelayIsolationActive(), false)
		setFeatures('settle,settleGasRelay')
		assert.equal(chatRelayRoute(), 'broad-settle')
		assert.equal(settleGasRelayIsolationActive(), false)
	} finally {
		setFeatures(PREV)
	}
})

test('isolated chat pointer HTTP refuses a missing or settle-admin array without a legacy read', async () => {
	const saved = snapshotPointerEnv()
	let legacyReads = 0
	let lookups = 0
	let sends = 0
	const deps = pointerDeps({
		lookup: {
			async accounts() {
				lookups += 1
				return [pointerOwner]
			},
		},
		readLegacyKeys: () => {
			legacyReads += 1
			return [`0x${'ab'.repeat(32)}`]
		},
		send: async () => {
			sends += 1
			return { txHash: '0x' }
		},
	})
	try {
		setFeatures(undefined)
		const deferred = await handleSetChatIndexPointerHttp(pointerBody, { ...deps, isolationActive: false })
		assert.equal(deferred.deferred, true)
		assert.equal(lookups, 0)
		assert.equal(legacyReads, 0)
		assert.equal(sends, 0)

		setFeatures('settleGasRelay')
		delete process.env.WALLET_SIGNER_CHAT_POINTER_ARRAY
		delete process.env.WALLET_SIGNER_CHAT_POINTER_CONTRACT
		delete process.env.WALLET_SIGNER_SETTLE_ARRAY
		const missingArray = await handleSetChatIndexPointerHttp(pointerBody, deps)
		assert.equal(missingArray.deferred, false)
		if (missingArray.deferred) return
		assert.equal(missingArray.status, 503)
		assert.equal(missingArray.json.retryable, false)
		assert.equal(missingArray.json.code, 'missing_key_array')

		process.env.WALLET_SIGNER_CHAT_POINTER_ARRAY = 'chat_index_pointer'
		const missingContract = await handleSetChatIndexPointerHttp(pointerBody, deps)
		assert.equal(missingContract.deferred, false)
		if (missingContract.deferred) return
		assert.equal(missingContract.status, 503)
		assert.equal(missingContract.json.code, 'missing_contract')

		process.env.WALLET_SIGNER_CHAT_POINTER_ARRAY = 'Settle_ContractAdmin'
		process.env.WALLET_SIGNER_CHAT_POINTER_CONTRACT = CHAT_POINTER_CONTRACT_PLACEHOLDER
		const settleName = await handleSetChatIndexPointerHttp(pointerBody, deps)
		assert.equal(settleName.deferred, false)
		if (settleName.deferred) return
		assert.equal(settleName.status, 503)
		assert.equal(settleName.json.code, 'points_at_settle_admin')
		assert.equal(settleName.json.retryable, false)

		process.env.WALLET_SIGNER_SETTLE_ARRAY = 'ops_settle'
		process.env.WALLET_SIGNER_CHAT_POINTER_ARRAY = 'ops_settle'
		const alias = await handleSetChatIndexPointerHttp(pointerBody, deps)
		assert.equal(alias.deferred, false)
		if (alias.deferred) return
		assert.equal(alias.status, 503)
		assert.equal(alias.json.code, 'points_at_settle_admin')
		assert.equal(lookups, 0)
		assert.equal(legacyReads, 0)
		assert.equal(sends, 0)
	} finally {
		setFeatures(PREV)
		restorePointerEnv(saved)
	}
})

test('isolated chat pointer HTTP fails closed, then submits setPointerWithSig after the signer recovers', async () => {
	const saved = snapshotPointerEnv()
	let legacyReads = 0
	let lookups = 0
	const sent: { to: string; data: string; chainId: number; value: bigint; gasLimit: bigint }[] = []
	const relay = '0x00000000000000000000000000000000000000aa'
	try {
		setFeatures('settleGasRelay')
		process.env.WALLET_SIGNER_CHAT_POINTER_ARRAY = 'chat_index_pointer'
		process.env.WALLET_SIGNER_CHAT_POINTER_CONTRACT = CHAT_POINTER_CONTRACT_PLACEHOLDER
		delete process.env.WALLET_SIGNER_SETTLE_ARRAY
		const deps = pointerDeps({
			lookup: {
				async accounts(keyArray: string, chainId: number) {
					lookups += 1
					assert.equal(keyArray, 'chat_index_pointer')
					assert.equal(chainId, 224422)
					if (lookups === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:1')
					return [relay]
				},
			},
			readLegacyKeys: () => {
				legacyReads += 1
				return [`0x${'cd'.repeat(32)}`]
			},
			send: async (call) => {
				sent.push(call)
				return { txHash: `0x${'ee'.repeat(32)}` }
			},
		})
		const failed = await handleSetChatIndexPointerHttp(pointerBody, deps)
		assert.equal(failed.deferred, false)
		if (failed.deferred) return
		assert.equal(failed.status, 503)
		assert.equal(failed.json.error, 'signer_unavailable')
		assert.equal(failed.json.retryable, true)
		assert.match(String(failed.json.detail), /ECONNREFUSED/)
		assert.equal(sent.length, 0)
		assert.equal(legacyReads, 0)

		const ready = await handleSetChatIndexPointerHttp(pointerBody, deps)
		assert.equal(ready.deferred, false)
		if (ready.deferred) return
		assert.equal(ready.status, 200)
		assert.equal(ready.json.success, true)
		assert.equal(sent.length, 1)
		const call = sent[0]!
		assert.equal(getAddress(call.to), getAddress(CHAT_POINTER_CONTRACT_PLACEHOLDER))
		assert.equal(call.chainId, 224422)
		assert.equal(call.value, 0n)
		assert.ok(call.gasLimit <= CHAT_POINTER_MAX_GAS)
		const decoded = pointerIface.decodeFunctionData('setPointerWithSig', call.data)
		assert.equal(getAddress(decoded[0]), getAddress(pointerOwner))
		assert.equal(decoded[1], pointerHash)
		assert.equal(decoded[5], pointerSig)
		assert.equal(legacyReads, 0)
	} finally {
		setFeatures(PREV)
		restorePointerEnv(saved)
	}
})

test('chat pointer authorization allows only setPointerWithSig on the configured CoNET contract', () => {
	const saved = snapshotPointerEnv()
	try {
		process.env.WALLET_SIGNER_CHAT_POINTER_ARRAY = 'chat_index_pointer'
		process.env.WALLET_SIGNER_CHAT_POINTER_CONTRACT = CHAT_POINTER_CONTRACT_PLACEHOLDER
		delete process.env.WALLET_SIGNER_SETTLE_ARRAY
		const resolved = resolveChatPointerRelayConfig()
		assert.equal(resolved.ok, true)
		if (!resolved.ok) return
		const config: ChatPointerRelayConfig = resolved.config
		const allowed = authorizeChatPointerCall(config, {
			to: config.contract,
			data: pointerIface.encodeFunctionData('setPointerWithSig', [pointerOwner, pointerHash, 1n, 1n, 0n, pointerSig]),
			chainId: 224422,
			value: 0n,
			gasLimit: 150_000n,
		})
		assert.equal(allowed.ok, true)
		const allowedData = pointerIface.encodeFunctionData('setPointerWithSig', [pointerOwner, pointerHash, 1n, 1n, 0n, pointerSig])
		const otherSelector = id('transfer(address,uint256)').slice(0, 10)
		assert.equal(authorizeChatPointerCall(config, { to: config.contract, data: otherSelector, chainId: 224422, value: 0n }).ok, false)
		assert.equal(authorizeChatPointerCall(config, { to: '0x0000000000000000000000000000000000000002', data: allowedData, chainId: 224422 }).ok, false)
		assert.equal(authorizeChatPointerCall(config, { to: config.contract, data: allowedData, chainId: 224422, value: 1n }).ok, false)
		assert.equal(authorizeChatPointerCall(config, { to: config.contract, data: pointerIface.encodeFunctionData('setPointerWithSig', [pointerOwner, pointerHash, 1n, 1n, 0n, pointerSig]), chainId: 8453, value: 0n }).ok, false)
		assert.equal(authorizeChatPointerCall(config, { to: config.contract, data: pointerIface.encodeFunctionData('setPointerWithSig', [pointerOwner, pointerHash, 1n, 1n, 0n, pointerSig]), chainId: 224422, value: 0n, gasLimit: CHAT_POINTER_MAX_GAS + 1n }).ok, false)
	} finally {
		restorePointerEnv(saved)
	}
})
