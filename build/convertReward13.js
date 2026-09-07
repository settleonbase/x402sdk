"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertReward13ToUsdcToAaPool = exports.convertReward13ToProgramPointsPool = exports.CONVERT_REWARD13_EIP712_TYPES = void 0;
exports.convertReward13PreCheck = convertReward13PreCheck;
exports.kickConvertReward13Process = kickConvertReward13Process;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const chainAddresses_1 = require("./chainAddresses");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
const MemberCard_1 = require("./MemberCard");
const settleContractPool_1 = require("./settleContractPool");
const userCumulativeStatRewardPool_1 = require("./userCumulativeStatRewardPool");
const resolveBeamioAaViaUserCardFactory_1 = require("./endpoint/resolveBeamioAaViaUserCardFactory");
const CARD_VIEW_IFACE = new ethers_1.ethers.Interface([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function rewardEscrowUsdc6() view returns (uint256)',
    'function convertReward13ToUsdcRatioE6() view returns (uint256)',
    'function quoteUsdcWithdrawForFiat6(uint256 fiatAmount6) view returns (uint256)',
    'function pointsUnitPriceInCurrencyE6() view returns (uint256)',
]);
exports.CONVERT_REWARD13_EIP712_TYPES = {
    ConvertReward13: [
        { name: 'card', type: 'address' },
        { name: 'userEOA', type: 'address' },
        { name: 'kind', type: 'uint8' }, // 1 = toProgramPoints, 2 = toUsdcAa
        { name: 'burn13', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
const KIND_TO_POINTS = 1;
const KIND_TO_USDC = 2;
const usedNonces = new Set();
exports.convertReward13ToProgramPointsPool = [];
exports.convertReward13ToUsdcToAaPool = [];
let convertReward13InFlight = false;
function nonceKey(userEOA, nonce) {
    return `${userEOA.toLowerCase()}:${nonce.toLowerCase()}`;
}
function kindCode(kind) {
    return kind === 'toUsdcAa' ? KIND_TO_USDC : KIND_TO_POINTS;
}
async function convertReward13PreCheck(body) {
    try {
        const cardAddress = ethers_1.ethers.getAddress(String(body.cardAddress ?? ''));
        const userEOA = ethers_1.ethers.getAddress(String(body.userEOA ?? ''));
        const burn13 = BigInt(String(body.burn13 ?? '0'));
        const deadline = Number(body.deadline ?? 0);
        const nonce = String(body.nonce ?? '');
        const kind = body.kind;
        if (!ethers_1.ethers.isHexString(nonce, 32))
            return { success: false, error: 'Invalid nonce' };
        if (!body.userSignature || typeof body.userSignature !== 'string') {
            return { success: false, error: 'userSignature required' };
        }
        if (burn13 <= 0n)
            return { success: false, error: 'burn13 must be > 0' };
        if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
            return { success: false, error: 'deadline expired' };
        }
        const nk = nonceKey(userEOA, nonce);
        if (usedNonces.has(nk))
            return { success: false, error: 'nonce already used' };
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
        if (chain !== 'conet')
            return { success: false, error: 'Merchant card must be on CoNET' };
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)('conet');
        const aa = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(userEOA);
        if (!aa)
            return { success: false, error: 'User AA not found' };
        const card = new ethers_1.ethers.Contract(cardAddress, CARD_VIEW_IFACE, provider);
        const bal13 = (await card.balanceOf(aa, 13n));
        if (burn13 > bal13) {
            return { success: false, error: `Insufficient #13 balance (have ${bal13}, need ${burn13})` };
        }
        if (kind === 'toProgramPoints') {
            // Same-store #13 → #0 credit: no USDC escrow and no ratio switch.
            const price = (await card.pointsUnitPriceInCurrencyE6());
            if (price <= 0n)
                return { success: false, error: 'pointsUnitPriceInCurrencyE6 is zero' };
            const minted0 = (burn13 * 1000000n) / price;
            if (minted0 <= 0n)
                return { success: false, error: 'Conversion would mint zero #0' };
        }
        else {
            const ratio = (await card.convertReward13ToUsdcRatioE6());
            if (ratio <= 0n)
                return { success: false, error: '#13 → USDC conversion is disabled' };
            const [usdcOut6, escrow] = await Promise.all([
                card.quoteUsdcWithdrawForFiat6(burn13),
                card.rewardEscrowUsdc6(),
            ]);
            if (usdcOut6 <= 0n)
                return { success: false, error: 'Oracle quote for USDC out is zero' };
            if (usdcOut6 > escrow) {
                return {
                    success: false,
                    error: `Insufficient merchant USDC escrow (need ${usdcOut6}, have ${escrow})`,
                };
            }
            // Fail-closed: ERC20 balance on the card must also cover the payout (not escrow alone).
            const { CONET_USDC } = await import('./chainAddresses.js');
            const erc20 = new ethers_1.ethers.Contract(CONET_USDC, ['function balanceOf(address) view returns (uint256)'], provider);
            const tokenBal = (await erc20.balanceOf(cardAddress));
            if (usdcOut6 > tokenBal) {
                return {
                    success: false,
                    error: `Insufficient merchant CONET-USDC balance (need ${usdcOut6}, have ${tokenBal})`,
                };
            }
        }
        const factoryGateway = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(cardAddress);
        const domain = {
            name: 'BeamioUserCard',
            version: '1',
            chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
            verifyingContract: factoryGateway,
        };
        const recovered = ethers_1.ethers.verifyTypedData(domain, exports.CONVERT_REWARD13_EIP712_TYPES, {
            card: cardAddress,
            userEOA,
            kind: kindCode(kind),
            burn13,
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
                burn13: burn13.toString(),
                deadline,
                nonce,
                userSignature: body.userSignature,
                kind,
            },
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: msg };
    }
}
function kickConvertReward13Process() {
    if (convertReward13InFlight)
        return;
    void convertReward13Process();
}
async function convertReward13Process() {
    if (convertReward13InFlight)
        return;
    const item = exports.convertReward13ToProgramPointsPool.shift() ?? exports.convertReward13ToUsdcToAaPool.shift();
    if (!item)
        return;
    convertReward13InFlight = true;
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
        const burn13 = BigInt(item.burn13);
        const fn = item.kind === 'toUsdcAa' ? 'convertReward13ToUsdcToAa' : 'convertReward13ToProgramPoints';
        const cardCallData = userCumulativeStatRewardPool_1.CHARGE_REWARD_V2_IFACE.encodeFunctionData(fn, [userEOA, burn13]);
        const tx = await (0, MemberCard_1.relayUserCardCallViaEntryPoint)({
            SC,
            chain: 'conet',
            cardAddress,
            cardCallData,
            logTag: `convertReward13:${item.kind}`,
        });
        const receipt = await tx.wait();
        const ok = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(receipt ?? undefined, {
            logTag: `convertReward13:${item.kind}`,
        });
        if (!ok.ok) {
            throw new Error(`convertReward13 failed: ${ok.reason ?? tx.hash}`);
        }
        (0, logger_1.logger)(safe_1.default.green(`[convertReward13] ok kind=${item.kind} card=${cardAddress} eoa=${userEOA} hash=${tx.hash}`));
        if (item.res && !item.res.headersSent) {
            item.res
                .status(200)
                .json({
                success: true,
                kind: item.kind,
                cardAddress,
                userEOA,
                burn13: burn13.toString(),
                hash: tx.hash,
            })
                .end();
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red(`[convertReward13] ${msg}`));
        if (item.res && !item.res.headersSent) {
            item.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        if (SC)
            (0, settleContractPool_1.unshiftSettleConet)(SC);
        convertReward13InFlight = false;
        if (exports.convertReward13ToProgramPointsPool.length > 0 || exports.convertReward13ToUsdcToAaPool.length > 0) {
            setTimeout(() => {
                kickConvertReward13Process();
            }, 0);
        }
    }
}
