/**
 * Consumer Top-Up: burn merchant #13 from user AA, pay CONET-USDC to user EOA from card escrow.
 * Cluster precheck + Master relay via EntryPoint. HTTP waits for both receipts.
 */
import type { Response } from 'express'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import {
	CONET_CARD_FACTORY,
	CONET_MAINNET_CHAIN_ID,
} from './chainAddresses'
import {
	providerForUserCardChain,
	resolveUserCardChain,
} from './beamioUserCardChain'
import {
	checkBusinessRelayTxSuccessful,
	getBeamioUserCardFactoryGateway,
	relayUserCardCallViaEntryPoint,
} from './MemberCard'
import { shiftSettleConet, unshiftSettleConet } from './settleContractPool'
import { CHARGE_REWARD_V2_IFACE } from './userCumulativeStatRewardPool'
import { resolveBeamioAaOnConet } from './endpoint/resolveBeamioAaViaUserCardFactory'

const BURN_SEL =
	CHARGE_REWARD_V2_IFACE.getFunction('burnSocialPointsFromUserForExchange')?.selector ?? '0x00000000'
const PAY_SEL =
	CHARGE_REWARD_V2_IFACE.getFunction('payoutSocialExchangeUsdcToUser')?.selector ?? '0x00000000'

const REWARD13_IFACE = new ethers.Interface([
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function rewardEscrowUsdc6() view returns (uint256)',
	'function currency() view returns (uint8)',
	'function pointsUnitPriceInCurrencyE6() view returns (uint256)',
])

const FACTORY_QUOTE_IFACE = new ethers.Interface([
	'function quoteCurrencyAmountInUSDC6(uint8 currency, uint256 amount6) view returns (uint256)',
])

export const REDEEM_REWARD13_EIP712_TYPES: Record<string, Array<{ name: string; type: string }>> = {
	RedeemReward13ForUsdc: [
		{ name: 'card', type: 'address' },
		{ name: 'userEOA', type: 'address' },
		{ name: 'pointsCost', type: 'uint256' },
		{ name: 'usdcReward6', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

const usedNonces = new Set<string>()

export type RedeemReward13ForUsdcBody = {
	cardAddress: string
	userEOA: string
	pointsCost: string
	usdcReward6: string
	deadline: number
	nonce: string
	userSignature: string
}

type PoolItem = RedeemReward13ForUsdcBody & { res: Response }

export const redeemReward13ForUsdcPool: PoolItem[] = []

let redeemReward13InFlight = false

async function bytecodeHasSelector(provider: ethers.Provider, address: string, selector: string): Promise<boolean> {
	if (!selector || selector === '0x00000000') return false
	const code = await provider.getCode(address)
	if (!code || code === '0x') return false
	return code.toLowerCase().includes(selector.slice(2).toLowerCase())
}

function nonceKey(userEOA: string, nonce: string): string {
	return `${userEOA.toLowerCase()}:${nonce.toLowerCase()}`
}

export async function redeemReward13ForUsdcPreCheck(
	body: RedeemReward13ForUsdcBody,
): Promise<{ success: true; preChecked: RedeemReward13ForUsdcBody } | { success: false; error: string }> {
	try {
		if (!body?.cardAddress || !ethers.isAddress(body.cardAddress)) {
			return { success: false, error: 'Invalid cardAddress' }
		}
		if (!body?.userEOA || !ethers.isAddress(body.userEOA)) {
			return { success: false, error: 'Invalid userEOA' }
		}
		if (!body?.userSignature || typeof body.userSignature !== 'string') {
			return { success: false, error: 'Missing userSignature' }
		}
		const cardAddress = ethers.getAddress(body.cardAddress)
		const userEOA = ethers.getAddress(body.userEOA)
		const pointsCost = BigInt(body.pointsCost)
		const usdcReward6 = BigInt(body.usdcReward6)
		if (pointsCost <= 0n || usdcReward6 <= 0n) {
			return { success: false, error: 'pointsCost and usdcReward6 must be > 0' }
		}
		const deadline = Number(body.deadline)
		if (!Number.isFinite(deadline) || deadline < Math.floor(Date.now() / 1000) - 30) {
			return { success: false, error: 'deadline expired' }
		}
		const nonce = body.nonce
		if (typeof nonce !== 'string' || !nonce.startsWith('0x') || nonce.length !== 66) {
			return { success: false, error: 'Invalid nonce' }
		}
		const nk = nonceKey(userEOA, nonce)
		if (usedNonces.has(nk)) {
			return { success: false, error: 'nonce already used' }
		}

		const chain = await resolveUserCardChain(cardAddress)
		if (chain !== 'conet') {
			return { success: false, error: 'Merchant card must be on CoNET' }
		}
		const provider = providerForUserCardChain('conet')
		const burnOk = await bytecodeHasSelector(provider, cardAddress, BURN_SEL)
		const payOk = await bytecodeHasSelector(provider, cardAddress, PAY_SEL)
		if (!burnOk || !payOk) {
			return {
				success: false,
				error: 'This program card does not support Reward PT to USDC redemption yet',
			}
		}

		const aa = await resolveBeamioAaOnConet(userEOA)
		if (!aa || !ethers.isAddress(aa)) {
			return { success: false, error: 'Smart Wallet (AA) required to redeem Reward PT' }
		}
		const card = new ethers.Contract(cardAddress, REWARD13_IFACE, provider)
		const [bal13, escrow, currency, priceE6] = await Promise.all([
			card.balanceOf(aa, 13n) as Promise<bigint>,
			card.rewardEscrowUsdc6() as Promise<bigint>,
			card.currency() as Promise<bigint>,
			card.pointsUnitPriceInCurrencyE6() as Promise<bigint>,
		])
		if (bal13 < pointsCost) {
			return { success: false, error: 'Insufficient Reward PT (#13) on Smart Wallet' }
		}
		if (escrow < usdcReward6) {
			return { success: false, error: 'Insufficient merchant USDC escrow for this redemption' }
		}
		if (priceE6 <= 0n) {
			return { success: false, error: 'Invalid points unit price' }
		}
		const fiat6 = (pointsCost * priceE6) / 1_000_000n
		const factory = new ethers.Contract(CONET_CARD_FACTORY, FACTORY_QUOTE_IFACE, provider)
		const quotedUsdc6 = (await factory.quoteCurrencyAmountInUSDC6(Number(currency), fiat6)) as bigint
		const cap = quotedUsdc6 < escrow ? quotedUsdc6 : escrow
		if (usdcReward6 > cap) {
			return { success: false, error: 'usdcReward6 exceeds quoted or escrow cap' }
		}
		if (quotedUsdc6 > 0n) {
			const drift = usdcReward6 > quotedUsdc6 ? usdcReward6 - quotedUsdc6 : quotedUsdc6 - usdcReward6
			if (drift * 100n > quotedUsdc6 * 5n) {
				return { success: false, error: 'usdcReward6 diverges from Factory quote' }
			}
		}

		const factoryGateway = await getBeamioUserCardFactoryGateway(cardAddress)
		const domain = {
			name: 'BeamioUserCard',
			version: '1',
			chainId: CONET_MAINNET_CHAIN_ID,
			verifyingContract: factoryGateway,
		}
		const recovered = ethers.verifyTypedData(
			domain,
			REDEEM_REWARD13_EIP712_TYPES,
			{
				card: cardAddress,
				userEOA,
				pointsCost,
				usdcReward6,
				deadline: BigInt(deadline),
				nonce,
			},
			body.userSignature,
		)
		if (recovered.toLowerCase() !== userEOA.toLowerCase()) {
			return { success: false, error: 'Signature does not match userEOA' }
		}

		usedNonces.add(nk)
		return {
			success: true,
			preChecked: {
				cardAddress,
				userEOA,
				pointsCost: pointsCost.toString(),
				usdcReward6: usdcReward6.toString(),
				deadline,
				nonce,
				userSignature: body.userSignature,
			},
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		return { success: false, error: msg }
	}
}

export function kickRedeemReward13ForUsdcProcess(): void {
	if (redeemReward13InFlight) return
	void redeemReward13ForUsdcProcess()
}

async function redeemReward13ForUsdcProcess(): Promise<void> {
	if (redeemReward13InFlight) return
	const item = redeemReward13ForUsdcPool.shift()
	if (!item) return
	redeemReward13InFlight = true
	const SC = shiftSettleConet()
	try {
		if (!SC) {
			if (item.res && !item.res.headersSent) {
				item.res.status(503).json({ success: false, error: 'CoNET settle pool busy' }).end()
			}
			return
		}
		const cardAddress = ethers.getAddress(item.cardAddress)
		const userEOA = ethers.getAddress(item.userEOA)
		const pointsCost = BigInt(item.pointsCost)
		const usdcReward6 = BigInt(item.usdcReward6)
		const burnData = CHARGE_REWARD_V2_IFACE.encodeFunctionData('burnSocialPointsFromUserForExchange', [
			userEOA,
			pointsCost,
		])
		const payData = CHARGE_REWARD_V2_IFACE.encodeFunctionData('payoutSocialExchangeUsdcToUser', [
			userEOA,
			usdcReward6,
		])
		const burnTx = await relayUserCardCallViaEntryPoint({
			SC,
			chain: 'conet',
			cardAddress,
			cardCallData: burnData,
			logTag: 'redeemReward13ForUsdc:burn',
		})
		const burnReceipt = await burnTx.wait()
		const burnOk = checkBusinessRelayTxSuccessful(burnReceipt ?? undefined, { logTag: 'redeemReward13ForUsdc:burn' })
		if (!burnOk.ok) {
			throw new Error(`Reward PT burn failed: ${burnOk.reason ?? burnTx.hash}`)
		}
		const payTx = await relayUserCardCallViaEntryPoint({
			SC,
			chain: 'conet',
			cardAddress,
			cardCallData: payData,
			logTag: 'redeemReward13ForUsdc:payout',
		})
		const payReceipt = await payTx.wait()
		const payOk = checkBusinessRelayTxSuccessful(payReceipt ?? undefined, { logTag: 'redeemReward13ForUsdc:payout' })
		if (!payOk.ok) {
			throw new Error(`USDC payout failed: ${payOk.reason ?? payTx.hash}`)
		}
		logger(
			Colors.green(
				`[redeemReward13ForUsdc] ok card=${cardAddress} eoa=${userEOA} burn=${burnTx.hash} pay=${payTx.hash}`,
			),
		)
		if (item.res && !item.res.headersSent) {
			item.res.status(200).json({
				success: true,
				cardAddress,
				userEOA,
				burnHash: burnTx.hash,
				payoutHash: payTx.hash,
			}).end()
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red(`[redeemReward13ForUsdc] ${msg}`))
		if (item.res && !item.res.headersSent) {
			item.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		if (SC) unshiftSettleConet(SC)
		redeemReward13InFlight = false
		if (redeemReward13ForUsdcPool.length > 0) {
			setTimeout(() => {
				kickRedeemReward13ForUsdcProcess()
			}, 0)
		}
	}
}
