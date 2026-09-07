"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const cluster_1 = __importDefault(require("cluster"));
const logger = (...argv) => {
    const date = new Date();
    // 格式化时间
    const ts = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}:${date.getMilliseconds()}`;
    // cluster 信息
    const wid = cluster_1.default.isPrimary
        ? 'master'
        : `worker-${cluster_1.default.worker?.id ?? 'unknown'}`;
    // 彩色 prefix
    const prefix = `%c[${wid} INFO ${ts}]`;
    return console.log(prefix, 'color: #6f4de7ff', ...argv);
};
exports.logger = logger;
