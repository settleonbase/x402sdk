// 测试工具共用守卫。目的：防止测试工具在真实 HOME 或生产环境下运行。
// - HOME 必须位于 os.tmpdir() 之下（按真实路径比较），且含本工具写入的标记文件。
// - 启动服务必须 BEAMIO_TEST_MODE=1 且 NODE_ENV 不是 production。
// - 子进程环境使用最小白名单，不继承父进程的全部环境变量。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const MARKER = '.beamio-test-home'
const CONFIG_SIDECAR = '.beamio-synth-config.sha256'

const realTmp = () => fs.realpathSync(os.tmpdir())

const assertUnderTmp = (real) => {
  const tmp = realTmp()
  if (!(real === tmp || real.startsWith(tmp + path.sep))) {
    throw new Error(`refusing: HOME (${real}) is not under os.tmpdir() (${tmp})`)
  }
}

/** 检查已存在的测试 HOME：必须在临时目录下、必须有标记文件。返回真实路径。 */
const assertTestHome = (home) => {
  if (!home) throw new Error('refusing: HOME is not set')
  if (!fs.existsSync(home)) throw new Error(`refusing: HOME does not exist: ${home}`)
  const real = fs.realpathSync(home)
  assertUnderTmp(real)
  if (!fs.existsSync(path.join(real, MARKER))) throw new Error(`refusing: HOME lacks marker ${MARKER}`)
  return real
}

/** 创建或确认测试 HOME：只能在临时目录下；非空且无标记的目录一律拒绝。 */
const initTestHome = (home) => {
  const abs = path.resolve(home)
  // 先按路径前缀检查（未创建前无法 realpath），拒绝在临时目录之外创建任何目录。
  const tmpCandidates = [os.tmpdir(), realTmp()].map((t) => path.resolve(t))
  if (!tmpCandidates.some((t) => abs === t || abs.startsWith(t + path.sep))) {
    throw new Error(`refusing: HOME (${abs}) is not under os.tmpdir()`)
  }
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true, mode: 0o700 })
  const real = fs.realpathSync(abs)
  assertUnderTmp(real)
  const entries = fs.readdirSync(real).filter((e) => e !== MARKER)
  if (!fs.existsSync(path.join(real, MARKER))) {
    if (entries.length > 0) throw new Error('refusing: non-empty HOME without marker')
    fs.writeFileSync(path.join(real, MARKER), 'created by test-harness/isolated; synthetic only\n', { mode: 0o600 })
  }
  return real
}

/** 启动器环境检查。 */
const assertServiceLaunchAllowed = () => {
  if (process.env.BEAMIO_TEST_MODE !== '1') throw new Error('refusing: BEAMIO_TEST_MODE must be 1')
  if (process.env.NODE_ENV === 'production') throw new Error('refusing: NODE_ENV=production')
}

/** 子进程最小环境。 */
const minimalChildEnv = (home, extra = {}) => ({
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: home,
  BASE_RPC_URL: 'http://127.0.0.1:9',
  CONET_RPC_URL: 'http://127.0.0.1:9',
  BEAMIO_TEST_MODE: '1',
  ...extra,
})

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 合成配置：不得覆盖非本工具生成的配置（依赖 sidecar 哈希）。 */
const assertCanWriteSynthConfig = (cfgFile) => {
  if (!fs.existsSync(cfgFile)) return
  const sidecar = path.join(path.dirname(cfgFile), CONFIG_SIDECAR)
  if (!fs.existsSync(sidecar)) throw new Error('refusing: existing .master.json was not written by this tool')
  const recorded = fs.readFileSync(sidecar, 'utf8').trim()
  if (recorded !== sha256File(cfgFile)) throw new Error('refusing: .master.json changed since this tool wrote it')
}

const recordSynthConfig = (cfgFile) => {
  fs.writeFileSync(path.join(path.dirname(cfgFile), CONFIG_SIDECAR), sha256File(cfgFile) + '\n', { mode: 0o600 })
}

module.exports = {
  MARKER, CONFIG_SIDECAR,
  assertTestHome, initTestHome, assertServiceLaunchAllowed,
  minimalChildEnv, assertCanWriteSynthConfig, recordSynthConfig,
}
