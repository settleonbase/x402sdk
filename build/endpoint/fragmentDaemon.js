"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cluster_1 = __importDefault(require("node:cluster"));
const node_os_1 = require("node:os");
const logger_1 = require("../logger");
const safe_1 = __importDefault(require("colors/safe"));
const fragmentClusterServer_1 = __importDefault(require("./fragmentClusterServer"));
if (node_cluster_1.default.isPrimary) {
    const forkWorker = () => {
        let numCPUs = (0, node_os_1.cpus)().length / 2;
        for (let i = 0; i < numCPUs; i++) {
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
}
else {
    new fragmentClusterServer_1.default();
}
