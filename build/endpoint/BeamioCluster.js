"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const beamioServer_1 = require("./beamioServer");
const node_os_1 = require("node:os");
const node_cluster_1 = __importDefault(require("node:cluster"));
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const beamioMaster_1 = __importDefault(require("./beamioMaster"));
const validatorDepositRedeem_1 = require("./validatorDepositRedeem");
const conetBlockscoutIncomeDaemon_1 = require("./conetBlockscoutIncomeDaemon");
if (node_cluster_1.default.isPrimary) {
    const forkWorker = () => {
        let numCPUs = (0, node_os_1.cpus)().length;
        for (let i = 0; i < numCPUs / 2; i++) {
            _forkWorker();
        }
    };
    const _forkWorker = () => {
        const fork = node_cluster_1.default.fork();
        fork.once('exit', (code, signal) => {
            (0, logger_1.logger)(safe_1.default.red(`Worker [${fork.id}] Exit with code[${code}] signal[${signal}]!\n Restart after 30 seconds!`));
            return setTimeout(() => {
                return _forkWorker();
            }, 1000 * 10);
        });
        return (fork);
    };
    forkWorker();
    (0, beamioMaster_1.default)();
    (0, validatorDepositRedeem_1.startValidatorDepositRedeemListener)();
}
else {
    (0, beamioServer_1.startServer)();
    (0, conetBlockscoutIncomeDaemon_1.startConetBlockscoutIncomeDaemon)();
}
