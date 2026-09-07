"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkSign = exports.redeemCheck = exports.BeamioPaymentLink = exports.BeamioPayMeRouteToSC = exports.BeamioPayMe = exports.BeamioPaymentLinkFinishRouteToSC = exports.BeamioETHFaucet = exports.BeamioETHFaucetTry = exports.BeamioFaucet = exports.isOracleFresh = exports.ORACLE_FRESH_WINDOW_SEC = exports.setOracleSnapshot = exports.getOracleRequest = exports.facilitators = exports.facilitatorsPool = exports.x402ProcessPool = exports.cashcode_check = exports.generateCheck = exports.convertGasWeiToUSDC6 = exports.submitUsdcChargeSettleIndexer = exports.TX_CATEGORY_TERMINAL_RESET = exports.TX_CATEGORY_USDC_CHARGE_SETTLE = exports.settleBeamioX402ToCardOwner = exports.BeamioTransfer = exports.cashcode_request = exports.verifyPaymentNew = exports.buildX402ResourceUrl = exports.BASE_USDC_CONTRACT = exports.X402_PROTOCOL_VERSION = exports.Settle_ContractPool = exports.BEAMIO_BASE_PUBLIC_TIP_RPC = exports.oracleBackoud = exports.oracolPrice = exports.getAllNodes = exports.getGuardianNodesCount = exports.getBaseRpcUrlViaConetNode = exports.getRandomNode = exports.MINT_RATE = exports.masterSetup = exports.BEAMIO_BASE_HTTP_RPC_DEFAULT = exports.getClientIp = void 0;
exports.resolveBeamioBaseHttpRpcUrl = resolveBeamioBaseHttpRpcUrl;
exports.resolveBeamioConetHttpRpcUrl = resolveBeamioConetHttpRpcUrl;
exports.buildBeamioExactPaymentRequirements = buildBeamioExactPaymentRequirements;
exports.AuthorizationSign = AuthorizationSign;
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const usdc_abi_json_1 = __importDefault(require("./ABI/usdc_abi.json"));
const schemes_1 = require("x402/schemes");
const verify_1 = require("x402/verify");
const x402_1 = require("@coinbase/x402");
const types_1 = require("x402/types");
const shared_1 = require("x402/shared");
const node_util_1 = require("node:util");
const node_http_1 = require("node:http");
const uuid62 = require('uuid62');
const viem_1 = require("viem");
const chains_1 = require("viem/chains");
const accounts_1 = require("viem/accounts");
const viem_2 = require("viem");
const GuardianOracle_ABI_json_1 = __importDefault(require("./ABI/GuardianOracle_ABI.json"));
const newNodeInfoABI_json_1 = __importDefault(require("./ABI/newNodeInfoABI.json"));
const beamio_base_abi_json_1 = __importDefault(require("./ABI/beamio-base-abi.json"));
const beamio_conet_abi_json_1 = __importDefault(require("./ABI/beamio-conet.abi.json"));
const conet_airdrop_abi_json_1 = __importDefault(require("./ABI/conet_airdrop.abi.json"));
const beamio_AccountRegistry_json_1 = __importDefault(require("./ABI/beamio-AccountRegistry.json"));
const chainAddresses_1 = require("./chainAddresses");
const setupFile = (0, node_path_1.join)((0, node_os_1.homedir)(), '.master.json');
const getClientIp = (req) => {
    // 1. X-Real-IP（Nginx 转发的）
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string' && realIp !== '') {
        return realIp;
    }
    // 3. X-Forwarded-For
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string' && xff !== '') {
        return xff.split(',')[0].trim();
    }
    // 2. CF-Connecting-IP（Cloudflare 原生）
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp && typeof cfIp === 'string' && cfIp !== '') {
        return cfIp;
    }
    // 4. 如果以上都没有，返回 socket 地址（本地测试会是 127.0.0.1）
    return '';
};
exports.getClientIp = getClientIp;
(0, logger_1.logger)((0, node_os_1.homedir)());
/** CoNET 官方 Base HTTP RPC。API 默认使用此地址；仅环境变量 BASE_RPC_URL 可覆盖。不读取 ~/.master.json base_endpoint 作为主 RPC，避免误配 Alchemy 等第三方限额节点。 */
exports.BEAMIO_BASE_HTTP_RPC_DEFAULT = 'https://base-rpc.conet.network';
function resolveBeamioBaseHttpRpcUrl() {
    const env = typeof process !== 'undefined' ? process.env?.BASE_RPC_URL?.trim() : '';
    return env || exports.BEAMIO_BASE_HTTP_RPC_DEFAULT;
}
/** CoNET PoS HTTP RPC；与 deployments/conet-addresses.json `rpcUrl` 同步；CONET_RPC_URL 可覆盖。 */
function resolveBeamioConetHttpRpcUrl() {
    const env = typeof process !== 'undefined' ? process.env?.CONET_RPC_URL?.trim() : '';
    return env || chainAddresses_1.CONET_RPC_URL;
}
exports.masterSetup = require(setupFile);
const facilitator1 = (0, x402_1.createFacilitatorConfig)(exports.masterSetup.base.CDP_API_KEY_ID, exports.masterSetup.base.CDP_API_KEY_SECRET);
const x402Version = 1;
const conetEndpoint = resolveBeamioConetHttpRpcUrl();
const CashCodeBaseAddr = '0x3977f35c531895CeD50fAf5e02bd9e7EB890D2D1';
const USDCContract_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_Base_DECIMALS = 6;
const masterServerPort = 1111;
const SETTLEContract = '0x20c84933F3fFAcFF1C0b4D713b059377a9EF5fD1';
exports.MINT_RATE = ethers_1.ethers.parseUnits('7000', 18);
const USDC_decimals = BigInt(10 ** 6);
//	const conet_CashCodeNote = '0xCe1F36a78904F9506E5cD3149Ce4992cC91385AF'
const conet_CashCodeNote = '0xB8c526aC40f5BA9cC18706efE81AC7014A4aBB6d';
const oracleSC_addr = '0xE9922F900Eef37635aF06e87708545ffD9C3aa99';
/** Base 主网部署的 BeamioOracle，用于 oracolPrice 汇率获取 */
const oracleSC_addr_base = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B';
const eventContract = '0x18A976ee42A89025f0d3c7Fb8B32e0f8B840E1F3';
const { verify, settle } = (0, verify_1.useFacilitator)(facilitator1);
const GuardianNodeInfo_mainnet = '0xBC6b53065b5647261396d002bDBA0d3396E0722f';
const CONET_MAINNET = new ethers_1.ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl());
const GuardianNodesMainnet = new ethers_1.ethers.Contract(GuardianNodeInfo_mainnet, newNodeInfoABI_json_1.default, CONET_MAINNET);
//					beamio	Contract（与 GuardianNodesInfoV6 同链上地址）
const beamiobase = GuardianNodeInfo_mainnet;
const beamioConet = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd';
const airdropRecord = '0x070BcBd163a3a280Ab6106bA62A079f228139379';
const beamioConetAccountRegistry = '0xfFDc8d2021A41F4638Cb3eCf58B5155383EE9f6d';
let Guardian_Nodes = [];
/** 随机选取一个 Guardian 节点，返回其 ip_addr；无节点时返回 null */
const getRandomNode = () => {
    if (!Guardian_Nodes.length)
        return null;
    const idx = Math.floor(Math.random() * Guardian_Nodes.length);
    const _node1 = Guardian_Nodes[idx];
    return _node1?.ip_addr ?? null;
};
exports.getRandomNode = getRandomNode;
/** 通过 CoNET 节点获取 Base RPC URL（HTTP 协议），参照 SilentPassUI baseRpc；无节点时返回 null */
const getBaseRpcUrlViaConetNode = () => {
    const ip = (0, exports.getRandomNode)();
    if (!ip)
        return null;
    return `http://${ip}/base-rpc`;
};
exports.getBaseRpcUrlViaConetNode = getBaseRpcUrlViaConetNode;
/** 供 debug：Guardian_Nodes 数量 */
const getGuardianNodesCount = () => Guardian_Nodes.length;
exports.getGuardianNodesCount = getGuardianNodesCount;
/**
 * 与 conet-si `_getAllNodes` 一致的分页拉取：
 * - 每页 100 条（合约的内部 limit，传 1000 会被 RPC 静默返回空数据 `0x`，
 *   触发 ethers `BAD_DATA` 抛出，让旧实现把整个进程拖崩）。
 * - 对 `BAD_DATA value="0x"` 吞掉视为「无更多节点」，与 conet-si 保持一致。
 * - 连续 5 次其它错误退出，避免无限重试。
 */
const _getAllNodesPaged = async () => {
    const PAGE = 100;
    const MAX_LOOP = 1000;
    const MAX_CONSECUTIVE_FAIL = 5;
    const all = [];
    const seen = new Set();
    let i = 0;
    let loop = 0;
    let consecutiveFail = 0;
    while (loop++ < MAX_LOOP) {
        let page = [];
        try {
            page = await GuardianNodesMainnet.getAllNodes(i, PAGE);
            consecutiveFail = 0;
        }
        catch (e) {
            if (e?.code === 'BAD_DATA' && /value="0x"/.test(e?.message ?? '')) {
                (0, logger_1.logger)(`_getAllNodesPaged: contract returned empty (0x) at offset=${i}, treat as end`);
                break;
            }
            consecutiveFail++;
            (0, logger_1.logger)(`_getAllNodesPaged Error (${consecutiveFail}/${MAX_CONSECUTIVE_FAIL}) at offset=${i}: ${e?.message ?? e}`);
            if (consecutiveFail >= MAX_CONSECUTIVE_FAIL)
                break;
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        if (!page || page.length === 0)
            break;
        let added = 0;
        for (const n of page) {
            const ip = (n?.[3] ?? '').toString().trim().toLowerCase();
            if (!ip)
                continue;
            if (seen.has(ip))
                continue;
            seen.add(ip);
            all.push(n);
            added++;
        }
        if (added === 0)
            break;
        i += page.length;
    }
    return all;
};
const getAllNodes = async () => {
    try {
        const _nodes = await _getAllNodesPaged();
        Guardian_Nodes.length = 0;
        for (let i = 0; i < _nodes.length; i++) {
            const node = _nodes[i];
            const id = parseInt(node[0].toString());
            const pgpString = Buffer.from(node[1], 'base64').toString();
            const domain = node[2];
            const ipAddr = node[3];
            const region = node[4];
            Guardian_Nodes.push({
                ip_addr: ipAddr,
                armoredPublicKey: pgpString,
                domain: domain,
                nftNumber: id,
                region: region,
            });
        }
        (0, logger_1.logger)(`getAllNodes success total nodes = ${Guardian_Nodes.length}`);
        return true;
    }
    catch (e) {
        (0, logger_1.logger)(`getAllNodes Error: ${e?.message ?? e}`);
        return false;
    }
};
exports.getAllNodes = getAllNodes;
// const headers: Record<string, string> = {
// 	accept: 'application/json',
// 	'content-type': 'application/json',
// 	'accept-encoding': 'gzip, deflate, br, zstd',
// 	'accept-language': 'en-US,en;q=0.9,ja;q=0.8,zh-CN;q=0.7,zh-TW;q=0.6,zh;q=0.5',
// 	'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
// 	'x-app-version': '3.133.0',
// 	'x-cb-device-id': v4(),
// 	'x-cb-is-logged-in': 'true',
// 	'x-cb-pagekey': 'send',
// 	'x-cb-platform': 'extension',
// 	'x-cb-project-name': 'wallet_extension',
// 	'x-cb-session-uuid': v4(),
// 	'x-cb-version-name': '3.133.0',
// 	'x-platform-name': 'extension',
// 	'x-release-stage': 'production',
// 	'x-wallet-user-id': '98630690',
// 	// 如需身份态就带上 cookie（注意隐私与时效）
// 	cookie: `cb_dm=${v4()};`,
// 	// 若需要伪装扩展来源（可能仍被服务端策略拦截）
// 	origin: 'chrome-extension://hnfanknocfeofbddgcijnmhnfnkdnaad',
// }
const conetMainnet = (0, viem_2.defineChain)({
    id: 224422, // 随便指定唯一的 chainId，例如 2550；如果有官方ID请填实际
    name: 'CoNET Mainnet',
    network: 'conet',
    nativeCurrency: {
        name: 'ETH',
        symbol: 'ETH',
        decimals: 18,
    },
    rpcUrls: {
        default: { http: [conetEndpoint] },
        public: { http: [conetEndpoint] },
    },
    blockExplorers: {
        default: { name: 'CoNET Explorer', url: 'https://mainnet.conet.network' }
    }
});
const conetClient = (0, viem_1.createPublicClient)({ chain: conetMainnet, transport: (0, viem_1.http)(conetEndpoint) });
const oracle = {
    bnb: '',
    eth: '',
    usdc: '',
    timestamp: 0,
    usdcad: '',
    usdjpy: '',
    usdcny: '',
    usdhkd: '',
    usdeur: '',
    usdsgd: '',
    usdtwd: ''
};
let oracolPriceProcess = false;
/** BeamioCurrency: CAD=0, USD=1, JPY=2, CNY=3, USDC=4, HKD=5, EUR=6, SGD=7, TWD=8, ETH=9, BNB=10, SOLANA=11, BTC=12
 * 链上 getRate(c) 返回「1 该货币 = X USD」；UI 期望「1 USD = X 该货币」，故对非 USD/USDC 需取倒数
 */
const inv = (s) => {
    const n = Number(s);
    return (n > 0 ? 1 / n : 0).toString();
};
const oracolPrice = async () => {
    if (oracolPriceProcess)
        return;
    oracolPriceProcess = true;
    try {
        const [cadRaw, jpyRaw, cnyRaw, usdcRaw, hkdRaw, eurRaw, sgdRaw, twdRaw] = await Promise.all([
            oracleSCBase.getRate(0).then((r) => ethers_1.ethers.formatEther(r)), // CAD
            oracleSCBase.getRate(2).then((r) => ethers_1.ethers.formatEther(r)), // JPY
            oracleSCBase.getRate(3).then((r) => ethers_1.ethers.formatEther(r)), // CNY
            oracleSCBase.getRate(4).then((r) => ethers_1.ethers.formatEther(r)), // USDC
            oracleSCBase.getRate(5).then((r) => ethers_1.ethers.formatEther(r)), // HKD
            oracleSCBase.getRate(6).then((r) => ethers_1.ethers.formatEther(r)), // EUR
            oracleSCBase.getRate(7).then((r) => ethers_1.ethers.formatEther(r)), // SGD
            oracleSCBase.getRate(8).then((r) => ethers_1.ethers.formatEther(r)), // TWD
        ]);
        const timestamp = Math.floor(Date.now() / 1000);
        oracle.bnb = '';
        oracle.eth = '';
        oracle.usdc = usdcRaw.toString();
        oracle.usdcad = inv(cadRaw);
        oracle.usdjpy = inv(jpyRaw);
        oracle.usdcny = inv(cnyRaw);
        oracle.usdhkd = inv(hkdRaw);
        oracle.usdeur = inv(eurRaw);
        oracle.usdsgd = inv(sgdRaw);
        oracle.usdtwd = inv(twdRaw);
        oracle.timestamp = timestamp;
    }
    catch (e) {
        // Exceeded quota / RPC 限流时保留旧数据，避免崩溃
        (0, logger_1.logger)('oracolPrice failed (quota/RPC):', e?.message?.slice?.(0, 80) ?? e);
    }
    finally {
        oracolPriceProcess = false;
    }
};
exports.oracolPrice = oracolPrice;
/**
 * @param enableOracle 是否启用链上 oracle 读取（仅 master 设为 true，cluster 从 master 拉取）
 */
const oracleBackoud = async (enableOracle = true) => {
    await (0, exports.getAllNodes)();
    exports.Settle_ContractPool = exports.masterSetup.settle_contractAdmin.map(n => {
        const account = (0, accounts_1.privateKeyToAccount)('0x' + n);
        // const walletClientBase = createWalletClient({
        // 	account,
        // 	chain: base,
        // 	transport: http(`http://${getRandomNode()}/base-rpc`),
        // })
        const walletBase = new ethers_1.ethers.Wallet(n, providerBaseBackup);
        const walletConet = new ethers_1.ethers.Wallet(n, providerConet);
        (0, logger_1.logger)(`address => ${walletBase.address}`);
        return {
            // baseWalletClient: walletClientBase,
            baseSC: new ethers_1.ethers.Contract(beamiobase, beamio_base_abi_json_1.default, walletBase),
            baseUSDC: new ethers_1.ethers.Contract(USDCContract_BASE, usdc_abi_json_1.default, walletBase),
            privateKey: n,
            wallet: walletBase,
            conetSC: new ethers_1.ethers.Contract(beamioConet, beamio_conet_abi_json_1.default, walletConet),
            // event: new ethers.Contract(eventContract, Event_ABI, walletConet),
            conetAirdrop: new ethers_1.ethers.Contract(airdropRecord, conet_airdrop_abi_json_1.default, walletConet),
            constAccountRegistry: new ethers_1.ethers.Contract(beamioConetAccountRegistry, beamio_AccountRegistry_json_1.default, walletConet),
        };
    });
    if (!enableOracle)
        return;
    (0, exports.oracolPrice)();
    providerConet.on('block', async (blockNumber) => {
        if (blockNumber % 30 !== 0) {
            return;
        }
        (0, exports.oracolPrice)();
    });
};
exports.oracleBackoud = oracleBackoud;
/** Base 主网 RPC：与 resolveBeamioBaseHttpRpcUrl 一致（默认 CoNET 官方节点） */
const BASE_RPC_URL = resolveBeamioBaseHttpRpcUrl();
/** Official Base tip — read/confirm when CoNET Base RPC lags (nonce / receipts / USDC balance). */
exports.BEAMIO_BASE_PUBLIC_TIP_RPC = 'https://mainnet.base.org';
const BASE_PUBLIC_TIP_RPC = exports.BEAMIO_BASE_PUBLIC_TIP_RPC;
const providerBase = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
const providerBaseBackup = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
async function readBaseUsdcBalanceLatest(rpcUrl, payer) {
    const provider = new ethers_1.ethers.JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
    try {
        const usdc = new ethers_1.ethers.Contract(USDCContract_BASE, ['function balanceOf(address) view returns (uint256)'], provider);
        return (await usdc.balanceOf(payer, { blockTag: 'latest' }));
    }
    catch {
        return null;
    }
    finally {
        provider.destroy();
    }
}
const providerConet = new ethers_1.ethers.JsonRpcProvider(conetEndpoint);
const oracleSC = new ethers_1.ethers.Contract(oracleSC_addr, GuardianOracle_ABI_json_1.default, providerConet);
/** BeamioTransfer x402 预检：payer（EOA）的 B-Unit 余额必须 >= 2（手续费） */
const beamioTransferPreCheckBUnitBalance = async (payerEOA) => {
    const BUNIT_FEE_AMOUNT = 2000000n; // 2 B-Units (6 decimals)
    try {
        if (!ethers_1.ethers.isAddress(payerEOA)) {
            return { success: false, error: 'Invalid payer address for B-Unit fee check' };
        }
        const bunitAirdropRead = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUNIT_AIRDROP_ADDRESS, ['function getBUnitBalance(address) view returns (uint256)'], providerConet);
        const balance = await bunitAirdropRead.getBUnitBalance(payerEOA);
        if (balance < BUNIT_FEE_AMOUNT) {
            return {
                success: false,
                error: `Insufficient B-Units to pay fee (2 required, balance: ${Number(balance) / 1e6} B-Units)`,
            };
        }
        return { success: true };
    }
    catch (e) {
        return {
            success: false,
            error: `B-Unit balance check failed: ${e?.shortMessage ?? e?.message ?? String(e)}`,
        };
    }
};
/** BeamioOracle ABI：getRate(uint8) 返回货币对 USD 的 E18 汇率 */
const BeamioOracleAbi = ['function getRate(uint8 c) view returns (uint256)'];
/** Base 主网的 BeamioOracle 合约实例，供 oracolPrice 使用 */
const oracleSCBase = new ethers_1.ethers.Contract(oracleSC_addr_base, BeamioOracleAbi, providerBase);
exports.Settle_ContractPool = [];
/** x402 协议 version 常量（外部模块构造 paymentRequirements / 错误响应时使用） */
exports.X402_PROTOCOL_VERSION = x402Version;
/** Base USDC ERC-20 合约地址（外部模块需要时复用，避免重复硬编码） */
exports.BASE_USDC_CONTRACT = USDCContract_BASE;
/** 暴露给外部模块复用：构造 Beamio x402 'exact' scheme PaymentRequirements。
 * 与 cashcode_request / BeamioTransfer 内部使用同一个工厂，保持 mimeType / extra / network 一致。 */
function buildBeamioExactPaymentRequirements(price, resource, description, payto) {
    return createBeamioExactPaymentRequirements(price, resource, description, payto);
}
/** 暴露 x402 resource URL 构造（X-Forwarded-Proto/Host 优先），供外部 handler 与 verifyPaymentNew 输入对齐。 */
const buildX402ResourceUrl = (req) => buildResourceUrl(req);
exports.buildX402ResourceUrl = buildX402ResourceUrl;
function createBeamioExactPaymentRequirements(price, resource, description = "", payto) {
    const atomicAmountForAsset = (0, shared_1.processPriceToAtomicAmount)(price, 'base');
    if ("error" in atomicAmountForAsset) {
        throw new Error(atomicAmountForAsset.error);
    }
    const { maxAmountRequired, asset } = atomicAmountForAsset;
    return {
        scheme: "exact",
        network: 'base',
        maxAmountRequired,
        resource,
        description,
        mimeType: "",
        payTo: payto,
        maxTimeoutSeconds: 120,
        asset: asset.address,
        outputSchema: undefined,
        extra: {
            name: 'USD Coin',
            version: '2',
        },
    };
}
/** 构建 x402 resource URL，优先使用 X-Forwarded-Proto 以在代理后得到正确的 https。取逗号分隔的首值（多级代理时可能为 "https, https"） */
function buildResourceUrl(req) {
    const rawProto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
    const protocol = rawProto.split(',')[0]?.trim() || 'https';
    const rawHost = req.get('X-Forwarded-Host') || req.headers.host || '';
    const host = rawHost.split(',')[0]?.trim() || '';
    const pathname = new URL(req.originalUrl || req.url, 'http://x').pathname;
    return `${protocol}://${host}${pathname}`;
}
const verifyPaymentNew = (req, res, paymentRequirements) => new Promise(async (resolve) => {
    const payment = req.header("X-PAYMENT");
    if (!payment) {
        // 第一跳：客户端没带 X-PAYMENT，按 x402 协议返回 402 + paymentRequirements。
        // 把 Origin / Referer / UA 一起 dump，便于排查跨域第二跳是否被 CORS 预检拦下来：
        // 如果第二跳从未到达服务器，但这条日志却出现两次（同一 sid/同一 cardAddr），
        // 极有可能是浏览器在 OPTIONS 预检阶段把带 X-PAYMENT 的 POST block 掉了。
        const origin = req.header('origin') ?? '(no-origin)';
        const referer = req.header('referer') ?? '(no-referer)';
        const ua = (req.header('user-agent') ?? '').slice(0, 80);
        const xfwdProto = req.header('x-forwarded-proto') ?? '(none)';
        const xfwdFor = req.header('x-forwarded-for') ?? '(none)';
        (0, logger_1.logger)(`verifyPayment send x402 payment information path=${req.originalUrl} origin=${origin} referer=${referer} xfwd-proto=${xfwdProto} xfwd-for=${xfwdFor} ua="${ua}"`);
        res.status(402).json({
            x402Version,
            error: "X-PAYMENT header is required",
            accepts: paymentRequirements,
        });
        return;
    }
    // 进入第二跳：把 X-PAYMENT 长度+前缀打出来，证明 nginx + 浏览器 CORS 预检确实放行了 X-PAYMENT。
    (0, logger_1.logger)(`verifyPayment got X-PAYMENT header path=${req.originalUrl} origin=${req.header('origin') ?? '(no-origin)'} payment.len=${payment.length} payment.prefix=${payment.slice(0, 24)}…`);
    let decodedPayment;
    try {
        decodedPayment = schemes_1.exact.evm.decodePayment(payment);
        decodedPayment.x402Version = x402Version;
    }
    catch (error) {
        (0, logger_1.logger)(`verifyPayment catch Invalid or malformed payment header Error!`);
        res.status(402).json({
            x402Version,
            error: error || "Invalid or malformed payment header",
            accepts: paymentRequirements,
        });
        return resolve(false);
    }
    // 余额检查：付款方 USDC 不足时提前返回，便于 UI 显示友好错误。
    // 一次性 provider + latest，避免长期 providerBase 把 latest 钉在过期块。
    // CoNET Base RPC 若落后主网 tip，再读官方 Base 公共 RPC，避免把已到账的充值误判为不足。
    try {
        const auth = decodedPayment?.payload?.authorization;
        const payer = auth?.from;
        const needAmount = BigInt(auth?.value ?? '0');
        if (payer && needAmount > 0n) {
            const localBal = await readBaseUsdcBalanceLatest(BASE_RPC_URL, payer);
            let bal = localBal;
            if (localBal != null && localBal < needAmount) {
                const tipBal = await readBaseUsdcBalanceLatest(BASE_PUBLIC_TIP_RPC, payer);
                if (tipBal != null && tipBal > localBal) {
                    (0, logger_1.logger)(`verifyPayment Base RPC lag: local=${localBal} tip=${tipBal} payer=${payer}`);
                    bal = tipBal;
                }
            }
            if (bal != null && bal < needAmount) {
                const balStr = (Number(bal) / 1e6).toFixed(2);
                const needStr = (Number(needAmount) / 1e6).toFixed(2);
                const errMsg = `Insufficient USDC balance: account has ${balStr} USDC, need ${needStr} USDC`;
                (0, logger_1.logger)(`verifyPayment ${errMsg}`);
                res.status(402).json({
                    x402Version,
                    error: errMsg,
                    accepts: paymentRequirements,
                });
                return resolve(false);
            }
        }
    }
    catch (balanceEx) {
        (0, logger_1.logger)(`verifyPayment balance check failed (continuing): ${balanceEx?.message ?? balanceEx}`);
        // RPC 失败时不影响主流程，交给 facilitator 校验
    }
    // 自转账守卫：付款钱包 == 收款地址（例如误连 initiator / 收款钱包）→ CDP 会以通用 400 拒绝，
    // 这里提前给出可操作的清晰提示，避免用户看到无意义的 "Bad Request"。
    try {
        const selfFrom = decodedPayment?.payload?.authorization?.from;
        const selfPayTo = paymentRequirements?.[0]?.payTo;
        if (selfFrom && selfPayTo && selfFrom.toLowerCase() === selfPayTo.toLowerCase()) {
            const errMsg = 'The connected wallet is the Beamio settlement address and cannot fund a deposit to itself. Please connect a different Base wallet that holds USDC.';
            (0, logger_1.logger)(`verifyPayment self-transfer blocked: from==payTo=${selfPayTo}`);
            res.status(402).json({ x402Version, error: errMsg, accepts: paymentRequirements });
            return resolve(false);
        }
    }
    catch (selfEx) {
        (0, logger_1.logger)(`verifyPayment self-transfer guard skipped: ${selfEx?.message ?? selfEx}`);
    }
    // 签名时效检查：validAfter/validBefore 超出则提前返回，便于 UI 提示用户重新签名
    const authTime = decodedPayment?.payload?.authorization;
    if (authTime?.validAfter !== undefined && authTime?.validBefore !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        const validAfter = Number(authTime.validAfter);
        const validBefore = Number(authTime.validBefore);
        if (now < validAfter) {
            const errMsg = 'Payment authorization not yet valid. Please try again shortly.';
            (0, logger_1.logger)(`verifyPayment ${errMsg} (now=${now} validAfter=${validAfter})`);
            res.status(402).json({ x402Version, error: errMsg, accepts: paymentRequirements });
            return resolve(false);
        }
        if (now > validBefore) {
            const errMsg = 'Payment authorization expired. Please sign again.';
            (0, logger_1.logger)(`verifyPayment ${errMsg} (now=${now} validBefore=${validBefore})`);
            res.status(402).json({ x402Version, error: errMsg, accepts: paymentRequirements });
            return resolve(false);
        }
    }
    try {
        if (!paymentRequirements.length) {
            //@ts-ignore
            const amount = decodedPayment.payload.authorization.value;
            const resource = buildResourceUrl(req);
            paymentRequirements = [createBeamioExactPaymentRequirements(amount, resource, `Cashcode Payment Request`, decodedPayment.payload
                    //@ts-ignore
                    .authorization.to)];
        }
        const selectedPaymentRequirement = (0, shared_1.findMatchingPaymentRequirements)(paymentRequirements, decodedPayment) ||
            paymentRequirements[0];
        const response = await verify(decodedPayment, selectedPaymentRequirement);
        if (!response.isValid) {
            (0, logger_1.logger)(`verifyPayment verify decodedPayment Erro! ${response.invalidReason} `);
            res.status(402).json({
                x402Version,
                error: response.invalidReason,
                accepts: paymentRequirements,
                payer: response.payer,
            });
            return resolve(false);
        }
    }
    catch (error) {
        let errMsg = error?.message ?? String(error);
        const errCause = error?.cause?.message ?? error?.cause;
        (0, logger_1.logger)(`verifyPayment catch error! ${errMsg}`, errCause ? `cause=${errCause}` : '');
        // x402 lib（verify2）在 facilitator 非 200 时读取 errorData.error 抛出通用 "Failed to verify payment: Bad Request"，
        // 但 CDP facilitator 的真实原因在 errorMessage / invalidReason。这里复现 verify 请求（发送单个对象，
        // 与真实调用一致），抓取 CDP 原始 body 并把真实原因回传给前端。
        if (errMsg.includes('Bad Request') || errMsg.includes('400') || errMsg.includes('Failed to verify payment')) {
            const payload = decodedPayment?.payload;
            const auth = payload?.authorization;
            const req0 = (0, shared_1.findMatchingPaymentRequirements)(paymentRequirements, decodedPayment) ||
                paymentRequirements[0];
            (0, logger_1.logger)(`[DEBUG] verifyPayment Bad Request - reqResource=${req0?.resource} payTo=${req0?.payTo} authFrom=${auth?.from?.slice(0, 10)}… authTo=${auth?.to?.slice(0, 10)}… authValue=${auth?.value} authResource=${auth?.resource ?? 'n/a'}`);
            try {
                const createAuth = facilitator1?.createAuthHeaders;
                if (createAuth && facilitator1?.url && req0) {
                    const authHeaders = await createAuth();
                    const url = `${facilitator1.url}/verify`;
                    const replacer = (_, v) => typeof v === 'bigint' ? String(v) : v;
                    // 与真实 verify(decodedPayment, selectedPaymentRequirement) 一致：paymentRequirements 为单个对象
                    const body = JSON.stringify({
                        x402Version: decodedPayment?.x402Version ?? 1,
                        paymentPayload: JSON.parse(JSON.stringify(decodedPayment, replacer)),
                        paymentRequirements: JSON.parse(JSON.stringify(req0, replacer)),
                    });
                    const debugRes = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders.verify }, body });
                    const debugText = await debugRes.text();
                    (0, logger_1.logger)(`[DEBUG] facilitator raw response: status=${debugRes.status} body=${debugText}`);
                    // 从 CDP 原始响应解析真实原因（CDP 用 errorMessage，x402 lib 误读 error）
                    try {
                        const parsed = JSON.parse(debugText);
                        const realReason = parsed?.errorMessage || parsed?.invalidReason || parsed?.message || parsed?.error;
                        if (realReason && typeof realReason === 'string') {
                            errMsg = realReason;
                        }
                    }
                    catch {
                        if (debugText && debugText.length < 500)
                            errMsg = `${errMsg} (${debugText})`;
                    }
                }
            }
            catch (debugEx) {
                (0, logger_1.logger)(`[DEBUG] facilitator debug fetch failed: ${debugEx?.message ?? debugEx}`);
            }
        }
        res.status(402).json({
            x402Version,
            error: errMsg,
            accepts: paymentRequirements,
        });
        return resolve(false);
    }
    return resolve(paymentRequirements);
});
exports.verifyPaymentNew = verifyPaymentNew;
const checkx402paymentHeader = (paymentHeader, amount, recipient) => {
    if (paymentHeader?.payload?.authorization?.to?.toLowerCase() !== recipient.toLowerCase()) {
        return false;
    }
    try {
        const _payAmount = BigInt(paymentHeader?.payload?.authorization?.value);
        if (_payAmount !== amount) {
            return false;
        }
    }
    catch (ex) {
        return false;
    }
    return true;
};
const USDC_MinPrice = ethers_1.ethers.parseUnits('0.11', USDC_Base_DECIMALS);
const cashcode_request = async (req, res) => {
    const _routerName = req.path;
    const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`);
    const resource = `${req.protocol}://${req.headers.host}${url.pathname}`;
    const { amount, note, secureCode, hash } = req.query;
    const _price = amount || '0';
    const price = ethers_1.ethers.parseUnits(_price, USDC_Base_DECIMALS);
    if (!amount || price < USDC_MinPrice || !hash) {
        (0, logger_1.logger)(`${_routerName} Error! The minimum amount was not reached.`, (0, node_util_1.inspect)(req.query, false, 3, true));
        return res.status(400).json({ success: false, error: 'The minimum amount was not reached.' });
    }
    const paymentRequirements = [createBeamioExactPaymentRequirements(amount, resource, `Cashcode Payment Request`, beamioConet)];
    const isValid = await (0, exports.verifyPaymentNew)(req, res, paymentRequirements);
    if (!isValid) {
        (0, logger_1.logger)(`${_routerName} !isValid ERROR!`);
        return;
    }
    let responseData;
    const paymentHeader = schemes_1.exact.evm.decodePayment(req.header("X-PAYMENT"));
    const saleRequirements = paymentRequirements[0];
    const isValidPaymentHeader = checkx402paymentHeader(paymentHeader, price, beamioConet);
    if (!isValidPaymentHeader) {
        (0, logger_1.logger)(`${_routerName} checkx402paymentHeader Error!`, (0, node_util_1.inspect)(paymentHeader));
        return res.status(402).end();
    }
    const payload = paymentHeader?.payload;
    // try {
    // 	const settleResponse = await settle(
    // 		paymentHeader,
    // 		saleRequirements)
    // 	const responseHeader = settleResponseHeader(settleResponse)
    // 	// In a real application, you would store this response header
    // 	// and associate it with the payment for later verification
    // 	responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString())
    // 	if (!responseData.success) {
    // 		logger(`${_routerName} responseData ERROR!`, inspect(responseData, false, 3, true))
    // 		return res.status(402).end()
    // 	}
    // } catch (ex: any) {
    // 	console.error("Payment settlement failed:", ex.message)
    // }
    (0, logger_1.logger)((0, node_util_1.inspect)(payload, false, 3, true));
    processToBase.push({
        from: payload.authorization.from,
        erc3009Addr: USDCContract_BASE,
        value: payload.authorization.value,
        validAfter: payload.authorization.validAfter,
        validBefore: payload.authorization.validBefore,
        nonce: payload.authorization.nonce,
        signature: payload.signature,
        hash: hash,
        note: note || '',
        res
    });
    processCheck();
};
exports.cashcode_request = cashcode_request;
/**
 * BeamioTransfer：x402 支付，使用 EIP-3009 TransferWithAuthorization。
 * 客户端用 EOA 私钥签名，authorization.from = EOA，authorization.to = toAddress。
 * 因此仅适用于「EOA 作为付款方」的场景（EOA→EOA、EOA→AA）。
 * AA 作为付款方（AA→EOA）不适用：AA 无私钥无法签 EIP-3009，需单独实现 AA 执行流（如 ERC-4337 UserOp）。
 *
 * 协议：必须使用显式参数，不再依赖 payMe JSON。
 * 必填：amount（usdcAmount）、currency、currencyAmount、toAddress。
 */
const BeamioTransfer = async (req, res) => {
    const _routerName = req.path;
    const resource = buildResourceUrl(req);
    const { amount, usdcAmount, currency, currencyAmount, toAddress, note, requestHash, isInternalTransfer, feePayerForBunit } = req.query;
    const usdcAmt = amount || usdcAmount;
    (0, logger_1.logger)(`[BeamioTransfer] req.query: amount=${usdcAmt} toAddress=${toAddress?.slice(0, 10)}… currency=${currency ?? 'undefined'} resource=${resource}`);
    const _price = usdcAmt || '0';
    const price = ethers_1.ethers.parseUnits(_price, USDC_Base_DECIMALS);
    if (!usdcAmt || price <= 0 || !ethers_1.ethers.isAddress(toAddress)) {
        (0, logger_1.logger)(`${_routerName} Error! The minimum amount was not reached.`, (0, node_util_1.inspect)(req.query, false, 3, true));
        return res.status(400).json({ success: false, error: 'The minimum amount was not reached.' });
    }
    // Cluster 预检：拒绝缺少 currency/currencyAmount 的转账
    if (!currency || !String(currency).trim()) {
        (0, logger_1.logger)(safe_1.default.red(`[BeamioTransfer] REJECT: currency is required (explicit param, no payMe JSON)`));
        return res.status(400).json({ success: false, error: 'currency is required for accounting' });
    }
    if (!currencyAmount || !String(currencyAmount).trim()) {
        (0, logger_1.logger)(safe_1.default.red(`[BeamioTransfer] REJECT: currencyAmount is required (explicit param, no payMe JSON)`));
        return res.status(400).json({ success: false, error: 'currencyAmount is required for accounting' });
    }
    const paymentRequirements = [createBeamioExactPaymentRequirements(usdcAmt, resource, `Beamio Transfer`, toAddress)];
    const isValid = await (0, exports.verifyPaymentNew)(req, res, paymentRequirements);
    if (!isValid) {
        (0, logger_1.logger)(`${_routerName} !isValid ERROR!`);
        return;
    }
    const paymentHeader = schemes_1.exact.evm.decodePayment(req.header("X-PAYMENT"));
    const saleRequirements = paymentRequirements[0];
    const payload = paymentHeader?.payload;
    // Cluster 预检：默认 payer 付 B-Unit；Vouchers 链路约定收款人付（与 vouchersReceivePreCheck 一致）
    const payerEOA = payload?.authorization?.from;
    if (!payerEOA || !ethers_1.ethers.isAddress(payerEOA)) {
        (0, logger_1.logger)(safe_1.default.red(`[BeamioTransfer] REJECT: cannot determine payer from payment`));
        return res.status(400).json({ success: false, error: 'Invalid payment: cannot determine payer' });
    }
    const bunitRole = String(feePayerForBunit ?? 'payer').trim().toLowerCase();
    const payeePaysBunit = bunitRole === 'payee';
    if (payeePaysBunit && String(note ?? '').trim() !== 'Vouchers') {
        (0, logger_1.logger)(safe_1.default.red(`[BeamioTransfer] REJECT: feePayerForBunit=payee requires note=Vouchers`));
        return res.status(400).json({
            success: false,
            error: 'feePayerForBunit=payee is only allowed with note=Vouchers',
        });
    }
    const toNorm = ethers_1.ethers.getAddress(toAddress);
    const bunitFeeAddress = payeePaysBunit ? toNorm : ethers_1.ethers.getAddress(payerEOA);
    const bunitCheck = await beamioTransferPreCheckBUnitBalance(bunitFeeAddress);
    if (!bunitCheck.success) {
        (0, logger_1.logger)(safe_1.default.red(`[BeamioTransfer] B-Unit pre-check FAIL (${payeePaysBunit ? 'payee' : 'payer'}=${bunitFeeAddress.slice(0, 10)}…): ${bunitCheck.error}`));
        return res.status(400).json({ success: false, error: bunitCheck.error });
    }
    let responseData;
    try {
        const settleResponse = await settle(paymentHeader, saleRequirements);
        const responseHeader = (0, types_1.settleResponseHeader)(settleResponse);
        // In a real application, you would store this response header
        // and associate it with the payment for later verification
        responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString());
        if (!responseData.success) {
            (0, logger_1.logger)(`${_routerName} responseData ERROR!`, (0, node_util_1.inspect)(responseData, false, 3, true));
            return res.status(402).end();
        }
        const wallet = responseData.payer;
        const isWallet = ethers_1.ethers.isAddress(wallet);
        const ret = {
            success: true,
            payer: wallet,
            USDC_tx: responseData?.transaction,
            network: responseData?.network,
            timestamp: new Date().toISOString()
        };
        res.status(200).json(ret).end();
        (0, logger_1.logger)((0, node_util_1.inspect)(ret, false, 3, true));
        const authorization = payload?.authorization;
        if (authorization) {
            const from = authorization.from;
            const to = authorization.to;
            const authAmount = authorization.value;
            const record = {
                from, to, amount: authAmount, finishedHash: responseData?.transaction, note: note || ''
            };
            (0, logger_1.logger)((0, node_util_1.inspect)(record, false, 3, true));
            // 使用显式参数 currency/currencyAmount，不再解析 payMe JSON
            const displayJson = buildDisplayJsonFromNoteOnly(note || '', String(responseData?.transaction || ''), isInternalTransfer === 'true' || isInternalTransfer === '1');
            const reqHashValid = requestHash && ethers_1.ethers.isHexString(requestHash) && ethers_1.ethers.dataLength(requestHash) === 32 ? requestHash : undefined;
            // 记账必须 payer≠payee；from=付款方 to=收款方，内部转账时 EOA→AA 为 from=EOA to=AA，AA→EOA 为 from=AA to=EOA
            if (!from || !to || from.toLowerCase() === to.toLowerCase()) {
                (0, logger_1.logger)(safe_1.default.red(`[BeamioTransfer] SKIP accounting: from=to (payer=payee) from=${from} to=${to} txHash=${responseData?.transaction ?? 'n/a'}`));
            }
            else {
                (0, logger_1.logger)(`[BeamioTransfer] submitBeamioTransferIndexerAccounting from=${from} to=${to} requestHash=${reqHashValid ?? 'n/a'} currency=${currency} feePayer=${payeePaysBunit ? 'payee' : 'payer'}`);
                void submitBeamioTransferIndexerAccountingToMaster({
                    from,
                    to,
                    amountUSDC6: authAmount.toString(),
                    finishedHash: String(responseData?.transaction || ''),
                    displayJson,
                    currency: currency,
                    currencyAmount: currencyAmount,
                    requestHash: reqHashValid,
                    isInternalTransfer: isInternalTransfer === 'true' || isInternalTransfer === '1',
                    feePayer: payeePaysBunit ? toNorm : undefined,
                });
            }
        }
        return;
    }
    catch (ex) {
        console.error("Payment settlement failed:", ex.message);
        res.status(500).end();
    }
};
exports.BeamioTransfer = BeamioTransfer;
/**
 * 共享 x402 settle 工具：
 * - 在 cluster 端 `verifyPaymentNew` 通过后，把 USDC 通过 facilitator 真正结算到 `cardOwner`。
 * - 失败路径（缺/坏 X-PAYMENT、settle 错误）已经把 402/500 响应写出，调用方应直接返回。
 *
 * 注意：本函数 **不会** 写出成功响应；返回成功结构体后，调用方负责继续后续业务（如触发 nfcTopup workflow）
 * 并最终通过 `res.status(200).json(...)` 回写。
 */
const settleBeamioX402ToCardOwner = async (req, res, params) => {
    const { cardOwner, quotedUsdc6, description } = params;
    if (!ethers_1.ethers.isAddress(cardOwner)) {
        res.status(400).json({ success: false, error: 'Invalid cardOwner' }).end();
        return null;
    }
    if (quotedUsdc6 <= 0n) {
        res.status(400).json({ success: false, error: 'Invalid quotedUsdc6' }).end();
        return null;
    }
    const resource = buildResourceUrl(req);
    // processPriceToAtomicAmount 把 string price 视为「人类可读 USDC dollar」并再乘 10**6 得到原子单位。
    // 因此必须传人类可读字符串（如 "81.000000"），**绝不能直接传 quotedUsdc6.toString()**（已经是 atomic），
    // 否则会被多乘一次 10^6，前端 wrapFetchWithPayment 看到的 maxAmountRequired 会暴涨到万亿级，
    // 立即触发 "Payment amount exceeds maximum allowed" 客户端拒签。
    const priceUsdcHuman = ethers_1.ethers.formatUnits(quotedUsdc6, 6);
    const paymentRequirements = [createBeamioExactPaymentRequirements(priceUsdcHuman, resource, description, ethers_1.ethers.getAddress(cardOwner))];
    const isValid = await (0, exports.verifyPaymentNew)(req, res, paymentRequirements);
    if (!isValid)
        return null;
    const paymentHeader = schemes_1.exact.evm.decodePayment(req.header('X-PAYMENT'));
    const saleRequirements = paymentRequirements[0];
    const payload = paymentHeader?.payload;
    const auth = payload?.authorization;
    if (!auth || !ethers_1.ethers.isAddress(auth.from) || !ethers_1.ethers.isAddress(auth.to)) {
        res.status(400).json({ success: false, error: 'Invalid payment payload (missing authorization)' }).end();
        return null;
    }
    if (ethers_1.ethers.getAddress(auth.to) !== ethers_1.ethers.getAddress(cardOwner)) {
        res.status(400).json({ success: false, error: 'Payment authorization "to" mismatch with cardOwner' }).end();
        return null;
    }
    if (BigInt(auth.value || '0') < quotedUsdc6) {
        res.status(400).json({ success: false, error: `Payment authorization value < quotedUsdc6 (${auth.value} < ${quotedUsdc6})` }).end();
        return null;
    }
    try {
        const settleResponse = await settle(paymentHeader, saleRequirements);
        const responseHeader = (0, types_1.settleResponseHeader)(settleResponse);
        const responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString());
        if (!responseData.success) {
            (0, logger_1.logger)(safe_1.default.red(`[settleBeamioX402ToCardOwner] settle failed: ${(0, node_util_1.inspect)(responseData, false, 3, true)}`));
            res.status(402).json({ success: false, error: responseData.errorReason ?? 'USDC settle failed' }).end();
            return null;
        }
        return {
            payer: responseData.payer ?? auth.from,
            usdcAmount6: BigInt(auth.value),
            USDC_tx: responseData.transaction,
            network: responseData.network,
            authorization: auth,
        };
    }
    catch (ex) {
        (0, logger_1.logger)(safe_1.default.red(`[settleBeamioX402ToCardOwner] settle exception: ${ex?.message ?? ex}`));
        res.status(500).json({ success: false, error: `USDC settle exception: ${ex?.message ?? ex}` }).end();
        return null;
    }
};
exports.settleBeamioX402ToCardOwner = settleBeamioX402ToCardOwner;
/** 仅从 note 构建 displayJson（forText、card），不解析 payMe。currency/currencyAmount 由显式参数传入 */
function buildDisplayJsonFromNoteOnly(note, finishedHash, isInternalTransfer) {
    const trimmed = note.trim();
    const parts = trimmed.split(/\r?\n/);
    const forTextPart = parts[0]?.trim() || '';
    const rest = parts.slice(1).join('\n').trim();
    let card;
    const jsonMatches = [];
    let i = 0;
    while (rest && i < rest.length) {
        const start = rest.indexOf('{', i);
        if (start < 0)
            break;
        let depth = 0;
        let end = start;
        for (let j = start; j < rest.length; j++) {
            if (rest[j] === '{')
                depth++;
            else if (rest[j] === '}') {
                depth--;
                if (depth === 0) {
                    end = j + 1;
                    break;
                }
            }
        }
        if (depth === 0)
            jsonMatches.push(rest.slice(start, end));
        i = end;
    }
    for (const m of jsonMatches) {
        try {
            const obj = JSON.parse(m);
            if (obj.title != null || obj.detail != null || obj.image != null) {
                card = { title: obj.title, detail: obj.detail, image: obj.image };
            }
            else if (obj.card && typeof obj.card === 'object') {
                const c = obj.card;
                card = { title: c.title, detail: c.detail, image: c.image };
            }
        }
        catch (_) { /* ignore */ }
    }
    const d = {
        title: isInternalTransfer ? 'EOA to AA' : 'Beamio Transfer',
        source: isInternalTransfer ? 'eoa-aa' : 'x402',
        finishedHash,
        handle: (forTextPart && !/^\{/.test(forTextPart) ? forTextPart : '').slice(0, 80),
        forText: forTextPart && !/^\{/.test(forTextPart) ? forTextPart : undefined,
        card,
    };
    return JSON.stringify(d);
}
/** @deprecated 不再用于 BeamioTransfer 记账，仅保留供 beamioTransferIndexerAccounting 的 note 回退路径 */
function buildDisplayJsonFromNote(note, finishedHash, source) {
    const trimmed = note.trim();
    const parts = trimmed.split(/\r?\n/);
    const forTextPart = parts[0]?.trim() || '';
    const rest = parts.slice(1).join('\n').trim();
    let parsed = {};
    let card;
    const jsonMatches = [];
    let i = 0;
    while (rest && i < rest.length) {
        const start = rest.indexOf('{', i);
        if (start < 0)
            break;
        let depth = 0;
        let end = start;
        for (let j = start; j < rest.length; j++) {
            if (rest[j] === '{')
                depth++;
            else if (rest[j] === '}') {
                depth--;
                if (depth === 0) {
                    end = j + 1;
                    break;
                }
            }
        }
        if (depth === 0)
            jsonMatches.push(rest.slice(start, end));
        i = end;
    }
    for (const m of jsonMatches) {
        try {
            const obj = JSON.parse(m);
            // 优先使用 payMe 格式（data1）的 currency/currencyAmount；card JSON 的 currencyAmount 可能带 "CA$" 前缀导致服务器 parseFloat 失败
            if ((obj.currency != null || obj.currencyAmount != null) && (parsed.currency == null && parsed.currencyAmount == null)) {
                parsed.currency = obj.currency;
                parsed.currencyAmount = obj.currencyAmount;
            }
            if (obj.requestHash != null && typeof obj.requestHash === 'string') {
                parsed.requestHash = obj.requestHash;
            }
            if (obj.isInternalTransfer === true) {
                parsed.isInternalTransfer = true;
            }
            if (obj.title != null || obj.detail != null || obj.image != null) {
                card = {
                    title: obj.title,
                    detail: obj.detail,
                    image: obj.image,
                };
            }
            else if (obj.card && typeof obj.card === 'object') {
                const c = obj.card;
                card = {
                    title: c.title,
                    detail: c.detail,
                    image: c.image,
                };
            }
        }
        catch (_) { /* ignore */ }
    }
    const d = {
        title: parsed.isInternalTransfer ? 'EOA to AA' : (source === 'x402' ? 'Beamio Transfer' : 'AA to EOA (Internal)'),
        source: parsed.isInternalTransfer ? 'eoa-aa' : source,
        finishedHash,
        handle: (forTextPart && !/^\{/.test(forTextPart) ? forTextPart : '').slice(0, 80),
        forText: forTextPart && !/^\{/.test(forTextPart) ? forTextPart : undefined,
        card,
    };
    return {
        displayJson: JSON.stringify(d),
        currency: parsed.currency,
        currencyAmount: parsed.currencyAmount != null ? String(parsed.currencyAmount) : undefined,
        requestHash: parsed.requestHash,
        isInternalTransfer: parsed.isInternalTransfer,
    };
}
const submitBeamioTransferIndexerAccountingToMaster = async (payload) => {
    if (!ethers_1.ethers.isAddress(payload.from) || !ethers_1.ethers.isAddress(payload.to)) {
        return;
    }
    try {
        if (!payload.amountUSDC6 || BigInt(payload.amountUSDC6) <= 0n) {
            return;
        }
    }
    catch {
        return;
    }
    if (!ethers_1.ethers.isHexString(payload.finishedHash) || ethers_1.ethers.dataLength(payload.finishedHash) !== 32) {
        return;
    }
    const gasFields = await estimateTransferGasFields(payload.finishedHash);
    const option = {
        hostname: 'localhost',
        path: '/api/beamioTransferIndexerAccounting',
        port: masterServerPort,
        method: 'POST',
        protocol: 'http:',
        headers: {
            'Content-Type': 'application/json',
        },
    };
    await new Promise((resolve) => {
        const req = (0, node_http_1.request)(option, (res) => {
            let body = '';
            res.on('data', (c) => { body += c.toString(); });
            res.on('end', () => {
                if ((res.statusCode || 500) >= 400) {
                    (0, logger_1.logger)(`[BeamioTransfer] submitBeamioTransferIndexerAccountingToMaster failed status=${res.statusCode} body=${body}`);
                }
                resolve();
            });
        });
        req.once('error', (e) => {
            (0, logger_1.logger)(`[BeamioTransfer] submitBeamioTransferIndexerAccountingToMaster error: ${e.message}`);
            resolve();
        });
        const feePayerResolved = payload.feePayer && ethers_1.ethers.isAddress(payload.feePayer) ? ethers_1.ethers.getAddress(payload.feePayer) : ethers_1.ethers.getAddress(payload.from);
        const body = {
            from: payload.from,
            to: payload.to,
            amountUSDC6: payload.amountUSDC6,
            finishedHash: payload.finishedHash,
            displayJson: payload.displayJson,
            currency: payload.currency,
            currencyAmount: payload.currencyAmount,
            gasWei: gasFields.gasWei,
            gasUSDC6: gasFields.gasUSDC6,
            gasChainType: gasFields.gasChainType,
            baseGas: gasFields.baseGas,
            feePayer: feePayerResolved,
            source: 'x402',
        };
        if (payload.requestHash)
            body.requestHash = payload.requestHash;
        if (payload.isInternalTransfer)
            body.isInternalTransfer = true;
        req.write(JSON.stringify(body));
        req.end();
    });
};
const estimateTransferGasFields = async (txHash) => {
    const GAS_CHAIN_TYPE_ETH = 0;
    const CURRENCY_USDC = 4;
    const CURRENCY_ETH = 9;
    const E18 = 10n ** 18n;
    const E6 = 10n ** 6n;
    try {
        const receipt = await providerBase.getTransactionReceipt(txHash);
        if (!receipt) {
            return { gasWei: '0', gasUSDC6: '0', gasChainType: GAS_CHAIN_TYPE_ETH, baseGas: '0' };
        }
        const gasUsed = receipt.gasUsed ?? 0n;
        let gasPrice = receipt.gasPrice ?? 0n;
        if (gasPrice <= 0n) {
            const tx = await providerBase.getTransaction(txHash);
            gasPrice = tx?.gasPrice ?? 0n;
        }
        const gasWei = gasUsed * gasPrice;
        let gasUSDC6 = 0n;
        try {
            // BeamioOracle: rate = "1 currency = X USD" (E18)
            const [ethUsdE18, usdcUsdE18] = await Promise.all([
                oracleSCBase.getRate(CURRENCY_ETH),
                oracleSCBase.getRate(CURRENCY_USDC),
            ]);
            if (ethUsdE18 > 0n && usdcUsdE18 > 0n && gasWei > 0n) {
                // wei -> USD(E18): gasWei * ethUsd / 1e18
                const usdE18 = (gasWei * ethUsdE18) / E18;
                // USD(E18) -> USDC(6): usdE18 * 1e6 / usdcUsdE18, round half up
                gasUSDC6 = (usdE18 * E6 + (usdcUsdE18 / 2n)) / usdcUsdE18;
            }
        }
        catch (oracleErr) {
            (0, logger_1.logger)(`[BeamioTransfer] estimateTransferGasFields oracle fallback gasUSDC6=0: ${oracleErr?.message ?? String(oracleErr)}`);
        }
        return {
            gasWei: gasWei.toString(),
            gasUSDC6: gasUSDC6.toString(),
            gasChainType: GAS_CHAIN_TYPE_ETH,
            baseGas: gasUsed.toString(),
        };
    }
    catch (ex) {
        (0, logger_1.logger)(`[BeamioTransfer] estimateTransferGasFields failed: ${ex?.message ?? String(ex)}`);
        return { gasWei: '0', gasUSDC6: '0', gasChainType: GAS_CHAIN_TYPE_ETH, baseGas: '0' };
    }
};
/** PR (USDC charge settle ledger):
 * `keccak256("usdcCharge:settle")` —— BeamioIndexerDiamond.syncTokenAction 的 `ledgerTxCategory`，
 * 标记一行**独立**的 USDC settle ledger 行（payer → cardOwner，Base USDC `transferWithAuthorization`）。
 *
 * 在 charge 流程中，这是 orchestrator 三段「L0 settle / L1 topup / L2 charge」中的 **L0** 行，
 * 与 L1 topup 主单 / L2 charge 主单完全分开。链下对账以 `finishedHash = USDC_tx` 作为 join key，
 * 与 PG `beamio_member_topup_events.originating_usdc_tx` 一致。 */
exports.TX_CATEGORY_USDC_CHARGE_SETTLE = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('usdcCharge:settle'));
/** Merchant OS parent admin reset POS terminal quotas on Base；CoNET indexer 单行标点：`payer`=上级 admin EOA，`payee`=Terminal EOA。 */
exports.TX_CATEGORY_TERMINAL_RESET = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('TX_Terminal_RESET'));
/** Fire-and-forget：USDC charge settle 成功后，独立向 BeamioIndexerDiamond 推一行 ledger。
 *
 * 复用既存 Master `/api/beamioTransferIndexerAccounting` 端点 + `beamioTransferIndexerAccountingPool`；
 * 这条行：
 *   - `from = payer`、`to = cardOwner`、`finishedHash = USDC_tx`、`source = 'x402'`；
 *   - `ledgerTxCategory = TX_CATEGORY_USDC_CHARGE_SETTLE`，与 L1 topup（`creditTopupCard` 等）/ L2 charge 主单互斥；
 *   - `routeItems` 单元素：USDC@Base 资产、`amountE6 = usdcAmount6`（charge 主单 / topup 主单也带 USDC route，
 *     但 category 不同，Indexer 不会去重）；
 *   - `bServiceUSDC6 / bServiceUnits6 = 0`（settle 段无 B-Unit 服务费——B-Unit 费在 L1 topup 段独立记账）；
 *   - 无 `requestHash`（charge 不绑 payMe Voucher），跳过 `runRequestHashPreCheck`；
 *   - `currency / currencyAmount` 为商户卡币种（CAD/USD/...），与 NFC charge 主单 currency 字段一致；
 *   - `ledgerFinalRequestAmountFiat6 = total e6`、`ledgerFinalRequestAmountUSDC6 = usdcAmount6`；
 *   - `ledgerMetaRequestAmountFiat6 = subtotal e6`、`ledgerMetaDiscount/Tax*` 反映原始 breakdown。
 *
 * 失败仅 logger，不抛；charge 主链路（USDC settle 完成 + orchestrator 启动）不会被阻塞。
 * 设计目的：让独立查询「USDC 在哪些时刻到了商户 cardOwner EOA」时，**不必再 join topup 主单**。 */
const submitUsdcChargeSettleIndexer = async (params) => {
    try {
        if (!ethers_1.ethers.isAddress(params.payer) || !ethers_1.ethers.isAddress(params.cardOwner) || !ethers_1.ethers.isAddress(params.cardAddress)) {
            (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] skip: invalid address (payer/cardOwner/cardAddress)`));
            return;
        }
        if (params.payer.toLowerCase() === params.cardOwner.toLowerCase()) {
            (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] skip: payer==cardOwner ${params.payer}`));
            return;
        }
        const usdcAmount6Big = typeof params.usdcAmount6 === 'bigint' ? params.usdcAmount6 : BigInt(params.usdcAmount6);
        if (usdcAmount6Big <= 0n) {
            (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] skip: usdcAmount6 <= 0`));
            return;
        }
        if (!params.usdcTxHash || !ethers_1.ethers.isHexString(params.usdcTxHash) || ethers_1.ethers.dataLength(params.usdcTxHash) !== 32) {
            (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] skip: invalid usdcTxHash ${params.usdcTxHash}`));
            return;
        }
        const cur = (params.currency || '').toString().trim().toUpperCase() || 'CAD';
        const totalNum = Number(params.totalCurrencyAmount);
        if (!Number.isFinite(totalNum) || totalNum <= 0) {
            (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] skip: invalid totalCurrencyAmount ${params.totalCurrencyAmount}`));
            return;
        }
        const subtotalNum = Number(params.subtotalCurrencyAmount);
        const fiat6 = (n) => BigInt(Math.max(0, Math.round(n * 1_000_000))).toString();
        const totalFiat6 = fiat6(totalNum);
        const subtotalFiat6 = Number.isFinite(subtotalNum) && subtotalNum > 0 ? fiat6(subtotalNum) : totalFiat6;
        const USDC_BASE_ADDRESS = ethers_1.ethers.getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
        const usdcAmount6Str = usdcAmount6Big.toString();
        const displayJson = JSON.stringify({
            title: 'USDC Charge Settle',
            source: 'usdcChargeSettle',
            finishedHash: params.usdcTxHash,
            cardAddress: ethers_1.ethers.getAddress(params.cardAddress),
            cardOwner: ethers_1.ethers.getAddress(params.cardOwner),
            payer: ethers_1.ethers.getAddress(params.payer),
            pos: params.posOperator && ethers_1.ethers.isAddress(params.posOperator) ? ethers_1.ethers.getAddress(params.posOperator) : undefined,
            sid: params.sid ?? undefined,
            currency: cur,
            currencyAmount: params.totalCurrencyAmount,
            breakdown: {
                subtotal: params.subtotalCurrencyAmount,
                discountFiat6: params.discountAmountFiat6 ?? '0',
                discountBps: Number.isFinite(Number(params.discountRateBps)) ? Number(params.discountRateBps) : 0,
                taxFiat6: params.taxAmountFiat6 ?? '0',
                taxBps: Number.isFinite(Number(params.taxRateBps)) ? Number(params.taxRateBps) : 0,
                tip: params.tipCurrencyAmount ?? '0',
                tipBps: Number.isFinite(Number(params.tipRateBps)) ? Number(params.tipRateBps) : 0,
                total: params.totalCurrencyAmount,
            },
            usdcAmount6: usdcAmount6Str,
        });
        const gasFields = await estimateTransferGasFields(params.usdcTxHash);
        const body = {
            from: ethers_1.ethers.getAddress(params.payer),
            to: ethers_1.ethers.getAddress(params.cardOwner),
            amountUSDC6: usdcAmount6Str,
            finishedHash: params.usdcTxHash,
            displayJson,
            currency: cur,
            currencyAmount: params.totalCurrencyAmount,
            gasWei: gasFields.gasWei,
            gasUSDC6: gasFields.gasUSDC6,
            gasChainType: gasFields.gasChainType,
            baseGas: gasFields.baseGas,
            // settle 由 x402 facilitator 代付 gas，链上 fee payer 是 facilitator EOA；ledger 这里用 payer
            // （顾客 EOA，发起 EIP-3009 授权的人）作为账面 feePayer，与既存 `submitBeamioTransferIndexerAccountingToMaster`
            // (`source='x402'`) 的口径一致。
            feePayer: ethers_1.ethers.getAddress(params.payer),
            source: 'x402',
            payeeEOA: ethers_1.ethers.getAddress(params.cardOwner),
            merchantCardAddress: ethers_1.ethers.getAddress(params.cardAddress),
            ledgerTxId: params.usdcTxHash,
            ledgerOriginalPaymentHash: ethers_1.ethers.ZeroHash,
            ledgerTxCategory: exports.TX_CATEGORY_USDC_CHARGE_SETTLE,
            ledgerFinalRequestAmountFiat6: totalFiat6,
            ledgerFinalRequestAmountUSDC6: usdcAmount6Str,
            ledgerMetaRequestAmountFiat6: subtotalFiat6,
            ledgerMetaRequestAmountUSDC6: usdcAmount6Str,
            ledgerMetaDiscountAmountFiat6: params.discountAmountFiat6 ?? '0',
            ledgerMetaDiscountRateBps: Number.isFinite(Number(params.discountRateBps)) ? Number(params.discountRateBps) : 0,
            ledgerMetaTaxAmountFiat6: params.taxAmountFiat6 ?? '0',
            ledgerMetaTaxRateBps: Number.isFinite(Number(params.taxRateBps)) ? Number(params.taxRateBps) : 0,
            bServiceUSDC6: '0',
            bServiceUnits6: '0',
            routeItems: [
                {
                    asset: USDC_BASE_ADDRESS,
                    amountE6: usdcAmount6Str,
                    assetType: 0,
                    source: 0,
                    tokenId: '0',
                    itemCurrencyType: 4, // USDC
                    offsetInRequestCurrencyE6: usdcAmount6Str,
                },
            ],
        };
        const option = {
            hostname: 'localhost',
            path: '/api/beamioTransferIndexerAccounting',
            port: masterServerPort,
            method: 'POST',
            protocol: 'http:',
            headers: { 'Content-Type': 'application/json' },
        };
        await new Promise((resolve) => {
            const req = (0, node_http_1.request)(option, (resp) => {
                let buf = '';
                resp.on('data', (c) => { buf += c.toString(); });
                resp.on('end', () => {
                    if ((resp.statusCode || 500) >= 400) {
                        (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] master returned ${resp.statusCode} body=${buf.slice(0, 240)} ` +
                            `USDC_tx=${params.usdcTxHash} payer=${params.payer.slice(0, 10)}… cardOwner=${params.cardOwner.slice(0, 10)}…`));
                    }
                    else {
                        (0, logger_1.logger)(safe_1.default.cyan(`[submitUsdcChargeSettleIndexer] enqueued OK USDC_tx=${params.usdcTxHash} ` +
                            `payer=${params.payer.slice(0, 10)}… cardOwner=${params.cardOwner.slice(0, 10)}… usdc6=${usdcAmount6Str} sid=${params.sid ?? 'n/a'}`));
                    }
                    resolve();
                });
            });
            req.once('error', (e) => {
                (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] master unreachable: ${e.message}`));
                resolve();
            });
            req.write(JSON.stringify(body));
            req.end();
        });
    }
    catch (err) {
        (0, logger_1.logger)(safe_1.default.yellow(`[submitUsdcChargeSettleIndexer] non-critical: ${err?.message ?? String(err)}`));
    }
};
exports.submitUsdcChargeSettleIndexer = submitUsdcChargeSettleIndexer;
/** 将 gasWei 通过 BeamioOracle 换算为 gasUSDC6，供 beamioTransferIndexerAccounting 使用 */
const convertGasWeiToUSDC6 = async (gasWei) => {
    const CURRENCY_USDC = 4;
    const CURRENCY_ETH = 9;
    const E18 = 10n ** 18n;
    const E6 = 10n ** 6n;
    if (gasWei <= 0n)
        return 0n;
    try {
        const [ethUsdE18, usdcUsdE18] = await Promise.all([
            oracleSCBase.getRate(CURRENCY_ETH),
            oracleSCBase.getRate(CURRENCY_USDC),
        ]);
        if (ethUsdE18 <= 0n || usdcUsdE18 <= 0n)
            return 0n;
        const usdE18 = (gasWei * ethUsdE18) / E18;
        return (usdE18 * E6 + (usdcUsdE18 / 2n)) / usdcUsdE18;
    }
    catch (e) {
        (0, logger_1.logger)(`[convertGasWeiToUSDC6] oracle failed: ${e?.message ?? String(e)}`);
        return 0n;
    }
};
exports.convertGasWeiToUSDC6 = convertGasWeiToUSDC6;
const generateCODE = (passcode) => {
    const code = uuid62.v4();
    const hash = ethers_1.ethers.solidityPackedKeccak256(['string', 'string'], [code, passcode]);
    return ({
        code, hash
    });
};
async function AuthorizationSign(amount, to, privateKey, DECIMALS, CHAIN_ID, TOKEN_ADDRESS) {
    // 1) 签名者
    const wallet = new ethers_1.ethers.Wallet(privateKey);
    const from = await wallet.getAddress();
    // 2) 金额 & 时间窗（现在 - 1s 到 24h 后）
    const value = ethers_1.ethers.parseUnits(amount, DECIMALS); // bigint
    const now = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = now - 60n;
    const validBefore = now + 60n; // 1 分钟有效
    // 3) 随机 nonce（bytes32）
    const nonce = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
    // 4) EIP-712 域 & 类型 & 数据（与你合约里的 TYPEHASH 字段严格一致）
    const domain = {
        name: "USD Coin", // ERC20Permit(name) -> 你的合约构造里是 "USDC"
        version: "2", // OpenZeppelin ERC20Permit 的默认版本是 "1"
        chainId: 8453, // 必须与链实际 ID 一致
        verifyingContract: USDCContract_BASE,
    };
    const AuthorizationTypes = {
        TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
        ],
    };
    const message = {
        from,
        to,
        value,
        validAfter,
        validBefore,
        nonce,
    };
    // 5) 签名（返回 0x + 65 字节，合约的 bytes 接口可直接用）
    const signature = await wallet.signTypedData(domain, AuthorizationTypes, message);
    return {
        signature,
        authorization: {
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
        }
    };
}
// const AuthorizationCallUSDC = async (data: AuthorizationPayload) => {
// 	const SC = Settle_ContractPool[0]
// 	try {
// 		const tx = await SC.conetUSDC.transferWithAuthorization(
// 			data.from,
// 			data.to,
// 			data.value,
// 			data.validAfter,
// 			data.validBefore,
// 			data.nonce,
// 			data.signature
// 		)
// 		await tx.wait()
// 		logger(`AuthorizationCall success ${tx.hash}`)
// 	} catch (ex: any) {
// 		logger(`Error! ${ex.message}`)
// 	}
// }
const withdrawWithCode = async (code, passcode, to) => {
    const SC = exports.Settle_ContractPool[0];
    try {
        const tx = await SC.conetSC.withdrawWithCode(code + passcode, to);
        await tx.wait();
        (0, logger_1.logger)(`withdrawWithCode success ${tx.hash}`);
    }
    catch (ex) {
        (0, logger_1.logger)(`withdrawWithCode Error! ${ex.message}`);
    }
};
const generateCheck = async (req, res) => {
    const { amount, note, secureCode } = req.query;
    const totalAmount = Number(amount);
    const checkNode = (!note || note.split('\r\n').length < 2);
    if (!amount || isNaN(totalAmount) || totalAmount < 0.1 || !secureCode || checkNode || !ethers_1.ethers.isHexString(secureCode)) {
        (0, logger_1.logger)(`generateCheck stage 1 error!`);
        return res.status(400);
    }
    const SC = exports.Settle_ContractPool[0];
    (0, logger_1.logger)(`secureCode : ${secureCode} , note : ${note} , amount ${amount}`);
    try {
        const [from] = await SC.conetSC.checkMemo(secureCode);
        (0, logger_1.logger)(`generateCheck ${from} `);
        if (from !== ethers_1.ethers.ZeroAddress) {
            (0, logger_1.logger)(`withdrawWithCode ${secureCode} is exiets `);
            return res.status(403).end();
        }
        const amt = ethers_1.ethers.parseUnits(amount, 6);
        const requestX402 = await BeamioPayment(req, res, amt, beamiobase);
        if (!requestX402 || !requestX402?.authorization) {
            return res.status(403).end();
        }
        const payload = requestX402.authorization;
        depositWith3009AuthorizationPayLinkPool.push({
            from: payload.from,
            to: '',
            value: payload.value,
            validAfter: payload.validAfter,
            validBefore: payload.validBefore,
            signature: requestX402.signature,
            res: res,
            note: note,
            nonce: payload.nonce,
            linkHash: secureCode,
            newHash: true
        });
        depositWith3009AuthorizationPayLinkProcess();
    }
    catch (ex) {
        (0, logger_1.logger)(`generateCheck SC.conetSC.checkMemo(secureCode) Error!, `, ex.message);
    }
};
exports.generateCheck = generateCheck;
const processCheck = async () => {
    const obj = processToBase.shift();
    if (!obj) {
        return;
    }
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        processToBase.unshift(obj);
        return;
    }
    const baseRpcUrl = (0, exports.getBaseRpcUrlViaConetNode)() ?? BASE_RPC_URL;
    const baseClient = (0, viem_1.createPublicClient)({ chain: chains_1.base, transport: (0, viem_1.http)(baseRpcUrl) });
    let baseHash;
    try {
        // baseHash = await SC.baseWalletClient.writeContract({
        // 	address: CashCodeBaseAddr,
        // 	abi: CoinCodeABI,
        // 	functionName: 'depositWith3009Authorization',
        // 	args: [obj.from, USDCContract_BASE, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature, obj.hash]
        // })
        const tx = await SC.baseSC.depositWith3009Authorization(obj.from, USDCContract_BASE, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature, obj.hash);
        // await tx.wait()
        const rx = await SC.conetSC.checkMemoGenerate(obj.hash, obj.from, obj.value, baseHash, '8453', USDCContract_BASE, '6', obj.note);
        await Promise.all([
            rx.wait(),
            baseClient.waitForTransactionReceipt({ hash: baseHash })
        ]);
        (0, logger_1.logger)(`processCheck BASE success! ${baseHash} processCheck CONET success! ${rx.hash}`);
        obj.res.status(200).json({ success: true, USDC_tx: baseHash }).end();
    }
    catch (ex) {
        obj.res.status(404).json({ error: 'CashCode Server Error' }).end();
        (0, logger_1.logger)(`processCheck Error! ${ex.message}`);
        (0, logger_1.logger)((0, node_util_1.inspect)({ codeHash: obj.hash, from: obj.from, value: obj.value, successAuthorizationHash: baseHash, chianID: '8453', erc3009Address: USDCContract_BASE, decimals: '6', note: obj.note }, false, 3, true));
    }
    exports.Settle_ContractPool.push(SC);
    setTimeout(() => {
        processCheck();
    }, 1000);
};
const processToBase = [];
const processCheckWithdrawPool = [];
const processCheckWithdraw = async () => {
    const obj = processCheckWithdrawPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        processCheckWithdrawPool.unshift();
        return setTimeout(() => {
            processCheckWithdraw();
        }, 1000);
    }
    const baseRpcUrl = (0, exports.getBaseRpcUrlViaConetNode)() ?? BASE_RPC_URL;
    const baseClient = (0, viem_1.createPublicClient)({ chain: chains_1.base, transport: (0, viem_1.http)(baseRpcUrl) });
    try {
        const hash = ethers_1.ethers.solidityPackedKeccak256(['string'], [obj.code]);
        // const baseHash = await SC.baseWalletClient.writeContract({
        // 	address: CashCodeBaseAddr,
        // 	abi: CoinCodeABI,
        // 	functionName: 'withdrawWithCode',
        // 	args: [obj.code, obj.address]
        // })
        const tx = await SC.baseSC.withdrawWithCode(obj.code, obj.address);
        const tr = await SC.conetSC.finishedCheck(hash, tx.hash, obj.address);
        await Promise.all([
            tx.wait(),
            tr.wait()
        ]);
        obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end();
        (0, logger_1.logger)(`processCheckWithdraw success! BASE = ${tx.hash} CONET = ${tr.hash}`);
    }
    catch (ex) {
        (0, logger_1.logger)('processCheckWithdraw error!', ex.message);
        obj.res.status(404).json({ error: 'Server error!' }).end();
    }
    exports.Settle_ContractPool.push(SC);
    setTimeout(() => {
        processCheckWithdraw();
    }, 1000);
};
const cashcode_check = (req, res) => {
    const { code, address } = req.query;
    if (!code || !address || !ethers_1.ethers.isAddress(address)) {
        (0, logger_1.logger)(`cashcode_check Format Error!`);
        return res.status(404).end();
    }
    (0, logger_1.logger)(`cashcode_check`, (0, node_util_1.inspect)({ address, code }, false, 3, true));
    processCheckWithdrawPool.push({
        address,
        res,
        code
    });
    processCheckWithdraw();
};
exports.cashcode_check = cashcode_check;
exports.x402ProcessPool = [];
exports.facilitatorsPool = [];
const facilitators = async () => {
    const obj = exports.facilitatorsPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        exports.facilitatorsPool.unshift(obj);
        return setTimeout(() => (0, exports.facilitators)(), 1000);
    }
    const wallet = obj.from;
    try {
        // const baseHash = await SC.baseWalletClient.writeContract({
        // 	address: USDCContract_BASE,
        // 	abi: USDC_ABI,
        // 	functionName: 'transferWithAuthorization',
        // 	args: [obj.from, obj.isSettle ? SETTLEContract: CashCodeBaseAddr, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature]
        // })
        const tx = await SC.baseUSDC.transferWithAuthorization(obj.from, beamiobase, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature);
        // const baseClient = createPublicClient({chain: base, transport: http(`http://${getRandomNode()}/base-rpc`)})
        // // await tx.wait()
        // await baseClient.waitForTransactionReceipt({ hash: baseHash })
        // logger(`facilitators success! ${baseHash}`)
        const ret = {
            success: true,
            payer: wallet,
            USDC_tx: tx.hash,
            network: 'BASE',
            timestamp: new Date().toISOString()
        };
        obj.res.status(200).json(ret).end();
        exports.Settle_ContractPool.push(SC);
        if (obj.isSettle) {
            exports.x402ProcessPool.push({
                wallet,
                settle: ethers_1.ethers.parseUnits('0.001', 6).toString()
            });
        }
        // await process_x402()
        return setTimeout(() => (0, exports.facilitators)(), 1000);
    }
    catch (ex) {
        (0, logger_1.logger)(`facilitators Error!`, ex.message);
    }
    //	transferWithAuthorization
    exports.Settle_ContractPool.push(SC);
    setTimeout(() => (0, exports.facilitators)(), 1000);
};
exports.facilitators = facilitators;
// export const process_x402 = async () => {
// 	console.debug(`process_x402`)
// 	const obj = x402ProcessPool.shift()
// 	if (!obj) {
// 		return
// 	}
// 	const SC = Settle_ContractPool.shift()
// 	if (!SC) {
// 		logger(`process_x402 got empty Settle_testnet_pool`)
// 		x402ProcessPool.unshift(obj)
// 		return
// 	}
// 	const baseClient = createPublicClient({chain: base, transport: http(`http://${getRandomNode()}/base-rpc`)})
// 	try {
// 		// const baseHash = await SC.baseWalletClient.writeContract({
// 		// 	address: SETTLEContract,
// 		// 	abi: Settle_ABI,
// 		// 	functionName: 'mint',
// 		// 	args: [obj.wallet, obj.settle]
// 		// })
// 		// await baseClient.waitForTransactionReceipt({ hash: baseHash })
// 		const tx = await SC.base.mint(
// 			obj.wallet, obj.settle
// 		)
// 		// await tx.wait()
// 		const SETTLE = BigInt(obj.settle) * MINT_RATE / USDC_decimals
// 		const ts = await SC.event.eventEmit(
// 			obj.wallet, obj.settle, SETTLE, baseHash
// 		)
// 		await ts.wait()
// 		reflashData.unshift({
// 			wallet: obj.wallet,
// 			hash: baseHash,
// 			USDC: obj.settle,
// 			timestmp: new Date().toUTCString(),
// 			SETTLE: SETTLE.toString(),
// 		})
// 		logger(`process_x402 success! ${baseHash}`)
// 	} catch (ex: any) {
// 		logger(`Error process_x402 `, ex.message)
// 		x402ProcessPool.unshift(obj)
// 	}
// 	Settle_ContractPool.push(SC)
// 	setTimeout(() => process_x402(), 1000)
// }
let lastGasEstimate = null;
// 当前是否有进行中的估算请求（用 Promise 复用同一次调用）
let pendingEstimate = null;
// export const estimateErc20TransferGas = async (
// 	usdc: string,
// 	RecipientAddress: string,
// 	fromAddress: string
// ) => {
//   const now = Date.now()
//   // 1）有 15 秒内的缓存 → 直接返回
//   if (lastGasEstimate && (now - lastGasEstimate.ts) < 15_000) {
//     return lastGasEstimate.data
//   }
//   // 2）如果已经有进行中的 RPC 调用 → 等待 1 秒，然后复用它的结果
//   if (pendingEstimate) {
//     // 等待 1 秒（你要求的延迟）
//     await new Promise(resolve => setTimeout(resolve, 1_000))
//     // 再次检查：如果 1 秒内 RPC 完成了，缓存就应该是最新的
//     if (lastGasEstimate && (Date.now() - lastGasEstimate.ts) < 15_000) {
//       return lastGasEstimate.data
//     }
//     // 如果缓存还是没更新，就直接等待那次进行中的调用完成
//     try {
//       const data = await pendingEstimate
//       return data
//     } catch {
// 		return null
//     }
//   }
//   // 3）没有缓存、也没有进行中的请求 → 发起新的 RPC 调用
//   const node = getRandomNode()
//   const baseClient = createPublicClient({
//     chain: base,
//     transport: http(`http://${node}/base-rpc`)
// 	// transport: http(`http://94.143.138.27/base-rpc`)
//   })
//   pendingEstimate = (async () => {
//     const [gas, price] = await Promise.all([
//       baseClient.estimateContractGas({
//         address: USDCContract_BASE,
//         abi: USDC_ABI,
//         functionName: 'transfer',
//         account: fromAddress as `0x${string}`,
//         args: [
//           RecipientAddress,
//           ethers.parseUnits(usdc, 6)
//         ]
//       }),
//       baseClient.getGasPrice()
//     ])
// 	if (typeof gas !== 'bigint' || typeof price !== 'bigint' || !price || !gas) {
// 		const error = new Error(`Node = ${node} return null result! gas = ${gas} price = ${price}`)
// 		logger(error)
// 		throw(error)
// 	}
//     const result = {
//       gas: gas.toString(),
//       price: price.toString(),
//       ethPrice: oracle.eth
//     }
// 	logger(inspect(result, false, 3, true))
//     // 写入缓存
//     lastGasEstimate = {
//       data: result,
//       ts: Date.now()
//     }
//     return result
//   })()
//   try {
//     const data = await pendingEstimate
//     return data
//   } catch(ex: any) {
// 		logger(ex.message)
//   }
//    finally {
//     // 这次调用结束后，清空 pending 状态
//     pendingEstimate = null
//   }
// }
const linkMemo = [];
const baseChainID = 8453;
const linkMemoGenerate = async () => {
    const obj = linkMemo.shift();
    if (!obj) {
        return;
    }
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        linkMemo.unshift(obj);
        return setTimeout(() => linkMemoGenerate(), 1000);
    }
    try {
        const tx = await SC.conetSC.linkMemoGenerate(obj.linkHash, obj.to, obj.value, baseChainID, USDCContract_BASE, USDC_Base_DECIMALS, obj.note);
        if (obj.res)
            obj.res.status(200).json({ success: true, hash: tx.hash }).end();
        await tx.wait();
        (0, logger_1.logger)(`linkMemoGenerate Success, ${tx.hash}!`, (0, node_util_1.inspect)({ linkHash: obj.linkHash, to: obj.to, value: obj.value, note: obj.note }, false, 3, true));
    }
    catch (ex) {
        (0, logger_1.logger)(`linkMemoGenerate Error, ${ex.message}`);
        if (obj.res)
            obj.res.status(200).json({ success: false }).end();
    }
    exports.Settle_ContractPool.push(SC);
    setTimeout(() => linkMemoGenerate, 1000);
};
// =============================
//  Balance Cache: 60 秒记忆
// =============================
const balanceCache = {};
const getOracleRequest = () => {
    return oracle;
};
exports.getOracleRequest = getOracleRequest;
/** Cluster 进程不会自己跑 oracolPrice()，由其从 master /api/oracleForCluster 拉到快照后调用本函数同步进
 * util.ts 全局 oracle，确保 quoteCurrencyToUsdc6 / nfcTopupPreparePayload 在 cluster 端也能拿到真实链上汇率，
 * 而不是悄悄回退到写死的 fallback 常量（参见 beamio-currency-protocol：禁止固定汇率给客户报价）。 */
const setOracleSnapshot = (snap) => {
    if (!snap || typeof snap !== 'object')
        return;
    const pickStr = (k) => {
        const v = snap[k];
        if (v === undefined || v === null)
            return undefined;
        const s = String(v);
        return s.length ? s : undefined;
    };
    const pickNum = (k) => {
        const v = snap[k];
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    };
    const fields = ['bnb', 'eth', 'usdc', 'usdcad', 'usdjpy', 'usdcny', 'usdhkd', 'usdeur', 'usdsgd', 'usdtwd'];
    for (const f of fields) {
        const v = pickStr(f);
        if (v !== undefined)
            oracle[f] = v;
    }
    const ts = pickNum('timestamp');
    if (ts !== undefined && ts > 0)
        oracle.timestamp = ts;
};
exports.setOracleSnapshot = setOracleSnapshot;
/** Oracle 报价新鲜度阈值（秒）。超过则视为 stale，不允许用于客户报价。 */
exports.ORACLE_FRESH_WINDOW_SEC = 10 * 60;
/** 判断当前 oracle 快照是否新鲜：timestamp 必须存在，并落在阈值窗口内。 */
const isOracleFresh = (windowSec = exports.ORACLE_FRESH_WINDOW_SEC) => {
    const ts = Number(oracle.timestamp);
    if (!Number.isFinite(ts) || ts <= 0)
        return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return (nowSec - ts) <= windowSec;
};
exports.isOracleFresh = isOracleFresh;
// const getBalance = async (address: string) => {
// 	const now = Date.now()
// 	const cached = balanceCache[address]
// 	// 若有缓存，且时间在 60 秒内 → 直接返回缓存
// 	if (cached && (now - cached.ts) < 60_000) {
// 		return cached.data
// 	}
//   // =============================
//   //      实际调用 RPC
//   // =============================
// //   const baseClient = createPublicClient({
// // 		chain: base,
// // 		//transport: http(`http://${getRandomNode()}/base-rpc`)
// // 		transport: http(`http://94.143.138.27/base-rpc`)
// // 	})
// 	const baseEthers = new ethers.JsonRpcProvider('')
// 	const SC = new ethers.Contract(USDCContract_BASE, USDC_ABI, baseEthers)
// 	try {
// 		// const [usdcRaw, ethRaw] = await Promise.all([
// 		//   baseClient.readContract({
// 		//     address: USDCContract_BASE,
// 		//     abi: USDC_ABI,
// 		//     functionName: 'balanceOf',
// 		//     args: [address]
// 		//   }),
// 		//   providerBase.getBalance(address)
// 		// ])
// 		const [usdcRaw, ethRaw] = await Promise.all([
// 			SC.balanceOf (address),
// 			baseEthers.getBalance(address)
// 		])
// 		const usdc = ethers.formatUnits(usdcRaw as bigint, 6)
// 		const eth = ethers.formatUnits(ethRaw, 18)
// 		const result = { usdc, eth, oracle: { eth: oracle.eth, usdc: oracle.usdc }}
// 		logger(inspect(result, false, 3, true))
// 		// 记忆：写入缓存
// 		balanceCache [address] = {
// 			data: result,
// 			ts: now
// 		}
// 		return result
// 	} catch (ex: any) {
// 		logger(`baseUSDC.balanceOf Error!`, ex.message)
// 		return null
// 	}
// }
/** Faucet 已停用，统一返回 200 兼容旧客户端 */
const BeamioFaucet = async (_req, res) => {
    return res.status(200).json({ success: true }).end();
};
exports.BeamioFaucet = BeamioFaucet;
const BeamioPayment = async (req, res, amt, wallet) => {
    (0, logger_1.logger)(`BeamioGateway: `, (0, node_util_1.inspect)({ amt, wallet }));
    const _routerName = req.path;
    const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`);
    const resource = `${req.protocol}://${req.headers.host}${url.pathname}`;
    if (!amt) {
        (0, logger_1.logger)(`processPayment ${_routerName} price=${amt} Error!`);
        res.status(404).end();
        return false;
    }
    const price = Number(ethers_1.ethers.formatUnits(amt, 6));
    if (isNaN(price) || price <= 0.02 || !wallet) {
        (0, logger_1.logger)(`processPayment isNaN(price) || price <= 0 || !wallet Error! `);
        res.status(403).json({ success: 'Data format error!' }).end();
        return false;
    }
    const paymentRequirements = [createBeamioExactPaymentRequirements(price, resource, `Beamio Payment Request for ${wallet}`, beamiobase)];
    const isValid = await (0, exports.verifyPaymentNew)(req, res, paymentRequirements);
    if (!isValid) {
        (0, logger_1.logger)(`verifyPaymentNew Error!`);
        res.status(402).end();
        return false;
    }
    let responseData;
    const paymentHeader = schemes_1.exact.evm.decodePayment(req.header("X-PAYMENT"));
    const saleRequirements = paymentRequirements[0];
    const isValidPaymentHeader = checkx402paymentHeader(paymentHeader, BigInt(amt), beamiobase);
    if (!isValidPaymentHeader) {
        (0, logger_1.logger)(`${_routerName} checkx402paymentHeader Error!`, (0, node_util_1.inspect)(paymentHeader));
        res.status(402).end();
        return false;
    }
    const payload = paymentHeader?.payload;
    if (!payload.signature || payload.signature.length > 132) {
        (0, logger_1.logger)(`${_routerName} checkx402paymentHeader sign Error!`, (0, node_util_1.inspect)(payload, false, 3, true));
        res.status(403).end();
        return false;
    }
    if (payload.authorization.to.toLowerCase() !== wallet.toLowerCase() || Number(payload.authorization.value.toString()) !== Number(amt.toString())) {
        (0, logger_1.logger)(`${_routerName} checkx402paymentHeader authorization Error!`, (0, node_util_1.inspect)(payload, false, 3, true));
        res.status(403).end();
        return false;
    }
    return payload;
};
const depositWith3009AuthorizationPayLinkPool = [];
const depositWith3009AuthorizationPayLinkProcess = async () => {
    const obj = depositWith3009AuthorizationPayLinkPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        depositWith3009AuthorizationPayLinkPool.unshift(obj);
        return setTimeout(() => depositWith3009AuthorizationPayLinkProcess(), 3000);
    }
    /**
     * finishedPayLinkPool.push({
                linkHash: code,
                from: declaneAddress,
                depositHash: ethers.ZeroHash,
                payAmount: '0'
            })
     */
    try {
        const tx = obj.to ? await SC.baseSC["depositWith3009Authorization(address,address,address,uint256,uint256,uint256,bytes32,bytes)"](obj.from, obj.to, USDCContract_BASE, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature) : await SC.baseSC["depositWith3009Authorization(address,address,uint256,uint256,uint256,bytes32,bytes,bytes32)"](obj.from, USDCContract_BASE, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature, obj.linkHash);
        (0, logger_1.logger)(`depositWith3009AuthorizationPayLinkProcess baseSC success!`, tx.hash);
        obj.res.status(200).json({ success: true, USDC_tx: tx.hash });
        const tr = obj.to ? await SC.conetSC.finishedLink(obj.linkHash, tx.hash, obj.from, obj.value) : await SC.conetSC.checkMemoGenerate(obj.linkHash, obj.from, obj.value, tx.hash, baseChainID, USDCContract_BASE, USDC_decimals, obj.note, obj.linkHash);
        await Promise.all([
            tx.wait(), tr.wait()
        ]);
        (0, logger_1.logger)(`depositWith3009AuthorizationPayLinkProcess conetSC success!`, tr.hash);
    }
    catch (ex) {
        (0, logger_1.logger)((0, node_util_1.inspect)({ from: obj.from, to: obj.to, linkHash: obj.linkHash, usdcAmount: obj.value, validAfter: obj.validAfter, validBefore: obj.validBefore, nonce: obj.nonce, signature: obj.signature }));
        (0, logger_1.logger)(`depositWith3009AuthorizationPayLinkProcess Error!`, ex.message);
    }
    exports.Settle_ContractPool.unshift(SC);
    setTimeout(() => depositWith3009AuthorizationPayLinkProcess(), 3000);
};
const declaneAddress = '0x1000000000000000000000000000000000000000';
/** Faucet 已停用，no-op */
const BeamioETHFaucetTry = async (_address) => {
    return;
};
exports.BeamioETHFaucetTry = BeamioETHFaucetTry;
/** Faucet 已停用，统一返回 200 兼容旧客户端 */
const BeamioETHFaucet = async (_req, res) => {
    return res.status(200).json({ success: true }).end();
};
exports.BeamioETHFaucet = BeamioETHFaucet;
const BeamioPaymentLinkFinish = async (req, res) => {
    let { code, amount } = req.query;
    const totalAmount = Number(amount);
    //		check step 1
    if (!code || !ethers_1.ethers.isHexString(code) || isNaN(totalAmount)) {
        (0, logger_1.logger)(`BeamioPaymentLinkFinish check step 1 Error! !code == ${!code} || !ethers.isHexString(code) == ${!ethers_1.ethers.isHexString(code)} || isNaN(totalAmount) ${isNaN(totalAmount)}`);
        return res.status(404).end();
    }
    const SC = exports.Settle_ContractPool[0];
    try {
        const getPayLink = await SC.conetSC.linkMemo(code);
        const requestAmount = Number(getPayLink.amount.toString());
        //			no request 
        if (getPayLink.to === ethers_1.ethers.ZeroAddress) {
            (0, logger_1.logger)(`BeamioPaymentLinkFinish no request getPayLink.to === ethers.ZeroAddress Error! getPayLink.to ${getPayLink.to} `);
            return res.status(404).end();
        }
        //			Insufficient request
        // if (totalAmount > 0 && totalAmount < requestAmount) {
        // 	logger(`BeamioPaymentLinkFinish totalAmount ${totalAmount} > 0 && totalAmount < requestAmount ${requestAmount} Error! `)
        // 	return res.status(403).end()
        // }
        //				Already Used
        if (getPayLink.from !== ethers_1.ethers.ZeroAddress) {
            const newCode = generateCODE('').hash;
            //		new Link request
            linkMemo.push({
                value: getPayLink.amount,
                note: getPayLink.node,
                linkHash: newCode,
                res: null,
                to: getPayLink.to
            });
            linkMemoGenerate();
            (0, logger_1.logger)(`BeamioPaymentLinkFinish Already Used create new ! ${code} ==> ${newCode}`);
            code = newCode;
            //		Declane
        }
        (0, logger_1.logger)(`BeamioPaymentLinkFinish doing BeamioPayment code ${code} totalAmount ${totalAmount} !`);
        if (!totalAmount) {
            (0, logger_1.logger)(`BeamioPaymentLinkFinish code ${code} Declane`);
            finishedPayLinkPool.push({
                linkHash: code,
                from: declaneAddress,
                depositHash: ethers_1.ethers.ZeroHash,
                payAmount: '0'
            });
            res.status(200).json({ success: true }).end();
            return setTimeout(() => finishedPayLinkProcess(), 5000);
        }
        const requestX402 = await BeamioPayment(req, res, totalAmount.toString(), beamiobase);
        (0, logger_1.logger)((0, node_util_1.inspect)(requestX402, false, 3, true));
        if (!requestX402 || !requestX402?.authorization) {
            return;
        }
        const authorization = requestX402.authorization;
        depositWith3009AuthorizationPayLinkPool.push({
            from: authorization.from,
            to: getPayLink.to,
            value: authorization.value,
            validAfter: authorization.validAfter,
            validBefore: authorization.validBefore,
            nonce: authorization.nonce,
            signature: requestX402.signature,
            res: res,
            linkHash: code,
            newHash: true
        });
        depositWith3009AuthorizationPayLinkProcess();
    }
    catch (ex) {
        return res.status(403).end();
    }
};
const BeamioPaymentLinkFinishRouteToSC = async (req, res) => {
    let { code, amount, note } = req.query;
    const totalAmount = Number(amount);
    //		check step 1
    if (!code || !ethers_1.ethers.isHexString(code) || isNaN(totalAmount) || totalAmount <= 0) {
        (0, logger_1.logger)(`BeamioPaymentLinkFinishRouteToSC check step 1 Error! !code == ${!code} || !ethers.isHexString(code) == ${!ethers_1.ethers.isHexString(code)} || isNaN(totalAmount) ${isNaN(totalAmount)}`);
        return res.status(404).end();
    }
    const SC = exports.Settle_ContractPool[0];
    try {
        const getPayLink = await SC.conetSC.linkMemo(code);
        const requestAmount = Number(getPayLink.amount.toString());
        //			no request 
        if (getPayLink.to === ethers_1.ethers.ZeroAddress) {
            (0, logger_1.logger)(`BeamioPaymentLinkFinishRouteToSC no request getPayLink.to === ethers.ZeroAddress Error! getPayLink.to ${getPayLink.to} `);
            return res.status(404).end();
        }
        //			Insufficient request	need check chrrency
        // if ( totalAmount < requestAmount) {
        // 	logger(`BeamioPaymentLinkFinishRouteToSC totalAmount ${totalAmount} > 0 && totalAmount < requestAmount ${requestAmount} Error! `)
        // 	return res.status(403).end()
        // }
        //				Already Used
        if (getPayLink.from !== ethers_1.ethers.ZeroAddress) {
            (0, logger_1.logger)(`BeamioPaymentLinkFinishRouteToSC getPayLink.from !== ethers.ZeroAddress ${getPayLink.from !== ethers_1.ethers.ZeroAddress} Can't be reuse Error! `);
            return res.status(403).end();
        }
        (0, logger_1.logger)(`BeamioPaymentLinkFinishRouteToSC doing BeamioPayment code ${code} totalAmount ${totalAmount} !`);
        const requestX402 = await BeamioPayment(req, res, totalAmount.toString(), beamiobase);
        (0, logger_1.logger)((0, node_util_1.inspect)(requestX402, false, 3, true));
        if (!requestX402 || !requestX402?.authorization) {
            return;
        }
        const from = requestX402.authorization.from;
        const to = requestX402.authorization.to;
        const value = requestX402.authorization.value;
        PayMePool.push({
            from,
            to,
            value,
            validAfter: requestX402.authorization.validAfter,
            validBefore: requestX402.authorization.validBefore,
            nonce: requestX402.authorization.nonce,
            signature: requestX402.signature,
            res: res,
            linkHash: code,
            note: note,
            newHash: false
        });
        PayMeProcess();
    }
    catch (ex) {
        return res.status(403).end();
    }
};
exports.BeamioPaymentLinkFinishRouteToSC = BeamioPaymentLinkFinishRouteToSC;
const finishedPayLinkPool = [];
const finishedPayLinkProcess = async () => {
    const obj = finishedPayLinkPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        finishedPayLinkPool.unshift(obj);
        return setTimeout(() => {
            finishedPayLinkProcess();
        }, 4000);
    }
    try {
        const tx = await SC.conetSC.finishedLink(obj.linkHash, obj.depositHash, obj.from, obj.payAmount);
        await tx.wait();
        (0, logger_1.logger)(`finishedPayLinkProcess success!`, tx.hash);
    }
    catch (ex) {
        (0, logger_1.logger)(`finishedPayLinkProcess Error!`, ex.message);
        finishedPayLinkPool.unshift(obj);
    }
    exports.Settle_ContractPool.push(SC);
    setTimeout(() => finishedPayLinkProcess(), 4000);
};
const PayMePool = [];
const PayMeProcess = async () => {
    const obj = PayMePool.shift();
    if (!obj)
        return;
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        PayMePool.unshift(obj);
        return setTimeout(() => depositWith3009AuthorizationPayLinkProcess(), 3000);
    }
    try {
        //		转账到 beamio smart contract 地址
        const tx = await SC.baseSC["depositWith3009Authorization(address,address,address,uint256,uint256,uint256,bytes32,bytes)"](obj.from, obj.to, USDCContract_BASE, obj.value, obj.validAfter, obj.validBefore, obj.nonce, obj.signature);
        (0, logger_1.logger)(`PayMeProcess baseSC success!`, tx.hash);
        if (obj.res.writable) {
            obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end();
        }
        const [, tr] = await Promise.all([
            tx.wait(),
            //		记录到 conetSC 上	 obj.to
            obj.newHash ? SC.conetSC.linkMemoGenerate(obj.linkHash, obj.to, obj.value, baseChainID, USDCContract_BASE, USDC_Base_DECIMALS, obj.note) : SC.conetSC.finishedLink(obj.linkHash, tx.hash, obj.from, obj.value)
        ]);
        await tr.wait();
        (0, logger_1.logger)(`PayMeProcess conetSC tr success!`, tr.hash);
        if (obj.newHash) {
            await new Promise(executor => setTimeout(() => executor(true), 4000));
            const ts = await SC.conetSC.finishedLink(obj.linkHash, tx.hash, obj.from, obj.value);
            await ts.wait();
            (0, logger_1.logger)(`PayMeProcess newHash conetSC success!`, ts.hash);
        }
    }
    catch (ex) {
        (0, logger_1.logger)(`PayMeProcess Error!`, (0, node_util_1.inspect)({ from: obj.from, to: obj.to, linkHash: obj.linkHash, usdcAmount: obj.value, validAfter: obj.validAfter, validBefore: obj.validBefore, nonce: obj.nonce, signature: obj.signature }));
        (0, logger_1.logger)(`PayMeProcess Error!`, ex.message);
    }
    exports.Settle_ContractPool.unshift(SC);
    setTimeout(() => PayMeProcess(), 3000);
};
const beamioApi = 'https://beamio.app';
const searchUrl = `${beamioApi}/api/search-users`;
const searchUsername = async (keyward) => {
    const params = new URLSearchParams({ keyward }).toString();
    const requestUrl = `${searchUrl}?${params}`;
    try {
        const res = await fetch(requestUrl, { method: 'GET' });
        if (res.status !== 200) {
            return null;
        }
        return await res.json();
    }
    catch (ex) {
    }
    return null;
};
const BeamioPayMe = async (req, res) => {
    const { code, amount, note, address } = req.query;
    const isAddress = ethers_1.ethers.isAddress(address);
    const _amount = Number(amount);
    if (!isAddress || address === ethers_1.ethers.ZeroAddress || isNaN(_amount) || !_amount) {
        return res.status(404).end();
    }
    //		if already linkHash exits
    const getPayLink = await exports.Settle_ContractPool[0].conetSC.linkMemo(code);
    if (getPayLink.to !== ethers_1.ethers.ZeroAddress) {
        (0, logger_1.logger)(`BeamioPayMe Error! code ${code} getPayLink.to !== ethers.ZeroAddress.`);
        return res.status(403).end();
    }
    const user = await searchUsername(address);
    if (!user?.results?.length || user.results.length > 1) {
        (0, logger_1.logger)(`BeamioPayMe Error! address ${address} has not exits!!!`);
        return res.status(404).end();
    }
    const _price = amount || '0';
    const price = ethers_1.ethers.parseUnits(_price, USDC_Base_DECIMALS); // to BIG INT
    if (!amount || price <= 0) {
        (0, logger_1.logger)(`BeamioPayMe Error! The minimum amount was not reached.`, (0, node_util_1.inspect)(req.query, false, 3, true));
        return res.status(400).json({ success: false, error: 'The minimum amount was not reached.' });
    }
    const url = new URL(`${req.protocol}://${req.headers.host}${req.originalUrl}`);
    const resource = `${req.protocol}://${req.headers.host}${url.pathname}`;
    const paymentRequirements = [createBeamioExactPaymentRequirements(amount, resource, `Beamio Transfer`, address)];
    const isValid = await (0, exports.verifyPaymentNew)(req, res, paymentRequirements);
    if (!isValid) {
        (0, logger_1.logger)(`BeamioPayMe !isValid ERROR!`);
        return;
    }
    let responseData;
    const paymentHeader = schemes_1.exact.evm.decodePayment(req.header("X-PAYMENT"));
    const saleRequirements = paymentRequirements[0];
    const payload = paymentHeader?.payload;
    try {
        const settleResponse = await settle(paymentHeader, saleRequirements);
        const responseHeader = (0, types_1.settleResponseHeader)(settleResponse);
        // In a real application, you would store this response header
        // and associate it with the payment for later verification
        responseData = JSON.parse(Buffer.from(responseHeader, 'base64').toString());
        if (!responseData.success) {
            (0, logger_1.logger)(`BeamioPayMe responseData ERROR!`, (0, node_util_1.inspect)(responseData, false, 3, true));
            return res.status(402).end();
        }
        const wallet = responseData.payer;
        const ret = {
            success: true,
            payer: wallet,
            USDC_tx: responseData?.transaction,
            network: responseData?.network,
            timestamp: new Date().toISOString()
        };
        res.status(200).json(ret).end();
        (0, logger_1.logger)((0, node_util_1.inspect)(ret, false, 3, true));
        const authorization = payload?.authorization;
        if (authorization) {
            const from = authorization.from;
            const to = authorization.to;
            const amount = authorization.value;
            PayMePool.push({
                from,
                to,
                value: amount,
                validAfter: authorization.validAfter,
                validBefore: authorization.validBefore,
                nonce: authorization.nonce,
                signature: responseData?.transaction,
                res: res,
                linkHash: code,
                note: note,
                newHash: true
            });
            PayMeProcess();
        }
        return;
    }
    catch (ex) {
        console.error("Payment settlement failed:", ex.message);
        res.status(500).end();
    }
};
exports.BeamioPayMe = BeamioPayMe;
const BeamioPayMeRouteToSC = async (req, res) => {
    const { code, amount, note, address } = req.query;
    const isAddress = ethers_1.ethers.isAddress(address);
    const _amount = Number(amount);
    if (!isAddress || address === ethers_1.ethers.ZeroAddress || isNaN(_amount) || !_amount) {
        return res.status(404).end();
    }
    //		if already linkHash exits
    const getPayLink = await exports.Settle_ContractPool[0].conetSC.linkMemo(code);
    if (getPayLink.to !== ethers_1.ethers.ZeroAddress) {
        (0, logger_1.logger)(`BeamioPayMe Error! code ${code} getPayLink.to !== ethers.ZeroAddress.`);
        return res.status(403).end();
    }
    const user = await searchUsername(address);
    if (!user?.results?.length || user.results.length > 1) {
        (0, logger_1.logger)(`BeamioPayMe Error! address ${address} has not exits!!!`);
        return res.status(404).end();
    }
    const _price = amount || '0';
    const price = ethers_1.ethers.parseUnits(_price, USDC_Base_DECIMALS); // to BIG INT
    if (!amount || price <= 0) {
        (0, logger_1.logger)(`BeamioPayMe Error! The minimum amount was not reached.`, (0, node_util_1.inspect)(req.query, false, 3, true));
        return res.status(400).json({ success: false, error: 'The minimum amount was not reached.' });
    }
    const requestX402 = await BeamioPayment(req, res, price.toString(), beamiobase);
    (0, logger_1.logger)((0, node_util_1.inspect)(requestX402, false, 3, true));
    if (!requestX402 || !requestX402?.authorization) {
        return;
    }
    // depositWith3009AuthorizationPayLinkPool.push({
    // 			from: payload.from,
    // 			to: '',
    // 			value: payload.value,
    // 			validAfter: payload.validAfter,
    // 			validBefore: payload.validBefore,
    // 			signature: requestX402.signature,
    // 			res: res,
    // 			note: note,
    // 			nonce: payload.nonce,
    // 			linkHash: secureCode,
    // 		})
    const from = requestX402.authorization.from;
    const to = requestX402.authorization.to;
    const value = requestX402.authorization.value;
    PayMePool.push({
        from,
        to: address,
        value,
        validAfter: requestX402.authorization.validAfter,
        validBefore: requestX402.authorization.validBefore,
        nonce: requestX402.authorization.nonce,
        signature: requestX402.signature,
        res: res,
        linkHash: code,
        note: note,
        newHash: true
    });
    PayMeProcess();
    return;
};
exports.BeamioPayMeRouteToSC = BeamioPayMeRouteToSC;
const BeamioPaymentLink = async (req, res) => {
    const { code, amount, note, address } = req.query;
    const totalAmount = Number(amount);
    if (!code || !address || isNaN(totalAmount) || !ethers_1.ethers.isHexString(code)) {
        return res.status(404).end();
    }
    linkMemo.push({
        value: totalAmount.toString(),
        note: note || '',
        linkHash: code,
        res,
        to: address
    });
    linkMemoGenerate();
};
exports.BeamioPaymentLink = BeamioPaymentLink;
const redeemCheckPool = [];
const redeemCheckProcess = async () => {
    const obj = redeemCheckPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.Settle_ContractPool.shift();
    if (!SC) {
        redeemCheckPool.unshift(obj);
        setTimeout(() => {
            redeemCheckProcess();
        }, 2000);
        return;
    }
    try {
        const tx = await SC.baseSC.withdrawWithCode(obj.secureCode, obj.address);
        const tr = await SC.conetSC.finishedCheck(obj.hash, tx.hash, obj.address);
        if (obj.res.writable) {
            obj.res.status(200).json({ success: true, tx: tx.hash }).end();
        }
        await Promise.all([
            tx.wait(),
            tr.wait()
        ]);
        (0, logger_1.logger)(`redeemCheckProcess SUCCESS! BASE ${tx.hash} to ${obj.address} CoNET ${tr.hash}`);
    }
    catch (ex) {
        (0, logger_1.logger)(`redeemCheckProcess Error! ${ex.message}`);
        obj.res.status(500).json({ success: false }).end();
    }
    exports.Settle_ContractPool.push(SC);
    setTimeout(() => {
        redeemCheckProcess();
    }, 2000);
};
const redeemCheck = async (req, res) => {
    const { secureCode, securityCodeDigits, address } = req.query;
    if (!secureCode || secureCode === ethers_1.ethers.ZeroHash || !address || !ethers_1.ethers.isAddress(address) || address === ethers_1.ethers.ZeroAddress) {
        return res.status(404).end();
    }
    const hash = ethers_1.ethers.solidityPackedKeccak256(['string'], [secureCode + securityCodeDigits]);
    const SC = exports.Settle_ContractPool[0];
    try {
        const obj = await SC.baseSC.hashAmount(hash);
        if (obj.from === ethers_1.ethers.ZeroAddress || obj.amount === BigInt(0) || obj.erc20.toLowerCase() !== USDCContract_BASE.toLowerCase()) {
            (0, logger_1.logger)(`/redeemCheck hash${hash} has zero from address error! `, (0, node_util_1.inspect)(obj, false, 3, true));
            res.status(403).end();
            return;
        }
        redeemCheckPool.push({
            secureCode: secureCode + securityCodeDigits,
            address,
            res,
            hash
        });
        redeemCheckProcess();
    }
    catch (ex) {
        (0, logger_1.logger)(`redeemCheck catch ex!! ${ex.message}`);
        return;
    }
};
exports.redeemCheck = redeemCheck;
const checkSign = (message, signMess, signWallet) => {
    if (!message || !signMess) {
        return null;
    }
    let recoverPublicKey;
    try {
        recoverPublicKey = ethers_1.ethers.verifyMessage(message, signMess);
    }
    catch (ex) {
        return (0, logger_1.logger)(`${ex.messang}`);
    }
    if (!recoverPublicKey || recoverPublicKey.toLowerCase() !== signWallet.toLowerCase()) {
        (0, logger_1.logger)(`!recoverPublicKey || recoverPublicKey.toLowerCase() !== signWallet.toLowerCase()`);
        return null;
    }
    return signWallet.toLowerCase();
};
exports.checkSign = checkSign;
// setTimeout(() => test1(), 5000)
// setTimeout(() => {test2()}, 2000)
