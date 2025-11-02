import express from 'express'
import type { Server } from 'node:http'
import { request } from 'node:https'
import type {RequestOptions} from 'node:https'
import { join } from 'node:path'
import Colors from 'colors/safe'
import { inspect } from 'node:util'
import {logger} from './logger'

import {ethers} from 'ethers'
import os from 'node:os'
import fs from 'node:fs'
import { paymentMiddleware, Network } from 'x402-express'
import {masterSetup} from './util'
import Settle_ABI from './ABI/sellte-abi.json'
import USDC_ABI from './ABI/usdc_abi.json'

const ownerWallet = '0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1'

const USDCContract = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SETTLEContract = '0x543F0d39Fc2C7308558D2419790A0856fA499423'

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

const baseProvider = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const SETTLE_admin = new ethers.Wallet(masterSetup.settle_admin, baseProvider)
const Settle_ContractPool = [new ethers.Contract(SETTLEContract, Settle_ABI, SETTLE_admin)]

logger(`base admin ${SETTLE_admin.address}`)

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

	const app = express()



	// app.use ( express.static ( staticFolder ))
	app.use ( express.json() )

	app.use (async (req, res: any, next) => {
		logger(Colors.blue(`${req.url}`))
		return next()
	})

	const cors = require('cors')

	app.use(cors({
		origin: true,                   // 或者 ['http://localhost:5173','https://settleonbase.xyz']
		methods: ['GET','POST','OPTIONS'],
		allowedHeaders: ['Content-Type','Authorization'],
		credentials: false              // 如果前端要带 cookie/凭证，设 true，并且不能用 origin: true/*
	}));


	// app.use(paymentMiddleware(ownerWallet, {"/api/weather": {
    //   price: "$0.001",
    //   network: "base",
    //   config: {
    //     discoverable: true,
    //     description: "SETTLE: MINTS THAT SETTLE_ON BASE",
    //     inputSchema: {
    //       queryParams: {
            
    //       }
    //     },
    //     outputSchema: {
    //       type: "object",
    //       properties: { 
    //         temperature: { type: "number" },
    //         conditions: { type: "string" },
    //         humidity: { type: "number" }
    //       }
    //     }
    //   }
    // }}))

	const router = express.Router ()

	app.use( '/api', router )
	setupRoutes(router)

	logger('Router stack:', router.stack.map(r => r.route?.path))


	logger(`🧭 public router after serverRoute(router)`)

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
		res.status(200).json({routes}).end()
	})

	router.get('/settleHistory', async (req,res) => {
		const body = JSON.stringify(latestList.slice(0, 20), null, 2)
		res.status(200).json(body).end()
	})

	router.post('/mintTestnet', async (req, res) => {
		logger(Colors.red(`/mintTestnet coming in`), inspect(req.body, false, 3, true))

		const ercObj: body402 = req.body
		
		
		if (!ercObj?.sig || !ercObj?.EIP712 || !ercObj.EIP712?.domain||!ercObj.EIP712?.message) {

			logger(Colors.red(`message or domain Data format error 1!:`), inspect(ercObj, false, 3, true))
			return res.status(200).json({error: `Data format error!`}).end()
		}

		const message = ercObj.EIP712.message
		const domain = ercObj.EIP712.domain

		if (!message || !message?.value || domain?.verifyingContract?.toLowerCase() !== USDCContract.toLowerCase()) {
			logger(Colors.red(`message or domain Data format error 2 !: domain?.verifyingContract ${domain?.verifyingContract} USDC = ${USDCContract}`))
			return res.status(200).json({error: `message or domain Data format error!`}).end()
		}

		// 检查收款人必须是 ownerWallet
		if (!message?.to || message.to.toLowerCase() !== ownerWallet.toLowerCase()) {
			logger(Colors.red(`Recipient check failed! Expected: ${ownerWallet}, Got: ${message?.to}`))
			return res.status(200).json({error: `Recipient must be ${ownerWallet}!`}).end()
		}

		// 调用 checkSig 验证签名
		const sigResult = checkSig(ercObj)
		if (!sigResult || !sigResult.isValid) {
			logger(Colors.red(`Signature verification failed: ${ownerWallet}, Got: ${message?.to}`), inspect(sigResult, false, 3, true))
			return res.status(200).json({error: `Signature verification failed!`}).end()
		}

		const value = parseFloat(message.value)
		if (value < 0.01) {
			logger(Colors.red(`value failed: ${ownerWallet}, Got: ${message?.to}`))
			return res.status(200).json({error: `value low error!`}).end()
		}

		x402ProcessPool.push({
			v: sigResult.v,
			r: sigResult.r,
			s: sigResult.s,
			address: sigResult.recoveredAddress,
			usdcAmount: message.value,
			validAfter: message.validAfter,
			validBefore: message.validBefore,
			nonce: message.nonce
		})

		process_x402()
		// 返回签名验证结果

		res.status(200).json({
			success: true,
			message: 'Signature verified successfully',
			signatureComponents: {
				v: sigResult.v,
				r: sigResult.r,
				s: sigResult.s,
				recoveredAddress: sigResult.recoveredAddress
			}
		}).end()
	})
}


const x402ProcessPool: IEIP3009depositWithUSDCAuthorization[] = []

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
		const tx = await SC.depositWithUSDCAuthorization(
			obj.address,
			obj.usdcAmount,
			obj.validAfter,
			obj.validBefore,
			obj.nonce,
			obj.v,
			obj.r,
			obj.s
		)

		await tx.wait()
		logger(`process_x402 success! ${tx.hash}`)
	} catch (ex: any) {
		logger(`Error process_x402 `, ex.message)
	}
	Settle_ContractPool.unshift(SC)
	setTimeout(() => process_x402(), 1000)

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

function saveLog(obj:ISettleEvent ) {
	try {
		let logs = []
		if (fs.existsSync(logPath)) {
			const data = fs.readFileSync(logPath, "utf8")
			logs = JSON.parse(data)
			if (!Array.isArray(logs)) logs = []
		}
		logs.push({
			...obj,
			timestamp: new Date().toISOString(),
		})
		fs.writeFileSync(logPath, JSON.stringify(logs, null, 2))
		console.log(`[SETTLE] Log saved to ${logPath}`)
	} catch (err) {
		console.error(`[SETTLE] Failed to save log:`, err)
	}
}

// 运行期状态
// --- 常量 ---
const FLUSH_INTERVAL_MS = 5 * 60 * 1000  // 5分钟
const FLUSH_BATCH_MAX   = 10             // 新增≥10条就立即落盘
let flushTimer = null as null | NodeJS.Timeout
let flushing = false                     // 防止并发落盘
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

function stageRecord(obj: any, event: any) {
	const txHash = event?.transactionHash
	const blockNumber = event?.blockNumber ?? 0
	if (!txHash) return
	if (history.has(txHash)) return

	history.set(txHash, { blockNumber, obj })
	latestList.unshift({ ...obj, blockNumber, txHash, timestamp: new Date().toISOString() })

	newRecords1.push({
		...obj,
		blockNumber,
		txHash,
		timestamp: new Date().toISOString(),
	})

	if (newRecords1.length >= FLUSH_BATCH_MAX) {
		flushNow() // 触发批量阈值即刻写盘
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

	sc.on("DepositWithAuthorization", (from, usdcAmount, sobAmount, event) => {

		const obj:ISettleEvent =  {
			from,
			amount: usdcAmount.toString(),
			SETTLTAmount: sobAmount.toString(),
			txHash: event.transactionHash,
		}
		console.log(`[SETTLE] DepositWithAuthorization:`, inspect(obj, false, 3, true));
		if (!event?.removed) stageRecord(obj, event)
		saveLog(obj)
	})

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

process.on?.("SIGINT", flushNowAndExit)
process.on?.("SIGTERM", flushNowAndExit)

;(async () => {
	try {
		console.log('🌐 Creating x402Server instance...')
		const server = new x402Server(4088, '')
		
		console.log('⏳ Calling server.start()...')
		listenEvent()
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


// callTransferWithAuthorization()
//	curl -v https://api.settleonbase.xyz/api/info

