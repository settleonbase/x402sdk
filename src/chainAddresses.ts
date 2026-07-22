/**
 * x402sdk 是独立项目，发布/构建时不能跨项目相对引用 BeamioContract 根仓配置。
 * 本文件必须保持自包含，地址由同步脚本或手工更新。
 */
export const BASE_MAINNET_CHAIN_ID = 8453

/** CoNET PoS HTTP RPC；与 deployments/conet-addresses.json `rpcUrl` 同步 */
export const CONET_RPC_URL = 'https://publicrpc.conet.network'

/**
 * BeamioFactoryPaymasterV07（Nick CREATE2 跨链同址 Base + CoNET）。
 * 与 deployments/beamioAAFactory-create2-meta.json、`UserCardFactory._aaFactory()` 同步。
 * AA 账户 `createAccountFor` 仅 CoNET（224422）；Base 侧用于 isBeamioAccount / paymaster relay 等只读或 relay，不在 Base 部署新 AA。
 */
/** V1 Factory — 存量 Express Pay；勿用于新机构 AA（见 beamio-aa-account-dev.mdc） */
export const BEAMIO_AA_FACTORY = '0x869B31C87ABd9bFB858F5183Ef6021b28ED225E2'
/** @deprecated 同 BEAMIO_AA_FACTORY（V1） */
export const BEAMIO_AA_FACTORY_V1 = BEAMIO_AA_FACTORY

/**
 * V2 Factory（BeamioFactoryInstitutionalV2）— 新 AA + 全部 institutional-grade。
 * CoNET 224422：deployments/conet-BeamioFactoryInstitutionalV2.json
 */
export const BEAMIO_AA_FACTORY_V2 = '0x02F00061ae54d76C3308EA24D2B3d0a24df60fAd'

/** @deprecated 使用 BEAMIO_AA_FACTORY（跨链同址） */
export const BASE_AA_FACTORY = BEAMIO_AA_FACTORY

/** CoNET 224422 同址别名（ensureAAForEOAOnConet / resolveBeamioAaOnConet）— V1 */
export const CONET_AA_FACTORY = BEAMIO_AA_FACTORY
/** CoNET V2 Factory 别名 */
export const CONET_AA_FACTORY_V2 = BEAMIO_AA_FACTORY_V2
/**
 * Base card factory (createCard / factoryGateway / EIP-712 domain verifyingContract).
 * Canonical: deployments/base-UserCardFactory.json / base-UserCardFactory-DEBUG.json（同址）.
 */
export const BASE_CARD_FACTORY = '0xF2864210577359AcaE448D2B116031a0c5EE1016'
/**
 * createCardCollectionWithInitCode(address,uint8,uint256,bytes) — selector 0xef759095
 * createCardCollectionWithInitCodeAndTiers(..., (uint256,uint256,uint256)[]) — selector 0x9a7eb0f0
 * 编码须用完整 Factory ABI（如 ABI/BeamioUserCardFactoryPaymaster.json），勿把两函数 selector 混用：
 * 用 0x9a7eb0f0 调 4 参、或用精简 ABI 导致缺少 AndTiers，均会整笔 revert。
 */
export const FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_SELECTOR = '0xef759095' as const
/** 5 参工厂方法（含 Tier[]）；与 4 参方法并存，勿与 0xef759095 混淆 */
export const FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_SELECTOR = '0x9a7eb0f0' as const
/**
 * BeamioUserCardFormattingLib（发卡 initCode 链接用）。必须与当前 npm 编译产物 linkReferences 一致；
 * 旧地址会导致 initCode 与链上库 bytecode 不匹配，CREATE / AndTiers 整笔 revert（见成功 tx 0xda9bd5d5… 与失败 0xe67c4054… 对比）。
 * 空串时可用环境变量 BEAMIO_USER_CARD_FORMATTING_LIB。
 */
export const BASE_BEAMIO_USER_CARD_FORMATTING_LIB = '0xe56dca3aF78a12164dC6546e6CD0E9Fe9d9Cc4b3'
/** BeamioUserCardTransferLib；同上须与 artifact 同步。 */
export const BASE_BEAMIO_USER_CARD_TRANSFER_LIB = '0xc7fAF8e33e9fE9D4409961Ec72d46B2200766f8F'
export const BASE_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB = '0x4d0Af8Aa67C78C81F3860497a9082A3B70b9a467'
export const BASE_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB = '0x11D99A1d0B3C6985abE2E82B2065fCC5506e99A8'
export const BASE_BEAMIO_USER_CARD_GATEWAY_MINT_LIB = '0xEE6309a46DBCaDD98398758fD0032A12A0a2D696'
export const BASE_BEAMIO_USER_CARD_GOVERNANCE_LIB = '0x4564b36B44A0B689F35973A67EF19d0b46cCfc73'
export const BASE_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB = '0x090Fb47c70412dE61B15771EF75797e36616B4ad'
export const BASE_BEAMIO_USER_CARD_MODULE_ROUTER_LIB = '0x55154E4eb8f86Fb6E6520993Ec38E230bBf925fD'
export const BASE_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB = '0x6f4dE4941F4b7f2Fbc179A4697E9A04F0F916732'
export const BASE_BEAMIO_USER_CARD_REFERRER_LIB = '0x981E3ca5160C3147673Eb984FED979778eed7B68'
export const BASE_BEAMIO_USER_CARD_UPDATE_LIB = '0xD021f61d70e1B72ec1ED49950F7F581139d6879A'
export const BASE_BEAMIO_USER_CARD_VIEWS_LIB = '0x2e3a136733e400f579DcB71fAf78922563d8D7EC'
/** BeamioUserCardMembershipGateLib (Scheme C); deploy with beamioUserCard stack before createCard. */
export const BASE_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB =
  process.env.BASE_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB || ''
/** @deprecated 废弃全局 CCSA 卡；API/客户端不得扫描或展示。见 apiExcludedUserCards.ts 与 beamio-no-legacy-global-cards.mdc */
export const BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
/** 统一国库 ConetTreasury（CREATE2 跨链同址 Base + CoNET）；USDC 入金、投票出金、mint/burn peer */
export const CONET_TREASURY_CREATE2 = '0xa311c8fBE7CafC611603Ee925465A62493B73B30'
/** Base 主网国库收款（与 CONET_TREASURY_CREATE2 同址；已部署 Base 8453） */
export const BASE_TREASURY = CONET_TREASURY_CREATE2
/** CoNET 主网国库投票/mint（与 CONET_TREASURY_CREATE2 同址；须 CoNET L1 CREATE2 部署后才有 code） */
export const CONET_TREASURY = CONET_TREASURY_CREATE2
/** @deprecated 旧 BaseTreasury；单一国库设计已弃用 */
export const BASE_TREASURY_LEGACY = '0x5c64a8b0935DA72d60933bBD8cD10579E1C40c58'
/** @deprecated 旧 CoNET 非 CREATE2 ConetTreasury */
export const CONET_TREASURY_LEGACY = '0x6dC686831A497c2a9d0a2ff5A000E3Bb40a2E795'
/** @deprecated 废弃全局 CashTrees 卡；API/客户端不得作为默认商户卡。见 apiExcludedUserCards.ts 与 beamio-no-legacy-global-cards.mdc */
export const BEAMIO_USER_CARD_ASSET_ADDRESS = '0xB7644DDb12656F4854dC746464af47D33C206F0E'
export const PURCHASING_CARD_METADATA_ADDRESS = '0xf99018DfFdb0c5657C93ca14DB2900CEbe1168A7'
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/**
 * NodeSaleSplitter（Base，UUPS ERC1967 代理）：节点购买 USDC 拆账。
 * 每节点 = nodePrice(1250 USDC → CONET_TREASURY_CREATE2 / BASE_TREASURY) + serverFee(120 USDC → 0x87cA…05E1)。
 * 部署后用 deployments/base-NodeSaleSplitter.json 的 `address` 回填；环境变量 NODE_SALE_SPLITTER_BASE 可覆盖。
 */
export const NODE_SALE_SPLITTER_BASE =
  process.env.NODE_SALE_SPLITTER_BASE || '0x648D628e05DaD493dcECf8C8cDDb4E8867635d49'
/** 每节点本金（USDC，6 位精度）→ BASE_TREASURY */
export const NODE_SALE_NODE_PRICE_USDC6 = 1_250_000_000n
/** 每节点服务器费（USDC，6 位精度）→ CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN(0x87cA…05E1) */
export const NODE_SALE_SERVER_FEE_USDC6 = 120_000_000n

/** CoNET BUint ERC20（balanceOfAll）；与 deployments/conet-addresses.json `BUint` 同步 */
export const CONET_BUINT = '0x54ac4672cE75EC5ACebaeF1a7aFC6F49E77Ae9Ae'
/**
 * Canonical CoNET BUnitAirdropV2 proxy — free claim + consume + Referral free redeem share one hasClaimed gate.
 * Free 20 B-Unit (new EOA) and free Referral package codes are mutually exclusive (once per EOA).
 */
export const CONET_BUNIT_AIRDROP_ADDRESS = '0x305f90A7f38289219BA1b4be98CB5b47e7b15Ac2'
/**
 * Previous BUnitAirdrop (pre–Referral V2 cutover). V2.legacyBunitAirdrop points here;
 * free-claim eligibility also checks it for accounts that claimed before cutover.
 */
export const CONET_BUNIT_AIRDROP_PREVIOUS_ADDRESS = '0xa01DFfD68b355540B840310a9f0C1E7a779C3Ce8'
/** Oldest BUnitAirdrop; hasClaimed 须一并检查，避免已领用户在新合约重复 eligible */
export const CONET_BUNIT_AIRDROP_LEGACY_ADDRESS = '0xb9cf45AF87b16853c8F48a16b0495F030309e70f'
/** CoNET ReferralRegistryVaultV1 ERC1967 proxy; referral redeem writes are relayed by Master. */
export const CONET_REFERRAL_REGISTRY_VAULT_V1 = '0xD6252Cbf266B80231397Ac2a4f25ed2d9b01DEE6'
/** CoNET ReferralMerchantShareModuleV1 proxy — L0 merchant→L1 rebate share config. */
export const CONET_REFERRAL_MERCHANT_SHARE_MODULE = process.env.CONET_REFERRAL_MERCHANT_SHARE_MODULE
	|| '0xe3e06f47D89159713d67ec8530E4FE97D31Bb708'
/**
 * 已废弃 BUint 合约（Business Kit redeem 旧部署曾 wired 至 0xf548…）。
 * 余额只读展示 / 迁移脚本用；扣费与 /api/getBUnitBalance.total 仅认 canonical CONET_BUINT。
 */
export const CONET_DEPRECATED_BUINT_ADDRESSES = [
	'0x2B7d42E560fC324f34ec57ce2FB8968F517EC7f9',
	'0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB',
	'0x4A3E59519eE72B9Dcf376f0617fF0a0a5a1ef879',
	'0x1330297821814B06A6DafE3557Fa730F690D7007',
	'0xf5484F11b7De647E17aea1089e3CbD6BF15dfC0f',
	'0x9149433F154C508d2a04454b8E527A479C6fd254',
	'0xC97CEbb4DF827cB2D1453A9Df7FEf6dADa1C16Ad',
	'0xa354CC4c414568Dd14F6d63b53013f35483427f0',
	'0x4289601782F7a5572fF9409DdbBE4572107CcdA9',
] as const
/** 旧 BusinessStartKetRedeem（constructor buint=0xf548…）；新 redeem 部署后仅作对照 */
export const CONET_BUSINESS_START_KET_REDEEM_LEGACY = '0xe9CeDC2c9F7DE7c0e6d1f1ba1F7e7126F0F1D3c8'
/** BuintRedeemAirdrop（CoNET）；与 deployments/conet-addresses.json 同步 */
export const CONET_BUINT_REDEEM_AIRDROP = '0x74Fc5C1f105E64663689692e3240127DdE649AF1'
export const BEAMIO_INDEXER_DIAMOND = '0x6113fE738489c0aB64B4606Ce333aD29b44ED0C4'
export const MERCHANT_POS_MANAGEMENT_CONET = '0x74140e0C8118889538da8625Fc96Aac6B1342AE5'
/** 跨链同址 BeamioOracle（Nick CREATE2；Base + CoNET 同值） */
export const BEAMIO_ORACLE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'
/** 跨链同址 BeamioQuoteHelperV07 */
export const BEAMIO_QUOTE_HELPER = '0xD3f275774831810006d744d32E6b024507C0d374'
/** CoNET BeamioOracle；与 deployments/conet-addresses.json `beamioOracle` 同步 */
export const CONET_BEAMIO_ORACLE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'
/** Base BeamioOracle */
export const BASE_BEAMIO_ORACLE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'

/**
 * BusinessStartKet ERC-1155（CoNET）。与 deployments/conet-addresses.json `BusinessStartKet` 同步。
 * 未部署时留空串；可用环境变量 CONET_BUSINESS_START_KET 覆盖（便于未提交地址前的本地联调）。
 */
export const CONET_BUSINESS_START_KET = '0xAcf20dbb4DE0992d8947Ef00b505bBc17E6A03b2'

/**
 * BusinessStartKetRedeem（CoNET）。与 deployments/conet-addresses.json `BusinessStartKetRedeem` 同步。
 * 环境变量 CONET_BUSINESS_START_KET_REDEEM 可覆盖。
 */
export const CONET_BUSINESS_START_KET_REDEEM = '0x02F98E8A2066F15F83E7758c5230398027D29f56'

/** ValidatorDepositRedeem（CoNET）；与 deployments/conet-addresses.json `ValidatorDepositRedeem` 同步 */
export const CONET_VALIDATOR_DEPOSIT_REDEEM = '0xc71e246DD78B37C2fABc905D340932F28F503433'
/** ValidatorDepositRedeem deploy block（CoNET）；listener 补扫下限，不得低于此块 */
export const CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK = 181083
/** ConetLabMiningPool proxy deploy block — Lab CL payout daemon backfill floor (not Redeem genesis). */
export const CONET_LAB_MINING_POOL_DEPLOY_BLOCK = 326705
export const CONET_DEPOSIT_CONTRACT = '0x4242424242424242424242424242424242424242'
export const CONET_VALIDATOR_DEPOSIT_FUNDER = '0x0981275553A41E00ec1006fe074971285E00c2A3'
/** ValidatorDepositRedeem contract admin (withdrawNative only; not redeem admin). Sync from deployments/conet-ValidatorDepositRedeem.json */
export const CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN = '0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1'
/** ValidatorDepositRedeem redeem admin on validator node 38.102.85.33 (~/.master.json key_38.102.85.33) */
export const CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN = '0xE974c5d10cc36738bC2619FC73b075504D5c6d1E'
export const CONET_VALIDATOR_NODE_IP = '212.227.242.207'
/** ValidatorNodeRewardIndexer（CoNET）：每节点/每受益人小时原子 CNET 收益账本 + 周期统计；
 *  与 deployments/conet-addresses.json `ValidatorNodeRewardIndexer` 同步。留空则由主合约 rewardIndexer() 解析。 */
export const CONET_VALIDATOR_NODE_REWARD_INDEXER = '0xCA83d2d766701d3939Ef1644e2A911dc87CeA39D'
/** ValidatorDepositRedeemReferrerExtension（CoNET）；与 deployments/conet-addresses.json 同步 */
export const CONET_VALIDATOR_REFERRER_EXTENSION = '0xa7410a532544aB7d1bA70701D9D0E389e4f4Cc1F'

export const BASE_MAINNET_FACTORIES = {
  AA_FACTORY: BEAMIO_AA_FACTORY,
  CARD_FACTORY: BASE_CARD_FACTORY,
  BeamioCardCCSA_ADDRESS: BASE_CCSA_CARD_ADDRESS,
} as const

/** CoNET UserCard Factory（224422）；与 deployments/conet-addresses.json `CARD_FACTORY` 同步 */
export const CONET_CARD_FACTORY = '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB'
/** CoNET Factory ExecuteLib（linked library） */
export const CONET_BEAMIO_USER_CARD_FACTORY_EXECUTE_LIB = '0xbc6f3926691d2306c96357ac08aadB5F50Ab0784'
/** CoNET 默认 BeamioUserCard（AA Factory `beamioUserCard`） */
export const CONET_BEAMIO_USER_CARD_DEFAULT = '0xA5C727d11d04BeBC095bd814c6530c4e77fD6662'
/** CoNET USDC（ConetTreasury `FactoryERC20`）；UserCard Factory `USDC_TOKEN` */
/** CONET-USDC UUPS proxy；minter = 同址 Treasury 0xa311… */
export const CONET_USDC = '0xF9240fd613C00d5C479f1E9f1690130c5Fdc8BC3'
/** @deprecated minter=旧国库 0x6dC6… */
export const CONET_USDC_LEGACY_UUPS_V1 = '0x84e55A7d82aEa1243cB88b20dDde9Ba5cea0E134'
/** @deprecated legacy FactoryERC20 (non-UUPS) */
export const CONET_USDC_LEGACY = '0x2975c85D8Cc8F5d263492E332A6dAa7ad11aDBdC'
/** CoNET GB ERC1155（ConetGB1155）；id=0 为累计净 GB（18 decimals） */
export const CONET_GB1155 = '0x3Dc53e528d45225e8F38c391Cc6a72CDec435748'
/** CoNET GB total（ConetGB_total，1155 净额聚合） */
export const CONET_GB_TOTAL = '0x949ed49faB0e999f685f16e09Cf5EaaF4090F290'
/** CoNET GuardianNodesInfoV6 — DePIN 节点 IP ↔ 运营钱包；与 deployments/conet-addresses.json 同步 */
export const CONET_GUARDIAN_NODES_INFO_V6 = '0xBC6b53065b5647261396d002bDBA0d3396E0722f'
export const CONET_BEAMIO_USER_CARD_FORMATTING_LIB = '0x9727136BC5DAA5540e7397C9086e9980EBDD0e48'
export const CONET_BEAMIO_USER_CARD_TRANSFER_LIB = '0xBcf3f8C5994B02B89fB743e1dee6AFDD5a49a664'
export const CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB = '0x602646B80Df4d46eF3dCF1C2AB60899135e5d0AC'
export const CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB = '0xE8BCc970e1C51d0F8fFDcB3beCe1DEAd4B786986'
export const CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB = '0x4d62ab34c4E7df4a124806A45F82C591681E7C4D'
export const CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB = '0x1656673561FfB970902D4e7Ec734Fcb3D5b2d286'
export const CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB = '0x2dCe8094277BD85A0f1bcd7f72ce86C56309879d'
export const CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB = '0x6c1d2b58f0893F35Cf608b734CB425A44bf139F5'
export const CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB = '0x10dAdE725b8E12d67AEdBaf2a50C57E1B86F5f82'
export const CONET_BEAMIO_USER_CARD_REFERRER_LIB = '0x9aBB24d2a3760241a22616DECedA7ab04B452345'
export const CONET_BEAMIO_USER_CARD_UPDATE_LIB = '0x269eEf460A5256bB81660CDD1325AE2A6D9f39Cb'
export const CONET_BEAMIO_USER_CARD_VIEWS_LIB = '0x1c7c122429Da18e6078d9CEbb7B5b30F0Aa2a033'
export const CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB =
  process.env.CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB || '0x048fb5BdEAeF9bFb42b7Af9118f9975E9Be933F2'
export const CONET_REFERRER_REGISTRY_LIB = '0x1A4D7F46B553528e3e0b64425079cCcD8E15e5Ca'

/** CoNET 主网 chainId（BUnitAirdrop / consumeFromUser / 独立 BUint indexer 记账） */
export const CONET_MAINNET_CHAIN_ID = 224422

export const CONTRACT_ADDRESSES = {
  base: {
    chainId: BASE_MAINNET_CHAIN_ID,
    aaFactory: BEAMIO_AA_FACTORY,
    cardFactory: BASE_CARD_FACTORY,
    ccsaCard: BASE_CCSA_CARD_ADDRESS,
    baseTreasury: BASE_TREASURY,
    conetTreasury: CONET_TREASURY,
    usdc: USDC_BASE,
  },
  conet: {
    chainId: CONET_MAINNET_CHAIN_ID,
    aaFactory: CONET_AA_FACTORY,
    cardFactory: CONET_CARD_FACTORY,
    defaultUserCard: CONET_BEAMIO_USER_CARD_DEFAULT,
    usdc: CONET_USDC,
    bUint: CONET_BUINT,
    bUnitAirdrop: CONET_BUNIT_AIRDROP_ADDRESS,
    buintRedeemAirdrop: CONET_BUINT_REDEEM_AIRDROP,
    conetTreasury: CONET_TREASURY,
    beamioIndexerDiamond: BEAMIO_INDEXER_DIAMOND,
    businessStartKet: CONET_BUSINESS_START_KET || undefined,
    businessStartKetRedeem: CONET_BUSINESS_START_KET_REDEEM || undefined,
    validatorDepositRedeem: CONET_VALIDATOR_DEPOSIT_REDEEM || undefined,
  },
} as const

export type ChainKey = keyof typeof CONTRACT_ADDRESSES
