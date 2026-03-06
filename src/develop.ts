/**
 * develop.ts (完整版本)
 * - 支持：Phase1 安装 Loupe+Ownership（如果缺失）
 * - 支持：对 Task/Stats/Catalog/Action 做 Add / Replace / Skip 自动规划
 * - 支持：单独 ReplaceStats / ReplaceCatalog
 * - 支持：Stats recordDetailedActivityAt 写入 smoke test
 * - 支持：验收（不再写死旧 facet；用 EXPECT 覆盖你想强校验的 facet）
 *
 * 运行建议：
 *  1) npm run build && node dist/develop.js
 *  2) 在 main() / replaceStats() / replaceCatalog() / test() / checkAndVerify() 里选你要跑的入口
 */



/***
 * 
 * 3）部署顺序（严格照做）
Step A：部署 DiamondCutFacet（Tx1）

在 Contract 下拉框选 DiamondCutFacet

点击 Deploy

记下输出地址：cutFacetAddress

Step B：部署 BeamioIndexerDiamond（Tx2）

Contract 下拉框选 BeamioIndexerDiamond

在 deploy 参数里填：

initialOwner：你的 MetaMask 地址（或你想设的 owner）

diamondCutFacet：上一步的 cutFacetAddress

点击 Deploy

记下输出地址：diamondAddress

这一步完成后，你的 Diamond 地址已经存在，但只有 diamondCut。

Step C：部署其它 Facets（Tx3）

依次部署（每个都点 Deploy，记录地址）：

DiamondLoupeFacet

OwnershipFacet

TaskFacet

StatsFacet

CatalogFacet

ActionFacet

你会得到：

loupeAddr

ownAddr

taskAddr

statsAddr

catalogAddr

actionAddr

4）最关键：在 Remix 里执行 diamondCut（Tx4）

你要在 Diamond 地址上执行：

diamondCut(
  FacetCut[] cuts,
  address init,
  bytes calldata
)


其中 cuts = 每个 facet 的 {facetAddress, action, functionSelectors}

4.1 先让 Remix 能调用 diamondCut

在 Remix “Deployed Contracts” 里：

找到你部署出来的 Diamond 地址合约实例（BeamioIndexerDiamond）

你会发现它没有 diamondCut 按钮（因为是 fallback delegatecall）

✅ 解决办法：
在 Deploy 面板里选择合约 IDiamondCut（interface），然后：

点击 At Address

地址填 diamondAddress

这样 Remix 会把 IDiamondCut ABI 绑定到 Diamond 地址上，你就能看到 diamondCut(...) 按钮了。
 * 
 * 
 * 
 * 
 */

import { ethers } from "ethers";
import { masterSetup } from "./util";

import IDiamondCutABI from "./ABI/DiamondCutFacetABI.json";
import LoupeABI from "./ABI/LoupeABI.json";
import OwnershipABI from "./ABI/OwnershipABI.json";
import TaskABI from "./ABI/TaskABI.json";
import StatsABI from "./ABI/StatsABI.json";
import CatalogABI from "./ABI/CatalogABI.json";
import ActionABI from "./ABI/ActionABI.json";

const RPC_URL = "https://mainnet-rpc.conet.network";
const DIAMOND = "0xCfCfD5E8428051B84D53aE1B39DeFD50705d967f";

//										DiamondCutFacet
// ====== 你当前链上已知 facet（旧/当前）======
// 注意：升级后不一定还用这个地址，验收不要再写死它们（下面 EXPECT 才是强校验用）
const FACETS = {
  loupe: "0x22823343Af4028945452A80A695B2811A08e7Deb",
  ownership: "0xB428D8942CB6F096e979b6c21ce6E47351316c38",
  task: "0x740b5ef97fb0f475722c90B3389B1CF42C36d5Eb",
  stats: "0x6272386a59D11863DCb91C1604864FeB0Cb8F768",				//
  catalog: "0xc3b86c8d3147438bb9326A11332ED466F68681c0",			// 
  action: "0x7AA705789316e2CCA02E690d0d9aE9BeA67BEdbd",				//
  AdminFacet: ''
} as const;

// ====== 你这次升级后的“目标 facet 地址”（强校验用）======
// 如果你只想验收“已安装”而不强校验地址，可以把某个字段设为 undefined
const EXPECT: Partial<Record<"stats" | "catalog" | "action" | "task", string>> = {
  // 你验证到的 stats 新 facet：
  stats: "0x3E58592e8ecAF2c2E6957BA6c93ca34Fad20DE42",
  // 你 replace 后看到的 catalog 新 facet：
  catalog: "0x413707d465405718375CBD408cD0b1d751d0065b",
  // action 如果也有新 facet，填这里；否则注释掉表示“不强校验地址”
  action: "0x7AA705789316e2CCA02E690d0d9aE9BeA67BEdbd",
  // task 同理
  // task: "0x740b5ef97fb0f475722c90B3389B1CF42C36d5Eb",
};

// never add diamondCut selector
const DIAMOND_CUT_SELECTOR = "0x1f931c1c";
const ZERO = ethers.ZeroAddress;

// MAX_HOURS() selector（如你要把它列为 forbidden，可用它）
const MAX_HOURS_SELECTOR = ethers.id("MAX_HOURS()").slice(0, 10).toLowerCase();

// ---------- helpers ----------
function abiArray(abiJson: any) {
  const abi = Array.isArray(abiJson) ? abiJson : abiJson?.abi;
  if (!Array.isArray(abi)) throw new Error("Bad ABI JSON: expected array or {abi:[...]}");
  return abi;
}

function getSelectors(abiJson: any): string[] {
  const abi = abiArray(abiJson);
  const selectors = abi
    .filter((f: any) => f.type === "function")
    .map((f: any) =>
      ethers.id(`${f.name}(${(f.inputs || []).map((i: any) => i.type).join(",")})`).slice(0, 10)
    );
  return [...new Set(selectors)].map((s) => s.toLowerCase());
}

function buildCut(facetAddress: string, action: 0 | 1 | 2, selectors: string[]) {
  return { facetAddress, action, functionSelectors: selectors };
}

function selectorOf(signature: string) {
  return ethers.id(signature).slice(0, 10).toLowerCase();
}

async function hasLoupe(wallet: ethers.Wallet): Promise<boolean> {
  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  try {
    await loupe.facets();
    return true;
  } catch (e: any) {
    const msg = String(e?.shortMessage || e?.reason || e?.message || "");
    if (msg.includes("fn not found") || msg.includes("Diamond: fn not found")) return false;
    throw e;
  }
}

async function diamondCutTx(wallet: ethers.Wallet, cuts: any[], tag: string) {
  if (cuts.length === 0) {
    console.log(`== ${tag}: nothing to cut ==`);
    return;
  }
  const diamondCut = new ethers.Contract(DIAMOND, abiArray(IDiamondCutABI), wallet);
  console.log(`== ${tag}: diamondCut(${cuts.length} cuts) ==`);
  const tx = await diamondCut.diamondCut(cuts, ZERO, "0x");
  console.log(`${tag} tx sent:`, tx.hash);
  const receipt = await tx.wait();
  console.log(`✅ ${tag} mined. status=${receipt.status} hash=${tx.hash}`);
}

async function getInstalledSelectors(wallet: ethers.Wallet): Promise<Map<string, string>> {
  // selector -> facetAddress
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

/**
 * Decide Add vs Replace vs Skip for a facet's desired selectors.
 */
function planCutsForFacet(desiredSelectors: string[], installed: Map<string, string>, targetFacet: string) {
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
    if (!currentFacet) {
      add.push(sel);
      continue;
    }

    if (currentFacet === target) {
      skip.push(sel);
      continue;
    }

    // exists but on another facet => replace
    replace.push(sel);
  }

  return { add, replace, skip, forbidden };
}

async function mustEqual(label: string, got: string, want: string) {
  const g = got.toLowerCase();
  const w = want.toLowerCase();
  if (g !== w) {
    throw new Error(`❌ ${label} mismatch: got=${got} want=${want}`);
  }
  console.log(`✅ ${label} ok: ${got}`);
}

function mustInstalled(label: string, got: string) {
  if (got.toLowerCase() === ZERO.toLowerCase()) {
    throw new Error(`❌ ${label} not installed (facetAddress=0x0)`);
  }
  console.log(`✅ ${label} installed at ${got}`);
}

async function check(wallet: ethers.Wallet) {
  const ownership = new ethers.Contract(DIAMOND, abiArray(OwnershipABI), wallet);
  console.log("owner =", await ownership.owner());

  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  console.log("facets =", await loupe.facets());
}

// ---------- main upgrade flow ----------
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);

  const loupeInstalled = await hasLoupe(wallet);
  console.log("Loupe installed?", loupeInstalled);

  // Phase 1: install Loupe + Ownership if needed
  if (!loupeInstalled) {
    console.log("== Phase 1: Installing Loupe + Ownership ==");
    const cuts1 = [
      buildCut(FACETS.loupe, 0, getSelectors(LoupeABI)),
      buildCut(FACETS.ownership, 0, getSelectors(OwnershipABI)),
    ];
    await diamondCutTx(wallet, cuts1, "Phase1");
  } else {
    console.log("== Phase 1: skipped (Loupe already installed) ==");
  }

  // Now Loupe must exist
  const installed = await getInstalledSelectors(wallet);
  console.log("installed selectors =", installed.size);

  const planList = [
    { name: "TaskFacet", facet: FACETS.task, abi: TaskABI },
    { name: "StatsFacet", facet: FACETS.stats, abi: StatsABI },
    { name: "CatalogFacet", facet: FACETS.catalog, abi: CatalogABI },
    { name: "ActionFacet", facet: FACETS.action, abi: ActionABI },
	
  ];

  for (const x of planList) {
    const desired = getSelectors(x.abi);
    const { add, replace, skip, forbidden } = planCutsForFacet(desired, installed, x.facet);

    console.log(
      `${x.name}: desired=${desired.length} add=${add.length} replace=${replace.length} skip=${skip.length} forbidden=${forbidden.length}`
    );

    // 1) Replace first (if any)
    if (replace.length) {
      await diamondCutTx(wallet, [buildCut(x.facet, 1, replace)], `${x.name}-Replace`);
      for (const sel of replace) installed.set(sel, x.facet.toLowerCase());
    }

    // 2) Add new selectors
    if (add.length) {
      await diamondCutTx(wallet, [buildCut(x.facet, 0, add)], `${x.name}-Add`);
      for (const sel of add) installed.set(sel, x.facet.toLowerCase());
    }

    if (!add.length && !replace.length) {
      console.log(`== ${x.name}: nothing to change ==`);
    }

    if (forbidden.length) {
      console.log(`  forbidden selectors (${forbidden.length}) =`, forbidden);
    }
  }

  console.log("== Final check ==");
  await check(wallet);
}

// ---------- quick utils ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);

async function testStatsRecordDetailedActivityAt() {
  const stats = new ethers.Contract(DIAMOND, abiArray(StatsABI), wallet);

  // 写入需要 owner，所以 wallet 必须是 owner 才会成功
  const now = Math.floor(Date.now() / 1000);
  const tx = await stats.recordDetailedActivityAt(
    now,
    "0x0000000000000000000000000000000000000001", // card
    "0x0000000000000000000000000000000000000002", // user
    1,
    2,
    3,
    4
  );
  console.log("recordDetailedActivityAt tx:", tx.hash);
  await tx.wait();
  console.log("✅ recordDetailedActivityAt worked");
}

async function verifyFacetAddressOfSelector(selector: string) {
  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  const addr = await loupe.facetAddress(selector);
  console.log(`facetAddress(${selector}) =`, addr);
}

// ---------- replace helpers ----------
async function replaceStatsAll() {
  const NEW_STATS_FACET = EXPECT.stats!;
  if (!NEW_STATS_FACET) throw new Error("EXPECT.stats not set");

  const statsSelectors = getSelectors(StatsABI);

  // Replace all selectors to NEW_STATS_FACET
  const replaceStatsCut = {
    facetAddress: NEW_STATS_FACET,
    action: 1 as const,
    functionSelectors: statsSelectors,
  };

  await diamondCutTx(wallet, [replaceStatsCut], "StatsFacet-ReplaceAll");
}

async function replaceCatalogAll() {
  const NEW_CATALOG_FACET = EXPECT.catalog!;
  if (!NEW_CATALOG_FACET) throw new Error("EXPECT.catalog not set");

  const installed = await getInstalledSelectors(wallet);
  const desired = getSelectors(CatalogABI);

  // forbidden: diamondCut（通常不在这个 ABI 里，但保险起见）
  // 如果你担心 MAX_HOURS() 冲突，可以把 MAX_HOURS_SELECTOR 加进 forbidden
  const forbidden = new Set<string>([DIAMOND_CUT_SELECTOR /*, MAX_HOURS_SELECTOR*/]);

  const toReplace: string[] = [];
  const toAdd: string[] = [];
  const skippedForbidden: string[] = [];

  for (const sel of desired) {
    if (forbidden.has(sel)) {
      skippedForbidden.push(sel);
      continue;
    }
    if (installed.has(sel)) toReplace.push(sel);
    else toAdd.push(sel);
  }

  console.log("Catalog desired =", desired.length);
  console.log("replace =", toReplace.length, "add =", toAdd.length, "forbidden =", skippedForbidden.length);
  if (skippedForbidden.length) console.log("forbidden selectors =", skippedForbidden);

  if (toReplace.length) {
    await diamondCutTx(
      wallet,
      [{ facetAddress: NEW_CATALOG_FACET, action: 1, functionSelectors: toReplace }],
      "CatalogFacet-Replace"
    );
  }

  if (toAdd.length) {
    await diamondCutTx(
      wallet,
      [{ facetAddress: NEW_CATALOG_FACET, action: 0, functionSelectors: toAdd }],
      "CatalogFacet-Add"
    );
  }

  console.log("✅ Catalog upgrade done");
}

// ---------- acceptance / verify ----------
async function checkAndVerify() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);

  const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  const ownership = new ethers.Contract(DIAMOND, abiArray(OwnershipABI), wallet);
  const catalog = new ethers.Contract(DIAMOND, abiArray(CatalogABI), wallet);
  const action = new ethers.Contract(DIAMOND, abiArray(ActionABI), wallet);

  console.log("== Owner check ==");
  console.log("diamond owner =", await ownership.owner());
  console.log("wallet       =", await wallet.getAddress());

  console.log("\n== Facet route checks (Loupe.facetAddress) ==");

  // ---- Catalog selectors ----
  const sel_catalog_register = selectorOf(
    "registerCard((address,address,string,string,string,uint8,uint256,uint8,uint64,uint64,uint256))"
  );
  const sel_catalog_update = selectorOf(
    "updateCardMeta((address,string,string,string,uint8,uint256,uint8,uint64,uint64,uint256))"
  );
  const sel_catalog_setActive = selectorOf("setCardActive((address,bool,uint256))");
  const sel_catalog_getMeta = selectorOf("getCardMeta(address)");
  const sel_catalog_agg = selectorOf("getCatalogAggregatedStats(uint8,address,uint8,uint256,uint256)");

  console.log("Catalog selectors:");
  console.log(" registerCard              =", sel_catalog_register);
  console.log(" updateCardMeta            =", sel_catalog_update);
  console.log(" setCardActive             =", sel_catalog_setActive);
  console.log(" getCardMeta               =", sel_catalog_getMeta);
  console.log(" getCatalogAggregatedStats =", sel_catalog_agg);

  // ---- Action selectors ----
  const sel_action_sync = selectorOf(
    "syncTokenAction((uint8,address,address,address,uint256,uint256,string,string,uint256,uint256,uint256,uint256,uint256,string,string,string))"
  );
  const sel_action_getAction = selectorOf("getAction(uint256)");
  const sel_action_getWithMeta = selectorOf("getActionWithMeta(uint256)");
  const sel_action_setNotes = selectorOf("setAfterTatchNotes(uint256,string,string,string)");
  const sel_action_userPaged = selectorOf("getUserActionsPaged(address,uint256,uint256)");
  const sel_action_cardPaged = selectorOf("getCardActionsPaged(address,uint256,uint256)");

  console.log("\nAction selectors:");
  console.log(" syncTokenAction     =", sel_action_sync);
  console.log(" getAction           =", sel_action_getAction);
  console.log(" getActionWithMeta   =", sel_action_getWithMeta);
  console.log(" setAfterTatchNotes  =", sel_action_setNotes);
  console.log(" getUserActionsPaged =", sel_action_userPaged);
  console.log(" getCardActionsPaged =", sel_action_cardPaged);

  // ---- routing query ----
  const fa_catalog_getMeta = await loupe.facetAddress(sel_catalog_getMeta);
  const fa_catalog_register = await loupe.facetAddress(sel_catalog_register);
  const fa_action_getAction = await loupe.facetAddress(sel_action_getAction);
  const fa_action_sync = await loupe.facetAddress(sel_action_sync);

  // ✅ 如果 EXPECT.xxx 存在就强校验地址；否则只校验“已安装”
  if (EXPECT.catalog) {
    await mustEqual("Catalog:getCardMeta facet", fa_catalog_getMeta, EXPECT.catalog);
    await mustEqual("Catalog:registerCard facet", fa_catalog_register, EXPECT.catalog);
  } else {
    mustInstalled("Catalog:getCardMeta facet", fa_catalog_getMeta);
    mustInstalled("Catalog:registerCard facet", fa_catalog_register);
  }

  if (EXPECT.action) {
    await mustEqual("Action:getAction facet", fa_action_getAction, EXPECT.action);
    await mustEqual("Action:syncTokenAction facet", fa_action_sync, EXPECT.action);
  } else {
    mustInstalled("Action:getAction facet", fa_action_getAction);
    mustInstalled("Action:syncTokenAction facet", fa_action_sync);
  }

  console.log("\n== Catalog read checks ==");
  const allCnt = await catalog.getAllCardsCount();
  console.log("getAllCardsCount =", allCnt.toString());

  const page = await catalog.getAllCardsPaged(0, 5);
  console.log("getAllCardsPaged(0,5) size =", page.length);

  if (page.length > 0) {
    const c0 = page[0];
    const meta = await catalog.getCardMeta(c0);
    console.log("first card =", c0);
    console.log("meta.creator =", meta.creator);
    console.log("meta.cardType =", meta.cardType.toString());
    console.log("meta.active =", meta.active);
  } else {
    console.log("no cards yet; skip getCardMeta sample");
  }

  console.log("\n== Action read checks ==");
  const actCnt = await action.getActionCount();
  console.log("getActionCount =", actCnt.toString());

  const emptyUserPage = await action.getUserActionsPaged(ZERO, 0, 5);
  console.log("getUserActionsPaged(0x0,0,5) size =", emptyUserPage.length);

  if (actCnt > 0n) {
    const a1 = await action.getActionWithMeta(1);
    console.log("getActionWithMeta(1).action.timestamp =", a1.action_.timestamp.toString());
    console.log("getActionWithMeta(1).meta.title =", a1.meta_.title);
  } else {
    console.log("no actions yet; skip getActionWithMeta sample");
  }

  console.log("\n✅ ACCEPTANCE DONE");
}

function fnSelector(iface: ethers.Interface, nameOrSig: string): string {
	const f = iface.getFunction(nameOrSig);
	if (!f) throw new Error(`Function not found in ABI: ${nameOrSig}`);
	return f.selector.toLowerCase();
  }

async function fixCatalogWriteSelectors() {
	const provider = new ethers.JsonRpcProvider(RPC_URL);
	const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);
  
	const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  
	const NEW_CATALOG_FACET = EXPECT.catalog!;
	if (!NEW_CATALOG_FACET) throw new Error("EXPECT.catalog not set");
  
	// ✅ 从 ABI 直接取 selector（别手写 signature）
	const catalogIface = new ethers.Interface(abiArray(CatalogABI));
  
	const sels = [
	  fnSelector(catalogIface, "registerCard"),
	  fnSelector(catalogIface, "updateCardMeta"),
	  fnSelector(catalogIface, "setCardActive"),
	];
  
	const toAdd: string[] = [];
	const toReplace: string[] = [];
  
	for (const sel of sels) {
	  if (sel === DIAMOND_CUT_SELECTOR) continue;
  
	  const cur = (await loupe.facetAddress(sel)).toLowerCase();
	  if (cur === ZERO.toLowerCase()) {
		toAdd.push(sel);
	  } else if (cur !== NEW_CATALOG_FACET.toLowerCase()) {
		toReplace.push(sel);
	  }
	}
  
	console.log("Catalog write selectors:", sels);
	console.log("toAdd =", toAdd.length, "toReplace =", toReplace.length);
  
	if (toReplace.length) {
	  await diamondCutTx(
		wallet,
		[buildCut(NEW_CATALOG_FACET, 1, toReplace)],
		"CatalogWrite-Replace"
	  );
	}
  
	if (toAdd.length) {
	  await diamondCutTx(
		wallet,
		[buildCut(NEW_CATALOG_FACET, 0, toAdd)],
		"CatalogWrite-Add"
	  );
	}
  
	console.log("✅ fixCatalogWriteSelectors done");
  }

  async function fixActionSyncTokenActionSelector() {
	const provider = new ethers.JsonRpcProvider(RPC_URL);
	const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);
  
	// 1) 取出 ABI 中的 syncTokenAction selector（别手写 signature）
	const actionIface = new ethers.Interface(abiArray(ActionABI));
	const sel = fnSelector(actionIface, "syncTokenAction"); // => 你期待的 0x43c22220
	console.log("Action syncTokenAction selector =", sel);
  
	// 2) 查当前 selector 在 diamond 里路由到哪里
	const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
	const current = (await loupe.facetAddress(sel)).toLowerCase();
	const target = FACETS.action.toLowerCase();
  
	if (current === target) {
	  console.log("✅ already routed to target facet:", target);
	  return;
	}
  
	// 3) 决定 Add 还是 Replace
	// current == 0x0 => Add
	// current != 0x0 且 != target => Replace
	const action: 0 | 1 = current === ethers.ZeroAddress ? 0 : 1;
  
	console.log(`to${action === 0 ? "Add" : "Replace"} = 1`, "current =", current);
  
	// 4) diamondCut
	await diamondCutTx(
	  wallet,
	  [buildCut(FACETS.action, action, [sel])],
	  `ActionSync-${action === 0 ? "Add" : "Replace"}`
	);
  
	console.log("✅ fixActionSyncTokenActionSelector done");
  }

// ---------- choose entrypoint ----------
// 推荐你只打开一个入口，避免你一跑就同时升级+验收+写入

(async () => {
  // 1) 全量升级（Add/Replace 自动规划）
  // await main();

  // 2) 只替换 Stats 全部 selectors 到 EXPECT.stats
  // await replaceStatsAll();

  // 3) 只替换 Catalog 全部 selectors 到 EXPECT.catalog
  // await replaceCatalogAll();

  // 4) Stats 写入 smoke test（需要 owner）
  // await testStatsRecordDetailedActivityAt();

  // 5) 单个 selector 路由查询（例：recordDetailedActivityAt 的 selector）
  // await verifyFacetAddressOfSelector("0xddf8f3b9");

  // 6) 验收（支持强校验 EXPECT，也支持只校验 installed）
 
//   await checkAndVerify();
})().catch((e) => {
  console.error("❌ failed:", e);
  process.exit(1);
});

async function debugActionReadRouting() {
	const provider = new ethers.JsonRpcProvider(RPC_URL);
	const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);
  
	const loupe = new ethers.Contract(DIAMOND, abiArray(LoupeABI), wallet);
  
	const sel = ethers.id("getActionCount()").slice(0, 10).toLowerCase(); // 0x5eecd218
	const fa = await loupe.facetAddress(sel);
  
	console.log("selector(getActionCount) =", sel);
	console.log("facetAddress(getActionCount) =", fa);
  }

// debugActionReadRouting()

async function debugFacetHasCode() {
	const provider = new ethers.JsonRpcProvider(RPC_URL);
  
	const addr = "0x7AA705789316e2CCA02E690d0d9aE9BeA67BEdbd";
	const code = await provider.getCode(addr);
  
	console.log("facet =", addr);
	console.log("code length =", code.length); // "0x" => 2；有代码一般 > 2
	if (code === "0x") throw new Error("❌ facet address has NO code (EOA or not deployed)");
  }

//   debugFacetHasCode()

async function directFacetSmoke() {
	const provider = new ethers.JsonRpcProvider(RPC_URL);
	const wallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], provider);
  
	const facetAddr = "0x7AA705789316e2CCA02E690d0d9aE9BeA67BEdbd";
	const facet = new ethers.Contract(facetAddr, abiArray(ActionABI), wallet);
  
	// 1) 直接 call facet（不是 diamond）
	const v = await facet.getActionCount();
	console.log("direct facet getActionCount =", v.toString());

	function safeSelector(abiJson: any, name: string) {
		const iface = new ethers.Interface(abiArray(abiJson));
		const fn = iface.getFunction(name);
		if (!fn) throw new Error(`Function not found in ABI: ${name}`);
		return fn.selector.toLowerCase();
	  }
	  
	  console.log("ABI selector(getActionCount) =", safeSelector(ActionABI, "getActionCount"));

  }



  directFacetSmoke()