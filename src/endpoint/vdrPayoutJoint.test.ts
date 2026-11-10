/**
 * Joint regression: the reporter client talks to wallet-signer 18db908 on a
 * local unix socket, and an unresolved pubkey does not advance the scan cursor.
 * No production socket, vault, or daemon is used.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { ethers } from 'ethers'
import { sendConfiguredSettle } from './vdrPayoutSigner.ts'
import { scanBlocksIntoPending, type UnresolvedWithdrawal } from './validatorClRewardPayoutReporter.ts'

const SIGNER_REPO = '/Users/peter/Downloads/BeamioContract/src/signer-gas-keeper-2026-11-09'
const SIGNER_PKG = path.join(SIGNER_REPO, 'packages/wallet-signer')
const SIGNER_REV = '18db908b1a14fccc12cc9b654290c2a72e5370fd'
const SIGNER_DIST = path.join(tmpdir(), 'wallet-signer-18db908')
const VDR = '0xc71e246DD78B37C2fABc905D340932F28F503433'
const PASSWORD = 'joint-socket-password-123'
const PUB_A = '0x' + '11'.repeat(48)
const PUB_B = '0x' + '22'.repeat(48)

type SignerModules = {
	loadConfig: (file: string) => { rpc: { unix?: { path: string; client: string }[] } }
	HdRoot: { fromEntropy: (entropy: Uint8Array) => { wipe: () => void } }
	mnemonicToEntropyBytes: (phrase: string) => Uint8Array
	newMnemonic: () => string
	Keyring: new () => { load: (hd: unknown, x: null) => void; wipe: () => void; pmAddress: string; attestorAddress: string }
	addArray: (registry: unknown, hd: unknown, name: string, count: number, chains: number[]) => { arrays: Array<{ addresses: string[] }> }
	emptyRegistry: (pm: string, attestor: string) => unknown
	saveRegistry: (file: string, registry: unknown) => void
	signRegistry: (keyring: unknown, body: unknown) => unknown
	startRpcServers: (svc: unknown, rpc: unknown) => Array<{ close: (cb: () => void) => void }>
	SignerService: new (cfg: unknown) => { unlock: (password: string) => Promise<void>; lock: (why: string) => void }
	createVaultJson: (entropy: Uint8Array, password: string, scryptN: number) => Promise<string>
}

function eventKey(blockNumber: number, withdrawalIndex: number): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(blockNumber), BigInt(withdrawalIndex)])
	).toLowerCase()
}

function withdrawal(index: number, validatorIndex: number) {
	return {
		index: ethers.toQuantity(index),
		validatorIndex: ethers.toQuantity(validatorIndex),
		address: VDR,
		amount: '0x10',
	}
}

function fakeProvider(blocks: Map<number, unknown>): ethers.JsonRpcProvider {
	return {
		async send(method: string, params: unknown[]) {
			if (method !== 'eth_getBlockByNumber') throw new Error(method)
			return blocks.get(Number(params[0])) ?? null
		},
	} as unknown as ethers.JsonRpcProvider
}

function fakeContract(): ethers.Contract {
	return {
		async getNodeByValidatorPubkeyHash(hash: string) {
			if (hash === ethers.keccak256(PUB_A)) return 4n
			if (hash === ethers.keccak256(PUB_B)) return 5n
			return 0n
		},
		async guardianIdBeneficiary() {
			return '0x0000000000000000000000000000000000000009'
		},
	} as unknown as ethers.Contract
}

test('unresolved pubkey does not advance the cursor and a duplicate eventKey is not queued twice', async () => {
	const blocks = new Map<number, unknown>([
		[100, { withdrawals: [withdrawal(10, 1)] }],
		[101, { withdrawals: [withdrawal(11, 1), withdrawal(12, 2)] }],
		[102, { withdrawals: [withdrawal(13, 1)] }],
	])
	let failIndex2 = true
	const lookup = async (validatorIndex: number) => {
		if (validatorIndex === 1) return PUB_A
		if (validatorIndex === 2) return failIndex2 ? null : PUB_B
		return null
	}
	const pending = new Map()
	const provider = fakeProvider(blocks)
	const contract = fakeContract()
	let lastProcessedBlock = 99

	const first = await scanBlocksIntoPending(provider, contract, VDR, 100, 102, pending, lookup)
	if (first.okThrough != null) lastProcessedBlock = first.okThrough
	assert.equal(lastProcessedBlock, 100)
	assert.equal(first.unresolved.length, 1)
	assert.equal(first.unresolved[0]?.blockNumber, 101)
	assert.equal(first.unresolved[0]?.validatorIndex, 2)
	assert.equal(pending.has(eventKey(100, 10)), true)
	assert.equal(pending.has(eventKey(101, 11)), true)
	assert.equal(pending.has(eventKey(102, 13)), false)
	assert.equal(pending.size, 2)

	const retry = await scanBlocksIntoPending(provider, contract, VDR, lastProcessedBlock + 1, 102, pending, lookup)
	if (retry.okThrough != null) lastProcessedBlock = retry.okThrough
	assert.equal(lastProcessedBlock, 100)
	assert.equal(retry.added, 0)
	assert.equal(retry.unresolved.map((row: UnresolvedWithdrawal) => row.withdrawalIndex).join(','), '12')
	assert.equal(pending.has(eventKey(102, 13)), false)
	assert.equal(pending.size, 2)

	failIndex2 = false
	const mapped = await scanBlocksIntoPending(provider, contract, VDR, lastProcessedBlock + 1, 102, pending, lookup)
	if (mapped.okThrough != null) lastProcessedBlock = mapped.okThrough
	assert.equal(mapped.unresolved.length, 0)
	assert.equal(lastProcessedBlock, 102)
	assert.equal(pending.has(eventKey(101, 12)), true)
	assert.equal(pending.has(eventKey(102, 13)), true)
	assert.equal(pending.size, 4)

	const again = await scanBlocksIntoPending(provider, contract, VDR, 100, 102, pending, lookup)
	assert.equal(again.added, 0)
	assert.equal(again.unresolved.length, 0)
	assert.equal(pending.size, 4)
})

function listenMock(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			try {
			const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params?: unknown[] }
			const raw = typeof msg.params?.[0] === 'string' ? msg.params[0] : '0x'
			const result = msg.method === 'eth_sendRawTransaction'
				? ethers.keccak256(raw)
				: msg.method === 'eth_chainId' ? '0x36d06'
				: msg.method === 'eth_getTransactionCount' ? '0x0'
				: msg.method === 'eth_gasPrice' || msg.method === 'eth_maxPriorityFeePerGas' ? '0x3b9aca00'
				: msg.method === 'eth_getBalance' ? '0x3635c9adc5dea00000'
				: msg.method === 'eth_estimateGas' ? '0x7a120'
				: msg.method === 'eth_blockNumber' ? '0x10'
				: msg.method === 'eth_getBlockByNumber' ? {
					hash: '0x' + '22'.repeat(32),
					parentHash: '0x' + '22'.repeat(32),
					number: '0x10',
					timestamp: '0x65',
					nonce: '0x0000000000000000',
					difficulty: '0x0',
					gasLimit: '0x1c9c380',
					gasUsed: '0x0',
					miner: '0x' + '00'.repeat(20),
					extraData: '0x',
					baseFeePerGas: '0x1',
					transactions: [],
				}
				: '0x'
			const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
			res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
			res.end(body)
			} catch (err) {
				const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: (err as Error).message } })
				res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
				res.end(body)
			}
		})
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr == null || typeof addr === 'string') throw new Error('mock rpc did not bind')
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				close: () => new Promise((done) => server.close(() => done())),
			})
		})
	})
}

async function loadSigner(): Promise<SignerModules> {
	const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SIGNER_REPO, encoding: 'utf8' }).trim()
	assert.equal(rev, SIGNER_REV)
	execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--outDir', SIGNER_DIST, '--pretty', 'false'], {
		cwd: SIGNER_PKG,
		stdio: 'inherit',
	})
	try {
		symlinkSync(path.join(SIGNER_PKG, 'node_modules'), path.join(SIGNER_DIST, 'node_modules'))
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
	}
	const load = (rel: string) => import(pathToFileURL(path.join(SIGNER_DIST, rel)).href)
	await load('src/noWebSocket.js')
	const [config, hd, keyring, registry, rpcServer, service, vault] = await Promise.all([
		load('src/config.js'),
		load('src/hd.js'),
		load('src/keyring.js'),
		load('src/registry.js'),
		load('src/rpcServer.js'),
		load('src/service.js'),
		load('src/vault.js'),
	])
	return {
		loadConfig: config.loadConfig,
		HdRoot: hd.HdRoot,
		mnemonicToEntropyBytes: hd.mnemonicToEntropyBytes,
		newMnemonic: hd.newMnemonic,
		Keyring: keyring.Keyring,
		addArray: registry.addArray,
		emptyRegistry: registry.emptyRegistry,
		saveRegistry: registry.saveRegistry,
		signRegistry: registry.signRegistry,
		startRpcServers: rpcServer.startRpcServers,
		SignerService: service.SignerService,
		createVaultJson: vault.createVaultJson,
	}
}

function post(socketPath: string, params: unknown) {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signer_sendTransaction', params })
	return new Promise<{ result?: { hash?: string }; error?: { code?: number; message?: string } }>((resolve, reject) => {
		const req = httpRequest({
			socketPath,
			path: '/rpc',
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
		}, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
		})
		req.on('error', reject)
		req.end(body)
	})
}

test('reporter settle reaches signer 18db908 and the signer rejects bad calls', { timeout: 180_000 }, async () => {
	const reporter = readFileSync(new URL('./validatorClRewardPayoutReporter.ts', import.meta.url), 'utf8')
	assert.equal(reporter.includes('withSettleWallet('), false)
	assert.equal(reporter.includes('shiftSettleConet('), false)
	assert.doesNotMatch(reporter, /from ['"][^'"]*settleContractPool['"]/)
	assert.match(reporter, /sendConfiguredSettle/)

	const signer = await loadSigner()
	const dir = mkdtempSync(path.join(tmpdir(), 'vdr-joint-'))
	const sock = path.join(dir, 'vdr.sock')
	const mock = await listenMock()
	const phrase = signer.newMnemonic()
	const hd = signer.HdRoot.fromEntropy(signer.mnemonicToEntropyBytes(phrase))
	const keyring = new signer.Keyring()
	keyring.load(hd, null)
	const body = signer.addArray(signer.emptyRegistry(keyring.pmAddress, keyring.attestorAddress), hd, 'beamio_vdr_payout', 1, [224422])
	signer.saveRegistry(path.join(dir, 'registry.json'), signer.signRegistry(keyring, body))
	keyring.wipe()
	hd.wipe()
	mkdirSync(dir, { recursive: true })
	writeFileSync(path.join(dir, 'vault.json'), await signer.createVaultJson(signer.mnemonicToEntropyBytes(phrase), PASSWORD, 2 ** 12), { mode: 0o600 })
	writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({
		version: 1,
		clients: {
			'vdr-payout': {
				arrays: {
					beamio_vdr_payout: {
						chains: [224422],
						maxInflightPerKey: 8,
						allow: [{
							to: VDR,
							selectors: ['settleNodeRewards(uint256[],uint256[],bytes32[])'],
							maxValueWei: '0',
							maxGas: 2000000,
							equalArrays: [0, 1, 2],
							args: {
								'0': { minItems: 1, maxItems: 29 },
								'1': { minItems: 1, maxItems: 29 },
								'2': { minItems: 1, maxItems: 29 },
							},
						}],
					},
				},
			},
		},
	}))
	writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
		dataDir: dir,
		logDir: dir,
		adminSocket: path.join(dir, 'admin.sock'),
		policyFile: path.join(dir, 'policy.json'),
		rpc: { unix: [{ path: sock, client: 'vdr-payout' }] },
		chains: { '224422': { rpcUrls: [mock.url] } },
		gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
	}))
	const cfg = signer.loadConfig(path.join(dir, 'config.json'))
	const svc = new signer.SignerService(cfg)
	await svc.unlock(PASSWORD)
	const servers = signer.startRpcServers(svc, cfg.rpc)
	const settle = new ethers.Interface(['function settleNodeRewards(uint256[] ids, uint256[] amounts, bytes32[] roots)'])
	const word = '0x' + '11'.repeat(32)
	const encode = (ids: number, amounts = ids, roots = ids) => settle.encodeFunctionData('settleNodeRewards', [
		Array.from({ length: ids }, (_, i) => i + 1),
		Array.from({ length: amounts }, (_, i) => (i + 1) * 10),
		Array.from({ length: roots }, () => word),
	])
	const env = {
		CONET_VALIDATOR_CL_REWARD_PAYOUT_SIGNER_SOCKET: sock,
		CONET_VALIDATOR_CL_REWARD_PAYOUT_KEY_ARRAY: 'beamio_vdr_payout',
	}
	try {
		const accepted = await sendConfiguredSettle({
			to: VDR,
			guardianIds: [4n],
			amounts: [10n],
			eventKeys: ['0x' + 'ab'.repeat(32)],
			gasLimit: 500_000,
			env,
		})
		assert.match(accepted.hash, /^0x[0-9a-fA-F]{64}$/)

		const base = {
			keyArray: 'beamio_vdr_payout',
			chainId: 224422,
			to: VDR,
			value: '0',
			gasLimit: '500000',
		}
		const cases: Array<[string, unknown, RegExp]> = [
			['value', { ...base, data: encode(1), value: '1' }, /value above 0 wei/],
			['empty', { ...base, data: encode(0) }, /length 0 is below 1/],
			['over', { ...base, data: encode(30) }, /length 30 is above 29/],
			['unequal', { ...base, data: encode(1, 2, 1) }, /same length/],
			['bad-abi', { ...base, data: settle.getFunction('settleNodeRewards')!.selector + '00' }, /does not decode/],
			['wrong-to', { ...base, to: '0x0000000000000000000000000000000000000001', data: encode(1) }, /not in policy/],
		]
		for (const [label, params, pattern] of cases) {
			const refused = await post(sock, params)
			assert.equal(refused.error?.code, -32003, label)
			assert.match(refused.error?.message ?? '', pattern, label)
			assert.equal(refused.result, undefined, label)
		}
	} finally {
		svc.lock('joint-test')
		await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
		await mock.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
