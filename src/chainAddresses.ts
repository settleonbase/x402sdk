/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0x4811fe90Bb3b3C5dE6491c5Efb90E19756F2C318'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 deployments/BASE_MAINNET_FACTORIES.md 一致。
 */
export const BASE_CARD_FACTORY = '0x7Ec828BAbA1c58C5021a6E7D29ccDDdB2d8D84bd'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 重新发卡后运行：NEW_CCSA_ADDRESS=0x... node scripts/replace-ccsa-address.js
 */
export const BASE_CCSA_CARD_ADDRESS = '0x1dc8c473fc67358357e90636ae8607229d5e9f92'
