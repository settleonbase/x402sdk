"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const validatorDepositRedeem_1 = require("./validatorDepositRedeem");
const validatorRewardHourlyReporter_1 = require("./validatorRewardHourlyReporter");
const validatorClRewardPayoutReporter_1 = require("./validatorClRewardPayoutReporter");
const onchainTxSerialQueue_1 = require("../onchainTxSerialQueue");
/**
 * Lightweight CoNET validator-node daemon: event listener + hourly CNET reward reporter
 * + CL skim payout reporter (no BeamioCluster / Master / port 2222). Deploy on the validator host that matches
 * targetNodeIp (e.g. 38.102.85.33) alongside the CoNET-DL / newCoNET Prysm stack.
 */
(0, logger_1.logger)(safe_1.default.cyan('[validatorDepositRedeemListenerDaemon] starting'));
(0, validatorDepositRedeem_1.startValidatorDepositRedeemListener)();
(0, validatorRewardHourlyReporter_1.startValidatorRewardHourlyReporter)();
(0, validatorClRewardPayoutReporter_1.startValidatorClRewardPayoutReporter)();
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListenerDaemon] ${signal}; waiting for helper scripts (08_import, …) before exit`));
    (0, validatorRewardHourlyReporter_1.stopValidatorRewardHourlyReporter)();
    (0, validatorClRewardPayoutReporter_1.stopValidatorClRewardPayoutReporter)();
    (0, validatorDepositRedeem_1.stopValidatorDepositRedeemListener)();
    await (0, validatorDepositRedeem_1.waitForListenerSerialQueue)();
    await (0, onchainTxSerialQueue_1.waitForOnchainTxQueue)(onchainTxSerialQueue_1.CONET_VALIDATOR_CL_PAYOUT_ONCHAIN_LANE);
    await (0, validatorDepositRedeem_1.waitForRunCommandChildren)();
    process.exit(0);
}
process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
