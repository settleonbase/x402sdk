/**
 * Master：gatewayInvokeCard 队列（#13 奖励池 / 累计统计 gateway-only 写路径）。
 */
import type { Response } from 'express'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import { resolveUserCardChain, providerForUserCardChain, type BeamioUserCardChainKey } from './beamioUserCardChain'
import { getBeamioUserCardFactoryGateway, relayUserCardFactoryCallViaEntryPoint, relayUserCardCallViaEntryPoint, Settle_ContractPool } from './MemberCard'
import {
	CHARGE_REWARD_V2_IFACE,
	buildInitializeCardUserCumulativeStatCalldata,
	encodeGatewayInvokeCardFactoryCalldata,
	readCardUserCumulativeStatStatus,
} from './userCumulativeStatRewardPool'
import {
	insertCardProgramShareClick,
	removeCardProgramLike,
	upsertCardProgramLike,
} from './cardProgramSocialDb'

const FACTORY_GATEWAY_IFACE = new ethers.Interface([
	'function gatewayInvokeCard(address cardAddr, bytes data) returns (bytes)',
])

export const GATEWAY_INVOKE_CARD_SELECTOR =
	FACTORY_GATEWAY_IFACE.getFunction('gatewayInvokeCard')?.selector ?? '0x0a76307f'

export type CardProgramSocialDbMeta =
	| {
			kind: 'like'
			userEOA: string
			targetKind: number
			issuedParentId: string
	  }
	| {
			kind: 'unlike'
			userEOA: string
			targetKind: number
			issuedParentId: string
	  }
	| {
			kind: 'shareClick'
			actorEOA: string
			referrerEOA?: string | null
			targetKind: number
			issuedParentId: string
	  }

export type CardGatewayRewardPoolTask = {
	cardAddress: string
	/** Legacy gatewayInvokeCard(factory, card, data). */
	factoryCallData?: string
	/** Plan A: direct card calldata via relayer AA execute(card, 0, data). */
	cardCallData?: string
	/** Optional follow-up direct card calls in the same worker (e.g. USER_CLICK then REF_CLICK). */
	extraCardCallData?: string[]
	label: string
	/** 仅 gateway 初始化 cumulative stat tokens，无需卡主 owner 签名。 */
	initOnly?: boolean
	/** 链上 tx 成功后写入 beamio_card_program_*（不做历史回填）。 */
	socialDb?: CardProgramSocialDbMeta
	res?: Response
}

export const cardGatewayRewardPool: CardGatewayRewardPoolTask[] = []

let gatewayPoolPressRunning = false

export async function factorySupportsGatewayInvokeCard(
	factoryAddress: string,
	chain: BeamioUserCardChainKey = 'conet',
): Promise<boolean> {
	if (chain !== 'conet') return false
	try {
		const provider = providerForUserCardChain(chain)
		const code = await provider.getCode(factoryAddress)
		if (!code || code === '0x') return false
		const selector = GATEWAY_INVOKE_CARD_SELECTOR.slice(2).toLowerCase()
		return code.toLowerCase().includes(selector)
	} catch {
		return false
	}
}

export function kickCardGatewayRewardPoolPress(): void {
	if (gatewayPoolPressRunning) return
	gatewayPoolPressRunning = true
	void cardGatewayRewardPoolPress().finally(() => {
		gatewayPoolPressRunning = false
	})
}

function scheduleCardGatewayRewardPoolPress(): void {
	if (cardGatewayRewardPool.length === 0) return
	setTimeout(() => kickCardGatewayRewardPoolPress(), 1000)
}

async function persistCardProgramSocialDbAfterTx(
	cardAddress: string,
	txHash: string,
	meta: CardProgramSocialDbMeta | undefined,
): Promise<void> {
	if (!meta) return
	if (meta.kind === 'like') {
		await upsertCardProgramLike({
			cardAddress,
			userEOA: meta.userEOA,
			targetKind: meta.targetKind,
			issuedParentId: meta.issuedParentId,
			txHash,
		})
		return
	}
	if (meta.kind === 'unlike') {
		await removeCardProgramLike({
			cardAddress,
			userEOA: meta.userEOA,
			targetKind: meta.targetKind,
			issuedParentId: meta.issuedParentId,
		})
		return
	}
	if (meta.kind === 'shareClick') {
		await insertCardProgramShareClick({
			cardAddress,
			actorEOA: meta.actorEOA,
			referrerEOA: meta.referrerEOA ?? null,
			targetKind: meta.targetKind,
			issuedParentId: meta.issuedParentId,
			txHash,
		})
	}
}

async function ensureCardUserCumulativeStatInitialized(params: {
	SC: (typeof Settle_ContractPool)[number]
	chain: BeamioUserCardChainKey
	factoryAddress: string
	cardAddress: string
	logTag: string
}): Promise<{ ok: true; hash?: string; skipped?: boolean } | { ok: false; error: string; hash?: string }> {
	const status = await readCardUserCumulativeStatStatus(params.cardAddress)
	if (status.initialized) return { ok: true, skipped: true }
	const initFactoryCallData = encodeGatewayInvokeCardFactoryCalldata(
		params.cardAddress,
		buildInitializeCardUserCumulativeStatCalldata(),
	)
	logger(Colors.cyan(`[${params.logTag}] auto-init cardUserCumulativeStatTokens card=${params.cardAddress}`))
	const tx = await relayUserCardFactoryCallViaEntryPoint({
		SC: params.SC,
		chain: params.chain,
		factoryAddress: params.factoryAddress,
		factoryCallData: initFactoryCallData,
		logTag: `${params.logTag}:initUserCumulativeStat`,
	})
	const receipt = await tx.wait()
	if (!receipt || receipt.status !== 1) {
		return { ok: false, error: 'initializeCardUserCumulativeStatTokens tx reverted', hash: tx.hash }
	}
	return { ok: true, hash: tx.hash }
}

export async function cardGatewayRewardPoolPress(): Promise<void> {
	const obj = cardGatewayRewardPool.shift()
	if (!obj) return
	const SC = Settle_ContractPool.shift()
	if (!SC) {
		cardGatewayRewardPool.unshift(obj)
		setTimeout(() => kickCardGatewayRewardPoolPress(), 3000)
		return
	}
	try {
		const chain = await resolveUserCardChain(obj.cardAddress)
		if (chain !== 'conet') {
			const err = 'Gateway reward-pool writes are CoNET-only'
			logger(Colors.red(`[${obj.label}] ${err}`))
			obj.res?.status(400).json({ success: false, error: err }).end()
			return
		}
		const factory = await getBeamioUserCardFactoryGateway(obj.cardAddress)
		const gatewaySupported = await factorySupportsGatewayInvokeCard(factory, chain)
		const hasDirectCard = Boolean(obj.cardCallData && obj.cardCallData.length >= 10)
		if (obj.initOnly) {
			if (!gatewaySupported) {
				const err =
					'Factory gatewayInvokeCard not deployed on-chain; use cardInitializeUserCumulativeStat (executeForOwner) instead.'
				logger(Colors.red(`[${obj.label}] ${err}`))
				obj.res?.status(503).json({ success: false, error: err, code: 'UC_FACTORY_GATEWAY_INVOKE_NOT_DEPLOYED' }).end()
				return
			}
			const initResult = await ensureCardUserCumulativeStatInitialized({
				SC,
				chain,
				factoryAddress: factory,
				cardAddress: obj.cardAddress,
				logTag: obj.label,
			})
			if (!initResult.ok) {
				logger(Colors.red(`[${obj.label}] ${initResult.error}`))
				obj.res
					?.status(500)
					.json({ success: false, error: initResult.error, hash: initResult.hash })
					.end()
				return
			}
			logger(
				Colors.green(
					`[${obj.label}] ok card=${obj.cardAddress} skipped=${Boolean(initResult.skipped)} hash=${initResult.hash ?? 'n/a'}`,
				),
			)
			obj.res
				?.status(200)
				.json({
					success: true,
					hash: initResult.hash,
					skipped: Boolean(initResult.skipped),
					initialized: true,
				})
				.end()
			return
		}
		const initResult = await ensureCardUserCumulativeStatInitialized({
			SC,
			chain,
			factoryAddress: factory,
			cardAddress: obj.cardAddress,
			logTag: obj.label,
		})
		if (!initResult.ok) {
			logger(Colors.red(`[${obj.label}] ${initResult.error}`))
			obj.res
				?.status(500)
				.json({ success: false, error: initResult.error, hash: initResult.hash })
				.end()
			return
		}
		const useDirectCard =
			hasDirectCard &&
			(!gatewaySupported || !obj.factoryCallData || obj.factoryCallData.length < 10)
		if (useDirectCard) {
			const directSteps = [obj.cardCallData!, ...(obj.extraCardCallData ?? [])].filter(
				(d) => typeof d === 'string' && d.length >= 10,
			)
			let lastHash = ''
			for (let i = 0; i < directSteps.length; i++) {
				const stepLabel = `${obj.label}:step${i + 1}`
				const tx = await relayUserCardCallViaEntryPoint({
					SC,
					chain,
					cardAddress: obj.cardAddress,
					cardCallData: directSteps[i]!,
					logTag: stepLabel,
				})
				const receipt = await tx.wait()
				if (!receipt || receipt.status !== 1) {
					const err = 'Direct card reward-pool tx reverted'
					logger(Colors.red(`[${stepLabel}] ${err} hash=${tx.hash}`))
					obj.res?.status(500).json({ success: false, error: err, hash: tx.hash }).end()
					return
				}
				lastHash = tx.hash
			}
			logger(Colors.green(`[${obj.label}] ok (direct card) hash=${lastHash} card=${obj.cardAddress}`))
			await persistCardProgramSocialDbAfterTx(obj.cardAddress, lastHash, obj.socialDb)
			obj.res?.status(200).json({ success: true, hash: lastHash }).end()
			return
		}
		if (!gatewaySupported && !hasDirectCard) {
			const err =
				'CoNET Factory lacks gatewayInvokeCard and no direct cardCallData; upgrade ChargeRewardModuleV2 (paymaster relay) and ensure Cluster forwards cardCallData.'
			logger(Colors.red(`[${obj.label}] ${err}`))
			obj.res?.status(503).json({ success: false, error: err, code: 'UC_FACTORY_GATEWAY_INVOKE_NOT_DEPLOYED' }).end()
			return
		}
		if (!obj.factoryCallData || obj.factoryCallData.length < 10) {
			const err = 'Missing or invalid factoryCallData / cardCallData'
			logger(Colors.red(`[${obj.label}] ${err}`))
			obj.res?.status(400).json({ success: false, error: err }).end()
			return
		}
		const tx = await relayUserCardFactoryCallViaEntryPoint({
			SC,
			chain,
			factoryAddress: factory,
			factoryCallData: obj.factoryCallData,
			logTag: obj.label,
		})
		const receipt = await tx.wait()
		if (!receipt || receipt.status !== 1) {
			const err = 'Gateway reward-pool tx reverted'
			logger(Colors.red(`[${obj.label}] ${err} hash=${tx.hash}`))
			obj.res?.status(500).json({ success: false, error: err, hash: tx.hash }).end()
			return
		}
		logger(Colors.green(`[${obj.label}] ok hash=${tx.hash} card=${obj.cardAddress}`))
		await persistCardProgramSocialDbAfterTx(obj.cardAddress, tx.hash, obj.socialDb)
		obj.res?.status(200).json({ success: true, hash: tx.hash }).end()
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		const msg = err?.shortMessage ?? err?.message ?? String(e)
		logger(Colors.red(`[${obj.label}] failed: ${msg}`))
		obj.res?.status(500).json({ success: false, error: msg }).end()
	} finally {
		Settle_ContractPool.unshift(SC)
		scheduleCardGatewayRewardPoolPress()
	}
}

export function pushCardGatewayRewardPoolTask(task: CardGatewayRewardPoolTask): void {
	cardGatewayRewardPool.push(task)
	kickCardGatewayRewardPoolPress()
}

/** NFC top-up 成功后后台记 METRIC_TOPUP（不阻塞 indexer / HTTP）。 */
export function enqueueRecordTopupCumulativeStatGateway(params: {
	cardAddress: string
	userEOA: string
	points6: bigint
}): void {
	if (params.points6 <= 0n) return
	const card = ethers.getAddress(params.cardAddress)
	const user = ethers.getAddress(params.userEOA)
	const cardCalldata = CHARGE_REWARD_V2_IFACE.encodeFunctionData('recordTopupCumulativeStat', [user, params.points6])
	const factoryCallData = encodeGatewayInvokeCardFactoryCalldata(card, cardCalldata)
	pushCardGatewayRewardPoolTask({
		cardAddress: card,
		cardCallData: cardCalldata,
		factoryCallData,
		label: 'recordTopupCumulativeStat',
	})
}
