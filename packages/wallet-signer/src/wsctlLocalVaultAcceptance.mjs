import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const guard = path.join(root, 'dist/src/noWebSocket.js')
const nodeFlags = ['--disable-sigusr1', '--disallow-code-generation-from-strings', '--require', guard]
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conet-wsctl-local-'))
const etc = path.join(dir, 'etc')
const data = path.join(dir, 'data')
const runDir = path.join(dir, 'run')
for (const d of [etc, data, runDir]) fs.mkdirSync(d)
const cfgPath = path.join(etc, 'config.json')
const adminSock = path.join(runDir, 'admin.sock')
const rpcSock = path.join(runDir, 'rpc.sock')
fs.writeFileSync(path.join(etc, 'policy.json'), JSON.stringify({ version: 1, clients: { 'oracle-daemon': { arrays: {} } } }))
fs.writeFileSync(path.join(etc, 'compromised.json'), JSON.stringify({ addresses: [] }))
fs.writeFileSync(cfgPath, JSON.stringify({
  dataDir: data,
  logDir: data,
  adminSocket: adminSock,
  policyFile: path.join(etc, 'policy.json'),
  compromisedFile: path.join(etc, 'compromised.json'),
  rpc: { unix: [{ path: rpcSock, client: 'oracle-daemon', mode: 384 }] },
  chains: { '224422': { rpcUrls: ['http://127.0.0.1:9'], receiptPollMs: 60000, resendAfterMs: 60000 } },
  gasKeeper: { enabled: false, intervalMs: 60000, chains: {} },
  alerts: {},
  scryptN: 4096,
  keyWaitMs: 1000,
  allowUnsafeTestInit: true,
}))

function spawnNode(args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeFlags, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { err += b })
    child.stdin.end(input ?? '')
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

const bad = await spawnNode([path.join(root, 'dist/src/main.js'), '--config', path.join(dir, 'missing.json')])
console.log('SIGNER_BAD_CONFIG_EXIT', bad.code)
console.log(bad.err.trim())

const init = await spawnNode([path.join(root, 'dist/src/wsctl.js'), '--config', cfgPath, 'init', '--unsafe-test-init', '--password-stdin'], 'local-test-password\n')
console.log('WSCTL_INIT_EXIT', init.code)
console.log(init.err.trim())
console.log(init.out.trim())

const svc = spawn(process.execPath, [...nodeFlags, path.join(root, 'dist/src/main.js'), '--config', cfgPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
let slog = ''
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('signer did not start: ' + slog)), 8000)
  svc.stdout.on('data', (b) => {
    slog += b
    if (String(b).includes('started LOCKED')) {
      clearTimeout(t)
      resolve()
    }
  })
  svc.stderr.on('data', (b) => { slog += b })
})
console.log('SIGNER_STARTED', slog.trim())

const status = await spawnNode([path.join(root, 'dist/src/wsctl.js'), '--config', cfgPath, 'status'])
console.log('WSCTL_STATUS_LOCKED_EXIT', status.code)
console.log(status.out.trim())
console.log(status.err.trim())

const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signer_sendTransaction', params: { chainId: 224422, to: '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008', data: '0x0936c703', value: '0', keyArray: 'beamio_oracle_owner' } })
const lockedRpc = await new Promise((resolve) => {
  const req = http.request({ socketPath: rpcSock, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rpcBody) } }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
  req.on('error', (e) => resolve(String(e)))
  req.end(rpcBody)
})
console.log('LOCKED_SEND', lockedRpc)

const unlock = await spawnNode([path.join(root, 'dist/src/wsctl.js'), '--config', cfgPath, 'unlock', '--password-stdin'], 'local-test-password\n')
console.log('WSCTL_UNLOCK_EXIT', unlock.code)
console.log(unlock.out.trim())
console.log(unlock.err.trim())
const status2 = await spawnNode([path.join(root, 'dist/src/wsctl.js'), '--config', cfgPath, 'status'])
console.log('WSCTL_STATUS_NEXT_EXIT', status2.code)
console.log(status2.out.trim())

svc.kill('SIGTERM')
await new Promise((r) => svc.once('exit', r))
console.log('SIGNER_STOPPED')

const rpc = await spawnNode([path.join(root, 'src/httpRpcDisconnectAcceptance.js')])
console.log('RPC_CHILD_EXIT', rpc.code)
console.log(rpc.out.trim())
console.log(rpc.err.trim())
if (rpc.code !== 0) process.exit(rpc.code ?? 1)
console.log('LOCAL_DONE')
