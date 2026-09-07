"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardRecordUserLikePreCheck = exports.GATEWAY_REWARD_POOL_NOT_WIRED = exports.cardDispatchEventReward13PreCheck = exports.cardBindShareRefereePreCheck = exports.cardRecordDiscoverShareClickPreCheck = exports.cardFundSocialExchangeUsdcEscrowPreCheck = exports.cardPurchaseRewardProgramPreCheck = exports.cardRecordTopupCumulativeStatPreCheck = exports.cardGatewayInitializeUserCumulativeStatPreCheck = exports.cardRecordUserCumulativeStatPreCheck = exports.cardConfigureEventRewardRulesBatchGatewayPreCheck = exports.cardConfigureEventRewardRulesBatchPreCheck = exports.cardConfigureEventRewardRuleGatewayPreCheck = exports.cardConfigureEventRewardRulePreCheck = exports.cardConfigureEventRewardRuleAdminPreCheck = exports.cardBootstrapIssuedNftV2StatPreCheck = exports.cardInitializeUserCumulativeStatPreCheck = exports.UC_METRIC_TOPUP = exports.SOCIAL_PROMOTION_TOPUP_RULE_ID = exports.UC_REWARD_ASSET = exports.UC_TARGET = exports.UC_METRIC = exports.CLAIM_SOCIAL_EXCHANGE_WITH_USER_SIGNATURE_SELECTOR = exports.FUND_SOCIAL_EXCHANGE_USDC_ESCROW_SELECTOR = exports.DISPATCH_EVENT_REWARD13_SELECTOR = exports.PURCHASE_REWARD_PROGRAM_SELECTOR = exports.RECORD_TOPUP_CUMULATIVE_STAT_SELECTOR = exports.RECORD_MERCHANT_CARD_USER_LIKE_EIP712_TYPE = exports.BIND_SHARE_REFEREE_EIP712_TYPE = exports.RECORD_DISCOVER_SHARE_CLICK_EIP712_TYPE = exports.RECORD_USER_LIKE_EIP712_TYPE = exports.ISSUED_NFT_START_ID_MEMBER = exports.MERCHANT_CARD_USER_LIKE_SCOPED_TOKEN_ID = exports.BIND_SHARE_REFEREE_WITH_SIGNATURE_SELECTOR = exports.APPLY_DISCOVER_SHARE_CLICK_WITH_SIGNATURE_SELECTOR = exports.APPLY_USER_LIKE_WITH_SIGNATURE_SELECTOR = exports.BURN_USER_CUMULATIVE_STAT_SELECTOR = exports.RECORD_USER_CUMULATIVE_STAT_SELECTOR = exports.CONFIGURE_EVENT_REWARD_RULES_BATCH_SELECTOR = exports.CONFIGURE_EVENT_REWARD_RULE_SELECTOR = exports.BOOTSTRAP_ISSUED_NFT_V2_STAT_SELECTOR = exports.INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR = exports.CHARGE_REWARD_V2_IFACE = exports.USER_CUMULATIVE_STAT_IFACE = void 0;
exports.buildFundSocialExchangeUsdcEscrowCalldata = buildFundSocialExchangeUsdcEscrowCalldata;
exports.buildInitializeCardUserCumulativeStatCalldata = buildInitializeCardUserCumulativeStatCalldata;
exports.buildBootstrapIssuedNftV2StatCalldata = buildBootstrapIssuedNftV2StatCalldata;
exports.buildConfigureEventRewardRuleCalldata = buildConfigureEventRewardRuleCalldata;
exports.buildConfigureEventRewardRulesBatchCalldata = buildConfigureEventRewardRulesBatchCalldata;
exports.buildRecordUserCumulativeStatCalldata = buildRecordUserCumulativeStatCalldata;
exports.buildBurnUserCumulativeStatCalldata = buildBurnUserCumulativeStatCalldata;
exports.buildApplyUserLikeWithSignatureCalldata = buildApplyUserLikeWithSignatureCalldata;
exports.buildApplyDiscoverShareClickWithSignatureCalldata = buildApplyDiscoverShareClickWithSignatureCalldata;
exports.buildBindShareRefereeWithSignatureCalldata = buildBindShareRefereeWithSignatureCalldata;
exports.buildRecordTopupCumulativeStatCalldata = buildRecordTopupCumulativeStatCalldata;
exports.buildPurchaseRewardProgramCalldata = buildPurchaseRewardProgramCalldata;
exports.buildDispatchEventReward13Calldata = buildDispatchEventReward13Calldata;
exports.readActiveTopupSocialRewardRule = readActiveTopupSocialRewardRule;
exports.cardSupportsApplyUserLikeWithSignature = cardSupportsApplyUserLikeWithSignature;
exports.cardSupportsApplyDiscoverShareClickWithSignature = cardSupportsApplyDiscoverShareClickWithSignature;
exports.cardSupportsBindShareRefereeWithSignature = cardSupportsBindShareRefereeWithSignature;
exports.encodeGatewayInvokeCardFactoryCalldata = encodeGatewayInvokeCardFactoryCalldata;
exports.readCardUserCumulativeStatStatus = readCardUserCumulativeStatStatus;
exports.cardSupportsChargeRewardFallback = cardSupportsChargeRewardFallback;
exports.assertCardSupportsChargeRewardFallback = assertCardSupportsChargeRewardFallback;
exports.assertSocialExchangeClaimViaCardFallback = assertSocialExchangeClaimViaCardFallback;
exports.buildGatewayRewardPoolForwardBody = buildGatewayRewardPoolForwardBody;
exports.verifyDiscoverShareClickAttestation = verifyDiscoverShareClickAttestation;
exports.readUserLikeScopedTokenBalance = readUserLikeScopedTokenBalance;
/**
 * User cumulative stat (IssuedNft V2) + #13 reward pool (ChargeReward V2) — Cluster 预检与 calldata 构建。
 * Master 写路径：owner/admin 经 executeForOwner；gateway-only 端点见 beamioServer 骨架（501）。
 */
const ethers_1 = require("ethers");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
const MemberCard_1 = require("./MemberCard");
const db_1 = require("./db");
const couponMetadataCategory_1 = require("./couponMetadataCategory");
const chainAddresses_1 = require("./chainAddresses");
exports.USER_CUMULATIVE_STAT_IFACE = new ethers_1.ethers.Interface([
    'function initializeCardUserCumulativeStatTokens()',
    'function bootstrapIssuedNftV2StatTokens(uint256 parentTokenId)',
    'function cardUserCumulativeStatTokensInitialized() view returns (bool)',
    'function recordUserCumulativeStat(address wallet, uint8 metricKind, uint8 targetKind, uint256 issuedParentId, uint256 delta)',
    'function burnUserCumulativeStatByGateway(address wallet, uint8 metricKind, uint8 targetKind, uint256 issuedParentId, uint256 delta)',
    'function applyUserLikeWithSignature(address userEOA, uint8 targetKind, uint256 issuedParentId, bool liked, uint256 deadline, bytes32 nonce, bytes userSignature)',
    'function applyDiscoverShareClickWithSignature(address actorEOA, address refWallet, uint8 targetKind, uint256 issuedParentId, uint256 deadline, bytes32 nonce, bytes userSignature)',
    'function bindShareRefereeWithSignature(address downlineEOA, address refereeEOA, uint256 deadline, bytes32 nonce, bytes userSignature) returns (address downlineAA, address refereeAA)',
    'function resolveUserCumulativeStatTokenId(uint8 metricKind, uint8 targetKind, uint256 issuedParentId) view returns (uint256 globalTokenId, uint256 scopedTokenId)',
]);
exports.CHARGE_REWARD_V2_IFACE = new ethers_1.ethers.Interface([
    'function configureEventRewardRule(uint256 ruleId, bool active, uint8 eventKind, uint8 targetKind, uint256 issuedParentId, uint256 actorMint13, uint256 refMint13)',
    'function configureEventRewardRulesBatch((uint256 ruleId,bool active,uint8 eventKind,uint8 targetKind,uint256 issuedParentId,uint256 actorMint13,uint256 refMint13)[] configs)',
    'function purchaseRewardProgram(address payerEOA, uint8 assetKind, uint256 amount, uint256 budget13PerUnit, uint8 cumulativeTargetKind, uint256 cumulativeIssuedParentId)',
    'function dispatchEventReward13(uint256 ruleId, address actorWallet, address refWallet, uint8 cumulativeTargetKind, uint256 cumulativeIssuedParentId, uint256 cumulativeDelta)',
    'function recordTopupCumulativeStat(address userEOA, uint256 points6)',
    'function recordChargeReferrerReward(address userEOA, uint256 amountFiat6)',
    'function rewardMintBudget13() view returns (uint256)',
    'function fundSocialExchangeUsdcEscrow(address payerEOA, uint256 amount6)',
    'function rewardEscrowUsdc6() view returns (uint256)',
    'function burnSocialPointsFromUserForExchange(address userEOA, uint256 pointsCost)',
    'function payoutSocialExchangeUsdcToUser(address userEOA, uint256 usdcReward6)',
    // Charge path: atomic #13 → #0 / #13 → Conet-USDC (to AA) + merchant oracle spread
    'function convertReward13ToPointsRatioE6() view returns (uint256)',
    'function convertReward13ToUsdcRatioE6() view returns (uint256)',
    'function merchantOracleSpreadBps() view returns (uint256)',
    'function quoteUsdcDepositForFiat6(uint256 fiatAmount6) view returns (uint256 usdcNeeded6)',
    'function quoteUsdcWithdrawForFiat6(uint256 fiatAmount6) view returns (uint256 usdcOut6)',
    'function setConvertReward13ToPointsRatio(uint256 ratioE6)',
    'function setConvertReward13ToUsdcRatio(uint256 ratioE6)',
    'function setMerchantOracleSpreadBps(uint256 spreadBps)',
    'function convertReward13ToProgramPoints(address userEOA, uint256 burn13) returns (uint256 minted0)',
    'function convertReward13ToUsdcToAa(address userEOA, uint256 burn13) returns (uint256 usdcOut6)',
    // Atomic multi-source top-up (peer #13 → USDC to target card + same-store #13 → #0)
    'function peerRedeem13ForContainerTopup(address userEOA, uint256 burn13, uint256 usdcOut6, address targetCard) returns (uint256 paidUsdc6)',
    'function topupWithReward13Container(address userEOA, uint256 sameStoreBurn13, uint256 peerUsdcCredited6, uint256 pointsFromPeerUsdc6, uint256 minTotalPointsOut0, uint256 deadline, bytes32 nonce) returns (uint256 minted0Total)',
]);
exports.INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR = exports.USER_CUMULATIVE_STAT_IFACE.getFunction('initializeCardUserCumulativeStatTokens')?.selector ?? '0xe6848b85';
exports.BOOTSTRAP_ISSUED_NFT_V2_STAT_SELECTOR = exports.USER_CUMULATIVE_STAT_IFACE.getFunction('bootstrapIssuedNftV2StatTokens')?.selector ?? '0xf5ac2f52';
exports.CONFIGURE_EVENT_REWARD_RULE_SELECTOR = exports.CHARGE_REWARD_V2_IFACE.getFunction('configureEventRewardRule')?.selector ?? '0x3dd26ef8';
exports.CONFIGURE_EVENT_REWARD_RULES_BATCH_SELECTOR = exports.CHARGE_REWARD_V2_IFACE.getFunction('configureEventRewardRulesBatch')?.selector ?? '0x00000000';
exports.RECORD_USER_CUMULATIVE_STAT_SELECTOR = exports.USER_CUMULATIVE_STAT_IFACE.getFunction('recordUserCumulativeStat')?.selector ?? '0xba62e9d5';
exports.BURN_USER_CUMULATIVE_STAT_SELECTOR = exports.USER_CUMULATIVE_STAT_IFACE.getFunction('burnUserCumulativeStatByGateway')?.selector ?? '0x00000000';
/** Plan A: user EIP-712 like/unlike on card (no Factory gatewayInvokeCard). */
exports.APPLY_USER_LIKE_WITH_SIGNATURE_SELECTOR = exports.USER_CUMULATIVE_STAT_IFACE.getFunction('applyUserLikeWithSignature')?.selector ?? '0x4e5759fe';
/** Plan A: Discover share-link click (USER_CLICK + REF_CLICK) without Factory gatewayInvokeCard. */
exports.APPLY_DISCOVER_SHARE_CLICK_WITH_SIGNATURE_SELECTOR = exports.USER_CUMULATIVE_STAT_IFACE.getFunction('applyDiscoverShareClickWithSignature')?.selector ?? '0x2f2c0f7b';
/** Plan A: share-landing referee bind (registerReferee + setRefereeReferrer via EIP-712). */
exports.BIND_SHARE_REFEREE_WITH_SIGNATURE_SELECTOR = exports.USER_CUMULATIVE_STAT_IFACE.getFunction('bindShareRefereeWithSignature')?.selector ?? '0x00000000';
/** L1 merchant-card user-like scoped stat token (UserCumulativeStatLib.MERCHANT_CARD_LIKE_TOKEN_ID). */
exports.MERCHANT_CARD_USER_LIKE_SCOPED_TOKEN_ID = 19n;
/** Issued NFT series start (matches BeamioERC1155Logic.ISSUED_NFT_START_ID). */
exports.ISSUED_NFT_START_ID_MEMBER = 100000000000n;
exports.RECORD_USER_LIKE_EIP712_TYPE = {
    RecordUserLike: [
        { name: 'cardAddress', type: 'address' },
        { name: 'userEOA', type: 'address' },
        { name: 'targetKind', type: 'uint8' },
        { name: 'issuedParentId', type: 'uint256' },
        { name: 'liked', type: 'bool' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
exports.RECORD_DISCOVER_SHARE_CLICK_EIP712_TYPE = {
    RecordDiscoverShareClick: [
        { name: 'cardAddress', type: 'address' },
        { name: 'actorEOA', type: 'address' },
        { name: 'refWallet', type: 'address' },
        { name: 'targetKind', type: 'uint8' },
        { name: 'issuedParentId', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
exports.BIND_SHARE_REFEREE_EIP712_TYPE = {
    BindShareReferee: [
        { name: 'cardAddress', type: 'address' },
        { name: 'downlineEOA', type: 'address' },
        { name: 'refereeEOA', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
/** @deprecated use RECORD_USER_LIKE_EIP712_TYPE */
exports.RECORD_MERCHANT_CARD_USER_LIKE_EIP712_TYPE = exports.RECORD_USER_LIKE_EIP712_TYPE;
exports.RECORD_TOPUP_CUMULATIVE_STAT_SELECTOR = exports.CHARGE_REWARD_V2_IFACE.getFunction('recordTopupCumulativeStat')?.selector ?? '0x5a3f1b55';
exports.PURCHASE_REWARD_PROGRAM_SELECTOR = exports.CHARGE_REWARD_V2_IFACE.getFunction('purchaseRewardProgram')?.selector ?? '0xa9eaf30f';
exports.DISPATCH_EVENT_REWARD13_SELECTOR = exports.CHARGE_REWARD_V2_IFACE.getFunction('dispatchEventReward13')?.selector ?? '0x19b043d8';
exports.FUND_SOCIAL_EXCHANGE_USDC_ESCROW_SELECTOR = exports.CHARGE_REWARD_V2_IFACE.getFunction('fundSocialExchangeUsdcEscrow')?.selector ?? '0x00000000';
exports.CLAIM_SOCIAL_EXCHANGE_WITH_USER_SIGNATURE_SELECTOR = new ethers_1.ethers.Interface([
    'function claimSocialExchangeWithUserSignature(address userEOA,uint256 tokenId,uint256 pointsCost,uint256 usdcReward6,uint256 deadline,bytes32 nonce,bytes userSignature)',
]).getFunction('claimSocialExchangeWithUserSignature')?.selector ?? '0xef79d366';
function buildFundSocialExchangeUsdcEscrowCalldata(payerEOA, amount6) {
    return exports.CHARGE_REWARD_V2_IFACE.encodeFunctionData('fundSocialExchangeUsdcEscrow', [
        ethers_1.ethers.getAddress(payerEOA),
        BigInt(amount6),
    ]);
}
/** UserCumulativeStatLib metric kinds (subset for API validation). */
exports.UC_METRIC = {
    TOPUP: 1,
    CHARGE: 2,
    USER_CLICK: 3,
    USER_COMMENT: 4,
    USER_LIKE: 5,
    USER_PURCHASE: 6,
    REF_CLICK: 7,
    REF_CLAIM: 8,
    REF_BURN: 9,
    REF_LIKE: 10,
    REF_COMMENT: 11,
    REF_PURCHASE: 12,
    INSTALL: 13,
    REF_INSTALL: 14,
};
exports.UC_TARGET = {
    GLOBAL_ONLY: 0,
    MERCHANT_CARD_COUPON: 1,
    ISSUED_COUPON: 2,
};
async function rejectDelistedIssuedCouponSocial(cardAddress, targetKind, issuedParentId) {
    if (targetKind !== exports.UC_TARGET.ISSUED_COUPON || issuedParentId <= 0n)
        return null;
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const series = await (0, db_1.getSeriesByCardAndTokenId)(card, String(issuedParentId));
        if (series?.metadata && (0, couponMetadataCategory_1.readCouponDisabledFromMetadata)(series.metadata)) {
            return { success: false, error: 'This coupon is delisted.' };
        }
    }
    catch {
        /* untrusted read: do not block */
    }
    return null;
}
/** RewardPoolStorage asset kinds supported by purchaseRewardProgram (USDC/GB/B-Unit 仍 revert)。 */
exports.UC_REWARD_ASSET = {
    POINTS0: 1,
    CHARGE_REWARD2: 2,
    VOUCHER13: 3,
};
const EXECUTE_FOR_OWNER_TYPES = {
    ExecuteForOwner: [
        { name: 'cardAddress', type: 'address' },
        { name: 'dataHash', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
const EXECUTE_FOR_ADMIN_TYPES = {
    ExecuteForAdmin: [
        { name: 'cardAddress', type: 'address' },
        { name: 'dataHash', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
function buildInitializeCardUserCumulativeStatCalldata() {
    return exports.USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('initializeCardUserCumulativeStatTokens', []);
}
function buildBootstrapIssuedNftV2StatCalldata(parentTokenId) {
    return exports.USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('bootstrapIssuedNftV2StatTokens', [BigInt(parentTokenId)]);
}
function buildConfigureEventRewardRuleCalldata(args) {
    return exports.CHARGE_REWARD_V2_IFACE.encodeFunctionData('configureEventRewardRule', [
        BigInt(args.ruleId),
        args.active,
        args.eventKind,
        args.targetKind,
        BigInt(args.issuedParentId),
        BigInt(args.actorMint13),
        BigInt(args.refMint13),
    ]);
}
function buildConfigureEventRewardRulesBatchCalldata(configs) {
    const rows = configs.map((c) => ({
        ruleId: BigInt(c.ruleId),
        active: c.active,
        eventKind: c.eventKind,
        targetKind: c.targetKind,
        issuedParentId: BigInt(c.issuedParentId),
        actorMint13: c.active ? BigInt(c.actorMint13) : 0n,
        refMint13: c.active ? BigInt(c.refMint13) : 0n,
    }));
    return exports.CHARGE_REWARD_V2_IFACE.encodeFunctionData('configureEventRewardRulesBatch', [rows]);
}
function buildRecordUserCumulativeStatCalldata(args) {
    return exports.USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('recordUserCumulativeStat', [
        ethers_1.ethers.getAddress(args.wallet),
        args.metricKind,
        args.targetKind,
        BigInt(args.issuedParentId),
        BigInt(args.delta),
    ]);
}
/** Unlike = burn user-held like stat tokens (ERC1155 `_update` to `address(0)` semantics). */
function buildBurnUserCumulativeStatCalldata(args) {
    return exports.USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('burnUserCumulativeStatByGateway', [
        ethers_1.ethers.getAddress(args.wallet),
        args.metricKind,
        args.targetKind,
        BigInt(args.issuedParentId),
        BigInt(args.delta),
    ]);
}
function buildApplyUserLikeWithSignatureCalldata(args) {
    const nonceBytes32 = args.nonce.length === 66 && args.nonce.startsWith('0x')
        ? args.nonce
        : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(args.nonce));
    return exports.USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('applyUserLikeWithSignature', [
        ethers_1.ethers.getAddress(args.userEOA),
        args.targetKind,
        BigInt(args.issuedParentId),
        args.liked,
        BigInt(args.deadline),
        nonceBytes32,
        args.userSignature,
    ]);
}
function buildApplyDiscoverShareClickWithSignatureCalldata(args) {
    const nonceBytes32 = args.nonce.length === 66 && args.nonce.startsWith('0x')
        ? args.nonce
        : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(args.nonce));
    const refWallet = args.refWallet && ethers_1.ethers.isAddress(args.refWallet) ? ethers_1.ethers.getAddress(args.refWallet) : ethers_1.ethers.ZeroAddress;
    return exports.USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('applyDiscoverShareClickWithSignature', [
        ethers_1.ethers.getAddress(args.actorEOA),
        refWallet,
        args.targetKind,
        BigInt(args.issuedParentId),
        BigInt(args.deadline),
        nonceBytes32,
        args.userSignature,
    ]);
}
function buildBindShareRefereeWithSignatureCalldata(args) {
    const nonceBytes32 = args.nonce.length === 66 && args.nonce.startsWith('0x')
        ? args.nonce
        : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(args.nonce));
    return exports.USER_CUMULATIVE_STAT_IFACE.encodeFunctionData('bindShareRefereeWithSignature', [
        ethers_1.ethers.getAddress(args.downlineEOA),
        ethers_1.ethers.getAddress(args.refereeEOA),
        BigInt(args.deadline),
        nonceBytes32,
        args.userSignature,
    ]);
}
function buildRecordTopupCumulativeStatCalldata(userEOA, points6) {
    return exports.CHARGE_REWARD_V2_IFACE.encodeFunctionData('recordTopupCumulativeStat', [
        ethers_1.ethers.getAddress(userEOA),
        BigInt(points6),
    ]);
}
function buildPurchaseRewardProgramCalldata(args) {
    return exports.CHARGE_REWARD_V2_IFACE.encodeFunctionData('purchaseRewardProgram', [
        ethers_1.ethers.getAddress(args.payerEOA),
        args.assetKind,
        BigInt(args.amount),
        BigInt(args.budget13PerUnit),
        args.cumulativeTargetKind,
        BigInt(args.cumulativeIssuedParentId),
    ]);
}
function buildDispatchEventReward13Calldata(args) {
    return exports.CHARGE_REWARD_V2_IFACE.encodeFunctionData('dispatchEventReward13', [
        BigInt(args.ruleId),
        ethers_1.ethers.getAddress(args.actorWallet),
        args.refWallet && ethers_1.ethers.isAddress(args.refWallet) ? ethers_1.ethers.getAddress(args.refWallet) : ethers_1.ethers.ZeroAddress,
        args.cumulativeTargetKind,
        BigInt(args.cumulativeIssuedParentId),
        BigInt(args.cumulativeDelta),
    ]);
}
/**
 * @deprecated Legacy Social Promotion fixed-mint top-up slot.
 * Same-cycle Top-up Reward PT / Referrer use **ratio E6** storage
 * (`topupActorRewardRatioE6` / `referrerTopupAmountRatioE6`) via `recordTopupCumulativeStat`.
 * Do **not** mint #13 from `getRewardRule(2)` on the top-up path.
 */
exports.SOCIAL_PROMOTION_TOPUP_RULE_ID = 2;
/** UserCumulativeStatLib.METRIC_TOPUP */
exports.UC_METRIC_TOPUP = 1;
/**
 * @deprecated Do not use for Top-up #13 mint / enqueue.
 * Rewards come from ratio E6; `enqueueTopupSocialReward13IfConfigured` is a no-op.
 * Kept for type/export stability only — always returns null.
 */
async function readActiveTopupSocialRewardRule(_cardAddress) {
    return null;
}
const FACTORY_GATEWAY_IFACE = new ethers_1.ethers.Interface([
    'function gatewayInvokeCard(address cardAddr, bytes data) returns (bytes)',
]);
const GATEWAY_INVOKE_CARD_SELECTOR = FACTORY_GATEWAY_IFACE.getFunction('gatewayInvokeCard')?.selector ?? '0x0a76307f';
async function factorySupportsGatewayInvokeCard(factoryAddress, chain = 'conet') {
    if (chain !== 'conet')
        return false;
    try {
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const code = await provider.getCode(factoryAddress);
        if (!code || code === '0x')
            return false;
        return code.toLowerCase().includes(GATEWAY_INVOKE_CARD_SELECTOR.slice(2).toLowerCase());
    }
    catch {
        return false;
    }
}
/** Plan A: IssuedNft V2 module exposes applyUserLikeWithSignature (CoNET merchant cards). */
async function cardSupportsApplyUserLikeWithSignature(cardAddress) {
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        if (chain !== 'conet')
            return false;
        const routeErr = await assertAdminStatsRoutesIssuedNftSelector(cardAddress, exports.APPLY_USER_LIKE_WITH_SIGNATURE_SELECTOR, 'applyUserLikeWithSignature');
        if (routeErr)
            return false;
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const gw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const factory = new ethers_1.ethers.Contract(gw, ['function defaultIssuedNftModule() view returns (address)'], provider);
        const issuedMod = (await factory.defaultIssuedNftModule());
        if (!issuedMod || issuedMod === ethers_1.ethers.ZeroAddress)
            return false;
        const code = await provider.getCode(issuedMod);
        if (!code || code === '0x')
            return false;
        return code.toLowerCase().includes(exports.APPLY_USER_LIKE_WITH_SIGNATURE_SELECTOR.slice(2).toLowerCase());
    }
    catch {
        return false;
    }
}
/** Plan A: IssuedNft V2 module exposes applyDiscoverShareClickWithSignature (CoNET merchant cards). */
async function cardSupportsApplyDiscoverShareClickWithSignature(cardAddress) {
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        if (chain !== 'conet')
            return false;
        const routeErr = await assertAdminStatsRoutesIssuedNftSelector(cardAddress, exports.APPLY_DISCOVER_SHARE_CLICK_WITH_SIGNATURE_SELECTOR, 'applyDiscoverShareClickWithSignature');
        if (routeErr)
            return false;
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const gw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const factory = new ethers_1.ethers.Contract(gw, ['function defaultIssuedNftModule() view returns (address)'], provider);
        const issuedMod = (await factory.defaultIssuedNftModule());
        if (!issuedMod || issuedMod === ethers_1.ethers.ZeroAddress)
            return false;
        const code = await provider.getCode(issuedMod);
        if (!code || code === '0x')
            return false;
        return code.toLowerCase().includes(exports.APPLY_DISCOVER_SHARE_CLICK_WITH_SIGNATURE_SELECTOR.slice(2).toLowerCase());
    }
    catch {
        return false;
    }
}
/**
 * AdminStats V6 is a thin router (~840 bytes): bind lives on immutable `v5()`, not in the
 * router bytecode. A needle scan of `defaultAdminStatsQueryModule` alone false-negatives
 * after the V6 cutover and rejects Discover share-link bind with 400.
 */
async function adminStatsBytecodeContainsSelector(provider, adminMod, selector) {
    const needle = selector.replace(/^0x/i, '').toLowerCase();
    const seen = new Set();
    const visit = async (addr) => {
        let checksum;
        try {
            checksum = ethers_1.ethers.getAddress(addr);
        }
        catch {
            return false;
        }
        const key = checksum.toLowerCase();
        if (seen.has(key) || checksum === ethers_1.ethers.ZeroAddress)
            return false;
        seen.add(key);
        const code = await provider.getCode(checksum);
        if (!code || code === '0x')
            return false;
        if (code.toLowerCase().includes(needle))
            return true;
        try {
            const router = new ethers_1.ethers.Contract(checksum, ['function v5() view returns (address)'], provider);
            const v5 = (await router.v5());
            if (v5 && v5 !== ethers_1.ethers.ZeroAddress)
                return visit(v5);
        }
        catch {
            /* V1–V5 have no v5() */
        }
        return false;
    };
    return visit(adminMod);
}
/** Plan A: AdminStats module exposes bindShareRefereeWithSignature (ROUTE_STATS_QUERY). */
async function cardSupportsBindShareRefereeWithSignature(cardAddress) {
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        if (chain !== 'conet')
            return false;
        const routeErr = await assertAdminStatsRoutesStatsQuerySelector(cardAddress, exports.BIND_SHARE_REFEREE_WITH_SIGNATURE_SELECTOR, 'bindShareRefereeWithSignature');
        if (routeErr)
            return false;
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const gw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const factory = new ethers_1.ethers.Contract(gw, ['function defaultAdminStatsQueryModule() view returns (address)'], provider);
        const adminMod = (await factory.defaultAdminStatsQueryModule());
        if (!adminMod || adminMod === ethers_1.ethers.ZeroAddress)
            return false;
        return adminStatsBytecodeContainsSelector(provider, adminMod, exports.BIND_SHARE_REFEREE_WITH_SIGNATURE_SELECTOR);
    }
    catch {
        return false;
    }
}
function encodeGatewayInvokeCardFactoryCalldata(cardAddress, cardCalldata) {
    return FACTORY_GATEWAY_IFACE.encodeFunctionData('gatewayInvokeCard', [
        ethers_1.ethers.getAddress(cardAddress),
        cardCalldata,
    ]);
}
async function readCardUserCumulativeStatStatus(cardAddress) {
    const card = ethers_1.ethers.getAddress(cardAddress);
    if (!(await (0, beamioUserCardChain_1.hasCoNETUserCardBytecode)(card))) {
        throw new Error(`No BeamioUserCard bytecode on CoNET at ${card}`);
    }
    const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
    const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
    const reader = new ethers_1.ethers.Contract(card, [
        'function owner() view returns (address)',
        'function cardUserCumulativeStatTokensInitialized() view returns (bool)',
    ], provider);
    const [owner, initialized] = await Promise.all([
        reader.owner(),
        reader.cardUserCumulativeStatTokensInitialized(),
    ]);
    return { ok: true, cardAddress: card, initialized: !!initialized, owner: ethers_1.ethers.getAddress(owner) };
}
async function verifyExecuteForOwnerOwnerSignature(params) {
    const card = ethers_1.ethers.getAddress(params.cardAddress);
    const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
    const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
    const code = await provider.getCode(card);
    if (!code || code === '0x')
        return { ok: false, error: 'Card contract not found on CoNET' };
    const cardReader = new ethers_1.ethers.Contract(card, ['function owner() view returns (address)'], provider);
    const owner = (await cardReader.owner());
    if (!owner || owner === ethers_1.ethers.ZeroAddress)
        return { ok: false, error: 'Card has no owner' };
    const verifyingContract = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(card);
    const chainId = (0, beamioUserCardChain_1.chainIdForUserCardChain)(chain);
    const domain = {
        name: 'BeamioUserCardFactory',
        version: '1',
        chainId,
        verifyingContract,
    };
    const dataHash = ethers_1.ethers.keccak256(params.data);
    const nonceBytes = params.nonce.length === 66 && params.nonce.startsWith('0x')
        ? params.nonce
        : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(params.nonce));
    const value = {
        cardAddress: card,
        dataHash,
        deadline: Number(params.deadline),
        nonce: nonceBytes,
    };
    const digest = ethers_1.ethers.TypedDataEncoder.hash(domain, EXECUTE_FOR_OWNER_TYPES, value);
    const signer = ethers_1.ethers.recoverAddress(digest, params.ownerSignature);
    if (signer.toLowerCase() !== ethers_1.ethers.getAddress(owner).toLowerCase()) {
        return { ok: false, error: 'ownerSignature does not match card owner' };
    }
    if (Number(params.deadline) < Math.floor(Date.now() / 1000)) {
        return { ok: false, error: 'deadline expired' };
    }
    return { ok: true, owner: ethers_1.ethers.getAddress(owner) };
}
async function verifyExecuteForAdminAdminSignature(params) {
    const card = ethers_1.ethers.getAddress(params.cardAddress);
    const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
    const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
    const code = await provider.getCode(card);
    if (!code || code === '0x')
        return { ok: false, error: 'Card contract not found on CoNET' };
    const verifyingContract = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(card);
    const chainId = (0, beamioUserCardChain_1.chainIdForUserCardChain)(chain);
    const domain = {
        name: 'BeamioUserCardFactory',
        version: '1',
        chainId,
        verifyingContract,
    };
    const dataHash = ethers_1.ethers.keccak256(params.data);
    const nonceBytes = params.nonce.length === 66 && params.nonce.startsWith('0x')
        ? params.nonce
        : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(params.nonce));
    const value = {
        cardAddress: card,
        dataHash,
        deadline: Number(params.deadline),
        nonce: nonceBytes,
    };
    const digest = ethers_1.ethers.TypedDataEncoder.hash(domain, EXECUTE_FOR_ADMIN_TYPES, value);
    const signer = ethers_1.ethers.recoverAddress(digest, params.adminSignature);
    const cardReader = new ethers_1.ethers.Contract(card, ['function isAdmin(address) view returns (bool)'], provider);
    const isAdmin = (await cardReader.isAdmin(signer));
    if (!isAdmin) {
        return { ok: false, error: `Signer is not card admin (recovered=${ethers_1.ethers.getAddress(signer)})` };
    }
    if (Number(params.deadline) < Math.floor(Date.now() / 1000)) {
        return { ok: false, error: 'deadline expired' };
    }
    return { ok: true, signer: ethers_1.ethers.getAddress(signer) };
}
async function assertAdminStatsRoutesIssuedNftSelector(cardAddress, selector, label) {
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const gw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const factory = new ethers_1.ethers.Contract(gw, ['function defaultAdminStatsQueryModule() view returns (address)'], provider);
        const adminStats = (await factory.defaultAdminStatsQueryModule());
        if (!adminStats || adminStats === ethers_1.ethers.ZeroAddress) {
            return `factory defaultAdminStatsQueryModule not configured (${label})`;
        }
        const routeReader = new ethers_1.ethers.Contract(adminStats, ['function selectorModuleKind(bytes4) view returns (uint8)'], provider);
        const kind = Number(await routeReader.selectorModuleKind(selector));
        // BeamioUserCardModuleKinds.ISSUED_NFT = 2
        if (kind !== 2) {
            return `AdminStatsQueryModule routes ${label} to kind=${kind}, expected 2 (IssuedNft)`;
        }
        return null;
    }
    catch (e) {
        const err = e;
        return err?.message ?? String(e);
    }
}
/** ROUTE_STATS_QUERY = type(uint8).max - 1 = 254 — handled by AdminStats module itself. */
async function assertAdminStatsRoutesStatsQuerySelector(cardAddress, selector, label) {
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const gw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const factory = new ethers_1.ethers.Contract(gw, ['function defaultAdminStatsQueryModule() view returns (address)'], provider);
        const adminStats = (await factory.defaultAdminStatsQueryModule());
        if (!adminStats || adminStats === ethers_1.ethers.ZeroAddress) {
            return `factory defaultAdminStatsQueryModule not configured (${label})`;
        }
        const routeReader = new ethers_1.ethers.Contract(adminStats, ['function selectorModuleKind(bytes4) view returns (uint8)'], provider);
        const kind = Number(await routeReader.selectorModuleKind(selector));
        if (kind !== 254) {
            return `AdminStatsQueryModule routes ${label} to kind=${kind}, expected 254 (STATS_QUERY)`;
        }
        return null;
    }
    catch (e) {
        const err = e;
        return err?.message ?? String(e);
    }
}
/**
 * Runtime bytecode needles for BeamioUserCard fallback ChargeReward (kind=5) routing.
 * V12 CREATE: PUSH2 0x0745 JUMPI → PUSH2 0x3b9b JUMP (includes MODULE_CHARGE_REWARD).
 * V13 beacon impl: function dispatcher PUSH4 initialize(string,uint8,uint256,address,address)
 *   (`0x1897af89`) — V13 source always includes MODULE_CHARGE_REWARD; jump dests moved after P1.
 * Old CREATE: same V12 JUMPI → PUSH2 0x3b88 JUMP (no ChargeReward → BM_CallFailed).
 */
const USER_CARD_CHARGE_REWARD_FALLBACK_SUPPORTED_NEEDLES = [
    '610745613b9b56',
    '631897af8914',
];
const USER_CARD_CHARGE_REWARD_FALLBACK_LEGACY_NEEDLE = '610745613b8856';
/** EIP-1967 implementation slot (UUPS / transparent). */
const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** EIP-1967 beacon slot (BeaconProxy). */
const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
function bytecodeSupportsChargeRewardFallback(codeHex) {
    const hex = codeHex.toLowerCase().replace(/^0x/, '');
    if (!hex || hex === '')
        return null;
    if (USER_CARD_CHARGE_REWARD_FALLBACK_SUPPORTED_NEEDLES.some((n) => hex.includes(n)))
        return true;
    if (hex.includes(USER_CARD_CHARGE_REWARD_FALLBACK_LEGACY_NEEDLE))
        return false;
    return null;
}
async function resolveProxyImplementationCode(provider, proxyAddress) {
    try {
        const beaconRaw = await provider.getStorage(proxyAddress, EIP1967_BEACON_SLOT);
        const beacon = ethers_1.ethers.getAddress(`0x${beaconRaw.slice(-40)}`);
        if (beacon !== ethers_1.ethers.ZeroAddress) {
            const beaconReader = new ethers_1.ethers.Contract(beacon, ['function implementation() view returns (address)'], provider);
            const impl = (await beaconReader.implementation());
            if (impl && impl !== ethers_1.ethers.ZeroAddress) {
                const code = await provider.getCode(impl);
                if (code && code !== '0x')
                    return code;
            }
        }
    }
    catch {
        /* not a beacon proxy */
    }
    try {
        const implRaw = await provider.getStorage(proxyAddress, EIP1967_IMPLEMENTATION_SLOT);
        const impl = ethers_1.ethers.getAddress(`0x${implRaw.slice(-40)}`);
        if (impl !== ethers_1.ethers.ZeroAddress) {
            const code = await provider.getCode(impl);
            if (code && code !== '0x')
                return code;
        }
    }
    catch {
        /* not an ERC1967 impl proxy */
    }
    return null;
}
/**
 * True when the card runtime (or its beacon/ERC1967 implementation) includes the
 * MODULE_CHARGE_REWARD fallback branch. Fail-closed on RPC / empty code / unknown bytecode.
 */
async function cardSupportsChargeRewardFallback(cardAddress) {
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const code = await provider.getCode(card);
        if (!code || code === '0x')
            return false;
        const direct = bytecodeSupportsChargeRewardFallback(code);
        if (direct !== null)
            return direct;
        const implCode = await resolveProxyImplementationCode(provider, card);
        if (!implCode)
            return false;
        const viaProxy = bytecodeSupportsChargeRewardFallback(implCode);
        return viaProxy === true;
    }
    catch {
        return false;
    }
}
/**
 * Pre-check helper: returns English error when the card cannot route ChargeReward selectors.
 * Fail-closed (RPC / unknown bytecode → error).
 */
async function assertCardSupportsChargeRewardFallback(cardAddress) {
    const supported = await cardSupportsChargeRewardFallback(cardAddress);
    if (supported)
        return null;
    return (`This merchant card runtime does not support ChargeReward fallback (MODULE_CHARGE_REWARD / kind=5). ` +
        `Social Promotion Top-up / configureEventRewardRule(s) would revert with BM_CallFailed on-chain. ` +
        `Upgrade to a card whose bytecode includes ChargeReward routing (V12+), or re-issue via the beacon proxy path.`);
}
async function assertAdminStatsRoutesChargeRewardSelector(cardAddress, selector, label) {
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const gw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const factory = new ethers_1.ethers.Contract(gw, ['function defaultAdminStatsQueryModule() view returns (address)'], provider);
        const adminStats = (await factory.defaultAdminStatsQueryModule());
        if (!adminStats || adminStats === ethers_1.ethers.ZeroAddress) {
            return `factory defaultAdminStatsQueryModule not configured (${label})`;
        }
        const routeReader = new ethers_1.ethers.Contract(adminStats, ['function selectorModuleKind(bytes4) view returns (uint8)'], provider);
        const kind = Number(await routeReader.selectorModuleKind(selector));
        // BeamioUserCardModuleKinds.CHARGE_REWARD = 5
        if (kind !== 5) {
            return `AdminStatsQueryModule routes ${label} to kind=${kind}, expected 5 (ChargeReward)`;
        }
        const fallbackErr = await assertCardSupportsChargeRewardFallback(cardAddress);
        if (fallbackErr)
            return fallbackErr;
        return null;
    }
    catch (e) {
        const err = e;
        return err?.message ?? String(e);
    }
}
/** Legacy merchant cards: claim via card fallback → IssuedNftModuleV2 (AdminStats routes selector). */
async function assertSocialExchangeClaimViaCardFallback(cardAddress) {
    const routeErr = await assertAdminStatsRoutesIssuedNftSelector(cardAddress, exports.CLAIM_SOCIAL_EXCHANGE_WITH_USER_SIGNATURE_SELECTOR, 'claimSocialExchangeWithUserSignature');
    if (routeErr)
        return routeErr;
    try {
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const gw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const factory = new ethers_1.ethers.Contract(gw, ['function defaultIssuedNftModule() view returns (address)'], provider);
        const mod = (await factory.defaultIssuedNftModule());
        if (!mod || mod === ethers_1.ethers.ZeroAddress) {
            return 'factory defaultIssuedNftModule not configured (claimSocialExchangeWithUserSignature)';
        }
        const code = await provider.getCode(mod);
        const needle = exports.CLAIM_SOCIAL_EXCHANGE_WITH_USER_SIGNATURE_SELECTOR.slice(2).toLowerCase();
        if (!code || code === '0x' || !code.toLowerCase().includes(needle)) {
            return 'IssuedNftModule missing claimSocialExchangeWithUserSignature; run upgradeSocialExchangeModulesConet.ts';
        }
        return null;
    }
    catch (e) {
        const err = e;
        return err?.message ?? String(e);
    }
}
/** Cluster：卡主 initializeCardUserCumulativeStatTokens（幂等；已初始化则拒绝）。 */
const cardInitializeUserCumulativeStatPreCheck = async (body) => {
    const { cardAddress, deadline, nonce, ownerSignature } = body;
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (deadline == null || !nonce || !ownerSignature) {
        return { success: false, error: 'Missing deadline, nonce, or ownerSignature' };
    }
    const data = body.data && typeof body.data === 'string' && body.data.length >= 10
        ? body.data
        : buildInitializeCardUserCumulativeStatCalldata();
    if (data.slice(0, 10).toLowerCase() !== exports.INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR.toLowerCase()) {
        return { success: false, error: 'data must be initializeCardUserCumulativeStatTokens() calldata' };
    }
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const status = await readCardUserCumulativeStatStatus(card);
        if (status.initialized) {
            return { success: false, error: 'cardUserCumulativeStatTokens already initialized (idempotent no-op on-chain)' };
        }
        const routeErr = await assertAdminStatsRoutesIssuedNftSelector(card, exports.INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR, 'initializeCardUserCumulativeStatTokens');
        if (routeErr)
            return { success: false, error: routeErr };
        const sig = await verifyExecuteForOwnerOwnerSignature({
            cardAddress: card,
            data,
            deadline: Number(deadline),
            nonce: String(nonce),
            ownerSignature: String(ownerSignature),
        });
        if (!sig.ok)
            return { success: false, error: sig.error };
        return {
            success: true,
            preChecked: {
                cardAddress: card,
                data,
                deadline: Number(deadline),
                nonce: String(nonce),
                ownerSignature: String(ownerSignature),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardInitializeUserCumulativeStatPreCheck = cardInitializeUserCumulativeStatPreCheck;
/** Cluster：旧 issued 系列 bootstrapIssuedNftV2StatTokens(parentTokenId)。 */
const cardBootstrapIssuedNftV2StatPreCheck = async (body) => {
    const { cardAddress, parentTokenId, deadline, nonce, ownerSignature } = body;
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (parentTokenId == null && !body.data)
        return { success: false, error: 'Missing parentTokenId or data' };
    if (deadline == null || !nonce || !ownerSignature) {
        return { success: false, error: 'Missing deadline, nonce, or ownerSignature' };
    }
    const parentId = parentTokenId != null ? BigInt(parentTokenId) : undefined;
    if (parentId != null && parentId < exports.ISSUED_NFT_START_ID_MEMBER) {
        return { success: false, error: `parentTokenId must be >= ${exports.ISSUED_NFT_START_ID_MEMBER}` };
    }
    const data = body.data && typeof body.data === 'string' && body.data.length >= 10
        ? body.data
        : buildBootstrapIssuedNftV2StatCalldata(parentId ?? 0n);
    if (data.slice(0, 10).toLowerCase() !== exports.BOOTSTRAP_ISSUED_NFT_V2_STAT_SELECTOR.toLowerCase()) {
        return { success: false, error: 'data must be bootstrapIssuedNftV2StatTokens(uint256) calldata' };
    }
    try {
        const decoded = exports.USER_CUMULATIVE_STAT_IFACE.parseTransaction({ data });
        if (!decoded || decoded.name !== 'bootstrapIssuedNftV2StatTokens') {
            return { success: false, error: 'Invalid bootstrapIssuedNftV2StatTokens calldata' };
        }
        const decodedParent = BigInt(decoded.args[0]);
        if (decodedParent < exports.ISSUED_NFT_START_ID_MEMBER) {
            return { success: false, error: `parentTokenId must be >= ${exports.ISSUED_NFT_START_ID_MEMBER}` };
        }
        const card = ethers_1.ethers.getAddress(cardAddress);
        const status = await readCardUserCumulativeStatStatus(card);
        if (!status.initialized) {
            return {
                success: false,
                error: 'cardUserCumulativeStatTokens not initialized; call cardInitializeUserCumulativeStat first',
            };
        }
        const routeErr = await assertAdminStatsRoutesIssuedNftSelector(card, exports.BOOTSTRAP_ISSUED_NFT_V2_STAT_SELECTOR, 'bootstrapIssuedNftV2StatTokens');
        if (routeErr)
            return { success: false, error: routeErr };
        const sig = await verifyExecuteForOwnerOwnerSignature({
            cardAddress: card,
            data,
            deadline: Number(deadline),
            nonce: String(nonce),
            ownerSignature: String(ownerSignature),
        });
        if (!sig.ok)
            return { success: false, error: sig.error };
        return {
            success: true,
            preChecked: {
                cardAddress: card,
                data,
                deadline: Number(deadline),
                nonce: String(nonce),
                ownerSignature: String(ownerSignature),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardBootstrapIssuedNftV2StatPreCheck = cardBootstrapIssuedNftV2StatPreCheck;
function configureEventRewardRuleCalldataFromBody(body) {
    const data = body.data && typeof body.data === 'string' && body.data.length >= 10
        ? body.data
        : buildConfigureEventRewardRuleCalldata({
            ruleId: body.ruleId ?? 0,
            active: body.active !== false,
            eventKind: Number(body.eventKind ?? 0),
            targetKind: Number(body.targetKind ?? 0),
            issuedParentId: body.issuedParentId ?? 0,
            actorMint13: body.actorMint13 ?? 0,
            refMint13: body.refMint13 ?? 0,
        });
    if (data.slice(0, 10).toLowerCase() !== exports.CONFIGURE_EVENT_REWARD_RULE_SELECTOR.toLowerCase()) {
        return { ok: false, error: 'data must be configureEventRewardRule(...) calldata' };
    }
    return { ok: true, data };
}
/** Cluster：card admin 配置 #13 奖励规则 configureEventRewardRule（executeForAdmin → onlyOwnerOrGateway）。 */
const cardConfigureEventRewardRuleAdminPreCheck = async (body) => {
    const { cardAddress, deadline, nonce, adminSignature } = body;
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (deadline == null || !nonce || !adminSignature) {
        return { success: false, error: 'Missing deadline, nonce, or adminSignature' };
    }
    const calldata = configureEventRewardRuleCalldataFromBody(body);
    if (!calldata.ok)
        return { success: false, error: calldata.error };
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(card, exports.CONFIGURE_EVENT_REWARD_RULE_SELECTOR, 'configureEventRewardRule');
        if (routeErr)
            return { success: false, error: routeErr };
        const sig = await verifyExecuteForAdminAdminSignature({
            cardAddress: card,
            data: calldata.data,
            deadline: Number(deadline),
            nonce: String(nonce),
            adminSignature: String(adminSignature),
        });
        if (!sig.ok)
            return { success: false, error: sig.error };
        return {
            success: true,
            preChecked: {
                cardAddress: card,
                data: calldata.data,
                deadline: Number(deadline),
                nonce: String(nonce),
                adminSignature: String(adminSignature),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardConfigureEventRewardRuleAdminPreCheck = cardConfigureEventRewardRuleAdminPreCheck;
/** Cluster：owner 配置 #13 奖励规则 configureEventRewardRule。 */
const cardConfigureEventRewardRulePreCheck = async (body) => {
    const { cardAddress, deadline, nonce, ownerSignature } = body;
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (deadline == null || !nonce || !ownerSignature) {
        return { success: false, error: 'Missing deadline, nonce, or ownerSignature' };
    }
    const calldata = configureEventRewardRuleCalldataFromBody(body);
    if (!calldata.ok)
        return { success: false, error: calldata.error };
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(card, exports.CONFIGURE_EVENT_REWARD_RULE_SELECTOR, 'configureEventRewardRule');
        if (routeErr)
            return { success: false, error: routeErr };
        const sig = await verifyExecuteForOwnerOwnerSignature({
            cardAddress: card,
            data: calldata.data,
            deadline: Number(deadline),
            nonce: String(nonce),
            ownerSignature: String(ownerSignature),
        });
        if (!sig.ok)
            return { success: false, error: sig.error };
        return {
            success: true,
            preChecked: {
                cardAddress: card,
                data: calldata.data,
                deadline: Number(deadline),
                nonce: String(nonce),
                ownerSignature: String(ownerSignature),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardConfigureEventRewardRulePreCheck = cardConfigureEventRewardRulePreCheck;
/** Cluster：gateway configureEventRewardRule（与 cardDispatchEventReward13 同路径，无需 owner/admin 签名）。 */
const cardConfigureEventRewardRuleGatewayPreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    const ruleId = BigInt(body.ruleId ?? 0);
    if (ruleId <= 0n)
        return { success: false, error: 'ruleId must be > 0' };
    const eventKind = Number(body.eventKind ?? 0);
    const targetKind = Number(body.targetKind ?? 0);
    const issuedParentId = BigInt(body.issuedParentId ?? 0);
    const active = body.active !== false;
    const actorMint13 = active ? BigInt(body.actorMint13 ?? 0) : 0n;
    const refMint13 = active ? BigInt(body.refMint13 ?? 0) : 0n;
    if (active && actorMint13 <= 0n && refMint13 <= 0n) {
        return { success: false, error: 'active rule requires actorMint13 or refMint13 > 0' };
    }
    const comboErr = validateMetricTargetCombo(eventKind, targetKind, issuedParentId);
    if (comboErr)
        return { success: false, error: comboErr };
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const cardCalldata = buildConfigureEventRewardRuleCalldata({
            ruleId,
            active,
            eventKind,
            targetKind,
            issuedParentId,
            actorMint13,
            refMint13,
        });
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(base.card, exports.CONFIGURE_EVENT_REWARD_RULE_SELECTOR, 'configureEventRewardRule');
        if (routeErr)
            return { success: false, error: routeErr };
        return {
            success: true,
            preChecked: buildGatewayRewardPoolForwardBody(base.card, cardCalldata),
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardConfigureEventRewardRuleGatewayPreCheck = cardConfigureEventRewardRuleGatewayPreCheck;
function normalizeEventRewardRuleConfigRow(raw) {
    if (!raw || typeof raw !== 'object')
        return { ok: false, error: 'Invalid rule row' };
    const r = raw;
    const ruleId = BigInt(String(r.ruleId ?? 0));
    if (ruleId <= 0n)
        return { ok: false, error: 'ruleId must be > 0' };
    const eventKind = Number(r.eventKind ?? 0);
    const targetKind = Number(r.targetKind ?? 0);
    const issuedParentId = BigInt(String(r.issuedParentId ?? 0));
    const active = r.active !== false;
    const actorMint13 = active ? BigInt(String(r.actorMint13 ?? 0)) : 0n;
    const refMint13 = active ? BigInt(String(r.refMint13 ?? 0)) : 0n;
    if (active && actorMint13 <= 0n && refMint13 <= 0n) {
        return { ok: false, error: 'active rule requires actorMint13 or refMint13 > 0' };
    }
    const comboErr = validateMetricTargetCombo(eventKind, targetKind, issuedParentId);
    if (comboErr)
        return { ok: false, error: comboErr };
    return {
        ok: true,
        row: {
            ruleId,
            active,
            eventKind,
            targetKind,
            issuedParentId,
            actorMint13,
            refMint13,
        },
    };
}
function parseEventRewardRuleConfigsFromBody(body) {
    if (body.data && typeof body.data === 'string' && body.data.length >= 10) {
        if (body.data.slice(0, 10).toLowerCase() !== exports.CONFIGURE_EVENT_REWARD_RULES_BATCH_SELECTOR.toLowerCase()) {
            return { ok: false, error: 'data must be configureEventRewardRulesBatch(...) calldata' };
        }
        return { ok: true, configs: [], data: body.data };
    }
    if (!Array.isArray(body.rules) || body.rules.length === 0) {
        return { ok: false, error: 'rules[] must be a non-empty array' };
    }
    const configs = [];
    for (let i = 0; i < body.rules.length; i++) {
        const row = normalizeEventRewardRuleConfigRow(body.rules[i]);
        if (!row.ok)
            return { ok: false, error: `rules[${i}]: ${row.error}` };
        configs.push(row.row);
    }
    return {
        ok: true,
        configs,
        data: buildConfigureEventRewardRulesBatchCalldata(configs),
    };
}
/** Cluster：owner 批量配置 #13 奖励规则（一次 executeForOwner / 一次签名）。 */
const cardConfigureEventRewardRulesBatchPreCheck = async (body) => {
    const { cardAddress, deadline, nonce, ownerSignature } = body;
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (deadline == null || !nonce || !ownerSignature) {
        return { success: false, error: 'Missing deadline, nonce, or ownerSignature' };
    }
    const parsed = parseEventRewardRuleConfigsFromBody(body);
    if (!parsed.ok)
        return { success: false, error: parsed.error };
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(card, exports.CONFIGURE_EVENT_REWARD_RULES_BATCH_SELECTOR, 'configureEventRewardRulesBatch');
        if (routeErr) {
            return {
                success: false,
                error: `${routeErr} (upgrade ChargeRewardModuleV2 with configureEventRewardRulesBatch)`,
            };
        }
        const sig = await verifyExecuteForOwnerOwnerSignature({
            cardAddress: card,
            data: parsed.data,
            deadline: Number(deadline),
            nonce: String(nonce),
            ownerSignature: String(ownerSignature),
        });
        if (!sig.ok)
            return { success: false, error: sig.error };
        return {
            success: true,
            preChecked: {
                cardAddress: card,
                data: parsed.data,
                deadline: Number(deadline),
                nonce: String(nonce),
                ownerSignature: String(ownerSignature),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardConfigureEventRewardRulesBatchPreCheck = cardConfigureEventRewardRulesBatchPreCheck;
/** Cluster：gateway 批量 configureEventRewardRule（优先单 tx batch；未部署时 extraCardCallData 串行）。 */
const cardConfigureEventRewardRulesBatchGatewayPreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!Array.isArray(body.rules) || body.rules.length === 0) {
        return { success: false, error: 'rules[] must be a non-empty array' };
    }
    const parsed = parseEventRewardRuleConfigsFromBody({ rules: body.rules });
    if (!parsed.ok)
        return { success: false, error: parsed.error };
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const batchRouteErr = await assertAdminStatsRoutesChargeRewardSelector(base.card, exports.CONFIGURE_EVENT_REWARD_RULES_BATCH_SELECTOR, 'configureEventRewardRulesBatch');
        if (!batchRouteErr) {
            return {
                success: true,
                preChecked: buildGatewayRewardPoolForwardBody(base.card, parsed.data),
            };
        }
        const calldatas = parsed.configs.map((c) => buildConfigureEventRewardRuleCalldata({
            ruleId: c.ruleId,
            active: c.active,
            eventKind: c.eventKind,
            targetKind: c.targetKind,
            issuedParentId: c.issuedParentId,
            actorMint13: c.actorMint13,
            refMint13: c.refMint13,
        }));
        for (let i = 0; i < calldatas.length; i++) {
            const routeErr = await assertAdminStatsRoutesChargeRewardSelector(base.card, exports.CONFIGURE_EVENT_REWARD_RULE_SELECTOR, 'configureEventRewardRule');
            if (routeErr)
                return { success: false, error: routeErr };
        }
        const [first, ...rest] = calldatas;
        if (!first)
            return { success: false, error: 'rules[] must be a non-empty array' };
        return {
            success: true,
            preChecked: {
                ...buildGatewayRewardPoolForwardBody(base.card, first),
                ...(rest.length > 0 ? { extraCardCallData: rest } : {}),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardConfigureEventRewardRulesBatchGatewayPreCheck = cardConfigureEventRewardRulesBatchGatewayPreCheck;
function validateMetricTargetCombo(metricKind, targetKind, issuedParentId) {
    if (metricKind === exports.UC_METRIC.TOPUP || metricKind === exports.UC_METRIC.CHARGE) {
        if (targetKind !== exports.UC_TARGET.GLOBAL_ONLY) {
            return 'topup/charge metrics require targetKind=TARGET_GLOBAL_ONLY (0)';
        }
        return null;
    }
    if (targetKind === exports.UC_TARGET.ISSUED_COUPON) {
        if (issuedParentId < exports.ISSUED_NFT_START_ID_MEMBER) {
            return `issuedParentId must be >= ${exports.ISSUED_NFT_START_ID_MEMBER} for TARGET_ISSUED_COUPON`;
        }
    }
    if (targetKind !== exports.UC_TARGET.MERCHANT_CARD_COUPON && targetKind !== exports.UC_TARGET.ISSUED_COUPON) {
        return 'targetKind must be 0 (global), 1 (merchant card), or 2 (issued coupon)';
    }
    return null;
}
/** Cluster：owner/admin 记账 recordUserCumulativeStat（executeForOwner）。 */
const cardRecordUserCumulativeStatPreCheck = async (body) => {
    const { cardAddress, wallet, deadline, nonce, ownerSignature } = body;
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!wallet || !ethers_1.ethers.isAddress(wallet))
        return { success: false, error: 'Invalid wallet' };
    if (deadline == null || !nonce || !ownerSignature) {
        return { success: false, error: 'Missing deadline, nonce, or ownerSignature' };
    }
    const metricKind = Number(body.metricKind ?? 0);
    const targetKind = Number(body.targetKind ?? 0);
    const issuedParentId = BigInt(body.issuedParentId ?? 0);
    const delta = BigInt(body.delta ?? 0);
    if (delta <= 0n)
        return { success: false, error: 'delta must be > 0' };
    const comboErr = validateMetricTargetCombo(metricKind, targetKind, issuedParentId);
    if (comboErr)
        return { success: false, error: comboErr };
    const data = body.data && typeof body.data === 'string' && body.data.length >= 10
        ? body.data
        : buildRecordUserCumulativeStatCalldata({
            wallet,
            metricKind,
            targetKind,
            issuedParentId,
            delta,
        });
    if (data.slice(0, 10).toLowerCase() !== exports.RECORD_USER_CUMULATIVE_STAT_SELECTOR.toLowerCase()) {
        return { success: false, error: 'data must be recordUserCumulativeStat(...) calldata' };
    }
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const status = await readCardUserCumulativeStatStatus(card);
        if (!status.initialized) {
            return { success: false, error: 'cardUserCumulativeStatTokens not initialized' };
        }
        const routeErr = await assertAdminStatsRoutesIssuedNftSelector(card, exports.RECORD_USER_CUMULATIVE_STAT_SELECTOR, 'recordUserCumulativeStat');
        if (routeErr)
            return { success: false, error: routeErr };
        const sig = await verifyExecuteForOwnerOwnerSignature({
            cardAddress: card,
            data,
            deadline: Number(deadline),
            nonce: String(nonce),
            ownerSignature: String(ownerSignature),
        });
        if (!sig.ok)
            return { success: false, error: sig.error };
        return {
            success: true,
            preChecked: {
                cardAddress: card,
                data,
                deadline: Number(deadline),
                nonce: String(nonce),
                ownerSignature: String(ownerSignature),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardRecordUserCumulativeStatPreCheck = cardRecordUserCumulativeStatPreCheck;
function buildGatewayRewardPoolForwardBody(card, cardCalldata) {
    return {
        cardAddress: card,
        cardCallData: cardCalldata,
        factoryCallData: encodeGatewayInvokeCardFactoryCalldata(card, cardCalldata),
    };
}
async function gatewayRewardPoolBasePreCheck(cardAddress) {
    const card = ethers_1.ethers.getAddress(cardAddress);
    if (!(await (0, beamioUserCardChain_1.hasCoNETUserCardBytecode)(card)))
        return { error: 'Card not found on CoNET' };
    const status = await readCardUserCumulativeStatStatus(card);
    return { card, needsInit: !status.initialized };
}
/** Cluster：gateway 代付 initializeCardUserCumulativeStatTokens（无需卡主 owner 签名）。 */
const cardGatewayInitializeUserCumulativeStatPreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress)) {
        return { success: false, error: 'Invalid cardAddress' };
    }
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        if (!base.needsInit) {
            return {
                success: false,
                error: 'cardUserCumulativeStatTokens already initialized (idempotent no-op on-chain)',
                alreadyInitialized: true,
            };
        }
        const initRouteErr = await assertAdminStatsRoutesIssuedNftSelector(base.card, exports.INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR, 'initializeCardUserCumulativeStatTokens');
        if (initRouteErr)
            return { success: false, error: initRouteErr };
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(base.card);
        const factory = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(base.card);
        if (!(await factorySupportsGatewayInvokeCard(factory, chain))) {
            return {
                success: false,
                error: 'Factory gatewayInvokeCard not deployed on-chain; upgrade CoNET UserCard factory before gateway initialize.',
            };
        }
        return {
            success: true,
            preChecked: {
                cardAddress: base.card,
                initOnly: true,
                label: 'initializeCardUserCumulativeStat',
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardGatewayInitializeUserCumulativeStatPreCheck = cardGatewayInitializeUserCumulativeStatPreCheck;
/** Cluster：gateway recordTopupCumulativeStat（Master gatewayInvokeCard 队列）。 */
const cardRecordTopupCumulativeStatPreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!body.userEOA || !ethers_1.ethers.isAddress(body.userEOA))
        return { success: false, error: 'Invalid userEOA' };
    const points6 = BigInt(body.points6 ?? 0);
    if (points6 <= 0n)
        return { success: false, error: 'points6 must be > 0' };
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        if (base.needsInit) {
            const initRouteErr = await assertAdminStatsRoutesIssuedNftSelector(base.card, exports.INITIALIZE_CARD_USER_CUMUL_STAT_SELECTOR, 'initializeCardUserCumulativeStatTokens');
            if (initRouteErr)
                return { success: false, error: initRouteErr };
        }
        const cardCalldata = buildRecordTopupCumulativeStatCalldata(body.userEOA, points6);
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(base.card, exports.RECORD_TOPUP_CUMULATIVE_STAT_SELECTOR, 'recordTopupCumulativeStat');
        if (routeErr)
            return { success: false, error: routeErr };
        return {
            success: true,
            preChecked: buildGatewayRewardPoolForwardBody(base.card, cardCalldata),
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardRecordTopupCumulativeStatPreCheck = cardRecordTopupCumulativeStatPreCheck;
/** Cluster：gateway purchaseRewardProgram。 */
const cardPurchaseRewardProgramPreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!body.payerEOA || !ethers_1.ethers.isAddress(body.payerEOA))
        return { success: false, error: 'Invalid payerEOA' };
    const assetKind = Number(body.assetKind ?? 0);
    if (assetKind < 1 || assetKind > 3) {
        return { success: false, error: 'assetKind must be 1 (points), 2 (charge reward), or 3 (voucher #13)' };
    }
    const amount = BigInt(body.amount ?? 0);
    const budget13PerUnit = BigInt(body.budget13PerUnit ?? 0);
    if (amount <= 0n || budget13PerUnit <= 0n) {
        return { success: false, error: 'amount and budget13PerUnit must be > 0' };
    }
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const cardCalldata = buildPurchaseRewardProgramCalldata({
            payerEOA: body.payerEOA,
            assetKind,
            amount,
            budget13PerUnit,
            cumulativeTargetKind: Number(body.cumulativeTargetKind ?? 0),
            cumulativeIssuedParentId: body.cumulativeIssuedParentId ?? 0,
        });
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(base.card, exports.PURCHASE_REWARD_PROGRAM_SELECTOR, 'purchaseRewardProgram');
        if (routeErr)
            return { success: false, error: routeErr };
        return {
            success: true,
            preChecked: buildGatewayRewardPoolForwardBody(base.card, cardCalldata),
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardPurchaseRewardProgramPreCheck = cardPurchaseRewardProgramPreCheck;
/** Cluster：gateway fundSocialExchangeUsdcEscrow（商户 owner 须先 approve CONET-USDC 给 card）。 */
const cardFundSocialExchangeUsdcEscrowPreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!body.payerEOA || !ethers_1.ethers.isAddress(body.payerEOA))
        return { success: false, error: 'Invalid payerEOA' };
    const amount6 = BigInt(body.amount6 ?? 0);
    if (amount6 <= 0n)
        return { success: false, error: 'amount6 must be > 0' };
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const cardOwner = (await new ethers_1.ethers.Contract(base.card, ['function owner() view returns (address)'], (0, beamioUserCardChain_1.providerForUserCardChain)(await (0, beamioUserCardChain_1.resolveUserCardChain)(base.card))).owner());
        if (ethers_1.ethers.getAddress(cardOwner) !== ethers_1.ethers.getAddress(body.payerEOA)) {
            return { success: false, error: 'payerEOA must be card owner' };
        }
        const cardCalldata = buildFundSocialExchangeUsdcEscrowCalldata(body.payerEOA, amount6);
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(base.card, exports.FUND_SOCIAL_EXCHANGE_USDC_ESCROW_SELECTOR, 'fundSocialExchangeUsdcEscrow');
        if (routeErr)
            return { success: false, error: routeErr };
        return {
            success: true,
            preChecked: buildGatewayRewardPoolForwardBody(base.card, cardCalldata),
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardFundSocialExchangeUsdcEscrowPreCheck = cardFundSocialExchangeUsdcEscrowPreCheck;
const DISCOVER_SHARE_CLICK_ATTESTATION_KIND = 'beamio_discover_share_click_v1';
const DISCOVER_SHARE_CLICK_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1000;
/** Verify homepage app-download share-click signMessage attestation. */
function verifyDiscoverShareClickAttestation(body) {
    let card;
    let actor;
    try {
        card = ethers_1.ethers.getAddress(body.cardAddress);
        actor = ethers_1.ethers.getAddress(body.actorEOA);
    }
    catch {
        return { ok: false, error: 'Invalid cardAddress or actorEOA' };
    }
    const sig = body.clickAttestation;
    if (!sig || typeof sig !== 'string' || !ethers_1.ethers.isHexString(sig)) {
        return { ok: false, error: 'Invalid clickAttestation' };
    }
    const ts = Number(body.attestationTs);
    if (!Number.isFinite(ts) || ts <= 0)
        return { ok: false, error: 'Invalid attestationTs' };
    if (Math.abs(Date.now() - ts) > DISCOVER_SHARE_CLICK_ATTESTATION_MAX_AGE_MS) {
        return { ok: false, error: 'clickAttestation expired' };
    }
    const payload = JSON.stringify({
        kind: DISCOVER_SHARE_CLICK_ATTESTATION_KIND,
        cardAddress: card,
        actor,
        ts,
    });
    try {
        const recovered = ethers_1.ethers.verifyMessage(payload, sig);
        if (ethers_1.ethers.getAddress(recovered) !== actor) {
            return { ok: false, error: 'clickAttestation signer mismatch' };
        }
    }
    catch {
        return { ok: false, error: 'clickAttestation verify failed' };
    }
    return { ok: true };
}
/** Cluster：Discover 分享链接打开计数（Plan A applyDiscoverShareClickWithSignature；legacy gateway 两步 fallback）。 */
const cardRecordDiscoverShareClickPreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!body.actorWallet || !ethers_1.ethers.isAddress(body.actorWallet))
        return { success: false, error: 'Invalid actorWallet' };
    const targetKind = Number(body.cumulativeTargetKind ?? exports.UC_TARGET.MERCHANT_CARD_COUPON);
    const issuedParentId = BigInt(body.cumulativeIssuedParentId ?? 0);
    const actor = ethers_1.ethers.getAddress(body.actorWallet);
    let refWallet = ethers_1.ethers.ZeroAddress;
    if (body.refWallet && ethers_1.ethers.isAddress(body.refWallet)) {
        const ref = ethers_1.ethers.getAddress(body.refWallet);
        if (ref !== actor)
            refWallet = ref;
    }
    const userClickErr = validateMetricTargetCombo(exports.UC_METRIC.USER_CLICK, targetKind, issuedParentId);
    if (userClickErr)
        return { success: false, error: userClickErr };
    const refClickErr = validateMetricTargetCombo(exports.UC_METRIC.REF_CLICK, targetKind, issuedParentId);
    if (refClickErr)
        return { success: false, error: refClickErr };
    const delistedErr = await rejectDelistedIssuedCouponSocial(body.cardAddress, targetKind, issuedParentId);
    if (delistedErr)
        return delistedErr;
    const hasEip712 = body.deadline != null &&
        Number.isFinite(Number(body.deadline)) &&
        body.nonce &&
        typeof body.nonce === 'string' &&
        body.nonce.trim() &&
        body.userSignature &&
        ethers_1.ethers.isHexString(body.userSignature);
    if (!hasEip712) {
        const attestation = verifyDiscoverShareClickAttestation({
            cardAddress: body.cardAddress,
            actorEOA: body.actorWallet,
            clickAttestation: String(body.clickAttestation ?? ''),
            attestationTs: Number(body.attestationTs ?? 0),
        });
        if (!attestation.ok) {
            return {
                success: false,
                error: `${attestation.error}; Plan A requires deadline, nonce, and userSignature (EIP-712)`,
            };
        }
    }
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const card = base.card;
        if (base.needsInit) {
            return {
                success: false,
                error: 'cardUserCumulativeStatTokens not initialized; merchant must call cardInitializeUserCumulativeStat first',
            };
        }
        const bunitPre = await (0, MemberCard_1.cardProgramSocialBunitFeePreCheck)(card);
        if (!bunitPre.success) {
            return { success: false, error: bunitPre.error };
        }
        if (hasEip712) {
            const deadline = Number(body.deadline);
            if (deadline <= Math.floor(Date.now() / 1000)) {
                return { success: false, error: 'Missing or expired deadline' };
            }
            const nonce = String(body.nonce).trim();
            const userSignature = String(body.userSignature);
            const nonceBytes32 = nonce.length === 66 && nonce.startsWith('0x')
                ? nonce
                : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(nonce));
            const domain = await eip712DomainForRecordUserLike(card);
            const digest = ethers_1.ethers.TypedDataEncoder.hash(domain, exports.RECORD_DISCOVER_SHARE_CLICK_EIP712_TYPE, {
                cardAddress: card,
                actorEOA: actor,
                refWallet,
                targetKind,
                issuedParentId,
                deadline: BigInt(deadline),
                nonce: nonceBytes32,
            });
            const signer = ethers_1.ethers.recoverAddress(digest, userSignature);
            if (ethers_1.ethers.getAddress(signer) !== actor) {
                return { success: false, error: 'userSignature signer mismatch' };
            }
            const planASupported = await cardSupportsApplyDiscoverShareClickWithSignature(card);
            if (planASupported) {
                const cardCallData = buildApplyDiscoverShareClickWithSignatureCalldata({
                    actorEOA: actor,
                    refWallet,
                    targetKind,
                    issuedParentId,
                    deadline,
                    nonce,
                    userSignature,
                });
                return {
                    success: true,
                    preChecked: {
                        cardAddress: card,
                        cardCallData,
                    },
                };
            }
        }
        const userClickCalldata = buildRecordUserCumulativeStatCalldata({
            wallet: actor,
            metricKind: exports.UC_METRIC.USER_CLICK,
            targetKind,
            issuedParentId,
            delta: 1,
        });
        const refClickCalldata = buildRecordUserCumulativeStatCalldata({
            wallet: refWallet !== ethers_1.ethers.ZeroAddress ? refWallet : actor,
            metricKind: exports.UC_METRIC.REF_CLICK,
            targetKind,
            issuedParentId,
            delta: 1,
        });
        const routeErr = await assertAdminStatsRoutesIssuedNftSelector(card, exports.RECORD_USER_CUMULATIVE_STAT_SELECTOR, 'recordUserCumulativeStat');
        if (routeErr)
            return { success: false, error: routeErr };
        const factoryGw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(card);
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
        if (!(await factorySupportsGatewayInvokeCard(factoryGw, chain))) {
            return {
                success: false,
                error: 'CoNET card missing applyDiscoverShareClickWithSignature module; upgrade IssuedNft V2 + AdminStats V2 on CoNET Factory.',
            };
        }
        return {
            success: true,
            preChecked: {
                ...buildGatewayRewardPoolForwardBody(card, userClickCalldata),
                extraCardCallData: [refClickCalldata],
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardRecordDiscoverShareClickPreCheck = cardRecordDiscoverShareClickPreCheck;
/** Cluster：分享落地绑定 referee（Plan A bindShareRefereeWithSignature；EOA only；同卡不可改 uplink）。 */
const cardBindShareRefereePreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    const downlineRaw = body.downlineEOA || body.actorWallet;
    const refereeRaw = body.refereeEOA || body.refWallet;
    if (!downlineRaw || !ethers_1.ethers.isAddress(downlineRaw))
        return { success: false, error: 'Invalid downlineEOA' };
    if (!refereeRaw || !ethers_1.ethers.isAddress(refereeRaw))
        return { success: false, error: 'Invalid refereeEOA' };
    const downlineEOA = ethers_1.ethers.getAddress(downlineRaw);
    const refereeEOA = ethers_1.ethers.getAddress(refereeRaw);
    if (downlineEOA === refereeEOA)
        return { success: false, error: 'downlineEOA must differ from refereeEOA' };
    if (body.deadline == null ||
        !Number.isFinite(Number(body.deadline)) ||
        !body.nonce ||
        typeof body.nonce !== 'string' ||
        !body.nonce.trim() ||
        !body.userSignature ||
        !ethers_1.ethers.isHexString(body.userSignature)) {
        return { success: false, error: 'Plan A requires deadline, nonce, and userSignature (EIP-712)' };
    }
    const deadline = Number(body.deadline);
    if (deadline <= Math.floor(Date.now() / 1000)) {
        return { success: false, error: 'Missing or expired deadline' };
    }
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const card = base.card;
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const aaFactoryAddr = chainAddresses_1.CONET_AA_FACTORY;
        const aaFac = new ethers_1.ethers.Contract(aaFactoryAddr, [
            'function isBeamioAccount(address) view returns (bool)',
            'function beamioAccountOf(address) view returns (address)',
        ], provider);
        const rejectIfAa = async (label, addr) => {
            try {
                if (await aaFac.isBeamioAccount(addr)) {
                    return `${label} must be an EOA (got Beamio AA)`;
                }
            }
            catch {
                /* ignore */
            }
            const aa = (await aaFac.beamioAccountOf(addr));
            if (!aa || aa === ethers_1.ethers.ZeroAddress) {
                return `${label} has no Beamio AA (register Express Pay first)`;
            }
            return null;
        };
        const downErr = await rejectIfAa('downlineEOA', downlineEOA);
        if (downErr)
            return { success: false, error: downErr };
        const refErr = await rejectIfAa('refereeEOA', refereeEOA);
        if (refErr)
            return { success: false, error: refErr };
        const downlineAA = ethers_1.ethers.getAddress((await aaFac.beamioAccountOf(downlineEOA)));
        const refereeAA = ethers_1.ethers.getAddress((await aaFac.beamioAccountOf(refereeEOA)));
        /*
         * Do not use refereeReferrer() as a pre-check here. Older cards and the
         * current AdminStats module do not route that read selector through the
         * card, so an eth_call reverts with BM_CallFailed. Treating
         * that revert as address(0) made the pre-check report a false "unbound"
         * state and encouraged duplicate submissions. The V4 bind entrypoint
         * performs the authoritative immutable/idempotent check on-chain.
         */
        const nonce = String(body.nonce).trim();
        const userSignature = String(body.userSignature);
        const nonceBytes32 = nonce.length === 66 && nonce.startsWith('0x')
            ? nonce
            : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(nonce));
        const domain = await eip712DomainForRecordUserLike(card);
        const digest = ethers_1.ethers.TypedDataEncoder.hash(domain, exports.BIND_SHARE_REFEREE_EIP712_TYPE, {
            cardAddress: card,
            downlineEOA,
            refereeEOA,
            deadline: BigInt(deadline),
            nonce: nonceBytes32,
        });
        const signer = ethers_1.ethers.recoverAddress(digest, userSignature);
        if (ethers_1.ethers.getAddress(signer) !== downlineEOA) {
            return { success: false, error: 'userSignature signer mismatch' };
        }
        const planASupported = await cardSupportsBindShareRefereeWithSignature(card);
        if (!planASupported) {
            return {
                success: false,
                error: 'CoNET card missing bindShareRefereeWithSignature (AdminStats must route selector 254 and V5/V6 impl must contain the bind function).',
            };
        }
        const cardCallData = buildBindShareRefereeWithSignatureCalldata({
            downlineEOA,
            refereeEOA,
            deadline,
            nonce,
            userSignature,
        });
        return {
            success: true,
            preChecked: {
                cardAddress: card,
                cardCallData,
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardBindShareRefereePreCheck = cardBindShareRefereePreCheck;
/** Cluster：gateway dispatchEventReward13。 */
const cardDispatchEventReward13PreCheck = async (body) => {
    if (!body.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!body.actorWallet || !ethers_1.ethers.isAddress(body.actorWallet))
        return { success: false, error: 'Invalid actorWallet' };
    const ruleId = BigInt(body.ruleId ?? 0);
    if (ruleId <= 0n)
        return { success: false, error: 'ruleId must be > 0' };
    const cumulativeDelta = BigInt(body.cumulativeDelta ?? 0);
    const refWallet = body.refWallet && ethers_1.ethers.isAddress(body.refWallet) ? ethers_1.ethers.getAddress(body.refWallet) : ethers_1.ethers.ZeroAddress;
    const targetKind = Number(body.cumulativeTargetKind ?? 0);
    const issuedParentId = BigInt(body.cumulativeIssuedParentId ?? 0);
    const delistedErr = await rejectDelistedIssuedCouponSocial(body.cardAddress, targetKind, issuedParentId);
    if (delistedErr)
        return delistedErr;
    try {
        const base = await gatewayRewardPoolBasePreCheck(body.cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const cardCalldata = buildDispatchEventReward13Calldata({
            ruleId,
            actorWallet: body.actorWallet,
            refWallet,
            cumulativeTargetKind: Number(body.cumulativeTargetKind ?? 0),
            cumulativeIssuedParentId: body.cumulativeIssuedParentId ?? 0,
            cumulativeDelta,
        });
        const routeErr = await assertAdminStatsRoutesChargeRewardSelector(base.card, exports.DISPATCH_EVENT_REWARD13_SELECTOR, 'dispatchEventReward13');
        if (routeErr)
            return { success: false, error: routeErr };
        return {
            success: true,
            preChecked: buildGatewayRewardPoolForwardBody(base.card, cardCalldata),
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardDispatchEventReward13PreCheck = cardDispatchEventReward13PreCheck;
/** @deprecated 使用 cardGatewayRewardPool Master 队列；保留常量供 503 回退文案。 */
exports.GATEWAY_REWARD_POOL_NOT_WIRED = {
    success: false,
    error: 'Gateway reward-pool write not wired yet; use Master internal queue (purchaseRewardProgram / dispatchEventReward13 / recordUserCumulativeStat).',
    code: 'UC_REWARD_POOL_GATEWAY_STUB',
};
async function eip712DomainForRecordUserLike(cardNorm) {
    const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardNorm);
    return {
        name: 'BeamioUserCardFactory',
        version: '1',
        chainId: (0, beamioUserCardChain_1.chainIdForUserCardChain)(chain),
        verifyingContract: await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardNorm),
    };
}
/** Read scoped like-stat balance (token 19 for merchant card; parent+offset for issued coupon). */
async function readUserLikeScopedTokenBalance(cardAddress, userEOA, targetKind, issuedParentId = 0) {
    try {
        const card = ethers_1.ethers.getAddress(cardAddress);
        const user = ethers_1.ethers.getAddress(userEOA);
        const parentId = BigInt(issuedParentId ?? 0);
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
        const reader = new ethers_1.ethers.Contract(card, [
            'function balanceOf(address account, uint256 id) view returns (uint256)',
            'function resolveUserCumulativeStatTokenId(uint8 metricKind, uint8 targetKind, uint256 issuedParentId) view returns (uint256 globalTokenId, uint256 scopedTokenId)',
        ], provider);
        const [, scopedTokenId] = (await reader.resolveUserCumulativeStatTokenId(exports.UC_METRIC.USER_LIKE, targetKind, parentId));
        if (scopedTokenId === 0n)
            return 0n;
        return (await reader.balanceOf(user, scopedTokenId));
    }
    catch {
        return null;
    }
}
/**
 * Cluster：用户 EIP-712 签字点赞 / 解除点赞。
 * - Like：`recordUserCumulativeStat` mint 全局 + scoped like stat token 给用户。
 * - Unlike：`burnUserCumulativeStatByGateway` 焚烧用户持有的 like stat token（等同转到 0x0）。
 * 支持 L1 商户卡（targetKind=1）与 L2 优惠券（targetKind=2, issuedParentId=issued tokenId）。
 */
const cardRecordUserLikePreCheck = async (body) => {
    const { cardAddress, userEOA, deadline, nonce, userSignature } = body;
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress))
        return { success: false, error: 'Invalid cardAddress' };
    if (!userEOA || !ethers_1.ethers.isAddress(userEOA))
        return { success: false, error: 'Invalid userEOA' };
    if (typeof body.liked !== 'boolean')
        return { success: false, error: 'Missing liked (boolean)' };
    if (deadline == null || !Number.isFinite(Number(deadline)) || Number(deadline) <= Math.floor(Date.now() / 1000)) {
        return { success: false, error: 'Missing or expired deadline' };
    }
    if (!nonce || typeof nonce !== 'string' || !nonce.trim())
        return { success: false, error: 'Missing nonce' };
    if (!userSignature || !ethers_1.ethers.isHexString(userSignature))
        return { success: false, error: 'Invalid userSignature' };
    const targetKind = Number(body.targetKind ?? exports.UC_TARGET.MERCHANT_CARD_COUPON);
    const issuedParentId = BigInt(body.issuedParentId ?? 0);
    const liked = Boolean(body.liked);
    const comboErr = validateMetricTargetCombo(exports.UC_METRIC.USER_LIKE, targetKind, issuedParentId);
    if (comboErr)
        return { success: false, error: comboErr };
    const delistedErr = await rejectDelistedIssuedCouponSocial(cardAddress, targetKind, issuedParentId);
    if (delistedErr)
        return delistedErr;
    const cardNorm = ethers_1.ethers.getAddress(cardAddress);
    const userNorm = ethers_1.ethers.getAddress(userEOA);
    const nonceBytes32 = nonce.length === 66 && nonce.startsWith('0x')
        ? nonce
        : ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(nonce));
    try {
        const base = await gatewayRewardPoolBasePreCheck(cardAddress);
        if ('error' in base)
            return { success: false, error: base.error };
        const cardNorm = base.card;
        if (base.needsInit) {
            return {
                success: false,
                error: 'cardUserCumulativeStatTokens not initialized; merchant must call cardInitializeUserCumulativeStat first',
            };
        }
        const domain = await eip712DomainForRecordUserLike(cardNorm);
        const digest = ethers_1.ethers.TypedDataEncoder.hash(domain, exports.RECORD_USER_LIKE_EIP712_TYPE, {
            cardAddress: cardNorm,
            userEOA: userNorm,
            targetKind,
            issuedParentId,
            liked,
            deadline: BigInt(deadline),
            nonce: nonceBytes32,
        });
        const signer = ethers_1.ethers.recoverAddress(digest, userSignature);
        if (ethers_1.ethers.getAddress(signer) !== userNorm) {
            return { success: false, error: 'userSignature signer mismatch' };
        }
        const scopedBal = await readUserLikeScopedTokenBalance(cardNorm, userNorm, targetKind, issuedParentId);
        if (scopedBal == null)
            return { success: false, error: 'Unable to read like token balance' };
        if (liked && scopedBal > 0n) {
            return { success: false, error: 'User already liked this target' };
        }
        if (!liked && scopedBal <= 0n) {
            return { success: false, error: 'User has not liked this target' };
        }
        const bunitPre = await (0, MemberCard_1.cardProgramSocialBunitFeePreCheck)(cardNorm);
        if (!bunitPre.success) {
            return { success: false, error: bunitPre.error };
        }
        const planASupported = await cardSupportsApplyUserLikeWithSignature(cardNorm);
        if (planASupported) {
            const cardCallData = buildApplyUserLikeWithSignatureCalldata({
                userEOA: userNorm,
                targetKind,
                issuedParentId,
                liked,
                deadline: Number(deadline),
                nonce,
                userSignature,
            });
            return {
                success: true,
                preChecked: {
                    cardAddress: cardNorm,
                    cardCallData,
                    liked,
                    targetKind,
                    issuedParentId: String(issuedParentId),
                },
            };
        }
        const statArgs = {
            wallet: userNorm,
            metricKind: exports.UC_METRIC.USER_LIKE,
            targetKind,
            issuedParentId,
            delta: 1,
        };
        const legacyCardCalldata = liked
            ? buildRecordUserCumulativeStatCalldata(statArgs)
            : buildBurnUserCumulativeStatCalldata(statArgs);
        const selector = liked ? exports.RECORD_USER_CUMULATIVE_STAT_SELECTOR : exports.BURN_USER_CUMULATIVE_STAT_SELECTOR;
        const routeErr = await assertAdminStatsRoutesIssuedNftSelector(cardNorm, selector, liked ? 'recordUserCumulativeStat' : 'burnUserCumulativeStatByGateway');
        if (routeErr)
            return { success: false, error: routeErr };
        const factoryGw = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardNorm);
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardNorm);
        if (!(await factorySupportsGatewayInvokeCard(factoryGw, chain))) {
            return {
                success: false,
                error: 'CoNET card missing applyUserLikeWithSignature module; upgrade IssuedNft V2 + AdminStats V2 on CoNET Factory.',
            };
        }
        return {
            success: true,
            preChecked: {
                cardAddress: cardNorm,
                factoryCallData: encodeGatewayInvokeCardFactoryCalldata(cardNorm, legacyCardCalldata),
                liked,
                targetKind,
                issuedParentId: String(issuedParentId),
            },
        };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.message ?? String(e) };
    }
};
exports.cardRecordUserLikePreCheck = cardRecordUserLikePreCheck;
