"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCdpEvmTokenBalancesAllPages = fetchCdpEvmTokenBalancesAllPages;
exports.mapCdpRowsToBaseAaSmartWalletItems = mapCdpRowsToBaseAaSmartWalletItems;
exports.fetchBaseAaSmartWalletBalancesViaCdp = fetchBaseAaSmartWalletBalancesViaCdp;
const node_fetch_1 = __importDefault(require("node-fetch"));
const ethers_1 = require("ethers");
const auth_1 = require("@coinbase/cdp-sdk/auth");
const coinbase_1 = require("./coinbase");
const chainAddresses_1 = require("./chainAddresses");
const CDP_HOST = 'api.cdp.coinbase.com';
const NATIVE_ETH_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
async function cdpJwt(method, path) {
    const { apiKeyId, apiKeySecret } = (0, coinbase_1.getCDPCredentials)();
    return (0, auth_1.generateJwt)({
        apiKeyId,
        apiKeySecret,
        requestMethod: method,
        requestPath: path,
        requestHost: CDP_HOST,
    });
}
/** Paginated CDP token balances for one EVM network (Base). */
async function fetchCdpEvmTokenBalancesAllPages(network, address, maxPages = 5) {
    const checksum = ethers_1.ethers.getAddress(address);
    const out = [];
    let pageToken;
    for (let page = 0; page < maxPages; page++) {
        const basePath = `/platform/v2/evm/token-balances/${network}/${checksum}`;
        const path = pageToken
            ? `${basePath}?pageToken=${encodeURIComponent(pageToken)}`
            : basePath;
        const jwt = await cdpJwt('GET', path.split('?')[0]);
        const url = `https://${CDP_HOST}${path}`;
        const res = await (0, node_fetch_1.default)(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`CDP token-balances failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const data = (await res.json());
        for (const row of data.balances ?? []) {
            const amountStr = row.amount?.amount;
            const decimals = row.amount?.decimals;
            const contractAddress = row.token?.contractAddress;
            if (amountStr == null || decimals == null || !contractAddress)
                continue;
            let raw;
            try {
                raw = BigInt(amountStr);
            }
            catch {
                continue;
            }
            if (raw <= 0n)
                continue;
            out.push({
                amountRaw: raw.toString(),
                decimals,
                symbol: String(row.token?.symbol ?? '').trim() || '?',
                name: String(row.token?.name ?? '').trim() || '?',
                contractAddress: ethers_1.ethers.getAddress(contractAddress),
            });
        }
        pageToken = data.nextPageToken?.trim() || undefined;
        if (!pageToken)
            break;
    }
    return out;
}
function isNativeEthToken(contractAddress) {
    return contractAddress.toLowerCase() === NATIVE_ETH_PLACEHOLDER;
}
/** Map CDP rows to AA multisig UI items (Base ETH + Base USDC only). */
function mapCdpRowsToBaseAaSmartWalletItems(rows) {
    const usdcLower = chainAddresses_1.USDC_BASE.toLowerCase();
    const items = [];
    for (const row of rows) {
        const contractLower = row.contractAddress.toLowerCase();
        if (isNativeEthToken(contractLower) || row.symbol.toUpperCase() === 'ETH') {
            items.push({
                id: 'base_eth',
                label: 'Base ETH',
                symbol: 'ETH',
                amountRaw: row.amountRaw,
                decimals: row.decimals,
                contractAddress: row.contractAddress,
            });
            continue;
        }
        if (contractLower === usdcLower || row.symbol.toUpperCase() === 'USDC') {
            items.push({
                id: 'base_usdc',
                label: 'Base USDC',
                symbol: 'USDC',
                amountRaw: row.amountRaw,
                decimals: row.decimals,
                contractAddress: row.contractAddress,
            });
        }
    }
    const order = ['base_eth', 'base_usdc'];
    return order
        .map((id) => items.find((i) => i.id === id))
        .filter((i) => i != null);
}
async function fetchBaseAaSmartWalletBalancesViaCdp(aaAddress, baseProvider) {
    const checksum = ethers_1.ethers.getAddress(aaAddress);
    const code = await baseProvider.getCode(checksum);
    const aaDeployed = !!(code && code !== '0x' && code.length > 2);
    if (!aaDeployed) {
        return { aaDeployed: false, aaAddress: checksum, items: [] };
    }
    const rows = await fetchCdpEvmTokenBalancesAllPages('base', checksum);
    return {
        aaDeployed: true,
        aaAddress: checksum,
        items: mapCdpRowsToBaseAaSmartWalletItems(rows),
    };
}
