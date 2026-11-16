/**
 * Regression tests for the serial state writer (mutateState) of the claim reporter.
 * (a) state is not held across an await: a write from another call during the signer await survives the submit merge;
 * (c) two concurrent merges run one after another and both results are kept;
 * (d) a throwing merge aborts only itself.
 * Stub provider / contract / signer only: no network, no socket.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import { attachIntentToState, prepareSettleIntent, type PendingEntryJson, type SettleIntent } from './vdrDualCursor.js'
import {
	__engHarnessFlushPendingOnce,
	__setFlushTestHooks,
	mutateState,
	peekValidatorClRewardPayoutState,
} from './validatorClRewardPayoutReporter.js'

const PROXY = ethers.getAddress('0x' + '5a'.repeat(20))
const AMT = 16_000_000_000n
const H_HASH = '0x' + 'ab'.repeat(32)
const KEY_ARRAY = 'test-key-array'

function keyOf(label: string): string {
	return ethers.id(`state-mut:${label}`).toLowerCase()
}

function pendingRow(label: string, blockNumber: number): PendingEntryJson {
	return {
		guardianId: '1',
		amount: AMT.toString(),
		eventKey: keyOf(label),
		blockNumber,
		withdrawalIndex: 0,
		scanLine: 'historical',
	}
}

function writeLedger(file: string, pending: PendingEntryJson[]): void {
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH: { blockNumber: 150, blockHash: H_HASH },
			historicalCursor: 100,
			realtimeCursor: 150,
			pending,
			settleIntents: [] as SettleIntent[],
			firstBatchSettledWei: '0',
			updatedAt: new Date().toISOString(),
		})
	)
}

function freshFile(): string {
	return path.join(mkdtempSync(path.join(process.env.VDR_TEST_TMP || tmpdir(), 'state-mut-')), 'state.json')
}

function intentFor(label: string): SettleIntent {
	return prepareSettleIntent({
		to: PROXY,
		guardianIds: [1n],
		amounts: [AMT],
		eventKeys: [keyOf(label)],
		gasLimit: 170000,
		keyArray: KEY_ARRAY,
		scanLines: ['historical'],
	})
}

function setEnv(file: string): void {
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE = file
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK = '0'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM = '0x' + '11'.repeat(20)
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES = '2'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_HISTORICAL_FLUSH_FLOOR = '8'
	delete process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH
}

/** Stub chain: no key consumed, every settle receipt status 1. `beforeSend` runs inside the signer await. */
function installStub(beforeSend: () => Promise<void>): { sent: number } {
	const receipts = new Map<string, { status: number }>()
	const env = { sent: 0 }
	const provider = {
		async getFeeData() {
			return { gasPrice: 1_000_000_000n, maxFeePerGas: null }
		},
		async getTransactionReceipt(hash: string) {
			return receipts.get(hash) ?? null
		},
		async getTransaction(_hash: string) {
			return null
		},
		async getTransactionCount(_addr: string, _tag: string) {
			return 0
		},
	}
	const contract = {
		consumedRewardEventKey: async (_k: string) => false,
		settleNodeRewards: { estimateGas: async () => 100000n },
	}
	__setFlushTestHooks({
		provider,
		contract: () => contract,
		signerConfig: { socketPath: '/nonexistent-test-socket', keyArray: KEY_ARRAY },
		signerSend: async () => {
			await beforeSend()
			const hash = ethers.id(`state-mut-tx:${env.sent + 1}`)
			env.sent += 1
			receipts.set(hash, { status: 1 })
			return { hash }
		},
	})
	return env
}

test('a1: an intent written by another call during the signer await survives the submit merge', async () => {
	const file = freshFile()
	writeLedger(file, [pendingRow('A', 1), pendingRow('B', 1)])
	setEnv(file)
	const other = intentFor('Z')
	const env = installStub(async () => {
		await mutateState((s) => attachIntentToState(s, other))
	})
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(env.sent, 1, 'one settle for [A,B]')
	const s = peekValidatorClRewardPayoutState()
	assert.ok(
		s.settleIntents.some((i) => i.idempotencyKey === other.idempotencyKey),
		'the intent written during the await is kept'
	)
	const mine = s.settleIntents.find((i) => i.idempotencyKey !== other.idempotencyKey)
	assert.equal(mine?.status, 'confirmed', 'the submitted batch intent is still confirmed')
	assert.equal(s.pending.length, 0)
})

test('a2: a settled credit written during the signer await is not overwritten by the submit merge', async () => {
	const file = freshFile()
	writeLedger(file, [pendingRow('A', 1), pendingRow('B', 1)])
	setEnv(file)
	const EXTRA = 7n
	const env = installStub(async () => {
		await mutateState((s) => ({
			...s,
			firstBatchSettledWei: (BigInt(s.firstBatchSettledWei ?? '0') + EXTRA).toString(),
		}))
	})
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(env.sent, 1)
	const s = peekValidatorClRewardPayoutState()
	assert.equal(s.firstBatchSettledWei, (AMT * 2n + EXTRA).toString(), 'external credit and the batch total are both kept')
	assert.equal(s.pending.length, 0)
})

test('c: two concurrent mutateState calls run one after another and both results are kept', async () => {
	const file = freshFile()
	writeLedger(file, [])
	setEnv(file)
	const trace: string[] = []
	const ia = intentFor('A')
	const ib = intentFor('B')
	const pa = mutateState((s) => {
		trace.push('a:start')
		const next = attachIntentToState(s, ia)
		trace.push('a:end')
		return next
	})
	const pb = mutateState((s) => {
		trace.push('b:start')
		if (!s.settleIntents.some((i) => i.idempotencyKey === ia.idempotencyKey)) {
			throw new Error('b ran before a was committed')
		}
		const next = attachIntentToState(s, ib)
		trace.push('b:end')
		return next
	})
	await Promise.all([pa, pb])
	assert.deepEqual(trace, ['a:start', 'a:end', 'b:start', 'b:end'])
	const s = peekValidatorClRewardPayoutState()
	assert.deepEqual(
		s.settleIntents.map((i) => i.idempotencyKey).sort(),
		[ia.idempotencyKey, ib.idempotencyKey].sort(),
		'both merges are kept'
	)
})

test('d: a throwing merge aborts only itself; later merges still commit', async () => {
	const file = freshFile()
	writeLedger(file, [])
	setEnv(file)
	const ia = intentFor('A')
	const bad = mutateState(() => {
		throw new Error('merge refused')
	})
	const good = mutateState((s) => attachIntentToState(s, ia))
	await assert.rejects(bad, /merge refused/)
	await good
	assert.equal(peekValidatorClRewardPayoutState().settleIntents.length, 1)
})
