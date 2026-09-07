"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Settle_ContractPool = exports.Settle_ConetPool = exports.Settle_BasePool = exports.Settle_ContractRoster = void 0;
exports.initSettleContractPool = initSettleContractPool;
exports.ensureSettleContractPoolInitialized = ensureSettleContractPoolInitialized;
exports.settleRosterInitialized = settleRosterInitialized;
exports.hasIdleSettleBase = hasIdleSettleBase;
exports.hasIdleSettleConet = hasIdleSettleConet;
exports.hasIdleSettleBoth = hasIdleSettleBoth;
exports.shiftSettleBase = shiftSettleBase;
exports.shiftSettleConet = shiftSettleConet;
exports.shiftSettleBoth = shiftSettleBoth;
exports.unshiftSettleBase = unshiftSettleBase;
exports.unshiftSettleConet = unshiftSettleConet;
exports.unshiftSettleBoth = unshiftSettleBoth;
exports.genesisBridgeInitiatorInRoster = genesisBridgeInitiatorInRoster;
exports.hasIdleGenesisInitiatorBase = hasIdleGenesisInitiatorBase;
exports.hasIdleGenesisInitiatorBoth = hasIdleGenesisInitiatorBoth;
exports.shiftGenesisBridgeInitiatorBase = shiftGenesisBridgeInitiatorBase;
exports.shiftGenesisBridgeInitiatorBoth = shiftGenesisBridgeInitiatorBoth;
exports.withGenesisBridgeInitiatorBase = withGenesisBridgeInitiatorBase;
exports.withGenesisBridgeInitiatorBoth = withGenesisBridgeInitiatorBoth;
exports.settlePoolIdleSummary = settlePoolIdleSummary;
const ethers_1 = require("ethers");
const BeamioUserCardFactoryPaymaster_json_1 = __importDefault(require("./ABI/BeamioUserCardFactoryPaymaster.json"));
const BeamioAAAccountFactoryPaymaster_json_1 = __importDefault(require("./ABI/BeamioAAAccountFactoryPaymaster.json"));
const DiamondCutFacetABI_json_1 = __importDefault(require("./ABI/DiamondCutFacetABI.json"));
const DiamondLoupeFacet_json_1 = __importDefault(require("./ABI/DiamondLoupeFacet.json"));
const OwnershipABI_json_1 = __importDefault(require("./ABI/OwnershipABI.json"));
const TaskABI_json_1 = __importDefault(require("./ABI/TaskABI.json"));
const StatsABI_json_1 = __importDefault(require("./ABI/StatsABI.json"));
const CatalogABI_json_1 = __importDefault(require("./ABI/CatalogABI.json"));
const ActionABI_json_1 = __importDefault(require("./ABI/ActionABI.json"));
const adminFacet_ABI_json_1 = __importDefault(require("./ABI/adminFacet_ABI.json"));
const beamio_conet_abi_json_1 = __importDefault(require("./ABI/beamio-conet.abi.json"));
const BeamioUserCardGatewayABI_json_1 = __importDefault(require("./ABI/BeamioUserCardGatewayABI.json"));
const chainAddresses_1 = require("./chainAddresses");
const util_1 = require("./util");
const BeamioFactoryPaymasterABI = (Array.isArray(BeamioUserCardFactoryPaymaster_json_1.default)
    ? BeamioUserCardFactoryPaymaster_json_1.default
    : BeamioUserCardFactoryPaymaster_json_1.default.abi ?? []);
const BeamioAAAccountFactoryPaymasterABI = (Array.isArray(BeamioAAAccountFactoryPaymaster_json_1.default)
    ? BeamioAAAccountFactoryPaymaster_json_1.default
    : BeamioAAAccountFactoryPaymaster_json_1.default.abi ?? []);
const JSONRPC_NO_BATCH = { batchMaxCount: 1 };
const BEAMIO_CONET_ADDRESS = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd';
exports.Settle_ContractRoster = [];
exports.Settle_BasePool = [];
exports.Settle_ConetPool = [];
/**
 * 只读名册别名（view / factory-admin-init / `[0]` 读合约）。
 * **禁止** `.shift()` / `.unshift()` / `.splice` 占用；用 Base/Conet pool。
 */
exports.Settle_ContractPool = [];
let poolInitialized = false;
function scAddr(sc) {
    return sc.walletBase.address.toLowerCase();
}
/** Idempotent: populate roster + both occupancy pools from ~/.master.json settle_contractAdmin. */
function initSettleContractPool() {
    if (poolInitialized)
        return;
    poolInitialized = true;
    const admins = util_1.masterSetup?.settle_contractAdmin;
    if (!Array.isArray(admins) || admins.length === 0) {
        return;
    }
    const providerBase = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioBaseHttpRpcUrl)(), undefined, JSONRPC_NO_BATCH);
    const providerConet = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)(), undefined, JSONRPC_NO_BATCH);
    for (const pk of admins) {
        const walletBase = new ethers_1.ethers.Wallet(pk, providerBase);
        const walletConet = new ethers_1.ethers.Wallet(pk, providerConet);
        const baseFactoryPaymaster = new ethers_1.ethers.Contract(chainAddresses_1.BASE_CARD_FACTORY, BeamioFactoryPaymasterABI, walletBase);
        const conetFactoryPaymaster = new ethers_1.ethers.Contract(chainAddresses_1.CONET_CARD_FACTORY, BeamioFactoryPaymasterABI, walletConet);
        const aaAccountFactoryPaymaster = new ethers_1.ethers.Contract(chainAddresses_1.BASE_AA_FACTORY, BeamioAAAccountFactoryPaymasterABI, walletBase);
        const BeamioTaskDiamondCut = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, DiamondCutFacetABI_json_1.default, walletConet);
        const BeamioTaskDiamondLoupe = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, DiamondLoupeFacet_json_1.default, walletConet);
        const BeamioTaskDiamondOwnership = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, OwnershipABI_json_1.default, walletConet);
        const BeamioTaskDiamondTask = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, TaskABI_json_1.default, walletConet);
        const BeamioTaskDiamondStats = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, StatsABI_json_1.default, walletConet);
        const BeamioTaskDiamondCatalog = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, CatalogABI_json_1.default, walletConet);
        const BeamioTaskDiamondAction = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, ActionABI_json_1.default, walletConet);
        const BeamioTaskDiamondAdmin = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, adminFacet_ABI_json_1.default, walletConet);
        const beamioConet = new ethers_1.ethers.Contract(BEAMIO_CONET_ADDRESS, beamio_conet_abi_json_1.default, walletConet);
        const conetSC = new ethers_1.ethers.Contract(BEAMIO_CONET_ADDRESS, beamio_conet_abi_json_1.default, walletConet);
        const BeamioUserCardGateway = new ethers_1.ethers.Contract(chainAddresses_1.BASE_AA_FACTORY, BeamioUserCardGatewayABI_json_1.default, walletBase);
        const entry = {
            baseFactoryPaymaster,
            conetFactoryPaymaster,
            walletBase,
            walletConet,
            aaAccountFactoryPaymaster,
            BeamioTaskDiamondCut,
            BeamioTaskDiamondLoupe,
            BeamioTaskDiamondOwnership,
            BeamioTaskDiamondTask,
            BeamioTaskDiamondStats,
            BeamioTaskDiamondCatalog,
            BeamioTaskDiamondAction,
            BeamioTaskDiamondAdmin,
            beamioConet,
            conetSC,
            BeamioUserCardGateway,
        };
        exports.Settle_ContractRoster.push(entry);
        exports.Settle_BasePool.push(entry);
        exports.Settle_ConetPool.push(entry);
    }
    exports.Settle_ContractPool = exports.Settle_ContractRoster;
}
/** Listener / redeem paths: ensure pool wallets exist without importing MemberCard.ts. */
function ensureSettleContractPoolInitialized() {
    initSettleContractPool();
}
function settleRosterInitialized() {
    return exports.Settle_ContractRoster.length > 0;
}
function hasIdleSettleBase() {
    return exports.Settle_BasePool.length > 0;
}
function hasIdleSettleConet() {
    return exports.Settle_ConetPool.length > 0;
}
/** Same admin key idle on both chains (Genesis bindSale + LockMint). */
function hasIdleSettleBoth() {
    const base = new Set(exports.Settle_BasePool.map(scAddr));
    return exports.Settle_ConetPool.some((sc) => base.has(scAddr(sc)));
}
function shiftSettleBase() {
    return exports.Settle_BasePool.shift();
}
function shiftSettleConet() {
    return exports.Settle_ConetPool.shift();
}
function shiftSettleBoth() {
    const conetIdx = new Map(exports.Settle_ConetPool.map((sc, i) => [scAddr(sc), i]));
    for (let i = 0; i < exports.Settle_BasePool.length; i++) {
        const j = conetIdx.get(scAddr(exports.Settle_BasePool[i]));
        if (j === undefined)
            continue;
        const [sc] = exports.Settle_BasePool.splice(i, 1);
        exports.Settle_ConetPool.splice(j, 1);
        return sc;
    }
    return undefined;
}
function unshiftSettleBase(sc) {
    exports.Settle_BasePool.unshift(sc);
}
function unshiftSettleConet(sc) {
    exports.Settle_ConetPool.unshift(sc);
}
function unshiftSettleBoth(sc) {
    exports.Settle_BasePool.unshift(sc);
    exports.Settle_ConetPool.unshift(sc);
}
function genesisBridgeInitiatorInRoster() {
    const want = chainAddresses_1.GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase();
    return exports.Settle_ContractRoster.some((sc) => scAddr(sc) === want);
}
function hasIdleGenesisInitiatorBase() {
    const want = chainAddresses_1.GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase();
    return exports.Settle_BasePool.some((sc) => scAddr(sc) === want);
}
function hasIdleGenesisInitiatorBoth() {
    const want = chainAddresses_1.GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase();
    const inBase = exports.Settle_BasePool.some((sc) => scAddr(sc) === want);
    const inConet = exports.Settle_ConetPool.some((sc) => scAddr(sc) === want);
    return inBase && inConet;
}
function shiftGenesisBridgeInitiatorBase() {
    const want = chainAddresses_1.GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase();
    const idx = exports.Settle_BasePool.findIndex((sc) => scAddr(sc) === want);
    if (idx < 0)
        return undefined;
    const [sc] = exports.Settle_BasePool.splice(idx, 1);
    return sc;
}
function shiftGenesisBridgeInitiatorBoth() {
    const want = chainAddresses_1.GENESIS_NODE_BRIDGE_INITIATOR.toLowerCase();
    const baseIdx = exports.Settle_BasePool.findIndex((sc) => scAddr(sc) === want);
    const conetIdx = exports.Settle_ConetPool.findIndex((sc) => scAddr(sc) === want);
    if (baseIdx < 0 || conetIdx < 0)
        return undefined;
    const [sc] = exports.Settle_BasePool.splice(baseIdx, 1);
    exports.Settle_ConetPool.splice(conetIdx, 1);
    return sc;
}
async function withGenesisBridgeInitiatorBase(fn) {
    if (!genesisBridgeInitiatorInRoster()) {
        throw new Error(`Genesis bridge initiator ${chainAddresses_1.GENESIS_NODE_BRIDGE_INITIATOR} not in Settle_ContractRoster (check settle_contractAdmin)`);
    }
    const sc = shiftGenesisBridgeInitiatorBase();
    if (!sc) {
        throw new Error('GENESIS_BRIDGE_INITIATOR_BASE_BUSY');
    }
    try {
        return await fn(sc);
    }
    finally {
        unshiftSettleBase(sc);
    }
}
async function withGenesisBridgeInitiatorBoth(fn) {
    if (!genesisBridgeInitiatorInRoster()) {
        throw new Error(`Genesis bridge initiator ${chainAddresses_1.GENESIS_NODE_BRIDGE_INITIATOR} not in Settle_ContractRoster (check settle_contractAdmin)`);
    }
    const sc = shiftGenesisBridgeInitiatorBoth();
    if (!sc) {
        throw new Error('GENESIS_BRIDGE_INITIATOR_BOTH_BUSY');
    }
    try {
        return await fn(sc);
    }
    finally {
        unshiftSettleBoth(sc);
    }
}
function settlePoolIdleSummary() {
    return `roster=${exports.Settle_ContractRoster.length} baseIdle=${exports.Settle_BasePool.length} conetIdle=${exports.Settle_ConetPool.length}`;
}
