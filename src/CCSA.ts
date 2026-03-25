import { ethers } from 'ethers'
import BeamioFactoryPaymasterArtifact from './ABI/BeamioUserCardFactoryPaymaster.json'
const BeamioFactoryPaymasterABI = (Array.isArray(BeamioFactoryPaymasterArtifact) ? BeamioFactoryPaymasterArtifact : (BeamioFactoryPaymasterArtifact as { abi?: unknown[] }).abi ?? []) as ethers.InterfaceAbi
import BeamioUserCardArtifact from './ABI/BeamioUserCardArtifact.json'
import { BASE_CARD_FACTORY } from './chainAddresses'
import {
  linkBeamioUserCardBytecode,
  type BeamioUserCardLibraryAddresses,
} from './linkBeamioUserCardBytecode.js'

export type { BeamioUserCardLibraryAddresses } from './linkBeamioUserCardBytecode.js'

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

/** 统一 metadata base（ERC-1155 / Base Explorer 约定）。与 Factory metadataBaseURI 一致，合约 uri() 重写为 0x{address(this)}{id}.json。 */
const BEAMIO_METADATA_BASE_URI = 'https://beamio.app/api/metadata/0x'

/** createCardCollectionWithInitCode 可能 revert 的 custom errors（Factory / Deployer / BeamioUserCard），用于解析链上返回的 data */
const CREATE_CARD_ERROR_IFACE = new ethers.Interface([
  'error DEP_NotFactory()',
  'error DEP_InvalidFactory()',
  'error DEP_NotOwner()',
  'error BM_DeployFailed()',
  'error BM_DeployFailedAtStep(uint8 step)',
  'error BM_ZeroAddress()',
  'error F_BadDeployedCard()',
  'error F_AlreadyRegistered()',
  'error UC_GlobalMisconfigured()',
  'error UC_ResolveAccountFailed(address eoa, address aaFactory, address acct)',
  'error UC_UnauthorizedGateway()',
  'error UC_RedeemModuleZero()',
])

/**
 * 解析 createCard 链上 revert 的 data，返回可读的 error 名称（及参数），便于日志定位原因。
 * 若无法解析则返回 null。
 */
function parseCreateCardRevertData(data: string | Uint8Array | undefined): string | null {
  if (data == null) return null
  const hex = typeof data === 'string' ? data : (data instanceof Uint8Array ? ethers.hexlify(data) : null)
  if (!hex || !hex.startsWith('0x') || hex.length < 10) return null
  try {
    const parsed = CREATE_CARD_ERROR_IFACE.parseError(hex)
    if (!parsed) return null
    const name = parsed.name
    const args = parsed.args
    if (args && args.length > 0) {
      return `${name}(${args.map((a: unknown) => String(a)).join(', ')})`
    }
    return name
  } catch {
    return null
  }
}

/** 当 decoded 为 BM_DeployFailed 或 BM_DeployFailedAtStep(step) 时追加的排查说明 */
function createCardRevertHint(decoded: string | null): string {
  if (decoded === 'BM_DeployFailed') {
    return (
      '【BM_DeployFailed】CREATE 失败（create 返回 0），通常为：① 卡 constructor 内 revert（如 gateway 无 code → UC_GlobalMisconfigured）；② gas 不足。' +
      '请确认 initCode 中 gateway 为当前 Factory 地址且该地址在 Base 上有 code，并确认 x402sdk 使用的 BeamioUserCardArtifact 与链上预期一致。\n'
    )
  }
  const stepMatch = decoded?.match(/^BM_DeployFailedAtStep\((\d+)\)$/)
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10)
    const stepDesc = [
      '0=CREATE 失败（OOG / EIP-170 / EIP-3860 / constructor revert）',
      '1=gateway 不匹配',
      '2=owner 不匹配',
      '3=currency 不匹配',
      '4=price 不匹配',
    ][step] ?? `step=${step}`
    return `【BM_DeployFailedAtStep】${stepDesc}。若 step=0 请查 gas、runtime/initcode 大小、constructor 参数（gateway 有 code、initialOwner 非零）。\n`
  }
  return ''
}

/**
 * 人类可读的 initCode 构造项：不传原始 initCode 时，由 createBeamioCardWithFactory 内部根据这些项组合生成。
 * - uri: BeamioUserCard 的 metadata base（合约内重写 uri() 为 0x{合约地址}{id}.json，此处仅作 constructor 占位），默认 BEAMIO_METADATA_BASE_URI
 * - gateway: 工厂/gateway 地址，默认使用当前 factory 合约地址
 */
export type CreateBeamioCardInitCodeOptions = {
  /** BeamioUserCard 的 metadata URI（constructor 占位，合约 uri() 重写为 0x{address(this)}{id}.json） */
  uri?: string
  /** 工厂（gateway）地址，默认使用传入的 factory 合约地址 */
  gateway?: string
  /** 0=按单次 topup/redeem 金额升级；1=按 points 余额；2=按累计向 admin 转账 points。constructor 固定，默认 0 */
  upgradeType?: 0 | 1 | 2
  /** true：创建时即开启 points 转账白名单（须配置 whitelist 地址）；默认 false（不限制） */
  transferWhitelistEnabled?: boolean
  /**
   * 链上已部署且与当前 BeamioUserCardArtifact 版本一致的库地址（Formatting + Transfer）。
   * 由 initCode 选项生成部署数据时必传；或直接传入完整 initCode 十六进制字符串可省略。
   */
  libraryAddresses?: BeamioUserCardLibraryAddresses
}

export type CreateBeamioCardOptions = {
  /** 工厂合约地址，默认 Base 主网 CARD_FACTORY */
  factoryAddress?: string
  /** BeamioUserCard 的 metadata URI（constructor 占位） */
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
    BeamioFactoryPaymasterABI,
    signer
  )

  const tx = await factory.createCardCollectionWithInitCode(
    cardOwner,
    currencyEnum,
    priceE6,
    initCode,
    { gasLimit: 6_000_000 }
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
  gateway: string,
  upgradeType: 0 | 1 | 2 = 0,
  initialTransferWhitelistEnabled = false,
  libraryAddresses?: BeamioUserCardLibraryAddresses
): Promise<string> {
  const fs = require('fs') as typeof import('fs')
  const raw = fs.readFileSync(artifactPath, 'utf-8')
  const artifact = JSON.parse(raw) as {
    abi: ethers.InterfaceAbi
    bytecode: string
    linkReferences?: Record<string, Record<string, unknown[]>>
  }
  if (!artifact?.bytecode) throw new Error('Artifact missing bytecode')

  let bytecode = artifact.bytecode
  const lr = artifact.linkReferences
  if (lr && Object.keys(lr).length > 0) {
    if (!libraryAddresses) {
      throw new Error(
        'BeamioUserCard artifact has linkReferences; pass libraryAddresses (BeamioUserCardFormattingLib + BeamioUserCardTransferLib) as the last argument to buildBeamioUserCardInitCode'
      )
    }
    bytecode = linkBeamioUserCardBytecode(bytecode, lr, libraryAddresses)
  }

  const factory = new ethers.ContractFactory(artifact.abi, bytecode)
  const deployTx = await factory.getDeployTransaction(
    uri,
    currencyEnum,
    pointsUnitPriceInCurrencyE6,
    initialOwner,
    gateway,
    upgradeType,
    initialTransferWhitelistEnabled
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
  gateway: string,
  upgradeType: 0 | 1 | 2,
  initialTransferWhitelistEnabled = false,
  libraryAddresses?: BeamioUserCardLibraryAddresses
): Promise<string> {
  const artifact = BeamioUserCardArtifact as {
    abi: ethers.InterfaceAbi
    bytecode: string
    linkReferences?: Record<string, Record<string, unknown[]>>
  }
  if (!artifact?.bytecode) throw new Error('BeamioUserCard artifact missing bytecode')

  let bytecode = artifact.bytecode
  const lr = artifact.linkReferences
  if (lr && Object.keys(lr).length > 0) {
    if (!libraryAddresses) {
      throw new Error(
        'BeamioUserCard requires linked libraries. Pass libraryAddresses: { BeamioUserCardFormattingLib, BeamioUserCardTransferLib } in CreateBeamioCardInitCodeOptions, or supply a pre-linked initCode hex string.'
      )
    }
    bytecode = linkBeamioUserCardBytecode(bytecode, lr, libraryAddresses)
  }

  const factory = new ethers.ContractFactory(artifact.abi, bytecode)
  const deployTx = await factory.getDeployTransaction(
    uri,
    currencyEnum,
    pointsUnitPriceInCurrencyE6,
    initialOwner,
    gateway,
    upgradeType,
    initialTransferWhitelistEnabled
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
    const uri = initCodeOrOptions.uri ?? BEAMIO_METADATA_BASE_URI
    const wlOn = initCodeOrOptions.transferWhitelistEnabled === true
    const ut = initCodeOrOptions.upgradeType
    const upgradeType: 0 | 1 | 2 = ut === 1 || ut === 2 ? ut : 0
    initCode = await buildBeamioUserCardInitCodeFromParams(
      uri,
      currencyEnum,
      priceE6,
      cardOwner,
      gateway,
      upgradeType,
      wlOn,
      initCodeOrOptions.libraryAddresses
    )
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
      initCode,
      { gasLimit: 6_000_000 }
    )
  } catch (e: unknown) {
    const err = e as { code?: string; data?: string; reason?: string; shortMessage?: string; message?: string }
    const revertData = err?.data ?? (e as { data?: string | Uint8Array }).data ?? (e as { info?: { error?: { data?: string } } }).info?.error?.data
    const decoded = parseCreateCardRevertData(revertData)
    const isCallException = err?.code === 'CALL_EXCEPTION'
    const noUsefulReason = !decoded && (err?.shortMessage === 'missing revert data' || !err?.reason || (err?.message && err.message.includes('unknown custom error')))
    if (isCallException && (noUsefulReason || decoded)) {
      const reasonLine = decoded ? `链上 revert: ${decoded}` : 'RPC 未返回具体原因'
      const dataStr = revertData != null ? (typeof revertData === 'string' ? revertData : ethers.hexlify(revertData)) : ''
      const hint = createCardRevertHint(decoded)
      throw new Error(
        `createCardCollectionWithInitCode 链上执行 revert（${reasonLine}）。常见原因：\n` +
          '  1) Deployer 未配置：工厂使用的 Deployer 合约需由其 owner 调用 setFactory(工厂地址)。运行 npm run check:createcard-deployer:base 诊断，修复：npm run set:card-deployer-factory:base\n' +
          '  2) 新卡 constructor revert：例如 gateway 地址无 code（UC_GlobalMisconfigured）；\n' +
          '  3) 工厂校验失败：部署后 factoryGateway/owner/currency/price 与传入不一致（F_BadDeployedCard）。\n' +
          (hint ? hint : '') +
          (dataStr ? `原始 data（前 74 字符）: ${dataStr.slice(0, 74)}${dataStr.length > 74 ? '...' : ''}\n` : '') +
          (dataStr ? `rawRevertDataForRpc=${dataStr}\n` : '') +
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

/** Tier 结构（与 BeamioUserCard.Tier 一致） */
export type CreateCardTier = {
  minUsdc6: bigint | string
  attr: number
  tierExpirySeconds?: number | bigint
}

/** 同 createBeamioCardWithFactory，但返回 { cardAddress, hash } 供 daemon 回传 tx hash 给 UI。可选 tiers 时使用 createCardCollectionWithInitCodeAndTiers 一次性部署+配置 */
export async function createBeamioCardWithFactoryReturningHash(
  factory: ethers.Contract,
  cardOwner: string,
  currency: ICurrency,
  pointsUnitPriceInCurrencyE6: number | bigint,
  initCodeOrOptions: string | CreateBeamioCardInitCodeOptions,
  tiers?: CreateCardTier[]
): Promise<{ cardAddress: string; hash: string }> {
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
    const uri = initCodeOrOptions.uri ?? BEAMIO_METADATA_BASE_URI
    const wlOn = initCodeOrOptions.transferWhitelistEnabled === true
    const ut2 = initCodeOrOptions.upgradeType
    const upgradeType2: 0 | 1 | 2 = ut2 === 1 || ut2 === 2 ? ut2 : 0
    initCode = await buildBeamioUserCardInitCodeFromParams(
      uri,
      currencyEnum,
      priceE6,
      cardOwner,
      gateway,
      upgradeType2,
      wlOn,
      initCodeOrOptions.libraryAddresses
    )
  }

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
    }
  }

  const tiersArray = tiers && tiers.length > 0
    ? tiers.map((t) => ({
        minUsdc6: BigInt(t.minUsdc6),
        attr: t.attr,
        tierExpirySeconds: BigInt(t.tierExpirySeconds ?? 0),
      }))
    : []

  let tx: ethers.ContractTransactionResponse
  try {
    if (tiersArray.length > 0) {
      tx = await factory.createCardCollectionWithInitCodeAndTiers(
        cardOwner,
        currencyEnum,
        priceE6,
        initCode,
        tiersArray,
        { gasLimit: 8_000_000 }
      )
    } else {
      tx = await factory.createCardCollectionWithInitCode(
        cardOwner,
        currencyEnum,
        priceE6,
        initCode,
        { gasLimit: 6_000_000 }
      )
    }
  } catch (e: unknown) {
    const err = e as { code?: string; data?: string; reason?: string; shortMessage?: string; message?: string }
    const revertData = err?.data ?? (e as { data?: string | Uint8Array }).data ?? (e as { info?: { error?: { data?: string } } }).info?.error?.data
    const decoded = parseCreateCardRevertData(revertData)
    const isCallException = err?.code === 'CALL_EXCEPTION'
    const noUsefulReason = !decoded && (err?.shortMessage === 'missing revert data' || !err?.reason || (err?.message && err.message.includes('unknown custom error')))
    if (isCallException && (noUsefulReason || decoded)) {
      const reasonLine = decoded ? `链上 revert: ${decoded}` : 'RPC 未返回具体原因'
      const dataStr = revertData != null ? (typeof revertData === 'string' ? revertData : ethers.hexlify(revertData)) : ''
      const hint = createCardRevertHint(decoded)
      throw new Error(
        `createCardCollectionWithInitCode 链上执行 revert（${reasonLine}）。常见原因：\n` +
          '  1) Deployer 未配置：工厂使用的 Deployer 合约需由其 owner 调用 setFactory(工厂地址)。运行 npm run check:createcard-deployer:base 诊断，修复：npm run set:card-deployer-factory:base\n' +
          '  2) 新卡 constructor revert：例如 gateway 地址无 code（UC_GlobalMisconfigured）；\n' +
          '  3) 工厂校验失败：部署后 factoryGateway/owner/currency/price 与传入不一致（F_BadDeployedCard）。\n' +
          (hint ? hint : '') +
          (dataStr ? `原始 data（前 74 字符）: ${dataStr.slice(0, 74)}${dataStr.length > 74 ? '...' : ''}\n` : '') +
          (dataStr ? `rawRevertDataForRpc=${dataStr}\n` : '') +
          `原始错误: ${err?.shortMessage ?? err?.message ?? String(e)}`
      )
    }
    throw e
  }
  const hash = tx.hash
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
  return { cardAddress: ethers.getAddress(cardAddress), hash }
}

