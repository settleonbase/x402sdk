import fs from 'node:fs'
import net from 'node:net'

const vault = process.env.EDGE_DAC_VAULT || ''
const probe = process.env.EDGE_DAC_PROBE || ''
const sockets = (process.env.EDGE_DAC_SOCKETS || '').split(',').filter(Boolean)
if (!vault || !probe || sockets.length !== 3) {
	console.error('negative-dac needs EDGE_DAC_VAULT, EDGE_DAC_PROBE and three EDGE_DAC_SOCKETS')
	process.exit(2)
}

function codeOf(fn) {
	try {
		fn()
		return 'ok'
	} catch (err) {
		return err.code || 'error'
	}
}

function connect(sockPath) {
	return new Promise((resolve) => {
		const socket = net.createConnection(sockPath)
		const finish = (code) => {
			socket.removeAllListeners()
			socket.destroy()
			resolve(code)
		}
		socket.once('connect', () => finish('connected'))
		socket.once('error', (err) => finish(err.code || 'error'))
		setTimeout(() => finish('timeout'), 1000)
	})
}

const vaultRead = codeOf(() => fs.readFileSync(vault))
const writeOpt = codeOf(() => fs.writeFileSync(probe, 'nope\n'))
const socketCodes = []
for (const sockPath of sockets) socketCodes.push(`${sockPath}=${await connect(sockPath)}`)
const denied = (code) => code === 'EACCES' || code === 'EPERM'
const ok = denied(vaultRead) && denied(writeOpt) && socketCodes.every((line) => denied(line.split('=').pop()))
console.log(JSON.stringify({ vaultRead, writeOpt, socketCodes, ok }))
process.exit(ok ? 0 : 1)
