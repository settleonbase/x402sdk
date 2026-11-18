import assert from 'node:assert/strict'
import { join as joinPath } from 'node:path'
// Source directory for the static checks: the .ts sources (set by the harness), else this file's directory.
const SRC_DIR = process.env.LAB_SRC_DIR || __dirname

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ethers } from 'ethers'
import { loadLabDenyList } from './labDenyList'
import {
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
	LAB_SIGNER_DECLARED_ADDRESS_ENV,
	verifyLabSignerBoundAddress,
	readLabPayoutSignerConfig,
	sendConfiguredLabExecutorPayout,
	sendConfiguredLabExecutorPayoutBatch,
	sendConfiguredLabWithdrawNative,
} from './labMiningPoolPayoutSigner'

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
	assert.deepEqual([...LAB_LIVE_SIGNER_ALLOWLIST_SELECTORS], [WITHDRAW_NATIVE_SELECTOR])
	assert.equal(isLabLiveAllowlistedSelector(WITHDRAW_NATIVE_SELECTOR), true)
	assert.equal(isLabLiveAllowlistedSelector(PAYOUT_BATCH_SELECTOR), false)
	assert.equal(isLabLiveAllowlistedSelector(PAYOUT_SELECTOR), false)
	assert.equal(PAYOUT_BATCH_SELECTOR, '0xa7f22fea')
	assert.equal(PAYOUT_SELECTOR, '0xe1152343')
	assert.equal(loadLabDenyList().addresses.includes(SYN_ADDR), true, 'the deny list is loaded from the private file')
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
				CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: SYN_SOCKET,
				CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
				CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR: EXECUTOR,
			}),
		/deny-listed socket/
	)
	assert.throws(
		() =>
			readLabPayoutSignerConfig({
				CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: '/synthetic/ok/lab-payout.sock',
				CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: SYN_KEY_ARRAY,
				CONET_LAB_MINING_POOL_PAYOUT_EXECUTOR: EXECUTOR,
			}),
		/deny-listed key array/
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

test('B-2 boundary: a withdrawNative whose key differs from the daemon record is refused before any send', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'lab-signer-key-'))
	const socketPath = path.join(dir, 'lab-withdraw.sock')
	const fake = await listenFake(socketPath, { acceptSelector: WITHDRAW_NATIVE_SELECTOR })
	try {
		const env = {
			CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: socketPath,
			CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
		}
		await assert.rejects(
			sendConfiguredLabWithdrawNative({
				redeem: '0x2222222222222222222222222222222222222222',
				pool: '0x32bE583C8e778FFfC5107BF34820c2B225336201',
				amount: 5n,
				eventKeys: [EVENT_A],
				gasLimit: 800_000,
				expectedIdempotencyKey: 'lab-withdrawNative:wrong',
				env,
			}),
			/does not match the in-flight record/
		)
		const methods = fake.seen.map((b) => (b as { method?: string }).method)
		assert.equal(methods.includes('signer_sendTransaction'), false, 'nothing is sent when the key differs')
	} finally {
		fake.server.close()
	}
})

test('ACK-lost: the batch sender is single-shot; it throws and makes no recovery call (daemon owns recovery)', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'lab-signer-ack-'))
	const socketPath = path.join(dir, 'lab-payout.sock')
	const fake = await listenFake(socketPath, {
		acceptSelector: PAYOUT_BATCH_SELECTOR,
		ackLostOnce: true,
	})
	try {
		const batchId = labBatchIdFromEventKeys([EVENT_A, EVENT_B])
		await assert.rejects(
			sendConfiguredLabExecutorPayoutBatch({
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
		)
		const methods = fake.seen.map((b) => (b as { method?: string }).method)
		assert.equal(methods.filter((m) => m === 'signer_sendTransaction').length, 1, 'exactly one send')
		assert.equal(methods.includes('signer_getTransaction'), false, 'no journal recovery inside the signer client')
	} finally {
		fake.server.close()
	}
})

test('reporter signs withdrawNative; no hot key and no executor batch', () => {
	const reporter = readFileSync(joinPath(SRC_DIR, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	assert.equal(reporter.includes('resolveAdminPrivateKey'), false)
	assert.equal(reporter.includes('withdrawNative!'), false)
	assert.equal(reporter.includes('WRITE_ABI'), false)
	assert.equal(reporter.includes('new ethers.Wallet('), false)
	assert.equal(reporter.includes('CONET_LAB_MINING_POOL_CL_PAYOUT_ADMIN_PRIVATE_KEY'), false)
	assert.equal(reporter.includes('sendConfiguredLabExecutorPayoutBatch'), false)
	assert.match(reporter, /sendConfiguredLabWithdrawNative/)
	assert.match(reporter, /flush paid-key view unconfirmed/)
	assert.equal(reporter.includes('/* keep entry */'), false)
	assert.equal(readFileSync(joinPath(SRC_DIR, 'labStartupConfig.ts'), 'utf8').includes('8_000_000'), true, 'the gas limit cap lives in labStartupConfig')
	assert.match(reporter, /LAB_MINING_POOL_ONCHAIN_LANE/)
	// Batch identity is now the withdrawNative request fingerprint plus the daemon-chosen attempt key (B-2).
	assert.equal(reporter.includes('labBatchIdFromEventKeys'), false, 'the reporter no longer derives a batch id from event keys')
	assert.match(reporter, /submitWithdrawBatchDurably/)
	assert.equal(reporter.includes('preferRecoverFirst'), false, 'the daemon never asks the signer to dedupe before a send')
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
	assert.throws(() => buildLabWithdrawNativeSignerTx({ ...input, keyArray: SYN_KEY_ARRAY }))
})

test('F3: the live send refuses payoutBatch before any socket is opened (legacy fixture only)', async () => {
	const tx = buildLabPayoutBatchSignerTx({
		keyArray: 'lab_mining_pool_payout',
		executor: EXECUTOR,
		batchId: EVENT_A,
		eventKeys: [EVENT_A],
		amount: 5n,
		gasLimit: 250_000,
	})
	await assert.rejects(labPayoutSignerSendOnce(tx, path.join(tmpdir(), 'no-such-lab-f3.sock')), /not on the live allowlist/)
})

/** A fake signer socket that answers any JSON-RPC method through respond(). Records every method it sees. */
function listenRpcFake(
	socketPath: string,
	respond: (method: string) => { result?: unknown; error?: string }
): Promise<{ server: ReturnType<typeof createServer>; seen: string[] }> {
	const seen: string[] = []
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => chunks.push(c))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string }
			seen.push(body.method)
			const r = respond(body.method)
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(r.error ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: r.error } } : { jsonrpc: '2.0', id: 1, result: r.result }))
		})
	})
	return new Promise((resolve) => server.listen(socketPath, () => resolve({ server, seen })))
}

const BOUND = '0x2222222222222222222222222222222222222222'
// Synthetic deny-list values for the tests only. The real list is private and loaded from CONET_LAB_DENY_LIST_FILE.
const SYN_ADDR = '0x00000000000000000000000000000000000000f1'
const FORBIDDEN_UPPER = '0x00000000000000000000000000000000000000F1'
const FORBIDDEN_LOWER = SYN_ADDR
const SYN_SOCKET = '/synthetic/deny/payout.sock'
const SYN_KEY_ARRAY = 'synthetic_deny_array'
{
	const denyDir = mkdtempSync(path.join(tmpdir(), 'lab-deny-'))
	const denyFile = path.join(denyDir, 'deny.json')
	require('node:fs').writeFileSync(denyFile, JSON.stringify({ addresses: [SYN_ADDR], sockets: [SYN_SOCKET], keyArrays: [SYN_KEY_ARRAY] }))
	process.env.CONET_LAB_DENY_LIST_FILE = denyFile
}

async function withBoundFake(
	respond: (method: string) => { result?: unknown; error?: string },
	declared: string | undefined,
	fn: (env: NodeJS.ProcessEnv, seen: string[]) => Promise<void>
): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), 'lab-bound-'))
	const socketPath = path.join(dir, 'bound.sock')
	const fake = await listenRpcFake(socketPath, respond)
	try {
		const env: NodeJS.ProcessEnv = {
			CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: socketPath,
			CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
		}
		if (declared !== undefined) env[LAB_SIGNER_DECLARED_ADDRESS_ENV] = declared
		await fn(env, fake.seen)
	} finally {
		fake.server.close()
	}
}

test('F1: the bound address is confirmed when declared and reported agree and are allowed', async () => {
	await withBoundFake((m) => (m === 'signer_getAddress' ? { result: { address: BOUND } } : { error: 'unexpected' }), BOUND, async (env, seen) => {
		assert.equal(await verifyLabSignerBoundAddress(env), ethers.getAddress(BOUND))
		assert.deepEqual(seen, ['signer_getAddress'], 'only the read-only method is called')
	})
})

test('F1: a declared deny-listed address (any case) is refused before the signer is asked', async () => {
	await withBoundFake((m) => ({ result: { address: FORBIDDEN_UPPER } }), FORBIDDEN_LOWER, async (env, seen) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /deny-listed/)
		assert.deepEqual(seen, [], 'no readback when the declared address is already forbidden')
	})
})

test('F1: a reported forbidden address is refused even when the declaration differs', async () => {
	await withBoundFake((m) => ({ result: { address: FORBIDDEN_UPPER } }), BOUND, async (env) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /deny-listed/)
	})
})

test('F1: a reported address that differs from the declaration is refused', async () => {
	const other = '0x3333333333333333333333333333333333333333'
	await withBoundFake((m) => ({ result: { address: other } }), BOUND, async (env) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /differs from the declared/)
	})
})

test('F1: a signer that cannot report its address (error or no field) leaves the address unconfirmed', async () => {
	await withBoundFake((m) => ({ error: 'method not found' }), BOUND, async (env) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /method not found/)
	})
	await withBoundFake((m) => ({ result: {} }), BOUND, async (env) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /did not report a bound address/)
	})
})

test('F1: no declared address means nothing can be confirmed; the signer is not asked', async () => {
	await withBoundFake((m) => ({ result: { address: BOUND } }), undefined, async (env, seen) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /is not set/)
		assert.deepEqual(seen, [])
	})
})

test('R5 F1: the bound address is read before the intent is persisted, on every composition (no process cache)', () => {
	const lifecycle = readFileSync(joinPath(SRC_DIR, 'labClPayoutBatchLifecycle.ts'), 'utf8')
	const reporter = readFileSync(joinPath(SRC_DIR, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	const confirmAt = lifecycle.indexOf('await deps.confirmBeforeSend()')
	const intentAt = lifecycle.indexOf('deps.setInFlight(rec)')
	assert.ok(confirmAt > 0, 'the lifecycle calls the confirmation')
	assert.ok(intentAt > confirmAt, 'the confirmation comes before the intent is written')
	assert.match(reporter, /confirmBeforeSend: async \(\) => \{\n\t\t\tawait verifyLabSignerBoundAddress\(process\.env\)/)
	assert.equal(reporter.includes('labSignerBoundConfirmed'), false, 'no per-process cache of the confirmation')
})

test('F5: the startup log prints each effective value with src, name and reason, from the same parsers as the resolvers', () => {
	const reporter = readFileSync(joinPath(SRC_DIR, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	assert.match(reporter, /\$\{startupConfigLine\(\)\} /)
	assert.equal(reporter.includes('gasEnvSource'), false, 'the presence-only source check is gone')
	assert.match(reporter, /return gasWaitForceFromEnv\(process\.env\.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS\)\.value/)
})

test('redeem pin: the reporter uses the pinned redeem and refuses a differing override at start', () => {
	const reporter = readFileSync(joinPath(SRC_DIR, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	assert.match(reporter, /function resolveLabRedeemAddress\(\): string \{\n\treturn CONET_VALIDATOR_DEPOSIT_REDEEM\n\}/)
	assert.match(reporter, /assertPinnedRedeem\(process\.env\.CONET_VALIDATOR_DEPOSIT_REDEEM, CONET_VALIDATOR_DEPOSIT_REDEEM\)/)
})

test('R5 redeem: inside the start function, the redeem pin is asserted before the state lock is taken (static order)', () => {
	const reporter = readFileSync(joinPath(SRC_DIR, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8')
	const start = reporter.indexOf('export function startValidatorLabMiningPoolClPayoutReporter(')
	const pin = reporter.indexOf('assertPinnedRedeem(process.env.CONET_VALIDATOR_DEPOSIT_REDEEM', start)
	const lock = reporter.indexOf('labStateLock = acquireStateDirLock(resolveSegmentedStateDir())', start)
	assert.ok(start > 0, 'the start function exists')
	assert.ok(pin > start, 'the pin is inside the start function')
	assert.ok(lock > pin, 'the pin comes before the state lock')
})

test('F1 compat: signer_getAddress as a bare address string is accepted when it equals the declared address', async () => {
	await withBoundFake((m) => ({ result: BOUND }), BOUND, async (env, seen) => {
		assert.equal(await verifyLabSignerBoundAddress(env), ethers.getAddress(BOUND))
		assert.deepEqual(seen, ['signer_getAddress'])
	})
})

test('F1 compat: a bare address string that differs from the declared address is refused', async () => {
	const other = '0x3333333333333333333333333333333333333333'
	await withBoundFake((m) => ({ result: other }), BOUND, async (env) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /differs from the declared/)
	})
})

test('F1 compat: an empty bare string, null, a non-string address and a non-object result all leave the address unconfirmed', async () => {
	for (const result of ['', '   ', null, 42, { address: 123 }, {}]) {
		await withBoundFake((m) => ({ result }), BOUND, async (env) => {
			await assert.rejects(verifyLabSignerBoundAddress(env), /did not report a bound address/, `result ${JSON.stringify(result)}`)
		})
	}
})

test('F1 compat: a bare deny-listed address string (any case) is refused', async () => {
	await withBoundFake((m) => ({ result: FORBIDDEN_UPPER }), BOUND, async (env) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /deny-listed/)
	})
})

test('F1 compat: a signer transport error or JSON-RPC error is refused, never treated as confirmed', async () => {
	await withBoundFake((m) => ({ error: 'socket closed' }), BOUND, async (env) => {
		await assert.rejects(verifyLabSignerBoundAddress(env), /socket closed/)
	})
})
