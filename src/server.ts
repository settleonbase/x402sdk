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
import { paymentMiddleware, Network } from 'x402-express'
import {masterSetup} from './util'
import Settle_ABI from './ABI/sellte-abi.json'
import USDC_ABI from './ABI/usdc_abi.json'
import { facilitator, createFacilitatorConfig } from "@coinbase/x402"
import { timeStamp } from 'node:console'

const facilitator1 = createFacilitatorConfig(masterSetup.base.CDP_API_KEY_ID,masterSetup.base.CDP_API_KEY_SECRET)

const USDCContract = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const SETTLEContract = '0x730c1232f15D70C0ebb6B8be23d607baFCed076D'
const owner = '0x8bd9BE7366EcE94CEf1E533727201B67C3E3cAD2'							//			base test2 wallet

const baseProvider = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const settle_admin = new ethers.Wallet(masterSetup.settle_contractAdmin, baseProvider)
const Settle_ContractPool = [new ethers.Contract(SETTLEContract, Settle_ABI, settle_admin)]

const routes =  {
    "/api/weather": {
      price: "$0.001",
      network: "base",
      config: {
        discoverable: true, // make your endpoint discoverable
        description: "SETTLE: MINTS THAT SETTLE_ON BASE",
        inputSchema: {
          queryParams: { 
            location: { 
              type: 'Canada', 
              description: "Toronto", 
              required: true
            }
          }
        },
        outputSchema: {
          type: "object",
          properties: { 
            temperature: { type: "number" },
            conditions: { type: "string" },
            humidity: { type: "number" }
          }
        }
      }
    }
}


// ============================================
// EIP-712 typedData
// ============================================
type EIP712 = {
	types: string
	primaryType: string
	domain: {
		chainId: number
		name: string
		verifyingContract: string
		version: string
	}
	message: {
		from: string
		to:string
		value: string
		validAfter: number
		validBefore: number
		nonce: string
	}
}


type body402 = {
	EIP712: EIP712
	sig: string
}

type SignatureComponents = {
	v: number
	r: string
	s: string
	recoveredAddress: string
	isValid: boolean
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
	app.use ( express.json() )

	app.use (async (req, res: any, next) => {
		logger(Colors.blue(`${req.url}`))
		return next()
	})

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




	app.use(paymentMiddleware(
		owner, 
		{
			"GET /api/weather": {
				price: "$0.001",
				network: "base",
				config: {
					discoverable: true,
					description: "SETTLE: MINTS THAT SETTLE_ON BASE",
					inputSchema: {
						queryParams: {
							
						}
					},
					outputSchema: {
						type: "object",
						properties: { 
							temperature: { type: "number" },
							conditions: { type: "string" },
							humidity: { type: "number" }
						}
					}
				}
			},
			"GET /api/settle0001": {
				price: "$0.001",
				network: "base",
				config: {
					discoverable: true,
					description: "SETTLE: MINTS THAT SETTLE_ON BASE",
					inputSchema: {
						queryParams: {
							
						}
					},
					outputSchema: {
						type: "object",
						properties: { 
							temperature: { type: "number" },
							conditions: { type: "string" },
							humidity: { type: "number" }
						}
					}
				}
			},
			"GET /api/settle001": {
				price: "$0.01",
				network: "base",
				config: {
					discoverable: true,
					description: "SETTLE: MINTS THAT SETTLE_ON BASE",
					inputSchema: {
						queryParams: {
							
						}
					},
					outputSchema: {
						type: "object",
						properties: { 
							temperature: { type: "number" },
							conditions: { type: "string" },
							humidity: { type: "number" }
						}
					}
				}
			},
			"GET /api/settle01": {
				price: "$0.1",
				network: "base",
				config: {
					discoverable: true,
					description: "SETTLE: MINTS THAT SETTLE_ON BASE",
					inputSchema: {
						queryParams: {
							
						}
					},
					outputSchema: {
						type: "object",
						properties: { 
							temperature: { type: "number" },
							conditions: { type: "string" },
							humidity: { type: "number" }
						}
					}
				}
			},
			"GET /api/settle1": {
				price: "$1.00",
				network: "base",
				config: {
					discoverable: true,
					description: "SETTLE: MINTS THAT SETTLE_ON BASE",
					inputSchema: {
						queryParams: {
							
						}
					},
					outputSchema: {
						type: "object",
						properties: { 
							temperature: { type: "number" },
							conditions: { type: "string" },
							humidity: { type: "number" }
						}
					}
				}
			},
			"GET /api/settle10": {
				price: "$10.00",
				network: "base",
				config: {
					discoverable: true,
					description: "SETTLE: MINTS THAT SETTLE_ON BASE",
					inputSchema: {
						queryParams: {
							
						}
					},
					outputSchema: {
						type: "object",
						properties: { 
							temperature: { type: "number" },
							conditions: { type: "string" },
							humidity: { type: "number" }
						}
					}
				}
			},
			"GET /api/settle100": {
				price: "$100.00",
				network: "base",
				config: {
					discoverable: true,
					description: "SETTLE: MINTS THAT SETTLE_ON BASE",
					inputSchema: {
						queryParams: {
							
						}
					},
					outputSchema: {
						type: "object",
						properties: { 
							temperature: { type: "number" },
							conditions: { type: "string" },
							humidity: { type: "number" }
						}
					}
				}
			}
		},
		facilitator1
	))

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

const router = ( router: express.Router ) => {
	
	router.get('/info', async (req,res) => {
		logger(Colors.red(`/info`), inspect(req.body, false, 3, true))
		res.status(200).json({ 'x402 Server': `http://localhost: 4088`, 'Serving files from': '' }).end()
	})

	router.get('/weather', async (req,res) => {
		
			const wallet = req?.query?.wallet
			
			const isWallet = ethers.isAddress(wallet)

			const routes = [{ city: "San Francisco", temperature: 22, conditions: "Sunny" }]

			if (isWallet) {
				x402ProcessPool.push({
					wallet,
					settle: ethers.parseUnits('0.001', 6).toString()
				})
				process_x402()
			}
			
			res.status(200).json({ wallet: wallet, routes }).end()
		
	})


	router.get('/settleHistory', async (req,res) => {
		res.status(200).json(reflashData.slice(0, 20)).end()
	})

	router.get('/settle0001', async (req,res) => {
		
			const wallet = req?.query?.wallet
			logger(inspect(req.header, false, 3, true))
			const isWallet = ethers.isAddress(wallet)

			if (isWallet) {
				x402ProcessPool.push({
					wallet,
					settle: ethers.parseUnits('0.001', 6).toString()
				})
				process_x402()
			}
			
			res.status(200).json({ wallet: wallet, success: '0.001'}).end()
		
	})

	router.get('/settle001', async (req,res) => {
		
			const wallet = req?.query?.wallet
			
			const isWallet = ethers.isAddress(wallet)

			if (isWallet) {
				x402ProcessPool.push({
					wallet,
					settle: ethers.parseUnits('0.01', 6).toString()
				})
				process_x402()
			}
			
			res.status(200).json({ wallet: wallet, success: '0.001'}).end()
		
	})

	router.get('/settle01', async (req,res) => {
		
			const wallet = req?.query?.wallet
			
			const isWallet = ethers.isAddress(wallet)

			if (isWallet) {
				x402ProcessPool.push({
					wallet,
					settle: ethers.parseUnits('0.1', 6).toString()
				})
				process_x402()
			}
			
			res.status(200).json({ wallet: wallet, success: '0.001'}).end()
		
	})

	router.get('/settle1', async (req,res) => {
		
			const wallet = req?.query?.wallet
			
			const isWallet = ethers.isAddress(wallet)

			if (isWallet) {
				x402ProcessPool.push({
					wallet,
					settle: ethers.parseUnits('1', 6).toString()
				})
				process_x402()
			}
			
			res.status(200).json({ wallet: wallet, success: '0.001'}).end()
		
	})

	router.get('/settle10', async (req,res) => {
		
			const wallet = req?.query?.wallet
			
			const isWallet = ethers.isAddress(wallet)

			if (isWallet) {
				x402ProcessPool.push({
					wallet,
					settle: ethers.parseUnits('10', 6).toString()
				})
				process_x402()
			}
			
			res.status(200).json({ wallet: wallet, success: '0.001'}).end()
		
	})

	router.get('/settle100', async (req,res) => {
		
			const wallet = req?.query?.wallet
			
			const isWallet = ethers.isAddress(wallet)

			if (isWallet) {
				x402ProcessPool.push({
					wallet,
					settle: ethers.parseUnits('100', 6).toString()
				})
				process_x402()
			}
			
			res.status(200).json({ wallet: wallet, success: '0.001'}).end()
		
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


const x402ProcessPool: airDrop[] = []

const reflashData: reflashData[] = []
const MINT_RATE = 7000 * 10**18
const USDC_decimals = 1e6


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




const process_x402 = async () => {
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

	try {
		const tx = await SC.mint(
			obj.wallet, obj.settle
		)

		await tx.wait()
		logger(`process_x402 success! ${tx.hash}`)
		const SETTLE = ((parseFloat(obj.settle) * MINT_RATE) / USDC_decimals).toString()

		reflashData.unshift({
			wallet: obj.wallet,
			hash: tx.hash,
			USDC: obj.settle,
			timestmp: new Date().toUTCString(),
			SETTLE
		})


	} catch (ex: any) {
		logger(`Error process_x402 `, ex.message)
	}
	Settle_ContractPool.unshift(SC)
	setTimeout(() => process_x402(), 1000)

}


	// 启动读取 settle.json（若不存在则创建空数组）
const loadSettleFile = async () => {
  try {
    const buf = await fs.readFileSync(SETTLE_FILE,'utf8');
    const arr = JSON.parse(buf);
    if (Array.isArray(arr)) {
      // 文件内按倒序（最新在前）保存
      fileCache = arr as reflashData[];
    } else {
      fileCache = [];
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      fileCache = [];
      await fs.writeFileSync(SETTLE_FILE, "[]", 'utf8');
    } else {
      console.error("[settle.json] read error:", e?.message || e);
      fileCache = [];
    }
  }

}

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
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);
  process.on("beforeExit", async () => {
    await flushNewReflashData();
  });
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


// 运行期状态
// --- 常量 ---
const FLUSH_INTERVAL_MS = 5 * 60 * 1000  // 5分钟
const FLUSH_BATCH_MAX   = 10             // 新增≥10条就立即落盘
let flushTimer = null as null | NodeJS.Timeout
                // 防止并发落盘
let latestList: any = []
let newRecords1: any = [] 
const history = new Map()

// --- 启动加载：读取文件中最新 20 条，建 history ---
function bootLoad() {
	try {
		if (!fs.existsSync(logPath)) {
			fs.writeFileSync(logPath, "[]")
			return
		}
		const raw = fs.readFileSync(logPath, "utf8")
		const arr = JSON.parse(raw)
		if (!Array.isArray(arr)) return
		latestList = arr.slice(0, 20)
		for (const item of latestList) {
			const tx = item.txHash || item.transactionHash
			if (tx && !history.has(tx)) {
				history.set(tx, { blockNumber: item.blockNumber ?? 0, obj: item })
			}
		}
		console.log(`[SETTLE] bootLoad: loaded ${latestList.length} recent records`)
	} catch (e) {
		console.error("[SETTLE] bootLoad failed:", e)
	}
}


const listenEvent = () => {
	bootLoad()
	scheduleFlush()

	const sc = Settle_ContractPool[0]
	if (!sc) {
		console.error("No SETTLE contract instance found in Settle_ContractPool[0]")
		return
	}

	sc.removeAllListeners("DepositWithAuthorization")
	sc.removeAllListeners("PendingEnqueued")

	// sc.on("DepositWithAuthorization", (from, usdcAmount, sobAmount, event) => {
	// 	const txHash =
	// 		event?.transactionHash ||
	// 		event?.log?.transactionHash ||
	// 		event?.receipt?.transactionHash ||
	// 		"0x0"

	// 	const obj:ISettleEvent =  {
	// 		from,
	// 		amount: usdcAmount.toString(),
	// 		SETTLTAmount: sobAmount.toString(),
	// 		txHash
	// 	}
	// 	console.log(`[SETTLE] DepositWithAuthorization:`, inspect(obj, false, 3, true));
	// 	if (!event?.removed) stageRecord(obj, event)
	// 	saveLog(obj)
	// })

}

function scheduleFlush() {
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = setInterval(flushNow, FLUSH_INTERVAL_MS)
}

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
		await server.start()
		
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

