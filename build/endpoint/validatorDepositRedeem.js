"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.walletDepositFulfillProcess = exports.walletDepositFulfillPool = exports.genesisNodeSeatFulfillProcess = exports.genesisNodeSeatFulfillPool = exports.validatorFulfillTransferOrderProcess = exports.validatorCancelTransferOrderProcess = exports.validatorCreateTransferOrderProcess = exports.validatorDepositRedeemTransferProcess = exports.validatorDepositRedeemClaimProcess = exports.validatorDepositRedeemCancelProcess = exports.validatorDepositRedeemClaimAirdropProcess = exports.validatorDepositRedeemCreateProcess = exports.validatorFulfillTransferOrderPool = exports.validatorCancelTransferOrderPool = exports.validatorCreateTransferOrderPool = exports.validatorDepositRedeemTransferPool = exports.validatorDepositRedeemClaimAirdropPool = exports.validatorDepositRedeemClaimPool = exports.validatorDepositRedeemCancelPool = exports.validatorDepositRedeemCreatePool = exports.usdcTransferWithAuthorizationTypes = exports.validatorFulfillTransferOrderTypes = exports.validatorCancelTransferOrderTypes = exports.validatorCreateTransferOrderTypes = exports.validatorDepositRedeemTransferTypes = exports.validatorDepositRedeemClaimTypes = exports.validatorDepositRedeemCancelTypes = exports.validatorDepositRedeemClaimAirdropTypes = exports.validatorDepositRedeemCreateTypes = exports.REWARD_PERIOD = void 0;
exports.resolveClaimRedeemForGasLimit = resolveClaimRedeemForGasLimit;
exports.validatorDepositRedeemClaimAllocationPreflight = validatorDepositRedeemClaimAllocationPreflight;
exports.resolveValidatorDepositRedeemAddress = resolveValidatorDepositRedeemAddress;
exports.resolveValidatorReferrerExtensionAddress = resolveValidatorReferrerExtensionAddress;
exports.resolveValidatorNodeRewardIndexerAddress = resolveValidatorNodeRewardIndexerAddress;
exports.validatorRewardReadBeneficiarySummary = validatorRewardReadBeneficiarySummary;
exports.validatorRewardReadNodeSummary = validatorRewardReadNodeSummary;
exports.validatorDepositRedeemReadUnifiedIncomeStats = validatorDepositRedeemReadUnifiedIncomeStats;
exports.validatorDepositRedeemReadReferrerDetail = validatorDepositRedeemReadReferrerDetail;
exports.validatorDepositRedeemReadReferrerSummary = validatorDepositRedeemReadReferrerSummary;
exports.validatorDepositRedeemReadReferrerReferredBeneficiaries = validatorDepositRedeemReadReferrerReferredBeneficiaries;
exports.validatorRewardReadBeneficiaryWithNodes = validatorRewardReadBeneficiaryWithNodes;
exports.validatorRewardReadNodePeriods = validatorRewardReadNodePeriods;
exports.validatorRewardReadBeneficiaryPeriods = validatorRewardReadBeneficiaryPeriods;
exports.validatorRewardReport = validatorRewardReport;
exports.resolveValidatorNodeIp = resolveValidatorNodeIp;
exports.getValidatorDepositRedeemStatus = getValidatorDepositRedeemStatus;
exports.validatorDepositRedeemConfig = validatorDepositRedeemConfig;
exports.validatorDepositRedeemEip712Domain = validatorDepositRedeemEip712Domain;
exports.validatorDepositRedeemReadAdminNonce = validatorDepositRedeemReadAdminNonce;
exports.validatorDepositRedeemCreateClusterPreCheck = validatorDepositRedeemCreateClusterPreCheck;
exports.validatorDepositRedeemCancelClusterPreCheck = validatorDepositRedeemCancelClusterPreCheck;
exports.validatorDepositRedeemClaimClusterPreCheck = validatorDepositRedeemClaimClusterPreCheck;
exports.probeLinkedValidatorDepositRedeemByCode = probeLinkedValidatorDepositRedeemByCode;
exports.validatorDepositRedeemClaimAirdropClusterPreCheck = validatorDepositRedeemClaimAirdropClusterPreCheck;
exports.validatorDepositRedeemTransferClusterPreCheck = validatorDepositRedeemTransferClusterPreCheck;
exports.createTransferOrderClusterPreCheck = createTransferOrderClusterPreCheck;
exports.cancelTransferOrderClusterPreCheck = cancelTransferOrderClusterPreCheck;
exports.fulfillTransferOrderClusterPreCheck = fulfillTransferOrderClusterPreCheck;
exports.enqueueLinkedValidatorDepositRedeemClaim = enqueueLinkedValidatorDepositRedeemClaim;
exports.getActiveRunCommandChildCount = getActiveRunCommandChildCount;
exports.waitForRunCommandChildren = waitForRunCommandChildren;
exports.retryRegisterDeployedValidatorsForRedeemState = retryRegisterDeployedValidatorsForRedeemState;
exports.waitForListenerSerialQueue = waitForListenerSerialQueue;
exports.stopValidatorDepositRedeemListener = stopValidatorDepositRedeemListener;
exports.replayValidatorRedeemClaimedEvent = replayValidatorRedeemClaimedEvent;
exports.kickGenesisNodeSeatFulfillPoolPress = kickGenesisNodeSeatFulfillPoolPress;
exports.kickWalletDepositFulfillPoolPress = kickWalletDepositFulfillPoolPress;
exports.startValidatorDepositRedeemListener = startValidatorDepositRedeemListener;
const ethers_1 = require("ethers");
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = require("node:crypto");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const util_1 = require("../util");
const chainAddresses_1 = require("../chainAddresses");
const settleContractPool_1 = require("../settleContractPool");
const onchainTxSerialQueue_1 = require("../onchainTxSerialQueue");
const genesisNodeReferralIncome_1 = require("../genesisNodeReferralIncome");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
const VALIDATOR_REDEEM_VERSION = 'validator-deposit-redeem-v1';
const VALIDATOR_STAKE_WEI = 32n * 10n ** 18n;
const MAX_REDEEM_CODE_BYTES = 512;
const MAX_IP_BYTES = 64;
const DEFAULT_NEW_CONET_DIR = '/Users/peter/Downloads/seguro-pro/CoNET-DL-master/newCoNET';
const VALIDATOR_DEPOSIT_REDEEM_ABI = [
    'event ValidatorRedeemClaimed(bytes32 indexed requestId, bytes32 indexed codeHash, address indexed claimer, address beneficiary, uint256 validatorCount, string targetNodeIp, string[] conetDepinNodeIps, uint256 gbMiningNodeCount)',
    'function createRedeemFor(address admin, bytes32 codeHash, address allowedClaimer, address referrer, uint256 validatorCount, string targetNodeIp, uint256 gbMiningNodeCount, bool airdrop, uint256 validAfter, uint256 validBefore, uint256 nonce, uint256 deadline, bytes signature) external',
    'function cancelRedeemFor(address admin, bytes32 codeHash, uint256 nonce, uint256 deadline, bytes signature) external',
    'function claimRedeemFor(address claimer, address beneficiary, string code, uint256 deadline, bytes signature) external returns (bytes32)',
    'function referrerExtension() view returns (address)',
    'function grantReferrerRewardNodes(address referrer, uint256 count) external',
    'function getReferrerRewardNodes(address referrer) view returns (uint256[] guardianNodeIds, address[] nodeWallets, string[] depinNodeIps)',
    'function redeemAdminNonces(address account) view returns (uint256)',
    'function redeemAdmins(address account) view returns (bool)',
    'function admins(address account) view returns (bool)',
    'function getRedeem(bytes32 codeHash) view returns (address allowedClaimer, address referrer, uint256 validatorCount, string targetNodeIp, uint256 gbMiningNodeCount, uint64 validAfter, uint64 validBefore, bool active, bool consumed, bool airdrop)',
    'function airdropInfoOf(address beneficiary) view returns (uint256 accrued, uint256 claimed, uint256 claimable, uint64 claimableAt)',
    'function setAirdropClaimableAt(uint64 claimableAt) external',
    'function claimAirdropFor(address beneficiary, uint256 amount, uint256 nonce, uint256 deadline, bytes signature) external',
    'event AirdropAccrued(address indexed beneficiary, bytes32 indexed codeHash, uint256 added, uint256 newTotal)',
    'event AirdropClaimed(address indexed beneficiary, uint256 amount)',
    'event AirdropClaimableAtSet(uint64 claimableAt)',
    'function registerNodeValidators(uint256[] guardianIds, bytes[] pubkeys) external',
    'function registerNodeValidatorsFor(address admin, uint256[] guardianIds, bytes[] pubkeys, uint256 nonce, uint256 deadline, bytes signature) external',
    'function getNodeValidator(uint256 guardianId) view returns (bytes pubkey, address withdrawalBeneficiary, uint64 registeredAt, uint64 exitedAt, bool active)',
    'function getBeneficiaryNodeBundle(address beneficiary) view returns (tuple(address beneficiary, uint256[] guardianNodeIds, string[] depinNodeIps, address[] nodeWallets, bytes[] validatorPubkeys, bool[] validatorActive, uint256 validatorNodeCount, uint256 gbMiningNodeCount, uint256 claimCount, uint256 nativeBalance, uint256 gbBalance, uint256 usdcBalance))',
    'function resolveNodeBundle(address maybeWallet, string conetDepinNodeIp) view returns (tuple(address beneficiary, uint256[] guardianNodeIds, string[] depinNodeIps, address[] nodeWallets, bytes[] validatorPubkeys, bool[] validatorActive, uint256 validatorNodeCount, uint256 gbMiningNodeCount, uint256 claimCount, uint256 nativeBalance, uint256 gbBalance, uint256 usdcBalance))',
    'function resolveUnifiedIncomeStats(address maybeWallet, string conetDepinNodeIp, uint256 anchorTs) view returns (tuple(address beneficiary, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) gbBeneficiary, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) cnetBeneficiary, tuple(address nodeWallet, string depinNodeIp, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) gb, tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year) cnet)[] nodes))',
    'function transferNodes(address fromBeneficiary, address toBeneficiary, uint256[] guardianIds, uint256 nonce, uint256 deadline, bytes signature) external',
    'function getTransferNodesDigest(address fromBeneficiary, address toBeneficiary, uint256[] guardianIds, uint256 nonce, uint256 deadline) view returns (bytes32)',
    'function beneficiaryNonces(address account) view returns (uint256)',
    'function getBeneficiaryByNodeWallet(address nodeWallet) view returns (address beneficiary)',
    'function getNodeByValidatorPubkeyHash(bytes32 pubkeyHash) view returns (uint256 guardianId)',
    'function createTransferOrder(address seller, uint256[] guardianIds, uint256 priceUsdc6, uint256 nonce, uint256 deadline, bytes signature) external returns (uint256 orderId)',
    'function cancelTransferOrder(uint256 orderId, address seller, uint256 nonce, uint256 deadline, bytes signature) external',
    'function fulfillTransferOrder(uint256 orderId, address buyer, uint256 nonce, uint256 deadline, bytes signature, uint256 payValidAfter, uint256 payValidBefore, bytes32 payNonce, bytes paySignature) external',
    'function getTransferOrder(uint256 orderId) view returns (address seller, uint256[] guardianIds, uint256 priceUsdc6, bool active, address buyer, uint64 createdAt, uint64 filledAt)',
    'function nodeOrder(uint256 guardianId) view returns (uint256)',
    'function usdcToken() view returns (address)',
    'function setDepositContract(address depositContract_) external',
    'function depositContract() view returns (address)',
    'function selfWithdrawalCredentials() view returns (bytes32)',
    'function stakedValidatorCountOf(address beneficiary) view returns (uint256)',
    'function fundedDepositTotal() view returns (uint256)',
    'function exitSettledPubkey(bytes32 pubkeyHash) view returns (bool)',
    'function fundAndDepositValidators(uint256[] guardianIds, bytes[] pubkeys, bytes[] withdrawalCredentials, bytes[] signatures, bytes32[] depositDataRoots) external',
    'function requestFullExit(address beneficiary, uint256[] guardianIds, uint256 nonce, uint256 deadline, bytes signature) external',
    'function settleFullExitPayout(address beneficiary, uint256[] guardianIds) external',
    'function settleNodeRewards(uint256[] guardianIds, uint256[] amounts, bytes32[] eventKeys) external',
    'function consumedRewardEventKey(bytes32 key) view returns (bool)',
    'function totalStakedValidatorCount() view returns (uint256)',
    'function totalRewardPaid() view returns (uint256)',
    'function getRequestFullExitDigest(address beneficiary, uint256[] guardianIds, uint256 nonce, uint256 deadline) view returns (bytes32)',
    'function rewardIndexer() view returns (address)',
    'function getClaimRedeemDigest(address claimer, bytes32 codeHash, address beneficiary, uint256 deadline) view returns (bytes32)',
    'function nextGuardianAllocId() view returns (uint256)',
    'function guardianAllocStartId() view returns (uint256)',
    'function guardianIdBeneficiary(uint256 nodeId) view returns (address)',
    'function nodeWalletBeneficiary(address nodeWallet) view returns (address)',
    'function setRewardIndexer(address rewardIndexer_) external',
    'event RewardIndexerConfigured(address indexed rewardIndexer)',
    'event TransferOrderCreated(uint256 indexed orderId, address indexed seller, uint256 priceUsdc6, uint256[] guardianIds)',
    'event TransferOrderCancelled(uint256 indexed orderId, address indexed seller)',
    'event TransferOrderFilled(uint256 indexed orderId, address indexed seller, address indexed buyer, uint256 priceUsdc6)',
    'event NodesTransferred(address indexed fromBeneficiary, address indexed toBeneficiary, uint256[] guardianIds)',
    'event NodeValidatorBeneficiaryUpdated(uint256 indexed guardianId, bytes32 indexed pubkeyHash, address indexed fromBeneficiary, address toBeneficiary)',
    'event ValidatorDeposited(uint256 indexed guardianId, address indexed beneficiary, bytes32 indexed pubkeyHash, uint256 amount)',
    'event FullExitRequested(address indexed beneficiary, uint256[] guardianIds)',
    'event FullExitSettled(address indexed beneficiary, uint256 validatorCount, uint256 amount)',
    'event NodeRewardSettled(uint256 indexed guardianId, address indexed beneficiary, uint256 amount, bytes32 indexed eventKey)',
    // Retired (no longer emitted; kept for back-compat decoding of historical logs).
    'event NodeValidatorExitRequested(address indexed nodeWallet, bytes32 indexed pubkeyHash, address indexed fromBeneficiary, address toBeneficiary)',
];
const VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI = [
    'function REFERRER_NODES_PER_REWARD() view returns (uint256)',
    'function referrerOfBeneficiary(address beneficiary) view returns (address)',
    'function referrerReferralNodeTotal(address referrer) view returns (uint256)',
    'function referrerRewardMilestonePaid(address referrer) view returns (uint256)',
    'function getReferrerReferredBeneficiaryCount(address referrer) view returns (uint256)',
    'function getReferrerReferredBeneficiaries(address referrer, uint256 offset, uint256 limit) view returns (address[])',
    'function getReferrerSummary(address referrer) view returns (uint256 referredBeneficiaryCount, uint256 referralNodeTotal, uint256 rewardMilestonePaid, uint256 pendingRewardNodes, uint256 referredNodesOwnedTotal)',
    'function resolveReferrerDetail(address referrer, uint256 beneficiaryOffset, uint256 beneficiaryLimit) view returns (address[] referredBeneficiaries, uint256 referralNodeTotal, uint256 rewardNodesGranted, uint256 pendingRewardNodes, tuple(uint256 guardianNodeId, address nodeWallet, string depinNodeIp)[] rewardNodes)',
];
/**
 * ValidatorNodeRewardIndexer — standalone per-node / per-beneficiary CNET reward ledger + period stats.
 * All reads here are RPC-direct (no centralized API), per the project RPC-first rule. The relayer write
 * (reportNodeReward) is the only gas-sponsored on-chain action and goes through a Settle wallet.
 */
const VALIDATOR_NODE_REWARD_INDEXER_ABI = [
    'function admins(address account) view returns (bool)',
    'function redeem() view returns (address)',
    'function reportNodeReward(bytes32[] eventKeys, address[] nodeWallets, uint256[] amounts) external returns (uint256 added)',
    'function consumedEventKey(bytes32 key) view returns (bool)',
    'function nodeHourlyReward(address nodeWallet, uint256 hourId) view returns (uint256)',
    'function beneficiaryHourlyReward(address beneficiary, uint256 hourId) view returns (uint256)',
    'function nodeCumulativeReward(address nodeWallet) view returns (uint256)',
    'function beneficiaryCumulativeReward(address beneficiary) view returns (uint256)',
    'function totalCumulativeReward() view returns (uint256)',
    'function nodeFirstHour(address nodeWallet) view returns (uint64)',
    'function nodeLastHour(address nodeWallet) view returns (uint64)',
    'function beneficiaryFirstHour(address beneficiary) view returns (uint64)',
    'function beneficiaryLastHour(address beneficiary) view returns (uint64)',
    'function getNodeRewardBetween(address nodeWallet, uint256 startTs, uint256 endTs) view returns (uint256)',
    'function getBeneficiaryRewardBetween(address beneficiary, uint256 startTs, uint256 endTs) view returns (uint256)',
    'function getNodePeriodReports(address nodeWallet, uint8 periodType, uint256 periods, uint256 anchorTs) view returns (tuple(uint256 periodStart, uint256 periodEnd, uint256 reward)[])',
    'function getBeneficiaryPeriodReports(address beneficiary, uint8 periodType, uint256 periods, uint256 anchorTs) view returns (tuple(uint256 periodStart, uint256 periodEnd, uint256 reward)[])',
    'function getNodeRewardSummary(address nodeWallet, uint256 anchorTs) view returns (uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year)',
    'function getBeneficiaryRewardSummary(address beneficiary, uint256 anchorTs) view returns (uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year)',
    'event NodeRewardReported(address indexed nodeWallet, address indexed beneficiary, uint256 indexed hourId, uint256 amount, uint256 newHourTotal, bytes32 eventKey)',
];
/** Reward indexer period type ids (mirror ValidatorNodeRewardIndexer / AdminStatsPeriodLib). */
exports.REWARD_PERIOD = { HOUR: 0, DAY: 1, WEEK: 2, MONTH: 3, QUARTER: 4, YEAR: 5 };
let cachedConetProvider;
let conetProviderListenerHooksInstalled = false;
function isFilterNotFoundRpcError(e) {
    const err = e;
    const msg = [err?.error?.message, err?.message, err?.shortMessage].filter(Boolean).join(' ');
    return /filter not found/i.test(msg);
}
/** CoNET JSON-RPC for listener + redeem paths; longer timeout + staticNetwork to survive public RPC blips. */
function conetProvider() {
    if (cachedConetProvider)
        return cachedConetProvider;
    const url = (0, util_1.resolveBeamioConetHttpRpcUrl)();
    const fetchReq = new ethers_1.ethers.FetchRequest(url);
    const timeoutMs = Math.max(15_000, Number(process.env.CONET_RPC_HTTP_TIMEOUT_MS || 60_000) || 60_000);
    fetchReq.timeout = timeoutMs;
    const network = ethers_1.ethers.Network.from(chainAddresses_1.CONET_MAINNET_CHAIN_ID);
    const pollingInterval = Math.max(4_000, Number(process.env.CONET_LISTENER_POLLING_MS || 12_000) || 12_000);
    cachedConetProvider = new ethers_1.ethers.JsonRpcProvider(fetchReq, network, {
        staticNetwork: network,
        batchMaxCount: 1,
        pollingInterval,
    });
    return cachedConetProvider;
}
function normalizeIp(raw) {
    return raw.trim().toLowerCase();
}
function isValidIpLike(raw) {
    const ip = normalizeIp(raw);
    if (!ip || ip.length > MAX_IP_BYTES)
        return false;
    if (!/^[a-z0-9.:-]+$/.test(ip))
        return false;
    return true;
}
function codeHashOf(code) {
    return ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(code));
}
const GUARDIAN_NODES_ALLOC_ABI = [
    'function id2ip(uint256 id) view returns (string)',
    'function idOwner(uint256 id) view returns (address)',
    'function ipaddress2owner(string ip) view returns (address)',
    'function ipaddressExisting(string ip) view returns (bool)',
];
function formatEthersRevert(e) {
    const err = e;
    if (typeof err?.reason === 'string' && err.reason.trim())
        return err.reason.trim();
    if (typeof err?.shortMessage === 'string' && err.shortMessage.trim())
        return err.shortMessage.trim();
    if (typeof err?.message === 'string' && err.message.trim())
        return err.message.trim();
    return 'Claim would revert on-chain';
}
/** claimRedeemFor gas scales ~linearly with validatorCount; fixed 1.8M OOGs at 9+ nodes on mainnet. */
function resolveClaimRedeemForGasLimit(validatorCount) {
    const n = Number(validatorCount);
    if (!Number.isFinite(n) || n <= 0)
        return 800_000;
    const estimated = 800_000 + 250_000 * n;
    return Math.min(Math.max(estimated, 1_800_000), 8_000_000);
}
async function resolveClaimRedeemForGasLimitWithEstimate(read, claimer, beneficiary, code, deadline, signature, validatorCount) {
    const fallback = resolveClaimRedeemForGasLimit(validatorCount);
    try {
        const est = (await read.claimRedeemFor.estimateGas(claimer, beneficiary, code, deadline, signature));
        const withBuffer = (est * 120n) / 100n;
        return Number(withBuffer > BigInt(fallback) ? withBuffer : BigInt(fallback));
    }
    catch {
        return fallback;
    }
}
/** Mirrors on-chain guardian allocation checks before claimRedeemFor (RPC-direct). */
async function validatorDepositRedeemClaimAllocationPreflight(beneficiary, validatorCount) {
    const redeemAddr = resolveValidatorDepositRedeemAddress();
    if (!redeemAddr)
        return { ok: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (validatorCount <= 0n)
        return { ok: true };
    const provider = conetProvider();
    const redeem = new ethers_1.ethers.Contract(redeemAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
    const guardian = new ethers_1.ethers.Contract(chainAddresses_1.CONET_GUARDIAN_NODES_INFO_V6, GUARDIAN_NODES_ALLOC_ABI, provider);
    const ben = ethers_1.ethers.getAddress(beneficiary);
    let nextId = (await redeem.nextGuardianAllocId());
    const startId = (await redeem.guardianAllocStartId());
    for (let need = 0n; need < validatorCount; need++) {
        let resolved = false;
        while (!resolved) {
            if (nextId < startId) {
                return { ok: false, error: 'Guardian allocation pool exhausted (before pool start id)' };
            }
            const idOwner = ethers_1.ethers.getAddress((await redeem.guardianIdBeneficiary(nextId)));
            if (idOwner !== ethers_1.ethers.ZeroAddress) {
                nextId++;
                continue;
            }
            const ip = String(await guardian.id2ip(nextId));
            if (!ip || ip.length === 0) {
                return { ok: false, error: `Guardian node id ${nextId.toString()} has no IP` };
            }
            const ipOk = Boolean(await guardian.ipaddressExisting(ip));
            if (!ipOk) {
                return { ok: false, error: `Guardian IP ${ip} is not registered on-chain` };
            }
            let nodeWallet = ethers_1.ethers.getAddress((await guardian.idOwner(nextId)));
            if (nodeWallet === ethers_1.ethers.ZeroAddress) {
                nodeWallet = ethers_1.ethers.getAddress((await guardian.ipaddress2owner(ip)));
            }
            if (nodeWallet === ethers_1.ethers.ZeroAddress) {
                return { ok: false, error: `Guardian node id ${nextId.toString()} has no operator wallet` };
            }
            const walletBen = ethers_1.ethers.getAddress((await redeem.nodeWalletBeneficiary(nodeWallet)));
            if (walletBen !== ethers_1.ethers.ZeroAddress && walletBen.toLowerCase() !== ben.toLowerCase()) {
                return {
                    ok: false,
                    error: 'DePIN operator wallet is already bound to another beneficiary (ValidatorRedeem: node wallet other beneficiary). Redeploy ValidatorDepositRedeem with the shared-operator fix, or claim with the same beneficiary wallet as the prior claim.',
                };
            }
            resolved = true;
            nextId++;
        }
    }
    return { ok: true };
}
function resolveValidatorDepositRedeemAddress() {
    const raw = process.env.CONET_VALIDATOR_DEPOSIT_REDEEM?.trim() || chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM;
    if (!raw)
        return null;
    try {
        const a = ethers_1.ethers.getAddress(raw);
        return a === ethers_1.ethers.ZeroAddress ? null : a;
    }
    catch {
        return null;
    }
}
/** Reads {referrerExtension} from env / chainAddresses, else main redeem contract (RPC-direct). */
async function resolveValidatorReferrerExtensionAddress() {
    const raw = process.env.CONET_VALIDATOR_REFERRER_EXTENSION?.trim() || chainAddresses_1.CONET_VALIDATOR_REFERRER_EXTENSION;
    if (raw) {
        try {
            const a = ethers_1.ethers.getAddress(raw);
            if (a !== ethers_1.ethers.ZeroAddress)
                return a;
        }
        catch {
            /* fall through to on-chain lookup */
        }
    }
    const main = resolveValidatorDepositRedeemAddress();
    if (!main)
        return null;
    try {
        const c = new ethers_1.ethers.Contract(main, ['function referrerExtension() view returns (address)'], conetProvider());
        const ext = ethers_1.ethers.getAddress(String(await c.referrerExtension()));
        return ext === ethers_1.ethers.ZeroAddress ? null : ext;
    }
    catch {
        return null;
    }
}
/**
 * Resolve the ValidatorNodeRewardIndexer address. Prefers the explicit env / chainAddresses value; if unset,
 * reads it on-chain from the main ValidatorDepositRedeem contract's {rewardIndexer} pointer (RPC-direct).
 */
async function resolveValidatorNodeRewardIndexerAddress() {
    const raw = process.env.CONET_VALIDATOR_NODE_REWARD_INDEXER?.trim() || chainAddresses_1.CONET_VALIDATOR_NODE_REWARD_INDEXER;
    if (raw) {
        try {
            const a = ethers_1.ethers.getAddress(raw);
            if (a !== ethers_1.ethers.ZeroAddress)
                return a;
        }
        catch {
            /* fall through to on-chain lookup */
        }
    }
    const main = resolveValidatorDepositRedeemAddress();
    if (!main)
        return null;
    try {
        const c = new ethers_1.ethers.Contract(main, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
        const a = ethers_1.ethers.getAddress(await c.rewardIndexer());
        return a === ethers_1.ethers.ZeroAddress ? null : a;
    }
    catch {
        return null;
    }
}
function incomeTotalsFromTuple(t) {
    return rewardSummaryFromTuple(t);
}
function rewardSummaryFromTuple(t) {
    const v = (k, i) => ((Array.isArray(t) ? t[i] : t[k]) ?? 0n).toString();
    return {
        cumulative: v('cumulative', 0),
        hour: v('hour', 1),
        day: v('day', 2),
        week: v('week', 3),
        month: v('month', 4),
        year: v('year', 5),
    };
}
function rewardPeriodReportsFromTuples(rows) {
    return (rows || []).map((r) => ({
        periodStart: Number(Array.isArray(r) ? r[0] : r.periodStart),
        periodEnd: Number(Array.isArray(r) ? r[1] : r.periodEnd),
        reward: (Array.isArray(r) ? r[2] : r.reward).toString(),
    }));
}
async function rewardIndexerReadContract() {
    const address = await resolveValidatorNodeRewardIndexerAddress();
    if (!address)
        return { ok: false, error: 'ValidatorNodeRewardIndexer not configured' };
    return { ok: true, c: new ethers_1.ethers.Contract(address, VALIDATOR_NODE_REWARD_INDEXER_ABI, conetProvider()), address };
}
/**
 * One-shot CNET reward summary for a BENEFICIARY across ALL its staked nodes (total income):
 * cumulative + current hour/day/week/month/year. RPC-direct, no centralized API.
 * @param anchorTs optional anchor unix seconds (0 / omit = now).
 */
async function validatorRewardReadBeneficiarySummary(beneficiary, anchorTs = 0) {
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(beneficiary);
    }
    catch {
        return { ok: false, error: 'bad beneficiary address' };
    }
    const r = await rewardIndexerReadContract();
    if (!r.ok)
        return r;
    try {
        const t = await r.c.getBeneficiaryRewardSummary(addr, BigInt(anchorTs || 0));
        return { ok: true, beneficiary: addr, summary: rewardSummaryFromTuple(t) };
    }
    catch (ex) {
        return { ok: false, error: `reward summary read failed: ${ex.message}` };
    }
}
/** One-shot CNET reward summary for a single NODE wallet (per-node income). RPC-direct. */
async function validatorRewardReadNodeSummary(nodeWallet, anchorTs = 0) {
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(nodeWallet);
    }
    catch {
        return { ok: false, error: 'bad node wallet address' };
    }
    const r = await rewardIndexerReadContract();
    if (!r.ok)
        return r;
    try {
        const t = await r.c.getNodeRewardSummary(addr, BigInt(anchorTs || 0));
        return { ok: true, nodeWallet: addr, summary: rewardSummaryFromTuple(t) };
    }
    catch (ex) {
        return { ok: false, error: `node reward summary read failed: ${ex.message}` };
    }
}
/**
 * Single eth_call to ValidatorDepositRedeem.resolveUnifiedIncomeStats:
 * beneficiary GB (**legacy ConetGB1155** 18-dec mining accounting) + CNET totals and per-node rows.
 * Wallet/canonical GB balances use GBToken ERC20 — see beamio-gb-erc20-canonical.mdc.
 * Contract internally staticcalls gbToken + rewardIndexer — no centralized read API.
 */
async function validatorDepositRedeemReadUnifiedIncomeStats(ipOrWallet, anchorTs = 0) {
    const main = resolveValidatorDepositRedeemAddress();
    if (!main)
        return { ok: false, error: 'no validator redeem contract configured' };
    const raw = String(ipOrWallet ?? '').trim();
    if (!raw)
        return { ok: false, error: 'empty query' };
    const isAddr = ethers_1.ethers.isAddress(raw);
    const maybeWallet = isAddr ? ethers_1.ethers.getAddress(raw) : ethers_1.ethers.ZeroAddress;
    const ip = isAddr ? '' : normalizeIp(raw);
    try {
        const c = new ethers_1.ethers.Contract(main, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
        const r = await c.resolveUnifiedIncomeStats(maybeWallet, ip, BigInt(Math.max(0, anchorTs)));
        const beneficiaryAddr = ethers_1.ethers.getAddress(String(r.beneficiary ?? r[0]));
        const beneficiary = beneficiaryAddr === ethers_1.ethers.ZeroAddress ? null : beneficiaryAddr;
        const gbBeneficiary = incomeTotalsFromTuple(r.gbBeneficiary ?? r[1]);
        const cnetBeneficiary = incomeTotalsFromTuple(r.cnetBeneficiary ?? r[2]);
        const nodeRows = (r.nodes ?? r[3] ?? []);
        const nodes = nodeRows.map((row) => {
            const nr = row;
            const nArr = row;
            const nGet = (name, idx) => (nr[name] !== undefined ? nr[name] : nArr[idx]);
            return {
                nodeWallet: ethers_1.ethers.getAddress(String(nGet('nodeWallet', 0))),
                depinNodeIp: normalizeIp(String(nGet('depinNodeIp', 1))),
                gb: incomeTotalsFromTuple(nGet('gb', 2)),
                cnet: incomeTotalsFromTuple(nGet('cnet', 3)),
            };
        });
        return { ok: true, query: raw, stats: { beneficiary, gbBeneficiary, cnetBeneficiary, nodes } };
    }
    catch (ex) {
        return { ok: false, error: `resolveUnifiedIncomeStats read failed: ${ex.message}` };
    }
}
function parseReferrerRewardNodeRows(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map((row) => {
        const r = row;
        const get = (name, idx) => r && typeof r === 'object' && !Array.isArray(r) && name in r ? r[name] : r[idx];
        return {
            guardianNodeId: String(get('guardianNodeId', 0) ?? '0'),
            nodeWallet: ethers_1.ethers.getAddress(String(get('nodeWallet', 1))),
            depinNodeIp: normalizeIp(String(get('depinNodeIp', 2) ?? '')),
        };
    });
}
/** RPC-direct referrer detail (extension.resolveReferrerDetail + reward node rows from redeem host). */
async function validatorDepositRedeemReadReferrerDetail(referrer, opts) {
    const ext = await resolveValidatorReferrerExtensionAddress();
    if (!ext)
        return { ok: false, error: 'no validator referrer extension configured' };
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(referrer);
    }
    catch {
        return { ok: false, error: 'bad referrer address' };
    }
    const beneficiaryOffset = Math.max(0, opts?.beneficiaryOffset ?? 0);
    const beneficiaryLimit = Math.max(0, opts?.beneficiaryLimit ?? 0);
    try {
        const c = new ethers_1.ethers.Contract(ext, VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI, conetProvider());
        const [detail, nodesPerReward] = await Promise.all([
            c.resolveReferrerDetail(addr, BigInt(beneficiaryOffset), BigInt(beneficiaryLimit)),
            c.REFERRER_NODES_PER_REWARD(),
        ]);
        return {
            ok: true,
            detail: {
                referrer: addr,
                referredBeneficiaries: (detail[0] ?? []).map((a) => ethers_1.ethers.getAddress(a)),
                referralNodeTotal: detail[1].toString(),
                rewardNodesGranted: detail[2].toString(),
                pendingRewardNodes: detail[3].toString(),
                nodesPerReward: nodesPerReward.toString(),
                rewardNodes: parseReferrerRewardNodeRows(detail[4]),
            },
        };
    }
    catch (ex) {
        return { ok: false, error: `referrer detail read failed: ${ex.message}` };
    }
}
/** RPC-direct referrer dashboard (introduced wallets + node totals + reward progress). */
async function validatorDepositRedeemReadReferrerSummary(referrer) {
    const ext = await resolveValidatorReferrerExtensionAddress();
    if (!ext)
        return { ok: false, error: 'no validator referrer extension configured' };
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(referrer);
    }
    catch {
        return { ok: false, error: 'bad referrer address' };
    }
    try {
        const c = new ethers_1.ethers.Contract(ext, VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI, conetProvider());
        const [summaryTuple, nodesPerReward] = await Promise.all([c.getReferrerSummary(addr), c.REFERRER_NODES_PER_REWARD()]);
        const s = summaryTuple;
        return {
            ok: true,
            summary: {
                referrer: addr,
                referredBeneficiaryCount: s[0].toString(),
                referralNodeTotal: s[1].toString(),
                rewardMilestonePaid: s[2].toString(),
                pendingRewardNodes: s[3].toString(),
                referredNodesOwnedTotal: s[4].toString(),
                nodesPerReward: nodesPerReward.toString(),
            },
        };
    }
    catch (ex) {
        return { ok: false, error: `referrer summary read failed: ${ex.message}` };
    }
}
async function validatorDepositRedeemReadReferrerReferredBeneficiaries(referrer, offset = 0, limit = 50) {
    const ext = await resolveValidatorReferrerExtensionAddress();
    if (!ext)
        return { ok: false, error: 'no validator referrer extension configured' };
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(referrer);
    }
    catch {
        return { ok: false, error: 'bad referrer address' };
    }
    try {
        const c = new ethers_1.ethers.Contract(ext, VALIDATOR_DEPOSIT_REDEEM_REFERRER_ABI, conetProvider());
        const rows = (await c.getReferrerReferredBeneficiaries(addr, BigInt(offset), BigInt(limit)));
        return { ok: true, beneficiaries: rows.map((a) => ethers_1.ethers.getAddress(a)) };
    }
    catch (ex) {
        return { ok: false, error: `referrer beneficiaries read failed: ${ex.message}` };
    }
}
/**
 * Beneficiary total income + a per-node breakdown in one call: resolves the beneficiary's node bundle from the
 * main contract, then fetches each node's CNET summary plus the beneficiary aggregate. RPC-direct.
 * @deprecated Prefer {validatorDepositRedeemReadUnifiedIncomeStats} for GB + CNET in one eth_call.
 */
async function validatorRewardReadBeneficiaryWithNodes(beneficiary, anchorTs = 0) {
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(beneficiary);
    }
    catch {
        return { ok: false, error: 'bad beneficiary address' };
    }
    const main = resolveValidatorDepositRedeemAddress();
    if (!main)
        return { ok: false, error: 'no validator redeem contract configured' };
    const r = await rewardIndexerReadContract();
    if (!r.ok)
        return r;
    try {
        const cMain = new ethers_1.ethers.Contract(main, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
        const bundle = await cMain.getBeneficiaryNodeBundle(addr);
        const wallets = bundle.nodeWallets || [];
        const ips = bundle.depinNodeIps || [];
        const anchor = BigInt(anchorTs || 0);
        const total = rewardSummaryFromTuple(await r.c.getBeneficiaryRewardSummary(addr, anchor));
        const nodes = await Promise.all(wallets.map(async (w, i) => {
            const nodeWallet = ethers_1.ethers.getAddress(w);
            const summary = rewardSummaryFromTuple(await r.c.getNodeRewardSummary(nodeWallet, anchor));
            return { nodeWallet, depinNodeIp: normalizeIp(ips[i] || ''), summary };
        }));
        return { ok: true, beneficiary: addr, total, nodes };
    }
    catch (ex) {
        return { ok: false, error: `beneficiary reward breakdown read failed: ${ex.message}` };
    }
}
/** Period (hour/day/week/month/quarter/year) CNET reward series for a NODE, newest first. RPC-direct. */
async function validatorRewardReadNodePeriods(nodeWallet, periodType, periods, anchorTs = 0) {
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(nodeWallet);
    }
    catch {
        return { ok: false, error: 'bad node wallet address' };
    }
    const r = await rewardIndexerReadContract();
    if (!r.ok)
        return r;
    try {
        const rows = await r.c.getNodePeriodReports(addr, periodType, BigInt(periods), BigInt(anchorTs || 0));
        return { ok: true, nodeWallet: addr, reports: rewardPeriodReportsFromTuples(rows) };
    }
    catch (ex) {
        return { ok: false, error: `node period reports read failed: ${ex.message}` };
    }
}
/** Period CNET reward series for a BENEFICIARY (all nodes aggregated), newest first. RPC-direct. */
async function validatorRewardReadBeneficiaryPeriods(beneficiary, periodType, periods, anchorTs = 0) {
    let addr;
    try {
        addr = ethers_1.ethers.getAddress(beneficiary);
    }
    catch {
        return { ok: false, error: 'bad beneficiary address' };
    }
    const r = await rewardIndexerReadContract();
    if (!r.ok)
        return r;
    try {
        const rows = await r.c.getBeneficiaryPeriodReports(addr, periodType, BigInt(periods), BigInt(anchorTs || 0));
        return { ok: true, beneficiary: addr, reports: rewardPeriodReportsFromTuples(rows) };
    }
    catch (ex) {
        return { ok: false, error: `beneficiary period reports read failed: ${ex.message}` };
    }
}
/**
 * Relayer write: accumulate measured CNET reward into the indexer (BeamioIndexerDiamond-style: contract
 * buckets by block.timestamp/3600). Only a redeem admin in {Settle_ContractPool} pays CNET gas; MOVES NO FUNDS.
 * Each entry carries a unique {eventKey} for on-chain idempotency (listener restart / retry safe).
 */
async function validatorRewardReport(entries) {
    if (!entries.length)
        return { ok: false, error: 'empty entries' };
    const address = await resolveValidatorNodeRewardIndexerAddress();
    if (!address)
        return { ok: false, error: 'ValidatorNodeRewardIndexer not configured' };
    if (!(0, settleContractPool_1.hasIdleSettleConet)())
        return { ok: false, error: 'no relayer wallet available (Settle pool empty)' };
    let eventKeys;
    let nodeWallets;
    let amounts;
    try {
        eventKeys = entries.map((e) => {
            const key = String(e.eventKey).trim();
            if (!key || key === ethers_1.ethers.ZeroHash)
                throw new Error('zero eventKey');
            return key;
        });
        nodeWallets = entries.map((e) => ethers_1.ethers.getAddress(e.nodeWallet));
        amounts = entries.map((e) => BigInt(e.amount));
    }
    catch (ex) {
        return { ok: false, error: `bad entry: ${ex.message}` };
    }
    const txResult = await withSettleWallet('validatorRewardReport', async (sc) => {
        const c = new ethers_1.ethers.Contract(address, VALIDATOR_NODE_REWARD_INDEXER_ABI, sc.walletConet);
        let added = entries.length;
        try {
            added = Number(await c.reportNodeReward.staticCall(eventKeys, nodeWallets, amounts));
        }
        catch {
            // fall back to batch size when staticCall unavailable
        }
        const tx = await c.reportNodeReward(eventKeys, nodeWallets, amounts, { gasLimit: 4_000_000 });
        await tx.wait();
        return { hash: tx.hash, added };
    });
    if (!txResult)
        return { ok: false, error: 'relayer submit failed' };
    return { ok: true, txHash: txResult.hash, count: entries.length, added: txResult.added };
}
function resolveValidatorNodeIp() {
    return normalizeIp(process.env.CONET_VALIDATOR_NODE_IP?.trim() ||
        util_1.masterSetup.validatorDeposit?.nodeIp?.trim() ||
        chainAddresses_1.CONET_VALIDATOR_NODE_IP ||
        '');
}
function resolveNewCoNETDir() {
    return process.env.CONET_VALIDATOR_NEWCONET_DIR?.trim() || util_1.masterSetup.validatorDeposit?.newCoNETDir?.trim() || DEFAULT_NEW_CONET_DIR;
}
function resolveStateFile() {
    return (process.env.CONET_VALIDATOR_REDEEM_STATE_FILE?.trim() ||
        util_1.masterSetup.validatorDeposit?.stateFile?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-validator-redeem-state.json'));
}
function resolveDepositPrivateKeyFile() {
    return (process.env.CONET_VALIDATOR_REDEEM_ADMIN_PRIVATE_KEY_FILE?.trim() ||
        process.env.CONET_VALIDATOR_DEPOSIT_PRIVATE_KEY_FILE?.trim() ||
        util_1.masterSetup.validatorDeposit?.privateKeyFile?.trim() ||
        '');
}
/** Prysm validator keystore password — same value used by deposit CLI on this node. */
function resolveKeystorePasswordFile() {
    return (process.env.CONET_VALIDATOR_KEYSTORE_PASSWORD_FILE?.trim() ||
        node_path_1.default.join(resolveNewCoNETDir(), 'secrets/validator_keystore_password.txt'));
}
function resolveKeystorePassword() {
    const inline = process.env.KEYSTORE_PASSWORD?.trim();
    if (inline)
        return inline;
    const file = resolveKeystorePasswordFile();
    if (file && node_fs_1.default.existsSync(file)) {
        return node_fs_1.default.readFileSync(file, 'utf8').trim();
    }
    return '';
}
/** Prysm wallet password (distinct from validator keystore password on some nodes). */
function resolveWalletPasswordFile() {
    return (process.env.CONET_VALIDATOR_WALLET_PASSWORD_FILE?.trim() ||
        node_path_1.default.join(resolveNewCoNETDir(), 'secrets/prysm_wallet_password.txt'));
}
function resolveWalletPassword() {
    const inline = process.env.WALLET_PASSWORD?.trim();
    if (inline)
        return inline;
    const file = resolveWalletPasswordFile();
    if (file && node_fs_1.default.existsSync(file)) {
        return node_fs_1.default.readFileSync(file, 'utf8').trim();
    }
    return '';
}
function allowedRedeemAdminAddresses() {
    const fromEnv = (process.env.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMINS || '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => ethers_1.ethers.isAddress(s))
        .map((s) => ethers_1.ethers.getAddress(s));
    const defaults = [
        chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN,
        chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN_LEGACY,
    ]
        .filter((s) => ethers_1.ethers.isAddress(s))
        .map((s) => ethers_1.ethers.getAddress(s));
    return [...new Set([...defaults, ...fromEnv].map((a) => a.toLowerCase()))];
}
/** Prefer API-host `~/.master.json` `GenesisNode` (Genesis Seat fulfill); else private key file (validator node deposit). */
function loadRedeemAdminWallet() {
    const provider = conetProvider();
    const allowed = allowedRedeemAdminAddresses();
    const assertAllowed = (wallet, source) => {
        if (!allowed.includes(wallet.address.toLowerCase())) {
            throw new Error(`redeem admin key mismatch (${source}): got ${wallet.address}, allowed ${allowed.join(', ')}`);
        }
        return wallet;
    };
    const genesisRaw = String(util_1.masterSetup.GenesisNode ?? '').trim();
    if (genesisRaw) {
        const pk = genesisRaw.startsWith('0x') ? genesisRaw : `0x${genesisRaw}`;
        return assertAllowed(new ethers_1.ethers.Wallet(pk, provider), 'master.json GenesisNode');
    }
    const file = resolveDepositPrivateKeyFile();
    if (!file || !node_fs_1.default.existsSync(file)) {
        throw new Error('GenesisNode missing in ~/.master.json and CONET_VALIDATOR_REDEEM_ADMIN_PRIVATE_KEY_FILE (or CONET_VALIDATOR_DEPOSIT_PRIVATE_KEY_FILE) missing');
    }
    const raw = node_fs_1.default.readFileSync(file, 'utf8').trim();
    const pk = raw.startsWith('0x') ? raw : `0x${raw}`;
    return assertAllowed(new ethers_1.ethers.Wallet(pk, provider), `file ${file}`);
}
function validatorDryRun() {
    const env = process.env.CONET_VALIDATOR_REDEEM_DRY_RUN?.trim().toLowerCase();
    if (env === '1' || env === 'true' || env === 'yes')
        return true;
    if (env === '0' || env === 'false' || env === 'no')
        return false;
    return Boolean(util_1.masterSetup.validatorDeposit?.dryRun);
}
function readStateFile() {
    const file = resolveStateFile();
    if (!node_fs_1.default.existsSync(file))
        return {};
    try {
        return JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeStateFile(state) {
    const file = resolveStateFile();
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}
function resolveListenerBlockFile() {
    return (process.env.CONET_VALIDATOR_REDEEM_LISTENER_BLOCK_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-validator-redeem-listener-block.json'));
}
function loadListenerBlockCheckpoint(contract, deployFloor) {
    const raw = readListenerBlockCheckpointRaw(contract, deployFloor);
    return raw?.lastProcessedBlock ?? null;
}
function normalizeListenerScanTargetBlock(raw) {
    if (raw == null)
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
function writeListenerCheckpointFile(payload) {
    const file = resolveListenerBlockFile();
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}
function readListenerBlockCheckpointRaw(contract, deployFloor) {
    const file = resolveListenerBlockFile();
    if (!node_fs_1.default.existsSync(file))
        return null;
    try {
        const raw = JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
        if (!raw?.contractAddress || typeof raw.lastProcessedBlock !== 'number')
            return null;
        if (ethers_1.ethers.getAddress(raw.contractAddress).toLowerCase() !== ethers_1.ethers.getAddress(contract).toLowerCase()) {
            return null;
        }
        const block = Math.floor(raw.lastProcessedBlock);
        if (block < deployFloor) {
            (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListener] ignore checkpoint block ${block} < deployFloor ${deployFloor}`));
            return null;
        }
        return {
            contractAddress: ethers_1.ethers.getAddress(raw.contractAddress),
            lastProcessedBlock: block,
            scanTargetBlock: normalizeListenerScanTargetBlock(raw.scanTargetBlock),
            updatedAt: raw.updatedAt ?? new Date().toISOString(),
        };
    }
    catch {
        return null;
    }
}
/** Persist catch-up ceiling (requires existing checkpoint). See beamio-chain-listener-block-scan-ceiling.mdc */
function saveListenerScanTargetBlock(contract, scanTargetBlock, opts) {
    const deployFloor = resolveListenerDeployBlockFloor();
    const target = Math.max(deployFloor, Math.floor(scanTargetBlock));
    const raw = readListenerBlockCheckpointRaw(contract, deployFloor);
    if (!raw) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListener] scanTargetBlock=${target} not persisted (no checkpoint yet)`));
        return;
    }
    const caughtUp = raw.scanTargetBlock == null || raw.lastProcessedBlock >= (raw.scanTargetBlock ?? raw.lastProcessedBlock);
    const finalTarget = opts?.force || caughtUp ? target : (raw.scanTargetBlock ?? target);
    writeListenerCheckpointFile({
        ...raw,
        scanTargetBlock: finalTarget,
        updatedAt: new Date().toISOString(),
    });
}
function saveListenerBlockCheckpoint(contract, blockNumber) {
    const deployFloor = resolveListenerDeployBlockFloor();
    const block = Math.floor(blockNumber);
    if (block < deployFloor)
        return;
    const prev = loadListenerBlockCheckpoint(contract, deployFloor);
    if (prev != null && block <= prev)
        return;
    const raw = readListenerBlockCheckpointRaw(contract, deployFloor);
    const payload = {
        contractAddress: ethers_1.ethers.getAddress(contract),
        lastProcessedBlock: block,
        scanTargetBlock: raw?.scanTargetBlock,
        updatedAt: new Date().toISOString(),
    };
    writeListenerCheckpointFile(payload);
}
function noteListenerBlock(contract, blockNumber) {
    if (!Number.isFinite(blockNumber) || blockNumber < 0)
        return;
    saveListenerBlockCheckpoint(contract, blockNumber);
}
/** Hard minimum block for eth_getLogs — never scan below ValidatorDepositRedeem deploy block. */
function resolveListenerDeployBlockFloor() {
    const env = process.env.CONET_VALIDATOR_REDEEM_LISTENER_DEPLOY_BLOCK?.trim() ||
        process.env.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK?.trim();
    if (env) {
        const n = Number(env);
        if (Number.isFinite(n) && n >= 0)
            return Math.floor(n);
        throw new Error(`invalid CONET_VALIDATOR_REDEEM_LISTENER_DEPLOY_BLOCK: ${env}`);
    }
    return chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM_DEPLOY_BLOCK;
}
/** Safety clamp when issuing getLogs only — routine resume cursor stays at last checkpoint + 1. */
function listenerBackfillFromBlock(requestedFrom, deployFloor) {
    const from = Math.floor(requestedFrom);
    if (from < deployFloor) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListener] backfill safety clamp ${from} -> ${deployFloor} (deploy floor)`));
        return deployFloor;
    }
    return from;
}
function resolveListenerLogChunk() {
    const n = Number(process.env.CONET_VALIDATOR_REDEEM_LISTENER_LOG_CHUNK || 2000);
    return Number.isFinite(n) && n >= 1 ? Math.min(10_000, Math.floor(n)) : 2000;
}
/** Max eth_getLogs chunks per incremental backfill tick (default 1). See beamio-chain-listener-block-scan-ceiling.mdc */
function resolveListenerBackfillChunksPerTick() {
    const n = Number(process.env.CONET_VALIDATOR_REDEEM_LISTENER_BACKFILL_CHUNKS_PER_TICK || 1);
    return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 1;
}
function upsertState(requestId, update) {
    const all = readStateFile();
    const next = update(all[requestId]);
    all[requestId] = next;
    writeStateFile(all);
    return next;
}
function getValidatorDepositRedeemStatus(requestId) {
    if (!ethers_1.ethers.isHexString(requestId, 32))
        return null;
    return readStateFile()[requestId.toLowerCase()] || null;
}
function validatorDepositRedeemConfig() {
    const contract = resolveValidatorDepositRedeemAddress();
    const nodeIp = resolveValidatorNodeIp();
    const privateKeyFile = resolveDepositPrivateKeyFile();
    return {
        success: true,
        version: VALIDATOR_REDEEM_VERSION,
        chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
        contract,
        nodeIp,
        depositContract: chainAddresses_1.CONET_DEPOSIT_CONTRACT,
        depositFunder: chainAddresses_1.CONET_VALIDATOR_DEPOSIT_FUNDER,
        contractAdminAddress: chainAddresses_1.CONET_VALIDATOR_DEPOSIT_CONTRACT_ADMIN,
        redeemAdminAddress: chainAddresses_1.CONET_VALIDATOR_DEPOSIT_REDEEM_ADMIN,
        depositMode: 'contract_balance_fundAndDepositValidators',
        newCoNETDir: resolveNewCoNETDir(),
        stateFile: resolveStateFile(),
        listenerBlockFile: resolveListenerBlockFile(),
        listenerDeployBlockFloor: resolveListenerDeployBlockFloor(),
        listenerLastProcessedBlock: contract ? loadListenerBlockCheckpoint(contract, resolveListenerDeployBlockFloor()) : null,
        dryRun: validatorDryRun(),
        depositPrivateKeyFileConfigured: Boolean(privateKeyFile),
        listenerEnabled: process.env.CONET_VALIDATOR_REDEEM_LISTENER === '1',
    };
}
function validatorDepositRedeemEip712Domain(verifyingContract) {
    return {
        name: 'ValidatorDepositRedeem',
        version: '1',
        chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
        verifyingContract: ethers_1.ethers.getAddress(verifyingContract),
    };
}
exports.validatorDepositRedeemCreateTypes = {
    CreateRedeem: [
        { name: 'admin', type: 'address' },
        { name: 'codeHash', type: 'bytes32' },
        { name: 'allowedClaimer', type: 'address' },
        { name: 'referrer', type: 'address' },
        { name: 'validatorCount', type: 'uint256' },
        { name: 'targetNodeIp', type: 'string' },
        { name: 'gbMiningNodeCount', type: 'uint256' },
        { name: 'airdrop', type: 'bool' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
// ClaimAirdrop: signed by the beneficiary; relayed via {claimAirdropFor} (gas-sponsored). Must stay byte-identical
// to ValidatorDepositRedeemStatsLib.CLAIM_AIRDROP_TYPEHASH.
exports.validatorDepositRedeemClaimAirdropTypes = {
    ClaimAirdrop: [
        { name: 'beneficiary', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
exports.validatorDepositRedeemCancelTypes = {
    CancelRedeem: [
        { name: 'admin', type: 'address' },
        { name: 'codeHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
exports.validatorDepositRedeemClaimTypes = {
    ClaimRedeem: [
        { name: 'claimer', type: 'address' },
        { name: 'codeHash', type: 'bytes32' },
        { name: 'beneficiary', type: 'address' },
        { name: 'referrer', type: 'address' },
        { name: 'validatorCount', type: 'uint256' },
        { name: 'targetNodeIp', type: 'string' },
        { name: 'gbMiningNodeCount', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
exports.validatorDepositRedeemTransferTypes = {
    TransferNodes: [
        { name: 'fromBeneficiary', type: 'address' },
        { name: 'toBeneficiary', type: 'address' },
        { name: 'guardianIds', type: 'uint256[]' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
exports.validatorCreateTransferOrderTypes = {
    CreateTransferOrder: [
        { name: 'seller', type: 'address' },
        { name: 'guardianIds', type: 'uint256[]' },
        { name: 'priceUsdc6', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
exports.validatorCancelTransferOrderTypes = {
    CancelTransferOrder: [
        { name: 'seller', type: 'address' },
        { name: 'orderId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
exports.validatorFulfillTransferOrderTypes = {
    FulfillTransferOrder: [
        { name: 'buyer', type: 'address' },
        { name: 'orderId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
/** CoNET-USDC（FactoryERC20 / EIP20Permit3009）EIP-3009 TransferWithAuthorization typed data. */
exports.usdcTransferWithAuthorizationTypes = {
    TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
async function validatorDepositRedeemReadAdminNonce(adminAddress) {
    const addr = resolveValidatorDepositRedeemAddress();
    if (!addr)
        return { ok: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!ethers_1.ethers.isAddress(adminAddress))
        return { ok: false, error: 'Invalid admin' };
    const c = new ethers_1.ethers.Contract(addr, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    try {
        const n = await c.redeemAdminNonces(ethers_1.ethers.getAddress(adminAddress));
        return { ok: true, nonce: n.toString() };
    }
    catch (e) {
        return { ok: false, error: e?.shortMessage ?? e?.message ?? 'redeemAdminNonces failed' };
    }
}
// NOTE: 链上「节点档案 / 受益人反查」读路径已下沉到各客户端，直连 RPC（见 beamio-rpc-first-no-centralized-api.mdc）。
// 参考客户端实现：src/SilentPassUI/src/services/validatorWalletNodeProfile.ts（fetchValidatorWalletNodeProfile / fetchNodeBeneficiaryProfile）。
// x402sdk 仅保留「代付 gas 的链上写」路径（createRedeemFor / claimRedeemFor relay 等）。
function parseUintField(name, value) {
    try {
        const n = BigInt(String(value ?? ''));
        if (n < 0n)
            return `${name} must be non-negative`;
        return n;
    }
    catch {
        return `Invalid ${name}`;
    }
}
/** Cluster must reject expired EIP-712 deadlines before Master relay (matches on-chain `block.timestamp <= deadline`). */
function clusterRejectIfSignatureDeadlineExpired(deadline) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadline < now)
        return { success: false, error: 'Signature expired' };
    return null;
}
async function validatorDepositRedeemCreateClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.admin || !ethers_1.ethers.isAddress(body.admin))
        return { success: false, error: 'Invalid admin' };
    const admin = ethers_1.ethers.getAddress(body.admin);
    const codeHash = typeof body.codeHash === 'string' && ethers_1.ethers.isHexString(body.codeHash, 32) ? body.codeHash : '';
    if (!codeHash)
        return { success: false, error: 'Invalid codeHash' };
    const allowedClaimer = typeof body.allowedClaimer === 'string' && body.allowedClaimer.trim()
        ? ethers_1.ethers.getAddress(body.allowedClaimer)
        : ethers_1.ethers.ZeroAddress;
    let referrer = ethers_1.ethers.ZeroAddress;
    if (typeof body.referrer === 'string' && body.referrer.trim()) {
        if (!ethers_1.ethers.isAddress(body.referrer))
            return { success: false, error: 'Invalid referrer' };
        referrer = ethers_1.ethers.getAddress(body.referrer);
    }
    const validatorCount = parseUintField('validatorCount', body.validatorCount);
    if (typeof validatorCount === 'string' || validatorCount <= 0n)
        return { success: false, error: typeof validatorCount === 'string' ? validatorCount : 'validatorCount must be positive' };
    const targetNodeIp = normalizeIp(body.targetNodeIp || resolveValidatorNodeIp() || '');
    if (!isValidIpLike(targetNodeIp))
        return { success: false, error: 'Invalid targetNodeIp (set body.targetNodeIp or CONET_VALIDATOR_NODE_IP)' };
    // All redeems auto-allocate Guardian nodes at claim time; no manual DePIN IP list is accepted.
    const gbMiningNodeCount = parseUintField('gbMiningNodeCount', body.gbMiningNodeCount ?? validatorCount.toString());
    if (typeof gbMiningNodeCount === 'string')
        return { success: false, error: gbMiningNodeCount };
    const airdrop = body.airdrop === true || body.airdrop === 'true' || body.airdrop === 1 || body.airdrop === '1';
    const validAfter = parseUintField('validAfter', body.validAfter ?? '0');
    const validBefore = parseUintField('validBefore', body.validBefore ?? '0');
    const nonce = parseUintField('nonce', body.nonce);
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof validAfter === 'string' || typeof validBefore === 'string' || typeof nonce === 'string' || typeof deadline === 'string') {
        return { success: false, error: 'Invalid time or nonce fields' };
    }
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const [isAdmin, chainNonce, referrerExt] = await Promise.all([
        read.redeemAdmins(admin),
        read.redeemAdminNonces(admin),
        referrer !== ethers_1.ethers.ZeroAddress ? read.referrerExtension() : Promise.resolve(ethers_1.ethers.ZeroAddress),
    ]);
    if (!isAdmin)
        return { success: false, error: 'Not a redeem admin' };
    if (chainNonce !== nonce)
        return { success: false, error: 'Stale nonce; refresh and sign again' };
    const expiredCreate = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expiredCreate)
        return expiredCreate;
    if (referrer !== ethers_1.ethers.ZeroAddress && ethers_1.ethers.getAddress(String(referrerExt)) === ethers_1.ethers.ZeroAddress) {
        return { success: false, error: 'Referrer extension not configured on chain' };
    }
    const message = {
        admin,
        codeHash,
        allowedClaimer,
        referrer,
        validatorCount,
        targetNodeIp,
        gbMiningNodeCount,
        airdrop,
        validAfter,
        validBefore,
        nonce,
        deadline,
    };
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorDepositRedeemCreateTypes, message, signature);
    if (recovered.toLowerCase() !== admin.toLowerCase()) {
        return {
            success: false,
            error: `EIP-712 signer (${recovered}) does not match admin (${admin}). Sign with the redeem-admin wallet.`,
        };
    }
    return { success: true, preChecked: { contract, ...message, signature } };
}
async function validatorDepositRedeemCancelClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.admin || !ethers_1.ethers.isAddress(body.admin))
        return { success: false, error: 'Invalid admin' };
    const admin = ethers_1.ethers.getAddress(body.admin);
    const codeHash = typeof body.codeHash === 'string' && ethers_1.ethers.isHexString(body.codeHash, 32) ? body.codeHash : '';
    if (!codeHash)
        return { success: false, error: 'Invalid codeHash' };
    const nonce = parseUintField('nonce', body.nonce);
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof nonce === 'string' || typeof deadline === 'string')
        return { success: false, error: 'Invalid nonce or deadline' };
    const expiredCancel = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expiredCancel)
        return expiredCancel;
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const [isAdmin, chainNonce] = await Promise.all([read.redeemAdmins(admin), read.redeemAdminNonces(admin)]);
    if (!isAdmin)
        return { success: false, error: 'Not a redeem admin' };
    if (chainNonce !== nonce)
        return { success: false, error: 'Stale nonce; refresh and sign again' };
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorDepositRedeemCancelTypes, { admin, codeHash, nonce, deadline }, signature);
    if (recovered.toLowerCase() !== admin.toLowerCase()) {
        return {
            success: false,
            error: `EIP-712 signer (${recovered}) does not match admin (${admin}). Sign with the redeem-admin wallet.`,
        };
    }
    return { success: true, preChecked: { contract, admin, codeHash, nonce, deadline, signature } };
}
async function validatorDepositRedeemClaimClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.claimer || !ethers_1.ethers.isAddress(body.claimer))
        return { success: false, error: 'Invalid claimer' };
    if (!body.beneficiary || !ethers_1.ethers.isAddress(body.beneficiary))
        return { success: false, error: 'Invalid beneficiary' };
    const claimer = ethers_1.ethers.getAddress(body.claimer);
    const beneficiary = ethers_1.ethers.getAddress(body.beneficiary);
    const code = typeof body.code === 'string' ? body.code : '';
    if (!code || ethers_1.ethers.toUtf8Bytes(code).length > MAX_REDEEM_CODE_BYTES)
        return { success: false, error: 'Invalid code' };
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof deadline === 'string')
        return { success: false, error: deadline };
    const expiredClaim = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expiredClaim)
        return expiredClaim;
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    const codeHash = codeHashOf(code);
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const redeem = await read.getRedeem(codeHash);
    const allowedClaimer = ethers_1.ethers.getAddress(redeem[0]);
    const referrer = ethers_1.ethers.getAddress(redeem[1]);
    const validatorCount = redeem[2];
    const targetNodeIp = normalizeIp(redeem[3]);
    const gbMiningNodeCount = redeem[4];
    const active = Boolean(redeem[7]);
    const consumed = Boolean(redeem[8]);
    if (!active || consumed)
        return { success: false, error: 'Redeem not active' };
    if (allowedClaimer !== ethers_1.ethers.ZeroAddress && allowedClaimer.toLowerCase() !== claimer.toLowerCase()) {
        return { success: false, error: 'Claimer not allowed' };
    }
    if (referrer !== ethers_1.ethers.ZeroAddress && referrer.toLowerCase() === beneficiary.toLowerCase()) {
        return { success: false, error: 'Referrer cannot equal beneficiary' };
    }
    // DePIN node IPs are auto-allocated from Guardian on-chain at claim; nothing to verify here.
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorDepositRedeemClaimTypes, {
        claimer,
        codeHash,
        beneficiary,
        referrer,
        validatorCount,
        targetNodeIp,
        gbMiningNodeCount,
        deadline,
    }, signature);
    if (recovered.toLowerCase() !== claimer.toLowerCase())
        return { success: false, error: 'Signer is not claimer' };
    const alloc = await validatorDepositRedeemClaimAllocationPreflight(beneficiary, validatorCount);
    if (!alloc.ok)
        return { success: false, error: alloc.error };
    const gasLimit = await resolveClaimRedeemForGasLimitWithEstimate(read, claimer, beneficiary, code, deadline, signature, validatorCount);
    try {
        await read.claimRedeemFor.staticCall(claimer, beneficiary, code, deadline, signature, { gasLimit });
    }
    catch (e) {
        return { success: false, error: formatEthersRevert(e) };
    }
    return {
        success: true,
        preChecked: { contract, claimer, beneficiary, referrer, code, deadline, signature, gasLimit },
    };
}
/** Read-only: same secret may also be an active ValidatorDepositRedeem (Institutional Pack dual registration). */
async function probeLinkedValidatorDepositRedeemByCode(code) {
    const trimmed = typeof code === 'string' ? code.trim() : '';
    if (!trimmed)
        return { redeemable: false, error: 'Invalid code' };
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { redeemable: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    const codeHash = codeHashOf(trimmed);
    try {
        const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
        const redeem = await read.getRedeem(codeHash);
        const active = Boolean(redeem[7]);
        const consumed = Boolean(redeem[8]);
        return { redeemable: active && !consumed, codeHash };
    }
    catch (e) {
        const err = e;
        return { redeemable: false, codeHash, error: err?.shortMessage ?? err?.message ?? 'getRedeem failed' };
    }
}
/**
 * Cluster pre-check for the gas-sponsored airdrop claim. The beneficiary signs EIP-712 {ClaimAirdrop}; we verify the
 * signature, nonce (beneficiaryNonces), deadline, claim-open time and that `amount` does not exceed the on-chain
 * claimable balance, then static-call {claimAirdropFor} so master relay never reverts on a valid pre-check.
 */
async function validatorDepositRedeemClaimAirdropClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.beneficiary || !ethers_1.ethers.isAddress(body.beneficiary))
        return { success: false, error: 'Invalid beneficiary' };
    const beneficiary = ethers_1.ethers.getAddress(body.beneficiary);
    const amount = parseUintField('amount', body.amount);
    if (typeof amount === 'string' || amount <= 0n)
        return { success: false, error: typeof amount === 'string' ? amount : 'amount must be positive' };
    const nonce = parseUintField('nonce', body.nonce);
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof nonce === 'string' || typeof deadline === 'string')
        return { success: false, error: 'Invalid nonce or deadline' };
    const expired = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expired)
        return expired;
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const [chainNonce, info] = await Promise.all([read.beneficiaryNonces(beneficiary), read.airdropInfoOf(beneficiary)]);
    if (chainNonce !== nonce)
        return { success: false, error: 'Stale nonce; refresh and sign again' };
    const claimable = info[2];
    const claimableAt = info[3];
    if (claimableAt === 0n || BigInt(Math.floor(Date.now() / 1000)) < claimableAt)
        return { success: false, error: 'Airdrop claim not open yet' };
    if (amount > claimable)
        return { success: false, error: 'Amount exceeds claimable airdrop' };
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorDepositRedeemClaimAirdropTypes, { beneficiary, amount, nonce, deadline }, signature);
    if (recovered.toLowerCase() !== beneficiary.toLowerCase())
        return { success: false, error: 'Signer is not beneficiary' };
    try {
        await read.claimAirdropFor.staticCall(beneficiary, amount, nonce, deadline, signature);
    }
    catch (e) {
        return { success: false, error: formatEthersRevert(e) };
    }
    return { success: true, preChecked: { contract, beneficiary, amount, nonce, deadline, signature } };
}
function parseGuardianIdArray(value) {
    if (!Array.isArray(value) || value.length === 0)
        return 'Empty guardianIds';
    const out = [];
    for (const v of value) {
        try {
            const n = BigInt(String(v));
            if (n <= 0n)
                return 'Invalid guardianId (must be > 0)';
            out.push(n);
        }
        catch {
            return 'Invalid guardianIds';
        }
    }
    return out;
}
async function validatorDepositRedeemTransferClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.fromBeneficiary || !ethers_1.ethers.isAddress(body.fromBeneficiary))
        return { success: false, error: 'Invalid fromBeneficiary' };
    if (!body.toBeneficiary || !ethers_1.ethers.isAddress(body.toBeneficiary))
        return { success: false, error: 'Invalid toBeneficiary' };
    const fromBeneficiary = ethers_1.ethers.getAddress(body.fromBeneficiary);
    const toBeneficiary = ethers_1.ethers.getAddress(body.toBeneficiary);
    if (fromBeneficiary.toLowerCase() === toBeneficiary.toLowerCase())
        return { success: false, error: 'Same beneficiary' };
    const guardianIds = parseGuardianIdArray(body.guardianIds);
    if (typeof guardianIds === 'string')
        return { success: false, error: guardianIds };
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof deadline === 'string')
        return { success: false, error: deadline };
    const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expiredTransfer)
        return expiredTransfer;
    const nonce = parseUintField('nonce', body.nonce);
    if (typeof nonce === 'string')
        return { success: false, error: nonce };
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const onchainNonce = (await read.beneficiaryNonces(fromBeneficiary));
    if (onchainNonce !== nonce)
        return { success: false, error: `Bad nonce (expected ${onchainNonce.toString()})` };
    // Every guardian id must currently belong to fromBeneficiary (strict 1:1 ownership).
    for (const guardianId of guardianIds) {
        const owner = ethers_1.ethers.getAddress(await read.guardianIdBeneficiary(guardianId));
        if (owner.toLowerCase() !== fromBeneficiary.toLowerCase()) {
            return { success: false, error: `Guardian #${guardianId.toString()} not owned by fromBeneficiary` };
        }
    }
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorDepositRedeemTransferTypes, { fromBeneficiary, toBeneficiary, guardianIds, nonce, deadline }, signature);
    if (recovered.toLowerCase() !== fromBeneficiary.toLowerCase())
        return { success: false, error: 'Signer is not fromBeneficiary' };
    return {
        success: true,
        preChecked: { contract, fromBeneficiary, toBeneficiary, guardianIds, nonce, deadline, signature },
    };
}
async function createTransferOrderClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.seller || !ethers_1.ethers.isAddress(body.seller))
        return { success: false, error: 'Invalid seller' };
    const seller = ethers_1.ethers.getAddress(body.seller);
    const guardianIds = parseGuardianIdArray(body.guardianIds);
    if (typeof guardianIds === 'string')
        return { success: false, error: guardianIds };
    const priceUsdc6 = parseUintField('priceUsdc6', body.priceUsdc6);
    if (typeof priceUsdc6 === 'string')
        return { success: false, error: priceUsdc6 };
    if (priceUsdc6 <= 0n)
        return { success: false, error: 'Price must be > 0' };
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof deadline === 'string')
        return { success: false, error: deadline };
    const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expiredTransfer)
        return expiredTransfer;
    const nonce = parseUintField('nonce', body.nonce);
    if (typeof nonce === 'string')
        return { success: false, error: nonce };
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const onchainNonce = (await read.beneficiaryNonces(seller));
    if (onchainNonce !== nonce)
        return { success: false, error: `Bad nonce (expected ${onchainNonce.toString()})` };
    for (const guardianId of guardianIds) {
        const owner = ethers_1.ethers.getAddress(await read.guardianIdBeneficiary(guardianId));
        if (owner.toLowerCase() !== seller.toLowerCase())
            return { success: false, error: `Guardian #${guardianId.toString()} not owned by seller` };
    }
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorCreateTransferOrderTypes, { seller, guardianIds, priceUsdc6, nonce, deadline }, signature);
    if (recovered.toLowerCase() !== seller.toLowerCase())
        return { success: false, error: 'Signer is not seller' };
    return { success: true, preChecked: { contract, seller, guardianIds, priceUsdc6, nonce, deadline, signature } };
}
async function cancelTransferOrderClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.seller || !ethers_1.ethers.isAddress(body.seller))
        return { success: false, error: 'Invalid seller' };
    const seller = ethers_1.ethers.getAddress(body.seller);
    const orderId = parseUintField('orderId', body.orderId);
    if (typeof orderId === 'string')
        return { success: false, error: orderId };
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof deadline === 'string')
        return { success: false, error: deadline };
    const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expiredTransfer)
        return expiredTransfer;
    const nonce = parseUintField('nonce', body.nonce);
    if (typeof nonce === 'string')
        return { success: false, error: nonce };
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const order = await read.getTransferOrder(orderId);
    if (!Boolean(order[3]))
        return { success: false, error: 'Order not active' };
    if (ethers_1.ethers.getAddress(order[0]).toLowerCase() !== seller.toLowerCase())
        return { success: false, error: 'Not order seller' };
    const onchainNonce = (await read.beneficiaryNonces(seller));
    if (onchainNonce !== nonce)
        return { success: false, error: `Bad nonce (expected ${onchainNonce.toString()})` };
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorCancelTransferOrderTypes, { seller, orderId, nonce, deadline }, signature);
    if (recovered.toLowerCase() !== seller.toLowerCase())
        return { success: false, error: 'Signer is not seller' };
    return { success: true, preChecked: { contract, orderId, seller, nonce, deadline, signature } };
}
async function fulfillTransferOrderClusterPreCheck(body) {
    const contract = resolveValidatorDepositRedeemAddress();
    if (!contract)
        return { success: false, error: 'CONET_VALIDATOR_DEPOSIT_REDEEM not configured' };
    if (!body.buyer || !ethers_1.ethers.isAddress(body.buyer))
        return { success: false, error: 'Invalid buyer' };
    const buyer = ethers_1.ethers.getAddress(body.buyer);
    const orderId = parseUintField('orderId', body.orderId);
    if (typeof orderId === 'string')
        return { success: false, error: orderId };
    const deadline = parseUintField('deadline', body.deadline);
    if (typeof deadline === 'string')
        return { success: false, error: deadline };
    const expiredTransfer = clusterRejectIfSignatureDeadlineExpired(deadline);
    if (expiredTransfer)
        return expiredTransfer;
    const nonce = parseUintField('nonce', body.nonce);
    if (typeof nonce === 'string')
        return { success: false, error: nonce };
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!ethers_1.ethers.isHexString(signature) || ethers_1.ethers.dataLength(signature) < 64)
        return { success: false, error: 'Invalid signature' };
    // EIP-3009 payment authorization fields (zero-approve).
    const payValidAfter = parseUintField('payValidAfter', body.payValidAfter);
    if (typeof payValidAfter === 'string')
        return { success: false, error: payValidAfter };
    const payValidBefore = parseUintField('payValidBefore', body.payValidBefore);
    if (typeof payValidBefore === 'string')
        return { success: false, error: payValidBefore };
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (payValidBefore <= nowSec)
        return { success: false, error: 'Payment authorization expired' };
    const payNonce = typeof body.payNonce === 'string' ? body.payNonce.trim() : '';
    if (!ethers_1.ethers.isHexString(payNonce, 32))
        return { success: false, error: 'Invalid payNonce' };
    const paySignature = typeof body.paySignature === 'string' ? body.paySignature.trim() : '';
    if (!ethers_1.ethers.isHexString(paySignature) || ethers_1.ethers.dataLength(paySignature) < 64)
        return { success: false, error: 'Invalid paySignature' };
    const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
    const order = await read.getTransferOrder(orderId);
    if (!Boolean(order[3]))
        return { success: false, error: 'Order not active' };
    const seller = ethers_1.ethers.getAddress(order[0]);
    const priceUsdc6 = order[2];
    if (seller.toLowerCase() === buyer.toLowerCase())
        return { success: false, error: 'Buyer is seller' };
    const onchainNonce = (await read.beneficiaryNonces(buyer));
    if (onchainNonce !== nonce)
        return { success: false, error: `Bad nonce (expected ${onchainNonce.toString()})` };
    // Buyer must hold enough CoNET-USDC; with EIP-3009 no approve/allowance is required.
    const usdcAddr = ethers_1.ethers.getAddress(await read.usdcToken());
    if (usdcAddr === ethers_1.ethers.ZeroAddress)
        return { success: false, error: 'USDC token unset' };
    const usdc = new ethers_1.ethers.Contract(usdcAddr, [
        'function balanceOf(address) view returns (uint256)',
        'function name() view returns (string)',
        'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
    ], conetProvider());
    const bal = (await usdc.balanceOf(buyer));
    if (bal < priceUsdc6)
        return { success: false, error: 'Insufficient CoNET-USDC balance' };
    const authUsed = (await usdc.authorizationState(buyer, payNonce));
    if (authUsed)
        return { success: false, error: 'Payment authorization already used' };
    // Verify the buyer's fulfill binding signature (ValidatorDepositRedeem domain).
    const recovered = ethers_1.ethers.verifyTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorFulfillTransferOrderTypes, { buyer, orderId, nonce, deadline }, signature);
    if (recovered.toLowerCase() !== buyer.toLowerCase())
        return { success: false, error: 'Signer is not buyer' };
    // Verify the EIP-3009 payment authorization (CoNET-USDC token domain): buyer -> seller priceUsdc6.
    const tokenName = (await usdc.name());
    const usdcDomain = { name: tokenName, version: '1', chainId: validatorDepositRedeemEip712Domain(contract).chainId, verifyingContract: usdcAddr };
    const payRecovered = ethers_1.ethers.verifyTypedData(usdcDomain, exports.usdcTransferWithAuthorizationTypes, { from: buyer, to: seller, value: priceUsdc6, validAfter: payValidAfter, validBefore: payValidBefore, nonce: payNonce }, paySignature);
    if (payRecovered.toLowerCase() !== buyer.toLowerCase())
        return { success: false, error: 'Payment signer is not buyer' };
    return {
        success: true,
        preChecked: { contract, orderId, buyer, nonce, deadline, signature, payValidAfter, payValidBefore, payNonce, paySignature },
    };
}
exports.validatorDepositRedeemCreatePool = [];
exports.validatorDepositRedeemCancelPool = [];
exports.validatorDepositRedeemClaimPool = [];
exports.validatorDepositRedeemClaimAirdropPool = [];
exports.validatorDepositRedeemTransferPool = [];
exports.validatorCreateTransferOrderPool = [];
exports.validatorCancelTransferOrderPool = [];
exports.validatorFulfillTransferOrderPool = [];
async function withSettleWallet(poolName, fn) {
    if (!(0, settleContractPool_1.hasIdleSettleConet)())
        return undefined;
    const sc = (0, settleContractPool_1.shiftSettleConet)();
    if (!sc)
        return undefined;
    try {
        return await fn(sc);
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(sc);
    }
}
const validatorDepositRedeemCreateProcess = async () => {
    const obj = exports.validatorDepositRedeemCreatePool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorDepositRedeemCreatePool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorDepositRedeemCreateProcess)(), 3000);
    }
    try {
        const txHash = await withSettleWallet('validatorDepositRedeemCreate', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.createRedeemFor(obj.admin, obj.codeHash, obj.allowedClaimer, obj.referrer, obj.validatorCount, obj.targetNodeIp, obj.gbMiningNodeCount, obj.airdrop, obj.validAfter, obj.validBefore, obj.nonce, obj.deadline, obj.signature, { gasLimit: 1_800_000 });
            await tx.wait();
            return tx.hash;
        });
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, txHash }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemCreateProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorDepositRedeemCreateProcess)(), 3000);
    }
};
exports.validatorDepositRedeemCreateProcess = validatorDepositRedeemCreateProcess;
const validatorDepositRedeemClaimAirdropProcess = async () => {
    const obj = exports.validatorDepositRedeemClaimAirdropPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorDepositRedeemClaimAirdropPool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorDepositRedeemClaimAirdropProcess)(), 3000);
    }
    try {
        const txHash = await withSettleWallet('validatorDepositRedeemClaimAirdrop', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.claimAirdropFor(obj.beneficiary, obj.amount, obj.nonce, obj.deadline, obj.signature, { gasLimit: 600_000 });
            await tx.wait();
            return tx.hash;
        });
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, txHash }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemClaimAirdropProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorDepositRedeemClaimAirdropProcess)(), 3000);
    }
};
exports.validatorDepositRedeemClaimAirdropProcess = validatorDepositRedeemClaimAirdropProcess;
const validatorDepositRedeemCancelProcess = async () => {
    const obj = exports.validatorDepositRedeemCancelPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorDepositRedeemCancelPool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorDepositRedeemCancelProcess)(), 3000);
    }
    try {
        const txHash = await withSettleWallet('validatorDepositRedeemCancel', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.cancelRedeemFor(obj.admin, obj.codeHash, obj.nonce, obj.deadline, obj.signature, { gasLimit: 700_000 });
            await tx.wait();
            return tx.hash;
        });
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, txHash }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemCancelProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorDepositRedeemCancelProcess)(), 3000);
    }
};
exports.validatorDepositRedeemCancelProcess = validatorDepositRedeemCancelProcess;
const validatorDepositRedeemClaimProcess = async () => {
    const obj = exports.validatorDepositRedeemClaimPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorDepositRedeemClaimPool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorDepositRedeemClaimProcess)(), 3000);
    }
    try {
        const gasLimit = obj.gasLimit > 0 ? obj.gasLimit : 1_800_000;
        const txHash = await withSettleWallet('validatorDepositRedeemClaim', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.claimRedeemFor(obj.claimer, obj.beneficiary, obj.code, obj.deadline, obj.signature, { gasLimit });
            const receipt = await tx.wait();
            if (receipt?.status !== 1) {
                throw new Error(`claimRedeemFor reverted (gasLimit=${gasLimit}, gasUsed=${receipt?.gasUsed?.toString() ?? '?'})`);
            }
            return tx.hash;
        });
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, txHash }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red(`[validatorDepositRedeemClaimProcess] failed (gasLimit=${obj.gasLimit}):`), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorDepositRedeemClaimProcess)(), 3000);
    }
};
exports.validatorDepositRedeemClaimProcess = validatorDepositRedeemClaimProcess;
/** Background queue after a successful kit / package claim (no HTTP res). */
function enqueueLinkedValidatorDepositRedeemClaim(preChecked) {
    exports.validatorDepositRedeemClaimPool.push({
        contract: preChecked.contract,
        claimer: preChecked.claimer,
        beneficiary: preChecked.beneficiary,
        referrer: preChecked.referrer,
        code: preChecked.code,
        deadline: preChecked.deadline,
        signature: preChecked.signature,
        gasLimit: preChecked.gasLimit,
    });
    void (0, exports.validatorDepositRedeemClaimProcess)().catch((err) => {
        (0, logger_1.logger)(safe_1.default.red('[enqueueLinkedValidatorDepositRedeemClaim] unhandled:'), err?.message ?? err);
    });
}
const validatorDepositRedeemTransferProcess = async () => {
    const obj = exports.validatorDepositRedeemTransferPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorDepositRedeemTransferPool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorDepositRedeemTransferProcess)(), 3000);
    }
    try {
        const txHash = await withSettleWallet('validatorDepositRedeemTransfer', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.transferNodes(obj.fromBeneficiary, obj.toBeneficiary, obj.guardianIds, obj.nonce, obj.deadline, obj.signature, { gasLimit: 3_000_000 });
            await tx.wait();
            return tx.hash;
        });
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, txHash }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemTransferProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorDepositRedeemTransferProcess)(), 3000);
    }
};
exports.validatorDepositRedeemTransferProcess = validatorDepositRedeemTransferProcess;
const validatorCreateTransferOrderProcess = async () => {
    const obj = exports.validatorCreateTransferOrderPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorCreateTransferOrderPool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorCreateTransferOrderProcess)(), 3000);
    }
    try {
        const result = await withSettleWallet('validatorCreateTransferOrder', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.createTransferOrder(obj.seller, obj.guardianIds, obj.priceUsdc6, obj.nonce, obj.deadline, obj.signature, { gasLimit: 3_000_000 });
            const receipt = await tx.wait();
            // Parse orderId from the TransferOrderCreated event.
            let orderId;
            for (const log of receipt?.logs ?? []) {
                try {
                    const parsed = c.interface.parseLog(log);
                    if (parsed?.name === 'TransferOrderCreated') {
                        orderId = parsed.args[0].toString();
                        break;
                    }
                }
                catch {
                    // not our event
                }
            }
            return { txHash: tx.hash, orderId };
        });
        if (!result)
            throw new Error('No settle wallet available');
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, ...result }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorCreateTransferOrderProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorCreateTransferOrderProcess)(), 3000);
    }
};
exports.validatorCreateTransferOrderProcess = validatorCreateTransferOrderProcess;
const validatorCancelTransferOrderProcess = async () => {
    const obj = exports.validatorCancelTransferOrderPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorCancelTransferOrderPool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorCancelTransferOrderProcess)(), 3000);
    }
    try {
        const txHash = await withSettleWallet('validatorCancelTransferOrder', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.cancelTransferOrder(obj.orderId, obj.seller, obj.nonce, obj.deadline, obj.signature, { gasLimit: 2_000_000 });
            await tx.wait();
            return tx.hash;
        });
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, txHash }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorCancelTransferOrderProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorCancelTransferOrderProcess)(), 3000);
    }
};
exports.validatorCancelTransferOrderProcess = validatorCancelTransferOrderProcess;
const validatorFulfillTransferOrderProcess = async () => {
    const obj = exports.validatorFulfillTransferOrderPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.validatorFulfillTransferOrderPool.unshift(obj);
        return setTimeout(() => void (0, exports.validatorFulfillTransferOrderProcess)(), 3000);
    }
    try {
        const txHash = await withSettleWallet('validatorFulfillTransferOrder', async (sc) => {
            const c = new ethers_1.ethers.Contract(obj.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.fulfillTransferOrder(obj.orderId, obj.buyer, obj.nonce, obj.deadline, obj.signature, obj.payValidAfter, obj.payValidBefore, obj.payNonce, obj.paySignature, { gasLimit: 3_000_000 });
            await tx.wait();
            return tx.hash;
        });
        if (obj.res && !obj.res.headersSent)
            obj.res.status(200).json({ success: true, txHash }).end();
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorFulfillTransferOrderProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        setTimeout(() => void (0, exports.validatorFulfillTransferOrderProcess)(), 3000);
    }
};
exports.validatorFulfillTransferOrderProcess = validatorFulfillTransferOrderProcess;
const activeRunCommandChildren = new Set();
function runCommand(label, command, args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        activeRunCommandChildren.add(child);
        const detach = () => {
            activeRunCommandChildren.delete(child);
        };
        let out = '';
        child.stdout.on('data', (d) => {
            out += d.toString();
        });
        child.stderr.on('data', (d) => {
            out += d.toString();
        });
        child.on('error', (err) => {
            detach();
            reject(err);
        });
        child.on('close', (code) => {
            detach();
            if (code === 0)
                return resolve(out.slice(-4000));
            reject(new Error(`${label} exited ${code}: ${out.slice(-4000)}`));
        });
    });
}
/** Active bash helper scripts (08_import, generate, exit, …) spawned via runCommand. */
function getActiveRunCommandChildCount() {
    return activeRunCommandChildren.size;
}
/** Preserve keystores before 01_generate REPLACE wipes append_validator_keys/ (restart re-import safety). */
function archiveAppendValidatorKeystoresBeforeGenerate(newCoNETDir) {
    const sourceDir = node_path_1.default.join(newCoNETDir, 'append_validator_keys');
    const archiveDir = node_path_1.default.join(newCoNETDir, process.env.CONET_VALIDATOR_KEYS_ARCHIVE_DIR?.trim() || 'append_validator_keys_archive');
    node_fs_1.default.mkdirSync(archiveDir, { recursive: true });
    let copied = 0;
    const walk = (dir) => {
        if (!node_fs_1.default.existsSync(dir))
            return;
        for (const ent of node_fs_1.default.readdirSync(dir, { withFileTypes: true })) {
            const full = node_path_1.default.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(full);
                continue;
            }
            if (!ent.name.startsWith('keystore-') || !ent.name.endsWith('.json'))
                continue;
            const dest = node_path_1.default.join(archiveDir, ent.name);
            if (!node_fs_1.default.existsSync(dest)) {
                node_fs_1.default.copyFileSync(full, dest);
                try {
                    node_fs_1.default.chmodSync(dest, 0o600);
                }
                catch {
                    /* ignore chmod on some hosts */
                }
                copied++;
            }
        }
    };
    walk(sourceDir);
    return `archived ${copied} keystore(s) to ${archiveDir}`;
}
function assertImportWalletAccountCount(importOut) {
    if (importOut.includes('wallet locked by running validator'))
        return;
    const m = importOut.match(/OK: wallet accounts=(\d+)/);
    if (!m) {
        throw new Error(`import did not report wallet account count: ${importOut.slice(-800)}`);
    }
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 1) {
        throw new Error(`import reported invalid wallet account count: ${m[1]}`);
    }
}
/** Wait for in-flight runCommand children before listener exit (systemctl restart grace). */
async function waitForRunCommandChildren(timeoutMs) {
    const grace = timeoutMs ?? Number(process.env.CONET_VALIDATOR_LISTENER_STOP_GRACE_MS || 120_000);
    if (!Number.isFinite(grace) || grace <= 0 || activeRunCommandChildren.size === 0)
        return;
    const deadline = Date.now() + grace;
    while (activeRunCommandChildren.size > 0) {
        if (Date.now() >= deadline) {
            (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeem] waitForRunCommandChildren timeout (${grace}ms); ${activeRunCommandChildren.size} child(ren) still running`));
            return;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
}
/**
 * Read the last {count} validator BLS pubkeys appended to a staking deposit-cli style JSON file.
 * The generate script APPENDS {validatorCount} entries per claim, so this claim's validators are the tail.
 * Returns 0x-prefixed 48-byte pubkeys; empty array if the file is unreadable or malformed.
 */
function readLastNDepositPubkeys(depositFile, count) {
    if (count <= 0 || !node_fs_1.default.existsSync(depositFile))
        return [];
    try {
        const parsed = JSON.parse(node_fs_1.default.readFileSync(depositFile, 'utf8'));
        const arr = Array.isArray(parsed) ? parsed : [];
        const tail = arr.slice(-count);
        const out = [];
        for (const entry of tail) {
            try {
                out.push(hexBytesField(entry?.pubkey, 48, 'pubkey'));
            }
            catch {
                // skip pubkey-only / malformed tail entries
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
function hexBytesField(raw, byteLen, label) {
    const t = String(raw ?? '').trim().toLowerCase();
    const hex = t.startsWith('0x') ? t.slice(2) : t;
    if (!/^[0-9a-f]+$/.test(hex) || hex.length !== byteLen * 2) {
        throw new Error(`invalid ${label}: expected ${byteLen} bytes hex`);
    }
    return `0x${hex}`;
}
function readLastNDepositEntries(depositFile, count) {
    if (count <= 0 || !node_fs_1.default.existsSync(depositFile))
        return [];
    const parsed = JSON.parse(node_fs_1.default.readFileSync(depositFile, 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : [];
    const tail = arr.slice(-count);
    const out = [];
    for (const entry of tail) {
        out.push({
            pubkey: hexBytesField(entry?.pubkey, 48, 'pubkey'),
            withdrawalCredentials: hexBytesField(entry?.withdrawal_credentials ?? entry?.withdrawalCredentials, 32, 'withdrawal_credentials'),
            signature: hexBytesField(entry?.signature, 96, 'signature'),
            depositDataRoot: hexBytesField(entry?.deposit_data_root ?? entry?.depositDataRoot, 32, 'deposit_data_root'),
        });
    }
    return out;
}
/** Resolve guardian node ids (1:1 with claim IPs) for the last N deposit entries. */
async function resolveGuardianIdsForClaim(state, count) {
    const contractAddr = resolveValidatorDepositRedeemAddress();
    if (!contractAddr)
        throw new Error('no validator redeem contract configured');
    const provider = conetProvider();
    const cRead = new ethers_1.ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
    const bundle = await cRead.getBeneficiaryNodeBundle(state.beneficiary);
    const bundleIps = bundle.depinNodeIps.map(normalizeIp);
    const bundleGuardianIds = bundle.guardianNodeIds || [];
    const ipToGuardianId = new Map();
    bundleIps.forEach((ip, i) => {
        const gid = bundleGuardianIds[i];
        if (ip && gid !== undefined && gid > 0n)
            ipToGuardianId.set(ip, gid);
    });
    const claimIps = state.conetDepinNodeIps.map(normalizeIp);
    const guardianIds = [];
    for (let i = 0; i < count; i++) {
        const ip = claimIps[i];
        const gid = ip ? ipToGuardianId.get(ip) : undefined;
        if (gid === undefined)
            throw new Error(`no DePIN guardian id for ip=${ip ?? '?'}`);
        guardianIds.push(gid);
    }
    return guardianIds;
}
/**
 * Submit validators via ValidatorDepositRedeem.fundAndDepositValidators: 32 CNET/validator from contract
 * balance; redeem admin (38.102.85.33) signs and pays gas only.
 */
async function fundAndDepositViaContract(state, mark) {
    const contractAddr = resolveValidatorDepositRedeemAddress();
    if (!contractAddr)
        return mark('fund-and-deposit', false, 'no validator redeem contract configured');
    const count = Number(state.validatorCount);
    if (!Number.isFinite(count) || count <= 0)
        return mark('fund-and-deposit', true, 'no validators to deposit');
    const depositFile = node_path_1.default.join(resolveNewCoNETDir(), 'validator_deposits.json');
    let entries;
    try {
        entries = readLastNDepositEntries(depositFile, count);
    }
    catch (e) {
        return mark('fund-and-deposit', false, e?.message ?? String(e));
    }
    if (entries.length !== count) {
        return mark('fund-and-deposit', false, `deposit entries ${entries.length} != validatorCount ${count}`);
    }
    const provider = conetProvider();
    const cRead = new ethers_1.ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
    const selfCred = await cRead.selfWithdrawalCredentials();
    for (const e of entries) {
        const wc = ethers_1.ethers.hexlify(e.withdrawalCredentials).toLowerCase();
        if (wc !== String(selfCred).toLowerCase()) {
            return mark('fund-and-deposit', false, `withdrawal_credentials must equal contract selfWithdrawalCredentials (${selfCred}); regenerate with WITHDRAWAL_ADDRESS=contract`);
        }
    }
    let guardianIds;
    try {
        guardianIds = await resolveGuardianIdsForClaim(state, count);
    }
    catch (e) {
        return mark('fund-and-deposit', false, e?.message ?? String(e));
    }
    const need = VALIDATOR_STAKE_WEI * BigInt(count);
    const bal = await provider.getBalance(contractAddr);
    if (bal < need) {
        return mark('fund-and-deposit', false, `ValidatorDepositRedeem balance ${ethers_1.ethers.formatEther(bal)} CNET < ${ethers_1.ethers.formatEther(need)} needed (${count}×32)`);
    }
    const admin = loadRedeemAdminWallet();
    const cw = new ethers_1.ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, admin);
    const tx = await cw.fundAndDepositValidators(guardianIds, entries.map((e) => e.pubkey), entries.map((e) => e.withdrawalCredentials), entries.map((e) => e.signature), entries.map((e) => e.depositDataRoot), { gasLimit: 800_000 + 350_000 * count });
    const receipt = await tx.wait();
    const deployedPubkeys = entries.map((e) => e.pubkey);
    mark('fund-and-deposit', true, `deposited ${count} validators from contract balance; tx=${receipt?.hash ?? tx.hash}; admin=${admin.address}`);
    upsertState(state.requestId, (cur) => ({
        ...(cur || state),
        deployedPubkeys,
        updatedAt: new Date().toISOString(),
    }));
    // Post-fund on-chain verification (replaces the previously redundant registerNodeValidators tx):
    // fundAndDepositValidators binds pubkey -> guardian id INLINE (see _registerOneNodeValidator), so the
    // standard path only needs to confirm the binding. We pair deployed pubkeys 1:1 with the same guardian ids
    // passed into fundAndDepositValidators (no IP/bundle re-resolution → avoids "no DePIN guardian ids resolved").
    const cVerify = new ethers_1.ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
    const unbound = [];
    const mismatched = [];
    for (let i = 0; i < deployedPubkeys.length; i++) {
        const pubkey = deployedPubkeys[i];
        const guardianId = guardianIds[i];
        const pkHash = ethers_1.ethers.keccak256(pubkey);
        let bound = 0n;
        try {
            bound = (await cVerify.getNodeByValidatorPubkeyHash(pkHash));
        }
        catch {
            bound = 0n;
        }
        if (bound === 0n)
            unbound.push({ guardianId, pubkey });
        else if (bound !== guardianId)
            mismatched.push(`${pubkey.slice(0, 12)}…->#${bound.toString()}`);
    }
    if (mismatched.length) {
        return mark('register-validators', false, `pubkey bound to unexpected guardian: ${mismatched.join(', ')}`);
    }
    if (!unbound.length) {
        return mark('register-validators', true, `verified ${deployedPubkeys.length} validator binding(s) on chain (bound inline by fundAndDepositValidators)`);
    }
    // Fallback only: contract did NOT inline-bind (legacy bytecode) — register the missing pairs once via a
    // Settle relayer. Uses the explicit (guardianId, pubkey) pairs from this claim, not bundle/IP resolution.
    const txHash = await withSettleWallet('registerNodeValidators', async (sc) => {
        const cwReg = new ethers_1.ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
        const regTx = await cwReg.registerNodeValidators(unbound.map((p) => p.guardianId), unbound.map((p) => p.pubkey), { gasLimit: 2_500_000 });
        await regTx.wait();
        return regTx.hash;
    });
    if (!txHash) {
        return mark('register-validators', false, `${unbound.length} validator(s) unbound after fund; no relayer wallet available (Settle pool empty) — retry later`);
    }
    mark('register-validators', true, `fallback-registered ${unbound.length} validator(s); tx=${txHash}`);
}
/**
 * After validators are deployed for a claimed beneficiary, pair each allocated DePIN node wallet (1:1) with a
 * deployed validator pubkey and register the binding on chain (withdrawal -> beneficiary). The deployment node's
 * relayer (a redeem admin in {Settle_ContractPool}) submits and pays CNET gas. Failures here do NOT roll back the
 * deployment (validators already exist); the stage is marked so it can be retried later.
 */
async function registerDeployedValidators(state, mark) {
    const contractAddr = resolveValidatorDepositRedeemAddress();
    if (!contractAddr)
        return mark('register-validators', false, 'no validator redeem contract configured');
    const count = Number(state.validatorCount);
    if (!Number.isFinite(count) || count <= 0)
        return mark('register-validators', true, 'no validators to register');
    const depositFile = node_path_1.default.join(resolveNewCoNETDir(), 'validator_deposits.json');
    let pubkeys = (state.deployedPubkeys ?? []).slice(0, count);
    if (pubkeys.length !== count) {
        pubkeys = readLastNDepositPubkeys(depositFile, count);
    }
    if (pubkeys.length !== count) {
        return mark('register-validators', false, `deposit pubkeys ${pubkeys.length} != validatorCount ${count}`);
    }
    const provider = conetProvider();
    const cRead = new ethers_1.ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
    const bundle = await cRead.getBeneficiaryNodeBundle(state.beneficiary);
    const bundleIps = bundle.depinNodeIps.map(normalizeIp);
    const bundleGuardianIds = bundle.guardianNodeIds || [];
    const ipToGuardianId = new Map();
    bundleIps.forEach((ip, i) => {
        const gid = bundleGuardianIds[i];
        if (ip && gid !== undefined && gid > 0n)
            ipToGuardianId.set(ip, gid);
    });
    // Pair this claim's allocated DePIN guardian ids (from the event IP list) with deployed validator pubkeys.
    const claimIps = state.conetDepinNodeIps.map(normalizeIp);
    const pairs = [];
    for (let i = 0; i < pubkeys.length; i++) {
        const ip = claimIps[i];
        const gid = ip ? ipToGuardianId.get(ip) : undefined;
        if (gid !== undefined)
            pairs.push({ guardianId: gid, pubkey: pubkeys[i] });
    }
    if (!pairs.length)
        return mark('register-validators', false, 'no DePIN guardian ids resolved for this claim');
    const pending = [];
    for (const p of pairs) {
        const pkHash = ethers_1.ethers.keccak256(p.pubkey);
        const bound = (await cRead.getNodeByValidatorPubkeyHash(pkHash));
        if (bound !== 0n && bound === p.guardianId)
            continue;
        if (bound !== 0n && bound !== p.guardianId) {
            return mark('register-validators', false, `pubkey already bound to guardian #${bound.toString()}`);
        }
        pending.push(p);
    }
    if (!pending.length) {
        return mark('register-validators', true, `already registered ${pairs.length} validators on chain`);
    }
    const txHash = await withSettleWallet('registerNodeValidators', async (sc) => {
        const cw = new ethers_1.ethers.Contract(contractAddr, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
        const tx = await cw.registerNodeValidators(pending.map((p) => p.guardianId), pending.map((p) => p.pubkey), { gasLimit: 2_500_000 });
        await tx.wait();
        return tx.hash;
    });
    if (!txHash)
        return mark('register-validators', false, 'no relayer wallet available (Settle pool empty)');
    mark('register-validators', true, `registered ${pending.length} validators; tx=${txHash}`);
}
/** Manual / retry: register validators for succeeded redeem claims missing register-validators stage. */
async function retryRegisterDeployedValidatorsForRedeemState() {
    const stateFile = resolveStateFile();
    if (!node_fs_1.default.existsSync(stateFile))
        return [];
    const all = JSON.parse(node_fs_1.default.readFileSync(stateFile, 'utf8'));
    const results = [];
    for (const [requestId, state] of Object.entries(all)) {
        if (state?.status !== 'succeeded')
            continue;
        if (state.stages?.['register-validators']?.ok) {
            results.push({ requestId, ok: true, detail: 'already registered' });
            continue;
        }
        const stages = { ...(state.stages || {}) };
        const mark = (stage, ok, detail) => {
            stages[stage] = { ok, at: new Date().toISOString(), detail };
        };
        try {
            await registerDeployedValidators({ ...state, requestId, stages }, mark);
            const ok = Boolean(stages['register-validators']?.ok);
            results.push({ requestId, ok, detail: stages['register-validators']?.detail ?? 'unknown' });
            upsertState(requestId, (cur) => ({
                ...(cur || state),
                stages,
                updatedAt: new Date().toISOString(),
            }));
        }
        catch (e) {
            const detail = e?.message ?? String(e);
            mark('register-validators', false, detail);
            results.push({ requestId, ok: false, detail });
            upsertState(requestId, (cur) => ({
                ...(cur || state),
                stages,
                updatedAt: new Date().toISOString(),
            }));
        }
    }
    return results;
}
/** True if the deposit-cli JSON file contains a validator entry whose pubkey matches {pubkeyHex} (0x..). */
function depositFileHasPubkey(depositFile, pubkeyHex) {
    try {
        if (!node_fs_1.default.existsSync(depositFile))
            return false;
        const want = pubkeyHex.toLowerCase().replace(/^0x/, '');
        const arr = JSON.parse(node_fs_1.default.readFileSync(depositFile, 'utf8'));
        if (!Array.isArray(arr))
            return false;
        return arr.some((e) => String(e?.pubkey ?? '').toLowerCase().replace(/^0x/, '') === want);
    }
    catch {
        return false;
    }
}
/**
 * Transfer step on the validator node (staking-custody model): when a {NodeValidatorBeneficiaryUpdated}
 * event names a validator this node deployed, HOT-UPDATE its fee_recipient to the new economic beneficiary.
 * The validator is NOT exited and NOT redeployed: same BLS pubkey, withdrawal_credentials stay pointed at
 * the ValidatorDepositRedeem contract (immutable custody). Only the execution-layer fee_recipient changes.
 * Best-effort: missing scripts / dry-run only record stages and never throw out of the listener.
 */
async function executeFeeRecipientHotUpdate(args) {
    const rid = `feerecipient:${args.guardianId.toString()}:${args.pubkeyHash.toLowerCase()}`;
    const flightKey = `feerecipient:${rid}`;
    if (!tryBeginListenerEvent(flightKey))
        return;
    try {
        const prior = getValidatorDepositRedeemStatus(rid);
        if (prior?.status === 'succeeded' || prior?.status === 'running')
            return;
        await enqueueListenerOnchainWork(`feerecipient #${args.guardianId.toString()}`, async () => {
            const base = {
                requestId: rid,
                codeHash: '',
                claimer: args.toBeneficiary,
                beneficiary: args.toBeneficiary,
                validatorCount: '1',
                targetNodeIp: resolveValidatorNodeIp(),
                conetDepinNodeIps: [],
                gbMiningNodeCount: '0',
                status: 'received',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                stages: {},
            };
            const mark = (stage, ok, detail) => upsertState(rid, (cur) => ({
                ...(cur || base),
                status: ok ? 'running' : 'failed',
                updatedAt: new Date().toISOString(),
                error: ok ? cur?.error : detail,
                stages: { ...(cur?.stages || base.stages), [stage]: { ok, at: new Date().toISOString(), detail } },
            }));
            const provider = conetProvider();
            const cRead = new ethers_1.ethers.Contract(args.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
            const onchain = await cRead.getNodeValidator(args.guardianId);
            const pubkey = String(onchain?.[0] ?? onchain?.pubkey ?? '').toLowerCase();
            const newCoNETDir = resolveNewCoNETDir();
            const depositFile = node_path_1.default.join(newCoNETDir, 'validator_deposits.json');
            if (!pubkey || pubkey === '0x' || !depositFileHasPubkey(depositFile, pubkey)) {
                return;
            }
            mark('feerecipient-matched', true, `guardian #${args.guardianId.toString()} -> ${args.toBeneficiary}`);
            if (validatorDryRun()) {
                mark('dry-run', true, 'skipped fee_recipient hot-update');
                upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }));
                return;
            }
            const env = {
                ...process.env,
                VALIDATOR_PUBKEY: pubkey,
                EXIT_VALIDATOR_PUBKEY: pubkey,
                FEE_RECIPIENT: args.toBeneficiary,
                FEE_RECIPIENT_ADDRESS: args.toBeneficiary,
                RPC_URL: process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || util_1.masterSetup.validatorDeposit?.rpcUrl || (0, util_1.resolveBeamioConetHttpRpcUrl)(),
                CHAIN_ID: String(chainAddresses_1.CONET_MAINNET_CHAIN_ID),
            };
            const feeScript = process.env.CONET_VALIDATOR_FEE_RECIPIENT_SCRIPT?.trim() || './07_update_fee_recipient.sh';
            if (node_fs_1.default.existsSync(node_path_1.default.join(newCoNETDir, feeScript))) {
                const out = await runCommand('update fee_recipient', 'bash', [feeScript], newCoNETDir, env);
                mark('feerecipient-update', true, out);
                upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }));
            }
            else {
                mark('feerecipient-update', false, `fee_recipient script missing: ${feeScript} (manual hot-update required)`);
            }
        });
    }
    finally {
        endListenerEvent(flightKey);
    }
}
/**
 * Full-exit step on the validator node: when a {FullExitRequested} event names node wallets whose validators
 * this node deployed, exit each validator. The 32-CNET principal auto-returns to the ValidatorDepositRedeem
 * contract (0x01 withdrawal target). After broadcasting the exit, the relayer calls {settleFullExitPayout}
 * which advances 32×count CNET from the contract pool to the beneficiary. Best-effort; never throws out.
 */
async function executeValidatorFullExit(args) {
    const rid = `fullexit:${args.beneficiary.toLowerCase()}:${args.guardianIds.map((g) => g.toString()).join(',')}`;
    const flightKey = `fullexit:${rid}`;
    if (!tryBeginListenerEvent(flightKey))
        return;
    try {
        const prior = getValidatorDepositRedeemStatus(rid);
        if (prior?.status === 'succeeded' || prior?.status === 'running')
            return;
        await enqueueListenerOnchainWork(`fullexit ${args.beneficiary.slice(0, 10)}…`, async () => {
            const base = {
                requestId: rid,
                codeHash: '',
                claimer: args.beneficiary,
                beneficiary: args.beneficiary,
                validatorCount: String(args.guardianIds.length),
                targetNodeIp: resolveValidatorNodeIp(),
                conetDepinNodeIps: [],
                gbMiningNodeCount: '0',
                status: 'received',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                stages: {},
            };
            const mark = (stage, ok, detail) => upsertState(rid, (cur) => ({
                ...(cur || base),
                status: ok ? 'running' : 'failed',
                updatedAt: new Date().toISOString(),
                error: ok ? cur?.error : detail,
                stages: { ...(cur?.stages || base.stages), [stage]: { ok, at: new Date().toISOString(), detail } },
            }));
            const provider = conetProvider();
            const cRead = new ethers_1.ethers.Contract(args.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
            const newCoNETDir = resolveNewCoNETDir();
            const depositFile = node_path_1.default.join(newCoNETDir, 'validator_deposits.json');
            const localGuardianIds = [];
            for (const guardianId of args.guardianIds) {
                try {
                    const onchain = await cRead.getNodeValidator(guardianId);
                    const pubkey = String(onchain?.[0] ?? onchain?.pubkey ?? '').toLowerCase();
                    if (pubkey && pubkey !== '0x' && depositFileHasPubkey(depositFile, pubkey)) {
                        localGuardianIds.push(guardianId);
                    }
                }
                catch {
                    // ignore unreadable node
                }
            }
            if (!localGuardianIds.length)
                return;
            mark('fullexit-matched', true, `local guardianIds=${localGuardianIds.map((g) => g.toString()).join(',')}`);
            if (validatorDryRun()) {
                mark('dry-run', true, 'skipped exit + settle');
                upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }));
                return;
            }
            const baseEnv = {
                ...process.env,
                RPC_URL: process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || util_1.masterSetup.validatorDeposit?.rpcUrl || (0, util_1.resolveBeamioConetHttpRpcUrl)(),
                CHAIN_ID: String(chainAddresses_1.CONET_MAINNET_CHAIN_ID),
                DEPOSIT_CONTRACT: chainAddresses_1.CONET_DEPOSIT_CONTRACT,
            };
            const exitScript = process.env.CONET_VALIDATOR_EXIT_SCRIPT?.trim() || './06_exit_validator.sh';
            if (!node_fs_1.default.existsSync(node_path_1.default.join(newCoNETDir, exitScript))) {
                mark('fullexit-exit', false, `exit script missing: ${exitScript} (manual exit required)`);
                return;
            }
            for (const guardianId of localGuardianIds) {
                const onchain = await cRead.getNodeValidator(guardianId);
                const pubkey = String(onchain?.[0] ?? onchain?.pubkey ?? '').toLowerCase();
                const out = await runCommand(`exit validator ${pubkey.slice(0, 12)}`, 'bash', [exitScript], newCoNETDir, {
                    ...baseEnv,
                    EXIT_VALIDATOR_PUBKEY: pubkey,
                });
                mark(`fullexit-exit-${pubkey.slice(2, 12)}`, true, out);
            }
            const txHash = await withSettleWallet('settleFullExitPayout', async (sc) => {
                const cw = new ethers_1.ethers.Contract(args.contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
                const tx = await cw.settleFullExitPayout(args.beneficiary, localGuardianIds, { gasLimit: 1_500_000 });
                await tx.wait();
                return tx.hash;
            });
            if (txHash) {
                mark('fullexit-settle', true, `tx=${txHash}`);
                upsertState(rid, (cur) => ({ ...(cur || base), status: 'succeeded', updatedAt: new Date().toISOString() }));
            }
            else {
                mark('fullexit-settle', false, 'settle deferred (pool insufficient or no relayer); will retry');
            }
        });
    }
    finally {
        endListenerEvent(flightKey);
    }
}
async function executeValidatorRedeem(state) {
    const requestId = state.requestId.toLowerCase();
    const dryRun = validatorDryRun();
    const newCoNETDir = resolveNewCoNETDir();
    const depositPrivateKeyFile = resolveDepositPrivateKeyFile();
    const contractAddr = resolveValidatorDepositRedeemAddress();
    if (!node_fs_1.default.existsSync(newCoNETDir))
        throw new Error(`newCoNET dir missing: ${newCoNETDir}`);
    if (!contractAddr)
        throw new Error('ValidatorDepositRedeem contract not configured');
    if (!dryRun && (!depositPrivateKeyFile || !node_fs_1.default.existsSync(depositPrivateKeyFile))) {
        throw new Error('CONET_VALIDATOR_REDEEM_ADMIN_PRIVATE_KEY_FILE missing; fundAndDepositValidators requires redeem admin key (key_38.102.85.33)');
    }
    const keystorePassword = resolveKeystorePassword();
    if (!dryRun && !keystorePassword) {
        throw new Error('KEYSTORE_PASSWORD or CONET_VALIDATOR_KEYSTORE_PASSWORD_FILE missing; required for 01_generate_append_validator_deposits.sh (must match validator keystore password on this node)');
    }
    const walletPassword = resolveWalletPassword();
    if (!dryRun && !walletPassword) {
        throw new Error('WALLET_PASSWORD or CONET_VALIDATOR_WALLET_PASSWORD_FILE missing; required for 01_generate_append_validator_deposits.sh (Prysm wallet password on this node)');
    }
    const env = {
        ...process.env,
        KEYSTORE_PASSWORD: keystorePassword,
        WALLET_PASSWORD: walletPassword,
        VALIDATOR_COUNT: state.validatorCount,
        // Withdrawal credentials must point at ValidatorDepositRedeem (0x01 + contract), not beneficiary EOA.
        WITHDRAWAL_ADDRESS_RAW: contractAddr,
        CONFIRM_OVERRIDE_WITHDRAWAL_ADDRESS: 'YES',
        // 01_generate_append_validator_deposits.sh: skip "Type REPLACE" prompt when prior local output exists.
        CONFIRM_REPLACE: 'REPLACE',
        // EthStaker deposit CLI: no TTY prompts (listener stdin is ignored).
        DEPOSIT_NON_INTERACTIVE: process.env.CONET_VALIDATOR_DEPOSIT_NON_INTERACTIVE?.trim() === 'NO' ? '' : 'YES',
        PRIVATE_KEY_FILE: depositPrivateKeyFile,
        DEPOSIT_DATA_FILE: node_path_1.default.join(newCoNETDir, 'validator_deposits.json'),
        RPC_URL: process.env.CONET_VALIDATOR_DEPOSIT_RPC_URL || util_1.masterSetup.validatorDeposit?.rpcUrl || (0, util_1.resolveBeamioConetHttpRpcUrl)(),
        CHAIN_ID: String(chainAddresses_1.CONET_MAINNET_CHAIN_ID),
        DEPOSIT_CONTRACT: chainAddresses_1.CONET_DEPOSIT_CONTRACT,
    };
    const mark = (stage, ok, detail) => {
        upsertState(requestId, (cur) => ({
            ...(cur || state),
            status: ok ? 'running' : 'failed',
            updatedAt: new Date().toISOString(),
            error: ok ? cur?.error : detail,
            stages: { ...(cur?.stages || state.stages), [stage]: { ok, at: new Date().toISOString(), detail } },
            depositPrivateKeyFile: depositPrivateKeyFile || undefined,
        }));
    };
    mark('depin-gb-assignment', true, `beneficiary=${state.beneficiary}; depinIps=${state.conetDepinNodeIps.join(',')}; gbMiningNodeCount=${state.gbMiningNodeCount}`);
    if (dryRun) {
        mark('dry-run', true, 'skipped scripts and deposits');
        return;
    }
    const archiveDetail = archiveAppendValidatorKeystoresBeforeGenerate(newCoNETDir);
    mark('archive-prior-keystores', true, archiveDetail);
    const generateOut = await runCommand('generate validators', 'bash', ['./01_generate_append_validator_deposits_listener.sh'], newCoNETDir, env);
    mark('generate-validators', true, generateOut);
    // Password files must stay stable for Prysm wallet; re-read after wrapper restore.
    const importKeystorePassword = resolveKeystorePassword();
    const importWalletPassword = resolveWalletPassword();
    // fundAndDepositValidators binds pubkey -> node wallet inline; fundAndDepositViaContract now performs the
    // post-fund on-chain binding verification (and a one-shot fallback register only if the contract did not
    // inline-bind). The standalone registerDeployedValidators is reserved for manual retry of older/failed claims.
    await fundAndDepositViaContract(state, mark);
    const prysmValidatorBinary = process.env.PRYSM_VALIDATOR_BINARY?.trim() ||
        node_path_1.default.join(newCoNETDir, 'dependencies/prysm-v7.1.5/validator');
    const importEnv = {
        ...env,
        KEYSTORE_PASSWORD: importKeystorePassword,
        WALLET_PASSWORD: importWalletPassword,
        KEYSTORE_PASSWORD_FILE: resolveKeystorePasswordFile(),
        WALLET_PASSWORD_FILE: resolveWalletPasswordFile(),
        PRYSM_VALIDATOR_BINARY: prysmValidatorBinary,
        VALIDATOR_KEYS_ARCHIVE_DIR: node_path_1.default.join(newCoNETDir, process.env.CONET_VALIDATOR_KEYS_ARCHIVE_DIR?.trim() || 'append_validator_keys_archive'),
        RELOAD_VALIDATOR_AFTER_IMPORT: process.env.CONET_VALIDATOR_RELOAD_VALIDATOR_AFTER_IMPORT?.trim().toUpperCase() === 'NO' ? 'NO' : 'YES',
    };
    const skipImport = process.env.CONET_VALIDATOR_SKIP_IMPORT?.trim().toUpperCase() === 'YES';
    if (skipImport) {
        mark('import-validator-keys', true, 'skipped (CONET_VALIDATOR_SKIP_IMPORT=YES)');
    }
    else {
        const importOut = await runCommand('import append validator keys', 'bash', ['./08_import_append_validator_keys.sh'], newCoNETDir, importEnv);
        assertImportWalletAccountCount(importOut);
        mark('import-validator-keys', true, importOut);
    }
    // Optional full beacon+validator restart (does NOT import keys). Default skip — import script reloads validator only.
    const skipBeaconRestart = process.env.CONET_VALIDATOR_SKIP_BEACON_RESTART?.trim().toUpperCase() !== 'NO';
    if (skipBeaconRestart) {
        mark('restart-beacon-validator', true, 'skipped (set CONET_VALIDATOR_SKIP_BEACON_RESTART=NO to run 05_restart_beacon_validator.sh)');
        return;
    }
    const restartEnv = {
        ...importEnv,
        PRYSM_BEACON_BINARY: process.env.PRYSM_BEACON_BINARY?.trim() ||
            node_path_1.default.join(newCoNETDir, 'dependencies/prysm-v7.1.5/beacon-chain'),
    };
    const restartOut = await runCommand('restart beacon validator', 'bash', ['./05_restart_beacon_validator.sh'], newCoNETDir, restartEnv);
    mark('restart-beacon-validator', true, restartOut);
}
let listenerStarted = false;
let listenerBackfillTimer;
let listenerBackfillInFlight = false;
let liveListenerRebuildInFlight = false;
let pendingLiveListenerRebuild = false;
let liveListenerRebuildTimer;
let lastListenerLagAlertAt = 0;
let listenerContract = null;
let listenerContext = null;
/** First block handled by live subscription; blocks below this are backfill-only. Set after live attach. */
let liveListenFromBlock = 0;
function resolveListenerBackfillTickMs() {
    const raw = Number(process.env.CONET_VALIDATOR_REDEEM_LISTENER_BACKFILL_TICK_MS || 180_000);
    if (!Number.isFinite(raw))
        return 180_000;
    return Math.min(Math.max(Math.floor(raw), 60_000), 300_000);
}
function resolveListenerLagAlertBlocks() {
    const raw = Number(process.env.CONET_VALIDATOR_REDEEM_LISTENER_LAG_ALERT_BLOCKS || 500);
    if (!Number.isFinite(raw) || raw <= 0)
        return 500;
    return Math.floor(raw);
}
function resolveListenerLagAlertCooldownMs() {
    const raw = Number(process.env.CONET_VALIDATOR_REDEEM_LISTENER_LAG_ALERT_COOLDOWN_MS || 600_000);
    if (!Number.isFinite(raw) || raw < 60_000)
        return 600_000;
    return Math.floor(raw);
}
function rebuildLiveListenersEachBackfillTick() {
    const raw = (process.env.CONET_VALIDATOR_REDEEM_LISTENER_REBUILD_LIVE_EACH_TICK || 'YES').trim().toUpperCase();
    return raw !== 'NO' && raw !== '0' && raw !== 'FALSE';
}
function scheduleLiveListenerRebuild(reason) {
    if (!listenerStarted || !listenerContext)
        return;
    if (pendingLiveListenerRebuild)
        return;
    pendingLiveListenerRebuild = true;
    if (liveListenerRebuildTimer !== undefined)
        clearTimeout(liveListenerRebuildTimer);
    liveListenerRebuildTimer = setTimeout(() => {
        pendingLiveListenerRebuild = false;
        liveListenerRebuildTimer = undefined;
        void rebuildLiveListeners(reason);
    }, 500);
}
function ensureConetProviderListenerHooks() {
    if (conetProviderListenerHooksInstalled)
        return;
    conetProviderListenerHooksInstalled = true;
    const provider = conetProvider();
    const origSend = provider.send.bind(provider);
    provider.send = async (method, params) => {
        try {
            return await origSend(method, params);
        }
        catch (e) {
            if (method === 'eth_getFilterChanges' && isFilterNotFoundRpcError(e)) {
                scheduleLiveListenerRebuild('eth_getFilterChanges filter not found');
                void runIncrementalListenerBackfill('filter not found');
            }
            throw e;
        }
    };
}
async function maybeAlertListenerCheckpointLag(contract, deployFloor, head) {
    const prior = loadListenerBlockCheckpoint(contract, deployFloor);
    if (prior == null)
        return 0;
    const lag = head - prior;
    const threshold = resolveListenerLagAlertBlocks();
    if (lag <= threshold)
        return lag;
    const now = Date.now();
    if (now - lastListenerLagAlertAt < resolveListenerLagAlertCooldownMs())
        return lag;
    lastListenerLagAlertAt = now;
    (0, logger_1.logger)(safe_1.default.red(`[validatorDepositRedeemListener] ALERT: checkpoint lag ${lag} blocks (checkpoint=${prior}, head=${head}, threshold=${threshold}) — run incremental backfill`));
    scheduleLiveListenerRebuild(`checkpoint lag ${lag} blocks`);
    return lag;
}
async function runIncrementalListenerBackfill(reason) {
    if (!listenerContext)
        return;
    if (listenerBackfillInFlight) {
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListener] incremental backfill skipped (${reason}): prior tick in flight`));
        return;
    }
    listenerBackfillInFlight = true;
    const { contract, nodeIp, deployFloor } = listenerContext;
    try {
        const provider = conetProvider();
        const liveHead = await provider.getBlockNumber();
        const lag = await maybeAlertListenerCheckpointLag(contract, deployFloor, liveHead);
        const prior = loadListenerBlockCheckpoint(contract, deployFloor);
        if (prior == null) {
            (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListener] incremental backfill skipped (${reason}): no checkpoint yet`));
            return;
        }
        const raw = readListenerBlockCheckpointRaw(contract, deployFloor);
        const caughtUp = raw?.scanTargetBlock == null || prior >= (raw.scanTargetBlock ?? prior);
        if (caughtUp) {
            saveListenerScanTargetBlock(contract, liveHead);
            (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] new backfill session scanTargetBlock=${liveHead} (lastProcessed=${prior})`));
        }
        else if (raw?.scanTargetBlock != null) {
            (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] catch-up toward scanTargetBlock=${raw.scanTargetBlock} (lastProcessed=${prior}, liveHead=${liveHead})`));
        }
        const scanTargetBlock = readListenerBlockCheckpointRaw(contract, deployFloor)?.scanTargetBlock ?? liveHead;
        const fromBlock = prior + 1;
        if (fromBlock > scanTargetBlock)
            return;
        const chunk = resolveListenerLogChunk();
        const chunksPerTick = resolveListenerBackfillChunksPerTick();
        const maxBlocksThisTick = chunk * chunksPerTick;
        const tickEnd = Math.min(fromBlock + maxBlocksThisTick - 1, scanTargetBlock);
        (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] incremental backfill ${fromBlock}..${tickEnd} (target=${scanTargetBlock}, liveHead=${liveHead}, ${reason}, lag=${lag})`));
        await backfillValidatorDepositRedeemListenerEvents(contract, nodeIp, fromBlock, tickEnd, deployFloor);
        if (rebuildLiveListenersEachBackfillTick() || lag > resolveListenerLagAlertBlocks()) {
            scheduleLiveListenerRebuild(`after incremental backfill (${reason})`);
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red(`[validatorDepositRedeemListener] incremental backfill failed (${reason}):`), msg);
    }
    finally {
        listenerBackfillInFlight = false;
    }
}
function scheduleListenerBackfillTick() {
    if (!listenerStarted)
        return;
    listenerBackfillTimer = setTimeout(async () => {
        await runIncrementalListenerBackfill('periodic tick');
        scheduleListenerBackfillTick();
    }, resolveListenerBackfillTickMs());
}
async function rebuildLiveListeners(reason) {
    if (!listenerContext || liveListenerRebuildInFlight)
        return;
    liveListenerRebuildInFlight = true;
    const { contract, nodeIp, deployFloor } = listenerContext;
    try {
        if (listenerContract) {
            listenerContract.removeAllListeners();
        }
        const provider = conetProvider();
        const head = await provider.getBlockNumber();
        const prior = loadListenerBlockCheckpoint(contract, deployFloor);
        if (prior != null && prior < head) {
            saveListenerScanTargetBlock(contract, head, { force: true });
        }
        listenerContract = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
        attachValidatorDepositRedeemLiveListeners(listenerContract, contract, nodeIp);
        liveListenFromBlock = head + 1;
        (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListener] live listeners rebuilt (${reason}); live from block ${liveListenFromBlock}`));
        if (prior != null && prior < head) {
            void runIncrementalListenerBackfill(`live rebuild (${reason})`);
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] live listener rebuild failed:'), msg);
    }
    finally {
        liveListenerRebuildInFlight = false;
    }
}
function shouldHandleLiveListenerBlock(blockNumber) {
    // Before boundary is resolved, accept live events (dedup handles any overlap with backfill).
    if (liveListenFromBlock <= 0)
        return true;
    return blockNumber >= liveListenFromBlock;
}
/** Prevents duplicate work when backfill and live subscription overlap on the same event. */
const listenerEventInFlight = new Set();
const LISTENER_ONCHAIN_LOG_PREFIX = '[validatorDepositRedeemListener]';
function enqueueListenerOnchainWork(label, fn) {
    return (0, onchainTxSerialQueue_1.enqueueOnchainTxWork)(onchainTxSerialQueue_1.CONET_VALIDATOR_NODE_ONCHAIN_LANE, label, fn, LISTENER_ONCHAIN_LOG_PREFIX);
}
/** Wait until the serial on-chain queue is idle (for graceful SIGTERM). */
async function waitForListenerSerialQueue(maxWaitMs = 30 * 60 * 1000) {
    await (0, onchainTxSerialQueue_1.waitForOnchainTxQueue)(onchainTxSerialQueue_1.CONET_VALIDATOR_NODE_ONCHAIN_LANE, maxWaitMs);
}
function tryBeginListenerEvent(key) {
    if (listenerEventInFlight.has(key))
        return false;
    listenerEventInFlight.add(key);
    return true;
}
function endListenerEvent(key) {
    listenerEventInFlight.delete(key);
}
const LISTENER_EVENT_NAMES = [
    'ValidatorRedeemClaimed',
    'NodeValidatorBeneficiaryUpdated',
    'FullExitRequested',
];
const VALIDATOR_DEPOSIT_REDEEM_IFACE = new ethers_1.ethers.Interface(VALIDATOR_DEPOSIT_REDEEM_ABI);
function isStaleRunningRedeemState(existing) {
    if (!existing || existing.status !== 'running')
        return false;
    const updatedAt = Date.parse(existing.updatedAt || '');
    const staleMs = Number(process.env.CONET_VALIDATOR_REDEEM_STALE_RUNNING_MS || 10 * 60 * 1000);
    if (!Number.isFinite(updatedAt) || staleMs <= 0)
        return false;
    return Date.now() - updatedAt >= staleMs;
}
async function handleValidatorRedeemClaimedEvent(contract, nodeIp, args, blockNumber) {
    noteListenerBlock(contract, blockNumber);
    const target = normalizeIp(args.targetNodeIp);
    const rid = args.requestId.toLowerCase();
    const flightKey = `claim:${rid}`;
    if (!tryBeginListenerEvent(flightKey))
        return;
    try {
        if (target !== nodeIp) {
            upsertState(rid, () => ({
                requestId: rid,
                codeHash: args.codeHash,
                claimer: ethers_1.ethers.getAddress(args.claimer),
                beneficiary: ethers_1.ethers.getAddress(args.beneficiary),
                validatorCount: args.validatorCount,
                targetNodeIp: target,
                conetDepinNodeIps: args.conetDepinNodeIps.map(normalizeIp),
                gbMiningNodeCount: args.gbMiningNodeCount,
                status: 'ignored',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                stages: { filter: { ok: true, at: new Date().toISOString(), detail: `target ${target} != local ${nodeIp}` } },
            }));
            return;
        }
        const existing = getValidatorDepositRedeemStatus(rid);
        if (existing?.status === 'succeeded')
            return;
        if (existing?.status === 'running' && !isStaleRunningRedeemState(existing))
            return;
        if (existing?.status === 'running' && isStaleRunningRedeemState(existing)) {
            (0, logger_1.logger)(safe_1.default.yellow(`[validatorDepositRedeemListener] retry stale running claim ${rid.slice(0, 12)}…`));
        }
        await enqueueListenerOnchainWork(`claim ${rid.slice(0, 12)}…`, async () => {
            const next = upsertState(rid, () => ({
                requestId: rid,
                codeHash: args.codeHash,
                claimer: ethers_1.ethers.getAddress(args.claimer),
                beneficiary: ethers_1.ethers.getAddress(args.beneficiary),
                validatorCount: args.validatorCount,
                targetNodeIp: target,
                conetDepinNodeIps: args.conetDepinNodeIps.map(normalizeIp),
                gbMiningNodeCount: args.gbMiningNodeCount,
                status: 'received',
                createdAt: existing?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                stages: { event: { ok: true, at: new Date().toISOString(), detail: `block=${blockNumber}` } },
            }));
            try {
                upsertState(rid, (cur) => ({ ...(cur || next), status: 'running', updatedAt: new Date().toISOString() }));
                await executeValidatorRedeem(next);
                upsertState(rid, (cur) => ({ ...(cur || next), status: 'succeeded', updatedAt: new Date().toISOString() }));
            }
            catch (e) {
                const msg = e?.message ?? String(e);
                (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] execute failed:'), msg);
                upsertState(rid, (cur) => ({ ...(cur || next), status: 'failed', error: msg, updatedAt: new Date().toISOString() }));
            }
        });
    }
    finally {
        endListenerEvent(flightKey);
    }
}
async function dispatchValidatorDepositRedeemListenerLog(contract, nodeIp, parsed, blockNumber) {
    switch (parsed.name) {
        case 'ValidatorRedeemClaimed':
            await handleValidatorRedeemClaimedEvent(contract, nodeIp, {
                requestId: String(parsed.args.requestId),
                codeHash: String(parsed.args.codeHash),
                claimer: String(parsed.args.claimer),
                beneficiary: String(parsed.args.beneficiary),
                validatorCount: String(parsed.args.validatorCount),
                targetNodeIp: String(parsed.args.targetNodeIp),
                conetDepinNodeIps: parsed.args.conetDepinNodeIps || [],
                gbMiningNodeCount: String(parsed.args.gbMiningNodeCount),
            }, blockNumber);
            return;
        case 'NodeValidatorBeneficiaryUpdated':
            noteListenerBlock(contract, blockNumber);
            await executeFeeRecipientHotUpdate({
                contract,
                guardianId: BigInt(String(parsed.args.guardianId)),
                toBeneficiary: ethers_1.ethers.getAddress(String(parsed.args.toBeneficiary)),
                pubkeyHash: String(parsed.args.pubkeyHash),
            });
            return;
        case 'FullExitRequested':
            noteListenerBlock(contract, blockNumber);
            await executeValidatorFullExit({
                contract,
                beneficiary: ethers_1.ethers.getAddress(String(parsed.args.beneficiary)),
                guardianIds: parsed.args.guardianIds.map((g) => BigInt(String(g))),
            });
            return;
        default:
            return;
    }
}
async function backfillValidatorDepositRedeemListenerEvents(contract, nodeIp, fromBlock, toBlock, deployFloor) {
    const safeFrom = listenerBackfillFromBlock(fromBlock, deployFloor);
    if (safeFrom > toBlock)
        return;
    const provider = conetProvider();
    const topics = LISTENER_EVENT_NAMES.map((name) => VALIDATOR_DEPOSIT_REDEEM_IFACE.getEvent(name).topicHash);
    const chunk = resolveListenerLogChunk();
    (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] backfill blocks ${safeFrom}..${toBlock} (chunk=${chunk}) contract=${contract}`));
    for (let start = safeFrom; start <= toBlock; start += chunk) {
        const end = Math.min(toBlock, start + chunk - 1);
        let logs;
        try {
            logs = await provider.getLogs({
                address: contract,
                fromBlock: start,
                toBlock: end,
                topics: [topics],
            });
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            (0, logger_1.logger)(safe_1.default.red(`[validatorDepositRedeemListener] getLogs failed ${start}-${end}:`), msg);
            throw e;
        }
        logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
        for (const log of logs) {
            let parsed;
            try {
                parsed = VALIDATOR_DEPOSIT_REDEEM_IFACE.parseLog(log);
            }
            catch {
                continue;
            }
            if (!parsed)
                continue;
            await dispatchValidatorDepositRedeemListenerLog(contract, nodeIp, parsed, log.blockNumber);
        }
        saveListenerBlockCheckpoint(contract, end);
        (0, logger_1.logger)(safe_1.default.green(`[validatorDepositRedeemListener] backfill checkpoint block ${end}/${toBlock}`));
    }
}
async function runValidatorDepositRedeemListenerBackfill(contract, nodeIp, priorSaved, backfillToBlock, deployFloor, liveFromBlock) {
    let fromBlock = null;
    if (priorSaved != null) {
        fromBlock = priorSaved + 1;
    }
    else {
        const envFrom = process.env.CONET_VALIDATOR_REDEEM_LISTENER_FROM_BLOCK?.trim();
        if (envFrom) {
            const catchupFrom = Number(envFrom);
            if (!Number.isFinite(catchupFrom) || catchupFrom < 0) {
                throw new Error(`invalid CONET_VALIDATOR_REDEEM_LISTENER_FROM_BLOCK: ${envFrom}`);
            }
            fromBlock = Math.floor(catchupFrom);
        }
    }
    if (fromBlock == null) {
        (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] backfill skipped: no prior checkpoint (live from block ${liveFromBlock})`));
        return;
    }
    if (fromBlock > backfillToBlock) {
        (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] backfill skipped: gap empty (${fromBlock} > ${backfillToBlock}, live from ${liveFromBlock})`));
        return;
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] backfill ${fromBlock}..${backfillToBlock} (prior=${priorSaved ?? 'none'}, live from ${liveFromBlock}, deployFloor=${deployFloor})`));
    await backfillValidatorDepositRedeemListenerEvents(contract, nodeIp, fromBlock, backfillToBlock, deployFloor);
}
function attachValidatorDepositRedeemLiveListeners(c, contract, nodeIp) {
    (0, logger_1.logger)(safe_1.default.green(`[validatorDepositRedeemListener] attaching live listeners contract=${contract} nodeIp=${nodeIp}`));
    c.on('ValidatorRedeemClaimed', (requestId, codeHash, claimer, beneficiary, validatorCount, targetNodeIp, conetDepinNodeIps, gbMiningNodeCount, ev) => {
        const blockNumber = ev?.log?.blockNumber ?? 0;
        if (!shouldHandleLiveListenerBlock(blockNumber))
            return;
        void handleValidatorRedeemClaimedEvent(contract, nodeIp, {
            requestId: String(requestId),
            codeHash: String(codeHash),
            claimer: String(claimer),
            beneficiary: String(beneficiary),
            validatorCount: String(validatorCount),
            targetNodeIp: String(targetNodeIp),
            conetDepinNodeIps: conetDepinNodeIps || [],
            gbMiningNodeCount: String(gbMiningNodeCount),
        }, blockNumber).catch((e) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] live ValidatorRedeemClaimed failed:'), e?.message ?? String(e));
        });
    });
    c.on('NodeValidatorBeneficiaryUpdated', (guardianId, pubkeyHash, _fromBeneficiary, toBeneficiary, ev) => {
        const blockNumber = ev?.log?.blockNumber ?? 0;
        if (!shouldHandleLiveListenerBlock(blockNumber))
            return;
        noteListenerBlock(contract, blockNumber);
        void executeFeeRecipientHotUpdate({
            contract,
            guardianId: BigInt(String(guardianId)),
            toBeneficiary: ethers_1.ethers.getAddress(String(toBeneficiary)),
            pubkeyHash: String(pubkeyHash),
        }).catch((e) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] fee_recipient hot-update failed:'), e?.message ?? String(e));
        });
    });
    c.on('FullExitRequested', (beneficiary, guardianIds, ev) => {
        const blockNumber = ev?.log?.blockNumber ?? 0;
        if (!shouldHandleLiveListenerBlock(blockNumber))
            return;
        noteListenerBlock(contract, blockNumber);
        void executeValidatorFullExit({
            contract,
            beneficiary: ethers_1.ethers.getAddress(String(beneficiary)),
            guardianIds: guardianIds.map((g) => BigInt(String(g))),
        }).catch((e) => {
            (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] full exit failed:'), e?.message ?? String(e));
        });
    });
}
/** After live attach: next block live owns; checkpoint = that block - 1; backfill fills only below. */
async function resolveLiveListenBoundary(provider) {
    const head = await provider.getBlockNumber();
    const liveFrom = head + 1;
    return { liveListenFromBlock: liveFrom, checkpointBlock: liveFrom - 1 };
}
async function bootstrapValidatorDepositRedeemListener() {
    const contract = resolveValidatorDepositRedeemAddress();
    const nodeIp = resolveValidatorNodeIp();
    if (!contract || !nodeIp) {
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] missing contract or nodeIp'));
        return;
    }
    const provider = conetProvider();
    const deployFloor = resolveListenerDeployBlockFloor();
    const priorSaved = loadListenerBlockCheckpoint(contract, deployFloor);
    listenerContext = { contract, nodeIp, deployFloor };
    ensureConetProviderListenerHooks();
    listenerContract = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, provider);
    attachValidatorDepositRedeemLiveListeners(listenerContract, contract, nodeIp);
    const { liveListenFromBlock: liveFrom, checkpointBlock } = await resolveLiveListenBoundary(provider);
    liveListenFromBlock = liveFrom;
    if (priorSaved != null && priorSaved < checkpointBlock) {
        saveListenerScanTargetBlock(contract, checkpointBlock, { force: true });
    }
    (0, logger_1.logger)(safe_1.default.green(`[validatorDepositRedeemListener] live from block ${liveFrom}; backfill target=${checkpointBlock} (prior=${priorSaved ?? 'none'}); tick=${resolveListenerBackfillTickMs()}ms lagAlert>${resolveListenerLagAlertBlocks()} blocks`));
    void runValidatorDepositRedeemListenerBackfill(contract, nodeIp, priorSaved, checkpointBlock, deployFloor, liveFrom)
        .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] bootstrap backfill failed:'), msg);
    })
        .finally(() => {
        scheduleListenerBackfillTick();
    });
}
function stopValidatorDepositRedeemListener() {
    listenerStarted = false;
    if (listenerBackfillTimer !== undefined) {
        clearTimeout(listenerBackfillTimer);
        listenerBackfillTimer = undefined;
    }
    if (liveListenerRebuildTimer !== undefined) {
        clearTimeout(liveListenerRebuildTimer);
        liveListenerRebuildTimer = undefined;
    }
    pendingLiveListenerRebuild = false;
    if (listenerContract) {
        listenerContract.removeAllListeners();
        listenerContract = null;
    }
    listenerContext = null;
    liveListenFromBlock = 0;
}
/** One-shot replay for a missed local ValidatorRedeemClaimed (manual Plan A catch-up). */
async function replayValidatorRedeemClaimedEvent(requestId) {
    const contract = resolveValidatorDepositRedeemAddress();
    const nodeIp = resolveValidatorNodeIp();
    if (!contract || !nodeIp)
        throw new Error('missing contract or nodeIp');
    if (!ethers_1.ethers.isHexString(requestId, 32))
        throw new Error(`invalid requestId: ${requestId}`);
    const rid = requestId.toLowerCase();
    const existing = getValidatorDepositRedeemStatus(rid);
    if (existing?.status === 'succeeded') {
        (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] replay skip ${rid.slice(0, 12)}… already succeeded`));
        return existing;
    }
    const provider = conetProvider();
    const topic = VALIDATOR_DEPOSIT_REDEEM_IFACE.getEvent('ValidatorRedeemClaimed').topicHash;
    const logs = await provider.getLogs({
        address: contract,
        fromBlock: resolveListenerDeployBlockFloor(),
        toBlock: 'latest',
        topics: [topic, rid],
    });
    if (!logs.length)
        throw new Error(`no ValidatorRedeemClaimed log for ${rid}`);
    const log = logs[logs.length - 1];
    const parsed = VALIDATOR_DEPOSIT_REDEEM_IFACE.parseLog(log);
    if (!parsed)
        throw new Error('parseLog failed');
    (0, logger_1.logger)(safe_1.default.cyan(`[validatorDepositRedeemListener] replay claim ${rid.slice(0, 12)}… block=${log.blockNumber} count=${String(parsed.args.validatorCount)}`));
    await handleValidatorRedeemClaimedEvent(contract, nodeIp, {
        requestId: String(parsed.args.requestId),
        codeHash: String(parsed.args.codeHash),
        claimer: String(parsed.args.claimer),
        beneficiary: String(parsed.args.beneficiary),
        validatorCount: String(parsed.args.validatorCount),
        targetNodeIp: String(parsed.args.targetNodeIp),
        conetDepinNodeIps: parsed.args.conetDepinNodeIps || [],
        gbMiningNodeCount: String(parsed.args.gbMiningNodeCount),
    }, log.blockNumber);
    await waitForListenerSerialQueue();
    await waitForRunCommandChildren();
    return getValidatorDepositRedeemStatus(rid);
}
// ─── Genesis Node Seat fulfill (x402 settle → bindSale + LockMint → createRedeemFor + claimRedeemFor) ───
const GENESIS_VAULT_BIND_ABI = [
    'function bindSale(bytes32 operationId,address referrer,address buyer,uint256 qty,bool testMode)',
    'function saleTestModePermanentlyDisabled() view returns (bool)',
];
const TREASURY_LOCK_MINT_ABI = [
    'function initiateLockMint(uint256 destinationChainId,address sourceAsset,address destinationAsset,address[] beneficiaries,uint256[] amounts,bytes32 sourceTxHash,uint256 nonce,address callbackTarget) returns (bytes32)',
    'function destinationFeeBps(uint256 destinationChainId) view returns (uint256)',
];
const ERC20_APPROVE_ABI = [
    'function approve(address spender,uint256 amount) returns (bool)',
    'function allowance(address owner,address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
];
/** TreasuryBridgeV3.AssetMode.LockMint */
const ASSET_MODE_LOCK_MINT = 1;
function computeLockMintOperationId(params) {
    const coder = ethers_1.ethers.AbiCoder.defaultAbiCoder();
    const beneficiariesHash = ethers_1.ethers.keccak256(coder.encode(['address[]', 'uint256[]'], [params.beneficiaries, params.amounts]));
    return ethers_1.ethers.keccak256(coder.encode([
        'uint256',
        'uint256',
        'address',
        'address',
        'address',
        'bytes32',
        'uint8',
        'uint256',
        'uint256',
        'bytes32',
        'uint256',
        'address',
    ], [
        params.sourceChainId,
        params.destinationChainId,
        params.sourceTreasury,
        params.sourceAsset,
        params.destinationAsset,
        beneficiariesHash,
        ASSET_MODE_LOCK_MINT,
        params.grossAmount,
        params.feeAmount,
        params.sourceTxHash,
        params.nonce,
        params.callbackTarget,
    ]));
}
async function withGenesisBridgeInitiatorWallet(fn) {
    return (0, settleContractPool_1.withGenesisBridgeInitiatorBoth)(fn);
}
exports.genesisNodeSeatFulfillPool = [];
function resolveGenesisNodeSeatFulfillFile() {
    return (process.env.CONET_GENESIS_NODE_SEAT_FULFILL_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-genesis-node-seat-fulfill.json'));
}
function readGenesisNodeSeatFulfillFile() {
    const file = resolveGenesisNodeSeatFulfillFile();
    if (!node_fs_1.default.existsSync(file))
        return {};
    try {
        return JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeGenesisNodeSeatFulfillRecord(record) {
    const file = resolveGenesisNodeSeatFulfillFile();
    const all = readGenesisNodeSeatFulfillFile();
    all[record.USDC_tx.toLowerCase()] = record;
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf-8');
}
function lookupGenesisNodeSeatFulfill(usdcTx) {
    const key = usdcTx.trim().toLowerCase();
    if (!key)
        return null;
    return readGenesisNodeSeatFulfillFile()[key] || null;
}
function generateEphemeralRedeemCode() {
    // Memory-only secret; never log or persist plaintext.
    return `beamio-gens-${(0, node_crypto_1.randomBytes)(18).toString('base64url')}`;
}
function kickGenesisNodeSeatFulfillPoolPress() {
    void (0, exports.genesisNodeSeatFulfillProcess)().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[genesisNodeSeatFulfillProcess] kick error:'), msg);
    });
}
function scheduleGenesisNodeSeatFulfillPoolPress() {
    if (exports.genesisNodeSeatFulfillPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleGenesisInitiatorBoth)())
        kickGenesisNodeSeatFulfillPoolPress();
    else
        setTimeout(() => kickGenesisNodeSeatFulfillPoolPress(), 3000);
}
/**
 * Master: after Base USDC settle to GENESIS_NODE_BRIDGE_INITIATOR:
 * 1) bindSale on CoNET vault
 * 2) approve + initiateLockMint (callbackTarget = vault)
 * 3) createRedeemFor + claimRedeemFor (seat deploy; unchanged)
 * Idempotent on USDC_tx. Redeem plaintext code stays in-process memory only.
 */
const genesisNodeSeatFulfillProcess = async () => {
    const obj = exports.genesisNodeSeatFulfillPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleGenesisInitiatorBoth)()) {
        exports.genesisNodeSeatFulfillPool.unshift(obj);
        return setTimeout(() => void (0, exports.genesisNodeSeatFulfillProcess)(), 3000);
    }
    const usdcTx = String(obj.USDC_tx ?? '').trim();
    try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
            throw new Error('Invalid USDC_tx');
        }
        if (!ethers_1.ethers.isAddress(obj.beneficiary) || obj.qty <= 0n) {
            throw new Error('Invalid beneficiary or qty');
        }
        const existing = lookupGenesisNodeSeatFulfill(usdcTx);
        if (existing) {
            (0, logger_1.logger)(safe_1.default.cyan(`[genesisNodeSeatFulfill] idempotent hit USDC_tx=${usdcTx.slice(0, 12)}… create=${existing.createTxHash.slice(0, 12)}… claim=${existing.claimTxHash.slice(0, 12)}…`));
            (0, genesisNodeReferralIncome_1.recordGenesisNodeReferralPurchaseIncomeInBackground)({
                usdcTxHash: existing.USDC_tx,
                operationId: existing.operationId,
                bindTxHash: existing.bindTxHash,
                lockMintTxHash: existing.lockMintTxHash,
                buyer: existing.beneficiary,
                payer: existing.payer,
                qty: existing.qty,
                testMode: existing.testMode,
                referrer: existing.referrerL0 || null,
                purchasedAt: existing.fulfilledAt,
            });
            if (obj.res && !obj.res.headersSent) {
                obj.res
                    .status(200)
                    .json({
                    success: true,
                    idempotent: true,
                    beneficiary: existing.beneficiary,
                    qty: existing.qty,
                    USDC_tx: existing.USDC_tx,
                    operationId: existing.operationId,
                    bindTxHash: existing.bindTxHash,
                    lockMintTxHash: existing.lockMintTxHash,
                    createTxHash: existing.createTxHash,
                    claimTxHash: existing.claimTxHash,
                })
                    .end();
            }
            return;
        }
        const contract = resolveValidatorDepositRedeemAddress();
        if (!contract)
            throw new Error('CONET_VALIDATOR_DEPOSIT_REDEEM not configured');
        const targetNodeIp = resolveValidatorNodeIp();
        if (!isValidIpLike(targetNodeIp)) {
            throw new Error('CONET_VALIDATOR_NODE_IP not configured (required for genesisNodeSeat fulfill)');
        }
        const vault = ethers_1.ethers.getAddress(chainAddresses_1.CONET_GENESIS_NODE_REFERRAL_VAULT);
        const treasury = ethers_1.ethers.getAddress(chainAddresses_1.CONET_TREASURY);
        const beneficiary = ethers_1.ethers.getAddress(obj.beneficiary);
        const testMode = Boolean(obj.testMode);
        let saleReferrer = ethers_1.ethers.ZeroAddress;
        const refRaw = String(obj.referrerL0 ?? '').trim();
        if (refRaw && ethers_1.ethers.isAddress(refRaw)) {
            // Client field may be Admin, L0, or L1 — vault bindSale resolves the role.
            saleReferrer = ethers_1.ethers.getAddress(refRaw);
        }
        if (testMode) {
            const vaultRead = new ethers_1.ethers.Contract(vault, GENESIS_VAULT_BIND_ABI, conetProvider());
            const disabled = Boolean(await vaultRead.saleTestModePermanentlyDisabled());
            if (disabled) {
                throw new Error('Genesis vault sale testMode is permanently disabled');
            }
        }
        const lockAmount = testMode
            ? BigInt(obj.qty) * chainAddresses_1.GENESIS_NODE_SEAT_TEST_USDC6
            : obj.qty * chainAddresses_1.GENESIS_NODE_SEAT_USDC_PER_NODE6;
        const sourceTxHash = usdcTx;
        const nonce = BigInt(ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(16)));
        const bridgeResult = await (0, settleContractPool_1.withGenesisBridgeInitiatorBoth)(async (sc) => {
            const baseProvider = sc.walletBase.provider;
            const treasuryRead = new ethers_1.ethers.Contract(treasury, TREASURY_LOCK_MINT_ABI, baseProvider);
            const feeBps = (await treasuryRead.destinationFeeBps(chainAddresses_1.CONET_MAINNET_CHAIN_ID));
            const feeAmount = (lockAmount * feeBps) / 10000n;
            const beneficiaries = [vault];
            const amounts = [lockAmount];
            const operationId = computeLockMintOperationId({
                sourceChainId: 8453n,
                destinationChainId: BigInt(chainAddresses_1.CONET_MAINNET_CHAIN_ID),
                sourceTreasury: treasury,
                sourceAsset: ethers_1.ethers.getAddress(chainAddresses_1.USDC_BASE),
                destinationAsset: ethers_1.ethers.getAddress(chainAddresses_1.CONET_USDC),
                beneficiaries,
                amounts,
                grossAmount: lockAmount,
                feeAmount,
                sourceTxHash,
                nonce,
                callbackTarget: vault,
            });
            const vaultConet = new ethers_1.ethers.Contract(vault, GENESIS_VAULT_BIND_ABI, sc.walletConet);
            const bindTx = await vaultConet.bindSale(operationId, saleReferrer, beneficiary, obj.qty, testMode, {
                gasLimit: 300_000,
            });
            await bindTx.wait();
            const usdc = new ethers_1.ethers.Contract(chainAddresses_1.USDC_BASE, ERC20_APPROVE_ABI, sc.walletBase);
            const needApprove = lockAmount + feeAmount;
            const bal = (await usdc.balanceOf(sc.walletBase.address));
            if (bal < needApprove) {
                throw new Error(`Bridge initiator USDC balance ${bal.toString()} < required ${needApprove.toString()} (settle may have landed elsewhere)`);
            }
            const allowance = (await usdc.allowance(sc.walletBase.address, treasury));
            if (allowance < needApprove) {
                const approveTx = await usdc.approve(treasury, needApprove);
                await approveTx.wait();
            }
            const treasuryWrite = new ethers_1.ethers.Contract(treasury, TREASURY_LOCK_MINT_ABI, sc.walletBase);
            const mintTx = await treasuryWrite.initiateLockMint(chainAddresses_1.CONET_MAINNET_CHAIN_ID, ethers_1.ethers.getAddress(chainAddresses_1.USDC_BASE), ethers_1.ethers.getAddress(chainAddresses_1.CONET_USDC), beneficiaries, amounts, sourceTxHash, nonce, vault, { gasLimit: 500_000 });
            const mintReceipt = await mintTx.wait();
            if (mintReceipt?.status !== 1)
                throw new Error('initiateLockMint reverted');
            return {
                operationId,
                bindTxHash: bindTx.hash,
                lockMintTxHash: mintTx.hash,
            };
        });
        const adminWallet = loadRedeemAdminWallet();
        const admin = ethers_1.ethers.getAddress(adminWallet.address);
        const code = generateEphemeralRedeemCode();
        const codeHash = codeHashOf(code);
        const allowedClaimer = ethers_1.ethers.ZeroAddress;
        const referrer = ethers_1.ethers.ZeroAddress;
        const validatorCount = obj.qty;
        const gbMiningNodeCount = 0n;
        const airdrop = false;
        const validAfter = 0n;
        const validBefore = 0n;
        const now = Math.floor(Date.now() / 1000);
        const createDeadline = BigInt(now + 3600);
        const claimDeadline = BigInt(now + 3600);
        const read = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, conetProvider());
        const chainNonce = (await read.redeemAdminNonces(admin));
        const createMessage = {
            admin,
            codeHash,
            allowedClaimer,
            referrer,
            validatorCount,
            targetNodeIp,
            gbMiningNodeCount,
            airdrop,
            validAfter,
            validBefore,
            nonce: chainNonce,
            deadline: createDeadline,
        };
        const createSignature = await adminWallet.signTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorDepositRedeemCreateTypes, createMessage);
        const createTxHash = await withSettleWallet('genesisNodeSeatCreate', async (sc) => {
            const c = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.createRedeemFor(admin, codeHash, allowedClaimer, referrer, validatorCount, targetNodeIp, gbMiningNodeCount, airdrop, validAfter, validBefore, chainNonce, createDeadline, createSignature, { gasLimit: 1_800_000 });
            await tx.wait();
            return tx.hash;
        });
        if (!createTxHash)
            throw new Error('createRedeemFor failed (no settle wallet)');
        const claimMessage = {
            claimer: admin,
            codeHash,
            beneficiary,
            referrer,
            validatorCount,
            targetNodeIp,
            gbMiningNodeCount,
            deadline: claimDeadline,
        };
        const claimSignature = await adminWallet.signTypedData(validatorDepositRedeemEip712Domain(contract), exports.validatorDepositRedeemClaimTypes, claimMessage);
        const gasLimit = await resolveClaimRedeemForGasLimitWithEstimate(read, admin, beneficiary, code, claimDeadline, claimSignature, validatorCount);
        const claimTxHash = await withSettleWallet('genesisNodeSeatClaim', async (sc) => {
            const c = new ethers_1.ethers.Contract(contract, VALIDATOR_DEPOSIT_REDEEM_ABI, sc.walletConet);
            const tx = await c.claimRedeemFor(admin, beneficiary, code, claimDeadline, claimSignature, { gasLimit });
            const receipt = await tx.wait();
            if (receipt?.status !== 1) {
                throw new Error(`claimRedeemFor reverted (gasLimit=${gasLimit}, gasUsed=${receipt?.gasUsed?.toString() ?? '?'})`);
            }
            return tx.hash;
        });
        if (!claimTxHash)
            throw new Error('claimRedeemFor failed (no settle wallet)');
        const record = {
            beneficiary,
            qty: validatorCount.toString(),
            payer: ethers_1.ethers.isAddress(obj.payer) ? ethers_1.ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
            USDC_tx: usdcTx,
            usdcAmount6: String(obj.usdcAmount6 ?? ''),
            referrerL0: saleReferrer !== ethers_1.ethers.ZeroAddress ? saleReferrer : '',
            testMode,
            operationId: bridgeResult.operationId,
            bindTxHash: bridgeResult.bindTxHash,
            lockMintTxHash: bridgeResult.lockMintTxHash,
            createTxHash,
            claimTxHash,
            fulfilledAt: new Date().toISOString(),
        };
        writeGenesisNodeSeatFulfillRecord(record);
        (0, genesisNodeReferralIncome_1.recordGenesisNodeReferralPurchaseIncomeInBackground)({
            usdcTxHash: record.USDC_tx,
            operationId: record.operationId,
            bindTxHash: record.bindTxHash,
            lockMintTxHash: record.lockMintTxHash,
            buyer: record.beneficiary,
            payer: record.payer,
            qty: record.qty,
            testMode: record.testMode,
            referrer: record.referrerL0 || null,
            purchasedAt: record.fulfilledAt,
        });
        (0, logger_1.logger)(safe_1.default.green(`[genesisNodeSeatFulfill] OK USDC_tx=${usdcTx.slice(0, 12)}… qty=${record.qty} beneficiary=${beneficiary.slice(0, 10)}… op=${bridgeResult.operationId.slice(0, 12)}… create=${createTxHash.slice(0, 12)}… claim=${claimTxHash.slice(0, 12)}…`));
        if (obj.res && !obj.res.headersSent) {
            obj.res
                .status(200)
                .json({
                success: true,
                beneficiary,
                qty: record.qty,
                USDC_tx: usdcTx,
                operationId: bridgeResult.operationId,
                bindTxHash: bridgeResult.bindTxHash,
                lockMintTxHash: bridgeResult.lockMintTxHash,
                createTxHash,
                claimTxHash,
            })
                .end();
        }
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        if (String(msg).includes('GENESIS_BRIDGE_INITIATOR_BOTH_BUSY')) {
            exports.genesisNodeSeatFulfillPool.unshift(obj);
            return;
        }
        (0, logger_1.logger)(safe_1.default.red('[genesisNodeSeatFulfillProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent) {
            obj.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        scheduleGenesisNodeSeatFulfillPoolPress();
    }
};
exports.genesisNodeSeatFulfillProcess = genesisNodeSeatFulfillProcess;
exports.walletDepositFulfillPool = [];
function resolveWalletDepositFulfillFile() {
    return (process.env.CONET_WALLET_DEPOSIT_FULFILL_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-wallet-deposit-fulfill.json'));
}
function readWalletDepositFulfillFile() {
    const file = resolveWalletDepositFulfillFile();
    if (!node_fs_1.default.existsSync(file))
        return {};
    try {
        return JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeWalletDepositFulfillRecord(record) {
    const file = resolveWalletDepositFulfillFile();
    const all = readWalletDepositFulfillFile();
    all[record.USDC_tx.toLowerCase()] = record;
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf-8');
}
function lookupWalletDepositFulfill(usdcTx) {
    const key = usdcTx.trim().toLowerCase();
    if (!key)
        return null;
    return readWalletDepositFulfillFile()[key] || null;
}
function kickWalletDepositFulfillPoolPress() {
    void (0, exports.walletDepositFulfillProcess)().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[walletDepositFulfillProcess] kick error:'), msg);
    });
}
function scheduleWalletDepositFulfillPoolPress() {
    if (exports.walletDepositFulfillPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleGenesisInitiatorBase)())
        kickWalletDepositFulfillPoolPress();
    else
        setTimeout(() => kickWalletDepositFulfillPoolPress(), 3000);
}
/**
 * Master: after Base USDC settle to GENESIS_NODE_BRIDGE_INITIATOR,
 * approve + initiateLockMint with beneficiaries=[wallet] (EOA or AA), callbackTarget=0.
 * Idempotent on USDC_tx. No Genesis vault / redeem.
 */
const walletDepositFulfillProcess = async () => {
    const obj = exports.walletDepositFulfillPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleGenesisInitiatorBase)()) {
        exports.walletDepositFulfillPool.unshift(obj);
        return setTimeout(() => void (0, exports.walletDepositFulfillProcess)(), 3000);
    }
    const usdcTx = String(obj.USDC_tx ?? '').trim();
    try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
            throw new Error('Invalid USDC_tx');
        }
        if (!ethers_1.ethers.isAddress(obj.beneficiary)) {
            throw new Error('Invalid beneficiary');
        }
        const lockAmount = BigInt(String(obj.usdcAmount6 ?? '0'));
        if (lockAmount <= 0n) {
            throw new Error('Invalid usdcAmount6');
        }
        const existing = lookupWalletDepositFulfill(usdcTx);
        if (existing) {
            (0, logger_1.logger)(safe_1.default.cyan(`[walletDepositFulfill] idempotent hit USDC_tx=${usdcTx.slice(0, 12)}… lockMint=${existing.lockMintTxHash.slice(0, 12)}…`));
            if (obj.res && !obj.res.headersSent) {
                obj.res
                    .status(200)
                    .json({
                    success: true,
                    idempotent: true,
                    beneficiary: existing.beneficiary,
                    USDC_tx: existing.USDC_tx,
                    operationId: existing.operationId,
                    lockMintTxHash: existing.lockMintTxHash,
                })
                    .end();
            }
            return;
        }
        const treasury = ethers_1.ethers.getAddress(chainAddresses_1.CONET_TREASURY);
        const beneficiary = ethers_1.ethers.getAddress(obj.beneficiary);
        const sourceTxHash = usdcTx;
        const nonce = BigInt(ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(16)));
        const bridgeResult = await (0, settleContractPool_1.withGenesisBridgeInitiatorBase)(async (sc) => {
            const baseProvider = sc.walletBase.provider;
            const treasuryRead = new ethers_1.ethers.Contract(treasury, TREASURY_LOCK_MINT_ABI, baseProvider);
            const feeBps = (await treasuryRead.destinationFeeBps(chainAddresses_1.CONET_MAINNET_CHAIN_ID));
            const feeAmount = (lockAmount * feeBps) / 10000n;
            const beneficiaries = [beneficiary];
            const amounts = [lockAmount];
            const operationId = computeLockMintOperationId({
                sourceChainId: 8453n,
                destinationChainId: BigInt(chainAddresses_1.CONET_MAINNET_CHAIN_ID),
                sourceTreasury: treasury,
                sourceAsset: ethers_1.ethers.getAddress(chainAddresses_1.USDC_BASE),
                destinationAsset: ethers_1.ethers.getAddress(chainAddresses_1.CONET_USDC),
                beneficiaries,
                amounts,
                grossAmount: lockAmount,
                feeAmount,
                sourceTxHash,
                nonce,
                callbackTarget: ethers_1.ethers.ZeroAddress,
            });
            const usdc = new ethers_1.ethers.Contract(chainAddresses_1.USDC_BASE, ERC20_APPROVE_ABI, sc.walletBase);
            const needApprove = lockAmount + feeAmount;
            const bal = (await usdc.balanceOf(sc.walletBase.address));
            if (bal < needApprove) {
                throw new Error(`Bridge initiator USDC balance ${bal.toString()} < required ${needApprove.toString()} (settle may have landed elsewhere)`);
            }
            const allowance = (await usdc.allowance(sc.walletBase.address, treasury));
            if (allowance < needApprove) {
                const approveTx = await usdc.approve(treasury, needApprove);
                await approveTx.wait();
            }
            const treasuryWrite = new ethers_1.ethers.Contract(treasury, TREASURY_LOCK_MINT_ABI, sc.walletBase);
            const mintTx = await treasuryWrite.initiateLockMint(chainAddresses_1.CONET_MAINNET_CHAIN_ID, ethers_1.ethers.getAddress(chainAddresses_1.USDC_BASE), ethers_1.ethers.getAddress(chainAddresses_1.CONET_USDC), beneficiaries, amounts, sourceTxHash, nonce, ethers_1.ethers.ZeroAddress, { gasLimit: 500_000 });
            const mintReceipt = await mintTx.wait();
            if (mintReceipt?.status !== 1)
                throw new Error('initiateLockMint reverted');
            return {
                operationId,
                lockMintTxHash: mintTx.hash,
            };
        });
        const record = {
            beneficiary,
            payer: ethers_1.ethers.isAddress(obj.payer) ? ethers_1.ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
            USDC_tx: usdcTx,
            usdcAmount6: lockAmount.toString(),
            operationId: bridgeResult.operationId,
            lockMintTxHash: bridgeResult.lockMintTxHash,
            fulfilledAt: new Date().toISOString(),
        };
        writeWalletDepositFulfillRecord(record);
        (0, logger_1.logger)(safe_1.default.green(`[walletDepositFulfill] OK USDC_tx=${usdcTx.slice(0, 12)}… beneficiary=${beneficiary.slice(0, 10)}… op=${bridgeResult.operationId.slice(0, 12)}… lockMint=${bridgeResult.lockMintTxHash.slice(0, 12)}…`));
        if (obj.res && !obj.res.headersSent) {
            obj.res
                .status(200)
                .json({
                success: true,
                beneficiary,
                USDC_tx: usdcTx,
                operationId: bridgeResult.operationId,
                lockMintTxHash: bridgeResult.lockMintTxHash,
            })
                .end();
        }
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        if (String(msg).includes('GENESIS_BRIDGE_INITIATOR_BASE_BUSY')) {
            exports.walletDepositFulfillPool.unshift(obj);
            return;
        }
        (0, logger_1.logger)(safe_1.default.red('[walletDepositFulfillProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent) {
            obj.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        scheduleWalletDepositFulfillPoolPress();
    }
};
exports.walletDepositFulfillProcess = walletDepositFulfillProcess;
function startValidatorDepositRedeemListener() {
    if (listenerStarted)
        return;
    listenerStarted = true;
    if (process.env.CONET_VALIDATOR_REDEEM_LISTENER !== '1') {
        (0, logger_1.logger)(safe_1.default.yellow('[validatorDepositRedeemListener] disabled; set CONET_VALIDATOR_REDEEM_LISTENER=1'));
        listenerStarted = false;
        return;
    }
    void bootstrapValidatorDepositRedeemListener().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[validatorDepositRedeemListener] bootstrap failed:'), msg);
    });
}
