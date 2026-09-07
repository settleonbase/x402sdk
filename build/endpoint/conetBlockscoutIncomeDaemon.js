"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startConetBlockscoutIncomeDaemon = startConetBlockscoutIncomeDaemon;
exports.getBeneficiaryGuardianClPaidMap = getBeneficiaryGuardianClPaidMap;
exports.getConetBlockscoutIncomeDaemonStatus = getConetBlockscoutIncomeDaemonStatus;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const chainAddresses_1 = require("../chainAddresses");
const logger_1 = require("../logger");
const conetBlockscoutClient_1 = require("./conetBlockscoutClient");
const TICK_MS = Number(process.env.CONET_BLOCKSCOUT_INCOME_DAEMON_MS ?? 60_000);
const MAX_PAGES_PER_TICK = Number(process.env.CONET_BLOCKSCOUT_INCOME_PAGES_PER_TICK ?? 8);
const ENABLED = process.env.CONET_BLOCKSCOUT_INCOME_DAEMON !== '0' &&
    process.env.CONET_BLOCKSCOUT_INCOME_DAEMON !== 'false';
/** beneficiary lower → guardianId → cumulative CL wei from NodeRewardSettled logs */
const guardianClByBeneficiary = new Map();
/** eventKey lower → true (dedupe across pages / head refresh) */
const seenEventKeys = new Set();
let backfillCursor = undefined;
let backfillComplete = false;
let daemonTimer;
let tickInFlight = false;
let lastTickAt = 0;
let lastError = null;
function beneficiaryKey(addr) {
    try {
        return ethers_1.ethers.getAddress(addr).toLowerCase();
    }
    catch {
        return addr.toLowerCase();
    }
}
function getOrCreateBeneficiaryMap(key) {
    let m = guardianClByBeneficiary.get(key);
    if (!m) {
        m = new Map();
        guardianClByBeneficiary.set(key, m);
    }
    return m;
}
function ingestNodeRewardSettled(guardianId, beneficiary, amount, eventKey) {
    const dedupeKey = eventKey.toLowerCase();
    if (dedupeKey && seenEventKeys.has(dedupeKey))
        return;
    if (dedupeKey)
        seenEventKeys.add(dedupeKey);
    const benKey = beneficiaryKey(beneficiary);
    const map = getOrCreateBeneficiaryMap(benKey);
    map.set(guardianId, (map.get(guardianId) ?? 0n) + amount);
}
function ingestLogsPage(items) {
    let count = 0;
    for (const log of items) {
        const parsed = (0, conetBlockscoutClient_1.parseNodeRewardSettledFromBlockscoutLog)(log);
        if (!parsed)
            continue;
        ingestNodeRewardSettled(parsed.guardianId, parsed.beneficiary, parsed.amount, parsed.eventKey);
        count += 1;
    }
    return count;
}
async function fetchAndIngestPage(pageParams) {
    const page = await (0, conetBlockscoutClient_1.fetchBlockscoutAddressLogsPage)(chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM, pageParams);
    const ingested = ingestLogsPage(page.items);
    return { next: page.next_page_params, ingested };
}
async function runDaemonTick() {
    if (tickInFlight)
        return;
    tickInFlight = true;
    lastTickAt = Date.now();
    try {
        let pages = 0;
        if (!backfillComplete) {
            while (pages < MAX_PAGES_PER_TICK) {
                const { next, ingested } = await fetchAndIngestPage(backfillCursor ?? undefined);
                pages += 1;
                backfillCursor = next;
                if (!next) {
                    backfillComplete = true;
                    (0, logger_1.logger)(safe_1.default.green(`[conetBlockscoutIncomeDaemon] backfill complete; beneficiaries=${guardianClByBeneficiary.size} events=${seenEventKeys.size} lastPageIngested=${ingested}`));
                    break;
                }
            }
            if (!backfillComplete) {
                (0, logger_1.logger)(safe_1.default.cyan(`[conetBlockscoutIncomeDaemon] backfill progress pages=${pages} beneficiaries=${guardianClByBeneficiary.size} events=${seenEventKeys.size}`));
            }
        }
        else {
            // Head refresh: newest page only (Blockscout sorts desc).
            const { ingested } = await fetchAndIngestPage(undefined);
            if (ingested > 0) {
                (0, logger_1.logger)(safe_1.default.green(`[conetBlockscoutIncomeDaemon] head refresh ingested=${ingested} beneficiaries=${guardianClByBeneficiary.size}`));
            }
        }
        lastError = null;
    }
    catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.yellow(`[conetBlockscoutIncomeDaemon] tick failed: ${lastError}`));
    }
    finally {
        tickInFlight = false;
        scheduleDaemonTick();
    }
}
function scheduleDaemonTick() {
    if (!ENABLED)
        return;
    if (daemonTimer !== undefined)
        clearTimeout(daemonTimer);
    daemonTimer = setTimeout(() => {
        void runDaemonTick();
    }, TICK_MS);
}
function startConetBlockscoutIncomeDaemon() {
    if (!ENABLED) {
        (0, logger_1.logger)(safe_1.default.yellow('[conetBlockscoutIncomeDaemon] disabled (set CONET_BLOCKSCOUT_INCOME_DAEMON=0 to suppress)'));
        return;
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[conetBlockscoutIncomeDaemon] starting contract=${chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM} deployFloor=${chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK} tickMs=${TICK_MS}`));
    backfillCursor = undefined;
    backfillComplete = false;
    void runDaemonTick();
}
function getBeneficiaryGuardianClPaidMap(beneficiary) {
    const key = beneficiaryKey(beneficiary);
    const cached = guardianClByBeneficiary.get(key);
    return cached ? new Map(cached) : new Map();
}
function getConetBlockscoutIncomeDaemonStatus() {
    return {
        enabled: ENABLED,
        backfillComplete,
        beneficiaryCount: guardianClByBeneficiary.size,
        eventCount: seenEventKeys.size,
        lastTickAt,
        lastError,
    };
}
