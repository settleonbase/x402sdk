/**
 * Local signer HTTP proof for the isolated chat pointer.
 * Requests are posted to the signer's JSON-RPC listener and are not passed through
 * authorizeChatPointerCall. The allowed call also goes through handleSetChatIndexPointerHttp.
 * Keys are a temporary test vault. The chain RPC is a local mock. Nothing is broadcast.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, Transaction, getAddress, id } from 'ethers'
import { paths, type Config } from '../../packages/wallet-signer/src/config'
import { newMnemonic, mnemonicToEntropyBytes } from '../../packages/wallet-signer/src/hd'
import { Policy } from '../../packages/wallet-signer/src/policy'
import { startRpcServers } from '../../packages/wallet-signer/src/rpcServer'
import { SignerService } from '../../packages/wallet-signer/src/service'
import { createVaultJson } from '../../packages/wallet-signer/src/vault'
import { CHAT_POINTER_CONTRACT_PLACEHOLDER, CHAT_POINTER_METHOD, handleSetChatIndexPointerHttp } from './chatPointerRelayGate'

const EXAMPLE = join(process.cwd(), 'packages/wallet-signer/deploy/policy.example.json')
const REGISTRY = CHAT_POINTER_CONTRACT_PLACEHOLDER
const EPOCH = '0x648f1a17269627C3d465fEa40b3C229f7CacE5cA'
const GB = '0x62bcc59cC36C737E8AfBb0914F840d12cd33025f'
const CLIENT = 'conet-beamio-api'
const POINTER = `function ${CHAT_POINTER_METHOD}`
const pointerIface = new Interface([POINTER])
const owner = '0x0000000000000000000000000000000000000001'
const indexHash = `0x${'11'.repeat(32)}`
const signature = `0x${'ab'.repeat(65)}`
const pointerData = pointerIface.encodeFunctionData('setPointerWithSig', [owner, indexHash, 1n, 1n, 0n, signature])
const transferData = id('transfer(address,uint256)').slice(0, 10)

type RpcResult = { result?: { hash?: string; duplicate?: boolean }; error?: { code?: number; message?: string } }

test('example policy keeps other grants and does not give setPointer to the settle admin array', () => {
	const file = JSON.parse(readFileSync(EXAMPLE, 'utf8'))
	const policy = new Policy(file)
	const lists = { compromised: new Set<string>(), registry: new Set<string>() }
	const base = { client: CLIENT, chainId: 224422, value: 0n }
	const allowed = policy.checkCall({ ...base, array: 'chat_index_pointer', to: REGISTRY, data: pointerData, gasLimit: 150_000n }, lists)
	assert.equal(allowed.method, CHAT_POINTER_METHOD)
	assert.equal(allowed.maxGas, 300000)
	assert.throws(
		() => policy.checkCall({ ...base, array: 'settle_contractAdmin', to: REGISTRY, data: pointerData }, lists),
		/not in policy/,
	)
	const airdrop = new Interface(['function airdropDepinPaidAll()']).encodeFunctionData('airdropDepinPaidAll', [])
	assert.equal(
		policy.checkCall({ ...base, array: 'gbDepinAirdropAdmin', to: GB, data: airdrop }, lists).method,
		'airdropDepinPaidAll()',
	)
	const update = new Interface(['function updateInfo(uint256,uint256,uint256)']).encodeFunctionData('updateInfo', [1, 2, 3])
	assert.equal(
		policy.checkCall({ client: 'conetapiv4Local', array: 'epochManagre', chainId: 224422, to: EPOCH, data: update, value: 0n }, lists).method,
		'updateInfo(uint256,uint256,uint256)',
	)
	assert.throws(() => Policy.load(join(process.cwd(), 'packages/wallet-signer/deploy/missing-policy.json')))
})

test('signer HTTP enforces the chat pointer grant without the client gate', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'p5-chat-pointer-'))
	const policyPath = join(dir, 'policy.json')
	const sock = join(dir, 'rpc.sock')
	const password = `local-test-${'x'.repeat(8)}`
	let phrase = newMnemonic()
	const entropy = mnemonicToEntropyBytes(phrase)
	phrase = ''
	writeFileSync(policyPath, readFileSync(EXAMPLE))
	writeFileSync(join(dir, 'compromised.json'), '{"addresses":[]}')
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(entropy, password, 2 ** 12), { mode: 0o600 })
	entropy.fill(0)

	const broadcasts: string[] = []
	const unknown: string[] = []
	const mock = await listenMock(broadcasts, unknown)
	const cfg: Config = {
		dataDir: dir,
		logDir: dir,
		adminSocket: join(dir, 'admin.sock'),
		policyFile: policyPath,
		compromisedFile: join(dir, 'compromised.json'),
		rpc: { unix: [{ path: sock, client: CLIENT }] },
		chains: { '224422': { rpcUrls: [`http://127.0.0.1:${mock.port}`], receiptPollMs: 60_000 } },
		gasKeeper: { enabled: false, intervalMs: 60_000, chains: {} },
		alerts: {},
		scryptN: 2 ** 12,
		keyWaitMs: 500,
	}
	const svc = new SignerService(cfg)
	const servers = startRpcServers(svc, cfg.rpc)
	let legacyReads = 0
	try {
		await waitForFile(sock)
		await svc.unlock(password)
		svc.arrayAdd('chat_index_pointer', 1, [224422])
		svc.arrayAdd('settle_contractAdmin', 1, [224422])
		assert.equal(existsSyncVault(paths(cfg).vault), true)

		const rpc = (method: string, params: unknown) => postRpc(sock, method, params)
		const sendDirect = (params: Record<string, unknown>) => rpc('signer_sendTransaction', params)
		const denied = async (params: Record<string, unknown>, pattern: RegExp) => {
			const body = await sendDirect(params)
			assert.equal(body.error?.code, -32003)
			assert.match(body.error?.message ?? '', pattern)
			assert.equal(broadcasts.length, 0)
		}
		const valid = {
			chainId: 224422,
			to: REGISTRY,
			data: pointerData,
			value: '0',
			gasLimit: '150000',
		}
		await denied({ ...valid, keyArray: 'settle_contractAdmin' }, /not in policy/)
		await denied({ ...valid, keyArray: 'chat_index_pointer', chainId: 8453 }, /chain 8453/)
		await denied({ ...valid, keyArray: 'chat_index_pointer', to: EPOCH }, /not in policy/)
		await denied({ ...valid, keyArray: 'chat_index_pointer', data: transferData }, /not in policy/)
		await denied({ ...valid, keyArray: 'chat_index_pointer', value: '1' }, /value above 0/)
		await denied({ ...valid, keyArray: 'chat_index_pointer', gasLimit: '300001' }, /gasLimit above policy max 300000/)

		const stripped = JSON.parse(readFileSync(policyPath, 'utf8')) as { clients: { 'conet-beamio-api': { arrays: Record<string, unknown> } } }
		delete stripped.clients[CLIENT].arrays.chat_index_pointer
		writeFileSync(policyPath, JSON.stringify(stripped))
		svc.reloadPolicy()
		await denied({ ...valid, keyArray: 'chat_index_pointer' }, /no grant for key array chat_index_pointer/)
		writeFileSync(policyPath, readFileSync(EXAMPLE))
		svc.reloadPolicy()

		const earlyCalls = { n: 0 }
		const missingClient = await handleSetChatIndexPointerHttp(
			{ owner, indexHash, ts: '1', seq: '1', nonce: '0', signature },
			{
				isolationActive: true,
				env: {},
				lookup: {
					async accounts() {
						earlyCalls.n += 1
						return []
					},
				},
				readLegacyKeys: () => {
					legacyReads += 1
					return []
				},
				send: async () => {
					earlyCalls.n += 1
					return { txHash: '0x' }
				},
			},
		)
		assert.equal(missingClient.deferred, false)
		if (!missingClient.deferred) {
			assert.equal(missingClient.status, 503)
			assert.equal(missingClient.json.retryable, false)
		}
		assert.equal(earlyCalls.n, 0)
		assert.equal(legacyReads, 0)

		const queued = await handleSetChatIndexPointerHttp(
			{ owner, indexHash, ts: '1', seq: '1', nonce: '0', signature },
			{
				isolationActive: true,
				env: {
					WALLET_SIGNER_CHAT_POINTER_ARRAY: 'chat_index_pointer',
					WALLET_SIGNER_CHAT_POINTER_CONTRACT: REGISTRY,
				},
				lookup: {
					async accounts(keyArray, chainId) {
						const body = await rpc('signer_accounts', { keyArray, chainId })
						if (body.error) throw new Error(body.error.message)
						return body.result as string[]
					},
				},
				readLegacyKeys: () => {
					legacyReads += 1
					return [`0x${'cd'.repeat(32)}`]
				},
				send: async (call) => {
					const body = await rpc('signer_sendTransaction', {
						keyArray: 'chat_index_pointer',
						chainId: call.chainId,
						to: call.to,
						data: call.data,
						value: call.value.toString(),
						gasLimit: call.gasLimit.toString(),
					})
					if (body.error) throw new Error(body.error.message)
					return { txHash: String(body.result?.hash) }
				},
			},
		)
		assert.equal(queued.deferred, false)
		if (queued.deferred) return
		assert.equal(queued.status, 200)
		assert.equal(queued.json.success, true)
		assert.equal(broadcasts.length, 1)
		assert.equal(legacyReads, 0)
		assert.deepEqual(unknown, [])
		const tx = Transaction.from(broadcasts[0])
		assert.equal(getAddress(tx.to ?? ''), getAddress(REGISTRY))
		assert.equal(tx.chainId, 224422n)
		assert.equal(tx.value, 0n)
		assert.ok((tx.gasLimit ?? 0n) <= 300_000n)
		assert.equal((tx.data ?? '').slice(0, 10).toLowerCase(), id(CHAT_POINTER_METHOD).slice(0, 10))
		assert.equal(queued.json.txHash, tx.hash)
	} finally {
		for (const server of servers) server.close()
		svc.stop()
		await closeServer(mock.server)
		rmSync(dir, { recursive: true, force: true })
	}
})

test('idempotency key is bound to the caller and the canonical request', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'p5-idem-'))
	const policyPath = join(dir, 'policy.json')
	const sock = join(dir, 'rpc.sock')
	const otherSock = join(dir, 'other.sock')
	const password = `local-test-${'y'.repeat(8)}`
	let phrase = newMnemonic()
	const entropy = mnemonicToEntropyBytes(phrase)
	phrase = ''
	const policy = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as {
		clients: Record<string, unknown>
	}
	policy.clients['other-daemon'] = JSON.parse(JSON.stringify(policy.clients[CLIENT]))
	writeFileSync(policyPath, JSON.stringify(policy))
	writeFileSync(join(dir, 'compromised.json'), '{"addresses":[]}')
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(entropy, password, 2 ** 12), { mode: 0o600 })
	entropy.fill(0)
	const legacyFrom = '0x00000000000000000000000000000000000000aa'
	const legacyHash = `0x${'ab'.repeat(32)}`
	const legacy = {
		id: `224422:${legacyFrom}:7`,
		idempotencyKey: 'legacy-pointer',
		client: CLIENT,
		array: 'chat_index_pointer',
		chainId: 224422,
		from: legacyFrom,
		to: REGISTRY,
		data: pointerData,
		value: '0',
		nonce: 7,
		gasLimit: '210000',
		type: 2,
		hash: legacyHash,
		hashes: [legacyHash],
		raw: '0x',
		status: 'mined',
		resends: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		lastSentAt: Date.now(),
	}
	writeFileSync(join(dir, 'txjournal.jsonl'), `${JSON.stringify(legacy)}\n`)
	const broadcasts: string[] = []
	const unknown: string[] = []
	const mock = await listenMock(broadcasts, unknown)
	const cfg: Config = {
		dataDir: dir,
		logDir: dir,
		adminSocket: join(dir, 'admin.sock'),
		policyFile: policyPath,
		compromisedFile: join(dir, 'compromised.json'),
		rpc: { unix: [{ path: sock, client: CLIENT }, { path: otherSock, client: 'other-daemon' }] },
		chains: { '224422': { rpcUrls: [`http://127.0.0.1:${mock.port}`], receiptPollMs: 60_000 } },
		gasKeeper: { enabled: false, intervalMs: 60_000, chains: {} },
		alerts: {},
		scryptN: 2 ** 12,
		keyWaitMs: 500,
	}
	const otherData = pointerIface.encodeFunctionData('setPointerWithSig', [owner, indexHash, 2n, 1n, 0n, signature])
	let svc = new SignerService(cfg)
	let servers = startRpcServers(svc, cfg.rpc)
	const send = (socketPath: string, key: string, data: string, gasLimit: string) =>
		postRpc(socketPath, 'signer_sendTransaction', {
			keyArray: 'chat_index_pointer',
			chainId: 224422,
			to: REGISTRY,
			data,
			value: '0',
			gasLimit,
			idempotencyKey: key,
		})
	try {
		await waitForFile(sock)
		await waitForFile(otherSock)
		await svc.unlock(password)
		svc.arrayAdd('chat_index_pointer', 4, [224422])
		const sameLegacy = await send(sock, 'legacy-pointer', pointerData, '120000')
		assert.equal(sameLegacy.result?.hash, legacyHash)
		assert.equal(sameLegacy.result?.duplicate, true)
		assert.equal(broadcasts.length, 0)
		const changedLegacy = await send(sock, 'legacy-pointer', otherData, '120000')
		assert.equal(changedLegacy.error?.code, -32003)
		assert.match(changedLegacy.error?.message ?? '', /different request/)
		assert.equal(broadcasts.length, 0)

		const first = await send(sock, 'fresh-pointer', pointerData, '150000')
		assert.equal(first.error, undefined)
		assert.equal(broadcasts.length, 1)
		const again = await send(sock, 'fresh-pointer', pointerData, '150000')
		assert.equal(again.result?.duplicate, true)
		assert.equal(again.result?.hash, first.result?.hash)
		assert.equal(broadcasts.length, 1)
		const changedGas = await send(sock, 'fresh-pointer', pointerData, '140000')
		assert.equal(changedGas.error?.code, -32003)
		assert.match(changedGas.error?.message ?? '', /different request/)
		assert.equal(broadcasts.length, 1)
		const changedBody = await send(sock, 'fresh-pointer', otherData, '150000')
		assert.equal(changedBody.error?.code, -32003)
		assert.equal(broadcasts.length, 1)

		const paired = await Promise.all([
			send(sock, 'concurrent-same', pointerData, '150000'),
			send(sock, 'concurrent-same', pointerData, '150000'),
		])
		assert.equal(broadcasts.length, 2)
		assert.equal(paired[0]?.result?.hash, paired[1]?.result?.hash)
		assert.equal(paired.filter((row) => row.result?.duplicate).length, 1)
		const raced = await Promise.all([
			send(sock, 'concurrent-diff', pointerData, '150000'),
			send(sock, 'concurrent-diff', otherData, '150000'),
		])
		assert.equal(raced.filter((row) => row.error?.code === -32003).length, 1)
		assert.equal(raced.filter((row) => row.result?.hash).length, 1)
		assert.equal(broadcasts.length, 3)

		const otherClient = await send(otherSock, 'fresh-pointer', pointerData, '150000')
		assert.equal(otherClient.result?.duplicate, undefined)
		assert.notEqual(otherClient.result?.hash, first.result?.hash)
		assert.equal(broadcasts.length, 4)
		const originalStill = await send(sock, 'fresh-pointer', pointerData, '150000')
		assert.equal(originalStill.result?.duplicate, true)
		assert.equal(originalStill.result?.hash, first.result?.hash)
		assert.equal(broadcasts.length, 4)

		await Promise.all(servers.map((server) => closeServer(server)))
		svc.stop()
		for (const path of [sock, otherSock]) {
			if (existsSync(path)) unlinkSync(path)
		}
		svc = new SignerService(cfg)
		servers = startRpcServers(svc, cfg.rpc)
		await waitForFile(sock)
		await svc.unlock(password)
		const afterRestart = await send(sock, 'fresh-pointer', pointerData, '150000')
		assert.equal(afterRestart.result?.duplicate, true)
		assert.equal(afterRestart.result?.hash, first.result?.hash)
		const conflictAfterRestart = await send(sock, 'fresh-pointer', otherData, '150000')
		assert.equal(conflictAfterRestart.error?.code, -32003)
		assert.equal(broadcasts.length, 4)
		assert.deepEqual(unknown, [])
	} finally {
		for (const server of servers) server.close()
		svc.stop()
		await closeServer(mock.server)
		rmSync(dir, { recursive: true, force: true })
	}
})

test('typed data replay follows the contract nonce and retries the same signature', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'p5-typed-'))
	const policyPath = join(dir, 'policy.json')
	const sock = join(dir, 'rpc.sock')
	const otherSock = join(dir, 'other.sock')
	const password = `local-test-${'z'.repeat(8)}`
	const factory = '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB'
	const adminTypes = {
		ExecuteForAdmin: [
			{ name: 'cardAddress', type: 'address' },
			{ name: 'dataHash', type: 'bytes32' },
			{ name: 'deadline', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
		],
	}
	const ownerTypes = {
		ExecuteForOwner: [
			{ name: 'cardAddress', type: 'address' },
			{ name: 'dataHash', type: 'bytes32' },
			{ name: 'deadline', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
		],
	}
	const domain = { name: 'BeamioUserCardFactory', version: '1', chainId: 224422, verifyingContract: factory }
	const basePolicy = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as { clients: Record<string, { arrays: Record<string, { typedData?: unknown[] }> }> }
	const typedData = [
		{ chainId: 224422, verifyingContract: factory, primaryType: 'ExecuteForAdmin', domainName: domain.name, domainVersion: domain.version, types: adminTypes },
		{ chainId: 224422, verifyingContract: factory, primaryType: 'ExecuteForOwner', domainName: domain.name, domainVersion: domain.version, types: ownerTypes },
	]
	basePolicy.clients[CLIENT].arrays.chat_index_pointer.typedData = typedData
	basePolicy.clients['other-daemon'] = JSON.parse(JSON.stringify(basePolicy.clients[CLIENT])) as (typeof basePolicy.clients)[string]
	writeFileSync(policyPath, JSON.stringify(basePolicy))
	writeFileSync(join(dir, 'compromised.json'), '{"addresses":[]}')
	writeFileSync(join(dir, 'typed-data-replay.jsonl'), 'not json\n{"id":"legacy-without-content"}\n')
	let phrase = newMnemonic()
	const entropy = mnemonicToEntropyBytes(phrase)
	phrase = ''
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(entropy, password, 2 ** 12), { mode: 0o600 })
	entropy.fill(0)
	const broadcasts: string[] = []
	const mock = await listenMock(broadcasts, [])
	const cfg: Config = {
		dataDir: dir,
		logDir: dir,
		adminSocket: join(dir, 'admin.sock'),
		policyFile: policyPath,
		compromisedFile: join(dir, 'compromised.json'),
		rpc: { unix: [{ path: sock, client: CLIENT }, { path: otherSock, client: 'other-daemon' }] },
		chains: { '224422': { rpcUrls: [`http://127.0.0.1:${mock.port}`] } },
		gasKeeper: { enabled: false, intervalMs: 60_000, chains: {} },
		alerts: {},
		scryptN: 2 ** 12,
		keyWaitMs: 500,
	}
	const nonce = `0x${'44'.repeat(32)}`
	const card = '0x0000000000000000000000000000000000000002'
	const otherCard = '0x0000000000000000000000000000000000000003'
	const deadline = Math.floor(Date.now() / 1000) + 2
	const message = { cardAddress: card, dataHash: `0x${'11'.repeat(32)}`, deadline, nonce }
	let svc = new SignerService(cfg)
	let servers = startRpcServers(svc, cfg.rpc)
	const sign = (socketPath: string, address: string, primaryType: string, body: Record<string, unknown>, types: unknown) =>
		postRpc(socketPath, 'eth_signTypedData_v4', [address, { domain, types, primaryType, message: body }])
	const auditEvents = () =>
		readFileSync(join(dir, 'audit.jsonl'), 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { event?: string }).event)
	try {
		await waitForFile(sock)
		await svc.unlock(password)
		const added = svc.arrayAdd('chat_index_pointer', 2, [224422]) as { addresses: string[] }[]
		const [firstKey, secondKey] = added[0]!.addresses
		const first = await sign(sock, firstKey!, 'ExecuteForAdmin', message, adminTypes)
		assert.equal(first.error, undefined)
		assert.match(String(first.result), /^0x[0-9a-f]{130}$/i)
		const retry = await sign(sock, firstKey!, 'ExecuteForAdmin', message, adminTypes)
		assert.equal(retry.result, first.result)
		const otherCaller = await sign(otherSock, firstKey!, 'ExecuteForAdmin', message, adminTypes)
		assert.equal(otherCaller.result, first.result)
		const changed = await sign(sock, firstKey!, 'ExecuteForAdmin', { ...message, dataHash: `0x${'55'.repeat(32)}` }, adminTypes)
		assert.equal(changed.error?.code, -32003)
		assert.match(changed.error?.message ?? '', /different content/)
		const paired = await Promise.all([
			sign(sock, firstKey!, 'ExecuteForAdmin', { ...message, cardAddress: otherCard, deadline: deadline + 600 }, adminTypes),
			sign(sock, firstKey!, 'ExecuteForAdmin', { ...message, cardAddress: otherCard, deadline: deadline + 600 }, adminTypes),
		])
		assert.equal(paired[0]?.result, paired[1]?.result)
		assert.match(String(paired[0]?.result), /^0x/)
		const otherAdmin = await sign(sock, secondKey!, 'ExecuteForAdmin', message, adminTypes)
		assert.match(String(otherAdmin.result), /^0x/)
		assert.notEqual(otherAdmin.result, first.result)
		const ownerSig = await sign(sock, firstKey!, 'ExecuteForOwner', message, ownerTypes)
		assert.match(String(ownerSig.result), /^0x/)
		const ownerOtherKey = await sign(sock, secondKey!, 'ExecuteForOwner', message, ownerTypes)
		assert.equal(ownerOtherKey.error?.code, -32003)
		assert.equal(auditEvents().filter((event) => event === 'sign.typed').length, 4)
		await new Promise((resolve) => setTimeout(resolve, 2100))
		const expiredRetry = await sign(sock, firstKey!, 'ExecuteForAdmin', message, adminTypes)
		assert.match(expiredRetry.error?.message ?? '', /expired/)
		const renewed = await sign(sock, firstKey!, 'ExecuteForAdmin', { ...message, deadline: Math.floor(Date.now() / 1000) + 600, dataHash: `0x${'66'.repeat(32)}` }, adminTypes)
		assert.match(String(renewed.result), /^0x/)
		assert.notEqual(renewed.result, first.result)
		await Promise.all(servers.map((server) => closeServer(server)))
		svc.stop()
		for (const path of [sock, otherSock]) if (existsSync(path)) unlinkSync(path)
		svc = new SignerService(cfg)
		servers = startRpcServers(svc, cfg.rpc)
		await waitForFile(sock)
		await svc.unlock(password)
		const signedBefore = auditEvents().filter((event) => event === 'sign.typed').length
		const afterRestart = await sign(sock, firstKey!, 'ExecuteForAdmin', { ...message, cardAddress: otherCard, deadline: deadline + 600 }, adminTypes)
		assert.equal(afterRestart.result, paired[0]?.result)
		assert.equal(auditEvents().filter((event) => event === 'sign.typed').length, signedBefore)
		assert.ok(auditEvents().includes('sign.typed.replay'))
	} finally {
		for (const server of servers) server.close()
		svc.stop()
		await closeServer(mock.server)
		rmSync(dir, { recursive: true, force: true })
	}
})

function existsSyncVault(path: string): boolean {
	try {
		readFileSync(path)
		return true
	} catch {
		return false
	}
}

function postRpc(socketPath: string, method: string, params: unknown): Promise<RpcResult> {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ socketPath, path: '/rpc', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk) => chunks.push(chunk as Buffer))
				res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcResult))
			},
		)
		req.on('error', reject)
		req.end(body)
	})
}

function listenMock(broadcasts: string[], unknown: string[]): Promise<{ server: Server; port: number }> {
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
			else if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') result = '0x3b9aca00'
			else if (method === 'eth_getBalance') result = '0xde0b6b3a7640000'
			else if (method === 'eth_call') result = '0x'
			else if (method === 'eth_estimateGas') result = '0x249f0'
			else if (method === 'eth_getTransactionCount') result = '0x0'
			else if (method === 'eth_sendRawTransaction') {
				const raw = String(msg.params?.[0] ?? '')
				broadcasts.push(raw)
				result = Transaction.from(raw).hash
			} else if (method === 'eth_getTransactionReceipt') result = null
			else unknown.push(method)
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }))
		})
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr == null || typeof addr === 'string') throw new Error('mock rpc did not bind')
			resolve({ server, port: addr.port })
		})
	})
}

function waitForFile(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`socket missing: ${path}`)), 2000)
		const poll = () => {
			if (existsSync(path)) {
				clearTimeout(timer)
				resolve()
				return
			}
			setTimeout(poll, 20)
		}
		poll()
	})
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()))
}
