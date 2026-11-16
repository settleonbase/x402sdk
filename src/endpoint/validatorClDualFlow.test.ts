/**
 * Dual-flow regression tests for the claim reporter. Stub provider / contract / signer only; no network, no socket.
 * (b) A restart between scan steps leaves no gap: H is fixed once and persisted; history resumes at its last
 *     contiguous block + 1 up to H; realtime starts at H + 1.
 * (c) A hung historical RPC does not block realtime scanning, queueing or payment.
 * (d) The first batch reads only its own keys (no full-queue scan) and signing runs through one serial lane.
 * (e) The same key arriving from both lines is paid once.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import { commitScanProgress } from './vdrDualCursor.js'
import {
	__engHarnessResetStateCache,
	__engHarnessRunTickOnce,
	__engHarnessRunWorkerOnce,
	__setFlushTestHooks,
	mutateState,
	peekValidatorClRewardPayoutState,
	type FlushTestHooks,
} from './validatorClRewardPayoutReporter.js'

const PROXY = ethers.getAddress('0x' + '5a'.repeat(20))
const PUBKEY = '0x' + '11'.repeat(48)
const BENEFICIARY = ethers.getAddress('0x' + '33'.repeat(20))

type Chain = {
	head: number
	/** Block numbers at or below this value never answer (RPC hang). */
	hangAtOrBelow: number
	fetched: number[]
	withdrawals: Map<number, unknown[]>
	receipts: Map<string, { status: number }>
}

function hashOf(n: number): string {
	return ethers.id(`block:${n}`).toLowerCase()
}

function makeProvider(chain: Chain) {
	return {
		async getBlockNumber() {
			return chain.head
		},
		async send(method: string, params: unknown[]) {
			if (method !== 'eth_getBlockByNumber') throw new Error(`unexpected rpc ${method}`)
			const n = Number(BigInt(params[0] as string))
			chain.fetched.push(n)
			if (n <= chain.hangAtOrBelow) return await new Promise<never>(() => {})
			return { number: ethers.toQuantity(n), hash: hashOf(n), withdrawals: chain.withdrawals.get(n) ?? [] }
		},
		async getFeeData() {
			return { gasPrice: 1_000_000_000n, maxFeePerGas: null }
		},
		async getTransactionReceipt(hash: string) {
			return chain.receipts.get(hash) ?? null
		},
		async getTransaction(_hash: string) {
			return null
		},
		async getTransactionCount(_addr: string, _tag: string) {
			return 0
		},
	}
}

function freshFile(): string {
	return path.join(mkdtempSync(path.join(process.env.VDR_TEST_TMP || tmpdir(), 'dual-flow-')), 'state.json')
}

function writeLedger(file: string, boundaryH: number | null, historicalCursor: number, realtimeCursor: number): void {
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH: boundaryH === null ? null : { blockNumber: boundaryH, blockHash: hashOf(boundaryH) },
			historicalCursor,
			realtimeCursor,
			pending: [],
			settleIntents: [],
			firstBatchSettledWei: '0',
			updatedAt: new Date().toISOString(),
		})
	)
}

type InstallOpts = {
	signer?: NonNullable<FlushTestHooks['signerSend']>
	workerTimeoutMs?: number
	onConsumedRead?: () => void
}

function install(file: string, chain: Chain, opts: InstallOpts = {}): void {
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE = file
	process.env.CONET_VALIDATOR_DEPOSIT_REDEEM = PROXY
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK = '1'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNK_BLOCKS = '32'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES = '2'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM = '0x' + '11'.repeat(20)
	delete process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH
	const contract = {
		consumedRewardEventKey: async (_k: string) => {
			opts.onConsumedRead?.()
			return false
		},
		settleNodeRewards: { estimateGas: async () => 100000n },
		getNodeByValidatorPubkeyHash: async (_h: string) => 1n,
		guardianIdBeneficiary: async (_g: bigint) => BENEFICIARY,
	}
	__setFlushTestHooks({
		provider: makeProvider(chain),
		contract: () => contract,
		signerConfig: { socketPath: '/nonexistent-test-socket', keyArray: 'test-key-array' },
		signerSend:
			opts.signer ??
			(async () => {
				throw new Error('signer must not be called in this test')
			}),
		workerTimeoutMs: opts.workerTimeoutMs ?? 5_000,
	})
}

function newChain(head: number, hangAtOrBelow = -1): Chain {
	return { head, hangAtOrBelow, fetched: [], withdrawals: new Map(), receipts: new Map() }
}

test('b: a restart between scan steps leaves no gap; H is fixed and persisted', async () => {
	const file = freshFile()
	writeLedger(file, null, 0, 0)
	const chain = newChain(60)
	install(file, chain)
	try {
		await __engHarnessRunTickOnce() // H locks at 58; history 1..32
		assert.equal(peekValidatorClRewardPayoutState().boundaryH?.blockNumber, 58)
		assert.equal(peekValidatorClRewardPayoutState().historicalCursor, 32)

		__engHarnessResetStateCache() // restart
		await __engHarnessRunTickOnce() // history 33..58, realtime idle
		assert.equal(peekValidatorClRewardPayoutState().historicalCursor, 58)

		__engHarnessResetStateCache() // restart
		chain.head = 100
		await __engHarnessRunTickOnce() // H stays 58; realtime 59..90
		assert.equal(peekValidatorClRewardPayoutState().realtimeCursor, 90)
		assert.equal(peekValidatorClRewardPayoutState().boundaryH?.blockNumber, 58, 'H is not re-fixed after restart')

		__engHarnessResetStateCache() // restart
		await __engHarnessRunTickOnce() // realtime 91..98
		assert.equal(peekValidatorClRewardPayoutState().realtimeCursor, 98)
	} finally {
		__setFlushTestHooks(null)
	}
	const seen = new Set(chain.fetched)
	for (let n = 1; n <= 98; n++) assert.ok(seen.has(n), `block ${n} was scanned (no gap across restarts)`)
	assert.deepEqual(peekValidatorClRewardPayoutState().boundaryH, { blockNumber: 58, blockHash: hashOf(58) })
})

test('c: a hung historical RPC does not block realtime scanning, queueing or payment', async () => {
	const file = freshFile()
	writeLedger(file, 98, 0, 98)
	const chain = newChain(110, 50) // history reads (blocks 1..50) hang; H=98 and realtime 99..108 answer
	chain.withdrawals.set(99, [{ index: '7', validatorIndex: '5', address: PROXY, amount: '1000000' }])
	let signed = 0
	install(file, chain, {
		workerTimeoutMs: 300,
		signer: async () => {
			signed += 1
			const hash = ethers.id(`c-tx:${signed}`)
			chain.receipts.set(hash, { status: 1 })
			return { hash }
		},
	})
	const realFetch = globalThis.fetch
	// Beacon REST answers the validator pubkey for the realtime withdrawal.
	globalThis.fetch = (async () => ({
		ok: true,
		json: async () => ({ data: { validator: { pubkey: PUBKEY } } }),
	})) as unknown as typeof fetch
	try {
		const historical = __engHarnessRunWorkerOnce('historical') // hangs on block 1
		assert.equal(await __engHarnessRunWorkerOnce('realtime'), 'done', 'realtime step completes')
		assert.equal(peekValidatorClRewardPayoutState().pending.length, 1, 'realtime row enqueued while history hung')
		assert.equal(await __engHarnessRunWorkerOnce('flush'), 'done', 'flush step completes')
		const s = peekValidatorClRewardPayoutState()
		assert.equal(s.realtimeCursor, 108, 'realtime line advanced while history hung')
		assert.equal(s.pending.length, 0, 'realtime row paid and removed')
		assert.equal(signed, 1, 'exactly one settle for the realtime row')
		assert.equal(await historical, 'timeout', 'the hung history step is reported as UNKNOWN and released')
		assert.equal(peekValidatorClRewardPayoutState().historicalCursor, 0, 'history cursor did not move without blocks')
	} finally {
		__setFlushTestHooks(null)
		globalThis.fetch = realFetch
	}
})

test('d: the first batch reads only its own keys and signing is serial through one lane', async () => {
	const file = freshFile()
	const rows = Array.from({ length: 300 }, (_, i) => ({
		guardianId: '1',
		amount: '1000000000000000',
		eventKey: ethers.id(`d-row:${i}`).toLowerCase(),
		blockNumber: 1 + i,
		withdrawalIndex: 0,
		scanLine: 'historical',
	}))
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH: { blockNumber: 98, blockHash: hashOf(98) },
			historicalCursor: 98,
			realtimeCursor: 98,
			pending: rows,
			settleIntents: [],
			firstBatchSettledWei: '0',
			updatedAt: new Date().toISOString(),
		})
	)
	const chain = newChain(110)
	let reads = 0
	let readsAtFirstSign = -1
	let signs = 0
	let inflight = 0
	let maxInflight = 0
	install(file, chain, {
		onConsumedRead: () => {
			reads += 1
		},
		signer: async () => {
			if (signs === 0) readsAtFirstSign = reads
			inflight += 1
			maxInflight = Math.max(maxInflight, inflight)
			await new Promise((resolve) => setImmediate(resolve))
			inflight -= 1
			signs += 1
			const hash = ethers.id(`d-tx:${signs}`)
			chain.receipts.set(hash, { status: 1 })
			return { hash }
		},
	})
	try {
		// Two flush steps at once: one lane only; the second is refused while the first is busy.
		const outcomes = await Promise.all([__engHarnessRunWorkerOnce('flush'), __engHarnessRunWorkerOnce('flush')])
		assert.deepEqual([...outcomes].sort(), ['busy', 'done'])
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(readsAtFirstSign, 2, 'before the first signature only the batch keys (2) were read, not the 300-row queue')
	assert.equal(reads, 2, 'the step read consumed status only for the keys of the batch it signed')
	assert.equal(signs, 1)
	assert.equal(maxInflight, 1, 'signing is serial through one lane')
	assert.equal(peekValidatorClRewardPayoutState().pending.length, 298, 'the rest of the queue is untouched')
})

test('e: the same key arriving from both lines is paid once', async () => {
	const file = freshFile()
	writeLedger(file, 98, 0, 98)
	const chain = newChain(110)
	let signed = 0
	install(file, chain, {
		signer: async () => {
			signed += 1
			const hash = ethers.id(`e-tx:${signed}`)
			chain.receipts.set(hash, { status: 1 })
			return { hash }
		},
	})
	const row = {
		guardianId: '1',
		amount: '1000000000000000',
		eventKey: ethers.id('e-row').toLowerCase(),
		blockNumber: 99,
		withdrawalIndex: 7,
		scanLine: 'historical' as const,
	}
	try {
		// The historical line commits the row first; the realtime line then reports the same key.
		await mutateState((s) => commitScanProgress(s, { line: 'historical', okThrough: 98, entries: [row] }))
		await mutateState((s) => commitScanProgress(s, { line: 'realtime', okThrough: 108, entries: [{ ...row, scanLine: 'realtime' }] }))
		assert.equal(peekValidatorClRewardPayoutState().pending.length, 1, 'one row for the key, not two')
		// Two flush steps at once: one signs, the other is busy; a later step finds nothing left to pay.
		await Promise.all([__engHarnessRunWorkerOnce('flush'), __engHarnessRunWorkerOnce('flush')])
		await __engHarnessRunWorkerOnce('flush')
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(signed, 1, 'the key is paid exactly once')
	assert.equal(peekValidatorClRewardPayoutState().pending.length, 0)
})
