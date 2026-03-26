import { ethers } from 'ethers'
import BeamioFactoryPaymasterArtifact from './ABI/BeamioUserCardFactoryPaymaster.json'
const BeamioFactoryPaymasterABI = (Array.isArray(BeamioFactoryPaymasterArtifact) ? BeamioFactoryPaymasterArtifact : (BeamioFactoryPaymasterArtifact as { abi?: unknown[] }).abi ?? []) as ethers.InterfaceAbi
import BeamioUserCardArtifact from './ABI/BeamioUserCardArtifact.json'
import {
  BASE_BEAMIO_USER_CARD_FORMATTING_LIB,
  BASE_BEAMIO_USER_CARD_TRANSFER_LIB,
  BASE_CARD_FACTORY,
} from './chainAddresses'
import {
  linkBeamioUserCardBytecode,
  type BeamioUserCardLibraryAddresses,
} from './linkBeamioUserCardBytecode.js'
import { emitCreateCardChainTrace } from './createCardChainTrace'

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
  'error UC_TierMinZero()',
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
 * - gateway: 若传入且与 factory 地址不一致会被忽略并告警；initCode 内 gateway 始终为当前 factory（链上 factoryGateway 必须与 msg.sender 工厂一致）。
 */
export type CreateBeamioCardInitCodeOptions = {
  /** BeamioUserCard 的 metadata URI（constructor 占位，合约 uri() 重写为 0x{address(this)}{id}.json） */
  uri?: string
  /** 已废弃/忽略：gateway 强制为 factory.getAddress()，勿传其它地址以免 BM_DeployFailedAtStep(1) */
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

function isConfiguredLibAddress(s: string | undefined): s is string {
  return typeof s === 'string' && s.startsWith('0x') && s.length === 42
}

/** EIP-55 or all-lowercase hex; if checksum fails, retry with lowercase (constants/env typos). */
function tryNormalizeLibAddress(s: string | undefined): string | undefined {
  if (!s?.trim()) return undefined
  const t = s.trim()
  try {
    return ethers.getAddress(t)
  } catch {
    try {
      return ethers.getAddress(t.toLowerCase())
    } catch {
      return undefined
    }
  }
}

/**
 * 解析 BeamioUserCard 链接库地址：显式 override → 环境变量 → chainAddresses 常量。
 * SI / Master 可不传 libraryAddresses，只要已发布版本的 chainAddresses 或进程 env 已配置。
 */
/** 与 Master 失败笔对齐：gas 上限需覆盖 ~25KB initCode 的 CREATE；可用 BEAMIO_CREATE_CARD_GAS_LIMIT 覆盖 */
const DEFAULT_CREATE_CARD_GAS_LIMIT = 8_500_000n

function getCreateCardGasLimit(): bigint {
  const raw = typeof process !== 'undefined' ? process.env?.BEAMIO_CREATE_CARD_GAS_LIMIT?.trim() : undefined
  if (raw && /^\d+$/.test(raw)) return BigInt(raw)
  return DEFAULT_CREATE_CARD_GAS_LIMIT
}

export function resolveBeamioUserCardLibraryAddresses(
  override?: BeamioUserCardLibraryAddresses
): BeamioUserCardLibraryAddresses | undefined {
  const fmtO = override?.BeamioUserCardFormattingLib?.trim()
  const trO = override?.BeamioUserCardTransferLib?.trim()
  const fmtE =
    typeof process !== 'undefined' ? process.env?.BEAMIO_USER_CARD_FORMATTING_LIB?.trim() : undefined
  const trE = typeof process !== 'undefined' ? process.env?.BEAMIO_USER_CARD_TRANSFER_LIB?.trim() : undefined

  let fmt: string | undefined
  let tr: string | undefined
  if (fmtO) fmt = tryNormalizeLibAddress(fmtO)
  else if (fmtE) fmt = tryNormalizeLibAddress(fmtE)
  else if (isConfiguredLibAddress(BASE_BEAMIO_USER_CARD_FORMATTING_LIB)) {
    fmt = tryNormalizeLibAddress(BASE_BEAMIO_USER_CARD_FORMATTING_LIB)
  }
  if (trO) tr = tryNormalizeLibAddress(trO)
  else if (trE) tr = tryNormalizeLibAddress(trE)
  else if (isConfiguredLibAddress(BASE_BEAMIO_USER_CARD_TRANSFER_LIB)) {
    tr = tryNormalizeLibAddress(BASE_BEAMIO_USER_CARD_TRANSFER_LIB)
  }

  if (fmt && tr) {
    return { BeamioUserCardFormattingLib: fmt, BeamioUserCardTransferLib: tr }
  }
  return undefined
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
    const libs = resolveBeamioUserCardLibraryAddresses(libraryAddresses)
    if (!libs) {
      throw new Error(
        'BeamioUserCard artifact has linkReferences; pass libraryAddresses to buildBeamioUserCardInitCode, ' +
          'or set BEAMIO_USER_CARD_FORMATTING_LIB / BEAMIO_USER_CARD_TRANSFER_LIB, ' +
          'or configure BASE_BEAMIO_USER_CARD_*_LIB in chainAddresses.ts'
      )
    }
    bytecode = linkBeamioUserCardBytecode(bytecode, lr, libs)
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
    const libs = resolveBeamioUserCardLibraryAddresses(libraryAddresses)
    if (!libs) {
      throw new Error(
        'BeamioUserCard requires linked libraries. Pass libraryAddresses in CreateBeamioCardInitCodeOptions, ' +
          'or set BEAMIO_USER_CARD_FORMATTING_LIB / BEAMIO_USER_CARD_TRANSFER_LIB, ' +
          'or configure BASE_BEAMIO_USER_CARD_*_LIB in chainAddresses.ts (see BeamioContract scripts/beamioUserCardLibraries.ts). ' +
          'Alternatively supply a pre-linked initCode hex string.'
      )
    }
    bytecode = linkBeamioUserCardBytecode(bytecode, lr, libs)
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

  emitCreateCardChainTrace('CCSA.createBeamioCardWithFactory.enter', {
    cardOwner,
    currency,
    priceE6: priceE6.toString(),
  })

  let initCode: string
  let initCodeSource: 'prebuiltHex' | 'builtFromOptions'
  let gatewayUsedWhenBuilding: string | undefined
  let libraryOverrideForDebug: BeamioUserCardLibraryAddresses | undefined
  if (typeof initCodeOrOptions === 'string') {
    if (!initCodeOrOptions || !initCodeOrOptions.startsWith('0x')) {
      throw new Error('initCode must be a hex string (e.g. 0x...) when passed as string')
    }
    initCode = initCodeOrOptions
    initCodeSource = 'prebuiltHex'
  } else {
    const resolvedFactory = await resolveFactoryAddressForInitCode(factory)
    const requestedGw = initCodeOrOptions.gateway
    if (requestedGw !== undefined && ethers.getAddress(requestedGw) !== resolvedFactory) {
      console.warn(
        `[CCSA] initCodeOptions.gateway (${ethers.getAddress(requestedGw)}) ignored; using factory ${resolvedFactory} ` +
          '(BeamioUserCard.factoryGateway() must equal the factory that calls createCardCollectionWithInitCode).',
      )
    }
    const gateway = resolvedFactory
    gatewayUsedWhenBuilding = gateway
    libraryOverrideForDebug = initCodeOrOptions.libraryAddresses
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
    initCodeSource = 'builtFromOptions'
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

  const gasLimit = getCreateCardGasLimit()

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

  const createCardDebugSnap = await collectCreateCardChainDebugSnapshot(factory, initCode, {
    cardOwner,
    currencyEnum,
    priceE6,
    signerAddress,
    gasLimit,
    callKind: 'createCardCollectionWithInitCode',
    initCodeSource,
    gatewayUsedWhenBuilding,
    libraryOverride: libraryOverrideForDebug,
    rawTierCount: 0,
    normalizedTierCount: 0,
  })
  if (isVerboseCreateCardDebug()) emitCreateCardDebug('preflight', createCardDebugSnap)

  emitCreateCardChainTrace('CCSA.createBeamioCardWithFactory.beforeSendTx', {
    callKind: createCardDebugSnap.callKind,
    factoryAddress: createCardDebugSnap.factoryAddress,
    signerAddress: createCardDebugSnap.signerAddress,
    initCodeKeccak256: createCardDebugSnap.initCodeKeccak256,
    initCodeByteLength: createCardDebugSnap.initCodeByteLength,
  })

  let tx: ethers.ContractTransactionResponse
  let receipt: ethers.TransactionReceipt | null = null
  try {
    tx = await factory.createCardCollectionWithInitCode(
      cardOwner,
      currencyEnum,
      priceE6,
      initCode,
      { gasLimit: gasLimit },
    )
    receipt = await tx.wait()
    if (!receipt) throw new Error('Transaction failed')
    // Revert is often surfaced here (after mining), not on the initial send — keep in same try/catch as send.
    if (Number(receipt.status) === 0) {
      throw Object.assign(new Error('transaction execution reverted'), {
        code: 'CALL_EXCEPTION',
        shortMessage: 'transaction execution reverted',
        receipt,
      } as const)
    }
  } catch (e: unknown) {
    const err = e as { code?: string; data?: string; reason?: string; shortMessage?: string; message?: string }
    const revertData =
      err?.data ??
      (e as { data?: string | Uint8Array }).data ??
      (e as { info?: { error?: { data?: string } } }).info?.error?.data
    const decoded = parseCreateCardRevertData(revertData)
    const failSnap: CreateCardChainDebugSnapshot = {
      ...createCardDebugSnap,
      failureRpcCode: err?.code ?? null,
      failureShortMessage: err?.shortMessage ?? err?.message ?? String(e),
      parsedRevert: decoded ?? null,
    }
    emitCreateCardChainTrace('CCSA.createBeamioCardWithFactory.sendFailed', {
      failureRpcCode: failSnap.failureRpcCode,
      parsedRevert: failSnap.parsedRevert,
      initCodeKeccak256: failSnap.initCodeKeccak256,
    })
    emitCreateCardDebug('failure', failSnap)
    const isCallException = err?.code === 'CALL_EXCEPTION'
    const noUsefulReason = !decoded && (err?.shortMessage === 'missing revert data' || !err?.reason || (err?.message && err.message.includes('unknown custom error')))
    if (isCallException && (noUsefulReason || decoded)) {
      const reasonLine = decoded ? `链上 revert: ${decoded}` : 'RPC 未返回具体原因'
      const dataStr = revertData != null ? (typeof revertData === 'string' ? revertData : ethers.hexlify(revertData)) : ''
      const hint = createCardRevertHint(decoded)
      throw new Error(
        appendSnapshotToErrorMessage(
          `createCardCollectionWithInitCode(或 WithInitCodeAndTiers) 链上执行 revert（${reasonLine}）。常见原因：\n` +
            '  1) Deployer 未配置：工厂使用的 Deployer 合约需由其 owner 调用 setFactory(工厂地址)。运行 npm run check:createcard-deployer:base 诊断，修复：npm run set:card-deployer-factory:base\n' +
            '  2) 新卡 constructor revert：例如 gateway 地址无 code（UC_GlobalMisconfigured）；\n' +
            '  3) 工厂校验失败：部署后 factoryGateway/owner/currency/price 与传入不一致（BM_DeployFailedAtStep 2–4）；\n' +
            '  4) 使用 AndTiers 时某档 minUsdc6==0（UC_TierMinZero），或 Factory ABI 缺少 createCardCollectionWithInitCodeAndTiers。\n' +
            (hint ? hint : '') +
            (dataStr ? `原始 data（前 74 字符）: ${dataStr.slice(0, 74)}${dataStr.length > 74 ? '...' : ''}\n` : '') +
            (dataStr ? `rawRevertDataForRpc=${dataStr}\n` : '') +
            `原始错误: ${err?.shortMessage ?? err?.message ?? String(e)}`,
          failSnap,
        ),
      )
    }
    throw new Error(appendSnapshotToErrorMessage(err?.shortMessage ?? err?.message ?? String(e), failSnap))
  }

  let cardAddress: string | undefined
  try {
    const iface = factory.interface
    const log = receipt!.logs?.find((l: ethers.Log) => {
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
  const out = ethers.getAddress(cardAddress)
  emitCreateCardChainTrace('CCSA.createBeamioCardWithFactory.success', {
    cardAddress: out,
    txHash: tx.hash,
  })
  return out
}

/** Tier 结构（与 BeamioUserCard.Tier 一致） */
export type CreateCardTier = {
  minUsdc6: bigint | string
  attr: number
  tierExpirySeconds?: number | bigint
}

/**
 * 过滤 minUsdc6<=0 的档；链上 appendTier 要求 minUsdc6>0（UC_TierMinZero）。
 * 若调用方传了占位 tier（0 门槛），应退回无 tiers 的 createCardCollectionWithInitCode，避免整笔 revert。
 */
export function normalizeTiersForCreateCard(
  tiers: CreateCardTier[] | undefined,
): { minUsdc6: bigint; attr: bigint; tierExpirySeconds: bigint }[] {
  if (!tiers?.length) return []
  const out: { minUsdc6: bigint; attr: bigint; tierExpirySeconds: bigint }[] = []
  for (const t of tiers) {
    const min = BigInt(t.minUsdc6)
    if (min <= 0n) continue
    out.push({
      minUsdc6: min,
      attr: BigInt(t.attr),
      tierExpirySeconds: BigInt(t.tierExpirySeconds ?? 0),
    })
  }
  return out
}

async function resolveFactoryAddressForInitCode(factory: ethers.Contract): Promise<string> {
  if (typeof factory.getAddress === 'function') {
    return ethers.getAddress(await factory.getAddress())
  }
  const a = (factory as unknown as { address?: string }).address
  if (!a) throw new Error('Factory contract has no getAddress() nor address')
  return ethers.getAddress(a)
}

function isVerboseCreateCardDebug(): boolean {
  return typeof process !== 'undefined' && process.env?.BEAMIO_CREATE_CARD_DEBUG === '1'
}

/** JSON-safe fields for Master / Cluster logs (no secrets). */
export type CreateCardChainDebugSnapshot = Record<string, string | number | boolean | null | string[]>

/**
 * Collect on-chain + initCode fingerprints to compare local Hardhat vs server Master.
 * Set BEAMIO_CREATE_CARD_DEBUG=1 to also log a verbose block before send (see emitCreateCardDebug).
 */
export async function collectCreateCardChainDebugSnapshot(
  factory: ethers.Contract,
  initCode: string,
  params: {
    cardOwner: string
    currencyEnum: number
    priceE6: bigint
    signerAddress: string
    gasLimit: bigint
    callKind: 'createCardCollectionWithInitCode' | 'createCardCollectionWithInitCodeAndTiers'
    initCodeSource: 'prebuiltHex' | 'builtFromOptions'
    gatewayUsedWhenBuilding?: string
    libraryOverride?: BeamioUserCardLibraryAddresses
    rawTierCount?: number
    normalizedTierCount?: number
  },
): Promise<CreateCardChainDebugSnapshot> {
  const factoryAddr = await resolveFactoryAddressForInitCode(factory)
  const ic = initCode.startsWith('0x') ? initCode : `0x${initCode}`
  const initCodeByteLength = (ic.length - 2) / 2
  const initCodeKeccak256 = ethers.keccak256(ic)
  const libs = resolveBeamioUserCardLibraryAddresses(params.libraryOverride)

  let chainId: string | null = null
  try {
    const p = factory.runner && 'provider' in factory.runner ? (factory.runner as ethers.Signer).provider : null
    if (p) chainId = (await p.getNetwork()).chainId.toString()
  } catch {
    chainId = null
  }

  let deployerAddress: string | null = null
  let deployerFactory: string | null = null
  let deployerFactoryMatches: boolean | null = null
  try {
    deployerAddress = (await factory.deployer()) as string
    if (deployerAddress && ethers.getAddress(deployerAddress) !== ethers.ZeroAddress) {
      const dc = new ethers.Contract(
        deployerAddress,
        ['function factory() view returns (address)'],
        factory.runner,
      )
      deployerFactory = (await dc.factory()) as string
      deployerFactoryMatches =
        deployerFactory.toLowerCase() === factoryAddr.toLowerCase()
    }
  } catch {
    deployerAddress = deployerAddress ?? null
  }

  const gw = params.gatewayUsedWhenBuilding
  const gatewayMatchesFactory =
    gw !== undefined ? gw.toLowerCase() === factoryAddr.toLowerCase() : null

  return {
    chainId: chainId ?? 'unknown',
    factoryAddress: factoryAddr,
    signerAddress: params.signerAddress,
    cardOwner: params.cardOwner,
    currencyEnum: params.currencyEnum,
    priceE6: params.priceE6.toString(),
    callKind: params.callKind,
    gasLimit: params.gasLimit.toString(),
    initCodeSource: params.initCodeSource,
    initCodeByteLength,
    initCodeKeccak256,
    initCodePrefixHex: ic.slice(0, 26),
    gatewayUsedWhenBuilding: gw ?? null,
    gatewayMatchesFactory: gatewayMatchesFactory ?? null,
    beamioUserCardFormattingLib: libs?.BeamioUserCardFormattingLib ?? 'missing',
    beamioUserCardTransferLib: libs?.BeamioUserCardTransferLib ?? 'missing',
    deployerAddress,
    deployerFactory,
    deployerFactoryMatches,
    rawTierCount: params.rawTierCount ?? 0,
    normalizedTierCount: params.normalizedTierCount ?? 0,
    noteGatewayRule:
      'BeamioUserCard.factoryGateway() must equal the factory that calls createCard; initCode gateway must match factory address.',
    noteReceiptLogs:
      'On revert, tx receipt logs are usually empty; use debug_traceTransaction / Tenderly for inner revert.',
    noteCompareLocal:
      'Compare initCodeKeccak256 with a local Hardhat create (same owner/currency/price/gateway). If hashes differ, artifact or library link addresses differ (run compile + syncBeamioUserCardToX402sdk).',
    noteStep0vs1:
      'BM_DeployFailedAtStep(0)=CREATE/constructor; step(1)=gateway mismatch; steps 2–4=owner/currency/price.',
  }
}

function emitCreateCardDebug(phase: 'preflight' | 'failure', snapshot: CreateCardChainDebugSnapshot): void {
  const line = `[BeamioCreateCard:${phase}] ${JSON.stringify(snapshot)}`
  console.warn(line)
  if (phase === 'preflight' && isVerboseCreateCardDebug()) {
    console.warn(
      '[BeamioCreateCard:preflight:verbose] BEAMIO_CREATE_CARD_DEBUG=1 is set; unset after diagnosis to reduce log volume.',
    )
  }
}

function appendSnapshotToErrorMessage(base: string, snapshot: CreateCardChainDebugSnapshot): string {
  try {
    return `${base}\n[createCardDebugJson] ${JSON.stringify(snapshot)}`
  } catch {
    return base
  }
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

  emitCreateCardChainTrace('CCSA.createBeamioCardWithFactoryReturningHash.enter', {
    cardOwner,
    currency,
    priceE6: priceE6.toString(),
    tierArgLength: tiers?.length ?? 0,
  })

  let initCode: string
  let initCodeSource: 'prebuiltHex' | 'builtFromOptions'
  let gatewayUsedWhenBuilding: string | undefined
  let libraryOverrideForDebug: BeamioUserCardLibraryAddresses | undefined
  if (typeof initCodeOrOptions === 'string') {
    if (!initCodeOrOptions || !initCodeOrOptions.startsWith('0x')) {
      throw new Error('initCode must be a hex string (e.g. 0x...) when passed as string')
    }
    initCode = initCodeOrOptions
    initCodeSource = 'prebuiltHex'
  } else {
    const resolvedFactory = await resolveFactoryAddressForInitCode(factory)
    const requestedGw = initCodeOrOptions.gateway
    if (requestedGw !== undefined && ethers.getAddress(requestedGw) !== resolvedFactory) {
      console.warn(
        `[CCSA] initCodeOptions.gateway (${ethers.getAddress(requestedGw)}) ignored; using factory ${resolvedFactory} ` +
          '(BeamioUserCard.factoryGateway() must equal the factory that calls createCardCollectionWithInitCode).',
      )
    }
    const gateway = resolvedFactory
    gatewayUsedWhenBuilding = gateway
    libraryOverrideForDebug = initCodeOrOptions.libraryAddresses
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
    initCodeSource = 'builtFromOptions'
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

  const normalizedTiers = normalizeTiersForCreateCard(tiers)
  if (tiers?.length && normalizedTiers.length === 0) {
    console.warn(
      '[CCSA] createCard tiers input had only minUsdc6<=0 entries; using createCardCollectionWithInitCode (no AndTiers) to avoid UC_TierMinZero.',
    )
  }

  const gasLimit = getCreateCardGasLimit()

  const callKind =
    normalizedTiers.length > 0
      ? 'createCardCollectionWithInitCodeAndTiers'
      : 'createCardCollectionWithInitCode'
  const createCardDebugSnap = await collectCreateCardChainDebugSnapshot(factory, initCode, {
    cardOwner,
    currencyEnum,
    priceE6,
    signerAddress,
    gasLimit,
    callKind,
    initCodeSource,
    gatewayUsedWhenBuilding,
    libraryOverride: libraryOverrideForDebug,
    rawTierCount: tiers?.length ?? 0,
    normalizedTierCount: normalizedTiers.length,
  })
  if (isVerboseCreateCardDebug()) emitCreateCardDebug('preflight', createCardDebugSnap)

  emitCreateCardChainTrace('CCSA.createBeamioCardWithFactoryReturningHash.beforeSendTx', {
    callKind: createCardDebugSnap.callKind,
    factoryAddress: createCardDebugSnap.factoryAddress,
    signerAddress: createCardDebugSnap.signerAddress,
    initCodeKeccak256: createCardDebugSnap.initCodeKeccak256,
    initCodeByteLength: createCardDebugSnap.initCodeByteLength,
    normalizedTierCount: normalizedTiers.length,
  })

  let tx: ethers.ContractTransactionResponse
  let receipt: ethers.TransactionReceipt | null = null
  try {
    if (normalizedTiers.length > 0) {
      tx = await factory.createCardCollectionWithInitCodeAndTiers(
        cardOwner,
        currencyEnum,
        priceE6,
        initCode,
        normalizedTiers,
        { gasLimit },
      )
    } else {
      tx = await factory.createCardCollectionWithInitCode(
        cardOwner,
        currencyEnum,
        priceE6,
        initCode,
        { gasLimit },
      )
    }
    receipt = await tx.wait()
    if (!receipt) throw new Error('Transaction failed')
    if (Number(receipt.status) === 0) {
      throw Object.assign(new Error('transaction execution reverted'), {
        code: 'CALL_EXCEPTION',
        shortMessage: 'transaction execution reverted',
        receipt,
      } as const)
    }
  } catch (e: unknown) {
    const err = e as { code?: string; data?: string; reason?: string; shortMessage?: string; message?: string }
    const revertData =
      err?.data ??
      (e as { data?: string | Uint8Array }).data ??
      (e as { info?: { error?: { data?: string } } }).info?.error?.data
    const decoded = parseCreateCardRevertData(revertData)
    const failSnap: CreateCardChainDebugSnapshot = {
      ...createCardDebugSnap,
      failureRpcCode: err?.code ?? null,
      failureShortMessage: err?.shortMessage ?? err?.message ?? String(e),
      parsedRevert: decoded ?? null,
    }
    emitCreateCardChainTrace('CCSA.createBeamioCardWithFactoryReturningHash.sendFailed', {
      failureRpcCode: failSnap.failureRpcCode,
      parsedRevert: failSnap.parsedRevert,
      initCodeKeccak256: failSnap.initCodeKeccak256,
    })
    emitCreateCardDebug('failure', failSnap)
    const isCallException = err?.code === 'CALL_EXCEPTION'
    const noUsefulReason = !decoded && (err?.shortMessage === 'missing revert data' || !err?.reason || (err?.message && err.message.includes('unknown custom error')))
    if (isCallException && (noUsefulReason || decoded)) {
      const reasonLine = decoded ? `链上 revert: ${decoded}` : 'RPC 未返回具体原因'
      const dataStr = revertData != null ? (typeof revertData === 'string' ? revertData : ethers.hexlify(revertData)) : ''
      const hint = createCardRevertHint(decoded)
      throw new Error(
        appendSnapshotToErrorMessage(
          `createCardCollectionWithInitCode(或 WithInitCodeAndTiers) 链上执行 revert（${reasonLine}）。常见原因：\n` +
            '  1) Deployer 未配置：工厂使用的 Deployer 合约需由其 owner 调用 setFactory(工厂地址)。运行 npm run check:createcard-deployer:base 诊断，修复：npm run set:card-deployer-factory:base\n' +
            '  2) 新卡 constructor revert：例如 gateway 地址无 code（UC_GlobalMisconfigured）；\n' +
            '  3) 工厂校验失败：部署后 factoryGateway/owner/currency/price 与传入不一致（BM_DeployFailedAtStep 2–4）；\n' +
            '  4) 使用 AndTiers 时某档 minUsdc6==0（UC_TierMinZero），或 Factory ABI 缺少 createCardCollectionWithInitCodeAndTiers。\n' +
            (hint ? hint : '') +
            (dataStr ? `原始 data（前 74 字符）: ${dataStr.slice(0, 74)}${dataStr.length > 74 ? '...' : ''}\n` : '') +
            (dataStr ? `rawRevertDataForRpc=${dataStr}\n` : '') +
            `原始错误: ${err?.shortMessage ?? err?.message ?? String(e)}`,
          failSnap,
        ),
      )
    }
    throw new Error(appendSnapshotToErrorMessage(err?.shortMessage ?? err?.message ?? String(e), failSnap))
  }
  const hash = tx.hash

  let cardAddress: string | undefined
  try {
    const iface = factory.interface
    const log = receipt!.logs?.find((l: ethers.Log) => {
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
  const resolved = ethers.getAddress(cardAddress)
  emitCreateCardChainTrace('CCSA.createBeamioCardWithFactoryReturningHash.success', {
    cardAddress: resolved,
    txHash: hash,
  })
  return { cardAddress: resolved, hash }
}

