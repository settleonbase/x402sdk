/**
 * Entry to mock JSON-RPC. Does not import beamioMaster or read master.json.
 * POST /setChatIndexPointer's isolated branch is writeIsolatedChatPointerResponse.
 * The settle roster entry is loadSettleRelayRoster, which initFromWalletSigner calls.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Transaction, Wallet, type Provider, type TransactionReceipt } from 'ethers'
import { writeIsolatedChatPointerResponse, type ChatPointerHttpSink } from './chatPointerHttpRoute.ts'
import { resetChatWriteStopForTests } from './chatWriteStopGate.ts'
import { setIsolatedChatRelayIdle } from './isolatedChatRelayPool.ts'
import { RemoteSigner, WalletSignerClient, WalletSignerError } from './remoteSigner.ts'
import { loadSettleRelayRoster } from './settleRemoteRelay.ts'

const CONTRACT = '0x1511Caa71081C84d8a591490D1b83879088EED72'
const CHAT_ARRAY = 'chatPointerGas'
const SETTLE_ARRAY = 'settle_contractAdmin'

type Seen = { method: string; params: Record<string, unknown> }

function writeCerts(dir: string): void {
	const ext = join(dir, 'san.cnf')
	writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
	const run = (args: string[]) => {
		const result = spawnSync('openssl', args, { encoding: 'utf8' })
		if (result.status !== 0) throw new Error(result.stderr || 'openssl failed')
	}
	run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'ca.key')])
	run(['req', '-x509', '-new', '-sha256', '-key', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'), '-days', '1', '-subj', '/CN=caller-rpc-test-ca'])
	run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'server.key')])
	run(['req', '-new', '-key', join(dir, 'server.key'), '-out', join(dir, 'server.csr'), '-subj', '/CN=localhost'])
	run(['x509', '-req', '-sha256', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'server.crt'), '-days', '1', '-extfile', ext])
	run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'client.key')])
	run(['req', '-new', '-key', join(dir, 'client.key'), '-out', join(dir, 'client.csr'), '-subj', '/CN=caller-rpc-test'])
	run(['x509', '-req', '-sha256', '-in', join(dir, 'client.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'client.crt'), '-days', '1'])
}

function listen(dir: string, seen: Seen[], address: string, raw: string, rawHash: string): Promise<Server> {
	const server = createServer(
		{
			cert: readFileSync(join(dir, 'server.crt')),
			key: readFileSync(join(dir, 'server.key')),
			ca: readFileSync(join(dir, 'ca.crt')),
			requestCert: true,
			rejectUnauthorized: false,
			minVersion: 'TLSv1.3',
		},
		(req, res) => {
			const chunks: Buffer[] = []
			req.on('data', (chunk) => chunks.push(chunk as Buffer))
			req.on('end', () => {
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: Record<string, unknown> }
				seen.push({ method: body.method, params: body.params })
				res.setHeader('content-type', 'application/json')
				const key = String(body.params.idempotencyKey ?? '')
				if (body.method === 'signer_sendTransaction' && key.endsWith(':99')) {
					res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32003, message: 'policy denied' } }))
					return
				}
				if (body.method === 'signer_accounts') {
					res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [address] }))
					return
				}
				if (body.method === 'signer_getTransaction') {
					res.end(JSON.stringify({
						jsonrpc: '2.0',
						id: body.id,
						result: { hash: rawHash, hashes: [rawHash], from: address, nonce: 0, chainId: 224422, status: 'mined' },
					}))
					return
				}
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					id: body.id,
					result: { hash: rawHash, from: address, nonce: 0, chainId: 224422, status: 'submitted', raw },
				}))
			})
		},
	)
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function useEnv(port: number, dir: string): () => void {
	const keys = [
		'WALLET_SIGNER_URL',
		'WALLET_SIGNER_CERT',
		'WALLET_SIGNER_KEY',
		'WALLET_SIGNER_CA',
		'WALLET_SIGNER_SERVERNAME',
		'WALLET_SIGNER_CHAT_POINTER_ARRAY',
		'WALLET_SIGNER_CHAT_POINTER_CONTRACT',
	] as const
	const previous = new Map(keys.map((key) => [key, process.env[key]]))
	process.env.WALLET_SIGNER_URL = `https://127.0.0.1:${port}`
	process.env.WALLET_SIGNER_CERT = join(dir, 'client.crt')
	process.env.WALLET_SIGNER_KEY = join(dir, 'client.key')
	process.env.WALLET_SIGNER_CA = join(dir, 'ca.crt')
	process.env.WALLET_SIGNER_SERVERNAME = 'localhost'
	process.env.WALLET_SIGNER_CHAT_POINTER_ARRAY = CHAT_ARRAY
	process.env.WALLET_SIGNER_CHAT_POINTER_CONTRACT = CONTRACT
	return () => {
		for (const key of keys) {
			const value = previous.get(key)
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

function httpSink(): { sink: ChatPointerHttpSink; done: Promise<{ status: number; json: Record<string, unknown> }> } {
	let finish: (value: { status: number; json: Record<string, unknown> }) => void = () => {}
	const done = new Promise<{ status: number; json: Record<string, unknown> }>((resolve) => { finish = resolve })
	const sink: ChatPointerHttpSink = {
		headersSent: false,
		status(code: number) {
			return {
				json(payload: unknown) {
					return {
						end() {
							sink.headersSent = true
							finish({ status: code, json: payload as Record<string, unknown> })
						},
					}
				},
			}
		},
	}
	return { sink, done }
}

type CallerMock = {
	dir: string
	seen: Seen[]
	sender: Wallet
	rawHash: string
	legacyReads: string[]
}

function pointerBody(owner: string, nonce = '1') {
	return {
		owner,
		indexHash: `0x${'11'.repeat(32)}`,
		ts: '1',
		seq: '1',
		nonce,
		signature: `0x${'22'.repeat(65)}`,
	}
}

/** One mock signer. Restores any ledger env from outside this file so the two cases stay isolated. */
async function withCallerMock(run: (ctx: CallerMock) => Promise<void>): Promise<void> {
	const prevLedger = process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
	const dir = mkdtempSync(join(tmpdir(), 'caller-entry-'))
	const seen: Seen[] = []
	const legacyReads: string[] = []
	let server: Server | undefined
	let restore: (() => void) | undefined
	try {
		writeCerts(dir)
		const sender = Wallet.createRandom()
		const raw = await sender.signTransaction({
			to: CONTRACT,
			value: 0,
			nonce: 0,
			gasLimit: 150_000,
			gasPrice: 1,
			chainId: 224422,
		})
		const rawHash = Transaction.from(raw).hash!
		server = await listen(dir, seen, sender.address, raw, rawHash)
		restore = useEnv((server.address() as { port: number }).port, dir)
		await run({ dir, seen, sender, rawHash, legacyReads })
	} finally {
		setIsolatedChatRelayIdle([])
		delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
		resetChatWriteStopForTests()
		if (prevLedger !== undefined) process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = prevLedger
		restore?.()
		server?.close()
		rmSync(dir, { recursive: true, force: true })
	}
}

test('unset chat ledger refuses setChatIndexPointer and does not reach the mock send', async () => {
	await withCallerMock(async ({ seen, sender }) => {
		// Fail closed: an unpersisted token could be resent by the legacy pool after restart.
		// There is no silent temp-file default, so a missing ledger must refuse before broadcast.
		delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
		resetChatWriteStopForTests()
		const provider = {
			getTransactionReceipt: async (): Promise<TransactionReceipt> => ({ status: 1, to: CONTRACT, from: sender.address } as TransactionReceipt),
		} as Provider
		setIsolatedChatRelayIdle([
			new RemoteSigner(WalletSignerClient.fromEnv(), { keyArray: CHAT_ARRAY, chainId: 224422, address: sender.address }, provider),
		])
		const refused = httpSink()
		writeIsolatedChatPointerResponse(pointerBody(sender.address), refused.sink)
		const result = await refused.done
		assert.equal(result.status, 400)
		assert.equal(result.json.success, false)
		assert.equal(result.json.retryable, false)
		assert.equal(result.json.error, 'chat_token_ledger_unconfigured')
		assert.equal(seen.some((row) => row.method === 'signer_sendTransaction'), false)
	})
})

test('settle roster and setChatIndexPointer entry reach the mock RPC', async () => {
	await withCallerMock(async ({ dir, seen, sender, rawHash, legacyReads }) => {
		// Own file under this test's temp directory. Not the process temp root and not the old default name.
		process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = join(dir, 'chat-token-ledger.json')
		resetChatWriteStopForTests()
		const roster = await loadSettleRelayRoster({
			remote: true,
			keyArray: SETTLE_ARRAY,
			conetChainId: 224422,
			baseChainId: 8453,
			lookup: WalletSignerClient.fromEnv(),
			readLegacyKeys: () => {
				legacyReads.push('read')
				return []
			},
		})
		assert.equal(roster.ok, true)
		assert.equal(roster.mode, 'remote')
		if (roster.ok && roster.mode === 'remote') {
			assert.equal(roster.legacyKeyReads, 0)
			assert.equal(roster.placed[0]?.base, true)
		}
		assert.equal(legacyReads.length, 0)
		assert.deepEqual(seen.map((row) => [row.method, row.params.keyArray, row.params.chainId]), [
			['signer_accounts', SETTLE_ARRAY, 224422],
			['signer_accounts', SETTLE_ARRAY, 8453],
		])

		const provider = {
			getTransactionReceipt: async (): Promise<TransactionReceipt> => ({ status: 1, to: CONTRACT, from: sender.address } as TransactionReceipt),
		} as Provider
		setIsolatedChatRelayIdle([
			new RemoteSigner(WalletSignerClient.fromEnv(), { keyArray: CHAT_ARRAY, chainId: 224422, address: sender.address }, provider),
		])
		const body = pointerBody(sender.address)
		const allow = httpSink()
		writeIsolatedChatPointerResponse(body, allow.sink)
		const allowed = await allow.done
		assert.equal(allowed.status, 200)
		assert.equal(allowed.json.success, true)
		assert.equal(allowed.json.txHash, rawHash)
		const send = seen.find((row) => row.method === 'signer_sendTransaction')
		assert.equal(send?.params.keyArray, CHAT_ARRAY)
		assert.equal(send?.params.chainId, 224422)
		assert.equal(send?.params.value, '0')
		assert.equal(send?.params.idempotencyKey, `chat:${sender.address.toLowerCase()}:1`)

		const deny = httpSink()
		writeIsolatedChatPointerResponse(pointerBody(sender.address, '99'), deny.sink)
		const denied = await deny.done
		assert.equal(denied.status, 400)
		assert.equal(denied.json.success, false)
		assert.notEqual(denied.json.error, 'chat_token_ledger_unconfigured')
		assert.equal(seen.filter((row) => row.method === 'signer_sendTransaction' && String(row.params.idempotencyKey).endsWith(':99')).length, 1)
		assert.equal(legacyReads.length, 0)
	})
})

test('settle roster does not read legacy keys when the mock RPC refuses', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'caller-entry-deny-'))
	let server: Server | undefined
	let restore: (() => void) | undefined
	let legacyReads = 0
	try {
		writeCerts(dir)
		server = createServer(
			{
				cert: readFileSync(join(dir, 'server.crt')),
				key: readFileSync(join(dir, 'server.key')),
				ca: readFileSync(join(dir, 'ca.crt')),
				requestCert: true,
				rejectUnauthorized: false,
				minVersion: 'TLSv1.3',
			},
			(req, res) => {
				const chunks: Buffer[] = []
				req.on('data', (chunk) => chunks.push(chunk as Buffer))
				req.on('end', () => {
					const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number }
					res.setHeader('content-type', 'application/json')
					res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32003, message: 'policy denied' } }))
				})
			},
		)
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
		restore = useEnv((server.address() as { port: number }).port, dir)
		const roster = await loadSettleRelayRoster({
			remote: true,
			keyArray: SETTLE_ARRAY,
			conetChainId: 224422,
			baseChainId: 8453,
			lookup: WalletSignerClient.fromEnv(),
			readLegacyKeys: () => {
				legacyReads += 1
				return ['0xabc']
			},
		})
		assert.equal(roster.ok, false)
		if (!roster.ok) assert.equal(roster.code, 'signer_unavailable')
		assert.equal(legacyReads, 0)
		await assert.rejects(
			() => WalletSignerClient.fromEnv().accounts(SETTLE_ARRAY, 224422),
			(err: unknown) => err instanceof WalletSignerError && err.signerCode === -32003,
		)
	} finally {
		restore?.()
		server?.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
