import express, { Request, Response, Router} from 'express'
import { GoogleGenAI } from '@google/genai'
import { getClientIp, oracleBackoud, checkSign, BeamioTransfer, settleBeamioX402ToCardOwner, setOracleSnapshot, isOracleFresh } from '../util'
import { checkSmartAccount } from '../MemberCard'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import { ethers } from "ethers"
import {beamio_ContractPool, searchUsers, searchUsersResultsForKeyward, getDistinctBeamioCardOwnerAddressesLower, _searchExactByAddress, FollowerStatus, getMyFollowStatus, getOwnerNftSeries, getSeriesByCardAndTokenId, getMintMetadataForOwner, getNfcCardByUid, getNfcRecipientAddressByUid, getNfcRecipientAddressByTagId, getCardByAddress, getNftTierMetadataByCardAndToken, getNftTierMetadataByOwnerAndToken, insertAiLearningFeedback, getAiLearningFeedback, listLinkedNfcCardsByOwnerEoa, applyNfcCardLinkStateChange, getNfcCardSignedTxGateByTagId, getPosTerminalCardAddressForWallet, getPosTerminalCardBindingRow, assertPosEoaAvailableForCardBinding, listCardMemberTopupEvents, listDistinctCardMemberTopupMembers, listCardMemberDirectory, getCardTopupRollup, isOnchainEmptyResult} from '../db'
import {coinbaseToken, coinbaseOfframp, coinbaseHooks} from '../coinbase'
import { purchasingCard, purchasingCardPreCheck, usdcTopupPreCheck, usdcTopupPreview, createCardPreCheck, createCardBusinessStartKetClusterPreCheck, resolveCardOwnerToEOA, AAtoEOAPreCheck, AAtoEOAPreCheckSenderHasCode, AAtoEOAPreCheckBUnitBalance, ContainerRelayPreCheckBUnitBalance, OpenContainerRelayPreCheckBUnitFee, nfcTopupPreCheckBUnitFee, nfcTopupPreCheckAdminAirdropLimit, requestAccountingPreCheckBUnitFee, transferPreCheckBUnit, OpenContainerRelayPreCheck, ContainerRelayPreCheck, ContainerRelayPreCheckUnsigned, cardCreateRedeemPreCheck, cardCreateRedeemAdminPreCheck, cardRedeemAdminPreCheck, cardAddAdminPreCheck, cardAddAdminByAdminPreCheck, cardCreateIssuedNftPreCheck, cardMintIssuedNftToAddressPreCheck, getRedeemStatusBatchApi, claimBUnitsPreCheck, buintRedeemAirdropQueryOnChain, buintRedeemAirdropRedeemClusterPreCheck, businessStartKetRedeemQueryOnChain, businessStartKetRedeemRedeemClusterPreCheck, businessStartKetRedeemReadAdminNonce, businessStartKetRedeemCreateClusterPreCheck, businessStartKetRedeemCancelClusterPreCheck, cancelRequestPreCheck, purchaseBUnitFromBasePreCheck, validateRecommenderForTopup, cardClearAdminMintCounterPreCheck, getCardAdminsWithMintCounter, burnPointsByAdminPreparePayload, verifyBurnPointsByAdminPrepareAllowed, verifyChargeOwnerChildBurnClusterPreCheck, isChargeLedgerTxTipRow, buildChargeLedgerTransactionPreviewFromIndexerBody, nfcLinkAppPaymentBlockedIfAny, nfcLinkAppValidateParams, releaseNfcLinkAppLockIfSessionMatches, nfcLinkAppNewLinkBlockedDetail, NFC_LINK_APP_CARD_LOCKED_MESSAGE, NFC_LINK_APP_CARD_LOCKED_ERROR_CODE, quoteCurrencyToUsdc6, nfcTopupPreparePayload } from '../MemberCard'
import { BASE_CARD_FACTORY, BASE_CCSA_CARD_ADDRESS, BEAMIO_INDEXER_DIAMOND, BEAMIO_USER_CARD_ASSET_ADDRESS, CONET_BUNIT_AIRDROP_ADDRESS, MERCHANT_POS_MANAGEMENT_CONET } from '../chainAddresses'
import { verifyAndPersistBeamioSunUrl, logSunDebug } from '../BeamioSun'
import { fetchUIDAssetsForEOA, fetchBeamioTagForEoa, scheduleEnsureNfcBeamioTagForEoa, type FetchUIDAssetsOptions } from './getUIDAssetsLogic'
import { pickBestMembershipNftByMinUsdc6 } from './membershipTierPick'
import { getAaFactoryAddressFromUserCardFactoryPaymaster, resolveBeamioAaForEoaWithFallback } from './resolveBeamioAaViaUserCardFactory'
import { runUsdcChargeOrchestrator, type OrchestratorSessionPatch, type UsdcChargeOrchestratorContext } from './usdcChargeOrchestrator'
/** 服务器返回时强制屏蔽的旧基础设施卡地址 */
const DEPRECATED_INFRA_CARDS = new Set([
	'0xB7644DDb12656F4854dC746464af47D33C206F0E'.toLowerCase(),
	'0xC0F1c74fb95100a97b532be53B266a54f41DB615'.toLowerCase(),
	'0x02BAe511632354584b198951B42eC73BACBc4E98'.toLowerCase(),
])

/** 旧 CCSA 地址 → 新地址映射，redeemStatusBatch 入口处规范化 */
const OLD_CCSA_REDIRECTS = [
	'0x3A578f47d68a5f2C1f2930E9548E240AB8d40048',
	'0xb6ba88045F854B713562fb7f1332D186df3B25A8', // 曾为 infrastructure CCSA
	'0x6870acA2f4f6aBed6B10B0C8D76C75343398fd64', // 旧工厂部署的 CCSA
	'0xA1A9f6f942dc0ED9Aa7eF5df7337bd878c2e157b', // 旧工厂 0x86879fE3 部署的 CCSA（已迁移至新工厂）
].map(a => a.toLowerCase())
import { masterSetup, resolveBeamioBaseHttpRpcUrl } from '../util'

/** Public short link GET /go/verra-ndef → TestFlight (iOS) or Play Store (Android / default). */
const VERRA_NDEF_PLAY_STORE_URL =
	'https://play.google.com/store/apps/details?id=com.beamio.android_ntag'
const VERRA_NDEF_TESTFLIGHT_URL = 'https://testflight.apple.com/join/ytm1F8Aq'

function resolveVerraNdefInstallRedirectUrl(userAgent: string): string {
	const ua = userAgent || ''
	const isIOS =
		/iPad|iPhone|iPod/i.test(ua) ||
		(/Macintosh/i.test(ua) && /\bMobile\b/i.test(ua))
	if (isIOS) return VERRA_NDEF_TESTFLIGHT_URL
	if (/Android/i.test(ua)) return VERRA_NDEF_PLAY_STORE_URL
	return VERRA_NDEF_PLAY_STORE_URL
}

const BASE_CHAIN_ID = 8453
const MINT_POINTS_BY_ADMIN_SELECTOR = '0x' + ethers.id('mintPointsByAdmin(address,uint256)').slice(2, 10)
const BURN_POINTS_BY_ADMIN_SELECTOR = '0x' + ethers.id('burnPointsByAdmin(address,uint256)').slice(2, 10)

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
/** Base RPC：与 util.resolveBeamioBaseHttpRpcUrl 一致（默认 https://base-rpc.conet.network） */
const BASE_RPC_URL = resolveBeamioBaseHttpRpcUrl()
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

/** 从 mintPointsByAdmin(data) 解析 recipient 与 points6 */
const tryParseMintPointsByAdminArgs = (data: string): { recipient: string; points6: bigint } | null => {
	try {
		const iface = new ethers.Interface(['function mintPointsByAdmin(address user, uint256 points6)'])
		const decoded = iface.parseTransaction({ data })
		if (decoded?.name === 'mintPointsByAdmin' && decoded.args[0] != null && decoded.args[1] != null) {
			return { recipient: decoded.args[0] as string, points6: BigInt(decoded.args[1]) }
		}
	} catch { /* ignore */ }
	return null
}

const tryParseBurnPointsByAdminArgs = (data: string): { target: string; points6: bigint } | null => {
	try {
		const iface = new ethers.Interface(['function burnPointsByAdmin(address target, uint256 amount)'])
		const decoded = iface.parseTransaction({ data })
		if (decoded?.name === 'burnPointsByAdmin' && decoded.args[0] != null && decoded.args[1] != null) {
			return { target: decoded.args[0] as string, points6: BigInt(decoded.args[1]) }
		}
	} catch { /* ignore */ }
	return null
}

/** 解析 EOA 对应的 AA：仅 UserCardFactoryPaymaster._aaFactory() 路径（与发卡工厂绑定；无回退旧 AA 工厂） */
const resolveBeamioAccountOf = async (eoa: string): Promise<string | null> =>
	resolveBeamioAaForEoaWithFallback(providerBase, eoa)

/**
 * cardAddAdmin：Master ensureAAForEOA 成功后，Cluster 必须能用同一解析路径在链上看到已部署 AA。
 * 避免 Master 失败却仍转发、或 body.adminEOA 与真实商户不一致时难以排查。
 */
async function assertAdminEoaHasVisibleAaAfterEnsure(
	adminEoaNorm: string,
	ensureBody: string,
	logTag: string
): Promise<{ ok: true; canonicalAa: string } | { ok: false; error: string }> {
	let masterAa: string | null = null
	try {
		const j = JSON.parse(ensureBody) as { aa?: string }
		if (j?.aa && ethers.isAddress(j.aa)) masterAa = ethers.getAddress(j.aa)
	} catch {
		/* ignore */
	}
	let canonicalAa: string | null = null
	for (let attempt = 0; attempt < 2 && !canonicalAa; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 1500))
		try {
			canonicalAa = await resolveBeamioAaForEoaWithFallback(providerBase, adminEoaNorm)
		} catch {
			canonicalAa = null
		}
	}
	if (!canonicalAa) {
		logger(
			Colors.red(
				`[${logTag}] No AA visible on Base for body adminEOA=${adminEoaNorm} after ensureAAForEOA (master aa=${masterAa ?? 'N/A'}). ` +
					'Use the merchant real EOA in both body.adminEOA and adminManager.to (must match, EOA with no code).'
			)
		)
		return {
			ok: false,
			error:
				'Admin EOA has no AA visible onchain after ensureAAForEOA. Use the merchant’s real EOA in body.adminEOA and adminManager.to; do not use a placeholder address.',
		}
	}
	if (masterAa && masterAa.toLowerCase() !== canonicalAa.toLowerCase()) {
		logger(
			Colors.yellow(
				`[${logTag}] Master ensure aa ${masterAa} != cluster canonical ${canonicalAa} for adminEOA=${adminEoaNorm} (gate uses cluster read)`
			)
		)
	}
	return { ok: true, canonicalAa }
}
const CONET_RPC = 'https://rpc1.conet.network'
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
				if (data && typeof data === 'object') {
					clusterOracleCache = { ...defaultOracle, ...data }
					// 同步到 util.ts 全局 oracle，保证 quoteCurrencyToUsdc6 / nfcTopupPreparePayload 在
					// cluster 进程内也能读到 master 的真实链上汇率，而不是悄悄退回到任何 fallback 常量。
					setOracleSnapshot(data as Record<string, unknown>)
				}
			} catch (_) {}
		})
	})
	req.on('error', () => {})
	req.end()
}

const startClusterOracleSync = () => {
	const conetRpc = new ethers.JsonRpcProvider('https://rpc1.conet.network')
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

/** 将 Stripe webhook 等 raw body POST 原样转发到 Master（签名头必须透传） */
const postLocalhostRaw = (
	path: string,
	body: Buffer,
	stripeSignature: string | string[] | undefined,
	_res: Response
) => {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Content-Length': String(body.length),
	}
	if (stripeSignature) {
		headers['stripe-signature'] = Array.isArray(stripeSignature) ? stripeSignature[0] : stripeSignature
	}
	const option: RequestOptions = {
		hostname: 'localhost',
		path,
		port: masterServerPort,
		method: 'POST',
		protocol: 'http:',
		headers,
	}
	const reqOut = request(option, (mres) => {
		mres.pipe(_res)
	})
	reqOut.once('error', (e) => {
		logger(Colors.red(`[DEBUG] postLocalhostRaw ${path} FAIL: ${e.message}`))
		_res.status(502).json({ success: false, error: `Forward to master failed: ${e.message}` }).end()
	})
	reqOut.write(body)
	reqOut.end()
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
const getNFTMetadataCache = new Map<string, { body: string; expiry: number }>()
const ownerNftSeriesCache = new Map<string, { body: string; expiry: number }>()
const seriesSharedMetadataCache = new Map<string, { body: string; expiry: number }>()
const mintMetadataCache = new Map<string, { body: string; expiry: number }>()
const getFollowStatusCache = new Map<string, { body: string; expiry: number }>()
const getMyFollowStatusCache = new Map<string, { body: string; expiry: number }>()

/** PR #3: USDC charge no-NFC session 跟踪
 * iOS POS 出 QR 前自生成 UUID v4 `sid`，写入 QR URL；customer 在 verra-home 完成 x402 + USDC settle 后，
 * 后端把 `sid → state/USDC_tx/payer/...` 持久化进 in-memory map；POS 异步 `setTimeout` 链单飞轮询
 * `GET /api/nfcUsdcChargeSession?sid=...` 读取最新状态：terminal state（success/error）后 POS 切换 UI
 * 进 `chargeApprovedInline / paymentTerminalError`。
 *
 * - 仅 in-memory（cluster 单进程一致；多副本回滚时由 client 容忍 not-found 即可）
 * - TTL = 10 分钟（远长于典型 1-2 分钟 QR 展示窗口；customer 慢点也不会被踢）
 * - 没记录 ⇒ GET 返回 `{ ok: true, state: 'awaiting_payment' }` 而不是 404，让 POS 单一码路径处理「客人还没扫」
 */
type ChargeSessionState =
	| 'awaiting_payment'  // POS 出 QR，customer 尚未到达 verra-home POST charge
	| 'verifying'         // verra-home 提交 charge，x402 verify 进行中
	| 'settling'          // verify 通过，USDC settle on-chain
	/** PR #4 (USDC charge orchestrator) 引入的中间态：USDC 已结算，编排器开始 L1 topup */
	| 'topup_pending'
	/** PR #4 v2：编排器已生成 tmpEOA + nfcTopupPreparePayload，等待 POS 终端用 admin key 离线签 ExecuteForAdmin。
	 *  POS 轮询命中此态 ⇒ 读 `pendingTopup*` 字段，本地 `BeamioEthWallet.signExecuteForAdmin`，POST 回
	 *  `/api/nfcUsdcChargeTopupAuth`；服务端写入 `posTopupSignature` 后编排器恢复并提交到 Master。
	 *  若 POS 在 `TOPUP_SIG_TIMEOUT_MS` 内未送达 ⇒ session=error（USDC 已落 cardOwner，无 ghost dust，loyalty 入账缺失需人工对账）。 */
	| 'awaiting_topup_auth'
	/** PR #4：L1 topup tx 已确认，开始解析 tmpAA + 构造 container 进入 L2 */
	| 'topup_confirmed'
	/** PR #4：L2 charge container 已提交 Master，等待 relay 上链 */
	| 'charge_pending'
	| 'success'           // PR #4：已含 chargeTxHash（编排器 L2 完成）
	| 'error'             // 任意阶段失败（payload 中含 error）

interface ChargeSession {
	sid: string
	state: ChargeSessionState
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
	/** PR #4：编排器临时钱包 EOA / AA / mint 出的 points / topup base tx / charge base tx */
	tmpEOA: string | null
	tmpAA: string | null
	pointsMinted6: string | null
	topupTxHash: string | null
	chargeTxHash: string | null
	/** PR #4 v2：`awaiting_topup_auth` 状态下供 POS 端签 ExecuteForAdmin 的全部输入。POS 必须用这些 *exact* 值
	 *  签名（任何字段 mismatch 都会让 cluster 验签 recover 不到 session.pos 而拒收）。 */
	pendingTopupCardAddr: string | null
	pendingTopupRecipientEOA: string | null
	pendingTopupData: string | null
	pendingTopupDeadline: number | null
	pendingTopupNonce: string | null
	pendingTopupPoints6: string | null
	pendingTopupBUnitFee: string | null
	/** POS POST 回的签名；orchestrator 的 `awaitTopupSignature` 轮询命中后即转入下一阶段并清掉 pendingTopup* 字段。 */
	posTopupSignature: string | null
	createdAt: number
	updatedAt: number
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidSid(sid: unknown): sid is string {
	return typeof sid === 'string' && UUID_V4_RE.test(sid)
}

/** PR #4 v3：cluster 是 N-worker 多进程，session store 改在 Master（单进程，唯一信源），cluster 全部 HTTP 代理。
 *  详见 `beamioMaster.ts` 顶部 `MasterChargeSession` block 注释。
 *
 *  这里只暴露三个 helper：
 *   - `masterSessionUpsert(sid, patch)` ← cluster sessionUpdate(...) 的实际承载（fire-and-forget，不阻塞热路径）
 *   - `masterSessionGet(sid)`           ← GET /api/nfcUsdcChargeSession 透传 + orchestrator 内部 polling 用（如 awaitTopupSignature 走专用 consume 端点）
 *   - `masterSessionConsumePosSig(sid)` ← orchestrator awaitTopupSignature 闭环原子消耗 POS 签名 */
const masterSessionUpsert = async (sid: string, patch: Record<string, unknown>): Promise<void> => {
	try {
		const r = await postLocalhostBuffer('/api/chargeSessionUpsert', { sid, patch })
		if (r.statusCode !== 200) {
			logger(Colors.red(`[masterSessionUpsert] sid=${sid.slice(0,8)}… HTTP ${r.statusCode} body=${r.body.slice(0, 200)}`))
		}
	} catch (err: any) {
		logger(Colors.red(`[masterSessionUpsert] sid=${sid.slice(0,8)}… error: ${err?.message ?? err}`))
	}
}

const masterSessionGet = async (sid: string): Promise<{ statusCode: number; body: string }> => {
	const sidEnc = encodeURIComponent(sid)
	return getLocalhostBuffer(`/api/chargeSessionGet?sid=${sidEnc}`)
}

const masterSessionConsumePosSig = async (sid: string): Promise<
	{ ok: true; signature: string; signer: string } | { ok: false; error: string }
> => {
	try {
		const r = await postLocalhostBuffer('/api/chargeSessionConsumePosSig', { sid })
		const parsed = JSON.parse(r.body) as { ok?: boolean; signature?: string; signer?: string; error?: string }
		if (parsed.ok && typeof parsed.signature === 'string' && typeof parsed.signer === 'string') {
			return { ok: true, signature: parsed.signature, signer: parsed.signer }
		}
		return { ok: false, error: parsed.error ?? 'no signature yet' }
	} catch (err: any) {
		return { ok: false, error: err?.message ?? String(err) }
	}
}

type JsonObject = Record<string, unknown>

const ERC1155_METADATA_PATH_RE = /^(?:0x)?([0-9a-fA-F]{40})([0-9a-fA-F]{64})\.json$/
const DEFAULT_METADATA_IMAGE_URL = 'https://ipfs.conet.network/api/getFragment?hash=0x44e7a175e57a337bf5d0a98deb19a0a545e362d504092a7af1aecd58798eab'

const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const firstNonEmptyString = (...values: unknown[]): string | undefined => {
	for (const value of values) {
		if (typeof value !== 'string') continue
		const trimmed = value.trim()
		if (trimmed) return trimmed
	}
	return undefined
}

const mergeMetadataObjects = (...sources: Array<unknown>): JsonObject => {
	const out: JsonObject = {}
	for (const source of sources) {
		if (!isJsonObject(source)) continue
		Object.assign(out, source)
	}
	return out
}

const ensureMetadataImage = (meta: JsonObject): JsonObject => {
	const props = isJsonObject(meta.properties) ? meta.properties : {}
	const image = firstNonEmptyString(
		meta.image,
		meta.image_url,
		meta.imageUrl,
		props.image,
		DEFAULT_METADATA_IMAGE_URL
	)
	if (image) meta.image = image
	return meta
}

const normalizeExplorerMetadata = (
	meta: JsonObject,
	defaults: {
		name: string
		description: string
		image?: string
		externalUrl?: string
		attributes?: unknown[]
		extra?: JsonObject
	}
): JsonObject => {
	const props = isJsonObject(meta.properties) ? meta.properties : {}
	const out: JsonObject = {
		name: firstNonEmptyString(meta.name, meta.title, defaults.name) ?? defaults.name,
		description: firstNonEmptyString(meta.description, defaults.description) ?? defaults.description,
	}
	const image = firstNonEmptyString(
		meta.image,
		meta.image_url,
		meta.imageUrl,
		props.image,
		defaults.image
	)
	if (image) out.image = image
	const externalUrl = firstNonEmptyString(meta.external_url, meta.externalUrl, defaults.externalUrl)
	if (externalUrl) out.external_url = externalUrl
	const attrs = Array.isArray(meta.attributes) ? meta.attributes : defaults.attributes
	if (attrs && attrs.length > 0) out.attributes = attrs
	const backgroundColor = firstNonEmptyString(meta.background_color, props.background_color)
	if (backgroundColor) out.background_color = backgroundColor
	if (Object.keys(props).length > 0) out.properties = props
	if (defaults.extra) Object.assign(out, defaults.extra)
	for (const [key, value] of Object.entries(meta)) {
		if (out[key] === undefined) out[key] = value
	}
	return out
}

const SC = beamio_ContractPool[0].constAccountRegistry

const userOwnershipCheck = async (accountName: string, wallet: string) => {

	try {
		const accountWallet: string = await SC.getOwnerByAccountName(accountName)
		if (accountWallet !== ethers.ZeroAddress && accountWallet.toLowerCase() !== wallet.toLowerCase()) {
			return false
		}
	} catch (ex: any) {
		// 新 registry 对未注册名字返回 0x（BAD_DATA），等价于「名字未占用」→ 当作通过。
		// 真正的 RPC/合约错误才记日志，避免日常注册流程被误报为 ownership 失败。
		if (!isOnchainEmptyResult(ex)) {
			logger(`userOwnershipCheck Error! ${ex.message}`)
		}
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

	/** GET /api/sun - 校验 Beamio SUN 动态 URL。valid 时：若 tagID 已绑定则返回 eoa/aa；未绑定则转发 Master 创建钱包并返回 eoa/aa。 */
	router.get('/sun', async (req, res) => {
		try {
			const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
			const result = await verifyAndPersistBeamioSunUrl(url)
			const shortHex = (v: string | null | undefined, k = 8) => !v ? null : v.length <= k * 2 ? v : `${v.slice(0, k)}...${v.slice(-k)}`
			logSunDebug(result.valid ? 'verify_ok' : 'verify_fail', req, {
				uidHex: result.uidHex,
				counterHex: result.counterHex,
				lastCounterHex: result.counterState?.lastCounterHex ?? null,
				tagIdHex: result.tagIdHex,
				version: result.version,
				macLayout: result.macLayout,
				payloadLayout: result.payloadLayout,
				macValid: result.macValid,
				counterFresh: result.counterFresh,
				embeddedUidMatchesInput: result.embeddedUidMatchesInput,
				embeddedCounterMatchesInput: result.embeddedCounterMatchesInput,
				valid: result.valid,
				eHex: shortHex(result.eHex),
				mHex: result.mHex,
				expectedMacHex: result.expectedMacHex,
				macInputAscii: result.macInputAscii,
			})
			if (!result.valid) {
				return res.status(403).json(result).end()
			}
			const eoa = await getNfcRecipientAddressByTagId(result.tagIdHex)
			if (eoa) {
				const eoaAddr = ethers.getAddress(eoa)
				const aaAddr = await resolveBeamioAccountOf(eoaAddr)
				let hasDeployedAA = false
				if (aaAddr && aaAddr !== ethers.ZeroAddress) {
					const code = await providerBase.getCode(aaAddr)
					hasDeployedAA = !!(code && code !== '0x' && code.length > 2)
				}
				if (hasDeployedAA) {
					scheduleEnsureNfcBeamioTagForEoa(eoaAddr, result.uidHex, result.tagIdHex, null)
				}
				return res.status(200).json({ ...result, eoa: eoaAddr, aa: aaAddr ?? undefined }).end()
			}
			logger(Colors.cyan(`[sun] tagId=${result.tagIdHex.slice(0, 8)}... 未绑定钱包，转发 Master 创建`))
			postLocalhost('/api/sunProvision', { uid: result.uidHex, tagIdHex: result.tagIdHex, sunResult: result }, res)
		} catch (e: any) {
			logSunDebug('verify_fail', req, { error: e?.message ?? String(e), uidHex: req.query?.uid ?? null })
			return res.status(403).json({ success: false, error: e?.message ?? String(e) }).end()
		}
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

	const DISTINCT_CARD_OWNERS_CACHE_TTL_MS = 60_000
	let distinctCardOwnersCache: { addrs: Set<string>; expiry: number } | null = null
	const getCachedDistinctBeamioCardOwnerSet = async (): Promise<Set<string>> => {
		const now = Date.now()
		if (distinctCardOwnersCache && distinctCardOwnersCache.expiry > now) {
			return distinctCardOwnersCache.addrs
		}
		const list = await getDistinctBeamioCardOwnerAddressesLower()
		const addrs = new Set(list.map((x) => x.toLowerCase()))
		distinctCardOwnersCache = { addrs, expiry: now + DISTINCT_CARD_OWNERS_CACHE_TTL_MS }
		return addrs
	}

	const FACTORY_CARDS_OF_OWNER_ABI = ['function cardsOfOwner(address owner) view returns (address[])'] as const
	const CARD_ADMIN_ABI_OWNER_AND_LIST = [
		'function owner() view returns (address)',
		'function getAdminListWithMetadata() view returns (address[] admins, string[] metadatas, address[] parents)',
	] as const

	const collectWalletRelatedCardAddresses = async (
		walletRaw: string | null | undefined,
		extraCardAddressesCsv: string | undefined
	): Promise<string[]> => {
		const out = new Set<string>()
		if (extraCardAddressesCsv?.trim()) {
			for (const part of extraCardAddressesCsv.split(',')) {
				const t = part.trim()
				if (t && ethers.isAddress(t)) out.add(ethers.getAddress(t))
			}
		}
		const wTrim = walletRaw?.trim()
		if (!wTrim || !ethers.isAddress(wTrim)) {
			return Array.from(out)
		}
		const wallet = ethers.getAddress(wTrim)
		let eoa = wallet
		try {
			const code = await providerBase.getCode(wallet)
			if (code && code !== '0x' && code.length > 2) {
				const aa = new ethers.Contract(wallet, ['function owner() view returns (address)'], providerBase)
				const owner = await aa.owner()
				if (owner && owner !== ethers.ZeroAddress) eoa = ethers.getAddress(owner)
			}
		} catch {
			/* treat as EOA */
		}
		try {
			const pos = await getPosTerminalCardAddressForWallet(eoa)
			if (pos) out.add(ethers.getAddress(pos))
		} catch {
			/* ignore */
		}
		try {
			const fac = new ethers.Contract(BASE_CARD_FACTORY, FACTORY_CARDS_OF_OWNER_ABI, providerBase)
			const cards = (await fac.cardsOfOwner(eoa)) as string[]
			const cap = 48
			for (const c of (cards ?? []).slice(0, cap)) {
				if (c && ethers.isAddress(c) && c !== ethers.ZeroAddress) out.add(ethers.getAddress(c))
			}
		} catch (e) {
			logger(Colors.gray(`[search-users-by-card-owner-or-admin] cardsOfOwner failed: ${(e as Error)?.message ?? e}`))
		}
		return Array.from(out)
	}

	const buildOwnerOrAdminAllowSetForCards = async (cardAddrs: string[]): Promise<Set<string>> => {
		const allow = new Set<string>()
		const unique = [...new Set(cardAddrs.map((c) => ethers.getAddress(c)))]
		await Promise.all(
			unique.map(async (cardAddr) => {
				try {
					const card = new ethers.Contract(cardAddr, CARD_ADMIN_ABI_OWNER_AND_LIST, providerBase)
					const [owner, adminResult] = await Promise.all([
						card.owner() as Promise<string>,
						card.getAdminListWithMetadata() as Promise<[string[], string[], string[]]>,
					])
					const [admins] = adminResult
					if (owner && owner !== ethers.ZeroAddress) allow.add(ethers.getAddress(owner).toLowerCase())
					for (const a of admins ?? []) {
						if (a && ethers.isAddress(a) && a !== ethers.ZeroAddress) allow.add(ethers.getAddress(a).toLowerCase())
					}
				} catch (e) {
					logger(
						Colors.gray(
							`[search-users-by-card-owner-or-admin] card ${cardAddr} admin fetch failed: ${(e as Error)?.message ?? e}`
						)
					)
				}
			})
		)
		return allow
	}

	/**
	 * GET /api/search-users-by-card-owner-or-admin?keyward=...&wallet=0x...&extraCardAddresses=0x...,0x...
	 * 先按 search-users 逻辑查 BeamioTag，再过滤：accounts.address 在 beamio_cards 登记过的发卡 owner，或与 wallet 关联卡（POS 绑定卡 + factory.cardsOfOwner + extra）链上 owner/admin 集合命中。
	 * 无 wallet 时仅保留「DB 登记发卡 owner」命中项（链上 admin 需传 wallet 或 extraCardAddresses）。
	 */
	router.get('/search-users-by-card-owner-or-admin', async (req, res) => {
		const { keyward, wallet, extraCardAddresses } = req.query as {
			keyward?: string
			wallet?: string
			extraCardAddresses?: string
		}
		const _keywork = String(keyward || '').trim().replace(/^@+/, '')
		if (!_keywork) {
			return res.status(404).end()
		}
		try {
			const raw = await searchUsersResultsForKeyward(_keywork)
			if ('error' in raw) {
				return res.status(500).json({ ok: false, error: raw.error }).end()
			}
			const results = raw.results ?? []
			const ownerSet = await getCachedDistinctBeamioCardOwnerSet()
			let chainAllow = new Set<string>()
			const walletTrim = wallet?.trim()
			const extraTrim = extraCardAddresses?.trim()
			if ((walletTrim && ethers.isAddress(walletTrim)) || extraTrim) {
				const cards = await collectWalletRelatedCardAddresses(
					walletTrim && ethers.isAddress(walletTrim) ? walletTrim : undefined,
					extraTrim
				)
				if (cards.length > 0) {
					chainAllow = await buildOwnerOrAdminAllowSetForCards(cards)
				}
			}
			const filtered = results.filter((row: { address?: string }) => {
				const addr = typeof row?.address === 'string' ? row.address.toLowerCase() : ''
				if (!addr) return false
				if (ownerSet.has(addr)) return true
				if (chainAllow.has(addr)) return true
				return false
			})
			return res.status(200).json({ results: filtered }).end()
		} catch (e) {
			logger(Colors.red(`[search-users-by-card-owner-or-admin] ${(e as Error)?.message ?? e}`))
			return res.status(500).json({ ok: false, error: (e as Error)?.message ?? 'Internal error' }).end()
		}
	})

	/** GET /api/getTerminalProfile - 终端首页用：返回当前钱包的 beamio profile 及上层 admin（merchant）的 profile。供 Android NdefScreen 头部展示。 */
	router.get('/getTerminalProfile', async (req, res) => {
		const { wallet } = req.query as { wallet?: string }
		if (!wallet || typeof wallet !== 'string' || !wallet.trim() || !ethers.isAddress(wallet.trim())) {
			return res.status(400).json({ ok: false, error: 'Missing or invalid wallet' }).end()
		}
		try {
			const addr = ethers.getAddress(wallet.trim())
			// Resolve AA to EOA (accounts table stores EOA)
			let eoa = addr
			try {
				const code = await providerBase.getCode(addr)
				if (code && code !== '0x' && code.length > 2) {
					const aa = new ethers.Contract(addr, ['function owner() view returns (address)'], providerBase)
					const owner = await aa.owner()
					if (owner && owner !== ethers.ZeroAddress) eoa = ethers.getAddress(owner)
				}
			} catch (_) { /* not AA, use as-is */ }
			const profileRet = await _searchExactByAddress(eoa.toLowerCase())
			const profileRow = profileRet?.results?.[0]
			const profile = profileRow ? {
				accountName: profileRow.username ?? profileRow.accountName,
				first_name: profileRow.first_name,
				last_name: profileRow.last_name,
				image: profileRow.image,
				address: profileRow.address,
			} : null
			let adminProfile: { accountName?: string; first_name?: string; last_name?: string; image?: string; address?: string } | null = null
			try {
				const posMgmt = new ethers.Contract(MERCHANT_POS_MANAGEMENT_CONET, ['function getPOSMerchant(address) view returns (address)'], providerConet)
				const merchant = await posMgmt.getPOSMerchant(eoa)
				if (merchant && merchant !== ethers.ZeroAddress) {
					const adminRet = await _searchExactByAddress(ethers.getAddress(merchant).toLowerCase())
					const adminRow = adminRet?.results?.[0]
					if (adminRow) {
						adminProfile = {
							accountName: adminRow.username ?? adminRow.accountName,
							first_name: adminRow.first_name,
							last_name: adminRow.last_name,
							image: adminRow.image,
							address: adminRow.address,
						}
					}
				}
			} catch (e) {
				logger(Colors.gray(`[getTerminalProfile] getPOSMerchant failed: ${(e as Error)?.message ?? e}`))
			}
			return res.status(200).json({ ok: true, profile, adminProfile }).end()
		} catch (e) {
			logger(Colors.red(`[getTerminalProfile] error: ${(e as Error)?.message ?? e}`))
			return res.status(500).json({ ok: false, error: (e as Error)?.message ?? 'Internal error' }).end()
		}
	})

	/** GET /api/getCardAdminInfo?cardAddress=0x...&wallet=0x... - 从 BeamioUserCard 卡合约（Base）获取 owner 与 admin 列表。cardAddress 默认 BEAMIO_USER_CARD_ASSET_ADDRESS。wallet 可选：若提供则返回该终端的上层 admin（upperAdmin）。供 Android 用 upperAdmin/owner 调用 search-users 拉取 BeamioCapsule。 */
	const CARD_ADMIN_ABI = [
		'function owner() view returns (address)',
		'function getAdminListWithMetadata() view returns (address[] admins, string[] metadatas, address[] parents)',
		'function getAdminSubordinatesWithMetadata(address admin) view returns (address[] subordinates, string[] metadatas, address[] parents)',
	] as const
	router.get('/getCardAdminInfo', async (req, res) => {
		const { cardAddress: cardAddrQ, wallet: walletQ } = req.query as { cardAddress?: string; wallet?: string }
		const cardAddr = (cardAddrQ?.trim() || BEAMIO_USER_CARD_ASSET_ADDRESS)
		if (!ethers.isAddress(cardAddr)) {
			return res.status(400).json({ ok: false, error: 'Invalid cardAddress' }).end()
		}
		try {
			const card = new ethers.Contract(ethers.getAddress(cardAddr), CARD_ADMIN_ABI, providerBase)
			const [owner, adminResult] = await Promise.all([
				card.owner() as Promise<string>,
				card.getAdminListWithMetadata() as Promise<[string[], string[], string[]]>,
			])
			const [admins, metadatas, parents] = adminResult
			const ownerAddr = owner && owner !== ethers.ZeroAddress ? ethers.getAddress(owner) : null
			const result: { ok: boolean; owner: string | null; admins: string[]; metadatas: string[]; parents: string[]; upperAdmin?: string | null } = {
				ok: true,
				owner: ownerAddr,
				admins: (admins ?? []).map((a: string) => ethers.getAddress(a)),
				metadatas: metadatas ?? [],
				parents: (parents ?? []).map((p: string) => ethers.getAddress(p)),
			}
			if (walletQ?.trim() && ethers.isAddress(walletQ.trim()) && ownerAddr) {
				const terminal = ethers.getAddress(walletQ.trim())
				const adminsNorm = (admins ?? []).map((a: string) => ethers.getAddress(a).toLowerCase())
				const idx = adminsNorm.indexOf(terminal.toLowerCase())
				if (idx >= 0) {
					const p = (parents ?? [])[idx]
					result.upperAdmin = p && p !== ethers.ZeroAddress ? ethers.getAddress(p) : ownerAddr
				} else {
					const [subsOwner] = await card.getAdminSubordinatesWithMetadata(ownerAddr) as [string[]]
					const subsOwnerNorm = (subsOwner ?? []).map((s: string) => ethers.getAddress(s).toLowerCase())
					if (subsOwnerNorm.includes(terminal.toLowerCase())) {
						result.upperAdmin = ownerAddr
					} else {
						for (let i = 0; i < (admins ?? []).length; i++) {
							const adminAddr = ethers.getAddress((admins ?? [])[i])
							const [subs] = await card.getAdminSubordinatesWithMetadata(adminAddr) as [string[]]
							const subsNorm = (subs ?? []).map((s: string) => ethers.getAddress(s).toLowerCase())
							if (subsNorm.includes(terminal.toLowerCase())) {
								result.upperAdmin = adminAddr
								break
							}
						}
						if (result.upperAdmin === undefined) result.upperAdmin = null
					}
				}
			}
			return res.status(200).json(result).end()
		} catch (e) {
			logger(Colors.red(`[getCardAdminInfo] error: ${(e as Error)?.message ?? e}`))
			return res.status(500).json({ ok: false, error: (e as Error)?.message ?? 'Internal error' }).end()
		}
	})

	/**
	 * GET /api/myPosAddress?wallet=0x... 或 POST JSON { "wallet"|"posEOA"|"address": "0x..." }
	 * — POS 终端 EOA 已通过 Registration Device（cardAddAdmin）登记后，返回该终端绑定的 BeamioUserCard 地址。
	 * Cluster 直读 DB，不转发 Master。
	 */
	const parseMyPosWallet = (req: Request): string | null => {
		const q = req.query as { wallet?: string; posEOA?: string; address?: string }
		const fromQuery = q.wallet?.trim() || q.posEOA?.trim() || q.address?.trim()
		if (fromQuery) return fromQuery
		const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
		const fromBody =
			(typeof b.wallet === 'string' && b.wallet.trim()) ||
			(typeof b.posEOA === 'string' && b.posEOA.trim()) ||
			(typeof b.address === 'string' && b.address.trim()) ||
			''
		return fromBody || null
	}
	const myPosAddressHandler = async (req: Request, res: Response) => {
		const raw = parseMyPosWallet(req)
		if (!raw || !ethers.isAddress(raw)) {
			return res.status(400).json({ ok: false, error: 'wallet or posEOA (address) required' }).end()
		}
		try {
			const row = await getPosTerminalCardBindingRow(raw)
			if (!row?.cardAddress) {
				return res
					.status(404)
					.json({ ok: false, error: 'No merchant card registered for this terminal in DB' })
					.end()
			}
			const { cardAddress, terminalMetadata, txHash } = row
			return res
				.status(200)
				.json({
					ok: true,
					cardAddress,
					myPosAddress: cardAddress,
					terminalMetadata: terminalMetadata ?? undefined,
					bindingTxHash: txHash ?? undefined,
				})
				.end()
		} catch (e) {
			logger(Colors.red(`[myPosAddress] error: ${(e as Error)?.message ?? e}`))
			return res.status(500).json({ ok: false, error: (e as Error)?.message ?? 'Internal error' }).end()
		}
	}
	router.get('/myPosAddress', myPosAddressHandler)
	router.post('/myPosAddress', myPosAddressHandler)

	/** GET /api/getCardStats?cardAddress=0x...&admin=0x... - 从 BeamioUserCard 获取 periodTransferAmount（Charge，当天数据）与 redeemMintCounterFromClear（Top-Up）。periodType=PERIOD_DAY、anchorTs=0 即当天。admin 为终端 EOA，默认用 owner。 */
	const CARD_STATS_ABI = [
		'function getAdminStatsFull(address admin, uint8 periodType, uint256 anchorTs, uint256 cumulativeStartTs) view returns (uint256 cumulativeMint, uint256 cumulativeBurn, uint256 cumulativeTransfer, uint256 cumulativeTransferAmount, uint256 cumulativeRedeemMint, uint256 cumulativeUSDCMint, uint256 cumulativeIssued, uint256 cumulativeUpgraded, uint256 periodMint, uint256 periodBurn, uint256 periodTransfer, uint256 periodTransferAmount, uint256 periodRedeemMint, uint256 periodUSDCMint, uint256 periodIssued, uint256 periodUpgraded, uint256 mintCounterFromClear, uint256 burnCounterFromClear, uint256 transferCounterFromClear, uint256 transferAmountFromClear, uint256 redeemMintCounterFromClear, uint256 usdcMintCounterFromClear, address[] subordinates)',
		'function getGlobalStatsFull(uint8 periodType, uint256 anchorTs, uint256 cumulativeStartTs) view returns (uint256 cumulativeMint, uint256 cumulativeBurn, uint256 cumulativeTransfer, uint256 cumulativeTransferAmount, uint256 cumulativeRedeemMint, uint256 cumulativeUSDCMint, uint256 cumulativeIssued, uint256 cumulativeUpgraded, uint256 periodMint, uint256 periodBurn, uint256 periodTransfer, uint256 periodTransferAmount, uint256 periodRedeemMint, uint256 periodUSDCMint, uint256 periodIssued, uint256 periodUpgraded, uint256 adminCount)',
	] as const
	const PERIOD_DAY = 1
	router.get('/getCardStats', async (req, res) => {
		const { cardAddress: cardAddrQ, admin: adminQ } = req.query as { cardAddress?: string; admin?: string }
		const cardAddr = (cardAddrQ?.trim() || BEAMIO_USER_CARD_ASSET_ADDRESS)
		if (!ethers.isAddress(cardAddr)) {
			return res.status(400).json({ ok: false, error: 'Invalid cardAddress' }).end()
		}
		try {
			const card = new ethers.Contract(ethers.getAddress(cardAddr), CARD_STATS_ABI, providerBase)
			let adminAddr = adminQ?.trim() && ethers.isAddress(adminQ.trim()) ? ethers.getAddress(adminQ.trim()) : null
			if (!adminAddr) {
				const ownerAbi = ['function owner() view returns (address)']
				const ownerCard = new ethers.Contract(ethers.getAddress(cardAddr), ownerAbi, providerBase)
				const owner = await ownerCard.owner() as string
				adminAddr = owner && owner !== ethers.ZeroAddress ? ethers.getAddress(owner) : null
			}
			if (!adminAddr) {
				return res.status(200).json({ ok: true, charge: 0, topUp: 0 }).end()
			}
			const resAdmin = await card.getAdminStatsFull(adminAddr, PERIOD_DAY, 0, 0) as { periodTransferAmount: bigint; redeemMintCounterFromClear: bigint }
			const charge = Number(resAdmin.periodTransferAmount) / 1_000_000
			const topUp = Number(resAdmin.redeemMintCounterFromClear) / 1_000_000
			return res.status(200).json({ ok: true, charge, topUp }).end()
		} catch (e) {
			logger(Colors.red(`[getCardStats] error: ${(e as Error)?.message ?? e}`))
			return res.status(500).json({ ok: false, error: (e as Error)?.message ?? 'Internal error' }).end()
		}
	})

	/** GET /api/cardTransactions - 代理 BeamioIndexerDiamond 记账数据（asset + account 合并），供 bizSite 前端绕过 CORS 拉取。 */
	router.get('/cardTransactions', async (req, res) => {
		const { cardAddress, adminAddress, aaAddress } = req.query as { cardAddress?: string; adminAddress?: string; aaAddress?: string }
		const cardAddr = (cardAddress?.trim() || BEAMIO_USER_CARD_ASSET_ADDRESS)
		if (!ethers.isAddress(cardAddr)) {
			return res.status(400).json({ error: 'Invalid cardAddress' }).end()
		}
		const adminAddr = adminAddress?.trim() && ethers.isAddress(adminAddress.trim()) ? ethers.getAddress(adminAddress.trim()) : null
		const aaAddr = aaAddress?.trim() && ethers.isAddress(aaAddress.trim()) ? ethers.getAddress(aaAddress.trim()) : null
		const INDEXER_ASSET_ABI = ['function getAssetTransactionsByCurrentPeriodOffsetAndAccountModePaged(address asset, address account, uint8 periodType, uint256 periodOffset, uint256 pageOffset, uint256 pageLimit, bytes32 txCategoryFilter, uint8 accountMode, uint256 chainIdFilter) view returns (uint256 total, uint256 periodStart, uint256 periodEnd, tuple(bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, tuple(uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, tuple(uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, bool exists)[] page)']
		const INDEXER_ACCOUNT_ABI = ['function getAccountTransactionsByCurrentPeriodOffsetAndAccountModePaged(address account, uint8 periodType, uint256 periodOffset, uint256 pageOffset, uint256 pageLimit, bytes32 txCategoryFilter, uint8 accountMode) view returns (uint256 total, uint256 periodStart, uint256 periodEnd, tuple(bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, tuple(uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, tuple(uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, bool exists)[] page)']
		const PERIOD_DAY = 1
		const CHAIN_ID_FILTER_ALL = ethers.MaxUint256
		const TX_CATEGORY_ZERO = ethers.ZeroHash
		const ACCOUNT_MODE_ALL = 0
		type TxRow = { id: string; txCategory: string; displayJson: string; timestamp: bigint; payer: string; payee: string; finalRequestAmountFiat6: bigint; finalRequestAmountUSDC6: bigint; meta: { afterNotePayer?: string; afterNotePayee?: string }; exists?: boolean }
		const serializeTx = (tx: TxRow): Record<string, unknown> => ({
			id: String(tx.id),
			txCategory: String(tx.txCategory),
			displayJson: tx.displayJson ?? '',
			timestamp: String(tx.timestamp),
			payer: tx.payer,
			payee: tx.payee,
			finalRequestAmountFiat6: String(tx.finalRequestAmountFiat6 ?? 0n),
			finalRequestAmountUSDC6: String(tx.finalRequestAmountUSDC6 ?? 0n),
			meta: tx.meta ?? {},
		})
		try {
			const indexerAsset = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, INDEXER_ASSET_ABI, providerConet)
			const indexerAccount = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, INDEXER_ACCOUNT_ABI, providerConet)
			const seen = new Set<string>()
			const all: TxRow[] = []
			const addPage = (page: TxRow[] | undefined) => {
				for (const tx of page ?? []) {
					if (!tx?.exists || !tx?.id) continue
					const id = String(tx.id)
					if (seen.has(id)) continue
					seen.add(id)
					all.push(tx)
				}
			}
			const queryAccount = async (account: string) => {
				for (let periodOffset = 0; periodOffset < 3; periodOffset++) {
					try {
						const [total, , , page] = await indexerAccount.getAccountTransactionsByCurrentPeriodOffsetAndAccountModePaged(account, PERIOD_DAY, periodOffset, 0, 100, TX_CATEGORY_ZERO, ACCOUNT_MODE_ALL) as [bigint, bigint, bigint, TxRow[]]
						addPage(page)
						if (Number(total) <= 100) return
					} catch { return }
				}
			}
			if (adminAddr) await queryAccount(adminAddr)
			if (aaAddr && aaAddr.toLowerCase() !== adminAddr?.toLowerCase()) await queryAccount(aaAddr)
			for (let periodOffset = 0; periodOffset < 3; periodOffset++) {
				const [total, , , page] = await indexerAsset.getAssetTransactionsByCurrentPeriodOffsetAndAccountModePaged(ethers.getAddress(cardAddr), ethers.ZeroAddress, PERIOD_DAY, periodOffset, 0, 100, TX_CATEGORY_ZERO, ACCOUNT_MODE_ALL, CHAIN_ID_FILTER_ALL) as [bigint, bigint, bigint, TxRow[]]
				addPage(page)
				if (Number(total) <= 100) break
			}
			const sorted = all.sort((a, b) => Number(b.timestamp - a.timestamp)).slice(0, 50)
			return res.status(200).json({ ok: true, transactions: sorted.map(serializeTx) }).end()
		} catch (e) {
			logger(Colors.red(`[cardTransactions] error: ${(e as Error)?.message ?? e}`))
			return res.status(500).json({ ok: false, error: (e as Error)?.message ?? 'Internal error' }).end()
		}
	})

	/**
	 * GET /api/posLedger - POS 终端 EOA 维度的 Top-Up + Charge 流水（newest first），同时回送
	 * 该 admin 在指定 BeamioUserCard 上的「上次 clear 起累计」(`mintCounterFromClear` /
	 * `transferAmountFromClear`)。
	 *
	 * 列表使用「running cumulative bound」裁剪：从最新一条开始累加 USDC6（fiat6 兜底），
	 * 一旦 topUpSum6 ≥ topUpFromClear6 且 chargeSum6 ≥ chargeFromClear6 即停止——确保
	 * **items 的 topUp/charge 总和等于 admin/owner 清零后的金额**（与 `*FromClear` 对账）。
	 *
	 * Query: `eoa`（必填，POS 终端 EOA）；`infraCard`（必填，POS 注册的基础设施 BeamioUserCard）。
	 * 返回 `{ ok, fromClear: { topUp6, charge6 }, items: [...] }` —— `items` 为简化后的行集，
	 * iOS 直接渲染、按时间倒序（最新在最上方）。
	 */
	router.get('/posLedger', async (req, res) => {
		const { eoa, infraCard } = req.query as { eoa?: string; infraCard?: string }
		const eoaTrim = typeof eoa === 'string' ? eoa.trim() : ''
		const cardTrim = typeof infraCard === 'string' ? infraCard.trim() : ''
		if (!eoaTrim || !ethers.isAddress(eoaTrim)) {
			return res.status(400).json({ ok: false, error: 'Invalid eoa' }).end()
		}
		if (!cardTrim || !ethers.isAddress(cardTrim)) {
			return res.status(400).json({ ok: false, error: 'Invalid infraCard' }).end()
		}
		const adminAddr = ethers.getAddress(eoaTrim)
		const cardAddr = ethers.getAddress(cardTrim)

		const TX_PAGE_TUPLE = 'tuple(bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, tuple(uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, tuple(uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, bool exists, address topAdmin, address subordinate)'
		const POS_LEDGER_INDEXER_ABI = [
			'function getAccountActionCount(address account) view returns (uint256)',
			`function getAccountTransactionsPaged(address account, uint256 offset, uint256 limit) view returns (${TX_PAGE_TUPLE}[] page)`,
		]
		const ADMIN_STATS_FULL_ABI = [
			'function getAdminStatsFull(address admin, uint8 periodType, uint256 anchorTs, uint256 cumulativeStartTs) view returns (tuple(uint256 cumulativeMint, uint256 cumulativeBurn, uint256 cumulativeTransfer, uint256 cumulativeTransferAmount, uint256 cumulativeRedeemMint, uint256 cumulativeUSDCMint, uint256 cumulativeIssued, uint256 cumulativeUpgraded, uint256 periodMint, uint256 periodBurn, uint256 periodTransfer, uint256 periodTransferAmount, uint256 periodRedeemMint, uint256 periodUSDCMint, uint256 periodIssued, uint256 periodUpgraded, uint256 mintCounterFromClear, uint256 burnCounterFromClear, uint256 transferCounterFromClear, uint256 transferAmountFromClear, uint256 redeemMintCounterFromClear, uint256 usdcMintCounterFromClear, address[] subordinates))',
		]

		// keccak256 of the categorized topup hashes (mirror biz `INDEXER_TX_TOPUP_CATEGORIES`).
		const hk = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s)).toLowerCase()
		const TOPUP_CATEGORIES_LOWER = new Set<string>([
			hk('usdcTopupCard'),
			hk('newCard'),
			hk('upgradeNewCard'),
			hk('topupCard'),
			hk('redeemNewCard'),
			hk('redeemUpgradeNewCard'),
			hk('redeemTopupCard'),
			hk('creditTopupCard'),
			hk('cashTopupCard'),
			hk('creditUpgradeNewCard'),
			hk('cashUpgradeNewCard'),
			hk('creditNewCard'),
			hk('cashNewCard'),
			hk('bonusCard'),
		])
		const TIP_CATEGORIES_LOWER = new Set<string>([
			hk('merchant_pay:tip_updated'),
			hk('TX_TIP'),
		])
		const SKIP_CATEGORIES_LOWER = new Set<string>([
			hk('buintClaim'),
			hk('buintUSDC'),
			hk('buintBurn'),
			hk('requestAccounting'),
			hk('sendUSDC'),
			hk('x402Send'),
		])
		const normalizeCatHex = (cat: unknown): string => {
			if (cat == null) return ''
			if (typeof cat === 'string') {
				const s = cat.trim()
				if (!s) return ''
				if (s.startsWith('0x')) return s.toLowerCase()
				try {
					return ethers.hexlify(s as ethers.BytesLike).toLowerCase()
				} catch {
					try {
						return (`0x${BigInt(s).toString(16).padStart(64, '0')}`).toLowerCase()
					} catch {
						return ''
					}
				}
			}
			try { return ethers.hexlify(cat as ethers.BytesLike).toLowerCase() } catch { return '' }
		}

		try {
			const stats = new ethers.Contract(cardAddr, ADMIN_STATS_FULL_ABI, providerConet)
			let topUpFromClear6 = 0n
			let chargeFromClear6 = 0n
			try {
				const v: any = await stats.getAdminStatsFull(adminAddr, 0, 0, 0)
				const mintFromClear = v?.mintCounterFromClear ?? v?.[16]
				const xferAmtFromClear = v?.transferAmountFromClear ?? v?.[19]
				if (mintFromClear != null) topUpFromClear6 = BigInt(mintFromClear)
				if (xferAmtFromClear != null) chargeFromClear6 = BigInt(xferAmtFromClear)
			} catch (e) {
				// `getAdminStatsFull` 可能 revert（如 admin 未登记到 card）；此时 fallback 0/0 → 不裁剪上限，仅按可获取的 items 返回。
				logger(Colors.yellow(`[posLedger] getAdminStatsFull failed admin=${adminAddr} card=${cardAddr}: ${(e as Error)?.message ?? e}`))
			}

			const indexer = new ethers.Contract(BEAMIO_INDEXER_DIAMOND, POS_LEDGER_INDEXER_ABI, providerConet)
			let total = 0n
			try { total = await indexer.getAccountActionCount(adminAddr) } catch { total = 0n }
			const totalNum = Number(total)
			if (!Number.isFinite(totalNum) || totalNum <= 0) {
				return res.status(200).json({
					ok: true,
					fromClear: { topUp6: topUpFromClear6.toString(), charge6: chargeFromClear6.toString() },
					items: [],
				}).end()
			}

			type IndexerTxRow = {
				id: string | bigint
				originalPaymentHash?: string | bigint
				txCategory: string | bigint
				displayJson?: string
				timestamp: bigint
				payer: string
				payee: string
				finalRequestAmountFiat6: bigint
				finalRequestAmountUSDC6: bigint
				meta?: { currencyFiat?: number | bigint; afterNotePayer?: string; afterNotePayee?: string }
				exists?: boolean
				topAdmin?: string
				subordinate?: string
				fees?: { bServiceUnits6?: bigint }
			}
			type SimplifiedItem = {
				id: string
				originalPaymentHash?: string
				type: 'topUp' | 'charge'
				txCategory: string
				timestamp: number
				payer: string
				payee: string
				amountUSDC6: string
				amountFiat6: string
				currencyFiat: number
				displayJson: string
				topAdmin?: string
				subordinate?: string
				note?: string
			}

			const PAGE_SIZE = 50
			const HARD_PAGE_CAP = 20 // ≤ 1000 rows scanned (safety bound)
			let topUpSum6 = 0n
			let chargeSum6 = 0n
			const items: SimplifiedItem[] = []
			let nextOffset = 0
			let pages = 0
			let stop = false
			while (!stop && pages < HARD_PAGE_CAP && nextOffset < totalNum) {
				const lim = Math.min(PAGE_SIZE, totalNum - nextOffset)
				let page: IndexerTxRow[]
				try {
					page = await indexer.getAccountTransactionsPaged(adminAddr, nextOffset, lim) as IndexerTxRow[]
				} catch (e) {
					logger(Colors.yellow(`[posLedger] getAccountTransactionsPaged failed off=${nextOffset} lim=${lim}: ${(e as Error)?.message ?? e}`))
					break
				}
				nextOffset += lim
				pages += 1
				for (const tx of page ?? []) {
					if (!tx?.exists || !tx?.id) continue
					const catHex = normalizeCatHex(tx.txCategory)
					if (catHex === '' || SKIP_CATEGORIES_LOWER.has(catHex) || TIP_CATEGORIES_LOWER.has(catHex)) continue
					const isTopUp = TOPUP_CATEGORIES_LOWER.has(catHex)
					const itemType: 'topUp' | 'charge' = isTopUp ? 'topUp' : 'charge'
					const usdc6 = BigInt(tx.finalRequestAmountUSDC6 ?? 0n)
					const fiat6 = BigInt(tx.finalRequestAmountFiat6 ?? 0n)
					const measure6 = usdc6 > 0n ? usdc6 : fiat6
					if (itemType === 'topUp') {
						const targetReached = topUpFromClear6 > 0n && topUpSum6 >= topUpFromClear6
						if (targetReached) continue
						if (topUpFromClear6 > 0n && topUpSum6 + measure6 > topUpFromClear6 + (topUpFromClear6 / 1000n)) {
							// 越界（超过目标 +0.1%）→ 该笔属于上一次 clear 之前；丢弃并视作 topUp 已完成。
							topUpSum6 = topUpFromClear6
							continue
						}
						topUpSum6 += measure6
					} else {
						const targetReached = chargeFromClear6 > 0n && chargeSum6 >= chargeFromClear6
						if (targetReached) continue
						if (chargeFromClear6 > 0n && chargeSum6 + measure6 > chargeFromClear6 + (chargeFromClear6 / 1000n)) {
							chargeSum6 = chargeFromClear6
							continue
						}
						chargeSum6 += measure6
					}
					const idStr = typeof tx.id === 'string' ? tx.id : ('0x' + BigInt(tx.id).toString(16).padStart(64, '0'))
					const ophRaw = tx.originalPaymentHash
					const ophStr = ophRaw == null
						? undefined
						: typeof ophRaw === 'string'
							? (ophRaw === ethers.ZeroHash ? undefined : ophRaw.toLowerCase())
							: ('0x' + BigInt(ophRaw).toString(16).padStart(64, '0'))
					const note = (tx.meta?.afterNotePayee || tx.meta?.afterNotePayer || '').toString()
					items.push({
						id: idStr.toLowerCase(),
						originalPaymentHash: ophStr,
						type: itemType,
						txCategory: catHex,
						timestamp: Number(tx.timestamp ?? 0n),
						payer: tx.payer ? ethers.getAddress(tx.payer).toLowerCase() : '',
						payee: tx.payee ? ethers.getAddress(tx.payee).toLowerCase() : '',
						amountUSDC6: usdc6.toString(),
						amountFiat6: fiat6.toString(),
						currencyFiat: Number(tx.meta?.currencyFiat ?? 0n),
						displayJson: tx.displayJson ?? '',
						topAdmin: tx.topAdmin && tx.topAdmin !== ethers.ZeroAddress ? ethers.getAddress(tx.topAdmin).toLowerCase() : undefined,
						subordinate: tx.subordinate && tx.subordinate !== ethers.ZeroAddress ? ethers.getAddress(tx.subordinate).toLowerCase() : undefined,
						note: note || undefined,
					})
					// 只有当 *FromClear 给出了非 0 目标且双方均已达到，才能提前 break；
					// 否则（POS EOA 不在 infraCard admin 列表导致 getAdminStatsFull 返回 0/0，或
					// 旧 Diamond 时期 subordinate 未被纳入 accountActionIds 导致目标不可达）继续翻页，
					// 由 HARD_PAGE_CAP 与 totalNum 自然兜底，避免「fromClear=0 时只回 1 条」。
					if (topUpFromClear6 > 0n && chargeFromClear6 > 0n) {
						const topUpDone = topUpSum6 >= topUpFromClear6
						const chargeDone = chargeSum6 >= chargeFromClear6
						if (topUpDone && chargeDone) {
							stop = true
							break
						}
					}
				}
				// `getAccountTransactionsPaged` returns offset 0 = newest（与 biz `pullAccountPagedWithLocalStopRule` 对齐）。
				// 当 fromClear=0/0（如 POS EOA 不在 infraCard admin 列表时 `getAdminStatsFull` revert）
				// 不再立即 break——继续翻页让 HARD_PAGE_CAP / totalNum 兜底，覆盖 ActionFacet 升级后
				// `subordinate` 也并入 accountActionIds 的全部经手记录。
			}
			items.sort((a, b) => b.timestamp - a.timestamp)
			return res.status(200).json({
				ok: true,
				fromClear: { topUp6: topUpFromClear6.toString(), charge6: chargeFromClear6.toString() },
				items,
			}).end()
		} catch (e) {
			logger(Colors.red(`[posLedger] error: ${(e as Error)?.message ?? e}`))
			return res.status(500).json({ ok: false, error: (e as Error)?.message ?? 'Internal error' }).end()
		}
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

	/** 解析 POS 可选字段：`merchantInfraCard` 指定终端登记的基础设施卡；`merchantInfraOnly` 为真时仅返回该卡一行（须有效 merchantInfraCard）。 */
	const parseMerchantInfraFetchOptions = (body: unknown): FetchUIDAssetsOptions => {
		const b = body as { merchantInfraCard?: string; merchantInfraOnly?: boolean; cardsScope?: string; includeZeroBalanceCards?: boolean }
		const raw = typeof b?.merchantInfraCard === 'string' ? b.merchantInfraCard.trim() : ''
		const resolved =
			raw !== '' && ethers.isAddress(raw)
				? ethers.getAddress(raw)
				: undefined
		const merchantInfraOnly = b?.merchantInfraOnly === true && !!resolved
		const scopeRaw = typeof b?.cardsScope === 'string' ? b.cardsScope.trim().toLowerCase() : ''
		let cardsScope: FetchUIDAssetsOptions['cardsScope'] = undefined
		if (merchantInfraOnly) {
			cardsScope = 'merchantInfraOnly'
		} else if (scopeRaw === 'infrastructureonly' || scopeRaw === 'infraonly') {
			cardsScope = 'infrastructureOnly'
		} else if (scopeRaw === 'all') {
			cardsScope = 'all'
		}
		return {
			...(resolved ? { infrastructureCardAddress: resolved } : {}),
			...(cardsScope ? { cardsScope } : {}),
			...(b?.includeZeroBalanceCards === true ? { includeZeroBalanceCards: true } : {}),
		}
	}

	/** POST /api/getUIDAssets - 查询卡资产。卡的唯一 ID 为 TagID。NFC 格式（14 位 hex uid）时：必须提供 e/c/m，SUN 解密得到 TagID，用 TagID 查 EOA/AA。beamioTab 仍按 AccountRegistry 解析。 */
	router.post('/getUIDAssets', async (req, res) => {
		const { uid, e, c, m } = req.body as { uid?: string; e?: string; c?: string; m?: string }
		const uidAssetsOpts = parseMerchantInfraFetchOptions(req.body)
		logger(Colors.cyan(`[getUIDAssets] 收到请求 uid=${uid ?? '(undefined)'}`))
		if (!uid || typeof uid !== 'string' || !uid.trim()) {
			const err = { ok: false, error: 'Missing uid' }
			logger(Colors.yellow(`[getUIDAssets] 返回 400: ${JSON.stringify(err)}`))
			return res.status(400).json(err).end()
		}
		const uidTrim = uid.trim()
		const isNfcUid = /^[0-9A-Fa-f]{14}$/.test(uidTrim)
		let nfcSunTagIdHex: string | null = null
		let sunResult: import('../BeamioSun').VerifyBeamioSunResult | null = null
		if (isNfcUid) {
			const eTrim = typeof e === 'string' ? e.trim() : ''
			const cTrim = typeof c === 'string' ? c.trim() : ''
			const mTrim = typeof m === 'string' ? m.trim() : ''
			if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
				const err = { ok: false, error: 'NFC UID requires SUN params (e, c, m) for verification. e=64 hex, c=6 hex, m=16 hex.' }
				logger(Colors.yellow(`[getUIDAssets] uid=${uidTrim} 缺少 SUN 参数 返回 403: ${JSON.stringify(err)}`))
				return res.status(403).json(err).end()
			}
			try {
				const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
				sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
				if (!sunResult.valid) {
					const err = { ok: false, error: 'SUN verification failed', macValid: sunResult.macValid, counterFresh: sunResult.counterFresh }
					logger(Colors.yellow(`[getUIDAssets] uid=${uidTrim} tagId=${sunResult.tagIdHex} SUN 校验失败: valid=${sunResult.valid} macValid=${sunResult.macValid} counterFresh=${sunResult.counterFresh}`))
					return res.status(403).json(err).end()
				}
				nfcSunTagIdHex = sunResult.tagIdHex
				logger(Colors.gray(`[getUIDAssets] uid=${uidTrim} tagId=${nfcSunTagIdHex} SUN 校验通过 counter=${sunResult.counterHex}`))
			} catch (sunErr: any) {
				const msg = sunErr?.message ?? String(sunErr)
				const err = { ok: false, error: `SUN verification error: ${msg}` }
				logger(Colors.yellow(`[getUIDAssets] uid=${uidTrim} SUN 校验异常: ${msg}`))
				return res.status(403).json(err).end()
			}
		}
		try {
			let eoaRaw: string | null
			if (nfcSunTagIdHex) {
				eoaRaw = await getNfcRecipientAddressByTagId(nfcSunTagIdHex)
				if (!eoaRaw) {
					logger(Colors.cyan(`[getUIDAssets] tagId=${nfcSunTagIdHex} 未绑定钱包，转发 Master 排队创建`))
					postLocalhost('/api/getUIDAssetsProvision', { uid: uidTrim, tagIdHex: nfcSunTagIdHex, e: req.body?.e, c: req.body?.c, m: req.body?.m }, res)
					return
				}
				// EOA 已绑定但可能无 AA（如 DeployingSmartAccount 曾失败），getOwnershipByEOA 会 revert UC_ResolveAccountFailed，需转发 Master 确保 AA
				const aaAddr = await resolveBeamioAccountOf(eoaRaw)
				let hasDeployedAA = false
				if (aaAddr && aaAddr !== ethers.ZeroAddress) {
					const code = await providerBase.getCode(aaAddr)
					hasDeployedAA = !!(code && code !== '0x' && code.length > 2)
				}
				if (!hasDeployedAA) {
					logger(Colors.cyan(`[getUIDAssets] tagId=${nfcSunTagIdHex} EOA 无已部署 AA，转发 Master 确保 AA 后拉取`))
					postLocalhost('/api/getUIDAssetsProvision', { uid: uidTrim, tagIdHex: nfcSunTagIdHex, e: req.body?.e, c: req.body?.c, m: req.body?.m }, res)
					return
				}
			} else {
				eoaRaw = await getNfcRecipientAddressByUid(uidTrim)
			}
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
				const err = { ok: false, error: 'This card is not registered' }
				logger(Colors.yellow(`[getUIDAssets] uid=${uidTrim} 卡未登记 返回 404: ${JSON.stringify(err)}`))
				return res.status(404).json(err).end()
			}
			const eoa = ethers.getAddress(eoaRaw)
			const result = await fetchUIDAssetsForEOA(eoa, uidAssetsOpts)
			const nfcExtras = nfcSunTagIdHex && sunResult ? {
				uid: uidTrim,
				tagIdHex: nfcSunTagIdHex,
				counterHex: sunResult.counterHex,
				counter: sunResult.counterValue,
			} : null
			if (nfcExtras) {
				logger(Colors.gray(`[getUIDAssets] debug 推算 tagIdHex=${nfcExtras.tagIdHex} counter=${nfcExtras.counter} counterHex=${nfcExtras.counterHex}`))
			}
			const merged = {
				...result,
				...(nfcExtras ?? {}),
			}
			if (nfcSunTagIdHex) {
				scheduleEnsureNfcBeamioTagForEoa(eoa, uidTrim, nfcSunTagIdHex, result.cards)
			}
			const resultJson = JSON.stringify(merged, null, 2)
			logger(Colors.cyan(`[getUIDAssets] 返回客户端 JSON (uid=${uidTrim}):\n${resultJson}`))
			logger(Colors.green(`[getUIDAssets] uid=${uidTrim} 成功 cards=${result.cards.length}`))
			return res.status(200).json(merged).end()
		} catch (e: any) {
			const msg = e?.shortMessage ?? e?.message ?? ''
			const isRevert = /execution reverted|CALL_EXCEPTION|revert/i.test(String(msg))
			if (isRevert) {
				const err = { ok: false, error: 'This card is not registered' }
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
		const walletAssetsOpts = parseMerchantInfraFetchOptions(req.body)
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
				const aaOwnerAbi = ['function owner() view returns (address)']
				const aaContract = new ethers.Contract(addr, aaOwnerAbi, providerBase)
				const owner = await aaContract.owner()
				if (!owner || owner === ethers.ZeroAddress) {
					const err = { ok: false, error: 'Could not resolve owner for this AA' }
					logger(Colors.yellow(`[getWalletAssets] AA 无 owner 返回 404: ${JSON.stringify(err)}`))
					return res.status(404).json(err).end()
				}
				eoa = ethers.getAddress(owner)
				/** 与 getUIDAssets 一致：aaAddress 一律为 UserCard 工厂链路的 canonical AA，禁止沿用调用方传入的「另一工厂」AA */
				const canonicalAa = await resolveBeamioAaForEoaWithFallback(providerBase, eoa)
				if (!canonicalAa) {
					const err = { ok: false, error: 'No active Beamio account for this wallet' }
					logger(Colors.yellow(`[getWalletAssets] EOA 无 canonical AA 返回 404: ${JSON.stringify(err)}`))
					return res.status(404).json(err).end()
				}
				if (canonicalAa.toLowerCase() !== addr.toLowerCase()) {
					logger(
						Colors.gray(
							`[getWalletAssets] wallet 传入 AA ${addr} 与卡工厂解析 AA ${canonicalAa} 不一致，返回 canonical（与 getOwnershipByEOA / OpenContainer 一致）`
						)
					)
				}
				aaAddr = canonicalAa
			} else {
				eoa = addr
				const primary = await resolveBeamioAaForEoaWithFallback(providerBase, eoa)
				if (!primary) {
					const err = { ok: false, error: 'No active Beamio account for this wallet' }
					logger(Colors.yellow(`[getWalletAssets] EOA 无 AA 返回 404: ${JSON.stringify(err)}`))
					return res.status(404).json(err).end()
				}
				aaAddr = primary
			}

			const base = await fetchUIDAssetsForEOA(eoa, { ...walletAssetsOpts, includeZeroBalanceCards: true })
			let unitPriceUSDC6 = '0'
			let beamioUserCard = ''
			try {
				const factoryAbi = ['function quoteUnitPointInUSDC6(address) view returns (uint256)']
				const factory = new ethers.Contract(BASE_CARD_FACTORY, factoryAbi, providerBase)
				const up = await factory.quoteUnitPointInUSDC6(BASE_CCSA_CARD_ADDRESS)
				unitPriceUSDC6 = String(up)
			} catch (_) { /* ignore */ }
			try {
				const aaFacAddr = await getAaFactoryAddressFromUserCardFactoryPaymaster(providerBase, BASE_CARD_FACTORY)
				if (aaFacAddr) {
					const aaFactoryAbi = ['function beamioUserCard() view returns (address)']
					const aaFactory = new ethers.Contract(aaFacAddr, aaFactoryAbi, providerBase)
					const uc = await aaFactory.beamioUserCard()
					if (uc && uc !== ethers.ZeroAddress) beamioUserCard = ethers.getAddress(uc)
				}
			} catch (_) { /* ignore */ }
			const cards = base.cards
			const firstCard = cards[0]
			const legacyCardFallback =
				firstCard?.cardAddress ??
				walletAssetsOpts.infrastructureCardAddress ??
				BASE_CCSA_CARD_ADDRESS
			const beamioTag = base.beamioTag ?? (await fetchBeamioTagForEoa(eoa))
			const result = {
				ok: true,
				address: base.address,
				aaAddress: aaAddr,
				cardAddress: legacyCardFallback,
				points: firstCard?.points ?? '0',
				points6: firstCard?.points6 ?? '0',
				usdcBalance: base.usdcBalance,
				cardCurrency: firstCard?.cardCurrency ?? 'CAD',
				cards,
				nfts: firstCard?.nfts ?? [],
				unitPriceUSDC6,
				beamioUserCard: beamioUserCard || undefined,
				...(beamioTag != null && beamioTag !== '' ? { beamioTag } : {}),
			}
			const resultJson = JSON.stringify(result, null, 2)
			logger(Colors.cyan(`[getWalletAssets] 返回客户端 JSON (wallet=${eoa}):\n${resultJson}`))
			logger(Colors.green(`[getWalletAssets] wallet=${eoa} aa=${aaAddr} 成功 cards=${cards.length}`))
			return res.status(200).json(result).end()
		} catch (e: any) {
			const msg = e?.shortMessage ?? e?.message ?? ''
			const isRevert = /execution reverted|CALL_EXCEPTION|revert/i.test(String(msg))
			if (isRevert) {
				const err = { ok: false, error: 'No active Beamio account for this wallet' }
				logger(Colors.yellow(`[getWalletAssets] 链上查询 revert 返回 404: ${JSON.stringify(err)}`))
				return res.status(404).json(err).end()
			}
			const err = { ok: false, error: msg || 'Query failed' }
			logger(Colors.red(`[getWalletAssets] failed: ${msg} 返回 500: ${JSON.stringify(err)}`))
			return res.status(500).json(err).end()
		}
	})

	/**
	 * POST /api/nfcCardLinkState — 用户-linked 卡：active / deactive / remove（仅 remove 会删除 DB 私钥与绑定）。
	 * Body: { message, signature } — message 为 canonical JSON UTF-8 字符串（与 wallet.signMessage(message) 一致），见 db.buildNfcCardLinkStateSignMessage。
	 */
	router.post('/nfcCardLinkState', async (req, res) => {
		const { message, signature } = req.body as { message?: string; signature?: string }
		logger(Colors.cyan(`[nfcCardLinkState] messageLen=${message != null ? String(message).length : 0}`))
		if (!message || typeof message !== 'string' || !signature || typeof signature !== 'string') {
			return res.status(400).json({ ok: false, error: 'Missing message or signature.' }).end()
		}
		try {
			const out = await applyNfcCardLinkStateChange({ message: message.trim(), signature: signature.trim() })
			if (!out.ok) {
				return res.status(400).json({ ok: false, error: out.error, errorCode: out.errorCode }).end()
			}
			return res.status(200).json({ ok: true, action: out.action, tagId: out.tagId }).end()
		} catch (e: any) {
			const msg = e?.shortMessage ?? e?.message ?? 'Request failed.'
			logger(Colors.red(`[nfcCardLinkState] ${msg}`))
			return res.status(500).json({ ok: false, error: msg }).end()
		}
	})

	/** POST /api/listLinkedNfcCards — 传入 AA 或 EOA，返回该钱包（认领时记录的 EOA）下已通过 Link App 绑定的 NFC：uid、tagId。纯 DB 读，Cluster 直出。 */
	router.post('/listLinkedNfcCards', async (req, res) => {
		const { wallet } = req.body as { wallet?: string }
		logger(Colors.cyan(`[listLinkedNfcCards] wallet=${wallet ?? '(undefined)'}`))
		if (!wallet || typeof wallet !== 'string' || !wallet.trim()) {
			return res.status(400).json({ ok: false, error: 'Missing wallet' }).end()
		}
		if (!ethers.isAddress(wallet)) {
			return res.status(400).json({ ok: false, error: 'Invalid wallet address' }).end()
		}
		try {
			const addr = ethers.getAddress(wallet.trim())
			const code = await providerBase.getCode(addr)
			const isAA = Boolean(code && code !== '0x' && code.length > 2)
			let ownerEoa: string
			if (isAA) {
				const aaContract = new ethers.Contract(addr, ['function owner() view returns (address)'], providerBase)
				const owner = await aaContract.owner()
				if (!owner || owner === ethers.ZeroAddress) {
					return res.status(400).json({ ok: false, error: 'Cannot resolve AA owner' }).end()
				}
				ownerEoa = ethers.getAddress(owner)
			} else {
				ownerEoa = addr
			}
			const cards = await listLinkedNfcCardsByOwnerEoa(ownerEoa)
			return res.status(200).json({
				ok: true,
				ownerEoa,
				inputWasSmartAccount: isAA,
				count: cards.length,
				cards,
			}).end()
		} catch (e: any) {
			const msg = e?.shortMessage ?? e?.message ?? 'Query failed'
			logger(Colors.red(`[listLinkedNfcCards] failed: ${msg}`))
			return res.status(500).json({ ok: false, error: msg }).end()
		}
	})

	/** POST /api/registerNfcCard - 登记 NFC 卡，Cluster 预检后转发 Master。tagId 可选，SUN 解密得到的 TagID（16 hex），用于合法性校验。 */
	router.post('/registerNfcCard', async (req, res) => {
		const { uid, privateKey, tagId } = req.body as { uid?: string; privateKey?: string; tagId?: string }
		if (!uid || typeof uid !== 'string' || !privateKey || typeof privateKey !== 'string') {
			return res.status(400).json({ ok: false, error: 'Missing uid or privateKey' })
		}
		logger(Colors.green('server /api/registerNfcCard preCheck OK, forwarding to master'))
		postLocalhost('/api/registerNfcCard', { uid: uid.trim(), privateKey: privateKey.trim(), ...(tagId && typeof tagId === 'string' && { tagId: tagId.trim() }) }, res)
	})

	/** POST /api/payByNfcUidPrepare - Android/iOS 构建 container 前的准备（读操作，Cluster 可直处理或转发 Master）。NFC 格式（14 位 hex uid）时：必须提供 e/c/m，SUN 校验通过后以 tagIdHex 查卡，无法推导 tagID 的不予受理。
	 *  fiat6-only 协议（推荐）：传 `amountFiat6` + `currency`（卡币种）。`amountUsdc6` 已 deprecated，仅在 `amountFiat6` 缺失时作为向后兼容回退；同时存在则忽略 `amountUsdc6` 并打 deprecation 日志。 */
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
		if (fiat6Ok && usdc6Ok) {
			logger(Colors.yellow(`[payByNfcUidPrepare][deprecation] both amountFiat6 and amountUsdc6 provided — using amountFiat6 (fiat6-only protocol). amountUsdc6 will be ignored.`))
		} else if (!fiat6Ok && usdc6Ok) {
			logger(Colors.yellow(`[payByNfcUidPrepare][deprecation] amountUsdc6-only client; please upgrade to amountFiat6+currency (see beamio-charge-fiat-only-protocol.mdc). uid=${uid.trim().slice(0, 12)}...`))
		}
		const uidTrim = uid.trim()
		const isNfcUid = /^[0-9A-Fa-f]{14}$/.test(uidTrim)
		if (isNfcUid) {
			const eTrim = typeof e === 'string' ? e.trim() : ''
			const cTrim = typeof c === 'string' ? c.trim() : ''
			const mTrim = typeof m === 'string' ? m.trim() : ''
			if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
				return res.status(403).json({ ok: false, error: 'NFC UID requires SUN params (e, c, m) for verification. e=64 hex, c=6 hex, m=16 hex.' })
			}
		}
		logger(Colors.green(`[payByNfcUidPrepare] Cluster preCheck OK forwarding to master (fiat6=${fiat6Ok ? `${fiat6Trim} ${currencyTrim}` : 'none'} usdc6=${usdc6Ok ? amountUsdc6 : 'none'})`))
		postLocalhost(
			'/api/payByNfcUidPrepare',
			{
				uid: uidTrim,
				payee: ethers.getAddress(payee),
				...(fiat6Ok ? { amountFiat6: fiat6Trim, currency: currencyTrim } : {}),
				...(usdc6Ok ? { amountUsdc6 } : {}),
				...(isNfcUid && { e, c, m }),
			},
			res
		)
	})

	/** POST /api/payByNfcUidSignContainer - 接受 Android 打包的未签名 container（写操作，Cluster 预检余额后转发 Master）。NFC 格式（14 位 hex uid）时：必须提供 e/c/m，SUN 校验通过后以 tagIdHex 查卡，无法推导 tagID 的不予受理。 */
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
			containerPayload?: import('../MemberCard').ContainerRelayPayloadUnsigned
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
		const uidTrim = uid.trim()
		const isNfcUid = /^[0-9A-Fa-f]{14}$/.test(uidTrim)
		if (isNfcUid) {
			const eTrim = typeof e === 'string' ? e.trim() : ''
			const cTrim = typeof c === 'string' ? c.trim() : ''
			const mTrim = typeof m === 'string' ? m.trim() : ''
			if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
				return res.status(403).json({ success: false, error: 'NFC UID requires SUN params (e, c, m) for verification. e=64 hex, c=6 hex, m=16 hex.' })
			}
		}
		const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : ''
		const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
		const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== ''
		const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n
		logger(Colors.cyan(`[payByNfcUidSignContainer] container uid=${uidTrim.slice(0, 16)}... amountFiat6=${fiat6Ok ? `${fiat6Trim} ${currencyTrim}` : 'none'} amountUsdc6=${usdc6Ok ? amountUsdc6 : 'none'}\n` + inspect(containerPayload, false, 4, true)))
		if (fiat6Ok && usdc6Ok) {
			logger(Colors.yellow(`[payByNfcUidSignContainer][deprecation] both amountFiat6 and amountUsdc6 provided — using amountFiat6 (fiat6-only protocol). amountUsdc6 retained for accounting fallback.`))
		} else if (!fiat6Ok && usdc6Ok) {
			logger(Colors.yellow(`[payByNfcUidSignContainer][deprecation] amountUsdc6-only client; upgrade to amountFiat6+currency. uid=${uidTrim.slice(0, 12)}...`))
		}
		const preCheck = ContainerRelayPreCheckUnsigned(containerPayload)
		if (!preCheck.success) {
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		if (!fiat6Ok && !usdc6Ok) {
			return res.status(400).json({ success: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' })
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
				return res.status(400).json({ success: false, error: 'Insufficient balance' }).end()
			}
			for (const { required, points } of cardBalances) {
				if (points < required) {
					logger(
						Colors.yellow(
							`[payByNfcUidSignContainer] Cluster 预检失败: 卡内点数不足（container account）需=${required} 有=${points}。若与 getUIDAssets 不一致，请确认 payByNfcUidPrepare 使用 UserCard 绑定 AA。`
						)
					)
					return res.status(400).json({ success: false, error: 'Insufficient balance' }).end()
				}
			}
		} catch (e: any) {
			logger(Colors.red(`[payByNfcUidSignContainer] Cluster 余额预检异常: ${e?.message ?? e}`))
			return res.status(500).json({ success: false, error: 'Balance pre-check failed' }).end()
		}
		const nfcFwd = {
			nfcSubtotalCurrencyAmount: nfcSubtotalCurrencyAmount ?? null,
			nfcTipCurrencyAmount: nfcTipCurrencyAmount ?? null,
			nfcTipRateBps: nfcTipRateBps ?? null,
			nfcRequestCurrency: nfcRequestCurrency ?? null,
			types: {
				sub: typeof nfcSubtotalCurrencyAmount,
				tip: typeof nfcTipCurrencyAmount,
				tipBps: typeof nfcTipRateBps,
				cur: typeof nfcRequestCurrency,
			},
		}
		logger(Colors.gray(`[payByNfcUidSignContainer] Cluster NFC forward snapshot: ${JSON.stringify(nfcFwd)}`))
		const strOrUndef = (v: unknown) =>
			v != null && String(v).trim() !== '' ? String(v).trim() : undefined
		const fwdSub = strOrUndef(nfcSubtotalCurrencyAmount)
		const fwdTip = strOrUndef(nfcTipCurrencyAmount)
		const fwdCur = strOrUndef(nfcRequestCurrency)
		const fwdDisc = strOrUndef(nfcDiscountAmountFiat6)
		const fwdTax = strOrUndef(nfcTaxAmountFiat6)
		if (chargeOwnerChildBurn && typeof chargeOwnerChildBurn === 'object') {
			const burnPre = await verifyChargeOwnerChildBurnClusterPreCheck({
				burn: chargeOwnerChildBurn as import('../MemberCard').ChargeOwnerChildBurnPayload,
				payeeTo: containerPayload.to,
				merchantCardAddress: undefined,
				items: containerPayload.items ?? [],
			})
			if (!burnPre.ok) {
				logger(Colors.red(`[payByNfcUidSignContainer] chargeOwnerChildBurn Cluster REJECT: ${burnPre.error}`))
				return res.status(400).json({ success: false, error: burnPre.error }).end()
			}
		}
		logger(Colors.green(`[payByNfcUidSignContainer] Cluster preCheck OK uid=${uidTrim.slice(0, 16)}... forwarding to master`))
		postLocalhost(
			'/api/payByNfcUidSignContainer',
			{
				uid: uidTrim,
				containerPayload,
				...(fiat6Ok ? { amountFiat6: fiat6Trim, currency: currencyTrim } : {}),
				...(usdc6Ok ? { amountUsdc6 } : {}),
				...(isNfcUid && { e, c, m }),
				...(fwdSub != null ? { nfcSubtotalCurrencyAmount: fwdSub } : {}),
				...(fwdTip != null ? { nfcTipCurrencyAmount: fwdTip } : {}),
				...(nfcTipRateBps != null && Number.isFinite(Number(nfcTipRateBps))
					? { nfcTipRateBps: Math.max(0, Math.min(10000, Math.trunc(Number(nfcTipRateBps)))) }
					: {}),
				...(fwdCur != null ? { nfcRequestCurrency: fwdCur } : {}),
				...(fwdDisc != null ? { nfcDiscountAmountFiat6: fwdDisc } : {}),
				...(nfcDiscountRateBps != null ? { nfcDiscountRateBps } : {}),
				...(fwdTax != null ? { nfcTaxAmountFiat6: fwdTax } : {}),
				...(nfcTaxRateBps != null ? { nfcTaxRateBps } : {}),
				...(chargeOwnerChildBurn && typeof chargeOwnerChildBurn === 'object' ? { chargeOwnerChildBurn } : {}),
			},
			res
		)
	})

	/** POST /api/payByNfcUid - 以 UID 支付（写操作，Cluster 预检后转发 Master）。
	 *  fiat6-only 协议：传 `amountFiat6` + `currency`；`amountUsdc6` 已 deprecated，仅作回退。 */
	router.post('/payByNfcUid', async (req, res) => {
		const { uid, amountUsdc6, amountFiat6, currency, payee } = req.body as { uid?: string; amountUsdc6?: string; amountFiat6?: string; currency?: string; payee?: string }
		if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
			return res.status(400).json({ success: false, error: 'Missing uid' })
		}
		const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : ''
		const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
		const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== ''
		const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n
		if (!fiat6Ok && !usdc6Ok) {
			return res.status(400).json({ success: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' })
		}
		if (fiat6Ok && usdc6Ok) {
			logger(Colors.yellow(`[payByNfcUid][deprecation] both amountFiat6 and amountUsdc6 provided — using amountFiat6 (fiat6-only protocol).`))
		} else if (!fiat6Ok && usdc6Ok) {
			logger(Colors.yellow(`[payByNfcUid][deprecation] amountUsdc6-only client; please upgrade to amountFiat6+currency. uid=${uid.trim().slice(0, 12)}...`))
		}
		const amountBig = usdc6Ok ? BigInt(String(amountUsdc6).trim()) : 0n
		if (!payee || !ethers.isAddress(payee)) {
			return res.status(400).json({ success: false, error: 'Invalid payee address' })
		}
		// 不在此做卡登记检测，直接转发 Master；Master 会从 DB 或 mnemonic 派生私钥
		logger(Colors.green(`[payByNfcUid] Cluster preCheck OK uid=${uid.trim().slice(0, 16)}... amountFiat6=${fiat6Ok ? `${fiat6Trim} ${currencyTrim}` : 'none'} amountUsdc6=${usdc6Ok ? amountUsdc6 : 'none'} payee=${ethers.getAddress(payee)} forwarding to master`))
		postLocalhost(
			'/api/payByNfcUid',
			{
				uid: uid.trim(),
				...(fiat6Ok ? { amountFiat6: fiat6Trim, currency: currencyTrim } : {}),
				...(usdc6Ok ? { amountUsdc6 } : {}),
				payee: ethers.getAddress(payee),
			},
			res
		)
	})

	/** POST /api/nfcLinkApp - POS Link App：SUN 预检 + DB 会话冲突检查，再转发 Master 登记 redeem / 写会话 */
	router.post('/nfcLinkApp', async (req, res) => {
		const body = req.body as { uid?: string; e?: string; c?: string; m?: string; cardAddress?: string }
		const uidTrim = body.uid?.trim() ?? ''
		const eTrim = body.e?.trim() ?? ''
		const cTrim = body.c?.trim() ?? ''
		const mTrim = body.m?.trim() ?? ''
		const cardRaw = typeof body.cardAddress === 'string' ? body.cardAddress.trim() : ''
		if (cardRaw && !ethers.isAddress(cardRaw)) {
			return res.status(400).json({ success: false, error: 'Invalid cardAddress.' }).end()
		}
		if (!/^[0-9A-Fa-f]{14}$/.test(uidTrim)) {
			return res.status(400).json({ success: false, error: 'Invalid uid' }).end()
		}
		if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
			return res.status(403).json({ success: false, error: 'SUN params (e, c, m) required.' }).end()
		}
		try {
			const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
			const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
			if (!sunResult.valid) {
				return res.status(403).json({ success: false, error: 'SUN verification failed.' }).end()
			}
			const nfcTxGateLink = await getNfcCardSignedTxGateByTagId(sunResult.tagIdHex)
			if (!nfcTxGateLink.ok) {
				return res.status(403).json({ success: false, error: nfcTxGateLink.message, errorCode: nfcTxGateLink.code }).end()
			}
			const blockedDetail = await nfcLinkAppNewLinkBlockedDetail(sunResult.tagIdHex)
			if (blockedDetail) {
				return res
					.status(409)
					.json({
						success: false,
						error: NFC_LINK_APP_CARD_LOCKED_MESSAGE,
						errorCode: NFC_LINK_APP_CARD_LOCKED_ERROR_CODE,
						redeemOnChain: blockedDetail.redeemOnChain,
					})
					.end()
			}
		} catch (e: any) {
			return res.status(403).json({ success: false, error: e?.message ?? String(e) }).end()
		}
		postLocalhost(
			'/api/nfcLinkApp',
			{
				uid: uidTrim,
				e: eTrim,
				c: cTrim,
				m: mTrim,
				...(cardRaw ? { cardAddress: ethers.getAddress(cardRaw) } : {}),
			},
			res
		)
	})

	/** POST /api/nfcLinkAppClaimWithKey - SilentPassUI 扫 Link 深链：校验参数与私钥格式后转 Master（redeem + 换绑 nfc_cards 私钥） */
	router.post('/nfcLinkAppClaimWithKey', async (req, res) => {
		const body = req.body as {
			nftRedeemcode?: string
			tagid?: string
			uid?: string
			counter?: string | number
			privateKey?: string
		}
		const code = typeof body.nftRedeemcode === 'string' ? body.nftRedeemcode.trim() : ''
		const tagid = typeof body.tagid === 'string' ? body.tagid.trim().replace(/^0x/i, '') : ''
		const uid = typeof body.uid === 'string' ? body.uid.trim().replace(/^0x/i, '').toLowerCase() : ''
		const pk = typeof body.privateKey === 'string' ? body.privateKey.trim() : ''
		const ctr = body.counter
		if (!code || code.toLowerCase() === 'null') {
			return res.status(400).json({ success: false, error: 'Missing nftRedeemcode.' }).end()
		}
		if (!/^[0-9a-f]{16}$/i.test(tagid)) {
			return res.status(400).json({ success: false, error: 'Invalid tagid.' }).end()
		}
		if (!/^[0-9a-f]{14}$/i.test(uid)) {
			return res.status(400).json({ success: false, error: 'Invalid uid.' }).end()
		}
		const ctrNum = typeof ctr === 'number' && Number.isFinite(ctr) ? ctr : parseInt(String(ctr ?? ''), 10)
		if (!Number.isFinite(ctrNum)) {
			return res.status(400).json({ success: false, error: 'Invalid counter.' }).end()
		}
		const pkHex = pk.startsWith('0x') ? pk : `0x${pk}`
		if (!/^0x[0-9a-fA-F]{64}$/.test(pkHex)) {
			return res.status(400).json({ success: false, error: 'Invalid private key.' }).end()
		}
		try {
			new ethers.Wallet(pkHex)
		} catch {
			return res.status(400).json({ success: false, error: 'Invalid private key.' }).end()
		}
		const claimClusterGate = await getNfcCardSignedTxGateByTagId(tagid.toUpperCase())
		if (!claimClusterGate.ok) {
			return res.status(403).json({ success: false, error: claimClusterGate.message, errorCode: claimClusterGate.code }).end()
		}
		postLocalhost('/api/nfcLinkAppClaimWithKey', req.body ?? {}, res)
	})

	/** POST /api/nfcLinkAppValidate - 校验深链参数与当前 Link App 会话一致（Cluster 直出，读共享 PG） */
	router.post('/nfcLinkAppValidate', async (req, res) => {
		const v = await nfcLinkAppValidateParams(req.body ?? {})
		if (!v.ok) return res.status(400).json({ success: false, error: v.error }).end()
		return res
			.status(200)
			.json({
				success: true,
				redeemOnChain: v.redeemOnChain,
				migrateViaContainer: v.migrateViaContainer,
			})
			.end()
	})

	/** POST /api/nfcLinkAppRelease - App 完成 Link（尤其 redeem=null 会话）后释放 DB 会话，恢复 topup/charge */
	router.post('/nfcLinkAppRelease', async (req, res) => {
		const r = await releaseNfcLinkAppLockIfSessionMatches(req.body ?? {})
		if (!r.ok) return res.status(400).json({ success: false, error: r.error }).end()
		return res.status(200).json({ success: true }).end()
	})

	/** POST /api/nfcLinkAppCancel - SUN 预检后转发 Master：链上 cancelRedeem（若有）+ 释放 DB 会话 */
	router.post('/nfcLinkAppCancel', async (req, res) => {
		const body = req.body as { uid?: string; e?: string; c?: string; m?: string }
		const uidTrim = body.uid?.trim() ?? ''
		const eTrim = body.e?.trim() ?? ''
		const cTrim = body.c?.trim() ?? ''
		const mTrim = body.m?.trim() ?? ''
		if (!/^[0-9A-Fa-f]{14}$/.test(uidTrim)) {
			return res.status(400).json({ success: false, error: 'Invalid uid' }).end()
		}
		if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
			return res.status(403).json({ success: false, error: 'SUN params (e, c, m) required.' }).end()
		}
		try {
			const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
			const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
			if (!sunResult.valid) {
				return res.status(403).json({ success: false, error: 'SUN verification failed.' }).end()
			}
		} catch (e: any) {
			return res.status(403).json({ success: false, error: e?.message ?? String(e) }).end()
		}
		postLocalhost('/api/nfcLinkAppCancel', { uid: uidTrim, e: eTrim, c: cTrim, m: mTrim }, res)
	})

	/** POST /api/burnPointsByAdminPrepare - 返回 executeForAdmin 所需的 cardAddr、data、deadline、nonce。Admin 离线签字后提交 /api/nfcTopup。target 为被 burn 的地址，amount 为 "max" 表示 burn 全部。 */
	router.post('/burnPointsByAdminPrepare', async (req, res) => {
		const { cardAddress, target, amount } = req.body as { cardAddress?: string; target?: string; amount?: string }
		const allow = await verifyBurnPointsByAdminPrepareAllowed({
			cardAddress: cardAddress ?? '',
			target: target ?? '',
		})
		if (!allow.ok) {
			logger(Colors.yellow(`[burnPointsByAdminPrepare] Cluster REJECT: ${allow.error}`))
			return res.status(400).json({ success: false, error: allow.error }).end()
		}
		const result = await burnPointsByAdminPreparePayload({ cardAddress: cardAddress ?? '', target: target ?? '', amount: amount ?? '0' })
		if ('error' in result) return res.status(400).json({ success: false, error: result.error })
		res.status(200).json(result).end()
	})

	/** POST /api/nfcTopupPrepare - 转发到 Master，返回 executeForAdmin 所需的 cardAddr、data、deadline、nonce。cardAddress 必填；支持 uid（NFC）、wallet（Scan QR）或 beamioTag（Scan QR 的 beamio 参数，按 AccountRegistry 解析 EOA）。NFC 格式（14 位 hex uid）时：必须提供 e/c/m，SUN 校验通过后以 tagIdHex 查 EOA，无法推导 tagID 的不予受理。 */
	router.post('/nfcTopupPrepare', async (req, res) => {
		const { uid, wallet, beamioTag, amount, currency, cardAddress, e, c, m } = req.body as { uid?: string; wallet?: string; beamioTag?: string; amount?: string; currency?: string; cardAddress?: string; e?: string; c?: string; m?: string }
		const hasUid = uid && typeof uid === 'string' && uid.trim().length > 0
		const uidTrim = hasUid ? uid!.trim() : ''
		const isNfcUid = /^[0-9A-Fa-f]{14}$/.test(uidTrim)
		let resolvedWallet: string | undefined = wallet && typeof wallet === 'string' && ethers.isAddress(wallet.trim()) ? ethers.getAddress(wallet.trim()) : undefined
		const hasBeamioTag = beamioTag && typeof beamioTag === 'string' && beamioTag.trim().length > 0
		let nfcSunTagForEnsure: string | null = null
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
			return res.status(400).json({ success: false, error: hasBeamioTag ? 'Could not resolve beamioTag to a valid wallet' : 'Missing uid or wallet' })
		}
		if (!cardAddress || typeof cardAddress !== 'string' || !ethers.isAddress(cardAddress.trim())) {
			return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' })
		}
		// NFC 格式 uid：必须提供 e/c/m，SUN 校验，用 tagIdHex 查 EOA；不符合 SUN 或无法推导 tagID 的不予受理
		if (hasUid && isNfcUid) {
			const eTrim = typeof e === 'string' ? e.trim() : ''
			const cTrim = typeof c === 'string' ? c.trim() : ''
			const mTrim = typeof m === 'string' ? m.trim() : ''
			if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
				const err = { success: false, error: 'NFC UID requires SUN params (e, c, m) for verification. e=64 hex, c=6 hex, m=16 hex.' }
				logger(Colors.yellow(`[nfcTopupPrepare] uid=${uidTrim} 缺少 SUN 参数 返回 403: ${JSON.stringify(err)}`))
				return res.status(403).json(err).end()
			}
			try {
				const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
				const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
				if (!sunResult.valid) {
					const err = { success: false, error: 'SUN verification failed', macValid: sunResult.macValid, counterFresh: sunResult.counterFresh }
					logger(Colors.yellow(`[nfcTopupPrepare] uid=${uidTrim} tagId=${sunResult.tagIdHex} SUN 校验失败: valid=${sunResult.valid}`))
					return res.status(403).json(err).end()
				}
				const topPrepGate = await getNfcCardSignedTxGateByTagId(sunResult.tagIdHex)
				if (!topPrepGate.ok) {
					return res.status(403).json({ success: false, error: topPrepGate.message, errorCode: topPrepGate.code }).end()
				}
				const eoaFromTag = await getNfcRecipientAddressByTagId(sunResult.tagIdHex)
				if (!eoaFromTag || !ethers.isAddress(eoaFromTag)) {
					const err = { success: false, error: 'Card not provisioned. SUN valid but tagId not bound to wallet.' }
					logger(Colors.yellow(`[nfcTopupPrepare] uid=${uidTrim} tagId=${sunResult.tagIdHex} 未绑定钱包 返回 403`))
					return res.status(403).json(err).end()
				}
				resolvedWallet = ethers.getAddress(eoaFromTag)
				nfcSunTagForEnsure = sunResult.tagIdHex
				logger(Colors.gray(`[nfcTopupPrepare] uid=${uidTrim} SUN 校验通过 tagId=${sunResult.tagIdHex.slice(0, 8)}... wallet=${resolvedWallet.slice(0, 10)}...`))
			} catch (sunErr: any) {
				const msg = sunErr?.message ?? String(sunErr)
				const err = { success: false, error: `SUN verification error: ${msg}` }
				logger(Colors.yellow(`[nfcTopupPrepare] uid=${uidTrim} SUN 校验异常: ${msg}`))
				return res.status(403).json(err).end()
			}
		}
		const forwardBody = {
			uid: hasUid && !resolvedWallet ? uid!.trim() : undefined,
			wallet: resolvedWallet,
			amount: String(amount ?? ''),
			currency: (currency || 'CAD').trim(),
			cardAddress: ethers.getAddress(cardAddress.trim())
		}
		try {
			let prepareCardOwner = ''
			try {
				const cprep = new ethers.Contract(forwardBody.cardAddress, ['function owner() view returns (address)'], providerBase)
				const ow = await cprep.owner() as string
				if (ow && ethers.isAddress(ow)) prepareCardOwner = ethers.getAddress(ow)
			} catch { /* ignore */ }
			const walletLabel = forwardBody.wallet ?? (forwardBody.uid ? `(uid=${forwardBody.uid})` : 'N/A')
			logger(Colors.cyan(`[nfcTopupPrepare] POS prepare summary | cardAddr=${forwardBody.cardAddress} | cardOwner=${prepareCardOwner || 'N/A'} | amount=${forwardBody.amount} | currency=${forwardBody.currency} | payeeWallet=${walletLabel}`))
			const { statusCode, body } = await postLocalhostBuffer('/api/nfcTopupPrepare', forwardBody)
			const parsed = JSON.parse(body)
			if (resolvedWallet && (hasBeamioTag || (hasUid && isNfcUid)) && parsed.cardAddr && !parsed.error) {
				parsed.wallet = resolvedWallet
			}
			if (resolvedWallet && hasUid && isNfcUid && nfcSunTagForEnsure && parsed.cardAddr && !parsed.error) {
				try {
					const aa = await resolveBeamioAccountOf(ethers.getAddress(resolvedWallet))
					if (aa && aa !== ethers.ZeroAddress) {
						const code = await providerBase.getCode(aa)
						if (code && code !== '0x' && code.length > 2) {
							scheduleEnsureNfcBeamioTagForEoa(ethers.getAddress(resolvedWallet), uidTrim, nfcSunTagForEnsure, null)
						}
					}
				} catch (_) {
					/* non-fatal */
				}
			}
			res.status(statusCode).json(parsed).end()
		} catch (e: any) {
			logger(Colors.red(`[nfcTopupPrepare] forward failed: ${e?.message ?? e}`))
			res.status(502).json({ success: false, error: `Forward to master failed: ${e?.message ?? e}` }).end()
		}
	})

	/** POST /api/nfcTopup - NFC 卡向 CCSA 充值：读取方 UI 用户用 profile 私钥签 ExecuteForAdmin，Cluster 预检签名与 isAdmin 后转发 Master。当 uid 为 NFC 格式（14 位 hex）时：必须提供 e/c/m，SUN 校验通过才转发，不符合 SUN 或无法推导 tagID 的不予受理。 */
	router.post('/nfcTopup', async (req, res) => {
		const {
			cardAddr,
			data,
			deadline,
			nonce,
			adminSignature,
			uid,
			e,
			c,
			m,
			cardCurrencyAmount,
			cashCurrencyAmount,
			bonusCurrencyAmount,
			currencyAmount,
		} = req.body as {
			cardAddr?: string
			data?: string
			deadline?: number
			nonce?: string
			adminSignature?: string
			uid?: string
			e?: string
			c?: string
			m?: string
			cardCurrencyAmount?: string
			cashCurrencyAmount?: string
			bonusCurrencyAmount?: string
			currencyAmount?: string
		}
		let nfcTagIdHex: string | null = null
		let nfcLinkedEOA: string | null = null
		const uidTrim = uid && typeof uid === 'string' ? uid.trim() : ''
		const isNfcUid = uidTrim.length > 0 && /^[0-9A-Fa-f]{14}$/.test(uidTrim)
		if (isNfcUid) {
			const eTrim = typeof e === 'string' ? e.trim() : ''
			const cTrim = typeof c === 'string' ? c.trim() : ''
			const mTrim = typeof m === 'string' ? m.trim() : ''
			if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
				const err = { success: false, error: 'NFC UID requires SUN params (e, c, m) for verification. e=64 hex, c=6 hex, m=16 hex.' }
				logger(Colors.yellow(`[nfcTopup] uid=${uidTrim} 缺少 SUN 参数 返回 403: ${JSON.stringify(err)}`))
				return res.status(403).json(err).end()
			}
			try {
				const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
				const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
				if (!sunResult.valid) {
					const err = { success: false, error: 'SUN verification failed', macValid: sunResult.macValid, counterFresh: sunResult.counterFresh }
					logger(Colors.yellow(`[nfcTopup] uid=${uidTrim} tagId=${sunResult.tagIdHex} SUN 校验失败: valid=${sunResult.valid}`))
					return res.status(403).json(err).end()
				}
				nfcTagIdHex = sunResult.tagIdHex
				const topGate = await getNfcCardSignedTxGateByTagId(nfcTagIdHex)
				if (!topGate.ok) {
					const err = { success: false, error: topGate.message, errorCode: topGate.code }
					logger(Colors.yellow(`[nfcTopup] uid=${uidTrim} NFC gate: ${topGate.code}`))
					return res.status(403).json(err).end()
				}
				nfcLinkedEOA = await getNfcRecipientAddressByTagId(nfcTagIdHex)
				logger(Colors.gray(`[nfcTopup] uid=${uidTrim} SUN 校验通过 tagId=${sunResult.tagIdHex.slice(0, 8)}...`))
			} catch (sunErr: any) {
				const msg = sunErr?.message ?? String(sunErr)
				const err = { success: false, error: `SUN verification error: ${msg}` }
				logger(Colors.yellow(`[nfcTopup] uid=${uidTrim} SUN 校验异常: ${msg}`))
				return res.status(403).json(err).end()
			}
		}
		if (!cardAddr || !ethers.isAddress(cardAddr) || !data || typeof data !== 'string' || data.length === 0) {
			return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr/data' })
		}
		if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string' || !adminSignature || typeof adminSignature !== 'string') {
			return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce/adminSignature' })
		}
		try {
			const adminManagerIface4 = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata)'])
			const adminManagerIface5 = new ethers.Interface([
				'function adminManager(address to, bool admin, uint256 newThreshold, string metadata, uint256 mintLimit)',
			])
			const adminManagerSel4 = (adminManagerIface4.getFunction('adminManager')?.selector ?? '').toLowerCase()
			const adminManagerSel5 = (adminManagerIface5.getFunction('adminManager')?.selector ?? '').toLowerCase()
			const dataSel = data.slice(0, 10).toLowerCase()
			const isMint = data.startsWith(MINT_POINTS_BY_ADMIN_SELECTOR)
			const isBurn = data.startsWith(BURN_POINTS_BY_ADMIN_SELECTOR)
			const isAdminManager = dataSel === adminManagerSel4 || dataSel === adminManagerSel5
			if (!isMint && !isBurn && !isAdminManager) {
				return res.status(400).json({ success: false, error: 'executeForAdmin only supports mintPointsByAdmin, burnPointsByAdmin, or adminManager' })
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
			const cardAbi = ['function isAdmin(address) view returns (bool)', 'function owner() view returns (address)', 'function adminParent(address) view returns (address)']
			const card = new ethers.Contract(cardAddress, cardAbi, providerBase)
			const isAdmin = await card.isAdmin(signer)
			if (!isAdmin) {
				const mintParsed = tryParseMintPointsByAdminArgs(data)
				const recipientTo = mintParsed?.recipient ?? tryParseMintPointsByAdminRecipient(data)
				const points6 = mintParsed?.points6 ?? 0n
				let cardOwner = ''
				let signerAdminParent = ''
				try {
					cardOwner = await card.owner() as string
					signerAdminParent = await card.adminParent(signer) as string
				} catch (_) { /* ignore */ }
				const nfcLinkedAA = nfcLinkedEOA ? await resolveBeamioAccountOf(nfcLinkedEOA) : null
				logger(Colors.red(`[nfcTopup] Signer is not card admin - DEBUG: cardAddr=${cardAddress} | tagIdHex=${nfcTagIdHex ?? '(not NFC)'} | tagIdLinkedEOA=${nfcLinkedEOA ?? 'N/A'} | tagIdLinkedAA=${nfcLinkedAA ?? 'N/A'} | toRecipient=${recipientTo ?? 'N/A'} | amountPoints6=${points6.toString()} | cardOwner=${cardOwner || 'N/A'} | signer=${signer} | signerAdminParent=${signerAdminParent || 'N/A'}`))
				return res.status(403).json({
					success: false,
					error: 'Signer is not card admin',
					signer,
					cardOwner: cardOwner || undefined,
					cardAddr: cardAddress
				})
			}
			/** adminManager(add) 经 nfcTopup 时须与 cardAddAdminByAdmin 一致：禁止同一终端 EOA 已绑定其他商户卡后再加为 admin（此前仅此路径未做 DB 预检）。 */
			if (isAdminManager) {
				const iface = dataSel === adminManagerSel5 ? adminManagerIface5 : adminManagerIface4
				try {
					const decoded = iface.parseTransaction({ data })
					if (decoded?.name === 'adminManager' && decoded.args[1] === true) {
						const toRaw = decoded.args[0] as string
						if (!toRaw || !ethers.isAddress(toRaw)) {
							return res.status(400).json({ success: false, error: 'Invalid adminManager to address' }).end()
						}
						const toCandidate = ethers.getAddress(toRaw)
						const codeAtTo = await providerBase.getCode(toCandidate)
						if (codeAtTo && codeAtTo !== '0x' && codeAtTo.length > 2) {
							return res
								.status(400)
								.json({ success: false, error: 'Adding AA as admin via nfcTopup is not allowed. Encode adminManager with the terminal EOA as to.' })
								.end()
						}
						const bindCheck = await assertPosEoaAvailableForCardBinding(toCandidate, cardAddress)
						if (!bindCheck.ok) {
							return res.status(400).json({ success: false, error: bindCheck.error }).end()
						}
					}
				} catch (e: any) {
					return res
						.status(400)
						.json({ success: false, error: e?.shortMessage ?? e?.message ?? 'Invalid adminManager calldata' })
						.end()
				}
			}
			let cardOwnerForLog = ''
			try {
				const ow = await card.owner() as string
				if (ow && ethers.isAddress(ow)) cardOwnerForLog = ethers.getAddress(ow)
			} catch { /* ignore */ }
			let topupSummaryOp = 'adminManager'
			let topupSummaryPoints6 = ''
			let topupSummaryRecipient = 'N/A'
			if (isMint) {
				const mp = tryParseMintPointsByAdminArgs(data)
				topupSummaryOp = 'mintPointsByAdmin'
				topupSummaryPoints6 = mp?.points6 !== undefined ? mp.points6.toString() : ''
				topupSummaryRecipient = mp?.recipient ?? tryParseMintPointsByAdminRecipient(data) ?? 'N/A'
			} else if (isBurn) {
				const bp = tryParseBurnPointsByAdminArgs(data)
				topupSummaryOp = 'burnPointsByAdmin'
				if (bp) {
					topupSummaryPoints6 = bp.points6.toString()
					topupSummaryRecipient = bp.target
				}
			}
			logger(Colors.cyan(`[nfcTopup] POS topup summary | cardAddr=${cardAddress} | cardOwner=${cardOwnerForLog || 'N/A'} | posEOA=${signer} | op=${topupSummaryOp} | points6=${topupSummaryPoints6 || 'N/A'} | recipient=${topupSummaryRecipient} | uid=${uidTrim || '(none)'}`))
			let recipientEOA: string | null = null
			let aaAddr: string | null = null
			let bunitFeeCheck: { success: boolean; error?: string; feeAmount?: bigint; cardOwnerEOA?: string; topupKind?: 2 | 3 } = { success: true }
			if (isMint) {
				recipientEOA = tryParseMintPointsByAdminRecipient(data)
				if (!recipientEOA || !ethers.isAddress(recipientEOA)) {
					return res.status(400).json({ success: false, error: 'Invalid mintPointsByAdmin payload' })
				}
				const mintAmt = tryParseMintPointsByAdminArgs(data)
				if (!mintAmt || mintAmt.points6 <= 0n) {
					return res.status(400).json({ success: false, error: 'Invalid mintPointsByAdmin amount' })
				}
				const airdropLimitCheck = await nfcTopupPreCheckAdminAirdropLimit(cardAddress, signer, mintAmt.points6)
				if (!airdropLimitCheck.success) {
					logger(Colors.red(`[nfcTopup] admin airdrop limit pre-check FAIL: ${airdropLimitCheck.error}`))
					return res.status(400).json({ success: false, error: airdropLimitCheck.error }).end()
				}
				aaAddr = recipientEOA ? await resolveBeamioAccountOf(recipientEOA) : null
				bunitFeeCheck = await nfcTopupPreCheckBUnitFee(cardAddress, data)
				if (!bunitFeeCheck.success) {
					logger(Colors.red(`[nfcTopup] B-Unit fee pre-check FAIL: ${bunitFeeCheck.error}`))
					return res.status(400).json({ success: false, error: bunitFeeCheck.error }).end()
				}
			}
			logger(Colors.green(`server /api/nfcTopup preCheck OK | uid=${uid ?? '(not provided)'} | wallet=${recipientEOA ?? 'N/A'} | AA=${aaAddr ?? 'N/A'} | fee=${Number(bunitFeeCheck.feeAmount ?? 0) / 1e6} B-Units | forwarding to master`))
			const parseTopupCurrencyE6Cluster = (raw: unknown): bigint => {
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
			const splitCluster: {
				cardCurrencyAmount?: string
				cashCurrencyAmount?: string
				bonusCurrencyAmount?: string
				currencyAmount?: string
			} = {}
			if (isMint) {
				const anySplitField =
					(cardCurrencyAmount != null && String(cardCurrencyAmount).trim() !== '') ||
					(cashCurrencyAmount != null && String(cashCurrencyAmount).trim() !== '') ||
					(bonusCurrencyAmount != null && String(bonusCurrencyAmount).trim() !== '') ||
					(currencyAmount != null && String(currencyAmount).trim() !== '')
				if (anySplitField) {
					const cE = parseTopupCurrencyE6Cluster(cardCurrencyAmount)
					const cashE = parseTopupCurrencyE6Cluster(cashCurrencyAmount)
					const bE = parseTopupCurrencyE6Cluster(bonusCurrencyAmount)
					const totE = parseTopupCurrencyE6Cluster(currencyAmount)
					if (cE < 0n || cashE < 0n || bE < 0n || totE < 0n) {
						return res.status(400).json({ success: false, error: 'Invalid top-up currency split amounts' }).end()
					}
					if (totE <= 0n || cE + cashE + bE !== totE) {
						return res
							.status(400)
							.json({
								success: false,
								error:
									'cardCurrencyAmount + cashCurrencyAmount + bonusCurrencyAmount must equal currencyAmount (6 decimal places)',
							})
							.end()
					}
					splitCluster.cardCurrencyAmount = ethers.formatUnits(cE, 6)
					splitCluster.cashCurrencyAmount = ethers.formatUnits(cashE, 6)
					splitCluster.bonusCurrencyAmount = ethers.formatUnits(bE, 6)
					splitCluster.currencyAmount = ethers.formatUnits(totE, 6)
				}
			}
			if (isNfcUid && nfcLinkedEOA && nfcTagIdHex && ethers.isAddress(nfcLinkedEOA)) {
				try {
					const aaNfc = await resolveBeamioAccountOf(ethers.getAddress(nfcLinkedEOA))
					if (aaNfc && aaNfc !== ethers.ZeroAddress) {
						const codeNfc = await providerBase.getCode(aaNfc)
						if (codeNfc && codeNfc !== '0x' && codeNfc.length > 2) {
							scheduleEnsureNfcBeamioTagForEoa(ethers.getAddress(nfcLinkedEOA), uidTrim, nfcTagIdHex, null)
						}
					}
				} catch (_) {
					/* non-fatal */
				}
			}
			postLocalhost(
				'/api/nfcTopup',
				{
					cardAddr: cardAddress,
					data,
					deadline,
					nonce,
					adminSignature,
					uid: typeof uid === 'string' ? uid : undefined,
					cardOwnerEOA: bunitFeeCheck.cardOwnerEOA,
					topupFeeBUnits: bunitFeeCheck.feeAmount?.toString(),
					topupKind: bunitFeeCheck.topupKind,
					...splitCluster,
				},
				res
			)
		} catch (e: any) {
			logger(Colors.red(`[nfcTopup] preCheck failed: ${e?.message ?? e}`))
			return res.status(400).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'PreCheck failed' })
		}
	})

	/** GET /api/nfcUsdcTopupQuote
	 * 客户端浏览器钱包页面（verra-home /usdc-topup）展示价格用：根据 currency 与 amount 用 Oracle 折算 USDC6。
	 * Query: card, owner, amount, currency。
	 * 同步校验 card.owner() 是否与 owner 一致，避免任意 payTo 注入误用。 */
	router.get('/nfcUsdcTopupQuote', async (req, res) => {
		try {
			const { card, owner, amount, currency } = req.query as { card?: string; owner?: string; amount?: string; currency?: string }
			if (!card || !ethers.isAddress(String(card).trim())) {
				return res.status(400).json({ success: false, error: 'Invalid card' }).end()
			}
			if (!owner || !ethers.isAddress(String(owner).trim())) {
				return res.status(400).json({ success: false, error: 'Invalid owner' }).end()
			}
			const cur = (currency || 'CAD').toString().trim().toUpperCase()
			const amt = String(amount ?? '').trim()
			if (!amt || !(Number(amt) > 0)) {
				return res.status(400).json({ success: false, error: 'Invalid amount' }).end()
			}
			const cardAddr = ethers.getAddress(String(card).trim())
			const ownerAddr = ethers.getAddress(String(owner).trim())
			let onChainOwner: string | null = null
			try {
				const c = new ethers.Contract(cardAddr, ['function owner() view returns (address)'], providerBase)
				const o = (await c.owner()) as string
				if (o && ethers.isAddress(o)) onChainOwner = ethers.getAddress(o)
			} catch (_) { /* tolerate transient rpc */ }
			if (onChainOwner && onChainOwner !== ownerAddr) {
				return res.status(400).json({ success: false, error: `cardOwner mismatch (on-chain ${onChainOwner.slice(0, 10)}…)` }).end()
			}
			const usdc6 = quoteCurrencyToUsdc6(amt, cur)
			if (usdc6 <= 0n) {
				const fresh = isOracleFresh()
				const oracleTs = (clusterOracleCache?.timestamp ?? 0) as number
				logger(Colors.yellow(`[nfcUsdcTopupQuote] oracle quote=0 cur=${cur} amt=${amt} fresh=${fresh} oracleTs=${oracleTs}`))
				return res.status(503).json({
					success: false,
					error: fresh
						? `Oracle rate not available for ${cur}, please retry shortly`
						: `Oracle rate stale, please retry shortly`,
				}).end()
			}
			return res.status(200).json({
				success: true,
				cardAddress: cardAddr,
				cardOwner: onChainOwner ?? ownerAddr,
				currency: cur,
				amount: amt,
				quotedUsdc6: usdc6.toString(),
				quotedUsdc: ethers.formatUnits(usdc6, 6),
				oracleTimestamp: Number(clusterOracleCache?.timestamp ?? 0),
			}).end()
		} catch (e: any) {
			logger(Colors.red(`[nfcUsdcTopupQuote] error: ${e?.message ?? e}`))
			return res.status(500).json({ success: false, error: e?.message ?? String(e) }).end()
		}
	})

	/** POST /api/nfcUsdcTopup
	 * x402（EIP-3009）：客户用任意外部钱包浏览器（MetaMask 等）为 NFC POS topup 付 USDC。
	 * 流程：
	 *   1. 校验 body 参数（cardAddress、cardOwner、uid+SUN e/c/m、amount、currency）
	 *   2. SUN 校验通过后用 tagId 查 NFC 持卡人 EOA（recipientEOA）
	 *   3. 校验 card.owner() == cardOwner（payTo 一致性）
	 *   4. nfcTopupPreparePayload 拿到 ExecuteForAdmin 的 data/deadline/nonce（mintPointsByAdmin → recipientEOA, points6）
	 *   5. quoteCurrencyToUsdc6 计算需付 USDC6
	 *   6. 构造 paymentRequirements(payTo=cardOwner) 通过 verifyPaymentNew 走 x402 协议
	 *   7. settle USDC（transferWithAuthorization → cardOwner）
	 *   8. 转发 Master /api/nfcUsdcTopup，由 Master 用 service-admin key 签 ExecuteForAdmin 后 push executeForAdminPool
	 */
	router.post('/nfcUsdcTopup', async (req, res) => {
		const { cardAddress, cardOwner, uid, e, c, m, amount, currency } = req.body as {
			cardAddress?: string
			cardOwner?: string
			uid?: string
			e?: string
			c?: string
			m?: string
			amount?: string
			currency?: string
		}
		try {
			if (!cardAddress || !ethers.isAddress(String(cardAddress).trim())) {
				return res.status(400).json({ success: false, error: 'Invalid cardAddress' }).end()
			}
			if (!cardOwner || !ethers.isAddress(String(cardOwner).trim())) {
				return res.status(400).json({ success: false, error: 'Invalid cardOwner' }).end()
			}
			const uidTrim = (uid ?? '').trim()
			const eTrim = (e ?? '').trim()
			const cTrim = (c ?? '').trim()
			const mTrim = (m ?? '').trim()
			if (!/^[0-9A-Fa-f]{14}$/.test(uidTrim)) {
				return res.status(400).json({ success: false, error: 'Invalid uid (expect 14-hex NFC UID)' }).end()
			}
			if (eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
				return res.status(400).json({ success: false, error: 'NFC UID requires SUN params (e=64 hex, c=6 hex, m=16 hex)' }).end()
			}
			const cur = (currency || 'CAD').trim().toUpperCase()
			const amt = String(amount ?? '').trim()
			if (!amt || !(Number(amt) > 0)) {
				return res.status(400).json({ success: false, error: 'Invalid amount' }).end()
			}
			const cardAddr = ethers.getAddress(String(cardAddress).trim())
			const ownerAddr = ethers.getAddress(String(cardOwner).trim())

			// 1. SUN 校验 + recipient 解析（与 /api/nfcTopupPrepare 同一组合：SUN→tagId→DB EOA）
			let recipientEOA: string | null = null
			let tagIdHex: string | null = null
			try {
				const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
				const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
				if (!sunResult.valid) {
					logger(Colors.yellow(`[nfcUsdcTopup] uid=${uidTrim} SUN 校验失败 valid=${sunResult.valid}`))
					return res.status(403).json({ success: false, error: 'SUN verification failed', macValid: sunResult.macValid, counterFresh: sunResult.counterFresh }).end()
				}
				tagIdHex = sunResult.tagIdHex
				const topGate = await getNfcCardSignedTxGateByTagId(tagIdHex)
				if (!topGate.ok) {
					return res.status(403).json({ success: false, error: topGate.message, errorCode: topGate.code }).end()
				}
				const eoaFromTag = await getNfcRecipientAddressByTagId(tagIdHex)
				if (!eoaFromTag || !ethers.isAddress(eoaFromTag)) {
					return res.status(403).json({ success: false, error: 'Card not provisioned. SUN valid but tagId not bound to wallet.' }).end()
				}
				recipientEOA = ethers.getAddress(eoaFromTag)
			} catch (sunErr: any) {
				logger(Colors.yellow(`[nfcUsdcTopup] uid=${uidTrim} SUN 校验异常: ${sunErr?.message ?? sunErr}`))
				return res.status(403).json({ success: false, error: `SUN verification error: ${sunErr?.message ?? sunErr}` }).end()
			}

			// 2. 校验 card.owner() 一致性（防止 payTo 被注入）
			let onChainOwner: string | null = null
			try {
				const cprep = new ethers.Contract(cardAddr, ['function owner() view returns (address)'], providerBase)
				const o = (await cprep.owner()) as string
				if (o && ethers.isAddress(o)) onChainOwner = ethers.getAddress(o)
			} catch (_) { /* tolerate */ }
			if (onChainOwner && onChainOwner !== ownerAddr) {
				return res.status(400).json({ success: false, error: `cardOwner mismatch (on-chain ${onChainOwner.slice(0, 10)}…)` }).end()
			}
			const payToOwner = onChainOwner ?? ownerAddr

			// 3. 准备 ExecuteForAdmin payload（mintPointsByAdmin → recipientEOA, points6）。
			//    nfcTopupPreparePayload 内部以 wallet=recipientEOA 跳过 SUN 走 wallet 直发路径
			const prepared = await nfcTopupPreparePayload({
				wallet: recipientEOA,
				amount: amt,
				currency: cur,
				cardAddress: cardAddr,
			})
			if ('error' in prepared) {
				return res.status(400).json({ success: false, error: prepared.error }).end()
			}

			// 4. USDC 报价 - **严格 Oracle**：oracle 缺失/stale 时拒绝，不允许用固定汇率报价
			const quotedUsdc6 = quoteCurrencyToUsdc6(amt, cur)
			if (quotedUsdc6 <= 0n) {
				const fresh = isOracleFresh()
				logger(Colors.yellow(`[nfcUsdcTopup] oracle quote=0 cur=${cur} amt=${amt} fresh=${fresh}`))
				return res.status(503).json({
					success: false,
					error: fresh
						? `Oracle rate not available for ${cur}, please retry shortly`
						: `Oracle rate stale, please retry shortly`,
				}).end()
			}

			// 5. x402 verify + settle（verifyPaymentNew 内部已处理 402 / 余额 / 时效）
			const settled = await settleBeamioX402ToCardOwner(req, res, {
				cardOwner: payToOwner,
				quotedUsdc6,
				description: `Beamio NFC USDC Topup (${cur} ${amt} → card ${cardAddr.slice(0, 8)}…)`,
			})
			if (!settled) return // 响应已在 helper 内写出

			logger(Colors.green(`[nfcUsdcTopup] settle OK card=${cardAddr} payer=${settled.payer} usdc6=${settled.usdcAmount6} USDC_tx=${settled.USDC_tx} → forward Master to mint points to recipient=${recipientEOA}`))

			// 6. 转发 Master 触发 ExecuteForAdmin（由 Master 用 service admin key 签 + push executeForAdminPool）
			postLocalhost(
				'/api/nfcUsdcTopup',
				{
					cardAddr: prepared.cardAddr,
					data: prepared.data,
					deadline: prepared.deadline,
					nonce: prepared.nonce,
					recipientEOA,
					cardOwner: payToOwner,
					currency: cur,
					currencyAmount: amt,
					payer: settled.payer,
					USDC_tx: settled.USDC_tx,
					usdcAmount6: settled.usdcAmount6.toString(),
					nfcUid: uidTrim,
					nfcTagIdHex: tagIdHex,
				},
				res
			)
		} catch (err: any) {
			logger(Colors.red(`[nfcUsdcTopup] error: ${err?.message ?? err}`))
			if (!res.headersSent) {
				res.status(500).json({ success: false, error: err?.message ?? String(err) }).end()
			}
		}
	})

	/**
	 * Charge breakdown 归一化（与 NFC charge `nfcBill` 字段对齐：subtotal/discount/tax/tip + 可选 bps）。
	 * total = subtotal - discount + tax + tip（任一负数视为 0；total 为最小可报价基数）。
	 * 返回 currency-amount 文本（保留两位小数；total 用 ceil 处理误差）+ atomic E6（用于审计/记账）。
	 */
	const normalizeChargeBreakdown = (raw: {
		subtotal?: string | number
		discount?: string | number
		tax?: string | number
		tip?: string | number
		discountBps?: string | number
		taxBps?: string | number
		tipBps?: string | number
	}): {
		subtotal: number
		discount: number
		tax: number
		tip: number
		total: number
		discountBps: number
		taxBps: number
		tipBps: number
	} => {
		const num = (v: unknown): number => {
			if (v === undefined || v === null) return 0
			const n = Number(String(v).replace(/,/g, '').trim())
			return Number.isFinite(n) && n > 0 ? n : 0
		}
		const intBps = (v: unknown): number => {
			if (v === undefined || v === null) return 0
			const n = Math.round(Number(v))
			return Number.isFinite(n) && n >= 0 ? n : 0
		}
		const subtotal = num(raw.subtotal)
		const discount = num(raw.discount)
		const tax = num(raw.tax)
		const tip = num(raw.tip)
		const total = Math.max(0, subtotal - discount + tax + tip)
		return {
			subtotal,
			discount,
			tax,
			tip,
			total,
			discountBps: intBps(raw.discountBps),
			taxBps: intBps(raw.taxBps),
			tipBps: intBps(raw.tipBps),
		}
	}

	/** GET /api/nfcUsdcChargeQuote
	 * 客户端浏览器钱包页面（verra-home /usdc-charge）展示价格用：根据 charge breakdown + currency 用 Oracle 折算 USDC6。
	 * Query: card, owner, subtotal, discount, tax, tip, discountBps, taxBps, tipBps, currency。
	 * 同步校验 card.owner() 是否与 owner 一致（与 topup 一致），避免任意 payTo 注入误用。 */
	router.get('/nfcUsdcChargeQuote', async (req, res) => {
		try {
			const { card, owner, currency, pos } = req.query as { card?: string; owner?: string; currency?: string; pos?: string }
			if (!card || !ethers.isAddress(String(card).trim())) {
				return res.status(400).json({ success: false, error: 'Invalid card' }).end()
			}
			const breakdown = normalizeChargeBreakdown(req.query as any)
			if (breakdown.total <= 0) {
				return res.status(400).json({ success: false, error: 'Invalid charge breakdown (total must be > 0)' }).end()
			}
			const cardAddr = ethers.getAddress(String(card).trim())
			const posAddr = pos && ethers.isAddress(String(pos).trim()) ? ethers.getAddress(String(pos).trim()) : null

			// 链上一次性读取 owner / currency / isAdmin(pos)，让 owner/currency 在 URL 中变可选
			let onChainOwner: string | null = null
			let onChainCurrency: string | null = null
			let isAdminPos: boolean = posAddr === null
			try {
				const c = new ethers.Contract(
					cardAddr,
					[
						'function owner() view returns (address)',
						'function currency() view returns (uint8)',
						'function isAdmin(address) view returns (bool)',
					],
					providerBase
				)
				const ownerP = c.owner() as Promise<string>
				const curEnumP = c.currency() as Promise<bigint | number>
				const adminP = posAddr ? (c.isAdmin(posAddr) as Promise<boolean>) : Promise.resolve(true)
				const [o, ce, ad] = await Promise.all([ownerP, curEnumP, adminP])
				if (o && ethers.isAddress(o)) onChainOwner = ethers.getAddress(o)
				const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
				onChainCurrency = currencyMap[Number(ce)] ?? null
				isAdminPos = !!ad
			} catch (_) { /* tolerate transient rpc */ }

			// owner 字段处理：URL 提供 ⇒ 与链上一致校验；URL 缺省 ⇒ 直接用链上 owner（新 schema）。
			const ownerStr = (owner ?? '').toString().trim()
			let resolvedOwner: string | null = onChainOwner
			if (ownerStr !== '') {
				if (!ethers.isAddress(ownerStr)) {
					return res.status(400).json({ success: false, error: 'Invalid owner' }).end()
				}
				const ownerAddr = ethers.getAddress(ownerStr)
				if (onChainOwner && onChainOwner !== ownerAddr) {
					return res.status(400).json({ success: false, error: `cardOwner mismatch (on-chain ${onChainOwner.slice(0, 10)}…)` }).end()
				}
				resolvedOwner = onChainOwner ?? ownerAddr
			}
			if (!resolvedOwner) {
				return res.status(400).json({ success: false, error: 'Cannot resolve card.owner() on-chain' }).end()
			}
			if (posAddr && !isAdminPos && posAddr !== resolvedOwner) {
				return res
					.status(400)
					.json({ success: false, error: `pos ${posAddr.slice(0, 10)}… is not an admin/owner of card ${cardAddr.slice(0, 10)}…` })
					.end()
			}

			// currency: URL 提供 ⇒ 必须与链上一致；URL 缺省 ⇒ 用链上 (新 schema)；链上读不到 ⇒ 回退 CAD
			const cur = (currency ?? '').toString().trim().toUpperCase() || onChainCurrency || 'CAD'
			if (currency && onChainCurrency && cur !== onChainCurrency.toUpperCase()) {
				logger(
					Colors.yellow(
						`[nfcUsdcChargeQuote] currency mismatch client=${cur} card=${onChainCurrency} card=${cardAddr.slice(0, 10)}… (using card chain currency)`
					)
				)
			}
			const effectiveCurrency = onChainCurrency ?? cur

			const totalStr = breakdown.total.toFixed(6)
			const usdc6 = quoteCurrencyToUsdc6(totalStr, effectiveCurrency)
			if (usdc6 <= 0n) {
				const fresh = isOracleFresh()
				const oracleTs = (clusterOracleCache?.timestamp ?? 0) as number
				logger(Colors.yellow(`[nfcUsdcChargeQuote] oracle quote=0 cur=${effectiveCurrency} total=${totalStr} fresh=${fresh} oracleTs=${oracleTs}`))
				return res.status(503).json({
					success: false,
					error: fresh
						? `Oracle rate not available for ${effectiveCurrency}, please retry shortly`
						: `Oracle rate stale, please retry shortly`,
				}).end()
			}
			return res.status(200).json({
				success: true,
				cardAddress: cardAddr,
				cardOwner: resolvedOwner,
				pos: posAddr,
				currency: effectiveCurrency,
				subtotal: breakdown.subtotal.toFixed(2),
				discount: breakdown.discount.toFixed(2),
				tax: breakdown.tax.toFixed(2),
				tip: breakdown.tip.toFixed(2),
				total: breakdown.total.toFixed(2),
				discountBps: breakdown.discountBps,
				taxBps: breakdown.taxBps,
				tipBps: breakdown.tipBps,
				quotedUsdc6: usdc6.toString(),
				quotedUsdc: ethers.formatUnits(usdc6, 6),
				oracleTimestamp: Number(clusterOracleCache?.timestamp ?? 0),
			}).end()
		} catch (e: any) {
			logger(Colors.red(`[nfcUsdcChargeQuote] error: ${e?.message ?? e}`))
			return res.status(500).json({ success: false, error: e?.message ?? String(e) }).end()
		}
	})

	/** GET /api/nfcUsdcChargePreCheck
	 * iOS POS 在生成 USDC charge QR **之前** 的 fast-fail 预检：cardOwner 是否有足够 B-Unit 覆盖 topup 腿手续费？
	 * 失败 ⇒ POS 不出 QR，弹 toast；成功 ⇒ POS 渲染 QR 等顾客扫码。
	 *
	 * 这是 PR #2 的范围，仅做 BUnit 余额预检；后续 PR #4（双腿 orchestrator）会真正消费 BUnit。
	 *
	 * Query:
	 *   - card        必填  BeamioUserCard 地址
	 *   - pos         可选（推荐）POS 终端 admin EOA；提供 ⇒ 校验 pos∈card.adminList()/owner，杜绝 misconfig
	 *   - subtotal    必填  小计（人类可读，按 card.currency() 隐含币种）
	 *   - tipBps,taxBps,discountBps  可选，默认 0
	 *   - currency    可选，仅作日志/兼容；后端以链上 card.currency() 为准
	 */
	router.get('/nfcUsdcChargePreCheck', async (req, res) => {
		try {
			const { card, pos, subtotal, currency } = req.query as { card?: string; pos?: string; subtotal?: string; currency?: string }
			if (!card || !ethers.isAddress(String(card).trim())) {
				return res.status(400).json({ ok: false, error: 'Invalid card' }).end()
			}
			const subtotalStr = String(subtotal ?? '').trim()
			if (!subtotalStr || !(Number(subtotalStr) > 0)) {
				return res.status(400).json({ ok: false, error: 'Invalid subtotal' }).end()
			}
			const cardAddr = ethers.getAddress(String(card).trim())
			const posAddr = pos && ethers.isAddress(String(pos).trim()) ? ethers.getAddress(String(pos).trim()) : null

			// 1. 链上读 card.owner / card.isAdmin(pos) / card.currency
			const cardC = new ethers.Contract(
				cardAddr,
				[
					'function owner() view returns (address)',
					'function isAdmin(address) view returns (bool)',
					'function currency() view returns (uint8)',
				],
				providerBase
			)
			const ownerPromise = cardC.owner() as Promise<string>
			const isAdminPromise: Promise<boolean> = posAddr ? cardC.isAdmin(posAddr) : Promise.resolve(true)
			const currencyEnumPromise = cardC.currency() as Promise<bigint | number>
			const [ownerRaw, isAdminPos, currencyEnum] = await Promise.all([ownerPromise, isAdminPromise, currencyEnumPromise])
			const onChainOwner = ethers.isAddress(ownerRaw) ? ethers.getAddress(ownerRaw) : null
			if (!onChainOwner) {
				return res.status(400).json({ ok: false, error: 'Cannot resolve card.owner() on-chain' }).end()
			}
			if (posAddr && !isAdminPos && posAddr !== onChainOwner) {
				return res
					.status(400)
					.json({ ok: false, error: `pos ${posAddr.slice(0, 10)}… is not an admin/owner of card ${cardAddr.slice(0, 10)}…` })
					.end()
			}
			const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
			const cardCurrency = currencyMap[Number(currencyEnum)] ?? 'CAD'
			if (currency && String(currency).trim().toUpperCase() !== cardCurrency.toUpperCase()) {
				logger(
					Colors.yellow(
						`[nfcUsdcChargePreCheck] currency mismatch client=${String(currency).trim().toUpperCase()} card=${cardCurrency} card=${cardAddr.slice(0, 10)}… (using card chain currency)`
					)
				)
			}

			// 2. 重算 total fiat (= subtotal × (10000 - disc + tax + tip) / 10000) — 与 normalizeChargeBreakdown 同源
			const breakdown = normalizeChargeBreakdown({
				subtotal: subtotalStr,
				tipBps: String(req.query.tipBps ?? '0'),
				taxBps: String(req.query.taxBps ?? '0'),
				discountBps: String(req.query.discountBps ?? '0'),
			})
			if (breakdown.total <= 0) {
				return res.status(400).json({ ok: false, error: 'Invalid charge breakdown (total must be > 0)' }).end()
			}
			const totalStr = breakdown.total.toFixed(6)

			// 3. quote total fiat → USDC6
			const usdc6 = quoteCurrencyToUsdc6(totalStr, cardCurrency)
			if (usdc6 <= 0n) {
				return res.status(503).json({ ok: false, error: `Oracle rate not available for ${cardCurrency}, please retry shortly` }).end()
			}

			// 4. USDC6 → points6 via card-specific gateway.quoteUnitPointInUSDC6
			let points6: bigint
			try {
				const gw = new ethers.Contract(cardAddr, ['function factoryGateway() view returns (address)'], providerBase)
				const gatewayAddr = (await gw.factoryGateway()) as string
				const gateway = new ethers.Contract(gatewayAddr, ['function quoteUnitPointInUSDC6(address) view returns (uint256)'], providerBase)
				const unitPriceUSDC6 = (await gateway.quoteUnitPointInUSDC6(cardAddr)) as bigint
				if (unitPriceUSDC6 <= 0n) {
					return res.status(503).json({ ok: false, error: 'Card unit price unavailable (UC_PriceZero)' }).end()
				}
				// ceil(usdc6 * 1e6 / unitPriceUSDC6) — 与 nfcTopupPreCheckBUnitFee 反算口径一致
				points6 = (usdc6 * 1_000_000n + unitPriceUSDC6 - 1n) / unitPriceUSDC6
			} catch (e: any) {
				return res.status(503).json({ ok: false, error: `Cannot read card price: ${e?.shortMessage ?? e?.message ?? String(e)}` }).end()
			}
			if (points6 <= 0n) {
				return res.status(400).json({ ok: false, error: 'Computed points6 is zero (subtotal too small)' }).end()
			}

			// 5. 用 mock mintPointsByAdmin(dummy, points6) calldata 复用现有 BUnit fee 预检
			const dummyRecipient = '0x000000000000000000000000000000000000dEaD'
			const mintIface = new ethers.Interface(['function mintPointsByAdmin(address,uint256)'])
			const mockData = mintIface.encodeFunctionData('mintPointsByAdmin', [dummyRecipient, points6])
			const bunit = await nfcTopupPreCheckBUnitFee(cardAddr, mockData)
			if (!bunit.success) {
				logger(
					Colors.yellow(
						`[nfcUsdcChargePreCheck] BUnit fee FAIL card=${cardAddr.slice(0, 10)}… owner=${(bunit.cardOwnerEOA ?? onChainOwner).slice(0, 10)}… err=${bunit.error}`
					)
				)
				return res
					.status(400)
					.json({
						ok: false,
						error: bunit.error ?? 'B-Unit pre-check failed',
						cardOwner: bunit.cardOwnerEOA ?? onChainOwner,
						requiredBUnits6: bunit.feeAmount?.toString(),
					})
					.end()
			}

			logger(
				Colors.green(
					`[nfcUsdcChargePreCheck] OK card=${cardAddr.slice(0, 10)}… pos=${posAddr ? posAddr.slice(0, 10) + '…' : '(none)'} subtotal=${subtotalStr} ${cardCurrency} total=${breakdown.total.toFixed(2)} usdc6=${usdc6} points6=${points6} fee=${bunit.feeAmount} BUnits6`
				)
			)
			return res
				.status(200)
				.json({
					ok: true,
					cardAddr,
					cardOwner: bunit.cardOwnerEOA ?? onChainOwner,
					pos: posAddr,
					currency: cardCurrency,
					subtotal: breakdown.subtotal.toFixed(2),
					discount: breakdown.discount.toFixed(2),
					tax: breakdown.tax.toFixed(2),
					tip: breakdown.tip.toFixed(2),
					total: breakdown.total.toFixed(2),
					discountBps: breakdown.discountBps,
					taxBps: breakdown.taxBps,
					tipBps: breakdown.tipBps,
					quotedUsdc6: usdc6.toString(),
					estPoints6: points6.toString(),
					requiredBUnits6: bunit.feeAmount?.toString() ?? '0',
				})
				.end()
		} catch (e: any) {
			logger(Colors.red(`[nfcUsdcChargePreCheck] error: ${e?.message ?? e}`))
			return res.status(500).json({ ok: false, error: e?.shortMessage ?? e?.message ?? String(e) }).end()
		}
	})

	/** POST /api/nfcUsdcCharge
	 * x402（EIP-3009）：客户用任意外部钱包浏览器（MetaMask 等）为 POS charge 付 USDC。
	 * 与 nfcUsdcTopup 区别：
	 *   - charge 是顾客付钱给商家，**不需要** mintPointsByAdmin / ExecuteForAdmin
	 *   - body 携带 charge breakdown（subtotal/discount/tax/tip + currency），与 NFC charge `nfcBill` 字段对齐
	 *
	 * NFC 模式（兼容旧链路）：携带 `uid + e + c + m` ⇒ SUN 校验 + best-effort 解析 recipientEOA（未来 loyalty 入账）。
	 * 第三方钱包模式（iOS POS USDC charge no-NFC）：`uid` 未提供 ⇒ 跳过 SUN 校验（`recipientEOA = null`），收款仍走
	 *   `card.owner()` 一致性校验后的 cardOwner，确保不会误把 USDC 转到任意 payTo。
	 */
	router.post('/nfcUsdcCharge', async (req, res) => {
		const {
			card,
			cardAddress,
			cardOwner,
			pos,
			sid,
			uid,
			e,
			c,
			m,
			currency,
			subtotal,
			discount,
			tax,
			tip,
			discountBps,
			taxBps,
			tipBps,
		} = req.body as {
			card?: string
			cardAddress?: string
			cardOwner?: string
			pos?: string
			sid?: string
			uid?: string
			e?: string
			c?: string
			m?: string
			currency?: string
			subtotal?: string | number
			discount?: string | number
			tax?: string | number
			tip?: string | number
			discountBps?: string | number
			taxBps?: string | number
			tipBps?: string | number
		}
		// PR #3 sid 仅用于 POS ↔ cluster 内部状态跟踪，不影响 verra-home POST/x402 流程；
		// sid 缺省/无效 ⇒ 跳过 session 写入但仍正常处理 charge（向下兼容老 verra-home build）。
		// PR #4 v3：session 实际存储在 Master，cluster 这里只是 fire-and-forget 转发，多 worker 共享一份信源。
		const sidNorm: string | null = isValidSid(sid) ? (sid as string).toLowerCase() : null
		const sessionUpdate = (patch: Partial<ChargeSession>): void => {
			if (!sidNorm) return
			void masterSessionUpsert(sidNorm, patch as Record<string, unknown>)
		}
		try {
			// 新 schema 用 `card`；老 schema 用 `cardAddress`。两者择一即可，都没有则 400。
			const cardField = (card ?? cardAddress ?? '').toString().trim()
			if (!cardField || !ethers.isAddress(cardField)) {
				sessionUpdate({ state: 'error', error: 'Invalid card' })
				return res.status(400).json({ success: false, error: 'Invalid card' }).end()
			}
			const cardAddr = ethers.getAddress(cardField)
			const posStr = (pos ?? '').toString().trim()
			const posAddr = posStr && ethers.isAddress(posStr) ? ethers.getAddress(posStr) : null
			const ownerStrRaw = (cardOwner ?? '').toString().trim()
			const uidTrim = (uid ?? '').trim()
			const eTrim = (e ?? '').trim()
			const cTrim = (c ?? '').trim()
			const mTrim = (m ?? '').trim()
			// uid 提供与否决定走 NFC SUN 校验路径还是第三方钱包 no-NFC 路径。
			const hasNfcSun = uidTrim.length > 0 || eTrim.length > 0 || cTrim.length > 0 || mTrim.length > 0
			if (hasNfcSun) {
				if (!/^[0-9A-Fa-f]{14}$/.test(uidTrim)) {
					sessionUpdate({ state: 'error', cardAddr, pos: posAddr, error: 'Invalid uid' })
					return res.status(400).json({ success: false, error: 'Invalid uid (expect 14-hex NFC UID)' }).end()
				}
				if (eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
					sessionUpdate({ state: 'error', cardAddr, pos: posAddr, error: 'Invalid NFC SUN params' })
					return res.status(400).json({ success: false, error: 'NFC UID requires SUN params (e=64 hex, c=6 hex, m=16 hex)' }).end()
				}
			}
			const breakdown = normalizeChargeBreakdown({ subtotal, discount, tax, tip, discountBps, taxBps, tipBps })
			if (breakdown.total <= 0) {
				sessionUpdate({ state: 'error', cardAddr, pos: posAddr, error: 'Invalid charge breakdown' })
				return res.status(400).json({ success: false, error: 'Invalid charge breakdown (total must be > 0)' }).end()
			}
			// 进入 verifying 阶段：把 breakdown + cardAddr/pos 写入 session（POS 拉取后能立即知道客户已经到达 POST 阶段）
			sessionUpdate({
				state: 'verifying',
				cardAddr,
				pos: posAddr,
				subtotal: breakdown.subtotal.toFixed(2),
				discount: breakdown.discount.toFixed(2),
				tax: breakdown.tax.toFixed(2),
				tip: breakdown.tip.toFixed(2),
				total: breakdown.total.toFixed(2),
				discountBps: breakdown.discountBps,
				taxBps: breakdown.taxBps,
				tipBps: breakdown.tipBps,
			})

			// 1. SUN 校验仅在 NFC 模式触发；no-NFC 第三方钱包路径直接跳过（`card.owner()` 一致性 + x402 verify 仍是强约束）。
			let recipientEOA: string | null = null
			let tagIdHex: string | null = null
			if (hasNfcSun) {
				try {
					const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
					const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
					if (!sunResult.valid) {
						logger(Colors.yellow(`[nfcUsdcCharge] uid=${uidTrim} SUN 校验失败 valid=${sunResult.valid}`))
						sessionUpdate({ state: 'error', error: 'SUN verification failed' })
						return res.status(403).json({ success: false, error: 'SUN verification failed', macValid: sunResult.macValid, counterFresh: sunResult.counterFresh }).end()
					}
					tagIdHex = sunResult.tagIdHex
					try {
						const eoaFromTag = await getNfcRecipientAddressByTagId(tagIdHex)
						if (eoaFromTag && ethers.isAddress(eoaFromTag)) {
							recipientEOA = ethers.getAddress(eoaFromTag)
						}
					} catch (_) { /* charge: best-effort */ }
				} catch (sunErr: any) {
					logger(Colors.yellow(`[nfcUsdcCharge] uid=${uidTrim} SUN 校验异常: ${sunErr?.message ?? sunErr}`))
					sessionUpdate({ state: 'error', error: `SUN verification error: ${sunErr?.message ?? sunErr}` })
					return res.status(403).json({ success: false, error: `SUN verification error: ${sunErr?.message ?? sunErr}` }).end()
				}
			} else {
				logger(Colors.cyan(`[nfcUsdcCharge] no-NFC mode card=${cardAddr.slice(0, 8)}… total=${breakdown.total.toFixed(2)} (third-party wallet, SUN bypass; currency resolved on-chain)`))
			}

			// 2. 链上一次性读 owner / currency / isAdmin(pos)：新 schema 下 owner/currency 不在 URL 里，必须链上权威。
			let onChainOwner: string | null = null
			let onChainCurrency: string | null = null
			let isAdminPos: boolean = posAddr === null
			try {
				const cprep = new ethers.Contract(
					cardAddr,
					[
						'function owner() view returns (address)',
						'function currency() view returns (uint8)',
						'function isAdmin(address) view returns (bool)',
					],
					providerBase
				)
				const ownerP = cprep.owner() as Promise<string>
				const curP = cprep.currency() as Promise<bigint | number>
				const adminP = posAddr ? (cprep.isAdmin(posAddr) as Promise<boolean>) : Promise.resolve(true)
				const [o, ce, ad] = await Promise.all([ownerP, curP, adminP])
				if (o && ethers.isAddress(o)) onChainOwner = ethers.getAddress(o)
				const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
				onChainCurrency = currencyMap[Number(ce)] ?? null
				isAdminPos = !!ad
			} catch (_) { /* tolerate transient rpc */ }
			if (!onChainOwner) {
				sessionUpdate({ state: 'error', error: 'Cannot resolve card.owner() on-chain' })
				return res.status(400).json({ success: false, error: 'Cannot resolve card.owner() on-chain' }).end()
			}
			// 老 schema 显式传 cardOwner ⇒ 必须与链上一致；新 schema 不传 ⇒ 直接用链上值
			if (ownerStrRaw !== '') {
				if (!ethers.isAddress(ownerStrRaw)) {
					sessionUpdate({ state: 'error', cardOwner: onChainOwner, error: 'Invalid cardOwner' })
					return res.status(400).json({ success: false, error: 'Invalid cardOwner' }).end()
				}
				const ownerAddr = ethers.getAddress(ownerStrRaw)
				if (ownerAddr !== onChainOwner) {
					sessionUpdate({ state: 'error', cardOwner: onChainOwner, error: 'cardOwner mismatch' })
					return res.status(400).json({ success: false, error: `cardOwner mismatch (on-chain ${onChainOwner.slice(0, 10)}…)` }).end()
				}
			}
			if (posAddr && !isAdminPos && posAddr !== onChainOwner) {
				sessionUpdate({ state: 'error', cardOwner: onChainOwner, error: 'pos not admin/owner of card' })
				return res
					.status(400)
					.json({ success: false, error: `pos ${posAddr.slice(0, 10)}… is not an admin/owner of card ${cardAddr.slice(0, 10)}…` })
					.end()
			}
			const payToOwner = onChainOwner

			// currency: 新 schema 缺省 ⇒ 用链上；老 schema 显式 ⇒ warn-only mismatch（不阻断，避免老 QR 被 reject）
			const cur = ((currency ?? '').toString().trim().toUpperCase() || onChainCurrency || 'CAD')
			if (currency && onChainCurrency && cur !== onChainCurrency.toUpperCase()) {
				logger(
					Colors.yellow(
						`[nfcUsdcCharge] currency mismatch client=${cur} card=${onChainCurrency} card=${cardAddr.slice(0, 10)}… (using card chain currency)`
					)
				)
			}
			const effectiveCurrency = onChainCurrency ?? cur
			// 资料齐了，把 owner/currency 也补进 session（POS 可以提前看到 verifying 阶段的明细）
			sessionUpdate({ cardOwner: payToOwner, currency: effectiveCurrency })

			// 3. USDC 报价 - 严格 Oracle（与 topup 同策略）
			const totalStr = breakdown.total.toFixed(6)
			const quotedUsdc6 = quoteCurrencyToUsdc6(totalStr, effectiveCurrency)
			if (quotedUsdc6 <= 0n) {
				const fresh = isOracleFresh()
				logger(Colors.yellow(`[nfcUsdcCharge] oracle quote=0 cur=${effectiveCurrency} total=${totalStr} fresh=${fresh}`))
				const errMsg = fresh
					? `Oracle rate not available for ${effectiveCurrency}, please retry shortly`
					: `Oracle rate stale, please retry shortly`
				sessionUpdate({ state: 'error', error: errMsg })
				return res.status(503).json({ success: false, error: errMsg }).end()
			}

			// 4. x402 verify + settle（USDC → cardOwner）
			sessionUpdate({ state: 'settling' })
			const settled = await settleBeamioX402ToCardOwner(req, res, {
				cardOwner: payToOwner,
				quotedUsdc6,
				description: `Beamio NFC USDC Charge (${effectiveCurrency} ${breakdown.total.toFixed(2)} → card ${cardAddr.slice(0, 8)}…)`,
			})
			if (!settled) {
				// helper 已经把错误响应写到 res；session 用 status code 推断粗粒度原因（具体错文已写到 res 给 verra-home）
				const sc = res.statusCode
				const reason = sc === 402
					? 'USDC payment verification failed'
					: sc === 503
						? 'USDC settle unavailable, please retry'
						: `USDC settle failed (HTTP ${sc})`
				sessionUpdate({ state: 'error', error: reason })
				return
			}

			const fiat6 = (n: number): string => BigInt(Math.max(0, Math.round(n * 1_000_000))).toString()

			logger(Colors.green(
				`[nfcUsdcCharge] settle OK card=${cardAddr} pos=${posAddr ? posAddr.slice(0, 10) + '…' : '(none)'} payer=${settled.payer} ` +
				`USDC_tx=${settled.USDC_tx} usdc6=${settled.usdcAmount6} sid=${sidNorm ?? '(none)'} ` +
				`mode=${hasNfcSun ? 'NFC' : 'no-NFC orchestrator'}`
			))

			// 5. 分流：
			//    - NFC 模式 ⇒ 顾客是 BeamioTag 持卡人，沿用既有 Master `/api/nfcUsdcCharge` 仅做日志记账（PR #4 之前行为）；
			//                 settle 成功即视为终态，session 直接进 success（顾客的 NFC tag 已绑定，无需 orchestrator）。
			//    - no-NFC 模式 ⇒ PR #4 编排器：立刻 200 给 verra-home（USDC 已到 cardOwner，对客户已完成支付），
			//                     后台启动 ephemeral 钱包 topup → charge 闭环；POS 通过 sid 轮询 session 状态机推进 UI。
			if (hasNfcSun) {
				sessionUpdate({
					state: 'success',
					usdcAmount6: settled.usdcAmount6.toString(),
					USDC_tx: settled.USDC_tx,
					payer: settled.payer,
					error: null,
				})
				postLocalhost(
					'/api/nfcUsdcCharge',
					{
						cardAddr,
						cardOwner: payToOwner,
						pos: posAddr,
						nfcUid: uidTrim,
						nfcTagIdHex: tagIdHex,
						nfcRecipientEOA: recipientEOA,
						currency: effectiveCurrency,
						subtotalCurrencyAmount: breakdown.subtotal.toFixed(2),
						discountAmountFiat6: fiat6(breakdown.discount),
						discountRateBps: breakdown.discountBps,
						taxAmountFiat6: fiat6(breakdown.tax),
						taxRateBps: breakdown.taxBps,
						tipCurrencyAmount: breakdown.tip.toFixed(2),
						tipRateBps: breakdown.tipBps,
						totalCurrencyAmount: breakdown.total.toFixed(2),
						usdcAmount6: settled.usdcAmount6.toString(),
						USDC_tx: settled.USDC_tx,
						payer: settled.payer,
					},
					res
				)
				return
			}

			// no-NFC orchestrator path (PR #4)
			// 立即把 USDC settle 成功告诉 verra-home（用户在小狐狸里看到 ✓ 不需要等到 L1/L2 链上确认）
			sessionUpdate({
				state: 'topup_pending',
				usdcAmount6: settled.usdcAmount6.toString(),
				USDC_tx: settled.USDC_tx,
				payer: settled.payer,
				error: null,
			})
			if (!res.headersSent) {
				res.status(200).json({
					success: true,
					cardAddress: cardAddr,
					cardOwner: payToOwner,
					currency: effectiveCurrency,
					totalCurrencyAmount: breakdown.total.toFixed(2),
					usdcAmount6: settled.usdcAmount6.toString(),
					USDC_tx: settled.USDC_tx,
					payer: settled.payer,
					sid: sidNorm,
				}).end()
			}

			// 后台编排（fire-and-forget）；orchestrator 内部做 try/catch + session 状态推进；
			// 任何 unhandled 异常都会被外层 .catch 捕获写到 session.error，不会冒泡为 unhandledRejection 把 cluster worker 拖垮。
			// settle 在极少数情况下没有 transaction 字段（responseData.transaction undefined）；这种 USDC 等于没 settle，跳过编排并把 session 标记 error。
			if (!settled.USDC_tx || !/^0x[0-9a-fA-F]{64}$/.test(settled.USDC_tx)) {
				logger(Colors.red(`[nfcUsdcCharge/orchestrator] sid=${sidNorm ?? 'n/a'} settle returned invalid USDC_tx; abort orchestrator`))
				sessionUpdate({ state: 'error', error: 'USDC settle returned invalid tx hash; orchestrator aborted' })
				return
			}
			const sidForAwait = sidNorm ?? ''
			const orchestratorCtx: UsdcChargeOrchestratorContext = {
				sid: sidForAwait,
				cardAddr,
				cardOwner: payToOwner,
				currency: effectiveCurrency,
				totalCurrencyAmount: breakdown.total.toFixed(2),
				originatingUSDCTx: settled.USDC_tx,
				usdcAmount6: settled.usdcAmount6.toString(),
				payer: settled.payer,
				posOperator: posAddr,
				provider: providerBase,
				updateSession: (patch: OrchestratorSessionPatch) => {
					// orchestrator 不持有 sid（避免循环依赖），无 sid 时 sessionUpdate 内部 no-op，恰好兜住「sid 缺省」场景
					sessionUpdate(patch as Partial<ChargeSession>)
				},
				/** PR #4 v3：跨 worker session 轮询 ⇒ 走 Master 的 `/api/chargeSessionConsumePosSig` 原子消耗端点。
				 *  POS POST `/api/nfcUsdcChargeTopupAuth` 命中 cluster ⇒ proxy 到 Master ⇒ Master verify 后写 posTopupSignature；
				 *  本闭包每 500ms 探一次 Master，签名一旦出现即原子消耗（Master 同时清掉 pendingTopup* 字段，避免重放）。 */
				awaitTopupSignature: async (timeoutMs: number) => {
					if (!sidForAwait) return { ok: false, error: 'sid missing; orchestrator cannot solicit POS signature' }
					const deadline = Date.now() + Math.max(1_000, timeoutMs)
					while (Date.now() < deadline) {
						const got = await masterSessionConsumePosSig(sidForAwait)
						if (got.ok) return { ok: true, signature: got.signature, signer: got.signer }
						// got.error in {'no signature yet', 'session not found', 'session in error', ...}
						if (got.error === 'session not found') {
							// upsert 还没飘到 Master（fire-and-forget 没回执），继续等
						} else if (got.error.startsWith('session in error') || got.error === 'session moved to error') {
							return { ok: false, error: got.error }
						}
						await new Promise((r) => setTimeout(r, 500))
					}
					return { ok: false, error: `timeout ${timeoutMs}ms waiting POS topup auth` }
				},
			}
			void runUsdcChargeOrchestrator(orchestratorCtx).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err)
				logger(Colors.red(`[nfcUsdcCharge/orchestrator] sid=${sidNorm ?? 'n/a'} unhandled: ${msg}`))
				sessionUpdate({ state: 'error', error: `Orchestrator unhandled: ${msg}` })
			})
		} catch (err: any) {
			logger(Colors.red(`[nfcUsdcCharge] error: ${err?.message ?? err}`))
			sessionUpdate({ state: 'error', error: err?.message ?? String(err) })
			if (!res.headersSent) {
				res.status(500).json({ success: false, error: err?.message ?? String(err) }).end()
			}
		}
	})

	/** GET /api/nfcUsdcChargeSession?sid=<uuid v4>
	 * PR #3 iOS POS 轮询入口；PR #4 v3 改为 cluster→Master 透传：session 唯一信源在 Master，
	 * cluster 任何 worker 都能拿到一致状态（修复 LB 派到非创建者 worker 时的 "Session not found"）。
	 * - sid 非法 ⇒ 400 由 cluster 自己拦
	 * - sid 不存在 ⇒ Master 返 awaiting_payment shell；POS 继续轮询不当 error
	 * - sid 存在 ⇒ 返完整 record（含 USDC_tx/payer/breakdown/pendingTopup*） */
	router.get('/nfcUsdcChargeSession', async (req, res) => {
		const sidQ = (req.query?.sid ?? '').toString().trim()
		if (!isValidSid(sidQ)) {
			return res.status(400).json({ ok: false, error: 'Invalid sid (expect UUID v4)' }).end()
		}
		try {
			const r = await masterSessionGet(sidQ.toLowerCase())
			res.status(r.statusCode === 200 ? 200 : r.statusCode).setHeader('Content-Type', 'application/json').send(r.body).end()
		} catch (err: any) {
			logger(Colors.red(`[nfcUsdcChargeSession proxy] sid=${sidQ.slice(0, 8)}… ${err?.message ?? err}`))
			res.status(502).json({ ok: false, error: 'Master unreachable' }).end()
		}
	})

	/** POST /api/nfcUsdcChargeTopupAuth
	 * PR #4 v2 POS-signed admin path；PR #4 v3：cluster→Master 透传，所有验签 + session 写入都在 Master 完成。
	 * 这样不论 POS 的请求被 LB 派到哪个 cluster worker，都能命中正确 session。
	 * cluster 端只透传请求体，不再持本地 state。 */
	router.post('/nfcUsdcChargeTopupAuth', async (req, res) => {
		try {
			const r = await postLocalhostBuffer('/api/nfcUsdcChargeTopupAuth', req.body ?? {})
			res.status(r.statusCode).setHeader('Content-Type', 'application/json').send(r.body).end()
		} catch (err: any) {
			logger(Colors.red(`[nfcUsdcChargeTopupAuth proxy] ${err?.message ?? err}`))
			if (!res.headersSent) {
				res.status(502).json({ success: false, error: 'Master unreachable' }).end()
			}
		}
	})

	/** 最新发行的前 N 张卡明细：透传 Master（含 token0TotalSupply6、token0CumulativeMint6、holderCount；与 Master 同排除集）。limit 上限 300。 */
	router.get('/latestCards', (req, res) => {
		const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''
		getLocalhost(`/api/latestCards${qs}`, res)
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

	/** GET /api/metadata/0x{contract}{64hexTokenId}.json - BaseScan/ERC-1155 兼容元数据路由 */
	router.get('/metadata/:resource', async (req, res) => {
		const resource = typeof req.params.resource === 'string' ? req.params.resource : ''
		const match = ERC1155_METADATA_PATH_RE.exec(resource)
		if (!match) {
			return res.status(404).json({ error: 'Invalid metadata path' })
		}

		const cardAddress = ethers.getAddress(`0x${match[1]}`)
		const tokenIdHex = match[2].toLowerCase()
		const tokenIdBigInt = BigInt(`0x${tokenIdHex}`)
		const tokenId = tokenIdBigInt.toString()

		try {
			const cardRow = await getCardByAddress(cardAddress)
			const cardMeta = isJsonObject(cardRow?.metadata) ? cardRow.metadata : {}
			const cardProps = isJsonObject(cardMeta.properties) ? cardMeta.properties : {}
			const cardName = firstNonEmptyString(cardMeta.name, cardMeta.title, 'Beamio User Card') ?? 'Beamio User Card'
			const defaultImage = firstNonEmptyString(cardMeta.image, cardMeta.image_url, cardMeta.imageUrl, cardProps.image, DEFAULT_METADATA_IMAGE_URL)

			let tokenMeta: JsonObject = {}
			let sharedSeriesMetadata: JsonObject | null = null
			let sharedMetadataHash: string | null = null
			let ipfsCid: string | null = null

			if (tokenIdBigInt >= ISSUED_NFT_START_ID) {
				const series = await getSeriesByCardAndTokenId(cardAddress, tokenId)
				sharedMetadataHash = series?.sharedMetadataHash ?? null
				ipfsCid = series?.ipfsCid ?? null
				if (series?.ipfsCid && String(series.ipfsCid).trim() !== '') {
					try {
						const ipfsRes = await fetch(`https://ipfs.io/ipfs/${series.ipfsCid}`)
						if (ipfsRes.ok) {
							const ipfsJson = await ipfsRes.json()
							if (isJsonObject(ipfsJson)) sharedSeriesMetadata = ipfsJson
						}
					} catch (ipfsErr: any) {
						logger(Colors.yellow('[metadata route] IPFS fetch failed:'), ipfsErr?.message ?? ipfsErr)
					}
				}
				if (!sharedSeriesMetadata && series?.metadata && typeof series.metadata === 'object') {
					sharedSeriesMetadata = series.metadata
				}
				tokenMeta = mergeMetadataObjects(series?.metadata, sharedSeriesMetadata)
			} else if (tokenIdBigInt > 0n) {
				const tierMetaByOwner = cardRow?.cardOwner
					? await getNftTierMetadataByOwnerAndToken(cardRow.cardOwner, tokenIdBigInt)
					: null
				const tierMetaByCard = await getNftTierMetadataByCardAndToken(cardAddress, tokenIdBigInt)
				tokenMeta = mergeMetadataObjects(tierMetaByOwner, tierMetaByCard)
			} else {
				tokenMeta = mergeMetadataObjects(
					cardMeta.pointsMetadata,
					cardProps.pointsMetadata
				)
			}

			const merged = ensureMetadataImage(mergeMetadataObjects(cardMeta, tokenMeta))
			const baseExtra: JsonObject = {
				card_address: cardAddress,
				token_id: tokenId,
			}

			let out: JsonObject
			if (tokenIdBigInt === 0n) {
				out = normalizeExplorerMetadata(merged, {
					name: `${cardName} Points`,
					description: `${cardName} ERC-1155 points balance token on Beamio.`,
					image: defaultImage,
					attributes: [
						{ trait_type: 'asset_type', value: 'POINTS' },
						{ trait_type: 'token_id', value: tokenId },
					],
					extra: baseExtra,
				})
			} else if (tokenIdBigInt < ISSUED_NFT_START_ID) {
				out = normalizeExplorerMetadata(merged, {
					name: `${cardName} Membership #${tokenId}`,
					description: `${cardName} membership NFT #${tokenId}.`,
					image: defaultImage,
					attributes: [
						{ trait_type: 'asset_type', value: 'MEMBERSHIP' },
						{ trait_type: 'token_id', value: tokenId },
					],
					extra: baseExtra,
				})
			} else {
				out = normalizeExplorerMetadata(merged, {
					name: `${cardName} Issued NFT #${tokenId}`,
					description: `${cardName} issued NFT #${tokenId}.`,
					image: defaultImage,
					attributes: [
						{ trait_type: 'asset_type', value: 'ISSUED_NFT' },
						{ trait_type: 'token_id', value: tokenId },
					],
					extra: baseExtra,
				})
				if (sharedSeriesMetadata) out.sharedSeriesMetadata = sharedSeriesMetadata
				if (sharedMetadataHash) out.sharedMetadataHash = sharedMetadataHash
				if (ipfsCid) out.ipfsCid = ipfsCid
			}

			res.setHeader('Content-Type', 'application/json')
			res.setHeader('Cache-Control', 'public, max-age=300')
			return res.status(200).json(out)
		} catch (err: any) {
			logger(Colors.red('[metadata route] error:'), err?.message ?? err)
			return res.status(500).json({ error: err?.message ?? 'Failed to fetch metadata' })
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
		const image = firstNonEmptyString(
			(out.assembled as JsonObject | undefined)?.image,
			(out.assembled as JsonObject | undefined)?.image_url,
			(out.assembled as JsonObject | undefined)?.imageUrl,
			(out.sharedSeriesMetadata as JsonObject | undefined)?.image,
			(out.sharedSeriesMetadata as JsonObject | undefined)?.image_url,
			(out.sharedSeriesMetadata as JsonObject | undefined)?.imageUrl,
			DEFAULT_METADATA_IMAGE_URL
		)
		if (image) out.image = image
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

	/** GET /api/seriesSharedMetadata?card=0x&tokenId=... - 返回该系列的 sharedSeriesMetadata（IPFS 或自定义 metadata）。30 秒缓存 */
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
			if (!series) {
				return res.status(404).json({ error: 'Series not registered' })
			}
			let sharedJson: Record<string, unknown> | null = null
			if (series.ipfsCid && series.ipfsCid.trim() !== '') {
				const ipfsUrl = `https://ipfs.io/ipfs/${series.ipfsCid}`
				const ipfsRes = await fetch(ipfsUrl)
				if (ipfsRes.ok) {
					const parsed = await ipfsRes.json()
					if (parsed && typeof parsed === 'object') sharedJson = parsed as Record<string, unknown>
				}
			}
			if (!sharedJson && series.metadata && typeof series.metadata === 'object') {
				sharedJson = series.metadata as Record<string, unknown>
			}
			const rawShared = (sharedJson ?? {}) as JsonObject
			const sharedWithImage = ensureMetadataImage({ ...rawShared })
			const out = {
				cardAddress: series.cardAddress,
				tokenId: series.tokenId,
				sharedMetadataHash: series.sharedMetadataHash,
				ipfsCid: series.ipfsCid || null,
				metadata: series.metadata ?? null,
				sharedSeriesMetadata: sharedWithImage,
			}
			const body = JSON.stringify(out)
			seriesSharedMetadataCache.set(cacheKey, { body, expiry: Date.now() + QUERY_CACHE_TTL_MS })
			res.status(200).json(out)
		} catch (err: any) {
			logger(Colors.red('[seriesSharedMetadata] error:'), err?.message ?? err)
			return res.status(500).json({ error: err?.message ?? 'Failed to fetch shared metadata' })
		}
	})

	/** registerSeries：cluster 预检格式，合格转发 master。
	 *  tokenId 必须来自合约 createIssuedNft 的返回值（合约自动递增，不可自定）。
	 *  sharedMetadata：支持 ipfsCid（从 IPFS 拉取）或 metadata 自定义 JSON（扩展用），至少提供一个。 */
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
		logger(Colors.green('server /api/registerSeries preCheck OK, forwarding to master'))
		postLocalhost('/api/registerSeries', req.body, res)
	})

	/** registerMintMetadata：cluster 预检格式，合格转发 master。tokenId 必须来自 createIssuedNft 返回值。metadata 为自定义 JSON（如座位、序列号等）。 */
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
		const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, recommender } = req.body as {
			cardAddress?: string
			userSignature?: string
			nonce?: string
			usdcAmount?: string
			from?: string
			validAfter?: string
			validBefore?: string
			recommender?: string
		}

		if (!cardAddress || !userSignature || !nonce  || !usdcAmount || !from || !validBefore) {
			logger(`server /api/purchasingCard Invalid data format!`, inspect(req.body, false, 3, true))
			return res.status(400).json({ error: "Invalid data format" })
		}

		const recommenderCheck = await validateRecommenderForTopup(cardAddress, recommender)
		if (!recommenderCheck.ok) {
			return res.status(400).json({ success: false, error: recommenderCheck.error }).end()
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
			...(preCheck.success && preCheck.preChecked && { preChecked: preCheck.preChecked }),
			...(recommender != null && recommender !== '' && { recommender })
		}, res)

		logger(preCheck.success ? `server /api/purchasingCard preCheck OK, forwarded to master` : `server /api/purchasingCard forwarded to master (no preChecked)`, inspect({ cardAddress, from, usdcAmount, hasPreChecked: !!preCheck.success }, false, 3, true))
	})

	/** USDC Topup（新接口）：Cluster 执行完整预检（tier/金额/签名字段），通过后转发 Master 执行 buyPointsForUser。 */
	router.post('/usdcTopup', async (req, res) => {
		const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, intent, recommender } = req.body as {
			cardAddress?: string
			userSignature?: string
			nonce?: string
			usdcAmount?: string
			from?: string
			validAfter?: string
			validBefore?: string
			intent?: 'auto' | 'first_purchase' | 'upgrade' | 'topup'
			recommender?: string
		}
		if (!cardAddress || !userSignature || !nonce || !usdcAmount || !from || !validBefore) {
			return res.status(400).json({ success: false, error: 'Invalid data format' }).end()
		}
		const recommenderCheck = await validateRecommenderForTopup(cardAddress, recommender)
		if (!recommenderCheck.ok) {
			return res.status(400).json({ success: false, error: recommenderCheck.error }).end()
		}
		const shapeCheck = await purchasingCard(cardAddress, userSignature, nonce, usdcAmount, from, validAfter || '0', validBefore)
		if (!shapeCheck || !(shapeCheck as { success: boolean }).success) {
			return res.status(400).json(shapeCheck).end()
		}
		const preCheck = await usdcTopupPreCheck(cardAddress, usdcAmount, from, 'auto')
		if (!preCheck.success) {
			logger(Colors.red(`server /api/usdcTopup preCheck FAIL: ${preCheck.error}`))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/usdcTopup preCheck OK intent=${preCheck.ruleCheck.intent}, forwarding to master`), inspect({
			cardAddress,
			from,
			usdcAmount,
			requiredMinUsdc6: preCheck.ruleCheck.requiredMinUsdc6,
			hasMembership: preCheck.ruleCheck.hasMembership,
		}, false, 2, true))
		postLocalhost('/api/usdcTopup', {
			cardAddress,
			userSignature,
			nonce,
			usdcAmount,
			from,
			validAfter,
			validBefore,
			intent: preCheck.ruleCheck.intent,
			preChecked: preCheck.preChecked,
			...(recommender != null && recommender !== '' && { recommender })
		}, res)
	})

	/** USDC Topup 预览（只读）：签名前返回首购/升级最低要求与下一档信息。 */
	router.post('/usdcTopupPreview', async (req, res) => {
		const { cardAddress, from, intent, usdcAmount } = req.body as {
			cardAddress?: string
			from?: string
			intent?: 'auto' | 'first_purchase' | 'upgrade' | 'topup'
			usdcAmount?: string
		}
		if (!cardAddress || !from) {
			return res.status(400).json({ success: false, error: 'cardAddress and from are required' }).end()
		}
		const preview = await usdcTopupPreview(cardAddress, from, 'auto', usdcAmount)
		if (!preview.success) {
			return res.status(400).json({ success: false, error: preview.error }).end()
		}
		return res.status(200).json(preview).end()
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
		const ketGate = await createCardBusinessStartKetClusterPreCheck(originalCardOwner, resolveResult.cardOwner)
		if (!ketGate.success) {
			logger(Colors.red(`server /api/createCard BusinessStartKet preCheck FAIL: ${ketGate.error}`), inspect(body, false, 2, true))
			return res.status(400).json({ success: false, error: ketGate.error }).end()
		}
		preCheck.preChecked.cardOwner = resolveResult.cardOwner
		preCheck.preChecked.createCardOwnerAsRequested = ethers.getAddress(originalCardOwner)
		if (ketGate.burnFrom) {
			preCheck.preChecked.businessStartKetBurnFrom = ethers.getAddress(ketGate.burnFrom)
		}
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

	/** cardCreateRedeemAdmin：owner 离线签字创建 redeem-admin，Cluster 预检 data 为 createRedeemAdmin，合格转发 master executeForOwner */
	router.post('/cardCreateRedeemAdmin', async (req, res) => {
		const preCheck = await cardCreateRedeemAdminPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardCreateRedeemAdmin preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardCreateRedeemAdmin preCheck OK, forwarding to master executeForOwner`), inspect({ cardAddress: req.body?.cardAddress }, false, 2, true))
		postLocalhost('/api/executeForOwner', req.body, res)
	})

	/** cardAddAdmin：owner 管理 admin（添加/移除）。添加时 body.adminEOA 须与 calldata adminManager.to 同为商户 EOA；Cluster ensureAAForEOA 后须能在 Base 上读到规范 AA，再预检转发。移除时无需 adminEOA。 */
	router.post('/cardAddAdmin', async (req, res) => {
		const data = req.body?.data as string
		let isAddingAdmin = false
		if (data && typeof data === 'string' && data.length >= 10) {
			const sel = data.slice(0, 10).toLowerCase()
			const iface4 = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata)'])
			const iface5 = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata, uint256 mintLimit)'])
			const is5 = sel === (iface5.getFunction('adminManager')?.selector ?? '').toLowerCase()
			try {
				const decoded = (is5 ? iface5 : iface4).parseTransaction({ data })
				if (decoded?.name === 'adminManager') isAddingAdmin = decoded.args[1] === true
			} catch (_) { /* ignore */ }
		}
		if (isAddingAdmin) {
			const adminEOA = (req.body?.adminEOA as string)?.trim()
			if (!adminEOA || !ethers.isAddress(adminEOA)) {
				return res.status(400).json({ success: false, error: 'adminEOA is required when adding admin. Pass the EOA address to add.' }).end()
			}
			const adminNorm = ethers.getAddress(adminEOA)
			let ensureBody = ''
			try {
				const { statusCode, body: eb } = await getLocalhostBuffer('/api/ensureAAForEOA?eoa=' + encodeURIComponent(adminNorm))
				ensureBody = eb
				if (statusCode !== 200) {
					const err = (() => { try { const j = JSON.parse(ensureBody); return j?.error ?? 'Failed to ensure AA for EOA' } catch { return 'Failed to ensure AA for EOA' } })()
					return res.status(400).json({ success: false, error: err }).end()
				}
			} catch (e: any) {
				logger(Colors.red(`[cardAddAdmin] ensureAAForEOA failed: ${e?.message ?? e}`))
				return res.status(502).json({ success: false, error: 'Failed to ensure AA for EOA' }).end()
			}
			const visible = await assertAdminEoaHasVisibleAaAfterEnsure(adminNorm, ensureBody, 'cardAddAdmin')
			if (!visible.ok) {
				return res.status(400).json({ success: false, error: visible.error }).end()
			}
		}
		const preCheck = await cardAddAdminPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardAddAdmin preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		// Debug: 一行打印：签字钱包、卡地址、想登记的admin的EOA/AA、离线签字指定的登记地址
		try {
			const { cardAddress, data, deadline, nonce, ownerSignature } = req.body
			let signerAddr: string | null = null
			/** adminManager(to=...) 的 to；预检要求为 EOA，与 body.adminEOA 同址 */
			let calldataTo: string | null = null
			/** 若 calldata to 曾为合约，则 owner(to)；正常 EOA 路径下多为 N/A */
			let ownerOfCalldataToIfContract: string | null = null
			if (cardAddress && data && deadline != null && nonce && ownerSignature) {
				const domain = { name: 'BeamioUserCardFactory', version: '1', chainId: BASE_CHAIN_ID, verifyingContract: BASE_CARD_FACTORY }
				const types = { ExecuteForOwner: [{ name: 'cardAddress', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
				const dataHash = ethers.keccak256(data)
				const nonceBytes = (nonce.length === 66 && nonce.startsWith('0x') ? nonce : ethers.keccak256(ethers.toUtf8Bytes(nonce))) as `0x${string}`
				const value = { cardAddress: ethers.getAddress(cardAddress), dataHash, deadline: Number(deadline), nonce: nonceBytes }
				signerAddr = ethers.recoverAddress(ethers.TypedDataEncoder.hash(domain, types, value), ownerSignature)
			}
			if (data && typeof data === 'string' && data.length >= 10) {
				const iface4 = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata)'])
				const iface5 = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata, uint256 mintLimit)'])
				const iface = data.slice(0, 10).toLowerCase() === (iface5.getFunction('adminManager')?.selector ?? '').toLowerCase() ? iface5 : iface4
				const decoded = iface.parseTransaction({ data })
				if (decoded?.name === 'adminManager' && decoded.args[0]) {
					calldataTo = ethers.getAddress(String(decoded.args[0]))
					try {
						const ownerResult = await providerBase.call({ to: calldataTo as `0x${string}`, data: '0x8da5cb5b' })
						if (ownerResult && ownerResult !== '0x') {
							const [owner] = new ethers.Interface(['function owner() view returns (address)']).decodeFunctionResult('owner', ownerResult)
							if (owner && owner !== ethers.ZeroAddress) ownerOfCalldataToIfContract = ethers.getAddress(String(owner))
						}
					} catch (_) { /* ignore */ }
				}
			}
			let canonicalAAForSignerEOA: string | null = null
			let canonicalAAForBodyAdminEOA: string | null = null
			const bodyAdminRaw = (req.body?.adminEOA as string)?.trim()
			const bodyAdminEOA = bodyAdminRaw && ethers.isAddress(bodyAdminRaw) ? ethers.getAddress(bodyAdminRaw) : null
			if (signerAddr && ethers.isAddress(signerAddr)) {
				try {
					canonicalAAForSignerEOA = await resolveBeamioAaForEoaWithFallback(providerBase, signerAddr)
				} catch (_) { /* ignore */ }
			}
			if (isAddingAdmin && bodyAdminEOA) {
				try {
					canonicalAAForBodyAdminEOA = await resolveBeamioAaForEoaWithFallback(providerBase, bodyAdminEOA)
				} catch (_) { /* ignore */ }
			}
			const fmtAa = (a: string | null) => (a && ethers.isAddress(a) ? a : 'N/A')
			logger(
				Colors.cyan(
					`[cardAddAdmin] signer=${signerAddr ?? 'N/A'} cardAddress=${cardAddress ?? 'N/A'} bodyAdminEOA=${bodyAdminEOA ?? 'N/A'} ` +
						`calldataTo=${calldataTo ?? 'N/A'} ownerOfCalldataTo(ifContract)=${ownerOfCalldataToIfContract ?? 'N/A'} ` +
						`canonicalAAForSignerEOA=${fmtAa(canonicalAAForSignerEOA)} canonicalAAForBodyAdminEOA=${fmtAa(canonicalAAForBodyAdminEOA)} ` +
						`(on-card admin identity is EOA=calldataTo; AA is for Beamio spend paths)`
				)
			)
		} catch (e: any) {
			logger(Colors.yellow(`[cardAddAdmin] debug log failed: ${e?.message ?? e}`))
		}
		logger(Colors.green(`server /api/cardAddAdmin preCheck OK, forwarding to master executeForOwner`), inspect({ cardAddress: req.body?.cardAddress }, false, 2, true))
		postLocalhost('/api/executeForOwner', req.body, res)
	})

	/** cardAddAdminByAdmin：admin 为自己下层登记 admin。添加时：仅允许 EOA，body 必须含 adminEOA，Cluster 先 ensureAAForEOA（若 EOA 无 AA 则创建），再预检并转发。移除时无需 adminEOA。 */
	router.post('/cardAddAdminByAdmin', async (req, res) => {
		const data = req.body?.data as string
		let isAddingAdmin = false
		if (data && typeof data === 'string' && data.length >= 10) {
			const sel = data.slice(0, 10).toLowerCase()
			const iface4 = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata)'])
			const iface5 = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata, uint256 mintLimit)'])
			const is5 = sel === (iface5.getFunction('adminManager')?.selector ?? '').toLowerCase()
			try {
				const decoded = (is5 ? iface5 : iface4).parseTransaction({ data })
				if (decoded?.name === 'adminManager') isAddingAdmin = decoded.args[1] === true
			} catch (_) { /* ignore */ }
		}
		if (isAddingAdmin) {
			const adminEOA = (req.body?.adminEOA as string)?.trim()
			if (!adminEOA || !ethers.isAddress(adminEOA)) {
				return res.status(400).json({ success: false, error: 'adminEOA is required when adding admin. Pass the EOA address to add.' }).end()
			}
			const adminNorm = ethers.getAddress(adminEOA)
			let ensureBody = ''
			try {
				const { statusCode, body: eb } = await getLocalhostBuffer('/api/ensureAAForEOA?eoa=' + encodeURIComponent(adminNorm))
				ensureBody = eb
				if (statusCode !== 200) {
					const err = (() => { try { const j = JSON.parse(ensureBody); return j?.error ?? 'Failed to ensure AA for EOA' } catch { return 'Failed to ensure AA for EOA' } })()
					return res.status(400).json({ success: false, error: err }).end()
				}
			} catch (e: any) {
				logger(Colors.red(`[cardAddAdminByAdmin] ensureAAForEOA failed: ${e?.message ?? e}`))
				return res.status(502).json({ success: false, error: 'Failed to ensure AA for EOA' }).end()
			}
			const visible = await assertAdminEoaHasVisibleAaAfterEnsure(adminNorm, ensureBody, 'cardAddAdminByAdmin')
			if (!visible.ok) {
				return res.status(400).json({ success: false, error: visible.error }).end()
			}
		}
		const preCheck = await cardAddAdminByAdminPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardAddAdminByAdmin preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardAddAdminByAdmin preCheck OK, forwarding to master executeForAdmin`), inspect({ cardAddress: req.body?.cardAddress }, false, 2, true))
		postLocalhost('/api/executeForAdmin', req.body, res)
	})

	/** GET /api/cardAdmins：查询 card 的 admin 列表，连同 metadata、parent、mintCounter 一起回送 */
	router.get('/cardAdmins', async (req, res) => {
		const cardAddress = (req.query?.cardAddress as string)?.trim()
		if (!cardAddress || !ethers.isAddress(cardAddress)) {
			return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress query' }).end()
		}
		const result = await getCardAdminsWithMintCounter(cardAddress)
		if (!result.success) {
			return res.status(400).json(result).end()
		}
		return res.status(200).json({ success: true, admins: result.admins }).end()
	})

	/** cardClearAdminMintCounter：parent admin 签字清零 subordinate 的 mint 计数。Cluster 预检 signer==adminParent(subordinate)，合格转发 master */
	router.post('/cardClearAdminMintCounter', async (req, res) => {
		const preCheck = await cardClearAdminMintCounterPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardClearAdminMintCounter preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardClearAdminMintCounter preCheck OK, forwarding to master`), inspect({ cardAddress: req.body?.cardAddress, subordinate: req.body?.subordinate }, false, 2, true))
		postLocalhost('/api/cardClearAdminMintCounter', req.body, res)
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

	/** cardMintIssuedNftToAddress：owner 离线签字发行 issued NFT 到指定地址。Cluster 预检 targetAddress 为 EOA、签名有效，编码 data 后转发 master executeForOwner */
	router.post('/cardMintIssuedNftToAddress', async (req, res) => {
		const preCheck = await cardMintIssuedNftToAddressPreCheck(req.body)
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardMintIssuedNftToAddress preCheck FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
			return res.status(400).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardMintIssuedNftToAddress preCheck OK, forwarding to master executeForOwner`), inspect({ cardAddress: preCheck.preChecked.cardAddress, targetAddress: req.body?.targetAddress }, false, 2, true))
		postLocalhost('/api/executeForOwner', { ...preCheck.preChecked, targetAddress: req.body?.targetAddress }, res)
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

	/** cardRedeemAdmin：用户兑换 redeem-admin 码，将 EOA 用户登记为指定卡的 admin。Cluster 预检链上 redeem code 有效后转发 master */
	router.post('/cardRedeemAdmin', async (req, res) => {
		const { cardAddress, redeemCode, to } = req.body || {}
		if (!cardAddress || !redeemCode || !to || !ethers.isAddress(cardAddress) || !ethers.isAddress(to)) {
			return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, to' })
		}
		const resolvedCard = OLD_CCSA_REDIRECTS.includes(cardAddress.toLowerCase()) ? BASE_CCSA_CARD_ADDRESS : cardAddress
		const preCheck = await cardRedeemAdminPreCheck({ cardAddress: resolvedCard, redeemCode, to })
		if (!preCheck.success) {
			logger(Colors.red(`server /api/cardRedeemAdmin preCheck FAIL: ${preCheck.error}`), { cardAddress: resolvedCard, to })
			return res.status(403).json({ success: false, error: preCheck.error }).end()
		}
		logger(Colors.green(`server /api/cardRedeemAdmin preCheck OK, forwarding to master`), { cardAddress: resolvedCard, to })
		postLocalhost('/api/cardRedeemAdmin', { ...req.body, cardAddress: resolvedCard }, res)
	})

	/** redeemSeries：用户使用 redeem code 兑换 NFT（与 cardRedeem 相同逻辑，用于特别设置 NFT 兑换） */
	router.post('/redeemSeries', async (req, res) => {
		const { cardAddress, redeemCode, toUserEOA } = req.body || {}
		if (!cardAddress || !redeemCode || !toUserEOA || !ethers.isAddress(cardAddress) || !ethers.isAddress(toUserEOA)) {
			return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, toUserEOA' })
		}
		logger(Colors.green(`server /api/redeemSeries forwarding to master`), { cardAddress, toUserEOA })
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
			const bunitCheck = await ContainerRelayPreCheckBUnitBalance(body.containerPayload, body.currency ?? 'USDC', body.currencyAmount ?? '0')
			if (!bunitCheck.success) {
				logger(Colors.red(`[AAtoEOA] server Container B-Unit pre-check FAIL: ${bunitCheck.error}`))
				return res.status(400).json({ success: false, error: bunitCheck.error }).end()
			}
			const closedPayerAa = body.containerPayload?.account
			if (closedPayerAa && ethers.isAddress(closedPayerAa)) {
				const lbCc = await nfcLinkAppPaymentBlockedIfAny({ aaAddress: closedPayerAa })
				if (lbCc) {
					return res.status(403).json({ success: false, error: lbCc }).end()
				}
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
			if (body.chargeOwnerChildBurn && typeof body.chargeOwnerChildBurn === 'object') {
				const burnPre = await verifyChargeOwnerChildBurnClusterPreCheck({
					burn: body.chargeOwnerChildBurn as import('../MemberCard').ChargeOwnerChildBurnPayload,
					payeeTo: body.containerPayload.to,
					merchantCardAddress: typeof body.merchantCardAddress === 'string' ? body.merchantCardAddress : undefined,
					items: body.containerPayload.items ?? [],
				})
				if (!burnPre.ok) {
					logger(Colors.red(`[AAtoEOA] chargeOwnerChildBurn Cluster REJECT (container): ${burnPre.error}`))
					return res.status(400).json({ success: false, error: burnPre.error }).end()
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
				...(body.chargeOwnerChildBurn && typeof body.chargeOwnerChildBurn === 'object'
					? { chargeOwnerChildBurn: body.chargeOwnerChildBurn }
					: {}),
			}, res)
			return
		}

		if (body.openContainerPayload) {
			const preCheck = OpenContainerRelayPreCheck(body.openContainerPayload)
			if (!preCheck.success) {
				logger(Colors.red(`[AAtoEOA] server OpenContainer pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			/** 付款 AA 必须与 UserCard 工厂链路 canonical 一致，否则链上 balanceOf(account,0) 为 0 导致 CM_Reserved1155Violation */
			try {
				const acc = ethers.getAddress(body.openContainerPayload.account)
				const aaOwnerAbi = ['function owner() view returns (address)']
				const aaContract = new ethers.Contract(acc, aaOwnerAbi, providerBase)
				const ownerRaw = await aaContract.owner()
				if (!ownerRaw || ownerRaw === ethers.ZeroAddress) {
					logger(Colors.red(`[AAtoEOA] server OpenContainer REJECT: invalid AA owner for ${acc}`))
					return res
						.status(400)
						.json({ success: false, error: 'openContainerPayload.account is not a valid Beamio AA' })
						.end()
				}
				const eoa = ethers.getAddress(ownerRaw)
				const canonical = await resolveBeamioAaForEoaWithFallback(providerBase, eoa)
				if (canonical && canonical.toLowerCase() !== acc.toLowerCase()) {
					const msg = `openContainer account ${acc} does not match canonical AA ${canonical} for owner ${eoa}. Refresh aaAddress from getWalletAssets or getAAAccount and re-sign.`
					logger(Colors.yellow(`[AAtoEOA] server OpenContainer REJECT: ${msg}`))
					return res.status(400).json({ success: false, error: msg }).end()
				}
			} catch (e: any) {
				const m = e?.shortMessage ?? e?.message ?? String(e)
				logger(Colors.red(`[AAtoEOA] server OpenContainer canonical AA check FAIL: ${m}`))
				return res
					.status(400)
					.json({ success: false, error: 'Failed to validate openContainerPayload.account against canonical AA' })
					.end()
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
			const bunitCheck = await OpenContainerRelayPreCheckBUnitFee(body.openContainerPayload, body.currency ?? [], body.currencyAmount ?? [])
			if (!bunitCheck.success) {
				logger(Colors.red(`[AAtoEOA] server OpenContainer B-Unit pre-check FAIL: ${bunitCheck.error}`))
				return res.status(400).json({ success: false, error: bunitCheck.error }).end()
			}
			const payerAa = body.openContainerPayload?.account
			if (payerAa && ethers.isAddress(payerAa)) {
				const lbOc = await nfcLinkAppPaymentBlockedIfAny({ aaAddress: payerAa })
				if (lbOc) {
					return res.status(403).json({ success: false, error: lbOc }).end()
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
			if (body.chargeOwnerChildBurn && typeof body.chargeOwnerChildBurn === 'object') {
				const burnPre = await verifyChargeOwnerChildBurnClusterPreCheck({
					burn: body.chargeOwnerChildBurn as import('../MemberCard').ChargeOwnerChildBurnPayload,
					payeeTo: body.openContainerPayload.to,
					merchantCardAddress: typeof body.merchantCardAddress === 'string' ? body.merchantCardAddress : undefined,
					items: body.openContainerPayload.items ?? [],
				})
				if (!burnPre.ok) {
					logger(Colors.red(`[AAtoEOA] chargeOwnerChildBurn Cluster REJECT (openContainer): ${burnPre.error}`))
					return res.status(400).json({ success: false, error: burnPre.error }).end()
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
				merchantCardAddress: body.merchantCardAddress,
				nfcSubtotalCurrencyAmount: body.nfcSubtotalCurrencyAmount,
				nfcTipCurrencyAmount: body.nfcTipCurrencyAmount,
				nfcTipRateBps: body.nfcTipRateBps,
				nfcRequestCurrency: body.nfcRequestCurrency,
				nfcDiscountAmountFiat6: body.nfcDiscountAmountFiat6,
				nfcDiscountRateBps: body.nfcDiscountRateBps,
				nfcTaxAmountFiat6: body.nfcTaxAmountFiat6,
				nfcTaxRateBps: body.nfcTaxRateBps,
				...(body.chargeOwnerChildBurn && typeof body.chargeOwnerChildBurn === 'object'
					? { chargeOwnerChildBurn: body.chargeOwnerChildBurn }
					: {}),
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
		const bunitCheck = await AAtoEOAPreCheckBUnitBalance(packedUserOp!)
		if (!bunitCheck.success) {
			logger(Colors.red(`[AAtoEOA] server B-Unit balance pre-check FAIL: ${bunitCheck.error}`))
			return res.status(400).json({ success: false, error: bunitCheck.error }).end()
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

	/** GET /api/transferPreCheckBUnit - UI 自检转账前 B-Unit 是否 >= 2。account=EOA 或 aaAddress=AA（解析 owner 后检查） */
	router.get('/transferPreCheckBUnit', async (req, res) => {
		const account = req.query.account as string
		const aaAddress = req.query.aaAddress as string
		if (!account && !aaAddress) {
			return res.status(400).json({ success: false, error: 'Missing account or aaAddress' }).end()
		}
		if (account && !ethers.isAddress(account)) {
			return res.status(400).json({ success: false, error: 'Invalid account address' }).end()
		}
		if (aaAddress && !ethers.isAddress(aaAddress)) {
			return res.status(400).json({ success: false, error: 'Invalid aaAddress' }).end()
		}
		const check = await transferPreCheckBUnit({ account: account || undefined, aaAddress: aaAddress || undefined })
		if (!check.success) {
			return res.status(200).json({ success: false, error: check.error }).end()
		}
		return res.status(200).json({ success: true }).end()
	})

	/** GET /api/requestAccountingPreCheck - UI 自检 B-Unit 是否足够，不写链。用于创建 payment request 前预检 */
	router.get('/requestAccountingPreCheck', async (req, res) => {
		const payee = req.query.payee as string
		const amount = req.query.amount as string
		const currency = (req.query.currency as string) || 'USD'
		if (!payee || !amount) {
			return res.status(400).json({ success: false, error: 'Missing payee or amount' }).end()
		}
		if (!ethers.isAddress(payee)) {
			return res.status(400).json({ success: false, error: 'Invalid payee address' }).end()
		}
		const amt = parseFloat(String(amount))
		if (!Number.isFinite(amt) || amt <= 0) {
			return res.status(400).json({ success: false, error: 'amount must be > 0' }).end()
		}
		const bunitFeeCheck = await requestAccountingPreCheckBUnitFee(payee, amount, currency)
		if (!bunitFeeCheck.success) {
			return res.status(200).json({ success: false, error: bunitFeeCheck.error }).end()
		}
		return res.status(200).json({ success: true, feeAmount: bunitFeeCheck.feeAmount?.toString() }).end()
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
		const bunitFeeCheck = await requestAccountingPreCheckBUnitFee(String(payee), String(amount), currency ? String(currency) : 'USD')
		if (!bunitFeeCheck.success) {
			logger(Colors.red(`[requestAccounting] B-Unit fee pre-check FAIL: ${bunitFeeCheck.error}`))
			return res.status(400).json({ success: false, error: bunitFeeCheck.error }).end()
		}
		logger(Colors.green(`[requestAccounting] server pre-check OK, forwarding to master | fee=${Number(bunitFeeCheck.feeAmount ?? 0) / 1e6} B-Units`), inspect({ requestHash, payee, amount, validDays }, false, 2, true))
		postLocalhost('/api/requestAccounting', {
			requestHash: String(requestHash),
			payee: String(payee),
			amount: String(amount),
			currency: currency ? String(currency) : 'USD',
			forText: forText ? String(forText) : undefined,
			validDays: vd,
			feeBUnits: bunitFeeCheck.feeAmount?.toString(),
			payerEOA: bunitFeeCheck.payerEOA,
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
				ledgerTxId?: string
				ledgerOriginalPaymentHash?: string
				ledgerTxCategory?: string
				source?: string
				payeeEOA?: string
				merchantCardAddress?: string
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
			const tipLedgerRow = isChargeLedgerTxTipRow(body.ledgerTxCategory)
			const reqHashValid = body.requestHash && ethers.isHexString(body.requestHash) && ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined
			// TX_TIP 为同一笔 Base relay 的附属行：不得再按 Bill requestHash 做「已履约」拦截，否则第二条记账会被 Cluster 403
			if (!tipLedgerRow && reqHashValid && body.to && ethers.isAddress(body.to)) {
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
			if (tipLedgerRow) {
				const lid = body.ledgerTxId != null ? String(body.ledgerTxId).trim() : ''
				const lorig = body.ledgerOriginalPaymentHash != null ? String(body.ledgerOriginalPaymentHash).trim() : ''
				const fh = String(body.finishedHash).trim()
				if (!lid || !ethers.isHexString(lid) || ethers.dataLength(lid) !== 32) {
					return res.status(400).json({ success: false, error: 'TX_TIP accounting requires ledgerTxId (random bytes32, distinct from main tx id)' }).end()
				}
				if (!lorig || !ethers.isHexString(lorig) || ethers.dataLength(lorig) !== 32) {
					return res.status(400).json({ success: false, error: 'TX_TIP accounting requires ledgerOriginalPaymentHash (parent main Transaction.id / Base relay tx hash)' }).end()
				}
				if (lorig.toLowerCase() !== fh.toLowerCase()) {
					return res.status(400).json({ success: false, error: 'TX_TIP ledgerOriginalPaymentHash must equal finishedHash (main relay tx hash)' }).end()
				}
				if (lid.toLowerCase() === fh.toLowerCase()) {
					return res.status(400).json({ success: false, error: 'TX_TIP ledgerTxId must not equal finishedHash; use a new random bytes32 for tip row id' }).end()
				}
				logger(
					Colors.cyan(
						`[beamioTransferIndexerAccounting] TX_TIP charge ledger Transaction preview (readme) = ${inspect(buildChargeLedgerTransactionPreviewFromIndexerBody(body), false, 4, true)}`
					)
				)
			}
			logger(Colors.green(`[beamioTransferIndexerAccounting] server pre-check OK, forwarding to master from=${body.from?.slice(0, 10)}… to=${body.to?.slice(0, 10)}… requestHash=${body.requestHash ?? 'n/a'}${tipLedgerRow ? ' (TX_TIP row)' : ''}`))
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

	/** POST /api/buintRedeemAirdropPreCheck - 读 CoNET 合约，校验兑换码是否可领（Cluster 直出） */
	router.post('/buintRedeemAirdropPreCheck', async (req, res) => {
		const code = typeof (req.body as { code?: unknown })?.code === 'string' ? (req.body as { code: string }).code : ''
		try {
			const out = await buintRedeemAirdropQueryOnChain(code)
			return res.status(200).json(out).end()
		} catch (e: any) {
			logger(Colors.red('[buintRedeemAirdropPreCheck] error:'), e?.message ?? e)
			return res.status(400).json({ valid: false, redeemable: false, error: e?.message ?? String(e) }).end()
		}
	})

	/** POST /api/buintRedeemAirdropRedeem - admin 代付：Master 先 ensureAAForEOA(Base)，再 redeemWithCodeAsAdmin（recipient=该 EOA 的 AA）；cluster 完整预检后转 master */
	router.post('/buintRedeemAirdropRedeem', async (req, res) => {
		const body = req.body as { eoa?: string; code?: string }
		const pre = buintRedeemAirdropRedeemClusterPreCheck(body)
		if (!pre.success) {
			logger(Colors.red(`server /api/buintRedeemAirdropRedeem preCheck FAIL: ${pre.error}`))
			return res.status(400).json({ success: false, error: pre.error }).end()
		}
		const chain = await buintRedeemAirdropQueryOnChain(pre.code)
		if (!chain.redeemable) {
			const err = chain.error ?? 'Redeem not available'
			logger(Colors.red(`server /api/buintRedeemAirdropRedeem not redeemable: ${err}`))
			return res.status(400).json({ success: false, error: err }).end()
		}
		logger(Colors.green('server /api/buintRedeemAirdropRedeem preCheck OK, forwarding to master'))
		postLocalhost('/api/buintRedeemAirdropRedeem', { eoa: pre.eoa, code: pre.code }, res)
	})

	/** POST /api/businessStartKetRedeemRedeem — BusinessStartKetRedeem：Cluster 读链预检后代付 redeemWithCodeAsAdmin（Ket + B-Unit → 用户 EOA，CoNET） */
	router.post('/businessStartKetRedeemRedeem', async (req, res) => {
		const body = req.body as { eoa?: string; code?: string }
		const pre = businessStartKetRedeemRedeemClusterPreCheck(body)
		if (!pre.success) {
			logger(Colors.red(`server /api/businessStartKetRedeemRedeem preCheck FAIL: ${pre.error}`))
			return res.status(400).json({ success: false, error: pre.error }).end()
		}
		try {
			const chain = await businessStartKetRedeemQueryOnChain(pre.code)
			if (!chain.redeemable) {
				const err = chain.error ?? 'Redeem not available'
				logger(Colors.red(`server /api/businessStartKetRedeemRedeem not redeemable: ${err}`))
				return res.status(400).json({ success: false, error: err }).end()
			}
		} catch (e: any) {
			logger(Colors.red('[businessStartKetRedeemRedeem] query error:'), e?.message ?? e)
			return res.status(400).json({ success: false, error: e?.message ?? 'Query failed' }).end()
		}
		logger(Colors.green('server /api/businessStartKetRedeemRedeem preCheck OK, forwarding to master'))
		postLocalhost('/api/businessStartKetRedeemRedeem', { eoa: pre.eoa, code: pre.code }, res)
	})

	/** GET /api/businessStartKetRedeemAdminNonce?admin=0x… — Cluster 直读 CoNET redeemAdminNonces（供签名前） */
	router.get('/businessStartKetRedeemAdminNonce', async (req, res) => {
		const admin = typeof req.query.admin === 'string' ? req.query.admin.trim() : ''
		const out = await businessStartKetRedeemReadAdminNonce(admin)
		if (!out.ok) {
			return res.status(400).json({ success: false, error: out.error }).end()
		}
		return res.status(200).json({ success: true, nonce: out.nonce }).end()
	})

	/** POST /api/businessStartKetRedeemAdminCreate — redeem admin EIP-712 授权；Cluster 完整预检后转发 Master，Settle 代付 gas 调 createRedeemFor（Ket #0 ×1 + 指定 B-Unit） */
	router.post('/businessStartKetRedeemAdminCreate', async (req, res) => {
		const pre = await businessStartKetRedeemCreateClusterPreCheck(req.body)
		if (!pre.success) {
			logger(Colors.red(`server /api/businessStartKetRedeemAdminCreate preCheck FAIL: ${pre.error}`))
			return res.status(400).json({ success: false, error: pre.error }).end()
		}
		logger(Colors.green('server /api/businessStartKetRedeemAdminCreate preCheck OK, forwarding to master'))
		const p = pre.preChecked
		postLocalhost(
			'/api/businessStartKetRedeemAdminCreate',
			{
				contract: p.contract,
				admin: p.admin,
				codeHash: p.codeHash,
				tokenId: p.tokenId.toString(),
				ketAmount: p.ketAmount.toString(),
				buintAmount: p.buintAmount.toString(),
				validAfter: p.validAfter.toString(),
				validBefore: p.validBefore.toString(),
				nonce: p.nonce.toString(),
				deadline: p.deadline.toString(),
				signature: p.signature,
			},
			res
		)
	})

	/** POST /api/businessStartKetRedeemAdminCancel — redeem admin EIP-712 授权取消兑换 */
	router.post('/businessStartKetRedeemAdminCancel', async (req, res) => {
		const pre = await businessStartKetRedeemCancelClusterPreCheck(req.body)
		if (!pre.success) {
			logger(Colors.red(`server /api/businessStartKetRedeemAdminCancel preCheck FAIL: ${pre.error}`))
			return res.status(400).json({ success: false, error: pre.error }).end()
		}
		logger(Colors.green('server /api/businessStartKetRedeemAdminCancel preCheck OK, forwarding to master'))
		const cp = pre.preChecked
		postLocalhost(
			'/api/businessStartKetRedeemAdminCancel',
			{
				contract: cp.contract,
				admin: cp.admin,
				codeHash: cp.codeHash,
				nonce: cp.nonce.toString(),
				deadline: cp.deadline.toString(),
				signature: cp.signature,
			},
			res
		)
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
				chainId: 224422,
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

	/** POST /api/registerPOS - merchant EIP-712 RegisterPOS，Cluster 验签后转发 Master 代付 CoNET Gas */
	router.post('/registerPOS', async (req, res) => {
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
				chainId: 224422,
				verifyingContract: MERCHANT_POS_MANAGEMENT_CONET as `0x${string}`,
			}
			const types = {
				RegisterPOS: [
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
			logger(Colors.red(`[registerPOS] signature verify failed: ${e?.message ?? e}`))
			return res.status(400).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'Invalid signature' })
		}
		logger(Colors.green(`[registerPOS] Cluster preCheck OK merchant=${merchant.slice(0, 10)}... pos=${pos.slice(0, 10)}... forwarding to master`))
		postLocalhost('/api/registerPOS', {
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

	/** GET /api/ensureAAForEOA?eoa=0x... - 转发 Master；返回 { aa }。cardAddAdmin 须用真实商户 EOA，adminManager.to 须与同 body.adminEOA 一致。 */
	router.get('/ensureAAForEOA', async (req, res) => {
		const { eoa } = req.query as { eoa?: string }
		if (!eoa || !ethers.isAddress(eoa)) {
			return res.status(400).json({ error: 'Invalid eoa: require valid 0x address' })
		}
		try {
			const path = '/api/ensureAAForEOA?eoa=' + encodeURIComponent(eoa)
			const { statusCode, body } = await getLocalhostBuffer(path)
			res.status(statusCode).setHeader('Content-Type', 'application/json').send(body)
		} catch (e: any) {
			logger(Colors.red('[ensureAAForEOA] forward error:'), e?.message ?? e)
			res.status(502).json({ error: e?.message ?? 'Failed to ensure AA for EOA' })
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
			// 源自 deployments/conet-addresses.json:BUint（chain 224422 重启后地址）。
			// 旧地址 0xC97CEbb4DF827cB2D1453A9Df7FEf6dADa1C16Ad 已废弃，链上无代码会触发 BAD_DATA。
			const CONET_BUINT = '0x1330297821814B06A6DafE3557Fa730F690D7007'
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

	/** GET /api/getBUnitLedger?address=0x... - CoNET B-Unit 记账明细，30 秒缓存。供前端绕过 CORS 获取。?_nocache=1 跳过缓存。 */
	router.get('/getBUnitLedger', async (req, res) => {
		const { address, _nocache } = req.query as { address?: string; _nocache?: string }
		if (!address || !ethers.isAddress(address)) {
			return res.status(400).json({ error: 'Invalid address: require valid 0x address' })
		}
		const cacheKey = ethers.getAddress(address).toLowerCase()
		const skipCache = _nocache === '1' || _nocache === 'true'
		const cached = !skipCache ? getBUnitLedgerCache.get(cacheKey) : undefined
		if (cached && Date.now() < cached.expiry) {
			return res.status(cached.statusCode).setHeader('Content-Type', 'application/json').send(cached.body)
		}
		try {
			// 源自 deployments/conet-addresses.json（chain 224422 重启后）。
			// 旧 BeamioIndexerDiamond 0xd990719B2f05ccab4Acdd5D7A3f7aDfd2Fc584Fe / 旧 BUint 0xC97CEbb4DF827cB2D1453A9Df7FEf6dADa1C16Ad 已废弃。
			const BEAMIO_INDEXER = '0x45D45de73465b8913B50974Fc188529dFFb7AfFA'
			const CONET_BUINT = '0x1330297821814B06A6DafE3557Fa730F690D7007'
			const INDEXER_ABI = ['function getAccountTransactionsPaged(address account, uint256 offset, uint256 limit) view returns ((bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, bool exists)[] page)']
			const TX_BUINT_CLAIM = ethers.keccak256(ethers.toUtf8Bytes('buintClaim'))
			const TX_BUINT_USDC = ethers.keccak256(ethers.toUtf8Bytes('buintUSDC'))
			const TX_REQUEST_ACCOUNTING = ethers.keccak256(ethers.toUtf8Bytes('requestAccounting'))
			const TX_SEND_USDC = ethers.keccak256(ethers.toUtf8Bytes('sendUSDC'))
			const TX_X402_SEND = ethers.keccak256(ethers.toUtf8Bytes('x402Send'))
			const indexer = new ethers.Contract(BEAMIO_INDEXER, INDEXER_ABI, providerConet)
			const page = await indexer.getAccountTransactionsPaged(address, 0, 100)
			const accountLower = address.toLowerCase()
			const buintLower = CONET_BUINT.toLowerCase()
			const decimals = 6
			const serializeJsonSafe = (value: unknown): unknown => {
				if (typeof value === 'bigint') return value.toString()
				if (Array.isArray(value)) return value.map((item) => serializeJsonSafe(item))
				if (value && typeof value === 'object') {
					const out: Record<string, unknown> = {}
					for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
						out[k] = serializeJsonSafe(v)
					}
					return out
				}
				return value
			}
			const serializeRawTx = (tx: unknown): Record<string, unknown> => {
				if (tx == null || typeof tx !== 'object') return {}
				const t = tx as Record<string, unknown>
				return {
					id: serializeJsonSafe(t.id),
					originalPaymentHash: serializeJsonSafe(t.originalPaymentHash),
					chainId: serializeJsonSafe(t.chainId),
					txCategory: serializeJsonSafe(t.txCategory),
					displayJson: serializeJsonSafe(t.displayJson),
					timestamp: serializeJsonSafe(t.timestamp),
					payer: serializeJsonSafe(t.payer),
					payee: serializeJsonSafe(t.payee),
					finalRequestAmountFiat6: serializeJsonSafe(t.finalRequestAmountFiat6),
					finalRequestAmountUSDC6: serializeJsonSafe(t.finalRequestAmountUSDC6),
					isAAAccount: serializeJsonSafe(t.isAAAccount),
					fees: serializeJsonSafe(t.fees),
					meta: serializeJsonSafe(t.meta),
					exists: serializeJsonSafe(t.exists),
				}
			}
		const entries: Array<{ id: string; title: string; subtitle: string; amount: number; time: string; timestamp: number; type: string; status: string; linkedUsdc: string; txHash: string; network: string; baseTxHash?: string; originalPaymentHash?: string; rawTx: Record<string, unknown> }> = []
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
					entries.push({ ...baseEntry, id: txIdHex, title: 'BUnit Claim', subtitle: 'Free claim', amount: amountBUnits, type: 'reward', linkedUsdc: 'N/A', rawTx: serializeRawTx(tx) })
				} else if (txCategory === TX_BUINT_USDC && payee === accountLower) {
					const usdcAmount = amountUSDC6 > 0 ? amountUSDC6 / 10 ** decimals : amountBUnits / 100
					const usdcStr = usdcAmount > 0 ? `-${usdcAmount.toFixed(2)} USDC` : 'N/A'
					const rawOph = (tx as { originalPaymentHash?: string }).originalPaymentHash
					const baseTxHash = rawOph && rawOph !== ethers.ZeroHash && ethers.isHexString(rawOph) && ethers.dataLength(rawOph) === 32 ? rawOph : undefined
					entries.push({ ...baseEntry, id: txIdHex, title: 'Fuel Yield (1:100)', subtitle: 'System Top-up', amount: amountBUnits, type: 'refuel', linkedUsdc: usdcStr, baseTxHash, rawTx: serializeRawTx(tx) })
				} else if (payee === buintLower && payer === accountLower) {
					const rawOphVal = (tx as { originalPaymentHash?: string | bigint }).originalPaymentHash
					const rawOph = rawOphVal != null
						? (typeof rawOphVal === 'string' ? rawOphVal : '0x' + BigInt(rawOphVal).toString(16).padStart(64, '0'))
						: undefined
					const txCatNorm = (typeof txCategory === 'string' ? txCategory : txCategory != null ? '0x' + BigInt(txCategory).toString(16).padStart(64, '0') : '').toLowerCase()
					const isRequestAccounting = txCatNorm === TX_REQUEST_ACCOUNTING.toLowerCase()
					const isSendUSDC = txCatNorm === TX_SEND_USDC.toLowerCase()
					const isX402Send = txCatNorm === TX_X402_SEND.toLowerCase()
					// requestAccounting 的 originalPaymentHash 是 requestHash，用 CoNET 链接；其他用 Base 链接
					const ophHex = rawOph && rawOph !== ethers.ZeroHash && ethers.isHexString(rawOph) && ethers.dataLength(rawOph) === 32 ? (rawOph.startsWith('0x') ? rawOph : '0x' + rawOph) : ''
					const baseTxHash = !isRequestAccounting && ophHex && ethers.dataLength(ophHex) === 32 ? ophHex : undefined
					const originalPaymentHash = isRequestAccounting && ophHex && ethers.dataLength(ophHex) === 32 ? ophHex : undefined
					const title = isRequestAccounting
						? 'Service Fee (0.8%)'
						: isSendUSDC || isX402Send
							? 'Service Fee'
							: 'B-Unit Burn'
					const subtitle = isRequestAccounting
						? `Payment Request ${ophHex ? ophHex.slice(-3) : '—'}`
						: (isSendUSDC || isX402Send)
							? ''
							: (amountUSDC6 > 0 ? `Paid ${(amountUSDC6 / 10 ** decimals).toFixed(2)} USDC` : 'Gas / Fee')
					const isServiceFee = amountUSDC6 > 0 || isRequestAccounting || isSendUSDC || isX402Send
					entries.push({
						...baseEntry,
						id: txIdHex,
						title,
						subtitle,
						amount: -amountBUnits,
						type: isServiceFee ? 'fee' : 'gas',
						linkedUsdc: amountUSDC6 > 0 ? `${(amountUSDC6 / 10 ** decimals).toFixed(2)} USDC` : 'N/A',
						baseTxHash,
						originalPaymentHash,
						rawTx: serializeRawTx(tx),
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
			const topupStats = await getCardTopupRollup(cardAddress)
			logger(Colors.green(`[cardMetadata] 200: card_owner=${row.cardOwner}`))
			res.setHeader('Content-Type', 'application/json')
			res.json({
				cardOwner: row.cardOwner,
				metadata: row.metadata,
				topupStats: {
					totalTopupCount: topupStats.totalTopupCount,
					totalRepeatTopupCount: topupStats.totalRepeatTopupCount,
					nfcActivationCount: topupStats.nfcActivationCount,
					appActivationCount: topupStats.appActivationCount,
				},
			})
		} catch (err: any) {
			logger(Colors.red('[cardMetadata] 500 error:'), err?.message ?? err)
			return res.status(500).json({ error: 'Failed to fetch card metadata' })
		}
	})

	/**
	 * GET /api/cardMemberTopups?cardAddress=0x…&mode=events|members|directory|card&limit=&offset=&page=
	 * card：仅返回该卡 totalTopupCount、totalRepeatTopupCount（全站成功 top-up 次数与 repeat 次数）。
	 * events / members 含义同前。
	 * directory：同 members 分页，但每行含 usedNfc、usedApp、firstTopupSource、firstTopupAt（由 beamio_member_topup_events 聚合）。
	 * page 为 1 基页码（与 limit 联用：offset=(page-1)*limit）；若同时传 offset，以 offset 为准。
	 */
	router.get('/cardMemberTopups', async (req, res) => {
		const q = req.query as { cardAddress?: string; mode?: string; limit?: string; offset?: string; page?: string }
		const { cardAddress, mode, limit: limitQ, offset: offsetQ, page: pageQ } = q
		if (!cardAddress || !ethers.isAddress(cardAddress)) {
			return res.status(400).json({ error: 'Invalid cardAddress: require valid 0x address' })
		}
		const m = String(mode || 'events').toLowerCase()
		const parsedLimit = limitQ != null && String(limitQ).trim() !== '' ? Number(limitQ) : 20
		const limit = Math.min(Math.max(Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 20, 1), 2000)
		let offset = 0
		if (offsetQ != null && String(offsetQ).trim() !== '') {
			const o = Number(offsetQ)
			offset = Number.isFinite(o) && o > 0 ? Math.floor(o) : 0
		} else if (pageQ != null && String(pageQ).trim() !== '') {
			const p = Number(pageQ)
			const page = Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1
			offset = (page - 1) * limit
		}
		const addrNorm = ethers.getAddress(cardAddress)
		try {
			if (m === 'card') {
				const rollup = await getCardTopupRollup(cardAddress)
				return res.status(200).json({
					mode: 'card',
					cardAddress: addrNorm,
					totalTopupCount: rollup.totalTopupCount,
					totalRepeatTopupCount: rollup.totalRepeatTopupCount,
					nfcActivationCount: rollup.nfcActivationCount,
					appActivationCount: rollup.appActivationCount,
				})
			}
			if (m === 'members') {
				const { items, total } = await listDistinctCardMemberTopupMembers(cardAddress, { limit, offset })
				const pageNum = limit > 0 ? Math.floor(offset / limit) + 1 : 1
				return res.status(200).json({
					mode: 'members',
					cardAddress: addrNorm,
					total,
					limit,
					offset,
					page: pageNum,
					members: items,
				})
			}
			if (m === 'directory') {
				const { items, total } = await listCardMemberDirectory(cardAddress, { limit, offset })
				const pageNum = limit > 0 ? Math.floor(offset / limit) + 1 : 1
				return res.status(200).json({
					mode: 'directory',
					cardAddress: addrNorm,
					total,
					limit,
					offset,
					page: pageNum,
					members: items,
				})
			}
			const { items, total } = await listCardMemberTopupEvents(cardAddress, { limit, offset })
			const pageNum = limit > 0 ? Math.floor(offset / limit) + 1 : 1
			return res.status(200).json({
				mode: 'events',
				cardAddress: addrNorm,
				total,
				limit,
				offset,
				page: pageNum,
				events: items,
			})
		} catch (err: any) {
			logger(Colors.red('[cardMemberTopups] error:'), err?.message ?? err)
			return res.status(500).json({ error: 'Failed to fetch card member top-ups' })
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

	/**
	 * Merchant Programs — Cluster 仅预检后转发 Master（会话状态仅在 Master 单进程，避免多 worker 内存分裂）。
	 * body: `{ walletAddress, packageType: 'lite_kit' | 'standard_kit' | 'custom_kit' }`
	 */
	router.post('/merchantKitStripe/createSession', async (req, res) => {
		const { walletAddress, packageType } = req.body ?? {}
		if (!walletAddress || typeof packageType !== 'string') {
			return res.status(400).json({ error: 'walletAddress and packageType required' }).end()
		}
		if (!ethers.isAddress(walletAddress)) {
			return res.status(400).json({ error: 'Invalid walletAddress' }).end()
		}
		if (
			packageType !== 'lite_kit' &&
			packageType !== 'standard_kit' &&
			packageType !== 'custom_kit'
		) {
			return res.status(400).json({ error: 'Invalid packageType' }).end()
		}
		const sk =
			(typeof process !== 'undefined' && process.env?.STRIPE_SECRET_KEY?.trim()) ||
			(masterSetup as { stripe_SecretKey?: string }).stripe_SecretKey?.trim() ||
			''
		if (!sk) {
			logger(Colors.red('[merchantKitStripe] createSession cluster precheck: Stripe key missing'))
			return res.status(503).json({ error: 'Stripe is not configured on server' }).end()
		}
		return postLocalhost(
			'/api/merchantKitStripe/createSession',
			{ walletAddress: ethers.getAddress(walletAddress), packageType },
			res
		)
	})

	router.post('/merchantKitStripe/poll', async (req, res) => {
		const { sessionId, userClosedCheckout } = req.body ?? {}
		if (!sessionId || typeof sessionId !== 'string') {
			return res.status(400).json({ error: 'sessionId required' }).end()
		}
		return postLocalhost('/api/merchantKitStripe/poll', { sessionId, userClosedCheckout: Boolean(userClosedCheckout) }, res)
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

	/** Stripe merchant-kit webhook must see raw body (before express.json). Configure URL in Stripe Dashboard → same path on beamio.app. */
	app.post(
		'/api/merchant-kit-stripe-webhook',
		express.raw({ type: 'application/json' }),
		async (req: Request, res: Response) => {
			const ip = getClientIp(req)
			const ua = String(req.headers['user-agent'] ?? '').slice(0, 80)
			logger(
				Colors.cyan('[merchant-kit-stripe-webhook] POST → master'),
				`ip=${ip || '(none)'}`,
				`ua=${ua || '(none)'}`
			)
			return postLocalhostRaw(
				'/api/merchant-kit-stripe-webhook',
				req.body as Buffer,
				req.headers['stripe-signature'],
				res
			)
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
		// 生产环境只把所有 CORS 预检透传给 nginx 处理，但这里加一行轻量日志，
		// 用于排查 x402 客户端"Failed to fetch"问题：如果浏览器第二跳带着 X-PAYMENT 的预检
		// 实际打到了 Node，会在这里看到 `acrh=...,x-payment`；如果完全看不到 OPTIONS log，
		// 就说明 nginx 自己回的 OPTIONS（可能没把 X-PAYMENT 列入 Access-Control-Allow-Headers）。
		app.use((req, _res, next) => {
			if (req.method === 'OPTIONS') {
				const acrm = req.header('access-control-request-method') ?? '(none)'
				const acrh = req.header('access-control-request-headers') ?? '(none)'
				const origin = req.header('origin') ?? '(no-origin)'
				logger(`[CORS preflight] path=${req.originalUrl} origin=${origin} acrm=${acrm} acrh=${acrh}`)
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

	/** Short link for Verra NDEF / SoftPOS: UA-based redirect to TestFlight or Play Store. */
	app.get('/go/verra-ndef', (req: Request, res: Response) => {
		const ua = String(req.headers['user-agent'] ?? '')
		const loc = resolveVerraNdefInstallRedirectUrl(ua)
		logger(
			Colors.cyan('[go/verra-ndef] redirect'),
			`→ ${loc}`,
			`ua=${ua.slice(0, 120)}`
		)
		res.redirect(302, loc)
	})

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

	/** GET /metadata/:filename - 唯一统一约定（Base Explorer / EIP-1155）：
	 *  仅支持 0x{40hex}{suffix}.json，40hex = ERC-1155 合约（卡）地址，suffix = tokenId（十进制或 64 位十六进制）。
	 *  tokenId=0 返回卡级 metadata（getCardByAddress），否则返回该 NFT tier metadata（getNftTierMetadataByCardAndToken）。
	 */
	app.get('/metadata/:filename', async (req, res) => {
		const filename = req.params.filename
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
				const payload = await getNftTierMetadataByCardAndToken(cardAddress, tokenId)
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
		return res.status(400).json({ error: 'Invalid metadata filename format (expected 0x{40hex}{suffix}.json, suffix = tokenId decimal or 64 hex)' })
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