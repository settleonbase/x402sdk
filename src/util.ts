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
import {v4} from 'uuid'
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

const setupFile = join( homedir(),'.master.json' )



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
    bnb: 0,
    eth: 0,
	usdc: 0
}

let oracolPriceProcess = false
const oracolPrice = async () => {
	if (oracolPriceProcess) {
		return
	}
	oracolPriceProcess = true
	const assets = ['bnb', 'eth', 'usdc']
	const process: any[] = []
	assets.forEach(n =>{
		process.push (oracleSC.GuardianPrice(n))
	})

	const price = await Promise.all(process)
	const bnb = ethers.formatEther(price[0])
	const eth = ethers.formatEther(price[1])
	const usdc = ethers.formatEther(price[2])
	logger(`oracolPrice BNB ${bnb} ETH ${eth} USDC ${usdc}`)
	oracle.bnb = parseFloat(bnb)
	oracle.eth = parseFloat(eth)
	oracle.usdc = parseFloat(usdc)
	oracolPriceProcess = false
}

const oracleBackoud = async () => {
	await getAllNodes()
	Settle_ContractPool = masterSetup.settle_contractAdmin.map(n => {

		const account = privateKeyToAccount('0x' + n as `0x${string}`)
		const walletClientBase = createWalletClient({
			account,
			chain: base,
			transport: http(`http://${getRandomNode()}/base-rpc`),
		})
		

		const walletBase = new ethers.Wallet(n, providerBase)
		const walletConet = new ethers.Wallet(n, providerConet)
		logger(`address => ${walletBase.address}`)

		return {
			baseWalletClient: walletClientBase,
			baseSC: new ethers.Contract(CashCodeBaseAddr, CoinCodeABI, walletBase),
			baseUSDC: new ethers.Contract(USDCContract_BASE, USDC_ABI, walletBase),
			conetUSDC: new ethers.Contract(USDC_conet, USDC_ABI, walletConet),
			conetSC: new ethers.Contract(conet_CashCodeNote, CashcodeNode_abi, walletConet),
			event: new ethers.Contract(eventContract, Event_ABI, walletConet),
		}
	})

	oracolPrice()
	providerConet.on('block', async (blockNumber) => {

		if (blockNumber % 20 !== 0) {
			return
		}

		logger(`Oracle backoud blockNumber ${blockNumber}`)
		await oracolPrice()
		logger(`Oracle Price BNB ${oracle.bnb} ETH ${oracle.eth}`)
	})

}

const providerBase = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const providerConet = new ethers.JsonRpcProvider(conetEndpoint)
const oracleSC = new ethers.Contract(oracleSC_addr, GuardianOracle_ABI, providerConet)

let Settle_ContractPool: any[] = []

function createExactPaymentRequirements(
		price: Price,
		resource: Resource,
		description = "",
		payto = CashCodeBaseAddr
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
			maxTimeoutSeconds: 60,
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
			paymentRequirements = [createExactPaymentRequirements(
				amount,
				resource,
				`Cashcode Payment Request`,
				//@ts-ignore
				decodedPayment.payload.authorization.to
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

		logger(`verifyPayment catch error!`)

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

	

	const paymentRequirements = [createExactPaymentRequirements(
		amount,
		resource,
		`Cashcode Payment Request`,
		CashCodeBaseAddr
	)]

	const isValid = await verifyPaymentNew(req, res, paymentRequirements)

	if (!isValid) {
		logger(`${_routerName} !isValid ERROR!`)
		return 
	}

	let responseData: x402SettleResponse

	const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
	const saleRequirements = paymentRequirements[0]

	const isValidPaymentHeader = checkx402paymentHeader(paymentHeader as x402paymentHeader, price, CashCodeBaseAddr)

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

	const { amount, toAddress } = req.query as {
		amount?: string
		toAddress?: string
	}

	const _price = amount|| '0'
	const price = ethers.parseUnits(_price, USDC_Base_DECIMALS)
	
	if ( !amount || price <=0 || !ethers.isAddress(toAddress)) {
		logger(`${_routerName} Error! The minimum amount was not reached.`,inspect(req.query, false, 3, true))
		return res.status(400).json({success: false, error: 'The minimum amount was not reached.'})
	}


	const paymentRequirements = [createExactPaymentRequirements(
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

	const isValidPaymentHeader = checkx402paymentHeader(paymentHeader as x402paymentHeader, price, CashCodeBaseAddr)

	if (!isValidPaymentHeader) {
		logger(`${_routerName} checkx402paymentHeader Error!`,inspect(paymentHeader))
		return res.status(402).end()
	}

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


			
	} catch (ex: any) {
		console.error("Payment settlement failed:", ex.message)
	}

	logger(inspect(payload, false, 3, true))

	// processToBase.push({
	// 	from: payload.authorization.from,
	// 	erc3009Addr: USDCContract_BASE,
	// 	value: payload.authorization.value,
	// 	validAfter: payload.authorization.validAfter,
	// 	validBefore: payload.authorization.validBefore,
	// 	nonce: payload.authorization.nonce,
	// 	signature: payload.signature,
	// 	hash: hash,
	// 	note: note||'',
	// 	res
	// })

	// processCheck()



}

const generateCODE = (passcode: string) => {
	const code = uuid62.v4()
	const hash = ethers.solidityPackedKeccak256(['string', 'string'], [code, passcode])
	return ({
		code, hash
	})
	
}



type AuthorizationPayload = {
	from: string;
	to: string;
	value: bigint;
	validAfter: bigint;
	validBefore: bigint;
	nonce: `0x${string}`;
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
	const validBefore = now      // 1 分钟有效

	// 3) 随机 nonce（bytes32）
	const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`

	// 4) EIP-712 域 & 类型 & 数据（与你合约里的 TYPEHASH 字段严格一致）
	const domain = {
		name: "USDC",          // ERC20Permit(name) -> 你的合约构造里是 "USDC"
		version: "1",          // OpenZeppelin ERC20Permit 的默认版本是 "1"
		chainId: CHAIN_ID,     // 必须与链实际 ID 一致
		verifyingContract: TOKEN_ADDRESS,
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
		from,
		to,
		value,
		validAfter,
		validBefore,
		nonce,
		signature,
	}
}

const AuthorizationCallUSDC = async (data: AuthorizationPayload) => {
	const SC = Settle_ContractPool[0]
	try {
		const tx = await SC.conetUSDC.transferWithAuthorization(
			data.from,
			data.to,
			data.value,
			data.validAfter,
			data.validBefore,
			data.nonce,
			data.signature
		)
		await tx.wait()
		logger(`AuthorizationCall success ${tx.hash}`)
	} catch (ex: any) {
		logger(`Error! ${ex.message}`)
	}
}

const AuthorizationCallCashCode = async (data: AuthorizationPayload, hash: string, erc3009Addr: string) => {
	const SC = Settle_ContractPool[0]
	try {
		const tx = await SC.conetSC.depositWith3009Authorization(
			data.from,
			erc3009Addr,
			data.value,
			data.validAfter,
			data.validBefore,
			data.nonce,
			data.signature,
			hash
		)
		await tx.wait()
		logger(`AuthorizationCallCashCode success ${tx.hash}`)
	} catch (ex: any) {
		logger(`AuthorizationCallCashCode Error! ${ex.message}`)
	}
}

const getHashDetail = async (hash: string) => {
	const SC = Settle_ContractPool[0]
	try {
		const tx = await SC.conetSC.hashAmount(hash)
		
		logger(inspect(tx, false, 3, true))
	} catch (ex: any) {
		logger(`getHashDetail Error! ${ex.message}`)
	}
}

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
	const kk = await AuthorizationSign ("0.11", CashCodeBaseAddr, masterSetup.settle_contractAdmin[0], USDC_Base_DECIMALS, conet_chainID, conet_USDC)
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

		baseHash = await SC.baseWalletClient.writeContract({
			address: CashCodeBaseAddr,
			abi: CoinCodeABI,
			functionName: 'depositWith3009Authorization',
			args: [obj.from, USDCContract_BASE, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature, obj.hash]
		})




		// const tx = await SC.baseSC.depositWith3009Authorization(
		// 	obj.from,
		// 	USDCContract_BASE,
		// 	obj.value,
		// 	obj.validAfter,
		// 	obj.validBefore,
		// 	obj.nonce,
		// 	obj.signature,
		// 	obj.hash
		// )
		
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

		const baseHash = await SC.baseWalletClient.writeContract({
			address: CashCodeBaseAddr,
			abi: CoinCodeABI,
			functionName: 'withdrawWithCode',
			args: [obj.code, obj.address]
		})

		// const tx = await SC.baseSC.withdrawWithCode(obj.code, obj.address)


		const tr = await SC.conetSC.finishedCheck(
			hash,
			baseHash,
			obj.address
		)

		await Promise.all([
			baseClient.waitForTransactionReceipt({ hash: baseHash }),
			tr.wait()
		])

		obj.res.status(200).json({success: true, USDC_tx: baseHash}).end()
		logger(`processCheckWithdraw success! BASE = ${baseHash} CONET = ${tr.hash}`)
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

		const baseHash = await SC.baseWalletClient.writeContract({
			address: USDCContract_BASE,
			abi: USDC_ABI,
			functionName: 'transferWithAuthorization',
			args: [obj.from, obj.isSettle ? SETTLEContract: CashCodeBaseAddr, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature]
		})

		// const tx = await SC.usdc.transferWithAuthorization(
		// 	obj.from, SETTLEContract, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature
		// )

		const baseClient = createPublicClient({chain: base, transport: http(`http://${getRandomNode()}/base-rpc`)})
		// await tx.wait()
		await baseClient.waitForTransactionReceipt({ hash: baseHash })

		logger(`facilitators success! ${baseHash}`)

		const ret: x402Response = {
			success: true,
			payer: wallet,
			USDC_tx: baseHash,
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
		
		await process_x402()
		return setTimeout(() => facilitators(), 1000)

	} catch (ex: any) {
		logger(`facilitators Error!`, ex.message)
	}

	//	transferWithAuthorization

	Settle_ContractPool.push(SC)
	setTimeout(() => facilitators(), 1000)
}

export const process_x402 = async () => {
	console.debug(`process_x402`)
	const obj = x402ProcessPool.shift()
	if (!obj) {
		return
	}

	const SC = Settle_ContractPool.shift()
	if (!SC) {
		logger(`process_x402 got empty Settle_testnet_pool`)
		x402ProcessPool.unshift(obj)
		return
	}
	const baseClient = createPublicClient({chain: base, transport: http(`http://${getRandomNode()}/base-rpc`)})
	try {

		const baseHash = await SC.baseWalletClient.writeContract({
			address: SETTLEContract,
			abi: Settle_ABI,
			functionName: 'mint',
			args: [obj.wallet, obj.settle]
		})
		await baseClient.waitForTransactionReceipt({ hash: baseHash })

		// const tx = await SC.base.mint(
		// 	obj.wallet, obj.settle
		// )

		// await tx.wait()

		const SETTLE = BigInt(obj.settle) * MINT_RATE / USDC_decimals


		
		const ts = await SC.event.eventEmit(
			obj.wallet, obj.settle, SETTLE, baseHash
		)

		await ts.wait()

		reflashData.unshift({
			wallet: obj.wallet,
			hash: baseHash,
			USDC: obj.settle,
			timestmp: new Date().toUTCString(),
			SETTLE: SETTLE.toString(),
		})

		logger(`process_x402 success! ${baseHash}`)

	} catch (ex: any) {
		logger(`Error process_x402 `, ex.message)
		x402ProcessPool.unshift(obj)
	}

	Settle_ContractPool.push(SC)
	setTimeout(() => process_x402(), 1000)

}



let lastGasEstimate:
  | { data: { gas: string; price: string; ethPrice: number }; ts: number }
  | null = null

// 当前是否有进行中的估算请求（用 Promise 复用同一次调用）
let pendingEstimate:
  | Promise<{ gas: string; price: string; ethPrice: number }>
  | null = null





export const estimateErc20TransferGas = async (
	usdc: string,
	RecipientAddress: string,
	fromAddress: string
) => {
  const now = Date.now()

  // 1）有 15 秒内的缓存 → 直接返回
  if (lastGasEstimate && (now - lastGasEstimate.ts) < 15_000) {
    return lastGasEstimate.data
  }

  // 2）如果已经有进行中的 RPC 调用 → 等待 1 秒，然后复用它的结果
  if (pendingEstimate) {
    // 等待 1 秒（你要求的延迟）
    await new Promise(resolve => setTimeout(resolve, 1_000))

    // 再次检查：如果 1 秒内 RPC 完成了，缓存就应该是最新的
    if (lastGasEstimate && (Date.now() - lastGasEstimate.ts) < 15_000) {
      return lastGasEstimate.data
    }

    // 如果缓存还是没更新，就直接等待那次进行中的调用完成
    try {
      const data = await pendingEstimate
      return data
    } catch {
		return null
    }
  }

  // 3）没有缓存、也没有进行中的请求 → 发起新的 RPC 调用
  const node = getRandomNode()
  const baseClient = createPublicClient({
    chain: base,
    transport: http(`http://${node}/base-rpc`)
	// transport: http(`http://94.143.138.27/base-rpc`)
  })

  pendingEstimate = (async () => {
    const [gas, price] = await Promise.all([
      baseClient.estimateContractGas({
        address: USDCContract_BASE,
        abi: USDC_ABI,
        functionName: 'transfer',
        account: fromAddress as `0x${string}`,
        args: [
          RecipientAddress,
          ethers.parseUnits(usdc, 6)
        ]
      }),
      baseClient.getGasPrice()
    ])

	if (typeof gas !== 'bigint' || typeof price !== 'bigint' || !price || !gas) {
		const error = new Error(`Node = ${node} return null result! gas = ${gas} price = ${price}`)
		logger(error)
		throw(error)
	}

    const result = {
      gas: gas.toString(),
      price: price.toString(),
      ethPrice: oracle.eth
    }

	logger(inspect(result, false, 3, true))
    // 写入缓存
    lastGasEstimate = {
      data: result,
      ts: Date.now()
    }

    return result
  })()

  try {
    const data = await pendingEstimate
    return data
  } catch(ex: any) {
		logger(ex.message)
  }
   finally {
    // 这次调用结束后，清空 pending 状态
    pendingEstimate = null
  }
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

export const getBalance = async (address: string) => {
  const now = Date.now()
  const cached = balanceCache[address]

  // 若有缓存，且时间在 60 秒内 → 直接返回缓存
  if (cached && (now - cached.ts) < 60_000) {
    return cached.data
  }




  // =============================
  //      实际调用 RPC
  // =============================
  const baseClient = createPublicClient({
    chain: base,
	//transport: http(`http://${getRandomNode()}/base-rpc`)
	transport: http(`http://94.143.138.27/base-rpc`)
  })

  const baseEthers = new ethers.JsonRpcProvider('')
  const SC = new ethers.Contract(USDCContract_BASE, USDC_ABI, baseEthers)

  try {
    // const [usdcRaw, ethRaw] = await Promise.all([
    //   baseClient.readContract({
    //     address: USDCContract_BASE,
    //     abi: USDC_ABI,
    //     functionName: 'balanceOf',
    //     args: [address]
    //   }),
    //   providerBase.getBalance(address)
    // ])

	 const [usdcRaw, ethRaw] = await Promise.all([
		SC.balanceOf (address),
		baseEthers.getBalance(address)
	 ])
	

    const usdc = ethers.formatUnits(usdcRaw as bigint, 6)
    const eth = ethers.formatUnits(ethRaw, 18)

    const result = { usdc, eth, oracle: {eth: oracle.eth, usdc: oracle.usdc} }
	logger(inspect(result, false, 3, true))
    // 记忆：写入缓存
    balanceCache[address] = {
      data: result,
      ts: now
    }

    return result
  } catch (ex: any) {
    logger(`baseUSDC.balanceOf Error!`, ex.message)
    return null
  }
}

const test = async () => {
	const SC = Settle_ContractPool[0]
	try {
		const ba = await SC.baseUSDC.balanceOf(USDC_conet)
		const bas = ethers.formatUnits(ba, 6)
		logger (`Balance ${bas}`)
	} catch (ex: any) {
		logger(`baseUSDC.balanceOf Error!`, ex.message)
	}
}

oracleBackoud()


const test1 = async () => {

	const ba = await getBalance('0xC8F855Ff966F6Be05cD659A5c5c7495a66c5c015')
	logger(`getBalance`, inspect(ba, false, 3, true))
}

const test2 = async () => {
	const kkk = await estimateErc20TransferGas('0.1', '0xD36Fc9d529B9Cc0b230942855BA46BC9CA772A88', '0xC8F855Ff966F6Be05cD659A5c5c7495a66c5c015')
	logger(inspect(kkk, false, 3, true))
}
// setTimeout(() => test1(), 5000)
// setTimeout(() => {test2()}, 2000)