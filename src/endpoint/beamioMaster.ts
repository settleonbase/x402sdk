import express, { Request, Response, Router} from 'express'
import {getClientIp, oracleBackoud, getOracleRequest, masterSetup} from '../util'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import {addUser, addFollow, removeFollow, regiestChatRoute, ipfsDataPool, ipfsDataProcess, ipfsAccessPool, ipfsAccessProcess, getLatestCards, getOwnerNftSeries, getSeriesByCardAndTokenId, getMintMetadataForOwner, registerSeriesToDb, registerMintMetadataToDb, searchUsers, FollowerStatus, getMyFollowStatus, getNfcCardByUid, getNfcCardPrivateKeyByUid, registerNfcCardToDb} from '../db'
import {coinbaseHooks, coinbaseToken, coinbaseOfframp} from '../coinbase'
import { ethers } from 'ethers'
import { purchasingCardPool, purchasingCardProcess, purchasingCardPreCheck, createCardPool, createCardPoolPress, executeForOwnerPool, executeForOwnerProcess, executeForAdminPool, executeForAdminProcess, cardRedeemPool, cardRedeemProcess, AAtoEOAPool, AAtoEOAProcess, OpenContainerRelayPool, OpenContainerRelayProcess, OpenContainerRelayPreCheck, ContainerRelayPool, ContainerRelayProcess, ContainerRelayPreCheck, beamioTransferIndexerAccountingPool, beamioTransferIndexerAccountingProcess, requestAccountingPool, requestAccountingProcess, cancelRequestAccountingPool, cancelRequestAccountingProcess, claimBUnitsPool, claimBUnitsProcess, Settle_ContractPool, signUSDC3009ForNfcTopup, nfcTopupPreparePayload, type AAtoEOAUserOp, type OpenContainerRelayPayload, type ContainerRelayPayload } from '../MemberCard'
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

		/** GET /api/checkRequestStatus - 校验 Voucher 支付请求是否过期或已支付。用于 Smart Routing 及 beamioTransferIndexerAccounting 前置校验。 */
		const BEAMIO_INDEXER_ADDRESS = '0x0DBDF27E71f9c89353bC5e4dC27c9C5dAe0cc612'
		const CONET_RPC = 'https://mainnet-rpc1.conet.network'
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

		/** x402 BeamioTransfer 成功后：写入 BeamioIndexerDiamond（master 队列处理） */
		router.post('/beamioTransferIndexerAccounting', (req, res) => {
			logger(Colors.gray(`[DEBUG] beamioTransferIndexerAccounting received bodyKeys=${Object.keys(req.body || {}).join(',')} from=${(req.body as any)?.from?.slice?.(0, 10)}… to=${(req.body as any)?.to?.slice?.(0, 10)}… requestHash=${(req.body as any)?.requestHash ?? 'n/a'} poolBefore=${beamioTransferIndexerAccountingPool.length}`))
			const { from, to, amountUSDC6, finishedHash, displayJson, note, currency, currencyAmount, gasWei, gasUSDC6, gasChainType, feePayer, isInternalTransfer, requestHash } = req.body as {
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
				feePayer?: string
				isInternalTransfer?: boolean
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
				feePayer: String(feePayer),
				isInternalTransfer: !!isInternalTransfer,
				requestHash: reqHashValid,
				res,
			})
			logger(Colors.cyan(`[beamioTransferIndexerAccounting] pushed to pool from=${from} to=${to} amountUSDC6=${amountUSDC6} requestHash=${reqHashValid ?? 'n/a'} (raw=${requestHash ?? 'undefined'})`))
			beamioTransferIndexerAccountingProcess().catch((err: any) => {
				logger(Colors.red('[beamioTransferIndexerAccountingProcess] unhandled error:'), err?.message ?? err)
			})
		})

		/** Beamio Pay Me 生成 request 记账（txCategory=request_create:confirmed，originalPaymentHash=requestHash） */
		router.post('/requestAccounting', (req, res) => {
			const { requestHash, payee, amount, currency, forText, validDays } = req.body as {
				requestHash?: string
				payee?: string
				amount?: string
				currency?: string
				forText?: string
				validDays?: number
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
			}
			logger(`[AAtoEOA] [DEBUG] Master received openContainer=${!!body?.openContainerPayload} requestHash=${body?.requestHash ?? 'n/a'} forText=${body?.forText ? `"${String(body.forText).slice(0, 40)}…"` : 'n/a'} OpenContainerRelayPool.len=${OpenContainerRelayPool.length} Settle_ContractPool.len=${Settle_ContractPool.length}`)
			logger(`[AAtoEOA] master received POST /api/AAtoEOA`, inspect({ toEOA: body?.toEOA, amountUSDC6: body?.amountUSDC6, sender: body?.packedUserOp?.sender, openContainer: !!body?.openContainerPayload, container: !!body?.containerPayload, requestHash: body?.requestHash ?? 'n/a', forText: body?.forText ? `${body.forText.slice(0, 40)}…` : 'n/a' }, false, 3, true))

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
					forText: body.forText?.trim() || undefined,
					requestHash: body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined,
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
					forText: body.forText?.trim() || undefined,
					requestHash: body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined,
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

		/** POST /api/registerNfcCard - 登记 NFC 卡（uid + private_key），需鉴权（可后续添加） */
		router.post('/registerNfcCard', async (req, res) => {
			const { uid, privateKey } = req.body as { uid?: string; privateKey?: string }
			if (!uid || typeof uid !== 'string' || !privateKey || typeof privateKey !== 'string') {
				return res.status(400).json({ ok: false, error: 'Missing uid or privateKey' })
			}
			await registerNfcCardToDb({ uid: uid.trim(), privateKey: privateKey.trim() })
			return res.status(200).json({ ok: true }).end()
		})

		/** POST /api/payByNfcUid - 以 UID 支付：使用 NFC 卡私钥从卡 EOA 向 payee 转 USDC */
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
			const privateKey = await getNfcCardPrivateKeyByUid(uid)
			if (!privateKey) {
				return res.status(403).json({ success: false, error: '不存在该卡' })
			}
			try {
				const provider = new ethers.JsonRpcProvider(BASE_RPC_URL)
				const wallet = new ethers.Wallet(privateKey, provider)
				const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
				const usdcAbi = ['function transfer(address to, uint256 amount) returns (bool)']
				const usdc = new ethers.Contract(USDC_BASE, usdcAbi, wallet)
				const tx = await usdc.transfer(ethers.getAddress(payee), amountBig)
				await tx.wait()
				logger(Colors.green(`[payByNfcUid] uid=${uid.slice(0, 16)}... -> ${payee} amount=${amountUsdc6} tx=${tx.hash}`))
				return res.status(200).json({ success: true, USDC_tx: tx.hash }).end()
			} catch (e: any) {
				logger(Colors.red(`[payByNfcUid] failed: ${e?.message ?? e}`))
				return res.status(500).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'Transfer failed' }).end()
			}
		})

		/** POST /api/nfcTopupPrepare - 返回 executeForAdmin 所需的 cardAddr、data、deadline、nonce，供前端签名 */
		router.post('/nfcTopupPrepare', async (req, res) => {
			const { uid, amount, currency } = req.body as { uid?: string; amount?: string; currency?: string }
			if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
				return res.status(400).json({ success: false, error: 'Missing uid' })
			}
			const result = await nfcTopupPreparePayload({ uid: uid.trim(), amount: String(amount ?? ''), currency: (currency || 'CAD').trim() })
			if ('error' in result) {
				return res.status(400).json({ success: false, error: result.error })
			}
			res.status(200).json(result).end()
		})

		/** POST /api/nfcTopup - NFC 卡向 CCSA 充值：读取方 UI 用户用 profile 私钥签 ExecuteForAdmin，Master 调用 factory.executeForAdmin */
		router.post('/nfcTopup', async (req, res) => {
			const { cardAddr, data, deadline, nonce, adminSignature } = req.body as {
				cardAddr?: string
				data?: string
				deadline?: number
				nonce?: string
				adminSignature?: string
			}
			if (!cardAddr || !ethers.isAddress(cardAddr) || !data || typeof data !== 'string' || data.length === 0) {
				return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr/data' })
			}
			if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string' || !adminSignature || typeof adminSignature !== 'string') {
				return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce/adminSignature' })
			}
			executeForAdminPool.push({
				cardAddr: ethers.getAddress(cardAddr),
				data,
				deadline,
				nonce,
				adminSignature,
				res
			})
			logger(Colors.green(`[nfcTopup] cardAddr=${cardAddr} pushed to executeForAdminPool`))
			executeForAdminProcess().catch((err: any) => {
				logger(Colors.red('[executeForAdminProcess] nfcTopup error:'), err?.message ?? err)
			})
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