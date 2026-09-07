"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TREASURY_STABLE_SWAP_TYPES = exports.treasuryStableSwapPool = exports.CANONICAL_BUINT_ERC20 = exports.CANONICAL_USDC_ERC20 = exports.CANONICAL_GB_ERC20 = exports.CONET_STABLE_SWAP_CHAIN_ID = void 0;
exports.kickTreasuryStableSwapRelay = kickTreasuryStableSwapRelay;
exports.treasuryStableSwapRelayProcess = treasuryStableSwapRelayProcess;
exports.treasuryStableSwapEip712Domain = treasuryStableSwapEip712Domain;
exports.isLocalUsdcStableSwapPair = isLocalUsdcStableSwapPair;
/**
 * ConetTreasuryPeer 本链离线签字 StableSwap — Master Settle_ContractPool 代付。
 * Cluster 完成预检后入队；Master 调用 Offline.bridgeStableSwapWithSignature。
 */
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const chainAddresses_1 = require("./chainAddresses");
const settleContractPool_1 = require("./settleContractPool");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
exports.CONET_STABLE_SWAP_CHAIN_ID = 224422n;
exports.CANONICAL_GB_ERC20 = 1;
exports.CANONICAL_USDC_ERC20 = 2;
exports.CANONICAL_BUINT_ERC20 = 3;
const OFFLINE_ABI = [
    'function bridgeStableSwapWithSignature(address user,uint8 burnAssetKind,uint256 amount,uint256 destinationChainId,address recipient,uint8 creditAssetKind,uint256 minCreditAmount,uint256 nonce,uint256 deadline,bytes signature)',
];
const USDC_PERMIT_ABI = [
    'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
];
exports.treasuryStableSwapPool = [];
function kickTreasuryStableSwapRelay() {
    void treasuryStableSwapRelayProcess().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.red('[treasuryStableSwapRelay] unhandled error:'), msg);
    });
}
function scheduleTreasuryStableSwapRelay() {
    if (exports.treasuryStableSwapPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleSettleConet)()) {
        kickTreasuryStableSwapRelay();
        return;
    }
    setTimeout(() => kickTreasuryStableSwapRelay(), 3000);
}
async function treasuryStableSwapRelayProcess() {
    const job = exports.treasuryStableSwapPool.shift();
    if (!job)
        return;
    const SC = (0, settleContractPool_1.shiftSettleConet)();
    if (!SC) {
        exports.treasuryStableSwapPool.unshift(job);
        return scheduleTreasuryStableSwapRelay();
    }
    try {
        if (job.permit) {
            const usdc = new ethers_1.ethers.Contract(chainAddresses_1.CONET_USDC, USDC_PERMIT_ABI, SC.walletConet);
            const ptx = await usdc.permit(ethers_1.ethers.getAddress(job.user), chainAddresses_1.CONET_TREASURY_CREATE2, BigInt(job.permit.value), BigInt(job.permit.deadline), job.permit.v, job.permit.r, job.permit.s, { gasLimit: 120_000 });
            const prec = await ptx.wait();
            if (prec?.status !== 1)
                throw new Error('USDC permit reverted');
        }
        const offline = new ethers_1.ethers.Contract(chainAddresses_1.CONET_TREASURY_PEER_STABLE_SWAP_OFFLINE, OFFLINE_ABI, SC.walletConet);
        const tx = await offline.bridgeStableSwapWithSignature(ethers_1.ethers.getAddress(job.user), job.burnAssetKind, BigInt(job.amount), BigInt(job.destinationChainId), ethers_1.ethers.getAddress(job.recipient), job.creditAssetKind, BigInt(job.minCreditAmount), BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 800_000 });
        const receipt = await tx.wait();
        if (receipt?.status !== 1)
            throw new Error('bridgeStableSwapWithSignature reverted');
        if (job.res && !job.res.headersSent) {
            job.res
                .status(200)
                .json({
                success: true,
                txHash: tx.hash,
                peer: chainAddresses_1.CONET_TREASURY_PEER,
                offline: chainAddresses_1.CONET_TREASURY_PEER_STABLE_SWAP_OFFLINE,
            })
                .end();
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.shortMessage ?? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[treasuryStableSwapRelay] failed:'), msg);
        if (job.res && !job.res.headersSent) {
            job.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(SC);
        scheduleTreasuryStableSwapRelay();
    }
}
/** EIP-712 domain / types for client + Cluster (verifyingContract = Peer). */
function treasuryStableSwapEip712Domain() {
    return {
        name: 'ConetTreasuryPeer',
        version: '1',
        chainId: Number(exports.CONET_STABLE_SWAP_CHAIN_ID),
        verifyingContract: chainAddresses_1.CONET_TREASURY_PEER,
    };
}
exports.TREASURY_STABLE_SWAP_TYPES = {
    StableSwap: [
        { name: 'user', type: 'address' },
        { name: 'burnAssetKind', type: 'uint8' },
        { name: 'amount', type: 'uint256' },
        { name: 'destinationChainId', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'creditAssetKind', type: 'uint8' },
        { name: 'minCreditAmount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
function isLocalUsdcStableSwapPair(burnKind, creditKind) {
    if (burnKind === creditKind)
        return false;
    if (burnKind < exports.CANONICAL_GB_ERC20 || burnKind > exports.CANONICAL_BUINT_ERC20)
        return false;
    if (creditKind < exports.CANONICAL_GB_ERC20 || creditKind > exports.CANONICAL_BUINT_ERC20)
        return false;
    return burnKind === exports.CANONICAL_USDC_ERC20 || creditKind === exports.CANONICAL_USDC_ERC20;
}
