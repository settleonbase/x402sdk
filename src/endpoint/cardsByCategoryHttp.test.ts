// 本地 HTTP 联测（合成数据 + 桩）：真实的 Cluster 透传处理器 → Master 替身（真实的 Discover 过滤与
// fail-closed agent temp 判定）→ 桩 RPC。
// 不启动 beamioServer.ts / beamioMaster.ts（依赖链过重），Master 替身复刻候选路由的处理顺序，因此覆盖的是 HTTP 行为与过滤逻辑，不是整进程。
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { registerHooks } from 'node:module'
import test from 'node:test'
import express from 'express'
import type { BeamioLatestCardItem } from '../db.ts'

const STUB_SOURCES: Record<string, string> = {
	'/src/beamioUserCardChain.ts': [
		'export const providerForUserCardChain = () => globalThis.__cardsByCategoryHttpRpc',
		"export const resolveUserCardChain = async () => 'conet'",
		'',
	].join('\n'),
}
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context)
		} catch (err) {
			if (/\.[cm]?[jt]s$/.test(specifier) || specifier.startsWith('node:')) throw err
			for (const ext of ['.ts', '.js']) {
				try {
					return nextResolve(`${specifier}${ext}`, context)
				} catch {
					// 尝试下一个扩展名
				}
			}
			throw err
		}
	},
	load(url, context, nextLoad) {
		for (const suffix of Object.keys(STUB_SOURCES)) {
			if (url.endsWith(suffix)) return { format: 'module', source: STUB_SOURCES[suffix], shortCircuit: true }
		}
		return nextLoad(url, context)
	},
})

const { ethers } = await import('ethers')
const { createCardsByCategoryHandler, CARDS_BY_CATEGORY_FILTER_HEADER, CARDS_BY_CATEGORY_FILTER_VERSION } = await import('./cardsByCategoryProxy.ts')
const { filterCardsByCategoryGroupsForDiscover } = await import('./cardsByCategoryDiscover.ts')
const { omitCardsOwnedByUnhandedAgentTempFailClosed, clearAgentTempVisibleVerdictCache } = await import('./agentTempDiscoverVisibility.ts')

// ---- 合成数据与 RPC 桩 ----
const REGISTRY_IFACE = new ethers.Interface([
	'function agentOfTemp(address) view returns (address)',
	'function tempHandedOff(address) view returns (bool)',
])
const MULTICALL_IFACE = new ethers.Interface([
	'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
])
const AGENT_OF_TEMP_SELECTOR = REGISTRY_IFACE.getFunction('agentOfTemp')!.selector
const rpc = {
	mode: 'answer' as 'answer' | 'fail',
	hiddenOwners: new Set<string>(),
	calls: 0,
}
globalThis.__cardsByCategoryHttpRpc = {
	call: async (tx: { data: string }) => {
		rpc.calls += 1
		if (rpc.mode === 'fail') throw new Error('rpc unavailable (test stub)')
		const [calls] = MULTICALL_IFACE.decodeFunctionData('aggregate3', tx.data)
		const results = calls.map((c: { callData: string }) => {
			if (c.callData.slice(0, 10) === AGENT_OF_TEMP_SELECTOR) {
				const owner = REGISTRY_IFACE.decodeFunctionData('agentOfTemp', c.callData)[0] as string
				const agent = rpc.hiddenOwners.has(owner.toLowerCase()) ? '0x0000000000000000000000000000000000000001' : ethers.ZeroAddress
				return [true, REGISTRY_IFACE.encodeFunctionResult('agentOfTemp', [agent])]
			}
			return [true, REGISTRY_IFACE.encodeFunctionResult('tempHandedOff', [false])]
		})
		return MULTICALL_IFACE.encodeFunctionResult('aggregate3', [results])
	},
}

const OWNER = '0x00000000000000000000000000000000000000aa' // 普通卡主，链上可见
const TEMP_OWNER = '0x00000000000000000000000000000000000000bb' // 未移交的 agent temp，链上隐藏
const EXCLUDED = '0xbccfa50d2a5917c7a8662177f5f4b7a175787270' // API_EXCLUDED 名单（合成卡地址）
const NORMAL = '0x1111111111111111111111111111111111111111'
const TEMP_CARD = '0x2222222222222222222222222222222222222222'
const OLD_CARD = '0x3333333333333333333333333333333333333333' // cutover 之前
const NEW = '2026-06-01T00:00:00.000Z'
const BEFORE_CUTOVER = '2026-05-23T00:29:59.999Z'

const card = (cardAddress: string, createdAt: string, cardOwner: string): BeamioLatestCardItem => ({
	cardAddress,
	cardOwner,
	currency: 'USDC',
	priceInCurrencyE6: '1000000',
	uri: null,
	metadata: null,
	txHash: null,
	totalPointsMinted6: '0',
	holderCount: 0,
	createdAt,
})

/** 合成的 Master 聚合原始结果（过滤前）。 */
const syntheticRawGroups = () => [
	{
		categoryId: 'food',
		items: [card(NORMAL, NEW, OWNER), card(TEMP_CARD, NEW, TEMP_OWNER), card(EXCLUDED, NEW, OWNER), card(OLD_CARD, BEFORE_CUTOVER, OWNER)],
	},
	{ categoryId: 'drink', items: [card(TEMP_CARD, NEW, TEMP_OWNER)] },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const listen = (app: express.Express): Promise<{ server: Server; port: number }> =>
	new Promise((resolve) => {
		const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
	})
const close = (server: Server): Promise<void> =>
	new Promise((resolve) => {
		server.closeAllConnections?.()
		server.close(() => resolve())
	})

/** 搭建一套 Cluster 替身 + Master 替身。Master 替身复用真实 resolver、过滤与 fail-closed 判定。 */
const startStack = async (opts: { masterDelayMs?: number; clusterTimeoutMs: number; raw?: () => unknown[]; filterMarker?: boolean }) => {
	const masterReceived: string[] = []
	const raw = opts.raw ?? syntheticRawGroups
	// Master 替身：与候选 beamioMaster 路由的处理顺序相同（聚合 → Discover 过滤 → 写缓存），缓存为本地 Map。
	const cache = new Map<string, { groups: unknown[]; expiry: number }>()
	const compute = async (): Promise<unknown[]> => {
		if (opts.masterDelayMs) await sleep(opts.masterDelayMs)
		return filterCardsByCategoryGroupsForDiscover(raw() as any, { omitUnhandedAgentTemp: omitCardsOwnedByUnhandedAgentTempFailClosed })
	}
	const master = express()
	master.get('/api/cardsByCategory', async (req, res) => {
		masterReceived.push(req.url.split('?')[1] ?? '')
		const scanLimit = Math.min(parseInt(String(req.query.scanLimit || 800), 10) || 800, 3000)
		const limitPerCategory = Math.min(parseInt(String(req.query.limitPerCategory || 80), 10) || 80, 500)
		const cacheKey = `scan:${scanLimit}:per:${limitPerCategory}`
		const cached = cache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			if (opts.filterMarker !== false) res.setHeader(CARDS_BY_CATEGORY_FILTER_HEADER, CARDS_BY_CATEGORY_FILTER_VERSION)
			return res.status(200).json({ groups: cached.groups })
		}
		try {
			const groups = await compute()
			cache.set(cacheKey, { groups, expiry: Date.now() + 30_000 })
			if (opts.filterMarker !== false) res.setHeader(CARDS_BY_CATEGORY_FILTER_HEADER, CARDS_BY_CATEGORY_FILTER_VERSION)
			res.status(200).json({ groups })
		} catch (e: any) {
			res.status(503).json({ error: e?.message ?? 'cardsByCategory failed' })
		}
	})
	const m = await listen(master)
	const cluster = express()
	cluster.get('/api/cardsByCategory', createCardsByCategoryHandler({ masterPort: m.port, timeoutMs: opts.clusterTimeoutMs, requiredResponseHeader: { name: CARDS_BY_CATEGORY_FILTER_HEADER, value: CARDS_BY_CATEGORY_FILTER_VERSION } }))
	const c = await listen(cluster)
	return {
		clusterPort: c.port,
		masterReceived,
		stop: async () => {
			await close(c.server)
			await close(m.server)
		},
	}
}

const getJson = async (port: number, path: string) => {
	const r = await fetch(`http://127.0.0.1:${port}${path}`)
	const text = await r.text()
	let body: unknown = text
	try {
		body = JSON.parse(text)
	} catch {
		// 非 JSON 正文保持原文
	}
	return { status: r.status, body }
}

const ownersOf = (groups: any[]) => groups.map((g) => [g.categoryId, g.items.map((i: any) => i.cardAddress)])

test.beforeEach(() => {
	rpc.mode = 'answer'
	rpc.hiddenOwners.clear()
	rpc.calls = 0
	clearAgentTempVisibleVerdictCache()
})

test('healthy path: allowed params are forwarded, excluded/pre-cutover/hidden-owner cards are removed, empty groups dropped', async () => {
	rpc.hiddenOwners.add(TEMP_OWNER.toLowerCase())
	const s = await startStack({ clusterTimeoutMs: 5_000 })
	try {
		const r = await getJson(s.clusterPort, '/api/cardsByCategory?scanLimit=1200&limitPerCategory=120')
		assert.equal(r.status, 200)
		assert.deepEqual(ownersOf((r.body as any).groups), [['food', [NORMAL]]])
		assert.equal(s.masterReceived[0], 'scanLimit=1200&limitPerCategory=120')
		assert.ok(rpc.calls > 0, 'the registry read path ran')
	} finally {
		await s.stop()
	}
})

test('only scanLimit and limitPerCategory are forwarded; other query keys are dropped at the Cluster', async () => {
	const s = await startStack({ clusterTimeoutMs: 5_000 })
	try {
		const r = await getJson(s.clusterPort, '/api/cardsByCategory?scanLimit=5&evil=x&limitPerCategory=2&owner=0x1')
		assert.equal(r.status, 200)
		assert.equal(s.masterReceived[0], 'scanLimit=5&limitPerCategory=2')
	} finally {
		await s.stop()
	}
})

test('a valid query with no qualifying cards returns 200 with an empty groups array', async () => {
	const s = await startStack({ clusterTimeoutMs: 5_000, raw: () => [] })
	try {
		const r = await getJson(s.clusterPort, '/api/cardsByCategory?scanLimit=1&limitPerCategory=1')
		assert.equal(r.status, 200)
		assert.deepEqual(r.body, { groups: [] })
	} finally {
		await s.stop()
	}
})

test('RPC failure is fail-closed end to end: no verified owner means no card is shown', async () => {
	rpc.mode = 'fail'
	const s = await startStack({ clusterTimeoutMs: 5_000 })
	try {
		const r = await getJson(s.clusterPort, '/api/cardsByCategory?scanLimit=1200&limitPerCategory=120')
		assert.equal(r.status, 200)
		assert.deepEqual(r.body, { groups: [] })
	} finally {
		await s.stop()
	}
})

test('a Master slower than the Cluster timeout yields 504 at the Cluster', async () => {
	const s = await startStack({ clusterTimeoutMs: 200, masterDelayMs: 1_000 })
	try {
		const r = await getJson(s.clusterPort, '/api/cardsByCategory?scanLimit=1200&limitPerCategory=120')
		assert.equal(r.status, 504)
	} finally {
		await s.stop()
	}
})

test('an unreachable Master yields 502 at the Cluster', async () => {
	const app = express()
	app.get('/api/cardsByCategory', createCardsByCategoryHandler({ masterPort: 1, timeoutMs: 1_000 }))
	const c = await listen(app)
	try {
		const r = await getJson(c.port, '/api/cardsByCategory?scanLimit=1&limitPerCategory=1')
		assert.equal(r.status, 502)
	} finally {
		await close(c.server)
	}
})

test('an unfiltered (old) Master cannot leak cards: the Cluster answers 503 and forwards no card data', async () => {
	const s2 = await startStack({ clusterTimeoutMs: 5_000, filterMarker: false })
	try {
		const r = await getJson(s2.clusterPort, '/api/cardsByCategory?scanLimit=1200&limitPerCategory=120')
		assert.equal(r.status, 503)
		assert.equal(JSON.stringify(r.body).includes(NORMAL), false, 'no card address reaches the client')
	} finally {
		await s2.stop()
	}
})
