/**
 * x402sdk 是独立项目，发布/构建时不能跨项目相对引用 BeamioContract 根仓配置。
 * 本文件必须保持自包含，地址由同步脚本或手工更新。
 */
export const BASE_MAINNET_CHAIN_ID = 8453

export const BASE_AA_FACTORY = '0x4b31D6a05Cdc817CAc1B06369555b37a5b182122'
/** BeamioAccountDeployer（与 config/base-addresses.json BEAMIO_ACCOUNT_DEPLOYER 同步） */
export const BASE_BEAMIO_ACCOUNT_DEPLOYER = '0x139D55591A03550259AF32097A9848ECE9869C90'
/**
 * Base card factory (createCard / factoryGateway / EIP-712 domain verifyingContract).
 * Aligned with deployments/base-UserCardFactory-DEBUG.json (createCard succeeds; prod factory still reverts on same initCode).
 * Previous prod: 0xfB5E3F2AbFe24DC17970d78245BeF56aAE8cb71a — see DEBUG json `productionFactoryReference`.
 */
export const BASE_CARD_FACTORY = '0x2EB245646de404b2Dce87E01C6282C131778bb05'
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
export const BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
export const BASE_TREASURY = '0x5c64a8b0935DA72d60933bBD8cD10579E1C40c58'
export const BEAMIO_USER_CARD_ASSET_ADDRESS = '0xA756F2E27a332d6Be2d399dA543E3Ce4C8455F14'
export const PURCHASING_CARD_METADATA_ADDRESS = '0xf99018DfFdb0c5657C93ca14DB2900CEbe1168A7'
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export const CONET_BUNIT_AIRDROP_ADDRESS = '0xa7410a532544aB7d1bA70701D9D0E389e4f4Cc1F'
export const BEAMIO_INDEXER_DIAMOND = '0xd990719B2f05ccab4Acdd5D7A3f7aDfd2Fc584Fe'
export const MERCHANT_POS_MANAGEMENT_CONET = '0x3Eb57035d3237Fce4b1cB273662E875EdfA0D54f'

export const BASE_MAINNET_FACTORIES = {
  AA_FACTORY: BASE_AA_FACTORY,
  BEAMIO_ACCOUNT_DEPLOYER: BASE_BEAMIO_ACCOUNT_DEPLOYER,
  CARD_FACTORY: BASE_CARD_FACTORY,
  BeamioCardCCSA_ADDRESS: BASE_CCSA_CARD_ADDRESS,
} as const

/** CoNET 主网 chainId（BUnitAirdrop / consumeFromUser / 独立 BUint  indexer 记账） */
export const CONET_MAINNET_CHAIN_ID = 224400

export const CONTRACT_ADDRESSES = {
  base: {
    chainId: BASE_MAINNET_CHAIN_ID,
    aaFactory: BASE_AA_FACTORY,
    beamioAccountDeployer: BASE_BEAMIO_ACCOUNT_DEPLOYER,
    cardFactory: BASE_CARD_FACTORY,
    ccsaCard: BASE_CCSA_CARD_ADDRESS,
    baseTreasury: BASE_TREASURY,
    usdc: USDC_BASE,
  },
  conet: {
    chainId: CONET_MAINNET_CHAIN_ID,
    bUnitAirdrop: CONET_BUNIT_AIRDROP_ADDRESS,
    beamioIndexerDiamond: BEAMIO_INDEXER_DIAMOND,
  },
} as const

export type ChainKey = keyof typeof CONTRACT_ADDRESSES
