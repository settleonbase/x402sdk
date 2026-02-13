import { ethers } from "ethers";
import { masterSetup } from "./util";

import IDiamondCutABI from "./ABI/DiamondCutFacetABI.json";
import LoupeABI from "./ABI/LoupeABI.json";
import OwnershipABI from "./ABI/OwnershipABI.json";

import CatalogABI from "./ABI/CatalogABI.json";
import StatsABI from "./ABI/StatsABI.json";
import ActionABI from "./ABI/ActionABI.json";
import TaskABI from "./ABI/TaskABI.json";

const RPC_URL = "https://mainnet-rpc1.conet.network";
const DIAMOND = "0xCfCfD5E8428051B84D53aE1B39DeFD50705d967f";

const FACETS = {
  // 你自己的已知 facet 地址（如果未来换了就改这里）
  catalog: "0x413707d465405718375CBD408cD0b1d751d0065b",
  stats:   "0x3E58592e8ecAF2c2E6957BA6c93ca34Fad20DE42",
  action:  "0xFE482f7175999937f16E1B515aD8e1dD672211eA",
  task:    "0x740b5ef97fb0f475722c90B3389B1CF42C36d5Eb",
} as const;

const ZERO = ethers.ZeroAddress;
const DIAMOND_CUT_SELECTOR = "0x1f931c1c";

function abiArray(abiJson: any) {
    const abi = Array.isArray(abiJson) ? abiJson : abiJson?.abi;
  if (!Array.isArray(abi)) throw new Error("Bad ABI JSON: expected array or {abi:[...]}");
  return abi;
}

/**
 * ✅ 正确获取 selectors：用 Interface 自动处理 tuple/struct
 */
function getSelectors(abiJson: any): string[] {
	const iface = new ethers.Interface(abiArray(abiJson));
	const out = new Set<string>();
  
	for (const frag of iface.fragments) {
	  if (frag.type !== "function") continue;
	  // ethers v6: FunctionFragment has selector
	  // @ts-ignore
	  const sel: string | undefined = frag.selector;
	  if (sel) out.add(sel.toLowerCase());
	}
	return [...out];
  }

function selectorOf(signature: string) {
  return ethers.id(signature).slice(0, 10).toLowerCase();
}

async function diamondCutTx(wallet: ethers.Wallet, cuts: any[], tag: string) {
  if (!cuts.length) {
    console.log(`== ${tag}: nothing ==`);
    return;
  }
  const dc = new ethers.Contract(DIAMOND, abiArray(IDiamondCutABI), wallet);
  console.log(`== ${tag}: diamondCut(${cuts.length} cuts) ==`);
  const tx = await dc.diamondCut(cuts, ZERO, "0x");
  console.log(`${tag} tx sent:`, tx.hash);
  const r = await tx.wait();
  console.log(`✅ ${tag} mined. status=${r.status} hash=${tx.hash}`);
}

async function getInstalledSelectors(wallet: ethers.Wallet): Promise<Map<string, string>> {
  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  const facets: Array<{ facetAddress: string; functionSelectors: string[] }> = await loupe.facets();

  const m = new Map<string, string>();
  for (const f of facets) {
    for (const sel of f.functionSelectors) {
      m.set(sel.toLowerCase(), (f.facetAddress || "").toLowerCase());
    }
  }
  return m;
}

function planCutsForFacet(
  desiredSelectors: string[],
  installed: Map<string, string>,
  targetFacet: string
) {
  const add: string[] = [];
  const replace: string[] = [];
  const skip: string[] = [];
  const forbidden: string[] = [];

  const target = targetFacet.toLowerCase();

  for (const sel of desiredSelectors) {
    if (sel === DIAMOND_CUT_SELECTOR) {
      forbidden.push(sel);
      continue;
    }

    const currentFacet = installed.get(sel); // may be undefined
    if (!currentFacet) add.push(sel);
    else if (currentFacet === target) skip.push(sel);
    else replace.push(sel);
  }

  return { add, replace, skip, forbidden };
}

async function mustEqual(label: string, got: string, want: string) {
  const g = got.toLowerCase();
  const w = want.toLowerCase();
  if (g !== w) throw new Error(`❌ ${label} mismatch: got=${got} want=${want}`);
  console.log(`✅ ${label} ok: ${got}`);
}

/**
 * direct-call smoke: 对 “facet 地址” 直接发 eth_call（不走 diamond）
 * 任何 revert 都说明 facet 本身不支持这个 selector（或是 proxy/fallback/地址错）
 */
async function directCallSmoke(provider: ethers.JsonRpcProvider, facetAddr: string, selector: string, label: string) {
  try {
    const data = selector; // no args
    const ret = await provider.call({ to: facetAddr, data });
    console.log(`✅ direct facet call OK: ${label} ret=${ret}`);
    return ret;
  } catch (e: any) {
    const msg = String(e?.shortMessage || e?.reason || e?.message || "");
    throw new Error(`❌ direct facet call REVERT: ${label} facet=${facetAddr} sel=${selector} msg=${msg}`);
  }
}



function assertAbiHas(abiJson: any, signature: string) {
	const sel = selectorOf(signature);
	const sels = new Set(getSelectors(abiJson));
	if (!sels.has(sel)) {
		throw new Error(`❌ ABI missing selector ${sel} for: ${signature}`);
	}
  }


  
  function ensureSelectors(selectors: string[], mustHave: string[]) {
	const set = new Set(selectors.map((s) => s.toLowerCase()));
	for (const s of mustHave) set.add(s.toLowerCase());
	return [...set];
  }

  const ACTION_MUST_HAVE = [
	selectorOf(
	  "syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))"
	),
	selectorOf("getActionCount()"),
	selectorOf("getAction(uint256)"),
	selectorOf("getActionWithMeta(uint256)"),
	selectorOf("setAfterTatchNotes(uint256,string,string,string)"),
	selectorOf("getUserActionsPaged(address,uint256,uint256)"),
	selectorOf("getCardActionsPaged(address,uint256,uint256)"),
  ];

  let desired = getSelectors(ActionABI);
desired = ensureSelectors(desired, ACTION_MUST_HAVE);

async function printCodeHash(provider: ethers.JsonRpcProvider, addr: string, label: string) {
  const code = await provider.getCode(addr);
  const len = (code.length - 2) / 2;
  const h = ethers.keccak256(code);
  console.log(`${label}: codeBytes=${len} keccak256=${h}`);
  return { len, hash: h, code };
}

async function checkAndVerify() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);

  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  const ownership = new ethers.Contract(DIAMOND, abiArray(OwnershipABI), wallet);

  assertAbiHas(
	ActionABI,
	"syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))"
  );

  console.log("== Owner check ==");
  console.log("diamond owner =", await ownership.owner());
  console.log("wallet       =", await wallet.getAddress());

  console.log("\n== Selector route checks (Loupe.facetAddress) ==");

  // ---- Catalog selectors ----
  const sel_catalog_register = selectorOf(
    "registerCard((address,address,string,string,string,uint8,uint256,uint8,uint64,uint64,uint256))"
  );
  const sel_catalog_getMeta = selectorOf("getCardMeta(address)");

  // ---- Action selectors ----
  const sel_action_getCount = selectorOf("getActionCount()");
  const sel_action_sync = selectorOf(
    "syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))"
  );

  console.log("Catalog.registerCard =", sel_catalog_register);
  console.log("Catalog.getCardMeta  =", sel_catalog_getMeta);
  console.log("Action.getActionCount =", sel_action_getCount);
  console.log("Action.syncTokenAction =", sel_action_sync);

  const fa_catalog_register = await loupe.facetAddress(sel_catalog_register);
  const fa_catalog_getMeta = await loupe.facetAddress(sel_catalog_getMeta);
  const fa_action_getCount = await loupe.facetAddress(sel_action_getCount);
  const fa_action_sync = await loupe.facetAddress(sel_action_sync);

  await mustEqual("Catalog:registerCard facet", fa_catalog_register, FACETS.catalog);
  await mustEqual("Catalog:getCardMeta facet", fa_catalog_getMeta, FACETS.catalog);
  await mustEqual("Action:getActionCount facet", fa_action_getCount, FACETS.action);
  await mustEqual("Action:syncTokenAction facet", fa_action_sync, FACETS.action);

  console.log("\n== Runtime bytecode hashes ==");
  await printCodeHash(provider, DIAMOND, "DIAMOND");
  await printCodeHash(provider, FACETS.action, "ACTION_FACET");

  console.log("\n== Direct facet smoke (IMPORTANT) ==");
  // 关键：对 facet 地址 direct call getActionCount()
  // 如果这里 revert，说明 facet 压根不是你给的这份源码编译出来的那个
  await directCallSmoke(provider, FACETS.action, sel_action_getCount, "ActionFacet.getActionCount()");

  console.log("\n✅ ACCEPTANCE DONE");
}

/**
 * 一键升级 ActionFacet：
 * - 用 ActionABI 里的所有 selectors
 * - 先 plan add/replace
 * - replace + add 到 NEW_ACTION_FACET
 */
async function upgradeActionFacet(NEW_ACTION_FACET: string) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);

  const installed = await getInstalledSelectors(wallet);
  const desired = getSelectors(ActionABI);

  const { add, replace, skip, forbidden } = planCutsForFacet(desired, installed, NEW_ACTION_FACET);

  console.log("Action desired =", desired.length);
  console.log("replace =", replace.length, "add =", add.length, "skip =", skip.length, "forbidden =", forbidden.length);

  // Replace first
  if (replace.length) {
    await diamondCutTx(wallet, [{ facetAddress: NEW_ACTION_FACET, action: 1, functionSelectors: replace }], "Action-Replace");
  }
  // Add
  if (add.length) {
    await diamondCutTx(wallet, [{ facetAddress: NEW_ACTION_FACET, action: 0, functionSelectors: add }], "Action-Add");
  }

  console.log("✅ Action upgrade done");
}

const selFromSig = selectorOf(
	"syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))"
  );

const selsFromAbi = getSelectors(ActionABI);

console.log("syncTokenAction selector(from signature) =", selFromSig);
console.log("ActionABI selectors count =", selsFromAbi.length);
console.log("ActionABI includes syncTokenAction? =", selsFromAbi.includes(selFromSig));

if (!selsFromAbi.includes(selFromSig)) {
  console.log("❌ ABI mismatch: ActionABI does not generate 0x43c22220");
}

// // 你想验收就跑这个：
checkAndVerify().catch((e) => {
  console.error("❌ failed:", e);
  process.exit(1);
});

// 你想升级就打开这个：
//upgradeActionFacet("0xFE482f7175999937f16E1B515aD8e1dD672211eA").catch(console.error);






/**
 * 1) 合约部署顺序（推荐顺序）
A. 部署 Oracle（如果你已经有，就跳过）

BeamioQuoteHelperV07 依赖一个 IBeamioOracle，也就是一个 getRate(uint8) 的 Oracle 合约。

如果你已有 Oracle 地址：直接用它

如果没有：你需要先部署一个简单 Oracle（测试用），或者把 QuoteHelper 的 oracle 参数先填你已有的实现

⚠️ 注意：你给的 BeamioQuoteHelperV07 里 setOracle() 没有权限控制，正式环境建议加 onlyOwner（但这是你自己的选择）

B. 部署 BeamioQuoteHelperV07

在 Remix 里选中合约 BeamioQuoteHelperV07

构造参数：

_oracle：你 Oracle 合约地址

部署成功记下地址：quoteHelper

C. 部署 BeamioUserCardDeployerV07

直接部署，无构造参数。

部署成功记下地址：deployer

部署后你需要调用一次：
setFactoryOnce(factoryAddress)（等 Factory 部署完再回头设置）

D. 部署 BeamioUserCardFactoryPaymasterV07

构造参数有 4 个：

redeemModule_：你的 Redeem 模块地址（delegatecall 用）

quoteHelper_：上面部署的 quoteHelper

deployer_：上面部署的 deployer

aaFactory_：你的 AA AccountFactory 地址（实现 beamioAccountOf(eoa) + isBeamioAccount(account)）

部署成功记下地址：factory

E. 回去设置 Deployer 的 factory

打开 BeamioUserCardDeployerV07 的已部署实例，调用：

setFactoryOnce(factory)

✅ 只允许一次，之后不能改（符合你设计）

F. 部署 BeamioUserCardGatewayExecutorV07

构造参数：

factory_：上面的 factory

部署成功记下地址：gatewayExecutor
 */