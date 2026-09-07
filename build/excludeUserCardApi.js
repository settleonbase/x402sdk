"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXCLUDE_USER_CARD_SIGN_PREFIX = void 0;
exports.buildExcludeUserCardSignMessage = buildExcludeUserCardSignMessage;
exports.warmDynamicApiExcludedUserCardsFromDb = warmDynamicApiExcludedUserCardsFromDb;
exports.excludeUserCardPreCheck = excludeUserCardPreCheck;
exports.applyExcludeUserCard = applyExcludeUserCard;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const apiExcludedUserCards_1 = require("./apiExcludedUserCards");
const db_1 = require("./db");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
exports.EXCLUDE_USER_CARD_SIGN_PREFIX = 'Beamio excludeUserCard:v1';
function buildExcludeUserCardSignMessage(cardAddress, deadline, nonce) {
    return `${exports.EXCLUDE_USER_CARD_SIGN_PREFIX}\n${ethers_1.ethers.getAddress(cardAddress)}\n${deadline}\n${nonce}`;
}
async function warmDynamicApiExcludedUserCardsFromDb() {
    const rows = await (0, db_1.listApiExcludedUserCardAddressesFromDb)();
    (0, apiExcludedUserCards_1.setDynamicApiExcludedUserCards)(rows.map((a) => a.toLowerCase()));
    (0, logger_1.logger)(safe_1.default.green(`[warmDynamicApiExcludedUserCardsFromDb] loaded ${rows.length} dynamic exclude(s)`));
}
async function resolveExcludeUserCardOwnerCandidates(cardAddress) {
    const out = new Set();
    const cardAddr = ethers_1.ethers.getAddress(cardAddress);
    const ownerAbi = ['function owner() view returns (address)'];
    for (const chain of ['conet', 'base']) {
        try {
            const cardProvider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
            const code = await cardProvider.getCode(cardAddr);
            if (!code || code === '0x')
                continue;
            const card = new ethers_1.ethers.Contract(cardAddr, ownerAbi, cardProvider);
            const owner = await card.owner();
            if (owner && ethers_1.ethers.isAddress(owner)) {
                out.add(ethers_1.ethers.getAddress(owner).toLowerCase());
                break;
            }
        }
        catch {
            /* try other chain */
        }
    }
    const row = await (0, db_1.getCardByAddress)(cardAddress);
    if (row?.cardOwner && ethers_1.ethers.isAddress(row.cardOwner)) {
        out.add(ethers_1.ethers.getAddress(row.cardOwner).toLowerCase());
    }
    return out;
}
async function excludeUserCardPreCheck(params) {
    const cardAddress = typeof params.cardAddress === 'string' ? params.cardAddress.trim() : '';
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
        return { success: false, error: 'Invalid or missing cardAddress' };
    }
    const ownerEOA = typeof params.ownerEOA === 'string' ? params.ownerEOA.trim() : '';
    if (!ownerEOA || !ethers_1.ethers.isAddress(ownerEOA)) {
        return { success: false, error: 'Invalid or missing ownerEOA' };
    }
    const { deadline, nonce, ownerSignature } = params;
    if (!Number.isInteger(deadline)) {
        return { success: false, error: 'Invalid deadline' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (deadline <= now) {
        return { success: false, error: 'Deadline expired' };
    }
    if (!ethers_1.ethers.isHexString(nonce, 32)) {
        return { success: false, error: 'Invalid nonce' };
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(ownerSignature))) {
        return { success: false, error: 'Invalid ownerSignature' };
    }
    const cardNorm = ethers_1.ethers.getAddress(cardAddress);
    if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(cardNorm)) {
        return { success: true };
    }
    let recovered;
    try {
        const message = buildExcludeUserCardSignMessage(cardNorm, deadline, nonce);
        recovered = ethers_1.ethers.getAddress(ethers_1.ethers.verifyMessage(message, ownerSignature));
    }
    catch {
        return { success: false, error: 'Invalid owner signature' };
    }
    const ownerCandidates = await resolveExcludeUserCardOwnerCandidates(cardNorm);
    if (ownerCandidates.size === 0) {
        return {
            success: false,
            error: 'Could not verify card owner on-chain or in programs database. Ensure this address is a deployed BeamioUserCard you own.',
        };
    }
    const signerLower = recovered.toLowerCase();
    if (!ownerCandidates.has(signerLower)) {
        return { success: false, error: 'Signer is not card owner' };
    }
    if (signerLower !== ethers_1.ethers.getAddress(ownerEOA).toLowerCase()) {
        return { success: false, error: 'ownerEOA does not match signature' };
    }
    return { success: true };
}
async function applyExcludeUserCard(params) {
    const lower = (0, apiExcludedUserCards_1.normalizeUserCardAddressLower)(params.cardAddress);
    if (!lower) {
        return { success: false, error: 'Invalid cardAddress' };
    }
    const excludedBy = (0, apiExcludedUserCards_1.normalizeUserCardAddressLower)(params.excludedBy);
    if (!excludedBy) {
        return { success: false, error: 'Invalid excludedBy' };
    }
    if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(lower)) {
        (0, apiExcludedUserCards_1.registerDynamicApiExcludedUserCard)(lower);
        return { success: true, cardAddress: ethers_1.ethers.getAddress(lower) };
    }
    const inserted = await (0, db_1.insertApiExcludedUserCard)({
        cardAddress: lower,
        excludedBy,
    });
    if (!inserted.ok) {
        return { success: false, error: inserted.error };
    }
    (0, apiExcludedUserCards_1.registerDynamicApiExcludedUserCard)(lower);
    (0, logger_1.logger)(safe_1.default.yellow(`[applyExcludeUserCard] blacklisted card=${ethers_1.ethers.getAddress(lower)} by=${ethers_1.ethers.getAddress(excludedBy)}`));
    return { success: true, cardAddress: ethers_1.ethers.getAddress(lower) };
}
