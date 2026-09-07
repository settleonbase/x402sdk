"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.linkBeamioUserCardBytecode = linkBeamioUserCardBytecode;
const ethers_1 = require("ethers");
/**
 * 将未链接的 creation bytecode 按 solc 规则填入 external library 地址。
 */
function linkBeamioUserCardBytecode(bytecode, linkReferences, libraryAddressesByName) {
    let b = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
    for (const [sourcePath, libs] of Object.entries(linkReferences || {})) {
        for (const libName of Object.keys(libs)) {
            const addr = libraryAddressesByName[libName];
            if (!addr) {
                throw new Error(`linkBeamioUserCardBytecode: missing address for ${libName}`);
            }
            const fqn = `${sourcePath}:${libName}`;
            const hash = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(fqn));
            const placeholder = ('__$' + hash.slice(2, 36) + '$__').toLowerCase();
            const clean = (0, ethers_1.getAddress)(addr).slice(2).toLowerCase();
            const bl = b.toLowerCase();
            const parts = bl.split(placeholder);
            if (parts.length < 2) {
                throw new Error(`linkBeamioUserCardBytecode: placeholder not found for ${libName}`);
            }
            b = parts.join(clean);
        }
    }
    return '0x' + b;
}
