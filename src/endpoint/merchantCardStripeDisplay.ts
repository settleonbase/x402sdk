/**
 * Merchant name shown to the payer on Stripe payment pages.
 *
 * Checkout runs on the Beamio platform account (destination charge, no
 * `on_behalf_of`), so Stripe's page header shows "Beamio". The merchant name
 * therefore goes into the line item, the PaymentIntent description and the
 * text above the pay button. These are display fields only: they do not change
 * who is charged, where funds are transferred, or who pays Stripe fees.
 */

const MERCHANT_NAME_MAX = 60

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function readStringField(source: Record<string, unknown> | null, keys: readonly string[]): string {
	if (!source) return ''
	for (const key of keys) {
		const raw = source[key]
		if (typeof raw !== 'string') continue
		const value = raw.trim()
		if (value) return value
	}
	return ''
}

/** Same rule as SilentPassUI `isGenericMerchantCardDisplayName`: placeholders are not merchant names. */
export function isGenericMerchantCardDisplayName(name: string | null | undefined): boolean {
	const t = String(name ?? '').trim()
	if (!t) return true
	if (/^beamio$/i.test(t)) return true
	if (/^(?:qr\s+)?merchant\s+payment$/i.test(t)) return true
	if (/^user\s+card$/i.test(t)) return true
	if (/^beamio\s+user\s+card(?:\s+points|\s+membership(?:\s*#\d+)?)?$/i.test(t)) return true
	if (/^merchant\s+pass$/i.test(t)) return true
	return false
}

/**
 * Merchant name from card0 `metadata_json`, in the same order SilentPassUI
 * uses for the name the payer sees in the app (`merchantProgramCardDisplayNameFromMetadataRoot`):
 * business / store name first, then the program name.
 */
export function merchantNameFromCardMetadata(metadata: Record<string, unknown> | null | undefined): string {
	const root = asRecord(metadata)
	if (!root) return ''
	const share = asRecord(root.shareTokenMetadata)
	const business =
		readStringField(asRecord(root.ownerBusinessMetadata), ['storeName', 'businessName']) ||
		readStringField(asRecord(root.businessMetadata), ['storeName', 'businessName']) ||
		readStringField(asRecord(root.businessProfile), ['storeName', 'businessName']) ||
		readStringField(asRecord(root.businessCard), ['storeName', 'businessName', 'merchantName', 'brandName']) ||
		readStringField(share, ['storeName', 'businessName', 'merchantName', 'brandName', 'displayName']) ||
		readStringField(root, ['storeName', 'businessName', 'merchantName', 'brandName', 'displayName'])
	for (const candidate of [business, readStringField(share, ['name']), readStringField(root, ['name'])]) {
		if (!isGenericMerchantCardDisplayName(candidate)) return candidate
	}
	return ''
}

/** Fallback: the name the merchant set on their connected Stripe account. */
export function merchantNameFromStripeAccount(account: {
	business_profile?: { name?: string | null } | null
	settings?: { dashboard?: { display_name?: string | null } | null } | null
} | null | undefined): string {
	for (const candidate of [account?.business_profile?.name, account?.settings?.dashboard?.display_name]) {
		const value = typeof candidate === 'string' ? candidate.trim() : ''
		if (!isGenericMerchantCardDisplayName(value)) return value
	}
	return ''
}

export function normalizeMerchantDisplayName(raw: string | null | undefined): string {
	const value = String(raw ?? '').replace(/\s+/g, ' ').trim()
	if (!value || isGenericMerchantCardDisplayName(value)) return ''
	return value.length > MERCHANT_NAME_MAX ? `${value.slice(0, MERCHANT_NAME_MAX - 1).trimEnd()}…` : value
}

export type MerchantCardStripeKind = 'topup' | 'membership' | 'gift' | 'charge'

export type MerchantCardStripeDisplayText = {
	/** Line item title on the Checkout page. */
	productName: string
	/** Line item subtitle on the Checkout page. */
	productDescription?: string
	/** PaymentIntent description (Stripe receipt and Dashboard). */
	paymentDescription: string
	/** Text above the Checkout pay button. */
	submitMessage?: string
}

/**
 * Builds the payer-facing text. Without a merchant name the text stays exactly
 * as before this change. Base labels match the existing English Stripe copy;
 * Stripe localises its own page chrome through `locale: 'auto'`.
 */
export function buildMerchantCardStripeDisplayText(params: {
	kind: MerchantCardStripeKind
	merchantName?: string | null
	/** Checkout historically labels gifts as top-ups; the PaymentIntent path labels them as gifts. */
	surface: 'checkout' | 'paymentIntent'
}): MerchantCardStripeDisplayText {
	const baseLabel =
		params.kind === 'membership'
			? 'Membership fee'
			: params.kind === 'gift' && params.surface === 'paymentIntent'
				? 'Dining gift payment'
				: 'Program card top-up'
	const merchantName = normalizeMerchantDisplayName(params.merchantName)
	if (!merchantName) {
		return { productName: baseLabel, paymentDescription: baseLabel }
	}
	return {
		productName: `${merchantName} · ${baseLabel}`,
		productDescription: `Paid to ${merchantName}`,
		paymentDescription: `${baseLabel} — paid to ${merchantName}`,
		submitMessage: `You are paying ${merchantName}. Beamio processes this payment and sends it to the merchant.`,
	}
}
