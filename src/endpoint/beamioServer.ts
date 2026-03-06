import express, { Request, Response, Router} from 'express'
import { GoogleGenAI } from '@google/genai'
import { getClientIp, oracleBackoud, checkSign, BeamioTransfer } from '../util'
import { checkSmartAccount } from '../MemberCard'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import { ethers } from "ethers"
import {beamio_ContractPool, searchUsers, FollowerStatus, getMyFollowStatus, getLatestCards, getOwnerNftSeries, getSeriesByCardAndTokenId, getMintMetadataForOwner, getNfcCardByUid, getNfcRecipientAddressByUid, getCardMetadataByOwner, getCardByAddress, getNftTierMetadataByCardAndToken, getNftTierMetadataByOwnerAndToken, insertAiLearningFeedback, getAiLearningFeedback} from '../db'
import {coinbaseToken, coinbaseOfframp, coinbaseHooks} from '../coinbase'
import { purchasingCard, purchasingCardPreCheck, createCardPreCheck, resolveCardOwnerToEOA, AAtoEOAPreCheck, AAtoEOAPreCheckSenderHasCode, OpenContainerRelayPreCheck, ContainerRelayPreCheck, ContainerRelayPreCheckUnsigned, cardCreateRedeemPreCheck, cardAddAdminPreCheck, cardCreateIssuedNftPreCheck, getRedeemStatusBatchApi, claimBUnitsPreCheck, cancelRequestPreCheck, purchaseBUnitFromBasePreCheck } from '../MemberCard'
import { BASE_AA_FACTORY, BASE_CARD_FACTORY, BASE_CCSA_CARD_ADDRESS, BEAMIO_USER_CARD_ASSET_ADDRESS, CONET_BUNIT_AIRDROP_ADDRESS, MERCHANT_POS_MANAGEMENT_CONET } from '../chainAddresses'

/** 服务器返回时强制屏蔽的旧基础设施卡地址 */
const DEPRECATED_INFRA_CARDS = new Set([
	'0xB7644DDb12656F4854dC746464af47D33C206F0E'.toLowerCase(),
	'0xC0F1c74fb95100a97b532be53B266a54f41DB615'.toLowerCase(),
])

/** 旧 CCSA 地址 → 新地址映射，redeemStatusBatch 入口处规范化 */
const OLD_CCSA_REDIRECTS = [
	'0x3A578f47d68a5f2C1f2930E9548E240AB8d40048',
	'0xb6ba88045F854B713562fb7f1332D186df3B25A8', // 曾为 infrastructure CCSA
	'0x6870acA2f4f6aBed6B10B0C8D76C75343398fd64', // 旧工厂部署的 CCSA
	'0xA1A9f6f942dc0ED9Aa7eF5df7337bd878c2e157b', // 旧工厂 0x86879fE3 部署的 CCSA（已迁移至新工厂）
].map(a => a.toLowerCase())
import { masterSetup } from '../util'

const BASE_CHAIN_ID = 8453
const MINT_POINTS_BY_ADMIN_SELECTOR = '0x' + ethers.id('mintPointsByAdmin(address,uint256)').slice(2, 10)

const ISSUED_NFT_START_ID = 100_000_000_000n

/** 仅 issued NFT 读函数，避免依赖完整 ABI 同步 */
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
const BASE_RPC_URL = masterSetup?.base_endpoint || 'https://mainnet.base.org'
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)

/** 从 mintPointsByAdmin(data) 解析 recipient EOA */
const tryParseMintPointsByAdminRecipient = (data: string): string | null => {
	try {
		const iface = new ethers.Interface(['function mintPointsByAdmin(address user, uint256 points6)'])
		const decoded = iface.parseTransaction({ data })
		if (decoded?.name === 'mintPointsByAdmin' && decoded.args[0]) return decoded.args[0] as string
	} catch { /* ignore */ }
	return null
}

/** 解析 EOA 对应的 AA 地址（用于日志） */
const resolveBeamioAccountOf = async (eoa: string): Promise<string | null> => {
	try {
		const iface = new ethers.Interface(['function beamioAccountOf(address) view returns (address)'])
		const result = await providerBase.call({
			to: BASE_AA_FACTORY as `0x${string}`,
			data: iface.encodeFunctionData('beamioAccountOf', [eoa]) as `0x${string}`,
		})
		const [addr] = iface.decodeFunctionResult('beamioAccountOf', result)
		return addr && addr !== ethers.ZeroAddress ? addr : null
	} catch { return null }
}
const CONET_RPC = 'https://mainnet-rpc.conet.network'
const providerConet = new ethers.JsonRpcProvider(CONET_RPC)

const masterServerPort = 1111
const serverPort = 2222

/** Cluster 本地缓存 oracle，监听 CoNET 出块（约 6s/块），每 10 块（约 1 分钟）从 master 拉取 */
const defaultOracle = { bnb: '', eth: '', usdc: '1', timestamp: 0, usdcad: '1', usdjpy: '150', usdcny: '7.2', usdhkd: '7.8', usdeur: '0.92', usdsgd: '1.35', usdtwd: '31' }
let clusterOracleCache: Record<string, string | number> = { ...defaultOracle }

const fetchOracleFromMaster = () => {
	const opts: RequestOptions = { hostname: 'localhost', path: '/api/oracleForCluster', port: masterServerPort, method: 'GET' }
	const req = request(opts, (res) => {
		let buf = ''
		res.on('data', (c) => { buf += c })
		res.on('end', () => {
			try {
				const data = JSON.parse(buf)
				if (data && typeof data === 'object') clusterOracleCache = { ...defaultOracle, ...data }
			} catch (_) {}
		})
	})
	req.on('error', () => {})
	req.end()
}

const startClusterOracleSync = () => {
	const conetRpc = new ethers.JsonRpcProvider('https://mainnet-rpc.conet.network')
	conetRpc.on('block', (blockNumber: bigint | number) => {
		const n = typeof blockNumber === 'bigint' ? Number(blockNumber) : blockNumber
		if (n % 10 !== 0) return
		fetchOracleFromMaster()
	})
	fetchOracleFromMaster()
}

/** JSON 序列化时把 BigInt 转为 string，避免 "Do not know how to serialize a BigInt" */
function jsonStringifyWithBigInt(obj: any): string {
	return JSON.stringify(obj, (_key, value) =>
		typeof value === 'bigint' ? value.toString() : value
	)
}

/** 递归将对象中所有 BigInt 转为 string，避免下游 RPC / JSON 序列化出错 */
function convertBigIntToString(obj: any): any {
	if (obj === null || obj === undefined) return obj
	if (typeof obj === 'bigint') return obj.toString()
	if (Array.isArray(obj)) return obj.map(convertBigIntToString)
	if (typeof obj === 'object') {
		const out: Record<string, any> = {}
		for (const k of Object.keys(obj)) {
			out[k] = convertBigIntToString(obj[k])
		}
		return out
	}
	return obj
}

export const postLocalhost = async (path: string, obj: any, _res: Response)=> {
	
	const option: RequestOptions = {
		hostname: 'localhost',
		path,
		port: masterServerPort,
		method: 'POST',
		protocol: 'http:',
		headers: {
			'Content-Type': 'application/json'
		}
	}

	const req = await request (option, res => {
		
		
		res.pipe(_res)
		
	})

		req.once('error', (e) => {
		logger(Colors.red(`[DEBUG] postLocalhost ${path} FAIL: ${e.message}`))
		_res.status(502).json({ success: false, error: `Forward to master failed: ${e.message}` }).end()
	})

	req.write(jsonStringifyWithBigInt(obj))
	req.end()
}

/** GET 请求转发到 master */
const getLocalhost = (path: string, res: Response) => {
	const opts: RequestOptions = { hostname: 'localhost', path, port: masterServerPort, method: 'GET' }
	const req = request(opts, (masterRes) => { masterRes.pipe(res) })
	req.on('error', (e) => { logger(Colors.red(`getLocalhost ${path} error:`), e.message); res.status(502).end() })
	req.end()
}

/** POST 请求转发到 master 并返回 body（用于需修改响应的场景） */
const postLocalhostBuffer = (path: string, obj: any): Promise<{ statusCode: number; body: string }> =>
	new Promise((resolve, reject) => {
		const opts: RequestOptions = {
			hostname: 'localhost',
			path,
			port: masterServerPort,
			method: 'POST',
			protocol: 'http:',
			headers: { 'Content-Type': 'application/json' }
		}
		const req = request(opts, (masterRes) => {
			let buf = ''
			masterRes.on('data', (c) => { buf += c })
			masterRes.on('end', () => resolve({ statusCode: masterRes.statusCode ?? 500, body: buf }))
		})
		req.on('error', (e) => reject(e))
		req.write(jsonStringifyWithBigInt(obj))
		req.end()
	})

/** GET 请求转发到 master 并返回 body（用于缓存） */
const getLocalhostBuffer = (path: string): Promise<{ statusCode: number; body: string }> =>
	new Promise((resolve, reject) => {
		const opts: RequestOptions = { hostname: 'localhost', path, port: masterServerPort, method: 'GET' }
		const req = request(opts, (masterRes) => {
			let buf = ''
			masterRes.on('data', (c) => { buf += c })
			masterRes.on('end', () => resolve({ statusCode: masterRes.statusCode ?? 500, body: buf }))
		})
		req.on('error', (e) => reject(e))
		req.end()
	})

/** Cluster 预检：若有 requestHash，调用 checkRequestStatus，过期或已支付则返回 { ok: false }，否则 { ok: true } */
const runRequestHashPreCheck = async (requestHash: string, validDays: number, payee: string): Promise<{ ok: boolean; error?: string }> => {
	if (!requestHash || !ethers.isHexString(requestHash) || ethers.dataLength(requestHash) !== 32) return { ok: true }
	if (!payee || !ethers.isAddress(payee)) return { ok: true }
	try {
		const qs = new URLSearchParams({ requestHash, validDays: String(Math.max(1, Math.floor(validDays))), payee }).toString()
		const { statusCode, body } = await getLocalhostBuffer('/api/checkRequestStatus?' + qs)
		if (statusCode !== 200) return { ok: true }
		const data = JSON.parse(body) as { expired?: boolean; fulfilled?: boolean }
		if (data.expired) return { ok: false, error: 'Request expired' }
		if (data.fulfilled) return { ok: false, error: 'Request already paid' }
		return { ok: true }
	} catch {
		return { ok: true }
	}
}

/** myCards 缓存：30 秒内相同查询直接返回，减轻 master 负荷 */
const MY_CARDS_CACHE_TTL_MS = 30 * 1000
const myCardsCache = new Map<string, { body: string; statusCode: number; expiry: number }>()

/** getAAAccount 缓存：30 秒 */
const GET_AA_CACHE_TTL_MS = 30 * 1000
const getAAAccountCache = new Map<string, { body: string; statusCode: number; expiry: number }>()

/** getBalance 缓存：30 秒 */
const GET_BALANCE_CACHE_TTL_MS = 30 * 1000
const getBalanceCache = new Map<string, { body: string; statusCode: number; expiry: number }>()
const GET_BUNIT_CACHE_TTL_MS = 30 * 1000
const getBUnitBalanceCache = new Map<string, { body: string; statusCode: number; expiry: number }>()
const getBUnitLedgerCache = new Map<string, { body: string; statusCode: number; expiry: number }>()

/** 通用查询缓存：30 秒协议 */
const QUERY_CACHE_TTL_MS = 30 * 1000
const redeemStatusBatchCache = new Map<string, { body: string; expiry: number }>()
const searchHelpCache = new Map<string, { body: string; expiry: number }>()
const latestCardsCache = new Map<string, { body: string; expiry: number }>()
const getNFTMetadataCache = new Map<string, { body: string; expiry: number }>()
const ownerNftSeriesCache = new Map<string, { body: string; expiry: number }>()
const seriesSharedMetadataCache = new Map<string, { body: string; expiry: number }>()
const mintMetadataCache = new Map<string, { body: string; expiry: number }>()
const getFollowStatusCache = new Map<string, { body: string; expiry: number }>()
const getMyFollowStatusCache = new Map<string, { body: string; expiry: number }>()

const SC = beamio_ContractPool[0].constAccountRegistry

const userOwnershipCheck = async (accountName: string, wallet: string) => {
	
	try {
		const accountWallet: string = await SC.getOwnerByAccountName(accountName)
		if (accountWallet !== ethers.ZeroAddress && accountWallet.toLowerCase() !== wallet.toLowerCase()) {
			return false
		}
	} catch (ex: any) {
		logger(`userOwnershipCheck Error! ${ex.message}`)
	}
	return true
}

const getFollowCheck = async (wallet: string, followAddress: string) => {
	try {
		const isFollowing: boolean = await SC.isFollowingAddress(wallet, followAddress)
		return isFollowing
	} catch (ex: any) {
		logger(`getFollowCheck Error! ${ex.message}`)
	}
	return null
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
		Colors.gray(
			`[INBOUND][Cluster] ${req.method} ${req.originalUrl} ip=${getClientIp(req)}`
		),
		inspect({ query, body }, false, 4, true)
	)
}

const routing = ( router: Router ) => {
	router.use((req, _res, next) => {
		logInboundDebug(req)
		next()
	})

	/** GET /api/manifest.json - 动态 manifest，cluster 独自处理，无需 master。支持 ?start_url= 或从 Referer 获取 */
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
	
	router.get('/search-users', (req,res) => {
		searchUsers(req,res)
	})

	/** POST /api/nfcCardStatus - 查询 NTAG 424 DNA 卡状态（读操作，Cluster 直接处理） */
	router.post('/nfcCardStatus', async (req, res) => {
		const { uid } = req.body as { uid?: string }
		if (!uid || typeof uid !== 'string') {
			return res.status(400).json({ error: 'Missing uid' })
		}
		const result = await getNfcCardByUid(uid)
		return res.status(200).json(result).end()
	})

	/** POST /api/getUIDAssets - 根据 UID 查询 NFC 卡资产（多卡：CCSA + 基础设施卡 + USDC 余额），Cluster 直接处理。uid 支持 NFC 卡 UID 或 beamioTab（Scan QR 的 beamio 参数，按 AccountRegistry 账户名解析 EOA）。每张卡按用户拥有的最佳 NFT 的 tier metadata 返回 cardBackground（供 Android 等多端展示）。 */
	router.post('/getUIDAssets', async (req, res) => {
		const { uid } = req.body as { uid?: string }
		logger(Colors.cyan(`[getUIDAssets] 收到请求 uid=${uid ?? '(undefined)'}`))
		if (!uid || typeof uid !== 'string' || !uid.trim()) {
			const err = { ok: false, error: 'Missing uid' }
			logger(Colors.yellow(`[getUIDAssets] 返回 400: ${JSON.stringify(err)}`))
			return res.status(400).json(err).end()
		}
		const uidTrim = uid.trim()
		try {
			let eoaRaw = await getNfcRecipientAddressByUid(uidTrim)
			if (!eoaRaw) {
				// beamioTab：Scan QR 的 beamio 参数，按 AccountRegistry 账户名解析 EOA
				try {
					const owner = await SC.getOwnerByAccountName(uidTrim)
					if (owner && owner !== ethers.ZeroAddress) {
						eoaRaw = owner
						logger(Colors.gray(`[getUIDAssets] uid=${uidTrim} 按 beamioTab 解析到 EOA=${owner.slice(0, 10)}...`))
					}
				} catch (_) { /* 非账户名，忽略 */ }
			}
			if (!eoaRaw) {
				const err = { ok: false, error: '该卡没有被登记' }
				logger(Colors.yellow(`[getUIDAssets] uid=${uidTrim} 卡未登记 返回 404: ${JSON.stringify(err)}`))
				return res.status(404).json(err).end()
			}
			const eoa = ethers.getAddress(eoaRaw)
			const cardAbi = [
				'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
				'function currency() view returns (uint8)',
			]
			const usdcAbi = ['function balanceOf(address) view returns (uint256)']
			const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
			const usdc = new ethers.Contract(USDC_BASE, usdcAbi, providerBase)
			const [usdcEoaRaw, aaAddr] = await Promise.all([
				usdc.balanceOf(eoa),
				resolveBeamioAccountOf(eoa),
			])
			let usdcTotalRaw = usdcEoaRaw
			if (aaAddr) {
				const usdcAaRaw = await usdc.balanceOf(aaAddr)
				usdcTotalRaw += usdcAaRaw
			}
			const usdcBalance = ethers.formatUnits(usdcTotalRaw, 6)
			const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
			const cardAddresses: { address: string; name: string; type: string }[] = [
				{ address: BASE_CCSA_CARD_ADDRESS, name: 'CCSA CARD', type: 'ccsa' },
				{ address: BEAMIO_USER_CARD_ASSET_ADDRESS, name: 'CashTrees Card', type: 'infrastructure' },
			].filter(({ address }) => !DEPRECATED_INFRA_CARDS.has(address.toLowerCase()))
			const cards: Array<{
				cardAddress: string
				cardName: string
				cardType: string
				points: string
				points6: string
				cardCurrency: string
				cardBackground?: string
				cardImage?: string
				tierName?: string
				tierDescription?: string
				nfts: Array<{ tokenId: string; attribute: string; tier: string; expiry: string; isExpired: boolean }>
			}> = []
			for (const { address: cardAddr, name: cardName, type: cardType } of cardAddresses) {
				try {
					const card = new ethers.Contract(cardAddr, cardAbi, providerBase)
					const [ [pointsBalance, nfts], currencyNum ] = await Promise.all([
						card.getOwnershipByEOA(eoa),
						card.currency(),
					])
					const currency = currencyMap[Number(currencyNum)] ?? 'CAD'
					const nftList = nfts.map((nft: { tokenId: bigint; attribute: bigint; tierIndexOrMax: bigint; expiry: bigint; isExpired: boolean }) => ({
						tokenId: nft.tokenId.toString(),
						attribute: nft.attribute.toString(),
						tier: nft.tierIndexOrMax === ethers.MaxUint256 ? 'Default/Max' : nft.tierIndexOrMax.toString(),
						expiry: nft.expiry === 0n ? 'Never' : new Date(Number(nft.expiry) * 1000).toLocaleString(),
						isExpired: nft.isExpired,
					}))
					// 用户拥有的最佳 NFT（tokenId 最大且 > 0）用于 tier 显示与 background/image
					let cardBackground: string | undefined
					let cardImage: string | undefined
					let tierName: string | undefined
					let tierDescription: string | undefined
					const withTokenId = nftList.filter((n: { tokenId: string }) => Number(n.tokenId) > 0)
					logger(Colors.gray(`[getUIDAssets] card=${cardAddr} withTokenId=${withTokenId.length} withTokenIds=${withTokenId.map((n: { tokenId: string }) => n.tokenId).join(',')}`))
					const bestNft = withTokenId.length > 0
						? withTokenId.reduce((a: { tokenId: string; tier: string }, b: { tokenId: string; tier: string }) => (Number(b.tokenId) > Number(a.tokenId) ? b : a))
						: null
					let cardRow: { cardOwner: string; metadata: Record<string, unknown> | null } | null = null
					if (bestNft) {
						try {
							cardRow = await getCardByAddress(cardAddr)
							let tierMeta = await getNftTierMetadataByCardAndToken(cardAddr, bestNft.tokenId)
							if (!tierMeta && cardRow?.cardOwner) {
								tierMeta = await getNftTierMetadataByOwnerAndToken(cardRow.cardOwner, bestNft.tokenId)
								if (tierMeta) logger(Colors.gray(`[getUIDAssets] card=${cardAddr} tokenId=${bestNft.tokenId} 按 card_owner 回退查到 tier metadata`))
							}
							if (tierMeta && typeof tierMeta === 'object') {
								const props = tierMeta.properties as Record<string, unknown> | undefined
								const bg = (props?.background_color ?? tierMeta.background_color) as string | undefined
								if (bg && typeof bg === 'string' && bg.trim()) {
									cardBackground = bg.trim().startsWith('#') ? bg.trim() : `#${bg.trim().replace(/^#/, '')}`
								}
								const img = (props?.image ?? tierMeta.image) as string | undefined
								if (img && typeof img === 'string' && img.trim()) cardImage = img.trim()
								tierName = (props?.tier_name ?? tierMeta.name) as string | undefined
								if (tierName && typeof tierName === 'string' && tierName.trim()) tierName = tierName.trim()
								else tierName = undefined
								tierDescription = (props?.tier_description ?? tierMeta.description) as string | undefined
								if (tierDescription && typeof tierDescription === 'string' && tierDescription.trim()) tierDescription = tierDescription.trim()
								else tierDescription = undefined
							} else if (bestNft && !tierMeta) {
								logger(Colors.gray(`[getUIDAssets] card=${cardAddr} tokenId=${bestNft.tokenId} 无 NFT tier metadata，将尝试从卡级 tiers 取 background`))
							}
							// 无 NFT tier metadata 时，用卡级 metadata 的 tiers 数组。按 BeamioUserCard.Tier.minUsdc6 升序排序，低的一档（minUsdc6 最小）为 sorted[0]；Default/Max 对应该低档。
							if ((!tierName || !tierDescription || !cardBackground || !cardImage) && cardRow?.metadata?.tiers && Array.isArray(cardRow.metadata.tiers)) {
								const tiersRaw = cardRow.metadata.tiers as Array<{ index?: number; minUsdc6?: string; name?: string; description?: string; image?: string; backgroundColor?: string }>
								const minUsdc6Num = (t: { minUsdc6?: string }) => {
									const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : ''
									const n = parseInt(s, 10)
									return Number.isNaN(n) ? Infinity : n
								}
								const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b))
								const tierIndexChain = bestNft.tier === 'Default/Max' ? 0 : (parseInt(bestNft.tier, 10) || 0)
								// Default/Max -> 排序后第一档（minUsdc6 最低）；数字 -> 按链上下标取原序中对应项
								const t = bestNft.tier === 'Default/Max'
									? tiersSorted[0]
									: (tiersRaw.find((x: { index?: number }, i: number) => (x.index != null ? x.index : i) === tierIndexChain) ?? tiersRaw[tierIndexChain])
								if (t) {
									if (!tierName && t.name && String(t.name).trim()) tierName = String(t.name).trim()
									if (!tierDescription && t.description && String(t.description).trim()) tierDescription = String(t.description).trim()
									if (!cardImage && t.image && String(t.image).trim()) cardImage = String(t.image).trim()
									// 卡级 tiers 中若有 backgroundColor，作为 cardBackground 兜底（当无 NFT tier metadata 时）
									if (!cardBackground && t.backgroundColor && String(t.backgroundColor).trim()) {
										const bg = String(t.backgroundColor).trim()
										cardBackground = bg.startsWith('#') ? bg : `#${bg.replace(/^#/, '')}`
										logger(Colors.gray(`[getUIDAssets] card=${cardAddr} 使用卡级 tier backgroundColor: ${cardBackground}`))
									}
								}
								if (!tierName && (bestNft.tier === 'Default/Max' || tierIndexChain === 0)) tierName = 'Default'
								else if (!tierName) tierName = `Tier ${tierIndexChain + 1}`
							}
						} catch (_) { /* ignore */ }
					}
					// 当卡中资产为零且无 NFT# > 0 时，不组装进 cards
					const hasPoints = pointsBalance > 0n
					const hasNftGt0 = nftList.some((n: { tokenId: string }) => Number(n.tokenId) > 0)
					if (hasPoints || hasNftGt0) {
						cards.push({
							cardAddress: cardAddr,
							cardName,
							cardType,
							points: ethers.formatUnits(pointsBalance, 6),
							points6: String(pointsBalance),
							cardCurrency: currency,
							...(cardBackground != null && { cardBackground }),
							...(cardImage != null && { cardImage }),
							...(tierName != null && { tierName }),
							...(tierDescription != null && { tierDescription }),
							nfts: nftList,
						})
					} else {
						logger(Colors.gray(`[getUIDAssets] card=${cardAddr} skip: zero points and no NFT# > 0`))
					}
				} catch (cardErr: any) {
					logger(Colors.gray(`[getUIDAssets] card=${cardAddr} skip: ${cardErr?.message ?? cardErr}`))
				}
			}

			// 双保险：即使上游误传，也不向客户端返回已废弃基础设施卡数据
			const cardsFiltered = cards.filter((c) => !DEPRECATED_INFRA_CARDS.has(c.cardAddress.toLowerCase()))


			const result = {
				ok: true,
				address: eoa,
				aaAddress: aaAddr || undefined,
				usdcBalance,
				cards: cardsFiltered,
			}
			// Debug: 返回客户端的完整 JSON，便于排查 Android 端为何未解析/使用 cardBackground
			const resultJson = JSON.stringify(result, null, 2)
			logger(Colors.cyan(`[getUIDAssets] 返回客户端 JSON (uid=${uidTrim}):\n${resultJson}`))
			logger(Colors.green(`[getUIDAssets] uid=${uidTrim} 成功 cards=${cards.length}`))
			return res.status(200).json(result).end()
		} catch (e: any) {
			const msg = e?.shortMessage ?? e?.message ?? ''
			const isRevert = /execution reverted|CALL_EXCEPTION|revert/i.test(String(msg))
			if (isRevert) {
				const err = { ok: false, error: '该卡没有被登记' }
				logger(Colors.yellow(`[getUIDAssets] uid=${uidTrim} 链上查询 revert 返回 404: ${JSON.stringify(err)}`))
				return res.status(404).json(err).end()
			}
			const err = { ok: false, error: msg || 'Query failed' }
			logger(Colors.red(`[getUIDAssets] uid=${uidTrim} failed: ${msg} 返回 500: ${JSON.stringify(err)}`))
			return res.status(500).json(err).end()
		}
	})

	/** POST /api/getWalletAssets - 根据 wallet 查询资产。先确定是 AA 或 EOA：若 EOA 则推算 AA，检查 AA 存在后显示该 AA 资产。用于 Scan QR 获得的 beamio URL */
	router.post('/getWalletAssets', async (req, res) => {
		const { wallet, for: forLabel } = req.body as { wallet?: string; for?: string }
		const isPostPayment = forLabel === 'postPaymentBalance'
		logger(Colors.cyan(`[getWalletAssets] 收到请求 wallet=${wallet ?? '(undefined)'}${isPostPayment ? ' [扣款后拉取余额]' : ''}`))
		if (!wallet || typeof wallet !== 'string' || !wallet.trim()) {
			const err = { ok: false, error: 'Missing wallet' }
			logger(Colors.yellow(`[getWalletAssets] 返回 400: ${JSON.stringify(err)}`))
			return res.status(400).json(err).end()
		}
		if (!ethers.isAddress(wallet)) {
			const err = { ok: false, error: 'Invalid wallet address' }
			return res.status(400).json(err).end()
		}
		try {
			const addr = ethers.getAddress(wallet.trim())
			const code = await providerBase.getCode(addr)
			const isAA = code && code !== '0x' && code.length > 2

			let eoa: string
			let aaAddr: string

			if (isAA) {
				aaAddr = addr
				const aaOwnerAbi = ['function owner() view returns (address)']
				const aaContract = new ethers.Contract(addr, aaOwnerAbi, providerBase)
				const owner = await aaContract.owner()
				if (!owner || owner === ethers.ZeroAddress) {
					const err = { ok: false, error: '该 AA 无法解析 owner' }
					logger(Colors.yellow(`[getWalletAssets] AA 无 owner 返回 404: ${JSON.stringify(err)}`))
					return res.status(404).json(err).end()
				}
				eoa = ethers.getAddress(owner)
			} else {
				eoa = addr
				const aaFactoryAbi = ['function beamioAccountOf(address) view returns (address)']
				const aaFactory = new ethers.Contract(BASE_AA_FACTORY, aaFactoryAbi, providerBase)
				const primary = await aaFactory.beamioAccountOf(addr)
				if (!primary || primary === ethers.ZeroAddress) {
					const err = { ok: false, error: '该钱包未激活 Beamio 账户' }
					logger(Colors.yellow(`[getWalletAssets] EOA 无 AA 返回 404: ${JSON.stringify(err)}`))
					return res.status(404).json(err).end()
				}
				const aaCode = await providerBase.getCode(primary)
				if (!aaCode || aaCode === '0x') {
					const err = { ok: false, error: '该钱包未激活 Beamio 账户' }
					logger(Colors.yellow(`[getWalletAssets] beamioAccountOf 返回的 AA 无 code 返回 404: ${JSON.stringify(err)}`))
					return res.status(404).json(err).end()
				}
				aaAddr = ethers.getAddress(primary)
			}

			const cardAbi = [
				'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
				'function currency() view returns (uint8)',
			]
			const usdcAbi = ['function balanceOf(address) view returns (uint256)']
			const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
			const cardAddresses: { address: string; name: string; type: string }[] = [
				{ address: BASE_CCSA_CARD_ADDRESS, name: 'CCSA CARD', type: 'ccsa' },
				...(DEPRECATED_INFRA_CARDS.has(BEAMIO_USER_CARD_ASSET_ADDRESS.toLowerCase()) ? [] : [{ address: BEAMIO_USER_CARD_ASSET_ADDRESS, name: 'CashTrees Card', type: 'infrastructure' }]),
			]
			const usdc = new ethers.Contract(USDC_BASE, usdcAbi, providerBase)
			const usdcBalanceRaw = await usdc.balanceOf(aaAddr)
			let unitPriceUSDC6 = '0'
			let beamioUserCard = ''
			try {
				const factoryAbi = ['function quoteUnitPointInUSDC6(address) view returns (uint256)']
				const factory = new ethers.Contract(BASE_CARD_FACTORY, factoryAbi, providerBase)
				const up = await factory.quoteUnitPointInUSDC6(BASE_CCSA_CARD_ADDRESS)
				unitPriceUSDC6 = String(up)
			} catch (_) { /* ignore */ }
			try {
				const aaFactoryAbi = ['function beamioUserCard() view returns (address)']
				const aaFactory = new ethers.Contract(BASE_AA_FACTORY, aaFactoryAbi, providerBase)
				const uc = await aaFactory.beamioUserCard()
				if (uc && uc !== ethers.ZeroAddress) beamioUserCard = ethers.getAddress(uc)
			} catch (_) { /* ignore */ }
			const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
			const cards: Array<{ cardAddress: string; cardName: string; cardType: string; points: string; points6: string; cardCurrency: string; cardBackground?: string; cardImage?: string; tierName?: string; tierDescription?: string; nfts: Array<{ tokenId: string; attribute: string; tier: string; expiry: string; isExpired: boolean }> }> = []
			for (const { address: cardAddr, name: cardName, type: cardType } of cardAddresses) {
				try {
					const card = new ethers.Contract(cardAddr, cardAbi, providerBase)
					const [[pointsBalance, nfts], currencyNum] = await Promise.all([
						card.getOwnershipByEOA(eoa),
						card.currency(),
					])
					const currency = currencyMap[Number(currencyNum)] ?? 'CAD'
					const nftList = nfts.map((nft: { tokenId: bigint; attribute: bigint; tierIndexOrMax: bigint; expiry: bigint; isExpired: boolean }) => ({
						tokenId: nft.tokenId.toString(),
						attribute: nft.attribute.toString(),
						tier: nft.tierIndexOrMax === ethers.MaxUint256 ? 'Default/Max' : nft.tierIndexOrMax.toString(),
						expiry: nft.expiry === 0n ? 'Never' : new Date(Number(nft.expiry) * 1000).toLocaleString(),
						isExpired: nft.isExpired,
					}))
					let cardBackground: string | undefined
					let cardImage: string | undefined
					let tierName: string | undefined
					let tierDescription: string | undefined
					const withTokenId = nftList.filter((n: { tokenId: string }) => Number(n.tokenId) > 0)
					const bestNft = withTokenId.length > 0 ? withTokenId.reduce((a: { tokenId: string; tier: string }, b: { tokenId: string; tier: string }) => (Number(b.tokenId) > Number(a.tokenId) ? b : a)) : null
					if (bestNft) {
						try {
							const cardRow = await getCardByAddress(cardAddr)
							let tierMeta = await getNftTierMetadataByCardAndToken(cardAddr, bestNft.tokenId)
							if (!tierMeta && cardRow?.cardOwner) {
								tierMeta = await getNftTierMetadataByOwnerAndToken(cardRow.cardOwner, bestNft.tokenId)
							}
							if (tierMeta && typeof tierMeta === 'object') {
								const props = tierMeta.properties as Record<string, unknown> | undefined
								const bg = (props?.background_color ?? tierMeta.background_color) as string | undefined
								if (bg && typeof bg === 'string' && bg.trim()) cardBackground = bg.trim().startsWith('#') ? bg.trim() : `#${bg.trim().replace(/^#/, '')}`
								const img = (props?.image ?? tierMeta.image) as string | undefined
								if (img && typeof img === 'string' && img.trim()) cardImage = img.trim()
								tierName = (props?.tier_name ?? tierMeta.name) as string | undefined
								if (tierName && typeof tierName === 'string' && tierName.trim()) tierName = tierName.trim()
								else tierName = undefined
								tierDescription = (props?.tier_description ?? tierMeta.description) as string | undefined
								if (tierDescription && typeof tierDescription === 'string' && tierDescription.trim()) tierDescription = tierDescription.trim()
								else tierDescription = undefined
							}
							if ((!tierName || !tierDescription || !cardBackground || !cardImage) && cardRow?.metadata?.tiers && Array.isArray(cardRow.metadata.tiers)) {
								const tiersRaw = cardRow.metadata.tiers as Array<{ index?: number; minUsdc6?: string; name?: string; description?: string; image?: string; backgroundColor?: string }>
								const minUsdc6Num = (t: { minUsdc6?: string }) => { const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : ''; const n = parseInt(s, 10); return Number.isNaN(n) ? Infinity : n }
								const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b))
								const tierIndexChain = bestNft.tier === 'Default/Max' ? 0 : (parseInt(bestNft.tier, 10) || 0)
								const t = bestNft.tier === 'Default/Max' ? tiersSorted[0] : (tiersRaw.find((x: { index?: number }, i: number) => (x.index != null ? x.index : i) === tierIndexChain) ?? tiersRaw[tierIndexChain])
								if (t) {
									if (!tierName && t.name && String(t.name).trim()) tierName = String(t.name).trim()
									if (!tierDescription && t.description && String(t.description).trim()) tierDescription = String(t.description).trim()
									if (!cardImage && t.image && String(t.image).trim()) cardImage = String(t.image).trim()
									if (!cardBackground && t.backgroundColor && String(t.backgroundColor).trim()) {
										const bg = String(t.backgroundColor).trim()
										cardBackground = bg.startsWith('#') ? bg : `#${bg.replace(/^#/, '')}`
									}
								}
								if (!tierName && (bestNft.tier === 'Default/Max' || tierIndexChain === 0)) tierName = 'Default'
								else if (!tierName) tierName = `Tier ${tierIndexChain + 1}`
							}
						} catch (_) { /* ignore */ }
					}
					cards.push({
						cardAddress: cardAddr,
						cardName,
						cardType,
						points: ethers.formatUnits(pointsBalance, 6),
						points6: String(pointsBalance),
						cardCurrency: currency,
						...(cardBackground != null && { cardBackground }),
						...(cardImage != null && { cardImage }),
						...(tierName != null && { tierName }),
						...(tierDescription != null && { tierDescription }),
						nfts: nftList,
					})
				} catch (_) { /* skip failed card */ }
			}
			const firstCard = cards[0]
			const result = {
				ok: true,
				address: eoa,
				aaAddress: aaAddr,
				cardAddress: firstCard?.cardAddress ?? BASE_CCSA_CARD_ADDRESS,
				points: firstCard?.points ?? '0',
				points6: firstCard?.points6 ?? '0',
				usdcBalance: ethers.formatUnits(usdcBalanceRaw, 6),
				cardCurrency: firstCard?.cardCurrency ?? 'CAD',
				cards,
				nfts: firstCard?.nfts ?? [],
				unitPriceUSDC6,
				beamioUserCard: beamioUserCard || undefined,
			}
			const resultJson = JSON.stringify(result, null, 2)
			logger(Colors.cyan(`[getWalletAssets] 返回客户端 JSON (wallet=${eoa}):\n${resultJson}`))
			logger(Colors.green(`[getWalletAssets] wallet=${eoa} aa=${aaAddr} 成功 cards=${cards.length}`))
			return res.status(200).json(result).end()
		} catch (e: any) {
			const msg = e?.shortMessage ?? e?.message ?? ''
			const isRevert = /execution reverted|CALL_EXCEPTION|revert/i.test(String(msg))
			if (isRevert) {
				const err = { ok: false, error: '该钱包未激活 Beamio 账户' }
				logger(Colors.yellow(`[getWalletAssets] 链上查询 revert 返回 404: ${JSON.stringify(err)}`))
				return res.status(404).json(err).end()
			}
			const err = { ok: false, error: msg || 'Query failed' }
			logger(Colors.red(`[getWalletAssets] failed: ${msg} 返回 500: ${JSON.stringify(err)}`))
			return res.status(500).json(err).end()
		}
	})

	/** POST /api/registerNfcCard - 登记 NFC 卡，Cluster 预检后转发 Master */
	router.post('/registerNfcCard', async (req, res) => {
		const { uid, privateKey } = req.body as { uid?: string; privateKey?: string }
		if (!uid || typeof uid !== 'string' || !privateKey || typeof privateKey !== 'string') {
			return res.status(400).json({ ok: false, error: 'Missing uid or privateKey' })
		}
		logger(Colors.green('server /api/registerNfcCard preCheck OK, forwarding to master'))
		postLocalhost('/api/registerNfcCard', { uid: uid.trim(), privateKey: privateKey.trim() }, res)
	})

	/** POST /api/payByNfcUidPrepare - Android 构建 container 前的准备（读操作，Cluster 可直处理或转发 Master） */
	router.post('/payByNfcUidPrepare', async (req, res) => {
		const { uid, payee, amountUsdc6 } = req.body as { uid?: string; payee?: string; amountUsdc6?: string }
		if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
			return res.status(400).json({ ok: false, error: 'Missing uid' })
		}
		if (!payee || !ethers.isAddress(payee)) {
			return res.status(400).json({ ok: false, error: 'Invalid payee' })
		}
		if (!amountUsdc6 || BigInt(amountUsdc6) <= 0n) {
			return res.status(400).json({ ok: false, error: 'Invalid amountUsdc6' })
		}
		logger(Colors.green(`[payByNfcUidPrepare] Cluster preCheck OK forwarding to master`))
		postLocalhost('/api/payByNfcUidPrepare', { uid: uid.trim(), payee: ethers.getAddress(payee), amountUsdc6 }, res)
	})

	/** POST /api/payByNfcUidSignContainer - 接受 Android 打包的未签名 container（写操作，Cluster 预检余额后转发 Master） */
	router.post('/payByNfcUidSignContainer', async (req, res) => {
		const { uid, containerPayload, amountUsdc6 } = req.body as { uid?: string; containerPayload?: import('../MemberCard').ContainerRelayPayloadUnsigned; amountUsdc6?: string }
		if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
			return res.status(400).json({ success: false, error: 'Missing uid' })
		}
		if (!containerPayload || typeof containerPayload !== 'object') {
			return res.status(400).json({ success: false, error: 'Missing containerPayload' })
		}
		logger(Colors.cyan(`[payByNfcUidSignContainer] Android container uid=${uid.slice(0, 16)}... amountUsdc6=${amountUsdc6}\n` + inspect(containerPayload, false, 4, true)))
		const preCheck = ContainerRelayPreCheckUnsigned(containerPayload)
		if (!preCheck.success) {
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		if (!amountUsdc6 || BigInt(amountUsdc6) <= 0n) {
			return res.status(400).json({ success: false, error: 'Invalid amountUsdc6' })
		}
		// Cluster 预检：扣款是否在余额内，不足则返回错误，不转发 Master
		const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
		const usdcAbi = ['function balanceOf(address) view returns (uint256)']
		const cardAbi = ['function getOwnership(address) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[])']
		try {
			const account = ethers.getAddress(containerPayload.account)
			const usdc = new ethers.Contract(USDC_BASE, usdcAbi, providerBase)
			let usdcRequired = 0n
			const cardRequired = new Map<string, bigint>()
			for (const it of containerPayload.items) {
				const amount = BigInt(it.amount)
				if (it.kind === 0 && ethers.getAddress(it.asset).toLowerCase() === USDC_BASE.toLowerCase()) {
					usdcRequired += amount
				} else if (it.kind === 1) {
					const cardAddr = ethers.getAddress(it.asset)
					cardRequired.set(cardAddr, (cardRequired.get(cardAddr) ?? 0n) + amount)
				}
			}
			const usdcPromise = usdcRequired > 0n ? usdc.balanceOf(account) : Promise.resolve(0n)
			const cardPromises = Array.from(cardRequired.entries()).map(async ([cardAddr, required]) => {
				const card = new ethers.Contract(cardAddr, cardAbi, providerBase)
				const res = await card.getOwnership(account) as [bigint, unknown[]]
				const points = res[0]
				return { required, points }
			})
			const results = await Promise.all([usdcPromise, ...cardPromises])
			const usdcBalance = results[0] as bigint
			const cardBalances = results.slice(1) as { required: bigint; points: bigint }[]
			if (usdcRequired > 0n && usdcBalance < usdcRequired) {
				logger(Colors.yellow(`[payByNfcUidSignContainer] Cluster 预检失败: USDC 余额不足 需=${usdcRequired} 有=${usdcBalance}`))
				return res.status(400).json({ success: false, error: '余额不足' }).end()
			}
			for (const { required, points } of cardBalances) {
				if (points < required) {
					logger(Colors.yellow(`[payByNfcUidSignContainer] Cluster 预检失败: CCSA 点数不足 需=${required} 有=${points}`))
					return res.status(400).json({ success: false, error: '余额不足' }).end()
				}
			}
		} catch (e: any) {
			logger(Colors.red(`[payByNfcUidSignContainer] Cluster 余额预检异常: ${e?.message ?? e}`))
			return res.status(500).json({ success: false, error: '余额预检失败' }).end()
		}
		logger(Colors.green(`[payByNfcUidSignContainer] Cluster preCheck OK uid=${uid.slice(0, 16)}... forwarding to master`))
		postLocalhost('/api/payByNfcUidSignContainer', { uid: uid.trim(), containerPayload, amountUsdc6 }, res)
	})

	/** POST /api/payByNfcUid - 以 UID 支付（写操作，Cluster 预检后转发 Master） */
	router.post('/payByNfcUid', async (req, res) => {
		const { uid, amountUsdc6, payee } = req.body as { uid?: string; amountUsdc6?: string; payee?: string }
		if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
			return res.status(400).json({ success: false, error: 'Missing uid' })
		}
		const amountBig = amountUsdc6 ? BigInt(amountUsdc6) : 0n
		if (amountBig <= 0n) {
			return res.status(400).json({ success: false, error: 'Invalid amountUsdc6' })
		}
		if (!payee || !ethers.isAddress(payee)) {
			return res.status(400).json({ success: false, error: 'Invalid payee address' })
		}
		// 不在此做卡登记检测，直接转发 Master；Master 会从 DB 或 mnemonic 派生私钥
		logger(Colors.green(`[payByNfcUid] Cluster preCheck OK uid=${uid.trim().slice(0, 16)}... amountUsdc6=${amountUsdc6} payee=${ethers.getAddress(payee)} forwarding to master`))
		postLocalhost('/api/payByNfcUid', { uid: uid.trim(), amountUsdc6: amountUsdc6, payee: ethers.getAddress(payee) }, res)
	})

	/** POST /api/nfcTopupPrepare - 转发到 Master，返回 executeForAdmin 所需的 cardAddr、data、deadline、nonce。cardAddress 必填；支持 uid（NFC）、wallet（Scan QR）或 beamioTag（Scan QR 的 beamio 参数，按 AccountRegistry 解析 EOA）。 */
	router.post('/nfcTopupPrepare', async (req, res) => {
		const { uid, wallet, beamioTag, amount, currency, cardAddress } = req.body as { uid?: string; wallet?: string; beamioTag?: string; amount?: string; currency?: string; cardAddress?: string }
		const hasUid = uid && typeof uid === 'string' && uid.trim().length > 0
		let resolvedWallet: string | undefined = wallet && typeof wallet === 'string' && ethers.isAddress(wallet.trim()) ? ethers.getAddress(wallet.trim()) : undefined
		const hasBeamioTag = beamioTag && typeof beamioTag === 'string' && beamioTag.trim().length > 0
		if (hasBeamioTag && !resolvedWallet) {
			try {
				const owner = await SC.getOwnerByAccountName(beamioTag!.trim())
				if (owner && owner !== ethers.ZeroAddress) {
					resolvedWallet = ethers.getAddress(owner)
					logger(Colors.gray(`[nfcTopupPrepare] beamioTag=${beamioTag!.trim()} 解析到 wallet=${resolvedWallet.slice(0, 10)}...`))
				}
			} catch (_) { /* 非账户名，忽略 */ }
		}
		const hasWallet = !!resolvedWallet
		if (!hasUid && !hasWallet) {
			return res.status(400).json({ success: false, error: hasBeamioTag ? 'beamioTag 无法解析到有效钱包' : 'Missing uid or wallet' })
		}
		if (!cardAddress || typeof cardAddress !== 'string' || !ethers.isAddress(cardAddress.trim())) {
			return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' })
		}
		const forwardBody = {
			uid: hasUid ? uid!.trim() : undefined,
			wallet: resolvedWallet,
			amount: String(amount ?? ''),
			currency: (currency || 'CAD').trim(),
			cardAddress: ethers.getAddress(cardAddress.trim())
		}
		try {
			const { statusCode, body } = await postLocalhostBuffer('/api/nfcTopupPrepare', forwardBody)
			const parsed = JSON.parse(body)
			if (resolvedWallet && hasBeamioTag && parsed.cardAddr && !parsed.error) {
				parsed.wallet = resolvedWallet
			}
			res.status(statusCode).json(parsed).end()
		} catch (e: any) {
			logger(Colors.red(`[nfcTopupPrepare] forward failed: ${e?.message ?? e}`))
			res.status(502).json({ success: false, error: `Forward to master failed: ${e?.message ?? e}` }).end()
		}
	})

	/** POST /api/nfcTopup - NFC 卡向 CCSA 充值：读取方 UI 用户用 profile 私钥签 ExecuteForAdmin，Cluster 预检签名与 isAdmin 后转发 Master */
	router.post('/nfcTopup', async (req, res) => {
		const { cardAddr, data, deadline, nonce, adminSignature, uid } = req.body as {
			cardAddr?: string
			data?: string
			deadline?: number
			nonce?: string
			adminSignature?: string
			uid?: string
		}
		if (!cardAddr || !ethers.isAddress(cardAddr) || !data || typeof data !== 'string' || data.length === 0) {
			return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr/data' })
		}
		if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string' || !adminSignature || typeof adminSignature !== 'string') {
			return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce/adminSignature' })
		}
		try {
			if (!data.startsWith(MINT_POINTS_BY_ADMIN_SELECTOR)) {
				return res.status(400).json({ success: false, error: 'executeForAdmin only supports mintPointsByAdmin (topup)' })
			}
			const now = Math.floor(Date.now() / 1000)
			if (now > deadline) {
				return res.status(400).json({ success: false, error: 'Deadline expired' })
			}
			const cardAddress = ethers.getAddress(cardAddr)
			const dataHash = ethers.keccak256(data)
			const domain = {
				name: 'BeamioUserCardFactory',
				version: '1',
				chainId: BASE_CHAIN_ID,
				verifyingContract: BASE_CARD_FACTORY
			}
			const types = {
				ExecuteForAdmin: [
					{ name: 'cardAddress', type: 'address' },
					{ name: 'dataHash', type: 'bytes32' },
					{ name: 'deadline', type: 'uint256' },
					{ name: 'nonce', type: 'bytes32' }
				]
			}
			const message = {
				cardAddress,
				dataHash,
				deadline: BigInt(deadline),
				nonce: nonce.startsWith('0x') ? nonce : '0x' + nonce
			}
			const digest = ethers.TypedDataEncoder.hash(domain, types, message)
			const signer = ethers.recoverAddress(digest, adminSignature)
			const cardAbi = ['function isAdmin(address) view returns (bool)']
			const card = new ethers.Contract(cardAddress, cardAbi, providerBase)
			const isAdmin = await card.isAdmin(signer)
			if (!isAdmin) {
				return res.status(403).json({ success: false, error: 'Signer is not card admin' })
			}
			const recipientEOA = tryParseMintPointsByAdminRecipient(data)
			if (!recipientEOA || !ethers.isAddress(recipientEOA)) {
				return res.status(400).json({ success: false, error: 'Invalid mintPointsByAdmin payload' })
			}
			const aaAddr = recipientEOA ? await resolveBeamioAccountOf(recipientEOA) : null
			logger(Colors.green(`server /api/nfcTopup preCheck OK | uid=${uid ?? '(not provided)'} | wallet=${recipientEOA ?? 'N/A'} | AA=${aaAddr ?? 'N/A'} | forwarding to master`))
			postLocalhost('/api/nfcTopup', {
				cardAddr: cardAddress,
				data,
				deadline,
				nonce,
				adminSignature,
				uid: typeof uid === 'string' ? uid : undefined
			}, res)
		} catch (e: any) {
			logger(Colors.red(`[nfcTopup] preCheck failed: ${e?.message ?? e}`))
			return res.status(400).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'PreCheck failed' })
		}
	})

	/** 最新发行的前 N 张卡明细（含 mint token #0 总数、卡持有者数、metadata）。30 秒缓存 */
	router.get('/latestCards', async (req, res) => {
		const limit = Math.min(parseInt(String(req.query.limit || 20), 10) || 20, 100)
		const cacheKey = `limit:${limit}`
		const cached = latestCardsCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		const items = await getLatestCards(limit)
		const body = JSON.stringify({ items })
		latestCardsCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
		res.status(200).json({ items })
	})

	/** GET /api/searchHelp?card=0x... - 返回该卡已定义的全部 issued NFT 列表。30 秒缓存 */
	router.get('/searchHelp', async (req, res) => {
		const { card } = req.query as { card?: string }
		if (!card || !ethers.isAddress(card)) {
			return res.status(400).json({ error: 'Invalid card address' })
		}
		const cacheKey = ethers.getAddress(card).toLowerCase()
		const cached = searchHelpCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const cardContract = new ethers.Contract(card, BEAMIO_USER_CARD_ISSUED_NFT_ABI, providerBase)
			const nextIdx = await cardContract.issuedNftIndex()
			const nextIdxN = Number(nextIdx)
			const startN = Number(ISSUED_NFT_START_ID)
			if (nextIdxN <= startN) {
				return res.status(200).json({ items: [] })
			}
			const items: Array<{
				tokenId: string
				title: string
				sharedMetadataHash: string | null
				validAfter: string
				validBefore: string
				maxSupply: string
				mintedCount: string
				priceInCurrency6: string
			}> = []
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
			const body = JSON.stringify({ items })
			searchHelpCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json({ items })
		} catch (err: any) {
			logger(Colors.red('[searchHelp] error:'), err?.message ?? err)
			return res.status(500).json({ error: err?.message ?? 'Failed to fetch issued NFTs' })
		}
	})

	/** POST /api/ai/learningFeedback - 保存 AI 学习反馈（满意/纠正），共享给所有用户。correctedAction：Beamio 提供的期望 UI/action */
	router.post('/ai/learningFeedback', async (req, res) => {
		logger(Colors.cyan('[ai/learningFeedback] DEBUG body:'), JSON.stringify(req.body, null, 2))
		const { kind, userInput, action, customRule, correctedAction } = req.body as {
			kind?: string
			userInput?: string
			action?: object
			customRule?: string
			correctedAction?: object
		}
		if (!kind || !['approved', 'corrected'].includes(kind)) {
			return res.status(400).json({ error: 'Invalid kind, use approved or corrected' })
		}
		if (!userInput || typeof userInput !== 'string' || !userInput.trim()) {
			return res.status(400).json({ error: 'Missing or invalid userInput' })
		}
		if (!action || typeof action !== 'object') {
			return res.status(400).json({ error: 'Missing or invalid action' })
		}
		const ok = await insertAiLearningFeedback(kind, userInput, action, customRule, correctedAction)
		if (!ok) {
			logger(Colors.red('[ai/learningFeedback] Failed to save'))
			return res.status(500).json({ error: 'Failed to save feedback' })
		}
		logger(Colors.green('[ai/learningFeedback] Saved:'), kind, userInput?.slice(0, 50))
		return res.status(200).json({ ok: true })
	})

	/** GET /api/ai/learningFeedback - 获取 AI 学习反馈（供 beamioAction 注入 prompt） */
	router.get('/ai/learningFeedback', async (_req, res) => {
		const rows = await getAiLearningFeedback()
		return res.status(200).json({ items: rows })
	})

	/** GET /api/ai/generateImage?prompt=... - Proxy Pollinations 图片生成，避免客户端 403/CORS。使用 gen.pollinations.ai，需配置 masterSetup.POLLINATIONS_API_KEY（免費 key 見 enter.pollinations.ai） */
	router.get('/ai/generateImage', async (req, res) => {
		const prompt = typeof req.query?.prompt === 'string' ? req.query.prompt.trim() : ''
		const text = prompt || 'a cute avatar'
		const apiKey = (masterSetup as { POLLINATIONS_API_KEY?: string })?.POLLINATIONS_API_KEY
		const key = apiKey && typeof apiKey === 'string' ? apiKey.trim() : ''
		const baseUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(text)}`
		const params = new URLSearchParams({ model: 'flux' })
		if (key) params.set('key', key)
		const url = `${baseUrl}?${params.toString()}`
		const headers: Record<string, string> = { 'User-Agent': 'Beamio/1.0 (https://beamio.app)' }
		if (key) headers['Authorization'] = `Bearer ${key}`
		try {
			const ctrl = new AbortController()
			const t = setTimeout(() => ctrl.abort(), 90_000)
			try {
				const upstream = await fetch(url, {
					headers,
					signal: ctrl.signal,
				})
				clearTimeout(t)
				if (!upstream.ok) {
					logger(Colors.yellow('[ai/generateImage] upstream'), upstream.status, baseUrl)
					if ((upstream.status === 401 || upstream.status === 403) && !key) {
						return res.status(503).json({ error: 'Image service requires POLLINATIONS_API_KEY. Add it to ~/.master.json (free key at enter.pollinations.ai)' })
					}
					if (upstream.status === 403 && key) {
						return res.status(503).json({ error: 'POLLINATIONS_API_KEY rejected (403). Check key validity and image scope at enter.pollinations.ai' })
					}
					return res.status(upstream.status).json({ error: `Image service returned ${upstream.status}` })
				}
				const ct = upstream.headers.get('content-type') || 'image/png'
				res.setHeader('Content-Type', ct)
				res.setHeader('Cache-Control', 'public, max-age=86400')
				const buf = await upstream.arrayBuffer()
				res.send(Buffer.from(buf))
			} finally {
				clearTimeout(t)
			}
		} catch (e) {
			logger(Colors.red('[ai/generateImage]'), (e as Error)?.message ?? e, baseUrl)
			return res.status(502).json({ error: 'Failed to generate image' })
		}
	})

	/** POST /api/ai/beamioAction - Cluster 直接调用 Gemini 2.5 Flash，根据用户意图返回 BeamioAction（读操作，无需 Master） */
	router.post('/ai/beamioAction', async (req, res) => {
		// Debug: 显示 UI 传入的原始数据
		logger(Colors.cyan('[ai/beamioAction] DEBUG body:'), JSON.stringify(req.body, null, 2))
		const apiKey = masterSetup?.GEMINI_API_KEY
		if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
			logger(Colors.yellow('[ai/beamioAction] masterSetup.GEMINI_API_KEY not configured'))
			return res.status(503).json({ error: 'AI service unavailable: GEMINI_API_KEY not configured' })
		}
		const { messages, userText } = req.body as {
			messages?: Array<{ role: 'user' | 'assistant'; content: string }>
			userText?: string
		}
		if (!userText || typeof userText !== 'string' || !userText.trim()) {
			return res.status(400).json({ error: 'Missing or invalid userText' })
		}
		const feedbackItems = await getAiLearningFeedback()
		let feedbackPrompt = ''
		if (feedbackItems.length > 0) {
			feedbackPrompt = '\n\nLearned from user feedback (apply when relevant):\n'
			for (const f of feedbackItems.slice(0, 20)) {
				if (f.kind === 'approved') {
					feedbackPrompt += `- User said "${f.user_input}" -> action: ${JSON.stringify(f.action_json)}\n`
				} else if (f.kind === 'corrected') {
					if (f.custom_rule) {
						try {
							const parsed = JSON.parse(f.custom_rule) as { _correctedAction?: object }
							if (parsed._correctedAction) {
								feedbackPrompt += `- User corrected "${f.user_input}" -> use this action instead: ${JSON.stringify(parsed._correctedAction)}\n`
							} else {
								feedbackPrompt += `- Rule: ${f.custom_rule}\n`
							}
						} catch {
							feedbackPrompt += `- Rule: ${f.custom_rule}\n`
						}
					} else {
						feedbackPrompt += `- User corrected "${f.user_input}" -> action: ${JSON.stringify(f.action_json)}\n`
					}
				}
			}
		}
		const BEAMIO_ACTION_SCHEMA = {
			type: 'object' as const,
			properties: {
				type: {
					type: 'string' as const,
					enum: ['pay', 'request', 'cashcode', 'fuel', 'balance', 'history', 'contact', 'add-usdc', 'card-topup', 'text', 'custom-ui', 'edit-profile', 'send-chat', 'generate-avatar-image'],
				},
				params: {
					type: 'object' as const,
					properties: {
						to: { type: 'string' as const },
						amount: { type: 'number' as const },
						currency: { type: 'string' as const, enum: ['USD', 'USDC', 'CAD', 'JPY', 'CNY', 'HKD', 'EUR', 'SGD', 'TWD'] },
						note: { type: 'string' as const },
						content: { type: 'string' as const },
						text: { type: 'string' as const },
						firstName: { type: 'string' as const },
						lastName: { type: 'string' as const },
						avatarSeed: { type: 'string' as const },
						mode: { type: 'string' as const, enum: ['create', 'redeem'] },
						query: { type: 'string' as const },
						action: { type: 'string' as const, enum: ['view', 'pay', 'chat'] },
						cardId: { type: 'string' as const },
						limit: { type: 'number' as const },
						prompt: { type: 'string' as const },
						ui: {
							type: 'object' as const,
							properties: {
								schema: { type: 'string' as const },
								root: { type: 'object' as const },
							},
							required: ['schema', 'root'],
						},
					},
					additionalProperties: true,
				},
			},
			required: ['type', 'params'],
		}
		const BEAMIO_INFRA_PROMPT = `
Beamio balance infrastructure (for your understanding when answering):
- EOA = user's wallet address (e.g. MetaMask). Holds USDC directly on Base.
- AA = Beamio Account (smart contract), resolved via beamioAccountOf(EOA). Activated when user first uses Beamio. Also holds USDC on Base.
- User total USDC = EOA balance + AA balance. B-Units = CoNET chain credits for gas/fees, separate from USDC.
- APIs: GET /api/getBalance?address=0x... returns {eth, usdc} for that address. GET /api/getWalletAssets?wallet=0x...&isAA=false returns AA balance + cards. getUIDAssets (NFC) returns EOA+AA combined.
- When user asks "balance", "how much", "my USDC", "check balance", "餘額", "有多少" -> return balance or custom-ui with BalanceDisplay.`
		const CONET_CHAT_PROMPT = `
CoNET chat infrastructure (for your understanding when answering):
- Chat uses CoNET P2P: messages encrypted with PGP, posted to CoNET nodes (https://{node}.conet.network/post). Recipient fetches via gossip.
- User PGP keys: stored on CoNET chain (AddressPGP). regiestChatRoute registers keys so others can find them. getAllNodes (GuardianNodesInfoV6) returns entry nodes.
- When user asks "chat", "message", "open contacts", "和某人聊天", "發訊息給" -> return contact with action: "chat".
- If user specifies a person (e.g. "chat with @Simon", "message John") -> include query: "Simon" or "John" in params. { type: "contact", params: { action: "chat", query: "Simon" } }.
- contact with action: chat opens the Chat/contacts page where user can select or start a conversation.`
		const PROFILE_EDIT_PROMPT = `
Profile edit (edit-profile): Update user's Beamio profile via addUser API.
- firstName, lastName: display name. When user says "change name to X", "my name is John Smith" -> { type: "edit-profile", params: { firstName: "John", lastName: "Smith" } }.
- avatarSeed: DiceBear emoji avatar (seed only). When user says "change avatar to emoji", "use DiceBear seed" -> { type: "edit-profile", params: { avatarSeed: "beamio-123" } }.
- IMPORTANT: When user says "生成小貓頭像", "generate cat avatar", "為我生成貓咪圖片", "get a cat image" -> use generate-avatar-image (returns actual image), NOT edit-profile.
- currency: USD|USDC|CAD|JPY|CNY|HKD|EUR|SGD|TWD. When user says "set currency to CAD", "use JPY" -> { type: "edit-profile", params: { currency: "CAD" } }.
- Can combine: { type: "edit-profile", params: { firstName: "John", lastName: "Doe", avatarSeed: "beamio-john", currency: "CAD" } }.
- Triggers: "change name", "update profile", "set currency", "修改名字", "設置貨幣".`
		const GENERATE_AVATAR_PROMPT = `
generate-avatar-image: AI generates any image from text prompt (via Pollinations). User can download or set as profile avatar.
- When user says "生成小貓頭像", "generate cat avatar", "為我生成貓咪圖片" -> { type: "generate-avatar-image", params: { prompt: "a cute kitten avatar" } }.
- When user says "生成星空圖", "畫一隻龍", "create a dragon", "sunset over ocean", "a robot" -> { type: "generate-avatar-image", params: { prompt: "user's description in English" } }.
- Always put the prompt in English for best results. Use generate-avatar-image when user wants to CREATE/GET any image. Use edit-profile only for changing name/currency/DiceBear seed.`
		const HISTORY_PROMPT = `
history: Transaction history from BeamioIndexerDiamond. UI fetches via getAccountTransactionsByMonthOffsetPaged and displays inline.
- When user says "顯示前N條 歷史", "show last N transactions", "前5筆記錄", "顯示歷史" (with or without N) -> { type: "history", params: { limit: N } }. Use N from user (e.g. 5); if no number, use limit: 5.
- When user says "history", "交易記錄", "open history" (no count, wants full page) -> { type: "history", params: {} } opens History page.`
		const BEAMIO_SERVICE_CATALOG = `
Service catalog (actions that invoke backend/client services):
- send-chat: Send a CoNET P2P message directly. params: { to: string (BeamioTag, e.g. "Simon"), text: string }.
  When user says "send hello to @Simon", "message John with hi", "發送訊息給 Simon 說 hello" -> { type: "send-chat", params: { to: "Simon", text: "hello" } }.
  Use send-chat when user explicitly wants to SEND a message. Use contact with action: chat when user wants to open chat/contacts without sending.`
		const UI_CATALOG_PROMPT = `
custom-ui: For composite or custom layouts, use type "custom-ui" with params.ui = { schema: "beamio-ui-v1", root: UINode }.
UINode: { type, props?, children? }. root MUST have type (e.g. "Card") and valid structure. NEVER return root: {}.
Allowed types: Card, Text, Button, Row, Column, Spacer, Divider, BalanceDisplay, AddUsdcHint, ActionButton.
- Card: props.title?, props.subtitle?, children
- Text: props.content, props.size? (xs|sm|base|lg)
- Button: props.label, props.action? (pay|fuel|balance|add-usdc|contact|history|cashcode|request|card-topup), props.href? (external link)
- ActionButton: props.label, props.actionType, props.actionParams? - opens Beamio action
- Row/Column: props.gap?, children
- Spacer: props.height? (px)
- BalanceDisplay: shows USDC + B-Units (no props)
- AddUsdcHint: hint for adding USDC (no props)
Example: User says "balance" -> { type: "custom-ui", params: { ui: { schema: "beamio-ui-v1", root: { type: "Card", props: { title: "Balance" }, children: [{ type: "BalanceDisplay" }, { type: "ActionButton", props: { label: "Add USDC", actionType: "add-usdc" } }] } } } }
PREFER custom-ui to display AI-generated composite UI. For "balance", "add usdc", "how much" -> return custom-ui with Card + BalanceDisplay + ActionButton. Single actions (balance, add-usdc) only when user explicitly wants minimal.`
		const systemPrompt = `You are the Beamio wallet assistant. Return JSON action based on user intent.
Supported: pay, request, balance, fuel, add-usdc, history, contact, cashcode, card-topup, text, custom-ui, edit-profile, send-chat, generate-avatar-image.
pay needs to (@BeamioTag or address) and amount; request needs amount; text needs content. Return valid JSON only, no markdown.
${BEAMIO_INFRA_PROMPT}
${HISTORY_PROMPT}
${CONET_CHAT_PROMPT}
${PROFILE_EDIT_PROMPT}
${GENERATE_AVATAR_PROMPT}
${BEAMIO_SERVICE_CATALOG}
${UI_CATALOG_PROMPT}
IMPORTANT: Reply in the SAME language as the user. If user asks in English, use English for text content. If user asks in 中文, use 中文. Match the user's language for all text responses.${feedbackPrompt}`
		try {
			const ai = new GoogleGenAI({ apiKey })
			const history = Array.isArray(messages) ? messages : []
			const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [
				{ role: 'user', parts: [{ text: systemPrompt }] },
				...history.slice(-10).map((m) => ({
					role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
					parts: [{ text: m.content }],
				})),
				{ role: 'user', parts: [{ text: userText.trim() }] },
			]
			const response = await ai.models.generateContent({
				model: 'gemini-2.5-flash',
				contents,
				config: {
					responseMimeType: 'application/json' as const,
					responseSchema: BEAMIO_ACTION_SCHEMA,
				},
			})
			const text = (response as { text?: string })?.text?.trim()
			if (!text) {
				return res.status(502).json({ error: 'Empty response from AI' })
			}
			let action: Record<string, unknown>
			try {
				action = JSON.parse(text) as Record<string, unknown>
			} catch {
				logger(Colors.yellow('[ai/beamioAction] Invalid JSON from AI:'), text?.slice(0, 200))
				return res.status(502).json({ error: 'Invalid JSON from AI' })
			}
			if (!action || typeof action.type !== 'string' || typeof action.params !== 'object') {
				return res.status(502).json({ error: 'Invalid action structure from AI' })
			}
			// Sanitize custom-ui with empty/invalid root (AI sometimes returns root: {})
			if (action.type === 'custom-ui' && action.params && typeof action.params === 'object') {
				const params = action.params as Record<string, unknown>
				const ui = params.ui as Record<string, unknown> | undefined
				const root = ui?.root
				const isEmptyRoot = !root || (typeof root === 'object' && !('type' in root))
				if (ui && isEmptyRoot) {
					ui.root = { type: 'Card', props: { title: 'Balance' }, children: [{ type: 'BalanceDisplay' }, { type: 'ActionButton', props: { label: 'Add USDC', actionType: 'add-usdc' } }] }
				}
			}
			// Debug: 显示返回给 UI 的 action
			logger(Colors.cyan('[ai/beamioAction] DEBUG response action:'), JSON.stringify(action, null, 2))
			return res.status(200).json({ action })
		} catch (err: any) {
			logger(Colors.red('[ai/beamioAction] error:'), err?.message ?? err)
			return res.status(502).json({ error: err?.message ?? 'AI request failed' })
		}
	})

	/** GET /api/getNFTMetadata?card=0x&tokenId=...&nftSpecialMetadata=... - 返回指定 #NFT 的 metadata。30 秒缓存 */
	router.get('/getNFTMetadata', async (req, res) => {
		const { card, tokenId, nftSpecialMetadata } = req.query as { card?: string; tokenId?: string; nftSpecialMetadata?: string }
		if (!card || !ethers.isAddress(card) || !tokenId) {
			return res.status(400).json({ error: 'Invalid card or tokenId' })
		}
		const cacheKey = `${ethers.getAddress(card).toLowerCase()}:${tokenId}:${nftSpecialMetadata ?? ''}`
		const cached = getNFTMetadataCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		const tid = BigInt(tokenId)
		if (tid < ISSUED_NFT_START_ID) {
			return res.status(400).json({ error: 'tokenId must be >= ISSUED_NFT_START_ID (100000000000)' })
		}
		try {
			const cardContract = new ethers.Contract(card, BEAMIO_USER_CARD_ISSUED_NFT_ABI, providerBase)
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
			// 若 DB 有系列且 ipfsCid 有效，拉取 sharedSeriesMetadata 并与 nftSpecialMetadata 组装
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
		const body = JSON.stringify(out)
		getNFTMetadataCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
		res.status(200).json(out)
	} catch (err: any) {
		logger(Colors.red('[getNFTMetadata] error:'), err?.message ?? err)
		return res.status(500).json({ error: err?.message ?? 'Failed to fetch NFT metadata' })
	}
})

	/** GET /api/ownerNftSeries?owner=0x... - 返回 owner 钱包所有的 NFT 系列（含 sharedMetadataHash、ipfsCid） */
	router.get('/ownerNftSeries', async (req, res) => {
		const { owner } = req.query as { owner?: string }
		if (!owner || !ethers.isAddress(owner)) {
			return res.status(400).json({ error: 'Invalid owner address' })
		}
		const cacheKey = ethers.getAddress(owner).toLowerCase()
		const cached = ownerNftSeriesCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const items = await getOwnerNftSeries(owner, 100)
			const body = JSON.stringify({ items })
			ownerNftSeriesCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json({ items })
		} catch (err: any) {
			logger(Colors.red('[ownerNftSeries] error:'), err?.message ?? err)
			return res.status(500).json({ error: err?.message ?? 'Failed to fetch owner NFT series' })
		}
	})

	/** GET /api/seriesSharedMetadata?card=0x&tokenId=... - 从 IPFS 拉取并返回该系列的 sharedSeriesMetadata。30 秒缓存 */
	router.get('/seriesSharedMetadata', async (req, res) => {
		const { card, tokenId } = req.query as { card?: string; tokenId?: string }
		if (!card || !ethers.isAddress(card) || !tokenId) {
			return res.status(400).json({ error: 'Invalid card or tokenId' })
		}
		const cacheKey = `${ethers.getAddress(card).toLowerCase()}:${tokenId}`
		const cached = seriesSharedMetadataCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		const tid = BigInt(tokenId)
		if (tid < ISSUED_NFT_START_ID) {
			return res.status(400).json({ error: 'tokenId must be >= ISSUED_NFT_START_ID' })
		}
		try {
			const series = await getSeriesByCardAndTokenId(card, tokenId)
			if (!series?.ipfsCid) {
				return res.status(404).json({ error: 'Series not registered or no IPFS CID' })
			}
			const ipfsUrl = `https://ipfs.io/ipfs/${series.ipfsCid}`
			const ipfsRes = await fetch(ipfsUrl)
			if (!ipfsRes.ok) {
				return res.status(502).json({ error: 'Failed to fetch from IPFS' })
			}
			const sharedJson = await ipfsRes.json()
			const out = {
				cardAddress: series.cardAddress,
				tokenId: series.tokenId,
				sharedMetadataHash: series.sharedMetadataHash,
				ipfsCid: series.ipfsCid,
				metadata: series.metadata ?? null,
				sharedSeriesMetadata: sharedJson,
			}
			const body = JSON.stringify(out)
			seriesSharedMetadataCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json(out)
		} catch (err: any) {
			logger(Colors.red('[seriesSharedMetadata] error:'), err?.message ?? err)
			return res.status(500).json({ error: err?.message ?? 'Failed to fetch shared metadata' })
		}
	})

	/** registerSeries：cluster 预检格式，合格转发 master */
	router.post('/registerSeries', async (req, res) => {
		const { cardAddress, tokenId, sharedMetadataHash, ipfsCid, metadata } = req.body as {
			cardAddress?: string
			tokenId?: string
			sharedMetadataHash?: string
			ipfsCid?: string
			metadata?: Record<string, unknown>
		}
		if (!cardAddress || !ethers.isAddress(cardAddress) || !tokenId || !sharedMetadataHash || !ipfsCid) {
			return res.status(400).json({ error: 'Missing cardAddress, tokenId, sharedMetadataHash, or ipfsCid' })
		}
		logger(Colors.green('server /api/registerSeries preCheck OK, forwarding to master'))
		postLocalhost('/api/registerSeries', req.body, res)
	})

	/** registerMintMetadata：cluster 预检格式，合格转发 master */
	router.post('/registerMintMetadata', async (req, res) => {
		const { cardAddress, tokenId, ownerAddress, metadata } = req.body as {
			cardAddress?: string
			tokenId?: string
			ownerAddress?: string
			metadata?: Record<string, unknown>
		}
		if (!cardAddress || !ethers.isAddress(cardAddress) || !tokenId || !ownerAddress || !ethers.isAddress(ownerAddress) || !metadata || typeof metadata !== 'object') {
			return res.status(400).json({ error: 'Missing cardAddress, tokenId, ownerAddress, or metadata (object)' })
		}
		logger(Colors.green('server /api/registerMintMetadata preCheck OK, forwarding to master'))
		postLocalhost('/api/registerMintMetadata', req.body, res)
	})

	/** GET /api/mintMetadata?card=0x&tokenId=...&owner=0x... - cluster 直接处理读请求。30 秒缓存 */
	router.get('/mintMetadata', async (req, res) => {
		const { card, tokenId, owner } = req.query as { card?: string; tokenId?: string; owner?: string }
		if (!card || !ethers.isAddress(card) || !tokenId || !owner || !ethers.isAddress(owner)) {
			return res.status(400).json({ error: 'Invalid card, tokenId, or owner' })
		}
		const cacheKey = `${ethers.getAddress(card).toLowerCase()}:${tokenId}:${ethers.getAddress(owner).toLowerCase()}`
		const cached = mintMetadataCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const items = await getMintMetadataForOwner(card, tokenId, owner)
			const body = JSON.stringify({ items })
			mintMetadataCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json({ items })
		} catch (err: any) {
			logger(Colors.red('[mintMetadata] error:'), err?.message ?? err)
			return res.status(500).json({ error: err?.message ?? 'Failed to fetch mint metadata' })
		}
	})
	router.post('/addUser', async (req,res) => {
		const { accountName, wallet, recover, image, isUSDCFaucet, darkTheme, isETHFaucet, firstName, lastName, pgpKeyID, pgpKey, signMessage } = req.body as {
			accountName?: string
			wallet?: string
			recover?: IAccountRecover[]
			image?: string
			isUSDCFaucet?: boolean
			darkTheme?: boolean
			isETHFaucet?: boolean
			firstName?: string
			lastName?: string
			pgpKeyID?: string
			pgpKey?: string
			signMessage?: string
		}

		const trimmed = accountName?.trim().replace('@','')
		if (!trimmed || !/^[a-zA-Z0-9_\.]{3,20}$/.test(trimmed) || !ethers.isAddress(wallet) || wallet === ethers.ZeroAddress || !signMessage || signMessage?.trim() === '') {
			return res.status(400).json({ error: "Invalid data format" })
		}

		const isValid = checkSign(wallet, signMessage, wallet)
		
		if (!isValid) {
			return  res.status(400).json({ error: "Signature verification failed!" })
		}

		const ownship = await userOwnershipCheck(trimmed, wallet)
		if (!ownship) {
			return res.status(400).json({ error: "Wallet & accountName ownership Error!" })
		}

		const obj = {
			accountName: trimmed,
			wallet: wallet.toLowerCase(),
			recover: recover || [],
			image: image?.trim() || '',
			isUSDCFaucet: typeof isUSDCFaucet === 'boolean' ? isUSDCFaucet : false,
			darkTheme: typeof darkTheme === 'boolean' ? darkTheme : false,
			isETHFaucet: typeof isETHFaucet === 'boolean' ? isETHFaucet : false,
			firstName: firstName?.trim() || '',
			lastName: lastName?.trim() || '',
			pgpKeyID: typeof pgpKeyID === 'string' ? pgpKeyID.trim() : '',
			pgpKey: typeof pgpKey === 'string' ? pgpKey.trim() : ''
		}
		
		postLocalhost ('/api/addUser', obj, res)
	})

	router.post('/addFollow', async (req,res) => {
		const { wallet, signMessage, followAddress } = req.body as {
			wallet?: string
			followAddress?: string
			signMessage?: string
		}

		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress || !signMessage || signMessage?.trim() === ''|| !ethers.isAddress(followAddress) || followAddress === ethers.ZeroAddress) {
			return res.status(400).json({ error: "Invalid data format" })
		}

		const isValid = checkSign(wallet, signMessage, wallet)
		
		if (!isValid||isValid === followAddress.toLowerCase()) {
			return  res.status(400).json({ error: "Signature verification failed!" })
		}
		const followCheck = await getFollowCheck(wallet, followAddress)
		if (followCheck === null) {
			return res.status(400).json({ error: "Follow check Error!" })
		}
		if (followCheck) {
			return res.status(200).json({ message: "Already following!" }).end()
		}

		
		const obj = {
			wallet: wallet.toLowerCase(),
			followAddress: followAddress.toLowerCase()
		}
		postLocalhost ('/api/addFollow', obj, res)

	})

	/** GET /api/getFollowStatus?wallet=0x&followAddress=0x... 30 秒缓存 */
	router.get('/getFollowStatus', async (req,res) => {
		const { wallet, followAddress } = req.query as {
			wallet?: string
			followAddress?: string
		}

		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress || !ethers.isAddress(followAddress) || followAddress === ethers.ZeroAddress) {
			return res.status(400).json({ error: "Invalid data format" })
		}
		const cacheKey = `${ethers.getAddress(wallet).toLowerCase()}:${ethers.getAddress(followAddress).toLowerCase()}`
		const cached = getFollowStatusCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		const followStatus = await FollowerStatus(wallet, followAddress)
		if (followStatus === null) {
			return res.status(400).json({ error: "Follow status check Error!" })
		}
		const body = JSON.stringify(followStatus)
		getFollowStatusCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
		return res.status(200).json(followStatus).end()
	})

	router.get('/coinbase-token', (req,res) => {
		return coinbaseToken(req, res)
	})

	router.get('/coinbase-offramp', (req,res) => {
		return coinbaseOfframp(req, res)
	})

	router.post('/removeFollow', async (req,res) => {
		const { wallet, signMessage, followAddress } = req.body as {
			wallet?: string
			followAddress?: string
			signMessage?: string
		}

		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress || !signMessage || signMessage?.trim() === ''|| !ethers.isAddress(followAddress) || followAddress === ethers.ZeroAddress) {
			return res.status(400).json({ error: "Invalid data format" })
		}

		const isValid = checkSign(wallet, signMessage, wallet)
		
		if (!isValid||isValid === followAddress.toLowerCase()) {
			return  res.status(400).json({ error: "Signature verification failed!" })
		}
		const followCheck = await getFollowCheck(wallet, followAddress)
		if (followCheck === null) {
			return res.status(400).json({ error: "Follow check Error!" })
		}

		if (!followCheck) {
			return res.status(200).json({ message: "Have not following!" }).end()
		}

		
		const obj = {
			wallet: wallet.toLowerCase(),
			followAddress: followAddress.toLowerCase()
		}
		postLocalhost ('/api/removeFollow', obj, res)

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

	/** Cluster 直接返回本地缓存的 oracle（每 1 分钟从 master 更新），不再读链 */
	router.get('/getOracle', (_req, res) => {
		res.status(200).json(clusterOracleCache).end()
	})

	/** GET /api/BeamioTransfer - x402 EOA 转账。Cluster 直接处理（含预检 currency/currencyAmount 必填），不转发 master */
	router.get('/BeamioTransfer', (req, res) => BeamioTransfer(req, res))

	router.post('/purchasingCard', async (req,res) => {
		const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore } = req.body as {
			cardAddress?: string
			userSignature?: string
			nonce?: string
			usdcAmount?: string
			from?: string
			validAfter?: string
			validBefore?: string
		}

		if (!cardAddress || !userSignature || !nonce  || !usdcAmount || !from || !validBefore) {
			logger(`server /api/purchasingCard Invalid data format!`, inspect(req.body, false, 3, true))
			return res.status(400).json({ error: "Invalid data format" })
		}

		const ret = await purchasingCard(cardAddress, userSignature, nonce, usdcAmount, from, validAfter||'0', validBefore)
		if (!ret||!(ret as { success: boolean }).success) {
			logger(`server /api/purchasingCard failed!`, inspect(ret, false, 3, true))
			return res.status(400).json(ret).end()
		}

		// 集群侧数据预检：链上只读校验，通过后把 preChecked 带给 master。若预检失败（如 Oracle 未配置）则回退：不带 preChecked 转发，由 master 自行校验
		const preCheck = await purchasingCardPreCheck(cardAddress, usdcAmount, from)
		const isOracleOrQuoteError = preCheck.success ? false : /unitPriceUSDC6|oracle not configured|quotePointsForUSDC|QuoteHelper/i.test(preCheck.error)

		if (!preCheck.success) {
			if (isOracleOrQuoteError) {
				logger(Colors.yellow(`server /api/purchasingCard preCheck skipped (oracle/quote): ${preCheck.error} -> forward to master without preChecked`))
				// 集群链上 Oracle/报价未配置时，仍转发给 master，master 用自身配置完成校验与发交易
			} else {
				logger(Colors.red(`server /api/purchasingCard preCheck FAIL: ${preCheck.error}`))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
		}

		postLocalhost ('/api/purchasingCard', {
			cardAddress,
			userSignature,
			nonce,
			usdcAmount,
			from,
			validAfter,
			validBefore,
			...(preCheck.success && preCheck.preChecked && { preChecked: preCheck.preChecked })
		}, res)

		logger(preCheck.success ? `server /api/purchasingCard preCheck OK, forwarded to master` : `server /api/purchasingCard forwarded to master (no preChecked)`, inspect({ cardAddress, from, usdcAmount, hasPreChecked: !!preCheck.success }, false, 3, true))
	})

	/** createCard：集群预检 JSON + AA→EOA 替换，不合格 400，合格转发 master。master 不预检，直接推 createCardPool。*/
	router.post('/createCard', async (req, res) => {
		const body = req.body as {
			cardOwner?: string
			currency?: string
			unitPriceHuman?: string | number
			priceInCurrencyE6?: string | number
			uri?: string
			shareTokenMetadata?: { name?: string; description?: string; image?: string }
			tiers?: Array<{ index: number; minUsdc6: string; attr: number; tierExpirySeconds?: number; name?: string; description?: string; image?: string; backgroundColor?: string; upgradeByBalance?: boolean }>
		}
		const preCheck = createCardPreCheck(body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/createCard preCheck FAIL: ${preCheck.error}`), inspect(body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		const originalCardOwner = preCheck.preChecked.cardOwner
		const resolveResult = await resolveCardOwnerToEOA(providerBase, originalCardOwner)
		if (!resolveResult.success) {
			logger(Colors.red(`server /api/createCard AA→EOA resolve FAIL: ${resolveResult.error}`))
			return res.status(400).json({ success: false, error: resolveResult.error }).end()
		}
		preCheck.preChecked.cardOwner = resolveResult.cardOwner
		if (ethers.getAddress(resolveResult.cardOwner) !== ethers.getAddress(originalCardOwner)) {
			logger(Colors.cyan(`server /api/createCard cardOwner was AA, replaced with EOA: ${resolveResult.cardOwner}`))
		}
		logger(Colors.green(`server /api/createCard preCheck OK, forwarding to master`), inspect({ cardOwner: preCheck.preChecked.cardOwner, currency: preCheck.preChecked.currency }, false, 2, true))
		postLocalhost('/api/createCard', preCheck.preChecked, res)
	})

	/** cardCreateRedeem：集群预检，合格转发 master。master 使用 executeForOwnerPool + Settle_ContractPool 排队处理。默认 createRedeemBatch（多 hash array）*/
	router.post('/cardCreateRedeem', async (req, res) => {
		const preCheck = await cardCreateRedeemPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardCreateRedeem preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardCreateRedeem preCheck OK, forwarding to master`), inspect({ cardAddress: preCheck.preChecked.cardAddress }, false, 2, true))
		postLocalhost('/api/cardCreateRedeem', preCheck.preChecked, res)
	})

	/** cardAddAdmin：owner 添加 admin。Cluster 预检 data 为 addAdmin、newAdmin 为 EOA（非 AA），合格转发 master executeForOwner */
	router.post('/cardAddAdmin', async (req, res) => {
		const preCheck = await cardAddAdminPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardAddAdmin preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardAddAdmin preCheck OK, forwarding to master executeForOwner`), inspect({ cardAddress: req.body?.cardAddress }, false, 2, true))
		postLocalhost('/api/executeForOwner', req.body, res)
	})

	/** cardCreateIssuedNft：owner 定义新发行 NFT 类型。Cluster 预检 data 为 createIssuedNft、maxSupply>0、日期合法、card 存在，合格转发 master executeForOwner，Master 代付 gas 上链 */
	router.post('/cardCreateIssuedNft', async (req, res) => {
		const preCheck = await cardCreateIssuedNftPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardCreateIssuedNft preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardCreateIssuedNft preCheck OK, forwarding to master executeForOwner`), inspect({ cardAddress: req.body?.cardAddress }, false, 2, true))
		postLocalhost('/api/executeForOwner', req.body, res)
	})

	/** cardRedeem：用户兑换 redeem 码，转发 master */
	router.post('/cardRedeem', async (req, res) => {
		const { cardAddress, redeemCode, toUserEOA } = req.body || {}
		if (!cardAddress || !redeemCode || !toUserEOA || !ethers.isAddress(cardAddress) || !ethers.isAddress(toUserEOA)) {
			return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, toUserEOA' })
		}
		logger(Colors.green(`server /api/cardRedeem forwarding to master`), { cardAddress, toUserEOA })
		postLocalhost('/api/cardRedeem', req.body, res)
	})

	/** redeemStatusBatch：批量查询 redeem 状态（只支持批量）。30 秒缓存。兼容旧 CCSA 地址自动映射到新地址。 */
	router.post('/redeemStatusBatch', async (req, res) => {
		const { items } = req.body || {}
		if (!Array.isArray(items) || items.length === 0) {
			return res.status(400).json({ success: false, error: 'items required (non-empty array of { cardAddress, hash })' })
		}
		const valid = items
			.filter((it: any) => it && it.cardAddress && it.hash)
			.map((it: any) => ({
				cardAddress: OLD_CCSA_REDIRECTS.includes(it.cardAddress?.toLowerCase()) ? BASE_CCSA_CARD_ADDRESS : it.cardAddress,
				hash: it.hash
			}))
		if (valid.length === 0) {
			return res.status(400).json({ success: false, error: 'Each item must have cardAddress and hash' })
		}
		const cacheKey = JSON.stringify(valid.map((it: any) => ({ c: it.cardAddress.toLowerCase(), h: it.hash })).sort((a: any, b: any) => (a.c + a.h).localeCompare(b.c + b.h)))
		const cached = redeemStatusBatchCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const statuses = await getRedeemStatusBatchApi(valid)
			const body = JSON.stringify({ success: true, statuses })
			redeemStatusBatchCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			return res.status(200).json({ success: true, statuses }).end()
		} catch (e: any) {
			logger(Colors.red(`[redeemStatusBatch] error:`), e?.message ?? e)
			return res.status(500).json({ success: false, error: e?.message ?? 'Redeem status query failed' }).end()
		}
	})

	router.post('/executeForOwner', async (req, res) => {
		const { cardAddress, data, deadline, nonce, ownerSignature } = req.body as {
			cardAddress?: string
			data?: string
			deadline?: number
			nonce?: string
			ownerSignature?: string
		}
		if (!cardAddress || !data || deadline == null || !nonce || !ownerSignature) {
			logger(Colors.red(`server /api/executeForOwner Invalid data`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: 'Missing required fields' })
		}
		if (!ethers.isAddress(cardAddress)) {
			return res.status(400).json({ success: false, error: 'Invalid cardAddress' })
		}
		logger(Colors.green(`server /api/executeForOwner forwarding to master`), inspect({ cardAddress }, false, 2, true))
		postLocalhost('/api/executeForOwner', req.body, res)
	})

	/** AA→EOA：支持三种提交。(1) packedUserOp；(2) openContainerPayload；(3) containerPayload（绑定 to）*/
	router.post('/AAtoEOA', async (req, res) => {
		// 入口数据检测：将 BigInt 转为 string，避免 downstream RPC / JSON 序列化错误
		const body = convertBigIntToString(req.body) as {
			toEOA?: string
			amountUSDC6?: string
			packedUserOp?: import('../MemberCard').AAtoEOAUserOp
			openContainerPayload?: import('../MemberCard').OpenContainerRelayPayload
			containerPayload?: import('../MemberCard').ContainerRelayPayload
			currency?: string | string[]
			currencyAmount?: string | string[]
			currencyDiscount?: string | string[]
			currencyDiscountAmount?: string | string[]
			forText?: string
			requestHash?: string
			validDays?: number | string
		}
		logger(`[AAtoEOA] [DEBUG] Cluster received bodyKeys=${Object.keys(req.body || {}).join(',')} openContainer=${!!body?.openContainerPayload} requestHash=${body?.requestHash ?? 'n/a'} forText=${body?.forText ? `"${String(body.forText).slice(0, 50)}…"` : 'n/a'}`)
		logger(`[AAtoEOA] server received POST /api/AAtoEOA`, inspect({ bodyKeys: Object.keys(req.body || {}), toEOA: body?.toEOA, amountUSDC6: body?.amountUSDC6, sender: body?.packedUserOp?.sender, openContainer: !!body?.openContainerPayload, container: !!body?.containerPayload, requestHash: body?.requestHash ?? 'n/a' }, false, 3, true))
		if (body?.openContainerPayload) {
			logger(Colors.cyan(`[AAtoEOA] [DEBUG] openContainerPayload JSON (for debug): ${JSON.stringify(body.openContainerPayload)}`))
		}

		if (body.containerPayload) {
			const preCheck = ContainerRelayPreCheck(body.containerPayload)
			if (!preCheck.success) {
				logger(Colors.red(`[AAtoEOA] server Container pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			// Cluster 预检：currency/currencyAmount 必填（显式参数，不再依赖 payMe JSON）
			if (!body.currency || !String(body.currency).trim()) {
				logger(Colors.red(`[AAtoEOA] server Container REJECT: currency is required`))
				return res.status(400).json({ success: false, error: 'currency is required for accounting' }).end()
			}
			if (!body.currencyAmount || (Array.isArray(body.currencyAmount) ? body.currencyAmount.length === 0 : !String(body.currencyAmount).trim())) {
				logger(Colors.red(`[AAtoEOA] server Container REJECT: currencyAmount is required`))
				return res.status(400).json({ success: false, error: 'currencyAmount is required for accounting' }).end()
			}
			const reqHashValid = body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined
			if (reqHashValid && body.containerPayload?.to && ethers.isAddress(body.containerPayload.to)) {
				const vd = body.validDays != null ? Math.max(1, Math.floor(Number(body.validDays))) : 1
				const reqCheck = await runRequestHashPreCheck(reqHashValid, vd, body.containerPayload.to)
				if (!reqCheck.ok) {
					logger(Colors.yellow(`[AAtoEOA] Cluster requestHash pre-check FAIL: ${reqCheck.error}`))
					return res.status(403).json({ success: false, error: reqCheck.error, rejected: true }).end()
				}
			}
			logger(Colors.green(`[AAtoEOA] server Container pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
			postLocalhost('/api/AAtoEOA', {
				containerPayload: body.containerPayload,
				currency: body.currency,
				currencyAmount: body.currencyAmount,
				currencyDiscount: body.currencyDiscount,
				currencyDiscountAmount: body.currencyDiscountAmount,
				forText: body.forText,
				requestHash: body.requestHash,
				validDays: body.validDays,
			}, res)
			return
		}

		if (body.openContainerPayload) {
			const preCheck = OpenContainerRelayPreCheck(body.openContainerPayload)
			if (!preCheck.success) {
				logger(Colors.red(`[AAtoEOA] server OpenContainer pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			const itemsLength = body.openContainerPayload.items?.length ?? 0
			// Cluster 预检：currency/currencyAmount 必填（显式参数）
			if (itemsLength <= 1) {
				if (!body.currency || !String(Array.isArray(body.currency) ? body.currency[0] : body.currency).trim()) {
					logger(Colors.red(`[AAtoEOA] server OpenContainer REJECT: currency is required`))
					return res.status(400).json({ success: false, error: 'currency is required for accounting' }).end()
				}
				if (!body.currencyAmount || (Array.isArray(body.currencyAmount) ? !String(body.currencyAmount[0]).trim() : !String(body.currencyAmount).trim())) {
					logger(Colors.red(`[AAtoEOA] server OpenContainer REJECT: currencyAmount is required`))
					return res.status(400).json({ success: false, error: 'currencyAmount is required for accounting' }).end()
				}
			}
			if (itemsLength > 1) {
				if (!body.currency || !body.currencyAmount) {
					const error = `When items.length > 1, currency and currencyAmount are required`
					logger(Colors.red(`[AAtoEOA] server OpenContainer currency validation FAIL: ${error}`))
					return res.status(400).json({ success: false, error }).end()
				}
				const currencyIsArray = Array.isArray(body.currency)
				const currencyAmountIsArray = Array.isArray(body.currencyAmount)
				if (!currencyIsArray || !currencyAmountIsArray) {
					const error = `When items.length > 1, currency and currencyAmount must be arrays with the same length. Got items.length=${itemsLength}, currency is array=${currencyIsArray}, currencyAmount is array=${currencyAmountIsArray}`
					logger(Colors.red(`[AAtoEOA] server OpenContainer currency validation FAIL: ${error}`))
					return res.status(400).json({ success: false, error }).end()
				}
				const currencyArray = body.currency as unknown as string[]
				const currencyAmountArray = body.currencyAmount as unknown as string[]
				if (currencyArray.length !== itemsLength || currencyAmountArray.length !== itemsLength) {
					const error = `currency and currencyAmount arrays must have the same length as items. Got items.length=${itemsLength}, currency.length=${currencyArray.length}, currencyAmount.length=${currencyAmountArray.length}`
					logger(Colors.red(`[AAtoEOA] server OpenContainer currency length validation FAIL: ${error}`))
					return res.status(400).json({ success: false, error }).end()
				}
			}
			const reqHashValid = body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined
			if (reqHashValid && body.openContainerPayload?.to && ethers.isAddress(body.openContainerPayload.to)) {
				const vd = body.validDays != null ? Math.max(1, Math.floor(Number(body.validDays))) : 1
				const reqCheck = await runRequestHashPreCheck(reqHashValid, vd, body.openContainerPayload.to)
				if (!reqCheck.ok) {
					logger(Colors.yellow(`[AAtoEOA] Cluster requestHash pre-check FAIL: ${reqCheck.error}`))
					return res.status(403).json({ success: false, error: reqCheck.error, rejected: true }).end()
				}
			}
			logger(Colors.green(`[AAtoEOA] server OpenContainer pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
			postLocalhost('/api/AAtoEOA', {
				openContainerPayload: body.openContainerPayload,
				currency: body.currency,
				currencyAmount: body.currencyAmount,
				currencyDiscount: body.currencyDiscount,
				currencyDiscountAmount: body.currencyDiscountAmount,
				forText: body.forText,
				requestHash: body.requestHash,
				validDays: body.validDays,
			}, res)
			return
		}

		const { toEOA, amountUSDC6, packedUserOp } = body
		const preCheck = AAtoEOAPreCheck(toEOA ?? '', amountUSDC6 ?? '', packedUserOp)
		if (!preCheck.success) {
			logger(Colors.red(`[AAtoEOA] server pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		const senderCheck = await AAtoEOAPreCheckSenderHasCode(packedUserOp!)
		if (!senderCheck.success) {
			logger(Colors.red(`[AAtoEOA] server sender pre-check FAIL: ${senderCheck.error}`))
			return res.status(400).json({ success: false, error: senderCheck.error }).end()
		}
		if (body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 && toEOA && ethers.isAddress(toEOA)) {
			const vd = body.validDays != null ? Math.max(1, Math.floor(Number(body.validDays))) : 1
			const reqCheck = await runRequestHashPreCheck(body.requestHash, vd, toEOA)
			if (!reqCheck.ok) {
				logger(Colors.yellow(`[AAtoEOA] Cluster requestHash pre-check FAIL: ${reqCheck.error}`))
				return res.status(403).json({ success: false, error: reqCheck.error, rejected: true }).end()
			}
		}
		logger(Colors.green(`[AAtoEOA] server pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
		postLocalhost('/api/AAtoEOA', { toEOA, amountUSDC6, packedUserOp, requestHash: body.requestHash, validDays: body.validDays }, res)
	})

	/** regiestChatRoute：集群预检格式，合格转发 master。master 使用 beamio_ContractPool 排队并发处理。*/
	router.post('/regiestChatRoute', async (req, res) => {
		const { wallet, keyID, publicKeyArmored, encrypKeyArmored, routeKeyID } = req.body as {
			wallet?: string
			keyID?: string
			publicKeyArmored?: string
			encrypKeyArmored?: string
			routeKeyID?: string
		}
		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress) {
			logger(Colors.red(`server /api/regiestChatRoute Invalid wallet`), inspect(req.body, false, 2, true))
			return res.status(400).json({ ok: false, error: 'Invalid wallet' }).end()
		}
		if (!keyID || typeof keyID !== 'string' || keyID.trim() === '') {
			return res.status(400).json({ ok: false, error: 'Missing or invalid keyID' }).end()
		}
		if (!publicKeyArmored || typeof publicKeyArmored !== 'string' || publicKeyArmored.trim() === '') {
			return res.status(400).json({ ok: false, error: 'Missing or invalid publicKeyArmored' }).end()
		}
		if (!encrypKeyArmored || typeof encrypKeyArmored !== 'string' || encrypKeyArmored.trim() === '') {
			return res.status(400).json({ ok: false, error: 'Missing or invalid encrypKeyArmored' }).end()
		}
		if (!routeKeyID || typeof routeKeyID !== 'string' || routeKeyID.trim() === '') {
			return res.status(400).json({ ok: false, error: 'Missing or invalid routeKeyID' }).end()
		}
		logger(Colors.green(`server /api/regiestChatRoute preCheck OK, forwarding to master`), inspect({ wallet, keyID: keyID.slice(0, 16), routeKeyID }, false, 2, true))
		postLocalhost('/api/regiestChatRoute', {
			wallet: wallet.toLowerCase(),
			keyID: keyID.trim(),
			publicKeyArmored: publicKeyArmored.trim(),
			encrypKeyArmored: encrypKeyArmored.trim(),
			routeKeyID: routeKeyID.trim()
		}, res)
	})

	/** Beamio Pay Me 生成 request 记账：预检后转发 master（txCategory=request_create:confirmed） */
	router.post('/requestAccounting', async (req, res) => {
		const { requestHash, payee, amount, currency, forText, validDays } = req.body as {
			requestHash?: string
			payee?: string
			amount?: string
			currency?: string
			forText?: string
			validDays?: number
		}
		if (!requestHash || !payee || !amount || validDays == null) {
			logger(Colors.red(`[requestAccounting] server pre-check: missing required fields`), inspect(req.body, false, 2, true))
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
		logger(Colors.green(`[requestAccounting] server pre-check OK, forwarding to master`), inspect({ requestHash, payee, amount, validDays }, false, 2, true))
		postLocalhost('/api/requestAccounting', {
			requestHash: String(requestHash),
			payee: String(payee),
			amount: String(amount),
			currency: currency ? String(currency) : 'USD',
			forText: forText ? String(forText) : undefined,
			validDays: vd,
		}, res)
	})

	/** POST /api/cancelRequest - Payee 取消 Request。预检：格式 + 验签必须为原 request (Transaction) 的 payee，非 payee 不得 cancel */
	router.post('/cancelRequest', async (req, res) => {
		const { originalPaymentHash, payeeSignature } = req.body as { originalPaymentHash?: string; payeeSignature?: string }
		if (!originalPaymentHash || !payeeSignature) {
			logger(Colors.red(`[cancelRequest] server pre-check: missing originalPaymentHash or payeeSignature`))
			return res.status(400).json({ success: false, error: 'Missing originalPaymentHash or payeeSignature' }).end()
		}
		const preCheck = await cancelRequestPreCheck(String(originalPaymentHash), String(payeeSignature))
		if (!preCheck.success) {
			logger(Colors.red(`[cancelRequest] server pre-check FAIL: ${preCheck.error}`))
			return res.status(403).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`[cancelRequest] server pre-check OK (signature from payee), forwarding to master`), inspect({ originalPaymentHash: originalPaymentHash.slice(0, 10) + '…' }, false, 2, true))
		postLocalhost('/api/cancelRequest', { originalPaymentHash: String(originalPaymentHash), payeeSignature: String(payeeSignature) }, res)
	})

		/** beamioTransferIndexerAccounting：x402/AAtoEOA 成功后记账到 BeamioIndexerDiamond，预检后转发 master */
		router.post('/beamioTransferIndexerAccounting', async (req, res) => {
			const body = convertBigIntToString(req.body) as {
				from?: string
				to?: string
				amountUSDC6?: string
				finishedHash?: string
				displayJson?: string
				note?: string
				currency?: string
				currencyAmount?: string
				gasWei?: string
				gasUSDC6?: string
				gasChainType?: number
				feePayer?: string
				isInternalTransfer?: boolean
				requestHash?: string
				validDays?: number | string
			}
			if (!ethers.isAddress(body?.from) || !ethers.isAddress(body?.to)) {
				logger(Colors.red(`[beamioTransferIndexerAccounting] server pre-check FAIL: invalid from/to`))
				return res.status(400).json({ success: false, error: 'Invalid from or to address' }).end()
			}
			if (String(body.from).toLowerCase() === String(body.to).toLowerCase()) {
				logger(Colors.red(`[beamioTransferIndexerAccounting] server pre-check FAIL: from=to (payer=payee)`))
				return res.status(400).json({ success: false, error: 'from and to must be different (payer≠payee)' }).end()
			}
			if (!body?.amountUSDC6 || BigInt(body.amountUSDC6) <= 0n) {
				return res.status(400).json({ success: false, error: 'amountUSDC6 must be > 0' }).end()
			}
			if (!body?.finishedHash || !ethers.isHexString(body.finishedHash) || ethers.dataLength(body.finishedHash) !== 32) {
				return res.status(400).json({ success: false, error: 'finishedHash must be bytes32 tx hash' }).end()
			}
			const reqHashValid = body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined
			if (reqHashValid && body.to && ethers.isAddress(body.to)) {
				const vd = body.validDays != null ? Math.max(1, Math.floor(Number(body.validDays))) : 1
				const reqCheck = await runRequestHashPreCheck(reqHashValid, vd, body.to)
				if (!reqCheck.ok) {
					logger(Colors.yellow(`[beamioTransferIndexerAccounting] Cluster requestHash pre-check FAIL: ${reqCheck.error}`))
					return res.status(403).json({ success: false, error: reqCheck.error, rejected: true }).end()
				}
			}
			// Cluster 预检：currency/currencyAmount 必填（显式参数，不再依赖 payMe JSON）
			if (!body.currency || !String(body.currency).trim()) {
				logger(Colors.red(`[beamioTransferIndexerAccounting] REJECT: currency is required`))
				return res.status(400).json({ success: false, error: 'currency is required for accounting' }).end()
			}
			if (!body.currencyAmount || !String(body.currencyAmount).trim()) {
				logger(Colors.red(`[beamioTransferIndexerAccounting] REJECT: currencyAmount is required`))
				return res.status(400).json({ success: false, error: 'currencyAmount is required for accounting' }).end()
			}
			logger(Colors.green(`[beamioTransferIndexerAccounting] server pre-check OK, forwarding to master from=${body.from?.slice(0, 10)}… to=${body.to?.slice(0, 10)}… requestHash=${body.requestHash ?? 'n/a'}`))
			logger(Colors.gray(`[DEBUG] postLocalhost /api/beamioTransferIndexerAccounting`))
			postLocalhost('/api/beamioTransferIndexerAccounting', body, res)
		})

		/** GET /api/checkBUnitClaimEligibility?address=0x... - 检查是否可领取 BeamioBUnits，cluster 直接读 CoNET BUnitAirdrop */
		router.get('/checkBUnitClaimEligibility', async (req, res) => {
			const { address } = req.query as { address?: string }
			if (!address || !ethers.isAddress(address)) {
				return res.status(400).json({ canClaim: false, error: 'Invalid address' })
			}
			try {
				const airdrop = new ethers.Contract(CONET_BUNIT_AIRDROP_ADDRESS, ['function hasClaimed(address) view returns (bool)', 'function claimNonces(address) view returns (uint256)'], providerConet)
				const [hasClaimed, nonce] = await Promise.all([airdrop.hasClaimed(address), airdrop.claimNonces(address)])
				const canClaim = !hasClaimed
				const deadline = Math.floor(Date.now() / 1000) + 3600 // 1h from now
				res.status(200).json({ canClaim, nonce: String(nonce), deadline })
			} catch (e: any) {
				logger(Colors.red('[checkBUnitClaimEligibility] error:'), e?.message ?? e)
				res.status(500).json({ canClaim: false, error: e?.message ?? 'Failed to check eligibility' })
			}
		})

	/** POST /api/claimBUnits - 领取 BeamioBUnits，cluster 预检后转发 master，master 使用 Settle_ContractPool 执行 claimFor */
	router.post('/claimBUnits', async (req, res) => {
		const body = req.body as { claimant?: string; nonce?: unknown; deadline?: unknown; signature?: unknown }
		const preCheck = claimBUnitsPreCheck(body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/claimBUnits preCheck FAIL: ${preCheck.error}`))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green('server /api/claimBUnits preCheck OK, forwarding to master'))
		postLocalhost('/api/claimBUnits', preCheck.preChecked, res)
	})

	/** POST /api/purchaseBUnitFromBase - Refuel B-Unit：UI 离线签 EIP-3009，Cluster 预检后转发 Master，Master 提交 BaseTreasury.purchaseBUnitWith3009Authorization */
	router.post('/purchaseBUnitFromBase', async (req, res) => {
		const body = req.body as { from?: string; amount?: string; validAfter?: unknown; validBefore?: unknown; nonce?: string; signature?: string }
		const preCheck = purchaseBUnitFromBasePreCheck(body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/purchaseBUnitFromBase preCheck FAIL: ${preCheck.error}`))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		// Cluster 预检：Base 链上 USDC 余额
		try {
			const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
			const usdc = new ethers.Contract(USDC_BASE, ['function balanceOf(address) view returns (uint256)'], providerBase)
			const balance = await usdc.balanceOf(preCheck.preChecked.from)
			const amount = BigInt(preCheck.preChecked.amount)
			if (balance < amount) {
				logger(Colors.red(`server /api/purchaseBUnitFromBase balance FAIL: from=${preCheck.preChecked.from.slice(0, 10)}... balance=${balance} < amount=${amount}`))
				return res.status(400).json({ success: false, error: 'Insufficient USDC balance on Base' }).end()
			}
		} catch (e: any) {
			logger(Colors.red(`server /api/purchaseBUnitFromBase balance check error: ${e?.message ?? e}`))
			return res.status(502).json({ success: false, error: 'Failed to verify USDC balance' }).end()
		}
		logger(Colors.green(`server /api/purchaseBUnitFromBase preCheck OK from=${preCheck.preChecked.from.slice(0, 10)}... forwarding to master`))
		postLocalhost('/api/purchaseBUnitFromBase', preCheck.preChecked, res)
	})

	/** POST /api/removePOS - 商家 manager 离线签字删除 POS，Cluster 预检后转发 Master 代付 Gas */
	router.post('/removePOS', async (req, res) => {
		const { merchant, pos, deadline, nonce, signature } = req.body as {
			merchant?: string
			pos?: string
			deadline?: number
			nonce?: string
			signature?: string
		}
		if (!merchant || !ethers.isAddress(merchant.trim())) {
			return res.status(400).json({ success: false, error: 'Missing or invalid merchant address' })
		}
		if (!pos || !ethers.isAddress(pos.trim())) {
			return res.status(400).json({ success: false, error: 'Missing or invalid pos address' })
		}
		const now = Math.floor(Date.now() / 1000)
		if (typeof deadline !== 'number' || deadline <= now) {
			return res.status(400).json({ success: false, error: 'Deadline must be in the future' })
		}
		if (!nonce || typeof nonce !== 'string' || nonce.trim().length === 0) {
			return res.status(400).json({ success: false, error: 'Missing nonce' })
		}
		const sigHex = (signature || '').trim()
		if (!sigHex || !ethers.isHexString(sigHex)) {
			return res.status(400).json({ success: false, error: 'Missing or invalid signature (must be hex)' })
		}
		const sigLen = ethers.getBytes(sigHex).length
		if (sigLen !== 65 && sigLen !== 64) {
			return res.status(400).json({ success: false, error: `Invalid signature length: expected 64 or 65 bytes, got ${sigLen}` })
		}
		try {
			const domain = {
				name: 'MerchantPOSManagement',
				version: '1',
				chainId: 224400,
				verifyingContract: MERCHANT_POS_MANAGEMENT_CONET as `0x${string}`,
			}
			const types = {
				RemovePOS: [
					{ name: 'merchant', type: 'address' },
					{ name: 'pos', type: 'address' },
					{ name: 'deadline', type: 'uint256' },
					{ name: 'nonce', type: 'bytes32' },
				],
			}
			const message = {
				merchant: ethers.getAddress(merchant.trim()),
				pos: ethers.getAddress(pos.trim()),
				deadline: BigInt(deadline),
				nonce: nonce.startsWith('0x') ? nonce : '0x' + nonce,
			}
			const digest = ethers.TypedDataEncoder.hash(domain, types, message)
			const signer = ethers.recoverAddress(digest, sigHex)
			if (signer.toLowerCase() !== ethers.getAddress(merchant.trim()).toLowerCase()) {
				return res.status(403).json({ success: false, error: 'Signature does not recover to merchant' })
			}
		} catch (e: any) {
			logger(Colors.red(`[removePOS] signature verify failed: ${e?.message ?? e}`))
			return res.status(400).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'Invalid signature' })
		}
		logger(Colors.green(`[removePOS] Cluster preCheck OK merchant=${merchant.slice(0, 10)}... pos=${pos.slice(0, 10)}... forwarding to master`))
		postLocalhost('/api/removePOS', {
			merchant: ethers.getAddress(merchant.trim()),
			pos: ethers.getAddress(pos.trim()),
			deadline,
			nonce: nonce.startsWith('0x') ? nonce : '0x' + nonce,
			signature: sigHex,
		}, res)
	})

	/** GET /api/checkRequestStatus - 校验 Voucher 支付请求是否过期或已支付，转发 master */
	router.get('/checkRequestStatus', async (req, res) => {
		const { requestHash, validDays, payee } = req.query as { requestHash?: string; validDays?: string; payee?: string }
		if (!requestHash || validDays == null || validDays === '' || !payee) {
			return res.status(400).json({ error: 'Missing required: requestHash, validDays, payee' })
		}
		try {
			const qs = new URLSearchParams({ requestHash, validDays, payee }).toString()
			const path = '/api/checkRequestStatus?' + qs
			const { statusCode, body } = await getLocalhostBuffer(path)
			res.status(statusCode).setHeader('Content-Type', 'application/json').send(body)
		} catch (e: any) {
			logger(Colors.red('[checkRequestStatus] forward error:'), e?.message ?? e)
			res.status(502).json({ error: e?.message ?? 'Failed to check request status' })
		}
	})

	/** GET /api/myCards?owner=0x... - 30 秒内相同查询返回缓存，否则转发 master 并缓存 */
	router.get('/myCards', async (req, res) => {
		const { owner, owners } = req.query as { owner?: string; owners?: string }
		const addrs: string[] = []
		if (owner && ethers.isAddress(owner)) addrs.push(ethers.getAddress(owner).toLowerCase())
		if (owners && typeof owners === 'string') {
			for (const a of owners.split(',').map((s) => s.trim())) {
				if (a && ethers.isAddress(a)) addrs.push(ethers.getAddress(a).toLowerCase())
			}
		}
		addrs.sort()
		const cacheKey = addrs.length === 0 ? '' : addrs.join(',')
		if (cacheKey) {
			const cached = myCardsCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				res.status(cached.statusCode).setHeader('Content-Type', 'application/json').send(cached.body)
				return
			}
		}
		const qs = Object.keys(req.query || {}).length ? '?' + new URLSearchParams(req.query as Record<string, string>).toString() : ''
		const path = '/api/myCards' + qs
		try {
			const { statusCode, body } = await getLocalhostBuffer(path)
			if (cacheKey && statusCode === 200) {
				myCardsCache.set(cacheKey, { body, statusCode, expiry: Date.now() + MY_CARDS_CACHE_TTL_MS })
			}
			res.status(statusCode).setHeader('Content-Type', 'application/json').send(body)
		} catch (e: any) {
			logger(Colors.red('[myCards] forward error:'), e?.message ?? e)
			res.status(502).json({ error: e?.message ?? 'Failed to fetch my cards' })
		}
	})

	/** GET /api/getAAAccount?eoa=0x... - 30 秒内相同查询返回缓存，否则转发 master 并缓存 */
	router.get('/getAAAccount', async (req, res) => {
		const { eoa } = req.query as { eoa?: string }
		if (!eoa || !ethers.isAddress(eoa)) {
			return res.status(400).json({ error: 'Invalid eoa: require valid 0x address' })
		}
		const cacheKey = ethers.getAddress(eoa).toLowerCase()
		const cached = getAAAccountCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(cached.statusCode).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const path = '/api/getAAAccount?eoa=' + encodeURIComponent(eoa)
			const { statusCode, body } = await getLocalhostBuffer(path)
			getAAAccountCache.set(cacheKey, { body, statusCode, expiry: Date.now() + GET_AA_CACHE_TTL_MS })
			res.status(statusCode).setHeader('Content-Type', 'application/json').send(body)
		} catch (e: any) {
			logger(Colors.red('[getAAAccount] forward error:'), e?.message ?? e)
			res.status(502).json({ error: e?.message ?? 'Failed to fetch AA account' })
		}
	})

	/** GET /api/getBalance?address=0x... - 30 秒内相同查询返回缓存，否则转发 master 并缓存 */
	router.get('/getBalance', async (req, res) => {
		const { address } = req.query as { address?: string }
		if (!address || !ethers.isAddress(address)) {
			return res.status(400).json({ error: 'Invalid address: require valid 0x address' })
		}
		const cacheKey = ethers.getAddress(address).toLowerCase()
		const cached = getBalanceCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(cached.statusCode).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const path = '/api/getBalance?address=' + encodeURIComponent(address)
			const { statusCode, body } = await getLocalhostBuffer(path)
			getBalanceCache.set(cacheKey, { body, statusCode, expiry: Date.now() + GET_BALANCE_CACHE_TTL_MS })
			res.status(statusCode).setHeader('Content-Type', 'application/json').send(body)
		} catch (e: any) {
			logger(Colors.red('[getBalance] forward error:'), e?.message ?? e)
			res.status(502).json({ error: e?.message ?? 'Failed to fetch balance' })
		}
	})

	/** GET /api/getBUnitBalance?address=0x... - CoNET B-Unit 余额（total/free/paid），30 秒缓存。供前端绕过 CORS 获取。 */
	router.get('/getBUnitBalance', async (req, res) => {
		const { address } = req.query as { address?: string }
		if (!address || !ethers.isAddress(address)) {
			return res.status(400).json({ error: 'Invalid address: require valid 0x address' })
		}
		const cacheKey = ethers.getAddress(address).toLowerCase()
		const cached = getBUnitBalanceCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(cached.statusCode).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const CONET_BUINT = '0x4A3E59519eE72B9Dcf376f0617fF0a0a5a1ef879'
			const buint = new ethers.Contract(CONET_BUINT, ['function balanceOfAll(address) view returns (uint256 total, uint256 free, uint256 paid)'], providerConet)
			const [total, free, paid] = await buint.balanceOfAll(address)
			const decimals = 6
			const data = {
				total: Number(total) / 10 ** decimals,
				free: Number(free) / 10 ** decimals,
				paid: Number(paid) / 10 ** decimals,
			}
			const body = JSON.stringify(data)
			getBUnitBalanceCache.set(cacheKey, { body, statusCode: 200, expiry: Date.now() + GET_BUNIT_CACHE_TTL_MS })
			res.status(200).setHeader('Content-Type', 'application/json').send(body)
		} catch (e: any) {
			logger(Colors.red('[getBUnitBalance] error:'), e?.message ?? e)
			res.status(502).json({ error: e?.message ?? 'Failed to fetch B-Unit balance' })
		}
	})

	/** GET /api/getBUnitLedger?address=0x... - CoNET B-Unit 记账明细，30 秒缓存。供前端绕过 CORS 获取。 */
	router.get('/getBUnitLedger', async (req, res) => {
		const { address } = req.query as { address?: string }
		if (!address || !ethers.isAddress(address)) {
			return res.status(400).json({ error: 'Invalid address: require valid 0x address' })
		}
		const cacheKey = ethers.getAddress(address).toLowerCase()
		const cached = getBUnitLedgerCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(cached.statusCode).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			const BEAMIO_INDEXER = '0x0DBDF27E71f9c89353bC5e4dC27c9C5dAe0cc612'
			const CONET_BUINT = '0x4A3E59519eE72B9Dcf376f0617fF0a0a5a1ef879'
			const INDEXER_ABI = ['function getAccountTransactionsPaged(address account, uint256 offset, uint256 limit) view returns ((bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, bool exists)[] page)']
			const TX_BUINT_CLAIM = ethers.keccak256(ethers.toUtf8Bytes('buintClaim'))
			const TX_BUINT_USDC = ethers.keccak256(ethers.toUtf8Bytes('buintUSDC'))
			const indexer = new ethers.Contract(BEAMIO_INDEXER, INDEXER_ABI, providerConet)
			const page = await indexer.getAccountTransactionsPaged(address, 0, 100)
			const accountLower = address.toLowerCase()
			const buintLower = CONET_BUINT.toLowerCase()
			const decimals = 6
			const entries: Array<{ id: string; title: string; subtitle: string; amount: number; time: string; timestamp: number; type: string; status: string; linkedUsdc: string; txHash: string; network: string; baseTxHash?: string }> = []
			const formatTime = (ts: number) => {
				const d = new Date(ts * 1000)
				const now = Date.now()
				const diff = now - ts * 1000
				if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`
				if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`
				if (diff < 48 * 60 * 60 * 1000) return 'Yesterday'
				return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
			}
			for (const tx of page) {
				if (!tx?.exists) continue
				const txCategory = String(tx.txCategory)
				const payer = String(tx.payer).toLowerCase()
				const payee = String(tx.payee).toLowerCase()
				const amountFiat6 = Number(tx.finalRequestAmountFiat6 ?? 0)
				const amountUSDC6 = Number(tx.finalRequestAmountUSDC6 ?? 0)
				const amountBUnits = Math.round(amountFiat6 / 10 ** decimals)
				const ts = Number(tx.timestamp ?? 0)
				const timeStr = ts ? formatTime(ts) : '—'
				const rawId = tx.id
				const txIdHex = typeof rawId === 'string' ? rawId : rawId != null ? '0x' + BigInt(rawId).toString(16).padStart(64, '0') : '0x'
				const txHashShort = txIdHex.length > 10 ? `${txIdHex.slice(0, 6)}...${txIdHex.slice(-4)}` : txIdHex
				const baseEntry = { time: timeStr, timestamp: ts, txHash: txHashShort, network: 'CoNET L1' as const, status: 'Completed' as const }
				if (txCategory === TX_BUINT_CLAIM && payee === accountLower) {
					entries.push({ ...baseEntry, id: txIdHex, title: 'BUnit Claim', subtitle: 'Free claim', amount: amountBUnits, type: 'reward', linkedUsdc: 'N/A' })
				} else if (txCategory === TX_BUINT_USDC && payee === accountLower) {
					const usdcAmount = amountUSDC6 > 0 ? amountUSDC6 / 10 ** decimals : amountBUnits / 100
					const usdcStr = usdcAmount > 0 ? `-${usdcAmount.toFixed(2)} USDC` : 'N/A'
					let baseTxHash: string | undefined
					try {
						const displayJson = (tx as { displayJson?: string })?.displayJson ?? ''
						if (displayJson) {
							const parsed = JSON.parse(displayJson) as { baseTxHash?: string }
							if (parsed?.baseTxHash && ethers.isHexString(parsed.baseTxHash)) baseTxHash = parsed.baseTxHash
						}
					} catch {}
					entries.push({ ...baseEntry, id: txIdHex, title: 'Fuel Yield (1:100)', subtitle: 'System Top-up', amount: amountBUnits, type: 'refuel', linkedUsdc: usdcStr, baseTxHash })
				} else if (payee === buintLower && payer === accountLower) {
					let baseTxHash: string | undefined
					try {
						const displayJson = (tx as { displayJson?: string })?.displayJson ?? ''
						if (displayJson) {
							const parsed = JSON.parse(displayJson) as { baseTxHash?: string }
							if (parsed?.baseTxHash && ethers.isHexString(parsed.baseTxHash)) baseTxHash = parsed.baseTxHash
						}
					} catch {}
					entries.push({
						...baseEntry,
						id: txIdHex,
						title: 'B-Unit Burn',
						subtitle: amountUSDC6 > 0 ? `Paid ${(amountUSDC6 / 10 ** decimals).toFixed(2)} USDC` : 'Gas / Fee',
						amount: -amountBUnits,
						type: amountUSDC6 > 0 ? 'fee' : 'gas',
						linkedUsdc: amountUSDC6 > 0 ? `${(amountUSDC6 / 10 ** decimals).toFixed(2)} USDC` : 'N/A',
						baseTxHash,
					})
				}
			}
			entries.sort((a, b) => b.timestamp - a.timestamp)
			const body = JSON.stringify(entries)
			getBUnitLedgerCache.set(cacheKey, { body, statusCode: 200, expiry: Date.now() + GET_BUNIT_CACHE_TTL_MS })
			res.status(200).setHeader('Content-Type', 'application/json').send(body)
		} catch (e: any) {
			logger(Colors.red('[getBUnitLedger] error:'), e?.message ?? e)
			res.status(502).json({ error: e?.message ?? 'Failed to fetch B-Unit ledger' })
		}
	})

	/** GET /api/cardMetadata?cardAddress=0x... - 返回该卡的 card_owner + metadata_json（DB beamio_cards），供前端 beamioApi 拉取用于 Passes 展示 */
	router.get('/cardMetadata', async (req, res) => {
		const { cardAddress } = req.query as { cardAddress?: string }
		logger(Colors.cyan(`[cardMetadata] GET cardAddress=${cardAddress ?? '(missing)'}`))
		if (!cardAddress || !ethers.isAddress(cardAddress)) {
			logger(Colors.yellow('[cardMetadata] 400: invalid or missing cardAddress'))
			return res.status(400).json({ error: 'Invalid cardAddress: require valid 0x address' })
		}
		const normalizedAddr = ethers.getAddress(cardAddress).toLowerCase()
		logger(Colors.cyan(`[cardMetadata] normalized card_address=${normalizedAddr}, querying DB...`))
		try {
			const row = await getCardByAddress(cardAddress)
			if (!row) {
				logger(Colors.yellow(`[cardMetadata] 404: no row in beamio_cards for card_address=${normalizedAddr}`))
				return res.status(404).json({ error: 'Card not found' })
			}
			logger(Colors.green(`[cardMetadata] 200: card_owner=${row.cardOwner}`))
			res.setHeader('Content-Type', 'application/json')
			res.json({ cardOwner: row.cardOwner, metadata: row.metadata })
		} catch (err: any) {
			logger(Colors.red('[cardMetadata] 500 error:'), err?.message ?? err)
			return res.status(500).json({ error: 'Failed to fetch card metadata' })
		}
	})

	router.get('/deploySmartAccount', async (req,res) => {
		const { wallet, signMessage } = req.body as {
			wallet?: string
			signMessage?: string
		}

		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress || !signMessage || signMessage?.trim() === '') {
			return res.status(400).json({ error: "Invalid data format" })
		}

		const isValid = checkSign(wallet, signMessage, wallet)
		
		if (!isValid) {
			return  res.status(400).json({ error: "Signature verification failed!" })
		}

		return res.status(200).json({ message: "Smart account deployed!" }).end()
		// const aaAccount = await checkSmartAccount(wallet)

	})


	/** GET /api/getMyFollowStatus?wallet=0x... 30 秒缓存 */
	router.get('/getMyFollowStatus', async (req,res) => {
		const { wallet } = req.query as {
			wallet?: string
		}

		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress) {
			return res.status(400).json({ error: "Invalid data format" })
		}
		const cacheKey = ethers.getAddress(wallet).toLowerCase()
		const cached = getMyFollowStatusCache.get(cacheKey)
		if (cached && Date.now() < cached.expiry) {
			return res.status(200).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		const followStatus = await getMyFollowStatus(wallet)
		if (followStatus === null) {
			return res.status(400).json({ error: "Follow status check Error!" })
		}
		const body = JSON.stringify(followStatus)
		getMyFollowStatusCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
		return res.status(200).json(followStatus).end()
	})

	router.post('/coinbase-hooks', express.raw({ type: '*/*' }), async (req, res) => {
		const ret = await coinbaseHooks(req,res)
		if (!ret) {
			return logger(`/coinbase-hooks Error!`)
		}
		

	})




}

const initialize = async (reactBuildFolder: string, PORT: number) => {
	console.log('🔧 Initialize called with PORT:', PORT, 'reactBuildFolder:', reactBuildFolder)
	
	oracleBackoud(false)
	setTimeout(startClusterOracleSync, 3000)
	const defaultPath = join(__dirname, 'workers')
	

	const userDataPath = reactBuildFolder
	const updatedPath = join(userDataPath, 'workers')
	

	let staticFolder = fs.existsSync(updatedPath) ? updatedPath : defaultPath
	
	
	const isProd = process.env.NODE_ENV === "production";

	const app = express()
	app.set("trust proxy", true); 
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

	logger('Router stack:', router.stack.map(r => r.route?.path))


	logger(`🧭 public router after serverRoute(router)`)

	/** GET /metadata/:filename - 唯一统一约定（Base Explorer / EIP-1155）：
	 *  仅支持 0x{40hex}{suffix}.json，40hex = ERC-1155 合约（卡）地址，suffix = tokenId（十进制或 64 位十六进制）。
	 *  tokenId=0 返回卡级 metadata（getCardByAddress），否则返回该 NFT tier metadata（getNftTierMetadataByCardAndToken）。
	 *  兼容旧格式 0x{40hex}.json（40hex 视为 owner，getCardMetadataByOwner）用于卡级拉取。
	 */
	app.get('/metadata/:filename', async (req, res) => {
		const filename = req.params.filename
		// 格式 2/3：0x + 40 hex + (64 hex 或 十进制) + .json → 按 ERC-1155 约定，40hex 为合约（卡）地址
		const nftMetaMatch = filename.match(/^(0x[0-9a-fA-F]{40})([0-9a-fA-F]+)\.json$/)
		if (nftMetaMatch) {
			const cardAddress = nftMetaMatch[1]
			const suffix = nftMetaMatch[2]
			let tokenId: number
			if (suffix.length === 64 && /^[0-9a-fA-F]{64}$/.test(suffix)) {
				// EIP-1155 标准：64 位十六进制 tokenId（小写/无 0x 前缀）
				tokenId = Number(BigInt('0x' + suffix))
				if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
					return res.status(400).json({ error: 'Token ID from 64-hex out of safe range' })
				}
			} else if (/^[0-9]+$/.test(suffix)) {
				// 十进制 NFT#（如 101）
				tokenId = parseInt(suffix, 10)
				if (!Number.isInteger(tokenId) || tokenId < 0) {
					return res.status(400).json({ error: 'Invalid NFT number in filename' })
				}
			} else {
				return res.status(400).json({ error: 'Invalid NFT suffix (use 64 hex chars or decimal digits)' })
			}
			logger(Colors.cyan(`[metadata] GET filename=${filename} → cardAddress=${cardAddress} tokenId=${tokenId}`))
			try {
				if (tokenId === 0) {
					// tokenId 0 = 卡级 metadata（Base Explorer 约定，与 uri(0) 一致）
					const row = await getCardByAddress(cardAddress)
					if (!row?.metadata) {
						logger(Colors.yellow(`[metadata] tokenId=0: no card metadata for cardAddress=${cardAddress}`))
						return res.status(404).json({ error: 'Card metadata not found' })
					}
					const data = row.metadata as Record<string, unknown>
					const base = data?.shareTokenMetadata && typeof data.shareTokenMetadata === 'object' ? data.shareTokenMetadata as Record<string, unknown> : {}
					const out: Record<string, unknown> = { ...base }
					if (data?.tiers && Array.isArray(data.tiers) && data.tiers.length > 0) out.tiers = data.tiers
					const body = JSON.stringify(out)
					logger(Colors.green(`[metadata] tokenId=0 返回给 UI 的 JSON 长度=${body.length} 内容:`), body)
					res.setHeader('Content-Type', 'application/json')
					res.send(body)
					return
				}
				const data = await getNftTierMetadataByCardAndToken(cardAddress, tokenId)
				// 兼容旧数据：若按 card_address 无记录，尝试按 card_owner 查（sync 可能只写过 owner）
				let payload = data
				if (!payload) {
					const row = await getCardByAddress(cardAddress)
					if (row?.cardOwner) {
						payload = await getNftTierMetadataByOwnerAndToken(row.cardOwner, tokenId)
						if (payload) logger(Colors.gray(`[metadata] tokenId=${tokenId} 按 card_owner=${row.cardOwner} 回退查到`))
					}
				}
				if (!payload) {
					logger(Colors.yellow(`[metadata] tokenId=${tokenId}: DB 无记录 cardAddress=${cardAddress}`))
					return res.status(404).json({ error: 'NFT tier metadata not found' })
				}
				const body = JSON.stringify(payload)
				logger(Colors.green(`[metadata] tokenId=${tokenId} 返回给 UI 的 JSON 长度=${body.length} 内容:`), body)
				res.setHeader('Content-Type', 'application/json')
				res.send(body)
			} catch (err: any) {
				logger(Colors.red('[metadata] NFT tier read error:'), err?.message ?? err)
				return res.status(500).json({ error: 'Failed to read NFT tier metadata' })
			}
			return
		}
		// 格式 1：0x{40hex}.json
		if (!/^0x[0-9a-fA-F]{40}\.json$/.test(filename)) {
			return res.status(400).json({ error: 'Invalid metadata filename format (expected 0x{40hex}.json, 0x{40hex}{64hex}.json, or 0x{40hex}{NFT#}.json)' })
		}
		const owner = filename.slice(0, -5) // 去掉 .json
		try {
			const data = await getCardMetadataByOwner(owner)
			if (!data) {
				return res.status(404).json({ error: 'Metadata not found' })
			}
			const base = data.shareTokenMetadata && typeof data.shareTokenMetadata === 'object' ? data.shareTokenMetadata as Record<string, unknown> : {}
			const out: Record<string, unknown> = { ...base }
			if (data.tiers && Array.isArray(data.tiers) && data.tiers.length > 0) {
				out.tiers = data.tiers
			}
			res.setHeader('Content-Type', 'application/json')
			res.send(JSON.stringify(out))
		} catch (err: any) {
			logger(Colors.red('[metadata] read error:'), err?.message ?? err)
			return res.status(500).json({ error: 'Failed to read metadata' })
		}
	})

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

	
	const server = app.listen( PORT, () => {
		console.log('✅ Server started successfully!')
		console.table([
			{ 'x402 Server': `http://localhost:${PORT}`, 'Serving files from': staticFolder }
		])
	})

	server.on('error', (err: any) => {
		console.error('❌ Server error:', err)
	})

	return server
}

export const startServer = async () => {
	initialize('', serverPort)
}