"use strict";
/**
 * CL consensus-layer skim payout reporter: scans execution-layer block withdrawals
 * credited to ValidatorDepositRedeem proxy, maps validatorIndex → guardianId → current beneficiary,
 * and calls {settleNodeRewards} on-chain (idempotent eventKey per withdrawal).
 *
 * Restart / catch-up semantics (see beamio-chain-listener-block-scan-ceiling.mdc):
 * - Each scan session snapshots chain head once into state.scanTargetBlock (ceiling).
 * - While lastProcessedBlock < scanTargetBlock, ticks only advance toward that ceiling — never
 *   re-read live head and extend the range mid-catch-up (restart-safe).
 * - After caught up, the next tick starts a new session with a fresh scanTargetBlock = live head.
 * - Each tick processes at most CHUNKS_PER_TICK × CHUNK_BLOCKS blocks (default 1×32).
 *
 * Pending pool + cross-block batching:
 * - Scanned withdrawals are merged into a persisted pending pool (dedupe by eventKey).
 * - Checkpoint advances after a block is successfully scanned into the pool (settle may lag).
 * - Flush submits settleNodeRewards in split batches when gasPrice ≤ max and settle wallet
 *   has enough balance for gasLimit × gasPrice.
 * - If estimateGas / submit fails for n>1, auto-bisect and retry both halves (never stall the
 *   whole pending pool on one oversized batch). A singleton that still fails is skipped for this
 *   flush round and retried later; remaining batches continue.
 * - If gas stays above max for longer than the force-wait window (default 3 min), flush anyway
 *   at the live gasPrice to drain the pending pool (countdown logged while waiting).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startValidatorClRewardPayoutReporter = startValidatorClRewardPayoutReporter;
exports.stopValidatorClRewardPayoutReporter = stopValidatorClRewardPayoutReporter;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const util_1 = require("../util");
const settleContractPool_1 = require("../settleContractPool");
const onchainTxSerialQueue_1 = require("../onchainTxSerialQueue");
const chainAddresses_1 = require("../chainAddresses");
const validatorDepositRedeem_1 = require("./validatorDepositRedeem");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
const PAYOUT_ABI = [
    'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys) external',
    'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
    'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
    'function consumedRewardEventKey(bytes32 key) view returns (bool)',
];
let payoutStarted = false;
let payoutTimer;
let payoutInFlight = false;
function resolveStateFile() {
    return (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_STATE_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-validator-cl-reward-payout-state.json'));
}
function resolveBeaconRestUrl() {
    return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '');
}
function resolveTickMs() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_TICK_MS || 60_000);
    return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000;
}
function resolveChunkBlocks() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNK_BLOCKS || 32);
    return Number.isFinite(n) && n >= 1 ? Math.min(512, Math.floor(n)) : 32;
}
/** Max eth_getBlock chunks processed per tick (default 1 — avoids monopolizing on-chain queue). */
function resolveChunksPerTick() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CHUNKS_PER_TICK || 1);
    return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 1;
}
/** Hard cap on entries per settleNodeRewards tx (before gas/calldata split). */
function resolveMaxEntriesPerTx() {
    // Measured on CONET mainnet (2026-08): n=40 estimateGas ≈ 2.29M > 2M gasLimit (OOG);
    // n=64 ≈ 2.43M; n=48 ≈ 1.83M. Default 29 keeps ~1.66M est + 20% buffer under 2M.
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_ENTRIES || 29);
    return Number.isFinite(n) && n >= 1 ? Math.min(256, Math.floor(n)) : 29;
}
function resolveGasLimit() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_LIMIT || 2_000_000);
    return Number.isFinite(n) && n >= 100_000 ? Math.min(8_000_000, Math.floor(n)) : 2_000_000;
}
/** Conservative gas model for pre-split (mainnet estimateGas ≈ 100k + ~55k/entry incl. period accumulate). */
function resolveGasBase() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_BASE || 100_000);
    return Number.isFinite(n) && n >= 21_000 ? Math.floor(n) : 100_000;
}
function resolveGasPerEntry() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_PER_ENTRY || 55_000);
    return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : 55_000;
}
/** Max calldata bytes per tx (RPC / node limits); leave headroom under common 128KiB caps. */
function resolveMaxCalldataBytes() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_CALLDATA_BYTES || 48_000);
    return Number.isFinite(n) && n >= 2_000 ? Math.min(100_000, Math.floor(n)) : 48_000;
}
/** Approx ABI encoding size per entry across three dynamic arrays. */
function resolveCalldataBytesPerEntry() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_CALLDATA_PER_ENTRY || 128);
    return Number.isFinite(n) && n >= 64 ? Math.floor(n) : 128;
}
/**
 * Only submit when eth_gasPrice ≤ this many gwei (default 2).
 * CONET often sits at exactly 2.0 gwei — use ≤ not <.
 */
function resolveMaxGasPriceWei() {
    const gwei = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_MAX_GAS_PRICE_GWEI || 2);
    const safe = Number.isFinite(gwei) && gwei > 0 ? gwei : 2;
    return ethers_1.ethers.parseUnits(String(safe), 'gwei');
}
/** After this many ms waiting on high gas, force flush at live gasPrice (default 3 min). */
function resolveGasWaitForceMs() {
    const n = Number(process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_GAS_WAIT_FORCE_MS || 180_000);
    return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 180_000;
}
function clearGasWait(state) {
    if (!state.gasWaitStartedAt)
        return false;
    delete state.gasWaitStartedAt;
    return true;
}
function formatWaitCountdown(elapsedMs, forceMs) {
    const leftMs = Math.max(0, forceMs - elapsedMs);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const leftSec = Math.ceil(leftMs / 1000);
    const forceSec = Math.floor(forceMs / 1000);
    return `${elapsedSec}s/${forceSec}s (force in ${leftSec}s)`;
}
function normalizeScanTargetBlock(raw) {
    if (raw == null)
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
/** True when catch-up to the persisted ceiling is complete (or no ceiling yet). */
function isScanCatchUpComplete(state) {
    const target = normalizeScanTargetBlock(state.scanTargetBlock);
    if (target == null)
        return true;
    return state.lastProcessedBlock >= target;
}
function payoutDryRun() {
    const v = (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
function payoutEnabled() {
    if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT === '0')
        return false;
    if (process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT === '1')
        return true;
    return process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1';
}
function resolveDeployBlockFloor() {
    const env = process.env.CONET_VALIDATOR_CL_REWARD_PAYOUT_DEPLOY_BLOCK?.trim() ||
        process.env.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK?.trim();
    if (env) {
        const n = Number(env);
        if (Number.isFinite(n) && n >= 0)
            return Math.floor(n);
    }
    return chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK;
}
function entryToJson(e) {
    return {
        guardianId: e.guardianId.toString(),
        amount: e.amount.toString(),
        eventKey: e.eventKey.toLowerCase(),
        blockNumber: e.blockNumber,
        withdrawalIndex: e.withdrawalIndex,
    };
}
function entryFromJson(raw) {
    try {
        const eventKey = String(raw.eventKey || '').toLowerCase();
        if (!eventKey || eventKey === ethers_1.ethers.ZeroHash)
            return null;
        const guardianId = BigInt(raw.guardianId);
        const amount = BigInt(raw.amount);
        if (guardianId <= 0n || amount <= 0n)
            return null;
        const blockNumber = Number(raw.blockNumber);
        const withdrawalIndex = Number(raw.withdrawalIndex);
        if (!Number.isFinite(blockNumber) || !Number.isFinite(withdrawalIndex))
            return null;
        return { guardianId, amount, eventKey, blockNumber, withdrawalIndex };
    }
    catch {
        return null;
    }
}
function loadPendingMap(state) {
    const map = new Map();
    for (const raw of state.pending ?? []) {
        const e = entryFromJson(raw);
        if (!e)
            continue;
        map.set(e.eventKey, e);
    }
    return map;
}
function persistPending(state, pending) {
    state.pending = [...pending.values()]
        .sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
        .map(entryToJson);
    writeState(state);
}
function mergeIntoPending(pending, entries) {
    let added = 0;
    for (const e of entries) {
        const key = e.eventKey.toLowerCase();
        if (pending.has(key))
            continue;
        pending.set(key, { ...e, eventKey: key });
        added++;
    }
    return added;
}
/**
 * Split entries so each batch respects max entries, estimated gas, and calldata size.
 * Never returns a batch larger than the configured on-chain interaction limits.
 */
function splitEntriesForOnchain(entries) {
    if (!entries.length)
        return [];
    const maxEntries = resolveMaxEntriesPerTx();
    const gasLimit = resolveGasLimit();
    const gasBase = resolveGasBase();
    const gasPer = resolveGasPerEntry();
    const maxCalldata = resolveMaxCalldataBytes();
    const calldataPer = resolveCalldataBytesPerEntry();
    // Keep ~15% gas headroom under configured gasLimit.
    const gasBudget = Math.floor(gasLimit * 0.85);
    const maxByGas = Math.max(1, Math.floor((gasBudget - gasBase) / gasPer));
    const maxByCalldata = Math.max(1, Math.floor((maxCalldata - 512) / calldataPer));
    const chunkSize = Math.max(1, Math.min(maxEntries, maxByGas, maxByCalldata));
    const batches = [];
    for (let i = 0; i < entries.length; i += chunkSize) {
        batches.push(entries.slice(i, i + chunkSize));
    }
    return batches;
}
/** estimateGas + 20% headroom; returns null when buffered estimate exceeds configured gasLimit. */
async function resolveSubmitGasLimit(contract, guardianIds, amounts, eventKeys) {
    const cap = resolveGasLimit();
    try {
        const est = await contract.settleNodeRewards.estimateGas(guardianIds, amounts, eventKeys);
        const buffered = (est * 120n) / 100n + 50000n;
        if (buffered > BigInt(cap))
            return null;
        return Number(buffered);
    }
    catch {
        return cap;
    }
}
function readState() {
    const file = resolveStateFile();
    try {
        if (!node_fs_1.default.existsSync(file)) {
            return { lastProcessedBlock: resolveDeployBlockFloor() - 1, pending: [], updatedAt: new Date().toISOString() };
        }
        const raw = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
        const floor = resolveDeployBlockFloor();
        const last = Number(raw.lastProcessedBlock);
        if (!Number.isFinite(last)) {
            return { lastProcessedBlock: floor - 1, pending: [], updatedAt: new Date().toISOString() };
        }
        const scanTargetBlock = normalizeScanTargetBlock(raw.scanTargetBlock);
        const pending = Array.isArray(raw.pending) ? raw.pending : [];
        const gasWaitStartedAt = typeof raw.gasWaitStartedAt === 'string' && raw.gasWaitStartedAt.trim()
            ? raw.gasWaitStartedAt.trim()
            : undefined;
        return {
            lastProcessedBlock: Math.max(floor - 1, Math.floor(last)),
            scanTargetBlock,
            pending,
            gasWaitStartedAt,
            updatedAt: raw.updatedAt ?? new Date().toISOString(),
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] state reset: ${e?.message ?? e}`));
        return { lastProcessedBlock: resolveDeployBlockFloor() - 1, pending: [], updatedAt: new Date().toISOString() };
    }
}
function writeState(state) {
    const file = resolveStateFile();
    state.updatedAt = new Date().toISOString();
    if (!Array.isArray(state.pending))
        state.pending = [];
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
const validatorPubkeyCache = new Map();
async function fetchValidatorPubkeyByIndex(validatorIndex) {
    if (validatorPubkeyCache.has(validatorIndex)) {
        return validatorPubkeyCache.get(validatorIndex) ?? null;
    }
    const base = resolveBeaconRestUrl();
    const url = `${base}/eth/v1/beacon/states/head/validators/${validatorIndex}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
            validatorPubkeyCache.set(validatorIndex, null);
            return null;
        }
        const json = (await res.json());
        const pk = json?.data?.validator?.pubkey?.trim();
        if (!pk) {
            validatorPubkeyCache.set(validatorIndex, null);
            return null;
        }
        const normalized = ethers_1.ethers.hexlify(ethers_1.ethers.getBytes(pk.startsWith('0x') ? pk : `0x${pk}`)).toLowerCase();
        validatorPubkeyCache.set(validatorIndex, normalized);
        return normalized;
    }
    catch {
        return null;
    }
}
async function fetchBlockWithWithdrawals(provider, blockNumber) {
    try {
        const hex = ethers_1.ethers.toQuantity(blockNumber);
        const block = (await provider.send('eth_getBlockByNumber', [hex, false]));
        return block;
    }
    catch {
        return null;
    }
}
function withdrawalEventKey(blockNumber, withdrawalIndex) {
    return ethers_1.ethers.keccak256(ethers_1.ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(blockNumber), BigInt(withdrawalIndex)]));
}
async function resolveGuardianIdForWithdrawal(contract, validatorIndex) {
    const pubkey = await fetchValidatorPubkeyByIndex(validatorIndex);
    if (!pubkey)
        return null;
    const pkHash = ethers_1.ethers.keccak256(pubkey);
    try {
        const guardianId = await contract.getNodeByValidatorPubkeyHash(pkHash);
        const gid = BigInt(guardianId);
        if (gid <= 0n)
            return null;
        // adminRelease clears beneficiary; legacy pubkey→gid mapping may remain (Lab 136 341–476).
        const beneficiary = String(await contract.guardianIdBeneficiary(gid));
        if (beneficiary === ethers_1.ethers.ZeroAddress)
            return null;
        return gid;
    }
    catch {
        return null;
    }
}
async function collectPayoutEntriesForBlock(contract, proxyLower, blockNumber, block) {
    const withdrawals = block.withdrawals ?? [];
    const entries = [];
    for (const w of withdrawals) {
        const addr = String(w.address ?? '').toLowerCase();
        if (addr !== proxyLower)
            continue;
        const amountGwei = BigInt(String(w.amount ?? '0'));
        if (amountGwei <= 0n)
            continue;
        const amountWei = amountGwei * 1000000000n;
        const validatorIndex = Number(w.validatorIndex);
        if (!Number.isFinite(validatorIndex) || validatorIndex < 0)
            continue;
        const withdrawalIndex = Number(w.index);
        if (!Number.isFinite(withdrawalIndex) || withdrawalIndex < 0)
            continue;
        const guardianId = await resolveGuardianIdForWithdrawal(contract, validatorIndex);
        if (guardianId == null)
            continue;
        entries.push({
            guardianId,
            amount: amountWei,
            eventKey: withdrawalEventKey(blockNumber, withdrawalIndex).toLowerCase(),
            blockNumber,
            withdrawalIndex,
        });
    }
    return entries;
}
async function withSettleWallet(label, fn) {
    if (!(0, settleContractPool_1.hasIdleSettleConet)())
        return undefined;
    const sc = (0, settleContractPool_1.shiftSettleConet)();
    if (!sc)
        return undefined;
    try {
        return await fn(sc);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.red(`[validatorClRewardPayout] ${label} failed: ${e?.message ?? e}`));
        return undefined;
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(sc);
    }
}
function peekSettleWalletAddress() {
    const sc = settleContractPool_1.Settle_ContractPool[0];
    const addr = sc?.walletConet?.address;
    return addr ? ethers_1.ethers.getAddress(addr) : null;
}
async function readGasPriceWei(provider) {
    try {
        const fee = await provider.getFeeData();
        if (fee.gasPrice != null && fee.gasPrice > 0n)
            return fee.gasPrice;
        if (fee.maxFeePerGas != null && fee.maxFeePerGas > 0n)
            return fee.maxFeePerGas;
    }
    catch {
        /* fall through */
    }
    const hex = (await provider.send('eth_gasPrice', []));
    return BigInt(hex);
}
async function filterUnconsumed(readContract, entries) {
    const out = [];
    for (const e of entries) {
        try {
            const consumed = Boolean(await readContract.consumedRewardEventKey(e.eventKey));
            if (consumed)
                continue;
        }
        catch {
            // If the read fails, keep the entry and let the chain reject duplicates.
        }
        out.push(e);
    }
    return out;
}
const NEEDS_SPLIT_MARKER = Symbol('validatorClRewardPayout.needs_split');
async function submitPayoutBatchOnchain(contractAddr, entries, gasPriceWei) {
    if (!entries.length)
        return 'ok';
    const guardianIds = entries.map((e) => e.guardianId);
    const amounts = entries.map((e) => e.amount);
    const eventKeys = entries.map((e) => e.eventKey);
    if (payoutDryRun()) {
        (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] dry-run settleNodeRewards n=${entries.length} total=${ethers_1.ethers.formatEther(amounts.reduce((a, b) => a + b, 0n))} CNET`));
        return 'ok';
    }
    const result = await withSettleWallet('settleNodeRewards', async (sc) => {
        const c = new ethers_1.ethers.Contract(contractAddr, PAYOUT_ABI, sc.walletConet);
        const gasLimit = await resolveSubmitGasLimit(c, guardianIds, amounts, eventKeys);
        if (gasLimit == null) {
            (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] estimateGas+20% exceeds gasLimit=${resolveGasLimit()} for n=${entries.length} — will auto-split`));
            return NEEDS_SPLIT_MARKER;
        }
        // Prefer legacy gasPrice: EIP-1559 tip=0 is rejected by some CONET nodes
        // ("tip cap 0, minimum needed 1"); tip=1 wei can enter mempool but never mine
        // while eth_gasPrice stays ~2 gwei. Legacy gasPrice matches the network quote.
        const tx = await c.settleNodeRewards(guardianIds, amounts, eventKeys, {
            gasLimit,
            gasPrice: gasPriceWei,
        });
        await tx.wait();
        return tx.hash;
    });
    if (result === NEEDS_SPLIT_MARKER)
        return 'needs_split';
    if (typeof result === 'string' && result.length > 0) {
        (0, logger_1.logger)(safe_1.default.green(`[validatorClRewardPayout] settleNodeRewards ok tx=${result} n=${entries.length}`));
        return 'ok';
    }
    return 'failed';
}
async function submitPayoutBatch(contractAddr, entries, gasPriceWei) {
    if (!entries.length)
        return 'ok';
    const outcome = await (0, onchainTxSerialQueue_1.enqueueOnchainTxWork)(onchainTxSerialQueue_1.CONET_VALIDATOR_NODE_ONCHAIN_LANE, `settleNodeRewards n=${entries.length}`, async () => submitPayoutBatchOnchain(contractAddr, entries, gasPriceWei), '[validatorClRewardPayout]');
    return outcome ?? 'failed';
}
/**
 * Submit a batch; on estimate/tx failure with n>1, bisect and retry both halves.
 * Singleton hard-failures stay in pending for a later tick so the rest of the pool can drain.
 */
async function submitPayoutBatchAutoSplit(contractAddr, entries, gasPriceWei, state, pending, provider, settleAddr, intrinsicCost) {
    if (!entries.length)
        return 'continue';
    const balNow = await provider.getBalance(settleAddr);
    if (balNow < intrinsicCost) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] stop flush mid-way: balance=${ethers_1.ethers.formatEther(balNow)} < intrinsic=${ethers_1.ethers.formatEther(intrinsicCost)} (pending=${pending.size})`));
        return 'stop_balance';
    }
    const outcome = await submitPayoutBatch(contractAddr, entries, gasPriceWei);
    if (outcome === 'ok') {
        for (const e of entries)
            pending.delete(e.eventKey);
        persistPending(state, pending);
        return 'continue';
    }
    if (entries.length === 1) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] singleton settle failed (${outcome}); leave in pending and continue (eventKey=${entries[0].eventKey.slice(0, 18)}…)`));
        return 'continue';
    }
    const mid = Math.max(1, Math.floor(entries.length / 2));
    const left = entries.slice(0, mid);
    const right = entries.slice(mid);
    (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] auto-split n=${entries.length} → ${left.length}+${right.length} (reason=${outcome})`));
    const leftResult = await submitPayoutBatchAutoSplit(contractAddr, left, gasPriceWei, state, pending, provider, settleAddr, intrinsicCost);
    if (leftResult === 'stop_balance')
        return 'stop_balance';
    return submitPayoutBatchAutoSplit(contractAddr, right, gasPriceWei, state, pending, provider, settleAddr, intrinsicCost);
}
/**
 * Scan [fromBlock, toBlock] into the pending pool. Advances through contiguous
 * successfully-fetched blocks; stops (without advancing past) the first fetch failure.
 * Does not submit on-chain — flushPendingBatches does that.
 */
async function scanBlocksIntoPending(provider, readContract, proxyAddr, fromBlock, toBlock, pending) {
    const proxyLower = proxyAddr.toLowerCase();
    let okThrough = null;
    let added = 0;
    for (let bn = fromBlock; bn <= toBlock; bn++) {
        const block = await fetchBlockWithWithdrawals(provider, bn);
        if (!block) {
            return { okThrough, added, fetchFailed: true };
        }
        const entries = await collectPayoutEntriesForBlock(readContract, proxyLower, bn, block);
        added += mergeIntoPending(pending, entries);
        okThrough = bn;
    }
    return { okThrough, added, fetchFailed: false };
}
async function flushPendingBatches(provider, readContract, contractAddr, state, pending) {
    if (!pending.size) {
        if (clearGasWait(state))
            persistPending(state, pending);
        return;
    }
    const maxGas = resolveMaxGasPriceWei();
    // CONET often reports eth_gasPrice as 2.000000007 gwei — allow tiny dust above configured max.
    const gasDustWei = 50000000n; // 0.05 gwei
    const gasPrice = await readGasPriceWei(provider);
    const forceMs = resolveGasWaitForceMs();
    let forceFlush = false;
    if (gasPrice > maxGas + gasDustWei) {
        const now = Date.now();
        if (!state.gasWaitStartedAt) {
            state.gasWaitStartedAt = new Date(now).toISOString();
            persistPending(state, pending);
        }
        const startedMs = Date.parse(state.gasWaitStartedAt);
        const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : forceMs;
        if (elapsedMs < forceMs) {
            (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] skip flush: gasPrice=${ethers_1.ethers.formatUnits(gasPrice, 'gwei')} gwei > max=${ethers_1.ethers.formatUnits(maxGas, 'gwei')} gwei ` +
                `wait ${formatWaitCountdown(elapsedMs, forceMs)} pending=${pending.size}`));
            return;
        }
        forceFlush = true;
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] force flush: gas wait ${Math.floor(elapsedMs / 1000)}s ≥ ${Math.floor(forceMs / 1000)}s; ` +
            `ignoring max=${ethers_1.ethers.formatUnits(maxGas, 'gwei')} gwei, using live gasPrice=${ethers_1.ethers.formatUnits(gasPrice, 'gwei')} gwei (pending=${pending.size})`));
    }
    else if (clearGasWait(state)) {
        persistPending(state, pending);
    }
    const gasLimit = BigInt(resolveGasLimit());
    const intrinsicCost = gasLimit * gasPrice;
    const settleAddr = peekSettleWalletAddress();
    if (!settleAddr) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] skip flush: no settle wallet in pool (pending=${pending.size})`));
        return;
    }
    const balance = await provider.getBalance(settleAddr);
    if (balance < intrinsicCost) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] skip flush: settle ${settleAddr} balance=${ethers_1.ethers.formatEther(balance)} < intrinsic=${ethers_1.ethers.formatEther(intrinsicCost)} CNET (gasLimit=${gasLimit}×${ethers_1.ethers.formatUnits(gasPrice, 'gwei')}gwei, pending=${pending.size})`));
        return;
    }
    const ordered = [...pending.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex);
    const live = await filterUnconsumed(readContract, ordered);
    if (live.length !== ordered.length) {
        const liveKeys = new Set(live.map((e) => e.eventKey));
        for (const e of ordered) {
            if (!liveKeys.has(e.eventKey))
                pending.delete(e.eventKey);
        }
        persistPending(state, pending);
        (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] dropped ${ordered.length - live.length} already-consumed eventKeys; pending=${pending.size}`));
    }
    if (!live.length) {
        if (clearGasWait(state))
            persistPending(state, pending);
        return;
    }
    const batches = splitEntriesForOnchain(live);
    (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] flush pending=${live.length} → ${batches.length} batch(es) ` +
        `(maxEntries=${resolveMaxEntriesPerTx()} estGas/entry=${resolveGasPerEntry()} gasLimit=${resolveGasLimit()} ` +
        `gasPrice=${ethers_1.ethers.formatUnits(gasPrice, 'gwei')}gwei${forceFlush ? ' force=1' : ''})`));
    for (const batch of batches) {
        // Heuristic pre-split is a first cut; real estimateGas may still exceed gasLimit.
        // Always go through auto-split so oversized / reverted batches bisect instead of stalling.
        const result = await submitPayoutBatchAutoSplit(contractAddr, batch, gasPrice, state, pending, provider, settleAddr, intrinsicCost);
        if (result === 'stop_balance') {
            persistPending(state, pending);
            return;
        }
    }
    if (!pending.size && clearGasWait(state))
        persistPending(state, pending);
}
async function payoutTick() {
    if (payoutInFlight)
        return;
    payoutInFlight = true;
    try {
        const proxyAddr = (0, validatorDepositRedeem_1.resolveValidatorDepositRedeemAddress)();
        if (!proxyAddr) {
            (0, logger_1.logger)(safe_1.default.yellow('[validatorClRewardPayout] CONET_VALIDATOR_DEPOSIT_REDEEM not configured — skip'));
            return;
        }
        const provider = new ethers_1.ethers.JsonRpcProvider(process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
            util_1.masterSetup.validatorDeposit?.rpcUrl ||
            (0, util_1.resolveBeamioConetHttpRpcUrl)());
        const readContract = new ethers_1.ethers.Contract(proxyAddr, PAYOUT_ABI, provider);
        const floor = resolveDeployBlockFloor();
        const state = readState();
        const pending = loadPendingMap(state);
        const liveHead = Number(await provider.getBlockNumber());
        if (!Number.isFinite(liveHead) || liveHead < floor)
            return;
        // New scan session: snapshot live head once as ceiling. Restart mid-catch-up keeps the prior ceiling.
        if (isScanCatchUpComplete(state)) {
            if (state.scanTargetBlock !== liveHead) {
                state.scanTargetBlock = liveHead;
                persistPending(state, pending);
                (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] new scan session scanTargetBlock=${liveHead} (lastProcessed=${state.lastProcessedBlock} pending=${pending.size})`));
            }
        }
        else {
            (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] catch-up toward scanTargetBlock=${state.scanTargetBlock} (lastProcessed=${state.lastProcessedBlock}, liveHead=${liveHead}, pending=${pending.size})`));
        }
        const scanTargetBlock = state.scanTargetBlock ?? liveHead;
        let from = Math.max(floor, state.lastProcessedBlock + 1);
        if (from <= scanTargetBlock) {
            const chunk = resolveChunkBlocks();
            const chunksPerTick = resolveChunksPerTick();
            const maxBlocksThisTick = chunk * chunksPerTick;
            const tickEnd = Math.min(from + maxBlocksThisTick - 1, scanTargetBlock);
            (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] scan blocks ${from}..${tickEnd} (target=${scanTargetBlock}, liveHead=${liveHead}, floor=${floor}, proxy=${proxyAddr.slice(0, 10)}…)`));
            while (from <= tickEnd) {
                const to = Math.min(from + chunk - 1, tickEnd);
                const { okThrough, added, fetchFailed } = await scanBlocksIntoPending(provider, readContract, proxyAddr, from, to, pending);
                if (okThrough != null) {
                    state.lastProcessedBlock = okThrough;
                    persistPending(state, pending);
                    if (added > 0) {
                        (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] queued +${added} into pending (pending=${pending.size}) through ${from}..${okThrough}`));
                    }
                }
                if (fetchFailed || okThrough == null || okThrough < to) {
                    (0, logger_1.logger)(safe_1.default.yellow(`[validatorClRewardPayout] scan stop at ${okThrough ?? from - 1} (fetch failed); will retry next tick`));
                    break;
                }
                from = to + 1;
            }
        }
        await flushPendingBatches(provider, readContract, proxyAddr, state, pending);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.red(`[validatorClRewardPayout] tick error: ${e?.message ?? e}`));
    }
    finally {
        payoutInFlight = false;
    }
}
function scheduleNextPayoutTick() {
    if (!payoutStarted)
        return;
    payoutTimer = setTimeout(async () => {
        await payoutTick();
        scheduleNextPayoutTick();
    }, resolveTickMs());
}
function startValidatorClRewardPayoutReporter() {
    if (payoutStarted)
        return;
    if (!payoutEnabled()) {
        (0, logger_1.logger)(safe_1.default.yellow('[validatorClRewardPayout] disabled (set CONET_VALIDATOR_CL_REWARD_PAYOUT=1)'));
        return;
    }
    payoutStarted = true;
    const proxy = (0, validatorDepositRedeem_1.resolveValidatorDepositRedeemAddress)() || chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM;
    (0, logger_1.logger)(safe_1.default.cyan(`[validatorClRewardPayout] starting proxy=${proxy || 'unset'} floor=${resolveDeployBlockFloor()} tick=${resolveTickMs()}ms ` +
        `maxEntries=${resolveMaxEntriesPerTx()} maxGasGwei=${ethers_1.ethers.formatUnits(resolveMaxGasPriceWei(), 'gwei')} ` +
        `gasWaitForceMs=${resolveGasWaitForceMs()} pendingPool=on`));
    void payoutTick().finally(() => scheduleNextPayoutTick());
}
function stopValidatorClRewardPayoutReporter() {
    payoutStarted = false;
    if (payoutTimer !== undefined) {
        clearTimeout(payoutTimer);
        payoutTimer = undefined;
    }
}
