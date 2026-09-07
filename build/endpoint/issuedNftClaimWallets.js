"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listIssuedNftClaimWallets = listIssuedNftClaimWallets;
const ethers_1 = require("ethers");
const logger_1 = require("../logger");
const safe_1 = __importDefault(require("colors/safe"));
const db_1 = require("../db");
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? 'https://base-rpc.conet.network';
const JSONRPC_NO_BATCH = { batchMaxCount: 1 };
const ISSUED_NFT_MINTED_IFACE = new ethers_1.ethers.Interface([
    'event IssuedNftMinted(uint256 indexed tokenId, address indexed recipient, uint256 amount)',
]);
const ISSUED_NFT_MINTED_TOPIC = ISSUED_NFT_MINTED_IFACE.getEvent('IssuedNftMinted').topicHash;
const ISSUED_NFT_BURNED_IFACE = new ethers_1.ethers.Interface([
    'event IssuedNftBurned(uint256 indexed tokenId, address indexed holder, uint256 amount)',
]);
const ISSUED_NFT_BURNED_TOPIC = ISSUED_NFT_BURNED_IFACE.getEvent('IssuedNftBurned').topicHash;
/** ERC-1155 issued coupon/catalog series start at 100_000_000_000. */
const ISSUED_NFT_TOKEN_ID_MIN = 100000000000n;
const LOG_CHUNK_SIZE = 500000n;
const AVG_BLOCK_SEC = 2;
const FROM_BLOCK_BUFFER = 2000n;
async function resolveDisplayWallet(provider, addr) {
    if (!ethers_1.ethers.isAddress(addr))
        return '';
    const checksummed = ethers_1.ethers.getAddress(addr);
    try {
        const code = await provider.getCode(checksummed);
        if (!code || code === '0x')
            return checksummed;
        const owner = await new ethers_1.ethers.Contract(checksummed, ['function owner() view returns (address)'], provider).owner();
        if (owner && ethers_1.ethers.isAddress(owner) && owner !== ethers_1.ethers.ZeroAddress) {
            return ethers_1.ethers.getAddress(owner);
        }
    }
    catch {
        /* non-ownable contract — show holder as-is */
    }
    return checksummed;
}
async function estimateFromBlock(provider, seriesCreatedAtIso) {
    const head = BigInt(await provider.getBlockNumber());
    if (!seriesCreatedAtIso) {
        return head > 4000000n ? head - 4000000n : 0n;
    }
    const createdMs = Date.parse(seriesCreatedAtIso);
    if (!Number.isFinite(createdMs) || createdMs <= 0) {
        return head > 4000000n ? head - 4000000n : 0n;
    }
    const ageSec = Math.max(0, (Date.now() - createdMs) / 1000);
    const blocksAgo = BigInt(Math.ceil(ageSec / AVG_BLOCK_SEC) + Number(FROM_BLOCK_BUFFER));
    return blocksAgo >= head ? 0n : head - blocksAgo;
}
async function fetchIssuedNftMintedLogs(provider, cardAddress, tokenId, fromBlock, toBlock) {
    const tokenTopic = ethers_1.ethers.zeroPadValue(ethers_1.ethers.toBeHex(tokenId), 32);
    const out = [];
    let cursor = fromBlock;
    while (cursor <= toBlock) {
        const end = cursor + LOG_CHUNK_SIZE > toBlock ? toBlock : cursor + LOG_CHUNK_SIZE;
        try {
            const chunk = await provider.getLogs({
                address: cardAddress,
                topics: [ISSUED_NFT_MINTED_TOPIC, tokenTopic],
                fromBlock: cursor,
                toBlock: end,
            });
            out.push(...chunk);
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[issuedNftClaimWallets] getLogs chunk failed card=${cardAddress} tokenId=${tokenId} ${cursor}-${end}: ${e?.message ?? e}`));
            if (end - cursor <= 50000n)
                throw e;
            const mid = cursor + (end - cursor) / 2n;
            const left = await fetchIssuedNftMintedLogs(provider, cardAddress, tokenId, cursor, mid);
            const right = await fetchIssuedNftMintedLogs(provider, cardAddress, tokenId, mid + 1n, end);
            out.push(...left, ...right);
        }
        cursor = end + 1n;
    }
    return out;
}
async function fetchIssuedNftBurnedLogs(provider, cardAddress, tokenId, fromBlock, toBlock) {
    const tokenTopic = ethers_1.ethers.zeroPadValue(ethers_1.ethers.toBeHex(tokenId), 32);
    const out = [];
    let cursor = fromBlock;
    while (cursor <= toBlock) {
        const end = cursor + LOG_CHUNK_SIZE > toBlock ? toBlock : cursor + LOG_CHUNK_SIZE;
        try {
            const chunk = await provider.getLogs({
                address: cardAddress,
                topics: [ISSUED_NFT_BURNED_TOPIC, tokenTopic],
                fromBlock: cursor,
                toBlock: end,
            });
            out.push(...chunk);
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[issuedNftClaimWallets] burn getLogs chunk failed card=${cardAddress} tokenId=${tokenId} ${cursor}-${end}: ${e?.message ?? e}`));
            if (end - cursor <= 50000n)
                throw e;
            const mid = cursor + (end - cursor) / 2n;
            const left = await fetchIssuedNftBurnedLogs(provider, cardAddress, tokenId, cursor, mid);
            const right = await fetchIssuedNftBurnedLogs(provider, cardAddress, tokenId, mid + 1n, end);
            out.push(...left, ...right);
        }
        cursor = end + 1n;
    }
    return out;
}
/** holder (lowercase) → latest burn block for this issued series tokenId */
function buildLatestBurnBlockByHolder(burnLogs) {
    const byHolder = new Map();
    for (const log of burnLogs) {
        let holder;
        try {
            const parsed = ISSUED_NFT_BURNED_IFACE.parseLog({ topics: log.topics, data: log.data });
            if (!parsed)
                continue;
            holder = ethers_1.ethers.getAddress(String(parsed.args.holder)).toLowerCase();
        }
        catch {
            continue;
        }
        const blockNumber = Number(log.blockNumber ?? 0);
        const prev = byHolder.get(holder);
        if (!prev || blockNumber >= prev) {
            byHolder.set(holder, blockNumber);
        }
    }
    return byHolder;
}
async function blockToIso(provider, blockNumber) {
    if (!Number.isFinite(blockNumber) || blockNumber <= 0)
        return '';
    try {
        const block = await provider.getBlock(blockNumber);
        if (block?.timestamp) {
            return new Date(Number(block.timestamp) * 1000).toISOString();
        }
    }
    catch {
        /* optional */
    }
    return '';
}
/** Paginated wallets that received this issued NFT (mint / open-claim / redeem mint). */
async function listIssuedNftClaimWallets(args) {
    const cardNorm = ethers_1.ethers.getAddress(args.cardAddress);
    let tokenIdN;
    try {
        tokenIdN = BigInt(String(args.tokenId).trim());
    }
    catch {
        throw new Error('Invalid tokenId');
    }
    if (tokenIdN < ISSUED_NFT_TOKEN_ID_MIN) {
        throw new Error('tokenId is not an issued NFT series');
    }
    const page = Math.max(1, Math.floor(Number(args.page ?? 1) || 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(Number(args.pageSize ?? 10) || 10)));
    const provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL, undefined, JSONRPC_NO_BATCH);
    const series = await (0, db_1.getSeriesByCardAndTokenId)(cardNorm, tokenIdN.toString());
    const fromBlock = await estimateFromBlock(provider, series?.createdAt);
    const head = BigInt(await provider.getBlockNumber());
    const [mintLogs, burnLogs] = await Promise.all([
        fetchIssuedNftMintedLogs(provider, cardNorm, tokenIdN, fromBlock, head),
        fetchIssuedNftBurnedLogs(provider, cardNorm, tokenIdN, fromBlock, head),
    ]);
    const burnBlockByHolder = buildLatestBurnBlockByHolder(burnLogs);
    const byWallet = new Map();
    for (const log of mintLogs) {
        let recipient;
        try {
            const parsed = ISSUED_NFT_MINTED_IFACE.parseLog({ topics: log.topics, data: log.data });
            if (!parsed)
                continue;
            recipient = ethers_1.ethers.getAddress(String(parsed.args.recipient));
        }
        catch {
            continue;
        }
        const blockNumber = Number(log.blockNumber ?? 0);
        const txHash = String(log.transactionHash ?? '');
        const key = recipient.toLowerCase();
        const prev = byWallet.get(key);
        if (!prev || blockNumber >= prev.blockNumber) {
            byWallet.set(key, {
                holder: recipient,
                wallet: recipient,
                blockNumber,
                txHash,
                claimedAt: '',
            });
        }
    }
    const sorted = [...byWallet.values()].sort((a, b) => b.blockNumber - a.blockNumber);
    const walletResolved = await Promise.all(sorted.map(async (row) => {
        const wallet = await resolveDisplayWallet(provider, row.holder);
        const claimedAt = await blockToIso(provider, row.blockNumber);
        const burnBlock = burnBlockByHolder.get(row.holder.toLowerCase()) ??
            burnBlockByHolder.get(wallet.toLowerCase()) ??
            0;
        const burnedAt = burnBlock > 0 ? await blockToIso(provider, burnBlock) : '';
        return { ...row, wallet, claimedAt, burnedAt };
    }));
    const total = walletResolved.length;
    const start = (page - 1) * pageSize;
    const items = walletResolved.slice(start, start + pageSize).map((row) => ({
        wallet: row.wallet,
        holder: row.holder,
        claimedAt: row.claimedAt,
        burnedAt: row.burnedAt,
        txHash: row.txHash,
        blockNumber: row.blockNumber,
    }));
    return {
        ok: true,
        cardAddress: cardNorm,
        tokenId: tokenIdN.toString(),
        page,
        pageSize,
        total,
        items,
    };
}
