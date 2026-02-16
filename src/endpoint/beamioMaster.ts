import express, { Request, Response, Router} from 'express'
import {getClientIp, oracleBackoud, getOracleRequest, masterSetup} from '../util'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import {addUser, addFollow, removeFollow, regiestChatRoute, ipfsDataPool, ipfsDataProcess, ipfsAccessPool, ipfsAccessProcess, getLatestCards, getOwnerNftSeries, getSeriesByCardAndTokenId, getMintMetadataForOwner, registerSeriesToDb, registerMintMetadataToDb, searchUsers, FollowerStatus, getMyFollowStatus} from '../db'
import {coinbaseHooks, coinbaseToken, coinbaseOfframp} from '../coinbase'
import { ethers } from 'ethers'
import { purchasingCardPool, purchasingCardProcess, createCardPool, createCardPoolPress, executeForOwnerPool, executeForOwnerProcess, cardRedeemPool, cardRedeemProcess, AAtoEOAPool, AAtoEOAProcess, OpenContainerRelayPool, OpenContainerRelayProcess, OpenContainerRelayPreCheck, ContainerRelayPool, ContainerRelayProcess, ContainerRelayPreCheck, type AAtoEOAUserOp, type OpenContainerRelayPayload, type ContainerRelayPayload } from '../MemberCard'
import { BASE_AA_FACTORY, BASE_CARD_FACTORY, BASE_CCSA_CARD_ADDRESS } from '../chainAddresses'

const masterServerPort = 1111

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
const BASE_RPC_URL = masterSetup?.base_endpoint || 'https://mainnet.base.org'

/** 通用查询缓存：30 秒协议 */
const QUERY_CACHE_TTL_MS = 30 * 1000
const searchHelpCache = new Map<string, { items: unknown[]; expiry: number }>()
const getNFTMetadataCache = new Map<string, { out: Record<string, unknown>; expiry: number }>()
const latestCardsCache = new Map<string, { items: unknown[]; expiry: number }>()
const getFollowStatusCache = new Map<string, { data: unknown; expiry: number }>()
const getMyFollowStatusCache = new Map<string, { data: unknown; expiry: number }>()
const ownerNftSeriesCache = new Map<string, { items: unknown[]; expiry: number }>()
const seriesSharedMetadataCache = new Map<string, { data: unknown; expiry: number }>()
const mintMetadataCache = new Map<string, { items: unknown[]; expiry: number }>()

const routing = ( router: Router ) => {

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

		/** 最新发行的前 N 张卡明细。30 秒缓存 */
		router.get('/latestCards', async (_req, res) => {
			const limit = Math.min(parseInt(String(_req.query.limit || 20), 10) || 20, 100)
			const cacheKey = `limit:${limit}`
			const cached = latestCardsCache.get(cacheKey)
			if (cached && Date.now() < cached.expiry) {
				return res.status(200).json({ items: cached.items })
			}
			const items = await getLatestCards(limit)
			latestCardsCache.set(cacheKey, { items, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json({ items })
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

		/** GET /api/getAAAccount?eoa=0x... - 客户端 RPC 失败时由此获取 primaryAccountOf(EOA)。30 秒缓存。 */
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
				const aaFactory = new ethers.Contract(BASE_AA_FACTORY, ['function primaryAccountOf(address) view returns (address)'], provider)
				let account = await aaFactory.primaryAccountOf(eoa)
				if (account === ethers.ZeroAddress) {
					getAAAccountCache.set(cacheKey, { account: null, expiry: Date.now() + GET_AA_CACHE_TTL_MS })
					return res.status(200).json({ account: null })
				}
				const code = await provider.getCode(account)
				if (!code || code === '0x') {
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

		/** GET /api/seriesSharedMetadata - 从 IPFS 拉取 sharedSeriesMetadata。30 秒缓存 */
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
				if (!series?.ipfsCid) {
					return res.status(404).json({ error: 'Series not registered or no IPFS CID' })
				}
				const ipfsUrl = `https://ipfs.io/ipfs/${series.ipfsCid}`
				const ipfsRes = await fetch(ipfsUrl)
				if (!ipfsRes.ok) {
					return res.status(502).json({ error: 'Failed to fetch from IPFS' })
				}
				const sharedJson = await ipfsRes.json()
				const data = {
					cardAddress: series.cardAddress,
					tokenId: series.tokenId,
					sharedMetadataHash: series.sharedMetadataHash,
					ipfsCid: series.ipfsCid,
					metadata: series.metadata ?? null,
					sharedSeriesMetadata: sharedJson,
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

		/** POST /api/registerSeries - 登记 NFT 系列到 DB（cluster 预检后转发） */
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
					ipfsCid,
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

		/** 创建 BeamioUserCard。由 cluster 预检，master 不再预检，信任 cluster 数据。push createCardPool，daemon createCardPoolPress 上链后回传 hash，同时登记到本地 db。*/
		router.post('/createCard', (req, res) => {
			const raw = req.body as {
				cardOwner: string
				currency: 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD'
				priceInCurrencyE6?: string
				unitPriceHuman?: string | number
				uri?: string
				shareTokenMetadata?: { name?: string; description?: string; image?: string }
				tiers?: Array<{ index: number; minUsdc6: string; attr: number; name?: string; description?: string }>
			}
			let priceInCurrencyE6: string
			if (raw.priceInCurrencyE6 != null && raw.priceInCurrencyE6 !== '') {
				priceInCurrencyE6 = String(raw.priceInCurrencyE6)
			} else if (raw.unitPriceHuman != null && raw.unitPriceHuman !== '') {
				const n = parseFloat(String(raw.unitPriceHuman))
				if (!Number.isFinite(n) || n <= 0) {
					return res.status(400).json({ success: false, error: 'unitPriceHuman must be > 0' })
				}
				priceInCurrencyE6 = String(BigInt(Math.round(n * 1_000_000)))
			} else {
				return res.status(400).json({ success: false, error: 'Missing priceInCurrencyE6 or unitPriceHuman' })
			}
			const body = { ...raw, priceInCurrencyE6 }
			createCardPool.push({ ...body, res })
			logger(Colors.cyan(`[createCard] pushed to pool, cardOwner=${body.cardOwner}`))
			createCardPoolPress()
		})

		router.post('/purchasingCard', (req, res) => {
			const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, preChecked } = req.body as {
				cardAddress: string
				userSignature: string
				nonce: string
				usdcAmount: string
				from: string
				validAfter: string
				validBefore: string
				preChecked?: import('../MemberCard').PurchasingCardPreChecked
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
				...(preChecked != null && { preChecked })
			})

			logger(` Master GOT /api/purchasingCard ${preChecked ? '[preChecked]' : ''} doing purchasingCardProcess...`, inspect({ cardAddress, from, usdcAmount, hasPreChecked: !!preChecked }, false, 3, true))
			purchasingCardProcess().catch((err: any) => {
				logger(Colors.red('[purchasingCardProcess] unhandled error (fire-and-forget):'), err?.message ?? err)
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

		/** cardRedeem：用户兑换 redeem 码，服务端 redeemForUser，点数 mint 到用户 AA */
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

		router.post('/executeForOwner', (req, res) => {
			const { cardAddress, data, deadline, nonce, ownerSignature, redeemCode, toUserEOA } = req.body as {
				cardAddress?: string
				data?: string
				deadline?: number
				nonce?: string
				ownerSignature?: string
				redeemCode?: string
				toUserEOA?: string
			}
			if (!cardAddress || !data || deadline == null || !nonce || !ownerSignature) {
				return res.status(400).json({ success: false, error: 'Missing required fields: cardAddress, data, deadline, nonce, ownerSignature' })
			}
			executeForOwnerPool.push({ cardAddress, data, deadline, nonce, ownerSignature, redeemCode, toUserEOA, res })
			logger(Colors.cyan(`[executeForOwner] pushed to pool, card=${cardAddress}`))
			executeForOwnerProcess().catch((err: any) => {
				logger(Colors.red('[executeForOwnerProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** AA→EOA：支持三种提交。(1) ERC-4337 UserOp → AAtoEOAProcess；(2) openContainerPayload → OpenContainerRelayProcess；(3) containerPayload（绑定 to）→ ContainerRelayProcess */
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
			}
			logger(`[AAtoEOA] master received POST /api/AAtoEOA`, inspect({ toEOA: body?.toEOA, amountUSDC6: body?.amountUSDC6, sender: body?.packedUserOp?.sender, openContainer: !!body?.openContainerPayload, container: !!body?.containerPayload }, false, 3, true))

			if (body.containerPayload) {
				const preCheck = ContainerRelayPreCheck(body.containerPayload)
				if (!preCheck.success) {
					logger(Colors.red(`[AAtoEOA] master Container validation FAIL: ${preCheck.error}`))
					return res.status(400).json({ success: false, error: preCheck.error ?? 'Invalid containerPayload' }).end()
				}
				const poolLenBefore = ContainerRelayPool.length
				ContainerRelayPool.push({
					containerPayload: body.containerPayload,
					currency: body.currency,
					currencyAmount: body.currencyAmount,
					currencyDiscount: body.currencyDiscount,
					currencyDiscountAmount: body.currencyDiscountAmount,
					res,
				})
				logger(`[AAtoEOA] master pushed to ContainerRelayPool (length ${poolLenBefore} -> ${ContainerRelayPool.length}), calling ContainerRelayProcess()`)
				ContainerRelayProcess().catch((err: any) => {
					logger(Colors.red('[ContainerRelayProcess] unhandled error:'), err?.message ?? err)
				})
				return
			}

			if (body.openContainerPayload) {
				const preCheck = OpenContainerRelayPreCheck(body.openContainerPayload)
				if (!preCheck.success) {
					logger(Colors.red(`[AAtoEOA] master OpenContainer validation FAIL: ${preCheck.error}`))
					return res.status(400).json({ success: false, error: preCheck.error ?? 'Invalid openContainerPayload' }).end()
				}
				const poolLenBefore = OpenContainerRelayPool.length
				OpenContainerRelayPool.push({
					openContainerPayload: body.openContainerPayload,
					currency: body.currency,
					currencyAmount: body.currencyAmount,
					currencyDiscount: body.currencyDiscount,
					currencyDiscountAmount: body.currencyDiscountAmount,
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
			const poolLenBefore = AAtoEOAPool.length
			AAtoEOAPool.push({
				toEOA: toEOA as string,
				amountUSDC6,
				packedUserOp: packedUserOp as AAtoEOAUserOp,
				res,
			})
			logger(`[AAtoEOA] master pushed to pool (length ${poolLenBefore} -> ${AAtoEOAPool.length}), calling AAtoEOAProcess()`)
			AAtoEOAProcess().catch((err: any) => {
				logger(Colors.red('[AAtoEOAProcess] unhandled error:'), err?.message ?? err)
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