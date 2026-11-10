/**
 * Local Anvil acceptance for registrationAdmin.
 * Synthetic vault only. Chain is 127.0.0.1. No production RPC and no real keys.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { connect as connectSocket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, JsonRpcProvider, Wallet } from 'ethers'
import { newMnemonic, mnemonicToEntropyBytes } from '../../packages/wallet-signer/src/hd'
import { createVaultJson } from '../../packages/wallet-signer/src/vault'
import { WalletSignerClient, WalletSignerError } from './remoteSigner'
import { encodeAddPublicPgp, submitRegistrationCall } from './registrationRelay'

const CLIENT = 'conet-beamio-api'
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const SOLC = process.env.SOLC ?? 'solc'
const MAIN = join(process.cwd(), 'packages/wallet-signer/dist/src/main.js')
const EXAMPLE = join(process.cwd(), 'packages/wallet-signer/deploy/policy.example.json')
const STUB = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract RegistrationStub {
    event Registered(address who);
    function addPublicPGPByAdmin(address who, string calldata, string calldata, string calldata, string calldata) external {
        emit Registered(who);
    }
    function steal() external {}
}
`

test('registrationAdmin allows one registration call and rejects unauthorized calls', { timeout: 90_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'reg-admin-'))
	const password = `local-test-${'p'.repeat(8)}`
	let anvil: ChildProcess | undefined
	let signer: ChildProcess | undefined
	let client: WalletSignerClient | undefined
	const rpcPort = 18547
	const tlsPort = 18447
	try {
		execFileSync('anvil', ['--version'], { stdio: 'ignore' })
		execFileSync('cast', ['--version'], { stdio: 'ignore' })
		assert.equal(await portOpen(rpcPort), false, '127.0.0.1:18547 is already in use')
		assert.equal(await portOpen(tlsPort), false, '127.0.0.1:18447 is already in use')
		const bytecode = compileStub(dir)
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
		const stub = castCreate(rpc, bytecode)
		writeCerts(dir)
		const phrase = newMnemonic()
		const entropy = mnemonicToEntropyBytes(phrase)
		writeFileSync(join(dir, 'vault.json'), await createVaultJson(entropy, password, 2 ** 12), { mode: 0o600 })
		entropy.fill(0)
		writePolicy(dir, stub)
		writeFileSync(join(dir, 'compromised.json'), '{"addresses":[]}\n')
		writeConfig(dir, tlsPort, rpcPort)
		signer = spawn(process.execPath, [MAIN, '--config', join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] })
		const signerLog = collect(signer)
		await waitStarted(signer, signerLog)
		await admin(join(dir, 'admin.sock'), 'unlock', { password })
		await admin(join(dir, 'admin.sock'), 'array.add', { name: 'registrationAdmin', count: 1, chains: [224422] })
		process.env.WALLET_SIGNER_URL = `https://127.0.0.1:${tlsPort}`
		process.env.WALLET_SIGNER_CERT = join(dir, 'client.crt')
		process.env.WALLET_SIGNER_KEY = join(dir, 'client.key')
		process.env.WALLET_SIGNER_CA = join(dir, 'ca.crt')
		process.env.WALLET_SIGNER_SERVERNAME = 'localhost'
		process.env.WALLET_SIGNER_FEATURES = 'registration'
		process.env.WALLET_SIGNER_PGP_ADDRESS = stub
		client = WalletSignerClient.fromEnv()
		const [from] = await client.accounts('registrationAdmin', 224422)
		assert.ok(from)
		const before = await provider.getTransactionCount(from)
		execFileSync('cast', ['send', '--private-key', ANVIL_KEY, '--rpc-url', rpc, '--value', '1ether', from], { stdio: 'ignore' })
		const who = Wallet.createRandom().address
		const data = encodeAddPublicPgp({
			wallet: who,
			keyID: 'kid',
			publicKeyArmored: 'pub',
			encrypKeyArmored: 'enc',
			routeKeyID: 'route',
		})
		const allowed = await submitRegistrationCall({ to: stub, data, gasLimit: 200_000n, idempotencyKey: 'allow-pgp' })
		const receipt = await provider.waitForTransaction(allowed.txHash)
		assert.equal(receipt?.status, 1)
		assert.equal(await provider.getTransactionCount(from), before + 1)
		const registered = new Interface(['event Registered(address who)'])
		const hit = receipt!.logs.map((log) => {
			try { return registered.parseLog(log) } catch { return null }
		}).find((parsed) => parsed?.name === 'Registered')
		assert.equal(hit?.args.who, who)

		const afterAllow = await provider.getTransactionCount(from)
		await expectDeny(client, stub, { data: new Interface(['function steal()']).encodeFunctionData('steal'), idempotencyKey: 'deny-steal' })
		await expectDeny(client, stub, {
			data: new Interface(['function createAccountFor(address)']).encodeFunctionData('createAccountFor', [who]),
			idempotencyKey: 'deny-settle',
		})
		await expectDeny(client, stub, { data, value: '1', idempotencyKey: 'deny-value' })
		assert.equal(await provider.getTransactionCount(from), afterAllow)
		console.log(`PASS registration stub=${stub} from=${from} tx=${allowed.txHash} nonce ${before}->${afterAllow} denied=3`)
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
		rmSync(dir, { recursive: true, force: true })
	}
})

function compileStub(dir: string): string {
	const source = join(dir, 'RegistrationStub.sol')
	writeFileSync(source, STUB)
	const out = execFileSync(SOLC, ['--bin', '--optimize', source], { encoding: 'utf8' })
	const bin = out.split('\n').map((line) => line.trim()).find((line) => /^[0-9a-fA-F]+$/.test(line) && line.length > 64)
	if (!bin) throw new Error(`solc produced no bytecode\n${out}`)
	return `0x${bin}`
}

function writePolicy(dir: string, stub: string): void {
	const file = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as {
		clients: Record<string, { arrays: Record<string, { allow: { to: string }[] }> }>
	}
	const allow = file.clients[CLIENT]!.arrays.registrationAdmin!.allow
	allow[0]!.to = stub
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
		allowUnsafeTestInit: false,
		gasKeeper: { enabled: false, intervalMs: 60_000, chains: {} },
		alerts: {},
		rpc: { tls: { host: '127.0.0.1', port, cert: join(dir, 'server.crt'), key: join(dir, 'server.key'), ca: join(dir, 'ca.crt') } },
		chains: { '224422': { rpcUrls: [`http://127.0.0.1:${rpcPort}`], resendAfterMs: 60_000, maxResends: 1, receiptPollMs: 200 } },
	}))
}

function castCreate(rpc: string, bytecode: string): string {
	const out = execFileSync('cast', [
		'send', '--private-key', ANVIL_KEY, '--rpc-url', rpc, '--json', '--create', bytecode,
	], { encoding: 'utf8' })
	const parsed = JSON.parse(out) as { contractAddress?: string }
	if (!parsed.contractAddress) throw new Error('cast create returned no address')
	return parsed.contractAddress
}

async function expectDeny(client: WalletSignerClient, to: string, patch: Record<string, unknown>): Promise<void> {
	await assert.rejects(
		() => client.call('signer_sendTransaction', {
			keyArray: 'registrationAdmin',
			chainId: 224422,
			to,
			data: '0x',
			value: '0',
			gasLimit: '200000',
			...patch,
		}),
		(err: unknown) => err instanceof WalletSignerError && err.signerCode === -32003,
	)
}

function portOpen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connectSocket(port, '127.0.0.1')
		sock.once('connect', () => { sock.end(); resolve(true) })
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
			if (await provider.send('eth_chainId', []) === '0x36ca6') return
		} catch (err) {
			last = err instanceof Error ? err.message : String(err)
		}
		if (Date.now() > deadline) throw new Error(`anvil not ready: ${last}\n${log.text}`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

function waitStarted(child: ChildProcess, log: { text: string }): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`signer did not start\n${log.text}`)), 8_000)
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
			reject(new Error(`signer exited ${code}\n${log.text}`))
		})
	})
}

function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode != null) return Promise.resolve()
	return new Promise((resolve) => child.once('exit', () => resolve()))
}

function admin(socketPath: string, cmd: string, args: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const sock = connectSocket(socketPath)
		let buf = ''
		const timer = setTimeout(() => { sock.destroy(); reject(new Error(`admin timeout ${cmd}`)) }, 8_000)
		sock.on('data', (chunk) => {
			buf += chunk.toString()
			if (!buf.includes('\n')) return
			clearTimeout(timer)
			sock.end()
			const parsed = JSON.parse(buf) as { ok?: boolean; error?: string }
			if (parsed.ok === false) reject(new Error(parsed.error || `${cmd} failed`))
			else resolve()
		})
		sock.on('error', (err) => { clearTimeout(timer); reject(err) })
		sock.write(`${JSON.stringify({ cmd, args })}\n`)
	})
}

function writeCerts(dir: string): void {
	const ext = join(dir, 'san.cnf')
	writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
	execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'ca.key')])
	execFileSync('openssl', ['req', '-x509', '-new', '-sha256', '-key', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'), '-days', '1', '-subj', '/CN=wallet-signer-test-ca'])
	execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'server.key')])
	execFileSync('openssl', ['req', '-new', '-key', join(dir, 'server.key'), '-out', join(dir, 'server.csr'), '-subj', '/CN=localhost'])
	execFileSync('openssl', ['x509', '-req', '-sha256', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'server.crt'), '-days', '1', '-extfile', ext])
	execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'client.key')])
	execFileSync('openssl', ['req', '-new', '-key', join(dir, 'client.key'), '-out', join(dir, 'client.csr'), '-subj', `/CN=${CLIENT}`])
	execFileSync('openssl', ['x509', '-req', '-sha256', '-in', join(dir, 'client.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'client.crt'), '-days', '1'])
}
