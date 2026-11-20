/**
 * Isolation only. Local unix sockets and a loopback mock RPC.
 * Does not contact any remote host, does not broadcast, does not call pm.grantAdmin,
 * and does not repeat the B host member / non-member cases.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config'
import { HdRoot, mnemonicToEntropyBytes, newMnemonic } from '../src/hd'
import { Keyring } from '../src/keyring'
import { addArray, emptyRegistry, saveRegistry, signRegistry } from '../src/registry'
import { startAdminFromConfig } from '../src/adminServer'
import { startRpcServers } from '../src/rpcServer'
import { SignerService } from '../src/service'
import { createVaultJson } from '../src/vault'
import { preflight } from '../src/preflight'

const VDR = '0xc71e246DD78B37C2fABc905D340932F28F503433'
const DENIED = '0x0000000000000000000000000000000000000001'
const HASH = '0x' + '22'.repeat(32)
const ZERO = '0x' + '00'.repeat(20)

function answer(method: string): unknown {
	switch (method) {
		case 'eth_chainId': return '0x36d06'
		case 'eth_blockNumber': return '0x10'
		case 'eth_gasPrice': return '0x989680'
		case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
		case 'eth_getBalance': return '0x3635c9adc5dea00000'
		case 'eth_getTransactionCount': return '0x0'
		case 'eth_call': return '0x'
		case 'eth_estimateGas': return '0x7a120'
		case 'eth_getBlockByNumber':
			return {
				hash: HASH, parentHash: HASH, number: '0x10', timestamp: '0x65', nonce: '0x0000000000000000',
				difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: ZERO, extraData: '0x',
				baseFeePerGas: '0x1', transactions: [],
			}
		case 'eth_sendRawTransaction':
			throw new Error('isolation mock must not be asked to broadcast')
		default:
			return null
	}
}

function listenMock(sent: { n: number }): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string }
			if (msg.method === 'eth_sendRawTransaction') sent.n++
			const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg.method) })
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

function post(socketPath: string, method: string, params: unknown = {}): Promise<{ result?: any; error?: { message: string } }> {
	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			socketPath, path: '/', method: 'POST',
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

function admin(socketPath: string, cmd: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath)
		let buf = ''
		sock.setEncoding('utf8')
		sock.on('connect', () => sock.write(`${JSON.stringify({ cmd, args })}\n`))
		sock.on('data', (d: string) => {
			buf += d
			const nl = buf.indexOf('\n')
			if (nl >= 0) {
				sock.end()
				resolve(JSON.parse(buf.slice(0, nl)))
			}
		})
		sock.on('error', reject)
	})
}

test('four local sockets stay up and the three old entries reconnect with the old deny-list names', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'oneshot-keep-'))
	const sent = { n: 0 }
	const mock = await listenMock(sent)
	const adminSock = join(dir, 'admin.sock')
	const oracleSock = join(dir, 'oracle.sock')
	const vdrSock = join(dir, 'vdr.sock')
	const labSock = join(dir, 'lab-payout.sock')
	const phrase = newMnemonic()
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(phrase))
	const keyring = new Keyring()
	keyring.load(hd, null)
	let body = addArray(emptyRegistry(keyring.pmAddress, keyring.attestorAddress), hd, 'lab_mining_pool_payout', 1, [224422])
	body = addArray(body, hd, 'beamio_vdr_payout', 1, [224422])
	saveRegistry(join(dir, 'registry.json'), signRegistry(keyring, body))
	const labAddr = body.arrays.find((a) => a.name === 'lab_mining_pool_payout')?.addresses[0]
	if (!labAddr) throw new Error('lab address missing')
	keyring.wipe()
	hd.wipe()
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(mnemonicToEntropyBytes(phrase), 'isolation-password-not-a-secret', 2 ** 12), { mode: 0o600 })
	writeFileSync(join(dir, 'compromised.json'), JSON.stringify({ addresses: [DENIED] }), { mode: 0o640 })
	const fragment = JSON.parse(readFileSync(join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.fragment.json'), 'utf8')) as {
		'lab-mining-pool': { arrays: { lab_mining_pool_payout: unknown } }
	}
	writeFileSync(join(dir, 'policy.json'), JSON.stringify({
		version: 1,
		clients: {
			'oracle-daemon': { arrays: {} },
			'vdr-payout': { arrays: { beamio_vdr_payout: { chains: [224422], allow: [{ to: VDR, selectors: ['settleNodeRewards(uint256[],uint256[],bytes32[])'], maxValueWei: '0', maxGas: 2000000 }] } } },
			'lab-mining-pool': { arrays: { lab_mining_pool_payout: fragment['lab-mining-pool'].arrays.lab_mining_pool_payout } },
		},
	}))
	writeFileSync(join(dir, 'config.json'), JSON.stringify({
		dataDir: dir,
		logDir: dir,
		adminSocket: adminSock,
		adminSocketMode: 0o600,
		policyFile: join(dir, 'policy.json'),
		compromisedFile: join(dir, 'compromised.json'),
		rpc: { unix: [
			{ path: oracleSock, client: 'oracle-daemon' },
			{ path: vdrSock, client: 'vdr-payout' },
			{ path: labSock, client: 'lab-mining-pool', gid: process.getgid ? process.getgid() : 0 },
		] },
		chains: { '224422': { rpcUrls: [mock.url] } },
		gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
		pmOneShot: { enabled: false },
	}))
	const gate = preflight(join(dir, 'config.json'))
	assert.equal(gate.ok, true, gate.problems.join('; '))
	assert.equal(loadConfig(join(dir, 'config.json')).deniedAddressesFile, join(dir, 'compromised.json'))
	const cfg = loadConfig(join(dir, 'config.json'))
	const svc = new SignerService(cfg)
	await svc.unlock('isolation-password-not-a-secret')
	const adminSrv = startAdminFromConfig(svc, cfg)
	const servers = startRpcServers(svc, cfg.rpc)
	await new Promise<void>((resolve) => adminSrv.on('listening', () => resolve()))
	for (const sock of [oracleSock, vdrSock, labSock]) {
		for (let i = 0; i < 50 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20))
		assert.equal(existsSync(sock), true, sock)
	}
	try {
		const firstOracle = await post(oracleSock, 'signer_status')
		const firstVdr = await post(vdrSock, 'signer_status')
		const firstLab = await post(labSock, 'signer_getAddress', { keyArray: 'lab_mining_pool_payout' })
		const firstAdmin = await admin(adminSock, 'status')
		const firstOneshot = await admin(adminSock, 'pm.oneshot.status')
		const disabledVdrGas = await admin(adminSock, 'pm.oneshot.vdr-gas-0.1', { ownerPassword: 'isolation-password-not-a-secret' })
		const abortVdrGas = await admin(adminSock, 'pm.oneshot.abort-unsent', { ownerPassword: 'isolation-password-not-a-secret' })
		const disabledLabGas = await admin(adminSock, 'pm.labInitialGas')
		const disabledGrant = await admin(adminSock, 'pm.grantAdmin', { target: '0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135' })
		const rpcCannotCallAdmin = await post(oracleSock, 'pm.labInitialGas')
		const againOracle = await post(oracleSock, 'signer_compromised')
		const againVdr = await post(vdrSock, 'signer_status')
		const againAdmin = await admin(adminSock, 'compromised.list')
		assert.deepEqual(firstOracle.result?.compromised, [DENIED])
		assert.deepEqual(firstOracle.result?.denied, [DENIED])
		assert.deepEqual(againOracle.result, [DENIED])
		assert.deepEqual(firstVdr.result?.arrays, ['beamio_vdr_payout'])
		assert.deepEqual(againVdr.result?.arrays, ['beamio_vdr_payout'])
		assert.equal(firstLab.result, labAddr)
		assert.equal(firstAdmin.ok, true)
		assert.equal(firstAdmin.result?.state, 'unlocked')
		assert.equal(againAdmin.ok, true)
		assert.deepEqual(againAdmin.result, [DENIED])
		assert.equal(firstOneshot.ok, true)
		assert.equal(firstOneshot.result?.enabled, false)
		assert.equal(disabledVdrGas.ok, false)
		assert.match(disabledVdrGas.error ?? '', /disabled/)
		assert.equal(abortVdrGas.ok, true)
		assert.deepEqual(abortVdrGas.result, { aborted: false, reason: 'no-state' })
		assert.deepEqual(disabledLabGas.result, { status: 'disabled' })
		assert.equal(disabledGrant.ok, false)
		assert.match(disabledGrant.error ?? '', /disabled/)
		assert.ok(rpcCannotCallAdmin.error)
		assert.equal(sent.n, 0)
	} finally {
		svc.lock('isolation')
		await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
		await new Promise<void>((resolve) => adminSrv.close(() => resolve()))
		await mock.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
