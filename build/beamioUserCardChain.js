"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultMerchantUserCardChain = defaultMerchantUserCardChain;
exports.chainIdForUserCardChain = chainIdForUserCardChain;
exports.cardFactoryForUserCardChain = cardFactoryForUserCardChain;
exports.defaultMerchantProgramCardAddress = defaultMerchantProgramCardAddress;
exports.providerForUserCardChain = providerForUserCardChain;
exports.beamioUserCardLibrariesForChain = beamioUserCardLibrariesForChain;
exports.resolveUserCardChain = resolveUserCardChain;
exports.hasCoNETUserCardBytecode = hasCoNETUserCardBytecode;
exports.settleRelayWalletForChain = settleRelayWalletForChain;
exports.merchantCardRelayContext = merchantCardRelayContext;
const ethers_1 = require("ethers");
const chainAddresses_1 = require("./chainAddresses");
const util_1 = require("./util");
const chainByCardCache = new Map();
let cachedProviderConet;
/** Merchant BeamioUserCard chain. Merchant cards are CoNET-only; do not fall back to Base. */
function defaultMerchantUserCardChain() {
    return 'conet';
}
function chainIdForUserCardChain(_chain) {
    return chainAddresses_1.CONET_MAINNET_CHAIN_ID;
}
function cardFactoryForUserCardChain(_chain) {
    return chainAddresses_1.CONET_CARD_FACTORY;
}
function defaultMerchantProgramCardAddress() {
    return chainAddresses_1.CONET_BEAMIO_USER_CARD_DEFAULT;
}
function providerForUserCardChain(_chain) {
    if (!cachedProviderConet) {
        cachedProviderConet = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)(), chainAddresses_1.CONET_MAINNET_CHAIN_ID, {
            staticNetwork: true,
            batchMaxCount: 1,
        });
    }
    return cachedProviderConet;
}
function beamioUserCardLibrariesForChain(_chain) {
    return {
        BeamioUserCardAdminGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
        BeamioUserCardFaucetGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
        BeamioUserCardFormattingLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_FORMATTING_LIB,
        BeamioUserCardGatewayMintLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
        BeamioUserCardGovernanceLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB,
        BeamioUserCardIssuedNftGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
        BeamioUserCardModuleRouterLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
        BeamioUserCardRedeemGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
        BeamioUserCardReferrerLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_REFERRER_LIB,
        BeamioUserCardTransferLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_TRANSFER_LIB,
        BeamioUserCardUpdateLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_UPDATE_LIB,
        BeamioUserCardViewsLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_VIEWS_LIB,
        BeamioUserCardMembershipGateLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB,
        ReferrerRegistryLib: chainAddresses_1.CONET_REFERRER_REGISTRY_LIB,
    };
}
/** Resolve merchant BeamioUserCard chain. Only CoNET is accepted for merchant cards. */
async function resolveUserCardChain(cardAddress, _fallback = defaultMerchantUserCardChain()) {
    const addr = ethers_1.ethers.getAddress(cardAddress);
    const cached = chainByCardCache.get(addr.toLowerCase());
    if (cached)
        return cached;
    const conetCode = await providerForUserCardChain('conet').getCode(addr);
    if (conetCode && conetCode !== '0x') {
        chainByCardCache.set(addr.toLowerCase(), 'conet');
        return 'conet';
    }
    return 'conet';
}
/** True when BeamioUserCard bytecode exists on CoNET (224422). Base-only legacy cards return false. */
async function hasCoNETUserCardBytecode(cardAddress) {
    try {
        const addr = ethers_1.ethers.getAddress(cardAddress);
        const code = await providerForUserCardChain('conet').getCode(addr);
        return !!(code && code !== '0x');
    }
    catch {
        return false;
    }
}
function settleRelayWalletForChain(SC, chain) {
    return chain === 'conet' ? SC.walletConet : SC.walletBase;
}
async function merchantCardRelayContext(SC, cardAddress) {
    const chain = cardAddress && ethers_1.ethers.isAddress(cardAddress)
        ? await resolveUserCardChain(cardAddress)
        : defaultMerchantUserCardChain();
    return {
        chain,
        chainId: chainIdForUserCardChain(chain),
        provider: providerForUserCardChain(chain),
        cardFactory: cardFactoryForUserCardChain(chain),
        wallet: settleRelayWalletForChain(SC, chain),
    };
}
