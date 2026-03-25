/**
 * x402sdk 是独立项目，发布/构建时不能跨项目相对引用 BeamioContract 根仓配置。
 * 本文件必须保持自包含，地址由同步脚本或手工更新。
 */
export const BASE_MAINNET_CHAIN_ID = 8453

export const BASE_AA_FACTORY = '0x4b31D6a05Cdc817CAc1B06369555b37a5b182122'
/** BeamioAccountDeployer（与 config/base-addresses.json BEAMIO_ACCOUNT_DEPLOYER 同步） */
export const BASE_BEAMIO_ACCOUNT_DEPLOYER = '0x139D55591A03550259AF32097A9848ECE9869C90'
export const BASE_CARD_FACTORY = '0xfB5E3F2AbFe24DC17970d78245BeF56aAE8cb71a'
/**
 * createCardCollectionWithInitCode(address,uint8,uint256,bytes)
 * 必须与 Base 上 CARD_FACTORY 部署一致；编码时请用完整 Factory ABI（Interface），勿手写旧 selector。
 * 历史错误 calldata 前缀 0x9a7eb0f0 在链上工厂中已不存在，会导致整笔 revert。
 */
export const FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_SELECTOR = '0xef759095' as const
/** BeamioUserCardFormattingLib 部署地址（发卡 initCode 链接用）。空串时可用环境变量 BEAMIO_USER_CARD_FORMATTING_LIB */
export const BASE_BEAMIO_USER_CARD_FORMATTING_LIB = '0x4F2D7Afaa0b1cfd1833C0fA637C80F9B54fF8fca'
/** BeamioUserCardTransferLib 部署地址。空串时可用环境变量 BEAMIO_USER_CARD_TRANSFER_LIB */
export const BASE_BEAMIO_USER_CARD_TRANSFER_LIB = '0x75b35013063651Dd3859d97b1C17de1dD2268b6f'
export const BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
export const BASE_TREASURY = '0x5c64a8b0935DA72d60933bBD8cD10579E1C40c58'
export const BEAMIO_USER_CARD_ASSET_ADDRESS = '0x9Cda8477C9F03b8759ac64e21941e578908fd750'
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
