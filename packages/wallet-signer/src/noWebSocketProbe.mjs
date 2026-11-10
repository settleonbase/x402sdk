/**
 * Offline WebSocket-ban probe. Compiles the guard with typescript.transpileModule,
 * loads it through Module._compile, and never listens or dials.
 *
 * The WIP hash 4e66e94ce6a93eaa5c526b5446fd024baeb1ac271260af9b43043e13039625ff
 * is not a pass. This file fails if either guard copy still has that hash.
 *
 * Covered here: object Upgrade headers, Node's flat header array, the global
 * WebSocket constructor, and http.createServer inbound upgrade.
 * Not covered: browsers, chain nodes, the rest of the repository, http2.
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const Module = require('node:module')
const ts = require('typescript')
const http = require('node:http')
const https = require('node:https')

const self = fileURLToPath(import.meta.url)
const worktree = path.resolve(path.dirname(self), '../../..')
const signerGuard = path.join(worktree, 'packages/wallet-signer/src/noWebSocket.ts')
const oracleGuard = path.join(worktree, 'packages/conet-oracle-daemon/src/noWebSocket.ts')
const WIP_SHA256 = '4e66e94ce6a93eaa5c526b5446fd024baeb1ac271260af9b43043e13039625ff'
const CASES = ['all', 'object-header', 'flat-header', 'global-ctor', 'inbound-upgrade']
const FLAT_HEADERS = ['Upgrade', 'websocket', 'Connection', 'Upgrade']

function sha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function assertRejected(fn, label) {
	try {
		fn()
	} catch (error) {
		if (error && error.name === 'WebSocketDisabled') return
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`${label}: expected WebSocketDisabled, got ${message}`)
	}
	throw new Error(`${label}: expected WebSocketDisabled, but the call returned`)
}

function compileGuard(tsPath) {
	const source = fs.readFileSync(tsPath, 'utf8')
	const js = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: tsPath,
	}).outputText
	if (/\beval\s*\(/.test(js) || /\bnew\s+Function\s*\(/.test(js)) {
		throw new Error('compiled guard uses eval or new Function')
	}
	const filename = path.join(path.dirname(tsPath), '.noWebSocket.probe-compile.cjs')
	const compiled = new Module(filename)
	compiled.filename = filename
	compiled.paths = Module._nodeModulePaths(path.dirname(tsPath))
	compiled._compile(js, filename)
	return filename
}

function installCountingStubs() {
	let stubCalls = 0
	const stub = (name) =>
		function countingStub() {
			stubCalls += 1
			throw new Error(`underlying ${name} was called`)
		}
	http.request = stub('http.request')
	http.get = stub('http.get')
	https.request = stub('https.request')
	https.get = stub('https.get')
	return {
		get stubCalls() {
			return stubCalls
		},
	}
}

function runCase(which) {
	const signerSha = sha256(signerGuard)
	const oracleSha = sha256(oracleGuard)
	console.log(`signer_sha256=${signerSha}`)
	console.log(`oracle_sha256=${oracleSha}`)
	if (signerSha !== oracleSha) throw new Error('signer and oracle noWebSocket.ts differ')
	if (signerSha === WIP_SHA256 || oracleSha === WIP_SHA256) throw new Error('guard is still the WIP hash')
	console.log('files_identical=yes')
	console.log('wip_sha_rejected=yes')

	const counter = installCountingStubs()
	const compiled = compileGuard(signerGuard)
	console.log(`compiled=${compiled}`)
	console.log(`case=${which}`)

	const checks = {
		'object-header': () => {
			const before = counter.stubCalls
			assertRejected(
				() => http.request({ host: '127.0.0.1', port: 9, method: 'GET', headers: { Upgrade: 'websocket' } }),
				'http.request object headers',
			)
			assertRejected(
				() => http.get({ host: '127.0.0.1', port: 9, headers: { Upgrade: 'websocket' } }),
				'http.get object headers',
			)
			if (counter.stubCalls !== before) throw new Error(`object headers called the stub ${counter.stubCalls - before} time(s)`)
		},
		'flat-header': () => {
			const before = counter.stubCalls
			assertRejected(
				() => http.request({ host: '127.0.0.1', port: 9, method: 'GET', headers: FLAT_HEADERS }),
				'http.request flat headers',
			)
			assertRejected(
				() => http.get({ host: '127.0.0.1', port: 9, headers: FLAT_HEADERS }),
				'http.get flat headers',
			)
			if (counter.stubCalls !== before) throw new Error(`flat headers called the stub ${counter.stubCalls - before} time(s)`)
		},
		'global-ctor': () => {
			assertRejected(() => new WebSocket('ws://127.0.0.1:9'), 'global WebSocket')
		},
		'inbound-upgrade': () => {
			const server = http.createServer()
			let business = 0
			assertRejected(() => server.on('upgrade', () => {
				business += 1
			}), 'createServer on(upgrade)')
			if (server.listenerCount('upgrade') !== 0) throw new Error('upgrade listener was registered')
			if (server.listening) throw new Error('createServer listened')
			const socket = { destroyed: false, destroy() { this.destroyed = true } }
			assertRejected(
				() => server.emit('upgrade', { headers: { upgrade: 'websocket' } }, socket, Buffer.alloc(0)),
				'createServer emit(upgrade)',
			)
			if (business !== 0) throw new Error('inbound upgrade reached the business handler')
			if (server.listening) throw new Error('inbound upgrade opened a listen')
			const httpsServer = https.createServer()
			let httpsBusiness = 0
			assertRejected(() => httpsServer.on('upgrade', () => {
				httpsBusiness += 1
			}), 'https.createServer on(upgrade)')
			assertRejected(
				() => httpsServer.emit('upgrade', { headers: { upgrade: 'websocket' } }, { destroy() {} }, Buffer.alloc(0)),
				'https.createServer emit(upgrade)',
			)
			if (httpsBusiness !== 0) throw new Error('https inbound upgrade reached the business handler')
			if (httpsServer.listening) throw new Error('https.createServer listened')
		},
	}
	const selected = which === 'all' ? ['object-header', 'flat-header', 'global-ctor', 'inbound-upgrade'] : [which]
	for (const name of selected) checks[name]()
	if (counter.stubCalls !== 0) throw new Error(`stub_calls=${counter.stubCalls}`)
	console.log('stub_calls=0')
	console.log('REAL_NETWORK_CALLS=0')
	console.log('listening=false')
	console.log('result=rejected')
	console.log('not_covered=browsers,chain-nodes,rest-of-repo,http2')
}

function isTestRunner() {
	return process.execArgv.includes('--test')
}

if (!isTestRunner()) {
	const which = process.argv[2] ?? 'all'
	if (!CASES.includes(which)) {
		console.error(`usage: node noWebSocketProbe.mjs [${CASES.join('|')}]`)
		process.exit(2)
	}
	try {
		runCase(which)
	} catch (error) {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error))
		process.exit(1)
	}
	process.exit(0)
}

for (const name of ['object-header', 'flat-header', 'global-ctor', 'inbound-upgrade']) {
	test(name, () => {
		const result = spawnSync(process.execPath, [self, name], { encoding: 'utf8' })
		if (result.status !== 0) {
			throw new Error(`exit ${result.status}\n${result.stdout}\n${result.stderr}`)
		}
		if (!result.stdout.includes('stub_calls=0') || !result.stdout.includes('REAL_NETWORK_CALLS=0')) {
			throw new Error(result.stdout)
		}
	})
}
