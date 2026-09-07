"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFERRAL_REGISTRY_DEPLOY_BLOCK = void 0;
exports.ensureReferralRegistryTreeReady = ensureReferralRegistryTreeReady;
exports.rebuildReferralRegistryTreeNow = rebuildReferralRegistryTreeNow;
const ethers_1 = require("ethers");
const chainAddresses_1 = require("./chainAddresses");
const db_1 = require("./db");
const util_1 = require("./util");
exports.REFERRAL_REGISTRY_DEPLOY_BLOCK = 431_457;
const LOG_CHUNK_BLOCKS = 5_000;
const REFERRAL_REGISTRY_ABI = [
    'function admins(address) view returns (bool)',
    'function members(address) view returns (uint8 role,address parentAdmin,address parentL0,uint256 rebateBps,uint256 ratioBps,bool active)',
];
const MEMBER_REGISTERED_EVENT = 'MemberRegistered(address indexed account,uint8 role,address indexed parentL0,address indexed parentAdmin)';
const ADMIN_UPDATED_EVENT = 'AdminUpdated(address indexed account,bool enabled)';
const EVENT_INTERFACE = new ethers_1.ethers.Interface([
    `event ${MEMBER_REGISTERED_EVENT}`,
    `event ${ADMIN_UPDATED_EVENT}`,
]);
const MEMBER_REGISTERED_TOPIC = ethers_1.ethers.id('MemberRegistered(address,uint8,address,address)');
const ADMIN_UPDATED_TOPIC = ethers_1.ethers.id('AdminUpdated(address,bool)');
let backfillInFlight;
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function roleFromValue(value) {
    if (value === 1)
        return 'l0';
    if (value === 2)
        return 'l1';
    if (value === 3)
        return 'merchant';
    return 'none';
}
async function scanRegisteredAccounts(provider, latestBlock) {
    const accounts = new Set();
    for (let fromBlock = exports.REFERRAL_REGISTRY_DEPLOY_BLOCK; fromBlock <= latestBlock; fromBlock += LOG_CHUNK_BLOCKS) {
        const toBlock = Math.min(fromBlock + LOG_CHUNK_BLOCKS - 1, latestBlock);
        const logs = await provider.getLogs({
            address: chainAddresses_1.CONET_REFERRAL_REGISTRY_VAULT_V1,
            fromBlock,
            toBlock,
            topics: [[MEMBER_REGISTERED_TOPIC, ADMIN_UPDATED_TOPIC]],
        });
        for (const log of logs) {
            const parsed = EVENT_INTERFACE.parseLog(log);
            if (!parsed)
                continue;
            const account = parsed.args.account;
            if (ethers_1.ethers.isAddress(account))
                accounts.add(ethers_1.ethers.getAddress(account));
        }
    }
    return accounts;
}
async function rebuildReferralRegistryTree() {
    const provider = new ethers_1.ethers.JsonRpcProvider((0, util_1.resolveBeamioConetHttpRpcUrl)());
    const registry = new ethers_1.ethers.Contract(chainAddresses_1.CONET_REFERRAL_REGISTRY_VAULT_V1, REFERRAL_REGISTRY_ABI, provider);
    const latestBlock = await provider.getBlockNumber();
    const accounts = await scanRegisteredAccounts(provider, latestBlock);
    const rows = [];
    for (const account of accounts) {
        const [isAdmin, member] = await Promise.all([
            registry.admins(account),
            registry.members(account),
        ]);
        rows.push({
            account,
            isAdmin: Boolean(isAdmin),
            role: roleFromValue(Number(member.role)),
            parentAdmin: ethers_1.ethers.getAddress(member.parentAdmin) === ethers_1.ethers.ZeroAddress ? null : ethers_1.ethers.getAddress(member.parentAdmin),
            parentL0: ethers_1.ethers.getAddress(member.parentL0) === ethers_1.ethers.ZeroAddress ? null : ethers_1.ethers.getAddress(member.parentL0),
            rebateBps: member.rebateBps.toString(),
            ratioBps: member.ratioBps.toString(),
            active: Boolean(member.active),
            firstSeenBlock: null,
            lastSeenBlock: null,
            lastTxHash: null,
        });
    }
    await (0, db_1.replaceReferralRegistryTreeMembers)(rows, String(latestBlock));
}
async function ensureReferralRegistryTreeReady() {
    if (!backfillInFlight) {
        backfillInFlight = (async () => {
            try {
                let sync = await (0, db_1.getReferralRegistryTreeSync)();
                if (sync.syncedThroughBlock !== null)
                    return;
                while (!(await (0, db_1.tryStartReferralRegistryTreeRebuild)())) {
                    await delay(500);
                    sync = await (0, db_1.getReferralRegistryTreeSync)();
                    if (sync.syncedThroughBlock !== null)
                        return;
                }
                await rebuildReferralRegistryTree();
            }
            catch (error) {
                await (0, db_1.setReferralRegistryTreeRebuilding)(false);
                throw error;
            }
            finally {
                backfillInFlight = undefined;
            }
        })();
    }
    return backfillInFlight;
}
async function rebuildReferralRegistryTreeNow() {
    if (!backfillInFlight) {
        backfillInFlight = (async () => {
            await (0, db_1.setReferralRegistryTreeRebuilding)(true);
            try {
                await rebuildReferralRegistryTree();
            }
            catch (error) {
                await (0, db_1.setReferralRegistryTreeRebuilding)(false);
                throw error;
            }
            finally {
                backfillInFlight = undefined;
            }
        })();
    }
    return backfillInFlight;
}
