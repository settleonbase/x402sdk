/**
 * displayJson 仅存 BeamioIndexerDiamond 约定的 DisplayJsonData 字段，不能自行组装 Indexer 中不存在的字段。
 * Base tx hash 等由 originalPaymentHash 表达，勿放入 displayJson。
 * 金额由 Transaction 的 finalRequestAmountFiat6/finalRequestAmountUSDC6/meta 表达。
 */
export type DisplayJsonData = {
	title: string
	source: string
	finishedHash: string
	handle?: string
	forText?: string
	/** 附加图片 card（Gift Envelope）：IPFS URL 及 title、detail 等 */
	card?: {
		title?: string
		detail?: string
		image?: string
	}
	/** 账单有效期（request 类）：有效天数、过期时间戳（秒） */
	validity?: {
		validDays?: number
		expiresAt?: number
	}
	/** NFC Charge 明细（与 Transaction.meta 税/折扣一致；小费另有 TX_TIP 行） */
	chargeBreakdown?: {
		requestCurrency?: string
		subtotalCurrencyAmount?: string
		taxRatePercent?: number
		taxAmountCurrencyAmount?: string
		tierDiscountPercent?: number
		tierDiscountAmountCurrencyAmount?: string
		tipRatePercent?: number
		tipCurrencyAmount?: string
	}
}
