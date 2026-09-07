"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAaFactoryAddressFromUserCardFactoryPaymaster = getAaFactoryAddressFromUserCardFactoryPaymaster;
exports.resolveBeamioAaForEoaViaUserCardFactory = resolveBeamioAaForEoaViaUserCardFactory;
exports.resolveBeamioAaOnConet = resolveBeamioAaOnConet;
exports.resolveBeamioAaForEoaWithFallback = resolveBeamioAaForEoaWithFallback;
/**
 * Resolve EOA → AA：仅使用 **链上** `UserCardFactoryPaymaster._aaFactory()` 再 `beamioAccountOf(eoa)`（与发卡工厂绑定的新 AA 工厂一致）。
 *
 * **不再回退 `BASE_AA_FACTORY`（0x4b31…）**：该常量与当前卡工厂 `_aaFactory()` 常不一致，回退会解析到「旧部署」上的 AA，与 OpenContainer / getUIDAssets 卡路径分裂。
 */
const ethers_1 = require("ethers");
const chainAddresses_1 = require("../chainAddresses");
const beamioUserCardChain_1 = require("../beamioUserCardChain");
const userCardFactoryPaymasterAbi = ['function _aaFactory() view returns (address)'];
const aaFactoryAbi = ['function beamioAccountOf(address) view returns (address)'];
async function getAaFactoryAddressFromUserCardFactoryPaymaster(provider, userCardFactoryPaymaster = chainAddresses_1.CONET_CARD_FACTORY) {
    try {
        const fac = new ethers_1.ethers.Contract(userCardFactoryPaymaster, userCardFactoryPaymasterAbi, provider);
        const addr = await fac._aaFactory();
        if (!addr || addr === ethers_1.ethers.ZeroAddress)
            return null;
        const code = await provider.getCode(addr);
        if (!code || code === '0x' || code.length <= 2)
            return null;
        return ethers_1.ethers.getAddress(addr);
    }
    catch {
        return null;
    }
}
async function beamioAaFromFactory(provider, eoa, aaFactoryAddr) {
    try {
        const eoaAddr = ethers_1.ethers.getAddress(eoa);
        const aaFactory = new ethers_1.ethers.Contract(aaFactoryAddr, aaFactoryAbi, provider);
        const primary = await aaFactory.beamioAccountOf(eoaAddr);
        if (!primary || primary === ethers_1.ethers.ZeroAddress)
            return null;
        const code = await provider.getCode(primary);
        return code && code !== '0x' && code.length > 2 ? ethers_1.ethers.getAddress(primary) : null;
    }
    catch {
        return null;
    }
}
/** Prefer factory wired on UserCardFactoryPaymaster (matches getOwnershipByEOA / OpenContainer account). */
async function resolveBeamioAaForEoaViaUserCardFactory(provider, eoa, userCardFactoryPaymaster = chainAddresses_1.CONET_CARD_FACTORY) {
    const aaFac = await getAaFactoryAddressFromUserCardFactoryPaymaster(provider, userCardFactoryPaymaster);
    if (!aaFac)
        return null;
    return beamioAaFromFactory(provider, eoa, aaFac);
}
/** CoNET 224422：跨链同址 BEAMIO_AA_FACTORY 上查已部署 AA（须 getCode 非空）。新 AA 仅在此链部署。 */
async function resolveBeamioAaOnConet(eoa) {
    const provider = (0, beamioUserCardChain_1.providerForUserCardChain)('conet');
    return beamioAaFromFactory(provider, eoa, chainAddresses_1.CONET_AA_FACTORY);
}
/** 解析 EOA → AA：仅 CoNET（224422）；Base 不再部署或回退。`provider` 参数保留兼容，忽略链选择。 */
async function resolveBeamioAaForEoaWithFallback(_provider, eoa, _userCardFactoryPaymaster) {
    return resolveBeamioAaOnConet(eoa);
}
