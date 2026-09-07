"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ethers_1 = require("ethers");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os_1 = require("os");
const util_1 = require("./util");
const DiamondCutFacetABI_json_1 = __importDefault(require("./ABI/DiamondCutFacetABI.json"));
const LoupeABI_json_1 = __importDefault(require("./ABI/LoupeABI.json"));
const RPC_URL = (0, util_1.resolveBeamioConetHttpRpcUrl)();
const ZERO = ethers_1.ethers.ZeroAddress;
// 从 deployments/conet-IndexerDiamond.json 读取（与 MemberCard BeamioTaskIndexerAddress 一致）
function loadDiamondAndFacets() {
    const deployPath = path.join(__dirname, "..", "..", "..", "deployments", "conet-IndexerDiamond.json");
    if (!fs.existsSync(deployPath))
        throw new Error("未找到 deployments/conet-IndexerDiamond.json");
    const d = JSON.parse(fs.readFileSync(deployPath, "utf-8"));
    if (!d.diamond || !d.facets?.ActionFacet)
        throw new Error("conet-IndexerDiamond.json 缺少 diamond 或 facets.ActionFacet");
    return { diamond: d.diamond, actionFacet: d.facets.ActionFacet };
}
function loadMasterSetup() {
    const p = path.join((0, os_1.homedir)(), ".master.json");
    if (!fs.existsSync(p))
        throw new Error("未找到 ~/.master.json，请配置 settle_contractAdmin");
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!data.settle_contractAdmin?.length)
        throw new Error("~/.master.json 中 settle_contractAdmin 为空");
    return { settle_contractAdmin: data.settle_contractAdmin };
}
function abiArray(abiJson) {
    const abi = Array.isArray(abiJson) ? abiJson : abiJson?.abi;
    if (!Array.isArray(abi))
        throw new Error("Bad ABI JSON");
    return abi;
}
function selectorOf(signature) {
    return ethers_1.ethers.id(signature).slice(0, 10).toLowerCase();
}
async function diamondCutTx(wallet, diamond, cuts, tag) {
    const dc = new ethers_1.ethers.Contract(diamond, abiArray(DiamondCutFacetABI_json_1.default), wallet);
    console.log(`== ${tag}: diamondCut(${cuts.length} cuts) ==`);
    const tx = await dc.diamondCut(cuts, ZERO, "0x");
    console.log(`${tag} tx sent:`, tx.hash);
    const r = await tx.wait();
    console.log(`✅ ${tag} mined. status=${r.status} hash=${tx.hash}`);
}
async function main() {
    const { diamond: DIAMOND, actionFacet: ACTION_FACET } = loadDiamondAndFacets();
    const master = loadMasterSetup();
    const provider = new ethers_1.ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers_1.ethers.Wallet(master.settle_contractAdmin[0], provider);
    console.log("Diamond:", DIAMOND);
    console.log("ActionFacet:", ACTION_FACET);
    console.log("RPC:", RPC_URL);
    const loupe = new ethers_1.ethers.Contract(DIAMOND, abiArray(LoupeABI_json_1.default), wallet);
    // ActionFacet.syncTokenAction 的 selector
    const sel_sync = selectorOf("syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))");
    console.log("syncTokenAction selector =", sel_sync);
    const cur = await loupe.facetAddress(sel_sync);
    console.log("current facet(syncTokenAction) =", cur);
    // action 0 = Add： selector 尚未路由时添加；Replace 要求 selector 已存在
    const cut = [{ facetAddress: ACTION_FACET, action: 0, functionSelectors: [sel_sync] }];
    await diamondCutTx(wallet, DIAMOND, cut, "Fix-Action-syncTokenAction");
    const after = await loupe.facetAddress(sel_sync);
    console.log("after facet(syncTokenAction) =", after);
    if (after.toLowerCase() !== ACTION_FACET.toLowerCase()) {
        throw new Error("❌ still not routed to ActionFacet");
    }
    console.log("✅ syncTokenAction route fixed");
}
main().catch((e) => {
    console.error("❌ failed:", e);
    process.exit(1);
});
