// 路由层运行时测试：真实的 db.ts（pg 桩失败）→ 真实的注册函数（Master 直连与 Cluster 公网）→ 503 固定正文、不写缓存、不泄露异常文本。
// 只加载 db.ts 本身；它的直接依赖全部替换为桩（HOME、~/.master.json、签名、网络、数据库一律不触达）：
//   - ./util（masterSetup 为空、RPC 地址为占位）、./logger、pg（Client.connect 抛错）、express（类型）、colors/safe、
//   - 其余本地依赖（链上地址解析、缓存失效、Coupon 元数据工具等）与 JSON ABI。
// 不加载 beamioServer.ts、beamioMaster.ts、MemberCard.ts。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const STUB_BY_SPECIFIER: Record<string, string> = {
	'./util': [
		'export const masterSetup = { beamio_Admins: [], settle_contractAdmin: [], admin: [] }',
		"export const resolveBeamioBaseHttpRpcUrl = () => 'https://stub.invalid/base'",
		'',
	].join('\n'),
	'./logger': "export const logger = (..._args) => {}\n",
	'./chainAddresses': "export const CONET_RPC_URL = 'https://stub.invalid/conet'\n",
	'./couponMetadataCategory': [
		'export const normalizeCouponSeriesMetadataJson = (x) => x',
		'export const normalizeProductionSeriesMetadataJson = (x) => x',
		'export const filterClientCouponSeriesRows = (x) => x',
		'export const filterClientProductionSeriesRows = (x) => x',
		'export const seriesMetadataLooksLikeProduction = () => false',
		'',
	].join('\n'),
	'./apiExcludedUserCards': 'export const isApiExcludedUserCard = () => false\n',
	'./beamioWalletIdentity': 'export const resolveBeamioWalletIdentityFromAddress = async () => null\n',
	'./endpoint/resolveBeamioAaViaUserCardFactory': 'export const resolveBeamioAaOnConet = async () => null\n',
	'./endpoint/latestCardsQueryCache': 'export const invalidateLatestCardsQueryCaches = () => {}\n',
	pg: [
		'export class Client {',
		'  constructor(_opts) {}',
		"  async connect() { throw new Error('database unavailable (test stub)') }",
		'  async query() { throw new Error(\'database unavailable (test stub)\') }',
		'  async end() {}',
		'}',
		'',
	].join('\n'),
	express: 'export const Request = undefined\nexport const Response = undefined\n',
	'colors/safe': "export default { yellow: (s) => s, red: (s) => s, gray: (s) => s }\n",
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const parent = context.parentURL ?? ''
		if (parent.endsWith('/src/db.ts')) {
			if (Object.prototype.hasOwnProperty.call(STUB_BY_SPECIFIER, specifier)) {
				return { url: 'stub:' + specifier, shortCircuit: true }
			}
			if (specifier.endsWith('.json')) return { url: 'stub:json:' + specifier, shortCircuit: true }
		}
		try { return nextResolve(specifier, context) } catch (err) {
			if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
				for (const ext of ['.ts', '.js']) { try { return nextResolve(specifier + ext, context) } catch { /* next */ } }
			}
			throw err
		}
	},
	load(url, context, nextLoad) {
		if (url.startsWith('stub:json:')) return { format: 'module', source: 'export default []\n', shortCircuit: true }
		if (url.startsWith('stub:')) {
			const key = url.slice('stub:'.length)
			if (Object.prototype.hasOwnProperty.call(STUB_BY_SPECIFIER, key)) {
				return { format: 'module', source: STUB_BY_SPECIFIER[key], shortCircuit: true }
			}
		}
		return nextLoad(url, context)
	},
})

import express from 'express'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
const db = await import('../db.ts')
const { registerCardsByCategoryMasterRoute, registerCardsByCategoryClusterRoute } = await import('./cardsByCategoryRoutes.ts')

const listen = (s: Server): Promise<number> => new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))
const close = (s: Server): Promise<void> => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()) })

test('route layer over real db.ts: DB failure gives 503 with the fixed body on Master and Cluster, caches nothing, and never exposes the exception text', async () => {
	const cache = new Map<string, { groups: unknown[]; expiry: number }>()
	const logs: string[] = []
	let computeCalls = 0
	const masterApp = express()
	const masterRouter = express.Router()
	registerCardsByCategoryMasterRoute(masterRouter, {
		computeRawGroups: async (args) => { computeCalls++; return db.getLatestCardsGroupedByCategory(args) },
		filter: async (raw) => raw,
		cache, ttlMs: 30_000, getGeneration: () => 0,
		log: (line, err) => logs.push(`${line} ${String((err as any)?.message ?? err)}`),
	})
	masterApp.use('/api', masterRouter)
	const masterServer = createServer(masterApp)
	const masterPort = await listen(masterServer)
	const clusterApp = express()
	const clusterRouter = express.Router()
	registerCardsByCategoryClusterRoute(clusterRouter, { masterPort, timeoutMs: 5000 })
	clusterApp.use('/api', clusterRouter)
	const clusterServer = createServer(clusterApp)
	const clusterPort = await listen(clusterServer)
	try {
		const direct1 = await fetch(`http://127.0.0.1:${masterPort}/api/cardsByCategory?scanLimit=10&limitPerCategory=5`)
		const body1 = await direct1.text()
		assert.equal(direct1.status, 503)
		assert.deepEqual(JSON.parse(body1), { error: 'cards_by_category_unavailable' })
		assert.equal(body1.includes('database unavailable'), false)
		assert.equal(cache.size, 0, 'a failure must not be cached')
		const direct2 = await fetch(`http://127.0.0.1:${masterPort}/api/cardsByCategory?scanLimit=10&limitPerCategory=5`)
		assert.equal(direct2.status, 503, 'second request recomputes and fails again (not served from cache)')
		assert.deepEqual(JSON.parse(await direct2.clone().text()), { error: 'cards_by_category_unavailable' })
		assert.equal(cache.size, 0, 'still nothing cached after the second failure')
		assert.equal(computeCalls, 2, 'the second request actually recomputed')
		const pub = await fetch(`http://127.0.0.1:${clusterPort}/api/cardsByCategory?scanLimit=10&limitPerCategory=5`)
		const bodyPub = await pub.text()
		assert.equal(pub.status, 503)
		assert.equal(pub.headers.get('content-type')?.includes('application/json') ?? false, true, 'Cluster passes the Master JSON body through')
		assert.deepEqual(JSON.parse(bodyPub), { error: 'cards_by_category_unavailable' })
		assert.equal(bodyPub.includes('database unavailable'), false)
		assert.ok(logs.some((l) => l.includes('database unavailable')), 'exception detail stays in the server log')
	} finally {
		await close(clusterServer)
		await close(masterServer)
	}
})
