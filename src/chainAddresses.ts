/**
 * Base 主网 AA Factory 地址。
 * 与 config/base-addresses.ts 保持一致；运行 npm run redeploy:aa-factory:base 后会同步更新此处。
 */
export const BASE_AA_FACTORY = '0xD4759c85684e47A02223152b85C25D2E5cD2E738'

/**
 * Base 主网 BeamioUserCard 工厂地址 (BeamioUserCardFactoryPaymasterV07)。
 * 与 config/base-addresses.ts 一致。
 */
export const BASE_CARD_FACTORY = '0x73e3b722Eb55C92Fe73DEC01c064a5C677079E03'

/**
 * Base 主网 CCSA 卡地址（BeamioUserCard 实例，1 CAD = 1 token）。
 * 重新发卡后运行：NEW_CCSA_ADDRESS=0x... node scripts/replace-ccsa-address.js
 */
export const BASE_CCSA_CARD_ADDRESS = '0xd81B78B3E3253b37B44b75E88b6965FE887721a3'
