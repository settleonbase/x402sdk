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

const memberCardBeamioFactoryPaymaster = '0x05e6a8f53b096f44928670C431F78e1F75E232bA'
const BeamioAAAccountFactoryPaymaster = '0xF036E570D5811a16A29C072528b7ceBF9933f7BD'
const BeamioOracle = '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'

const BeamioTaskIndexer = '0xc499D0597940A2607f1415327e9050602D9057e3'
const providerBase = new ethers.JsonRpcProvider(masterSetup.base_endpoint)
const providerBaseBackup = new ethers.JsonRpcProvider('https://1rpc.io/base')
const conetEndpoint = 'https://mainnet-rpc.conet.network'
const providerConet = new ethers.JsonRpcProvider(conetEndpoint)
let Settle_ContractPool: {
	baseFactoryPaymaster: ethers.Contract
	walletBase: ethers.Wallet
	walletConet: ethers.Wallet
	aaAccountFactoryPaymaster: ethers.Contract
}[] = []

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const USDC_SmartContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, providerBaseBackup)

masterSetup.settle_contractAdmin.forEach(n => {
	const walletBase = new ethers.Wallet(n, providerBaseBackup)
	const walletConet = new ethers.Wallet(n, providerConet)
	const baseFactoryPaymaster = new ethers.Contract(memberCardBeamioFactoryPaymaster, BeamioFactoryPaymasterABI, walletBase)
	const aaAccountFactoryPaymaster = new ethers.Contract(BeamioAAAccountFactoryPaymaster, BeamioAAAccountFactoryPaymasterABI, walletBase)
	Settle_ContractPool.push ({
		baseFactoryPaymaster,
		walletBase,
		walletConet,
		aaAccountFactoryPaymaster,
	})

})


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

const DeployingSmartAccount = async (wallet: string) => {
	const SC = Settle_ContractPool[0]
	if (!SC) {
		logger(`DeployingSmartAccount Error! SC is not found`);
		return false
	}
	try {
		// 3. 预测账户地址 (可选，用于在创建前告诉用户地址)
		const creatorAddress = wallet
		
		const index = await SC.aaAccountFactoryPaymaster.nextIndexOfCreator(creatorAddress);
		// 使用 getFunction 并传入完整的函数签名或名称
		const predictedAddress = await SC.aaAccountFactoryPaymaster.getFunction("getAddress(address,uint256)")(
			creatorAddress, 
			index
		);

		logger(`预测 ${wallet} 将生成的账户地址: ${predictedAddress} ${index}`);
	
		
		if (index > 0n) {
			logger(`账户已存在`);
			return;
		}
		// 如果你是普通用户调用：
		const tx = await SC.aaAccountFactoryPaymaster.createAccountFor(wallet);
		
		// // 如果你是 Paymaster 身份调用 createAccountFor：
		// // const tx = await factory.createAccountFor(creatorAddress);
		console.log(`交易成功！哈希: ${tx.hash}`);
		const receipt = await tx.wait();
		
	
		// 5. 确认结果
		console.log(`BeamioAccount 已在地址 ${predictedAddress} 部署完成。`);
	} catch (error: any) {
		console.error("[Beamio] Failed to deploy smart account. Ensure your signer is the Factory Admin:", error.message)
		throw error;
	}
}


export const checkSmartAccount = async (wallet: string) => {
	const SC = Settle_ContractPool[0]
	if (!SC) {
		return false
	}
	try {
		const currentIndex = await SC.baseFactoryPaymaster.nextIndexOfCreator(wallet)
		
            /**
             * 注意：由于 ethers.Contract 实例自带 getAddress() 方法（用于获取合约地址），
             * 与 ABI 中的 getAddress 函数重名。
             * 因此必须通过 getFunction 明确指定调用合约逻辑。
             */
            const getAddressFn = SC.baseFactoryPaymaster.getFunction("getAddress(address,uint256)")
            const predictedAddress = await getAddressFn(wallet, currentIndex)

			// 2. 检查该地址是否已经在链上部署了代码
            const code = await providerBaseBackup.getCode(predictedAddress)
            const isDeployed = code !== "0x"

            if (isDeployed) {
                console.log(`[Beamio] Account ${wallet} already deployed at ${predictedAddress}`);
                return { accountAddress: predictedAddress, alreadyExisted: true };
            }

			return false
	} catch (error) {
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
const initCardTest = async (
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
export const USDC2Token = async (userPrivateKey: string, amount: number, cardAddress: string) => {
	const SC = Settle_ContractPool[0];
  
	try {
	  const userWallet = new ethers.Wallet(userPrivateKey, providerBaseBackup);
	  const usdcAmount6 = ethers.parseUnits(amount.toString(), 6);
	  const chainId = (await providerBaseBackup.getNetwork()).chainId;
  
	  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  
	  // 0) 构造 Card（由 relayer/admin 付 gas）
	  const card = new ethers.Contract(cardAddress, BeamioUserCardABI, SC.walletBase);
  
	  // ====== 前置条件(1)：global gateway -> aaFactory 必须正确 ======
	  // 你的全局 gateway：SC.baseFactoryPaymaster
	  // 你的 aaFactory：SC.aaAccountFactoryPaymaster
	  // 要求 gateway.aaFactory() == aaAccountFactoryPaymaster 地址
  
	  // 如果 baseFactoryPaymaster 没有 aaFactory() 这个函数，你就必须在合约里补上
	  const globalAaFactory = await SC.baseFactoryPaymaster.aaFactory();
	  const localAaFactory = await SC.aaAccountFactoryPaymaster.getAddress(); // ethers v6
	  if (globalAaFactory.toLowerCase() !== localAaFactory.toLowerCase()) {
		throw new Error(
		  `❌ GlobalMisconfigured: baseFactoryPaymaster.aaFactory()=${globalAaFactory}, but SC.aaAccountFactoryPaymaster=${localAaFactory}`
		);
	  }
  
	  // 额外：aaFactory 必须是合约
	  const aaFactoryCode = await providerBaseBackup.getCode(globalAaFactory);
	  if (aaFactoryCode === "0x") {
		throw new Error(`❌ GlobalMisconfigured: aaFactory ${globalAaFactory} has no code`);
	  }
  
	  // ====== 前置条件(2)：用户 EOA 必须先有 AA account（以 beamioAccountOf 为准）======
	  const userEOA = userWallet.address;
  
	  const primaryAccount =
		await SC.aaAccountFactoryPaymaster.primaryAccountOf(userWallet.address);

		if (primaryAccount === ethers.ZeroAddress) {
			throw new Error("❌ 用户尚未创建 BeamioAccount，请先 createAccount()");
		}

		logger(`[AA] primaryAccountOf(${userWallet.address}) = ${primaryAccount}`);
  
	 
  
  
	  // （可选 debug）预测地址仅用于打印，不用于逻辑
	  const index = await SC.aaAccountFactoryPaymaster.nextIndexOfCreator(userEOA);
	  const predicted0 = await SC.aaAccountFactoryPaymaster.getFunction("getAddress(address,uint256)")(userEOA, 0);
	  logger(`[AA] user=${userEOA} index=${index} predicted(index0)=${predicted0} primaryAccount=${primaryAccount}`);
  
	  // ====== merchant ======
	  const merchantAddress = await card.owner();
	  logger(`[Debug] Merchant Address: ${merchantAddress}`);
  
	  // ====== 价格 / oracle sanity check（很重要）======
	  const unitPriceUsdc6 = await SC.baseFactoryPaymaster.quoteUnitPointInUSDC6(cardAddress);
	  if (unitPriceUsdc6 === 0n) {
		throw new Error("❌ PriceZero: quoteUnitPointInUSDC6(card)=0 (oracle 未配置/返回0)");
	  }

	  console.log("chainId =", (await providerBaseBackup.getNetwork()).chainId);
		console.log("block =", await providerBaseBackup.getBlockNumber());
  
	  // ====== 3009 签名（你这段逻辑没问题）======
	  const validBefore = Math.floor(Date.now() / 1000) + 3600;
	  const userNonce = ethers.hexlify(ethers.randomBytes(32));
  
	  const userSignature = await userWallet.signTypedData(
		{ name: "USD Coin", version: "2", chainId, verifyingContract: USDC_ADDRESS },
		{
		  TransferWithAuthorization: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
		  ],
		},
		{
		  from: userEOA,
		  to: merchantAddress,
		  value: usdcAmount6,
		  validAfter: 0,
		  validBefore,
		  nonce: userNonce,
		}
	  );
  
	  logger(`[Relayer] staticCall buyPointsWith3009Authorization...`);
  
	  // ====== 强烈建议：先 staticCall 定位 revert ======
	  await card.buyPointsWith3009Authorization.staticCall(
		userEOA,
		usdcAmount6,
		0,
		validBefore,
		userNonce,
		userSignature,
		0
	  );
  
	  logger(`[Relayer] sending buyPointsWith3009Authorization...`);
  
	  const tx = await card.buyPointsWith3009Authorization(
		userEOA,
		usdcAmount6,
		0,
		validBefore,
		userNonce,
		userSignature,
		0,
		{ gasLimit: 900_000 }
	  );
  
	  const receipt = await tx.wait();
	  logger(`✅ Purchase Success! Hash: ${tx.hash} status=${receipt.status}`);
  
	  return { txHash: tx.hash, account: primaryAccount };
  
	} catch (error: any) {
	  logger(`❌ Direct Purchase Failed: ${error.message}`);
	  throw error;
	}
  };
  

export const purchasingCardPool: { cardAddress: string, userSignature: string, nonce: string, to: string, usdcAmount: string, from: string, validAfter: string, validBefore: string, res: Response } [] = []

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
		const { cardAddress, userSignature, nonce, to, usdcAmount, from, validAfter, validBefore } = obj

		// 1. 获取受益人 (Owner) - 仅作为签名参数，不需要 Owner 签名
		const card = new ethers.Contract(cardAddress, [
			"function buyPointsWith3009Authorization(address from, uint256 usdcAmount6, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature, uint256 minPointsOut6) external"
		], SC.walletBase); // 使用 adminn 账户进行提交
		const tx = await card.buyPointsWith3009Authorization(
			from,
			usdcAmount,
			validAfter,
			validBefore,
			nonce,
			userSignature,
			0
		)
		obj.res.status(200).json({success: true, USDC_tx: tx.hash}).end()
		const receipt = await tx.wait()
		logger(Colors.green(`✅ purchasingCardProcess success! Hash: ${tx.hash}`));
		
		
	} catch (error: any) {
		logger(Colors.red(`❌ purchasingCardProcess failed:`), inspect(obj, false, 3, true), error.message);
		obj.res.status(400).json({success: false, error: 'purchasingCardProcess failed'}).end()
		
	}

	Settle_ContractPool.unshift(SC)

	setTimeout(() => purchasingCardProcess(), 3000)
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
        const cardContract = new ethers.Contract(
            cardAddress,
            [
                "function getOwnership(address user) external view returns (uint256 pt, tuple(uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)"
            ],
            providerBaseBackup
        );

        logger(`[Assets] Fetching assets for AA ${account} on card ${cardAddress}...`);

        // 3️⃣ 用 AA 地址查资产
        const [pointsBalance, nfts] = await cardContract.getOwnership(account);

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
};

const cardOwnerPrivateKey = "735e12c015a59afbfc3a9d59d0753d0b738539fa38081ea6ac647b418e8b5e51"
const test = async () => {
	await new Promise(executor => setTimeout(executor, 3000))
	// await DeployingSmartAccount('0x733f860d1C97A0edD4d87BD63BA85Abb7f275F5E')			//			0x88c99612ca7cd045177ce9273c62bd7f752cfff17780b501763365f87a31a607
	// for (let i = 0; i < Settle_ContractPool.length; i++) {
	// 	await registerPayMasterForCardFactory(Settle_ContractPool[i].walletBase.address)
	// 	await new Promise(executor => setTimeout(executor, 3000))
	// }

	//		创建 新卡
	//await initCardTest('0x733f860d1C97A0edD4d87BD63BA85Abb7f275F5E', 'CAD', 100)				//			0xfB804b423d27968336263c0CEF581Fbcd51D93B9		//		0x6068bc22e6b246f836369217e030bb2e83ebb071143dc80b0528f7b9366de07f

	//await USDC2Token(cardOwnerPrivateKey, 0.01, '0xfB804b423d27968336263c0CEF581Fbcd51D93B9')
		
	// await getMyAssets('0x733f860d1C97A0edD4d87BD63BA85Abb7f275F5E', '0xfB804b423d27968336263c0CEF581Fbcd51D93B9')

	// const rates = await getAllRate()
	// logger(inspect(rates, false, 3, true))
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

// test()