"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLOCKSCOUT_BASE_CHAIN_ID = void 0;
exports.blockscoutUnifiedApiRoot = blockscoutUnifiedApiRoot;
exports.requestBlockscoutErc1155MetadataRefetch = requestBlockscoutErc1155MetadataRefetch;
exports.listMembershipTokenIdsForBlockscoutRefetch = listMembershipTokenIdsForBlockscoutRefetch;
exports.requestBlockscoutCardCatalogMetadataRefetch = requestBlockscoutCardCatalogMetadataRefetch;
exports.scheduleBeamioUserCardBlockscoutMetadataRefetch = scheduleBeamioUserCardBlockscoutMetadataRefetch;
exports.requestExplorerNftMetadataRefresh = requestExplorerNftMetadataRefresh;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const db_1 = require("../db");
const couponClaimShare_1 = require("./couponClaimShare");
const util_1 = require("../util");
const ISSUED_NFT_START_ID = 100000000000n;
const MEMBERSHIP_NFT_START_ID = BigInt(db_1.BEAMIO_MEMBERSHIP_NFT_START_ID);
const MEMBERSHIP_REFETCH_DELAY_MS = 280;
const BEAMIO_CARD_MEMBERSHIP_COUNT_ABI = ['function totalMembershipIssued() view returns (uint256)'];
const BASE_CHAIN_SLUG = 'base';
/** Base mainnet — Blockscout PRO REST uses `https://api.blockscout.com/{chainId}/api/v2/...` */
exports.BLOCKSCOUT_BASE_CHAIN_ID = 8453;
function blockscoutApiKey() {
    const key = process.env.BLOCKSCOUT_API_KEY?.trim();
    return key || undefined;
}
function blockscoutChainId() {
    const raw = process.env.BLOCKSCOUT_CHAIN_ID?.trim();
    if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    return exports.BLOCKSCOUT_BASE_CHAIN_ID;
}
/**
 * PRO multi-chain reads (e.g. address transactions):
 * `https://api.blockscout.com/{chainId}/api/v2/...?apikey=proapi_...`
 */
function blockscoutUnifiedApiRoot() {
    const base = (process.env.BLOCKSCOUT_API_BASE_URL?.trim() || 'https://api.blockscout.com').replace(/\/$/, '');
    if (/\/\d+$/.test(base))
        return base;
    return `${base}/${blockscoutChainId()}`;
}
/**
 * NFT metadata refetch PATCH is served by the chain explorer host.
 * PRO `proapi_…` keys use `Authorization: Bearer` here (not `base.blockscout.com?apikey=`).
 */
function blockscoutRefetchApiRoot() {
    const custom = process.env.BLOCKSCOUT_REFETCH_API_ROOT?.trim();
    if (custom)
        return custom.replace(/\/$/, '');
    return (process.env.BLOCKSCOUT_EXPLORER_API_ROOT?.trim() || 'https://base.blockscout.com').replace(/\/$/, '');
}
function blockscoutRefetchHeaders(apiKey) {
    return {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
    };
}
async function patchBlockscoutInstanceMetadataRefetch(contract, tokenId, apiKey) {
    const root = blockscoutRefetchApiRoot();
    const url = `${root}/api/v2/tokens/${contract}/instances/${encodeURIComponent(tokenId)}/refetch-metadata`;
    try {
        const res = await fetch(url, {
            method: 'PATCH',
            headers: blockscoutRefetchHeaders(apiKey),
            body: '{}',
        });
        if (res.ok || res.status === 202)
            return { ok: true };
        const body = await res.text().catch(() => '');
        return {
            ok: false,
            error: `${res.status}${body ? `:${body.slice(0, 120)}` : ''}`,
        };
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
/**
 * Blockscout PRO: refresh indexed ERC-1155 metadata after beamio.app JSON changes.
 * Set `BLOCKSCOUT_API_KEY` on Master. Card-level updates refetch token #0 (program card metadata).
 */
async function requestBlockscoutErc1155MetadataRefetch(opts) {
    const channels = [];
    const errors = [];
    const apiKey = blockscoutApiKey();
    if (!apiKey) {
        (0, logger_1.logger)(safe_1.default.yellow('[blockscoutMetadataRefetch] BLOCKSCOUT_API_KEY unset — skip Blockscout metadata refetch'));
        return { ok: false, channels, errors: ['api_key_unset'] };
    }
    let contract;
    try {
        contract = ethers_1.ethers.getAddress(opts.contractAddress);
    }
    catch {
        return { ok: false, channels, errors: ['invalid_contract'] };
    }
    const tokenId = opts.tokenId != null && String(opts.tokenId).trim() !== '' ? String(opts.tokenId).trim() : '0';
    const instance = await patchBlockscoutInstanceMetadataRefetch(contract, tokenId, apiKey);
    if (instance.ok) {
        channels.push(tokenId === '0' ? 'blockscout_token_0' : 'blockscout_instance');
    }
    else if (instance.error) {
        errors.push((tokenId === '0' ? 'blockscout_token_0' : 'blockscout_instance') + `:${instance.error}`);
    }
    const ok = channels.length > 0;
    if (ok) {
        (0, logger_1.logger)(safe_1.default.cyan(`[blockscoutMetadataRefetch] card=${contract} tokenId=${tokenId} channels=${channels.join(',')}`));
    }
    else if (errors.length) {
        (0, logger_1.logger)(safe_1.default.yellow(`[blockscoutMetadataRefetch] card=${contract} tokenId=${tokenId} errors=${errors.join(';')}`));
    }
    return { ok, channels, errors };
}
function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Membership minted tokenIds: [NFT_START_ID, NFT_START_ID + totalMembershipIssued) plus DB tier rows. */
async function listMembershipTokenIdsForBlockscoutRefetch(contractAddress) {
    let card;
    try {
        card = ethers_1.ethers.getAddress(contractAddress);
    }
    catch {
        return [];
    }
    const ids = new Set();
    for (const tid of await (0, db_1.listMembershipNftTierTokenIdsByCard)(card)) {
        if (tid >= db_1.BEAMIO_MEMBERSHIP_NFT_START_ID && tid < db_1.BEAMIO_ISSUED_NFT_START_ID) {
            ids.add(String(tid));
        }
    }
    try {
        const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioBaseHttpRpcUrl)());
        const cardContract = new ethers_1.ethers.Contract(card, BEAMIO_CARD_MEMBERSHIP_COUNT_ABI, provider);
        const total = await cardContract.totalMembershipIssued();
        const totalN = Number(total);
        if (Number.isFinite(totalN) && totalN > 0) {
            const start = db_1.BEAMIO_MEMBERSHIP_NFT_START_ID;
            const end = Math.min(start + totalN, db_1.BEAMIO_ISSUED_NFT_START_ID);
            for (let tid = start; tid < end; tid++)
                ids.add(String(tid));
        }
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[blockscoutMetadataRefetch] totalMembershipIssued read failed card=${card}: ${e instanceof Error ? e.message : e}`));
    }
    return [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}
/**
 * Refetch Blockscout for token #0 and every membership NFT id in [100, currentIndex) space.
 * `currentIndex` ≈ NFT_START_ID + totalMembershipIssued() on-chain.
 */
async function requestBlockscoutCardCatalogMetadataRefetch(contractAddress) {
    const channels = [];
    const errors = [];
    const r0 = await requestBlockscoutErc1155MetadataRefetch({
        contractAddress,
        tokenId: '0',
    });
    channels.push(...r0.channels);
    errors.push(...r0.errors);
    const membershipIds = await listMembershipTokenIdsForBlockscoutRefetch(contractAddress);
    for (const tid of membershipIds) {
        if (tid === '0')
            continue;
        try {
            const tidBig = BigInt(tid);
            if (tidBig < MEMBERSHIP_NFT_START_ID || tidBig >= ISSUED_NFT_START_ID)
                continue;
        }
        catch {
            continue;
        }
        const r = await requestBlockscoutErc1155MetadataRefetch({ contractAddress, tokenId: tid });
        channels.push(...r.channels);
        errors.push(...r.errors);
        await sleepMs(MEMBERSHIP_REFETCH_DELAY_MS);
    }
    const ok = channels.length > 0;
    if (ok) {
        (0, logger_1.logger)(safe_1.default.cyan(`[blockscoutMetadataRefetch] card catalog card=${contractAddress} membershipCount=${membershipIds.length} channels=${channels.length}`));
    }
    return { ok, channels, errors };
}
/** Fire-and-forget: token #0 + membership ids [NFT_START_ID, NFT_START_ID + totalMembershipIssued). */
function scheduleBeamioUserCardBlockscoutMetadataRefetch(contractAddress) {
    void requestBlockscoutCardCatalogMetadataRefetch(contractAddress).catch((e) => {
        (0, logger_1.logger)(safe_1.default.yellow('[blockscoutMetadataRefetch] schedule failed:'), e instanceof Error ? e.message : e);
    });
}
/** Best-effort refresh after biz updates issued coupon/catalog metadata (Blockscout + OpenSea + warm OG). */
async function requestExplorerNftMetadataRefresh(opts) {
    const channels = [];
    const errors = [];
    let contract;
    try {
        contract = ethers_1.ethers.getAddress(opts.contractAddress);
    }
    catch {
        return { ok: false, channels, errors: ['invalid_contract'] };
    }
    const tokenId = String(opts.tokenId ?? '').trim();
    try {
        if (BigInt(tokenId) < ISSUED_NFT_START_ID) {
            return { ok: false, channels, errors: ['not_issued_nft_token'] };
        }
    }
    catch {
        return { ok: false, channels, errors: ['invalid_token_id'] };
    }
    const blockscout = await requestBlockscoutErc1155MetadataRefetch({
        contractAddress: contract,
        tokenId,
    });
    channels.push(...blockscout.channels);
    errors.push(...blockscout.errors);
    try {
        const shareMeta = await (0, couponClaimShare_1.resolveIssuedNftExplorerShareMeta)(contract, tokenId);
        if (shareMeta) {
            await (0, couponClaimShare_1.warmIssuedNftExplorerOgJpeg)(contract, tokenId, shareMeta);
            channels.push('beamio_og');
        }
    }
    catch (e) {
        errors.push(`beamio_og:${e instanceof Error ? e.message : String(e)}`);
    }
    const openSeaKey = process.env.OPENSEA_API_KEY?.trim();
    if (openSeaKey) {
        try {
            const res = await fetch(`https://api.opensea.io/api/v2/chain/${BASE_CHAIN_SLUG}/contract/${contract}/nfts/${encodeURIComponent(tokenId)}/refresh`, {
                method: 'POST',
                headers: { accept: 'application/json', 'x-api-key': openSeaKey },
            });
            if (res.ok || res.status === 202) {
                channels.push('opensea');
            }
            else {
                const body = await res.text().catch(() => '');
                errors.push(`opensea:${res.status}${body ? `:${body.slice(0, 120)}` : ''}`);
            }
        }
        catch (e) {
            errors.push(`opensea:${e instanceof Error ? e.message : String(e)}`);
        }
    }
    else {
        (0, logger_1.logger)(safe_1.default.yellow('[explorerNftMetadataRefresh] OPENSEA_API_KEY unset — skip OpenSea refresh'));
    }
    const ok = channels.length > 0;
    if (ok) {
        (0, logger_1.logger)(safe_1.default.cyan(`[explorerNftMetadataRefresh] card=${contract} tokenId=${tokenId} channels=${channels.join(',')}`));
    }
    return { ok, channels, errors };
}
