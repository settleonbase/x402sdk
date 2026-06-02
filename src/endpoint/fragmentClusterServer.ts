import Express, { Router } from 'express'
import type { Response, Request } from 'express'
import multer from 'multer'
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

/** Max bytes per storageFragmentChunk part (512 KiB). Client uses multipart `chunk`; legacy JSON uses chunkBase64. */
export const FRAGMENT_UPLOAD_CHUNK_BYTES = 512 * 1024

const fragmentChunkMulter = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: FRAGMENT_UPLOAD_CHUNK_BYTES },
})

const workerNumber = Cluster?.worker?.id ? `worker : ${Cluster.worker.id} ` : `${ Cluster?.isPrimary ? 'Cluster Master': 'Cluster unknow'}`

function fragmentPaths(hash: string) {
	const base = `${storagePATH}/${hash}`
	return {
		text: base,
		binary: `${base}.bin`,
		meta: `${base}.meta.json`,
	}
}

function fragmentUploadPaths(hash: string) {
	return {
		partial: `${storagePATH}/${hash}.upload`,
		meta: `${storagePATH}/${hash}.upload.meta.json`,
	}
}

type FragmentUploadMeta = {
	totalSize: number
	wallet: string
}

function verifyFragmentWalletSign(wallet?: string, signMessage?: string): boolean {
	if (!wallet || !signMessage) return false
	return Boolean(checkSign(wallet, signMessage, wallet))
}

async function fragmentFinalExists(hash: string): Promise<boolean> {
	try {
		await Fs.promises.access(fragmentPaths(hash).text)
		return true
	} catch {
		return false
	}
}

async function readFragmentUploadMeta(hash: string): Promise<FragmentUploadMeta | null> {
	try {
		const raw = await Fs.promises.readFile(fragmentUploadPaths(hash).meta, 'utf8')
		const parsed = JSON.parse(raw) as FragmentUploadMeta
		if (!parsed?.wallet || !Number.isFinite(parsed.totalSize) || parsed.totalSize <= 0) return null
		return parsed
	} catch {
		return null
	}
}

async function writeFragmentUploadMeta(hash: string, meta: FragmentUploadMeta): Promise<void> {
	await Fs.promises.writeFile(fragmentUploadPaths(hash).meta, JSON.stringify(meta))
}

async function getFragmentUploadReceivedBytes(hash: string): Promise<number> {
	try {
		const stat = await Fs.promises.stat(fragmentUploadPaths(hash).partial)
		return stat.size
	} catch {
		return 0
	}
}

async function finalizeFragmentChunkUpload(hash: string): Promise<boolean> {
	const uploadPaths = fragmentUploadPaths(hash)
	const meta = await readFragmentUploadMeta(hash)
	if (!meta) return false

	const received = await getFragmentUploadReceivedBytes(hash)
	if (received !== meta.totalSize) {
		logger(Colors.red(`finalizeFragmentChunkUpload [${hash}] size mismatch received=${received} expected=${meta.totalSize}`))
		return false
	}

	const data = await Fs.promises.readFile(uploadPaths.partial, 'utf8')
	const computed = keccak256(toUtf8Bytes(data))
	if (computed.toLowerCase() !== hash.toLowerCase()) {
		logger(Colors.red(`finalizeFragmentChunkUpload [${hash}] hash mismatch`))
		return false
	}

	const ok = await saveFragment(hash, data)
	await Fs.promises.unlink(uploadPaths.partial).catch(() => undefined)
	await Fs.promises.unlink(uploadPaths.meta).catch(() => undefined)
	return ok
}

async function writeFragmentUploadChunk(args: {
	hash: string
	wallet: string
	totalSize: number
	offset: number
	chunk: Buffer
}): Promise<{ received: number; complete: boolean }> {
	const { hash, wallet, totalSize, offset, chunk } = args
	if (chunk.length <= 0 || chunk.length > FRAGMENT_UPLOAD_CHUNK_BYTES) {
		throw new Error('Invalid chunk size')
	}
	if (offset < 0 || offset + chunk.length > totalSize) {
		throw new Error('Chunk out of range')
	}

	if (await fragmentFinalExists(hash)) {
		return { received: totalSize, complete: true }
	}

	const uploadPaths = fragmentUploadPaths(hash)
	let meta = await readFragmentUploadMeta(hash)
	if (!meta) {
		meta = { totalSize, wallet }
		await writeFragmentUploadMeta(hash, meta)
		await Fs.promises.writeFile(uploadPaths.partial, Buffer.alloc(0))
	} else {
		if (meta.wallet.toLowerCase() !== wallet.toLowerCase()) {
			throw new Error('Upload wallet mismatch')
		}
		if (meta.totalSize !== totalSize) {
			throw new Error('Upload totalSize mismatch')
		}
	}

	const receivedBefore = await getFragmentUploadReceivedBytes(hash)
	if (offset < receivedBefore) {
		return { received: receivedBefore, complete: receivedBefore >= totalSize }
	}
	if (offset > receivedBefore) {
		throw new Error('Upload gap — resume from last received byte')
	}

	await Fs.promises.appendFile(uploadPaths.partial, chunk)
	const received = receivedBefore + chunk.length
	if (received >= totalSize) {
		const ok = await finalizeFragmentChunkUpload(hash)
		if (!ok) throw new Error('Finalize upload failed')
		return { received: totalSize, complete: true }
	}
	return { received, complete: false }
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
		/** JSON body limit: image base64 ~4/3 of raw size; catalog video clips up to ~50MB raw → ~67MB base64. Match nginx 256m. */
		app.use(Express.json({ limit: '256mb' }))
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
		
		router.get('/storageFragmentChunkStatus', async (req, res) => {
			const { hash, wallet, signMessage } = req.query as {
				hash?: string
				wallet?: string
				signMessage?: string
			}
			const ipaddress = getIpAddressFromForwardHeader(req)
			if (!hash || !verifyFragmentWalletSign(wallet, signMessage)) {
				logger(Colors.grey(`Router /storageFragmentChunkStatus auth error ${ipaddress}`))
				return res.status(403).json({ ok: false, error: 'Unauthorized' })
			}

			if (await fragmentFinalExists(hash)) {
				const meta = await readFragmentUploadMeta(hash)
				return res.status(200).json({
					ok: true,
					complete: true,
					received: meta?.totalSize ?? 0,
					totalSize: meta?.totalSize ?? 0,
				})
			}

			const meta = await readFragmentUploadMeta(hash)
			const received = await getFragmentUploadReceivedBytes(hash)
			return res.status(200).json({
				ok: true,
				complete: false,
				received,
				totalSize: meta?.totalSize ?? null,
			})
		})

		const storageFragmentChunkMultipart = fragmentChunkMulter.single('chunk')
		router.post('/storageFragmentChunk', (req: Request, res: Response, next) => {
			const ct = (req.headers['content-type'] || '').toLowerCase()
			if (ct.includes('multipart/form-data')) {
				return storageFragmentChunkMultipart(req, res, next)
			}
			return next()
		}, async (req: any, res: any) => {
			const ipaddress = getIpAddressFromForwardHeader(req)
			let wallet: string | undefined
			let signMessage: string | undefined
			let hash: string | undefined
			let totalSizeN: number
			let offsetN: number
			let chunk: Buffer | undefined

			if (req.file?.buffer) {
				wallet = req.body?.wallet
				signMessage = req.body?.signMessage
				hash = req.body?.hash
				totalSizeN = Number(req.body?.totalSize)
				offsetN = Number(req.body?.offset)
				chunk = req.file.buffer as Buffer
			} else {
				const body = req.body as {
					wallet?: string
					signMessage?: string
					hash?: string
					totalSize?: number
					offset?: number
					chunkBase64?: string
				}
				wallet = body.wallet
				signMessage = body.signMessage
				hash = body.hash
				totalSizeN = Number(body.totalSize)
				offsetN = Number(body.offset)
				if (body.chunkBase64) {
					try {
						chunk = Buffer.from(String(body.chunkBase64), 'base64')
					} catch {
						return res.status(400).json({ ok: false, error: 'Invalid chunkBase64' })
					}
				}
			}

			if (!verifyFragmentWalletSign(wallet, signMessage) || !hash || !chunk) {
				logger(Colors.grey(`Router /storageFragmentChunk auth/format error ${ipaddress}`))
				return res.status(403).json({ ok: false, error: 'Unauthorized' })
			}
			if (!Number.isFinite(totalSizeN) || totalSizeN <= 0 || !Number.isFinite(offsetN) || offsetN < 0) {
				return res.status(400).json({ ok: false, error: 'Invalid totalSize or offset' })
			}
			if (chunk.length === 0 || chunk.length > FRAGMENT_UPLOAD_CHUNK_BYTES) {
				return res.status(400).json({ ok: false, error: 'Invalid chunk size' })
			}

			try {
				const result = await writeFragmentUploadChunk({
					hash,
					wallet: String(wallet),
					totalSize: totalSizeN,
					offset: offsetN,
					chunk,
				})
				return res.status(200).json({ ok: true, ...result })
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				logger(Colors.red(`storageFragmentChunk [${hash}] ${message}`))
				return res.status(400).json({ ok: false, error: message })
			}
		})

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
