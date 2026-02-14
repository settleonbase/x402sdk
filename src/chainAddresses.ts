/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0xD86403DD1755F7add19540489Ea10cdE876Cc1CE'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 config/base-addresses.ts 一致。
 */
export const BASE_CARD_FACTORY = '0xbDC8a165820bB8FA23f5d953632409F73E804eE5'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 与 SilentPassUI config/chainAddresses.ts BeamioCardCCSA_ADDRESS 必须一致；重发卡后运行 replace-ccsa-address.js 同步两处。
 */
export const BASE_CCSA_CARD_ADDRESS = '0xb6ba88045F854B713562fb7f1332D186df3B25A8'
