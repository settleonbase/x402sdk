/**
 * Dual-flow regression tests for the claim reporter. Stub provider / contract / signer only; no network, no socket.
 * (b) A restart between scan steps leaves no gap: H is fixed once and persisted; history resumes at its last
 *     contiguous block + 1 up to H; realtime starts at H + 1.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import {
	__engHarnessResetStateCache,
	__engHarnessRunTickOnce,
	__setFlushTestHooks,
	peekValidatorClRewardPayoutState,
} from './validatorClRewardPayoutReporter.js'

type Chain = {
	head: number
	hangAtOrBelow: number
	fetched: number[]
	withdrawals: Map<number, unknown[]>
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
		async getTransactionReceipt(_hash: string) {
			return null
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

/** Fresh ledger: no H yet, both cursors at the floor-1 (deploy block 1). */
function writeFreshLedger(file: string): void {
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH: null,
			historicalCursor: 0,
			realtimeCursor: 0,
			pending: [],
			settleIntents: [],
			firstBatchSettledWei: '0',
			updatedAt: new Date().toISOString(),
		})
	)
}

function install(file: string, chain: Chain): void {
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE = file
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK = '1'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNK_BLOCKS = '32'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM = '0x' + '11'.repeat(20)
	delete process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH
	const contract = {
		consumedRewardEventKey: async (_k: string) => false,
		settleNodeRewards: { estimateGas: async () => 100000n },
	}
	__setFlushTestHooks({
		provider: makeProvider(chain),
		contract: () => contract,
		signerConfig: { socketPath: '/nonexistent-test-socket', keyArray: 'test-key-array' },
		signerSend: async () => {
			throw new Error('signer must not be called in scan-only tests')
		},
	})
}

test('b: a restart between scan steps leaves no gap; H is fixed and persisted', async () => {
	const file = freshFile()
	writeFreshLedger(file)
	const chain: Chain = { head: 60, hangAtOrBelow: -1, fetched: [], withdrawals: new Map() }
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
