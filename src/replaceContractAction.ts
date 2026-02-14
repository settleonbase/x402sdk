import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

import IDiamondCutABI from "./ABI/DiamondCutFacetABI.json";
import LoupeABI from "./ABI/LoupeABI.json";

const RPC_URL = "https://mainnet-rpc1.conet.network";
const ZERO = ethers.ZeroAddress;

// 从 deployments/conet-IndexerDiamond.json 读取（与 MemberCard BeamioTaskIndexerAddress 一致）
function loadDiamondAndFacets(): { diamond: string; actionFacet: string } {
  const deployPath = path.join(__dirname, "..", "..", "..", "deployments", "conet-IndexerDiamond.json");
  if (!fs.existsSync(deployPath)) throw new Error("未找到 deployments/conet-IndexerDiamond.json");
  const d = JSON.parse(fs.readFileSync(deployPath, "utf-8"));
  if (!d.diamond || !d.facets?.ActionFacet) throw new Error("conet-IndexerDiamond.json 缺少 diamond 或 facets.ActionFacet");
  return { diamond: d.diamond, actionFacet: d.facets.ActionFacet };
}

function loadMasterSetup(): { settle_contractAdmin: string[] } {
  const p = path.join(homedir(), ".master.json");
  if (!fs.existsSync(p)) throw new Error("未找到 ~/.master.json，请配置 settle_contractAdmin");
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (!data.settle_contractAdmin?.length) throw new Error("~/.master.json 中 settle_contractAdmin 为空");
  return { settle_contractAdmin: data.settle_contractAdmin };
}

function abiArray(abiJson: any) {
  const abi = Array.isArray(abiJson) ? abiJson : abiJson?.abi;
  if (!Array.isArray(abi)) throw new Error("Bad ABI JSON");
  return abi;
}

function selectorOf(signature: string) {
  return ethers.id(signature).slice(0, 10).toLowerCase();
}

async function diamondCutTx(wallet: ethers.Wallet, diamond: string, cuts: any[], tag: string) {
  const dc = new ethers.Contract(diamond, abiArray(IDiamondCutABI), wallet);
  console.log(`== ${tag}: diamondCut(${cuts.length} cuts) ==`);
  const tx = await dc.diamondCut(cuts, ZERO, "0x");
  console.log(`${tag} tx sent:`, tx.hash);
  const r = await tx.wait();
  console.log(`✅ ${tag} mined. status=${r.status} hash=${tx.hash}`);
}

async function main() {
  const { diamond: DIAMOND, actionFacet: ACTION_FACET } = loadDiamondAndFacets();
  const master = loadMasterSetup();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(master.settle_contractAdmin[0], provider);

  console.log("Diamond:", DIAMOND);
  console.log("ActionFacet:", ACTION_FACET);
  console.log("RPC:", RPC_URL);

  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);

  // ActionFacet.syncTokenAction 的 selector
  const sel_sync = selectorOf(
    "syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))"
  );

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
