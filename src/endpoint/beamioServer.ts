import express, { Request, Response, Router} from 'express'
import {getClientIp, oracleBackoud, checkSign} from '../util'
import { checkSmartAccount } from '../MemberCard'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import { ethers } from "ethers"
import {beamio_ContractPool, searchUsers, FollowerStatus, getMyFollowStatus, getLatestCards, getOwnerNftSeries, getSeriesByCardAndTokenId, getMintMetadataForOwner} from '../db'
import {coinbaseToken, coinbaseOfframp, coinbaseHooks} from '../coinbase'
import { purchasingCard, purchasingCardPreCheck, createCardPreCheck, AAtoEOAPreCheck, AAtoEOAPreCheckSenderHasCode, OpenContainerRelayPreCheck, ContainerRelayPreCheck, cardCreateRedeemPreCheck, getRedeemStatusBatchApi } from '../MemberCard'
import { masterSetup } from '../util'

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
	const conetRpc = new ethers.JsonRpcProvider('https://mainnet-rpc1.conet.network')
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
		console.error(`getReferrer req on Error! ${e.message}`)
		_res.status(502).end()
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

/** myCards 缓存：30 秒内相同查询直接返回，减轻 master 负荷 */
const MY_CARDS_CACHE_TTL_MS = 30 * 1000
const myCardsCache = new Map<string, { body: string; statusCode: number; expiry: number }>()

/** getAAAccount 缓存：30 秒 */
const GET_AA_CACHE_TTL_MS = 30 * 1000
const getAAAccountCache = new Map<string, { body: string; statusCode: number; expiry: number }>()

/** getBalance 缓存：30 秒 */
const GET_BALANCE_CACHE_TTL_MS = 30 * 1000
const getBalanceCache = new Map<string, { body: string; statusCode: number; expiry: number }>()

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

const routing = ( router: Router ) => {

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
		res.json(manifest)
	})
	
	router.get('/search-users', (req,res) => {
		searchUsers(req,res)
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

	/** createCard：集群预检 JSON，不合格 400，合格转发 master。master 不预检，直接推 createCardPool。*/
	router.post('/createCard', async (req, res) => {
		const body = req.body as {
			cardOwner?: string
			currency?: string
			unitPriceHuman?: string | number
			priceInCurrencyE6?: string | number
			uri?: string
			shareTokenMetadata?: { name?: string; description?: string; image?: string }
			tiers?: Array<{ index: number; minUsdc6: string; attr: number; name?: string; description?: string }>
		}
		const preCheck = createCardPreCheck(body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/createCard preCheck FAIL: ${preCheck.error}`), inspect(body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
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

	/** cardRedeem：用户兑换 redeem 码，转发 master */
	router.post('/cardRedeem', async (req, res) => {
		const { cardAddress, redeemCode, toUserEOA } = req.body || {}
		if (!cardAddress || !redeemCode || !toUserEOA || !ethers.isAddress(cardAddress) || !ethers.isAddress(toUserEOA)) {
			return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, toUserEOA' })
		}
		logger(Colors.green(`server /api/cardRedeem forwarding to master`), { cardAddress, toUserEOA })
		postLocalhost('/api/cardRedeem', req.body, res)
	})

	/** redeemStatusBatch：批量查询 redeem 状态（只支持批量）。30 秒缓存 */
	router.post('/redeemStatusBatch', async (req, res) => {
		const { items } = req.body || {}
		if (!Array.isArray(items) || items.length === 0) {
			return res.status(400).json({ success: false, error: 'items required (non-empty array of { cardAddress, hash })' })
		}
		const valid = items.filter((it: any) => it && it.cardAddress && it.hash)
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
		}
		logger(`[AAtoEOA] server received POST /api/AAtoEOA`, inspect({ bodyKeys: Object.keys(req.body || {}), toEOA: body?.toEOA, amountUSDC6: body?.amountUSDC6, sender: body?.packedUserOp?.sender, openContainer: !!body?.openContainerPayload, container: !!body?.containerPayload }, false, 3, true))

		if (body.containerPayload) {
			const preCheck = ContainerRelayPreCheck(body.containerPayload)
			if (!preCheck.success) {
				logger(Colors.red(`[AAtoEOA] server Container pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			logger(Colors.green(`[AAtoEOA] server Container pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
			postLocalhost('/api/AAtoEOA', {
				containerPayload: body.containerPayload,
				currency: body.currency,
				currencyAmount: body.currencyAmount,
				currencyDiscount: body.currencyDiscount,
				currencyDiscountAmount: body.currencyDiscountAmount,
			}, res)
			return
		}

		if (body.openContainerPayload) {
			const preCheck = OpenContainerRelayPreCheck(body.openContainerPayload)
			if (!preCheck.success) {
				logger(Colors.red(`[AAtoEOA] server OpenContainer pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			// 检查 items.length 和 currency/currencyAmount 的长度匹配
			const itemsLength = body.openContainerPayload.items?.length ?? 0
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
			logger(Colors.green(`[AAtoEOA] server OpenContainer pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
			postLocalhost('/api/AAtoEOA', {
				openContainerPayload: body.openContainerPayload,
				currency: body.currency,
				currencyAmount: body.currencyAmount,
				currencyDiscount: body.currencyDiscount,
				currencyDiscountAmount: body.currencyDiscountAmount,
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
		logger(Colors.green(`[AAtoEOA] server pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
		postLocalhost('/api/AAtoEOA', { toEOA, amountUSDC6, packedUserOp }, res)
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

	const METADATA_BASE = process.env.METADATA_BASE ?? '/home/peter/.data/metadata'
	const ISSUED_NFT_START_ID = 100_000_000_000n
	/** GET /metadata/:filename - 由 cluster 处理。0x{owner}.json：若 id < 100000000000 返回 shareTokenMetadata，否则返回完整 JSON。降低 master 负荷 */
	app.get('/metadata/:filename', (req, res) => {
		const filename = req.params.filename
		// 仅允许 0x{40hex}.json 或 {64hex}.json，防止路径穿越
		if (!/^(0x[0-9a-fA-F]{40}|[0-9a-f]{64})\.json$/.test(filename)) {
			return res.status(400).json({ error: 'Invalid metadata filename format' })
		}
		const filePath = resolve(METADATA_BASE, filename)
		const baseResolved = resolve(METADATA_BASE)
		if (!filePath.startsWith(baseResolved + '/') && filePath !== baseResolved) {
			return res.status(400).json({ error: 'Invalid path' })
		}
		try {
			const content = fs.readFileSync(filePath, 'utf-8')
			let data: Record<string, unknown>
			try {
				data = JSON.parse(content) as Record<string, unknown>
			} catch {
				res.setHeader('Content-Type', 'application/json')
				return res.send(content)
			}
			const tokenIdHex = filename.startsWith('0x') ? null : filename.replace(/\.json$/, '')
			const tokenId = tokenIdHex ? BigInt('0x' + tokenIdHex) : null
			const useShared = tokenId === null || tokenId < ISSUED_NFT_START_ID
			const shared = useShared && data && typeof data.shareTokenMetadata === 'object' && data.shareTokenMetadata !== null
			let out: Record<string, unknown>
			if (shared) {
				const base = data.shareTokenMetadata as Record<string, unknown>
				out = base ? { ...base } : {}
				if (data.tiers && Array.isArray(data.tiers) && data.tiers.length > 0) {
					out.tiers = data.tiers
				}
			} else {
				out = data
			}
			res.setHeader('Content-Type', 'application/json')
			res.send(JSON.stringify(out))
		} catch (err: any) {
			if (err?.code === 'ENOENT') {
				return res.status(404).json({ error: 'Metadata not found' })
			}
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