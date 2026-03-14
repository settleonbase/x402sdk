/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0xD86403DD1755F7add19540489Ea10cdE876Cc1CE'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 config/base-addresses.ts 一致。
 */
export const BASE_CARD_FACTORY = '0x2F45f38f2B6EF97b606ec2557E237529e8db9281'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 与 SilentPassUI config/chainAddresses.ts BeamioCardCCSA_ADDRESS 必须一致；重发卡后运行 replace-ccsa-address.js 同步两处。
 */
export const BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'

/**
 * Base 主网 BaseTreasury：USDC 购买 B-Unit，用户 EIP-3009 签字后由服务端提交 purchaseBUnitWith3009Authorization。
 */
export const BASE_TREASURY = '0x5c64a8b0935DA72d60933bBD8cD10579E1C40c58'

/**
 * Base 主网基础设施卡地址（BeamioUserCard 实例）。
 * 与服务端 getWalletAssets/getUIDAssets 的基础设施卡查询保持一致。
 */
export const BEAMIO_USER_CARD_ASSET_ADDRESS = '0xB7644DDb12656F4854dC746464af47D33C206F0E'

/**
 * 购买卡时用于获取 metadata 的发行卡地址（卡名、tiers 等展示信息从此卡获取）。
 */
export const PURCHASING_CARD_METADATA_ADDRESS = '0xf99018dffdb0c5657c93ca14db2900cebe1168a7'

/**
 * CoNET BUnit Airdrop 合约地址（用于 claimBUnits）。来自 deployments/conet-addresses.json
 */
export const CONET_BUNIT_AIRDROP_ADDRESS = '0xa7410a532544aB7d1bA70701D9D0E389e4f4Cc1F'

/**
 * CoNET 主网 MerchantPOSManagement 合约地址（商家 POS 终端登记/删除）。
 */
export const MERCHANT_POS_MANAGEMENT_CONET = '0x3Eb57035d3237Fce4b1cB273662E875EdfA0D54f'
