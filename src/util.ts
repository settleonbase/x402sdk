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




const setupFile = join( homedir(),'.master.json' )
export const masterSetup: IMasterSetup = require ( setupFile )

const facilitator1 = createFacilitatorConfig(masterSetup.base.CDP_API_KEY_ID,masterSetup.base.CDP_API_KEY_SECRET)

const x402Version = 1

const CashCodeBaseAddr = '0xfFDc8d2021A41F4638Cb3eCf58B5155383EE9f6d'
const USDCContract_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_Base_DECIMALS = 6

const USDC_conet = '0x43b25Da1d5516E98D569C1848b84d74B4b8cA6ad'
const CashCodeCoNETAddr = '0xa7f37538de716e84e3ee3a9b51d675564b7531b3'
const baseProvider = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const conetEndpoint = new ethers.JsonRpcProvider('https://mainnet-rpc.conet.network')
const conet_CashCodeNote = '0xCe1F36a78904F9506E5cD3149Ce4992cC91385AF'

const {verify, settle} = useFacilitator(facilitator1)

const Settle_ContractPool = masterSetup.settle_contractAdmin.map(n => {
	const admin_base = new ethers.Wallet(n, baseProvider)
	const admin_conet = new ethers.Wallet(n, conetEndpoint)

	logger(`address ${admin_base.address} added to Settle_ContractPool`)
	return {
		baseSC: new ethers.Contract(CashCodeBaseAddr, CoinCodeABI, admin_base),
		baseUSDC: new ethers.Contract(USDCContract_BASE, USDC_ABI, admin_base),
		conetUSDC: new ethers.Contract(USDC_conet, USDC_ABI, admin_conet),
		conetSC: new ethers.Contract(conet_CashCodeNote, CashcodeNode_abi, admin_conet),

	}
})

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

async function verifyPayment (
		req: Request,
		res: Response,
		paymentRequirements: PaymentRequirements[],
	): Promise<boolean> {
	const payment = req.header("X-PAYMENT")

	if (!payment) {
		logger(`verifyPayment send x402 payment information`)
		res.status(402).json({
			x402Version,
			error: "X-PAYMENT header is required",
			accepts: paymentRequirements,
		});
		return false;
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
		return false
	}

	try {
		const selectedPaymentRequirement =
			findMatchingPaymentRequirements(paymentRequirements, decodedPayment) ||
			paymentRequirements[0];
		const response = await verify(decodedPayment, selectedPaymentRequirement)
		
		if (!response.isValid) {
			logger(`verifyPayment verify decodedPayment Erro!`)
			res.status(402).json({
				x402Version,
				error: response.invalidReason,
				accepts: paymentRequirements,
				payer: response.payer,
			})
			return false
		}

	} catch (error) {

		logger(`verifyPayment catch error!`)

		res.status(402).json({
			x402Version,
			error,
			accepts: paymentRequirements,
		});
		return false
	}

	return true
}


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

	const isValid = await verifyPayment(req, res, paymentRequirements)

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
	try {
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
		
		await tx.wait()
		logger(`processCheck BASE success! ${tx.hash}`)
		const rx = await SC.conetSC.checkMemoGenerate(
			obj.hash,
			obj.from,
			obj.value,
			tx.hash,
			'8453',
			USDCContract_BASE,
			'6',
			obj.note
		)
		await rx.wait()
		obj.res.status(200).json({success: true, USDC_tx: tx.hash}).end()
		logger(`processCheck CONET success! ${rx.hash}`)

	} catch (ex: any) {
		obj.res.status(404).json({error: 'CashCode Server Error'}).end()
		logger(`processCheck Error! ${ex.message}`)
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

const test2 = async () => {
	const SC = Settle_ContractPool[0]
	const code = '19SD0VZvAJt8u23KaHW2Xx'+ '111111'
	const hash = ethers.solidityPackedKeccak256(['string'], [code])
	try {
		// const tx = await SC.baseSC.withdrawWithCode(code, '0x18d5a44dbb1d88af9f1cc7dbbf57851c0c65d0ea')
		// await tx.wait()	
		// logger(`success! tx = ${tx.hash}`)
		const tx = await SC.conetSC.finishedCheck(

			hash,
			'0x589ec100fd5d5844828c1381abb9420cc711fc00ab1c740c18427cf325e406da'
		)
		await tx.wait()
		logger(`success! tx = ${tx.hash}`)
	}catch (ex: any) {
		logger('error', ex.message)
	}
}
test2()
