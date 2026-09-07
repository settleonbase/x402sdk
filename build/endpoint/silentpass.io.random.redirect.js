"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const node_http_1 = require("node:http");
const safe_1 = __importDefault(require("colors/safe"));
const ethers_1 = require("ethers");
const logger_1 = require("../logger");
const newNodeInfoABI_json_1 = __importDefault(require("../ABI/newNodeInfoABI.json"));
/** Default 14000 — do not use 4000 (Prysm beacon gRPC on L1 nodes). Override via SILENTPASS_REDIRECT_PORT. */
const DEFAULT_SILENTPASS_REDIRECT_PORT = 14000;
const GuardianNodeInfo_mainnet = '0xBC6b53065b5647261396d002bDBA0d3396E0722f';
const CONET_MAINNET = new ethers_1.ethers.JsonRpcProvider('https://publicrpc.conet.network');
const GuardianNodesMainnet = new ethers_1.ethers.Contract(GuardianNodeInfo_mainnet, newNodeInfoABI_json_1.default, CONET_MAINNET);
let Guardian_Nodes = [];
const getAllNodes = () => new Promise(async (resolve) => {
    try {
        const _nodes = await GuardianNodesMainnet.getAllNodes(0, 1000);
        Guardian_Nodes = [];
        for (let i = 0; i < _nodes.length; i++) {
            const node = _nodes[i];
            Guardian_Nodes.push({
                nftNumber: parseInt(node[0].toString()),
                armoredPublicKey: Buffer.from(node[1], 'base64').toString(),
                domain: node[2],
                ip_addr: node[3],
                region: node[4],
            });
        }
        (0, logger_1.logger)(safe_1.default.red(`getAllNodes success, Guardian_Nodes = ${Guardian_Nodes.length}`));
        resolve(true);
    }
    catch (ex) {
        (0, logger_1.logger)('getAllNodes error', ex);
        resolve(false);
    }
});
const getRandomNode = () => {
    if (!Guardian_Nodes.length)
        return null;
    return Guardian_Nodes[Math.floor(Math.random() * Guardian_Nodes.length)];
};
function resolveRedirectPort() {
    const raw = process.env.SILENTPASS_REDIRECT_PORT?.trim();
    const n = raw ? Number(raw) : DEFAULT_SILENTPASS_REDIRECT_PORT;
    if (!Number.isFinite(n) || n <= 0 || n >= 65536) {
        (0, logger_1.logger)(safe_1.default.yellow(`invalid SILENTPASS_REDIRECT_PORT=${raw ?? ''}; using ${DEFAULT_SILENTPASS_REDIRECT_PORT}`));
        return DEFAULT_SILENTPASS_REDIRECT_PORT;
    }
    if (n === 4000) {
        (0, logger_1.logger)(safe_1.default.yellow('SILENTPASS_REDIRECT_PORT=4000 conflicts with Prysm beacon gRPC; using 14000 instead'));
        return DEFAULT_SILENTPASS_REDIRECT_PORT;
    }
    return n;
}
class ConetSilentPassRedirectServer {
    PORT = resolveRedirectPort();
    constructor() {
        void this.startServer();
    }
    startServer = async () => {
        const app = (0, express_1.default)();
        app.disable('x-powered-by');
        app.use(express_1.default.json());
        app.all('*', (req, res) => {
            let search = '';
            try {
                const url = new URL(req.url, `https://${req.headers.host}`);
                search = url.search;
            }
            catch (ex) {
                (0, logger_1.logger)(`URL parse error: ${ex}`);
            }
            (0, logger_1.logger)(`url = ${req.url} Search = ${search}`);
            const node = getRandomNode();
            if (!node) {
                return res.redirect(301, `https://silentpass.io/download/index.html`);
            }
            res.redirect(302, `https://${node.domain}.conet.network/download/index.html${search}`);
        });
        await getAllNodes();
        (0, logger_1.logger)(`start silentpass redirect server on 127.0.0.1:${this.PORT}`);
        const server = (0, node_http_1.createServer)(app);
        server.listen(this.PORT, '127.0.0.1', () => {
            console.table([{ 'CoNET SilentPass redirect': `started on 127.0.0.1:${this.PORT}` }]);
        });
    };
}
new ConetSilentPassRedirectServer();
