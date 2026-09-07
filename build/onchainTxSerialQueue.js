"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE = exports.CONET_VALIDATOR_REDEEM_WORKFLOW_ONCHAIN_LANE = exports.CONET_VALIDATOR_NODE_ONCHAIN_LANE = void 0;
exports.enqueueOnchainTxWork = enqueueOnchainTxWork;
exports.waitForOnchainTxQueue = waitForOnchainTxQueue;
exports.waitForAllOnchainTxQueues = waitForAllOnchainTxQueues;
exports.onchainTxLaneForSigner = onchainTxLaneForSigner;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
class OnchainTxSerialLane {
    laneKey;
    logPrefix;
    queue = [];
    inFlight = false;
    currentLabel;
    constructor(laneKey, logPrefix) {
        this.laneKey = laneKey;
        this.logPrefix = logPrefix;
    }
    depth() {
        return this.queue.length + (this.inFlight ? 1 : 0);
    }
    enqueue(label, fn) {
        return new Promise((resolve, reject) => {
            const waiting = this.queue.length;
            this.queue.push({
                label,
                run: fn,
                resolve: resolve,
                reject,
                enqueuedAt: Date.now(),
            });
            if (waiting > 0 || this.inFlight) {
                (0, logger_1.logger)(safe_1.default.yellow(`${this.logPrefix} tx queue +${label} lane=${this.laneKey} waiting=${waiting + (this.inFlight ? 1 : 0)}`));
            }
            void this.drain();
        });
    }
    async drain() {
        if (this.inFlight)
            return;
        this.inFlight = true;
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            const waitMs = Date.now() - item.enqueuedAt;
            const behind = this.queue.length;
            this.currentLabel = item.label;
            if (waitMs > 500 || behind > 0) {
                (0, logger_1.logger)(safe_1.default.cyan(`${this.logPrefix} tx start ${item.label} lane=${this.laneKey} (queued ${waitMs}ms; ${behind} behind)`));
            }
            try {
                const result = await item.run();
                item.resolve(result);
            }
            catch (e) {
                item.reject(e);
            }
            finally {
                this.currentLabel = undefined;
            }
        }
        this.inFlight = false;
    }
    async waitIdle(maxWaitMs = 30 * 60 * 1000) {
        const started = Date.now();
        while (this.depth() > 0) {
            if (Date.now() - started >= maxWaitMs) {
                (0, logger_1.logger)(safe_1.default.red(`${this.logPrefix} tx queue drain timeout lane=${this.laneKey} (${maxWaitMs}ms); inFlight=${this.currentLabel ?? 'none'} pending=${this.queue.length}`));
                return;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
    }
}
const lanes = new Map();
function normalizeLaneKey(laneKey) {
    return laneKey.trim().toLowerCase();
}
function getOrCreateLane(laneKey, logPrefix) {
    const key = normalizeLaneKey(laneKey);
    let lane = lanes.get(key);
    if (!lane) {
        lane = new OnchainTxSerialLane(key, logPrefix);
        lanes.set(key, lane);
    }
    return lane;
}
/** Enqueue on-chain write work on a signer lane; tasks run FIFO, one at a time per lane. */
function enqueueOnchainTxWork(laneKey, label, fn, logPrefix = '[onchainTxQueue]') {
    return getOrCreateLane(laneKey, logPrefix).enqueue(label, fn);
}
/** Wait until a lane has no pending or in-flight tx work (graceful shutdown). */
async function waitForOnchainTxQueue(laneKey, maxWaitMs = 30 * 60 * 1000) {
    const lane = lanes.get(normalizeLaneKey(laneKey));
    if (!lane)
        return;
    await lane.waitIdle(maxWaitMs);
}
/** Wait until every open lane is idle. */
async function waitForAllOnchainTxQueues(maxWaitMs = 30 * 60 * 1000) {
    for (const lane of lanes.values()) {
        await lane.waitIdle(maxWaitMs);
    }
}
/**
 * Legacy shared lane name (kept for callers that have not split yet).
 * Prefer {@link CONET_VALIDATOR_REDEEM_WORKFLOW_ONCHAIN_LANE} vs {@link CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE}.
 */
exports.CONET_VALIDATOR_NODE_ONCHAIN_LANE = 'conet-validator-node:onchain';
/**
 * Claim / fee-recipient / full-exit workflow (redeem admin + Prysm helper scripts).
 * Isolated from CL skim so long settleNodeRewards batches cannot starve claim jobs.
 */
exports.CONET_VALIDATOR_REDEEM_WORKFLOW_ONCHAIN_LANE = 'conet-validator-node:redeem-workflow';
/**
 * CL skim settleNodeRewards / withdrawNative payout reporter only.
 */
exports.CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE = 'conet-validator-node:cl-payout';
/** Lane key for a single hot-wallet signer (checksum-agnostic). */
function onchainTxLaneForSigner(signerAddress) {
    return `eoa:${ethers_1.ethers.getAddress(signerAddress).toLowerCase()}`;
}
