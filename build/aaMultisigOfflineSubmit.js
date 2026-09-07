"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AA_MULTISIG_OFFLINE_SUBMIT_BUNIT_UNITS6 = exports.BEAMIO_AA_MULTISIG_TYPE = void 0;
exports.aaMultisigOfflineSubmitBunitPreCheck = aaMultisigOfflineSubmitBunitPreCheck;
exports.buildAaMultisigOfflineSubmitDedupeKey = buildAaMultisigOfflineSubmitDedupeKey;
exports.aaMultisigOfflineSubmitPreCheck = aaMultisigOfflineSubmitPreCheck;
/**
 * AA Smart Wallet multisig offline sign/reject API — Cluster precheck (0.1 B-Unit + inner validation).
 */
const ethers_1 = require("ethers");
const chainAddresses_1 = require("./chainAddresses");
const util_1 = require("./util");
exports.BEAMIO_AA_MULTISIG_TYPE = 'beamio_aa_multisig_v1';
/** 与 Discover 社交互动一致：每笔 0.1 B-Unit。 */
exports.AA_MULTISIG_OFFLINE_SUBMIT_BUNIT_UNITS6 = 100000n;
const JSONRPC_NO_BATCH = { batchMaxCount: 1, batchStallTime: 0 };
const providerConet = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)(), undefined, JSONRPC_NO_BATCH);
const AA_FACTORY_READ_ABI = ['function beamioAccountOf(address) view returns (address)'];
async function pickOfflineSubmitBunitConsumer(submitterEoa, aaAccount) {
    const feeBUnits6 = exports.AA_MULTISIG_OFFLINE_SUBMIT_BUNIT_UNITS6;
    const eoaN = ethers_1.ethers.getAddress(submitterEoa);
    const bunitAirdropRead = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUNIT_AIRDROP_ADDRESS, ['function getBUnitBalance(address) view returns (uint256)'], providerConet);
    const balEoa = (await bunitAirdropRead.getBUnitBalance(eoaN));
    if (balEoa >= feeBUnits6) {
        return { ok: true, consumer: eoaN };
    }
    const tryAa = async (aaRaw) => {
        if (!aaRaw || !ethers_1.ethers.isAddress(aaRaw))
            return null;
        const aaN = ethers_1.ethers.getAddress(aaRaw);
        if (aaN.toLowerCase() === eoaN.toLowerCase())
            return null;
        const balAa = (await bunitAirdropRead.getBUnitBalance(aaN));
        if (balAa >= feeBUnits6)
            return { ok: true, consumer: aaN };
        return null;
    };
    if (ethers_1.ethers.isAddress(aaAccount)) {
        const hit = await tryAa(aaAccount);
        if (hit)
            return hit;
    }
    try {
        const factory = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_AA_FACTORY, AA_FACTORY_READ_ABI, providerConet);
        const linkedAa = (await factory.beamioAccountOf(eoaN));
        if (linkedAa && ethers_1.ethers.isAddress(linkedAa) && linkedAa !== ethers_1.ethers.ZeroAddress) {
            const hit = await tryAa(linkedAa);
            if (hit)
                return hit;
        }
    }
    catch {
        /* ignore factory read failure */
    }
    return {
        ok: false,
        error: `Insufficient B-Units: need ${Number(feeBUnits6) / 1e6} B-Units (EOA balance ${Number(balEoa) / 1e6})`,
    };
}
async function aaMultisigOfflineSubmitBunitPreCheck(submitterEoa, aaAccount) {
    const picked = await pickOfflineSubmitBunitConsumer(submitterEoa, aaAccount);
    if (!picked.ok)
        return { success: false, error: picked.error };
    return { success: true, feePayer: picked.consumer, feeAmount: exports.AA_MULTISIG_OFFLINE_SUBMIT_BUNIT_UNITS6 };
}
const AA_THRESHOLD_MANAGER_ABI = ['function isThresholdManager(address) view returns (bool)'];
function verifyUserOpSignature(signerEoa, userOpHash, signature) {
    try {
        const recovered = ethers_1.ethers.verifyMessage(ethers_1.ethers.getBytes(userOpHash), signature);
        return recovered.toLowerCase() === signerEoa.toLowerCase();
    }
    catch {
        return false;
    }
}
function parseInner(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const o = raw;
    if (o.type !== exports.BEAMIO_AA_MULTISIG_TYPE)
        return null;
    if (o.action !== 'sign')
        return null;
    if (typeof o.taskId !== 'string' || !o.taskId.trim())
        return null;
    if (typeof o.aaAccount !== 'string' || !ethers_1.ethers.isAddress(o.aaAccount))
        return null;
    if (typeof o.sendId !== 'string' || !o.sendId.trim())
        return null;
    if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt))
        return null;
    if (typeof o.signerEoa !== 'string' || !ethers_1.ethers.isAddress(o.signerEoa))
        return null;
    const inner = {
        type: exports.BEAMIO_AA_MULTISIG_TYPE,
        action: o.action,
        taskId: o.taskId.trim(),
        aaAccount: ethers_1.ethers.getAddress(o.aaAccount),
        sendId: o.sendId.trim(),
        createdAt: o.createdAt,
        signerEoa: ethers_1.ethers.getAddress(o.signerEoa),
    };
    if (o.action === 'sign') {
        if (typeof o.userOpHash !== 'string' || !ethers_1.ethers.isHexString(o.userOpHash) || ethers_1.ethers.dataLength(o.userOpHash) !== 32) {
            return null;
        }
        if (typeof o.signature !== 'string' || !o.signature.startsWith('0x') || o.signature.length < 132) {
            return null;
        }
        inner.userOpHash = o.userOpHash;
        inner.signature = o.signature;
    }
    return inner;
}
function buildAaMultisigOfflineSubmitDedupeKey(inner) {
    const signer = inner.signerEoa.toLowerCase();
    const hash = (inner.userOpHash ?? '').toLowerCase();
    return `${inner.taskId}:${inner.action}:${signer}:${hash}`;
}
async function assertSignerIsThresholdManager(aaAccount, signerEoa, provider) {
    try {
        const aa = new ethers_1.ethers.Contract(aaAccount, AA_THRESHOLD_MANAGER_ABI, provider);
        const ok = (await aa.isThresholdManager(signerEoa));
        if (!ok)
            return 'Signer is not a Smart Wallet threshold manager';
        return null;
    }
    catch (e) {
        const err = e;
        return `Smart Wallet manager check failed: ${err?.shortMessage ?? err?.message ?? String(e)}`;
    }
}
/** Cluster：离线签字/拒绝提交 — 校验 inner + submitter B-Unit ≥ 0.1。 */
async function aaMultisigOfflineSubmitPreCheck(body) {
    const inner = parseInner(body.inner);
    if (!inner) {
        return { success: false, error: 'Invalid multisig sign packet (expected beamio_aa_multisig_v1 action=sign)' };
    }
    if (!body.submitterEoa || !ethers_1.ethers.isAddress(body.submitterEoa)) {
        return { success: false, error: 'Invalid submitterEoa' };
    }
    const submitterEoa = ethers_1.ethers.getAddress(body.submitterEoa);
    if (submitterEoa.toLowerCase() !== inner.signerEoa.toLowerCase()) {
        return { success: false, error: 'submitterEoa must match inner.signerEoa' };
    }
    if (inner.action === 'sign') {
        if (!inner.userOpHash || !inner.signature) {
            return { success: false, error: 'sign packet requires userOpHash and signature' };
        }
        if (!verifyUserOpSignature(inner.signerEoa, inner.userOpHash, inner.signature)) {
            return { success: false, error: 'Invalid UserOp signature for signerEoa' };
        }
    }
    const managerErr = await assertSignerIsThresholdManager(inner.aaAccount, inner.signerEoa, providerConet);
    if (managerErr)
        return { success: false, error: managerErr };
    const bunitCheck = await aaMultisigOfflineSubmitBunitPreCheck(submitterEoa, inner.aaAccount);
    if (!bunitCheck.success) {
        return { success: false, error: bunitCheck.error };
    }
    return {
        success: true,
        preChecked: {
            inner,
            submitterEoa,
            feePayer: bunitCheck.feePayer,
            feeAmount: String(bunitCheck.feeAmount),
            dedupeKey: buildAaMultisigOfflineSubmitDedupeKey(inner),
        },
    };
}
