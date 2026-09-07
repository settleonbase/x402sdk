"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redeemReward13ForUsdcPool = exports.REDEEM_REWARD13_EIP712_TYPES = void 0;
exports.redeemReward13ForUsdcPreCheck = redeemReward13ForUsdcPreCheck;
exports.kickRedeemReward13ForUsdcProcess = kickRedeemReward13ForUsdcProcess;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const chainAddresses_1 = require("./chainAddresses");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
const MemberCard_1 = require("./MemberCard");
const settleContractPool_1 = require("./settleContractPool");
const userCumulativeStatRewardPool_1 = require("./userCumulativeStatRewardPool");
const resolveBeamioAaViaUserCardFactory_1 = require("./endpoint/resolveBeamioAaViaUserCardFactory");
const BURN_SEL = userCumulativeStatRewardPool_1.CHARGE_REWARD_V2_IFACE.getFunction('burnSocialPointsFromUserForExchange')?.selector ?? '0x00000000';
const PAY_SEL = userCumulativeStatRewardPool_1.CHARGE_REWARD_V2_IFACE.getFunction('payoutSocialExchangeUsdcToUser')?.selector ?? '0x00000000';
const REWARD13_IFACE = new ethers_1.ethers.Interface([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function rewardEscrowUsdc6() view returns (uint256)',
    'function currency() view returns (uint8)',
    'function pointsUnitPriceInCurrencyE6() view returns (uint256)',
]);
const FACTORY_QUOTE_IFACE = new ethers_1.ethers.Interface([
    'function quoteCurrencyAmountInUSDC6(uint8 currency, uint256 amount6) view returns (uint256)',
]);
exports.REDEEM_REWARD13_EIP712_TYPES = {
    RedeemReward13ForUsdc: [
        { name: 'card', type: 'address' },
        { name: 'userEOA', type: 'address' },
        { name: 'pointsCost', type: 'uint256' },
        { name: 'usdcReward6', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
const usedNonces = new Set();
exports.redeemReward13ForUsdcPool = [];
let redeemReward13InFlight = false;
async function bytecodeHasSelector(provider, address, selector) {
    if (!selector || selector === '0x00000000')
        return false;
    const code = await provider.getCode(address);
    if (!code || code === '0x')
        return false;
    return code.toLowerCase().includes(selector.slice(2).toLowerCase());
}
function nonceKey(userEOA, nonce) {
    return `${userEOA.toLowerCase()}:${nonce.toLowerCase()}`;
}
async function redeemReward13ForUsdcPreCheck(body) {
    try {
        if (!body?.cardAddress || !ethers_1.ethers.isAddress(body.cardAddress)) {
            return { success: false, error: 'Invalid cardAddress' };
        }
        if (!body?.userEOA || !ethers_1.ethers.isAddress(body.userEOA)) {
            return { success: false, error: 'Invalid userEOA' };
        }
        if (!body?.userSignature || typeof body.userSignature !== 'string') {
            return { success: false, error: 'Missing userSignature' };
        }
        const cardAddress = ethers_1.ethers.getAddress(body.cardAddress);
        const userEOA = ethers_1.ethers.getAddress(body.userEOA);
        const pointsCost = BigInt(body.pointsCost);
        const usdcReward6 = BigInt(body.usdcReward6);
        if (pointsCost <= 0n || usdcReward6 <= 0n) {
            return { success: false, error: 'pointsCost and usdcReward6 must be > 0' };
        }
        const deadline = Number(body.deadline);
        if (!Number.isFinite(deadline) || deadline < Math.floor(Date.now() / 1000) - 30) {
            return { success: false, error: 'deadline expired' };
        }
        const nonce = body.nonce;
        if (typeof nonce !== 'string' || !nonce.startsWith('0x') || nonce.length !== 66) {
            return { success: false, error: 'Invalid nonce' };
        }
        const nk = nonceKey(userEOA, nonce);
        if (usedNonces.has(nk)) {
            return { success: false, error: 'nonce already used' };
        }
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        if (chain !== 'conet') {
            return { success: false, error: 'Merchant card must be on CoNET' };
        }
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)('conet');
        const burnOk = await bytecodeHasSelector(provider, cardAddress, BURN_SEL);
        const payOk = await bytecodeHasSelector(provider, cardAddress, PAY_SEL);
        if (!burnOk || !payOk) {
            return {
                success: false,
                error: 'This program card does not support Reward PT to USDC redemption yet',
            };
        }
        const aa = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(userEOA);
        if (!aa || !ethers_1.ethers.isAddress(aa)) {
            return { success: false, error: 'Smart Wallet (AA) required to redeem Reward PT' };
        }
        const card = new ethers_1.ethers.Contract(cardAddress, REWARD13_IFACE, provider);
        const [bal13, escrow, currency, priceE6] = await Promise.all([
            card.balanceOf(aa, 13n),
            card.rewardEscrowUsdc6(),
            card.currency(),
            card.pointsUnitPriceInCurrencyE6(),
        ]);
        if (bal13 < pointsCost) {
            return { success: false, error: 'Insufficient Reward PT (#13) on Smart Wallet' };
        }
        if (escrow < usdcReward6) {
            return { success: false, error: 'Insufficient merchant USDC escrow for this redemption' };
        }
        if (priceE6 <= 0n) {
            return { success: false, error: 'Invalid points unit price' };
        }
        const fiat6 = (pointsCost * priceE6) / 1000000n;
        const factory = new ethers_1.ethers.Contract(chainAddresses_1.CONET_CARD_FACTORY, FACTORY_QUOTE_IFACE, provider);
        const quotedUsdc6 = (await factory.quoteCurrencyAmountInUSDC6(Number(currency), fiat6));
        const cap = quotedUsdc6 < escrow ? quotedUsdc6 : escrow;
        if (usdcReward6 > cap) {
            return { success: false, error: 'usdcReward6 exceeds quoted or escrow cap' };
        }
        if (quotedUsdc6 > 0n) {
            const drift = usdcReward6 > quotedUsdc6 ? usdcReward6 - quotedUsdc6 : quotedUsdc6 - usdcReward6;
            if (drift * 100n > quotedUsdc6 * 5n) {
                return { success: false, error: 'usdcReward6 diverges from Factory quote' };
            }
        }
        const factoryGateway = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const domain = {
            name: 'BeamioUserCard',
            version: '1',
            chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
            verifyingContract: factoryGateway,
        };
        const recovered = ethers_1.ethers.verifyTypedData(domain, exports.REDEEM_REWARD13_EIP712_TYPES, {
            card: cardAddress,
            userEOA,
            pointsCost,
            usdcReward6,
            deadline: BigInt(deadline),
            nonce,
        }, body.userSignature);
        if (recovered.toLowerCase() !== userEOA.toLowerCase()) {
            return { success: false, error: 'Signature does not match userEOA' };
        }
        usedNonces.add(nk);
        return {
            success: true,
            preChecked: {
                cardAddress,
                userEOA,
                pointsCost: pointsCost.toString(),
                usdcReward6: usdcReward6.toString(),
                deadline,
                nonce,
                userSignature: body.userSignature,
            },
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: msg };
    }
}
function kickRedeemReward13ForUsdcProcess() {
    if (redeemReward13InFlight)
        return;
    void redeemReward13ForUsdcProcess();
}
async function redeemReward13ForUsdcProcess() {
    if (redeemReward13InFlight)
        return;
    const item = exports.redeemReward13ForUsdcPool.shift();
    if (!item)
        return;
    redeemReward13InFlight = true;
    const SC = (0, settleContractPool_1.shiftSettleConet)();
    try {
        if (!SC) {
            if (item.res && !item.res.headersSent) {
                item.res.status(503).json({ success: false, error: 'CoNET settle pool busy' }).end();
            }
            return;
        }
        const cardAddress = ethers_1.ethers.getAddress(item.cardAddress);
        const userEOA = ethers_1.ethers.getAddress(item.userEOA);
        const pointsCost = BigInt(item.pointsCost);
        const usdcReward6 = BigInt(item.usdcReward6);
        const burnData = userCumulativeStatRewardPool_1.CHARGE_REWARD_V2_IFACE.encodeFunctionData('burnSocialPointsFromUserForExchange', [
            userEOA,
            pointsCost,
        ]);
        const payData = userCumulativeStatRewardPool_1.CHARGE_REWARD_V2_IFACE.encodeFunctionData('payoutSocialExchangeUsdcToUser', [
            userEOA,
            usdcReward6,
        ]);
        const burnTx = await (0, MemberCard_1.relayUserCardCallViaEntryPoint)({
            SC,
            chain: 'conet',
            cardAddress,
            cardCallData: burnData,
            logTag: 'redeemReward13ForUsdc:burn',
        });
        const burnReceipt = await burnTx.wait();
        const burnOk = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(burnReceipt ?? undefined, { logTag: 'redeemReward13ForUsdc:burn' });
        if (!burnOk.ok) {
            throw new Error(`Reward PT burn failed: ${burnOk.reason ?? burnTx.hash}`);
        }
        const payTx = await (0, MemberCard_1.relayUserCardCallViaEntryPoint)({
            SC,
            chain: 'conet',
            cardAddress,
            cardCallData: payData,
            logTag: 'redeemReward13ForUsdc:payout',
        });
        const payReceipt = await payTx.wait();
        const payOk = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(payReceipt ?? undefined, { logTag: 'redeemReward13ForUsdc:payout' });
        if (!payOk.ok) {
            throw new Error(`USDC payout failed: ${payOk.reason ?? payTx.hash}`);
        }
        (0, logger_1.logger)(safe_1.default.green(`[redeemReward13ForUsdc] ok card=${cardAddress} eoa=${userEOA} burn=${burnTx.hash} pay=${payTx.hash}`));
        if (item.res && !item.res.headersSent) {
            item.res.status(200).json({
                success: true,
                cardAddress,
                userEOA,
                burnHash: burnTx.hash,
                payoutHash: payTx.hash,
            }).end();
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red(`[redeemReward13ForUsdc] ${msg}`));
        if (item.res && !item.res.headersSent) {
            item.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        if (SC)
            (0, settleContractPool_1.unshiftSettleConet)(SC);
        redeemReward13InFlight = false;
        if (exports.redeemReward13ForUsdcPool.length > 0) {
            setTimeout(() => {
                kickRedeemReward13ForUsdcProcess();
            }, 0);
        }
    }
}
