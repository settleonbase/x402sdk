"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const validatorLabMiningPoolClPayoutReporter_1 = require("./validatorLabMiningPoolClPayoutReporter");
const onchainTxSerialQueue_1 = require("../onchainTxSerialQueue");
/**
 * Standalone daemon: Lab manual staking CL skim → ConetLabMiningPool via Redeem.withdrawNative(admin).
 * Run on ONE ops host with EL RPC + beacon REST (default http://127.0.0.1:4100).
 * Do not run alongside guardian CL payout for the same withdrawal keys — Lab path skips guardianId > 0.
 */
(0, logger_1.logger)(safe_1.default.cyan('[labMiningPoolClPayoutDaemon] starting'));
(0, validatorLabMiningPoolClPayoutReporter_1.startValidatorLabMiningPoolClPayoutReporter)();
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayoutDaemon] ${signal}; draining payout queue…`));
    (0, validatorLabMiningPoolClPayoutReporter_1.stopValidatorLabMiningPoolClPayoutReporter)();
    await (0, validatorLabMiningPoolClPayoutReporter_1.waitForLabMiningPoolClPayoutIdle)();
    await (0, validatorLabMiningPoolClPayoutReporter_1.flushLabMiningPoolListeningCheckpoint)();
    await (0, onchainTxSerialQueue_1.waitForAllOnchainTxQueues)();
    process.exit(0);
}
process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
