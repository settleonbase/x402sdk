/* eslint-disable no-console */
import { ethers } from "ethers";
import { masterSetup } from "./util";
// ====== ENV ======
const RPC_URL = "https://mainnet-rpc1.conet.network"
const DIAMOND = "0x083AE5AC063a55dBA769Ba71Cd301d5FC5896D5b"
const PRIVATE_KEY = masterSetup.settle_contractAdmin[0]

if (!RPC_URL) {
  console.error("❌ RPC_URL not set");
  process.exit(1);
}

// ====== ABIs ======
// 你可以改成 import { StatsABI } from "./abis/StatsFacetABI";
const DiamondLoupeABI = [
  "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
  "function facetAddress(bytes4 _functionSelector) view returns (address)",
  "function facetFunctionSelectors(address _facet) view returns (bytes4[])",
];

const OwnershipABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];

const DiamondCutABI = [
  "function diamondCut(tuple(address facetAddress,uint8 action,bytes4[] functionSelectors)[] _diamondCut,address _init,bytes _calldata)",
];

// 你给的 StatsFacet ABI（精简成 ethers 需要的 function fragments）
const StatsABI = [
  "event StatsUpdated(uint256 indexed hourIndex, address indexed card, address indexed user)",
  "function MAX_HOURS() view returns (uint256)",
  "function getAggregatedStats(uint8 mode,address account,uint256 startTimestamp,uint256 endTimestamp) view returns (tuple(uint256 totalNftMinted,uint256 totalTokenMinted,uint256 totalTokenBurned,uint256 totalTransfers))",
  "function getStatsSince(uint8 mode,address account,uint256 startTimestamp) view returns (tuple(uint256 totalNftMinted,uint256 totalTokenMinted,uint256 totalTokenBurned,uint256 totalTransfers))",
  "function getHourlyData(uint256 hourIndex) view returns (tuple(uint256 nftMinted,uint256 tokenMinted,uint256 tokenBurned,uint256 transferCount,bool hasData))",
  "function getCardHourlyData(address card,uint256 hourIndex) view returns (tuple(uint256 nftMinted,uint256 tokenMinted,uint256 tokenBurned,uint256 transferCount,bool hasData))",
  "function getUserHourlyData(address user,uint256 hourIndex) view returns (tuple(uint256 nftMinted,uint256 tokenMinted,uint256 tokenBurned,uint256 transferCount,bool hasData))",
  "function recordDetailedActivity(address card,address user,uint256 nftCount,uint256 mintAmount,uint256 burnAmount,uint256 transfers)",
  "function recordDetailedActivityAt(uint256 ts,address card,address user,uint256 nftCount,uint256 mintAmount,uint256 burnAmount,uint256 transfers)",
];

const CatalogABI = [
  "function getAllCardsCount() view returns (uint256)",
  "function getAllCardsPaged(uint256 offset,uint256 limit) view returns (address[] page)",
  "function getCardMeta(address card) view returns (tuple(address card,address creator,string name,string description,string uri,uint8 currency,uint256 priceE18,uint8 cardType,uint64 saleStart,uint64 saleEnd,bool active,uint256 createdAt,uint256 updatedAt))",
  "function registerCard(tuple(address card,address creator,string name,string description,string uri,uint8 currency,uint256 priceE18,uint8 cardType,uint64 saleStart,uint64 saleEnd,uint256 ts) in_)",
  "function setCardActive(tuple(address card,bool active,uint256 ts) in_)",
];

const ActionABI = [
  "function getActionCount() view returns (uint256)",
  "function getAction(uint256 actionId) view returns (tuple(uint8 actionType,address card,address from,address to,uint256 amount,uint256 timestamp))",
  "function getUserActionsPaged(address user,uint256 offset,uint256 limit) view returns (tuple(uint8 actionType,address card,address from,address to,uint256 amount,uint256 timestamp)[] page)",
  "function syncTokenAction(tuple(uint8 actionType,address card,address from,address to,uint256 amount,uint256 ts,string title,string note,uint256 tax,uint256 tip,uint256 beamioFee1,uint256 beamioFee2,uint256 cardServiceFee,string afterTatchNoteByFrom,string afterTatchNoteByTo,string afterTatchNoteByCardOwner) in_) returns (uint256 actionId)",
];

const TaskABI = [
  "function getTaskCount() view returns (uint256)",
];

const AdminABI = [
  "function isAdmin(address who) view returns (bool)",
  // 如果你有 addAdmin/removeAdmin 也可以加进来做可选写测
];

// ====== FACET ADDRESSES (你部署后实际的 facet 地址) ======
const FACETS = {
  DiamondCut: "0x8c7FBDCB20B00162d99f3CfeC928fcd3bfDEdBD3",
  AdminFacet: "0x2e385d2a36D75E92e7785240dCAb3607dd442576",
  TaskFacet: "0x740b5ef97fb0f475722c90B3389B1CF42C36d5Eb",
  StatsFacet: "0xcB22040bD585927a7b5d00aD7713ef0f118842B3",
  CatalogFacet: "0x1e3Bf1E967292dF3064B841194099b2Bd83C7b05",
  ActionFacet: "0xaa260ebBE43D1d5B2aBFC591F88Ee0796C8994D6",
  DiamondLoupeFacet: "0x4bb6BDD37B388c3E2e6BC16C8AE7fa1854BF9912",
  OwnershipFacet: "0x04cc1D7E893958DC5d2fc134EF7487C9A30f1Dd6",
} as const;

// ====== SELECTORS (你之前打印出来的关键函数 selector) ======
const SELECTORS = {
  diamondCut: "0x1f931c1c",

  // Catalog
  registerCard: "0x069afbb3",
  getCardMeta: "0x11a96680",
  setCardActive: "0xe1d2ae8c",

  // Action
  getActionCount: "0x5eecd218",
  getAction: "0xb6e76873",
  syncTokenAction: "0x43c22220",

  // Stats
  getAggregatedStats: "0x574c72e1",

  // Task
  getTaskCount: "0xc17a340e",

  // Admin
  isAdmin: "0x24d7806c",
} as const;

// ====== helpers ======
function mustEqual(label: string, got: string, want: string) {
  if (got.toLowerCase() !== want.toLowerCase()) {
    throw new Error(`❌ ${label} mismatch: got=${got} want=${want}`);
  }
  console.log(`✅ ${label} facet ok: ${got}`);
}

async function facetAddress(loupe: ethers.Contract, selector: string) {
  return (await loupe.facetAddress(selector)) as string;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const signer =
    PRIVATE_KEY && PRIVATE_KEY.length > 0
      ? new ethers.Wallet(PRIVATE_KEY, provider)
      : null;

  if (!signer) {
    console.log("⚠️ PRIVATE_KEY not set. Will run read-only checks. (Set env PRIVATE_KEY for optional write tests)");
  }

  console.log("== BASIC ==");
  console.log("DIAMOND =", DIAMOND);

  // contracts (diamond address + ABI)
  const loupe = new ethers.Contract(DIAMOND, DiamondLoupeABI, provider);
  const ownership = new ethers.Contract(DIAMOND, OwnershipABI, provider);

  const catalog = new ethers.Contract(DIAMOND, CatalogABI, provider);
  const action = new ethers.Contract(DIAMOND, ActionABI, provider);
  const stats = new ethers.Contract(DIAMOND, StatsABI, provider);
  const task = new ethers.Contract(DIAMOND, TaskABI, provider);
  const admin = new ethers.Contract(DIAMOND, AdminABI, provider);

  // ===== Owner check =====
  console.log("\n== Owner check ==");
  const owner = (await ownership.owner()) as string;
  console.log("diamond owner =", owner);

  // ===== Runtime bytecode hash =====
  console.log("\n== Runtime bytecode hashes ==");
  const code = await provider.getCode(DIAMOND);
  console.log("DIAMOND: codeBytes=%d keccak256=%s", (code.length - 2) / 2, ethers.keccak256(code));

  // ===== Selector route checks =====
  console.log("\n== Selector route checks (Loupe.facetAddress) ==");

  mustEqual("DiamondCut:diamondCut", await facetAddress(loupe, SELECTORS.diamondCut), FACETS.DiamondCut);

  mustEqual("Catalog:registerCard", await facetAddress(loupe, SELECTORS.registerCard), FACETS.CatalogFacet);
  mustEqual("Catalog:getCardMeta", await facetAddress(loupe, SELECTORS.getCardMeta), FACETS.CatalogFacet);
  mustEqual("Catalog:setCardActive", await facetAddress(loupe, SELECTORS.setCardActive), FACETS.CatalogFacet);

  mustEqual("Action:getActionCount", await facetAddress(loupe, SELECTORS.getActionCount), FACETS.ActionFacet);
  mustEqual("Action:getAction", await facetAddress(loupe, SELECTORS.getAction), FACETS.ActionFacet);
  mustEqual("Action:syncTokenAction", await facetAddress(loupe, SELECTORS.syncTokenAction), FACETS.ActionFacet);

  mustEqual("Stats:getAggregatedStats", await facetAddress(loupe, SELECTORS.getAggregatedStats), FACETS.StatsFacet);

  mustEqual("Task:getTaskCount", await facetAddress(loupe, SELECTORS.getTaskCount), FACETS.TaskFacet);

  mustEqual("Admin:isAdmin", await facetAddress(loupe, SELECTORS.isAdmin), FACETS.AdminFacet);

  // ===== Loupe.facets summary =====
  console.log("\n== Loupe.facets() summary ==");
  const facets = (await loupe.facets()) as Array<{ facetAddress: string; functionSelectors: string[] }>;
  console.log("facets count =", facets.length);
  for (const f of facets) {
    console.log("facet", f.facetAddress, "selectors", f.functionSelectors.length);
  }

  // optional: ensure 8 facets and includes all expected
  const facetSet = new Set(facets.map((f) => f.facetAddress.toLowerCase()));
  const expected = Object.values(FACETS).map((x) => x.toLowerCase());
  for (const addr of expected) {
    if (!facetSet.has(addr)) throw new Error(`❌ missing facet in loupe.facets(): ${addr}`);
  }
  console.log("✅ facets() contains all expected facet addresses");

  // ===== Read smoke =====
  console.log("\n== Read smoke ==");

  const cardCount = await catalog.getAllCardsCount();
  console.log("Catalog.getAllCardsCount =", cardCount.toString());

  const actionCount = await action.getActionCount();
  console.log("Action.getActionCount =", actionCount.toString());

  // ✅ FIXED: getAggregatedStats has 4 params (mode, account, start, end)
  const agg = await stats.getAggregatedStats(0, ethers.ZeroAddress, 0, 0);

  // ethers v6 兼容：
  // 1) 有些情况返回 { stats: Result(...) }
  // 2) 有些情况直接返回 Result(...)（没有 stats 字段）
  // 3) Result(...) 内部可能有命名字段，也可能只有 [0..3]
  const statsRes: any = (agg as any).stats ?? agg;
  
  const toStr = (x: any) => (x == null ? "null" : x.toString());
  
  const totalNftMinted = statsRes.totalNftMinted ?? statsRes[0];
  const totalTokenMinted = statsRes.totalTokenMinted ?? statsRes[1];
  const totalTokenBurned = statsRes.totalTokenBurned ?? statsRes[2];
  const totalTransfers = statsRes.totalTransfers ?? statsRes[3];
  
  console.log("Stats.getAggregatedStats =", {
	totalNftMinted: toStr(totalNftMinted),
	totalTokenMinted: toStr(totalTokenMinted),
	totalTokenBurned: toStr(totalTokenBurned),
	totalTransfers: toStr(totalTransfers),
  });
  

  const taskCount = await task.getTaskCount();
  console.log("Task.getTaskCount =", taskCount.toString());

  // Admin read (no signer also ok)
  const who = signer ? await signer.getAddress() : owner; // 没 signer 就测 owner 地址
  const isAdmin = await admin.isAdmin(who);
  console.log(`Admin.isAdmin(${who}) =`, isAdmin);

  // ===== Optional: minimal write smoke (OFF by default) =====
  // 如果你想开写测，把 WRITE_TEST=1
  const WRITE_TEST = process.env.WRITE_TEST === "1";
  if (WRITE_TEST) {
    if (!signer) throw new Error("WRITE_TEST=1 but PRIVATE_KEY not set");

    console.log("\n== WRITE smoke (optional) ==");

    // 例：用 DiamondCut ABI 验证 diamondCut 能 encode（不实际 cut）
    // 如果你真的要做 diamondCut 写测，你应该用 signer 并传入空 cuts 会 revert（大多数实现不允许空）
    const diamondCut = new ethers.Contract(DIAMOND, DiamondCutABI, signer);
    console.log("DiamondCut contract ready:", await diamondCut.getAddress());

    // 你也可以在这里加：syncTokenAction 写入一条最小记录（会污染链上数据，不默认做）
    console.log("⚠️ WRITE_TEST is enabled but no state-changing tx is sent by default.");
  }

  console.log("\n✅ ACCEPTANCE DONE");
}

main().catch((e) => {
  console.error("❌ failed:", e);
  process.exit(1);
});
