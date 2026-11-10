import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { bigintReplacer } from './audit'
import type { ProxiedListen, TlsListen, UnixListen } from './config'
import { ErrorCode, SignerError } from './errors'
import { errorMessage } from './redact'
import type { SignerService } from './service'

const MAX_BODY = 256 * 1024

type RpcRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }

/** Identity headers nginx sets on the proxied listener. Lower-case, as Node reports them. */
export const PROXY_HEADERS = {
	cn: 'x-ws-client-cn',
	verify: 'x-ws-client-verify',
	fingerprint: 'x-ws-client-fingerprint',
	serial: 'x-ws-client-serial',
	remoteAddr: 'x-ws-remote-addr',
	proxyAuth: 'x-ws-proxy-auth',
} as const
const PROXY_HEADER_PREFIX = 'x-ws-'
const KNOWN_PROXY_HEADERS = new Set<string>(Object.values(PROXY_HEADERS))
/** Client names are certificate CNs; anything outside this set is refused, whatever nginx sent. */
const CN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

type Via = 'tls' | 'unix' | 'proxied'
type Identity = { client: string; via: Via; fingerprint?: string; serial?: string; remoteAddr?: string }

/**
 * Client JSON-RPC listeners.
 *  - tls: direct TLS. A client certificate signed by the configured CA is required (requestCert +
 *    rejectUnauthorized: a handshake without one fails before any HTTP). Client name = cert CN.
 *  - proxied: behind a local nginx that terminates TLS and verifies the client certificate. The
 *    client name comes from X-WS-Client-CN, trusted only here and only with X-WS-Client-Verify:
 *    SUCCESS. Unix socket preferred; loopback TCP needs the X-WS-Proxy-Auth secret.
 *  - unix: a fixed client per socket (local tools).
 * Any X-WS-* header arriving on tls or unix is a forgery attempt and the request is refused.
 * Optional second factor everywhere: `Authorization: Bearer <token>` against policy tokenSha256.
 */
export function startRpcServers(svc: SignerService, cfg: { tls?: TlsListen; unix?: UnixListen[]; proxied?: ProxiedListen }): Server[] {
	const servers: Server[] = []
	if (cfg.tls) {
		const t = cfg.tls
		const srv = createHttpsServer(
			{
				key: readFileSync(t.key),
				cert: readFileSync(t.cert),
				ca: readFileSync(t.ca),
				requestCert: true,
				rejectUnauthorized: true,
				minVersion: 'TLSv1.3',
			},
			(req, res) => {
				if (rejectForgedProxyHeaders(svc, req, res, 'tls')) return
				const sock = req.socket as TLSSocket
				const cert = sock.getPeerCertificate()
				const cn = sock.authorized && cert?.subject?.CN ? String(cert.subject.CN) : ''
				void handle(svc, { client: cn, via: 'tls', fingerprint: cert?.fingerprint256 }, req, res)
			},
		)
		srv.listen(t.port, t.host)
		servers.push(srv)
	}
	if (cfg.proxied) {
		const p = cfg.proxied
		const secret = p.secretSha256 ? Buffer.from(p.secretSha256.replace(/^0x/, ''), 'hex') : undefined
		const srv = createHttpServer((req, res) => {
			const id = proxiedIdentity(svc, req, res, secret)
			if (id) void handle(svc, id, req, res)
		})
		if (p.path) {
			if (existsSync(p.path)) unlinkSync(p.path)
			srv.listen(p.path, () => chmodSync(p.path!, p.mode ?? 0o660))
		} else {
			srv.listen(p.port, p.host)
		}
		servers.push(srv)
	}
	for (const u of cfg.unix ?? []) {
		if (existsSync(u.path)) unlinkSync(u.path)
		const srv = createHttpServer((req, res) => {
			if (rejectForgedProxyHeaders(svc, req, res, 'unix')) return
			void handle(svc, { client: u.client, via: 'unix' }, req, res)
		})
		srv.listen(u.path, () => chmodSync(u.path, u.mode ?? 0o660))
		servers.push(srv)
	}
	return servers
}

function proxyHeaderNames(req: IncomingMessage): string[] {
	return Object.keys(req.headersDistinct).filter((h) => h.startsWith(PROXY_HEADER_PREFIX))
}

/** On listeners that are not behind nginx, an X-WS-* header can only be a forgery. */
function rejectForgedProxyHeaders(svc: SignerService, req: IncomingMessage, res: ServerResponse, via: Via): boolean {
	const forged = proxyHeaderNames(req)
	if (forged.length === 0) return false
	svc.audit.write({ event: 'deny', via, reason: 'forged_proxy_header', headers: forged })
	send(res, 400, { error: 'identity headers are not accepted on this listener' })
	return true
}

/** One value per header; duplicates mean something upstream passed a client copy through. */
function single(req: IncomingMessage, name: string): string | undefined | null {
	const v = req.headersDistinct[name]
	if (!v) return undefined
	return v.length === 1 ? v[0]! : null
}

function proxiedIdentity(svc: SignerService, req: IncomingMessage, res: ServerResponse, secret?: Buffer): Identity | null {
	const deny = (status: number, reason: string, extra: Record<string, unknown> = {}) => {
		svc.audit.write({ event: 'deny', via: 'proxied', reason, ...extra })
		send(res, status, { error: status === 401 ? 'client certificate required' : 'bad proxy headers' })
		return null
	}
	const unknown = proxyHeaderNames(req).filter((h) => !KNOWN_PROXY_HEADERS.has(h))
	if (unknown.length) return deny(400, 'unknown_proxy_header', { headers: unknown })
	for (const h of KNOWN_PROXY_HEADERS) if (single(req, h) === null) return deny(400, 'duplicate_proxy_header', { header: h })
	if (secret) {
		const got = createHash('sha256').update(single(req, PROXY_HEADERS.proxyAuth) ?? '').digest()
		if (!timingSafeEqual(got, secret)) return deny(403, 'bad_proxy_secret')
	}
	const verify = single(req, PROXY_HEADERS.verify)
	const cn = single(req, PROXY_HEADERS.cn) ?? ''
	const remoteAddr = single(req, PROXY_HEADERS.remoteAddr) ?? undefined
	if (verify !== 'SUCCESS') return deny(401, 'client_cert_not_verified', { verify: verify?.slice(0, 64), remoteAddr })
	if (!CN_PATTERN.test(cn)) return deny(401, 'bad_client_cn', { remoteAddr })
	return {
		client: cn,
		via: 'proxied',
		fingerprint: single(req, PROXY_HEADERS.fingerprint) ?? undefined,
		serial: single(req, PROXY_HEADERS.serial) ?? undefined,
		remoteAddr,
	}
}

async function handle(svc: SignerService, id: Identity, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const client = id.client
	try {
		if (!client) return send(res, 401, { error: 'client certificate required' })
		try {
			svc.authorizeClient(client)
			checkToken(svc, client, req)
		} catch (e) {
			svc.audit.write({ event: 'deny', client, via: id.via, fingerprint: id.fingerprint, serial: id.serial, remoteAddr: id.remoteAddr, reason: 'unauthorized' })
			return send(res, 403, rpcError(null, e))
		}
		if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { state: svc.state })
		if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
		const body = await readBody(req)
		let parsed: RpcRequest
		try {
			parsed = JSON.parse(body) as RpcRequest
		} catch {
			return send(res, 200, rpcError(null, new SignerError(ErrorCode.PARSE_ERROR, 'parse error')))
		}
		try {
			const result = await dispatch(svc, client, parsed)
			return send(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, result })
		} catch (e) {
			return send(res, 200, rpcError(parsed.id ?? null, e))
		}
	} catch (e) {
		return send(res, 500, rpcError(null, e))
	}
}

function checkToken(svc: SignerService, client: string, req: IncomingMessage): void {
	const want = svc.policy.client(client)?.tokenSha256
	if (!want) return
	const header = String(req.headers.authorization ?? '')
	const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
	const got = createHash('sha256').update(token).digest()
	const exp = Buffer.from(want.replace(/^0x/, ''), 'hex')
	if (exp.length !== got.length || !timingSafeEqual(exp, got)) throw new SignerError(ErrorCode.UNAUTHORIZED, 'bad token')
}

async function dispatch(svc: SignerService, client: string, r: RpcRequest): Promise<unknown> {
	const p = r.params
	const obj = (Array.isArray(p) ? p[0] : p) as Record<string, unknown> | undefined
	switch (r.method) {
		case 'signer_status':
			return { state: svc.state, version: svc.status().version, arrays: svc.policy.arraysOf(client), compromised: svc.compromisedList() }
		case 'signer_accounts':
			return svc.accounts(client, obj?.keyArray as string | undefined, obj?.chainId !== undefined ? Number(obj.chainId) : undefined)
		case 'eth_accounts':
			return svc.accounts(client)
		case 'signer_compromised':
			return svc.compromisedList()
		case 'signer_sendTransaction':
			if (!obj) throw new SignerError(ErrorCode.INVALID_PARAMS, 'params object required')
			return svc.sendTransaction(client, obj as never)
		case 'signer_getTransaction':
			return svc.getTransaction(client, (obj ?? {}) as { idempotencyKey?: string; hash?: string })
		case 'eth_signTransaction':
			if (!obj) throw new SignerError(ErrorCode.INVALID_PARAMS, 'tx object required')
			return svc.signTransaction(client, obj)
		case 'eth_signTypedData_v4': {
			if (!Array.isArray(p) || p.length < 2) throw new SignerError(ErrorCode.INVALID_PARAMS, '[address, typedData] required')
			const typed = typeof p[1] === 'string' ? JSON.parse(p[1]) : p[1]
			return svc.signTypedData(client, String(p[0]), typed)
		}
		case 'personal_sign':
			if (!Array.isArray(p) || p.length < 2) throw new SignerError(ErrorCode.INVALID_PARAMS, '[message, address] required')
			return svc.personalSign(client, String(p[0]), String(p[1]))
		case 'eth_sign':
			throw new SignerError(ErrorCode.METHOD_NOT_FOUND, 'eth_sign is disabled')
		default:
			throw new SignerError(ErrorCode.METHOD_NOT_FOUND, `unknown method ${String(r.method)}`)
	}
}

function rpcError(id: unknown, e: unknown): Record<string, unknown> {
	const se = e instanceof SignerError ? e : new SignerError(ErrorCode.INTERNAL, errorMessage(e))
	return { jsonrpc: '2.0', id, error: { code: se.code, message: se.message, data: se.data } }
}

function send(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return
	const text = JSON.stringify(body, bigintReplacer)
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
	res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => {
			size += c.length
			if (size > MAX_BODY) {
				reject(new SignerError(ErrorCode.INVALID_REQUEST, 'body too large'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}
