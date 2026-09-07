"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatIndexPointerPool = void 0;
exports.kickChatIndexPointerRelay = kickChatIndexPointerRelay;
exports.chatIndexPointerRelayProcess = chatIndexPointerRelayProcess;
/**
 * ChatIndexRegistry — gasless encrypted-chat-history index pointer relay (Master pool).
 *
 * A wallet signs `SetPointer(owner,indexHash,ts,seq,nonce)` offline (EIP-712). ANYONE may submit
 * that signed update; this relayer (Master settle pool) pays gas. Only the owner's signature can
 * move the owner's pointer, so the write right is protected by the private key.
 */
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const chainAddresses_1 = require("./chainAddresses");
const settleContractPool_1 = require("./settleContractPool");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
const CHAT_INDEX_REGISTRY_ABI = [
    'function setPointerWithSig(address owner,bytes32 indexHash,uint64 ts,uint64 seq,uint256 nonce,bytes signature)',
];
exports.chatIndexPointerPool = [];
function kickChatIndexPointerRelay() {
    void chatIndexPointerRelayProcess().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.red('[chatIndexPointerRelay] unhandled error:'), msg);
    });
}
function scheduleChatIndexPointerRelay() {
    if (exports.chatIndexPointerPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleSettleConet)()) {
        kickChatIndexPointerRelay();
        return;
    }
    setTimeout(() => kickChatIndexPointerRelay(), 3000);
}
async function chatIndexPointerRelayProcess() {
    const job = exports.chatIndexPointerPool.shift();
    if (!job)
        return;
    const SC = (0, settleContractPool_1.shiftSettleConet)();
    if (!SC) {
        exports.chatIndexPointerPool.unshift(job);
        return scheduleChatIndexPointerRelay();
    }
    try {
        const registry = new ethers_1.ethers.Contract(chainAddresses_1.CONET_CHAT_INDEX_REGISTRY, CHAT_INDEX_REGISTRY_ABI, SC.walletConet);
        const tx = await registry.setPointerWithSig(ethers_1.ethers.getAddress(job.owner), job.indexHash, BigInt(job.ts), BigInt(job.seq), BigInt(job.nonce), job.signature, { gasLimit: 150_000 });
        const receipt = await tx.wait();
        if (receipt?.status !== 1)
            throw new Error('setPointerWithSig reverted');
        if (job.res && !job.res.headersSent) {
            job.res.status(200).json({ success: true, txHash: tx.hash }).end();
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.shortMessage ?? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[chatIndexPointerRelay] failed:'), msg);
        if (job.res && !job.res.headersSent) {
            job.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(SC);
        scheduleChatIndexPointerRelay();
    }
}
