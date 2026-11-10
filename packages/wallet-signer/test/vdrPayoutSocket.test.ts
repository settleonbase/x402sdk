/**
 * Local unix-socket mock of the production signer_sendTransaction path.
 * It does not open a production socket and does not talk to 70.35.205.77.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, keccak256 } from 'ethers'
import { loadConfig } from '../src/config'
import { HdRoot, mnemonicToEntropyBytes, newMnemonic } from '../src/hd'
import { Keyring } from '../src/keyring'
import { addArray, emptyRegistry, saveRegistry, signRegistry } from '../src/registry'
import { startRpcServers } from '../src/rpcServer'
import { SignerService } from '../src/service'
import { createVaultJson } from '../src/vault'

const VDR = '0xc71e246DD78B37C2fABc905D340932F28F503433'
const PASSWORD = 'socket-mock-password-123'
const settle = new Interface(['function settleNodeRewards(uint256[] ids, uint256[] amounts, bytes32[] roots)'])
const ZERO = '0x' + '00'.repeat(20)
const HASH = '0x' + '22'.repeat(32)

function settleData(ids: number, amounts = ids, roots = ids): string {
	const word = '0x' + '11'.repeat(32)
	return settle.encodeFunctionData('settleNodeRewards', [
		Array.from({ length: ids }, (_, i) => i + 1),
		Array.from({ length: amounts }, (_, i) => (i + 1) * 10),
		Array.from({ length: roots }, () => word),
	])
}

function answer(method: string, params: unknown[]): unknown {
	switch (method) {
		case 'eth_chainId':
			return '0x36d06'
		case 'eth_blockNumber':
			return '0x10'
		case 'eth_gasPrice':
		case 'eth_maxPriorityFeePerGas':
			return '0x3b9aca00'
		case 'eth_getBalance':
			return '0x3635c9adc5dea00000'
		case 'eth_getTransactionCount':
			return '0x0'
		case 'eth_call':
			return '0x'
		case 'eth_estimateGas':
			return '0x7a120'
		case 'eth_getBlockByNumber':
			return {
				hash: HASH,
				parentHash: HASH,
				number: '0x10',
				timestamp: '0x65',
				nonce: '0x0000000000000000',
				difficulty: '0x0',
				gasLimit: '0x1c9c380',
				gasUsed: '0x0',
				miner: ZERO,
				extraData: '0x',
				baseFeePerGas: '0x1',
				transactions: [],
			}
		case 'eth_sendRawTransaction':
			return keccak256(String(params[0]))
		default:
			return null
	}
}

function listenMock(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params?: unknown[] }
			const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg.method, msg.params ?? []) })
			res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
			res.end(body)
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

function post(socketPath: string, method: string, params: unknown): Promise<{ result?: { hash?: string }; error?: { code?: number; message?: string } }> {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			socketPath,
			path: '/',
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
		}, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk: Buffer) => chunks.push(chunk))
			res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
		})
		req.on('error', reject)
		req.end(body)
	})
}

test('unix socket signer_sendTransaction enforces the VDR settle rule', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vdr-signer-'))
	const sock = join(dir, 'vdr.sock')
	const mock = await listenMock()
	const phrase = newMnemonic()
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(phrase))
	const keyring = new Keyring()
	keyring.load(hd, null)
	const body = addArray(emptyRegistry(keyring.pmAddress, keyring.attestorAddress), hd, 'beamio_vdr_payout', 1, [224422])
	saveRegistry(join(dir, 'registry.json'), signRegistry(keyring, body))
	keyring.wipe()
	hd.wipe()
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(mnemonicToEntropyBytes(phrase), PASSWORD, 2 ** 12), { mode: 0o600 })
	writeFileSync(join(dir, 'policy.json'), JSON.stringify({
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
	writeFileSync(join(dir, 'config.json'), JSON.stringify({
		dataDir: dir,
		logDir: dir,
		adminSocket: join(dir, 'admin.sock'),
		policyFile: join(dir, 'policy.json'),
		rpc: { unix: [{ path: sock, client: 'vdr-payout' }] },
		chains: { '224422': { rpcUrls: [mock.url] } },
		gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
	}))
	mkdirSync(dir, { recursive: true })
	const cfg = loadConfig(join(dir, 'config.json'))
	const svc = new SignerService(cfg)
	await svc.unlock(PASSWORD)
	const servers = startRpcServers(svc, cfg.rpc)
	const send = (data: string, extra: Record<string, unknown> = {}) => post(sock, 'signer_sendTransaction', {
		keyArray: 'beamio_vdr_payout',
		chainId: 224422,
		to: VDR,
		data,
		value: '0',
		gasLimit: '500000',
		...extra,
	})
	try {
		const one = await send(settleData(1))
		assert.equal(one.error, undefined, JSON.stringify(one.error))
		assert.match(one.result?.hash ?? '', /^0x[0-9a-f]{64}$/)
		const full = await send(settleData(29))
		assert.equal(full.error, undefined, JSON.stringify(full.error))
		assert.match(full.result?.hash ?? '', /^0x[0-9a-f]{64}$/)
		for (const [label, call] of [
			['empty', send(settleData(0))],
			['over', send(settleData(30))],
			['unequal', send(settleData(1, 2, 1))],
			['bad-abi', send(settle.getFunction('settleNodeRewards')!.selector + '00')],
			['value', send(settleData(1), { value: '1' })],
			['wrong-to', send(settleData(1), { to: '0x0000000000000000000000000000000000000001' })],
		] as const) {
			const res = await call
			assert.equal(res.error?.code, -32003, label)
			assert.equal(res.result, undefined, label)
		}
		const payout = JSON.parse(JSON.stringify(body.arrays[0]!.addresses[0]))
		const personal = await post(sock, 'personal_sign', ['0x6869', payout])
		assert.equal(personal.error?.code, -32003)
		const typed = await post(sock, 'eth_signTypedData_v4', [payout, { domain: {}, types: {}, message: {} }])
		assert.equal(typed.error?.code, -32003)
	} finally {
		svc.lock('test')
		await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
		await mock.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
