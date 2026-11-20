import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface, getAddress } from 'ethers'
import { checkPmGrantTarget, runPmGrantAdmin, reconcilePmGrant, PM_GRANT_VDR, type PmGrantDeps, type PmGrantReader } from '../src/pmGrantAdmin'
import { startRpcServers } from '../src/rpcServer'
import { SignerService } from '../src/service'
import { loadConfig } from '../src/config'


// Output must live outside every input tree: use a sibling directory.
const outside = (dir: string, name: string) => join(dir + '-out', name)
// Test fixture only (not a real account): stands in for the PM address.
const PM = getAddress('0x5a1ab0000000000000000000000000000000a0a0')
const LAB = getAddress('0x5a1ab0000000000000000000000000000000c0de')
const LAB2 = getAddress('0x5a1ab0000000000000000000000000000000c0df')
// Test fixture only (not a real account): stands in for the private deny list.
const DENY = getAddress('0x5a1ab0000000000000000000000000000000d0d0')
// Private derive config for tests: fixture values, written once outside the repository.
const PRIV_DIR = mkdtempSync(join(tmpdir(), 'pmpriv-'))
const PRIV = join(PRIV_DIR, 'private-derive.json')
writeFileSync(PRIV, JSON.stringify({ labTarget: LAB, denyAddresses: [DENY] }))
const OTHER = getAddress('0x5a1ab0000000000000000000000000000000beef')
const IFACE = new Interface(['function admins(address) view returns (bool)', 'function addAdmin(address)'])
const TRUE = '0x' + '0'.repeat(63) + '1'
const FALSE = '0x' + '0'.repeat(64)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Opt = { readFailTimes?: number; pmAdmin?: boolean; adminOf?: Record<string, boolean>; estimate?: bigint; balance?: bigint; simRevert?: boolean; sendThrows?: boolean; receiptStatus?: string | null; delayMs?: number; fromOverride?: string }

function harness(opt: Opt = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'pmgrant-'))
	const statePath = join(dir, 'pm-grant-admin.json')
	const audit: Record<string, unknown>[] = []
	const journal = new Map<string, string>()
	const calls = { send: 0, concurrent: 0, maxConcurrent: 0, reads: 0 }
	let readFails = opt.readFailTimes ?? 0
	const reader: PmGrantReader = {
		async call(to, data, from) {
			calls.reads++
			if (opt.delayMs) await sleep(opt.delayMs)
			if (readFails > 0) { readFails--; throw new Error('rpc timeout on read') }
			const d = IFACE.parseTransaction({ data })!
			if (d.name === 'admins') {
				const who = getAddress('0x' + data.slice(34))
				if (who === PM) return opt.pmAdmin === false ? FALSE : TRUE
				return opt.adminOf?.[who.toLowerCase()] ? TRUE : FALSE
			}
			if (from !== PM) throw new Error('simulation must come from PM')
			if (opt.simRevert) throw new Error('execution reverted')
			return '0x'
		},
		async getBalance() { return opt.balance ?? 10n ** 18n },
		async feeData() { return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n } },
		async estimateGas() { return opt.estimate ?? 80_000n },
		async receipt(hash) { return opt.receiptStatus === undefined ? null : opt.receiptStatus === null ? null : { status: opt.receiptStatus } },
	}
	const send: PmGrantDeps['send'] = async (req) => {
		calls.send++
		calls.concurrent++
		calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent)
		try {
			await sleep(opt.delayMs ?? 5)
			if (opt.sendThrows) throw new Error('rpc timeout after send')
			const hash = '0x' + String(calls.send).padStart(2, '0').repeat(32)
			journal.set(req.idempotencyKey, hash)
			return { hash, from: opt.fromOverride ?? PM, status: 'sent' }
		} finally {
			calls.concurrent--
		}
	}
	const deps: PmGrantDeps = {
		cfg: { enabled: true, targets: [LAB, LAB2], denyAddresses: [DENY] },
		statePath,
		pmAddress: PM,
		reader,
		send,
		journalHash: (k) => journal.get(k) ?? null,
		audit: (e) => { audit.push(e); return 0 as never },
	}
	return { dir, statePath, audit, calls, journal, deps, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const st = (h: ReturnType<typeof harness>) => JSON.parse(readFileSync(h.statePath, 'utf8')) as Record<string, { status: string; hash?: string }>

test('target rules: disabled, not allowlisted, zero, deny list, VDR, PM, bad format', () => {
	assert.throws(() => checkPmGrantTarget(LAB, PM, { enabled: false, targets: [LAB] }), /disabled/)
	assert.throws(() => checkPmGrantTarget(OTHER, PM, { enabled: true, targets: [LAB], denyAddresses: [DENY] }), /allowlist/)
	assert.throws(() => checkPmGrantTarget('0x0000000000000000000000000000000000000000', PM, { enabled: true, targets: ['0x0000000000000000000000000000000000000000'], denyAddresses: [DENY] }), /zero/)
	assert.throws(() => checkPmGrantTarget(DENY, PM, { enabled: true, targets: [DENY], denyAddresses: [DENY] }), /deny list/)
	assert.throws(() => checkPmGrantTarget(LAB, PM, { enabled: true, targets: [LAB], denyAddresses: [] }), /fail closed/)
	assert.throws(() => checkPmGrantTarget(PM_GRANT_VDR, PM, { enabled: true, targets: [PM_GRANT_VDR], denyAddresses: [DENY] }), /contract itself/)
	assert.throws(() => checkPmGrantTarget(PM, PM, { enabled: true, targets: [PM], denyAddresses: [DENY] }), /PM address/)
	assert.throws(() => checkPmGrantTarget('not-an-address', PM, { enabled: true, targets: [LAB], denyAddresses: [DENY] }), /must be an address/)
	assert.equal(checkPmGrantTarget(LAB.toLowerCase(), PM, { enabled: true, targets: [LAB], denyAddresses: [DENY] }), LAB)
})

test('success: one send through TxManager path with addAdmin(target), value 0, PM as candidate; audit has pre-reads', async () => {
	const h = harness()
	try {
		const r = await runPmGrantAdmin(h.deps, LAB)
		assert.equal(r.status, 'sent')
		assert.equal(h.calls.send, 1)
		const s = st(h)[LAB.toLowerCase()]!
		assert.equal(s.status, 'sent')
		assert.match(s.hash!, /^0x/)
		const ev = h.audit.find((e) => e.event === 'pm.grantAdmin.sent')!
		assert.equal(ev.pmAdmin, true)
		assert.equal(ev.targetAdmin, false)
	} finally { h.cleanup() }
})

test('the send request carries the fixed contract, selector calldata, value 0 and PM as the only candidate', async () => {
	let seen: Record<string, unknown> | null = null
	const h = harness()
	try {
		const orig = h.deps.send
		h.deps.send = async (req) => { seen = req as never; return orig(req) }
		await runPmGrantAdmin(h.deps, LAB)
		const r = seen as unknown as { to: string; data: string; value: bigint; candidates: string[]; client: string; array: string; maxGas: bigint }
		assert.equal(r.to, PM_GRANT_VDR)
		assert.equal(r.data.slice(0, 10), '0x70480275')
		assert.equal(r.value, 0n)
		assert.deepEqual(r.candidates, [PM])
		assert.equal(r.client, 'pm-grant-admin')
		assert.equal(r.array, 'PM')
	} finally { h.cleanup() }
})

test('one-shot: same target refused once any record exists', async () => {
	const h = harness()
	try {
		await runPmGrantAdmin(h.deps, LAB)
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /already granted or in flight/)
		assert.equal(h.calls.send, 1)
	} finally { h.cleanup() }
})

test('concurrency: same target fired twice in parallel sends exactly once', async () => {
	const h = harness({ delayMs: 20 })
	try {
		const results = await Promise.allSettled([runPmGrantAdmin(h.deps, LAB), runPmGrantAdmin(h.deps, LAB)])
		assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
		assert.equal(h.calls.send, 1)
		assert.equal(h.calls.maxConcurrent, 1)
	} finally { h.cleanup() }
})

test('concurrency: different targets in parallel never overlap in signing and each is sent once', async () => {
	const h = harness({ delayMs: 15 })
	try {
		const results = await Promise.allSettled([runPmGrantAdmin(h.deps, LAB), runPmGrantAdmin(h.deps, LAB2)])
		assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2)
		assert.equal(h.calls.send, 2)
		assert.equal(h.calls.maxConcurrent, 1, 'only one grant may be in the send step at a time')
	} finally { h.cleanup() }
})

test('reads refuse before any send: PM not admin, target already admin (state marked aborted)', async () => {
	const a = harness({ pmAdmin: false })
	try {
		await assert.rejects(runPmGrantAdmin(a.deps, LAB), /PM is not an admin/)
		assert.equal(a.calls.send, 0)
		assert.equal(st(a)[LAB.toLowerCase()]!.status, 'aborted')
	} finally { a.cleanup() }
	const b = harness({ adminOf: { [LAB.toLowerCase()]: true } })
	try {
		await assert.rejects(runPmGrantAdmin(b.deps, LAB), /already an admin/)
		assert.equal(b.calls.send, 0)
	} finally { b.cleanup() }
})

test('simulation revert, gas cap and balance refuse before any send', async () => {
	const a = harness({ simRevert: true })
	try { await assert.rejects(runPmGrantAdmin(a.deps, LAB), /execution reverted/); assert.equal(a.calls.send, 0) } finally { a.cleanup() }
	const b = harness({ estimate: 200_000n })
	try { await assert.rejects(runPmGrantAdmin(b.deps, LAB), /above cap/); assert.equal(b.calls.send, 0) } finally { b.cleanup() }
	const c = harness({ balance: 1n })
	try { await assert.rejects(runPmGrantAdmin(c.deps, LAB), /below worst-case/); assert.equal(c.calls.send, 0) } finally { c.cleanup() }
})

test('signer check: a send that reports a non-PM signer is refused and marked uncertain', async () => {
	const h = harness({ fromOverride: OTHER })
	try {
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /signer address is not PM/)
		assert.equal(st(h)[LAB.toLowerCase()]!.status, 'uncertain')
	} finally { h.cleanup() }
})

test('lost receipt: send throws, target uncertain, no second send; reconcile by key finds the hash and never re-sends', async () => {
	const h = harness({ sendThrows: true })
	try {
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /outcome unknown/)
		assert.equal(st(h)[LAB.toLowerCase()]!.status, 'uncertain')
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /already granted or in flight \(uncertain\)/)
		assert.equal(h.calls.send, 1)
		// Simulate restart: the journal has the hash, chain has the receipt success.
		const h2Deps = { ...h.deps, reader: { ...h.deps.reader, async call(to: string, data: string) { return FALSE }, async receipt() { return { status: '0x1' } } } }
		h.journal.set('pm-grant:224422:' + LAB.toLowerCase(), '0x' + 'cd'.repeat(32))
		const rr = await reconcilePmGrant(h2Deps as PmGrantDeps, LAB)
		assert.equal(rr.status, 'confirmed')
		assert.equal(h.calls.send, 1, 'reconcile never signs')
	} finally { h.cleanup() }
})

test('reconcile: receipt status 0x0 marks failed; admin already true marks confirmed; never re-sends', async () => {
	const h = harness({ sendThrows: true })
	try {
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /outcome unknown/)
		h.journal.set('pm-grant:224422:' + LAB.toLowerCase(), '0x' + 'ef'.repeat(32))
		const failDeps = { ...h.deps, reader: { ...h.deps.reader, async call() { return FALSE }, async receipt() { return { status: '0x0' } } } }
		assert.equal((await reconcilePmGrant(failDeps as PmGrantDeps, LAB)).status, 'failed')
		assert.equal(h.calls.send, 1)
	} finally { h.cleanup() }
})

test('disabled config refuses without touching state', async () => {
	const h = harness()
	try {
		await assert.rejects(runPmGrantAdmin({ ...h.deps, cfg: { enabled: false, targets: [LAB] } }, LAB), /disabled/)
		assert.equal(existsSync(h.statePath), false)
	} finally { h.cleanup() }
})

test('admin wiring: pm.reconcile is routed on the admin socket and not on the business socket', () => {
	const admin = readFileSync(join(__dirname, '..', '..', 'src', 'adminServer.ts'), 'utf8')
	assert.match(admin, /case 'pm\.reconcile':\s*\n\s*return svc\.pmReconcile\(a\.target\)/)
	const rpc = readFileSync(join(__dirname, '..', '..', 'src', 'rpcServer.ts'), 'utf8')
	assert.doesNotMatch(rpc, /pm\.reconcile|pm\.grantAdmin/)
})

test('Lab initial Gas is an admin-only no-argument operation and has no RPC caller-supplied target route', () => {
	const admin = readFileSync(join(__dirname, '..', '..', 'src', 'adminServer.ts'), 'utf8')
	assert.match(admin, /case 'pm\.labInitialGas':[\s\S]*?Object\.keys\(a\)\.length !== 0[\s\S]*?svc\.pmLabInitialGas\(\)/)
	const rpc = readFileSync(join(__dirname, '..', '..', 'src', 'rpcServer.ts'), 'utf8')
	assert.doesNotMatch(rpc, /pm\.labInitialGas|pmLabInitialGas/)
	const implementation = readFileSync(join(__dirname, '..', '..', 'src', 'pmLabInitialGas.ts'), 'utf8')
	assert.match(implementation, /PM_LAB_INITIAL_GAS_RECIPIENT = getAddress\('0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135'\)/)
	assert.match(implementation, /to: PM_LAB_INITIAL_GAS_RECIPIENT/)
	assert.doesNotMatch(implementation, /targetIn|recipientIn|PM_GRANT_CLIENT/)
})

test('retry: a read failure before broadcast aborts; retry then succeeds with exactly one send', async () => {
	const h = harness({ readFailTimes: 1 })
	try {
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /rpc timeout on read/)
		assert.equal(st(h)[LAB.toLowerCase()]!.status, 'aborted')
		assert.equal(h.calls.send, 0, 'nothing broadcast')
		const r = await runPmGrantAdmin(h.deps, LAB)
		assert.equal(r.status, 'sent')
		assert.equal(h.calls.send, 1, 'exactly one transaction across both attempts')
	} finally { h.cleanup() }
})

test('retry: PM-not-admin refusal before broadcast is retryable once the chain state changes', async () => {
	const h = harness({ pmAdmin: false })
	try {
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /PM is not an admin/)
		assert.equal(st(h)[LAB.toLowerCase()]!.status, 'aborted')
		// Chain state changes: PM becomes admin.
		const h2 = { ...h.deps, reader: { ...h.deps.reader, async call(to: string, data: string, from?: string) {
			const d = IFACE.parseTransaction({ data })!
			if (d.name === 'admins' && getAddress('0x' + data.slice(34)) === PM) return TRUE
			return (h.deps.reader.call as (a: string, b: string, c?: string) => Promise<string>)(to, data, from)
		} } }
		const r = await runPmGrantAdmin(h2 as PmGrantDeps, LAB)
		assert.equal(r.status, 'sent')
		assert.equal(h.calls.send, 1)
	} finally { h.cleanup() }
})

test('retry: an ambiguous send (uncertain) is never retried; only reconcile may resolve it', async () => {
	const h = harness({ sendThrows: true })
	try {
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /outcome unknown/)
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /already granted or in flight \(uncertain\)/)
		assert.equal(h.calls.send, 1)
	} finally { h.cleanup() }
})

import { preflight } from '../src/preflight'
import { makeListenerSink } from '../src/rpcServer'
import { statSync, mkdirSync, readdirSync } from 'node:fs'
const LAB_POLICY_FILE = join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.lab-service.json')
function candidatePolicy(extra: Record<string, unknown> = {}): string {
	const lab = JSON.parse(readFileSync(LAB_POLICY_FILE, 'utf8')) as { clients: Record<string, unknown> }
	return JSON.stringify({ version: 1, clients: { ...lab.clients, 'oracle-daemon': { arrays: {} }, 'vdr-payout': { arrays: {} }, ...extra } })
}
test('preflight: a candidate with the required listeners, Lab gid and a clean policy passes', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmpre-'))
	try {
		const base = { dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }
		writeFileSync(join(dir, 'p.json'), candidatePolicy())
		const unix = [
			{ path: join(dir, 'o.sock'), client: 'oracle-daemon' },
			{ path: join(dir, 'v.sock'), client: 'vdr-payout' },
			{ path: join(dir, 'lab.sock'), client: 'lab-mining-pool', gid: process.getgid!() },
		]
		writeFileSync(join(dir, 'ok.json'), JSON.stringify({ ...base, rpc: { unix } }))
		const ok = preflight(join(dir, 'ok.json'))
		assert.equal(ok.ok, true, JSON.stringify(ok.problems))
		assert.match(ok.policyHash!, /^0x[0-9a-f]{64}$/)
		const withoutOracle = { ...base, rpc: { unix: unix.slice(1) } }
		writeFileSync(join(dir, 'nooracle.json'), JSON.stringify(withoutOracle))
		assert.ok(preflight(join(dir, 'nooracle.json')).problems.some((p) => /oracle-daemon is missing/.test(p)))
		const noGid = { ...base, rpc: { unix: [unix[0], unix[1], { path: join(dir, 'lab.sock'), client: 'lab-mining-pool' }] } }
		writeFileSync(join(dir, 'nogid.json'), JSON.stringify(noGid))
		assert.ok(preflight(join(dir, 'nogid.json')).problems.some((p) => /dedicated gid/.test(p)))
		writeFileSync(join(dir, 'pmclient.json'), JSON.stringify({ ...base, rpc: { unix } }))
		writeFileSync(join(dir, 'p.json'), candidatePolicy({ 'some-client': { arrays: { PM: { chains: [224422], allow: [{ to: PM_GRANT_VDR, selectors: ['withdrawNative(address,uint256)'], maxValueWei: '0' }] } } } }))
		assert.ok(preflight(join(dir, 'pmclient.json')).problems.some((p) => /must not hold the PM array/.test(p)))
		writeFileSync(join(dir, 'p.json'), candidatePolicy())
		writeFileSync(join(dir, 'gk.json'), JSON.stringify({ ...base, gasKeeper: { enabled: true, intervalMs: 60000, chains: {} }, rpc: { unix } }))
		assert.ok(preflight(join(dir, 'gk.json')).problems.some((p) => /gasKeeper/.test(p)))
		writeFileSync(join(dir, 'col.json'), JSON.stringify({ ...base, rpc: { unix: [{ ...unix[2], path: join(dir, 'a.sock') }, unix[0], unix[1]] } }))
		assert.ok(preflight(join(dir, 'col.json')).problems.some((p) => /collides/.test(p)))
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listener gid: the Lab socket is re-grouped to the declared gid after listen', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmgid-'))
	try {
		writeFileSync(join(dir, 'p.json'), candidatePolicy())
		const sock = join(dir, 'lab.sock')
		const cfgPath = join(dir, 'c.json')
		writeFileSync(cfgPath, JSON.stringify({ dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), rpc: { unix: [{ path: sock, client: 'lab-mining-pool', gid: process.getgid!() }] }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }))
		const svc = new SignerService(loadConfig(cfgPath))
		const servers = startRpcServers(svc, loadConfig(cfgPath).rpc)
		try {
			for (let i = 0; i < 40 && (statSync(sock).mode & 0o777) !== 0o660; i++) await new Promise((r) => setTimeout(r, 50))
			assert.equal(statSync(sock).gid, process.getgid!())
			assert.equal(statSync(sock).mode & 0o777, 0o660)
		} finally {
			await Promise.all(servers.map((x) => new Promise<void>((r) => x.close(() => r()))))
		}
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gas price cap: the grant send carries the 0.03 Gwei cap; the Lab grant policy carries maxGasPriceGwei 0.03', () => {
	const pol = JSON.parse(readFileSync(LAB_POLICY_FILE, 'utf8')) as { clients: { 'lab-mining-pool': { arrays: { lab_mining_pool_payout: { maxGasPriceGwei: Record<string, number> } } } } }
	assert.deepEqual(pol.clients['lab-mining-pool'].arrays.lab_mining_pool_payout.maxGasPriceGwei, { '224422': 0.03 })
	const src = readFileSync(join(__dirname, '..', '..', 'src', 'pmGrantAdmin.ts'), 'utf8')
	assert.match(src, /maxGasPriceWei: capWei\(deps\.cfg\)/)
	assert.match(src, /PM_GRANT_MAX_GAS_PRICE_WEI = 30_000_000n/)
})

test('price cap refusal before broadcast is retryable (aborted), not uncertain', async () => {
	const { SignerError, ErrorCode } = await import('../src/errors')
	const h = harness()
	try {
		let first = true
		const orig = h.deps.send
		h.deps.send = async (req) => {
			if (first) { first = false; throw new SignerError(ErrorCode.GAS_PRICE_TOO_HIGH, 'gas price above cap') }
			return orig(req)
		}
		await assert.rejects(runPmGrantAdmin(h.deps, LAB), /gas price above cap/)
		assert.equal(st(h)[LAB.toLowerCase()]!.status, 'aborted')
		const r = await runPmGrantAdmin(h.deps, LAB)
		assert.equal(r.status, 'sent')
		assert.equal(h.calls.send, 1)
	} finally { h.cleanup() }
})

test('gas price cap: default 0.03 Gwei reaches the send request; a config override replaces it', async () => {
	const seen: bigint[] = []
	const h = harness()
	try {
		const orig = h.deps.send
		h.deps.send = async (req) => { seen.push(req.maxGasPriceWei); return orig(req) }
		await runPmGrantAdmin(h.deps, LAB)
		assert.equal(seen[0], 30_000_000n)
		const h2 = harness()
		try {
			const o2 = h2.deps.send
			h2.deps.send = async (req) => { seen.push(req.maxGasPriceWei); return o2(req) }
			await runPmGrantAdmin({ ...h2.deps, cfg: { enabled: true, targets: [LAB], denyAddresses: [DENY], maxGasPriceWei: '5000000000' } }, LAB)
			assert.equal(seen[1], 5_000_000_000n)
		} finally { h2.cleanup() }
	} finally { h.cleanup() }
})

import { deriveCandidate, readPrivateDerive } from '../src/deriveCandidate'
test('derive: private config missing, malformed or without deny list fails closed', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmprivx-'))
	try {
		const frag = join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.fragment.json')
		writeFileSync(join(dir, 'lc.json'), JSON.stringify({ dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'lp.json'), rpc: { unix: [] }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }))
		writeFileSync(join(dir, 'lp.json'), JSON.stringify({ version: 1, clients: {} }))
		const base = { liveConfig: join(dir, 'lc.json'), livePolicy: join(dir, 'lp.json'), labPolicyFragment: frag, labGid: 4242 }
		assert.throws(() => deriveCandidate({ ...base, outDir: outside(dir, 'n1') }), /private config required/)
		assert.throws(() => deriveCandidate({ ...base, outDir: outside(dir, 'n2'), privateConfig: join(dir, 'absent.json') }), /not found/)
		writeFileSync(join(dir, 'p1.json'), JSON.stringify({ labTarget: LAB, denyAddresses: [] }))
		assert.throws(() => readPrivateDerive(join(dir, 'p1.json')), /non-empty/)
		writeFileSync(join(dir, 'p2.json'), JSON.stringify({ labTarget: 'nope', denyAddresses: [DENY] }))
		assert.throws(() => readPrivateDerive(join(dir, 'p2.json')), /labTarget must be an address/)
		writeFileSync(join(dir, 'p3.json'), '{ not json')
		assert.throws(() => readPrivateDerive(join(dir, 'p3.json')), /not valid JSON/)
		assert.throws(() => deriveCandidate({ ...base, outDir: outside(dir, 'n3'), privateConfig: join(dir, 'p1.json') }), /non-empty/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('derive: minimal candidate from copies; inputs untouched; preflight passes; refusals hold', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmder-'))
	try {
		const live = { dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), adminSocketMode: 432, policyFile: join(dir, 'live-policy.json'), rpc: { unix: [{ path: join(dir, 'o.sock'), client: 'oracle-daemon', mode: 432 }, { path: join(dir, 'v.sock'), client: 'vdr-payout' }] }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} }, pmOneShot: { enabled: true } }
		const livePolicy = { version: 1, clients: { 'oracle-daemon': { arrays: {} }, 'vdr-payout': { arrays: {} } } }
		writeFileSync(join(dir, 'live-config.json'), JSON.stringify(live))
		writeFileSync(join(dir, 'live-policy.json'), JSON.stringify(livePolicy))
		const fragPath = join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.fragment.json')
		const beforeC = readFileSync(join(dir, 'live-config.json'), 'utf8'), beforeP = readFileSync(join(dir, 'live-policy.json'), 'utf8')
		const out = deriveCandidate({ privateConfig: PRIV, liveConfig: join(dir, 'live-config.json'), livePolicy: join(dir, 'live-policy.json'), labPolicyFragment: fragPath, labGid: 4242, outDir: outside(dir, 'cand') })
		assert.equal(readFileSync(join(dir, 'live-config.json'), 'utf8'), beforeC, 'live config untouched')
		assert.equal(readFileSync(join(dir, 'live-policy.json'), 'utf8'), beforeP, 'live policy untouched')
		assert.ok(out.warnings.some((w) => /pmOneShot/.test(w)))
		const cand = JSON.parse(readFileSync(out.config, 'utf8'))
		assert.equal(cand.pmGrantAdmin.enabled, false)
		assert.deepEqual(cand.pmGrantAdmin.targets, [LAB])
		assert.deepEqual(cand.pmGrantAdmin.denyAddresses, [DENY])
		assert.equal(cand.rpc.unix.find((u: { client: string }) => u.client === 'lab-mining-pool').gid, 4242)
		const pre = preflight(out.config, out.policy)
		assert.equal(pre.ok, true, JSON.stringify(pre.problems))
		assert.match(pre.policyHash!, /^0x[0-9a-f]{64}$/)
		writeFileSync(join(dir, 'gk.json'), JSON.stringify({ ...live, gasKeeper: { enabled: true, intervalMs: 60000, chains: {} } }))
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, liveConfig: join(dir, 'gk.json'), livePolicy: join(dir, 'live-policy.json'), labPolicyFragment: fragPath, labGid: 4242, outDir: outside(dir, 'c2') }), /gasKeeper/)
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, liveConfig: join(dir, 'live-config.json'), livePolicy: join(dir, 'live-policy.json'), labPolicyFragment: fragPath, labGid: 0, outDir: outside(dir, 'c3') }), /positive integer/)
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, liveConfig: out.config, livePolicy: out.policy, labPolicyFragment: fragPath, labGid: 4242, outDir: outside(dir, 'c4') }), /already has (a lab-mining-pool listener|pmGrantAdmin)/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

import { chmodSync } from 'node:fs'
import type { ListenerEvent } from '../src/rpcServer'
test('isolation: a Lab bind failure (EACCES) closes only the Lab listener; vdr and oracle keep listening', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmiso-'))
	const ro = join(dir, 'ro'); mkdirSync(ro); chmodSync(ro, 0o500)
	try {
		const svc = new SignerService(loadConfig((() => { writeFileSync(join(dir, 'p.json'), candidatePolicy()); writeFileSync(join(dir, 'c.json'), JSON.stringify({ dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } })); return join(dir, 'c.json') })()))
		const events: ListenerEvent[] = []
		const unix = [
			{ path: join(dir, 'o.sock'), client: 'oracle-daemon' },
			{ path: join(ro, 'lab.sock'), client: 'lab-mining-pool' },
			{ path: join(dir, 'v.sock'), client: 'vdr-payout' },
		]
		const servers = startRpcServers(svc, { unix }, (e) => events.push(e))
		const waitFor = (s: import('node:net').Server) => new Promise<void>((r) => { const t = setInterval(() => { if (s.listening) { clearInterval(t); r() } }, 20); setTimeout(() => { clearInterval(t); r() }, 1000) })
		await Promise.all([waitFor(servers[0]!), waitFor(servers[2]!)])
		assert.equal(servers[0]!.listening, true, 'oracle listener still up')
		assert.equal(servers[2]!.listening, true, 'vdr listener still up')
		assert.equal(servers[1]!.listening, false, 'lab listener not bound')
		assert.ok(events.some((e) => e.client === 'lab-mining-pool' && e.event === 'bind_failed'), JSON.stringify(events))
		assert.ok(events.some((e) => e.client === 'oracle-daemon' && e.event === 'listening'))
		assert.ok(events.some((e) => e.client === 'vdr-payout' && e.event === 'listening'))
		await Promise.all(servers.map((x) => new Promise<void>((r) => x.close(() => r()))))
	} finally { chmodSync(ro, 0o700); rmSync(dir, { recursive: true, force: true }) }
})

test('group mismatch: a declared gid that the socket does not carry closes only the Lab listener', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmgrp-'))
	try {
		writeFileSync(join(dir, 'p.json'), candidatePolicy())
		writeFileSync(join(dir, 'c.json'), JSON.stringify({ dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }))
		const svc = new SignerService(loadConfig(join(dir, 'c.json')))
		const events: ListenerEvent[] = []
		const servers = startRpcServers(svc, { unix: [
			{ path: join(dir, 'lab.sock'), client: 'lab-mining-pool', gid: process.getgid!() + 1 },
			{ path: join(dir, 'o.sock'), client: 'oracle-daemon' },
		] }, (e) => events.push(e))
		await new Promise((r) => setTimeout(r, 300))
		assert.equal(servers[0]!.listening, false)
		assert.equal(servers[1]!.listening, true)
		assert.ok(events.some((e) => e.event === 'group_mismatch' && e.client === 'lab-mining-pool'), JSON.stringify(events))
		await Promise.all(servers.map((x) => new Promise<void>((r) => x.close(() => r()))))
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('derive refusals: output equal to or inside an input location, existing pmGrantAdmin, existing output files', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmder2-'))
	try {
		const live = { dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'lp.json'), rpc: { unix: [] as unknown[] }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }
		writeFileSync(join(dir, 'lc.json'), JSON.stringify(live))
		writeFileSync(join(dir, 'lp.json'), JSON.stringify({ version: 1, clients: {} }))
		const frag = join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.fragment.json')
		const base = { liveConfig: join(dir, 'lc.json'), livePolicy: join(dir, 'lp.json'), labPolicyFragment: frag, labGid: 4242 }
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, ...base, outDir: join(dir, 'lc.json') }), /overlap|directory/)
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, ...base, outDir: dir }), /directory of a live input|overlap/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
test('derive refusals: existing pmGrantAdmin in the live config is refused; existing output files are refused', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmder3-'))
	try {
		const frag = join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.fragment.json')
		writeFileSync(join(dir, 'lp.json'), JSON.stringify({ version: 1, clients: {} }))
		const withGrant = { dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'lp.json'), rpc: { unix: [] }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} }, pmGrantAdmin: { enabled: false, targets: [] } }
		writeFileSync(join(dir, 'lc.json'), JSON.stringify(withGrant))
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, liveConfig: join(dir, 'lc.json'), livePolicy: join(dir, 'lp.json'), labPolicyFragment: frag, labGid: 4242, outDir: outside(dir, 'out') }), /already has pmGrantAdmin/)
		const noGrant = { ...withGrant, pmGrantAdmin: undefined }
		writeFileSync(join(dir, 'lc2.json'), JSON.stringify(noGrant))
		mkdirSync(outside(dir, 'out2'), { recursive: true })
		writeFileSync(join(outside(dir, 'out2'), 'config.json'), '{}')
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, liveConfig: join(dir, 'lc2.json'), livePolicy: join(dir, 'lp.json'), labPolicyFragment: frag, labGid: 4242, outDir: outside(dir, 'out2') }), /refusing to overwrite/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
test('preflight: pmGrantAdmin.maxGasPriceWei above 0.03 Gwei is refused', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmcap-'))
	try {
		writeFileSync(join(dir, 'p.json'), candidatePolicy())
		const unix = [{ path: join(dir, 'o.sock'), client: 'oracle-daemon' }, { path: join(dir, 'v.sock'), client: 'vdr-payout' }, { path: join(dir, 'lab.sock'), client: 'lab-mining-pool', gid: 1 }]
		const base = { dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), rpc: { unix }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }
		writeFileSync(join(dir, 'hi.json'), JSON.stringify({ ...base, pmGrantAdmin: { enabled: true, targets: [], denyAddresses: ['0x5a1ab0000000000000000000000000000000d0d0'], maxGasPriceWei: '50000000' } }))
		assert.ok(preflight(join(dir, 'hi.json')).problems.some((p) => /above the 0.03 Gwei/.test(p)))
		writeFileSync(join(dir, 'ok.json'), JSON.stringify({ ...base, pmGrantAdmin: { enabled: true, targets: [], denyAddresses: ['0x5a1ab0000000000000000000000000000000d0d0'], maxGasPriceWei: '30000000' } }))
		assert.ok(!preflight(join(dir, 'ok.json')).problems.some((p) => /above the 0.03 Gwei/.test(p)))
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listener sink: bind failure is written to stderr and to the audit log', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmsink-'))
	try {
		writeFileSync(join(dir, 'p.json'), candidatePolicy())
		writeFileSync(join(dir, 'c.json'), JSON.stringify({ dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }))
		const svc = new SignerService(loadConfig(join(dir, 'c.json')))
		const out: string[] = []
		const sink = makeListenerSink(svc, (s) => out.push(s))
		sink({ client: 'lab-mining-pool', path: '/x/lab.sock', event: 'bind_failed', detail: 'EACCES' })
		assert.ok(out.join('').includes('[listener] lab-mining-pool bind_failed /x/lab.sock EACCES'))
		const audit = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => readFileSync(join(dir, f), 'utf8')).join('')
		assert.ok(audit.includes('"event":"listener.bind_failed"'), 'audit has the listener event')
		const main = readFileSync(join(__dirname, '..', '..', 'src', 'main.ts'), 'utf8')
		assert.match(main, /startRpcServers\(svc, config\.rpc, makeListenerSink\(svc\)\)/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
test('preflight: lab maxGasPriceGwei above 0.03 is refused; derive refuses output inside an input tree', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pmlab-'))
	try {
		const pol = JSON.parse(candidatePolicy()) as { clients: Record<string, any> }
		pol.clients['lab-mining-pool'].arrays.lab_mining_pool_payout.maxGasPriceGwei = { '224422': 0.05 }
		writeFileSync(join(dir, 'p.json'), JSON.stringify(pol))
		const unix = [{ path: join(dir, 'o.sock'), client: 'oracle-daemon' }, { path: join(dir, 'v.sock'), client: 'vdr-payout' }, { path: join(dir, 'lab.sock'), client: 'lab-mining-pool', gid: 1 }]
		writeFileSync(join(dir, 'c.json'), JSON.stringify({ dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(dir, 'p.json'), rpc: { unix }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }))
		assert.ok(preflight(join(dir, 'c.json')).problems.some((p) => /maxGasPriceGwei 0.05 is above 0.03/.test(p)))
		// derive: output inside the input tree is refused
		const live = join(dir, 'live')
		mkdirSync(live)
		writeFileSync(join(live, 'config.json'), JSON.stringify({ dataDir: dir, logDir: dir, adminSocket: join(dir, 'a.sock'), policyFile: join(live, 'policy.json'), rpc: { unix: [] }, chains: { '224422': { rpcUrls: ['http://127.0.0.1:1'] } }, gasKeeper: { enabled: false, intervalMs: 60000, chains: {} } }))
		writeFileSync(join(live, 'policy.json'), JSON.stringify({ version: 1, clients: {} }))
		const frag = join(__dirname, '..', '..', 'deploy', 'lab-mining-pool', 'policy.fragment.json')
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, liveConfig: join(live, 'config.json'), livePolicy: join(live, 'policy.json'), labPolicyFragment: frag, labGid: 4242, outDir: join(live, 'cand') }), /inside the input tree/)
		assert.throws(() => deriveCandidate({ privateConfig: PRIV, liveConfig: join(live, 'config.json'), livePolicy: join(live, 'policy.json'), labPolicyFragment: frag, labGid: 4242, outDir: join(dir, 'sub', '..', 'live') }), /overlap|inside/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})
