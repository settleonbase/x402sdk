/**
 * Flush-level integration tests for the claim reporter (stub provider, stub read contract, stub signer).
 * No network, no socket, no signer process. Covers review R4 items B1, B2 and B3 (unknown / non-boolean
 * results are not signed; consumed removal persists; multi-sub-batch intent and total are preserved).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import { prepareSettleIntent, type PendingEntryJson, type SettleIntent } from './vdrDualCursor.js'
import {
	__engHarnessFlushPendingOnce,
	__setFlushTestHooks,
	peekValidatorClRewardPayoutState,
	type EngHarnessPendingSeed,
} from './validatorClRewardPayoutReporter.js'

const PROXY = ethers.getAddress('0x' + '5a'.repeat(20))
const AMT = 16_000_000_000n
const H_HASH = '0x' + 'ab'.repeat(32)

function keyOf(label: string): string {
	return ethers.id(`flush-it:${label}`).toLowerCase()
}

function seed(label: string, blockNumber: number): EngHarnessPendingSeed {
	return {
		guardianId: '1',
		amount: AMT.toString(),
		eventKey: keyOf(label),
		blockNumber,
		withdrawalIndex: 0,
		scanLine: 'historical',
	}
}

function pendingJson(s: EngHarnessPendingSeed): PendingEntryJson {
	return { ...s, eventKey: s.eventKey.toLowerCase(), scanLine: 'historical' }
}

/** Ledger v2 with boundary H=150, historical cursor 100, realtime cursor 150. */
function writeLedger(file: string, pending: PendingEntryJson[], settleIntents: SettleIntent[] = []): void {
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH: { blockNumber: 150, blockHash: H_HASH },
			historicalCursor: 100,
			realtimeCursor: 150,
			pending,
			settleIntents,
			firstBatchSettledWei: '0',
			updatedAt: new Date().toISOString(),
		})
	)
}

type Env = {
	consumed: (key: string) => unknown
	sent: Array<{ eventKeys?: string[]; idem: string }>
}

function install(file: string, consumed: (key: string) => unknown): Env {
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE = file
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK = '0'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM = '0x' + '11'.repeat(20)
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES = '2'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_HISTORICAL_FLUSH_FLOOR = '8'
	delete process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH
	const receipts = new Map<string, { status: number }>()
	const sent: Env['sent'] = []
	const provider = {
		async getFeeData() {
			return { gasPrice: 1_000_000_000n, maxFeePerGas: null }
		},
		async getTransactionReceipt(hash: string) {
			return receipts.get(hash) ?? null
		},
	}
	const contract = {
		consumedRewardEventKey: async (k: string) => consumed(k),
		settleNodeRewards: { estimateGas: async () => 100000n },
	}
	__setFlushTestHooks({
		provider,
		contract: () => contract,
		signerConfig: { socketPath: '/nonexistent-test-socket', keyArray: 'test-key-array' },
		signerSend: async (tx) => {
			const hash = ethers.id(`flush-it-tx:${sent.length + 1}`)
			sent.push({ idem: tx.idempotencyKey })
			receipts.set(hash, { status: 1 })
			return { hash }
		},
	})
	return { consumed, sent }
}

function freshDir(): string {
	return mkdtempSync(path.join(process.env.VDR_TEST_TMP || tmpdir(), 'flush-it-'))
}

test('B1: second sub-batch consumed removal keeps the first sub-batch intent, settled total and cursors', async () => {
	const file = path.join(freshDir(), 'state.json')
	const A = seed('A', 1)
	const B = seed('B', 1)
	const C = seed('C', 2)
	writeLedger(file, [pendingJson(A), pendingJson(B), pendingJson(C)])
	const env = install(file, (k) => k === keyOf('C'))
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(env.sent.length, 1, 'exactly one settle tx for [A,B]; C is consumed and not signed')
	const s = peekValidatorClRewardPayoutState()
	assert.equal(s.settleIntents.length, 1, 'first sub-batch intent survives the later consumed removal')
	assert.equal(s.settleIntents[0]!.status, 'confirmed')
	assert.deepEqual([...s.settleIntents[0]!.eventKeys].sort(), [keyOf('A'), keyOf('B')].sort())
	assert.equal(s.firstBatchSettledWei, (AMT * 2n).toString(), 'settled total of the first sub-batch is kept')
	assert.equal(s.pending.length, 0, 'A and B removed on confirm, C removed as consumed')
	assert.equal(s.historicalCursor, 100)
	assert.equal(s.realtimeCursor, 150)
	assert.equal(s.boundaryH?.blockNumber, 150)
})

test('B2/B3: a consumed-read error is UNKNOWN: not signed, pending kept', async () => {
	const file = path.join(freshDir(), 'state.json')
	const A = seed('A', 1)
	writeLedger(file, [pendingJson(A)])
	const env = install(file, () => {
		throw new Error('simulated RPC failure')
	})
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(env.sent.length, 0)
	assert.deepEqual(peekValidatorClRewardPayoutState().pending.map((p) => p.eventKey), [keyOf('A')])
})

test('B3: a non-boolean consumed result (1, "yes", undefined) is UNKNOWN: not signed, pending kept', async () => {
	for (const bad of [1, 'yes', undefined]) {
		const file = path.join(freshDir(), 'state.json')
		writeLedger(file, [pendingJson(seed('A', 1))])
		const env = install(file, () => bad)
		try {
			await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
		} finally {
			__setFlushTestHooks(null)
		}
		assert.equal(env.sent.length, 0, `non-boolean ${String(bad)} must not sign`)
		assert.equal(peekValidatorClRewardPayoutState().pending.length, 1)
	}
})

test('B2: in-flight intent with txHash and no receipt yet is not rebuilt or resent', async () => {
	const file = path.join(freshDir(), 'state.json')
	const A = seed('A', 1)
	const keyArray = 'test-key-array'
	const intent = prepareSettleIntent({
		to: PROXY,
		guardianIds: [1n],
		amounts: [AMT],
		eventKeys: [keyOf('A')],
		gasLimit: 170000,
		keyArray,
		scanLines: ['historical'],
	})
	const inFlight: SettleIntent = { ...intent, status: 'broadcast', txHash: ethers.id('inflight-tx') }
	writeLedger(file, [pendingJson(A)], [inFlight])
	const env = install(file, () => false)
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(env.sent.length, 0, 'no resend of the same batch and no new issue of a key owned by an open intent')
	assert.deepEqual(peekValidatorClRewardPayoutState().pending.map((p) => p.eventKey), [keyOf('A')])
})

test('B2: prepared intent whose consumed status is UNKNOWN is held, not resent', async () => {
	const file = path.join(freshDir(), 'state.json')
	const A = seed('A', 1)
	const intent = prepareSettleIntent({
		to: PROXY,
		guardianIds: [1n],
		amounts: [AMT],
		eventKeys: [keyOf('A')],
		gasLimit: 170000,
		keyArray: 'test-key-array',
		scanLines: ['historical'],
	})
	writeLedger(file, [pendingJson(A)], [{ ...intent, status: 'prepared' }])
	const env = install(file, () => {
		throw new Error('simulated RPC failure')
	})
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(env.sent.length, 0, 'unknown on-chain status must not sign')
	assert.equal(peekValidatorClRewardPayoutState().pending.length, 1)
})
