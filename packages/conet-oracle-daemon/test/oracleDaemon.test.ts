import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	BEAMIO_ORACLE,
	CONET_CHAIN_ID,
	GUARDIAN_ORACLE_CONET,
	MAX_SOURCE_AGE_MS,
	ORACLE_KEY_ARRAY,
	SIGNER_LOCKED,
	UPDATE_RATE_SELECTOR,
	UPDATE_RATES_BATCH_SELECTOR,
} from '../src/constants'
import { acquireQuoteLock } from '../src/lock'
import { execute } from '../src/main'
import { buildOracleTx } from '../src/plan'
import { readQuoteDocument } from '../src/quoteSource'
import { SignerCallError } from '../src/refusal'
import { renderOutcome, runOnce, type QuoteSender } from '../src/runOnce'
import { signerSendOnce } from '../src/signerRpc'

const HASH = `0x${'11'.repeat(32)}`
const NOW = Date.parse('2026-11-09T18:00:00.000Z')

function freshDocument(ageMs = 0) {
	return {
		observedAt: new Date(NOW - ageMs).toISOString(),
		rates: [
			{ currencyId: 1, rateE18: '1000000000000000000' },
			{ currencyId: 0, rateE18: '730000000000000000' },
		],
	}
}

function countingSend(body: { calls: number }, impl?: QuoteSender): QuoteSender {
	return async (tx) => {
		body.calls += 1
		if (impl) return impl(tx)
		return { hash: HASH }
	}
}

function lockPath(name: string): string {
	return join(mkdtempSync(join(tmpdir(), 'conet-oracle-')), name)
}

test('a source older than 20 minutes is refused and not signed', async () => {
	const seen = { calls: 0 }
	const outcome = await runOnce({
		document: freshDocument(MAX_SOURCE_AGE_MS + 1),
		nowMs: NOW,
		lockPath: lockPath('stale.lock'),
		send: countingSend(seen),
	})
	assert.equal(outcome.ok, false)
	assert.equal(outcome.sent, false)
	if (!outcome.ok) assert.equal(outcome.reason, 'stale')
	assert.equal(seen.calls, 0)
	const view = renderOutcome(outcome)
	assert.equal(view.exitCode, 1)
	assert.doesNotMatch(view.line, /quoted|success/i)
})

test('a source exactly 20 minutes old can be submitted once', async () => {
	const seen = { calls: 0 }
	const outcome = await runOnce({
		document: freshDocument(MAX_SOURCE_AGE_MS),
		nowMs: NOW,
		lockPath: lockPath('fresh.lock'),
		send: countingSend(seen),
	})
	assert.deepEqual(outcome, { ok: true, sent: true, hash: HASH })
	assert.equal(seen.calls, 1)
	const tx = buildOracleTx(readQuoteDocument(freshDocument(0), NOW))
	assert.equal(tx.chainId, CONET_CHAIN_ID)
	assert.equal(tx.to, BEAMIO_ORACLE)
	assert.equal(tx.value, '0')
	assert.equal(tx.keyArray, ORACLE_KEY_ARRAY)
	assert.equal(tx.data.slice(0, 10).toLowerCase(), UPDATE_RATES_BATCH_SELECTOR)
})

test('a single rate uses updateRate and still sends value 0 on CoNET', () => {
	const quote = readQuoteDocument(
		{
			observedAt: new Date(NOW).toISOString(),
			rates: [{ currencyId: 1, rateE18: '1000000000000000000' }],
		},
		NOW,
	)
	const tx = buildOracleTx(quote)
	assert.equal(tx.data.slice(0, 10).toLowerCase(), UPDATE_RATE_SELECTOR)
	assert.equal(tx.value, '0')
	assert.equal(tx.chainId, CONET_CHAIN_ID)
	assert.equal(tx.to, BEAMIO_ORACLE)
})

test('Base chain 8453 is refused before any send', async () => {
	const seen = { calls: 0 }
	const outcome = await runOnce({
		document: freshDocument(0),
		nowMs: NOW,
		lockPath: lockPath('base.lock'),
		target: { chainId: 8453, to: BEAMIO_ORACLE, value: 0n },
		send: countingSend(seen),
	})
	assert.equal(outcome.ok, false)
	assert.equal(outcome.sent, false)
	if (!outcome.ok) assert.equal(outcome.reason, 'chain')
	assert.equal(seen.calls, 0)
	assert.equal(renderOutcome(outcome).exitCode, 1)
})

test('the old GuardianOracle address is refused on CoNET', async () => {
	const seen = { calls: 0 }
	const outcome = await runOnce({
		document: freshDocument(0),
		nowMs: NOW,
		lockPath: lockPath('guardian.lock'),
		target: { chainId: CONET_CHAIN_ID, to: GUARDIAN_ORACLE_CONET, value: 0n },
		send: countingSend(seen),
	})
	assert.equal(outcome.ok, false)
	if (!outcome.ok) assert.equal(outcome.reason, 'guardian-oracle')
	assert.equal(seen.calls, 0)
})

test('a quote document that names Base is refused', async () => {
	const seen = { calls: 0 }
	const outcome = await runOnce({
		document: { ...freshDocument(0), baseRpc: 'https://base-rpc.conet.network' },
		nowMs: NOW,
		lockPath: lockPath('baserpc.lock'),
		send: countingSend(seen),
	})
	assert.equal(outcome.ok, false)
	if (!outcome.ok) assert.equal(outcome.reason, 'base-or-secret')
	assert.equal(seen.calls, 0)
})

test('a locked signer is not reported as a quote and is not retried', async () => {
	const seen = { calls: 0 }
	const send: QuoteSender = async () => {
		seen.calls += 1
		if (seen.calls === 1) throw new SignerCallError(SIGNER_LOCKED, 'signer locked')
		return { hash: HASH }
	}
	const outcome = await runOnce({
		document: freshDocument(0),
		nowMs: NOW,
		lockPath: lockPath('locked.lock'),
		send,
	})
	assert.equal(seen.calls, 1)
	assert.equal(outcome.ok, false)
	assert.equal(outcome.sent, false)
	if (!outcome.ok) {
		assert.equal(outcome.reason, 'signer')
		assert.equal(outcome.code, SIGNER_LOCKED)
	}
	const view = renderOutcome(outcome)
	assert.equal(view.exitCode, 1)
	assert.match(view.line, /^refused: signer/)
	assert.doesNotMatch(view.line, /quoted|success/i)
	const error = new SignerCallError(SIGNER_LOCKED, 'signer locked')
	assert.equal(error.reportedSuccess, false)
})

test('the unix socket client posts one locked refusal and does not call again', async () => {
	const sock = `/tmp/conet-oracle-test-${process.pid}.sock`
	let calls = 0
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		calls += 1
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
				id: number
				method: string
				params: { chainId: number; value: string; to: string; keyArray: string; data: string }
			}
			assert.equal(req.method, 'POST')
			assert.equal(body.method, 'signer_sendTransaction')
			assert.equal(body.params.chainId, CONET_CHAIN_ID)
			assert.equal(body.params.value, '0')
			assert.equal(body.params.to, BEAMIO_ORACLE)
			assert.equal(body.params.keyArray, ORACLE_KEY_ARRAY)
			assert.equal(body.params.data.slice(0, 10).toLowerCase(), UPDATE_RATES_BATCH_SELECTOR)
			assert.equal(req.headers['x-ws-client-cn'], undefined)
			const payload = calls === 1
				? { jsonrpc: '2.0', id: body.id, error: { code: SIGNER_LOCKED, message: 'signer locked' } }
				: { jsonrpc: '2.0', id: body.id, result: { hash: HASH } }
			res.end(JSON.stringify(payload))
		})
	})
	await new Promise<void>((resolve) => server.listen(sock, resolve))
	try {
		const outcome = await runOnce({
			document: freshDocument(0),
			nowMs: NOW,
			lockPath: lockPath('socket.lock'),
			send: (tx) => signerSendOnce(tx, sock),
		})
		assert.equal(calls, 1)
		assert.equal(outcome.ok, false)
		assert.equal(outcome.sent, false)
		if (!outcome.ok) assert.equal(outcome.code, SIGNER_LOCKED)
		assert.doesNotMatch(renderOutcome(outcome).line, /quoted|success/i)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
	}
})

test('a second start while the first lock is held does not send', async () => {
	const path = lockPath('overlap.lock')
	const hold = acquireQuoteLock(path)
	assert.equal(hold.acquired, true)
	const seen = { calls: 0 }
	try {
		const outcome = await runOnce({
			document: freshDocument(0),
			nowMs: NOW,
			lockPath: path,
			send: countingSend(seen),
		})
		assert.equal(outcome.ok, false)
		assert.equal(outcome.sent, false)
		if (!outcome.ok) assert.equal(outcome.reason, 'overlap')
		assert.equal(seen.calls, 0)
		const view = renderOutcome(outcome)
		assert.equal(view.exitCode, 0)
		assert.match(view.line, /not sent/)
		assert.doesNotMatch(view.line, /quoted/)
	} finally {
		if (hold.acquired) hold.release()
	}
})

test('the oneshot exits non-zero for a stale file and does not call the signer', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'conet-oracle-cli-'))
	const quoteFile = join(dir, 'quote.json')
	writeFileSync(quoteFile, JSON.stringify(freshDocument(MAX_SOURCE_AGE_MS + 5)))
	const lines: string[] = []
	const errors: string[] = []
	const seen = { calls: 0 }
	const code = await execute({
		quoteFile,
		lockFile: join(dir, 'lock'),
		nowMs: NOW,
		send: countingSend(seen),
		io: {
			log: (line) => lines.push(line),
			error: (line) => errors.push(line),
		},
	})
	assert.equal(code, 1)
	assert.equal(seen.calls, 0)
	assert.equal(lines.length, 0)
	assert.match(errors.join('\n'), /^refused: stale/)
	assert.doesNotMatch(errors.join('\n'), /quoted|success/i)
	rmSync(dir, { recursive: true, force: true })
})

test('CONET_ORACLE_CHAIN_ID=8453 exits before a send', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'conet-oracle-cli-'))
	const quoteFile = join(dir, 'quote.json')
	writeFileSync(quoteFile, JSON.stringify(freshDocument(0)))
	const seen = { calls: 0 }
	const errors: string[] = []
	const code = await execute({
		quoteFile,
		lockFile: join(dir, 'lock'),
		nowMs: NOW,
		env: { CONET_ORACLE_CHAIN_ID: '8453' },
		send: countingSend(seen),
		io: { log: () => undefined, error: (line) => errors.push(line) },
	})
	assert.equal(code, 1)
	assert.equal(seen.calls, 0)
	assert.match(errors.join('\n'), /refused: chain/)
	rmSync(dir, { recursive: true, force: true })
})

test('the unit files are a non-overlapping 10 minute oneshot with no setInterval', () => {
	const root = join(__dirname, '..', '..')
	const service = readFileSync(join(root, 'deploy/conet-oracle-quote.service'), 'utf8')
	const timer = readFileSync(join(root, 'deploy/conet-oracle-quote.timer'), 'utf8')
	assert.match(service, /^Type=oneshot$/m)
	assert.match(service, /^Restart=no$/m)
	assert.doesNotMatch(service, /Restart=(always|on-failure|on-success|on-abnormal|on-abort|on-watchdog)/)
	assert.match(service, /oracle-daemon\.sock/)
	assert.doesNotMatch(service, /^ExecStart=.*conetOracle\.service/m)
	assert.match(timer, /^OnUnitActiveSec=10min$/m)
	assert.match(timer, /^Persistent=false$/m)
	assert.match(timer, /^Unit=conet-oracle-quote\.service$/m)
	const files: string[] = []
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name === 'dist') continue
			const path = join(dir, name)
			if (statSync(path).isDirectory()) walk(path)
			else if (/\.(ts|service|timer|txt|md|json)$/.test(name)) files.push(path)
		}
	}
	walk(join(root, 'src'))
	walk(join(root, 'deploy'))
	const blob = files.map((path) => readFileSync(path, 'utf8')).join('\n')
	assert.doesNotMatch(blob, /setInterval/)
	assert.doesNotMatch(blob, /JsonRpcProvider/)
	assert.doesNotMatch(blob, /eth_sendRawTransaction/)
	assert.doesNotMatch(blob, /base-rpc\.conet\.network/)
	assert.doesNotMatch(blob, /rpc1\.conet\.network/)
})
