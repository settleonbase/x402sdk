/**
 * Lab payout socket: admission by socket, wallet binding, read-only signer_getAddress.
 * Local unix sockets and a mock RPC only. Never opens a production socket or host.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, getAddress, keccak256 } from 'ethers'
import { loadConfig } from '../src/config'
import { HdRoot, mnemonicToEntropyBytes, newMnemonic } from '../src/hd'
import { Keyring } from '../src/keyring'
import { addArray, emptyRegistry, saveRegistry, signRegistry } from '../src/registry'
import { startAdminFromConfig, startAdminServer } from '../src/adminServer'
import { startRpcServers } from '../src/rpcServer'
import { SignerService } from '../src/service'
import { createVaultJson } from '../src/vault'

const VDR = '0xc71e246DD78B37C2fABc905D340932F28F503433'
const PAYEE = '0x32bE583C8e778FFfC5107BF34820c2B225336201'
const OTHER = '0x0000000000000000000000000000000000000001'
const PASSWORD = 'lab-socket-test-password-123'
const ZERO = '0x' + '00'.repeat(20)
const HASH = '0x' + '22'.repeat(32)
const withdraw = new Interface(['function withdrawNative(address to, uint256 amount)'])
const payoutBatch = new Interface(['function payoutBatch(bytes32 batchId, bytes32[] eventKeys, uint256 amount)'])

function withdrawData(to = PAYEE, amount = 1n): string {
	return withdraw.encodeFunctionData('withdrawNative', [to, amount])
}

let mockGasPrice = '0x989680'
let rawSends = 0 // eth_sendRawTransaction calls that reached the chain mock
function answer(method: string, params: unknown[]): unknown {
	switch (method) {
		case 'eth_chainId':
			return '0x36d06'
		case 'eth_blockNumber':
			return '0x10'
		case 'eth_gasPrice':
			return mockGasPrice // default 0.01 Gwei, under the 0.03 Gwei Lab cap
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
				hash: HASH, parentHash: HASH, number: '0x10', timestamp: '0x65', nonce: '0x0000000000000000',
				difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: ZERO, extraData: '0x',
				baseFeePerGas: '0x1', transactions: [],
			}
		case 'eth_sendRawTransaction':
			rawSends++
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
			resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((done) => server.close(() => done())) })
		})
	})
}

type Rpc = { result?: unknown; error?: { code?: number; message?: string } }

function post(socketPath: string, method: string, params: unknown): Promise<Rpc> {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			socketPath, path: '/', method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
		}, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk: Buffer) => chunks.push(chunk))
			res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc))
		})
		req.on('error', reject)
		req.end(body)
	})
}

type Fixture = {
	dir: string
	labSock: string
	vdrSock: string
	labAddr: string
	vdrAddr: string
	svc: SignerService
	servers: ReturnType<typeof startRpcServers>
	signCalls: { n: number }
	mock: { url: string; close: () => Promise<void> }
}

// The lab grant is read from the shipped fragment so the tests exercise the file Codex will merge.
const LAB_FRAGMENT = JSON.parse(readFileSync(join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.fragment.json'), 'utf8')) as {
	'lab-mining-pool': { arrays: { lab_mining_pool_payout: unknown } }
}
const LAB_POLICY = LAB_FRAGMENT['lab-mining-pool'].arrays.lab_mining_pool_payout
const VDR_POLICY = {
	chains: [224422],
	allow: [{
		to: VDR,
		selectors: ['settleNodeRewards(uint256[],uint256[],bytes32[])'],
		maxValueWei: '0',
		maxGas: 2000000,
	}],
	maxInflightPerKey: 1,
}

async function setup(labCount = 1): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), 'lab-signer-'))
	const labSock = join(dir, 'lab-payout.sock')
	const vdrSock = join(dir, 'vdr.sock')
	const mock = await listenMock()
	const phrase = newMnemonic()
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(phrase))
	const keyring = new Keyring()
	keyring.load(hd, null)
	let body = addArray(emptyRegistry(keyring.pmAddress, keyring.attestorAddress), hd, 'lab_mining_pool_payout', labCount, [224422])
	body = addArray(body, hd, 'beamio_vdr_payout', 1, [224422])
	saveRegistry(join(dir, 'registry.json'), signRegistry(keyring, body))
	const labAddr = body.arrays.find((a) => a.name === 'lab_mining_pool_payout')!.addresses[0]!
	const vdrAddr = body.arrays.find((a) => a.name === 'beamio_vdr_payout')!.addresses[0]!
	keyring.wipe()
	hd.wipe()
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(mnemonicToEntropyBytes(phrase), PASSWORD, 2 ** 12), { mode: 0o600 })
	writeFileSync(join(dir, 'policy.json'), JSON.stringify({
		version: 1,
		clients: {
			'lab-mining-pool': { arrays: { lab_mining_pool_payout: LAB_POLICY } },
			'vdr-payout': { arrays: { beamio_vdr_payout: VDR_POLICY } },
		},
	}))
	writeFileSync(join(dir, 'config.json'), JSON.stringify({
		dataDir: dir,
		logDir: dir,
		adminSocket: join(dir, 'admin.sock'),
		policyFile: join(dir, 'policy.json'),
		rpc: { unix: [
			{ path: labSock, client: 'lab-mining-pool' },
			{ path: vdrSock, client: 'vdr-payout' },
		] },
		chains: { '224422': { rpcUrls: [mock.url] } },
		gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
	}))
	const cfg = loadConfig(join(dir, 'config.json'))
	const svc = new SignerService(cfg)
	await svc.unlock(PASSWORD)
	const signCalls = { n: 0 }
	const kr = (svc as unknown as { keyring: Record<string, (...a: unknown[]) => unknown> }).keyring
	for (const name of ['signTransaction', 'signMessage', 'signTypedData']) {
		const orig = kr[name]
		if (typeof orig !== 'function') continue
		kr[name] = (...a: unknown[]) => {
			signCalls.n++
			return orig.apply(kr, a)
		}
	}
	const servers = startRpcServers(svc, cfg.rpc)
	return { dir, labSock, vdrSock, labAddr, vdrAddr, svc, servers, signCalls, mock }
}

async function teardown(f: Fixture): Promise<void> {
	f.svc.lock('test')
	await Promise.all(f.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
	await f.mock.close()
	rmSync(f.dir, { recursive: true, force: true })
}

function sendWithdraw(f: Fixture, sock: string, data: string, extra: Record<string, unknown> = {}): Promise<Rpc> {
	return post(sock, 'signer_sendTransaction', {
		keyArray: 'lab_mining_pool_payout',
		chainId: 224422,
		to: VDR,
		data,
		value: '0',
		gasLimit: '500000',
		...extra,
	})
}

test('lab socket: signer_getAddress returns the bound address and never signs', async () => {
	const f = await setup()
	try {
		const a = await post(f.labSock, 'signer_getAddress', {})
		assert.equal(a.error, undefined, JSON.stringify(a.error))
		assert.equal(a.result, f.labAddr)
		const b = await post(f.labSock, 'signer_getAddress', { keyArray: 'lab_mining_pool_payout' })
		assert.equal(b.result, f.labAddr)
		assert.equal(f.signCalls.n, 0, 'signer_getAddress must not sign')
	} finally {
		await teardown(f)
	}
})

test('lab socket: positive withdrawNative send to the fixed payee signs once', async () => {
	const f = await setup()
	try {
		const ok = await sendWithdraw(f, f.labSock, withdrawData())
		assert.equal(ok.error, undefined, JSON.stringify(ok.error))
		assert.match(String((ok.result as { hash?: string }).hash ?? ''), /^0x[0-9a-f]{64}$/)
		assert.equal(f.signCalls.n, 1)
	} finally {
		await teardown(f)
	}
})

test('lab payment path: a withdrawNative to any address other than the fixed ConetLabMiningPool makes zero signatures and zero chain submissions', async () => {
	const f = await setup()
	try {
		rawSends = 0
		const ok = await sendWithdraw(f, f.labSock, withdrawData())
		assert.equal(ok.error, undefined, JSON.stringify(ok.error))
		assert.equal(f.signCalls.n, 1, 'control: the fixed payee signs once')
		assert.equal(rawSends, 1, 'control: and exactly one transaction reaches the chain')
		const flip = (hex: string, at: number) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1)
		const wrong = [
			OTHER,
			ZERO,
			f.labAddr, // the Lab signing wallet itself
			f.vdrAddr, // the VDR payout wallet
			VDR, // the redeem contract itself
			getAddress(flip(PAYEE.toLowerCase(), 2)), // first nibble differs
			getAddress(flip(PAYEE.toLowerCase(), 41)), // last nibble differs
		]
		for (const to of wrong) {
			const res = await sendWithdraw(f, f.labSock, withdrawData(to, 1n))
			assert.match(res.error?.message ?? '', /must equal/, to)
			assert.equal(res.result, undefined, to)
		}
		assert.equal(f.signCalls.n, 1, 'no wrong payee reached the signer')
		assert.equal(rawSends, 1, 'no wrong payee produced a chain submission')
	} finally {
		await teardown(f)
	}
	// The same fixed payee in another letter case is the same address and is still accepted (fresh fixture: one in-flight tx per key).
	const g = await setup()
	try {
		rawSends = 0
		const lower = await sendWithdraw(g, g.labSock, withdrawData(PAYEE.toLowerCase(), 2n))
		assert.equal(lower.error, undefined, JSON.stringify(lower.error))
		assert.equal(rawSends, 1)
	} finally {
		await teardown(g)
	}
})

test('lab socket: every out-of-scope call is refused before signing', async () => {
	const f = await setup()
	try {
		const cases: Array<[string, Promise<Rpc>, RegExp]> = [
			['other payee', sendWithdraw(f, f.labSock, withdrawData(OTHER)), /must equal/],
			['other selector (payoutBatch)', sendWithdraw(f, f.labSock, payoutBatch.encodeFunctionData('payoutBatch', ['0x' + '33'.repeat(32), ['0x' + '44'.repeat(32)], 1n])), /not in policy/],
			['other to', sendWithdraw(f, f.labSock, withdrawData(), { to: OTHER }), /not in policy/],
			['value', sendWithdraw(f, f.labSock, withdrawData(), { value: '1' }), /value above/],
			['gas over 800000', sendWithdraw(f, f.labSock, withdrawData(), { gasLimit: '900000' }), /gasLimit above policy max 800000/],
			['wrong chain', sendWithdraw(f, f.labSock, withdrawData(), { chainId: 1 }), /not allowed/],
			['vdr array via lab socket', sendWithdraw(f, f.labSock, withdrawData(), { keyArray: 'beamio_vdr_payout' }), /no grant/],
		]
		for (const [label, call, want] of cases) {
			const res = await call
			assert.match(res.error?.message ?? '', want, label)
			assert.equal(res.result, undefined, label)
		}
		assert.equal(f.signCalls.n, 0, 'refused calls must not reach the signer')
	} finally {
		await teardown(f)
	}
})

test('socket admission: other sockets cannot reach the lab wallet', async () => {
	const f = await setup()
	try {
		const viaVdr = await sendWithdraw(f, f.vdrSock, withdrawData(), { keyArray: 'lab_mining_pool_payout' })
		assert.ok(viaVdr.error, 'vdr socket must not sign with the lab array')
		const addrViaVdr = await post(f.vdrSock, 'signer_getAddress', { keyArray: 'lab_mining_pool_payout' })
		assert.ok(addrViaVdr.error, 'vdr socket must not read the lab address')
		const cross = await post(f.labSock, 'signer_getAddress', { keyArray: 'beamio_vdr_payout' })
		assert.ok(cross.error, 'lab socket must not read the vdr address')
		const vdrOwn = await post(f.vdrSock, 'signer_getAddress', {})
		assert.equal(vdrOwn.result, f.vdrAddr, 'vdr socket keeps its own binding')
		assert.notEqual(f.labAddr, f.vdrAddr)
		assert.equal(f.signCalls.n, 0)
	} finally {
		await teardown(f)
	}
})

test('signer_getAddress refuses a key array with more than one active address', async () => {
	const f = await setup(2)
	try {
		const res = await post(f.labSock, 'signer_getAddress', {})
		assert.ok(res.error, 'two active addresses are ambiguous')
		assert.equal(res.result, undefined)
		assert.equal(f.signCalls.n, 0)
	} finally {
		await teardown(f)
	}
})


function postRaw(socketPath: string, headers: Record<string, string>, method: string, params: unknown): Promise<{ status: number; body: Rpc }> {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			socketPath, path: '/', method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
		}, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk: Buffer) => chunks.push(chunk))
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc }))
		})
		req.on('error', reject)
		req.end(body)
	})
}

test('lab socket: forged X-WS identity headers are refused before any signer call', async () => {
	const f = await setup()
	try {
		const forged = await postRaw(f.labSock, { 'x-ws-client-cn': 'vdr-payout', 'x-ws-client-verify': 'SUCCESS' }, 'signer_sendTransaction', {
			keyArray: 'lab_mining_pool_payout', chainId: 224422, to: VDR, data: withdrawData(), value: '0', gasLimit: '500000',
		})
		assert.equal(forged.status, 400)
		assert.match(String((forged.body as unknown as { error?: unknown }).error ?? ''), /identity headers are not accepted/)
		const addr = await postRaw(f.labSock, { 'x-ws-client-cn': 'vdr-payout' }, 'signer_getAddress', {})
		assert.equal(addr.status, 400)
		assert.equal(addr.body.result, undefined)
		assert.equal(f.signCalls.n, 0, 'forged headers must not reach the signer')
	} finally {
		await teardown(f)
	}
})

test('lab socket: signer_getAddress still reads while the signer is locked; signing does not', async () => {
	const f = await setup()
	try {
		f.svc.lock('test')
		const a = await post(f.labSock, 'signer_getAddress', {})
		assert.equal(a.result, f.labAddr, 'locked read of the bound address')
		const s = await sendWithdraw(f, f.labSock, withdrawData())
		assert.ok(s.error, 'locked signer must refuse to sign')
		assert.equal(s.result, undefined)
		assert.equal(f.signCalls.n, 0)
	} finally {
		await teardown(f)
	}
})

test('admin.sock mode: default 0660, dedicated service 0600, other modes refused', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'lab-admin-mode-'))
	try {
		const base = {
			dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'),
			chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
		}
		const path = (n: string) => join(dir, n)
		writeFileSync(path('p.json'), JSON.stringify({ version: 1, clients: {} }))
		writeFileSync(path('c-default.json'), JSON.stringify(base))
		assert.equal(loadConfig(path('c-default.json')).adminSocketMode, 0o660)
		writeFileSync(path('c-600.json'), JSON.stringify({ ...base, adminSocket: path('b.sock'), adminSocketMode: 0o600 }))
		assert.equal(loadConfig(path('c-600.json')).adminSocketMode, 0o600)
		writeFileSync(path('c-666.json'), JSON.stringify({ ...base, adminSocketMode: 0o666 }))
		assert.throws(() => loadConfig(path('c-666.json')), /adminSocketMode must be/)
		const svc = new SignerService(loadConfig(path('c-600.json')))
		const srv = startAdminServer(svc, path('b.sock'), 0o600)
		await new Promise<void>((resolve) => srv.on('listening', () => resolve()))
		try {
			const mode = statSync(path('b.sock')).mode & 0o777
			assert.equal(mode, 0o600, 'admin.sock must not be group or world accessible')
		} finally {
			await new Promise<void>((resolve) => srv.close(() => resolve()))
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('shipped Lab config keeps admin.sock owner-only and its runtime dir 0700', () => {
	const root = join(__dirname, '..', '..', 'deploy', 'lab-mining-pool')
	const cfg = loadConfig(join(root, 'config.lab-service.example.json'))
	assert.equal(cfg.adminSocketMode, 0o600, 'shipped Lab config must set admin.sock 0600')
	assert.equal(cfg.adminSocket, '/run/wallet-signer-lab/admin.sock')
	const tmp = readFileSync(join(root, 'tmpfiles.lab-signer.conf'), 'utf8')
	// PM-service scheme: walletsigner owns the setgid 2750 directory, group wslab. The separate-service
	// user (walletsigner-lab) and the /run/wallet-signer-lab 0700 line are no longer part of this file.
	assert.match(tmp, /^d \/run\/wallet-signer-lab-mining-pool 2750 walletsigner wslab -$/m)
	assert.doesNotMatch(tmp, /walletsigner-lab/)
})

test('main.ts wires the configured admin mode through startAdminFromConfig (MF)', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'lab-admin-wire-'))
	try {
		writeFileSync(join(dir, 'p.json'), JSON.stringify({ version: 1, clients: {} }))
		const svc = new SignerService(loadConfig(writeCfg(dir, 384)))
		const srv = startAdminFromConfig(svc, { adminSocket: join(dir, 'w.sock'), adminSocketMode: 0o600 })
		await new Promise<void>((resolve) => srv.on('listening', () => resolve()))
		try {
			assert.equal(statSync(join(dir, 'w.sock')).mode & 0o777, 0o600)
		} finally {
			await new Promise<void>((resolve) => srv.close(() => resolve()))
		}
		const mainSrc = readFileSync(join(__dirname, '..', '..', 'src', 'main.ts'), 'utf8')
		assert.match(mainSrc, /startAdminFromConfig\(svc, config\)/)
		assert.doesNotMatch(mainSrc, /startAdminServer\(svc, config\.adminSocket/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

function writeCfg(dir: string, mode: number): string {
	const p = join(dir, 'cfg.json')
	writeFileSync(p, JSON.stringify({
		dataDir: dir, logDir: dir, adminSocket: join(dir, 'x.sock'), adminSocketMode: mode, policyFile: join(dir, 'p.json'),
		chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
	}))
	return p
}

test('lab payment path: a market price above the 0.03 Gwei policy cap is refused before signing', async () => {
	mockGasPrice = '0x2faf080' // 0.05 Gwei
	const f = await setup()
	try {
		const res = await sendWithdraw(f, f.labSock, withdrawData())
		assert.equal(res.error?.code, -32006, JSON.stringify(res))
		assert.match(res.error?.message ?? '', /above cap 30000000/)
		assert.equal(res.result, undefined)
		assert.equal(f.signCalls.n, 0, 'refused before signing')
	} finally {
		mockGasPrice = '0x989680'
		await teardown(f)
	}
})
