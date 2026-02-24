import crypto from 'crypto'

/**
 * 生成 16 bytes (128-bit) 系统 MasterKey
 * @returns {Buffer}
 */
export function generateSystemMasterKey() {
  return crypto.randomBytes(16) // 128-bit
}

/**
 * 生成 HEX 格式 MasterKey（32 hex chars）
 * @returns {string}
 */
export function generateSystemMasterKeyHex() {
  return crypto.randomBytes(16).toString('hex').toUpperCase()
}


console.log(generateSystemMasterKeyHex())	