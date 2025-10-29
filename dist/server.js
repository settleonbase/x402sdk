"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.x402Server = void 0;
const express_1 = __importDefault(require("express"));
const node_path_1 = require("node:path");
const safe_1 = __importDefault(require("colors/safe"));
const node_util_1 = require("node:util");
const logger_1 = require("./logger");
const node_fs_1 = __importDefault(require("node:fs"));
class x402Server {
    PORT;
    reactBuildFolder;
    loginListening = null;
    localserver;
    connect_peer_pool = [];
    worker_command_waiting_pool = new Map();
    logStram = '';
    constructor(PORT = 3000, reactBuildFolder) {
        this.PORT = PORT;
        this.reactBuildFolder = reactBuildFolder;
        this.initialize();
    }
    end = () => new Promise(resolve => {
        if (this.localserver) {
            this.localserver.close(err => {
                if (err) {
                    (0, logger_1.logger)(safe_1.default.red('Server err:'), err);
                }
            });
        }
        // 即使服务器不存在或关闭出错，也继续执行
        resolve();
    });
    postMessageToLocalDevice(device, encryptedMessage) {
        const index = this.connect_peer_pool.findIndex(n => n.publicKeyID === device);
        if (index < 0) {
            return console.log((0, node_util_1.inspect)({ postMessageToLocalDeviceError: `this.connect_peer_pool have no publicKeyID [${device}]` }, false, 3, true));
        }
        const ws = this.connect_peer_pool[index];
        const sendData = { encryptedMessage: encryptedMessage };
        console.log((0, node_util_1.inspect)({ ws_send: sendData }, false, 3, true));
        return ws.send(JSON.stringify(sendData));
    }
    initialize = async () => {
        // --- 关键逻辑开始 ---
        // 1. 定义默认路径（只读的应用包内部）
        const defaultPath = (0, node_path_1.join)(__dirname, 'workers');
        // 2. 定义更新路径（可写的 userData 目录内部）
        const userDataPath = this.reactBuildFolder;
        const updatedPath = (0, node_path_1.join)(userDataPath, 'workers');
        // 3. 检查更新路径是否存在，然后决定使用哪个路径
        //    如果 updatedPath 存在，就用它；否则，回退到 defaultPath。
        let staticFolder = node_fs_1.default.existsSync(updatedPath) ? updatedPath : defaultPath;
        (0, logger_1.logger)(`staticFolder = ${staticFolder}`);
        // --- 关键逻辑结束 ---
        const app = (0, express_1.default)();
        const cors = require('cors');
        app.use(cors());
        app.use(express_1.default.static(staticFolder));
        //app.use ( express.static ( launcherFolder ))
        app.use(express_1.default.json());
        app.use(async (req, res, next) => {
            (0, logger_1.logger)(safe_1.default.blue(`${req.url}`));
            return next();
        });
        app.once('error', (err) => {
            (0, logger_1.logger)(err);
            (0, logger_1.logger)(`Local server on ERROR, try restart!`);
            return this.initialize();
        });
        app.post('/connecting', (req, res) => {
            const headerName = safe_1.default.blue(`Local Server /connecting remoteAddress = ${req.socket?.remoteAddress}`);
            (0, logger_1.logger)(headerName, (0, node_util_1.inspect)(req.body.data, false, 3, true));
            let roop;
            if (this.loginListening) {
                (0, logger_1.logger)(`${headerName} Double connecting. drop connecting!`);
                return res.sendStatus(403).end();
            }
            this.loginListening = res;
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders(); // flush the headers to establish SSE with client
            const interValID = () => {
                if (res.closed) {
                    this.loginListening = null;
                    return (0, logger_1.logger)(` ${headerName} lost connect! `);
                }
                res.write(`\r\n\r\n`, (err) => {
                    if (err) {
                        (0, logger_1.logger)(`${headerName}res.write got Error STOP connecting`, err);
                        res.end();
                        this.loginListening = null;
                    }
                    return roop = setTimeout(() => {
                        interValID();
                    }, 10000);
                });
            };
            res.once('close', () => {
                (0, logger_1.logger)(`[${headerName}] Closed`);
                res.end();
                clearTimeout(roop);
                this.loginListening = null;
            });
            res.on('error', (err) => {
                (0, logger_1.logger)(`[${headerName}] on Error`, err);
            });
            return interValID();
        });
        app.all('/', (req, res) => {
            return res.status(404).end();
        });
        this.localserver = app.listen(this.PORT, () => {
            return console.table([
                { 'x402 Server': `http://localhost:${this.PORT}` },
                { 'Serving files from': staticFolder }
            ]);
        });
    };
}
exports.x402Server = x402Server;
