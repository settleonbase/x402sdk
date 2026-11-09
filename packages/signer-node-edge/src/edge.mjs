import cluster from 'node:cluster'
import { X509Certificate, createHash, createPrivateKey } from 'node:crypto'
import { readFileSync, writeSync, promises as fs } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import tls from 'node:tls'

const FORBIDDEN_PREFIXES = [
	'/opt/wallet-signer',
	'/srv/secure',
	'/etc/wallet-signer',
	'/run/wallet-signer',
	'/run/wallet-signer-rpc',
	'/run/wallet-signer-oracle',
]

const BUILTIN_INDEX = 'dle.conet.network\n'
const MAX_INDEX_BYTES = 64 * 1024
const MAX_ACME_BYTES = 64 * 1024
const ACME_NAME = /^[A-Za-z0-9_-]{1,128}$/

function emit(line) {
	writeSync(1, line)
}

export function loadConfig(env = process.env) {
	const httpsPort = Number(env.SIGNER_EDGE_HTTPS_PORT)
	const httpPort = env.SIGNER_EDGE_HTTP_PORT ? Number(env.SIGNER_EDGE_HTTP_PORT) : 0
	const workers = Number(env.SIGNER_EDGE_WORKERS || 2)
	const pollMs = Number(env.SIGNER_EDGE_CERT_POLL_MS || 5000)
	const cert = env.SIGNER_EDGE_CERT || ''
	const key = env.SIGNER_EDGE_KEY || ''
	const indexFile = env.SIGNER_EDGE_INDEX || ''
	const acmeDir = env.SIGNER_EDGE_ACME_DIR || ''
	const bind = env.SIGNER_EDGE_BIND || '127.0.0.1'
	if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) {
		throw new Error('SIGNER_EDGE_HTTPS_PORT must be 1-65535')
	}
	if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
		throw new Error('SIGNER_EDGE_HTTP_PORT must be 0-65535')
	}
	if (httpPort !== 0 && httpPort === httpsPort) throw new Error('HTTP and HTTPS ports must differ')
	if (!Number.isInteger(workers) || workers < 1 || workers > 16) throw new Error('SIGNER_EDGE_WORKERS must be 1-16')
	if (!Number.isInteger(pollMs) || pollMs < 200 || pollMs > 300_000) throw new Error('SIGNER_EDGE_CERT_POLL_MS out of range')
	if (!cert || !key) throw new Error('SIGNER_EDGE_CERT and SIGNER_EDGE_KEY are required')
	assertOutsideSigner('SIGNER_EDGE_CERT', cert)
	assertOutsideSigner('SIGNER_EDGE_KEY', key)
	if (indexFile) assertOutsideSigner('SIGNER_EDGE_INDEX', indexFile)
	if (acmeDir) assertOutsideSigner('SIGNER_EDGE_ACME_DIR', acmeDir)
	return { httpsPort, httpPort, workers, pollMs, cert, key, indexFile, acmeDir, bind }
}

function assertOutsideSigner(label, filePath) {
	const resolved = path.resolve(filePath)
	for (const prefix of FORBIDDEN_PREFIXES) {
		if (resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`)) {
			throw new Error(`${label} must not point inside ${prefix}`)
		}
	}
}

function delay(ms, state) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			state.wake = null
			resolve()
		}, ms)
		state.wake = () => {
			clearTimeout(timer)
			state.wake = null
			resolve()
		}
	})
}

function liveWorkers() {
	return Object.values(cluster.workers).filter((worker) => worker && !worker.isDead())
}

function loadCandidate(cfg) {
	let cert
	let key
	try {
		cert = readFileSync(cfg.cert)
		key = readFileSync(cfg.key)
	} catch {
		return { ok: false, reason: 'unreadable', hash: '' }
	}
	const hash = createHash('sha256').update(cert).update('\0').update(key).digest('hex')
	try {
		const parsed = new X509Certificate(cert)
		if (!certificateMatchesKey(parsed, key)) return { ok: false, reason: 'cert-key-mismatch', hash }
		tls.createSecureContext({ cert, key, minVersion: 'TLSv1.2' })
	} catch {
		return { ok: false, reason: 'invalid-cert', hash }
	}
	return { ok: true, cert, key, hash }
}

function certificateMatchesKey(parsed, keyPem) {
	const keyObject = createPrivateKey(keyPem)
	return parsed.checkPrivateKey(keyObject) === true
}

function sendMaterial(worker, material) {
	worker.send({
		type: 'tls',
		cert: material.cert.toString('base64'),
		key: material.key.toString('base64'),
	})
}

export async function startPrimary(cfg) {
	cluster.schedulingPolicy = cluster.SCHED_RR
	const initial = loadCandidate(cfg)
	if (!initial.ok) {
		process.stderr.write(`signer-node-edge refused to start: ${initial.reason}\n`)
		process.exit(1)
	}
	const holder = { material: initial }
	const state = {
		shuttingDown: false,
		exitCode: 0,
		wake: null,
		rolling: false,
		announced: false,
		rejectedHash: '',
		holder,
	}
	const forkOne = (material) => {
		const worker = cluster.fork()
		worker.sawReady = false
		worker.retiring = false
		worker.replaces = 0
		worker.on('online', () => sendMaterial(worker, material))
		worker.on('message', (msg) => {
			if (msg?.type === 'need-tls') sendMaterial(worker, material)
			if (msg?.type === 'ready') {
				worker.sawReady = true
				noteInitialReady(state, cfg)
				if (worker.replaces) {
					emit(`edge-worker replaced exited=${worker.replaces} ready=${worker.process.pid}\n`)
				}
			}
		})
		return worker
	}
	state.forkOne = forkOne
	cluster.on('exit', (worker, code) => {
		if (state.shuttingDown) {
			if (liveWorkers().length === 0) process.exit(state.exitCode)
			return
		}
		if (worker.retiring) return
		if (!worker.sawReady) {
			if (!state.rolling && liveWorkers().length === 0) shutdown(state, code === 0 ? 1 : code || 1)
			return
		}
		if (state.rolling) return
		const neu = forkOne(holder.material)
		neu.replaces = worker.process.pid
	})
	for (let i = 0; i < cfg.workers; i += 1) forkOne(holder.material)
	process.on('SIGTERM', () => shutdown(state, 0))
	process.on('SIGINT', () => shutdown(state, 0))
	process.on('SIGHUP', () => {
		void considerReload(cfg, state)
	})
	void pollCertificates(cfg, state)
	emit(`signer-node-edge primary pid=${process.pid} workers=${cfg.workers} https=${cfg.bind}:${cfg.httpsPort} http=${cfg.httpPort || 'off'}\n`)
}

function noteInitialReady(state, cfg) {
	if (state.announced || state.rolling) return
	const ready = liveWorkers().filter((worker) => worker.sawReady && !worker.retiring)
	if (ready.length < cfg.workers) return
	state.announced = true
	emit(`edge-workers ready=${ready.map((worker) => worker.process.pid).join(',')}\n`)
}

function shutdown(state, code) {
	if (state.shuttingDown) return
	state.shuttingDown = true
	state.exitCode = code
	state.wake?.()
	const workers = liveWorkers()
	if (workers.length === 0) process.exit(code)
	const timer = setTimeout(() => process.exit(code), 4000)
	timer.unref()
	for (const worker of workers) {
		worker.retiring = true
		try {
			worker.process.kill('SIGTERM')
		} catch {
			/* already gone */
		}
	}
}

async function pollCertificates(cfg, state) {
	while (!state.shuttingDown) {
		await considerReload(cfg, state)
		if (state.shuttingDown) return
		await delay(cfg.pollMs, state)
	}
}

async function considerReload(cfg, state) {
	if (state.shuttingDown || state.rolling) return
	const next = loadCandidate(cfg)
	if (!next.hash || next.hash === state.holder.material.hash || next.hash === state.rejectedHash) return
	if (!next.ok) {
		state.rejectedHash = next.hash
		emit(`edge-reload skipped reason=${next.reason}\n`)
		return
	}
	await roll(state, next)
}

async function roll(state, next) {
	if (state.rolling || state.shuttingDown) return
	state.rolling = true
	const oldOnes = liveWorkers().filter((worker) => worker.sawReady && !worker.retiring)
	const before = oldOnes.map((worker) => worker.process.pid)
	const after = []
	try {
		for (const old of oldOnes) {
			if (state.shuttingDown) return
			const neu = state.forkOne(next)
			const ready = await waitReady(neu, 5000)
			if (!ready || state.shuttingDown) {
				neu.retiring = true
				try { neu.process.kill('SIGTERM') } catch { /* already gone */ }
				const kept = liveWorkers().filter((worker) => worker.sawReady && !worker.retiring).map((worker) => worker.process.pid)
				emit(`edge-reload skipped reason=replacement-not-ready before=${before.join(',')} kept=${kept.join(',')}\n`)
				return
			}
			after.push(neu.process.pid)
			old.retiring = true
			await retire(old)
		}
		state.holder.material = next
		state.rejectedHash = ''
		emit(`edge-reload before=${before.join(',')} after=${after.join(',')}\n`)
	} finally {
		state.rolling = false
	}
}

function waitReady(worker, ms) {
	if (worker.sawReady) return Promise.resolve(true)
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms)
		const onMessage = (msg) => {
			if (msg?.type !== 'ready') return
			clearTimeout(timer)
			worker.off('message', onMessage)
			resolve(true)
		}
		worker.on('message', onMessage)
		worker.once('exit', () => {
			clearTimeout(timer)
			worker.off('message', onMessage)
			resolve(false)
		})
	})
}

function retire(worker) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			try { worker.process.kill('SIGKILL') } catch { /* already gone */ }
		}, 3000)
		worker.once('exit', () => {
			clearTimeout(timer)
			resolve()
		})
		try {
			worker.process.kill('SIGTERM')
		} catch {
			clearTimeout(timer)
			resolve()
		}
	})
}

function waitForMaterial() {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('tls material timeout')), 5000)
		process.on('message', (msg) => {
			if (msg?.type !== 'tls') return
			clearTimeout(timer)
			resolve({
				cert: Buffer.from(msg.cert, 'base64'),
				key: Buffer.from(msg.key, 'base64'),
			})
		})
		process.send?.({ type: 'need-tls' })
	})
}

export function startWorker(cfg) {
	waitForMaterial().then((pair) => {
		const context = tls.createSecureContext({ cert: pair.cert, key: pair.key, minVersion: 'TLSv1.2' })
		const httpsServer = https.createServer({
			SNICallback: (_host, cb) => cb(null, context),
			cert: pair.cert,
			key: pair.key,
			minVersion: 'TLSv1.2',
		}, (req, res) => {
			void handleHttps(cfg, req, res)
		})
		bindWorker(cfg, httpsServer)
	}, (err) => {
		process.stderr.write(`signer-node-edge worker failed: ${err.message}\n`)
		process.exit(1)
	})
}

function bindWorker(cfg, httpsServer) {
	let httpServer = null
	const listening = [listen(httpsServer, cfg.httpsPort, cfg.bind)]
	if (cfg.httpPort) {
		httpServer = http.createServer((req, res) => {
			void handleHttp(cfg, req, res)
		})
		listening.push(listen(httpServer, cfg.httpPort, cfg.bind))
	}
	Promise.all(listening).then(() => {
		process.send?.({ type: 'ready', pid: process.pid })
	}, (err) => {
		process.stderr.write(`signer-node-edge worker failed: ${err.code || err.message}\n`)
		process.exit(1)
	})
	let closing = false
	const closeAll = () => {
		if (closing) return
		closing = true
		const timer = setTimeout(() => process.exit(0), 3000)
		timer.unref()
		let pending = 1 + (httpServer ? 1 : 0)
		const done = () => {
			pending -= 1
			if (pending <= 0) process.exit(0)
		}
		httpsServer.close(done)
		httpServer?.close(done)
	}
	process.on('SIGTERM', closeAll)
	process.on('SIGINT', closeAll)
	process.on('SIGHUP', () => {})
}

function listen(server, port, host) {
	return new Promise((resolve, reject) => {
		const onError = (err) => {
			server.off('listening', onListening)
			reject(err)
		}
		const onListening = () => {
			server.off('error', onError)
			resolve()
		}
		server.once('error', onError)
		server.once('listening', onListening)
		server.listen(port, host)
	})
}

async function handleHttps(cfg, req, res) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		send(res, 404, 'not found\n', req.method)
		return
	}
	const pathname = pathnameOf(req.url)
	if (pathname === '/healthz') {
		send(res, 200, 'ok\n', req.method)
		return
	}
	if (pathname === '/') {
		const body = await indexBody(cfg)
		if (body == null) {
			send(res, 404, 'not found\n', req.method)
			return
		}
		send(res, 200, body, req.method, 'text/html; charset=utf-8')
		return
	}
	send(res, 404, 'not found\n', req.method)
}

async function handleHttp(cfg, req, res) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		send(res, 404, 'not found\n', req.method)
		return
	}
	const pathname = pathnameOf(req.url)
	const token = pathname.match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{1,128})$/)
	if (!token || !cfg.acmeDir || !ACME_NAME.test(token[1])) {
		send(res, 404, 'not found\n', req.method)
		return
	}
	const body = await acmeBody(cfg.acmeDir, token[1])
	if (body == null) {
		send(res, 404, 'not found\n', req.method)
		return
	}
	send(res, 200, body, req.method)
}

function pathnameOf(url) {
	const raw = String(url || '/').split('?')[0] || '/'
	try {
		const decoded = decodeURIComponent(raw)
		if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return '/__invalid'
		return decoded === '' ? '/' : decoded
	} catch {
		return '/__invalid'
	}
}

async function indexBody(cfg) {
	if (!cfg.indexFile) return BUILTIN_INDEX
	try {
		const stat = await fs.stat(cfg.indexFile)
		if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return null
		return await fs.readFile(cfg.indexFile)
	} catch {
		return null
	}
}

async function acmeBody(dir, name) {
	try {
		const root = await fs.realpath(dir)
		const rootStat = await fs.stat(root)
		if (!rootStat.isDirectory()) return null
		const candidate = path.join(root, name)
		const real = await fs.realpath(candidate)
		if (path.dirname(real) !== root) return null
		const stat = await fs.stat(real)
		if (!stat.isFile() || stat.size > MAX_ACME_BYTES) return null
		return await fs.readFile(real)
	} catch {
		return null
	}
}

function send(res, status, body, method, type = 'text/plain; charset=utf-8') {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body)
	res.writeHead(status, {
		'Content-Type': type,
		'Content-Length': payload.length,
		Connection: 'close',
		'Cache-Control': 'no-store',
	})
	res.end(method === 'HEAD' ? undefined : payload)
}

function main() {
	let cfg
	try {
		cfg = loadConfig()
	} catch (err) {
		process.stderr.write(`${err.message}\n`)
		process.exit(1)
	}
	if (cluster.isPrimary) startPrimary(cfg)
	else startWorker(cfg)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) main()
