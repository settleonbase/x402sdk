/**
 * Starts the real wallet-signer process with a temporary vault, a local CA and a mock chain.
 * The app path is handleSetChatIndexPointerHttp over mTLS. Nothing here uses a production key.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, Transaction } from 'ethers'
import { newMnemonic, mnemonicToEntropyBytes } from '../../packages/wallet-signer/src/hd'
import { createVaultJson } from '../../packages/wallet-signer/src/vault'
import { WalletSignerClient, WalletSignerError } from './remoteSigner'
import { CHAT_POINTER_CONTRACT_PLACEHOLDER, CHAT_POINTER_METHOD, handleSetChatIndexPointerHttp } from './chatPointerRelayGate'

const CLIENT = 'conet-beamio-api'
const REGISTRY = CHAT_POINTER_CONTRACT_PLACEHOLDER
const MAIN = join(process.cwd(), 'packages/wallet-signer/dist/src/main.js')
const EXAMPLE = join(process.cwd(), 'packages/wallet-signer/deploy/policy.example.json')
const pointerData = new Interface([`function ${CHAT_POINTER_METHOD}`]).encodeFunctionData('setPointerWithSig', [
	'0x0000000000000000000000000000000000000001',
	`0x${'11'.repeat(32)}`,
	1n,
	1n,
	0n,
	`0x${'ab'.repeat(65)}`,
])

test('signer process accepts one setPointer, rejects the rest, and recovers a dropped RPC', { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'p5-signer-'))
	const raws: string[] = []
	const drop = { left: 1 }
	const fail = { left: 0 }
	const password = `local-test-${'p'.repeat(8)}`
	let child: ChildProcess | undefined
	let mock: Server | undefined
	let client: WalletSignerClient | undefined
	const legacyReads: string[] = []
	try {
		execFileSync('openssl', ['version'], { stdio: 'ignore' })
		writeCerts(dir)
		const phrase = newMnemonic()
		const entropy = mnemonicToEntropyBytes(phrase)
		writeFileSync(join(dir, 'vault.json'), await createVaultJson(entropy, password, 2 ** 12), { mode: 0o600 })
		entropy.fill(0)
		writePolicy(join(dir, 'policy.json'), '500000')
		writeFileSync(join(dir, 'compromised.json'), '{"addresses":[]}\n')
		const rpc = await listen(raws, drop, fail)
		mock = rpc.server
		const port = await freePort()
		writeConfig(dir, port, rpc.port)
		child = startSigner(dir)
		await waitStarted(child)
		await admin(join(dir, 'admin.sock'), 'unlock', { password })
		await admin(join(dir, 'admin.sock'), 'array.add', { name: 'chat_index_pointer', count: 1, chains: [224422] })
		client = new WalletSignerClient({
			url: `https://127.0.0.1:${port}`,
			cert: readFileSync(join(dir, 'client.crt')),
			key: readFileSync(join(dir, 'client.key')),
			ca: readFileSync(join(dir, 'ca.crt')),
			servername: 'localhost',
		})
		const env = {
			WALLET_SIGNER_CHAT_POINTER_ARRAY: 'chat_index_pointer',
			WALLET_SIGNER_CHAT_POINTER_CONTRACT: REGISTRY,
		}
		const send = (key: string) => async (call: { to: string; data: string; chainId: number; value: bigint; gasLimit: bigint }) => {
			const res = await client!.call<{ hash: string; nonce: number; duplicate?: boolean }>('signer_sendTransaction', {
				keyArray: 'chat_index_pointer',
				chainId: call.chainId,
				to: call.to,
				data: call.data,
				value: call.value.toString(),
				gasLimit: call.gasLimit.toString(),
				idempotencyKey: key,
			})
			return { txHash: res.hash }
		}
		const first = await handleSetChatIndexPointerHttp(pointerBody(), {
			isolationActive: true,
			env,
			lookup: client,
			readLegacyKeys: () => {
				legacyReads.push('read')
				return []
			},
			send: send('smoke-pointer'),
		})
		assert.equal(first.deferred, false)
		if (first.deferred) return
		assert.equal(first.status, 200)
		assert.equal(legacyReads.length, 0)
		const again = await handleSetChatIndexPointerHttp(pointerBody(), {
			isolationActive: true,
			env,
			lookup: client,
			readLegacyKeys: () => {
				legacyReads.push('read')
				return []
			},
			send: send('smoke-pointer'),
		})
		assert.equal(again.deferred, false)
		if (again.deferred) return
		assert.equal(again.status, 200)
		assert.equal(again.json.txHash, first.json.txHash)
		assert.equal(unique(raws).length, 1)
		fail.left = 1
		const rejected = await callSend(client, 'smoke-reject')
		assert.equal(rejected.error?.code, -32011)
		assert.match(rejected.error?.message ?? '', /broadcast rejected/)
		const retried = await callSend(client, 'smoke-reject')
		assert.equal(retried.result?.nonce, 1)
		await expectDeny(client, { keyArray: 'settle_contractAdmin', chainId: 224422, idempotencyKey: 'bad-array' })
		await expectDeny(client, { chainId: 8453, idempotencyKey: 'bad-chain' })
		await expectDeny(client, { to: '0x0000000000000000000000000000000000000009', idempotencyKey: 'bad-contract' })
		await expectDeny(client, { data: '0xa9059cbb', idempotencyKey: 'bad-method' })
		await expectDeny(client, { value: '1', idempotencyKey: 'bad-value' })
		const bad = new WalletSignerClient({
			url: `https://127.0.0.1:${port}`,
			cert: readFileSync(join(dir, 'bad.crt')),
			key: readFileSync(join(dir, 'bad.key')),
			ca: readFileSync(join(dir, 'ca.crt')),
			servername: 'localhost',
		})
		await assert.rejects(() => bad.call('signer_status', {}), (err: unknown) => err instanceof WalletSignerError || err instanceof Error)
		bad.close()
		const third = await callSend(client, 'smoke-third')
		assert.equal(third.result?.nonce, 2)
		const over = await callSend(client, 'smoke-over')
		assert.equal(over.error?.code, -32004)
		writePolicy(join(dir, 'policy.json'), '2000000')
		const reloaded = await admin(join(dir, 'admin.sock'), 'policy.reload', {})
		assert.equal(reloaded.ok, true)
		const fourth = await callSend(client, 'smoke-fourth')
		assert.equal(fourth.result?.nonce, 3)
		const noncesBeforeRestart = unique(raws).map((raw) => Transaction.from(raw).nonce)
		assert.deepEqual(noncesBeforeRestart, [0, 1, 2, 3])
		child.kill('SIGTERM')
		await waitExit(child)
		child = startSigner(dir)
		await waitStarted(child)
		await admin(join(dir, 'admin.sock'), 'unlock', { password })
		const replay = await callSend(client, 'smoke-pointer')
		assert.equal(replay.result?.duplicate, true)
		assert.equal(replay.result?.hash, first.json.txHash)
		const after = await callSend(client, 'smoke-after-restart')
		assert.equal(after.result?.nonce, 4)
		assert.equal(legacyReads.length, 0)
	} finally {
		client?.close()
		if (child && child.exitCode == null) {
			child.kill('SIGTERM')
			await waitExit(child)
		}
		if (mock) await new Promise<void>((resolve) => mock!.close(() => resolve()))
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
	}
})

function pointerBody() {
	return {
		owner: '0x0000000000000000000000000000000000000001',
		indexHash: `0x${'11'.repeat(32)}`,
		ts: '1',
		seq: '1',
		nonce: '0',
		signature: `0x${'ab'.repeat(65)}`,
	}
}

function callSend(client: WalletSignerClient, key: string, patch: Record<string, unknown> = {}) {
	return client.call<{ hash?: string; nonce?: number; duplicate?: boolean }>('signer_sendTransaction', {
		keyArray: 'chat_index_pointer',
		chainId: 224422,
		to: REGISTRY,
		data: pointerData,
		value: '0',
		gasLimit: '150000',
		idempotencyKey: key,
		...patch,
	}).then(
		(result) => ({ result, error: undefined }),
		(error: unknown) => ({
			result: undefined,
			error: {
				code: error instanceof WalletSignerError ? error.signerCode : undefined,
				message: error instanceof Error ? error.message : String(error),
			},
		}),
	)
}

async function expectDeny(client: WalletSignerClient, patch: Record<string, unknown>) {
	const res = await callSend(client, String(patch.idempotencyKey), patch)
	assert.equal(res.error?.code, -32003, JSON.stringify(res.error))
}

function unique(raws: string[]): string[] {
	return [...new Set(raws)]
}

function writePolicy(path: string, budget: string): void {
	const file = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as {
		clients: Record<string, { arrays: Record<string, { dailyGasBudgetWei?: unknown; maxGasPriceGwei?: unknown; maxInflightPerKey?: number; rate?: unknown }> }>
	}
	const grant = file.clients[CLIENT]!.arrays.chat_index_pointer!
	grant.dailyGasBudgetWei = { '224422': budget }
	grant.maxGasPriceGwei = { '224422': 100 }
	grant.maxInflightPerKey = 8
	grant.rate = { perMinute: 1000, perDay: 100000 }
	writeFileSync(path, JSON.stringify(file))
}

function writeConfig(dir: string, port: number, rpcPort: number): void {
	writeFileSync(
		join(dir, 'config.json'),
		JSON.stringify({
			dataDir: dir,
			logDir: dir,
			adminSocket: join(dir, 'admin.sock'),
			policyFile: join(dir, 'policy.json'),
			compromisedFile: join(dir, 'compromised.json'),
			scryptN: 2 ** 12,
			keyWaitMs: 1000,
			gasKeeper: { enabled: false, intervalMs: 60_000, chains: {} },
			alerts: {},
			rpc: {
				tls: {
					host: '127.0.0.1',
					port,
					cert: join(dir, 'server.crt'),
					key: join(dir, 'server.key'),
					ca: join(dir, 'ca.crt'),
				},
			},
			chains: { '224422': { rpcUrls: [`http://127.0.0.1:${rpcPort}`], resendAfterMs: 60_000, maxResends: 1, receiptPollMs: 60_000 } },
		}),
	)
}

function writeCerts(dir: string): void {
	const ext = join(dir, 'san.cnf')
	writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
	execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'ca.key')])
	execFileSync('openssl', ['req', '-x509', '-new', '-key', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'), '-days', '1', '-subj', '/CN=wallet-signer-test-ca'])
	execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'server.key')])
	execFileSync('openssl', ['req', '-new', '-key', join(dir, 'server.key'), '-out', join(dir, 'server.csr'), '-subj', '/CN=localhost'])
	execFileSync('openssl', ['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'server.crt'), '-days', '1', '-extfile', ext])
	issueClient(dir, 'client', CLIENT)
	issueClient(dir, 'bad', 'other-app')
}

function issueClient(dir: string, name: string, cn: string): void {
	execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, `${name}.key`)])
	execFileSync('openssl', ['req', '-new', '-key', join(dir, `${name}.key`), '-out', join(dir, `${name}.csr`), '-subj', `/CN=${cn}`])
	execFileSync('openssl', ['x509', '-req', '-in', join(dir, `${name}.csr`), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, `${name}.crt`), '-days', '1'])
}

function startSigner(dir: string): ChildProcess {
	const child = spawn(process.execPath, [MAIN, '--config', join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] })
	let log = ''
	child.stdout?.on('data', (chunk) => {
		log += chunk.toString()
	})
	child.stderr?.on('data', (chunk) => {
		log += chunk.toString()
	})
	;(child as ChildProcess & { log?: string }).log = ''
	const remember = () => {
		;(child as ChildProcess & { log?: string }).log = log
	}
	child.stdout?.on('data', remember)
	child.stderr?.on('data', remember)
	return child
}

function waitStarted(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`signer did not start\n${(child as ChildProcess & { log?: string }).log ?? ''}`)), 8_000)
		const look = (chunk: Buffer) => {
			if (chunk.toString().includes('started LOCKED')) {
				clearTimeout(timer)
				resolve()
			}
		}
		child.stdout?.on('data', look)
		child.once('exit', (code) => {
			clearTimeout(timer)
			reject(new Error(`signer exited ${code}\n${(child as ChildProcess & { log?: string }).log ?? ''}`))
		})
	})
}

function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode != null) return Promise.resolve()
	return new Promise((resolve) => child.once('exit', () => resolve()))
}

function admin(socketPath: string, cmd: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; result?: { nonce?: number } }> {
	return new Promise((resolve, reject) => {
		const sock = connectSocket(socketPath)
		let buf = ''
		const timer = setTimeout(() => {
			sock.destroy()
			reject(new Error(`admin timeout ${cmd}`))
		}, 8_000)
		sock.on('data', (chunk) => {
			buf += chunk.toString()
			if (!buf.includes('\n')) return
			clearTimeout(timer)
			sock.end()
			resolve(JSON.parse(buf) as { ok: boolean; error?: string })
		})
		sock.on('error', (err) => {
			clearTimeout(timer)
			reject(err)
		})
		sock.write(`${JSON.stringify({ cmd, args })}\n`)
	})
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer()
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr == null || typeof addr === 'string') throw new Error('no port')
			const port = addr.port
			server.close(() => resolve(port))
		})
	})
}

function listen(raws: string[], drop: { left: number }, fail: { left: number }): Promise<{ server: Server; port: number }> {
	const block = {
		hash: `0x${'11'.repeat(32)}`,
		parentHash: `0x${'22'.repeat(32)}`,
		number: '0x1',
		timestamp: '0x1',
		nonce: '0x0000000000000000',
		difficulty: '0x0',
		gasLimit: '0x1c9c380',
		gasUsed: '0x0',
		miner: '0x0000000000000000000000000000000000000000',
		extraData: '0x',
		baseFeePerGas: null,
		transactions: [],
	}
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk) => chunks.push(chunk as Buffer))
		req.on('end', () => {
			const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string; params?: unknown[] }
			const method = msg.method ?? ''
			let result: unknown = '0x0'
			if (method === 'eth_chainId') result = '0x36ca6'
			else if (method === 'eth_blockNumber') result = '0x1'
			else if (method === 'eth_getBlockByNumber') result = block
			else if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') result = '0x1'
			else if (method === 'eth_getBalance') result = '0xde0b6b3a7640000'
			else if (method === 'eth_call') result = '0x'
			else if (method === 'eth_estimateGas') result = '0x5208'
			else if (method === 'eth_getTransactionByHash') result = null
			else if (method === 'eth_getTransactionCount') result = '0x0'
			else if (method === 'eth_getTransactionReceipt') result = null
			else if (method === 'eth_sendRawTransaction' && drop.left > 0) {
				drop.left -= 1
				res.destroy()
				return
			} else if (method === 'eth_sendRawTransaction' && fail.left > 0) {
				fail.left -= 1
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'insufficient funds' } }))
				return
			} else if (method === 'eth_sendRawTransaction') {
				const raw = String(msg.params?.[0] ?? '')
				raws.push(raw)
				result = Transaction.from(raw).hash
			}
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }))
		})
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr == null || typeof addr === 'string') throw new Error('mock did not bind')
			resolve({ server, port: addr.port })
		})
	})
}
