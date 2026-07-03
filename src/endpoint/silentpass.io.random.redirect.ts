import Express from 'express'
import { createServer } from 'node:http'
import Colors from 'colors/safe'
import { ethers } from 'ethers'
import { logger } from '../logger'
import newNodeInfoABI from '../ABI/newNodeInfoABI.json'

/** Default 14000 — do not use 4000 (Prysm beacon gRPC on L1 nodes). Override via SILENTPASS_REDIRECT_PORT. */
const DEFAULT_SILENTPASS_REDIRECT_PORT = 14000

type NodeInfo = {
	ip_addr: string
	armoredPublicKey: string
	domain: string
	nftNumber: number
	region: string
}

const GuardianNodeInfo_mainnet = '0xBC6b53065b5647261396d002bDBA0d3396E0722f'
const CONET_MAINNET = new ethers.JsonRpcProvider('https://publicrpc.conet.network')
const GuardianNodesMainnet = new ethers.Contract(GuardianNodeInfo_mainnet, newNodeInfoABI, CONET_MAINNET)

let Guardian_Nodes: NodeInfo[] = []

const getAllNodes = () =>
	new Promise<boolean>(async (resolve) => {
		try {
			const _nodes = await GuardianNodesMainnet.getAllNodes(0, 1000)
			Guardian_Nodes = []
			for (let i = 0; i < _nodes.length; i++) {
				const node = _nodes[i]
				Guardian_Nodes.push({
					nftNumber: parseInt(node[0].toString()),
					armoredPublicKey: Buffer.from(node[1], 'base64').toString(),
					domain: node[2],
					ip_addr: node[3],
					region: node[4],
				})
			}
			logger(Colors.red(`getAllNodes success, Guardian_Nodes = ${Guardian_Nodes.length}`))
			resolve(true)
		} catch (ex) {
			logger('getAllNodes error', ex)
			resolve(false)
		}
	})

const getRandomNode = () => {
	if (!Guardian_Nodes.length) return null
	return Guardian_Nodes[Math.floor(Math.random() * Guardian_Nodes.length)]
}

function resolveRedirectPort(): number {
	const raw = process.env.SILENTPASS_REDIRECT_PORT?.trim()
	const n = raw ? Number(raw) : DEFAULT_SILENTPASS_REDIRECT_PORT
	if (!Number.isFinite(n) || n <= 0 || n >= 65536) {
		logger(
			Colors.yellow(
				`invalid SILENTPASS_REDIRECT_PORT=${raw ?? ''}; using ${DEFAULT_SILENTPASS_REDIRECT_PORT}`
			)
		)
		return DEFAULT_SILENTPASS_REDIRECT_PORT
	}
	if (n === 4000) {
		logger(
			Colors.yellow(
				'SILENTPASS_REDIRECT_PORT=4000 conflicts with Prysm beacon gRPC; using 14000 instead'
			)
		)
		return DEFAULT_SILENTPASS_REDIRECT_PORT
	}
	return n
}

class ConetSilentPassRedirectServer {
	private readonly PORT = resolveRedirectPort()

	constructor() {
		void this.startServer()
	}

	private startServer = async () => {
		const app = Express()
		app.disable('x-powered-by')
		app.use(Express.json())

		app.all('*', (req: any, res: any) => {
			let search = ''
			try {
				const url = new URL(req.url, `https://${req.headers.host}`)
				search = url.search
			} catch (ex) {
				logger(`URL parse error: ${ex}`)
			}

			logger(`url = ${req.url} Search = ${search}`)
			const node = getRandomNode()
			if (!node) {
				return res.redirect(301, `https://silentpass.io/download/index.html`)
			}
			res.redirect(302, `https://${node.domain}.conet.network/download/index.html${search}`)
		})

		await getAllNodes()
		logger(`start silentpass redirect server on 127.0.0.1:${this.PORT}`)

		const server = createServer(app)
		server.listen(this.PORT, '127.0.0.1', () => {
			console.table([{ 'CoNET SilentPass redirect': `started on 127.0.0.1:${this.PORT}` }])
		})
	}
}

new ConetSilentPassRedirectServer()
