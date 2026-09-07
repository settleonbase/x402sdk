"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAaTransferAssetId = parseAaTransferAssetId;
exports.relayChainForTransferAsset = relayChainForTransferAsset;
exports.parseAaUserOpRelayChain = parseAaUserOpRelayChain;
exports.resolveAaUserOpRelayChainFromRequest = resolveAaUserOpRelayChainFromRequest;
function parseAaTransferAssetId(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    switch (s) {
        case 'cnet':
        case 'usdc':
        case 'gb_paid':
        case 'buint_paid':
        case 'base_eth':
        case 'base_usdc':
            return s;
        default:
            return null;
    }
}
function relayChainForTransferAsset(asset) {
    if (asset === 'base_eth' || asset === 'base_usdc')
        return 'base';
    return 'conet';
}
function parseAaUserOpRelayChain(raw) {
    if (raw === 'conet' || raw === 'base')
        return raw;
    return null;
}
/** UserOp relay 链：以客户端声明的 transferAsset 为主；relayChain 为显式备选。禁止靠 getCode 猜链。 */
function resolveAaUserOpRelayChainFromRequest(input) {
    const asset = parseAaTransferAssetId(input.transferAsset);
    if (asset) {
        return { ok: true, chain: relayChainForTransferAsset(asset), transferAsset: asset };
    }
    const chain = parseAaUserOpRelayChain(input.relayChain);
    if (chain) {
        return { ok: true, chain };
    }
    return {
        ok: false,
        error: 'transferAsset or relayChain is required for UserOp relay (e.g. transferAsset=cnet or relayChain=base). Server does not infer chain from bytecode.',
    };
}
