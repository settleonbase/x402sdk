"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.genesisNodeReferralRedeemPool = void 0;
exports.kickGenesisNodeReferralRedeemRelay = kickGenesisNodeReferralRedeemRelay;
exports.genesisNodeReferralRedeemRelayProcess = genesisNodeReferralRedeemRelayProcess;
/**
 * GenesisNodeReferralVaultV1 — gasless Admin/L0/L1 redeem relay (Master pool).
 * L0 sets ratioBps (% of L0's 10% node bucket) when issuing L1 codes.
 */
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const chainAddresses_1 = require("./chainAddresses");
const settleContractPool_1 = require("./settleContractPool");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
const GENESIS_REFERRAL_REDEEM_ABI = [
    'function issueL0RedeemCodeFor(address admin,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
    'function cancelL0RedeemCodeFor(address admin,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
    'function claimL0RedeemCodeFor(address claimer,bytes secret,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
    'function issueL1RedeemCodeFor(address l0,bytes32 redeemHash,uint256 ratioBps,uint256 nonce,uint256 deadline,bytes signature)',
    'function cancelL1RedeemCodeFor(address l0,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
    'function claimL1RedeemCodeFor(address claimer,bytes secret,bytes32 redeemHash,uint256 nonce,uint256 deadline,bytes signature)',
    'function setFoundationFor(address admin,address foundation,uint256 nonce,uint256 deadline,bytes signature)',
    'function setDefaultAdminPayoutFor(address admin,address payout,uint256 nonce,uint256 deadline,bytes signature)',
    'function setL1RatioFor(address l0,address l1,uint256 ratioBps,uint256 nonce,uint256 deadline,bytes signature)',
];
exports.genesisNodeReferralRedeemPool = [];
function kickGenesisNodeReferralRedeemRelay() {
    void genesisNodeReferralRedeemRelayProcess().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        (0, logger_1.logger)(safe_1.default.red('[genesisNodeReferralRedeemRelay] unhandled error:'), msg);
    });
}
function scheduleGenesisNodeReferralRedeemRelay() {
    if (exports.genesisNodeReferralRedeemPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleSettleConet)()) {
        kickGenesisNodeReferralRedeemRelay();
        return;
    }
    setTimeout(() => kickGenesisNodeReferralRedeemRelay(), 3000);
}
async function genesisNodeReferralRedeemRelayProcess() {
    const job = exports.genesisNodeReferralRedeemPool.shift();
    if (!job)
        return;
    const SC = (0, settleContractPool_1.shiftSettleConet)();
    if (!SC) {
        exports.genesisNodeReferralRedeemPool.unshift(job);
        return scheduleGenesisNodeReferralRedeemRelay();
    }
    try {
        const vault = new ethers_1.ethers.Contract(chainAddresses_1.CONET_GENESIS_NODE_REFERRAL_VAULT, GENESIS_REFERRAL_REDEEM_ABI, SC.walletConet);
        const account = ethers_1.ethers.getAddress(job.account);
        let tx;
        if (job.action === 'setFoundation') {
            tx = await vault.setFoundationFor(account, ethers_1.ethers.getAddress(job.payoutAddress), BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 200_000 });
        }
        else if (job.action === 'setDefaultAdminPayout') {
            tx = await vault.setDefaultAdminPayoutFor(account, ethers_1.ethers.getAddress(job.payoutAddress), BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 200_000 });
        }
        else if (job.action === 'setL1Ratio') {
            tx = await vault.setL1RatioFor(account, ethers_1.ethers.getAddress(job.l1Address), BigInt(job.ratioBps ?? '0'), BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 250_000 });
        }
        else if (job.action === 'issueL0') {
            tx = await vault.issueL0RedeemCodeFor(account, job.redeemHash, BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 400_000 });
        }
        else if (job.action === 'cancelL0') {
            tx = await vault.cancelL0RedeemCodeFor(account, job.redeemHash, BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 300_000 });
        }
        else if (job.action === 'claimL0') {
            tx = await vault.claimL0RedeemCodeFor(account, ethers_1.ethers.toUtf8Bytes(job.secret ?? ''), job.redeemHash, BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 500_000 });
        }
        else if (job.action === 'issueL1') {
            tx = await vault.issueL1RedeemCodeFor(account, job.redeemHash, BigInt(job.ratioBps ?? '0'), BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 400_000 });
        }
        else if (job.action === 'cancelL1') {
            tx = await vault.cancelL1RedeemCodeFor(account, job.redeemHash, BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 300_000 });
        }
        else {
            tx = await vault.claimL1RedeemCodeFor(account, ethers_1.ethers.toUtf8Bytes(job.secret ?? ''), job.redeemHash, BigInt(job.nonce), BigInt(job.deadline), job.signature, { gasLimit: 500_000 });
        }
        const receipt = await tx.wait();
        if (receipt?.status !== 1)
            throw new Error(`${job.action} reverted`);
        if (job.res && !job.res.headersSent) {
            job.res.status(200).json({ success: true, txHash: tx.hash }).end();
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.shortMessage ?? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[genesisNodeReferralRedeemRelay] failed:'), msg);
        if (job.res && !job.res.headersSent) {
            job.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(SC);
        scheduleGenesisNodeReferralRedeemRelay();
    }
}
