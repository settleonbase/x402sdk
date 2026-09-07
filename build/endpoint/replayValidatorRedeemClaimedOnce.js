"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const validatorDepositRedeem_1 = require("./validatorDepositRedeem");
const requestId = process.argv[2]?.trim();
if (!requestId) {
    console.error('Usage: node dist/endpoint/replayValidatorRedeemClaimedOnce.js <requestId>');
    process.exit(1);
}
void (0, validatorDepositRedeem_1.replayValidatorRedeemClaimedEvent)(requestId)
    .then((state) => {
    if (!state) {
        (0, logger_1.logger)(safe_1.default.red('[replayValidatorRedeemClaimedOnce] no state after replay'));
        process.exit(2);
    }
    (0, logger_1.logger)(safe_1.default.green(`[replayValidatorRedeemClaimedOnce] done status=${state.status} validators=${state.validatorCount} requestId=${state.requestId}`));
    process.exit(state.status === 'succeeded' ? 0 : 1);
})
    .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    (0, logger_1.logger)(safe_1.default.red('[replayValidatorRedeemClaimedOnce] failed:'), msg);
    process.exit(1);
});
