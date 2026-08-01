import { ethers } from 'ethers'
import {
	CONET_GB_DECIMALS,
	CONET_VALIDATOR_DEPOSIT_REDEEM,
	resolveConetGbDepinAirdropAddress,
} from '../chainAddresses'
import { resolveBeamioConetHttpRpcUrl } from '../util'
import { getBeneficiaryGuardianClPaidMap } from './conetBlockscoutIncomeDaemon'
import type { IncomeTotals, NodeIncomeRow, UnifiedIncomeStats } from './validatorDepositRedeem'

const NATIVE_DECIMALS = 18

const REDEEM_VIEW_ABI = ['function clRewardPaid(address beneficiary) view returns (uint256)'] as const

const GB_DEPIN_LEDGER_ABI = [
	'function paidGbReceivedOf(address beneficiary) view returns (uint256)',
	'function paidGbReceivedOfGuardianNode(uint256 guardianNodeId) view returns (uint256)',
] as const

export type IncomeEnrichmentNodeHint = {
	guardianId: number
	depinNodeIp?: string | null
	nodeWallet?: string | null
}

function totalsRaw(t: IncomeTotals): bigint {
	try {
		return BigInt(String(t.cumulative || '0'))
	} catch {
		return 0n
	}
}

function bumpTotalsCumulative(t: IncomeTotals, rawWei: bigint, decimals: number): IncomeTotals {
	if (rawWei <= totalsRaw(t)) return t
	return {
		...t,
		cumulative: rawWei.toString(),
		// Blockscout validator UI formats cumulative with token decimals client-side.
		// Keep hour/day/week/month/year from indexer; only cumulative is authoritative on-chain.
	}
}

function normalizeIp(ip: unknown): string {
	return String(ip ?? '').trim()
}

function assignGuardianIds(stats: UnifiedIncomeStats, hints: IncomeEnrichmentNodeHint[]): void {
	if (hints.length === 0) return
	const byWallet = new Map<string, number>()
	const byIp = new Map<string, number>()
	for (const h of hints) {
		const wallet = String(h.nodeWallet ?? '').toLowerCase()
		if (wallet && wallet !== ethers.ZeroAddress.toLowerCase()) byWallet.set(wallet, h.guardianId)
		const ip = normalizeIp(h.depinNodeIp)
		if (ip) byIp.set(ip, h.guardianId)
	}
	for (const node of stats.nodes) {
		const ip = normalizeIp(node.depinNodeIp)
		const gidFromIp = ip ? byIp.get(ip) : undefined
		const gid =
			gidFromIp ??
			byWallet.get(String(node.nodeWallet ?? '').toLowerCase())
		if (gid !== undefined) (node as NodeIncomeRow & { guardianId?: number }).guardianId = gid
	}
}

function mergeGuardianClIntoNodes(stats: UnifiedIncomeStats, guardianCl: Map<number, bigint>): void {
	if (guardianCl.size === 0) return
	for (const node of stats.nodes) {
		const gid = (node as NodeIncomeRow & { guardianId?: number }).guardianId
		if (gid === undefined) continue
		const clWei = guardianCl.get(gid)
		if (clWei === undefined || clWei <= 0n) continue
		node.cnet = bumpTotalsCumulative(node.cnet, clWei, NATIVE_DECIMALS)
	}
}

function mergeGuardianGbIntoNodes(stats: UnifiedIncomeStats, byGuardianGb: Map<number, bigint>): void {
	if (byGuardianGb.size === 0) return
	for (const node of stats.nodes) {
		const gid = (node as NodeIncomeRow & { guardianId?: number }).guardianId
		if (gid === undefined) continue
		const gbRaw = byGuardianGb.get(gid)
		if (gbRaw === undefined || gbRaw <= 0n) continue
		node.gb = bumpTotalsCumulative(node.gb, gbRaw, CONET_GB_DECIMALS)
	}
}

async function readClRewardPaidWei(beneficiary: string): Promise<bigint | null> {
	try {
		const provider = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), undefined, { batchMaxCount: 1 })
		const c = new ethers.Contract(CONET_VALIDATOR_DEPOSIT_REDEEM, REDEEM_VIEW_ABI, provider)
		return BigInt(String(await c.clRewardPaid!(beneficiary)))
	} catch {
		return null
	}
}

async function readDepinPaidGb(
	beneficiary: string,
	guardianIds: number[],
): Promise<{ total: bigint | null; byGuardian: Map<number, bigint> }> {
	const airdrop = resolveConetGbDepinAirdropAddress()
	if (!airdrop) return { total: null, byGuardian: new Map() }
	try {
		const provider = new ethers.JsonRpcProvider(resolveBeamioConetHttpRpcUrl(), undefined, { batchMaxCount: 1 })
		const c = new ethers.Contract(airdrop, GB_DEPIN_LEDGER_ABI, provider)
		const total = BigInt(String(await c.paidGbReceivedOf!(beneficiary)))
		const byGuardian = new Map<number, bigint>()
		const unique = [...new Set(guardianIds.filter((id) => Number.isFinite(id) && id > 0))]
		if (unique.length > 0) {
			const rows = await Promise.all(
				unique.map(async (id) => {
					const v = BigInt(String(await c.paidGbReceivedOfGuardianNode!(id)))
					return [id, v] as const
				}),
			)
			for (const [id, v] of rows) {
				if (v > 0n) byGuardian.set(id, v)
			}
		}
		return { total, byGuardian }
	} catch {
		return { total: null, byGuardian: new Map() }
	}
}

/**
 * Merge authoritative on-chain ledgers into indexer-based UnifiedIncomeStats.
 * - CNET beneficiary ← clRewardPaid(beneficiary)
 * - CNET per-node ← Blockscout/RPC NodeRewardSettled cache by guardianId
 * - GB beneficiary ← paidGbReceivedOf(beneficiary) (Blockscout validator page reads gbBeneficiary)
 * - GB per-node ← paidGbReceivedOfGuardianNode
 */
export async function enrichUnifiedIncomeStats(
	stats: UnifiedIncomeStats,
	opts: {
		beneficiary: string
		clRewardPaidWei?: bigint | string | null
		nodeHints?: IncomeEnrichmentNodeHint[]
	},
): Promise<UnifiedIncomeStats> {
	let beneficiary: string
	try {
		beneficiary = ethers.getAddress(opts.beneficiary)
	} catch {
		return stats
	}

	const out: UnifiedIncomeStats = {
		...stats,
		beneficiary: stats.beneficiary ?? beneficiary,
		gbBeneficiary: { ...stats.gbBeneficiary },
		cnetBeneficiary: { ...stats.cnetBeneficiary },
		nodes: stats.nodes.map((n) => ({
			...n,
			gb: { ...n.gb },
			cnet: { ...n.cnet },
		})),
	}

	const hints = opts.nodeHints ?? []
	assignGuardianIds(out, hints)
	const guardianIds = [
		...new Set(
			hints.map((h) => h.guardianId).concat(
				out.nodes.map((n) => (n as NodeIncomeRow & { guardianId?: number }).guardianId).filter(
					(id): id is number => id !== undefined,
				),
			),
		),
	]

	let clPaid: bigint | null = null
	if (opts.clRewardPaidWei !== undefined && opts.clRewardPaidWei !== null) {
		try {
			clPaid = BigInt(String(opts.clRewardPaidWei))
		} catch {
			clPaid = null
		}
	}
	if (clPaid === null) clPaid = await readClRewardPaidWei(beneficiary)
	if (clPaid !== null && clPaid > 0n) {
		out.cnetBeneficiary = bumpTotalsCumulative(out.cnetBeneficiary, clPaid, NATIVE_DECIMALS)
	}

	const guardianCl = getBeneficiaryGuardianClPaidMap(beneficiary)
	mergeGuardianClIntoNodes(out, guardianCl)

	const depinGb = await readDepinPaidGb(beneficiary, guardianIds)
	if (depinGb.total !== null && depinGb.total > 0n) {
		out.gbBeneficiary = bumpTotalsCumulative(out.gbBeneficiary, depinGb.total, CONET_GB_DECIMALS)
	}
	mergeGuardianGbIntoNodes(out, depinGb.byGuardian)

	// Single-node beneficiaries: per-guardian log cache may lag during daemon backfill.
	if (out.nodes.length === 1) {
		if (clPaid !== null && clPaid > totalsRaw(out.nodes[0].cnet)) {
			out.nodes[0].cnet = bumpTotalsCumulative(out.nodes[0].cnet, clPaid, NATIVE_DECIMALS)
		}
		if (depinGb.total !== null && depinGb.total > totalsRaw(out.nodes[0].gb)) {
			out.nodes[0].gb = bumpTotalsCumulative(out.nodes[0].gb, depinGb.total, CONET_GB_DECIMALS)
		}
	}

	return out
}

/** Human-readable cumulative strings for API consumers that expect formatted units. */
export function formatEnrichedIncomeDisplay(stats: UnifiedIncomeStats): UnifiedIncomeStats {
	const fmt = (raw: string, decimals: number): string => {
		try {
			return ethers.formatUnits(BigInt(raw || '0'), decimals)
		} catch {
			return '0'
		}
	}
	const mapTotals = (t: IncomeTotals, decimals: number): IncomeTotals => {
		const raw = String(t.cumulative || '0')
		const asBig = (() => {
			try {
				return BigInt(raw)
			} catch {
				return 0n
			}
		})()
		// If already looks like a decimal string (contains '.'), leave as-is.
		if (raw.includes('.')) return t
		return { ...t, cumulative: fmt(String(asBig), decimals) }
	}
	return {
		...stats,
		gbBeneficiary: mapTotals(stats.gbBeneficiary, CONET_GB_DECIMALS),
		cnetBeneficiary: mapTotals(stats.cnetBeneficiary, NATIVE_DECIMALS),
		nodes: stats.nodes.map((n) => ({
			...n,
			gb: mapTotals(n.gb, CONET_GB_DECIMALS),
			cnet: mapTotals(n.cnet, NATIVE_DECIMALS),
		})),
	}
}
