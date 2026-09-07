"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unwrapTrueEoaFromBeamioAa = unwrapTrueEoaFromBeamioAa;
exports.resolveBeamioWalletIdentityFromAddress = resolveBeamioWalletIdentityFromAddress;
/**
 * Resolve a pasted wallet address to canonical Beamio EOA + optional CoNET AA.
 * Used by search-users (address query) and multisig co-signer flows.
 */
const ethers_1 = require("ethers");
const chainAddresses_1 = require("./chainAddresses");
const resolveBeamioAaViaUserCardFactory_1 = require("./endpoint/resolveBeamioAaViaUserCardFactory");
const util_1 = require("./util");
const aaFactoryAbi = [
    'function isBeamioAccount(address) view returns (bool)',
    'function beamioAccountOf(address) view returns (address)',
];
const ownerAbi = ['function owner() view returns (address)'];
async function readContractOwner(provider, addr) {
    try {
        const c = new ethers_1.ethers.Contract(addr, ownerAbi, provider);
        const o = (await c.owner());
        if (!o || o === ethers_1.ethers.ZeroAddress)
            return null;
        return ethers_1.ethers.getAddress(o);
    }
    catch {
        return null;
    }
}
async function readIsBeamioAccount(provider, addr) {
    try {
        const fac = new ethers_1.ethers.Contract(chainAddresses_1.CONET_AA_FACTORY, aaFactoryAbi, provider);
        return Boolean(await fac.isBeamioAccount(addr));
    }
    catch {
        return false;
    }
}
/**
 * Walk Beamio AA `owner()` until a non-AA address (true EOA).
 * Prevents treating a nested AA's owner (primary AA) as the EOA.
 */
async function unwrapTrueEoaFromBeamioAa(maybeAaOrEoa, conet, maxDepth = 8) {
    let cur = ethers_1.ethers.getAddress(maybeAaOrEoa);
    for (let depth = 0; depth < maxDepth; depth++) {
        const isAcct = await readIsBeamioAccount(conet, cur);
        if (!isAcct)
            return cur;
        const owner = await readContractOwner(conet, cur);
        if (!owner || owner.toLowerCase() === cur.toLowerCase())
            return cur;
        cur = owner;
    }
    return cur;
}
/** CoNET getCode + factory isBeamioAccount + owner() → EOA; beamioAccountOf(eoa) → AA. */
async function resolveBeamioWalletIdentityFromAddress(input, opts) {
    if (!ethers_1.ethers.isAddress(input))
        return null;
    const queriedAddress = ethers_1.ethers.getAddress(input);
    const conet = opts?.conetProvider ?? new ethers_1.ethers.JsonRpcProvider(chainAddresses_1.CONET_RPC_URL);
    const base = opts?.baseProvider ?? new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioBaseHttpRpcUrl)());
    let code = '';
    try {
        code = await conet.getCode(queriedAddress);
    }
    catch {
        code = '';
    }
    const isContract = Boolean(code && code !== '0x' && code.length > 2);
    if (!isContract) {
        const aaAccount = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(queriedAddress);
        return { queriedAddress, eoa: queriedAddress, aaAccount, inputKind: 'eoa' };
    }
    const isBeamioAa = await readIsBeamioAccount(conet, queriedAddress);
    if (isBeamioAa) {
        const trueEoa = await unwrapTrueEoaFromBeamioAa(queriedAddress, conet);
        const aaFromEoa = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(trueEoa);
        return {
            queriedAddress,
            eoa: trueEoa,
            aaAccount: aaFromEoa ?? queriedAddress,
            inputKind: 'aa',
        };
    }
    let owner = await readContractOwner(conet, queriedAddress);
    if (!owner) {
        owner = await readContractOwner(base, queriedAddress);
    }
    if (owner) {
        const trueEoa = await unwrapTrueEoaFromBeamioAa(owner, conet);
        const aaFromEoa = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(trueEoa);
        return {
            queriedAddress,
            eoa: trueEoa,
            aaAccount: aaFromEoa,
            inputKind: 'contract',
        };
    }
    return {
        queriedAddress,
        eoa: queriedAddress,
        aaAccount: null,
        inputKind: 'contract',
    };
}
