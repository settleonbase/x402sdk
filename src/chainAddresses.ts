/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0xD86403DD1755F7add19540489Ea10cdE876Cc1CE'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 config/base-addresses.ts 一致。
 */
export const BASE_CARD_FACTORY = '0x331a8ebc41afbAf01D78Fd2684D609407527DA18'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 与 SilentPassUI config/chainAddresses.ts BeamioCardCCSA_ADDRESS 必须一致；重发卡后运行 replace-ccsa-address.js 同步两处。
 */
export const BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'

/**
 * Base 主网基础设施卡地址（BeamioUserCard 实例）。
 * 与服务端 getWalletAssets/getUIDAssets 的基础设施卡查询保持一致。
 */
export const BEAMIO_USER_CARD_ASSET_ADDRESS = '0xa86a8406B06bD6c332b4b380A0EAced822218Eff'

/**
 * CoNET BUnit Airdrop 合约地址（用于 claimBUnits）。
 */
export const CONET_BUNIT_AIRDROP_ADDRESS = '0x36dEc4b91ee3b9a0cF0F6f0df47955745Eae4a30'

/**
 * CoNET 主网 MerchantPOSManagement 合约地址（商家 POS 终端登记/删除）。
 */
export const MERCHANT_POS_MANAGEMENT_CONET = '0x3Eb57035d3237Fce4b1cB273662E875EdfA0D54f'
