// 测试专用：生成合成 .master.json（只含合成值，不读取任何生产配置）。
// 方法：在临时 HOME 中反复加载已编译模块，根据首个 TypeError 所在源码行推断缺失字段，补入合成值。
// 用法：node synth-master-config.cjs <build-out 目录> <临时 HOME 目录> <模块，如 endpoint/beamioMaster.js>
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const guard = require('./guard.cjs')
const { Wallet, randomBytes } = { Wallet: require('ethers').Wallet, randomBytes: require('node:crypto').randomBytes }
const [buildDir, home, mod] = process.argv.slice(2)
if (!buildDir || !home || !mod) throw new Error('usage: synth-master-config.cjs <build-out> <HOME> <module>')
const realHome = guard.initTestHome(home)
const cfgFile = path.join(realHome, '.master.json')
guard.assertCanWriteSynthConfig(cfgFile)
if (!fs.existsSync(cfgFile)) { fs.writeFileSync(cfgFile, '{}', { mode: 0o600 }); guard.recordSynthConfig(cfgFile) }
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {}
// 固定的合成 SUN 密钥与 settle 管理键格式（与生产配置的格式约定一致，值为随机合成）
if (!cfg.beamio_nfc) cfg.beamio_nfc = { key2Hex: randomBytes(16).toString('hex').toUpperCase(), key0Hex: randomBytes(16).toString('hex').toUpperCase(), debugSun: false }
const synthKey = () => Wallet.createRandom().privateKey // 每次随机，仅测试用
const synthHex32 = () => randomBytes(32).toString('hex')
const synthBase64 = () => randomBytes(32).toString('base64')
const setPath = (obj, parts, val) => { let o = obj; for (const p of parts.slice(0, -1)) { o[p] = o[p] ?? {}; o = o[p] } o[parts[parts.length - 1]] = val }
const guess = (name, usage) => {
  if (/Key2Hex|key2Hex|key0Hex/.test(name)) return synthHex32()
  if (/SECRET|secret/.test(name)) return synthBase64()
  if (/ID$|KEY_ID/.test(name)) return 'SYNTH-' + name.slice(0, 6)
  if (/endpoint|RPC|rpc|url/i.test(name)) return 'http://127.0.0.1:9'
  if (/Admin|admin|Manager|manager|Key|key|private|Private|Airdrop|Wallet|wallet|Init|init|Claim|Referral|Oracle|Faucet|Point|GB|Reword|reword|Distributor|distributor|Passport|passport|Treasury|Account|Node|node|Deployer|deployer|Owner|owner|Relayer|relayer/i.test(name)) {
    return usage === 'array' ? [synthKey()] : synthKey()
  }
  return usage === 'array' ? [] : 'SYNTH'
}
for (let i = 0; i < 80; i++) {
  let out = ''
  try {
    const runArgs = process.env.SYNTH_START
      ? [path.join(__dirname, 'run-isolated-service.cjs'), buildDir, process.env.SYNTH_START]
      : ['-e', `require('./${path.basename(buildDir)}/${mod}')`]
    out = execFileSync('node', runArgs, {
      cwd: path.dirname(buildDir), env: guard.minimalChildEnv(realHome),
      stdio: ['ignore', 'pipe', 'pipe'], timeout: Number(process.env.SYNTH_TIMEOUT_MS || 25000), encoding: 'utf8',
    })
    console.log(JSON.stringify({ loaded: true, iterations: i, module: mod }))
    break
  } catch (e) {
    if (e.killed || e.signal === 'SIGTERM') { console.log(JSON.stringify({ running_until_timeout: true, iterations: i })); break }
    out = (e.stderr || '') + (e.stdout || '')
  }
  const m = out.match(/Cannot read properties of undefined \(reading '([^']+)'\)/)
  if (!m) { console.log(JSON.stringify({ stop: true, iterations: i, tail: out.split('\n').slice(-12).join('\n').slice(0, 1200) })); break }
  const reading = m[1]
  const srcLine = (out.split('\n').find((l) => l.includes('masterSetup') && l.includes(reading))) || ''
  const chain = srcLine.slice(srcLine.indexOf('masterSetup') + 'masterSetup'.length)
  const idx = chain.indexOf('.' + reading)
  const parts = chain.slice(0, Math.max(idx, 0)).split(/\.|\[|\]/).filter((x) => x && !/^\d+$/.test(x) && !/^\w+\(/.test(x))
  if (parts.length === 0) { console.log(JSON.stringify({ stop: true, reason: 'cannot infer path', reading, srcLine: srcLine.slice(0, 200) })); break }
  const usage = /\[0\]|\.map\(/.test(chain.slice(idx)) ? 'array' : 'scalar'
  const missingPath = parts.join('.')
  const existing = parts.reduce((o, p) => (o ? o[p] : undefined), cfg)
  if (existing !== undefined && !reading) break
  const v = guess(parts[parts.length - 1], usage)
  // settle_contractAdmin 的条目按 viem 约定为不带 0x 的十六进制
  const fixed = parts[parts.length - 1] === 'settle_contractAdmin' ? v.map((x) => x.replace(/^0x/, '')) : v
  setPath(cfg, parts, fixed)
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  guard.recordSynthConfig(cfgFile)
  console.log(JSON.stringify({ added: missingPath, usage, iteration: i }))
}
