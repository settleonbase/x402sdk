import { masterSetup} from '../util'
import {ethers} from 'ethers'
import { logger } from '../logger'
import Colors from 'colors/safe'
import {inspect} from 'node:util'
import SeamioOracle_ABI from '../ABI/SeamioOracleABI.json'

const CoinMarketCap = require('coinmarketcap-api')
interface quote {
	USD: {
		price: number
		volume_24h: number
		volume_change_24h: number
		percent_change_1h: number
		percent_change_24h: number
		percent_change_7d: number
		percent_change_30d: number
		percent_change_60d: number
		percent_change_90d: number
		market_cap: number
		market_cap_dominance: number
		fully_diluted_market_cap: number
		tvl: null
		last_updated: string
	}
}

/** GuardianOracle 所在 L1：CoNET */
const providerConet = new ethers.JsonRpcProvider('https://mainnet-rpc.conet.network')
/** BeamioOracle 所在 L1；与 CoNET 不同链，故可并行喂价且无 nonce 冲突 */
const providerBaseBackup = new ethers.JsonRpcProvider('https://1rpc.io/base')



const apiKey = masterSetup.CoinMarketCapAPIKey
const oracleSC_addr = '0xe5dA73e4c714afA3D1cCdb3392A4867cBc117629'
const managerWallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], providerConet)
const beamioWallet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], providerBaseBackup)
const beamioWalletConet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], providerConet)
const oracleSC = new ethers.Contract(oracleSC_addr, SeamioOracle_ABI, managerWallet)
const client = new CoinMarketCap(apiKey)
///							1 Credits
///		ids BNB: 1839, Dai: 4943, ETH: 1027, USDC: 3408, USDT: 825 TRX:1958
const testData = [ 'eth', 'usdt', 'usdc', 'dai', 'bnb'  ]
const testData1 = [

  2521.798130399146,
  1.000081714873474,
  0.9999341810909045,
  0.9998955107583655,
  537.1435821764862
]

logger(`admin wallet ${managerWallet.address} | GuardianOracle CoNET | BeamioOracle L1 ${providerBaseBackup}`)

const beamioOracleBaseAddr = process.env.BASE_BEAMIO_ORACLE_ADDRESS || '0xDa4AE8301262BdAaf1bb68EC91259E6C512A9A2B'
const beamioOracleConetAddr = process.env.CONET_BEAMIO_ORACLE_ADDRESS || '0x06a1e0D55B4db57Aa906Eff332902F5CA7a25dd4'
const beamioOracleBase = new ethers.Contract(beamioOracleBaseAddr, SeamioOracle_ABI, beamioWallet)
const beamioOracleConet = new ethers.Contract(beamioOracleConetAddr, SeamioOracle_ABI, beamioWalletConet)

/** BeamioCurrency.CurrencyType 对应索引: CAD=0, USD=1, JPY=2, CNY=3, USDC=4, HKD=5, EUR=6, SGD=7, TWD=8 */

const CURRENCY_IDS = { CAD: 0, USD: 1, JPY: 2, CNY: 3, USDC: 4, HKD: 5, EUR: 6, SGD: 7, TWD: 8 } as const;

/**
 * 将数据喂给 BeamioOracle，覆盖 CurrencyType 全部 9 种货币。
 * fx: Coinbase 返回的 1 USD = X 外币；Oracle 存储 1 外币 = ? USD，故法币用 1/rate。
 * USDC 来自 CMC；USD 恒为 1。
 */
const updateBeamioOracleOnChain = async (
	label: 'base' | 'conet',
	oracleContract: ethers.Contract,
	provider: ethers.JsonRpcProvider,
	ids: number[],
	rates: bigint[]
) => {
	const feeData = await provider.getFeeData();
	const gasPrice = feeData.gasPrice ? (feeData.gasPrice * 120n / 100n) : undefined;
	logger(Colors.cyan(`Sending Batch TX to BeamioOracle (${label})...`));
	const tx = await oracleContract.updateRatesBatch(ids, rates, { gasPrice });
	logger(Colors.yellow(`[${label}] Batch TX sent: ${tx.hash}`));
	const receipt = await tx.wait();
	if (receipt.status === 1) {
		logger(Colors.green(`✅ [${label}] BeamioOracle batch update successful in block ${receipt.blockNumber}!`));
	} else {
		throw new Error(`[${label}] transaction reverted by network`);
	}
}

const updateBeamioOracle = async (fx: any, cmcQuotes: any) => {
    try {
        const usdcPrice = Number(cmcQuotes.data['3408'].quote.USD.price);
        
        // 1. USDC 脱锚检测逻辑
        if (Math.abs(usdcPrice - 1) > 0.05) {
            logger(Colors.yellow(`⚠️ WARNING: USDC de-peg detected! Current Price: ${usdcPrice}`));
        }

        const ratesData = [
            { id: CURRENCY_IDS.CAD, symbol: 'CAD', rateUsd: 1 / fx.USDCAD },
            { id: CURRENCY_IDS.USD, symbol: 'USD', rateUsd: 1 },
            { id: CURRENCY_IDS.JPY, symbol: 'JPY', rateUsd: 1 / fx.USDJPY },
            { id: CURRENCY_IDS.CNY, symbol: 'CNY', rateUsd: 1 / fx.USDCNY },
            { id: CURRENCY_IDS.USDC, symbol: 'USDC', rateUsd: usdcPrice },
            { id: CURRENCY_IDS.HKD, symbol: 'HKD', rateUsd: 1 / fx.USDHKD },
            { id: CURRENCY_IDS.EUR, symbol: 'EUR', rateUsd: 1 / fx.USDEUR },
            { id: CURRENCY_IDS.SGD, symbol: 'SGD', rateUsd: 1 / fx.USDSGD },
            { id: CURRENCY_IDS.TWD, symbol: 'TWD', rateUsd: 1 / fx.USDTWD },
        ];

        // 2. 准备批量更新所需的数组
        const ids: number[] = [];
        const rates: bigint[] = [];

        logger(Colors.cyan(`Preparing batch update for ${ratesData.length} currencies...`));
        
        for (const r of ratesData) {
            ids.push(r.id);
            // 转换为 E18 精度
            const rateE18 = ethers.parseUnits(r.rateUsd.toFixed(18), 18);
            rates.push(rateE18);
            
            logger(`  - ${r.symbol}: 1 ${r.symbol} = ${r.rateUsd.toFixed(6)} USD`);
        }

		await Promise.all([
			updateBeamioOracleOnChain('base', beamioOracleBase, providerBaseBackup, ids, rates),
			updateBeamioOracleOnChain('conet', beamioOracleConet, providerConet, ids, rates),
		]);

    } catch (ex) {
        logger(Colors.red(`❌ updateBeamioOracle Error!`), ex);
        // 如果是特定错误，可以在此增加重试逻辑
    }
}

const linten = 1000 * 60 * 10
const updateOracle = async (tokenNames: string[], price: number[]) => {
	const priceArray = price.map(n => ethers.parseEther(n.toString()))

	logger(inspect(tokenNames, false, 3, true))
	logger(inspect(price, false, 3, true))
	logger(inspect(priceArray, false, 3, true))
	try {
		const tx = await oracleSC.updatePrice(tokenNames, priceArray)
		logger(`Write to Smart Contract success! ${tx.hash}`)
		const ts = await tx.wait()
		
		return ts
	} catch (ex) {
		logger(Colors.magenta(`updateOracle Error!`), ex)
		return false
	}
}

const getIDs = () => {
	return client.getIdMap({symbol: ['BNB', 'DAI', 'ETH', 'USDT', 'USDC', 'TRX']}).then((data: any) => {
		logger(inspect(data, false, 3, true))
	})
}

const getUsdFxFromCoinbase = async () => {
	const res = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD')
	if (!res.ok) throw new Error(`coinbase fx failed: ${res.status}`)

	const json: any = await res.json()
	const rates = json?.data?.rates || {}

	const cad = Number(rates.CAD)
	const jpy = Number(rates.JPY)
	const cny = Number(rates.CNY) // 人民币 ISO = CNY
	const hkd = Number(rates.HKD) // 港元 ISO = HKD
	const eur = Number(rates.EUR) // 欧元 ISO = EUR
	const sgd = Number(rates.SGD) // 新加坡元 ISO = SGD
	const twd = Number(rates.TWD) // 新台币 ISO = TWD

	if (!cad || !jpy || !cny || !hkd || !eur || !sgd || !twd) {
		throw new Error('missing CAD/JPY/CNY/HKD/EUR/SGD/TWD in coinbase rates')
	}

	return {
		USDCAD: cad,
		USDJPY: jpy,
		USDCNY: cny,
		USDHKD: hkd,
		USDEUR: eur,
		USDSGD: sgd,
		USDTWD: twd
	}
}

const runTick = async () => {
    try {
        const [cmc, fx] = await Promise.all([
        client.getQuotes({ id: [1839, 4943, 1027, 825, 3408, 1958] }),
        getUsdFxFromCoinbase()
        ])

        const usdt = cmc.data['825'].quote
        const eth = cmc.data['1027'].quote
        const usdc = cmc.data['3408'].quote
        const dai = cmc.data['4943'].quote
        const bnb = cmc.data['1839'].quote
        const tron = cmc.data['1958'].quote

        const tokenNames = ['eth', 'usdt', 'usdc', 'dai', 'bnb', 'trx', 'usd-cad', 'usd-jpy', 'usd-cny', 'usd-hkd', 'usd-eur', 'usd-sgd', 'usd-twd']
        const price = [
            eth.USD.price,
            usdt.USD.price,
            usdc.USD.price,
            dai.USD.price,
            bnb.USD.price,
            tron.USD.price,
            fx.USDCAD,
            fx.USDJPY,
            fx.USDCNY,
            fx.USDHKD,
            fx.USDEUR,
            fx.USDSGD,
            fx.USDTWD
        ]

		await Promise.all([
			// updateOracle(tokenNames, price),
			updateBeamioOracle(fx, cmc)
		])

        
    } finally {
        setTimeout(runTick, linten)
    }
}
// getIDs()
runTick()

// logger(managerWallet.address)
