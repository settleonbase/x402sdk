/**
 * Local Anvil + real ChatIndexRegistry bytecode.
 * The send callback is submitIsolatedChatPointer itself. It must attach the chat: key.
 * This file does not import util.ts, settleContractPool.ts, or chatIndexPointer.ts.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { connect as connectSocket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { Contract, Interface, JsonRpcProvider, Wallet, id, type HDNodeWallet, type TransactionReceipt } from 'ethers'
import { newMnemonic, mnemonicToEntropyBytes } from '../../packages/wallet-signer/src/hd'
import { createVaultJson } from '../../packages/wallet-signer/src/vault'
import { WalletSignerClient, WalletSignerError, RemoteSigner } from './remoteSigner'
import { handleSetChatIndexPointerHttp, type ChatPointerHttpBody } from './chatPointerRelayGate'
import { chatPointerIdempotencyKey, submitIsolatedChatPointer } from './chatPointerIsolatedSend'
import { isolatedChatRelayIdleCount, setIsolatedChatRelayIdle } from './isolatedChatRelayPool'

const CLIENT = 'conet-beamio-api'
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ANVIL_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ARTIFACT_ROOT = process.env.CHAT_INDEX_ARTIFACT_ROOT ?? ''
const MAIN = join(process.cwd(), 'packages/wallet-signer/dist/src/main.js')
const EXAMPLE = join(process.cwd(), 'packages/wallet-signer/deploy/policy.example.json')
const REGISTRY_ABI = [
	'function version() view returns (uint256)',
	'function admins(address) view returns (bool)',
	'function getPointer(address) view returns (bytes32 indexHash, uint64 ts, uint64 seq, uint64 updatedAt)',
	'function nonceOf(address) view returns (uint256)',
	'event PointerUpdated(address indexed owner, bytes32 indexHash, uint64 ts, uint64 seq, uint256 nonce)',
]

test('isolated setPointer keeps one chain execution and refuses the old pool', { timeout: 90_000 }, async () => {
	assert.equal(loadedSecretModules(), false)
	const dir = mkdtempSync(join(tmpdir(), 'p5-chat-chain-'))
	const password = `local-test-${'p'.repeat(8)}`
	let anvil: ChildProcess | undefined
	let signer: ChildProcess | undefined
	let client: WalletSignerClient | undefined
	let legacyReads = 0
	try {
		execFileSync('anvil', ['--version'], { stdio: 'ignore' })
		execFileSync('cast', ['--version'], { stdio: 'ignore' })
		execFileSync('openssl', ['version'], { stdio: 'ignore' })
		const rpcPort = 18545
		assert.equal(await portOpen(rpcPort), false, '127.0.0.1:18545 is already in use')
		anvil = spawn('anvil', [
			'--host', '127.0.0.1',
			'--port', String(rpcPort),
			'--chain-id', '224422',
			'--gas-price', '1000000000',
			'--base-fee', '1000000000',
			'--accounts', '1',
		], { stdio: ['ignore', 'pipe', 'pipe'] })
		const anvilLog = collect(anvil)
		const rpc = `http://127.0.0.1:${rpcPort}`
		const provider = new JsonRpcProvider(rpc, 224422, { staticNetwork: true })
		await waitChain(provider, anvil, anvilLog)
		const impl = castCreate(rpc, artifactBytecode('ChatIndexRegistry.sol', 'ChatIndexRegistry'))
		const init = execFileSync('cast', ['calldata', 'initialize(address)', ANVIL_ADDR], { encoding: 'utf8' }).trim()
		const args = execFileSync('cast', ['abi-encode', 'constructor(address,bytes)', impl, init], { encoding: 'utf8' }).trim()
		const proxy = castCreate(rpc, artifactBytecode('ChatIndexRegistryProxy.sol', 'ChatIndexRegistryProxy') + args.slice(2))
		const registry = new Contract(proxy, REGISTRY_ABI, provider)
		assert.equal(await registry.version(), 1n)
		assert.equal(await registry.admins(ANVIL_ADDR), true)

		writeCerts(dir)
		const phrase = newMnemonic()
		const entropy = mnemonicToEntropyBytes(phrase)
		writeFileSync(join(dir, 'vault.json'), await createVaultJson(entropy, password, 2 ** 12), { mode: 0o600 })
		entropy.fill(0)
		writePolicy(dir, proxy)
		writeFileSync(join(dir, 'compromised.json'), '{"addresses":[]}\n')
		const tlsPort = 18443
		assert.equal(await portOpen(tlsPort), false, '127.0.0.1:18443 is already in use')
		writeConfig(dir, tlsPort, rpcPort)
		signer = startSigner(dir)
		await waitStarted(signer)
		await admin(join(dir, 'admin.sock'), 'unlock', { password })
		await admin(join(dir, 'admin.sock'), 'array.add', { name: 'chat_index_pointer', count: 2, chains: [224422] })
		client = new WalletSignerClient({
			url: `https://127.0.0.1:${tlsPort}`,
			cert: readFileSync(join(dir, 'client.crt')),
			key: readFileSync(join(dir, 'client.key')),
			ca: readFileSync(join(dir, 'ca.crt')),
			servername: 'localhost',
		})
		const relayers = await client.accounts('chat_index_pointer', 224422)
		assert.equal(relayers.length, 2)
		for (const addr of relayers) await provider.send('anvil_setBalance', [addr, '0xDE0B6B3A7640000'])
		setIsolatedChatRelayIdle(relayers.map((address) => new RemoteSigner(client!, {
			keyArray: 'chat_index_pointer',
			chainId: 224422,
			address,
		}, provider)))
		const env = {
			WALLET_SIGNER_CHAT_POINTER_ARRAY: 'chat_index_pointer',
			WALLET_SIGNER_CHAT_POINTER_CONTRACT: proxy,
		}
		const send = (call: { to: string; data: string; chainId: number; value: bigint; gasLimit: bigint }) => submitIsolatedChatPointer(call)
		const deps = () => ({
			isolationActive: true,
			env,
			lookup: client!,
			readLegacyKeys: () => {
				legacyReads += 1
				throw new Error('chat pointer relay refused a legacy private-key read')
			},
			send,
		})

		const ownerA = Wallet.createRandom()
		const hashA = id('p5-isolated-pointer-a')
		const bodyA = await pointerBody(ownerA, proxy, hashA, '0')
		const keyA = chatPointerIdempotencyKey(ownerA.address, '0')
		const first = await handleSetChatIndexPointerHttp(bodyA, deps())
		assert.equal(first.deferred, false)
		if (first.deferred) return
		if (first.status !== 200) throw new Error(`first send ${first.status} ${JSON.stringify(first.json)}`)
		const txHash = String(first.json.txHash)
		const stored = await client.getTransaction({ idempotencyKey: keyA })
		assert.equal(stored?.hash, txHash)
		assert.equal(stored?.idempotencyKey, keyA)
		const receipt = await provider.getTransactionReceipt(txHash)
		assert.equal(receipt?.status, 1)
		assert.equal(pointerEvent(receipt!, ownerA.address)?.args.indexHash, hashA)
		const pointer = await registry.getPointer(ownerA.address)
		assert.equal(pointer.indexHash, hashA)
		assert.equal(await registry.nonceOf(ownerA.address), 1n)
		const sender = stored!.from
		assert.equal(await provider.getTransactionCount(sender), 1)

		const again = await handleSetChatIndexPointerHttp(bodyA, deps())
		assert.equal(again.deferred, false)
		if (again.deferred) return
		assert.equal(again.status, 200)
		assert.equal(again.json.txHash, txHash)
		assert.equal(await provider.getTransactionCount(sender), 1)
		assert.equal(await registry.nonceOf(ownerA.address), 1n)

		const other = await pointerBody(ownerA, proxy, id('p5-isolated-pointer-other'), '0')
		const conflict = await handleSetChatIndexPointerHttp(other, deps())
		assert.equal(conflict.deferred, false)
		if (conflict.deferred) return
		assert.equal(conflict.status, 400)
		assert.match(String(conflict.json.error), /different request/)
		assert.equal(await provider.getTransactionCount(sender), 1)
		assert.equal(await registry.nonceOf(ownerA.address), 1n)

		const ownerB = Wallet.createRandom()
		const hashB = id('p5-isolated-pointer-b')
		const bodyB = await pointerBody(ownerB, proxy, hashB, '0')
		const before = await counts(provider, relayers)
		const [left, right] = await Promise.all([
			handleSetChatIndexPointerHttp(bodyB, deps()),
			handleSetChatIndexPointerHttp(bodyB, deps()),
		])
		assert.equal(left.deferred, false)
		assert.equal(right.deferred, false)
		if (left.deferred || right.deferred) return
		assert.equal(left.status, 200, JSON.stringify(left.json))
		assert.equal(right.status, 200, JSON.stringify(right.json))
		assert.equal(left.json.txHash, right.json.txHash)
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal((await counts(provider, relayers)) - before, 1)
		assert.equal(await registry.nonceOf(ownerB.address), 1n)

		const ownerC = Wallet.createRandom()
		const hashC = id('p5-isolated-pointer-c')
		const bad = await pointerBody(Wallet.createRandom(), proxy, hashC, '0')
		bad.owner = ownerC.address
		const beforeBad = await counts(provider, relayers)
		const failed = await handleSetChatIndexPointerHttp(bad, deps())
		assert.equal(failed.deferred, false)
		if (failed.deferred) return
		assert.equal(failed.status, 400)
		assert.match(String(failed.json.error), /simulation reverted/)
		const keyC = chatPointerIdempotencyKey(ownerC.address, '0')
		assert.equal(await client.getTransaction({ idempotencyKey: keyC }), null)
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal(await counts(provider, relayers), beforeBad)
		assert.equal(await registry.nonceOf(ownerC.address), 0n)
		const good = await pointerBody(ownerC, proxy, hashC, '0')
		const recovered = await handleSetChatIndexPointerHttp(good, deps())
		assert.equal(recovered.deferred, false)
		if (recovered.deferred) return
		assert.equal(recovered.status, 200, JSON.stringify(recovered.json))
		assert.equal(await registry.nonceOf(ownerC.address), 1n)
		assert.equal((await client.getTransaction({ idempotencyKey: keyC }))?.hash, recovered.json.txHash)
		await new Promise((resolve) => setTimeout(resolve, 400))
		assert.equal((await counts(provider, relayers)) - beforeBad, 1)

		const idleBeforeDeny = isolatedChatRelayIdleCount()
		const deniedPool = await handleSetChatIndexPointerHttp(bodyA, {
			...deps(),
			env: { ...env, WALLET_SIGNER_CHAT_POINTER_ARRAY: 'settle_contractAdmin' },
		})
		assert.equal(deniedPool.deferred, false)
		if (deniedPool.deferred) return
		assert.equal(deniedPool.status, 503)
		assert.equal(isolatedChatRelayIdleCount(), idleBeforeDeny)
		assert.equal(legacyReads, 0)
		const denyData = new Interface([
			'function setPointerWithSig(address,bytes32,uint64,uint64,uint256,bytes)',
		]).encodeFunctionData('setPointerWithSig', [ANVIL_ADDR, id('deny'), 1n, 1n, 0n, `0x${'11'.repeat(65)}`])
		await expectDeny(client, proxy, { keyArray: 'settle_contractAdmin', data: denyData, idempotencyKey: 'deny-array' })
		await expectDeny(client, proxy, { value: '1', data: denyData, idempotencyKey: 'deny-value' })
		const badClient = new WalletSignerClient({
			url: `https://127.0.0.1:${tlsPort}`,
			cert: readFileSync(join(dir, 'bad.crt')),
			key: readFileSync(join(dir, 'bad.key')),
			ca: readFileSync(join(dir, 'ca.crt')),
			servername: 'localhost',
		})
		await assert.rejects(() => badClient.accounts('chat_index_pointer', 224422))
		badClient.close()
		assert.equal(loadedSecretModules(), false)
		console.log(`PASS proxy=${proxy} impl=${impl} tx=${txHash} legacyReads=${legacyReads}`)
	} finally {
		client?.close()
		if (signer && signer.exitCode == null) {
			signer.kill('SIGTERM')
			await waitExit(signer)
		}
		if (anvil && anvil.exitCode == null) {
			anvil.kill('SIGTERM')
			await waitExit(anvil)
		}
		setIsolatedChatRelayIdle([])
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
	}
})

function loadedSecretModules(): boolean {
	return Object.keys(require.cache).some((file) =>
		file.includes(`${sep}src${sep}util.js`)
		|| file.includes(`${sep}src${sep}settleContractPool.js`)
		|| file.includes(`${sep}src${sep}chatIndexPointer.js`)
		|| file.includes(`${sep}src${sep}endpoint${sep}beamioMaster.js`))
}

function artifactBytecode(file: string, contract: string): string {
	if (!ARTIFACT_ROOT) throw new Error('CHAT_INDEX_ARTIFACT_ROOT is required')
	const path = join(ARTIFACT_ROOT, file, `${contract}.json`)
	const json = JSON.parse(readFileSync(path, 'utf8')) as { bytecode?: string | { object?: string }; contractName?: string }
	const bytecode = typeof json.bytecode === 'string' ? json.bytecode : json.bytecode?.object
	if (!bytecode || json.contractName !== contract) throw new Error(`missing bytecode for ${contract}`)
	return bytecode
}

function castCreate(rpc: string, bytecode: string): string {
	const out = execFileSync('cast', [
		'send', '--private-key', ANVIL_KEY, '--rpc-url', rpc, '--json', '--create', bytecode,
	], { encoding: 'utf8' })
	const parsed = JSON.parse(out) as { contractAddress?: string }
	if (!parsed.contractAddress) throw new Error('cast create returned no address')
	return parsed.contractAddress
}

async function pointerBody(owner: HDNodeWallet, proxy: string, indexHash: string, nonce: string): Promise<ChatPointerHttpBody> {
	const signature = await owner.signTypedData(
		{ name: 'ChatIndexRegistry', version: '1', chainId: 224422, verifyingContract: proxy },
		{ SetPointer: [
			{ name: 'owner', type: 'address' },
			{ name: 'indexHash', type: 'bytes32' },
			{ name: 'ts', type: 'uint64' },
			{ name: 'seq', type: 'uint64' },
			{ name: 'nonce', type: 'uint256' },
		] },
		{ owner: owner.address, indexHash, ts: 1700000000000n, seq: 1n, nonce: BigInt(nonce) },
	)
	return { owner: owner.address, indexHash, ts: '1700000000000', seq: '1', nonce, signature }
}

function pointerEvent(receipt: TransactionReceipt, owner: string) {
	const registry = new Interface(REGISTRY_ABI)
	return receipt.logs.map((log) => {
		try { return registry.parseLog(log) } catch { return null }
	}).find((parsed) => parsed?.name === 'PointerUpdated' && parsed.args.owner === owner)
}

async function counts(provider: JsonRpcProvider, addrs: string[]): Promise<number> {
	const values = await Promise.all(addrs.map((addr) => provider.getTransactionCount(addr)))
	return values.reduce((sum, n) => sum + n, 0)
}

async function expectDeny(client: WalletSignerClient, proxy: string, patch: Record<string, unknown>) {
	const body = {
		keyArray: 'chat_index_pointer',
		chainId: 224422,
		to: proxy,
		data: '0x',
		value: '0',
		gasLimit: '150000',
		idempotencyKey: 'deny',
		...patch,
	}
	await assert.rejects(
		() => client.call('signer_sendTransaction', body),
		(err: unknown) => err instanceof WalletSignerError && err.signerCode === -32003,
	)
}

function portOpen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connectSocket(port, '127.0.0.1')
		sock.once('connect', () => {
			sock.end()
			resolve(true)
		})
		sock.once('error', () => resolve(false))
	})
}

function collect(child: ChildProcess): { text: string } {
	const log = { text: '' }
	child.stdout?.on('data', (chunk) => { log.text += chunk.toString() })
	child.stderr?.on('data', (chunk) => { log.text += chunk.toString() })
	return log
}

async function waitChain(provider: JsonRpcProvider, child: ChildProcess, log: { text: string }): Promise<void> {
	const deadline = Date.now() + 8_000
	let last = ''
	for (;;) {
		if (child.exitCode != null) throw new Error(`anvil exited ${child.exitCode}\n${log.text}`)
		try {
			const chainId = await provider.send('eth_chainId', [])
			if (chainId === '0x36ca6') return
			last = String(chainId)
		} catch (err) {
			last = err instanceof Error ? err.message : String(err)
		}
		if (Date.now() > deadline) throw new Error(`anvil not ready: ${last}\n${log.text}`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

function writePolicy(dir: string, proxy: string): void {
	const file = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as {
		clients: Record<string, { arrays: Record<string, { allow: { to: string }[]; dailyGasBudgetWei?: unknown; maxGasPriceGwei?: unknown; maxInflightPerKey?: number; rate?: unknown }> }>
	}
	const grant = file.clients[CLIENT]!.arrays.chat_index_pointer!
	grant.allow[0]!.to = proxy
	grant.dailyGasBudgetWei = { '224422': '500000000000000000' }
	grant.maxGasPriceGwei = { '224422': 2 }
	grant.maxInflightPerKey = 8
	grant.rate = { perMinute: 1000, perDay: 100000 }
	writeFileSync(join(dir, 'policy.json'), JSON.stringify(file))
}

function writeConfig(dir: string, port: number, rpcPort: number): void {
	writeFileSync(join(dir, 'config.json'), JSON.stringify({
		dataDir: dir,
		logDir: dir,
		adminSocket: join(dir, 'admin.sock'),
		policyFile: join(dir, 'policy.json'),
		compromisedFile: join(dir, 'compromised.json'),
		scryptN: 2 ** 12,
		keyWaitMs: 1000,
		gasKeeper: { enabled: false, intervalMs: 60_000, chains: {} },
		alerts: {},
		rpc: { tls: { host: '127.0.0.1', port, cert: join(dir, 'server.crt'), key: join(dir, 'server.key'), ca: join(dir, 'ca.crt') } },
		chains: { '224422': { rpcUrls: [`http://127.0.0.1:${rpcPort}`], resendAfterMs: 60_000, maxResends: 1, receiptPollMs: 200 } },
	}))
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
	collect(child)
	return child
}

function waitStarted(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('signer did not start')), 8_000)
		const look = (chunk: Buffer) => {
			if (chunk.toString().includes('started LOCKED')) {
				clearTimeout(timer)
				resolve()
			}
		}
		child.stdout?.on('data', look)
		child.stderr?.on('data', look)
		child.once('exit', (code) => {
			clearTimeout(timer)
			reject(new Error(`signer exited ${code}`))
		})
	})
}

function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode != null) return Promise.resolve()
	return new Promise((resolve) => child.once('exit', () => resolve()))
}

function admin(socketPath: string, cmd: string, args: Record<string, unknown>): Promise<{ ok: boolean }> {
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
			resolve(JSON.parse(buf) as { ok: boolean })
		})
		sock.on('error', (err) => {
			clearTimeout(timer)
			reject(err)
		})
		sock.write(`${JSON.stringify({ cmd, args })}\n`)
	})
}
