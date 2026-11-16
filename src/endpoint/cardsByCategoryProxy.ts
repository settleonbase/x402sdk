import type { Request, RequestHandler, Response } from 'express'
import { request } from 'node:http'

/** 原样转发给 Master GET /api/cardsByCategory 的查询参数。其他参数一律丢弃。 */
export const CARDS_BY_CATEGORY_QUERY_KEYS: readonly string[] = ['scanLimit', 'limitPerCategory']

/**
 * 上游（Master）总耗时默认上限，**候选值 45 秒，待项目方确认**。
 * 缓存未命中时 Master 要扫描 DB 并顺序读取链上 agent temp 注册表（每批 80 个 owner）；
 * 1200 个 owner、单次 RPC 2 秒时链上段约 30 秒（见待审单第 11 节）。线上 nginx /api/ 的 proxy_read_timeout 须大于该值。
 */
export const CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS = 45_000
/** 环境变量可配置的上限，防止误配成极大值使请求长期挂起。 */
export const CARDS_BY_CATEGORY_MAX_UPSTREAM_TIMEOUT_MS = 120_000

/**
 * 解析 CARDS_BY_CATEGORY_UPSTREAM_TIMEOUT_MS。未设置或非法（非正整数）时用默认值；超过上限时截断到上限。
 */
export const resolveCardsByCategoryUpstreamTimeoutMs = (raw: string | undefined): number => {
	const n = Number((raw ?? '').trim())
	if (!Number.isInteger(n) || n <= 0) return CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS
	return Math.min(n, CARDS_BY_CATEGORY_MAX_UPSTREAM_TIMEOUT_MS)
}

/**
 * 从 req.url（路由内视角，形如 `/cardsByCategory?scanLimit=10&x=1`）中只保留允许的参数对。
 * 每一对保持原始编码、原始顺序，不解码也不重新编码。无可保留参数时返回空串。
 */
export const pickCardsByCategoryQuery = (rawUrl: string): string => {
	const q = rawUrl.indexOf('?')
	if (q < 0) return ''
	const kept: string[] = []
	for (const pair of rawUrl.slice(q + 1).split('&')) {
		if (!pair) continue
		const eq = pair.indexOf('=')
		const rawKey = eq < 0 ? pair : pair.slice(0, eq)
		let key: string
		try {
			key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
		} catch {
			continue
		}
		if (CARDS_BY_CATEGORY_QUERY_KEYS.includes(key)) kept.push(pair)
	}
	return kept.length ? `?${kept.join('&')}` : ''
}

/**
 * Cluster 侧 GET /api/cardsByCategory：透传 Master。
 * - 转发目标固定为 localhost:masterPort 的 /api/cardsByCategory，调用方只能影响允许的查询参数。
 * - 同时复制 Master 的 HTTP 状态码与 Content-Type，使错误语义与 Master 一致。
 * - Master 不可达返回 502；上游超过 timeoutMs 返回 504 并销毁上游请求。
 * - 客户端在响应完成前断开时，销毁上游请求。
 * - 不做鉴权、不做缓存；Discover 过滤在 Master 侧完成（见 cardsByCategoryDiscover.ts），本层不改写响应体。
 */
export const createCardsByCategoryHandler = (opts: {
	masterPort: number
	log?: (line: string) => void
	timeoutMs?: number
}): RequestHandler => {
	const timeoutMs = opts.timeoutMs ?? CARDS_BY_CATEGORY_DEFAULT_UPSTREAM_TIMEOUT_MS
	return (req: Request, res: Response) => {
		const path = `/api/cardsByCategory${pickCardsByCategoryQuery(req.url)}`
		let timedOut = false
		let clientGone = false
		const upstream = request({ hostname: 'localhost', port: opts.masterPort, path, method: 'GET' }, (masterRes) => {
			clearTimeout(timer)
			res.status(masterRes.statusCode ?? 502)
			const contentType = masterRes.headers['content-type']
			if (contentType) res.setHeader('Content-Type', contentType)
			masterRes.on('error', () => res.destroy())
			masterRes.pipe(res)
		})
		const timer = setTimeout(() => {
			timedOut = true
			upstream.destroy(new Error(`master response timeout after ${timeoutMs}ms`))
		}, timeoutMs)
		upstream.on('error', (e) => {
			clearTimeout(timer)
			if (clientGone) return
			if (res.headersSent) {
				res.destroy()
				return
			}
			if (timedOut) {
				opts.log?.(`cardsByCategory master timeout after ${timeoutMs}ms`)
				res.status(504).end()
				return
			}
			opts.log?.(`cardsByCategory forward to master failed: ${e.message}`)
			res.status(502).end()
		})
		res.on('close', () => {
			clearTimeout(timer)
			if (!res.writableFinished) {
				clientGone = true
				upstream.destroy()
			}
		})
		upstream.end()
	}
}
