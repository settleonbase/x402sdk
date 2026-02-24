/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0xD86403DD1755F7add19540489Ea10cdE876Cc1CE'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 config/base-addresses.ts 一致。
 */
export const BASE_CARD_FACTORY = '0x86879fE3fbd958f468B1e5E6Cd075a9149ADB48F'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 与 SilentPassUI config/chainAddresses.ts BeamioCardCCSA_ADDRESS 必须一致；重发卡后运行 replace-ccsa-address.js 同步两处。
 */
export const BASE_CCSA_CARD_ADDRESS = '0x6870acA2f4f6aBed6B10B0C8D76C75343398fd64'

/** CoNET 主网 BUnitAirdrop 合约地址（与 deployments/conet-BUintAirdrop.json 一致） */
export const CONET_BUNIT_AIRDROP_ADDRESS = '0x5Bf7b014190c05957cc1A84976f958674628578c'
