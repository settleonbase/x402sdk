"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStripeBeamioSecretKey = getStripeBeamioSecretKey;
exports.getStripeBeamioWebhookSecret = getStripeBeamioWebhookSecret;
exports.getStripeBeamioClient = getStripeBeamioClient;
exports.constructStripeBeamioEvent = constructStripeBeamioEvent;
/**
 * StripeBeamio — 唯一现役 Stripe 账号 + 唯一 webhook 验签。
 * Merchant Kit Checkout 与 Consumer Onramp 共用；履约必须分轨。
 * 禁止读 `stripe_SecretKey` / `STRIPE_WEBHOOK_SECRET_EOA_USDC`。
 */
const stripe_1 = __importDefault(require("stripe"));
const util_1 = require("../util");
function getStripeBeamioSecretKey() {
    const setup = util_1.masterSetup;
    return ((typeof process !== 'undefined' && process.env?.STRIPE_SECRET_KEY?.trim()) ||
        setup.StripeBeamio?.trim() ||
        '');
}
function getStripeBeamioWebhookSecret() {
    const setup = util_1.masterSetup;
    return ((typeof process !== 'undefined' && process.env?.STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?.trim()) ||
        setup.STRIPE_WEBHOOK_SECRET_MERCHANT_KIT?.trim() ||
        '');
}
function getStripeBeamioClient() {
    const key = getStripeBeamioSecretKey();
    if (!key)
        return null;
    return new stripe_1.default(key);
}
function constructStripeBeamioEvent(rawBody, sigHeader) {
    const whSecret = getStripeBeamioWebhookSecret();
    if (!whSecret) {
        return { ok: false, error: 'STRIPE_WEBHOOK_SECRET_MERCHANT_KIT not configured' };
    }
    const stripe = getStripeBeamioClient();
    if (!stripe) {
        return { ok: false, error: 'Stripe client not configured' };
    }
    const sig = typeof sigHeader === 'string' ? sigHeader : sigHeader?.[0] ?? '';
    try {
        return { ok: true, event: stripe.webhooks.constructEvent(rawBody, sig, whSecret) };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}
