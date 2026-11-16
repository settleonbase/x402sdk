/**
 * Replaced-intent rebuild (claim reporter). A replaced batch (txHash without receipt, signer nonce consumed) is rebuilt
 * under a NEW idempotencyKey, because the signer answers a known key with the original hash and duplicate:true.
 * The stub signer implements exactly that dedupe semantics. No network, no socket.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import {
	prepareRebuiltSettleIntent,
	prepareSettleIntent,
	rebuildSignerTxFromIntent,
	type PendingEntryJson,
	type SettleIntent,
} from './vdrDualCursor.js'
import {
	__engHarnessFlushPendingOnce,
	__setFlushTestHooks,
	peekValidatorClRewardPayoutState,
} from './validatorClRewardPayoutReporter.js'

const PROXY = ethers.getAddress('0x' + '5a'.repeat(20))
const SIGNER = ethers.getAddress('0x' + '22'.repeat(20))
const AMT = 16_000_000_000n
const KEY_ARRAY = 'test-key-array'
const DEAD_TX = ethers.id('replace-dead-tx')

function keyOf(label: string): string {
	return ethers.id(`replace:${label}`).toLowerCase()
}

function row(label: string, blockNumber: number): PendingEntryJson {
	return { guardianId: '1', amount: AMT.toString(), eventKey: keyOf(label), blockNumber, withdrawalIndex: 0, scanLine: 'historical' }
}

/** Batch intent for the given labels; with a txHash it is a broadcast intent whose transaction never got a receipt. */
function batchIntent(labels: string[], txHash?: string): SettleIntent {
	const base = prepareSettleIntent({
		to: PROXY,
		guardianIds: labels.map(() => 1n),
		amounts: labels.map(() => AMT),
		eventKeys: labels.map(keyOf),
		gasLimit: 170000,
		keyArray: KEY_ARRAY,
		scanLines: labels.map(() => 'historical'),
	})
	return txHash ? { ...base, status: 'broadcast' as const, txHash } : base
}

function freshFile(): string {
	return path.join(mkdtempSync(path.join(process.env.VDR_TEST_TMP || tmpdir(), 'replace-')), 'state.json')
}

function writeLedger(file: string, pending: PendingEntryJson[], intents: SettleIntent[]): void {
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH: { blockNumber: 150, blockHash: '0x' + 'ab'.repeat(32) },
			historicalCursor: 100,
			realtimeCursor: 150,
			pending,
			settleIntents: intents,
			firstBatchSettledWei: '0',
			updatedAt: new Date().toISOString(),
		})
	)
}

type Chain = {
	txs: Map<string, { from: string; nonce: number }>
	latest: number
	consumed: Set<string>
	receipts: Map<string, { status: number }>
}

function newChain(): Chain {
	return { txs: new Map(), latest: 0, consumed: new Set(), receipts: new Map() }
}

/** Signer with the dedupe semantics: a known idempotencyKey returns the original hash and sends nothing. */
function dedupeSigner(chain: Chain) {
	const seen = new Map<string, string>()
	const stats = { sent: [] as string[], duplicates: 0 }
	const send = async (tx: { idempotencyKey: string }) => {
		const prior = seen.get(tx.idempotencyKey)
		if (prior) {
			stats.duplicates += 1
			return { hash: prior }
		}
		const hash = ethers.id(`replace-tx:${stats.sent.length + 1}`)
		seen.set(tx.idempotencyKey, hash)
		stats.sent.push(tx.idempotencyKey)
		chain.receipts.set(hash, { status: 1 })
		return { hash }
	}
	return { send, stats }
}

function install(file: string, chain: Chain, send: (tx: { idempotencyKey: string }) => Promise<{ hash: string }>): void {
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE = file
	process.env.CONET_VALIDATOR_DEPOSIT_REDEEM = PROXY
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK = '1'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES = '2'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_ESTIMATE_FROM = '0x' + '11'.repeat(20)
	delete process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_PACK_HASH
	const provider = {
		async getFeeData() {
			return { gasPrice: 1_000_000_000n, maxFeePerGas: null }
		},
		async getTransactionReceipt(hash: string) {
			return chain.receipts.get(hash) ?? null
		},
		async getTransaction(hash: string) {
			return chain.txs.get(hash) ?? null
		},
		async getTransactionCount(_addr: string, _tag: string) {
			return chain.latest
		},
	}
	const contract = {
		consumedRewardEventKey: async (k: string) => chain.consumed.has(k.toLowerCase()),
		settleNodeRewards: { estimateGas: async () => 100000n },
	}
	__setFlushTestHooks({
		provider,
		contract: () => contract,
		signerConfig: { socketPath: '/nonexistent-test-socket', keyArray: KEY_ARRAY },
		signerSend: send as never,
	})
}

/** Capture console output (the logger writes through console.log) for alert assertions. */
function captureLog() {
	const lines: string[] = []
	const original = console.log
	console.log = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(' '))
	}
	return { lines, restore: () => (console.log = original) }
}

test('replaced batch is rebuilt under a new key: no stall with a dedupe signer, consumed keys not re-paid', async () => {
	const file = freshFile()
	const dead = batchIntent(['A', 'B'], DEAD_TX)
	writeLedger(file, [row('A', 1), row('B', 1)], [dead])
	const chain = newChain()
	chain.txs.set(DEAD_TX, { from: SIGNER, nonce: 5 })
	chain.latest = 6 // nonce 5 is taken by another transaction: the dead one can never mine
	const signer = dedupeSigner(chain)
	install(file, chain, signer.send)
	const log = captureLog()
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
		log.restore()
	}
	assert.equal(signer.stats.sent.length, 1, 'exactly one new settlement')
	assert.equal(signer.stats.duplicates, 0, 'the signer never answered with a stale duplicate (no stall)')
	assert.notEqual(signer.stats.sent[0], dead.idempotencyKey, 'the rebuild carries a new idempotencyKey')

	const s = peekValidatorClRewardPayoutState()
	assert.equal(s.pending.length, 0, 'A and B settled once')
	assert.equal(s.firstBatchSettledWei, (AMT * 2n).toString(), 'the batch total is credited once')
	const fresh = s.settleIntents.find((i) => i.status === 'confirmed')
	assert.equal(fresh?.idempotencyKey, signer.stats.sent[0])
	assert.deepEqual([...(fresh?.eventKeys ?? [])].sort(), [keyOf('A'), keyOf('B')].sort())
	const kept = s.settleIntents.find((i) => i.idempotencyKey === dead.idempotencyKey)
	assert.equal(kept?.status, 'failed', 'the replaced record stays as failed (audit, no budget reserve)')
	assert.match(kept?.note ?? '', /rebuilt_r1/)
	const alerts = log.lines.filter((l) => l.includes('ALERT intent replaced/dropped'))
	assert.equal(alerts.length, 1, 'one ALERT for the replaced intent')
})

test('partially consumed replaced batch is held: no rebuild, no re-issue of a consumed key', async () => {
	const file = freshFile()
	const dead = batchIntent(['C', 'D'], DEAD_TX)
	writeLedger(file, [row('C', 1), row('D', 1)], [dead])
	const chain = newChain()
	chain.txs.set(DEAD_TX, { from: SIGNER, nonce: 5 })
	chain.latest = 6
	chain.consumed.add(keyOf('C'))
	const signer = dedupeSigner(chain)
	install(file, chain, signer.send)
	const log = captureLog()
	try {
		await __engHarnessFlushPendingOnce({ contractAddr: PROXY, resumeFromState: true })
	} finally {
		__setFlushTestHooks(null)
		log.restore()
	}
	assert.equal(signer.stats.sent.length, 0, 'nothing is signed while the batch is partially consumed')
	const s = peekValidatorClRewardPayoutState()
	assert.equal(s.settleIntents.find((i) => i.idempotencyKey === dead.idempotencyKey)?.status, 'broadcast', 'record left open for an operator')
	assert.equal(s.pending.length, 2, 'C and D stay pending, not re-issued')
	assert.ok(log.lines.some((l) => l.includes('ALERT intent replaced/dropped')), 'the replaced state is alerted')
})

test('a rebuilt intent verifies its own key; a tampered key is refused', () => {
	const plain = batchIntent(['A'])
	const fresh = prepareRebuiltSettleIntent(plain, 1, KEY_ARRAY)
	assert.notEqual(fresh.idempotencyKey, plain.idempotencyKey)
	assert.equal(rebuildSignerTxFromIntent(fresh, KEY_ARRAY).idempotencyKey, fresh.idempotencyKey)
	assert.throws(() => rebuildSignerTxFromIntent({ ...fresh, idempotencyKey: plain.idempotencyKey }, KEY_ARRAY), /drifted/)
})
