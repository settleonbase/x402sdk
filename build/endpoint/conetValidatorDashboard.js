"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeConetValidatorPubkey = normalizeConetValidatorPubkey;
exports.getConetValidatorDashboard = getConetValidatorDashboard;
const ethers_1 = require("ethers");
const util_1 = require("../util");
const chainAddresses_1 = require("../chainAddresses");
const validatorDepositRedeem_1 = require("./validatorDepositRedeem");
const conetUnifiedIncomeEnrichment_1 = require("./conetUnifiedIncomeEnrichment");
const PUBKEY_RE = /^0x[0-9a-f]{96}$/;
const CACHE_TTL_MS = 30_000;
const BEACON_TIMEOUT_MS = 8_000;
const DEFAULT_SECONDS_PER_SLOT = '12';
const DEFAULT_SLOTS_PER_EPOCH = '32';
const VALIDATOR_DASHBOARD_ABI = [
    'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
    'function getNodeValidator(uint256 guardianId) view returns (bytes pubkey, address withdrawalBeneficiary, uint64 registeredAt, uint64 exitedAt, bool active)',
    'function guardianIdBeneficiary(uint256 guardianId) view returns (address)',
    'function getBeneficiaryNodeBundle(address beneficiary) view returns (tuple(address beneficiary, uint256[] guardianNodeIds, string[] depinNodeIps, address[] nodeWallets, bytes[] validatorPubkeys, bool[] validatorActive, uint256 validatorNodeCount, uint256 gbMiningNodeCount, uint256 claimCount, uint256 nativeBalance, uint256 gbBalance, uint256 usdcBalance))',
];
const dashboardCache = new Map();
function normalizePubkey(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().toLowerCase();
    return PUBKEY_RE.test(normalized) ? normalized : null;
}
function toAddress(value) {
    try {
        return ethers_1.ethers.getAddress(String(value));
    }
    catch {
        return ethers_1.ethers.ZeroAddress;
    }
}
function toStringValue(value) {
    return typeof value === 'bigint' ? value.toString() : String(value ?? '');
}
function normalizeBytes(value) {
    try {
        return ethers_1.ethers.hexlify(ethers_1.ethers.getBytes(String(value))).toLowerCase();
    }
    catch {
        return '';
    }
}
function normalizeBundle(raw) {
    const row = raw;
    const array = (key) => (Array.isArray(row[key]) ? row[key] : []);
    return {
        beneficiary: toAddress(row.beneficiary),
        guardianNodeIds: array('guardianNodeIds').map((value) => BigInt(String(value))),
        depinNodeIps: array('depinNodeIps').map(String),
        nodeWallets: array('nodeWallets').map(toAddress),
        validatorPubkeys: array('validatorPubkeys').map(normalizeBytes),
        validatorActive: array('validatorActive').map(Boolean),
        validatorNodeCount: BigInt(String(row.validatorNodeCount ?? 0)),
        gbMiningNodeCount: BigInt(String(row.gbMiningNodeCount ?? 0)),
        claimCount: BigInt(String(row.claimCount ?? 0)),
        nativeBalance: BigInt(String(row.nativeBalance ?? 0)),
        gbBalance: BigInt(String(row.gbBalance ?? 0)),
        usdcBalance: BigInt(String(row.usdcBalance ?? 0)),
    };
}
function findBundleIndex(bundle, pubkey, guardianId) {
    const byGuardian = bundle.guardianNodeIds.findIndex((id) => id === guardianId);
    if (byGuardian >= 0)
        return byGuardian;
    return bundle.validatorPubkeys.findIndex((value) => value === pubkey);
}
async function fetchBeaconValidator(pubkey) {
    const base = (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '');
    try {
        const response = await fetch(`${base}/eth/v1/beacon/states/head/validators/${pubkey}`, {
            signal: AbortSignal.timeout(BEACON_TIMEOUT_MS),
        });
        if (!response.ok)
            return { available: false, value: null, updatedAt: null };
        const payload = (await response.json());
        if (!payload.data?.validator)
            return { available: false, value: null, updatedAt: null };
        return { available: true, value: payload.data, updatedAt: new Date().toISOString() };
    }
    catch {
        return { available: false, value: null, updatedAt: null };
    }
}
async function fetchBeaconTiming(base) {
    try {
        const [genesisResponse, specResponse] = await Promise.all([
            fetch(`${base}/eth/v1/beacon/genesis`, { signal: AbortSignal.timeout(BEACON_TIMEOUT_MS) }),
            fetch(`${base}/eth/v1/config/spec`, { signal: AbortSignal.timeout(BEACON_TIMEOUT_MS) }),
        ]);
        const genesisPayload = genesisResponse.ok
            ? await genesisResponse.json()
            : null;
        const specPayload = specResponse.ok
            ? await specResponse.json()
            : null;
        return {
            genesisTime: genesisPayload?.data?.genesis_time ?? null,
            secondsPerSlot: specPayload?.data?.SECONDS_PER_SLOT ?? DEFAULT_SECONDS_PER_SLOT,
            slotsPerEpoch: specPayload?.data?.SLOTS_PER_EPOCH ?? DEFAULT_SLOTS_PER_EPOCH,
        };
    }
    catch {
        return {
            genesisTime: null,
            secondsPerSlot: DEFAULT_SECONDS_PER_SLOT,
            slotsPerEpoch: DEFAULT_SLOTS_PER_EPOCH,
        };
    }
}
function emptyBeacon(timing = {
    genesisTime: null,
    secondsPerSlot: DEFAULT_SECONDS_PER_SLOT,
    slotsPerEpoch: DEFAULT_SLOTS_PER_EPOCH,
}) {
    return {
        available: false,
        index: null,
        status: null,
        balanceGwei: null,
        effectiveBalanceGwei: null,
        withdrawalCredentials: null,
        slashed: null,
        activationEligibilityEpoch: null,
        activationEpoch: null,
        exitEpoch: null,
        withdrawableEpoch: null,
        genesisTime: timing.genesisTime,
        secondsPerSlot: timing.secondsPerSlot,
        slotsPerEpoch: timing.slotsPerEpoch,
    };
}
function normalizeConetValidatorPubkey(value) {
    return normalizePubkey(value);
}
async function getConetValidatorDashboard(rawPubkey) {
    const pubkey = normalizePubkey(rawPubkey);
    if (!pubkey) {
        return { status: 400, body: { success: false, error: 'Validator pubkey must be 0x followed by 96 hexadecimal characters' } };
    }
    const cached = dashboardCache.get(pubkey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return { status: 200, body: cached.value };
    }
    try {
        const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)());
        const contract = new ethers_1.ethers.Contract(chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM, VALIDATOR_DASHBOARD_ABI, provider);
        const pubkeyHash = ethers_1.ethers.keccak256(ethers_1.ethers.getBytes(pubkey));
        const guardianId = (await contract.getNodeByValidatorPubkeyHash(pubkeyHash));
        if (guardianId === 0n) {
            return { status: 404, body: { success: false, error: 'Validator pubkey is not registered on CoNET' } };
        }
        const [validatorRaw, beneficiaryRaw] = await Promise.all([
            contract.getNodeValidator(guardianId),
            contract.guardianIdBeneficiary(guardianId),
        ]);
        const validator = {
            pubkey: normalizeBytes(validatorRaw[0]),
            withdrawalBeneficiary: toAddress(validatorRaw[1]),
            registeredAt: toStringValue(validatorRaw[2]),
            exitedAt: toStringValue(validatorRaw[3]),
            active: Boolean(validatorRaw[4]),
        };
        const beneficiary = toAddress(beneficiaryRaw);
        const bundle = normalizeBundle(await contract.getBeneficiaryNodeBundle(beneficiary));
        const index = findBundleIndex(bundle, pubkey, guardianId);
        const beaconBase = (process.env.CONET_VALIDATOR_BEACON_REST_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/$/, '');
        const [incomeResult, beacon] = await Promise.all([
            (0, validatorDepositRedeem_1.validatorDepositRedeemReadUnifiedIncomeStats)(beneficiary),
            fetchBeaconValidator(pubkey),
        ]);
        const beaconTiming = await fetchBeaconTiming(beaconBase);
        const beaconRow = beacon.value;
        const beaconValidator = beaconRow?.validator;
        const previous = cached?.value;
        const beaconState = beacon.available && beaconRow && beaconValidator
            ? {
                available: true,
                index: beaconRow.index ?? null,
                status: beaconRow.status ?? null,
                balanceGwei: beaconRow.balance ?? null,
                effectiveBalanceGwei: beaconValidator.effective_balance ?? null,
                withdrawalCredentials: beaconValidator.withdrawal_credentials ?? null,
                slashed: beaconValidator.slashed ?? null,
                activationEligibilityEpoch: beaconValidator.activation_eligibility_epoch ?? null,
                activationEpoch: beaconValidator.activation_epoch ?? null,
                exitEpoch: beaconValidator.exit_epoch ?? null,
                withdrawableEpoch: beaconValidator.withdrawable_epoch ?? null,
                ...beaconTiming,
            }
            : previous?.beacon ?? emptyBeacon(beaconTiming);
        let income = incomeResult.ok ? incomeResult.stats : cached?.value.income ?? null;
        if (income) {
            const nodeHints = bundle.guardianNodeIds.map((gid, i) => ({
                guardianId: Number(gid),
                depinNodeIp: bundle.depinNodeIps[i] ?? null,
                nodeWallet: bundle.nodeWallets[i] ?? null,
            }));
            income = (0, conetUnifiedIncomeEnrichment_1.adaptUnifiedIncomeStatsForBlockscoutValidatorUi)(await (0, conetUnifiedIncomeEnrichment_1.enrichUnifiedIncomeStats)(income, {
                beneficiary,
                nodeHints,
            }));
        }
        const clRewardPaidWei = income?.cnetBeneficiary?.cumulative ?? '0';
        const value = {
            success: true,
            pubkey,
            chain: {
                contract: chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM,
                guardianId: guardianId.toString(),
                beneficiary,
                withdrawalBeneficiary: validator.withdrawalBeneficiary,
                registeredAt: validator.registeredAt,
                exitedAt: validator.exitedAt,
                active: validator.active,
                nodeWallet: index >= 0 ? bundle.nodeWallets[index] ?? null : null,
                depinNodeIp: index >= 0 ? bundle.depinNodeIps[index] ?? null : null,
                clRewardPaidWei,
            },
            income,
            beacon: beaconState,
            meta: {
                partial: !beacon.available,
                stale: false,
                chainUpdatedAt: new Date().toISOString(),
                beaconUpdatedAt: beacon.available ? beacon.updatedAt : previous?.meta.beaconUpdatedAt ?? null,
            },
        };
        dashboardCache.set(pubkey, { value, fetchedAt: Date.now() });
        return { status: 200, body: value };
    }
    catch (error) {
        if (cached) {
            return {
                status: 200,
                body: {
                    ...cached.value,
                    meta: { ...cached.value.meta, stale: true, partial: true },
                },
            };
        }
        return { status: 503, body: { success: false, error: `CoNET validator data unavailable: ${error.message}` } };
    }
}
