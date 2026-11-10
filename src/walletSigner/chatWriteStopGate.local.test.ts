/**
 * Chat write stop: refuse new pointer writes, keep unreconciled remote tokens,
 * and do not send those nonces through the legacy pool.
 * This file does not import util.ts, settleContractPool.ts, chatIndexPointer.ts, or beamioMaster.ts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Interface, getAddress } from 'ethers'
import { CHAT_POINTER_METHOD } from './chatPointerRelayGate'
import { handleSetChatIndexPointerHttp, type ChatPointerHttpDeps } from './chatPointerRelayGate'
import { submitIsolatedChatPointer } from './chatPointerIsolatedSend'
import {
	chatPointerReadsOpen,
	chatWritesStopped,
	decideRemoteChatToken,
	explicitChatRelayArray,
	legacyPoolMayResendChatNonce,
	resetChatWriteStopForTests,
	retainedRemoteChatToken,
} from './chatWriteStopGate'
import {
	isolatedChatRelayHeldCount,
	isolatedChatRelayIdleCount,
	resetIsolatedChatRelayForTests,
	setIsolatedChatRelayIdle,
} from './isolatedChatRelayPool'
import { RemoteSigner, WalletSignerClient, walletSignerFeatureEnabled } from './remoteSigner'
import { chatRelayRoute, settleGasRelayIsolationActive, settleLegacyPrivateKeyClosed } from './settleLegacyKeyGate'

const here = dirname(fileURLToPath(import.meta.url))
const pointerIface = new Interface([`function ${CHAT_POINTER_METHOD}`])
const owner = '0x0000000000000000000000000000000000000001'
const indexHash = `0x${'11'.repeat(32)}`
const signature = `0x${'ab'.repeat(65)}`
process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = join(mkdtempSync(join(tmpdir(), 'chat-stop-gate-ledger-')), 'ledger.json')
const PREV_FEATURES = process.env.WALLET_SIGNER_FEATURES
const PREV_WRITES = process.env.WALLET_SIGNER_CHAT_WRITES
const PREV_ARRAY = process.env.WALLET_SIGNER_CHAT_ARRAY
const PREV_SETTLE_ARRAY = process.env.WALLET_SIGNER_SETTLE_ARRAY

function setFeatures(value: string | undefined): void {
	if (value === undefined) delete process.env.WALLET_SIGNER_FEATURES
	else process.env.WALLET_SIGNER_FEATURES = value
}

function setWrites(value: string | undefined): void {
	if (value === undefined) delete process.env.WALLET_SIGNER_CHAT_WRITES
	else process.env.WALLET_SIGNER_CHAT_WRITES = value
}

function restoreEnv(): void {
	setFeatures(PREV_FEATURES)
	setWrites(PREV_WRITES)
	if (PREV_ARRAY === undefined) delete process.env.WALLET_SIGNER_CHAT_ARRAY
	else process.env.WALLET_SIGNER_CHAT_ARRAY = PREV_ARRAY
	if (PREV_SETTLE_ARRAY === undefined) delete process.env.WALLET_SIGNER_SETTLE_ARRAY
	else process.env.WALLET_SIGNER_SETTLE_ARRAY = PREV_SETTLE_ARRAY
	resetChatWriteStopForTests()
	resetIsolatedChatRelayForTests()
}

function pointerCalldata(nonce = 0n): string {
	return pointerIface.encodeFunctionData('setPointerWithSig', [owner, indexHash, 1n, 1n, nonce, signature])
}

function httpDeps(counts: { lookups: number; legacyReads: number; sends: number }, isolationActive: boolean): ChatPointerHttpDeps {
	return {
		isolationActive,
		env: process.env,
		lookup: {
			async accounts() {
				counts.lookups += 1
				return [owner]
			},
		},
		readLegacyKeys: () => {
			counts.legacyReads += 1
			return [`0x${'cd'.repeat(32)}`]
		},
		send: async () => {
			counts.sends += 1
			return { txHash: `0x${'ee'.repeat(32)}` }
		},
	}
}

test('clearing WALLET_SIGNER_FEATURES is not a chat write stop', () => {
	try {
		setWrites(undefined)
		setFeatures(undefined)
		assert.equal(chatWritesStopped(), false)
		assert.equal(chatRelayRoute(), 'legacy')
		setFeatures('')
		assert.equal(chatRelayRoute(), 'legacy')
		setWrites('off')
		assert.equal(chatWritesStopped(), false)
		assert.equal(chatRelayRoute(), 'legacy')
		setWrites('')
		assert.equal(chatRelayRoute(), 'legacy')
	} finally {
		restoreEnv()
	}
})

test('WALLET_SIGNER_CHAT_WRITES=stopped refuses every chat route and leaves other features alone', () => {
	try {
		setWrites('stopped')
		for (const features of [undefined, '', 'chat', 'settleGasRelay', 'settle', 'all', 'gbAirdrop,registration']) {
			setFeatures(features)
			assert.equal(chatRelayRoute(), 'chat-writes-stopped')
			assert.equal(chatPointerReadsOpen(), true)
		}
		setFeatures('gbAirdrop,registration')
		assert.equal(walletSignerFeatureEnabled('gbAirdrop'), true)
		assert.equal(walletSignerFeatureEnabled('registration'), true)
		assert.equal(settleLegacyPrivateKeyClosed('executeForAdmin admin signature'), null)
		setFeatures('settleGasRelay')
		assert.equal(settleGasRelayIsolationActive(), true)
		assert.equal(chatRelayRoute(), 'chat-writes-stopped')
		setFeatures('settle')
		assert.match(settleLegacyPrivateKeyClosed('guardian oracle')!, /closed/)
		assert.equal(chatRelayRoute(), 'chat-writes-stopped')
	} finally {
		restoreEnv()
	}
})

test('stopped chat HTTP does not defer, send, or read legacy keys', async () => {
	const counts = { lookups: 0, legacyReads: 0, sends: 0 }
	try {
		setWrites('stopped')
		setFeatures(undefined)
		const body = { owner, indexHash, ts: '1', seq: '1', nonce: '0', signature }
		const isolatedOff = await handleSetChatIndexPointerHttp(body, httpDeps(counts, false))
		assert.equal(isolatedOff.deferred, false)
		if (isolatedOff.deferred) return
		assert.equal(isolatedOff.status, 503)
		assert.equal(isolatedOff.json.code, 'chat_writes_stopped')
		assert.equal(isolatedOff.json.retryable, false)
		assert.equal(isolatedOff.json.legacyFallback, false)

		setFeatures('settleGasRelay')
		const isolatedOn = await handleSetChatIndexPointerHttp(body, httpDeps(counts, true))
		assert.equal(isolatedOn.deferred, false)
		if (isolatedOn.deferred) return
		assert.equal(isolatedOn.status, 503)
		assert.equal(isolatedOn.json.code, 'chat_writes_stopped')
		assert.equal(counts.lookups, 0)
		assert.equal(counts.legacyReads, 0)
		assert.equal(counts.sends, 0)
	} finally {
		restoreEnv()
	}
})

test('first chat batch refuses a missing or settle-admin array', () => {
	try {
		delete process.env.WALLET_SIGNER_CHAT_ARRAY
		delete process.env.WALLET_SIGNER_SETTLE_ARRAY
		assert.equal(explicitChatRelayArray(), null)
		process.env.WALLET_SIGNER_CHAT_ARRAY = 'settle_contractAdmin'
		assert.equal(explicitChatRelayArray(), null)
		process.env.WALLET_SIGNER_CHAT_ARRAY = 'Settle_ContractAdmin'
		assert.equal(explicitChatRelayArray(), null)
		process.env.WALLET_SIGNER_SETTLE_ARRAY = 'ops_settle'
		process.env.WALLET_SIGNER_CHAT_ARRAY = 'ops_settle'
		assert.equal(explicitChatRelayArray(), null)
		process.env.WALLET_SIGNER_CHAT_ARRAY = 'chat_index_pointer'
		assert.equal(explicitChatRelayArray(), 'chat_index_pointer')
		const pools = readFileSync(join(here, 'pools.ts'), 'utf8')
		assert.match(pools, /WALLET_SIGNER_CHAT_ARRAY\?\.trim\(\) \|\| ''/)
		assert.equal(pools.includes("|| 'settle_contractAdmin'"), false)
	} finally {
		restoreEnv()
	}
})

test('unconfirmed and abandoned remote tokens stay retained', () => {
	assert.deepEqual(decideRemoteChatToken('confirmed'), { releaseToken: true, retainToken: false, legacyMayResend: false })
	assert.deepEqual(decideRemoteChatToken('not-sent'), { releaseToken: true, retainToken: false, legacyMayResend: true })
	assert.deepEqual(decideRemoteChatToken('unconfirmed'), { releaseToken: false, retainToken: true, legacyMayResend: false })
	assert.deepEqual(decideRemoteChatToken('abandoned'), { releaseToken: false, retainToken: true, legacyMayResend: false })
})

test('an unconfirmed isolated send keeps the remote token and blocks a legacy resend', async () => {
	const original = RemoteSigner.prototype.sendTransaction
	const client = new WalletSignerClient({ url: 'unix:/tmp/wallet-signer-chat-stop-test.sock' })
	const relayer = getAddress('0x00000000000000000000000000000000000000aa')
	try {
		setWrites(undefined)
		setFeatures('settleGasRelay')
		RemoteSigner.prototype.sendTransaction = async () => ({ hash: `0x${'ab'.repeat(32)}`, wait: async () => null }) as never
		setIsolatedChatRelayIdle([
			new RemoteSigner(client, { keyArray: 'chat_index_pointer', chainId: 224422, address: relayer }),
		])
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: pointerCalldata(0n),
			value: 0n,
			gasLimit: 150_000n,
		}), /chat_pointer_unreconciled/)
		assert.equal(isolatedChatRelayIdleCount(), 0)
		assert.equal(isolatedChatRelayHeldCount(), 1)
		const kept = retainedRemoteChatToken(`chat:${owner.toLowerCase()}:0`)
		assert.equal(kept?.phase, 'unconfirmed')
		assert.equal(legacyPoolMayResendChatNonce(owner, '0'), false)
		setFeatures(undefined)
		setWrites(undefined)
		assert.equal(chatRelayRoute(), 'legacy')
		assert.equal(legacyPoolMayResendChatNonce(owner, '0'), false)

		setWrites('stopped')
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: pointerCalldata(1n),
			value: 0n,
			gasLimit: 150_000n,
		}), /chat_writes_stopped/)
		assert.equal(isolatedChatRelayIdleCount(), 0)
		assert.equal(isolatedChatRelayHeldCount(), 1)
		assert.equal(legacyPoolMayResendChatNonce(owner, '0'), false)
	} finally {
		RemoteSigner.prototype.sendTransaction = original
		restoreEnv()
	}
})

test('a confirmed isolated send releases the remote token', async () => {
	const original = RemoteSigner.prototype.sendTransaction
	const client = new WalletSignerClient({ url: 'unix:/tmp/wallet-signer-chat-stop-test.sock' })
	const relayer = getAddress('0x00000000000000000000000000000000000000aa')
	try {
		setWrites(undefined)
		RemoteSigner.prototype.sendTransaction = async () => ({ hash: `0x${'cd'.repeat(32)}`, wait: async () => ({ status: 1 }) }) as never
		setIsolatedChatRelayIdle([
			new RemoteSigner(client, { keyArray: 'chat_index_pointer', chainId: 224422, address: relayer }),
		])
		const sent = await submitIsolatedChatPointer({
			to: owner,
			data: pointerCalldata(2n),
			value: 0n,
			gasLimit: 150_000n,
		})
		assert.match(sent.txHash, /^0xcd/)
		assert.equal(isolatedChatRelayHeldCount(), 0)
		assert.equal(isolatedChatRelayIdleCount(), 1)
		assert.equal(retainedRemoteChatToken(`chat:${owner.toLowerCase()}:2`), undefined)
		assert.equal(legacyPoolMayResendChatNonce(owner, '2'), true)
	} finally {
		RemoteSigner.prototype.sendTransaction = original
		restoreEnv()
	}
})

test('abandoned and not-sent isolated sends keep or release the token', async () => {
	const original = RemoteSigner.prototype.sendTransaction
	const client = new WalletSignerClient({ url: 'unix:/tmp/wallet-signer-chat-stop-test.sock' })
	const relayer = getAddress('0x00000000000000000000000000000000000000aa')
	try {
		setWrites(undefined)
		RemoteSigner.prototype.sendTransaction = async () => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:1')
		}
		setIsolatedChatRelayIdle([
			new RemoteSigner(client, { keyArray: 'chat_index_pointer', chainId: 224422, address: relayer }),
		])
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: pointerCalldata(3n),
			value: 0n,
			gasLimit: 150_000n,
		}), /ECONNREFUSED/)
		assert.equal(isolatedChatRelayHeldCount(), 0)
		assert.equal(isolatedChatRelayIdleCount(), 1)
		assert.equal(legacyPoolMayResendChatNonce(owner, '3'), false)

		RemoteSigner.prototype.sendTransaction = async () => ({
			hash: `0x${'ef'.repeat(32)}`,
			wait: async () => {
				throw new Error('wait for transaction timeout')
			},
		}) as never
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: pointerCalldata(4n),
			value: 0n,
			gasLimit: 150_000n,
		}), /chat_pointer_unreconciled/)
		assert.equal(isolatedChatRelayIdleCount(), 0)
		assert.equal(isolatedChatRelayHeldCount(), 1)
		assert.equal(retainedRemoteChatToken(`chat:${owner.toLowerCase()}:4`)?.phase, 'abandoned')
		assert.equal(legacyPoolMayResendChatNonce(owner, '4'), false)
	} finally {
		RemoteSigner.prototype.sendTransaction = original
		restoreEnv()
	}
})

test('pointer read route stays independent of the write stop', () => {
	const server = readFileSync(join(here, '../endpoint/beamioServer.ts'), 'utf8')
	const from = server.indexOf("router.get('/chatIndexPointer'")
	assert.ok(from >= 0)
	const to = server.indexOf("router.post('/setChatIndexPointer'", from)
	assert.ok(to > from)
	const read = server.slice(from, to)
	assert.match(read, /getPointer/)
	assert.match(read, /nonceOf/)
	assert.equal(read.includes('chatWritesStopped'), false)
	assert.equal(read.includes('enqueueChatIndexPointerRelay'), false)
	const relay = readFileSync(join(here, '../chatIndexPointer.ts'), 'utf8')
	assert.match(relay, /code: 'refuses_default_settle_array'/)
	assert.match(relay, /legacyPoolMayResendChatNonce/)
	assert.match(relay, /legacyFallback: false/)
})
