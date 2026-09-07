"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.coinbaseHooks = exports.coinbaseOfframp = exports.coinbaseOnrampSession = exports.coinbaseToken = void 0;
exports.getCDPCredentials = getCDPCredentials;
exports.coinbaseWebhook = coinbaseWebhook;
const auth_1 = require("@coinbase/cdp-sdk/auth");
const util_1 = require("./util");
const node_fetch_1 = __importDefault(require("node-fetch"));
const logger_1 = require("./logger");
const util_2 = require("util");
const ethers_1 = require("ethers");
const node_crypto_1 = __importDefault(require("node:crypto"));
const coinbase_subscription = {
    createdAt: '2025-12-13T21:01:15.542744Z',
    description: 'Beamio Onramp/Offramp transaction status webhook',
    eventTypes: [
        'onramp.transaction.created',
        'onramp.transaction.updated',
        'onramp.transaction.success',
        'onramp.transaction.failed',
        'offramp.transaction.created',
        'offramp.transaction.updated',
        'offramp.transaction.success',
        'offramp.transaction.failed'
    ],
    isEnabled: true,
    labelKey: 'project',
    labelValue: '292c1ff5-e113-49d5-82ae-c7999dab7257',
    labels: { project: '292c1ff5-e113-49d5-82ae-c7999dab7257' },
    subscriptionId: 'ff683cce-069f-49c3-b735-246268a26b22',
    target: { url: 'https://beamio.app/app/coinbase-hooks' }
};
const COINBASE_WEBHOOK_SECRET = util_1.masterSetup.coinbase.secret;
const apiKeyId = util_1.masterSetup.coinbase.CDP_API_KEY_ID;
const apiKeySecret = util_1.masterSetup.coinbase.CDP_API_KEY_SECRET;
// --- 从 eventType 推导状态 ---
function extractStatus(evt) {
    const eventType = (evt.eventType || evt.type || '').toLowerCase();
    const root = evt.data ?? evt.payload?.data ?? evt.event?.data ?? evt.payload ?? evt.event ?? {};
    // 优先取 payload 自带的 status
    const payloadStatus = root?.status ||
        root?.transaction?.status ||
        root?.session?.status;
    if (typeof payloadStatus === 'string' && payloadStatus.length > 0) {
        return payloadStatus;
    }
    // 没有就用事件名推导
    if (eventType.endsWith('.success'))
        return 'success';
    if (eventType.endsWith('.failed'))
        return 'failed';
    if (eventType.endsWith('.created'))
        return 'created';
    if (eventType.endsWith('.updated'))
        return 'updated';
    return 'unknown';
}
// --- 取 eventType ---
function extractEventType(evt) {
    return evt.eventType || evt.type || 'unknown';
}
// --- 取 eventId 做幂等 ---
function extractEventId(evt) {
    return evt.id || evt.eventId || evt.event?.id || evt.payload?.id || null;
}
function verifyCoinbaseWebhook(req, rawBody) {
    if (!COINBASE_WEBHOOK_SECRET) {
        throw new Error('Missing COINBASE_WEBHOOK_SECRET');
    }
    // Coinbase CDP webhooks 常见的签名 header（不同环境/代理可能大小写不同）
    const sigHeader = req.headers['x-hook0-signature'] ||
        req.headers['x-coinbase-signature'] ||
        req.headers['x-webhook-signature'] ||
        '';
    const tsHeader = req.headers['x-hook0-timestamp'] ||
        req.headers['x-coinbase-timestamp'] ||
        req.headers['x-webhook-timestamp'] ||
        '';
    if (!sigHeader) {
        throw new Error('Missing signature header');
    }
    /**
     * 兼容两种常见签名输入：
     * 1) payload-only:    HMAC(secret, rawBody)
     * 2) ts + payload:    HMAC(secret, `${timestamp}.${rawBody}`)
     *
     * 兼容签名 header 形态：
     * - 直接是 hex/base64
     * - 或者 "t=...,v1=...." / "v1=...."
     */
    const parts = sigHeader.split(',').map(s => s.trim());
    let provided = sigHeader.trim();
    for (const p of parts) {
        const [k, v] = p.split('=');
        if (!v)
            continue;
        if (k === 'v1' || k === 'sig' || k === 'signature') {
            provided = v;
            break;
        }
    }
    const msg1 = rawBody;
    const msg2 = tsHeader ? `${tsHeader}.${rawBody}` : '';
    const h1 = node_crypto_1.default.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg1).digest('hex');
    const h2 = msg2
        ? node_crypto_1.default.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg2).digest('hex')
        : '';
    // 有些实现会用 base64，顺便算一份
    const h1b64 = node_crypto_1.default.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg1).digest('base64');
    const h2b64 = msg2
        ? node_crypto_1.default.createHmac('sha256', COINBASE_WEBHOOK_SECRET).update(msg2).digest('base64')
        : '';
    const ok = safeEqual(provided, h1) ||
        safeEqual(provided, h2) ||
        safeEqual(provided, h1b64) ||
        (h2b64 ? safeEqual(provided, h2b64) : false);
    if (!ok) {
        throw new Error('Invalid webhook signature');
    }
}
const ONRAMP_API_BASE_URL = 'https://api.cdp.coinbase.com';
const LEGACY_API_BASE_URL = 'https://api.developer.coinbase.com';
function getCDPCredentials() {
    if (!apiKeyId || !apiKeySecret) {
        throw new Error('CDP API credentials not configured');
    }
    return { apiKeyId, apiKeySecret };
}
// --- 解析 destinationAddress 的“宽松提取器” ---
function extractDestinationAddress(evt) {
    const root = evt.data ?? evt.payload?.data ?? evt.event?.data ?? evt.payload ?? evt.event ?? {};
    const candidates = [
        root?.destinationAddress,
        root?.destination_address,
        root?.transaction?.destinationAddress,
        root?.transaction?.destination_address,
        root?.quote?.destinationAddress,
        root?.quote?.destination_address,
        root?.session?.destinationAddress,
        root?.session?.destination_address,
        root?.details?.destinationAddress,
        root?.details?.destination_address,
    ];
    const addr = candidates.find(v => typeof v === 'string' && v.length > 0);
    return addr || null;
}
async function generateCDPJWT(config) {
    const { apiKeyId, apiKeySecret } = getCDPCredentials();
    return (0, auth_1.generateJwt)({
        apiKeyId,
        apiKeySecret,
        requestMethod: config.requestMethod,
        requestPath: config.requestPath,
        requestHost: config.requestHost,
    });
}
async function createOnrampSession(params) {
    const path = '/platform/v2/onramp/sessions';
    const host = 'api.cdp.coinbase.com';
    const jwt = await generateCDPJWT({
        requestMethod: 'POST',
        requestPath: path,
        requestHost: host,
    });
    const body = {
        purchaseCurrency: 'USDC', // 买 USDC
        destinationNetwork: 'base', // 打到 Base
        destinationAddress: params.destinationAddress,
        // paymentAmount: params.paymentAmount,
        paymentCurrency: 'USD',
        paymentMethod: 'CARD', // CARD / ACH / APPLE_PAY / PAYPAL 等
        country: params.country,
        subdivision: params.subdivision ?? 'CA',
        redirectUrl: 'https://beamio.app/app/onramp-success', // 完成后回调到你
        partnerUserRef: params.partnerUserRef,
    };
    const res = await (0, node_fetch_1.default)(`${ONRAMP_API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const error = await res.text();
        throw new Error(`Onramp session failed: ${res.status} ${error}`);
    }
    const data = await res.json();
    return data;
}
async function createSessionToken({ userAddress, clientIp, }) {
    const path = '/onramp/v1/token';
    const host = 'api.developer.coinbase.com';
    const jwt = await generateCDPJWT({
        requestMethod: 'POST',
        requestPath: path,
        requestHost: host,
    });
    const body = {
        addresses: [
            {
                address: userAddress,
                blockchains: ['base'], // 或 ['ethereum', 'base'] 等
            },
        ],
        assets: ['USDC', 'ETH'], // 这次 session 允许的资产
        clientIp, // 真实 IP，不要随便伪造
    };
    const res = await (0, node_fetch_1.default)(`${LEGACY_API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const error = await res.text();
        throw new Error(`Create session token failed: ${res.status} ${error}`);
    }
    const data = await res.json();
    return data.token; // 这个就是 sessionToken
}
const coinbaseToken = async (req, res) => {
    const clientIp = (0, util_1.getClientIp)(req);
    try {
        const { address, paymentAmount } = req.query;
        if (!address || !ethers_1.ethers.isAddress(address) || address === ethers_1.ethers.ZeroAddress) {
            return res.status(400).json({ error: 'Missing or invalid address' });
        }
        const amount = Number(paymentAmount);
        // 调用上面封装好的 createSessionToken
        const data = await createOnrampSession({
            destinationAddress: address,
            partnerUserRef: `${address}`,
        });
        return res.json({
            onrampUrl: data.session.onrampUrl,
            quote: data.quote ?? null,
        });
    }
    catch (err) {
        console.error('coinbaseToken error:', err);
        return res.status(500).json({ error: 'Failed to create session token' });
    }
};
exports.coinbaseToken = coinbaseToken;
const coinbaseOnrampSession = async (req, res) => {
    try {
        const { address, country, subdivision, paymentAmount, userId } = req.body;
        if (!address || typeof address !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid address' });
        }
        const clientIp = req.headers['cf-connecting-ip'] ||
            req.headers['x-real-ip'] ||
            req.headers['x-forwarded-for']?.split(',')[0].trim() ||
            req.socket.remoteAddress ||
            '';
        const data = await createOnrampSession({
            destinationAddress: address,
            country: country || 'US',
            subdivision: subdivision || 'CA',
            paymentAmount: paymentAmount || '50.00',
            partnerUserRef: userId || `beamio-${address}`,
        });
        // data.session.onrampUrl 就是你要丢给前端打开的 URL
        return res.json({
            onrampUrl: data.session.onrampUrl,
            quote: data.quote ?? null,
            clientIp, // 看情况要不要返回，仅用于调试
        });
    }
    catch (err) {
        console.error('coinbaseOnrampSession error:', err);
        return res.status(500).json({ error: 'Failed to create onramp session' });
    }
};
exports.coinbaseOnrampSession = coinbaseOnrampSession;
// ⭐ 使用 v1 token 生成 sessionToken，再拼 sell/offramp URL
async function createOfframpSessionToken(userAddress, clientIp) {
    const path = '/onramp/v1/token';
    const host = 'api.developer.coinbase.com';
    const jwt = await generateCDPJWT({
        requestMethod: 'POST',
        requestPath: path,
        requestHost: host,
    });
    const body = {
        addresses: [
            {
                address: userAddress,
                blockchains: ['base'],
            },
        ],
        assets: ['USDC'], // 允许卖出的资产
        clientIp, // 真实 IP
    };
    const res = await (0, node_fetch_1.default)(`${LEGACY_API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const error = await res.text();
        throw new Error(`Create session token failed: ${res.status} ${error}`);
    }
    const data = (await res.json());
    return data.token; // sessionToken
}
// GET /api/coinbase-offramp?address=0x...
const coinbaseOfframp = async (req, res) => {
    try {
        const address = req.query.address;
        if (!address) {
            return res.status(400).json({ error: 'Missing address' });
        }
        const clientIp = req.headers['cf-connecting-ip'] ||
            req.headers['x-real-ip'] ||
            req.headers['x-forwarded-for']?.split(',')[0].trim() ||
            req.socket.remoteAddress ||
            '';
        // 1) 生成 sessionToken
        const sessionToken = await createOfframpSessionToken(address, clientIp);
        // 2) 拼 Offramp / Sell URL
        // 文档约定：sell / off-ramp 入口 path 一般类似 /v3/sell/input 或 /buy/select-asset 的变体
        const url = new URL('https://pay.coinbase.com/v3/sell/input');
        url.searchParams.set('sessionToken', sessionToken);
        url.searchParams.set('partnerUserRef', `${address}`);
        url.searchParams.set('defaultNetwork', 'base');
        url.searchParams.set('defaultAsset', 'USDC');
        url.searchParams.set('fiatCurrency', 'USD');
        url.searchParams.set('redirectUrl', 'https://beamio.app/app/offramp/success');
        return res.json({ offrampUrl: url.toString() });
    }
    catch (err) {
        console.error('coinbaseOfframp error:', err);
        return res.status(500).json({ error: 'Failed to create offramp url' });
    }
};
exports.coinbaseOfframp = coinbaseOfframp;
async function coinbaseWebhook() {
    const host = 'api.cdp.coinbase.com';
    const path = '/platform/v2/data/webhooks/subscriptions';
    const jwt = await generateCDPJWT({
        requestMethod: 'POST',
        requestPath: path,
        requestHost: host,
    });
    const body = {
        description: 'Beamio Onramp/Offramp transaction status webhook',
        eventTypes: [
            // Onramp
            'onramp.transaction.created',
            'onramp.transaction.updated',
            'onramp.transaction.success',
            'onramp.transaction.failed',
            // Offramp
            'offramp.transaction.created',
            'offramp.transaction.updated',
            'offramp.transaction.success',
            'offramp.transaction.failed',
        ],
        target: {
            url: 'https://beamio.app/app/coinbase-hooks',
            method: 'POST',
        },
        labels: {},
        isEnabled: true,
    };
    const res = await (0, node_fetch_1.default)(`https://${host}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Create webhook subscription failed: ${res.status} ${err}`);
    }
    const data = await res.json();
    (0, logger_1.logger)(`success `, (0, util_2.inspect)(data, false, 3, true));
    // ⚠️ metadata.secret 会在创建时返回，用于验签；务必保存
    return data;
}
// --- 小工具：安全比较 ---
function safeEqual(a, b) {
    const aa = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (aa.length !== bb.length)
        return false;
    return node_crypto_1.default.timingSafeEqual(aa, bb);
}
// --- 小工具：取 raw body ---
function getRawBody(req) {
    // 因为我们用了 express.raw，所以 req.body 是 Buffer
    if (Buffer.isBuffer(req.body))
        return req.body.toString('utf8');
    // 兜底：如果有人误配成 json parser
    if (typeof req.body === 'string')
        return req.body;
    try {
        return JSON.stringify(req.body ?? {});
    }
    catch {
        return '';
    }
}
const coinbaseHooks = (req, res) => {
    const rawBody = getRawBody(req);
    (0, logger_1.logger)(`coinbaseHooks call`, (0, util_2.inspect)(rawBody, false, 3, true));
    try {
        // 1) 验签
        verifyCoinbaseWebhook(req, rawBody);
        // 2) parse JSON
        const evt = JSON.parse(rawBody);
        const eventId = extractEventId(evt);
        const eventType = extractEventType(evt);
        const destinationAddress = extractDestinationAddress(evt);
        const status = extractStatus(evt);
        // 3) 幂等处理（强烈建议）
        // TODO: 用 eventId 做唯一键，已处理过就直接 200
        // await db.webhookEvents.insertOnce({ eventId, ... })
        // 4) 业务处理：更新你们的订单/流水
        // 推荐：用 destinationAddress + (payload里的 partnerUserRef / transactionId) 去定位订单
        // TODO:
        // await db.onrampOrders.updateByTxOrRef({ ... })
        // 你想直接“获得 destinationAddress 和状态”
        // 这里返回给调用方（Coinbase）必须 200，且尽量快
        // 你自己 debug 可以 log
        console.log('[coinbaseHooks]', {
            eventId,
            eventType,
            destinationAddress,
            status,
        });
        res.status(200).json({
            ok: true,
            eventId,
            eventType,
            destinationAddress,
            status,
        });
        return { destinationAddress, status };
    }
    catch (e) {
        console.error('[coinbaseHooks] error:', e?.message || e);
        // 验签失败一般返回 401
        if ((e?.message || '').includes('signature')) {
            res.status(401).json({ ok: false, error: 'invalid_signature' });
            return null;
        }
        res.status(400).json({ ok: false, error: 'bad_request' });
        return null;
    }
};
exports.coinbaseHooks = coinbaseHooks;
