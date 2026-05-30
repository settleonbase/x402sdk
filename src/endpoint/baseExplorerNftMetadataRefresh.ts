import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { warmIssuedNftExplorerOgJpeg, resolveIssuedNftExplorerShareMeta } from './couponClaimShare'

const ISSUED_NFT_START_ID = 100_000_000_000n
const BASE_CHAIN_SLUG = 'base'

export type ExplorerNftMetadataRefreshResult = {
	ok: boolean
	channels: string[]
	errors: string[]
}

/** Best-effort refresh after biz updates issued coupon/catalog metadata (OpenSea + warm OG). */
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
				'[explorerNftMetadataRefresh] OPENSEA_API_KEY unset — skip OpenSea refresh; BaseScan may need manual Refresh Metadata'
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
