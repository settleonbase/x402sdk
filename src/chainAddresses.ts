/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0xD86403DD1755F7add19540489Ea10cdE876Cc1CE'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 config/base-addresses.ts 一致。
 */
export const BASE_CARD_FACTORY = '0xDdD5c17E549a4e66ca636a3c528ae8FAebb8692b'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 与 SilentPassUI config/chainAddresses.ts BeamioCardCCSA_ADDRESS 必须一致；重发卡后运行 replace-ccsa-address.js 同步两处。
 */
export const BASE_CCSA_CARD_ADDRESS = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'

/**
 * Base 主网基础设施卡地址（BeamioUserCard 实例）。
 * 与服务端 getWalletAssets/getUIDAssets 的基础设施卡查询保持一致。
 */
export const BEAMIO_USER_CARD_ASSET_ADDRESS = '0xB7644DDb12656F4854dC746464af47D33C206F0E'

/**
 * CoNET BUnit Airdrop 合约地址（用于 claimBUnits）。
 */
export const CONET_BUNIT_AIRDROP_ADDRESS = '0x5Bf7b014190c05957cc1A84976f958674628578c'
