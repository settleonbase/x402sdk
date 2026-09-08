import Express from 'express'
import { createServer } from 'node:http'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { closeStealthBrowser, stealthFetchHtml } from './stealthBrowserFetch'

const DEFAULT_PORT = 17331
const MAX_QUEUE = 8

const PORT = Number(process.env.BEAMIO_STEALTH_BROWSER_PORT || DEFAULT_PORT) || DEFAULT_PORT

let inflight = 0
let waiting = 0
let chain: Promise<void> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
	if (waiting + inflight >= MAX_QUEUE) {
		return Promise.reject(Object.assign(new Error('stealth_busy'), { code: 'STEALTH_BUSY' }))
	}
	waiting += 1
	const run = chain.then(async () => {
		waiting -= 1
		inflight += 1
		try {
			return await fn()
		} finally {
			inflight -= 1
		}
	})
	chain = run.then(
		() => undefined,
		() => undefined,
	)
	return run
}

const app = Express()
app.disable('x-powered-by')
app.use(Express.json({ limit: '16kb' }))

app.get('/health', (_req, res) => {
	res.json({ ok: true, inflight, waiting, port: PORT })
})

app.post('/fetch', (req, res) => {
	const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
	if (!url) {
		res.status(400).json({ ok: false, error: 'url_required' })
		return
	}
	void enqueue(() => stealthFetchHtml(url))
		.then((got) => {
			if (!got) {
				res.status(502).json({ ok: false, error: 'fetch_failed' })
				return
			}
			res.json({ ok: true, url: got.url, html: got.html, contentLang: got.contentLang })
		})
		.catch((e) => {
			if ((e as { code?: string })?.code === 'STEALTH_BUSY') {
				res.status(503).json({ ok: false, error: 'busy' })
				return
			}
			logger(Colors.yellow('[stealthBrowserDaemon]'), (e as Error)?.message ?? e)
			res.status(502).json({ ok: false, error: 'fetch_failed' })
		})
})

const server = createServer(app)
server.listen(PORT, '127.0.0.1', () => {
	logger(Colors.cyan(`[stealthBrowserDaemon] listening 127.0.0.1:${PORT}`))
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return
	shuttingDown = true
	logger(Colors.yellow(`[stealthBrowserDaemon] ${signal}`))
	server.close()
	await closeStealthBrowser()
	process.exit(0)
}

process.on('SIGINT', () => {
	void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
	void shutdown('SIGTERM')
})
