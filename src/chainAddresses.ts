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
export const CONET_BUINT = '0x9149433F154C508d2a04454b8E527A479C6fd254'
export const CONET_BUNIT_AIRDROP_ADDRESS = '0x67d01e0E9c859A89def4098aC7803f04BF0d77af'
/** BuintRedeemAirdrop（CoNET）；与 deployments/conet-addresses.json 同步 */
export const CONET_BUINT_REDEEM_AIRDROP = '0x05a19aA5100B9F6C22446cCD801F010Dc42D25E5'
export const BEAMIO_INDEXER_DIAMOND = '0xd764eBA64536cFF1bbE7e7c7Bbc90F35620f72a9'
export const MERCHANT_POS_MANAGEMENT_CONET = '0x74140e0C8118889538da8625Fc96Aac6B1342AE5'
/** CoNET BeamioOracle；与 deployments/conet-addresses.json `beamioOracle` 同步 */
export const CONET_BEAMIO_ORACLE = '0x102E9FBE87a28BaC10ADbc0E67a2b0385C8Bd0E9'
/** Base BeamioOracle */
export const BASE_BEAMIO_ORACLE = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'

/**
 * BusinessStartKet ERC-1155（CoNET）。与 deployments/conet-addresses.json `BusinessStartKet` 同步。
 * 未部署时留空串；可用环境变量 CONET_BUSINESS_START_KET 覆盖（便于未提交地址前的本地联调）。
 */
export const CONET_BUSINESS_START_KET = '0x61A206aD8fFdBA847fCB92eB8EE4bfAa2546249D'

/**
 * BusinessStartKetRedeem（CoNET）。与 deployments/conet-addresses.json `BusinessStartKetRedeem` 同步。
 * 环境变量 CONET_BUSINESS_START_KET_REDEEM 可覆盖。
 */
export const CONET_BUSINESS_START_KET_REDEEM = '0x980340A8Eb23117b624b1f037b8a489F54C7b6a5'

export const BASE_MAINNET_FACTORIES = {
  AA_FACTORY: BASE_AA_FACTORY,
  BEAMIO_ACCOUNT_DEPLOYER: BASE_BEAMIO_ACCOUNT_DEPLOYER,
  CARD_FACTORY: BASE_CARD_FACTORY,
  BeamioCardCCSA_ADDRESS: BASE_CCSA_CARD_ADDRESS,
} as const

/** CoNET 主网 chainId（BUnitAirdrop / consumeFromUser / 独立 BUint  indexer 记账） */
export const CONET_MAINNET_CHAIN_ID = 224422

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
    bUint: CONET_BUINT,
    bUnitAirdrop: CONET_BUNIT_AIRDROP_ADDRESS,
    buintRedeemAirdrop: CONET_BUINT_REDEEM_AIRDROP,
    beamioIndexerDiamond: BEAMIO_INDEXER_DIAMOND,
    businessStartKet: CONET_BUSINESS_START_KET || undefined,
    businessStartKetRedeem: CONET_BUSINESS_START_KET_REDEEM || undefined,
  },
} as const

export type ChainKey = keyof typeof CONTRACT_ADDRESSES
