"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONET_CHAT_INDEX_REGISTRY_IMPL = exports.CONET_CHAT_INDEX_REGISTRY = exports.CONET_GENESIS_NODE_REFERRAL_VAULT_DEPLOY_BLOCK = exports.CONET_GENESIS_NODE_REFERRAL_VAULT_IMPL = exports.CONET_GENESIS_NODE_REFERRAL_VAULT = exports.GENESIS_NODE_SEAT_PAYTO = exports.GENESIS_NODE_BRIDGE_INITIATOR = exports.NODE_SALE_SERVER_FEE_USDC6 = exports.NODE_SALE_NODE_PRICE_USDC6 = exports.NODE_SALE_SPLITTER_BASE = exports.USDC_BASE = exports.PURCHASING_CARD_METADATA_ADDRESS = exports.BEAMIO_USER_CARD_ASSET_ADDRESS = exports.CONET_TREASURY_LEGACY = exports.BASE_TREASURY_LEGACY = exports.CONET_TREASURY_PEER_STABLE_SWAP_OFFLINE = exports.CONET_TREASURY_PEER = exports.BASE_TREASURY_PEER = exports.CONET_TREASURY_PEER_CREATE2_V3 = exports.CONET_TREASURY_PEER_CREATE2 = exports.CONET_TREASURY_BRIDGE_V3_DEPLOY_BLOCK = exports.CONET_TREASURY = exports.BASE_TREASURY = exports.CONET_TREASURY_CREATE2 = exports.BASE_CCSA_CARD_ADDRESS = exports.BASE_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB = exports.BASE_BEAMIO_USER_CARD_VIEWS_LIB = exports.BASE_BEAMIO_USER_CARD_UPDATE_LIB = exports.BASE_BEAMIO_USER_CARD_REFERRER_LIB = exports.BASE_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB = exports.BASE_BEAMIO_USER_CARD_MODULE_ROUTER_LIB = exports.BASE_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB = exports.BASE_BEAMIO_USER_CARD_GOVERNANCE_LIB = exports.BASE_BEAMIO_USER_CARD_GATEWAY_MINT_LIB = exports.BASE_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB = exports.BASE_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB = exports.BASE_BEAMIO_USER_CARD_TRANSFER_LIB = exports.BASE_BEAMIO_USER_CARD_FORMATTING_LIB = exports.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_4TUPLE_SELECTOR = exports.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_SELECTOR = exports.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_SELECTOR = exports.BASE_CARD_FACTORY = exports.CONET_AA_FACTORY_V2 = exports.CONET_AA_FACTORY = exports.BASE_AA_FACTORY = exports.BEAMIO_AA_FACTORY_V2 = exports.BEAMIO_AA_FACTORY_V1 = exports.BEAMIO_AA_FACTORY = exports.CONET_RPC_URL = exports.BASE_MAINNET_CHAIN_ID = void 0;
exports.CONET_GB_TOTAL = exports.CONET_GB1155 = exports.CONET_GB_DEPIN_AIRDROP = exports.CONET_GB_DECIMALS = exports.CONET_GB = exports.CONET_GB_ERC20 = exports.CONET_USDC_LEGACY = exports.CONET_USDC_LEGACY_UUPS_V1 = exports.CONET_USDC_LEGACY_UUPS_CREATE2 = exports.CONET_USDC_LEGACY_FACTORY = exports.CONET_USDC_FACTORY_LEGACY = exports.CONET_TREASURY_BRIDGE_V3 = exports.CONET_USDC = exports.CONET_BEAMIO_USER_CARD_DEFAULT = exports.CONET_BEAMIO_USER_CARD_FACTORY_EXECUTE_LIB = exports.CONET_CARD_FACTORY = exports.BASE_MAINNET_FACTORIES = exports.CONET_VALIDATOR_REFERRER_EXTENSION = exports.CONET_VALIDATOR_NODE_REWARD_INDEXER = exports.CONET_VALIDATOR_NODE_IP = exports.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN_LEGACY = exports.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN = exports.CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN = exports.CONET_VALIDATOR_DEPOSIT_FUNDER = exports.CONET_DEPOSIT_CONTRACT = exports.CONET_LAB_MINING_POOL_DEPLOY_BLOCK = exports.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK = exports.CONET_VALIDATOR_DEPOSIT_REDEEM = exports.CONET_BUSINESS_START_KET_REDEEM = exports.CONET_BUSINESS_START_KET = exports.BASE_BEAMIO_ORACLE = exports.CONET_BEAMIO_ORACLE = exports.BEAMIO_QUOTE_HELPER = exports.BEAMIO_ORACLE = exports.MERCHANT_POS_MANAGEMENT_CONET = exports.BEAMIO_INDEXER_DIAMOND = exports.CONET_BUINT_REDEEM_AIRDROP = exports.CONET_BUSINESS_START_KET_REDEEM_LEGACY = exports.CONET_DEPRECATED_BUINT_ADDRESSES = exports.CONET_REFERRAL_MERCHANT_SHARE_MODULE = exports.CONET_REFERRAL_PURCHASE_SPLIT_V1 = exports.CONET_REFERRAL_REGISTRY_VAULT_V1 = exports.CONET_BUNIT_AIRDROP_LEGACY_ADDRESS = exports.CONET_BUNIT_AIRDROP_PREVIOUS_ADDRESS = exports.CONET_BUNIT_AIRDROP_ADDRESS = exports.CONET_BUINT = exports.GENESIS_NODE_SEAT_TEST_USDC6 = exports.GENESIS_NODE_SEAT_TEST_CODE = exports.GENESIS_NODE_SEAT_CARD_ADDRESS = exports.GENESIS_NODE_SEAT_USDC_PER_NODE6 = void 0;
exports.CONTRACT_ADDRESSES = exports.CONET_MAINNET_CHAIN_ID = exports.CONET_USER_CARD_BEACON_IMPL = exports.CONET_USER_CARD_BEACON = exports.CONET_REFERRER_REGISTRY_LIB = exports.CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB = exports.CONET_BEAMIO_USER_CARD_VIEWS_LIB = exports.CONET_BEAMIO_USER_CARD_UPDATE_LIB = exports.CONET_BEAMIO_USER_CARD_REFERRER_LIB = exports.CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB = exports.CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB = exports.CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB = exports.CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB = exports.CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB = exports.CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB = exports.CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB = exports.CONET_BEAMIO_USER_CARD_TRANSFER_LIB = exports.CONET_BEAMIO_USER_CARD_FORMATTING_LIB = exports.CONET_GUARDIAN_NODES_INFO_V6 = void 0;
exports.resolveConetGbDepinAirdropAddress = resolveConetGbDepinAirdropAddress;
exports.resolveConetUserCardBeaconAddress = resolveConetUserCardBeaconAddress;
exports.isConetUserCardBeaconConfigured = isConetUserCardBeaconConfigured;
/**
 * x402sdk 是独立项目，发布/构建时不能跨项目相对引用 BeamioContract 根仓配置。
 * 本文件必须保持自包含，地址由同步脚本或手工更新。
 */
const ethers_1 = require("ethers");
exports.BASE_MAINNET_CHAIN_ID = 8453;
/** CoNET PoS HTTP RPC；与 deployments/conet-addresses.json `rpcUrl` 同步 */
exports.CONET_RPC_URL = 'https://publicrpc.conet.network';
/**
 * BeamioFactoryPaymasterV07（Nick CREATE2 跨链同址 Base + CoNET）。
 * 与 deployments/beamioAAFactory-create2-meta.json、`UserCardFactory._aaFactory()` 同步。
 * AA 账户 `createAccountFor` 仅 CoNET（224422）；Base 侧用于 isBeamioAccount / paymaster relay 等只读或 relay，不在 Base 部署新 AA。
 */
/** V1 Factory — 存量 Express Pay；勿用于新机构 AA（见 beamio-aa-account-dev.mdc） */
exports.BEAMIO_AA_FACTORY = '0x869B31C87ABd9bFB858F5183Ef6021b28ED225E2';
/** @deprecated 同 BEAMIO_AA_FACTORY（V1） */
exports.BEAMIO_AA_FACTORY_V1 = exports.BEAMIO_AA_FACTORY;
/**
 * V2 Factory（BeamioFactoryInstitutionalV2）— 新 AA + 全部 institutional-grade。
 * CoNET 224422：deployments/conet-BeamioFactoryInstitutionalV2.json
 */
exports.BEAMIO_AA_FACTORY_V2 = '0xE9577cFd00A00E97D26854243B6AB4B11D5E907f';
/** @deprecated 使用 BEAMIO_AA_FACTORY（跨链同址） */
exports.BASE_AA_FACTORY = exports.BEAMIO_AA_FACTORY;
/** CoNET 224422 同址别名（ensureAAForEOAOnConet / resolveBeamioAaOnConet）— V1 */
exports.CONET_AA_FACTORY = exports.BEAMIO_AA_FACTORY;
/** CoNET V2 Factory 别名 */
exports.CONET_AA_FACTORY_V2 = exports.BEAMIO_AA_FACTORY_V2;
/**
 * Base card factory (createCard / factoryGateway / EIP-712 domain verifyingContract).
 * Canonical: deployments/base-UserCardFactory.json / base-UserCardFactory-DEBUG.json（同址）.
 */
exports.BASE_CARD_FACTORY = '0xF2864210577359AcaE448D2B116031a0c5EE1016';
/**
 * createCardCollectionWithInitCode(address,uint8,uint256,bytes) — selector 0xef759095
 * createCardCollectionWithInitCodeAndTiers(..., (uint256,uint256,uint256)[]) — selector 0x9a7eb0f0
 *
 * Loyalty new cards: one tx `createCardCollectionWithInitCodeAndTiers` (live 3-tuple
 * `0x9a7eb0f0`). Membership-fee cards: `createCardCollectionWithInitCode` only.
 * Encode AndTiers with `encodeCreateCardCollectionWithInitCodeAndTiersCalldata` in CCSA.ts.
 * Hardhat V07 source compiles 4-tuple (`upgradeByBalance`) → selector 0x62cb913c,
 * which is **not** on the live Factory. Never send 0x62cb913c. Do not upgrade Factory
 * to add it. Calling the artifact ABI method throws
 * `missing value for component upgradeByBalance` before RPC.
 * Do not create then serial `appendTierForCard` on the new-card path (orphan if append reverts).
 */
exports.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_SELECTOR = '0xef759095';
/** Live CoNET AndTiers (3-tuple Tier). Do not confuse with 0xef759095 or 0x62cb913c. */
exports.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_SELECTOR = '0x9a7eb0f0';
/** @deprecated Hardhat 4-tuple AndTiers (includes upgradeByBalance). Not on live CoNET Factory. */
exports.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_4TUPLE_SELECTOR = '0x62cb913c';
/**
 * BeamioUserCardFormattingLib（发卡 initCode 链接用）。必须与当前 npm 编译产物 linkReferences 一致；
 * 旧地址会导致 initCode 与链上库 bytecode 不匹配，CREATE / AndTiers 整笔 revert（见成功 tx 0xda9bd5d5… 与失败 0xe67c4054… 对比）。
 * 空串时可用环境变量 BEAMIO_USER_CARD_FORMATTING_LIB。
 */
exports.BASE_BEAMIO_USER_CARD_FORMATTING_LIB = '0xe56dca3aF78a12164dC6546e6CD0E9Fe9d9Cc4b3';
/** BeamioUserCardTransferLib；同上须与 artifact 同步。 */
exports.BASE_BEAMIO_USER_CARD_TRANSFER_LIB = '0xc7fAF8e33e9fE9D4409961Ec72d46B2200766f8F';
exports.BASE_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB = '0x4d0Af8Aa67C78C81F3860497a9082A3B70b9a467';
exports.BASE_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB = '0x11D99A1d0B3C6985abE2E82B2065fCC5506e99A8';
exports.BASE_BEAMIO_USER_CARD_GATEWAY_MINT_LIB = '0xEE6309a46DBCaDD98398758fD0032A12A0a2D696';
exports.BASE_BEAMIO_USER_CARD_GOVERNANCE_LIB = '0x4564b36B44A0B689F35973A67EF19d0b46cCfc73';
exports.BASE_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB = '0x090Fb47c70412dE61B15771EF75797e36616B4ad';
exports.BASE_BEAMIO_USER_CARD_MODULE_ROUTER_LIB = '0x55154E4eb8f86Fb6E6520993Ec38E230bBf925fD';
exports.BASE_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB = '0x6f4dE4941F4b7f2Fbc179A4697E9A04F0F916732';
exports.BASE_BEAMIO_USER_CARD_REFERRER_LIB = '0x981E3ca5160C3147673Eb984FED979778eed7B68';
exports.BASE_BEAMIO_USER_CARD_UPDATE_LIB = '0xD021f61d70e1B72ec1ED49950F7F581139d6879A';
exports.BASE_BEAMIO_USER_CARD_VIEWS_LIB = '0x2e3a136733e400f579DcB71fAf78922563d8D7EC';
/** BeamioUserCardMembershipGateLib (Scheme C); deploy with beamioUserCard stack before createCard. */
exports.BASE_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB = process.env.BASE_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB || '';
/** @deprecated 废弃全局 CCSA 卡；API/客户端不得扫描或展示。见 apiExcludedUserCards.ts 与 beamio-no-legacy-global-cards.mdc */
exports.BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7';
/**
 * @deprecated 旧工厂 ConetTreasury CREATE2（Base + CoNET 同址）。
 * Base Circle USDC settle / NodeSale 仍可指向此址；CoNET 业务国库已改绑 TreasuryBridgeV3。
 */
exports.CONET_TREASURY_CREATE2 = '0xa311c8fBE7CafC611603Ee925465A62493B73B30';
/** Base 主网 Circle USDC 入金（仍为 CREATE2 ConetTreasury；与 NodeSale / nfcUsdcTopup settle 一致） */
exports.BASE_TREASURY = exports.CONET_TREASURY_CREATE2;
/**
 * CoNET 业务国库 = TreasuryBridgeV3（feeSettlement mint / 桥 / 唯一 conet-USDC 增发入口）。
 * 别名见下方 `CONET_TREASURY_BRIDGE_V3`。
 */
exports.CONET_TREASURY = '0xa208982212978550594A7FEEB70a61665d129003';
/**
 * TreasuryBridgeV3 (`CONET_TREASURY`) CREATE2 部署块高。
 * 创建 tx `0x116a43ebd7b813…` → block **557036**（`eth_getTransactionReceipt`）。
 * Genesis `voteBridgeOperation` / settle-hash 日志扫描下限必须用此值。
 */
exports.CONET_TREASURY_BRIDGE_V3_DEPLOY_BLOCK = 557036;
/** ConetTreasuryPeer（CREATE2 跨链同址）；矿工监听 StableSwapBridgeOut / burn*ForBridge，非 Discover x402 settle 目标 */
/** CoNET Peer v4（bridgeStableSwapFor + DepositLib；离线签字经 Offline 模块） */
exports.CONET_TREASURY_PEER_CREATE2 = '0x6093871d8a3EE6EaADc9869451D1693973cFBCC0';
/** @deprecated Peer v3（无 offline StableSwap） */
exports.CONET_TREASURY_PEER_CREATE2_V3 = '0x025eC62F801B2f63d5C5b3eB066bab21B12Bbeb5';
exports.BASE_TREASURY_PEER = exports.CONET_TREASURY_PEER_CREATE2;
exports.CONET_TREASURY_PEER = exports.CONET_TREASURY_PEER_CREATE2;
/** 本链离线签字 StableSwap 入口（EIP-712 verifyingContract = Peer） */
exports.CONET_TREASURY_PEER_STABLE_SWAP_OFFLINE = '0xdB91AaFf8d076a8B45B48f5d8bA8A1191627f1F2';
/** @deprecated 旧 BaseTreasury；单一国库设计已弃用 */
exports.BASE_TREASURY_LEGACY = '0x5c64a8b0935DA72d60933bBD8cD10579E1C40c58';
/** @deprecated 旧 CoNET 非 CREATE2 ConetTreasury */
exports.CONET_TREASURY_LEGACY = '0x6dC686831A497c2a9d0a2ff5A000E3Bb40a2E795';
/** @deprecated 废弃全局 CashTrees 卡；API/客户端不得作为默认商户卡。见 apiExcludedUserCards.ts 与 beamio-no-legacy-global-cards.mdc */
exports.BEAMIO_USER_CARD_ASSET_ADDRESS = '0xB7644DDb12656F4854dC746464af47D33C206F0E';
exports.PURCHASING_CARD_METADATA_ADDRESS = '0xf99018DfFdb0c5657C93ca14DB2900CEbe1168A7';
exports.USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/**
 * NodeSaleSplitter（Base，UUPS ERC1967 代理）：节点购买 USDC 拆账。
 * 每节点 = nodePrice(3880 USDC → CONET_TREASURY_CREATE2 / BASE_TREASURY) + serverFee/OPEX(120 USDC → 0x87cA…05E1)
 * = **4000 USDC** list price (OPEX included).
 * 部署后用 deployments/base-NodeSaleSplitter.json 的 `address` 回填；环境变量 NODE_SALE_SPLITTER_BASE 可覆盖。
 */
exports.NODE_SALE_SPLITTER_BASE = process.env.NODE_SALE_SPLITTER_BASE || '0x648D628e05DaD493dcECf8C8cDDb4E8867635d49';
/** 每节点本金（USDC，6 位精度）→ BASE_TREASURY；list 4000 已含 OPEX 后的节点份额 */
exports.NODE_SALE_NODE_PRICE_USDC6 = 3880000000n;
/** 每节点 OPEX / 服务器费（USDC，6 位精度）→ CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN(0x87cA…05E1)；含于 list 4000 */
exports.NODE_SALE_SERVER_FEE_USDC6 = 120000000n;
/**
 * Genesis Node Seat：Base USDC x402 settle → bridge initiator EOA，再 LockMint 入国库。
 * 必须与 Master `settle_contractAdmin` 中某一 `walletBase` 同址（当前 = vault.bridgeBinder）。
 */
exports.GENESIS_NODE_BRIDGE_INITIATOR = '0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1';
/**
 * @deprecated Alias of {@link GENESIS_NODE_BRIDGE_INITIATOR}. Historical payTo `0x17FC…637A` retired —
 * settle no longer lands on that EOA; funds LockMint into {@link CONET_GENESIS_NODE_REFERRAL_VAULT}.
 */
exports.GENESIS_NODE_SEAT_PAYTO = exports.GENESIS_NODE_BRIDGE_INITIATOR;
/** CoNET GenesisNodeReferralVaultV1 ERC1967 proxy (LockMint beneficiary + onBridgeMint splitter). */
exports.CONET_GENESIS_NODE_REFERRAL_VAULT = '0x051b65E5711E6E74bC236Fe220dcA7021841855C';
/** Current UUPS impl (setL1Ratio). Proxy address above is canonical. */
exports.CONET_GENESIS_NODE_REFERRAL_VAULT_IMPL = '0x23aBCA06b2cBDA37A372Fc071be4194739635b0D';
exports.CONET_GENESIS_NODE_REFERRAL_VAULT_DEPLOY_BLOCK = 594820;
/** CoNET ChatIndexRegistry ERC1967 proxy — per-EOA head pointer to encrypted chat-history index (IPFS content hash). */
exports.CONET_CHAT_INDEX_REGISTRY = '0x1511Caa71081C84d8a591490D1b83879088EED72';
/** Current UUPS impl. Proxy address above is canonical. */
exports.CONET_CHAT_INDEX_REGISTRY_IMPL = '0xF94299760E07E62eC33A8e91fA585f0b40d137Ee';
/** 每节点应收 USDC（6 位精度）= NODE_SALE_NODE_PRICE + NODE_SALE_SERVER_FEE */
exports.GENESIS_NODE_SEAT_USDC_PER_NODE6 = exports.NODE_SALE_NODE_PRICE_USDC6 + exports.NODE_SALE_SERVER_FEE_USDC6;
/** Discover Genesis 商家卡（SilentPassUI /discover 明细） */
exports.GENESIS_NODE_SEAT_CARD_ADDRESS = '0xafE482D2612327a0D723544B9fB713C514a793a2';
/**
 * E2E test gate for `/usdc-topup?...&workflow=genesisNodeSeat&test=…`.
 * When body `test` matches, Cluster settles **4.00 USDC** (1/1000 seat) then runs
 * `genesisNodeSeatFulfill` with vault `testMode=true` (micro split).
 *
 * **Third-party**: code-only (`test=332266`); no buyer allowlist on API.
 * **PWA**: client attaches `test` only for buyers on SilentPassUI
 * `GENESIS_NODE_SEAT_PWA_TEST_BUYER_WHITELIST`. Disabled forever after on-chain
 * `disableSaleTestMode`.
 */
exports.GENESIS_NODE_SEAT_TEST_CODE = '332266';
/** Test-mode settle amount per seat (4.00 USDC = 3.88 + 0.12, 6 decimals) */
exports.GENESIS_NODE_SEAT_TEST_USDC6 = 4000000n;
/** CoNET BUint ERC20（balanceOfAll）；与 deployments/conet-addresses.json `BUint` 同步 */
exports.CONET_BUINT = '0x54ac4672cE75EC5ACebaeF1a7aFC6F49E77Ae9Ae';
/**
 * Canonical CoNET BUnitAirdropV2 proxy — free claim + consume + Referral free redeem share one hasClaimed gate.
 * Free 20 B-Unit (new EOA) and free Referral package codes are mutually exclusive (once per EOA).
 */
exports.CONET_BUNIT_AIRDROP_ADDRESS = '0x305f90A7f38289219BA1b4be98CB5b47e7b15Ac2';
/**
 * Previous BUnitAirdrop (pre–Referral V2 cutover). V2.legacyBunitAirdrop points here;
 * free-claim eligibility also checks it for accounts that claimed before cutover.
 */
exports.CONET_BUNIT_AIRDROP_PREVIOUS_ADDRESS = '0xa01DFfD68b355540B840310a9f0C1E7a779C3Ce8';
/** Oldest BUnitAirdrop; hasClaimed 须一并检查，避免已领用户在新合约重复 eligible */
exports.CONET_BUNIT_AIRDROP_LEGACY_ADDRESS = '0xb9cf45AF87b16853c8F48a16b0495F030309e70f';
/** CoNET ReferralRegistryVaultV1 ERC1967 proxy; referral redeem writes are relayed by Master. */
exports.CONET_REFERRAL_REGISTRY_VAULT_V1 = '0xD6252Cbf266B80231397Ac2a4f25ed2d9b01DEE6';
/** CoNET ReferralPurchaseSplitV1 proxy — Fuel Pack 60% immediate / 40% deferred. */
exports.CONET_REFERRAL_PURCHASE_SPLIT_V1 = process.env.CONET_REFERRAL_PURCHASE_SPLIT_V1
    || '0x7Be303160Dd23DE0B6D420827441a8AaA1Fb0f87';
/** CoNET ReferralMerchantShareModuleV1 proxy — L0 merchant→L1 rebate share config. */
exports.CONET_REFERRAL_MERCHANT_SHARE_MODULE = process.env.CONET_REFERRAL_MERCHANT_SHARE_MODULE
    || '0xe3e06f47D89159713d67ec8530E4FE97D31Bb708';
/**
 * 已废弃 BUint 合约（Business Kit redeem 旧部署曾 wired 至 0xf548…）。
 * 余额只读展示 / 迁移脚本用；扣费与 /api/getBUnitBalance.total 仅认 canonical CONET_BUINT。
 */
exports.CONET_DEPRECATED_BUINT_ADDRESSES = [
    '0x2B7d42E560fC324f34ec57ce2FB8968F517EC7f9',
    '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB',
    '0x4A3E59519eE72B9Dcf376f0617fF0a0a5a1ef879',
    '0x1330297821814B06A6DafE3557Fa730F690D7007',
    '0xf5484F11b7De647E17aea1089e3CbD6BF15dfC0f',
    '0x9149433F154C508d2a04454b8E527A479C6fd254',
    '0xC97CEbb4DF827cB2D1453A9Df7FEf6dADa1C16Ad',
    '0xa354CC4c414568Dd14F6d63b53013f35483427f0',
    '0x4289601782F7a5572fF9409DdbBE4572107CcdA9',
];
/** 旧 BusinessStartKetRedeem（constructor buint=0xf548…）；新 redeem 部署后仅作对照 */
exports.CONET_BUSINESS_START_KET_REDEEM_LEGACY = '0xe9CeDC2c9F7DE7c0e6d1f1ba1F7e7126F0F1D3c8';
/** BuintRedeemAirdrop（CoNET）；与 deployments/conet-addresses.json 同步 */
exports.CONET_BUINT_REDEEM_AIRDROP = '0x74Fc5C1f105E64663689692e3240127DdE649AF1';
exports.BEAMIO_INDEXER_DIAMOND = '0x6113fE738489c0aB64B4606Ce333aD29b44ED0C4';
exports.MERCHANT_POS_MANAGEMENT_CONET = '0x74140e0C8118889538da8625Fc96Aac6B1342AE5';
/** 跨链同址 BeamioOracle（Nick CREATE2；Base + CoNET 同值） */
exports.BEAMIO_ORACLE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008';
/** 跨链同址 BeamioQuoteHelperV07 */
exports.BEAMIO_QUOTE_HELPER = '0xD3f275774831810006d744d32E6b024507C0d374';
/** CoNET BeamioOracle；与 deployments/conet-addresses.json `beamioOracle` 同步 */
exports.CONET_BEAMIO_ORACLE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008';
/** Base BeamioOracle */
exports.BASE_BEAMIO_ORACLE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008';
/**
 * BusinessStartKet ERC-1155（CoNET）。与 deployments/conet-addresses.json `BusinessStartKet` 同步。
 * 未部署时留空串；可用环境变量 CONET_BUSINESS_START_KET 覆盖（便于未提交地址前的本地联调）。
 */
exports.CONET_BUSINESS_START_KET = '0xAcf20dbb4DE0992d8947Ef00b505bBc17E6A03b2';
/**
 * BusinessStartKetRedeem（CoNET）。与 deployments/conet-addresses.json `BusinessStartKetRedeem` 同步。
 * 环境变量 CONET_BUSINESS_START_KET_REDEEM 可覆盖。
 */
exports.CONET_BUSINESS_START_KET_REDEEM = '0x02F98E8A2066F15F83E7758c5230398027D29f56';
/** ValidatorDepositRedeem（CoNET）；与 deployments/conet-addresses.json `ValidatorDepositRedeem` 同步 */
exports.CONET_VALIDATOR_DEPOSIT_REDEEM = '0xc71e246DD78B37C2fABc905D340932F28F503433';
/** ValidatorDepositRedeem deploy block（CoNET）；listener 补扫下限，不得低于此块 */
exports.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK = 181083;
/** ConetLabMiningPool proxy deploy block — Lab CL payout daemon backfill floor (not Redeem genesis). */
exports.CONET_LAB_MINING_POOL_DEPLOY_BLOCK = 326705;
exports.CONET_DEPOSIT_CONTRACT = '0x4242424242424242424242424242424242424242';
exports.CONET_VALIDATOR_DEPOSIT_FUNDER = '0x0981275553A41E00ec1006fe074971285E00c2A3';
/** ValidatorDepositRedeem contract admin (withdrawNative only; not redeem admin). Sync from deployments/conet-ValidatorDepositRedeem.json */
exports.CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN = '0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1';
/**
 * ValidatorDepositRedeem redeem admin used by API genesisNodeSeat fulfill
 * (`~/.master.json` `GenesisNode` private key → this address).
 */
exports.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN = '0x6CC9e08b6050Aef5Edeae9D5a065E96c360701E5';
/** Legacy redeem admin (validator node deposit key / prior ops); still valid on-chain. */
exports.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN_LEGACY = '0xE974c5d10cc36738bC2619FC73b075504D5c6d1E';
exports.CONET_VALIDATOR_NODE_IP = '212.227.242.207';
/** ValidatorNodeRewardIndexer（CoNET）：每节点/每受益人小时原子 CNET 收益账本 + 周期统计；
 *  与 deployments/conet-addresses.json `ValidatorNodeRewardIndexer` 同步。留空则由主合约 rewardIndexer() 解析。 */
exports.CONET_VALIDATOR_NODE_REWARD_INDEXER = '0xCA83d2d766701d3939Ef1644e2A911dc87CeA39D';
/** ValidatorDepositRedeemReferrerExtension（CoNET）；与 deployments/conet-addresses.json 同步 */
exports.CONET_VALIDATOR_REFERRER_EXTENSION = '0xa7410a532544aB7d1bA70701D9D0E389e4f4Cc1F';
exports.BASE_MAINNET_FACTORIES = {
    AA_FACTORY: exports.BEAMIO_AA_FACTORY,
    CARD_FACTORY: exports.BASE_CARD_FACTORY,
    BeamioCardCCSA_ADDRESS: exports.BASE_CCSA_CARD_ADDRESS,
};
/** CoNET UserCard Factory（224422）；与 deployments/conet-addresses.json `CARD_FACTORY` 同步 */
exports.CONET_CARD_FACTORY = '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB';
/** CoNET Factory ExecuteLib（linked library） */
exports.CONET_BEAMIO_USER_CARD_FACTORY_EXECUTE_LIB = '0xbc6f3926691d2306c96357ac08aadB5F50Ab0784';
/** CoNET 默认 BeamioUserCard（AA Factory `beamioUserCard`） */
exports.CONET_BEAMIO_USER_CARD_DEFAULT = '0xA5C727d11d04BeBC095bd814c6530c4e77fD6662';
/**
 * CoNET 唯一 canonical USDC（Treasury V3 `TreasuryCanonicalERC20V3`）。
 * 收费 B-Unit 焚烧 mint、钱包展示、Referral claimable 均指向此地址。
 */
exports.CONET_USDC = '0x5209865D404aA5646eDe5B91CD4218909eA72eDA';
/** TreasuryBridgeV3 proxy — 与 {@link CONET_TREASURY} 同址 */
exports.CONET_TREASURY_BRIDGE_V3 = exports.CONET_TREASURY;
/** @deprecated 工厂版 USDC（旧 ConetTreasury.createERC20）；停增发，仅存量 */
exports.CONET_USDC_FACTORY_LEGACY = '0xfD0D7B0706AaB5E4351bcED37bC3C77ed6813907';
/** @deprecated alias of CONET_USDC_FACTORY_LEGACY */
exports.CONET_USDC_LEGACY_FACTORY = exports.CONET_USDC_FACTORY_LEGACY;
/** @deprecated Nick CREATE2 UUPS USDC（未进工厂白名单） */
exports.CONET_USDC_LEGACY_UUPS_CREATE2 = '0xF9240fd613C00d5C479f1E9f1690130c5Fdc8BC3';
/** @deprecated minter=旧国库 0x6dC6… */
exports.CONET_USDC_LEGACY_UUPS_V1 = '0x84e55A7d82aEa1243cB88b20dDde9Ba5cea0E134';
/** @deprecated legacy FactoryERC20 (non-UUPS) */
exports.CONET_USDC_LEGACY = '0x2975c85D8Cc8F5d263492E332A6dAa7ad11aDBdC';
/**
 * CoNET canonical GB — `GBToken` ERC20（9 decimals；free/paid 双池；可转账 / 跨链 / StableSwap）。
 * 全项目「GB」默认语义见 `.cursor/rules/beamio-gb-erc20-canonical.mdc`。
 */
exports.CONET_GB_ERC20 = '0xC3EF02DaE632b4C10abB66e07d92a387c10838D8';
/** @alias CONET_GB_ERC20 — 活跃 GB 地址 */
exports.CONET_GB = exports.CONET_GB_ERC20;
/** GBToken decimals：1 GB = 1e9 */
exports.CONET_GB_DECIMALS = 9;
/**
 * GBDepinAirdrop — DePIN 协议补贴 + 用户带宽 GB 扣费/记账（须 GBToken V2 consumeGb）。
 * 部署后写入 deployments/conet-GBDepinAirdrop.json；可用 CONET_GB_DEPIN_AIRDROP 环境变量覆盖。
 */
exports.CONET_GB_DEPIN_AIRDROP = '0x62bcc59cC36C737E8AfBb0914F840d12cd33025f';
function resolveConetGbDepinAirdropAddress() {
    const raw = exports.CONET_GB_DEPIN_AIRDROP.trim();
    if (!raw || !ethers_1.ethers.isAddress(raw))
        return null;
    return ethers_1.ethers.getAddress(raw);
}
/** @deprecated ConetGB1155 挖矿记账轨已弃用；勿在新功能当作 canonical GB。只读遗留见 beamio-gb-erc20-canonical.mdc */
exports.CONET_GB1155 = '0x3Dc53e528d45225e8F38c391Cc6a72CDec435748';
/** @deprecated ConetGB_total（1155 全网聚合）已弃用；Dashboard 遗留只读 */
exports.CONET_GB_TOTAL = '0x949ed49faB0e999f685f16e09Cf5EaaF4090F290';
/** CoNET GuardianNodesInfoV6 — DePIN 节点 IP ↔ 运营钱包；与 deployments/conet-addresses.json 同步 */
exports.CONET_GUARDIAN_NODES_INFO_V6 = '0xBC6b53065b5647261396d002bDBA0d3396E0722f';
exports.CONET_BEAMIO_USER_CARD_FORMATTING_LIB = '0x62F18eeC53B423bb36246856Fe2216A7Df270873';
exports.CONET_BEAMIO_USER_CARD_TRANSFER_LIB = '0x8F8e3AF75FD3bF3f72897e3c5F3AE8458A1cC0a3';
exports.CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB = '0xa4072EeEB513b5ac8529CaDFC7Cb8A18C615b17A';
exports.CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB = '0xE8BCc970e1C51d0F8fFDcB3beCe1DEAd4B786986';
exports.CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB = '0x17FC474B9A86f0d639E5214Cf72D9bC068c2718b';
exports.CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB = '0x1656673561FfB970902D4e7Ec734Fcb3D5b2d286';
exports.CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB = '0x2dCe8094277BD85A0f1bcd7f72ce86C56309879d';
exports.CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB = '0x1619a3Ce48C6B45d743E0C8E4636221FfEa88Bc9';
exports.CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB = '0xEe877D169fe240e81437D2315C9f4b5A6f938648';
exports.CONET_BEAMIO_USER_CARD_REFERRER_LIB = '0x45317F44A0f071e5B397A7F095B5e40b9b50cE1e';
exports.CONET_BEAMIO_USER_CARD_UPDATE_LIB = '0xD94157Ce226E5519C6925280fa435578f1a1a585';
exports.CONET_BEAMIO_USER_CARD_VIEWS_LIB = '0x1c7c122429Da18e6078d9CEbb7B5b30F0Aa2a033';
exports.CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB = process.env.CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB || '0x048fb5BdEAeF9bFb42b7Af9118f9975E9Be933F2';
exports.CONET_REFERRER_REGISTRY_LIB = '0xE7A4287be0f6e3BDB217d72648E71312757Dd837';
/**
 * CoNET UserCard UpgradeableBeacon (P2). Empty until deployed; createCard stays on CREATE initCode
 * until this is a non-zero address.
 */
exports.CONET_USER_CARD_BEACON = process.env.CONET_USER_CARD_BEACON?.trim() || '0x01716C6b755a0FBfCF4e548A6d6B7af19ADf6698';
/** Logic implementation the beacon currently points at. Diagnostic / verify only; initCode uses the beacon. */
exports.CONET_USER_CARD_BEACON_IMPL = process.env.CONET_USER_CARD_BEACON_IMPL?.trim() || '0xc8A7a11bd74a52826dA564EE1Ec42f59b496C862';
function resolveConetUserCardBeaconAddress() {
    const raw = exports.CONET_USER_CARD_BEACON.trim();
    if (!raw || !ethers_1.ethers.isAddress(raw) || raw === ethers_1.ethers.ZeroAddress)
        return null;
    try {
        return ethers_1.ethers.getAddress(raw);
    }
    catch {
        return null;
    }
}
function isConetUserCardBeaconConfigured() {
    return resolveConetUserCardBeaconAddress() !== null;
}
/** CoNET 主网 chainId（BUnitAirdrop / consumeFromUser / 独立 BUint indexer 记账） */
exports.CONET_MAINNET_CHAIN_ID = 224422;
exports.CONTRACT_ADDRESSES = {
    base: {
        chainId: exports.BASE_MAINNET_CHAIN_ID,
        aaFactory: exports.BEAMIO_AA_FACTORY,
        cardFactory: exports.BASE_CARD_FACTORY,
        ccsaCard: exports.BASE_CCSA_CARD_ADDRESS,
        baseTreasury: exports.BASE_TREASURY,
        conetTreasury: exports.CONET_TREASURY,
        usdc: exports.USDC_BASE,
    },
    conet: {
        chainId: exports.CONET_MAINNET_CHAIN_ID,
        aaFactory: exports.CONET_AA_FACTORY,
        cardFactory: exports.CONET_CARD_FACTORY,
        defaultUserCard: exports.CONET_BEAMIO_USER_CARD_DEFAULT,
        usdc: exports.CONET_USDC,
        bUint: exports.CONET_BUINT,
        bUnitAirdrop: exports.CONET_BUNIT_AIRDROP_ADDRESS,
        buintRedeemAirdrop: exports.CONET_BUINT_REDEEM_AIRDROP,
        conetTreasury: exports.CONET_TREASURY,
        beamioIndexerDiamond: exports.BEAMIO_INDEXER_DIAMOND,
        businessStartKet: exports.CONET_BUSINESS_START_KET || undefined,
        businessStartKetRedeem: exports.CONET_BUSINESS_START_KET_REDEEM || undefined,
        validatorDepositRedeem: exports.CONET_VALIDATOR_DEPOSIT_REDEEM || undefined,
        gbErc20: exports.CONET_GB_ERC20,
        gbDepinAirdrop: exports.CONET_GB_DEPIN_AIRDROP || undefined,
        /** @deprecated legacy ConetGB1155 — do not use in new code */
        conetGb1155: exports.CONET_GB1155,
        /** @deprecated legacy ConetGB_total */
        conetGbTotal: exports.CONET_GB_TOTAL,
    },
};
