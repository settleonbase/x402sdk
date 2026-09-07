"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enrichUnifiedIncomeStats = enrichUnifiedIncomeStats;
exports.adaptUnifiedIncomeStatsForBlockscoutValidatorUi = adaptUnifiedIncomeStatsForBlockscoutValidatorUi;
exports.formatEnrichedIncomeDisplay = formatEnrichedIncomeDisplay;
const ethers_1 = require("ethers");
const chainAddresses_1 = require("../chainAddresses");
const util_1 = require("../util");
const conetBlockscoutIncomeDaemon_1 = require("./conetBlockscoutIncomeDaemon");
const NATIVE_DECIMALS = 18;
/** Blockscout validator UI always divides income totals by 10^18 (see mainnet.conet.network validator bundle). */
const BLOCKSCOUT_INCOME_DECIMALS = 18;
/** GBDepinAirdrop paidGb* amounts are GB ERC20 9-dec; scale up before Blockscout 18-dec formatting. */
const GB_NINE_TO_EIGHTEEN_SCALE = 10n ** 9n;
/** Values below this are treated as 9-decimal GB raw (legacy ConetGB1155 mining stats use 18-dec). */
const GB_NINE_DEC_HEURISTIC_MAX = 10n ** 15n;
const INCOME_PERIOD_FIELDS = ['cumulative', 'hour', 'day', 'week', 'month', 'year'];
function fieldToBigInt(raw) {
    const s = String(raw ?? '0');
    if (!s || s === '0')
        return 0n;
    try {
        if (s.includes('.'))
            return ethers_1.ethers.parseUnits(s, NATIVE_DECIMALS);
        return BigInt(s);
    }
    catch {
        return 0n;
    }
}
function normalizeCnetIncomeField(raw) {
    return fieldToBigInt(raw).toString();
}
/** Scale 9-dec GB ledger fields to 18-dec wei strings for Blockscout `/10^18` formatting. */
function normalizeGbIncomeField(raw) {
    const v = fieldToBigInt(raw);
    if (v <= 0n)
        return '0';
    if (v < GB_NINE_DEC_HEURISTIC_MAX)
        return (v * GB_NINE_TO_EIGHTEEN_SCALE).toString();
    return v.toString();
}
function normalizeCnetIncomeTotals(t) {
    return {
        cumulative: normalizeCnetIncomeField(t.cumulative),
        hour: normalizeCnetIncomeField(t.hour),
        day: normalizeCnetIncomeField(t.day),
        week: normalizeCnetIncomeField(t.week),
        month: normalizeCnetIncomeField(t.month),
        year: normalizeCnetIncomeField(t.year),
    };
}
function normalizeGbIncomeTotals(t) {
    return {
        cumulative: normalizeGbIncomeField(t.cumulative),
        hour: normalizeGbIncomeField(t.hour),
        day: normalizeGbIncomeField(t.day),
        week: normalizeGbIncomeField(t.week),
        month: normalizeGbIncomeField(t.month),
        year: normalizeGbIncomeField(t.year),
    };
}
function maxIncomeTotals(a, b) {
    const out = { ...a };
    for (const k of INCOME_PERIOD_FIELDS) {
        const av = fieldToBigInt(a[k]);
        const bv = fieldToBigInt(b[k]);
        out[k] = (av >= bv ? av : bv).toString();
    }
    return out;
}
const REDEEM_VIEW_ABI = [
    'function resolveUnifiedIncomeStats(address maybeWallet, string conetDepinNodeIp, uint256 anchorTs) view returns (tuple(address beneficiary, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) gbBeneficiary, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) cnetBeneficiary, tuple(address nodeWallet, string depinNodeIp, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) gb, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) cnet)[] nodes))',
];
const GB_DEPIN_LEDGER_ABI = [
    'function paidGbReceivedOf(address beneficiary) view returns (uint256)',
    'function paidGbReceivedOfGuardianNode(uint256 guardianNodeId) view returns (uint256)',
    'function paidGbSummaryOf(address beneficiary, uint256 anchorTs) view returns (tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year))',
    'function paidGbSummaryOfGuardianNode(uint256 guardianNodeId, uint256 anchorTs) view returns (tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year))',
];
function totalsRaw(t) {
    try {
        return BigInt(String(t.cumulative || '0'));
    }
    catch {
        return 0n;
    }
}
function bumpTotalsCumulative(t, rawWei) {
    if (rawWei <= totalsRaw(t))
        return t;
    return {
        ...t,
        cumulative: rawWei.toString(),
    };
}
/** Normalize GB cumulative to 18-dec wei for Blockscout (legacy indexer may already be 18-dec). */
function gbCumulativeAsEighteenDec(t) {
    return fieldToBigInt(normalizeGbIncomeField(t.cumulative));
}
function bumpGbTotalsCumulative(t, paidGbNineDec) {
    if (paidGbNineDec <= 0n)
        return t;
    const paid18 = paidGbNineDec * GB_NINE_TO_EIGHTEEN_SCALE;
    if (paid18 <= gbCumulativeAsEighteenDec(t))
        return t;
    return { ...t, cumulative: paid18.toString() };
}
function normalizeIp(ip) {
    return String(ip ?? '').trim();
}
function assignGuardianIds(stats, hints) {
    if (hints.length === 0)
        return;
    const byWallet = new Map();
    const byIp = new Map();
    for (const h of hints) {
        const wallet = String(h.nodeWallet ?? '').toLowerCase();
        if (wallet && wallet !== ethers_1.ethers.ZeroAddress.toLowerCase())
            byWallet.set(wallet, h.guardianId);
        const ip = normalizeIp(h.depinNodeIp);
        if (ip)
            byIp.set(ip, h.guardianId);
    }
    for (const node of stats.nodes) {
        const ip = normalizeIp(node.depinNodeIp);
        const gidFromIp = ip ? byIp.get(ip) : undefined;
        const gid = gidFromIp ??
            byWallet.get(String(node.nodeWallet ?? '').toLowerCase());
        if (gid !== undefined)
            node.guardianId = gid;
    }
}
function mergeGuardianClIntoNodes(stats, guardianCl) {
    if (guardianCl.size === 0)
        return;
    for (const node of stats.nodes) {
        const gid = node.guardianId;
        if (gid === undefined)
            continue;
        const clWei = guardianCl.get(gid);
        if (clWei === undefined || clWei <= 0n)
            continue;
        node.cnet = bumpTotalsCumulative(node.cnet, clWei);
    }
}
function mergeGuardianGbIntoNodes(stats, byGuardianGb) {
    if (byGuardianGb.size === 0)
        return;
    for (const node of stats.nodes) {
        const gid = node.guardianId;
        if (gid === undefined)
            continue;
        const gbRaw = byGuardianGb.get(gid);
        if (gbRaw === undefined || gbRaw <= 0n)
            continue;
        node.gb = bumpGbTotalsCumulative(node.gb, gbRaw);
    }
}
/** Blockscout beneficiary panels read gbBeneficiary/cnetBeneficiary, not per-node rows. */
function rollupNodeIncomeToBeneficiary(stats) {
    if (stats.nodes.length === 0)
        return;
    for (const k of INCOME_PERIOD_FIELDS) {
        let gbMax = fieldToBigInt(stats.gbBeneficiary[k]);
        let cnetMax = fieldToBigInt(stats.cnetBeneficiary[k]);
        for (const node of stats.nodes) {
            const gv = fieldToBigInt(node.gb[k]);
            const cv = fieldToBigInt(node.cnet[k]);
            if (gv > gbMax)
                gbMax = gv;
            if (cv > cnetMax)
                cnetMax = cv;
        }
        stats.gbBeneficiary[k] = gbMax.toString();
        stats.cnetBeneficiary[k] = cnetMax.toString();
    }
}
async function readClPaidSummary(beneficiary, anchorTs = 0) {
    try {
        const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)(), undefined, { batchMaxCount: 1 });
        const c = new ethers_1.ethers.Contract(chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM, REDEEM_VIEW_ABI, provider);
        const stats = await c.resolveUnifiedIncomeStats(beneficiary, '', BigInt(Math.max(0, anchorTs)));
        const row = stats.cnetBeneficiary ?? stats[2];
        if (!row)
            return null;
        const get = (i, k) => BigInt(String(Array.isArray(row) ? row[i] : row[k] ?? 0));
        return {
            cumulative: get(0, 'cumulative').toString(),
            hour: get(1, 'hour').toString(),
            day: get(2, 'day').toString(),
            week: get(3, 'week').toString(),
            month: get(4, 'month').toString(),
            year: get(5, 'year').toString(),
        };
    }
    catch {
        return null;
    }
}
async function readDepinPaidGbSummary(beneficiary, guardianIds, anchorTs = 0) {
    const airdrop = (0, chainAddresses_1.resolveConetGbDepinAirdropAddress)();
    if (!airdrop)
        return { beneficiary: null, byGuardian: new Map() };
    const parseSummary = (t) => {
        const row = t;
        const get = (i, k) => BigInt(String(Array.isArray(row) ? row[i] : row[k] ?? 0));
        return {
            cumulative: get(0, 'cumulative').toString(),
            hour: get(1, 'hour').toString(),
            day: get(2, 'day').toString(),
            week: get(3, 'week').toString(),
            month: get(4, 'month').toString(),
            year: get(5, 'year').toString(),
        };
    };
    try {
        const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)(), undefined, { batchMaxCount: 1 });
        const c = new ethers_1.ethers.Contract(airdrop, GB_DEPIN_LEDGER_ABI, provider);
        const ts = BigInt(Math.max(0, anchorTs));
        const beneficiarySummary = parseSummary(await c.paidGbSummaryOf(beneficiary, ts));
        const byGuardian = new Map();
        const unique = [...new Set(guardianIds.filter((id) => Number.isFinite(id) && id > 0))];
        if (unique.length > 0) {
            const rows = await Promise.all(unique.map(async (id) => {
                const s = parseSummary(await c.paidGbSummaryOfGuardianNode(id, ts));
                return [id, s];
            }));
            for (const [id, s] of rows)
                byGuardian.set(id, s);
        }
        return { beneficiary: beneficiarySummary, byGuardian };
    }
    catch {
        return { beneficiary: null, byGuardian: new Map() };
    }
}
async function readClRewardPaidWei(_beneficiary) {
    // clRewardPaid mapping is private on upgraded VDR; CL settle totals merge in resolveUnifiedIncomeStats.
    return null;
}
async function readDepinPaidGb(beneficiary, guardianIds) {
    const airdrop = (0, chainAddresses_1.resolveConetGbDepinAirdropAddress)();
    if (!airdrop)
        return { total: null, byGuardian: new Map() };
    try {
        const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)(), undefined, { batchMaxCount: 1 });
        const c = new ethers_1.ethers.Contract(airdrop, GB_DEPIN_LEDGER_ABI, provider);
        const total = BigInt(String(await c.paidGbReceivedOf(beneficiary)));
        const byGuardian = new Map();
        const unique = [...new Set(guardianIds.filter((id) => Number.isFinite(id) && id > 0))];
        if (unique.length > 0) {
            const rows = await Promise.all(unique.map(async (id) => {
                const v = BigInt(String(await c.paidGbReceivedOfGuardianNode(id)));
                return [id, v];
            }));
            for (const [id, v] of rows) {
                if (v > 0n)
                    byGuardian.set(id, v);
            }
        }
        return { total, byGuardian };
    }
    catch {
        return { total: null, byGuardian: new Map() };
    }
}
/**
 * Merge authoritative on-chain ledgers into indexer-based UnifiedIncomeStats.
 * - CNET beneficiary ← clRewardPaid(beneficiary)
 * - CNET per-node ← Blockscout/RPC NodeRewardSettled cache by guardianId
 * - GB beneficiary ← paidGbReceivedOf(beneficiary) (Blockscout validator page reads gbBeneficiary)
 * - GB per-node ← paidGbReceivedOfGuardianNode
 */
async function enrichUnifiedIncomeStats(stats, opts) {
    let beneficiary;
    try {
        beneficiary = ethers_1.ethers.getAddress(opts.beneficiary);
    }
    catch {
        return stats;
    }
    const out = {
        ...stats,
        beneficiary: stats.beneficiary ?? beneficiary,
        gbBeneficiary: { ...stats.gbBeneficiary },
        cnetBeneficiary: { ...stats.cnetBeneficiary },
        nodes: stats.nodes.map((n) => ({
            ...n,
            gb: { ...n.gb },
            cnet: { ...n.cnet },
        })),
    };
    const hints = opts.nodeHints ?? [];
    assignGuardianIds(out, hints);
    const guardianIds = [
        ...new Set(hints.map((h) => h.guardianId).concat(out.nodes.map((n) => n.guardianId).filter((id) => id !== undefined))),
    ];
    let clPaid = null;
    if (opts.clRewardPaidWei !== undefined && opts.clRewardPaidWei !== null) {
        try {
            clPaid = BigInt(String(opts.clRewardPaidWei));
        }
        catch {
            clPaid = null;
        }
    }
    if (clPaid === null)
        clPaid = await readClRewardPaidWei(beneficiary);
    if (clPaid !== null && clPaid > 0n) {
        out.cnetBeneficiary = bumpTotalsCumulative(out.cnetBeneficiary, clPaid);
    }
    const clSummary = await readClPaidSummary(beneficiary);
    if (clSummary) {
        out.cnetBeneficiary = maxIncomeTotals(out.cnetBeneficiary, clSummary);
    }
    const guardianCl = (0, conetBlockscoutIncomeDaemon_1.getBeneficiaryGuardianClPaidMap)(beneficiary);
    mergeGuardianClIntoNodes(out, guardianCl);
    const depinGb = await readDepinPaidGb(beneficiary, guardianIds);
    if (depinGb.total !== null && depinGb.total > 0n) {
        out.gbBeneficiary = bumpGbTotalsCumulative(out.gbBeneficiary, depinGb.total);
    }
    mergeGuardianGbIntoNodes(out, depinGb.byGuardian);
    const depinSummary = await readDepinPaidGbSummary(beneficiary, guardianIds);
    if (depinSummary.beneficiary) {
        out.gbBeneficiary = maxIncomeTotals(out.gbBeneficiary, depinSummary.beneficiary);
    }
    if (depinSummary.byGuardian.size > 0) {
        for (const node of out.nodes) {
            const gid = node.guardianId;
            if (gid === undefined)
                continue;
            const s = depinSummary.byGuardian.get(gid);
            if (!s)
                continue;
            node.gb = maxIncomeTotals(node.gb, s);
        }
    }
    // Single-node beneficiaries: per-guardian log cache may lag during daemon backfill.
    if (out.nodes.length === 1) {
        if (clPaid !== null && clPaid > totalsRaw(out.nodes[0].cnet)) {
            out.nodes[0].cnet = bumpTotalsCumulative(out.nodes[0].cnet, clPaid);
        }
        if (depinGb.total !== null && depinGb.total > 0n) {
            out.nodes[0].gb = bumpGbTotalsCumulative(out.nodes[0].gb, depinGb.total);
        }
    }
    rollupNodeIncomeToBeneficiary(out);
    return out;
}
/** Blockscout validator page expects integer wei strings and divides by 10^18 client-side for all six period fields. */
function adaptUnifiedIncomeStatsForBlockscoutValidatorUi(stats) {
    return {
        ...stats,
        gbBeneficiary: normalizeGbIncomeTotals(stats.gbBeneficiary),
        cnetBeneficiary: normalizeCnetIncomeTotals(stats.cnetBeneficiary),
        nodes: stats.nodes.map((n) => ({
            ...n,
            gb: normalizeGbIncomeTotals(n.gb),
            cnet: normalizeCnetIncomeTotals(n.cnet),
        })),
    };
}
/** Human-readable cumulative strings for PWA / JSON consumers that expect decimal units. */
function formatEnrichedIncomeDisplay(stats) {
    const fmt = (raw, decimals) => {
        try {
            return ethers_1.ethers.formatUnits(BigInt(raw || '0'), decimals);
        }
        catch {
            return '0';
        }
    };
    const mapCnetTotals = (t) => {
        const raw = String(t.cumulative || '0');
        if (raw.includes('.'))
            return t;
        return { ...t, cumulative: fmt(raw, NATIVE_DECIMALS) };
    };
    const mapGbTotals = (t) => {
        const raw = String(t.cumulative || '0');
        if (raw.includes('.'))
            return t;
        const asBig = totalsRaw(t);
        const decimals = asBig >= 10n ** 15n ? BLOCKSCOUT_INCOME_DECIMALS : chainAddresses_1.CONET_GB_DECIMALS;
        return { ...t, cumulative: fmt(raw, decimals) };
    };
    return {
        ...stats,
        gbBeneficiary: mapGbTotals(stats.gbBeneficiary),
        cnetBeneficiary: mapCnetTotals(stats.cnetBeneficiary),
        nodes: stats.nodes.map((n) => ({
            ...n,
            gb: mapGbTotals(n.gb),
            cnet: mapCnetTotals(n.cnet),
        })),
    };
}
