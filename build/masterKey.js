"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSystemMasterKey = generateSystemMasterKey;
exports.generateSystemMasterKeyHex = generateSystemMasterKeyHex;
const crypto_1 = __importDefault(require("crypto"));
/**
 * 生成 16 bytes (128-bit) 系统 MasterKey
 * @returns {Buffer}
 */
function generateSystemMasterKey() {
    return crypto_1.default.randomBytes(16); // 128-bit
}
/**
 * 生成 HEX 格式 MasterKey（32 hex chars）
 * @returns {string}
 */
function generateSystemMasterKeyHex() {
    return crypto_1.default.randomBytes(16).toString('hex').toUpperCase();
}
console.log(generateSystemMasterKeyHex());
