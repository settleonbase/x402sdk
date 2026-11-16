import type { Request, RequestHandler, Response } from 'express'
import { request } from 'node:http'

/** 原样转发给 Master GET /api/cardsByCategory 的查询参数。其他参数一律丢弃。 */
export const CARDS_BY_CATEGORY_QUERY_KEYS: readonly string[] = ['scanLimit', 'limitPerCategory']

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
 * 与 getLocalhost 的区别：同时复制 Master 的 HTTP 状态码与 Content-Type，使错误语义与 Master 一致。
 * Master 不可达时返回 502（与 /latestCards 的不可达语义一致）。不做鉴权、不做缓存，缓存只在 Master 侧。
 */
export const createCardsByCategoryHandler = (opts: {
	masterPort: number
	log?: (line: string) => void
}): RequestHandler => {
	return (req: Request, res: Response) => {
		const path = `/api/cardsByCategory${pickCardsByCategoryQuery(req.url)}`
		const upstream = request({ hostname: 'localhost', port: opts.masterPort, path, method: 'GET' }, (masterRes) => {
			res.status(masterRes.statusCode ?? 502)
			const contentType = masterRes.headers['content-type']
			if (contentType) res.setHeader('Content-Type', contentType)
			masterRes.pipe(res)
		})
		upstream.on('error', (e) => {
			opts.log?.(`cardsByCategory forward to master failed: ${e.message}`)
			if (!res.headersSent) res.status(502).end()
		})
		upstream.end()
	}
}
