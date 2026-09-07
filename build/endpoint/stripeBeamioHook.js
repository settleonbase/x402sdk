"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleStripeBeamioWebhook = handleStripeBeamioWebhook;
/**
 * 唯一现役 Stripe webhook：`POST /api/stripeBeamioHook`。
 * 验签一次后按 event.type 分流：Onramp → eoaUsdc；Checkout → Merchant Kit。
 * 履约禁止交叉。
 */
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const stripeBeamio_1 = require("./stripeBeamio");
const eoaUsdcStripe_1 = require("./eoaUsdcStripe");
const merchantKitStripe_1 = require("./merchantKitStripe");
async function handleStripeBeamioWebhook(rawBody, sigHeader) {
    (0, logger_1.logger)(safe_1.default.cyan('[stripeBeamioHook] inbound'), `bytes=${rawBody.length}`, `stripe-signature=${Boolean(sigHeader && (typeof sigHeader === 'string' ? sigHeader : sigHeader[0]))}`);
    const constructed = (0, stripeBeamio_1.constructStripeBeamioEvent)(rawBody, sigHeader);
    if (!constructed.ok) {
        (0, logger_1.logger)(safe_1.default.red('[stripeBeamioHook] constructEvent FAILED'), constructed.error);
        return constructed;
    }
    const { event } = constructed;
    (0, logger_1.logger)(safe_1.default.green('[stripeBeamioHook] verified'), `id=${event.id}`, `type=${event.type}`, `livemode=${event.livemode}`);
    if (event.type.startsWith('crypto.onramp_session')) {
        return (0, eoaUsdcStripe_1.processEoaUsdcStripeEvent)(event);
    }
    if (event.type.startsWith('checkout.session.')) {
        return (0, merchantKitStripe_1.processMerchantKitStripeEvent)(event);
    }
    (0, logger_1.logger)(safe_1.default.grey(`[stripeBeamioHook] unhandled event type (ignored): ${event.type}`));
    return { ok: true };
}
