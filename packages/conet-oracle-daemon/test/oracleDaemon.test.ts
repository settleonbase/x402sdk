import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Interface } from 'ethers'
import {
	BEAMIO_ORACLE,
	COINBASE_ETH_USD_SPOT_URL,
	COINBASE_FX_URL,
	CONET_CHAIN_ID,
	GUARDIAN_ORACLE_CONET,
	MAX_FETCH_ATTEMPTS,
	MAX_SOURCE_AGE_MS,
	ORACLE_KEY_ARRAY,
	SIGNER_LOCKED,
	UPDATE_RATES_BATCH_SELECTOR,
} from '../src/constants'
import { acquireQuoteLock } from '../src/lock'
import { execute, parseArgv } from '../src/main'
import { fxUnitsPerUsdToRateE18, quoteFromResponses, usdAmountToRateE18 } from '../src/publicQuotes'
import type { HttpGet, HttpResponse } from '../src/publicQuotes'
import { SignerCallError } from '../src/refusal'
import { runOnce, type QuoteSender } from '../src/runOnce'
import { nodeHttpGet } from '../src/publicQuotes'
import { signerSendOnce } from '../src/signerRpc'

const HASH = `0x${'11'.repeat(32)}`
const NOW = Date.parse('2026-11-09T18:00:00.000Z')
const FRESH_DATE = new Date(NOW - 60_000).toUTCString()
const FX_URL = 'https://quotes.test/fx'
const ETH_URL = 'https://quotes.test/eth'

const RATE_IFACE = new Interface(['function updateRatesBatch(uint8[] cs, uint256[] rs)'])

function lockPath(name: string): string {
	return join(mkdtempSync(join(tmpdir(), 'conet-oracle-')), name)
}

function fxBody(cad = '1.36'): string {
	return JSON.stringify({
		data: {
			currency: 'USD',
			rates: { CAD: cad, JPY: '150.1', CNY: '7.2', HKD: '7.8', EUR: '0.92', SGD: '1.34', TWD: '32.1' },
		},
	})
}

function ethBody(amount = '2000.25'): string {
	return JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount } })
}

function ok(body: string, dateHeader: string | null = FRESH_DATE): HttpResponse {
	return { status: 200, dateHeader, body }
}

function pairGet(fx: HttpResponse, eth: HttpResponse): HttpGet {
	return async (url) => (url === ETH_URL ? eth : fx)
}

async function run(
	get: HttpGet,
	send: QuoteSender,
	extra: Partial<Parameters<typeof execute>[0]> = {},
): Promise<{ code: number; lines: string[]; errors: string[] }> {
	const lines: string[] = []
	const errors: string[] = []
	const code = await execute({
		fxUrl: FX_URL,
		ethUrl: ETH_URL,
		now: () => NOW,
		retryDelayMs: 0,
		io: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
		...extra,
		lockFile: extra.lockFile ?? lockPath('run.lock'),
		get,
		send,
	})
	return { code, lines, errors }
}

test('public defaults are Coinbase FX and ETH-USD spot, not CoinMarketCap', () => {
	assert.equal(COINBASE_FX_URL, 'https://api.coinbase.com/v2/exchange-rates?currency=USD')
	assert.equal(COINBASE_ETH_USD_SPOT_URL, 'https://api.coinbase.com/v2/prices/ETH-USD/spot')
	assert.doesNotMatch(`${COINBASE_FX_URL} ${COINBASE_ETH_USD_SPOT_URL}`, /coinmarketcap/i)
})

test('a fresh public pair is signed once on CoNET with inverted fiat, USD and USDC at 1', async () => {
	const seen: { calls: number; data?: string } = { calls: 0 }
	const send: QuoteSender = async (tx) => {
		seen.calls += 1
		seen.data = tx.data
		assert.equal(tx.chainId, CONET_CHAIN_ID)
		assert.equal(tx.to, BEAMIO_ORACLE)
		assert.equal(tx.value, '0')
		assert.equal(tx.keyArray, ORACLE_KEY_ARRAY)
		assert.equal(tx.data.slice(0, 10).toLowerCase(), UPDATE_RATES_BATCH_SELECTOR)
		return { hash: HASH }
	}
	const result = await run(pairGet(ok(fxBody()), ok(ethBody())), send)
	assert.equal(result.code, 0)
	assert.equal(seen.calls, 1)
	assert.match(result.lines.join('\n'), /^fetched observedAt=/)
	assert.match(result.lines.join('\n'), new RegExp(`quoted ${HASH}`))
	const decoded = RATE_IFACE.decodeFunctionData('updateRatesBatch', seen.data!)
	const ids = [...decoded[0]].map((id) => Number(id))
	const rates = [...decoded[1]].map((rate) => BigInt(rate))
	assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
	assert.equal(rates[0], fxUnitsPerUsdToRateE18(1.36))
	assert.equal(rates[1], 10n ** 18n)
	assert.equal(rates[4], 10n ** 18n)
	assert.equal(rates[9], usdAmountToRateE18(2000.25))
})

test('a local HTTPS quote source supplies the Date header that is signed', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'conet-oracle-tls-'))
	const cert = join(dir, 'cert.pem')
	const key = join(dir, 'key.pem')
	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes',
		'-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
	])
	const server = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
		const body = req.url === '/eth' ? ethBody() : fxBody()
		res.writeHead(200, { 'content-type': 'application/json', date: FRESH_DATE })
		res.end(body)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as { port: number }).port
	const seen = { calls: 0 }
	try {
		const result = await run(
			nodeHttpGet(readFileSync(cert)),
			async (tx) => {
				seen.calls += 1
				assert.equal(tx.to, BEAMIO_ORACLE)
				assert.equal(tx.value, '0')
				return { hash: HASH }
			},
			{
				fxUrl: `https://127.0.0.1:${port}/fx`,
				ethUrl: `https://127.0.0.1:${port}/eth`,
			},
		)
		assert.equal(result.code, 0)
		assert.equal(seen.calls, 1)
		assert.match(result.lines.join('\n'), /observedAt=2026-11-09T17:59:00.000Z/)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
		rmSync(dir, { recursive: true, force: true })
	}
})

test('an HTTP Date older than 20 minutes is not signed', async () => {
	const stale = new Date(NOW - MAX_SOURCE_AGE_MS - 1).toUTCString()
	const seen = { calls: 0 }
	let hits = 0
	const get: HttpGet = async (url) => {
		hits += 1
		return ok(url === ETH_URL ? ethBody() : fxBody(), stale)
	}
	const result = await run(get, async () => {
		seen.calls += 1
		return { hash: HASH }
	})
	assert.equal(result.code, 1)
	assert.equal(seen.calls, 0)
	assert.equal(hits, MAX_FETCH_ATTEMPTS * 2)
	assert.match(result.errors.join('\n'), /^refused: stale/)
	assert.doesNotMatch(result.errors.join('\n'), /quoted|success/i)
})

test('a Date header later than the pre-request clock succeeds when the collection clock has moved', async () => {
	const start = NOW
	let clock = start
	const samples: number[] = []
	const get: HttpGet = async (url) => {
		assert.equal(samples.length, 0)
		clock = start + 1000
		return ok(url === ETH_URL ? ethBody() : fxBody(), new Date(start + 1000).toUTCString())
	}
	const seen = { calls: 0 }
	const result = await run(
		get,
		async () => {
			seen.calls += 1
			return { hash: HASH }
		},
		{
			now: () => {
				samples.push(clock)
				return clock
			},
			maxAttempts: 1,
		},
	)
	assert.equal(result.code, 0)
	assert.equal(seen.calls, 1)
	assert.deepEqual(samples, [start + 1000])
	assert.match(result.lines.join('\n'), /observedAt=2026-11-09T18:00:01.000Z/)
})

test('a Date header later than the collection clock is still refused', async () => {
	const seen = { calls: 0 }
	const result = await run(
		pairGet(ok(fxBody(), new Date(NOW + 1000).toUTCString()), ok(ethBody(), new Date(NOW + 1000).toUTCString())),
		async () => {
			seen.calls += 1
			return { hash: HASH }
		},
		{ maxAttempts: 1 },
	)
	assert.equal(result.code, 1)
	assert.equal(seen.calls, 0)
	assert.match(result.errors.join('\n'), /in the future/)
})

test('a retry whose Date is later than the original pre-request clock succeeds without reusing the failed body', async () => {
	const start = NOW
	let clock = start
	let round = 1
	const samples: number[] = []
	const get: HttpGet = async (url) => {
		if (url === FX_URL && round === 1) {
			setTimeout(() => {
				clock = start + 5000
				round = 2
			}, 5)
			return { status: 503, dateHeader: new Date(start).toUTCString(), body: fxBody('9.99') }
		}
		const date = new Date(clock).toUTCString()
		if (url === ETH_URL) return ok(ethBody(round === 1 ? '1111' : '2222'), date)
		return ok(fxBody('1.36'), date)
	}
	const seen: { data?: string } = {}
	const result = await run(
		get,
		async (tx) => {
			seen.data = tx.data
			return { hash: HASH }
		},
		{
			now: () => {
				samples.push(clock)
				return clock
			},
			retryDelayMs: 40,
			maxAttempts: 2,
		},
	)
	assert.equal(result.code, 0)
	assert.equal(samples.at(-1), start + 5000)
	assert.ok(samples.every((sample) => sample <= start + 5000))
	const decoded = RATE_IFACE.decodeFunctionData('updateRatesBatch', seen.data!)
	const rates = [...decoded[1]].map((rate) => BigInt(rate))
	assert.equal(rates[0], fxUnitsPerUsdToRateE18(1.36))
	assert.notEqual(rates[0], fxUnitsPerUsdToRateE18(9.99))
	assert.equal(rates[9], usdAmountToRateE18(2222))
	assert.notEqual(rates[9], usdAmountToRateE18(1111))
})

test('a missing Date header is not signed', async () => {
	const seen = { calls: 0 }
	const result = await run(
		pairGet(ok(fxBody(), null), ok(ethBody(), FRESH_DATE)),
		async () => {
			seen.calls += 1
			return { hash: HASH }
		},
		{ maxAttempts: 1 },
	)
	assert.equal(result.code, 1)
	assert.equal(seen.calls, 0)
	assert.match(result.errors.join('\n'), /Date header is missing/)
})

test('a non-numeric FX field is not signed', async () => {
	const seen = { calls: 0 }
	const result = await run(
		pairGet(ok(fxBody('nope')), ok(ethBody())),
		async () => {
			seen.calls += 1
			return { hash: HASH }
		},
		{ maxAttempts: 1 },
	)
	assert.equal(result.code, 1)
	assert.equal(seen.calls, 0)
	assert.match(result.errors.join('\n'), /not a positive number/)
})

test('a missing FX field is not signed', async () => {
	const seen = { calls: 0 }
	const body = JSON.stringify({ data: { rates: { JPY: '1', CNY: '1', HKD: '1', EUR: '1', SGD: '1', TWD: '1' } } })
	const result = await run(pairGet(ok(body), ok(ethBody())), async () => {
		seen.calls += 1
		return { hash: HASH }
	}, { maxAttempts: 1 })
	assert.equal(result.code, 1)
	assert.equal(seen.calls, 0)
	assert.match(result.errors.join('\n'), /CAD is missing/)
})

test('non-2xx responses retry a bounded number of times and then do not sign', async () => {
	const seen = { calls: 0 }
	let fxHits = 0
	const get: HttpGet = async (url) => {
		if (url === ETH_URL) return ok(ethBody())
		fxHits += 1
		return { status: 503, dateHeader: FRESH_DATE, body: 'no' }
	}
	const result = await run(get, async () => {
		seen.calls += 1
		return { hash: HASH }
	})
	assert.equal(result.code, 1)
	assert.equal(fxHits, MAX_FETCH_ATTEMPTS)
	assert.equal(seen.calls, 0)
	assert.match(result.errors.join('\n'), /HTTP 503/)
})

test('a bounded retry signs the new body and drops the failed one', async () => {
	const seen: { calls: number; data: string[] } = { calls: 0, data: [] }
	let fxHits = 0
	const get: HttpGet = async (url) => {
		if (url === ETH_URL) return ok(ethBody('2100'))
		fxHits += 1
		if (fxHits < 3) return { status: 503, dateHeader: FRESH_DATE, body: fxBody('9.99') }
		return ok(fxBody('1.36'))
	}
	const result = await run(get, async (tx) => {
		seen.calls += 1
		seen.data.push(tx.data)
		return { hash: HASH }
	})
	assert.equal(result.code, 0)
	assert.equal(fxHits, 3)
	assert.equal(seen.calls, 1)
	const decoded = RATE_IFACE.decodeFunctionData('updateRatesBatch', seen.data[0]!)
	assert.equal(BigInt(decoded[1][0]), fxUnitsPerUsdToRateE18(1.36))
})

test('a timeout is not signed', async () => {
	const seen = { calls: 0 }
	const get: HttpGet = async () => {
		throw new Error('timeout')
	}
	const result = await run(get, async () => {
		seen.calls += 1
		return { hash: HASH }
	}, { maxAttempts: 1 })
	assert.equal(result.code, 1)
	assert.equal(seen.calls, 0)
	assert.match(result.errors.join('\n'), /timeout/)
})

test('a locked signer exits non-zero without a quote, and the next run fetches again', async () => {
	const signed: string[] = []
	let locked = true
	let eth = '2000.25'
	const send: QuoteSender = async (tx) => {
		signed.push(tx.data)
		if (locked) throw new SignerCallError(SIGNER_LOCKED, 'signer locked')
		return { hash: HASH }
	}
	const get: HttpGet = async (url) => ok(url === ETH_URL ? ethBody(eth) : fxBody())
	const first = await run(get, send)
	assert.equal(first.code, 1)
	assert.equal(signed.length, 1)
	assert.match(first.errors.join('\n'), /^refused: signer/)
	assert.doesNotMatch([...first.lines, ...first.errors].join('\n'), /quoted|success/i)
	assert.equal(new SignerCallError(SIGNER_LOCKED, 'signer locked').reportedSuccess, false)
	locked = false
	eth = '2100'
	const second = await run(get, send)
	assert.equal(second.code, 0)
	assert.equal(signed.length, 2)
	assert.notEqual(signed[0], signed[1])
	assert.match(second.lines.join('\n'), /quoted /)
})

test('a failed later fetch does not sign the previous round prices', async () => {
	const seen = { calls: 0 }
	let phase: 'ok' | 'down' = 'ok'
	const get: HttpGet = async (url) => {
		if (phase === 'down') throw new Error('down')
		return ok(url === ETH_URL ? ethBody() : fxBody())
	}
	const send: QuoteSender = async () => {
		seen.calls += 1
		return { hash: HASH }
	}
	const first = await run(get, send, { maxAttempts: 1 })
	assert.equal(first.code, 0)
	phase = 'down'
	const second = await run(get, send, { maxAttempts: 1 })
	assert.equal(second.code, 1)
	assert.equal(seen.calls, 1)
	assert.match(second.errors.join('\n'), /down/)
})

test('Base chain 8453 is refused before any fetch or send', async () => {
	let hits = 0
	const result = await execute({
		lockFile: lockPath('base.lock'),
		now: () => NOW,
		env: { CONET_ORACLE_CHAIN_ID: '8453' },
		get: async () => {
			hits += 1
			return ok(fxBody())
		},
		send: async () => {
			throw new Error('signed')
		},
		io: { log: () => undefined, error: () => undefined },
	})
	assert.equal(result, 1)
	assert.equal(hits, 0)
})

test('the old GuardianOracle address is refused before send', async () => {
	const seen = { calls: 0 }
	const quote = quoteFromResponses(ok(fxBody()), ok(ethBody()), NOW)
	const outcome = await runOnce({
		lockPath: lockPath('guardian.lock'),
		loadQuote: async () => quote,
		target: { chainId: CONET_CHAIN_ID, to: GUARDIAN_ORACLE_CONET, value: 0n },
		send: async () => {
			seen.calls += 1
			return { hash: HASH }
		},
	})
	assert.equal(outcome.ok, false)
	if (!outcome.ok) assert.equal(outcome.reason, 'guardian-oracle')
	assert.equal(seen.calls, 0)
})

test('a second start while the lock is held does not fetch or sign', async () => {
	const path = lockPath('overlap.lock')
	const hold = acquireQuoteLock(path)
	assert.equal(hold.acquired, true)
	let hits = 0
	try {
		const result = await run(
			async () => {
				hits += 1
				return ok(fxBody())
			},
			async () => ({ hash: HASH }),
			{ lockFile: path },
		)
		assert.equal(result.code, 0)
		assert.equal(hits, 0)
		assert.match(result.lines.join('\n'), /not sent/)
		assert.doesNotMatch(result.lines.join('\n'), /quoted/)
	} finally {
		if (hold.acquired) hold.release()
	}
})

test('the unix socket client posts one locked refusal and does not call again', async () => {
	const sock = `/tmp/conet-oracle-fetch-${process.pid}.sock`
	let calls = 0
	const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
		calls += 1
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
				id: number
				method: string
				params: { chainId: number; value: string; to: string; keyArray: string; data: string }
			}
			assert.equal(body.method, 'signer_sendTransaction')
			assert.equal(body.params.chainId, CONET_CHAIN_ID)
			assert.equal(body.params.value, '0')
			assert.equal(body.params.to, BEAMIO_ORACLE)
			assert.equal(body.params.keyArray, ORACLE_KEY_ARRAY)
			assert.equal(body.params.data.slice(0, 10).toLowerCase(), UPDATE_RATES_BATCH_SELECTOR)
			const payload = calls === 1
				? { jsonrpc: '2.0', id: body.id, error: { code: SIGNER_LOCKED, message: 'signer locked' } }
				: { jsonrpc: '2.0', id: body.id, result: { hash: HASH } }
			res.end(JSON.stringify(payload))
		})
	})
	await new Promise<void>((resolve) => server.listen(sock, resolve))
	try {
		const result = await run(pairGet(ok(fxBody()), ok(ethBody())), (tx) => signerSendOnce(tx, sock))
		assert.equal(calls, 1)
		assert.equal(result.code, 1)
		assert.match(result.errors.join('\n'), /signer locked/)
		assert.doesNotMatch(result.errors.join('\n'), /quoted|success/i)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
	}
})

test('--quote-file is rejected and the unit does not read a quote file', () => {
	assert.throws(() => parseArgv(['--quote-file', '/tmp/quote.json', '--lock-file', '/tmp/lock']), /quote file is not a source/)
	const root = join(__dirname, '..', '..')
	const service = readFileSync(join(root, 'deploy/conet-oracle-quote.service'), 'utf8')
	const timer = readFileSync(join(root, 'deploy/conet-oracle-quote.timer'), 'utf8')
	assert.match(service, /^Type=oneshot$/m)
	assert.match(service, /^Restart=no$/m)
	assert.doesNotMatch(service, /Restart=(always|on-failure|on-success|on-abnormal|on-abort|on-watchdog)/)
	assert.doesNotMatch(service, /quote-file|quote\.json/)
	assert.match(service, /oracle-daemon\.sock/)
	assert.match(timer, /^OnUnitActiveSec=10min$/m)
	assert.match(timer, /^Persistent=false$/m)
	const files: string[] = []
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name === 'dist') continue
			const path = join(dir, name)
			if (statSync(path).isDirectory()) walk(path)
			else if (/\.(ts|service|timer|txt|md|mjs)$/.test(name)) files.push(path)
		}
	}
	walk(join(root, 'src'))
	walk(join(root, 'deploy'))
	const blob = files.map((path) => readFileSync(path, 'utf8')).join('\n')
	assert.doesNotMatch(blob, /setInterval/)
	assert.doesNotMatch(blob, /JsonRpcProvider/)
	assert.doesNotMatch(blob, /eth_sendRawTransaction/)
	assert.doesNotMatch(blob, /coinmarketcap/i)
})
