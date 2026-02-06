import express, { Request, Response, Router} from 'express'
import {getClientIp, oracleBackoud, BeamioETHFaucetTry} from '../util'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import {addUser, addFollow, removeFollow, ipfsDataPool, ipfsDataProcess, ipfsAccessPool, ipfsAccessProcess} from '../db'
import {coinbaseHooks} from '../coinbase'
import { ethers } from 'ethers'
import { purchasingCardPool, purchasingCardProcess, AAtoEOAPool, AAtoEOAProcess, type AAtoEOAUserOp } from '../MemberCard'

const masterServerPort = 1111


const routing = ( router: Router ) => {

	router.post('/addFollow', (req,res) => {
		return addFollow(req, res)
	})

	router.post('/removeFollow', (req,res) => {
		return removeFollow(req, res)
	})

	router.post('/addUser', (req,res) => {
		return addUser(req, res)
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

	router.post('/purchasingCard', (req, res) => {
		const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore } = req.body as {
			cardAddress: string
			userSignature: string
			nonce: string
			usdcAmount: string
			from: string
			validAfter: string
			validBefore: string
		}

		purchasingCardPool.push({
			cardAddress,
			userSignature,
			nonce,
			usdcAmount,
			from,
			validAfter,
			validBefore,
			res: res
		})

		logger(` Master GOT /api/purchasingCard doing purchasingCardProcess...`, inspect(req.body, false, 3, true))
		purchasingCardProcess()
	})

	/** AA→EOA：接受 ERC-4337 UserOp 签字，入队后由 AAtoEOAProcess 用 Settle_ContractPool 私钥代付 Gas 提交 */
	router.post('/AAtoEOA', (req, res) => {
		logger(`[AAtoEOA] master received POST /api/AAtoEOA`, inspect({ toEOA: req.body?.toEOA, amountUSDC6: req.body?.amountUSDC6, sender: req.body?.packedUserOp?.sender }, false, 3, true))
		const { toEOA, amountUSDC6, packedUserOp } = req.body as {
			toEOA?: string
			amountUSDC6?: string
			packedUserOp?: AAtoEOAUserOp
		}
		if (!ethers.isAddress(toEOA) || !amountUSDC6 || !packedUserOp?.sender || !packedUserOp?.callData || packedUserOp?.signature === undefined) {
			logger(Colors.red(`[AAtoEOA] master validation FAIL: need toEOA, amountUSDC6, packedUserOp (sender, callData, signature)`))
			return res.status(400).json({ success: false, error: 'Invalid data: need toEOA, amountUSDC6, packedUserOp (sender, callData, signature)' }).end()
		}
		const poolLenBefore = AAtoEOAPool.length
		AAtoEOAPool.push({
			toEOA: toEOA as string,
			amountUSDC6,
			packedUserOp: packedUserOp as AAtoEOAUserOp,
			res,
		})
		logger(`[AAtoEOA] master pushed to pool (length ${poolLenBefore} -> ${AAtoEOAPool.length}), calling AAtoEOAProcess()`)
		AAtoEOAProcess()
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

	router.post('/coinbase-hooks', (req, res) => {
		const { destinationAddress, status } = req.body as {
			destinationAddress: string
			status: string
		}
		
		logger(``)
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