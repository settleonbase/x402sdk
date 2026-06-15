import { masterSetup, resolveBeamioBaseHttpRpcUrl, resolveBeamioConetHttpRpcUrl } from '../util'
import { ethers } from 'ethers'
import { logger } from '../logger'
import Colors from 'colors/safe'
import SeamioOracle_ABI from '../ABI/SeamioOracleABI.json'
import { BEAMIO_ORACLE } from '../chainAddresses'

const CoinMarketCap = require('coinmarketcap-api')

/** CoNET PoS（chainId 224422）；与 deployments/conet-addresses.json `rpcUrl` 一致 */
const CONET_RPC = resolveBeamioConetHttpRpcUrl()
/** Base 主网；与 beamio-base-rpc.mdc 一致 */
const BASE_RPC = resolveBeamioBaseHttpRpcUrl()

const providerConet = new ethers.JsonRpcProvider(CONET_RPC)
const providerBase = new ethers.JsonRpcProvider(BASE_RPC)

const apiKey = masterSetup.CoinMarketCapAPIKey
const beamioWalletBase = new ethers.Wallet(masterSetup.settle_contractAdmin[0], providerBase)
const beamioWalletConet = new ethers.Wallet(masterSetup.settle_contractAdmin[0], providerConet)

const client = new CoinMarketCap(apiKey)

/** 跨链同址 BeamioOracle（Nick CREATE2）；BEAMIO_ORACLE_ADDRESS 可覆盖 */
const beamioOracleAddr =
	process.env.BEAMIO_ORACLE_ADDRESS?.trim() ||
	process.env.BASE_BEAMIO_ORACLE_ADDRESS?.trim() ||
	process.env.CONET_BEAMIO_ORACLE_ADDRESS?.trim() ||
	BEAMIO_ORACLE

const beamioOracleBase = new ethers.Contract(beamioOracleAddr, SeamioOracle_ABI, beamioWalletBase)
const beamioOracleConet = new ethers.Contract(beamioOracleAddr, SeamioOracle_ABI, beamioWalletConet)

logger(
	`GuardianOracle admin ${beamioWalletConet.address} | BeamioOracle ${beamioOracleAddr} | CoNET ${CONET_RPC} | Base ${BASE_RPC}`
)

/** BeamioCurrency.CurrencyType: CAD=0, USD=1, JPY=2, CNY=3, USDC=4, HKD=5, EUR=6, SGD=7, TWD=8, ETH=9, BNB=10... */

const CURRENCY_IDS = { CAD: 0, USD: 1, JPY: 2, CNY: 3, USDC: 4, HKD: 5, EUR: 6, SGD: 7, TWD: 8, ETH: 9 } as const

/**
 * 将数据喂给 BeamioOracle（Base + CoNET 双链，同址合约）。
 * fx: Coinbase 返回的 1 USD = X 外币；Oracle 存储 1 外币 = ? USD，故法币用 1/rate。
 * USDC、ETH 来自 CMC；USD 恒为 1。ETH 用于 convertGasWeiToUSDC6（gas 换算）。
 */
const updateBeamioOracleOnChain = async (
	label: 'base' | 'conet',
	oracleContract: ethers.Contract,
	provider: ethers.JsonRpcProvider,
	ids: number[],
	rates: bigint[]
) => {
	try {
		const feeData = await provider.getFeeData()
		const gasPrice = feeData.gasPrice ? (feeData.gasPrice * 120n) / 100n : undefined
		logger(Colors.cyan(`Sending Batch TX to BeamioOracle (${label})...`))
		const tx = await oracleContract.updateRatesBatch(ids, rates, { gasPrice })
		logger(Colors.yellow(`[${label}] Batch TX sent: ${tx.hash}`))
		const receipt = await tx.wait()
		if (receipt.status === 1) {
			logger(Colors.green(`✅ [${label}] BeamioOracle batch update successful in block ${receipt.blockNumber}!`))
		} else {
			throw new Error(`[${label}] transaction reverted by network`)
		}
	} catch (ex) {
		logger(Colors.red(`❌ [${label}] updateBeamioOracle Error!`), ex)
	}
}

const updateBeamioOracle = async (fx: any, cmcQuotes: any) => {
	try {
		const usdcPrice = Number(cmcQuotes.data['3408'].quote.USD.price)

		if (Math.abs(usdcPrice - 1) > 0.05) {
			logger(Colors.yellow(`⚠️ WARNING: USDC de-peg detected! Current Price: ${usdcPrice}`))
		}

		const ethPrice = Number(cmcQuotes.data['1027']?.quote?.USD?.price ?? 0)
		if (ethPrice <= 0) {
			logger(Colors.yellow('⚠️ WARNING: ETH price missing from CMC, skipping ETH feed'))
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
			...(ethPrice > 0 ? [{ id: CURRENCY_IDS.ETH, symbol: 'ETH', rateUsd: ethPrice }] : []),
		]

		const ids: number[] = []
		const rates: bigint[] = []

		logger(Colors.cyan(`Preparing batch update for ${ratesData.length} currencies...`))

		for (const r of ratesData) {
			ids.push(r.id)
			const rateE18 = ethers.parseUnits(r.rateUsd.toFixed(18), 18)
			rates.push(rateE18)
			logger(`  - ${r.symbol}: 1 ${r.symbol} = ${r.rateUsd.toFixed(6)} USD`)
		}

		await Promise.all([
			updateBeamioOracleOnChain('base', beamioOracleBase, providerBase, ids, rates),
			updateBeamioOracleOnChain('conet', beamioOracleConet, providerConet, ids, rates),
		])
	} catch (ex) {
		logger(Colors.red(`❌ updateBeamioOracle prepare Error!`), ex)
	}
}

const TICK_INTERVAL_MS = 1000 * 60 * 10

const getUsdFxFromCoinbase = async () => {
	const res = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD')
	if (!res.ok) throw new Error(`coinbase fx failed: ${res.status}`)

	const json: any = await res.json()
	const rates = json?.data?.rates || {}

	const cad = Number(rates.CAD)
	const jpy = Number(rates.JPY)
	const cny = Number(rates.CNY)
	const hkd = Number(rates.HKD)
	const eur = Number(rates.EUR)
	const sgd = Number(rates.SGD)
	const twd = Number(rates.TWD)

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
		USDTWD: twd,
	}
}

const runTick = async () => {
	try {
		const [cmc, fx] = await Promise.all([
			client.getQuotes({ id: [1839, 4943, 1027, 825, 3408, 1958] }),
			getUsdFxFromCoinbase(),
		])

		await updateBeamioOracle(fx, cmc)
	} catch (ex) {
		logger(Colors.red('❌ GuardianOracle tick failed'), ex)
	} finally {
		setTimeout(runTick, TICK_INTERVAL_MS)
	}
}

runTick()
