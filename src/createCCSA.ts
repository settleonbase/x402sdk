/**
 * 使用 createBeamioCardWithFactory 发行一张新的 CCSA 卡。
 * 合约 createCardCollectionWithInitCode 仅要求「调用者」为工厂 owner 或 paymaster（onlyPaymaster）；
 * cardOwner（卡归属）可为任意地址，无需是工厂 owner 或 paymaster。
 *
 * 使用 Settle_ContractPool[0] 作为调用者（signer）；createBeamioCardWithFactory 会校验该 signer 是否为工厂 owner 或 paymaster。
 * 卡归属（card owner）：默认 0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61；可通过 CARD_OWNER 覆盖。
 *
 * 运行：cd src/x402sdk && npx ts-node src/createCCSA.ts
 */

import { ethers } from 'ethers'
import { Settle_ContractPool } from './MemberCard'
import { createBeamioCardWithFactory } from './CCSA'

const CARD_ISSUER_ADDRESS = '0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61'
const ONE_CAD_E6 = 1_000_000

async function main() {
  if (!Settle_ContractPool?.length) {
    throw new Error('Settle_ContractPool 为空，请确保 MemberCard 已加载（~/.master.json 中配置 base_endpoint 与 settle_contractAdmin）')
  }
  // 调用者（signer）须为工厂 owner 或 paymaster；卡归属（cardOwner）独立，可为 CARD_ISSUER_ADDRESS
  const SC = Settle_ContractPool[0]
  const factory = SC.baseFactoryPaymaster

  const cardOwner = process.env.CARD_OWNER
    ? ethers.getAddress(process.env.CARD_OWNER)
    : ethers.getAddress(CARD_ISSUER_ADDRESS)

  const factoryAddr = await factory.getAddress()
  const factoryOwner = (await factory.owner()) as string
  console.log('Creating CCSA card...')
  console.log('  Factory:', factoryAddr)
  console.log('  Factory owner:', factoryOwner)
  console.log('  Caller/signer (must be owner or paymaster):', SC.walletBase.address)
  console.log('  Card owner (cardOwner, can be any address):', cardOwner)
  console.log('  Currency: CAD, Unit price: 1 token = 1 CAD (pointsUnitPriceInCurrencyE6 = 1e6)')

  const cardAddress = await createBeamioCardWithFactory(
    factory,
    cardOwner,
    'CAD',
    ONE_CAD_E6,
    {}
  )

  console.log('CCSA card created:', cardAddress)
  console.log('From repo root, update address: NEW_CCSA_ADDRESS=' + cardAddress + ' node scripts/replace-ccsa-address.js')
}

main().catch((e: Error) => {
  console.error(e)
  process.exit(1)
})
