// 自检：合成 key2，生成向量并用独立校验器验证（只用合成值）。
import { randomBytes } from 'node:crypto'
import { buildSunUrl, verifySunPure, buildVectorSet } from './sun-vectors.mjs'
const key2Hex = randomBytes(16).toString('hex').toUpperCase()   // 合成，每次随机，仅用于本次测试
const uidHex = '04A1B2C3D4E5F6'                                 // 合成 UID（7 字节）
const tagIdHex = '1122334455667788'                              // 合成 TagID（8 字节）
const set = buildVectorSet({ key2Hex, uidHex, tagIdHex, lastCounter: 16 })
const results = set.vectors.map((v) => {
  const r = verifySunPure({ key2Hex, url: v.url })
  const ok = Object.entries(v.expect).filter(([k]) => k !== 'note').every(([k, want]) => {
    if (k === 'counterFresh') return (r.counterValue > set.lastCounter) === want
    return r[k] === want
  })
  return { name: v.name, klass: v.klass, macValid: r.macValid, embeddedUidMatchesInput: r.embeddedUidMatchesInput, tagIdOk: r.tagIdHex === tagIdHex, counterValue: r.counterValue, matchesExpectation: ok }
})
console.log(JSON.stringify({ selfcheck: 'sun-vectors', syntheticKey: true, lastCounter: set.lastCounter, results }, null, 2))
const allOk = results.every((x) => x.matchesExpectation)
process.exitCode = allOk ? 0 : 1
