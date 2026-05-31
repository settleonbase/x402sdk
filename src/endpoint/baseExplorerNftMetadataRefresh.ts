import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { warmIssuedNftExplorerOgJpeg, resolveIssuedNftExplorerShareMeta } from './couponClaimShare'

const ISSUED_NFT_START_ID = 100_000_000_000n
const BASE_CHAIN_SLUG = 'base'
/** Base mainnet — Blockscout PRO REST uses `https://api.blockscout.com/{chainId}/api/v2/...` */
export const BLOCKSCOUT_BASE_CHAIN_ID = 8453

export type ExplorerNftMetadataRefreshResult = {
	ok: boolean
	channels: string[]
	errors: string[]
}

export type BlockscoutMetadataRefetchResult = {
	ok: boolean
	channels: string[]
	errors: string[]
}

function blockscoutApiKey(): string | undefined {
	const key = process.env.BLOCKSCOUT_API_KEY?.trim()
	return key || undefined
}

function blockscoutChainId(): number {
	const raw = process.env.BLOCKSCOUT_CHAIN_ID?.trim()
	if (raw) {
		const n = Number(raw)
		if (Number.isFinite(n) && n > 0) return n
	}
	return BLOCKSCOUT_BASE_CHAIN_ID
}

/**
 * PRO multi-chain reads (e.g. address transactions):
 * `https://api.blockscout.com/{chainId}/api/v2/...?apikey=proapi_...`
 */
export function blockscoutUnifiedApiRoot(): string {
	const base = (process.env.BLOCKSCOUT_API_BASE_URL?.trim() || 'https://api.blockscout.com').replace(
		/\/$/,
		''
	)
	if (/\/\d+$/.test(base)) return base
	return `${base}/${blockscoutChainId()}`
}

/**
 * NFT metadata refetch PATCH is served by the chain explorer host.
 * PRO `proapi_…` keys use `Authorization: Bearer` here (not `base.blockscout.com?apikey=`).
 */
function blockscoutRefetchApiRoot(): string {
	const custom = process.env.BLOCKSCOUT_REFETCH_API_ROOT?.trim()
	if (custom) return custom.replace(/\/$/, '')
	return (process.env.BLOCKSCOUT_EXPLORER_API_ROOT?.trim() || 'https://base.blockscout.com').replace(
		/\/$/,
		''
	)
}

function blockscoutRefetchHeaders(apiKey: string): Record<string, string> {
	return {
		accept: 'application/json',
		authorization: `Bearer ${apiKey}`,
		'content-type': 'application/json',
	}
}

async function patchBlockscoutInstanceMetadataRefetch(
	contract: string,
	tokenId: string,
	apiKey: string
): Promise<{ ok: boolean; error?: string }> {
	const root = blockscoutRefetchApiRoot()
	const url = `${root}/api/v2/tokens/${contract}/instances/${encodeURIComponent(tokenId)}/refetch-metadata`
	try {
		const res = await fetch(url, {
			method: 'PATCH',
			headers: blockscoutRefetchHeaders(apiKey),
			body: '{}',
		})
		if (res.ok || res.status === 202) return { ok: true }
		const body = await res.text().catch(() => '')
		return {
			ok: false,
			error: `${res.status}${body ? `:${body.slice(0, 120)}` : ''}`,
		}
	} catch (e: unknown) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) }
	}
}

/**
 * Blockscout PRO: refresh indexed ERC-1155 metadata after beamio.app JSON changes.
 * Set `BLOCKSCOUT_API_KEY` on Master. Card-level updates refetch token #0 (program card metadata).
 */
export async function requestBlockscoutErc1155MetadataRefetch(opts: {
	contractAddress: string
	/** When set, PATCH that instance; otherwise refetch token `0` (card catalog metadata). */
	tokenId?: string
	/** @deprecated Collection refetch is not available for PRO keys on Base; ignored. */
	skipCollectionRefetch?: boolean
}): Promise<BlockscoutMetadataRefetchResult> {
	const channels: string[] = []
	const errors: string[] = []
	const apiKey = blockscoutApiKey()
	if (!apiKey) {
		logger(
			Colors.yellow(
				'[blockscoutMetadataRefetch] BLOCKSCOUT_API_KEY unset — skip Blockscout metadata refetch'
			)
		)
		return { ok: false, channels, errors: ['api_key_unset'] }
	}

	let contract: string
	try {
		contract = ethers.getAddress(opts.contractAddress)
	} catch {
		return { ok: false, channels, errors: ['invalid_contract'] }
	}

	const tokenId = opts.tokenId != null && String(opts.tokenId).trim() !== '' ? String(opts.tokenId).trim() : '0'
	const instance = await patchBlockscoutInstanceMetadataRefetch(contract, tokenId, apiKey)
	if (instance.ok) {
		channels.push(tokenId === '0' ? 'blockscout_token_0' : 'blockscout_instance')
	} else if (instance.error) {
		errors.push(
			(tokenId === '0' ? 'blockscout_token_0' : 'blockscout_instance') + `:${instance.error}`
		)
	}

	const ok = channels.length > 0
	if (ok) {
		logger(
			Colors.cyan(
				`[blockscoutMetadataRefetch] card=${contract} tokenId=${tokenId} channels=${channels.join(',')}`
			)
		)
	} else if (errors.length) {
		logger(
			Colors.yellow(
				`[blockscoutMetadataRefetch] card=${contract} tokenId=${tokenId} errors=${errors.join(';')}`
			)
		)
	}
	return { ok, channels, errors }
}

/** Fire-and-forget: refresh Blockscout index for card-level `0x{card}0.json` (token #0). */
export function scheduleBeamioUserCardBlockscoutMetadataRefetch(contractAddress: string): void {
	void requestBlockscoutErc1155MetadataRefetch({ contractAddress }).catch((e: unknown) => {
		logger(
			Colors.yellow('[blockscoutMetadataRefetch] schedule failed:'),
			e instanceof Error ? e.message : e
		)
	})
}

/** Best-effort refresh after biz updates issued coupon/catalog metadata (Blockscout + OpenSea + warm OG). */
export async function requestExplorerNftMetadataRefresh(opts: {
	contractAddress: string
	tokenId: string
}): Promise<ExplorerNftMetadataRefreshResult> {
	const channels: string[] = []
	const errors: string[] = []
	let contract: string
	try {
		contract = ethers.getAddress(opts.contractAddress)
	} catch {
		return { ok: false, channels, errors: ['invalid_contract'] }
	}
	const tokenId = String(opts.tokenId ?? '').trim()
	try {
		if (BigInt(tokenId) < ISSUED_NFT_START_ID) {
			return { ok: false, channels, errors: ['not_issued_nft_token'] }
		}
	} catch {
		return { ok: false, channels, errors: ['invalid_token_id'] }
	}

	const blockscout = await requestBlockscoutErc1155MetadataRefetch({
		contractAddress: contract,
		tokenId,
	})
	channels.push(...blockscout.channels)
	errors.push(...blockscout.errors)

	try {
		const shareMeta = await resolveIssuedNftExplorerShareMeta(contract, tokenId)
		if (shareMeta) {
			await warmIssuedNftExplorerOgJpeg(contract, tokenId, shareMeta)
			channels.push('beamio_og')
		}
	} catch (e: unknown) {
		errors.push(`beamio_og:${e instanceof Error ? e.message : String(e)}`)
	}

	const openSeaKey = process.env.OPENSEA_API_KEY?.trim()
	if (openSeaKey) {
		try {
			const res = await fetch(
				`https://api.opensea.io/api/v2/chain/${BASE_CHAIN_SLUG}/contract/${contract}/nfts/${encodeURIComponent(tokenId)}/refresh`,
				{
					method: 'POST',
					headers: { accept: 'application/json', 'x-api-key': openSeaKey },
				}
			)
			if (res.ok || res.status === 202) {
				channels.push('opensea')
			} else {
				const body = await res.text().catch(() => '')
				errors.push(`opensea:${res.status}${body ? `:${body.slice(0, 120)}` : ''}`)
			}
		} catch (e: unknown) {
			errors.push(`opensea:${e instanceof Error ? e.message : String(e)}`)
		}
	} else {
		logger(
			Colors.yellow(
				'[explorerNftMetadataRefresh] OPENSEA_API_KEY unset — skip OpenSea refresh'
			)
		)
	}

	const ok = channels.length > 0
	if (ok) {
		logger(
			Colors.cyan(
				`[explorerNftMetadataRefresh] card=${contract} tokenId=${tokenId} channels=${channels.join(',')}`
			)
		)
	}
	return { ok, channels, errors }
}
