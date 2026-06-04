import { ethers } from 'ethers'
import { logger } from '../logger'
import Colors from 'colors/safe'
import { getSeriesByCardAndTokenId } from '../db'

const BASE_RPC_URL = process.env.BASE_RPC_URL ?? 'https://base-rpc.conet.network'
const JSONRPC_NO_BATCH = { batchMaxCount: 1 } as const

const ISSUED_NFT_MINTED_IFACE = new ethers.Interface([
	'event IssuedNftMinted(uint256 indexed tokenId, address indexed recipient, uint256 amount)',
])
const ISSUED_NFT_MINTED_TOPIC = ISSUED_NFT_MINTED_IFACE.getEvent('IssuedNftMinted')!.topicHash

/** ERC-1155 issued coupon/catalog series start at 100_000_000_000. */
const ISSUED_NFT_TOKEN_ID_MIN = 100_000_000_000n

const LOG_CHUNK_SIZE = 500_000n
const AVG_BLOCK_SEC = 2
const FROM_BLOCK_BUFFER = 2_000n

export type IssuedNftClaimWalletRow = {
	wallet: string
	holder: string
	claimedAt: string
	txHash: string
	blockNumber: number
}

export type ListIssuedNftClaimWalletsResult = {
	ok: true
	cardAddress: string
	tokenId: string
	page: number
	pageSize: number
	total: number
	items: IssuedNftClaimWalletRow[]
}

async function resolveDisplayWallet(provider: ethers.JsonRpcProvider, addr: string): Promise<string> {
	if (!ethers.isAddress(addr)) return ''
	const checksummed = ethers.getAddress(addr)
	try {
		const code = await provider.getCode(checksummed)
		if (!code || code === '0x') return checksummed
		const owner = await new ethers.Contract(
			checksummed,
			['function owner() view returns (address)'],
			provider
		).owner() as Promise<string>
		if (owner && ethers.isAddress(owner) && owner !== ethers.ZeroAddress) {
			return ethers.getAddress(owner)
		}
	} catch {
		/* non-ownable contract — show holder as-is */
	}
	return checksummed
}

async function estimateFromBlock(
	provider: ethers.JsonRpcProvider,
	seriesCreatedAtIso: string | undefined
): Promise<bigint> {
	const head = BigInt(await provider.getBlockNumber())
	if (!seriesCreatedAtIso) {
		return head > 4_000_000n ? head - 4_000_000n : 0n
	}
	const createdMs = Date.parse(seriesCreatedAtIso)
	if (!Number.isFinite(createdMs) || createdMs <= 0) {
		return head > 4_000_000n ? head - 4_000_000n : 0n
	}
	const ageSec = Math.max(0, (Date.now() - createdMs) / 1000)
	const blocksAgo = BigInt(Math.ceil(ageSec / AVG_BLOCK_SEC) + Number(FROM_BLOCK_BUFFER))
	return blocksAgo >= head ? 0n : head - blocksAgo
}

async function fetchIssuedNftMintedLogs(
	provider: ethers.JsonRpcProvider,
	cardAddress: string,
	tokenId: bigint,
	fromBlock: bigint,
	toBlock: bigint
): Promise<ethers.Log[]> {
	const tokenTopic = ethers.zeroPadValue(ethers.toBeHex(tokenId), 32)
	const out: ethers.Log[] = []
	let cursor = fromBlock
	while (cursor <= toBlock) {
		const end = cursor + LOG_CHUNK_SIZE > toBlock ? toBlock : cursor + LOG_CHUNK_SIZE
		try {
			const chunk = await provider.getLogs({
				address: cardAddress,
				topics: [ISSUED_NFT_MINTED_TOPIC, tokenTopic],
				fromBlock: cursor,
				toBlock: end,
			})
			out.push(...chunk)
		} catch (e: any) {
			logger(
				Colors.yellow(
					`[issuedNftClaimWallets] getLogs chunk failed card=${cardAddress} tokenId=${tokenId} ${cursor}-${end}: ${e?.message ?? e}`
				)
			)
			if (end - cursor <= 50_000n) throw e
			const mid = cursor + (end - cursor) / 2n
			const left = await fetchIssuedNftMintedLogs(provider, cardAddress, tokenId, cursor, mid)
			const right = await fetchIssuedNftMintedLogs(provider, cardAddress, tokenId, mid + 1n, end)
			out.push(...left, ...right)
		}
		cursor = end + 1n
	}
	return out
}

/** Paginated wallets that received this issued NFT (mint / open-claim / redeem mint). */
export async function listIssuedNftClaimWallets(args: {
	cardAddress: string
	tokenId: string
	page?: number
	pageSize?: number
}): Promise<ListIssuedNftClaimWalletsResult> {
	const cardNorm = ethers.getAddress(args.cardAddress)
	let tokenIdN: bigint
	try {
		tokenIdN = BigInt(String(args.tokenId).trim())
	} catch {
		throw new Error('Invalid tokenId')
	}
	if (tokenIdN < ISSUED_NFT_TOKEN_ID_MIN) {
		throw new Error('tokenId is not an issued NFT series')
	}

	const page = Math.max(1, Math.floor(Number(args.page ?? 1) || 1))
	const pageSize = Math.min(50, Math.max(1, Math.floor(Number(args.pageSize ?? 10) || 10)))

	const provider = new ethers.JsonRpcProvider(BASE_RPC_URL, undefined, JSONRPC_NO_BATCH)
	const series = await getSeriesByCardAndTokenId(cardNorm, tokenIdN.toString())
	const fromBlock = await estimateFromBlock(provider, series?.createdAt)
	const head = BigInt(await provider.getBlockNumber())
	const logs = await fetchIssuedNftMintedLogs(provider, cardNorm, tokenIdN, fromBlock, head)

	const byWallet = new Map<
		string,
		{ holder: string; wallet: string; blockNumber: number; txHash: string; claimedAt: string }
	>()

	for (const log of logs) {
		let recipient: string
		try {
			const parsed = ISSUED_NFT_MINTED_IFACE.parseLog({ topics: log.topics as string[], data: log.data })
			if (!parsed) continue
			recipient = ethers.getAddress(String(parsed.args.recipient))
		} catch {
			continue
		}
		const blockNumber = Number(log.blockNumber ?? 0)
		const txHash = String(log.transactionHash ?? '')
		const key = recipient.toLowerCase()
		const prev = byWallet.get(key)
		if (!prev || blockNumber >= prev.blockNumber) {
			byWallet.set(key, {
				holder: recipient,
				wallet: recipient,
				blockNumber,
				txHash,
				claimedAt: '',
			})
		}
	}

	const sorted = [...byWallet.values()].sort((a, b) => b.blockNumber - a.blockNumber)
	const walletResolved = await Promise.all(
		sorted.map(async (row) => {
			const wallet = await resolveDisplayWallet(provider, row.holder)
			let claimedAt = ''
			try {
				const block = await provider.getBlock(row.blockNumber)
				if (block?.timestamp) {
					claimedAt = new Date(Number(block.timestamp) * 1000).toISOString()
				}
			} catch {
				/* optional timestamp */
			}
			return { ...row, wallet, claimedAt }
		})
	)

	const total = walletResolved.length
	const start = (page - 1) * pageSize
	const items = walletResolved.slice(start, start + pageSize).map((row) => ({
		wallet: row.wallet,
		holder: row.holder,
		claimedAt: row.claimedAt,
		txHash: row.txHash,
		blockNumber: row.blockNumber,
	}))

	return {
		ok: true,
		cardAddress: cardNorm,
		tokenId: tokenIdN.toString(),
		page,
		pageSize,
		total,
		items,
	}
}
