/**
 * Charge path: atomic #13 → #0 (same-store credit) or #13 → Conet-USDC to user AA.
 * Same-store #13 → #0 does not require USDC escrow or convertReward13ToPointsRatioE6.
 * Distinct from redeemReward13ForUsdc (pays EOA via two-step social exchange).
 * Cluster precheck + Master single-selector EntryPoint relay; HTTP waits for receipt.
 */
import type { Response } from 'express'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import { CONET_MAINNET_CHAIN_ID } from './chainAddresses'
import { providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'
import {
	checkBusinessRelayTxSuccessful,
	getBeamioUserCardFactoryGateway,
	relayUserCardCallViaEntryPoint,
} from './MemberCard'
import { shiftSettleConet, unshiftSettleConet } from './settleContractPool'
import { CHARGE_REWARD_V2_IFACE } from './userCumulativeStatRewardPool'
import { resolveBeamioAaOnConet } from './endpoint/resolveBeamioAaViaUserCardFactory'

const CARD_VIEW_IFACE = new ethers.Interface([
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function rewardEscrowUsdc6() view returns (uint256)',
	'function convertReward13ToUsdcRatioE6() view returns (uint256)',
	'function quoteUsdcWithdrawForFiat6(uint256 fiatAmount6) view returns (uint256)',
	'function pointsUnitPriceInCurrencyE6() view returns (uint256)',
])

export type ConvertReward13Kind = 'toProgramPoints' | 'toUsdcAa'

export const CONVERT_REWARD13_EIP712_TYPES: Record<string, Array<{ name: string; type: string }>> = {
	ConvertReward13: [
		{ name: 'card', type: 'address' },
		{ name: 'userEOA', type: 'address' },
		{ name: 'kind', type: 'uint8' }, // 1 = toProgramPoints, 2 = toUsdcAa
		{ name: 'burn13', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

const KIND_TO_POINTS = 1
const KIND_TO_USDC = 2

const usedNonces = new Set<string>()

export type ConvertReward13Body = {
	cardAddress: string
	userEOA: string
	burn13: string
	deadline: number
	nonce: string
	userSignature: string
	kind: ConvertReward13Kind
}

type PoolItem = ConvertReward13Body & { res: Response }

export const convertReward13ToProgramPointsPool: PoolItem[] = []
export const convertReward13ToUsdcToAaPool: PoolItem[] = []

let convertReward13InFlight = false

function nonceKey(userEOA: string, nonce: string): string {
	return `${userEOA.toLowerCase()}:${nonce.toLowerCase()}`
}

function kindCode(kind: ConvertReward13Kind): number {
	return kind === 'toUsdcAa' ? KIND_TO_USDC : KIND_TO_POINTS
}

export async function convertReward13PreCheck(
	body: Partial<ConvertReward13Body> & { kind: ConvertReward13Kind },
): Promise<
	| { success: true; preChecked: ConvertReward13Body }
	| { success: false; error: string }
> {
	try {
		const cardAddress = ethers.getAddress(String(body.cardAddress ?? ''))
		const userEOA = ethers.getAddress(String(body.userEOA ?? ''))
		const burn13 = BigInt(String(body.burn13 ?? '0'))
		const deadline = Number(body.deadline ?? 0)
		const nonce = String(body.nonce ?? '')
		const kind = body.kind
		if (!ethers.isHexString(nonce, 32)) return { success: false, error: 'Invalid nonce' }
		if (!body.userSignature || typeof body.userSignature !== 'string') {
			return { success: false, error: 'userSignature required' }
		}
		if (burn13 <= 0n) return { success: false, error: 'burn13 must be > 0' }
		if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
			return { success: false, error: 'deadline expired' }
		}
		const nk = nonceKey(userEOA, nonce)
		if (usedNonces.has(nk)) return { success: false, error: 'nonce already used' }

		const chain = await resolveUserCardChain(cardAddress)
		if (chain !== 'conet') return { success: false, error: 'Merchant card must be on CoNET' }
		const provider = providerForUserCardChain('conet')

		const aa = await resolveBeamioAaOnConet(userEOA)
		if (!aa) return { success: false, error: 'User AA not found' }

		const card = new ethers.Contract(cardAddress, CARD_VIEW_IFACE, provider)
		const bal13 = (await card.balanceOf(aa, 13n)) as bigint
		if (burn13 > bal13) {
			return { success: false, error: `Insufficient #13 balance (have ${bal13}, need ${burn13})` }
		}

		if (kind === 'toProgramPoints') {
			// Same-store #13 → #0 credit: no USDC escrow and no ratio switch.
			const price = (await card.pointsUnitPriceInCurrencyE6()) as bigint
			if (price <= 0n) return { success: false, error: 'pointsUnitPriceInCurrencyE6 is zero' }
			const minted0 = (burn13 * 1_000_000n) / price
			if (minted0 <= 0n) return { success: false, error: 'Conversion would mint zero #0' }
		} else {
			const ratio = (await card.convertReward13ToUsdcRatioE6()) as bigint
			if (ratio <= 0n) return { success: false, error: '#13 → USDC conversion is disabled' }
			const [usdcOut6, escrow] = await Promise.all([
				card.quoteUsdcWithdrawForFiat6(burn13) as Promise<bigint>,
				card.rewardEscrowUsdc6() as Promise<bigint>,
			])
			if (usdcOut6 <= 0n) return { success: false, error: 'Oracle quote for USDC out is zero' }
			if (usdcOut6 > escrow) {
				return {
					success: false,
					error: `Insufficient merchant USDC escrow (need ${usdcOut6}, have ${escrow})`,
				}
			}
			// Fail-closed: ERC20 balance on the card must also cover the payout (not escrow alone).
			const { CONET_USDC } = await import('./chainAddresses.js')
			const erc20 = new ethers.Contract(
				CONET_USDC,
				['function balanceOf(address) view returns (uint256)'],
				provider,
			)
			const tokenBal = (await erc20.balanceOf(cardAddress)) as bigint
			if (usdcOut6 > tokenBal) {
				return {
					success: false,
					error: `Insufficient merchant CONET-USDC balance (need ${usdcOut6}, have ${tokenBal})`,
				}
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
			CONVERT_REWARD13_EIP712_TYPES,
			{
				card: cardAddress,
				userEOA,
				kind: kindCode(kind),
				burn13,
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
				burn13: burn13.toString(),
				deadline,
				nonce,
				userSignature: body.userSignature,
				kind,
			},
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		return { success: false, error: msg }
	}
}

export function kickConvertReward13Process(): void {
	if (convertReward13InFlight) return
	void convertReward13Process()
}

async function convertReward13Process(): Promise<void> {
	if (convertReward13InFlight) return
	const item = convertReward13ToProgramPointsPool.shift() ?? convertReward13ToUsdcToAaPool.shift()
	if (!item) return
	convertReward13InFlight = true
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
		const burn13 = BigInt(item.burn13)
		const fn =
			item.kind === 'toUsdcAa' ? 'convertReward13ToUsdcToAa' : 'convertReward13ToProgramPoints'
		const cardCallData = CHARGE_REWARD_V2_IFACE.encodeFunctionData(fn, [userEOA, burn13])
		const tx = await relayUserCardCallViaEntryPoint({
			SC,
			chain: 'conet',
			cardAddress,
			cardCallData,
			logTag: `convertReward13:${item.kind}`,
		})
		const receipt = await tx.wait()
		const ok = checkBusinessRelayTxSuccessful(receipt ?? undefined, {
			logTag: `convertReward13:${item.kind}`,
		})
		if (!ok.ok) {
			throw new Error(`convertReward13 failed: ${ok.reason ?? tx.hash}`)
		}
		logger(
			Colors.green(
				`[convertReward13] ok kind=${item.kind} card=${cardAddress} eoa=${userEOA} hash=${tx.hash}`,
			),
		)
		if (item.res && !item.res.headersSent) {
			item.res
				.status(200)
				.json({
					success: true,
					kind: item.kind,
					cardAddress,
					userEOA,
					burn13: burn13.toString(),
					hash: tx.hash,
				})
				.end()
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red(`[convertReward13] ${msg}`))
		if (item.res && !item.res.headersSent) {
			item.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		if (SC) unshiftSettleConet(SC)
		convertReward13InFlight = false
		if (convertReward13ToProgramPointsPool.length > 0 || convertReward13ToUsdcToAaPool.length > 0) {
			setTimeout(() => {
				kickConvertReward13Process()
			}, 0)
		}
	}
}
