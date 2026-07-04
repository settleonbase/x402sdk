import fetch from 'node-fetch'
import { ethers } from 'ethers'
import { generateJwt } from '@coinbase/cdp-sdk/auth'
import { getCDPCredentials } from './coinbase'
import { USDC_BASE } from './chainAddresses'

const CDP_HOST = 'api.cdp.coinbase.com'
const NATIVE_ETH_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

export type CdpEvmTokenBalanceRow = {
	amountRaw: string
	decimals: number
	symbol: string
	name: string
	contractAddress: string
}

export type BaseAaSmartWalletBalanceItem = {
	id: 'base_eth' | 'base_usdc'
	label: string
	symbol: string
	amountRaw: string
	decimals: number
	contractAddress: string
}

async function cdpJwt(method: string, path: string): Promise<string> {
	const { apiKeyId, apiKeySecret } = getCDPCredentials()
	return generateJwt({
		apiKeyId,
		apiKeySecret,
		requestMethod: method,
		requestPath: path,
		requestHost: CDP_HOST,
	})
}

/** Paginated CDP token balances for one EVM network (Base). */
export async function fetchCdpEvmTokenBalancesAllPages(
	network: 'base',
	address: string,
	maxPages = 5
): Promise<CdpEvmTokenBalanceRow[]> {
	const checksum = ethers.getAddress(address)
	const out: CdpEvmTokenBalanceRow[] = []
	let pageToken: string | undefined

	for (let page = 0; page < maxPages; page++) {
		const basePath = `/platform/v2/evm/token-balances/${network}/${checksum}`
		const path = pageToken
			? `${basePath}?pageToken=${encodeURIComponent(pageToken)}`
			: basePath
		const jwt = await cdpJwt('GET', path.split('?')[0]!)

		const url = `https://${CDP_HOST}${path}`
		const res = await fetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${jwt}` },
		})
		if (!res.ok) {
			const text = await res.text().catch(() => '')
			throw new Error(`CDP token-balances failed: HTTP ${res.status} ${text.slice(0, 200)}`)
		}

		const data = (await res.json()) as {
			balances?: Array<{
				amount?: { amount?: string; decimals?: number }
				token?: { symbol?: string; name?: string; contractAddress?: string }
			}>
			nextPageToken?: string
		}

		for (const row of data.balances ?? []) {
			const amountStr = row.amount?.amount
			const decimals = row.amount?.decimals
			const contractAddress = row.token?.contractAddress
			if (amountStr == null || decimals == null || !contractAddress) continue
			let raw: bigint
			try {
				raw = BigInt(amountStr)
			} catch {
				continue
			}
			if (raw <= 0n) continue
			out.push({
				amountRaw: raw.toString(),
				decimals,
				symbol: String(row.token?.symbol ?? '').trim() || '?',
				name: String(row.token?.name ?? '').trim() || '?',
				contractAddress: ethers.getAddress(contractAddress),
			})
		}

		pageToken = data.nextPageToken?.trim() || undefined
		if (!pageToken) break
	}

	return out
}

function isNativeEthToken(contractAddress: string): boolean {
	return contractAddress.toLowerCase() === NATIVE_ETH_PLACEHOLDER
}

/** Map CDP rows to AA multisig UI items (Base ETH + Base USDC only). */
export function mapCdpRowsToBaseAaSmartWalletItems(
	rows: CdpEvmTokenBalanceRow[]
): BaseAaSmartWalletBalanceItem[] {
	const usdcLower = USDC_BASE.toLowerCase()
	const items: BaseAaSmartWalletBalanceItem[] = []

	for (const row of rows) {
		const contractLower = row.contractAddress.toLowerCase()
		if (isNativeEthToken(contractLower) || row.symbol.toUpperCase() === 'ETH') {
			items.push({
				id: 'base_eth',
				label: 'Base ETH',
				symbol: 'ETH',
				amountRaw: row.amountRaw,
				decimals: row.decimals,
				contractAddress: row.contractAddress,
			})
			continue
		}
		if (contractLower === usdcLower || row.symbol.toUpperCase() === 'USDC') {
			items.push({
				id: 'base_usdc',
				label: 'Base USDC',
				symbol: 'USDC',
				amountRaw: row.amountRaw,
				decimals: row.decimals,
				contractAddress: row.contractAddress,
			})
		}
	}

	const order: BaseAaSmartWalletBalanceItem['id'][] = ['base_eth', 'base_usdc']
	return order
		.map((id) => items.find((i) => i.id === id))
		.filter((i): i is BaseAaSmartWalletBalanceItem => i != null)
}

export async function fetchBaseAaSmartWalletBalancesViaCdp(
	aaAddress: string,
	baseProvider: ethers.Provider
): Promise<{
	aaDeployed: boolean
	aaAddress: string
	items: BaseAaSmartWalletBalanceItem[]
}> {
	const checksum = ethers.getAddress(aaAddress)
	const code = await baseProvider.getCode(checksum)
	const aaDeployed = !!(code && code !== '0x' && code.length > 2)
	if (!aaDeployed) {
	 return { aaDeployed: false, aaAddress: checksum, items: [] }
	}

	const rows = await fetchCdpEvmTokenBalancesAllPages('base', checksum)
	return {
		aaDeployed: true,
		aaAddress: checksum,
		items: mapCdpRowsToBaseAaSmartWalletItems(rows),
	}
}
