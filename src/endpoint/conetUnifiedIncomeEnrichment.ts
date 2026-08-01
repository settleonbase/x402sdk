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
/** Blockscout validator UI always divides income totals by 10^18 (see mainnet.conet.network validator bundle). */
const BLOCKSCOUT_INCOME_DECIMALS = 18
/** GBDepinAirdrop paidGb* amounts are GB ERC20 9-dec; scale up before Blockscout 18-dec formatting. */
const GB_NINE_TO_EIGHTEEN_SCALE = 10n ** 9n

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

function bumpTotalsCumulative(t: IncomeTotals, rawWei: bigint): IncomeTotals {
	if (rawWei <= totalsRaw(t)) return t
	return {
		...t,
		cumulative: rawWei.toString(),
	}
}

/** Normalize GB cumulative to 18-dec wei for Blockscout (legacy indexer may already be 18-dec). */
function gbCumulativeAsEighteenDec(t: IncomeTotals): bigint {
	const raw = totalsRaw(t)
	if (raw <= 0n) return 0n
	if (raw < 10n ** 15n) return raw * GB_NINE_TO_EIGHTEEN_SCALE
	return raw
}

function bumpGbTotalsCumulative(t: IncomeTotals, paidGbNineDec: bigint): IncomeTotals {
	if (paidGbNineDec <= 0n) return t
	const paid18 = paidGbNineDec * GB_NINE_TO_EIGHTEEN_SCALE
	if (paid18 <= gbCumulativeAsEighteenDec(t)) return t
	return { ...t, cumulative: paid18.toString() }
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
		node.cnet = bumpTotalsCumulative(node.cnet, clWei)
	}
}

function mergeGuardianGbIntoNodes(stats: UnifiedIncomeStats, byGuardianGb: Map<number, bigint>): void {
	if (byGuardianGb.size === 0) return
	for (const node of stats.nodes) {
		const gid = (node as NodeIncomeRow & { guardianId?: number }).guardianId
		if (gid === undefined) continue
		const gbRaw = byGuardianGb.get(gid)
		if (gbRaw === undefined || gbRaw <= 0n) continue
		node.gb = bumpGbTotalsCumulative(node.gb, gbRaw)
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
		out.cnetBeneficiary = bumpTotalsCumulative(out.cnetBeneficiary, clPaid)
	}

	const guardianCl = getBeneficiaryGuardianClPaidMap(beneficiary)
	mergeGuardianClIntoNodes(out, guardianCl)

	const depinGb = await readDepinPaidGb(beneficiary, guardianIds)
	if (depinGb.total !== null && depinGb.total > 0n) {
		out.gbBeneficiary = bumpGbTotalsCumulative(out.gbBeneficiary, depinGb.total)
	}
	mergeGuardianGbIntoNodes(out, depinGb.byGuardian)

	// Single-node beneficiaries: per-guardian log cache may lag during daemon backfill.
	if (out.nodes.length === 1) {
		if (clPaid !== null && clPaid > totalsRaw(out.nodes[0].cnet)) {
			out.nodes[0].cnet = bumpTotalsCumulative(out.nodes[0].cnet, clPaid)
		}
		if (depinGb.total !== null && depinGb.total > 0n) {
			out.nodes[0].gb = bumpGbTotalsCumulative(out.nodes[0].gb, depinGb.total)
		}
	}

	return out
}

/** Blockscout validator page expects integer wei strings and divides by 10^18 client-side. */
export function adaptUnifiedIncomeStatsForBlockscoutValidatorUi(stats: UnifiedIncomeStats): UnifiedIncomeStats {
	const normalizeCnetTotals = (t: IncomeTotals): IncomeTotals => {
		const raw = String(t.cumulative ?? '0')
		if (!raw.includes('.')) return t
		try {
			return { ...t, cumulative: ethers.parseUnits(raw, NATIVE_DECIMALS).toString() }
		} catch {
			return t
		}
	}
	const normalizeGbTotals = (t: IncomeTotals): IncomeTotals => {
		const raw = totalsRaw(t)
		if (raw <= 0n) return t
		if (raw < 10n ** 15n) {
			return { ...t, cumulative: (raw * GB_NINE_TO_EIGHTEEN_SCALE).toString() }
		}
		return t
	}
	return {
		...stats,
		gbBeneficiary: normalizeGbTotals(stats.gbBeneficiary),
		cnetBeneficiary: normalizeCnetTotals(stats.cnetBeneficiary),
		nodes: stats.nodes.map((n) => ({
			...n,
			gb: normalizeGbTotals(n.gb),
			cnet: normalizeCnetTotals(n.cnet),
		})),
	}
}

/** Human-readable cumulative strings for PWA / JSON consumers that expect decimal units. */
export function formatEnrichedIncomeDisplay(stats: UnifiedIncomeStats): UnifiedIncomeStats {
	const fmt = (raw: string, decimals: number): string => {
		try {
			return ethers.formatUnits(BigInt(raw || '0'), decimals)
		} catch {
			return '0'
		}
	}
	const mapCnetTotals = (t: IncomeTotals): IncomeTotals => {
		const raw = String(t.cumulative || '0')
		if (raw.includes('.')) return t
		return { ...t, cumulative: fmt(raw, NATIVE_DECIMALS) }
	}
	const mapGbTotals = (t: IncomeTotals): IncomeTotals => {
		const raw = String(t.cumulative || '0')
		if (raw.includes('.')) return t
		const asBig = totalsRaw(t)
		const decimals = asBig >= 10n ** 15n ? BLOCKSCOUT_INCOME_DECIMALS : CONET_GB_DECIMALS
		return { ...t, cumulative: fmt(raw, decimals) }
	}
	return {
		...stats,
		gbBeneficiary: mapGbTotals(stats.gbBeneficiary),
		cnetBeneficiary: mapCnetTotals(stats.cnetBeneficiary),
		nodes: stats.nodes.map((n) => ({
			...n,
			gb: mapGbTotals(n.gb),
			cnet: mapCnetTotals(n.cnet),
		})),
	}
}
