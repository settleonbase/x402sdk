// 交叉校验：加载 clean 构建产物中的真实 BeamioSun.js（util/db/logger 以合成桩替代，不连接数据库），
// 用 sun-vectors.mjs 生成的向量调用真实 verifyBeamioSunUrl，比较 macValid / counterFresh / embeddedUid。
// 用法：node crosscheck-real-sun.cjs <build-out 目录>
const path = require('node:path')
const Module = require('node:module')
const { randomBytes } = require('node:crypto')
const buildDir = process.argv[2]
if (!buildDir) throw new Error('usage: node crosscheck-real-sun.cjs <build-out dir>')
const key2Hex = randomBytes(16).toString('hex').toUpperCase() // 合成
let lastCounterHex = '000010'
const stubs = {
  './util': { masterSetup: { beamio_nfc: { key2Hex } } },
  './db': { getBeamioSunLastCounterStateByUid: async () => (lastCounterHex ? { lastCounterHex, updatedAt: new Date(0) } : null) },
  './logger': { logger: () => {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.startsWith(buildDir) && stubs[request]) return stubs[request]
  return origLoad.apply(this, arguments)
}
const real = require(path.join(buildDir, 'BeamioSun.js'))
const gen = require('./sun-vectors.cjs')
;(async () => {
  const uidHex = '04A1B2C3D4E5F6', tagIdHex = '1122334455667788'
  const set = gen.buildVectorSet({ key2Hex, uidHex, tagIdHex, lastCounter: 16 })
  const out = []
  for (const v of set.vectors) {
    const r = await real.verifyBeamioSunUrl(v.url)
    out.push({ name: v.name, macValid: r.macValid, counterFresh: r.counterFresh, embeddedUidMatchesInput: r.embeddedUidMatchesInput, tagIdOk: r.tagIdHex === tagIdHex, valid: r.valid })
  }
  console.log(JSON.stringify({ crosscheck: 'real BeamioSun.verifyBeamioSunUrl vs synthetic vectors', buildDir: path.basename(path.dirname(buildDir)) + '/' + path.basename(buildDir), dbStubbed: true, syntheticKey: true, results: out }, null, 2))
})().catch((e) => { console.error(e); process.exit(1) })
