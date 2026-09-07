"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.enrichLatestCardsWithBaseErc1155PointsHolderCounts = enrichLatestCardsWithBaseErc1155PointsHolderCounts;
const ethers_1 = require("ethers");
const logger_1 = require("../logger");
const safe_1 = __importDefault(require("colors/safe"));
const beamioUserCardChain_1 = require("../beamioUserCardChain");
/** AdminStatsPeriodLib: valid periodType; cumulative slice when cumulativeStartTs=0 仍见合约实现 */
const PERIOD_HOUR = 0;
const POINTS_TOKEN_ID = 0n;
/**
 * Full `GlobalStatsFullView` 与链上 `BeamioUserCardAdminStatsQueryModuleV1.getGlobalStatsFull` 一致（经 BeamioUserCard fallback）。
 * @see src/BeamioUserCard/readme.md — getGlobalStatsFull
 */
/** 链上读数用 ABI；`getGlobalStatsFull` 的返回值在 Master 侧用手动长度分支解码（旧 module 17 字 vs 新 module 25 字）。 */
const CARD_HOLDER_METRICS_ABI = [
    'function totalSupply(uint256 id) view returns (uint256)',
    'function totalActiveMemberships() view returns (uint256)',
    'function getGlobalStatsFull(uint8 periodType, uint256 anchorTs, uint256 cumulativeStartTs) view returns (uint256 cumulativeMint, uint256 cumulativeBurn, uint256 cumulativeTransfer, uint256 cumulativeTransferAmount, uint256 cumulativeRedeemMint, uint256 cumulativeUSDCMint, uint256 cumulativeIssued, uint256 cumulativeUpgraded, uint256 periodMint, uint256 periodBurn, uint256 periodTransfer, uint256 periodTransferAmount, uint256 periodRedeemMint, uint256 periodUSDCMint, uint256 periodIssued, uint256 periodUpgraded, uint256 adminCount, uint256 cumulativeAdminToAdminTransfer, uint256 cumulativeAdminToAdminTransferAmount, uint256 periodAdminToAdminTransfer, uint256 periodAdminToAdminTransferAmount, uint256 lifetimeAdminToAdminTransferCount, uint256 lifetimeAdminToAdminTransferAmount)',
];
const IFACE_HOLDERS = new ethers_1.ethers.Interface([...CARD_HOLDER_METRICS_ABI]);
/** 旧 AdminStatsQueryModule：`GlobalStatsFullView` 止于 `adminCount`（17×uint256）。新 module 追加 admin-to-admin 共 25 字。 */
function decodeGlobalStatsFullMintAndIssued(ret) {
    const bytes = ethers_1.ethers.getBytes(ret);
    const wordCount = bytes.length / 32;
    if (wordCount < 17) {
        throw new Error(`getGlobalStatsFull: expected at least 17 words, got ${wordCount}`);
    }
    const n = wordCount >= 25 ? 25 : 17;
    const types = Array(n).fill('uint256');
    const d = ethers_1.ethers.AbiCoder.defaultAbiCoder().decode(types, ret);
    const cumulativeIssued = d[6];
    const cumulativeUpgraded = d[7];
    return {
        cumulativeMint: d[0],
        cumulativeIssuedPlusUpgraded: cumulativeIssued + cumulativeUpgraded,
    };
}
function toSafeNonNegInt(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x < 0)
        return 0;
    if (x > Number.MAX_SAFE_INTEGER)
        return Number.MAX_SAFE_INTEGER;
    return Math.trunc(x);
}
/** ethers CALL_EXCEPTION 的 message 常带整段 transaction JSON，journald 刷屏；只保留可读前缀 */
function shortRpcCallErr(e) {
    const x = e;
    const code = x?.code != null ? String(x.code) : 'error';
    let msg = typeof x?.message === 'string' ? x.message : String(e);
    const cut = msg.indexOf('(action=');
    if (cut >= 0)
        msg = msg.slice(0, cut).trim();
    if (msg.length > 180)
        msg = `${msg.slice(0, 180)}…`;
    return `${code}: ${msg}`;
}
function shouldRetryRpcCall(e) {
    const x = e;
    if (x?.code === 'CALL_EXCEPTION')
        return true;
    const m = String(x?.message ?? e);
    return m.includes('missing revert data');
}
async function ethCallWithOptionalRetry(provider, req) {
    const delays = [300, 700];
    for (let attempt = 0;; attempt++) {
        try {
            return await provider.call(req);
        }
        catch (e) {
            if (attempt < delays.length && shouldRetryRpcCall(e)) {
                await new Promise((r) => setTimeout(r, delays[attempt]));
                continue;
            }
            throw e;
        }
    }
}
/** prewarm 对 20/100/300 顺序各跑一遍，同卡会连错三次；限流同地址同类错误日志 */
const holderEnrichErrLogAt = new Map();
const HOLDER_ENRICH_ERR_LOG_TTL_MS = 45_000;
function shouldLogHolderEnrichErr(kind, cardAddress) {
    const key = `${cardAddress.toLowerCase()}:${kind}`;
    const now = Date.now();
    const last = holderEnrichErrLogAt.get(key) ?? 0;
    if (now - last < HOLDER_ENRICH_ERR_LOG_TTL_MS)
        return false;
    holderEnrichErrLogAt.set(key, now);
    if (holderEnrichErrLogAt.size > 2000) {
        for (const [k, t] of holderEnrichErrLogAt) {
            if (now - t > HOLDER_ENRICH_ERR_LOG_TTL_MS)
                holderEnrichErrLogAt.delete(k);
        }
    }
    return true;
}
/**
 * RPC 对某卡持续返回 CALL_EXCEPTION 时，prewarm 仍每 6s×3 个 limit 重试 → 刷屏且打满节点。
 * 失败后进入冷却窗口，期间跳过 eth_call（holder 仍可用 totalActiveMemberships / totalSupply）。
 */
const globalStatsSkipUntil = new Map();
const GLOBAL_STATS_FAIL_COOLDOWN_MS = 8 * 60 * 1000;
function globalStatsCooldownRemainingMs(addrLower) {
    const until = globalStatsSkipUntil.get(addrLower) ?? 0;
    return Math.max(0, until - Date.now());
}
const cardEnrichCache = new Map();
const CARD_ENRICH_TTL_MS = 30 * 1000;
/** 同一时刻 enrich 的最大单卡并发数。base-rpc 单 call ~200ms，10 路 ≈ 2s/批，足以服务 limit≤300 不超 nginx 60s */
const ENRICH_CONCURRENCY = 10;
/** 单卡 enrichment 总预算：超过即放弃该卡（保留旧 cache 或 0），不让一卡拖慢整批 */
const PER_CARD_BUDGET_MS = 8_000;
function withTimeout(p, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
async function enrichOneCard(cardAddress, provider) {
    const card = new ethers_1.ethers.Contract(cardAddress, CARD_HOLDER_METRICS_ABI, provider);
    const addrLo = cardAddress.toLowerCase();
    const gsCool = globalStatsCooldownRemainingMs(addrLo);
    // 并发 3 个 RPC：totalSupply(0)、totalActiveMemberships、getGlobalStatsFull
    const supplyP = card.totalSupply(POINTS_TOKEN_ID).catch((e) => {
        if (shouldLogHolderEnrichErr('totalSupply0', cardAddress)) {
            (0, logger_1.logger)(safe_1.default.gray(`[latestCards holders] ${cardAddress} totalSupply(0): ${shortRpcCallErr(e)}`));
        }
        return 0n;
    });
    const activeP = card.totalActiveMemberships().catch((e) => {
        if (shouldLogHolderEnrichErr('totalActiveMemberships', cardAddress)) {
            (0, logger_1.logger)(safe_1.default.gray(`[latestCards holders] ${cardAddress} totalActiveMemberships: ${shortRpcCallErr(e)}`));
        }
        return 0n;
    });
    const statsP = gsCool > 0
        ? Promise.resolve({ cumulativeMint: 0n, cumulativeIssuedPlusUpgraded: 0n })
        : (async () => {
            try {
                const data = IFACE_HOLDERS.encodeFunctionData('getGlobalStatsFull', [PERIOD_HOUR, 0, 0]);
                const ret = await ethCallWithOptionalRetry(provider, { to: cardAddress, data });
                const p = decodeGlobalStatsFullMintAndIssued(ret);
                globalStatsSkipUntil.delete(addrLo);
                return p;
            }
            catch (e) {
                globalStatsSkipUntil.set(addrLo, Date.now() + GLOBAL_STATS_FAIL_COOLDOWN_MS);
                // Optional enrichment only. Some deployed cards/modules do not expose stats through fallback;
                // keep latestCards healthy and avoid noisy restart/prewarm logs.
                return { cumulativeMint: 0n, cumulativeIssuedPlusUpgraded: 0n };
            }
        })();
    const [supply0, active, stats] = await Promise.all([supplyP, activeP, statsP]);
    let n = toSafeNonNegInt(active);
    if (n === 0)
        n = toSafeNonNegInt(stats.cumulativeIssuedPlusUpgraded);
    return {
        holderCount: n,
        token0TotalSupply6: supply0.toString(),
        token0CumulativeMint6: stats.cumulativeMint.toString(),
    };
}
/** 受控并发：windowed promise pool */
async function runWithConcurrency(tasks, concurrency) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= tasks.length)
                return;
            results[idx] = await tasks[idx]();
        }
    });
    await Promise.all(workers);
    return results;
}
/**
 * latestCards：链上 enrichment。
 * - `holderCount`：`totalActiveMemberships`，否则 `cumulativeIssued + cumulativeUpgraded`。
 * - `token0TotalSupply6`：`totalSupply(0)` 当前流通。
 * - `token0CumulativeMint6`：`getGlobalStatsFull.cumulativeMint`（统计窗口内 token #0 累计 mint）。
 *
 * 性能与可信性约束（对应 .cursor/rules/beamio-chain-fetch-protocol.mdc / beamio-trusted-vs-untrusted-fetch.mdc）：
 * - per-card 30s TTL cache（命中直接返回，无 RPC）
 * - 单卡 3 个 RPC 并发；外层受控并发（默认 10 路）
 * - 单卡总预算 8s，超时按 untrusted 处理：保留上次 trusted cache 字段，无 cache 时返回原 item（不写入 cache、不当作 0 holder）
 */
async function enrichLatestCardsWithBaseErc1155PointsHolderCounts(items, provider) {
    if (items.length === 0)
        return items;
    const now = Date.now();
    const tasks = items.map((it) => async () => {
        const addrLo = (it.cardAddress || '').toLowerCase();
        const cached = cardEnrichCache.get(addrLo);
        if (cached && now < cached.expiry) {
            return { ...it, ...cached.value };
        }
        try {
            const cardProvider = await (0, beamioUserCardChain_1.resolveUserCardChain)(it.cardAddress)
                .then((chain) => (0, beamioUserCardChain_1.providerForUserCardChain)(chain))
                .catch(() => provider);
            const fresh = await withTimeout(enrichOneCard(it.cardAddress, cardProvider), PER_CARD_BUDGET_MS, `enrich ${it.cardAddress}`);
            // trusted success：写 cache（缺失字段也算 trusted，因为上游 catch 已用 0 兜底；如果连
            // 整个卡都因 timeout 抛出，则走下面 untrusted 分支不写 cache）
            cardEnrichCache.set(addrLo, { value: fresh, expiry: Date.now() + CARD_ENRICH_TTL_MS });
            return { ...it, ...fresh };
        }
        catch (e) {
            if (shouldLogHolderEnrichErr('outer', it.cardAddress)) {
                (0, logger_1.logger)(safe_1.default.gray(`[latestCards holders] ${it.cardAddress}: ${shortRpcCallErr(e)}`));
            }
            // untrusted：保留上次 trusted cache（即使过期），避免把已确认数据当成 0；都没有就返回原 item
            if (cached)
                return { ...it, ...cached.value };
            return it;
        }
    });
    return runWithConcurrency(tasks, ENRICH_CONCURRENCY);
}
