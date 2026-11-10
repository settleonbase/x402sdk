import { request as httpRequest } from 'node:http'
import { ORACLE_SOCKET_PATH } from './constants'
import { assertConetOracleTarget, type OracleTx } from './plan'
import { SignerCallError } from './refusal'

type RpcError = { code?: number; message?: string }
type RpcBody = { result?: { hash?: unknown }; error?: RpcError }

/**
 * One JSON-RPC call on the dedicated oracle socket. There is no retry.
 * A locked signer is a refusal, not a quote.
 */
export function signerSendOnce(tx: OracleTx, socketPath: string = ORACLE_SOCKET_PATH): Promise<{ hash: string }> {
	assertConetOracleTarget({ chainId: tx.chainId, to: tx.to, value: tx.value })
	const selector = tx.data.slice(0, 10).toLowerCase()
	if (selector !== '0x0936c703' && selector !== '0x3c766394') {
		return Promise.reject(new SignerCallError(-32602, `refusing selector ${selector}`))
	}
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'signer_sendTransaction',
		params: tx,
	})
	return new Promise((resolve, reject) => {
		let settled = false
		const fail = (code: number, message: string) => {
			if (settled) return
			settled = true
			reject(new SignerCallError(code, message))
		}
		const req = httpRequest(
			{
				socketPath,
				path: '/rpc',
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(body),
				},
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					let parsed: RpcBody
					try {
						parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcBody
					} catch {
						fail(-32603, 'signer response was not JSON')
						return
					}
					if (parsed.error) {
						fail(Number(parsed.error.code ?? -32603), parsed.error.message || 'signer refused')
						return
					}
					const hash = parsed.result?.hash
					if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
						fail(-32603, 'signer response had no transaction hash')
						return
					}
					if (settled) return
					settled = true
					resolve({ hash })
				})
			},
		)
		req.setTimeout(60_000, () => {
			req.destroy()
			fail(-32099, 'signer socket timed out')
		})
		req.on('error', (err: NodeJS.ErrnoException) => {
			fail(-32099, `signer socket failed: ${err.message}`)
		})
		req.end(body)
	})
}
