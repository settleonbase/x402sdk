import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { bigintReplacer } from './audit'
import { ErrorCode, SignerError } from './errors'
import { adminGasRunRefusal } from './gasKeeper'
import { errorMessage } from './redact'
import type { SignerService } from './service'

/**
 * Admin socket: newline-delimited JSON, one request per line. File mode 0660; the directory and
 * group (wsadmin) are set by systemd RuntimeDirectory / tmpfiles. Only admins in that group, after
 * SSH login, can reach it. The unlock password arrives here and is never logged.
 */
export function startAdminServer(svc: SignerService, path: string): Server {
	if (existsSync(path)) unlinkSync(path)
	const srv = createServer((sock) => handleConn(svc, sock))
	srv.listen(path, () => chmodSync(path, 0o660))
	return srv
}

function handleConn(svc: SignerService, sock: Socket): void {
	let buf = ''
	sock.setEncoding('utf8')
	sock.on('data', (chunk: string) => {
		buf += chunk
		if (buf.length > 64 * 1024) {
			sock.destroy()
			return
		}
		let nl: number
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl)
			buf = buf.slice(nl + 1)
			void run(svc, line).then((out) => sock.write(`${JSON.stringify(out, bigintReplacer)}\n`))
		}
	})
	sock.on('error', () => undefined)
}

async function run(svc: SignerService, line: string): Promise<unknown> {
	let req: { cmd?: string; args?: Record<string, unknown> }
	try {
		req = JSON.parse(line)
	} catch {
		return { ok: false, error: 'bad json' }
	}
	const a = req.args ?? {}
	try {
		const result = await exec(svc, req.cmd ?? '', a)
		if (req.cmd !== 'unlock' && req.cmd !== 'status') svc.audit.write({ event: 'admin', cmd: req.cmd })
		return { ok: true, result }
	} catch (e) {
		const code = e instanceof SignerError ? e.code : ErrorCode.INTERNAL
		return { ok: false, code, error: errorMessage(e), data: e instanceof SignerError ? e.data : undefined }
	}
}

async function exec(svc: SignerService, cmd: string, a: Record<string, unknown>): Promise<unknown> {
	switch (cmd) {
		case 'status':
			return svc.status()
		case 'unlock': {
			const pw = a.password
			if (typeof pw !== 'string' || !pw) throw new SignerError(ErrorCode.INVALID_PARAMS, 'password required')
			delete a.password
			return svc.unlock(pw)
		}
		case 'lock':
			svc.lock('admin')
			return svc.status()
		case 'array.list':
			return svc.listArrays()
		case 'array.add':
			return svc.arrayAdd(String(a.name), Number(a.count), (a.chains as number[]).map(Number))
		case 'array.grow':
			return svc.arrayGrow(String(a.name), Number(a.count))
		case 'array.rotate':
			return svc.arrayRotate(String(a.name))
		case 'policy.reload':
			return svc.reloadPolicy()
		case 'client.disable':
			return svc.setClientDisabled(String(a.name), true)
		case 'client.enable':
			return svc.setClientDisabled(String(a.name), false)
		case 'gas.status':
			return svc.gasKeeper.status()
		case 'gas.run': {
			const refusal = adminGasRunRefusal(a)
			if (refusal) throw new SignerError(ErrorCode.INVALID_PARAMS, 'gas run does not accept a caller or a target')
			if (svc.config.gasKeeper.enabled !== true) throw new SignerError(ErrorCode.POLICY_DENIED, 'gas keeper is disabled')
			await svc.gasKeeper.runOnce()
			return svc.gasKeeper.status()
		}
		case 'tx.list':
			return svc.txm.recent(Number(a.limit ?? 20)).map(({ raw: _r, data: _d, ...rest }) => rest)
		case 'compromised.list':
			return svc.compromisedList()
		default:
			throw new SignerError(ErrorCode.METHOD_NOT_FOUND, `unknown command ${cmd}`)
	}
}
