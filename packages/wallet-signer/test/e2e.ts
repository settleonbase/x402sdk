/**
 * End-to-end on a local anvil fork of CoNET (chain 224422). Nothing touches a public network:
 * the signer's only RPC is the fork, P0 steps run via anvil impersonation.
 *
 * env: E2E_DIR (empty work dir), FORK_RPC (http://127.0.0.1:18545), X402_BUILD, DL_BUILD,
 *      NODE_PATH (x402sdk node_modules, for the harness)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Interface, JsonRpcProvider, Wallet, formatEther, parseEther, toBeHex } from 'ethers'
import { verifyAuditFile } from '../src/audit'
import { CONTRACTS, LEAKED, buildSteps, forkRun } from '../p0/p0Plan'
// The client is the x402sdk copy (compiled into X402_BUILD), exactly what the daemons use.
type Client = { call<T = unknown>(m: string, p: unknown): Promise<T>; close(): void }
const { WalletSignerClient } = require(join(process.env.X402_BUILD!, 'walletSigner', 'remoteSigner.js')) as {
	WalletSignerClient: new (o: Record<string, unknown>) => Client
}

const DIR = process.env.E2E_DIR!
const FORK = process.env.FORK_RPC ?? 'http://127.0.0.1:18545'
const PORT = 18443
const DIST = join(__dirname, '..', 'src')
const HARNESS = join(__dirname, 'daemonHarness.js')
// Random per run, only in this process' memory; passed to wsctl over stdin.
const PASSWORD = randomBytes(18).toString('base64')

const results: { step: string; ok: boolean; detail?: unknown }[] = []
function record(step: string, ok: boolean, detail?: unknown): void {
	results.push({ step, ok, detail })
	process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail !== undefined ? `  ${JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}` : ''}\n`)
}

function sh(cmd: string, args: string[], input?: string): { code: number; out: string; err: string } {
	const r = spawnSync(cmd, args, { input, encoding: 'utf8' })
	return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

// ---------- certificates ----------
function certs(): Record<string, string> {
	const d = join(DIR, 'pki')
	mkdirSync(d, { recursive: true })
	const f = (n: string) => join(d, n)
	const ossl = (...a: string[]) => {
		const r = sh('openssl', a)
		if (r.code !== 0) throw new Error(`openssl ${a[0]}: ${r.err}`)
	}
	const ca = (name: string) => {
		ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f(`${name}.key`), '-out', f(`${name}.crt`), '-days', '2', '-subj', `/CN=${name}`)
	}
	const leaf = (name: string, cn: string, caName: string, ext: string) => {
		ossl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f(`${name}.key`), '-out', f(`${name}.csr`), '-subj', `/CN=${cn}`)
		writeFileSync(f(`${name}.ext`), ext)
		ossl('x509', '-req', '-in', f(`${name}.csr`), '-CA', f(`${caName}.crt`), '-CAkey', f(`${caName}.key`), '-CAcreateserial', '-out', f(`${name}.crt`), '-days', '2', '-extfile', f(`${name}.ext`))
	}
	ca('test-ca')
	ca('rogue-ca')
	leaf('server', 'localhost', 'test-ca', 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
	leaf('api', 'conet-beamio-api', 'test-ca', 'extendedKeyUsage=clientAuth\n')
	leaf('dl', 'conetapiv4Local', 'test-ca', 'extendedKeyUsage=clientAuth\n')
	leaf('intruder', 'intruder', 'test-ca', 'extendedKeyUsage=clientAuth\n')
	leaf('rogue', 'conet-beamio-api', 'rogue-ca', 'extendedKeyUsage=clientAuth\n')
	return { dir: d }
}

// ---------- signer config ----------
function writeConfig(): string {
	const etc = join(DIR, 'etc')
	const data = join(DIR, 'data')
	const run = join(DIR, 'run')
	for (const x of [etc, data, run]) mkdirSync(x, { recursive: true })
	const pki = join(DIR, 'pki')
	const policy = {
		version: 1,
		clients: {
			'conet-beamio-api': {
				arrays: {
					settle_contractAdmin: {
						chains: [224422],
						allow: [{ to: CONTRACTS.chatIndexRegistry, selectors: ['setPointerWithSig(address,bytes32,uint64,uint64,uint256,bytes)'], maxGas: 300000 }],
						rate: { perMinute: 120, perDay: 50000 },
						maxGasPriceGwei: { '224422': 2 },
						dailyGasBudgetWei: { '224422': parseEther('0.5').toString() },
					},
					gbDepinAirdropAdmin: {
						chains: [224422],
						allow: [{ to: CONTRACTS.gbDepinAirdrop, selectors: ['airdropDepinPaidPage(uint256,uint256,bool)', 'airdropDepinPaidAll()'], maxGas: 16000000 }],
						rate: { perMinute: 6 },
						maxGasPriceGwei: { '224422': 3 },
					},
				},
			},
			conetapiv4Local: {
				arrays: {
					epochManagre: {
						chains: [224422],
						allow: [
							{ to: CONTRACTS.epochMiningInfo, selectors: ['updateInfo(uint256,uint256,uint256)'], maxGas: 300000 },
							{ to: CONTRACTS.epochMiningInfo, selectors: ['changeAddressInAdminlist(address,bool)'], maxGas: 150000, args: { '0': { in: '@compromised' }, '1': { eq: false } } },
						],
						rate: { perMinute: 20 },
						maxGasPriceGwei: { '224422': 2 },
					},
				},
			},
		},
	}
	writeFileSync(join(etc, 'policy.json'), JSON.stringify(policy, null, 2))
	writeFileSync(join(etc, 'compromised.json'), JSON.stringify({ note: 'partial list for tests', addresses: Object.values(LEAKED) }, null, 2))
	const cfg = {
		dataDir: data,
		adminSocket: join(run, 'admin.sock'),
		policyFile: join(etc, 'policy.json'),
		compromisedFile: join(etc, 'compromised.json'),
		rpc: { tls: { host: '127.0.0.1', port: PORT, cert: join(pki, 'server.crt'), key: join(pki, 'server.key'), ca: join(pki, 'test-ca.crt') } },
		chains: { '224422': { rpcUrls: [FORK], resendAfterMs: 20000, maxResends: 3, receiptPollMs: 500 } },
		gasKeeper: {
			enabled: false,
			intervalMs: 3000,
			chains: {
				'224422': {
					wallets: [],
					budgetWei: '0',
					minWei: parseEther('0.05').toString(),
					targetWei: parseEther('0.2').toString(),
					perAddressDailyWei: parseEther('1').toString(),
					globalDailyWei: parseEther('5').toString(),
					pmWarnWei: parseEther('5').toString(),
					pmCriticalWei: parseEther('1').toString(),
				},
			},
		},
		alerts: {},
		scryptN: 2 ** 18,
		keyWaitMs: 10000,
		allowUnsafeTestInit: true,
	}
	const path = join(etc, 'config.json')
	writeFileSync(path, JSON.stringify(cfg, null, 2))
	return path
}

let svc: ChildProcess | undefined
async function startService(config: string): Promise<void> {
	svc = spawn(process.execPath, ['--disable-sigusr1', '--disallow-code-generation-from-strings', join(DIST, 'main.js'), '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] })
	const log = join(DIR, 'service.log')
	svc.stdout!.on('data', (d) => writeFileSync(log, d, { flag: 'a' }))
	svc.stderr!.on('data', (d) => writeFileSync(log, d, { flag: 'a' }))
	await new Promise<void>((r, j) => {
		const t = setTimeout(() => j(new Error('service did not start')), 10000)
		svc!.stdout!.on('data', (d: Buffer) => {
			if (d.toString().includes('started LOCKED')) {
				clearTimeout(t)
				r()
			}
		})
	})
}
async function stopService(): Promise<void> {
	if (!svc) return
	const p = new Promise((r) => svc!.once('exit', r))
	svc.kill('SIGTERM')
	await p
	svc = undefined
}

function wsctl(config: string, args: string[], input?: string): { code: number; json: any; err: string } {
	const r = sh(process.execPath, [join(DIST, 'wsctl.js'), '--config', config, ...args], input)
	let json: unknown = null
	try {
		json = JSON.parse(r.out)
	} catch {
		/* not json */
	}
	return { code: r.code, json, err: r.err.trim() }
}

function client(name: 'api' | 'dl' | 'intruder' | 'rogue'): Client {
	const pki = join(DIR, 'pki')
	return new WalletSignerClient({
		url: `https://localhost:${PORT}`,
		cert: readFileSync(join(pki, `${name}.crt`)),
		key: readFileSync(join(pki, `${name}.key`)),
		ca: readFileSync(join(pki, 'test-ca.crt')),
		timeoutMs: 120000,
	})
}

function harness(cmd: string, who: 'api' | 'dl', extra: string[] = []): any {
	const pki = join(DIR, 'pki')
	const env = {
		...process.env,
		CONET_RPC_URL: FORK,
		WALLET_SIGNER_URL: `https://localhost:${PORT}`,
		WALLET_SIGNER_CERT: join(pki, `${who}.crt`),
		WALLET_SIGNER_KEY: join(pki, `${who}.key`),
		WALLET_SIGNER_CA: join(pki, 'test-ca.crt'),
		WALLET_SIGNER_FEATURES: who === 'api' ? 'chat,gbAirdrop' : 'epoch',
	}
	const r = spawnSync(process.execPath, [HARNESS, cmd, ...extra], { env, encoding: 'utf8', timeout: 180000 })
	const line = (r.stdout ?? '').trim().split('\n').at(-1) ?? ''
	try {
		return JSON.parse(line)
	} catch {
		return { raw: r.stdout, err: r.stderr }
	}
}

function curl(args: string[]): { code: number; out: string; err: string } {
	return sh('curl', ['-s', '-S', '--max-time', '10', ...args])
}

async function main(): Promise<void> {
	const fork = new JsonRpcProvider(FORK, 224422, { staticNetwork: true })
	const head = await fork.getBlockNumber()
	record('anvil fork of CoNET reachable', head > 2_000_000, { head, clientVersion: await fork.send('web3_clientVersion', []) })
	certs()
	const config = writeConfig()

	// --- init + first unlock
	let t = Date.now()
	const init = wsctl(config, ['init', '--unsafe-test-init', '--password-stdin'], `${PASSWORD}\n`)
	record('wsctl init writes keystore v3 vault (scrypt N=2^18)', init.code === 0, { pm: init.json?.pm, ms: Date.now() - t })
	const vault = JSON.parse(readFileSync(join(DIR, 'data', 'vault.json'), 'utf8'))
	const vc = vault.Crypto ?? vault.crypto
	record('vault file has no plaintext mnemonic', !JSON.stringify(vault).match(/"(phrase|mnemonic)"\s*:\s*"[a-z ]+"/) && vc?.kdfparams?.n === 2 ** 18, { kdf: vc?.kdf, n: vc?.kdfparams?.n, xEthers: Object.keys(vault['x-ethers'] ?? {}) })

	await startService(config)
	const st0 = wsctl(config, ['status'])
	record('service starts LOCKED', st0.json?.state === 'locked')
	const lockedReq = (await client('api').call('signer_sendTransaction', { keyArray: 'settle_contractAdmin', chainId: 224422, to: CONTRACTS.chatIndexRegistry, data: '0x12345678' }).catch((e) => e)) as { signerCode?: number }
	record('client request while locked → LOCKED (-32001)', lockedReq?.signerCode === -32001, { code: lockedReq?.signerCode })

	const bad = wsctl(config, ['unlock', '--password-stdin'], 'wrong-password-123\n')
	record('wrong password rejected, backoff starts', bad.code !== 0, { err: bad.err })
	await new Promise((r) => setTimeout(r, 1100))
	t = Date.now()
	const un = wsctl(config, ['unlock', '--password-stdin'], `${PASSWORD}\n`)
	record('wsctl unlock (password over admin socket from stdin/tty)', un.code === 0 && !!un.json?.pm, { fingerprint: un.json, ms: Date.now() - t })

	// --- key arrays named after master.json fields
	const a1 = wsctl(config, ['array', 'add', 'settle_contractAdmin', '--count', '4', '--chains', '224422'])
	const a2 = wsctl(config, ['array', 'add', 'epochManagre', '--count', '1', '--chains', '224422'])
	const a3 = wsctl(config, ['array', 'add', 'gbDepinAirdropAdmin', '--count', '1', '--chains', '224422'])
	const settle = a1.json?.[0]?.addresses as string[]
	const epochNew = a2.json?.[0]?.addresses?.[0] as string
	const airdropNew = a3.json?.[0]?.addresses?.[0] as string
	record('arrays created on accounts 10/11/12', a1.json?.[0]?.account === 10 && a2.json?.[0]?.account === 11 && a3.json?.[0]?.account === 12, { settle, epochNew, airdropNew })
	const registryBefore = wsctl(config, ['status']).json?.registryHash

	// Local fork balances only. The gas keeper stays disabled and does not sweep every array.
	const pm = un.json.pm as string
	await fork.send('anvil_setBalance', [pm, toBeHex(parseEther('10'))])
	for (const address of [...settle, epochNew, airdropNew]) {
		await fork.send('anvil_setBalance', [address, toBeHex(parseEther('0.2'))])
	}
	const bal = await Promise.all([...settle, epochNew, airdropNew].map((a) => fork.getBalance(a)))
	record('local fork funds array keys directly while the gas keeper stays off', bal.every((b) => b === parseEther('0.2')), { balances: bal.map(formatEther), pm: formatEther(await fork.getBalance(pm)) })

	// --- before P0: daemons must wait for grants
	const er0 = harness('epoch-reconcile', 'dl')
	record('epoch daemon before P0: WAITING_FOR_GRANT + bootstrap plan', er0.report?.state === 'MISSING_GRANT' && er0.report?.externalPlan?.length === 1, { plan: er0.report?.externalPlan?.[0]?.call })
	const eu0 = harness('epoch-update', 'dl', ['1'])
	record('epoch update skipped while not admin (no tx)', eu0.hash === null, { logs: eu0.logs })
	const ar0 = harness('airdrop-roles', 'api')
	record('airdrop daemon before grant: MISSING_GRANT, plan for owner', ar0.state === 'MISSING_GRANT', { plan: ar0.externalPlan?.map((s: any) => `${s.signer.slice(0, 6)} ${s.call}`) })

	// --- P0 rehearsal on the fork (leaked keys hand over to COLD / NEW)
	const cold = Wallet.createRandom().address
	const steps = buildSteps(cold, epochNew, [airdropNew]).filter((s) => s.chainId === 224422)
	const p0 = steps.filter((s) => s.phase === 'P0')
	const used = await forkRun(fork, p0, () => undefined)
	// Steps whose role the address never held are skipped by forkRun, so check every step's state.
	const p0Done = await Promise.all(p0.map((s) => s.done(fork)))
	record('P0 steps execute on fork (impersonated leaked keys + COLD)', p0Done.every(Boolean), { executed: Object.keys(used).length, total: p0.length, notDone: p0.filter((_, i) => !p0Done[i]).map((s) => s.id) })

	// --- chat relay pilot (no on-chain permission needed)
	const c1 = harness('chat', 'api')
	record('chatIndexPointerRelay via wallet-signer: 200 + pointer on chain', c1.http === 200 && c1.pointerMatches === true, c1.body)

	// --- epoch: daemon removes leaked admins itself, then writes
	const er1 = harness('epoch-reconcile', 'dl')
	const iface = new Interface(['function adminList(address) view returns (bool)'])
	const isAdmin = async (a: string) => iface.decodeFunctionResult('adminList', await fork.call({ to: CONTRACTS.epochMiningInfo, data: iface.encodeFunctionData('adminList', [a]) }))[0] as boolean
	const leakedStill = await Promise.all([LEAKED.epochManagre, LEAKED.master].map(isAdmin))
	record('epoch reconcile: NEW removed 0x4A3A and 0x87cA itself (P3)', er1.report?.state === 'CLEAN' && leakedStill.every((x) => !x) && (await isAdmin(epochNew)), { logs: er1.logs })
	const epochNo = 2029999
	const eu1 = harness('epoch-update', 'dl', [String(epochNo)])
	record('updateEpochToSC via wallet-signer: tx + currentInfo updated', typeof eu1.hash === 'string' && eu1.currentInfo?.[1] === '123' && eu1.currentInfo?.[3] === '456', eu1)

	// --- idempotency: same key returns the first tx
	const api = client('api')
	const dl = client('dl')
	const epochData = new Interface(['function updateInfo(uint256,uint256,uint256)']).encodeFunctionData('updateInfo', [1, 2, 3])
	const s1 = await dl.call<any>('signer_sendTransaction', { keyArray: 'epochManagre', chainId: 224422, to: CONTRACTS.epochMiningInfo, data: epochData, gasLimit: '200000', idempotencyKey: 'e2e:idem' })
	const s2 = await dl.call<any>('signer_sendTransaction', { keyArray: 'epochManagre', chainId: 224422, to: CONTRACTS.epochMiningInfo, data: epochData, gasLimit: '200000', idempotencyKey: 'e2e:idem' })
	record('same idempotencyKey → same tx, not sent twice', s1.hash === s2.hash && s2.duplicate === true, { hash: s1.hash })

	// --- airdrop: COLD grants NEW (P4), daemon runs a page, then COLD revokes the leaked admins
	const grant = steps.filter((s) => s.id.startsWith('gba.addAdmin'))
	await forkRun(fork, grant, () => undefined)
	await fork.send('evm_increaseTime', [3600])
	await fork.send('evm_mine', [])
	const ap = harness('airdrop-page', 'api')
	record('gbDepinAirdropAllPoolPress via wallet-signer: page tx mined', ap.http === 200 && typeof ap.body?.hash === 'string', ap.body)
	const revoke = steps.filter((s) => s.phase === 'P4' && !s.id.startsWith('gba.addAdmin'))
	const usedP4 = await forkRun(fork, revoke, () => undefined)
	const ar1 = harness('airdrop-roles', 'api')
	record('P4 revokes done; airdrop roles CLEAN', ar1.state === 'CLEAN', Object.fromEntries(Object.entries(usedP4).map(([k, v]) => [k, v.toString()])))

	// --- policy denials
	const deny = async (label: string, p: Promise<unknown>, code: number) => {
		const e = (await p.catch((x) => x)) as { signerCode?: number; message?: string }
		record(label, e?.signerCode === code, { code: e?.signerCode, msg: e?.message })
	}
	await deny('DL client cannot use settle_contractAdmin', dl.call('signer_accounts', { keyArray: 'settle_contractAdmin' }), -32003)
	const setParam = new Interface(['function setMonthlyPaidGbPerNode(uint256)']).encodeFunctionData('setMonthlyPaidGbPerNode', [1])
	await deny('airdrop key cannot call setMonthlyPaidGbPerNode (not whitelisted)', api.call('signer_sendTransaction', { keyArray: 'gbDepinAirdropAdmin', chainId: 224422, to: CONTRACTS.gbDepinAirdrop, data: setParam }), -32003)
	const addBack = new Interface(['function changeAddressInAdminlist(address,bool)'])
	await deny('epoch key cannot re-add a leaked admin', dl.call('signer_sendTransaction', { keyArray: 'epochManagre', chainId: 224422, to: CONTRACTS.epochMiningInfo, data: addBack.encodeFunctionData('changeAddressInAdminlist', [LEAKED.master, true]) }), -32003)
	await deny('epoch key cannot remove a non-leaked admin', dl.call('signer_sendTransaction', { keyArray: 'epochManagre', chainId: 224422, to: CONTRACTS.epochMiningInfo, data: addBack.encodeFunctionData('changeAddressInAdminlist', [epochNew, false]) }), -32003)
	await deny('plain CNET transfer from an array key refused', api.call('signer_sendTransaction', { keyArray: 'settle_contractAdmin', chainId: 224422, to: cold, data: '0x', value: '1' }), -32003)
	await deny('eth_sign disabled', api.call('eth_sign', [settle[0], '0x00']), -32601)
	await deny('wrong chain refused', api.call('signer_sendTransaction', { keyArray: 'settle_contractAdmin', chainId: 8453, to: CONTRACTS.chatIndexRegistry, data: '0x12345678' }), -32003)

	// --- mTLS
	const pki = join(DIR, 'pki')
	const noCert = curl(['--cacert', join(pki, 'test-ca.crt'), '-X', 'POST', '-d', '{}', `https://localhost:${PORT}/rpc`])
	record('mTLS: request without client cert rejected at TLS handshake', noCert.code !== 0, { curlExit: noCert.code, err: noCert.err.slice(0, 160) })
	const rogue = curl(['--cacert', join(pki, 'test-ca.crt'), '--cert', join(pki, 'rogue.crt'), '--key', join(pki, 'rogue.key'), '-X', 'POST', '-d', '{}', `https://localhost:${PORT}/rpc`])
	record('mTLS: cert from another CA (same CN) rejected', rogue.code !== 0, { curlExit: rogue.code, err: rogue.err.slice(0, 160) })
	const intr = curl(['--cacert', join(pki, 'test-ca.crt'), '--cert', join(pki, 'intruder.crt'), '--key', join(pki, 'intruder.key'), '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-d', '{"jsonrpc":"2.0","id":1,"method":"eth_accounts"}', `https://localhost:${PORT}/rpc`])
	record('mTLS: valid CA but client not in policy → 403', intr.out === '403', { http: intr.out })
	const ok = curl(['--cacert', join(pki, 'test-ca.crt'), '--cert', join(pki, 'api.crt'), '--key', join(pki, 'api.key'), '-X', 'POST', '-d', '{"jsonrpc":"2.0","id":1,"method":"signer_accounts","params":{"keyArray":"settle_contractAdmin"}}', `https://localhost:${PORT}/rpc`])
	record('mTLS: valid client cert accepted', ok.out.includes(settle[0]!))

	// --- restart → locked → daemons get 503 → unlock → same addresses
	await stopService()
	await startService(config)
	const st1 = wsctl(config, ['status'])
	record('after restart: LOCKED, registry kept', st1.json?.state === 'locked' && st1.json?.registryHash === registryBefore)
	const c2 = harness('chat', 'api')
	record('chat relay while locked → 503 signer_unavailable (not cached)', c2.http === 503 && c2.body?.retryable === true, c2.body)
	const un2 = wsctl(config, ['unlock', '--password-stdin'], `${PASSWORD}\n`)
	const addrs2 = await api.call<string[]>('signer_accounts', { keyArray: 'settle_contractAdmin' })
	record('unlock after restart: same PM, same registry, same addresses', un2.json?.pm === pm && un2.json?.registryHash === registryBefore && addrs2.join() === settle.join())
	const c3 = harness('chat', 'api')
	record('chat relay works again after unlock', c3.http === 200 && c3.pointerMatches === true, { txHash: c3.body?.txHash })

	// --- tampered registry refused
	await stopService()
	const regPath = join(DIR, 'data', 'registry.json')
	copyFileSync(regPath, `${regPath}.bak`)
	const reg = JSON.parse(readFileSync(regPath, 'utf8'))
	reg.arrays[1].addresses[0] = Wallet.createRandom().address
	writeFileSync(regPath, JSON.stringify(reg))
	await startService(config)
	const un3 = wsctl(config, ['unlock', '--password-stdin'], `${PASSWORD}\n`)
	const st3 = wsctl(config, ['status'])
	const tamperedReq = await api.call('signer_sendTransaction', { keyArray: 'settle_contractAdmin', chainId: 224422, to: CONTRACTS.chatIndexRegistry, data: '0x12345678' }).catch((e) => e)
	record('tampered registry: unlock refused, signer stays in registry_mismatch', un3.code !== 0 && st3.json?.state === 'registry_mismatch' && (tamperedReq as any)?.signerCode === -32010, { err: un3.err })
	await stopService()
	copyFileSync(`${regPath}.bak`, regPath)
	await startService(config)
	wsctl(config, ['unlock', '--password-stdin'], `${PASSWORD}\n`)

	// --- audit + journal hygiene
	const auditPath = join(DIR, 'data', 'audit.jsonl')
	record('audit log hash chain intact', verifyAuditFile(auditPath) === null, { lines: readFileSync(auditPath, 'utf8').trim().split('\n').length })
	const blob = ['audit.jsonl', 'txjournal.jsonl', 'registry.json', 'gaskeeper-state.json'].map((f) => {
		try {
			return readFileSync(join(DIR, 'data', f), 'utf8')
		} catch {
			return ''
		}
	}).join('\n') + readFileSync(join(DIR, 'service.log'), 'utf8')
	record('password never appears in data files or service log', !blob.includes(PASSWORD))
	const txl = wsctl(config, ['tx', 'list', '--limit', '50']).json as any[]
	record('tx journal: all signer txs mined', Array.isArray(txl) && txl.length > 0 && txl.every((r) => r.status === 'mined' || r.status === 'reverted'), { count: txl?.length, byArray: txl?.reduce((m: Record<string, number>, r: any) => ({ ...m, [r.array]: (m[r.array] ?? 0) + 1 }), {}) })

	await stopService()
	api.close()
	dl.close()
	writeFileSync(join(DIR, 'report.json'), JSON.stringify(results, null, 2))
	const failed = results.filter((r) => !r.ok)
	process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`)
	process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
	process.stdout.write(`E2E crashed: ${e instanceof Error ? e.stack : String(e)}\n`)
	await stopService().catch(() => undefined)
	process.exit(1)
})
