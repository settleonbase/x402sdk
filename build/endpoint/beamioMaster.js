"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const util_1 = require("../util");
const node_path_1 = require("node:path");
const node_fs_1 = __importDefault(require("node:fs"));
const logger_1 = require("../logger");
const node_util_1 = require("node:util");
const safe_1 = __importDefault(require("colors/safe"));
const db_1 = require("../db");
const coinbase_1 = require("../coinbase");
const ethers_1 = require("ethers");
const offlineChatPush_1 = require("./offlineChatPush");
const merchantKitStripe_1 = require("./merchantKitStripe");
const eoaUsdcStripe_1 = require("./eoaUsdcStripe");
const stripeBeamioHook_1 = require("./stripeBeamioHook");
const MemberCard_1 = require("../MemberCard");
const chainAddresses_1 = require("../chainAddresses");
const beamioUserCardChain_1 = require("../beamioUserCardChain");
const aaTransferRelayChain_1 = require("../aaTransferRelayChain");
const enrichLatestCardsHolderCounts_1 = require("./enrichLatestCardsHolderCounts");
const latestCardsShared_1 = require("./latestCardsShared");
const couponDiscoverFilter_1 = require("./couponDiscoverFilter");
const MemberCard_2 = require("../MemberCard");
const genesisNodeReferralRedeem_1 = require("../genesisNodeReferralRedeem");
const chatIndexPointer_1 = require("../chatIndexPointer");
const gbDepinAirdrop_1 = require("../gbDepinAirdrop");
const treasuryStableSwapRelay_1 = require("../treasuryStableSwapRelay");
const MemberCard_3 = require("../MemberCard");
const issuedCouponSeriesQueryCache_1 = require("./issuedCouponSeriesQueryCache");
const latestCardsQueryCache_1 = require("./latestCardsQueryCache");
const issuedCouponSocialPromotionMetadataSync_1 = require("./issuedCouponSocialPromotionMetadataSync");
const apiExcludedUserCards_1 = require("../apiExcludedUserCards");
const userCumulativeStatRewardPoolMaster_1 = require("../userCumulativeStatRewardPoolMaster");
const redeemReward13ForUsdc_1 = require("../redeemReward13ForUsdc");
const convertReward13_1 = require("../convertReward13");
const topupWithReward13Container_1 = require("../topupWithReward13Container");
const excludeUserCardApi_1 = require("../excludeUserCardApi");
const getUIDAssetsLogic_1 = require("./getUIDAssetsLogic");
const resolveBeamioAaViaUserCardFactory_1 = require("./resolveBeamioAaViaUserCardFactory");
const couponMetadataCategory_1 = require("../couponMetadataCategory");
const longDhangConetMigration_1 = require("./longDhangConetMigration");
const validatorDepositRedeem_1 = require("./validatorDepositRedeem");
const treasuryBridgeFulfill_1 = require("./treasuryBridgeFulfill");
const fuelPackFulfill_1 = require("./fuelPackFulfill");
const masterServerPort = 1111;
/** HTTP 记账 body 中的 routeItems 归一化（与 MemberCard 内存路径一致） */
function normalizeBeamioRouteItemsFromBody(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return undefined;
    }
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const r = entry;
        const asset = r.asset;
        if (typeof asset !== 'string' || !ethers_1.ethers.isAddress(asset)) {
            continue;
        }
        if (r.amountE6 == null) {
            continue;
        }
        out.push({
            asset: ethers_1.ethers.getAddress(asset),
            amountE6: String(r.amountE6),
            assetType: typeof r.assetType === 'number' && Number.isFinite(r.assetType) ? r.assetType : Number(r.assetType ?? 0),
            source: typeof r.source === 'number' && Number.isFinite(r.source) ? r.source : Number(r.source ?? 0),
            tokenId: r.tokenId != null ? String(r.tokenId) : '0',
            itemCurrencyType: r.itemCurrencyType !== undefined && r.itemCurrencyType !== null ? Number(r.itemCurrencyType) : undefined,
            offsetInRequestCurrencyE6: r.offsetInRequestCurrencyE6 != null ? String(r.offsetInRequestCurrencyE6) : undefined,
        });
    }
    return out.length ? out : undefined;
}
const ISSUED_NFT_START_ID = 100000000000n;
const BEAMIO_USER_CARD_ISSUED_NFT_ABI = [
    'function issuedNftIndex() view returns (uint256)',
    'function issuedNftTitle(uint256) view returns (bytes32)',
    'function issuedNftSharedMetadataHash(uint256) view returns (bytes32)',
    'function issuedNftValidAfter(uint256) view returns (uint64)',
    'function issuedNftValidBefore(uint256) view returns (uint64)',
    'function issuedNftMaxSupply(uint256) view returns (uint256)',
    'function issuedNftMintedCount(uint256) view returns (uint256)',
    'function issuedNftPriceInCurrency6(uint256) view returns (uint256)',
    'function isIssuedNftValid(uint256 tokenId) view returns (bool)',
    'function owner() view returns (address)',
];
const BASE_RPC_URL = (0, util_1.resolveBeamioBaseHttpRpcUrl)();
/**
 * Disable JSON-RPC batch (与 MemberCard.ts 一致)。base-rpc.conet.network 上游网关在 batch
 * 响应顺序与请求 id 不对齐时会让 ethers 等到 default request timeout（~30s/请求），
 * 直接表现为 Trending Now 单卡 enrichment 用 25s+ 而 base-rpc 单 call 实测仅 ~200ms。
 */
const providerBaseForLatestCards = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL, undefined, { batchMaxCount: 1 });
function setOrDeleteStringField(target, key, value) {
    const v = String(value ?? '').trim();
    if (v) {
        target[key] = v;
        return;
    }
    delete target[key];
}
function setOrDeleteBooleanField(target, key, value) {
    if (value) {
        target[key] = true;
        return;
    }
    delete target[key];
}
/** Log helper: avoid dumping full URLs; show IPFS fragment hash when present. */
function summarizeCouponIconForDebugLog(icon) {
    const s = String(icon ?? '').trim();
    if (!s)
        return '(empty)';
    const m = s.match(/hash=(0x[a-fA-F0-9]+)/i);
    if (m)
        return `hash=${m[1]} len=${s.length}`;
    return `len=${s.length} head=${s.slice(0, 80)}`;
}
/** When `shareTokenMetadata.coupons` is empty/out-of-sync, authorize updates from `beamio_nft_series.metadata_json`. */
function seriesMetadataMatchesIssuedCoupon(metadata, couponId, issuedTokenIdNorm) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        return false;
    const m = metadata;
    const rootId = String(m.couponId ?? m.id ?? '').trim();
    const rootTok = String(m.issuedTokenId ?? '').trim();
    if (rootId === couponId) {
        if (rootTok === '' || rootTok === issuedTokenIdNorm)
            return true;
    }
    const props = m.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        const bc = props.beamioCoupon;
        if (bc && typeof bc === 'object' && !Array.isArray(bc)) {
            const b = bc;
            const bid = String(b.couponId ?? b.id ?? '').trim();
            const btok = String(b.issuedTokenId ?? '').trim();
            if (bid === couponId) {
                if (btok === '' || btok === issuedTokenIdNorm)
                    return true;
            }
        }
    }
    return false;
}
/** Beamio 默认 metadata image（与 BeamioUserCard 一致） */
const DEFAULT_METADATA_IMAGE_URL = 'https://ipfs.conet.network/api/getFragment?hash=0x44e7a175e57a337bf5d0a98deb19a0a545e362d504092a7af1aecd58798eab';
/** Base mainnet chain id —— EIP-712 ExecuteForAdmin domain 用 */
const MASTER_BASE_CHAIN_ID = 8453;
const MASTER_CHARGE_SESSION_TTL_MS = 10 * 60 * 1000;
const masterChargeSessions = new Map();
const MASTER_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const masterIsValidSid = (sid) => typeof sid === 'string' && MASTER_UUID_V4_RE.test(sid);
const masterPruneExpiredChargeSessions = () => {
    const now = Date.now();
    for (const [k, v] of masterChargeSessions) {
        if (now - v.updatedAt > MASTER_CHARGE_SESSION_TTL_MS)
            masterChargeSessions.delete(k);
    }
};
const masterMakeFreshChargeSession = (sid, now) => ({
    sid,
    state: 'verifying',
    cardAddr: '',
    pos: null,
    cardOwner: null,
    currency: null,
    subtotal: '0',
    discount: '0',
    tax: '0',
    tip: '0',
    total: '0',
    discountBps: 0,
    taxBps: 0,
    tipBps: 0,
    usdcAmount6: null,
    USDC_tx: null,
    payer: null,
    error: null,
    tmpEOA: null,
    tmpAA: null,
    pointsMinted6: null,
    topupTxHash: null,
    chargeTxHash: null,
    pendingTopupCardAddr: null,
    pendingTopupRecipientEOA: null,
    pendingTopupData: null,
    pendingTopupDeadline: null,
    pendingTopupNonce: null,
    pendingTopupPoints6: null,
    pendingTopupBUnitFee: null,
    pendingTopupVerifyingContract: null,
    posTopupSignature: null,
    createdAt: now,
    updatedAt: now,
});
const ensureMetadataImage = (meta) => {
    const props = (meta.properties && typeof meta.properties === 'object') ? meta.properties : {};
    const image = [meta.image, meta.image_url, meta.imageUrl, props.image, DEFAULT_METADATA_IMAGE_URL]
        .find((v) => typeof v === 'string' && v.trim() !== '');
    if (image)
        meta.image = image;
    return meta;
};
/** 通用查询缓存：30 秒协议 */
const QUERY_CACHE_TTL_MS = 30 * 1000;
const searchHelpCache = new Map();
const getNFTMetadataCache = new Map();
const latestCardsCache = new Map();
const cardsByCategoryCache = new Map();
const getFollowStatusCache = new Map();
const getMyFollowStatusCache = new Map();
const ownerNftSeriesCache = new Map();
const recentIssuedCouponSeriesCache = new Map();
const cardActiveIssuedCouponSeriesCache = new Map();
const cardActiveIssuedProductionSeriesCache = new Map();
const seriesSharedMetadataCache = new Map();
const mintMetadataCache = new Map();
(0, issuedCouponSeriesQueryCache_1.registerIssuedCouponSeriesQueryCacheInvalidator)((cardLo, issuedTokenId) => {
    const prefix = `${cardLo}:`;
    for (const k of cardActiveIssuedCouponSeriesCache.keys()) {
        if (k.startsWith(prefix)) {
            cardActiveIssuedCouponSeriesCache.delete(k);
        }
    }
    for (const k of cardActiveIssuedProductionSeriesCache.keys()) {
        if (k.startsWith(prefix)) {
            cardActiveIssuedProductionSeriesCache.delete(k);
        }
    }
    recentIssuedCouponSeriesCache.clear();
    if (issuedTokenId) {
        try {
            const tk = String(BigInt(issuedTokenId.trim()));
            seriesSharedMetadataCache.delete(`${cardLo}:${tk}`);
        }
        catch {
            /* ignore */
        }
    }
});
/**
 * Master prewarm latestCards：
 *  - 实际只拉一次 limit=300（DB → Discover filter → 仅对可见卡 enrichment），其它 limit 用 slice 派生，避免 3 次重复打满 RPC。
 *  - 间隔从 6s 调到 30s：trending 数据无需毫秒级新鲜，且 enrichment 本身 RPC 成本高。
 *  - cache stale 与 chain-fetch-protocol 30s TTL 对齐（之前 15s 在窗口尾部高频 miss）。
 */
const LATEST_CARDS_PREWARM_MS = 30 * 1000;
const LATEST_CARDS_CACHE_STALE_MS = 30 * 1000;
const LATEST_CARDS_PREWARM_LIMITS = [20, 100, 300];
const LATEST_CARDS_SUPERSET_LIMIT = 300;
/**
 * Discover 必须先超采再 filter：`getLatestCards(20)` 后再 cutover/exclude 会把刚登记的新卡
 * 挤出窗口（旧卡占满 LIMIT）。prewarm / GET miss 一律拉 SUPERSET，再 slice。
 */
let latestCardsCacheGeneration = 0;
let latestCardsInvalidateKickTimer;
const latestCardsComputeInflight = new Map();
function writeLatestCardsCacheIfCurrent(generation, key, items) {
    if (generation !== latestCardsCacheGeneration)
        return;
    latestCardsCache.set(key, { items, expiry: Date.now() + LATEST_CARDS_CACHE_STALE_MS });
}
async function ensureDiscoverPinnedLatestCards(visible) {
    const have = new Set(visible.map((c) => (c.cardAddress || '').toLowerCase()));
    const extra = [];
    for (const addr of latestCardsShared_1.DISCOVER_FEATURED_PINNED_CARD_ADDRESSES) {
        if (have.has(addr.toLowerCase()))
            continue;
        const row = await (0, db_1.getCardByAddress)(addr);
        if (!row)
            continue;
        const item = {
            cardAddress: addr,
            cardOwner: row.cardOwner,
            currency: row.currency,
            priceInCurrencyE6: row.priceInCurrencyE6,
            uri: row.uri,
            metadata: row.metadata,
            txHash: row.txHash,
            totalPointsMinted6: '0',
            holderCount: 0,
            createdAt: row.createdAt ?? '',
        };
        if (!(0, latestCardsShared_1.passDiscoverFeaturedBrandsMerchantCardPolicy)(item))
            continue;
        extra.push(item);
    }
    return (0, latestCardsShared_1.orderLatestCardsWithDiscoverPins)([...extra, ...visible]);
}
async function computeLatestCardsSuperset() {
    const gen = latestCardsCacheGeneration;
    const inflightKey = `${gen}:${LATEST_CARDS_SUPERSET_LIMIT}`;
    const inflight = latestCardsComputeInflight.get(inflightKey);
    if (inflight)
        return inflight;
    const task = (async () => {
        try {
            const raw = await (0, db_1.getLatestCards)(LATEST_CARDS_SUPERSET_LIMIT);
            // Discover gate 先于 enrichment：exclude / cutover 外的卡不对链上打 RPC
            const visible = (0, latestCardsShared_1.filterLatestCardsByDiscoverMerchantPolicy)(raw);
            const ordered = await ensureDiscoverPinnedLatestCards(visible);
            return (0, enrichLatestCardsHolderCounts_1.enrichLatestCardsWithBaseErc1155PointsHolderCounts)(ordered, providerBaseForLatestCards);
        }
        finally {
            latestCardsComputeInflight.delete(inflightKey);
        }
    })();
    latestCardsComputeInflight.set(inflightKey, task);
    return task;
}
async function computeLatestCardsForMaster(limit) {
    const superset = await computeLatestCardsSuperset();
    return superset.slice(0, limit);
}
async function prewarmLatestCardsCacheMaster() {
    const gen = latestCardsCacheGeneration;
    let superset = null;
    try {
        superset = await computeLatestCardsSuperset();
        writeLatestCardsCacheIfCurrent(gen, `limit:${LATEST_CARDS_SUPERSET_LIMIT}`, superset);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[latestCards prewarm] limit=${LATEST_CARDS_SUPERSET_LIMIT}: ${e?.message ?? e}`));
    }
    if (!superset)
        return;
    for (const lim of LATEST_CARDS_PREWARM_LIMITS) {
        if (lim === LATEST_CARDS_SUPERSET_LIMIT)
            continue;
        writeLatestCardsCacheIfCurrent(gen, `limit:${lim}`, superset.slice(0, lim));
    }
}
let latestCardsPrewarmTimeout;
function startLatestCardsPrewarmTimer() {
    const scheduleAfterDelay = () => {
        latestCardsPrewarmTimeout = setTimeout(() => {
            void (async () => {
                try {
                    await prewarmLatestCardsCacheMaster();
                }
                finally {
                    scheduleAfterDelay();
                }
            })();
        }, LATEST_CARDS_PREWARM_MS);
        latestCardsPrewarmTimeout.unref?.();
    };
    void (async () => {
        try {
            await prewarmLatestCardsCacheMaster();
        }
        finally {
            scheduleAfterDelay();
        }
    })();
}
(0, latestCardsQueryCache_1.registerLatestCardsQueryCacheInvalidator)(() => {
    latestCardsCacheGeneration += 1;
    latestCardsCache.clear();
    cardsByCategoryCache.clear();
    if (latestCardsInvalidateKickTimer !== undefined) {
        clearTimeout(latestCardsInvalidateKickTimer);
    }
    latestCardsInvalidateKickTimer = setTimeout(() => {
        latestCardsInvalidateKickTimer = undefined;
        void prewarmLatestCardsCacheMaster();
    }, 50);
    latestCardsInvalidateKickTimer.unref?.();
});
const DEBUG_INBOUND = process.env.DEBUG_INBOUND === '1' ||
    process.env.DEBUG_INBOUND === 'true' ||
    process.env.NODE_ENV !== 'production';
const truncateValue = (value, maxLen = 600) => {
    if (value == null)
        return value;
    if (typeof value === 'string') {
        return value.length > maxLen ? `${value.slice(0, maxLen)}...<truncated ${value.length - maxLen} chars>` : value;
    }
    if (typeof value === 'bigint')
        return value.toString();
    if (Array.isArray(value)) {
        const maxItems = 20;
        const mapped = value.slice(0, maxItems).map((v) => truncateValue(v, maxLen));
        if (value.length > maxItems)
            mapped.push(`...<truncated ${value.length - maxItems} items>`);
        return mapped;
    }
    if (typeof value === 'object') {
        const obj = value;
        const out = {};
        for (const [k, v] of Object.entries(obj))
            out[k] = truncateValue(v, maxLen);
        return out;
    }
    return value;
};
const logInboundDebug = (req) => {
    if (!DEBUG_INBOUND)
        return;
    const body = truncateValue(req.body);
    const query = truncateValue(req.query);
    (0, logger_1.logger)(safe_1.default.gray(`[INBOUND][Master] ${req.method} ${req.originalUrl} ip=${(0, util_1.getClientIp)(req)}`), (0, node_util_1.inspect)({ query, body }, false, 4, true));
};
const routing = (router) => {
    router.use((req, _res, next) => {
        logInboundDebug(req);
        next();
    });
    /** GET /api/manifest.json - 动态 manifest，与 cluster 相同（nginx 可能代理到 master） */
    router.get('/manifest.json', (req, res) => {
        const startUrl = req.query.start_url || req.get('Referer') || '';
        const protocol = req.get('X-Forwarded-Proto') || req.protocol || 'https';
        const host = req.get('Host') || 'beamio.app';
        const origin = `${protocol}://${host}`;
        const fallbackStartUrl = `${origin}/app/`;
        const url = startUrl && startUrl.startsWith('http') ? startUrl : fallbackStartUrl;
        const manifest = {
            id: '/app/',
            short_name: 'Beamio',
            name: 'Beamio APP',
            start_url: url,
            scope: '/app/',
            display: 'standalone',
            theme_color: '#0d0d0d',
            background_color: '#0d0d0d',
            icons: [
                { src: `${origin}/app/logo192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
                { src: `${origin}/app/logo512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
                { src: `${origin}/app/logo512-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
            shortcuts: [{ name: 'Open Beamio', short_name: 'Beamio', url: '/app/', icons: [{ src: `${origin}/app/logo192.png`, sizes: '192x192' }] }],
        };
        res.setHeader('Content-Type', 'application/manifest+json');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.json(manifest);
    });
    router.post('/addFollow', (req, res) => {
        return (0, db_1.addFollow)(req, res);
    });
    router.post('/removeFollow', (req, res) => {
        return (0, db_1.removeFollow)(req, res);
    });
    router.post('/addUser', (req, res) => {
        return (0, db_1.addUser)(req, res);
    });
    router.post('/regiestChatRoute', (req, res) => {
        return (0, db_1.regiestChatRoute)(req, res);
    });
    router.post('/registerPushDevice', (req, res) => {
        return (0, offlineChatPush_1.handleRegisterPushDeviceMaster)(req, res);
    });
    router.post('/syncChatBadge', (req, res) => {
        return (0, offlineChatPush_1.handleSyncChatBadgeMaster)(req, res);
    });
    router.post('/notifyOfflineChat', (req, res) => {
        return (0, offlineChatPush_1.handleNotifyOfflineChatMaster)(req, res);
    });
    /** Cluster 每 1 分钟从此接口拉取 oracle，供 UI getOracle 直接响应 */
    router.get('/oracleForCluster', (_req, res) => {
        res.status(200).json((0, util_1.getOracleRequest)()).end();
    });
    router.get('/debug/ip', (req, res) => {
        console.log('CF-Connecting-IP:', req.headers['cf-connecting-ip']);
        console.log('X-Real-IP:', req.headers['x-real-ip']);
        console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
        console.log('Remote Address:', req.socket.remoteAddress);
        res.json({
            realIp: (0, util_1.getClientIp)(req),
            headers: {
                'x-real-ip': req.headers['x-real-ip'],
                'cf-connecting-ip': req.headers['cf-connecting-ip'],
                'x-forwarded-for': req.headers['x-forwarded-for'],
                'Remote Address:': req.socket.remoteAddress
            },
        });
    });
    router.get('/search-users', (req, res) => {
        return (0, db_1.searchUsers)(req, res);
    });
    /** GET /api/getFollowStatus 30 秒缓存 */
    router.get('/getFollowStatus', async (req, res) => {
        const { wallet, followAddress } = req.query;
        if (!ethers_1.ethers.isAddress(wallet) || wallet === ethers_1.ethers.ZeroAddress || !ethers_1.ethers.isAddress(followAddress) || followAddress === ethers_1.ethers.ZeroAddress) {
            return res.status(400).json({ error: 'Invalid data format' });
        }
        const cacheKey = `${ethers_1.ethers.getAddress(wallet).toLowerCase()}:${ethers_1.ethers.getAddress(followAddress).toLowerCase()}`;
        const cached = getFollowStatusCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json(cached.data).end();
        }
        const followStatus = await (0, db_1.FollowerStatus)(wallet, followAddress);
        if (followStatus === null) {
            return res.status(400).json({ error: 'Follow status check Error!' });
        }
        getFollowStatusCache.set(cacheKey, { data: followStatus, expiry: Date.now() + QUERY_CACHE_TTL_MS });
        return res.status(200).json(followStatus).end();
    });
    /** GET /api/getMyFollowStatus 30 秒缓存 */
    router.get('/getMyFollowStatus', async (req, res) => {
        const { wallet } = req.query;
        if (!ethers_1.ethers.isAddress(wallet) || wallet === ethers_1.ethers.ZeroAddress) {
            return res.status(400).json({ error: 'Invalid data format' });
        }
        const cacheKey = ethers_1.ethers.getAddress(wallet).toLowerCase();
        const cached = getMyFollowStatusCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json(cached.data).end();
        }
        const followStatus = await (0, db_1.getMyFollowStatus)(wallet);
        if (followStatus === null) {
            return res.status(400).json({ error: 'Follow status check Error!' });
        }
        getMyFollowStatusCache.set(cacheKey, { data: followStatus, expiry: Date.now() + QUERY_CACHE_TTL_MS });
        return res.status(200).json(followStatus).end();
    });
    router.get('/coinbase-token', (req, res) => {
        return (0, coinbase_1.coinbaseToken)(req, res);
    });
    router.get('/coinbase-offramp', (req, res) => {
        return (0, coinbase_1.coinbaseOfframp)(req, res);
    });
    /** GET /api/searchHelp - 返回卡已定义的全部 issued NFT 列表。30 秒缓存 */
    router.get('/searchHelp', async (req, res) => {
        const { card } = req.query;
        if (!card || !ethers_1.ethers.isAddress(card)) {
            return res.status(400).json({ error: 'Invalid card address' });
        }
        const cacheKey = ethers_1.ethers.getAddress(card).toLowerCase();
        const cached = searchHelpCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ items: cached.items });
        }
        try {
            const provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
            const cardContract = new ethers_1.ethers.Contract(card, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider);
            const nextIdx = await cardContract.issuedNftIndex();
            const nextIdxN = Number(nextIdx);
            const startN = Number(ISSUED_NFT_START_ID);
            if (nextIdxN <= startN) {
                return res.status(200).json({ items: [] });
            }
            const items = [];
            for (let tid = startN; tid < nextIdxN; tid++) {
                const [title, sharedMetadataHash, validAfter, validBefore, maxSupply, mintedCount, priceInCurrency6] = await Promise.all([
                    cardContract.issuedNftTitle(tid),
                    cardContract.issuedNftSharedMetadataHash(tid),
                    cardContract.issuedNftValidAfter(tid),
                    cardContract.issuedNftValidBefore(tid),
                    cardContract.issuedNftMaxSupply(tid),
                    cardContract.issuedNftMintedCount(tid),
                    cardContract.issuedNftPriceInCurrency6(tid),
                ]);
                let titleStr = '';
                try {
                    titleStr = ethers_1.ethers.toUtf8String(title).replace(/\0/g, '').trim();
                }
                catch {
                    titleStr = '0x' + ethers_1.ethers.hexlify(title).slice(2);
                }
                if (!titleStr)
                    titleStr = '0x' + ethers_1.ethers.hexlify(title).slice(2);
                items.push({
                    tokenId: String(tid),
                    title: titleStr,
                    sharedMetadataHash: sharedMetadataHash !== ethers_1.ethers.ZeroHash ? ethers_1.ethers.hexlify(sharedMetadataHash) : null,
                    validAfter: String(validAfter),
                    validBefore: String(validBefore),
                    maxSupply: String(maxSupply),
                    mintedCount: String(mintedCount),
                    priceInCurrency6: String(priceInCurrency6),
                });
            }
            searchHelpCache.set(cacheKey, { items, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json({ items });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[searchHelp] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch issued NFTs' });
        }
    });
    /** GET /api/getNFTMetadata - 返回指定 NFT 的 metadata。30 秒缓存 */
    router.get('/getNFTMetadata', async (req, res) => {
        const { card, tokenId, nftSpecialMetadata } = req.query;
        if (!card || !ethers_1.ethers.isAddress(card) || !tokenId) {
            return res.status(400).json({ error: 'Invalid card or tokenId' });
        }
        const cacheKey = `${ethers_1.ethers.getAddress(card).toLowerCase()}:${tokenId}:${nftSpecialMetadata ?? ''}`;
        const cached = getNFTMetadataCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json(cached.out);
        }
        const tid = BigInt(tokenId);
        if (tid < ISSUED_NFT_START_ID) {
            return res.status(400).json({ error: 'tokenId must be >= ISSUED_NFT_START_ID (100000000000)' });
        }
        try {
            const provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
            const cardContract = new ethers_1.ethers.Contract(card, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider);
            const [title, sharedMetadataHash, validAfter, validBefore, maxSupply, mintedCount, priceInCurrency6] = await Promise.all([
                cardContract.issuedNftTitle(tid),
                cardContract.issuedNftSharedMetadataHash(tid),
                cardContract.issuedNftValidAfter(tid),
                cardContract.issuedNftValidBefore(tid),
                cardContract.issuedNftMaxSupply(tid),
                cardContract.issuedNftMintedCount(tid),
                cardContract.issuedNftPriceInCurrency6(tid),
            ]);
            if (maxSupply === 0n || maxSupply === 0) {
                return res.status(404).json({ error: 'Issued NFT not defined' });
            }
            let titleStr = '';
            try {
                titleStr = ethers_1.ethers.toUtf8String(title).replace(/\0/g, '').trim();
            }
            catch {
                titleStr = '0x' + ethers_1.ethers.hexlify(title).slice(2);
            }
            if (!titleStr)
                titleStr = '0x' + ethers_1.ethers.hexlify(title).slice(2);
            const out = {
                tokenId: String(tid),
                title: titleStr,
                sharedMetadataHash: sharedMetadataHash !== ethers_1.ethers.ZeroHash ? ethers_1.ethers.hexlify(sharedMetadataHash) : null,
                validAfter: String(validAfter),
                validBefore: String(validBefore),
                maxSupply: String(maxSupply),
                mintedCount: String(mintedCount),
                priceInCurrency6: String(priceInCurrency6),
            };
            const series = await (0, db_1.getSeriesByCardAndTokenId)(card, tokenId);
            if (series?.ipfsCid) {
                try {
                    const ipfsUrl = `https://ipfs.io/ipfs/${series.ipfsCid}`;
                    const ipfsRes = await fetch(ipfsUrl);
                    if (ipfsRes.ok) {
                        const sharedJson = await ipfsRes.json();
                        out.sharedSeriesMetadata = sharedJson;
                        if (nftSpecialMetadata && typeof nftSpecialMetadata === 'string') {
                            try {
                                const special = JSON.parse(nftSpecialMetadata);
                                const base = (typeof sharedJson === 'object' && sharedJson !== null) ? sharedJson : {};
                                out.assembled = { ...base, ...special };
                            }
                            catch {
                                out.nftSpecialMetadata = nftSpecialMetadata;
                            }
                        }
                    }
                }
                catch (ipfsErr) {
                    (0, logger_1.logger)(safe_1.default.yellow('[getNFTMetadata] IPFS fetch failed:'), ipfsErr?.message ?? ipfsErr);
                }
            }
            getNFTMetadataCache.set(cacheKey, { out, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json(out);
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[getNFTMetadata] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch NFT metadata' });
        }
    });
    /**
     * 最新发行的前 N 张卡明细；holderCount + token0TotalSupply6 + token0CumulativeMint6。
     *  - cache 命中（含已过期）一律可用：未过期直接返回；过期则当 stale 兜底。
     *  - cache miss：优先用 limit=300 超集 slice 派生（一次链上拉取就能服务多个 limit）。
     *  - 计算失败：若有任何 stale trusted cache，返回 stale 而不是 5xx，避免触发 nginx 504。
     *  - 严格不返回 [] 表示「无卡」（按 beamio-untrusted-empty-result-discard.mdc，windowed 扫描的空结果不可信）。
     */
    router.get('/latestCards', async (_req, res) => {
        const limit = Math.min(parseInt(String(_req.query.limit || 20), 10) || 20, 300);
        const cacheKey = `limit:${limit}`;
        const cached = latestCardsCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ items: cached.items });
        }
        // 用未过期超集 cache 派生：避免对每个 limit 都触发 enrichment。
        // 不过要求 items.length >= limit：Discover filter 后可见数常小于请求 limit。
        const supersetCacheKey = `limit:${LATEST_CARDS_SUPERSET_LIMIT}`;
        const superset = latestCardsCache.get(supersetCacheKey);
        if (superset && Date.now() < superset.expiry && limit <= LATEST_CARDS_SUPERSET_LIMIT) {
            const sliced = superset.items.slice(0, limit);
            latestCardsCache.set(cacheKey, { items: sliced, expiry: Date.now() + LATEST_CARDS_CACHE_STALE_MS });
            return res.status(200).json({ items: sliced });
        }
        try {
            const gen = latestCardsCacheGeneration;
            const supersetItems = await computeLatestCardsSuperset();
            writeLatestCardsCacheIfCurrent(gen, supersetCacheKey, supersetItems);
            const items = supersetItems.slice(0, limit);
            writeLatestCardsCacheIfCurrent(gen, cacheKey, items);
            res.status(200).json({ items });
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.red('[latestCards] error:'), e?.message ?? e);
            // untrusted 失败：尝试返回 stale trusted cache（同 limit 或超集 slice），避免 nginx 504
            if (cached)
                return res.status(200).json({ items: cached.items, stale: true });
            if (superset && limit <= LATEST_CARDS_SUPERSET_LIMIT) {
                const sliced = superset.items.slice(0, limit);
                if (sliced.length > 0)
                    return res.status(200).json({ items: sliced, stale: true });
            }
            res.status(503).json({ error: e?.message ?? 'latestCards failed' });
        }
    });
    /** 按 shareTokenMetadata.categories 聚合已登记发卡（与 Cluster GET /api/cardsByCategory 一致） */
    router.get('/cardsByCategory', async (_req, res) => {
        const scanLimit = Math.min(parseInt(String(_req.query.scanLimit || 800), 10) || 800, 3000);
        const limitPerCategory = Math.min(parseInt(String(_req.query.limitPerCategory || 80), 10) || 80, 500);
        const cacheKey = `scan:${scanLimit}:per:${limitPerCategory}`;
        const cached = cardsByCategoryCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ groups: cached.groups });
        }
        const groups = await (0, db_1.getLatestCardsGroupedByCategory)({ scanLimit, limitPerCategory });
        cardsByCategoryCache.set(cacheKey, { groups, expiry: Date.now() + QUERY_CACHE_TTL_MS });
        res.status(200).json({ groups });
    });
    /** GET /api/myCards?owner=0x... 或 ?owners=0x1,0x2 - 客户端 RPC 失败时可由此 API 获取。30 秒缓存。
     * RPC 错误时返回 500，绝不返回 200+空 items，以便 UI 区分「成功无卡」与「请求失败」。 */
    const MY_CARDS_CACHE_TTL_MS = 30 * 1000;
    const myCardsCache = new Map();
    router.get('/myCards', async (req, res) => {
        const { owner, owners } = req.query;
        const ownerList = [];
        if (owner && ethers_1.ethers.isAddress(owner))
            ownerList.push(ethers_1.ethers.getAddress(owner));
        if (owners && typeof owners === 'string') {
            for (const addr of owners.split(',').map((s) => s.trim())) {
                if (addr && ethers_1.ethers.isAddress(addr))
                    ownerList.push(ethers_1.ethers.getAddress(addr));
            }
        }
        if (ownerList.length === 0) {
            return res.status(400).json({ error: 'Invalid owner or owners: require valid 0x address(es)' });
        }
        const cacheKey = [...ownerList].map((o) => o.toLowerCase()).sort().join(',');
        const cached = myCardsCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ items: cached.items });
        }
        const CARD_ABI = ['function currency() view returns (uint8)', 'function pointsUnitPriceInCurrencyE6() view returns (uint256)'];
        const FACTORY_ABI = ['function cardsOfOwner(address) view returns (address[])'];
        const CURRENCY_MAP = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' };
        const factoryQueries = [
            { factory: chainAddresses_1.CONET_CARD_FACTORY, provider: (0, beamioUserCardChain_1.providerForUserCardChain)('conet') },
        ];
        try {
            const seen = new Set();
            const items = [];
            for (const o of ownerList) {
                for (const { factory, provider } of factoryQueries) {
                    const factoryContract = new ethers_1.ethers.Contract(factory, FACTORY_ABI, provider);
                    const cards = await factoryContract.cardsOfOwner(o);
                    for (const addr of cards) {
                        const key = addr.toLowerCase();
                        if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(key))
                            continue;
                        if (seen.has(key))
                            continue;
                        seen.add(key);
                        try {
                            const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(addr);
                            const cardProvider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
                            const card = new ethers_1.ethers.Contract(addr, CARD_ABI, cardProvider);
                            const [currencyNum, priceE6Raw] = await Promise.all([card.currency(), card.pointsUnitPriceInCurrencyE6()]);
                            const currency = CURRENCY_MAP[Number(currencyNum)] ?? 'USDC';
                            const priceE6 = Number(priceE6Raw);
                            const ptsPer1Currency = priceE6 > 0 ? String(1_000_000 / priceE6) : '0';
                            items.push({ cardAddress: addr, name: 'User Card', currency, priceE6: String(priceE6), ptsPer1Currency });
                        }
                        catch (_) { }
                    }
                }
            }
            myCardsCache.set(cacheKey, { items, expiry: Date.now() + MY_CARDS_CACHE_TTL_MS });
            res.status(200).json({ items });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[myCards] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch my cards' });
        }
    });
    /** GET /api/getAAAccount?eoa=0x... - CoNET BEAMIO_AA_FACTORY beamioAccountOf（新 AA 仅 224422）。30 秒缓存。 */
    const GET_AA_CACHE_TTL_MS = 30 * 1000;
    const getAAAccountCache = new Map();
    router.get('/getAAAccount', async (req, res) => {
        const { eoa } = req.query;
        if (!eoa || !ethers_1.ethers.isAddress(eoa)) {
            return res.status(400).json({ error: 'Invalid eoa: require valid 0x address' });
        }
        const cacheKey = ethers_1.ethers.getAddress(eoa).toLowerCase();
        const cached = getAAAccountCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ account: cached.account });
        }
        try {
            const account = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(eoa);
            if (!account) {
                getAAAccountCache.set(cacheKey, { account: null, expiry: Date.now() + GET_AA_CACHE_TTL_MS });
                return res.status(200).json({ account: null });
            }
            getAAAccountCache.set(cacheKey, { account, expiry: Date.now() + GET_AA_CACHE_TTL_MS });
            res.status(200).json({ account });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[getAAAccount] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch AA account' });
        }
    });
    /** GET /api/ensureAAForEOA?eoa=0x... - 在 CoNET 224422 确保 AA（无则 createAccountFor）；与 ensureAAForEOAOnConet 等价。 */
    router.get('/ensureAAForEOA', async (req, res) => {
        const { eoa } = req.query;
        if (!eoa || !ethers_1.ethers.isAddress(eoa)) {
            return res.status(400).json({ error: 'Invalid eoa: require valid 0x address' });
        }
        try {
            const aa = await (0, MemberCard_1.ensureAAForEOA)(ethers_1.ethers.getAddress(eoa));
            res.status(200).json({ aa });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[ensureAAForEOA] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to ensure AA for EOA' });
        }
    });
    /** GET /api/ensureAAForEOAOnConet?eoa=0x... - 在 CoNET 224422 上确保 Beamio AA 已部署（无则 createAccountFor）。 */
    router.get('/ensureAAForEOAOnConet', async (req, res) => {
        const { eoa } = req.query;
        if (!eoa || !ethers_1.ethers.isAddress(eoa)) {
            return res.status(400).json({ error: 'Invalid eoa: require valid 0x address' });
        }
        try {
            const aa = await (0, MemberCard_1.ensureAAForEOAOnConet)(ethers_1.ethers.getAddress(eoa));
            res.status(200).json({ aa });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[ensureAAForEOAOnConet] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to ensure CoNET AA for EOA' });
        }
    });
    /**
     * GET|POST /api/createInstitutionalAa?eoa= / body.eoa —
     * Optional body.accountName (BeamioTag) binds AccountRegistry name → new AA.
     * Ensure index=0, then createAccountFor → next institutional AA (index ≥ 1).
     */
    const handleCreateInstitutionalAa = async (req, res) => {
        const body = (req.body ?? {});
        const eoaRaw = req.query.eoa ?? body.eoa;
        const accountNameRaw = req.query.accountName ?? body.accountName;
        if (!eoaRaw || !ethers_1.ethers.isAddress(eoaRaw)) {
            return res.status(400).json({ success: false, error: 'Invalid eoa: require valid 0x address' });
        }
        const accountName = accountNameRaw ? (0, db_1.normalizeBeamioAccountName)(accountNameRaw) : '';
        if (accountNameRaw && !accountName) {
            return res.status(400).json({
                success: false,
                error: 'Invalid BeamioTag: use 3–26 letters, numbers, _ or .',
            });
        }
        try {
            if (accountName) {
                const available = await (0, db_1.isBeamioAccountNameAvailable)(accountName);
                if (!available) {
                    return res.status(400).json({
                        success: false,
                        error: `BeamioTag @${accountName} is already taken`,
                    });
                }
            }
            const out = await (0, MemberCard_1.createInstitutionalAaForEoa)(ethers_1.ethers.getAddress(eoaRaw));
            let tagTxHash = '';
            let boundTag = '';
            if (accountName) {
                const tagged = await (0, db_1.registerBeamioTagForAddress)({
                    wallet: out.aa,
                    accountName,
                    firstName: 'Institutional',
                    lastName: 'Smart Wallet',
                });
                tagTxHash = tagged.txHash;
                boundTag = tagged.accountName;
            }
            res.status(200).json({
                success: true,
                aa: out.aa,
                index: out.index,
                txHash: out.txHash,
                accountName: boundTag || undefined,
                tagTxHash: tagTxHash || undefined,
            });
        }
        catch (err) {
            const status = err instanceof MemberCard_1.CreateInstitutionalAaHttpError
                ? err.statusCode
                : typeof err?.statusCode === 'number'
                    ? err.statusCode
                    : 500;
            (0, logger_1.logger)(safe_1.default.red('[createInstitutionalAa] error:'), err?.message ?? err);
            res.status(status).json({
                success: false,
                error: err?.message ?? 'Failed to create institutional AA',
            });
        }
    };
    router.get('/createInstitutionalAa', handleCreateInstitutionalAa);
    router.post('/createInstitutionalAa', handleCreateInstitutionalAa);
    /** POST /api/aaCreateViaEntryPointSubmit - 用户签过 UserOp 后，由 paymaster/admin 通过 Factory.relayHandleOps 提交 EntryPoint。 */
    router.post('/aaCreateViaEntryPointSubmit', async (req, res) => {
        const body = req.body;
        if (!body.eoa || !ethers_1.ethers.isAddress(body.eoa)) {
            return res.status(400).json({ success: false, error: 'Invalid eoa: require valid 0x address' });
        }
        if (!body.signature || typeof body.signature !== 'string') {
            return res.status(400).json({ success: false, error: 'signature required' });
        }
        if (!body.packedUserOp || typeof body.packedUserOp !== 'object') {
            return res.status(400).json({ success: false, error: 'packedUserOp required' });
        }
        try {
            const out = await (0, MemberCard_1.submitAAAccountCreationViaEntryPoint)({
                eoa: ethers_1.ethers.getAddress(body.eoa),
                signature: body.signature,
                packedUserOp: body.packedUserOp,
            });
            return res.status(200).json(out);
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[aaCreateViaEntryPointSubmit] error:'), err?.message ?? err);
            return res.status(500).json({ success: false, error: err?.message ?? 'Failed to submit AA creation UserOp' });
        }
    });
    const parseMerchantInfraFetchOptions = (body) => {
        const b = body;
        const raw = typeof b?.merchantInfraCard === 'string' && b.merchantInfraCard.trim()
            ? b.merchantInfraCard.trim()
            : typeof b?.infrastructureCardAddress === 'string'
                ? b.infrastructureCardAddress.trim()
                : '';
        const resolved = raw !== '' && ethers_1.ethers.isAddress(raw)
            ? ethers_1.ethers.getAddress(raw)
            : undefined;
        const scopeRaw = typeof b?.cardsScope === 'string' ? b.cardsScope.trim().toLowerCase() : '';
        let cardsScope = undefined;
        if (scopeRaw === 'all') {
            cardsScope = 'all';
        }
        else if ((resolved && scopeRaw === '') || (b?.merchantInfraOnly === true && !!resolved)) {
            cardsScope = 'merchantInfraOnly';
        }
        else if (scopeRaw === 'infrastructureonly' || scopeRaw === 'infraonly') {
            cardsScope = 'infrastructureOnly';
        }
        return {
            ...(resolved ? { infrastructureCardAddress: resolved } : {}),
            ...(cardsScope ? { cardsScope } : {}),
            ...(b?.includeZeroBalanceCards === true ? { includeZeroBalanceCards: true } : {}),
        };
    };
    /** getUIDAssetsProvision pool：Cluster 预检通过后，TagID 未绑定时转发到此。Master 排队执行 provision → ensureAA → fetchAssets，不预检。 */
    const getUIDAssetsProvisionPool = [];
    const getUIDAssetsProvisionPress = async () => {
        const obj = getUIDAssetsProvisionPool.shift();
        if (!obj)
            return;
        const { uid, tagIdHex, c: counterHex, opts, res } = obj;
        try {
            (0, logger_1.logger)(safe_1.default.cyan(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... provision + ensureAA + fetch`));
            const { eoa, wasNewlyProvisioned } = await (0, db_1.provisionOrGetNfcWalletByTagId)(tagIdHex, uid || undefined);
            // 始终确保 AA 存在：wasNewlyProvisioned 仅表示 EOA 新建，但 EOA 已存在时可能因 DeployingSmartAccount 曾失败而无 AA
            await (0, MemberCard_1.ensureAAForEOA)(ethers_1.ethers.getAddress(eoa));
            if (wasNewlyProvisioned)
                (0, logger_1.logger)(safe_1.default.green(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... provisioned EOA + AA`));
            const result = await (0, getUIDAssetsLogic_1.fetchUIDAssetsForEOA)(eoa, opts);
            if (uid && tagIdHex) {
                await (0, db_1.upsertNfcBeamioUserCardHoldingsFromTrustedCards)({
                    tagIdHex,
                    uid: uid.trim(),
                    ownerEoa: eoa,
                    aaAddress: result.aaAddress ?? null,
                    cards: result.cards,
                });
                (0, getUIDAssetsLogic_1.scheduleEnsureNfcBeamioTagForEoa)(eoa, uid.trim(), tagIdHex, result.cards);
            }
            const counterVal = counterHex && /^[0-9a-fA-F]{6}$/.test(counterHex) ? parseInt(counterHex, 16) : undefined;
            const merged = {
                ...result,
                ...(uid && { uid }),
                tagIdHex,
                ...(counterHex && { counterHex: counterHex }),
                ...(counterVal !== undefined && { counter: counterVal }),
            };
            (0, logger_1.logger)(safe_1.default.green(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... success`));
            res.status(200).json(merged).end();
        }
        catch (err) {
            const msg = err?.message ?? String(err);
            (0, logger_1.logger)(safe_1.default.red(`[getUIDAssetsProvision] tagId=${tagIdHex.slice(0, 8)}... failed: ${msg}`));
            res.status(500).json({ ok: false, error: msg }).end();
        }
        setTimeout(() => getUIDAssetsProvisionPress(), 0);
    };
    /** POST /api/getUIDAssetsProvision - Cluster 预检后转发。TagID 未绑定时需创建钱包，Master 排队处理。tagIdHex 必填（卡的唯一 ID）；uid 可选（兼容旧客户端）。 */
    router.post('/getUIDAssetsProvision', (req, res) => {
        const { uid, tagIdHex, c } = req.body;
        if (!tagIdHex || typeof tagIdHex !== 'string' || !tagIdHex.trim()) {
            return res.status(400).json({ ok: false, error: 'Missing tagIdHex (card unique ID)' });
        }
        getUIDAssetsProvisionPool.push({
            uid: typeof uid === 'string' ? uid.trim() : '',
            tagIdHex: tagIdHex.trim(),
            c: typeof c === 'string' ? c.trim() : undefined,
            opts: parseMerchantInfraFetchOptions(req.body),
            res,
        });
        getUIDAssetsProvisionPress();
    });
    /** sunProvision pool：Cluster /sun valid 时 tagID 未绑定，转发到此。Master 排队 provision → ensureAA，返回 { ...sunResult, eoa, aa }。 */
    const sunProvisionPool = [];
    const sunProvisionPress = async () => {
        const obj = sunProvisionPool.shift();
        if (!obj)
            return;
        const { uid, tagIdHex, sunResult, res } = obj;
        try {
            (0, logger_1.logger)(safe_1.default.cyan(`[sunProvision] tagId=${tagIdHex.slice(0, 8)}... provision + ensureAA`));
            const { eoa, wasNewlyProvisioned } = await (0, db_1.provisionOrGetNfcWalletByTagId)(tagIdHex, uid || undefined);
            // 始终确保 AA 存在（与 getUIDAssetsProvision 一致）
            const aa = await (0, MemberCard_1.ensureAAForEOA)(ethers_1.ethers.getAddress(eoa));
            if (wasNewlyProvisioned)
                (0, logger_1.logger)(safe_1.default.green(`[sunProvision] tagId=${tagIdHex.slice(0, 8)}... provisioned EOA + AA`));
            const eoaAddr = ethers_1.ethers.getAddress(eoa);
            const uidForTag = (typeof uid === 'string' && uid.trim()
                ? uid.trim()
                : String(sunResult.uidHex ?? '').trim()) || tagIdHex;
            (0, getUIDAssetsLogic_1.scheduleEnsureNfcBeamioTagForEoa)(eoaAddr, uidForTag, tagIdHex, null);
            res.status(200).json({ ...sunResult, eoa: eoaAddr, aa }).end();
        }
        catch (err) {
            const msg = err?.message ?? String(err);
            (0, logger_1.logger)(safe_1.default.red(`[sunProvision] tagId=${tagIdHex.slice(0, 8)}... failed: ${msg}`));
            res.status(500).json({ ok: false, error: msg }).end();
        }
        setTimeout(() => sunProvisionPress(), 0);
    };
    /** POST /api/sunProvision - Cluster /sun valid 且 tagID 未绑定时转发。Master 排队创建钱包，返回 { ...sunResult, eoa, aa }。tagIdHex 必填；uid 可选。 */
    router.post('/sunProvision', (req, res) => {
        const { uid, tagIdHex, sunResult } = req.body;
        if (!tagIdHex || typeof tagIdHex !== 'string' || !tagIdHex.trim() || !sunResult || typeof sunResult !== 'object') {
            return res.status(400).json({ ok: false, error: 'Missing tagIdHex or sunResult' });
        }
        sunProvisionPool.push({ uid: typeof uid === 'string' ? uid.trim() : '', tagIdHex: tagIdHex.trim(), sunResult, res });
        sunProvisionPress();
    });
    /** GET /api/checkRequestStatus - 校验 Voucher 支付请求是否过期或已支付。用于 Smart Routing 及 beamioTransferIndexerAccounting 前置校验。 */
    const BEAMIO_INDEXER_ADDRESS = chainAddresses_1.BEAMIO_INDEXER_DIAMOND;
    const INDEXER_READ_ABI = [
        'function getTransactionFullByTxId(bytes32 txId) view returns ((bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, address topAdmin, address subordinate, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta))',
        'function getAccountTransactionsByMonthOffsetPaged(address account, uint256 periodOffset, uint256 pageOffset, uint256 pageLimit, bytes32 txCategoryFilter) view returns (uint256 total, uint256 periodStart, uint256 periodEnd, (bytes32 id, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, bool exists, address topAdmin, address subordinate)[] page)',
    ];
    const TX_REQUEST_CREATE = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('request_create:confirmed'));
    const TX_REQUEST_FULFILLED = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('request_fulfilled:confirmed'));
    const checkRequestStatus = async (requestHash, validDays, payee) => {
        if (!requestHash || !ethers_1.ethers.isHexString(requestHash) || ethers_1.ethers.dataLength(requestHash) !== 32) {
            return { expired: false, fulfilled: false, error: 'Invalid requestHash' };
        }
        if (!payee || !ethers_1.ethers.isAddress(payee)) {
            return { expired: false, fulfilled: false, error: 'Invalid payee address' };
        }
        const vd = Math.floor(Number(validDays));
        if (vd < 1) {
            return { expired: false, fulfilled: false, error: 'validDays must be >= 1' };
        }
        try {
            const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)());
            const indexer = new ethers_1.ethers.Contract(BEAMIO_INDEXER_ADDRESS, INDEXER_READ_ABI, provider);
            const txHashBytes32 = ethers_1.ethers.getBytes(requestHash).length === 32 ? requestHash : ethers_1.ethers.hexlify(ethers_1.ethers.zeroPadValue(requestHash, 32));
            // 1. 查 request_create：txId = requestHash，取 timestamp
            let createTs = 0n;
            try {
                const full = await indexer.getTransactionFullByTxId(txHashBytes32);
                if (full && full.txCategory === TX_REQUEST_CREATE && full.timestamp) {
                    createTs = BigInt(full.timestamp);
                }
            }
            catch {
                // 可能不存在（未登记 request_create），按无时间戳处理，视为未过期（由 fulfilled 决定）
            }
            // 2. 过期：createTs + validDays*86400 < now
            const nowSec = BigInt(Math.floor(Date.now() / 1000));
            const validSeconds = BigInt(vd) * 86400n;
            const expiresAt = createTs + validSeconds;
            const expired = createTs > 0n ? nowSec > expiresAt : false;
            // 3. 已支付：payee 的 request_fulfilled 中 originalPaymentHash === requestHash
            let fulfilled = false;
            try {
                const [total, , , page] = await indexer.getAccountTransactionsByMonthOffsetPaged(ethers_1.ethers.getAddress(payee), 0, 0, 50, TX_REQUEST_FULFILLED);
                if (page && page.length > 0) {
                    const reqHashLower = requestHash.toLowerCase();
                    for (const tx of page) {
                        if (tx?.exists && tx.originalPaymentHash && String(tx.originalPaymentHash).toLowerCase() === reqHashLower) {
                            fulfilled = true;
                            break;
                        }
                    }
                }
            }
            catch {
                // RPC 失败时不断言 fulfilled，避免误拒
            }
            return { expired, fulfilled };
        }
        catch (err) {
            return { expired: false, fulfilled: false, error: err?.message ?? 'Indexer query failed' };
        }
    };
    router.get('/checkRequestStatus', async (req, res) => {
        const { requestHash, validDays, payee } = req.query;
        if (!requestHash || validDays == null || validDays === '' || !payee) {
            return res.status(400).json({ error: 'Missing required: requestHash, validDays, payee' });
        }
        const vd = Math.floor(Number(validDays));
        if (vd < 1) {
            return res.status(400).json({ error: 'validDays must be >= 1' });
        }
        if (!ethers_1.ethers.isAddress(payee)) {
            return res.status(400).json({ error: 'Invalid payee address' });
        }
        const result = await checkRequestStatus(requestHash, vd, payee);
        if (result.error && !result.expired && !result.fulfilled) {
            return res.status(500).json({ error: result.error });
        }
        res.status(200).json({ expired: result.expired, fulfilled: result.fulfilled });
    });
    /** GET /api/getBalance?address=0x... - 客户端 RPC 失败时由此获取 USDC/ETH 余额。30 秒缓存。 */
    const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const GET_BALANCE_CACHE_TTL_MS = 30 * 1000;
    const getBalanceCache = new Map();
    router.get('/getBalance', async (req, res) => {
        const { address } = req.query;
        if (!address || !ethers_1.ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid address: require valid 0x address' });
        }
        const cacheKey = ethers_1.ethers.getAddress(address).toLowerCase();
        const cached = getBalanceCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ eth: cached.eth, usdc: cached.usdc, oracle: cached.oracle });
        }
        try {
            const provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
            const usdc = new ethers_1.ethers.Contract(USDC_BASE, ['function balanceOf(address) view returns (uint256)'], provider);
            const [usdcRaw, ethRaw] = await Promise.all([usdc.balanceOf(address), provider.getBalance(address)]);
            const oracle = (0, util_1.getOracleRequest)();
            const data = {
                eth: ethers_1.ethers.formatUnits(ethRaw, 18),
                usdc: ethers_1.ethers.formatUnits(usdcRaw, 6),
                oracle: oracle ?? {},
            };
            getBalanceCache.set(cacheKey, { eth: data.eth, usdc: data.usdc, oracle: data.oracle, expiry: Date.now() + GET_BALANCE_CACHE_TTL_MS });
            res.status(200).json(data);
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[getBalance] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch balance' });
        }
    });
    /** GET /api/ownerNftSeries - owner 钱包所有的 NFT 系列。30 秒缓存 */
    router.get('/ownerNftSeries', async (req, res) => {
        const { owner } = req.query;
        if (!owner || !ethers_1.ethers.isAddress(owner)) {
            return res.status(400).json({ error: 'Invalid owner address' });
        }
        const cacheKey = ethers_1.ethers.getAddress(owner).toLowerCase();
        const cached = ownerNftSeriesCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ items: cached.items });
        }
        try {
            const items = await (0, db_1.getOwnerNftSeries)(owner, 100);
            ownerNftSeriesCache.set(cacheKey, { items, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json({ items });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[ownerNftSeries] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch owner NFT series' });
        }
    });
    /** GET /api/recentIssuedCouponSeries — Program 优惠券 issued NFT，按登记时间倒序；默认 limit=20，最大 50 */
    router.get('/recentIssuedCouponSeries', async (req, res) => {
        let limit = Number(req.query.limit ?? 20);
        if (!Number.isFinite(limit))
            limit = 20;
        limit = Math.floor(limit);
        limit = Math.min(Math.max(limit, 1), 50);
        const cacheKey = String(limit);
        const cached = recentIssuedCouponSeriesCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ items: cached.items, limit: cached.limit });
        }
        try {
            const scanLimit = Math.min(100, Math.max(limit, limit * 8));
            const rawItems = await (0, db_1.listRecentBeamioIssuedCouponSeries)(scanLimit);
            const afterDiscover = await (0, couponDiscoverFilter_1.filterCouponSeriesRowsByDiscoverMerchantPolicy)(rawItems);
            const items = afterDiscover.slice(0, limit);
            recentIssuedCouponSeriesCache.set(cacheKey, { items, limit, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json({ items, limit });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[recentIssuedCouponSeries] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch recent issued coupon series' });
        }
    });
    /** GET /api/cardActiveIssuedCouponSeries — 单卡 Program 优惠券，DB 登记时间倒序且链上 isIssuedNftValid；默认 limit=20，最大 50 */
    router.get('/cardActiveIssuedCouponSeries', async (req, res) => {
        const { card } = req.query;
        if (!card || !ethers_1.ethers.isAddress(card)) {
            return res.status(400).json({ error: 'Invalid card address' });
        }
        let limit = Number(req.query.limit ?? 20);
        if (!Number.isFinite(limit))
            limit = 20;
        limit = Math.floor(limit);
        limit = Math.min(Math.max(limit, 1), 50);
        const checksum = ethers_1.ethers.getAddress(card);
        if (!(await (0, couponDiscoverFilter_1.isCouponCardDiscoverVisible)(checksum))) {
            return res.status(200).json({ cardAddress: checksum, limit, items: [] });
        }
        const cacheKey = `${checksum.toLowerCase()}:${limit}`;
        const cached = cardActiveIssuedCouponSeriesCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json(cached.data);
        }
        try {
            const scanLimit = Math.min(400, Math.max(60, limit * 25));
            const candidates = await (0, db_1.listCouponIssuedNftSeriesForCardDescending)(checksum, scanLimit);
            const seenToken = new Set();
            const ordered = [];
            for (const row of candidates) {
                if (seenToken.has(row.tokenId))
                    continue;
                seenToken.add(row.tokenId);
                ordered.push(row);
            }
            const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(checksum);
            const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
            const cardContract = new ethers_1.ethers.Contract(checksum, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider);
            const items = [];
            for (const row of ordered) {
                if (items.length >= limit)
                    break;
                if (!(0, couponMetadataCategory_1.metadataMatchesClientCouponCategoryFilter)(row.metadata))
                    continue;
                if (!(0, couponMetadataCategory_1.metadataMatchesListedClientCouponFilter)(row.metadata))
                    continue;
                let tid;
                try {
                    tid = BigInt(row.tokenId);
                }
                catch {
                    continue;
                }
                if (tid < ISSUED_NFT_START_ID)
                    continue;
                let valid = false;
                try {
                    valid = await cardContract.isIssuedNftValid(tid);
                }
                catch {
                    continue;
                }
                if (!valid)
                    continue;
                let maxSupply = null;
                let mintedCount = null;
                try {
                    const ms = await cardContract.issuedNftMaxSupply(tid);
                    if (ms === 0n)
                        continue;
                    maxSupply = ms;
                    try {
                        mintedCount = await cardContract.issuedNftMintedCount(tid);
                    }
                    catch {
                        mintedCount = null;
                    }
                }
                catch {
                    // unknown maxSupply: keep valid rows
                }
                let va = 0n;
                let vb = 0n;
                try {
                    va = await cardContract.issuedNftValidAfter(tid);
                }
                catch {
                    va = 0n;
                }
                try {
                    vb = await cardContract.issuedNftValidBefore(tid);
                }
                catch {
                    vb = 0n;
                }
                const remainingSupply = maxSupply != null && mintedCount != null
                    ? (maxSupply > mintedCount ? maxSupply - mintedCount : 0n)
                    : null;
                items.push({
                    cardAddress: row.cardAddress,
                    tokenId: row.tokenId,
                    sharedMetadataHash: row.sharedMetadataHash,
                    ipfsCid: row.ipfsCid,
                    cardOwner: row.cardOwner,
                    metadata: row.metadata,
                    createdAt: row.createdAt,
                    issuedNftValidAfter: String(va),
                    issuedNftValidBefore: String(vb),
                    ...(maxSupply != null ? { issuedNftMaxSupply: String(maxSupply) } : {}),
                    ...(mintedCount != null ? { issuedNftMintedCount: String(mintedCount) } : {}),
                    ...(remainingSupply != null ? { issuedNftRemainingSupply: String(remainingSupply) } : {}),
                });
            }
            const data = { cardAddress: checksum, limit, items };
            cardActiveIssuedCouponSeriesCache.set(cacheKey, { data, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json(data);
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[cardActiveIssuedCouponSeries] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch active issued coupons for card' });
        }
    });
    /** GET /api/cardActiveIssuedProductionSeries — Program productions / services (category=productions) */
    router.get('/cardActiveIssuedProductionSeries', async (req, res) => {
        const { card } = req.query;
        if (!card || !ethers_1.ethers.isAddress(card)) {
            return res.status(400).json({ error: 'Invalid card address' });
        }
        let limit = Number(req.query.limit ?? 20);
        if (!Number.isFinite(limit))
            limit = 20;
        limit = Math.floor(limit);
        limit = Math.min(Math.max(limit, 1), 50);
        const checksum = ethers_1.ethers.getAddress(card);
        const cacheKey = `${checksum.toLowerCase()}:${limit}`;
        const cached = cardActiveIssuedProductionSeriesCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json(cached.data);
        }
        try {
            const scanLimit = Math.min(400, Math.max(60, limit * 25));
            const candidates = await (0, db_1.listProductionIssuedNftSeriesForCardDescending)(checksum, scanLimit);
            const seenToken = new Set();
            const ordered = [];
            for (const row of candidates) {
                if (seenToken.has(row.tokenId))
                    continue;
                seenToken.add(row.tokenId);
                ordered.push(row);
            }
            const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(checksum);
            const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
            const cardContract = new ethers_1.ethers.Contract(checksum, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider);
            const items = [];
            for (const row of ordered) {
                if (items.length >= limit)
                    break;
                if (!(0, couponMetadataCategory_1.metadataMatchesClientProductionCategoryFilter)(row.metadata))
                    continue;
                let tid;
                try {
                    tid = BigInt(row.tokenId);
                }
                catch {
                    continue;
                }
                if (tid < ISSUED_NFT_START_ID)
                    continue;
                let valid = false;
                try {
                    valid = await cardContract.isIssuedNftValid(tid);
                }
                catch {
                    continue;
                }
                if (!valid)
                    continue;
                let maxSupply = null;
                let mintedCount = null;
                try {
                    const ms = await cardContract.issuedNftMaxSupply(tid);
                    if (ms === 0n)
                        continue;
                    maxSupply = ms;
                    try {
                        mintedCount = await cardContract.issuedNftMintedCount(tid);
                    }
                    catch {
                        mintedCount = null;
                    }
                }
                catch {
                    // unknown maxSupply: keep valid rows
                }
                let va = 0n;
                let vb = 0n;
                try {
                    va = await cardContract.issuedNftValidAfter(tid);
                }
                catch {
                    va = 0n;
                }
                try {
                    vb = await cardContract.issuedNftValidBefore(tid);
                }
                catch {
                    vb = 0n;
                }
                const remainingSupply = maxSupply != null && mintedCount != null
                    ? (maxSupply > mintedCount ? maxSupply - mintedCount : 0n)
                    : null;
                items.push({
                    cardAddress: row.cardAddress,
                    tokenId: row.tokenId,
                    sharedMetadataHash: row.sharedMetadataHash,
                    ipfsCid: row.ipfsCid,
                    cardOwner: row.cardOwner,
                    metadata: row.metadata,
                    createdAt: row.createdAt,
                    issuedNftValidAfter: String(va),
                    issuedNftValidBefore: String(vb),
                    ...(maxSupply != null ? { issuedNftMaxSupply: String(maxSupply) } : {}),
                    ...(mintedCount != null ? { issuedNftMintedCount: String(mintedCount) } : {}),
                    ...(remainingSupply != null ? { issuedNftRemainingSupply: String(remainingSupply) } : {}),
                });
            }
            const data = { cardAddress: checksum, limit, items };
            cardActiveIssuedProductionSeriesCache.set(cacheKey, { data, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json(data);
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[cardActiveIssuedProductionSeries] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch active issued productions for card' });
        }
    });
    /** GET /api/seriesSharedMetadata - 返回 sharedSeriesMetadata（IPFS 或自定义 metadata）。30 秒缓存 */
    router.get('/seriesSharedMetadata', async (req, res) => {
        const { card, tokenId } = req.query;
        if (!card || !ethers_1.ethers.isAddress(card) || !tokenId) {
            return res.status(400).json({ error: 'Invalid card or tokenId' });
        }
        const cacheKey = `${ethers_1.ethers.getAddress(card).toLowerCase()}:${tokenId}`;
        const cached = seriesSharedMetadataCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json(cached.data);
        }
        const tid = BigInt(tokenId);
        if (tid < ISSUED_NFT_START_ID) {
            return res.status(400).json({ error: 'tokenId must be >= ISSUED_NFT_START_ID' });
        }
        try {
            const series = await (0, db_1.getSeriesByCardAndTokenId)(card, tokenId);
            if (!series) {
                return res.status(404).json({ error: 'Series not registered' });
            }
            let sharedJson = null;
            if (series.ipfsCid && series.ipfsCid.trim() !== '') {
                const ipfsUrl = `https://ipfs.io/ipfs/${series.ipfsCid}`;
                const ipfsRes = await fetch(ipfsUrl);
                if (ipfsRes.ok) {
                    const parsed = await ipfsRes.json();
                    if (parsed && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
                        sharedJson = parsed;
                }
            }
            if (!sharedJson && series.metadata && typeof series.metadata === 'object') {
                sharedJson = series.metadata;
            }
            const rawShared = (sharedJson ?? {});
            const sharedWithImage = ensureMetadataImage({ ...rawShared });
            const data = {
                cardAddress: series.cardAddress,
                tokenId: series.tokenId,
                sharedMetadataHash: series.sharedMetadataHash,
                ipfsCid: series.ipfsCid || null,
                metadata: series.metadata ?? null,
                sharedSeriesMetadata: sharedWithImage,
            };
            seriesSharedMetadataCache.set(cacheKey, { data, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json(data);
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[seriesSharedMetadata] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch shared metadata' });
        }
    });
    /** GET /api/mintMetadata - owner 在某系列下的各笔 mint metadata。30 秒缓存 */
    router.get('/mintMetadata', async (req, res) => {
        const { card, tokenId, owner } = req.query;
        if (!card || !ethers_1.ethers.isAddress(card) || !tokenId || !owner || !ethers_1.ethers.isAddress(owner)) {
            return res.status(400).json({ error: 'Invalid card, tokenId, or owner' });
        }
        const cacheKey = `${ethers_1.ethers.getAddress(card).toLowerCase()}:${tokenId}:${ethers_1.ethers.getAddress(owner).toLowerCase()}`;
        const cached = mintMetadataCache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return res.status(200).json({ items: cached.items });
        }
        try {
            const items = await (0, db_1.getMintMetadataForOwner)(card, tokenId, owner);
            mintMetadataCache.set(cacheKey, { items, expiry: Date.now() + QUERY_CACHE_TTL_MS });
            res.status(200).json({ items });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[mintMetadata] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to fetch mint metadata' });
        }
    });
    /** POST /api/registerSeries - 登记 NFT 系列到 DB（cluster 预检后转发）。tokenId 必须来自 createIssuedNft 返回值；ipfsCid 可选，无 IPFS 时用 metadata 作为 shared metadata */
    router.post('/registerSeries', async (req, res) => {
        const { cardAddress, tokenId, sharedMetadataHash, ipfsCid, metadata } = req.body;
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress) || !tokenId || !sharedMetadataHash) {
            return res.status(400).json({ error: 'Missing cardAddress, tokenId, or sharedMetadataHash' });
        }
        const hasIpfs = ipfsCid != null && String(ipfsCid).trim() !== '';
        const hasMetadata = metadata != null && typeof metadata === 'object';
        if (!hasIpfs && !hasMetadata) {
            return res.status(400).json({ error: 'Provide ipfsCid or metadata (custom JSON object) for shared metadata' });
        }
        if ((0, MemberCard_1.couponWorkflowDebugEnabled)()) {
            const mk = metadata ? Object.keys(metadata) : [];
            (0, logger_1.logger)(safe_1.default.magenta(`[couponWorkflow][Master] registerSeries card=${ethers_1.ethers.getAddress(cardAddress)} tokenId=${String(tokenId)} hasIpfs=${hasIpfs} metadataKeys=${mk.join(',') || 'none'}`));
        }
        try {
            const cardAddrNorm = ethers_1.ethers.getAddress(cardAddress);
            const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddrNorm);
            const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
            const cardContract = new ethers_1.ethers.Contract(cardAddrNorm, BEAMIO_USER_CARD_ISSUED_NFT_ABI, provider);
            const cardOwner = await cardContract.owner();
            const onChainHash = await cardContract.issuedNftSharedMetadataHash(tokenId);
            const expectedHash = sharedMetadataHash.startsWith('0x') ? sharedMetadataHash : '0x' + sharedMetadataHash;
            if (ethers_1.ethers.hexlify(onChainHash) !== expectedHash.toLowerCase()) {
                return res.status(400).json({ error: 'sharedMetadataHash does not match chain' });
            }
            await (0, db_1.registerSeriesToDb)({
                cardAddress,
                tokenId: String(tokenId),
                sharedMetadataHash: expectedHash,
                ipfsCid: hasIpfs ? String(ipfsCid).trim() : undefined,
                cardOwner,
                metadataJson: metadata ? (0, couponMetadataCategory_1.normalizeCouponSeriesMetadataJson)(metadata) : undefined,
            });
            (0, issuedCouponSeriesQueryCache_1.invalidateIssuedCouponSeriesQueryCachesForCard)(cardAddrNorm, String(tokenId));
            res.status(200).json({ success: true });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[registerSeries] error:'), err?.message ?? err);
            if ((0, MemberCard_1.couponWorkflowDebugEnabled)()) {
                (0, logger_1.logger)(safe_1.default.gray(`[couponWorkflow][Master] registerSeries failed card=${cardAddress != null ? String(cardAddress) : 'n/a'} tokenId=${tokenId != null ? String(tokenId) : 'n/a'}`));
            }
            res.status(500).json({ error: err?.message ?? 'Failed to register series' });
        }
    });
    /** POST /api/registerMintMetadata - 登记单笔 mint 的 metadata（cluster 预检后转发） */
    router.post('/registerMintMetadata', async (req, res) => {
        const { cardAddress, tokenId, ownerAddress, txHash, metadata } = req.body;
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress) || !tokenId || !ownerAddress || !ethers_1.ethers.isAddress(ownerAddress) || !metadata || typeof metadata !== 'object') {
            return res.status(400).json({ error: 'Missing cardAddress, tokenId, ownerAddress, or metadata (object)' });
        }
        try {
            await (0, db_1.registerMintMetadataToDb)({
                cardAddress,
                tokenId: String(tokenId),
                ownerAddress,
                txHash,
                metadataJson: metadata,
            });
            res.status(200).json({ success: true });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[registerMintMetadata] error:'), err?.message ?? err);
            res.status(500).json({ error: err?.message ?? 'Failed to register mint metadata' });
        }
    });
    /** 创建 BeamioUserCard。由 cluster 完整预检，master 不做任何入站校验，直接入队 createCardPool。*/
    router.post('/createCard', (req, res) => {
        const body = req.body;
        MemberCard_1.createCardPool.push({ ...body, res });
        (0, logger_1.logger)(safe_1.default.cyan(`[createCard] pushed to pool, cardOwner=${body.cardOwner}`));
        (0, MemberCard_1.createCardPoolPress)();
    });
    router.post('/longDhangMigrationCreateCard', async (req, res) => {
        const body = req.body;
        try {
            const result = await (0, longDhangConetMigration_1.createLongDhangConetMigrationCard)({
                cardOwnerEoa: body.ownerEoa,
            });
            if (!result.success) {
                return res.status(400).json(result).end();
            }
            return res.status(200).json(result).end();
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.red(`[longDhangMigrationCreateCard] failed: ${e?.message ?? e}`));
            return res.status(500).json({ success: false, error: e?.message ?? 'Create LongDhang CoNET card failed.' }).end();
        }
    });
    router.post('/longDhangMigrationRun', async (req, res) => {
        const body = req.body;
        try {
            if (!body.newCardAddress || !ethers_1.ethers.isAddress(body.newCardAddress)) {
                return res.status(400).json({ success: false, error: 'Invalid newCardAddress.' }).end();
            }
            const result = await (0, longDhangConetMigration_1.runLongDhangConetMigrationBatch)({
                newCardAddress: body.newCardAddress,
                snapshotHash: body.snapshotHash,
                limit: Number.isFinite(Number(body.limit)) ? Math.max(1, Math.floor(Number(body.limit))) : undefined,
            });
            return res.status(result.success ? 200 : 400).json(result).end();
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.red(`[longDhangMigrationRun] failed: ${e?.message ?? e}`));
            return res.status(500).json({ success: false, error: e?.message ?? 'LongDhang migration failed.' }).end();
        }
    });
    router.post('/longDhangMigrationExecuteAuto', async (req, res) => {
        const body = req.body;
        try {
            const result = await (0, longDhangConetMigration_1.executeLongDhangConetMigrationAuto)({
                existingNewCardAddress: body.existingNewCardAddress,
                snapshotHash: body.snapshotHash,
                cardOwnerEoa: body.ownerEoa,
            });
            return res.status(result.success ? 200 : 400).json(result).end();
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.red(`[longDhangMigrationExecuteAuto] failed: ${e?.message ?? e}`));
            return res.status(500).json({ success: false, error: e?.message ?? 'LongDhang auto migration failed.' }).end();
        }
    });
    router.post('/longDhangMigrationRepairTerminals', async (req, res) => {
        const body = req.body;
        if (!body.newCardAddress || !ethers_1.ethers.isAddress(body.newCardAddress)) {
            return res.status(400).json({ success: false, error: 'Invalid newCardAddress.' }).end();
        }
        try {
            const result = await (0, longDhangConetMigration_1.repairLongDhangMigrationTerminalsOnly)({
                newCardAddress: body.newCardAddress,
                snapshotHash: body.snapshotHash,
            });
            return res.status(result.success ? 200 : 400).json(result).end();
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.red(`[longDhangMigrationRepairTerminals] failed: ${e?.message ?? e}`));
            return res.status(500).json({ success: false, error: e?.message ?? 'Terminal repair failed.' }).end();
        }
    });
    /**
     * 已发卡仅更新 ERC-1155 卡级 JSON（recharge bonus / shareTokenMetadata / tiers 等），不写链。
     * Cluster 需在预检（持卡人身份等）后转发至 Master，与 /api/createCard 一致。
     */
    router.post('/updateCardShareMetadata', async (req, res) => {
        const body = req.body;
        const cardAddress = body.cardAddress?.trim();
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
            res.status(400).json({ success: false, error: 'Invalid or missing cardAddress' }).end();
            return;
        }
        if (!body.shareTokenMetadata || typeof body.shareTokenMetadata !== 'object') {
            res.status(400).json({ success: false, error: 'shareTokenMetadata object is required' }).end();
            return;
        }
        if ((0, MemberCard_1.couponWorkflowDebugEnabled)()) {
            const sm = body.shareTokenMetadata;
            const couponsRaw = sm.coupons;
            const couponsLen = Array.isArray(couponsRaw) ? couponsRaw.length : -1;
            (0, logger_1.logger)(safe_1.default.magenta(`[couponWorkflow][Master] updateCardShareMetadata card=${ethers_1.ethers.getAddress(cardAddress)} shareTokenMetadataKeys=${Object.keys(sm).join(',')} couponsLength=${couponsLen}`));
        }
        try {
            const r = await (0, MemberCard_1.applyBeamioCardShareMetadataUpdate)({
                cardAddress,
                shareTokenMetadata: body.shareTokenMetadata,
                ...(body.tiers != null && { tiers: body.tiers }),
                ...(body.baseMembership !== undefined && { baseMembership: body.baseMembership }),
                ...(body.upgradeType != null && { upgradeType: body.upgradeType }),
                ...(typeof body.transferWhitelistEnabled === 'boolean' && {
                    transferWhitelistEnabled: body.transferWhitelistEnabled,
                }),
            });
            if (!r.success) {
                res.status(400).json({ success: false, error: r.error ?? 'Metadata update failed' }).end();
                return;
            }
            res.status(200).json({ success: true, cardAddress: ethers_1.ethers.getAddress(cardAddress) }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[updateCardShareMetadata] error:'), err?.message ?? err);
            if ((0, MemberCard_1.couponWorkflowDebugEnabled)()) {
                (0, logger_1.logger)(safe_1.default.gray(`[couponWorkflow][Master] updateCardShareMetadata failed card=${cardAddress}`));
            }
            res.status(500).json({ success: false, error: err?.message ?? 'Metadata update failed' }).end();
        }
    });
    /**
     * Merchant owner blacklists program card — DB + runtime exclude set (no on-chain tx).
     */
    router.post('/excludeUserCard', async (req, res) => {
        const body = req.body;
        const cardAddress = body.cardAddress?.trim();
        const excludedBy = body.excludedBy?.trim();
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
            res.status(400).json({ success: false, error: 'Invalid or missing cardAddress' }).end();
            return;
        }
        if (!excludedBy || !ethers_1.ethers.isAddress(excludedBy)) {
            res.status(400).json({ success: false, error: 'Invalid or missing excludedBy' }).end();
            return;
        }
        try {
            const r = await (0, excludeUserCardApi_1.applyExcludeUserCard)({ cardAddress, excludedBy });
            if (!r.success) {
                res.status(400).json({ success: false, error: r.error ?? 'Exclude failed' }).end();
                return;
            }
            res.status(200).json({ success: true, cardAddress: r.cardAddress }).end();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            (0, logger_1.logger)(safe_1.default.red('[excludeUserCard] error:'), msg);
            res.status(500).json({ success: false, error: msg }).end();
        }
    });
    /**
     * 仅更新 `shareTokenMetadata.merchantImage`（https URL）或传空字符串清除；合并 DB 现有 metadata 后写 JSON + beamio_cards。
     */
    router.post('/updateCardMerchantImage', async (req, res) => {
        const body = req.body;
        const cardAddress = body.cardAddress?.trim();
        const merchantImage = body.merchantImage != null ? String(body.merchantImage) : '';
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
            res.status(400).json({ success: false, error: 'Invalid or missing cardAddress' }).end();
            return;
        }
        try {
            const r = await (0, MemberCard_1.applyBeamioCardMerchantImageUrlUpdate)({
                cardAddress,
                merchantImage,
            });
            if (!r.success) {
                res.status(400).json({ success: false, error: r.error ?? 'Merchant image update failed' }).end();
                return;
            }
            res.status(200).json({ success: true, cardAddress: ethers_1.ethers.getAddress(cardAddress) }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[updateCardMerchantImage] error:'), err?.message ?? err);
            res.status(500).json({ success: false, error: err?.message ?? 'Merchant image update failed' }).end();
        }
    });
    /**
     * 仅更新 `shareTokenMetadata.image`（https URL）或传空字符串清除；合并 DB 现有 metadata 后写 JSON + beamio_cards。
     */
    router.post('/updateCardProgramImage', async (req, res) => {
        const body = req.body;
        const cardAddress = body.cardAddress?.trim();
        const image = body.image != null ? String(body.image) : '';
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
            res.status(400).json({ success: false, error: 'Invalid or missing cardAddress' }).end();
            return;
        }
        try {
            const r = await (0, MemberCard_1.applyBeamioCardProgramImageUrlUpdate)({
                cardAddress,
                image,
            });
            if (!r.success) {
                res.status(400).json({ success: false, error: r.error ?? 'Program image update failed' }).end();
                return;
            }
            res.status(200).json({ success: true, cardAddress: ethers_1.ethers.getAddress(cardAddress) }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[updateCardProgramImage] error:'), err?.message ?? err);
            res.status(500).json({ success: false, error: err?.message ?? 'Program image update failed' }).end();
        }
    });
    /** 已发行 coupon：允许更新 metadata（icon / description / backgroundColor / couponImage 宽屏背景图 URL）。 */
    router.post('/updateIssuedCouponMetadata', async (req, res) => {
        try {
            const body = req.body;
            const cardAddress = body.cardAddress?.trim();
            const couponId = body.couponId?.trim() ?? '';
            const issuedTokenIdRaw = body.issuedTokenId?.trim() ?? '';
            if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
                return res.status(400).json({ success: false, error: 'Invalid or missing cardAddress' }).end();
            }
            if (!couponId) {
                return res.status(400).json({ success: false, error: 'couponId is required' }).end();
            }
            let tokenIdNorm;
            try {
                tokenIdNorm = String(BigInt(issuedTokenIdRaw));
            }
            catch {
                return res.status(400).json({ success: false, error: 'issuedTokenId must be an integer string' }).end();
            }
            const couponImageTrim = typeof body.couponImage === 'string' ? body.couponImage.trim() : '';
            if (couponImageTrim && !(0, MemberCard_1.isAllowedMerchantImageHttpsUrl)(couponImageTrim)) {
                return res
                    .status(400)
                    .json({ success: false, error: 'couponImage must be a non-localhost https URL (max 2048 characters).' })
                    .end();
            }
            const cardNorm = ethers_1.ethers.getAddress(cardAddress);
            (0, logger_1.logger)(safe_1.default.cyan(`[updateIssuedCouponMetadata] start card=${cardNorm} couponId=${couponId} issuedTokenId=${tokenIdNorm} icon=${summarizeCouponIconForDebugLog(body.icon)}`));
            const cardRow = await (0, db_1.getCardByAddress)(cardNorm);
            if (!cardRow) {
                (0, logger_1.logger)(safe_1.default.yellow(`[updateIssuedCouponMetadata] card row missing card=${cardNorm}`));
                return res.status(404).json({ success: false, error: 'Card metadata not found' }).end();
            }
            const cardMeta = (cardRow.metadata ?? {});
            const shareTokenMetadata = (cardMeta.shareTokenMetadata && typeof cardMeta.shareTokenMetadata === 'object' && !Array.isArray(cardMeta.shareTokenMetadata)
                ? { ...cardMeta.shareTokenMetadata }
                : {});
            const coupons = Array.isArray(shareTokenMetadata.coupons)
                ? [...shareTokenMetadata.coupons]
                : [];
            const couponIdx = coupons.findIndex((item) => {
                const id = String(item?.couponId ?? item?.id ?? '').trim();
                const tok = String(item?.issuedTokenId ?? '').trim();
                return id === couponId && tok === tokenIdNorm;
            });
            let seriesOnlyPath = false;
            if (couponIdx < 0) {
                const seriesProbe = await (0, db_1.getSeriesByCardAndTokenId)(cardNorm, tokenIdNorm);
                const seriesMatch = seriesProbe
                    ? seriesMetadataMatchesIssuedCoupon(seriesProbe.metadata, couponId, tokenIdNorm)
                    : false;
                const keysForLog = coupons.slice(0, 12).map((item) => ({
                    couponId: String(item?.couponId ?? '').trim() || undefined,
                    id: String(item?.id ?? '').trim() || undefined,
                    issuedTokenId: String(item?.issuedTokenId ?? '').trim() || undefined,
                }));
                if (!seriesProbe || !seriesMatch) {
                    (0, logger_1.logger)(safe_1.default.yellow(`[updateIssuedCouponMetadata] no shareTokenMetadata coupon match wanted couponId=${couponId} issuedTokenId=${tokenIdNorm} couponsLen=${coupons.length} seriesRow=${Boolean(seriesProbe)} seriesMetaMatch=${seriesMatch} sample=${(0, node_util_1.inspect)(keysForLog, false, 4, true)}`));
                    return res.status(404).json({ success: false, error: 'Issued coupon metadata row not found' }).end();
                }
                seriesOnlyPath = true;
                (0, logger_1.logger)(safe_1.default.cyan(`[updateIssuedCouponMetadata] series-only path (shareTokenMetadata.coupons empty/mismatch; beamio_nft_series metadata matches) card=${cardNorm} tokenId=${tokenIdNorm}`));
            }
            else {
                const coupon = { ...coupons[couponIdx] };
                delete coupon.discountPercent;
                coupon.category = couponMetadataCategory_1.BEAMIO_COUPON_NFT_CATEGORY;
                setOrDeleteStringField(coupon, 'icon', String(body.icon ?? ''));
                setOrDeleteStringField(coupon, 'backgroundColor', String(body.backgroundColor ?? ''));
                setOrDeleteStringField(coupon, 'description', String(body.description ?? ''));
                setOrDeleteStringField(coupon, 'couponImage', couponImageTrim);
                if (typeof body.disable === 'boolean') {
                    setOrDeleteBooleanField(coupon, 'disable', body.disable);
                }
                coupons[couponIdx] = coupon;
                shareTokenMetadata.coupons = coupons;
                const applyRes = await (0, MemberCard_1.applyBeamioCardShareMetadataUpdate)({
                    cardAddress: cardNorm,
                    shareTokenMetadata,
                    ...(Array.isArray(cardMeta.tiers) ? { tiers: cardMeta.tiers } : {}),
                    ...(cardMeta.upgradeType != null ? { upgradeType: Number(cardMeta.upgradeType) } : {}),
                    ...(typeof cardMeta.transferWhitelistEnabled === 'boolean'
                        ? { transferWhitelistEnabled: cardMeta.transferWhitelistEnabled }
                        : {}),
                });
                if (!applyRes.success) {
                    (0, logger_1.logger)(safe_1.default.red(`[updateIssuedCouponMetadata] applyBeamioCardShareMetadataUpdate failed card=${cardNorm} err=${applyRes.error ?? 'unknown'}`));
                    return res.status(400).json({ success: false, error: applyRes.error ?? 'Metadata update failed' }).end();
                }
                (0, logger_1.logger)(safe_1.default.green(`[updateIssuedCouponMetadata] shareTokenMetadata.coupons updated card=${cardNorm} idx=${couponIdx}`));
            }
            const series = await (0, db_1.getSeriesByCardAndTokenId)(cardNorm, tokenIdNorm);
            if (seriesOnlyPath && !series) {
                (0, logger_1.logger)(safe_1.default.red(`[updateIssuedCouponMetadata] series row disappeared after probe card=${cardNorm} tokenId=${tokenIdNorm}`));
                return res
                    .status(500)
                    .json({ success: false, error: 'Issued coupon series row unavailable after validation.' })
                    .end();
            }
            const seriesMetaObj = series?.metadata && typeof series.metadata === 'object' && !Array.isArray(series.metadata);
            (0, logger_1.logger)(safe_1.default.cyan(`[updateIssuedCouponMetadata] beamio_nft_series row found=${Boolean(series)} metaIsObject=${Boolean(seriesMetaObj)} card=${cardNorm} tokenId=${tokenIdNorm}`));
            if (series) {
                const nextSeriesMeta = (0, couponMetadataCategory_1.normalizeCouponSeriesMetadataJson)(seriesMetaObj
                    ? { ...series.metadata }
                    : {});
                delete nextSeriesMeta.discountPercent;
                setOrDeleteStringField(nextSeriesMeta, 'icon', String(body.icon ?? ''));
                setOrDeleteStringField(nextSeriesMeta, 'backgroundColor', String(body.backgroundColor ?? ''));
                setOrDeleteStringField(nextSeriesMeta, 'description', String(body.description ?? ''));
                setOrDeleteStringField(nextSeriesMeta, 'couponImage', couponImageTrim);
                if (typeof body.disable === 'boolean') {
                    setOrDeleteBooleanField(nextSeriesMeta, 'disable', body.disable);
                }
                if (nextSeriesMeta.properties && typeof nextSeriesMeta.properties === 'object' && !Array.isArray(nextSeriesMeta.properties)) {
                    const props = (0, couponMetadataCategory_1.normalizeCouponCategoryOnTierProperties)({
                        ...nextSeriesMeta.properties,
                    });
                    if (props.beamioCoupon && typeof props.beamioCoupon === 'object' && !Array.isArray(props.beamioCoupon)) {
                        const beamioCoupon = { ...props.beamioCoupon };
                        delete beamioCoupon.discountPercent;
                        setOrDeleteStringField(beamioCoupon, 'icon', String(body.icon ?? ''));
                        setOrDeleteStringField(beamioCoupon, 'backgroundColor', String(body.backgroundColor ?? ''));
                        setOrDeleteStringField(beamioCoupon, 'description', String(body.description ?? ''));
                        setOrDeleteStringField(beamioCoupon, 'couponImage', couponImageTrim);
                        if (typeof body.disable === 'boolean') {
                            setOrDeleteBooleanField(beamioCoupon, 'disable', body.disable);
                        }
                        props.beamioCoupon = beamioCoupon;
                    }
                    nextSeriesMeta.properties = props;
                }
                const seriesUpdated = await (0, db_1.updateSeriesMetadataByCardAndToken)({
                    cardAddress: cardNorm,
                    tokenId: tokenIdNorm,
                    metadataJson: nextSeriesMeta,
                });
                if (!seriesUpdated) {
                    (0, logger_1.logger)(safe_1.default.red(`[updateIssuedCouponMetadata] beamio_nft_series UPDATE rowCount=0 card=${cardNorm} tokenId=${tokenIdNorm} icon=${summarizeCouponIconForDebugLog(body.icon)}`));
                    return res
                        .status(500)
                        .json({ success: false, error: 'Failed to persist issued coupon series metadata (beamio_nft_series).' })
                        .end();
                }
                (0, logger_1.logger)(safe_1.default.green(`[updateIssuedCouponMetadata] beamio_nft_series metadata_json updated card=${cardNorm} tokenId=${tokenIdNorm} icon=${summarizeCouponIconForDebugLog(String(body.icon ?? ''))}`));
            }
            else {
                (0, logger_1.logger)(safe_1.default.yellow(`[updateIssuedCouponMetadata] no beamio_nft_series row (GET /api/cardActiveIssuedCouponSeries may stay stale until registerSeries) card=${cardNorm} tokenId=${tokenIdNorm}`));
            }
            const tierMeta = await (0, db_1.getNftTierMetadataByCardAndToken)(cardNorm, Number(tokenIdNorm));
            if (tierMeta && typeof tierMeta === 'object') {
                const nextTierMeta = { ...tierMeta };
                delete nextTierMeta.discountPercent;
                setOrDeleteStringField(nextTierMeta, 'image', String(body.icon ?? ''));
                setOrDeleteStringField(nextTierMeta, 'background_color', String(body.backgroundColor ?? ''));
                setOrDeleteStringField(nextTierMeta, 'description', String(body.description ?? ''));
                const tierProps = (0, couponMetadataCategory_1.normalizeCouponCategoryOnTierProperties)(nextTierMeta.properties && typeof nextTierMeta.properties === 'object' && !Array.isArray(nextTierMeta.properties)
                    ? { ...nextTierMeta.properties }
                    : {});
                const beamioCoupon = tierProps.beamioCoupon && typeof tierProps.beamioCoupon === 'object' && !Array.isArray(tierProps.beamioCoupon)
                    ? { ...tierProps.beamioCoupon }
                    : {};
                delete beamioCoupon.discountPercent;
                setOrDeleteStringField(beamioCoupon, 'icon', String(body.icon ?? ''));
                setOrDeleteStringField(beamioCoupon, 'backgroundColor', String(body.backgroundColor ?? ''));
                setOrDeleteStringField(beamioCoupon, 'description', String(body.description ?? ''));
                setOrDeleteStringField(beamioCoupon, 'couponImage', couponImageTrim);
                if (typeof body.disable === 'boolean') {
                    setOrDeleteBooleanField(beamioCoupon, 'disable', body.disable);
                }
                if (Object.keys(beamioCoupon).length > 0) {
                    tierProps.beamioCoupon = beamioCoupon;
                }
                nextTierMeta.properties = tierProps;
                await (0, db_1.upsertNftTierMetadata)({
                    cardAddress: cardNorm,
                    cardOwner: cardRow.cardOwner,
                    tokenId: Number(tokenIdNorm),
                    metadataJson: nextTierMeta,
                });
                (0, logger_1.logger)(safe_1.default.green(`[updateIssuedCouponMetadata] nft_tier_metadata upserted card=${cardNorm} tokenId=${tokenIdNorm}`));
            }
            else {
                (0, logger_1.logger)(safe_1.default.cyan(`[updateIssuedCouponMetadata] no nft_tier_metadata row card=${cardNorm} tokenId=${tokenIdNorm}`));
            }
            (0, logger_1.logger)(safe_1.default.green(`[updateIssuedCouponMetadata] done 200 card=${cardNorm} couponId=${couponId} tokenId=${tokenIdNorm} seriesOnlyPath=${seriesOnlyPath} icon=${summarizeCouponIconForDebugLog(String(body.icon ?? ''))}`));
            return res.status(200).json({ success: true, cardAddress: cardNorm }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[updateIssuedCouponMetadata] error:'), err?.message ?? err);
            return res.status(500).json({ success: false, error: err?.message ?? 'Issued coupon metadata update failed' }).end();
        }
    });
    /** Sync issued coupon socialPromotion from biz into beamio_nft_series + nft_tier_metadata (after card publish or explicit save). */
    router.post('/updateIssuedCouponSocialPromotion', async (req, res) => {
        try {
            const body = req.body;
            const cardAddress = body.cardAddress?.trim();
            const couponId = body.couponId?.trim() ?? '';
            const issuedTokenIdRaw = body.issuedTokenId?.trim() ?? '';
            if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
                return res.status(400).json({ success: false, error: 'Invalid or missing cardAddress' }).end();
            }
            if (!couponId) {
                return res.status(400).json({ success: false, error: 'couponId is required' }).end();
            }
            let tokenIdNorm;
            try {
                tokenIdNorm = String(BigInt(issuedTokenIdRaw));
            }
            catch {
                return res.status(400).json({ success: false, error: 'issuedTokenId must be an integer string' }).end();
            }
            const cardNorm = ethers_1.ethers.getAddress(cardAddress);
            const cardRow = await (0, db_1.getCardByAddress)(cardNorm);
            if (!cardRow) {
                return res.status(404).json({ success: false, error: 'Card metadata not found' }).end();
            }
            let socialPromotion;
            if (body.socialPromotion === null) {
                socialPromotion = null;
            }
            else if (body.socialPromotion === undefined) {
                socialPromotion = undefined;
            }
            else if (typeof body.socialPromotion === 'object' && !Array.isArray(body.socialPromotion)) {
                socialPromotion = body.socialPromotion;
            }
            else {
                return res.status(400).json({ success: false, error: 'socialPromotion must be an object or null' }).end();
            }
            (0, logger_1.logger)(safe_1.default.cyan(`[updateIssuedCouponSocialPromotion] start card=${cardNorm} couponId=${couponId} tokenId=${tokenIdNorm} hasSocial=${socialPromotion != null}`));
            const syncRes = await (0, issuedCouponSocialPromotionMetadataSync_1.syncIssuedCouponSocialPromotionMetadata)({
                cardAddress: cardNorm,
                cardOwner: cardRow.cardOwner,
                couponId,
                issuedTokenId: tokenIdNorm,
                socialPromotion,
                invalidateQueryCaches: true,
            });
            if (!syncRes.success) {
                return res.status(400).json({ success: false, error: syncRes.error ?? 'Social promotion sync failed' }).end();
            }
            (0, logger_1.logger)(safe_1.default.green(`[updateIssuedCouponSocialPromotion] done card=${cardNorm} tokenId=${tokenIdNorm} series=${syncRes.seriesUpdated} tier=${syncRes.tierUpdated}`));
            return res
                .status(200)
                .json({
                success: true,
                cardAddress: cardNorm,
                issuedTokenId: tokenIdNorm,
                seriesUpdated: syncRes.seriesUpdated,
                tierUpdated: syncRes.tierUpdated,
            })
                .end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red('[updateIssuedCouponSocialPromotion] error:'), err?.message ?? err);
            return res
                .status(500)
                .json({ success: false, error: err?.message ?? 'Issued coupon social promotion sync failed' })
                .end();
        }
    });
    router.post('/purchasingCard', (req, res) => {
        const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, preChecked, recommender } = req.body;
        MemberCard_1.purchasingCardPool.push({
            cardAddress,
            userSignature,
            nonce,
            usdcAmount,
            from,
            validAfter,
            validBefore,
            res: res,
            ...(preChecked != null && { preChecked }),
            ...(recommender != null && recommender !== '' && { recommender })
        });
        (0, logger_1.logger)(` Master GOT /api/purchasingCard ${preChecked ? '[preChecked]' : ''} doing purchasingCardProcess...`, (0, node_util_1.inspect)({ cardAddress, from, usdcAmount, hasPreChecked: !!preChecked }, false, 3, true));
        (0, MemberCard_1.purchasingCardProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[purchasingCardProcess] unhandled error (fire-and-forget):'), err?.message ?? err);
        });
    });
    router.post('/redeemReward13ForUsdc', (req, res) => {
        redeemReward13ForUsdc_1.redeemReward13ForUsdcPool.push({
            cardAddress: String(req.body?.cardAddress ?? ''),
            userEOA: String(req.body?.userEOA ?? ''),
            pointsCost: String(req.body?.pointsCost ?? ''),
            usdcReward6: String(req.body?.usdcReward6 ?? ''),
            deadline: Number(req.body?.deadline ?? 0),
            nonce: String(req.body?.nonce ?? ''),
            userSignature: String(req.body?.userSignature ?? ''),
            res,
        });
        (0, logger_1.logger)(` Master GOT /api/redeemReward13ForUsdc doing redeemReward13ForUsdcProcess...`, (0, node_util_1.inspect)({
            cardAddress: req.body?.cardAddress,
            userEOA: req.body?.userEOA,
            pointsCost: req.body?.pointsCost,
            usdcReward6: req.body?.usdcReward6,
        }, false, 3, true));
        (0, redeemReward13ForUsdc_1.kickRedeemReward13ForUsdcProcess)();
    });
    router.post('/topupWithReward13Container', (req, res) => {
        topupWithReward13Container_1.topupWithReward13ContainerPool.push({
            ...req.body,
            res,
        });
        (0, logger_1.logger)(` Master GOT /api/topupWithReward13Container…`, (0, node_util_1.inspect)({
            targetCard: req.body?.targetCard,
            userEOA: req.body?.userEOA,
            sameStoreBurn13: req.body?.sameStoreBurn13,
            peerUsdcCredited6: req.body?.peerUsdcCredited6,
            peers: Array.isArray(req.body?.peers) ? req.body.peers.length : 0,
            cash: Boolean(req.body?.cash),
        }, false, 3, true));
        (0, topupWithReward13Container_1.kickTopupWithReward13ContainerProcess)();
    });
    router.post('/convertReward13ToProgramPoints', (req, res) => {
        convertReward13_1.convertReward13ToProgramPointsPool.push({
            cardAddress: String(req.body?.cardAddress ?? ''),
            userEOA: String(req.body?.userEOA ?? ''),
            burn13: String(req.body?.burn13 ?? ''),
            deadline: Number(req.body?.deadline ?? 0),
            nonce: String(req.body?.nonce ?? ''),
            userSignature: String(req.body?.userSignature ?? ''),
            kind: 'toProgramPoints',
            res,
        });
        (0, logger_1.logger)(` Master GOT /api/convertReward13ToProgramPoints…`, (0, node_util_1.inspect)({ cardAddress: req.body?.cardAddress, userEOA: req.body?.userEOA, burn13: req.body?.burn13 }, false, 3, true));
        (0, convertReward13_1.kickConvertReward13Process)();
    });
    router.post('/convertReward13ToUsdcToAa', (req, res) => {
        convertReward13_1.convertReward13ToUsdcToAaPool.push({
            cardAddress: String(req.body?.cardAddress ?? ''),
            userEOA: String(req.body?.userEOA ?? ''),
            burn13: String(req.body?.burn13 ?? ''),
            deadline: Number(req.body?.deadline ?? 0),
            nonce: String(req.body?.nonce ?? ''),
            userSignature: String(req.body?.userSignature ?? ''),
            kind: 'toUsdcAa',
            res,
        });
        (0, logger_1.logger)(` Master GOT /api/convertReward13ToUsdcToAa…`, (0, node_util_1.inspect)({ cardAddress: req.body?.cardAddress, userEOA: req.body?.userEOA, burn13: req.body?.burn13 }, false, 3, true));
        (0, convertReward13_1.kickConvertReward13Process)();
    });
    /** USDC Topup（cluster 已完成完整预检）：master 直接入 purchasingCard 队列执行。 */
    router.post('/usdcTopup', (req, res) => {
        const { cardAddress, userSignature, nonce, usdcAmount, from, validAfter, validBefore, preChecked, recommender } = req.body;
        MemberCard_1.purchasingCardPool.push({
            cardAddress,
            userSignature,
            nonce,
            usdcAmount,
            from,
            validAfter,
            validBefore,
            res,
            ...(preChecked != null && { preChecked }),
            ...(recommender != null && recommender !== '' && { recommender })
        });
        (0, logger_1.logger)(` Master GOT /api/usdcTopup ${preChecked ? '[preChecked]' : ''} -> purchasingCardProcess`, (0, node_util_1.inspect)({ cardAddress, from, usdcAmount, hasPreChecked: !!preChecked }, false, 3, true));
        (0, MemberCard_1.purchasingCardProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[purchasingCardProcess] usdcTopup unhandled:'), err?.message ?? err);
        });
    });
    /** x402 BeamioTransfer 成功后：写入 BeamioIndexerDiamond（master 队列处理） */
    router.post('/beamioTransferIndexerAccounting', (req, res) => {
        (0, logger_1.logger)(safe_1.default.gray(`[DEBUG] beamioTransferIndexerAccounting received bodyKeys=${Object.keys(req.body || {}).join(',')} from=${req.body?.from?.slice?.(0, 10)}… to=${req.body?.to?.slice?.(0, 10)}… requestHash=${req.body?.requestHash ?? 'n/a'} poolBefore=${MemberCard_1.beamioTransferIndexerAccountingPool.length}`));
        const { from, to, amountUSDC6, finishedHash, displayJson, note, currency, currencyAmount, gasWei, gasUSDC6, gasChainType, baseGas, feePayer, isInternalTransfer, requestHash, source, payeeEOA, merchantCardAddress, ledgerTxId, ledgerOriginalPaymentHash, ledgerTxCategory, routeItems, ledgerFinalRequestAmountFiat6, ledgerFinalRequestAmountUSDC6, ledgerMetaRequestAmountFiat6, ledgerMetaRequestAmountUSDC6, ledgerMetaDiscountAmountFiat6, ledgerMetaDiscountRateBps, ledgerMetaTaxAmountFiat6, ledgerMetaTaxRateBps, bServiceUSDC6, bServiceUnits6, } = req.body;
        if (!ethers_1.ethers.isAddress(from) || !ethers_1.ethers.isAddress(to) || !amountUSDC6 || !finishedHash || !ethers_1.ethers.isAddress(feePayer)) {
            return res.status(400).json({ success: false, error: 'Invalid payload: from,to,amountUSDC6,finishedHash,feePayer required' }).end();
        }
        if (String(from).toLowerCase() === String(to).toLowerCase()) {
            (0, logger_1.logger)(safe_1.default.red(`[beamioTransferIndexerAccounting] REJECT: from=to (payer=payee) from=${from} finishedHash=${finishedHash}`));
            return res.status(400).json({ success: false, error: 'from and to must be different (payer≠payee)' }).end();
        }
        try {
            const amount = BigInt(amountUSDC6);
            if (amount <= 0n) {
                return res.status(400).json({ success: false, error: 'amountUSDC6 must be > 0' }).end();
            }
            if (!ethers_1.ethers.isHexString(finishedHash) || ethers_1.ethers.dataLength(finishedHash) !== 32) {
                return res.status(400).json({ success: false, error: 'finishedHash must be bytes32 tx hash' }).end();
            }
            const _gasWei = BigInt(gasWei ?? '0');
            if (_gasWei < 0n) {
                return res.status(400).json({ success: false, error: 'gasWei must be >= 0' }).end();
            }
            const _gasUSDC6 = BigInt(gasUSDC6 ?? '0');
            if (_gasUSDC6 < 0n) {
                return res.status(400).json({ success: false, error: 'gasUSDC6 must be >= 0' }).end();
            }
            if (gasChainType == null || !Number.isInteger(gasChainType) || gasChainType < 0 || gasChainType > 1) {
                return res.status(400).json({ success: false, error: 'gasChainType must be 0(ETH) or 1(SOLANA)' }).end();
            }
        }
        catch {
            return res.status(400).json({ success: false, error: 'Invalid bigint string: amountUSDC6/gasWei/gasUSDC6' }).end();
        }
        const reqHashValid = requestHash && ethers_1.ethers.isHexString(requestHash) && ethers_1.ethers.dataLength(requestHash) === 32 ? requestHash : undefined;
        // requestHash 预检已由 Cluster 完成，Master 假定数据合格
        if (!currency || !String(currency).trim()) {
            (0, logger_1.logger)(safe_1.default.yellow(`[DEBUG] beamioTransferIndexerAccounting: currency missing or empty from=${from} to=${to} finishedHash=${finishedHash}`));
        }
        const ledgerTxIdTrim = ledgerTxId != null ? String(ledgerTxId).trim() : '';
        const ledgerTxIdOk = ledgerTxIdTrim !== '' && ethers_1.ethers.isHexString(ledgerTxIdTrim) && ethers_1.ethers.dataLength(ledgerTxIdTrim) === 32;
        const ledgerOrigTrim = ledgerOriginalPaymentHash != null ? String(ledgerOriginalPaymentHash).trim() : '';
        const ledgerOrigOk = ledgerOrigTrim !== '' && ethers_1.ethers.isHexString(ledgerOrigTrim) && ethers_1.ethers.dataLength(ledgerOrigTrim) === 32;
        const ledgerCatTrim = ledgerTxCategory != null ? String(ledgerTxCategory).trim() : '';
        const ledgerCatOk = ledgerCatTrim !== '' && ethers_1.ethers.isHexString(ledgerCatTrim) && ethers_1.ethers.dataLength(ledgerCatTrim) === 32;
        const parsedRouteItems = normalizeBeamioRouteItemsFromBody(routeItems);
        MemberCard_1.beamioTransferIndexerAccountingPool.push({
            from: String(from),
            to: String(to),
            amountUSDC6: String(amountUSDC6),
            finishedHash: String(finishedHash),
            displayJson: displayJson ? String(displayJson) : undefined,
            note: note ? String(note) : '',
            currency: currency ? String(currency) : undefined,
            currencyAmount: currencyAmount != null ? String(currencyAmount) : undefined,
            gasWei: String(gasWei ?? '0'),
            gasUSDC6: String(gasUSDC6 ?? '0'),
            gasChainType: Number(gasChainType ?? 0),
            baseGas: baseGas != null ? String(baseGas) : undefined,
            feePayer: String(feePayer),
            isInternalTransfer: !!isInternalTransfer,
            requestHash: reqHashValid,
            source: source === 'x402' ? 'x402' : (source === 'open-container' || source === 'container' ? source : undefined),
            payeeEOA: payeeEOA && ethers_1.ethers.isAddress(payeeEOA) ? payeeEOA : undefined,
            merchantCardAddress: merchantCardAddress && ethers_1.ethers.isAddress(merchantCardAddress) ? merchantCardAddress : undefined,
            ...(ledgerTxIdOk ? { ledgerTxId: ledgerTxIdTrim } : {}),
            ...(ledgerOrigOk ? { ledgerOriginalPaymentHash: ledgerOrigTrim } : {}),
            ...(ledgerCatOk ? { ledgerTxCategory: ledgerCatTrim } : {}),
            ...(parsedRouteItems ? { routeItems: parsedRouteItems } : {}),
            ...(ledgerFinalRequestAmountFiat6 != null && String(ledgerFinalRequestAmountFiat6).trim() !== ''
                ? { ledgerFinalRequestAmountFiat6: String(ledgerFinalRequestAmountFiat6) }
                : {}),
            ...(ledgerFinalRequestAmountUSDC6 != null && String(ledgerFinalRequestAmountUSDC6).trim() !== ''
                ? { ledgerFinalRequestAmountUSDC6: String(ledgerFinalRequestAmountUSDC6) }
                : {}),
            ...(ledgerMetaRequestAmountFiat6 != null && String(ledgerMetaRequestAmountFiat6).trim() !== ''
                ? { ledgerMetaRequestAmountFiat6: String(ledgerMetaRequestAmountFiat6) }
                : {}),
            ...(ledgerMetaRequestAmountUSDC6 != null && String(ledgerMetaRequestAmountUSDC6).trim() !== ''
                ? { ledgerMetaRequestAmountUSDC6: String(ledgerMetaRequestAmountUSDC6) }
                : {}),
            ...(ledgerMetaDiscountAmountFiat6 != null && String(ledgerMetaDiscountAmountFiat6).trim() !== ''
                ? { ledgerMetaDiscountAmountFiat6: String(ledgerMetaDiscountAmountFiat6) }
                : {}),
            ...(ledgerMetaDiscountRateBps != null && Number.isFinite(Number(ledgerMetaDiscountRateBps))
                ? { ledgerMetaDiscountRateBps: Number(ledgerMetaDiscountRateBps) }
                : {}),
            ...(ledgerMetaTaxAmountFiat6 != null && String(ledgerMetaTaxAmountFiat6).trim() !== ''
                ? { ledgerMetaTaxAmountFiat6: String(ledgerMetaTaxAmountFiat6) }
                : {}),
            ...(ledgerMetaTaxRateBps != null && Number.isFinite(Number(ledgerMetaTaxRateBps))
                ? { ledgerMetaTaxRateBps: Number(ledgerMetaTaxRateBps) }
                : {}),
            ...(bServiceUSDC6 != null && String(bServiceUSDC6).trim() !== '' ? { bServiceUSDC6: String(bServiceUSDC6) } : {}),
            ...(bServiceUnits6 != null && String(bServiceUnits6).trim() !== '' ? { bServiceUnits6: String(bServiceUnits6) } : {}),
            res,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[beamioTransferIndexerAccounting] pushed to pool from=${from} to=${to} amountUSDC6=${amountUSDC6} requestHash=${reqHashValid ?? 'n/a'} (raw=${requestHash ?? 'undefined'})`));
        (0, MemberCard_1.beamioTransferIndexerAccountingProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[beamioTransferIndexerAccountingProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** AA Smart Wallet 离线签字提交：Cluster 已预检；Master 扣 0.1 B-Unit + indexer 后返回。 */
    router.post('/aaMultisigOfflineSubmit', (req, res) => {
        const body = req.body;
        if (!body?.inner || !body.submitterEoa || !body.feePayer || !body.dedupeKey) {
            return res.status(400).json({ success: false, error: 'Missing preChecked aaMultisigOfflineSubmit body' }).end();
        }
        const feeAmount = BigInt(body.feeAmount ?? '0');
        MemberCard_1.aaMultisigOfflineSubmitPool.push({
            inner: body.inner,
            submitterEoa: ethers_1.ethers.getAddress(body.submitterEoa),
            feePayer: ethers_1.ethers.getAddress(body.feePayer),
            feeAmount,
            dedupeKey: body.dedupeKey,
            res,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[aaMultisigOfflineSubmit] pushed to pool task=${body.inner.taskId}`));
        (0, MemberCard_1.kickAaMultisigOfflineSubmitProcess)();
    });
    /** Institutional AA V2 — EIP-712 propose / vote (Cluster prechecked). */
    router.post('/aaInstitutionalV2ProposeTransfer', (req, res) => {
        MemberCard_1.aaInstitutionalV2RelayPool.push({ kind: 'proposeTransfer', body: req.body, res });
        (0, MemberCard_1.kickAaInstitutionalV2RelayProcess)();
    });
    router.post('/aaInstitutionalV2ProposeSetPolicy', (req, res) => {
        MemberCard_1.aaInstitutionalV2RelayPool.push({ kind: 'proposeSetPolicy', body: req.body, res });
        (0, MemberCard_1.kickAaInstitutionalV2RelayProcess)();
    });
    router.post('/aaInstitutionalV2Vote', (req, res) => {
        MemberCard_1.aaInstitutionalV2RelayPool.push({ kind: 'vote', body: req.body, res });
        (0, MemberCard_1.kickAaInstitutionalV2RelayProcess)();
    });
    /** Beamio Pay Me 生成 request 记账（txCategory=request_create:confirmed，originalPaymentHash=requestHash）。Cluster 已预检 B-Unit 费用。 */
    router.post('/requestAccounting', (req, res) => {
        const { requestHash, payee, amount, currency, forText, validDays, feeBUnits, payerEOA } = req.body;
        if (!requestHash || !payee || !amount || validDays == null) {
            return res.status(400).json({ success: false, error: 'Missing required: requestHash, payee, amount, validDays' }).end();
        }
        if (!ethers_1.ethers.isHexString(requestHash) || ethers_1.ethers.dataLength(requestHash) !== 32) {
            return res.status(400).json({ success: false, error: 'requestHash must be bytes32' }).end();
        }
        if (!ethers_1.ethers.isAddress(payee)) {
            return res.status(400).json({ success: false, error: 'Invalid payee address' }).end();
        }
        const amt = parseFloat(String(amount));
        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ success: false, error: 'amount must be > 0' }).end();
        }
        const vd = Math.floor(Number(validDays));
        if (vd < 1) {
            return res.status(400).json({ success: false, error: 'validDays must be >= 1' }).end();
        }
        MemberCard_1.requestAccountingPool.push({
            requestHash: String(requestHash),
            payee: String(payee),
            amount: String(amount),
            currency: currency ? String(currency) : 'USD',
            forText: forText ? String(forText) : undefined,
            validDays: vd,
            feeBUnits: feeBUnits ? BigInt(feeBUnits) : undefined,
            payerEOA: payerEOA && ethers_1.ethers.isAddress(payerEOA) ? ethers_1.ethers.getAddress(payerEOA) : undefined,
            res,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[requestAccounting] pushed to pool requestHash=${requestHash} payee=${payee}`));
        (0, MemberCard_1.requestAccountingProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[requestAccountingProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** Payee 取消 Request：验证 payee 对 originalPaymentHash 的签字，创建 request_cancel 记账 */
    router.post('/cancelRequest', (req, res) => {
        const { originalPaymentHash, payeeSignature } = req.body;
        if (!originalPaymentHash || !payeeSignature) {
            return res.status(400).json({ success: false, error: 'Missing originalPaymentHash or payeeSignature' }).end();
        }
        if (!ethers_1.ethers.isHexString(originalPaymentHash) || ethers_1.ethers.dataLength(originalPaymentHash) !== 32) {
            return res.status(400).json({ success: false, error: 'originalPaymentHash must be bytes32' }).end();
        }
        if (typeof payeeSignature !== 'string' || !/^0x[a-fA-F0-9]+$/.test(payeeSignature) || (payeeSignature.length - 2) / 2 !== 65) {
            return res.status(400).json({ success: false, error: 'payeeSignature must be 65-byte hex' }).end();
        }
        MemberCard_1.cancelRequestAccountingPool.push({ originalPaymentHash: String(originalPaymentHash), payeeSignature: String(payeeSignature), res });
        (0, logger_1.logger)(safe_1.default.cyan(`[cancelRequest] pushed to pool originalPaymentHash=${originalPaymentHash.slice(0, 10)}…`));
        (0, MemberCard_1.cancelRequestAccountingProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[cancelRequestAccountingProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** cardCreateRedeem：由 cluster 预检后转发，master 推入 executeForOwnerPool，统一经 Settle_ContractPool 排队处理 */
    router.post('/cardCreateRedeem', (req, res) => {
        const preChecked = req.body;
        const { cardAddress, data, deadline, nonce, ownerSignature } = preChecked;
        if (!cardAddress || !data || deadline == null || !nonce || !ownerSignature) {
            return res.status(400).json({ success: false, error: 'Missing required fields: cardAddress, data, deadline, nonce, ownerSignature' });
        }
        if ((0, MemberCard_1.couponWorkflowDebugEnabled)()) {
            const d = typeof data === 'string' ? data : '';
            const sel = d.length >= 10 ? d.slice(0, 10) : '';
            try {
                const iface = new ethers_1.ethers.Interface([
                    'function createRedeemBatch(bytes32[] hashes, uint256 points6, uint256 attr, uint64 validAfter, uint64 validBefore, uint256[] tokenIds, uint256[] amounts)',
                ]);
                const dec = iface.parseTransaction({ data: d });
                const hashes = dec?.args?.[0];
                const hc = Array.isArray(hashes) ? hashes.length : 0;
                const tid = dec?.args?.[5];
                const amt = dec?.args?.[6];
                (0, logger_1.logger)(safe_1.default.magenta(`[couponWorkflow][Master] cardCreateRedeem enqueue card=${cardAddress} selector=${sel} hashesInCalldata=${hc} tokenIds=[${(tid ?? []).map(String).join(',')}] amounts=[${(amt ?? []).map(String).join(',')}]`));
            }
            catch {
                (0, logger_1.logger)(safe_1.default.magenta(`[couponWorkflow][Master] cardCreateRedeem enqueue card=${cardAddress} selector=${sel} (calldata decode skipped)`));
            }
        }
        MemberCard_1.executeForOwnerPool.push({ cardAddress, data, deadline, nonce, ownerSignature, res });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardCreateRedeem] pushed to executeForOwnerPool, card=${cardAddress}`));
        (0, MemberCard_1.executeForOwnerProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red(`[executeForOwnerProcess] unhandled error:`), err?.message ?? err);
        });
    });
    /** ReferralRegistryVaultV1: Cluster has verified the signed authorization; Master only queues the relay. */
    router.post('/referralRegistryRedeem', (req, res) => {
        const body = req.body;
        const requiresRedeemHash = body.action !== 'setMerchantAirdrop';
        if (!body.action || !body.contract || !body.account || (requiresRedeemHash && !body.redeemHash) || (body.action === 'setMerchantAirdrop' && !body.amount) || !body.nonce || !body.deadline || !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing referral redeem relay fields' }).end();
        }
        if (body.action === 'issueAdminMerchantPackage' && !body.bunitAmount) {
            return res.status(400).json({ success: false, error: 'Missing admin merchant package fields' }).end();
        }
        MemberCard_2.referralRegistryRedeemPool.push({
            action: body.action,
            contract: body.contract,
            account: body.account,
            redeemHash: body.redeemHash ?? '',
            rebateBps: body.rebateBps ?? '0',
            amount: body.amount,
            optionalL0: body.optionalL0,
            bunitAmount: body.bunitAmount,
            isPaid: body.isPaid,
            includeStartKet: body.includeStartKet,
            paymentMethod: body.paymentMethod,
            description: body.description,
            nonce: body.nonce,
            deadline: body.deadline,
            signature: body.signature,
            secret: body.secret,
            res,
        });
        (0, MemberCard_2.kickReferralRegistryRedeemRelay)();
    });
    router.post('/referralRegistryAdminManagement', (req, res) => {
        const body = req.body;
        if (!body.action ||
            !body.contract ||
            !body.admin ||
            !body.l0 ||
            !body.nonce ||
            !body.deadline ||
            !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing Referral Admin management fields' }).end();
        }
        if ((body.action === 'setL0StarterQuota' || body.action === 'setL0Quota') &&
            (body.starterKetRemaining === undefined || body.starterKetRemaining === '')) {
            return res.status(400).json({ success: false, error: 'Missing starterKetRemaining' }).end();
        }
        if (body.action === 'setL0Quota' && (body.paidBunitRemaining === undefined || body.paidBunitRemaining === '')) {
            return res.status(400).json({ success: false, error: 'Missing paidBunitRemaining' }).end();
        }
        MemberCard_3.referralRegistryAdminManagementPool.push({
            action: body.action,
            contract: body.contract,
            admin: body.admin,
            l0: body.l0,
            merchant: body.merchant,
            card: body.card,
            rebateBps: body.rebateBps,
            starterKetRemaining: body.starterKetRemaining,
            paidBunitRemaining: body.paidBunitRemaining,
            nonce: body.nonce,
            deadline: body.deadline,
            signature: body.signature,
            res,
        });
        (0, MemberCard_3.kickReferralRegistryAdminManagementRelay)();
    });
    router.post('/referralPurchaseSplit', (req, res) => {
        const body = req.body;
        if (!body.contract ||
            !body.admin ||
            !body.adminPayout ||
            body.adminBps === undefined ||
            body.adminBps === '' ||
            !Array.isArray(body.wallets) ||
            !Array.isArray(body.bps) ||
            !body.nonce ||
            !body.deadline ||
            !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing purchase split fields' }).end();
        }
        MemberCard_3.referralPurchaseSplitPool.push({
            contract: body.contract,
            admin: body.admin,
            adminPayout: body.adminPayout,
            adminBps: body.adminBps,
            wallets: body.wallets,
            bps: body.bps,
            nonce: body.nonce,
            deadline: body.deadline,
            signature: body.signature,
            res,
        });
        (0, MemberCard_3.kickReferralPurchaseSplitRelay)();
    });
    router.post('/referralRegistryMerchantShare', (req, res) => {
        const body = req.body;
        if (!body.contract ||
            !body.l0 ||
            !body.merchant ||
            !body.l1 ||
            body.shareBps === undefined ||
            body.shareBps === '' ||
            !body.nonce ||
            !body.deadline ||
            !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing merchant L1 share fields' }).end();
        }
        MemberCard_3.referralRegistryMerchantSharePool.push({
            contract: body.contract,
            l0: body.l0,
            merchant: body.merchant,
            l1: body.l1,
            shareBps: body.shareBps,
            nonce: body.nonce,
            deadline: body.deadline,
            signature: body.signature,
            res,
        });
        (0, MemberCard_3.kickReferralRegistryMerchantShareRelay)();
    });
    router.post('/referralRegistryClaim', async (req, res) => {
        const body = req.body;
        MemberCard_2.referralRegistryRedeemPool.push({
            action: body.action,
            contract: body.contract,
            account: body.account,
            redeemHash: body.redeemHash,
            rebateBps: '0',
            nonce: body.nonce,
            deadline: body.deadline,
            signature: body.signature,
            secret: body.secret,
            linkedValidatorRedeemable: Boolean(body.linkedValidatorRedeemable),
            linkedValidatorClaim: body.linkedValidatorClaim,
            res,
        });
        (0, MemberCard_2.kickReferralRegistryRedeemRelay)();
    });
    /** cardOpenTransfer：Cluster 已预检；Master 入队 redeemOpenTransfer */
    router.post('/cardOpenTransfer', (req, res) => {
        const body = req.body;
        MemberCard_1.cardOpenTransferPool.push({
            cardAddress: body.cardAddress,
            fromEOA: body.fromEOA,
            to: body.to,
            id: body.id,
            amount: body.amount,
            maxAmount: body.maxAmount,
            validAfter: body.validAfter,
            validBefore: body.validBefore,
            nonce: body.nonce,
            signature: body.signature,
            res,
        });
        (0, MemberCard_1.kickCardOpenTransferPoolPress)();
    });
    /** cardRedeem：Cluster 已 cardRedeemPreCheck；Master 只入队 + Settle_ContractPool 并行上链，不再预检。 */
    router.post('/cardRedeem', (req, res) => {
        const { cardAddress, redeemCode, toUserEOA, posOperator } = req.body;
        MemberCard_1.cardRedeemPool.push({
            cardAddress: cardAddress,
            redeemCode: redeemCode,
            toUserEOA: toUserEOA,
            res,
            ...(posOperator && ethers_1.ethers.isAddress(posOperator) ? { posOperator: ethers_1.ethers.getAddress(posOperator) } : {}),
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardRedeem] pushed to pool, queue=${MemberCard_1.cardRedeemPool.length} card=${cardAddress} to=${toUserEOA}`));
        (0, MemberCard_1.kickCardRedeemPoolPress)();
    });
    /** cardCouponOpenClaim：无 redeemcode 的 coupon open-claim，服务端调用 claimIssuedNftWithUserSig。
     * 产品例外：Cluster 预检已通过后，入队即返回 `{ success, queued }`，链上 claim 后台执行（勿等 tx.wait）。
     */
    router.post('/cardCouponOpenClaim', (req, res) => {
        const { cardAddress, couponId, userEOA, tokenId, deadline, nonce, userSignature, pointsCost, usdcReward6, isSocialExchange, refWallet, posOperator } = req.body;
        if (!cardAddress || !couponId || !userEOA || !tokenId || deadline == null || !nonce || !userSignature) {
            return res.status(400).json({ success: false, error: 'Missing required fields for cardCouponOpenClaim' }).end();
        }
        MemberCard_1.cardCouponOpenClaimPool.push({
            cardAddress,
            couponId,
            userEOA,
            tokenId,
            deadline: Number(deadline),
            nonce,
            userSignature,
            ...(isSocialExchange ? { isSocialExchange: true } : {}),
            ...(pointsCost != null ? { pointsCost: String(pointsCost) } : {}),
            ...(usdcReward6 != null ? { usdcReward6: String(usdcReward6) } : {}),
            ...(refWallet && ethers_1.ethers.isAddress(String(refWallet)) ? { refWallet: ethers_1.ethers.getAddress(String(refWallet)) } : {}),
            ...(posOperator && ethers_1.ethers.isAddress(String(posOperator))
                ? { posOperator: ethers_1.ethers.getAddress(String(posOperator)) }
                : {}),
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardCouponOpenClaim] queued, card=${cardAddress} couponId=${couponId} tokenId=${tokenId}`));
        res.status(200).json({
            success: true,
            queued: true,
            cardAddress,
            couponId,
            tokenId,
        }).end();
        (0, MemberCard_1.cardCouponOpenClaimProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[cardCouponOpenClaimProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** cardCouponPosClaimWallet：POS Balance / QR 代领（终端 admin，无 NFC 私钥）。 */
    router.post('/cardCouponPosClaimWallet', (req, res) => {
        const { cardAddress, couponId, userEOA, tokenId, posAdminEOA } = req.body;
        if (!cardAddress || !couponId || !userEOA || !tokenId || !posAdminEOA) {
            return res.status(400).json({ success: false, error: 'Missing required fields for cardCouponPosClaimWallet' }).end();
        }
        MemberCard_1.cardCouponPosClaimWalletPool.push({
            cardAddress,
            couponId,
            userEOA,
            tokenId,
            posAdminEOA,
            res,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardCouponPosClaimWallet] pushed to pool, card=${cardAddress} couponId=${couponId} tokenId=${tokenId} posAdmin=${posAdminEOA}`));
        (0, MemberCard_1.cardCouponPosClaimWalletProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[cardCouponPosClaimWalletProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** redeemSeries：与 cardRedeem 同一 pool / worker（Cluster 已预检） */
    router.post('/redeemSeries', (req, res) => {
        const { cardAddress, redeemCode, toUserEOA } = req.body;
        MemberCard_1.cardRedeemPool.push({
            cardAddress: cardAddress,
            redeemCode: redeemCode,
            toUserEOA: toUserEOA,
            res,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[redeemSeries] pushed to pool, queue=${MemberCard_1.cardRedeemPool.length} card=${cardAddress} to=${toUserEOA}`));
        (0, MemberCard_1.kickCardRedeemPoolPress)();
    });
    /** cardRedeemAdmin：用户兑换 redeem-admin 码，添加 to 为 admin，服务端 redeemAdminForUser */
    router.post('/cardRedeemAdmin', (req, res) => {
        const { cardAddress, redeemCode, to } = req.body;
        if (!cardAddress || !redeemCode || !to || !ethers_1.ethers.isAddress(cardAddress) || !ethers_1.ethers.isAddress(to)) {
            return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, redeemCode, to' });
        }
        MemberCard_1.cardRedeemAdminPool.push({ cardAddress, redeemCode, to, res });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardRedeemAdmin] pushed to pool, card=${cardAddress} to=${to}`));
        (0, MemberCard_1.cardRedeemAdminProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[cardRedeemAdminProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** cardClearAdminMintCounter：parent admin 签字清零 subordinate 的 mint 计数。Cluster 已预检，Master 调用 Factory（Card）+ Indexer */
    router.post('/cardClearAdminMintCounter', async (req, res) => {
        const { cardAddress, subordinate, deadline, nonce, adminSignature, ownerSignature } = req.body;
        if (!cardAddress || !subordinate || !ethers_1.ethers.isAddress(cardAddress) || !ethers_1.ethers.isAddress(subordinate)) {
            return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, subordinate' }).end();
        }
        if (deadline == null || !nonce) {
            return res.status(400).json({ success: false, error: 'Missing: deadline, nonce' }).end();
        }
        if (!adminSignature?.trim() && !ownerSignature?.trim()) {
            return res.status(400).json({ success: false, error: 'Missing: adminSignature or ownerSignature' }).end();
        }
        const result = await (0, MemberCard_1.cardClearAdminMintCounterProcess)({ cardAddress, subordinate, deadline, nonce, adminSignature, ownerSignature });
        if (!result.success) {
            return res.status(400).json(result).end();
        }
        return res.status(200).json({ success: true, tx: result.tx }).end();
    });
    /** cardTerminalSettlementClear：parent admin 签 TerminalSettlementClear；仅 indexer TX_Terminal_RESET，不清 Base mint。Cluster 已预检。 */
    router.post('/cardTerminalSettlementClear', async (req, res) => {
        const { cardAddress, subordinate, deadline, nonce, adminSignature, ownerSignature } = req.body;
        if (!cardAddress || !subordinate || !ethers_1.ethers.isAddress(cardAddress) || !ethers_1.ethers.isAddress(subordinate)) {
            return res.status(400).json({ success: false, error: 'Missing or invalid: cardAddress, subordinate' }).end();
        }
        if (deadline == null || !nonce) {
            return res.status(400).json({ success: false, error: 'Missing: deadline, nonce' }).end();
        }
        if (!adminSignature?.trim() && !ownerSignature?.trim()) {
            return res.status(400).json({ success: false, error: 'Missing: adminSignature or ownerSignature' }).end();
        }
        const result = await (0, MemberCard_1.cardTerminalSettlementClearProcess)({ cardAddress, subordinate, deadline, nonce, adminSignature, ownerSignature });
        if (!result.success) {
            return res.status(400).json(result).end();
        }
        return res.status(200).json({ success: true, syncTx: result.syncTx }).end();
    });
    /** POST /api/cardGatewayRewardPool — Cluster 预检后转发；factory.gatewayInvokeCard 或 Plan A cardCallData 直调。
     * recordUserLike / burnUserLike：入队即返回 `{ success, queued }`（对齐 cardCouponOpenClaim），勿等 EntryPoint 确认。
     */
    router.post('/cardGatewayRewardPool', async (req, res) => {
        const { cardAddress, factoryCallData, cardCallData, extraCardCallData, label, initOnly, socialDb } = req.body;
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
            return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' }).end();
        }
        const hasFactory = typeof factoryCallData === 'string' && factoryCallData.length >= 10;
        const hasCard = typeof cardCallData === 'string' && cardCallData.length >= 10;
        if (!initOnly && !hasFactory && !hasCard) {
            return res
                .status(400)
                .json({ success: false, error: 'Missing or invalid factoryCallData / cardCallData' })
                .end();
        }
        const taskLabel = typeof label === 'string' && label.trim() ? label.trim() : 'cardGatewayRewardPool';
        /** Coupons / Discover 点赞：预检合格入队后立即成功，改善 UI 等待。 */
        const respondOnEnqueue = taskLabel === 'recordUserLike' || taskLabel === 'burnUserLike';
        const extraSteps = Array.isArray(extraCardCallData)
            ? extraCardCallData.filter((d) => typeof d === 'string' && d.length >= 10)
            : undefined;
        (0, userCumulativeStatRewardPoolMaster_1.pushCardGatewayRewardPoolTask)({
            cardAddress: ethers_1.ethers.getAddress(cardAddress),
            ...(hasFactory ? { factoryCallData } : {}),
            ...(hasCard ? { cardCallData } : {}),
            ...(extraSteps && extraSteps.length > 0 ? { extraCardCallData: extraSteps } : {}),
            ...(initOnly ? { initOnly: true } : {}),
            ...(socialDb ? { socialDb } : {}),
            label: taskLabel,
            ...(respondOnEnqueue ? {} : { res }),
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardGatewayRewardPool] pushed to pool label=${taskLabel} card=${cardAddress}`));
        if (respondOnEnqueue) {
            return res
                .status(200)
                .json({
                success: true,
                queued: true,
                cardAddress: ethers_1.ethers.getAddress(cardAddress),
                label: taskLabel,
            })
                .end();
        }
    });
    /** POST /api/cardGatewayInitializeUserCumulativeStat — Cluster 预检后仅初始化 cumulative stat tokens（无 owner 签名）。 */
    router.post('/cardGatewayInitializeUserCumulativeStat', async (req, res) => {
        const { cardAddress, initOnly, label } = req.body;
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
            return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' }).end();
        }
        const taskLabel = typeof label === 'string' && label.trim() ? label.trim() : 'initializeCardUserCumulativeStat';
        (0, userCumulativeStatRewardPoolMaster_1.pushCardGatewayRewardPoolTask)({
            cardAddress: ethers_1.ethers.getAddress(cardAddress),
            initOnly: initOnly !== false,
            label: taskLabel,
            res,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardGatewayInitializeUserCumulativeStat] pushed initOnly card=${cardAddress} label=${taskLabel}`));
    });
    router.post('/executeForOwner', async (req, res) => {
        const { cardAddress, data, deadline, nonce, ownerSignature, redeemCode, toUserEOA, targetAddress, description, image, background_color, metadata_extra_properties, } = req.body;
        if (!cardAddress || !data || deadline == null || !nonce || !ownerSignature) {
            return res.status(400).json({ success: false, error: 'Missing required fields: cardAddress, data, deadline, nonce, ownerSignature' });
        }
        if (targetAddress && ethers_1.ethers.isAddress(targetAddress)) {
            try {
                await (0, MemberCard_1.ensureAAForMintTarget)(targetAddress);
            }
            catch (e) {
                (0, logger_1.logger)(safe_1.default.red(`[executeForOwner] ensureAAForMintTarget failed: ${e?.message ?? e}`));
                return res.status(500).json({ success: false, error: e?.message ?? 'Failed to create AA for recipient' });
            }
        }
        if ((0, MemberCard_1.couponWorkflowDebugEnabled)()) {
            const d = typeof data === 'string' ? data : '';
            const sel = d.length >= 10 ? d.slice(0, 10) : '';
            const byteLen = d.startsWith('0x') ? (d.length - 2) / 2 : 0;
            let mexKeys = 'none';
            const mex = metadata_extra_properties;
            if (typeof mex === 'string' && mex.trim()) {
                try {
                    mexKeys = Object.keys(JSON.parse(mex.trim())).join(',');
                }
                catch {
                    mexKeys = '<json parse fail>';
                }
            }
            else if (mex != null && typeof mex === 'object' && !Array.isArray(mex)) {
                mexKeys = Object.keys(mex).join(',');
            }
            (0, logger_1.logger)(safe_1.default.magenta(`[couponWorkflow][Master] executeForOwner enqueue card=${cardAddress} selector=${sel} calldataByteLen=${byteLen} deadline=${deadline} metadataExtraKeys=${mexKeys} descLen=${typeof description === 'string' ? description.length : 0} hasImage=${!!(typeof image === 'string' && image.trim())} hasMintTarget=${!!targetAddress} hasAuxRedeemPair=${redeemCode != null && toUserEOA != null}`));
        }
        MemberCard_1.executeForOwnerPool.push({
            cardAddress,
            data,
            deadline,
            nonce,
            ownerSignature,
            redeemCode,
            toUserEOA,
            res,
            description,
            image,
            background_color,
            metadata_extra_properties,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[executeForOwner] pushed to pool, card=${cardAddress}`));
        (0, MemberCard_1.executeForOwnerProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[executeForOwnerProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** cardUpdateTiers：Cluster 已校验 owner signature + setTiers calldata；Master 执行链上 setTiers，确认后同步 metadata。 */
    router.post('/cardUpdateTiers', async (req, res) => {
        const body = req.body;
        MemberCard_1.executeForOwnerPool.push({
            cardAddress: body.cardAddress,
            data: body.data,
            deadline: body.deadline,
            nonce: body.nonce,
            ownerSignature: body.ownerSignature,
            res,
            metadataUpdate: {
                shareTokenMetadata: body.shareTokenMetadata,
                ...(body.tiers != null && { tiers: body.tiers }),
                ...(body.baseMembership !== undefined && { baseMembership: body.baseMembership }),
                ...(body.upgradeType != null && { upgradeType: body.upgradeType }),
                ...(typeof body.transferWhitelistEnabled === 'boolean' && {
                    transferWhitelistEnabled: body.transferWhitelistEnabled,
                }),
            },
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[cardUpdateTiers] pushed to executeForOwnerPool, card=${body.cardAddress}`));
        (0, MemberCard_1.executeForOwnerProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[executeForOwnerProcess] cardUpdateTiers unhandled error:'), err?.message ?? err);
        });
    });
    /** AA→EOA：支持三种提交。(1) ERC-4337 UserOp → AAtoEOAProcess；(2) openContainerPayload → OpenContainerRelayProcess；(3) containerPayload（绑定 to）→ ContainerRelayProcess。requestHash 预检已由 Cluster 完成 */
    router.post('/AAtoEOA', (req, res) => {
        const body = req.body;
        (0, logger_1.logger)(`[AAtoEOA] [DEBUG] Master received openContainer=${!!body?.openContainerPayload} requestHash=${body?.requestHash ?? 'n/a'} forText=${body?.forText ? `"${String(body.forText).slice(0, 40)}…"` : 'n/a'} OpenContainerRelayPool.len=${MemberCard_1.OpenContainerRelayPool.length} ${(0, MemberCard_1.settlePoolIdleSummary)()}`);
        (0, logger_1.logger)(`[AAtoEOA] master received POST /api/AAtoEOA`, (0, node_util_1.inspect)({ toEOA: body?.toEOA, amountUSDC6: body?.amountUSDC6, sender: body?.packedUserOp?.sender, openContainer: !!body?.openContainerPayload, container: !!body?.containerPayload, requestHash: body?.requestHash ?? 'n/a', forText: body?.forText ? `${body.forText.slice(0, 40)}…` : 'n/a' }, false, 3, true));
        if (body.containerPayload) {
            const preCheck = (0, MemberCard_1.ContainerRelayPreCheck)(body.containerPayload);
            if (!preCheck.success) {
                (0, logger_1.logger)(safe_1.default.red(`[AAtoEOA] master Container validation FAIL: ${preCheck.error}`));
                return res.status(400).json({ success: false, error: preCheck.error ?? 'Invalid containerPayload' }).end();
            }
            const origUsdcTxNorm = typeof body.originatingUSDCTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.originatingUSDCTx.trim())
                ? body.originatingUSDCTx.trim().toLowerCase()
                : undefined;
            const sidNorm = typeof body.chargeSessionId === 'string' && body.chargeSessionId.trim().length > 0
                ? body.chargeSessionId.trim().toLowerCase()
                : undefined;
            const posOpNorm = typeof body.posOperator === 'string' && ethers_1.ethers.isAddress(body.posOperator.trim())
                ? ethers_1.ethers.getAddress(body.posOperator.trim())
                : undefined;
            const poolLenBefore = MemberCard_1.ContainerRelayPool.length;
            MemberCard_1.ContainerRelayPool.push({
                containerPayload: body.containerPayload,
                currency: body.currency,
                currencyAmount: body.currencyAmount,
                currencyDiscount: body.currencyDiscount,
                currencyDiscountAmount: body.currencyDiscountAmount,
                forText: body.forText?.trim() || undefined,
                requestHash: body.requestHash && ethers_1.ethers.isHexString(body.requestHash) && ethers_1.ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined,
                merchantCardAddress: body.merchantCardAddress && ethers_1.ethers.isAddress(body.merchantCardAddress) ? body.merchantCardAddress : undefined,
                nfcSubtotalCurrencyAmount: body.nfcSubtotalCurrencyAmount != null && String(body.nfcSubtotalCurrencyAmount).trim() !== ''
                    ? String(body.nfcSubtotalCurrencyAmount).trim()
                    : undefined,
                nfcTipCurrencyAmount: body.nfcTipCurrencyAmount != null && String(body.nfcTipCurrencyAmount).trim() !== ''
                    ? String(body.nfcTipCurrencyAmount).trim()
                    : undefined,
                nfcTipRateBps: body.nfcTipRateBps != null && Number.isFinite(Number(body.nfcTipRateBps))
                    ? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTipRateBps))))
                    : undefined,
                nfcRequestCurrency: body.nfcRequestCurrency != null && String(body.nfcRequestCurrency).trim() !== ''
                    ? String(body.nfcRequestCurrency).trim()
                    : undefined,
                nfcDiscountAmountFiat6: body.nfcDiscountAmountFiat6 != null && String(body.nfcDiscountAmountFiat6).trim() !== ''
                    ? String(body.nfcDiscountAmountFiat6).trim()
                    : undefined,
                nfcDiscountRateBps: body.nfcDiscountRateBps != null && Number.isFinite(Number(body.nfcDiscountRateBps))
                    ? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcDiscountRateBps))))
                    : undefined,
                nfcTaxAmountFiat6: body.nfcTaxAmountFiat6 != null && String(body.nfcTaxAmountFiat6).trim() !== ''
                    ? String(body.nfcTaxAmountFiat6).trim()
                    : undefined,
                nfcTaxRateBps: body.nfcTaxRateBps != null && Number.isFinite(Number(body.nfcTaxRateBps))
                    ? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTaxRateBps))))
                    : undefined,
                chargeOwnerChildBurn: body.chargeOwnerChildBurn,
                originatingUSDCTx: origUsdcTxNorm,
                chargeSessionId: sidNorm,
                posOperator: posOpNorm,
                ...(typeof body.chargeLedgerMainUsdc6 === 'string' && body.chargeLedgerMainUsdc6.trim() !== ''
                    ? { chargeLedgerMainUsdc6: body.chargeLedgerMainUsdc6.trim() }
                    : {}),
                res,
            });
            if (sidNorm || origUsdcTxNorm) {
                (0, logger_1.logger)(safe_1.default.cyan(`[AAtoEOA/Container] orchestrator-tagged container: sid=${sidNorm ?? 'n/a'} originatingUSDCTx=${origUsdcTxNorm ?? 'n/a'} pos=${posOpNorm ? posOpNorm.slice(0, 10) + '…' : 'n/a'}`));
            }
            (0, logger_1.logger)(`[AAtoEOA] master pushed to ContainerRelayPool (length ${poolLenBefore} -> ${MemberCard_1.ContainerRelayPool.length}), calling ContainerRelayProcess()`);
            (0, MemberCard_1.ContainerRelayProcess)().catch((err) => {
                (0, logger_1.logger)(safe_1.default.red('[ContainerRelayProcess] unhandled error:'), err?.message ?? err);
            });
            return;
        }
        if (body.openContainerPayload) {
            (0, logger_1.logger)(safe_1.default.cyan(`[AAtoEOA] [DEBUG] Master openContainerPayload JSON: ${JSON.stringify(body.openContainerPayload)}`));
            const preCheck = (0, MemberCard_1.OpenContainerRelayPreCheck)(body.openContainerPayload);
            if (!preCheck.success) {
                (0, logger_1.logger)(safe_1.default.red(`[AAtoEOA] master OpenContainer validation FAIL: ${preCheck.error}`));
                return res.status(400).json({ success: false, error: preCheck.error ?? 'Invalid openContainerPayload' }).end();
            }
            const poolLenBefore = MemberCard_1.OpenContainerRelayPool.length;
            const posOpOpenNorm = typeof body.posOperator === 'string' && ethers_1.ethers.isAddress(body.posOperator.trim())
                ? ethers_1.ethers.getAddress(body.posOperator.trim())
                : undefined;
            MemberCard_1.OpenContainerRelayPool.push({
                openContainerPayload: body.openContainerPayload,
                currency: body.currency,
                currencyAmount: body.currencyAmount,
                currencyDiscount: body.currencyDiscount,
                currencyDiscountAmount: body.currencyDiscountAmount,
                forText: body.forText?.trim() || undefined,
                requestHash: body.requestHash && ethers_1.ethers.isHexString(body.requestHash) && ethers_1.ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined,
                merchantCardAddress: body.merchantCardAddress && ethers_1.ethers.isAddress(body.merchantCardAddress) ? body.merchantCardAddress : undefined,
                nfcSubtotalCurrencyAmount: body.nfcSubtotalCurrencyAmount != null && String(body.nfcSubtotalCurrencyAmount).trim() !== ''
                    ? String(body.nfcSubtotalCurrencyAmount).trim()
                    : undefined,
                nfcTipCurrencyAmount: body.nfcTipCurrencyAmount != null && String(body.nfcTipCurrencyAmount).trim() !== ''
                    ? String(body.nfcTipCurrencyAmount).trim()
                    : undefined,
                nfcTipRateBps: body.nfcTipRateBps != null && Number.isFinite(Number(body.nfcTipRateBps))
                    ? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTipRateBps))))
                    : undefined,
                nfcRequestCurrency: body.nfcRequestCurrency != null && String(body.nfcRequestCurrency).trim() !== ''
                    ? String(body.nfcRequestCurrency).trim()
                    : undefined,
                nfcDiscountAmountFiat6: body.nfcDiscountAmountFiat6 != null && String(body.nfcDiscountAmountFiat6).trim() !== ''
                    ? String(body.nfcDiscountAmountFiat6).trim()
                    : undefined,
                nfcDiscountRateBps: body.nfcDiscountRateBps != null && Number.isFinite(Number(body.nfcDiscountRateBps))
                    ? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcDiscountRateBps))))
                    : undefined,
                nfcTaxAmountFiat6: body.nfcTaxAmountFiat6 != null && String(body.nfcTaxAmountFiat6).trim() !== ''
                    ? String(body.nfcTaxAmountFiat6).trim()
                    : undefined,
                nfcTaxRateBps: body.nfcTaxRateBps != null && Number.isFinite(Number(body.nfcTaxRateBps))
                    ? Math.max(0, Math.min(10000, Math.trunc(Number(body.nfcTaxRateBps))))
                    : undefined,
                chargeOwnerChildBurn: body.chargeOwnerChildBurn,
                posOperator: posOpOpenNorm,
                ...(typeof body.chargeLedgerMainUsdc6 === 'string' && body.chargeLedgerMainUsdc6.trim() !== ''
                    ? { chargeLedgerMainUsdc6: body.chargeLedgerMainUsdc6.trim() }
                    : {}),
                ...(body.couponOpenContainerSurrender === true ? { couponOpenContainerSurrender: true } : {}),
                ...(typeof body.couponBurnUserEOA === 'string' && ethers_1.ethers.isAddress(body.couponBurnUserEOA.trim())
                    ? { couponBurnUserEOA: ethers_1.ethers.getAddress(body.couponBurnUserEOA.trim()) }
                    : {}),
                ...(typeof body.couponBurnRefWallet === 'string' && ethers_1.ethers.isAddress(body.couponBurnRefWallet.trim())
                    ? { couponBurnRefWallet: ethers_1.ethers.getAddress(body.couponBurnRefWallet.trim()) }
                    : {}),
                res,
            });
            (0, logger_1.logger)(`[AAtoEOA] master pushed to OpenContainerRelayPool (length ${poolLenBefore} -> ${MemberCard_1.OpenContainerRelayPool.length}), calling OpenContainerRelayProcess()`);
            (0, MemberCard_1.OpenContainerRelayProcess)().catch((err) => {
                (0, logger_1.logger)(safe_1.default.red('[OpenContainerRelayProcess] unhandled error:'), err?.message ?? err);
            });
            return;
        }
        const { toEOA, amountUSDC6, packedUserOp, relayChain, transferAsset } = body;
        if (!ethers_1.ethers.isAddress(toEOA) || !amountUSDC6 || !packedUserOp?.sender || !packedUserOp?.callData || packedUserOp?.signature === undefined) {
            (0, logger_1.logger)(safe_1.default.red(`[AAtoEOA] master validation FAIL: need toEOA, amountUSDC6, packedUserOp OR containerPayload OR openContainerPayload`));
            return res.status(400).json({ success: false, error: 'Invalid data: need toEOA, amountUSDC6, packedUserOp OR containerPayload OR openContainerPayload' }).end();
        }
        const relayResolved = (0, aaTransferRelayChain_1.resolveAaUserOpRelayChainFromRequest)({ transferAsset, relayChain });
        if (!relayResolved.ok) {
            (0, logger_1.logger)(safe_1.default.red(`[AAtoEOA] master relay chain FAIL: ${relayResolved.error}`));
            return res.status(400).json({ success: false, error: relayResolved.error }).end();
        }
        const reqHashValid = body.requestHash && ethers_1.ethers.isHexString(body.requestHash) && ethers_1.ethers.dataLength(body.requestHash) === 32 ? body.requestHash : undefined;
        const poolLenBefore = MemberCard_1.AAtoEOAPool.length;
        MemberCard_1.AAtoEOAPool.push({
            toEOA: toEOA,
            amountUSDC6,
            packedUserOp: packedUserOp,
            relayChain: relayResolved.chain,
            ...(relayResolved.transferAsset ? { transferAsset: relayResolved.transferAsset } : {}),
            requestHash: reqHashValid,
            res,
        });
        (0, logger_1.logger)(`[AAtoEOA] master pushed to pool (length ${poolLenBefore} -> ${MemberCard_1.AAtoEOAPool.length}), calling AAtoEOAProcess()`);
        (0, MemberCard_1.AAtoEOAProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[AAtoEOAProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/claimBUnits - 由 cluster 预检后转发，master 推入 claimBUnitsPool，经 Settle_ContractPool 执行 BUnitAirdrop.claimFor */
    router.post('/claimBUnits', (req, res) => {
        const body = req.body;
        if (!body.claimant || !body.nonce || !body.deadline || !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing claimant, nonce, deadline, or signature' }).end();
        }
        MemberCard_1.claimBUnitsPool.push({
            claimant: body.claimant,
            nonce: body.nonce,
            deadline: body.deadline,
            signature: body.signature,
            mintBeneficiary: body.mintBeneficiary,
            merchantCard: body.merchantCard,
            targetTokenId: body.targetTokenId,
            referrer: body.referrer,
            res,
        });
        (0, MemberCard_1.claimBUnitsProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[claimBUnitsProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/relocateBUnitToSmartWallet - 已 claim 至 EOA 的免费池 B-Unit 迁至 Beamio AA */
    router.post('/relocateBUnitToSmartWallet', (req, res) => {
        const body = req.body;
        if (!body.eoaOwner || !body.aaAccount) {
            return res.status(400).json({ success: false, error: 'Missing eoaOwner or aaAccount' }).end();
        }
        MemberCard_1.relocateBUnitsToSmartWalletPool.push({
            eoaOwner: body.eoaOwner,
            aaAccount: body.aaAccount,
            res,
        });
        (0, MemberCard_1.relocateBUnitsToSmartWalletProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[relocateBUnitsToSmartWalletProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/buintRedeemAirdropRedeem - cluster 完整预检后转发；ensureAAForEOA(Base) 后 redeemWithCodeAsAdmin(CoNET → 用户 AA) */
    router.post('/buintRedeemAirdropRedeem', (req, res) => {
        const body = req.body;
        if (!body.eoa || !ethers_1.ethers.isAddress(body.eoa) || typeof body.code !== 'string' || !body.code.trim()) {
            return res.status(400).json({ success: false, error: 'Missing eoa or code' }).end();
        }
        MemberCard_1.buintRedeemAirdropPool.push({
            eoa: ethers_1.ethers.getAddress(body.eoa),
            code: body.code.trim(),
            res,
        });
        (0, MemberCard_1.buintRedeemAirdropProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[buintRedeemAirdropProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/businessStartKetRedeemRedeem — cluster 预检合格后转发；Settle 代付 gas 调 redeemWithCodeAsAdmin(recipient=用户 EOA) */
    router.post('/businessStartKetRedeemRedeem', (req, res) => {
        const body = req.body;
        if (!body.eoa || !ethers_1.ethers.isAddress(body.eoa) || typeof body.code !== 'string' || !body.code.trim()) {
            return res.status(400).json({ success: false, error: 'Missing eoa or code' }).end();
        }
        MemberCard_1.businessStartKetRedeemUserRedeemPool.push({
            eoa: ethers_1.ethers.getAddress(body.eoa),
            code: body.code.trim(),
            linkedValidatorRedeemable: Boolean(body.linkedValidatorRedeemable),
            linkedValidatorClaim: body.linkedValidatorClaim,
            res,
        });
        (0, MemberCard_1.businessStartKetRedeemUserRedeemProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[businessStartKetRedeemUserRedeemProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/businessStartKetRedeemAdminCreate — cluster 预检合格后转发；Settle 代付 gas 调 createRedeemFor */
    router.post('/businessStartKetRedeemAdminCreate', (req, res) => {
        const b = req.body;
        if (!b.contract ||
            !b.admin ||
            !b.codeHash ||
            b.tokenId == null ||
            b.ketAmount == null ||
            b.buintAmount == null ||
            b.validAfter == null ||
            b.validBefore == null ||
            b.nonce == null ||
            b.deadline == null ||
            !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing create fields' }).end();
        }
        MemberCard_1.businessStartKetRedeemCreatePool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            admin: ethers_1.ethers.getAddress(b.admin),
            codeHash: b.codeHash,
            tokenId: BigInt(b.tokenId),
            ketAmount: BigInt(b.ketAmount),
            buintAmount: BigInt(b.buintAmount),
            validAfter: BigInt(b.validAfter),
            validBefore: BigInt(b.validBefore),
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, MemberCard_1.businessStartKetRedeemCreateProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[businessStartKetRedeemCreateProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/businessStartKetRedeemAdminCancel — cluster 预检合格后转发；Settle 代付 gas 调 cancelRedeemFor */
    router.post('/businessStartKetRedeemAdminCancel', (req, res) => {
        const b = req.body;
        if (!b.contract || !b.admin || !b.codeHash || b.nonce == null || b.deadline == null || !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing cancel fields' }).end();
        }
        MemberCard_1.businessStartKetRedeemCancelPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            admin: ethers_1.ethers.getAddress(b.admin),
            codeHash: b.codeHash,
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, MemberCard_1.businessStartKetRedeemCancelProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[businessStartKetRedeemCancelProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/validatorDepositRedeemAdminCreate', (req, res) => {
        const b = req.body;
        if (!b.contract ||
            !b.admin ||
            !b.codeHash ||
            b.allowedClaimer == null ||
            b.referrer == null ||
            !b.validatorCount ||
            !b.targetNodeIp ||
            !b.gbMiningNodeCount ||
            b.validAfter == null ||
            b.validBefore == null ||
            b.nonce == null ||
            b.deadline == null ||
            !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing validator redeem create fields' }).end();
        }
        validatorDepositRedeem_1.validatorDepositRedeemCreatePool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            admin: ethers_1.ethers.getAddress(b.admin),
            codeHash: b.codeHash,
            allowedClaimer: ethers_1.ethers.getAddress(b.allowedClaimer),
            referrer: ethers_1.ethers.getAddress(b.referrer),
            validatorCount: BigInt(b.validatorCount),
            targetNodeIp: b.targetNodeIp,
            gbMiningNodeCount: BigInt(b.gbMiningNodeCount),
            airdrop: b.airdrop === true || b.airdrop === 'true' || b.airdrop === 1 || b.airdrop === '1',
            validAfter: BigInt(b.validAfter),
            validBefore: BigInt(b.validBefore),
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, validatorDepositRedeem_1.validatorDepositRedeemCreateProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemCreateProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** After Genesis Seat x402 settle: bindSale + LockMint, then createRedeemFor + claimRedeemFor. */
    router.post('/genesisNodeSeatFulfill', (req, res) => {
        const b = req.body;
        const beneficiary = String(b.beneficiary ?? '').trim();
        const usdcTx = String(b.USDC_tx ?? '').trim();
        const qtyRaw = String(b.qty ?? '').trim();
        if (!beneficiary || !ethers_1.ethers.isAddress(beneficiary)) {
            return res.status(400).json({ success: false, error: 'Invalid beneficiary' }).end();
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
            return res.status(400).json({ success: false, error: 'Invalid USDC_tx' }).end();
        }
        if (!/^\d+$/.test(qtyRaw) || BigInt(qtyRaw) <= 0n) {
            return res.status(400).json({ success: false, error: 'Invalid qty' }).end();
        }
        // Client may send referrer / referrerL1 / referrerL0 — Admin, L0, or L1; vault resolves role.
        const refRaw = String(b.referrer ?? b.referrerL1 ?? b.referrerL0 ?? '').trim();
        validatorDepositRedeem_1.genesisNodeSeatFulfillPool.push({
            beneficiary: ethers_1.ethers.getAddress(beneficiary),
            qty: BigInt(qtyRaw),
            payer: String(b.payer ?? '').trim(),
            USDC_tx: usdcTx,
            usdcAmount6: String(b.usdcAmount6 ?? ''),
            referrerL0: refRaw && ethers_1.ethers.isAddress(refRaw) ? ethers_1.ethers.getAddress(refRaw) : undefined,
            testMode: Boolean(b.testMode),
            res,
        });
        (0, validatorDepositRedeem_1.kickGenesisNodeSeatFulfillPoolPress)();
    });
    /** After wallet USDC x402 settle: LockMint CONET-USDC → beneficiary (EOA or AA). */
    router.post('/walletDepositFulfill', (req, res) => {
        const b = req.body;
        const beneficiary = String(b.beneficiary ?? '').trim();
        const usdcTx = String(b.USDC_tx ?? '').trim();
        const usdcAmount6 = String(b.usdcAmount6 ?? '').trim();
        if (!beneficiary || !ethers_1.ethers.isAddress(beneficiary)) {
            return res.status(400).json({ success: false, error: 'Invalid beneficiary' }).end();
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
            return res.status(400).json({ success: false, error: 'Invalid USDC_tx' }).end();
        }
        if (!/^\d+$/.test(usdcAmount6) || BigInt(usdcAmount6) <= 0n) {
            return res.status(400).json({ success: false, error: 'Invalid usdcAmount6' }).end();
        }
        validatorDepositRedeem_1.walletDepositFulfillPool.push({
            beneficiary: ethers_1.ethers.getAddress(beneficiary),
            payer: String(b.payer ?? '').trim(),
            USDC_tx: usdcTx,
            usdcAmount6,
            res,
        });
        (0, validatorDepositRedeem_1.kickWalletDepositFulfillPoolPress)();
    });
    /** After fuel pack x402 settle: mint B-Units (+ Genesis Ket) → merchant beneficiary. */
    router.post('/fuelPackFulfill', (req, res) => {
        const b = req.body;
        const beneficiary = String(b.beneficiary ?? '').trim();
        const usdcTx = String(b.USDC_tx ?? '').trim();
        const usdcAmount6 = String(b.usdcAmount6 ?? '').trim();
        if (!beneficiary || !ethers_1.ethers.isAddress(beneficiary)) {
            return res.status(400).json({ success: false, error: 'Invalid beneficiary' }).end();
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
            return res.status(400).json({ success: false, error: 'Invalid USDC_tx' }).end();
        }
        if (!/^\d+$/.test(usdcAmount6) || BigInt(usdcAmount6) <= 0n) {
            return res.status(400).json({ success: false, error: 'Invalid usdcAmount6' }).end();
        }
        fuelPackFulfill_1.fuelPackFulfillPool.push({
            beneficiary: ethers_1.ethers.getAddress(beneficiary),
            payer: String(b.payer ?? '').trim(),
            USDC_tx: usdcTx,
            usdcAmount6,
            packId: String(b.packId ?? '').trim(),
            mintKet: b.mintKet === true || String(b.mintKet ?? '').trim() === 'true',
            freeBUnits6: String(b.freeBUnits6 ?? '0').trim() || '0',
            res,
        });
        (0, fuelPackFulfill_1.kickFuelPackFulfillPoolPress)();
    });
    /** After Discover treasuryBridge settle: LockMint CONET-USDC → card.owner + protocol gateway mint. */
    router.post('/treasuryBridgeFulfill', (req, res) => {
        const b = req.body;
        const cardAddress = String(b.cardAddress ?? '').trim();
        const cardOwner = String(b.cardOwner ?? '').trim();
        const recipientEOA = String(b.recipientEOA ?? '').trim();
        const usdcTx = String(b.USDC_tx ?? '').trim();
        const usdcAmount6 = String(b.usdcAmount6 ?? '').trim();
        const points6 = String(b.points6 ?? '').trim();
        if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
            return res.status(400).json({ success: false, error: 'Invalid cardAddress' }).end();
        }
        if (!cardOwner || !ethers_1.ethers.isAddress(cardOwner)) {
            return res.status(400).json({ success: false, error: 'Invalid cardOwner' }).end();
        }
        if (!recipientEOA || !ethers_1.ethers.isAddress(recipientEOA)) {
            return res.status(400).json({ success: false, error: 'Invalid recipientEOA' }).end();
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
            return res.status(400).json({ success: false, error: 'Invalid USDC_tx' }).end();
        }
        if (!/^\d+$/.test(usdcAmount6) || BigInt(usdcAmount6) <= 0n) {
            return res.status(400).json({ success: false, error: 'Invalid usdcAmount6' }).end();
        }
        if (!/^\d+$/.test(points6) || BigInt(points6) <= 0n) {
            return res.status(400).json({ success: false, error: 'Invalid points6' }).end();
        }
        let membershipFeeStage;
        const rawStage = b.membershipFeeStage;
        if (rawStage && typeof rawStage === 'object') {
            const stageRecipient = String(rawStage.recipientEOA ?? '').trim();
            const tierIndex = Number(rawStage.tierIndex);
            const feePaid6 = String(rawStage.feePaid6 ?? '').trim();
            const pointsCredit6 = String(rawStage.pointsCredit6 ?? '').trim();
            if (ethers_1.ethers.isAddress(stageRecipient) &&
                Number.isInteger(tierIndex) &&
                tierIndex >= 0 &&
                /^\d+$/.test(feePaid6) &&
                /^\d+$/.test(pointsCredit6) &&
                BigInt(feePaid6) > 0n &&
                BigInt(pointsCredit6) > 0n) {
                membershipFeeStage = {
                    recipientEOA: ethers_1.ethers.getAddress(stageRecipient),
                    tierIndex,
                    feePaid6: BigInt(feePaid6),
                    pointsCredit6: BigInt(pointsCredit6),
                    ...(rawStage.bootstrapOnChain === true
                        ? {
                            bootstrapOnChain: true,
                            durationKind: Number(rawStage.durationKind ?? 0),
                        }
                        : {}),
                };
            }
        }
        treasuryBridgeFulfill_1.treasuryBridgeFulfillPool.push({
            cardAddress: ethers_1.ethers.getAddress(cardAddress),
            cardOwner: ethers_1.ethers.getAddress(cardOwner),
            recipientEOA: ethers_1.ethers.getAddress(recipientEOA),
            points6,
            payer: String(b.payer ?? '').trim(),
            USDC_tx: usdcTx,
            usdcAmount6,
            currency: b.currency,
            currencyAmount: b.currencyAmount,
            membershipFeeStage,
            res,
        });
        (0, treasuryBridgeFulfill_1.kickTreasuryBridgeFulfillPoolPress)();
    });
    router.post('/treasuryStableSwap', (req, res) => {
        const body = req.body;
        if (!body.user ||
            body.burnAssetKind == null ||
            body.creditAssetKind == null ||
            !body.amount ||
            !body.destinationChainId ||
            !body.recipient ||
            body.minCreditAmount == null ||
            body.nonce == null ||
            body.deadline == null ||
            !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing treasuryStableSwap fields' }).end();
        }
        treasuryStableSwapRelay_1.treasuryStableSwapPool.push({
            user: body.user,
            burnAssetKind: Number(body.burnAssetKind),
            amount: String(body.amount),
            destinationChainId: String(body.destinationChainId),
            recipient: body.recipient,
            creditAssetKind: Number(body.creditAssetKind),
            minCreditAmount: String(body.minCreditAmount),
            nonce: String(body.nonce),
            deadline: String(body.deadline),
            signature: body.signature,
            permit: body.permit,
            res,
        });
        (0, treasuryStableSwapRelay_1.kickTreasuryStableSwapRelay)();
    });
    router.post('/genesisNodeReferralRedeem', (req, res) => {
        const body = req.body;
        if (!body.action || !body.account || body.nonce == null || body.deadline == null || !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing genesis referral redeem fields' }).end();
        }
        const isPayout = body.action === 'setFoundation' || body.action === 'setDefaultAdminPayout';
        if (body.action === 'setL1Ratio') {
            if (!body.l1Address || !ethers_1.ethers.isAddress(body.l1Address)) {
                return res.status(400).json({ success: false, error: 'Missing l1Address' }).end();
            }
            if (body.ratioBps == null || body.ratioBps === '') {
                return res.status(400).json({ success: false, error: 'Missing ratioBps for setL1Ratio' }).end();
            }
        }
        else if (isPayout) {
            if (!body.payoutAddress || !ethers_1.ethers.isAddress(body.payoutAddress)) {
                return res.status(400).json({ success: false, error: 'Missing payoutAddress' }).end();
            }
        }
        else if (!body.redeemHash) {
            return res.status(400).json({ success: false, error: 'Missing redeemHash' }).end();
        }
        if ((body.action === 'claimL0' || body.action === 'claimL1') && !body.secret) {
            return res.status(400).json({ success: false, error: `Missing secret for ${body.action}` }).end();
        }
        if (body.action === 'issueL1' && (body.ratioBps == null || body.ratioBps === '')) {
            return res.status(400).json({ success: false, error: 'Missing ratioBps for issueL1' }).end();
        }
        genesisNodeReferralRedeem_1.genesisNodeReferralRedeemPool.push({
            action: body.action,
            account: body.account,
            redeemHash: body.redeemHash,
            payoutAddress: body.payoutAddress,
            l1Address: body.l1Address,
            nonce: body.nonce,
            deadline: body.deadline,
            signature: body.signature,
            secret: body.secret,
            ratioBps: body.ratioBps,
            res,
        });
        (0, genesisNodeReferralRedeem_1.kickGenesisNodeReferralRedeemRelay)();
    });
    router.post('/setChatIndexPointer', (req, res) => {
        const b = req.body;
        if (!b.owner || !b.indexHash || b.ts == null || b.seq == null || b.nonce == null || !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing chat index pointer fields' }).end();
        }
        chatIndexPointer_1.chatIndexPointerPool.push({
            owner: b.owner,
            indexHash: b.indexHash,
            ts: b.ts,
            seq: b.seq,
            nonce: b.nonce,
            signature: b.signature,
            res,
        });
        (0, chatIndexPointer_1.kickChatIndexPointerRelay)();
    });
    router.post('/validatorDepositRedeemAdminCancel', (req, res) => {
        const b = req.body;
        if (!b.contract || !b.admin || !b.codeHash || b.nonce == null || b.deadline == null || !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing validator redeem cancel fields' }).end();
        }
        validatorDepositRedeem_1.validatorDepositRedeemCancelPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            admin: ethers_1.ethers.getAddress(b.admin),
            codeHash: b.codeHash,
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, validatorDepositRedeem_1.validatorDepositRedeemCancelProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemCancelProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/validatorDepositRedeemClaim', (req, res) => {
        const b = req.body;
        if (!b.contract || !b.claimer || !b.beneficiary || typeof b.code !== 'string' || b.deadline == null || !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing validator redeem claim fields' }).end();
        }
        const gasLimitRaw = b.gasLimit != null ? Number(b.gasLimit) : 0;
        const gasLimit = Number.isFinite(gasLimitRaw) && gasLimitRaw > 0 ? Math.floor(gasLimitRaw) : 1_800_000;
        validatorDepositRedeem_1.validatorDepositRedeemClaimPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            claimer: ethers_1.ethers.getAddress(b.claimer),
            beneficiary: ethers_1.ethers.getAddress(b.beneficiary),
            referrer: ethers_1.ethers.ZeroAddress,
            code: b.code,
            deadline: BigInt(b.deadline),
            signature: b.signature,
            gasLimit,
            res,
        });
        (0, validatorDepositRedeem_1.validatorDepositRedeemClaimProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemClaimProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/validatorDepositRedeemClaimAirdrop', (req, res) => {
        const b = req.body;
        if (!b.contract || !b.beneficiary || !b.amount || b.nonce == null || b.deadline == null || !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing validator redeem airdrop claim fields' }).end();
        }
        validatorDepositRedeem_1.validatorDepositRedeemClaimAirdropPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            beneficiary: ethers_1.ethers.getAddress(b.beneficiary),
            amount: BigInt(b.amount),
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, validatorDepositRedeem_1.validatorDepositRedeemClaimAirdropProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemClaimAirdropProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/gbDepinChargeUserGb', (req, res) => {
        const b = req.body;
        if (b.guardianNodeId == null || !b.user || b.amount == null) {
            return res.status(400).json({ success: false, error: 'Missing guardianNodeId, user, or amount' }).end();
        }
        let guardianNodeId;
        try {
            guardianNodeId = BigInt(String(b.guardianNodeId));
        }
        catch {
            return res.status(400).json({ success: false, error: 'invalid guardianNodeId' }).end();
        }
        let amount;
        try {
            amount = BigInt(String(b.amount));
        }
        catch {
            return res.status(400).json({ success: false, error: 'invalid amount' }).end();
        }
        gbDepinAirdrop_1.gbDepinChargeUserPool.push({
            guardianNodeId,
            user: ethers_1.ethers.getAddress(b.user),
            amount,
            res,
        });
        (0, gbDepinAirdrop_1.kickGbDepinChargeUserPoolPress)();
    });
    router.post('/gbDepinAirdropPaidAll', (req, res) => {
        gbDepinAirdrop_1.gbDepinAirdropAllPool.push({ res });
        (0, gbDepinAirdrop_1.kickGbDepinAirdropAllPoolPress)();
    });
    router.post('/validatorDepositRedeemTransfer', (req, res) => {
        const b = req.body;
        if (!b.contract ||
            !b.fromBeneficiary ||
            !b.toBeneficiary ||
            !Array.isArray(b.guardianIds) ||
            b.guardianIds.length === 0 ||
            b.nonce == null ||
            b.deadline == null ||
            !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing validator redeem transfer fields' }).end();
        }
        validatorDepositRedeem_1.validatorDepositRedeemTransferPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            fromBeneficiary: ethers_1.ethers.getAddress(b.fromBeneficiary),
            toBeneficiary: ethers_1.ethers.getAddress(b.toBeneficiary),
            guardianIds: b.guardianIds.map((g) => BigInt(g)),
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, validatorDepositRedeem_1.validatorDepositRedeemTransferProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemTransferProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/validatorCreateTransferOrder', (req, res) => {
        const b = req.body;
        if (!b.contract ||
            !b.seller ||
            !Array.isArray(b.guardianIds) ||
            b.guardianIds.length === 0 ||
            b.priceUsdc6 == null ||
            b.nonce == null ||
            b.deadline == null ||
            !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing create transfer order fields' }).end();
        }
        validatorDepositRedeem_1.validatorCreateTransferOrderPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            seller: ethers_1.ethers.getAddress(b.seller),
            guardianIds: b.guardianIds.map((g) => BigInt(g)),
            priceUsdc6: BigInt(b.priceUsdc6),
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, validatorDepositRedeem_1.validatorCreateTransferOrderProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorCreateTransferOrderProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/validatorCancelTransferOrder', (req, res) => {
        const b = req.body;
        if (!b.contract || b.orderId == null || !b.seller || b.nonce == null || b.deadline == null || !b.signature) {
            return res.status(400).json({ success: false, error: 'Missing cancel transfer order fields' }).end();
        }
        validatorDepositRedeem_1.validatorCancelTransferOrderPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            orderId: BigInt(b.orderId),
            seller: ethers_1.ethers.getAddress(b.seller),
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            res,
        });
        (0, validatorDepositRedeem_1.validatorCancelTransferOrderProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorCancelTransferOrderProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/validatorFulfillTransferOrder', (req, res) => {
        const b = req.body;
        if (!b.contract ||
            b.orderId == null ||
            !b.buyer ||
            b.nonce == null ||
            b.deadline == null ||
            !b.signature ||
            b.payValidAfter == null ||
            b.payValidBefore == null ||
            !b.payNonce ||
            !b.paySignature) {
            return res.status(400).json({ success: false, error: 'Missing fulfill transfer order fields' }).end();
        }
        validatorDepositRedeem_1.validatorFulfillTransferOrderPool.push({
            contract: ethers_1.ethers.getAddress(b.contract),
            orderId: BigInt(b.orderId),
            buyer: ethers_1.ethers.getAddress(b.buyer),
            nonce: BigInt(b.nonce),
            deadline: BigInt(b.deadline),
            signature: b.signature,
            payValidAfter: BigInt(b.payValidAfter),
            payValidBefore: BigInt(b.payValidBefore),
            payNonce: b.payNonce,
            paySignature: b.paySignature,
            res,
        });
        (0, validatorDepositRedeem_1.validatorFulfillTransferOrderProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorFulfillTransferOrderProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/purchaseBUnitFromBase - 由 cluster 预检后转发，master 推入 purchaseBUnitFromBasePool，经 Settle_ContractPool 执行 BaseTreasury.purchaseBUnitWith3009Authorization */
    router.post('/purchaseBUnitFromBase', (req, res) => {
        const body = req.body;
        if (!body.from || !body.amount || body.validAfter == null || body.validBefore == null || !body.nonce || !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing from, amount, validAfter, validBefore, nonce, or signature' }).end();
        }
        MemberCard_1.purchaseBUnitFromBasePool.push({
            from: body.from,
            amount: body.amount,
            validAfter: body.validAfter,
            validBefore: body.validBefore,
            nonce: body.nonce,
            signature: body.signature,
            res,
        });
        (0, MemberCard_1.purchaseBUnitFromBaseProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[purchaseBUnitFromBaseProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/removePOS - 由 cluster 预检后转发，master 推入 removePOSPool，经 Settle_ContractPool 执行 MerchantPOSManagement.removePOSBySignature */
    router.post('/removePOS', (req, res) => {
        const body = req.body;
        if (!body.merchant || !body.pos || body.deadline == null || !body.nonce || !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing merchant, pos, deadline, nonce, or signature' }).end();
        }
        MemberCard_1.removePOSPool.push({
            merchant: body.merchant,
            pos: body.pos,
            deadline: body.deadline,
            nonce: body.nonce,
            signature: body.signature,
            res,
        });
        (0, MemberCard_1.removePOSProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[removePOSProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/registerPOS - 由 cluster 预检后转发，master 推入 registerPOSPool，执行 MerchantPOSManagement.registerPOSBySignature */
    router.post('/registerPOS', (req, res) => {
        const body = req.body;
        if (!body.merchant || !body.pos || body.deadline == null || !body.nonce || !body.signature) {
            return res.status(400).json({ success: false, error: 'Missing merchant, pos, deadline, nonce, or signature' }).end();
        }
        MemberCard_1.registerPOSPool.push({
            merchant: body.merchant,
            pos: body.pos,
            deadline: body.deadline,
            nonce: body.nonce,
            signature: body.signature,
            res,
        });
        (0, MemberCard_1.registerPOSProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[registerPOSProcess] unhandled error:'), err?.message ?? err);
        });
    });
    router.post('/storageFragment', (req, res) => {
        const { hash, wallet, imageLength } = req.body;
        db_1.ipfsDataPool.push({
            wallet, imageLength, hash
        });
        (0, logger_1.logger)(`storageFragment ${hash} ${wallet} ${imageLength}`);
        (0, db_1.ipfsDataProcess)();
        res.status(200).end();
    });
    router.post('/getFragment', (req, res) => {
        const { hash } = req.body;
        db_1.ipfsAccessPool.push({
            hash
        });
        (0, db_1.ipfsAccessProcess)();
        res.status(200).end();
    });
    router.post('/coinbase-hooks', express_1.default.raw({ type: '*/*' }), (req, res) => {
        return (0, coinbase_1.coinbaseHooks)(req, res);
    });
    /** POST /api/nfcCardStatus - 查询 NFC 卡状态（Master 可选实现，Cluster 已直接处理） */
    router.post('/nfcCardStatus', async (req, res) => {
        const { uid } = req.body;
        if (!uid || typeof uid !== 'string') {
            return res.status(400).json({ error: 'Missing uid' });
        }
        const result = await (0, db_1.getNfcCardByUid)(uid);
        return res.status(200).json(result).end();
    });
    /** POST /api/registerNfcCard - 登记 NFC 卡（uid + private_key；tagId 可选，SUN 解密得到的 TagID） */
    router.post('/registerNfcCard', async (req, res) => {
        const { uid, privateKey, tagId } = req.body;
        if (!uid || typeof uid !== 'string' || !privateKey || typeof privateKey !== 'string') {
            return res.status(400).json({ ok: false, error: 'Missing uid or privateKey' });
        }
        await (0, db_1.registerNfcCardToDb)({ uid: uid.trim(), privateKey: privateKey.trim(), ...(tagId && typeof tagId === 'string' && { tagId: tagId.trim() }) });
        return res.status(200).json({ ok: true }).end();
    });
    /** POST /api/payByNfcUidPrepare - 客户端构建 container 前的准备，返回 account、nonce、deadline、payeeAA、cardCurrency、pointsUnitPriceInCurrencyE6（fiat6-only 协议）以及兼容的 unitPriceUSDC6。
     *  fiat6-only 协议：传 `amountFiat6` + `currency`；`amountUsdc6` 已 deprecated，仅作回退。NFC 格式时需 e/c/m 做 SUN 校验。 */
    router.post('/payByNfcUidPrepare', async (req, res) => {
        const { uid, payee, amountUsdc6, amountFiat6, currency, merchantInfraCard, e, c, m } = req.body;
        if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
            return res.status(400).json({ ok: false, error: 'Missing uid' });
        }
        if (!payee || !ethers_1.ethers.isAddress(payee)) {
            return res.status(400).json({ ok: false, error: 'Invalid payee' });
        }
        const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : '';
        const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
        const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== '';
        const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n;
        if (!fiat6Ok && !usdc6Ok) {
            return res.status(400).json({ ok: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' });
        }
        const merchantInfraForPrepare = typeof merchantInfraCard === 'string' && merchantInfraCard.trim() && ethers_1.ethers.isAddress(merchantInfraCard.trim())
            ? ethers_1.ethers.getAddress(merchantInfraCard.trim())
            : undefined;
        (0, logger_1.logger)(safe_1.default.cyan(`[payByNfcUidPrepare] Master received uid=${uid.trim().slice(0, 16)}... fiat6=${fiat6Ok ? `${fiat6Trim} ${currencyTrim}` : 'none'} usdc6=${usdc6Ok ? amountUsdc6 : 'none'} merchantInfraCard=${merchantInfraForPrepare ?? 'none'}`));
        const result = await (0, MemberCard_1.payByNfcUidPrepare)({
            uid: uid.trim(),
            payee: ethers_1.ethers.getAddress(payee),
            amountUsdc6: usdc6Ok ? amountUsdc6 : undefined,
            amountFiat6: fiat6Ok ? fiat6Trim : undefined,
            currency: fiat6Ok ? currencyTrim : undefined,
            merchantInfraCard: merchantInfraForPrepare,
            e,
            c,
            m,
        });
        return res.status(result.ok ? 200 : 400).json(result).end();
    });
    /** POST /api/payByNfcUidSignContainer - 接受 Android 打包的未签名 container，用 UID 私钥签名后 relay。NFC 格式时需 e/c/m 做 SUN 校验。 */
    router.post('/payByNfcUidSignContainer', async (req, res) => {
        const { uid, containerPayload, amountUsdc6, amountFiat6, currency, merchantInfraCard, e, c, m, nfcSubtotalCurrencyAmount, nfcTipCurrencyAmount, nfcTipRateBps, nfcRequestCurrency, nfcDiscountAmountFiat6, nfcDiscountRateBps, nfcTaxAmountFiat6, nfcTaxRateBps, chargeOwnerChildBurn, } = req.body;
        if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Missing uid' });
        }
        if (!containerPayload || typeof containerPayload !== 'object') {
            return res.status(400).json({ success: false, error: 'Missing containerPayload' });
        }
        const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : '';
        const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
        const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== '';
        const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n;
        const merchantInfraForContainer = typeof merchantInfraCard === 'string' && merchantInfraCard.trim() && ethers_1.ethers.isAddress(merchantInfraCard.trim())
            ? ethers_1.ethers.getAddress(merchantInfraCard.trim())
            : undefined;
        (0, logger_1.logger)(safe_1.default.cyan(`[payByNfcUidSignContainer] Master received container uid=${uid.slice(0, 16)}... amountFiat6=${fiat6Ok ? `${fiat6Trim} ${currencyTrim}` : 'none'} amountUsdc6=${usdc6Ok ? amountUsdc6 : 'none'} merchantInfraCard=${merchantInfraForContainer ?? 'none'}\n` + (0, node_util_1.inspect)(containerPayload, false, 4, true)));
        const preCheck = (0, MemberCard_1.ContainerRelayPreCheckUnsigned)(containerPayload);
        if (!preCheck.success) {
            return res.status(400).json({ success: false, error: preCheck.error }).end();
        }
        if (!fiat6Ok && !usdc6Ok) {
            return res.status(400).json({ success: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' });
        }
        const nfcLog = {
            nfcSubtotalCurrencyAmount: nfcSubtotalCurrencyAmount ?? null,
            nfcTipCurrencyAmount: nfcTipCurrencyAmount ?? null,
            nfcRequestCurrency: nfcRequestCurrency ?? null,
            types: {
                sub: typeof nfcSubtotalCurrencyAmount,
                tip: typeof nfcTipCurrencyAmount,
                cur: typeof nfcRequestCurrency,
            },
        };
        (0, logger_1.logger)(safe_1.default.gray(`[payByNfcUidSignContainer] Master NFC body (raw): ${JSON.stringify(nfcLog)}`));
        const result = await (0, MemberCard_1.payByNfcUidSignContainer)({
            uid: uid.trim(),
            containerPayload,
            amountUsdc6: usdc6Ok ? amountUsdc6 : undefined,
            amountFiat6: fiat6Ok ? fiat6Trim : undefined,
            currency: fiat6Ok ? currencyTrim : undefined,
            merchantInfraCard: merchantInfraForContainer,
            res,
            e,
            c,
            m,
            nfcSubtotalCurrencyAmount: nfcSubtotalCurrencyAmount != null && String(nfcSubtotalCurrencyAmount).trim() !== ''
                ? String(nfcSubtotalCurrencyAmount).trim()
                : undefined,
            nfcTipCurrencyAmount: nfcTipCurrencyAmount != null && String(nfcTipCurrencyAmount).trim() !== ''
                ? String(nfcTipCurrencyAmount).trim()
                : undefined,
            nfcTipRateBps: nfcTipRateBps != null && Number.isFinite(Number(nfcTipRateBps))
                ? Math.max(0, Math.min(10000, Math.trunc(Number(nfcTipRateBps))))
                : undefined,
            nfcRequestCurrency: nfcRequestCurrency != null && String(nfcRequestCurrency).trim() !== ''
                ? String(nfcRequestCurrency).trim()
                : undefined,
            nfcDiscountAmountFiat6: nfcDiscountAmountFiat6 != null && String(nfcDiscountAmountFiat6).trim() !== ''
                ? String(nfcDiscountAmountFiat6).trim()
                : undefined,
            nfcDiscountRateBps,
            nfcTaxAmountFiat6: nfcTaxAmountFiat6 != null && String(nfcTaxAmountFiat6).trim() !== ''
                ? String(nfcTaxAmountFiat6).trim()
                : undefined,
            nfcTaxRateBps,
            chargeOwnerChildBurn,
        });
        if (result.pushed)
            return;
        if (res.headersSent)
            return;
        return res.status(result.httpStatus ?? 400).json({ success: false, error: result.error }).end();
    });
    /** POST /api/payByNfcUid - 以 UID 支付：Smart Routing 聚合 CCSA+USDC 扣款，无 AA 时回退纯 USDC 转账 */
    router.post('/payByNfcUid', async (req, res) => {
        const { uid, amountUsdc6, amountFiat6, currency, payee } = req.body;
        (0, logger_1.logger)(safe_1.default.cyan(`[payByNfcUid] Master received uid=${uid?.slice(0, 16)}... amountFiat6=${amountFiat6 ?? 'none'} currency=${currency ?? 'none'} amountUsdc6=${amountUsdc6 ?? 'none'} payee=${payee}`));
        if (!uid || typeof uid !== 'string' || uid.trim().length === 0) {
            (0, logger_1.logger)(safe_1.default.red('[payByNfcUid] reject: Missing uid'));
            return res.status(400).json({ success: false, error: 'Missing uid' });
        }
        const fiat6Trim = typeof amountFiat6 === 'string' ? amountFiat6.trim() : '';
        const currencyTrim = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
        const fiat6Ok = fiat6Trim !== '' && /^[0-9]+$/.test(fiat6Trim) && BigInt(fiat6Trim) > 0n && currencyTrim !== '';
        const usdc6Ok = !!amountUsdc6 && /^[0-9]+$/.test(String(amountUsdc6).trim()) && BigInt(String(amountUsdc6).trim()) > 0n;
        if (!fiat6Ok && !usdc6Ok) {
            (0, logger_1.logger)(safe_1.default.red(`[payByNfcUid] reject: Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)`));
            return res.status(400).json({ success: false, error: 'Missing amountFiat6+currency (preferred) or amountUsdc6 (deprecated)' });
        }
        const amountBig = usdc6Ok ? BigInt(String(amountUsdc6).trim()) : 0n;
        if (!payee || !ethers_1.ethers.isAddress(payee)) {
            (0, logger_1.logger)(safe_1.default.red(`[payByNfcUid] reject: Invalid payee=${payee}`));
            return res.status(400).json({ success: false, error: 'Invalid payee address' });
        }
        if (!usdc6Ok && fiat6Ok) {
            // fiat6-only Charge 协议：/payByNfcUid 走 OpenContainer 路径，OpenContainer 仍按 USDC 计费。
            // TODO(下一批)：把 OpenContainer 路径接入 fiat6+chain quote 自洽换算。当前过渡期：要求 fiat6 客户端走 /payByNfcUidSignContainer。
            (0, logger_1.logger)(safe_1.default.red(`[payByNfcUid] fiat6-only client should use /payByNfcUidSignContainer (OpenContainer path 暂未支持 fiat6 自洽换算)`));
            return res.status(400).json({ success: false, error: 'fiat6-only client must use /payByNfcUidSignContainer (OpenContainer path 暂未支持 fiat6)' });
        }
        const privateKey = await (0, db_1.getNfcCardPrivateKeyByUid)(uid);
        (0, logger_1.logger)(safe_1.default.cyan(`[payByNfcUid] getNfcCardPrivateKeyByUid: ${privateKey ? 'OK (from DB or mnemonic)' : 'null (card not found)'}`));
        if (!privateKey) {
            return res.status(403).json({ success: false, error: 'Card not found' });
        }
        const openResult = await (0, MemberCard_1.payByNfcUidOpenContainer)({ uid: uid.trim(), amountUsdc6: amountUsdc6 ?? amountBig.toString(), payee: ethers_1.ethers.getAddress(payee), res });
        (0, logger_1.logger)(safe_1.default.cyan(`[payByNfcUid] payByNfcUidOpenContainer: pushed=${openResult.pushed}${openResult.error ? ` error=${openResult.error}` : ''}`));
        if (openResult.pushed) {
            return;
        }
        if (openResult.error?.includes('linking to the Beamio app')) {
            return res.status(403).json({ success: false, error: openResult.error }).end();
        }
        // Payee cannot receive CCSA (e.g. EOA-only): skip fallback when pure USDC would also fail
        if (openResult.error &&
            (openResult.error.includes('EOA') ||
                openResult.error.includes('cannot receive CCSA') ||
                openResult.error.includes('无法接收 CCSA'))) {
            return res.status(400).json({ success: false, error: openResult.error }).end();
        }
        (0, logger_1.logger)(safe_1.default.yellow(`[payByNfcUid] fallback to simple USDC transfer`));
        try {
            const provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
            const wallet = new ethers_1.ethers.Wallet(privateKey, provider);
            const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
            const usdcAbi = ['function transfer(address to, uint256 amount) returns (bool)'];
            const usdc = new ethers_1.ethers.Contract(USDC_BASE, usdcAbi, wallet);
            const tx = await usdc.transfer(ethers_1.ethers.getAddress(payee), amountBig);
            await tx.wait();
            (0, logger_1.logger)(safe_1.default.green(`[payByNfcUid] fallback USDC uid=${uid.slice(0, 16)}... -> ${payee} amount=${amountUsdc6} tx=${tx.hash}`));
            try {
                const payerEoa = ethers_1.ethers.getAddress(await wallet.getAddress());
                const assets = await (0, getUIDAssetsLogic_1.fetchUIDAssetsForEOA)(payerEoa);
                (0, getUIDAssetsLogic_1.scheduleEnsureNfcBeamioTagForEoa)(payerEoa, uid.trim(), null, assets.cards);
            }
            catch (tagErr) {
                (0, logger_1.logger)(safe_1.default.yellow(`[payByNfcUid] NFC beamioTag ensure after fallback: ${tagErr?.message ?? tagErr}`));
            }
            return res.status(200).json({ success: true, USDC_tx: tx.hash }).end();
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.red(`[payByNfcUid] failed: ${e?.message ?? e}`));
            return res.status(500).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'Transfer failed' }).end();
        }
    });
    /** POST /api/nfcLinkApp - 基础设施卡 owner 签 executeForOwner(createRedeemBatch)，返回明文 redeem 与深链 */
    router.post('/nfcLinkApp', async (req, res) => {
        await (0, MemberCard_1.nfcLinkAppExecute)(req.body ?? {}, res);
    });
    /** POST /api/nfcLinkAppCancel - 取消进行中 Link：executeForOwner(cancelRedeem)（若有）+ 释放 DB 会话 */
    router.post('/nfcLinkAppCancel', async (req, res) => {
        await (0, MemberCard_1.nfcLinkAppCancelExecute)(req.body ?? {}, res);
    });
    /** POST /api/nfcLinkAppClaimWithKey - App 完成 Link：redeem（若有）+ 将 nfc_cards 私钥换为用户密钥 + 释放会话 */
    router.post('/nfcLinkAppClaimWithKey', async (req, res) => {
        await (0, MemberCard_1.nfcLinkAppClaimWithKeyExecute)(req.body ?? {}, res);
    });
    /** POST /api/nfcTopupPrepare - 返回 executeForAdmin 所需的 cardAddr、data、deadline、nonce。cardAddress 必填；支持 uid（NFC）或 wallet（Scan QR）。Optional paidAmount = 实付本金. */
    router.post('/nfcTopupPrepare', async (req, res) => {
        try {
            const { uid, wallet, amount, currency, cardAddress, membershipTierIndex, membershipFeeFiat6, paidAmount } = req.body;
            const hasUid = uid && typeof uid === 'string' && uid.trim().length > 0;
            const hasWallet = wallet && typeof wallet === 'string' && ethers_1.ethers.isAddress(wallet.trim());
            if (!hasUid && !hasWallet) {
                return res.status(400).json({ success: false, error: 'Missing uid or wallet' });
            }
            if (!cardAddress || typeof cardAddress !== 'string' || !ethers_1.ethers.isAddress(cardAddress.trim())) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' });
            }
            const result = await (0, MemberCard_1.nfcTopupPreparePayload)({
                uid: hasUid ? uid.trim() : undefined,
                wallet: hasWallet ? ethers_1.ethers.getAddress(wallet.trim()) : undefined,
                amount: String(amount ?? ''),
                currency: (currency || 'CAD').trim(),
                cardAddress: ethers_1.ethers.getAddress(cardAddress.trim()),
                ...(membershipTierIndex != null && String(membershipTierIndex).trim() !== ''
                    ? { membershipTierIndex }
                    : {}),
                ...(membershipFeeFiat6 != null && String(membershipFeeFiat6).trim() !== ''
                    ? { membershipFeeFiat6 }
                    : {}),
                ...(paidAmount != null && String(paidAmount).trim() !== ''
                    ? { paidAmount: String(paidAmount).trim() }
                    : {}),
            });
            if ('error' in result) {
                return res.status(400).json({ success: false, error: result.error });
            }
            return res.status(200).json(result).end();
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.red(`[nfcTopupPrepare][master] error: ${e?.shortMessage ?? e?.message ?? e}`));
            return res.status(500).json({ success: false, error: e?.shortMessage ?? e?.message ?? 'Prepare failed' }).end();
        }
    });
    /** POST /api/executeForAdmin - cardAddAdminByAdmin 等：Cluster 预检后转发，Master 推入 executeForAdminPool */
    router.post('/executeForAdmin', async (req, res) => {
        const { cardAddress, cardAddr, data, deadline, nonce, adminSignature, cardOwnerEOA, topupFeeBUnits, topupKind, posOperator, couponBurnUserEOA, couponBurnRefWallet, } = req.body;
        const addr = cardAddr ?? cardAddress;
        if (!addr || !ethers_1.ethers.isAddress(addr) || !data || typeof data !== 'string' || data.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress/cardAddr/data' });
        }
        if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string' || !adminSignature || typeof adminSignature !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce/adminSignature' });
        }
        let feeBUnits;
        if (topupFeeBUnits != null && String(topupFeeBUnits).trim() !== '') {
            try {
                feeBUnits = BigInt(String(topupFeeBUnits).trim());
            }
            catch {
                return res.status(400).json({ success: false, error: 'Invalid topupFeeBUnits' });
            }
        }
        const ownerEoa = cardOwnerEOA && ethers_1.ethers.isAddress(cardOwnerEOA) ? ethers_1.ethers.getAddress(cardOwnerEOA) : undefined;
        const posOp = posOperator && ethers_1.ethers.isAddress(posOperator) ? ethers_1.ethers.getAddress(posOperator) : undefined;
        const burnUser = couponBurnUserEOA && ethers_1.ethers.isAddress(couponBurnUserEOA)
            ? ethers_1.ethers.getAddress(couponBurnUserEOA)
            : undefined;
        const burnRef = couponBurnRefWallet && ethers_1.ethers.isAddress(couponBurnRefWallet)
            ? ethers_1.ethers.getAddress(couponBurnRefWallet)
            : undefined;
        const kindRaw = Number(topupKind);
        const kindParsed = kindRaw === 1 || kindRaw === 2 || kindRaw === 3 ? kindRaw : undefined;
        MemberCard_1.executeForAdminPool.push({
            cardAddr: ethers_1.ethers.getAddress(addr),
            data,
            deadline,
            nonce,
            adminSignature,
            ...(ownerEoa ? { cardOwnerEOA: ownerEoa } : {}),
            ...(feeBUnits != null && feeBUnits > 0n ? { topupFeeBUnits: feeBUnits } : {}),
            ...(kindParsed != null ? { topupKind: kindParsed } : {}),
            ...(posOp ? { posOperator: posOp } : {}),
            ...(burnUser ? { couponBurnUserEOA: burnUser } : {}),
            ...(burnRef ? { couponBurnRefWallet: burnRef } : {}),
            res,
        });
        (0, logger_1.logger)(safe_1.default.cyan(`[executeForAdmin] pushed to pool, card=${addr}`));
        (0, MemberCard_1.executeForAdminProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[executeForAdminProcess] unhandled error:'), err?.message ?? err);
        });
    });
    /** POST /api/nfcTopup - NFC 卡向 CCSA 充值：读取方 UI 用户用 profile 私钥签 ExecuteForAdmin，Master 调用 factory.executeForAdmin */
    router.post('/nfcTopup', async (req, res) => {
        const { cardAddr, data, deadline, nonce, adminSignature, uid, cardOwnerEOA, topupFeeBUnits, topupKind, cardCurrencyAmount, cashCurrencyAmount, bonusCurrencyAmount, currencyAmount, usdcTopupSessionId, posOperator, membershipFeeStage, chargeBurnProgramPoints, chargeBurnCustomerEOA, chargeBurnAmountFiat6, chargeBurnCurrency, } = req.body;
        /** 仅当本请求成功消费 `awaiting_beneficiary` session 时由本 handler 填入（忽略 body 里伪造的对账元数据）。 */
        let usdcPhase2OriginatingTx;
        let usdcPhase2ChargeSid;
        let usdcPhase2PosOp;
        const usdcSidRaw = typeof usdcTopupSessionId === 'string' ? usdcTopupSessionId.trim().toLowerCase() : '';
        if (usdcSidRaw && masterIsValidSid(usdcSidRaw)) {
            masterPruneExpiredChargeSessions();
            const rec = masterChargeSessions.get(usdcSidRaw);
            if (!rec || rec.state !== 'awaiting_beneficiary') {
                return res
                    .status(400)
                    .json({ success: false, error: 'Invalid USDC top-up session (not awaiting beneficiary)' })
                    .end();
            }
            const cardNorm = ethers_1.ethers.getAddress(String(cardAddr).trim());
            if (!rec.cardAddr || ethers_1.ethers.getAddress(rec.cardAddr) !== cardNorm) {
                return res.status(400).json({ success: false, error: 'USDC session card mismatch' }).end();
            }
            const parseTot = (raw) => {
                const t = String(raw ?? '')
                    .trim()
                    .replace(/,/g, '');
                if (!t)
                    return -1n;
                try {
                    return ethers_1.ethers.parseUnits(t, 6);
                }
                catch {
                    return -1n;
                }
            };
            const totBody = parseTot(currencyAmount);
            if (totBody < 0n) {
                return res.status(400).json({ success: false, error: 'Missing currencyAmount for USDC phase-2 topup' }).end();
            }
            const anySplit = (cardCurrencyAmount != null && String(cardCurrencyAmount).trim() !== '') ||
                (cashCurrencyAmount != null && String(cashCurrencyAmount).trim() !== '') ||
                (bonusCurrencyAmount != null && String(bonusCurrencyAmount).trim() !== '');
            if (anySplit) {
                const cE = parseTot(cardCurrencyAmount);
                const cashE = parseTot(cashCurrencyAmount);
                const bE = parseTot(bonusCurrencyAmount);
                const totE = parseTot(currencyAmount);
                if (cE < 0n || cashE < 0n || bE < 0n || totE < 0n) {
                    return res.status(400).json({ success: false, error: 'Invalid top-up currency split amounts' }).end();
                }
                if (totE <= 0n || cE + cashE + bE !== totE) {
                    return res.status(400).json({ success: false, error: 'Split amounts must sum to currencyAmount' }).end();
                }
            }
            const sessTot = parseTot(rec.total);
            if (sessTot < 0n || totBody !== sessTot) {
                return res.status(400).json({ success: false, error: 'USDC session amount mismatch' }).end();
            }
            const curRec = (rec.currency ?? '').trim().toUpperCase();
            if (curRec) {
                let chainCur = '';
                try {
                    const c = new ethers_1.ethers.Contract(cardNorm, ['function currency() view returns (string)'], providerBaseForLatestCards);
                    chainCur = String(await c.currency()).trim().toUpperCase();
                }
                catch {
                    chainCur = '';
                }
                if (chainCur && chainCur !== curRec) {
                    return res.status(400).json({ success: false, error: 'USDC session currency mismatch' }).end();
                }
            }
            const usdcTx = rec.USDC_tx && /^0x[0-9a-fA-F]{64}$/.test(rec.USDC_tx) ? rec.USDC_tx.toLowerCase() : '';
            if (!usdcTx) {
                return res.status(400).json({ success: false, error: 'USDC session missing settle tx' }).end();
            }
            usdcPhase2OriginatingTx = usdcTx;
            usdcPhase2ChargeSid = usdcSidRaw;
            if (rec.pos && ethers_1.ethers.isAddress(rec.pos))
                usdcPhase2PosOp = ethers_1.ethers.getAddress(rec.pos);
            const now = Date.now();
            masterChargeSessions.set(usdcSidRaw, {
                ...rec,
                state: 'topup_pending',
                error: null,
                updatedAt: now,
            });
        }
        if (!cardAddr || !ethers_1.ethers.isAddress(cardAddr) || !data || typeof data !== 'string' || data.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr/data' });
        }
        if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string' || !adminSignature || typeof adminSignature !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce/adminSignature' });
        }
        const mintLinkBlock = await (0, MemberCard_1.nfcLinkAppPaymentBlockedForMintCalldata)(data);
        if (mintLinkBlock) {
            return res.status(403).json({ success: false, error: mintLinkBlock }).end();
        }
        const parseTopupAmtE6 = (raw) => {
            const t = String(raw ?? '')
                .trim()
                .replace(/,/g, '');
            if (!t)
                return 0n;
            try {
                return ethers_1.ethers.parseUnits(t, 6);
            }
            catch {
                return -1n;
            }
        };
        const cE = parseTopupAmtE6(cardCurrencyAmount);
        const cashE = parseTopupAmtE6(cashCurrencyAmount);
        const bE = parseTopupAmtE6(bonusCurrencyAmount);
        const totE = parseTopupAmtE6(currencyAmount);
        const anySplit = (cardCurrencyAmount != null && String(cardCurrencyAmount).trim() !== '') ||
            (cashCurrencyAmount != null && String(cashCurrencyAmount).trim() !== '') ||
            (bonusCurrencyAmount != null && String(bonusCurrencyAmount).trim() !== '') ||
            (currencyAmount != null && String(currencyAmount).trim() !== '');
        let topupCurrencySplit;
        if (anySplit) {
            if (cE < 0n || cashE < 0n || bE < 0n || totE < 0n) {
                return res.status(400).json({ success: false, error: 'Invalid top-up currency split amounts' }).end();
            }
            if (totE <= 0n || cE + cashE + bE !== totE) {
                return res
                    .status(400)
                    .json({
                    success: false,
                    error: 'cardCurrencyAmount + cashCurrencyAmount + bonusCurrencyAmount must equal currencyAmount (6dp)',
                })
                    .end();
            }
            topupCurrencySplit = { currencyAmountE6: totE, cardE6: cE, cashE6: cashE, bonusE6: bE };
        }
        const posOpNfc = typeof posOperator === 'string' && ethers_1.ethers.isAddress(posOperator.trim())
            ? ethers_1.ethers.getAddress(posOperator.trim())
            : undefined;
        const kindNfc = topupKind === 1 || topupKind === 2 || topupKind === 3 ? topupKind : 2;
        let membershipFeeStageParsed;
        if (membershipFeeStage && typeof membershipFeeStage === 'object') {
            const r = membershipFeeStage.recipientEOA;
            const t = Number(membershipFeeStage.tierIndex);
            try {
                const feePaid6 = BigInt(String(membershipFeeStage.feePaid6 ?? '').trim());
                const pointsCredit6 = BigInt(String(membershipFeeStage.pointsCredit6 ?? '').trim());
                const bootstrapOnChain = Boolean(membershipFeeStage.bootstrapOnChain);
                const durationKindRaw = membershipFeeStage.durationKind;
                const durationKind = durationKindRaw != null && String(durationKindRaw).trim() !== ''
                    ? Number(durationKindRaw)
                    : undefined;
                if (r &&
                    ethers_1.ethers.isAddress(r) &&
                    Number.isInteger(t) &&
                    t >= 0 &&
                    feePaid6 > 0n &&
                    pointsCredit6 > 0n &&
                    (!bootstrapOnChain || (Number.isInteger(durationKind) && (durationKind ?? 0) >= 1))) {
                    membershipFeeStageParsed = {
                        recipientEOA: ethers_1.ethers.getAddress(r),
                        tierIndex: t,
                        feePaid6,
                        pointsCredit6,
                        ...(bootstrapOnChain ? { bootstrapOnChain: true, durationKind } : {}),
                    };
                }
                else {
                    return res.status(400).json({ success: false, error: 'Invalid membershipFeeStage' }).end();
                }
            }
            catch {
                return res.status(400).json({ success: false, error: 'Invalid membershipFeeStage amounts' }).end();
            }
        }
        const wantChargeBurnMaster = chargeBurnProgramPoints === true ||
            String(chargeBurnProgramPoints ?? '').trim().toLowerCase() === 'true';
        MemberCard_1.executeForAdminPool.push({
            cardAddr: ethers_1.ethers.getAddress(cardAddr),
            data,
            deadline,
            nonce,
            adminSignature,
            uid: typeof uid === 'string' ? uid : undefined,
            cardOwnerEOA: cardOwnerEOA && ethers_1.ethers.isAddress(cardOwnerEOA) ? ethers_1.ethers.getAddress(cardOwnerEOA) : undefined,
            topupFeeBUnits: topupFeeBUnits ? BigInt(topupFeeBUnits) : undefined,
            topupKind: kindNfc,
            res,
            topupCurrencySplit,
            ...(posOpNfc ? { posOperator: posOpNfc } : {}),
            ...(membershipFeeStageParsed ? { membershipFeeStage: membershipFeeStageParsed } : {}),
            ...(wantChargeBurnMaster
                ? {
                    chargeBurnProgramPoints: true,
                    ...(typeof chargeBurnCustomerEOA === 'string' &&
                        ethers_1.ethers.isAddress(chargeBurnCustomerEOA.trim())
                        ? { chargeBurnCustomerEOA: ethers_1.ethers.getAddress(chargeBurnCustomerEOA.trim()) }
                        : {}),
                    ...(typeof chargeBurnAmountFiat6 === 'string' &&
                        String(chargeBurnAmountFiat6).trim() !== ''
                        ? { chargeBurnAmountFiat6: String(chargeBurnAmountFiat6).trim() }
                        : {}),
                    ...(typeof chargeBurnCurrency === 'string' &&
                        String(chargeBurnCurrency).trim() !== ''
                        ? { chargeBurnCurrency: String(chargeBurnCurrency).trim() }
                        : {}),
                }
                : {}),
            ...(usdcPhase2ChargeSid && usdcPhase2OriginatingTx
                ? {
                    originatingUSDCTx: usdcPhase2OriginatingTx,
                    chargeSessionId: usdcPhase2ChargeSid,
                    ...(usdcPhase2PosOp ? { posOperator: usdcPhase2PosOp } : {}),
                }
                : {}),
        });
        (0, logger_1.logger)(safe_1.default.green(`[nfcTopup] cardAddr=${cardAddr} uid=${uid ?? '(not provided)'} pushed to executeForAdminPool`));
        (0, MemberCard_1.executeForAdminProcess)().catch((err) => {
            (0, logger_1.logger)(safe_1.default.red('[executeForAdminProcess] nfcTopup error:'), err?.message ?? err);
        });
    });
    /** POST /api/nfcUsdcTopup —— x402 NFC USDC Topup Master 端
     * Cluster 已完成：
     *   - SUN 校验 + recipientEOA 解析
     *   - card.owner() == cardOwner 一致性
     *   - nfcTopupPreparePayload(data/deadline/nonce, mintPointsByAdmin → recipientEOA)
     *   - x402 verify + settle USDC（transferWithAuthorization → cardOwner）
     * Master 在此处：
     *   - 用 service-admin（masterSetup.settle_contractAdmin[0]）EIP-712 签 ExecuteForAdmin
     *   - push executeForAdminPool 复用既有 NFC topup 工作流（executeForAdminProcess + post-base-process 记账） */
    router.post('/nfcUsdcTopup', async (req, res) => {
        const { cardAddr, data, deadline, nonce, recipientEOA, cardOwner, currency, currencyAmount, payer, USDC_tx, usdcAmount6, nfcUid, topupFeeBUnits, originatingUSDCTx, chargeSessionId, posOperator, topupSourceOverride, preSignedAdminSignature, preSignedAdminSigner, } = req.body;
        try {
            if (!cardAddr || !ethers_1.ethers.isAddress(cardAddr) || !data || typeof data !== 'string' || data.length === 0) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr/data' }).end();
            }
            if (typeof deadline !== 'number' || deadline <= 0 || !nonce || typeof nonce !== 'string') {
                return res.status(400).json({ success: false, error: 'Missing or invalid deadline/nonce' }).end();
            }
            if (!recipientEOA || !ethers_1.ethers.isAddress(recipientEOA)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid recipientEOA' }).end();
            }
            if (!cardOwner || !ethers_1.ethers.isAddress(cardOwner)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardOwner' }).end();
            }
            const cardAddrNorm = ethers_1.ethers.getAddress(cardAddr);
            const cardOwnerNorm = ethers_1.ethers.getAddress(cardOwner);
            const recipientNorm = ethers_1.ethers.getAddress(recipientEOA);
            /** PR #4 v2：preSignedAdminSignature 优先 —— 由 POS 终端用 admin EOA 离线签 ExecuteForAdmin。
             *  cluster 端在 `/api/nfcUsdcChargeTopupAuth` 已做 EIP-712 recover==session.pos + isAdmin 双重校验，
             *  Master 这里仅做格式校验后透传。无 preSigned 时回落到 service-admin 签（兼容 NFC USDC topup 历史路径）。 */
            let adminSignatureForPool;
            let adminSignerForLog;
            if (typeof preSignedAdminSignature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(preSignedAdminSignature.trim())) {
                adminSignatureForPool = preSignedAdminSignature.trim();
                if (!preSignedAdminSigner || !ethers_1.ethers.isAddress(preSignedAdminSigner)) {
                    return res.status(400).json({ success: false, error: 'preSignedAdminSignature provided without valid preSignedAdminSigner' }).end();
                }
                adminSignerForLog = ethers_1.ethers.getAddress(preSignedAdminSigner);
            }
            else {
                /** Master 用 service admin key 签 ExecuteForAdmin。要求 settle_contractAdmin[0] 已被 cardOwner 添加为该卡 admin。 */
                const signed = await (0, MemberCard_1.signExecuteForAdminWithServiceAdmin)({ cardAddr: cardAddrNorm, data, deadline, nonce });
                if ('error' in signed) {
                    (0, logger_1.logger)(safe_1.default.red(`[nfcUsdcTopup] service admin sign FAIL: ${signed.error}`));
                    return res.status(500).json({ success: false, error: `Service admin sign failed: ${signed.error}` }).end();
                }
                adminSignatureForPool = signed.adminSignature;
                adminSignerForLog = signed.signer;
            }
            /** USDC 已 settle 至 cardOwner（USDC_tx），此处提供 currencyAmount 让 NFC topup post-base 链路按 currency 拆分。
             *  当前不做拆分，等同 legacy `topupCard`/`newCard`/`upgradeNewCard` 单笔行为。 */
            const totE = (() => {
                const t = String(currencyAmount ?? '').trim().replace(/,/g, '');
                if (!t)
                    return 0n;
                try {
                    return ethers_1.ethers.parseUnits(t, 6);
                }
                catch {
                    return 0n;
                }
            })();
            const topupCurrencySplit = totE > 0n
                ? { currencyAmountE6: totE, cardE6: totE, cashE6: 0n, bonusE6: 0n }
                : undefined;
            const feeBUnitsParsed = (() => {
                if (topupFeeBUnits == null)
                    return undefined;
                const s = String(topupFeeBUnits).trim();
                if (!s || !/^\d+$/.test(s))
                    return undefined;
                try {
                    return BigInt(s);
                }
                catch {
                    return undefined;
                }
            })();
            const originatingUsdcTxNorm = typeof originatingUSDCTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(originatingUSDCTx.trim())
                ? originatingUSDCTx.trim().toLowerCase()
                : undefined;
            const sidNorm = typeof chargeSessionId === 'string' && chargeSessionId.trim().length > 0
                ? chargeSessionId.trim().toLowerCase()
                : undefined;
            const posOperatorNorm = typeof posOperator === 'string' && ethers_1.ethers.isAddress(posOperator.trim())
                ? ethers_1.ethers.getAddress(posOperator.trim())
                : undefined;
            const sourceOverrideNorm = topupSourceOverride === 'usdcPurchasingCard' || topupSourceOverride === 'androidNfcTopup'
                ? topupSourceOverride
                : 'webPosNfcTopup';
            MemberCard_1.executeForAdminPool.push({
                cardAddr: cardAddrNorm,
                data,
                deadline,
                nonce,
                adminSignature: adminSignatureForPool,
                uid: typeof nfcUid === 'string' ? nfcUid : undefined,
                cardOwnerEOA: cardOwnerNorm,
                topupFeeBUnits: feeBUnitsParsed,
                topupKind: 2,
                res,
                topupCurrencySplit,
                topupSourceOverride: sourceOverrideNorm,
                originatingUSDCTx: originatingUsdcTxNorm,
                chargeSessionId: sidNorm,
                posOperator: posOperatorNorm,
            });
            (0, logger_1.logger)(safe_1.default.green(`[nfcUsdcTopup] queued ExecuteForAdmin card=${cardAddrNorm} recipient=${recipientNorm} cardOwner=${cardOwnerNorm} ` +
                `USDC_tx=${USDC_tx ?? 'n/a'} payer=${payer ?? 'n/a'} usdc6=${usdcAmount6 ?? 'n/a'} ` +
                `currency=${currency ?? 'n/a'} amount=${currencyAmount ?? 'n/a'} ` +
                `feeBUnits=${feeBUnitsParsed?.toString() ?? 'n/a'} sid=${sidNorm ?? 'n/a'} ` +
                `pos=${posOperatorNorm ? posOperatorNorm.slice(0, 10) + '…' : 'n/a'} ` +
                `signer=${adminSignerForLog} signSource=${preSignedAdminSignature ? 'pos-presigned' : 'service-admin'}`));
            (0, MemberCard_1.executeForAdminProcess)().catch((err) => {
                (0, logger_1.logger)(safe_1.default.red('[executeForAdminProcess] nfcUsdcTopup error:'), err?.message ?? err);
            });
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[nfcUsdcTopup] master error: ${err?.message ?? err}`));
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: err?.message ?? String(err) }).end();
            }
        }
    });
    /** PR #4 v3 (cross-worker session store) —— 见文件顶部 `MasterChargeSession` block 注释。
     *  POST /api/chargeSessionUpsert  body: { sid, patch }
     *  - sid：UUID v4（非法 ⇒ 400）
     *  - patch：可选字段子集；缺省字段不动；patch.state 必须是合法 state 字符串（非法 ⇒ 400）
     *  - 不存在 ⇒ 用 makeFresh 创建后再 merge
     *  - 200 即代表已落地；fire-and-forget 调用方不必读 body
     *
     *  这里用宽松的 record 透传 patch（不强 schema），因为 patch 字段经常一起增减；
     *  cluster `sessionUpdate` 自己保证只送合法字段，Master 这层只做基本 sanity。 */
    router.post('/chargeSessionUpsert', (req, res) => {
        try {
            const { sid, patch } = (req.body ?? {});
            const sidNorm = typeof sid === 'string' ? sid.trim().toLowerCase() : '';
            if (!masterIsValidSid(sidNorm)) {
                return res.status(400).json({ ok: false, error: 'Invalid sid (expect UUID v4)' }).end();
            }
            if (!patch || typeof patch !== 'object') {
                return res.status(400).json({ ok: false, error: 'Missing patch object' }).end();
            }
            masterPruneExpiredChargeSessions();
            const now = Date.now();
            const prev = masterChargeSessions.get(sidNorm) ?? masterMakeFreshChargeSession(sidNorm, now);
            const merged = { ...prev, ...patch, sid: sidNorm, updatedAt: now };
            // state 校验：只接受合法字符串；其他字段一律透传
            if (patch.state !== undefined &&
                typeof patch.state === 'string' &&
                !['awaiting_payment', 'verifying', 'settling', 'topup_pending', 'awaiting_topup_auth', 'awaiting_beneficiary', 'topup_confirmed', 'charge_pending', 'success', 'error'].includes(patch.state)) {
                return res.status(400).json({ ok: false, error: `Invalid state: ${patch.state}` }).end();
            }
            masterChargeSessions.set(sidNorm, merged);
            return res.status(200).json({ ok: true, sid: sidNorm, state: merged.state }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[chargeSessionUpsert] ${err?.message ?? err}`));
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: err?.message ?? String(err) }).end();
            }
        }
    });
    /** GET /api/chargeSessionGet?sid=...  —— cluster GET /api/nfcUsdcChargeSession 透传到这里。
     *  - sid 不存在 ⇒ `state: 'awaiting_payment'` shell（与之前 cluster 行为一致，POS 不要把它当 error）。
     *  - sid 存在 ⇒ 返回完整 record（含 USDC_tx / payer / breakdown / orchestrator 中间态）。 */
    router.get('/chargeSessionGet', (req, res) => {
        try {
            const sidQ = (req.query?.sid ?? '').toString().trim().toLowerCase();
            if (!masterIsValidSid(sidQ)) {
                return res.status(400).json({ ok: false, error: 'Invalid sid (expect UUID v4)' }).end();
            }
            masterPruneExpiredChargeSessions();
            const rec = masterChargeSessions.get(sidQ);
            if (!rec) {
                return res.status(200).json({ ok: true, state: 'awaiting_payment', sid: sidQ }).end();
            }
            return res.status(200).json({ ok: true, ...rec }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[chargeSessionGet] ${err?.message ?? err}`));
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: err?.message ?? String(err) }).end();
            }
        }
    });
    /** POST /api/chargeSessionConsumePosSig  body: { sid }
     *  orchestrator 的 awaitTopupSignature 闭包通过此端点轮询 + 原子消耗 POS 签名。
     *  - 签名未到 ⇒ `{ ok: false, error: 'no signature yet' }`，调用方下一轮再来
     *  - 签名已到 ⇒ 返回 signature + signer，并清掉 posTopupSignature + 全部 pendingTopup* 字段（一次性消耗，避免重放） */
    router.post('/chargeSessionConsumePosSig', (req, res) => {
        try {
            const { sid } = (req.body ?? {});
            const sidNorm = typeof sid === 'string' ? sid.trim().toLowerCase() : '';
            if (!masterIsValidSid(sidNorm)) {
                return res.status(400).json({ ok: false, error: 'Invalid sid (expect UUID v4)' }).end();
            }
            const rec = masterChargeSessions.get(sidNorm);
            if (!rec)
                return res.status(200).json({ ok: false, error: 'session not found' }).end();
            if (rec.state === 'error')
                return res.status(200).json({ ok: false, error: rec.error || 'session in error' }).end();
            const sig = rec.posTopupSignature;
            if (!sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
                return res.status(200).json({ ok: false, error: 'no signature yet' }).end();
            }
            const signer = rec.pos ?? '';
            const now = Date.now();
            masterChargeSessions.set(sidNorm, {
                ...rec,
                posTopupSignature: null,
                pendingTopupCardAddr: null,
                pendingTopupRecipientEOA: null,
                pendingTopupData: null,
                pendingTopupDeadline: null,
                pendingTopupNonce: null,
                pendingTopupPoints6: null,
                pendingTopupBUnitFee: null,
                pendingTopupVerifyingContract: null,
                updatedAt: now,
            });
            return res.status(200).json({ ok: true, signature: sig, signer }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[chargeSessionConsumePosSig] ${err?.message ?? err}`));
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: err?.message ?? String(err) }).end();
            }
        }
    });
    /** POST /api/nfcUsdcChargeTopupAuth  body: { sid, signature }
     *  POS 端把 admin EOA 离线签的 ExecuteForAdmin 65-byte sig 回灌（cluster 把 POS 的请求 proxy 到这里）。
     *  Master 用 session.pendingTopup* 字段重算 EIP-712 digest，recover 必须 == session.pos。
     *  通过则写 posTopupSignature，编排器的 consumePosSig 闭环立即获取。 */
    router.post('/nfcUsdcChargeTopupAuth', async (req, res) => {
        try {
            const { sid, signature } = (req.body ?? {});
            const sidNorm = typeof sid === 'string' ? sid.trim().toLowerCase() : '';
            if (!masterIsValidSid(sidNorm)) {
                return res.status(400).json({ success: false, error: 'Invalid sid (expect UUID v4)' }).end();
            }
            const sigNorm = typeof signature === 'string' ? signature.trim() : '';
            if (!/^0x[0-9a-fA-F]{130}$/.test(sigNorm)) {
                return res.status(400).json({ success: false, error: 'Invalid signature (expect 65-byte 0x… hex)' }).end();
            }
            masterPruneExpiredChargeSessions();
            const rec = masterChargeSessions.get(sidNorm);
            if (!rec) {
                return res.status(404).json({ success: false, error: 'Session not found or expired' }).end();
            }
            if (rec.state === 'error') {
                return res.status(409).json({ success: false, error: rec.error || 'Session in error state' }).end();
            }
            if (rec.state !== 'awaiting_topup_auth') {
                if (rec.posTopupSignature == null && rec.pendingTopupData == null) {
                    return res.status(200).json({ success: true, idempotent: true, state: rec.state }).end();
                }
                return res.status(409).json({ success: false, error: `Session not awaiting topup auth (state=${rec.state})` }).end();
            }
            if (!rec.pendingTopupCardAddr || !rec.pendingTopupData ||
                rec.pendingTopupDeadline == null || !rec.pendingTopupNonce) {
                return res.status(409).json({ success: false, error: 'Session has no pending topup payload' }).end();
            }
            if (!rec.pos || !ethers_1.ethers.isAddress(rec.pos)) {
                return res.status(409).json({ success: false, error: 'Session has no POS operator bound' }).end();
            }
            const dataBytes = ethers_1.ethers.getBytes(rec.pendingTopupData);
            const dataHash = ethers_1.ethers.keccak256(dataBytes);
            let verifyingContract;
            try {
                const fromSession = rec.pendingTopupVerifyingContract != null &&
                    String(rec.pendingTopupVerifyingContract).trim() !== '' &&
                    ethers_1.ethers.isAddress(String(rec.pendingTopupVerifyingContract).trim())
                    ? ethers_1.ethers.getAddress(String(rec.pendingTopupVerifyingContract).trim())
                    : null;
                verifyingContract =
                    fromSession ?? (await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(rec.pendingTopupCardAddr));
            }
            catch (vcErr) {
                return res
                    .status(409)
                    .json({ success: false, error: `EIP-712 factory gateway: ${vcErr?.message ?? String(vcErr)}` })
                    .end();
            }
            const domain = {
                name: 'BeamioUserCardFactory',
                version: '1',
                chainId: MASTER_BASE_CHAIN_ID,
                verifyingContract,
            };
            const types = {
                ExecuteForAdmin: [
                    { name: 'cardAddress', type: 'address' },
                    { name: 'dataHash', type: 'bytes32' },
                    { name: 'deadline', type: 'uint256' },
                    { name: 'nonce', type: 'bytes32' },
                ],
            };
            const nonceHex = rec.pendingTopupNonce.startsWith('0x') ? rec.pendingTopupNonce : '0x' + rec.pendingTopupNonce;
            const message = {
                cardAddress: ethers_1.ethers.getAddress(rec.pendingTopupCardAddr),
                dataHash,
                deadline: BigInt(rec.pendingTopupDeadline),
                nonce: nonceHex,
            };
            let signer;
            try {
                const digest = ethers_1.ethers.TypedDataEncoder.hash(domain, types, message);
                signer = ethers_1.ethers.recoverAddress(digest, sigNorm);
            }
            catch (err) {
                return res.status(400).json({ success: false, error: `EIP-712 recover failed: ${err?.shortMessage ?? err?.message ?? String(err)}` }).end();
            }
            if (!signer || !ethers_1.ethers.isAddress(signer)) {
                return res.status(400).json({ success: false, error: 'EIP-712 recover returned invalid address' }).end();
            }
            if (signer.toLowerCase() !== rec.pos.toLowerCase()) {
                (0, logger_1.logger)(safe_1.default.red(`[nfcUsdcChargeTopupAuth] signer mismatch sid=${sidNorm.slice(0, 8)}… expected=${rec.pos} got=${signer}`));
                return res.status(401).json({ success: false, error: 'Signature does not recover to bound POS operator', expectedPos: rec.pos, recoveredSigner: signer }).end();
            }
            const now = Date.now();
            masterChargeSessions.set(sidNorm, { ...rec, posTopupSignature: sigNorm, updatedAt: now });
            (0, logger_1.logger)(safe_1.default.green(`[nfcUsdcChargeTopupAuth] sid=${sidNorm.slice(0, 8)}… POS sig accepted signer=${signer}`));
            return res.status(200).json({ success: true, sid: sidNorm, signer }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[nfcUsdcChargeTopupAuth] ${err?.message ?? err}`));
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: err?.message ?? String(err) }).end();
            }
        }
    });
    /** POST /api/nfcUsdcCharge —— x402 NFC USDC Charge Master 端
     * Cluster 已完成：
     *   - SUN 校验（确认 NFC 卡确实在 POS 现场）
     *   - card.owner() == cardOwner 一致性
     *   - x402 verify + settle USDC（transferWithAuthorization → cardOwner）
     * Master 在此处：
     *   - 仅做记账日志（charge 是顾客付款给商家，不需要 mintPointsByAdmin / ExecuteForAdmin）
     *   - 与 NFC charge 字段同步（subtotal/discount/tax/tip/currency），便于商家端报表对齐
     * 未来若需要为 NFC 卡持有人发 loyalty points（earn-on-charge），可在此基于 nfcTopupPreparePayload + signExecuteForAdminWithServiceAdmin 扩展。
     */
    router.post('/nfcUsdcCharge', async (req, res) => {
        const { cardAddr, cardOwner, nfcUid, nfcTagIdHex, nfcRecipientEOA, currency, subtotalCurrencyAmount, discountAmountFiat6, discountRateBps, taxAmountFiat6, taxRateBps, tipCurrencyAmount, tipRateBps, totalCurrencyAmount, usdcAmount6, USDC_tx, payer, } = req.body;
        try {
            if (!cardAddr || !ethers_1.ethers.isAddress(cardAddr)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardAddr' }).end();
            }
            if (!cardOwner || !ethers_1.ethers.isAddress(cardOwner)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardOwner' }).end();
            }
            const cardAddrNorm = ethers_1.ethers.getAddress(cardAddr);
            const cardOwnerNorm = ethers_1.ethers.getAddress(cardOwner);
            const cur = String(currency ?? 'CAD').toUpperCase();
            (0, logger_1.logger)(safe_1.default.green(`[nfcUsdcCharge] OK card=${cardAddrNorm} cardOwner=${cardOwnerNorm} ` +
                `USDC_tx=${USDC_tx ?? 'n/a'} payer=${payer ?? 'n/a'} usdc6=${usdcAmount6 ?? 'n/a'} ` +
                `currency=${cur} subtotal=${subtotalCurrencyAmount ?? '0'} discountE6=${discountAmountFiat6 ?? '0'}` +
                `(${discountRateBps ?? 0}bps) taxE6=${taxAmountFiat6 ?? '0'}(${taxRateBps ?? 0}bps) ` +
                `tip=${tipCurrencyAmount ?? '0'}(${tipRateBps ?? 0}bps) total=${totalCurrencyAmount ?? '0'} ` +
                `nfcUid=${nfcUid ?? 'n/a'} nfcTagId=${nfcTagIdHex ? nfcTagIdHex.slice(0, 8) + '…' : 'n/a'} ` +
                `nfcRecipient=${nfcRecipientEOA ?? 'n/a'}`));
            return res.status(200).json({
                success: true,
                cardAddress: cardAddrNorm,
                cardOwner: cardOwnerNorm,
                currency: cur,
                totalCurrencyAmount: totalCurrencyAmount ?? null,
                usdcAmount6: usdcAmount6 ?? null,
                USDC_tx: USDC_tx ?? null,
                payer: payer ?? null,
                nfcUid: nfcUid ?? null,
            }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[nfcUsdcCharge] master error: ${err?.message ?? err}`));
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: err?.message ?? String(err) }).end();
            }
        }
    });
    /** POST /api/tokenTransferRawSig
     * Generic EIP-3009 relay for USDC/CADD transferWithAuthorization.
     * Used by cluster for non-x402 settle paths (e.g. CADD QR pay) before continuing topup/charge flows.
     */
    router.post('/tokenTransferRawSig', async (req, res) => {
        const { paymentToken, cardOwner, payer, value, validAfter, validBefore, nonce, permitDeadline, permitNonce, signature, } = (req.body ?? {});
        try {
            const tokenSym = String(paymentToken ?? 'USDC').trim().toUpperCase();
            const tokenMap = {
                USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                CADD: '0x16F93eBC5320C89EfC8701577efe49d14A276a06',
            };
            const tokenAddress = tokenMap[tokenSym];
            if (!tokenAddress) {
                return res.status(400).json({ success: false, error: `Unsupported paymentToken: ${tokenSym}` }).end();
            }
            if (!cardOwner || !ethers_1.ethers.isAddress(cardOwner)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardOwner' }).end();
            }
            if (!payer || !ethers_1.ethers.isAddress(payer)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid payer' }).end();
            }
            if (!value || !/^\d+$/.test(String(value)) || BigInt(String(value)) <= 0n) {
                return res.status(400).json({ success: false, error: 'Missing or invalid value' }).end();
            }
            if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
                return res.status(400).json({ success: false, error: 'Invalid signature (expect 0x-prefixed 65-byte hex)' }).end();
            }
            const payerNorm = ethers_1.ethers.getAddress(payer);
            const cardOwnerNorm = ethers_1.ethers.getAddress(cardOwner);
            const valueBig = BigInt(String(value));
            const pk = util_1.masterSetup.settle_contractAdmin?.[0];
            if (!pk) {
                return res.status(500).json({ success: false, error: 'Service admin Base signer not configured (masterSetup.settle_contractAdmin[0])' }).end();
            }
            const provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
            const wallet = new ethers_1.ethers.Wallet(pk, provider);
            const token = new ethers_1.ethers.Contract(tokenAddress, [
                'function name() view returns (string)',
                'function version() view returns (string)',
                'function nonces(address) view returns (uint256)',
                'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
                'function transferFrom(address from, address to, uint256 value) returns (bool)',
                'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
            ], wallet);
            let domainName = tokenSym;
            let domainVersion = '1';
            try {
                const n = await token.name();
                if (typeof n === 'string' && n.trim())
                    domainName = n.trim();
            }
            catch {
                /* fallback */
            }
            try {
                const v = await token.version();
                if (typeof v === 'string' && v.trim())
                    domainVersion = v.trim();
            }
            catch {
                /* fallback */
            }
            const DOMAIN = {
                name: domainName,
                version: domainVersion,
                chainId: MASTER_BASE_CHAIN_ID,
                verifyingContract: ethers_1.ethers.getAddress(tokenAddress),
            };
            let txHash = null;
            if (tokenSym === 'CADD') {
                const permitDeadlineBig = BigInt(permitDeadline ?? '0');
                const permitNonceBig = BigInt(permitNonce ?? '0');
                const nowSec = BigInt(Math.floor(Date.now() / 1000));
                if (permitDeadlineBig <= nowSec) {
                    return res.status(400).json({ success: false, error: `Permit expired (deadline=${permitDeadlineBig} <= now=${nowSec})` }).end();
                }
                const spender = ethers_1.ethers.getAddress(wallet.address);
                const permitTypes = {
                    Permit: [
                        { name: 'owner', type: 'address' },
                        { name: 'spender', type: 'address' },
                        { name: 'value', type: 'uint256' },
                        { name: 'nonce', type: 'uint256' },
                        { name: 'deadline', type: 'uint256' },
                    ],
                };
                const permitMsg = {
                    owner: payerNorm,
                    spender,
                    value: valueBig,
                    nonce: permitNonceBig,
                    deadline: permitDeadlineBig,
                };
                let recovered;
                try {
                    recovered = ethers_1.ethers.verifyTypedData(DOMAIN, permitTypes, permitMsg, signature);
                }
                catch (sigErr) {
                    return res.status(400).json({ success: false, error: `Permit signature recovery failed: ${sigErr?.message ?? sigErr}` }).end();
                }
                if (ethers_1.ethers.getAddress(recovered) !== payerNorm) {
                    return res.status(400).json({ success: false, error: `Permit signer mismatch (recovered=${recovered}, payer=${payerNorm})` }).end();
                }
                try {
                    const nonceOnChain = await token.nonces(payerNorm);
                    if (BigInt(nonceOnChain) !== permitNonceBig) {
                        return res.status(400).json({ success: false, error: `Permit nonce mismatch (onchain=${nonceOnChain.toString()}, signed=${permitNonceBig.toString()})` }).end();
                    }
                }
                catch {
                    /* ignore strict nonce check failure */
                }
                try {
                    const sig = ethers_1.ethers.Signature.from(signature);
                    const txPermit = await token.permit(payerNorm, spender, valueBig, permitDeadlineBig, sig.v, sig.r, sig.s);
                    const permitRcpt = await txPermit.wait(1);
                    if (!permitRcpt || permitRcpt.status !== 1) {
                        return res.status(502).json({ success: false, error: `CADD permit reverted on-chain (tx=${txPermit.hash})`, txHash: txPermit.hash }).end();
                    }
                    const txTransfer = await token.transferFrom(payerNorm, cardOwnerNorm, valueBig);
                    txHash = txTransfer.hash;
                    const rcpt = await txTransfer.wait(1);
                    if (!rcpt || rcpt.status !== 1) {
                        return res.status(502).json({ success: false, error: `CADD transferFrom reverted on-chain (tx=${txHash})`, txHash }).end();
                    }
                }
                catch (txErr) {
                    const msg = txErr?.shortMessage ?? txErr?.message ?? String(txErr);
                    return res.status(502).json({ success: false, error: `CADD permit/transferFrom failed: ${msg}` }).end();
                }
            }
            else {
                if (!nonce || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
                    return res.status(400).json({ success: false, error: 'Invalid nonce (expect 0x-prefixed 32-byte hex)' }).end();
                }
                const validAfterBig = BigInt(validAfter ?? '0');
                const validBeforeBig = BigInt(validBefore ?? '0');
                const nowSec = BigInt(Math.floor(Date.now() / 1000));
                const TIME_TOLERANCE = 300n;
                if (validBeforeBig <= nowSec) {
                    return res.status(400).json({ success: false, error: `Authorization expired (validBefore=${validBeforeBig} <= now=${nowSec})` }).end();
                }
                if (validAfterBig > nowSec + TIME_TOLERANCE) {
                    return res.status(400).json({ success: false, error: `Authorization not yet valid (validAfter=${validAfterBig} > now=${nowSec})` }).end();
                }
                const authTypes = {
                    TransferWithAuthorization: [
                        { name: 'from', type: 'address' },
                        { name: 'to', type: 'address' },
                        { name: 'value', type: 'uint256' },
                        { name: 'validAfter', type: 'uint256' },
                        { name: 'validBefore', type: 'uint256' },
                        { name: 'nonce', type: 'bytes32' },
                    ],
                };
                const authMsg = {
                    from: payerNorm,
                    to: cardOwnerNorm,
                    value: valueBig,
                    validAfter: validAfterBig,
                    validBefore: validBeforeBig,
                    nonce: nonce,
                };
                let recovered;
                try {
                    recovered = ethers_1.ethers.verifyTypedData(DOMAIN, authTypes, authMsg, signature);
                }
                catch (sigErr) {
                    return res.status(400).json({ success: false, error: `Signature recovery failed: ${sigErr?.message ?? sigErr}` }).end();
                }
                if (ethers_1.ethers.getAddress(recovered) !== payerNorm) {
                    return res.status(400).json({ success: false, error: `EIP-3009 signer mismatch (recovered=${recovered}, payer=${payerNorm})` }).end();
                }
                try {
                    const tx = await token.transferWithAuthorization(payerNorm, cardOwnerNorm, valueBig, validAfterBig, validBeforeBig, nonce, signature);
                    txHash = tx.hash;
                    const rcpt = await tx.wait(1);
                    if (!rcpt || rcpt.status !== 1) {
                        return res.status(502).json({ success: false, error: `${tokenSym} transferWithAuthorization reverted on-chain (tx=${txHash})`, txHash }).end();
                    }
                }
                catch (txErr) {
                    const msg = txErr?.shortMessage ?? txErr?.message ?? String(txErr);
                    return res.status(502).json({ success: false, error: `${tokenSym} transferWithAuthorization failed: ${msg}` }).end();
                }
            }
            return res.status(200).json({
                success: true,
                paymentToken: tokenSym,
                payer: payerNorm,
                txHash,
                transaction: txHash,
                USDC_tx: txHash,
                usdcAmount6: valueBig.toString(),
            }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[tokenTransferRawSig] ${err?.message ?? err}`));
            return res.status(500).json({ success: false, error: err?.message ?? String(err) }).end();
        }
    });
    /** POST /api/usdcChargeRawSig —— WC v2 / 任意第三方钱包 raw EIP-3009 sig USDC@Base 直发
     *
     * 与 `/api/nfcUsdcCharge`（x402 路径）的关键区别：
     *   - 调用方（POS）已经从顾客钱包拿到完整 transferWithAuthorization (from,to,value,validAfter,validBefore,nonce,signature)；
     *     Master 这里**不走 x402 facilitator**、**不调 settle()**，直接用 service-admin EOA 在 Base 上提交 USDC 合约的
     *     `transferWithAuthorization(...)`。USDC 合约自己会做 EIP-712 校验 + nonce 防重放，所以即便我们自己也复算一次
     *     ECDSA 仅作为 fast-fail（避免烧白 gas）。
     *   - **不触发 orchestrator 双腿 topup→charge / mintPointsByAdmin** —— 第三方钱包顾客没有 BeamioTag 卡，没有 loyalty
     *     points 受益人；硬塞 `_requirePointsMintAllowsFirstMembership` 会撞 first-membership tier 阈值（< $10 Base tier 必 revert）。
     *     这里 settle 完成即视为终态：商户卡 owner EOA 直接收 USDC，记账落库，session → success。
     *
     * Cluster 端 `POST /api/nfcUsdcChargeRawSig` 已完成：sid 合法性、card.owner() / currency() / isAdmin(pos) 链上权威读、
     * breakdown 归一化、Oracle USDC 报价（usdcAmount6 = expected min）。Master 这里仅做：sig 复算 → 链上提交 → 记账 → 200。
     */
    router.post('/usdcChargeRawSig', async (req, res) => {
        const { cardAddress, cardOwner, pos, sid, currency, totalCurrencyAmount, subtotalCurrencyAmount, discountAmountFiat6, discountRateBps, taxAmountFiat6, taxRateBps, tipCurrencyAmount, tipRateBps, usdcAmount6, paymentToken, payer, validAfter, validBefore, nonce, signature, } = (req.body ?? {});
        try {
            if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardAddress' }).end();
            }
            if (!cardOwner || !ethers_1.ethers.isAddress(cardOwner)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid cardOwner' }).end();
            }
            if (!payer || !ethers_1.ethers.isAddress(payer)) {
                return res.status(400).json({ success: false, error: 'Missing or invalid payer (EIP-3009 from)' }).end();
            }
            if (!usdcAmount6 || !/^\d+$/.test(usdcAmount6) || BigInt(usdcAmount6) <= 0n) {
                return res.status(400).json({ success: false, error: 'Missing or invalid usdcAmount6 (expect positive uint256 decimal string)' }).end();
            }
            if (!nonce || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
                return res.status(400).json({ success: false, error: 'Invalid nonce (expect 0x-prefixed 32-byte hex)' }).end();
            }
            if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
                return res.status(400).json({ success: false, error: 'Invalid signature (expect 0x-prefixed 65-byte hex)' }).end();
            }
            const validAfterBig = BigInt(validAfter ?? '0');
            const validBeforeBig = BigInt(validBefore ?? '0');
            const nowSec = BigInt(Math.floor(Date.now() / 1000));
            const TIME_TOLERANCE = 300n;
            if (validBeforeBig <= nowSec) {
                return res.status(400).json({ success: false, error: `Authorization expired (validBefore=${validBeforeBig} <= now=${nowSec})` }).end();
            }
            if (validAfterBig > nowSec + TIME_TOLERANCE) {
                return res.status(400).json({ success: false, error: `Authorization not yet valid (validAfter=${validAfterBig} > now=${nowSec})` }).end();
            }
            const cardAddressNorm = ethers_1.ethers.getAddress(cardAddress);
            const cardOwnerNorm = ethers_1.ethers.getAddress(cardOwner);
            const payerNorm = ethers_1.ethers.getAddress(payer);
            const valueBig = BigInt(usdcAmount6);
            const cur = String(currency ?? 'CAD').toUpperCase();
            const paymentTokenNorm = (() => {
                const t = String(paymentToken ?? '').trim().toUpperCase();
                if (t === 'USDC' || t === 'CADD')
                    return t;
                return cur === 'CADD' ? 'CADD' : 'USDC';
            })();
            const sidNorm = typeof sid === 'string' && sid.trim().length > 0 ? sid.trim() : null;
            const posNorm = typeof pos === 'string' && ethers_1.ethers.isAddress(pos) ? ethers_1.ethers.getAddress(pos) : null;
            // fast-fail：本地 ECDSA 复算 EIP-712 TransferWithAuthorization；与支付 token 合约同 domain/types。
            // 复算失败 ⇒ 不烧 gas、直接 400；复算通过 ⇒ 链上 USDC 合约会再校验一次（nonce 防重放只能在链上做）。
            const tokenMap = {
                USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                CADD: '0x16F93eBC5320C89EfC8701577efe49d14A276a06',
            };
            const tokenAddress = tokenMap[paymentTokenNorm];
            if (!tokenAddress) {
                return res.status(400).json({ success: false, error: `Unsupported paymentToken: ${paymentTokenNorm}` }).end();
            }
            const TRANSFER_WITH_AUTH_TYPES = {
                TransferWithAuthorization: [
                    { name: 'from', type: 'address' },
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'validAfter', type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' },
                    { name: 'nonce', type: 'bytes32' },
                ],
            };
            const message = {
                from: payerNorm,
                to: cardOwnerNorm,
                value: valueBig,
                validAfter: validAfterBig,
                validBefore: validBeforeBig,
                nonce: nonce,
            };
            const provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
            const eip712Read = new ethers_1.ethers.Contract(tokenAddress, ['function name() view returns (string)', 'function version() view returns (string)'], provider);
            let domainName = paymentTokenNorm;
            let domainVersion = '1';
            try {
                const n = await eip712Read.name();
                if (typeof n === 'string' && n.trim())
                    domainName = n.trim();
            }
            catch {
                /* fallback */
            }
            try {
                const v = await eip712Read.version();
                if (typeof v === 'string' && v.trim())
                    domainVersion = v.trim();
            }
            catch {
                /* fallback */
            }
            const TOKEN_EIP712_DOMAIN = {
                name: domainName,
                version: domainVersion,
                chainId: MASTER_BASE_CHAIN_ID,
                verifyingContract: ethers_1.ethers.getAddress(tokenAddress),
            };
            let recovered;
            try {
                recovered = ethers_1.ethers.verifyTypedData(TOKEN_EIP712_DOMAIN, TRANSFER_WITH_AUTH_TYPES, message, signature);
            }
            catch (sigErr) {
                (0, logger_1.logger)(safe_1.default.yellow(`[usdcChargeRawSig] sig recover threw: ${sigErr?.message ?? sigErr}`));
                return res.status(400).json({ success: false, error: 'Signature recovery failed (malformed sig)' }).end();
            }
            if (ethers_1.ethers.getAddress(recovered) !== payerNorm) {
                (0, logger_1.logger)(safe_1.default.yellow(`[usdcChargeRawSig] sig signer ${recovered} != payer ${payerNorm} (card=${cardAddressNorm.slice(0, 10)}…)`));
                return res.status(400).json({ success: false, error: `EIP-3009 signer mismatch (recovered=${recovered}, payer=${payerNorm})` }).end();
            }
            const pk = util_1.masterSetup.settle_contractAdmin?.[0];
            if (!pk) {
                return res.status(500).json({ success: false, error: 'Service admin Base signer not configured (masterSetup.settle_contractAdmin[0])' }).end();
            }
            const wallet = new ethers_1.ethers.Wallet(pk, provider);
            const usdcAbi = [
                'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
            ];
            const usdc = new ethers_1.ethers.Contract(tokenAddress, usdcAbi, wallet);
            let txHash = null;
            let blockNumber = null;
            try {
                const tx = await usdc.transferWithAuthorization(payerNorm, cardOwnerNorm, valueBig, validAfterBig, validBeforeBig, nonce, signature);
                txHash = tx.hash;
                (0, logger_1.logger)(safe_1.default.cyan(`[usdcChargeRawSig] submit tx=${txHash} card=${cardAddressNorm.slice(0, 10)}… payer=${payerNorm.slice(0, 10)}… ` +
                    `cardOwner=${cardOwnerNorm.slice(0, 10)}… value6=${valueBig.toString()} sid=${sidNorm ?? 'n/a'}`));
                const rcpt = await tx.wait(1);
                blockNumber = rcpt?.blockNumber ?? null;
                if (!rcpt || rcpt.status !== 1) {
                    (0, logger_1.logger)(safe_1.default.red(`[usdcChargeRawSig] tx reverted on-chain status=${rcpt?.status} hash=${txHash}`));
                    return res.status(502).json({ success: false, error: `USDC transferWithAuthorization reverted on-chain (tx=${txHash})`, USDC_tx: txHash }).end();
                }
            }
            catch (txErr) {
                const msg = txErr?.shortMessage ?? txErr?.message ?? String(txErr);
                (0, logger_1.logger)(safe_1.default.red(`[usdcChargeRawSig] submit tx failed: ${msg}`));
                return res.status(502).json({ success: false, error: `USDC transferWithAuthorization failed: ${msg}` }).end();
            }
            (0, logger_1.logger)(safe_1.default.green(`[usdcChargeRawSig] OK card=${cardAddressNorm} cardOwner=${cardOwnerNorm} pos=${posNorm ? posNorm.slice(0, 10) + '…' : '(none)'} ` +
                `USDC_tx=${txHash} payer=${payerNorm} usdc6=${valueBig.toString()} block=${blockNumber} ` +
                `currency=${cur} subtotal=${subtotalCurrencyAmount ?? '0'} discountE6=${discountAmountFiat6 ?? '0'}` +
                `(${discountRateBps ?? 0}bps) taxE6=${taxAmountFiat6 ?? '0'}(${taxRateBps ?? 0}bps) ` +
                `tip=${tipCurrencyAmount ?? '0'}(${tipRateBps ?? 0}bps) total=${totalCurrencyAmount ?? '0'} ` +
                `sid=${sidNorm ?? 'n/a'} mode=raw-sig (no orchestrator)`));
            // PR (USDC settle 独立记账)：raw-sig 路径不走 orchestrator（无 L1 topup / L2 charge 行），
            // 唯一的 ledger 行就是这条 USDC settle 行。fire-and-forget enqueue（同 cluster /api/nfcUsdcCharge 路径）。
            // helper 内部走 localhost POST `/api/beamioTransferIndexerAccounting` —— 即便我们已在 Master 进程内，
            // 也保持同一条 enqueue 路径（含 currency/from-to 预检）以避免重复实现校验逻辑。
            if (txHash) {
                void (0, util_1.submitUsdcChargeSettleIndexer)({
                    payer: payerNorm,
                    cardOwner: cardOwnerNorm,
                    cardAddress: cardAddressNorm,
                    posOperator: posNorm,
                    sid: sidNorm,
                    currency: cur,
                    subtotalCurrencyAmount: typeof subtotalCurrencyAmount === 'string' && subtotalCurrencyAmount.trim()
                        ? subtotalCurrencyAmount
                        : (totalCurrencyAmount ?? '0'),
                    totalCurrencyAmount: typeof totalCurrencyAmount === 'string' && totalCurrencyAmount.trim()
                        ? totalCurrencyAmount
                        : ethers_1.ethers.formatUnits(valueBig, 6),
                    discountAmountFiat6: typeof discountAmountFiat6 === 'string' ? discountAmountFiat6 : '0',
                    discountRateBps: Number(discountRateBps ?? 0),
                    taxAmountFiat6: typeof taxAmountFiat6 === 'string' ? taxAmountFiat6 : '0',
                    taxRateBps: Number(taxRateBps ?? 0),
                    tipCurrencyAmount: typeof tipCurrencyAmount === 'string' ? tipCurrencyAmount : '0',
                    tipRateBps: Number(tipRateBps ?? 0),
                    usdcTxHash: txHash,
                    usdcAmount6: valueBig,
                }).catch((err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    (0, logger_1.logger)(safe_1.default.yellow(`[usdcChargeRawSig] USDC settle indexer enqueue failed (non-critical): ${msg}`));
                });
            }
            return res.status(200).json({
                success: true,
                cardAddress: cardAddressNorm,
                cardOwner: cardOwnerNorm,
                pos: posNorm,
                currency: cur,
                totalCurrencyAmount: totalCurrencyAmount ?? null,
                usdcAmount6: valueBig.toString(),
                USDC_tx: txHash,
                blockNumber,
                payer: payerNorm,
                sid: sidNorm,
            }).end();
        }
        catch (err) {
            (0, logger_1.logger)(safe_1.default.red(`[usdcChargeRawSig] master error: ${err?.message ?? err}`));
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: err?.message ?? String(err) }).end();
            }
        }
    });
    /**
     * Merchant kit Stripe — Master 单进程持有会话 map（Cluster 预检后 postLocalhost 至此处）。
     * body: `{ walletAddress, packageType }`
     */
    router.post('/merchantKitStripe/createSession', async (req, res) => {
        const { walletAddress, packageType } = req.body ?? {};
        if (!walletAddress || typeof packageType !== 'string') {
            return res.status(400).json({ error: 'walletAddress and packageType required' }).end();
        }
        if (!ethers_1.ethers.isAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid walletAddress' }).end();
        }
        const out = await (0, merchantKitStripe_1.createMerchantKitCheckoutSession)(walletAddress, packageType);
        if ('error' in out) {
            (0, logger_1.logger)(safe_1.default.red('[merchantKitStripe] createSession HTTP 400 (master)'), walletAddress, out.error);
            return res.status(400).json({ error: out.error }).end();
        }
        return res.status(200).json({ url: out.url, sessionId: out.sessionId }).end();
    });
    router.post('/merchantKitStripe/poll', async (req, res) => {
        const { sessionId, userClosedCheckout } = req.body ?? {};
        if (!sessionId || typeof sessionId !== 'string') {
            return res.status(400).json({ error: 'sessionId required' }).end();
        }
        const closed = Boolean(userClosedCheckout);
        await (0, merchantKitStripe_1.refreshMerchantKitSessionFromStripe)(sessionId, {
            treatOpenUnpaidAsAbandoned: closed,
        });
        const st = (0, merchantKitStripe_1.getMerchantKitSessionStatus)(sessionId);
        if (!st) {
            (0, logger_1.logger)(safe_1.default.yellow('[merchantKitStripe] poll 404 unknown session (master)'), sessionId);
            return res.status(404).json({ error: 'Unknown session' }).end();
        }
        const pollVerbose = closed ||
            process.env.MERCHANT_KIT_STRIPE_DEBUG === '1' ||
            process.env.MERCHANT_KIT_STRIPE_DEBUG === 'true';
        if (pollVerbose) {
            (0, logger_1.logger)(safe_1.default.cyan('[merchantKitStripe] poll → (master)'), (0, node_util_1.inspect)({
                sessionId,
                userClosedCheckout: closed,
                status: st.status,
                packageType: st.packageType,
                lastEvent: st.lastEvent,
            }, false, 2, true));
        }
        return res.status(200).json({
            status: st.status,
            packageType: st.packageType,
            eoaAddress: st.eoaAddress,
            lastEvent: st.lastEvent,
            chainFulfillment: st.chainFulfillment ?? null,
        }).end();
    });
    /**
     * Stripe Crypto Onramp → Stripe 把 Base 原生 USDC 直转用户 EOA。
     * Master 创建 Onramp session + 读状态；不占用 Settle_BasePool，不发 USDC.transfer。
     * body: `{ walletAddress, amountUsdc6 }`（6 位定点，最低 1 USDC）
     */
    router.post('/eoaUsdcStripe/createSession', async (req, res) => {
        const { walletAddress, amountUsdc6 } = req.body ?? {};
        if (!walletAddress) {
            return res.status(400).json({ error: 'walletAddress required' }).end();
        }
        if (!ethers_1.ethers.isAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid walletAddress' }).end();
        }
        const out = await (0, eoaUsdcStripe_1.createEoaUsdcStripeCheckoutSession)(walletAddress, amountUsdc6);
        if ('error' in out) {
            (0, logger_1.logger)(safe_1.default.red('[eoaUsdcStripe] createSession HTTP 400 (master)'), walletAddress, out.error);
            return res.status(400).json({ error: out.error }).end();
        }
        return res.status(200).json({ url: out.url, sessionId: out.sessionId }).end();
    });
    router.post('/eoaUsdcStripe/poll', async (req, res) => {
        const { sessionId, userClosedCheckout } = req.body ?? {};
        if (!sessionId || typeof sessionId !== 'string') {
            return res.status(400).json({ error: 'sessionId required' }).end();
        }
        const closed = Boolean(userClosedCheckout);
        await (0, eoaUsdcStripe_1.refreshEoaUsdcStripeSessionFromStripe)(sessionId, {
            treatOpenUnpaidAsAbandoned: closed,
        });
        const st = (0, eoaUsdcStripe_1.getEoaUsdcStripeSessionStatus)(sessionId);
        if (!st) {
            (0, logger_1.logger)(safe_1.default.yellow('[eoaUsdcStripe] poll 404 unknown session (master)'), sessionId);
            return res.status(404).json({ error: 'Unknown session' }).end();
        }
        return res.status(200).json({
            status: st.status,
            walletAddress: st.walletAddress,
            amountUsdc6: st.amountUsdc6,
            lastEvent: st.lastEvent,
            chainFulfillment: st.chainFulfillment ?? null,
        }).end();
    });
};
const initialize = async (reactBuildFolder, PORT) => {
    console.log('🔧 Initialize called with PORT:', PORT, 'reactBuildFolder:', reactBuildFolder);
    (0, util_1.oracleBackoud)();
    const defaultPath = (0, node_path_1.join)(__dirname, 'workers');
    console.log('📁 defaultPath:', defaultPath);
    const userDataPath = reactBuildFolder;
    const updatedPath = (0, node_path_1.join)(userDataPath, 'workers');
    console.log('📁 updatedPath:', updatedPath);
    let staticFolder = node_fs_1.default.existsSync(updatedPath) ? updatedPath : defaultPath;
    (0, logger_1.logger)(`staticFolder = ${staticFolder}`);
    console.log('📁 staticFolder:', staticFolder);
    const isProd = process.env.NODE_ENV === "production";
    const app = (0, express_1.default)();
    app.set("trust proxy", true);
    const handleStripeBeamioWebhookPost = async (req, res, routeTag) => {
        const ip = (0, util_1.getClientIp)(req);
        const ua = String(req.headers['user-agent'] ?? '').slice(0, 80);
        (0, logger_1.logger)(safe_1.default.cyan(`[${routeTag}] POST (master)`), `ip=${ip || '(none)'}`, `ua=${ua || '(none)'}`);
        const result = await (0, stripeBeamioHook_1.handleStripeBeamioWebhook)(req.body, req.headers['stripe-signature']);
        if (result.ok) {
            (0, logger_1.logger)(safe_1.default.green(`[${routeTag}] response 200 received=true`));
            return res.status(200).json({ received: true }).end();
        }
        (0, logger_1.logger)(safe_1.default.red(`[${routeTag}] response 400`), result.error);
        return res.status(400).send(`Webhook Error: ${result.error}`).end();
    };
    /** 唯一现役 Stripe webhook。旧 path 兼容转发到同一 handler。 */
    app.post('/api/stripeBeamioHook', express_1.default.raw({ type: 'application/json' }), (req, res) => void handleStripeBeamioWebhookPost(req, res, 'stripeBeamioHook'));
    app.post('/api/merchant-kit-stripe-webhook', express_1.default.raw({ type: 'application/json' }), (req, res) => void handleStripeBeamioWebhookPost(req, res, 'merchant-kit-stripe-webhook'));
    app.post('/api/eoa-usdc-stripe-webhook', express_1.default.raw({ type: 'application/json' }), (req, res) => void handleStripeBeamioWebhookPost(req, res, 'eoa-usdc-stripe-webhook'));
    if (!isProd) {
        app.use((req, res, next) => {
            res.setHeader('Access-Control-Allow-Origin', '*'); // 或你的白名单 Origin
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 
            // 允许二跳自定义头；顺手加 Access-Control-Expose-Headers 兜底某些客户端误发到预检
            'Content-Type, Authorization, X-Requested-With, X-PAYMENT, Access-Control-Expose-Headers');
            // 暴露自定义响应头，便于浏览器读取
            res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-PAYMENT-RESPONSE');
            if (req.method === 'OPTIONS')
                return res.sendStatus(204);
            next();
        });
    }
    else {
        app.use((req, _res, next) => {
            if (!req.get('x-forwarded-proto')) {
                req.headers['x-forwarded-proto'] = 'https';
            }
            next();
        });
    }
    // app.use ( express.static ( staticFolder ))
    app.use(express_1.default.json({ limit: '5mb' }));
    const cors = require('cors');
    if (!isProd) {
        // 本地开发才由 Node 处理 CORS（例如直连 http://localhost:4088）
        app.use(/.*/, cors({
            origin: ['http://localhost:4088'],
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: [
                'Content-Type',
                'Authorization',
                'X-Requested-With',
                'X-PAYMENT',
                'Access-Control-Expose-Headers',
            ],
            exposedHeaders: ['X-PAYMENT-RESPONSE'],
            credentials: false,
            optionsSuccessStatus: 204,
            maxAge: 600,
        }));
    }
    const router = express_1.default.Router();
    app.use('/api', router);
    routing(router);
    app.use((err, req, res, next) => {
        // Guard noisy body-parser JSON syntax errors (e.g. multipart/form-data sent as application/json).
        if (err?.type === 'entity.parse.failed' && err instanceof SyntaxError) {
            const ct = String(req.headers['content-type'] ?? '');
            (0, logger_1.logger)(safe_1.default.yellow(`[json-parse] ${req.method} ${req.originalUrl} invalid JSON body; content-type=${ct || '(none)'}`));
            if (!res.headersSent) {
                return res.status(400).json({ success: false, error: 'Invalid JSON body' }).end();
            }
            return;
        }
        next(err);
    });
    (0, logger_1.logger)('Router stack:', router.stack.map(r => r.route?.path));
    (0, logger_1.logger)(`🧭 public router after serverRoute(router)`);
    app.get('/_debug', (req, res) => {
        res.json({
            protocol: req.protocol,
            secure: req.secure,
            host: req.get('host'),
            xfp: req.get('x-forwarded-proto'),
        });
    });
    app.once('error', (err) => {
        (0, logger_1.logger)(err);
        (0, logger_1.logger)(`Local server on ERROR, try restart!`);
        return;
    });
    app.all('/', (req, res) => {
        return res.status(404).end();
    });
    console.log('🚀 Starting express.listen on port:', PORT);
    const server = app.listen(PORT, () => {
        console.log('✅ Server started successfully!');
        console.table([
            { 'x402 Server': `http://localhost:${PORT}`, 'Serving files from': staticFolder }
        ]);
        (0, MemberCard_1.startNfcLinkAppAutoCancelSweeper)();
        startLatestCardsPrewarmTimer();
        (0, gbDepinAirdrop_1.startGbDepinAirdropCron)();
        void (0, excludeUserCardApi_1.warmDynamicApiExcludedUserCardsFromDb)().catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logger)(safe_1.default.red('[initialize] warmDynamicApiExcludedUserCardsFromDb error:'), msg);
        });
        void Promise.all([(0, db_1.ensureAccountRegistryBeamioAdmins)(), (0, db_1.ensureAddressPgpBeamioAdmins)()]).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logger)(safe_1.default.red('[initialize] ensure*BeamioAdmins error:'), msg);
        });
    });
    server.on('error', (err) => {
        console.error('❌ Server error:', err);
    });
    return server;
};
const startMaster = async () => {
    initialize('', masterServerPort);
};
exports.default = startMaster;
