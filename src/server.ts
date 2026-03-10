import express from 'express'
import type { Server } from 'node:http'
import { request } from 'node:https'
import type {RequestOptions} from 'node:https'
import { join, resolve } from 'node:path'
import Colors from 'colors/safe'
import { inspect } from 'node:util'
import {logger} from './logger'

import {ethers, Wallet} from 'ethers'
import os from 'node:os'
import fs from 'node:fs'
import { useFacilitator } from "x402/verify"
import {masterSetup, cashcode_request, cashcode_check, facilitators, facilitatorsPool, x402ProcessPool, MINT_RATE, BeamioFaucet, generateCheck, redeemCheck,
	BeamioTransfer, getOracleRequest, verifyPaymentNew, BeamioPaymentLink, BeamioPaymentLinkFinishRouteToSC, BeamioETHFaucet, getClientIp, oracleBackoud, BeamioPayMeRouteToSC
} from './util'
import { facilitator, createFacilitatorConfig } from "@coinbase/x402"
import { exact } from "x402/schemes";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  Price,
  Resource,
  settleResponseHeader,
} from "x402/types"
import { processPriceToAtomicAmount, findMatchingPaymentRequirements } from "x402/shared";
import {coinbaseToken, coinbaseOfframp} from './coinbase'
import { searchUsers, addUser} from './db'
import { verifyBeamioSunRequest } from './BeamioSun'


const facilitator1 = createFacilitatorConfig(masterSetup.base.CDP_API_KEY_ID,masterSetup.base.CDP_API_KEY_SECRET)
const {verify, settle} = useFacilitator(facilitator1)

const SETTLEContract = '0x20c84933F3fFAcFF1C0b4D713b059377a9EF5fD1'

const x402Version = 1

function createExactPaymentRequirements(
		price: Price,
		resource: Resource,
		description = "",
		payto = SETTLEContract
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
	};
}


// ============================================
// checkSig 函数：验证签名并获取 { v, r, s }
// ============================================
const checkSig = (ercObj: any): {
  v: number
  r: string
  s: string
  recoveredAddress: string
  isValid: boolean
} | null => {
  try {
    // 基础字段校验
    if (!ercObj || !ercObj.sig || !ercObj.EIP712) {
      console.log('❌ Invalid ercObj: missing sig or EIP712')
      return null
    }

    const sigRaw: string = ercObj.sig
    const eip712: any = ercObj.EIP712
    const message: any = eip712?.message || {}

    // 时间窗口校验（如果你的业务不需要，可移除）
    const now = Math.floor(Date.now() / 1000)
    const validAfter = BigInt((message?.validAfter ?? 0).toString())
    const validBefore = BigInt((message?.validBefore ?? 0).toString())
    if (now < Number(validAfter)) {
      console.log(`❌ Signature not yet valid: now=${now}, validAfter=${validAfter}`)
      return null
    }
    if (now > Number(validBefore)) {
      console.log(`❌ Signature expired: now=${now}, validBefore=${validBefore}`)
      return null
    }

    // 规范化 domain（ethers v6：chainId 推荐 number/bigint）
    const domain = {
      name: eip712?.domain?.name,
      version: eip712?.domain?.version,
      chainId:
        typeof eip712?.domain?.chainId === 'string'
          ? Number(eip712.domain.chainId)
          : eip712?.domain?.chainId,
      verifyingContract: eip712?.domain?.verifyingContract
    }

    // 规范化 types：可能是对象，也可能被序列化为字符串
    const typesObj: Record<string, Array<{ name: string; type: string }>> =
      typeof eip712?.types === 'string'
        ? JSON.parse(eip712.types)
        : (eip712?.types as any)

    if (!typesObj || typeof typesObj !== 'object') {
      console.log('❌ EIP712.types is not a valid object')
      return null
    }

    // —— 首选：verifyTypedData（最高容错） ——
    try {
      const recovered = ethers.verifyTypedData(domain as any, typesObj as any, message, sigRaw)
      const isValid = recovered?.toLowerCase?.() === message?.from?.toLowerCase?.()
      if (isValid) {
        // 拆分 v/r/s 以便后续链上使用
        const normalizedSig = sigRaw.startsWith('0x') ? sigRaw : ('0x' + sigRaw)
        const sig = ethers.Signature.from(normalizedSig)
        // v 规范化到 27/28（有些钱包返回 0/1）
        
		let v: number = Number(sig.v)
		if (v === 0 || v === 1) v += 27

        console.log(`✅ verifyTypedData OK. recovered=${recovered}`)
        return {
          v,
          r: sig.r,
          s: sig.s,
          recoveredAddress: recovered,
          isValid: true
        }
      } else {
        console.log(`⚠️ verifyTypedData recovered=${recovered}, expected=${message?.from}`)
        // 继续走 fallback
      }
    } catch (e: any) {
      console.log(`⚠️ verifyTypedData failed: ${e?.message || String(e)}`)
      // 继续走 fallback
    }

    // —— fallback：手工 hash + recoverAddress ——

    // 1) 规范化签名并拆分 v/r/s
    let hex = sigRaw.startsWith('0x') ? sigRaw : ('0x' + sigRaw)
    if (hex.length !== 132) {
      console.log(`⚠️ Unusual signature length=${hex.length}, still attempting recovery`)
      // 尽力而为，不直接退出
    }
    const r = '0x' + hex.slice(2, 66)
    const s = '0x' + hex.slice(66, 130)
    let v = parseInt(hex.slice(130, 132) || '1b', 16) // 默认 0x1b(27)
    if (v === 0 || v === 1) v += 27
    if (v !== 27 && v !== 28) console.log(`⚠️ Unusual v=${v} after normalization`)

    // 2) 规范化 message（数值字段使用 BigInt，更符合 v6 编码）
    const msgForHash: any = {
      from: message.from,
      to: message.to,
      value: BigInt(message.value?.toString?.() ?? message.value ?? 0),
      validAfter: BigInt(message.validAfter?.toString?.() ?? message.validAfter ?? 0),
      validBefore: BigInt(message.validBefore?.toString?.() ?? message.validBefore ?? 0),
      nonce: message.nonce
    }

    // 3) 计算 digest
    let digest: string
    try {
      digest = ethers.TypedDataEncoder.hash(domain as any, typesObj as any, msgForHash)
      console.log(`📋 digest=${digest}`)
    } catch (e: any) {
      console.log(`❌ TypedDataEncoder.hash error: ${e?.message || String(e)}`)
      return null
    }

    // 4) 恢复地址
    let recoveredAddress: string
    try {
      recoveredAddress = ethers.recoverAddress(digest, { v, r, s })
      console.log(`✅ fallback recovered=${recoveredAddress}`)
    } catch (e: any) {
      console.log(`❌ recoverAddress error: ${e?.message || String(e)}`)
      return null
    }

    const isValid = recoveredAddress?.toLowerCase?.() === message?.from?.toLowerCase?.()
    if (!isValid) {
      console.log(`❌ INVALID signature. expected=${message?.from}, got=${recoveredAddress}`)
    }

    return { v, r, s, recoveredAddress, isValid }
  } catch (err: any) {
    console.log(`❌ checkSig fatal error: ${err?.message || String(err)}`)
    return null
  }
}


const MAX_BODY_SIZE = 5 * 1024 * 1024 // 5MB

const initialize = async (reactBuildFolder: string, PORT: number, setupRoutes: (router: any) => void) => {
	console.log('🔧 Initialize called with PORT:', PORT, 'reactBuildFolder:', reactBuildFolder)
	

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

	// app.use(paymentMiddleware(
	// 	owner, 
	// 	{
	// 		"GET /api/weather": {
	// 			price: "$0.001",
	// 			network: "base",
	// 			config: {
	// 				discoverable: true,
	// 				description: "SETTLE: MINTS THAT SETTLE_ON BASE",
	// 				inputSchema: {
	// 					queryParams: {
							
	// 					}
	// 				},
	// 				outputSchema: {
	// 					type: "object",
	// 					properties: { 
	// 						temperature: { type: "number" },
	// 						conditions: { type: "string" },
	// 						humidity: { type: "number" }
	// 					}
	// 				}
	// 			}
	// 		},
	// 		"GET /api/settle0001": {
	// 			price: "$0.001",
	// 			network: "base",
	// 			config: {
	// 				discoverable: true,
	// 				description: "SETTLE: MINTS THAT SETTLE_ON BASE",
	// 				inputSchema: {
	// 					queryParams: {
							
	// 					}
	// 				},
	// 				outputSchema: {
	// 					type: "object",
	// 					properties: { 
	// 						temperature: { type: "number" },
	// 						conditions: { type: "string" },
	// 						humidity: { type: "number" }
	// 					}
	// 				}
	// 			}
	// 		},
	// 		"GET /api/settle001": {
	// 			price: "$0.01",
	// 			network: "base",
	// 			config: {
	// 				discoverable: true,
	// 				description: "SETTLE: MINTS THAT SETTLE_ON BASE",
	// 				inputSchema: {
	// 					queryParams: {
							
	// 					}
	// 				},
	// 				outputSchema: {
	// 					type: "object",
	// 					properties: { 
	// 						temperature: { type: "number" },
	// 						conditions: { type: "string" },
	// 						humidity: { type: "number" }
	// 					}
	// 				}
	// 			}
	// 		},
	// 		"GET /api/settle01": {
	// 			price: "$0.1",
	// 			network: "base",
	// 			config: {
	// 				discoverable: true,
	// 				description: "SETTLE: MINTS THAT SETTLE_ON BASE",
	// 				inputSchema: {
	// 					queryParams: {
							
	// 					}
	// 				},
	// 				outputSchema: {
	// 					type: "object",
	// 					properties: { 
	// 						temperature: { type: "number" },
	// 						conditions: { type: "string" },
	// 						humidity: { type: "number" }
	// 					}
	// 				}
	// 			}
	// 		},
	// 		"GET /api/settle1": {
	// 			price: "$1.00",
	// 			network: "base",
	// 			config: {
	// 				discoverable: true,
	// 				description: "SETTLE: MINTS THAT SETTLE_ON BASE",
	// 				inputSchema: {
	// 					queryParams: {
							
	// 					}
	// 				},
	// 				outputSchema: {
	// 					type: "object",
	// 					properties: { 
	// 						temperature: { type: "number" },
	// 						conditions: { type: "string" },
	// 						humidity: { type: "number" }
	// 					}
	// 				}
	// 			}
	// 		},
	// 		"GET /api/settle10": {
	// 			price: "$10.00",
	// 			network: "base",
	// 			config: {
	// 				discoverable: true,
	// 				description: "SETTLE: MINTS THAT SETTLE_ON BASE",
	// 				inputSchema: {
	// 					queryParams: {
							
	// 					}
	// 				},
	// 				outputSchema: {
	// 					type: "object",
	// 					properties: { 
	// 						temperature: { type: "number" },
	// 						conditions: { type: "string" },
	// 						humidity: { type: "number" }
	// 					}
	// 				}
	// 			}
	// 		},
	// 		"GET /api/settle100": {
	// 			price: "$100.00",
	// 			network: "base",
	// 			config: {
	// 				discoverable: true,
	// 				description: "SETTLE: MINTS THAT SETTLE_ON BASE",
	// 				inputSchema: {
	// 					queryParams: {
							
	// 					}
	// 				},
	// 				outputSchema: {
	// 					type: "object",
	// 					properties: { 
	// 						temperature: { type: "number" },
	// 						conditions: { type: "string" },
	// 						humidity: { type: "number" }
	// 					}
	// 				}
	// 			}
	// 		}
	// 	},
	// 	facilitator1
	// ))

	const router = express.Router ()

	app.use( '/api', router )
	setupRoutes(router)

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

async function verifyPayment(
		req: express.Request,
		res: express.Response,
		paymentRequirements: PaymentRequirements[],
	): Promise<boolean> {
	const payment = req.header("X-PAYMENT");
	if (!payment) {
		res.status(402).json({
			x402Version,
			error: "X-PAYMENT header is required",
			accepts: paymentRequirements,
		});
		return false;
	}

	let decodedPayment: PaymentPayload;
	try {
		decodedPayment = exact.evm.decodePayment(payment);
		decodedPayment.x402Version = x402Version;
	} catch (error) {
		res.status(402).json({
		x402Version,
		error: error || "Invalid or malformed payment header",
		accepts: paymentRequirements,
		});
		return false;
	}

	try {
		const selectedPaymentRequirement =
			findMatchingPaymentRequirements(paymentRequirements, decodedPayment) ||
			paymentRequirements[0];
		const response = await verify(decodedPayment, selectedPaymentRequirement)

		if (!response.isValid) {
			res.status(402).json({
				x402Version,
				error: response.invalidReason,
				accepts: paymentRequirements,
				payer: response.payer,
			})
			return false
		}
	} catch (error) {
		res.status(402).json({
			x402Version,
			error,
			accepts: paymentRequirements,
		});
		return false
	}

	return true
}



const checkx402paymentHeader = (paymentHeader: x402paymentHeader, amount: number, recipient: string) => {
	if (paymentHeader?.payload?.authorization?.to?.toLowerCase() !== recipient.toLowerCase()) {
		return false
	}
	const _payAmount = paymentHeader?.payload?.authorization?.value
	if (!_payAmount) {
		return false
	}

	const payAmount = parseFloat(_payAmount)
	if (isNaN(payAmount) || payAmount < amount) {
		return false
	}

	return true
}

const cashcodeGateway = async(req: any, res: any) => {
		const { id, amt, ccy, wallet, note } = req.query as {
			id?: string
			amt?: string
			ccy?: string
			wallet?: string
			note?: string
		}

		logger (`cashcodeGateway: `, inspect({amt, wallet}))

		const _routerName = req.path
		const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`)

		const resource = `${req.protocol}://${req.headers.host}${url.pathname}` as Resource
		
		if (!amt) {
			logger(`processPayment ${_routerName} price=${amt} Error!`)
			return res.status(404).end()
		}

		const price = parseFloat(amt)
		if (isNaN(price) || price < 0.01 || !wallet) {
			logger(`processPayment isNaN(price) || price <= 0 || !wallet Error! `)
			return res.status(200).json({success: 'Data format error!'}).end()
		}


		const paymentRequirements = [createExactPaymentRequirements(
			amt,
			resource,
			`Cashcode Payment Request for ${wallet}`,
			wallet
		)]


		const isValid = await verifyPayment(req, res, paymentRequirements)

		if (!isValid) {
			return res.status(404).end()
		}

		let responseData: x402SettleResponse

		const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
		const saleRequirements = paymentRequirements[0]
		
		const isValidPaymentHeader = checkx402paymentHeader(paymentHeader as x402paymentHeader, price, wallet)

		if (!isValidPaymentHeader) {
			logger(`${_routerName} checkx402paymentHeader Error!`,inspect(paymentHeader))
			return res.status(402).end()
		}

		try {
			// throw new Error('facilitatorsPool')

			const settleResponse = await settle(
				paymentHeader,
				saleRequirements
			)


			const responseHeader = settleResponseHeader(settleResponse)

			// In a real application, you would store this response header
			// and associate it with the payment for later verification
			
			responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
			
			if (!responseData.success) {
				logger(`${_routerName} responseData ERROR!`, inspect(responseData, false, 3, true))
				return res.status(402).end()
			}


		} catch (error) {
			console.error("Payment settlement failed:", error);

			// In a real application, you would handle the failed payment
			// by marking it for retry or notifying the user
			const payload: payload = paymentHeader?.payload as payload
			if (payload?.authorization) {
				facilitatorsPool.push({
					from: payload.authorization.from,
					value: payload.authorization.value,
					validAfter: payload.authorization.validAfter,
					validBefore: payload.authorization.validBefore,
					nonce: payload.authorization.nonce,
					signature: payload.signature,
					res: res,
					isSettle: false
				})
				return facilitators()
			}
			
			logger(inspect({paymentHeader, saleRequirements}, false, 3, true))

			return res.status(402).end()
		}


		const ret: x402Response = {
			success: true,
			payer: wallet,
			USDC_tx: responseData?.transaction,
			network: responseData?.network,
			timestamp: new Date().toISOString()
		}
		res.status(200).json(ret).end()

}

const processPaymebnt = async (req: any, res: any, price: string) => {
	const _routerName = req.path

	
	const resource = `${req.protocol}://${req.headers.host}${req.originalUrl}` as Resource
		const USDC_tokenValue = ethers.parseUnits(price, 6)
		const SETTLE_tokenvalue = USDC_tokenValue * MINT_RATE
		const SETTLE_token_ether = ethers.formatEther(SETTLE_tokenvalue)

		logger(`processPaymebnt ${_routerName} price=${price} `)


		const paymentRequirements = [createExactPaymentRequirements(
			price,
			resource,
			`SETTLE Mint / Early Access $SETTLE ${SETTLE_token_ether}`
		)];

		const isValid = await verifyPayment(req, res, paymentRequirements)

		if (!isValid) {
			return res.status(404).end()
		}

		let responseData: x402SettleResponse

		const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
		const saleRequirements = paymentRequirements[0]

		const isValidPaymentHeader = checkx402paymentHeader(paymentHeader as x402paymentHeader, parseInt(price), SETTLEContract)

		if (!isValidPaymentHeader) {

			logger(`${_routerName} checkx402paymentHeader Error!`,inspect(paymentHeader))
			return res.status(402).end()
		}

		try {
			// throw new Error('facilitatorsPool')

			const settleResponse = await settle(
				paymentHeader,
				saleRequirements
			)


			const responseHeader = settleResponseHeader(settleResponse)

			// In a real application, you would store this response header
			// and associate it with the payment for later verification
			
			responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
			
			if (!responseData.success) {
				logger(`${_routerName} responseData ERROR!`, inspect(responseData, false, 3, true))
				return res.status(402).end()
			}


		} catch (error) {
			console.error("Payment settlement failed:", error);

			// In a real application, you would handle the failed payment
			// by marking it for retry or notifying the user
			const payload: payload = paymentHeader?.payload as payload
			if (payload?.authorization) {
				facilitatorsPool.push({
					from: payload.authorization.from,
					value: payload.authorization.value,
					validAfter: payload.authorization.validAfter,
					validBefore: payload.authorization.validBefore,
					nonce: payload.authorization.nonce,
					signature: payload.signature,
					res: res,
					isSettle: true
				})
				return facilitators()
			}
			
			logger(inspect({paymentHeader, saleRequirements}, false, 3, true))

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

		
		if (isWallet) {


			x402ProcessPool.push({
				wallet,
				settle: ethers.parseUnits('0.001', 6).toString()
			})

			logger(`${_routerName} success!`, inspect(responseData, false, 3, true))
			// process_x402()


		}

		
		res.status(200).json(ret).end()
}



const router = ( router: express.Router ) => {
	

	router.get('/weather', async (req,res) => {
		return processPaymebnt(req, res, '0.001')
	})


	router.get('/settleHistory', async (req,res) => {
		res.status(200).json(reflashData.slice(0, 20)).end()
	})

	router.get('/settle0001', async (req,res) => {
		return processPaymebnt(req, res, '0.001')
	})
	//	https://api.settleonbase.xyz/api/settle001
	router.get('/settle001', async (req,res) => {
		return processPaymebnt(req, res, '0.01')
	})

	router.get('/settle01', async (req,res) => {
		
		return processPaymebnt(req, res, '0.1')
		
	})

	router.get('/settle1', async (req,res) => {
		return processPaymebnt(req, res, '1.00')
		
	})

	router.get('/settle10', async (req,res) => {
		return processPaymebnt(req, res, '10.00')
		
	})

	router.get('/settle100', async (req,res) => {
		return processPaymebnt(req, res, '100.00')
		
	})

	router.get('/settle', async (req,res) => {
		return cashcodeGateway(req, res)
		
	})

	router.get('/cashCode', async (req,res) => {
		return cashcode_request(req, res)
	})

	router.get('/cashCodeCheck', async (req,res) => {
		return cashcode_check(req, res)
	})

	router.get('/BeamioPaymentLinkFinish', async (req,res) => {
		return BeamioPaymentLinkFinishRouteToSC(req, res)
	})

	router.get('/BeamioTransfer', async (req,res) => {

		return BeamioTransfer(req, res)
		// const payment = req.header("X-PAYMENT")

		// if (!payment) {
		// 	logger(`verifyPayment send x402 payment information`)
		// 	res.status(402).json({
		// 		x402Version,
		// 		error: "X-PAYMENT header is required",
		// 	})
		// 	return 
		// }
		// let decodedPayment: PaymentPayload
		
		// try {
		// 	decodedPayment = exact.evm.decodePayment(payment)
		// 	decodedPayment.x402Version = x402Version
	
		// } catch (error) {
		// 	logger(`verifyPayment catch Invalid or malformed payment header Error!`)
		// 	res.status(402).json({
		// 		x402Version,
		// 		error: error || "Invalid or malformed payment header"
		// 	})
		// 	return
		// }

		// const amount = decodedPayment.payload
		// //@ts-ignore
		// .authorization.value

		// const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`)
		// const resource = `${req.protocol}://${req.headers.host}${url.pathname}` as Resource

		// const paymentRequirements = createExactPaymentRequirements(
		// 	amount,
		// 	resource,
		// 	`Cashcode Payment Request`,
		// 	decodedPayment.payload
		// 	//@ts-ignore
		// 	.authorization.to
		// )
		// const paymentHeader = exact.evm.decodePayment(req.header("X-PAYMENT")!)
		// try {
		// 	// throw new Error('facilitatorsPool')

		// 	const settleResponse = await settle(
		// 		paymentHeader,
		// 		paymentRequirements
		// 	)


		// 	const responseHeader = settleResponseHeader(settleResponse)

		// 	// In a real application, you would store this response header
		// 	// and associate it with the payment for later verification
			
		// 	const responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
			
		// 	if (!responseData.success) {
		// 		logger(`/BeamioTransfer responseData ERROR!`, inspect(responseData, false, 3, true))
		// 		return res.status(402).end()
		// 	}


		// } catch (error) {
		// 	console.error("Payment settlement failed:", error);

		// 	// In a real application, you would handle the failed payment
		// 	// by marking it for retry or notifying the user
		// 	const payload: payload = paymentHeader?.payload as payload
		// 	if (payload?.authorization) {
		// 		facilitatorsPool.push({
		// 			from: payload.authorization.from,
		// 			value: payload.authorization.value,
		// 			validAfter: payload.authorization.validAfter,
		// 			validBefore: payload.authorization.validBefore,
		// 			nonce: payload.authorization.nonce,
		// 			signature: payload.signature,
		// 			res: res,
		// 			isSettle: true
		// 		})
		// 		return facilitators()
		// 	}
			
		// 	logger(inspect({paymentHeader}, false, 3, true))

		// 	return res.status(402).end()
		// }
		

	})

	router.get('/BeamioPaymentLink', async (req,res) => {
		return BeamioPaymentLink(req, res)
	})

	router.get('/BeamioFaucet', async (req,res) => {
		return BeamioFaucet(req, res)
	})

	router.get('/BeamioPayME', async (req,res) => {
		return BeamioPayMeRouteToSC(req, res)
	})

	router.get('/sun', (req, res) => {
		return verifyBeamioSunRequest(req, res)
	})

	// router.get('/estimateNativeBaseTransferGas', async (req,res) => {
	// 	const { address, toAddress, amount } = req.query as {
	// 		address?: string
	// 		toAddress?: string
	// 		amount?: string
	// 	}

	// 	if (!ethers.isAddress(address) || !ethers.isAddress(toAddress) || !amount || isNaN(Number(amount)) ) {
	// 		return res.status(403).json({error: 'format error!'}).end()
	// 	}

	// 	let process = 5
	// 	do {
	// 		const ret = await estimateErc20TransferGas (amount, toAddress, address)
	// 		if (!ret) {
	// 			process--
	// 		} else {
	// 			process = 0
	// 			res.status(200).json(ret).end()
	// 		}

	// 	} while (process)

		
		
		
	// })

	router.get('/getOracle', async (req, res) => {
		try {
			const data = getOracleRequest()
			res.status(200).json({ eth: data }).end()
		} catch (e: any) {
			console.error('getOracle error:', e?.message ?? e)
			res.status(200).json({
				eth: {
					bnb: '', eth: '', usdc: '1', timestamp: Math.floor(Date.now() / 1000),
					usdcad: '1', usdjpy: '150', usdcny: '7.2', usdhkd: '7.8', usdeur: '0.92', usdsgd: '1.35', usdtwd: '31'
				}
			}).end()
		}
	})

	router.get('/generateCheck', (req,res) => {
		return generateCheck(req,res)
	})

	router.get('/redeemCheck', (req,res) => {
		return redeemCheck(req,res)
	})

	router.get('/coinbase-token', (req,res) => {
		return coinbaseToken(req, res)
	})

	

	router.get('/coinbase-offramp', (req,res) => {
		return coinbaseOfframp(req, res)
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

	


	// router.post('/mintTestnet', async (req, res) => {
	// 	// logger(Colors.red(`/mintTestnet coming in`), inspect(req.body, false, 3, true))

	// 	// const ercObj: body402 = req.body
		
		
	// 	// if (!ercObj?.sig || !ercObj?.EIP712 || !ercObj.EIP712?.domain||!ercObj.EIP712?.message) {

	// 	// 	logger(Colors.red(`message or domain Data format error 1!:`), inspect(ercObj, false, 3, true))
	// 	// 	return res.status(200).json({error: `Data format error!`}).end()
	// 	// }

	// 	// const message = ercObj.EIP712.message
	// 	// const domain = ercObj.EIP712.domain

	// 	// if (!message || !message?.value || domain?.verifyingContract?.toLowerCase() !== USDCContract.toLowerCase()) {
	// 	// 	logger(Colors.red(`message or domain Data format error 2 !: domain?.verifyingContract ${domain?.verifyingContract} USDC = ${USDCContract}`))
	// 	// 	return res.status(200).json({error: `message or domain Data format error!`}).end()
	// 	// }

	// 	// // 检查收款人必须是 ownerWallet
	// 	// if (!message?.to || message.to.toLowerCase() !== SETTLEContract.toLowerCase()) {
	// 	// 	logger(Colors.red(`Recipient check failed! Expected: ${SETTLEContract}, Got: ${message?.to}`))
	// 	// 	return res.status(200).json({error: `Recipient must be ${SETTLEContract}!`}).end()
	// 	// }

	// 	// // 调用 checkSig 验证签名
	// 	// const sigResult = checkSig(ercObj)
	// 	// if (!sigResult || !sigResult.isValid) {
	// 	// 	logger(Colors.red(`Signature verification failed:`), inspect(sigResult, false, 3, true))
	// 	// 	return res.status(200).json({error: `Signature verification failed!`}).end()
	// 	// }

	// 	// const value = parseFloat(message.value)
	// 	// if (value < 0.01) {
	// 	// 	logger(Colors.red(`value failed: ${value}`))
	// 	// 	return res.status(200).json({error: `value low error!`}).end()
	// 	// }

	// 	// x402ProcessPool.push({
	// 	// 	v: sigResult.v,
	// 	// 	r: sigResult.r,
	// 	// 	s: sigResult.s,
	// 	// 	address: sigResult.recoveredAddress,
	// 	// 	usdcAmount: message.value,
	// 	// 	validAfter: message.validAfter,
	// 	// 	validBefore: message.validBefore,
	// 	// 	nonce: message.nonce
	// 	// })

	// 	// process_x402()
	// 	// // 返回签名验证结果

	// 	// res.status(200).json({
	// 	// 	success: true,
	// 	// 	message: 'Signature verified successfully',
	// 	// 	signatureComponents: {
	// 	// 		v: sigResult.v,
	// 	// 		r: sigResult.r,
	// 	// 		s: sigResult.s,
	// 	// 		recoveredAddress: sigResult.recoveredAddress
	// 	// 	}
	// 	// }).end()
	// })
}









const SETTLE_FILE = join(os.homedir(), "settle.json")

// 已持久化的 hash 集
const persistedHashes = new Set<string>()

// 文件中现有的所有记录（倒序，最新在前）
let fileCache: reflashData[] = []

// 定时器句柄
let settleFlushTimer: NodeJS.Timeout | null = null;
let flushing = false; // 防重入



async function flushNewReflashData(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    // 仅挑出 reflashData 中“尚未写入文件”的新项（靠 hash 去重）
    const newOnes: reflashData[] = [];
    for (const r of reflashData) {
      if (!persistedHashes.has(r.hash)) {
        newOnes.push(r);
      } else {
        // r.hash 已经入库，说明其后的老记录很可能也已入库，
        // 但不做提前 break，允许 reflashData 前 20 之外的新增也被补齐。
      }
    }

    if (newOnes.length === 0) return;

    // 读一遍最新文件（防止多进程/意外修改导致覆盖）
    await loadSettleFile();

    // 过滤掉已存在的（双重保险）
    const reallyNew = newOnes.filter(r => !persistedHashes.has(r.hash));
    if (reallyNew.length === 0) return;

    // 统一保持倒序：新纪录插到最前
    const nextFile = [...reallyNew, ...fileCache];

    // 原子写入：先写临时文件，再 rename
    const tmp = SETTLE_FILE + ".tmp";
    await fs.writeFileSync(tmp, JSON.stringify(nextFile, null, 2), "utf8")
    await fs.renameSync(tmp, SETTLE_FILE )

    // 更新内存索引
    fileCache = nextFile;
    for (const r of reallyNew) persistedHashes.add(r.hash);
  } catch (e: any) {
    console.error("[settle.json] flush error:", e?.message || e);
  } finally {
    flushing = false;
  }
}






export const reflashData: reflashData[] = []


const loadSettleFile = async () => {
  try {
    const buf = await fs.readFileSync(SETTLE_FILE, 'utf8');
    const arr = JSON.parse(buf);

    if (Array.isArray(arr)) {
      //logger(`loadSettleFile ${SETTLE_FILE}`, inspect(arr, false, 3, true));

      // ✅ 先去重（按 tx 或 hash 唯一）
      const uniqueMap = new Map<string, reflashData>();
	  
      for (const item of arr as reflashData[]) {
        const key = item.hash || item.hash || JSON.stringify(item); // 兜底
        if (!uniqueMap.has(key)) uniqueMap.set(key, item);
      }
      let deduped = Array.from(uniqueMap.values());

      

      // ✅ 保存至缓存（保证最新在前）
      fileCache = deduped;

    } else {
      fileCache = [];
      logger(`loadSettleFile ${SETTLE_FILE} Empty array`);
    }
  } catch (e: any) {
    logger(`loadSettleFile ${SETTLE_FILE} ERROR!`);
    if (e?.code === "ENOENT") {
      fileCache = [];
      await fs.writeFileSync(SETTLE_FILE, "[]", 'utf8');
    } else {
      console.error(`[settle.json] ${SETTLE_FILE} read error: `, e?.message || e);
      fileCache = [];
    }
  }

  // ✅ 初始化 reflashData 数组（最多前 20 条，倒序）
  reflashData.splice(0, reflashData.length, ...fileCache.slice(0, 20));
  logger(`reflashData initialized with ${reflashData.length} items`);
};

async function initSettlePersistence() {
  await loadSettleFile();

  // 每 5 分钟增量落盘
  settleFlushTimer = setInterval(flushNewReflashData, 5 * 60 * 1000);

  // 进程退出时兜底 flush 一次
  const onExit = async () => {
    try {
      if (settleFlushTimer) clearInterval(settleFlushTimer);
      await flushNewReflashData();
    } catch {}
    process.exit(0);
  }

  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);
  process.on("beforeExit", async () => {
    await flushNewReflashData();
  })
}
export class x402Server {

    private loginListening: express.Response|null = null
    private localserver: Server | null = null
    private connect_peer_pool: any [] = []
    private worker_command_waiting_pool: Map<string, express.Response> = new Map()
    private logStram: any

    constructor ( private PORT = 3000, private reactBuildFolder: string) {
		this.logStram = 
        console.log('🗑️  x402Server constructor called')
    }

	public async start(): Promise<void> {
		console.log('⏳ start() called')
		try {
			this.localserver = await initialize(this.reactBuildFolder, this.PORT, router)
			console.log('✨ start() completed successfully')
		} catch (err) {
			console.error('❌ start() error:', err)
			throw err
		}
	}

	public end = (): Promise<void> => new Promise(resolve => {
		if (this.localserver) {
			this.localserver.close(err => {
				if (err) {
					logger(Colors.red('Server err:'), err)
				}
			})
		}
		resolve()
	})



    public postMessageToLocalDevice ( device: string, encryptedMessage: string ) {
        const index = this.connect_peer_pool.findIndex ( n => n.publicKeyID === device )
        if ( index < 0 ) {
            return console.log ( inspect ({ postMessageToLocalDeviceError: `this.connect_peer_pool have no publicKeyID [${ device }]`}, false, 3, true ))
        }
        const ws = this.connect_peer_pool[ index ]
        const sendData = { encryptedMessage: encryptedMessage }
        console.log ( inspect ({ ws_send: sendData}, false, 3, true ))
        return ws.send ( JSON.stringify ( sendData ))
    }
}


const logPath = join(os.homedir(), "esttleEvent.json")


let newRecords1: any = [] 

function flushNow() {
	if (newRecords1.length === 0) return
	if (flushing) return                   // 简单并发保护
	flushing = true
	try {
		let oldArr = []
		if (fs.existsSync(logPath)) {
			const raw = fs.readFileSync(logPath, "utf8")
			const parsed = JSON.parse(raw)
			oldArr = Array.isArray(parsed) ? parsed : []
		}

		newRecords1.sort((a: any, b: any) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))

		const merged = [...newRecords1, ...oldArr]

		fs.writeFileSync(logPath, JSON.stringify(merged, null, 2))
		console.log(`[SETTLE] flush: wrote ${newRecords1.length} new records to ${logPath}`)
		newRecords1 = []
	} catch (e) {
		console.error("[SETTLE] flush failed:", e)
	} finally {
		flushing = false
  }
}

console.log('📌 Script started')
export function flushNowAndExit() {
	try { flushNow() } finally { process.exit(0) }
}

(async () => {
	try {
		console.log('🌐 Creating x402Server instance...')
		const server = new x402Server(4088, '')
		initSettlePersistence()
		console.log('⏳ Calling server.start()...')
		// listenEvent()
		await Promise.all([
			oracleBackoud(),
			server.start()
		])
		console.log('✅ Server started successfully!')
		

		process.on('SIGINT', async () => {
			logger('Shutting down gracefully...')
			await server.end()
			process.exit(0)
		})
		
		console.log('🎯 Server is now running. Press Ctrl+C to exit.')
		
	} catch (error) {
		logger(Colors.red('Failed to start server:'), error)
		console.error('❌ Error details:', error)
		process.exit(1)
	}
})()


console.log('📌 Script setup completed')
