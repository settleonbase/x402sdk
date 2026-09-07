"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.topupWithReward13ContainerPool = exports.TOPUP_WITH_REWARD13_CONTAINER_EIP712_TYPES = void 0;
exports.hashTopupPeers = hashTopupPeers;
exports.topupWithReward13ContainerPreCheck = topupWithReward13ContainerPreCheck;
exports.kickTopupWithReward13ContainerProcess = kickTopupWithReward13ContainerProcess;
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
    'function owner() view returns (address)',
]);
const ERC20_IFACE = new ethers_1.ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const CONET_USDC_EIP3009_IFACE = new ethers_1.ethers.Interface([
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
    'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
    'function name() view returns (string)',
]);
const MINT_PROTOCOL_IFACE = new ethers_1.ethers.Interface([
    'function mintPointsForProtocolUsdcSettlement(address userEOA, uint256 points6)',
]);
const CONET_USDC_TRANSFER_WITH_AUTHORIZATION_TYPES = {
    TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
exports.TOPUP_WITH_REWARD13_CONTAINER_EIP712_TYPES = {
    TopupWithReward13Container: [
        { name: 'targetCard', type: 'address' },
        { name: 'userEOA', type: 'address' },
        { name: 'sameStoreBurn13', type: 'uint256' },
        { name: 'peerUsdcCredited6', type: 'uint256' },
        { name: 'pointsFromPeerUsdc6', type: 'uint256' },
        { name: 'minTotalPointsOut0', type: 'uint256' },
        { name: 'peersHash', type: 'bytes32' },
        { name: 'cashUsdc6', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
exports.topupWithReward13ContainerPool = [];
let topupContainerInFlight = false;
const usedNonces = new Set();
function nonceKey(userEOA, nonce) {
    return `${userEOA.toLowerCase()}:${nonce.toLowerCase()}`;
}
/**
 * Deterministic peersHash = keccak256(abi.encodePacked(card, burn13, usdcOut6, …))
 * sorted by card address. Empty peers → ZeroHash. Must match client + Cluster.
 */
function hashTopupPeers(peers) {
    if (peers.length === 0)
        return ethers_1.ethers.ZeroHash;
    const sorted = peers
        .map((p) => ({
        cardAddress: ethers_1.ethers.getAddress(p.cardAddress),
        burn13: p.burn13,
        usdcOut6: p.usdcOut6,
    }))
        .sort((a, b) => a.cardAddress.toLowerCase().localeCompare(b.cardAddress.toLowerCase()));
    const chunks = sorted.map((p) => ethers_1.ethers.solidityPacked(['address', 'uint256', 'uint256'], [p.cardAddress, p.burn13, p.usdcOut6]));
    return ethers_1.ethers.keccak256(ethers_1.ethers.concat(chunks));
}
const TX_CATEGORY_USDC_TOPUP_BUNIT_SERVICE = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('usdcTopup:bunitService'));
async function readUsdcLiquidity(cardAddress) {
    const provider = (0, beamioUserCardChain_1.providerForUserCardChain)('conet');
    const card = new ethers_1.ethers.Contract(cardAddress, CARD_VIEW_IFACE, provider);
    const usdc = new ethers_1.ethers.Contract(chainAddresses_1.CONET_USDC, ERC20_IFACE, provider);
    const [escrow, tokenBal] = await Promise.all([
        card.rewardEscrowUsdc6(),
        usdc.balanceOf(cardAddress),
    ]);
    return { escrow, tokenBal };
}
async function topupWithReward13ContainerPreCheck(body) {
    try {
        const targetCard = ethers_1.ethers.getAddress(String(body.targetCard ?? ''));
        const userEOA = ethers_1.ethers.getAddress(String(body.userEOA ?? ''));
        const sameStoreBurn13 = BigInt(String(body.sameStoreBurn13 ?? '0'));
        const peerUsdcCredited6Client = BigInt(String(body.peerUsdcCredited6 ?? '0'));
        const pointsFromPeerUsdc6Client = BigInt(String(body.pointsFromPeerUsdc6 ?? '0'));
        const minTotalPointsOut0 = BigInt(String(body.minTotalPointsOut0 ?? '0'));
        const deadline = Number(body.deadline ?? 0);
        const nonce = String(body.nonce ?? '');
        const peersRaw = Array.isArray(body.peers) ? body.peers : [];
        if (!ethers_1.ethers.isHexString(nonce, 32))
            return { success: false, error: 'Invalid nonce' };
        if (!body.userSignature || typeof body.userSignature !== 'string') {
            return { success: false, error: 'userSignature required' };
        }
        if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
            return { success: false, error: 'deadline expired' };
        }
        const nk = nonceKey(userEOA, nonce);
        if (usedNonces.has(nk))
            return { success: false, error: 'nonce already used' };
        const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(targetCard);
        if (chain !== 'conet')
            return { success: false, error: 'Merchant card must be on CoNET' };
        const provider = (0, beamioUserCardChain_1.providerForUserCardChain)('conet');
        const aa = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(userEOA);
        if (!aa)
            return { success: false, error: 'Smart Wallet (AA) required' };
        const peers = [];
        for (const raw of peersRaw) {
            const peerCard = ethers_1.ethers.getAddress(String(raw?.cardAddress ?? ''));
            const burn13 = BigInt(String(raw?.burn13 ?? '0'));
            const usdcOut6 = BigInt(String(raw?.usdcOut6 ?? '0'));
            if (peerCard === targetCard) {
                return { success: false, error: 'Peer leg must not use target card' };
            }
            if (burn13 <= 0n || usdcOut6 <= 0n) {
                return { success: false, error: 'Peer leg burn13 and usdcOut6 must be > 0' };
            }
            peers.push({ cardAddress: peerCard, burn13, usdcOut6 });
        }
        let peerUsdcSum = 0n;
        for (const peer of peers) {
            const peerChain = await (0, beamioUserCardChain_1.resolveUserCardChain)(peer.cardAddress);
            if (peerChain !== 'conet') {
                return { success: false, error: `Peer card must be on CoNET: ${peer.cardAddress}` };
            }
            const peerCard = new ethers_1.ethers.Contract(peer.cardAddress, CARD_VIEW_IFACE, provider);
            const [ratio, quoted, bal13] = await Promise.all([
                peerCard.convertReward13ToUsdcRatioE6(),
                peerCard.quoteUsdcWithdrawForFiat6(peer.burn13),
                peerCard.balanceOf(aa, 13n),
            ]);
            if (ratio === 0n) {
                return { success: false, error: `Peer card Reward PT→USDC disabled: ${peer.cardAddress}` };
            }
            if (quoted === 0n) {
                return { success: false, error: `Peer oracle quote zero: ${peer.cardAddress}` };
            }
            // Fail-closed: no silent underpay — client usdcOut6 must equal on-chain quote.
            if (peer.usdcOut6 !== quoted) {
                return {
                    success: false,
                    error: `Peer usdcOut6 must equal quote (${quoted.toString()}) for ${peer.cardAddress}`,
                };
            }
            if (peer.burn13 > bal13) {
                return { success: false, error: `Insufficient #13 on peer ${peer.cardAddress}` };
            }
            const { escrow, tokenBal } = await readUsdcLiquidity(peer.cardAddress);
            if (escrow < peer.usdcOut6 || tokenBal < peer.usdcOut6) {
                return {
                    success: false,
                    error: `Insufficient USDC liquidity on peer ${peer.cardAddress} (escrow=${escrow} token=${tokenBal} need=${peer.usdcOut6})`,
                };
            }
            peerUsdcSum += peer.usdcOut6;
        }
        if (peerUsdcCredited6Client !== peerUsdcSum) {
            return {
                success: false,
                error: `peerUsdcCredited6 must equal sum of peer usdcOut6 (${peerUsdcSum.toString()})`,
            };
        }
        let pointsFromPeerUsdc6 = 0n;
        if (peerUsdcSum > 0n) {
            const quote = await (0, MemberCard_1.quotePointsForUSDC_raw)(targetCard, peerUsdcSum);
            pointsFromPeerUsdc6 = BigInt(quote.points6);
            if (pointsFromPeerUsdc6 <= 0n) {
                return { success: false, error: 'pointsFromPeerUsdc6 quote is zero' };
            }
            // In EIP-712 — client must sign Cluster-matching quote (no silent overwrite).
            if (pointsFromPeerUsdc6Client !== pointsFromPeerUsdc6) {
                return {
                    success: false,
                    error: `pointsFromPeerUsdc6 mismatch (client=${pointsFromPeerUsdc6Client.toString()}, expected=${pointsFromPeerUsdc6.toString()})`,
                };
            }
        }
        else if (pointsFromPeerUsdc6Client !== 0n) {
            return { success: false, error: 'pointsFromPeerUsdc6 must be 0 when no peer USDC' };
        }
        if (sameStoreBurn13 === 0n && peerUsdcSum === 0n) {
            return { success: false, error: 'Container requires same-store #13 and/or peer USDC' };
        }
        let sameStoreMinted0 = 0n;
        if (sameStoreBurn13 > 0n) {
            const target = new ethers_1.ethers.Contract(targetCard, CARD_VIEW_IFACE, provider);
            const [price, bal13] = await Promise.all([
                target.pointsUnitPriceInCurrencyE6(),
                target.balanceOf(aa, 13n),
            ]);
            if (price === 0n)
                return { success: false, error: 'Target card points unit price is zero' };
            if (sameStoreBurn13 > bal13) {
                return { success: false, error: 'Insufficient same-store #13 balance' };
            }
            sameStoreMinted0 = (sameStoreBurn13 * 1000000n) / price;
            if (sameStoreMinted0 === 0n) {
                return { success: false, error: 'Same-store burn too small to mint #0' };
            }
        }
        const expectedMinTotal = sameStoreMinted0 + pointsFromPeerUsdc6;
        if (minTotalPointsOut0 !== expectedMinTotal) {
            return {
                success: false,
                error: `minTotalPointsOut0 mismatch (client=${minTotalPointsOut0.toString()}, expected=${expectedMinTotal.toString()})`,
            };
        }
        const cashRaw = body.cash;
        let cash = null;
        let cashUsdc6 = 0n;
        if (cashRaw && typeof cashRaw === 'object') {
            const from = ethers_1.ethers.getAddress(String(cashRaw.from ?? ''));
            const to = ethers_1.ethers.getAddress(String(cashRaw.to ?? ''));
            const value = BigInt(String(cashRaw.value ?? '0'));
            const points6 = BigInt(String(cashRaw.points6 ?? '0'));
            const validAfter = Number(cashRaw.validAfter ?? 0);
            const validBefore = Number(cashRaw.validBefore ?? 0);
            const cashNonce = String(cashRaw.nonce ?? '');
            const cashSig = String(cashRaw.signature ?? '');
            if (value <= 0n)
                return { success: false, error: 'cash.value must be > 0' };
            if (!ethers_1.ethers.isHexString(cashNonce, 32))
                return { success: false, error: 'Invalid cash nonce' };
            if (!cashSig)
                return { success: false, error: 'cash.signature required' };
            if (from.toLowerCase() !== userEOA.toLowerCase()) {
                return { success: false, error: 'cash.from must equal userEOA' };
            }
            const target = new ethers_1.ethers.Contract(targetCard, CARD_VIEW_IFACE, provider);
            const owner = ethers_1.ethers.getAddress((await target.owner()));
            if (to.toLowerCase() !== owner.toLowerCase()) {
                return { success: false, error: 'cash.to must be target card owner' };
            }
            const quote = await (0, MemberCard_1.quotePointsForUSDC_raw)(targetCard, value);
            const expectedPoints = BigInt(quote.points6);
            if (expectedPoints <= 0n) {
                return { success: false, error: 'cash.points6 quote is zero' };
            }
            // points6 is not in EIP-712; Cluster overwrites from quote (client may pass any positive).
            if (points6 > 0n && points6 !== expectedPoints) {
                (0, logger_1.logger)(safe_1.default.yellow(`[topupWithReward13Container] overwrite cash.points6 client=${points6} → ${expectedPoints}`));
            }
            const usdc = new ethers_1.ethers.Contract(chainAddresses_1.CONET_USDC, CONET_USDC_EIP3009_IFACE, provider);
            let tokenName = 'CoNET USD Coin';
            try {
                const n = (await usdc.name());
                if (typeof n === 'string' && n.trim())
                    tokenName = n.trim();
            }
            catch {
                /* fallback */
            }
            const eip3009Domain = {
                name: tokenName,
                version: '1',
                chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
                verifyingContract: ethers_1.ethers.getAddress(chainAddresses_1.CONET_USDC),
            };
            let recovered;
            try {
                recovered = ethers_1.ethers.verifyTypedData(eip3009Domain, CONET_USDC_TRANSFER_WITH_AUTHORIZATION_TYPES, {
                    from,
                    to,
                    value,
                    validAfter: BigInt(validAfter || 0),
                    validBefore: BigInt(validBefore),
                    nonce: cashNonce,
                }, cashSig);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return { success: false, error: `Invalid cash EIP-3009 signature: ${msg}` };
            }
            if (recovered.toLowerCase() !== from.toLowerCase()) {
                return { success: false, error: 'cash EIP-3009 signer mismatch' };
            }
            const alreadyUsed = (await usdc.authorizationState(from, cashNonce));
            if (alreadyUsed)
                return { success: false, error: 'cash authorization nonce already used' };
            cashUsdc6 = value;
            cash = {
                from,
                to,
                value: value.toString(),
                validAfter,
                validBefore,
                nonce: cashNonce,
                signature: cashSig,
                points6: expectedPoints.toString(),
            };
        }
        const peersHash = hashTopupPeers(peers);
        const verifying = await (0, MemberCard_1.getBeamioUserCardFactoryGateway)(targetCard);
        const domain = {
            name: 'BeamioUserCard',
            version: '1',
            chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
            verifyingContract: verifying,
        };
        const recovered = ethers_1.ethers.verifyTypedData(domain, exports.TOPUP_WITH_REWARD13_CONTAINER_EIP712_TYPES, {
            targetCard,
            userEOA,
            sameStoreBurn13,
            peerUsdcCredited6: peerUsdcSum,
            pointsFromPeerUsdc6,
            minTotalPointsOut0,
            peersHash,
            cashUsdc6,
            deadline: BigInt(deadline),
            nonce,
        }, body.userSignature);
        if (recovered.toLowerCase() !== userEOA.toLowerCase()) {
            return { success: false, error: 'Signature does not match userEOA' };
        }
        let cardOwnerEOA;
        let topupFeeBUnits;
        if (cash) {
            const { feeBUnits6 } = (0, MemberCard_1.calcTopupFixedBUnitFee)();
            const target = new ethers_1.ethers.Contract(targetCard, CARD_VIEW_IFACE, provider);
            const owner = String(await target.owner());
            const resolveOwner = await (0, MemberCard_1.resolveCardOwnerToEOA)(provider, owner);
            if (!resolveOwner.success) {
                return { success: false, error: resolveOwner.error ?? 'Cannot resolve card owner to EOA' };
            }
            cardOwnerEOA = resolveOwner.cardOwner;
            const aaFactoryAddr = await (0, MemberCard_1.getCardAaFactoryAddress)(targetCard);
            const picked = await (0, MemberCard_1.pickBUnitFeeConsumerPreferEoaThenAa)(cardOwnerEOA, feeBUnits6, {
                aaFactoryAddress: aaFactoryAddr,
            });
            if (!picked.ok) {
                return { success: false, error: `Insufficient B-Units for topup (${picked.error})` };
            }
            topupFeeBUnits = feeBUnits6.toString();
        }
        usedNonces.add(nk);
        return {
            success: true,
            preChecked: {
                targetCard,
                userEOA,
                sameStoreBurn13: sameStoreBurn13.toString(),
                peerUsdcCredited6: peerUsdcSum.toString(),
                pointsFromPeerUsdc6: pointsFromPeerUsdc6.toString(),
                minTotalPointsOut0: minTotalPointsOut0.toString(),
                deadline,
                nonce,
                userSignature: body.userSignature,
                peers: peers.map((p) => ({
                    cardAddress: p.cardAddress,
                    burn13: p.burn13.toString(),
                    usdcOut6: p.usdcOut6.toString(),
                })),
                cash,
                cardOwnerEOA,
                topupFeeBUnits,
            },
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: msg };
    }
}
function kickTopupWithReward13ContainerProcess() {
    if (topupContainerInFlight)
        return;
    void topupWithReward13ContainerProcess();
}
async function topupWithReward13ContainerProcess() {
    if (topupContainerInFlight)
        return;
    const item = exports.topupWithReward13ContainerPool.shift();
    if (!item)
        return;
    topupContainerInFlight = true;
    const SC = (0, settleContractPool_1.shiftSettleConet)();
    try {
        if (!SC) {
            if (item.res && !item.res.headersSent) {
                item.res.status(503).json({ success: false, error: 'CoNET settle pool busy' }).end();
            }
            return;
        }
        const targetCard = ethers_1.ethers.getAddress(item.targetCard);
        const userEOA = ethers_1.ethers.getAddress(item.userEOA);
        const sameStoreBurn13 = BigInt(item.sameStoreBurn13);
        const peerUsdcCredited6 = BigInt(item.peerUsdcCredited6);
        const pointsFromPeerUsdc6 = BigInt(item.pointsFromPeerUsdc6);
        const minTotalPointsOut0 = BigInt(item.minTotalPointsOut0);
        const deadline = BigInt(item.deadline);
        const nonce = item.nonce;
        const dest = [];
        const value = [];
        const func = [];
        for (const peer of item.peers ?? []) {
            const peerCard = ethers_1.ethers.getAddress(peer.cardAddress);
            dest.push(peerCard);
            value.push(0n);
            func.push(userCumulativeStatRewardPool_1.CHARGE_REWARD_V2_IFACE.encodeFunctionData('peerRedeem13ForContainerTopup', [
                userEOA,
                BigInt(peer.burn13),
                BigInt(peer.usdcOut6),
                targetCard,
            ]));
        }
        dest.push(targetCard);
        value.push(0n);
        func.push(userCumulativeStatRewardPool_1.CHARGE_REWARD_V2_IFACE.encodeFunctionData('topupWithReward13Container', [
            userEOA,
            sameStoreBurn13,
            peerUsdcCredited6,
            pointsFromPeerUsdc6,
            minTotalPointsOut0,
            deadline,
            nonce,
        ]));
        if (item.cash) {
            const cash = item.cash;
            const cashValue = BigInt(cash.value);
            const cashPoints = BigInt(cash.points6);
            dest.push(ethers_1.ethers.getAddress(chainAddresses_1.CONET_USDC));
            value.push(0n);
            func.push(CONET_USDC_EIP3009_IFACE.encodeFunctionData('transferWithAuthorization', [
                ethers_1.ethers.getAddress(cash.from),
                ethers_1.ethers.getAddress(cash.to),
                cashValue,
                BigInt(cash.validAfter || 0),
                BigInt(cash.validBefore),
                cash.nonce,
                cash.signature,
            ]));
            dest.push(targetCard);
            value.push(0n);
            func.push(MINT_PROTOCOL_IFACE.encodeFunctionData('mintPointsForProtocolUsdcSettlement', [
                userEOA,
                cashPoints,
            ]));
        }
        const tx = await (0, MemberCard_1.relayUserCardBatchViaEntryPoint)({
            SC,
            chain: 'conet',
            cardAddressForFactory: targetCard,
            dest,
            value,
            func,
            logTag: 'topupWithReward13Container',
        });
        const receipt = await tx.wait();
        const ok = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(receipt ?? undefined, {
            logTag: 'topupWithReward13Container',
        });
        if (!ok.ok) {
            throw new Error(`topupWithReward13Container failed: ${ok.reason ?? tx.hash}`);
        }
        (0, logger_1.logger)(safe_1.default.green(`[topupWithReward13Container] ok target=${targetCard} eoa=${userEOA} peers=${item.peers?.length ?? 0} cash=${item.cash ? 'yes' : 'no'} hash=${tx.hash}`));
        if (item.res && !item.res.headersSent) {
            item.res
                .status(200)
                .json({
                success: true,
                targetCard,
                userEOA,
                sameStoreBurn13: sameStoreBurn13.toString(),
                peerUsdcCredited6: peerUsdcCredited6.toString(),
                pointsFromPeerUsdc6: pointsFromPeerUsdc6.toString(),
                hash: tx.hash,
            })
                .end();
        }
        // B-Unit fee after HTTP 200 (cash leg only); hold settle SC until consume finishes.
        if (item.cash && item.topupFeeBUnits && item.cardOwnerEOA && SC) {
            const feeBUnits6 = BigInt(item.topupFeeBUnits);
            const cardOwnerEOA = ethers_1.ethers.getAddress(item.cardOwnerEOA);
            try {
                let consumer = cardOwnerEOA;
                try {
                    const aaFac = await (0, MemberCard_1.getCardAaFactoryAddress)(targetCard);
                    const picked = await (0, MemberCard_1.pickBUnitFeeConsumerPreferEoaThenAa)(cardOwnerEOA, feeBUnits6, {
                        aaFactoryAddress: aaFac,
                    });
                    if (picked.ok)
                        consumer = picked.consumer;
                }
                catch (pickErr) {
                    const m = pickErr instanceof Error ? pickErr.message : String(pickErr);
                    (0, logger_1.logger)(safe_1.default.yellow(`[topupWithReward13Container] B-Unit pick error: ${m}`));
                }
                const bunit = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUNIT_AIRDROP_ADDRESS, ['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'], SC.walletConet);
                const gasUsed = receipt?.gasUsed ?? 0n;
                const consumeTx = await bunit.consumeFromUser(consumer, feeBUnits6, tx.hash, gasUsed, 2n, { gasLimit: 2_500_000 });
                await consumeTx.wait();
                (0, logger_1.logger)(safe_1.default.cyan(`[topupWithReward13Container] consumeFromUser ok: ${Number(feeBUnits6) / 1e6} B-Units from ${consumer}`));
                await (0, MemberCard_1.syncStandaloneBunitServiceFeeToIndexer)({
                    walletConet: SC.walletConet,
                    BeamioTaskDiamondAction: SC.BeamioTaskDiamondAction,
                    consumeTxHash: consumeTx.hash,
                    basePaymentHash: tx.hash,
                    cardAddress: targetCard,
                    feePayer: consumer,
                    bServiceUnits6: feeBUnits6,
                    txCategory: TX_CATEGORY_USDC_TOPUP_BUNIT_SERVICE,
                    title: 'USDC top-up B-Unit service fee',
                    source: 'topupWithReward13ContainerBUnit',
                    operator: ethers_1.ethers.ZeroAddress,
                    operatorParentChain: [],
                    topAdmin: ethers_1.ethers.ZeroAddress,
                    subordinate: ethers_1.ethers.ZeroAddress,
                });
            }
            catch (e) {
                const m = e instanceof Error ? e.message : String(e);
                (0, logger_1.logger)(safe_1.default.red(`[topupWithReward13Container] B-Unit background failed (non-fatal): ${m}`));
            }
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red(`[topupWithReward13Container] ${msg}`));
        if (item.res && !item.res.headersSent) {
            item.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        if (SC)
            (0, settleContractPool_1.unshiftSettleConet)(SC);
        topupContainerInFlight = false;
        if (exports.topupWithReward13ContainerPool.length > 0) {
            setTimeout(() => {
                kickTopupWithReward13ContainerProcess();
            }, 0);
        }
    }
}
