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
const x402_express_1 = require("x402-express");
const routes = {
    "/api/weather": {
        price: "$0.001",
        network: "base",
        config: {
            discoverable: true, // make your endpoint discoverable
            description: "SETTLE: MINTS THAT SETTLE_ON BASE",
            inputSchema: {
                queryParams: {
                    location: {
                        type: 'Canada',
                        description: "Toronto",
                        required: true
                    }
                }
            },
            outputSchema: {
                type: "object",
                properties: {
                    temperature: { type: "number" },
                    conditions: { type: "string" },
                    humidity: { type: "number" }
                }
            }
        }
    }
};
const initialize = async (reactBuildFolder, PORT, serverRoute) => {
    console.log('🔧 Initialize called with PORT:', PORT, 'reactBuildFolder:', reactBuildFolder);
    const defaultPath = (0, node_path_1.join)(__dirname, 'workers');
    console.log('📁 defaultPath:', defaultPath);
    const userDataPath = reactBuildFolder;
    const updatedPath = (0, node_path_1.join)(userDataPath, 'workers');
    console.log('📁 updatedPath:', updatedPath);
    let staticFolder = node_fs_1.default.existsSync(updatedPath) ? updatedPath : defaultPath;
    (0, logger_1.logger)(`staticFolder = ${staticFolder}`);
    console.log('📁 staticFolder:', staticFolder);
    const app = (0, express_1.default)();
    const cors = require('cors');
    app.use(cors());
    app.use(express_1.default.static(staticFolder));
    app.use(express_1.default.json());
    app.use(async (req, res, next) => {
        (0, logger_1.logger)(safe_1.default.blue(`${req.url}`));
        return next();
    });
    app.use((0, x402_express_1.paymentMiddleware)('0xFd60936707cb4583c08D8AacBA19E4bfaEE446B8', { "/api/weather": {
            price: "$0.001",
            network: "base",
            config: {
                discoverable: true, // make your endpoint discoverable
                description: "SETTLE: MINTS THAT SETTLE_ON BASE",
                inputSchema: {
                    queryParams: {}
                },
                outputSchema: {
                    type: "object",
                    properties: {
                        temperature: { type: "number" },
                        conditions: { type: "string" },
                        humidity: { type: "number" }
                    }
                }
            }
        } }));
    const router = express_1.default.Router();
    app.use('/api', router);
    serverRoute(router);
    app.once('error', (err) => {
        (0, logger_1.logger)(err);
        (0, logger_1.logger)(`Local server on ERROR, try restart!`);
        return;
    });
    app.all('/', (req, res) => {
        return res.status(404).end();
    });
    console.log('🚀 Starting express.listen on port:', PORT);
    const server = app.listen(PORT, () => {
        console.log('✅ Server started successfully!');
        console.table([
            { 'x402 Server': `http://localhost:${PORT}`, 'Serving files from': staticFolder }
        ]);
    });
    server.on('error', (err) => {
        console.error('❌ Server error:', err);
    });
    return server;
};
class x402Server {
    PORT;
    reactBuildFolder;
    loginListening = null;
    localserver = null;
    connect_peer_pool = [];
    worker_command_waiting_pool = new Map();
    logStram;
    constructor(PORT = 3000, reactBuildFolder) {
        this.PORT = PORT;
        this.reactBuildFolder = reactBuildFolder;
        this.logStram =
            console.log('🏗️  x402Server constructor called');
    }
    async start() {
        console.log('⏳ start() called');
        try {
            this.localserver = await initialize(this.reactBuildFolder, this.PORT, this.router);
            console.log('✨ start() completed successfully');
        }
        catch (err) {
            console.error('❌ start() error:', err);
            throw err;
        }
    }
    router(router) {
        router.get('/info', async (req, res) => {
            res.status(200).json({ 'x402 Server': `http://localhost: 4088`, 'Serving files from': '' }).end();
        });
        router.get('/weather', async (req, res) => {
            res.status(200).json({ routes }).end();
        });
    }
    end = () => new Promise(resolve => {
        if (this.localserver) {
            this.localserver.close(err => {
                if (err) {
                    (0, logger_1.logger)(safe_1.default.red('Server err:'), err);
                }
            });
        }
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
}
exports.x402Server = x402Server;
console.log('📌 Script started');
(async () => {
    try {
        console.log('🌍 Creating x402Server instance...');
        const server = new x402Server(4088, '');
        console.log('⏳ Calling server.start()...');
        await server.start();
        console.log('✅ Server started successfully!');
        process.on('SIGINT', async () => {
            (0, logger_1.logger)('Shutting down gracefully...');
            await server.end();
            process.exit(0);
        });
        console.log('🎯 Server is now running. Press Ctrl+C to exit.');
    }
    catch (error) {
        (0, logger_1.logger)(safe_1.default.red('Failed to start server:'), error);
        console.error('❌ Error details:', error);
        process.exit(1);
    }
})();
console.log('📌 Script setup completed');
