import {join} from 'node:path'
import {homedir} from 'node:os'
import {ethers} from 'ethers'
import Colors from 'colors/safe'
import {logger} from './logger'
import CoinCodeABI from './ABI/cashcoin-abi.json'
import USDC_ABI from './ABI/usdc_abi.json'
import CashcodeNode_abi from './ABI/cashcodeNote.abi.json'
import { Request, Response} from 'express'
import { exact } from "x402/schemes"
import { useFacilitator } from "x402/verify"

import { facilitator, createFacilitatorConfig } from "@coinbase/x402"
import {
	Network,
	PaymentPayload,
	PaymentRequirements,
	Price,
	Resource,
	settleResponseHeader,
	} from "x402/types"
import { processPriceToAtomicAmount, findMatchingPaymentRequirements } from "x402/shared"
import { inspect } from 'node:util'
import { request as httpRequest, type RequestOptions } from 'node:http'
const uuid62 = require('uuid62')
import { createPublicClient, createWalletClient, http, getContract, parseEther, parseAbi, NumberToHexErrorType } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { defineChain } from 'viem'
import Settle_ABI from './ABI/sellte-abi.json'
import Event_ABI from './ABI/event-abi.json'

import GuardianOracle_ABI from './ABI/GuardianOracle_ABI.json'
import newNodeInfoABI from './ABI/newNodeInfoABI.json'
import beamiobaseABI from './ABI/beamio-base-abi.json'
import beamioConetABI from './ABI/beamio-conet.abi.json'
import conetAirdropABI from './ABI/conet_airdrop.abi.json'
import AccountRegistryABI from './ABI/beamio-AccountRegistry.json'
import { CONET_BUNIT_AIRDROP_ADDRESS } from './chainAddresses'



const setupFile = join( homedir(),'.master.json' )


export const getClientIp = (req: Request): string => {


    // 1. X-Real-IP（Nginx 转发的）
    const realIp = req.headers['x-real-ip']
    if (realIp && typeof realIp === 'string' && realIp !== '') {
        return realIp
    }

    // 3. X-Forwarded-For
    const xff = req.headers['x-forwarded-for']
    if (xff && typeof xff === 'string' && xff !== '') {
        return xff.split(',')[0].trim()
    }

	 // 2. CF-Connecting-IP（Cloudflare 原生）
    const cfIp = req.headers['cf-connecting-ip']
    if (cfIp && typeof cfIp === 'string' && cfIp !== '') {
        return cfIp
    }

    // 4. 如果以上都没有，返回 socket 地址（本地测试会是 127.0.0.1）
    return ''
}


logger( homedir())

/** CoNET 官方 Base HTTP RPC。API 默认使用此地址；仅环境变量 BASE_RPC_URL 可覆盖。不读取 ~/.master.json base_endpoint 作为主 RPC，避免误配 Alchemy 等第三方限额节点。 */
export const BEAMIO_BASE_HTTP_RPC_DEFAULT = 'https://base-rpc.conet.network'

export function resolveBeamioBaseHttpRpcUrl(): string {
	const env = typeof process !== 'undefined' ? process.env?.BASE_RPC_URL?.trim() : ''
	return env || BEAMIO_BASE_HTTP_RPC_DEFAULT
}

export const masterSetup: IMasterSetup = require ( setupFile )
import {reflashData} from './server'

const facilitator1 = createFacilitatorConfig(masterSetup.base.CDP_API_KEY_ID,masterSetup.base.CDP_API_KEY_SECRET)

const x402Version = 1
const conetEndpoint = 'https://rpc1.conet.network'
const CashCodeBaseAddr = '0x3977f35c531895CeD50fAf5e02bd9e7EB890D2D1'
const USDCContract_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_Base_DECIMALS = 6
const masterServerPort = 1111

const SETTLEContract = '0x20c84933F3fFAcFF1C0b4D713b059377a9EF5fD1'
export const MINT_RATE = ethers.parseUnits('7000', 18)
const USDC_decimals = BigInt(10 ** 6)
//	const conet_CashCodeNote = '0xCe1F36a78904F9506E5cD3149Ce4992cC91385AF'
const conet_CashCodeNote = '0xB8c526aC40f5BA9cC18706efE81AC7014A4aBB6d'
const oracleSC_addr = '0xE9922F900Eef37635aF06e87708545ffD9C3aa99'
/** Base 主网部署的 BeamioOracle，用于 oracolPrice 汇率获取 */
const oracleSC_addr_base = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'
const eventContract = '0x18A976ee42A89025f0d3c7Fb8B32e0f8B840E1F3'

const {verify, settle} = useFacilitator(facilitator1)

const GuardianNodeInfo_mainnet = '0x6d7a526BFD03E90ea8D19eDB986577395a139872'
const CONET_MAINNET = new ethers.JsonRpcProvider('https://rpc1.conet.network') 
const GuardianNodesMainnet = new ethers.Contract(GuardianNodeInfo_mainnet, newNodeInfoABI, CONET_MAINNET)


//					beamio	Contract（与 GuardianNodesInfoV6 同链上地址）

const beamiobase = GuardianNodeInfo_mainnet
const beamioConet = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
const airdropRecord = '0x070BcBd163a3a280Ab6106bA62A079f228139379'
const beamioConetAccountRegistry = '0x4afaca09cf8307070a83836223Ae129073eC92e5'

let Guardian_Nodes: nodeInfo[] = []

/** 随机选取一个 Guardian 节点，返回其 ip_addr；无节点时返回 null */
export const getRandomNode = (): string | null => {
	if (!Guardian_Nodes.length) return null
	const idx = Math.floor(Math.random() * Guardian_Nodes.length)
	const _node1 = Guardian_Nodes[idx]
	return _node1?.ip_addr ?? null
}

/** 通过 CoNET 节点获取 Base RPC URL（HTTP 协议），参照 SilentPassUI baseRpc；无节点时返回 null */
export const getBaseRpcUrlViaConetNode = (): string | null => {
	const ip = getRandomNode()
	if (!ip) return null
	return `http://${ip}/base-rpc`
}

/** 供 debug：Guardian_Nodes 数量 */
export const getGuardianNodesCount = (): number => Guardian_Nodes.length

/**
 * 与 conet-si `_getAllNodes` 一致的分页拉取：
 * - 每页 100 条（合约的内部 limit，传 1000 会被 RPC 静默返回空数据 `0x`，
 *   触发 ethers `BAD_DATA` 抛出，让旧实现把整个进程拖崩）。
 * - 对 `BAD_DATA value="0x"` 吞掉视为「无更多节点」，与 conet-si 保持一致。
 * - 连续 5 次其它错误退出，避免无限重试。
 */
const _getAllNodesPaged = async (): Promise<any[]> => {
	const PAGE = 100
	const MAX_LOOP = 1000
	const MAX_CONSECUTIVE_FAIL = 5
	const all: any[] = []
	const seen = new Set<string>()
	let i = 0
	let loop = 0
	let consecutiveFail = 0

	while (loop++ < MAX_LOOP) {
		let page: any[] = []
		try {
			page = await GuardianNodesMainnet.getAllNodes(i, PAGE)
			consecutiveFail = 0
		} catch (e: any) {
			if (e?.code === 'BAD_DATA' && /value="0x"/.test(e?.message ?? '')) {
				logger(`_getAllNodesPaged: contract returned empty (0x) at offset=${i}, treat as end`)
				break
			}
			consecutiveFail++
			logger(`_getAllNodesPaged Error (${consecutiveFail}/${MAX_CONSECUTIVE_FAIL}) at offset=${i}: ${e?.message ?? e}`)
			if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) break
			await new Promise(r => setTimeout(r, 2000))
			continue
		}

		if (!page || page.length === 0) break

		let added = 0
		for (const n of page) {
			const ip = (n?.[3] ?? '').toString().trim().toLowerCase()
			if (!ip) continue
			if (seen.has(ip)) continue
			seen.add(ip)
			all.push(n)
			added++
		}
		if (added === 0) break
		i += page.length
	}

	return all
}

export const getAllNodes = async (): Promise<boolean> => {
	try {
		const _nodes = await _getAllNodesPaged()
		Guardian_Nodes.length = 0
		for (let i = 0; i < _nodes.length; i ++) {
			const node = _nodes[i]
			const id = parseInt(node[0].toString())
			const pgpString: string = Buffer.from(node[1], 'base64').toString()
			const domain: string = node[2]
			const ipAddr: string = node[3]
			const region: string = node[4]
			Guardian_Nodes.push({
				ip_addr: ipAddr,
				armoredPublicKey: pgpString,
				domain: domain,
				nftNumber: id,
				region: region,
			})
		}
		logger(`getAllNodes success total nodes = ${Guardian_Nodes.length}`)
		return true
	} catch (e: any) {
		logger(`getAllNodes Error: ${e?.message ?? e}`)
		return false
	}
}

// const headers: Record<string, string> = {
// 	accept: 'application/json',
// 	'content-type': 'application/json',
// 	'accept-encoding': 'gzip, deflate, br, zstd',
// 	'accept-language': 'en-US,en;q=0.9,ja;q=0.8,zh-CN;q=0.7,zh-TW;q=0.6,zh;q=0.5',
// 	'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
// 	'x-app-version': '3.133.0',
// 	'x-cb-device-id': v4(),
// 	'x-cb-is-logged-in': 'true',
// 	'x-cb-pagekey': 'send',
// 	'x-cb-platform': 'extension',
// 	'x-cb-project-name': 'wallet_extension',
// 	'x-cb-session-uuid': v4(),
// 	'x-cb-version-name': '3.133.0',
// 	'x-platform-name': 'extension',
// 	'x-release-stage': 'production',
// 	'x-wallet-user-id': '98630690',
// 	// 如需身份态就带上 cookie（注意隐私与时效）
// 	cookie: `cb_dm=${v4()};`,
// 	// 若需要伪装扩展来源（可能仍被服务端策略拦截）
// 	origin: 'chrome-extension://hnfanknocfeofbddgcijnmhnfnkdnaad',
// }



const conetMainnet = defineChain({
	id: 224422, // 随便指定唯一的 chainId，例如 2550；如果有官方ID请填实际
	name: 'CoNET Mainnet',
	network: 'conet',
	nativeCurrency: {
		name: 'ETH',
		symbol: 'ETH',
		decimals: 18,
	},
	rpcUrls: {
		default: { http: [conetEndpoint] },
		public:  { http: [conetEndpoint] },
	},
	blockExplorers: {
		default: { name: 'CoNET Explorer', url: 'https://mainnet.conet.network' }
	}
})

const conetClient = createPublicClient({chain: conetMainnet, transport: http(conetEndpoint)})


const oracle = {
    bnb: '',
    eth: '',
	usdc: '',
	timestamp: 0,
	usdcad: '',
	usdjpy: '',
	usdcny: '',
	usdhkd: '',
	usdeur: '',
	usdsgd: '',
	usdtwd: ''
}

let oracolPriceProcess = false

/** BeamioCurrency: CAD=0, USD=1, JPY=2, CNY=3, USDC=4, HKD=5, EUR=6, SGD=7, TWD=8, ETH=9, BNB=10, SOLANA=11, BTC=12
 * 链上 getRate(c) 返回「1 该货币 = X USD」；UI 期望「1 USD = X 该货币」，故对非 USD/USDC 需取倒数
 */
const inv = (s: string) => {
	const n = Number(s)
	return (n > 0 ? 1 / n : 0).toString()
}
export const oracolPrice = async () => {
	if (oracolPriceProcess) return
	oracolPriceProcess = true
	try {
		const [cadRaw, jpyRaw, cnyRaw, usdcRaw, hkdRaw, eurRaw, sgdRaw, twdRaw] = await Promise.all([
			oracleSCBase.getRate(0).then((r: bigint) => ethers.formatEther(r)), // CAD
			oracleSCBase.getRate(2).then((r: bigint) => ethers.formatEther(r)), // JPY
			oracleSCBase.getRate(3).then((r: bigint) => ethers.formatEther(r)), // CNY
			oracleSCBase.getRate(4).then((r: bigint) => ethers.formatEther(r)), // USDC
			oracleSCBase.getRate(5).then((r: bigint) => ethers.formatEther(r)), // HKD
			oracleSCBase.getRate(6).then((r: bigint) => ethers.formatEther(r)), // EUR
			oracleSCBase.getRate(7).then((r: bigint) => ethers.formatEther(r)), // SGD
			oracleSCBase.getRate(8).then((r: bigint) => ethers.formatEther(r)), // TWD
		])
		const timestamp = Math.floor(Date.now() / 1000)
		oracle.bnb = ''
		oracle.eth = ''
		oracle.usdc = usdcRaw.toString()
		oracle.usdcad = inv(cadRaw)
		oracle.usdjpy = inv(jpyRaw)
		oracle.usdcny = inv(cnyRaw)
		oracle.usdhkd = inv(hkdRaw)
		oracle.usdeur = inv(eurRaw)
		oracle.usdsgd = inv(sgdRaw)
		oracle.usdtwd = inv(twdRaw)
		oracle.timestamp = timestamp
	} catch (e: any) {
		// Exceeded quota / RPC 限流时保留旧数据，避免崩溃
		logger('oracolPrice failed (quota/RPC):', e?.message?.slice?.(0, 80) ?? e)
	} finally {
		oracolPriceProcess = false
	}
}

/**
 * @param enableOracle 是否启用链上 oracle 读取（仅 master 设为 true，cluster 从 master 拉取）
 */
export const oracleBackoud = async (enableOracle = true) => {
	await getAllNodes()
	Settle_ContractPool = masterSetup.settle_contractAdmin.map(n => {

		const account = privateKeyToAccount('0x' + n as `0x${string}`)
		// const walletClientBase = createWalletClient({
		// 	account,
		// 	chain: base,
		// 	transport: http(`http://${getRandomNode()}/base-rpc`),
		// })
		

		const walletBase = new ethers.Wallet(n, providerBaseBackup)
		const walletConet = new ethers.Wallet(n, providerConet)
		logger(`address => ${walletBase.address}`)

		return {
			// baseWalletClient: walletClientBase,
			baseSC: new ethers.Contract(beamiobase, beamiobaseABI, walletBase),
			baseUSDC: new ethers.Contract(USDCContract_BASE, USDC_ABI, walletBase),
			privateKey: n,
			wallet: walletBase,
			conetSC: new ethers.Contract(beamioConet, beamioConetABI, walletConet),
			// event: new ethers.Contract(eventContract, Event_ABI, walletConet),
			conetAirdrop: new ethers.Contract(airdropRecord, conetAirdropABI, walletConet),
			constAccountRegistry: new ethers.Contract(beamioConetAccountRegistry, AccountRegistryABI, walletConet),
		}
	})

	if (!enableOracle) return

	oracolPrice()
	providerConet.on('block', async (blockNumber) => {

		if (blockNumber % 30 !== 0) {
			return
		}

		oracolPrice()

	})
}

/** Base 主网 RPC：与 resolveBeamioBaseHttpRpcUrl 一致（默认 CoNET 官方节点） */
const BASE_RPC_URL = resolveBeamioBaseHttpRpcUrl()
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)
const providerBaseBackup = new ethers.JsonRpcProvider(BASE_RPC_URL)

const providerConet = new ethers.JsonRpcProvider(conetEndpoint)
const oracleSC = new ethers.Contract(oracleSC_addr, GuardianOracle_ABI, providerConet)

/** BeamioTransfer x402 预检：payer（EOA）的 B-Unit 余额必须 >= 2（手续费） */
const beamioTransferPreCheckBUnitBalance = async (payerEOA: string): Promise<{ success: boolean; error?: string }> => {
	const BUNIT_FEE_AMOUNT = 2_000_000n // 2 B-Units (6 decimals)
	try {
		if (!ethers.isAddress(payerEOA)) {
			return { success: false, error: 'Invalid payer address for B-Unit fee check' }
		}
		const bunitAirdropRead = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			['function getBUnitBalance(address) view returns (uint256)'],
			providerConet
		)
		const balance = await bunitAirdropRead.getBUnitBalance(payerEOA)
		if (balance < BUNIT_FEE_AMOUNT) {
			return {
				success: false,
				error: `Insufficient B-Units to pay fee (2 required, balance: ${Number(balance) / 1e6} B-Units)`,
			}
		}
		return { success: true }
	} catch (e: any) {
		return {
			success: false,
			error: `B-Unit balance check failed: ${e?.shortMessage ?? e?.message ?? String(e)}`,
		}
	}
}
/** BeamioOracle ABI：getRate(uint8) 返回货币对 USD 的 E18 汇率 */
const BeamioOracleAbi = ['function getRate(uint8 c) view returns (uint256)']
/** Base 主网的 BeamioOracle 合约实例，供 oracolPrice 使用 */
const oracleSCBase = new ethers.Contract(oracleSC_addr_base, BeamioOracleAbi, providerBase)

export let Settle_ContractPool: {
	baseSC: ethers.Contract
	baseUSDC: ethers.Contract
	conetSC: ethers.Contract
	privateKey: string
	wallet: ethers.Wallet
	conetAirdrop: ethers.Contract
	constAccountRegistry: ethers.Contract
}[] = []

/** x402 协议 version 常量（外部模块构造 paymentRequirements / 错误响应时使用） */
export const X402_PROTOCOL_VERSION = x402Version

/** Base USDC ERC-20 合约地址（外部模块需要时复用，避免重复硬编码） */
export const BASE_USDC_CONTRACT = USDCContract_BASE

/** 暴露给外部模块复用：构造 Beamio x402 'exact' scheme PaymentRequirements。
 * 与 cashcode_request / BeamioTransfer 内部使用同一个工厂，保持 mimeType / extra / network 一致。 */
export function buildBeamioExactPaymentRequirements(
		price: Price,
		resource: Resource,
		description: string,
		payto: string
	): PaymentRequirements {
	return createBeamioExactPaymentRequirements(price, resource, description, payto)
}

/** 暴露 x402 resource URL 构造（X-Forwarded-Proto/Host 优先），供外部 handler 与 verifyPaymentNew 输入对齐。 */
export const buildX402ResourceUrl = (req: Request): Resource => buildResourceUrl(req) as Resource

function createBeamioExactPaymentRequirements(
		price: Price,
		resource: Resource,
		description = "",
		payto: string
	): PaymentRequirements {
		const atomicAmountForAsset = processPriceToAtomicAmount(price, 'base')
		if ("error" in atomicAmountForAsset) {
			throw new Error(atomicAmountForAsset.error);
		}
		const { maxAmountRequired, asset } = atomicAmountForAsset;

		return {
			scheme: "exact",
			network:'base',
			maxAmountRequired,
			resource,
			description,
			mimeType: "",
			payTo: payto,
			maxTimeoutSeconds: 120,
			asset: asset.address,
			outputSchema: undefined,
			extra: {
				name: 'USD Coin',
				version: '2',
			},
		}
}

/** 构建 x402 resource URL，优先使用 X-Forwarded-Proto 以在代理后得到正确的 https。取逗号分隔的首值（多级代理时可能为 "https, https"） */
function buildResourceUrl(req: Request): string {
	const rawProto = (req.get('X-Forwarded-Proto') as string) || req.protocol || 'https'
	const protocol = rawProto.split(',')[0]?.trim() || 'https'
	const rawHost = req.get('X-Forwarded-Host') || req.headers.host || ''
	const host = rawHost.split(',')[0]?.trim() || ''
	const pathname = new URL(req.originalUrl || req.url, 'http://x').pathname
	return `${protocol}://${host}${pathname}`
}

export const verifyPaymentNew = (
		req: Request,
		res: Response,
		paymentRequirements: PaymentRequirements[],
	): Promise<false|any> => new Promise(async resolve =>  {
	const payment = req.header("X-PAYMENT")

	if (!payment) {
		// 第一跳：客户端没带 X-PAYMENT，按 x402 协议返回 402 + paymentRequirements。
		// 把 Origin / Referer / UA 一起 dump，便于排查跨域第二跳是否被 CORS 预检拦下来：
		// 如果第二跳从未到达服务器，但这条日志却出现两次（同一 sid/同一 cardAddr），
		// 极有可能是浏览器在 OPTIONS 预检阶段把带 X-PAYMENT 的 POST block 掉了。
		const origin = req.header('origin') ?? '(no-origin)'
		const referer = req.header('referer') ?? '(no-referer)'
		const ua = (req.header('user-agent') ?? '').slice(0, 80)
		const xfwdProto = req.header('x-forwarded-proto') ?? '(none)'
		const xfwdFor = req.header('x-forwarded-for') ?? '(none)'
		logger(`verifyPayment send x402 payment information path=${req.originalUrl} origin=${origin} referer=${referer} xfwd-proto=${xfwdProto} xfwd-for=${xfwdFor} ua="${ua}"`)
		res.status(402).json({
			x402Version,
			error: "X-PAYMENT header is required",
			accepts: paymentRequirements,
		})
		return 
	}

	// 进入第二跳：把 X-PAYMENT 长度+前缀打出来，证明 nginx + 浏览器 CORS 预检确实放行了 X-PAYMENT。
	logger(`verifyPayment got X-PAYMENT header path=${req.originalUrl} origin=${req.header('origin') ?? '(no-origin)'} payment.len=${payment.length} payment.prefix=${payment.slice(0, 24)}…`)

	let decodedPayment: PaymentPayload

	try {
		decodedPayment = exact.evm.decodePayment(payment)
		decodedPayment.x402Version = x402Version

	} catch (error) {
		logger(`verifyPayment catch Invalid or malformed payment header Error!`)
		res.status(402).json({
			x402Version,
			error: error || "Invalid or malformed payment header",
			accepts: paymentRequirements,
		})
		return resolve(false)
	}

	// 余额检查：付款方 USDC 不足时提前返回，便于 UI 显示友好错误
	try {
		const auth = (decodedPayment?.payload as { authorization?: { from?: string; value?: string } })?.authorization
		const payer = auth?.from
		const needAmount = BigInt(auth?.value ?? '0')
		if (payer && needAmount > 0n) {
			const usdcBase = new ethers.Contract(USDCContract_BASE, ['function balanceOf(address) view returns (uint256)'], providerBase)
			const bal = await usdcBase.balanceOf(payer)
			if (bal < needAmount) {
				const balStr = (Number(bal) / 1e6).toFixed(2)
				const needStr = (Number(needAmount) / 1e6).toFixed(2)
				const errMsg = `Insufficient USDC balance: account has ${balStr} USDC, need ${needStr} USDC`
				logger(`verifyPayment ${errMsg}`)
				res.status(402).json({
					x402Version,
					error: errMsg,
					accepts: paymentRequirements,
				})
				return resolve(false)
			}
		}
	} catch (balanceEx: any) {
		logger(`verifyPayment balance check failed (continuing): ${balanceEx?.message ?? balanceEx}`)
		// RPC 失败时不影响主流程，交给 facilitator 校验
	}

	// 签名时效检查：validAfter/validBefore 超出则提前返回，便于 UI 提示用户重新签名
	const authTime = (decodedPayment?.payload as { authorization?: { validAfter?: string; validBefore?: string } })?.authorization
	if (authTime?.validAfter !== undefined && authTime?.validBefore !== undefined) {
		const now = Math.floor(Date.now() / 1000)
		const validAfter = Number(authTime.validAfter)
		const validBefore = Number(authTime.validBefore)
		if (now < validAfter) {
			const errMsg = 'Payment authorization not yet valid. Please try again shortly.'
			logger(`verifyPayment ${errMsg} (now=${now} validAfter=${validAfter})`)
			res.status(402).json({ x402Version, error: errMsg, accepts: paymentRequirements })
			return resolve(false)
		}
		if (now > validBefore) {
			const errMsg = 'Payment authorization expired. Please sign again.'
			logger(`verifyPayment ${errMsg} (now=${now} validBefore=${validBefore})`)
			res.status(402).json({ x402Version, error: errMsg, accepts: paymentRequirements })
			return resolve(false)
		}
	}
	
	try {

		if (!paymentRequirements.length) {
			//@ts-ignore
			const amount = decodedPayment.payload.authorization.value
			const resource = buildResourceUrl(req) as Resource
			paymentRequirements = [createBeamioExactPaymentRequirements(
				amount,
				resource,
				`Cashcode Payment Request`,
				decodedPayment.payload
				//@ts-ignore
				.authorization.to
			)]
		}
		const selectedPaymentRequirement =
			findMatchingPaymentRequirements(paymentRequirements, decodedPayment) ||
			paymentRequirements[0];
		const response = await verify(decodedPayment, selectedPaymentRequirement)
		
		if (!response.isValid) {
			logger(`verifyPayment verify decodedPayment Erro! ${response.invalidReason} `)
			res.status(402).json({
				x402Version,
				error: response.invalidReason,
				accepts: paymentRequirements,
				payer: response.payer,
			})
			return resolve(false)
		}

	} catch (error: any) {
		const errMsg = error?.message ?? String(error)
		const errCause = error?.cause?.message ?? error?.cause
		logger(`verifyPayment catch error! ${errMsg}`, errCause ? `cause=${errCause}` : '')
		if (errMsg.includes('Bad Request') || errMsg.includes('400')) {
			const payload = decodedPayment?.payload as { authorization?: { from?: string; to?: string; value?: string; resource?: string } } | undefined
			const auth = payload?.authorization
			const req0 = paymentRequirements[0]
			logger(`[DEBUG] verifyPayment Bad Request - reqResource=${req0?.resource} payTo=${req0?.payTo} authFrom=${auth?.from?.slice(0, 10)}… authTo=${auth?.to?.slice(0, 10)}… authValue=${auth?.value} authResource=${auth?.resource ?? 'n/a'}`)
			// 复现请求以捕获 facilitator 原始错误详情
			try {
				const createAuth = facilitator1?.createAuthHeaders
				if (createAuth && facilitator1?.url && req0) {
					const authHeaders = await createAuth()
					const url = `${facilitator1.url}/verify`
					const replacer = (_: unknown, v: unknown) => typeof v === 'bigint' ? String(v) : v
					const body = JSON.stringify({
						x402Version: decodedPayment?.x402Version ?? 1,
						paymentPayload: JSON.parse(JSON.stringify(decodedPayment, replacer)),
						paymentRequirements: [JSON.parse(JSON.stringify(req0, replacer))],
					})
					const debugRes = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders.verify }, body })
					const debugText = await debugRes.text()
					logger(`[DEBUG] facilitator raw response: status=${debugRes.status} body=${debugText}`)
				}
			} catch (debugEx: any) {
				logger(`[DEBUG] facilitator debug fetch failed: ${debugEx?.message ?? debugEx}`)
			}
		}
		res.status(402).json({
			x402Version,
			error: errMsg,
			accepts: paymentRequirements,
		});
		return resolve (false)
	}

	return resolve (paymentRequirements)
})


const checkx402paymentHeader = (paymentHeader: x402paymentHeader, amount: bigint, recipient: string ) => {
	if (paymentHeader?.payload?.authorization?.to?.toLowerCase() !== recipient.toLowerCase()) {
		return false
	}
	try {
		const _payAmount = BigInt(paymentHeader?.payload?.authorization?.value)
		if (_payAmount !== amount) {
			return false
		}

	} catch (ex) {
		return false
	}
	
	return true
}

const USDC_MinPrice = ethers.parseUnits('0.11', USDC_Base_DECIMALS)

export const cashcode_request = async (req: Request, res: Response) => {
	
	const _routerName = req.path
	const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`)
	const resource = `${req.protocol}://${req.headers.host}${url.pathname}` as Resource

	const { amount, note, secureCode, hash } = req.query as {
		amount?: string
		secureCode?: string
		note?: string
		hash?: string
	}

	const _price = amount|| '0'
	const price = ethers.parseUnits(_price, USDC_Base_DECIMALS)
	
	if ( !amount || price < USDC_MinPrice || !hash) {
		logger(`${_routerName} Error! The minimum amount was not reached.`,inspect(req.query, false, 3, true))
		return res.status(400).json({success: false, error: 'The minimum amount was not reached.'})
	}

	const paymentRequirements = [createBeamioExactPaymentRequirements(
		amount,
		resource,
		`Cashcode Payment Request`,
		beamioConet
	)]

	const isValid = await verifyPaymentNew(req, res, paymentRequirements)

	if (!isValid) {
		logger(`${_routerName} !isValid ERROR!`)
		return 
	}

	let responseData: x402SettleResponse

	const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
	const saleRequirements = paymentRequirements[0]

	const isValidPaymentHeader = checkx402paymentHeader(paymentHeader as x402paymentHeader, price, beamioConet)

	if (!isValidPaymentHeader) {
		logger(`${_routerName} checkx402paymentHeader Error!`,inspect(paymentHeader))
		return res.status(402).end()
	}

	const payload: payload = paymentHeader?.payload as payload


		// try {
		

		// 	const settleResponse = await settle(
		// 		paymentHeader,
		// 		saleRequirements)

		// 	const responseHeader = settleResponseHeader(settleResponse)

		// 	// In a real application, you would store this response header
		// 	// and associate it with the payment for later verification
			
		// 	responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
			
		// 	if (!responseData.success) {
		// 		logger(`${_routerName} responseData ERROR!`, inspect(responseData, false, 3, true))
		// 		return res.status(402).end()
		// 	}


				
		// } catch (ex: any) {
		// 	console.error("Payment settlement failed:", ex.message)
		// }

	logger(inspect(payload, false, 3, true))

	processToBase.push({
		from: payload.authorization.from,
		erc3009Addr: USDCContract_BASE,
		value: payload.authorization.value,
		validAfter: payload.authorization.validAfter,
		validBefore: payload.authorization.validBefore,
		nonce: payload.authorization.nonce,
		signature: payload.signature,
		hash: hash,
		note: note||'',
		res
	})

	processCheck()

}


/**
 * BeamioTransfer：x402 支付，使用 EIP-3009 TransferWithAuthorization。
 * 客户端用 EOA 私钥签名，authorization.from = EOA，authorization.to = toAddress。
 * 因此仅适用于「EOA 作为付款方」的场景（EOA→EOA、EOA→AA）。
 * AA 作为付款方（AA→EOA）不适用：AA 无私钥无法签 EIP-3009，需单独实现 AA 执行流（如 ERC-4337 UserOp）。
 *
 * 协议：必须使用显式参数，不再依赖 payMe JSON。
 * 必填：amount（usdcAmount）、currency、currencyAmount、toAddress。
 */
export const BeamioTransfer = async (req: Request, res: Response) => {
	const _routerName = req.path
	const resource = buildResourceUrl(req) as Resource

	const { amount, usdcAmount, currency, currencyAmount, toAddress, note, requestHash, isInternalTransfer, feePayerForBunit } = req.query as {
		amount?: string
		usdcAmount?: string
		currency?: string
		currencyAmount?: string
		toAddress?: string
		note?: string
		requestHash?: string
		isInternalTransfer?: string
		/** `payee`：B-Unit 预检与 consumeFromUser 扣款方为收款人（需配合 note=Vouchers） */
		feePayerForBunit?: string
	}
	const usdcAmt = amount || usdcAmount
	logger(`[BeamioTransfer] req.query: amount=${usdcAmt} toAddress=${toAddress?.slice(0, 10)}… currency=${currency ?? 'undefined'} resource=${resource}`)

	const _price = usdcAmt || '0'
	const price = ethers.parseUnits(_price, USDC_Base_DECIMALS)

	if (!usdcAmt || price <= 0 || !ethers.isAddress(toAddress)) {
		logger(`${_routerName} Error! The minimum amount was not reached.`, inspect(req.query, false, 3, true))
		return res.status(400).json({ success: false, error: 'The minimum amount was not reached.' })
	}

	// Cluster 预检：拒绝缺少 currency/currencyAmount 的转账
	if (!currency || !String(currency).trim()) {
		logger(Colors.red(`[BeamioTransfer] REJECT: currency is required (explicit param, no payMe JSON)`))
		return res.status(400).json({ success: false, error: 'currency is required for accounting' })
	}
	if (!currencyAmount || !String(currencyAmount).trim()) {
		logger(Colors.red(`[BeamioTransfer] REJECT: currencyAmount is required (explicit param, no payMe JSON)`))
		return res.status(400).json({ success: false, error: 'currencyAmount is required for accounting' })
	}


	const paymentRequirements = [createBeamioExactPaymentRequirements(
		usdcAmt,
		resource,
		`Beamio Transfer`,
		toAddress
	)]

	const isValid = await verifyPaymentNew(req, res, paymentRequirements)

	if (!isValid) {
		logger(`${_routerName} !isValid ERROR!`)
		return 
	}

	const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
	const saleRequirements = paymentRequirements[0]
	const payload: payload = paymentHeader?.payload as payload

	// Cluster 预检：默认 payer 付 B-Unit；Vouchers 链路约定收款人付（与 vouchersReceivePreCheck 一致）
	const payerEOA = payload?.authorization?.from
	if (!payerEOA || !ethers.isAddress(payerEOA)) {
		logger(Colors.red(`[BeamioTransfer] REJECT: cannot determine payer from payment`))
		return res.status(400).json({ success: false, error: 'Invalid payment: cannot determine payer' })
	}
	const bunitRole = String(feePayerForBunit ?? 'payer').trim().toLowerCase()
	const payeePaysBunit = bunitRole === 'payee'
	if (payeePaysBunit && String(note ?? '').trim() !== 'Vouchers') {
		logger(Colors.red(`[BeamioTransfer] REJECT: feePayerForBunit=payee requires note=Vouchers`))
		return res.status(400).json({
			success: false,
			error: 'feePayerForBunit=payee is only allowed with note=Vouchers',
		})
	}
	const toNorm = ethers.getAddress(toAddress!)
	const bunitFeeAddress = payeePaysBunit ? toNorm : ethers.getAddress(payerEOA)
	const bunitCheck = await beamioTransferPreCheckBUnitBalance(bunitFeeAddress)
	if (!bunitCheck.success) {
		logger(
			Colors.red(
				`[BeamioTransfer] B-Unit pre-check FAIL (${payeePaysBunit ? 'payee' : 'payer'}=${bunitFeeAddress.slice(0, 10)}…): ${bunitCheck.error}`,
			),
		)
		return res.status(400).json({ success: false, error: bunitCheck.error })
	}

	let responseData: x402SettleResponse

	try {
		const settleResponse = await settle(
			paymentHeader,
			saleRequirements)

		const responseHeader = settleResponseHeader(settleResponse)

		// In a real application, you would store this response header
		// and associate it with the payment for later verification
		
		responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
		
		if (!responseData.success) {
			logger(`${_routerName} responseData ERROR!`, inspect(responseData, false, 3, true))
			return res.status(402).end()
		}

		const wallet = responseData.payer
		
		const isWallet = ethers.isAddress(wallet)

		
		const ret: x402Response = {
			success: true,
			payer: wallet,
			USDC_tx: responseData?.transaction,
			network: responseData?.network,
			timestamp: new Date().toISOString()
		}

		
		
		res.status(200).json(ret).end()

		logger(inspect(ret, false, 3, true))
		const authorization = payload?.authorization
		if (authorization) {

			const from = authorization.from
			const to = authorization.to
			const authAmount = authorization.value
			const record = {
				from, to, amount: authAmount, finishedHash: responseData?.transaction, note: note||''
			}
			logger(inspect(record, false, 3, true))
			// 使用显式参数 currency/currencyAmount，不再解析 payMe JSON
			const displayJson = buildDisplayJsonFromNoteOnly(note || '', String(responseData?.transaction || ''), isInternalTransfer === 'true' || isInternalTransfer === '1')
			const reqHashValid = requestHash && ethers.isHexString(requestHash) && ethers.dataLength(requestHash) === 32 ? requestHash : undefined
			// 记账必须 payer≠payee；from=付款方 to=收款方，内部转账时 EOA→AA 为 from=EOA to=AA，AA→EOA 为 from=AA to=EOA
			if (!from || !to || from.toLowerCase() === to.toLowerCase()) {
				logger(Colors.red(`[BeamioTransfer] SKIP accounting: from=to (payer=payee) from=${from} to=${to} txHash=${responseData?.transaction ?? 'n/a'}`))
			} else {
				logger(
					`[BeamioTransfer] submitBeamioTransferIndexerAccounting from=${from} to=${to} requestHash=${reqHashValid ?? 'n/a'} currency=${currency} feePayer=${payeePaysBunit ? 'payee' : 'payer'}`,
				)
				void submitBeamioTransferIndexerAccountingToMaster({
					from,
					to,
					amountUSDC6: authAmount.toString(),
					finishedHash: String(responseData?.transaction || ''),
					displayJson,
					currency: currency as string,
					currencyAmount: currencyAmount as string,
					requestHash: reqHashValid,
					isInternalTransfer: isInternalTransfer === 'true' || isInternalTransfer === '1',
					feePayer: payeePaysBunit ? toNorm : undefined,
				})
			}
		}
		
		return 
			
	} catch (ex: any) {
		console.error("Payment settlement failed:", ex.message)
		res.status(500).end()
	}
	
}

/** x402 'exact' settle 结果（settle 成功时返回，失败时已写出 402/500 响应）。 */
export type BeamioX402SettleSuccess = {
	payer: string
	usdcAmount6: bigint
	USDC_tx?: string
	network?: string
	authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }
}

/**
 * 共享 x402 settle 工具：
 * - 在 cluster 端 `verifyPaymentNew` 通过后，把 USDC 通过 facilitator 真正结算到 `cardOwner`。
 * - 失败路径（缺/坏 X-PAYMENT、settle 错误）已经把 402/500 响应写出，调用方应直接返回。
 *
 * 注意：本函数 **不会** 写出成功响应；返回成功结构体后，调用方负责继续后续业务（如触发 nfcTopup workflow）
 * 并最终通过 `res.status(200).json(...)` 回写。
 */
export const settleBeamioX402ToCardOwner = async (
	req: Request,
	res: Response,
	params: { cardOwner: string; quotedUsdc6: bigint; description: string }
): Promise<BeamioX402SettleSuccess | null> => {
	const { cardOwner, quotedUsdc6, description } = params
	if (!ethers.isAddress(cardOwner)) {
		res.status(400).json({ success: false, error: 'Invalid cardOwner' }).end()
		return null
	}
	if (quotedUsdc6 <= 0n) {
		res.status(400).json({ success: false, error: 'Invalid quotedUsdc6' }).end()
		return null
	}
	const resource = buildResourceUrl(req) as Resource
	// processPriceToAtomicAmount 把 string price 视为「人类可读 USDC dollar」并再乘 10**6 得到原子单位。
	// 因此必须传人类可读字符串（如 "81.000000"），**绝不能直接传 quotedUsdc6.toString()**（已经是 atomic），
	// 否则会被多乘一次 10^6，前端 wrapFetchWithPayment 看到的 maxAmountRequired 会暴涨到万亿级，
	// 立即触发 "Payment amount exceeds maximum allowed" 客户端拒签。
	const priceUsdcHuman = ethers.formatUnits(quotedUsdc6, 6)
	const paymentRequirements = [createBeamioExactPaymentRequirements(
		priceUsdcHuman,
		resource,
		description,
		ethers.getAddress(cardOwner)
	)]
	const isValid = await verifyPaymentNew(req, res, paymentRequirements)
	if (!isValid) return null

	const paymentHeader = exact.evm.decodePayment(req.header('X-PAYMENT')!)
	const saleRequirements = paymentRequirements[0]
	const payload = paymentHeader?.payload as { authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string } }
	const auth = payload?.authorization
	if (!auth || !ethers.isAddress(auth.from) || !ethers.isAddress(auth.to)) {
		res.status(400).json({ success: false, error: 'Invalid payment payload (missing authorization)' }).end()
		return null
	}
	if (ethers.getAddress(auth.to) !== ethers.getAddress(cardOwner)) {
		res.status(400).json({ success: false, error: 'Payment authorization "to" mismatch with cardOwner' }).end()
		return null
	}
	if (BigInt(auth.value || '0') < quotedUsdc6) {
		res.status(400).json({ success: false, error: `Payment authorization value < quotedUsdc6 (${auth.value} < ${quotedUsdc6})` }).end()
		return null
	}

	try {
		const settleResponse = await settle(paymentHeader, saleRequirements)
		const responseHeader = settleResponseHeader(settleResponse)
		const responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString()) as { success: boolean; payer?: string; transaction?: string; network?: string; errorReason?: string }
		if (!responseData.success) {
			logger(Colors.red(`[settleBeamioX402ToCardOwner] settle failed: ${inspect(responseData, false, 3, true)}`))
			res.status(402).json({ success: false, error: responseData.errorReason ?? 'USDC settle failed' }).end()
			return null
		}
		return {
			payer: responseData.payer ?? auth.from,
			usdcAmount6: BigInt(auth.value),
			USDC_tx: responseData.transaction,
			network: responseData.network,
			authorization: auth,
		}
	} catch (ex: any) {
		logger(Colors.red(`[settleBeamioX402ToCardOwner] settle exception: ${ex?.message ?? ex}`))
		res.status(500).json({ success: false, error: `USDC settle exception: ${ex?.message ?? ex}` }).end()
		return null
	}
}

import type { DisplayJsonData } from './displayJsonTypes'

/** 仅从 note 构建 displayJson（forText、card），不解析 payMe。currency/currencyAmount 由显式参数传入 */
function buildDisplayJsonFromNoteOnly(note: string, finishedHash: string, isInternalTransfer: boolean): string {
	const trimmed = note.trim()
	const parts = trimmed.split(/\r?\n/)
	const forTextPart = parts[0]?.trim() || ''
	const rest = parts.slice(1).join('\n').trim()
	let card: DisplayJsonData['card']
	const jsonMatches: string[] = []
	let i = 0
	while (rest && i < rest.length) {
		const start = rest.indexOf('{', i)
		if (start < 0) break
		let depth = 0
		let end = start
		for (let j = start; j < rest.length; j++) {
			if (rest[j] === '{') depth++
			else if (rest[j] === '}') { depth--; if (depth === 0) { end = j + 1; break } }
		}
		if (depth === 0) jsonMatches.push(rest.slice(start, end))
		i = end
	}
	for (const m of jsonMatches) {
		try {
			const obj = JSON.parse(m) as Record<string, unknown>
			if (obj.title != null || obj.detail != null || obj.image != null) {
				card = { title: obj.title as string, detail: obj.detail as string, image: obj.image as string }
			} else if (obj.card && typeof obj.card === 'object') {
				const c = obj.card as Record<string, unknown>
				card = { title: c.title as string, detail: c.detail as string, image: c.image as string }
			}
		} catch (_) { /* ignore */ }
	}
	const d: DisplayJsonData = {
		title: isInternalTransfer ? 'EOA to AA' : 'Beamio Transfer',
		source: isInternalTransfer ? 'eoa-aa' : 'x402',
		finishedHash,
		handle: (forTextPart && !/^\{/.test(forTextPart) ? forTextPart : '').slice(0, 80),
		forText: forTextPart && !/^\{/.test(forTextPart) ? forTextPart : undefined,
		card,
	}
	return JSON.stringify(d)
}

/** @deprecated 不再用于 BeamioTransfer 记账，仅保留供 beamioTransferIndexerAccounting 的 note 回退路径 */
function buildDisplayJsonFromNote(note: string, finishedHash: string, source: string): { displayJson: string; currency?: string; currencyAmount?: string; requestHash?: string; isInternalTransfer?: boolean } {
	const trimmed = note.trim()
	const parts = trimmed.split(/\r?\n/)
	const forTextPart = parts[0]?.trim() || ''
	const rest = parts.slice(1).join('\n').trim()
	let parsed: { currency?: string; currencyAmount?: string | number; requestHash?: string; isInternalTransfer?: boolean } = {}
	let card: DisplayJsonData['card']
	const jsonMatches: string[] = []
	let i = 0
	while (rest && i < rest.length) {
		const start = rest.indexOf('{', i)
		if (start < 0) break
		let depth = 0
		let end = start
		for (let j = start; j < rest.length; j++) {
			if (rest[j] === '{') depth++
			else if (rest[j] === '}') { depth--; if (depth === 0) { end = j + 1; break } }
		}
		if (depth === 0) jsonMatches.push(rest.slice(start, end))
		i = end
	}
	for (const m of jsonMatches) {
		try {
			const obj = JSON.parse(m) as Record<string, unknown>
			// 优先使用 payMe 格式（data1）的 currency/currencyAmount；card JSON 的 currencyAmount 可能带 "CA$" 前缀导致服务器 parseFloat 失败
			if ((obj.currency != null || obj.currencyAmount != null) && (parsed.currency == null && parsed.currencyAmount == null)) {
				parsed.currency = obj.currency as string
				parsed.currencyAmount = obj.currencyAmount as string | number
			}
			if (obj.requestHash != null && typeof obj.requestHash === 'string') {
				parsed.requestHash = obj.requestHash
			}
			if (obj.isInternalTransfer === true) {
				parsed.isInternalTransfer = true
			}
			if (obj.title != null || obj.detail != null || obj.image != null) {
				card = {
					title: obj.title as string,
					detail: obj.detail as string,
					image: obj.image as string,
				}
			} else if (obj.card && typeof obj.card === 'object') {
				const c = obj.card as Record<string, unknown>
				card = {
					title: c.title as string,
					detail: c.detail as string,
					image: c.image as string,
				}
			}
		} catch (_) { /* ignore */ }
	}
	const d: DisplayJsonData = {
		title: parsed.isInternalTransfer ? 'EOA to AA' : (source === 'x402' ? 'Beamio Transfer' : 'AA to EOA (Internal)'),
		source: parsed.isInternalTransfer ? 'eoa-aa' : source,
		finishedHash,
		handle: (forTextPart && !/^\{/.test(forTextPart) ? forTextPart : '').slice(0, 80),
		forText: forTextPart && !/^\{/.test(forTextPart) ? forTextPart : undefined,
		card,
	}
	return {
		displayJson: JSON.stringify(d),
		currency: parsed.currency,
		currencyAmount: parsed.currencyAmount != null ? String(parsed.currencyAmount) : undefined,
		requestHash: parsed.requestHash,
		isInternalTransfer: parsed.isInternalTransfer,
	}
}

const submitBeamioTransferIndexerAccountingToMaster = async (payload: {
	from: string
	to: string
	amountUSDC6: string
	finishedHash: string
	displayJson: string
	currency?: string
	currencyAmount?: string
	requestHash?: string
	isInternalTransfer?: boolean
	/** B-Unit x402Send fee payer; default `from` (payer). Vouchers uses `to` (payee). */
	feePayer?: string
}) => {
	if (!ethers.isAddress(payload.from) || !ethers.isAddress(payload.to)) {
		return
	}
	try {
		if (!payload.amountUSDC6 || BigInt(payload.amountUSDC6) <= 0n) {
			return
		}
	} catch {
		return
	}
	if (!ethers.isHexString(payload.finishedHash) || ethers.dataLength(payload.finishedHash) !== 32) {
		return
	}
	const gasFields = await estimateTransferGasFields(payload.finishedHash)

	const option: RequestOptions = {
		hostname: 'localhost',
		path: '/api/beamioTransferIndexerAccounting',
		port: masterServerPort,
		method: 'POST',
		protocol: 'http:',
		headers: {
			'Content-Type': 'application/json',
		},
	}

	await new Promise<void>((resolve) => {
		const req = httpRequest(option, (res) => {
			let body = ''
			res.on('data', (c) => { body += c.toString() })
			res.on('end', () => {
				if ((res.statusCode || 500) >= 400) {
					logger(`[BeamioTransfer] submitBeamioTransferIndexerAccountingToMaster failed status=${res.statusCode} body=${body}`)
				}
				resolve()
			})
		})
		req.once('error', (e) => {
			logger(`[BeamioTransfer] submitBeamioTransferIndexerAccountingToMaster error: ${e.message}`)
			resolve()
		})
		const feePayerResolved =
			payload.feePayer && ethers.isAddress(payload.feePayer) ? ethers.getAddress(payload.feePayer) : ethers.getAddress(payload.from)
		const body: Record<string, unknown> = {
			from: payload.from,
			to: payload.to,
			amountUSDC6: payload.amountUSDC6,
			finishedHash: payload.finishedHash,
			displayJson: payload.displayJson,
			currency: payload.currency,
			currencyAmount: payload.currencyAmount,
			gasWei: gasFields.gasWei,
			gasUSDC6: gasFields.gasUSDC6,
			gasChainType: gasFields.gasChainType,
			baseGas: gasFields.baseGas,
			feePayer: feePayerResolved,
			source: 'x402',
		}
		if (payload.requestHash) body.requestHash = payload.requestHash
		if (payload.isInternalTransfer) body.isInternalTransfer = true
		req.write(JSON.stringify(body))
		req.end()
	})
}

const estimateTransferGasFields = async (txHash: string): Promise<{
	gasWei: string
	gasUSDC6: string
	gasChainType: number
	baseGas: string
}> => {
	const GAS_CHAIN_TYPE_ETH = 0
	const CURRENCY_USDC = 4
	const CURRENCY_ETH = 9
	const E18 = 10n ** 18n
	const E6 = 10n ** 6n
	try {
		const receipt = await providerBase.getTransactionReceipt(txHash)
		if (!receipt) {
			return { gasWei: '0', gasUSDC6: '0', gasChainType: GAS_CHAIN_TYPE_ETH, baseGas: '0' }
		}
		const gasUsed = receipt.gasUsed ?? 0n
		let gasPrice = receipt.gasPrice ?? 0n
		if (gasPrice <= 0n) {
			const tx = await providerBase.getTransaction(txHash)
			gasPrice = tx?.gasPrice ?? 0n
		}
		const gasWei = gasUsed * gasPrice

		let gasUSDC6 = 0n
		try {
			// BeamioOracle: rate = "1 currency = X USD" (E18)
			const [ethUsdE18, usdcUsdE18] = await Promise.all([
				oracleSCBase.getRate(CURRENCY_ETH) as Promise<bigint>,
				oracleSCBase.getRate(CURRENCY_USDC) as Promise<bigint>,
			])
			if (ethUsdE18 > 0n && usdcUsdE18 > 0n && gasWei > 0n) {
				// wei -> USD(E18): gasWei * ethUsd / 1e18
				const usdE18 = (gasWei * ethUsdE18) / E18
				// USD(E18) -> USDC(6): usdE18 * 1e6 / usdcUsdE18, round half up
				gasUSDC6 = (usdE18 * E6 + (usdcUsdE18 / 2n)) / usdcUsdE18
			}
		} catch (oracleErr: any) {
			logger(`[BeamioTransfer] estimateTransferGasFields oracle fallback gasUSDC6=0: ${oracleErr?.message ?? String(oracleErr)}`)
		}

		return {
			gasWei: gasWei.toString(),
			gasUSDC6: gasUSDC6.toString(),
			gasChainType: GAS_CHAIN_TYPE_ETH,
			baseGas: gasUsed.toString(),
		}
	} catch (ex: any) {
		logger(`[BeamioTransfer] estimateTransferGasFields failed: ${ex?.message ?? String(ex)}`)
		return { gasWei: '0', gasUSDC6: '0', gasChainType: GAS_CHAIN_TYPE_ETH, baseGas: '0' }
	}
}

/** PR (USDC charge settle ledger):
 * `keccak256("usdcCharge:settle")` —— BeamioIndexerDiamond.syncTokenAction 的 `ledgerTxCategory`，
 * 标记一行**独立**的 USDC settle ledger 行（payer → cardOwner，Base USDC `transferWithAuthorization`）。
 *
 * 在 charge 流程中，这是 orchestrator 三段「L0 settle / L1 topup / L2 charge」中的 **L0** 行，
 * 与 L1 topup 主单 / L2 charge 主单完全分开。链下对账以 `finishedHash = USDC_tx` 作为 join key，
 * 与 PG `beamio_member_topup_events.originating_usdc_tx` 一致。 */
export const TX_CATEGORY_USDC_CHARGE_SETTLE = ethers.keccak256(ethers.toUtf8Bytes('usdcCharge:settle')) as `0x${string}`

/** Merchant OS parent admin reset POS terminal quotas on Base；CoNET indexer 单行标点：`payer`=上级 admin EOA，`payee`=Terminal EOA。 */
export const TX_CATEGORY_TERMINAL_RESET = ethers.keccak256(ethers.toUtf8Bytes('TX_Terminal_RESET')) as `0x${string}`

/** Fire-and-forget：USDC charge settle 成功后，独立向 BeamioIndexerDiamond 推一行 ledger。
 *
 * 复用既存 Master `/api/beamioTransferIndexerAccounting` 端点 + `beamioTransferIndexerAccountingPool`；
 * 这条行：
 *   - `from = payer`、`to = cardOwner`、`finishedHash = USDC_tx`、`source = 'x402'`；
 *   - `ledgerTxCategory = TX_CATEGORY_USDC_CHARGE_SETTLE`，与 L1 topup（`creditTopupCard` 等）/ L2 charge 主单互斥；
 *   - `routeItems` 单元素：USDC@Base 资产、`amountE6 = usdcAmount6`（charge 主单 / topup 主单也带 USDC route，
 *     但 category 不同，Indexer 不会去重）；
 *   - `bServiceUSDC6 / bServiceUnits6 = 0`（settle 段无 B-Unit 服务费——B-Unit 费在 L1 topup 段独立记账）；
 *   - 无 `requestHash`（charge 不绑 payMe Voucher），跳过 `runRequestHashPreCheck`；
 *   - `currency / currencyAmount` 为商户卡币种（CAD/USD/...），与 NFC charge 主单 currency 字段一致；
 *   - `ledgerFinalRequestAmountFiat6 = total e6`、`ledgerFinalRequestAmountUSDC6 = usdcAmount6`；
 *   - `ledgerMetaRequestAmountFiat6 = subtotal e6`、`ledgerMetaDiscount/Tax*` 反映原始 breakdown。
 *
 * 失败仅 logger，不抛；charge 主链路（USDC settle 完成 + orchestrator 启动）不会被阻塞。
 * 设计目的：让独立查询「USDC 在哪些时刻到了商户 cardOwner EOA」时，**不必再 join topup 主单**。 */
export const submitUsdcChargeSettleIndexer = async (params: {
	payer: string
	cardOwner: string
	cardAddress: string
	posOperator?: string | null
	sid?: string | null
	currency: string
	/** decimal currency string e.g. "5.00" —— breakdown.subtotal */
	subtotalCurrencyAmount: string
	/** decimal currency string e.g. "5.00" —— breakdown.total = subtotal - discount + tax + tip */
	totalCurrencyAmount: string
	/** atomic e6 string —— breakdown.discount * 1e6 */
	discountAmountFiat6?: string
	discountRateBps?: number
	/** atomic e6 string —— breakdown.tax * 1e6 */
	taxAmountFiat6?: string
	taxRateBps?: number
	/** decimal currency string —— breakdown.tip（折叠在 total 内，仅用于 displayJson 审计） */
	tipCurrencyAmount?: string
	tipRateBps?: number
	/** Base USDC settle tx hash（必须 0x + 32 bytes） */
	usdcTxHash: string
	/** atomic 6 —— x402 settle 实际转账金额 */
	usdcAmount6: bigint | string
}): Promise<void> => {
	try {
		if (!ethers.isAddress(params.payer) || !ethers.isAddress(params.cardOwner) || !ethers.isAddress(params.cardAddress)) {
			logger(Colors.yellow(`[submitUsdcChargeSettleIndexer] skip: invalid address (payer/cardOwner/cardAddress)`))
			return
		}
		if (params.payer.toLowerCase() === params.cardOwner.toLowerCase()) {
			logger(Colors.yellow(`[submitUsdcChargeSettleIndexer] skip: payer==cardOwner ${params.payer}`))
			return
		}
		const usdcAmount6Big = typeof params.usdcAmount6 === 'bigint' ? params.usdcAmount6 : BigInt(params.usdcAmount6)
		if (usdcAmount6Big <= 0n) {
			logger(Colors.yellow(`[submitUsdcChargeSettleIndexer] skip: usdcAmount6 <= 0`))
			return
		}
		if (!params.usdcTxHash || !ethers.isHexString(params.usdcTxHash) || ethers.dataLength(params.usdcTxHash) !== 32) {
			logger(Colors.yellow(`[submitUsdcChargeSettleIndexer] skip: invalid usdcTxHash ${params.usdcTxHash}`))
			return
		}
		const cur = (params.currency || '').toString().trim().toUpperCase() || 'CAD'
		const totalNum = Number(params.totalCurrencyAmount)
		if (!Number.isFinite(totalNum) || totalNum <= 0) {
			logger(Colors.yellow(`[submitUsdcChargeSettleIndexer] skip: invalid totalCurrencyAmount ${params.totalCurrencyAmount}`))
			return
		}
		const subtotalNum = Number(params.subtotalCurrencyAmount)
		const fiat6 = (n: number): string => BigInt(Math.max(0, Math.round(n * 1_000_000))).toString()
		const totalFiat6 = fiat6(totalNum)
		const subtotalFiat6 = Number.isFinite(subtotalNum) && subtotalNum > 0 ? fiat6(subtotalNum) : totalFiat6

		const USDC_BASE_ADDRESS = ethers.getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
		const usdcAmount6Str = usdcAmount6Big.toString()

		const displayJson = JSON.stringify({
			title: 'USDC Charge Settle',
			source: 'usdcChargeSettle',
			finishedHash: params.usdcTxHash,
			cardAddress: ethers.getAddress(params.cardAddress),
			cardOwner: ethers.getAddress(params.cardOwner),
			payer: ethers.getAddress(params.payer),
			pos: params.posOperator && ethers.isAddress(params.posOperator) ? ethers.getAddress(params.posOperator) : undefined,
			sid: params.sid ?? undefined,
			currency: cur,
			currencyAmount: params.totalCurrencyAmount,
			breakdown: {
				subtotal: params.subtotalCurrencyAmount,
				discountFiat6: params.discountAmountFiat6 ?? '0',
				discountBps: Number.isFinite(Number(params.discountRateBps)) ? Number(params.discountRateBps) : 0,
				taxFiat6: params.taxAmountFiat6 ?? '0',
				taxBps: Number.isFinite(Number(params.taxRateBps)) ? Number(params.taxRateBps) : 0,
				tip: params.tipCurrencyAmount ?? '0',
				tipBps: Number.isFinite(Number(params.tipRateBps)) ? Number(params.tipRateBps) : 0,
				total: params.totalCurrencyAmount,
			},
			usdcAmount6: usdcAmount6Str,
		})

		const gasFields = await estimateTransferGasFields(params.usdcTxHash)

		const body: Record<string, unknown> = {
			from: ethers.getAddress(params.payer),
			to: ethers.getAddress(params.cardOwner),
			amountUSDC6: usdcAmount6Str,
			finishedHash: params.usdcTxHash,
			displayJson,
			currency: cur,
			currencyAmount: params.totalCurrencyAmount,
			gasWei: gasFields.gasWei,
			gasUSDC6: gasFields.gasUSDC6,
			gasChainType: gasFields.gasChainType,
			baseGas: gasFields.baseGas,
			// settle 由 x402 facilitator 代付 gas，链上 fee payer 是 facilitator EOA；ledger 这里用 payer
			// （顾客 EOA，发起 EIP-3009 授权的人）作为账面 feePayer，与既存 `submitBeamioTransferIndexerAccountingToMaster`
			// (`source='x402'`) 的口径一致。
			feePayer: ethers.getAddress(params.payer),
			source: 'x402',
			payeeEOA: ethers.getAddress(params.cardOwner),
			merchantCardAddress: ethers.getAddress(params.cardAddress),
			ledgerTxId: params.usdcTxHash,
			ledgerOriginalPaymentHash: ethers.ZeroHash,
			ledgerTxCategory: TX_CATEGORY_USDC_CHARGE_SETTLE,
			ledgerFinalRequestAmountFiat6: totalFiat6,
			ledgerFinalRequestAmountUSDC6: usdcAmount6Str,
			ledgerMetaRequestAmountFiat6: subtotalFiat6,
			ledgerMetaRequestAmountUSDC6: usdcAmount6Str,
			ledgerMetaDiscountAmountFiat6: params.discountAmountFiat6 ?? '0',
			ledgerMetaDiscountRateBps: Number.isFinite(Number(params.discountRateBps)) ? Number(params.discountRateBps) : 0,
			ledgerMetaTaxAmountFiat6: params.taxAmountFiat6 ?? '0',
			ledgerMetaTaxRateBps: Number.isFinite(Number(params.taxRateBps)) ? Number(params.taxRateBps) : 0,
			bServiceUSDC6: '0',
			bServiceUnits6: '0',
			routeItems: [
				{
					asset: USDC_BASE_ADDRESS,
					amountE6: usdcAmount6Str,
					assetType: 0,
					source: 0,
					tokenId: '0',
					itemCurrencyType: 4, // USDC
					offsetInRequestCurrencyE6: usdcAmount6Str,
				},
			],
		}

		const option: RequestOptions = {
			hostname: 'localhost',
			path: '/api/beamioTransferIndexerAccounting',
			port: masterServerPort,
			method: 'POST',
			protocol: 'http:',
			headers: { 'Content-Type': 'application/json' },
		}

		await new Promise<void>((resolve) => {
			const req = httpRequest(option, (resp) => {
				let buf = ''
				resp.on('data', (c) => { buf += c.toString() })
				resp.on('end', () => {
					if ((resp.statusCode || 500) >= 400) {
						logger(Colors.yellow(
							`[submitUsdcChargeSettleIndexer] master returned ${resp.statusCode} body=${buf.slice(0, 240)} ` +
							`USDC_tx=${params.usdcTxHash} payer=${params.payer.slice(0, 10)}… cardOwner=${params.cardOwner.slice(0, 10)}…`
						))
					} else {
						logger(Colors.cyan(
							`[submitUsdcChargeSettleIndexer] enqueued OK USDC_tx=${params.usdcTxHash} ` +
							`payer=${params.payer.slice(0, 10)}… cardOwner=${params.cardOwner.slice(0, 10)}… usdc6=${usdcAmount6Str} sid=${params.sid ?? 'n/a'}`
						))
					}
					resolve()
				})
			})
			req.once('error', (e) => {
				logger(Colors.yellow(`[submitUsdcChargeSettleIndexer] master unreachable: ${e.message}`))
				resolve()
			})
			req.write(JSON.stringify(body))
			req.end()
		})
	} catch (err: any) {
		logger(Colors.yellow(`[submitUsdcChargeSettleIndexer] non-critical: ${err?.message ?? String(err)}`))
	}
}

/** 将 gasWei 通过 BeamioOracle 换算为 gasUSDC6，供 beamioTransferIndexerAccounting 使用 */
export const convertGasWeiToUSDC6 = async (gasWei: bigint): Promise<bigint> => {
	const CURRENCY_USDC = 4
	const CURRENCY_ETH = 9
	const E18 = 10n ** 18n
	const E6 = 10n ** 6n
	if (gasWei <= 0n) return 0n
	try {
		const [ethUsdE18, usdcUsdE18] = await Promise.all([
			oracleSCBase.getRate(CURRENCY_ETH) as Promise<bigint>,
			oracleSCBase.getRate(CURRENCY_USDC) as Promise<bigint>,
		])
		if (ethUsdE18 <= 0n || usdcUsdE18 <= 0n) return 0n
		const usdE18 = (gasWei * ethUsdE18) / E18
		return (usdE18 * E6 + (usdcUsdE18 / 2n)) / usdcUsdE18
	} catch (e: any) {
		logger(`[convertGasWeiToUSDC6] oracle failed: ${e?.message ?? String(e)}`)
		return 0n
	}
}

const generateCODE = (passcode: string) => {
	const code = uuid62.v4()
	const hash = ethers.solidityPackedKeccak256(['string', 'string'], [code, passcode])
	return ({
		code, hash
	})
	
}



type AuthorizationPayload = {
	authorization: {
		from: string
		to: string
		value: bigint
		validAfter: bigint
		validBefore: bigint
		nonce: `0x${string}`
	}
	signature: `0x${string}`; // 65 字节 (r,s,v)
}

export async function AuthorizationSign(
	amount: string,
	to: string,
	privateKey: string,
	DECIMALS: number,
	CHAIN_ID: string,
	TOKEN_ADDRESS: string
): Promise<AuthorizationPayload> {
  // 1) 签名者
	const wallet = new ethers.Wallet(privateKey)
	const from = await wallet.getAddress()

	// 2) 金额 & 时间窗（现在 - 1s 到 24h 后）
	const value = ethers.parseUnits(amount, DECIMALS)     // bigint
	const now = BigInt(Math.floor(Date.now() / 1000))
	const validAfter = now - 60n
	const validBefore = now + 60n     // 1 分钟有效

	// 3) 随机 nonce（bytes32）
	const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`

	// 4) EIP-712 域 & 类型 & 数据（与你合约里的 TYPEHASH 字段严格一致）
	const domain = {
		name: "USD Coin",          // ERC20Permit(name) -> 你的合约构造里是 "USDC"
		version: "2",          // OpenZeppelin ERC20Permit 的默认版本是 "1"
		chainId: 8453,     // 必须与链实际 ID 一致
		verifyingContract: USDCContract_BASE,
	} as const;

	const AuthorizationTypes = {
		TransferWithAuthorization: [
		{ name: "from",        type: "address" },
		{ name: "to",          type: "address" },
		{ name: "value",       type: "uint256" },
		{ name: "validAfter",  type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce",       type: "bytes32"  },
		],
	}

	const message = {
		from,
		to,
		value,
		validAfter,
		validBefore,
		nonce,
  }

	// 5) 签名（返回 0x + 65 字节，合约的 bytes 接口可直接用）
	const signature = await wallet.signTypedData(domain, AuthorizationTypes, message) as `0x${string}`

	return {
		signature,
		authorization:
		{
			from,
			to,
			value,
			validAfter,
			validBefore,
			nonce,
		}
	}
}

// const AuthorizationCallUSDC = async (data: AuthorizationPayload) => {
// 	const SC = Settle_ContractPool[0]
// 	try {
// 		const tx = await SC.conetUSDC.transferWithAuthorization(
// 			data.from,
// 			data.to,
// 			data.value,
// 			data.validAfter,
// 			data.validBefore,
// 			data.nonce,
// 			data.signature
// 		)
// 		await tx.wait()
// 		logger(`AuthorizationCall success ${tx.hash}`)
// 	} catch (ex: any) {
// 		logger(`Error! ${ex.message}`)
// 	}
// }


const withdrawWithCode = async(code: string, passcode: string, to: string) => {
	const SC = Settle_ContractPool[0]
	try {
		const tx = await SC.conetSC.withdrawWithCode(
			code + passcode,
			to
		)
		await tx.wait()
		logger(`withdrawWithCode success ${tx.hash}`)
	} catch (ex: any) {
		logger(`withdrawWithCode Error! ${ex.message}`)
	}
}




export const generateCheck = async (req: Request, res: Response) => {
	const { amount, note, secureCode } = req.query as {
		secureCode?: string
		note?: string
		amount?: string
	}

	const totalAmount = Number(amount)
	const checkNode = (!note || note.split('\r\n').length < 2)

	if (!amount|| isNaN(totalAmount) || totalAmount < 0.1 || !secureCode || checkNode || !ethers.isHexString(secureCode)) {
		logger(`generateCheck stage 1 error!`)
		return res.status(400)
	}

	const SC = Settle_ContractPool[0]

	logger(`secureCode : ${secureCode} , note : ${note} , amount ${amount}`)
	try {
		const [from] = await SC.conetSC.checkMemo(secureCode)

		logger(`generateCheck ${from} `)
		if (from !== ethers.ZeroAddress)
		{
			logger(`withdrawWithCode ${secureCode} is exiets `)
			return res.status(403).end()
		}

		
		
		const amt = ethers.parseUnits(amount, 6)

		const requestX402 = await BeamioPayment(req, res, amt, beamiobase)
		if (!requestX402 || !requestX402?.authorization) {
			return res.status(403).end()
		}

		const payload = requestX402.authorization
		depositWith3009AuthorizationPayLinkPool.push({
			from: payload.from,
			to: '',
			value: payload.value,
			validAfter: payload.validAfter,
			validBefore: payload.validBefore,
			signature: requestX402.signature,
			res: res,
			note: note,
			nonce: payload.nonce,
			linkHash: secureCode,
			newHash: true
		})
		depositWith3009AuthorizationPayLinkProcess()

	} catch (ex: any) {
		logger(`generateCheck SC.conetSC.checkMemo(secureCode) Error!, `, ex.message)
	}
	
}



const processCheck = async() => {
	const obj = processToBase.shift()
	if (!obj) {
		return
	}
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		processToBase.unshift(obj)
		return
	}

	const baseRpcUrl = getBaseRpcUrlViaConetNode() ?? BASE_RPC_URL
	const baseClient = createPublicClient({chain: base, transport: http(baseRpcUrl)})
	let baseHash: any
	try {

		// baseHash = await SC.baseWalletClient.writeContract({
		// 	address: CashCodeBaseAddr,
		// 	abi: CoinCodeABI,
		// 	functionName: 'depositWith3009Authorization',
		// 	args: [obj.from, USDCContract_BASE, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature, obj.hash]
		// })




		const tx = await SC.baseSC.depositWith3009Authorization(
			obj.from,
			USDCContract_BASE,
			obj.value,
			obj.validAfter,
			obj.validBefore,
			obj.nonce,
			obj.signature,
			obj.hash
		)
		
		// await tx.wait()
		
		const rx = await SC.conetSC.checkMemoGenerate(
			obj.hash,
			obj.from,
			obj.value,
			baseHash,
			'8453',
			USDCContract_BASE,
			'6',
			obj.note
		)

		await Promise.all([
			rx.wait(),
			baseClient.waitForTransactionReceipt({ hash: baseHash })
		])

		logger(`processCheck BASE success! ${baseHash} processCheck CONET success! ${rx.hash}`)
		
		obj.res.status(200).json({success: true, USDC_tx: baseHash}).end()

	} catch (ex: any) {
		obj.res.status(404).json({error: 'CashCode Server Error'}).end()
		logger(`processCheck Error! ${ex.message}`)
		logger(inspect({codeHash: obj.hash,from: obj.from, value: obj.value, successAuthorizationHash: baseHash, chianID:'8453', erc3009Address: USDCContract_BASE, decimals: '6', note: obj.note }, false, 3, true))
	}

	Settle_ContractPool.push(SC)

	setTimeout(() => {
		processCheck()
	}, 1000)

}

const processToBase: {
	from: string
	erc3009Addr: string
	value: string
	validAfter: string
	validBefore: string
	nonce: string
	signature: string
	hash: string
	note: string
	res: Response
}[] = []


const processCheckWithdrawPool: {
	code: string
	address: string
	res: Response
}[] = []

const processCheckWithdraw = async () => {
	const obj = processCheckWithdrawPool.shift()
	if (!obj) {
		return
	}
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		processCheckWithdrawPool.unshift()
		return setTimeout(() => {
			processCheckWithdraw()
		}, 1000)
	}

	const baseRpcUrl = getBaseRpcUrlViaConetNode() ?? BASE_RPC_URL
	const baseClient = createPublicClient({chain: base, transport: http(baseRpcUrl)})
	try {
		const hash = ethers.solidityPackedKeccak256(['string'], [obj.code])

		// const baseHash = await SC.baseWalletClient.writeContract({
		// 	address: CashCodeBaseAddr,
		// 	abi: CoinCodeABI,
		// 	functionName: 'withdrawWithCode',
		// 	args: [obj.code, obj.address]
		// })

		const tx = await SC.baseSC.withdrawWithCode(obj.code, obj.address)


		const tr = await SC.conetSC.finishedCheck(
			hash,
			tx.hash,
			obj.address
		)

		await Promise.all([
			tx.wait(),
			tr.wait()
		])

		obj.res.status(200).json({success: true, USDC_tx: tx.hash}).end()
		logger(`processCheckWithdraw success! BASE = ${tx.hash} CONET = ${tr.hash}`)
	} catch (ex: any) {
		logger('processCheckWithdraw error!', ex.message)
		obj.res.status(404).json({error: 'Server error!'}).end()
	}

	Settle_ContractPool.push(SC)

	setTimeout(() => {
		processCheckWithdraw()
	}, 1000)

}


export const cashcode_check = (req: Request, res: Response) => {
	const { code, address } = req.query as {
		address?: string
		code?: string
	}

	if (!code || !address || !ethers.isAddress(address)) {
		logger(`cashcode_check Format Error!`)
		return res.status(404).end()
	}

	logger(`cashcode_check`, inspect({address, code}, false, 3, true))

	processCheckWithdrawPool.push({
		address,
		res,
		code
	})

	processCheckWithdraw()

}


export const x402ProcessPool: airDrop[] = []
export const facilitatorsPool: facilitatorsPoolType[] = []



export const facilitators = async () => {
	const obj = facilitatorsPool.shift()
	if (!obj) {
		return
	}

	const SC = Settle_ContractPool.shift()
	if (!SC) {
		facilitatorsPool.unshift(obj)
		return setTimeout(() => facilitators(), 1000)
	}
	const wallet = obj.from
	try {

		// const baseHash = await SC.baseWalletClient.writeContract({
		// 	address: USDCContract_BASE,
		// 	abi: USDC_ABI,
		// 	functionName: 'transferWithAuthorization',
		// 	args: [obj.from, obj.isSettle ? SETTLEContract: CashCodeBaseAddr, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature]
		// })

		const tx = await SC.baseUSDC.transferWithAuthorization(
			obj.from, beamiobase, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature
		)

		// const baseClient = createPublicClient({chain: base, transport: http(`http://${getRandomNode()}/base-rpc`)})
		// // await tx.wait()
		// await baseClient.waitForTransactionReceipt({ hash: baseHash })

		// logger(`facilitators success! ${baseHash}`)

		const ret: x402Response = {
			success: true,
			payer: wallet,
			USDC_tx: tx.hash,
			network: 'BASE',
			timestamp: new Date().toISOString()
		}

		obj.res.status(200).json(ret).end()

		Settle_ContractPool.push(SC)
		if (obj.isSettle) {
			x402ProcessPool.push({
				wallet,
				settle: ethers.parseUnits('0.001', 6).toString()
			})
		}
		
		// await process_x402()
		return setTimeout(() => facilitators(), 1000)

	} catch (ex: any) {
		logger(`facilitators Error!`, ex.message)
	}

	//	transferWithAuthorization

	Settle_ContractPool.push(SC)
	setTimeout(() => facilitators(), 1000)
}

// export const process_x402 = async () => {
// 	console.debug(`process_x402`)
// 	const obj = x402ProcessPool.shift()
// 	if (!obj) {
// 		return
// 	}

// 	const SC = Settle_ContractPool.shift()
// 	if (!SC) {
// 		logger(`process_x402 got empty Settle_testnet_pool`)
// 		x402ProcessPool.unshift(obj)
// 		return
// 	}
// 	const baseClient = createPublicClient({chain: base, transport: http(`http://${getRandomNode()}/base-rpc`)})
// 	try {

// 		// const baseHash = await SC.baseWalletClient.writeContract({
// 		// 	address: SETTLEContract,
// 		// 	abi: Settle_ABI,
// 		// 	functionName: 'mint',
// 		// 	args: [obj.wallet, obj.settle]
// 		// })
// 		// await baseClient.waitForTransactionReceipt({ hash: baseHash })

// 		const tx = await SC.base.mint(
// 			obj.wallet, obj.settle
// 		)

// 		// await tx.wait()

// 		const SETTLE = BigInt(obj.settle) * MINT_RATE / USDC_decimals


		
// 		const ts = await SC.event.eventEmit(
// 			obj.wallet, obj.settle, SETTLE, baseHash
// 		)

// 		await ts.wait()

// 		reflashData.unshift({
// 			wallet: obj.wallet,
// 			hash: baseHash,
// 			USDC: obj.settle,
// 			timestmp: new Date().toUTCString(),
// 			SETTLE: SETTLE.toString(),
// 		})

// 		logger(`process_x402 success! ${baseHash}`)

// 	} catch (ex: any) {
// 		logger(`Error process_x402 `, ex.message)
// 		x402ProcessPool.unshift(obj)
// 	}

// 	Settle_ContractPool.push(SC)
// 	setTimeout(() => process_x402(), 1000)

// }



let lastGasEstimate:
  | { data: { gas: string; price: string; ethPrice: number }; ts: number }
  | null = null

// 当前是否有进行中的估算请求（用 Promise 复用同一次调用）
let pendingEstimate:
  | Promise<{ gas: string; price: string; ethPrice: number }>
  | null = null


// export const estimateErc20TransferGas = async (
// 	usdc: string,
// 	RecipientAddress: string,
// 	fromAddress: string
// ) => {
//   const now = Date.now()

//   // 1）有 15 秒内的缓存 → 直接返回
//   if (lastGasEstimate && (now - lastGasEstimate.ts) < 15_000) {
//     return lastGasEstimate.data
//   }

//   // 2）如果已经有进行中的 RPC 调用 → 等待 1 秒，然后复用它的结果
//   if (pendingEstimate) {
//     // 等待 1 秒（你要求的延迟）
//     await new Promise(resolve => setTimeout(resolve, 1_000))

//     // 再次检查：如果 1 秒内 RPC 完成了，缓存就应该是最新的
//     if (lastGasEstimate && (Date.now() - lastGasEstimate.ts) < 15_000) {
//       return lastGasEstimate.data
//     }

//     // 如果缓存还是没更新，就直接等待那次进行中的调用完成
//     try {
//       const data = await pendingEstimate
//       return data
//     } catch {
// 		return null
//     }
//   }

//   // 3）没有缓存、也没有进行中的请求 → 发起新的 RPC 调用
//   const node = getRandomNode()
//   const baseClient = createPublicClient({
//     chain: base,
//     transport: http(`http://${node}/base-rpc`)
// 	// transport: http(`http://94.143.138.27/base-rpc`)
//   })

//   pendingEstimate = (async () => {
//     const [gas, price] = await Promise.all([
//       baseClient.estimateContractGas({
//         address: USDCContract_BASE,
//         abi: USDC_ABI,
//         functionName: 'transfer',
//         account: fromAddress as `0x${string}`,
//         args: [
//           RecipientAddress,
//           ethers.parseUnits(usdc, 6)
//         ]
//       }),
//       baseClient.getGasPrice()
//     ])

// 	if (typeof gas !== 'bigint' || typeof price !== 'bigint' || !price || !gas) {
// 		const error = new Error(`Node = ${node} return null result! gas = ${gas} price = ${price}`)
// 		logger(error)
// 		throw(error)
// 	}

//     const result = {
//       gas: gas.toString(),
//       price: price.toString(),
//       ethPrice: oracle.eth
//     }

// 	logger(inspect(result, false, 3, true))
//     // 写入缓存
//     lastGasEstimate = {
//       data: result,
//       ts: Date.now()
//     }

//     return result
//   })()

//   try {
//     const data = await pendingEstimate
//     return data
//   } catch(ex: any) {
// 		logger(ex.message)
//   }
//    finally {
//     // 这次调用结束后，清空 pending 状态
//     pendingEstimate = null
//   }
// }


const linkMemo: {
	linkHash: string
	to: string
	value: string
	note: string
	res: Response|null
}[]= []

const baseChainID = 8453

const linkMemoGenerate = async() => {
	const obj = linkMemo.shift()
	if (!obj) {
		return
	}

	const SC = Settle_ContractPool.shift()
	if (!SC) {
		linkMemo.unshift(obj)
		return setTimeout(() => linkMemoGenerate(), 1000)
	}

	try {
		const tx = await SC.conetSC.linkMemoGenerate(
			obj.linkHash, obj.to, obj.value, baseChainID, USDCContract_BASE, USDC_Base_DECIMALS, obj.note
		)

		if (obj.res) obj.res.status(200).json({success: true, hash: tx.hash}).end()
		
		await tx.wait()
		logger(`linkMemoGenerate Success, ${tx.hash}!`, inspect({linkHash: obj.linkHash, to:  obj.to, value: obj.value, note: obj.note}, false, 3, true))

	} catch (ex: any) {
		logger(`linkMemoGenerate Error, ${ex.message}`)
		if (obj.res) obj.res.status(200).json({success: false}).end()
	}

	Settle_ContractPool.push(SC)
	setTimeout(() => linkMemoGenerate, 1000)

}

  // =============================
//  Balance Cache: 60 秒记忆
// =============================
const balanceCache: Record<string, {
	data: { usdc: string; eth: string; oracle: {eth: number, usdc: number} }
	ts: number
}> = {}

export const getOracleRequest = () => {
	return oracle
}

/** Cluster 进程不会自己跑 oracolPrice()，由其从 master /api/oracleForCluster 拉到快照后调用本函数同步进
 * util.ts 全局 oracle，确保 quoteCurrencyToUsdc6 / nfcTopupPreparePayload 在 cluster 端也能拿到真实链上汇率，
 * 而不是悄悄回退到写死的 fallback 常量（参见 beamio-currency-protocol：禁止固定汇率给客户报价）。 */
export const setOracleSnapshot = (snap: Record<string, unknown> | null | undefined): void => {
	if (!snap || typeof snap !== 'object') return
	const pickStr = (k: string): string | undefined => {
		const v = (snap as any)[k]
		if (v === undefined || v === null) return undefined
		const s = String(v)
		return s.length ? s : undefined
	}
	const pickNum = (k: string): number | undefined => {
		const v = (snap as any)[k]
		const n = Number(v)
		return Number.isFinite(n) ? n : undefined
	}
	const fields: Array<keyof typeof oracle> = ['bnb', 'eth', 'usdc', 'usdcad', 'usdjpy', 'usdcny', 'usdhkd', 'usdeur', 'usdsgd', 'usdtwd']
	for (const f of fields) {
		const v = pickStr(f as string)
		if (v !== undefined) (oracle as any)[f] = v
	}
	const ts = pickNum('timestamp')
	if (ts !== undefined && ts > 0) oracle.timestamp = ts
}

/** Oracle 报价新鲜度阈值（秒）。超过则视为 stale，不允许用于客户报价。 */
export const ORACLE_FRESH_WINDOW_SEC = 10 * 60

/** 判断当前 oracle 快照是否新鲜：timestamp 必须存在，并落在阈值窗口内。 */
export const isOracleFresh = (windowSec = ORACLE_FRESH_WINDOW_SEC): boolean => {
	const ts = Number(oracle.timestamp)
	if (!Number.isFinite(ts) || ts <= 0) return false
	const nowSec = Math.floor(Date.now() / 1000)
	return (nowSec - ts) <= windowSec
}

// const getBalance = async (address: string) => {
// 	const now = Date.now()
// 	const cached = balanceCache[address]

// 	// 若有缓存，且时间在 60 秒内 → 直接返回缓存
// 	if (cached && (now - cached.ts) < 60_000) {
// 		return cached.data
// 	}




//   // =============================
//   //      实际调用 RPC
//   // =============================
// //   const baseClient = createPublicClient({
// // 		chain: base,
// // 		//transport: http(`http://${getRandomNode()}/base-rpc`)
// // 		transport: http(`http://94.143.138.27/base-rpc`)
// // 	})

// 	const baseEthers = new ethers.JsonRpcProvider('')
// 	const SC = new ethers.Contract(USDCContract_BASE, USDC_ABI, baseEthers)

// 	try {
// 		// const [usdcRaw, ethRaw] = await Promise.all([
// 		//   baseClient.readContract({
// 		//     address: USDCContract_BASE,
// 		//     abi: USDC_ABI,
// 		//     functionName: 'balanceOf',
// 		//     args: [address]
// 		//   }),
// 		//   providerBase.getBalance(address)
// 		// ])

// 		const [usdcRaw, ethRaw] = await Promise.all([
// 			SC.balanceOf (address),
// 			baseEthers.getBalance(address)
// 		])
		

// 		const usdc = ethers.formatUnits(usdcRaw as bigint, 6)
// 		const eth = ethers.formatUnits(ethRaw, 18)

// 		const result = { usdc, eth, oracle: { eth: oracle.eth, usdc: oracle.usdc }}
// 		logger(inspect(result, false, 3, true))
// 		// 记忆：写入缓存
// 		balanceCache [address] = {
// 			data: result,
// 			ts: now
// 		}

// 		return result
// 	} catch (ex: any) {
// 		logger(`baseUSDC.balanceOf Error!`, ex.message)
// 		return null
// 	}
// }

/** Faucet 已停用，统一返回 200 兼容旧客户端 */
export const BeamioFaucet = async (_req: Request, res: Response) => {
	return res.status(200).json({ success: true }).end()
}

const BeamioPayment = async (req: Request, res: Response, amt: string|bigint, wallet: string): Promise<false|payload> => {
	
		logger (`BeamioGateway: `, inspect({amt, wallet}))

		const _routerName = req.path
		const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`)

		const resource = `${req.protocol}://${req.headers.host}${url.pathname}` as Resource
		
		if (!amt) {
			logger(`processPayment ${_routerName} price=${amt} Error!`)
			res.status(404).end()
			return false
		}

		const price = Number(ethers.formatUnits(amt, 6))
		if (isNaN(price) || price <= 0.02 || !wallet) {
			logger(`processPayment isNaN(price) || price <= 0 || !wallet Error! `)
			res.status(403).json({success: 'Data format error!'}).end()
			return false
		}


		const paymentRequirements = [createBeamioExactPaymentRequirements(
			price,
			resource,
			`Beamio Payment Request for ${wallet}`,
			beamiobase
		)]


		const isValid = await verifyPaymentNew(req, res, paymentRequirements)

		if (!isValid) {
			logger(`verifyPaymentNew Error!`)
			res.status(402).end()
			return false
		}

		let responseData: x402SettleResponse

		const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
		const saleRequirements = paymentRequirements[0]
		
		const isValidPaymentHeader = checkx402paymentHeader(paymentHeader as x402paymentHeader, BigInt(amt), beamiobase)

		if (!isValidPaymentHeader) {
			logger(`${_routerName} checkx402paymentHeader Error!`,inspect(paymentHeader))
			res.status(402).end()
			return false
		}

		

		const payload: payload = paymentHeader?.payload as payload
		
		if (!payload.signature || payload.signature.length > 132) {
			logger(`${_routerName} checkx402paymentHeader sign Error!`,inspect(payload, false, 3, true))
			res.status(403).end()
			return false
		}

		if (payload.authorization.to.toLowerCase() !== wallet.toLowerCase() || Number(payload.authorization.value.toString()) !==  Number(amt.toString())) {
			logger(`${_routerName} checkx402paymentHeader authorization Error!`,inspect(payload, false, 3, true))
			res.status(403).end()
			return false
		}

		return payload


}

const depositWith3009AuthorizationPayLinkPool: facilitatorsPayLinkPoolType[] = []

const depositWith3009AuthorizationPayLinkProcess = async () => {
	const obj = depositWith3009AuthorizationPayLinkPool.shift()
	if (!obj) {
		return 
	}
	const SC = Settle_ContractPool.shift()

	if (!SC) {
		depositWith3009AuthorizationPayLinkPool.unshift(obj)
		return setTimeout(() => depositWith3009AuthorizationPayLinkProcess(), 3000)
	}

/**
 * finishedPayLinkPool.push({
			linkHash: code,
			from: declaneAddress,
			depositHash: ethers.ZeroHash,
			payAmount: '0'
		})
 */
	try {



		const tx = obj.to ? await SC.baseSC["depositWith3009Authorization(address,address,address,uint256,uint256,uint256,bytes32,bytes)"]
		(
			obj.from,
			obj.to,
			USDCContract_BASE,
			obj.value,
			obj.validAfter,
			obj.validBefore,
			obj.nonce,
			obj.signature
		) : await SC.baseSC["depositWith3009Authorization(address,address,uint256,uint256,uint256,bytes32,bytes,bytes32)"] 
		(
			obj.from, USDCContract_BASE, obj.value, obj.validAfter,obj.validBefore, obj.nonce,obj.signature, obj.linkHash
		)

		logger(`depositWith3009AuthorizationPayLinkProcess baseSC success!`, tx.hash)

		obj.res.status(200).json({success: true, USDC_tx: tx.hash})

		const tr = obj.to? await SC.conetSC.finishedLink(
			obj.linkHash, tx.hash, obj.from, obj.value
		) : await SC.conetSC.checkMemoGenerate(
			obj.linkHash, obj.from, obj.value, tx.hash, baseChainID, USDCContract_BASE, USDC_decimals, obj.note, obj.linkHash
		)
		await Promise.all([
			tx.wait(), tr.wait ()
		])
		
		logger(`depositWith3009AuthorizationPayLinkProcess conetSC success!`, tr.hash)

	} catch (ex: any) {
		logger(inspect({from:obj.from, to: obj.to, linkHash: obj.linkHash, usdcAmount: obj.value, validAfter: obj.validAfter, validBefore:obj.validBefore, nonce: obj.nonce, signature: obj.signature  }))
		logger(`depositWith3009AuthorizationPayLinkProcess Error!`, ex.message)
	}

	Settle_ContractPool.unshift(SC)
	setTimeout(() => depositWith3009AuthorizationPayLinkProcess(), 3000)

}

const declaneAddress = '0x1000000000000000000000000000000000000000'

/** Faucet 已停用，no-op */
export const BeamioETHFaucetTry = async (_address: string) => {
	return
}

/** Faucet 已停用，统一返回 200 兼容旧客户端 */
export const BeamioETHFaucet = async (_req: Request, res: Response) => {
	return res.status(200).json({ success: true }).end()
}

const BeamioPaymentLinkFinish = async (req: Request, res: Response) => {
	let { code, amount } = req.query as {
		amount?: string
		code?: string
	}

	const totalAmount = Number(amount)

	//		check step 1
	if (!code || !ethers.isHexString(code) || isNaN(totalAmount)) {
		logger(`BeamioPaymentLinkFinish check step 1 Error! !code == ${!code} || !ethers.isHexString(code) == ${!ethers.isHexString(code)} || isNaN(totalAmount) ${isNaN(totalAmount)}`)
		return res.status(404).end()
	}

	const SC = Settle_ContractPool[0]

	try {
		const getPayLink = await SC.conetSC.linkMemo(code)
		const requestAmount = Number(getPayLink.amount.toString())

		//			no request 
		if (getPayLink.to === ethers.ZeroAddress) {
			logger(`BeamioPaymentLinkFinish no request getPayLink.to === ethers.ZeroAddress Error! getPayLink.to ${getPayLink.to} `)
			return res.status(404).end()
		}

		//			Insufficient request
		// if (totalAmount > 0 && totalAmount < requestAmount) {
		// 	logger(`BeamioPaymentLinkFinish totalAmount ${totalAmount} > 0 && totalAmount < requestAmount ${requestAmount} Error! `)
		// 	return res.status(403).end()
		// }

		//				Already Used
		if (getPayLink.from !== ethers.ZeroAddress) {
			
			const newCode = generateCODE('').hash

			//		new Link request
			linkMemo.push({
				value: getPayLink.amount,
				note: getPayLink.node,
				linkHash: newCode,
				res: null,
				to: getPayLink.to
			})
			linkMemoGenerate()

			logger(`BeamioPaymentLinkFinish Already Used create new ! ${code} ==> ${newCode}`)

			code = newCode
			//		Declane
			
		}
		logger(`BeamioPaymentLinkFinish doing BeamioPayment code ${code} totalAmount ${totalAmount} !`)

		if (!totalAmount) {
			logger(`BeamioPaymentLinkFinish code ${code} Declane`)
			finishedPayLinkPool.push({
				linkHash: code,
				from: declaneAddress,
				depositHash: ethers.ZeroHash,
				payAmount: '0'
			})

			res.status(200).json({success: true}).end()
			return setTimeout(() => finishedPayLinkProcess(), 5000)
		}

		const requestX402 = await BeamioPayment(req, res, totalAmount.toString(), beamiobase)
		logger(inspect(requestX402, false, 3, true))
		if (!requestX402|| !requestX402?.authorization) {
			return 
		}

		const authorization = requestX402.authorization
		depositWith3009AuthorizationPayLinkPool.push({
			from: authorization.from,
			to: getPayLink.to,
			value: authorization.value,
			validAfter: authorization.validAfter,
			validBefore: authorization.validBefore,
			nonce: authorization.nonce,
			signature: requestX402.signature,
			res: res,
			linkHash: code,
			newHash: true
		})
		depositWith3009AuthorizationPayLinkProcess()

	} catch (ex: any) {
		return res.status(403).end()
	}

}

export const BeamioPaymentLinkFinishRouteToSC = async (req: Request, res: Response) => {
	let { code, amount, note } = req.query as {
		amount?: string
		code?: string
		note?: string
	}

	const totalAmount = Number(amount)

	//		check step 1
	if (!code || !ethers.isHexString(code) || isNaN(totalAmount) || totalAmount <= 0) {
		logger(`BeamioPaymentLinkFinishRouteToSC check step 1 Error! !code == ${!code} || !ethers.isHexString(code) == ${!ethers.isHexString(code)} || isNaN(totalAmount) ${isNaN(totalAmount)}`)
		return res.status(404).end()
	}

	const SC = Settle_ContractPool[0]



	try {
		const getPayLink = await SC.conetSC.linkMemo(code)
		const requestAmount = Number(getPayLink.amount.toString())

		//			no request 
		if (getPayLink.to === ethers.ZeroAddress) {
			logger(`BeamioPaymentLinkFinishRouteToSC no request getPayLink.to === ethers.ZeroAddress Error! getPayLink.to ${getPayLink.to} `)
			return res.status(404).end()
		}

		//			Insufficient request	need check chrrency
		// if ( totalAmount < requestAmount) {
		// 	logger(`BeamioPaymentLinkFinishRouteToSC totalAmount ${totalAmount} > 0 && totalAmount < requestAmount ${requestAmount} Error! `)
		// 	return res.status(403).end()
		// }

		//				Already Used
		if (getPayLink.from !== ethers.ZeroAddress) {
			logger(`BeamioPaymentLinkFinishRouteToSC getPayLink.from !== ethers.ZeroAddress ${getPayLink.from !== ethers.ZeroAddress} Can't be reuse Error! `)
			return res.status(403).end()
			
		}


		logger(`BeamioPaymentLinkFinishRouteToSC doing BeamioPayment code ${code} totalAmount ${totalAmount} !`)

		

		const requestX402 = await BeamioPayment(req, res, totalAmount.toString(), beamiobase)
		logger(inspect(requestX402, false, 3, true))
		if (!requestX402|| !requestX402?.authorization) {
			return 
		}
		
			const from = requestX402.authorization.from
			const to = requestX402.authorization.to
			const value = requestX402.authorization.value
			
			PayMePool.push({
				from,
				to,
				value,
				validAfter: requestX402.authorization.validAfter,
				validBefore: requestX402.authorization.validBefore,
				nonce: requestX402.authorization.nonce,
				signature: requestX402.signature,
				res: res,
				linkHash: code,
				note: note,
				newHash: false
			})
			PayMeProcess()

	} catch (ex: any) {
		return res.status(403).end()
	}

}

const finishedPayLinkPool: {
	linkHash: string
	depositHash: string
	from: string
	payAmount: string

}[] = []

const finishedPayLinkProcess = async () => {
	const obj = finishedPayLinkPool.shift()
	if (!obj) {
		return
	}
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		finishedPayLinkPool.unshift(obj)
		return setTimeout(() => {
			finishedPayLinkProcess()
		}, 4000)
	}
	try {
		const tx = await SC.conetSC.finishedLink(obj.linkHash, obj.depositHash, obj.from, obj.payAmount)
		await tx.wait()
		logger(`finishedPayLinkProcess success!`, tx.hash)
	} catch (ex:any) {
		logger(`finishedPayLinkProcess Error!`, ex.message)
		finishedPayLinkPool.unshift(obj)
	}

	Settle_ContractPool.push(SC)
	setTimeout(() => finishedPayLinkProcess(), 4000)


}

const PayMePool: facilitatorsPayLinkPoolType[] = []

const PayMeProcess = async () => {
	const obj = PayMePool.shift()
	if (!obj) return

	const SC = Settle_ContractPool.shift()
	if (!SC) {
		PayMePool.unshift(obj)
		return setTimeout(() => depositWith3009AuthorizationPayLinkProcess(), 3000)
	}

	try {
		//		转账到 beamio smart contract 地址
		const tx = await SC.baseSC["depositWith3009Authorization(address,address,address,uint256,uint256,uint256,bytes32,bytes)"]
		(
			obj.from,
			obj.to,
			USDCContract_BASE,
			obj.value,
			obj.validAfter,
			obj.validBefore,
			obj.nonce,
			obj.signature
		)

		logger(`PayMeProcess baseSC success!`, tx.hash)
		if (obj.res.writable) {
			obj.res.status(200).json({success: true, USDC_tx: tx.hash}).end()
		}
		
		const [,tr] = await Promise.all([
			tx.wait(),
							//		记录到 conetSC 上	 obj.to
			obj.newHash ? SC.conetSC.linkMemoGenerate(
				obj.linkHash, obj.to, obj.value, baseChainID, USDCContract_BASE, USDC_Base_DECIMALS, obj.note
			) : SC.conetSC.finishedLink(
				obj.linkHash, tx.hash, obj.from, obj.value
			)
		])
		
		

		await tr.wait()

		logger(`PayMeProcess conetSC tr success!`, tr.hash)

		if (obj.newHash) {
			await new Promise(executor => setTimeout(() => executor(true), 4000))

			const ts = await SC.conetSC.finishedLink(
				obj.linkHash, tx.hash, obj.from, obj.value
			)
			
			await ts.wait()

			logger(`PayMeProcess newHash conetSC success!`, ts.hash)

		}
		

	} catch (ex: any) {
		

		logger(`PayMeProcess Error!`,inspect({from:obj.from, to: obj.to, linkHash: obj.linkHash, usdcAmount: obj.value, validAfter: obj.validAfter, validBefore:obj.validBefore, nonce: obj.nonce, signature: obj.signature  }))
		logger(`PayMeProcess Error!`, ex.message)
	}

	Settle_ContractPool.unshift(SC)
	setTimeout(() => PayMeProcess(), 3000)

}


const beamioApi = 'https://beamio.app'
const searchUrl = `${beamioApi}/api/search-users`

const searchUsername = async (keyward: string) => {
	const params = new URLSearchParams({keyward}).toString()
	const requestUrl = `${searchUrl}?${params}`
	try {
		const res = await fetch(requestUrl, {method: 'GET'})

		
		if (res.status !== 200) {
			return null
		}
		return await res.json()
		

	} catch (ex) {
		
	}
	return null
}


export const BeamioPayMe = async (req: Request, res: Response) => {
	const { code, amount, note, address } = req.query as {
		amount?: string
		code?: string
		note?: string
		address?: string
	}
	const isAddress = ethers.isAddress(address)
	const _amount = Number(amount)
	if (!isAddress || address === ethers.ZeroAddress || isNaN(_amount) || !_amount ) {
		return res.status(404).end()
	}

	//		if already linkHash exits
	const getPayLink = await Settle_ContractPool[0].conetSC.linkMemo(code)
	
	if (getPayLink.to !== ethers.ZeroAddress) {

		logger(`BeamioPayMe Error! code ${code} getPayLink.to !== ethers.ZeroAddress.`)
		return res.status(403).end()
	}



	const user: any = await searchUsername(address)
	if (!user?.results?.length||user.results.length > 1) {
		logger(`BeamioPayMe Error! address ${address} has not exits!!!`)
		return res.status(404).end()
	}

	const _price = amount|| '0'
	const price = ethers.parseUnits(_price, USDC_Base_DECIMALS)			// to BIG INT

	if ( !amount || price <= 0 ) {
		logger(`BeamioPayMe Error! The minimum amount was not reached.`,inspect( req.query, false, 3, true))
		return res.status(400).json({success: false, error: 'The minimum amount was not reached.'})
	}

	const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`)
	const resource = `${req.protocol}://${req.headers.host}${url.pathname}` as Resource
	const paymentRequirements = [createBeamioExactPaymentRequirements(
		amount,
		resource,
		`Beamio Transfer`,
		address
	)]

	const isValid = await verifyPaymentNew(req, res, paymentRequirements)

	if (!isValid) {
		logger(`BeamioPayMe !isValid ERROR!`)
		return 
	}

	let responseData: x402SettleResponse

	const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
	const saleRequirements = paymentRequirements[0]

	const payload: payload = paymentHeader?.payload as payload

	try {
	
		
		const settleResponse = await settle(
			paymentHeader,
			saleRequirements)

		const responseHeader = settleResponseHeader(settleResponse)

		// In a real application, you would store this response header
		// and associate it with the payment for later verification
		
		responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
		
		if (!responseData.success) {
			logger(`BeamioPayMe responseData ERROR!`, inspect(responseData, false, 3, true))
			return res.status(402).end()
		}

		const wallet = responseData.payer
		
		
		const ret: x402Response = {
			success: true,
			payer: wallet,
			USDC_tx: responseData?.transaction,
			network: responseData?.network,
			timestamp: new Date().toISOString()
		}

		
		res.status(200).json(ret).end()

		logger(inspect(ret, false, 3, true))

		const authorization = payload?.authorization
		if (authorization) {

			const from = authorization.from
			const to = authorization.to
			const amount = authorization.value
			

			PayMePool.push({
				from,
				to,
				value: amount,
				validAfter: authorization.validAfter,
				validBefore: authorization.validBefore,
				nonce: authorization.nonce,
				signature: responseData?.transaction,
				res: res,
				linkHash: code,
				note: note,
				newHash: true
			})
			PayMeProcess()
			
		}
		
		return 
			
	} catch (ex: any) {
		console.error("Payment settlement failed:", ex.message)
		res.status(500).end()
	}

	
	

}

export const BeamioPayMeRouteToSC = async (req: Request, res: Response) => {
	const { code, amount, note, address } = req.query as {
		amount?: string
		code?: string
		note?: string
		address?: string
	}
	
	const isAddress = ethers.isAddress(address)
	const _amount = Number(amount)
	if (!isAddress || address === ethers.ZeroAddress || isNaN(_amount) || !_amount ) {
		return res.status(404).end()
	}

	//		if already linkHash exits
	const getPayLink = await Settle_ContractPool[0].conetSC.linkMemo(code)
	
	if (getPayLink.to !== ethers.ZeroAddress) {

		logger(`BeamioPayMe Error! code ${code} getPayLink.to !== ethers.ZeroAddress.`)
		return res.status(403).end()
	}



	const user: any = await searchUsername(address)
	if (!user?.results?.length||user.results.length > 1) {
		logger(`BeamioPayMe Error! address ${address} has not exits!!!`)
		return res.status(404).end()
	}

	const _price = amount|| '0'
	const price = ethers.parseUnits(_price, USDC_Base_DECIMALS)			// to BIG INT

	if ( !amount || price <= 0 ) {
		logger(`BeamioPayMe Error! The minimum amount was not reached.`,inspect( req.query, false, 3, true))
		return res.status(400).json({success: false, error: 'The minimum amount was not reached.'})
	}

	const requestX402 = await BeamioPayment(req, res, price.toString(), beamiobase)
	logger(inspect(requestX402, false, 3, true))
	if (!requestX402|| !requestX402?.authorization) {
		return 
	}


		
// depositWith3009AuthorizationPayLinkPool.push({
// 			from: payload.from,
// 			to: '',
// 			value: payload.value,
// 			validAfter: payload.validAfter,
// 			validBefore: payload.validBefore,
// 			signature: requestX402.signature,
// 			res: res,
// 			note: note,
// 			nonce: payload.nonce,
// 			linkHash: secureCode,

// 		})
			const from = requestX402.authorization.from
			const to = requestX402.authorization.to
			const value = requestX402.authorization.value
			

			PayMePool.push({
				from,
				to: address,
				value,
				validAfter: requestX402.authorization.validAfter,
				validBefore: requestX402.authorization.validBefore,
				nonce: requestX402.authorization.nonce,
				signature: requestX402.signature,
				res: res,
				linkHash: code,
				note: note,
				newHash: true
			})
			PayMeProcess()
			
		return 
			

}


export const BeamioPaymentLink = async (req: Request, res: Response) => {
	const { code, amount, note, address } = req.query as {
		amount?: string
		code?: string
		note?: string
		address?: string
	}
	const totalAmount = Number(amount)
	if (!code || !address|| isNaN(totalAmount) || !ethers.isHexString(code)) {
		return res.status(404).end()
	}

	linkMemo.push({
		value: totalAmount.toString(),
		note: note||'',
		linkHash: code,
		res,
		to: address
	})
	linkMemoGenerate()

}

type hashAmount = {
	from: string
	amount: bigint
	erc20: string
}


const redeemCheckPool: {
	secureCode: string
	address: string
	res: Response,
	hash: string
}[] = []

const redeemCheckProcess = async () => {
	const obj = redeemCheckPool.shift()
	if (!obj) {
		return
	}
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		redeemCheckPool.unshift(obj)
		setTimeout(() => {
			redeemCheckProcess()
		}, 2000)
		return 
	}


	try {
		const tx = await SC.baseSC.withdrawWithCode(obj.secureCode, obj.address)
		const tr = await SC.conetSC.finishedCheck(obj.hash, tx.hash, obj.address)
		
		if (obj.res.writable) {
			obj.res.status(200).json({success: true, tx: tx.hash}).end()
		}
		await Promise.all([
			tx.wait(),
			tr.wait()
		])

		logger(`redeemCheckProcess SUCCESS! BASE ${tx.hash} to ${obj.address} CoNET ${tr.hash}`)

	} catch (ex: any) {
		logger(`redeemCheckProcess Error! ${ex.message}`)
		obj.res.status(500).json({success: false}).end()
	}

	Settle_ContractPool.push(SC)
	setTimeout(() => {
		redeemCheckProcess()
	}, 2000)
}

export const redeemCheck = async (req: Request, res: Response) => {
	const { secureCode, securityCodeDigits, address } = req.query as {
		secureCode?: string
		securityCodeDigits?: string
		address?: string
	}
	if (!secureCode|| secureCode === ethers.ZeroHash || !address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
		return res.status(404).end()
	}

	const hash = ethers.solidityPackedKeccak256(['string'], [secureCode+securityCodeDigits])
	const SC = Settle_ContractPool[0]
	try {
		const obj: hashAmount  = await SC.baseSC.hashAmount(hash)

		if (obj.from === ethers.ZeroAddress || obj.amount === BigInt(0) || obj.erc20.toLowerCase() !== USDCContract_BASE.toLowerCase()) {
			logger(`/redeemCheck hash${hash} has zero from address error! `, inspect(obj, false, 3, true))
			res.status(403).end()
			return 
		}

		redeemCheckPool.push({
			secureCode: secureCode + securityCodeDigits,
			address,
			res,
			hash
		})

		redeemCheckProcess()


	} catch (ex: any) {
		logger(`redeemCheck catch ex!! ${ex.message}`)
		return 
	}



}

export const checkSign = (message: string, signMess: string, signWallet: string) => {
	if (!message || !signMess) {
		
		return null
	}
	
	let recoverPublicKey
	try {
		recoverPublicKey = ethers.verifyMessage(message, signMess)

	} catch (ex: any) {
		return logger(`${ex.messang}`)
	}

	if (!recoverPublicKey || recoverPublicKey.toLowerCase() !== signWallet.toLowerCase()) {
		logger(`!recoverPublicKey || recoverPublicKey.toLowerCase() !== signWallet.toLowerCase()`)
		return null
	}
	
	return signWallet.toLowerCase()
	
}

// setTimeout(() => test1(), 5000)
// setTimeout(() => {test2()}, 2000)

