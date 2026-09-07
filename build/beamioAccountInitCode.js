"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BEAMIO_ACCOUNT_ENTRY_POINT_V07 = void 0;
exports.buildBeamioAccountInitCode = buildBeamioAccountInitCode;
const ethers_1 = require("ethers");
const BeamioAccountArtifact_json_1 = __importDefault(require("./ABI/BeamioAccountArtifact.json"));
/** ERC-4337 v0.7 EntryPoint on Base / 与 BeamioFactoryPaymasterV07.ENTRY_POINT 一致 */
exports.BEAMIO_ACCOUNT_ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
/**
 * 生成 BeamioAccount 的部署 initCode（constructor(EntryPoint) + bytecode），
 * 与链上 BeamioFactoryPaymasterV07._initCode() 使用的编码一致；用于 CREATE2 地址预测、UserOp.initCode 等。
 */
async function buildBeamioAccountInitCode(entryPoint = exports.BEAMIO_ACCOUNT_ENTRY_POINT_V07) {
    if (!entryPoint.startsWith('0x') || entryPoint.length !== 42) {
        throw new Error('buildBeamioAccountInitCode: invalid entryPoint address');
    }
    const art = BeamioAccountArtifact_json_1.default;
    if (!art?.bytecode) {
        throw new Error('BeamioAccountArtifact missing bytecode — run BeamioContract: npm run compile && node scripts/syncBeamioAccountToX402sdk.mjs');
    }
    const factory = new ethers_1.ContractFactory(art.abi, art.bytecode);
    const deployTx = await factory.getDeployTransaction(entryPoint);
    const data = deployTx?.data;
    if (!data || typeof data !== 'string') {
        throw new Error('Failed to build BeamioAccount initCode');
    }
    return data;
}
