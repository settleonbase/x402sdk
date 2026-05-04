import express, { Request, Response, Router} from 'express'
import {getClientIp, oracleBackoud, getOracleRequest, masterSetup, resolveBeamioBaseHttpRpcUrl, submitUsdcChargeSettleIndexer} from '../util'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import {addUser, addFollow, removeFollow, regiestChatRoute, ipfsDataPool, ipfsDataProcess, ipfsAccessPool, ipfsAccessProcess, getLatestCards, getLatestCardsGroupedByCategory, getOwnerNftSeries, getSeriesByCardAndTokenId, getMintMetadataForOwner, registerSeriesToDb, registerMintMetadataToDb, searchUsers, FollowerStatus, getMyFollowStatus, getNfcCardByUid, getNfcCardPrivateKeyByUid, registerNfcCardToDb, provisionOrGetNfcWalletByTagId, type BeamioLatestCardItem} from '../db'
import {coinbaseHooks, coinbaseToken, coinbaseOfframp} from '../coinbase'
import { ethers } from 'ethers'
import {
	createMerchantKitCheckoutSession,
	getMerchantKitSessionStatus,
	handleMerchantKitStripeWebhook,
	refreshMerchantKitSessionFromStripe,
} from './merchantKitStripe'
import { purchasingCardPool, purchasingCardProcess, purchasingCardPreCheck, createCardPool, createCardPoolPress, applyBeamioCardShareMetadataUpdate, executeForOwnerPool, executeForOwnerProcess, executeForAdminPool, executeForAdminProcess, cardRedeemPool, cardRedeemProcess, cardRedeemAdminPool, cardRedeemAdminProcess, cardClearAdminMintCounterProcess, cardTerminalSettlementClearProcess, AAtoEOAPool, AAtoEOAProcess, OpenContainerRelayPool, OpenContainerRelayProcess, OpenContainerRelayPreCheck, ContainerRelayPool, ContainerRelayProcess, ContainerRelayPreCheck, ContainerRelayPreCheckUnsigned, beamioTransferIndexerAccountingPool, beamioTransferIndexerAccountingProcess, requestAccountingPool, requestAccountingProcess, cancelRequestAccountingPool, cancelRequestAccountingProcess, claimBUnitsPool, claimBUnitsProcess, buintRedeemAirdropPool, buintRedeemAirdropProcess, businessStartKetRedeemUserRedeemPool, businessStartKetRedeemUserRedeemProcess, businessStartKetRedeemCreatePool, businessStartKetRedeemCreateProcess, businessStartKetRedeemCancelPool, businessStartKetRedeemCancelProcess, removePOSPool, removePOSProcess, registerPOSPool, registerPOSProcess, purchaseBUnitFromBasePool, purchaseBUnitFromBaseProcess, Settle_ContractPool, ensureAAForMintTarget, ensureAAForEOA, signUSDC3009ForNfcTopup, nfcTopupPreparePayload, payByNfcUidOpenContainer, payByNfcUidPrepare, payByNfcUidSignContainer, nfcLinkAppExecute, nfcLinkAppCancelExecute, nfcLinkAppClaimWithKeyExecute, nfcLinkAppPaymentBlockedForMintCalldata, startNfcLinkAppAutoCancelSweeper, signExecuteForAdminWithServiceAdmin, type AAtoEOAUserOp, type OpenContainerRelayPayload, type ContainerRelayPayload, type ContainerRelayPayloadUnsigned, type BeamioTransferRouteItem } from '../MemberCard'
import { BASE_CARD_FACTORY, BASE_CCSA_CARD_ADDRESS } from '../chainAddresses'
import { enrichLatestCardsWithBaseErc1155PointsHolderCounts } from './enrichLatestCardsHolderCounts'
import { LATEST_CARDS_EXCLUDED } from './latestCardsShared'
import { fetchUIDAssetsForEOA, scheduleEnsureNfcBeamioTagForEoa } from './getUIDAssetsLogic'
import { resolveBeamioAaForEoaWithFallback } from './resolveBeamioAaViaUserCardFactory'

const masterServerPort = 1111

/** HTTP 记账 body 中的 routeItems 归一化（与 MemberCard 内存路径一致） */
function normalizeBeamioRouteItemsFromBody(raw: unknown): BeamioTransferRouteItem[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) {
		return undefined
	}
	const out: BeamioTransferRouteItem[] = []
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') {
			continue
		}
		const r = entry as Record<string, unknown>
		const asset = r.asset
		if (typeof asset !== 'string' || !ethers.isAddress(asset)) {
			continue
		}
		if (r.amountE6 == null) {
			continue
		}
		out.push({
			asset: ethers.getAddress(asset),
			amountE6: String(r.amountE6),
			assetType: typeof r.assetType === 'number' && Number.isFinite(r.assetType) ? r.assetType : Number(r.assetType ?? 0),
			source: typeof r.source === 'number' && Number.isFinite(r.source) ? r.source : Number(r.source ?? 0),
			tokenId: r.tokenId != null ? String(r.tokenId) : '0',
			itemCurrencyType:
				r.itemCurrencyType !== undefined && r.itemCurrencyType !== null ? Number(r.itemCurrencyType) : undefined,
			offsetInRequestCurrencyE6: r.offsetInRequestCurrencyE6 != null ? String(r.offsetInRequestCurrencyE6) : undefined,
		})
	}
	return out.length ? out : undefined
}

const ISSUED_NFT_START_ID = 100_000_000_000n
const BEAMIO_USER_CARD_ISSUED_NFT_ABI = [
	'function issuedNftIndex() view returns (uint256)',
	'function issuedNftTitle(uint256) view returns (bytes32)',
	'function issuedNftSharedMetadataHash(uint256) view returns (bytes32)',
	'function issuedNftValidAfter(uint256) view returns (uint64)',
	'function issuedNftValidBefore(uint256) view returns (uint64)',
	'function issuedNftMaxSupply(uint256) view returns (uint256)',
	'function issuedNftMintedCount(uint256) view returns (uint256)',
	'function issuedNftPriceInCurrency6(uint256) view returns (uint256)',
	'function owner() view returns (address)',
] as const
const BASE_RPC_URL = resolveBeamioBaseHttpRpcUrl()
/**
 * Disable JSON-RPC batch (与 MemberCard.ts 一致)。base-rpc.conet.network 上游网关在 batch
 * 响应顺序与请求 id 不对齐时会让 ethers 等到 default request timeout（~30s/请求），
 * 直接表现为 Trending Now 单卡 enrichment 用 25s+ 而 base-rpc 单 call 实测仅 ~200ms。
 */
const providerBaseForLatestCards = new ethers.JsonRpcProvider(BASE_RPC_URL, undefined, { batchMaxCount: 1 })

/** Beamio 默认 metadata image（与 BeamioUserCard 一致） */
const DEFAULT_METADATA_IMAGE_URL = 'https://ipfs.conet.network/api/getFragment?hash=0x44e7a175e57a337bf5d0a98deb19a0a545e362d504092a7af1aecd58798eab'

/** Base mainnet chain id —— EIP-712 ExecuteForAdmin domain 用 */
const MASTER_BASE_CHAIN_ID = 8453

/** PR #4 v3：USDC charge session 中央存储
 *
 * 背景：cluster 是 N-worker 多进程；之前 `chargeSessions` Map 在 cluster 端就是进程内 Map，POS 的
 * `GET /api/nfcUsdcChargeSession` / `POST /api/nfcUsdcChargeTopupAuth` 被 LB 派到任何一个 worker 都
 * 极易 404 "Session not found or expired"。修法：把 session store 搬到 Master（单进程，唯一信源）。
 *
 * Master 提供三个内部端点供 cluster 代理：
 *   POST /api/chargeSessionUpsert   — cluster sessionUpdate(...) → fire-and-forget upsert
 *   GET  /api/chargeSessionGet      — cluster GET /api/nfcUsdcChargeSession 透传到这里
 *   POST /api/chargeSessionConsumePosSig — orchestrator awaitTopupSignature 轮询消耗
 *
 * 以及一个对外端点（cluster proxy 后转发过来）：
 *   POST /api/nfcUsdcChargeTopupAuth — POS 离线签字回灌（EIP-712 verify recover==session.pos）
 *
 * TTL 与 cluster 既有逻辑一致，10 分钟。clean up 在每次 GET / upsert 时顺手做一次。 */
type MasterChargeSessionState =
	| 'awaiting_payment'
	| 'verifying'
	| 'settling'
	| 'topup_pending'
	| 'awaiting_topup_auth'
	/** USDC x402 已结算到 cardOwner；待顾客在终端贴卡/扫码后再走 `nfcTopup` 完成 mint（与先 SUN 再付的旧 sid 路径分离） */
	| 'awaiting_beneficiary'
	| 'topup_confirmed'
	| 'charge_pending'
	| 'success'
	| 'error'

interface MasterChargeSession {
	sid: string
	state: MasterChargeSessionState
	cardAddr: string
	pos: string | null
	cardOwner: string | null
	currency: string | null
	subtotal: string
	discount: string
	tax: string
	tip: string
	total: string
	discountBps: number
	taxBps: number
	tipBps: number
	usdcAmount6: string | null
	USDC_tx: string | null
	payer: string | null
	error: string | null
	tmpEOA: string | null
	tmpAA: string | null
	pointsMinted6: string | null
	topupTxHash: string | null
	chargeTxHash: string | null
	pendingTopupCardAddr: string | null
	pendingTopupRecipientEOA: string | null
	pendingTopupData: string | null
	pendingTopupDeadline: number | null
	pendingTopupNonce: string | null
	pendingTopupPoints6: string | null
	pendingTopupBUnitFee: string | null
	posTopupSignature: string | null
	createdAt: number
	updatedAt: number
}

const MASTER_CHARGE_SESSION_TTL_MS = 10 * 60 * 1000
const masterChargeSessions = new Map<string, MasterChargeSession>()
const MASTER_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const masterIsValidSid = (sid: unknown): sid is string =>
	typeof sid === 'string' && MASTER_UUID_V4_RE.test(sid)

const masterPruneExpiredChargeSessions = (): void => {
	const now = Date.now()
	for (const [k, v] of masterChargeSessions) {
		if (now - v.updatedAt > MASTER_CHARGE_SESSION_TTL_MS) masterChargeSessions.delete(k)
	}
}

const masterMakeFreshChargeSession = (sid: string, now: number): MasterChargeSession => ({
	sid,
	state: 'verifying',
	cardAddr: '',
	pos: null,
	cardOwner: null,
	currency: null,
	subtotal: '0',
	discount: '0',
	tax: '0',
	tip: '0',
	total: '0',
	discountBps: 0,
	taxBps: 0,
	tipBps: 0,
	usdcAmount6: null,
	USDC_tx: null,
	payer: null,
	error: null,
	tmpEOA: null,
	tmpAA: null,
	pointsMinted6: null,
	topupTxHash: null,
	chargeTxHash: null,
	pendingTopupCardAddr: null,
	pendingTopupRecipientEOA: null,
	pendingTopupData: null,
	pendingTopupDeadline: null,
	pendingTopupNonce: null,
	pendingTopupPoints6: null,
	pendingTopupBUnitFee: null,
	posTopupSignature: null,
	createdAt: now,
	updatedAt: now,
})

const ensureMetadataImage = (meta: Record<string, unknown>): Record<string, unknown> => {
	const props = (meta.properties && typeof meta.properties === 'object') ? meta.properties as Record<string, unknown> : {}
	const image = [meta.image, meta.image_url, meta.imageUrl, props.image, DEFAULT_METADATA_IMAGE_URL]
		.find((v): v is string => typeof v === 'string' && v.trim() !== '')
	if (image) meta.image = image
	return meta
}

/** 通用查询缓存：30 秒协议 */
const QUERY_CACHE_TTL_MS = 30 * 1000
const searchHelpCache = new Map<string, { items: unknown[]; expiry: number }>()
const getNFTMetadataCache = new Map<string, { out: Record<string, unknown>; expiry: number }>()
const latestCardsCache = new Map<string, { items: unknown[]; expiry: number }>()
const cardsByCategoryCache = new Map<string, { groups: unknown[]; expiry: number }>()
const getFollowStatusCache = new Map<string, { data: unknown; expiry: number }>()
const getMyFollowStatusCache = new Map<string, { data: unknown; expiry: number }>()
const ownerNftSeriesCache = new Map<string, { items: unknown[]; expiry: number }>()
const seriesSharedMetadataCache = new Map<string, { data: unknown; expiry: number }>()
const mintMetadataCache = new Map<string, { items: unknown[]; expiry: number }>()

/**
 * Master prewarm latestCards：
 *  - 实际只拉一次 limit=300（链上 + enrichment），其它 limit 用 slice 派生，避免 3 次重复打满 RPC。
 *  - 间隔从 6s 调到 30s：trending 数据无需毫秒级新鲜，且 enrichment 本身 RPC 成本高。
 *  - cache stale 与 chain-fetch-protocol 30s TTL 对齐（之前 15s 在窗口尾部高频 miss）。
 */
const LATEST_CARDS_PREWARM_MS = 30 * 1000
const LATEST_CARDS_CACHE_STALE_MS = 30 * 1000
const LATEST_CARDS_PREWARM_LIMITS = [20, 100, 300] as const
const LATEST_CARDS_SUPERSET_LIMIT = 300

/** 合并同 limit 的并发 enrich（prewarm 与 GET /latestCards 缓存未命中常同时触发，避免同一批卡重复 RPC + 重复日志） */
const latestCardsComputeInflight = new Map<number, Promise<BeamioLatestCardItem[]>>()

async function computeLatestCardsForMaster(limit: number): Promise<BeamioLatestCardItem[]> {
	const inflight = latestCardsComputeInflight.get(limit)
	if (inflight) return inflight

	const task = (async () => {
		try {
			const raw = await getLatestCards(limit)
			const filtered = raw.filter((c) => !LATEST_CARDS_EXCLUDED.has((c.cardAddress || '').toLowerCase()))
			return enrichLatestCardsWithBaseErc1155PointsHolderCounts(filtered, providerBaseForLatestCards)
		} finally {
			latestCardsComputeInflight.delete(limit)
		}
	})()

	latestCardsComputeInflight.set(limit, task)
	return task
}

async function prewarmLatestCardsCacheMaster(): Promise<void> {
	// 1) 拉超集 limit=300 一次，命中后 slice 派生其它 limit（避免 3 倍 RPC）
	let superset: BeamioLatestCardItem[] | null = null
	try {
		superset = await computeLatestCardsForMaster(LATEST_CARDS_SUPERSET_LIMIT)
		latestCardsCache.set(
			`limit:${LATEST_CARDS_SUPERSET_LIMIT}`,
			{ items: superset, expiry: Date.now() + LATEST_CARDS_CACHE_STALE_MS },
		)
	} catch (e: any) {
		logger(Colors.yellow(`[latestCards prewarm] limit=${LATEST_CARDS_SUPERSET_LIMIT}: ${e?.message ?? e}`))
	}
	// 2) 派生剩余 limit；untrusted 失败时绝不写空，让旧 trusted cache 自然 stale
	if (!superset) return
	for (const lim of LATEST_CARDS_PREWARM_LIMITS) {
		if (lim === LATEST_CARDS_SUPERSET_LIMIT) continue
		const sliced = superset.slice(0, lim)
		latestCardsCache.set(`limit:${lim}`, { items: sliced, expiry: Date.now() + LATEST_CARDS_CACHE_STALE_MS })
	}
}

let latestCardsPrewarmTimeout: ReturnType<typeof setTimeout> | undefined

function startLatestCardsPrewarmTimer(): void {
	const scheduleAfterDelay = (): void => {
		latestCardsPrewarmTimeout = setTimeout(() => {
			void (async () => {
				try {
					await prewarmLatestCardsCacheMaster()
				} finally {
					scheduleAfterDelay()
				}
			})()
		}, LATEST_CARDS_PREWARM_MS)
		latestCardsPrewarmTimeout.unref?.()
	}
	void (async () => {
		try {
			await prewarmLatestCardsCacheMaster()
		} finally {
			scheduleAfterDelay()
		}
	})()
}

const DEBUG_INBOUND =
	process.env.DEBUG_INBOUND === '1' ||
	process.env.DEBUG_INBOUND === 'true' ||
	process.env.NODE_ENV !== 'production'

const truncateValue = (value: unknown, maxLen = 600): unknown => {
	if (value == null) return value
	if (typeof value === 'string') {
		return value.length > maxLen ? `${value.slice(0, maxLen)}...<truncated ${value.length - maxLen} chars>` : value
	}
	if (typeof value === 'bigint') return value.toString()
	if (Array.isArray(value)) {
		const maxItems = 20
		const mapped = value.slice(0, maxItems).map((v) => truncateValue(v, maxLen))
		if (value.length > maxItems) mapped.push(`...<truncated ${value.length - maxItems} items>`)
		return mapped
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(obj)) out[k] = truncateValue(v, maxLen)
		return out
	}
	return value
}

const logInboundDebug = (req: Request) => {
	if (!DEBUG_INBOUND) return
	const body = truncateValue(req.body)
	const query = truncateValue(req.query)
	logger(
		Colors.gray(`[INBOUND][Master] ${req.method} ${req.originalUrl} ip=${getClientIp(req)}`),
		inspect({ query, body }, false, 4, true)
	)
}

const routing = ( router: Router ) => {
	router.use((req, _res, next) => {
		logInboundDebug(req)
		next()
	})

	/** GET /api/manifest.json - 动态 manifest，与 cluster 相同（nginx 可能代理到 master） */
	router.get('/manifest.json', (req, res) => {
		const startUrl = (req.query.start_url as string) || req.get('Referer') || ''
		const protocol = req.get('X-Forwarded-Proto') || req.protocol || 'https'
		const host = req.get('Host') || 'beamio.app'
		const origin = `${protocol}://${host}`
		const fallbackStartUrl = `${origin}/app/`
		const url = startUrl && startUrl.startsWith('http') ? startUrl : fallbackStartUrl
		const manifest = {
			id: '/app/',
			short_name: 'Beamio',
			name: 'Beamio APP',
			start_url: url,
			scope: '/app/',
			display: 'standalone' as const,
			theme_color: '#0d0d0d',
			background_color: '#0d0d0d',
			icons: [
				{ src: `${origin}/app/logo192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
				{ src: `${origin}/app/logo512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
				{ src: `${origin}/app/logo512-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
			],
			shortcuts: [{ name: 'Open Beamio', short_name: 'Beamio', url: '/app/', icons: [{ src: `${origin}/app/logo192.png`, sizes: '192x192' }] }],
		}
		res.setHeader('Content-Type', 'application/manifest+json')
		res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
		res.json(manifest)
	})

	router.post('/addFollow', (req,res) => {
		return addFollow(req, res)
	})

	router.post('/removeFollow', (req,res) => {
		return removeFollow(req, res)
	})

	router.post('/addUser', (req,res) => {
		return addUser(req, res)
	})

	router.post('/regiestChatRoute', (req, res) => {
		return regiestChatRoute(req, res)
	})

	/** Cluster 每 1 分钟从此接口拉取 oracle，供 UI getOracle 直接响应 */
	router.get('/oracleForCluster', (_req, res) => {
		res.status(200).json(getOracleRequest()).end()
	})

	router.get('/debug/ip', (req, res) => {
		console.log('CF-Connecting-IP:', req.headers['cf-connecting-ip'])
		console.log('X-Real-IP:', req.headers['x-real-ip'])
		console.log('X-Forwarded-For:', req.headers['x-forwarded-for'])
		console.log('Remote Address:', req.socket.remoteAddress)
		res.json({
			realIp: getClientIp(req),
			headers: {
			'x-real-ip': req.headers['x-real-ip'],
			'cf-connecting-ip': req.headers['cf-connecting-ip'],
			'x-forwarded-for': req.headers['x-forwarded-for'],
			'Remote Address:': req.socket.remoteAddress
			},
		})
	})

		router.get('/search-users', (req, res) => {
			return searchUsers(req, res)
		})

		/** GET /api/getFollowStatus 30 秒缓存 */
		router.get('/getFollowStatus', async (req, res) => {
			const { wallet, followAddress } = req.query as { wallet?: string; followAddress?: string }
			if (!ethers.isAddress(wallet!) || wallet === ethers.ZeroAddress || !ethers.isAddress(followAddress!) || followAddress === ethers.ZeroAddress) {
				return res.status(400).json({ error: 'Invalid data format' })
			}
			const cacheKey = `${ethers.getAddress(wallet!).toLowerCase()}:${ethers.getAddress(followAddress!).toLowerCase()}`
			const cached = getFollowStatusCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json(cached.data).end()
			}
			const followStatus = await FollowerStatus(wallet!, followAddress!)
			if (followStatus === null) {
				return res.status(400).json({ error: 'Follow status check Error!' })
			}
			getFollowStatusCache.set(cacheKey, { data: followStatus, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			return res.status(200).json(followStatus).end()
		})

		/** GET /api/getMyFollowStatus 30 秒缓存 */
		router.get('/getMyFollowStatus', async (req, res) => {
			const { wallet } = req.query as { wallet?: string }
			if (!ethers.isAddress(wallet!) || wallet === ethers.ZeroAddress) {
				return res.status(400).json({ error: 'Invalid data format' })
			}
			const cacheKey = ethers.getAddress(wallet!).toLowerCase()
			const cached = getMyFollowStatusCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json(cached.data).end()
			}
			const followStatus = await getMyFollowStatus(wallet!)
			if (followStatus === null) {
				return res.status(400).json({ error: 'Follow status check Error!' })
			}
			getMyFollowStatusCache.set(cacheKey, { data: followStatus, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			return res.status(200).json(followStatus).end()
		})

		router.get('/coinbase-token', (req, res) => {
			return coinbaseToken(req, res)
		})

		router.get('/coinbase-offramp', (req, res) => {
			return coinbaseOfframp(req, res)
		})

		/** GET /api/searchHelp - 返回卡已定义的全部 issued NFT 列表。30 秒缓存 */
		router.get('/searchHelp', async (req, res) => {
			const { card } = req.query as { card?: string }
			if (!card || !ethers.isAddress(card)) {
				return res.status(400).json({ error: 'Invalid card address' })
			}
			const cacheKey = ethers.getAddress(card).toLowerCase()
			const cached = searchHelpCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ items: cached.items })
			}
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const cardContract = new ethers.Contract(card, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider)
				const nextIdx = await cardContract.issuedNftIndex()
				const nextIdxN = Number(nextIdx)
				const startN = Number(ISSUED_NFT_START_ID)
				if (nextIdxN <= startN) {
					return res.status(200).json({ items: [] })
				}
				const items: Array<{ tokenId: string; title: string; sharedMetadataHash: string | null; validAfter: string; validBefore: string; maxSupply: string; mintedCount: string; priceInCurrency6: string }> = []
				for (let tid = startN; tid < nextIdxN; tid++) {
					const [title, sharedMetadataHash, validAfter, validBefore, maxSupply, mintedCount, priceInCurrency6] = await Promise.all([
						cardContract.issuedNftTitle(tid),
						cardContract.issuedNftSharedMetadataHash(tid),
						cardContract.issuedNftValidAfter(tid),
						cardContract.issuedNftValidBefore(tid),
						cardContract.issuedNftMaxSupply(tid),
						cardContract.issuedNftMintedCount(tid),
						cardContract.issuedNftPriceInCurrency6(tid),
					])
					let titleStr = ''
					try { titleStr = ethers.toUtf8String(title).replace(/\0/g, '').trim() } catch { titleStr = '0x' + ethers.hexlify(title).slice(2) }
					if (!titleStr) titleStr = '0x' + ethers.hexlify(title).slice(2)
					items.push({
						tokenId: String(tid),
						title: titleStr,
						sharedMetadataHash: sharedMetadataHash !== ethers.ZeroHash ? ethers.hexlify(sharedMetadataHash) : null,
						validAfter: String(validAfter),
						validBefore: String(validBefore),
						maxSupply: String(maxSupply),
						mintedCount: String(mintedCount),
						priceInCurrency6: String(priceInCurrency6),
					})
				}
				searchHelpCache.set(cacheKey, { items, expiry: Date.now() + QUERY_CACHE_TTL_MS })
				res.status(200).json({ items })
			} catch (err: any) {
				logger(Colors.red('[searchHelp] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to fetch issued NFTs' })
			}
		})

		/** GET /api/getNFTMetadata - 返回指定 NFT 的 metadata。30 秒缓存 */
		router.get('/getNFTMetadata', async (req, res) => {
			const { card, tokenId, nftSpecialMetadata } = req.query as { card?: string; tokenId?: string; nftSpecialMetadata?: string }
			if (!card || !ethers.isAddress(card) || !tokenId) {
				return res.status(400).json({ error: 'Invalid card or tokenId' })
			}
			const cacheKey = `${ethers.getAddress(card).toLowerCase()}:${tokenId}:${nftSpecialMetadata ?? ''}`
			const cached = getNFTMetadataCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json(cached.out)
			}
			const tid = BigInt(tokenId)
			if (tid < ISSUED_NFT_START_ID) {
				return res.status(400).json({ error: 'tokenId must be >= ISSUED_NFT_START_ID (100000000000)' })
			}
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const cardContract = new ethers.Contract(card, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider)
				const [title, sharedMetadataHash, validAfter, validBefore, maxSupply, mintedCount, priceInCurrency6] = await Promise.all([
					cardContract.issuedNftTitle(tid),
					cardContract.issuedNftSharedMetadataHash(tid),
					cardContract.issuedNftValidAfter(tid),
					cardContract.issuedNftValidBefore(tid),
					cardContract.issuedNftMaxSupply(tid),
					cardContract.issuedNftMintedCount(tid),
					cardContract.issuedNftPriceInCurrency6(tid),
				])
				if (maxSupply === 0n || maxSupply === 0) {
					return res.status(404).json({ error: 'Issued NFT not defined' })
				}
				let titleStr = ''
				try { titleStr = ethers.toUtf8String(title).replace(/\0/g, '').trim() } catch { titleStr = '0x' + ethers.hexlify(title).slice(2) }
				if (!titleStr) titleStr = '0x' + ethers.hexlify(title).slice(2)
				const out: Record<string, unknown> = {
					tokenId: String(tid),
					title: titleStr,
					sharedMetadataHash: sharedMetadataHash !== ethers.ZeroHash ? ethers.hexlify(sharedMetadataHash) : null,
					validAfter: String(validAfter),
					validBefore: String(validBefore),
					maxSupply: String(maxSupply),
					mintedCount: String(mintedCount),
					priceInCurrency6: String(priceInCurrency6),
				}
				const series = await getSeriesByCardAndTokenId(card, tokenId)
				if (series?.ipfsCid) {
					try {
						const ipfsUrl = `https://ipfs.io/ipfs/${series.ipfsCid}`
						const ipfsRes = await fetch(ipfsUrl)
						if (ipfsRes.ok) {
							const sharedJson = await ipfsRes.json()
							out.sharedSeriesMetadata = sharedJson
							if (nftSpecialMetadata && typeof nftSpecialMetadata === 'string') {
								try {
									const special = JSON.parse(nftSpecialMetadata) as Record<string, unknown>
									const base = (typeof sharedJson === 'object' && sharedJson !== null) ? sharedJson as Record<string, unknown> : {}
									out.assembled = { ...base, ...special }
								} catch {
									out.nftSpecialMetadata = nftSpecialMetadata
								}
							}
						}
				} catch (ipfsErr: any) {
					logger(Colors.yellow('[getNFTMetadata] IPFS fetch failed:'), ipfsErr?.message ?? ipfsErr)
				}
			}
			getNFTMetadataCache.set(cacheKey, { out, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json(out)
		} catch (err: any) {
			logger(Colors.red('[getNFTMetadata] error:'), err?.message ?? err)
			res.status(500).json({ error: err?.message ?? 'Failed to fetch NFT metadata' })
		}
	})

		/**
		 * 最新发行的前 N 张卡明细；holderCount + token0TotalSupply6 + token0CumulativeMint6。
		 *  - cache 命中（含已过期）一律可用：未过期直接返回；过期则当 stale 兜底。
		 *  - cache miss：优先用 limit=300 超集 slice 派生（一次链上拉取就能服务多个 limit）。
		 *  - 计算失败：若有任何 stale trusted cache，返回 stale 而不是 5xx，避免触发 nginx 504。
		 *  - 严格不返回 [] 表示「无卡」（按 beamio-untrusted-empty-result-discard.mdc，windowed 扫描的空结果不可信）。
		 */
		router.get('/latestCards', async (_req, res) => {
			const limit = Math.min(parseInt(String(_req.query.limit || 20), 10) || 20, 300)
			const cacheKey = `limit:${limit}`
			const cached = latestCardsCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ items: cached.items })
			}

			// 用超集 cache 派生：避免对每个 limit 都触发 enrichment
			const supersetCacheKey = `limit:${LATEST_CARDS_SUPERSET_LIMIT}`
			const superset = latestCardsCache.get(supersetCacheKey)
			if (superset && limit < LATEST_CARDS_SUPERSET_LIMIT && superset.items.length >= limit) {
				const sliced = superset.items.slice(0, limit)
				latestCardsCache.set(cacheKey, { items: sliced, expiry: Date.now() + LATEST_CARDS_CACHE_STALE_MS })
				return res.status(200).json({ items: sliced })
			}

			try {
				const items = await computeLatestCardsForMaster(limit)
				latestCardsCache.set(cacheKey, { items, expiry: Date.now() + LATEST_CARDS_CACHE_STALE_MS })
				res.status(200).json({ items })
			} catch (e: any) {
				logger(Colors.red('[latestCards] error:'), e?.message ?? e)
				// untrusted 失败：尝试返回 stale trusted cache（同 limit 或超集 slice），避免 nginx 504
				if (cached) return res.status(200).json({ items: cached.items, stale: true })
				if (superset && limit <= LATEST_CARDS_SUPERSET_LIMIT) {
					const sliced = superset.items.slice(0, limit)
					if (sliced.length > 0) return res.status(200).json({ items: sliced, stale: true })
				}
				res.status(503).json({ error: e?.message ?? 'latestCards failed' })
			}
		})

		/** 按 shareTokenMetadata.categories 聚合已登记发卡（与 Cluster GET /api/cardsByCategory 一致） */
		router.get('/cardsByCategory', async (_req, res) => {
			const scanLimit = Math.min(parseInt(String(_req.query.scanLimit || 800), 10) || 800, 3000)
			const limitPerCategory = Math.min(parseInt(String(_req.query.limitPerCategory || 80), 10) || 80, 500)
			const cacheKey = `scan:${scanLimit}:per:${limitPerCategory}`
			const cached = cardsByCategoryCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ groups: cached.groups })
			}
			const groups = await getLatestCardsGroupedByCategory({ scanLimit, limitPerCategory })
			cardsByCategoryCache.set(cacheKey, { groups, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json({ groups })
		})

		/** GET /api/myCards?owner=0x... 或 ?owners=0x1,0x2 - 客户端 RPC 失败时可由此 API 获取。30 秒缓存。
		 * RPC 错误时返回 500，绝不返回 200+空 items，以便 UI 区分「成功无卡」与「请求失败」。 */
		const MY_CARDS_CACHE_TTL_MS = 30 * 1000
		const myCardsCache = new Map<string, { items: Array<{ cardAddress: string; name: string; currency: string; priceE6: string; ptsPer1Currency: string }>; expiry: number }>()
		router.get('/myCards', async (req, res) => {
			const { owner, owners } = req.query as { owner?: string; owners?: string }
			const ownerList: string[] = []
			if (owner && ethers.isAddress(owner)) ownerList.push(ethers.getAddress(owner))
			if (owners && typeof owners === 'string') {
				for (const addr of owners.split(',').map((s) => s.trim())) {
					if (addr && ethers.isAddress(addr)) ownerList.push(ethers.getAddress(addr))
				}
			}
			if (ownerList.length === 0) {
				return res.status(400).json({ error: 'Invalid owner or owners: require valid 0x address(es)' })
			}
			const cacheKey = [...ownerList].map((o) => o.toLowerCase()).sort().join(',')
			const cached = myCardsCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ items: cached.items })
			}
			const CARD_ABI = ['function currency() view returns (uint8)', 'function pointsUnitPriceInCurrencyE6() view returns (uint256)']
			const CURRENCY_MAP: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const factory = new ethers.Contract(BASE_CARD_FACTORY, ['function cardsOfOwner(address) view returns (address[])', 'function beamioUserCardOwner(address) view returns (address)'], provider)
				const seen = new Set<string>()
				const items: Array<{ cardAddress: string; name: string; currency: string; priceE6: string; ptsPer1Currency: string }> = []
				for (const o of ownerList) {
					const cards: string[] = await factory.cardsOfOwner(o)
					for (const addr of cards) {
						const key = addr.toLowerCase()
						if (seen.has(key)) continue
						seen.add(key)
						try {
							const card = new ethers.Contract(addr, CARD_ABI, provider)
							const [currencyNum, priceE6Raw] = await Promise.all([card.currency(), card.pointsUnitPriceInCurrencyE6()])
							const currency = CURRENCY_MAP[Number(currencyNum)] ?? 'USDC'
							const priceE6 = Number(priceE6Raw)
							const ptsPer1Currency = priceE6 > 0 ? String(1_000_000 / priceE6) : '0'
							items.push({ cardAddress: addr, name: addr.toLowerCase() === BASE_CCSA_CARD_ADDRESS.toLowerCase() ? 'CCSA' : 'User Card', currency, priceE6: String(priceE6), ptsPer1Currency })
						} catch (_) {}
					}
				}
				// CCSA fallback: 若任一 owner 为 CCSA owner 且 CCSA 未在列表中，则加入
				const ccsaLower = BASE_CCSA_CARD_ADDRESS.toLowerCase()
				if (!seen.has(ccsaLower)) {
					try {
						const ccsaOwner = await factory.beamioUserCardOwner(BASE_CCSA_CARD_ADDRESS)
						if (ccsaOwner && ownerList.some((o) => ccsaOwner.toLowerCase() === o.toLowerCase())) {
							const card = new ethers.Contract(BASE_CCSA_CARD_ADDRESS, CARD_ABI, provider)
							const [currencyNum, priceE6Raw] = await Promise.all([card.currency(), card.pointsUnitPriceInCurrencyE6()])
							const currency = CURRENCY_MAP[Number(currencyNum)] ?? 'USDC'
							const priceE6 = Number(priceE6Raw)
							const ptsPer1Currency = priceE6 > 0 ? String(1_000_000 / priceE6) : '0'
							items.unshift({ cardAddress: BASE_CCSA_CARD_ADDRESS, name: 'CCSA', currency, priceE6: String(priceE6), ptsPer1Currency })
						}
					} catch (_) {}
				}
				myCardsCache.set(cacheKey, { items, expiry: Date.now() + MY_CARDS_CACHE_TTL_MS })
				res.status(200).json({ items })
			} catch (err: any) {
				logger(Colors.red('[myCards] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to fetch my cards' })
			}
		})

		/** GET /api/getAAAccount?eoa=0x... - 仅 UserCard 绑定 _aaFactory → beamioAccountOf（与 resolveBeamioAaForEoaWithFallback 一致）。30 秒缓存。 */
		const GET_AA_CACHE_TTL_MS = 30 * 1000
		const getAAAccountCache = new Map<string, { account: string | null; expiry: number }>()
		router.get('/getAAAccount', async (req, res) => {
			const { eoa } = req.query as { eoa?: string }
			if (!eoa || !ethers.isAddress(eoa)) {
				return res.status(400).json({ error: 'Invalid eoa: require valid 0x address' })
			}
			const cacheKey = ethers.getAddress(eoa).toLowerCase()
			const cached = getAAAccountCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ account: cached.account })
			}
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const account = await resolveBeamioAaForEoaWithFallback(provider, eoa)
				if (!account) {
					getAAAccountCache.set(cacheKey, { account: null, expiry: Date.now() + GET_AA_CACHE_TTL_MS })
					return res.status(200).json({ account: null })
				}
				getAAAccountCache.set(cacheKey, { account, expiry: Date.now() + GET_AA_CACHE_TTL_MS })
				res.status(200).json({ account })
			} catch (err: any) {
				logger(Colors.red('[getAAAccount] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to fetch AA account' })
			}
		})

		/** GET /api/ensureAAForEOA?eoa=0x... - 为 EOA 确保存在 AA（无则创建），返回 { aa }。cardAddAdmin 预检要求 adminManager.to 与 body.adminEOA 同为真实商户 EOA（无 code），勿用占位地址。 */
		router.get('/ensureAAForEOA', async (req, res) => {
			const { eoa } = req.query as { eoa?: string }
			if (!eoa || !ethers.isAddress(eoa)) {
				return res.status(400).json({ error: 'Invalid eoa: require valid 0x address' })
			}
			try {
				const aa = await ensureAAForEOA(ethers.getAddress(eoa))
				res.status(200).json({ aa })
			} catch (err: any) {
				logger(Colors.red('[ensureAAForEOA] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to ensure AA for EOA' })
			}
		})

		/** getUIDAssetsProvision pool：Cluster 预检通过后，TagID 未绑定时转发到此。Master 排队执行 provision → ensureAA → fetchAssets，不预检。 */
		const getUIDAssetsProvisionPool: Array<{ uid: string; tagIdHex: string; c?: string; res: Response }> = []
		const getUIDAssetsProvisionPress = async () => {
			const obj = getUIDAssetsProvisionPool.shift()
			if (!obj) return
			const { uid, tagIdHex, c: counterHex, res } = obj
			try {
				logger(Colors.cyan(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... provision + ensureAA + fetch`))
				const { eoa, wasNewlyProvisioned } = await provisionOrGetNfcWalletByTagId(tagIdHex, uid || undefined)
				// 始终确保 AA 存在：wasNewlyProvisioned 仅表示 EOA 新建，但 EOA 已存在时可能因 DeployingSmartAccount 曾失败而无 AA
				await ensureAAForEOA(ethers.getAddress(eoa))
				if (wasNewlyProvisioned) logger(Colors.green(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... provisioned EOA + AA`))
				const result = await fetchUIDAssetsForEOA(eoa)
				if (uid && tagIdHex) {
					scheduleEnsureNfcBeamioTagForEoa(eoa, uid.trim(), tagIdHex, result.cards)
				}
				const counterVal = counterHex && /^[0-9a-fA-F]{6}$/.test(counterHex) ? parseInt(counterHex, 16) : undefined
				const merged = {
					...result,
					...(uid && { uid }),
					tagIdHex,
					...(counterHex && { counterHex: counterHex }),
					...(counterVal !== undefined && { counter: counterVal }),
				}
				logger(Colors.green(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... success`))
				res.status(200).json(merged).end()
			} catch (err: any) {
				const msg = err?.message ?? String(err)
				logger(Colors.red(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... failed: ${msg}`))
				res.status(500).json({ ok: false, error: msg }).end()
			}
			setTimeout(() => getUIDAssetsProvisionPress(), 0)
		}

		/** POST /api/getUIDAssetsProvision - Cluster 预检后转发。TagID 未绑定时需创建钱包，Master 排队处理。tagIdHex 必填（卡的唯一 ID）；uid 可选（兼容旧客户端）。 */
		router.post('/getUIDAssetsProvision', (req, res) => {
			const { uid, tagIdHex, c } = req.body as { uid?: string; tagIdHex?: string; c?: string }
			if (!tagIdHex || typeof tagIdHex !== 'string' || !tagIdHex.trim()) {
				return res.status(400).json({ ok: false, error: 'Missing tagIdHex (card unique ID)' })
			}
			getUIDAssetsProvisionPool.push({ uid: typeof uid === 'string' ? uid.trim() : '', tagIdHex: tagIdHex.trim(), c: typeof c === 'string' ? c.trim() : undefined, res })
			getUIDAssetsProvisionPress()
		})

		/** sunProvision pool：Cluster /sun valid 时 tagID 未绑定，转发到此。Master 排队 provision → ensureAA，返回 { ...sunResult, eoa, aa }。 */
		const sunProvisionPool: Array<{ uid: string; tagIdHex: string; sunResult: Record<string, unknown>; res: Response }> = []
		const sunProvisionPress = async () => {
			const obj = sunProvisionPool.shift()
			if (!obj) return
			const { uid, tagIdHex, sunResult, res } = obj
			try {
				logger(Colors.cyan(`[sunProvision] tagId=${tagIdHex.slice(0, 8)}... provision + ensureAA`))
				const { eoa, wasNewlyProvisioned } = await provisionOrGetNfcWalletByTagId(tagIdHex, uid || undefined)
				// 始终确保 AA 存在（与 getUIDAssetsProvision 一致）
				const aa = await ensureAAForEOA(ethers.getAddress(eoa))
				if (wasNewlyProvisioned) logger(Colors.green(`[sunProvision] tagId=${tagIdHex.slice(0, 8)}... provisioned EOA + AA`))
				const eoaAddr = ethers.getAddress(eoa)
				const uidForTag =
					(typeof uid === 'string' && uid.trim()
						? uid.trim()
						: String((sunResult as { uidHex?: string }).uidHex ?? '').trim()) || tagIdHex
				scheduleEnsureNfcBeamioTagForEoa(eoaAddr, uidForTag, tagIdHex, null)
				res.status(200).json({ ...sunResult, eoa: eoaAddr, aa }).end()
			} catch (err: any) {
				const msg = err?.message ?? String(err)
				logger(Colors.red(`[sunProvision] tagId=${tagIdHex.slice(0, 8)}... failed: ${msg}`))
				res.status(500).json({ ok: false, error: msg }).end()
			}
			setTimeout(() => sunProvisionPress(), 0)
		}

		/** POST /api/sunProvision - Cluster /sun valid 且 tagID 未绑定时转发。Master 排队创建钱包，返回 { ...sunResult, eoa, aa }。tagIdHex 必填；uid 可选。 */
		router.post('/sunProvision', (req, res) => {
			const { uid, tagIdHex, sunResult } = req.body as { uid?: string; tagIdHex?: string; sunResult?: Record<string, unknown> }
			if (!tagIdHex || typeof tagIdHex !== 'string' || !tagIdHex.trim() || !sunResult || typeof sunResult !== 'object') {
				return res.status(400).json({ ok: false, error: 'Missing tagIdHex or sunResult' })
			}
			sunProvisionPool.push({ uid: typeof uid === 'string' ? uid.trim() : '', tagIdHex: tagIdHex.trim(), sunResult, res })
			sunProvisionPress()
		})

		/** GET /api/checkRequestStatus - 校验 Voucher 支付请求是否过期或已支付。用于 Smart Routing 及 beamioTransferIndexerAccounting 前置校验。 */
		// 源自 deployments/conet-addresses.json:BeamioIndexerDiamond（chain 224422 重启后地址）。
		// 旧地址 0xd990719B2f05ccab4Acdd5D7A3f7aDfd2Fc584Fe 已废弃。
		const BEAMIO_INDEXER_ADDRESS = '0x45D45de73465b8913B50974Fc188529dFFb7AfFA'
		const CONET_RPC = 'https://rpc1.conet.network'
		const INDEXER_READ_ABI = [
			'function getTransactionFullByTxId(bytes32 txId) view returns ((bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta))',
			'function getAccountTransactionsByMonthOffsetPaged(address account, uint256 periodOffset, uint256 pageOffset, uint256 pageLimit, bytes32 txCategoryFilter) view returns (uint256 total, uint256 periodStart, uint256 periodEnd, (bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, bool exists)[] page)',
		]
		const TX_REQUEST_CREATE = ethers.keccak256(ethers.toUtf8Bytes('request_create:confirmed'))
		const TX_REQUEST_FULFILLED = ethers.keccak256(ethers.toUtf8Bytes('request_fulfilled:confirmed'))

		const checkRequestStatus = async (requestHash: string, validDays: number, payee: string): Promise<{ expired: boolean; fulfilled: boolean; error?: string }> => {
			if (!requestHash || !ethers.isHexString(requestHash) || ethers.dataLength(requestHash) !== 32) {
				return { expired: false, fulfilled: false, error: 'Invalid requestHash' }
			}
			if (!payee || !ethers.isAddress(payee)) {
				return { expired: false, fulfilled: false, error: 'Invalid payee address' }
			}
			const vd = Math.floor(Number(validDays))
			if (vd < 1) {
				return { expired: false, fulfilled: false, error: 'validDays must be >= 1' }
			}
			try {
				const provider = new ethers.JsonRpcProvider(CONET_RPC)
				const indexer = new ethers.Contract(BEAMIO_INDEXER_ADDRESS, INDEXER_READ_ABI, provider)
				const txHashBytes32 = ethers.getBytes(requestHash).length === 32 ? (requestHash as `0x${string}`) : ethers.hexlify(ethers.zeroPadValue(requestHash, 32)) as `0x${string}`

				// 1. 查 request_create：txId = requestHash，取 timestamp
				let createTs = 0n
				try {
					const full = await indexer.getTransactionFullByTxId(txHashBytes32)
					if (full && full.txCategory === TX_REQUEST_CREATE && full.timestamp) {
						createTs = BigInt(full.timestamp)
					}
				} catch {
					// 可能不存在（未登记 request_create），按无时间戳处理，视为未过期（由 fulfilled 决定）
				}

				// 2. 过期：createTs + validDays*86400 < now
				const nowSec = BigInt(Math.floor(Date.now() / 1000))
				const validSeconds = BigInt(vd) * 86400n
				const expiresAt = createTs + validSeconds
				const expired = createTs > 0n ? nowSec > expiresAt : false

				// 3. 已支付：payee 的 request_fulfilled 中 originalPaymentHash === requestHash
				let fulfilled = false
				try {
					const [total, , , page] = await indexer.getAccountTransactionsByMonthOffsetPaged(
						ethers.getAddress(payee),
						0,
						0,
						50,
						TX_REQUEST_FULFILLED
					)
					if (page && page.length > 0) {
						const reqHashLower = requestHash.toLowerCase()
						for (const tx of page) {
							if (tx?.exists && tx.originalPaymentHash && String(tx.originalPaymentHash).toLowerCase() === reqHashLower) {
								fulfilled = true
								break
							}
						}
					}
				} catch {
					// RPC 失败时不断言 fulfilled，避免误拒
				}

				return { expired, fulfilled }
			} catch (err: any) {
				return { expired: false, fulfilled: false, error: err?.message ?? 'Indexer query failed' }
			}
		}

		router.get('/checkRequestStatus', async (req, res) => {
			const { requestHash, validDays, payee } = req.query as { requestHash?: string; validDays?: string; payee?: string }
			if (!requestHash || validDays == null || validDays === '' || !payee) {
				return res.status(400).json({ error: 'Missing required: requestHash, validDays, payee' })
			}
			const vd = Math.floor(Number(validDays))
			if (vd < 1) {
				return res.status(400).json({ error: 'validDays must be >= 1' })
			}
			if (!ethers.isAddress(payee)) {
				return res.status(400).json({ error: 'Invalid payee address' })
			}
			const result = await checkRequestStatus(requestHash, vd, payee)
			if (result.error && !result.expired && !result.fulfilled) {
				return res.status(500).json({ error: result.error })
			}
			res.status(200).json({ expired: result.expired, fulfilled: result.fulfilled })
		})

		/** GET /api/getBalance?address=0x... - 客户端 RPC 失败时由此获取 USDC/ETH 余额。30 秒缓存。 */
		const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
		const GET_BALANCE_CACHE_TTL_MS = 30 * 1000
		const getBalanceCache = new Map<string, { eth: string; usdc: string; oracle: Record<string, unknown>; expiry: number }>()
		router.get('/getBalance', async (req, res) => {
			const { address } = req.query as { address?: string }
			if (!address || !ethers.isAddress(address)) {
				return res.status(400).json({ error: 'Invalid address: require valid 0x address' })
			}
			const cacheKey = ethers.getAddress(address).toLowerCase()
			const cached = getBalanceCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ eth: cached.eth, usdc: cached.usdc, oracle: cached.oracle })
			}
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const usdc = new ethers.Contract(USDC_BASE, ['function balanceOf(address) view returns (uint256)'], provider)
				const [usdcRaw, ethRaw] = await Promise.all([usdc.balanceOf(address), provider.getBalance(address)])
				const oracle = getOracleRequest()
				const data = {
					eth: ethers.formatUnits(ethRaw, 18),
					usdc: ethers.formatUnits(usdcRaw, 6),
					oracle: oracle ?? {},
				}
				getBalanceCache.set(cacheKey, { eth: data.eth, usdc: data.usdc, oracle: data.oracle, expiry: Date.now() + GET_BALANCE_CACHE_TTL_MS })
				res.status(200).json(data)
			} catch (err: any) {
				logger(Colors.red('[getBalance] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to fetch balance' })
			}
		})

		/** GET /api/ownerNftSeries - owner 钱包所有的 NFT 系列。30 秒缓存 */
		router.get('/ownerNftSeries', async (req, res) => {
			const { owner } = req.query as { owner?: string }
			if (!owner || !ethers.isAddress(owner)) {
				return res.status(400).json({ error: 'Invalid owner address' })
			}
			const cacheKey = ethers.getAddress(owner).toLowerCase()
			const cached = ownerNftSeriesCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ items: cached.items })
			}
			try {
				const items = await getOwnerNftSeries(owner, 100)
				ownerNftSeriesCache.set(cacheKey, { items, expiry: Date.now() + QUERY_CACHE_TTL_MS })
				res.status(200).json({ items })
			} catch (err: any) {
				logger(Colors.red('[ownerNftSeries] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to fetch owner NFT series' })
			}
		})

		/** GET /api/seriesSharedMetadata - 返回 sharedSeriesMetadata（IPFS 或自定义 metadata）。30 秒缓存 */
		router.get('/seriesSharedMetadata', async (req, res) => {
			const { card, tokenId } = req.query as { card?: string; tokenId?: string }
			if (!card || !ethers.isAddress(card) || !tokenId) {
				return res.status(400).json({ error: 'Invalid card or tokenId' })
			}
			const cacheKey = `${ethers.getAddress(card).toLowerCase()}:${tokenId}`
			const cached = seriesSharedMetadataCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json(cached.data)
			}
			const tid = BigInt(tokenId)
			if (tid < ISSUED_NFT_START_ID) {
				return res.status(400).json({ error: 'tokenId must be >= ISSUED_NFT_START_ID' })
			}
			try {
				const series = await getSeriesByCardAndTokenId(card, tokenId)
				if (!series) {
					return res.status(404).json({ error: 'Series not registered' })
				}
				let sharedJson: Record<string, unknown> | null = null
				if (series.ipfsCid && series.ipfsCid.trim() !== '') {
					const ipfsUrl = `https://ipfs.io/ipfs/${series.ipfsCid}`
					const ipfsRes = await fetch(ipfsUrl)
					if (ipfsRes.ok) {
						const parsed = await ipfsRes.json()
						if (parsed && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) sharedJson = parsed as Record<string, unknown>
					}
				}
				if (!sharedJson && series.metadata && typeof series.metadata === 'object') {
					sharedJson = series.metadata
				}
				const rawShared = (sharedJson ?? {}) as Record<string, unknown>
				const sharedWithImage = ensureMetadataImage({ ...rawShared })
				const data = {
					cardAddress: series.cardAddress,
					tokenId: series.tokenId,
					sharedMetadataHash: series.sharedMetadataHash,
					ipfsCid: series.ipfsCid || null,
					metadata: series.metadata ?? null,
					sharedSeriesMetadata: sharedWithImage,
				}
				seriesSharedMetadataCache.set(cacheKey, { data, expiry: Date.now() + QUERY_CACHE_TTL_MS })
				res.status(200).json(data)
			} catch (err: any) {
				logger(Colors.red('[seriesSharedMetadata] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to fetch shared metadata' })
			}
		})

		/** GET /api/mintMetadata - owner 在某系列下的各笔 mint metadata。30 秒缓存 */
		router.get('/mintMetadata', async (req, res) => {
			const { card, tokenId, owner } = req.query as { card?: string; tokenId?: string; owner?: string }
			if (!card || !ethers.isAddress(card) || !tokenId || !owner || !ethers.isAddress(owner)) {
				return res.status(400).json({ error: 'Invalid card, tokenId, or owner' })
			}
			const cacheKey = `${ethers.getAddress(card).toLowerCase()}:${tokenId}:${ethers.getAddress(owner).toLowerCase()}`
			const cached = mintMetadataCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ items: cached.items })
			}
			try {
				const items = await getMintMetadataForOwner(card, tokenId, owner)
				mintMetadataCache.set(cacheKey, { items, expiry: Date.now() + QUERY_CACHE_TTL_MS })
				res.status(200).json({ items })
			} catch (err: any) {
				logger(Colors.red('[mintMetadata] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to fetch mint metadata' })
			}
		})

		/** POST /api/registerSeries - 登记 NFT 系列到 DB（cluster 预检后转发）。tokenId 必须来自 createIssuedNft 返回值；ipfsCid 可选，无 IPFS 时用 metadata 作为 shared metadata */
		router.post('/registerSeries', async (req, res) => {
			const { cardAddress, tokenId, sharedMetadataHash, ipfsCid, metadata } = req.body as {
				cardAddress?: string
				tokenId?: string
				sharedMetadataHash?: string
				ipfsCid?: string
				metadata?: Record<string, unknown>
			}
			if (!cardAddress || !ethers.isAddress(cardAddress) || !tokenId || !sharedMetadataHash) {
				return res.status(400).json({ error: 'Missing cardAddress, tokenId, or sharedMetadataHash' })
			}
			const hasIpfs = ipfsCid != null && String(ipfsCid).trim() !== ''
			const hasMetadata = metadata != null && typeof metadata === 'object'
			if (!hasIpfs && !hasMetadata) {
				return res.status(400).json({ error: 'Provide ipfsCid or metadata (custom JSON object) for shared metadata' })
			}
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const cardContract = new ethers.Contract(cardAddress, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider)
				const cardOwner = await cardContract.owner()
				const onChainHash = await cardContract.issuedNftSharedMetadataHash(tokenId)
				const expectedHash = sharedMetadataHash.startsWith('0x') ? sharedMetadataHash : '0x' + sharedMetadataHash
				if (ethers.hexlify(onChainHash) !== expectedHash.toLowerCase()) {
					return res.status(400).json({ error: 'sharedMetadataHash does not match chain' })
				}
				await registerSeriesToDb({
					cardAddress,
					tokenId: String(tokenId),
					sharedMetadataHash: expectedHash,
					ipfsCid: hasIpfs ? String(ipfsCid).trim() : undefined,
					cardOwner,
					metadataJson: metadata ?? undefined,
				})
				res.status(200).json({ success: true })
			} catch (err: any) {
				logger(Colors.red('[registerSeries] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to register series' })
			}
		})

		/** POST /api/registerMintMetadata - 登记单笔 mint 的 metadata（cluster 预检后转发） */
		router.post('/registerMintMetadata', async (req, res) => {
			const { cardAddress, tokenId, ownerAddress, txHash, metadata } = req.body as {
				cardAddress?: string
				tokenId?: string
				ownerAddress?: string
				txHash?: string
				metadata?: Record<string, unknown>
			}
			if (!cardAddress || !ethers.isAddress(cardAddress) || !tokenId || !ownerAddress || !ethers.isAddress(ownerAddress) || !metadata || typeof metadata !== 'object') {
				return res.status(400).json({ error: 'Missing cardAddress, tokenId, ownerAddress, or metadata (object)' })
			}
			try {
				await registerMintMetadataToDb({
					cardAddress,
					tokenId: String(tokenId),
					ownerAddress,
					txHash,
					metadataJson: metadata,
				})
				res.status(200).json({ success: true })
			} catch (err: any) {
				logger(Colors.red('[registerMintMetadata] error:'), err?.message ?? err)
				res.status(500).json({ error: err?.message ?? 'Failed to register mint metadata' })
			}
		})

		/** 创建 BeamioUserCard。由 cluster 完整预检，master 不做任何入站校验，直接入队 createCardPool。*/
		router.post('/createCard', (req, res) => {
			const body = req.body as {
				cardOwner: string
				currency: 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD'
				priceInCurrencyE6: string
				uri?: string
				shareTokenMetadata?: { name?: string; description?: string; image?: string }
				tiers?: Array<{ index: number; minUsdc6: string; attr: number; tierExpirySeconds?: number; name?: string; description?: string; image?: string; backgroundColor?: string; upgradeByBalance?: boolean }>
				/** Set by Cluster when BusinessStartKet #0 must be burned before deploy */
				businessStartKetBurnFrom?: string
				createCardOwnerAsRequested?: string
			}
			createCardPool.push({ ...body, res })
			logger(Colors.cyan(`[createCard] pushed to pool, cardOwner=${body.cardOwner}`))
			createCardPoolPress()
		})

		/**
		 * 已发卡仅更新 ERC-1155 卡级 JSON（recharge bonus / shareTokenMetadata / tiers 等），不写链。
		 * Cluster 需在预检（持卡人身份等）后转发至 Master，与 /api/createCard 一致。
		 */
		router.post('/updateCardShareMetadata', async (req, res) => {
			const body = req.body as {
				cardAddress?: string
				shareTokenMetadata?: Record<string, unknown>
				tiers?: Array<Record<string, unknown>>
				upgradeType?: number
				transferWhitelistEnabled?: boolean
			}
			const cardAddress = body.cardAddress?.trim()
			if (!cardAddress || !ethers.isAddress(cardAddress)) {
				res.status(400).json({ success: false, error: 'Invalid or missing cardAddress' }).end()
				return
			}
			if (!body.shareTokenMetadata || typeof body.shareTokenMetadata !== 'object') {
				res.status(400).json({ success: false, error: 'shareTokenMetadata object is required' }).end()
				return
			}
			try {
				const r = await applyBeamioCardShareMetadataUpdate({
					cardAddress,
					shareTokenMetadata: body.shareTokenMetadata,
					...(body.tiers != null && { tiers: body.tiers }),
					...(body.upgradeType != null && { upgradeType: body.upgradeType }),
					...(typeof body.transferWhitelistEnabled === 'boolean' && {
						transferWhitelistEnabled: body.transferWhitelistEnabled,
					}),
				})
				if (!r.success) {
					res.status(400).json({ success: false, error: r.error ?? 'Metadata update failed' }).end()
					return
				}
				res.status(200).json({ success: true, cardAddress: ethers.getAddress(cardAddress) }).end()
			} catch (err: any) {
				logger(Colors.red('[updateCardShareMetadata] error:'), err?.message ?? err)
				res.status(500).json({ success: false, error: err?.message ?? 'Metadata update failed' }).end()
			}
		})

		router.post('/purchasingCard', (req, res) => {
			const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, preChecked, recommender } = req.body as {
				cardAddress: string
				userSignature: string
				nonce: string
				usdcAmount: string
				from: string
				validAfter: string
				validBefore: string
				preChecked?: import('../MemberCard').PurchasingCardPreChecked
				recommender?: string
			}

			purchasingCardPool.push({
				cardAddress,
				userSignature,
				nonce,
				usdcAmount,
				from,
				validAfter,
				validBefore,
				res: res,
				...(preChecked != null && { preChecked }),
				...(recommender != null && recommender !== '' && { recommender })
			})

			logger(` Master GOT /api/purchasingCard ${preChecked ? '[preChecked]' : ''} doing purchasingCardProcess...`, inspect({ cardAddress, from, usdcAmount, hasPreChecked: !!preChecked }, false, 3, true))
			purchasingCardProcess().catch((err: any) => {
				logger(Colors.red('[purchasingCardProcess] unhandled error (fire-and-forget):'), err?.message ?? err)
			})
		})

		/** USDC Topup（cluster 已完成完整预检）：master 直接入 purchasingCard 队列执行。 */
		router.post('/usdcTopup', (req, res) => {
			const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, preChecked, recommender } = req.body as {
				cardAddress: string
				userSignature: string
				nonce: string
				usdcAmount: string
				from: string
				validAfter: string
				validBefore: string
				preChecked?: import('../MemberCard').PurchasingCardPreChecked
				recommender?: string
			}
			purchasingCardPool.push({
				cardAddress,
				userSignature,
				nonce,
				usdcAmount,
				from,
				validAfter,
				validBefore,
				res,
				...(preChecked != null && { preChecked }),
				...(recommender != null && recommender !== '' && { recommender })
			})
			logger(` Master GOT /api/usdcTopup ${preChecked ? '[preChecked]' : ''} -> purchasingCardProcess`, inspect({ cardAddress, from, usdcAmount, hasPreChecked: !!preChecked }, false, 3, true))
			purchasingCardProcess().catch((err: any) => {
				logger(Colors.red('[purchasingCardProcess] usdcTopup unhandled:'), err?.message ?? err)
			})
		})

		/** x402 BeamioTransfer 成功后：写入 BeamioIndexerDiamond（master 队列处理） */
		router.post('/beamioTransferIndexerAccounting', (req, res) => {
			logger(Colors.gray(`[DEBUG] beamioTransferIndexerAccounting received bodyKeys=${Object.keys(req.body || {}).join(',')} from=${(req.body as any)?.from?.slice?.(0, 10)}… to=${(req.body as any)?.to?.slice?.(0, 10)}… requestHash=${(req.body as any)?.requestHash ?? 'n/a'} poolBefore=${beamioTransferIndexerAccountingPool.length}`))
			const {
				from,
				to,
				amountUSDC6,
				finishedHash,
				displayJson,
				note,
				currency,
				currencyAmount,
				gasWei,
				gasUSDC6,
				gasChainType,
				baseGas,
				feePayer,
				isInternalTransfer,
				requestHash,
				source,
				payeeEOA,
				merchantCardAddress,
				ledgerTxId,
				ledgerOriginalPaymentHash,
				ledgerTxCategory,
				routeItems,
				ledgerFinalRequestAmountFiat6,
				ledgerFinalRequestAmountUSDC6,
				ledgerMetaRequestAmountFiat6,
				ledgerMetaRequestAmountUSDC6,
				ledgerMetaDiscountAmountFiat6,
				ledgerMetaDiscountRateBps,
				ledgerMetaTaxAmountFiat6,
				ledgerMetaTaxRateBps,
				bServiceUSDC6,
				bServiceUnits6,
			} = req.body as {
				from?: string
				to?: string
				amountUSDC6?: string
				finishedHash?: string
				requestHash?: string
				displayJson?: string
				note?: string
				currency?: string
				currencyAmount?: string
				gasWei?: string
				gasUSDC6?: string
				gasChainType?: number
				baseGas?: string
				feePayer?: string
				isInternalTransfer?: boolean
				source?: string
				payeeEOA?: string
				merchantCardAddress?: string
				ledgerTxId?: string
				ledgerOriginalPaymentHash?: string
				ledgerTxCategory?: string
				routeItems?: unknown
				ledgerFinalRequestAmountFiat6?: string
				ledgerFinalRequestAmountUSDC6?: string
				ledgerMetaRequestAmountFiat6?: string
				ledgerMetaRequestAmountUSDC6?: string
				ledgerMetaDiscountAmountFiat6?: string
				ledgerMetaDiscountRateBps?: number
				ledgerMetaTaxAmountFiat6?: string
				ledgerMetaTaxRateBps?: number
				bServiceUSDC6?: string
				bServiceUnits6?: string
			}
			if (!ethers.isAddress(from) || !ethers.isAddress(to) || !amountUSDC6 || !finishedHash || !ethers.isAddress(feePayer)) {
				return res.status(400).json({ success: false, error: 'Invalid payload: from,to,amountUSDC6,finishedHash,feePayer required' }).end()
			}
			if (String(from).toLowerCase() === String(to).toLowerCase()) {
				logger(Colors.red(`[beamioTransferIndexerAccounting] REJECT: from=to (payer=payee) from=${from} finishedHash=${finishedHash}`))
				return res.status(400).json({ success: false, error: 'from and to must be different (payer≠payee)' }).end()
			}
			try {
				const amount = BigInt(amountUSDC6)
				if (amount <= 0n) {
					return res.status(400).json({ success: false, error: 'amountUSDC6 must be > 0' }).end()
				}
				if (!ethers.isHexString(finishedHash) || ethers.dataLength(finishedHash) !== 32) {
					return res.status(400).json({ success: false, error: 'finishedHash must be bytes32 tx hash' }).end()
				}
				const _gasWei = BigInt(gasWei ?? '0')
				if (_gasWei < 0n) {
					return res.status(400).json({ success: false, error: 'gasWei must be >= 0' }).end()
				}
				const _gasUSDC6 = BigInt(gasUSDC6 ?? '0')
				if (_gasUSDC6 < 0n) {
					return res.status(400).json({ success: false, error: 'gasUSDC6 must be >= 0' }).end()
				}
				if (gasChainType == null || !Number.isInteger(gasChainType) || gasChainType < 0 || gasChainType > 1) {
					return res.status(400).json({ success: false, error: 'gasChainType must be 0(ETH) or 1(SOLANA)' }).end()
				}
			} catch {
				return res.status(400).json({ success: false, error: 'Invalid bigint string: amountUSDC6/gasWei/gasUSDC6' }).end()
			}

			const reqHashValid = requestHash && ethers.isHexString(requestHash) && ethers.dataLength(requestHash) === 32 ? requestHash : undefined
			// requestHash 预检已由 Cluster 完成，Master 假定数据合格
			if (!currency || !String(currency).trim()) {
				logger(Colors.yellow(`[DEBUG] beamioTransferIndexerAccounting: currency missing or empty from=${from} to=${to} finishedHash=${finishedHash}`))
			}

			const ledgerTxIdTrim = ledgerTxId != null ? String(ledgerTxId).trim() : ''
			const ledgerTxIdOk =
				ledgerTxIdTrim !== '' && ethers.isHexString(ledgerTxIdTrim) && ethers.dataLength(ledgerTxIdTrim) === 32
			const ledgerOrigTrim = ledgerOriginalPaymentHash != null ? String(ledgerOriginalPaymentHash).trim() : ''
			const ledgerOrigOk =
				ledgerOrigTrim !== '' && ethers.isHexString(ledgerOrigTrim) && ethers.dataLength(ledgerOrigTrim) === 32
			const ledgerCatTrim = ledgerTxCategory != null ? String(ledgerTxCategory).trim() : ''
			const ledgerCatOk =
				ledgerCatTrim !== '' && ethers.isHexString(ledgerCatTrim) && ethers.dataLength(ledgerCatTrim) === 32
			const parsedRouteItems = normalizeBeamioRouteItemsFromBody(routeItems)

			beamioTransferIndexerAccountingPool.push({
				from: String(from),
				to: String(to),
				amountUSDC6: String(amountUSDC6),
				finishedHash: String(finishedHash),
				displayJson: displayJson ? String(displayJson) : undefined,
				note: note ? String(note) : '',
				currency: currency ? String(currency) : undefined,
				currencyAmount: currencyAmount != null ? String(currencyAmount) : undefined,
				gasWei: String(gasWei ?? '0'),
				gasUSDC6: String(gasUSDC6 ?? '0'),
				gasChainType: Number(gasChainType ?? 0),
				baseGas: baseGas != null ? String(baseGas) : undefined,
				feePayer: String(feePayer),
				isInternalTransfer: !!isInternalTransfer,
				requestHash: reqHashValid,
				source: source === 'x402' ? 'x402' : (source === 'open-container' || source === 'container' ? source : undefined),
				payeeEOA: payeeEOA && ethers.isAddress(payeeEOA) ? payeeEOA : undefined,
				merchantCardAddress: merchantCardAddress && ethers.isAddress(merchantCardAddress) ? merchantCardAddress : undefined,
				...(ledgerTxIdOk ? { ledgerTxId: ledgerTxIdTrim } : {}),
				...(ledgerOrigOk ? { ledgerOriginalPaymentHash: ledgerOrigTrim } : {}),
				...(ledgerCatOk ? { ledgerTxCategory: ledgerCatTrim } : {}),
				...(parsedRouteItems ? { routeItems: parsedRouteItems } : {}),
				...(ledgerFinalRequestAmountFiat6 != null && String(ledgerFinalRequestAmountFiat6).trim() !== ''
					? { ledgerFinalRequestAmountFiat6: String(ledgerFinalRequestAmountFiat6) }
					: {}),
				...(ledgerFinalRequestAmountUSDC6 != null && String(ledgerFinalRequestAmountUSDC6).trim() !== ''
					? { ledgerFinalRequestAmountUSDC6: String(ledgerFinalRequestAmountUSDC6) }
					: {}),
				...(ledgerMetaRequestAmountFiat6 != null && String(ledgerMetaRequestAmountFiat6).trim() !== ''
					? { ledgerMetaRequestAmountFiat6: String(ledgerMetaRequestAmountFiat6) }
					: {}),
				...(ledgerMetaRequestAmountUSDC6 != null && String(ledgerMetaRequestAmountUSDC6).trim() !== ''
					? { ledgerMetaRequestAmountUSDC6: String(ledgerMetaRequestAmountUSDC6) }
					: {}),
				...(ledgerMetaDiscountAmountFiat6 != null && String(ledgerMetaDiscountAmountFiat6).trim() !== ''
					? { ledgerMetaDiscountAmountFiat6: String(ledgerMetaDiscountAmountFiat6) }
					: {}),
				...(ledgerMetaDiscountRateBps != null && Number.isFinite(Number(ledgerMetaDiscountRateBps))
					? { ledgerMetaDiscountRateBps: Number(ledgerMetaDiscountRateBps) }
					: {}),
				...(ledgerMetaTaxAmountFiat6 != null && String(ledgerMetaTaxAmountFiat6).trim() !== ''
					? { ledgerMetaTaxAmountFiat6: String(ledgerMetaTaxAmountFiat6) }
					: {}),
				...(ledgerMetaTaxRateBps != null && Number.isFinite(Number(ledgerMetaTaxRateBps))
					? { ledgerMetaTaxRateBps: Number(ledgerMetaTaxRateBps) }
					: {}),
				...(bServiceUSDC6 != null && String(bServiceUSDC6).trim() !== '' ? { bServiceUSDC6: String(bServiceUSDC6) } : {}),
				...(bServiceUnits6 != null && String(bServiceUnits6).trim() !== '' ? { bServiceUnits6: String(bServiceUnits6) } : {}),
				res,
			})
			logger(Colors.cyan(`[beamioTransferIndexerAccounting] pushed to pool from=${from} to=${to} amountUSDC6=${amountUSDC6} requestHash=${reqHashValid ?? 'n/a'} (raw=${requestHash ?? 'undefined'})`))
			beamioTransferIndexerAccountingProcess().catch((err: any) => {
				logger(Colors.red('[beamioTransferIndexerAccountingProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** Beamio Pay Me 生成 request 记账（txCategory=request_create:confirmed，originalPaymentHash=requestHash）。Cluster 已预检 B-Unit 费用。 */
		router.post('/requestAccounting', (req, res) => {
			const { requestHash, payee, amount, currency, forText, validDays, feeBUnits, payerEOA } = req.body as {
				requestHash?: string
				payee?: string
				amount?: string
				currency?: string
				forText?: string
				validDays?: number
				feeBUnits?: string
				payerEOA?: string
			}
			if (!requestHash || !payee || !amount || validDays == null) {
				return res.status(400).json({ success: false, error: 'Missing required: requestHash, payee, amount, validDays' }).end()
			}
			if (!ethers.isHexString(requestHash) || ethers.dataLength(requestHash) !== 32) {
				return res.status(400).json({ success: false, error: 'requestHash must be bytes32' }).end()
			}
			if (!ethers.isAddress(payee)) {
				return res.status(400).json({ success: false, error: 'Invalid payee address' }).end()
			}
			const amt = parseFloat(String(amount))
			if (!Number.isFinite(amt) || amt <= 0) {
				return res.status(400).json({ success: false, error: 'amount must be > 0' }).end()
			}
			const vd = Math.floor(Number(validDays))
			if (vd < 1) {
				return res.status(400).json({ success: false, error: 'validDays must be >= 1' }).end()
			}

			requestAccountingPool.push({
				requestHash: String(requestHash),
				payee: String(payee),
				amount: String(amount),
				currency: currency ? String(currency) : 'USD',
				forText: forText ? String(forText) : undefined,
				validDays: vd,
				feeBUnits: feeBUnits ? BigInt(feeBUnits) : undefined,
				payerEOA: payerEOA && ethers.isAddress(payerEOA) ? ethers.getAddress(payerEOA) : undefined,
				res,
			})
			logger(Colors.cyan(`[requestAccounting] pushed to pool requestHash=${requestHash} payee=${payee}`))
			requestAccountingProcess().catch((err: any) => {
				logger(Colors.red('[requestAccountingProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** Payee 取消 Request：验证 payee 对 originalPaymentHash 的签字，创建 request_cancel 记账 */
		router.post('/cancelRequest', (req, res) => {
			const { originalPaymentHash, payeeSignature } = req.body as { originalPaymentHash?: string; payeeSignature?: string }
			if (!originalPaymentHash || !payeeSignature) {
				return res.status(400).json({ success: false, error: 'Missing originalPaymentHash or payeeSignature' }).end()
			}
			if (!ethers.isHexString(originalPaymentHash) || ethers.dataLength(originalPaymentHash) !== 32) {
				return res.status(400).json({ success: false, error: 'originalPaymentHash must be bytes32' }).end()
			}
			if (typeof payeeSignature !== 'string' || !/^0x[a-fA-F0-9]+$/.test(payeeSignature) || (payeeSignature.length - 2) / 2 !== 65) {
				return res.status(400).json({ success: false, error: 'payeeSignature must be 65-byte hex' }).end()
			}
			cancelRequestAccountingPool.push({ originalPaymentHash: String(originalPaymentHash), payeeSignature: String(payeeSignature), res })
			logger(Colors.cyan(`[cancelRequest] pushed to pool originalPaymentHash=${originalPaymentHash.slice(0, 10)}…`))
			cancelRequestAccountingProcess().catch((err: any) => {
				logger(Colors.red('[cancelRequestAccountingProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** cardCreateRedeem：由 cluster 预检后转发，master 推入 executeForOwnerPool，统一经 Settle_ContractPool 排队处理 */
		router.post('/cardCreateRedeem', (req, res) => {
			const preChecked = req.body as {
				cardAddress?: string
				data?: string
				deadline?: number
				nonce?: string
				ownerSignature?: string
			}
			const { cardAddress, data, deadline, nonce, ownerSignature } = preChecked
			if (!cardAddress || !data || deadline == null || !nonce || !ownerSignature) {
				return res.status(400).json({ success: false, error: 'Missing required fields: cardAddress, data, deadline, nonce, ownerSignature' })
			}
			executeForOwnerPool.push({ cardAddress, data, deadline, nonce, ownerSignature, res })
			logger(Colors.cyan(`[cardCreateRedeem] pushed to executeForOwnerPool, card=${cardAddress}`))
			executeForOwnerProcess().catch((err: any) => {
				logger(Colors.red(`[executeForOwnerProcess] unhandled error:`), err?.message ?? err)
			})
		})

		/** cardRedeem：用户兑换 redeem 码，服务端 redeemForUser，点数/NFT mint 到用户 AA */
		router.post('/cardRedeem', (req, res) => {
			const { cardAddress, redeemCode, toUserEOA } = req.body as { cardAddress?: string; redeemCode?: string; toUserEOA?: string }
			if (!cardAddress || !redeemCode || !toUserEOA || !ethers.isAddress(cardAddress) || !ethers.isAddress(toUserEOA)) {
				return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, toUserEOA' })
			}
			cardRedeemPool.push({ cardAddress, redeemCode, toUserEOA, res })
			logger(Colors.cyan(`[cardRedeem] pushed to pool, card=${cardAddress} to=${toUserEOA}`))
			cardRedeemProcess().catch((err: any) => {
				logger(Colors.red('[cardRedeemProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** redeemSeries：用户使用 redeem code 兑换 NFT，与 cardRedeem 同一逻辑 */
		router.post('/redeemSeries', (req, res) => {
			const { cardAddress, redeemCode, toUserEOA } = req.body as { cardAddress?: string; redeemCode?: string; toUserEOA?: string }
			if (!cardAddress || !redeemCode || !toUserEOA || !ethers.isAddress(cardAddress) || !ethers.isAddress(toUserEOA)) {
				return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, toUserEOA' })
			}
			cardRedeemPool.push({ cardAddress, redeemCode, toUserEOA, res })
			logger(Colors.cyan(`[redeemSeries] pushed to pool, card=${cardAddress} to=${toUserEOA}`))
			cardRedeemProcess().catch((err: any) => {
				logger(Colors.red('[cardRedeemProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** cardRedeemAdmin：用户兑换 redeem-admin 码，添加 to 为 admin，服务端 redeemAdminForUser */
		router.post('/cardRedeemAdmin', (req, res) => {
			const { cardAddress, redeemCode, to } = req.body as { cardAddress?: string; redeemCode?: string; to?: string }
			if (!cardAddress || !redeemCode || !to || !ethers.isAddress(cardAddress) || !ethers.isAddress(to)) {
				return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, to' })
			}
			cardRedeemAdminPool.push({ cardAddress, redeemCode, to, res })
			logger(Colors.cyan(`[cardRedeemAdmin] pushed to pool, card=${cardAddress} to=${to}`))
			cardRedeemAdminProcess().catch((err: any) => {
				logger(Colors.red('[cardRedeemAdminProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** cardClearAdminMintCounter：parent admin 签字清零 subordinate 的 mint 计数。Cluster 已预检，Master 调用 Factory（Card）+ Indexer */
		router.post('/cardClearAdminMintCounter', async (req, res) => {
			const { cardAddress, subordinate, deadline, nonce, adminSignature } = req.body as {
				cardAddress?: string; subordinate?: string; deadline?: number; nonce?: string; adminSignature?: string
			}
			if (!cardAddress || !subordinate || !ethers.isAddress(cardAddress) || !ethers.isAddress(subordinate)) {
				return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, subordinate' }).end()
			}
			if (deadline == null || !nonce || !adminSignature) {
				return res.status(400).json({ success: false, error: 'Missing: deadline, nonce, adminSignature' }).end()
			}
			const result = await cardClearAdminMintCounterProcess({ cardAddress, subordinate, deadline, nonce, adminSignature })
			if (!result.success) {
				return res.status(400).json(result).end()
			}
			return res.status(200).json({ success: true, tx: result.tx }).end()
		})

		/** cardTerminalSettlementClear：parent admin 签 TerminalSettlementClear；仅 indexer TX_Terminal_RESET，不清 Base mint。Cluster 已预检。 */
		router.post('/cardTerminalSettlementClear', async (req, res) => {
			const { cardAddress, subordinate, deadline, nonce, adminSignature } = req.body as {
				cardAddress?: string; subordinate?: string; deadline?: number; nonce?: string; adminSignature?: string
			}
			if (!cardAddress || !subordinate || !ethers.isAddress(cardAddress) || !ethers.isAddress(subordinate)) {
				return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, subordinate' }).end()
			}
			if (deadline == null || !nonce || !adminSignature) {
				return res.status(400).json({ success: false, error: 'Missing: deadline, nonce, adminSignature' }).end()
			}
			const result = await cardTerminalSettlementClearProcess({ cardAddress, subordinate, deadline, nonce, adminSignature })
			if (!result.success) {
				return res.status(400).json(result).end()
			}
			return res.status(200).json({ success: true, syncTx: result.syncTx }).end()
		})

		router.post('/executeForOwner', async (req, res) => {
			const { cardAddress, data, deadline, nonce, ownerSignature, redeemCode, toUserEOA, targetAddress, description, image, background_color } = req.body as {
				cardAddress?: string
				data?: string
				deadline?: number
				nonce?: string
				ownerSignature?: string
				redeemCode?: string
				toUserEOA?: string
				targetAddress?: string
				description?: string
				image?: string
				background_color?: string
			}
			if (!cardAddress || !data || deadline == null || !nonce || !ownerSignature) {
				return res.status(400).json({ success: false, error: 'Missing required fields: cardAddress, data, deadline, nonce, ownerSignature' })
			}
			if (targetAddress && ethers.isAddress(targetAddress)) {
				try {
					await ensureAAForMintTarget(targetAddress)
				} catch (e: any) {
					logger(Colors.red(`[executeForOwner] ensureAAForMintTarget failed: ${e?.message ?? e}`))
					return res.status(500).json({ success: false, error: e?.message ?? 'Failed to create AA for recipient' })
				}
			}
			executeForOwnerPool.push({ cardAddress, data, deadline, nonce, ownerSignature, redeemCode, toUserEOA, res, description, image, background_color })
			logger(Colors.cyan(`[executeForOwner] pushed to pool, card=${cardAddress}`))
			executeForOwnerProcess().catch((err: any) => {
				logger(Colors.red('[executeForOwnerProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** cardUpdateTiers：Cluster 已校验 owner signature + setTiers calldata；Master 执行链上 setTiers，确认后同步 metadata。 */
		router.post('/cardUpdateTiers', async (req, res) => {
			const body = req.body as {
				cardAddress: string
				data: string
				deadline: number
				nonce: string
				ownerSignature: string
				shareTokenMetadata: Record<string, unknown>
				tiers?: Array<Record<string, unknown>>
				upgradeType?: number
				transferWhitelistEnabled?: boolean
			}
			executeForOwnerPool.push({
				cardAddress: body.cardAddress,
				data: body.data,
				deadline: body.deadline,
				nonce: body.nonce,
				ownerSignature: body.ownerSignature,
				res,
				metadataUpdate: {
					shareTokenMetadata: body.shareTokenMetadata,
					...(body.tiers != null && { tiers: body.tiers }),
					...(body.upgradeType != null && { upgradeType: body.upgradeType }),
					...(typeof body.transferWhitelistEnabled === 'boolean' && {
						transferWhitelistEnabled: body.transferWhitelistEnabled,
					}),
				},
			})
			logger(Colors.cyan(`[cardUpdateTiers] pushed to executeForOwnerPool, card=${body.cardAddress}`))
			executeForOwnerProcess().catch((err: any) => {
				logger(Colors.red('[executeForOwnerProcess] cardUpdateTiers unhandled error:'), err?.message ?? err)
			})
		})

		/** AA→EOA：支持三种提交。(1) ERC-4337 UserOp → AAtoEOAProcess；(2) openContainerPayload → OpenContainerRelayProcess；(3) containerPayload（绑定 to）→ ContainerRelayProcess。requestHash 预检已由 Cluster 完成 */
		router.post('/AAtoEOA', (req, res) => {
			const body = req.body as {
				toEOA?: string
				amountUSDC6?: string
				packedUserOp?: AAtoEOAUserOp
				openContainerPayload?: OpenContainerRelayPayload
				containerPayload?: ContainerRelayPayload
				currency?: string | string[]
				currencyAmount?: string | string[]
				currencyDiscount?: string | string[]
				currencyDiscountAmount?: string | string[]
				forText?: string
				requestHash?: string
				validDays?: number | string
				merchantCardAddress?: string
				nfcSubtotalCurrencyAmount?: string
				nfcTipCurrencyAmount?: string
				nfcTipRateBps?: number
				nfcRequestCurrency?: string
				nfcDiscountAmountFiat6?: string
				nfcDiscountRateBps?: number
				nfcTaxAmountFiat6?: string
				nfcTaxRateBps?: number
				chargeOwnerChildBurn?: import('../MemberCard').ChargeOwnerChildBurnPayload
				/** PR #4 (USDC charge orchestrator)：把外部 USDC settle tx + POS sid + 操作员标记到本笔 container charge，
				 *  ContainerRelayPool 持有，便于事后按 sid 关联三段（USDC settle → tmp wallet topup → tmp wallet charge）。 */
				originatingUSDCTx?: string
				chargeSessionId?: string
				posOperator?: string
				chargeLedgerMainUsdc6?: string
			}
			logger(`[AAtoEOA] [DEBUG] Master received openContainer=${!!body?.openContainerPayload} requestHash=${body?.requestHash ?? 'n/a'} forText=${body?.forText ? `"${String(body.forText).slice(0, 40)}…"` : 'n/a'} OpenContainerRelayPool.len=${OpenContainerRelayPool.length} Settle_ContractPool.len=${Settle_ContractPool.length}`)
			logger(`[AAtoEOA] master received POST /api/AAtoEOA`, inspect({ toEOA: body?.toEOA, amountUSDC6: body?.amountUSDC6, sender: body?.packedUserOp?.sender, openContainer: !!body?.openContainerPayload, container: !!body?.containerPayload, requestHash: body?.requestHash ?? 'n/a', forText: body?.forText ? `${body.forText.slice(0, 40)}…` : 'n/a' }, false, 3, true))

			if (body.containerPayload) {
				const preCheck = ContainerRelayPreCheck(body.containerPayload)
				if (!preCheck.success) {
					logger(Colors.red(`[AAtoEOA] master Container validation FAIL: ${preCheck.error}`))
					return res.status(400).json({ success: false, error: preCheck.error ?? 'Invalid containerPayload' }).end()
				}
				const origUsdcTxNorm =
					typeof body.originatingUSDCTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.originatingUSDCTx.trim())
						? body.originatingUSDCTx.trim().toLowerCase()
						: undefined
				const sidNorm =
					typeof body.chargeSessionId === 'string' && body.chargeSessionId.trim().length > 0
						? body.chargeSessionId.trim().toLowerCase()
						: undefined
				const posOpNorm =
					typeof body.posOperator === 'string' && ethers.isAddress(body.posOperator.trim())
						? ethers.getAddress(body.posOperator.trim())
						: undefined
				const poolLenBefore = ContainerRelayPool.length
				ContainerRelayPool.push({
					containerPayload: body.containerPayload,
					currency: body.currency,
					currencyAmount: body.currencyAmount,
					currencyDiscount: body.currencyDiscount,
					currencyDiscountAmount: body.currencyDiscountAmount,
					forText: body.forText?.trim() || undefined,
					requestHash: body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined,
					merchantCardAddress: body.merchantCardAddress && ethers.isAddress(body.merchantCardAddress) ? body.merchantCardAddress : undefined,
					nfcSubtotalCurrencyAmount:
						body.nfcSubtotalCurrencyAmount != null && String(body.nfcSubtotalCurrencyAmount).trim() !== ''
							? String(body.nfcSubtotalCurrencyAmount).trim()
							: undefined,
					nfcTipCurrencyAmount:
						body.nfcTipCurrencyAmount != null && String(body.nfcTipCurrencyAmount).trim() !== ''
							? String(body.nfcTipCurrencyAmount).trim()
							: undefined,
					nfcTipRateBps:
						body.nfcTipRateBps != null && Number.isFinite(Number(body.nfcTipRateBps))
							? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTipRateBps))))
							: undefined,
					nfcRequestCurrency:
						body.nfcRequestCurrency != null && String(body.nfcRequestCurrency).trim() !== ''
							? String(body.nfcRequestCurrency).trim()
							: undefined,
					nfcDiscountAmountFiat6:
						body.nfcDiscountAmountFiat6 != null && String(body.nfcDiscountAmountFiat6).trim() !== ''
							? String(body.nfcDiscountAmountFiat6).trim()
							: undefined,
					nfcDiscountRateBps:
						body.nfcDiscountRateBps != null && Number.isFinite(Number(body.nfcDiscountRateBps))
							? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcDiscountRateBps))))
							: undefined,
					nfcTaxAmountFiat6:
						body.nfcTaxAmountFiat6 != null && String(body.nfcTaxAmountFiat6).trim() !== ''
							? String(body.nfcTaxAmountFiat6).trim()
							: undefined,
					nfcTaxRateBps:
						body.nfcTaxRateBps != null && Number.isFinite(Number(body.nfcTaxRateBps))
							? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTaxRateBps))))
							: undefined,
					chargeOwnerChildBurn: body.chargeOwnerChildBurn,
					originatingUSDCTx: origUsdcTxNorm,
					chargeSessionId: sidNorm,
					posOperator: posOpNorm,
					...(typeof body.chargeLedgerMainUsdc6 === 'string' && body.chargeLedgerMainUsdc6.trim() !== ''
						? { chargeLedgerMainUsdc6: body.chargeLedgerMainUsdc6.trim() }
						: {}),
					res,
				})
				if (sidNorm || origUsdcTxNorm) {
					logger(Colors.cyan(
						`[AAtoEOA/Container] orchestrator-tagged container: sid=${sidNorm ?? 'n/a'} originatingUSDCTx=${origUsdcTxNorm ?? 'n/a'} pos=${posOpNorm ? posOpNorm.slice(0, 10) + '…' : 'n/a'}`
					))
				}
				logger(`[AAtoEOA] master pushed to ContainerRelayPool (length ${poolLenBefore} -> ${ContainerRelayPool.length}), calling ContainerRelayProcess()`)
				ContainerRelayProcess().catch((err: any) => {
					logger(Colors.red('[ContainerRelayProcess] unhandled error:'), err?.message ?? err)
				})
				return
			}

			if (body.openContainerPayload) {
				logger(Colors.cyan(`[AAtoEOA] [DEBUG] Master openContainerPayload JSON: ${JSON.stringify(body.openContainerPayload)}`))
				const preCheck = OpenContainerRelayPreCheck(body.openContainerPayload)
				if (!preCheck.success) {
					logger(Colors.red(`[AAtoEOA] master OpenContainer validation FAIL: ${preCheck.error}`))
					return res.status(400).json({ success: false, error: preCheck.error ?? 'Invalid openContainerPayload' }).end()
				}
				const poolLenBefore = OpenContainerRelayPool.length
				const posOpOpenNorm =
					typeof body.posOperator === 'string' && ethers.isAddress(body.posOperator.trim())
						? ethers.getAddress(body.posOperator.trim())
						: undefined
				OpenContainerRelayPool.push({
					openContainerPayload: body.openContainerPayload,
					currency: body.currency,
					currencyAmount: body.currencyAmount,
					currencyDiscount: body.currencyDiscount,
					currencyDiscountAmount: body.currencyDiscountAmount,
					forText: body.forText?.trim() || undefined,
					requestHash: body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined,
					merchantCardAddress: body.merchantCardAddress && ethers.isAddress(body.merchantCardAddress) ? body.merchantCardAddress : undefined,
					nfcSubtotalCurrencyAmount:
						body.nfcSubtotalCurrencyAmount != null && String(body.nfcSubtotalCurrencyAmount).trim() !== ''
							? String(body.nfcSubtotalCurrencyAmount).trim()
							: undefined,
					nfcTipCurrencyAmount:
						body.nfcTipCurrencyAmount != null && String(body.nfcTipCurrencyAmount).trim() !== ''
							? String(body.nfcTipCurrencyAmount).trim()
							: undefined,
					nfcTipRateBps:
						body.nfcTipRateBps != null && Number.isFinite(Number(body.nfcTipRateBps))
							? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTipRateBps))))
							: undefined,
					nfcRequestCurrency:
						body.nfcRequestCurrency != null && String(body.nfcRequestCurrency).trim() !== ''
							? String(body.nfcRequestCurrency).trim()
							: undefined,
					nfcDiscountAmountFiat6:
						body.nfcDiscountAmountFiat6 != null && String(body.nfcDiscountAmountFiat6).trim() !== ''
							? String(body.nfcDiscountAmountFiat6).trim()
							: undefined,
					nfcDiscountRateBps:
						body.nfcDiscountRateBps != null && Number.isFinite(Number(body.nfcDiscountRateBps))
							? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcDiscountRateBps))))
							: undefined,
					nfcTaxAmountFiat6:
						body.nfcTaxAmountFiat6 != null && String(body.nfcTaxAmountFiat6).trim() !== ''
							? String(body.nfcTaxAmountFiat6).trim()
							: undefined,
					nfcTaxRateBps:
						body.nfcTaxRateBps != null && Number.isFinite(Number(body.nfcTaxRateBps))
							? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTaxRateBps))))
							: undefined,
					chargeOwnerChildBurn: body.chargeOwnerChildBurn,
					posOperator: posOpOpenNorm,
					...(typeof body.chargeLedgerMainUsdc6 === 'string' && body.chargeLedgerMainUsdc6.trim() !== ''
						? { chargeLedgerMainUsdc6: body.chargeLedgerMainUsdc6.trim() }
						: {}),
					res,
				})
				logger(`[AAtoEOA] master pushed to OpenContainerRelayPool (length ${poolLenBefore} -> ${OpenContainerRelayPool.length}), calling OpenContainerRelayProcess()`)
				OpenContainerRelayProcess().catch((err: any) => {
					logger(Colors.red('[OpenContainerRelayProcess] unhandled error:'), err?.message ?? err)
				})
				return
			}

			const { toEOA, amountUSDC6, packedUserOp } = body
			if (!ethers.isAddress(toEOA) || !amountUSDC6 || !packedUserOp?.sender || !packedUserOp?.callData || packedUserOp?.signature === undefined) {
				logger(Colors.red(`[AAtoEOA] master validation FAIL: need toEOA, amountUSDC6, packedUserOp OR containerPayload OR openContainerPayload`))
				return res.status(400).json({ success: false, error: 'Invalid data: need toEOA, amountUSDC6, packedUserOp OR containerPayload OR openContainerPayload' }).end()
			}
			const reqHashValid = body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined
			const poolLenBefore = AAtoEOAPool.length
			AAtoEOAPool.push({
				toEOA: toEOA as string,
				amountUSDC6,
				packedUserOp: packedUserOp as AAtoEOAUserOp,
				requestHash: reqHashValid,
				res,
			})
			logger(`[AAtoEOA] master pushed to pool (length ${poolLenBefore} -> ${AAtoEOAPool.length}), calling AAtoEOAProcess()`)
			AAtoEOAProcess().catch((err: any) => {
				logger(Colors.red('[AAtoEOAProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/claimBUnits - 由 cluster 预检后转发，master 推入 claimBUnitsPool，经 Settle_ContractPool 执行 BUnitAirdrop.claimFor */
		router.post('/claimBUnits', (req, res) => {
			const body = req.body as { claimant?: string; nonce?: string; deadline?: string; signature?: string }
			if (!body.claimant || !body.nonce || !body.deadline || !body.signature) {
				return res.status(400).json({ success: false, error: 'Missing claimant, nonce, deadline, or signature' }).end()
			}
			claimBUnitsPool.push({
				claimant: body.claimant,
				nonce: body.nonce,
				deadline: body.deadline,
				signature: body.signature,
				res,
			})
			claimBUnitsProcess().catch((err: any) => {
				logger(Colors.red('[claimBUnitsProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/buintRedeemAirdropRedeem - cluster 完整预检后转发；ensureAAForEOA(Base) 后 redeemWithCodeAsAdmin(CoNET → 用户 AA) */
		router.post('/buintRedeemAirdropRedeem', (req, res) => {
			const body = req.body as { eoa?: string; code?: string }
			if (!body.eoa || !ethers.isAddress(body.eoa) || typeof body.code !== 'string' || !body.code.trim()) {
				return res.status(400).json({ success: false, error: 'Missing eoa or code' }).end()
			}
			buintRedeemAirdropPool.push({
				eoa: ethers.getAddress(body.eoa),
				code: body.code.trim(),
				res,
			})
			buintRedeemAirdropProcess().catch((err: any) => {
				logger(Colors.red('[buintRedeemAirdropProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/businessStartKetRedeemRedeem — cluster 预检合格后转发；Settle 代付 gas 调 redeemWithCodeAsAdmin(recipient=用户 EOA) */
		router.post('/businessStartKetRedeemRedeem', (req, res) => {
			const body = req.body as { eoa?: string; code?: string }
			if (!body.eoa || !ethers.isAddress(body.eoa) || typeof body.code !== 'string' || !body.code.trim()) {
				return res.status(400).json({ success: false, error: 'Missing eoa or code' }).end()
			}
			businessStartKetRedeemUserRedeemPool.push({
				eoa: ethers.getAddress(body.eoa),
				code: body.code.trim(),
				res,
			})
			businessStartKetRedeemUserRedeemProcess().catch((err: any) => {
				logger(Colors.red('[businessStartKetRedeemUserRedeemProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/businessStartKetRedeemAdminCreate — cluster 预检合格后转发；Settle 代付 gas 调 createRedeemFor */
		router.post('/businessStartKetRedeemAdminCreate', (req, res) => {
			const b = req.body as {
				contract?: string
				admin?: string
				codeHash?: string
				tokenId?: string
				ketAmount?: string
				buintAmount?: string
				validAfter?: string
				validBefore?: string
				nonce?: string
				deadline?: string
				signature?: string
			}
			if (
				!b.contract ||
				!b.admin ||
				!b.codeHash ||
				b.tokenId == null ||
				b.ketAmount == null ||
				b.buintAmount == null ||
				b.validAfter == null ||
				b.validBefore == null ||
				b.nonce == null ||
				b.deadline == null ||
				!b.signature
			) {
				return res.status(400).json({ success: false, error: 'Missing create fields' }).end()
			}
			businessStartKetRedeemCreatePool.push({
				contract: ethers.getAddress(b.contract),
				admin: ethers.getAddress(b.admin),
				codeHash: b.codeHash,
				tokenId: BigInt(b.tokenId),
				ketAmount: BigInt(b.ketAmount),
				buintAmount: BigInt(b.buintAmount),
				validAfter: BigInt(b.validAfter),
				validBefore: BigInt(b.validBefore),
				nonce: BigInt(b.nonce),
				deadline: BigInt(b.deadline),
				signature: b.signature,
				res,
			})
			businessStartKetRedeemCreateProcess().catch((err: any) => {
				logger(Colors.red('[businessStartKetRedeemCreateProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/businessStartKetRedeemAdminCancel — cluster 预检合格后转发；Settle 代付 gas 调 cancelRedeemFor */
		router.post('/businessStartKetRedeemAdminCancel', (req, res) => {
			const b = req.body as {
				contract?: string
				admin?: string
				codeHash?: string
				nonce?: string
				deadline?: string
				signature?: string
			}
			if (!b.contract || !b.admin || !b.codeHash || b.nonce == null || b.deadline == null || !b.signature) {
				return res.status(400).json({ success: false, error: 'Missing cancel fields' }).end()
			}
			businessStartKetRedeemCancelPool.push({
				contract: ethers.getAddress(b.contract),
				admin: ethers.getAddress(b.admin),
				codeHash: b.codeHash,
				nonce: BigInt(b.nonce),
				deadline: BigInt(b.deadline),
				signature: b.signature,
				res,
			})
			businessStartKetRedeemCancelProcess().catch((err: any) => {
				logger(Colors.red('[businessStartKetRedeemCancelProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/purchaseBUnitFromBase - 由 cluster 预检后转发，master 推入 purchaseBUnitFromBasePool，经 Settle_ContractPool 执行 BaseTreasury.purchaseBUnitWith3009Authorization */
		router.post('/purchaseBUnitFromBase', (req, res) => {
			const body = req.body as { from?: string; amount?: string; validAfter?: number; validBefore?: number; nonce?: string; signature?: string }
			if (!body.from || !body.amount || body.validAfter == null || body.validBefore == null || !body.nonce || !body.signature) {
				return res.status(400).json({ success: false, error: 'Missing from, amount, validAfter, validBefore, nonce, or signature' }).end()
			}
			purchaseBUnitFromBasePool.push({
				from: body.from,
				amount: body.amount,
				validAfter: body.validAfter,
				validBefore: body.validBefore,
				nonce: body.nonce,
				signature: body.signature,
				res,
			})
			purchaseBUnitFromBaseProcess().catch((err: any) => {
				logger(Colors.red('[purchaseBUnitFromBaseProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/removePOS - 由 cluster 预检后转发，master 推入 removePOSPool，经 Settle_ContractPool 执行 MerchantPOSManagement.removePOSBySignature */
		router.post('/removePOS', (req, res) => {
			const body = req.body as { merchant?: string; pos?: string; deadline?: number; nonce?: string; signature?: string }
			if (!body.merchant || !body.pos || body.deadline == null || !body.nonce || !body.signature) {
				return res.status(400).json({ success: false, error: 'Missing merchant, pos, deadline, nonce, or signature' }).end()
			}
			removePOSPool.push({
				merchant: body.merchant,
				pos: body.pos,
				deadline: body.deadline,
				nonce: body.nonce,
				signature: body.signature,
				res,
			})
			removePOSProcess().catch((err: any) => {
				logger(Colors.red('[removePOSProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/registerPOS - 由 cluster 预检后转发，master 推入 registerPOSPool，执行 MerchantPOSManagement.registerPOSBySignature */
		router.post('/registerPOS', (req, res) => {
			const body = req.body as { merchant?: string; pos?: string; deadline?: number; nonce?: string; signature?: string }
			if (!body.merchant || !body.pos || body.deadline == null || !body.nonce || !body.signature) {
				return res.status(400).json({ success: false, error: 'Missing merchant, pos, deadline, nonce, or signature' }).end()
			}
			registerPOSPool.push({
				merchant: body.merchant,
				pos: body.pos,
				deadline: body.deadline,
				nonce: body.nonce,
				signature: body.signature,
				res,
			})
			registerPOSProcess().catch((err: any) => {
				logger(Colors.red('[registerPOSProcess] unhandled error:'), err?.message ?? err)
			})
		})

		router.post('/storageFragment', (req, res) => {
			const { hash, wallet, imageLength } = req.body as {
				wallet: string
				imageLength: number
				hash: string
			}
			ipfsDataPool.push({
				wallet, imageLength, hash
			})

			logger(`storageFragment ${hash} ${wallet} ${imageLength}`)

			ipfsDataProcess()
			res.status(200).end()

		})

		router.post('/getFragment', (req, res) => {
			const { hash } = req.body as {
				hash: string
			}
			ipfsAccessPool.push({
				hash
			})

			ipfsAccessProcess()
			res.status(200).end()

		})

		router.post('/coinbase-hooks', express.raw({ type: '*/*' }), (req, res) => {
			return coinbaseHooks(req, res)
		})

		/** POST /api/nfcCardStatus - 查询 NFC 卡状态（Master 可选实现，Cluster 已直接处理） */
		router.post('/nfcCardStatus', async (req, res) => {
			const { uid } = req.body as { uid?: string }
			if (!uid || typeof uid !== 'string') {
				return res.status(400).json({ error: 'Missing uid' })
			}
			const result = await getNfcCardByUid(uid)
			return res.status(200).json(result).end()
		})

		/** POST /api/registerNfcCard - 登记 NFC 卡（uid + private_key；tagId 可选，SUN 解密得到的 TagID） */
		router.post('/registerNfcCard', async (req, res) => {
			const { uid, privateKey, tagId } = req.body as { uid?: string; privateKey?: string; tagId?: string }
			if (!uid || typeof uid !== 'string' || !privateKey || typeof privateKey !== 'string') {
				return res.status(400).json({ ok: false, error: 'Missing uid or privateKey' })
			}
			await registerNfcCardToDb({ uid: uid.trim(), privateKey: privateKey.trim(), ...(tagId && typeof tagId === 'string' && { tagId: tagId.trim() }) })
			return res.status(200).json({ ok: true }).end()
		})

		/** POST /api/payByNfcUidPrepare - 客户端构建 container 前的准备，返回 account、nonce、deadline、payeeAA、cardCurrency、pointsUnitPriceInCurrencyE6（fiat6-only 协议）以及兼容的 unitPriceUSDC6。
		 *  fiat6-only 协议：传 `amountFiat6` + `currency`；`amountUsdc6` 已 deprecated，仅作回退。NFC 格式时需 e/c/m 做 SUN 校验。 */
		router.post('/payByNfcUidPrepare', async (req, res) => {
			const { uid, payee, amountUsdc6, amountFiat6, currency, e, c, m } = req.body as { uid?: string; payee?: string; amountUsdc6?: string; amountFiat6?: string; currency?: string; e?: string; c?: string; m?: string }
			if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
				return res.status(400).json({ ok: false, error: 'Missing uid' })
			}
			if (!payee || !ethers.isAddress(payee)) {
				return res.status(400).json({ ok: false, error: 'Invalid payee' })
			}
			const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : ''
			const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
			const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== ''
			const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n
			if (!fiat6Ok && !usdc6Ok) {
				return res.status(400).json({ ok: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' })
			}
			const result = await payByNfcUidPrepare({
				uid: uid.trim(),
				payee: ethers.getAddress(payee),
				amountUsdc6: usdc6Ok ? amountUsdc6 : undefined,
				amountFiat6: fiat6Ok ? fiat6Trim : undefined,
				currency: fiat6Ok ? currencyTrim : undefined,
				e,
				c,
				m,
			})
			return res.status(result.ok ? 200 : 400).json(result).end()
		})

		/** POST /api/payByNfcUidSignContainer - 接受 Android 打包的未签名 container，用 UID 私钥签名后 relay。NFC 格式时需 e/c/m 做 SUN 校验。 */
		router.post('/payByNfcUidSignContainer', async (req, res) => {
			const {
				uid,
				containerPayload,
				amountUsdc6,
				amountFiat6,
				currency,
				e,
				c,
				m,
				nfcSubtotalCurrencyAmount,
				nfcTipCurrencyAmount,
				nfcTipRateBps,
				nfcRequestCurrency,
				nfcDiscountAmountFiat6,
				nfcDiscountRateBps,
				nfcTaxAmountFiat6,
				nfcTaxRateBps,
				chargeOwnerChildBurn,
			} = req.body as {
				uid?: string
				containerPayload?: ContainerRelayPayloadUnsigned
				amountUsdc6?: string
				amountFiat6?: string
				currency?: string
				e?: string
				c?: string
				m?: string
				nfcSubtotalCurrencyAmount?: string
				nfcTipCurrencyAmount?: string
				nfcTipRateBps?: number
				nfcRequestCurrency?: string
				nfcDiscountAmountFiat6?: string
				nfcDiscountRateBps?: number
				nfcTaxAmountFiat6?: string
				nfcTaxRateBps?: number
				chargeOwnerChildBurn?: import('../MemberCard').ChargeOwnerChildBurnPayload
			}
			if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
				return res.status(400).json({ success: false, error: 'Missing uid' })
			}
			if (!containerPayload || typeof containerPayload !== 'object') {
				return res.status(400).json({ success: false, error: 'Missing containerPayload' })
			}
			const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : ''
			const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
			const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== ''
			const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n
			logger(Colors.cyan(`[payByNfcUidSignContainer] Master received container uid=${uid.slice(0, 16)}... amountFiat6=${fiat6Ok ? `${fiat6Trim} ${currencyTrim}` : 'none'} amountUsdc6=${usdc6Ok ? amountUsdc6 : 'none'}\n` + inspect(containerPayload, false, 4, true)))
			const preCheck = ContainerRelayPreCheckUnsigned(containerPayload)
			if (!preCheck.success) {
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			if (!fiat6Ok && !usdc6Ok) {
				return res.status(400).json({ success: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' })
			}
			const nfcLog = {
				nfcSubtotalCurrencyAmount: nfcSubtotalCurrencyAmount ?? null,
				nfcTipCurrencyAmount: nfcTipCurrencyAmount ?? null,
				nfcRequestCurrency: nfcRequestCurrency ?? null,
				types: {
					sub: typeof nfcSubtotalCurrencyAmount,
					tip: typeof nfcTipCurrencyAmount,
					cur: typeof nfcRequestCurrency,
				},
			}
			logger(Colors.gray(`[payByNfcUidSignContainer] Master NFC body (raw): ${JSON.stringify(nfcLog)}`))
			const result = await payByNfcUidSignContainer({
				uid: uid.trim(),
				containerPayload,
				amountUsdc6: usdc6Ok ? amountUsdc6 : undefined,
				amountFiat6: fiat6Ok ? fiat6Trim : undefined,
				currency: fiat6Ok ? currencyTrim : undefined,
				res,
				e,
				c,
				m,
				nfcSubtotalCurrencyAmount:
					nfcSubtotalCurrencyAmount != null && String(nfcSubtotalCurrencyAmount).trim() !== ''
						? String(nfcSubtotalCurrencyAmount).trim()
						: undefined,
				nfcTipCurrencyAmount:
					nfcTipCurrencyAmount != null && String(nfcTipCurrencyAmount).trim() !== ''
						? String(nfcTipCurrencyAmount).trim()
						: undefined,
				nfcTipRateBps:
					nfcTipRateBps != null && Number.isFinite(Number(nfcTipRateBps))
						? Math.max(0, Math.min(10000, Math.trunc(Number(nfcTipRateBps))))
						: undefined,
				nfcRequestCurrency:
					nfcRequestCurrency != null && String(nfcRequestCurrency).trim() !== ''
						? String(nfcRequestCurrency).trim()
						: undefined,
				nfcDiscountAmountFiat6:
					nfcDiscountAmountFiat6 != null && String(nfcDiscountAmountFiat6).trim() !== ''
						? String(nfcDiscountAmountFiat6).trim()
						: undefined,
				nfcDiscountRateBps,
				nfcTaxAmountFiat6:
					nfcTaxAmountFiat6 != null && String(nfcTaxAmountFiat6).trim() !== ''
						? String(nfcTaxAmountFiat6).trim()
						: undefined,
				nfcTaxRateBps,
				chargeOwnerChildBurn,
			})
			if (result.pushed) return
			if (res.headersSent) return
			return res.status(result.httpStatus ?? 400).json({ success: false, error: result.error }).end()
		})

		/** POST /api/payByNfcUid - 以 UID 支付：Smart Routing 聚合 CCSA+USDC 扣款，无 AA 时回退纯 USDC 转账 */
		router.post('/payByNfcUid', async (req, res) => {
			const { uid, amountUsdc6, amountFiat6, currency, payee } = req.body as { uid?: string; amountUsdc6?: string; amountFiat6?: string; currency?: string; payee?: string }
			logger(Colors.cyan(`[payByNfcUid] Master received uid=${uid?.slice(0, 16)}... amountFiat6=${amountFiat6 ?? 'none'} currency=${currency ?? 'none'} amountUsdc6=${amountUsdc6 ?? 'none'} payee=${payee}`))
			if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
				logger(Colors.red('[payByNfcUid] reject: Missing uid'))
				return res.status(400).json({ success: false, error: 'Missing uid' })
			}
			const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : ''
			const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
			const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== ''
			const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n
			if (!fiat6Ok && !usdc6Ok) {
				logger(Colors.red(`[payByNfcUid] reject: Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)`))
				return res.status(400).json({ success: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' })
			}
			const amountBig = usdc6Ok ? BigInt(String(amountUsdc6).trim()) : 0n
			if (!payee || !ethers.isAddress(payee)) {
				logger(Colors.red(`[payByNfcUid] reject: Invalid payee=${payee}`))
				return res.status(400).json({ success: false, error: 'Invalid payee address' })
			}
			if (!usdc6Ok && fiat6Ok) {
				// fiat6-only Charge 协议：/payByNfcUid 走 OpenContainer 路径，OpenContainer 仍按 USDC 计费。
				// TODO(下一批)：把 OpenContainer 路径接入 fiat6+chain quote 自洽换算。当前过渡期：要求 fiat6 客户端走 /payByNfcUidSignContainer。
				logger(Colors.red(`[payByNfcUid] fiat6-only client should use /payByNfcUidSignContainer (OpenContainer path 暂未支持 fiat6 自洽换算)`))
				return res.status(400).json({ success: false, error: 'fiat6-only client must use /payByNfcUidSignContainer (OpenContainer path 暂未支持 fiat6)' })
			}
			const privateKey = await getNfcCardPrivateKeyByUid(uid)
			logger(Colors.cyan(`[payByNfcUid] getNfcCardPrivateKeyByUid: ${privateKey ? 'OK (from DB or mnemonic)' : 'null (card not found)'}`))
			if (!privateKey) {
				return res.status(403).json({ success: false, error: 'Card not found' })
			}
			const openResult = await payByNfcUidOpenContainer({ uid: uid.trim(), amountUsdc6: amountUsdc6 ?? amountBig.toString(), payee: ethers.getAddress(payee), res })
			logger(Colors.cyan(`[payByNfcUid] payByNfcUidOpenContainer: pushed=${openResult.pushed}${openResult.error ? ` error=${openResult.error}` : ''}`))
			if (openResult.pushed) {
				return
			}
			if (openResult.error?.includes('linking to the Beamio app')) {
				return res.status(403).json({ success: false, error: openResult.error }).end()
			}
			// Payee cannot receive CCSA (e.g. EOA-only): skip fallback when pure USDC would also fail
			if (
				openResult.error &&
				(openResult.error.includes('EOA') ||
					openResult.error.includes('cannot receive CCSA') ||
					openResult.error.includes('无法接收 CCSA'))
			) {
				return res.status(400).json({ success: false, error: openResult.error }).end()
			}
			logger(Colors.yellow(`[payByNfcUid] fallback to simple USDC transfer`))
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const wallet = new ethers.Wallet(privateKey, provider)
				const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
				const usdcAbi = ['function transfer(address to, uint256 amount) returns (bool)']
				const usdc = new ethers.Contract(USDC_BASE, usdcAbi, wallet)
				const tx = await usdc.transfer(ethers.getAddress(payee), amountBig)
				await tx.wait()
				logger(Colors.green(`[payByNfcUid] fallback USDC uid=${uid.slice(0, 16)}... -> ${payee} amount=${amountUsdc6} tx=${tx.hash}`))
				try {
					const payerEoa = ethers.getAddress(await wallet.getAddress())
					const assets = await fetchUIDAssetsForEOA(payerEoa)
					scheduleEnsureNfcBeamioTagForEoa(payerEoa, uid.trim(), null, assets.cards)
				} catch (tagErr: any) {
					logger(Colors.yellow(`[payByNfcUid] NFC beamioTag ensure after fallback: ${tagErr?.message ?? tagErr}`))
				}
				return res.status(200).json({ success: true, USDC_tx: tx.hash }).end()
			} catch (e: any) {
				logger(Colors.red(`[payByNfcUid] failed: ${e?.message ?? e}`))
				return res.status(500).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'Transfer failed' }).end()
			}
		})

		/** POST /api/nfcLinkApp - 基础设施卡 owner 签 executeForOwner(createRedeemBatch)，返回明文 redeem 与深链 */
		router.post('/nfcLinkApp', async (req, res) => {
			await nfcLinkAppExecute(req.body ?? {}, res)
		})

		/** POST /api/nfcLinkAppCancel - 取消进行中 Link：executeForOwner(cancelRedeem)（若有）+ 释放 DB 会话 */
		router.post('/nfcLinkAppCancel', async (req, res) => {
			await nfcLinkAppCancelExecute(req.body ?? {}, res)
		})

		/** POST /api/nfcLinkAppClaimWithKey - App 完成 Link：redeem（若有）+ 将 nfc_cards 私钥换为用户密钥 + 释放会话 */
		router.post('/nfcLinkAppClaimWithKey', async (req, res) => {
			await nfcLinkAppClaimWithKeyExecute(req.body ?? {}, res)
		})

		/** POST /api/nfcTopupPrepare - 返回 executeForAdmin 所需的 cardAddr、data、deadline、nonce。cardAddress 必填；支持 uid（NFC）或 wallet（Scan QR）。 */
		router.post('/nfcTopupPrepare', async (req, res) => {
			const { uid, wallet, amount, currency, cardAddress } = req.body as { uid?: string; wallet?: string; amount?: string; currency?: string; cardAddress?: string }
			const hasUid = uid && typeof uid === 'string' && uid.trim().length > 0
			const hasWallet = wallet && typeof wallet === 'string' && ethers.isAddress(wallet.trim())
			if (!hasUid && !hasWallet) {
				return res.status(400).json({ success: false, error: 'Missing uid or wallet' })
			}
			if (!cardAddress || typeof cardAddress !== 'string' || !ethers.isAddress(cardAddress.trim())) {
				return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' })
			}
			const result = await nfcTopupPreparePayload({
				uid: hasUid ? uid!.trim() : undefined,
				wallet: hasWallet ? ethers.getAddress(wallet!.trim()) : undefined,
				amount: String(amount ?? ''),
				currency: (currency || 'CAD').trim(),
				cardAddress: ethers.getAddress(cardAddress.trim())
			})
			if ('error' in result) {
				return res.status(400).json({ success: false, error: result.error })
			}
			res.status(200).json(result).end()
		})

		/** POST /api/executeForAdmin - cardAddAdminByAdmin 等：Cluster 预检后转发，Master 推入 executeForAdminPool */
		router.post('/executeForAdmin', async (req, res) => {
			const { cardAddress, cardAddr, data, deadline, nonce, adminSignature } = req.body as {
				cardAddress?: string
				cardAddr?: string
				data?: string
				deadline?: number
				nonce?: string
				adminSignature?: string
			}
			const addr = cardAddr ?? cardAddress
			if (!addr || !ethers.isAddress(addr) || !data || typeof data !== 'string' || data.length === 0) {
				return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress/cardAddr/data' })
			}
			if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string' || !adminSignature || typeof adminSignature !== 'string') {
				return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce/adminSignature' })
			}
			executeForAdminPool.push({
				cardAddr: ethers.getAddress(addr),
				data,
				deadline,
				nonce,
				adminSignature,
				res
			})
			logger(Colors.cyan(`[executeForAdmin] pushed to pool, card=${addr}`))
			executeForAdminProcess().catch((err: any) => {
				logger(Colors.red('[executeForAdminProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** POST /api/nfcTopup - NFC 卡向 CCSA 充值：读取方 UI 用户用 profile 私钥签 ExecuteForAdmin，Master 调用 factory.executeForAdmin */
		router.post('/nfcTopup', async (req, res) => {
			const {
				cardAddr,
				data,
				deadline,
				nonce,
				adminSignature,
				uid,
				cardOwnerEOA,
				topupFeeBUnits,
				topupKind,
				cardCurrencyAmount,
				cashCurrencyAmount,
				bonusCurrencyAmount,
				currencyAmount,
				usdcTopupSessionId,
			} = req.body as {
				cardAddr?: string
				data?: string
				deadline?: number
				nonce?: string
				adminSignature?: string
				uid?: string
				cardOwnerEOA?: string
				topupFeeBUnits?: string
				topupKind?: number
				cardCurrencyAmount?: string
				cashCurrencyAmount?: string
				bonusCurrencyAmount?: string
				currencyAmount?: string
				usdcTopupSessionId?: string
			}
			/** 仅当本请求成功消费 `awaiting_beneficiary` session 时由本 handler 填入（忽略 body 里伪造的对账元数据）。 */
			let usdcPhase2OriginatingTx: string | undefined
			let usdcPhase2ChargeSid: string | undefined
			let usdcPhase2PosOp: string | undefined
			const usdcSidRaw = typeof usdcTopupSessionId === 'string' ? usdcTopupSessionId.trim().toLowerCase() : ''
			if (usdcSidRaw && masterIsValidSid(usdcSidRaw)) {
				masterPruneExpiredChargeSessions()
				const rec = masterChargeSessions.get(usdcSidRaw)
				if (!rec || rec.state !== 'awaiting_beneficiary') {
					return res
						.status(400)
						.json({ success: false, error: 'Invalid USDC top-up session (not awaiting beneficiary)' })
						.end()
				}
				const cardNorm = ethers.getAddress(String(cardAddr).trim())
				if (!rec.cardAddr || ethers.getAddress(rec.cardAddr) !== cardNorm) {
					return res.status(400).json({ success: false, error: 'USDC session card mismatch' }).end()
				}
				const parseTot = (raw: unknown): bigint => {
					const t = String(raw ?? '')
						.trim()
						.replace(/,/g, '')
					if (!t) return -1n
					try {
						return ethers.parseUnits(t, 6)
					} catch {
						return -1n
					}
				}
				const totBody = parseTot(currencyAmount)
				if (totBody < 0n) {
					return res.status(400).json({ success: false, error: 'Missing currencyAmount for USDC phase-2 topup' }).end()
				}
				const anySplit =
					(cardCurrencyAmount != null && String(cardCurrencyAmount).trim() !== '') ||
					(cashCurrencyAmount != null && String(cashCurrencyAmount).trim() !== '') ||
					(bonusCurrencyAmount != null && String(bonusCurrencyAmount).trim() !== '')
				if (anySplit) {
					const cE = parseTot(cardCurrencyAmount)
					const cashE = parseTot(cashCurrencyAmount)
					const bE = parseTot(bonusCurrencyAmount)
					const totE = parseTot(currencyAmount)
					if (cE < 0n || cashE < 0n || bE < 0n || totE < 0n) {
						return res.status(400).json({ success: false, error: 'Invalid top-up currency split amounts' }).end()
					}
					if (totE <= 0n || cE + cashE + bE !== totE) {
						return res.status(400).json({ success: false, error: 'Split amounts must sum to currencyAmount' }).end()
					}
				}
				const sessTot = parseTot(rec.total)
				if (sessTot < 0n || totBody !== sessTot) {
					return res.status(400).json({ success: false, error: 'USDC session amount mismatch' }).end()
				}
				const curRec = (rec.currency ?? '').trim().toUpperCase()
				if (curRec) {
					let chainCur = ''
					try {
						const c = new ethers.Contract(
							cardNorm,
							['function currency() view returns (string)'],
							providerBaseForLatestCards
						)
						chainCur = String(await c.currency()).trim().toUpperCase()
					} catch {
						chainCur = ''
					}
					if (chainCur && chainCur !== curRec) {
						return res.status(400).json({ success: false, error: 'USDC session currency mismatch' }).end()
					}
				}
				const usdcTx = rec.USDC_tx && /^0x[0-9a-fA-F]{64}$/.test(rec.USDC_tx) ? rec.USDC_tx.toLowerCase() : ''
				if (!usdcTx) {
					return res.status(400).json({ success: false, error: 'USDC session missing settle tx' }).end()
				}
				usdcPhase2OriginatingTx = usdcTx
				usdcPhase2ChargeSid = usdcSidRaw
				if (rec.pos && ethers.isAddress(rec.pos)) usdcPhase2PosOp = ethers.getAddress(rec.pos)
				const now = Date.now()
				masterChargeSessions.set(usdcSidRaw, {
					...rec,
					state: 'topup_pending',
					error: null,
					updatedAt: now,
				})
			}
			if (!cardAddr || !ethers.isAddress(cardAddr) || !data || typeof data !== 'string' || data.length === 0) {
				return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr/data' })
			}
			if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string' || !adminSignature || typeof adminSignature !== 'string') {
				return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce/adminSignature' })
			}
			const mintLinkBlock = await nfcLinkAppPaymentBlockedForMintCalldata(data)
			if (mintLinkBlock) {
				return res.status(403).json({ success: false, error: mintLinkBlock }).end()
			}
			const parseTopupAmtE6 = (raw: unknown): bigint => {
				const t = String(raw ?? '')
					.trim()
					.replace(/,/g, '')
				if (!t) return 0n
				try {
					return ethers.parseUnits(t, 6)
				} catch {
					return -1n
				}
			}
			const cE = parseTopupAmtE6(cardCurrencyAmount)
			const cashE = parseTopupAmtE6(cashCurrencyAmount)
			const bE = parseTopupAmtE6(bonusCurrencyAmount)
			const totE = parseTopupAmtE6(currencyAmount)
			const anySplit =
				(cardCurrencyAmount != null && String(cardCurrencyAmount).trim() !== '') ||
				(cashCurrencyAmount != null && String(cashCurrencyAmount).trim() !== '') ||
				(bonusCurrencyAmount != null && String(bonusCurrencyAmount).trim() !== '') ||
				(currencyAmount != null && String(currencyAmount).trim() !== '')
			let topupCurrencySplit:
				| { currencyAmountE6: bigint; cardE6: bigint; cashE6: bigint; bonusE6: bigint }
				| undefined
			if (anySplit) {
				if (cE < 0n || cashE < 0n || bE < 0n || totE < 0n) {
					return res.status(400).json({ success: false, error: 'Invalid top-up currency split amounts' }).end()
				}
				if (totE <= 0n || cE + cashE + bE !== totE) {
					return res
						.status(400)
						.json({
							success: false,
							error: 'cardCurrencyAmount + cashCurrencyAmount + bonusCurrencyAmount must equal currencyAmount (6dp)',
						})
						.end()
				}
				topupCurrencySplit = { currencyAmountE6: totE, cardE6: cE, cashE6: cashE, bonusE6: bE }
			}
			executeForAdminPool.push({
				cardAddr: ethers.getAddress(cardAddr),
				data,
				deadline,
				nonce,
				adminSignature,
				uid: typeof uid === 'string' ? uid : undefined,
				cardOwnerEOA: cardOwnerEOA && ethers.isAddress(cardOwnerEOA) ? ethers.getAddress(cardOwnerEOA) : undefined,
				topupFeeBUnits: topupFeeBUnits ? BigInt(topupFeeBUnits) : undefined,
				topupKind: topupKind === 2 || topupKind === 3 ? topupKind : 2,
				res,
				topupCurrencySplit,
				...(usdcPhase2ChargeSid && usdcPhase2OriginatingTx
					? {
							originatingUSDCTx: usdcPhase2OriginatingTx,
							chargeSessionId: usdcPhase2ChargeSid,
							...(usdcPhase2PosOp ? { posOperator: usdcPhase2PosOp } : {}),
						}
					: {}),
			})
			logger(Colors.green(`[nfcTopup] cardAddr=${cardAddr} uid=${uid ?? '(not provided)'} pushed to executeForAdminPool`))
			executeForAdminProcess().catch((err: any) => {
				logger(Colors.red('[executeForAdminProcess] nfcTopup error:'), err?.message ?? err)
			})
		})

		/** POST /api/nfcUsdcTopup —— x402 NFC USDC Topup Master 端
		 * Cluster 已完成：
		 *   - SUN 校验 + recipientEOA 解析
		 *   - card.owner() == cardOwner 一致性
		 *   - nfcTopupPreparePayload(data/deadline/nonce, mintPointsByAdmin → recipientEOA)
		 *   - x402 verify + settle USDC（transferWithAuthorization → cardOwner）
		 * Master 在此处：
		 *   - 用 service-admin（masterSetup.settle_contractAdmin[0]）EIP-712 签 ExecuteForAdmin
		 *   - push executeForAdminPool 复用既有 NFC topup 工作流（executeForAdminProcess + post-base-process 记账） */
		router.post('/nfcUsdcTopup', async (req, res) => {
			const {
				cardAddr,
				data,
				deadline,
				nonce,
				recipientEOA,
				cardOwner,
				currency,
				currencyAmount,
				payer,
				USDC_tx,
				usdcAmount6,
				nfcUid,
				topupFeeBUnits,
				originatingUSDCTx,
				chargeSessionId,
				posOperator,
				topupSourceOverride,
				preSignedAdminSignature,
				preSignedAdminSigner,
			} = req.body as {
				cardAddr?: string
				data?: string
				deadline?: number
				nonce?: string
				recipientEOA?: string
				cardOwner?: string
				currency?: string
				currencyAmount?: string
				payer?: string
				USDC_tx?: string
				usdcAmount6?: string
				nfcUid?: string
				nfcTagIdHex?: string
				/** PR #4 (USDC charge orchestrator)：传入 issuer 须扣的 topup B-Unit 服务费（与 NFC topup 一致 2%）。
				 *  历史 x402 nfcUsdcTopup 不传此字段 ⇒ 不扣费（与旧行为兼容）。 */
				topupFeeBUnits?: string
				/** PR #4：原始 x402 USDC settle 的 base tx，便于 insertMemberTopupEvent 对账 */
				originatingUSDCTx?: string
				/** PR #4：POS 端轮询 sid（UUID v4），便于「USDC settle → topup → charge」三段对账 */
				chargeSessionId?: string
				/** PR #4：POS 终端钱包地址，作为 operator 进入 admin 记账 */
				posOperator?: string
				/** PR #4：渠道标签覆盖（缺省 'webPosNfcTopup'）。orchestrator 临时钱包 topup 用 'webPosNfcTopup' 走默认即可 */
				topupSourceOverride?: 'usdcPurchasingCard' | 'androidNfcTopup' | 'webPosNfcTopup'
				/** PR #4 v2 (POS-signed admin path)：编排器从 cluster 拿到 POS 终端用 admin EOA 私钥离线签的
				 *  ExecuteForAdmin 65-byte sig。提供时跳过本地 service-admin 签（service admin 不一定是该商户卡的 admin）。
				 *  cluster 已 verify recover==session.pos 且 isAdmin(pos)==true，Master 只做语义校验后直接 push pool。 */
				preSignedAdminSignature?: string
				/** PR #4 v2：与 `preSignedAdminSignature` 配对，用于日志/审计；Master 不依赖此字段做权限判定（链上 recover 才是权威）。 */
				preSignedAdminSigner?: string
			}
			try {
				if (!cardAddr || !ethers.isAddress(cardAddr) || !data || typeof data !== 'string' || data.length === 0) {
					return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr/data' }).end()
				}
				if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string') {
					return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce' }).end()
				}
				if (!recipientEOA || !ethers.isAddress(recipientEOA)) {
					return res.status(400).json({ success: false, error: 'Missing or invalid recipientEOA' }).end()
				}
				if (!cardOwner || !ethers.isAddress(cardOwner)) {
					return res.status(400).json({ success: false, error: 'Missing or invalid cardOwner' }).end()
				}

				const cardAddrNorm = ethers.getAddress(cardAddr)
				const cardOwnerNorm = ethers.getAddress(cardOwner)
				const recipientNorm = ethers.getAddress(recipientEOA)

				/** PR #4 v2：preSignedAdminSignature 优先 —— 由 POS 终端用 admin EOA 离线签 ExecuteForAdmin。
				 *  cluster 端在 `/api/nfcUsdcChargeTopupAuth` 已做 EIP-712 recover==session.pos + isAdmin 双重校验，
				 *  Master 这里仅做格式校验后透传。无 preSigned 时回落到 service-admin 签（兼容 NFC USDC topup 历史路径）。 */
				let adminSignatureForPool: string
				let adminSignerForLog: string
				if (typeof preSignedAdminSignature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(preSignedAdminSignature.trim())) {
					adminSignatureForPool = preSignedAdminSignature.trim()
					if (!preSignedAdminSigner || !ethers.isAddress(preSignedAdminSigner)) {
						return res.status(400).json({ success: false, error: 'preSignedAdminSignature provided without valid preSignedAdminSigner' }).end()
					}
					adminSignerForLog = ethers.getAddress(preSignedAdminSigner)
				} else {
					/** Master 用 service admin key 签 ExecuteForAdmin。要求 settle_contractAdmin[0] 已被 cardOwner 添加为该卡 admin。 */
					const signed = await signExecuteForAdminWithServiceAdmin({ cardAddr: cardAddrNorm, data, deadline, nonce })
					if ('error' in signed) {
						logger(Colors.red(`[nfcUsdcTopup] service admin sign FAIL: ${signed.error}`))
						return res.status(500).json({ success: false, error: `Service admin sign failed: ${signed.error}` }).end()
					}
					adminSignatureForPool = signed.adminSignature
					adminSignerForLog = signed.signer
				}

				/** USDC 已 settle 至 cardOwner（USDC_tx），此处提供 currencyAmount 让 NFC topup post-base 链路按 currency 拆分。
				 *  当前不做拆分，等同 legacy `topupCard`/`newCard`/`upgradeNewCard` 单笔行为。 */
				const totE = (() => {
					const t = String(currencyAmount ?? '').trim().replace(/,/g, '')
					if (!t) return 0n
					try { return ethers.parseUnits(t, 6) } catch { return 0n }
				})()
				const topupCurrencySplit = totE > 0n
					? { currencyAmountE6: totE, cardE6: totE, cashE6: 0n, bonusE6: 0n }
					: undefined

				const feeBUnitsParsed: bigint | undefined = (() => {
					if (topupFeeBUnits == null) return undefined
					const s = String(topupFeeBUnits).trim()
					if (!s || !/^\d+$/.test(s)) return undefined
					try { return BigInt(s) } catch { return undefined }
				})()
				const originatingUsdcTxNorm =
					typeof originatingUSDCTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(originatingUSDCTx.trim())
						? originatingUSDCTx.trim().toLowerCase()
						: undefined
				const sidNorm =
					typeof chargeSessionId === 'string' && chargeSessionId.trim().length > 0
						? chargeSessionId.trim().toLowerCase()
						: undefined
				const posOperatorNorm =
					typeof posOperator === 'string' && ethers.isAddress(posOperator.trim())
						? ethers.getAddress(posOperator.trim())
						: undefined
				const sourceOverrideNorm: 'usdcPurchasingCard' | 'androidNfcTopup' | 'webPosNfcTopup' =
					topupSourceOverride === 'usdcPurchasingCard' || topupSourceOverride === 'androidNfcTopup'
						? topupSourceOverride
						: 'webPosNfcTopup'

				executeForAdminPool.push({
					cardAddr: cardAddrNorm,
					data,
					deadline,
					nonce,
					adminSignature: adminSignatureForPool,
					uid: typeof nfcUid === 'string' ? nfcUid : undefined,
					cardOwnerEOA: cardOwnerNorm,
					topupFeeBUnits: feeBUnitsParsed,
					topupKind: 2,
					res,
					topupCurrencySplit,
					topupSourceOverride: sourceOverrideNorm,
					originatingUSDCTx: originatingUsdcTxNorm,
					chargeSessionId: sidNorm,
					posOperator: posOperatorNorm,
				})

				logger(Colors.green(
					`[nfcUsdcTopup] queued ExecuteForAdmin card=${cardAddrNorm} recipient=${recipientNorm} cardOwner=${cardOwnerNorm} ` +
					`USDC_tx=${USDC_tx ?? 'n/a'} payer=${payer ?? 'n/a'} usdc6=${usdcAmount6 ?? 'n/a'} ` +
					`currency=${currency ?? 'n/a'} amount=${currencyAmount ?? 'n/a'} ` +
					`feeBUnits=${feeBUnitsParsed?.toString() ?? 'n/a'} sid=${sidNorm ?? 'n/a'} ` +
					`pos=${posOperatorNorm ? posOperatorNorm.slice(0, 10) + '…' : 'n/a'} ` +
					`signer=${adminSignerForLog} signSource=${preSignedAdminSignature ? 'pos-presigned' : 'service-admin'}`
				))
				executeForAdminProcess().catch((err: any) => {
					logger(Colors.red('[executeForAdminProcess] nfcUsdcTopup error:'), err?.message ?? err)
				})
			} catch (err: any) {
				logger(Colors.red(`[nfcUsdcTopup] master error: ${err?.message ?? err}`))
				if (!res.headersSent) {
					res.status(500).json({ success: false, error: err?.message ?? String(err) }).end()
				}
			}
		})

		/** PR #4 v3 (cross-worker session store) —— 见文件顶部 `MasterChargeSession` block 注释。
		 *  POST /api/chargeSessionUpsert  body: { sid, patch }
		 *  - sid：UUID v4（非法 ⇒ 400）
		 *  - patch：可选字段子集；缺省字段不动；patch.state 必须是合法 state 字符串（非法 ⇒ 400）
		 *  - 不存在 ⇒ 用 makeFresh 创建后再 merge
		 *  - 200 即代表已落地；fire-and-forget 调用方不必读 body
		 *
		 *  这里用宽松的 record 透传 patch（不强 schema），因为 patch 字段经常一起增减；
		 *  cluster `sessionUpdate` 自己保证只送合法字段，Master 这层只做基本 sanity。 */
		router.post('/chargeSessionUpsert', (req, res) => {
			try {
				const { sid, patch } = (req.body ?? {}) as { sid?: string; patch?: Record<string, unknown> }
				const sidNorm = typeof sid === 'string' ? sid.trim().toLowerCase() : ''
				if (!masterIsValidSid(sidNorm)) {
					return res.status(400).json({ ok: false, error: 'Invalid sid (expect UUID v4)' }).end()
				}
				if (!patch || typeof patch !== 'object') {
					return res.status(400).json({ ok: false, error: 'Missing patch object' }).end()
				}
				masterPruneExpiredChargeSessions()
				const now = Date.now()
				const prev = masterChargeSessions.get(sidNorm) ?? masterMakeFreshChargeSession(sidNorm, now)
				const merged = { ...prev, ...patch, sid: sidNorm, updatedAt: now } as MasterChargeSession
				// state 校验：只接受合法字符串；其他字段一律透传
				if (
					patch.state !== undefined &&
					typeof patch.state === 'string' &&
					!['awaiting_payment','verifying','settling','topup_pending','awaiting_topup_auth','awaiting_beneficiary','topup_confirmed','charge_pending','success','error'].includes(patch.state as string)
				) {
					return res.status(400).json({ ok: false, error: `Invalid state: ${patch.state}` }).end()
				}
				masterChargeSessions.set(sidNorm, merged)
				return res.status(200).json({ ok: true, sid: sidNorm, state: merged.state }).end()
			} catch (err: any) {
				logger(Colors.red(`[chargeSessionUpsert] ${err?.message ?? err}`))
				if (!res.headersSent) {
					res.status(500).json({ ok: false, error: err?.message ?? String(err) }).end()
				}
			}
		})

		/** GET /api/chargeSessionGet?sid=...  —— cluster GET /api/nfcUsdcChargeSession 透传到这里。
		 *  - sid 不存在 ⇒ `state: 'awaiting_payment'` shell（与之前 cluster 行为一致，POS 不要把它当 error）。
		 *  - sid 存在 ⇒ 返回完整 record（含 USDC_tx / payer / breakdown / orchestrator 中间态）。 */
		router.get('/chargeSessionGet', (req, res) => {
			try {
				const sidQ = (req.query?.sid ?? '').toString().trim().toLowerCase()
				if (!masterIsValidSid(sidQ)) {
					return res.status(400).json({ ok: false, error: 'Invalid sid (expect UUID v4)' }).end()
				}
				masterPruneExpiredChargeSessions()
				const rec = masterChargeSessions.get(sidQ)
				if (!rec) {
					return res.status(200).json({ ok: true, state: 'awaiting_payment', sid: sidQ }).end()
				}
				return res.status(200).json({ ok: true, ...rec }).end()
			} catch (err: any) {
				logger(Colors.red(`[chargeSessionGet] ${err?.message ?? err}`))
				if (!res.headersSent) {
					res.status(500).json({ ok: false, error: err?.message ?? String(err) }).end()
				}
			}
		})

		/** POST /api/chargeSessionConsumePosSig  body: { sid }
		 *  orchestrator 的 awaitTopupSignature 闭包通过此端点轮询 + 原子消耗 POS 签名。
		 *  - 签名未到 ⇒ `{ ok: false, error: 'no signature yet' }`，调用方下一轮再来
		 *  - 签名已到 ⇒ 返回 signature + signer，并清掉 posTopupSignature + 全部 pendingTopup* 字段（一次性消耗，避免重放） */
		router.post('/chargeSessionConsumePosSig', (req, res) => {
			try {
				const { sid } = (req.body ?? {}) as { sid?: string }
				const sidNorm = typeof sid === 'string' ? sid.trim().toLowerCase() : ''
				if (!masterIsValidSid(sidNorm)) {
					return res.status(400).json({ ok: false, error: 'Invalid sid (expect UUID v4)' }).end()
				}
				const rec = masterChargeSessions.get(sidNorm)
				if (!rec) return res.status(200).json({ ok: false, error: 'session not found' }).end()
				if (rec.state === 'error') return res.status(200).json({ ok: false, error: rec.error || 'session in error' }).end()
				const sig = rec.posTopupSignature
				if (!sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
					return res.status(200).json({ ok: false, error: 'no signature yet' }).end()
				}
				const signer = rec.pos ?? ''
				const now = Date.now()
				masterChargeSessions.set(sidNorm, {
					...rec,
					posTopupSignature: null,
					pendingTopupCardAddr: null,
					pendingTopupRecipientEOA: null,
					pendingTopupData: null,
					pendingTopupDeadline: null,
					pendingTopupNonce: null,
					pendingTopupPoints6: null,
					pendingTopupBUnitFee: null,
					updatedAt: now,
				})
				return res.status(200).json({ ok: true, signature: sig, signer }).end()
			} catch (err: any) {
				logger(Colors.red(`[chargeSessionConsumePosSig] ${err?.message ?? err}`))
				if (!res.headersSent) {
					res.status(500).json({ ok: false, error: err?.message ?? String(err) }).end()
				}
			}
		})

		/** POST /api/nfcUsdcChargeTopupAuth  body: { sid, signature }
		 *  POS 端把 admin EOA 离线签的 ExecuteForAdmin 65-byte sig 回灌（cluster 把 POS 的请求 proxy 到这里）。
		 *  Master 用 session.pendingTopup* 字段重算 EIP-712 digest，recover 必须 == session.pos。
		 *  通过则写 posTopupSignature，编排器的 consumePosSig 闭环立即获取。 */
		router.post('/nfcUsdcChargeTopupAuth', (req, res) => {
			try {
				const { sid, signature } = (req.body ?? {}) as { sid?: string; signature?: string }
				const sidNorm = typeof sid === 'string' ? sid.trim().toLowerCase() : ''
				if (!masterIsValidSid(sidNorm)) {
					return res.status(400).json({ success: false, error: 'Invalid sid (expect UUID v4)' }).end()
				}
				const sigNorm = typeof signature === 'string' ? signature.trim() : ''
				if (!/^0x[0-9a-fA-F]{130}$/.test(sigNorm)) {
					return res.status(400).json({ success: false, error: 'Invalid signature (expect 65-byte 0x… hex)' }).end()
				}
				masterPruneExpiredChargeSessions()
				const rec = masterChargeSessions.get(sidNorm)
				if (!rec) {
					return res.status(404).json({ success: false, error: 'Session not found or expired' }).end()
				}
				if (rec.state === 'error') {
					return res.status(409).json({ success: false, error: rec.error || 'Session in error state' }).end()
				}
				if (rec.state !== 'awaiting_topup_auth') {
					if (rec.posTopupSignature == null && rec.pendingTopupData == null) {
						return res.status(200).json({ success: true, idempotent: true, state: rec.state }).end()
					}
					return res.status(409).json({ success: false, error: `Session not awaiting topup auth (state=${rec.state})` }).end()
				}
				if (
					!rec.pendingTopupCardAddr || !rec.pendingTopupData ||
					rec.pendingTopupDeadline == null || !rec.pendingTopupNonce
				) {
					return res.status(409).json({ success: false, error: 'Session has no pending topup payload' }).end()
				}
				if (!rec.pos || !ethers.isAddress(rec.pos)) {
					return res.status(409).json({ success: false, error: 'Session has no POS operator bound' }).end()
				}

				const dataBytes = ethers.getBytes(rec.pendingTopupData)
				const dataHash = ethers.keccak256(dataBytes)
				const domain = {
					name: 'BeamioUserCardFactory',
					version: '1',
					chainId: MASTER_BASE_CHAIN_ID,
					verifyingContract: BASE_CARD_FACTORY,
				}
				const types = {
					ExecuteForAdmin: [
						{ name: 'cardAddress', type: 'address' },
						{ name: 'dataHash', type: 'bytes32' },
						{ name: 'deadline', type: 'uint256' },
						{ name: 'nonce', type: 'bytes32' },
					],
				}
				const nonceHex = rec.pendingTopupNonce.startsWith('0x') ? rec.pendingTopupNonce : '0x' + rec.pendingTopupNonce
				const message = {
					cardAddress: rec.pendingTopupCardAddr,
					dataHash,
					deadline: BigInt(rec.pendingTopupDeadline),
					nonce: nonceHex,
				}
				let signer: string
				try {
					const digest = ethers.TypedDataEncoder.hash(domain, types, message)
					signer = ethers.recoverAddress(digest, sigNorm)
				} catch (err: any) {
					return res.status(400).json({ success: false, error: `EIP-712 recover failed: ${err?.shortMessage ?? err?.message ?? String(err)}` }).end()
				}
				if (!signer || !ethers.isAddress(signer)) {
					return res.status(400).json({ success: false, error: 'EIP-712 recover returned invalid address' }).end()
				}
				if (signer.toLowerCase() !== rec.pos.toLowerCase()) {
					logger(Colors.red(`[nfcUsdcChargeTopupAuth] signer mismatch sid=${sidNorm.slice(0, 8)}… expected=${rec.pos} got=${signer}`))
					return res.status(401).json({ success: false, error: 'Signature does not recover to bound POS operator', expectedPos: rec.pos, recoveredSigner: signer }).end()
				}

				const now = Date.now()
				masterChargeSessions.set(sidNorm, { ...rec, posTopupSignature: sigNorm, updatedAt: now })
				logger(Colors.green(`[nfcUsdcChargeTopupAuth] sid=${sidNorm.slice(0, 8)}… POS sig accepted signer=${signer}`))
				return res.status(200).json({ success: true, sid: sidNorm, signer }).end()
			} catch (err: any) {
				logger(Colors.red(`[nfcUsdcChargeTopupAuth] ${err?.message ?? err}`))
				if (!res.headersSent) {
					res.status(500).json({ success: false, error: err?.message ?? String(err) }).end()
				}
			}
		})

		/** POST /api/nfcUsdcCharge —— x402 NFC USDC Charge Master 端
		 * Cluster 已完成：
		 *   - SUN 校验（确认 NFC 卡确实在 POS 现场）
		 *   - card.owner() == cardOwner 一致性
		 *   - x402 verify + settle USDC（transferWithAuthorization → cardOwner）
		 * Master 在此处：
		 *   - 仅做记账日志（charge 是顾客付款给商家，不需要 mintPointsByAdmin / ExecuteForAdmin）
		 *   - 与 NFC charge 字段同步（subtotal/discount/tax/tip/currency），便于商家端报表对齐
		 * 未来若需要为 NFC 卡持有人发 loyalty points（earn-on-charge），可在此基于 nfcTopupPreparePayload + signExecuteForAdminWithServiceAdmin 扩展。
		 */
		router.post('/nfcUsdcCharge', async (req, res) => {
			const {
				cardAddr,
				cardOwner,
				nfcUid,
				nfcTagIdHex,
				nfcRecipientEOA,
				currency,
				subtotalCurrencyAmount,
				discountAmountFiat6,
				discountRateBps,
				taxAmountFiat6,
				taxRateBps,
				tipCurrencyAmount,
				tipRateBps,
				totalCurrencyAmount,
				usdcAmount6,
				USDC_tx,
				payer,
			} = req.body as {
				cardAddr?: string
				cardOwner?: string
				nfcUid?: string
				nfcTagIdHex?: string
				nfcRecipientEOA?: string
				currency?: string
				subtotalCurrencyAmount?: string
				discountAmountFiat6?: string
				discountRateBps?: number
				taxAmountFiat6?: string
				taxRateBps?: number
				tipCurrencyAmount?: string
				tipRateBps?: number
				totalCurrencyAmount?: string
				usdcAmount6?: string
				USDC_tx?: string
				payer?: string
			}
			try {
				if (!cardAddr || !ethers.isAddress(cardAddr)) {
					return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr' }).end()
				}
				if (!cardOwner || !ethers.isAddress(cardOwner)) {
					return res.status(400).json({ success: false, error: 'Missing or invalid cardOwner' }).end()
				}
				const cardAddrNorm = ethers.getAddress(cardAddr)
				const cardOwnerNorm = ethers.getAddress(cardOwner)
				const cur = String(currency ?? 'CAD').toUpperCase()
				logger(Colors.green(
					`[nfcUsdcCharge] OK card=${cardAddrNorm} cardOwner=${cardOwnerNorm} ` +
					`USDC_tx=${USDC_tx ?? 'n/a'} payer=${payer ?? 'n/a'} usdc6=${usdcAmount6 ?? 'n/a'} ` +
					`currency=${cur} subtotal=${subtotalCurrencyAmount ?? '0'} discountE6=${discountAmountFiat6 ?? '0'}` +
					`(${discountRateBps ?? 0}bps) taxE6=${taxAmountFiat6 ?? '0'}(${taxRateBps ?? 0}bps) ` +
					`tip=${tipCurrencyAmount ?? '0'}(${tipRateBps ?? 0}bps) total=${totalCurrencyAmount ?? '0'} ` +
					`nfcUid=${nfcUid ?? 'n/a'} nfcTagId=${nfcTagIdHex ? nfcTagIdHex.slice(0, 8) + '…' : 'n/a'} ` +
					`nfcRecipient=${nfcRecipientEOA ?? 'n/a'}`
				))
				return res.status(200).json({
					success: true,
					cardAddress: cardAddrNorm,
					cardOwner: cardOwnerNorm,
					currency: cur,
					totalCurrencyAmount: totalCurrencyAmount ?? null,
					usdcAmount6: usdcAmount6 ?? null,
					USDC_tx: USDC_tx ?? null,
					payer: payer ?? null,
					nfcUid: nfcUid ?? null,
				}).end()
			} catch (err: any) {
				logger(Colors.red(`[nfcUsdcCharge] master error: ${err?.message ?? err}`))
				if (!res.headersSent) {
					res.status(500).json({ success: false, error: err?.message ?? String(err) }).end()
				}
			}
		})

		/** POST /api/usdcChargeRawSig —— WC v2 / 任意第三方钱包 raw EIP-3009 sig USDC@Base 直发
		 *
		 * 与 `/api/nfcUsdcCharge`（x402 路径）的关键区别：
		 *   - 调用方（POS）已经从顾客钱包拿到完整 transferWithAuthorization (from,to,value,validAfter,validBefore,nonce,signature)；
		 *     Master 这里**不走 x402 facilitator**、**不调 settle()**，直接用 service-admin EOA 在 Base 上提交 USDC 合约的
		 *     `transferWithAuthorization(...)`。USDC 合约自己会做 EIP-712 校验 + nonce 防重放，所以即便我们自己也复算一次
		 *     ECDSA 仅作为 fast-fail（避免烧白 gas）。
		 *   - **不触发 orchestrator 双腿 topup→charge / mintPointsByAdmin** —— 第三方钱包顾客没有 BeamioTag 卡，没有 loyalty
		 *     points 受益人；硬塞 `_requirePointsMintAllowsFirstMembership` 会撞 first-membership tier 阈值（< $10 Base tier 必 revert）。
		 *     这里 settle 完成即视为终态：商户卡 owner EOA 直接收 USDC，记账落库，session → success。
		 *
		 * Cluster 端 `POST /api/nfcUsdcChargeRawSig` 已完成：sid 合法性、card.owner() / currency() / isAdmin(pos) 链上权威读、
		 * breakdown 归一化、Oracle USDC 报价（usdcAmount6 = expected min）。Master 这里仅做：sig 复算 → 链上提交 → 记账 → 200。
		 */
		router.post('/usdcChargeRawSig', async (req, res) => {
			const {
				cardAddress,
				cardOwner,
				pos,
				sid,
				currency,
				totalCurrencyAmount,
				subtotalCurrencyAmount,
				discountAmountFiat6,
				discountRateBps,
				taxAmountFiat6,
				taxRateBps,
				tipCurrencyAmount,
				tipRateBps,
				usdcAmount6,
				payer,
				validAfter,
				validBefore,
				nonce,
				signature,
			} = (req.body ?? {}) as {
				cardAddress?: string
				cardOwner?: string
				pos?: string
				sid?: string
				currency?: string
				totalCurrencyAmount?: string
				subtotalCurrencyAmount?: string
				discountAmountFiat6?: string
				discountRateBps?: number
				taxAmountFiat6?: string
				taxRateBps?: number
				tipCurrencyAmount?: string
				tipRateBps?: number
				usdcAmount6?: string
				payer?: string
				validAfter?: string | number
				validBefore?: string | number
				nonce?: string
				signature?: string
			}
			try {
				if (!cardAddress || !ethers.isAddress(cardAddress)) {
					return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' }).end()
				}
				if (!cardOwner || !ethers.isAddress(cardOwner)) {
					return res.status(400).json({ success: false, error: 'Missing or invalid cardOwner' }).end()
				}
				if (!payer || !ethers.isAddress(payer)) {
					return res.status(400).json({ success: false, error: 'Missing or invalid payer (EIP-3009 from)' }).end()
				}
				if (!usdcAmount6 || !/^\d+$/.test(usdcAmount6) || BigInt(usdcAmount6) <= 0n) {
					return res.status(400).json({ success: false, error: 'Missing or invalid usdcAmount6 (expect positive uint256 decimal string)' }).end()
				}
				if (!nonce || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
					return res.status(400).json({ success: false, error: 'Invalid nonce (expect 0x-prefixed 32-byte hex)' }).end()
				}
				if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
					return res.status(400).json({ success: false, error: 'Invalid signature (expect 0x-prefixed 65-byte hex)' }).end()
				}
				const validAfterBig = BigInt(validAfter ?? '0')
				const validBeforeBig = BigInt(validBefore ?? '0')
				const nowSec = BigInt(Math.floor(Date.now() / 1000))
				const TIME_TOLERANCE = 300n
				if (validBeforeBig <= nowSec) {
					return res.status(400).json({ success: false, error: `Authorization expired (validBefore=${validBeforeBig} <= now=${nowSec})` }).end()
				}
				if (validAfterBig > nowSec + TIME_TOLERANCE) {
					return res.status(400).json({ success: false, error: `Authorization not yet valid (validAfter=${validAfterBig} > now=${nowSec})` }).end()
				}

				const cardAddressNorm = ethers.getAddress(cardAddress)
				const cardOwnerNorm = ethers.getAddress(cardOwner)
				const payerNorm = ethers.getAddress(payer)
				const valueBig = BigInt(usdcAmount6)
				const cur = String(currency ?? 'CAD').toUpperCase()
				const sidNorm = typeof sid === 'string' && sid.trim().length > 0 ? sid.trim() : null
				const posNorm = typeof pos === 'string' && ethers.isAddress(pos) ? ethers.getAddress(pos) : null

				// fast-fail：本地 ECDSA 复算 EIP-712 TransferWithAuthorization；与 USDC 合约同 domain/types。
				// 复算失败 ⇒ 不烧 gas、直接 400；复算通过 ⇒ 链上 USDC 合约会再校验一次（nonce 防重放只能在链上做）。
				const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
				const USDC_EIP712_DOMAIN = {
					name: 'USD Coin',
					version: '2',
					chainId: MASTER_BASE_CHAIN_ID,
					verifyingContract: USDC_BASE,
				}
				const TRANSFER_WITH_AUTH_TYPES: Record<string, ethers.TypedDataField[]> = {
					TransferWithAuthorization: [
						{ name: 'from', type: 'address' },
						{ name: 'to', type: 'address' },
						{ name: 'value', type: 'uint256' },
						{ name: 'validAfter', type: 'uint256' },
						{ name: 'validBefore', type: 'uint256' },
						{ name: 'nonce', type: 'bytes32' },
					],
				}
				const message = {
					from: payerNorm,
					to: cardOwnerNorm,
					value: valueBig,
					validAfter: validAfterBig,
					validBefore: validBeforeBig,
					nonce: nonce as `0x${string}`,
				}
				let recovered: string
				try {
					recovered = ethers.verifyTypedData(USDC_EIP712_DOMAIN, TRANSFER_WITH_AUTH_TYPES, message, signature)
				} catch (sigErr: any) {
					logger(Colors.yellow(`[usdcChargeRawSig] sig recover threw: ${sigErr?.message ?? sigErr}`))
					return res.status(400).json({ success: false, error: 'Signature recovery failed (malformed sig)' }).end()
				}
				if (ethers.getAddress(recovered) !== payerNorm) {
					logger(Colors.yellow(
						`[usdcChargeRawSig] sig signer ${recovered} != payer ${payerNorm} (card=${cardAddressNorm.slice(0, 10)}…)`
					))
					return res.status(400).json({ success: false, error: `EIP-3009 signer mismatch (recovered=${recovered}, payer=${payerNorm})` }).end()
				}

				const pk = (masterSetup as { settle_contractAdmin?: string[] }).settle_contractAdmin?.[0]
				if (!pk) {
					return res.status(500).json({ success: false, error: 'Service admin Base signer not configured (masterSetup.settle_contractAdmin[0])' }).end()
				}
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const wallet = new ethers.Wallet(pk, provider)
				const usdcAbi = [
					'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
				]
				const usdc = new ethers.Contract(USDC_BASE, usdcAbi, wallet)

				let txHash: string | null = null
				let blockNumber: number | null = null
				try {
					const tx = await usdc.transferWithAuthorization(
						payerNorm,
						cardOwnerNorm,
						valueBig,
						validAfterBig,
						validBeforeBig,
						nonce,
						signature
					)
					txHash = tx.hash
					logger(Colors.cyan(
						`[usdcChargeRawSig] submit tx=${txHash} card=${cardAddressNorm.slice(0, 10)}… payer=${payerNorm.slice(0, 10)}… ` +
						`cardOwner=${cardOwnerNorm.slice(0, 10)}… value6=${valueBig.toString()} sid=${sidNorm ?? 'n/a'}`
					))
					const rcpt = await tx.wait(1)
					blockNumber = rcpt?.blockNumber ?? null
					if (!rcpt || rcpt.status !== 1) {
						logger(Colors.red(`[usdcChargeRawSig] tx reverted on-chain status=${rcpt?.status} hash=${txHash}`))
						return res.status(502).json({ success: false, error: `USDC transferWithAuthorization reverted on-chain (tx=${txHash})`, USDC_tx: txHash }).end()
					}
				} catch (txErr: any) {
					const msg = txErr?.shortMessage ?? txErr?.message ?? String(txErr)
					logger(Colors.red(`[usdcChargeRawSig] submit tx failed: ${msg}`))
					return res.status(502).json({ success: false, error: `USDC transferWithAuthorization failed: ${msg}` }).end()
				}

				logger(Colors.green(
					`[usdcChargeRawSig] OK card=${cardAddressNorm} cardOwner=${cardOwnerNorm} pos=${posNorm ? posNorm.slice(0, 10) + '…' : '(none)'} ` +
					`USDC_tx=${txHash} payer=${payerNorm} usdc6=${valueBig.toString()} block=${blockNumber} ` +
					`currency=${cur} subtotal=${subtotalCurrencyAmount ?? '0'} discountE6=${discountAmountFiat6 ?? '0'}` +
					`(${discountRateBps ?? 0}bps) taxE6=${taxAmountFiat6 ?? '0'}(${taxRateBps ?? 0}bps) ` +
					`tip=${tipCurrencyAmount ?? '0'}(${tipRateBps ?? 0}bps) total=${totalCurrencyAmount ?? '0'} ` +
					`sid=${sidNorm ?? 'n/a'} mode=raw-sig (no orchestrator)`
				))

				// PR (USDC settle 独立记账)：raw-sig 路径不走 orchestrator（无 L1 topup / L2 charge 行），
				// 唯一的 ledger 行就是这条 USDC settle 行。fire-and-forget enqueue（同 cluster /api/nfcUsdcCharge 路径）。
				// helper 内部走 localhost POST `/api/beamioTransferIndexerAccounting` —— 即便我们已在 Master 进程内，
				// 也保持同一条 enqueue 路径（含 currency/from-to 预检）以避免重复实现校验逻辑。
				if (txHash) {
					void submitUsdcChargeSettleIndexer({
						payer: payerNorm,
						cardOwner: cardOwnerNorm,
						cardAddress: cardAddressNorm,
						posOperator: posNorm,
						sid: sidNorm,
						currency: cur,
						subtotalCurrencyAmount: typeof subtotalCurrencyAmount === 'string' && subtotalCurrencyAmount.trim()
							? subtotalCurrencyAmount
							: (totalCurrencyAmount ?? '0'),
						totalCurrencyAmount: typeof totalCurrencyAmount === 'string' && totalCurrencyAmount.trim()
							? totalCurrencyAmount
							: ethers.formatUnits(valueBig, 6),
						discountAmountFiat6: typeof discountAmountFiat6 === 'string' ? discountAmountFiat6 : '0',
						discountRateBps: Number(discountRateBps ?? 0),
						taxAmountFiat6: typeof taxAmountFiat6 === 'string' ? taxAmountFiat6 : '0',
						taxRateBps: Number(taxRateBps ?? 0),
						tipCurrencyAmount: typeof tipCurrencyAmount === 'string' ? tipCurrencyAmount : '0',
						tipRateBps: Number(tipRateBps ?? 0),
						usdcTxHash: txHash,
						usdcAmount6: valueBig,
					}).catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err)
						logger(Colors.yellow(`[usdcChargeRawSig] USDC settle indexer enqueue failed (non-critical): ${msg}`))
					})
				}

				return res.status(200).json({
					success: true,
					cardAddress: cardAddressNorm,
					cardOwner: cardOwnerNorm,
					pos: posNorm,
					currency: cur,
					totalCurrencyAmount: totalCurrencyAmount ?? null,
					usdcAmount6: valueBig.toString(),
					USDC_tx: txHash,
					blockNumber,
					payer: payerNorm,
					sid: sidNorm,
				}).end()
			} catch (err: any) {
				logger(Colors.red(`[usdcChargeRawSig] master error: ${err?.message ?? err}`))
				if (!res.headersSent) {
					res.status(500).json({ success: false, error: err?.message ?? String(err) }).end()
				}
			}
		})

		/**
		 * Merchant kit Stripe — Master 单进程持有会话 map（Cluster 预检后 postLocalhost 至此处）。
		 * body: `{ walletAddress, packageType }`
		 */
		router.post('/merchantKitStripe/createSession', async (req, res) => {
			const { walletAddress, packageType } = req.body ?? {}
			if (!walletAddress || typeof packageType !== 'string') {
				return res.status(400).json({ error: 'walletAddress and packageType required' }).end()
			}
			if (!ethers.isAddress(walletAddress)) {
				return res.status(400).json({ error: 'Invalid walletAddress' }).end()
			}
			const out = await createMerchantKitCheckoutSession(walletAddress, packageType)
			if ('error' in out) {
				logger(Colors.red('[merchantKitStripe] createSession HTTP 400 (master)'), walletAddress, out.error)
				return res.status(400).json({ error: out.error }).end()
			}
			return res.status(200).json({ url: out.url, sessionId: out.sessionId }).end()
		})

		router.post('/merchantKitStripe/poll', async (req, res) => {
			const { sessionId, userClosedCheckout } = req.body ?? {}
			if (!sessionId || typeof sessionId !== 'string') {
				return res.status(400).json({ error: 'sessionId required' }).end()
			}
			const closed = Boolean(userClosedCheckout)
			await refreshMerchantKitSessionFromStripe(sessionId, {
				treatOpenUnpaidAsAbandoned: closed,
			})
			const st = getMerchantKitSessionStatus(sessionId)
			if (!st) {
				logger(Colors.yellow('[merchantKitStripe] poll 404 unknown session (master)'), sessionId)
				return res.status(404).json({ error: 'Unknown session' }).end()
			}
			const pollVerbose =
				closed ||
				process.env.MERCHANT_KIT_STRIPE_DEBUG === '1' ||
				process.env.MERCHANT_KIT_STRIPE_DEBUG === 'true'
			if (pollVerbose) {
				logger(
					Colors.cyan('[merchantKitStripe] poll → (master)'),
					inspect(
						{
							sessionId,
							userClosedCheckout: closed,
							status: st.status,
							packageType: st.packageType,
							lastEvent: st.lastEvent,
						},
						false,
						2,
						true
					)
				)
			}
			return res.status(200).json({
				status: st.status,
				packageType: st.packageType,
				eoaAddress: st.eoaAddress,
				lastEvent: st.lastEvent,
				chainFulfillment: st.chainFulfillment ?? null,
			}).end()
		})

}

const initialize = async (reactBuildFolder: string, PORT: number) => {
	console.log('🔧 Initialize called with PORT:', PORT, 'reactBuildFolder:', reactBuildFolder)
	oracleBackoud()

	const defaultPath = join(__dirname, 'workers')
	console.log('📁 defaultPath:', defaultPath)

	const userDataPath = reactBuildFolder
	const updatedPath = join(userDataPath, 'workers')
	console.log('📁 updatedPath:', updatedPath)

	let staticFolder = fs.existsSync(updatedPath) ? updatedPath : defaultPath
	logger(`staticFolder = ${staticFolder}`)
	console.log('📁 staticFolder:', staticFolder)
	const isProd = process.env.NODE_ENV === "production";

	const app = express()
	app.set("trust proxy", true)

	/** Stripe merchant-kit webhook：仅在 Master 验签并更新会话 map（Cluster 将 raw body 转发至此） */
	app.post(
		'/api/merchant-kit-stripe-webhook',
		express.raw({ type: 'application/json' }),
		async (req: Request, res: Response) => {
			const ip = getClientIp(req)
			const ua = String(req.headers['user-agent'] ?? '').slice(0, 80)
			logger(
				Colors.cyan('[merchant-kit-stripe-webhook] POST (master)'),
				`ip=${ip || '(none)'}`,
				`ua=${ua || '(none)'}`
			)
			const result = await handleMerchantKitStripeWebhook(req.body as Buffer, req.headers['stripe-signature'])
			if (result.ok) {
				logger(Colors.green('[merchant-kit-stripe-webhook] response 200 received=true'))
				return res.status(200).json({ received: true }).end()
			}
			logger(Colors.red('[merchant-kit-stripe-webhook] response 400'), result.error)
			return res.status(400).send(`Webhook Error: ${result.error}`).end()
		}
	)

	if (!isProd) {
			app.use((req, res, next) => {
				res.setHeader('Access-Control-Allow-Origin', '*'); // 或你的白名单 Origin
				res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
				res.setHeader(
					'Access-Control-Allow-Headers',
					// 允许二跳自定义头；顺手加 Access-Control-Expose-Headers 兜底某些客户端误发到预检
					'Content-Type, Authorization, X-Requested-With, X-PAYMENT, Access-Control-Expose-Headers'
				);
				// 暴露自定义响应头，便于浏览器读取
				res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-PAYMENT-RESPONSE');
				if (req.method === 'OPTIONS') return res.sendStatus(204);
				next();
			});
	} else {
		app.use((req, _res, next) => {
			if (!req.get('x-forwarded-proto')) {
				req.headers['x-forwarded-proto'] = 'https';
			}
			next();
		});
	}


	// app.use ( express.static ( staticFolder ))
	app.use ( express.json({ limit: '5mb' }) )

	const cors = require('cors')
	

	if (!isProd) {
	// 本地开发才由 Node 处理 CORS（例如直连 http://localhost:4088）
		app.use(/.*/, cors({
			origin: ['http://localhost:4088'],
			methods: ['GET','POST','OPTIONS'],
			allowedHeaders: [
				'Content-Type',
				'Authorization',
				'X-Requested-With',
				'X-PAYMENT',
				'Access-Control-Expose-Headers',
			],
			exposedHeaders: ['X-PAYMENT-RESPONSE'],
			credentials: false,
			optionsSuccessStatus: 204,
			maxAge: 600,
		}));
	}


	const router = express.Router ()

	app.use( '/api', router )
	routing(router)
	app.use((err: any, req: Request, res: Response, next: any) => {
		// Guard noisy body-parser JSON syntax errors (e.g. multipart/form-data sent as application/json).
		if (err?.type === 'entity.parse.failed' && err instanceof SyntaxError) {
			const ct = String(req.headers['content-type'] ?? '')
			logger(Colors.yellow(`[json-parse] ${req.method} ${req.originalUrl} invalid JSON body; content-type=${ct || '(none)'}`))
			if (!res.headersSent) {
				return res.status(400).json({ success: false, error: 'Invalid JSON body' }).end()
			}
			return
		}
		next(err)
	})

	logger('Router stack:', router.stack.map(r => r.route?.path))


	logger(`🧭 public router after serverRoute(router)`)

		app.get('/_debug', (req, res) => {
			res.json({
				protocol: req.protocol,
				secure: req.secure,
				host: req.get('host'),
				xfp: req.get('x-forwarded-proto'),
			});
		});

	app.once ( 'error', ( err: any ) => {
		logger (err)
		logger (`Local server on ERROR, try restart!`)
		return 
	})

	app.all ('/', (req: any, res: any) => {
		return res.status(404).end ()
	})

	console.log('🚀 Starting express.listen on port:', PORT)
	const server = app.listen( PORT, () => {
		console.log('✅ Server started successfully!')
		console.table([
			{ 'x402 Server': `http://localhost:${PORT}`, 'Serving files from': staticFolder }
		])
		startNfcLinkAppAutoCancelSweeper()
		startLatestCardsPrewarmTimer()
	})

	server.on('error', (err: any) => {
		console.error('❌ Server error:', err)
	})

	return server
}

const startMaster = async () => {
	initialize('', masterServerPort)
}

export default startMaster