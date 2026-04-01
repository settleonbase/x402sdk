import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'
import { logger } from '../logger'
import Colors from 'colors/safe'

/** ERC-1155 points token id on BeamioUserCard */
const POINTS_TOKEN_ID = 0n

const ERC1155_TRANSFER_IFACE = new ethers.Interface([
	'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
	'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
])

const TOPIC_TRANSFER_SINGLE = ERC1155_TRANSFER_IFACE.getEvent('TransferSingle')!.topicHash
const TOPIC_TRANSFER_BATCH = ERC1155_TRANSFER_IFACE.getEvent('TransferBatch')!.topicHash

const ZERO_LC = ethers.ZeroAddress.toLowerCase()

/** 单次 getLogs 块区间（兼顾各 RPC 上限）；大范围回退用 */
const LOG_CHUNK_SIZE = 2048

/** 在此块跨度内优先单次 getLogs（latestCards 多为新卡，一次请求即可） */
const LOG_SINGLE_CALL_MAX_SPAN =
	Number(process.env.LATEST_CARDS_HOLDERS_SINGLE_CALL_MAX_BLOCKS || '') || 500_000

/** 单张卡最多扫的块跨度，防止极老合约拖垮 RPC */
const MAX_BLOCK_SPAN = Number(process.env.LATEST_CARDS_HOLDERS_MAX_BLOCKS || '') || 2_000_000

function applyPointsDelta(balances: Map<string, bigint>, from: string, to: string, value: bigint): void {
	if (value === 0n) return
	const f = ethers.getAddress(from).toLowerCase()
	const t = ethers.getAddress(to).toLowerCase()
	if (f === t) return
	if (f !== ZERO_LC) {
		balances.set(f, (balances.get(f) ?? 0n) - value)
	}
	if (t !== ZERO_LC) {
		balances.set(t, (balances.get(t) ?? 0n) + value)
	}
}

/** 从合约部署高度起扫 TransferSingle/TransferBatch，汇总 token #0 余额，统计 >0 地址数 */
async function countBaseErc1155PointsHolders(
	cardAddress: string,
	deployBlock: number,
	provider: ethers.Provider,
): Promise<number | null> {
	const latest = await provider.getBlockNumber()
	let fromBlock = Math.max(0, deployBlock)
	if (latest - fromBlock > MAX_BLOCK_SPAN) {
		logger(
			Colors.yellow(
				`[latestCards holders] card ${cardAddress} span ${latest - fromBlock} > max ${MAX_BLOCK_SPAN}, clamping fromBlock (count may be low if history truncated)`,
			),
		)
		fromBlock = Math.max(0, latest - MAX_BLOCK_SPAN)
	}
	const balances = new Map<string, bigint>()
	const addr = ethers.getAddress(cardAddress)

	const processLogSlice = (logs: ethers.Log[]) => {
		for (const log of logs) {
			try {
				const parsed = ERC1155_TRANSFER_IFACE.parseLog({
					topics: log.topics as string[],
					data: log.data,
				})
				if (!parsed) continue
				const name = parsed.name
				if (name === 'TransferSingle') {
					const { from, to, id, value } = parsed.args as unknown as {
						from: string
						to: string
						id: bigint
						value: bigint
					}
					if (id !== POINTS_TOKEN_ID) continue
					applyPointsDelta(balances, from, to, value)
				} else if (name === 'TransferBatch') {
					const { from, to, ids, values } = parsed.args as unknown as {
						from: string
						to: string
						ids: readonly bigint[]
						values: readonly bigint[]
					}
					for (let i = 0; i < ids.length; i++) {
						if (ids[i] !== POINTS_TOKEN_ID) continue
						applyPointsDelta(balances, from, to, values[i])
					}
				}
			} catch {
				/* ignore malformed log */
			}
		}
	}

	const span = latest - fromBlock
	if (span <= LOG_SINGLE_CALL_MAX_SPAN) {
		try {
			const logs = await provider.getLogs({
				address: addr,
				fromBlock,
				toBlock: latest,
				topics: [[TOPIC_TRANSFER_SINGLE, TOPIC_TRANSFER_BATCH]],
			})
			processLogSlice(logs)
		} catch (e: any) {
			logger(Colors.yellow(`[latestCards holders] single getLogs fallback to chunks ${addr}: ${e?.message ?? e}`))
			for (let start = fromBlock; start <= latest; start += LOG_CHUNK_SIZE) {
				const end = Math.min(start + LOG_CHUNK_SIZE - 1, latest)
				let logs: ethers.Log[]
				try {
					logs = await provider.getLogs({
						address: addr,
						fromBlock: start,
						toBlock: end,
						topics: [[TOPIC_TRANSFER_SINGLE, TOPIC_TRANSFER_BATCH]],
					})
				} catch (e2: any) {
					logger(Colors.red(`[latestCards holders] getLogs failed ${addr} ${start}-${end}: ${e2?.message ?? e2}`))
					return null
				}
				processLogSlice(logs)
			}
		}
	} else {
		for (let start = fromBlock; start <= latest; start += LOG_CHUNK_SIZE) {
			const end = Math.min(start + LOG_CHUNK_SIZE - 1, latest)
			let logs: ethers.Log[]
			try {
				logs = await provider.getLogs({
					address: addr,
					fromBlock: start,
					toBlock: end,
					topics: [[TOPIC_TRANSFER_SINGLE, TOPIC_TRANSFER_BATCH]],
				})
			} catch (e: any) {
				logger(Colors.red(`[latestCards holders] getLogs failed ${addr} ${start}-${end}: ${e?.message ?? e}`))
				return null
			}
			processLogSlice(logs)
		}
	}

	let n = 0
	for (const bal of balances.values()) {
		if (bal > 0n) n++
	}
	return n
}

async function resolveDeployBlock(txHash: string | null, provider: ethers.Provider): Promise<number | null> {
	if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) {
		return null
	}
	try {
		const rc = await provider.getTransactionReceipt(txHash.trim())
		return rc != null ? rc.blockNumber : null
	} catch {
		return null
	}
}

/**
 * 在 **Base** 上根据 ERC-1155 事件统计 token #0（points）当前持仓地址数。
 * CoNET Indexer 的 `getBeamioUserCardNft0HolderCount` 对 Base 卡常为 0（记账镜像未与链上余额对齐），故改用链上日志。
 */
export async function enrichLatestCardsWithBaseErc1155PointsHolderCounts(
	items: BeamioLatestCardItem[],
	provider: ethers.Provider,
): Promise<BeamioLatestCardItem[]> {
	if (items.length === 0) return items
	const out: BeamioLatestCardItem[] = []
	for (const it of items) {
		const deployBlock = await resolveDeployBlock(it.txHash, provider)
		if (deployBlock == null) {
			logger(Colors.gray(`[latestCards holders] skip ${it.cardAddress}: no deploy tx block`))
			out.push(it)
			continue
		}
		const count = await countBaseErc1155PointsHolders(it.cardAddress, deployBlock, provider)
		if (count == null) {
			out.push(it)
			continue
		}
		out.push({ ...it, holderCount: count })
	}
	return out
}
