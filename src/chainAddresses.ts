/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0xD86403DD1755F7add19540489Ea10cdE876Cc1CE'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 config/base-addresses.ts 一致。
 */
export const BASE_CARD_FACTORY = '0x19C000c00e6A2b254b39d16797930431E310BEdd'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 与 SilentPassUI config/chainAddresses.ts BeamioCardCCSA_ADDRESS 必须一致；重发卡后运行 replace-ccsa-address.js 同步两处。
 */
export const BASE_CCSA_CARD_ADDRESS = '0xA1A9f6f942dc0ED9Aa7eF5df7337bd878c2e157b'

/** CoNET 主网 BUnitAirdrop 合约地址（与 deployments/conet-BUintAirdrop.json 一致） */
export const CONET_BUNIT_AIRDROP_ADDRESS = '0x5Bf7b014190c05957cc1A84976f958674628578c'
