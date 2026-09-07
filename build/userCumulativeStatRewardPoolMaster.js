"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardGatewayRewardPool = exports.GATEWAY_INVOKE_CARD_SELECTOR = void 0;
exports.factorySupportsGatewayInvokeCard = factorySupportsGatewayInvokeCard;
exports.kickCardGatewayRewardPoolPress = kickCardGatewayRewardPoolPress;
exports.cardGatewayRewardPoolPress = cardGatewayRewardPoolPress;
exports.pushCardGatewayRewardPoolTask = pushCardGatewayRewardPoolTask;
exports.enqueueRecordTopupCumulativeStatGateway = enqueueRecordTopupCumulativeStatGateway;
exports.enqueueRecordChargeReferrerReward = enqueueRecordChargeReferrerReward;
exports.enqueueCouponSocialReward13IfConfigured = enqueueCouponSocialReward13IfConfigured;
exports.enqueueTopupSocialReward13IfConfigured = enqueueTopupSocialReward13IfConfigured;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
const MemberCard_1 = require("./MemberCard");
const settleContractPool_1 = require("./settleContractPool");
const userCumulativeStatRewardPool_1 = require("./userCumulativeStatRewardPool");
const couponSocialPromotionReward_1 = require("./couponSocialPromotionReward");
const cardProgramSocialDb_1 = require("./cardProgramSocialDb");
const cardProgramReferrerDb_1 = require("./cardProgramReferrerDb");
const FACTORY_GATEWAY_IFACE = new ethers_1.ethers.Interface([
    'function gatewayInvokeCard(address cardAddr, bytes data) returns (bytes)',
]);
exports.GATEWAY_INVOKE_CARD_SELECTOR = FACTORY_GATEWAY_IFACE.getFunction('gatewayInvokeCard')?.selector ?? '0x0a76307f';
exports.cardGatewayRewardPool = [];
let gatewayPoolPressRunning = false;
async function factorySupportsGatewayInvokeCard(factoryAddress, chain = 'conet') {
    if (chain !== 'conet')
        return false;
    try {
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const code = await provider.getCode(factoryAddress);
        if (!code || code === '0x')
            return false;
        const selector = exports.GATEWAY_INVOKE_CARD_SELECTOR.slice(2).toLowerCase();
        return code.toLowerCase().includes(selector);
    }
    catch {
        return false;
    }
}
function kickCardGatewayRewardPoolPress() {
    if (gatewayPoolPressRunning)
        return;
    gatewayPoolPressRunning = true;
    void cardGatewayRewardPoolPress().finally(() => {
        gatewayPoolPressRunning = false;
    });
}
function scheduleCardGatewayRewardPoolPress() {
    if (exports.cardGatewayRewardPool.length === 0)
        return;
    setTimeout(() => kickCardGatewayRewardPoolPress(), 1000);
}
async function persistCardProgramSocialDbAfterTx(cardAddress, txHash, meta) {
    if (!meta)
        return;
    if (meta.kind === 'like') {
        await (0, cardProgramSocialDb_1.upsertCardProgramLike)({
            cardAddress,
            userEOA: meta.userEOA,
            targetKind: meta.targetKind,
            issuedParentId: meta.issuedParentId,
            txHash,
        });
        return;
    }
    if (meta.kind === 'unlike') {
        await (0, cardProgramSocialDb_1.removeCardProgramLike)({
            cardAddress,
            userEOA: meta.userEOA,
            targetKind: meta.targetKind,
            issuedParentId: meta.issuedParentId,
        });
        return;
    }
    if (meta.kind === 'shareClick') {
        await (0, cardProgramSocialDb_1.insertCardProgramShareClick)({
            cardAddress,
            actorEOA: meta.actorEOA,
            referrerEOA: meta.referrerEOA ?? null,
            targetKind: meta.targetKind,
            issuedParentId: meta.issuedParentId,
            txHash,
        });
    }
}
/** Index ShareRefereeBound / Referee* into DB after gateway UserOp (bindShareReferee + other card writes). */
function syncCardProgramReferrerFromGatewayReceipt(cardAddress, txHash, receipt, logTag) {
    if (!receipt?.logs?.length)
        return;
    void (0, cardProgramReferrerDb_1.syncCardProgramReferrerEventsFromReceipt)({
        cardAddress,
        receipt: { logs: receipt.logs },
        txHash,
    }).catch((refIdxErr) => {
        const msg = refIdxErr instanceof Error ? refIdxErr.message : String(refIdxErr);
        (0, logger_1.logger)(safe_1.default.yellow(`[${logTag}] cardProgramReferrer indexer non-critical: ${msg}`));
    });
}
async function ensureCardUserCumulativeStatInitialized(params) {
    const status = await (0, userCumulativeStatRewardPool_1.readCardUserCumulativeStatStatus)(params.cardAddress);
    if (status.initialized)
        return { ok: true, skipped: true };
    const initFactoryCallData = (0, userCumulativeStatRewardPool_1.encodeGatewayInvokeCardFactoryCalldata)(params.cardAddress, (0, userCumulativeStatRewardPool_1.buildInitializeCardUserCumulativeStatCalldata)());
    (0, logger_1.logger)(safe_1.default.cyan(`[${params.logTag}] auto-init cardUserCumulativeStatTokens card=${params.cardAddress}`));
    const tx = await (0, MemberCard_1.relayUserCardFactoryCallViaEntryPoint)({
        SC: params.SC,
        chain: params.chain,
        factoryAddress: params.factoryAddress,
        factoryCallData: initFactoryCallData,
        logTag: `${params.logTag}:initUserCumulativeStat`,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
        return { ok: false, error: 'initializeCardUserCumulativeStatTokens tx reverted', hash: tx.hash };
    }
    return { ok: true, hash: tx.hash };
}
function scheduleSocialBunitFeeAfterGatewaySuccess(task, basePaymentHash, baseGas) {
    const kindFromDb = task.socialDb?.kind;
    let kind = null;
    if (kindFromDb === 'like' || kindFromDb === 'shareClick') {
        kind = kindFromDb;
    }
    else {
        const label = task.label || '';
        if (label.includes('dispatchEventReward13:coupon:claim'))
            kind = 'claim';
        else if (label.includes('dispatchEventReward13:coupon:burn'))
            kind = 'burn';
        else if (label.includes('dispatchEventReward13:coupon:linkClick'))
            kind = 'linkClick';
        else if (label.includes('dispatchEventReward13:topup'))
            kind = 'topup';
    }
    if (!kind)
        return;
    void (0, MemberCard_1.chargeCardProgramSocialBunitFeeInBackground)({
        cardAddress: task.cardAddress,
        basePaymentHash,
        kind,
        baseGas,
        logTag: `${task.label}:bunit`,
    }).catch((e) => {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[${task.label}:bunit] unhandled: ${err?.message ?? String(e)}`));
    });
}
async function cardGatewayRewardPoolPress() {
    const obj = exports.cardGatewayRewardPool.shift();
    if (!obj)
        return;
    const SC = (0, settleContractPool_1.shiftSettleConet)();
    if (!SC) {
        exports.cardGatewayRewardPool.unshift(obj);
        setTimeout(() => kickCardGatewayRewardPoolPress(), 3000);
        return;
    }
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(obj.cardAddress);
        if (chain !== 'conet') {
            const err = 'Gateway reward-pool writes are CoNET-only';
            (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] ${err}`));
            obj.res?.status(400).json({ success: false, error: err }).end();
            return;
        }
        const factory = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(obj.cardAddress);
        const gatewaySupported = await factorySupportsGatewayInvokeCard(factory, chain);
        const hasDirectCard = Boolean(obj.cardCallData && obj.cardCallData.length >= 10);
        if (obj.initOnly) {
            if (!gatewaySupported) {
                const err = 'Factory gatewayInvokeCard not deployed on-chain; use cardInitializeUserCumulativeStat (executeForOwner) instead.';
                (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] ${err}`));
                obj.res?.status(503).json({ success: false, error: err, code: 'UC_FACTORY_GATEWAY_INVOKE_NOT_DEPLOYED' }).end();
                return;
            }
            const initResult = await ensureCardUserCumulativeStatInitialized({
                SC,
                chain,
                factoryAddress: factory,
                cardAddress: obj.cardAddress,
                logTag: obj.label,
            });
            if (!initResult.ok) {
                (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] ${initResult.error}`));
                obj.res
                    ?.status(500)
                    .json({ success: false, error: initResult.error, hash: initResult.hash })
                    .end();
                return;
            }
            (0, logger_1.logger)(safe_1.default.green(`[${obj.label}] ok card=${obj.cardAddress} skipped=${Boolean(initResult.skipped)} hash=${initResult.hash ?? 'n/a'}`));
            obj.res
                ?.status(200)
                .json({
                success: true,
                hash: initResult.hash,
                skipped: Boolean(initResult.skipped),
                initialized: true,
            })
                .end();
            return;
        }
        const initResult = await ensureCardUserCumulativeStatInitialized({
            SC,
            chain,
            factoryAddress: factory,
            cardAddress: obj.cardAddress,
            logTag: obj.label,
        });
        if (!initResult.ok) {
            (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] ${initResult.error}`));
            obj.res
                ?.status(500)
                .json({ success: false, error: initResult.error, hash: initResult.hash })
                .end();
            return;
        }
        const hasExtraSteps = (obj.extraCardCallData?.length ?? 0) > 0;
        const useDirectCard = hasDirectCard &&
            (hasExtraSteps || !gatewaySupported || !obj.factoryCallData || obj.factoryCallData.length < 10);
        if (useDirectCard) {
            const directSteps = [obj.cardCallData, ...(obj.extraCardCallData ?? [])].filter((d) => typeof d === 'string' && d.length >= 10);
            let lastHash = '';
            let lastGas = 0n;
            let lastReceipt = null;
            for (let i = 0; i < directSteps.length; i++) {
                const stepLabel = `${obj.label}:step${i + 1}`;
                const tx = await (0, MemberCard_1.relayUserCardCallViaEntryPoint)({
                    SC,
                    chain,
                    cardAddress: obj.cardAddress,
                    cardCallData: directSteps[i],
                    logTag: stepLabel,
                });
                const receipt = await tx.wait();
                const relayCheck = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(receipt ?? undefined, { logTag: stepLabel });
                if (!relayCheck.ok) {
                    const err = relayCheck.reason ?? 'Direct card reward-pool UserOp failed';
                    (0, logger_1.logger)(safe_1.default.red(`[${stepLabel}] ${err} hash=${tx.hash}`));
                    obj.res?.status(500).json({ success: false, error: err, hash: tx.hash }).end();
                    return;
                }
                lastHash = tx.hash;
                lastGas = receipt?.gasUsed ?? 0n;
                lastReceipt = receipt;
            }
            (0, logger_1.logger)(safe_1.default.green(`[${obj.label}] ok (direct card) hash=${lastHash} card=${obj.cardAddress}`));
            await persistCardProgramSocialDbAfterTx(obj.cardAddress, lastHash, obj.socialDb);
            syncCardProgramReferrerFromGatewayReceipt(obj.cardAddress, lastHash, lastReceipt, obj.label);
            /** like/unlike already returned `{ queued: true }` at enqueue — do not rewrite HTTP. */
            if (obj.res && !obj.res.headersSent) {
                obj.res.status(200).json({ success: true, hash: lastHash }).end();
            }
            scheduleSocialBunitFeeAfterGatewaySuccess(obj, lastHash, lastGas);
            return;
        }
        if (!gatewaySupported && !hasDirectCard) {
            const err = 'CoNET Factory lacks gatewayInvokeCard and no direct cardCallData; upgrade ChargeRewardModuleV2 (paymaster relay) and ensure Cluster forwards cardCallData.';
            (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] ${err}`));
            obj.res?.status(503).json({ success: false, error: err, code: 'UC_FACTORY_GATEWAY_INVOKE_NOT_DEPLOYED' }).end();
            return;
        }
        if (!obj.factoryCallData || obj.factoryCallData.length < 10) {
            const err = 'Missing or invalid factoryCallData / cardCallData';
            (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] ${err}`));
            obj.res?.status(400).json({ success: false, error: err }).end();
            return;
        }
        const tx = await (0, MemberCard_1.relayUserCardFactoryCallViaEntryPoint)({
            SC,
            chain,
            factoryAddress: factory,
            factoryCallData: obj.factoryCallData,
            logTag: obj.label,
        });
        const receipt = await tx.wait();
        const relayCheck = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(receipt ?? undefined, { logTag: obj.label });
        if (!relayCheck.ok) {
            const err = relayCheck.reason ?? 'Gateway reward-pool UserOp failed';
            (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] ${err} hash=${tx.hash}`));
            obj.res?.status(500).json({ success: false, error: err, hash: tx.hash }).end();
            return;
        }
        (0, logger_1.logger)(safe_1.default.green(`[${obj.label}] ok hash=${tx.hash} card=${obj.cardAddress}`));
        await persistCardProgramSocialDbAfterTx(obj.cardAddress, tx.hash, obj.socialDb);
        syncCardProgramReferrerFromGatewayReceipt(obj.cardAddress, tx.hash, receipt, obj.label);
        if (obj.res && !obj.res.headersSent) {
            obj.res.status(200).json({ success: true, hash: tx.hash }).end();
        }
        scheduleSocialBunitFeeAfterGatewaySuccess(obj, tx.hash, receipt?.gasUsed ?? 0n);
    }
    catch (e) {
        const err = e;
        const msg = err?.shortMessage ?? err?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red(`[${obj.label}] failed: ${msg}`));
        if (obj.res && !obj.res.headersSent) {
            obj.res.status(500).json({ success: false, error: msg }).end();
        }
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(SC);
        scheduleCardGatewayRewardPoolPress();
    }
}
function pushCardGatewayRewardPoolTask(task) {
    exports.cardGatewayRewardPool.push(task);
    kickCardGatewayRewardPoolPress();
}
/**
 * @deprecated Beacon V15+ mints METRIC_TOPUP + #13 inside mintPointsByAdmin*|Gateway* same call.
 * Kept as no-op so old callers do not enqueue a second UserOp (design violation / BM_CallFailed).
 */
function enqueueRecordTopupCumulativeStatGateway(_params) {
    /* no-op: same-cycle on card */
}
/**
 * @deprecated Beacon V16+ mints Charge referrer #13 in-card via UpdateLib
 * (`mintReferrerRewardForChargeIfConfigured` when `referrerChargeAmountRatioE6 > 0`).
 * Kept as no-op so legacy callers do not dual-mint.
 */
function enqueueRecordChargeReferrerReward(_params) {
    /* no-op: same-cycle on card */
}
function resolveTopupRefWalletForDispatch(userEOA, refWalletRaw, refMint13) {
    if (refMint13 <= 0n)
        return ethers_1.ethers.ZeroAddress;
    const raw = refWalletRaw?.trim() ?? '';
    if (!raw || !ethers_1.ethers.isAddress(raw))
        return ethers_1.ethers.ZeroAddress;
    try {
        const ref = ethers_1.ethers.getAddress(raw);
        const actor = ethers_1.ethers.getAddress(userEOA);
        return ref === actor ? ethers_1.ethers.ZeroAddress : ref;
    }
    catch {
        return ethers_1.ethers.ZeroAddress;
    }
}
/** L2 coupon social event (#13) — claim / burn / optional server-side linkClick. cumulativeDelta=1 records stat in dispatch. */
async function enqueueCouponSocialReward13IfConfigured(params) {
    const rule = await (0, couponSocialPromotionReward_1.readActiveCouponSocialRewardRule)({
        cardAddress: params.cardAddress,
        issuedTokenId: params.issuedTokenId,
        eventKey: params.eventKey,
    });
    if (!rule)
        return;
    if (rule.actorMint13 <= 0n && rule.refMint13 <= 0n)
        return;
    const card = ethers_1.ethers.getAddress(params.cardAddress);
    const user = ethers_1.ethers.getAddress(params.userEOA);
    const refWallet = (0, couponSocialPromotionReward_1.resolveRefWalletForDispatch)(user, params.refWallet, rule.refMint13);
    const cumulativeDelta = BigInt(params.cumulativeDelta ?? 1);
    const cardCalldata = (0, userCumulativeStatRewardPool_1.buildDispatchEventReward13Calldata)({
        ruleId: rule.ruleId,
        actorWallet: user,
        refWallet,
        cumulativeTargetKind: rule.targetKind,
        cumulativeIssuedParentId: rule.issuedParentId,
        cumulativeDelta,
    });
    const factoryCallData = (0, userCumulativeStatRewardPool_1.encodeGatewayInvokeCardFactoryCalldata)(card, cardCalldata);
    pushCardGatewayRewardPoolTask({
        cardAddress: card,
        cardCallData: cardCalldata,
        factoryCallData,
        label: `dispatchEventReward13:coupon:${params.eventKey}`,
    });
}
/**
 * @deprecated Same-cycle top-up #13 is minted in-card from **ratio storage**
 * (`topupActorRewardRatioE6` / `referrerTopupAmountRatioE6`) via `recordTopupCumulativeStat`.
 * Kept as no-op so legacy callers do not dual-mint (fixed `ruleId=2` or a second UserOp).
 */
async function enqueueTopupSocialReward13IfConfigured(_params) {
    return;
}
