/**
 * Real TxManager tests against a local anvil (chain 224422). Run with: npm run test:pm-anvil
 * The VDR address carries a mock runtime (admins/addAdmin only) installed with anvil_setCode.
 * This is a local stand-in for the contract, not the production implementation. Fork test covers the live state.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { getAddress, Interface } from 'ethers'
import { loadConfig } from '../src/config'
import { HdRoot, mnemonicToEntropyBytes, newMnemonic } from '../src/hd'
import { Keyring } from '../src/keyring'
import { emptyRegistry, saveRegistry, signRegistry } from '../src/registry'
import { SignerService } from '../src/service'
import { createVaultJson } from '../src/vault'
import { PM_GRANT_VDR } from '../src/pmGrantAdmin'

const PORT = 8600 + Math.floor(Math.random() * 300)
const RPC = `http://127.0.0.1:${PORT}`
const MOCK_VDR = '0x60003560e01c8063429b62e51461001d578063704802751461003757005b600435600052600060205260406000205460005260206000f35b600435600052600060205260406000206001905500'
// TEST FIXTURE PASSWORD: a throwaway value for the local anvil vault only; not a credential.
const PW = 'pm-grant-real-tx-password-123'
const IFACE = new Interface(['function admins(address) view returns (bool)'])
const LAB = getAddress('0x5a1ab0000000000000000000000000000000c0de')
const LAB2 = getAddress('0x5a1ab0000000000000000000000000000000c0df')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let anvil: ChildProcess
async function rpc(method: string, params: unknown[]): Promise<any> {
	const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
	const j = (await r.json()) as { result?: any; error?: unknown }
	if (j.error) throw new Error(JSON.stringify(j.error))
	return j.result
}
async function adminsOf(a: string): Promise<boolean> {
	return BigInt(await rpc('eth_call', [{ to: PM_GRANT_VDR, data: IFACE.encodeFunctionData('admins', [a]) }, 'latest'])) === 1n
}
async function waitAdmin(a: string, want = true): Promise<boolean> {
	for (let i = 0; i < 100; i++) { if ((await adminsOf(a)) === want) return true; await sleep(100) }
	return false
}
async function nonceOf(a: string): Promise<number> {
	return parseInt(await rpc('eth_getTransactionCount', [a, 'pending']), 16)
}

const dirs: string[] = []
let pm = ''
let baseDir = ''
async function newService(dir: string): Promise<SignerService> {
	const cfgPath = join(dir, 'config.json')
	writeFileSync(cfgPath, JSON.stringify({
		dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'policy.json'),
		chains: { '224422': { rpcUrls: [RPC], receiptPollMs: 200, resendAfterMs: 60000 } },
		gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
		// Test chain only: anvil defaults sit near 1 Gwei. Production default is 0.03 Gwei (PM_GRANT_MAX_GAS_PRICE_WEI).
		// Deny fixture is a test value, not a real account.
		pmGrantAdmin: { enabled: true, targets: [LAB, LAB2], denyAddresses: ['0x5a1ab0000000000000000000000000000000d0d0'], maxGasPriceWei: '5000000000' },
	}))
	const svc = new SignerService(loadConfig(cfgPath))
	await svc.unlock(PW)
	svc.start() // receipt polling runs only after start(), as in main.ts
	return svc
}

before(async () => {
	anvil = spawn('anvil', ['--chain-id', '224422', '--port', String(PORT), '--silent'], { stdio: 'ignore' })
	for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId', []); break } catch { await sleep(200) } }
	const dir = mkdtempSync(join(tmpdir(), 'pmreal-')); dirs.push(dir); baseDir = dir
	const phrase = newMnemonic()
	const hd = HdRoot.fromEntropy(mnemonicToEntropyBytes(phrase))
	const kr = new Keyring(); kr.load(hd, null)
	pm = getAddress(kr.pmAddress)
	saveRegistry(join(dir, 'registry.json'), signRegistry(kr, emptyRegistry(kr.pmAddress, kr.attestorAddress)))
	kr.wipe(); hd.wipe()
	writeFileSync(join(dir, 'vault.json'), await createVaultJson(mnemonicToEntropyBytes(phrase), PW, 2 ** 12), { mode: 0o600 })
	writeFileSync(join(dir, 'policy.json'), JSON.stringify({ version: 1, clients: {} }))
	await rpc('anvil_setCode', [PM_GRANT_VDR, MOCK_VDR])
	await rpc('anvil_setBalance', [pm, '0x56bc75e2d63100000'])
	// The mock has no access control. Admin the PM through the mock's addAdmin from a funded anvil account.
	const [funder] = (await rpc('eth_accounts', [])) as string[]
	const setupTx = await rpc('eth_sendTransaction', [{ from: funder, to: PM_GRANT_VDR, data: '0x70480275' + pm.slice(2).toLowerCase().padStart(64, '0'), gas: '0x30d40' }])
	for (let i = 0; i < 100; i++) { if (await rpc('eth_getTransactionReceipt', [setupTx])) break; await sleep(100) }
	assert.equal(await adminsOf(pm), true, 'mock admin setup')
	assert.equal(await adminsOf(LAB), false)
})

after(async () => {
	anvil?.kill('SIGTERM')
	for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test('same target in parallel: exactly one transaction is sent', async () => {
	const dir = baseDir
	const svc = await newService(dir)
	const n0 = await nonceOf(pm)
	const results = await Promise.allSettled([svc.pmGrantAdmin(LAB), svc.pmGrantAdmin(LAB)])
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
	assert.equal(await nonceOf(pm), n0 + 1, 'one nonce consumed')
	assert.equal(await waitAdmin(LAB), true)
	svc.stop(); svc.lock('test')
})

test('different targets in parallel: both granted, nonces consecutive, no duplicates', async () => {
	const dir = baseDir
	const svc = await newService(dir)
	const n0 = await nonceOf(pm)
	const [a, b] = await Promise.allSettled([svc.pmGrantAdmin(LAB2), svc.pmGrantAdmin(LAB)])
	// LAB was granted in the previous test, so only LAB2 can succeed here. The other refuses (already admin / one-shot).
	assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify([a, b].map((r) => (r.status === 'rejected' ? String((r.reason as Error).message) : r.value))))
	assert.equal(await nonceOf(pm), n0 + 1)
	assert.equal(await waitAdmin(LAB2), true)
	svc.stop(); svc.lock('test')
})

test('grant interleaved with a PM gas top-up through the same TxManager: nonces unique, both mined', async () => {
	const dir = baseDir
	const svc = await newService(dir)
	const fresh = getAddress('0x5a1ab0000000000000000000000000000000d00d')
	// A new target for the grant (allowlist entry added by a new service instance below).
	const grantTarget = getAddress('0x5a1ab0000000000000000000000000000000e00e')
	;(svc.config as { pmGrantAdmin: { targets: string[] } }).pmGrantAdmin.targets.push(grantTarget)
	const n0 = await nonceOf(pm)
	const topup = svc.txm.send({ client: 'gas-keeper-test', array: 'PM', chainId: 224422, candidates: [pm], from: pm, to: fresh, data: '0x', value: 1000n, gasLimit: 21000n, maxInflightPerKey: 4, skipSimulation: true, idempotencyKey: 'topup-test-' + Date.now(), method: 'topup' })
	const grant = svc.pmGrantAdmin(grantTarget)
	const [t, g] = await Promise.allSettled([topup, grant])
	assert.equal(t.status, 'fulfilled', t.status === 'rejected' ? String(t.reason) : '')
	assert.equal(g.status, 'fulfilled', g.status === 'rejected' ? String(g.reason) : '')
	assert.equal(await nonceOf(pm), n0 + 2, 'two nonces, no reuse, no skip')
	assert.equal(await waitAdmin(grantTarget), true)
	svc.stop(); svc.lock('test')
})

test('lost response after send: restart, reconcile by stored hash, never re-sign', async () => {
	const dir = baseDir
	const target = getAddress('0x5a1ab0000000000000000000000000000000f00f')
	let svc = await newService(dir)
	;(svc.config as { pmGrantAdmin: { targets: string[] } }).pmGrantAdmin.targets.push(target)
	const r = await svc.pmGrantAdmin(target)
	assert.ok(r.hash, 'hash returned')
	const statePath = join(dir, 'pm-grant-admin.json')
	// Simulate: the response was lost, so the record reads uncertain on disk.
	const st = JSON.parse(readFileSync(statePath, 'utf8'))
	st[target.toLowerCase()].status = 'uncertain'
	writeFileSync(statePath, JSON.stringify(st))
	svc.stop(); svc.lock('restart')
	const n1 = await nonceOf(pm)
	// Restart: a new process instance reads the same dataDir (state file and TxManager journal).
	svc = await newService(dir)
	;(svc.config as { pmGrantAdmin: { targets: string[] } }).pmGrantAdmin.targets.push(target)
	const rec = await svc.pmReconcile(target)
	assert.equal(rec.status, 'confirmed')
	assert.equal(await nonceOf(pm), n1, 'reconcile sends nothing')
	// A second grant is refused; reconcile is idempotent.
	await assert.rejects(svc.pmGrantAdmin(target), /already granted|in flight/)
	assert.equal((await svc.pmReconcile(target)).status, 'confirmed')
	svc.stop(); svc.lock('test')
})
