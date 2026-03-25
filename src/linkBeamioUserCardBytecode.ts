import { getAddress, keccak256, toUtf8Bytes } from 'ethers'

/** 与 Hardhat 编译的 BeamioUserCard linkReferences 中短名一致 */
export type BeamioUserCardLibraryAddresses = {
  BeamioUserCardFormattingLib: string
  BeamioUserCardTransferLib: string
}

/**
 * 将未链接的 creation bytecode 按 solc 规则填入 external library 地址。
 */
export function linkBeamioUserCardBytecode(
  bytecode: string,
  linkReferences: Record<string, Record<string, unknown[]>>,
  libraryAddressesByName: BeamioUserCardLibraryAddresses | Record<string, string>
): string {
  let b = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode
  for (const [sourcePath, libs] of Object.entries(linkReferences || {})) {
    for (const libName of Object.keys(libs)) {
      const addr = (libraryAddressesByName as Record<string, string>)[libName]
      if (!addr) {
        throw new Error(`linkBeamioUserCardBytecode: missing address for ${libName}`)
      }
      const fqn = `${sourcePath}:${libName}`
      const hash = keccak256(toUtf8Bytes(fqn))
      const placeholder = ('__$' + hash.slice(2, 36) + '$__').toLowerCase()
      const clean = getAddress(addr).slice(2).toLowerCase()
      const bl = b.toLowerCase()
      const parts = bl.split(placeholder)
      if (parts.length < 2) {
        throw new Error(`linkBeamioUserCardBytecode: placeholder not found for ${libName}`)
      }
      b = parts.join(clean)
    }
  }
  return '0x' + b
}
