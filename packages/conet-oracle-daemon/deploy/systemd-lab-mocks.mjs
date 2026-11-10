/**
 * Local HTTPS quote source and unix-socket signer for the isolate systemd run.
 * It does not call Coinbase and it does not broadcast.
 *
 * args: cert key portFile eventsFile modeFile sock
 */
import { createServer as createHttps } from 'node:https'
import { createServer as createHttp } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'

const [certPath, keyPath, portFile, eventsFile, modeFile, sock] = process.argv.slice(2)
let fxFailsLeft = 2
let ethPrice = 2000
let lockedArmed = true

function event(line) {
	appendFileSync(eventsFile, `${Date.now()} ${line}\n`)
}

function mode() {
	try {
		return readFileSync(modeFile, 'utf8').trim()
	} catch {
		return 'retry'
	}
}

function fxBody() {
	return JSON.stringify({
		data: {
			currency: 'USD',
			rates: { CAD: '1.36', JPY: '150.1', CNY: '7.2', HKD: '7.8', EUR: '0.92', SGD: '1.34', TWD: '32.1' },
		},
	})
}

function ethBody() {
	ethPrice += 10
	return JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: String(ethPrice) } })
}

const httpsServer = createHttps({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
	const current = mode()
	if (req.url === '/fx' && current === 'retry' && fxFailsLeft > 0) {
		fxFailsLeft -= 1
		event(`fx 503 left=${fxFailsLeft}`)
		res.writeHead(503, { 'content-type': 'text/plain' })
		res.end('unavailable')
		return
	}
	const body = req.url === '/eth' ? ethBody() : fxBody()
	event(`${req.url === '/eth' ? 'eth' : 'fx'} 200`)
	res.writeHead(200, { 'content-type': 'application/json' })
	res.end(body)
})

const signer = createHttp((req, res) => {
	const chunks = []
	req.on('data', (chunk) => chunks.push(chunk))
	req.on('end', () => {
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		const data = String(body?.params?.data ?? '')
		const current = mode()
		if (current === 'locked-once' && lockedArmed) {
			lockedArmed = false
			event(`signer locked ${data.slice(0, 10)} ${data.length}`)
			res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'signer locked' } }))
			return
		}
		event(`signer ok ${data.slice(0, 10)} ${data.length} chain=${body?.params?.chainId} to=${body?.params?.to} value=${body?.params?.value} array=${body?.params?.keyArray}`)
		res.end(JSON.stringify({
			jsonrpc: '2.0',
			id: body.id,
			result: { hash: `0x${'ab'.repeat(32)}` },
		}))
	})
})

signer.listen(sock, () => {
	httpsServer.listen(0, '127.0.0.1', () => {
		const port = httpsServer.address().port
		writeFileSync(portFile, String(port))
		event(`ready port=${port}`)
	})
})
