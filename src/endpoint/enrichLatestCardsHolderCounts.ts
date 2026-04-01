import { ethers } from 'ethers'
import type { BeamioLatestCardItem } from '../db'
import { logger } from '../logger'
import Colors from 'colors/safe'

/** AdminStatsPeriodLib: valid periodType; cumulative slice when cumulativeStartTs=0 仍见合约实现 */
const PERIOD_HOUR = 0

const POINTS_TOKEN_ID = 0n

/**
 * Full `GlobalStatsFullView` 与链上 `BeamioUserCardAdminStatsQueryModuleV1.getGlobalStatsFull` 一致（经 BeamioUserCard fallback）。
 * @see src/BeamioUserCard/readme.md — getGlobalStatsFull
 */
/** 链上读数用 ABI；`getGlobalStatsFull` 的返回值在 Master 侧用手动长度分支解码（旧 module 17 字 vs 新 module 25 字）。 */
const CARD_HOLDER_METRICS_ABI = [
	'function totalSupply(uint256 id) view returns (uint256)',
	'function totalActiveMemberships() view returns (uint256)',
	'function getGlobalStatsFull(uint8 periodType, uint256 anchorTs, uint256 cumulativeStartTs) view returns (uint256 cumulativeMint, uint256 cumulativeBurn, uint256 cumulativeTransfer, uint256 cumulativeTransferAmount, uint256 cumulativeRedeemMint, uint256 cumulativeUSDCMint, uint256 cumulativeIssued, uint256 cumulativeUpgraded, uint256 periodMint, uint256 periodBurn, uint256 periodTransfer, uint256 periodTransferAmount, uint256 periodRedeemMint, uint256 periodUSDCMint, uint256 periodIssued, uint256 periodUpgraded, uint256 adminCount, uint256 cumulativeAdminToAdminTransfer, uint256 cumulativeAdminToAdminTransferAmount, uint256 periodAdminToAdminTransfer, uint256 periodAdminToAdminTransferAmount, uint256 lifetimeAdminToAdminTransferCount, uint256 lifetimeAdminToAdminTransferAmount)',
] as const

const IFACE_HOLDERS = new ethers.Interface([...CARD_HOLDER_METRICS_ABI])

/** 旧 AdminStatsQueryModule：`GlobalStatsFullView` 止于 `adminCount`（17×uint256）。新 module 追加 admin-to-admin 共 25 字。 */
function decodeGlobalStatsFullMintAndIssued(ret: string): { cumulativeMint: bigint; cumulativeIssuedPlusUpgraded: bigint } {
	const bytes = ethers.getBytes(ret)
	const wordCount = bytes.length / 32
	if (wordCount < 17) {
		throw new Error(`getGlobalStatsFull: expected at least 17 words, got ${wordCount}`)
	}
	const n = wordCount >= 25 ? 25 : 17
	const types = Array(n).fill('uint256') as string[]
	const d = ethers.AbiCoder.defaultAbiCoder().decode(types, ret)
	const cumulativeIssued = d[6] as bigint
	const cumulativeUpgraded = d[7] as bigint
	return {
		cumulativeMint: d[0] as bigint,
		cumulativeIssuedPlusUpgraded: cumulativeIssued + cumulativeUpgraded,
	}
}

function toSafeNonNegInt(n: bigint): number {
	const x = Number(n)
	if (!Number.isFinite(x) || x < 0) return 0
	if (x > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
	return Math.trunc(x)
}

/** ethers CALL_EXCEPTION 的 message 常带整段 transaction JSON，journald 刷屏；只保留可读前缀 */
function shortRpcCallErr(e: unknown): string {
	const x = e as { code?: string; message?: string }
	const code = x?.code != null ? String(x.code) : 'error'
	let msg = typeof x?.message === 'string' ? x.message : String(e)
	const cut = msg.indexOf('(action=')
	if (cut >= 0) msg = msg.slice(0, cut).trim()
	if (msg.length > 180) msg = `${msg.slice(0, 180)}…`
	return `${code}: ${msg}`
}

function shouldRetryRpcCall(e: unknown): boolean {
	const x = e as { code?: string; message?: string }
	if (x?.code === 'CALL_EXCEPTION') return true
	const m = String(x?.message ?? e)
	return m.includes('missing revert data')
}

async function ethCallWithOptionalRetry(
	provider: ethers.Provider,
	req: { to: string; data: string },
): Promise<string> {
	const delays = [300, 700] as const
	for (let attempt = 0; ; attempt++) {
		try {
			return await provider.call(req)
		} catch (e) {
			if (attempt < delays.length && shouldRetryRpcCall(e)) {
				await new Promise((r) => setTimeout(r, delays[attempt]))
				continue
			}
			throw e
		}
	}
}

/** prewarm 对 20/100/300 顺序各跑一遍，同卡会连错三次；限流同地址同类错误日志 */
const holderEnrichErrLogAt = new Map<string, number>()
const HOLDER_ENRICH_ERR_LOG_TTL_MS = 45_000

function shouldLogHolderEnrichErr(kind: string, cardAddress: string): boolean {
	const key = `${cardAddress.toLowerCase()}:${kind}`
	const now = Date.now()
	const last = holderEnrichErrLogAt.get(key) ?? 0
	if (now - last < HOLDER_ENRICH_ERR_LOG_TTL_MS) return false
	holderEnrichErrLogAt.set(key, now)
	if (holderEnrichErrLogAt.size > 2000) {
		for (const [k, t] of holderEnrichErrLogAt) {
			if (now - t > HOLDER_ENRICH_ERR_LOG_TTL_MS) holderEnrichErrLogAt.delete(k)
		}
	}
	return true
}

/**
 * RPC 对某卡持续返回 CALL_EXCEPTION 时，prewarm 仍每 6s×3 个 limit 重试 → 刷屏且打满节点。
 * 失败后进入冷却窗口，期间跳过 eth_call（holder 仍可用 totalActiveMemberships / totalSupply）。
 */
const globalStatsSkipUntil = new Map<string, number>()
const GLOBAL_STATS_FAIL_COOLDOWN_MS = 8 * 60 * 1000

function globalStatsCooldownRemainingMs(addrLower: string): number {
	const until = globalStatsSkipUntil.get(addrLower) ?? 0
	return Math.max(0, until - Date.now())
}

/**
 * latestCards：链上 enrichment。
 * - `holderCount`：`totalActiveMemberships`，否则 `cumulativeIssued + cumulativeUpgraded`。
 * - `token0TotalSupply6`：`totalSupply(0)` 当前流通。
 * - `token0CumulativeMint6`：`getGlobalStatsFull.cumulativeMint`（统计窗口内 token #0 累计 mint）。
 */
export async function enrichLatestCardsWithBaseErc1155PointsHolderCounts(
	items: BeamioLatestCardItem[],
	provider: ethers.Provider,
): Promise<BeamioLatestCardItem[]> {
	if (items.length === 0) return items
	const out: BeamioLatestCardItem[] = []
	for (const it of items) {
		try {
			const card = new ethers.Contract(it.cardAddress, CARD_HOLDER_METRICS_ABI, provider)
			let supply0 = 0n
			let active = 0n
			try {
				supply0 = (await card.totalSupply(POINTS_TOKEN_ID)) as bigint
			} catch (e: unknown) {
				if (shouldLogHolderEnrichErr('totalSupply0', it.cardAddress)) {
					logger(Colors.gray(`[latestCards holders] ${it.cardAddress} totalSupply(0): ${shortRpcCallErr(e)}`))
				}
			}
			try {
				active = (await card.totalActiveMemberships()) as bigint
			} catch (e: unknown) {
				if (shouldLogHolderEnrichErr('totalActiveMemberships', it.cardAddress)) {
					logger(Colors.gray(`[latestCards holders] ${it.cardAddress} totalActiveMemberships: ${shortRpcCallErr(e)}`))
				}
			}
			let cumulativeMint = 0n
			let issuedFallback = 0n
			const addrLo = (it.cardAddress || '').toLowerCase()
			const gsCool = addrLo ? globalStatsCooldownRemainingMs(addrLo) : 0
			if (gsCool <= 0) {
				try {
					const data = IFACE_HOLDERS.encodeFunctionData('getGlobalStatsFull', [PERIOD_HOUR, 0, 0])
					const ret = await ethCallWithOptionalRetry(provider, { to: it.cardAddress, data })
					const p = decodeGlobalStatsFullMintAndIssued(ret)
					cumulativeMint = p.cumulativeMint
					issuedFallback = p.cumulativeIssuedPlusUpgraded
					if (addrLo) globalStatsSkipUntil.delete(addrLo)
				} catch (e: unknown) {
					if (addrLo) globalStatsSkipUntil.set(addrLo, Date.now() + GLOBAL_STATS_FAIL_COOLDOWN_MS)
					if (shouldLogHolderEnrichErr('getGlobalStatsFull', it.cardAddress)) {
						logger(
							Colors.gray(
								`[latestCards holders] ${it.cardAddress} getGlobalStatsFull: ${shortRpcCallErr(e)} (cooldown ${GLOBAL_STATS_FAIL_COOLDOWN_MS / 60000}m)`,
							),
						)
					}
				}
			}
			let n = toSafeNonNegInt(active)
			if (n === 0) n = toSafeNonNegInt(issuedFallback)
			out.push({
				...it,
				holderCount: n,
				token0TotalSupply6: supply0.toString(),
				token0CumulativeMint6: cumulativeMint.toString(),
			})
		} catch (e: unknown) {
			if (shouldLogHolderEnrichErr('outer', it.cardAddress)) {
				logger(Colors.gray(`[latestCards holders] ${it.cardAddress}: ${shortRpcCallErr(e)}`))
			}
			out.push(it)
		}
	}
	return out
}
