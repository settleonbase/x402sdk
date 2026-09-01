/**
 * Master：gatewayInvokeCard 队列（#13 奖励池 / 累计统计 gateway-only 写路径）。
 */
import type { Response } from 'express'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from './logger'
import { resolveUserCardChain, providerForUserCardChain, type BeamioUserCardChainKey } from './beamioUserCardChain'
import {
	checkBusinessRelayTxSuccessful,
	getBeamioUserCardFactoryGateway,
	relayUserCardFactoryCallViaEntryPoint,
	relayUserCardCallViaEntryPoint,
	Settle_ContractPool,
	chargeCardProgramSocialBunitFeeInBackground,
} from './MemberCard'
import { shiftSettleConet, unshiftSettleConet } from './settleContractPool'
import {
	CHARGE_REWARD_V2_IFACE,
	buildDispatchEventReward13Calldata,
	buildInitializeCardUserCumulativeStatCalldata,
	encodeGatewayInvokeCardFactoryCalldata,
	readCardUserCumulativeStatStatus,
	type ConetUsdcPermitPayload,
} from './userCumulativeStatRewardPool'
import { CONET_USDC } from './chainAddresses'

/** TreasuryCanonicalERC20V3 — `bytes signature` permit (not v,r,s). */
const CONET_USDC_PERMIT_WRITE_ABI = [
	'function permit(address owner, address spender, uint256 value, uint256 deadline, bytes signature)',
] as const
import {
	readActiveCouponSocialRewardRule,
	resolveRefWalletForDispatch,
	type CouponSocialPromotionEventKey,
} from './couponSocialPromotionReward'
import {
	insertCardProgramShareClick,
	removeCardProgramLike,
	upsertCardProgramLike,
} from './cardProgramSocialDb'
import { syncCardProgramReferrerEventsFromReceipt } from './cardProgramReferrerDb'

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
	/**
	 * Cluster-verified CONET-USDC permit. Master sponsors CNET gas via Settle_Conet
	 * before fundSocialExchangeUsdcEscrow (no re-validation).
	 */
	permit?: ConetUsdcPermitPayload
	/**
	 * HTTP response handle. Omitted for recordUserLike / burnUserLike when Master already
	 * returned `{ success, queued }` at enqueue (client must not wait for EntryPoint).
	 */
	res?: Response
}

function humanizeGatewayRewardPoolError(raw: string): string {
	const s = String(raw ?? '')
	if (/insufficient funds for intrinsic transaction cost/i.test(s)) {
		return 'CoNET gas sponsorship failed. Please try again shortly.'
	}
	if (/permit|PERMIT|ECDSA|invalid signature/i.test(s)) {
		return 'CONET-USDC permit could not be applied. Please try again.'
	}
	if (/BM_CallFailed|execution reverted/i.test(s)) {
		return 'On-chain funding failed. Please try again.'
	}
	// Strip raw RPC / ethers JSON dumps from user-facing errors.
	if (/\{[\s\S]*"code"\s*:/.test(s) || s.length > 280) {
		return 'Funding the #13 redeem pool failed. Please try again.'
	}
	return s || 'Funding the #13 redeem pool failed. Please try again.'
}

/**
 * Master trusts Cluster-verified permit: submit via Settle_Conet wallet (sponsors CNET gas).
 */
async function applyClusterVerifiedConetUsdcPermit(
	SC: { walletConet: ethers.Wallet },
	permit: ConetUsdcPermitPayload,
	logTag: string,
): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
	try {
		const usdc = new ethers.Contract(CONET_USDC, CONET_USDC_PERMIT_WRITE_ABI, SC.walletConet)
		const tx = await usdc.permit(
			permit.owner,
			permit.spender,
			BigInt(permit.value),
			BigInt(permit.deadline),
			permit.signature,
		)
		const receipt = await tx.wait()
		if (receipt && typeof receipt.status === 'number' && receipt.status === 0) {
			return { ok: false, error: 'CONET-USDC permit transaction reverted.' }
		}
		logger(Colors.green(`[${logTag}] permit ok hash=${tx.hash}`))
		return { ok: true, hash: tx.hash as string }
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		const msg = err?.shortMessage ?? err?.message ?? String(e)
		logger(Colors.red(`[${logTag}] permit failed: ${msg}`))
		return { ok: false, error: humanizeGatewayRewardPoolError(msg) }
	}
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

/** Index ShareRefereeBound / Referee* into DB after gateway UserOp (bindShareReferee + other card writes). */
function syncCardProgramReferrerFromGatewayReceipt(
	cardAddress: string,
	txHash: string,
	receipt: { logs?: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> } | null | undefined,
	logTag: string,
): void {
	if (!receipt?.logs?.length) return
	void syncCardProgramReferrerEventsFromReceipt({
		cardAddress,
		receipt: { logs: receipt.logs },
		txHash,
	}).catch((refIdxErr: unknown) => {
		const msg = refIdxErr instanceof Error ? refIdxErr.message : String(refIdxErr)
		logger(Colors.yellow(`[${logTag}] cardProgramReferrer indexer non-critical: ${msg}`))
	})
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

function scheduleSocialBunitFeeAfterGatewaySuccess(
	task: CardGatewayRewardPoolTask,
	basePaymentHash: string,
	baseGas: bigint,
): void {
	const kindFromDb = task.socialDb?.kind
	let kind: import('./MemberCard').CardProgramSocialBunitKind | null = null
	if (kindFromDb === 'like' || kindFromDb === 'shareClick') {
		kind = kindFromDb
	} else {
		const label = task.label || ''
		if (label.includes('dispatchEventReward13:coupon:claim')) kind = 'claim'
		else if (label.includes('dispatchEventReward13:coupon:burn')) kind = 'burn'
		else if (label.includes('dispatchEventReward13:coupon:linkClick')) kind = 'linkClick'
		else if (label.includes('dispatchEventReward13:topup')) kind = 'topup'
	}
	if (!kind) return
	void chargeCardProgramSocialBunitFeeInBackground({
		cardAddress: task.cardAddress,
		basePaymentHash,
		kind,
		baseGas,
		logTag: `${task.label}:bunit`,
	}).catch((e: unknown) => {
		const err = e as { message?: string }
		logger(Colors.yellow(`[${task.label}:bunit] unhandled: ${err?.message ?? String(e)}`))
	})
}

export async function cardGatewayRewardPoolPress(): Promise<void> {
	const obj = cardGatewayRewardPool.shift()
	if (!obj) return
	const SC = shiftSettleConet()
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
		if (obj.permit) {
			const permitResult = await applyClusterVerifiedConetUsdcPermit(SC, obj.permit, obj.label)
			if (!permitResult.ok) {
				obj.res?.status(500).json({ success: false, error: permitResult.error }).end()
				return
			}
		}
		const hasExtraSteps = (obj.extraCardCallData?.length ?? 0) > 0
		const useDirectCard =
			hasDirectCard &&
			(hasExtraSteps || !gatewaySupported || !obj.factoryCallData || obj.factoryCallData.length < 10)
		if (useDirectCard) {
			const directSteps = [obj.cardCallData!, ...(obj.extraCardCallData ?? [])].filter(
				(d) => typeof d === 'string' && d.length >= 10,
			)
			let lastHash = ''
			let lastGas = 0n
			let lastReceipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>; gasUsed?: bigint } | null =
				null
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
				const relayCheck = checkBusinessRelayTxSuccessful(receipt ?? undefined, { logTag: stepLabel })
				if (!relayCheck.ok) {
					const err = relayCheck.reason ?? 'Direct card reward-pool UserOp failed'
					logger(Colors.red(`[${stepLabel}] ${err} hash=${tx.hash}`))
					obj.res?.status(500).json({ success: false, error: err, hash: tx.hash }).end()
					return
				}
				lastHash = tx.hash
				lastGas = receipt?.gasUsed ?? 0n
				lastReceipt = receipt
			}
			logger(Colors.green(`[${obj.label}] ok (direct card) hash=${lastHash} card=${obj.cardAddress}`))
			await persistCardProgramSocialDbAfterTx(obj.cardAddress, lastHash, obj.socialDb)
			syncCardProgramReferrerFromGatewayReceipt(obj.cardAddress, lastHash, lastReceipt, obj.label)
			/** like/unlike already returned `{ queued: true }` at enqueue — do not rewrite HTTP. */
			if (obj.res && !obj.res.headersSent) {
				obj.res.status(200).json({ success: true, hash: lastHash }).end()
			}
			scheduleSocialBunitFeeAfterGatewaySuccess(obj, lastHash, lastGas)
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
		const relayCheck = checkBusinessRelayTxSuccessful(receipt ?? undefined, { logTag: obj.label })
		if (!relayCheck.ok) {
			const err = relayCheck.reason ?? 'Gateway reward-pool UserOp failed'
			logger(Colors.red(`[${obj.label}] ${err} hash=${tx.hash}`))
			obj.res?.status(500).json({ success: false, error: err, hash: tx.hash }).end()
			return
		}
		logger(Colors.green(`[${obj.label}] ok hash=${tx.hash} card=${obj.cardAddress}`))
		await persistCardProgramSocialDbAfterTx(obj.cardAddress, tx.hash, obj.socialDb)
		syncCardProgramReferrerFromGatewayReceipt(obj.cardAddress, tx.hash, receipt, obj.label)
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(200).json({ success: true, hash: tx.hash }).end()
		}
		scheduleSocialBunitFeeAfterGatewaySuccess(obj, tx.hash, receipt?.gasUsed ?? 0n)
	} catch (e: unknown) {
		const err = e as { shortMessage?: string; message?: string }
		const msg = err?.shortMessage ?? err?.message ?? String(e)
		logger(Colors.red(`[${obj.label}] failed: ${msg}`))
		if (obj.res && !obj.res.headersSent) {
			obj.res.status(500).json({ success: false, error: humanizeGatewayRewardPoolError(msg) }).end()
		}
	} finally {
		unshiftSettleConet(SC)
		scheduleCardGatewayRewardPoolPress()
	}
}

export function pushCardGatewayRewardPoolTask(task: CardGatewayRewardPoolTask): void {
	cardGatewayRewardPool.push(task)
	kickCardGatewayRewardPoolPress()
}

/**
 * @deprecated Beacon V15+ mints METRIC_TOPUP + #13 inside mintPointsByAdmin*|Gateway* same call.
 * Kept as no-op so old callers do not enqueue a second UserOp (design violation / BM_CallFailed).
 */
export function enqueueRecordTopupCumulativeStatGateway(_params: {
	cardAddress: string
	userEOA: string
	points6: bigint
}): void {
	/* no-op: same-cycle on card */
}

/**
 * @deprecated Beacon V16+ mints Charge referrer #13 in-card via UpdateLib
 * (`mintReferrerRewardForChargeIfConfigured` when `referrerChargeAmountRatioE6 > 0`).
 * Kept as no-op so legacy callers do not dual-mint.
 */
export function enqueueRecordChargeReferrerReward(_params: {
	cardAddress: string
	userEOA: string
	amountFiat6: bigint
}): void {
	/* no-op: same-cycle on card */
}

function resolveTopupRefWalletForDispatch(
	userEOA: string,
	refWalletRaw: string | null | undefined,
	refMint13: bigint,
): string {
	if (refMint13 <= 0n) return ethers.ZeroAddress
	const raw = refWalletRaw?.trim() ?? ''
	if (!raw || !ethers.isAddress(raw)) return ethers.ZeroAddress
	try {
		const ref = ethers.getAddress(raw)
		const actor = ethers.getAddress(userEOA)
		return ref === actor ? ethers.ZeroAddress : ref
	} catch {
		return ethers.ZeroAddress
	}
}

/** L2 coupon social event (#13) — claim / burn / optional server-side linkClick. cumulativeDelta=1 records stat in dispatch. */
export async function enqueueCouponSocialReward13IfConfigured(params: {
	cardAddress: string
	userEOA: string
	issuedTokenId: bigint | string | number
	eventKey: CouponSocialPromotionEventKey
	refWallet?: string | null
	/** 0 when stat already written (share click / like); 1 for claim/burn. */
	cumulativeDelta?: bigint | number
}): Promise<void> {
	const rule = await readActiveCouponSocialRewardRule({
		cardAddress: params.cardAddress,
		issuedTokenId: params.issuedTokenId,
		eventKey: params.eventKey,
	})
	if (!rule) return
	if (rule.actorMint13 <= 0n && rule.refMint13 <= 0n) return

	const card = ethers.getAddress(params.cardAddress)
	const user = ethers.getAddress(params.userEOA)
	const refWallet = resolveRefWalletForDispatch(user, params.refWallet, rule.refMint13)
	const cumulativeDelta = BigInt(params.cumulativeDelta ?? 1)
	const cardCalldata = buildDispatchEventReward13Calldata({
		ruleId: rule.ruleId,
		actorWallet: user,
		refWallet,
		cumulativeTargetKind: rule.targetKind,
		cumulativeIssuedParentId: rule.issuedParentId,
		cumulativeDelta,
	})
	const factoryCallData = encodeGatewayInvokeCardFactoryCalldata(card, cardCalldata)
	pushCardGatewayRewardPoolTask({
		cardAddress: card,
		cardCallData: cardCalldata,
		factoryCallData,
		label: `dispatchEventReward13:coupon:${params.eventKey}`,
	})
}

/**
 * @deprecated Same-cycle top-up #13 is minted in-card from **ratio storage**
 * (`topupActorRewardRatioE6` / `referrerTopupAmountRatioE6`) via `recordTopupCumulativeStat`.
 * Kept as no-op so legacy callers do not dual-mint (fixed `ruleId=2` or a second UserOp).
 */
export async function enqueueTopupSocialReward13IfConfigured(_params: {
	cardAddress: string
	userEOA: string
	refWallet?: string | null
}): Promise<void> {
	return
}
