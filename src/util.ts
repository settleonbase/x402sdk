import {join} from 'node:path'
import {homedir} from 'node:os'
import {ethers} from 'ethers'
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
export const masterSetup: IMasterSetup = require ( setupFile )
import {reflashData} from './server'

const facilitator1 = createFacilitatorConfig(masterSetup.base.CDP_API_KEY_ID,masterSetup.base.CDP_API_KEY_SECRET)

const x402Version = 1
const conetEndpoint = 'https://mainnet-rpc.conet.network'
const CashCodeBaseAddr = '0x3977f35c531895CeD50fAf5e02bd9e7EB890D2D1'
const USDCContract_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_Base_DECIMALS = 6

const USDC_conet = '0x43b25Da1d5516E98D569C1848b84d74B4b8cA6ad'
const SETTLEContract = '0x20c84933F3fFAcFF1C0b4D713b059377a9EF5fD1'
export const MINT_RATE = ethers.parseUnits('7000', 18)
const USDC_decimals = BigInt(10 ** 6)
//	const conet_CashCodeNote = '0xCe1F36a78904F9506E5cD3149Ce4992cC91385AF'
const conet_CashCodeNote = '0xB8c526aC40f5BA9cC18706efE81AC7014A4aBB6d'
const oracleSC_addr = '0xE9922F900Eef37635aF06e87708545ffD9C3aa99'
const eventContract = '0x18A976ee42A89025f0d3c7Fb8B32e0f8B840E1F3'

const {verify, settle} = useFacilitator(facilitator1)

const GuardianNodeInfo_mainnet = '0x2DF3302d0c9aC19BE01Ee08ce3DDA841BdcF6F03'
const CONET_MAINNET = new ethers.JsonRpcProvider('https://mainnet-rpc.conet.network') 
const GuardianNodesMainnet = new ethers.Contract(GuardianNodeInfo_mainnet, newNodeInfoABI, CONET_MAINNET)


//					beamio	Contract

const beamiobase = '0xdE51f1daaCa6eae9BDeEe33E324c3e6e96837e94'
const beamioConet = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
const airdropRecord = '0x070BcBd163a3a280Ab6106bA62A079f228139379'
const beamioConetAccountRegistry = '0x09dfed722FBD199E9EC6ece19630DE02692eF572'

let Guardian_Nodes: nodeInfo[] = []

const getRandomNode = () => {
    const _node1 = Guardian_Nodes[Math.floor(Math.random() * (Guardian_Nodes.length - 1))]
    // return `https://${_node1.domain}.conet.network/solana-rpc`
    return _node1.ip_addr
}

const getAllNodes = () => new Promise(async resolve=> {

	const _nodes = await GuardianNodesMainnet.getAllNodes(0, 1000)
	for (let i = 0; i < _nodes.length; i ++) {
		const node = _nodes[i]
		const id = parseInt(node[0].toString())
		const pgpString: string = Buffer.from( node[1], 'base64').toString()
		const domain: string = node[2]
		const ipAddr: string = node[3]
		const region: string = node[4]
		const itemNode = {
			ip_addr: ipAddr,
			armoredPublicKey: pgpString,
			domain: domain,
			nftNumber: id,
			region: region
		}
	
		Guardian_Nodes.push(itemNode)
  	}
	
	resolve(true)
	logger(`getAllNodes success total nodes = ${Guardian_Nodes.length}`)
})

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
	id: 224400, // 随便指定唯一的 chainId，例如 2550；如果有官方ID请填实际
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

export const oracolPrice = async () => {
	if (oracolPriceProcess) {
		return
	}
	oracolPriceProcess = true

	const assets = ['bnb', 'eth', 'usdc','usd-cad', 'usd-jpy', 'usd-cny', 'usd-hkd', 'usd-eur', 'usd-sgd', 'usd-twd']
	const process: any[] = []
	assets.forEach(n => {
		process.push (oracleSC.GuardianPrice(n))
	})

	const price = await Promise.all([...process, oracleSC.lastUpdateEpoch()])
	const bnb = ethers.formatEther(price[0])
	const eth = ethers.formatEther(price[1])
	const usdc = ethers.formatEther(price[2])
	const usdcad = ethers.formatEther(price[3])
	const usdjpy = ethers.formatEther(price[4])
	const usdcny = ethers.formatEther(price[5])
	const usdhkd = ethers.formatEther(price[6])
	const usdeur = ethers.formatEther(price[7])
	const usdsgd = ethers.formatEther(price[8])
	const usdtwd = ethers.formatEther(price[9])
	const timestamp = Number(price[6].toString())

	logger(`oracolPrice BNB ${bnb} ETH ${eth} USDC ${usdc} `)
	oracle.bnb = bnb.toString()
	oracle.eth = eth.toString()
	oracle.usdc = usdc.toString()
	oracle.usdcad = usdcad.toString()
	oracle.usdjpy = usdjpy.toString()
	oracle.usdcny = usdcny.toString()
	oracle.usdhkd = usdhkd.toString()
	oracle.usdeur = usdeur.toString()
	oracle.usdsgd = usdsgd.toString()
	oracle.usdtwd = usdtwd.toString()
	oracle.timestamp = timestamp

	oracolPriceProcess = false
}

export const oracleBackoud = async (FaucetProcess = true) => {
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
			// conetUSDC: new ethers.Contract(USDC_conet, USDC_ABI, walletConet),
			conetSC: new ethers.Contract(beamioConet, beamioConetABI, walletConet),
			// event: new ethers.Contract(eventContract, Event_ABI, walletConet),
			conetAirdrop: new ethers.Contract(airdropRecord, conetAirdropABI, walletConet),
			constAccountRegistry: new ethers.Contract(beamioConetAccountRegistry, AccountRegistryABI, walletConet),
		}
	})

	oracolPrice()
	providerConet.on('block', async (blockNumber) => {

		if (blockNumber % 10 !== 0) {
			return
		}

		if (FaucetProcess) FaucetUserProcess()
		
		oracolPrice()

	})

}

const resource = `https://beamio.app/api/payment` as Resource

const USDC_FaucetAmount = '0.2'
const usdcFaucetAmount = ethers.parseUnits(USDC_FaucetAmount, 6)


const processUSDC_Faucet = async () => {
	const obj = FaucetUserPool.shift()
	if (!obj) {
		return
	}

	const SC = Settle_ContractPool.shift()
	if (!SC) {
		FaucetUserPool.unshift(obj)
		return setTimeout(() => processUSDC_Faucet(), 2000)
	}

	logger(`processUSDC_Faucet start! `, inspect(obj, false, 3, true))
	const paymentRequirements = createBeamioExactPaymentRequirements(
		USDC_FaucetAmount.toString(),
		resource,
		`Beamio Transfer`,
		obj.wallet
	)

	const paymentHeader = {
		network: 'base',
		payload: await AuthorizationSign(USDC_FaucetAmount, obj.wallet, SC.privateKey, 6, baseChainID.toString(), USDCContract_BASE),
		scheme:'exact',
		x402Version: 1
	}


	try {

		//	first 
		const tr = await SC.conetAirdrop.airdrop(obj.wallet, obj.ipaddress)

		const settleResponse = await settle(
			//@ts-ignore
			paymentHeader,
			paymentRequirements)
		const responseHeader = settleResponseHeader(settleResponse)

		// In a real application, you would store this response header
		// and associate it with the payment for later verification
		
		const responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
		
		if (!responseData.success) {
			logger(`processUSDC_Faucet responseData ERROR!`, inspect(responseData, false, 3, true))
			return
		}

		logger(`processUSDC_Faucet processUSDC_Faucet success! ${responseData?.transaction}`)

		const tx = await SC.conetSC.transferRecord(
			SC.wallet.address,
			obj.wallet,
			usdcFaucetAmount,
			responseData?.transaction,
			'Thank you for joining Beamio Alpha Test!'
		)

		
		await Promise.all([
			tx.wait(), tr.wait()
		])
		logger(`processUSDC_Faucet record to CoNET success ${tx.hash} ${tr.hash}`)
		
	} catch (ex: any) {
		if (/500 Internal Server/i.test( ex.message)) {
			FaucetUserPool.unshift(obj)
		}
		logger(`processUSDC_Faucet Error!`, ex.message)
		
	}
	Settle_ContractPool.push(SC)
	setTimeout(() => processUSDC_Faucet(), 2000)
}


const totalFaucetETHRecord: string [] = []

let waitingFaucetUserProcessPool: string[] = []

const FaucetUserProcess = async () => {
	
	if (!waitingFaucetUserProcessPool.length) {
		return
	}
	
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		return
	}
	
	try {
		const tx = await SC.conetSC.newUserBetch(waitingFaucetUserProcessPool)
		waitingFaucetUserProcessPool = []
		await tx.wait()
		console.log(`FaucetUserProcess success ${tx.hash} address number = ${waitingFaucetUserProcessPool.length}`)
	}catch (ex: any) {
		logger(`FaucetUserProcess Error! ${ex.message}`)
	}
	
	Settle_ContractPool.push(SC)
	processUSDC_Faucet()
}

const providerBase = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const providerBaseBackup = new ethers.JsonRpcProvider('https://1rpc.io/base')

const providerConet = new ethers.JsonRpcProvider(conetEndpoint)
const oracleSC = new ethers.Contract(oracleSC_addr, GuardianOracle_ABI, providerConet)

export let Settle_ContractPool: {
	baseSC: ethers.Contract
	baseUSDC: ethers.Contract
	conetSC: ethers.Contract
	privateKey: string
	wallet: ethers.Wallet
	conetAirdrop: ethers.Contract
	constAccountRegistry: ethers.Contract
}[] = []

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

export const verifyPaymentNew = (
		req: Request,
		res: Response,
		paymentRequirements: PaymentRequirements[],
	): Promise<false|any> => new Promise(async resolve =>  {
	const payment = req.header("X-PAYMENT")

	if (!payment) {
		logger(`verifyPayment send x402 payment information`)
		res.status(402).json({
			x402Version,
			error: "X-PAYMENT header is required",
			accepts: paymentRequirements,
		})
		return 
	}

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
	
	try {

		if (!paymentRequirements.length) {
			//@ts-ignore
			const amount = decodedPayment.payload.authorization.value
			const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`)
			const resource = `${req.protocol}://${req.headers.host}${url.pathname}` as Resource
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

	} catch (error) {

		logger(`verifyPayment catch error!`, error)

		res.status(402).json({
			x402Version,
			error,
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


export const BeamioTransfer = async (req: Request, res: Response) => {
	const _routerName = req.path
	const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`)
	const resource = `${req.protocol}://${req.headers.host}${url.pathname}` as Resource

	const { amount, toAddress, note } = req.query as {
		amount?: string
		toAddress?: string
		note?: string
	}

	const _price = amount|| '0'
	const price = ethers.parseUnits(_price, USDC_Base_DECIMALS)
	
	if ( !amount || price <=0 || !ethers.isAddress(toAddress)) {
		logger(`${_routerName} Error! The minimum amount was not reached.`,inspect(req.query, false, 3, true))
		return res.status(400).json({success: false, error: 'The minimum amount was not reached.'})
	}


	const paymentRequirements = [createBeamioExactPaymentRequirements(
		amount,
		resource,
		`Beamio Transfer`,
		toAddress
	)]

	const isValid = await verifyPaymentNew(req, res, paymentRequirements)

	if (!isValid) {
		logger(`${_routerName} !isValid ERROR!`)
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
			const amount = authorization.value
			const record = {
				from, to, amount, finishedHash: responseData?.transaction, note: note||''
			}
			transferRecord.push(record)
			logger(inspect(record, false, 3, true))
			transferRecordProcess()
		}
		
		return 
			
	} catch (ex: any) {
		console.error("Payment settlement failed:", ex.message)
		res.status(500).end()
	}
	
}

const transferRecord: {
	from: string
	to: string
	amount: string
	finishedHash: string
	note: string
}[] = []

const transferRecordProcess = async () => {
	const obj = transferRecord.shift()
	if (!obj) {
		return
	}
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		transferRecord.unshift()
		return setTimeout(() => {
			transferRecordProcess()
		}, 2000)
	}

	try {
		const tx = await SC.conetSC.transferRecord(
			obj.from,
			obj.to,
			obj.amount,
			obj.finishedHash,
			obj.note
		)
		await tx.wait()
	} catch (ex: any) {
		logger(`transferRecordProcess Error!`, ex.message, inspect(obj, false, 3, true))
	}

	Settle_ContractPool.push(SC)
	setTimeout(() => {transferRecordProcess()}, 1000)
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



const conet_chainID = '224400'
const conet_USDC = '0x43b25Da1d5516E98D569C1848b84d74B4b8cA6ad'
const conet_USDC_DECIMALS = 18
const testInConet = async () => {
	// const kk = await AuthorizationSign ("20", CashCodeCoNETAddr, masterSetup.settle_contractAdmin[0], conet_USDC_DECIMALS, conet_chainID, conet_USDC)
	// const hash = generateCODE('')
	// logger({kk, hash})
	// await AuthorizationCallUSDC(kk)
	// await AuthorizationCallCashCode(kk, hash.hash, conet_USDC)

	//getHashDetail('0xb42de32faf01df3b795a5914fdc43b56aa7d2253810e977246a960bd4ae8897e')
	await withdrawWithCode('2msGwbQsERCVqwQ14TzRTb', '', '0xD36Fc9d529B9Cc0b230942855BA46BC9CA772A88')
}

const testInBase = async () => {
	const kk = await AuthorizationSign ("0.11", beamioConet, masterSetup.settle_contractAdmin[0], USDC_Base_DECIMALS, conet_chainID, conet_USDC)
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

	const baseClient = createPublicClient({chain: base, transport: http(getRandomNode())})
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

	const baseClient = createPublicClient({chain: base, transport: http(`http://${getRandomNode()}/base-rpc`)})
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
	logger(inspect(oracle, false, 3, true))
	return oracle
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

//			FaucetUser for USDC 

const FaucetUser:string[] = []
const FaucetIPAddress: string[] = []
const FaucetUserPool: {
	wallet: string
	ipaddress: string
}[] = []

export const BeamioFaucet = async (req: Request, res: Response) => {
	let ipaddress = getClientIp(req)

	const { address } = req.query as {
		address?: string
	}
	if (!address || address === ethers.ZeroAddress || !ethers.isAddress(address)) {
		logger(`BeamioFaucet Error@! !address || address === ethers.ZeroAddress || !ethers.isAddress(${address})`)
		return res.status(403).end()
	}
	
	const walletAddress = address.toLowerCase()
	const SC = Settle_ContractPool[0]
	const realIpAddress = /73.189.157.190/.test(ipaddress) ? uuid62.v4() : ipaddress

	if (FaucetUser.indexOf(walletAddress)  > -1 || !realIpAddress || FaucetIPAddress.indexOf(realIpAddress) > -1 ) {
		logger(`BeamioFaucet ${walletAddress}:${realIpAddress} already!`)
		return res.status(403).end()
	}

	

	
	
	FaucetIPAddress.push(realIpAddress)
	FaucetUser.push(walletAddress)
		
		try {
			const isNew = await SC.conetAirdrop.mayAirdrop(walletAddress, realIpAddress)
			
			if (isNew) {
				logger(`BeamioFaucet ${walletAddress}:${realIpAddress} added to Pool!`)
				res.status(200).json({success: true}).end()
				FaucetUserPool.push({
					wallet: walletAddress,
					ipaddress: realIpAddress
				})
				processUSDC_Faucet()
				return
			}
			res.status(403).end()
			return logger(`BeamioFaucet ${walletAddress}:${realIpAddress} already in mayAirdrop !!`)
		} catch (ex: any) {
			logger(`BeamioFaucet call faucetClaimed error! ${ex.message}`)
			
		}
	

	res.status(500).end()
	logger(`BeamioFaucet ${walletAddress}:${realIpAddress} error`)
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

export const BeamioETHFaucetTry = async (address: string) => {
	const _address = address.toLowerCase()
	const index = totalFaucetETHRecord.indexOf(_address)
	if (index > -1) {
		return
	}
	const SC = Settle_ContractPool[0]
	try {
		const isClaimed = await SC.conetSC.faucetClaimed(_address)
		if (isClaimed) {
			return
		}
	} catch (ex: any) {
		logger(` await SC.conetSC.faucetClaimed(${_address}) Error, ${ex.message}`)
		return
	}
	waitingFaucetUserProcessPool.push(_address)
}

export const BeamioETHFaucet = async (req: Request, res: Response) => {
	let { address } = req.query as {
		address?: string
	}
	if (!address || !ethers.isAddress(address) || ethers.ZeroAddress === address) {
		return res.status(404).end()
	}

	const _address = address.toLowerCase()
	const index = totalFaucetETHRecord.indexOf(_address)
	if (index > -1) {
		return res.status(403).end()
	}

	const SC = Settle_ContractPool[0]
	try {
		const isClaimed = await SC.conetSC.faucetClaimed(_address)
		if (isClaimed) {
			return res.status(403).end()
		}
	} catch (ex: any) {
		logger(` await SC.conetSC.faucetClaimed(${_address}) Error, ${ex.message}`)
		return res.status(500).json({success: false}).end()
	}
	waitingFaucetUserProcessPool.push(_address)
	res.status(200).end()
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

