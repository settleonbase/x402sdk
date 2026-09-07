"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveGenesisBridgeSettleTxHash = resolveGenesisBridgeSettleTxHash;
exports.enrichGenesisBridgeSettleTxHashes = enrichGenesisBridgeSettleTxHashes;
exports.resolveGenesisPurchaseSplit = resolveGenesisPurchaseSplit;
exports.recordGenesisNodeReferralPurchaseIncome = recordGenesisNodeReferralPurchaseIncome;
exports.recordGenesisNodeReferralPurchaseIncomeInBackground = recordGenesisNodeReferralPurchaseIncomeInBackground;
exports.backfillGenesisNodeReferralIncomeFromFulfillFile = backfillGenesisNodeReferralIncomeFromFulfillFile;
exports.loadGenesisNodeReferralIncomeForAccount = loadGenesisNodeReferralIncomeForAccount;
/**
 * Genesis Node Seat purchase → income ledger.
 * Master writes after fulfill (x402 / in-app gas-sponsored paths); Cluster serves GET income.
 */
const ethers_1 = require("ethers");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const chainAddresses_1 = require("./chainAddresses");
const db_1 = require("./db");
const logger_1 = require("./logger");
const safe_1 = __importDefault(require("colors/safe"));
const VAULT_SPLIT_ABI = [
    'function isActiveL0(address) view returns (bool)',
    'function isActiveL1(address) view returns (bool)',
    'function admins(address) view returns (bool)',
    'function members(address) view returns (uint8 role,address parentAdmin,bool active,address parentL0,uint256 ratioBps)',
    'function foundation() view returns (address)',
    'function defaultAdminPayout() view returns (address)',
    'function previewSplit(uint256 qty) view returns (uint256 l0Pool,uint256 adminAmount,uint256 foundationAmount,uint256 total)',
    'function previewSplitTest(uint256 qty) view returns (uint256 l0Pool,uint256 adminAmount,uint256 foundationAmount,uint256 total)',
];
const BPS = 10000n;
function providerConet() {
    return new ethers_1.ethers.JsonRpcProvider(chainAddresses_1.CONET_RPC_URL);
}
/** Vault `SaleSettled(bytes32 indexed operationId, …)` — emitted inside voteBridge mint+split. */
const VAULT_SALE_SETTLED_TOPIC0 = '0x71b421ea5fb7db4cdcb886e62dcc5bde41df263d90486fcae2629ad45b8e374a';
/** TreasuryBridgeV3 `BridgeOperation(bytes32 indexed operationId, …)` settle phase. */
const TREASURY_BRIDGE_OPERATION_TOPIC0 = '0x3da6c53997af9ec249ba82273b099b7529ae3c371e100fda75e390d8a1f122ba';
/**
 * Resolve CoNET `voteBridgeOperation` tx that mints conet-USDC and runs vault Tokens transferred.
 * Log scan floor = TreasuryBridgeV3 create block ({@link CONET_TREASURY_BRIDGE_V3_DEPLOY_BLOCK}).
 * Prefer vault SaleSettled(opId); fallback Treasury BridgeOperation(opId).
 * Chunk size must stay ≤ ~5k on publicrpc (larger ranges → "could not coalesce").
 */
async function resolveGenesisBridgeSettleTxHash(operationId) {
    const op = String(operationId ?? '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(op))
        return null;
    const provider = providerConet();
    const floor = Math.max(0, Number(chainAddresses_1.CONET_TREASURY_BRIDGE_V3_DEPLOY_BLOCK) || 0);
    let latest = 0;
    try {
        latest = await provider.getBlockNumber();
    }
    catch {
        return null;
    }
    if (latest < floor)
        return null;
    const CHUNK = 2_000;
    const tryFilter = async (address, topic0) => {
        for (let from = floor; from <= latest; from += CHUNK) {
            const to = Math.min(latest, from + CHUNK - 1);
            try {
                const logs = await provider.getLogs({
                    address,
                    topics: [topic0, op],
                    fromBlock: from,
                    toBlock: to,
                });
                const hash = logs.find((log) => /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash))
                    ?.transactionHash;
                if (hash)
                    return hash;
            }
            catch {
                /* try next chunk */
            }
        }
        return null;
    };
    return ((await tryFilter(chainAddresses_1.CONET_GENESIS_NODE_REFERRAL_VAULT, VAULT_SALE_SETTLED_TOPIC0)) ||
        (await tryFilter(chainAddresses_1.CONET_TREASURY_BRIDGE_V3, TREASURY_BRIDGE_OPERATION_TOPIC0)) ||
        null);
}
/** Best-effort fill bridge_settle_tx_hash for purchases still missing the voteBridgeOperation hash. */
async function enrichGenesisBridgeSettleTxHashes(limit = 40) {
    const missing = await (0, db_1.listGenesisNodeReferralPurchasesMissingBridgeSettle)(limit);
    let updated = 0;
    for (const row of missing) {
        const settle = await resolveGenesisBridgeSettleTxHash(row.operationId);
        if (!settle)
            continue;
        await (0, db_1.updateGenesisNodeReferralBridgeSettleTx)({
            usdcTxHash: row.usdcTxHash,
            bridgeSettleTxHash: settle,
        });
        updated += 1;
    }
    return updated;
}
/**
 * Mirror GenesisNodeReferralVaultV1 onBridgeMint attribution using previewSplit + members().
 * `referrer` is the bindSale referrer (Admin / L0 / L1 / zero).
 */
async function resolveGenesisPurchaseSplit(params) {
    const vault = new ethers_1.ethers.Contract(chainAddresses_1.CONET_GENESIS_NODE_REFERRAL_VAULT, VAULT_SPLIT_ABI, providerConet());
    const qty = params.qty;
    const testMode = Boolean(params.testMode);
    const [foundationRaw, defaultAdminRaw, preview] = await Promise.all([
        vault.foundation(),
        vault.defaultAdminPayout(),
        (testMode ? vault.previewSplitTest(qty) : vault.previewSplit(qty)),
    ]);
    const foundation = ethers_1.ethers.getAddress(foundationRaw);
    let adminPay = ethers_1.ethers.getAddress(defaultAdminRaw);
    let l0Pool = BigInt(preview.l0Pool?.toString?.() ?? '0');
    let adminAmount = BigInt(preview.adminAmount?.toString?.() ?? '0');
    let foundationAmount = BigInt(preview.foundationAmount?.toString?.() ?? '0');
    let l0Amount = 0n;
    let l1Amount = 0n;
    let l0Pay = null;
    let l1Pay = null;
    const refRaw = String(params.referrer ?? '').trim();
    const referrer = refRaw && ethers_1.ethers.isAddress(refRaw) && refRaw !== ethers_1.ethers.ZeroAddress ? ethers_1.ethers.getAddress(refRaw) : null;
    if (referrer) {
        const [isL1, isL0, isAdmin] = await Promise.all([
            vault.isActiveL1(referrer),
            vault.isActiveL0(referrer),
            vault.admins(referrer),
        ]);
        if (isL1) {
            const l1 = await vault.members(referrer);
            const parentL0 = ethers_1.ethers.getAddress(l1.parentL0);
            if (parentL0 !== ethers_1.ethers.ZeroAddress && Boolean(await vault.isActiveL0(parentL0))) {
                let ratio = BigInt(l1.ratioBps?.toString?.() ?? '0');
                if (ratio > BPS)
                    ratio = BPS;
                l1Amount = (l0Pool * ratio) / BPS;
                l0Amount = l0Pool - l1Amount;
                l0Pay = parentL0;
                l1Pay = referrer;
                const l0Member = await vault.members(parentL0);
                const parentAdmin = ethers_1.ethers.getAddress(l0Member.parentAdmin);
                if (parentAdmin !== ethers_1.ethers.ZeroAddress)
                    adminPay = parentAdmin;
            }
            else {
                foundationAmount += l0Pool;
            }
        }
        else if (isL0) {
            l0Amount = l0Pool;
            l0Pay = referrer;
            const l0Member = await vault.members(referrer);
            const parentAdmin = ethers_1.ethers.getAddress(l0Member.parentAdmin);
            if (parentAdmin !== ethers_1.ethers.ZeroAddress)
                adminPay = parentAdmin;
        }
        else if (isAdmin) {
            foundationAmount += l0Pool;
            adminPay = referrer;
        }
        else {
            foundationAmount += l0Pool;
        }
    }
    else {
        foundationAmount += l0Pool;
    }
    return {
        referrerL0: l0Pay,
        referrerL1: l1Pay,
        adminPayout: adminAmount > 0n ? adminPay : null,
        foundationPayout: foundationAmount > 0n ? foundation : null,
        l0AmountUsdc6: l0Amount.toString(),
        l1AmountUsdc6: l1Amount.toString(),
        adminAmountUsdc6: adminAmount.toString(),
        foundationAmountUsdc6: foundationAmount.toString(),
    };
}
/** Persist purchase + computed split for Income details (idempotent on USDC_tx). */
async function recordGenesisNodeReferralPurchaseIncome(params) {
    const usdcTx = String(params.usdcTxHash ?? '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
        throw new Error('Invalid USDC_tx for genesis income ledger');
    }
    if (!ethers_1.ethers.isAddress(params.buyer)) {
        throw new Error('Invalid buyer for genesis income ledger');
    }
    const qty = typeof params.qty === 'bigint' ? params.qty : BigInt(String(params.qty || '0'));
    if (qty <= 0n)
        throw new Error('Invalid qty for genesis income ledger');
    const existing = await (0, db_1.getGenesisNodeReferralPurchaseByUsdcTx)(usdcTx);
    if (existing) {
        if (!existing.bridgeSettleTxHash) {
            const settle = (params.bridgeSettleTxHash && /^0x[0-9a-fA-F]{64}$/.test(params.bridgeSettleTxHash.trim())
                ? params.bridgeSettleTxHash.trim()
                : null) || (await resolveGenesisBridgeSettleTxHash(params.operationId));
            if (settle) {
                await (0, db_1.updateGenesisNodeReferralBridgeSettleTx)({
                    usdcTxHash: usdcTx,
                    bridgeSettleTxHash: settle,
                });
            }
        }
        return;
    }
    const split = await resolveGenesisPurchaseSplit({
        referrer: params.referrer,
        qty,
        testMode: params.testMode,
    });
    let bridgeSettle = params.bridgeSettleTxHash && /^0x[0-9a-fA-F]{64}$/.test(params.bridgeSettleTxHash.trim())
        ? params.bridgeSettleTxHash.trim()
        : null;
    if (!bridgeSettle) {
        bridgeSettle = await resolveGenesisBridgeSettleTxHash(params.operationId);
    }
    await (0, db_1.upsertGenesisNodeReferralPurchase)({
        usdcTxHash: usdcTx,
        operationId: params.operationId,
        bindTxHash: params.bindTxHash ?? null,
        lockMintTxHash: params.lockMintTxHash ?? null,
        bridgeSettleTxHash: bridgeSettle,
        buyer: params.buyer,
        payer: params.payer ?? null,
        qty: qty.toString(),
        testMode: params.testMode,
        referrer: params.referrer ?? null,
        referrerL0: split.referrerL0,
        referrerL1: split.referrerL1,
        adminPayout: split.adminPayout,
        foundationPayout: split.foundationPayout,
        l0AmountUsdc6: split.l0AmountUsdc6,
        l1AmountUsdc6: split.l1AmountUsdc6,
        adminAmountUsdc6: split.adminAmountUsdc6,
        foundationAmountUsdc6: split.foundationAmountUsdc6,
        purchasedAt: params.purchasedAt ?? null,
    });
}
/** Fire-and-forget write used after fulfill success / idempotent hit. */
function recordGenesisNodeReferralPurchaseIncomeInBackground(params) {
    void recordGenesisNodeReferralPurchaseIncome(params).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.yellow(`[genesisNodeReferralIncome] record failed: ${msg}`));
    });
}
function resolveGenesisNodeSeatFulfillFile() {
    return (process.env.CONET_GENESIS_NODE_SEAT_FULFILL_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-genesis-node-seat-fulfill.json'));
}
/**
 * Best-effort: import historical fulfill JSON rows into the income DB (idempotent).
 * Runs before Cluster GET so older x402 purchases appear without re-fulfill.
 */
async function backfillGenesisNodeReferralIncomeFromFulfillFile() {
    const file = resolveGenesisNodeSeatFulfillFile();
    if (!node_fs_1.default.existsSync(file))
        return 0;
    let all = {};
    try {
        all = JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
    }
    catch {
        return 0;
    }
    let written = 0;
    for (const row of Object.values(all)) {
        const usdcTx = String(row.USDC_tx ?? '').trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx))
            continue;
        if (!row.beneficiary || !ethers_1.ethers.isAddress(row.beneficiary))
            continue;
        if (!row.operationId)
            continue;
        try {
            const existing = await (0, db_1.getGenesisNodeReferralPurchaseByUsdcTx)(usdcTx);
            if (existing) {
                if (!existing.bridgeSettleTxHash) {
                    const settle = await resolveGenesisBridgeSettleTxHash(String(row.operationId));
                    if (settle) {
                        await (0, db_1.updateGenesisNodeReferralBridgeSettleTx)({
                            usdcTxHash: usdcTx,
                            bridgeSettleTxHash: settle,
                        });
                    }
                }
                continue;
            }
            await recordGenesisNodeReferralPurchaseIncome({
                usdcTxHash: usdcTx,
                operationId: String(row.operationId),
                bindTxHash: row.bindTxHash ?? null,
                lockMintTxHash: row.lockMintTxHash ?? null,
                buyer: row.beneficiary,
                payer: row.payer ?? null,
                qty: row.qty ?? '0',
                testMode: Boolean(row.testMode),
                referrer: row.referrerL0 || null,
                purchasedAt: row.fulfilledAt ?? null,
            });
            written += 1;
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            (0, logger_1.logger)(safe_1.default.yellow(`[genesisNodeReferralIncome] backfill skip ${usdcTx.slice(0, 12)}…: ${msg}`));
        }
    }
    return written;
}
/** Cluster read path: backfill legacy file, resolve missing settle hashes, then return income page. */
async function loadGenesisNodeReferralIncomeForAccount(account, options = {}) {
    const incremental = typeof options.sinceMs === 'number' && options.sinceMs > 0;
    if (!options.skipBackfill && !incremental) {
        try {
            await backfillGenesisNodeReferralIncomeFromFulfillFile();
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            (0, logger_1.logger)(safe_1.default.yellow(`[genesisNodeReferralIncome] backfill error: ${msg}`));
        }
    }
    try {
        await enrichGenesisBridgeSettleTxHashes(incremental ? 10 : 40);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.yellow(`[genesisNodeReferralIncome] settle enrich error: ${msg}`));
    }
    return (0, db_1.listGenesisNodeReferralIncomeForAccount)(account, {
        sinceMs: options.sinceMs,
        beforeMs: options.beforeMs,
        limit: options.limit,
    });
}
