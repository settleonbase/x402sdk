"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gbDepinAirdropAllPool = exports.gbDepinChargeUserPool = void 0;
exports.kickGbDepinChargeUserPoolPress = kickGbDepinChargeUserPoolPress;
exports.gbDepinChargeUserPoolPress = gbDepinChargeUserPoolPress;
exports.kickGbDepinAirdropAllPoolPress = kickGbDepinAirdropAllPoolPress;
exports.gbDepinAirdropAllPoolPress = gbDepinAirdropAllPoolPress;
exports.gbDepinChargeUserClusterPreCheck = gbDepinChargeUserClusterPreCheck;
exports.gbDepinAirdropAllClusterPreCheck = gbDepinAirdropAllClusterPreCheck;
exports.startGbDepinAirdropCron = startGbDepinAirdropCron;
exports.stopGbDepinAirdropCron = stopGbDepinAirdropCron;
/**
 * GBDepinAirdrop — Master pool + Cluster precheck (GBToken V2 consumeGb + protocol cron mint).
 */
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const chainAddresses_1 = require("./chainAddresses");
const settleContractPool_1 = require("./settleContractPool");
const util_1 = require("./util");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
const GB_DEPIN_AIRDROP_ABI = [
    'function chargeUserGbForGuardianNode(uint256 guardianNodeId, address user, uint256 amount) returns (uint256 freeBurned, uint256 paidBurned)',
    'function airdropDepinPaidAll() returns (uint256 nodesMinted, uint256 nodesRegistered, uint256 totalGbMinted)',
    'function airdropDepinPaidPage(uint256 start, uint256 length, bool advanceGlobalClock) returns (uint256 nodesMinted, uint256 nodesRegistered, uint256 totalGbMinted)',
    'function paidRecipientOfGuardianNode(uint256 guardianNodeId) view returns (address)',
    'function previewStandardPaidOwed(uint256 timestamp) view returns (uint256 owed, uint256 elapsedSeconds, uint256 perSecond)',
    'function paidGbReceivedOf(address beneficiary) view returns (uint256)',
    'function paidGbReceivedOfGuardianNode(uint256 guardianNodeId) view returns (uint256)',
    'function paidGbSummaryOf(address beneficiary, uint256 anchorTs) view returns (tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year))',
    'function paidGbSummaryOfGuardianNode(uint256 guardianNodeId, uint256 anchorTs) view returns (tuple(uint256 cumulative, uint256 hour, uint256 day, uint256 week, uint256 month, uint256 year))',
];
const GUARDIAN_NODES_PAGE_ABI = [
    'function getAllNodes(uint256 start, uint256 length) view returns (tuple(uint256 id,string PGP,string PGPKey,string ip_addr,string regionName)[] allNodes)',
];
const GB_TOKEN_BALANCE_ABI = ['function balanceOfAll(address account) view returns (uint256 total, uint256 free, uint256 paid)'];
let conetReadProvider;
function conetProvider() {
    if (!conetReadProvider) {
        conetReadProvider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)(), undefined, { batchMaxCount: 1 });
    }
    return conetReadProvider;
}
function requireAirdropAddress() {
    const addr = (0, chainAddresses_1.resolveConetGbDepinAirdropAddress)();
    if (!addr)
        throw new Error('CONET_GB_DEPIN_AIRDROP not configured');
    return addr;
}
exports.gbDepinChargeUserPool = [];
exports.gbDepinAirdropAllPool = [];
let gbDepinChargeUserRunning = false;
let gbDepinAirdropAllRunning = false;
let gbDepinCronTimer;
let gbDepinCronInFlight = false;
/** Resume index for multi-tick paginated cron (reset when global clock advances). */
let gbDepinCronPageStart = 0;
/** Wall-clock ms when cron first skipped due to gas > max (force execute after wait window). */
let gbDepinCronGasWaitStartedAt;
function kickGbDepinChargeUserPoolPress() {
    void gbDepinChargeUserPoolPress().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.red('[gbDepinChargeUserPoolPress] unhandled:'), msg);
    });
}
function scheduleGbDepinChargeUserPoolPress() {
    if (exports.gbDepinChargeUserPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleSettleConet)())
        kickGbDepinChargeUserPoolPress();
    else
        setTimeout(() => kickGbDepinChargeUserPoolPress(), 3000);
}
async function gbDepinChargeUserPoolPress() {
    if (gbDepinChargeUserRunning)
        return;
    gbDepinChargeUserRunning = true;
    const obj = exports.gbDepinChargeUserPool.shift();
    if (!obj) {
        gbDepinChargeUserRunning = false;
        return;
    }
    const sc = (0, settleContractPool_1.shiftSettleConet)();
    if (!sc) {
        exports.gbDepinChargeUserPool.unshift(obj);
        gbDepinChargeUserRunning = false;
        return scheduleGbDepinChargeUserPoolPress();
    }
    try {
        const airdrop = requireAirdropAddress();
        const c = new ethers_1.ethers.Contract(airdrop, GB_DEPIN_AIRDROP_ABI, sc.walletConet);
        const tx = await c.chargeUserGbForGuardianNode(obj.guardianNodeId, obj.user, obj.amount, { gasLimit: 500_000 });
        const receipt = await tx.wait();
        const parsed = receipt?.logs ? parseChargeReceipt(c, receipt.logs) : null;
        if (obj.res && !obj.res.headersSent) {
            obj.res.status(200).json({
                success: true,
                hash: tx.hash,
                freeBurned: parsed?.freeBurned.toString() ?? '0',
                paidBurned: parsed?.paidBurned.toString() ?? '0',
            }).end();
        }
    }
    catch (e) {
        const err = e;
        const msg = err?.shortMessage ?? err?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[gbDepinChargeUserPoolPress] failed:'), msg);
        if (obj.res && !obj.res.headersSent)
            obj.res.status(400).json({ success: false, error: msg }).end();
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(sc);
        gbDepinChargeUserRunning = false;
        scheduleGbDepinChargeUserPoolPress();
    }
}
function parseChargeReceipt(c, logs) {
    for (const log of logs) {
        try {
            const parsed = c.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'UserGbFeeCharged') {
                return {
                    freeBurned: BigInt(String(parsed.args.freeBurned ?? parsed.args[4] ?? 0)),
                    paidBurned: BigInt(String(parsed.args.paidBurned ?? parsed.args[5] ?? 0)),
                };
            }
        }
        catch {
            /* skip */
        }
    }
    return null;
}
function kickGbDepinAirdropAllPoolPress() {
    void gbDepinAirdropAllPoolPress().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.red('[gbDepinAirdropAllPoolPress] unhandled:'), msg);
    });
}
function scheduleGbDepinAirdropAllPoolPress() {
    if (exports.gbDepinAirdropAllPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleSettleConet)())
        kickGbDepinAirdropAllPoolPress();
    else
        setTimeout(() => kickGbDepinAirdropAllPoolPress(), 3000);
}
async function gbDepinAirdropAllPoolPress() {
    if (gbDepinAirdropAllRunning)
        return;
    gbDepinAirdropAllRunning = true;
    const obj = exports.gbDepinAirdropAllPool.shift();
    if (!obj) {
        gbDepinAirdropAllRunning = false;
        return;
    }
    const sc = (0, settleContractPool_1.shiftSettleConet)();
    if (!sc) {
        exports.gbDepinAirdropAllPool.unshift(obj);
        gbDepinAirdropAllRunning = false;
        return scheduleGbDepinAirdropAllPoolPress();
    }
    try {
        const airdrop = requireAirdropAddress();
        const c = new ethers_1.ethers.Contract(airdrop, GB_DEPIN_AIRDROP_ABI, sc.walletConet);
        const usePage = obj.pageStart !== undefined && obj.pageSize !== undefined;
        const maxGasLimit = resolveGbDepinAirdropMaxGasLimit();
        let gasLimit = maxGasLimit;
        if (usePage) {
            try {
                const est = await c.airdropDepinPaidPage.estimateGas(obj.pageStart, obj.pageSize, Boolean(obj.advanceGlobalClock));
                gasLimit = (est * 120n) / 100n + 50000n;
                if (gasLimit > maxGasLimit)
                    gasLimit = maxGasLimit;
            }
            catch {
                /* keep maxGasLimit */
            }
        }
        const tx = usePage
            ? await c.airdropDepinPaidPage(obj.pageStart, obj.pageSize, Boolean(obj.advanceGlobalClock), {
                gasLimit,
            })
            : await c.airdropDepinPaidAll({ gasLimit: maxGasLimit });
        const receipt = await tx.wait();
        if (obj.silent && usePage) {
            if (obj.advanceGlobalClock)
                gbDepinCronPageStart = 0;
            else
                gbDepinCronPageStart = (obj.pageStart ?? 0) + (obj.pageSize ?? 0);
        }
        if (obj.res && !obj.res.headersSent) {
            obj.res
                .status(200)
                .json({
                success: true,
                hash: tx.hash,
                blockNumber: receipt?.blockNumber,
                pageStart: obj.pageStart,
                pageSize: obj.pageSize,
                advanceGlobalClock: obj.advanceGlobalClock,
            })
                .end();
        }
        else if (obj.silent) {
            const pageInfo = usePage ? ` page=${obj.pageStart}+${obj.pageSize} advance=${obj.advanceGlobalClock ? '1' : '0'}` : '';
            clearGbDepinGasWait();
            (0, logger_1.logger)(safe_1.default.green(`[gbDepinAirdropCron] ok tx=${tx.hash}${pageInfo} admin=${sc.walletConet.address}`));
        }
    }
    catch (e) {
        const err = e;
        const msg = err?.shortMessage ?? err?.reason ?? err?.message ?? String(e);
        if (msg.includes('NothingToAirdrop') || msg.includes('Nothing to airdrop')) {
            if (obj.silent) {
                clearGbDepinGasWait();
                (0, logger_1.logger)(safe_1.default.gray('[gbDepinAirdropCron] nothing to airdrop'));
            }
            else if (obj.res && !obj.res.headersSent)
                obj.res.status(200).json({ success: true, skipped: true, reason: 'nothing_to_airdrop' }).end();
        }
        else {
            (0, logger_1.logger)(safe_1.default.red('[gbDepinAirdropAllPoolPress] failed:'), msg);
            if (obj.res && !obj.res.headersSent)
                obj.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(sc);
        gbDepinAirdropAllRunning = false;
        scheduleGbDepinAirdropAllPoolPress();
    }
}
async function gbDepinChargeUserClusterPreCheck(body) {
    try {
        const b = body;
        const nodeIdRaw = b.guardianNodeId;
        const nodeId = typeof nodeIdRaw === 'bigint'
            ? nodeIdRaw
            : typeof nodeIdRaw === 'number'
                ? BigInt(nodeIdRaw)
                : BigInt(String(nodeIdRaw ?? ''));
        if (nodeId <= 0n)
            return { success: false, error: 'invalid guardianNodeId' };
        if (!b.user || !ethers_1.ethers.isAddress(String(b.user)))
            return { success: false, error: 'invalid user address' };
        const user = ethers_1.ethers.getAddress(String(b.user));
        let amount;
        try {
            amount = BigInt(String(b.amount ?? ''));
        }
        catch {
            return { success: false, error: 'invalid amount' };
        }
        if (amount <= 0n)
            return { success: false, error: 'amount must be positive' };
        const airdropAddr = (0, chainAddresses_1.resolveConetGbDepinAirdropAddress)();
        if (!airdropAddr)
            return { success: false, error: 'GBDepinAirdrop not configured' };
        const provider = conetProvider();
        const airdrop = new ethers_1.ethers.Contract(airdropAddr, GB_DEPIN_AIRDROP_ABI, provider);
        const beneficiary = String(await airdrop.paidRecipientOfGuardianNode(nodeId));
        if (!beneficiary || beneficiary === ethers_1.ethers.ZeroAddress) {
            return { success: false, error: 'guardian node has no redeem beneficiary' };
        }
        const gb = new ethers_1.ethers.Contract(chainAddresses_1.CONET_GB_ERC20, GB_TOKEN_BALANCE_ABI, provider);
        const bal = (await gb.balanceOfAll(user));
        const total = bal[0] ?? 0n;
        if (total < amount)
            return { success: false, error: 'insufficient GB balance' };
        return { success: true, preChecked: { guardianNodeId: nodeId, user, amount } };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.shortMessage ?? err?.message ?? 'precheck failed' };
    }
}
async function gbDepinAirdropAllClusterPreCheck() {
    if (!(0, chainAddresses_1.resolveConetGbDepinAirdropAddress)())
        return { success: false, error: 'GBDepinAirdrop not configured' };
    try {
        const airdrop = new ethers_1.ethers.Contract(requireAirdropAddress(), GB_DEPIN_AIRDROP_ABI, conetProvider());
        const preview = (await airdrop.previewStandardPaidOwed(Math.floor(Date.now() / 1000)));
        const owed = preview[0] ?? 0n;
        if (owed <= 0n)
            return { success: false, error: 'nothing to airdrop yet' };
        return { success: true };
    }
    catch (e) {
        const err = e;
        return { success: false, error: err?.shortMessage ?? err?.message ?? 'precheck failed' };
    }
}
function resolveGbDepinCronIntervalMs() {
    const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_CRON_MS ?? 60_000);
    return Number.isFinite(raw) && raw >= 15_000 ? Math.floor(raw) : 60_000;
}
function resolveGbDepinAirdropPageSize() {
    /** ~3M gas @ 10 nodes; pageSize=100 can exceed 18M block gas on mainnet. */
    const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_PAGE_SIZE ?? 10);
    return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 500) : 10;
}
function resolveGbDepinAirdropMaxGasLimit() {
    const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_MAX_GAS_LIMIT ?? 18_000_000);
    return Number.isFinite(raw) && raw >= 500_000 ? BigInt(Math.floor(raw)) : 18000000n;
}
/** Only submit when eth_gasPrice ≤ this many gwei (default 2). CONET often sits at exactly 2.0 gwei — use ≤. */
function resolveGbDepinMaxGasPriceWei() {
    const gwei = Number(process.env.CONET_GB_DEPIN_AIRDROP_MAX_GAS_PRICE_GWEI ?? 2);
    const safe = Number.isFinite(gwei) && gwei > 0 ? gwei : 2;
    return ethers_1.ethers.parseUnits(String(safe), 'gwei');
}
/** After this many ms waiting on high gas, force one airdrop at live gasPrice (default 10 min). */
function resolveGbDepinGasWaitForceMs() {
    const raw = Number(process.env.CONET_GB_DEPIN_AIRDROP_GAS_WAIT_FORCE_MS ?? 600_000);
    return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 600_000;
}
function clearGbDepinGasWait() {
    gbDepinCronGasWaitStartedAt = undefined;
}
function formatGbDepinGasWaitCountdown(elapsedMs, forceMs) {
    const leftMs = Math.max(0, forceMs - elapsedMs);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const leftSec = Math.ceil(leftMs / 1000);
    const forceSec = Math.floor(forceMs / 1000);
    return `${elapsedSec}s/${forceSec}s (force in ${leftSec}s)`;
}
async function readConetGasPriceWei() {
    const provider = conetProvider();
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
/** Mid-pagination must finish; otherwise wait for gas ≤ max or force after wait window. */
async function resolveGbDepinCronGasGate() {
    if (gbDepinCronPageStart > 0) {
        return { run: true, force: false, gasPrice: await readConetGasPriceWei() };
    }
    const maxGas = resolveGbDepinMaxGasPriceWei();
    const gasDustWei = 50000000n; // 0.05 gwei — CONET quotes e.g. 2.000000007 gwei
    const gasPrice = await readConetGasPriceWei();
    const forceMs = resolveGbDepinGasWaitForceMs();
    if (gasPrice <= maxGas + gasDustWei) {
        clearGbDepinGasWait();
        return { run: true, force: false, gasPrice };
    }
    const now = Date.now();
    if (gbDepinCronGasWaitStartedAt === undefined)
        gbDepinCronGasWaitStartedAt = now;
    const elapsedMs = now - gbDepinCronGasWaitStartedAt;
    if (elapsedMs >= forceMs) {
        return { run: true, force: true, gasPrice };
    }
    return { run: false, gasPrice };
}
async function fetchGuardianNodesPageLength(start, maxLength) {
    const guardian = chainAddresses_1.CONET_GUARDIAN_NODES_INFO_V6;
    if (!guardian || !ethers_1.ethers.isAddress(guardian))
        return 0;
    const c = new ethers_1.ethers.Contract(guardian, GUARDIAN_NODES_PAGE_ABI, conetProvider());
    const page = (await c.getAllNodes(start, maxLength));
    return Array.isArray(page) ? page.length : 0;
}
async function gbDepinCronTick() {
    if (gbDepinCronInFlight)
        return;
    if (!(0, chainAddresses_1.resolveConetGbDepinAirdropAddress)())
        return;
    gbDepinCronInFlight = true;
    try {
        const gasGate = await resolveGbDepinCronGasGate();
        if (!gasGate.run) {
            const maxGas = resolveGbDepinMaxGasPriceWei();
            const forceMs = resolveGbDepinGasWaitForceMs();
            const elapsedMs = Date.now() - (gbDepinCronGasWaitStartedAt ?? Date.now());
            (0, logger_1.logger)(safe_1.default.yellow(`[gbDepinAirdropCron] skip tick: gasPrice=${ethers_1.ethers.formatUnits(gasGate.gasPrice, 'gwei')} gwei > max=${ethers_1.ethers.formatUnits(maxGas, 'gwei')} gwei ` +
                `wait ${formatGbDepinGasWaitCountdown(elapsedMs, forceMs)}`));
            return;
        }
        if (gasGate.force) {
            (0, logger_1.logger)(safe_1.default.yellow(`[gbDepinAirdropCron] force tick: gasPrice=${ethers_1.ethers.formatUnits(gasGate.gasPrice, 'gwei')} gwei exceeds max=${ethers_1.ethers.formatUnits(resolveGbDepinMaxGasPriceWei(), 'gwei')} gwei after ${Math.floor(resolveGbDepinGasWaitForceMs() / 1000)}s wait`));
        }
        if (gbDepinCronPageStart === 0) {
            const pre = await gbDepinAirdropAllClusterPreCheck();
            if (!pre.success)
                return;
        }
        const pageSize = resolveGbDepinAirdropPageSize();
        const pageLen = await fetchGuardianNodesPageLength(gbDepinCronPageStart, pageSize);
        const advanceGlobalClock = pageLen === 0 || pageLen < pageSize;
        const effectiveStart = gbDepinCronPageStart;
        const effectiveSize = pageLen === 0 ? 1 : pageLen;
        exports.gbDepinAirdropAllPool.push({
            silent: true,
            pageStart: effectiveStart,
            pageSize: effectiveSize,
            advanceGlobalClock,
        });
        kickGbDepinAirdropAllPoolPress();
    }
    finally {
        gbDepinCronInFlight = false;
    }
}
function scheduleGbDepinCron() {
    if (gbDepinCronTimer !== undefined)
        clearTimeout(gbDepinCronTimer);
    gbDepinCronTimer = setTimeout(async () => {
        try {
            await gbDepinCronTick();
        }
        finally {
            scheduleGbDepinCron();
        }
    }, resolveGbDepinCronIntervalMs());
}
/**
 * Master-only: paginated airdropDepinPaidPage cron when CONET_GB_DEPIN_AIRDROP_CRON=1.
 * Uses Settle_ContractPool (settle_contractAdmin ×4) as CoNET gas payers / GBDepinAirdrop admins.
 */
function startGbDepinAirdropCron() {
    if (process.env.CONET_GB_DEPIN_AIRDROP_CRON !== '1') {
        (0, logger_1.logger)(safe_1.default.gray('[gbDepinAirdropCron] disabled (set CONET_GB_DEPIN_AIRDROP_CRON=1)'));
        return;
    }
    if (!(0, chainAddresses_1.resolveConetGbDepinAirdropAddress)()) {
        (0, logger_1.logger)(safe_1.default.yellow('[gbDepinAirdropCron] disabled: CONET_GB_DEPIN_AIRDROP address missing'));
        return;
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[gbDepinAirdropCron] starting interval=${resolveGbDepinCronIntervalMs()}ms pageSize=${resolveGbDepinAirdropPageSize()} maxGasGwei=${ethers_1.ethers.formatUnits(resolveGbDepinMaxGasPriceWei(), 'gwei')} gasWaitForceMs=${resolveGbDepinGasWaitForceMs()} airdrop=${(0, chainAddresses_1.resolveConetGbDepinAirdropAddress)()} settleAdmins=${settleContractPool_1.Settle_ContractPool.length}`));
    void gbDepinCronTick().finally(() => scheduleGbDepinCron());
}
function stopGbDepinAirdropCron() {
    if (gbDepinCronTimer !== undefined) {
        clearTimeout(gbDepinCronTimer);
        gbDepinCronTimer = undefined;
    }
}
