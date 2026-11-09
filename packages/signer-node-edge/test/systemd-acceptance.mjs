import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import tls from 'node:tls'

const port = Number(process.env.EDGE_HTTPS_PORT || 0)
const unit = process.env.EDGE_UNIT || ''
const store = process.env.EDGE_STORE || ''
const templatePath = process.env.EDGE_TEMPLATE || ''
const installedPath = process.env.EDGE_INSTALLED_UNIT || ''
const hookPath = process.env.EDGE_HOOK || ''
const lineage = process.env.EDGE_LINEAGE || ''
const bind = process.env.EDGE_BIND || '127.0.0.1'
if (!unit.startsWith('signer-edge-isolate-') || port !== 443 || !store || !templatePath || !installedPath || !hookPath || !lineage) {
	console.error('systemd-acceptance requires the publish-template sandbox environment')
	process.exit(2)
}

const report = { kind: 'publish-template-equivalent', steps: [] }
function step(name, ok, extra = {}) {
	report.steps.push({ name, ok, ...extra })
	console.log(`STEP ${name} ${ok ? 'PASS' : 'FAIL'}`)
	if (!ok) {
		console.log(JSON.stringify(report))
		process.exit(1)
	}
}

function show(prop) {
	return execFileSync('systemctl', ['show', unit, `-p${prop}`, '--value'], { encoding: 'utf8' }).trim()
}

function journal() {
	return execFileSync('journalctl', ['-u', unit, '-o', 'cat', '--no-pager'], { encoding: 'utf8' })
}

const PROBE_MS = 2000

function request(path, timeoutMs = PROBE_MS) {
	return new Promise((resolve, reject) => {
		let settled = false
		const req = https.request({
			host: bind,
			port,
			path,
			servername: bind,
			rejectUnauthorized: false,
			agent: false,
			headers: { Connection: 'close' },
		}, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => finish(resolve, {
				status: res.statusCode,
				headers: res.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			}))
			res.on('error', (err) => finish(reject, err))
		})
		const timer = setTimeout(() => finish(reject, new Error(`https ${path} timed out after ${timeoutMs}ms`)), timeoutMs)
		const finish = (fn, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			req.destroy()
			fn(value)
		}
		req.once('error', (err) => finish(reject, err))
		req.end()
	})
}

function fingerprint(timeoutMs = PROBE_MS) {
	return new Promise((resolve, reject) => {
		let settled = false
		const socket = tls.connect({ host: bind, port, servername: bind, rejectUnauthorized: false })
		const timer = setTimeout(() => finish(reject, new Error(`tls timed out after ${timeoutMs}ms`)), timeoutMs)
		const finish = (fn, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			socket.destroy()
			fn(value)
		}
		socket.once('secureConnect', () => {
			const cert = socket.getPeerCertificate()
			finish(resolve, String(cert.fingerprint256 || '').toUpperCase())
		})
		socket.once('error', (err) => finish(reject, err))
	})
}

function expectedFingerprint(file) {
	const text = execFileSync('openssl', ['x509', '-in', file, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' })
	return text.split('=').pop().trim().toUpperCase()
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	let last
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now())
		try {
			const value = await Promise.race([
				Promise.resolve().then(check),
				new Promise((_, reject) => {
					setTimeout(() => reject(new Error(`probe wait timed out after ${remaining}ms`)), remaining)
				}),
			])
			if (value) return value
		} catch (err) {
			last = err
		}
		if (Date.now() >= deadline) break
		await sleep(Math.min(80, deadline - Date.now()))
	}
	throw last || new Error('timed out')
}

function inaccessibleTokens(text) {
	const line = text.split('\n').find((row) => row.startsWith('InaccessiblePaths='))
	if (!line) return []
	return line.slice('InaccessiblePaths='.length).trim().split(/\s+/).filter(Boolean)
}

function assertTemplate(text, label) {
	const tokens = inaccessibleTokens(text)
	const optional = tokens.length > 0 && tokens.every((token) => token.startsWith('-/'))
	const forbidden = ['RuntimeDirectory=', 'SIGNER_EDGE_HTTP_PORT', 'SIGNER_EDGE_WEBROOT', '/var/www/dle', 'systemctl kill']
	const hit = forbidden.filter((needle) => text.includes(needle))
	step(`${label}-443-only`, text.includes('SIGNER_EDGE_HTTPS_PORT=443') && hit.length === 0, { hit })
	step(`${label}-optional-inaccessible`, optional, { tokens })
}

function modeOf(file) {
	return fs.statSync(file).mode & 0o777
}

function rootOwned(file) {
	const stat = fs.statSync(file)
	return stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o022) === 0
}

function childPids(parent) {
	const out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' })
	const pids = []
	for (const line of out.trim().split('\n')) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number)
		if (ppid === parent) pids.push(pid)
	}
	return pids.sort((a, b) => a - b)
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return err.code !== 'ESRCH'
	}
}

function runHook(certName, keyName) {
	fs.copyFileSync(`${lineage}/${certName}`, `${lineage}/fullchain.pem`)
	fs.copyFileSync(`${lineage}/${keyName}`, `${lineage}/privkey.pem`)
	execFileSync(hookPath, {
		env: {
			...process.env,
			RENEWED_LINEAGE: lineage,
			SIGNER_EDGE_CERT_STORE: store,
			SIGNER_EDGE_RENEW_LINEAGE: lineage,
		},
		stdio: 'inherit',
	})
}

const template = fs.readFileSync(templatePath, 'utf8')
const installed = fs.readFileSync(installedPath, 'utf8')
const hook = fs.readFileSync(hookPath, 'utf8')
assertTemplate(template, 'template')
assertTemplate(installed, 'installed-unit')
step('hook-no-cgroup-kill', !hook.includes('systemctl') && hook.includes('mv -Tf') && !hook.includes('nginx'), {})
step('installed-from-template', installed.includes('ProtectSystem=strict') && installed.includes('CapabilityBoundingSet=CAP_NET_BIND_SERVICE') && installed.includes('NoNewPrivileges=yes'), {})

const active = show('ActiveState')
const user = show('User')
const mainPid = Number(show('MainPID'))
const bound = show('CapabilityBoundingSet')
step('systemd-active', active === 'active' && user === 'signer-edge' && mainPid > 0, { active, user, mainPid, bound })
step('bind-capability-only', bound.toLowerCase() === 'cap_net_bind_service', { bound })
const procUser = execFileSync('ps', ['-o', 'user=', '-p', String(mainPid)], { encoding: 'utf8' }).trim()
step('main-pid-user', procUser === 'signer-edge', { procUser })

const readyLog = await waitFor(async () => {
	const text = journal()
	return text.includes('edge-workers ready=') && text.includes('http=off') ? text : null
}, 8000).catch((err) => {
	throw new Error(`${err.message}\n${journal()}\n${execFileSync('ss', ['-ltnp'], { encoding: 'utf8' })}`)
})
const listeners = execFileSync('ss', ['-H', '-ltn'], { encoding: 'utf8' })
const listens443 = listeners.split('\n').some((line) => line.includes(`${bind}:443`))
const listens80 = listeners.split('\n').some((line) => /(?:^|\s)(?:\*|0\.0\.0\.0|\[::\]|127\.0\.0\.1):80\s/.test(line))
step('listen-443-only', listens443 && !listens80, { listens443, listens80, listeners })
const ready = readyLog.match(/edge-workers ready=([0-9,]+)/)
const before = ready[1].split(',').map(Number)
step('journal-initial-pids', before.length === 2 && before.every((pid) => pid !== mainPid && pidAlive(pid)), { before, mainPid })

const home = await request('/')
const health = await request('/healthz')
const missing = await request('/rpc')
step('fixed-routes-no-worker-header', home.status === 200 && home.body === 'dle.conet.network\n' && health.status === 200 && health.body === 'ok\n' && missing.status === 404 && home.headers['x-edge-worker'] == null && health.headers['x-edge-worker'] == null, {
	home: home.status,
	health: health.status,
	missing: missing.status,
})

for (const dir of [store, `${store}/versions`, `${store}/versions/v1`]) {
	if (!rootOwned(dir) || modeOf(dir) !== 0o755) step('cert-parents-root-only', false, { dir, mode: modeOf(dir) })
}
const keyStat = fs.statSync(`${store}/current/privkey.pem`)
step('cert-parents-root-only', keyStat.uid === 0 && modeOf(`${store}/current/privkey.pem`) === 0o640, { keyMode: modeOf(`${store}/current/privkey.pem`) })

const ignored = execFileSync(hookPath, {
	env: { ...process.env, RENEWED_LINEAGE: `${lineage}-other`, SIGNER_EDGE_CERT_STORE: store, SIGNER_EDGE_RENEW_LINEAGE: lineage },
	encoding: 'utf8',
})
step('hook-ignores-other-lineage', fs.readlinkSync(`${store}/current`) === 'versions/v1', { ignored })

runHook('bad-cert.pem', 'a-key.pem')
const skipped = await waitFor(async () => {
	const probed = await request('/healthz')
	if (probed.status !== 200 || probed.headers['x-edge-worker'] != null) throw new Error('health changed during bad certificate')
	const text = journal()
	return text.includes('edge-reload skipped reason=cert-key-mismatch') ? text : null
}, 8000)
step('bad-cert-keeps-workers', before.every(pidAlive) && !skipped.includes('edge-reload before='), { before })

runHook('b-cert.pem', 'b-key.pem')
const reloaded = await waitFor(async () => {
	const probed = await request('/healthz')
	if (probed.status !== 200 || probed.body !== 'ok\n' || probed.headers['x-edge-worker'] != null) throw new Error('health changed during reload')
	const text = journal()
	const match = text.match(/edge-reload before=([0-9,]+) after=([0-9,]+)/)
	return match ? { text, before: match[1], after: match[2] } : null
}, 12000)
const after = reloaded.after.split(',').map(Number)
step('rolling-reload-journal-pids', reloaded.before === before.join(',') && after.length === 2 && after.every((pid) => !before.includes(pid) && pidAlive(pid)), {
	journalBefore: reloaded.before,
	journalAfter: reloaded.after,
})
const seen = await fingerprint()
step('reloaded-certificate', seen === expectedFingerprint(`${lineage}/b-cert.pem`), { seen })

const victim = after[0]
const kept = after[1]
process.kill(victim, 'SIGKILL')
let proof
try {
	proof = await waitFor(async () => {
		const text = journal()
		const match = text.match(new RegExp(`edge-worker replaced exited=${victim} ready=(\\d+)`))
		if (!match) return null
		const readyPid = Number(match[1])
		if (!readyPid || readyPid === victim || readyPid === kept || readyPid === mainPid) return null
		if (pidAlive(victim) || !pidAlive(kept) || !pidAlive(readyPid)) return null
		if (Number(show('MainPID')) !== mainPid) return null
		return { readyPid }
	}, 8000)
} catch (err) {
	const text = journal()
	console.log('RESPAWN_JOURNAL_MISSING')
	console.log(text)
	step('worker-respawn-journal', false, { reason: 'journal-missing-ready', error: String(err.message || err) })
}
let probed
try {
	probed = await request('/healthz')
} catch (err) {
	console.log(journal())
	step('worker-respawn-journal', false, {
		reason: 'health-timeout',
		error: String(err.message || err),
		exited: victim,
		kept,
		ready: proof.readyPid,
	})
}
const healthOk = probed.status === 200 && probed.body === 'ok\n' && probed.headers['x-edge-worker'] == null
step('worker-respawn-journal', healthOk && !pidAlive(victim) && pidAlive(kept) && pidAlive(proof.readyPid) && Number(show('MainPID')) === mainPid, {
	exited: victim,
	kept,
	ready: proof.readyPid,
	health: probed.status,
	mainPid,
})

execFileSync('systemctl', ['stop', unit], { stdio: 'ignore' })
const stopped = show('ActiveState')
const result = show('Result')
step('graceful-stop', stopped === 'inactive' && (result === 'success' || result === 'exit-code'), { stopped, result, status: show('ExecMainStatus') })
console.log(JSON.stringify(report))
