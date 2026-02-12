/**
 * 使用 createBeamioCardWithFactory 创建 BeamioUserCard（与 createCCSA 相同模式，供 createCard API 调试）。
 * 合约 createCardCollectionWithInitCode 仅要求「调用者」为工厂 owner 或 paymaster（onlyPaymaster）；
 * cardOwner（卡归属）可为任意地址。
 *
 * 使用 Settle_ContractPool[0] 作为调用者（signer），与 createCCSA.ts 一致。
 *
 * 运行：cd src/x402sdk && npx ts-node src/createCardCLI.ts
 * 环境变量：CARD_OWNER（必填）, CURRENCY（默认 CAD）, UNIT_PRICE_HUMAN（默认 1）
 *
 * 示例：CARD_OWNER=0xDD9219193171E96C759eFD7aAa541E414108e62C npx ts-node src/createCardCLI.ts
 */

import { ethers } from 'ethers'
import { Settle_ContractPool } from './MemberCard'
import { createBeamioCardWithFactory } from './CCSA'

const CURRENCIES = ['CAD', 'USD', 'JPY', 'CNY', 'USDC', 'HKD', 'EUR', 'SGD', 'TWD'] as const

async function main() {
  if (!Settle_ContractPool?.length) {
    throw new Error('Settle_ContractPool 为空，请确保 MemberCard 已加载（~/.master.json 中配置 base_endpoint 与 settle_contractAdmin）')
  }

  const cardOwnerRaw = process.env.CARD_OWNER?.trim()
  if (!cardOwnerRaw || !ethers.isAddress(cardOwnerRaw)) {
    console.error('请设置 CARD_OWNER（有效地址）')
    process.exit(1)
  }

  const cardOwner = ethers.getAddress(cardOwnerRaw)
  const currency = (process.env.CURRENCY || 'CAD') as (typeof CURRENCIES)[number]
  if (!CURRENCIES.includes(currency)) {
    console.error('CURRENCY 须为:', CURRENCIES.join(', '))
    process.exit(1)
  }

  const unitPriceHuman = parseFloat(process.env.UNIT_PRICE_HUMAN || '1')
  if (!Number.isFinite(unitPriceHuman) || unitPriceHuman <= 0) {
    console.error('UNIT_PRICE_HUMAN 须为 > 0')
    process.exit(1)
  }
  const priceInCurrencyE6 = BigInt(Math.round(unitPriceHuman * 1_000_000))

  const SC = Settle_ContractPool[0]
  const factory = SC.baseFactoryPaymaster

  const factoryAddr = await factory.getAddress()
  const factoryOwner = (await factory.owner()) as string

  console.log('Creating BeamioUserCard...')
  console.log('  Factory:', factoryAddr)
  console.log('  Factory owner:', factoryOwner)
  console.log('  Caller/signer (must be owner or paymaster):', SC.walletBase.address)
  console.log('  Card owner:', cardOwner)
  console.log('  Currency:', currency)
  console.log('  Unit price (human):', unitPriceHuman, '→ priceInCurrencyE6:', priceInCurrencyE6.toString())

  const cardAddress = await createBeamioCardWithFactory(factory, cardOwner, currency, priceInCurrencyE6, {})

  console.log('Card created:', cardAddress)
}

main().catch((e: Error) => {
  console.error(e)
  process.exit(1)
})
