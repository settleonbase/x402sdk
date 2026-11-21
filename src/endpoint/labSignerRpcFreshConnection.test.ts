/**
 * Lab signer RPC transport: every call must use its own connection.
 *
 * Failure mode: between the first and the second signer_getAddress (the confirmation before the intent and the one
 * before the send) the daemon persists the intent. With a large pending set that write blocks the event loop for a
 * long time. The Node global agent (keepAlive on since Node 19) had kept the first connection; the signer closes idle
 * connections after the http.Server default keepAliveTimeout (5 s). With the loop blocked, neither the FIN nor the
 * agent's own idle timeout is processed, and the second call writes into the dead pooled connection:
 * "signer socket failed: write EPIPE", before the request reaches the signer.
 *
 * Local unix socket and a stub signer only. Never opens an external socket or host.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import {
	submitWithdrawBatchDurably,
	type LabInFlightWithdraw,
	type LabLifecycleDeps,
} from './labClPayoutBatchLifecycle'
import {
	LAB_MINING_POOL_FIXED,
	sendConfiguredLabWithdrawNative,
	verifyLabSignerBoundAddress,
} from './labMiningPoolPayoutSigner'

const LAB = '0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135'
const REDEEM = '0xc71e246DD78B37C2fABc905D340932F28F503433'
const HASH = `0x${'ab'.repeat(32)}`
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`

/** The real signer listener is a plain http.createServer: default keepAliveTimeout, 5 s. */
const STUB_KEEP_ALIVE_MS = 5000
/** Longer than the stub's timer: the server has closed the idle connection while the loop is blocked. */
const BLOCK_MS = 6500

function blockEventLoop(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type Stub = {
	dir: string
	sock: string
	env: NodeJS.ProcessEnv
	calls: { method: string; idempotencyKey?: string }[]
	close: () => Promise<void>
}

/**
 * The stub runs in its own process, like the real signer: its idle-connection timer and its FIN must not depend on
 * the client's event loop. In one process a blocked loop would freeze both ends and hide the failure.
 */
const STUB_SERVER = `
const http = require('node:http')
const sock = process.env.STUB_SOCK
const lab = process.env.STUB_ADDR
const hash = process.env.STUB_HASH
const dropSend = process.env.STUB_DROP_SEND === '1'
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    process.stdout.write(JSON.stringify({ method: msg.method, idempotencyKey: msg.params && msg.params.idempotencyKey }) + '\\n')
    if (msg.method === 'signer_sendTransaction' && dropSend) { req.socket.destroy(); return }
    const result = msg.method === 'signer_getAddress' ? lab : msg.method === 'signer_sendTransaction' ? { hash } : msg.method === 'signer_getTransaction' ? { found: false } : null
    const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
})
server.keepAliveTimeout = Number(process.env.STUB_KEEP_ALIVE_MS)
server.listen(sock, () => process.stdout.write('READY\\n'))
`

async function startStub(opts: { dropSend?: boolean } = {}): Promise<Stub> {
	const dir = mkdtempSync(join(tmpdir(), 'lab-rpc-keepalive-'))
	const sock = join(dir, 'lab-payout.sock')
	const denyFile = join(dir, 'deny.json')
	writeFileSync(denyFile, JSON.stringify({ addresses: [], sockets: [], keyArrays: [] }))
	const calls: Stub['calls'] = []
	const child: ChildProcess = spawn(process.execPath, ['-e', STUB_SERVER], {
		env: {
			...process.env,
			STUB_SOCK: sock,
			STUB_ADDR: LAB,
			STUB_HASH: HASH,
			STUB_DROP_SEND: opts.dropSend ? '1' : '0',
			STUB_KEEP_ALIVE_MS: String(STUB_KEEP_ALIVE_MS),
		},
		stdio: ['ignore', 'pipe', 'inherit'],
	})
	let buf = ''
	let ready: () => void = () => undefined
	const readyP = new Promise<void>((resolve) => {
		ready = resolve
	})
	child.stdout!.on('data', (d: Buffer) => {
		buf += d.toString('utf8')
		let nl: number
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl)
			buf = buf.slice(nl + 1)
			if (line === 'READY') ready()
			else if (line) calls.push(JSON.parse(line) as { method: string; idempotencyKey?: string })
		}
	})
	await readyP
	return {
		dir,
		sock,
		calls,
		env: {
			CONET_LAB_DENY_LIST_FILE: denyFile,
			CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET: sock,
			CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY: 'lab_mining_pool_payout',
			CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS: LAB,
		},
		close: () =>
			new Promise<void>((resolve) => {
				child.once('exit', () => {
					rmSync(dir, { recursive: true, force: true })
					resolve()
				})
				child.kill('SIGKILL')
			}),
	}
}

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
	const saved: NodeJS.ProcessEnv = {}
	for (const k of Object.keys(env)) saved[k] = process.env[k]
	Object.assign(process.env, env)
	return fn().finally(() => {
		for (const k of Object.keys(env)) {
			if (saved[k] === undefined) delete process.env[k]
			else process.env[k] = saved[k]
		}
	})
}

test('transport: a second signer call after the event loop was blocked past the server idle timeout still succeeds', async () => {
	const s = await startStub()
	try {
		await withEnv(s.env, async () => {
			assert.equal(await verifyLabSignerBoundAddress(process.env), LAB)
			blockEventLoop(BLOCK_MS)
			assert.equal(await verifyLabSignerBoundAddress(process.env), LAB)
		})
		assert.equal(s.calls.filter((c) => c.method === 'signer_getAddress').length, 2)
	} finally {
		await s.close()
	}
})

test('lifecycle: first send with a long synchronous persist between the two address confirmations settles', async () => {
	const s = await startStub()
	try {
		await withEnv(s.env, async () => {
			const alerts: string[] = []
			const logs: string[] = []
			let inFlight: LabInFlightWithdraw | null = null
			const persisted: Array<string | null> = []
			const settledKeys: string[] = []
			const gate = new LabPayoutFailClosedGate((m) => alerts.push(m))
			const deps: LabLifecycleDeps = {
				gate,
				getInFlight: () => inFlight,
				setInFlight: (v) => {
					inFlight = v
				},
				// Stands in for writeState on a large pending set: synchronous, blocks the loop.
				persist: () => {
					blockEventLoop(BLOCK_MS)
					persisted.push(inFlight ? inFlight.idempotencyKey : null)
				},
				confirmBeforeSend: async () => {
					await verifyLabSignerBoundAddress(process.env)
				},
				send: async (rec) => {
					const sent = await sendConfiguredLabWithdrawNative({
						redeem: rec.redeem,
						pool: rec.pool,
						amount: BigInt(rec.amountWei),
						eventKeys: rec.eventKeys,
						gasLimit: 800000,
						expectedIdempotencyKey: rec.idempotencyKey,
					})
					return { hash: sent.hash }
				},
				waitReceipt: async () => ({ status: 1 }),
				settle: (keys) => settledKeys.push(...keys),
				log: (l) => logs.push(l),
			}
			const outcome = await submitWithdrawBatchDurably(deps, {
				line: 'history',
				redeem: REDEEM,
				pool: LAB_MINING_POOL_FIXED,
				amount: 10n ** 15n,
				eventKeys: [key(1), key(2), key(3)],
			})
			assert.equal(outcome, 'settled', `alerts=${alerts.join(' | ')} logs=${logs.join(' | ')}`)
			assert.equal(alerts.filter((a) => a.includes('refused before broadcast')).length, 0)
			assert.equal(s.calls.filter((c) => c.method === 'signer_sendTransaction').length, 1)
			assert.equal(settledKeys.length, 3)
		})
	} finally {
		await s.close()
	}
})

test('semantics: a real transport failure on sendTransaction is an unknown outcome, held and never re-sent', async () => {
	const s = await startStub({ dropSend: true })
	try {
		await withEnv(s.env, async () => {
			const logs: string[] = []
			let inFlight: LabInFlightWithdraw | null = null
			const deps: LabLifecycleDeps = {
				gate: new LabPayoutFailClosedGate(() => undefined),
				getInFlight: () => inFlight,
				setInFlight: (v) => {
					inFlight = v
				},
				persist: () => undefined,
				confirmBeforeSend: async () => {
					await verifyLabSignerBoundAddress(process.env)
				},
				send: async (rec) => {
					const sent = await sendConfiguredLabWithdrawNative({
						redeem: rec.redeem,
						pool: rec.pool,
						amount: BigInt(rec.amountWei),
						eventKeys: rec.eventKeys,
						gasLimit: 800000,
						expectedIdempotencyKey: rec.idempotencyKey,
					})
					return { hash: sent.hash }
				},
				waitReceipt: async () => ({ status: 1 }),
				settle: () => undefined,
				log: (l) => logs.push(l),
			}
			const outcome = await submitWithdrawBatchDurably(deps, {
				line: 'history',
				redeem: REDEEM,
				pool: LAB_MINING_POOL_FIXED,
				amount: 10n ** 15n,
				eventKeys: [key(7)],
			})
			assert.equal(outcome, 'pending')
			assert.ok(inFlight, 'the in-flight record is kept')
			assert.match(logs.join('\n'), /withdrawNative send unresolved/)
			// Exactly one sendTransaction reached the signer: no blind retry. The only extra call is the read-only
			// journal lookup by idempotencyKey that sendConfiguredLabWithdrawNative already did before this change.
			assert.equal(s.calls.filter((c) => c.method === 'signer_sendTransaction').length, 1)
		})
	} finally {
		await s.close()
	}
})
