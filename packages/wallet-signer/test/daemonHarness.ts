/**
 * Runs the real daemon modules (x402sdk chatIndexPointer / gbDepinAirdrop, CoNET-DL epochWriter)
 * against wallet-signer on a local fork. x402sdk `util` is stubbed so nothing reads master.json
 * or starts the API server.
 *
 * env: X402_BUILD, DL_BUILD (compiled outDirs), CONET_RPC_URL, WALLET_SIGNER_* (client side)
 * usage: node daemonHarness.js <chat|airdrop-roles|airdrop-page|epoch-reconcile|epoch-update> [json]
 */
import Module from 'node:module'
import { join } from 'node:path'
import { Contract, JsonRpcProvider, Wallet, hexlify, randomBytes } from 'ethers'

const RPC = process.env.CONET_RPC_URL!

function stubX402Util(): void {
	const path = require.resolve(join(process.env.X402_BUILD!, 'util.js'))
	const m = new Module(path) as Module & { loaded: boolean }
	m.filename = path
	m.loaded = true
	m.exports = {
		masterSetup: {},
		resolveBeamioConetHttpRpcUrl: () => RPC,
		resolveBeamioBaseHttpRpcUrl: () => 'http://127.0.0.1:9',
	}
	;(require.cache as Record<string, Module>)[path] = m
}

type FakeRes = { code?: number; body?: unknown; headersSent: boolean; status(c: number): FakeRes; json(b: unknown): FakeRes; end(): FakeRes }
function fakeRes(): { res: FakeRes; done: Promise<FakeRes> } {
	let resolve!: (r: FakeRes) => void
	const done = new Promise<FakeRes>((r) => (resolve = r))
	const res: FakeRes = {
		headersSent: false,
		status(c) {
			this.code = c
			return this
		},
		json(b) {
			this.body = b
			this.headersSent = true
			resolve(this)
			return this
		},
		end() {
			return this
		},
	}
	return { res, done }
}

async function chat(): Promise<unknown> {
	stubX402Util()
	const mod = require(join(process.env.X402_BUILD!, 'chatIndexPointer.js'))
	const { CONET_CHAT_INDEX_REGISTRY } = require(join(process.env.X402_BUILD!, 'chainAddresses.js'))
	const provider = new JsonRpcProvider(RPC, 224422, { staticNetwork: true })
	const reg = new Contract(
		CONET_CHAT_INDEX_REGISTRY,
		['function nonceOf(address) view returns (uint256)', 'function getPointer(address) view returns (bytes32 indexHash, uint64 ts, uint64 seq, uint64 updatedAt)'],
		provider,
	)
	const user = Wallet.createRandom()
	const nonce = (await reg.nonceOf!(user.address)) as bigint
	const indexHash = hexlify(randomBytes(32))
	const ts = BigInt(Math.floor(Date.now() / 1000))
	const sig = await user.signTypedData(
		{ name: 'ChatIndexRegistry', version: '1', chainId: 224422, verifyingContract: CONET_CHAT_INDEX_REGISTRY },
		{ SetPointer: [{ name: 'owner', type: 'address' }, { name: 'indexHash', type: 'bytes32' }, { name: 'ts', type: 'uint64' }, { name: 'seq', type: 'uint64' }, { name: 'nonce', type: 'uint256' }] },
		{ owner: user.address, indexHash, ts, seq: 1n, nonce },
	)
	const { res, done } = fakeRes()
	mod.enqueueChatIndexPointerRelay({ owner: user.address, indexHash, ts: ts.toString(), seq: '1', nonce: nonce.toString(), signature: sig, res })
	const out = await done
	const ptr = out.code === 200 ? await reg.getPointer!(user.address) : null
	return { http: out.code, body: out.body, pointerMatches: ptr ? ptr[0] === indexHash : false }
}

async function airdropRoles(): Promise<unknown> {
	stubX402Util()
	const mod = require(join(process.env.X402_BUILD!, 'gbDepinAirdrop.js'))
	return mod.reconcileGbDepinAirdropRoles()
}

async function airdropPage(): Promise<unknown> {
	stubX402Util()
	const mod = require(join(process.env.X402_BUILD!, 'gbDepinAirdrop.js'))
	const { res, done } = fakeRes()
	mod.gbDepinAirdropAllPool.push({ res, pageStart: 0, pageSize: 3, advanceGlobalClock: false })
	mod.kickGbDepinAirdropAllPoolPress()
	const out = await done
	return { http: out.code, body: out.body }
}

function epochWriter() {
	const { createEpochWriter } = require(join(process.env.DL_BUILD!, 'endpoint', 'epochWriter.js'))
	const logs: string[] = []
	const w = createEpochWriter({ provider: new JsonRpcProvider(RPC, 224422, { staticNetwork: true }), log: (m: string) => logs.push(m) })
	return { w, logs }
}

async function epochReconcile(): Promise<unknown> {
	const { w, logs } = epochWriter()
	const report = await w.reconcile()
	return { mode: w.mode, report, logs }
}

async function epochUpdate(): Promise<unknown> {
	const { w, logs } = epochWriter()
	const epoch = Number(process.argv[3] ?? Date.now())
	const hash = await w.update({ epoch, totalMiners: 123, minerRate: 0.5, totalUsrs: 456 })
	const c = new Contract('0x648f1a17269627C3d465fEa40b3C229f7CacE5cA', ['function currentInfo() view returns (uint256,uint256,uint256,uint256)'], new JsonRpcProvider(RPC, 224422, { staticNetwork: true }))
	const info = (await c.currentInfo!()) as bigint[]
	return { hash, currentInfo: info.map(String), logs }
}

const cmds: Record<string, () => Promise<unknown>> = {
	chat,
	'airdrop-roles': airdropRoles,
	'airdrop-page': airdropPage,
	'epoch-reconcile': epochReconcile,
	'epoch-update': epochUpdate,
}

const fn = cmds[process.argv[2] ?? '']
if (!fn) {
	console.error('unknown command')
	process.exit(2)
}
fn()
	.then((r) => {
		process.stdout.write(`${JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`)
		process.exit(0)
	})
	.catch((e: unknown) => {
		process.stdout.write(`${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n`)
		process.exit(1)
	})
