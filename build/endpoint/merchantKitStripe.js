"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MERCHANT_KIT_INCLUDED_BUNITS_6 = exports.MERCHANT_KIT_SYNTHETIC_USDC6_FOR_BUINT = exports.MERCHANT_KIT_PACKAGES = void 0;
exports.scheduleMerchantKitStripeChainFulfillment = scheduleMerchantKitStripeChainFulfillment;
exports.merchantKitStripeSuccessUrl = merchantKitStripeSuccessUrl;
exports.merchantKitStripeCancelUrl = merchantKitStripeCancelUrl;
exports.createMerchantKitCheckoutSession = createMerchantKitCheckoutSession;
exports.getMerchantKitSessionStatus = getMerchantKitSessionStatus;
exports.refreshMerchantKitSessionFromStripe = refreshMerchantKitSessionFromStripe;
exports.processMerchantKitStripeEvent = processMerchantKitStripeEvent;
const node_crypto_1 = require("node:crypto");
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const util_1 = require("../util");
const logger_1 = require("../logger");
const chainAddresses_1 = require("../chainAddresses");
const stripeWalletEoaResolve_1 = require("../stripeWalletEoaResolve");
const stripeBeamio_1 = require("./stripeBeamio");
/** CoNET B-Unit / kit mint signer（与 MemberCard Settle 一致） */
const CONET_MAINNET_RPC_HTTP = (0, util_1.resolveBeamioConetHttpRpcUrl)();
const BUNIT_AIRDROP_MINT_FOR_USDC_PURCHASE_ABI = [
    'function mintForUsdcPurchase(address to, uint256 usdcAmount, bytes32 baseTxHash) external',
];
const BUSINESS_START_KET_MINT_ABI = [
    'function mint(address to, uint256 id, uint256 amount, bytes data) external',
];
/** Set `MERCHANT_KIT_STRIPE_DEBUG=1` (or `true`) for verbose poll/refresh logs. Webhook always logs a short summary line. */
function merchantKitStripeDebugEnabled() {
    const v = (typeof process !== 'undefined' && process.env?.MERCHANT_KIT_STRIPE_DEBUG?.trim()?.toLowerCase()) || '';
    return v === '1' || v === 'true' || v === 'yes';
}
function merchantKitDbg(...args) {
    if (merchantKitStripeDebugEnabled()) {
        (0, logger_1.logger)(safe_1.default.cyan('[merchantKitStripe:debug]'), ...args);
    }
}
exports.MERCHANT_KIT_PACKAGES = {
    lite_kit: {
        name: 'Lite Program Kit',
        cadCents: 1900,
        description: '500 B-Units included — digital program (no NFC cards)',
    },
    standard_kit: {
        name: 'Standard Program Kit',
        cadCents: 6900,
        description: '2,000 B-Units included — VERRA generic NFC program',
    },
    custom_kit: {
        name: 'Custom Program Kit',
        cadCents: 13900,
        description: '5,000 B-Units included — custom design program',
    },
};
/**
 * 合成 USDC（6 位）传入 BUnitAirdrop.mintForUsdcPurchase：合约内 bunit = usdc * 100（USDC_TO_BUNIT_RATE），
 * 与各 kit 标价中包含的 B-Unit 数量一致（付费池 mintPaid）。非真实链上 USDC，仅用于铸造配额与 Indexer 记账维度。
 */
exports.MERCHANT_KIT_SYNTHETIC_USDC6_FOR_BUINT = {
    lite_kit: 5000000n,
    standard_kit: 20000000n,
    custom_kit: 50000000n,
};
/** 各 kit 对应铸造的 B-Unit 数量（6 位精度），与 MERCHANT_KIT_PACKAGES 文案一致 */
exports.MERCHANT_KIT_INCLUDED_BUNITS_6 = {
    lite_kit: 500000000n,
    standard_kit: 2000000000n,
    custom_kit: 5000000000n,
};
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function pruneMerchantKitSessions() {
    const now = Date.now();
    for (const [id, rec] of sessions) {
        if (now - rec.createdAt > SESSION_TTL_MS)
            sessions.delete(id);
    }
}
/** 与 setInterval 等价的首拍延迟 1h，随后每轮结束后再排 1h（遵守 beamio-no-setinterval） */
function scheduleMerchantKitSessionPrune() {
    const t = setTimeout(() => {
        pruneMerchantKitSessions();
        scheduleMerchantKitSessionPrune();
    }, 60 * 60 * 1000);
    t.unref?.();
}
scheduleMerchantKitSessionPrune();
/** 同 session 多次触发 webhook / refresh 时合并为单次履约链上流程 */
const merchantKitFulfillmentInflight = new Map();
function resolveConetBusinessStartKetAddressForMint() {
    const raw = (typeof process !== 'undefined' && process.env.CONET_BUSINESS_START_KET?.trim()) ||
        chainAddresses_1.CONET_BUSINESS_START_KET?.trim() ||
        '';
    if (!raw) {
        return null;
    }
    try {
        const a = ethers_1.ethers.getAddress(raw);
        return a === ethers_1.ethers.ZeroAddress ? null : a;
    }
    catch {
        return null;
    }
}
/**
 * Stripe Checkout 支付确认后：向 metadata 中的 EOA 铸造 B-Units（付费池）并 mint BusinessStartKet #0 ×1。
 * 幂等：按 session 记录分步跳过已完成的交易；并发合并为单次 in-flight Promise。
 */
async function fulfillMerchantKitStripeOnChain(sessionId) {
    let inflight = merchantKitFulfillmentInflight.get(sessionId);
    if (inflight) {
        merchantKitDbg('fulfill join (in flight)', sessionId);
        return inflight;
    }
    inflight = (async () => {
        const getCf = () => sessions.get(sessionId)?.chainFulfillment ?? {};
        const patchChainFulfillment = (patch) => {
            const cur = sessions.get(sessionId);
            if (!cur) {
                return;
            }
            sessions.set(sessionId, {
                ...cur,
                chainFulfillment: { ...cur.chainFulfillment, ...patch },
            });
        };
        try {
            const rec = sessions.get(sessionId);
            if (!rec || rec.status !== 'succeeded') {
                merchantKitDbg('fulfill skip (not succeeded)', sessionId, rec?.status ?? '(no record)');
                return;
            }
            let mintRecipient;
            try {
                mintRecipient = ethers_1.ethers.getAddress(rec.eoaAddress);
            }
            catch {
                (0, logger_1.logger)(safe_1.default.red('[merchantKitStripe] fulfill: invalid EOA'), rec.eoaAddress);
                return;
            }
            mintRecipient = await (0, stripeWalletEoaResolve_1.resolveStripeMintRecipientEoaOnBase)(mintRecipient);
            if (mintRecipient.toLowerCase() !== rec.eoaAddress.toLowerCase()) {
                (0, logger_1.logger)(safe_1.default.cyan('[merchantKitStripe] fulfill: wallet was AA on Base; minting kit to EOA'), rec.eoaAddress, '→', mintRecipient);
            }
            if (!(rec.packageType in exports.MERCHANT_KIT_PACKAGES)) {
                (0, logger_1.logger)(safe_1.default.red('[merchantKitStripe] fulfill: unknown packageType'), rec.packageType);
                return;
            }
            const pkg = rec.packageType;
            const usdc6Synth = exports.MERCHANT_KIT_SYNTHETIC_USDC6_FOR_BUINT[pkg];
            const pk = util_1.masterSetup.settle_contractAdmin?.[0];
            if (!pk?.trim()) {
                (0, logger_1.logger)(safe_1.default.red('[merchantKitStripe] fulfill: settle_contractAdmin[0] missing'));
                return;
            }
            const pkNorm = pk.trim().startsWith('0x') ? pk.trim() : `0x${pk.trim()}`;
            const provider = new ethers_1.ethers.JsonRpcProvider(CONET_MAINNET_RPC_HTTP);
            const signer = new ethers_1.ethers.Wallet(pkNorm, provider);
            if (!getCf().buintTxHash) {
                const airdrop = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUNIT_AIRDROP_ADDRESS, BUNIT_AIRDROP_MINT_FOR_USDC_PURCHASE_ABI, signer);
                const refHash = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(sessionId));
                const tx = await airdrop.mintForUsdcPurchase(mintRecipient, usdc6Synth, refHash);
                const receipt = await tx.wait();
                const h = receipt?.hash ?? tx.hash;
                patchChainFulfillment({ buintTxHash: h, lastError: undefined });
                (0, logger_1.logger)(safe_1.default.green('[merchantKitStripe] mintForUsdcPurchase ok (kit B-Units paid pool)'), `session=${sessionId}`, `pkg=${pkg}`, `bunits≈${(Number(exports.MERCHANT_KIT_INCLUDED_BUNITS_6[pkg]) / 1e6).toFixed(2)}`, `tx=${h}`, `eoa=${mintRecipient}`);
            }
            const ketAddr = resolveConetBusinessStartKetAddressForMint();
            if (ketAddr && !getCf().nftTxHash) {
                const ket = new ethers_1.ethers.Contract(ketAddr, BUSINESS_START_KET_MINT_ABI, signer);
                const tx2 = await ket.mint(mintRecipient, 0n, 1n, '0x');
                const receipt2 = await tx2.wait();
                const h2 = receipt2?.hash ?? tx2.hash;
                patchChainFulfillment({ nftTxHash: h2, lastError: undefined });
                (0, logger_1.logger)(safe_1.default.green('[merchantKitStripe] BusinessStartKet mint token #0 ok'), `session=${sessionId}`, `tx=${h2}`, `eoa=${mintRecipient}`);
            }
            else if (!ketAddr) {
                merchantKitDbg('fulfill: skip ERC1155 (CONET_BUSINESS_START_KET unset)');
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logger)(safe_1.default.red('[merchantKitStripe] fulfill FAILED'), sessionId, msg);
            patchChainFulfillment({ lastError: msg });
        }
        finally {
            merchantKitFulfillmentInflight.delete(sessionId);
        }
    })();
    merchantKitFulfillmentInflight.set(sessionId, inflight);
    return inflight;
}
/** Fire-and-forget；应从 webhook / paid refresh 各调用一次（内部幂等） */
function scheduleMerchantKitStripeChainFulfillment(sessionId) {
    void fulfillMerchantKitStripeOnChain(sessionId);
}
function getStripeSecretKey() {
    return (0, stripeBeamio_1.getStripeBeamioSecretKey)();
}
function getStripeClient() {
    return (0, stripeBeamio_1.getStripeBeamioClient)();
}
/** Return base for Stripe redirects (no trailing slash). bizSite CRA `homepage` is `/biz`. */
function getMerchantKitStripeReturnBase() {
    const env = (typeof process !== 'undefined' && process.env?.MERCHANT_KIT_STRIPE_RETURN_BASE?.trim()) || '';
    return env.replace(/\/$/, '') || 'https://beamio.app/biz';
}
function merchantKitStripeSuccessUrl() {
    return `${getMerchantKitStripeReturnBase()}/native-pos?merchant_kit_stripe=success&session_id={CHECKOUT_SESSION_ID}`;
}
function merchantKitStripeCancelUrl() {
    return `${getMerchantKitStripeReturnBase()}/native-pos?merchant_kit_stripe=cancel`;
}
async function createMerchantKitCheckoutSession(eoaAddress, packageType) {
    let eoa;
    try {
        eoa = ethers_1.ethers.getAddress(eoaAddress);
    }
    catch {
        return { error: 'Invalid wallet address' };
    }
    if (!(packageType in exports.MERCHANT_KIT_PACKAGES)) {
        return { error: 'Invalid package type' };
    }
    const stripe = getStripeClient();
    if (!stripe) {
        return { error: 'Stripe is not configured' };
    }
    const pkg = exports.MERCHANT_KIT_PACKAGES[packageType];
    const eoaLower = eoa.toLowerCase();
    const idempotencyKey = `merchant-kit-${eoaLower}-${packageType}-${(0, node_crypto_1.randomUUID)()}`;
    const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        metadata: {
            eoaAddress: eoaLower,
            packageType,
        },
        line_items: [
            {
                price_data: {
                    currency: 'cad',
                    unit_amount: pkg.cadCents,
                    product_data: {
                        name: pkg.name,
                        description: pkg.description,
                    },
                },
                quantity: 1,
            },
        ],
        payment_intent_data: {
            metadata: {
                eoaAddress: eoaLower,
                packageType,
            },
        },
        success_url: merchantKitStripeSuccessUrl(),
        cancel_url: merchantKitStripeCancelUrl(),
    }, { idempotencyKey });
    if (!session.id || !session.url) {
        return { error: 'Checkout session creation failed' };
    }
    sessions.set(session.id, {
        status: 'pending',
        eoaAddress: eoaLower,
        packageType,
        createdAt: Date.now(),
    });
    (0, logger_1.logger)(safe_1.default.green('[merchantKitStripe] createSession ok'), `session=${session.id}`, `pkg=${packageType}`, `eoa=${eoaLower.slice(0, 10)}…`);
    return { sessionId: session.id, url: session.url };
}
function getMerchantKitSessionStatus(sessionId) {
    return sessions.get(sessionId) ?? null;
}
/** Best-effort sync when webhook is delayed or missed. */
async function refreshMerchantKitSessionFromStripe(sessionId, options) {
    const stripe = getStripeClient();
    if (!stripe)
        return;
    const rec_ = sessions.get(sessionId);
    if (rec_?.status !== 'pending') {
        merchantKitDbg('refresh skip (not pending)', sessionId, 'local=', rec_?.status ?? '(no record)');
        return;
    }
    try {
        const s = await stripe.checkout.sessions.retrieve(sessionId);
        merchantKitDbg('retrieve', sessionId, `checkoutStatus=${s.status}`, `payment_status=${s.payment_status}`, `abandonedFlag=${Boolean(options?.treatOpenUnpaidAsAbandoned)}`);
        if (s.status === 'complete' && s.payment_status === 'paid') {
            sessions.set(sessionId, {
                ...rec_,
                status: 'succeeded',
                lastEvent: 'retrieve.paid',
            });
            (0, logger_1.logger)(safe_1.default.green('[merchantKitStripe] refresh → succeeded'), sessionId);
            return;
        }
        if (s.status === 'expired') {
            sessions.set(sessionId, {
                ...rec_,
                status: 'failed',
                lastEvent: 'expired',
            });
            (0, logger_1.logger)(safe_1.default.yellow('[merchantKitStripe] refresh → failed (expired)'), sessionId);
            return;
        }
        if (options?.treatOpenUnpaidAsAbandoned &&
            s.status === 'open' &&
            s.payment_status === 'unpaid') {
            sessions.set(sessionId, {
                ...rec_,
                status: 'failed',
                lastEvent: 'abandoned',
            });
            (0, logger_1.logger)(safe_1.default.yellow('[merchantKitStripe] refresh → failed (abandoned open+unpaid)'), sessionId);
        }
    }
    catch (err) {
        (0, logger_1.logger)(safe_1.default.yellow(`[merchantKitStripe] retrieve error ${sessionId}:`), err);
    }
}
function applySessionOutcome(sessionId, status, meta) {
    const prev = sessions.get(sessionId);
    const createdAt = prev?.createdAt ?? Date.now();
    const eoaNorm = (meta.eoaAddress ?? prev?.eoaAddress ?? '').toLowerCase();
    const pkgNorm = meta.packageType ?? prev?.packageType ?? '';
    const next = {
        status,
        eoaAddress: eoaNorm,
        packageType: pkgNorm,
        createdAt,
        lastEvent: meta.lastEvent,
        chainFulfillment: prev?.chainFulfillment,
    };
    sessions.set(sessionId, next);
    merchantKitDbg('applySessionOutcome', sessionId, meta.lastEvent, '→', status, `pkg=${pkgNorm}`);
}
function markMerchantKitPaidSession(session, lastEvent) {
    const meta = session.metadata ?? {};
    (0, logger_1.logger)(`[merchantKitStripe:hook] ${lastEvent}`, `session=${session.id}`, `payment_status=${session.payment_status}`, `status=${session.status}`, `metadata.pkg=${meta.packageType ?? '?'}`, `metadata.eoa=${meta.eoaAddress ? `${String(meta.eoaAddress).slice(0, 10)}…` : '?'}`);
    if (session.payment_status !== 'paid') {
        (0, logger_1.logger)(safe_1.default.yellow(`[merchantKitStripe:hook] ${lastEvent} SKIPPED (not paid yet)`), `payment_status=${session.payment_status}`);
        return;
    }
    const hadLocal = sessions.has(session.id);
    applySessionOutcome(session.id, 'succeeded', {
        eoaAddress: session.metadata?.eoaAddress,
        packageType: session.metadata?.packageType,
        lastEvent,
    });
    (0, logger_1.logger)(safe_1.default.green('[merchantKitStripe:hook] → local map UPDATED succeeded'), `session=${session.id}`, `hadLocalRecord=${hadLocal}`);
    scheduleMerchantKitStripeChainFulfillment(session.id);
}
function processMerchantKitStripeEvent(event) {
    const product = event.data?.object?.metadata?.product;
    if (product === 'eoaUsdc') {
        (0, logger_1.logger)(safe_1.default.grey('[merchantKitStripe:hook] ignore eoaUsdc product'));
        return { ok: true };
    }
    switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
            markMerchantKitPaidSession(event.data.object, event.type);
            break;
        }
        case 'checkout.session.async_payment_failed': {
            const session = event.data.object;
            (0, logger_1.logger)(safe_1.default.yellow('[merchantKitStripe:hook] checkout.session.async_payment_failed'), `session=${session.id}`);
            applySessionOutcome(session.id, 'failed', {
                eoaAddress: session.metadata?.eoaAddress,
                packageType: session.metadata?.packageType,
                lastEvent: event.type,
            });
            break;
        }
        case 'checkout.session.expired': {
            const session = event.data.object;
            (0, logger_1.logger)(safe_1.default.yellow('[merchantKitStripe:hook] checkout.session.expired'), `session=${session.id}`);
            applySessionOutcome(session.id, 'failed', {
                eoaAddress: session.metadata?.eoaAddress,
                packageType: session.metadata?.packageType,
                lastEvent: event.type,
            });
            break;
        }
        default:
            (0, logger_1.logger)(safe_1.default.grey(`[merchantKitStripe:hook] unhandled event type (ignored): ${event.type}`));
            break;
    }
    return { ok: true };
}
