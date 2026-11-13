// 隔离测试专用：SUN 合成向量生成器 + 独立校验器（只用合成 key2，不读取任何生产配置）。
// 算法与 src/BeamioSun.ts 的 verifyBeamioSunUrl 保持一致（CMAC 会话密钥、AES-CBC 解密、截断 MAC）。
// 生成的向量分三类：valid（合法）、invalid（MAC 篡改或 UID 不一致）、replay（计数器不新鲜）。
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')

const hexToBytes = (hex) => Buffer.from(hex, 'hex')
const bytesToHex = (b) => Buffer.from(b).toString('hex').toUpperCase()
const ENC_SV_PREFIX = hexToBytes('C33C00010080')
const MAC_SV_PREFIX = hexToBytes('3CC300010080')

const aesEcbEncrypt = (key, block16) => {
  const c = createCipheriv('aes-128-ecb', key, null)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(block16), c.final()])
}
const aesCbcEncryptNoPadding = (plain, key, iv) => {
  const c = createCipheriv('aes-128-cbc', key, iv)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(plain), c.final()])
}
const aesCbcDecryptNoPadding = (ct, key, iv) => {
  const d = createDecipheriv('aes-128-cbc', key, iv)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(ct), d.final()])
}
const leftShiftOneBit = (input) => {
  const out = Buffer.alloc(16, 0)
  let carry = 0
  for (let i = 15; i >= 0; i -= 1) {
    const b = input[i]
    out[i] = ((b << 1) & 0xff) | carry
    carry = (b & 0x80) !== 0 ? 1 : 0
  }
  return out
}
const cmacSubkeys = (l) => {
  const k1 = leftShiftOneBit(l)
  if ((l[0] & 0x80) !== 0) k1[15] ^= 0x87
  const k2 = leftShiftOneBit(k1)
  if ((k1[0] & 0x80) !== 0) k2[15] ^= 0x87
  return [Buffer.from(k1), Buffer.from(k2)]
}
const xor16 = (a, b) => { const o = Buffer.alloc(16, 0); for (let i = 0; i < 16; i++) o[i] = a[i] ^ b[i]; return o }
const aesCmac = (key, message) => {
  const l = aesEcbEncrypt(key, Buffer.alloc(16, 0))
  const [k1, k2] = cmacSubkeys(l)
  const blockCount = message.length === 0 ? 1 : Math.ceil(message.length / 16)
  const lastComplete = message.length > 0 && message.length % 16 === 0
  let mLast
  if (lastComplete) {
    mLast = xor16(Buffer.from(message.subarray((blockCount - 1) * 16, blockCount * 16)), k1)
  } else {
    const start = (blockCount - 1) * 16
    const last = Buffer.alloc(16, 0)
    const remain = start < message.length ? message.subarray(start) : Buffer.alloc(0)
    Buffer.from(remain).copy(last, 0)
    last[remain.length] = 0x80
    mLast = xor16(last, k2)
  }
  let x = Buffer.alloc(16, 0)
  for (let i = 0; i < blockCount - 1; i += 1) {
    x = aesEcbEncrypt(key, xor16(x, Buffer.from(message.subarray(i * 16, (i + 1) * 16))))
  }
  return aesEcbEncrypt(key, xor16(x, mLast))
}
const truncateMac16To8 = (f) => Buffer.from([f[1], f[3], f[5], f[7], f[9], f[11], f[13], f[15]])
const deriveSdmEncIv = (sesEncKey, ctrLsb) => {
  const iv = Buffer.alloc(16, 0)
  ctrLsb.copy(iv, 0)
  return aesEcbEncrypt(sesEncKey, iv)
}

const sessionKeys = (key2, uid, counterLsb) => ({
  enc: aesCmac(key2, Buffer.concat([ENC_SV_PREFIX, uid, counterLsb])),
  mac: aesCmac(key2, Buffer.concat([MAC_SV_PREFIX, uid, counterLsb])),
})

/** 生成一条 SUN URL。counter 为整数（3 字节，c 参数为大端十六进制）。 */
const buildSunUrl = ({ key2Hex, uidHex, counter, tagIdHex, version = 1, baseUrl = 'https://example.invalid/nfc' }) => {
  const key2 = hexToBytes(key2Hex)
  const uid = hexToBytes(uidHex)
  const cMsb = Buffer.alloc(3)
  cMsb.writeUIntBE(counter, 0, 3)
  const cHex = bytesToHex(cMsb)
  const counterLsb = Buffer.from(cMsb).reverse()
  const { enc, mac } = sessionKeys(key2, uid, counterLsb)
  const plain = Buffer.alloc(32, 0)
  uid.copy(plain, 0)
  counterLsb.copy(plain, 7)
  hexToBytes(tagIdHex).copy(plain, 10)
  plain[18] = version
  const e = aesCbcEncryptNoPadding(plain, enc, deriveSdmEncIv(enc, counterLsb))
  const eHex = bytesToHex(e)
  const macInput = `${bytesToHex(uid)}&c=${cHex}&e=${eHex}&m=`
  const mHex = bytesToHex(truncateMac16To8(aesCmac(mac, Buffer.from(macInput, 'ascii'))))
  return { url: `${baseUrl}?uid=${bytesToHex(uid)}&c=${cHex}&e=${eHex}&m=${mHex}`, uidHex: bytesToHex(uid), cHex, eHex, mHex }
}

/** 独立校验（与 BeamioSun.ts 逻辑对齐，不查数据库）：返回 macValid、decrypted tagId、counterValue。 */
const verifySunPure = ({ key2Hex, url }) => {
  const q = (k) => { const m = new URL(url).searchParams.get(k); return m }
  const uidHex = q('uid').toUpperCase(), cHex = q('c').toUpperCase(), eHex = q('e').toUpperCase(), mHex = q('m').toUpperCase()
  const key2 = hexToBytes(key2Hex)
  const uid = hexToBytes(uidHex)
  const counterLsb = Buffer.from(hexToBytes(cHex)).reverse()
  const { enc, mac } = sessionKeys(key2, uid, counterLsb)
  const plain = aesCbcDecryptNoPadding(hexToBytes(eHex), enc, deriveSdmEncIv(enc, counterLsb))
  const embeddedUid = bytesToHex(plain.subarray(0, 7))
  const expected = bytesToHex(truncateMac16To8(aesCmac(mac, Buffer.from(`${uidHex}&c=${cHex}&e=${eHex}&m=`, 'ascii'))))
  return {
    macValid: expected === mHex,
    embeddedUidMatchesInput: embeddedUid === uidHex,
    tagIdHex: bytesToHex(plain.subarray(10, 18)),
    counterValue: parseInt(cHex, 16),
  }
}

/** 生成三类向量。lastCounter：服务端已记录的最新计数器（用于 replay 判定）。 */
const buildVectorSet = ({ key2Hex, uidHex, tagIdHex, lastCounter }) => {
  const valid = buildSunUrl({ key2Hex, uidHex, counter: lastCounter + 1, tagIdHex })
  // 篡改 m 的最后一位（十六进制字符）
  const tamperedM = valid.mHex.slice(0, -1) + (valid.mHex.slice(-1) === '0' ? '1' : '0')
  const invalidMac = { ...valid, mHex: tamperedM, url: valid.url.replace(/m=[0-9A-F]+/, `m=${tamperedM}`) }
  // UID 与密文内嵌 UID 不一致：用另一 UID 的 URL 但替换 uid 参数
  const otherUid = bytesToHex(randomBytes(7))
  const uidMismatch = { ...valid, url: valid.url.replace(/uid=[0-9A-F]+/, `uid=${otherUid}`), note: 'uid 参数与密文内嵌 UID 不一致' }
  const replay = buildSunUrl({ key2Hex, uidHex, counter: lastCounter, tagIdHex })
  return {
    key2Fingerprint: 'synthetic-key2',
    lastCounter,
    vectors: [
      { name: 'valid-fresh', klass: 'valid', expect: { macValid: true, counterFresh: true }, url: valid.url, counter: lastCounter + 1 },
      { name: 'invalid-mac-tampered', klass: 'invalid', expect: { macValid: false }, url: invalidMac.url, counter: lastCounter + 1 },
      { name: 'invalid-uid-mismatch', klass: 'invalid', expect: { embeddedUidMatchesInput: false }, url: uidMismatch.url, counter: lastCounter + 1 },
      { name: 'replay-same-counter', klass: 'replay', expect: { macValid: true, counterFresh: false, note: '相同计数器在 120 秒宽限外视为重放' }, url: replay.url, counter: lastCounter },
    ],
  }
}

module.exports = { buildSunUrl, verifySunPure, buildVectorSet, aesCmac };
