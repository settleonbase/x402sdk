import { ethers } from 'ethers'
import BeamioFactoryPaymasterArtifact from './ABI/BeamioUserCardFactoryPaymaster.json'
const BeamioFactoryPaymasterABI = (Array.isArray(BeamioFactoryPaymasterArtifact) ? BeamioFactoryPaymasterArtifact : (BeamioFactoryPaymasterArtifact as { abi?: unknown[] }).abi ?? []) as ethers.InterfaceAbi
import { masterSetup, checkSign, getBaseRpcUrlViaConetNode, getGuardianNodesCount, convertGasWeiToUSDC6, getOracleRequest } from './util'
import { Request, Response} from 'express'
import { resolve, join } from 'node:path'
import fs from 'node:fs'
import { homedir } from 'node:os'
import cluster from 'cluster'
import { logger } from './logger'
import { inspect } from 'util'
import Colors from 'colors/safe'
import BeamioUserCardABI from './ABI/BeamioUserCard.json'
import USDC_ABI from './ABI/usdc_abi.json'
import BeamioAAAccountFactoryPaymasterABI from './ABI/BeamioAAAccountFactoryPaymaster.json'
import IDiamondCutABI from "./ABI/DiamondCutFacetABI.json";
import DiamondLoupeFacetABI from "./ABI/DiamondLoupeFacet.json";
import DiamondCutFacetABI from "./ABI/DiamondCutFacetABI.json";
import OwnershipABI from "./ABI/OwnershipABI.json";
import TaskABI from "./ABI/TaskABI.json";
import StatsABI from "./ABI/StatsABI.json";
import CatalogABI from "./ABI/CatalogABI.json";
import ActionABI from "./ABI/ActionABI.json";
/** syncTokenAction(TransactionInput) - 与 ActionFacet.sol 当前实现一致。operator 非零时用于 admin 维度 token #0 mint/burn 统计；operatorParentChain 为 parent 链；topAdmin=上层 admin，subordinate=签字方 EOA */
const ACTION_SYNC_TOKEN_ABI = [
	'function syncTokenAction((bytes32 txId, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, address operator, address[] operatorParentChain, address topAdmin, address subordinate) in_) returns (uint256 actionId)',
] as const
import AdminFacetABI from "./ABI/adminFacet_ABI.json";
import beamioConetABI from './ABI/beamio-conet.abi.json'
import BeamioUserCardGatewayABI from './ABI/BeamioUserCardGatewayABI.json'
import { BASE_AA_FACTORY, BASE_CARD_FACTORY, BASE_CCSA_CARD_ADDRESS, CONET_BUNIT_AIRDROP_ADDRESS, BEAMIO_INDEXER_DIAMOND, MERCHANT_POS_MANAGEMENT_CONET, BASE_TREASURY } from './chainAddresses'

import { createBeamioCardWithFactory, createBeamioCardWithFactoryReturningHash } from './CCSA'
import { registerCardToDb, getNfcRecipientAddressByUid, getNfcCardPrivateKeyByUid, getNfcCardPrivateKeyByTagId, getCardByAddress, upsertNftTierMetadata } from './db'
import { verifyAndPersistBeamioSunUrl } from './BeamioSun'

/** Base 主网：与 chainAddresses.ts / config/base-addresses.ts 一致 */

const BeamioUserCardFactoryPaymasterV2 = BASE_CARD_FACTORY
const BeamioAAAccountFactoryPaymaster = BASE_AA_FACTORY
const BeamioOracle = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'
const beamioConetAddress = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
/** UserCard gateway = AA Factory（与 BASE_AA_FACTORY 一致） */
const BeamioUserCardGatewayAddress = BASE_AA_FACTORY

const BeamioTaskIndexerAddress = BEAMIO_INDEXER_DIAMOND
/** BUnitAirdrop consumeFromUser kind：x402 BeamioTransfer 转账手续费，需预先 registerKind(5,"x402Send") */
const BUNIT_KIND_X402_SEND = 5n
const DIAMOND = BeamioTaskIndexerAddress
/** Base 主网 RPC：优先 BASE_RPC_URL 环境变量，否则固定 1rpc.io/base */
const BASE_RPC_URL = (typeof process !== 'undefined' && process.env?.BASE_RPC_URL?.trim()) || 'https://1rpc.io/base'
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)
const providerBaseBackup = new ethers.JsonRpcProvider(BASE_RPC_URL)
const providerBaseBackup1 = new ethers.JsonRpcProvider(BASE_RPC_URL)
const conetEndpoint = 'https://mainnet-rpc.conet.network'
const providerConet = new ethers.JsonRpcProvider(conetEndpoint)
/**
 * Settle_ContractPool：factory 登记的 owner 列表，每项为一名 admin（含 baseFactoryPaymaster、walletBase 等）。
 *
 * 使用约定（防 nonce 冲突）：
 * - 任何 process 使用前必须 shift() 调出一名 owner，其他 process 则无法使用该 owner，避免同一 owner 同时调用 RPC 造成 nonce 冲突。
 * - process 结束后（无论成功/失败/early return）必须 unshift(SC) 将 owner 放回，以便其他 process 可复用。
 */
export let Settle_ContractPool: {
	baseFactoryPaymaster: ethers.Contract
	walletBase: ethers.Wallet
	walletConet: ethers.Wallet
	aaAccountFactoryPaymaster: ethers.Contract
	BeamioTaskDiamondCut: ethers.Contract
	BeamioTaskDiamondLoupe: ethers.Contract
	BeamioTaskDiamondOwnership: ethers.Contract
	BeamioTaskDiamondTask: ethers.Contract
	BeamioTaskDiamondStats: ethers.Contract
	BeamioTaskDiamondCatalog: ethers.Contract
	BeamioTaskDiamondAction: ethers.Contract
	BeamioTaskDiamondAdmin: ethers.Contract
	beamioConet: ethers.Contract
	conetSC: ethers.Contract
	BeamioUserCardGateway: ethers.Contract
}[] = []

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const USDC_SmartContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, providerBaseBackup)


//			RedeemModule 						0x1EC7540EbC03bcEBEc0C5f981C3D91100d206F5F
//			BeamioQuoteHelperV07 						0x4DD4b418949911B8A8038295F6a8Af7a1eA8de50
//			BeamioUserCardDeployerV07 					0x820bB3F54A403B298e2F785FFdA225009e9CA7Bf
//			BeamioUserCardFactoryPaymasterV07			0xb6D5A5319a5555E087eea9e8FC9d5E6787E4dD66

masterSetup.settle_contractAdmin.forEach((n: string) => {
	const walletBase = new ethers.Wallet(n, providerBaseBackup1)
	const walletConet = new ethers.Wallet(n, providerConet)
	const baseFactoryPaymaster = new ethers.Contract(BeamioUserCardFactoryPaymasterV2, BeamioFactoryPaymasterABI, walletBase)
	const aaAccountFactoryPaymaster = new ethers.Contract(BeamioAAAccountFactoryPaymaster, BeamioAAAccountFactoryPaymasterABI, walletBase)
	const BeamioTaskDiamondCut = new ethers.Contract(BeamioTaskIndexerAddress, IDiamondCutABI, walletConet)
	const BeamioTaskDiamondLoupe = new ethers.Contract(BeamioTaskIndexerAddress, DiamondLoupeFacetABI, walletConet)
	const BeamioTaskDiamondOwnership = new ethers.Contract(BeamioTaskIndexerAddress, OwnershipABI, walletConet)
	const BeamioTaskDiamondTask = new ethers.Contract(BeamioTaskIndexerAddress, TaskABI, walletConet)
	const BeamioTaskDiamondStats = new ethers.Contract(BeamioTaskIndexerAddress, StatsABI, walletConet)
	const BeamioTaskDiamondCatalog = new ethers.Contract(BeamioTaskIndexerAddress, CatalogABI, walletConet)
	const BeamioTaskDiamondAction = new ethers.Contract(BeamioTaskIndexerAddress, ActionABI, walletConet)
	const BeamioTaskDiamondAdmin = new ethers.Contract(BeamioTaskIndexerAddress, AdminFacetABI, walletConet)
	const beamioConet = new ethers.Contract(beamioConetAddress, beamioConetABI, walletConet)
	const conetSC = new ethers.Contract(beamioConet, beamioConetABI, walletConet)
	const BeamioUserCardGateway = new ethers.Contract(BeamioUserCardGatewayAddress, BeamioUserCardGatewayABI, walletBase)
	Settle_ContractPool.push ({
		baseFactoryPaymaster,
		walletBase,
		walletConet,
		aaAccountFactoryPaymaster,
		BeamioTaskDiamondCut,
		BeamioTaskDiamondLoupe,
		BeamioTaskDiamondOwnership,
		BeamioTaskDiamondTask,
		BeamioTaskDiamondStats,
		BeamioTaskDiamondCatalog,
		BeamioTaskDiamondAction,
		BeamioTaskDiamondAdmin,
		beamioConet,
		conetSC,
		BeamioUserCardGateway
	})

})

/**
 * 启动时确保 ~/.master.json 的 settle_contractAdmin 地址都被登记为 Card Factory paymaster(admin)。
 * - 幂等：已存在则跳过
 * - 仅使用 settle_contractAdmin[0] 作为写入 signer，避免多 signer/multi-worker 并发 nonce 冲突
 */
const ensureSettleAdminsAsCardFactoryAdmins = async (): Promise<void> => {
	if (!cluster.isPrimary) {
		logger(Colors.gray('[factory-admin-init] skip: only master process can initialize factory admins'))
		return
	}

	const lockPath = join(homedir(), '.beamio-factory-admin-init.lock')
	const lockTtlMs = 3 * 60 * 1000
	let lockFd: number | null = null
	const releaseLock = () => {
		if (lockFd != null) {
			try { fs.closeSync(lockFd) } catch { /* ignore */ }
			lockFd = null
		}
		try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath) } catch { /* ignore */ }
	}
	const acquireLock = (): boolean => {
		try {
			lockFd = fs.openSync(lockPath, 'wx')
			fs.writeFileSync(lockFd, `${process.pid} ${Date.now()}`)
			return true
		} catch (e: any) {
			if (e?.code !== 'EEXIST') return false
			try {
				const stat = fs.statSync(lockPath)
				if (Date.now() - stat.mtimeMs > lockTtlMs) {
					fs.unlinkSync(lockPath)
					lockFd = fs.openSync(lockPath, 'wx')
					fs.writeFileSync(lockFd, `${process.pid} ${Date.now()}`)
					return true
				}
			} catch {
				// ignore
			}
			return false
		}
	}

	if (!acquireLock()) {
		logger(Colors.gray('[factory-admin-init] skip: another process is initializing factory admins'))
		return
	}

	try {
		if (!Settle_ContractPool.length) {
			logger(Colors.yellow('[factory-admin-init] skip: Settle_ContractPool is empty'))
			return
		}

		const readOnlyFactory = new ethers.Contract(
			BeamioUserCardFactoryPaymasterV2,
			BeamioFactoryPaymasterABI as ethers.InterfaceAbi,
			providerBaseBackup
		)

		const ownerOnChain = String(await readOnlyFactory.owner())
		const ownerOnChainLower = ownerOnChain.toLowerCase()
		const ownerPk = masterSetup?.settle_contractAdmin?.[0]
		if (!ownerPk) {
			logger(Colors.yellow('[factory-admin-init] skip: settle_contractAdmin[0] is empty'))
			return
		}
		const ownerWallet = new ethers.Wallet(ownerPk, providerBaseBackup1)
		if (ownerWallet.address.toLowerCase() !== ownerOnChainLower) {
			logger(
				Colors.yellow(
					`[factory-admin-init] skip: settle_contractAdmin[0]=${ownerWallet.address} is not factory owner (${ownerOnChain})`
				)
			)
			return
		}
		const ownerFactory = new ethers.Contract(
			BeamioUserCardFactoryPaymasterV2,
			BeamioFactoryPaymasterABI as ethers.InterfaceAbi,
			ownerWallet
		)

		// 从本地配置列表构造目标 admin 地址（去重）
		const adminTargets = [...new Set(Settle_ContractPool.map(sc => sc.walletBase.address.toLowerCase()))]
			.map((addrLower) => {
				const found = Settle_ContractPool.find(sc => sc.walletBase.address.toLowerCase() === addrLower)
				return found?.walletBase.address
			})
			.filter((a): a is string => !!a)

		for (const adminAddr of adminTargets) {
			const adminLower = adminAddr.toLowerCase()
			// owner 默认具备 onlyPaymaster 权限，不需要写入 isPaymaster
			if (adminLower === ownerOnChainLower) {
				continue
			}

			let isPaymaster = false
			try {
				isPaymaster = !!(await readOnlyFactory.isPaymaster(adminAddr))
			} catch (e: any) {
				logger(Colors.red(`[factory-admin-init] isPaymaster(${adminAddr}) failed: ${e?.message ?? e}`))
				continue
			}

			if (isPaymaster) {
				continue
			}

			try {
				const tx = await ownerFactory.changePaymasterStatus(adminAddr, true)
				await tx.wait()
				logger(Colors.green(`[factory-admin-init] added paymaster(admin): ${adminAddr}`))
			} catch (e: any) {
				// 多进程并发场景：可能出现 nonce too low；此时再读一次链上状态，若已是 paymaster 视为成功
				const msg = String(e?.message ?? e)
				const isNonceRace =
					msg.includes('nonce too low') ||
					msg.includes('nonce has already been used') ||
					e?.code === 'NONCE_EXPIRED'
				if (isNonceRace) {
					try {
						const nowPaymaster = !!(await readOnlyFactory.isPaymaster(adminAddr))
						if (nowPaymaster) {
							logger(Colors.yellow(`[factory-admin-init] nonce race but admin already set: ${adminAddr}`))
							continue
						}
					} catch {
						// ignore and fall through to error log
					}
				}
				logger(Colors.red(`[factory-admin-init] add paymaster(admin) failed for ${adminAddr}: ${msg}`))
			}
		}
	} catch (e: any) {
		logger(Colors.red(`[factory-admin-init] unexpected error: ${e?.message ?? e}`))
	} finally {
		releaseLock()
	}
}

if (cluster.isPrimary) {
	void ensureSettleAdminsAsCardFactoryAdmins()
}




/**
 * 为 EOA 确保存在 AA 账户（purchasingCardProcess 等流程的依赖）。
 *
 * 业务约定（强制）：
 * - 每个 EOA 仅支持一个 AA 账户（index=0）。
 * - 不支持为同一 EOA 创建第二个及以上的 AA（index>=1）；若 EOA 已有 AA 则只返回其 index=0 的地址，绝不再次创建。
 *
 * 要求：SC 必须为 AA Factory（BeamioFactoryPaymasterV07），SC.runner 必须为 Factory 的 Paymaster，
 * 否则 createAccountFor 会 revert (onlyPayMaster)。
 *
 * 合约语义：nextIndexOfCreator(creator)=0 表示尚无账户，=1 表示已分配 index 0；
 * getAddress(creator, 0) 为 CREATE2 预测地址，createAccountFor(creator) 仅在此处用于创建唯一的 index=0 账户。
 */
const DeployingSmartAccount = async (wallet: string, SC: ethers.Contract): Promise<{ accountAddress: string, alreadyExisted: boolean }> => {
	const INDEX_AA_PER_EOA = 0n

	try {
		const creatorAddress = wallet
		// nextIndexOfCreator = 当前「下一个」要分配的 index：0 表示尚无账户，1 表示已有 index 0 的账户
		const nextIndex = await SC.nextIndexOfCreator(creatorAddress)
		const getAddressFn = SC.getFunction('getAddress(address,uint256)')
		const predictedAddress = await getAddressFn(creatorAddress, INDEX_AA_PER_EOA)

		logger(`DeployingSmartAccount ${wallet} -> 预测地址: ${predictedAddress}, nextIndex: ${nextIndex}`)

		if (nextIndex > 0n) {
			// 已有 AA：只认 index 0，不创建第二个及以上
			if (nextIndex > 1n) {
				logger(Colors.yellow(`DeployingSmartAccount: ${wallet} 已有多个 AA (nextIndex=${nextIndex})，本逻辑仅支持一个 AA，只返回 index=0 的地址`))
			}
			const provider = (SC.runner as ethers.Wallet)?.provider ?? providerBaseBackup
			const code = await provider.getCode(predictedAddress)
			if (code === '0x' || code === '') {
				logger(Colors.red(`DeployingSmartAccount: ${wallet} nextIndex=${nextIndex} 但 index=0 地址未部署，状态异常`))
				return { accountAddress: '', alreadyExisted: false }
			}
			logger(`DeployingSmartAccount: 账户已存在 (index=0)`)
			return { accountAddress: predictedAddress, alreadyExisted: true }
		}

		// 尚无账户，由 Paymaster 调用 createAccountFor(creator)；仅此路径会创建 AA，且仅创建 index=0 的一个
		const tx = await SC.createAccountFor(wallet)
		logger(`DeployingSmartAccount: 创建账户交易已发送，hash=${tx.hash}`)
		const receipt = await tx.wait()

		// 验证交易是否成功（ethers v6: status 1 = 成功）
		if (!receipt || receipt.status !== 1) {
			logger(Colors.red(`DeployingSmartAccount: 交易失败，receipt.status=${receipt?.status}`))
			return { accountAddress: '', alreadyExisted: false }
		}

		// CREATE2 确定性：实际部署地址 = getAddress(creator, 0) = predictedAddress
		const provider = (SC.runner as ethers.Wallet)?.provider ?? providerBaseBackup
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
		let code = await provider.getCode(predictedAddress)
		if (code === '0x' || code === '') {
			// RPC 传播延迟：tx 已确认但 getCode 可能尚未索引，重试 2–3 次
			for (let attempt = 1; attempt <= 3; attempt++) {
				await sleep(2 * attempt * 1000)
				code = await provider.getCode(predictedAddress)
				if (code && code !== '0x' && code !== '') break
			}
		}
		if (code === '0x' || code === '') {
			// 重试后仍空：尝试 beamioAccountOf（Factory 可能已索引）
			const primaryAfter = await SC.beamioAccountOf(creatorAddress).catch(() => null)
			if (primaryAfter && primaryAfter !== ethers.ZeroAddress) {
				const codeAtPrimary = await provider.getCode(primaryAfter).catch(() => '')
				if (codeAtPrimary && codeAtPrimary !== '0x') {
					logger(Colors.yellow(`DeployingSmartAccount: getCode(predicted) 空但 beamioAccountOf 已返回，使用 primary=${primaryAfter}`))
					return { accountAddress: ethers.getAddress(primaryAfter), alreadyExisted: false }
				}
			}
			const nextIdxAfter = await SC.nextIndexOfCreator(creatorAddress).catch(() => null)
			const blockNum = receipt?.blockNumber ?? '?'
			const gasUsed = receipt?.gasUsed?.toString() ?? '?'
			const logsLen = receipt?.logs?.length ?? 0
			logger(Colors.red(`DeployingSmartAccount: 交易成功但账户未部署，地址=${predictedAddress}`))
			logger(Colors.red(`  [debug] txHash=${tx.hash} block=${blockNum} gasUsed=${gasUsed} logs=${logsLen}`))
			logger(Colors.red(`  [debug] nextIndexOfCreator(after)=${nextIdxAfter} beamioAccountOf(after)=${primaryAfter ?? 'null'}`))
			return { accountAddress: '', alreadyExisted: false }
		}

		// 可选：用 beamioAccountOf 与 predictedAddress 交叉验证
		try {
			const primary = await SC.beamioAccountOf(creatorAddress)
			if (primary && primary.toLowerCase() !== predictedAddress.toLowerCase()) {
				logger(Colors.yellow(`DeployingSmartAccount: primaryAccountOf 与 predicted 不一致，primary=${primary} predicted=${predictedAddress}`))
			}
		} catch {
			// 忽略
		}

		const isBeamioAccount = await SC.isBeamioAccount(predictedAddress)
		if (!isBeamioAccount) {
			logger(Colors.yellow(`DeployingSmartAccount: 警告：账户已部署但未注册到 Factory，地址=${predictedAddress}`))
		}

		const newNextIndex = await SC.nextIndexOfCreator(creatorAddress)
		if (newNextIndex !== 1n) {
			logger(Colors.yellow(`DeployingSmartAccount: 警告：nextIndexOfCreator 未正确更新，期望=1，实际=${newNextIndex}`))
		}

		logger(`DeployingSmartAccount 已为 ${wallet} 创建 AA (index=0)，地址=${predictedAddress}，tx=${tx.hash}`)
		return { accountAddress: predictedAddress, alreadyExisted: false }
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error)
		logger(Colors.red(`DeployingSmartAccount error! ${msg}`))
		throw new Error(`DeployingSmartAccount failed for ${wallet}: ${msg}`)
	}
}


/**
 * 为 mint MerchantsManagement NFT 的 targetAddress（EOA）确保存在 AA。
 * 若 EOA 无 AA 则先调用 createAccountFor 创建，再返回；Master 在 push executeForOwner 前调用。
 */
export const ensureAAForMintTarget = async (targetAddress: string): Promise<void> => {
	const pool = Settle_ContractPool
	if (!pool?.length) throw new Error('Settle_ContractPool not initialized')
	const aaFactory = pool[0].aaAccountFactoryPaymaster
	if (!aaFactory) throw new Error('aaAccountFactoryPaymaster not initialized')
	const acct = await aaFactory.beamioAccountOf(targetAddress)
	const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
	const hasAA = acct && acct !== ethers.ZeroAddress && (await provider.getCode(acct)) !== '0x'
	if (hasAA) return
	logger(Colors.cyan(`[ensureAAForMintTarget] targetAddress ${targetAddress} has no AA, creating...`))
	const { accountAddress } = await DeployingSmartAccount(targetAddress, aaFactory)
	if (!accountAddress) throw new Error(`Failed to create AA for ${targetAddress}`)
	logger(Colors.green(`[ensureAAForMintTarget] created AA ${accountAddress} for ${targetAddress}`))
}

/**
 * 为 EOA 确保存在 AA，返回 AA 地址。供 UI 登记 admin 前调用：UI 仅传 EOA，由此获取 AA 再构建 adminManager(AA,...) 并签字。
 * 登记 admin 必须使用 AA 账号；UI 送入 endpoint 的账号默认必须为 EOA，不能传送预测 AA。
 */
export const ensureAAForEOA = async (eoa: string): Promise<string> => {
	const pool = Settle_ContractPool
	if (!pool?.length) throw new Error('Settle_ContractPool not initialized')
	const aaFactory = pool[0].aaAccountFactoryPaymaster
	if (!aaFactory) throw new Error('aaAccountFactoryPaymaster not initialized')
	const acct = await aaFactory.beamioAccountOf(eoa)
	const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
	const hasAA = acct && acct !== ethers.ZeroAddress && (await provider.getCode(acct)) !== '0x'
	if (hasAA) return ethers.getAddress(acct)
	logger(Colors.cyan(`[ensureAAForEOA] EOA ${eoa} has no AA, creating...`))
	const { accountAddress, alreadyExisted } = await DeployingSmartAccount(eoa, aaFactory)
	if (!accountAddress) {
		let predicted: string | null = null
		try {
			const fn = aaFactory.getFunction('getAddress(address,uint256)')
			predicted = await fn(eoa, 0n)
		} catch {
			/* ignore */
		}
		logger(Colors.red(`[ensureAAForEOA] error: Failed to create AA for ${eoa}`))
		logger(Colors.red(`  [debug] predictedAddress=${predicted ?? '?'} alreadyExisted=${alreadyExisted}`))
		throw new Error(`Failed to create AA for ${eoa}`)
	}
	logger(Colors.green(`[ensureAAForEOA] created AA ${accountAddress} for EOA ${eoa}`))
	return accountAddress
}

/**
 * 检查 EOA 是否已拥有 index=0 的 AA 账户（与 DeployingSmartAccount 约定一致：每个 EOA 仅支持一个 AA，不支持多个）。
 */
export const checkSmartAccount = async (wallet: string): Promise<false | { accountAddress: string; alreadyExisted: true }> => {
	const SC = Settle_ContractPool[0]
	if (!SC) return false
	try {
		const nextIndex = await SC.baseFactoryPaymaster.nextIndexOfCreator(wallet)
		// 仅关心 index 0 的账户
		const getAddressFn = SC.baseFactoryPaymaster.getFunction('getAddress(address,uint256)')
		const predictedAddress = await getAddressFn(wallet, 0n)

		const code = await providerBaseBackup.getCode(predictedAddress)
		const isDeployed = code !== '0x' && code !== ''

		if (nextIndex > 0n && isDeployed) {
			console.log(`[Beamio] Account ${wallet} already deployed at ${predictedAddress} (index=0)`)
			return { accountAddress: predictedAddress, alreadyExisted: true }
		}
		return false
	} catch {
		return false
	}
}

const ensureSmartAccount = async (req: Request, res: Response) => {
	const { wallet, signMessage } = req.query as { wallet: string, signMessage: string }
	if (!wallet || !ethers.isAddress(wallet)) {
		return res.status(400).json({ error: 'Address is required' })
	}
	const isValid = checkSign(wallet, signMessage, wallet)

}

export type CurrencyType = 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD'
type ICurrency = CurrencyType

const CurrencyMap: Record<CurrencyType, number> = {
  CAD: 0, USD: 1, JPY: 2, CNY: 3, USDC: 4,
  HKD: 5, EUR: 6, SGD: 7, TWD: 8
}

// 仅用于日志里的展示
const fmt18 = (v: bigint) => ethers.formatUnits(v, 18)

const calcPriceE18 = (currencyToTokenValue: number | bigint) => {
  const X = BigInt(currencyToTokenValue)
  if (X <= 0n) throw new Error('currencyToTokenValue must be > 0')
  // ✅ 1 currency = X points  ==>  1 point price = 1/X currency
  // priceE18 = 1e18 / X
  return ethers.parseUnits('1', 18) / X
}

const getRateE18Safe = async (currencyId: number) => {
  const oracle = new ethers.Contract(
    BeamioOracle,
    ['function getRate(uint8 c) external view returns (uint256)'],
    providerBaseBackup
  )
  const r: bigint = await oracle.getRate(currencyId)
  return r
}


const E12 = 10n ** 12n
const E18 = 10n ** 18n
const POINTS_ONE = 1_000_000n // 1 point = 1e6 units (points6)
const USDC_ONE_CENTS_6 = 10_000n // 0.01 USDC in 6 decimals

/** Beamio 收费标准（OpenContainer 商户收款等）：1 USDC = 100 BUnit，费率 0.8%，最低 2 BUnit，最高 200 BUnit，>=5000 USDC 时 500 BUnit */
function calcBeamioBUnitFee(amountUSDC6: bigint): { bServiceUnits6: bigint; bServiceUSDC6: bigint } {
  const BUNIT_PER_USDC = 100n // 1 USDC = 100 BUnit
  const MIN_BUNITS_6 = 2_000_000n
  const MAX_BUNITS_6 = 200_000_000n
  const THRESHOLD_USDC6 = 5_000_000_000n // 5000 USDC
  const FIXED_HIGH_BUNITS_6 = 500_000_000n
  if (amountUSDC6 >= THRESHOLD_USDC6) {
    const bServiceUnits6 = FIXED_HIGH_BUNITS_6
    const bServiceUSDC6 = bServiceUnits6 / BUNIT_PER_USDC
    return { bServiceUnits6, bServiceUSDC6 }
  }
  // fee = amount * 0.8%; feeBUnits = feeUSDC * 100; feeBUnits6 = amountUSDC6 * 8/1000 * 100 = amountUSDC6 * 4/5
  const feeBUnits6 = (amountUSDC6 * 8n * BUNIT_PER_USDC) / 1000n
  const clamped = feeBUnits6 < MIN_BUNITS_6 ? MIN_BUNITS_6 : feeBUnits6 > MAX_BUNITS_6 ? MAX_BUNITS_6 : feeBUnits6
  // 1 BUnit = 0.01 USDC => bServiceUSDC6 = bServiceUnits6 / 100
  const bServiceUSDC6 = clamped / BUNIT_PER_USDC
  return { bServiceUnits6: clamped, bServiceUSDC6 }
}

const OLD_ERROR_SELECTORS: Record<string, string> = {
	'0xea8e4eb5': 'NotAuthorized()',
	'0xd92e233d': 'ZeroAddress()',
	'0x56b88e0a': 'InvalidRedeemHash()',
	'0xfd70b8f6': 'BadDeployedCard()',
	'0x3a81d6fc': 'AlreadyRegistered()',
	'0x32cc7236': 'NotFactory()',
	'0xb4f54111': 'DeployFailed()',
	'0x154c51b8': 'FactoryAlreadySet()',
	'0x6ca4dbe2': 'SecretUsed()',
	'0x3204506f': 'CallFailed()',
	'0xabab6bd7': 'InvalidSecret()'
  }
  
  // 你统一 Errors.sol（新前缀）
  const NEW_ERROR_SELECTORS: Record<string, string> = {
	// Common
	'0xd92e233d': 'BM_ZeroAddress()',
	// 注意：BM_NotAuthorized() selector 取决于你 Errors.sol 的实际签名，这里不给死值
	// 你可以把 BM_NotAuthorized() 的 selector 也补进来（见下方 helper 说明）
  
	// Deployer
	// DEP_NotFactory(), DEP_FactoryAlreadySet() 同理：如果你需要，也可以补 selector
  }
  
  // 如果你想把 “新 Errors.sol” 的 selector 补全：
  // selector = keccak256("BM_NotAuthorized()").slice(0, 10)
  // 在 node 里也能算：ethers.id("BM_NotAuthorized()").slice(0, 10)
  const selectorOf = (sig: string) => ethers.id(sig).slice(0, 10)
  
  const decodeRevertSelector = (dataHex: string) => {
	if (!dataHex || dataHex === '0x') return null
	const sel = dataHex.slice(0, 10).toLowerCase()
	return sel
  }
  
  const explainRevert = (dataHex: string) => {
	const sel = decodeRevertSelector(dataHex)
	if (!sel) return `Unknown revert (no data)`
  
	// 先查旧错误（你现在碰到的就是这个）
	const old = OLD_ERROR_SELECTORS[sel]
	if (old) return `${old} (selector=${sel})`
  
	// 再查新错误（如果你链上已经升级到统一 Errors.sol）
	const nw = NEW_ERROR_SELECTORS[sel]
	if (nw) return `${nw} (selector=${sel})`
  
	// 尝试动态识别一些常见 OZ 错误
	const oz = {
	  [selectorOf('OwnableUnauthorizedAccount(address)')]: 'OwnableUnauthorizedAccount(address)',
	  [selectorOf('ERC1155InvalidReceiver(address)')]: 'ERC1155InvalidReceiver(address)',
	  [selectorOf('ERC1155InsufficientBalance(address,uint256,uint256,uint256)')]: 'ERC1155InsufficientBalance(address,...)'
	} as Record<string, string>
	if (oz[sel]) return `${oz[sel]} (selector=${sel})`
  
	return `Unknown custom error (selector=${sel})`
  }
 

// 辅助函数：计算错误选择器
const getErrorSelector = (errorName: string, params: string[] = []): string => {
	const paramStr = params.length > 0 ? `(${params.join(',')})` : '()'
	const errorSig = `${errorName}${paramStr}`
	return ethers.id(errorSig).slice(0, 10)
}

// 辅助函数：设置 Deployer 的 factory 地址
export const setupDeployerFactory = async (): Promise<void> => {
	if (!Settle_ContractPool || Settle_ContractPool.length === 0) {
		throw new Error('Settle_ContractPool is empty')
	}
	
	const SC = Settle_ContractPool[0]?.baseFactoryPaymaster
	if (!SC) {
		throw new Error('baseFactoryPaymaster is not initialized')
	}
	
	const gateway = await SC.getAddress()
	const deployerAddress = await SC.deployer()
	
	if (!deployerAddress || deployerAddress === ethers.ZeroAddress) {
		throw new Error(`Deployer address is zero in Factory`)
	}
	
	const deployerContract = new ethers.Contract(
		deployerAddress,
		['function factory() view returns (address)', 'function setFactoryOnce(address)'],
		Settle_ContractPool[0].walletBase
	)
	
	const currentFactory = await deployerContract.factory()
	if (currentFactory !== ethers.ZeroAddress) {
		if (currentFactory.toLowerCase() === gateway.toLowerCase()) {
			logger(Colors.green(`✅ Deployer.factory is already set correctly to ${gateway}`))
			return
		} else {
			throw new Error(`Deployer.factory is already set to ${currentFactory}, cannot change. Expected ${gateway}`)
		}
	}
	
	logger(Colors.yellow(`[SetupDeployer] Setting Deployer.factory to ${gateway}...`))
	const tx = await deployerContract.setFactoryOnce(gateway)
	logger(Colors.cyan(`[SetupDeployer] Transaction sent: ${tx.hash}`))
	await tx.wait()
	logger(Colors.green(`✅ Deployer.factory successfully set to ${gateway}`))
}



const getAllRate = async () => {
    try {
        const oracle = new ethers.Contract(
            BeamioOracle,
            ["function getRate(uint8 c) external view returns (uint256)"],
            providerBaseBackup
        );

        // 对应 BeamioCurrency.CurrencyType 的顺序
        const currencies = [
            { id: 0, name: 'CAD' },
            { id: 1, name: 'USD' },
            { id: 2, name: 'JPY' },
            { id: 3, name: 'CNY' },
            { id: 4, name: 'USDC' },
            { id: 5, name: 'HKD' },
            { id: 6, name: 'EUR' },
            { id: 7, name: 'SGD' },
            { id: 8, name: 'TWD' }
        ];

        logger(`[Oracle] Fetching all exchange rates from ${BeamioOracle}...`);

        // 使用 Promise.all 进行并发查询提升效率
        const ratePromises = currencies.map(async (c) => {
            try {
                const rate = await oracle.getRate(c.id);
                return {
                    ...c,
                    rateRaw: rate.toString(),
                    rateFormatted: ethers.formatUnits(rate, 18), // 汇率是以 E18 存储的
                    status: 'Active'
                };
            } catch (e) {
                return { ...c, rateRaw: '0', rateFormatted: 'N/A', status: 'Not Set' };
            }
        });

        const allRates = await Promise.all(ratePromises);

        // 打印成表格，方便调试
        console.table(allRates.map(r => ({
            ID: r.id,
            Currency: r.name,
            "Rate (to USD)": r.rateFormatted,
            Status: r.status
        })));

        return allRates;

    } catch (error: any) {
        logger(Colors.red(`❌ getAllRate failed:`), error.message);
        throw error;
    }
}

/**
 * 为 USDC 购买积分生成 EIP-3009 签名
 */
async function signUSDC3009(
    userWallet: ethers.Wallet,
    cardAddress: string,
    usdcAmount6: bigint,
    validAfter: number,
    validBefore: number,
    nonce: string
) {
    const cardContract = new ethers.Contract(cardAddress, ["function owner() view returns (address)"], providerBaseBackup);
    
    // 关键点：受益人必须是 Card 的 owner()
    const merchantAddress = await cardContract.owner(); 

    // USDC 在 Base 上的合约信息 (或根据 Factory 获取)
    const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; 

    const domain = {
        name: 'USD Coin', // 这里的 name 可能随链/版本变化，通常 Base 上是 'USD Coin'
        version: '2',
        chainId: 8453, // Base Mainnet
        verifyingContract: usdcAddress
    };

    const types = {
        TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' }
        ]
    };

    const message = {
        from: userWallet.address,
        to: merchantAddress, // 必须是 Card Owner
        value: usdcAmount6,
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: nonce
    };

    return await userWallet.signTypedData(domain, types, message);
}

/** NFC Topup：服务端用私钥签 EIP-3009，供 Master nfcTopup 端点调用 */
export const signUSDC3009ForNfcTopup = async (
	userWallet: ethers.Wallet,
	cardAddress: string,
	usdcAmount6: bigint,
	validAfter: number,
	validBefore: number,
	nonce: string
): Promise<string> => {
	const cardContract = new ethers.Contract(cardAddress, ["function owner() view returns (address)"], providerBaseBackup)
	const merchantAddress = await cardContract.owner()
	const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
	const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: usdcAddress }
	const types = {
		TransferWithAuthorization: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'validAfter', type: 'uint256' },
			{ name: 'validBefore', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' }
		]
	}
	const message = {
		from: userWallet.address,
		to: merchantAddress,
		value: usdcAmount6,
		validAfter,
		validBefore,
		nonce
	}
	return await userWallet.signTypedData(domain, types, message)
}

/** NFC Topup Prepare：根据 uid 或 wallet/amount/currency 生成 executeForAdmin 所需的 data、deadline、nonce。cardAddress 为必填，指定充值的卡。 */
export const nfcTopupPreparePayload = async (params: {
	uid?: string
	wallet?: string
	amount: string
	currency?: string
	cardAddress: string
}): Promise<{ cardAddr: string; data: string; deadline: number; nonce: string } | { error: string }> => {
	const { uid, wallet, amount, currency = 'CAD', cardAddress: clientCardAddress } = params
	const amt = typeof amount === 'string' ? amount : String(amount ?? '')
	if (!amt || Number(amt) <= 0) return { error: 'Invalid amount' }
	if (!clientCardAddress || typeof clientCardAddress !== 'string' || !ethers.isAddress(clientCardAddress.trim())) {
		return { error: 'Missing or invalid cardAddress' }
	}
	const cardAddr = ethers.getAddress(clientCardAddress.trim())
	let recipientEOA: string | null = null
	if (wallet && typeof wallet === 'string' && ethers.isAddress(wallet.trim())) {
		recipientEOA = ethers.getAddress(wallet.trim())
	} else if (uid && typeof uid === 'string' && uid.trim()) {
		recipientEOA = await getNfcRecipientAddressByUid(uid.trim())
	}
	if (!recipientEOA) return { error: wallet ? 'Invalid wallet address' : 'Failed to resolve recipient from uid' }

	// Android admin topup 需要支持首发/升级/普通 topup 三类路径：
	// 这里不再阻断“无会员卡”用户，具体分类与收费在 nfcTopupPreCheckBUnitFee + 记账阶段判定。

	const cur = (currency || 'CAD').toUpperCase()
	const ONE_E6 = 1_000_000n
	const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
	const toRateE6 = (raw: unknown, fallback: string): bigint => {
		const n = Number(raw)
		if (!Number.isFinite(n) || n <= 0) return ethers.parseUnits(fallback, 6)
		return ethers.parseUnits(n.toFixed(6), 6)
	}
	const amountCurrency6 = ethers.parseUnits(amt, 6)
	if (amountCurrency6 <= 0n) return { error: 'Invalid amount' }

	// 优先使用“卡币种直算 points6”，避免 currency->USDC->points 的双重向下截断造成 49.999993 这类漏档误差
	let points6: bigint | null = null
	try {
		const readCard = new ethers.Contract(
			cardAddr,
			['function currency() view returns (uint8)', 'function pointsUnitPriceInCurrencyE6() view returns (uint256)'],
			providerBaseBackup
		)
		const [cardCurrencyId, priceInCurrency6] = await Promise.all([
			readCard.currency() as Promise<bigint>,
			readCard.pointsUnitPriceInCurrencyE6() as Promise<bigint>
		])
		const currencyMap: Record<number, string> = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' }
		const cardCurrency = currencyMap[Number(cardCurrencyId)] ?? 'CAD'
		if (cardCurrency === cur && priceInCurrency6 > 0n) {
			points6 = ceilDiv(amountCurrency6 * ONE_E6, priceInCurrency6)
			logger(Colors.gray(`[nfcTopupPreparePayload] direct points calc card=${cardAddr} cur=${cur} amount6=${amountCurrency6} priceE6=${priceInCurrency6} => points6=${points6}`))
		}
	} catch (_) {
		// 直算失败时回退 USDC 报价路径
	}

	if (points6 == null) {
		const oracle = getOracleRequest() as any
		let usdcAmount6: bigint
		if (cur === 'USD' || cur === 'USDC') {
			usdcAmount6 = amountCurrency6
		} else {
			const oracleRateKey: Record<string, string> = {
				CAD: 'usdcad',
				EUR: 'usdeur',
				JPY: 'usdjpy',
				CNY: 'usdcny',
				HKD: 'usdhkd',
				SGD: 'usdsgd',
				TWD: 'usdtwd',
			}
			const rateKey = oracleRateKey[cur] ?? 'usdcad'
			const fallbackRate: Record<string, string> = {
				usdcad: '1.35',
				usdeur: '0.92',
				usdjpy: '150',
				usdcny: '7.2',
				usdhkd: '7.8',
				usdsgd: '1.35',
				usdtwd: '31',
			}
			const rateE6 = toRateE6(oracle?.[rateKey], fallbackRate[rateKey] ?? '1.35')
			usdcAmount6 = ceilDiv(amountCurrency6 * ONE_E6, rateE6)
		}
		if (usdcAmount6 <= 0n) return { error: 'Invalid amount' }
		const quote = await quotePointsForUSDC_raw(cardAddr, usdcAmount6)
		points6 = quote.points6
		logger(Colors.gray(`[nfcTopupPreparePayload] quote path card=${cardAddr} cur=${cur} amount6=${amountCurrency6} usdc6=${usdcAmount6} => points6=${points6}`))
	}

	if (points6 <= 0n) return { error: 'quotePointsForUSDC failed' }
	const iface = new ethers.Interface(['function mintPointsByAdmin(address toEOA, uint256 amount)'])
	const data = iface.encodeFunctionData('mintPointsByAdmin', [recipientEOA, points6])
	/** 15 分钟有效期，避免队列/网络延迟导致 UC_InvalidTimeWindow */
	const deadline = Math.floor(Date.now() / 1000) + 900
	const nonce = ethers.hexlify(ethers.randomBytes(32))
	return { cardAddr, data, deadline, nonce }
}

/** Burn Points Prepare：生成 executeForAdmin 所需的 data、deadline、nonce。Admin 离线签字后提交 /api/nfcTopup。target 为被 burn 的地址，amount 为 "max" 表示 burn 全部。 */
export const burnPointsByAdminPreparePayload = async (params: {
	cardAddress: string
	target: string
	amount: string
}): Promise<{ cardAddr: string; data: string; deadline: number; nonce: string } | { error: string }> => {
	const { cardAddress, target, amount } = params
	if (!cardAddress || !ethers.isAddress(cardAddress.trim())) return { error: 'Missing or invalid cardAddress' }
	if (!target || !ethers.isAddress(target.trim())) return { error: 'Missing or invalid target' }
	const amt = amount === 'max' || amount === 'all' ? ethers.MaxUint256 : BigInt(amount ?? '0')
	if (amt <= 0n && amt !== ethers.MaxUint256) return { error: 'Invalid amount (use "max" for burn all)' }
	const cardAddr = ethers.getAddress(cardAddress.trim())
	const iface = new ethers.Interface(['function burnPointsByAdmin(address target, uint256 amount)'])
	const data = iface.encodeFunctionData('burnPointsByAdmin', [ethers.getAddress(target.trim()), amt])
	const deadline = Math.floor(Date.now() / 1000) + 900
	const nonce = ethers.hexlify(ethers.randomBytes(32))
	return { cardAddr, data, deadline, nonce }
}

/** executeForAdmin 队列：Master 用 paymaster 调用 factory.executeForAdmin */
export const executeForAdminPool: Array<{
	cardAddr: string
	data: string
	deadline: number
	nonce: string
	adminSignature: string
	uid?: string
	cardOwnerEOA?: string
	topupFeeBUnits?: bigint
	topupKind?: 2 | 3
	res?: Response
}> = []

/** 校验 ExecuteForAdmin 签字的 signer 是否为 card 的 admin，与 Cluster 预检一致。Master 执行前二次校验。 */
const verifyExecuteForAdminSignerIsAdmin = async (obj: {
	cardAddr: string
	data: string
	deadline: number
	nonce: string
	adminSignature: string
}): Promise<{ ok: true; signer: string } | { ok: false; error: string }> => {
	try {
		const dataHash = ethers.keccak256(obj.data)
		const domain = {
			name: 'BeamioUserCardFactory',
			version: '1',
			chainId: 8453,
			verifyingContract: BASE_CARD_FACTORY,
		}
		const types = {
			ExecuteForAdmin: [
				{ name: 'cardAddress', type: 'address' },
				{ name: 'dataHash', type: 'bytes32' },
				{ name: 'deadline', type: 'uint256' },
				{ name: 'nonce', type: 'bytes32' },
			],
		}
		const message = {
			cardAddress: obj.cardAddr,
			dataHash,
			deadline: BigInt(obj.deadline),
			nonce: obj.nonce.startsWith('0x') ? obj.nonce : ('0x' + obj.nonce) as `0x${string}`,
		}
		const digest = ethers.TypedDataEncoder.hash(domain, types, message)
		const signer = ethers.recoverAddress(digest, obj.adminSignature)
		const cardAbi = ['function isAdmin(address) view returns (bool)']
		const provider = providerBaseBackup
		const card = new ethers.Contract(obj.cardAddr, cardAbi, provider)
		const isAdmin = await card.isAdmin(signer)
		if (!isAdmin) return { ok: false, error: 'Signer is not card admin' }
		return { ok: true, signer }
	} catch (e: any) {
		return { ok: false, error: e?.message ?? String(e) }
	}
}

/** 从 card 拉取 operator 的 parent 链（从直接 parent 到根），用于 syncTokenAction 的 operatorParentChain，B 的 mint/burn 累积到链上各 admin */
const fetchOperatorParentChain = async (cardAddr: string, operator: string): Promise<string[]> => {
	const chain: string[] = []
	const cardAbi = ['function adminParent(address) view returns (address)']
	const card = new ethers.Contract(cardAddr, cardAbi, providerBaseBackup)
	let current = operator
	for (let i = 0; i < 32; i++) {
		const parent = await card.adminParent(current) as string
		if (!parent || parent === ethers.ZeroAddress) break
		chain.push(ethers.getAddress(parent))
		current = parent
	}
	return chain
}

/** 从 operatorParentChain 推导 topAdmin（根 admin）与 subordinate（签字方 EOA）。topAdmin 用于报表按上层 admin 查询，subordinate 为实际执行方 */
const deriveTopAdminAndSubordinate = (operator: string, operatorParentChain: string[]): { topAdmin: string; subordinate: string } => {
	const subordinate = ethers.getAddress(operator)
	const topAdmin = operatorParentChain.length > 0
		? ethers.getAddress(operatorParentChain[operatorParentChain.length - 1])
		: subordinate
	return { topAdmin, subordinate }
}

/** 从 executeForAdmin 的 data 中解析 mintPointsByAdmin(toEOA, points6) 的 toEOA，供 NFC Topup 前置 DeployingSmartAccount */
const tryParseMintPointsByAdminRecipient = (data: string): string | null => {
	try {
		const iface = new ethers.Interface(['function mintPointsByAdmin(address user, uint256 points6)'])
		const decoded = iface.parseTransaction({ data })
		if (decoded?.name === 'mintPointsByAdmin' && decoded.args[0]) return decoded.args[0] as string
	} catch { /* ignore */ }
	return null
}

/** 获取 card 使用的 AA Factory 地址（card.factoryGateway()._aaFactory()），与 mintPointsByAdmin 的 _toAccount 解析逻辑一致 */
const getCardAaFactoryAddress = async (cardAddr: string): Promise<string> => {
	const cardAbi = ['function factoryGateway() view returns (address)']
	const factoryAbi = ['function _aaFactory() view returns (address)']
	const card = new ethers.Contract(cardAddr, cardAbi, providerBaseBackup)
	const gateway = await card.factoryGateway()
	const factory = new ethers.Contract(gateway, factoryAbi, providerBaseBackup)
	return factory._aaFactory()
}

export const executeForAdminProcess = async () => {
	const obj = executeForAdminPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		executeForAdminPool.unshift(obj)
		return setTimeout(() => executeForAdminProcess(), 3000)
	}
	try {
		// 二次校验：签字账户必须为 card admin（Cluster 已预检，Master 防御性再检）
		const adminCheck = await verifyExecuteForAdminSignerIsAdmin(obj)
		if (!adminCheck.ok) {
			logger(Colors.red(`[executeForAdminProcess] admin check failed: ${adminCheck.error}`))
			if (obj.res && !obj.res.headersSent) obj.res.status(403).json({ success: false, error: adminCheck.error }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => executeForAdminProcess(), 1000)
			return
		}
		// adminManager(add admin)：必须链上校验 to；若 to 无 code 视为 EOA，先创建 AA（与 executeForOwnerProcess 一致）。客户端应传 EOA 而非预测 AA。
		const dataSel = obj.data.slice(0, 10).toLowerCase()
		const isAdminManager = dataSel === ADMIN_MANAGER_4_SELECTOR.toLowerCase() || dataSel === ADMIN_MANAGER_5_SELECTOR.toLowerCase()
		if (isAdminManager && SC.aaAccountFactoryPaymaster) {
			const iface = dataSel === ADMIN_MANAGER_5_SELECTOR.toLowerCase() ? adminManager5ArgIface : adminManager4ArgIface
			const decoded = iface.parseTransaction({ data: obj.data })
			if (decoded?.name === 'adminManager' && decoded.args[1] === true) {
				const to = decoded.args[0] as string
				if (to && ethers.isAddress(to)) {
					const provider = (SC.walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
					const codeAtTo = await provider.getCode(to)
					if (!codeAtTo || codeAtTo === '0x') {
						let aaAddr = await SC.aaAccountFactoryPaymaster.beamioAccountOf(to)
						if (!aaAddr || aaAddr === ethers.ZeroAddress) aaAddr = await SC.aaAccountFactoryPaymaster.primaryAccountOf(to)
						const hasAA = aaAddr && aaAddr !== ethers.ZeroAddress && (await provider.getCode(aaAddr)) !== '0x'
						if (!hasAA) {
							logger(Colors.cyan(`[cardAddAdminByAdmin] EOA ${to} has no AA, creating...`))
							await DeployingSmartAccount(to, SC.aaAccountFactoryPaymaster)
							logger(Colors.green(`[cardAddAdminByAdmin] AA created for EOA ${to}, proceeding`))
						}
					}
				}
			}
		}
		// NFC Topup：mintPointsByAdmin 要求 recipient 已有 AA 账户，否则 _toAccount 会 revert UC_ResolveAccountFailed
		// 必须使用 card 的 factoryGateway()._aaFactory()，与合约内 _resolveAccount 一致；若用配置的 AA Factory 可能不匹配导致 UC_ResolveAccountFailed
		const recipientEOA = tryParseMintPointsByAdminRecipient(obj.data)
		const mintParsed = tryParseMintPointsByAdminArgs(obj.data)
		let aaAddr: string | null = null
		let beforePoint6 = 0n
		let beforeNfts: Array<{ tokenId: bigint }> = []
		let cardOwnerEOAForAccounting = ''
		let cardCurrencyFiat = 0
		if (recipientEOA) {
			logger(Colors.cyan(`[nfcTopup] uid=${obj.uid ?? '(not provided)'} | wallet=${recipientEOA} | cardAddr=${obj.cardAddr}`))
			const cardAaFactoryAddr = await getCardAaFactoryAddress(obj.cardAddr)
			const configAaAddr = await SC.aaAccountFactoryPaymaster.getAddress()
			const aaFactoryContract = cardAaFactoryAddr.toLowerCase() === configAaAddr.toLowerCase()
				? SC.aaAccountFactoryPaymaster
				: new ethers.Contract(cardAaFactoryAddr, BeamioAAAccountFactoryPaymasterABI as ethers.InterfaceAbi, SC.walletBase)
			if (cardAaFactoryAddr.toLowerCase() !== configAaAddr.toLowerCase()) {
				logger(Colors.yellow(`[nfcTopup] Card _aaFactory(${cardAaFactoryAddr}) != config(${configAaAddr}), using card's aaFactory`))
			}
			const { accountAddress: addr } = await DeployingSmartAccount(recipientEOA, aaFactoryContract)
			aaAddr = addr
			if (!addr) {
				logger(Colors.red(`[executeForAdminProcess] DeployingSmartAccount failed for recipient=${recipientEOA}`))
				if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: 'Recipient has no Beamio account. Please activate the Beamio app first.' }).end()
				Settle_ContractPool.unshift(SC)
				setTimeout(() => executeForAdminProcess(), 1000)
				return
			}
			try {
				const cardRead = new ethers.Contract(
					obj.cardAddr,
					[
						'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
						'function owner() view returns (address)',
						'function currency() view returns (uint8)',
					],
					providerBaseBackup
				)
				const [ownership, rawOwner, rawCurrency] = await Promise.all([
					cardRead.getOwnershipByEOA(recipientEOA) as Promise<[bigint, Array<{ tokenId: bigint }>]>,
					cardRead.owner() as Promise<string>,
					cardRead.currency() as Promise<bigint>,
				])
				beforePoint6 = ownership?.[0] ?? 0n
				beforeNfts = Array.isArray(ownership?.[1]) ? ownership[1] : []
				cardCurrencyFiat = Number(rawCurrency ?? 0n)
				try {
					const resolvedOwner = await resolveCardOwnerToEOA(providerBaseBackup, rawOwner)
					cardOwnerEOAForAccounting = resolvedOwner?.success ? resolvedOwner.cardOwner : ''
				} catch {
					cardOwnerEOAForAccounting = ethers.isAddress(rawOwner) ? ethers.getAddress(rawOwner) : ''
				}
			} catch (preOwnershipErr: any) {
				logger(Colors.yellow(`[executeForAdminProcess] pre-topup ownership snapshot failed: ${preOwnershipErr?.shortMessage ?? preOwnershipErr?.message ?? String(preOwnershipErr)}`))
			}
		}
		const factory = SC.baseFactoryPaymaster
		let tx: ethers.ContractTransactionResponse
		try {
			tx = await factory.executeForAdmin(
				obj.cardAddr,
				obj.data,
				obj.deadline,
				obj.nonce,
				obj.adminSignature
			)
		} catch (gasErr: any) {
			// 部分 RPC 在 estimateGas 时返回 "missing revert data"，直接发送可成功。用固定 gasLimit 重试
			if (/estimateGas|missing revert data|CALL_EXCEPTION/i.test(gasErr?.message ?? '')) {
				logger(Colors.yellow(`[executeForAdminProcess] estimateGas failed, retrying with gasLimit=600000`))
				tx = await factory.executeForAdmin(
					obj.cardAddr,
					obj.data,
					obj.deadline,
					obj.nonce,
					obj.adminSignature,
					{ gasLimit: 600_000 }
				)
			} else {
				throw gasErr
			}
		}
		logger(Colors.green(`[executeForAdminProcess] tx=${tx.hash} | uid=${obj.uid ?? '(not provided)'} | wallet=${recipientEOA ?? 'N/A'} | AA=${aaAddr ?? 'N/A'}`))
		let baseReceipt: ethers.TransactionReceipt | null = null
		const ensureBaseReceipt = async () => {
			if (baseReceipt) return baseReceipt
			baseReceipt = await tx.wait().catch(async (waitErr: any) => {
				const msg = waitErr?.shortMessage ?? waitErr?.message ?? String(waitErr)
				logger(Colors.yellow(`[executeForAdminProcess] tx.wait() failed (RPC): ${msg}`))
				// RPC may return malformed batch (missing eth_getTransactionReceipt response). Tx was broadcast; poll for receipt.
				if (waitErr?.code === 'BAD_DATA' || /missing response for request/i.test(msg)) {
					for (let i = 0; i < 12; i++) {
						await new Promise((r) => setTimeout(r, 2000))
						const r = await providerBaseBackup.getTransactionReceipt(tx.hash)
						if (r) {
							logger(Colors.green(`[executeForAdminProcess] receipt poll ok after ${(i + 1) * 2}s`))
							return r
						}
					}
				}
				return null
			}) as ethers.TransactionReceipt | null
			return baseReceipt
		}
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(200).json({ success: true, txHash: tx.hash }).end()
		}
		// Topup 成功后向卡的发行方收取 B-Unit 费用（Cluster 已预检，Master 直接执行）
		if (obj.cardOwnerEOA && obj.topupFeeBUnits && obj.topupFeeBUnits > 0n) {
			const receipt = await ensureBaseReceipt()
			const baseHash = tx.hash as `0x${string}`
			const baseGas = receipt?.gasUsed ?? 0n
			const bunitAirdropWrite = new ethers.Contract(
				CONET_BUNIT_AIRDROP_ADDRESS,
				['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
				SC.walletConet
			)
			try {
				const consumeTx = await bunitAirdropWrite.consumeFromUser(
					obj.cardOwnerEOA,
					obj.topupFeeBUnits,
					baseHash,
					baseGas,
					BigInt(obj.topupKind ?? 2), // kind=2 cardTopup, kind=3 issueCard
					{ gasLimit: 2_500_000 }
				)
				await consumeTx.wait()
				logger(Colors.cyan(`[executeForAdminProcess] consumeFromUser ok: ${Number(obj.topupFeeBUnits) / 1e6} B-Units from ${obj.cardOwnerEOA}`))
			} catch (consumeErr: any) {
				logger(Colors.red(`[executeForAdminProcess] consumeFromUser failed (non-fatal): ${consumeErr?.shortMessage ?? consumeErr?.message ?? consumeErr}`))
			}
		}
		// Android admin topup 也按 purchasingCard 规则记账：
		// newCard / upgradeNewCard / topupCard
		if (recipientEOA && mintParsed && mintParsed.points6 > 0n && ethers.isAddress(obj.cardAddr)) {
			try {
				await ensureBaseReceipt()
				const cardRead = new ethers.Contract(
					obj.cardAddr,
					['function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)'],
					providerBaseBackup
				)
				const [, nAfter] = await cardRead.getOwnershipByEOA(recipientEOA) as [bigint, Array<{ tokenId: bigint }>]
				const beforeTokenIds = extractTokenIdsFromOwnership(beforeNfts ?? [])
				const beforeTokenSet = new Set(beforeTokenIds.map((id) => id.toString()))
				const afterTokenIds = extractTokenIdsFromOwnership(Array.isArray(nAfter) ? nAfter : [])
				const upgradedByMint = afterTokenIds.some((id) => !beforeTokenSet.has(id.toString()))
				// TopUp RouteItem: tokenId = newly minted (upgrade/first) or existing held (normal topup); source=UserCardPoint
				const tokenIdForRoute = upgradedByMint
					? (afterTokenIds.find((id) => !beforeTokenSet.has(id.toString())) ?? afterTokenIds[0] ?? 0n)
					: (afterTokenIds[0] ?? 0n)
				// Classification rule:
				// - minted a new tier token this time + had previous balance => upgrade
				// - minted a new tier token this time + no previous balance => first purchase
				// - no new tier token minted => normal topup
				const topupCategoryRaw = upgradedByMint
					? (beforePoint6 > 0n ? 'upgradeNewCard' : 'newCard')
					: 'topupCard'
				const txCategoryTopup = ethers.keccak256(ethers.toUtf8Bytes(topupCategoryRaw)) as `0x${string}`
				let finalRequestAmountUSDC6 = 0n
				try {
					const q = await quoteUSDCForPoints(obj.cardAddr, ethers.formatUnits(mintParsed.points6, 6))
					finalRequestAmountUSDC6 = BigInt(q.usdc6)
				} catch (_) {
					finalRequestAmountUSDC6 = cardCurrencyFiat === 4 ? mintParsed.points6 : 0n
				}
				if (finalRequestAmountUSDC6 <= 0n) finalRequestAmountUSDC6 = 1n
				let cardDisplayName = ''
				try {
					const cardMeta = await getCardByAddress(obj.cardAddr)
					const metadata = cardMeta?.metadata as { shareTokenMetadata?: { name?: string }; name?: string } | undefined
					cardDisplayName = String(metadata?.shareTokenMetadata?.name ?? metadata?.name ?? '').trim()
				} catch {}
				const baseName = (cardDisplayName || 'Membership').replace(/\s*card\s*$/i, '').trim() || 'Membership'
				const title = topupCategoryRaw === 'newCard'
					? `Buy ${baseName} Card`
					: (topupCategoryRaw === 'upgradeNewCard' ? `Upgrade ${baseName} Card` : `Top Up ${baseName} Card`)
				const payerAddr = ethers.getAddress(recipientEOA)
				const payeeAddr = ethers.isAddress(cardOwnerEOAForAccounting)
					? ethers.getAddress(cardOwnerEOAForAccounting)
					: ethers.ZeroAddress
				const displayJson = JSON.stringify({
					title,
					handle: '',
					source: 'androidNfcTopup',
					topupCategory: topupCategoryRaw,
					cardName: cardDisplayName || undefined,
					cardAddress: obj.cardAddr,
					finishedHash: tx.hash,
				})
				// TopUp RouteItem per accounting spec: asset=card, assetType=ERC1155, source=UserCardPoint, tokenId=NFT card#, itemCurrencyType=currency, amountE6=topup amount
				const topupRouteItem = {
					asset: obj.cardAddr,
					amountE6: mintParsed.points6,
					assetType: 1, // ERC1155
					source: 1, // RouteSource.UserCardPoint
					tokenId: tokenIdForRoute,
					itemCurrencyType: cardCurrencyFiat,
					offsetInRequestCurrencyE6: 0n,
				}
				const operatorParentChain = await fetchOperatorParentChain(obj.cardAddr, adminCheck.signer)
				const { topAdmin, subordinate } = deriveTopAdminAndSubordinate(adminCheck.signer, operatorParentChain)
				const input = {
					txId: tx.hash as `0x${string}`,
					originalPaymentHash: ethers.ZeroHash as `0x${string}`,
					chainId: 8453n,
					txCategory: txCategoryTopup,
					displayJson,
					timestamp: 0n,
					payer: payerAddr,
					payee: payeeAddr,
					finalRequestAmountFiat6: mintParsed.points6,
					finalRequestAmountUSDC6,
					isAAAccount: false,
					route: [topupRouteItem],
					fees: {
						gasChainType: 0,
						gasWei: 0n,
						gasUSDC6: 0n,
						serviceUSDC6: 0n,
						bServiceUSDC6: 0n,
						bServiceUnits6: 0n,
						feePayer: ethers.ZeroAddress,
					},
					meta: {
						requestAmountFiat6: mintParsed.points6,
						requestAmountUSDC6: finalRequestAmountUSDC6,
						currencyFiat: cardCurrencyFiat,
						discountAmountFiat6: beforePoint6,
						discountRateBps: 0,
						taxAmountFiat6: 0n,
						taxRateBps: 0,
						afterNotePayer: '',
						afterNotePayee: '',
					},
					operator: ethers.getAddress(adminCheck.signer),
					operatorParentChain,
					topAdmin,
					subordinate,
				}
				const syncTxHash = await runPurchasingCardAccountingJob(
					{
						input,
						baseTxHash: tx.hash,
						from: payerAddr,
						cardAddress: obj.cardAddr,
						attempt: 0,
					},
					{ walletConet: SC.walletConet, BeamioTaskDiamondAction: SC.BeamioTaskDiamondAction }
				)
				logger(Colors.green(`[executeForAdminProcess] android topup accounting done: baseTx=${tx.hash} syncTokenAction=${syncTxHash} cat=${topupCategoryRaw}`))
			} catch (accountingErr: any) {
				logger(Colors.yellow(`[executeForAdminProcess] android topup accounting non-critical: ${accountingErr?.shortMessage ?? accountingErr?.message ?? String(accountingErr)}`))
			}
		}
		// Android NFC topup（mintPointsByAdmin）成功后同步该用户在该卡上的成员 NFT tier metadata，与普通 topup/redeem 一致：按 minUsdc6 排序、Default/Max 对应低档、写入 backgroundColor 等 1155 JSON
		if (recipientEOA && obj.cardAddr) {
			syncNftTierMetadataForUser(obj.cardAddr, recipientEOA).catch((err: any) => {
				logger(Colors.yellow(`[executeForAdminProcess] syncNftTierMetadataForUser after nfcTopup: ${err?.message ?? err}`))
			})
		}
	} catch (e: any) {
		logger(Colors.red(`[executeForAdminProcess] failed: ${e?.message ?? e}`))
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(400).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'executeForAdmin failed' }).end()
		}
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => executeForAdminProcess(), 1000)
	}
}

/**
 * 无需许可的购买：用户签名，Paymaster 提交
 * 真正实现了 Owner 无需干预
 */
export const USDC2Token = async (
	userPrivateKey: string,
	amount: number,
	cardAddress: string,
	opts?: {
	  autoCreateAA?: boolean
	  minPointsOut6?: bigint
	  gasLimit?: number
	}
  ) => {
	const SC = Settle_ContractPool[0]
  
	const {
	  autoCreateAA = false,
	  minPointsOut6 = 0n,
	  gasLimit = 900_000
	} = opts || {}
  
	try {
	  const userWallet = new ethers.Wallet(userPrivateKey, providerBaseBackup)
	  const userEOA = userWallet.address
  
	  const usdcAmount6 = ethers.parseUnits(String(amount), 6)
  
	  const network = await providerBaseBackup.getNetwork()
	  const chainId = Number(network.chainId)
  
	  const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  
	  // relayer signer (pays gas)
	  const relayer = SC.walletBase
  
	  // contracts
	  const card = new ethers.Contract(cardAddress, BeamioUserCardABI, relayer)
	  const gateway = SC.baseFactoryPaymaster
	  const aaFactory = SC.aaAccountFactoryPaymaster
  
	  // ===== 前置条件(1)：gateway.aaFactory() 必须等于 aaFactory 地址 =====
	  const globalAaFactory = await gateway.aaFactory()
	  const localAaFactory = await aaFactory.getAddress()
  
	  if (globalAaFactory.toLowerCase() !== localAaFactory.toLowerCase()) {
		throw new Error(
		  `❌ UC_GlobalMisconfigured: gateway.aaFactory()=${globalAaFactory}, local=${localAaFactory}`
		)
	  }
  
	  if ((await providerBaseBackup.getCode(globalAaFactory)) === '0x') {
		throw new Error(`❌ UC_GlobalMisconfigured: aaFactory ${globalAaFactory} has no code`)
	  }
  
	  // ===== 前置条件(2)：card.factoryGateway 必须等于 gateway =====
	  const cardGateway = await card.factoryGateway()
	  const gatewayAddr = await gateway.getAddress()
	  if (cardGateway.toLowerCase() !== gatewayAddr.toLowerCase()) {
		throw new Error(`❌ UC_UnauthorizedGateway: card.factoryGateway=${cardGateway}, expected=${gatewayAddr}`)
	  }
  
	  // ===== 获取 AA account（新合约 mint 目标强制是 AA）=====
	  let aaAccount = await aaFactory.beamioAccountOf(userEOA)
  
	  // 某些历史逻辑还会写 primaryAccountOf，这里做个 fallback + sanity
	  const primary = await aaFactory.primaryAccountOf(userEOA)
	  if (aaAccount === ethers.ZeroAddress && primary !== ethers.ZeroAddress) {
		aaAccount = primary
	  }
  
	  // 若需要自动创建
	//   if (aaAccount === ethers.ZeroAddress) {
	// 	if (!autoCreateAA) {
	// 	  throw new Error('❌ UC_NoBeamioAccount: user has no BeamioAccount, set autoCreateAA=true or createAccountFor() first')
	// 	}
  
	// 	logger(`[AA] creating account for ${userEOA}...`)
	// 	const txCreate = await aaFactory.connect(relayer).createAccountFor(userEOA, { gasLimit: 900_000 })
	// 	const rcCreate = await txCreate.wait()
	// 	logger(`[AA] created tx=${txCreate.hash} status=${rcCreate?.status}`)
  
	// 	aaAccount = await aaFactory.beamioAccountOf(userEOA)
	// 	if (aaAccount === ethers.ZeroAddress) {
	// 	  // 再 fallback 一次
	// 	  aaAccount = await aaFactory.primaryAccountOf(userEOA)
	// 	}
	//   }
  
	  // 强校验：AA 必须存在且是 BeamioAccount
	  const aaCode = await providerBaseBackup.getCode(aaAccount)
	  if (aaCode === '0x') {
		throw new Error(`❌ UC_NoBeamioAccount: aa=${aaAccount} has no code`)
	  }
  
	  const isBeamio = await aaFactory.isBeamioAccount(aaAccount)
	  if (!isBeamio) {
		throw new Error(`❌ UC_NoBeamioAccount: ${aaAccount} is not BeamioAccount`)
	  }
  
	  logger(`[AA] beamioAccountOf(${userEOA}) = ${aaAccount}`)
  
	  // ===== merchant =====
	  // buyPointsWith3009Authorization 内部 USDC 转给 card.owner()
	  const merchantAddress = await card.owner()
	  logger(`[Card] merchant(owner)=${merchantAddress}`)
  
	  // ===== price sanity =====
	  const unitPriceUsdc6 = await gateway.quoteUnitPointInUSDC6(cardAddress)
	  if (unitPriceUsdc6 === 0n) {
		throw new Error('❌ UC_PriceZero: quoteUnitPointInUSDC6(card)=0')
	  }
  
	  // 预估 pointsOut6 (仅日志/前端展示用)
	  const pointsOut6 = (usdcAmount6 * 1_000_000n) / unitPriceUsdc6
	  logger(`[Quote] usdc6=${usdcAmount6} unitPriceUsdc6=${unitPriceUsdc6} pointsOut6≈${pointsOut6}`)
  
	  // ===== ERC-3009 signature =====
	  const validAfter = 0
	  const validBefore = Math.floor(Date.now() / 1000) + 3600
	  const nonce = ethers.hexlify(ethers.randomBytes(32))
  
	  const sig = await userWallet.signTypedData(
		{ name: 'USD Coin', version: '2', chainId, verifyingContract: USDC_ADDRESS },
		{
		  TransferWithAuthorization: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'validAfter', type: 'uint256' },
			{ name: 'validBefore', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' }
		  ]
		},
		{
		  from: userEOA,
		  to: merchantAddress,
		  value: usdcAmount6,
		  validAfter,
		  validBefore,
		  nonce
		}
	  )
  
	  // ===== 强烈建议：staticCall 定位 revert =====
	  logger('[Relayer] staticCall buyPointsWith3009Authorization...')
	  await card.buyPointsWith3009Authorization.staticCall(
		userEOA,
		usdcAmount6,
		validAfter,
		validBefore,
		nonce,
		sig,
		minPointsOut6
	  )
  
	  logger('[Relayer] sending buyPointsWith3009Authorization...')
	  const tx = await card.buyPointsWith3009Authorization(
		userEOA,
		usdcAmount6,
		validAfter,
		validBefore,
		nonce,
		sig,
		minPointsOut6,
		{ gasLimit }
	  )
  
	  const receipt = await tx.wait()
	  logger(`✅ Purchase Success hash=${tx.hash} status=${receipt?.status}`)
  
	  return {
		txHash: tx.hash,
		eoa: userEOA,
		aaAccount,
		usdcAmount6,
		pointsOut6
	  }
	} catch (error: any) {
	  logger(`❌ Purchase Failed: ${error?.shortMessage || error?.message || String(error)}`)
	  throw error
	}
  }
  

/** 集群预检后传给 master 的数据（bigint 已序列化为 string 便于 JSON）。AA 账户由 master 用 DeployingSmartAccount 检查/创建，集群不检查 AA。 */
export type PurchasingCardPreChecked = {
	accountAddress?: string
	owner: string
	_currency: number
	currencyAmount: { usdc6: string, points6: string, usdc: string, points: string, unitPriceUSDC6?: string, unitPriceUSDC?: string }
	pointsBalance: string
	nfts: unknown[]
	isMember: boolean
}

export const purchasingCardPool: {
	cardAddress: string
	userSignature: string
	nonce: string
	usdcAmount: string
	from: string
	validAfter: string
	validBefore: string
	res: Response
	preChecked?: PurchasingCardPreChecked
	/** Recommender 地址；非零时必须为 card admin，统计时 operator=recommender；为零则 operator=owner */
	recommender?: string
}[] = []

/** 用户兑换 redeem 码：仅 redeemForUser，无需 owner 签名。paymaster 代付 gas。 */
export const cardRedeemPool: {
	cardAddress: string
	redeemCode: string
	toUserEOA: string
	res: Response
}[] = []

/** cardRedeem 成功后写入 BeamioIndexerDiamond（txCategory=redeemNewCard/redeemUpgradeNewCard/redeemTopupCard） */
export const cardRedeemIndexerAccountingPool: {
	cardAddress: string
	toUserEOA: string
	aaAddress: string
	txHash: string
	beforeNfts?: unknown[]
	/** 创建 redeem 的 admin/owner，兑换时计入其统计及 parent 链；0 则用 card owner 兜底 */
	creator?: string
}[] = []

/** 通用 executeForOwner：客户端提交 owner 签名的 calldata，服务端免 gas 执行。可选 redeemCode+toUserEOA 时额外执行 redeemForUser（空投）。可选 description/image/background_color 用于 createIssuedNft 后组装 EIP-1155 metadata。 */
export const executeForOwnerPool: {
	cardAddress: string
	data: string
	deadline: number
	nonce: string
	ownerSignature: string
	redeemCode?: string
	toUserEOA?: string
	res: Response
	description?: string
	image?: string
	background_color?: string
}[] = []

/** AA→EOA 转账请求：客户端提交 ERC-4337 已签字的 UserOp，由 Beamio 代付 Gas 并提交到链上 */
export type AAtoEOAUserOp = {
	sender: string
	nonce: string | bigint
	initCode: string
	callData: string
	accountGasLimits: string
	preVerificationGas: string | bigint
	gasFees: string
	paymasterAndData: string
	signature: string
}
export const AAtoEOAPool: {
	toEOA: string
	amountUSDC6: string
	packedUserOp: AAtoEOAUserOp
	/** Bill 支付时 URL 的 requestHash（bytes32），供记账写入 originalPaymentHash 以关联 request_create */
	requestHash?: string
	res: Response
}[] = []

/** OpenContainerRelayPayload：与 BeamioContainerModuleV07.containerMainRelayedOpen(to, items, currencyType, maxAmount, nonce_, deadline_, sig) 一致；无 token */
export type OpenContainerRelayPayload = {
	account: string
	to: string
	items: { kind: number; asset: string; amount: string | bigint; tokenId: string | bigint; data: string }[]
	currencyType: number
	maxAmount: string
	nonce: string
	deadline: string
	signature: string
}

export const OpenContainerRelayPool: {
	openContainerPayload: OpenContainerRelayPayload
	currency?: string | string[]
	currencyAmount?: string | string[]
	currencyDiscount?: string | string[]
	currencyDiscountAmount?: string | string[]
	forText?: string
	/** Bill 支付时 URL 的 requestHash（bytes32），供记账写入 originalPaymentHash 以关联 request_create */
	requestHash?: string
	res: Response
}[] = []

/** ContainerRelayPayload：UI 提交的 containerMainRelayed（绑定 to）签名结果，与 SilentPassUI ContainerRelayPayload 一致 */
export type ContainerRelayPayload = {
	account: string
	to: string
	items: { kind: number; asset: string; amount: string | bigint; tokenId: string | bigint; data: string }[]
	nonce: string
	deadline: string
	signature: string
}

/** 客户端提交的未签名 container（供 payByNfcUidSignContainer 使用，服务端用 UID 私钥签名后 relay） */
export type ContainerRelayPayloadUnsigned = Omit<ContainerRelayPayload, 'signature'>

export const ContainerRelayPool: {
	containerPayload: ContainerRelayPayload
	currency?: string | string[]
	currencyAmount?: string | string[]
	currencyDiscount?: string | string[]
	currencyDiscountAmount?: string | string[]
	forText?: string
	/** Bill 支付时 URL 的 requestHash（bytes32），供记账写入 originalPaymentHash 以关联 request_create */
	requestHash?: string
	/** NFC pay 等：总金额 USDC6，用于记账（CCSA 时 items[0] 为 points 非 USDC） */
	amountUSDC6?: string
	res: Response
}[] = []

import type { DisplayJsonData } from './displayJsonTypes'
export type { DisplayJsonData } from './displayJsonTypes'

/** 单条 RouteItem 描述（供批量 push） */
export type BeamioTransferRouteItem = {
	asset: string
	amountE6: string
	assetType: number
	source: number
	tokenId: string
}

/** BeamioTransfer / AA→EOA 成功后的 Diamond 记账请求（由 master 排队处理）。支持 USDC 与 CCSA(BeamioUserCard ERC1155) */
export const beamioTransferIndexerAccountingPool: {
	from: string
	to: string
	amountUSDC6: string
	finishedHash: string
	/** 账单附加字符 JSON（DisplayJsonData） */
	displayJson?: string
	/** Bill 支付时 URL 的 requestHash（bytes32），写入 originalPaymentHash 以关联 request_create，便于 UI 分组聚合 */
	requestHash?: string
	/** @deprecated 兼容旧 note */
	note?: string
	/** 金额由 Transaction 表达，此处仅供 meta 的 requestAmountFiat6/currencyFiat 换算 */
	currency?: string
	currencyAmount?: string
	gasWei?: string
	gasUSDC6?: string
	gasChainType?: number
	/** Base 链 gasUsed，供 consumeFromUser 使用 */
	baseGas?: string
	feePayer?: string
	isInternalTransfer?: boolean
	/** 'x402' = BeamioTransfer x402 转账，需扣 2 B-Units；'open-container' = OpenContainer 商户收款，BUnit 由收款方负担 */
	source?: 'x402' | 'open-container'
	/** B 服务费 USDC 6 位精度，写入 FeeInfo.bServiceUSDC6 */
	bServiceUSDC6?: string
	/** B 服务费单位数 6 位精度，写入 FeeInfo.bServiceUnits6 */
	bServiceUnits6?: string
	res?: Response
	/** 多条 route 项（同一 tx 多资产时）。有则优先于 routeAsset */
	routeItems?: BeamioTransferRouteItem[]
	/** CCSA/BeamioUserCard 时：route 资产地址（单条兼容） */
	routeAsset?: string
	/** CCSA 时：1=ERC1155 */
	routeAssetType?: number
	/** CCSA 时：1=UserCardPoint, 2=UserCardCoupon, 3=UserCardCashVoucher */
	routeSource?: number
	/** CCSA 时：ERC1155 tokenId，0=points */
	routeTokenId?: string
	/** CCSA 时：route 的 amountE6（与 amountUSDC6 相同时可省略） */
	routeAmountE6?: string
}[] = []

export const beamioTransferIndexerAccountingProcess = async () => {
	const queueBefore = beamioTransferIndexerAccountingPool.length
	const obj = beamioTransferIndexerAccountingPool.shift()
	if (!obj) {
		return
	}
	logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] dequeue one job (queue ${queueBefore} -> ${beamioTransferIndexerAccountingPool.length}) txHash=${obj.finishedHash}`))
	logger(Colors.cyan(`[beamioTransferIndexerAccountingProcess] 关联钱包: from(payer)=${obj.from} to(payee)=${obj.to}`))
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		logger(Colors.yellow(`[beamioTransferIndexerAccountingProcess] no admin wallet available, requeue txHash=${obj.finishedHash}`))
		beamioTransferIndexerAccountingPool.unshift(obj)
		logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] queue restore -> ${beamioTransferIndexerAccountingPool.length}`))
		return setTimeout(() => beamioTransferIndexerAccountingProcess(), 3000)
	}
	logger(Colors.cyan(`[beamioTransferIndexerAccountingProcess] picked admin=${SC.walletConet.address}, remaining admins=${Settle_ContractPool.length}`))

	try {
		if (!ethers.isAddress(obj.from) || !ethers.isAddress(obj.to)) {
			throw new Error('invalid from/to address')
		}
		// 内部转账及普通转账：payer(from) 与 payee(to) 必须不同，否则记账错误（AA<>EOA 时 from≠to）
		if (obj.from.toLowerCase() === obj.to.toLowerCase()) {
			logger(Colors.red(`[beamioTransferIndexerAccountingProcess] REJECT: from=to (payer=payee) txHash=${obj.finishedHash} addr=${obj.from}`))
			throw new Error('from and to must be different (payer≠payee)')
		}
		const amountUSDC6 = BigInt(obj.amountUSDC6 || '0')
		if (amountUSDC6 <= 0n) {
			throw new Error('amountUSDC6 must be > 0')
		}
		const txHash = String(obj.finishedHash || '')
		if (!ethers.isHexString(txHash) || ethers.dataLength(txHash) !== 32) {
			throw new Error('finishedHash must be bytes32 tx hash')
		}
		let gasWei = BigInt(obj.gasWei ?? '0')
		let gasUSDC6 = BigInt(obj.gasUSDC6 ?? '0')
		const gasChainType = Number(obj.gasChainType ?? 0)
		if (!Number.isInteger(gasChainType) || gasChainType < 0 || gasChainType > 1) {
			throw new Error('gasChainType must be 0 or 1')
		}
		const feePayer = ethers.isAddress(obj.feePayer || '') ? String(obj.feePayer) : obj.from
		const isInternalTransfer = !!obj.isInternalTransfer

		// gasUSDC6 为 0 且有 gasWei 时，通过 BeamioOracle 换算
		if (gasUSDC6 <= 0n && gasWei > 0n) {
			gasUSDC6 = await convertGasWeiToUSDC6(gasWei)
			logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] gasUSDC6 from oracle: gasWei=${gasWei} -> gasUSDC6=${gasUSDC6}`))
		}
		logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] normalized payload txHash=${txHash} from=${obj.from} to=${obj.to} amountUSDC6=${amountUSDC6} gasWei=${gasWei} gasUSDC6=${gasUSDC6} gasChainType=${gasChainType} feePayer=${feePayer}`))

		const BeamioCurrencyMap: Record<string, number> = { CAD: 0, USD: 1, JPY: 2, CNY: 3, USDC: 4, HKD: 5, EUR: 6, SGD: 7, TWD: 8, ETH: 9, BNB: 10, SOLANA: 11, BTC: 12 }
		let requestAmountFiat6 = 0n
		let currencyFiat = 4
		let displayJsonStr: string

		if (obj.displayJson) {
			displayJsonStr = obj.displayJson
			if (obj.currency || obj.currencyAmount != null) {
				const cur = String(obj.currency || 'USDC').toUpperCase()
				currencyFiat = BeamioCurrencyMap[cur] ?? 4
				const amt = obj.currencyAmount
				if (amt != null && amt !== '') {
					const val = parseFloat(String(amt))
					if (!Number.isNaN(val) && val >= 0) requestAmountFiat6 = BigInt(Math.round(val * 1e6))
				}
			}
		} else {
			const noteStr = (obj.note || '').trim()
			let parsed: { currency?: string; currencyAmount?: string | number; forText?: string } = {}
			const jsonMatch = noteStr?.match(/\{[\s\S]*\}/)
			if (jsonMatch) {
				try {
					parsed = JSON.parse(jsonMatch[0]) as typeof parsed
					const cur = String(parsed.currency || obj.currency || 'USDC').toUpperCase()
					currencyFiat = BeamioCurrencyMap[cur] ?? 4
					const amt = parsed.currencyAmount ?? obj.currencyAmount
					if (amt != null && amt !== '') {
						const val = typeof amt === 'number' ? amt : parseFloat(String(amt))
						if (!Number.isNaN(val) && val >= 0) requestAmountFiat6 = BigInt(Math.round(val * 1e6))
					}
				} catch (_) { /* 忽略 */ }
			}
			const forTextPart = noteStr?.split(/\r?\n/)[0]?.trim() || ''
			const handle = (forTextPart && !/^\{/.test(forTextPart) ? forTextPart : (parsed?.forText ?? '')).slice(0, 80)
			displayJsonStr = JSON.stringify({
				title: isInternalTransfer ? 'AA to EOA (Internal)' : 'Beamio Transfer',
				source: isInternalTransfer ? 'aa-eoa' : 'x402',
				finishedHash: txHash,
				handle,
				forText: forTextPart || parsed?.forText || undefined,
			} satisfies DisplayJsonData)
		}
		if (requestAmountFiat6 <= 0n) {
			requestAmountFiat6 = amountUSDC6
			// 不覆盖 currencyFiat：currencyAmount 解析失败（如带 "CA$" 前缀）时，currency 已由 obj.currency 或 parsed 正确传入，应保留
		}
		const discountAmountFiat6 = 0n
		const taxAmountFiat6 = 0n
		const finalRequestAmountFiat6 = requestAmountFiat6 - discountAmountFiat6 + taxAmountFiat6

		const TX_TRANSFER_OUT = ethers.keccak256(ethers.toUtf8Bytes('transfer_out:confirmed'))
		const TX_INTERNAL = ethers.keccak256(ethers.toUtf8Bytes('internal_transfer:confirmed'))
		const TX_REQUEST_FULFILLED = ethers.keccak256(ethers.toUtf8Bytes('request_fulfilled:confirmed'))
		const CHAIN_ID_BASE = 8453n
		const requestHashValid = obj.requestHash && ethers.isHexString(obj.requestHash) && ethers.dataLength(obj.requestHash) === 32
		const originalPaymentHash = requestHashValid ? (obj.requestHash as `0x${string}`) : ethers.ZeroHash
		const txCategory = isInternalTransfer ? TX_INTERNAL : (requestHashValid ? TX_REQUEST_FULFILLED : TX_TRANSFER_OUT)
		logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] requestHash=${obj.requestHash ?? 'n/a'} valid=${requestHashValid} txCategory=${requestHashValid ? 'request_fulfilled' : 'transfer_out'}`))
		const routeItems: { asset: string; amountE6: bigint; assetType: number; source: number; tokenId: bigint; itemCurrencyType: number; offsetInRequestCurrencyE6: bigint }[] = []
		if (obj.routeItems && obj.routeItems.length > 0) {
			for (const r of obj.routeItems) {
				if (!ethers.isAddress(r.asset)) continue
				const amtE6 = BigInt(r.amountE6)
				routeItems.push({
					asset: ethers.getAddress(r.asset),
					amountE6: amtE6,
					assetType: r.assetType ?? 0,
					source: r.source ?? 0,
					tokenId: BigInt(r.tokenId ?? '0'),
					itemCurrencyType: currencyFiat,
					offsetInRequestCurrencyE6: amtE6,
				})
			}
		} else if (obj.routeAsset && ethers.isAddress(obj.routeAsset)) {
			const routeAmt = BigInt(obj.routeAmountE6 ?? obj.amountUSDC6)
			routeItems.push({
				asset: ethers.getAddress(obj.routeAsset),
				amountE6: routeAmt,
				assetType: obj.routeAssetType ?? 1,
				source: obj.routeSource ?? 1,
				tokenId: BigInt(obj.routeTokenId ?? '0'),
				itemCurrencyType: currencyFiat,
				offsetInRequestCurrencyE6: amountUSDC6,
			})
		} else if (isInternalTransfer) {
			routeItems.push({
				asset: ethers.getAddress(USDC_ADDRESS),
				amountE6: amountUSDC6,
				assetType: 0,
				source: 0,
				tokenId: 0n,
				itemCurrencyType: 4,
				offsetInRequestCurrencyE6: amountUSDC6,
			})
		}
		// readme 强约束：isAAAccount=true 时必须提供 route[]；有 routeItems 的 OpenContainer/AA 交易必须 isAAAccount=true
		const hasRouteFromAA = routeItems.length > 0
		const isAAAccount = isInternalTransfer || hasRouteFromAA
		const transactionInput = {
			txId: txHash as `0x${string}`,
			originalPaymentHash,
			chainId: CHAIN_ID_BASE,
			txCategory,
			displayJson: displayJsonStr,
			timestamp: 0n,
			payer: ethers.getAddress(obj.from),
			payee: ethers.getAddress(obj.to),
			finalRequestAmountFiat6,
			finalRequestAmountUSDC6: amountUSDC6,
			isAAAccount,
			route: routeItems,
			fees: {
				gasChainType,
				gasWei,
				gasUSDC6,
				serviceUSDC6: 0n,
				bServiceUSDC6: BigInt(obj.bServiceUSDC6 ?? '0'),
				bServiceUnits6: BigInt(obj.bServiceUnits6 ?? '0'),
				feePayer,
			},
			meta: {
				requestAmountFiat6,
				requestAmountUSDC6: amountUSDC6,
				currencyFiat,
				discountAmountFiat6,
				discountRateBps: 0,
				taxAmountFiat6,
				taxRateBps: 0,
				afterNotePayer: '',
				afterNotePayee: obj.displayJson || obj.note || '',
			},
			operator: ethers.ZeroAddress,
			operatorParentChain: [],
			topAdmin: ethers.ZeroAddress,
			subordinate: ethers.ZeroAddress,
		}

		// BeamioTransfer x402：转账成功后扣 2 B-Units（由 payer 负担）
		if (obj.source === 'x402' && feePayer && feePayer !== ethers.ZeroAddress) {
			const BUNIT_FEE_AMOUNT = 2_000_000n
			const baseHashBytes32 = txHash as `0x${string}`
			const baseGas = BigInt(obj.baseGas ?? '0')
			const bunitAirdropWrite = new ethers.Contract(
				CONET_BUNIT_AIRDROP_ADDRESS,
				['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
				SC.walletConet
			)
			try {
				const consumeTx = await bunitAirdropWrite.consumeFromUser(
					feePayer,
					BUNIT_FEE_AMOUNT,
					baseHashBytes32,
					baseGas,
					BUNIT_KIND_X402_SEND, // kind=5 -> txCategory=keccak256("x402Send")，需预先 registerKind(5,"x402Send")
					{ gasLimit: 2_500_000 }
				)
				await consumeTx.wait()
				logger(Colors.cyan(`[beamioTransferIndexerAccountingProcess] consumeFromUser ok: 2 B-Units from ${feePayer} baseHash=${txHash} (x402Send)`))
			} catch (consumeErr: any) {
				logger(Colors.red(`[beamioTransferIndexerAccountingProcess] consumeFromUser failed (non-fatal): ${consumeErr?.shortMessage ?? consumeErr?.message ?? consumeErr}`))
			}
		}

		// OpenContainer 商户收款：BUnit 由收款方（payee）负担，按 Beamio 收费标准
		if (obj.source === 'open-container' && feePayer && feePayer !== ethers.ZeroAddress) {
			const bunitFeeAmount = BigInt(obj.bServiceUnits6 ?? '2000000')
			const baseHashBytes32 = txHash as `0x${string}`
			const baseGas = BigInt(obj.baseGas ?? '0')
			const bunitAirdropWrite = new ethers.Contract(
				CONET_BUNIT_AIRDROP_ADDRESS,
				['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
				SC.walletConet
			)
			try {
				const consumeTx = await bunitAirdropWrite.consumeFromUser(
					feePayer,
					bunitFeeAmount,
					baseHashBytes32,
					baseGas,
					1n, // kind=1 sendUSDC（与 Container 相同）
					{ gasLimit: 2_500_000 }
				)
				await consumeTx.wait()
				logger(Colors.cyan(`[beamioTransferIndexerAccountingProcess] consumeFromUser ok: ${Number(bunitFeeAmount) / 1e6} B-Units from payee ${feePayer} baseHash=${txHash} (open-container)`))
			} catch (consumeErr: any) {
				logger(Colors.red(`[beamioTransferIndexerAccountingProcess] consumeFromUser failed (non-fatal): ${consumeErr?.shortMessage ?? consumeErr?.message ?? consumeErr}`))
			}
		}

		const actionFacetSync = new ethers.Contract(BeamioTaskIndexerAddress, ACTION_SYNC_TOKEN_ABI, SC.walletConet)
		const conetBalance = await SC.walletConet.provider!.getBalance(SC.walletConet.address).catch(() => 0n)
		if (conetBalance === 0n || conetBalance < 10n ** 14n) {
			logger(Colors.yellow(`[beamioTransferIndexerAccountingProcess] warn: Conet admin ${SC.walletConet.address} balance=${ethers.formatEther(conetBalance)} CNET, may fail syncTokenAction`))
		}
		logger(Colors.cyan(`[beamioTransferIndexerAccountingProcess] send syncTokenAction diamond=${BeamioTaskIndexerAddress} txHash=${txHash}`))
		const tx = await actionFacetSync.syncTokenAction(transactionInput)
		logger(Colors.green(`[beamioTransferIndexerAccountingProcess] syncTokenAction submitted hash=${tx.hash}`))
		await tx.wait().catch((waitErr: any) => {
			logger(Colors.yellow(`[beamioTransferIndexerAccountingProcess] syncTokenAction.wait() failed (RPC): ${waitErr?.shortMessage ?? waitErr?.message ?? String(waitErr)}`))
		})
		logger(Colors.green(`[beamioTransferIndexerAccountingProcess] indexed txHash=${txHash} syncTx=${tx.hash} from=${obj.from} to=${obj.to} amountUSDC6=${amountUSDC6} isInternal=${isInternalTransfer}`))
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(200).json({ success: true, indexed: true, txHash, syncTx: tx.hash }).end()
		}
	} catch (error: any) {
		let msg = error?.shortMessage ?? error?.message ?? String(error)
		if (error?.data) logger(Colors.gray(`[DEBUG] beamioTransferIndexerAccountingProcess revert data=${typeof error.data === 'string' ? error.data : ethers.hexlify(error.data)}`))
		const isTxExists = /tx exists/i.test(msg)
		if (isTxExists) {
			const existingTxHash = String(obj?.finishedHash ?? '')
			logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] txHash=${existingTxHash} already indexed (idempotent OK), skip`))
			if (obj.res && !obj.res.headersSent) {
				obj.res.status(200).json({ success: true, indexed: true, txHash: existingTxHash, alreadyExists: true }).end()
			}
			Settle_ContractPool.unshift(SC)
			setTimeout(() => beamioTransferIndexerAccountingProcess(), 1000)
			return
		}
		const isInsufficientFunds = /insufficient funds for intrinsic transaction cost/i.test(msg)
		if (isInsufficientFunds) {
			msg = `${msg} (Conet 链上 admin ${SC?.walletConet?.address ?? '?'} 需充值 CNET 原生代币以支付 syncTokenAction gas)`
			// 重新入队，待充值后重试
			beamioTransferIndexerAccountingPool.unshift(obj)
			logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] requeued due to insufficient gas, queue=${beamioTransferIndexerAccountingPool.length}`))
		}
		logger(Colors.yellow(`[beamioTransferIndexerAccountingProcess] failed: ${msg}`), inspect(obj, false, 3, true))
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(400).json({ success: false, indexed: false, error: msg }).end()
		}
	}

	Settle_ContractPool.unshift(SC)
	logger(Colors.gray(`[beamioTransferIndexerAccountingProcess] admin wallet returned=${SC.walletConet.address}, admins=${Settle_ContractPool.length}, queue=${beamioTransferIndexerAccountingPool.length}`))
	setTimeout(() => beamioTransferIndexerAccountingProcess(), 1000)
}

/** Beamio Pay Me 生成 request 时的记账请求（txCategory=request_create:confirmed，originalPaymentHash=requestHash） */
export const requestAccountingPool: {
	requestHash: string
	payee: string
	amount: string
	currency: string
	forText?: string
	validDays: number
	displayJson?: string
	feeBUnits?: bigint
	payerEOA?: string
	res?: Response
}[] = []

export const requestAccountingProcess = async () => {
	const obj = requestAccountingPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		requestAccountingPool.unshift(obj)
		return setTimeout(() => requestAccountingProcess(), 3000)
	}
	logger(Colors.cyan(`[requestAccountingProcess] requestHash=${obj.requestHash} payee=${obj.payee}`))
	try {
		if (!ethers.isHexString(obj.requestHash) || ethers.dataLength(obj.requestHash) !== 32) {
			throw new Error('requestHash must be bytes32')
		}
		if (!ethers.isAddress(obj.payee)) {
			throw new Error('invalid payee address')
		}
		const amountVal = parseFloat(obj.amount)
		if (!Number.isFinite(amountVal) || amountVal <= 0) {
			throw new Error('amount must be > 0')
		}
		const validDays = Math.max(1, Math.floor(obj.validDays))
		const nowMs = Date.now()
		const expiresAt = Math.floor(nowMs / 1000) + validDays * 86400

		const BeamioCurrencyMap: Record<string, number> = { CAD: 0, USD: 1, JPY: 2, CNY: 3, USDC: 4, HKD: 5, EUR: 6, SGD: 7, TWD: 8, ETH: 9, BNB: 10, SOLANA: 11, BTC: 12 }
		const cur = String(obj.currency || 'USD').toUpperCase()
		const currencyFiat = BeamioCurrencyMap[cur] ?? 1
		const requestAmountFiat6 = BigInt(Math.round(amountVal * 1e6))
		let finalRequestAmountUSDC6: bigint
		try {
			const rateE18 = await getRateE18Safe(currencyFiat)
			const E18 = 10n ** 18n
			finalRequestAmountUSDC6 = rateE18 > 0n ? (requestAmountFiat6 * rateE18) / E18 : requestAmountFiat6
		} catch (_) {
			finalRequestAmountUSDC6 = currencyFiat === 4 ? requestAmountFiat6 : requestAmountFiat6
		}
		if (finalRequestAmountUSDC6 <= 0n) finalRequestAmountUSDC6 = 1n

		const displayJsonData: DisplayJsonData = obj.displayJson
			? (JSON.parse(obj.displayJson) as DisplayJsonData)
			: {
					title: 'Beamio Request',
					source: 'payme',
					finishedHash: ethers.ZeroHash,
					handle: (obj.forText || '').slice(0, 80),
					forText: obj.forText || undefined,
					validity: { validDays, expiresAt },
			  }
		if (!displayJsonData.validity) {
			displayJsonData.validity = { validDays, expiresAt }
		} else {
			displayJsonData.validity.validDays = validDays
			displayJsonData.validity.expiresAt = expiresAt
		}
		const displayJsonStr = JSON.stringify(displayJsonData)

		const TX_REQUEST_CREATE = ethers.keccak256(ethers.toUtf8Bytes('request_create:confirmed'))
		const CHAIN_ID_BASE = 8453n
		const payeeAddr = ethers.getAddress(obj.payee)
		// request_create：asset=USDC，amountE6=finalRequestAmountUSDC6，itemCurrencyType 沿用 request 的 currency
		const routeItem = {
			asset: ethers.getAddress(USDC_ADDRESS),
			amountE6: finalRequestAmountUSDC6,
			assetType: 0,
			source: 0,
			tokenId: 0n,
			itemCurrencyType: currencyFiat,
			offsetInRequestCurrencyE6: finalRequestAmountUSDC6,
		}
		const transactionInput = {
			txId: obj.requestHash as `0x${string}`,
			originalPaymentHash: obj.requestHash as `0x${string}`,
			chainId: CHAIN_ID_BASE,
			txCategory: TX_REQUEST_CREATE,
			displayJson: displayJsonStr,
			timestamp: BigInt(Math.floor(nowMs / 1000)),
			payer: payeeAddr,
			payee: payeeAddr,
			finalRequestAmountFiat6: requestAmountFiat6,
			finalRequestAmountUSDC6,
			isAAAccount: true,
			route: [routeItem],
			fees: {
				gasChainType: 0,
				gasWei: 0n,
				gasUSDC6: 0n,
				serviceUSDC6: 0n,
				bServiceUSDC6: 0n,
				bServiceUnits6: 0n,
				feePayer: ethers.ZeroAddress,
			},
			meta: {
				requestAmountFiat6,
				requestAmountUSDC6: finalRequestAmountUSDC6,
				currencyFiat,
				discountAmountFiat6: 0n,
				discountRateBps: 0,
				taxAmountFiat6: 0n,
				taxRateBps: 0,
				afterNotePayer: '',
				afterNotePayee: obj.forText || '',
			},
			operator: ethers.ZeroAddress,
			operatorParentChain: [],
			topAdmin: ethers.ZeroAddress,
			subordinate: ethers.ZeroAddress,
		}

		const actionFacetSync = new ethers.Contract(BeamioTaskIndexerAddress, ACTION_SYNC_TOKEN_ABI, SC.walletConet)
		const conetBalance = await SC.walletConet.provider!.getBalance(SC.walletConet.address).catch(() => 0n)
		if (conetBalance === 0n || conetBalance < 10n ** 14n) {
			logger(Colors.yellow(`[requestAccountingProcess] warn: Conet admin ${SC.walletConet.address} balance low`))
		}
		logger(Colors.cyan(`[requestAccountingProcess] syncTokenAction requestHash=${obj.requestHash}`))
		const tx = await actionFacetSync.syncTokenAction(transactionInput)
		logger(Colors.green(`[requestAccountingProcess] syncTokenAction submitted hash=${tx.hash}`))
		await tx.wait().catch((waitErr: any) => {
			logger(Colors.yellow(`[requestAccountingProcess] syncTokenAction.wait() failed: ${waitErr?.shortMessage ?? waitErr?.message ?? String(waitErr)}`))
		})
		// 登记成功后立即回送 UI 200，不等待 B-Unit 扣费，加速 UI 显示
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(200).json({ success: true, indexed: true, requestHash: obj.requestHash, syncTx: tx.hash }).end()
		}
		// 登记成功后向发出方收取 B-Unit 费用（后台执行，不阻塞 UI 响应；SC 在 consumeFromUser 完成后才归还 pool）
		const releaseSC = () => {
			Settle_ContractPool.unshift(SC)
			setTimeout(() => requestAccountingProcess(), 1000)
		}
		if (obj.payerEOA && obj.feeBUnits && obj.feeBUnits > 0n) {
			const syncTxHashBytes32 = tx.hash as `0x${string}` // syncTokenAction 的 CoNET 交易 hash
			const bunitAirdropWrite = new ethers.Contract(
				CONET_BUNIT_AIRDROP_ADDRESS,
				['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
				SC.walletConet
			)
			bunitAirdropWrite
				.consumeFromUser(
					obj.payerEOA,
					obj.feeBUnits,
					syncTxHashBytes32,
					0n, // no Base tx
					4n, // kind=4 requestAccounting
					{ gasLimit: 2_500_000 }
				)
				.then((consumeTx: { wait: () => Promise<unknown> }) => consumeTx.wait())
				.then(() => logger(Colors.cyan(`[requestAccountingProcess] consumeFromUser ok: ${Number(obj.feeBUnits) / 1e6} B-Units from ${obj.payerEOA}`)))
				.catch((consumeErr: any) => logger(Colors.red(`[requestAccountingProcess] consumeFromUser failed (non-fatal): ${consumeErr?.shortMessage ?? consumeErr?.message ?? consumeErr}`)))
				.finally(releaseSC)
		} else {
			releaseSC()
		}
	} catch (error: any) {
		const msg = error?.shortMessage ?? error?.message ?? String(error)
		const logPayload = { requestHash: obj.requestHash, payee: obj.payee, amount: obj.amount, currency: obj.currency, forText: obj.forText, validDays: obj.validDays }
		logger(Colors.yellow(`[requestAccountingProcess] failed: ${msg}`), inspect(logPayload, false, 2, true))
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(400).json({ success: false, indexed: false, error: msg }).end()
		}
		Settle_ContractPool.unshift(SC)
		setTimeout(() => requestAccountingProcess(), 1000)
	}
}

/** Cluster 预检：验证 payeeSignature 的 recover 地址必须是原 request (Transaction) 的 payee，非 payee 不得 cancel */
export const cancelRequestPreCheck = async (originalPaymentHash: string, payeeSignature: string): Promise<{ success: true } | { success: false; error: string }> => {
	if (!ethers.isHexString(originalPaymentHash) || ethers.dataLength(originalPaymentHash) !== 32) {
		return { success: false, error: 'originalPaymentHash must be bytes32' }
	}
	if (typeof payeeSignature !== 'string' || !/^0x[a-fA-F0-9]+$/.test(payeeSignature) || (payeeSignature.length - 2) / 2 !== 65) {
		return { success: false, error: 'payeeSignature must be 65-byte hex' }
	}
	let recoveredAddr: string
	try {
		recoveredAddr = ethers.verifyMessage(ethers.getBytes(originalPaymentHash), payeeSignature)
	} catch (_) {
		return { success: false, error: 'Invalid payeeSignature' }
	}
	const INDEXER_READ_ABI = ['function getTransactionFullByTxId(bytes32 txId) view returns ((bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta))']
	const indexer = new ethers.Contract(BeamioTaskIndexerAddress, INDEXER_READ_ABI, providerConet)
	let full: unknown = null
	try {
		full = await indexer.getTransactionFullByTxId(originalPaymentHash)
	} catch (_) {
		return { success: false, error: 'Request not found' }
	}
	const payeeRaw = full && typeof full === 'object' && 'payee' in full ? (full as { payee?: unknown }).payee : Array.isArray(full) && full.length > 7 ? full[7] : null
	const payeeAddr = payeeRaw && ethers.isAddress(String(payeeRaw)) ? ethers.getAddress(String(payeeRaw)) : null
	if (!payeeAddr) {
		return { success: false, error: 'Request not found' }
	}
	const isAA = full && typeof full === 'object' && 'isAAAccount' in full ? !!(full as { isAAAccount?: boolean }).isAAAccount : Array.isArray(full) && full.length > 10 ? !!full[10] : false
	const recoveredLower = recoveredAddr.toLowerCase()
	const payeeLower = payeeAddr.toLowerCase()
	let isAuthorized = recoveredLower === payeeLower
	if (!isAuthorized && isAA) {
		const AA_FACTORY_ABI = ['function primaryAccountOf(address eoa) view returns (address)']
		const aaFactory = new ethers.Contract(BeamioAAAccountFactoryPaymaster, AA_FACTORY_ABI, providerBaseBackup)
		const primaryAA = await aaFactory.primaryAccountOf(recoveredAddr).catch(() => ethers.ZeroAddress)
		isAuthorized = primaryAA && ethers.getAddress(String(primaryAA)).toLowerCase() === payeeLower
	}
	if (!isAuthorized) {
		return { success: false, error: 'Signature not from payee' }
	}
	return { success: true }
}

/** Payee 取消 Request：验证 payee 对 originalPaymentHash 的签字，创建 request_cancel 记账 */
export const cancelRequestAccountingPool: {
	originalPaymentHash: string
	payeeSignature: string
	res?: Response
}[] = []

export const cancelRequestAccountingProcess = async () => {
	const obj = cancelRequestAccountingPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		cancelRequestAccountingPool.unshift(obj)
		return setTimeout(() => cancelRequestAccountingProcess(), 3000)
	}
	logger(Colors.cyan(`[cancelRequestAccountingProcess] originalPaymentHash=${obj.originalPaymentHash.slice(0, 10)}…`))
	try {
		if (!ethers.isHexString(obj.originalPaymentHash) || ethers.dataLength(obj.originalPaymentHash) !== 32) {
			throw new Error('originalPaymentHash must be bytes32')
		}
		// Cluster 已验签（payeeSignature 必须为原 request 的 payee），Master 信任预检结果，仅取 payee/isAA 用于记账
		// 从 Indexer 获取 request_create（txId = originalPaymentHash）
		const INDEXER_READ_ABI = ['function getTransactionFullByTxId(bytes32 txId) view returns ((bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta))']
		const indexer = new ethers.Contract(BeamioTaskIndexerAddress, INDEXER_READ_ABI, SC.walletConet.provider)
		let full: unknown = null
		try {
			full = await indexer.getTransactionFullByTxId(obj.originalPaymentHash)
		} catch (_) {
			/* request 可能不存在 */
		}
		const payeeRaw = full && typeof full === 'object' && 'payee' in full ? (full as { payee?: unknown }).payee : Array.isArray(full) && full.length > 7 ? full[7] : null
		const payeeAddr = payeeRaw && ethers.isAddress(String(payeeRaw)) ? ethers.getAddress(String(payeeRaw)) : null
		const isAA = full && typeof full === 'object' && 'isAAAccount' in full ? !!(full as { isAAAccount?: boolean }).isAAAccount : Array.isArray(full) && full.length > 10 ? !!full[10] : false
		if (!payeeAddr) {
			throw new Error('Request not found')
		}
		const TX_REQUEST_CANCEL = ethers.keccak256(ethers.toUtf8Bytes('request_cancel:confirmed'))
		const CHAIN_ID_BASE = 8453n
		const nowMs = Date.now()
		const cancelTxId = ethers.keccak256(ethers.solidityPacked(['bytes32', 'string', 'uint256'], [obj.originalPaymentHash, 'cancel', BigInt(Math.floor(nowMs / 1000))]))
		const displayJsonStr = JSON.stringify({ title: 'Request Canceled', source: 'payee', handle: '' })
		// cancel 写入时沿用原 request 的 RouteItem 设定（txId=originalPaymentHash）
		const origRoute = full && typeof full === 'object' && 'route' in full ? (full as { route?: unknown[] }).route : Array.isArray(full) && full.length > 11 ? full[11] : []
		const safeBigInt = (x: unknown): bigint => {
			if (x === undefined || x === null) return 0n
			if (typeof x === 'bigint') return x
			if (typeof x === 'number' && !isNaN(x)) return BigInt(Math.floor(x))
			if (typeof x === 'string') return BigInt(x || '0')
			if (typeof x === 'boolean') return BigInt(x)
			return 0n
		}
		const rawFinal = full && typeof full === 'object' && 'finalRequestAmountUSDC6' in full ? (full as { finalRequestAmountUSDC6?: unknown }).finalRequestAmountUSDC6 : Array.isArray(full) && full.length > 9 ? full[9] : 0
		const finalRequestUSDC6 = safeBigInt(rawFinal)
		const metaObj = full && typeof full === 'object' && 'meta' in full ? (full as { meta?: unknown }).meta : Array.isArray(full) && full.length > 13 ? full[13] : null
		const metaCurrency = metaObj && typeof metaObj === 'object' && 'currencyFiat' in metaObj ? Number((metaObj as { currencyFiat?: unknown }).currencyFiat ?? 1) : Array.isArray(metaObj) && metaObj.length > 2 ? Number(metaObj[2] ?? 1) : 1
		const toRouteItem = (r: unknown) => {
			const v = (k: string | number) => (typeof r === 'object' && r !== null && (k in (r as object)) ? (r as Record<string, unknown>)[k] : Array.isArray(r) ? (r as unknown[])[k as number] : undefined)
			return {
				asset: ethers.getAddress(String(v('asset') ?? v(0) ?? ethers.ZeroAddress)),
				amountE6: safeBigInt(v('amountE6') ?? v(1)),
				assetType: Number(v('assetType') ?? v(2) ?? 0),
				source: Number(v('source') ?? v(3) ?? 0),
				tokenId: safeBigInt(v('tokenId') ?? v(4)),
				itemCurrencyType: Number(v('itemCurrencyType') ?? v(5) ?? 1),
				offsetInRequestCurrencyE6: safeBigInt(v('offsetInRequestCurrencyE6') ?? v(6) ?? v('amountE6') ?? v(1)),
			}
		}
		const cancelRoute = isAA
			? (Array.isArray(origRoute) && origRoute.length > 0
				? origRoute.map(toRouteItem).filter((r) => r.amountE6 > 0n && r.asset !== ethers.ZeroAddress)
				: [] as { asset: string; amountE6: bigint; assetType: number; source: number; tokenId: bigint; itemCurrencyType: number; offsetInRequestCurrencyE6: bigint }[])
			: []
		// 若原 request 无有效 route，fallback：单条 USDC
		const routeForCancel = cancelRoute.length > 0 ? cancelRoute : (isAA && finalRequestUSDC6 > 0n ? [{
			asset: ethers.getAddress(USDC_ADDRESS),
			amountE6: finalRequestUSDC6,
			assetType: 0,
			source: 0,
			tokenId: 0n,
			itemCurrencyType: metaCurrency,
			offsetInRequestCurrencyE6: finalRequestUSDC6,
		}] : [])
		const transactionInput = {
			txId: cancelTxId as `0x${string}`,
			originalPaymentHash: obj.originalPaymentHash as `0x${string}`,
			chainId: CHAIN_ID_BASE,
			txCategory: TX_REQUEST_CANCEL,
			displayJson: displayJsonStr,
			timestamp: BigInt(Math.floor(nowMs / 1000)),
			payer: payeeAddr,
			payee: payeeAddr,
			finalRequestAmountFiat6: 0n,
			finalRequestAmountUSDC6: 0n,
			isAAAccount: isAA,
			route: routeForCancel,
			fees: { gasChainType: 0, gasWei: 0n, gasUSDC6: 0n, serviceUSDC6: 0n, bServiceUSDC6: 0n, bServiceUnits6: 0n, feePayer: ethers.ZeroAddress },
			meta: { requestAmountFiat6: 0n, requestAmountUSDC6: 0n, currencyFiat: 1, discountAmountFiat6: 0n, discountRateBps: 0, taxAmountFiat6: 0n, taxRateBps: 0, afterNotePayer: '', afterNotePayee: '' },
			operator: ethers.ZeroAddress,
			operatorParentChain: [],
			topAdmin: ethers.ZeroAddress,
			subordinate: ethers.ZeroAddress,
		}
		const actionFacetSync = new ethers.Contract(BeamioTaskIndexerAddress, ACTION_SYNC_TOKEN_ABI, SC.walletConet)
		const tx = await actionFacetSync.syncTokenAction(transactionInput)
		logger(Colors.green(`[cancelRequestAccountingProcess] syncTokenAction submitted hash=${tx.hash}`))
		await tx.wait().catch((waitErr: any) => {
			logger(Colors.yellow(`[cancelRequestAccountingProcess] syncTokenAction.wait() failed: ${waitErr?.shortMessage ?? waitErr?.message ?? String(waitErr)}`))
		})
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(200).json({ success: true, indexed: true, originalPaymentHash: obj.originalPaymentHash, syncTx: tx.hash }).end()
		}
	} catch (error: any) {
		const msg = error?.shortMessage ?? error?.message ?? String(error)
		logger(Colors.yellow(`[cancelRequestAccountingProcess] failed: ${msg}`), inspect({ originalPaymentHash: obj.originalPaymentHash?.slice(0, 10) }, false, 2, true))
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(400).json({ success: false, indexed: false, error: msg }).end()
		}
	}
	Settle_ContractPool.unshift(SC)
	setTimeout(() => cancelRequestAccountingProcess(), 1000)
}

/** BUnit Airdrop claimFor：CoNET 上 BUnitAirdrop.claimFor(claimant, nonce, deadline, signature)，使用 walletConet 代付 gas */
const BUNIT_AIRDROP_ABI = [
	'function hasClaimed(address) view returns (bool)',
	'function claimNonces(address) view returns (uint256)',
	'function claimFor(address claimant, uint256 nonce, uint256 deadline, bytes calldata signature)',
] as const

/** EIP-712 domain 与 BUnitAirdrop contract 一致，用于 Cluster 签名预检 */
const CLAIM_AIRDROP_DOMAIN = {
	name: 'BUnitAirdrop',
	version: '1',
	chainId: 224400,
	verifyingContract: CONET_BUNIT_AIRDROP_ADDRESS as `0x${string}`,
}
const CLAIM_AIRDROP_TYPES = {
	ClaimAirdrop: [
		{ name: 'claimant', type: 'address' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export type ClaimBUnitsPayload = {
	claimant: string
	nonce: string | number
	deadline: string | number
	signature: string
	res?: Response
}

export const claimBUnitsPool: ClaimBUnitsPayload[] = []

export const claimBUnitsPreCheck = (body: { claimant?: string; nonce?: unknown; deadline?: unknown; signature?: unknown }): { success: true; preChecked: ClaimBUnitsPayload } | { success: false; error: string } => {
	if (!body.claimant || !ethers.isAddress(body.claimant)) {
		return { success: false, error: 'Invalid claimant address' }
	}
	const nonce = typeof body.nonce === 'string' ? BigInt(body.nonce) : typeof body.nonce === 'number' ? BigInt(Math.floor(body.nonce)) : null
	if (nonce === null || nonce < 0n) {
		return { success: false, error: 'Invalid nonce' }
	}
	const deadline = typeof body.deadline === 'string' ? Number(body.deadline) : typeof body.deadline === 'number' ? body.deadline : null
	if (deadline === null || !Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
		return { success: false, error: 'Invalid or expired deadline' }
	}
	const sig = body.signature
	if (typeof sig !== 'string' || !/^0x[a-fA-F0-9]+$/.test(sig) || (sig.length - 2) / 2 !== 65) {
		return { success: false, error: 'Invalid signature (must be 65 bytes hex)' }
	}
	// Cluster 预检：EIP-712 签名必须由 claimant 本人签署，否则不转发 Master
	const claimant = ethers.getAddress(body.claimant)
	const value = { claimant, nonce, deadline: BigInt(deadline) }
	let recovered: string
	try {
		recovered = ethers.verifyTypedData(CLAIM_AIRDROP_DOMAIN, CLAIM_AIRDROP_TYPES, value, sig)
	} catch {
		return { success: false, error: 'Invalid signature (verification failed)' }
	}
	if (recovered.toLowerCase() !== claimant.toLowerCase()) {
		return { success: false, error: 'Invalid signature: signer does not match claimant' }
	}
	return {
		success: true,
		preChecked: {
			claimant,
			nonce: String(nonce),
			deadline: String(deadline),
			signature: sig,
		},
	}
}

export const claimBUnitsProcess = async () => {
	const obj = claimBUnitsPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		claimBUnitsPool.unshift(obj)
		return setTimeout(() => claimBUnitsProcess(), 3000)
	}
	logger(Colors.cyan(`[claimBUnitsProcess] claimant=${obj.claimant} nonce=${obj.nonce}`))
	try {
		const airdrop = new ethers.Contract(CONET_BUNIT_AIRDROP_ADDRESS, BUNIT_AIRDROP_ABI, SC.walletConet)
		// claimFor 内部会调用 syncTokenAction 向 Indexer 记账，需约 55 万 gas；gas limit 过低会导致 out of gas，claim 成功但 Indexer 无记账
		const tx = await airdrop.claimFor(obj.claimant, obj.nonce, obj.deadline, obj.signature, { gasLimit: 1_200_000 })
		logger(Colors.green(`[claimBUnitsProcess] tx=${tx.hash}`))
		await tx.wait()
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash: tx.hash }).end()
	} catch (e: any) {
		const msg = e?.message ?? String(e)
		logger(Colors.red(`[claimBUnitsProcess] failed:`), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
	Settle_ContractPool.unshift(SC)
	setTimeout(() => claimBUnitsProcess(), 3000)
	}
}

/** MerchantPOSManagement removePOSBySignature：CoNET 上删除 POS */
const MERCHANT_POS_MANAGEMENT_ABI = [
	'function removePOSBySignature(address merchant, address pos, uint256 deadline, bytes32 nonce, bytes calldata signature)',
] as const

export type RemovePOSPayload = {
	merchant: string
	pos: string
	deadline: number
	nonce: string
	signature: string
	res?: Response
}

export const removePOSPool: RemovePOSPayload[] = []

export const removePOSProcess = async () => {
	const obj = removePOSPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		removePOSPool.unshift(obj)
		return setTimeout(() => removePOSProcess(), 3000)
	}
	logger(Colors.cyan(`[removePOSProcess] merchant=${obj.merchant.slice(0, 10)}... pos=${obj.pos.slice(0, 10)}...`))
	try {
		const posMgmt = new ethers.Contract(MERCHANT_POS_MANAGEMENT_CONET, MERCHANT_POS_MANAGEMENT_ABI, SC.walletConet)
		const nonceHex = obj.nonce.startsWith('0x') ? obj.nonce : '0x' + obj.nonce
		const tx = await posMgmt.removePOSBySignature(obj.merchant, obj.pos, obj.deadline, nonceHex, obj.signature)
		logger(Colors.green(`[removePOSProcess] tx=${tx.hash}`))
		await tx.wait()
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash: tx.hash }).end()
	} catch (e: any) {
		const msg = e?.message ?? String(e)
		logger(Colors.red(`[removePOSProcess] failed:`), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => removePOSProcess(), 3000)
	}
}

/** Refuel B-Unit：用户 EIP-3009 签字，Master 提交 BaseTreasury.purchaseBUnitWith3009Authorization */
export type PurchaseBUnitFromBasePayload = {
	from: string
	amount: string
	validAfter: number
	validBefore: number
	nonce: string
	signature: string
	res?: Response
}

export const purchaseBUnitFromBasePreCheck = (body: {
	from?: string
	amount?: string
	validAfter?: unknown
	validBefore?: unknown
	nonce?: string
	signature?: string
}): { success: true; preChecked: PurchaseBUnitFromBasePayload } | { success: false; error: string } => {
	if (!body.from || !ethers.isAddress(body.from)) {
		return { success: false, error: 'Invalid from address' }
	}
	const amount = typeof body.amount === 'string' ? BigInt(body.amount) : null
	const MIN_USDC6 = 1_000_000n  // 1 USDC (6 decimals)
	if (amount === null || amount < MIN_USDC6) {
		return { success: false, error: 'Minimum purchase is 1 USDC' }
	}
	const validAfter = typeof body.validAfter === 'number' ? body.validAfter : typeof body.validAfter === 'string' ? parseInt(body.validAfter, 10) : null
	if (validAfter === null || !Number.isFinite(validAfter) || validAfter < 0) {
		return { success: false, error: 'Invalid validAfter' }
	}
	const validBefore = typeof body.validBefore === 'number' ? body.validBefore : typeof body.validBefore === 'string' ? parseInt(body.validBefore, 10) : null
	const now = Math.floor(Date.now() / 1000)
	if (validBefore === null || !Number.isFinite(validBefore) || validBefore <= now) {
		return { success: false, error: 'Invalid or expired validBefore' }
	}
	const nonce = (body.nonce || '').trim()
	if (!nonce || !ethers.isHexString(nonce) || ethers.dataLength(nonce) !== 32) {
		return { success: false, error: 'Invalid nonce (must be bytes32 hex)' }
	}
	const sig = (body.signature || '').trim()
	if (!sig || !ethers.isHexString(sig)) {
		return { success: false, error: 'Invalid signature (must be hex)' }
	}
	return {
		success: true,
		preChecked: {
			from: ethers.getAddress(body.from),
			amount: String(amount),
			validAfter,
			validBefore,
			nonce: nonce.startsWith('0x') ? nonce : '0x' + nonce,
			signature: sig,
		},
	}
}

export const purchaseBUnitFromBasePool: PurchaseBUnitFromBasePayload[] = []

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_TREASURY_ABI = [
	'function purchaseBUnitWith3009Authorization(address from, address usdc, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature)',
] as const

export const purchaseBUnitFromBaseProcess = async () => {
	const obj = purchaseBUnitFromBasePool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		purchaseBUnitFromBasePool.unshift(obj)
		return setTimeout(() => purchaseBUnitFromBaseProcess(), 3000)
	}
	logger(Colors.cyan(`[purchaseBUnitFromBaseProcess] from=${obj.from.slice(0, 10)}... amount=${obj.amount}`))
	try {
		const treasury = new ethers.Contract(BASE_TREASURY, BASE_TREASURY_ABI, SC.walletBase)
		const nonceBytes32 = obj.nonce.length === 66 ? obj.nonce : ethers.zeroPadValue(obj.nonce, 32)
		const tx = await treasury.purchaseBUnitWith3009Authorization(
			obj.from,
			BASE_USDC,
			obj.amount,
			obj.validAfter,
			obj.validBefore,
			nonceBytes32,
			obj.signature
		)
		logger(Colors.green(`[purchaseBUnitFromBaseProcess] tx=${tx.hash}`))
		try {
			await tx.wait()
		} catch (waitErr: any) {
			// RPC may return malformed batch (e.g. missing eth_getTransactionReceipt response).
			// Tx was already broadcast; return success so client gets txHash. Tx will confirm on chain.
			const waitMsg = waitErr?.message ?? String(waitErr)
			logger(Colors.yellow(`[purchaseBUnitFromBaseProcess] tx.wait() failed (tx sent): ${waitMsg}`))
		}
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, txHash: tx.hash }).end()
	} catch (e: any) {
		const msg = e?.message ?? String(e)
		logger(Colors.red(`[purchaseBUnitFromBaseProcess] failed:`), msg)
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: msg }).end()
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => purchaseBUnitFromBaseProcess(), 3000)
	}
}

const TRANSFER_SINGLE_TOPIC = ethers.id('TransferSingle(address,address,address,uint256,uint256)')

/** cardRedeem 成功后写入 BeamioIndexerDiamond，txCategory=redeemNewCard/redeemUpgradeNewCard/redeemTopupCard */
export const cardRedeemIndexerAccountingProcess = async () => {
	const obj = cardRedeemIndexerAccountingPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		cardRedeemIndexerAccountingPool.unshift(obj)
		return setTimeout(() => cardRedeemIndexerAccountingProcess(), 3000)
	}
	logger(Colors.cyan(`[cardRedeemIndexerAccountingProcess] card=${obj.cardAddress} to=${obj.aaAddress} txHash=${obj.txHash}`))
	try {
		if (!ethers.isAddress(obj.cardAddress) || !ethers.isAddress(obj.aaAddress)) {
			throw new Error('invalid cardAddress or aaAddress')
		}
		const txHash = ethers.hexlify(ethers.getBytes(obj.txHash)).length === 66 ? obj.txHash : ethers.keccak256(obj.txHash as `0x${string}`)
		if (!ethers.isHexString(txHash) || ethers.dataLength(txHash) !== 32) {
			throw new Error('txHash must be bytes32')
		}
		const transferToAa: { tokenId: bigint; value: bigint }[] = []
		try {
			const receipt = await SC.walletBase.provider!.getTransactionReceipt(txHash)
			if (receipt?.logs) {
				const cardAddr = obj.cardAddress.toLowerCase()
				for (const log of receipt.logs) {
					if (log.address.toLowerCase() !== cardAddr || log.topics[0] !== TRANSFER_SINGLE_TOPIC) continue
					const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], log.data)
					const toAddr = log.topics[3] ? ethers.getAddress('0x' + String(log.topics[3]).slice(-40)) : ''
					if (toAddr.toLowerCase() === obj.aaAddress.toLowerCase()) {
						transferToAa.push({ tokenId: decoded[0], value: decoded[1] })
					}
				}
			}
		} catch (_) { /* 解析失败时 transferToAa 为空 */ }
		const pointsItem = transferToAa.find((t) => t.tokenId === 0n)
		const amountE6 = pointsItem && pointsItem.value > 0n ? pointsItem.value : 1n
		const cardContract = new ethers.Contract(obj.cardAddress, BeamioUserCardABI, SC.walletBase)
		const [cardOwner, currencyFiat, priceE6] = await Promise.all([
			cardContract.owner() as Promise<string>,
			cardContract.currency() as Promise<bigint>,
			cardContract.pointsUnitPriceInCurrencyE6() as Promise<bigint>,
		])
		const payerAddr = ethers.isAddress(cardOwner) ? ethers.getAddress(cardOwner) : ethers.ZeroAddress
		if (payerAddr === ethers.ZeroAddress) throw new Error('card owner not found')
		const currencyFiatNum = Number(currencyFiat)
		const finalRequestAmountFiat6 = priceE6 > 0n ? (amountE6 * priceE6) / 1_000_000n : amountE6
		let finalRequestAmountUSDC6: bigint
		try {
			const rateE18 = await getRateE18Safe(currencyFiatNum)
			finalRequestAmountUSDC6 = rateE18 > 0n ? (finalRequestAmountFiat6 * rateE18) / E18 : finalRequestAmountFiat6
		} catch (_) {
			finalRequestAmountUSDC6 = currencyFiatNum === 4 ? finalRequestAmountFiat6 : 0n
		}
		if (finalRequestAmountUSDC6 <= 0n) finalRequestAmountUSDC6 = 1n
		// redeem txCategory: redeemNewCard / redeemUpgradeNewCard / redeemTopupCard
		const hasNewTierInTransfer = transferToAa.some((t) => t.tokenId > 0n)
		const beforeTokenIds = extractTokenIdsFromOwnership(obj.beforeNfts ?? [])
		const redeemCategoryRaw = hasNewTierInTransfer
			? (beforeTokenIds.length > 0 ? 'redeemUpgradeNewCard' : 'redeemNewCard')
			: 'redeemTopupCard'
		const TX_REDEEM = ethers.keccak256(ethers.toUtf8Bytes(redeemCategoryRaw))
		const CHAIN_ID_BASE = 8453n
		const displayJson = JSON.stringify({
			title: redeemCategoryRaw === 'redeemNewCard' ? 'Redeem New Card' : (redeemCategoryRaw === 'redeemUpgradeNewCard' ? 'Redeem Upgrade Card' : 'Redeem Top Up'),
			handle: `Redeem to ${obj.aaAddress.slice(0, 10)}…`,
			finishedHash: txHash,
			source: 'cardRedeem',
			topupCategory: redeemCategoryRaw,
		})
		// TopUp RouteItem per spec: asset=card, assetType=ERC1155, source=UserCardPoint, tokenId=NFT card#, itemCurrencyType=currency, amountE6=topup amount, offsetInRequestCurrencyE6=0
		// tokenId: newly minted tier from transferToAa, or existing tier from getOwnership when points-only redeem
		let tokenIdForRoute = transferToAa.find((t) => t.tokenId > 0n)?.tokenId ?? 0n
		if (tokenIdForRoute === 0n) {
			try {
				const [, nfts] = await cardContract.getOwnership(obj.aaAddress) as [bigint, Array<{ tokenId: bigint }>]
				const tierIds = extractTokenIdsFromOwnership(Array.isArray(nfts) ? nfts : [])
				tokenIdForRoute = tierIds[0] ?? 0n
			} catch (_) { /* keep 0n */ }
		}
		const topupRouteItem = {
			asset: ethers.getAddress(obj.cardAddress),
			amountE6,
			assetType: 1, // ERC1155
			source: 1, // RouteSource.UserCardPoint
			tokenId: tokenIdForRoute,
			itemCurrencyType: currencyFiatNum,
			offsetInRequestCurrencyE6: 0n,
		}
		const routeItems = [topupRouteItem]
		const redeemOperator = (obj.creator && obj.creator !== ethers.ZeroAddress) ? obj.creator : payerAddr
		const redeemOpChain = await fetchOperatorParentChain(obj.cardAddress, redeemOperator)
		const { topAdmin: redeemTopAdmin, subordinate: redeemSubordinate } = deriveTopAdminAndSubordinate(redeemOperator, redeemOpChain)
		const transactionInput = {
			txId: txHash as `0x${string}`,
			originalPaymentHash: ethers.ZeroHash as `0x${string}`,
			chainId: CHAIN_ID_BASE,
			txCategory: TX_REDEEM,
			displayJson,
			timestamp: 0n,
			payer: payerAddr,
			payee: ethers.getAddress(obj.aaAddress),
			finalRequestAmountFiat6,
			finalRequestAmountUSDC6,
			isAAAccount: true,
			route: routeItems,
			fees: {
				gasChainType: 0,
				gasWei: 0n,
				gasUSDC6: 0n,
				serviceUSDC6: 0n,
				bServiceUSDC6: 0n,
				bServiceUnits6: 0n,
				feePayer: ethers.ZeroAddress,
			},
			meta: {
				requestAmountFiat6: finalRequestAmountFiat6,
				requestAmountUSDC6: finalRequestAmountUSDC6,
				currencyFiat: currencyFiatNum,
				discountAmountFiat6: 0n,
				discountRateBps: 0,
				taxAmountFiat6: 0n,
				taxRateBps: 0,
				afterNotePayer: '',
				afterNotePayee: '',
			},
			operator: ethers.getAddress(redeemOperator),
			operatorParentChain: redeemOpChain,
			topAdmin: redeemTopAdmin,
			subordinate: redeemSubordinate,
		}
		const actionFacetSync = new ethers.Contract(BeamioTaskIndexerAddress, ACTION_SYNC_TOKEN_ABI, SC.walletConet)
		const tx = await actionFacetSync.syncTokenAction(transactionInput)
		logger(Colors.green(`[cardRedeemIndexerAccountingProcess] indexed txHash=${txHash} syncTx=${tx.hash} card=${obj.cardAddress}`))
	} catch (error: any) {
		const msg = error?.shortMessage ?? error?.message ?? String(error)
		logger(Colors.yellow(`[cardRedeemIndexerAccountingProcess] failed: ${msg}`), inspect(obj, false, 3, true))
	}
	Settle_ContractPool.unshift(SC)
	setTimeout(() => cardRedeemIndexerAccountingProcess(), 1000)
}

/** Factory.relayContainerMainRelayed 的 ABI 片段 */
const RELAY_MAIN_ABI = {
	inputs: [
		{ internalType: 'address', name: 'account', type: 'address' },
		{ internalType: 'address', name: 'to', type: 'address' },
		{
			internalType: 'struct IBeamioContainerModuleV07.ContainerItem[]',
			name: 'items',
			type: 'tuple[]',
			components: [
				{ internalType: 'uint8', name: 'kind', type: 'uint8' },
				{ internalType: 'address', name: 'asset', type: 'address' },
				{ internalType: 'uint256', name: 'amount', type: 'uint256' },
				{ internalType: 'uint256', name: 'tokenId', type: 'uint256' },
				{ internalType: 'bytes', name: 'data', type: 'bytes' },
			],
		},
		{ internalType: 'uint256', name: 'nonce_', type: 'uint256' },
		{ internalType: 'uint256', name: 'deadline_', type: 'uint256' },
		{ internalType: 'bytes', name: 'sig', type: 'bytes' },
	],
	name: 'relayContainerMainRelayed',
	outputs: [],
	stateMutability: 'nonpayable' as const,
	type: 'function' as const,
}

/** Factory.relayContainerMainRelayedOpen 的 ABI 片段，与 BeamioContainerModuleV07.containerMainRelayedOpen(to, items, currencyType, maxAmount, nonce_, deadline_, sig) 一致，无 token */
const RELAY_OPEN_ABI = {
	inputs: [
		{ internalType: 'address', name: 'account', type: 'address' },
		{ internalType: 'address', name: 'to', type: 'address' },
		{
			internalType: 'struct IBeamioContainerModuleV07.ContainerItem[]',
			name: 'items',
			type: 'tuple[]',
			components: [
				{ internalType: 'uint8', name: 'kind', type: 'uint8' },
				{ internalType: 'address', name: 'asset', type: 'address' },
				{ internalType: 'uint256', name: 'amount', type: 'uint256' },
				{ internalType: 'uint256', name: 'tokenId', type: 'uint256' },
				{ internalType: 'bytes', name: 'data', type: 'bytes' },
			],
		},
		{ internalType: 'uint8', name: 'currencyType', type: 'uint8' },
		{ internalType: 'uint256', name: 'maxAmount', type: 'uint256' },
		{ internalType: 'uint256', name: 'nonce_', type: 'uint256' },
		{ internalType: 'uint256', name: 'deadline_', type: 'uint256' },
		{ internalType: 'bytes', name: 'sig', type: 'bytes' },
	],
	name: 'relayContainerMainRelayedOpen',
	outputs: [],
	stateMutability: 'nonpayable' as const,
	type: 'function' as const,
}

/** 预检：OpenContainerRelayPayload 格式与签名长度校验 */
export const OpenContainerRelayPreCheck = (payload: OpenContainerRelayPayload | undefined): { success: boolean; error?: string } => {
	if (!payload || typeof payload !== 'object') return { success: false, error: 'openContainerPayload required' }
	if (!ethers.isAddress(payload.account)) return { success: false, error: 'openContainerPayload.account must be a valid address' }
	if (!ethers.isAddress(payload.to)) return { success: false, error: 'openContainerPayload.to must be a valid address' }
	if (!Array.isArray(payload.items) || payload.items.length === 0) return { success: false, error: 'openContainerPayload.items must be a non-empty array' }
	for (let i = 0; i < payload.items.length; i++) {
		const it = payload.items[i]
		if (it == null || typeof it !== 'object') return { success: false, error: `openContainerPayload.items[${i}] invalid` }
		if (typeof it.kind !== 'number') return { success: false, error: `openContainerPayload.items[${i}].kind must be number` }
		if (!ethers.isAddress(it.asset)) return { success: false, error: `openContainerPayload.items[${i}].asset must be address` }
		if (it.amount === undefined || it.amount === null) return { success: false, error: `openContainerPayload.items[${i}].amount required` }
		if (it.tokenId === undefined || it.tokenId === null) return { success: false, error: `openContainerPayload.items[${i}].tokenId required` }
		if (it.data === undefined || it.data === null) return { success: false, error: `openContainerPayload.items[${i}].data required` }
	}
	if (typeof payload.currencyType !== 'number') return { success: false, error: 'openContainerPayload.currencyType must be number' }
	if (payload.maxAmount === undefined || payload.maxAmount === null) return { success: false, error: 'openContainerPayload.maxAmount required' }
	if (payload.nonce === undefined || payload.nonce === null) return { success: false, error: 'openContainerPayload.nonce required' }
	if (payload.deadline === undefined || payload.deadline === null) return { success: false, error: 'openContainerPayload.deadline required' }
	if (payload.signature === undefined || payload.signature === null) return { success: false, error: 'openContainerPayload.signature required' }
	const sigHex = typeof payload.signature === 'string' && payload.signature.startsWith('0x') ? payload.signature : '0x' + (payload.signature || '')
	const sigLen = sigHex.length <= 2 ? 0 : (sigHex.length - 2) / 2
	if (sigLen !== 65) return { success: false, error: `openContainerPayload.signature must be 65 bytes (130 hex chars), got ${sigLen}` }
	logger(`[AAtoEOA/OpenContainer] pre-check OK account=${payload.account} to=${payload.to} items=${payload.items.length}`)
	return { success: true }
}

/** 预检：ContainerRelayPayload（containerMainRelayed 绑定 to）格式与签名长度校验 */
export const ContainerRelayPreCheck = (payload: ContainerRelayPayload | undefined): { success: boolean; error?: string } => {
	if (!payload || typeof payload !== 'object') return { success: false, error: 'containerPayload required' }
	if (!ethers.isAddress(payload.account)) return { success: false, error: 'containerPayload.account must be a valid address' }
	if (!ethers.isAddress(payload.to)) return { success: false, error: 'containerPayload.to must be a valid address' }
	if (!Array.isArray(payload.items) || payload.items.length === 0) return { success: false, error: 'containerPayload.items must be a non-empty array' }
	for (let i = 0; i < payload.items.length; i++) {
		const it = payload.items[i]
		if (it == null || typeof it !== 'object') return { success: false, error: `containerPayload.items[${i}] invalid` }
		if (typeof it.kind !== 'number') return { success: false, error: `containerPayload.items[${i}].kind must be number` }
		if (!ethers.isAddress(it.asset)) return { success: false, error: `containerPayload.items[${i}].asset must be address` }
		if (it.amount === undefined || it.amount === null) return { success: false, error: `containerPayload.items[${i}].amount required` }
		if (it.tokenId === undefined || it.tokenId === null) return { success: false, error: `containerPayload.items[${i}].tokenId required` }
		if (it.data === undefined || it.data === null) return { success: false, error: `containerPayload.items[${i}].data required` }
	}
	if (payload.nonce === undefined || payload.nonce === null) return { success: false, error: 'containerPayload.nonce required' }
	if (payload.deadline === undefined || payload.deadline === null) return { success: false, error: 'containerPayload.deadline required' }
	if (payload.signature === undefined || payload.signature === null) return { success: false, error: 'containerPayload.signature required' }
	const sigHex = typeof payload.signature === 'string' && payload.signature.startsWith('0x') ? payload.signature : '0x' + (payload.signature || '')
	const sigLen = sigHex.length <= 2 ? 0 : (sigHex.length - 2) / 2
	if (sigLen !== 65) return { success: false, error: `containerPayload.signature must be 65 bytes (130 hex chars), got ${sigLen}` }
	logger(`[AAtoEOA/Container] pre-check OK account=${payload.account} to=${payload.to} items=${payload.items.length}`)
	return { success: true }
}

/** 预检：未签名 container（供 payByNfcUidSignContainer 使用） */
export const ContainerRelayPreCheckUnsigned = (payload: ContainerRelayPayloadUnsigned | undefined): { success: boolean; error?: string } => {
	if (!payload || typeof payload !== 'object') return { success: false, error: 'containerPayload required' }
	if (!ethers.isAddress(payload.account)) return { success: false, error: 'containerPayload.account must be a valid address' }
	if (!ethers.isAddress(payload.to)) return { success: false, error: 'containerPayload.to must be a valid address' }
	if (!Array.isArray(payload.items) || payload.items.length === 0) return { success: false, error: 'containerPayload.items must be a non-empty array' }
	for (let i = 0; i < payload.items.length; i++) {
		const it = payload.items[i]
		if (it == null || typeof it !== 'object') return { success: false, error: `containerPayload.items[${i}] invalid` }
		if (typeof it.kind !== 'number') return { success: false, error: `containerPayload.items[${i}].kind must be number` }
		if (!ethers.isAddress(it.asset)) return { success: false, error: `containerPayload.items[${i}].asset must be address` }
		if (it.amount === undefined || it.amount === null) return { success: false, error: `containerPayload.items[${i}].amount required` }
		if (it.tokenId === undefined || it.tokenId === null) return { success: false, error: `containerPayload.items[${i}].tokenId required` }
		if (it.data === undefined || it.data === null) return { success: false, error: `containerPayload.items[${i}].data required` }
	}
	if (payload.nonce === undefined || payload.nonce === null) return { success: false, error: 'containerPayload.nonce required' }
	if (payload.deadline === undefined || payload.deadline === null) return { success: false, error: 'containerPayload.deadline required' }
	return { success: true }
}

/** 与 BeamioContainerModuleV07 一致：hashItem = keccak256(abi.encode(uint8(kind), asset, amount, tokenId, keccak256(data))) */
function hashContainerItem(it: { kind: number; asset: string; amount: string | bigint; tokenId: string | bigint; data: string }): string {
	const dataHex = typeof it.data === 'string' && it.data.startsWith('0x') ? it.data : '0x'
	const dataHash = ethers.keccak256(ethers.getBytes(dataHex))
	const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
		['uint8', 'address', 'uint256', 'uint256', 'bytes32'],
		[it.kind as 0 | 1, it.asset, BigInt(it.amount), BigInt(it.tokenId), dataHash]
	)
	return ethers.keccak256(encoded)
}

/** 与 BeamioContainerModuleV07 一致：hashItems = keccak256(abi.encode(bytes32[])) */
function hashContainerItems(items: { kind: number; asset: string; amount: string | bigint; tokenId: string | bigint; data: string }[]): string {
	const hashes = items.map((it) => hashContainerItem(it))
	return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [hashes]))
}

/** 与 BeamioContainerStorageV07 布局一致：从 AA 账户 storage 读 container module 的 relayedNonce / openRelayedNonce */
function containerNonceSlotBase(): bigint {
	const slotHex = ethers.keccak256(ethers.toUtf8Bytes('beamio.container.module.storage.v07'))
	return BigInt(slotHex)
}

export async function readContainerNonceFromAAStorage(
	provider: ethers.Provider,
	aaAccount: string,
	kind: 'relayed' | 'openRelayed'
): Promise<bigint> {
	const base = containerNonceSlotBase()
	const slot = kind === 'relayed' ? base : base + 1n
	const raw = await provider.getStorage(aaAccount, slot)
	return BigInt(raw)
}

/** 预检：集群节点对 AAtoEOA 请求做格式与基本校验，合格再转 master。 */
export const AAtoEOAPreCheck = (toEOA: string, amountUSDC6: string, packedUserOp: AAtoEOAUserOp | undefined): { success: boolean; error?: string } => {
	if (!toEOA || !ethers.isAddress(toEOA)) return { success: false, error: 'Invalid toEOA address' }
	const amount = BigInt(amountUSDC6)
	if (amount <= 0n) return { success: false, error: 'amountUSDC6 must be positive' }
	if (!packedUserOp || typeof packedUserOp !== 'object') return { success: false, error: 'packedUserOp required' }
	if (!packedUserOp.sender || !ethers.isAddress(packedUserOp.sender)) return { success: false, error: 'packedUserOp.sender must be a valid AA address' }
	if (packedUserOp.callData === undefined || packedUserOp.callData === null) return { success: false, error: 'packedUserOp.callData required' }
	if (packedUserOp.signature === undefined || packedUserOp.signature === null) return { success: false, error: 'packedUserOp.signature required' }
	logger(`[AAtoEOA] pre-check OK toEOA=${toEOA} amountUSDC6=${amountUSDC6} sender=${packedUserOp.sender}`)
	return { success: true }
}

/** Worker 预检：sender 必须有合约 code（拒绝 EOA），在转发到 master 前调用，避免 AA93。 */
export const AAtoEOAPreCheckSenderHasCode = async (packedUserOp: AAtoEOAUserOp): Promise<{ success: boolean; error?: string }> => {
	const code = await providerBaseBackup.getCode(packedUserOp.sender)
	if (!code || code === '0x' || code.length <= 2) {
		return { success: false, error: 'Invalid sender: must be the Smart Account contract (with code), not the EOA. Use primaryAccountOf(owner) as sender.' }
	}
	return { success: true }
}

/** 从 mintPointsByAdmin data 解析 recipient 与 points6 */
const tryParseMintPointsByAdminArgs = (data: string): { recipient: string; points6: bigint } | null => {
	try {
		const iface = new ethers.Interface(['function mintPointsByAdmin(address user, uint256 points6)'])
		const decoded = iface.parseTransaction({ data })
		if (decoded?.name === 'mintPointsByAdmin' && decoded.args[0] != null && decoded.args[1] != null) {
			return { recipient: decoded.args[0] as string, points6: BigInt(decoded.args[1]) }
		}
	} catch { /* ignore */ }
	return null
}

type CardTier = {
	index: number
	minUsdc6: bigint
	attr: bigint
	tierExpirySeconds: bigint
	upgradeByBalance: boolean
}

const MAX_CARD_TIER_SCAN = 256

/**
 * 新卡 tier 读取：
 * - 直接使用 public tiers(uint256) getter
 * - 越界时 RPC/合约会 revert，此时停止扫描
 */
const readCardTiers = async (
	card: ethers.Contract,
	cardAddress: string
): Promise<CardTier[]> => {
	const tiers: CardTier[] = []
	for (let i = 0; i < MAX_CARD_TIER_SCAN; i++) {
		try {
			const tier = await card.tiers(i) as [bigint, bigint, bigint, boolean]
			tiers.push({
				index: i,
				minUsdc6: BigInt(tier[0]),
				attr: BigInt(tier[1]),
				tierExpirySeconds: BigInt(tier[2]),
				upgradeByBalance: Boolean(tier[3]),
			})
		} catch {
			break
		}
	}
	if (tiers.length === 0) {
		logger(Colors.gray(`[readCardTiers] no tiers found for ${cardAddress}`))
	}
	return tiers
}

/** Cluster 预检（USDC topup）：卡发行方 owner 的 B-Units 是否足够。
 * 规则：
 * 1) 用户不拥有可用卡 NFT（需发行新卡）=> 99 B-Units（kind=issueCard）
 * 2) 用户会因本次 topup 升级并获得新 tier NFT => 99 B-Units（kind=issueCard）
 * 3) 其余普通 topup => 2 B-Units（kind=cardTopup）
 */
export const nfcTopupPreCheckBUnitFee = async (
	cardAddr: string,
	data: string
): Promise<{ success: boolean; error?: string; cardOwnerEOA?: string; feeAmount?: bigint; topupKind?: 2 | 3 }> => {
	const FEE_REGULAR = 2_000_000n
	const FEE_ISSUE_CARD = 99_000_000n
	const KIND_CARD_TOPUP = 2
	const KIND_ISSUE_CARD = 3
	try {
		const parsed = tryParseMintPointsByAdminArgs(data)
		if (!parsed || !ethers.isAddress(parsed.recipient)) {
			return { success: false, error: 'Invalid mintPointsByAdmin payload' }
		}
		const cardAbi = [
			'function owner() view returns (address)',
			'function factoryGateway() view returns (address)',
			'function activeMembershipId(address) view returns (uint256)',
			'function activeTierIndexOrMax(address) view returns (uint256)',
			'function balanceOf(address,uint256) view returns (uint256)',
			'function tiers(uint256) view returns (uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds, bool upgradeByBalance)',
			'function getOwnershipByEOA(address) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
		]
		const factoryAbi = ['function _aaFactory() view returns (address)']
		const aaFactoryAbi = ['function beamioAccountOf(address) view returns (address)']
		const card = new ethers.Contract(cardAddr, cardAbi, providerBaseBackup)
		const rawOwner = await card.owner()
		const resolveResult = await resolveCardOwnerToEOA(providerBaseBackup, rawOwner)
		if (!resolveResult.success) {
			return { success: false, error: resolveResult.error ?? 'Cannot resolve card owner to EOA' }
		}
		const cardOwnerEOA = resolveResult.cardOwner
		const gateway = await card.factoryGateway()
		const factory = new ethers.Contract(gateway, factoryAbi, providerBaseBackup)
		const aaFactoryAddr = await factory._aaFactory()
		const aaFactory = new ethers.Contract(aaFactoryAddr, aaFactoryAbi, providerBaseBackup)
		const recipientAA = await aaFactory.beamioAccountOf(parsed.recipient)
		let requiresIssueOrUpgrade = false
		if (!recipientAA || recipientAA === ethers.ZeroAddress) {
			requiresIssueOrUpgrade = true
		} else {
			const [activeId, activeTierIdx, ownership, tiers] = await Promise.all([
				card.activeMembershipId(recipientAA),
				card.activeTierIndexOrMax(recipientAA),
				card.getOwnershipByEOA(parsed.recipient) as Promise<[bigint, Array<{ tokenId: bigint; tierIndexOrMax: bigint; isExpired: boolean }>]>,
				readCardTiers(card, cardAddr),
			])
			const MAX_UINT = 2n ** 256n - 1n
			const nfts = ownership[1] ?? []
			const hasUsableMembershipNft = nfts.some((n: { isExpired: boolean }) => !n.isExpired)
			// 用户不拥有可用卡 NFT：按发行新卡收费
			if (!hasUsableMembershipNft || activeId === 0n || activeTierIdx >= MAX_UINT) {
				requiresIssueOrUpgrade = true
			} else if (tiers.length > 0 && activeTierIdx < BigInt(tiers.length - 1)) {
				const nextTierIdx = activeTierIdx + 1n
				const alreadyHasNextTier = nfts.some(
					(n: { tierIndexOrMax: bigint; isExpired: boolean }) =>
						n.tierIndexOrMax === nextTierIdx && !n.isExpired
				)
				if (!alreadyHasNextTier) {
					const nextTier = tiers[Number(nextTierIdx)]
					const pointsBalance = await card.balanceOf(recipientAA, 0)
					if (nextTier?.upgradeByBalance) {
						if (pointsBalance + parsed.points6 >= nextTier.minUsdc6) requiresIssueOrUpgrade = true
					} else {
						if (nextTier && parsed.points6 >= nextTier.minUsdc6) requiresIssueOrUpgrade = true
					}
				}
			}
		}
		const feeAmount = requiresIssueOrUpgrade ? FEE_ISSUE_CARD : FEE_REGULAR
		const topupKind = (requiresIssueOrUpgrade ? KIND_ISSUE_CARD : KIND_CARD_TOPUP) as 2 | 3
		const bunitAirdropRead = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			['function getBUnitBalance(address) view returns (uint256)'],
			providerConet
		)
		const balance = await bunitAirdropRead.getBUnitBalance(cardOwnerEOA)
		if (balance < feeAmount) {
			return {
				success: false,
				error: `Insufficient B-Units: card issuer needs ${Number(feeAmount) / 1e6} B-Units for this topup (balance: ${Number(balance) / 1e6} B-Units)`,
			}
		}
		return { success: true, cardOwnerEOA, feeAmount, topupKind }
	} catch (e: any) {
		return {
			success: false,
			error: `Topup B-Unit fee check failed: ${e?.shortMessage ?? e?.message ?? String(e)}`,
		}
	}
}

/** Cluster 预检：requestAccounting 向发出方（payee）收费。0.8% 金额（换算 USDC），最低 2、最高 200 B-Units；金额>=5000 USDC 时 500 B-Units。不足则拒绝。 */
export const requestAccountingPreCheckBUnitFee = async (
	payee: string,
	amount: string,
	currency: string
): Promise<{ success: boolean; error?: string; feeAmount?: bigint; payerEOA?: string }> => {
	const BeamioCurrencyMap: Record<string, number> = { CAD: 0, USD: 1, JPY: 2, CNY: 3, USDC: 4, HKD: 5, EUR: 6, SGD: 7, TWD: 8, ETH: 9, BNB: 10, SOLANA: 11, BTC: 12 }
	const cur = String(currency || 'USD').toUpperCase()
	const currencyFiat = BeamioCurrencyMap[cur] ?? 1
	const amountVal = parseFloat(amount)
	if (!Number.isFinite(amountVal) || amountVal <= 0) {
		return { success: false, error: 'amount must be > 0' }
	}
	const requestAmountFiat6 = BigInt(Math.round(amountVal * 1e6))
	let amountUSDC6: bigint
	try {
		const rateE18 = await getRateE18Safe(currencyFiat)
		const E18 = 10n ** 18n
		amountUSDC6 = rateE18 > 0n ? (requestAmountFiat6 * rateE18) / E18 : requestAmountFiat6
	} catch (_) {
		amountUSDC6 = currencyFiat === 4 ? requestAmountFiat6 : requestAmountFiat6
	}
	if (amountUSDC6 <= 0n) amountUSDC6 = 1n

	// 0.8% of amount in USDC; 1 B-Unit = 0.01 USDC => feeBUnits6 = amountUSDC6 * 0.008 * 100 = amountUSDC6 * 0.8
	let feeBUnits6 = (amountUSDC6 * 8n * 100n) / 1000n
	const FEE_MIN = 2_000_000n
	const FEE_MAX = 200_000_000n
	const FEE_5000_USDC = 500_000_000n
	const FIVE_THOUSAND_USDC6 = 5000n * 1_000_000n
	if (amountUSDC6 >= FIVE_THOUSAND_USDC6) {
		feeBUnits6 = FEE_5000_USDC
	} else {
		if (feeBUnits6 < FEE_MIN) feeBUnits6 = FEE_MIN
		if (feeBUnits6 > FEE_MAX) feeBUnits6 = FEE_MAX
	}

	// Resolve payee to EOA (AA owner or EOA)
	let payerEOA: string
	const code = await providerBaseBackup.getCode(payee)
	if (code && code !== '0x' && code.length > 2) {
		const aaRead = new ethers.Contract(payee, ['function owner() view returns (address)'], providerBaseBackup)
		const owner = await aaRead.owner()
		if (!owner || owner === ethers.ZeroAddress) {
			return { success: false, error: 'Cannot determine payee owner for B-Unit fee check' }
		}
		payerEOA = ethers.getAddress(owner)
	} else {
		payerEOA = ethers.getAddress(payee)
	}

	const bunitAirdropRead = new ethers.Contract(
		CONET_BUNIT_AIRDROP_ADDRESS,
		['function getBUnitBalance(address) view returns (uint256)'],
		providerConet
	)
	const balance = await bunitAirdropRead.getBUnitBalance(payerEOA)
	if (balance < feeBUnits6) {
		return {
			success: false,
			error: `Insufficient B-Units: payee needs ${Number(feeBUnits6) / 1e6} B-Units for requestAccounting (balance: ${Number(balance) / 1e6} B-Units)`,
		}
	}
	return { success: true, feeAmount: feeBUnits6, payerEOA }
}

/** UI 预检：转账前检查 B-Unit 是否 >= 2。account 为 EOA；aaAddress 为 AA 时解析 owner 后检查。 */
export const transferPreCheckBUnit = async (opts: { account?: string; aaAddress?: string }): Promise<{ success: boolean; error?: string }> => {
	const BUNIT_FEE_AMOUNT = 2_000_000n
	let payerEOA: string
	if (opts.account && ethers.isAddress(opts.account)) {
		payerEOA = ethers.getAddress(opts.account)
	} else if (opts.aaAddress && ethers.isAddress(opts.aaAddress)) {
		const aaRead = new ethers.Contract(opts.aaAddress, ['function owner() view returns (address)'], providerBaseBackup)
		const owner = await aaRead.owner()
		if (!owner || owner === ethers.ZeroAddress) {
			return { success: false, error: 'Cannot determine AA owner for B-Unit fee check' }
		}
		payerEOA = ethers.getAddress(owner)
	} else {
		return { success: false, error: 'Missing account or aaAddress' }
	}
	try {
		const bunitAirdropRead = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			['function getBUnitBalance(address) view returns (uint256)'],
			providerConet
		)
		const balance = await bunitAirdropRead.getBUnitBalance(payerEOA)
		if (balance < BUNIT_FEE_AMOUNT) {
			return {
				success: false,
				error: `Insufficient B-Units: payer needs 2 B-Units for transfer fee (balance: ${Number(balance) / 1e6} B-Units)`,
			}
		}
		return { success: true }
	} catch (e: any) {
		return {
			success: false,
			error: `B-Unit balance check failed: ${e?.shortMessage ?? e?.message ?? String(e)}`,
		}
	}
}

/** Cluster 预检：AA owner 的 B-Unit 余额必须 >= 2（手续费）。Master 不再重复检查。 */
export const AAtoEOAPreCheckBUnitBalance = async (packedUserOp: AAtoEOAUserOp): Promise<{ success: boolean; error?: string }> => {
	const BUNIT_FEE_AMOUNT = 2_000_000n // 2 B-Units (6 decimals)
	try {
		const aaRead = new ethers.Contract(
			packedUserOp.sender,
			['function owner() view returns (address)'],
			providerBaseBackup
		)
		const aaOwner = await aaRead.owner()
		if (!aaOwner || aaOwner === ethers.ZeroAddress) {
			return { success: false, error: 'Cannot determine AA owner for B-Unit fee check' }
		}
		const bunitAirdropRead = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			['function getBUnitBalance(address) view returns (uint256)'],
			providerConet
		)
		const balance = await bunitAirdropRead.getBUnitBalance(aaOwner)
		if (balance < BUNIT_FEE_AMOUNT) {
			return {
				success: false,
				error: `Insufficient B-Units to pay fee (2 required, balance: ${Number(balance) / 1e6} B-Units)`,
			}
		}
		return { success: true }
	} catch (e: any) {
		return {
			success: false,
			error: `B-Unit balance check failed: ${e?.shortMessage ?? e?.message ?? String(e)}`,
		}
	}
}

/** Cluster 预检：Container 路径下 AA owner 的 B-Unit 余额必须 >= 2（手续费）。 */
export const ContainerRelayPreCheckBUnitBalance = async (containerPayload: ContainerRelayPayload): Promise<{ success: boolean; error?: string }> => {
	const BUNIT_FEE_AMOUNT = 2_000_000n // 2 B-Units (6 decimals)
	try {
		const account = ethers.getAddress(containerPayload.account)
		const aaRead = new ethers.Contract(
			account,
			['function owner() view returns (address)'],
			providerBaseBackup
		)
		const aaOwner = await aaRead.owner()
		if (!aaOwner || aaOwner === ethers.ZeroAddress) {
			return { success: false, error: 'Cannot determine AA owner for B-Unit fee check' }
		}
		const bunitAirdropRead = new ethers.Contract(
			CONET_BUNIT_AIRDROP_ADDRESS,
			['function getBUnitBalance(address) view returns (uint256)'],
			providerConet
		)
		const balance = await bunitAirdropRead.getBUnitBalance(aaOwner)
		if (balance < BUNIT_FEE_AMOUNT) {
			return {
				success: false,
				error: `Insufficient B-Units to pay fee (2 required, balance: ${Number(balance) / 1e6} B-Units)`,
			}
		}
		return { success: true }
	} catch (e: any) {
		return {
			success: false,
			error: `B-Unit balance check failed: ${e?.shortMessage ?? e?.message ?? String(e)}`,
		}
	}
}

const ACTION_TOKEN_TYPE = {
	TOKEN_MINT: 1,
	TOKEN_BURN: 2,
	TOKEN_TRANSFER: 3
}

const getICurrency = (currency: BigInt): ICurrency => {
	switch (currency) {
		case 0n:
			return 'CAD'
		case 1n:
			return 'USD'
		case 2n:
			return 'JPY'
		case 3n:
			return 'CNY'
		case 4n:
			return 'USDC'
		case 5n:
			return 'HKD'
		case 6n:
			return 'EUR'
		case 7n:
			return 'SGD'
		case 8n:
			return 'TWD'
		default:
			return 'USDC'
	}
}


/** 新部署的 CCSA 卡（1 CAD = 1 token），与 chainAddresses.BASE_CCSA_CARD_ADDRESS 一致 */
const CCSACardAddressNew = BASE_CCSA_CARD_ADDRESS.toLowerCase()

type payMe = {
	currency: ICurrency
	currencyAmount: string
	currencyTip?: string
	currencyDiscount?: string
	currencyDiscountAmount?: string
	tip?: number
	parentHash?: string
	oneTimeMode?: boolean
	code?: string
	title?: string
	currencyTax?: string
	usdcAmount?: number
	depositHash?: string
	/** 请求 URL 的 forText 备注（Bill 支付） */
	forText?: string
}

const cardNote = (
	cardAddress: string,
	usdcAmount: string,
	currency: ICurrency,
	parentHash: string,
	currencyAmount: string,
	isMember: boolean,
	cardDisplayName?: string
): payMe | null => {

	const payMe: payMe = {
		currency,
		currencyAmount,
		title: ``,
		usdcAmount: Number(usdcAmount),
		parentHash
	}

	logger(Colors.green(`✅ cardNote cardAddress = ${cardAddress} == '${CCSACardAddressNew}' isMember = ${isMember} usdcAmount = ${usdcAmount} currencyAmount = ${currencyAmount} parentHash = ${parentHash}`));
	const name = (cardDisplayName ?? '').trim()
	payMe.title = isMember ? 'Top Up' : (name || (cardAddress.toLowerCase() === CCSACardAddressNew ? 'CCSA Membership' : 'Membership'))
	// switch (cardAddress.toLowerCase()) {
	// 	case CCSACardAddressNew:{
	// 		payMe.title = isMember ? `Top Up` : `CCSA Membership`
	// 		return payMe
	// 	}
		
	// 	default:

	// 		return null
	// }
	return payMe
}

type PurchasingCardAccountingInput = {
	txId: `0x${string}`
	originalPaymentHash: `0x${string}`
	chainId: bigint
	txCategory: `0x${string}`
	displayJson: string
	timestamp: bigint
	payer: string
	payee: string
	finalRequestAmountFiat6: bigint
	finalRequestAmountUSDC6: bigint
	isAAAccount: boolean
	route: {
		asset: string
		amountE6: bigint
		assetType: number
		source: number
		tokenId: bigint
		itemCurrencyType: number
		offsetInRequestCurrencyE6: bigint
	}[]
	fees: {
		gasChainType: number
		gasWei: bigint
		gasUSDC6: bigint
		serviceUSDC6: bigint
		bServiceUSDC6: bigint
		bServiceUnits6: bigint
		feePayer: string
	}
	meta: {
		requestAmountFiat6: bigint
		requestAmountUSDC6: bigint
		currencyFiat: number
		discountAmountFiat6: bigint
		discountRateBps: number
		taxAmountFiat6: bigint
		taxRateBps: number
		afterNotePayer: string
		afterNotePayee: string
	}
	operator?: string
	operatorParentChain?: string[]
	topAdmin?: string
	subordinate?: string
}

type PurchasingCardAccountingRetryJob = {
	input: PurchasingCardAccountingInput
	baseTxHash: string
	from: string
	cardAddress: string
	attempt: number
}

const PURCHASING_CARD_ACCOUNTING_MAX_RETRY = 3
export const purchasingCardAccountingRetryPool: PurchasingCardAccountingRetryJob[] = []
let purchasingCardAccountingRetryRunning = false

const extractTokenIdsFromOwnership = (items: unknown[]): bigint[] => {
	const out: bigint[] = []
	for (const item of items) {
		try {
			if (item && typeof item === 'object' && 'tokenId' in item) {
				const v = (item as { tokenId?: unknown }).tokenId
				if (typeof v === 'bigint') out.push(v)
				else if (typeof v === 'number' && Number.isFinite(v)) out.push(BigInt(Math.floor(v)))
				else if (typeof v === 'string' && v !== '') out.push(BigInt(v))
				continue
			}
			if (Array.isArray(item) && item.length > 0) {
				const v = item[0]
				if (typeof v === 'bigint') out.push(v)
				else if (typeof v === 'number' && Number.isFinite(v)) out.push(BigInt(Math.floor(v)))
				else if (typeof v === 'string' && v !== '') out.push(BigInt(v))
			}
		} catch (_) {}
	}
	return out
}

const accountingToDebugJson = (val: unknown) => JSON.stringify(
	val,
	(_k, v) => typeof v === 'bigint' ? v.toString() : v,
	2
)

const pickAccountingErrorDebug = (err: any) => ({
	name: err?.name,
	code: err?.code,
	shortMessage: err?.shortMessage,
	message: err?.message,
	reason: err?.reason,
	data: err?.data ?? err?.info?.error?.data,
	error: err?.error?.message ?? err?.info?.error?.message,
	stack: err?.stack,
})

const buildPurchasingCardAccountingOverrides = (
	feeData: { gasPrice?: bigint | null; maxFeePerGas?: bigint | null; maxPriorityFeePerGas?: bigint | null } | null | undefined,
	multiplier: bigint,
	fallbackGwei: string
): Record<string, bigint | number> => {
	const overrides: Record<string, bigint | number> = { gasLimit: 2_500_000 }
	if (feeData?.maxFeePerGas != null && feeData?.maxPriorityFeePerGas != null) {
		const boostedPriority = feeData.maxPriorityFeePerGas > 0n
			? feeData.maxPriorityFeePerGas * multiplier
			: ethers.parseUnits('2', 'gwei')
		let boostedMax = feeData.maxFeePerGas > 0n
			? feeData.maxFeePerGas * multiplier
			: ethers.parseUnits(fallbackGwei, 'gwei')
		if (boostedMax <= boostedPriority) {
			boostedMax = boostedPriority + ethers.parseUnits('1', 'gwei')
		}
		overrides.maxPriorityFeePerGas = boostedPriority
		overrides.maxFeePerGas = boostedMax
		return overrides
	}
	const boostedGasPrice = feeData?.gasPrice && feeData.gasPrice > 0n
		? feeData.gasPrice * multiplier
		: ethers.parseUnits(fallbackGwei, 'gwei')
	overrides.gasPrice = boostedGasPrice
	return overrides
}

const runPurchasingCardAccountingJob = async (
	job: PurchasingCardAccountingRetryJob,
	SC: { walletConet: ethers.Wallet; BeamioTaskDiamondAction: ethers.Contract }
) => {
	const actionFacet = new ethers.Contract(BeamioTaskIndexerAddress, ACTION_SYNC_TOKEN_ABI, SC.walletConet)
	const feeData = await SC.walletConet.provider?.getFeeData().catch(() => null)
	logger(Colors.cyan(`[purchasingCardProcess][DEBUG] BeamioIndexerDiamond payload(JSON):\n${accountingToDebugJson(job.input)}`))

	const submitAndWait = async (label: '1st' | 'retry', overrides: Record<string, bigint | number>) => {
		logger(Colors.gray(`[purchasingCardProcess] syncTokenAction ${label} gas overrides: ${inspect(overrides, false, 3, true)}`))
		const tx = await actionFacet.syncTokenAction(job.input, overrides)
		logger(Colors.green(`[purchasingCardProcess][DEBUG] syncTokenAction submitted (${label}) hash=${tx.hash}`))
		const receipt = await tx.wait()
		if (!receipt || Number(receipt.status ?? 0) !== 1) {
			throw new Error(`syncTokenAction reverted (status=${receipt?.status ?? 'unknown'}) hash=${tx.hash}`)
		}
		return tx.hash
	}

	try {
		return await submitAndWait('1st', buildPurchasingCardAccountingOverrides(feeData, 3n, '60'))
	} catch (firstErr: any) {
		logger(Colors.yellow(`[purchasingCardProcess] syncTokenAction first try failed, retry once with higher gas: ${firstErr?.shortMessage ?? firstErr?.message ?? String(firstErr)}`))
		logger(Colors.red(`[purchasingCardProcess][DEBUG] syncTokenAction first error: ${accountingToDebugJson(pickAccountingErrorDebug(firstErr))}`))
		try {
			return await submitAndWait('retry', buildPurchasingCardAccountingOverrides(feeData, 5n, '90'))
		} catch (retryErr: any) {
			logger(Colors.red(`[purchasingCardProcess][DEBUG] syncTokenAction retry error: ${accountingToDebugJson(pickAccountingErrorDebug(retryErr))}`))
			throw retryErr
		}
	}
}

const ensurePurchasingCardAccountingRetryWorker = () => {
	if (purchasingCardAccountingRetryRunning) return
	purchasingCardAccountingRetryRunning = true
	setTimeout(() => purchasingCardAccountingRetryProcess(), 1000)
}

const enqueuePurchasingCardAccountingRetryJob = (job: PurchasingCardAccountingRetryJob) => {
	purchasingCardAccountingRetryPool.push(job)
	logger(Colors.yellow(`[purchasingCardProcess] queued accounting retry job attempt=${job.attempt} tx=${job.baseTxHash} queue=${purchasingCardAccountingRetryPool.length}`))
	ensurePurchasingCardAccountingRetryWorker()
}

export const purchasingCardAccountingRetryProcess = async () => {
	const job = purchasingCardAccountingRetryPool.shift()
	if (!job) {
		purchasingCardAccountingRetryRunning = false
		return
	}
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		purchasingCardAccountingRetryPool.unshift(job)
		setTimeout(() => purchasingCardAccountingRetryProcess(), 1500)
		return
	}
	try {
		const syncTxHash = await runPurchasingCardAccountingJob(job, { walletConet: SC.walletConet, BeamioTaskDiamondAction: SC.BeamioTaskDiamondAction })
		logger(Colors.green(`✅ purchasingCardProcess queued accounting done: tx=${job.baseTxHash} syncTokenAction=${syncTxHash}`))
	} catch (err: any) {
		const nextAttempt = job.attempt + 1
		logger(Colors.yellow(`[purchasingCardProcess] queued accounting failed: ${err?.shortMessage ?? err?.message ?? String(err)}`))
		logger(Colors.red(`[purchasingCardProcess][DEBUG] queued accounting error detail: ${accountingToDebugJson(pickAccountingErrorDebug(err))}`))
		if (nextAttempt < PURCHASING_CARD_ACCOUNTING_MAX_RETRY) {
			purchasingCardAccountingRetryPool.push({ ...job, attempt: nextAttempt })
			logger(Colors.yellow(`[purchasingCardProcess] requeued accounting job attempt=${nextAttempt} tx=${job.baseTxHash} queue=${purchasingCardAccountingRetryPool.length}`))
		} else {
			logger(Colors.red(`[purchasingCardProcess] dropped accounting job after max retries tx=${job.baseTxHash}`))
		}
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => purchasingCardAccountingRetryProcess(), 1000)
	}
}

export const purchasingCardProcess = async () => {
	const obj = purchasingCardPool.shift()
	if (!obj) {
		return
	}
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		purchasingCardPool.unshift(obj)
		return setTimeout(() => purchasingCardProcess(), 3000)
	}
	
	
	try {
		const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, preChecked } = obj
		const isCCSA = cardAddress?.toLowerCase() === BASE_CCSA_CARD_ADDRESS.toLowerCase()
		logger(Colors.cyan(`[purchasingCardProcess] cardAddress=${cardAddress} isCCSA=${isCCSA} (expected CCSA: ${BASE_CCSA_CARD_ADDRESS})`))

		// 1. AA 账户：仅在 master 用原有的 DeployingSmartAccount 检查/创建；集群不检查 AA、不传 accountAddress。若购卡 EOA 不存在 AA 则在此创建或返回错误。
		let accountAddress: string
		let owner: string
		let _currency: number
		let currencyAmount: { usdc6: bigint, points6: bigint, usdc: string, points: string, unitPriceUSDC6?: bigint, unitPriceUSDC?: string }
		let pointsBalance: bigint
		let nfts: unknown[]
		let isMember: boolean

		const { accountAddress: addr } = await DeployingSmartAccount(obj.from, SC.aaAccountFactoryPaymaster)
		if (!addr) {
			logger(Colors.red(`❌ ${obj.from} purchasingCardProcess DeployingSmartAccount failed (no AA account)`));
			if (obj.res && !obj.res.writableEnded) obj.res.status(400).json({ success: false, error: 'Account not found or failed to create. Please create/activate your Beamio account first.' }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => purchasingCardProcess(), 3000)
			return
		}
		accountAddress = addr

		if (preChecked) {
			// preChecked.currencyAmount from server's quotePointsForUSDC_raw(usdcAmount); never from client
			owner = preChecked.owner
			_currency = preChecked._currency
			currencyAmount = {
				usdc6: BigInt(preChecked.currencyAmount.usdc6),
				points6: BigInt(preChecked.currencyAmount.points6),
				usdc: preChecked.currencyAmount.usdc,
				points: preChecked.currencyAmount.points,
				unitPriceUSDC6: preChecked.currencyAmount.unitPriceUSDC6 != null ? BigInt(preChecked.currencyAmount.unitPriceUSDC6) : undefined,
				unitPriceUSDC: preChecked.currencyAmount.unitPriceUSDC
			}
			pointsBalance = BigInt(preChecked.pointsBalance)
			nfts = preChecked.nfts ?? []
			isMember = preChecked.isMember
			logger(Colors.green(`✅ purchasingCardProcess [preChecked] cardAddress = ${cardAddress} ${obj.from} AA: ${accountAddress} isMember: ${isMember} pointsBalance: ${pointsBalance} nfts: ${nfts?.length}`));
		} else {
			// currencyAmount: derived from usdcAmount (EIP-3009 signed value) via oracle; never from client input
			const card = new ethers.Contract(cardAddress, BeamioUserCardABI, SC.walletBase)
			const [[pb, n], o, c, ca] = await Promise.all([
				card.getOwnership(accountAddress),
				card.owner(),
				card.currency(),
				quotePointsForUSDC_raw(cardAddress, BigInt(usdcAmount), SC.baseFactoryPaymaster)
			])
			pointsBalance = pb
			nfts = Array.isArray(n) ? n : []
			owner = String(o)
			_currency = Number(c)
			currencyAmount = ca
			isMember = (nfts.length > 0) && (pointsBalance > 0n)
			logger(Colors.green(`✅ purchasingCardProcess cardAddress = ${cardAddress} ${obj.from} AA Account: ${accountAddress} isMember: ${isMember} pointsBalance: ${pointsBalance} nfts: ${nfts?.length}`));
		}

		// Card must be in DB before topup; reject if not registered (createCard may not have completed)
		const cardMeta = await getCardByAddress(cardAddress)
		if (!cardMeta) {
			logger(Colors.red(`❌ purchasingCardProcess card not in DB, rejecting topup: ${cardAddress}`))
			if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: 'Card not found in registry. Please ensure the card was created successfully before purchasing.' }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => purchasingCardProcess(), 3000)
			return
		}

		// 新合约设计：购点通过 Card Factory.buyPointsForUser，不再直接调用 card.buyPointsWith3009Authorization
		// 显式使用 BASE_CARD_FACTORY，避免错误配置导致调用到卡地址（卡无 buyPointsForUser 会 revert）
		const factoryAbiWithTopupRecommender = [
			...BeamioFactoryPaymasterABI,
			'function buyPointsForUser(address cardAddr,address fromEOA,uint256 usdcAmount6,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature,uint256 minPointsOut6,address recommender) returns (uint256)',
		] as ethers.InterfaceAbi
		const cardFactory = new ethers.Contract(BASE_CARD_FACTORY, factoryAbiWithTopupRecommender, SC.walletBase)
		const nonceBytes32 = (typeof nonce === 'string' && nonce.startsWith('0x') ? ethers.zeroPadValue(nonce, 32) : ethers.zeroPadValue(ethers.toBeHex(BigInt(nonce)), 32)) as `0x${string}`
		logger(Colors.gray(`[purchasingCardProcess] buyPointsForUser factory=${BASE_CARD_FACTORY} card=${cardAddress}`))
		const tx = await (obj.recommender && obj.recommender !== ethers.ZeroAddress
			? cardFactory["buyPointsForUser(address,address,uint256,uint256,uint256,bytes32,bytes,uint256,address)"](
				cardAddress,
				from,
				usdcAmount,
				validAfter,
				validBefore,
				nonceBytes32,
				userSignature,
				0,
				obj.recommender
			)
			: cardFactory["buyPointsForUser(address,address,uint256,uint256,uint256,bytes32,bytes,uint256)"](
				cardAddress,
				from,
				usdcAmount,
				validAfter,
				validBefore,
				nonceBytes32,
				userSignature,
				0
			))
		logger(Colors.green(`✅ purchasingCardProcess tx submitted Hash: ${tx.hash}`))

		await tx.wait().catch((waitErr: any) => {
			try {
				logger(Colors.yellow(`[purchasingCardProcess] tx.wait() failed (RPC): ${waitErr?.shortMessage ?? waitErr?.message ?? String(waitErr)}`))
			} catch (_) {
				console.error('[purchasingCardProcess] tx.wait() failed (RPC):', waitErr)
			}
		})
		// Base 转账完成后立即返回 hash 给客户端，不等待记账
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end()

		const to = owner
		// operator: recommender 非零且为 admin 时计入 recommender 统计；否则计入 owner 链
		let operatorAddr: string
		if (obj.recommender && obj.recommender !== ethers.ZeroAddress) {
			try {
				const cardRead = new ethers.Contract(cardAddress, ['function isAdmin(address) view returns (bool)'], SC.walletBase)
				const isAdmin = await cardRead.isAdmin(ethers.getAddress(obj.recommender)) as boolean
				operatorAddr = isAdmin ? ethers.getAddress(obj.recommender) : ethers.getAddress(to)
			} catch (_) {
				operatorAddr = ethers.getAddress(to)
			}
		} else {
			operatorAddr = ethers.getAddress(to)
		}
		const currency = getICurrency(BigInt(_currency))
		// cardMeta already validated before buyPointsForUser
		const metadata = cardMeta.metadata as { shareTokenMetadata?: { name?: string }; name?: string } | undefined
		const cardDisplayName = String(metadata?.shareTokenMetadata?.name ?? metadata?.name ?? '').trim()
		const payMe = cardNote(cardAddress, currencyAmount.usdc, currency, tx.hash, currencyAmount.points, isMember, cardDisplayName)

		logger(Colors.green(`✅ purchasingCardProcess payMe cardAddress = ${cardAddress} payMe = ${inspect(payMe, false, 3, true)}`));
		if (!payMe) {
			logger(Colors.red(`❌ purchasingCardProcess payMe is null`));
			Settle_ContractPool.unshift(SC)
			setTimeout(() => purchasingCardProcess(), 3000)
			return
		}

		

		const CHAIN_ID_BASE = 8453n
		const payerAddr = ethers.getAddress(from)
		const payeeAddr = ethers.getAddress(to)
		// Accounting: never trust client currency amount. Use USDC from EIP-3009 signature + chain-verified points.
		const finalRequestAmountUSDC6 = BigInt(usdcAmount)
		const currencyFiat = Number(_currency)
		const beforePoint6 = pointsBalance
		const beforeTokenIds = extractTokenIdsFromOwnership(nfts ?? [])
		const beforeTokenSet = new Set(beforeTokenIds.map((id) => id.toString()))
		let upgradedByMint = false
		let afterTokenIds: bigint[] = []
		let actualPointsMinted = 0n
		try {
			const cardRead = new ethers.Contract(cardAddress, BeamioUserCardABI, SC.walletBase)
			const [ptAfter, nAfter] = await cardRead.getOwnership(accountAddress) as [bigint, unknown[]]
			afterTokenIds = extractTokenIdsFromOwnership(Array.isArray(nAfter) ? nAfter : [])
			upgradedByMint = afterTokenIds.some((id) => !beforeTokenSet.has(id.toString()))
			actualPointsMinted = ptAfter > beforePoint6 ? ptAfter - beforePoint6 : 0n
		} catch (ownershipErr: any) {
			logger(Colors.yellow(`[purchasingCardProcess] post-topup ownership check failed: ${ownershipErr?.shortMessage ?? ownershipErr?.message ?? String(ownershipErr)}`))
		}
		// Currency amount for accounting: chain-verified points minted when available; else quote from USDC (never client input)
		const currentTopupPoint6 = actualPointsMinted > 0n ? actualPointsMinted : currencyAmount.points6
		const finalRequestAmountFiat6 = currentTopupPoint6
		// TopUp RouteItem: use UserCardPoint (txCategory: usdcNewCard/usdcUpgradeNewCard/usdcTopupCard)
		const ROUTE_SOURCE_USER_CARD_POINT = 1
		const tokenIdForRoute = upgradedByMint
			? (afterTokenIds.find((id) => !beforeTokenSet.has(id.toString())) ?? afterTokenIds[0] ?? 0n)
			: (afterTokenIds[0] ?? 0n)
		// Classification rule (USDC 购点):
		// - minted a new tier token this time + had previous balance => usdcUpgradeNewCard
		// - minted a new tier token this time + no previous balance => usdcNewCard
		// - no new tier token minted => usdcTopupCard
		const topupCategoryRaw = upgradedByMint
			? (beforePoint6 > 0n ? 'usdcUpgradeNewCard' : 'usdcNewCard')
			: 'usdcTopupCard'
		const txCategoryTopup = ethers.keccak256(ethers.toUtf8Bytes(topupCategoryRaw)) as `0x${string}`
		// currencyAmount in displayJson: chain-verified when available, else from quote (USDC→oracle); never from client
		const displayCurrencyAmount = actualPointsMinted > 0n ? ethers.formatUnits(actualPointsMinted, 6) : payMe.currencyAmount
		const displayJson = JSON.stringify({
			title: payMe.title || (isMember ? 'Top Up' : 'Card Mint'),
			handle: '',
			source: 'purchasingCard',
			topupCategory: topupCategoryRaw,
			cardName: cardDisplayName || undefined,
			cardAddress,
			finishedHash: tx.hash,
			currency: payMe.currency,
			currencyAmount: displayCurrencyAmount,
			usdcAmount: payMe.usdcAmount,
		})
		// TopUp RouteItem per accounting spec: asset=card, assetType=ERC1155, source=UserCardPoint, tokenId=NFT card#, itemCurrencyType=currency, amountE6=topup amount
		const topupRouteItem = {
			asset: cardAddress,
			amountE6: currentTopupPoint6,
			assetType: 1, // ERC1155
			source: ROUTE_SOURCE_USER_CARD_POINT,
			tokenId: tokenIdForRoute,
			itemCurrencyType: currencyFiat,
			offsetInRequestCurrencyE6: 0n,
		}
		const input: PurchasingCardAccountingInput = {
			txId: tx.hash as `0x${string}`,
			originalPaymentHash: ethers.ZeroHash as `0x${string}`,
			chainId: CHAIN_ID_BASE,
			txCategory: txCategoryTopup,
			displayJson,
			timestamp: 0n,
			payer: payerAddr,
			payee: payeeAddr,
			finalRequestAmountFiat6,
			finalRequestAmountUSDC6,
			isAAAccount: false,
			route: [topupRouteItem],
			fees: {
				gasChainType: 0,
				gasWei: 0n,
				gasUSDC6: 0n,
				serviceUSDC6: 0n,
				bServiceUSDC6: 0n,
				bServiceUnits6: 0n,
				feePayer: ethers.ZeroAddress,
			},
			meta: {
				requestAmountFiat6: currentTopupPoint6,
				requestAmountUSDC6: finalRequestAmountUSDC6,
				currencyFiat,
				discountAmountFiat6: beforePoint6,
				discountRateBps: 0,
				taxAmountFiat6: 0n,
				taxRateBps: 0,
				afterNotePayer: '',
				afterNotePayee: '',
			},
			operator: operatorAddr,
			operatorParentChain: await fetchOperatorParentChain(cardAddress, operatorAddr),
		}
		const opChain = input.operatorParentChain ?? []
		const { topAdmin, subordinate } = deriveTopAdminAndSubordinate(operatorAddr, opChain)
		input.topAdmin = topAdmin
		input.subordinate = subordinate
		
		

		logger(Colors.green(`✅ purchasingCardProcess note: ${payMe}`))

		// 以下记账（syncTokenAction -> BeamioIndexerDiamond）在后台执行，客户端已收到 hash；失败不影响购点成功
		try {
			const syncTxHash = await runPurchasingCardAccountingJob(
				{
					input,
					baseTxHash: tx.hash,
					from,
					cardAddress,
					attempt: 0,
				},
				{ walletConet: SC.walletConet, BeamioTaskDiamondAction: SC.BeamioTaskDiamondAction }
			)
			logger(Colors.green(`✅ purchasingCardProcess accounting done: tx=${tx.hash} syncTokenAction=${syncTxHash}`))
		} catch (accountingErr: any) {
			// 记账失败不影响购点主流程，入后台补记队列避免丢单
			logger(Colors.yellow(`[purchasingCardProcess] accounting non-critical (purchase succeeded): ${accountingErr?.shortMessage ?? accountingErr?.message ?? String(accountingErr)}`))
			logger(Colors.red(`[purchasingCardProcess][DEBUG] accounting error detail: ${accountingToDebugJson(pickAccountingErrorDebug(accountingErr))}`))
			enqueuePurchasingCardAccountingRetryJob({
				input,
				baseTxHash: tx.hash,
				from,
				cardAddress,
				attempt: 0,
			})
		}
		syncNftTierMetadataForUser(cardAddress, from).catch(() => {})
		
		
	} catch (error: any) {
		const msg = error?.message ?? error?.shortMessage ?? String(error)
		const data = error?.data ?? error?.info?.error?.data ?? ''
		// 0x76024b71 = UC_PriceZero()：卡合约内 quoteUnitPointInUSDC6(address(this)) 返回 0，链上 Oracle 未配置该卡币种（如 CAD）
		const isUCPriceZero = typeof data === 'string' && (data === '0x76024b71' || data.toLowerCase().startsWith('0x76024b71'))
		// 0xad12d341 = UC_ResolveAccountFailed(eoa, aaFactory, acct)：卡合约解析 EOA 的 AA 账户时得到 address(0)，即该 EOA 在此链上尚未创建/部署 AA 账户
		const isUCResolveAccountFailed = typeof data === 'string' && (data === '0xad12d341' || data.toLowerCase().startsWith('0xad12d341'))
		logger(Colors.red(`❌ purchasingCardProcess failed:`), error)
		let clientError = msg
		if (isUCPriceZero) {
			clientError = 'UC_PriceZero: Card contract rejected (quoteUnitPointInUSDC6=0 on chain). Set Oracle CAD rate on this chain: npm run set:oracle-cad:base'
			logger(Colors.yellow(`[purchasingCardProcess] UC_PriceZero: chain Oracle missing rate for card currency (e.g. CAD). Run: npm run set:oracle-cad:base`))
		} else if (isUCResolveAccountFailed) {
			clientError = 'Account not found on chain. Please create or activate your Beamio account first, then try purchasing again.'
			logger(Colors.yellow(`[purchasingCardProcess] UC_ResolveAccountFailed: EOA has no deployed AA account for this card's factory. Ensure DeployingSmartAccount runs before buyPointsWith3009Authorization.`))
		} else {
			const isOracleError = /unitPriceUSDC6=0|oracle not configured|QuoteHelper|set:oracle-cad/i.test(msg)
			if (isOracleError) clientError = msg.includes('set:oracle-cad') ? msg : `unitPriceUSDC6=0 (oracle not configured?). For CAD cards run: npm run set:oracle-cad:base`
		}
		if (obj.res && !obj.res.writableEnded) {
			obj.res.status(400).json({ success: false, error: clientError }).end()
		}
	}

	Settle_ContractPool.unshift(SC)

	setTimeout(() => purchasingCardProcess(), 3000)
}

/** EntryPoint v0.7：用于提交 UserOp、查询 userOpHash（与链上校验一致） */
const EntryPointHandleOpsABI = [
	'function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary) external',
	'function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)',
]


export const getMyAssets = async (userEOA: string, cardAddress: string) => {
    const SC = Settle_ContractPool[0];

    try {
        logger(`[Assets] Resolving AA account for EOA ${userEOA}...`);

        // 1️⃣ 通过 AA Factory 拿 primaryAccount
        const account = await SC.aaAccountFactoryPaymaster.primaryAccountOf(userEOA);

        if (account === ethers.ZeroAddress) {
            throw new Error("❌ No BeamioAccount found for this EOA");
        }

        const code = await providerBaseBackup.getCode(account);
        if (code === "0x") {
            throw new Error("❌ Resolved BeamioAccount has no code (not deployed)");
        }

        logger(`[Assets] Using BeamioAccount: ${account}`);

        // 2️⃣ 实例化 Card（只需要 getOwnership）
        const cardContractReadonly = new ethers.Contract(
            cardAddress,BeamioUserCardABI, providerBaseBackup
        );

        logger(`[Assets] Fetching assets for AA ${account} on card ${cardAddress}...`);

        // 3️⃣ 用 AA 地址查资产
        
		const [[pointsBalance, nfts], currency] = await Promise.all([
			cardContractReadonly.getOwnership(account),
			cardContractReadonly.currency()
		])


		


		logger(inspect({pointsBalance, nfts}, false, 3, true), inspect(getICurrency(currency), false, 3, true))
        // 4️⃣ 格式化返回
        const result = {
            eoa: userEOA,
            account,
            cardAddress,
            points: ethers.formatUnits(pointsBalance, 6),
            nfts: nfts.map((nft: any) => ({
                tokenId: nft.tokenId.toString(),
                attribute: nft.attribute.toString(),
                tier:
                    nft.tierIndexOrMax === ethers.MaxUint256
                        ? "Default/Max"
                        : nft.tierIndexOrMax.toString(),
                expiry:
                    nft.expiry === 0n
                        ? "Never"
                        : new Date(Number(nft.expiry) * 1000).toLocaleString(),
                isExpired: nft.isExpired,
            })),
        };

        // 5️⃣ 输出
        if (result.nfts.length > 0) {
            console.table(result.nfts);
        }
        logger(`✅ AA Points Balance: ${result.points}`);

        return result;
    } catch (error: any) {
        logger(`❌ getMyAssets failed: ${error.message}`);
        throw error;
    }
}



// ---- helpers ----
function asBigInt(v: any, fallback = 0n) {
  try {
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') return BigInt(v)
    if (typeof v === 'string') {
      if (v.startsWith('0x')) return BigInt(v)
      if (v.trim() === '') return fallback
      return BigInt(v)
    }
    return fallback
  } catch {
    return fallback
  }
}

function hexBytesLen(hex: string) {
  if (!hex || typeof hex !== 'string') return 0
  if (!hex.startsWith('0x')) return 0
  return (hex.length - 2) / 2
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

// decode EntryPoint FailedOp (0x65c8fd4d) -> string reason
function tryDecodeFailedOp(data: any): string | null {
  try {
    if (typeof data !== 'string') return null
    const hex = data.startsWith('0x') ? data.slice(2) : data
    if (hex.length < 8) return null
    const selector = hex.slice(0, 8)
    if (selector !== '65c8fd4d') return null // FailedOp selector
    // layout: selector + (opIndex) + (paymaster?) + (offsetReason) + ...
    // easiest: search ASCII tail "AAxx ..." often is last arg string
    // robust decode with AbiCoder:
    const coder = ethers.AbiCoder.defaultAbiCoder()
    // FailedOp(uint256 opIndex, string reason)
    // BUT some EntryPoint versions: FailedOp(uint256 opIndex, address paymaster, string reason)
    // We'll try both.
    try {
      const decoded = coder.decode(['uint256', 'string'], '0x' + hex.slice(8))
      return `FailedOp(opIndex=${decoded[0].toString()}): ${decoded[1]}`
    } catch {}
    try {
      const decoded2 = coder.decode(['uint256', 'address', 'string'], '0x' + hex.slice(8))
      return `FailedOp(opIndex=${decoded2[0].toString()}, paymaster=${decoded2[1]}): ${decoded2[2]}`
    } catch {}
    return null
  } catch {
    return null
  }
}

// pack check: bytes32 should not be 0x00..00
function isZeroBytes32(x: any) {
  const v = typeof x === 'string' ? x : ''
  return v === ethers.ZeroHash || v === '0x' + '00'.repeat(32)
}

// parse first 20 bytes of paymasterAndData
function parsePaymasterFromPnd(pnd: string): string | null {
  try {
    if (typeof pnd !== 'string' || !pnd.startsWith('0x')) return null
    if (pnd.length < 2 + 40) return null
    return ethers.getAddress('0x' + pnd.slice(2, 42))
  } catch {
    return null
  }
}

export const AAtoEOAProcess = async () => {
  const obj = AAtoEOAPool.shift()
  if (!obj) return

  logger(
    `[AAtoEOA] process started, pool had item toEOA=${obj.toEOA} amountUSDC6=${obj.amountUSDC6} sender=${obj.packedUserOp?.sender}`
  )

  const SC = Settle_ContractPool.shift()
  if (!SC) {
    logger(
      Colors.yellow(
        `[AAtoEOA] process no SC available, re-queue and retry in 3s (pool length ${AAtoEOAPool.length})`
      )
    )
    AAtoEOAPool.unshift(obj)
    return setTimeout(() => AAtoEOAProcess(), 3000)
  }

  let recoveredSigner: string | null = null

  try {
    const op = obj.packedUserOp
    if (!op) {
      const errMsg = 'packedUserOp missing'
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }

    // --- normalize fields ---
    const sender = op.sender
    const callData = op.callData || '0x'
    if (!sender || !ethers.isAddress(sender)) {
      const errMsg = `Invalid sender address: ${sender}`
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }
    if (typeof callData !== 'string' || !callData.startsWith('0x')) {
      const errMsg = 'Invalid callData: must start with 0x'
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }
    if (callData.length <= 2) {
      const errMsg = 'Invalid callData: empty'
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }

    // --- signature normalize ---
    const rawSig = op.signature ?? '0x'
    const sigHex =
      typeof rawSig === 'string' && rawSig.startsWith('0x')
        ? rawSig
        : '0x' + (rawSig || '')
    const sigLen = hexBytesLen(sigHex)

    if (sigLen !== 65) {
      const errMsg = `Invalid signature length: expected 65 bytes, got ${sigLen} bytes`
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }

    let sigBytes: Uint8Array
    try {
      sigBytes = ethers.getBytes(sigHex)
    } catch {
      const errMsg = 'Invalid signature hex: cannot decode to bytes'
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }
    if (sigBytes.length !== 65) {
      const errMsg = `Signature decoded length is ${sigBytes.length}, expected 65`
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }

    logger(`[AAtoEOA] signature bytes length=${sigBytes.length} hexLen=${sigHex.length}`)

    // --- sender must be contract ---
    const senderCode = await SC.walletBase.provider!.getCode(sender)
    if (!senderCode || senderCode === '0x' || senderCode.length <= 2) {
      const errMsg = `Invalid sender: ${sender} has no contract code`
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }

	

    // --- entryPoint ---
    const entryPointAddress = await SC.aaAccountFactoryPaymaster.ENTRY_POINT()
    logger(`[AAtoEOA] ENTRY_POINT address: ${entryPointAddress}`)
    if (!entryPointAddress || entryPointAddress === ethers.ZeroAddress) {
      const errMsg = 'ENTRY_POINT not configured'
      obj.res.status(500).json({ success: false, error: errMsg }).end()
      return
    }

    const entryPoint = new ethers.Contract(
      entryPointAddress,
      EntryPointHandleOpsABI,
      SC.walletBase
    )

    const entryPointRead = new ethers.Contract(
      entryPointAddress,
      ['function balanceOf(address account) view returns (uint256)'],
      SC.walletBase.provider!
    )

    // --- gas sanity checks (VERY IMPORTANT) ---
    // 如果 client 还在发全 0，这里直接拦住并提示改 UI buildAndSignPackedUserOp
    const accountGasLimits = op.accountGasLimits || ethers.ZeroHash
    const gasFees = op.gasFees || ethers.ZeroHash
    const preVerificationGas = asBigInt(op.preVerificationGas, 0n)

    if (isZeroBytes32(accountGasLimits) || isZeroBytes32(gasFees) || preVerificationGas === 0n) {
      const errMsg =
        'Invalid gas fields: accountGasLimits/gasFees/preVerificationGas must be set for ERC-4337 v0.7. ' +
        `got accountGasLimits=${accountGasLimits} gasFees=${gasFees} preVerificationGas=${preVerificationGas.toString()}`
      logger(Colors.red(`❌ [AAtoEOA] ${errMsg}`))
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      return
    }

    // --- build packed op (tx format) ---
    const packedOp: any = {
      sender,
      nonce: asBigInt(op.nonce, 0n),
      initCode: op.initCode || '0x',
      callData,
      accountGasLimits,
      preVerificationGas,
      gasFees,
      paymasterAndData: op.paymasterAndData || '0x',
      signature: sigBytes
    }

    // --- paymaster parse + allowlist check ---
    const pnd = packedOp.paymasterAndData as string
    const pm = parsePaymasterFromPnd(pnd) ?? ethers.ZeroAddress
    logger(
      `[AAtoEOA] paymasterAndDataLen=${hexBytesLen(pnd)} paymaster=${pm}`
    )

    if (pm !== ethers.ZeroAddress) {
      // 1) optional: verify sender allowed by paymaster
      const pmc = new ethers.Contract(
        pm,
        ['function isBeamioAccount(address) view returns (bool)'],
        SC.walletBase.provider!
      )
      const okSender = await safeCall(() => pmc.isBeamioAccount(sender) as Promise<boolean>)
      if (okSender === false) {
        const errMsg = `Sender AA not registered in paymaster allowlist: sender=${sender} pm=${pm}`
        logger(Colors.red(`❌ [AAtoEOA] ${errMsg}`))
        obj.res.status(400).json({ success: false, error: errMsg }).end()
        return
      }
      logger(`[AAtoEOA] pm.isBeamioAccount(sender)=${okSender}`)
    }

	  
	  // ... 已经 parse 出 pm
	  
	  if (pm !== ethers.ZeroAddress) {
		const pmDeposit = await entryPointRead.balanceOf(pm)
		logger(`[AAtoEOA] paymasterDeposit=${pmDeposit.toString()} pm=${pm}`)
	  
		// 你可以设一个最低阈值，比如 0.001 ETH（按 Base 费用再调）
		const min = ethers.parseEther('0.001')
		if (pmDeposit < min) {
		  const errMsg =
			`AA31 paymaster deposit too low: deposit=${pmDeposit.toString()} (< ${min.toString()}). ` +
			`Need to top up EntryPoint deposit for paymaster ${pm}.`
		  logger(Colors.red(`❌ [AAtoEOA] ${errMsg}`))
		  obj.res.status(400).json({ success: false, error: errMsg }).end()
		  Settle_ContractPool.unshift(SC)
		  setTimeout(() => AAtoEOAProcess(), 3000)
		  return
		}
	  }

    // --- recover signer from userOpHash (best-effort, for debug & pre-reject) ---
    try {
      const opForHash: any = { ...packedOp, signature: '0x' } // IMPORTANT
      const userOpHash = await entryPoint.getUserOpHash(opForHash) as string

      // ✅ 正确：链上是 toEthSignedMessageHash(userOpHash)，等价于 verifyMessage(bytes32, sig)
      recoveredSigner = ethers.verifyMessage(ethers.getBytes(userOpHash), sigHex)

      logger(
        `[AAtoEOA] recoveredSigner=${recoveredSigner} (should be AA owner / threshold manager)`
      )
    } catch (e: any) {
      logger(
        Colors.yellow(
          `[AAtoEOA] getUserOpHash/recover failed (non-fatal): ${e?.shortMessage || e?.message}`
        )
      )
    }

    // --- read AA owner + factory (best-effort) ---
    let aaOwner = ethers.ZeroAddress
    let aaFactory = ethers.ZeroAddress
    try {
      const aaRead = new ethers.Contract(
        sender,
        ['function owner() view returns (address)', 'function factory() view returns (address)'],
        SC.walletBase.provider!
      )
      aaOwner = await aaRead.owner()
      aaFactory = await aaRead.factory()
      logger(`[AAtoEOA] AA owner=${aaOwner} AA factory=${aaFactory}`)
    } catch (e: any) {
      logger(
        Colors.yellow(
          `[AAtoEOA] AA owner/factory read failed (non-fatal): ${e?.shortMessage || e?.message}`
        )
      )
    }

    // --- enforce signer == owner when both known ---
    if (aaOwner !== ethers.ZeroAddress && recoveredSigner) {
      if (aaOwner.toLowerCase() !== recoveredSigner.toLowerCase()) {
        const errMsg = `Signature signer (${recoveredSigner}) is not AA owner (${aaOwner})`
        logger(Colors.red(`❌ [AAtoEOA] ${errMsg}`))
        obj.res.status(400).json({ success: false, error: errMsg }).end()
        return
      }
    }

    // --- fee payer for consumeFromUser (Cluster 已预检 B-Unit 余额，Master 不再检查) ---
    const feePayer = aaOwner !== ethers.ZeroAddress ? aaOwner : recoveredSigner
    if (!feePayer) {
      const errMsg = 'Cannot determine fee payer (AA owner)'
      logger(Colors.red(`❌ [AAtoEOA] ${errMsg}`))
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      Settle_ContractPool.unshift(SC)
      setTimeout(() => AAtoEOAProcess(), 3000)
      return
    }
    const BUNIT_FEE_AMOUNT = 2_000_000n // 2 B-Units (6 decimals)

	 // --- submit ---
	 const beneficiary = await SC.walletBase.getAddress()
	 logger(
	   `[AAtoEOA] calling handleOps sender=${sender} beneficiary=${beneficiary} callDataBytes=${hexBytesLen(callData)} sigLen=${sigBytes.length}`
	 )
 

    // --- simulateValidation via eth_call (debug only, but super useful) ---
    try {
      const simIface = new ethers.Interface([
        'function simulateValidation((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) external'
      ])
      const data = simIface.encodeFunctionData('simulateValidation', [packedOp])

      await SC.walletBase.provider!.call({ to: entryPointAddress, data })
      logger('[AAtoEOA] simulateValidation eth_call ok')
    } catch (e: any) {
      const m = e?.shortMessage || e?.message || String(e)
      const decoded = tryDecodeFailedOp(e?.data)
      logger(Colors.red(`[AAtoEOA] simulateValidation failed: ${m}`))
      if (decoded) logger(Colors.red(`[AAtoEOA] simulateValidation decoded: ${decoded}`))
      if (e?.data) logger(Colors.red(`[AAtoEOA] simulateValidation data=${e.data}`))
      // 不在这里 return，让后续 handleOps 去给最终错误（但日志会更完整）
    }

    // --- deposit/eth snapshot ---
    const deposit = await entryPointRead.balanceOf(sender)
    const aaETH = await SC.walletBase.provider!.getBalance(sender)
    logger(`[AAtoEOA] entryPointDeposit=${deposit.toString()} aaETH=${aaETH.toString()}`)

   
    const tx = await entryPoint.handleOps([packedOp], beneficiary)
    logger(`[AAtoEOA] handleOps tx submitted hash=${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt) {
      throw new Error('handleOps tx.wait() returned null')
    }

    // --- deduct 2 B-Units fee from feePayer on CoNET (with Base tx hash) ---
    const baseHashBytes32 = tx.hash as `0x${string}` // 32-byte tx hash as bytes32
    const baseGas = receipt.gasUsed
    const bunitAirdropWrite = new ethers.Contract(
      CONET_BUNIT_AIRDROP_ADDRESS,
      ['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
      SC.walletConet
    )
    try {
      const consumeTx = await bunitAirdropWrite.consumeFromUser(
        feePayer,
        BUNIT_FEE_AMOUNT,
        baseHashBytes32,
        baseGas,
        1n, // kind=1 -> txCategory=keccak256("sendUSDC")，需预先 registerKind(1,"sendUSDC")
        { gasLimit: 2_500_000 }
      )
      await consumeTx.wait()
      logger(Colors.cyan(`[AAtoEOA] consumeFromUser ok: 2 B-Units from ${feePayer} baseHash=${tx.hash}`))
    } catch (consumeErr: any) {
      logger(Colors.red(`[AAtoEOA] consumeFromUser failed (non-fatal): ${consumeErr?.shortMessage ?? consumeErr?.message ?? consumeErr}`))
      // USDC transfer already succeeded; log but do not fail the response
    }

    // 记账：syncTokenAction via beamioTransferIndexerAccountingPool（USDC 转账，card 为 USDC 地址，title 为 "Express Pay to EOA"）
    const toEOA = ethers.getAddress(obj.toEOA)
    const amountUSDC6BigInt = BigInt(obj.amountUSDC6)
    const usdcAmountHuman = Number(amountUSDC6BigInt) / 1e6
    const displayJsonData: DisplayJsonData = {
      title: 'Express Pay to EOA',
      source: 'aa-eoa',
      finishedHash: tx.hash,
    }
    beamioTransferIndexerAccountingPool.push({
      from: sender,
      to: toEOA,
      amountUSDC6: amountUSDC6BigInt.toString(),
      finishedHash: tx.hash,
      displayJson: JSON.stringify(displayJsonData),
      currency: 'USDC',
      currencyAmount: String(usdcAmountHuman),
      gasWei: '0',
      gasUSDC6: '0',
      gasChainType: 0,
      feePayer: sender,
      isInternalTransfer: true,
      requestHash: obj.requestHash,
    })
    logger(Colors.cyan(`[AAtoEOA] pushed to beamioTransferIndexerAccountingPool (internal) from=${sender} to=${toEOA} amountUSDC6=${amountUSDC6BigInt} requestHash=${obj.requestHash ?? 'n/a'}`))
    beamioTransferIndexerAccountingProcess().catch((err: any) => {
      logger(Colors.red('[AAtoEOA] beamioTransferIndexerAccountingProcess unhandled:'), err?.message ?? err)
    })

    logger(Colors.green(`✅ AAtoEOAProcess success! tx=${tx.hash}`))
    obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end()
  } catch (error: any) {
    const msg = error?.shortMessage || error?.message || String(error)
    const decoded = tryDecodeFailedOp(error?.data)

    let clientError = decoded ? decoded : msg
    if (clientError.includes('AA23') && recoveredSigner) {
      clientError += ` | recoveredSigner=${recoveredSigner} (must be AA owner / threshold manager)`
    }

    logger(Colors.red(`❌ AAtoEOAProcess failed: ${msg}`))
    if (error?.data) logger(Colors.red(`[AAtoEOA] revert data=${error.data}`))
    if (decoded) logger(Colors.red(`[AAtoEOA] decoded=${decoded}`))

    obj.res.status(500).json({ success: false, error: clientError }).end()
  } finally {
    Settle_ContractPool.unshift(SC)
    setTimeout(() => AAtoEOAProcess(), 3000)
  }
}

/** 使用 Factory.relayContainerMainRelayedOpen 代付 Gas 执行 OpenContainer 转账；与 AAtoEOAProcess 共用 Settle_ContractPool。 */
export const OpenContainerRelayProcess = async () => {
  const obj = OpenContainerRelayPool.shift()
  if (!obj) return

  logger(Colors.gray(`[DEBUG] OpenContainerRelayProcess entry: objKeys=${Object.keys(obj).join(',')} requestHash=${obj.requestHash ?? 'n/a'} forText=${obj.forText ? `"${String(obj.forText).slice(0, 30)}…"` : 'n/a'} Settle_ContractPool.len=${Settle_ContractPool.length}`))
  const payload = obj.openContainerPayload
  logger(Colors.cyan(`[AAtoEOA/OpenContainer] [DEBUG] received openContainerPayload JSON: ${JSON.stringify(payload)}`))
  logger(`[AAtoEOA/OpenContainer] process started account=${payload.account} to=${payload.to}`)
  logger(`[AAtoEOA/OpenContainer] received obj data: currency=${obj.currency ?? 'null'}, currencyAmount=${obj.currencyAmount ?? 'null'}, payload.currencyType=${payload.currencyType}, payload.maxAmount=${payload.maxAmount}, items.length=${payload.items.length}`)
  logger(`[AAtoEOA/OpenContainer] full obj: ${inspect({ currency: obj.currency, currencyAmount: obj.currencyAmount, hasPayload: !!obj.openContainerPayload }, false, 2, true)}`)

  const SC = Settle_ContractPool.shift()
  if (!SC) {
    logger(Colors.yellow(`[AAtoEOA/OpenContainer] no SC available, re-queue (pool ${OpenContainerRelayPool.length})`))
    OpenContainerRelayPool.unshift(obj)
    return setTimeout(() => OpenContainerRelayProcess(), 3000)
  }

  try {
    const account = ethers.getAddress(payload.account)
    let to = ethers.getAddress(payload.to)
    const items = payload.items.map((it) => ({
      kind: Number(it.kind),
      asset: ethers.getAddress(it.asset),
      amount: BigInt(it.amount),
      tokenId: BigInt(it.tokenId),
      data: typeof it.data === 'string' ? (it.data as string) : ethers.hexlify(it.data as Uint8Array),
    }))
    const maxAmount = BigInt(payload.maxAmount)
    const nonce_ = BigInt(payload.nonce)
    const deadline_ = BigInt(payload.deadline)
    const sigHex = typeof payload.signature === 'string' && payload.signature.startsWith('0x') ? payload.signature : '0x' + payload.signature
    const sigBytes = ethers.getBytes(sigHex)

    const accountCode = await SC.walletBase.provider!.getCode(account)
    if (!accountCode || accountCode === '0x' || accountCode.length <= 2) {
      obj.res.status(400).json({ success: false, error: 'account has no contract code' }).end()
      Settle_ContractPool.unshift(SC)
      return setTimeout(() => OpenContainerRelayProcess(), 3000)
    }

    const FactoryWithRelay = new ethers.Contract(
      BeamioAAAccountFactoryPaymaster,
      [...(BeamioAAAccountFactoryPaymasterABI as any[]), RELAY_OPEN_ABI],
      SC.walletBase
    )
    // BeamioUserCard 要求 points(ERC1155) 只能转给 BeamioAccount；若 payload 含 ERC1155 或 to 为 EOA，将 to 解析为受益人 primary AA（严禁用付款方 account 的 AA 作为 to）
    const has1155 = items.some((it: { kind: number }) => it.kind === 1)
    const toIsEOA = !(await SC.walletBase.provider!.getCode(to).then((c: string) => c && c !== '0x' && c.length > 2))
    const needResolveTo = has1155 || toIsEOA
    if (needResolveTo) {
      try {
        // 仅当 to 为 EOA 时需通过 primaryAccountOf(EOA) 解析为 AA；primaryAccountOf 的 key 是 EOA 而非 AA
        // 若 to 已是 AA（有 code），则直接使用，无需解析
        if (toIsEOA) {
          const beneficiaryEOA = ethers.getAddress(payload.to)
          const primary = await FactoryWithRelay.primaryAccountOf(beneficiaryEOA)
          if (primary && primary !== ethers.ZeroAddress) {
            const resolvedTo = ethers.getAddress(primary)
            if (resolvedTo === account) {
              obj.res.status(400).json({ success: false, error: 'Beneficiary and sender cannot be the same (to resolved to sender AA). payload.to must be the recipient EOA/AA, not the payer.' }).end()
              Settle_ContractPool.unshift(SC)
              return setTimeout(() => OpenContainerRelayProcess(), 3000)
            }
            to = resolvedTo
            logger(`[AAtoEOA/OpenContainer] resolved beneficiary EOA -> AA ${to}`)
          } else {
            if (has1155) {
              logger(Colors.yellow(`[AAtoEOA/OpenContainer] ERC1155 item but beneficiary EOA ${payload.to} has no AA; card will revert UC_NoBeamioAccount`))
            }
          }
        } else {
          // to 已是 AA，可选验证 isBeamioAccount；若未注册则仅打 log（链上会 revert）
          const isBeamio = await FactoryWithRelay.isBeamioAccount(to).catch(() => false)
          if (has1155 && !isBeamio) {
            logger(Colors.yellow(`[AAtoEOA/OpenContainer] ERC1155 item: beneficiary ${payload.to} may not be registered BeamioAccount (isBeamioAccount=${isBeamio})`))
          }
        }
      } catch (e: any) {
        logger(Colors.yellow(`[AAtoEOA/OpenContainer] resolve beneficiary ${payload.to} failed: ${e?.message ?? e}`))
      }
    }
    if (to === account) {
      obj.res.status(400).json({ success: false, error: 'Beneficiary and sender cannot be the same. Check payload.to is the recipient address.' }).end()
      Settle_ContractPool.unshift(SC)
      return setTimeout(() => OpenContainerRelayProcess(), 3000)
    }
    const tx = await FactoryWithRelay.relayContainerMainRelayedOpen(
      account,
      to,
      items,
      payload.currencyType,
      maxAmount,
      nonce_,
      deadline_,
      sigBytes
    )
    logger(`[AAtoEOA/OpenContainer] relay tx submitted hash=${tx.hash}`)
    // 立即返回 hash 给客户端，避免 tx.wait() 等待链上确认导致 502 超时
    if (!obj.res?.headersSent) obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end()
    await tx.wait().catch((waitErr: any) => {
      try {
        logger(Colors.yellow(`[AAtoEOA/OpenContainer] tx.wait() failed (RPC issue, tx submitted): ${waitErr?.shortMessage ?? waitErr?.message ?? String(waitErr)}`))
      } catch (_) {
        console.error('[AAtoEOA/OpenContainer] tx.wait() failed (RPC):', waitErr)
      }
    })

    // 以下记账通过 beamioTransferIndexerAccountingPool -> BeamioIndexerDiamond，客户端已收到 hash
    const currencyFromClient = obj.currency
    const currencyAmountFromClient = obj.currencyAmount
    const currencyTypeValue = BigInt(payload.currencyType)
    const currencyFromType = getICurrency(currencyTypeValue)
    const isCurrencyArray = Array.isArray(currencyFromClient)
    const isCurrencyAmountArray = Array.isArray(currencyAmountFromClient)
    
    logger(`[AAtoEOA/OpenContainer] currency/currencyAmount: client currency=${isCurrencyArray ? `[${currencyFromClient.length} items]` : (currencyFromClient ?? 'null')}, client currencyAmount=${isCurrencyAmountArray ? `[${currencyAmountFromClient.length} items]` : (currencyAmountFromClient ?? 'null')}, currencyType=${payload.currencyType}, currencyFromType=${currencyFromType}, items.length=${items.length}`)
    
    const usdcAddress = ethers.getAddress(USDC_ADDRESS)
    const ccsacardAddress = ethers.getAddress(BASE_CCSA_CARD_ADDRESS)
    let processedItemIndex = 0
    const collectedRouteItems: BeamioTransferRouteItem[] = []
    let totalAmountE6 = 0n
    let totalAmountUSDC6ForFee = 0n
    let primaryCurrency: ICurrency = currencyFromType
    let primaryCurrencyAmount = ''
    let ccsacardUnitPriceUSDC6 = 0n
    try {
      ccsacardUnitPriceUSDC6 = await SC.baseFactoryPaymaster.quoteUnitPointInUSDC6(ccsacardAddress)
    } catch (_) {}

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const itemAsset = ethers.getAddress(item.asset)
      const isUSDC = item.kind === 0 && itemAsset === usdcAddress
      const isCCSA = item.kind === 1 && itemAsset === ccsacardAddress

      if (!isUSDC && !isCCSA) {
        logger(Colors.yellow(`[AAtoEOA/OpenContainer] Skipping item ${i}: kind=${item.kind}, asset=${itemAsset} (not USDC or CCSA)`))
        continue
      }

      const assetType = isUSDC ? 'USDC' : 'CCSA'
      const assetAmount = item.amount
      const assetAmountHuman = String(Number(assetAmount) / 1e6)
      const itemCurrency = isCurrencyArray
        ? (currencyFromClient[processedItemIndex] ?? currencyFromType) as ICurrency
        : ((currencyFromClient as string) ?? currencyFromType) as ICurrency
      const itemCurrencyAmount = isCurrencyAmountArray
        ? (currencyAmountFromClient[processedItemIndex] ?? assetAmountHuman)
        : ((currencyAmountFromClient as string) ?? assetAmountHuman)

      logger(`[AAtoEOA/OpenContainer] Item ${i} (processedIndex ${processedItemIndex}): currency=${itemCurrency}, currencyAmount=${itemCurrencyAmount}, forText=${obj.forText ?? 'null'}`)
      processedItemIndex++

      const displayJsonData: DisplayJsonData = {
        title: 'Merchant Payment',
        source: 'open-container',
        finishedHash: tx.hash,
        handle: obj.forText?.trim()?.slice(0, 80),
        forText: obj.forText?.trim(),
      }
      logger(`[AAtoEOA/OpenContainer] Processing item ${i}: ${assetType}, amount=${assetAmount.toString()}`)
      logger(Colors.green(`✅ OpenContainerRelayProcess item ${i} displayJson = ${inspect(displayJsonData, false, 2, true)}`))

      if (isUSDC) {
        collectedRouteItems.push({
          asset: usdcAddress,
          amountE6: assetAmount.toString(),
          assetType: 0,
          source: 0,
          tokenId: '0',
        })
        totalAmountE6 += assetAmount
        totalAmountUSDC6ForFee += assetAmount
        primaryCurrency = itemCurrency
        primaryCurrencyAmount = itemCurrencyAmount
      } else if (isCCSA) {
        const tokenIdVal = item.tokenId
        const routeSource = tokenIdVal === 0n ? 1 : 2
        collectedRouteItems.push({
          asset: ccsacardAddress,
          amountE6: assetAmount.toString(),
          assetType: 1,
          source: routeSource,
          tokenId: tokenIdVal.toString(),
        })
        totalAmountE6 += assetAmount
        if (ccsacardUnitPriceUSDC6 > 0n) totalAmountUSDC6ForFee += (assetAmount * ccsacardUnitPriceUSDC6) / POINTS_ONE
        primaryCurrency = itemCurrency
        primaryCurrencyAmount = itemCurrencyAmount
      }
    }

    if (collectedRouteItems.length > 0) {
      // BUnit 由收款方（payee）负担，解析 to 为 EOA 供 consumeFromUser
      let payeeEOA: string = to
      try {
        const toCode = await SC.walletBase.provider!.getCode(to)
        if (toCode && toCode !== '0x' && toCode.length > 2) {
          const aaRead = new ethers.Contract(to, ['function owner() view returns (address)'], SC.walletBase.provider!)
          const owner = await aaRead.owner()
          if (owner && owner !== ethers.ZeroAddress) payeeEOA = ethers.getAddress(owner)
        }
      } catch (_) {}
      // Beamio 收费标准：1 USDC=100 BUnit，0.8% 费率，最低 2 BUnit，最高 200 BUnit，>=5000 USDC 时 500 BUnit
      const amountUSDC6ForFee = totalAmountUSDC6ForFee > 0n ? totalAmountUSDC6ForFee : totalAmountE6
      const { bServiceUnits6: feeBUnits6, bServiceUSDC6: feeBUsdc6 } = calcBeamioBUnitFee(amountUSDC6ForFee)
      beamioTransferIndexerAccountingPool.push({
        from: account,
        to,
        amountUSDC6: totalAmountE6.toString(),
        finishedHash: tx.hash,
        displayJson: JSON.stringify({
          title: 'Merchant Payment',
          source: 'open-container',
          finishedHash: tx.hash,
          handle: obj.forText?.trim()?.slice(0, 80),
          forText: obj.forText?.trim(),
        }),
        currency: primaryCurrency,
        currencyAmount: primaryCurrencyAmount,
        gasWei: '0',
        gasUSDC6: '0',
        gasChainType: 0,
        feePayer: payeeEOA,
        isInternalTransfer: false,
        requestHash: obj.requestHash,
        routeItems: collectedRouteItems,
        source: 'open-container',
        bServiceUSDC6: feeBUsdc6.toString(),
        bServiceUnits6: feeBUnits6.toString(),
      })
      logger(Colors.cyan(`[AAtoEOA/OpenContainer] pushed to beamioTransferIndexerAccountingPool routeItems=${collectedRouteItems.length} totalAmountE6=${totalAmountE6} amountUSDC6ForFee=${amountUSDC6ForFee} feePayer(payee)=${payeeEOA} bServiceUnits6=${feeBUnits6} bServiceUSDC6=${feeBUsdc6} requestHash=${obj.requestHash ?? 'n/a'}`))
    }
    
    beamioTransferIndexerAccountingProcess().catch((err: any) => {
      logger(Colors.red('[AAtoEOA/OpenContainer] beamioTransferIndexerAccountingProcess unhandled:'), err?.message ?? err)
    })
    
    const successMsg = `✅ OpenContainerRelayProcess accounting done: tx=${tx.hash}, indexer queue pushed`
    logger(Colors.green(successMsg))
  } catch (error: any) {
    let msg = error?.shortMessage || error?.message || String(error)
    try {
      if (error?.data) {
        logger(Colors.red(`[AAtoEOA/OpenContainer] revert data=${error.data}`))
        const data = typeof error.data === 'string' ? error.data : ethers.hexlify(error.data)
        if (data.length >= 4 + 32 * 4 && data.startsWith('0x')) {
          try {
            const selector = data.slice(0, 10)
            if (selector === '0xc6d837a8') {
              const abiCoder = ethers.AbiCoder.defaultAbiCoder()
              const decoded = abiCoder.decode(
                ['address', 'uint256', 'uint256', 'uint256'],
                '0x' + data.slice(10)
              ) as unknown as [string, bigint, bigint, bigint]
              const [, spend, bal] = decoded
              msg = `Insufficient USDC balance: account has ${(Number(bal) / 1e6).toFixed(2)} USDC, need ${(Number(spend) / 1e6).toFixed(2)} USDC`
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    logger(Colors.red(`❌ OpenContainerRelayProcess failed: ${msg}`))
    try {
      if (!obj.res?.headersSent) obj.res.status(500).json({ success: false, error: msg }).end()
    } catch (resErr: any) {
      logger(Colors.red(`[AAtoEOA/OpenContainer] failed to send error response: ${resErr?.message ?? resErr}`))
    }
  } finally {
    Settle_ContractPool.unshift(SC)
    setTimeout(() => OpenContainerRelayProcess(), 3000)
  }
}

/** 使用 Factory.relayContainerMainRelayed（绑定 to）代付 Gas 执行转账；与 AAtoEOAProcess 共用 Settle_ContractPool。 */
export const ContainerRelayProcess = async () => {
  const obj = ContainerRelayPool.shift()
  if (!obj) return

  const payload = obj.containerPayload
  logger(`[AAtoEOA/Container] process started account=${payload.account} to=${payload.to}`)

  const SC = Settle_ContractPool.shift()
  if (!SC) {
    logger(Colors.yellow(`[AAtoEOA/Container] no SC available, re-queue (pool ${ContainerRelayPool.length})`))
    ContainerRelayPool.unshift(obj)
    return setTimeout(() => ContainerRelayProcess(), 3000)
  }

  try {
    const account = ethers.getAddress(payload.account)
    const to = ethers.getAddress(payload.to)
    const items = payload.items.map((it) => ({
      kind: Number(it.kind),
      asset: ethers.getAddress(it.asset),
      amount: BigInt(it.amount),
      tokenId: BigInt(it.tokenId),
      data: typeof it.data === 'string' ? (it.data as string) : ethers.hexlify(it.data as Uint8Array),
    }))
    const nonce_ = BigInt(payload.nonce)
    const deadline_ = BigInt(payload.deadline)
    const sigHex = typeof payload.signature === 'string' && payload.signature.startsWith('0x') ? payload.signature : '0x' + payload.signature
    const sigBytes = ethers.getBytes(sigHex)

    const accountCode = await SC.walletBase.provider!.getCode(account)
    if (!accountCode || accountCode === '0x' || accountCode.length <= 2) {
      obj.res.status(400).json({ success: false, error: 'account has no contract code' }).end()
      Settle_ContractPool.unshift(SC)
      return setTimeout(() => ContainerRelayProcess(), 3000)
    }

    const chainNonce = await readContainerNonceFromAAStorage(SC.walletBase.provider!, account, 'relayed')
    if (chainNonce !== nonce_) {
      const errMsg = `Nonce mismatch: payload nonce=${nonce_} but chain relayedNonce=${chainNonce}. Please refresh and try again (do not resubmit the same request).`
      logger(Colors.red(`[AAtoEOA/Container] ${errMsg}`))
      obj.res.status(400).json({ success: false, error: errMsg }).end()
      Settle_ContractPool.unshift(SC)
      return setTimeout(() => ContainerRelayProcess(), 3000)
    }

    const FactoryWithRelay = new ethers.Contract(
      BeamioAAAccountFactoryPaymaster,
      [...(BeamioAAAccountFactoryPaymasterABI as any[]), RELAY_MAIN_ABI],
      SC.walletBase
    )
    const tx = await FactoryWithRelay.relayContainerMainRelayed(account, to, items, nonce_, deadline_, sigBytes)
    logger(`[AAtoEOA/Container] relay tx submitted hash=${tx.hash}`)
    const receipt = await tx.wait().catch((waitErr: any) => {
      try {
        logger(Colors.yellow(`[AAtoEOA/Container] tx.wait() failed (RPC): ${waitErr?.shortMessage ?? waitErr?.message ?? String(waitErr)}`))
      } catch (_) {
        console.error('[AAtoEOA/Container] tx.wait() failed (RPC):', waitErr)
      }
      return null
    })
    // Base 转账完成后立即返回 hash 给客户端，不等待记账
    if (!obj.res?.headersSent) obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end()

    // --- deduct 2 B-Units fee from feePayer on CoNET (with Base tx hash) ---
    const baseGas = receipt?.gasUsed ?? 0n
    let feePayer: string | null = null
    try {
      const aaRead = new ethers.Contract(
        account,
        ['function owner() view returns (address)'],
        SC.walletBase.provider!
      )
      feePayer = await aaRead.owner()
    } catch (_) {}
    if (feePayer && feePayer !== ethers.ZeroAddress) {
      const BUNIT_FEE_AMOUNT = 2_000_000n // 2 B-Units (6 decimals)
      const baseHashBytes32 = tx.hash as `0x${string}`
      const bunitAirdropWrite = new ethers.Contract(
        CONET_BUNIT_AIRDROP_ADDRESS,
        ['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
        SC.walletConet
      )
      try {
        const consumeTx = await bunitAirdropWrite.consumeFromUser(
          feePayer,
          BUNIT_FEE_AMOUNT,
          baseHashBytes32,
          baseGas,
          1n, // kind=1 -> txCategory=keccak256("sendUSDC")
          { gasLimit: 2_500_000 }
        )
        await consumeTx.wait()
        logger(Colors.cyan(`[AAtoEOA/Container] consumeFromUser ok: 2 B-Units from ${feePayer} baseHash=${tx.hash}`))
      } catch (consumeErr: any) {
        logger(Colors.red(`[AAtoEOA/Container] consumeFromUser failed (non-fatal): ${consumeErr?.shortMessage ?? consumeErr?.message ?? consumeErr}`))
      }
    } else {
      logger(Colors.yellow(`[AAtoEOA/Container] skip consumeFromUser: could not resolve AA owner for account=${account}`))
    }

    const usdcAmountRaw = obj.amountUSDC6 ? BigInt(obj.amountUSDC6) : BigInt(payload.items[0].amount)
    // ContainerRelayProcess 只处理单个 item，所以 currency 和 currencyAmount 应该是字符串
    const currencyValue = Array.isArray(obj.currency) ? obj.currency[0] : obj.currency
    const currencyAmountValue = Array.isArray(obj.currencyAmount) ? obj.currencyAmount[0] : obj.currencyAmount
    const currency = (currencyValue ?? 'USDC') as ICurrency
    const currencyAmount = currencyAmountValue ?? String(Number(usdcAmountRaw) / 1e6)
    const currencyDiscountValue = obj.currencyDiscount != null ? (Array.isArray(obj.currencyDiscount) ? obj.currencyDiscount[0] : obj.currencyDiscount) : undefined
    const currencyDiscountAmountValue = obj.currencyDiscountAmount != null ? (Array.isArray(obj.currencyDiscountAmount) ? obj.currencyDiscountAmount[0] : obj.currencyDiscountAmount) : undefined
    const displayJsonData: DisplayJsonData = {
      title: 'AA to EOA',
      source: 'container',
      finishedHash: tx.hash,
      handle: obj.forText?.trim()?.slice(0, 80),
      forText: obj.forText?.trim(),
    }
    logger(Colors.green(`✅ ContainerRelayProcess displayJson = ${inspect(displayJsonData, false, 2, true)}`))

    beamioTransferIndexerAccountingPool.push({
      from: account,
      to,
      amountUSDC6: usdcAmountRaw.toString(),
      finishedHash: tx.hash,
      displayJson: JSON.stringify(displayJsonData),
      currency,
      currencyAmount,
      gasWei: '0',
      gasUSDC6: '0',
      gasChainType: 0,
      feePayer: account,
      isInternalTransfer: true,
      requestHash: obj.requestHash,
    })
    logger(Colors.cyan(`[AAtoEOA/Container] pushed to beamioTransferIndexerAccountingPool (internal) from=${account} to=${to} amountUSDC6=${usdcAmountRaw} requestHash=${obj.requestHash ?? 'n/a'}`))
    beamioTransferIndexerAccountingProcess().catch((err: any) => {
      logger(Colors.red('[AAtoEOA/Container] beamioTransferIndexerAccountingProcess unhandled:'), err?.message ?? err)
    })
    logger(Colors.green(`✅ ContainerRelayProcess done: tx=${tx.hash}, indexer queue pushed`))
  } catch (error: any) {
    let msg = error?.shortMessage || error?.message || String(error)
    try {
      if (error?.data) {
        logger(Colors.red(`[AAtoEOA/Container] revert data=${error.data}`))
        const data = typeof error.data === 'string' ? error.data : ethers.hexlify(error.data)
        if (data.length >= 4 + 32 * 4 && data.startsWith('0x')) {
          const selector = data.slice(0, 10)
          if (selector === '0xc6d837a8') {
            // CM_ReservedERC20Violation(address token, uint256 spend, uint256 bal, uint256 reserved)
            const abiCoder = ethers.AbiCoder.defaultAbiCoder()
            const decoded = abiCoder.decode(
              ['address', 'uint256', 'uint256', 'uint256'],
              '0x' + data.slice(10)
            ) as unknown as [string, bigint, bigint, bigint]
            const [, spend, bal] = decoded
            const fmt = (n: number) => (n >= 0.01 ? n.toFixed(2) : n.toFixed(6))
            msg = `Insufficient USDC balance: account has ${fmt(Number(bal) / 1e6)} USDC, need ${fmt(Number(spend) / 1e6)} USDC`
          }
        }
      }
    } catch (_) {}
    logger(Colors.red(`❌ ContainerRelayProcess failed: ${msg}`))
    const dataHex = typeof error?.data === 'string' ? error.data : ''
    const isBadNonce = dataHex.length >= 10 && dataHex.slice(0, 10).toLowerCase() === '0x74794617'
    const isInsufficientBalance = dataHex.length >= 10 && dataHex.slice(0, 10).toLowerCase() === '0xc6d837a8'
    const clientError = isBadNonce
      ? 'Nonce already used (链上 nonce 已递增). 请重新发起转账，不要重复提交同一笔。'
      : msg
    try {
      if (!obj.res?.headersSent) obj.res.status(isBadNonce || isInsufficientBalance ? 400 : 500).json({ success: false, error: clientError }).end()
    } catch (resErr: any) {
      logger(Colors.red(`[AAtoEOA/Container] failed to send error response: ${resErr?.message ?? resErr}`))
    }
  } finally {
    Settle_ContractPool.unshift(SC)
    setTimeout(() => ContainerRelayProcess(), 3000)
  }
}


const cardOwnerPrivateKey = ""

const BeamioAAAccount = '0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61'



const test = async () => {
	await new Promise(executor => setTimeout(executor, 3000))
	const cardAddress = await createBeamioCardWithFactory(Settle_ContractPool[0].baseFactoryPaymaster, BeamioAAAccount, 'CAD', 1, {
		uri: 'https://api.beamio.io/metadata/default_card.json',
	})
	logger(Colors.green(`✅ createBeamioCardWithFactory success! cardAddress = ${cardAddress}`))
	// await DeployingSmartAccount(BeamioAAAccount, Settle_ContractPool[0].aaAccountFactoryPaymaster)			//			0x241B97Ee83bF8664D42c030447A63d209c546867
	// for (let i = 0; i < Settle_ContractPool.length; i++) {
	// 	await registerPayMasterForCardFactory(Settle_ContractPool[i].walletBase.address)
	// 	await new Promise(executor => setTimeout(executor, 3000))
	// }

	//		创建 新卡

	
	// 然后创建新卡
	
	// const kkk = await develop1(BeamioAAAccount, 'CAD', '1')			//CCSA 新卡地址： 0x241B97Ee83bF8664D42c030447A63d209c546867   --> 0x73b61F3Fa7347a848D9DAFd31C4930212D2B341F
	// logger(inspect(kkk, false, 3, true));
	//logger(inspect(kkk, false, 3, true))
	//getLatestCard(Settle_ContractPool[0], '0x733f860d1C97A0edD4d87BD63BA85Abb7f275F5E')
	//await USDC2Token(cardOwnerPrivateKey, 0.01, '0x7Dd5423FCB4924dD27E82EbAd54F4C81c0C7e4F6')
	//debugMembership('0x863D5B7DaD9C595138e209d932511Be4E168A660','0x733f860d1C97A0edD4d87BD63BA85Abb7f275F5E', )
	//await getMyAssets(BeamioAAAccount, '0xa955200E42573F0eC5498717c4fC72A4b81fFFf7')

	// const rates = await getAllRate()
	// logger(inspect(rates, false, 3, true))	
}

// test()


/** 管理员创建 BeamioUserCard，供 /api/createCard 调用。调用者需为工厂 paymaster（Settle_ContractPool[0]）。 */
export const createBeamioCardAdmin = async (
	cardOwner: string,
	currency: 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD',
	pointsUnitPriceInCurrencyE6: number | bigint,
	opts?: { uri?: string }
): Promise<string> => {
	const SC = Settle_ContractPool[0]
	if (!SC?.baseFactoryPaymaster) throw new Error('Settle_ContractPool not initialized')
	return createBeamioCardWithFactory(
		SC.baseFactoryPaymaster,
		cardOwner,
		currency,
		pointsUnitPriceInCurrencyE6,
		opts?.uri ? { uri: opts.uri } : {}
	)
}

/** 同 createBeamioCardAdmin，但返回 { cardAddress, hash } 供 createCardPoolPress 回传 tx hash。
 * @param factoryOverride 当 createCardPoolPress 传入 shift 出的 SC.baseFactoryPaymaster 时使用，确保使用正确的 signer（owner/paymaster）
 * @param tiers 可选，创建时一并传入链上（createCardCollectionWithInitCodeAndTiers） */
export const createBeamioCardAdminWithHash = async (
	cardOwner: string,
	currency: 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD',
	pointsUnitPriceInCurrencyE6: number | bigint,
	opts?: { uri?: string; tiers?: Array<{ minUsdc6: string; attr: number; tierExpirySeconds?: number; upgradeByBalance?: boolean }> },
	factoryOverride?: ethers.Contract
): Promise<{ cardAddress: string; hash: string }> => {
	const factory = factoryOverride ?? Settle_ContractPool[0]?.baseFactoryPaymaster
	if (!factory) throw new Error('Settle_ContractPool not initialized')
	const tiersForCreate = opts?.tiers?.map((t) => ({
		minUsdc6: t.minUsdc6,
		attr: t.attr,
		tierExpirySeconds: t.tierExpirySeconds ?? 0,
		upgradeByBalance: t.upgradeByBalance !== false,
	}))
	return createBeamioCardWithFactoryReturningHash(
		factory,
		cardOwner,
		currency,
		pointsUnitPriceInCurrencyE6,
		opts?.uri ? { uri: opts.uri } : {},
		tiersForCreate
	)
}

/** createCard 集群预检：校验 JSON 结构，不合格返回 error，合格才可转发 master。不写链。 */
export type CreateCardPreChecked = {
	cardOwner: string
	currency: 'CAD' | 'USD' | 'JPY' | 'CNY' | 'USDC' | 'HKD' | 'EUR' | 'SGD' | 'TWD'
	priceInCurrencyE6: string
	uri?: string
	shareTokenMetadata?: { name?: string; description?: string; image?: string }
	tiers?: Array<{ index: number; minUsdc6: string; attr: number; tierExpirySeconds?: number; name?: string; description?: string; image?: string; backgroundColor?: string; upgradeByBalance?: boolean }>
}

export const createCardPreCheck = (body: {
	cardOwner?: string
	currency?: string
	unitPriceHuman?: string | number
	priceInCurrencyE6?: string | number
	uri?: string
	shareTokenMetadata?: { name?: string; description?: string; image?: string }
	tiers?: unknown[]
}): { success: true; preChecked: CreateCardPreChecked } | { success: false; error: string } => {
	const validCurrency = ['CAD', 'USD', 'JPY', 'CNY', 'USDC', 'HKD', 'EUR', 'SGD', 'TWD']
	if (!body.cardOwner || !ethers.isAddress(body.cardOwner)) {
		return { success: false, error: 'cardOwner is required and must be a valid address' }
	}
	if (!body.currency || !validCurrency.includes(body.currency)) {
		return { success: false, error: `currency must be one of: ${validCurrency.join(', ')}` }
	}
	let priceE6: bigint
	if (body.unitPriceHuman != null && body.unitPriceHuman !== '') {
		const n = parseFloat(String(body.unitPriceHuman))
		if (!Number.isFinite(n) || n <= 0) {
			return { success: false, error: 'unitPriceHuman must be > 0' }
		}
		priceE6 = BigInt(Math.round(n * 1_000_000))
	} else if (body.priceInCurrencyE6 != null && body.priceInCurrencyE6 !== '') {
		priceE6 = BigInt(body.priceInCurrencyE6)
	} else {
		return { success: false, error: 'Missing required: unitPriceHuman or priceInCurrencyE6' }
	}
	if (priceE6 <= 0n) {
		return { success: false, error: 'price must be > 0' }
	}
	if (body.shareTokenMetadata != null && typeof body.shareTokenMetadata !== 'object') {
		return { success: false, error: 'shareTokenMetadata must be an object if provided' }
	}
	if (body.tiers != null) {
		if (!Array.isArray(body.tiers)) {
			return { success: false, error: 'tiers must be an array if provided' }
		}
		for (let i = 0; i < body.tiers.length; i++) {
			const t = body.tiers[i]
			if (!t || typeof t !== 'object') {
				return { success: false, error: `tiers[${i}] must be an object` }
			}
			const o = t as Record<string, unknown>
			if (o.index != null && typeof o.index !== 'number') {
				return { success: false, error: `tiers[${i}].index must be number` }
			}
			if (!o.minUsdc6 || typeof o.minUsdc6 !== 'string') {
				return { success: false, error: `tiers[${i}].minUsdc6 is required (string)` }
			}
			try {
				const minUsdc6 = BigInt(o.minUsdc6)
				if (minUsdc6 < 0n) return { success: false, error: `tiers[${i}].minUsdc6 must be >= 0` }
			} catch {
				return { success: false, error: `tiers[${i}].minUsdc6 must be an integer string` }
			}
			if (o.attr != null && typeof o.attr !== 'number') {
				return { success: false, error: `tiers[${i}].attr must be number` }
			}
			if (o.attr != null && (!Number.isInteger(o.attr) || (o.attr as number) < 0)) {
				return { success: false, error: `tiers[${i}].attr must be a non-negative integer` }
			}
			if (o.tierExpirySeconds != null) {
				const expiryNum = Number(o.tierExpirySeconds)
				if (!Number.isFinite(expiryNum) || expiryNum < 0 || !Number.isInteger(expiryNum)) {
					return { success: false, error: `tiers[${i}].tierExpirySeconds must be a non-negative integer if provided` }
				}
			}
			if (o.upgradeByBalance != null && typeof o.upgradeByBalance !== 'boolean') {
				return { success: false, error: `tiers[${i}].upgradeByBalance must be boolean if provided` }
			}
		}
	}
	const preChecked: CreateCardPreChecked = {
		cardOwner: ethers.getAddress(body.cardOwner),
		currency: body.currency as CreateCardPreChecked['currency'],
		priceInCurrencyE6: String(priceE6),
		...(body.uri && { uri: body.uri }),
		...(body.shareTokenMetadata && { shareTokenMetadata: body.shareTokenMetadata }),
		...(body.tiers && body.tiers.length > 0 && {
			tiers: body.tiers.map((t, i) => {
				const o = t as Record<string, unknown>
				return {
					index: typeof o.index === 'number' ? o.index : i,
					minUsdc6: String(o.minUsdc6),
					attr: typeof o.attr === 'number' ? o.attr : i,
					...(o.tierExpirySeconds != null && { tierExpirySeconds: Number(o.tierExpirySeconds) }),
					...(o.name != null && { name: String(o.name) }),
					...(o.description != null && { description: String(o.description) }),
					...(o.image != null && typeof o.image === 'string' && { image: o.image }),
					...(o.backgroundColor != null && typeof o.backgroundColor === 'string' && { backgroundColor: o.backgroundColor }),
					...(typeof o.upgradeByBalance === 'boolean' && { upgradeByBalance: o.upgradeByBalance }),
				}
			}),
		}),
	}
	return { success: true, preChecked }
}

/** Cluster 预检用：若 cardOwner 为 AA（有合约 code），替换为其 owner 的 EOA。Master 不再校验，降低负荷。 */
export const resolveCardOwnerToEOA = async (
	provider: ethers.Provider,
	cardOwner: string
): Promise<{ success: true; cardOwner: string } | { success: false; error: string }> => {
	const addr = ethers.getAddress(cardOwner)
	const code = await provider.getCode(addr)
	if (!code || code === '0x' || code.length <= 2) {
		return { success: true, cardOwner: addr }
	}
	try {
		const aaContract = new ethers.Contract(addr, ['function owner() view returns (address)'], provider)
		const eoaOwner = await aaContract.owner()
		if (eoaOwner && ethers.isAddress(eoaOwner) && ethers.getAddress(eoaOwner) !== ethers.ZeroAddress) {
			return { success: true, cardOwner: ethers.getAddress(eoaOwner) }
		}
		return { success: false, error: 'cardOwner is an AA account but owner() returned invalid address. Use EOA as cardOwner.' }
	} catch (e: any) {
		return { success: false, error: `cardOwner is an AA account but owner() failed: ${e?.message ?? e}` }
	}
}

export const createCardPool: (CreateCardPreChecked & { res: Response })[] = []

export const createCardPoolPress = async () => {
	const obj = createCardPool.shift() as (CreateCardPreChecked & { res: Response }) | undefined
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		createCardPool.unshift(obj)
		return setTimeout(() => createCardPoolPress(), 3000)
	}
	const { res, ...payload } = obj
	const { cardOwner, currency, priceInCurrencyE6, uri, shareTokenMetadata, tiers } = payload

	// Settle_ContractPool = factory 登记的 owner 列表，shift 取一 admin 用于 RPC，支持多 request 并行（多 admin 同时送上链）
	const factory = SC.baseFactoryPaymaster
	logger(Colors.cyan(`[createCardPoolPress] admin=${SC.walletBase.address} cardOwner=${cardOwner} currency=${currency} priceE6=${priceInCurrencyE6}`))

	try {
		const tiersForCreate = tiers && tiers.length > 0
			? tiers.map((t, i) => ({
					minUsdc6: t.minUsdc6,
					attr: Number(t.attr ?? i),
					tierExpirySeconds: Number(t.tierExpirySeconds ?? 0), // 0 => 使用卡全局 expirySeconds
					upgradeByBalance: t.upgradeByBalance !== false,
				}))
			: undefined
		const { cardAddress, hash } = await createBeamioCardAdminWithHash(
			cardOwner,
			currency,
			BigInt(priceInCurrencyE6),
			{ ...(uri && { uri }), ...(tiersForCreate && { tiers: tiersForCreate }) },
			SC.baseFactoryPaymaster
		)
		// master 侧写入 metadata（shareTokenMetadata、tiers）到 0x{cardAddress}0.json（ERC-1155 约定）
		const METADATA_BASE = process.env.METADATA_BASE ?? '/home/peter/.data/metadata'
		const cardAddr = ethers.getAddress(cardAddress)
		const metaFilename = `0x${cardAddr.slice(2).toLowerCase()}0.json`
		if (shareTokenMetadata || (tiers && tiers.length > 0)) {
			const name = shareTokenMetadata?.name ?? 'Beamio CCSA Card'
			const description = shareTokenMetadata?.description
			const image = shareTokenMetadata?.image != null && shareTokenMetadata.image !== '' ? shareTokenMetadata.image : undefined
			const metaContent = JSON.stringify({
				...(name && { name }),
				...(description != null && { description }),
				...(image && { image }),
				...(shareTokenMetadata && {
					shareTokenMetadata: {
						name,
						...(description != null && { description }),
						...(image && { image }),
					},
				}),
				...(tiers && tiers.length > 0 && { tiers }),
			}, null, 2)
			const metaPath = resolve(METADATA_BASE, metaFilename)
			const metaDir = resolve(METADATA_BASE)
			if (metaPath.startsWith(metaDir + '/') || metaPath === metaDir) {
				try {
					if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true })
					fs.writeFileSync(metaPath, metaContent, 'utf-8')
					logger(Colors.green(`[createCardPoolPress] wrote metadata: ${metaFilename}`))
				} catch (metaErr: any) {
					logger(Colors.yellow(`[createCardPoolPress] metadata write failed: ${metaErr?.message ?? metaErr}`))
				}
			}
		}
		logger(Colors.green(`[createCardPoolPress] card created: ${cardAddress} hash=${hash}`))
		registerCardToDb({
			cardAddress,
			cardOwner,
			currency,
			priceInCurrencyE6,
			uri: uri ?? undefined,
			shareTokenMetadata,
			tiers,
			txHash: hash,
		}).catch(() => {})
		if (res && !res.headersSent) res.status(200).json({ success: true, cardAddress, hash }).end()
	} catch (err: any) {
		const msg = err?.message ?? String(err)
		logger(Colors.red(`[createCardPoolPress] failed:`), msg)
		if (res && !res.headersSent) res.status(500).json({ success: false, error: msg }).end()
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => createCardPoolPress(), 3000)
	}
}

export const purchasingCard = async (cardAddress: string, userSignature: string, nonce: string, usdcAmount: string, from: string, validAfter: string, validBefore: string): Promise<{ success: boolean, message: string }|boolean> => {
	const SC = Settle_ContractPool[0]
	try {
		 // 1. 获取受益人 (Owner) - 仅作为签名参数，不需要 Owner 签名
		 const card = new ethers.Contract(cardAddress, [
            "function owner() view returns (address)"
        ], SC.walletBase); // 使用 adminn 账户进行提交
        
        const [cardOwner, USDC_Balance] =  await Promise.all([
			card.owner(),
			USDC_SmartContract.balanceOf(from)
		])

		logger(`[purchasingCard] USDC_Balance = ${USDC_Balance}`);
		logger(`[purchasingCard] usdcAmount = ${usdcAmount}`);
		logger(`[purchasingCard] cardOwner = ${cardOwner}`);
		logger(`[purchasingCard] ethers.parseUnits(usdcAmount, USDC_DECIMALS) = ${ethers.parseUnits(usdcAmount, USDC_DECIMALS)}`);
		
		if (USDC_Balance < usdcAmount) {
			return { success: false, message: 'USDC balance is not enough' }
		}
		

		
	} catch (error: any) {
		logger(Colors.red(`❌ purchasingCard failed:`), error.message);
		throw error;
	}

	return { success: true, message: 'Card purchased successfully!' }
}

/**
 * 构建 createRedeemBatch 的 calldata，供 cardCreateRedeemPreCheck 使用。
 * 默认使用 codes（string[]），每项 keccak256 得到 hash；若传 hashes 则直接使用。
 */
export const buildCardCreateRedeemBatchData = (params: {
	codes?: string[]
	hashes?: string[]
	points6: string | number | bigint
	attr: number
	validAfter: number
	validBefore: number
	tokenIds: (string | number | bigint)[]
	amounts: (string | number | bigint)[]
}): string => {
	const { codes, hashes, points6, attr, validAfter, validBefore, tokenIds, amounts } = params
	let hashArr: string[]
	if (hashes != null && hashes.length > 0) {
		hashArr = hashes
	} else if (codes != null && codes.length > 0) {
		hashArr = codes.map((c) => ethers.keccak256(ethers.toUtf8Bytes(c)))
	} else {
		throw new Error('codes or hashes required (non-empty array)')
	}
	// 若 tokenIds 含 POINTS_ID(0)，top-level points6 传 0 避免兑换时双倍 mint（点数由 bundle 提供）
	const pts6ForRedeem = tokenIds?.some((t) => Number(t) === 0) ? 0n : BigInt(points6 ?? 0)
	const iface = new ethers.Interface([
		'function createRedeemBatch(bytes32[] hashes, uint256 points6, uint256 attr, uint64 validAfter, uint64 validBefore, uint256[] tokenIds, uint256[] amounts)',
	])
	return iface.encodeFunctionData('createRedeemBatch', [
		hashArr,
		pts6ForRedeem,
		attr,
		validAfter,
		validBefore,
		tokenIds.map((t) => BigInt(t)),
		amounts.map((a) => BigInt(a)),
	])
}

const GET_REDEEM_STATUS_BATCH_ABI = [
	'function getRedeemStatusBatch(bytes32[] hashes) view returns (bool[] active, uint256[] totalPoints6)',
]

function _normalizeCardAddress(addr: string): string {
	return addr
}

function _decodeRedeemStatusApi(active: boolean): 'redeemed' | 'cancelled' | 'pending' {
	if (active) return 'pending'
	return 'cancelled'
}

/**
 * 批量查询 redeem 状态（供 API 使用）：按 card 分组调用 getRedeemStatusBatch。
 * 仅支持批量，items 至少 1 项。
 * 兼容：客户端发送旧 CCSA 地址时自动映射到新地址。
 */
export const getRedeemStatusBatchApi = async (
	items: { cardAddress: string; hash: string }[]
): Promise<Record<string, 'redeemed' | 'cancelled' | 'pending'>> => {
	const result: Record<string, 'redeemed' | 'cancelled' | 'pending'> = {}
	if (items.length === 0) return result
	const byCard = new Map<string, { hash: string }[]>()
	for (const it of items) {
		if (!ethers.isAddress(it.cardAddress)) continue
		const normalized = _normalizeCardAddress(it.cardAddress)
		const arr = byCard.get(normalized) ?? []
		arr.push({ hash: it.hash })
		byCard.set(normalized, arr)
	}
	try {
		// 优先使用 CoNET 节点访问 Base RPC；若该节点返回 404（如 /base-rpc 不存在）则回退到 1rpc.io/base
		let baseRpcUrl = getBaseRpcUrlViaConetNode()
		if (!baseRpcUrl) {
			const nodeCount = getGuardianNodesCount()
			logger(Colors.yellow('[getRedeemStatusBatchApi] no CoNET nodes, skip RPC'), {
				Guardian_Nodes_count: nodeCount,
				items_count: items.length,
				byCard_size: byCard.size,
			})
			items.forEach(({ hash }) => { result[hash] = 'pending' })
			return result
		}
		const fallbackRpcUrl = BASE_RPC_URL
		const baseNetwork = { name: 'base', chainId: 8453 } as const

		const runWithProvider = async (url: string) => {
			const provider = new ethers.JsonRpcProvider(url, baseNetwork, { staticNetwork: true })
			for (const [cardAddress, cardItems] of byCard) {
				const card = new ethers.Contract(cardAddress, GET_REDEEM_STATUS_BATCH_ABI, provider)
				const hashes = cardItems.map((i) =>
					i.hash.length === 66 && i.hash.startsWith('0x') ? (i.hash as `0x${string}`) : ethers.keccak256(ethers.toUtf8Bytes(i.hash))
				)
				const [activeList] = await card.getRedeemStatusBatch(hashes)
				cardItems.forEach((it, idx) => {
					result[it.hash] = _decodeRedeemStatusApi(activeList[idx])
				})
			}
		}

		try {
			await runWithProvider(baseRpcUrl)
		} catch (firstErr: any) {
			const is404OrServerError = firstErr?.code === 'SERVER_ERROR' || firstErr?.info?.responseStatus === 404 || (String(firstErr?.info?.responseStatus ?? '').includes('404')) || (firstErr?.message && String(firstErr.message).includes('404'))
			if (is404OrServerError && fallbackRpcUrl && fallbackRpcUrl !== baseRpcUrl) {
				logger(Colors.yellow('[getRedeemStatusBatchApi] CoNET node RPC failed, retry with fallback'), { url: baseRpcUrl, fallback: fallbackRpcUrl })
				await runWithProvider(fallbackRpcUrl)
			} else {
				throw firstErr
			}
		}
	} catch (e: any) {
		logger(Colors.red('[getRedeemStatusBatchApi] RPC error:'), e?.message ?? e)
		items.forEach(({ hash }) => { result[hash] = 'pending' })
	}
	return result
}

const adminManager4ArgIface = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata)'])
const adminManager5ArgIface = new ethers.Interface(['function adminManager(address to, bool admin, uint256 newThreshold, string metadata, uint256 mintLimit)'])
const ADMIN_MANAGER_4_SELECTOR = adminManager4ArgIface.getFunction('adminManager')?.selector ?? ''
const ADMIN_MANAGER_5_SELECTOR = adminManager5ArgIface.getFunction('adminManager')?.selector ?? ''

/** cardAddAdminByAdmin 集群预检：仅允许添加 EOA。body 必须含 adminEOA，data 的 to 必须等于 adminEOA。禁止添加 AA。 */
export const cardAddAdminByAdminPreCheck = async (body: {
	cardAddress?: string
	data?: string
	deadline?: number
	nonce?: string
	adminSignature?: string
	adminEOA?: string
}): Promise<{ success: true } | { success: false; error: string }> => {
	const { cardAddress, data, deadline, nonce, adminSignature, adminEOA } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!data || typeof data !== 'string' || data.length < 10) return { success: false, error: 'Missing or invalid data' }
	const dataSelector = data.slice(0, 10).toLowerCase()
	if (dataSelector !== ADMIN_MANAGER_4_SELECTOR.toLowerCase() && dataSelector !== ADMIN_MANAGER_5_SELECTOR.toLowerCase()) {
		return { success: false, error: 'Data must be adminManager(address,bool,uint256,string) or adminManager(...,uint256 mintLimit) calldata' }
	}
	try {
		const iface = dataSelector === ADMIN_MANAGER_5_SELECTOR.toLowerCase() ? adminManager5ArgIface : adminManager4ArgIface
		const decoded = iface.parseTransaction({ data })
		if (!decoded || decoded.name !== 'adminManager') return { success: false, error: 'Invalid adminManager calldata' }
		const to = decoded.args[0] as string
		if (!to || !ethers.isAddress(to)) return { success: false, error: 'Invalid to address' }
		if (decoded.args[1] === true) {
			if (!adminEOA || !ethers.isAddress(adminEOA)) return { success: false, error: 'adminEOA is required when adding admin. Pass the EOA address to add.' }
			if (to.toLowerCase() !== ethers.getAddress(adminEOA).toLowerCase()) {
				return { success: false, error: 'Adding AA as admin is no longer allowed. Pass adminEOA and encode adminManager(adminEOA, ...).' }
			}
			const pool = Settle_ContractPool
			if (pool?.length) {
				const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
				const codeAtCard = await provider.getCode(cardAddress)
				if (!codeAtCard || codeAtCard === '0x') return { success: false, error: 'Card contract not found' }
				const codeAtTo = await provider.getCode(to)
				if (codeAtTo && codeAtTo !== '0x') {
					return { success: false, error: 'Adding AA as admin is no longer allowed. Pass adminEOA and encode adminManager(adminEOA, ...).' }
				}
			}
		}
		if (deadline == null || !nonce || !adminSignature) return { success: false, error: 'Missing deadline, nonce, or adminSignature' }
		const adminCheck = await verifyExecuteForAdminSignerIsAdmin({
			cardAddr: ethers.getAddress(cardAddress),
			data,
			deadline,
			nonce,
			adminSignature,
		})
		if (!adminCheck.ok) return { success: false, error: adminCheck.error }
		if (decoded.args[1] === true) {
			const signer = (adminCheck as { ok: true; signer?: string }).signer
			if (signer && Settle_ContractPool?.length) {
				const provider = (Settle_ContractPool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
				const card = new ethers.Contract(cardAddress, ['function isAdmin(address) view returns (bool)', 'function adminParent(address) view returns (address)'], provider)
				const alreadyAdmin = await card.isAdmin(ethers.getAddress(to)) as boolean
				if (alreadyAdmin) {
					const parent = await card.adminParent(ethers.getAddress(to)) as string
					if (parent && parent !== ethers.ZeroAddress && parent.toLowerCase() !== ethers.getAddress(signer).toLowerCase()) {
						return { success: false, error: 'EOA is already admin under another parent. Only the parent admin who added it can update.' }
					}
				}
			}
		}
		return { success: true }
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

/** cardAddAdmin/cardAdminManager 集群预检：仅允许添加 EOA。body 必须含 adminEOA，data 的 to 必须等于 adminEOA。禁止添加 AA。 */
export const cardAddAdminPreCheck = async (body: {
	cardAddress?: string
	data?: string
	deadline?: number
	nonce?: string
	ownerSignature?: string
	adminEOA?: string
}): Promise<{ success: true } | { success: false; error: string }> => {
	const { cardAddress, data, deadline, nonce, ownerSignature, adminEOA } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!data || typeof data !== 'string' || data.length < 10) return { success: false, error: 'Missing or invalid data' }
	const dataSelector = data.slice(0, 10).toLowerCase()
	if (dataSelector !== ADMIN_MANAGER_4_SELECTOR.toLowerCase() && dataSelector !== ADMIN_MANAGER_5_SELECTOR.toLowerCase()) {
		return { success: false, error: 'Data must be adminManager(address,bool,uint256,string) or adminManager(...,uint256 mintLimit) calldata' }
	}
	try {
		const iface = dataSelector === ADMIN_MANAGER_5_SELECTOR.toLowerCase() ? adminManager5ArgIface : adminManager4ArgIface
		const decoded = iface.parseTransaction({ data })
		if (!decoded || decoded.name !== 'adminManager') return { success: false, error: 'Invalid adminManager calldata' }
		const to = decoded.args[0] as string
		if (!to || !ethers.isAddress(to)) return { success: false, error: 'Invalid to address' }
		if (decoded.args[1] === true) {
			if (!adminEOA || !ethers.isAddress(adminEOA)) return { success: false, error: 'adminEOA is required when adding admin. Pass the EOA address to add.' }
			if (to.toLowerCase() !== ethers.getAddress(adminEOA).toLowerCase()) {
				return { success: false, error: 'Adding AA as admin is no longer allowed. Pass adminEOA and encode adminManager(adminEOA, ...).' }
			}
			const pool = Settle_ContractPool
			if (pool?.length) {
				const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
				const codeAtCard = await provider.getCode(cardAddress)
				if (!codeAtCard || codeAtCard === '0x') return { success: false, error: 'Card contract not found' }
				const codeAtTo = await provider.getCode(to)
				if (codeAtTo && codeAtTo !== '0x') {
					return { success: false, error: 'Adding AA as admin is no longer allowed. Pass adminEOA and encode adminManager(adminEOA, ...).' }
				}
			}
			if (deadline == null || !nonce || !ownerSignature) return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
			const domain = { name: 'BeamioUserCardFactory', version: '1', chainId: 8453, verifyingContract: BASE_CARD_FACTORY }
			const types = { ExecuteForOwner: [{ name: 'cardAddress', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
			const dataHash = ethers.keccak256(data)
			const nonceBytes = (nonce.length === 66 && nonce.startsWith('0x') ? nonce : ethers.keccak256(ethers.toUtf8Bytes(nonce))) as `0x${string}`
			const value = { cardAddress: ethers.getAddress(cardAddress), dataHash, deadline: Number(deadline), nonce: nonceBytes }
			const digest = ethers.TypedDataEncoder.hash(domain, types, value)
			const signer = ethers.recoverAddress(digest, ownerSignature)
			if (Settle_ContractPool?.length) {
				const provider = (Settle_ContractPool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
				const card = new ethers.Contract(cardAddress, ['function isAdmin(address) view returns (bool)', 'function adminParent(address) view returns (address)'], provider)
				const alreadyAdmin = await card.isAdmin(ethers.getAddress(to)) as boolean
				if (alreadyAdmin) {
					const parent = await card.adminParent(ethers.getAddress(to)) as string
					if (parent && parent !== ethers.ZeroAddress) {
						return { success: false, error: 'EOA is already admin under another admin. Only the parent admin who added it can update.' }
					}
				}
			}
		}
		if (deadline == null || !nonce || !ownerSignature) return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
		return { success: true }
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

const createIssuedNftIface = new ethers.Interface([
	'function createIssuedNft(bytes32 title, uint64 validAfter, uint64 validBefore, uint256 maxSupply, uint256 priceInCurrency6, bytes32 sharedMetadataHash)',
])
const mintIssuedNftByGatewayIface = new ethers.Interface([
	'function mintIssuedNftByGateway(address userEOA, uint256 tokenId, uint256 amount)',
])
const ISSUED_NFT_START_ID_MEMBER = 100_000_000_000n
const CREATE_ISSUED_NFT_SELECTOR = createIssuedNftIface.getFunction('createIssuedNft')?.selector ?? ''

/** cardMintIssuedNftToAddress 集群预检：校验 targetAddress 为 EOA，tokenId>=ISSUED_NFT_START_ID，amount>0，card 存在，owner 签名有效。合格编码 data 并转发 master executeForOwner。 */
export const cardMintIssuedNftToAddressPreCheck = async (body: {
	cardAddress?: string
	targetAddress?: string
	tokenId?: string | number
	amount?: string | number
	deadline?: number
	nonce?: string
	ownerSignature?: string
}): Promise<{ success: true; preChecked: { cardAddress: string; data: string; deadline: number; nonce: string; ownerSignature: string } } | { success: false; error: string }> => {
	const { cardAddress, targetAddress, tokenId, amount, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!targetAddress || !ethers.isAddress(targetAddress)) return { success: false, error: 'Invalid targetAddress' }
	const tokenIdN = BigInt(tokenId ?? ISSUED_NFT_START_ID_MEMBER)
	const amountN = BigInt(amount ?? 1)
	if (tokenIdN < ISSUED_NFT_START_ID_MEMBER) return { success: false, error: 'tokenId must be >= ISSUED_NFT_START_ID (100000000000)' }
	if (amountN <= 0n) return { success: false, error: 'amount must be > 0' }
	if (deadline == null || !nonce || !ownerSignature) return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
	try {
		const data = mintIssuedNftByGatewayIface.encodeFunctionData('mintIssuedNftByGateway', [
			ethers.getAddress(targetAddress),
			tokenIdN,
			amountN,
		])
		const pool = Settle_ContractPool
		if (pool?.length) {
			const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
			const codeAtCard = await provider.getCode(cardAddress)
			if (!codeAtCard || codeAtCard === '0x') return { success: false, error: 'Card contract not found' }
			const codeAtTarget = await provider.getCode(targetAddress)
			if (codeAtTarget && codeAtTarget !== '0x') return { success: false, error: 'targetAddress must be EOA (AA/smart contract not allowed for mintIssuedNftByGateway)' }
			const card = new ethers.Contract(cardAddress, ['function owner() view returns (address)', 'function balanceOf(address account, uint256 id) view returns (uint256)'], provider)
			const owner = await card.owner()
			if (!owner || owner === ethers.ZeroAddress) return { success: false, error: 'Card has no owner' }
			const existingBal = (await card.balanceOf(targetAddress, tokenIdN)) as bigint
			if (existingBal > 0n) return { success: false, error: 'Already registered as merchant' }
			const factory = new ethers.Contract(BASE_CARD_FACTORY, ['function DOMAIN_SEPARATOR() view returns (bytes32)'], provider)
			const domain = { name: 'BeamioUserCardFactory', version: '1', chainId: 8453, verifyingContract: BASE_CARD_FACTORY }
			const types = { ExecuteForOwner: [{ name: 'cardAddress', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
			const dataHash = ethers.keccak256(data)
			const nonceBytes = nonce.length === 66 && nonce.startsWith('0x') ? (nonce as `0x${string}`) : ethers.keccak256(ethers.toUtf8Bytes(nonce)) as `0x${string}`
			const value = { cardAddress: ethers.getAddress(cardAddress), dataHash, deadline: Number(deadline), nonce: nonceBytes }
			const digest = ethers.TypedDataEncoder.hash(domain, types, value)
			const signer = ethers.recoverAddress(digest, ownerSignature)
			if (signer.toLowerCase() !== ethers.getAddress(owner).toLowerCase()) {
				return { success: false, error: 'Signature does not match card owner' }
			}
		}
		return {
			success: true,
			preChecked: {
				cardAddress: ethers.getAddress(cardAddress),
				data,
				deadline: Number(deadline),
				nonce: String(nonce),
				ownerSignature: String(ownerSignature),
			},
		}
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}
const BeamioUserCardIface = new ethers.Interface(BeamioUserCardABI as ethers.InterfaceAbi)
const ISSUED_NFT_CREATED_TOPIC = ethers.id('IssuedNftCreated(uint256,bytes32,uint64,uint64,uint256,uint256,bytes32)')

/** cardCreateIssuedNft 集群预检：校验 data 为 createIssuedNft，maxSupply>0，validBefore>=validAfter（validBefore!=0 时），card 存在。合格转发 master executeForOwner，Master 不再校验。 */
export const cardCreateIssuedNftPreCheck = async (body: {
	cardAddress?: string
	data?: string
	deadline?: number
	nonce?: string
	ownerSignature?: string
}): Promise<{ success: true } | { success: false; error: string }> => {
	const { cardAddress, data, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!data || typeof data !== 'string' || data.length < 10) return { success: false, error: 'Missing or invalid data' }
	const expectedSelector = createIssuedNftIface.getFunction('createIssuedNft')?.selector ?? ''
	if (data.slice(0, 10).toLowerCase() !== expectedSelector.toLowerCase()) {
		return { success: false, error: 'Data must be createIssuedNft(bytes32,uint64,uint64,uint256,uint256,bytes32) calldata' }
	}
	try {
		const decoded = createIssuedNftIface.parseTransaction({ data })
		if (!decoded || decoded.name !== 'createIssuedNft') return { success: false, error: 'Invalid createIssuedNft calldata' }
		const [, validAfter, validBefore, maxSupply] = decoded.args
		const validAfterN = Number(validAfter)
		const validBeforeN = Number(validBefore)
		const maxSupplyN = BigInt(maxSupply)
		if (maxSupplyN === 0n) return { success: false, error: 'maxSupply must be > 0' }
		if (validBeforeN !== 0 && validBeforeN < validAfterN) {
			return { success: false, error: 'validBefore must be >= validAfter when not 0' }
		}
		const pool = Settle_ContractPool
		if (pool?.length) {
			const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
			const codeAtCard = await provider.getCode(cardAddress)
			if (!codeAtCard || codeAtCard === '0x') return { success: false, error: 'Card contract not found' }
		}
		if (deadline == null || !nonce || !ownerSignature) return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
		return { success: true }
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

const createRedeemAdmin4ArgIface = new ethers.Interface([
	'function createRedeemAdmin(bytes32 hash, string metadata, uint64 validAfter, uint64 validBefore)',
])
const createRedeemAdmin5ArgIface = new ethers.Interface([
	'function createRedeemAdmin(bytes32 hash, string metadata, uint64 validAfter, uint64 validBefore, uint256 mintLimit)',
])
const CREATE_REDEEM_ADMIN_4_SELECTOR = createRedeemAdmin4ArgIface.getFunction('createRedeemAdmin')?.selector ?? ''
const CREATE_REDEEM_ADMIN_5_SELECTOR = createRedeemAdmin5ArgIface.getFunction('createRedeemAdmin')?.selector ?? ''

/** cardClearAdminMintCounter 集群预检：parent admin 签字清零 subordinate 的 mint 计数。校验 signer == card.adminParent(subordinate)。 */
export const cardClearAdminMintCounterPreCheck = async (body: {
	cardAddress?: string
	subordinate?: string
	deadline?: number
	nonce?: string
	adminSignature?: string
}): Promise<{ success: true } | { success: false; error: string }> => {
	const { cardAddress, subordinate, deadline, nonce, adminSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!subordinate || !ethers.isAddress(subordinate)) return { success: false, error: 'Invalid subordinate' }
	if (deadline == null || !nonce || !adminSignature) return { success: false, error: 'Missing deadline, nonce, or adminSignature' }
	if (deadline < Math.floor(Date.now() / 1000)) return { success: false, error: 'Signature expired' }
	try {
		const card = new ethers.Contract(cardAddress, ['function adminParent(address) view returns (address)'], providerBaseBackup)
		const parent = await card.adminParent(ethers.getAddress(subordinate)) as string
		if (!parent || parent === ethers.ZeroAddress) return { success: false, error: 'Subordinate has no parent (owner-added admin cannot be cleared by another admin)' }
		const domain = { name: 'BeamioUserCardFactory', version: '1', chainId: 8453, verifyingContract: BASE_CARD_FACTORY }
		const types = { ClearAdminMintCounter: [{ name: 'cardAddress', type: 'address' }, { name: 'subordinate', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
		const nonceBytes = nonce.length === 66 && nonce.startsWith('0x') ? (nonce as `0x${string}`) : ethers.keccak256(ethers.toUtf8Bytes(nonce)) as `0x${string}`
		const value = { cardAddress: ethers.getAddress(cardAddress), subordinate: ethers.getAddress(subordinate), deadline: Number(deadline), nonce: nonceBytes }
		const digest = ethers.TypedDataEncoder.hash(domain, types, value)
		const signer = ethers.recoverAddress(digest, adminSignature)
		if (ethers.getAddress(signer) !== ethers.getAddress(parent)) {
			return { success: false, error: 'Signer must be subordinate\'s parent admin' }
		}
		return { success: true }
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

/** cardClearAdminMintCounter 执行：Master 调用 Factory.executeClearAdminMintCounter（Card 链上记账）与 Indexer.clearAdminMintCounterForSubordinate。 */
export const cardClearAdminMintCounterProcess = async (payload: {
	cardAddress: string
	subordinate: string
	deadline: number
	nonce: string
	adminSignature: string
}): Promise<{ success: true; tx: string } | { success: false; error: string }> => {
	const { cardAddress, subordinate, deadline, nonce, adminSignature } = payload
	const pool = Settle_ContractPool
	if (!pool?.length) return { success: false, error: 'Settle_ContractPool empty' }
	const SC = pool[0]
	const nonceBytes32 = (nonce.length === 66 && nonce.startsWith('0x') ? nonce : ethers.keccak256(ethers.toUtf8Bytes(nonce))) as `0x${string}`

	// 1) Card 链上记账：Factory.executeClearAdminMintCounter
	const factoryAbi = ['function executeClearAdminMintCounter(address cardAddress,address subordinate,uint256 deadline,bytes32 nonce,bytes adminSignature)']
	const factory = new ethers.Contract(BASE_CARD_FACTORY, factoryAbi, SC.walletBase)
	const txCard = await factory.executeClearAdminMintCounter(
		ethers.getAddress(cardAddress),
		ethers.getAddress(subordinate),
		Number(deadline),
		nonceBytes32,
		adminSignature as `0x${string}`
	)
	await txCard.wait()

	// 2) Indexer 记账
	const statsFacet = new ethers.Contract(BeamioTaskIndexerAddress, StatsABI as ethers.InterfaceAbi, SC.walletConet)
	const txIndexer = await statsFacet.clearAdminMintCounterForSubordinate(ethers.getAddress(cardAddress), ethers.getAddress(subordinate))
	await txIndexer.wait()
	return { success: true, tx: txCard.hash }
}

/** cardCreateRedeemAdmin 集群预检：校验 data 为 createRedeemAdmin(hash, metadata, validAfter, validBefore[, mintLimit])，hash 非零，card 存在。合格转发 master executeForOwner。 */
export const cardCreateRedeemAdminPreCheck = async (body: {
	cardAddress?: string
	data?: string
	deadline?: number
	nonce?: string
	ownerSignature?: string
}): Promise<{ success: true } | { success: false; error: string }> => {
	const { cardAddress, data, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!data || typeof data !== 'string' || data.length < 10) return { success: false, error: 'Missing or invalid data' }
	const dataSelector = data.slice(0, 10).toLowerCase()
	if (dataSelector !== CREATE_REDEEM_ADMIN_4_SELECTOR.toLowerCase() && dataSelector !== CREATE_REDEEM_ADMIN_5_SELECTOR.toLowerCase()) {
		return { success: false, error: 'Data must be createRedeemAdmin(bytes32,string,uint64,uint64) or createRedeemAdmin(...,uint256 mintLimit) calldata' }
	}
	try {
		const iface = dataSelector === CREATE_REDEEM_ADMIN_5_SELECTOR.toLowerCase() ? createRedeemAdmin5ArgIface : createRedeemAdmin4ArgIface
		const decoded = iface.parseTransaction({ data })
		if (!decoded || decoded.name !== 'createRedeemAdmin') return { success: false, error: 'Invalid createRedeemAdmin calldata' }
		const [hash] = decoded.args
		if (!hash || hash === ethers.ZeroHash) return { success: false, error: 'hash must be non-zero (keccak256 of secret code)' }
		const pool = Settle_ContractPool
		if (pool?.length) {
			const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
			const codeAtCard = await provider.getCode(cardAddress)
			if (!codeAtCard || codeAtCard === '0x') return { success: false, error: 'Card contract not found' }
		}
		if (deadline == null || !nonce || !ownerSignature) return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
		return { success: true }
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

/** cardRedeemAdmin 集群预检：拉取链上 getRedeemAdminStatus(hash) 验证 redeem code 是否有效。非法则不予转发 master。 */
export const cardRedeemAdminPreCheck = async (body: {
	cardAddress?: string
	redeemCode?: string
	to?: string
}): Promise<{ success: true } | { success: false; error: string }> => {
	const { cardAddress, redeemCode, to } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	if (!redeemCode || typeof redeemCode !== 'string' || !redeemCode.trim()) return { success: false, error: 'Missing or invalid redeemCode' }
	if (!to || !ethers.isAddress(to)) return { success: false, error: 'Invalid to address' }
	try {
		const hash = ethers.keccak256(ethers.toUtf8Bytes(redeemCode.trim()))
		const cardAbi = ['function getRedeemAdminStatus(bytes32 hash) view returns (bool active)']
		const card = new ethers.Contract(cardAddress, cardAbi, providerBaseBackup)
		const active = await card.getRedeemAdminStatus(hash)
		if (!active) {
			return { success: false, error: 'Redeem admin code is invalid or expired' }
		}
		return { success: true }
	} catch (e: any) {
		const msg = e?.message ?? e?.shortMessage ?? String(e)
		logger(Colors.red(`[cardRedeemAdminPreCheck] ${msg}`))
		return { success: false, error: msg }
	}
}

/** cardRedeemAdmin：用户兑换 redeem-admin 码，将 EOA 用户登记为指定卡的 admin。服务端调用 factory.redeemAdminForUser。 */
export const cardRedeemAdminPool: {
	cardAddress: string
	redeemCode: string
	to: string
	res?: Response
}[] = []

/** cardRedeemAdminProcess：用户兑换 redeem-admin 码，服务端调用 factory.redeemAdminForUser，将用户登记为指定卡的 admin。若 to 为 EOA 无 AA，先创建 AA 再使用 AA 地址（对齐 cardAddAdmin）。 */
export const cardRedeemAdminProcess = async () => {
	const obj = cardRedeemAdminPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		cardRedeemAdminPool.unshift(obj)
		return setTimeout(() => cardRedeemAdminProcess(), 3000)
	}
	logger(Colors.cyan(`[cardRedeemAdminProcess] processing card=${obj.cardAddress} to(EOA)=${obj.to} codeLen=${obj.redeemCode?.length ?? 0}`))
	try {
		const factory = SC.baseFactoryPaymaster
		let toForRedeem = obj.to
		if (SC.aaAccountFactoryPaymaster && obj.to && ethers.isAddress(obj.to)) {
			const provider = (SC.walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
			const codeAtTo = await provider.getCode(obj.to)
			if (!codeAtTo || codeAtTo === '0x') {
				let aaAddr = await SC.aaAccountFactoryPaymaster.beamioAccountOf(obj.to)
				if (!aaAddr || aaAddr === ethers.ZeroAddress) aaAddr = await SC.aaAccountFactoryPaymaster.primaryAccountOf(obj.to)
				const hasAA = aaAddr && aaAddr !== ethers.ZeroAddress && (await provider.getCode(aaAddr)) !== '0x'
				if (!hasAA) {
					logger(Colors.cyan(`[cardRedeemAdmin] EOA ${obj.to} has no AA, creating...`))
					const { accountAddress } = await DeployingSmartAccount(obj.to, SC.aaAccountFactoryPaymaster)
					if (accountAddress) {
						logger(Colors.green(`[cardRedeemAdmin] created AA ${accountAddress} for EOA ${obj.to}, using AA for redeemAdmin`))
						toForRedeem = ethers.getAddress(accountAddress)
					}
				} else {
					toForRedeem = ethers.getAddress(aaAddr)
				}
			}
		}
		const tx = await factory.redeemAdminForUser(obj.cardAddress, obj.redeemCode, toForRedeem)
		await tx.wait()
		const txHash = tx.hash
		logger(Colors.green(`✅ cardRedeemAdminProcess card=${obj.cardAddress} to(EOA)=${obj.to} tx=${txHash}`))
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, tx: txHash }).end()
	} catch (e: any) {
		const errMsg = e?.reason ?? e?.message ?? e?.shortMessage ?? String(e)
		logger(Colors.red(`❌ cardRedeemAdminProcess failed:`), errMsg)
		const dataHex = typeof e?.data === 'string' ? e.data
			: (e?.data && typeof e.data === 'object' && typeof (e.data as any).data === 'string') ? (e.data as any).data
			: e?.info?.error?.data ?? e?.error?.data ?? ''
		const dataStr = String(dataHex || errMsg)
		let clientError = errMsg
		if (/UC_InvalidProposal|UC_RedeemDelegateFailed|0xfb713d2b|dccff669|UC_PoolAlreadyClaimed|0x038039a7/.test(dataStr)) {
			if (/UC_InvalidTimeWindow|0xf88c1f68/.test(dataStr)) {
				clientError = 'Redeem admin code has expired. Check validAfter/validBefore.'
			} else {
				clientError = 'Code not found or already used. Please ensure you\'re redeeming against the correct card.'
			}
		}
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: clientError }).end()
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => cardRedeemAdminProcess(), 3000)
	}
}

/** cardCreateRedeem 集群预检：校验 JSON、可选链上校验（card 存在、factoryGateway），合格返回 preChecked 供转发 master。不写链。 */
export type CardCreateRedeemPreChecked = {
	cardAddress: string
	data: string
	deadline: number
	nonce: string
	ownerSignature: string
}

export const cardCreateRedeemPreCheck = async (body: {
	cardAddress?: string
	codes?: string[]
	hashes?: string[]
	points6?: string | number
	attr?: number
	validAfter?: number
	validBefore?: number
	tokenIds?: (string | number)[]
	amounts?: (string | number)[]
	deadline?: number
	nonce?: string
	ownerSignature?: string
}): Promise<{ success: true; preChecked: CardCreateRedeemPreChecked } | { success: false; error: string }> => {
	const { cardAddress, codes, hashes, points6, attr, validAfter, validBefore, tokenIds, amounts, deadline, nonce, ownerSignature } = body
	if (!cardAddress || !ethers.isAddress(cardAddress)) {
		return { success: false, error: 'Invalid cardAddress' }
	}
	if ((!codes || codes.length === 0) && (!hashes || hashes.length === 0)) {
		return { success: false, error: 'codes or hashes required (non-empty array)' }
	}
	if (!tokenIds || !amounts || tokenIds.length !== amounts.length) {
		return { success: false, error: 'tokenIds and amounts required, same length' }
	}
	for (let i = 0; i < amounts.length; i++) {
		if (BigInt(amounts[i]) <= 0n) {
			return { success: false, error: `amounts[${i}] must be > 0` }
		}
	}
	if (deadline == null || deadline === undefined || !nonce || !ownerSignature) {
		return { success: false, error: 'Missing deadline, nonce, or ownerSignature' }
	}
	try {
		const data = buildCardCreateRedeemBatchData({
			codes,
			hashes,
			points6: points6 ?? 0,
			attr: attr ?? 0,
			validAfter: validAfter ?? 0,
			validBefore: validBefore ?? 0,
			tokenIds,
			amounts,
		})
		const pool = Settle_ContractPool
		if (pool?.length) {
			const provider = (pool[0].walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
			const code = await provider.getCode(cardAddress)
			if (!code || code === '0x') {
				return { success: false, error: 'Card contract not found or not deployed' }
			}
			const card = new ethers.Contract(cardAddress, ['function factoryGateway() view returns (address)'], provider)
			const gw = await card.factoryGateway()
			if (!gw || gw === ethers.ZeroAddress) {
				return { success: false, error: 'Card factoryGateway not configured' }
			}
		}
		return {
			success: true,
			preChecked: {
				cardAddress: ethers.getAddress(cardAddress),
				data,
				deadline: Number(deadline),
				nonce: String(nonce),
				ownerSignature: String(ownerSignature),
			},
		}
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

/**
 * executeForOwnerProcess：通用，owner 签名的 calldata 由 paymaster 执行。若带 redeemCode+toUserEOA 则额外执行 redeemForUser（空投）。
 */
export const executeForOwnerProcess = async () => {
	const obj = executeForOwnerPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		executeForOwnerPool.unshift(obj)
		return setTimeout(() => executeForOwnerProcess(), 3000)
	}
	try {
		const factory = SC.baseFactoryPaymaster
		if (SC.aaAccountFactoryPaymaster && obj.data) {
			const dataSelector = obj.data.slice(0, 10).toLowerCase()
			const isAdminManager = dataSelector === ADMIN_MANAGER_4_SELECTOR.toLowerCase() || dataSelector === ADMIN_MANAGER_5_SELECTOR.toLowerCase()
			if (isAdminManager) {
				const iface = dataSelector === ADMIN_MANAGER_5_SELECTOR.toLowerCase() ? adminManager5ArgIface : adminManager4ArgIface
				const decoded = iface.parseTransaction({ data: obj.data })
				if (decoded?.name === 'adminManager' && decoded.args[1] === true) {
					const to = decoded.args[0] as string
					if (to && ethers.isAddress(to)) {
						const provider = (SC.walletBase as ethers.Wallet)?.provider ?? providerBaseBackup
						const codeAtTo = await provider.getCode(to)
						// 必须链上校验：不能因收到 AA 地址就跳过检测。若 to 有 code 则视为已部署 AA，直接执行；若无 code 则视为 EOA，需为其创建 AA。
						if (!codeAtTo || codeAtTo === '0x') {
							// to 无 code：可能是 EOA 或预测的 AA。仅 EOA 可作 createAccountFor(creator)；预测 AA 不可。客户端应传 EOA 而非预测地址。
							let aaAddr = await SC.aaAccountFactoryPaymaster.beamioAccountOf(to)
							if (!aaAddr || aaAddr === ethers.ZeroAddress) aaAddr = await SC.aaAccountFactoryPaymaster.primaryAccountOf(to)
							const hasAA = aaAddr && aaAddr !== ethers.ZeroAddress && (await provider.getCode(aaAddr)) !== '0x'
							if (!hasAA) {
								logger(Colors.cyan(`[cardAddAdmin] EOA ${to} has no AA, creating...`))
								await DeployingSmartAccount(to, SC.aaAccountFactoryPaymaster)
								logger(Colors.green(`[cardAddAdmin] AA created for EOA ${to}, proceeding with original data (EOA as admin)`))
							}
						}
					}
				}
			}
		}
		const tx = await factory.executeForOwner(
			obj.cardAddress,
			obj.data,
			obj.deadline,
			obj.nonce,
			obj.ownerSignature
		)
		const hash = tx?.hash as string | undefined
		let code: string | undefined
		if (obj.redeemCode != null && obj.toUserEOA != null) {
			await factory.redeemForUser(obj.cardAddress, obj.redeemCode, obj.toUserEOA)
			code = obj.redeemCode
			logger(Colors.green(`✅ executeForOwnerProcess + redeemForUser card=${obj.cardAddress} to=${obj.toUserEOA}`))
		} else {
			logger(Colors.green(`✅ executeForOwnerProcess card=${obj.cardAddress}`))
		}
		if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, ...(code != null && { code }), ...(hash && { hash }) }).end()
		// createIssuedNft 成功后异步写入 EIP-1155 tier metadata，供 GET /metadata/0x{card}{tokenId}.json 返回
		if (hash && obj.data && obj.data.slice(0, 10) === CREATE_ISSUED_NFT_SELECTOR) {
			const cardAddress = obj.cardAddress
			const descriptionFromBody = typeof obj.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined
			const imageFromBody = typeof obj.image === 'string' && obj.image.trim() ? obj.image.trim() : undefined
			const backgroundColorFromBody = typeof obj.background_color === 'string' && obj.background_color.trim() ? obj.background_color.trim() : undefined
			;(async () => {
				try {
					const receipt = await tx.wait()
					if (!receipt || receipt.status !== 1) return
					const cardAddrLower = cardAddress.toLowerCase()
					for (const log of receipt.logs) {
						if (log.address.toLowerCase() !== cardAddrLower || log.topics[0] !== ISSUED_NFT_CREATED_TOPIC) continue
						const parsed = BeamioUserCardIface.parseLog({ topics: log.topics, data: log.data })
						if (!parsed || parsed.name !== 'IssuedNftCreated') continue
						const tokenId = Number(parsed.args.tokenId)
						let cardOwner = (await getCardByAddress(cardAddress))?.cardOwner
						if (!cardOwner) {
							const card = new ethers.Contract(cardAddress, BeamioUserCardABI, providerBase)
							const owner = await card.owner()
							cardOwner = typeof owner === 'string' ? owner : String(owner)
						}
						const metadataJson: Record<string, unknown> = {
							name: `Issued NFT #${tokenId}`,
							description: descriptionFromBody ?? 'Issued NFT tier. ERC-1155 metadata for Base Explorer.',
							image: imageFromBody ?? 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'1\' height=\'1\'/%3E',
							...(backgroundColorFromBody && { background_color: backgroundColorFromBody }),
							properties: {
								...(backgroundColorFromBody && { background_color: backgroundColorFromBody }),
							},
						}
						await upsertNftTierMetadata({ cardAddress, cardOwner, tokenId, metadataJson })
						logger(Colors.green(`[createIssuedNft] upserted tier metadata card=${cardAddress} tokenId=${tokenId}`))
						break
					}
				} catch (e: any) {
					logger(Colors.yellow(`[createIssuedNft] background metadata upsert failed: ${e?.message ?? e}`))
				}
			})()
		}
	} catch (e: any) {
		const msg = String(e?.message ?? e)
		const isNonceRace = msg.includes('nonce too low') || msg.includes('nonce has already been used') || e?.code === 'NONCE_EXPIRED'
		if (isNonceRace) {
			logger(Colors.yellow(`[executeForOwnerProcess] nonce race (ensureAAForEOA + cardAddAdmin 并发), re-queueing: ${msg}`))
			executeForOwnerPool.unshift(obj)
		} else {
			logger(Colors.red(`❌ executeForOwnerProcess failed:`), e?.message ?? e)
			let errMsg = e?.message ?? String(e)
			const errData = (e?.data ?? e?.info?.error?.data ?? e?.error?.data) as string | undefined
			// UC_RedeemDelegateFailed(bytes) 空 data 通常表示 RedeemModule 不支持 createRedeemBatch（旧版）
			if (typeof errData === 'string' && /dccff669/.test(errData) && /0000000000000000000000000000000000000000000000000000000000000000$/.test(errData.slice(-64))) {
				errMsg = 'Redeem module does not support createRedeemBatch. Run: npx hardhat run scripts/verifyAndFixRedeemModule.ts --network base'
				logger(Colors.yellow('💡'), errMsg)
			}
			if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: errMsg }).end()
		}
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => executeForOwnerProcess(), 3000)
	}
}

/** 成员 NFT tokenId 范围（与 BeamioERC1155Logic 一致） */
const NFT_START_ID = 100
const ISSUED_NFT_START_ID = 100_000_000_000

/**
 * redeem/mint 成功后同步该用户在该卡上的成员 NFT 的 tier metadata 到 DB，
 * 供 GET /metadata/0x{owner}{NFT#}.json 返回。tier 选取与 getUIDAssets 一致：按 minUsdc6 升序排序，Default/Max 对应低档（tiersSorted[0]）；写入 1155 JSON 含 name/description/image/backgroundColor。
 */
export const syncNftTierMetadataForUser = async (cardAddress: string, userEOA: string): Promise<void> => {
	try {
		const SC = Settle_ContractPool[0]
		if (!SC) return
		const getAddressFn = SC.aaAccountFactoryPaymaster.getFunction('getAddress(address,uint256)')
		const accountAddress = await getAddressFn(userEOA, 0n).catch(() => null) as string | null
		if (!accountAddress || accountAddress === ethers.ZeroAddress) return
		const card = new ethers.Contract(cardAddress, BeamioUserCardABI, providerBase)
		const [cardOwner, ownership] = await Promise.all([
			card.owner(),
			card.getOwnership(accountAddress),
		])
		const nfts = Array.isArray(ownership) ? (ownership[1] ?? []) : (ownership?.nfts ?? [])
		if (nfts.length === 0) return
		const cardMeta = await getCardByAddress(cardAddress)
		if (!cardMeta?.metadata?.tiers || !Array.isArray(cardMeta.metadata.tiers)) return
		const tiersRaw = cardMeta.metadata.tiers as Array<{ index?: number; minUsdc6?: string; attr?: number; name?: string; description?: string; image?: string; backgroundColor?: string }>
		const minUsdc6Num = (t: { minUsdc6?: string }) => {
			const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : ''
			const n = parseInt(s, 10)
			return Number.isNaN(n) ? Infinity : n
		}
		const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b))
		const shareTokenMetadata = cardMeta.metadata.shareTokenMetadata as { name?: string; description?: string; image?: string } | undefined
		const cardOwnerStr = typeof cardOwner === 'string' ? cardOwner : String(cardOwner)
		for (let i = 0; i < nfts.length; i++) {
			const nft = nfts[i] as { tokenId: bigint | number; tierIndexOrMax?: bigint | number }
			const tokenId = Number(nft.tokenId)
			if (tokenId < NFT_START_ID || tokenId >= ISSUED_NFT_START_ID) continue
			const tierIndexRaw = nft.tierIndexOrMax != null ? Number(nft.tierIndexOrMax) : 0
			const isDefaultMax = !Number.isFinite(tierIndexRaw) || tierIndexRaw >= tiersRaw.length
			const tier = isDefaultMax ? tiersSorted[0] : tiersRaw[tierIndexRaw]
			const tierIndexForProps = isDefaultMax ? 0 : tierIndexRaw
			const name = tier?.name ?? shareTokenMetadata?.name ?? 'Beamio Member NFT'
			const description = tier?.description ?? shareTokenMetadata?.description ?? ''
			const image = tier?.image ?? shareTokenMetadata?.image
			const backgroundColor = tier?.backgroundColor != null && String(tier.backgroundColor).trim() !== '' ? String(tier.backgroundColor).trim() : undefined
			const bgFormatted = backgroundColor ? (backgroundColor.startsWith('#') ? backgroundColor : `#${backgroundColor.replace(/^#/, '')}`) : undefined
			await upsertNftTierMetadata({
				cardAddress,
				cardOwner: cardOwnerStr,
				tokenId,
				metadataJson: {
					name,
					description: description ?? '',
					...(image && { image }),
					...(bgFormatted != null && { background_color: bgFormatted }),
					properties: {
						tier_index: tierIndexForProps,
						...(tier?.minUsdc6 != null && { min_usdc6: tier.minUsdc6 }),
						...(tier?.name && { tier_name: tier.name }),
						...(tier?.description != null && { tier_description: tier.description }),
						...(bgFormatted != null && { background_color: bgFormatted }),
					},
				},
			})
		}
	} catch (e: any) {
		logger(Colors.yellow(`[syncNftTierMetadataForUser] card=${cardAddress} user=${userEOA} failed: ${e?.message ?? e}`))
	}
}

/**
 * cardRedeemProcess：用户输入 redeem 码，服务端调用 factory.redeemForUser，将点数 mint 到用户 AA。
 */
export const cardRedeemProcess = async () => {
	const obj = cardRedeemPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		cardRedeemPool.unshift(obj)
		return setTimeout(() => cardRedeemProcess(), 3000)
	}
	logger(Colors.cyan(`[cardRedeemProcess] processing card=${obj.cardAddress} toUserEOA=${obj.toUserEOA} codeLen=${obj.redeemCode?.length ?? 0}`))
	try {
		// 1. 确保 redeem 用户有 AA 账号（与 purchasingCardProcess 一致）
		const { accountAddress: addr } = await DeployingSmartAccount(obj.toUserEOA, SC.aaAccountFactoryPaymaster)
		if (!addr) {
			logger(Colors.red(`❌ cardRedeemProcess: ${obj.toUserEOA} DeployingSmartAccount failed (no AA account)`))
			if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: 'Account not found or failed to create. Please create/activate your Beamio account first.' }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => cardRedeemProcess(), 3000)
			return
		}

		const factory = SC.baseFactoryPaymaster
		let beforeNfts: unknown[] | undefined
		try {
			const cardRead = new ethers.Contract(obj.cardAddress, BeamioUserCardABI, SC.walletBase)
			const [, nfts] = await cardRead.getOwnership(addr) as [bigint, unknown[]]
			beforeNfts = Array.isArray(nfts) ? nfts : []
		} catch (_) {
			beforeNfts = []
		}
		let txHash: string | null = null
		let lastErr: any = null
		// 兑换前获取 creator（用于 syncTokenAction operator 统计）
		let creator: string | undefined
		try {
			const cardRead = new ethers.Contract(obj.cardAddress, ['function getRedeemCreator(string) view returns (address)'], SC.walletBase)
			creator = await cardRead.getRedeemCreator(obj.redeemCode) as string
			if (creator === ethers.ZeroAddress) creator = undefined
		} catch (_) { /* 旧卡无 getRedeemCreator 时忽略 */ }
		// 先尝试 one-time redeem；若 UC_InvalidProposal（code 可能为 pool 类型）则回退到 redeemPoolForUser
		try {
			const tx1 = await factory.redeemForUser(obj.cardAddress, obj.redeemCode, obj.toUserEOA)
			await tx1.wait()
			txHash = tx1.hash
		} catch (oneTimeErr: any) {
			lastErr = oneTimeErr
			const dataHex = typeof oneTimeErr?.data === 'string' ? oneTimeErr.data
				: (oneTimeErr?.data && typeof oneTimeErr.data === 'object' && typeof (oneTimeErr.data as any).data === 'string') ? (oneTimeErr.data as any).data
				: ''
			const msg = (() => {
				try {
					const m = oneTimeErr?.message ?? oneTimeErr?.shortMessage ?? ''
					return String(dataHex || m)
				} catch (_) {
					return String(dataHex || '')
				}
			})()
			if (/UC_InvalidProposal|UC_RedeemDelegateFailed|0xfb713d2b|dccff669|reverted/i.test(msg)) {
				try {
					const tx2 = await factory.redeemPoolForUser(obj.cardAddress, obj.redeemCode, obj.toUserEOA)
					await tx2.wait()
					txHash = tx2.hash
					lastErr = null
				} catch (poolErr: any) {
					lastErr = poolErr
				}
			}
			if (lastErr) throw lastErr
		}
		if (txHash) {
			logger(Colors.green(`✅ cardRedeemProcess card=${obj.cardAddress} to=${obj.toUserEOA} tx=${txHash}`))
			cardRedeemIndexerAccountingPool.push({
				cardAddress: obj.cardAddress,
				toUserEOA: obj.toUserEOA,
				aaAddress: addr,
				txHash,
				beforeNfts,
				creator: creator ? ethers.getAddress(creator) : undefined,
			})
			cardRedeemIndexerAccountingProcess().catch((err: any) => {
				logger(Colors.red('[cardRedeemIndexerAccountingProcess] unhandled:'), err?.message ?? err)
			})
			syncNftTierMetadataForUser(obj.cardAddress, obj.toUserEOA).catch(() => {})
			if (obj.res && !obj.res.headersSent) obj.res.status(200).json({ success: true, tx: txHash }).end()
		}
	} catch (e: any) {
		const errMsg = e?.reason ?? e?.message ?? e?.shortMessage ?? String(e)
		logger(Colors.red(`❌ cardRedeemProcess failed:`), errMsg)
		// 从多种位置提取 revert data（ethers v6 等结构可能不同）
		const dataHex = typeof e?.data === 'string' ? e.data
			: (e?.data && typeof e.data === 'object' && typeof (e.data as any).data === 'string') ? (e.data as any).data
			: e?.info?.error?.data ?? e?.error?.data ?? ''
		const dataStr = String(dataHex || errMsg)
		// UC_InvalidProposal (0xfb713d2b) / UC_RedeemDelegateFailed (0xdccff669)：code 不存在或已使用
		let clientError = errMsg
		if (/UC_InvalidProposal|UC_RedeemDelegateFailed|0xfb713d2b|dccff669|UC_PoolAlreadyClaimed|0x038039a7/.test(dataStr)) {
			if (/UC_PoolAlreadyClaimed|0x038039a7/.test(dataStr)) {
				clientError = 'This redeem code has already been used by this account.'
			} else if (/UC_InvalidTimeWindow|0xf88c1f68/.test(dataStr)) {
				clientError = 'Redeem code has expired. Check validAfter/validBefore.'
			} else {
				clientError = 'Code not found or already used. Please ensure you\'re redeeming against the correct card (the card where the code was created).'
			}
		}
		if (obj.res && !obj.res.headersSent) obj.res.status(400).json({ success: false, error: clientError }).end()
	} finally {
		Settle_ContractPool.unshift(SC)
		setTimeout(() => cardRedeemProcess(), 3000)
	}
}

/**
 * 查询 card 的 admin 列表，连同 metadata、adminParent、mintCounter 一起回送。
 * 使用 providerBaseBackup（card）和 providerConet（Indexer），不依赖 Settle_ContractPool。
 */
export const getCardAdminsWithMintCounter = async (cardAddress: string): Promise<{
	success: true
	admins: Array<{ address: string; metadata: string; parent: string; mintCounter: string }>
} | { success: false; error: string }> => {
	if (!cardAddress || !ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
	try {
		const card = new ethers.Contract(cardAddress, [
			'function getAdminList() view returns (address[])',
			'function adminParent(address) view returns (address)',
			'function getAdminMintCounter(address) view returns (uint256)',
		], providerBaseBackup)
		const adminList = await card.getAdminList() as string[]
		const admins: Array<{ address: string; metadata: string; parent: string; mintCounter: string }> = []
		for (const addr of adminList) {
			if (!addr || addr === ethers.ZeroAddress) continue
			const [parent, mintCounter] = await Promise.all([
				card.adminParent(addr) as Promise<string>,
				card.getAdminMintCounter(ethers.getAddress(addr)) as Promise<bigint>,
			])
			admins.push({
				address: ethers.getAddress(addr),
				metadata: '',
				parent: parent ? ethers.getAddress(parent) : ethers.ZeroAddress,
				mintCounter: String(mintCounter ?? 0n),
			})
		}
		return { success: true, admins }
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

/**
 * 校验 USDC Topup 的 recommender：若提供则必须为 card admin，否则返回错误。
 * 使用 providerBaseBackup，不依赖 Settle_ContractPool。
 */
export const validateRecommenderForTopup = async (
	cardAddress: string,
	recommender?: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
	if (!recommender || recommender === ethers.ZeroAddress) return { ok: true }
	if (!ethers.isAddress(recommender)) return { ok: false, error: 'Invalid recommender address' }
	if (!ethers.isAddress(cardAddress)) return { ok: false, error: 'Invalid cardAddress' }
	try {
		const card = new ethers.Contract(cardAddress, ['function isAdmin(address) view returns (bool)'], providerBaseBackup)
		const isAdmin = await card.isAdmin(ethers.getAddress(recommender)) as boolean
		if (!isAdmin) return { ok: false, error: 'Recommender must be card admin' }
		return { ok: true }
	} catch (e: any) {
		return { ok: false, error: e?.message ?? String(e) }
	}
}

/**
 * 集群侧数据预检：只读链上数据，不写。返回 preChecked 供转发给 master。
 * 不在集群检查 AA：AA 由 master 的 purchasingCardProcess 内用 DeployingSmartAccount 检查/创建。
 * 使用 Settle_ContractPool[0]（不 shift），仅 view 调用；用 getAddress(from,0) 仅作 getOwnership 入参取点数/会员数据，不向 master 返回 accountAddress。
 */
export const purchasingCardPreCheck = async (
	cardAddress: string,
	usdcAmount: string,
	from: string
): Promise<{ success: true; preChecked: PurchasingCardPreChecked } | { success: false; error: string }> => {
	const pool = Settle_ContractPool
	if (!pool?.length) return { success: false, error: 'Settle_ContractPool empty' }
	const SC = pool[0]
	const factory = SC.baseFactoryPaymaster
	const usdc6 = BigInt(usdcAmount)
	if (usdc6 <= 0n) return { success: false, error: 'usdcAmount must be > 0' }
	try {
		const getAddressFn = SC.aaAccountFactoryPaymaster.getFunction('getAddress(address,uint256)')
		const counterfactualAccount = await getAddressFn(from, 0n) as string
		const card = new ethers.Contract(cardAddress, BeamioUserCardABI, SC.walletBase)
		const [[pointsBalance, nfts], owner, _currency, currencyAmount] = await Promise.all([
			card.getOwnership(counterfactualAccount),
			card.owner(),
			card.currency(),
			quotePointsForUSDC_raw(cardAddress, usdc6, factory)
		])
		const isMember = (nfts?.length > 0) && (pointsBalance > 0n)
		const preChecked: PurchasingCardPreChecked = {
			owner: String(owner),
			_currency: Number(_currency),
			currencyAmount: {
				usdc6: String(currencyAmount.usdc6),
				points6: String(currencyAmount.points6),
				usdc: currencyAmount.usdc,
				points: currencyAmount.points,
				unitPriceUSDC6: String(currencyAmount.unitPriceUSDC6),
				unitPriceUSDC: currencyAmount.unitPriceUSDC
			},
			pointsBalance: String(pointsBalance),
			nfts: Array.isArray(nfts) ? nfts : [],
			isMember
		}
		return { success: true, preChecked }
	} catch (e: any) {
		const msg = e?.message ?? e?.shortMessage ?? String(e)
		logger(Colors.red(`[purchasingCardPreCheck] ${msg}`))
		return { success: false, error: msg }
	}
}

export type UsdcTopupIntent = 'auto' | 'first_purchase' | 'upgrade' | 'topup'

export type UsdcTopupRuleCheck = {
	intent: Exclude<UsdcTopupIntent, 'auto'>
	hasMembership: boolean
	currentPoints6: string
	currentTierIndex: number
	/** Backward-compatible field name; value is minimum tier threshold converted to required USDC6 */
	minTierUsdc6: string
	/** Backward-compatible field name; value is next tier threshold converted to required USDC6 */
	nextTierMinUsdc6?: string
	requiredMinUsdc6: string
}

export type UsdcTopupPreview = {
	intent: Exclude<UsdcTopupIntent, 'auto'>
	hasMembership: boolean
	currentPoints6: string
	currentTierIndex: number
	/** Backward-compatible field name; value is minimum tier threshold converted to required USDC6 */
	minTierUsdc6: string
	/** Backward-compatible field name; value is next tier threshold converted to required USDC6 */
	nextTierMinUsdc6?: string
	requiredMinUsdc6: string
	recommendedUsdc6: string
}

const resolveUsdcTopupRules = async (
	cardAddress: string,
	from: string,
	_intent: UsdcTopupIntent = 'auto'
): Promise<
	| { success: true; preview: UsdcTopupPreview }
	| { success: false; error: string }
> => {
	const CENT_USDC6 = 10_000n
	const ROUND_HALF_USDC6 = 5_000n // 0.005 USDC
	const roundUsdc6ToCents = (val: bigint) => ((val + ROUND_HALF_USDC6) / CENT_USDC6) * CENT_USDC6
	try {
		if (!ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
		if (!ethers.isAddress(from)) return { success: false, error: 'Invalid from address' }
		const pool = Settle_ContractPool
		if (!pool?.length) return { success: false, error: 'Settle_ContractPool empty' }
		const SC = pool[0]

		const card = new ethers.Contract(
			cardAddress,
			[
				'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
				'function tiers(uint256 idx) view returns (uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds, bool upgradeByBalance)',
			],
			SC.walletBase
		)

		const [[pt, nftsRaw], tiers] = await Promise.all([
			card.getOwnershipByEOA(from) as Promise<[bigint, Array<{ tokenId: bigint; tierIndexOrMax: bigint; isExpired: boolean }>]>,
			readCardTiers(card, cardAddress),
		])
		const tiersSorted = [...tiers].sort((a, b) => (a.minUsdc6 < b.minUsdc6 ? -1 : a.minUsdc6 > b.minUsdc6 ? 1 : 0))
		const minTierPoints6 = tiersSorted.length > 0 ? tiersSorted[0].minUsdc6 : 0n

		const nfts = Array.isArray(nftsRaw) ? nftsRaw : []
		const hasMembership = nfts.some((n) => !n?.isExpired && Number(n?.tokenId ?? 0n) >= 100 && Number(n?.tokenId ?? 0n) < 100_000_000_000)
		let currentTierIndex = -1
		for (const n of nfts) {
			if (n?.isExpired) continue
			const idx = n?.tierIndexOrMax
			if (idx == null || idx === ethers.MaxUint256) continue
			const num = Number(idx)
			if (Number.isFinite(num)) currentTierIndex = Math.max(currentTierIndex, num)
		}
		const nextTier = tiers.find((t) => t.index === currentTierIndex + 1)
		const nextTierPoints6 = nextTier?.minUsdc6
		const currentPoints6 = pt ?? 0n

		const unitPriceUSDC6 = await SC.baseFactoryPaymaster.quoteUnitPointInUSDC6(cardAddress) as bigint
		if (unitPriceUSDC6 <= 0n) {
			return { success: false, error: 'UC_PriceZero: quoteUnitPointInUSDC6(card)=0' }
		}
		const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
		// 与前端协议对齐：汇率到 USDC 后先加 0.005，再按 2 位小数四舍五入
		const points6ToRequiredUsdc6 = (points6: bigint) => {
			const raw = points6 <= 0n ? 1n : ceilDiv(points6 * unitPriceUSDC6, POINTS_ONE)
			return roundUsdc6ToCents(raw)
		}

		// Backend auto-judges the flow by current ownership:
		// - no membership NFT => first purchase (tier threshold applies only if tiers exist)
		// - has membership NFT => topup (upgrade handled by contract automatically)
		const resolvedIntent: Exclude<UsdcTopupIntent, 'auto'> = hasMembership ? 'topup' : 'first_purchase'
		const requiredMinUsdc6 = resolvedIntent === 'first_purchase'
			? points6ToRequiredUsdc6(minTierPoints6)
			: 1n
		const minTierRequiredUsdc6 = points6ToRequiredUsdc6(minTierPoints6)
		const nextTierRequiredUsdc6 = nextTierPoints6 != null ? points6ToRequiredUsdc6(nextTierPoints6) : undefined
		if (process.env.NODE_ENV !== 'production') {
			logger(
				Colors.gray(
					`[usdcTopupRules][debug] card=${cardAddress} from=${from} intent=${resolvedIntent} minTierPoints6=${minTierPoints6.toString()} unitPriceUSDC6=${unitPriceUSDC6.toString()} requiredMinUsdc6=${requiredMinUsdc6.toString()}`
				)
			)
		}

		return {
			success: true,
			preview: {
				intent: resolvedIntent,
				hasMembership,
				currentPoints6: currentPoints6.toString(),
				currentTierIndex,
				minTierUsdc6: minTierRequiredUsdc6.toString(),
				...(nextTierRequiredUsdc6 != null && { nextTierMinUsdc6: nextTierRequiredUsdc6.toString() }),
				requiredMinUsdc6: requiredMinUsdc6.toString(),
				recommendedUsdc6: requiredMinUsdc6.toString(),
			},
		}
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

/** USDC Topup 预览：签名前返回首购/升级最低要求和下一档信息（只读）。 */
export const usdcTopupPreview = async (
	cardAddress: string,
	from: string,
	_intent: UsdcTopupIntent = 'auto',
	usdcAmount?: string
): Promise<
	| { success: true; preview: UsdcTopupPreview; amountCheck?: { ok: boolean; requiredMinUsdc6: string; providedUsdc6: string } }
	| { success: false; error: string }
> => {
	const CENT_USDC6 = 10_000n
	const ROUND_HALF_USDC6 = 5_000n // 0.005 USDC
	const roundUsdc6ToCents = (val: bigint) => ((val + ROUND_HALF_USDC6) / CENT_USDC6) * CENT_USDC6
	const rules = await resolveUsdcTopupRules(cardAddress, from, 'auto')
	if (!rules.success) return rules
	const ret: { success: true; preview: UsdcTopupPreview; amountCheck?: { ok: boolean; requiredMinUsdc6: string; providedUsdc6: string } } = {
		success: true,
		preview: rules.preview,
	}
	if (typeof usdcAmount === 'string' && usdcAmount.trim() !== '') {
		try {
			const provided = roundUsdc6ToCents(BigInt(usdcAmount))
			const required = roundUsdc6ToCents(BigInt(rules.preview.requiredMinUsdc6))
			ret.amountCheck = {
				ok: provided >= required,
				requiredMinUsdc6: required.toString(),
				providedUsdc6: provided.toString(),
			}
		} catch {
			ret.amountCheck = {
				ok: false,
				requiredMinUsdc6: rules.preview.requiredMinUsdc6,
				providedUsdc6: '0',
			}
		}
	}
	return ret
}

/**
 * USDC Topup 预检（Cluster 用）：
 * - 后端自动判断是否首购：若用户没有该卡 membership NFT，则按首购规则校验
 * - 首购时：若有 tiers，必须达到最低 tier 门槛；若无 tiers，任意正数可过
 * - 已持卡时：仅要求 > 0；升级由合约逻辑自动处理
 */
export const usdcTopupPreCheck = async (
	cardAddress: string,
	usdcAmount: string,
	from: string,
	_intent: UsdcTopupIntent = 'auto'
): Promise<
	| { success: true; preChecked: PurchasingCardPreChecked; ruleCheck: UsdcTopupRuleCheck }
	| { success: false; error: string }
> => {
	const CENT_USDC6 = 10_000n
	const ROUND_HALF_USDC6 = 5_000n // 0.005 USDC
	const roundUsdc6ToCents = (val: bigint) => ((val + ROUND_HALF_USDC6) / CENT_USDC6) * CENT_USDC6
	try {
		if (!ethers.isAddress(cardAddress)) return { success: false, error: 'Invalid cardAddress' }
		if (!ethers.isAddress(from)) return { success: false, error: 'Invalid from address' }
		const usdc6 = roundUsdc6ToCents(BigInt(usdcAmount))
		if (usdc6 <= 0n) return { success: false, error: 'usdcAmount must be > 0' }
		const rules = await resolveUsdcTopupRules(cardAddress, from, 'auto')
		if (!rules.success) return rules
		const requiredMinUsdc6 = roundUsdc6ToCents(BigInt(rules.preview.requiredMinUsdc6))

		if (usdc6 < requiredMinUsdc6) {
			const need = ethers.formatUnits(requiredMinUsdc6, 6)
			return { success: false, error: `Amount too small for ${rules.preview.intent}. Minimum required is ${need} USDC.` }
		}

		const normalizedUsdcAmount = usdc6.toString()
		const preCheck = await purchasingCardPreCheck(cardAddress, normalizedUsdcAmount, from)
		if (!preCheck.success) return preCheck

		return {
			success: true,
			preChecked: preCheck.preChecked,
			ruleCheck: {
				intent: rules.preview.intent,
				hasMembership: rules.preview.hasMembership,
				currentPoints6: rules.preview.currentPoints6,
				currentTierIndex: rules.preview.currentTierIndex,
				minTierUsdc6: rules.preview.minTierUsdc6,
				...(rules.preview.nextTierMinUsdc6 != null && { nextTierMinUsdc6: rules.preview.nextTierMinUsdc6 }),
				requiredMinUsdc6: requiredMinUsdc6.toString(),
			},
		}
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) }
	}
}

export const quoteUSDCForPoints = async (
	cardAddress: string,
	pointsHuman: string   // ✅ 人类可读，例如 "10" / "1.5"
  ) => {
	const factory = Settle_ContractPool[0].baseFactoryPaymaster;
  
	if (!pointsHuman || Number(pointsHuman) <= 0) {
	  throw new Error("points must be > 0 (human readable)");
	}
  
	// 1️⃣ 人类可读 → 6 位 points（链上单位）
	let points6: bigint;
	try {
	  points6 = ethers.parseUnits(pointsHuman, 6);
	} catch {
	  throw new Error(`invalid points format: ${pointsHuman}`);
	}
  
	if (points6 <= 0n) {
	  throw new Error("points6 must be > 0");
	}
  
	// 2️⃣ 单价（1e6 points 对应 USDC6）；合约仅有 quoteUnitPointInUSDC6(card)，无 quotePointsInUSDC6
	const unitPriceUSDC6: bigint =
	  await factory.quoteUnitPointInUSDC6(cardAddress);
	if (unitPriceUSDC6 === 0n) {
	  throw new Error("quote=0 (oracle not configured or card invalid). Ensure BeamioOracle has CAD rate (e.g. updateRate(0, 1e18)) and card is from this factory.");
	}
	// 3️⃣ 总价 USDC6 = points6 * unitPriceUSDC6 / 1e6
	const usdc6: bigint = (points6 * unitPriceUSDC6) / POINTS_ONE;
  
	const ret = {
	  // 原始输入
	  points: pointsHuman,
  
	  // 链上单位
	  points6,                     // bigint (1e6)
  
	  // 总价
	  usdc6,                       // bigint (1e6)
	  usdc: ethers.formatUnits(usdc6, 6),
  
	  // 单价
	  unitPriceUSDC6,              // bigint
	  unitPriceUSDC: ethers.formatUnits(unitPriceUSDC6, 6),
	};
  
	logger(inspect(ret, false, 4, true));
	return ret;
}

export const quotePointsForUSDC = async (
	cardAddress: string,
	usdcHuman: string // 人类可读 USDC，例如 "10.5"
  ) => {
	const factory = Settle_ContractPool[0].baseFactoryPaymaster;
  
	// 1) USDC 人类可读 -> USDC6
	const usdc6 = ethers.parseUnits(usdcHuman, 6);
	if (usdc6 <= 0n) throw new Error("usdc must be > 0");
  
	// 2) unitPrice：买 1e6 points 需要多少 USDC6
	const unitPriceUSDC6: bigint = await factory.quoteUnitPointInUSDC6(cardAddress);
	if (unitPriceUSDC6 === 0n) throw new Error("unitPriceUSDC6=0 (oracle not configured?)");
  
	// 3) 反推 pointsOut6（向下取整，和合约一致）
	const points6 = (usdc6 * POINTS_ONE) / unitPriceUSDC6;
  
	const ret = {
	  usdc: usdcHuman,
	  usdc6,
	  unitPriceUSDC6,
	  unitPriceUSDC: ethers.formatUnits(unitPriceUSDC6, 6),
  
	  points6,
	  points: ethers.formatUnits(points6, 6), // points 人类可读（6位）
	};
  
	logger(inspect(ret, false, 4, true));
	return ret;
};

/** 与主 RPC 一致，unitPrice 主 RPC 返回 0 时重试用 */
const QUOTE_FALLBACK_RPC = BASE_RPC_URL

/**
 * 为何 quoteUnitPointInUSDC6(cardAddress) 可能返回 0？
 * 1) 合约逻辑：QuoteHelper.quoteUnitPointInUSDC6(currency, price) 仅在 price==0 时返回 0；否则会调 Oracle.getRate(currency)。
 *    Oracle 未配置该币种时 getRate 会 revert，不会返回 0。所以链上「正常」返回 0 的唯一情况是：卡合约的 pointsUnitPriceInCurrencyE6() == 0。
 * 2) 实际常见原因：部分 RPC 节点在 view 调用内部 revert 时（例如 Oracle 未配置 CAD），会把整次 eth_call 当作失败并返回 0 而不是抛出错误，
 *    导致 quoteUnitPointInUSDC6 在客户端看到 0。此时用与 UI 相同的 quoteCurrencyAmountInUSDC6(CAD, 1e6) 可绕过（CCSA 已做）。
 * 3) 若卡确为新部署且 constructor 已传 1e6，链上 pointsUnitPriceInCurrencyE6 不应为 0；若仍得 0，多为上述 RPC 对 revert 的处理差异。
 */
export const quotePointsForUSDC_raw = async (
		cardAddress: string,
		usdc6: bigint, // 已经是 raw USDC（6 decimals）
		factoryOverride?: ethers.Contract // 调用方传入时使用（如 purchasingCardProcess 中已 shift 的 SC.baseFactoryPaymaster），否则用 Settle_ContractPool[0]
	) => {
		const isCCSA = cardAddress?.toLowerCase() === BASE_CCSA_CARD_ADDRESS.toLowerCase()
		logger(Colors.cyan(`[quotePointsForUSDC_raw] cardAddress=${cardAddress} isCCSA=${isCCSA} usdc6=${usdc6}`))
		const factory = factoryOverride ?? Settle_ContractPool[0]?.baseFactoryPaymaster;
		if (!factory) throw new Error("quotePointsForUSDC_raw: no factory (pool empty or not inited)");
	
		if (usdc6 <= 0n) {
		throw new Error("usdc6 must be > 0");
	}

		// CCSA 卡：与 UI 完全一致，直接用 quoteCurrencyAmountInUSDC6(CAD, 1e6) 作为单价，不依赖 quoteUnitPointInUSDC6(cardAddress)
		const CAD_ENUM = 0
		const POINTS_ONE_E6 = 1_000_000n
		let unitPriceUSDC6: bigint = 0n
		if (isCCSA) {
			try {
				unitPriceUSDC6 = await factory.quoteCurrencyAmountInUSDC6(CAD_ENUM, POINTS_ONE_E6)
				if (unitPriceUSDC6 !== 0n) logger(Colors.green(`[quotePointsForUSDC_raw] CCSA: used quoteCurrencyAmountInUSDC6(CAD, 1e6) => ${unitPriceUSDC6} (same as UI)`))
			} catch (e) {
				logger(Colors.yellow(`[quotePointsForUSDC_raw] CCSA quoteCurrencyAmountInUSDC6 failed: ${(e as Error)?.message}`))
			}
		}

		if (unitPriceUSDC6 === 0n) {
		// 非 CCSA 或 CCSA 路径失败：走 quoteUnitPointInUSDC6(cardAddress)
		unitPriceUSDC6 = await factory.quoteUnitPointInUSDC6(cardAddress);
		}
	
		if (unitPriceUSDC6 === 0n) {
		// 同 RPC 重试一次
		try {
			const fallbackProvider = new ethers.JsonRpcProvider(QUOTE_FALLBACK_RPC);
			const readOnlyFactory = new ethers.Contract(BeamioUserCardFactoryPaymasterV2, BeamioFactoryPaymasterABI as ethers.InterfaceAbi, fallbackProvider);
			const fallbackPrice = await readOnlyFactory.quoteUnitPointInUSDC6(cardAddress);
			if (fallbackPrice !== 0n) {
				unitPriceUSDC6 = fallbackPrice;
				logger(Colors.yellow(`[quotePointsForUSDC_raw] unitPrice was 0, used fallback RPC => ${fallbackPrice}`));
			}
		} catch (_) { /* ignore */ }
	}

		if (unitPriceUSDC6 === 0n && !isCCSA) {
		// 用与 UI 相同的报价路径：quoteCurrencyAmountInUSDC6(currency, priceE6)
		const provider = (factory as any).runner?.provider ?? (factory as any).provider;
		if (provider) {
			try {
				const card = new ethers.Contract(cardAddress, BeamioUserCardABI, provider);
				const [currency, priceE6] = await Promise.all([card.currency(), card.pointsUnitPriceInCurrencyE6()]);
				if (priceE6 > 0n) {
					const unitFromCurrencyQuote = await factory.quoteCurrencyAmountInUSDC6(Number(currency), priceE6);
					if (unitFromCurrencyQuote !== 0n) {
						unitPriceUSDC6 = unitFromCurrencyQuote;
						logger(Colors.yellow(`[quotePointsForUSDC_raw] used quoteCurrencyAmountInUSDC6(currency=${currency}, priceE6=${priceE6}) => ${unitFromCurrencyQuote}`));
					}
				}
			} catch (_) { /* keep unitPriceUSDC6 0 */ }
		}
	}

		if (unitPriceUSDC6 === 0n) {
		const provider = (factory as any).runner?.provider ?? (factory as any).provider;
		let hint = "unitPriceUSDC6=0 (oracle not configured?)";
		if (provider) {
			try {
				const card = new ethers.Contract(cardAddress, BeamioUserCardABI, provider);
				const [currency, priceE6] = await Promise.all([card.currency(), card.pointsUnitPriceInCurrencyE6()]);
				if (priceE6 === 0n) hint = "unitPriceUSDC6=0: card has pointsUnitPriceInCurrencyE6=0 (card not configured?)";
				else if (Number(currency) === 0) hint = "unitPriceUSDC6=0. For CAD cards ensure Oracle has CAD rate: npm run set:oracle-cad:base. Card currency id=0, priceE6=" + String(priceE6);
				else hint = "unitPriceUSDC6=0. Card currency id=" + String(currency) + ", priceE6=" + String(priceE6) + ". Ensure Oracle has rate for this currency.";
			} catch (_) { /* keep default hint */ }
		}
		throw new Error(hint);
	}
	
		// 2️⃣ 完全对齐合约里的计算公式
		// pointsOut6 = usdcAmount6 * 1e6 / unitPriceUSDC6
		const points6 = (usdc6 * POINTS_ONE) / unitPriceUSDC6;
	
		const ret = {
		usdc6,
		unitPriceUSDC6,
	
		points6,
	
		// 👇 仅用于 debug / 前端展示（可删）
		usdc: ethers.formatUnits(usdc6, 6),
		unitPriceUSDC: ethers.formatUnits(unitPriceUSDC6, 6),
		points: ethers.formatUnits(points6, 6),
		};
	
		return ret;
};

const BASE_CHAIN_ID = 8453
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** NFC 卡 Smart Routing 聚合扣款：CCSA 点数 + USDC，使用 Container relay（绑定 to，与 AAaccount signAAtoEOA_USDC_with_BeamioContainerMainRelayed 一致）。失败返回 { pushed: false, error }，成功返回 { pushed: true } */
export const payByNfcUidOpenContainer = async (params: {
	uid: string
	amountUsdc6: string
	payee: string
	res: Response
}): Promise<{ pushed: boolean; error?: string }> => {
	const { uid, amountUsdc6, payee, res } = params
	const amountBig = BigInt(amountUsdc6)
	if (amountBig <= 0n) return { pushed: false, error: 'Invalid amountUsdc6' }
	const privateKey = await getNfcCardPrivateKeyByUid(uid.trim())
	if (!privateKey) {
		logger(Colors.red(`[payByNfcUidOpenContainer] failed: getNfcCardPrivateKeyByUid returned null for uid=${uid.slice(0, 16)}...`))
		return { pushed: false, error: '不存在该卡' }
	}
	if (Settle_ContractPool.length === 0) return { pushed: false, error: 'Settle_ContractPool empty' }
	const SC = Settle_ContractPool[0]
	try {
		const wallet = new ethers.Wallet(privateKey)
		const eoa = await wallet.getAddress()
		const aa = await SC.aaAccountFactoryPaymaster.primaryAccountOf(eoa)
		if (!aa || aa === ethers.ZeroAddress) {
			logger(Colors.yellow(`[payByNfcUidOpenContainer] EOA ${eoa} has no AA, fallback to simple USDC`))
			return { pushed: false, error: 'NO_AA' }
		}
		const aaCode = await SC.walletBase.provider!.getCode(aa)
		if (!aaCode || aaCode === '0x') return { pushed: false, error: 'NO_AA' }
		const cardAbi = ['function getOwnership(address) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[])', 'function currency() view returns (uint8)']
		const usdcAbi = ['function balanceOf(address) view returns (uint256)']
		const card = new ethers.Contract(BASE_CCSA_CARD_ADDRESS, cardAbi, SC.walletBase.provider!)
		const usdc = new ethers.Contract(USDC_BASE, usdcAbi, SC.walletBase.provider!)
		// Container 从 AA 转出，需用 AA 的余额（非 EOA）
		const [[points6], usdcBalance6] = await Promise.all([
			card.getOwnership(aa).then((r: [bigint, unknown[]]) => [r[0]]),
			usdc.balanceOf(aa),
		])
		let unitPriceUSDC6 = 0n
		try {
			const { unitPriceUSDC6: up } = await quotePointsForUSDC_raw(BASE_CCSA_CARD_ADDRESS, 1_000_000n, SC.baseFactoryPaymaster)
			unitPriceUSDC6 = up
		} catch (e) {
			logger(Colors.yellow(`[payByNfcUidOpenContainer] quote failed: ${(e as Error)?.message}`))
			return { pushed: false, error: 'Quote failed' }
		}
		if (unitPriceUSDC6 === 0n) return { pushed: false, error: 'Unit price 0' }
		const ccsaValueUsdc6 = (points6 * unitPriceUSDC6) / 1_000_000n
		const totalBalance6 = ccsaValueUsdc6 + usdcBalance6
		if (totalBalance6 < amountBig) {
			return { pushed: false, error: `余额不足（需 ${amountUsdc6} USDC6）` }
		}
		let ccsaPointsWei = 0n
		let usdcWei = amountBig
		if (points6 > 0n && unitPriceUSDC6 > 0n) {
			const maxPointsFromAmount = (amountBig * 1_000_000n) / unitPriceUSDC6
			ccsaPointsWei = maxPointsFromAmount > points6 ? points6 : maxPointsFromAmount
			const ccsaValue = (ccsaPointsWei * unitPriceUSDC6) / 1_000_000n
			usdcWei = amountBig - ccsaValue
			// AA 无 USDC 时，必须仅用 CCSA；用 ceil 覆盖 rounding 避免 usdcWei=1 导致链上 revert
			if (usdcBalance6 === 0n && usdcWei > 0n) {
				const ccsaPointsCeil = (amountBig * 1_000_000n + unitPriceUSDC6 - 1n) / unitPriceUSDC6
				if (ccsaPointsCeil <= points6) {
					ccsaPointsWei = ccsaPointsCeil
					usdcWei = 0n
				}
			}
		}
		const items: { kind: number; asset: string; amount: string; tokenId: string; data: string }[] = []
		if (ccsaPointsWei > 0n) {
			items.push({ kind: 1, asset: BASE_CCSA_CARD_ADDRESS, amount: ccsaPointsWei.toString(), tokenId: '0', data: '0x' })
		}
		if (usdcWei > 0n) {
			items.push({ kind: 0, asset: USDC_BASE, amount: usdcWei.toString(), tokenId: '0', data: '0x' })
		}
		if (items.length === 0) {
			items.push({ kind: 0, asset: USDC_BASE, amount: amountUsdc6, tokenId: '0', data: '0x' })
		}
		let toResolved = ethers.getAddress(payee)
		// 若含 CCSA，收款方必须为 AA；EOA 无 AA 时为其创建 AA 后继续
		if (ccsaPointsWei > 0n) {
			const payeeCode = await SC.walletBase.provider!.getCode(toResolved)
			const isPayeeEOA = !payeeCode || payeeCode === '0x'
			if (isPayeeEOA) {
				let payeeAA = await SC.aaAccountFactoryPaymaster.primaryAccountOf(toResolved)
				if (!payeeAA || payeeAA === ethers.ZeroAddress) {
					logger(Colors.cyan(`[payByNfcUidOpenContainer] payee ${toResolved} is EOA with no AA, creating AA for them...`))
					try {
						const { accountAddress } = await DeployingSmartAccount(toResolved, SC.aaAccountFactoryPaymaster)
						if (!accountAddress) {
							logger(Colors.red(`[payByNfcUidOpenContainer] DeployingSmartAccount failed for payee=${toResolved}`))
							return { pushed: false, error: '无法为收款方创建 Beamio AA 账户，请稍后重试。' }
						}
						payeeAA = accountAddress
						logger(Colors.green(`[payByNfcUidOpenContainer] created AA ${payeeAA} for payee EOA ${toResolved}`))
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e)
						logger(Colors.red(`[payByNfcUidOpenContainer] DeployingSmartAccount error: ${msg}`))
						return { pushed: false, error: `无法为收款方创建 AA：${msg}` }
					}
				}
				toResolved = payeeAA
			}
		}
		const nonce = await readContainerNonceFromAAStorage(SC.walletBase.provider!, aa, 'relayed')
		const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
		const itemsHash = hashContainerItems(items)
		const domain = {
			name: 'BeamioAccount',
			version: '1',
			chainId: BASE_CHAIN_ID,
			verifyingContract: aa as `0x${string}`,
		}
		const types = {
			ContainerMain: [
				{ name: 'account', type: 'address' },
				{ name: 'to', type: 'address' },
				{ name: 'itemsHash', type: 'bytes32' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		}
		const message = {
			account: aa,
			to: toResolved,
			itemsHash,
			nonce,
			deadline,
		}
		const sig = await wallet.signTypedData(domain, types, message)
		const containerPayload: ContainerRelayPayload = {
			account: aa,
			to: toResolved,
			items: items.map((it) => ({
				kind: it.kind,
				asset: it.asset,
				amount: it.amount,
				tokenId: it.tokenId,
				data: it.data,
			})),
			nonce: nonce.toString(),
			deadline: deadline.toString(),
			signature: sig,
		}
		const preCheck = ContainerRelayPreCheck(containerPayload)
		if (!preCheck.success) {
			return { pushed: false, error: preCheck.error }
		}
		ContainerRelayPool.push({
			containerPayload,
			currency: 'CAD',
			currencyAmount: ethers.formatUnits(amountBig, 6),
			forText: `NFC pay uid=${uid.slice(0, 12)}...`,
			amountUSDC6: amountUsdc6,
			res,
		})
		logger(Colors.green(`[payByNfcUidContainer] pushed to pool uid=${uid.slice(0, 12)}... ccsa=${ccsaPointsWei} usdc=${usdcWei}`))
		ContainerRelayProcess().catch((err: any) => logger(Colors.red('[ContainerRelayProcess] unhandled:'), err?.message ?? err))
		return { pushed: true }
	} catch (e: any) {
		logger(Colors.red(`[payByNfcUidContainer] failed: ${e?.message ?? e}`))
		return { pushed: false, error: e?.shortMessage ?? e?.message ?? 'Container relay failed' }
	}
}

/** QR 支付（OpenContainer）：根据 account(AA) 和 payee 返回 payeeAA、unitPriceUSDC6，供 Android 与 SilentPassUI 一致地 Smart Routing 组装 items */
export const payByAccountPrepare = async (params: {
	account: string
	payee: string
}): Promise<{
	ok: boolean
	payeeAA?: string
	unitPriceUSDC6?: string
	error?: string
}> => {
	const { account, payee } = params
	if (!account || !ethers.isAddress(account) || !payee || !ethers.isAddress(payee)) {
		return { ok: false, error: 'Invalid account or payee' }
	}
	if (Settle_ContractPool.length === 0) return { ok: false, error: 'Settle_ContractPool empty' }
	const SC = Settle_ContractPool[0]
	try {
		let toResolved = ethers.getAddress(payee)
		const payeeCode = await SC.walletBase.provider!.getCode(toResolved)
		const isPayeeEOA = !payeeCode || payeeCode === '0x'
		if (isPayeeEOA) {
			let payeeAA = await SC.aaAccountFactoryPaymaster.primaryAccountOf(toResolved)
			if (!payeeAA || payeeAA === ethers.ZeroAddress) {
				try {
					const { accountAddress } = await DeployingSmartAccount(toResolved, SC.aaAccountFactoryPaymaster)
					if (accountAddress) payeeAA = accountAddress
				} catch (_) { /* ignore */ }
			}
			if (payeeAA && payeeAA !== ethers.ZeroAddress) toResolved = payeeAA
		}
		let unitPriceUSDC6 = 0n
		try {
			const { unitPriceUSDC6: up } = await quotePointsForUSDC_raw(BASE_CCSA_CARD_ADDRESS, 1_000_000n, SC.baseFactoryPaymaster)
			unitPriceUSDC6 = up
		} catch (e) {
			logger(Colors.yellow(`[payByAccountPrepare] quote failed: ${(e as Error)?.message}`))
			return { ok: false, error: 'Quote failed' }
		}
		return {
			ok: true,
			payeeAA: toResolved,
			unitPriceUSDC6: unitPriceUSDC6.toString(),
		}
	} catch (e: any) {
		logger(Colors.red(`[payByAccountPrepare] failed: ${e?.message ?? e}`))
		return { ok: false, error: e?.shortMessage ?? e?.message ?? 'Prepare failed' }
	}
}

/** Android 构建 container 前的准备：返回 account、nonce、deadline、payeeAA、unitPriceUSDC6，供客户端 Smart Routing 后组装 items 并调用 payByNfcUidSignContainer。NFC 格式（14 位 hex uid）时：必须提供 e/c/m，SUN 校验通过后以 tagIdHex 查卡，无法推导 tagID 的不予受理。 */
export const payByNfcUidPrepare = async (params: {
	uid: string
	payee: string
	amountUsdc6: string
	e?: string
	c?: string
	m?: string
}): Promise<{
	ok: boolean
	account?: string
	nonce?: string
	deadline?: string
	payeeAA?: string
	unitPriceUSDC6?: string
	error?: string
}> => {
	const { uid, payee, amountUsdc6, e, c, m } = params
	const amountBig = BigInt(amountUsdc6)
	if (amountBig <= 0n) return { ok: false, error: 'Invalid amountUsdc6' }
	const uidTrim = uid.trim()
	const isNfcUid = /^[0-9A-Fa-f]{14}$/.test(uidTrim)
	let privateKey: string | null
	if (isNfcUid) {
		const eTrim = typeof e === 'string' ? e.trim() : ''
		const cTrim = typeof c === 'string' ? c.trim() : ''
		const mTrim = typeof m === 'string' ? m.trim() : ''
		if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
			logger(Colors.yellow(`[payByNfcUidPrepare] NFC uid requires SUN params (e,c,m) 64/6/16 hex`))
			return { ok: false, error: 'NFC UID requires SUN params (e, c, m) for verification. e=64 hex, c=6 hex, m=16 hex.' }
		}
		try {
			const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
			const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
			if (!sunResult.valid) {
				logger(Colors.yellow(`[payByNfcUidPrepare] SUN verification failed uid=${uidTrim.slice(0, 12)}... tagId=${sunResult.tagIdHex}`))
				return { ok: false, error: 'SUN verification failed. Cannot derive valid tagID.' }
			}
			privateKey = await getNfcCardPrivateKeyByTagId(sunResult.tagIdHex)
			logger(Colors.gray(`[payByNfcUidPrepare] SUN OK uid=${uidTrim.slice(0, 12)}... tagId=${sunResult.tagIdHex.slice(0, 8)}...`))
		} catch (sunErr: any) {
			const msg = sunErr?.message ?? String(sunErr)
			logger(Colors.yellow(`[payByNfcUidPrepare] SUN error uid=${uidTrim.slice(0, 12)}... ${msg}`))
			return { ok: false, error: `SUN verification error: ${msg}` }
		}
	} else {
		privateKey = await getNfcCardPrivateKeyByUid(uidTrim)
	}
	if (!privateKey) {
		logger(Colors.red(`[payByNfcUidPrepare] getNfcCardPrivateKey null uid=${uidTrim.slice(0, 16)}...`))
		return { ok: false, error: '不存在该卡' }
	}
	if (Settle_ContractPool.length === 0) return { ok: false, error: 'Settle_ContractPool empty' }
	const SC = Settle_ContractPool[0]
	try {
		const wallet = new ethers.Wallet(privateKey)
		const eoa = await wallet.getAddress()
		const aa = await SC.aaAccountFactoryPaymaster.primaryAccountOf(eoa)
		if (!aa || aa === ethers.ZeroAddress) {
			return { ok: false, error: 'NO_AA' }
		}
		const aaCode = await SC.walletBase.provider!.getCode(aa)
		if (!aaCode || aaCode === '0x') return { ok: false, error: 'NO_AA' }
		let toResolved = ethers.getAddress(payee)
		const payeeCode = await SC.walletBase.provider!.getCode(toResolved)
		const isPayeeEOA = !payeeCode || payeeCode === '0x'
		if (isPayeeEOA) {
			let payeeAA = await SC.aaAccountFactoryPaymaster.primaryAccountOf(toResolved)
			if (!payeeAA || payeeAA === ethers.ZeroAddress) {
				try {
					const { accountAddress } = await DeployingSmartAccount(toResolved, SC.aaAccountFactoryPaymaster)
					if (accountAddress) payeeAA = accountAddress
				} catch (_) { /* ignore */ }
			}
			if (payeeAA && payeeAA !== ethers.ZeroAddress) toResolved = payeeAA
		}
		const nonce = await readContainerNonceFromAAStorage(SC.walletBase.provider!, aa, 'relayed')
		const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
		let unitPriceUSDC6 = 0n
		try {
			const { unitPriceUSDC6: up } = await quotePointsForUSDC_raw(BASE_CCSA_CARD_ADDRESS, 1_000_000n, SC.baseFactoryPaymaster)
			unitPriceUSDC6 = up
		} catch (e) {
			logger(Colors.yellow(`[payByNfcUidPrepare] quote failed: ${(e as Error)?.message}`))
			return { ok: false, error: 'Quote failed' }
		}
		return {
			ok: true,
			account: aa,
			nonce: nonce.toString(),
			deadline: deadline.toString(),
			payeeAA: toResolved,
			unitPriceUSDC6: unitPriceUSDC6.toString(),
		}
	} catch (e: any) {
		logger(Colors.red(`[payByNfcUidPrepare] failed: ${e?.message ?? e}`))
		return { ok: false, error: e?.shortMessage ?? e?.message ?? 'Prepare failed' }
	}
}

/** 服务端用 UID 私钥对 Android 提交的未签名 container 签名并 relay。NFC 格式（14 位 hex uid）时：必须提供 e/c/m，SUN 校验通过后以 tagIdHex 查卡，无法推导 tagID 的不予受理。 */
export const payByNfcUidSignContainer = async (params: {
	uid: string
	containerPayload: ContainerRelayPayloadUnsigned
	amountUsdc6: string
	res: Response
	e?: string
	c?: string
	m?: string
}): Promise<{ pushed: boolean; error?: string }> => {
	const { uid, containerPayload, amountUsdc6, res, e, c, m } = params
	const uidTrim = uid.trim()
	const isNfcUid = /^[0-9A-Fa-f]{14}$/.test(uidTrim)
	let privateKey: string | null
	if (isNfcUid) {
		const eTrim = typeof e === 'string' ? e.trim() : ''
		const cTrim = typeof c === 'string' ? c.trim() : ''
		const mTrim = typeof m === 'string' ? m.trim() : ''
		if (!eTrim || !cTrim || !mTrim || eTrim.length !== 64 || cTrim.length !== 6 || mTrim.length !== 16) {
			logger(Colors.yellow(`[payByNfcUidSignContainer] NFC uid requires SUN params (e,c,m) 64/6/16 hex`))
			return { pushed: false, error: 'NFC UID requires SUN params (e, c, m) for verification. e=64 hex, c=6 hex, m=16 hex.' }
		}
		try {
			const sunUrl = `https://beamio.app/api/sun?uid=${uidTrim}&c=${cTrim}&e=${eTrim}&m=${mTrim}`
			const sunResult = await verifyAndPersistBeamioSunUrl(sunUrl)
			if (!sunResult.valid) {
				logger(Colors.yellow(`[payByNfcUidSignContainer] SUN verification failed uid=${uidTrim.slice(0, 12)}... tagId=${sunResult.tagIdHex}`))
				return { pushed: false, error: 'SUN verification failed' }
			}
			privateKey = await getNfcCardPrivateKeyByTagId(sunResult.tagIdHex)
			logger(Colors.gray(`[payByNfcUidSignContainer] SUN OK uid=${uidTrim.slice(0, 12)}... tagId=${sunResult.tagIdHex.slice(0, 8)}...`))
		} catch (sunErr: any) {
			const msg = sunErr?.message ?? String(sunErr)
			logger(Colors.yellow(`[payByNfcUidSignContainer] SUN error uid=${uidTrim.slice(0, 12)}... ${msg}`))
			return { pushed: false, error: `SUN verification error: ${msg}` }
		}
	} else {
		privateKey = await getNfcCardPrivateKeyByUid(uidTrim)
	}
	if (!privateKey) {
		logger(Colors.red(`[payByNfcUidSignContainer] getNfcCardPrivateKey null uid=${uidTrim.slice(0, 16)}...`))
		return { pushed: false, error: '不存在该卡' }
	}
	if (Settle_ContractPool.length === 0) return { pushed: false, error: 'Settle_ContractPool empty' }
	const wallet = new ethers.Wallet(privateKey)
	const eoa = await wallet.getAddress()
	const aa = (await Settle_ContractPool[0].aaAccountFactoryPaymaster.primaryAccountOf(eoa)) ?? ethers.ZeroAddress
	if (aa === ethers.ZeroAddress || ethers.getAddress(containerPayload.account) !== aa) {
		return { pushed: false, error: 'account 与 UID 对应的 AA 不一致' }
	}
	try {
		const itemsHash = hashContainerItems(containerPayload.items)
		const domain = {
			name: 'BeamioAccount',
			version: '1',
			chainId: BASE_CHAIN_ID,
			verifyingContract: containerPayload.account as `0x${string}`,
		}
		const types = {
			ContainerMain: [
				{ name: 'account', type: 'address' },
				{ name: 'to', type: 'address' },
				{ name: 'itemsHash', type: 'bytes32' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		}
		const message = {
			account: containerPayload.account,
			to: containerPayload.to,
			itemsHash,
			nonce: BigInt(containerPayload.nonce),
			deadline: BigInt(containerPayload.deadline),
		}
		const sig = await wallet.signTypedData(domain, types, message)
		const signed: ContainerRelayPayload = {
			...containerPayload,
			signature: sig,
		}
		const preCheck = ContainerRelayPreCheck(signed)
		if (!preCheck.success) return { pushed: false, error: preCheck.error }
		ContainerRelayPool.push({
			containerPayload: signed,
			currency: 'CAD',
			currencyAmount: ethers.formatUnits(BigInt(amountUsdc6), 6),
			forText: `NFC pay uid=${uid.slice(0, 12)}...`,
			amountUSDC6: amountUsdc6,
			res,
		})
		logger(Colors.green(`[payByNfcUidSignContainer] pushed uid=${uid.slice(0, 12)}... items=${containerPayload.items.length}`))
		ContainerRelayProcess().catch((err: any) => logger(Colors.red('[ContainerRelayProcess] unhandled:'), err?.message ?? err))
		return { pushed: true }
	} catch (e: any) {
		logger(Colors.red(`[payByNfcUidSignContainer] failed: ${e?.message ?? e}`))
		return { pushed: false, error: e?.shortMessage ?? e?.message ?? 'Sign failed' }
	}
}

export const getLatest20Actions = async (

) => {
	const facet = Settle_ContractPool[0].BeamioTaskDiamondAction

	// 1️⃣ 总 action 数
	const total: bigint = await facet.getActionCount();
	logger(`[getLatest20Actions] total = ${total}`);
	if (total === 0n) return [];

	const limit = 20n;
	const start =
		total > limit
		? total - limit   // 从尾部往前
		: 0n;

	// 2️⃣ 并发读取 action + meta
	const actions = await Promise.all(
		Array.from(
		{ length: Number(total - start) },
		(_, i) => start + BigInt(i)
		).map(async (actionId) => {
		const [action, meta] = await facet.getActionWithMeta(actionId);
		return {
			actionId: Number(actionId),
			...action,
			...meta,
		};
		})
	);

	// 3️⃣ UI 通常要最新在前

	const ret = actions.reverse();
	logger(inspect(ret, false, 4, true))
	return ret;
};



type forward1155ERC3009SignatureDataParams = {
	fromEOA: string,
	id: string,
	to: string,
	amount: string,
	maxAmount: string,
	validAfter: string,
	validBefore: string,
	nonce: string,
	signature: string,
	digest: string,
	cardAddress: string,
	res: Response,
}

export const forward1155ERC3009SignatureDataPool: forward1155ERC3009SignatureDataParams[] = [];



const makePayMeForForward1155ERC3009SignatureData = async (obj: forward1155ERC3009SignatureDataParams) => {
	const payMe = {
		title: "Forward 1155 ERC3009 Signature Data",
	}
	return payMe;
}
// export const forward1155ERC3009SignatureDataProcess = async () => {
// 	const obj = forward1155ERC3009SignatureDataPool.shift();
// 	if (!obj) {
// 		return;
// 	}
// 	try {
// 		const result = await forward1155ERC3009SignatureData(obj);
// 		logger(Colors.green(`✅ forward1155ERC3009SignatureDataProcess success! result: ${inspect(result, false, 3, true)}`));
// 		obj.res.status(200).json({success: true, txHash: result.txHash}).end()
// 		const input = {
// 			actionType: ,
// 			card: cardAddress,
// 			from: ethers.ZeroAddress,
// 			to: from, // ✅ points 归属 from
// 			amount: currencyAmount.points6,
// 			ts: 0n,

// 			title: `${payMe.title}`,
// 			note: JSON.stringify(payMe),
// 			tax: 0n,
// 			tip: 0n,
// 			beamioFee1: 0n,
// 			beamioFee2: 0n,
// 			cardServiceFee: 0n,
	
// 			afterTatchNoteByFrom: "",
// 			afterTatchNoteByTo: "",
// 			afterTatchNoteByCardOwner: "",
// 		};



// 	} catch (error: any) {
// 		logger(Colors.red(`❌ forward1155ERC3009SignatureDataProcess failed:`), error.message);
// 		obj.res.status(400).json({success: false, error: error.message}).end()
// 	}
// 	forward1155ERC3009SignatureDataPool.unshift(obj)
// 	return setTimeout(() => forward1155ERC3009SignatureDataProcess(), 3000)
// }



/**
 * 
 * @param fromEOA 
 * @param id 
 * @param to 
 * @param amount 
 * @param maxAmount 
 * @param validAfter 
 * @param validBefore 
 * 
 * */

const forward1155ERC3009SignatureData = async (
	params: forward1155ERC3009SignatureDataParams
):Promise<{ txHash: string }> => {
	const sign = {
		...params,
	  };
	
	  const env = Settle_ContractPool[0];
	  const factory = env.baseFactoryPaymaster; // BeamioUserCardFactoryPaymasterV07 contract instance (connected signer)
	  const provider = factory.runner!.provider! as ethers.Provider;
	  const signer = factory.runner! as ethers.Signer;
	
	  const caller = await signer.getAddress();
	  const net = await provider.getNetwork();
	  const blk = await provider.getBlock("latest");
	  console.log("chainId:", net.chainId.toString());
	  console.log("block.timestamp:", blk!.timestamp);
	  console.log("caller:", caller);
	  console.log("factory.owner:", await factory.owner());
	  console.log("factory.isPaymaster(caller):", await factory.isPaymaster(caller));


	  const factoryAddr = await factory.getAddress()
const chainId = (await provider.getNetwork()).chainId

const abi = ethers.AbiCoder.defaultAbiCoder()
const encoded = abi.encode(
  ["string","address","address","uint256","address","uint256","uint256","uint256","uint256","bytes32"],
  [
    "OpenTransfer",
    factoryAddr,                 // factoryGateway()
    sign.cardAddress,            // address(this) = card
    chainId,                     // block.chainid
    sign.fromEOA,                // fromEOA
    BigInt(sign.id),             // id
    BigInt(sign.maxAmount),      // maxAmount
    BigInt(sign.validAfter),
    BigInt(sign.validBefore),
    sign.nonce
  ]
)

const hash = ethers.keccak256(encoded)

// 合约用 toEthSignedMessageHash + ECDSA.recover
const recovered = ethers.verifyMessage(ethers.getBytes(hash), sign.signature)

console.log("local.hash:", hash)
console.log("local.recovered:", recovered)
console.log("expect fromEOA:", sign.fromEOA)


const card = new ethers.Contract(sign.cardAddress, [
	"function accountOf(address) view returns (address)",
	"function accounts(address) view returns (address)",
	"function resolveAccount(address) view returns (address)",
	"function balanceOf(address,uint256) view returns (uint256)",
	"function isTransferWhitelisted(address) view returns (bool)",
	"function transferWhitelist(address) view returns (bool)",
	"function POINTS_ID() view returns (uint256)",
  ], provider)
  
  async function tryCall(label: string, fn: () => Promise<any>) {
	try {
	  const v = await fn()
	  console.log(label, v)
	  return v
	} catch {}
  }
  
  const fromAccount =
	(await tryCall("accountOf", () => card.accountOf(sign.fromEOA))) ??
	(await tryCall("accounts", () => card.accounts(sign.fromEOA))) ??
	(await tryCall("resolveAccount", () => card.resolveAccount(sign.fromEOA))) ??
	sign.fromEOA
  
  const toAccount =
	(await tryCall("accountOf(to)", () => card.accountOf(sign.to))) ??
	(await tryCall("accounts(to)", () => card.accounts(sign.to))) ??
	(await tryCall("resolveAccount(to)", () => card.resolveAccount(sign.to))) ??
	sign.to
  
  console.log("fromAccount", fromAccount)
  console.log("toAccount", toAccount)
  
  await tryCall("wl(from)", () => card.isTransferWhitelisted(fromAccount))
  await tryCall("wl(from) alt", () => card.transferWhitelist(fromAccount))
  await tryCall("wl(to)", () => card.isTransferWhitelisted(toAccount))
  await tryCall("wl(to) alt", () => card.transferWhitelist(toAccount))
  
  console.log("bal(from,id)", (await card.balanceOf(fromAccount, 0)).toString())



  const aaF: string = (await DeployingSmartAccount(sign.fromEOA, env.aaAccountFactoryPaymaster))?.accountAddress
  const aaT: string = (await DeployingSmartAccount(sign.to,  env.aaAccountFactoryPaymaster))?.accountAddress

  const pid = await card.POINTS_ID()

	console.log("aaF:", aaF)
	console.log("aaT:", aaT)
	console.log("erc1155 bal(aa,pid):", (await card.balanceOf(aaF, pid)).toString())
	console.log("erc1155 bal(eoa,pid):", (await card.balanceOf(aaT, pid)).toString())
	
	  // ✅ 先 staticCall 看到真实 revert
	  try {
		await factory.redeemOpenTransfer.staticCall(
		  sign.cardAddress,
		  sign.fromEOA,
		  sign.to,
		  BigInt(sign.id),
		  BigInt(sign.amount),
		  BigInt(sign.maxAmount),
		  BigInt(sign.validAfter),
		  BigInt(sign.validBefore),
		  sign.nonce,
		  sign.signature
		);
		console.log("✅ redeemOpenTransfer staticCall ok");
	  } catch (e: any) {
		const data = e?.data || e?.error?.data || e?.info?.error?.data;
		const msg = e?.shortMessage || e?.message || String(e);
		console.error("❌ redeemOpenTransfer staticCall FAILED");
		console.error("message:", msg);
		console.error("revert data:", data);
		throw e;
	  }
	
	  // ✅ 再发交易
	  const tx = await factory.redeemOpenTransfer(
		sign.cardAddress,
		sign.fromEOA,
		sign.to,
		BigInt(sign.id),
		BigInt(sign.amount),
		BigInt(sign.maxAmount),
		BigInt(sign.validAfter),
		BigInt(sign.validBefore),
		sign.nonce,
		sign.signature
	  );
	
	  await tx.wait();
	  console.log("✅ success tx:", tx.hash);
	  return { txHash: tx.hash, };
	
	
}

// addWhitelistViaGov({
// 	cardAddr: CCSACardAddressNew,
// 	targetAddr: "0xD2d37BBa75Be722F3a725111d4e2ebAf16e034E1",
// 	allowed: true
// })


// forward1155ERC3009SignatureData()