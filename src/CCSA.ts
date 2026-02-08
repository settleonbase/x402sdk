import { ethers } from 'ethers'
import BeamioFactoryPaymasterABI from './ABI/BeamioUserCardFactoryPaymaster.json'
import BeamioUserCardArtifact from './ABI/BeamioUserCardArtifact.json'
import { BASE_CARD_FACTORY } from './chainAddresses'

type ICurrency = 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD'

const CURRENCY_TO_ENUM: Record<ICurrency, number> = {
  CAD: 0,
  USD: 1,
  JPY: 2,
  CNY: 3,
  USDC: 4,
  HKD: 5,
  EUR: 6,
  SGD: 7,
  TWD: 8,
}

const DEFAULT_URI = 'https://api.beamio.io/metadata/{id}.json'

/**
 * 人类可读的 initCode 构造项：不传原始 initCode 时，由 createBeamioCardWithFactory 内部根据这些项组合生成。
 * - uri: BeamioUserCard 的 metadata URI，默认 DEFAULT_URI
 * - gateway: 工厂/gateway 地址，默认使用当前 factory 合约地址
 */
export type CreateBeamioCardInitCodeOptions = {
  /** BeamioUserCard 的 metadata URI，默认 https://api.beamio.io/metadata/{id}.json */
  uri?: string
  /** 工厂（gateway）地址，默认使用传入的 factory 合约地址 */
  gateway?: string
}

export type CreateBeamioCardOptions = {
  /** 工厂合约地址，默认 Base 主网 CARD_FACTORY */
  factoryAddress?: string
  /** BeamioUserCard 的 metadata URI，默认 https://api.beamio.io/metadata/{id}.json */
  uri?: string
  /** BeamioUserCard 的部署 initCode（constructor 编码 + bytecode）。可由 buildBeamioUserCardInitCode() 生成。 */
  initCode: string
}

/**
 * 为用户创建 BeamioUserCard（CCSA 卡），并返回新卡的合约地址。
 * 调用者需为工厂的 paymaster；initCode 需由 buildBeamioUserCardInitCode 或 Hardhat 脚本生成。
 */
export async function createBeamioCard(
  signer: ethers.Signer,
  cardOwner: string,
  currency: ICurrency,
  pointsUnitPriceInCurrencyE6: number | bigint,
  options: CreateBeamioCardOptions
): Promise<string> {
  if (!ethers.isAddress(cardOwner)) throw new Error('Invalid cardOwner address')
  const currencyEnum = CURRENCY_TO_ENUM[currency]
  if (currencyEnum === undefined) throw new Error(`Unsupported currency: ${currency}`)
  const priceE6 = BigInt(pointsUnitPriceInCurrencyE6)
  if (priceE6 <= 0n) throw new Error('pointsUnitPriceInCurrencyE6 must be > 0')

  const factoryAddress = options.factoryAddress ?? BASE_CARD_FACTORY
  const initCode = options.initCode
  if (!initCode || typeof initCode !== 'string' || !initCode.startsWith('0x')) {
    throw new Error('options.initCode is required (hex string, e.g. from buildBeamioUserCardInitCode)')
  }

  const factory = new ethers.Contract(
    factoryAddress,
    BeamioFactoryPaymasterABI as ethers.InterfaceAbi,
    signer
  )

  const tx = await factory.createCardCollectionWithInitCode(
    cardOwner,
    currencyEnum,
    priceE6,
    initCode
  )
  const receipt = await tx.wait()
  if (!receipt) throw new Error('Transaction failed')

  // 从 CardDeployed 事件解析新卡地址
  let cardAddress: string | undefined
  try {
    const iface = factory.interface
    const log = receipt.logs?.find((l: ethers.Log) => {
      try {
        const parsed = iface.parseLog({ topics: l.topics, data: l.data })
        return parsed?.name === 'CardDeployed'
      } catch {
        return false
      }
    }) as ethers.Log | undefined
    if (log) {
      const parsed = factory.interface.parseLog({ topics: log.topics, data: log.data })
      cardAddress = parsed?.args?.card ?? parsed?.args?.userCard
    }
  } catch {}

  if (!cardAddress) {
    const cardsOfOwner = await factory.cardsOfOwner(cardOwner)
    if (cardsOfOwner && Array.isArray(cardsOfOwner) && cardsOfOwner.length > 0) {
      cardAddress = cardsOfOwner[cardsOfOwner.length - 1]
    }
  }

  if (!cardAddress || !ethers.isAddress(cardAddress)) {
    throw new Error('Could not resolve new BeamioUserCard address from receipt')
  }
  return ethers.getAddress(cardAddress)
}

/**
 * 生成 BeamioUserCard 的部署 initCode，供 createBeamioCard 使用。
 * 在 Node 环境中传入 Hardhat 产物的 JSON 路径即可；参数与合约 constructor 一致。
 */
export async function buildBeamioUserCardInitCode(
  artifactPath: string,
  uri: string,
  currencyEnum: number,
  pointsUnitPriceInCurrencyE6: bigint,
  initialOwner: string,
  gateway: string
): Promise<string> {
  const fs = require('fs') as typeof import('fs')
  const raw = fs.readFileSync(artifactPath, 'utf-8')
  const artifact = JSON.parse(raw) as { abi: ethers.InterfaceAbi; bytecode: string }
  if (!artifact?.bytecode) throw new Error('Artifact missing bytecode')

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode)
  const deployTx = await factory.getDeployTransaction(
    uri,
    currencyEnum,
    pointsUnitPriceInCurrencyE6,
    initialOwner,
    gateway
  )
  const initCode = deployTx?.data
  if (!initCode) throw new Error('Failed to build BeamioUserCard initCode')
  return initCode
}

/** 内嵌 artifact，无需 fs，根据人类可读参数生成 BeamioUserCard 的 initCode（供 createBeamioCardWithFactory 内部使用或直接调用） */
async function buildBeamioUserCardInitCodeFromParams(
  uri: string,
  currencyEnum: number,
  pointsUnitPriceInCurrencyE6: bigint,
  initialOwner: string,
  gateway: string
): Promise<string> {
  const artifact = BeamioUserCardArtifact as { abi: ethers.InterfaceAbi; bytecode: string }
  if (!artifact?.bytecode) throw new Error('BeamioUserCard artifact missing bytecode')
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode)
  const deployTx = await factory.getDeployTransaction(
    uri,
    currencyEnum,
    pointsUnitPriceInCurrencyE6,
    initialOwner,
    gateway
  )
  const initCode = deployTx?.data
  if (!initCode) throw new Error('Failed to build BeamioUserCard initCode')
  return initCode
}



/**
 * 使用已实例化的工厂合约创建 BeamioUserCard，并返回新卡地址。
 * 第五参可为：
 * - 已编码的 initCode 字符串（hex），或
 * - 人类可读的 initCode 选项（uri、gateway），由本函数内部组合生成 initCode；gateway 默认取 factory 地址。
 */
export async function createBeamioCardWithFactory(
  factory: ethers.Contract,
  cardOwner: string,
  currency: ICurrency,
  pointsUnitPriceInCurrencyE6: number | bigint,
  initCodeOrOptions: string | CreateBeamioCardInitCodeOptions
): Promise<string> {
  if (!ethers.isAddress(cardOwner)) throw new Error('Invalid cardOwner address')
  const currencyEnum = CURRENCY_TO_ENUM[currency]
  if (currencyEnum === undefined) throw new Error(`Unsupported currency: ${currency}`)
  const priceE6 = BigInt(pointsUnitPriceInCurrencyE6)
  if (priceE6 <= 0n) throw new Error('pointsUnitPriceInCurrencyE6 must be > 0')

  let initCode: string
  if (typeof initCodeOrOptions === 'string') {
    if (!initCodeOrOptions || !initCodeOrOptions.startsWith('0x')) {
      throw new Error('initCode must be a hex string (e.g. 0x...) when passed as string')
    }
    initCode = initCodeOrOptions
  } else {
    const gateway = initCodeOrOptions.gateway ?? (typeof factory.getAddress === 'function' ? await factory.getAddress() : (factory as unknown as { address: string }).address)
    const uri = initCodeOrOptions.uri ?? DEFAULT_URI
    initCode = await buildBeamioUserCardInitCodeFromParams(uri, currencyEnum, priceE6, cardOwner, gateway)
  }

  // 调用 createCardCollectionWithInitCode 前确认 factory 的 signer 是工厂 owner（或已注册 paymaster）
  const runner = factory.runner
  if (!runner || typeof (runner as ethers.Signer).getAddress !== 'function') {
    throw new Error('Factory contract has no signer (runner). Cannot determine caller.')
  }
  const signerAddress = await (runner as ethers.Signer).getAddress()
  const factoryOwner = (await factory.owner()) as string
  const isPaymaster = typeof factory.isPaymaster === 'function' ? await factory.isPaymaster(signerAddress) : false
  const isOwner = signerAddress.toLowerCase() === factoryOwner.toLowerCase()
  if (!isOwner && !isPaymaster) {
    throw new Error(
      `Factory signer (${signerAddress}) is not the factory owner (${factoryOwner}) nor a registered paymaster. ` +
        'Only owner or paymaster can call createCardCollectionWithInitCode.'
    )
  }

  // 预检查：工厂使用的 deployer 必须已通过 setFactory(factory) 指向当前工厂，否则 deploy() 会 revert（DEP_NotFactory）
  const deployerAddr = (await factory.deployer()) as string
  if (deployerAddr && ethers.getAddress(deployerAddr) !== ethers.ZeroAddress) {
    const deployerContract = new ethers.Contract(
      deployerAddr,
      ['function factory() view returns (address)'],
      factory.runner
    )
    try {
      const deployerFactory = (await deployerContract.factory()) as string
      const thisFactoryAddr = await factory.getAddress()
      if (deployerFactory.toLowerCase() !== thisFactoryAddr.toLowerCase()) {
        throw new Error(
          `Factory 使用的 Deployer (${deployerAddr}) 未指向当前工厂 (${thisFactoryAddr})。` +
            '请由 Deployer 的 owner 调用 setFactory(工厂地址) 后再发卡。'
        )
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('未指向当前工厂')) throw e
      // deployer 无 factory() 或调用失败时忽略，交给后续链上调用失败时的统一提示
    }
  }

  let tx: ethers.ContractTransactionResponse
  try {
    tx = await factory.createCardCollectionWithInitCode(
      cardOwner,
      currencyEnum,
      priceE6,
      initCode
    )
  } catch (e: unknown) {
    const err = e as { code?: string; data?: string; reason?: string; shortMessage?: string; message?: string }
    if (err?.code === 'CALL_EXCEPTION' && (err?.shortMessage === 'missing revert data' || !err?.reason)) {
      throw new Error(
        'createCardCollectionWithInitCode 链上执行 revert（RPC 未返回具体原因）。常见原因：\n' +
          '  1) Deployer 未配置：工厂使用的 Deployer 合约需由其 owner 调用 setFactory(工厂地址)；\n' +
          '  2) 新卡 constructor revert：例如 gateway 地址无 code（UC_GlobalMisconfigured）；\n' +
          '  3) 工厂校验失败：部署后 factoryGateway/owner/currency/price 与传入不一致（F_BadDeployedCard）。\n' +
          `原始错误: ${err?.shortMessage ?? err?.message ?? String(e)}`
      )
    }
    throw e
  }
  const receipt = await tx.wait()
  if (!receipt) throw new Error('Transaction failed')

  let cardAddress: string | undefined
  try {
    const iface = factory.interface
    const log = receipt.logs?.find((l: ethers.Log) => {
      try {
        const parsed = iface.parseLog({ topics: l.topics, data: l.data })
        return parsed?.name === 'CardDeployed'
      } catch {
        return false
      }
    }) as ethers.Log | undefined
    if (log) {
      const parsed = factory.interface.parseLog({ topics: log.topics, data: log.data })
      cardAddress = parsed?.args?.card ?? parsed?.args?.userCard
    }
  } catch {}

  if (!cardAddress) {
    const cardsOfOwner = await factory.cardsOfOwner(cardOwner)
    if (cardsOfOwner && Array.isArray(cardsOfOwner) && cardsOfOwner.length > 0) {
      cardAddress = cardsOfOwner[cardsOfOwner.length - 1]
    }
  }

  if (!cardAddress || !ethers.isAddress(cardAddress)) {
    throw new Error('Could not resolve new BeamioUserCard address from receipt')
  }
  return ethers.getAddress(cardAddress)
}

