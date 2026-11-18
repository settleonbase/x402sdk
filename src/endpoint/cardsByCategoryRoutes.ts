/**
 * GET /api/cardsByCategory 的路由注册函数（可导入，无顶层副作用）。
 * - 生产文件（beamioServer.ts、beamioMaster.ts）调用这里的函数完成注册；
 * - 联测直接调用同一函数，使用真实的 express Router，不替换路由本身。
 * 依赖（DB 聚合、过滤、缓存、generation、日志）全部由调用方注入。
 */
import type { Request, Response, Router } from 'express'
import {
	CARDS_BY_CATEGORY_FILTER_HEADER,
	CARDS_BY_CATEGORY_FILTER_VERSION,
	createCardsByCategoryHandler,
} from './cardsByCategoryProxy'

/** Cluster 侧：透传到本机回环的 Master 入口，并要求 Master 的过滤标记（见 cardsByCategoryProxy.ts）。 */
export const registerCardsByCategoryClusterRoute = (
	router: Router,
	opts: { masterPort: number; timeoutMs?: number; log?: (line: string) => void },
): void => {
	router.get(
		'/cardsByCategory',
		createCardsByCategoryHandler({
			masterPort: opts.masterPort,
			timeoutMs: opts.timeoutMs,
			log: opts.log,
			requiredResponseHeader: { name: CARDS_BY_CATEGORY_FILTER_HEADER, value: CARDS_BY_CATEGORY_FILTER_VERSION },
		}),
	)
}

export type CardsByCategoryMasterDeps = {
	/** 原始聚合（DB）。 */
	computeRawGroups: (args: { scanLimit: number; limitPerCategory: number }) => Promise<unknown[]>
	/** Discover 过滤（exclude、切点、agent temp fail-closed）。 */
	filter: (raw: unknown[]) => Promise<unknown[]>
	cache: Map<string, { groups: unknown[]; expiry: number }>
	ttlMs: number
	getGeneration: () => number
	log: (line: string, err: unknown) => void
}

/** Master 侧：过滤后返回，并在 200 响应上带过滤标记。 */
export const registerCardsByCategoryMasterRoute = (router: Router, deps: CardsByCategoryMasterDeps): void => {
	router.get('/cardsByCategory', async (req: Request, res: Response) => {
		const scanLimit = Math.min(parseInt(String(req.query.scanLimit || 800), 10) || 800, 3000)
		const limitPerCategory = Math.min(parseInt(String(req.query.limitPerCategory || 80), 10) || 80, 500)
		const cacheKey = `scan:${scanLimit}:per:${limitPerCategory}`
		const cached = deps.cache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			res.setHeader(CARDS_BY_CATEGORY_FILTER_HEADER, CARDS_BY_CATEGORY_FILTER_VERSION)
			return res.status(200).json({ groups: cached.groups })
		}
		try {
			const gen = deps.getGeneration()
			const rawGroups = await deps.computeRawGroups({ scanLimit, limitPerCategory })
			const groups = await deps.filter(rawGroups)
			// generation 守卫：缓存在计算期间被失效时，不把旧结果写入缓存。
			if (gen === deps.getGeneration()) {
				deps.cache.set(cacheKey, { groups, expiry: Date.now() + deps.ttlMs })
			}
			res.setHeader(CARDS_BY_CATEGORY_FILTER_HEADER, CARDS_BY_CATEGORY_FILTER_VERSION)
			res.status(200).json({ groups })
		} catch (e: any) {
			deps.log('[cardsByCategory] error:', e?.message ?? e)
			res.status(503).json({ error: e?.message ?? 'cardsByCategory failed' })
		}
	})
}
