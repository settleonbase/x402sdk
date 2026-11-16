import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import express from 'express'
import { createCardsByCategoryHandler, pickCardsByCategoryQuery } from './cardsByCategoryProxy.ts'

const listen = (server: Server): Promise<number> =>
	new Promise((resolve) => {
		server.listen(0, 'localhost', () => resolve((server.address() as AddressInfo).port))
	})

const close = (server: Server): Promise<void> =>
	new Promise((resolve) => {
		server.closeAllConnections?.()
		server.close(() => resolve())
	})

/** 桩 Master：记录收到的路径，按 mode 返回固定响应，结构与 Master 的 { groups } 一致。 */
const startStubMaster = async (mode: 'ok' | 'error') => {
	const received: string[] = []
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
		if (!(req.url ?? '').startsWith('/api/cardsByCategory')) {
			res.writeHead(404, { 'Content-Type': 'text/plain' })
			return res.end('not found')
		}
		if (mode === 'error') {
			res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
			return res.end('<pre>Internal Server Error</pre>')
		}
		res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
		res.end(JSON.stringify(groups))
	})
	const port = await listen(server)
	return { server, port, received }
}

/** 被测 Server：与 beamioServer 相同的挂载方式（router 挂在 /api 下）。 */
const startServer = async (masterPort: number) => {
	const app = express()
	const router = express.Router()
	router.get('/cardsByCategory', createCardsByCategoryHandler({ masterPort }))
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

test('Server GET /api/cardsByCategory returns the same status, type and body as Master', async () => {
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

test('Master error status is preserved (no 200 masking)', async () => {
	const master = await startStubMaster('error')
	const srv = await startServer(master.port)
	try {
		const viaServer = await fetch(`http://localhost:${srv.port}/api/cardsByCategory`)
		const direct = await fetch(`http://localhost:${master.port}/api/cardsByCategory`)
		assert.equal(direct.status, 500)
		assert.equal(viaServer.status, 500)
		assert.equal(viaServer.headers.get('content-type'), direct.headers.get('content-type'))
		assert.equal(await viaServer.text(), await direct.text())
	} finally {
		await close(srv.server)
		await close(master.server)
	}
})

test('Master unreachable returns 502', async () => {
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
