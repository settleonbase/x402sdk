/**
 * x402sdk 是独立项目，发布/构建时不能跨项目相对引用 BeamioContract 根仓配置。
 * 本文件必须保持自包含，地址由同步脚本或手工更新。
 */
export const BASE_MAINNET_CHAIN_ID = 8453

/** CoNET PoS HTTP RPC；与 deployments/conet-addresses.json `rpcUrl` 同步 */
export const CONET_RPC_URL = 'https://publicrpc.conet.network'

/** BeamioFactoryPaymasterV07 on Base. Keep API on the existing Base factory until Base AA flows are enabled. */
export const BEAMIO_AA_FACTORY = '0xe58F457Cd5674516400013E8d338054be556A730'

/** @deprecated 使用 BEAMIO_AA_FACTORY（跨链同址） */
export const BASE_AA_FACTORY = BEAMIO_AA_FACTORY
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
/** @deprecated 废弃全局 CCSA 卡；API/客户端不得扫描或展示。见 apiExcludedUserCards.ts 与 beamio-no-legacy-global-cards.mdc */
export const BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
export const BASE_TREASURY = '0x5c64a8b0935DA72d60933bBD8cD10579E1C40c58'
/** @deprecated 废弃全局 CashTrees 卡；API/客户端不得作为默认商户卡。见 apiExcludedUserCards.ts 与 beamio-no-legacy-global-cards.mdc */
export const BEAMIO_USER_CARD_ASSET_ADDRESS = '0xB7644DDb12656F4854dC746464af47D33C206F0E'
export const PURCHASING_CARD_METADATA_ADDRESS = '0xf99018DfFdb0c5657C93ca14DB2900CEbe1168A7'
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** CoNET BUint ERC20（balanceOfAll）；与 deployments/conet-addresses.json `BUint` 同步 */
export const CONET_BUINT = '0xa354CC4c414568Dd14F6d63b53013f35483427f0'
export const CONET_BUNIT_AIRDROP_ADDRESS = '0xb9cf45AF87b16853c8F48a16b0495F030309e70f'
/** BuintRedeemAirdrop（CoNET）；与 deployments/conet-addresses.json 同步 */
export const CONET_BUINT_REDEEM_AIRDROP = '0x02e954D352EB4C687AB066f0967E35D41E7721b6'
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
export const CONET_BUSINESS_START_KET_REDEEM = '0xe9CeDC2c9F7DE7c0e6d1f1ba1F7e7126F0F1D3c8'

/** ValidatorDepositRedeem（CoNET）；与 deployments/conet-addresses.json `ValidatorDepositRedeem` 同步 */
export const CONET_VALIDATOR_DEPOSIT_REDEEM = '0x7001c3637CE602aB10DE113A12aD09bD7B3Ce457'
/** ValidatorDepositRedeem deploy block（CoNET）；listener 补扫下限，不得低于此块 */
export const CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK = 172334
export const CONET_DEPOSIT_CONTRACT = '0x4242424242424242424242424242424242424242'
export const CONET_VALIDATOR_DEPOSIT_FUNDER = '0x0981275553A41E00ec1006fe074971285E00c2A3'
/** ValidatorDepositRedeem contract admin (withdrawNative only; not redeem admin). Sync from deployments/conet-ValidatorDepositRedeem.json */
export const CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN = '0x87cAeD4e51C36a2C2ece3Aaf4ddaC9693d2405E1'
/** ValidatorDepositRedeem redeem admin on validator node 38.102.85.33 (~/.master.json key_38.102.85.33) */
export const CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN = '0xE974c5d10cc36738bC2619FC73b075504D5c6d1E'
export const CONET_VALIDATOR_NODE_IP = ''
/** ValidatorNodeRewardIndexer（CoNET）：每节点/每受益人小时原子 CNET 收益账本 + 周期统计；
 *  与 deployments/conet-addresses.json `ValidatorNodeRewardIndexer` 同步。留空则由主合约 rewardIndexer() 解析。 */
export const CONET_VALIDATOR_NODE_REWARD_INDEXER = '0x76C316e1A0ed1f11819c3eBa04C77eFD30056553'
/** ValidatorDepositRedeemReferrerExtension（CoNET）；与 deployments/conet-addresses.json 同步 */
export const CONET_VALIDATOR_REFERRER_EXTENSION = '0x06AFcf64be6045EB42178970A2099a48e4f65086'

export const BASE_MAINNET_FACTORIES = {
  AA_FACTORY: BEAMIO_AA_FACTORY,
  CARD_FACTORY: BASE_CARD_FACTORY,
  BeamioCardCCSA_ADDRESS: BASE_CCSA_CARD_ADDRESS,
} as const

/** CoNET UserCard Factory（224422）；与 deployments/conet-addresses.json `CARD_FACTORY` 同步 */
export const CONET_CARD_FACTORY = '0xfA52a0CcC96C19cF4b6Ea864615F6d52BD0774FB'
/** CoNET EntryPoint-aware BeamioFactoryPaymasterV07（224422）；与 deployments/conet-addresses.json `AA_FACTORY` 同步 */
export const CONET_AA_FACTORY = '0x869B31C87ABd9bFB858F5183Ef6021b28ED225E2'
/** CoNET Factory ExecuteLib（linked library） */
export const CONET_BEAMIO_USER_CARD_FACTORY_EXECUTE_LIB = '0xbc6f3926691d2306c96357ac08aadB5F50Ab0784'
/** CoNET 默认 BeamioUserCard（AA Factory `beamioUserCard`） */
export const CONET_BEAMIO_USER_CARD_DEFAULT = '0xA5C727d11d04BeBC095bd814c6530c4e77fD6662'
/** CoNET USDC（ConetTreasury `FactoryERC20`）；UserCard Factory `USDC_TOKEN` */
export const CONET_USDC = '0x2975c85D8Cc8F5d263492E332A6dAa7ad11aDBdC'
/** CoNET GB ERC1155（ConetGB1155）；id=0 为累计净 GB（18 decimals） */
export const CONET_GB1155 = '0x3Dc53e528d45225e8F38c391Cc6a72CDec435748'
/** CoNET GB total（ConetGB_total，1155 净额聚合） */
export const CONET_GB_TOTAL = '0x949ed49faB0e999f685f16e09Cf5EaaF4090F290'
/** CoNET GuardianNodesInfoV6 — DePIN 节点 IP ↔ 运营钱包；与 deployments/conet-addresses.json 同步 */
export const CONET_GUARDIAN_NODES_INFO_V6 = '0xBC6b53065b5647261396d002bDBA0d3396E0722f'
export const CONET_BEAMIO_USER_CARD_FORMATTING_LIB = '0x9727136BC5DAA5540e7397C9086e9980EBDD0e48'
export const CONET_BEAMIO_USER_CARD_TRANSFER_LIB = '0xBcf3f8C5994B02B89fB743e1dee6AFDD5a49a664'
export const CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB = '0xeB18B18133cdc45fb098220ffa5B40228d0d6dA0'
export const CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB = '0xf56CbEc0e95699E96a63984c8f9A5eB6926E6Dd9'
export const CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB = '0x70d9CD47610632c8c3e2e73929FaE9c9a10FBf2D'
export const CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB = '0xF1BBd4fc1d4eceC3267a8Acb843414497f4D1215'
export const CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB = '0x0aC12b8021265fA4b429D33afc962e55ADd027b7'
export const CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB = '0x92220232F259AdB08f430Ee7B3d04767b198CF88'
export const CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB = '0x9016cB5162872D183c49EfD7Ab7033408fCCC14E'
export const CONET_BEAMIO_USER_CARD_REFERRER_LIB = '0xE7bA8F84D25B6c790216F2f491B947a6fc5eFC50'
export const CONET_BEAMIO_USER_CARD_UPDATE_LIB = '0x0dd2F946D14b5b49F117cB3Ad5c35B72c1761b48'
export const CONET_BEAMIO_USER_CARD_VIEWS_LIB = '0xeeE65DD61EB2D1188508e298b4B956EDfB82f9C6'
export const CONET_REFERRER_REGISTRY_LIB = '0x3CC7ddD8e8F9711C4fcdA68191A6A88304E6B3CA'

/** CoNET 主网 chainId（BUnitAirdrop / consumeFromUser / 独立 BUint indexer 记账） */
export const CONET_MAINNET_CHAIN_ID = 224422

export const CONTRACT_ADDRESSES = {
  base: {
    chainId: BASE_MAINNET_CHAIN_ID,
    aaFactory: BEAMIO_AA_FACTORY,
    cardFactory: BASE_CARD_FACTORY,
    ccsaCard: BASE_CCSA_CARD_ADDRESS,
    baseTreasury: BASE_TREASURY,
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
    beamioIndexerDiamond: BEAMIO_INDEXER_DIAMOND,
    businessStartKet: CONET_BUSINESS_START_KET || undefined,
    businessStartKetRedeem: CONET_BUSINESS_START_KET_REDEEM || undefined,
    validatorDepositRedeem: CONET_VALIDATOR_DEPOSIT_REDEEM || undefined,
  },
} as const

export type ChainKey = keyof typeof CONTRACT_ADDRESSES
