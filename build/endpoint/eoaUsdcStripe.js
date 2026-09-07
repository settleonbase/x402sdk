"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EOA_USDC_STRIPE_CENTS_UNIT = exports.EOA_USDC_STRIPE_MAX_USDC6 = exports.EOA_USDC_STRIPE_MIN_USDC6 = exports.EOA_USDC_STRIPE_PRODUCT = void 0;
exports.parseEoaUsdcStripeAmountUsdc6 = parseEoaUsdcStripeAmountUsdc6;
exports.createEoaUsdcStripeCheckoutSession = createEoaUsdcStripeCheckoutSession;
exports.getEoaUsdcStripeSessionStatus = getEoaUsdcStripeSessionStatus;
exports.refreshEoaUsdcStripeSessionFromStripe = refreshEoaUsdcStripeSessionFromStripe;
exports.processEoaUsdcStripeEvent = processEoaUsdcStripeEvent;
const node_crypto_1 = require("node:crypto");
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const stripeWalletEoaResolve_1 = require("../stripeWalletEoaResolve");
const stripeBeamio_1 = require("./stripeBeamio");
exports.EOA_USDC_STRIPE_PRODUCT = 'eoaUsdc';
/** 1 USDC = 1_000_000（6 位） */
exports.EOA_USDC_STRIPE_MIN_USDC6 = 1000000n;
/** 安全上限 10,000 USDC */
exports.EOA_USDC_STRIPE_MAX_USDC6 = 10000000000n;
/** Stripe 以分为单位：1 cent = 10_000（6 位） */
exports.EOA_USDC_STRIPE_CENTS_UNIT = 10000n;
const STRIPE_API_BASE = 'https://api.stripe.com';
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function pruneEoaUsdcSessions() {
    const now = Date.now();
    for (const [id, rec] of sessions) {
        if (now - rec.createdAt > SESSION_TTL_MS)
            sessions.delete(id);
    }
}
function scheduleEoaUsdcSessionPrune() {
    const t = setTimeout(() => {
        pruneEoaUsdcSessions();
        scheduleEoaUsdcSessionPrune();
    }, 60 * 60 * 1000);
    t.unref?.();
}
scheduleEoaUsdcSessionPrune();
function eoaUsdcStripeDebugEnabled() {
    const v = (typeof process !== 'undefined' && process.env?.EOA_USDC_STRIPE_DEBUG?.trim()?.toLowerCase()) || '';
    return v === '1' || v === 'true' || v === 'yes';
}
function eoaUsdcDbg(...args) {
    if (eoaUsdcStripeDebugEnabled()) {
        (0, logger_1.logger)(safe_1.default.cyan('[eoaUsdcStripe:debug]'), ...args);
    }
}
function parseEoaUsdcStripeAmountUsdc6(raw) {
    const amountStr = typeof raw === 'number' && Number.isFinite(raw)
        ? String(Math.trunc(raw))
        : typeof raw === 'string'
            ? raw.trim()
            : '';
    if (!/^\d+$/.test(amountStr)) {
        return { ok: false, error: 'amountUsdc6 must be a positive integer string' };
    }
    const amount = BigInt(amountStr);
    if (amount < exports.EOA_USDC_STRIPE_MIN_USDC6) {
        return { ok: false, error: 'Minimum deposit is 1 USDC' };
    }
    if (amount > exports.EOA_USDC_STRIPE_MAX_USDC6) {
        return { ok: false, error: 'Maximum deposit is 10,000 USDC' };
    }
    if (amount % exports.EOA_USDC_STRIPE_CENTS_UNIT !== 0n) {
        return { ok: false, error: 'amountUsdc6 must be a whole USD cent (multiple of 10000)' };
    }
    return { ok: true, amount };
}
function amountUsdc6ToUsdSourceAmount(amountUsdc6) {
    const cents = amountUsdc6 / exports.EOA_USDC_STRIPE_CENTS_UNIT;
    const dollars = cents / 100n;
    const rem = cents % 100n;
    return `${dollars.toString()}.${rem.toString().padStart(2, '0')}`;
}
function getStripeSecretKey() {
    return (0, stripeBeamio_1.getStripeBeamioSecretKey)();
}
function getStripeClient() {
    return (0, stripeBeamio_1.getStripeBeamioClient)();
}
function stripeErrorMessage(payload, fallback) {
    if (payload && typeof payload === 'object') {
        const err = payload.error;
        const nested = typeof err?.message === 'string' ? err.message.trim() : '';
        if (nested)
            return nested;
        const top = payload.message;
        if (typeof top === 'string' && top.trim())
            return top.trim();
    }
    return fallback;
}
function flattenStripeForm(value, prefix = '', out = new URLSearchParams()) {
    if (value === undefined || value === null)
        return out;
    if (Array.isArray(value)) {
        value.forEach((item, i) => flattenStripeForm(item, `${prefix}[${i}]`, out));
        return out;
    }
    if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            flattenStripeForm(v, prefix ? `${prefix}[${k}]` : k, out);
        }
        return out;
    }
    if (!prefix)
        return out;
    out.append(prefix, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
    return out;
}
async function stripeCryptoHttp(method, path, params, idempotencyKey) {
    const key = getStripeSecretKey();
    if (!key) {
        throw new Error('Stripe is not configured');
    }
    const url = new URL(`${STRIPE_API_BASE}${path}`);
    const headers = {
        Authorization: `Bearer ${key}`,
    };
    if (idempotencyKey) {
        headers['Idempotency-Key'] = idempotencyKey;
    }
    let body;
    if (method === 'GET' && params) {
        const form = flattenStripeForm(params);
        form.forEach((v, k) => url.searchParams.append(k, v));
    }
    else if (method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = params ? flattenStripeForm(params).toString() : '';
    }
    const res = await fetch(url, { method, headers, body });
    const json = (await res.json().catch(() => ({})));
    if (!res.ok) {
        throw new Error(stripeErrorMessage(json, `Stripe request failed (${res.status})`));
    }
    return json;
}
function asOnrampSession(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const obj = raw;
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!id)
        return null;
    const metadata = obj.metadata && typeof obj.metadata === 'object'
        ? Object.fromEntries(Object.entries(obj.metadata).map(([k, v]) => [k, String(v ?? '')]))
        : undefined;
    const details = obj.transaction_details && typeof obj.transaction_details === 'object'
        ? obj.transaction_details
        : undefined;
    return {
        id,
        object: typeof obj.object === 'string' ? obj.object : undefined,
        status: typeof obj.status === 'string' ? obj.status : undefined,
        redirect_url: typeof obj.redirect_url === 'string' ? obj.redirect_url : undefined,
        created: typeof obj.created === 'number' ? obj.created : undefined,
        metadata,
        transaction_details: details
            ? {
                transaction_id: typeof details.transaction_id === 'string' ? details.transaction_id : undefined,
                wallet_address: typeof details.wallet_address === 'string' ? details.wallet_address : undefined,
                destination_amount: typeof details.destination_amount === 'string' ? details.destination_amount : undefined,
                destination_currency: typeof details.destination_currency === 'string' ? details.destination_currency : undefined,
                destination_network: typeof details.destination_network === 'string' ? details.destination_network : undefined,
            }
            : undefined,
    };
}
function parseOnchainTxHash(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    return /^0x[0-9a-fA-F]{64}$/.test(s) ? s : undefined;
}
function mapOnrampStatus(stripeStatus) {
    const s = (stripeStatus ?? '').trim().toLowerCase();
    if (s === 'fulfillment_complete')
        return 'succeeded';
    if (s === 'rejected')
        return 'failed';
    return 'pending';
}
function isOnrampOpenUnpaid(stripeStatus) {
    const s = (stripeStatus ?? '').trim().toLowerCase();
    return s === 'initialized' || s === 'requires_payment' || s === '';
}
async function retrieveStripeOnrampSession(sessionId) {
    const stripe = getStripeClient();
    const cryptoApi = stripe
        ? (stripe
            .crypto?.onrampSessions)
        : undefined;
    try {
        if (cryptoApi?.retrieve) {
            return asOnrampSession(await cryptoApi.retrieve(sessionId));
        }
        return asOnrampSession(await stripeCryptoHttp('GET', `/v1/crypto/onramp_sessions/${encodeURIComponent(sessionId)}`));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, logger_1.logger)(safe_1.default.yellow('[eoaUsdcStripe] onramp retrieve failed'), sessionId, msg);
        return null;
    }
}
function stripeThrownMessage(err) {
    if (err && typeof err === 'object') {
        const o = err;
        if (typeof o.message === 'string' && o.message.trim())
            return o.message.trim();
        if (typeof o.raw?.message === 'string' && o.raw.message.trim())
            return o.raw.message.trim();
    }
    return err instanceof Error ? err.message : String(err);
}
function isStripeWalletAddressParamUnknownError(err) {
    const msg = stripeThrownMessage(err).toLowerCase();
    const code = err && typeof err === 'object' ? String(err.code ?? '').toLowerCase() : '';
    const param = err && typeof err === 'object' ? String(err.param ?? '').toLowerCase() : '';
    const mentionsWallet = msg.includes('wallet_address') || param.includes('wallet_address');
    const unknown = code === 'parameter_unknown' ||
        msg.includes('unknown parameter') ||
        msg.includes('parameter_unknown');
    return mentionsWallet && unknown;
}
async function createStripeOnrampSession(params, idempotencyKey) {
    const stripe = getStripeClient();
    const cryptoApi = stripe
        ? (stripe.crypto?.onrampSessions)
        : undefined;
    if (cryptoApi?.create) {
        const created = asOnrampSession(await cryptoApi.create(params, { idempotencyKey }));
        if (!created)
            throw new Error('Stripe Onramp session creation failed');
        return created;
    }
    const created = asOnrampSession(await stripeCryptoHttp('POST', '/v1/crypto/onramp_sessions', params, idempotencyKey));
    if (!created)
        throw new Error('Stripe Onramp session creation failed');
    return created;
}
function applyOnrampSessionToLocal(session, opts) {
    const meta = session.metadata ?? {};
    if (meta.product && meta.product !== exports.EOA_USDC_STRIPE_PRODUCT) {
        return null;
    }
    const prev = sessions.get(session.id);
    const walletNorm = (meta.walletAddress || prev?.walletAddress || '').toLowerCase();
    const amountNorm = meta.amountUsdc6 || prev?.amountUsdc6 || '';
    if (!walletNorm || !amountNorm) {
        return null;
    }
    const createdAt = prev?.createdAt ??
        (typeof session.created === 'number' && session.created > 0 ? session.created * 1000 : Date.now());
    const stripeStatus = session.status ?? '';
    let status = mapOnrampStatus(stripeStatus);
    let lastEvent = opts?.lastEvent || stripeStatus || prev?.lastEvent;
    if (opts?.treatOpenUnpaidAsAbandoned && isOnrampOpenUnpaid(stripeStatus) && status === 'pending') {
        status = 'failed';
        lastEvent = 'abandoned';
    }
    if (prev?.status === 'succeeded' && status !== 'succeeded') {
        status = 'succeeded';
        lastEvent = prev.lastEvent;
    }
    const txHash = parseOnchainTxHash(session.transaction_details?.transaction_id) || prev?.chainFulfillment?.usdcTxHash;
    const recipientFromMeta = meta.recipientEoa?.trim();
    const recipientFromTx = session.transaction_details?.wallet_address?.trim();
    let recipientEoa = prev?.chainFulfillment?.recipientEoa;
    for (const cand of [recipientFromMeta, recipientFromTx]) {
        if (cand && ethers_1.ethers.isAddress(cand)) {
            recipientEoa = ethers_1.ethers.getAddress(cand);
            break;
        }
    }
    const next = {
        status,
        walletAddress: walletNorm,
        amountUsdc6: amountNorm,
        createdAt,
        lastEvent,
        chainFulfillment: {
            ...prev?.chainFulfillment,
            ...(recipientEoa ? { recipientEoa } : {}),
            ...(txHash ? { usdcTxHash: txHash, lastError: undefined } : {}),
        },
    };
    sessions.set(session.id, next);
    return next;
}
function markRetiredCheckoutSession(sessionId) {
    const prev = sessions.get(sessionId);
    if (!prev)
        return null;
    if (prev.status === 'succeeded')
        return prev;
    const next = {
        ...prev,
        status: 'failed',
        lastEvent: 'retired.checkout.session',
        chainFulfillment: {
            ...prev.chainFulfillment,
            lastError: 'This session used the retired card checkout. Start a new Stripe USDC deposit.',
        },
    };
    sessions.set(sessionId, next);
    return next;
}
async function createEoaUsdcStripeCheckoutSession(walletAddress, amountUsdc6Raw) {
    let wallet;
    try {
        wallet = ethers_1.ethers.getAddress(walletAddress);
    }
    catch {
        return { error: 'Invalid wallet address' };
    }
    const parsed = parseEoaUsdcStripeAmountUsdc6(amountUsdc6Raw);
    if (!parsed.ok) {
        return { error: parsed.error };
    }
    if (!getStripeSecretKey()) {
        return { error: 'Stripe is not configured' };
    }
    /** Do not await Base RPC here — CoNET `base-rpc` lag must not block Opening Stripe. */
    let recipientEoa;
    try {
        recipientEoa = await (0, stripeWalletEoaResolve_1.resolveStripeOnrampRecipientEoa)(wallet);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, logger_1.logger)(safe_1.default.yellow('[eoaUsdcStripe] resolve EOA failed; using submitted address'), msg);
        recipientEoa = wallet;
    }
    if (recipientEoa.toLowerCase() !== wallet.toLowerCase()) {
        (0, logger_1.logger)(safe_1.default.cyan('[eoaUsdcStripe] create: submitted wallet is AA; locking Onramp to EOA'), wallet, '→', recipientEoa);
    }
    const walletLower = wallet.toLowerCase();
    const amountUsdc6 = parsed.amount.toString();
    const sourceAmount = amountUsdc6ToUsdSourceAmount(parsed.amount);
    const idempotencyKey = `eoa-usdc-onramp-${walletLower}-${amountUsdc6}-${(0, node_crypto_1.randomUUID)()}`;
    const onrampBase = {
        destination_networks: ['base'],
        destination_network: 'base',
        destination_currencies: ['usdc'],
        destination_currency: 'usdc',
        lock_wallet_address: true,
        source_amount: sourceAmount,
        source_currency: 'usd',
        metadata: {
            product: exports.EOA_USDC_STRIPE_PRODUCT,
            walletAddress: walletLower,
            amountUsdc6,
            recipientEoa,
        },
    };
    /** This Stripe account rejects `wallet_addresses[base]`. Lock EOA with `wallet_address`. */
    let session;
    try {
        session = await createStripeOnrampSession({ ...onrampBase, wallet_address: recipientEoa }, idempotencyKey);
    }
    catch (err) {
        const msg = stripeThrownMessage(err);
        if (!isStripeWalletAddressParamUnknownError(err)) {
            (0, logger_1.logger)(safe_1.default.red('[eoaUsdcStripe] onramp create failed'), msg);
            return { error: msg || 'Could not start Stripe USDC deposit' };
        }
        (0, logger_1.logger)(safe_1.default.yellow('[eoaUsdcStripe] wallet_address unknown; retry wallet_addresses[base_network]'), recipientEoa);
        try {
            session = await createStripeOnrampSession({ ...onrampBase, wallet_addresses: { base_network: recipientEoa } }, `${idempotencyKey}-wan`);
        }
        catch (retryErr) {
            const retryMsg = stripeThrownMessage(retryErr);
            (0, logger_1.logger)(safe_1.default.red('[eoaUsdcStripe] onramp create failed'), retryMsg);
            return { error: retryMsg || 'Could not start Stripe USDC deposit' };
        }
    }
    if (!session.id || !session.redirect_url) {
        return { error: 'Stripe Onramp session creation failed' };
    }
    sessions.set(session.id, {
        status: 'pending',
        walletAddress: walletLower,
        amountUsdc6,
        createdAt: Date.now(),
        lastEvent: session.status || 'initialized',
        chainFulfillment: { recipientEoa },
    });
    (0, logger_1.logger)(safe_1.default.green('[eoaUsdcStripe] createSession ok'), `session=${session.id}`, `sourceUsd=${sourceAmount}`, `eoa=${recipientEoa.slice(0, 10)}…`);
    return { sessionId: session.id, url: session.redirect_url };
}
function getEoaUsdcStripeSessionStatus(sessionId) {
    return sessions.get(sessionId) ?? null;
}
async function refreshEoaUsdcStripeSessionFromStripe(sessionId, options) {
    if (sessionId.startsWith('cs_')) {
        const retired = markRetiredCheckoutSession(sessionId);
        eoaUsdcDbg('refresh retired checkout session', sessionId, retired?.status ?? '(unknown)');
        return;
    }
    const rec = sessions.get(sessionId);
    if (rec?.status === 'succeeded' && rec.chainFulfillment?.usdcTxHash) {
        eoaUsdcDbg('refresh skip (already complete)', sessionId);
        return;
    }
    const remote = await retrieveStripeOnrampSession(sessionId);
    if (!remote) {
        eoaUsdcDbg('refresh miss', sessionId);
        return;
    }
    const next = applyOnrampSessionToLocal(remote, {
        lastEvent: remote.status || 'retrieve',
        treatOpenUnpaidAsAbandoned: options?.treatOpenUnpaidAsAbandoned,
    });
    if (next) {
        eoaUsdcDbg('refresh', sessionId, `stripe=${remote.status}`, `local=${next.status}`);
    }
}
function processEoaUsdcStripeEvent(event) {
    if (event.type.startsWith('checkout.session.')) {
        (0, logger_1.logger)(safe_1.default.grey('[eoaUsdcStripe:hook] ignore retired Checkout event'), event.type);
        return { ok: true };
    }
    if (!event.type.startsWith('crypto.onramp_session')) {
        (0, logger_1.logger)(safe_1.default.grey(`[eoaUsdcStripe:hook] unhandled event type (ignored): ${event.type}`));
        return { ok: true };
    }
    const session = asOnrampSession(event.data?.object);
    if (!session) {
        (0, logger_1.logger)(safe_1.default.yellow('[eoaUsdcStripe:hook] onramp object missing id'));
        return { ok: true };
    }
    const product = session.metadata?.product;
    if (product && product !== exports.EOA_USDC_STRIPE_PRODUCT) {
        (0, logger_1.logger)(safe_1.default.grey(`[eoaUsdcStripe:hook] ignore other product=${product}`));
        return { ok: true };
    }
    const next = applyOnrampSessionToLocal(session, { lastEvent: event.type });
    (0, logger_1.logger)(safe_1.default.cyan('[eoaUsdcStripe:hook] onramp'), `session=${session.id}`, `stripe=${session.status ?? '?'}`, `local=${next?.status ?? 'ignored'}`, `tx=${next?.chainFulfillment?.usdcTxHash ?? 'none'}`);
    return { ok: true };
}
