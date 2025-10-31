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
import Settle_ABI from './sellte-abi.json'

const ownerWallet = '0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1'
const ownerContract_testnet = `0xFd60936707cb4583c08D8AacBA19E4bfaEE446B8`

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
const checkSig = (ercObj: body402): SignatureComponents | null => {
	try {
		if (!ercObj?.sig || !ercObj?.EIP712) {
			logger(Colors.red('Invalid ercObj format'))
			return null
		}

		const sig = ercObj.sig
		const eip712 = ercObj.EIP712
		const message = eip712.message

		// 验证有效期时间戳
		const currentTimestamp = Math.floor(Date.now() / 1000)
		
		if (!message?.validAfter || !message?.validBefore) {
			logger(Colors.red('Missing validAfter or validBefore in message'))
			return null
		}

		const validAfter = parseInt(message.validAfter.toString())
		const validBefore = parseInt(message.validBefore.toString())

		// 检查当前时间是否在有效期内
		if (currentTimestamp < validAfter) {
			logger(Colors.red(`Signature not yet valid. validAfter: ${validAfter}, current: ${currentTimestamp}`))
			return null
		}

		if (currentTimestamp > validBefore) {
			logger(Colors.red(`Signature has expired. validBefore: ${validBefore}, current: ${currentTimestamp}`))
			return null
		}

		logger(Colors.green(`✓ Timestamp validation passed. validAfter: ${validAfter}, validBefore: ${validBefore}, current: ${currentTimestamp}`))

		// 验证签名格式（0x开头，长度为130）
		if (!sig.startsWith('0x') || sig.length !== 132) {
			logger(Colors.red('Invalid signature format'))
			return null
		}

		// 从签名中提取 v, r, s
		const r = '0x' + sig.slice(2, 66)
		const s = '0x' + sig.slice(66, 130)
		const v = parseInt(sig.slice(130, 132), 16)

		logger(`Extracted v: ${v}, r: ${r}, s: ${s}`)

		// 使用 ethers.js 构建 EIP-712 哈希
		const domain = {
			name: eip712.domain.name,
			version: eip712.domain.version,
			chainId: eip712.domain.chainId,
			verifyingContract: eip712.domain.verifyingContract
		}

		const messageTypes = {
			Message: [
				{ name: 'from', type: 'address' },
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'string' },
				{ name: 'validAfter', type: 'uint256' },
				{ name: 'validBefore', type: 'uint256' },
				{ name: 'nonce', type: 'string' }
			]
		}


		// 计算 EIP-712 hash
		const digest = ethers.TypedDataEncoder.hash(domain, messageTypes, message)
		logger(`Computed digest: ${digest}`)

		// 恢复签名者地址
		const recoveredAddress = ethers.recoverAddress(digest, { v, r, s })
		logger(Colors.green(`Recovered address: ${recoveredAddress}`))

		// 验证签名的有效性
		const isValid = recoveredAddress.toLowerCase() === message.from.toLowerCase()
		logger(isValid ? Colors.green('✓ Signature is valid') : Colors.red('✗ Signature is invalid'))

		return {
			v,
			r,
			s,
			recoveredAddress,
			isValid
		}
	} catch (error) {
		logger(Colors.red('checkSig error:'), error)
		return null
	}
}

const base_testnet_provide = new ethers.JsonRpcProvider('https://chain-proxy.wallet.coinbase.com?targetName=base-sepolia')
const base_testnet_admin = new ethers.Wallet(masterSetup.settle_admin, base_testnet_provide)
const Settle_testnet_pool = [new ethers.Contract(ownerContract_testnet, Settle_ABI, base_testnet_admin)]

const initialize = async (reactBuildFolder: string, PORT: number, serverRoute: (router: any) => void) => {
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
	const cors = require('cors')

	app.use( cors ())
	app.use ( express.static ( staticFolder ))
	app.use ( express.json() )
	app.use (async (req, res: any, next) => {
		logger(Colors.blue(`${req.url}`))
		return next()
	})

	app.use(paymentMiddleware(ownerWallet, {"/api/weather": {
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
    }}))

	const router = express.Router ()

	app.use( '/api', router )
	serverRoute(router)

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


const x402ProcessPool: IEIP3009depositWithUSDCAuthorization[] = []

const process_x402 = async () => {
	const obj = x402ProcessPool.shift()
	if (!obj) {
		return
	}

	const SC = Settle_testnet_pool.shift()
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
	Settle_testnet_pool.unshift(SC)
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
			this.localserver = await initialize(this.reactBuildFolder, this.PORT, this.router)
			console.log('✨ start() completed successfully')
		} catch (err) {
			console.error('❌ start() error:', err)
			throw err
		}
	}

	public router ( router: express.Router ) {

        router.get('/info', async (req,res) => {
            res.status(200).json({ 'x402 Server': `http://localhost: 4088`, 'Serving files from': '' }).end()
        })

		router.get('/weather', async (req,res) => {
			res.status(200).json({routes}).end()
		})

		router.post('/mint-testnet', async (req, res) => {

			const ercObj: body402 = req.body
			
			if (!ercObj?.sig || !ercObj?.EIP712 || !ercObj.EIP712?.domain||!ercObj.EIP712?.message) {
				return res.status(200).json({error: `Data format error!`}).end()
			}

			const message = ercObj.EIP712.message
			const domain = ercObj.EIP712.domain

			if (!message || !message?.value || domain?.verifyingContract?.toLowerCase() !== ownerContract_testnet.toLowerCase()) {
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
				return res.status(200).json({error: `Signature verification failed!`}).end()
			}

			const value = parseFloat(message.value)
			if (value < 0.01) {
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

console.log('📌 Script started')

;(async () => {
	try {
		console.log('🌐 Creating x402Server instance...')
		const server = new x402Server(4088, '')
		
		console.log('⏳ Calling server.start()...')
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