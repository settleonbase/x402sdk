/**
 * 收费准入（纯模块，无顶层副作用）。Cluster 预检与 Master 中继共用同一顺序：
 *   1) selectChargeCard（选卡，含 B1/B2/B4，地址规范化）；
 *   2) verifyChargeFeeCardBinding（绑定核验：无绑定 4xx，读取失败 503）；
 *   3) 纯 USDC 时 verifyChargePayeeMatchesCardOwner（收款方必须为卡 owner 的 EOA 或 AA）。
 * 任何依赖抛出的异常都映射为 503（pos_admission_unavailable），不会落成 500。
 * 依赖（绑定查询、owner 只读解析）全部由调用方注入。
 */
import { selectChargeCard, type ChargeSelectionItem } from './chargeCardSelection'
import { verifyChargeFeeCardBinding, verifyChargePayeeMatchesCardOwner } from './chargeFeeCardGuard'

export type ChargeGateCode =
	| 'pos_card_invalid'
	| 'pos_payee_card_mismatch'
	| 'pos_card_not_bound'
	| 'pos_card_binding_unavailable'
	| 'pos_payee_resolve_unavailable'
	| 'pos_admission_unavailable'
	| 'pos_fee_insufficient'
	| 'pos_fee_unavailable'
	| 'pos_amount_exceeds_max'

export type ChargeGateReject = { ok: false; status: 400 | 503; code: ChargeGateCode; error: string }

export type ChargeAdmission = Readonly<{
	ok: true
	/** 经核验并 checksum 规范化的卡地址；之后的收款方改写、费用卡与中继上下文都必须使用它。 */
	cardAddress: string
	/** 请求含非 CCSA 的 kind=1 资产（卡内资产收款）。为 true 时收款方由卡 owner 改写，不做 to 核验。 */
	hasNonCcsaErc1155: boolean
}>

export type ChargeAdmissionDeps = {
	/** 返回 true：存在有效绑定；false：确定无绑定；抛出：不可用。 */
	lookupBinding: (cardAddress: string) => Promise<boolean>
	/** 只读解析卡 owner 的 EOA 与 AA（不发交易）；读取失败抛出。 */
	resolveOwner: (cardAddress: string) => Promise<{ eoa: string; aa: string | null }>
}

export const admitChargeRequest = async (
	input: {
		merchantCardAddress: string | null | undefined
		items: readonly ChargeSelectionItem[]
		to: string | null | undefined
		ccsaAddress: string
	},
	deps: ChargeAdmissionDeps
): Promise<ChargeAdmission | ChargeGateReject> => {
	try {
		const selected = selectChargeCard({
			merchantCardAddress: input.merchantCardAddress,
			items: input.items,
			ccsaAddress: input.ccsaAddress,
		})
		if (!selected.ok) return { ok: false, status: selected.status, code: selected.code, error: selected.error }

		const bound = await verifyChargeFeeCardBinding({
			merchantCardAddress: selected.cardAddress,
			lookupBinding: deps.lookupBinding,
		})
		if (!bound.ok) return { ok: false, status: bound.status, code: bound.code, error: bound.error }

		if (!selected.hasNonCcsaErc1155) {
			const payee = await verifyChargePayeeMatchesCardOwner({
				to: String(input.to ?? ''),
				cardAddress: bound.cardAddress,
				resolveOwner: deps.resolveOwner,
			})
			if (!payee.ok) return { ok: false, status: payee.status, code: payee.code, error: payee.error }
		}

		return Object.freeze({
			ok: true as const,
			cardAddress: bound.cardAddress,
			hasNonCcsaErc1155: selected.hasNonCcsaErc1155,
		})
	} catch {
		return { ok: false, status: 503, code: 'pos_admission_unavailable', error: 'charge admission is temporarily unavailable' }
	}
}

// ---------------------------------------------------------------------------
// Master（广播前）：费用上下文、签名 maxAmount、广播前绑定复核。
// ---------------------------------------------------------------------------

export type ChargeFeeDeps = {
	/** 本笔应扣的 B-Unit（6 位精度）。 */
	feeBUnits6: bigint
	/** 读取卡所用的 AA 工厂（网关 _aaFactory）；读取失败抛出。 */
	readAaFactory: (cardAddress: string) => Promise<string>
	/** 读取 B-Unit 余额；读取失败或返回非 bigint 抛出。 */
	readBUnit: (consumer: string) => Promise<bigint>
	/** 读取卡 owner 的 EOA；失败抛出。 */
	readOwnerEoa: (cardAddress: string) => Promise<string>
	/** 只读解析 owner 在该工厂下的 AA：无 AA 返回 null；读取失败抛出。 */
	resolveOwnerAa: (cardAddress: string, aaFactory: string, ownerEoa: string) => Promise<string | null>
}

export type ChargeFeeVerdict =
	| { ok: true; consumer: string; source: 'card' | 'owner_eoa' | 'owner_aa'; ownerEoa: string; aaFactory: string; feeBUnits6: bigint }
	| { ok: false; status: 400 | 503; code: 'pos_fee_insufficient' | 'pos_fee_unavailable'; error: string }

/**
 * 费用付款人（严格版）：卡 → owner EOA → owner AA，顺序与 pickBUnitFeeConsumerPreferMerchantCardThenOwner 一致，
 * 但任何读取失败都直接 503（不像旧选择器那样把卡余额读取失败当作“不可读”后回退到 owner）。
 * 只有读取成功且全部余额都确定不足时，才返回 400 pos_fee_insufficient。
 */
export const verifyChargeFeePayer = async (params: { cardAddress: string; deps: ChargeFeeDeps }): Promise<ChargeFeeVerdict> => {
	const { deps, cardAddress } = params
	const fee = deps.feeBUnits6
	const unavailable = (msg: string): ChargeFeeVerdict => ({ ok: false, status: 503, code: 'pos_fee_unavailable', error: msg })
	if (typeof fee !== 'bigint' || fee <= 0n) return unavailable('B-Unit fee is not configured')
	let aaFactory: string
	let cardBal: bigint
	try {
		aaFactory = await deps.readAaFactory(cardAddress)
		cardBal = await deps.readBUnit(cardAddress)
		if (typeof cardBal !== 'bigint') throw new Error('card balance is not a bigint')
	} catch {
		return unavailable('merchant card fee context is temporarily unavailable')
	}
	if (cardBal >= fee) return { ok: true, consumer: cardAddress, source: 'card', ownerEoa: '', aaFactory, feeBUnits6: fee }
	let ownerEoa: string
	let eoaBal: bigint
	try {
		ownerEoa = await deps.readOwnerEoa(cardAddress)
		eoaBal = await deps.readBUnit(ownerEoa)
		if (typeof eoaBal !== 'bigint') throw new Error('owner balance is not a bigint')
	} catch {
		return unavailable('card owner fee context is temporarily unavailable')
	}
	if (eoaBal >= fee) return { ok: true, consumer: ownerEoa, source: 'owner_eoa', ownerEoa, aaFactory, feeBUnits6: fee }
	let aa: string | null
	let aaBal = 0n
	try {
		aa = await deps.resolveOwnerAa(cardAddress, aaFactory, ownerEoa)
		if (aa) {
			aaBal = await deps.readBUnit(aa)
			if (typeof aaBal !== 'bigint') throw new Error('owner AA balance is not a bigint')
		}
	} catch {
		return unavailable('owner AA fee context is temporarily unavailable')
	}
	if (aa && aaBal >= fee) return { ok: true, consumer: aa, source: 'owner_aa', ownerEoa, aaFactory, feeBUnits6: fee }
	return {
		ok: false,
		status: 400,
		code: 'pos_fee_insufficient',
		error: `Insufficient B-Units for charge: card ${cardAddress} balance ${cardBal.toString()}, owner ${ownerEoa} balance ${eoaBal.toString()}, owner AA ${aa ?? 'none'} balance ${aaBal.toString()}, need ${fee.toString()}`,
	}
}

/**
 * 签名 maxAmount：maxAmount 为 0 时与链上一致（不在此处强制）；否则 USDC 类（kind=0）金额之和不得超过 maxAmount。
 * 链上 simulate/relay 仍是权威校验；本函数只新增拒绝，不放宽任何既有校验。
 */
export const assertChargeWithinMaxAmount = (params: {
	maxAmount: bigint
	items: readonly { kind: number; amount: bigint }[]
}): { ok: true } | { ok: false; status: 400; code: 'pos_amount_exceeds_max'; error: string } => {
	if (params.maxAmount === 0n) return { ok: true }
	let spend = 0n
	for (const it of params.items) {
		if (Number(it.kind) === 0) spend += it.amount
	}
	if (spend > params.maxAmount) {
		return { ok: false, status: 400, code: 'pos_amount_exceeds_max', error: 'charge amount exceeds the signed maxAmount' }
	}
	return { ok: true }
}

/** 广播前紧邻处的绑定复核（B5）：撤销在准入之后生效。无绑定 → 4xx；读取失败 → 503。 */
export const recheckBindingBeforeBroadcast = async (
	cardAddress: string,
	lookupBinding: (cardAddress: string) => Promise<boolean>
): Promise<{ ok: true } | ChargeGateReject> => {
	try {
		const v = await verifyChargeFeeCardBinding({ merchantCardAddress: cardAddress, lookupBinding })
		if (!v.ok) return { ok: false, status: v.status, code: v.code, error: v.error }
		return { ok: true }
	} catch {
		return { ok: false, status: 503, code: 'pos_admission_unavailable', error: 'charge admission is temporarily unavailable' }
	}
}

export type ChargeRelayVerdict =
	| Readonly<{
			ok: true
			cardAddress: string
			hasNonCcsaErc1155: boolean
			feeConsumer: string
			feeSource: 'card' | 'owner_eoa' | 'owner_aa'
			ownerEoa: string
			aaFactory: string
			feeBUnits6: bigint
			maxAmount: bigint
	  }>
	| ChargeGateReject

/**
 * Master 广播前的唯一准入入口（B6）：准入（选卡/绑定/收款方）→ 签名 maxAmount → 严格费用付款人。
 * 任何一步失败都在广播、签名与入队之前返回拒绝。返回值冻结，之后的广播与记账只使用它。
 */
export const gateChargeRelay = async (
	input: {
		merchantCardAddress: string | null | undefined
		items: readonly { kind: number; asset: string; amount: bigint }[]
		to: string | null | undefined
		ccsaAddress: string
		maxAmount: bigint
	},
	deps: { admission: ChargeAdmissionDeps; fee: ChargeFeeDeps }
): Promise<ChargeRelayVerdict> => {
	const adm = await admitChargeRequest(
		{ merchantCardAddress: input.merchantCardAddress, items: input.items, to: input.to, ccsaAddress: input.ccsaAddress },
		deps.admission
	)
	if (!adm.ok) return adm
	const amt = assertChargeWithinMaxAmount({ maxAmount: input.maxAmount, items: input.items })
	if (!amt.ok) return amt
	const fee = await verifyChargeFeePayer({ cardAddress: adm.cardAddress, deps: deps.fee })
	if (!fee.ok) return fee
	return Object.freeze({
		ok: true as const,
		cardAddress: adm.cardAddress,
		hasNonCcsaErc1155: adm.hasNonCcsaErc1155,
		feeConsumer: fee.consumer,
		feeSource: fee.source,
		ownerEoa: fee.ownerEoa,
		aaFactory: fee.aaFactory,
		feeBUnits6: fee.feeBUnits6,
		maxAmount: input.maxAmount,
	})
}

