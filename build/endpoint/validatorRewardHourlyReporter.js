"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startValidatorRewardHourlyReporter = startValidatorRewardHourlyReporter;
exports.stopValidatorRewardHourlyReporter = stopValidatorRewardHourlyReporter;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const util_1 = require("../util");
const validatorDepositRedeem_1 = require("./validatorDepositRedeem");
const DEFAULT_NEW_CONET_DIR = '/Users/peter/Downloads/seguro-pro/CoNET-DL-master/newCoNET';
const DEFAULT_BEACON_REST = 'http://127.0.0.1:4100';
const REPORTER_ABI = [
    'function getNodeValidator(address nodeWallet) view returns (bytes pubkey, address withdrawalBeneficiary, uint64 registeredAt, uint64 exitedAt, bool active)',
    'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (address nodeWallet)',
];
let reporterStarted = false;
let reporterTimer;
let reporterInFlight = false;
function resolveNewCoNETDir() {
    return process.env.CONET_VALIDATOR_NEWCONET_DIR?.trim() || util_1.masterSetup.validatorDeposit?.newCoNETDir?.trim() || DEFAULT_NEW_CONET_DIR;
}
function resolveRewardReporterStateFile() {
    return (process.env.CONET_VALIDATOR_HOURLY_REWARD_STATE_FILE?.trim() ||
        process.env.CONET_VALIDATOR_REWARD_REPORTER_STATE_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-validator-reward-reporter-state.json'));
}
function resolveBeaconRestUrl() {
    return (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || DEFAULT_BEACON_REST).replace(/\/$/, '');
}
function resolveReporterTickMs() {
    const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_TICK_MS || process.env.CONET_VALIDATOR_REWARD_REPORTER_TICK_MS || 60_000);
    return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000;
}
function resolveReportChunkSize() {
    const n = Number(process.env.CONET_VALIDATOR_HOURLY_REWARD_CHUNK || process.env.CONET_VALIDATOR_REWARD_REPORTER_CHUNK || 40);
    return Number.isFinite(n) && n >= 1 ? Math.min(200, Math.floor(n)) : 40;
}
function reporterDryRun() {
    const v = (process.env.CONET_VALIDATOR_HOURLY_REWARD_DRY_RUN || process.env.CONET_VALIDATOR_REWARD_REPORTER_DRY_RUN || process.env.CONET_VALIDATOR_DRY_RUN || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
function reporterEnabled() {
    if (process.env.CONET_VALIDATOR_HOURLY_REWARD_REPORT === '0')
        return false;
    if (process.env.CONET_VALIDATOR_REWARD_REPORTER === '0')
        return false;
    if (process.env.CONET_VALIDATOR_HOURLY_REWARD_REPORT === '1')
        return true;
    if (process.env.CONET_VALIDATOR_REWARD_REPORTER === '1')
        return true;
    // Default: follow redeem listener flag when unset.
    return process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1';
}
function gweiToWei(gwei) {
    return gwei * 1000000000n;
}
function readState() {
    const file = resolveRewardReporterStateFile();
    try {
        if (!node_fs_1.default.existsSync(file)) {
            return { updatedAt: new Date().toISOString(), lastSnapshot: {} };
        }
        const raw = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
        if (raw.lastSnapshot && typeof raw.lastSnapshot === 'object') {
            return { updatedAt: raw.updatedAt ?? new Date().toISOString(), lastSnapshot: raw.lastSnapshot };
        }
        if (raw.hourStart && typeof raw.hourStart === 'object') {
            (0, logger_1.logger)(safe_1.default.yellow('[validatorRewardReporter] migrated legacy UTC-hour state → delta baseline (re-baselining on next tick)'));
        }
        return { updatedAt: new Date().toISOString(), lastSnapshot: {} };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorRewardReporter] state reset: ${e?.message ?? e}`));
        return { updatedAt: new Date().toISOString(), lastSnapshot: {} };
    }
}
function writeState(state) {
    const file = resolveRewardReporterStateFile();
    state.updatedAt = new Date().toISOString();
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
function normalizePubkeyHex(raw) {
    const pk = String(raw ?? '').trim();
    if (!pk)
        return null;
    try {
        return ethers_1.ethers.hexlify(ethers_1.ethers.getBytes(pk.startsWith('0x') ? pk : `0x${pk}`)).toLowerCase();
    }
    catch {
        return null;
    }
}
function readExtraTrackPubkeys() {
    const inline = (process.env.CONET_VALIDATOR_TRACK_PUBKEYS || '').trim();
    if (!inline)
        return [];
    return [
        ...new Set(inline
            .split(/[\s,]+/)
            .map((s) => normalizePubkeyHex(s))
            .filter((s) => Boolean(s))),
    ];
}
/** List validator pubkeys from Prysm wallet account metadata (optional supplement to deposit file). */
function readPrysmWalletPubkeys() {
    const walletDir = process.env.CONET_VALIDATOR_PRYSM_WALLET_DIR?.trim() ||
        node_path_1.default.join(resolveNewCoNETDir(), 'network/node-0/consensus/validator-wallet');
    const accountsDir = node_path_1.default.join(walletDir, 'direct/accounts');
    if (!node_fs_1.default.existsSync(accountsDir))
        return [];
    const out = [];
    try {
        for (const file of node_fs_1.default.readdirSync(accountsDir)) {
            if (!file.endsWith('.json'))
                continue;
            try {
                const meta = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(accountsDir, file), 'utf8'));
                const pk = normalizePubkeyHex(String(meta?.validator?.publicKey ?? ''));
                if (pk)
                    out.push(pk);
            }
            catch {
                // skip corrupt account file
            }
        }
    }
    catch {
        return [];
    }
    return [...new Set(out)];
}
function readLocalDepositPubkeys() {
    const depositFile = node_path_1.default.join(resolveNewCoNETDir(), 'validator_deposits.json');
    const out = [];
    if (node_fs_1.default.existsSync(depositFile)) {
        try {
            const arr = JSON.parse(node_fs_1.default.readFileSync(depositFile, 'utf8'));
            if (Array.isArray(arr)) {
                for (const entry of arr) {
                    const pk = normalizePubkeyHex(String(entry?.pubkey ?? ''));
                    if (pk)
                        out.push(pk);
                }
            }
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[validatorRewardReporter] deposit file read failed: ${e?.message ?? e}`));
        }
    }
    out.push(...readPrysmWalletPubkeys(), ...readExtraTrackPubkeys());
    return [...new Set(out)];
}
async function loadTrackedValidators(contract) {
    const pubkeys = readLocalDepositPubkeys();
    if (!pubkeys.length)
        return [];
    const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)());
    const c = new ethers_1.ethers.Contract(contract, REPORTER_ABI, provider);
    const out = [];
    for (const pubkey of pubkeys) {
        try {
            const pkHash = ethers_1.ethers.keccak256(pubkey);
            const nodeWallet = ethers_1.ethers.getAddress(await c.getNodeByValidatorPubkeyHash(pkHash));
            if (nodeWallet === ethers_1.ethers.ZeroAddress)
                continue;
            const row = await c.getNodeValidator(nodeWallet);
            const beneficiary = ethers_1.ethers.getAddress(String(row.withdrawalBeneficiary ?? row[1]));
            const active = Boolean(row.active ?? row[4]);
            out.push({ pubkey, nodeWallet, beneficiary, active });
        }
        catch {
            // skip unregistered / RPC blip for single pubkey
        }
    }
    return out.filter((v) => v.active);
}
async function fetchBeaconBalanceGwei(pubkey) {
    const base = resolveBeaconRestUrl();
    const id = encodeURIComponent(pubkey.startsWith('0x') ? pubkey : `0x${pubkey}`);
    const url = `${base}/eth/v1/beacon/states/head/validators/${id}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok)
            return null;
        const json = (await res.json());
        const bal = json?.data?.balance;
        if (bal == null || bal === '')
            return null;
        const gwei = BigInt(bal);
        return gwei >= 0n ? gwei : null;
    }
    catch {
        return null;
    }
}
async function fetchNativeBalanceWei(provider, address) {
    try {
        const bal = await provider.getBalance(address);
        return bal >= 0n ? bal : null;
    }
    catch {
        return null;
    }
}
async function snapshotValidators(validators) {
    const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)());
    const beneficiaryCache = new Map();
    const out = new Map();
    for (const v of validators) {
        const beaconGwei = await fetchBeaconBalanceGwei(v.pubkey);
        if (beaconGwei == null)
            continue;
        let feeWei = beneficiaryCache.get(v.beneficiary);
        if (feeWei === undefined) {
            feeWei = await fetchNativeBalanceWei(provider, v.beneficiary);
            beneficiaryCache.set(v.beneficiary, feeWei);
        }
        if (feeWei == null)
            continue;
        out.set(v.pubkey.toLowerCase(), {
            beaconGwei: beaconGwei.toString(),
            feeRecipientWei: feeWei.toString(),
        });
    }
    return out;
}
function rewardEventKey(pubkey, start, end) {
    return ethers_1.ethers.keccak256(ethers_1.ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256', 'uint256', 'uint256', 'uint256'], [
        ethers_1.ethers.keccak256(pubkey),
        BigInt(start.beaconGwei),
        BigInt(end.beaconGwei),
        BigInt(start.feeRecipientWei),
        BigInt(end.feeRecipientWei),
    ]));
}
function computeRewardEntries(validators, start, end) {
    const byBeneficiary = new Map();
    for (const v of validators) {
        const key = v.beneficiary.toLowerCase();
        const list = byBeneficiary.get(key) ?? [];
        list.push(v);
        byBeneficiary.set(key, list);
    }
    const entries = [];
    for (const v of validators) {
        const pk = v.pubkey.toLowerCase();
        const s = start.get(pk);
        const e = end.get(pk);
        if (!s || !e)
            continue;
        let reward = 0n;
        const beaconDelta = BigInt(e.beaconGwei) - BigInt(s.beaconGwei);
        if (beaconDelta > 0n)
            reward += gweiToWei(beaconDelta);
        const group = byBeneficiary.get(v.beneficiary.toLowerCase()) ?? [v];
        const feeStart = BigInt(s.feeRecipientWei);
        const feeEnd = BigInt(e.feeRecipientWei);
        const feeDelta = feeEnd > feeStart ? feeEnd - feeStart : 0n;
        if (feeDelta > 0n && group.length > 0) {
            reward += feeDelta / BigInt(group.length);
        }
        if (reward <= 0n)
            continue;
        entries.push({
            eventKey: rewardEventKey(pk, s, e),
            nodeWallet: v.nodeWallet,
            pubkey: pk,
            amount: reward,
        });
    }
    return entries;
}
async function submitRewardReports(entries, endSnap, state) {
    if (!entries.length)
        return;
    const chunk = resolveReportChunkSize();
    for (let i = 0; i < entries.length; i += chunk) {
        const slice = entries.slice(i, i + chunk);
        if (reporterDryRun()) {
            (0, logger_1.logger)(safe_1.default.cyan(`[validatorRewardReporter] dry-run report ${slice.length} rows sample=${slice[0]?.nodeWallet} amount=${slice[0]?.amount.toString()}`));
            for (const row of slice) {
                const snap = endSnap.get(row.pubkey);
                if (snap)
                    state.lastSnapshot[row.pubkey] = snap;
            }
            writeState(state);
            continue;
        }
        const res = await (0, validatorDepositRedeem_1.validatorRewardReport)(slice.map((e) => ({
            eventKey: e.eventKey,
            nodeWallet: e.nodeWallet,
            amount: e.amount,
        })));
        if (!res.ok) {
            throw new Error(res.error);
        }
        for (const row of slice) {
            const snap = endSnap.get(row.pubkey);
            if (snap)
                state.lastSnapshot[row.pubkey] = snap;
        }
        writeState(state);
        (0, logger_1.logger)(safe_1.default.green(`[validatorRewardReporter] reported ${res.added}/${res.count} rows tx=${res.txHash} sample=${slice[0]?.nodeWallet}`));
    }
}
async function reporterTick() {
    if (reporterInFlight)
        return;
    reporterInFlight = true;
    try {
        const contract = (0, validatorDepositRedeem_1.resolveValidatorDepositRedeemAddress)();
        if (!contract) {
            (0, logger_1.logger)(safe_1.default.yellow('[validatorRewardReporter] skip: ValidatorDepositRedeem not configured'));
            return;
        }
        const indexer = await (0, validatorDepositRedeem_1.resolveValidatorNodeRewardIndexerAddress)();
        if (!indexer) {
            (0, logger_1.logger)(safe_1.default.yellow('[validatorRewardReporter] skip: ValidatorNodeRewardIndexer not configured'));
            return;
        }
        const validators = await loadTrackedValidators(contract);
        if (!validators.length) {
            (0, logger_1.logger)(safe_1.default.yellow('[validatorRewardReporter] no active local validators to track'));
            return;
        }
        const state = readState();
        const endSnap = await snapshotValidators(validators);
        if (!Object.keys(state.lastSnapshot).length) {
            for (const [pk, snap] of endSnap.entries()) {
                state.lastSnapshot[pk] = snap;
            }
            writeState(state);
            (0, logger_1.logger)(safe_1.default.cyan(`[validatorRewardReporter] baseline ${endSnap.size} validators (no report until reward delta)`));
            return;
        }
        const startMap = new Map();
        for (const [pk, snap] of Object.entries(state.lastSnapshot))
            startMap.set(pk, snap);
        const entries = computeRewardEntries(validators, startMap, endSnap);
        if (entries.length) {
            await submitRewardReports(entries, endSnap, state);
        }
        for (const [pk, snap] of endSnap.entries()) {
            state.lastSnapshot[pk] = snap;
        }
        writeState(state);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.red('[validatorRewardReporter] tick failed:'), e?.message ?? String(e));
    }
    finally {
        reporterInFlight = false;
    }
}
function scheduleReporterTick() {
    if (reporterTimer !== undefined)
        clearTimeout(reporterTimer);
    reporterTimer = setTimeout(async () => {
        try {
            await reporterTick();
        }
        finally {
            scheduleReporterTick();
        }
    }, resolveReporterTickMs());
}
/** CoNET validator-node listener: detect CL+EL CNET reward deltas and report via {validatorRewardReport}. */
function startValidatorRewardHourlyReporter() {
    if (reporterStarted)
        return;
    reporterStarted = true;
    if (!reporterEnabled()) {
        (0, logger_1.logger)(safe_1.default.yellow('[validatorRewardReporter] disabled (set CONET_VALIDATOR_HOURLY_REWARD_REPORT=1)'));
        return;
    }
    const nodeIp = (0, validatorDepositRedeem_1.resolveValidatorNodeIp)();
    (0, logger_1.logger)(safe_1.default.cyan(`[validatorRewardReporter] starting nodeIp=${nodeIp || '?'} beacon=${resolveBeaconRestUrl()} tick=${resolveReporterTickMs()}ms`));
    void reporterTick().finally(() => scheduleReporterTick());
}
function stopValidatorRewardHourlyReporter() {
    if (reporterTimer !== undefined) {
        clearTimeout(reporterTimer);
        reporterTimer = undefined;
    }
    reporterStarted = false;
}
