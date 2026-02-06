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
import BeamioUserCardArtifact from './ABI/BeamioUserCardArtifact.json'
import BeamioUserCardGatewayABI from './ABI/BeamioUserCardGatewayABI.json'


/** Base 主网：与 chainAddresses.ts / config/base-addresses.ts 一致 */

const BeamioUserCardFactoryPaymasterV2 = '0x7Ec828BAbA1c58C5021a6E7D29ccDDdB2d8D84bd'
const BeamioAAAccountFactoryPaymaster = '0xFD48F7a6bBEb0c0C1ff756C38cA7fE7544239767'
const BeamioOracle = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'
const beamioConetAddress = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd'
const BeamioUserCardGatewayAddress = '0x5b24729E66f13BaB19F763f7aE7A35C881D3d858'

const BeamioTaskIndexerAddress = '0x083AE5AC063a55dBA769Ba71Cd301d5FC5896D5b'
const DIAMOND = BeamioTaskIndexerAddress
const providerBase = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const providerBaseBackup = new ethers.JsonRpcProvider('https://1rpc.io/base')
const providerBaseBackup1 = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const conetEndpoint = 'https://mainnet-rpc.conet.network'
const providerConet = new ethers.JsonRpcProvider(conetEndpoint)
let Settle_ContractPool: {
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

masterSetup.settle_contractAdmin.forEach(n => {
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


  const addAdminList = async (adminList: string[]) => {
	const  walletConet = Settle_ContractPool[0].walletConet
	const SC = new ethers.Contract(DIAMOND, AdminFacetABI, walletConet);
		
	// 可选：确认一下 sender 是谁
	const sender = await walletConet.getAddress();
	logger(`[Beamio] sender(owner?)=${sender}`);
		// 可选：确认一下 sender 是谁
		
	
	for (const admin of adminList) {
		try {
			if (!ethers.isAddress(admin)) {
			logger(`[Beamio] skip invalid address: ${admin}`);
			continue;
			}
	
			const already = await SC.isAdmin(admin);
			if (already) {
			logger(`[Beamio] ${admin} is already an Admin`);
			continue;
			}
	
			logger(`[Beamio] ${admin} is not an Admin, enabling...`);
			const tx = await SC.setAdmin(admin, true);   // ✅ 正确：setAdmin(admin, true)
			const receipt = await tx.wait();
	
			logger(`[Beamio] Successfully enabled ${admin}. tx=${tx.hash} block=${receipt.blockNumber}`);
		} catch (e: any) {
			logger(
			`[Beamio] Failed for ${admin}: ${e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)}`
			);
		}
	}
  }



//logger(`[Beamio] Registering ${adminn.address} `)

const registerPayMasterForCardFactory = async (payMasterAddress: string) => {
	const targetAddress = payMasterAddress;
    const SC = Settle_ContractPool[0].baseFactoryPaymaster
    try {
        // 1. 修正调用：合约生成的 getter 是小写 m
        // ethers 会自动为 public mapping 生成同名 getter 函数
        const alreadyRegistered = await SC.isPaymaster(targetAddress); 
        
        if (alreadyRegistered) {
            console.log(`[Beamio] Address ${targetAddress} is already a registered PayMaster.`);
            return;
        }

        console.log(`[Beamio] Registering ${targetAddress} as PayMaster...`);

        // 2. 修正函数名：合约中对应的函数是 changePaymasterStatus
        // 第二个参数传 true 表示启用
        const tx = await SC.changePaymasterStatus(targetAddress, true);
        
        await tx.wait();
        console.log(`[Beamio] Successfully added ${targetAddress} as PayMaster. Hash: ${tx.hash}`);
    } catch (error: any) {
        // 这里报错通常是因为：
        // 1. 函数名拼错（已修正）
        // 2. 调用者（adminn）不是合约的 owner（触发 NotAuthorized 错误）
        console.error("[Beamio] Failed to add PayMaster. Ensure your signer is the Factory Admin:", error.message);
        throw error;
    }
}

const registerPayMasterForAAFactory = async (payMasterAddress: string) => {
	const targetAddress = payMasterAddress;
    const SC = Settle_ContractPool[0].aaAccountFactoryPaymaster
    try {
        // 1. 修正调用：合约生成的 getter 是小写 m
        // ethers 会自动为 public mapping 生成同名 getter 函数
        const alreadyRegistered = await SC.isPayMaster(targetAddress); 
        
        if (alreadyRegistered) {
            console.log(`[Beamio] Address ${targetAddress} is already a registered PayMaster.`);
            return;
        }

        console.log(`[Beamio] Registering ${targetAddress} as PayMaster...`);

        // 2. 修正函数名：合约中对应的函数是 changePaymasterStatus
        // 第二个参数传 true 表示启用
        const tx = await SC.addPayMaster(targetAddress);
        
        await tx.wait();
        console.log(`[Beamio] Successfully added ${targetAddress} as PayMaster. Hash: ${tx.hash}`);
    } catch (error: any) {
        // 这里报错通常是因为：
        // 1. 函数名拼错（已修正）
        // 2. 调用者（adminn）不是合约的 owner（触发 NotAuthorized 错误）
        console.error("[Beamio] Failed to add PayMaster. Ensure your signer is the Factory Admin:", error.message);
        throw error;
    }
}

/**
 * 为 EOA 确保存在 AA 账户（purchasingCardProcess 等流程的依赖）。
 * 约定：每个 EOA 仅拥有 index 为 0 的一个 AA 账户；若已存在则直接返回其地址，否则由 Paymaster 创建。
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
			// 已有至少一个账户，只认 index 0 的那一个
			const provider = (SC.runner as ethers.Wallet)?.provider ?? providerBaseBackup
			const code = await provider.getCode(predictedAddress)
			if (code === '0x' || code === '') {
				logger(Colors.red(`DeployingSmartAccount: ${wallet} nextIndex=${nextIndex} 但 index=0 地址未部署，状态异常`))
				return { accountAddress: '', alreadyExisted: false }
			}
			logger(`DeployingSmartAccount: 账户已存在 (index=0)`)
			return { accountAddress: predictedAddress, alreadyExisted: true }
		}

		// 尚无账户，由 Paymaster 创建（工厂会分配 index 0）
		const tx = await SC.createAccountFor(wallet)
		console.log(`交易成功！哈希: ${tx.hash}`)
		await tx.wait()

		logger(`DeployingSmartAccount 已为 ${wallet} 创建 AA (index=0)`, tx.hash)
		return { accountAddress: predictedAddress, alreadyExisted: false }
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error)
		logger(`DeployingSmartAccount error!`, msg)
	}
	return { accountAddress: '', alreadyExisted: false }
}


/**
 * 检查 EOA 是否已拥有 index=0 的 AA 账户（与 DeployingSmartAccount 约定一致）。
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

/**
 * Deploy a new card with pricing:
 *   1 currency unit = X points
 *
 * Contract param pointsUnitPriceInCurrencyE18 means:
 *   price of 1.000000 point (1e6 units) in currency, with 1e18 precision.
 *
 * Therefore:
 *   priceE18 = 1e18 / X
 */
const initCardTest_old = async (
	user: string,
	currencyType: CurrencyType,
	currencyToPointValue: number,
	opts?: {
	  uri?: string
	  previewPayUsdc?: number // default 0.01
	  minX?: number // default 10 (防止误传 1)
	}
  ) => {
	const uri = opts?.uri ?? 'https://api.beamio.io/metadata/default_card.json'
	const previewPayUsdc = opts?.previewPayUsdc ?? 0.01
	const minX = opts?.minX ?? 10
  
	if (!ethers.isAddress(user)) throw new Error(`bad user address: ${user}`)
  
	const X = Number(currencyToPointValue)
	if (!Number.isFinite(X) || X <= 0) throw new Error(`currencyToPointValue must be > 0, got ${currencyToPointValue}`)
	if (X < minX) {
	  throw new Error(
		`Refusing to deploy: currencyToPointValue (X=${X}) is too small. Did you mean 10000?\n` +
		  `Rule: require X >= ${minX} to prevent accidental '1 currency = 1 point' deployments.`
	  )
	}
  
	const currencyId = CurrencyMap[currencyType]
	const usdcId = CurrencyMap.USDC
  
	// priceE18 = 1e18 / X
	const priceE18 = E18 / BigInt(X)
  
	// ===== Preview using your oracle table =====
	try {
	  const rates = await getAllRate()
  
	  const c = rates.find(r => r.id === currencyId && r.status === 'Active')
	  const u = rates.find(r => r.id === usdcId && r.status === 'Active')
  
	  if (c && u) {
		const cUSD = BigInt(c.rateRaw) // currency -> USD (E18)
		const uUSD = BigInt(u.rateRaw) // USDC -> USD (E18)
  
		// usdE18 = priceE18 * cUSD / 1e18
		const usdE18 = (priceE18 * cUSD) / E18
  
		// usdcE18 = usdE18 * 1e18 / uUSD
		const usdcE18 = (usdE18 * E18) / uUSD
  
		// usdc6 per 1 point (rounded)
		const usdc6PerPoint = (usdcE18 + (E12 / 2n)) / E12
  
		const payUsdc6 = BigInt(Math.round(previewPayUsdc * 1_000_000))
		const points6Out = usdc6PerPoint === 0n ? 0n : (payUsdc6 * POINTS_ONE) / usdc6PerPoint
  
		logger(`[InitCardTest] Preview by oracle:`)
		logger(`  currency=${currencyType} (id=${currencyId})  X=${X} points/1 ${currencyType}`)
		logger(`  priceE18 (currency per 1 point) = ${ethers.formatUnits(priceE18, 18)} ${currencyType}`)
		logger(`  rate ${currencyType}->USD = ${ethers.formatUnits(cUSD, 18)} , USDC->USD = ${ethers.formatUnits(uUSD, 18)}`)
		logger(`  unitPriceUsdc6 (USDC per 1 point) = ${ethers.formatUnits(usdc6PerPoint, 6)} USDC`)
		logger(`  pay ${previewPayUsdc} USDC => ~ ${ethers.formatUnits(points6Out, 6)} points`)
	  } else {
		logger(`[InitCardTest] Preview skipped: missing active rate for ${currencyType} or USDC`)
	  }
	} catch (e: any) {
	  logger(Colors.gray(`[InitCardTest] Preview skipped (getAllRate failed): ${e?.message ?? String(e)}`))
	}
	const SC = Settle_ContractPool[0].baseFactoryPaymaster
	// ===== Deploy =====
	logger(Colors.yellow(`[Test] Deploying Card: 1 ${currencyType} = ${X} Points`))
	logger(Colors.gray(`[Test] priceE18 = ${priceE18.toString()} (= ${ethers.formatUnits(priceE18, 18)} ${currencyType} per 1 point)`))





	
  
	const tx = await SC.createCardCollectionFor(user, uri, currencyId, priceE18)
	logger(Colors.cyan(`[Test] Transaction sent: ${tx.hash}`))
  
	const receipt = await tx.wait()
	if (receipt.status !== 1) throw new Error('Transaction reverted on-chain.')
		
	const cardDeployedLog = receipt.logs.find((log: any) => {
	  try {
		const parsed = SC.interface.parseLog(log)
		return parsed?.name === 'CardDeployed'
	  } catch {
		return false
	  }
	})
  
	if (!cardDeployedLog) throw new Error('CardDeployed event not found in receipt logs.')
  
	const parsed = SC.interface.parseLog(cardDeployedLog)
	const newCardAddress = parsed?.args.card as string
  
	logger(Colors.green(`✅ [Test] Success! Card: ${newCardAddress}`))
	return newCardAddress
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

  export const develop1 = async (
	user: string,
	currencyType: CurrencyType,
	currencyToPointValue: string
  ) => {
	const uri = "https://api.beamio.io/metadata/default_card.json";
  
	// ===== your existing config =====
	const SC = Settle_ContractPool[0];
	const signer = SC.walletBase;
	const baseProvider = signer.provider!;
	const signerAddr = await signer.getAddress();
  
	// ✅ MUST be BeamioUserCardFactoryPaymasterV07 address (the trusted gateway)
	const factoryAddress = BeamioUserCardFactoryPaymasterV2;
  
	// ===== BeamioUserCard ctor:
	// constructor(string uri, uint8 currency, uint256 priceE18, address initialOwner, address gateway)
	// gateway == factoryAddress (BeamioUserCardFactoryPaymasterV07)
	const priceE18 = ethers.parseUnits(currencyToPointValue, 18);
	const currencyId = CurrencyMap[currencyType]; // uint8/number
  
	const abi = BeamioUserCardArtifact.abi ?? BeamioUserCardABI;
	if (!abi) throw new Error("Missing ABI");
  
	const bytecodeRaw = BeamioUserCardArtifact.bytecode;
	if (!bytecodeRaw) throw new Error("Missing bytecode in artifact");
  
	const bytecode = bytecodeRaw.startsWith("0x") ? bytecodeRaw : `0x${bytecodeRaw}`;
	if (/__\$\w+\$__|__\w+__/.test(bytecode)) {
	  throw new Error("Bytecode contains unlinked libraries placeholders");
	}
  
	// ===== build initCode for DeployerV07.deploy(initCode) =====
	const cardFactory = new ethers.ContractFactory(abi, bytecode, signer);
  
	// ✅ 5 params: uri, currencyId, priceE18, initialOwner(user), gateway(factoryAddress)
	const deployTx = await cardFactory.getDeployTransaction(
	  uri,
	  currencyId,
	  priceE18,
	  user,
	  factoryAddress
	);
  
	const initCodeHex = deployTx.data as string;
	if (!initCodeHex || initCodeHex.length <= 2) throw new Error("initCode empty");
  
	const net = await baseProvider.getNetwork();
	console.log("chainId:", net.chainId.toString());
	console.log("deployer signer:", signerAddr);
	console.log("factoryAddress:", factoryAddress);
	console.log("✅ initCodeHex length:", initCodeHex.length);
	console.log("✅ initCodeHex prefix:", initCodeHex.slice(0, 10));
  
	// ===== call FactoryPaymasterV07.createCardCollectionWithInitCode =====
	const factory = new ethers.Contract(
	  factoryAddress,
	  SC.baseFactoryPaymaster.interface, // must include createCardCollectionWithInitCode(...)
	  signer
	);
  
	// ✅ correct simulation: staticCall through factory (so it goes through DeployerV07 + checks)
	try {
	  await factory.createCardCollectionWithInitCode.staticCall(
		user,
		currencyId,
		priceE18,
		initCodeHex,
		{ gasLimit: 6_500_000n }
	  );
	  console.log("✅ factory staticCall ok");
	} catch (e: any) {
	  const data = e?.data || e?.error?.data || e?.info?.error?.data;
	  const msg = e?.shortMessage || e?.message || String(e);
	  console.error("❌ factory staticCall FAILED");
	  console.error("message:", msg);
	  console.error("revert data:", data);
	  throw e;
	}
  
	// ✅ send tx
	const tx = await factory.createCardCollectionWithInitCode(
	  user,
	  currencyId,
	  priceE18,
	  initCodeHex,
	  { gasLimit: 6_500_000n }
	);
  
	const rc = await tx.wait();
	return { txHash: tx.hash, receipt: rc };
  };
  

 

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
  

export const purchasingCardPool: { cardAddress: string, userSignature: string, nonce: string, usdcAmount: string, from: string, validAfter: string, validBefore: string, res: Response } [] = []

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

async function setTier(ownerPk: string, cardAddr: string) {
	const signer = new ethers.Wallet(ownerPk, providerBaseBackup)
	const card = new ethers.Contract(cardAddr, BeamioUserCardABI, signer)
  
	console.log('owner=', await card.owner())
	console.log('tiersCount(before)=', (await card.getTiersCount()).toString())
  
	// 超低门槛，保证你买 0.01 USDC 后会触发发卡
	const tx = await card.appendTier(1n, 1n, { gasLimit: 500_000 })
	await tx.wait()
  
	console.log('tiersCount(after)=', (await card.getTiersCount()).toString())
	console.log('tx=', tx.hash)
}
  

/** 新部署的 CCSA 卡（1 CAD = 1 token），与 deployments/base-UserCard-0xEaBF0A98.json 一致 */
const CCSACardAddressNew = '0x1Dc8c473fc67358357E90636AE8607229d5e9f92'.toLowerCase()

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
		
		const { accountAddress, alreadyExisted } = await DeployingSmartAccount(obj.from, SC.aaAccountFactoryPaymaster)

		if (!accountAddress) {
			logger(Colors.red(`❌ ${obj.from} purchasingCardProcess DeployingSmartAccount failed`));
			obj.res.status(400).json({success: false, error: 'DeployingSmartAccount failed'}).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => purchasingCardProcess(), 3000)
			return
		}

		const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore } = obj

		// 1. 获取受益人 (Owner) - 仅作为签名参数，不需要 Owner 签名
		const card = new ethers.Contract(cardAddress, BeamioUserCardABI, SC.walletBase); // 使用 adminn 账户进行提交

		const [[pointsBalance, nfts] ,owner, _currency, currencyAmount] = await Promise.all([
			card.getOwnership(accountAddress),
			card.owner(),
			card.currency(),
			quotePointsForUSDC_raw(cardAddress, BigInt(usdcAmount))
		])

		const isMember = (nfts?.length > 0) && (pointsBalance > 0n)
		
		logger(Colors.green(`✅ purchasingCardProcess cardAddress = ${cardAddress} ${obj.from} AA Account: ${accountAddress} isMember: ${isMember} pointsBalance: ${pointsBalance} nfts: ${nfts?.length}`));




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
		const currency = getICurrency(_currency)
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
			actionType: ACTION_TOKEN_MINT,
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
		logger(Colors.red(`❌ purchasingCardProcess failed:`), error);
		//obj.res.status(400).json({success: false, error: 'purchasingCardProcess failed'}).end()
		
	}

	Settle_ContractPool.unshift(SC)

	setTimeout(() => purchasingCardProcess(), 3000)
}

/** EntryPoint v0.7：用于提交 UserOp、查询 userOpHash（与链上校验一致） */
const EntryPointHandleOpsABI = [
	'function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary) external',
	'function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)',
]

/**
 * AA→EOA 队列处理：从 Pool 取任务，用 Settle_ContractPool 的私钥提交 UserOp 到 EntryPoint，代付 Gas。
 * 与 purchasingCardProcess 相同：从 Pool 取一项、从 Settle_ContractPool 取一个 SC，执行后归还并递归。
 */
export const AAtoEOAProcess = async () => {
	const obj = AAtoEOAPool.shift()
	if (!obj) return
	logger(`[AAtoEOA] process started, pool had item toEOA=${obj.toEOA} amountUSDC6=${obj.amountUSDC6} sender=${obj.packedUserOp?.sender}`)
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		logger(Colors.yellow(`[AAtoEOA] process no SC available, re-queue and retry in 3s (pool length ${AAtoEOAPool.length})`))
		AAtoEOAPool.unshift(obj)
		return setTimeout(() => AAtoEOAProcess(), 3000)
	}
	let recoveredSigner: string | null = null
	try {
		const op = obj.packedUserOp
		const callData = op.callData || '0x'
		if (!callData.startsWith('0x')) {
			const errMsg = 'Invalid callData: must start with 0x'
			logger(Colors.red(`❌ AAtoEOAProcess ${errMsg}`))
			obj.res.status(400).json({ success: false, error: errMsg }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => AAtoEOAProcess(), 3000)
			return
		}
		const rawSig = op.signature ?? '0x'
		const sigHex = typeof rawSig === 'string' && rawSig.startsWith('0x') ? rawSig : '0x' + (rawSig || '')
		const sigLen = sigHex.length <= 2 ? 0 : (sigHex.length - 2) / 2
		// 占位/测试 UserOp（空 callData 或空 signature）会在链上被 EntryPoint 拒绝并 revert（如 AA233 reverted）
		// if (callDataHex.length <= 2 || sigHex.length <= 2 || sigLen === 0) {
		// 	const errMsg = 'Invalid UserOp: callData and signature must be non-empty (client must sign the UserOp with the AA owner key; see ERC-4337)'
		// 	logger(Colors.red(`❌ AAtoEOAProcess ${errMsg} (signatureLen=${sigHex.length})`))
		// 	obj.res.status(400).json({ success: false, error: errMsg }).end()
		// 	Settle_ContractPool.unshift(SC)
		// 	setTimeout(() => AAtoEOAProcess(), 3000)
		// 	return
		// }
		// BeamioAccount._checkThresholdManagersEthSign 要求 sigs.length % 65 === 0；单签必须恰好 65 字节，否则链上验证失败（AA23）
		if (sigLen !== 65) {
			const errMsg = `Invalid signature length: expected 65 bytes (130 hex chars), got ${sigLen} bytes (${sigHex.length} chars). Ensure client sends EIP-191 signature as hex, not double-encoded.`
			logger(Colors.red(`❌ AAtoEOAProcess ${errMsg}`))
			obj.res.status(400).json({ success: false, error: errMsg }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => AAtoEOAProcess(), 3000)
			return
		}
		// 显式转为 65 字节再传给 handleOps，避免 JSON/ABI 层把十六进制字符串误编码为 132 字节（导致 sigs.length % 65 !== 0）
		let sigBytes: Uint8Array
		try {
			sigBytes = ethers.getBytes(sigHex)
		} catch (e) {
			const errMsg = 'Invalid signature hex: cannot decode to bytes'
			logger(Colors.red(`❌ AAtoEOAProcess ${errMsg}`))
			obj.res.status(400).json({ success: false, error: errMsg }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => AAtoEOAProcess(), 3000)
			return
		}
		if (sigBytes.length !== 65) {
			const errMsg = `Signature decoded length is ${sigBytes.length}, expected 65`
			logger(Colors.red(`❌ AAtoEOAProcess ${errMsg}`))
			obj.res.status(400).json({ success: false, error: errMsg }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => AAtoEOAProcess(), 3000)
			return
		}
		logger(`[AAtoEOA] signature bytes length=${sigBytes.length} hexLen=${sigHex.length}`)
		const senderCode = await SC.walletBase.provider!.getCode(op.sender)
		if (!senderCode || senderCode === '0x' || senderCode.length <= 2) {
			const errMsg = 'Invalid sender: must be the AA contract address (with code), not the EOA. Use the smart account from primaryAccountOf(owner).'
			logger(Colors.red(`❌ AAtoEOAProcess ${errMsg} sender=${op.sender}`))
			obj.res.status(400).json({ success: false, error: errMsg }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => AAtoEOAProcess(), 3000)
			return
		}
		const entryPointAddress = await SC.aaAccountFactoryPaymaster.ENTRY_POINT()
		logger(`[AAtoEOA] ENTRY_POINT address: ${entryPointAddress}`)
		if (!entryPointAddress || entryPointAddress === ethers.ZeroAddress) {
			logger(Colors.red(`❌ AAtoEOAProcess ENTRY_POINT not found`))
			obj.res.status(500).json({ success: false, error: 'ENTRY_POINT not configured' }).end()
			Settle_ContractPool.unshift(SC)
			setTimeout(() => AAtoEOAProcess(), 3000)
			return
		}
		const entryPoint = new ethers.Contract(entryPointAddress, EntryPointHandleOpsABI, SC.walletBase)
		const packedOp = {
			sender: op.sender,
			nonce: typeof op.nonce === 'string' ? BigInt(op.nonce) : op.nonce,
			initCode: op.initCode || '0x',
			callData,
			accountGasLimits: op.accountGasLimits || ethers.ZeroHash,
			preVerificationGas: typeof op.preVerificationGas === 'string' ? BigInt(op.preVerificationGas) : op.preVerificationGas,
			gasFees: op.gasFees || ethers.ZeroHash,
			paymasterAndData: op.paymasterAndData || '0x',
			signature: sigBytes,
		}

		const pnd = packedOp.paymasterAndData
		logger(`[AAtoEOA] paymasterAndDataLen=${(typeof pnd === 'string' ? (pnd.length-2)/2 : (pnd as Uint8Array).length)} pnd=${typeof pnd === 'string' ? pnd.slice(0, 42) + '...' : 'bytes'}`)

		if (typeof pnd === 'string' && pnd.length >= 42) {
			const pm = ethers.getAddress('0x' + pnd.slice(2, 42))
			logger(`[AAtoEOA] parsed paymaster=${pm}`)
		  }

		// 与链上/客户端一致：userOpHash 必须用「空 signature」计算（ERC-4337 约定，客户端也是 signature: '0x' 算 hash 再签名）
		try {
			const opForHash = { ...packedOp, signature: '0x' as unknown as Uint8Array }
			const userOpHash = await entryPoint.getUserOpHash(opForHash) as string
			const hashBytes = ethers.getBytes(userOpHash)
			const digest = ethers.hashMessage(hashBytes)
			recoveredSigner = ethers.recoverAddress(digest, sigHex)
			logger(`[AAtoEOA] recoveredSigner=${recoveredSigner} (must be threshold manager of AA ${packedOp.sender} for validateUserOp to pass)`)
			// 立即检查：签名人必须等于 AA 的 owner（createAccount 时 creator 写入 managers[0]）
			const aaContract = new ethers.Contract(packedOp.sender, ['function owner() view returns (address)'], SC.walletBase.provider!)
			const aaOwner = await aaContract.owner() as string



			console.log(`[AAtoEOA] entryPointAddress =${entryPointAddress} owner（createAccount factory address）=`, await aaContract.factory())


			if (aaOwner && recoveredSigner && aaOwner.toLowerCase() !== recoveredSigner.toLowerCase()) {
				const errMsg = `Signature signer (${recoveredSigner}) is not the AA owner (${aaOwner}). Use the key for the AA owner to sign.`
				logger(Colors.red(`❌ AAtoEOAProcess ${errMsg}`))
				obj.res.status(400).json({ success: false, error: errMsg }).end()
				Settle_ContractPool.unshift(SC)
				setTimeout(() => AAtoEOAProcess(), 3000)
				return
			}
		} catch (e) {
			logger(Colors.yellow(`[AAtoEOA] getUserOpHash/recover failed (non-fatal): ${(e as Error)?.message}`))
		}
		const beneficiary = await SC.walletBase.getAddress()

		const aaContract = new ethers.Contract(
			packedOp.sender,
			[
			  'function owner() view returns (address)',
			  'function factory() view returns (address)'
			],
			SC.walletBase.provider!
		  )
		  
		  const aaOwner = await aaContract.owner() as string
		  const aaFactory = await aaContract.factory() as string
		  logger(`[AAtoEOA] AA owner=${aaOwner} AA factory=${aaFactory} paymaster=${typeof pnd === 'string' && pnd.length >= 42 ? ethers.getAddress('0x' + pnd.slice(2, 42)) : '0x'}`)
		logger(`[AAtoEOA] calling entryPoint.handleOps sender=${packedOp.sender} beneficiary=${beneficiary} callDataLen=${(packedOp.callData?.length || 0)} signatureBytesLen=${sigBytes.length}`)
		
		
		const pmc = new ethers.Contract(pm, ['function isBeamioAccount(address) view returns (bool)'], SC.walletBase)
		logger(`[AAtoEOA] pm.isBeamioAccount(sender)=${await pmc.isBeamioAccount(packedOp.sender)}`)

		// 2) entryPoint deposit / AA ETH (决定能否不用 paymaster)
		logger(`[AAtoEOA] deposit=${(await entryPoint.balanceOf(packedOp.sender)).toString()} aaETH=${(await providerBaseBackup.getBalance(packedOp.sender)).toString()}`)

		// 3) 强制试一次不用 paymaster（只做一次实验）
		packedOp.paymasterAndData = '0x'
		
		
		
		const tx = await entryPoint.handleOps([packedOp], beneficiary)
		logger(`[AAtoEOA] handleOps tx submitted hash=${tx.hash}`)
		await tx.wait()
		logger(Colors.green(`✅ AAtoEOAProcess success! Hash: ${tx.hash} toEOA: ${obj.toEOA} amount: ${obj.amountUSDC6}`))
		obj.res.status(200).json({ success: true, USDC_tx: tx.hash }).end()
		} catch (error: any) {
		const msg = error?.shortMessage || error?.message || String(error)
		const data = error?.data
		// EntryPoint 常见 revert：FailedOp(uint256 opIndex, string reason) selector 0x65c8fd4d，解码出 "AA23 reverted" 等
		let clientError = msg
		if (typeof data === 'string' && data.length > 10) {
			try {
				const hexPayload = data.startsWith('0x') ? data.slice(2) : data
				if (hexPayload.length >= 8) {
					const selector = hexPayload.slice(0, 8)
					// FailedOp(uint256 opIndex, string reason): 第二项为 string 的 offset（字节，从 params 起算）
					if (selector === '65c8fd4d' && hexPayload.length >= 136) {
						const offsetBytes = parseInt(hexPayload.slice(72, 136), 16) // 第二 32 字节为 offset
						const strStart = 8 + offsetBytes * 2 // params 从 8 开始，offset 为字节
						const lenHex = hexPayload.slice(strStart, strStart + 64)
						const len = parseInt(lenHex, 16) || 0
						if (len > 0 && hexPayload.length >= strStart + 64 + len * 2) {
							const strHex = hexPayload.slice(strStart + 64, strStart + 64 + len * 2)
							const decoded = ethers.toUtf8String('0x' + strHex)
							if (decoded.length > 0) {
								clientError = `EntryPoint reverted: ${decoded}`
								// AA23 = 账户 validateUserOp 失败，多为签名恢复出的地址不是该 AA 的 owner
								if (decoded.includes('AA23') && recoveredSigner != null) {
									clientError += ` Signature recovered to ${recoveredSigner}; this address must be a threshold manager (owner) of the AA ${obj.packedUserOp?.sender ?? 'unknown'}.`
								}
							}
						}
					}
				}
			} catch (_) { /* keep clientError = msg */ }
		}
		logger(Colors.red(`❌ AAtoEOAProcess failed: ${msg}`), error?.data ? `data=${error.data}` : '')
		obj.res.status(500).json({ success: false, error: clientError }).end()
	}
	Settle_ContractPool.unshift(SC)
	setTimeout(() => AAtoEOAProcess(), 3000)
}

const getLatestCard = async (SC: any, ownerEOA: string) => {
	const factoryAddr = await SC.baseFactoryPaymaster.getAddress()
	const abi = [
		'function latestCardOfOwner(address) view returns (address)',
		'function cardsOfOwner(address) view returns (address[])'
	]
	const f = new ethers.Contract(factoryAddr, abi, providerBaseBackup)
	const latest = await f.latestCardOfOwner(ownerEOA)
	const list = await f.cardsOfOwner(ownerEOA)

	console.log('[Factory] cardsOfOwner=', list)
	console.log('[Factory] latestCard=', latest)

	if (latest === ethers.ZeroAddress) throw new Error('No card found for owner')
	return latest
}

const debugMembership = async (cardAddress: string, userEOA: string) => {
	const net = await providerBaseBackup.getNetwork()
	console.log('[net]', { chainId: net.chainId.toString(), name: net.name })

	const code = await providerBaseBackup.getCode(cardAddress)
	console.log('[card]', cardAddress, 'codeLen=', code.length, 'isDeployed=', code !== '0x')
	if (code === '0x') throw new Error(`❌ cardAddress has no code: ${cardAddress}`)

	// 先用最小 ABI 探测“必然存在的字段”
	const baseAbi = [
		'function owner() view returns (address)',
		'function factoryGateway() view returns (address)',
		'function POINTS_ID() view returns (uint256)',
		'function NFT_START_ID() view returns (uint256)',
		'function ISSUED_NFT_START_ID() view returns (uint256)',
		'function activeMembershipId(address) view returns (uint256)',
		'function activeTierIndexOrMax(address) view returns (uint256)',
		'function balanceOf(address,uint256) view returns (uint256)',
		'function getOwnership(address) view returns (uint256 pt, tuple(uint256 tokenId,uint256 attribute,uint256 tierIndexOrMax,uint256 expiry,bool isExpired)[] nfts)'
	]
	const card0 = new ethers.Contract(cardAddress, baseAbi, providerBaseBackup)

	const owner = await card0.owner()
	const gateway = await card0.factoryGateway()
	const pointsId = await card0.POINTS_ID()

	console.log('owner=', owner)
	console.log('factoryGateway=', gateway)
	console.log('POINTS_ID=', pointsId.toString())

	// resolve AA
	const aaFactory = Settle_ContractPool[0].aaAccountFactoryPaymaster
	let aa = await aaFactory.beamioAccountOf(userEOA)
	if (aa === ethers.ZeroAddress) aa = await aaFactory.primaryAccountOf(userEOA)
	console.log('aa=', aa)

	const pointsBal = await card0.balanceOf(aa, pointsId)
	const activeId = await card0.activeMembershipId(aa)
	const activeTier = await card0.activeTierIndexOrMax(aa)

	console.log('pointsBal=', pointsBal.toString())
	console.log('activeMembershipId=', activeId.toString(), 'activeTier=', activeTier.toString())

	// ✅ 直接读 getOwnership（你现在这份合约里是存在的）
	try {
		const own = await card0.getOwnership(aa)
		console.log('getOwnership.pt=', own.pt.toString())
		console.log('getOwnership.nfts=', own.nfts)
	} catch (e: any) {
		console.log('getOwnership() not found on this deployed version')
	}

	// ---- tiers: 兼容探测 ----
	const tiersAbiA = [
		'function tiersCount() view returns (uint256)',
		'function tiers(uint256) view returns (uint256 minUsdc6, uint256 attr)'
	]
	const tiersAbiB = [
		'function getTiersCount() view returns (uint256)',
		'function getTierAt(uint256) view returns (uint256 minUsdc6, uint256 attr)'
	]

	let tiersCount = 0n
	let mode: 'A' | 'B' | 'NONE' = 'NONE'

	// A: tiersCount + tiers(i)
	try {
		const cA = new ethers.Contract(cardAddress, tiersAbiA, providerBaseBackup)
		tiersCount = await cA.tiersCount()
		mode = 'A'
	} catch {}

	// B: getTiersCount + getTierAt(i)
	if (mode === 'NONE') {
		try {
		const cB = new ethers.Contract(cardAddress, tiersAbiB, providerBaseBackup)
		tiersCount = await cB.getTiersCount()
		mode = 'B'
		} catch {}
	}

	console.log('tiersMode=', mode, 'tiersCount=', tiersCount.toString())

	if (tiersCount > 0n) {
		for (let i = 0; i < Number(tiersCount); i++) {
		if (mode === 'A') {
			const cA = new ethers.Contract(cardAddress, tiersAbiA, providerBaseBackup)
			const t = await cA.tiers(i)
			console.log(`tier[${i}] minUsdc6=${t.minUsdc6.toString()} attr=${t.attr.toString()}`)
		} else if (mode === 'B') {
			const cB = new ethers.Contract(cardAddress, tiersAbiB, providerBaseBackup)
			const t = await cB.getTierAt(i)
			console.log(`tier[${i}] minUsdc6=${t.minUsdc6.toString()} attr=${t.attr.toString()}`)
		}
		}
  }

  // ✅ 最快确认“#100 是否发了”
  try {
    const bal100 = await card0.balanceOf(aa, 100n)
    console.log('balanceOf(aa, #100)=', bal100.toString())
  } catch {}
  }

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

const cardOwnerPrivateKey = ""

const BeamioAAAccount = '0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61'


const test = async () => {
	await new Promise(executor => setTimeout(executor, 3000))
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
	//await initCardTest('0x863D5B7DaD9C595138e209d932511Be4E168A660', 'CAD', 1, { minX: 1 })				//  0x46C66544cCDe8cFE6435b53a41883F5392d99C0b			0x7Dd5423FCB4924dD27E82EbAd54F4C81c0C7e4F6		//	
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

export async function addWhitelistViaGov({
		
		cardAddr,
		targetAddr,
		allowed
}: {
		
		cardAddr: string
		targetAddr: string
		allowed: boolean
	}) {
		const card = new ethers.Contract(cardAddr, BeamioUserCardArtifact.abi, Settle_ContractPool[0].walletBase)
	
		// 0xe2316652 => _setTransferWhitelist(address,bool)
		const selector = "0xe2316652"
		const v1 = allowed ? 1n : 0n
	
		// 1) 先静态拿 proposalId（避免读 event）
		const proposalId: bigint = await card.createProposal.staticCall(
			selector,
			targetAddr,
			v1,
			0n,
			0n
		)
	
		// 2) 创建 proposal（paymaster 出 gas）
		const tx1 = await card.createProposal(selector, targetAddr, v1, 0n, 0n)
		await tx1.wait()
	
		// 3) approve（如果 threshold==1，会在 _approve 里直接 _execute）
		const tx2 = await card.approveProposal(proposalId)
		await tx2.wait()
	
		return {
			proposalId: proposalId.toString(),
			txCreate: tx1.hash,
			txApprove: tx2.hash
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
  
	// 2️⃣ quote 总价（USDC 6 decimals）
	const usdc6: bigint = await factory.quotePointsInUSDC6(cardAddress, points6);
	if (usdc6 === 0n) {
	  throw new Error("quote=0 (oracle not configured or card invalid)");
	}
  
	// 3️⃣ 单价（1 token = 1e6 points）
	const unitPriceUSDC6: bigint =
	  await factory.quoteUnitPointInUSDC6(cardAddress);
  
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

export const quotePointsForUSDC_raw = async (
		cardAddress: string,
		usdc6: bigint // 已经是 raw USDC（6 decimals）
	) => {
		const factory = Settle_ContractPool[0].baseFactoryPaymaster;
	
		if (usdc6 <= 0n) {
		throw new Error("usdc6 must be > 0");
		}
	
		// 1️⃣ 拿单价：1e6 points 需要多少 USDC6
		const unitPriceUSDC6: bigint =
		await factory.quoteUnitPointInUSDC6(cardAddress);
	
		if (unitPriceUSDC6 === 0n) {
		throw new Error("unitPriceUSDC6=0 (oracle not configured?)");
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