import Express, { Router } from 'express'
import type {Response, Request } from 'express'
import { logger } from '../logger'
import Colors from 'colors/safe'
import {createServer} from 'node:http'
import Fs, { createReadStream } from 'node:fs'
import { checkSign, masterSetup} from '../util'
import Cluster from 'node:cluster'
import {writeFile} from 'node:fs'
import {beamio_ContractPool} from '../db'
import { keccak256, toUtf8Bytes } from "ethers"

const storagePATH = masterSetup.storagePATH


const workerNumber = Cluster?.worker?.id ? `worker : ${Cluster.worker.id} ` : `${ Cluster?.isPrimary ? 'Cluster Master': 'Cluster unknow'}`

function fragmentPaths(hash: string) {
	const base = `${storagePATH}/${hash}`
	return {
		text: base,
		binary: `${base}.bin`,
		meta: `${base}.meta.json`,
	}
}

function isRangeStreamableMime(mime: string): boolean {
	const normalized = mime.toLowerCase().split(';')[0].trim()
	return normalized.startsWith('video/')
		|| normalized.startsWith('audio/')
		|| normalized === 'application/pdf'
}

function parseBase64(data: string) {
	const match = data.match(/^data:(.+);base64,(.+)$/)
	if (!match) return null

	return {
		mime: match[1],
		buffer: Buffer.from(match[2], "base64")
	}
}

type BytesRange = { start: number; end: number }

function parseBytesRange(rangeHeader: string | undefined, size: number): BytesRange | 'unsatisfiable' | null {
	if (!rangeHeader || !/^bytes=/i.test(rangeHeader)) return null

	const spec = rangeHeader.replace(/^bytes=/i, '').trim()
	const [startStr, endStr] = spec.split('-')

	let start: number
	let end: number

	if (startStr === '' && endStr !== '') {
		const suffixLen = parseInt(endStr, 10)
		if (!Number.isFinite(suffixLen) || suffixLen <= 0) return 'unsatisfiable'
		start = Math.max(0, size - suffixLen)
		end = size - 1
	} else {
		start = parseInt(startStr, 10)
		end = endStr !== '' ? parseInt(endStr, 10) : size - 1
		if (!Number.isFinite(start)) return 'unsatisfiable'
		if (!Number.isFinite(end) || end >= size) end = size - 1
	}

	if (start < 0 || start > end || start >= size) return 'unsatisfiable'
	return { start, end }
}

function sendBinaryWithRange(req: Request, res: Response, buffer: Buffer, mimeType: string): void {
	const size = buffer.length
	const parsed = parseBytesRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)

	res.setHeader('Accept-Ranges', 'bytes')

	if (parsed === 'unsatisfiable') {
		res.status(416)
		res.setHeader('Content-Range', `bytes */${size}`)
		res.end()
		return
	}

	if (!parsed) {
		res.status(200)
		res.setHeader('Content-Type', mimeType)
		res.setHeader('Content-Length', String(size))
		res.end(buffer)
		return
	}

	const { start, end } = parsed
	const chunk = buffer.subarray(start, end + 1)
	res.status(206)
	res.setHeader('Content-Type', mimeType)
	res.setHeader('Content-Length', String(chunk.length))
	res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
	res.end(chunk)
}

function streamFileWithRange(req: Request, res: Response, filePath: string, mimeType: string, size: number): void {
	const parsed = parseBytesRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)

	res.setHeader('Accept-Ranges', 'bytes')

	if (parsed === 'unsatisfiable') {
		res.status(416)
		res.setHeader('Content-Range', `bytes */${size}`)
		res.end()
		return
	}

	if (!parsed) {
		res.status(200)
		res.setHeader('Content-Type', mimeType)
		res.setHeader('Content-Length', String(size))
		createReadStream(filePath).pipe(res).on('error', err => {
			logger(Colors.red(`getFragment stream error ${err.message}`))
		})
		return
	}

	const { start, end } = parsed
	res.status(206)
	res.setHeader('Content-Type', mimeType)
	res.setHeader('Content-Length', String(end - start + 1))
	res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
	createReadStream(filePath, { start, end }).pipe(res).on('error', err => {
		logger(Colors.red(`getFragment range stream error ${err.message}`))
	})
}

async function writeBinarySidecar(hash: string, buffer: Buffer, mime: string): Promise<void> {
	const paths = fragmentPaths(hash)
	await Fs.promises.writeFile(paths.binary, buffer)
	await Fs.promises.writeFile(paths.meta, JSON.stringify({ mime }))
}

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

const saveFragment = (hash: string, data: string): Promise<boolean> => new Promise(resolve => {
	const fileName = `${storagePATH}/${hash}`
	logger(`saveFragment [${fileName}] data length = ${data.length}`)

	return writeFile(fileName, data, err => {
		if (err) {
			logger(Colors.red(`saveFragment [${hash}] data length [${data.length}] Error! ${err.message}`))
			return resolve (false)
		}
		logger(`saveFragment storage [${fileName}] data length = ${data.length} success!`)

		const parsed = parseBase64(data)
		if (!parsed || !isRangeStreamableMime(parsed.mime)) {
			return resolve(true)
		}

		return writeBinarySidecar(hash, parsed.buffer, parsed.mime)
			.then(() => {
				logger(`saveFragment binary sidecar [${hash}] mime=${parsed.mime} bytes=${parsed.buffer.length}`)
				return resolve(true)
			})
			.catch(sidecarErr => {
				logger(Colors.yellow(`saveFragment binary sidecar [${hash}] failed: ${sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr)}`))
				return resolve(true)
			})
	})
})

const getFragment = async (req: Request, hash: string, res: Response): Promise<void> => {
	const paths = fragmentPaths(hash)
	logger(`getFragment = ${hash} filename = ${paths.text}`)

	try {
		await Fs.promises.access(paths.text)
	} catch {
		logger(Colors.red(`getFragment file [${paths.text}] does not exist!`))
		res.status(404).end()
		return
	}

	try {
		const binStat = await Fs.promises.stat(paths.binary)
		let mimeType = 'application/octet-stream'
		try {
			const metaRaw = await Fs.promises.readFile(paths.meta, 'utf8')
			const meta = JSON.parse(metaRaw) as { mime?: string }
			if (meta.mime) mimeType = meta.mime
		} catch {
			// optional sidecar metadata
		}
		streamFileWithRange(req, res, paths.binary, mimeType, binStat.size)
		return
	} catch {
		// fall through to legacy text storage
	}

	const raw = await Fs.promises.readFile(paths.text, 'utf8')
	if (raw) {
		const base64 = raw.match(/^data:(.+);base64,(.+)$/)
		if (base64) {
			const mimeType = base64[1]
			const buffer = Buffer.from(base64[2], 'base64')

			if (isRangeStreamableMime(mimeType)) {
				void writeBinarySidecar(hash, buffer, mimeType).catch(sidecarErr => {
					logger(Colors.yellow(`getFragment lazy sidecar [${hash}] failed: ${sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr)}`))
				})
				sendBinaryWithRange(req, res, buffer, mimeType)
				return
			}

			sendBinaryWithRange(req, res, buffer, mimeType)
			return
		}

		if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
			res.status(200)
			res.setHeader('Content-Type', 'application/json; charset=utf-8')
			res.end(raw)
			return
		}
	}

	res.status(200)
	createReadStream(paths.text).pipe(res).on('error', err => {
		logger(Colors.red(`getFragment on error ${err.message}`))
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
		/** JSON body limit: image base64 ~4/3 of raw size; 50MB raw → ~67MB. Use 70mb to allow tier images. */
		app.use(Express.json({ limit: '70mb' }))
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
				logger (Colors.grey(`Router /storageFragments !wallet || !signMessage Error! ${ipaddress}`))
				return res.status(403).end()
			}

			const obj = checkSign (wallet, signMessage, wallet)

			if (!obj||!image) {
				logger (Colors.grey(`Router /storageFragments !obj Format Error Error! ${ipaddress} checkSign Error!`))
				return res.status(403).end()
			}
			
			

			// const kk = await searchUser(obj)
			// if (!kk?.results) {
			// 	logger (Colors.grey(`Router /storageFragments !obj Format Error Error! ${ipaddress} has not Beamioer!`))
			// 	return res.status(403).end()
			// }

			const hash = keccak256(toUtf8Bytes(image))
			const SC = beamio_ContractPool[0]
			const result = await saveFragment(hash, image)
			return res.status(200).end()

		})

		router.get ('/getFragment',  async (req, res) => {
			const { hash } = req.query as {
				hash?: string
			}
			if (!hash) {
				return res.status(404).end()
			}

			return getFragment (req, hash, res)
		})
	}
}

export default server


//	curl -v https://ipfs.conet.network/api/getFragment/free_wallets_53152
//	curl -v https://ipfs.conet.network/api/getFragment/53408_free
