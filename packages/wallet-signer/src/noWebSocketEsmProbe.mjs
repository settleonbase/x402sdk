/**
 * Reproduces dynamic ESM import("ws") against the compiled guard.
 *
 * The child is started as:
 *   node --disable-sigusr1 --disallow-code-generation-from-strings --require <dist>/noWebSocket.js this-file --child
 * It stubs net listen/connect, then imports the ws ESM entry and constructs the
 * default export, the named client, and WebSocketServer({ noServer: true }).
 * Those must throw before any transport call. CJS require("ws") is not this probe.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const packageDir = path.resolve(path.dirname(self), '..')

async function runChild() {
	const net = await import('node:net')
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

	const imported = await import('ws')
	let accepted = false
	const attempts = [
		['ESM_WS_SERVER_CONSTRUCTOR', () => new imported.WebSocketServer({ noServer: true })],
		['ESM_WS_DEFAULT_CONSTRUCTOR', () => new imported.default('ws://127.0.0.1:9')],
		['ESM_WS_NAMED_CLIENT_CONSTRUCTOR', () => new imported.WebSocket('ws://127.0.0.1:9')],
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
		const serverRejected = result.stdout.includes('ESM_WS_SERVER_CONSTRUCTOR=REJECTED')
		const transportClear = result.stdout.includes('TRANSPORT_CALLS=0') && result.stdout.includes('REAL_NETWORK_CALLS=0')
		const notAccepted = !result.stdout.includes('=ACCEPTED')
		if (result.status !== 0 || !serverRejected || !transportClear || !notAccepted) failed = true
	}
	process.exit(failed ? 1 : 0)
}

if (process.argv.includes('--child')) {
	await runChild()
} else {
	runParent()
}
