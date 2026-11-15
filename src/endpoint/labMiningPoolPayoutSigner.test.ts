import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import {
	FORBIDDEN_LAB_RESTORE_ADMIN_EOA,
	FORBIDDEN_VDR_KEY_ARRAY,
	FORBIDDEN_VDR_PAYOUT_SOCKET,
	LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS,
	PAYOUT_BATCH_SELECTOR,
	PAYOUT_SELECTOR,
	buildLabPayoutBatchSignerTx,
	buildLabPayoutSignerTx,
	buildLabWithdrawNativeSignerTx,
	WITHDRAW_NATIVE_SELECTOR,
	isLabLiveAllowlistedSelector,
	labBatchIdFromEventKeys,
	labPayoutBatchIdempotencyKey,
	labPayoutRequestFingerprint,
	labPayoutSignerSendOnce,
	readLabPayoutSignerConfig,
	sendConfiguredLabExecutorPayout,
	sendConfiguredLabExecutorPayoutBatch,
} from './labMiningPoolPayoutSigner.ts'

const HASH = '0x' + 'cd'.repeat(32)
const HASH2 = '0x' + 'ab'.repeat(32)
const EXECUTOR = '0x1111111111111111111111111111111111111111'
const EVENT_A = '0x' + '11'.repeat(32)
const EVENT_B = '0x' + '22'.repeat(32)

function listenFake(
	socketPath: string,
	opts?: {
		acceptSelector?: string
		/** Simulate ACK-lost: refuse first send, answer getTransaction with original hash. */
		ackLostOnce?: boolean
	}
) {
	const seen: unknown[] = []
	const acceptSel = (opts?.acceptSelector || PAYOUT_BATCH_SELECTOR).toLowerCase()
	let sendAttempts = 0
	const journal = new Map<string, string>()
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
				method?: string
				params?: {
					value?: string
					data?: string
					chainId?: number
					keyArray?: string
					to?: string
					idempotencyKey?: string
				}
			}
			seen.push(body)
			if (body.method === 'signer_getTransaction') {
				const key = String((body.params as { idempotencyKey?: string })?.idempotencyKey || '')
				const hash = journal.get(key)
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						result: hash ? { hash, status: 'submitted', found: true } : { found: false },
					})
				)
				return
			}
			const tx = body.params
			if (!tx || tx.value !== '0') {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'native value must be 0' } }))
				return
			}
			if (!String(tx.data || '').toLowerCase().startsWith(acceptSel)) {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'refusing selector' } }))
				return
			}
			sendAttempts++
			const idem = String(tx.idempotencyKey || '')
			if (opts?.ackLostOnce && sendAttempts === 1) {
				// Broadcast happened (journal written) but ACK to client is lost.
				journal.set(idem, HASH)
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'connection reset after broadcast' } }))
				return
			}
			const hash = journal.get(idem) || HASH
			journal.set(idem, hash)
			res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hash, duplicate: journal.has(idem) && sendAttempts > 1 } }))
		})
	})
	return new Promise<{ server: typeof server; seen: unknown[]; journal: Map<string, string> }>((resolve) => {
		server.listen(socketPath, () => resolve({ server, seen, journal }))
	})
}

test('live allowlist is payoutBatch only; legacy selector not live-allowlisted', () => {
	assert.deepEqual([...LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS], [PAYOUT_BATCH_SELECTOR])
	assert.equal(isLabLiveAllowlistedSelector(PAYOUT_BATCH_SELECTOR), true)
	assert.equal(isLabLiveAllowlistedSelector(PAYOUT_SELECTOR), false)
	assert.equal(PAYOUT_BATCH_SELECTOR, '0xa7f22fea')
	assert.equal(PAYOUT_SELECTOR, '0xe1152343')
	assert.equal(FORBIDDEN_LAB_RESTORE_ADMIN_EOA.toLowerCase(), '0x87caed4e51c36a2c2ece3aaf4ddac9693d2405e1')
})

test('missing signer env fails closed', async () => {
	assert.equal(readLabPayoutSignerConfig({}), null)
	await assert.rejects(
		() =>
			sendConfiguredLabExecutorPayout({
				amount: 1n,
				gasLimit: 250000,
				env: { CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT: '1' },
			}),
		/not configured/
	)
	await assert.rejects(
		() =>
			sendConfiguredLabExecutorPayout({
				amount: 1n,
				gasLimit: 250000,
				env: {},
			}),
		/legacy payout\(uint256\) disabled/
	)
})

test('refuses forbidden VDR socket and key array', () => {
	assert.throws(
		() =>
			readLabPayoutSignerConfig({
				CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: FORBIDDEN_VDR_PAYOUT_SOCKET,
				CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
				CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR: EXECUTOR,
			}),
		/forbidden VDR socket/
	)
	assert.throws(
		() =>
			readLabPayoutSignerConfig({
				CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: '/run/wallet-signer-lab-mining-pool/lab-payout.sock',
				CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: FORBIDDEN_VDR_KEY_ARRAY,
				CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR: EXECUTOR,
			}),
		/forbidden VDR key array/
	)
})

test('legacy payout(uint256) refused without env opt-in; fixtures need ALLOW_LEGACY=1', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'lab-signer-'))
	const socketPath = path.join(dir, 'lab-payout.sock')
	const legacyTx = buildLabPayoutSignerTx({
		keyArray: 'lab_mining_pool_payout',
		executor: EXECUTOR,
		amount: 10n ** 18n,
		gasLimit: 250_000,
		batchFingerprint: HASH,
	})
	await assert.rejects(
		() => labPayoutSignerSendOnce(legacyTx, socketPath),
		/refusing legacy payout\(uint256\)/
	)
	await assert.rejects(
		() =>
			sendConfiguredLabExecutorPayout({
				amount: 10n ** 18n,
				gasLimit: 250_000,
				batchFingerprint: HASH,
				env: {
					CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: socketPath,
					CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
					CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR: EXECUTOR,
				},
			}),
		/legacy payout\(uint256\) disabled/
	)
	const fake = await listenFake(socketPath, { acceptSelector: PAYOUT_SELECTOR })
	try {
		const sent = await sendConfiguredLabExecutorPayout({
			amount: 10n ** 18n,
			gasLimit: 250_000,
			batchFingerprint: HASH,
			env: {
				CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: socketPath,
				CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
				CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR: EXECUTOR,
				CONET_LAB_MINING_POOL_ALLOW_LEGACY_PAYOUT: '1',
			},
		})
		assert.equal(sent.hash, HASH)
		assert.equal(sent.executor.toLowerCase(), EXECUTOR.toLowerCase())
		const body = fake.seen[0] as {
			method: string
			params: { value: string; data: string; idempotencyKey: string }
		}
		assert.equal(body.method, 'signer_sendTransaction')
		assert.equal(body.params.data.slice(0, 10).toLowerCase(), PAYOUT_SELECTOR)
		assert.match(body.params.idempotencyKey, /^lab-executor-payout:/)
	} finally {
		fake.server.close()
	}
})

test('payoutBatch encode + same event keys → same batchId and fingerprint', () => {
	const batchId = labBatchIdFromEventKeys([EVENT_B, EVENT_A])
	const batchId2 = labBatchIdFromEventKeys([EVENT_A, EVENT_B])
	assert.equal(batchId, batchId2)
	const tx = buildLabPayoutBatchSignerTx({
		keyArray: 'lab_mining_pool_payout',
		executor: EXECUTOR,
		batchId,
		eventKeys: [EVENT_A, EVENT_B],
		amount: 5n,
		gasLimit: 250_000,
	})
	assert.equal(tx.data.slice(0, 10).toLowerCase(), PAYOUT_BATCH_SELECTOR)
	assert.match(tx.idempotencyKey, /^lab-executor-payoutBatch:/)
	const fp = labPayoutRequestFingerprint({
		executor: EXECUTOR,
		batchId,
		eventKeys: [EVENT_B, EVENT_A],
		amount: 5n,
	})
	assert.equal(tx.requestFingerprint, fp)
	assert.equal(tx.idempotencyKey, labPayoutBatchIdempotencyKey(fp))
})

test('ACK-lost after broadcast recovers original batch hash via idempotencyKey (not mock)', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'lab-signer-ack-'))
	const socketPath = path.join(dir, 'lab-payout.sock')
	const fake = await listenFake(socketPath, {
		acceptSelector: PAYOUT_BATCH_SELECTOR,
		ackLostOnce: true,
	})
	try {
		const batchId = labBatchIdFromEventKeys([EVENT_A, EVENT_B])
		const sent = await sendConfiguredLabExecutorPayoutBatch({
			batchId,
			eventKeys: [EVENT_A, EVENT_B],
			amount: 7n,
			gasLimit: 250_000,
			env: {
				CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: socketPath,
				CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
				CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR: EXECUTOR,
			},
		})
		assert.equal(sent.hash, HASH, 'must recover original journal hash')
		assert.equal(sent.recoveredFromJournal, true)
		assert.equal(sent.duplicate, true)
		assert.notEqual(sent.hash, HASH2)
		const methods = fake.seen.map((b) => (b as { method?: string }).method)
		assert.ok(methods.includes('signer_sendTransaction'))
		assert.ok(methods.includes('signer_getTransaction'))
		assert.match(sent.idempotencyKey, /^lab-executor-payoutBatch:/)
		assert.ok(/^0x[0-9a-fA-F]{64}$/.test(sent.requestFingerprint))
	} finally {
		fake.server.close()
	}
})

test('reporter signs withdrawNative; no hot key and no executor batch', () => {
	const reporter = readFileSync(new URL('./validatorLabMiningPoolClPayoutReporter.ts', import.meta.url), 'utf8')
	assert.equal(reporter.includes('resolveAdminPrivateKey'), false)
	assert.equal(reporter.includes('withdrawNative!'), false)
	assert.equal(reporter.includes('WRITE_ABI'), false)
	assert.equal(reporter.includes('new ethers.Wallet('), false)
	assert.equal(reporter.includes('CONET_LAB_MINING_POOL_CL_PAYOUT_ADMIN_PRIVATE_KEY'), false)
	assert.equal(reporter.includes('sendConfiguredLabExecutorPayoutBatch'), false)
	assert.match(reporter, /sendConfiguredLabWithdrawNative/)
	assert.match(reporter, /LAB_MINING_POOL_ONCHAIN_LANE/)
	assert.match(reporter, /labBatchIdFromEventKeys/)
	assert.match(reporter, /scheduleFlushBatches/)
	assert.match(reporter, /ensureFreezeH|ensureDualCursors/)
	assert.equal(/BATCH-KEY BLOCKER/i.test(reporter), false)
})

test('buildLabPayoutSignerTx notes advisory batch fingerprint only (legacy)', () => {
	const tx = buildLabPayoutSignerTx({
		keyArray: 'lab_mining_pool_payout',
		executor: EXECUTOR,
		amount: 5n,
		gasLimit: 21000,
		batchFingerprint: '0x' + '11'.repeat(32),
	})
	assert.equal(tx.value, '0')
	assert.equal(tx.data.slice(0, 10).toLowerCase(), PAYOUT_SELECTOR)
	assert.ok(tx.idempotencyKey.startsWith('lab-executor-payout:'))
	void ethers
})

test('withdrawNative idempotency key is stable and is not the vdr array', () => {
	const input = {
		keyArray: 'lab_mining_pool_payout',
		redeem: '0xc71e246DD78B37C2fABc905D340932F28F503433',
		pool: '0x32bE583C8e778FFfC5107BF34820c2B225336201',
		amount: 5n,
		eventKeys: [EVENT_B, EVENT_A],
		gasLimit: 800_000,
	}
	const a = buildLabWithdrawNativeSignerTx(input)
	const b = buildLabWithdrawNativeSignerTx({ ...input, eventKeys: [EVENT_A, EVENT_B] })
	assert.equal(a.data.slice(0, 10).toLowerCase(), WITHDRAW_NATIVE_SELECTOR)
	assert.equal(a.idempotencyKey, b.idempotencyKey)
	assert.equal(a.to, input.redeem)
	assert.throws(() => buildLabWithdrawNativeSignerTx({ ...input, keyArray: 'beamio_vdr_payout' }))
})
