import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/edge.mjs'

const edge = fileURLToPath(new URL('../src/edge.mjs', import.meta.url))
const roots = []

function tempRoot() {
	const root = mkdtempSync(path.join(os.tmpdir(), 'signer-edge-'))
	roots.push(root)
	return root
}

function makeCert(cn) {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const cert = new X509Certificate(publicKey)
	void cert
	const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
	const forged = `-----BEGIN CERTIFICATE-----\n${Buffer.from(`test-cert-${cn}`).toString('base64')}\n-----END CERTIFICATE-----\n`
	return { key: pem, cert: forged }
}

function realPair(cn) {
	const { execFileSync } = requireChild()
	const dir = tempRoot()
	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
		'-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
		'-days', '2', '-nodes', '-subj', `/CN=${cn}`,
	], { stdio: 'ignore' })
	return dir
}

function requireChild() {
	return { execFileSync: (awaitImport => awaitImport)(0) }
}

test.after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('config rejects signer-owned paths and accepts the fixed surface', () => {
	assert.throws(() => loadConfig({
		SIGNER_EDGE_HTTPS_PORT: '8443',
		SIGNER_EDGE_CERT: '/opt/wallet-signer/tls/cert.pem',
		SIGNER_EDGE_KEY: '/tmp/key.pem',
	}), /must not point inside/)
	const cfg = loadConfig({
		SIGNER_EDGE_HTTPS_PORT: '8443',
		SIGNER_EDGE_HTTP_PORT: '8080',
		SIGNER_EDGE_CERT: '/tmp/cert.pem',
		SIGNER_EDGE_KEY: '/tmp/key.pem',
		SIGNER_EDGE_INDEX: '/tmp/index.html',
		SIGNER_EDGE_ACME_DIR: '/tmp/acme',
	})
	assert.equal(cfg.httpPort, 8080)
	assert.equal(cfg.acmeDir, '/tmp/acme')
})

function publish(store, name, certDir) {
	const dest = path.join(store, 'versions', name)
	mkdirSync(dest, { recursive: true })
	writeFileSync(path.join(dest, 'fullchain.pem'), readFileSync(path.join(certDir, 'cert.pem')))
	writeFileSync(path.join(dest, 'privkey.pem'), readFileSync(path.join(certDir, 'key.pem')))
	const next = path.join(store, 'current.next')
	try { rmSync(next) } catch { /* first publish */ }
	symlinkSync(path.join('versions', name), next)
	rmSync(path.join(store, 'current'), { force: true })
	const { renameSync } = fsSync()
	renameSync(next, path.join(store, 'current'))
	return dest
}

function fsSync() {
	return { renameSync: (from, to) => {
		const { renameSync } = importSync()
		renameSync(from, to)
	} }
}

function importSync() {
	return { renameSync: globalThis.__edgeRename || null }
}

test('fixed routes hide worker identity and reject a bad certificate without stopping', async () => {
	const { execFileSync } = await import('node:child_process')
	const store = tempRoot()
	mkdirSync(path.join(store, 'versions'), { recursive: true })
	const first = tempRoot()
	const second = tempRoot()
	execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', path.join(first, 'key.pem'), '-out', path.join(first, 'cert.pem'), '-days', '2', '-nodes', '-subj', '/CN=one'], { stdio: 'ignore' })
	execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', path.join(second, 'key.pem'), '-out', path.join(second, 'cert.pem'), '-days', '2', '-nodes', '-subj', '/CN=two'], { stdio: 'ignore' })
	const destA = path.join(store, 'versions', 'a')
	mkdirSync(destA, { recursive: true })
	writeFileSync(path.join(destA, 'fullchain.pem'), readFileSync(path.join(first, 'cert.pem')))
	writeFileSync(path.join(destA, 'privkey.pem'), readFileSync(path.join(first, 'key.pem')))
	symlinkSync(path.join('versions', 'a'), path.join(store, 'current'))
	const index = path.join(store, 'index.html')
	writeFileSync(index, 'dle.conet.network\n')
	const acme = path.join(store, 'acme')
	mkdirSync(acme)
	writeFileSync(path.join(acme, 'token-ok'), 'challenge-body')
	const httpsPort = await freePort()
	const httpPort = await freePort()
	const child = spawn(process.execPath, [edge], {
		env: {
			...process.env,
			SIGNER_EDGE_HTTPS_PORT: String(httpsPort),
			SIGNER_EDGE_HTTP_PORT: String(httpPort),
			SIGNER_EDGE_WORKERS: '2',
			SIGNER_EDGE_CERT_POLL_MS: '300',
			SIGNER_EDGE_CERT: path.join(store, 'current', 'fullchain.pem'),
			SIGNER_EDGE_KEY: path.join(store, 'current', 'privkey.pem'),
			SIGNER_EDGE_INDEX: index,
			SIGNER_EDGE_ACME_DIR: acme,
			SIGNER_EDGE_BIND: '127.0.0.1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let log = ''
	child.stdout.on('data', (chunk) => { log += chunk })
	child.stderr.on('data', (chunk) => { log += chunk })
	try {
		await waitFor(() => log.includes('edge-workers ready='))
		const home = await request(`https://127.0.0.1:${httpsPort}/`)
		const health = await request(`https://127.0.0.1:${httpsPort}/healthz`)
		const missing = await request(`https://127.0.0.1:${httpsPort}/rpc`)
		const challenge = await text(`http://127.0.0.1:${httpPort}/.well-known/acme-challenge/token-ok`)
		const escaped = await text(`http://127.0.0.1:${httpPort}/.well-known/acme-challenge/..%2Findex.html`)
		assert.equal(home.status, 200)
		assert.equal(home.body, 'dle.conet.network\n')
		assert.equal(home.headers['x-edge-worker'], undefined)
		assert.equal(health.body, 'ok\n')
		assert.equal(health.headers['x-edge-worker'], undefined)
		assert.equal(missing.status, 404)
		assert.equal(challenge, 'challenge-body')
		assert.match(escaped, /not found/)
		const firstPids = pidsFrom(log)
		const bad = path.join(store, 'versions', 'bad')
		mkdirSync(bad)
		writeFileSync(path.join(bad, 'fullchain.pem'), readFileSync(path.join(second, 'cert.pem')))
		writeFileSync(path.join(bad, 'privkey.pem'), readFileSync(path.join(first, 'key.pem')))
		switchCurrent(store, 'bad')
		await waitFor(() => log.includes('edge-reload skipped reason=cert-key-mismatch'), 4000)
		assert.deepEqual(await livePids(child.pid), firstPids)
		const good = path.join(store, 'versions', 'b')
		mkdirSync(good)
		writeFileSync(path.join(good, 'fullchain.pem'), readFileSync(path.join(second, 'cert.pem')))
		writeFileSync(path.join(good, 'privkey.pem'), readFileSync(path.join(second, 'key.pem')))
		switchCurrent(store, 'b')
		await waitFor(() => log.includes('edge-reload before='), 6000)
		const reloaded = await request(`https://127.0.0.1:${httpsPort}/healthz`)
		assert.equal(reloaded.body, 'ok\n')
		const match = log.match(/edge-reload before=([0-9,]+) after=([0-9,]+)/)
		assert.ok(match)
		assert.notEqual(match[1], match[2])
		const victim = Number(match[2].split(',')[0])
		process.kill(victim, 'SIGKILL')
		await waitFor(() => log.includes(`edge-worker replaced exited=${victim}`), 4000)
		assert.equal((await request(`https://127.0.0.1:${httpsPort}/healthz`)).status, 200)
		child.kill('SIGTERM')
		const code = await new Promise((resolve) => child.once('exit', resolve))
		assert.equal(code, 0)
	} finally {
		if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
	}
})

function switchCurrent(store, name) {
	const next = path.join(store, `current.${name}`)
	symlinkSync(path.join('versions', name), next)
	rmSync(path.join(store, 'current'))
	renameSync(next, path.join(store, 'current'))
}

function pidsFrom(log) {
	const line = log.match(/edge-workers ready=([0-9,]+)/)
	assert.ok(line)
	return line[1].split(',').map(Number).sort((a, b) => a - b)
}

function livePids(parent) {
	return new Promise((resolve, reject) => {
		const child = spawn('ps', ['-ax', '-o', 'pid=,ppid='])
		let out = ''
		let err = ''
		child.stdout.on('data', (chunk) => { out += chunk })
		child.stderr.on('data', (chunk) => { err += chunk })
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== 0) {
				reject(new Error(`ps ${code} ${err.trim()}`))
				return
			}
			const pids = []
			for (const line of out.trim().split('\n')) {
				const [pid, ppid] = line.trim().split(/\s+/).map(Number)
				if (ppid === parent) pids.push(pid)
			}
			resolve(pids.sort((a, b) => a - b))
		})
	})
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			server.close(() => resolve(port))
		})
		server.on('error', reject)
	})
}

function request(url) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { rejectUnauthorized: false }, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
		})
		req.on('error', reject)
	})
}

function text(url) {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => resolve(Buffer.concat(chunks).toString()))
		}).on('error', reject)
	})
}

async function waitFor(check, ms = 3000) {
	const start = Date.now()
	while (Date.now() - start < ms) {
		if (check()) return
		await new Promise((resolve) => setTimeout(resolve, 40))
	}
	throw new Error('timed out')
}

void makeCert
void realPair
void publish
