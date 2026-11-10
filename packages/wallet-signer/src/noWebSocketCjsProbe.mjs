/**
 * Reproduces CJS require("ws") against the compiled guard.
 *
 * The child is started as:
 *   node --disable-sigusr1 --disallow-code-generation-from-strings --require <dist>/noWebSocket.js this-file --child
 * It stubs net listen/connect, then requires the installed ws package and constructs
 * WebSocketServer({ noServer: true }), the default client, and the named client.
 * Those must throw before any transport call.
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const packageDir = path.resolve(path.dirname(self), '..')
const require = createRequire(self)

function runChild() {
	const net = require('node:net')
	let transportCalls = 0
	const stub = (name) =>
		function transportStub() {
			transportCalls += 1
			const error = new Error(`transport ${name}`)
			error.name = 'TransportStub'
			throw error
		}
	net.Server.prototype.listen = stub('listen')
	net.Socket.prototype.connect = stub('connect')

	const ws = require('ws')
	let accepted = false
	const attempts = [
		['CJS_WS_SERVER_CONSTRUCTOR', () => new ws.WebSocketServer({ noServer: true })],
		['CJS_WS_DEFAULT_CONSTRUCTOR', () => new ws('ws://127.0.0.1:9')],
		['CJS_WS_NAMED_CLIENT_CONSTRUCTOR', () => new ws.WebSocket('ws://127.0.0.1:9')],
	]
	for (const [label, construct] of attempts) {
		try {
			const created = construct()
			if (created && typeof created.close === 'function') created.close()
			accepted = true
			console.log(`${label}=ACCEPTED`)
		} catch (error) {
			if (!error || error.name !== 'WebSocketDisabled') throw error
			console.log(`${label}=REJECTED`)
		}
	}
	console.log(`TRANSPORT_CALLS=${transportCalls}`)
	console.log('REAL_NETWORK_CALLS=0')
	if (accepted || transportCalls !== 0) process.exitCode = 1
}

function runParent() {
	const guards = [
		['signer', path.join(packageDir, 'dist/src/noWebSocket.js')],
		['oracle', path.join(packageDir, '../conet-oracle-daemon/dist/src/noWebSocket.js')],
	]
	let failed = false
	for (const [name, guard] of guards) {
		if (!fs.existsSync(guard)) {
			console.error(`${name} guard missing: ${guard}`)
			failed = true
			continue
		}
		console.log(`require=${guard}`)
		const result = spawnSync(
			process.execPath,
			['--disable-sigusr1', '--disallow-code-generation-from-strings', '--require', guard, self, '--child'],
			{ cwd: packageDir, encoding: 'utf8' },
		)
		process.stdout.write(result.stdout)
		process.stderr.write(result.stderr)
		console.log(`${name}_exit=${result.status}`)
		const serverRejected = result.stdout.includes('CJS_WS_SERVER_CONSTRUCTOR=REJECTED')
		const transportClear = result.stdout.includes('TRANSPORT_CALLS=0') && result.stdout.includes('REAL_NETWORK_CALLS=0')
		const notAccepted = !result.stdout.includes('=ACCEPTED')
		if (result.status !== 0 || !serverRejected || !transportClear || !notAccepted) failed = true
	}
	process.exit(failed ? 1 : 0)
}

if (process.argv.includes('--child')) {
	runChild()
} else {
	runParent()
}
