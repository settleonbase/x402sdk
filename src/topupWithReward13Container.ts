/**
 * Atomic multi-source top-up: same-store #13→#0 + peer #13→USDC(to target card) + optional cash,
 * all in one Relayer AA executeBatch (fail-closed). Cluster verifies EIP-712; Master relays only.
 */
import type { Response } from 'express'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import { CONET_BUNIT_AIRDROP_ADDRESS, CONET_MAINNET_CHAIN_ID, CONET_USDC } from './chainAddresses'
import { providerForUserCardChain, resolveUserCardChain } from './beamioUserCardChain'
import {
	checkBusinessRelayTxSuccessful,
	getBeamioUserCardFactoryGateway,
	quotePointsForUSDC_raw,
	quotePoints6FromDepositUsdc6,
	relayUserCardBatchViaEntryPoint,
	calcTopupFixedBUnitFee,
	resolveCardOwnerToEOA,
	pickBUnitFeeConsumerPreferEoaThenAa,
	getCardAaFactoryAddress,
	syncStandaloneBunitServiceFeeToIndexer,
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
	'function owner() view returns (address)',
])

const ERC20_IFACE = new ethers.Interface(['function balanceOf(address) view returns (uint256)'])

const CONET_USDC_EIP3009_IFACE = new ethers.Interface([
	'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
	'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
	'function name() view returns (string)',
])

const MINT_PROTOCOL_IFACE = new ethers.Interface([
	'function mintPointsForProtocolUsdcSettlement(address userEOA, uint256 points6)',
])

const CONET_USDC_TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, Array<{ name: string; type: string }>> = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export const TOPUP_WITH_REWARD13_CONTAINER_EIP712_TYPES: Record<
	string,
	Array<{ name: string; type: string }>
> = {
	TopupWithReward13Container: [
		{ name: 'targetCard', type: 'address' },
		{ name: 'userEOA', type: 'address' },
		{ name: 'sameStoreBurn13', type: 'uint256' },
		{ name: 'peerUsdcCredited6', type: 'uint256' },
		{ name: 'pointsFromPeerUsdc6', type: 'uint256' },
		{ name: 'minTotalPointsOut0', type: 'uint256' },
		{ name: 'peersHash', type: 'bytes32' },
		{ name: 'cashUsdc6', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
}

export type TopupPeerLeg = {
	cardAddress: string
	burn13: string
	usdcOut6: string
}

export type TopupCashAuth = {
	from: string
	to: string
	value: string
	validAfter: number | string
	validBefore: number | string
	nonce: string
	signature: string
	points6: string
}

export type TopupWithReward13ContainerBody = {
	targetCard: string
	userEOA: string
	sameStoreBurn13: string
	peerUsdcCredited6: string
	pointsFromPeerUsdc6: string
	minTotalPointsOut0: string
	deadline: number
	nonce: string
	userSignature: string
	peers: TopupPeerLeg[]
	cash?: TopupCashAuth | null
	/** Cluster-computed; Master may use for B-Unit fee path when cash present. */
	cardOwnerEOA?: string
	topupFeeBUnits?: string
}

type PoolItem = TopupWithReward13ContainerBody & { res: Response }

export const topupWithReward13ContainerPool: PoolItem[] = []

let topupContainerInFlight = false

const usedNonces = new Set<string>()

function nonceKey(userEOA: string, nonce: string): string {
	return `${userEOA.toLowerCase()}:${nonce.toLowerCase()}`
}

/**
 * Deterministic peersHash = keccak256(abi.encodePacked(card, burn13, usdcOut6, …))
 * sorted by card address. Empty peers → ZeroHash. Must match client + Cluster.
 */
export function hashTopupPeers(
	peers: Array<{ cardAddress: string; burn13: bigint; usdcOut6: bigint }>,
): string {
	if (peers.length === 0) return ethers.ZeroHash
	const sorted = peers
		.map((p) => ({
			cardAddress: ethers.getAddress(p.cardAddress),
			burn13: p.burn13,
			usdcOut6: p.usdcOut6,
		}))
		.sort((a, b) => a.cardAddress.toLowerCase().localeCompare(b.cardAddress.toLowerCase()))
	const chunks = sorted.map((p) =>
		ethers.solidityPacked(['address', 'uint256', 'uint256'], [p.cardAddress, p.burn13, p.usdcOut6]),
	)
	return ethers.keccak256(ethers.concat(chunks))
}

const TX_CATEGORY_USDC_TOPUP_BUNIT_SERVICE = ethers.keccak256(
	ethers.toUtf8Bytes('usdcTopup:bunitService'),
) as `0x${string}`

async function readUsdcLiquidity(cardAddress: string): Promise<{ escrow: bigint; tokenBal: bigint }> {
	const provider = providerForUserCardChain('conet')
	const card = new ethers.Contract(cardAddress, CARD_VIEW_IFACE, provider)
	const usdc = new ethers.Contract(CONET_USDC, ERC20_IFACE, provider)
	const [escrow, tokenBal] = await Promise.all([
		card.rewardEscrowUsdc6() as Promise<bigint>,
		usdc.balanceOf(cardAddress) as Promise<bigint>,
	])
	return { escrow, tokenBal }
}

export async function topupWithReward13ContainerPreCheck(
	body: Partial<TopupWithReward13ContainerBody>,
): Promise<
	| { success: true; preChecked: TopupWithReward13ContainerBody }
	| { success: false; error: string }
> {
	try {
		const targetCard = ethers.getAddress(String(body.targetCard ?? ''))
		const userEOA = ethers.getAddress(String(body.userEOA ?? ''))
		const sameStoreBurn13 = BigInt(String(body.sameStoreBurn13 ?? '0'))
		const peerUsdcCredited6Client = BigInt(String(body.peerUsdcCredited6 ?? '0'))
		const pointsFromPeerUsdc6Client = BigInt(String(body.pointsFromPeerUsdc6 ?? '0'))
		const minTotalPointsOut0 = BigInt(String(body.minTotalPointsOut0 ?? '0'))
		const deadline = Number(body.deadline ?? 0)
		const nonce = String(body.nonce ?? '')
		const peersRaw = Array.isArray(body.peers) ? body.peers : []

		if (!ethers.isHexString(nonce, 32)) return { success: false, error: 'Invalid nonce' }
		if (!body.userSignature || typeof body.userSignature !== 'string') {
			return { success: false, error: 'userSignature required' }
		}
		if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
			return { success: false, error: 'deadline expired' }
		}
		const nk = nonceKey(userEOA, nonce)
		if (usedNonces.has(nk)) return { success: false, error: 'nonce already used' }

		const chain = await resolveUserCardChain(targetCard)
		if (chain !== 'conet') return { success: false, error: 'Merchant card must be on CoNET' }
		const provider = providerForUserCardChain('conet')

		const aa = await resolveBeamioAaOnConet(userEOA)
		if (!aa) return { success: false, error: 'Smart Wallet (AA) required' }

		const peers: Array<{ cardAddress: string; burn13: bigint; usdcOut6: bigint }> = []
		for (const raw of peersRaw) {
			const peerCard = ethers.getAddress(String(raw?.cardAddress ?? ''))
			const burn13 = BigInt(String(raw?.burn13 ?? '0'))
			const usdcOut6 = BigInt(String(raw?.usdcOut6 ?? '0'))
			if (peerCard === targetCard) {
				return { success: false, error: 'Peer leg must not use target card' }
			}
			if (burn13 <= 0n || usdcOut6 <= 0n) {
				return { success: false, error: 'Peer leg burn13 and usdcOut6 must be > 0' }
			}
			peers.push({ cardAddress: peerCard, burn13, usdcOut6 })
		}

		let peerUsdcSum = 0n
		for (const peer of peers) {
			const peerChain = await resolveUserCardChain(peer.cardAddress)
			if (peerChain !== 'conet') {
				return { success: false, error: `Peer card must be on CoNET: ${peer.cardAddress}` }
			}
			const peerCard = new ethers.Contract(peer.cardAddress, CARD_VIEW_IFACE, provider)
			const [ratio, quoted, bal13] = await Promise.all([
				peerCard.convertReward13ToUsdcRatioE6() as Promise<bigint>,
				peerCard.quoteUsdcWithdrawForFiat6(peer.burn13) as Promise<bigint>,
				peerCard.balanceOf(aa, 13n) as Promise<bigint>,
			])
			if (ratio === 0n) {
				return { success: false, error: `Peer card Reward PT→USDC disabled: ${peer.cardAddress}` }
			}
			if (quoted === 0n) {
				return { success: false, error: `Peer oracle quote zero: ${peer.cardAddress}` }
			}
			// Fail-closed: no silent underpay — client usdcOut6 must equal on-chain quote.
			if (peer.usdcOut6 !== quoted) {
				return {
					success: false,
					error: `Peer usdcOut6 must equal quote (${quoted.toString()}) for ${peer.cardAddress}`,
				}
			}
			if (peer.burn13 > bal13) {
				return { success: false, error: `Insufficient #13 on peer ${peer.cardAddress}` }
			}
			const { escrow, tokenBal } = await readUsdcLiquidity(peer.cardAddress)
			if (escrow < peer.usdcOut6 || tokenBal < peer.usdcOut6) {
				return {
					success: false,
					error: `Insufficient USDC liquidity on peer ${peer.cardAddress} (escrow=${escrow} token=${tokenBal} need=${peer.usdcOut6})`,
				}
			}
			peerUsdcSum += peer.usdcOut6
		}

		if (peerUsdcCredited6Client !== peerUsdcSum) {
			return {
				success: false,
				error: `peerUsdcCredited6 must equal sum of peer usdcOut6 (${peerUsdcSum.toString()})`,
			}
		}

		let pointsFromPeerUsdc6 = 0n
		if (peerUsdcSum > 0n) {
			const quote = await quotePointsForUSDC_raw(targetCard, peerUsdcSum)
			pointsFromPeerUsdc6 = BigInt(quote.points6)
			if (pointsFromPeerUsdc6 <= 0n) {
				return { success: false, error: 'pointsFromPeerUsdc6 quote is zero' }
			}
			// In EIP-712 — client must sign Cluster-matching quote (no silent overwrite).
			if (pointsFromPeerUsdc6Client !== pointsFromPeerUsdc6) {
				return {
					success: false,
					error: `pointsFromPeerUsdc6 mismatch (client=${pointsFromPeerUsdc6Client.toString()}, expected=${pointsFromPeerUsdc6.toString()})`,
				}
			}
		} else if (pointsFromPeerUsdc6Client !== 0n) {
			return { success: false, error: 'pointsFromPeerUsdc6 must be 0 when no peer USDC' }
		}

		if (sameStoreBurn13 === 0n && peerUsdcSum === 0n) {
			return { success: false, error: 'Container requires same-store #13 and/or peer USDC' }
		}

		let sameStoreMinted0 = 0n
		if (sameStoreBurn13 > 0n) {
			const target = new ethers.Contract(targetCard, CARD_VIEW_IFACE, provider)
			const [price, bal13] = await Promise.all([
				target.pointsUnitPriceInCurrencyE6() as Promise<bigint>,
				target.balanceOf(aa, 13n) as Promise<bigint>,
			])
			if (price === 0n) return { success: false, error: 'Target card points unit price is zero' }
			if (sameStoreBurn13 > bal13) {
				return { success: false, error: 'Insufficient same-store #13 balance' }
			}
			sameStoreMinted0 = (sameStoreBurn13 * 1_000_000n) / price
			if (sameStoreMinted0 === 0n) {
				return { success: false, error: 'Same-store burn too small to mint #0' }
			}
		}

		const expectedMinTotal = sameStoreMinted0 + pointsFromPeerUsdc6
		if (minTotalPointsOut0 !== expectedMinTotal) {
			return {
				success: false,
				error: `minTotalPointsOut0 mismatch (client=${minTotalPointsOut0.toString()}, expected=${expectedMinTotal.toString()})`,
			}
		}

		const cashRaw = body.cash
		let cash: TopupCashAuth | null = null
		let cashUsdc6 = 0n
		if (cashRaw && typeof cashRaw === 'object') {
			const from = ethers.getAddress(String(cashRaw.from ?? ''))
			const to = ethers.getAddress(String(cashRaw.to ?? ''))
			const value = BigInt(String(cashRaw.value ?? '0'))
			const points6 = BigInt(String(cashRaw.points6 ?? '0'))
			const validAfter = Number(cashRaw.validAfter ?? 0)
			const validBefore = Number(cashRaw.validBefore ?? 0)
			const cashNonce = String(cashRaw.nonce ?? '')
			const cashSig = String(cashRaw.signature ?? '')
			if (value <= 0n) return { success: false, error: 'cash.value must be > 0' }
			if (!ethers.isHexString(cashNonce, 32)) return { success: false, error: 'Invalid cash nonce' }
			if (!cashSig) return { success: false, error: 'cash.signature required' }
			if (from.toLowerCase() !== userEOA.toLowerCase()) {
				return { success: false, error: 'cash.from must equal userEOA' }
			}
			const target = new ethers.Contract(targetCard, CARD_VIEW_IFACE, provider)
			const owner = ethers.getAddress((await target.owner()) as string)
			if (to.toLowerCase() !== owner.toLowerCase()) {
				return { success: false, error: 'cash.to must be target card owner' }
			}
			const quote = await quotePoints6FromDepositUsdc6(targetCard, value)
			const expectedPoints = quote.points6
			if (expectedPoints <= 0n) {
				return { success: false, error: 'cash.points6 quote is zero' }
			}
			// points6 is not in EIP-712; Cluster overwrites from fair-USDC quote (deposit USDC includes merchant spread).
			if (points6 > 0n && points6 !== expectedPoints) {
				logger(
					Colors.yellow(
						`[topupWithReward13Container] overwrite cash.points6 client=${points6} → ${expectedPoints} (fairUsdc6=${quote.fairUsdc6})`,
					),
				)
			}
			const usdc = new ethers.Contract(CONET_USDC, CONET_USDC_EIP3009_IFACE, provider)
			let tokenName = 'CoNET USD Coin'
			try {
				const n = (await usdc.name()) as string
				if (typeof n === 'string' && n.trim()) tokenName = n.trim()
			} catch {
				/* fallback */
			}
			const eip3009Domain = {
				name: tokenName,
				version: '1',
				chainId: CONET_MAINNET_CHAIN_ID,
				verifyingContract: ethers.getAddress(CONET_USDC),
			}
			let recovered: string
			try {
				recovered = ethers.verifyTypedData(
					eip3009Domain,
					CONET_USDC_TRANSFER_WITH_AUTHORIZATION_TYPES,
					{
						from,
						to,
						value,
						validAfter: BigInt(validAfter || 0),
						validBefore: BigInt(validBefore),
						nonce: cashNonce,
					},
					cashSig,
				)
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e)
				return { success: false, error: `Invalid cash EIP-3009 signature: ${msg}` }
			}
			if (recovered.toLowerCase() !== from.toLowerCase()) {
				return { success: false, error: 'cash EIP-3009 signer mismatch' }
			}
			const alreadyUsed = (await usdc.authorizationState(from, cashNonce)) as boolean
			if (alreadyUsed) return { success: false, error: 'cash authorization nonce already used' }

			cashUsdc6 = value
			cash = {
				from,
				to,
				value: value.toString(),
				validAfter,
				validBefore,
				nonce: cashNonce,
				signature: cashSig,
				points6: expectedPoints.toString(),
			}
		}

		const peersHash = hashTopupPeers(peers)
		const verifying = await getBeamioUserCardFactoryGateway(targetCard)
		const domain = {
			name: 'BeamioUserCard',
			version: '1',
			chainId: CONET_MAINNET_CHAIN_ID,
			verifyingContract: verifying,
		}
		const recovered = ethers.verifyTypedData(
			domain,
			TOPUP_WITH_REWARD13_CONTAINER_EIP712_TYPES,
			{
				targetCard,
				userEOA,
				sameStoreBurn13,
				peerUsdcCredited6: peerUsdcSum,
				pointsFromPeerUsdc6,
				minTotalPointsOut0,
				peersHash,
				cashUsdc6,
				deadline: BigInt(deadline),
				nonce,
			},
			body.userSignature,
		)
		if (recovered.toLowerCase() !== userEOA.toLowerCase()) {
			return { success: false, error: 'Signature does not match userEOA' }
		}

		let cardOwnerEOA: string | undefined
		let topupFeeBUnits: string | undefined
		if (cash) {
			const { feeBUnits6 } = calcTopupFixedBUnitFee()
			const target = new ethers.Contract(targetCard, CARD_VIEW_IFACE, provider)
			const owner = String(await target.owner())
			const resolveOwner = await resolveCardOwnerToEOA(provider, owner)
			if (!resolveOwner.success) {
				return { success: false, error: resolveOwner.error ?? 'Cannot resolve card owner to EOA' }
			}
			cardOwnerEOA = resolveOwner.cardOwner
			const aaFactoryAddr = await getCardAaFactoryAddress(targetCard)
			const picked = await pickBUnitFeeConsumerPreferEoaThenAa(cardOwnerEOA, feeBUnits6, {
				aaFactoryAddress: aaFactoryAddr,
			})
			if (!picked.ok) {
				return { success: false, error: `Insufficient B-Units for topup (${picked.error})` }
			}
			topupFeeBUnits = feeBUnits6.toString()
		}

		usedNonces.add(nk)

		return {
			success: true,
			preChecked: {
				targetCard,
				userEOA,
				sameStoreBurn13: sameStoreBurn13.toString(),
				peerUsdcCredited6: peerUsdcSum.toString(),
				pointsFromPeerUsdc6: pointsFromPeerUsdc6.toString(),
				minTotalPointsOut0: minTotalPointsOut0.toString(),
				deadline,
				nonce,
				userSignature: body.userSignature,
				peers: peers.map((p) => ({
					cardAddress: p.cardAddress,
					burn13: p.burn13.toString(),
					usdcOut6: p.usdcOut6.toString(),
				})),
				cash,
				cardOwnerEOA,
				topupFeeBUnits,
			},
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		return { success: false, error: msg }
	}
}

export function kickTopupWithReward13ContainerProcess(): void {
	if (topupContainerInFlight) return
	void topupWithReward13ContainerProcess()
}

async function topupWithReward13ContainerProcess(): Promise<void> {
	if (topupContainerInFlight) return
	const item = topupWithReward13ContainerPool.shift()
	if (!item) return
	topupContainerInFlight = true
	const SC = shiftSettleConet()
	try {
		if (!SC) {
			if (item.res && !item.res.headersSent) {
				item.res.status(503).json({ success: false, error: 'CoNET settle pool busy' }).end()
			}
			return
		}
		const targetCard = ethers.getAddress(item.targetCard)
		const userEOA = ethers.getAddress(item.userEOA)
		const sameStoreBurn13 = BigInt(item.sameStoreBurn13)
		const peerUsdcCredited6 = BigInt(item.peerUsdcCredited6)
		const pointsFromPeerUsdc6 = BigInt(item.pointsFromPeerUsdc6)
		const minTotalPointsOut0 = BigInt(item.minTotalPointsOut0)
		const deadline = BigInt(item.deadline)
		const nonce = item.nonce

		const dest: string[] = []
		const value: bigint[] = []
		const func: string[] = []

		for (const peer of item.peers ?? []) {
			const peerCard = ethers.getAddress(peer.cardAddress)
			dest.push(peerCard)
			value.push(0n)
			func.push(
				CHARGE_REWARD_V2_IFACE.encodeFunctionData('peerRedeem13ForContainerTopup', [
					userEOA,
					BigInt(peer.burn13),
					BigInt(peer.usdcOut6),
					targetCard,
				]),
			)
		}

		dest.push(targetCard)
		value.push(0n)
		func.push(
			CHARGE_REWARD_V2_IFACE.encodeFunctionData('topupWithReward13Container', [
				userEOA,
				sameStoreBurn13,
				peerUsdcCredited6,
				pointsFromPeerUsdc6,
				minTotalPointsOut0,
				deadline,
				nonce,
			]),
		)

		if (item.cash) {
			const cash = item.cash
			const cashValue = BigInt(cash.value)
			const cashPoints = BigInt(cash.points6)
			dest.push(ethers.getAddress(CONET_USDC))
			value.push(0n)
			func.push(
				CONET_USDC_EIP3009_IFACE.encodeFunctionData('transferWithAuthorization', [
					ethers.getAddress(cash.from),
					ethers.getAddress(cash.to),
					cashValue,
					BigInt(cash.validAfter || 0),
					BigInt(cash.validBefore),
					cash.nonce,
					cash.signature,
				]),
			)
			dest.push(targetCard)
			value.push(0n)
			func.push(
				MINT_PROTOCOL_IFACE.encodeFunctionData('mintPointsForProtocolUsdcSettlement', [
					userEOA,
					cashPoints,
				]),
			)
		}

		const tx = await relayUserCardBatchViaEntryPoint({
			SC,
			chain: 'conet',
			cardAddressForFactory: targetCard,
			dest,
			value,
			func,
			logTag: 'topupWithReward13Container',
		})
		const receipt = await tx.wait()
		const ok = checkBusinessRelayTxSuccessful(receipt ?? undefined, {
			logTag: 'topupWithReward13Container',
		})
		if (!ok.ok) {
			throw new Error(`topupWithReward13Container failed: ${ok.reason ?? tx.hash}`)
		}
		logger(
			Colors.green(
				`[topupWithReward13Container] ok target=${targetCard} eoa=${userEOA} peers=${item.peers?.length ?? 0} cash=${item.cash ? 'yes' : 'no'} hash=${tx.hash}`,
			),
		)
		if (item.res && !item.res.headersSent) {
			item.res
				.status(200)
				.json({
					success: true,
					targetCard,
					userEOA,
					sameStoreBurn13: sameStoreBurn13.toString(),
					peerUsdcCredited6: peerUsdcCredited6.toString(),
					pointsFromPeerUsdc6: pointsFromPeerUsdc6.toString(),
					hash: tx.hash,
				})
				.end()
		}

		// B-Unit fee after HTTP 200 (cash leg only); hold settle SC until consume finishes.
		if (item.cash && item.topupFeeBUnits && item.cardOwnerEOA && SC) {
			const feeBUnits6 = BigInt(item.topupFeeBUnits)
			const cardOwnerEOA = ethers.getAddress(item.cardOwnerEOA)
			try {
				let consumer = cardOwnerEOA
				try {
					const aaFac = await getCardAaFactoryAddress(targetCard)
					const picked = await pickBUnitFeeConsumerPreferEoaThenAa(cardOwnerEOA, feeBUnits6, {
						aaFactoryAddress: aaFac,
					})
					if (picked.ok) consumer = picked.consumer
				} catch (pickErr: unknown) {
					const m = pickErr instanceof Error ? pickErr.message : String(pickErr)
					logger(Colors.yellow(`[topupWithReward13Container] B-Unit pick error: ${m}`))
				}
				const bunit = new ethers.Contract(
					CONET_BUNIT_AIRDROP_ADDRESS,
					['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'],
					SC.walletConet,
				)
				const gasUsed = receipt?.gasUsed ?? 0n
				const consumeTx = await bunit.consumeFromUser(
					consumer,
					feeBUnits6,
					tx.hash as `0x${string}`,
					gasUsed,
					2n,
					{ gasLimit: 2_500_000 },
				)
				await consumeTx.wait()
				logger(
					Colors.cyan(
						`[topupWithReward13Container] consumeFromUser ok: ${Number(feeBUnits6) / 1e6} B-Units from ${consumer}`,
					),
				)
				await syncStandaloneBunitServiceFeeToIndexer({
					walletConet: SC.walletConet,
					BeamioTaskDiamondAction: SC.BeamioTaskDiamondAction,
					consumeTxHash: consumeTx.hash,
					basePaymentHash: tx.hash,
					cardAddress: targetCard,
					feePayer: consumer,
					bServiceUnits6: feeBUnits6,
					txCategory: TX_CATEGORY_USDC_TOPUP_BUNIT_SERVICE,
					title: 'USDC top-up B-Unit service fee',
					source: 'topupWithReward13ContainerBUnit',
					operator: ethers.ZeroAddress,
					operatorParentChain: [],
					topAdmin: ethers.ZeroAddress,
					subordinate: ethers.ZeroAddress,
				})
			} catch (e: unknown) {
				const m = e instanceof Error ? e.message : String(e)
				logger(Colors.red(`[topupWithReward13Container] B-Unit background failed (non-fatal): ${m}`))
			}
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red(`[topupWithReward13Container] ${msg}`))
		if (item.res && !item.res.headersSent) {
			item.res.status(400).json({ success: false, error: msg }).end()
		}
	} finally {
		if (SC) unshiftSettleConet(SC)
		topupContainerInFlight = false
		if (topupWithReward13ContainerPool.length > 0) {
			setTimeout(() => {
				kickTopupWithReward13ContainerProcess()
			}, 0)
		}
	}
}
