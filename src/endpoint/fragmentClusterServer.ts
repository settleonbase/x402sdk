import Express, { Router } from 'express'
import type {Response, Request } from 'express'
import { logger } from '../logger'
import Colors from 'colors/safe'
import {createServer} from 'node:http'
import Fs, { readFile, createReadStream, stat} from 'node:fs'
import { inspect } from 'node:util'
import { checkSign, masterSetup} from '../util'
import Cluster from 'node:cluster'
import {writeFile} from 'node:fs'
import {_search, beamio_ContractPool,ipfsDataPool, ipfsDataProcess, ipfsAccessPool, ipfsAccessProcess} from '../db'
import {postLocalhost} from './beamioServer'
import { keccak256, toUtf8Bytes } from "ethers"

const storagePATH = masterSetup.storagePATH


const workerNumber = Cluster?.worker?.id ? `worker : ${Cluster.worker.id} ` : `${ Cluster?.isPrimary ? 'Cluster Master': 'Cluster unknow'}`

//			getIpAddressFromForwardHeader(req.header(''))
const getIpAddressFromForwardHeader = (req: Request) => {

	// logger(inspect(req.headers, false, 3, true))
	const ipaddress = req.headers['X-Real-IP'.toLowerCase()]||req.headers['X-Forwarded-For'.toLowerCase()]||req.headers['CF-Connecting-IP'.toLowerCase()]||req.ip
	if (!ipaddress) {
		return ''
	}
	if (typeof ipaddress === 'object') {
		return ipaddress[0]
	}
	return ipaddress
}

const saveFragment = (hash: string, data: string): Promise<boolean> => new Promise(resolve=> {
	const lastChar = hash[hash.length-1]
	const n = parseInt(`0x${lastChar}`, 16)
	const path = storagePATH[n%storagePATH.length]
	const fileName = `${storagePATH}/${hash}`
	logger(`saveFragment [${fileName}] data length = ${data.length}`)

	return writeFile(fileName, data, err => {
		if (err) {
			logger(Colors.red(`saveFragment [${hash}] data length [${data.length}] Error! ${err.message}`))
			return resolve (false)
		}
		logger(`saveFragment storage [${fileName}] data length = ${data.length} success!`)
		return resolve (true)
	})
})

function parseBase64(data: string) {
  const match = data.match(/^data:(.+);base64,(.+)$/)
  if (!match) return null

  return {
    mime: match[1],
    buffer: Buffer.from(match[2], "base64")
  }
}

const getFragment = async (hash: string, res: Response) => {
	
	const filename = `${storagePATH}/${hash}`

	return stat(filename, async err => {
		if (err) {
			logger(Colors.red(`getFragment file [${filename}] does not exist!`))
			return res.status(404).end()
		}

		const raw = await Fs.readFileSync(filename, 'utf8')
		if (raw) {
			// ==== base64 data URI ====
			const base64 = raw.match(/^data:(.+);base64,(.+)$/)
			if (base64) {
				const mimeType = base64[1]
				const buffer = Buffer.from(base64[2], "base64")

				res.status(200)
				res.setHeader("Content-Type", mimeType)
				res.setHeader("Content-Length", buffer.length)

				return res.end(buffer)
			}

			// ==== JSON ====
			if (raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
				res.status(200)
				res.setHeader("Content-Type", "application/json; charset=utf-8")
				return res.end(raw)
			}
		}

		const req = createReadStream(filename, 'utf8')
		res.status(200)

		req.pipe(res).on(`error`, err => {
			logger(Colors.red(`getFragment on error ${err.message}`))
		})

		const obj = {
			hash
		}

		postLocalhost('/api/getFragment', obj, res)

	})
	

}

class server {

	private PORT = 8002
	public ipaddressWallet: Map<string, string> = new Map()
	public WalletIpaddress: Map<string, string> = new Map()
	public regiestNodes: Map<string, string> = new Map()
	public nodeIpaddressWallets: Map<string, Map<string, string>> = new Map()
	constructor () {
		this.startServer()
    }

	private startServer = async () => {
		const Cors = require('cors')
		const app = Express()
		app.use(Express.json({ limit: '50mb' }))
		app.use(Express.urlencoded({ extended: true }))
		app.disable('x-powered-by')
		app.use(Express.urlencoded({ extended: false }));
		const router = Router ()
		app.use( '/api', router )
	
		app.once ( 'error', ( err: any ) => {
			/**
			 * https://stackoverflow.com/questions/60372618/nodejs-listen-eacces-permission-denied-0-0-0-080
			 * > sudo apt-get install libcap2-bin 
			 * > sudo setcap cap_net_bind_service=+ep `readlink -f \`which node\``
			 * 
			 */
            logger (err)
            logger (Colors.red(`Local server on ERROR`))
        })

		const server = createServer(app)

		this.router (router)

		app.all ('/', (req: any, res: any) => {
			//logger (Colors.red(`get unknow router from ${ipaddress} => ${ req.method } [http://${ req.headers.host }${ req.url }] STOP connect! ${req.body, false, 3, true}`))
			res.status(406).end ()
			return res.socket?.end().destroy()
		})

		server.listen(this.PORT, () => {
			return console.table([
                { 'Cluster': ` startup success ${ this.PORT } Work [${workerNumber}]` }
            ])
		})
	}

	private router ( router: Router ) {
		
		router.post ('/storageFragment',  async (req: any, res: any) => {
			const { wallet, signMessage, image } = req.body as {
				wallet?: string
				image?: string
				signMessage?: string
			}
			const ipaddress = getIpAddressFromForwardHeader(req)
			if (!wallet || !signMessage) {
				return res.status(403).end()
			}

			const obj = checkSign (wallet, signMessage, wallet)

			if (!obj||!image) {
				logger (Colors.grey(`Router /storageFragments !obj Format Error Error! ${ipaddress} checkSign Error!`))
				return res.status(403).end()
			}
			
			

			const kk = await _search(obj)
			if (!kk?.results) {
				logger (Colors.grey(`Router /storageFragments !obj Format Error Error! ${ipaddress} has not Beamioer!`))
				return res.status(403).end()
			}

			const hash = keccak256(toUtf8Bytes(image))
			const SC = beamio_ContractPool[0]
			try {
				const isActive: boolean = await SC.constIPFS.isCidInUse(hash)
				if (isActive) {
					return res.status(403).end()
				}
			} catch (ex) {
				return res.status(403).end()
			}

			const result = await saveFragment(hash, image)

			if (result) {
				const obj = {
					wallet,
					imageLength: image.length,
					hash
				}

				return postLocalhost('/api/storageFragment', obj, res)
			}

			return res.status(403).json({status:true}).end()

		})

		router.get ('/getFragment',  async (req, res) => {
			const { hash } = req.query as {
				hash?: string
			}
			if (!hash) {
				return res.status(404).end()
			}

			return getFragment (hash, res)
		})
	}
}

export default server


//	curl -v https://ipfs.conet.network/api/getFragment/free_wallets_53152
//	curl -v https://ipfs.conet.network/api/getFragment/53408_free