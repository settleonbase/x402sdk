// 日志脱敏：金丝雀测试（每个键名 / 值模式 / 失败分支的输入形态）。
// 运行：node --test src/logRedact.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { redactForLog, redactUrlForLog, safeLogJson } from './logRedact.ts'

const C = (tag: string) => `CANARY_${tag}_` + 'f'.repeat(8)
const HEX64 = '0x' + 'ab'.repeat(32)
const PGP = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nxyz' + C('PGP') + '\n-----END PGP PRIVATE KEY BLOCK-----'

test('key names are redacted: privateKey, pk, k, priArmor, passcode, secret, mnemonic, seed', () => {
  for (const key of ['privateKey', 'private_key', 'pk', 'k', 'priArmor', 'passcode', 'secret', 'mnemonic', 'seed', 'passphrase', 'signatureKey']) {
    const out = JSON.stringify(redactForLog({ [key]: C(key) }))
    assert.ok(!out.includes(C(key)), `key ${key} must be redacted`)
    assert.ok(out.includes('<redacted>'))
  }
})

test('value patterns are redacted under innocuous keys: 0x+64hex and PGP private key block', () => {
  const out = JSON.stringify(redactForLog({ note: HEX64, other: PGP, arr: [HEX64] }))
  assert.ok(!out.includes('abababab'), '0x+64hex value must not survive')
  assert.ok(!out.includes(C('PGP')), 'PGP block must not survive')
})

test('no depth limit: secret at depth 12 is redacted', () => {
  let o: Record<string, unknown> = { privateKey: C('DEEP') }
  for (let i = 0; i < 12; i++) o = { lvl: o }
  assert.ok(!JSON.stringify(redactForLog(o)).includes(C('DEEP')))
})

test('secret inside an array of objects is redacted', () => {
  assert.ok(!JSON.stringify(redactForLog({ items: [{ a: 1 }, { privateKey: C('ARR') }] })).includes(C('ARR')))
})

test('circular references do not throw and are marked', () => {
  const a: Record<string, unknown> = { x: 1 }
  a.self = a
  assert.equal((redactForLog(a) as any).self, '[Circular]')
})

test('bigint and very long strings are handled; output is capped', () => {
  const s = safeLogJson({ n: 10n, big: 'z'.repeat(50_000) }, 500)
  assert.ok(s.length <= 500 + 40)
  assert.ok(s.includes('"n": "10"'))
})

test('URL: sensitive query parameters and 0x+64hex values are redacted; path kept', () => {
  const url = `/api/x?uid=04A1&privateKey=${HEX64}&pk=0x1234&note=ok&priArmor=${encodeURIComponent(C('URLARMOR'))}`
  const out = redactUrlForLog(url)
  assert.ok(out.startsWith('/api/x?uid=04A1'))
  assert.ok(!out.includes('abababab') && !out.includes(C('URLARMOR')) && !out.includes('pk=0x1234'))
  assert.ok(out.includes('note=ok'))
})

test('URL: encoded key names are matched after decoding', () => {
  const out = redactUrlForLog(`/p?priv%61teKey=${C('ENC')}`)
  assert.ok(!out.includes(C('ENC')))
})

test('canary never appears in output for a request-shaped body (failing-branch shape)', () => {
  const body = { uid: '04A1B2C3D4E5F6', e: '00', c: '000001', m: '00', privateKey: C('BODY'), nftRedeemcode: 'FAKE', k: C('K') }
  const out = safeLogJson(body)
  assert.ok(!out.includes(C('BODY')) && !out.includes(C('K')))
  assert.ok(out.includes('04A1B2C3D4E5F6'))
})
