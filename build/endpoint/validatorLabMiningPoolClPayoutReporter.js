"use strict";
/**
 * CL consensus-layer skim → ConetLabMiningPool for manual Lab staking validators (no guardian ledger).
 *
 * Scans EL block withdrawals credited to ValidatorDepositRedeem, maps validatorIndex → pubkey,
 * pays only when:
 *   - pubkey is in Lab manifest (deployments/conet-lab-mining-pool-pubkeys.json)
 *   - beacon status is active_ongoing only (active_exiting / withdrawn → no skim)
 *   - single withdrawal amount below exit floor (default 1 CNET; CL skim ≪ 1 CNET, exit principal ~32 CNET)
 *   - no active redeem beneficiary (guardianId==0 OR guardianIdBeneficiary==0 after adminRelease)
 *     OR pubkey not in manifest with active beneficiary (redeem stack on 85.33 handles those)
 *   - on-chain consumedRewardEventKey is false (guardian settleNodeRewards already paid)
 *
 * Payout: Redeem.withdrawNative(miningPool, batchTotal) via contract admin (onlyAdmin).
 * Idempotency: off-chain state consumedEventKeys + principal ceiling before each tx.
 *
 * Pending pool + gas gate (aligned with validatorClRewardPayoutReporter):
 *   - Scanned skim entries merge into a persisted pending pool; scan checkpoint advances without settle.
 *   - Flush when eth_gasPrice ≤ max (default 2 gwei); failed batches stay in pending.
 *   - If gas stays above max longer than force-wait (default 3 min), flush at live gasPrice anyway.
 *
 * Scan (parallel every tick / every process start):
 *   • listening — always scan current liveHead; when backfill has reached liveHead-1, persist lastListeningEndBlock=liveHead
 *   • backfill   — [sessionBackfillFloor .. liveHead-1] where sessionBackfillFloor = lastListeningEndBlock+1 | pool deploy block
 *
 * Next restart: backfill lower bound = persisted lastListeningEndBlock+1; upper bound = new liveHead-1 (dynamic).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startValidatorLabMiningPoolClPayoutReporter = startValidatorLabMiningPoolClPayoutReporter;
exports.stopValidatorLabMiningPoolClPayoutReporter = stopValidatorLabMiningPoolClPayoutReporter;
exports.flushLabMiningPoolListeningCheckpoint = flushLabMiningPoolListeningCheckpoint;
exports.waitForLabMiningPoolClPayoutIdle = waitForLabMiningPoolClPayoutIdle;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const chainAddresses_1 = require("../chainAddresses");
const onchainTxSerialQueue_1 = require("../onchainTxSerialQueue");
function resolveLabRpcUrl() {
    return (process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL?.trim() ||
        process.env.CONET_RPC_URL?.trim() ||
        chainAddresses_1.CONET_RPC_URL);
}
function resolveLabRedeemAddress() {
    const raw = process.env.CONET_VALIDATOR_DEPOSIT_REDEEM?.trim() || chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM;
    try {
        const a = ethers_1.ethers.getAddress(raw);
        if (a === ethers_1.ethers.ZeroAddress)
            return chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM;
        return a;
    }
    catch {
        return chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM;
    }
}
const VALIDATOR_STAKE_WEI = 32n * 10n ** 18n;
/** Per-withdrawal skim ceiling: CL rewards are ≪ 1 CNET; anything ≥ floor is principal/exit, not skim. */
const DEFAULT_SKIM_MAX_WITHDRAWAL_WEI = 10n ** 18n;
const LAB_SKIM_ELIGIBLE_STATUS = 'active_ongoing';
const READ_ABI = [
    'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
    'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
    'function consumedRewardEventKey(bytes32 key) view returns (bool)',
    'function totalStakedValidatorCount() view returns (uint256)',
];
const WRITE_ABI = [
    'function withdrawNative(address to, uint256 amount) external',
    'function admins(address) view returns (bool)',
];
let labStarted = false;
let labTimer;
let labInFlight = false;
let labPubkeySet = new Set();
let labMiningPool = '';
let labManifestMtime = 0;
let labPhaseLogged = false;
let labSessionState;
/** Frozen at process start: max(lastListeningEndBlock+1, pool deploy block). */
let sessionBackfillFloor;
function resolveManifestPath() {
    return (process.env.CONET_LAB_MINING_POOL_PUBKEYS_FILE?.trim() ||
        node_path_1.default.join(process.cwd(), 'deployments/conet-lab-mining-pool-pubkeys.json'));
}
function resolveStateFile() {
    return (process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-lab-mining-pool-cl-payout-state.json'));
}
function resolveBeaconRestUrl() {
    return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '');
}
function resolveTickMs() {
    const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_TICK_MS || 60_000);
    return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000;
}
function resolveChunkBlocks() {
    const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNK_BLOCKS || 32);
    return Number.isFinite(n) && n >= 1 ? Math.min(512, Math.floor(n)) : 32;
}
function resolveChunksPerTick() {
    const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_CHUNKS_PER_TICK || 1);
    return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 1;
}
/**
 * Only submit when eth_gasPrice ≤ this many gwei (default 2).
 * CONET often sits at exactly 2.0 gwei — use ≤ not <.
 */
function resolveMaxGasPriceWei() {
    const gwei = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI || 2);
    const safe = Number.isFinite(gwei) && gwei > 0 ? gwei : 2;
    return ethers_1.ethers.parseUnits(String(safe), 'gwei');
}
/** After this many ms waiting on high gas, force flush at live gasPrice (default 3 min). */
function resolveGasWaitForceMs() {
    const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS || 180_000);
    return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 180_000;
}
function resolveWithdrawGasLimit() {
    const n = Number(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT || 800_000);
    return Number.isFinite(n) && n >= 100_000 ? Math.min(8_000_000, Math.floor(n)) : 800_000;
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
function skimEntryToJson(e) {
    return {
        eventKey: e.eventKey.toLowerCase(),
        amount: e.amount.toString(),
        blockNumber: e.blockNumber,
        withdrawalIndex: e.withdrawalIndex,
        pubkey: e.pubkey.toLowerCase(),
    };
}
function skimEntryFromJson(raw) {
    try {
        const eventKey = String(raw.eventKey || '').toLowerCase();
        if (!eventKey || eventKey === ethers_1.ethers.ZeroHash)
            return null;
        const amount = BigInt(raw.amount);
        if (amount <= 0n)
            return null;
        const blockNumber = Number(raw.blockNumber);
        const withdrawalIndex = Number(raw.withdrawalIndex);
        const pubkey = String(raw.pubkey || '').toLowerCase();
        if (!Number.isFinite(blockNumber) || !Number.isFinite(withdrawalIndex) || !pubkey)
            return null;
        return { eventKey, amount, blockNumber, withdrawalIndex, pubkey };
    }
    catch {
        return null;
    }
}
function loadPendingMap(state) {
    const map = new Map();
    for (const raw of state.pending ?? []) {
        const e = skimEntryFromJson(raw);
        if (!e)
            continue;
        map.set(e.eventKey, e);
    }
    return map;
}
function persistPending(state, pending) {
    state.pending = [...pending.values()]
        .sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex)
        .map(skimEntryToJson);
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
function resolveFullExitFloorWei() {
    const raw = process.env.CONET_LAB_MINING_POOL_CL_FULL_EXIT_FLOOR_WEI?.trim();
    if (raw) {
        try {
            return BigInt(raw);
        }
        catch {
            /* fall through */
        }
    }
    return DEFAULT_SKIM_MAX_WITHDRAWAL_WEI;
}
function markLabValidatorExited(state, pubkey) {
    state.exitedPubkeys[pubkey.toLowerCase()] = true;
}
/** True when EL withdrawal is too large to be CL skim (treat as exit/principal inflow). */
function isNonSkimWithdrawal(amountWei, floorWei) {
    return amountWei >= floorWei;
}
function resolveLabScanFloorBlock() {
    const env = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK?.trim() ||
        process.env.CONET_LAB_MINING_POOL_DEPLOY_BLOCK?.trim();
    if (env) {
        const n = Number(env);
        if (Number.isFinite(n) && n >= 0)
            return Math.floor(n);
    }
    return chainAddresses_1.CONET_LAB_MINING_POOL_DEPLOY_BLOCK;
}
function resolveBackfillUpperBound(liveHead) {
    return Math.max(0, liveHead - 1);
}
function normalizeScanBlock(raw) {
    if (raw == null)
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
/** Inclusive first block for backfill on this process start. */
function resolveSessionBackfillFloor(state) {
    const lastListen = normalizeScanBlock(state.lastListeningEndBlock);
    if (lastListen != null)
        return lastListen + 1;
    return resolveLabScanFloorBlock();
}
function migrateLegacyStateFields(state) {
    if (state.lastBackfillProcessedBlock == null) {
        const legacy = normalizeScanBlock(state.lastProcessedBlock);
        state.lastBackfillProcessedBlock =
            legacy != null ? legacy : resolveSessionBackfillFloor(state) - 1;
    }
    delete state.lastProcessedBlock;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete state.phase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete state.scanTargetBlock;
}
function alignBackfillCursorForSession(state, floor) {
    if (state.lastBackfillProcessedBlock < floor - 1) {
        state.lastBackfillProcessedBlock = floor - 1;
    }
}
function tryPersistListeningCheckpoint(state, liveHead) {
    const upper = resolveBackfillUpperBound(liveHead);
    if (state.lastBackfillProcessedBlock < upper)
        return;
    if (state.lastLiveHeadScanned !== liveHead)
        return;
    const prev = state.lastListeningEndBlock;
    state.lastListeningEndBlock = liveHead;
    if (prev !== liveHead) {
        (0, logger_1.logger)(safe_1.default.green(`[labMiningPoolClPayout] listening checkpoint lastListeningEndBlock=${liveHead} (backfill≥${upper})`));
    }
}
function labEnabled() {
    return ['1', 'true', 'yes'].includes(String(process.env.CONET_LAB_MINING_POOL_CL_PAYOUT || '').toLowerCase());
}
function labDryRun() {
    const v = (process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
function readStateFromDisk() {
    const file = resolveStateFile();
    const floor = resolveLabScanFloorBlock();
    const empty = {
        lastBackfillProcessedBlock: floor - 1,
        consumedEventKeys: {},
        exitedPubkeys: {},
        updatedAt: new Date().toISOString(),
    };
    try {
        if (!node_fs_1.default.existsSync(file))
            return empty;
        const raw = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
        const state = {
            lastBackfillProcessedBlock: normalizeScanBlock(raw.lastBackfillProcessedBlock) ??
                normalizeScanBlock(raw.lastProcessedBlock) ??
                floor - 1,
            lastProcessedBlock: normalizeScanBlock(raw.lastProcessedBlock),
            lastListeningEndBlock: normalizeScanBlock(raw.lastListeningEndBlock),
            lastLiveHeadScanned: normalizeScanBlock(raw.lastLiveHeadScanned),
            pending: Array.isArray(raw.pending) ? raw.pending : [],
            gasWaitStartedAt: typeof raw.gasWaitStartedAt === 'string' && raw.gasWaitStartedAt.trim()
                ? raw.gasWaitStartedAt.trim()
                : undefined,
            consumedEventKeys: raw.consumedEventKeys && typeof raw.consumedEventKeys === 'object' ? raw.consumedEventKeys : {},
            exitedPubkeys: raw.exitedPubkeys && typeof raw.exitedPubkeys === 'object' ? raw.exitedPubkeys : {},
            updatedAt: raw.updatedAt ?? new Date().toISOString(),
        };
        migrateLegacyStateFields(state);
        return state;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] state reset: ${e?.message ?? e}`));
        return empty;
    }
}
/** Process boot: parallel listen+backfill; resume backfill cursor; freeze session floor from lastListeningEndBlock. */
function initLabSessionState() {
    const state = readStateFromDisk();
    sessionBackfillFloor = resolveSessionBackfillFloor(state);
    alignBackfillCursorForSession(state, sessionBackfillFloor);
    writeState(state);
    return state;
}
function getLabSessionState() {
    if (!labSessionState)
        labSessionState = initLabSessionState();
    return labSessionState;
}
function writeState(state) {
    const file = resolveStateFile();
    state.updatedAt = new Date().toISOString();
    if (!Array.isArray(state.pending))
        state.pending = [];
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
function loadManifestIfNeeded(force = false) {
    const file = resolveManifestPath();
    if (!node_fs_1.default.existsSync(file)) {
        (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] manifest missing: ${file} (run aggregateLabMiningPoolPubkeys.mjs)`));
        return false;
    }
    const st = node_fs_1.default.statSync(file);
    if (!force && st.mtimeMs === labManifestMtime && labPubkeySet.size > 0)
        return true;
    const raw = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
    const pubkeys = Array.isArray(raw.pubkeys) ? raw.pubkeys : [];
    if (!pubkeys.length) {
        (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] manifest has no pubkeys: ${file}`));
        return false;
    }
    labPubkeySet = new Set(pubkeys.map((p) => ethers_1.ethers.hexlify(ethers_1.ethers.getBytes(p.startsWith('0x') ? p : `0x${p}`)).toLowerCase()));
    labMiningPool =
        raw.miningPool?.trim() ||
            process.env.CONET_LAB_MINING_POOL_ADDRESS?.trim() ||
            '0x32bE583C8e778FFfC5107BF34820c2B225336201';
    labManifestMtime = st.mtimeMs;
    (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] loaded manifest pubkeys=${labPubkeySet.size} pool=${labMiningPool.slice(0, 10)}…`));
    return true;
}
const validatorPubkeyCache = new Map();
const validatorStatusCache = new Map();
async function fetchValidatorByIndex(validatorIndex) {
    if (validatorPubkeyCache.has(validatorIndex)) {
        return {
            pubkey: validatorPubkeyCache.get(validatorIndex) ?? null,
            status: validatorStatusCache.get(validatorIndex) ?? null,
        };
    }
    const base = resolveBeaconRestUrl();
    const url = `${base}/eth/v1/beacon/states/head/validators/${validatorIndex}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
        if (!res.ok) {
            validatorPubkeyCache.set(validatorIndex, null);
            validatorStatusCache.set(validatorIndex, null);
            return { pubkey: null, status: null };
        }
        const json = (await res.json());
        const pkRaw = json?.data?.validator?.pubkey?.trim();
        const status = json?.data?.status?.trim()?.toLowerCase() || null;
        let pubkey = null;
        if (pkRaw) {
            pubkey = ethers_1.ethers.hexlify(ethers_1.ethers.getBytes(pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`)).toLowerCase();
        }
        validatorPubkeyCache.set(validatorIndex, pubkey);
        validatorStatusCache.set(validatorIndex, status);
        return { pubkey, status };
    }
    catch {
        return { pubkey: null, status: null };
    }
}
async function fetchBlockWithWithdrawals(provider, blockNumber) {
    try {
        const hex = ethers_1.ethers.toQuantity(blockNumber);
        return (await provider.send('eth_getBlockByNumber', [hex, false]));
    }
    catch {
        return null;
    }
}
function withdrawalEventKey(blockNumber, withdrawalIndex) {
    return ethers_1.ethers.keccak256(ethers_1.ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [BigInt(blockNumber), BigInt(withdrawalIndex)]));
}
function resolveAdminPrivateKey() {
    const file = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_ADMIN_PRIVATE_KEY_FILE?.trim();
    if (file && node_fs_1.default.existsSync(file)) {
        const pk = node_fs_1.default.readFileSync(file, 'utf8').trim();
        return pk.startsWith('0x') ? pk : `0x${pk}`;
    }
    const inline = process.env.CONET_LAB_MINING_POOL_CL_PAYOUT_ADMIN_PRIVATE_KEY?.trim();
    if (inline)
        return inline.startsWith('0x') ? inline : `0x${inline}`;
    const masterPath = node_path_1.default.join((0, node_os_1.homedir)(), '.master.json');
    if (!node_fs_1.default.existsSync(masterPath))
        return undefined;
    try {
        const m = JSON.parse(node_fs_1.default.readFileSync(masterPath, 'utf8'));
        const pools = [
            ...(Array.isArray(m.settle_contractAdmin) ? m.settle_contractAdmin : []),
            ...(Array.isArray(m.beamio_Admins) ? m.beamio_Admins : []),
            ...(Array.isArray(m.admin) ? m.admin : []),
        ];
        for (const k of pools) {
            if (typeof k === 'string' && k.length > 0) {
                return k.startsWith('0x') ? k : `0x${k}`;
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
async function resolveMaxSkimPayoutWei(provider, redeemAddr, state) {
    const redeem = new ethers_1.ethers.Contract(redeemAddr, READ_ABI, provider);
    const stakedCount = BigInt(String(await redeem.totalStakedValidatorCount()));
    const onChainReserve = VALIDATOR_STAKE_WEI * stakedCount;
    const balance = await provider.getBalance(redeemAddr);
    const exitedCount = Object.keys(state.exitedPubkeys).length;
    const labActive = Math.max(0, labPubkeySet.size - exitedCount);
    const localReserve = VALIDATOR_STAKE_WEI * BigInt(labActive);
    const effectiveReserve = onChainReserve > localReserve ? onChainReserve : localReserve;
    if (balance <= effectiveReserve)
        return 0n;
    return balance - effectiveReserve;
}
async function collectLabSkimEntriesForBlock(readContract, proxyLower, blockNumber, block, state) {
    const floorWei = resolveFullExitFloorWei();
    const entries = [];
    for (const w of block.withdrawals ?? []) {
        const addr = String(w.address ?? '').toLowerCase();
        if (addr !== proxyLower)
            continue;
        const amountGwei = BigInt(String(w.amount ?? '0'));
        if (amountGwei <= 0n)
            continue;
        const amountWei = amountGwei * 1000000000n;
        const validatorIndex = Number(w.validatorIndex);
        const withdrawalIndex = Number(w.index);
        if (!Number.isFinite(validatorIndex) || validatorIndex < 0)
            continue;
        if (!Number.isFinite(withdrawalIndex) || withdrawalIndex < 0)
            continue;
        const eventKey = withdrawalEventKey(blockNumber, withdrawalIndex);
        if (state.consumedEventKeys[eventKey])
            continue;
        if ((state.pending ?? []).some((p) => String(p.eventKey || '').toLowerCase() === eventKey.toLowerCase())) {
            continue;
        }
        try {
            const consumedOnChain = await readContract.consumedRewardEventKey(eventKey);
            if (consumedOnChain) {
                state.consumedEventKeys[eventKey] = true;
                continue;
            }
        }
        catch {
            continue;
        }
        const { pubkey, status } = await fetchValidatorByIndex(validatorIndex);
        if (!pubkey || !labPubkeySet.has(pubkey))
            continue;
        if (isNonSkimWithdrawal(amountWei, floorWei)) {
            markLabValidatorExited(state, pubkey);
            state.consumedEventKeys[eventKey] = true;
            (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] non-skim inflow (≥exit floor) block=${blockNumber} validator=${pubkey.slice(0, 14)}… amount=${ethers_1.ethers.formatEther(amountWei)} CNET status=${status ?? '?'}`));
            continue;
        }
        if (status !== LAB_SKIM_ELIGIBLE_STATUS) {
            markLabValidatorExited(state, pubkey);
            (0, logger_1.logger)(safe_1.default.gray(`[labMiningPoolClPayout] skip non-active validator block=${blockNumber} status=${status ?? '?'} pubkey=${pubkey.slice(0, 14)}…`));
            continue;
        }
        try {
            const pkHash = ethers_1.ethers.keccak256(pubkey);
            const guardianId = BigInt(await readContract.getNodeByValidatorPubkeyHash(pkHash));
            if (guardianId > 0n) {
                const beneficiary = String(await readContract.guardianIdBeneficiary(guardianId));
                // Active redeem guardian (beneficiary set) → validatorClRewardPayoutReporter on redeem listener host.
                if (beneficiary !== ethers_1.ethers.ZeroAddress)
                    continue;
            }
        }
        catch {
            continue;
        }
        entries.push({ eventKey, amount: amountWei, blockNumber, withdrawalIndex, pubkey });
    }
    return entries;
}
async function submitLabSkimBatch(provider, redeemAddr, entries, state, gasPriceWei) {
    if (!entries.length)
        return true;
    const total = entries.reduce((a, e) => a + e.amount, 0n);
    if (total <= 0n)
        return true;
    const maxPayout = await resolveMaxSkimPayoutWei(provider, redeemAddr, state);
    if (total > maxPayout) {
        (0, logger_1.logger)(safe_1.default.red(`[labMiningPoolClPayout] refuse batch total=${ethers_1.ethers.formatEther(total)} > maxSkim=${ethers_1.ethers.formatEther(maxPayout)}`));
        return false;
    }
    if (labDryRun()) {
        (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] dry-run withdrawNative(${labMiningPool}, ${ethers_1.ethers.formatEther(total)} CNET) n=${entries.length}`));
        for (const e of entries)
            state.consumedEventKeys[e.eventKey] = true;
        return true;
    }
    const pk = resolveAdminPrivateKey();
    if (!pk) {
        (0, logger_1.logger)(safe_1.default.red('[labMiningPoolClPayout] missing contract admin key'));
        return false;
    }
    const admin = new ethers_1.ethers.Wallet(pk, provider);
    const redeemWrite = new ethers_1.ethers.Contract(redeemAddr, WRITE_ABI, admin);
    if (!(await redeemWrite.admins(admin.address))) {
        (0, logger_1.logger)(safe_1.default.red(`[labMiningPoolClPayout] signer ${admin.address} is not Redeem contract admin`));
        return false;
    }
    const gasLimit = resolveWithdrawGasLimit();
    const intrinsicCost = BigInt(gasLimit) * gasPriceWei;
    const bal = await provider.getBalance(admin.address);
    if (bal < intrinsicCost) {
        (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] skip flush: admin ${admin.address} balance=${ethers_1.ethers.formatEther(bal)} < intrinsic=${ethers_1.ethers.formatEther(intrinsicCost)} CNET`));
        return false;
    }
    const lane = (0, onchainTxSerialQueue_1.onchainTxLaneForSigner)(admin.address);
    try {
        await (0, onchainTxSerialQueue_1.enqueueOnchainTxWork)(lane, `labClSkim→pool n=${entries.length}`, async () => {
            // Legacy gasPrice: EIP-1559 tip=0 rejected on some CONET nodes; tip=1 can stall in mempool.
            const tx = await redeemWrite.withdrawNative(labMiningPool, total, {
                gasLimit,
                gasPrice: gasPriceWei,
            });
            await tx.wait();
            (0, logger_1.logger)(safe_1.default.green(`[labMiningPoolClPayout] withdrawNative ok tx=${tx.hash} total=${ethers_1.ethers.formatEther(total)} CNET n=${entries.length}`));
            for (const e of entries)
                state.consumedEventKeys[e.eventKey] = true;
        }, '[labMiningPoolClPayout]');
        return true;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.red(`[labMiningPoolClPayout] withdrawNative failed: ${e?.message ?? e}`));
        return false;
    }
}
async function flushPendingLabBatches(provider, readContract, redeemAddr, state, pending) {
    if (!pending.size) {
        if (clearGasWait(state))
            persistPending(state, pending);
        return;
    }
    const maxGas = resolveMaxGasPriceWei();
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
            (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] skip flush: gasPrice=${ethers_1.ethers.formatUnits(gasPrice, 'gwei')} gwei > max=${ethers_1.ethers.formatUnits(maxGas, 'gwei')} gwei ` +
                `wait ${formatWaitCountdown(elapsedMs, forceMs)} pending=${pending.size}`));
            return;
        }
        forceFlush = true;
        (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] force flush: gas wait ${Math.floor(elapsedMs / 1000)}s ≥ ${Math.floor(forceMs / 1000)}s; ` +
            `ignoring max=${ethers_1.ethers.formatUnits(maxGas, 'gwei')} gwei, using live gasPrice=${ethers_1.ethers.formatUnits(gasPrice, 'gwei')} gwei (pending=${pending.size})`));
    }
    else if (clearGasWait(state)) {
        persistPending(state, pending);
    }
    const ordered = [...pending.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.withdrawalIndex - b.withdrawalIndex);
    const live = [];
    for (const e of ordered) {
        try {
            const consumed = Boolean(await readContract.consumedRewardEventKey(e.eventKey));
            if (consumed) {
                state.consumedEventKeys[e.eventKey] = true;
                pending.delete(e.eventKey);
                continue;
            }
        }
        catch {
            /* keep entry */
        }
        live.push(e);
    }
    if (live.length !== ordered.length) {
        persistPending(state, pending);
        (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] dropped ${ordered.length - live.length} already-consumed eventKeys; pending=${pending.size}`));
    }
    if (!live.length) {
        if (clearGasWait(state))
            persistPending(state, pending);
        return;
    }
    const maxPayout = await resolveMaxSkimPayoutWei(provider, redeemAddr, state);
    if (maxPayout <= 0n) {
        (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] skip flush: maxSkim=0 (principal reserve) pending=${pending.size}`));
        return;
    }
    // Pack prefix batches that fit under maxSkim (one withdrawNative per batch).
    const batches = [];
    let cur = [];
    let curTotal = 0n;
    for (const e of live) {
        if (e.amount > maxPayout) {
            (0, logger_1.logger)(safe_1.default.red(`[labMiningPoolClPayout] entry ${e.eventKey.slice(0, 14)}… amount=${ethers_1.ethers.formatEther(e.amount)} > maxSkim; leaving in pending`));
            continue;
        }
        if (cur.length && curTotal + e.amount > maxPayout) {
            batches.push(cur);
            cur = [];
            curTotal = 0n;
        }
        cur.push(e);
        curTotal += e.amount;
    }
    if (cur.length)
        batches.push(cur);
    if (!batches.length)
        return;
    (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] flush pending=${live.length} → ${batches.length} batch(es) ` +
        `gasPrice=${ethers_1.ethers.formatUnits(gasPrice, 'gwei')}gwei${forceFlush ? ' force=1' : ''}`));
    for (const batch of batches) {
        const ok = await submitLabSkimBatch(provider, redeemAddr, batch, state, gasPrice);
        if (!ok) {
            (0, logger_1.logger)(safe_1.default.yellow(`[labMiningPoolClPayout] batch failed n=${batch.length}; remaining stay in pending pool (pending=${pending.size})`));
            persistPending(state, pending);
            return;
        }
        for (const e of batch)
            pending.delete(e.eventKey);
        persistPending(state, pending);
    }
    if (!pending.size && clearGasWait(state))
        persistPending(state, pending);
}
async function processBlockRange(provider, readContract, redeemAddr, fromBlock, toBlock, state, pending) {
    const proxyLower = redeemAddr.toLowerCase();
    let okThrough = null;
    let added = 0;
    for (let bn = fromBlock; bn <= toBlock; bn++) {
        const block = await fetchBlockWithWithdrawals(provider, bn);
        if (!block) {
            return { okThrough, added, fetchFailed: true };
        }
        // Keep pending mirror on state so collectLabSkimEntriesForBlock can dedupe.
        state.pending = [...pending.values()].map(skimEntryToJson);
        const entries = await collectLabSkimEntriesForBlock(readContract, proxyLower, bn, block, state);
        added += mergeIntoPending(pending, entries);
        okThrough = bn;
    }
    return { okThrough, added, fetchFailed: false };
}
function logSessionStartIfNeeded(state, liveHead) {
    if (labPhaseLogged)
        return;
    labPhaseLogged = true;
    const floor = sessionBackfillFloor ?? resolveSessionBackfillFloor(state);
    (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] parallel listen+backfill floor=${floor} backfill→${resolveBackfillUpperBound(liveHead)} (liveHead-1) listenHead=${liveHead} lastListen=${state.lastListeningEndBlock ?? 'none'} backfillCursor=${state.lastBackfillProcessedBlock}`));
}
async function labPayoutTick() {
    if (labInFlight)
        return;
    labInFlight = true;
    try {
        if (!loadManifestIfNeeded())
            return;
        const redeemAddr = resolveLabRedeemAddress();
        const provider = new ethers_1.ethers.JsonRpcProvider(resolveLabRpcUrl());
        const readContract = new ethers_1.ethers.Contract(redeemAddr, READ_ABI, provider);
        const state = getLabSessionState();
        const pending = loadPendingMap(state);
        const liveHead = Number(await provider.getBlockNumber());
        const floor = resolveLabScanFloorBlock();
        if (!Number.isFinite(liveHead) || liveHead < floor)
            return;
        const backfillFloor = sessionBackfillFloor ?? resolveSessionBackfillFloor(state);
        const backfillUpper = resolveBackfillUpperBound(liveHead);
        logSessionStartIfNeeded(state, liveHead);
        // 1) Listening — always scan current chain head (does not wait for backfill).
        if (state.lastLiveHeadScanned !== liveHead) {
            const { okThrough, added, fetchFailed } = await processBlockRange(provider, readContract, redeemAddr, liveHead, liveHead, state, pending);
            if (!fetchFailed && okThrough === liveHead) {
                state.lastLiveHeadScanned = liveHead;
                if (added > 0) {
                    (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] listening queued +${added} (pending=${pending.size}) liveHead=${liveHead}`));
                }
                else {
                    (0, logger_1.logger)(safe_1.default.gray(`[labMiningPoolClPayout] listening liveHead=${liveHead}`));
                }
                persistPending(state, pending);
            }
        }
        // 2) Backfill — [sessionBackfillFloor .. liveHead-1] in chunks (parallel with listening).
        let backfillFrom = state.lastBackfillProcessedBlock + 1;
        if (backfillFrom < backfillFloor)
            backfillFrom = backfillFloor;
        if (backfillFrom <= backfillUpper) {
            const chunk = resolveChunkBlocks();
            const chunksPerTick = resolveChunksPerTick();
            const tickEnd = Math.min(backfillFrom + chunk * chunksPerTick - 1, backfillUpper);
            let from = backfillFrom;
            while (from <= tickEnd) {
                const to = Math.min(from + chunk - 1, tickEnd);
                const { okThrough, added, fetchFailed } = await processBlockRange(provider, readContract, redeemAddr, from, to, state, pending);
                if (okThrough != null) {
                    state.lastBackfillProcessedBlock = okThrough;
                    persistPending(state, pending);
                    if (added > 0) {
                        (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] backfill queued +${added} (pending=${pending.size}) ${from}-${okThrough} gap→head-1=${Math.max(0, backfillUpper - okThrough)}`));
                    }
                    else {
                        (0, logger_1.logger)(safe_1.default.gray(`[labMiningPoolClPayout] backfill ${from}-${okThrough} cursor=${okThrough} gap→head-1=${Math.max(0, backfillUpper - okThrough)}`));
                    }
                }
                if (fetchFailed || okThrough == null || okThrough < to)
                    break;
                from = to + 1;
            }
        }
        await flushPendingLabBatches(provider, readContract, redeemAddr, state, pending);
        tryPersistListeningCheckpoint(state, liveHead);
        persistPending(state, pending);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.red(`[labMiningPoolClPayout] tick error: ${e?.message ?? e}`));
    }
    finally {
        labInFlight = false;
    }
}
function scheduleNextLabTick() {
    if (!labStarted)
        return;
    labTimer = setTimeout(async () => {
        await labPayoutTick();
        scheduleNextLabTick();
    }, resolveTickMs());
}
function startValidatorLabMiningPoolClPayoutReporter() {
    if (labStarted)
        return;
    if (!labEnabled()) {
        (0, logger_1.logger)(safe_1.default.yellow('[labMiningPoolClPayout] disabled (set CONET_LAB_MINING_POOL_CL_PAYOUT=1)'));
        return;
    }
    if (!loadManifestIfNeeded(true))
        return;
    labSessionState = initLabSessionState();
    labStarted = true;
    (0, logger_1.logger)(safe_1.default.cyan(`[labMiningPoolClPayout] starting pubkeys=${labPubkeySet.size} tick=${resolveTickMs()}ms ` +
        `maxGasGwei=${ethers_1.ethers.formatUnits(resolveMaxGasPriceWei(), 'gwei')} gasWaitForceMs=${resolveGasWaitForceMs()} pendingPool=on`));
    void labPayoutTick().finally(() => scheduleNextLabTick());
}
function stopValidatorLabMiningPoolClPayoutReporter() {
    labStarted = false;
    labSessionState = undefined;
    sessionBackfillFloor = undefined;
    labPhaseLogged = false;
    if (labTimer !== undefined) {
        clearTimeout(labTimer);
        labTimer = undefined;
    }
}
/** Persist listening checkpoint before process exit (next restart backfills from lastListeningEndBlock+1). */
async function flushLabMiningPoolListeningCheckpoint() {
    try {
        const state = labSessionState ?? readStateFromDisk();
        const provider = new ethers_1.ethers.JsonRpcProvider(resolveLabRpcUrl());
        const liveHead = Number(await provider.getBlockNumber());
        if (Number.isFinite(liveHead)) {
            tryPersistListeningCheckpoint(state, liveHead);
        }
        writeState(state);
    }
    catch {
        /* best effort */
    }
}
async function waitForLabMiningPoolClPayoutIdle() {
    while (labInFlight) {
        await new Promise((r) => setTimeout(r, 250));
    }
}
