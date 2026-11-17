/**
 * nginx-front mode, local only: a real nginx runs deploy/nginx-dle.conf (paths and ports swapped
 * for a temp dir), wallet-signer listens on rpc.proxied. No chain is needed: identity is checked
 * with signer_status (works while locked) and signer_accounts after a test unlock.
 *
 * env: X402_BUILD (x402sdk outDir, for the real client), NGINX (default: nginx on PATH)
 * usage: node dist/test/proxy.js
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyAuditFile } from '../src/audit'

type Client = { call<T = unknown>(m: string, p: unknown): Promise<T>; close(): void }
const { WalletSignerClient } = require(join(process.env.X402_BUILD!, 'walletSigner', 'remoteSigner.js')) as {
	WalletSignerClient: new (o: Record<string, unknown>) => Client
}

// Short base path: unix socket paths are limited to ~104 bytes on macOS.
const DIR = mkdtempSync(join(tmpdir(), 'wsp-'))
const NGINX = process.env.NGINX ?? 'nginx'
const NGINX_PORT = 18643
const TLS_PORT = 18644
const TCP_PROXY_PORT = 18645
const DIST = join(__dirname, '..', 'src')
const SAMPLE = join(__dirname, '..', '..', 'deploy', 'nginx-dle.conf')
const PASSWORD = randomBytes(18).toString('base64')
const PROXY_SECRET = randomBytes(24).toString('base64url')

const results: { step: string; ok: boolean; detail?: unknown }[] = []
function record(step: string, ok: boolean, detail?: unknown): void {
	results.push({ step, ok, detail })
	process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}\n`)
}
function sh(cmd: string, args: string[], input?: string): { code: number; out: string; err: string } {
	const r = spawnSync(cmd, args, { input, encoding: 'utf8' })
	return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const f = (...p: string[]) => join(DIR, ...p)

// ---------- PKI: "public" server CA (stands in for Let's Encrypt), private client CA, a rogue CA
function certs(): void {
	mkdirSync(f('pki'))
	const ossl = (...a: string[]) => {
		const r = sh('openssl', a)
		if (r.code !== 0) throw new Error(`openssl ${a[0]}: ${r.err}`)
	}
	const ca = (n: string) => ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f('pki', `${n}.key`), '-out', f('pki', `${n}.crt`), '-days', '2', '-subj', `/CN=${n}`)
	const leaf = (n: string, subj: string, caName: string, ext: string) => {
		ossl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f('pki', `${n}.key`), '-out', f('pki', `${n}.csr`), '-subj', subj)
		writeFileSync(f('pki', `${n}.ext`), ext)
		ossl('x509', '-req', '-in', f('pki', `${n}.csr`), '-CA', f('pki', `${caName}.crt`), '-CAkey', f('pki', `${caName}.key`), '-CAcreateserial', '-out', f('pki', `${n}.crt`), '-days', '2', '-extfile', f('pki', `${n}.ext`))
	}
	ca('server-ca')
	ca('client-ca')
	ca('rogue-ca')
	const client = 'extendedKeyUsage=clientAuth\n'
	leaf('server', '/CN=localhost', 'server-ca', 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
	leaf('api', '/CN=conet-beamio-api', 'client-ca', client)
	leaf('dl', '/CN=conetapiv4Local', 'client-ca', client)
	leaf('api-org', '/O=CoNET/CN=conet-beamio-api', 'client-ca', client)
	leaf('intruder', '/CN=intruder', 'client-ca', client)
	leaf('rogue', '/CN=conet-beamio-api', 'rogue-ca', client)
	// The escaped comma must not let "conet-beamio-api" be read out of a longer CN.
	leaf('tricky', '/CN=x\\,CN=conet-beamio-api', 'client-ca', client)
}

// ---------- signer config
function writeConfig(rpc: Record<string, unknown>, name: string): string {
	for (const d of ['etc', 'data', 'log', 'run']) mkdirSync(f(d), { recursive: true })
	const policy = {
		version: 1,
		clients: {
			'conet-beamio-api': { arrays: { settle_contractAdmin: { chains: [224422], allow: [{ to: '0x0000000000000000000000000000000000000001', selectors: ['setPointerWithSig(address,bytes32,uint64,uint64,uint256,bytes)'], maxGas: 300000 }], rate: { perMinute: 120 } } } },
			conetapiv4Local: { arrays: { epochManagre: { chains: [224422], allow: [{ to: '0x0000000000000000000000000000000000000002', selectors: ['updateInfo(uint256,uint256,uint256)'], maxGas: 300000 }], rate: { perMinute: 20 } } } },
		},
	}
	writeFileSync(f('etc', 'policy.json'), JSON.stringify(policy, null, 2))
	writeFileSync(f('etc', 'compromised.json'), JSON.stringify({ addresses: [] }))
	const cfg = {
		dataDir: f('data'),
		logDir: f('log'),
		adminSocket: f('run', 'admin.sock'),
		policyFile: f('etc', 'policy.json'),
		compromisedFile: f('etc', 'compromised.json'),
		rpc,
		chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'] } },
		gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
		alerts: {},
		scryptN: 2 ** 12,
		keyWaitMs: 1000,
		allowUnsafeTestInit: true,
	}
	const p = f('etc', `${name}.json`)
	writeFileSync(p, JSON.stringify(cfg, null, 2))
	return p
}

let svc: ChildProcess | undefined
async function startService(config: string): Promise<void> {
	svc = spawn(process.execPath, [join(DIST, 'main.js'), '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] })
	svc.stderr!.on('data', (d) => writeFileSync(f('service.log'), d, { flag: 'a' }))
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('service did not start')), 10000)
		svc!.stdout!.on('data', (d: Buffer) => {
			writeFileSync(f('service.log'), d, { flag: 'a' })
			if (d.toString().includes('started LOCKED')) {
				clearTimeout(t)
				resolve()
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

// ---------- nginx from the shipped sample. Every replacement must hit, so sample drift fails here.
function nginxConf(): string {
	let s = readFileSync(SAMPLE, 'utf8')
	const swap = (from: string | RegExp, to: string) => {
		const before = s
		s = s.replace(from, to)
		if (s === before) throw new Error(`nginx sample: pattern not found: ${String(from)}`)
	}
	swap('    listen 443 ssl;\n', `    listen 127.0.0.1:${NGINX_PORT} ssl;\n`)
	swap('    listen [::]:443 ssl;\n', '')
	swap('server_name signer.example.invalid;', 'server_name localhost;')
	swap('/etc/letsencrypt/live/signer.example.invalid/fullchain.pem', f('pki', 'server.crt'))
	swap('/etc/letsencrypt/live/signer.example.invalid/privkey.pem', f('pki', 'server.key'))
	swap('ssl_client_certificate /etc/wallet-signer/tls/client-ca.crt;', `ssl_client_certificate ${f('pki', 'client-ca.crt')};`)
	swap('    include /etc/nginx/wallet-signer/allow.conf;', `    include ${f('nginx', 'allow.conf')};`)
	swap(/\/var\/log\/nginx\//g, `${f('nginx')}/`)
	swap('    server unix:/run/wallet-signer-rpc/rpc.sock;', `    server unix:${f('run', 'rpc.sock')};`)
	mkdirSync(f('nginx'), { recursive: true })
	writeFileSync(f('nginx', 'allow.conf'), 'allow 127.0.0.1;\ndeny all;\n')
	writeFileSync(f('nginx', 'wallet-signer.conf'), s)
	const t = f('nginx')
	const main = `worker_processes 1;
pid ${t}/nginx.pid;
error_log ${t}/error.log warn;
events { worker_connections 64; }
http {
    access_log off;
    client_body_temp_path ${t}/body;
    proxy_temp_path ${t}/proxy;
    fastcgi_temp_path ${t}/fastcgi;
    uwsgi_temp_path ${t}/uwsgi;
    scgi_temp_path ${t}/scgi;
    include ${t}/wallet-signer.conf;
}
`
	writeFileSync(f('nginx', 'nginx.conf'), main)
	return f('nginx', 'nginx.conf')
}

let nginx: ChildProcess | undefined
async function startNginx(conf: string): Promise<void> {
	nginx = spawn(NGINX, ['-p', f('nginx'), '-c', conf, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] })
	nginx.stderr!.on('data', (d) => writeFileSync(f('nginx', 'stderr.log'), d, { flag: 'a' }))
	for (let i = 0; i < 50; i++) {
		await new Promise((r) => setTimeout(r, 100))
		if (nginx.exitCode !== null) break
		// The pid file appears before bind; give it a moment, then make sure it is still alive.
		if (existsSync(f('nginx', 'nginx.pid')) && i > 3) return
	}
	throw new Error(`nginx did not start (port ${NGINX_PORT} in use?)`)
}

function curl(args: string[]): { code: number; http: string; body: string; err: string } {
	const out = f('curl.out')
	writeFileSync(out, '')
	const r = sh('curl', ['-s', '-S', '--max-time', '10', '-o', out, '-w', '%{http_code}', ...args])
	return { code: r.code, http: r.out.trim(), body: readFileSync(out, 'utf8'), err: r.err.trim() }
}
const NG = `https://localhost:${NGINX_PORT}`
type Res = { http: string; body: string; err?: string }
/**
 * Requests through nginx with Node's TLS (macOS /usr/bin/curl is LibreSSL 3.3 and cannot finish a
 * TLS 1.3 handshake with an OpenSSL 4 nginx). Header values given as arrays are sent as repeated lines.
 */
function viaNginx(cert: string | null, opts: { method?: string; path?: string; body?: string; headers?: Record<string, string | string[]> } = {}): Promise<Res> {
	return new Promise((resolve) => {
		const body = opts.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signer_status', params: {} })
		const method = opts.method ?? 'POST'
		const req = httpsRequest(
			{
				host: '127.0.0.1',
				port: NGINX_PORT,
				servername: 'localhost',
				path: opts.path ?? '/rpc',
				method,
				ca: readFileSync(f('pki', 'server-ca.crt')),
				...(cert ? { cert: readFileSync(f('pki', `${cert}.crt`)), key: readFileSync(f('pki', `${cert}.key`)) } : {}),
				headers: { host: 'localhost', ...(method === 'POST' ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...(opts.headers ?? {}) },
				agent: false,
				timeout: 10000,
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (c: Buffer) => chunks.push(c))
				res.on('end', () => resolve({ http: String(res.statusCode), body: Buffer.concat(chunks).toString('utf8') }))
			},
		)
		req.on('error', (e) => resolve({ http: '000', body: '', err: e.message }))
		req.on('timeout', () => req.destroy(new Error('timeout')))
		req.end(method === 'POST' ? body : undefined)
	})
}
const rpcBody = (method: string, params: unknown = {}) => ['-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })]
const arraysOf = (body: string): unknown => {
	try {
		return JSON.parse(body).result?.arrays
	} catch {
		return undefined
	}
}
const direct = (extra: string[]) => curl(['--unix-socket', f('run', 'rpc.sock'), ...rpcBody('signer_status'), ...extra, 'http://wallet-signer/rpc'])

function client(name: string, ca: boolean): Client {
	return new WalletSignerClient({
		url: NG,
		cert: readFileSync(f('pki', `${name}.crt`)),
		key: readFileSync(f('pki', `${name}.key`)),
		...(ca ? { ca: readFileSync(f('pki', 'server-ca.crt')) } : {}),
		timeoutMs: 10000,
	})
}

async function main(): Promise<void> {
	const v = sh(NGINX, ['-v'])
	record('nginx available', v.code === 0, { version: v.err.trim() })
	certs()
	const config = writeConfig(
		{
			proxied: { path: f('run', 'rpc.sock'), mode: 0o660 },
			tls: { host: '127.0.0.1', port: TLS_PORT, cert: f('pki', 'server.crt'), key: f('pki', 'server.key'), ca: f('pki', 'client-ca.crt') },
			unix: [{ path: f('run', 'local.sock'), client: 'conetapiv4Local' }],
		},
		'config',
	)
	const conf = nginxConf()
	const t = sh(NGINX, ['-t', '-p', f('nginx'), '-c', conf])
	record('nginx -t accepts deploy/nginx-dle.conf (paths swapped only)', t.code === 0, { out: t.err.trim().split('\n').at(-1) })
	await startService(config)
	await startNginx(conf)

	// --- mTLS at nginx
	const noCert = await viaNginx(null)
	record('no client certificate → nginx 400, request never reaches the signer', noCert.http === '400' && noCert.body.includes('No required SSL certificate'), { http: noCert.http, err: noCert.err })
	const rogue = await viaNginx('rogue')
	record('client certificate from another CA (same CN) → nginx 400', rogue.http === '400', { http: rogue.http })
	const tricky = await viaNginx('tricky')
	record('CN with an escaped comma is not mapped → 401 from the signer', tricky.http === '401', { http: tricky.http })
	const intr = await viaNginx('intruder')
	record('valid CA, CN not in policy → 403', intr.http === '403', { http: intr.http })

	// --- identity mapping
	const api = await viaNginx('api')
	record('api certificate → identity conet-beamio-api', JSON.stringify(arraysOf(api.body)) === '["settle_contractAdmin"]', { http: api.http, arrays: arraysOf(api.body) })
	const org = await viaNginx('api-org')
	record('subject with O= as well still maps to the CN', JSON.stringify(arraysOf(org.body)) === '["settle_contractAdmin"]', { arrays: arraysOf(org.body) })

	// --- forged identity headers sent by a valid client through nginx are replaced
	const forged = await viaNginx('api', { headers: { 'X-WS-Client-CN': 'conetapiv4Local', 'X-WS-Client-Verify': 'SUCCESS', 'X-WS-Client-Fingerprint': 'ffff' } })
	record('forged X-WS-Client-CN through nginx is overwritten (still conet-beamio-api)', JSON.stringify(arraysOf(forged.body)) === '["settle_contractAdmin"]', { http: forged.http, arrays: arraysOf(forged.body) })
	const dupForged = await viaNginx('api', { headers: { 'X-WS-Client-CN': ['conetapiv4Local', 'conetapiv4Local'] } })
	record('repeated forged CN lines through nginx are replaced by one value', JSON.stringify(arraysOf(dupForged.body)) === '["settle_contractAdmin"]', { http: dupForged.http, arrays: arraysOf(dupForged.body) })
	const underscore = await viaNginx('api', { headers: { X_WS_Client_CN: 'conetapiv4Local' } })
	record('underscore variant of the header is dropped by nginx', JSON.stringify(arraysOf(underscore.body)) === '["settle_contractAdmin"]', { arrays: arraysOf(underscore.body) })
	const unknownHdr = await viaNginx('api', { headers: { 'X-WS-Admin': '1' } })
	record('unknown X-WS-* header passed through nginx → signer refuses (400)', unknownHdr.http === '400', { http: unknownHdr.http })

	// --- nginx limits
	const get = await viaNginx('api', { method: 'GET' })
	record('GET /rpc → 403 (POST only)', get.http === '403', { http: get.http })
	const other = await viaNginx('api', { path: '/healthz' })
	record('any other path → 404 (admin and health never exposed)', other.http === '404', { http: other.http })
	const big = await viaNginx('api', { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signer_status', params: { pad: 'x'.repeat(300 * 1024) } }) })
	record('body over 256 KiB → 413 at nginx', big.http === '413', { http: big.http })

	// --- the real client through nginx
	const pinned = client('dl', true)
	const st = await pinned.call<{ arrays: string[]; state: string }>('signer_status', {})
	record('WalletSignerClient (private CA given) through nginx → conetapiv4Local', JSON.stringify(st.arrays) === '["epochManagre"]' && st.state === 'locked', st)
	const noCa = client('dl', false)
	const e = (await noCa.call('signer_status', {}).catch((x) => x)) as { signerCode?: number; message?: string }
	record('WALLET_SIGNER_CA unset → public roots, so an unknown server CA is refused', e?.signerCode === -32099 && /self-signed|unable to (verify|get)/i.test(e.message ?? ''), { code: e?.signerCode, msg: e?.message })
	noCa.close()
	const envOnly = (() => {
		try {
			const c = (WalletSignerClient as unknown as { fromEnv(e: Record<string, string>): Client }).fromEnv({ WALLET_SIGNER_URL: NG, WALLET_SIGNER_CERT: f('pki', 'dl.crt'), WALLET_SIGNER_KEY: f('pki', 'dl.key') })
			c.close()
			return true
		} catch {
			return false
		}
	})()
	record('fromEnv accepts no WALLET_SIGNER_CA', envOnly)

	// unlock with a throwaway vault, then a call that needs keys
	const init = wsctl(config, ['init', '--unsafe-test-init', '--password-stdin'], `${PASSWORD}\n`)
	const un = wsctl(config, ['unlock', '--password-stdin'], `${PASSWORD}\n`)
	const add = wsctl(config, ['array', 'add', 'settle_contractAdmin', '--count', '2', '--chains', '224422'])
	const apiClient = client('api', true)
	const accts = await apiClient.call<string[]>('signer_accounts', { keyArray: 'settle_contractAdmin' }).catch((x) => x)
	record('after unlock: signer_accounts through nginx returns the array', init.code === 0 && un.code === 0 && Array.isArray(accts) && accts.join() === (add.json?.[0]?.addresses ?? []).join(), { accounts: accts })
	const cross = (await apiClient.call('signer_accounts', { keyArray: 'epochManagre' }).catch((x) => x)) as { signerCode?: number }
	record('api cannot use the epoch array through nginx (-32003)', cross?.signerCode === -32003, { code: cross?.signerCode })
	apiClient.close()
	pinned.close()

	// --- straight to the proxied socket (what a local process in group www-data could do)
	const d0 = direct([])
	record('proxied socket without identity headers → 401', d0.http === '401', { http: d0.http })
	const d1 = direct(['-H', 'X-WS-Client-CN: conet-beamio-api', '-H', 'X-WS-Client-Verify: FAILED:certificate has expired'])
	record('proxied socket with verify != SUCCESS → 401', d1.http === '401', { http: d1.http })
	const d2 = direct(['-H', 'X-WS-Client-CN: conet-beamio-api', '-H', 'X-WS-Client-CN: conetapiv4Local', '-H', 'X-WS-Client-Verify: SUCCESS'])
	record('proxied socket with a duplicated CN header → 400', d2.http === '400', { http: d2.http })
	const d3 = direct(['-H', 'X-WS-Client-CN: conet-beamio-api/../x', '-H', 'X-WS-Client-Verify: SUCCESS'])
	record('proxied socket with a malformed CN → 401', d3.http === '401', { http: d3.http })

	// --- the same headers on listeners that are not behind nginx are refused outright
	const tlsForged = curl(['--cacert', f('pki', 'server-ca.crt'), '--cert', f('pki', 'api.crt'), '--key', f('pki', 'api.key'), ...rpcBody('signer_status'), '-H', 'X-WS-Client-CN: conetapiv4Local', `https://localhost:${TLS_PORT}/rpc`])
	record('direct-TLS listener: X-WS-Client-CN header → 400', tlsForged.http === '400', { http: tlsForged.http })
	const tlsPlain = curl(['--cacert', f('pki', 'server-ca.crt'), '--cert', f('pki', 'api.crt'), '--key', f('pki', 'api.key'), ...rpcBody('signer_status'), `https://localhost:${TLS_PORT}/rpc`])
	record('direct-TLS listener still works without the header', JSON.stringify(arraysOf(tlsPlain.body)) === '["settle_contractAdmin"]', { http: tlsPlain.http })
	const tlsNoCert = curl(['--cacert', f('pki', 'server-ca.crt'), ...rpcBody('signer_status'), `https://localhost:${TLS_PORT}/rpc`])
	record('direct-TLS listener: no client certificate → handshake fails', tlsNoCert.code !== 0 && tlsNoCert.http === '000', { curlExit: tlsNoCert.code })
	const unixForged = curl(['--unix-socket', f('run', 'local.sock'), ...rpcBody('signer_status'), '-H', 'X-WS-Client-Verify: SUCCESS', 'http://wallet-signer/rpc'])
	record('local client socket: X-WS-* header → 400', unixForged.http === '400', { http: unixForged.http })

	await stopService()

	// --- loopback TCP fallback needs the shared secret
	const tcpConfig = writeConfig(
		{ proxied: { host: '127.0.0.1', port: TCP_PROXY_PORT, secretSha256: createHash('sha256').update(PROXY_SECRET).digest('hex') } },
		'config-tcp',
	)
	await startService(tcpConfig)
	const tcp = (extra: string[]) => curl([...rpcBody('signer_status'), '-H', 'X-WS-Client-CN: conet-beamio-api', '-H', 'X-WS-Client-Verify: SUCCESS', ...extra, `http://127.0.0.1:${TCP_PROXY_PORT}/rpc`])
	const t0 = tcp([])
	const t1 = tcp(['-H', 'X-WS-Proxy-Auth: wrong'])
	const t2 = tcp(['-H', `X-WS-Proxy-Auth: ${PROXY_SECRET}`])
	record('loopback TCP proxied listener: no/wrong secret → 403, right secret → 200', t0.http === '403' && t1.http === '403' && t2.http === '200', { none: t0.http, wrong: t1.http, right: t2.http })
	await stopService()

	// --- data on the encrypted volume: refuse to start / init when it is not mounted
	const unmounted = JSON.parse(readFileSync(config, 'utf8'))
	unmounted.requireMountPoint = f('vol')
	unmounted.dataDir = f('vol', 'state')
	unmounted.logDir = f('vol', 'log')
	writeFileSync(f('etc', 'config-unmounted.json'), JSON.stringify(unmounted))
	const m1 = sh(process.execPath, [join(DIST, 'main.js'), '--config', f('etc', 'config-unmounted.json')])
	const m2 = wsctl(f('etc', 'config-unmounted.json'), ['init', '--unsafe-test-init', '--password-stdin'], `${PASSWORD}\n`)
	record('volume not mounted: daemon and wsctl init refuse, nothing created', m1.code !== 0 && /not mounted/.test(m1.err) && m2.code !== 0 && /not mounted/.test(m2.err) && !existsSync(f('vol')), { daemon: m1.err.trim().split('\n')[0], wsctl: m2.err.split('\n')[0] })

	// --- audit
	const auditPath = f('log', 'audit.jsonl')
	const audit = readFileSync(auditPath, 'utf8')
	const reasons = audit.trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.event === 'deny').map((x) => `${x.via ?? ''}:${x.reason}`)
	record('audit log (in logDir) records each refusal, chain intact', verifyAuditFile(auditPath) === null && ['tls:forged_proxy_header', 'unix:forged_proxy_header', 'proxied:duplicate_proxy_header', 'proxied:client_cert_not_verified', 'proxied:bad_proxy_secret', 'proxied:unknown_proxy_header', 'proxied:bad_client_cn'].every((r) => reasons.includes(r)), { reasons: [...new Set(reasons)] })
	record('password and proxy secret absent from logs', ![audit, readFileSync(f('service.log'), 'utf8')].some((x) => x.includes(PASSWORD) || x.includes(PROXY_SECRET)))
}

main()
	.catch((e) => record('crashed', false, e instanceof Error ? e.stack : String(e)))
	.finally(async () => {
		await stopService().catch(() => undefined)
		if (nginx) {
			const p = new Promise((r) => nginx!.once('exit', r))
			nginx.kill('SIGQUIT')
			await p
		}
		writeFileSync(f('report.json'), JSON.stringify(results, null, 2))
		const failed = results.filter((r) => !r.ok)
		process.stdout.write(`\n${results.length - failed.length}/${results.length} passed  (work dir ${DIR})\n`)
		process.exit(failed.length ? 1 : 0)
	})
