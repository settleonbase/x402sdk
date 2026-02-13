import { ethers } from "ethers";
import { masterSetup } from "./util";

import IDiamondCutABI from "./ABI/DiamondCutFacetABI.json";
import LoupeABI from "./ABI/LoupeABI.json";

const RPC_URL = "https://mainnet-rpc1.conet.network";
const DIAMOND = "0xCfCfD5E8428051B84D53aE1B39DeFD50705d967f";
const ZERO = ethers.ZeroAddress;

const NEW_ACTION_FACET = "0xFE482f7175999937f16E1B515aD8e1dD672211eA";

function abiArray(abiJson: any) {
  const abi = Array.isArray(abiJson) ? abiJson : abiJson?.abi;
  if (!Array.isArray(abi)) throw new Error("Bad ABI JSON");
  return abi;
}

function selectorOf(signature: string) {
  return ethers.id(signature).slice(0, 10).toLowerCase();
}

async function diamondCutTx(wallet: ethers.Wallet, cuts: any[], tag: string) {
  const dc = new ethers.Contract(DIAMOND, abiArray(IDiamondCutABI), wallet);
  console.log(`== ${tag}: diamondCut(${cuts.length} cuts) ==`);
  const tx = await dc.diamondCut(cuts, ZERO, "0x");
  console.log(`${tag} tx sent:`, tx.hash);
  const r = await tx.wait();
  console.log(`✅ ${tag} mined. status=${r.status} hash=${tx.hash}`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);

  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);

  // 你的 ActionFacet 源码对应的 canonical signature（只看 types）
  const sel_sync = selectorOf(
    "syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))"
  );

  console.log("syncTokenAction selector =", sel_sync);
  const cur = await loupe.facetAddress(sel_sync);
  console.log("current facet(syncTokenAction) =", cur);

  const cut = [{ facetAddress: NEW_ACTION_FACET, action: 1, functionSelectors: [sel_sync] }];
  await diamondCutTx(wallet, cut, "Fix-Action-syncTokenAction");

  const after = await loupe.facetAddress(sel_sync);
  console.log("after facet(syncTokenAction) =", after);
  if (after.toLowerCase() !== NEW_ACTION_FACET.toLowerCase()) {
    throw new Error("❌ still not routed to NEW_ACTION_FACET");
  }
  console.log("✅ syncTokenAction route fixed");
}

main().catch((e) => {
  console.error("❌ failed:", e);
  process.exit(1);
});
