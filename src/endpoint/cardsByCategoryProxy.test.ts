import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import express from 'express'
import {
	createCardsByCategoryHandler,
	CARDS_BY_CATEGORY_FILTER_HEADER,
	CARDS_BY_CATEGORY_FILTER_VERSION,
	pickCardsByCategoryQuery,
	resolveCardsByCategoryUpstreamTimeoutMs,
	CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS,
	CARDS_BY_CATEGORY_MAX_UPSTREAM_TIMEOUT_MS,
} from './cardsByCategoryProxy.ts'

const listen = (server: Server): Promise<number> =>
	new Promise((resolve) => {
		server.listen(0, 'localhost', () => resolve((server.address() as AddressInfo).port))
	})

const close = (server: Server): Promise<void> =>
	new Promise((resolve) => {
		server.closeAllConnections?.()
		server.close(() => resolve())
	})

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error('condition not met in time')
		await new Promise((r) => setTimeout(r, 10))
	}
}

type StubMode = 'ok' | 'err500' | 'notfound' | 'hang'

/** 桩 Master：记录收到的路径与是否被上游中止，按 mode 返回固定响应。 */
const startStubMaster = async (mode: StubMode) => {
	const received: string[] = []
	const state = { aborted: false }
	const groups = {
		groups: [
			{
				categoryId: 'food',
				items: [{ cardAddress: '0x0000000000000000000000000000000000000001', name: 'Demo', currency: 'USD' }],
			},
		],
	}
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		received.push(req.url ?? '')
		if (mode === 'hang') {
			res.on('close', () => {
				if (!res.writableFinished) state.aborted = true
			})
			return
		}
		if (!(req.url ?? '').startsWith('/api/cardsByCategory')) {
			res.writeHead(404, { 'Content-Type': 'text/plain' })
			return res.end('not found')
		}
		if (mode === 'err500') {
			res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
			return res.end('<pre>Internal Server Error</pre>')
		}
		if (mode === 'notfound') {
			res.writeHead(404, { 'Content-Type': 'text/html' })
			return res.end('<pre>Cannot GET /api/cardsByCategory</pre>')
		}
		res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
		res.end(JSON.stringify(groups))
	})
	const port = await listen(server)
	return { server, port, received, state }
}

/** 被测 Server：与 beamioServer 相同的挂载方式（router 挂在 /api 下）。 */
const startServer = async (masterPort: number, timeoutMs?: number) => {
	const app = express()
	const router = express.Router()
	router.get('/cardsByCategory', createCardsByCategoryHandler({ masterPort, timeoutMs }))
	app.use('/api', router)
	const server = createServer(app)
	const port = await listen(server)
	return { server, port }
}

test('pickCardsByCategoryQuery keeps only the two allowed pairs, raw and in order', () => {
	assert.equal(pickCardsByCategoryQuery('/cardsByCategory'), '')
	assert.equal(pickCardsByCategoryQuery('/cardsByCategory?foo=1'), '')
	assert.equal(
		pickCardsByCategoryQuery('/cardsByCategory?scanLimit=10&foo=1&limitPerCategory=%35&scanLimit=2'),
		'?scanLimit=10&limitPerCategory=%35&scanLimit=2',
	)
	assert.equal(pickCardsByCategoryQuery('/cardsByCategory?scanLimit'), '?scanLimit')
	assert.equal(pickCardsByCategoryQuery('/cardsByCategory?scanLimit=1+0'), '?scanLimit=1+0')
})

test('resolveCardsByCategoryUpstreamTimeoutMs: default when unset or invalid, capped at maximum', () => {
	assert.equal(resolveCardsByCategoryUpstreamTimeoutMs(undefined), CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS)
	assert.equal(resolveCardsByCategoryUpstreamTimeoutMs(''), CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS)
	assert.equal(resolveCardsByCategoryUpstreamTimeoutMs('abc'), CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS)
	assert.equal(resolveCardsByCategoryUpstreamTimeoutMs('-5'), CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS)
	assert.equal(resolveCardsByCategoryUpstreamTimeoutMs('1.5'), CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS)
	assert.equal(resolveCardsByCategoryUpstreamTimeoutMs('5000'), 5000)
	assert.equal(resolveCardsByCategoryUpstreamTimeoutMs('999999999'), CARDS_BY_CATEGORY_MAX_UPSTREAM_TIMEOUT_MS)
})

// P1 正向：状态码、Content-Type、响应体与直接访问 Master 一致
test('P1 positive: Server returns the same status, type and body as Master', async () => {
	const master = await startStubMaster('ok')
	const srv = await startServer(master.port)
	try {
		const query = '?scanLimit=10&limitPerCategory=5'
		const viaServer = await fetch(`http://localhost:${srv.port}/api/cardsByCategory${query}`)
		const direct = await fetch(`http://localhost:${master.port}/api/cardsByCategory${query}`)
		assert.equal(viaServer.status, direct.status)
		assert.equal(viaServer.headers.get('content-type'), direct.headers.get('content-type'))
		assert.equal(await viaServer.text(), await direct.text())
		assert.deepEqual(master.received, [`/api/cardsByCategory${query}`, `/api/cardsByCategory${query}`])
	} finally {
		await close(srv.server)
		await close(master.server)
	}
})

// P2 参数异常：合法键的原始值原样转发，其他键丢弃，由 Master 决定如何处理
test('P2 abnormal params: allowed keys forwarded raw, other keys dropped', async () => {
	const master = await startStubMaster('ok')
	const srv = await startServer(master.port)
	try {
		const res = await fetch(
			`http://localhost:${srv.port}/api/cardsByCategory?scanLimit=abc&limitPerCategory=-5&scanLimit=%ZZ&evil=1`,
		)
		assert.equal(res.status, 200)
		await res.text()
		assert.deepEqual(master.received, ['/api/cardsByCategory?scanLimit=abc&limitPerCategory=-5&scanLimit=%ZZ'])
	} finally {
		await close(srv.server)
		await close(master.server)
	}
})

test('only scanLimit and limitPerCategory reach Master; other params are dropped', async () => {
	const master = await startStubMaster('ok')
	const srv = await startServer(master.port)
	try {
		const res = await fetch(`http://localhost:${srv.port}/api/cardsByCategory?foo=bar&scanLimit=3000&x=1`)
		assert.equal(res.status, 200)
		await res.text()
		assert.deepEqual(master.received, ['/api/cardsByCategory?scanLimit=3000'])
	} finally {
		await close(srv.server)
		await close(master.server)
	}
})

// P3 Master 500 与 404：状态码、Content-Type、正文原样透传（不得被 200 掩盖）
test('P3 Master 500 and 404 pass through with status, type and body', async () => {
	for (const mode of ['err500', 'notfound'] as const) {
		const master = await startStubMaster(mode)
		const srv = await startServer(master.port)
		try {
			const viaServer = await fetch(`http://localhost:${srv.port}/api/cardsByCategory`)
			const direct = await fetch(`http://localhost:${master.port}/api/cardsByCategory`)
			assert.equal(direct.status, mode === 'err500' ? 500 : 404)
			assert.equal(viaServer.status, direct.status, mode)
			assert.equal(viaServer.headers.get('content-type'), direct.headers.get('content-type'), mode)
			assert.equal(await viaServer.text(), await direct.text(), mode)
		} finally {
			await close(srv.server)
			await close(master.server)
		}
	}
})

// P4 Master 不可达：502
test('P4 Master unreachable returns 502', async () => {
	// 先占一个端口再关闭，得到一个确定无人监听的端口
	const probe = createServer()
	const deadPort = await listen(probe)
	await close(probe)
	const srv = await startServer(deadPort)
	try {
		const res = await fetch(`http://localhost:${srv.port}/api/cardsByCategory`)
		assert.equal(res.status, 502)
		await res.text()
	} finally {
		await close(srv.server)
	}
})

// P5 目标固定：调用方的请求头不能改变转发目标
test('P5 target is fixed: caller-supplied header cannot redirect forwarding', async () => {
	const master = await startStubMaster('ok')
	const rogue = await startStubMaster('ok')
	const srv = await startServer(master.port)
	try {
		const res = await fetch(`http://localhost:${srv.port}/api/cardsByCategory?scanLimit=1`, {
			headers: { 'x-master-port': String(rogue.port), 'x-forwarded-host': 'evil.example' },
		})
		assert.equal(res.status, 200)
		await res.text()
		assert.equal(rogue.received.length, 0, 'request must not reach a non-Master target')
		assert.equal(master.received.length, 1)
	} finally {
		await close(srv.server)
		await close(master.server)
		await close(rogue.server)
	}
})

test('upstream that never answers returns 504 within the timeout and aborts the upstream request', { timeout: 10000 }, async () => {
	const master = await startStubMaster('hang')
	const srv = await startServer(master.port, 150)
	try {
		const started = Date.now()
		const res = await fetch(`http://localhost:${srv.port}/api/cardsByCategory`, { signal: AbortSignal.timeout(5000) })
		assert.equal(res.status, 504)
		await res.text()
		assert.ok(Date.now() - started < 3000, 'must answer shortly after the timeout')
		await until(() => master.state.aborted)
	} finally {
		await close(srv.server)
		await close(master.server)
	}
})

test('client disconnect before the response destroys the upstream request', { timeout: 10000 }, async () => {
	const master = await startStubMaster('hang')
	const srv = await startServer(master.port)
	try {
		const ac = new AbortController()
		const pending = fetch(`http://localhost:${srv.port}/api/cardsByCategory`, { signal: ac.signal }).catch(() => null)
		await until(() => master.received.length === 1)
		ac.abort()
		await pending
		await until(() => master.state.aborted)
	} finally {
		await close(srv.server)
		await close(master.server)
	}
})


// ---- 过滤标记守卫：Master 未过滤（无标记）或路由未挂载（404）时，Cluster 明示 503，绝不转发正文 ----
const markerMaster = (upstreamStatus: number, headers: Record<string, string>, body: string): Server =>
	createServer((_req, res) => {
		res.writeHead(upstreamStatus, { 'content-type': 'application/json', ...headers })
		res.end(body)
	})
const clusterServer = (masterPort: number): Server => {
	const app = express()
	app.get('/api/cardsByCategory', createCardsByCategoryHandler({ masterPort, timeoutMs: 2_000, requiredResponseHeader: { name: CARDS_BY_CATEGORY_FILTER_HEADER, value: CARDS_BY_CATEGORY_FILTER_VERSION } }))
	return createServer(app)
}
const withMarkerStack = async (
	upstream: Server,
	run: (clusterPort: number) => Promise<void>,
): Promise<void> => {
	const masterPort = await listen(upstream)
	const cluster = clusterServer(masterPort)
	const clusterPort = await listen(cluster)
	try {
		await run(clusterPort)
	} finally {
		await close(cluster)
		await close(upstream)
	}
}
const CLUSTER_PATH = '/api/cardsByCategory?scanLimit=1&limitPerCategory=1'

test('filter marker: a 200 without the marker is replaced by 503 and its body is never forwarded', async () => {
	await withMarkerStack(markerMaster(200, {}, '{"groups":[{"categoryId":"x","items":[{"cardAddress":"0xSECRETCARD"}]}]}'), async (port) => {
		const r = await fetch(`http://localhost:${port}${CLUSTER_PATH}`)
		const text = await r.text()
		assert.equal(r.status, 503)
		assert.equal(text.includes('0xSECRETCARD'), false)
	})
})

test('filter marker: a 200 carrying the marker is forwarded unchanged', async () => {
	const body = '{"groups":[]}'
	await withMarkerStack(markerMaster(200, { [CARDS_BY_CATEGORY_FILTER_HEADER]: CARDS_BY_CATEGORY_FILTER_VERSION }, body), async (port) => {
		const r = await fetch(`http://localhost:${port}${CLUSTER_PATH}`)
		assert.equal(r.status, 200)
		assert.equal(await r.text(), body)
	})
})

test('filter marker: a 404 from Master (route not mounted) becomes 503', async () => {
	await withMarkerStack(markerMaster(404, {}, 'Cannot GET /api/cardsByCategory'), async (port) => {
		const r = await fetch(`http://localhost:${port}${CLUSTER_PATH}`)
		assert.equal(r.status, 503)
	})
})

test('filter marker: a non-200 from Master (its own 503) passes through unchanged', async () => {
	await withMarkerStack(markerMaster(503, {}, '{"error":"filter failed"}'), async (port) => {
		const r = await fetch(`http://localhost:${port}${CLUSTER_PATH}`)
		assert.equal(r.status, 503)
		assert.equal(await r.text(), '{"error":"filter failed"}')
	})
})
