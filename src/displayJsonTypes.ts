/** displayJson 仅存账单附加字符（title/handle/forText/card），金额由 Transaction 的 finalRequestAmountFiat6/finalRequestAmountUSDC6/meta 表达 */
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
}
