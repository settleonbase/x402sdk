"use strict";
/**
 * CoNET mainnet Blockscout REST client (https://mainnet.conet.network/api/v2).
 * Used for NodeRewardSettled log scans where eth_getLogs block range is capped at ~5000.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONET_BLOCKSCOUT_API_BASE = void 0;
exports.fetchBlockscoutAddressLogsPage = fetchBlockscoutAddressLogsPage;
exports.parseNodeRewardSettledFromBlockscoutLog = parseNodeRewardSettledFromBlockscoutLog;
exports.CONET_BLOCKSCOUT_API_BASE = (process.env.CONET_BLOCKSCOUT_API_BASE?.trim() || 'https://mainnet.conet.network/api/v2').replace(/\/$/, '');
function logsPageQuery(params) {
    if (!params)
        return '';
    const q = new URLSearchParams();
    q.set('index', String(params.index));
    q.set('block_number', String(params.block_number));
    q.set('items_count', String(params.items_count));
    return `?${q.toString()}`;
}
async function fetchBlockscoutAddressLogsPage(contractAddress, pageParams) {
    const addr = contractAddress.trim();
    const url = `${exports.CONET_BLOCKSCOUT_API_BASE}/addresses/${addr}/logs${logsPageQuery(pageParams)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) {
        throw new Error(`Blockscout logs HTTP ${response.status} for ${addr}`);
    }
    const payload = (await response.json());
    return {
        items: Array.isArray(payload.items) ? payload.items : [],
        next_page_params: payload.next_page_params ?? null,
    };
}
function parseNodeRewardSettledFromBlockscoutLog(log) {
    const call = log.decoded?.method_call ?? '';
    if (!call.startsWith('NodeRewardSettled'))
        return null;
    const params = log.decoded?.parameters ?? [];
    const byName = new Map();
    for (const p of params) {
        if (p.name)
            byName.set(p.name, String(p.value ?? ''));
    }
    const guardianId = Number(byName.get('guardianId') ?? NaN);
    const beneficiary = String(byName.get('beneficiary') ?? '').trim();
    const amountRaw = byName.get('amount') ?? '0';
    const eventKey = String(byName.get('eventKey') ?? '').trim();
    if (!Number.isFinite(guardianId) || guardianId <= 0)
        return null;
    if (!beneficiary || !beneficiary.startsWith('0x'))
        return null;
    let amount;
    try {
        amount = BigInt(amountRaw);
    }
    catch {
        return null;
    }
    if (amount <= 0n)
        return null;
    return { guardianId, beneficiary, amount, eventKey };
}
