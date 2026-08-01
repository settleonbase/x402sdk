/**
 * CoNET mainnet Blockscout REST client (https://mainnet.conet.network/api/v2).
 * Used for NodeRewardSettled log scans where eth_getLogs block range is capped at ~5000.
 */

export const CONET_BLOCKSCOUT_API_BASE =
	(process.env.CONET_BLOCKSCOUT_API_BASE?.trim() || 'https://mainnet.conet.network/api/v2').replace(/\/$/, '')

export type BlockscoutLogsPageParams = {
	index: number
	block_number: number
	items_count: number
}

export type BlockscoutDecodedLog = {
	address?: { hash?: string }
	block_number?: number
	block_hash?: string
	index?: number
	transaction_hash?: string
	decoded?: {
		method_call?: string
		parameters?: Array<{
			name?: string
			type?: string
			value?: string
			indexed?: boolean
		}>
	}
}

export type BlockscoutLogsPage = {
	items: BlockscoutDecodedLog[]
	next_page_params: BlockscoutLogsPageParams | null
}

function logsPageQuery(params?: BlockscoutLogsPageParams): string {
	if (!params) return ''
	const q = new URLSearchParams()
	q.set('index', String(params.index))
	q.set('block_number', String(params.block_number))
	q.set('items_count', String(params.items_count))
	return `?${q.toString()}`
}

export async function fetchBlockscoutAddressLogsPage(
	contractAddress: string,
	pageParams?: BlockscoutLogsPageParams,
): Promise<BlockscoutLogsPage> {
	const addr = contractAddress.trim()
	const url = `${CONET_BLOCKSCOUT_API_BASE}/addresses/${addr}/logs${logsPageQuery(pageParams)}`
	const response = await fetch(url, { signal: AbortSignal.timeout(45_000) })
	if (!response.ok) {
		throw new Error(`Blockscout logs HTTP ${response.status} for ${addr}`)
	}
	const payload = (await response.json()) as BlockscoutLogsPage
	return {
		items: Array.isArray(payload.items) ? payload.items : [],
		next_page_params: payload.next_page_params ?? null,
	}
}

export function parseNodeRewardSettledFromBlockscoutLog(
	log: BlockscoutDecodedLog,
): { guardianId: number; beneficiary: string; amount: bigint; eventKey: string } | null {
	const call = log.decoded?.method_call ?? ''
	if (!call.startsWith('NodeRewardSettled')) return null
	const params = log.decoded?.parameters ?? []
	const byName = new Map<string, string>()
	for (const p of params) {
		if (p.name) byName.set(p.name, String(p.value ?? ''))
	}
	const guardianId = Number(byName.get('guardianId') ?? NaN)
	const beneficiary = String(byName.get('beneficiary') ?? '').trim()
	const amountRaw = byName.get('amount') ?? '0'
	const eventKey = String(byName.get('eventKey') ?? '').trim()
	if (!Number.isFinite(guardianId) || guardianId <= 0) return null
	if (!beneficiary || !beneficiary.startsWith('0x')) return null
	let amount: bigint
	try {
		amount = BigInt(amountRaw)
	} catch {
		return null
	}
	if (amount <= 0n) return null
	return { guardianId, beneficiary, amount, eventKey }
}
