/**
 * Dual-flow regression tests for the claim reporter. Stub provider / contract / signer only; no network, no socket.
 * (b)  Each process start fixes H anew from the live confirmed block. History resumes at its last contiguous block + 1
 *      and fills up to the new H; realtime starts at H + 1; no block is committed twice.
 * (b2) A realtime span left by an earlier start is skipped by history, never rescanned.
 * (b3) A candidate below a cursor is held: H never moves backward and nothing is scanned.
 * (b4) Random restarts keep every cursor monotone and commit every block exactly once.
 * (c)  A hung historical RPC does not block realtime scanning, queueing or payment.
 * (d)  The first batch reads only its own keys (no full-queue scan) and signing runs through one serial lane.
 * (e)  The same key arriving from both lines is paid once.
 * (f)  An H candidate with no readable hash, or another height, is UNKNOWN: no lock and no tip-hash fallback.
 * (g)  An unreadable or wrong-height block in the reorg check is UNKNOWN, not a reorg: no rollback.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import { commitScanProgress, type DualCursorState } from './vdrDualCursor.js'
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
	/** Heights whose block read returns null (unreadable). */
	missing: Set<number>
	/** Heights whose block reports another number (wrong height). */
	wrongHeight: Set<number>
	fetched: number[]
	withdrawals: Map<number, unknown[]>
	receipts: Map<string, { status: number }>
}

type Commit = { line: string; from: number; okThrough: number }

/** Scan windows committed through the serial ledger writer during the current test (reset by install). */
let scanLog: Commit[] = []
let skipLog: { from: number; to: number }[] = []

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
			if (chain.missing.has(n)) return null
			const reported = chain.wrongHeight.has(n) ? n + 1 : n
			return {
				number: ethers.toQuantity(reported),
				hash: hashOf(n),
				withdrawals: chain.withdrawals.get(n) ?? [],
			}
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

function writeLedger(
	file: string,
	boundaryH: number | null,
	historicalCursor: number,
	realtimeCursor: number,
	boundaryHash?: string
): void {
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH:
				boundaryH === null
					? null
					: { blockNumber: boundaryH, blockHash: boundaryHash ?? hashOf(boundaryH) },
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
	chunkBlocks?: number
}

/** Install stubs and start a fresh process generation: the next scan step fixes H again. */
function install(file: string, chain: Chain, opts: InstallOpts = {}): void {
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE = file
	process.env.CONET_VALIDATOR_DEPOSIT_REDEEM = PROXY
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK = '1'
	process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNK_BLOCKS = String(opts.chunkBlocks ?? 32)
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
	scanLog = []
	skipLog = []
	__engHarnessResetStateCache() // a new process: H is fixed again on its first scan step
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
		onScanCommit: (rec) => {
			scanLog.push(rec)
		},
		onSpanSkip: (rec) => {
			skipLog.push(rec)
		},
	})
}

function newChain(head: number, hangAtOrBelow = -1): Chain {
	return {
		head,
		hangAtOrBelow,
		missing: new Set(),
		wrongHeight: new Set(),
		fetched: [],
		withdrawals: new Map(),
		receipts: new Map(),
	}
}

function st(): DualCursorState {
	return peekValidatorClRewardPayoutState()
}

function range(a: number, b: number): number[] {
	const out: number[] = []
	for (let i = a; i <= b; i++) out.push(i)
	return out
}

/** Expand committed windows into block counts; returns the sorted blocks committed exactly once and any duplicates. */
function countCommits(log: Commit[]): { once: number[]; dupes: number[] } {
	const count = new Map<number, number>()
	for (const r of log) {
		for (let b = r.from; b <= r.okThrough; b++) count.set(b, (count.get(b) ?? 0) + 1)
	}
	const once: number[] = []
	const dupes: number[] = []
	for (const [b, c] of count) {
		if (c === 1) once.push(b)
		else dupes.push(b)
	}
	return { once: once.sort((a, b) => a - b), dupes: dupes.sort((a, b) => a - b) }
}

/** Cursors never move back, H never moves back, and spans are sorted, disjoint and above the history cursor. */
function assertMonotone(prev: DualCursorState, cur: DualCursorState): void {
	assert.ok(cur.historicalCursor >= prev.historicalCursor, `history cursor moved back ${prev.historicalCursor} -> ${cur.historicalCursor}`)
	assert.ok(cur.realtimeCursor >= prev.realtimeCursor, `realtime cursor moved back ${prev.realtimeCursor} -> ${cur.realtimeCursor}`)
	const ph = prev.boundaryH?.blockNumber ?? -1
	const ch = cur.boundaryH?.blockNumber ?? -1
	assert.ok(ch >= ph, `H moved back ${ph} -> ${ch}`)
	if (!cur.boundaryH) return
	const H = cur.boundaryH.blockNumber
	assert.ok(cur.historicalCursor <= H, 'history cursor stays at or below H')
	assert.ok(cur.realtimeCursor >= H, 'realtime cursor stays at or above H')
	let last = -1
	for (const sp of cur.metrics.realtimeSpans ?? []) {
		assert.ok(sp.from <= sp.to, 'span is non-empty')
		assert.ok(sp.from > last, 'spans are sorted and disjoint')
		assert.ok(sp.to <= H, 'span is at or below H')
		assert.ok(sp.from > cur.historicalCursor, 'span starts above the history cursor')
		last = sp.to
	}
}

test('b: each start fixes H anew: history fills to it, realtime starts at H+1, no block committed twice', async () => {
	const file = freshFile()
	writeLedger(file, null, 0, 0)
	const chain = newChain(60)
	install(file, chain)
	const tick = async (n = 1) => {
		for (let i = 0; i < n; i++) await __engHarnessRunTickOnce()
	}
	try {
		await tick() // start 1, head 60: H=58; history 1..32
		assert.equal(st().boundaryH?.blockNumber, 58)
		assert.equal(st().historicalCursor, 32)

		__engHarnessResetStateCache() // start 2, same head: H is fixed again on the same block; history 33..58
		await tick(2)
		assert.deepEqual(st().boundaryH, { blockNumber: 58, blockHash: hashOf(58) })
		assert.equal(st().historicalCursor, 58)
		assert.equal(st().realtimeCursor, 58)

		__engHarnessResetStateCache()
		chain.head = 100 // start 3: H=98 (100 - 2); history 59..98; realtime waits at 98 (first block 99)
		await tick(4)
		assert.deepEqual(st().boundaryH, { blockNumber: 98, blockHash: hashOf(98) }, 'H moved to the new start block')
		assert.equal(st().historicalCursor, 98)
		assert.equal(st().realtimeCursor, 98)

		__engHarnessResetStateCache()
		chain.head = 110 // start 4: H=108; realtime had not passed 98, so no span; history 99..108
		await tick(2)
		assert.deepEqual(st().boundaryH, { blockNumber: 108, blockHash: hashOf(108) })
		assert.equal(st().historicalCursor, 108)
		assert.equal(st().realtimeCursor, 108)

		chain.head = 115 // no restart: realtime 109..113
		await tick(2)
		assert.equal(st().realtimeCursor, 113)
	} finally {
		__setFlushTestHooks(null)
	}
	const { once, dupes } = countCommits(scanLog)
	assert.deepEqual(dupes, [], 'no block committed twice across restarts')
	assert.deepEqual(once, range(1, 113), 'every block 1..113 committed exactly once (no gap)')
	const realtime = scanLog.filter((r) => r.line === 'realtime')
	assert.equal(realtime[0]?.from, 109, 'realtime starts at the start-4 H+1')
	assert.deepEqual(
		st().metrics.retiredBoundaries?.map((b) => b.blockNumber),
		[58, 58, 98],
		'every replaced H is kept in order'
	)
})

test('b2: a realtime span left by an earlier start is skipped by history, never rescanned', async () => {
	const file = freshFile()
	writeLedger(file, 98, 40, 108) // realtime had run to 108 under H=98: span (98, 108]
	const chain = newChain(110)
	install(file, chain)
	try {
		for (let i = 0; i < 4; i++) await __engHarnessRunTickOnce()
	} finally {
		__setFlushTestHooks(null)
	}
	assert.deepEqual(st().boundaryH, { blockNumber: 108, blockHash: hashOf(108) })
	const { once, dupes } = countCommits(scanLog)
	assert.deepEqual(dupes, [])
	assert.deepEqual(once, range(41, 98), 'history scans 41..98 only')
	assert.deepEqual(skipLog, [{ from: 99, to: 108 }], 'history jumps over the span without scanning it')
	assert.equal(st().historicalCursor, 108)
	assert.deepEqual(st().metrics.realtimeSpans, [], 'a span the history cursor has passed is dropped')
	assert.equal(st().metrics.retiredBoundaries?.at(-1)?.blockNumber, 98)
})

test('b3: a candidate below a cursor is held: H never moves backward and nothing is scanned', async () => {
	const file = freshFile()
	writeLedger(file, 98, 40, 108)
	const chain = newChain(105) // candidate 103 < realtime cursor 108
	install(file, chain)
	try {
		await __engHarnessRunTickOnce()
		assert.deepEqual(st().boundaryH, { blockNumber: 98, blockHash: hashOf(98) }, 'H unchanged while held')
		assert.equal(st().realtimeCursor, 108)
		assert.equal(st().historicalCursor, 40)
		assert.equal(scanLog.length, 0, 'a held start scans nothing')
		assert.equal(st().metrics.retiredBoundaries, undefined, 'a held start retires nothing')

		chain.head = 111 // candidate 109 >= 108: H=109; span (98, 108]; history 41..98, skip 99..108, then 109
		for (let i = 0; i < 3; i++) await __engHarnessRunTickOnce()
		assert.equal(st().boundaryH?.blockNumber, 109)
		assert.equal(st().historicalCursor, 109)
		assert.deepEqual(skipLog, [{ from: 99, to: 108 }])
	} finally {
		__setFlushTestHooks(null)
	}
	const { once, dupes } = countCommits(scanLog)
	assert.deepEqual(dupes, [])
	assert.deepEqual(once, [...range(41, 98), 109], 'history scans 41..98 and 109; 99..108 are skipped, not rescanned')
})

test('b4: random restarts keep cursors monotone and commit every block exactly once', async () => {
	const file = freshFile()
	writeLedger(file, null, 0, 0)
	const chain = newChain(40)
	install(file, chain, { chunkBlocks: 16 })
	let seed = 20261116
	const rnd = (m: number): number => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed % m
	}
	try {
		let prev = st()
		for (let run = 0; run < 30; run++) {
			__engHarnessResetStateCache() // restart
			if (rnd(10) === 0) chain.head = Math.max(1, chain.head - 1) // RPC lag: the head reads one block lower
			else chain.head += rnd(7) // 0..6 new blocks
			const ticks = 1 + rnd(3)
			for (let t = 0; t < ticks; t++) {
				await __engHarnessRunTickOnce()
				const cur = st()
				assertMonotone(prev, cur)
				prev = cur
			}
		}
		// Let history catch up to H at the last head (no restart).
		for (let t = 0; t < 400; t++) {
			const s = st()
			if (s.boundaryH && s.historicalCursor >= s.boundaryH.blockNumber) break
			await __engHarnessRunTickOnce()
			assertMonotone(prev, st())
			prev = st()
		}
	} finally {
		__setFlushTestHooks(null)
	}
	const s = st()
	assert.ok(s.boundaryH, 'H fixed')
	assert.equal(s.historicalCursor, s.boundaryH!.blockNumber, 'history caught up to H')
	const { once, dupes } = countCommits(scanLog)
	assert.deepEqual(dupes, [], 'no block committed twice in any run')
	assert.deepEqual(once, range(1, s.realtimeCursor), 'every block up to the realtime cursor committed exactly once')
	const retired = (s.metrics.retiredBoundaries ?? []).map((b) => b.blockNumber)
	assert.ok(retired.length > 0, 'restarts that fixed H kept the replaced H')
	for (let i = 1; i < retired.length; i++) {
		assert.ok(retired[i]! >= retired[i - 1]!, 'replaced H values never move back')
	}
})

test('c: a hung historical RPC does not block realtime scanning, queueing or payment', async () => {
	const file = freshFile()
	writeLedger(file, 98, 0, 98)
	const chain = newChain(110, 50) // history reads (blocks 1..50) hang
	chain.withdrawals.set(111, [{ index: '7', validatorIndex: '5', address: PROXY, amount: '1000000' }])
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
		assert.equal(await __engHarnessRunWorkerOnce('realtime'), 'done', 'start: H fixed at 108 (110 - 2)')
		assert.equal(st().boundaryH?.blockNumber, 108)
		chain.head = 115 // blocks 109..113 are now realtime; 111 carries a withdrawal
		const historical = __engHarnessRunWorkerOnce('historical') // hangs on block 1
		assert.equal(await __engHarnessRunWorkerOnce('realtime'), 'done', 'realtime step completes')
		assert.equal(st().realtimeCursor, 113, 'realtime line advanced while history hung')
		assert.equal(st().pending.length, 1, 'realtime row enqueued while history hung')
		assert.equal(await __engHarnessRunWorkerOnce('flush'), 'done', 'flush step completes')
		const s = st()
		assert.equal(s.pending.length, 0, 'realtime row paid and removed')
		assert.equal(signed, 1, 'exactly one settle for the realtime row')
		assert.equal(await historical, 'timeout', 'the hung history step is reported as UNKNOWN and released')
		assert.equal(st().historicalCursor, 0, 'history cursor did not move without blocks')
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
	assert.equal(st().pending.length, 298, 'the rest of the queue is untouched')
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
		assert.equal(st().pending.length, 1, 'one row for the key, not two')
		// Two flush steps at once: one signs, the other is busy; a later step finds nothing left to pay.
		await Promise.all([__engHarnessRunWorkerOnce('flush'), __engHarnessRunWorkerOnce('flush')])
		await __engHarnessRunWorkerOnce('flush')
	} finally {
		__setFlushTestHooks(null)
	}
	assert.equal(signed, 1, 'the key is paid exactly once')
	assert.equal(st().pending.length, 0)
})

test('f: an H candidate with no readable hash, or another height, is UNKNOWN: no lock, no tip-hash fallback', async () => {
	const file = freshFile()
	writeLedger(file, null, 0, 0)
	const chain = newChain(60)
	chain.wrongHeight.add(58) // the candidate block reports another height
	install(file, chain)
	try {
		await __engHarnessRunTickOnce()
		assert.equal(st().boundaryH, null, 'no H while the candidate block cannot be verified')
		assert.equal(st().historicalCursor, 0)
		assert.equal(scanLog.length, 0)

		chain.wrongHeight.clear()
		chain.missing.add(58) // the candidate block is unreadable
		await __engHarnessRunTickOnce()
		assert.equal(st().boundaryH, null, 'still no H while unreadable')

		chain.missing.clear()
		await __engHarnessRunTickOnce()
		assert.deepEqual(
			st().boundaryH,
			{ blockNumber: 58, blockHash: hashOf(58) },
			'H takes the hash of block 58 itself, never the tip (60) hash'
		)
	} finally {
		__setFlushTestHooks(null)
	}
})

test('g: an unreadable or wrong-height H block in the reorg check is UNKNOWN, not a reorg: no rollback', async () => {
	for (const mode of ['missing', 'wrongHeight'] as const) {
		const file = freshFile()
		writeLedger(file, 98, 40, 105) // realtime span (98, 105] over H=98
		const chain = newChain(110)
		chain[mode === 'missing' ? 'missing' : 'wrongHeight'].add(98)
		install(file, chain)
		try {
			await __engHarnessRunTickOnce()
			const s = st()
			assert.equal(s.boundaryH?.blockNumber, 108, `${mode}: H fixed at 108`)
			assert.deepEqual(
				s.metrics.retiredBoundaries?.map((b) => b.blockNumber),
				[98],
				`${mode}: H 98 retired with its cursors`
			)
			assert.equal(s.metrics.retiredBoundaries?.[0]?.realtimeCursor, 105, `${mode}: cursors not rolled back before the retire`)
			assert.deepEqual(s.metrics.realtimeSpans, [{ from: 99, to: 105 }], `${mode}: span kept, no rollback`)
		} finally {
			__setFlushTestHooks(null)
		}
	}
})

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
	const until = Date.now() + ms
	while (!cond() && Date.now() < until) await sleepMs(20)
}
function pendingRow(i: number) {
	return {
		guardianId: '1',
		amount: '1000000000000000',
		eventKey: ethers.id(`lane-row:${i}`).toLowerCase(),
		blockNumber: 1 + i,
		withdrawalIndex: 0,
		scanLine: 'historical',
	}
}

test('lane: a flush step that exceeds its timeout keeps the signing lane busy; a second batch never signs in parallel', async () => {
	const file = freshFile()
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			boundaryH: { blockNumber: 98, blockHash: hashOf(98) },
			historicalCursor: 98,
			realtimeCursor: 98,
			pending: [1, 2, 3, 4].map(pendingRow),
			settleIntents: [],
			firstBatchSettledWei: '0',
			updatedAt: new Date().toISOString(),
		})
	)
	const chain = newChain(110)
	let inflight = 0
	let maxInflight = 0
	let signed = 0
	install(file, chain, {
		workerTimeoutMs: 100, // the flush step is released by its timeout while the batch is still in the signer
		signer: async () => {
			inflight += 1
			maxInflight = Math.max(maxInflight, inflight)
			await sleepMs(400)
			inflight -= 1
			signed += 1
			const hash = ethers.id(`lane-tx:${signed}`)
			chain.receipts.set(hash, { status: 1 })
			return { hash }
		},
	})
	const first = await __engHarnessRunWorkerOnce('flush')
	const second = await __engHarnessRunWorkerOnce('flush') // must not start another flush job while the first still signs
	await waitFor(() => st().pending.length === 0 && inflight === 0)
	let third = 'busy'
	for (let i = 0; i < 100 && third !== 'done'; i++) {
		third = await __engHarnessRunWorkerOnce('flush')
		if (third !== 'done') await sleepMs(20)
	}
	__setFlushTestHooks(null)
	assert.equal(maxInflight, 1, 'never two batches in the signer at once (one outstanding signature, one nonce at a time)')
	assert.equal(first, 'timeout', 'the first step is released by its timeout')
	assert.equal(second, 'busy', 'the lane stays busy while its signing job is still in flight')
	assert.equal(signed, 2, 'the two batches (MAX_ENTRIES=2) are each signed once')
	assert.equal(st().pending.length, 0, 'all rows are paid once the lane settles')
	assert.equal(third, 'done', 'the lane is released once the signing job has settled')
})
