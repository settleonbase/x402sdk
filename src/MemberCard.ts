import { ethers } from 'ethers'
import BeamioFactoryPaymasterABI from './ABI/BeamioUserCardFactoryPaymaster.json'
import { masterSetup, checkSign } from './util'
import { Request, Response} from 'express'
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
import AdminFacetABI from "./ABI/adminFacet_ABI.json";
import beamioConetABI from './ABI/beamio-conet.abi.json'
import BeamioUserCardGatewayABI from './ABI/BeamioUserCardGatewayABI.json'
import { BASE_AA_FACTORY, BASE_CARD_FACTORY, BASE_CCSA_CARD_ADDRESS } from './chainAddresses'

import { createBeamioCardWithFactory } from './CCSA'

/** Base 主网：与 chainAddresses.ts / config/base-addresses.ts 一致 */

const BeamioUserCardFactoryPaymasterV2 = BASE_CARD_FACTORY
const BeamioAAAccountFactoryPaymaster = BASE_AA_FACTORY
const BeamioOracle = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'
const beamioConetAddress = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
/** UserCard gateway = AA Factory（与 BASE_AA_FACTORY 一致） */
const BeamioUserCardGatewayAddress = BASE_AA_FACTORY

const BeamioTaskIndexerAddress = '0x083AE5AC063a55dBA769Ba71Cd301d5FC5896D5b'
const DIAMOND = BeamioTaskIndexerAddress
/** Base 主网 RPC，与 UI 一致，保证报价与链上状态一致 */
const BASE_RPC_URL = 'https://1rpc.io/base'
const providerBase = new ethers.JsonRpcProvider(BASE_RPC_URL)
const providerBaseBackup = new ethers.JsonRpcProvider(BASE_RPC_URL)
const providerBaseBackup1 = new ethers.JsonRpcProvider(BASE_RPC_URL)
const conetEndpoint = 'https://mainnet-rpc.conet.network'
const providerConet = new ethers.JsonRpcProvider(conetEndpoint)
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
		const code = await provider.getCode(predictedAddress)
		if (code === '0x' || code === '') {
			logger(Colors.red(`DeployingSmartAccount: 交易成功但账户未部署，地址=${predictedAddress}`))
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

export const OpenContainerRelayPool: { openContainerPayload: OpenContainerRelayPayload; res: Response }[] = []

/** ContainerRelayPayload：UI 提交的 containerMainRelayed（绑定 to）签名结果，与 SilentPassUI ContainerRelayPayload 一致 */
export type ContainerRelayPayload = {
	account: string
	to: string
	items: { kind: number; asset: string; amount: string | bigint; tokenId: string | bigint; data: string }[]
	nonce: string
	deadline: string
	signature: string
}

export const ContainerRelayPool: {
	containerPayload: ContainerRelayPayload
	currency?: string
	currencyAmount?: string
	res: Response
}[] = []

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
	tip?: number
	parentHash?: string
	oneTimeMode?: boolean
	code?: string
	title?: string
	currencyTax?: string
	usdcAmount?: number
	depositHash?: string
}

const cardNote = (cardAddress : string, usdcAmount: string,  currency: ICurrency, parentHash: string, currencyAmount: string, isMember: boolean): payMe|null => {

	const payMe: payMe = {
		currency,
		currencyAmount,
		title: ``,
		usdcAmount: Number(usdcAmount),
		parentHash
	}

	logger(Colors.green(`✅ cardNote cardAddress = ${cardAddress} == '${CCSACardAddressNew}' isMember = ${isMember} usdcAmount = ${usdcAmount} currencyAmount = ${currencyAmount} parentHash = ${parentHash}`));
payMe.title = isMember ? `Top Up` : `CCSA Membership`
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

		const card = new ethers.Contract(cardAddress, BeamioUserCardABI, SC.walletBase)




		const tx = await card.buyPointsWith3009Authorization(
			from,
			usdcAmount,
			validAfter,
			validBefore,
			nonce,
			userSignature,
			0
		)
		
		logger(Colors.green(`✅ purchasingCardProcess success! Hash: ${tx.hash}`));



		const to = owner
		const currency = getICurrency(BigInt(_currency))
		const ACTION_TOKEN_MINT = 1; // ActionFacet: 1 mint
		const payMe = cardNote(cardAddress, currencyAmount.usdc, currency, tx.hash, currencyAmount.points, isMember)

		logger(Colors.green(`✅ purchasingCardProcess payMe cardAddress = ${cardAddress} payMe = ${inspect(payMe, false, 3, true)}`));
		if (!payMe) {
			logger(Colors.red(`❌ purchasingCardProcess payMe is null`));
			Settle_ContractPool.unshift(SC)
			setTimeout(() => purchasingCardProcess(), 3000)
			return
		}

		

		const input = {
			actionType: ACTION_TOKEN_TYPE.TOKEN_MINT,
			card: cardAddress,
			from: ethers.ZeroAddress,
			to: from, // ✅ points 归属 from
			amount: currencyAmount.points6,
			ts: 0n,

			title: `${payMe.title}`,
			note: JSON.stringify(payMe),
			tax: 0n,
			tip: 0n,
			beamioFee1: 0n,
			beamioFee2: 0n,
			cardServiceFee: 0n,
	
			afterTatchNoteByFrom: "",
			afterTatchNoteByTo: "",
			afterTatchNoteByCardOwner: "",
		};
		
		

		logger(Colors.green(`✅ purchasingCardProcess note: ${payMe}`));


		await tx.wait()
		
			
			// tx 为 ethers TransactionResponse，只有 tx.hash，无 tx.finishedHash；合约 bytes32 用交易哈希 tx.hash 即可
		const tr = await SC.conetSC.transferRecord(
				obj.from,
				to,
				usdcAmount,
				tx.hash,
				`\r\n${JSON.stringify(payMe)}`
			)	
		await tr.wait()
		const actionFacet = await SC.BeamioTaskDiamondAction
		const tx2 = await actionFacet.syncTokenAction(input)
		await tx2.wait()
		obj.res.status(200).json({success: true, USDC_tx: tx.hash}).end()
		logger(Colors.green(`✅ purchasingCardProcess success! Hash: ${tx.hash}`), `✅ conetSC Hash: ${tr.hash}`, `✅ syncTokenAction Hash: ${tx2.hash}`);
		
		
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
    await tx.wait()

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

  const payload = obj.openContainerPayload
  logger(`[AAtoEOA/OpenContainer] process started account=${payload.account} to=${payload.to}`)

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
        // 仅用 payload.to（受益人地址）解析，禁止用 payload.account（付款方）
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
            logger(Colors.yellow(`[AAtoEOA/OpenContainer] ERC1155 item but beneficiary ${payload.to} has no AA; card will revert UC_NoBeamioAccount`))
          }
        }
      } catch (e: any) {
        logger(Colors.yellow(`[AAtoEOA/OpenContainer] primaryAccountOf(beneficiary ${payload.to}) failed: ${e?.message ?? e}`))
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
    await tx.wait()
    logger(Colors.green(`✅ OpenContainerRelayProcess success! tx=${tx.hash}`))
    obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end()
  } catch (error: any) {
    let msg = error?.shortMessage || error?.message || String(error)
    if (error?.data) {
      logger(Colors.red(`[AAtoEOA/OpenContainer] revert data=${error.data}`))
      // CM_ReservedERC20Violation(address,uint256,uint256,uint256) → 多为余额不足
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
            const spendHuman = Number(spend) / 1e6
            const balHuman = Number(bal) / 1e6
            msg = `Insufficient USDC balance: account has ${balHuman.toFixed(2)} USDC, need ${spendHuman.toFixed(2)} USDC`
          }
        } catch (_) {}
      }
    }
    logger(Colors.red(`❌ OpenContainerRelayProcess failed: ${msg}`))
    // 失败时必须返回 500，且仅发送一次（避免 headers 已发送时再写导致异常）
    if (!obj.res.headersSent) {
      obj.res.status(500).json({ success: false, error: msg }).end()
    } else {
      logger(Colors.red(`[AAtoEOA/OpenContainer] WARN: response already sent, client may have received wrong status`))
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
    await tx.wait()

    const usdcAmountRaw = BigInt(payload.items[0].amount)
    const currency = (obj.currency ?? 'USDC') as ICurrency
    const currencyAmount = obj.currencyAmount ?? String(Number(usdcAmountRaw) / 1e6)
    const payMeData: payMe = {
      currency,
      currencyAmount,
      title: 'AA to EOA',
      usdcAmount: Number(usdcAmountRaw) / 1e6,
      parentHash: tx.hash,
    }
    logger(Colors.green(`✅ ContainerRelayProcess payMe = ${inspect(payMeData, false, 2, true)}`))
    const tr = await SC.conetSC.transferRecord(
      account,
      to,
      usdcAmountRaw,
      tx.hash,
      `\r\n${JSON.stringify(payMeData)}`
    )
    await tr.wait()

    const actionInput = {
      actionType: ACTION_TOKEN_TYPE.TOKEN_TRANSFER,
      card: USDC_ADDRESS,
      from: account,
      to,
      amount: usdcAmountRaw,
      ts: 0n,
      title: 'AA to EOA',
      note: JSON.stringify(payMeData),
      tax: 0n,
      tip: 0n,
      beamioFee1: 0n,
      beamioFee2: 0n,
      cardServiceFee: 0n,
      afterTatchNoteByFrom: '',
      afterTatchNoteByTo: '',
      afterTatchNoteByCardOwner: '',
    }
    const actionFacet = SC.BeamioTaskDiamondAction
    const tx2 = await actionFacet.syncTokenAction(actionInput)
    await tx2.wait()
    logger(Colors.green(`✅ ContainerRelayProcess success! tx=${tx.hash} conetSC=${tr.hash} syncTokenAction=${tx2.hash}`))
    obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end()
  } catch (error: any) {
    const msg = error?.shortMessage || error?.message || String(error)
    logger(Colors.red(`❌ ContainerRelayProcess failed: ${msg}`))
    if (error?.data) logger(Colors.red(`[AAtoEOA/Container] revert data=${error.data}`))
    const dataHex = typeof error?.data === 'string' ? error.data : ''
    const isBadNonce = dataHex.length >= 10 && dataHex.slice(0, 10).toLowerCase() === '0x74794617'
    const clientError = isBadNonce
      ? 'Nonce already used (链上 nonce 已递增). 请重新发起转账，不要重复提交同一笔。'
      : msg
    obj.res.status(isBadNonce ? 400 : 500).json({ success: false, error: clientError }).end()
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

/** 与主 RPC 一致，unitPrice 主 RPC 返回 0 时重试用（当前主 RPC 已固定为 1rpc.io/base） */
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