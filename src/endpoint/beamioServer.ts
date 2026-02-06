import express, { Request, Response, Router} from 'express'
import {getClientIp, getOracleRequest, oracleBackoud, checkSign} from '../util'
import { checkSmartAccount } from '../MemberCard'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import {logger} from '../logger'
import type { RequestOptions } from 'node:http'
import {request} from 'node:http'
import { inspect } from 'node:util'
import Colors from 'colors/safe'
import { ethers } from "ethers"
import {beamio_ContractPool, searchUsers, FollowerStatus, getMyFollowStatus} from '../db'
import {coinbaseToken, coinbaseOfframp, coinbaseHooks} from '../coinbase'
import { purchasingCard, AAtoEOAPreCheck, AAtoEOAPreCheckSenderHasCode, OpenContainerRelayPreCheck, ContainerRelayPreCheck } from '../MemberCard'

const masterServerPort = 1111
const serverPort = 2222

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
		console.error(`getReferrer req on Error! ${e.message}`)
		_res.status(502).end()
	})

	req.write(JSON.stringify(obj))
	req.end()
}

const SC = beamio_ContractPool[0].constAccountRegistry

const userOwnershipCheck = async (accountName: string, wallet: string) => {
	
	try {
		const accountWallet: string = await SC.getOwnerByAccountName(accountName)
		if (accountWallet !== ethers.ZeroAddress && accountWallet.toLowerCase() !== wallet.toLowerCase()) {
			return false
		}
	} catch (ex: any) {
		logger(`userOwnershipCheck Error! ${ex.message}`)
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

const routing = ( router: Router ) => {
	
	router.get('/search-users', (req,res) => {
		searchUsers(req,res)
	})
	router.post('/addUser', async (req,res) => {
		const { accountName, wallet, recover, image, isUSDCFaucet, darkTheme, isETHFaucet, firstName, lastName, signMessage } = req.body as {
			accountName?: string
			wallet?: string
			recover?: IAccountRecover[]
			image?: string
			isUSDCFaucet?: boolean
			darkTheme?: boolean
			isETHFaucet?: boolean
			firstName?: string
			lastName?: string
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
			lastName: lastName?.trim() || ''
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

	router.get('/getFollowStatus', async (req,res) => {
		const { wallet, followAddress } = req.query as {
			wallet?: string
			followAddress?: string
		}

		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress || !ethers.isAddress(followAddress) || followAddress === ethers.ZeroAddress) {
			return res.status(400).json({ error: "Invalid data format" })
		}

		
		const followStatus = await FollowerStatus(wallet, followAddress)
		if (followStatus === null) {
			return res.status(400).json({ error: "Follow status check Error!" })
		}
		
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

	router.get('/getOracle', async (req,res) => {
		res.status(200).json(getOracleRequest()).end()
	})

	router.post('/purchasingCard', async (req,res) => {
		const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore } = req.body as {
			cardAddress?: string
			userSignature?: string
			nonce?: string
			usdcAmount?: string
			from?: string
			validAfter?: string
			validBefore?: string
		}

		if (!cardAddress || !userSignature || !nonce  || !usdcAmount || !from || !validBefore) {
			logger(`server /api/purchasingCard Invalid data format!`, inspect(req.body, false, 3, true))
			return res.status(400).json({ error: "Invalid data format" })
		}

		const ret = await purchasingCard(cardAddress, userSignature, nonce, usdcAmount, from, validAfter||'0', validBefore)
		if (!ret||!(ret as { success: boolean }).success) {
			logger(`server /api/purchasingCard failed!`, inspect(ret, false, 3, true))
			return res.status(400).json(ret).end()
		}

		postLocalhost ('/api/purchasingCard', {
			cardAddress,
			userSignature,
			nonce,
			usdcAmount,
			from,
			validAfter,
			validBefore
		}, res)

		logger(`server /api/purchasingCard success!`, 
		inspect({cardAddress, userSignature, nonce,usdcAmount, from, validAfter, validBefore}, false, 3, true))
	})

	/** AA→EOA：支持三种提交。(1) packedUserOp；(2) openContainerPayload；(3) containerPayload（绑定 to）*/
	router.post('/AAtoEOA', async (req, res) => {
		const body = req.body as {
			toEOA?: string
			amountUSDC6?: string
			packedUserOp?: import('../MemberCard').AAtoEOAUserOp
			openContainerPayload?: import('../MemberCard').OpenContainerRelayPayload
			containerPayload?: import('../MemberCard').ContainerRelayPayload
			currency?: string
			currencyAmount?: string
		}
		logger(`[AAtoEOA] server received POST /api/AAtoEOA`, inspect({ bodyKeys: Object.keys(req.body || {}), toEOA: body?.toEOA, amountUSDC6: body?.amountUSDC6, sender: body?.packedUserOp?.sender, openContainer: !!body?.openContainerPayload, container: !!body?.containerPayload }, false, 3, true))

		if (body.containerPayload) {
			const preCheck = ContainerRelayPreCheck(body.containerPayload)
			if (!preCheck.success) {
				logger(Colors.red(`[AAtoEOA] server Container pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			logger(Colors.green(`[AAtoEOA] server Container pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
			postLocalhost('/api/AAtoEOA', {
				containerPayload: body.containerPayload,
				currency: body.currency,
				currencyAmount: body.currencyAmount,
			}, res)
			return
		}

		if (body.openContainerPayload) {
			const preCheck = OpenContainerRelayPreCheck(body.openContainerPayload)
			if (!preCheck.success) {
				logger(Colors.red(`[AAtoEOA] server OpenContainer pre-check FAIL: ${preCheck.error}`), inspect(req.body, false, 2, true))
				return res.status(400).json({ success: false, error: preCheck.error }).end()
			}
			logger(Colors.green(`[AAtoEOA] server OpenContainer pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
			postLocalhost('/api/AAtoEOA', { openContainerPayload: body.openContainerPayload }, res)
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
		logger(Colors.green(`[AAtoEOA] server pre-check OK, forwarding to localhost:${masterServerPort}/api/AAtoEOA`))
		postLocalhost('/api/AAtoEOA', { toEOA, amountUSDC6, packedUserOp }, res)
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


	router.get('/getMyFollowStatus', async (req,res) => {
		const { wallet } = req.query as {
			wallet?: string
		}

		if (!ethers.isAddress(wallet) || wallet === ethers.ZeroAddress) {
			return res.status(400).json({ error: "Invalid data format" })
		}
		
		const followStatus = await getMyFollowStatus(wallet)
		if (followStatus === null) {
			return res.status(400).json({ error: "Follow status check Error!" })
		}
		
		return res.status(200).json(followStatus).end()

	})

	router.post('/coinbase-hooks', express.raw({ type: '*/*' }), async (req, res) => {
		const ret = await coinbaseHooks(req,res)
		if (!ret) {
			return logger(`/coinbase-hooks Error!`)
		}
		

	})




}

const initialize = async (reactBuildFolder: string, PORT: number) => {
	console.log('🔧 Initialize called with PORT:', PORT, 'reactBuildFolder:', reactBuildFolder)
	
	oracleBackoud()
	const defaultPath = join(__dirname, 'workers')
	

	const userDataPath = reactBuildFolder
	const updatedPath = join(userDataPath, 'workers')
	

	let staticFolder = fs.existsSync(updatedPath) ? updatedPath : defaultPath
	
	
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
	oracleBackoud(false)
}