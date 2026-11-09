import http from 'node:http'

const STAGING_NAME = '_acme-challenge.dle-dns01-staging.conet.network'
const PRODUCTION_NAME = '_acme-challenge.dle.conet.network'
const ALLOWED_NAMES = new Set([STAGING_NAME, PRODUCTION_NAME])
const CHALLENGE_NAME = STAGING_NAME
const records = new Map([['preexisting', { type: 'TXT', name: CHALLENGE_NAME, preexisting: true }]])
const trace = { posts: 0, deletes: 0, lists: 0, rejected: 0, authSeen: 0, stagingPosts: 0, productionPosts: 0 }
let nextId = 1

function send(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
	res.end(payload)
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url || '/', 'http://127.0.0.1')
	if (req.method === 'GET' && url.pathname === '/status') {
		send(res, 200, {
			posts: trace.posts,
			deletes: trace.deletes,
			lists: trace.lists,
			rejected: trace.rejected,
			authSeen: trace.authSeen,
			stagingPosts: trace.stagingPosts,
			productionPosts: trace.productionPosts,
			remaining: records.size,
			preexisting: records.has('preexisting'),
		})
		return
	}
	if (req.method === 'GET') {
		trace.lists += 1
		send(res, 405, { success: false })
		return
	}
	const auth = req.headers.authorization || ''
	if (auth.startsWith('Bearer ')) trace.authSeen += 1
	if (!auth.startsWith('Bearer ') || auth.length < 12) {
		trace.rejected += 1
		send(res, 401, { success: false })
		return
	}
	const parts = url.pathname.split('/').filter(Boolean)
	if (req.method === 'POST' && parts.length === 5 && parts[0] === 'client' && parts[1] === 'v4' && parts[2] === 'zones' && parts[4] === 'dns_records') {
		const chunks = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			let body
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			} catch {
				trace.rejected += 1
				send(res, 400, { success: false })
				return
			}
			if (body.type !== 'TXT' || !ALLOWED_NAMES.has(body.name) || body.ttl !== 60 || !body.content) {
				trace.rejected += 1
				send(res, 400, { success: false })
				return
			}
			const id = `rec-${nextId}`
			nextId += 1
			records.set(id, { type: 'TXT', name: body.name, preexisting: false })
			trace.posts += 1
			if (body.name === PRODUCTION_NAME) trace.productionPosts += 1
			if (body.name === STAGING_NAME) trace.stagingPosts += 1
			send(res, 200, { success: true, result: { id, type: 'TXT', name: body.name } })
		})
		return
	}
	if (req.method === 'DELETE' && parts.length === 5 && parts[0] === 'client' && parts[1] === 'v4' && parts[2] === 'zones' && parts[4] === 'dns_records') {
		trace.rejected += 1
		send(res, 404, { success: false })
		return
	}
	if (req.method === 'DELETE' && parts.length === 6 && parts[0] === 'client' && parts[1] === 'v4' && parts[2] === 'zones' && parts[4] === 'dns_records') {
		const id = parts[5]
		if (!records.has(id) || records.get(id).preexisting) {
			trace.rejected += 1
			send(res, 404, { success: false })
			return
		}
		records.delete(id)
		trace.deletes += 1
		send(res, 200, { success: true })
		return
	}
	trace.rejected += 1
	send(res, 404, { success: false })
})

server.listen(0, '127.0.0.1', () => {
	const { port } = server.address()
	process.stdout.write(`stub-listen 127.0.0.1:${port}\n`)
})
