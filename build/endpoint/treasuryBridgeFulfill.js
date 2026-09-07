"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.treasuryBridgeFulfillProcess = exports.treasuryBridgeFulfillPool = void 0;
exports.kickTreasuryBridgeFulfillPoolPress = kickTreasuryBridgeFulfillPoolPress;
/**
 * Discover treasuryBridge fulfill (after Base USDC x402 settle → GENESIS_NODE_BRIDGE_INITIATOR):
 * 1) initiateLockMint CONET-USDC → card.owner()
 * 2) optional stageMembershipFeePurchase (first issue / upgrade)
 * 3) mintPointsForProtocolUsdcSettlement(recipientEOA, points6) via EntryPoint (gateway accounting)
 * Idempotent on USDC_tx.
 */
const ethers_1 = require("ethers");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const chainAddresses_1 = require("../chainAddresses");
const settleContractPool_1 = require("../settleContractPool");
const MemberCard_1 = require("../MemberCard");
const beamioUserCardChain_1 = require("../beamioUserCardChain");
const db_1 = require("../db");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
const TREASURY_LOCK_MINT_ABI = [
    'function initiateLockMint(uint256 destinationChainId,address sourceAsset,address destinationAsset,address[] beneficiaries,uint256[] amounts,bytes32 sourceTxHash,uint256 nonce,address callbackTarget) returns (bytes32)',
    'function destinationFeeBps(uint256 destinationChainId) view returns (uint256)',
];
const ERC20_APPROVE_ABI = [
    'function approve(address spender,uint256 amount) returns (bool)',
    'function allowance(address owner,address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
];
const ASSET_MODE_LOCK_MINT = 1;
const SHIFT_POLL_MS = 300;
const SHIFT_MAX_WAIT_MS = 120_000;
async function shiftSettleConetForWrite(logTag) {
    const deadline = Date.now() + SHIFT_MAX_WAIT_MS;
    while (Date.now() < deadline) {
        const SC = (0, settleContractPool_1.shiftSettleConet)();
        if (SC)
            return SC;
        await new Promise((r) => setTimeout(r, SHIFT_POLL_MS));
    }
    throw new Error(`${logTag}: Settle_ConetPool busy`);
}
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
exports.treasuryBridgeFulfillPool = [];
function resolveFulfillFile() {
    return (process.env.CONET_TREASURY_BRIDGE_FULFILL_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-treasury-bridge-fulfill.json'));
}
function readFulfillFile() {
    const file = resolveFulfillFile();
    if (!node_fs_1.default.existsSync(file))
        return {};
    try {
        return JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeFulfillRecord(record) {
    const file = resolveFulfillFile();
    const all = readFulfillFile();
    all[record.USDC_tx.toLowerCase()] = record;
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf-8');
}
function lookupFulfill(usdcTx) {
    const key = usdcTx.trim().toLowerCase();
    if (!key)
        return null;
    return readFulfillFile()[key] || null;
}
function kickTreasuryBridgeFulfillPoolPress() {
    void (0, exports.treasuryBridgeFulfillProcess)().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[treasuryBridgeFulfillProcess] kick error:'), msg);
    });
}
function scheduleTreasuryBridgeFulfillPoolPress() {
    if (exports.treasuryBridgeFulfillPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleGenesisInitiatorBase)())
        kickTreasuryBridgeFulfillPoolPress();
    else
        setTimeout(() => kickTreasuryBridgeFulfillPoolPress(), 3000);
}
const treasuryBridgeFulfillProcess = async () => {
    const obj = exports.treasuryBridgeFulfillPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleGenesisInitiatorBase)()) {
        exports.treasuryBridgeFulfillPool.unshift(obj);
        return setTimeout(() => void (0, exports.treasuryBridgeFulfillProcess)(), 3000);
    }
    const usdcTx = String(obj.USDC_tx ?? '').trim();
    try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx))
            throw new Error('Invalid USDC_tx');
        if (!ethers_1.ethers.isAddress(obj.cardAddress))
            throw new Error('Invalid cardAddress');
        if (!ethers_1.ethers.isAddress(obj.cardOwner))
            throw new Error('Invalid cardOwner');
        if (!ethers_1.ethers.isAddress(obj.recipientEOA))
            throw new Error('Invalid recipientEOA');
        const lockAmount = BigInt(String(obj.usdcAmount6 ?? '0'));
        if (lockAmount <= 0n)
            throw new Error('Invalid usdcAmount6');
        const points6 = BigInt(String(obj.points6 ?? '0'));
        if (points6 <= 0n)
            throw new Error('Invalid points6');
        const cardAddress = ethers_1.ethers.getAddress(obj.cardAddress);
        const cardOwner = ethers_1.ethers.getAddress(obj.cardOwner);
        const recipientEOA = ethers_1.ethers.getAddress(obj.recipientEOA);
        const existing = lookupFulfill(usdcTx);
        if (existing?.mintTxHash) {
            (0, logger_1.logger)(safe_1.default.cyan(`[treasuryBridgeFulfill] idempotent hit USDC_tx=${usdcTx.slice(0, 12)}… mint=${existing.mintTxHash.slice(0, 12)}…`));
            if (obj.res && !obj.res.headersSent) {
                obj.res
                    .status(200)
                    .json({
                    success: true,
                    idempotent: true,
                    USDC_tx: existing.USDC_tx,
                    lockMintTxHash: existing.lockMintTxHash,
                    mintTxHash: existing.mintTxHash,
                })
                    .end();
            }
            return;
        }
        let lockMintTxHash = existing?.lockMintTxHash;
        let operationId = existing?.operationId;
        if (!lockMintTxHash || !operationId) {
            const treasury = ethers_1.ethers.getAddress(chainAddresses_1.CONET_TREASURY);
            const sourceTxHash = usdcTx;
            const nonce = BigInt(ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(16)));
            const bridgeResult = await (0, settleContractPool_1.withGenesisBridgeInitiatorBase)(async (sc) => {
                const baseProvider = sc.walletBase.provider;
                const treasuryRead = new ethers_1.ethers.Contract(treasury, TREASURY_LOCK_MINT_ABI, baseProvider);
                const feeBps = (await treasuryRead.destinationFeeBps(chainAddresses_1.CONET_MAINNET_CHAIN_ID));
                const feeAmount = (lockAmount * feeBps) / 10000n;
                const beneficiaries = [cardOwner];
                const amounts = [lockAmount];
                const opId = computeLockMintOperationId({
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
                    throw new Error(`Bridge initiator USDC balance ${bal.toString()} < required ${needApprove.toString()}`);
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
                return { operationId: opId, lockMintTxHash: mintTx.hash };
            });
            lockMintTxHash = bridgeResult.lockMintTxHash;
            operationId = bridgeResult.operationId;
            writeFulfillRecord({
                cardAddress,
                cardOwner,
                recipientEOA,
                payer: ethers_1.ethers.isAddress(obj.payer) ? ethers_1.ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
                USDC_tx: usdcTx,
                usdcAmount6: lockAmount.toString(),
                points6: points6.toString(),
                operationId,
                lockMintTxHash,
                fulfilledAt: new Date().toISOString(),
            });
            (0, logger_1.logger)(safe_1.default.green(`[treasuryBridgeFulfill] LockMint OK USDC_tx=${usdcTx.slice(0, 12)}… owner=${cardOwner.slice(0, 10)}… lockMint=${lockMintTxHash.slice(0, 12)}…`));
        }
        const SC = await shiftSettleConetForWrite('treasuryBridgeFulfill.mint');
        let mintTxHash = '';
        try {
            const stage = obj.membershipFeeStage;
            if (stage) {
                const stageRecipient = ethers_1.ethers.getAddress(stage.recipientEOA);
                if (stageRecipient.toLowerCase() !== recipientEOA.toLowerCase()) {
                    throw new Error('membershipFeeStage recipient mismatch with treasuryBridge mint');
                }
                if (stage.pointsCredit6 !== points6) {
                    throw new Error('membershipFeeStage pointsCredit6 mismatch with treasuryBridge points6');
                }
                const stageIface = new ethers_1.ethers.Interface([
                    'function stageMembershipFeePurchase(address user, uint256 tierIndex, uint256 feePaid6, uint256 pointsCredit6)',
                    'function stageMembershipFeePurchaseWithBootstrap(address user, uint256 tierIndex, uint256 feePaid6, uint256 pointsCredit6, uint8 durationKind)',
                ]);
                const useBootstrap = Boolean(stage.bootstrapOnChain);
                const stageCallData = useBootstrap
                    ? stageIface.encodeFunctionData('stageMembershipFeePurchaseWithBootstrap', [
                        stageRecipient,
                        BigInt(stage.tierIndex),
                        stage.feePaid6,
                        stage.pointsCredit6,
                        Number(stage.durationKind ?? 0),
                    ])
                    : stageIface.encodeFunctionData('stageMembershipFeePurchase', [
                        stageRecipient,
                        BigInt(stage.tierIndex),
                        stage.feePaid6,
                        stage.pointsCredit6,
                    ]);
                const stageChain = await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddress);
                const stageTx = await (0, MemberCard_1.relayUserCardCallViaEntryPoint)({
                    SC,
                    chain: stageChain,
                    cardAddress,
                    cardCallData: stageCallData,
                    logTag: useBootstrap
                        ? 'treasuryBridgeFulfill:stageMembershipFeePurchaseWithBootstrap'
                        : 'treasuryBridgeFulfill:stageMembershipFeePurchase',
                });
                const stageReceipt = await stageTx.wait();
                const stageOk = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(stageReceipt ?? undefined, {
                    logTag: useBootstrap
                        ? 'treasuryBridgeFulfill:stageMembershipFeePurchaseWithBootstrap'
                        : 'treasuryBridgeFulfill:stageMembershipFeePurchase',
                });
                if (!stageOk.ok) {
                    throw new Error(`${useBootstrap ? 'stageMembershipFeePurchaseWithBootstrap' : 'stageMembershipFeePurchase'} failed on-chain: ${stageTx.hash} (${stageOk.reason})`);
                }
                (0, logger_1.logger)(safe_1.default.cyan(`[treasuryBridgeFulfill] ${useBootstrap ? 'stageMembershipFeePurchaseWithBootstrap' : 'stageMembershipFeePurchase'} tx=${stageTx.hash} tier=${stage.tierIndex} fee6=${stage.feePaid6} points6=${stage.pointsCredit6} user=${stageRecipient}`));
            }
            const { mintTx } = await (0, MemberCard_1.mintPointsForProtocolUsdcSettlementViaEntryPoint)({
                cardAddress,
                recipientEOA,
                points6,
                SC,
                logTag: 'treasuryBridgeFulfill.mint',
            });
            const mintReceipt = await mintTx.wait().catch(() => null);
            const mintCheck = (0, MemberCard_1.checkBusinessRelayTxSuccessful)(mintReceipt ?? undefined, {
                logTag: 'treasuryBridgeFulfill.mint',
            });
            if (!mintCheck.ok) {
                throw new Error(`protocol mint failed: ${mintTx.hash} (${mintCheck.reason})`);
            }
            mintTxHash = mintTx.hash;
            (0, logger_1.logger)(safe_1.default.green(`[treasuryBridgeFulfill] protocol mint OK card=${cardAddress.slice(0, 10)}… recipient=${recipientEOA.slice(0, 10)}… points6=${points6} mint=${mintTxHash.slice(0, 12)}…`));
        }
        finally {
            (0, settleContractPool_1.unshiftSettleConet)(SC);
        }
        writeFulfillRecord({
            cardAddress,
            cardOwner,
            recipientEOA,
            payer: ethers_1.ethers.isAddress(obj.payer) ? ethers_1.ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
            USDC_tx: usdcTx,
            usdcAmount6: lockAmount.toString(),
            points6: points6.toString(),
            operationId: operationId,
            lockMintTxHash: lockMintTxHash,
            mintTxHash,
            fulfilledAt: new Date().toISOString(),
        });
        void consumeTreasuryBridgeBunitInBackground({
            cardAddress,
            cardOwner,
            USDC_tx: usdcTx,
        }).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logger)(safe_1.default.yellow(`[treasuryBridgeFulfill] B-Unit background: ${msg}`));
        });
        void (0, db_1.insertMemberTopupEvent)({
            cardAddress,
            baseTxHash: mintTxHash,
            memberEoa: recipientEOA,
            memberAa: recipientEOA,
            tierTokenId: '0',
            topupSource: 'usdcPurchasingCard',
            topupCategory: 'usdcTopupCard',
            pointsE6: points6,
            usdcE6: lockAmount,
            originatingUsdcTx: usdcTx,
        }).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logger)(safe_1.default.yellow(`[treasuryBridgeFulfill] insertMemberTopupEvent: ${msg}`));
        });
        if (obj.res && !obj.res.headersSent) {
            obj.res
                .status(200)
                .json({
                success: true,
                USDC_tx: usdcTx,
                operationId,
                lockMintTxHash,
                mintTxHash,
                cardOwner,
                recipientEOA,
                points6: points6.toString(),
            })
                .end();
        }
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        if (String(msg).includes('GENESIS_BRIDGE_INITIATOR_BASE_BUSY')) {
            exports.treasuryBridgeFulfillPool.unshift(obj);
            return;
        }
        (0, logger_1.logger)(safe_1.default.red('[treasuryBridgeFulfillProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent) {
            obj.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        scheduleTreasuryBridgeFulfillPoolPress();
    }
};
exports.treasuryBridgeFulfillProcess = treasuryBridgeFulfillProcess;
async function consumeTreasuryBridgeBunitInBackground(args) {
    const { feeBUnits6 } = (0, MemberCard_1.calcTopupFixedBUnitFee)();
    if (feeBUnits6 <= 0n)
        return;
    const provider = settleContractPool_1.Settle_ContractPool[0]?.walletConet?.provider;
    if (!provider)
        return;
    const ownerResolved = await (0, MemberCard_1.resolveCardOwnerToEOA)(provider, args.cardOwner);
    const feePayer = ownerResolved.success ? ownerResolved.cardOwner : ethers_1.ethers.getAddress(args.cardOwner);
    const SC = await shiftSettleConetForWrite('treasuryBridgeFulfill.bunit');
    try {
        const bunit = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUNIT_AIRDROP_ADDRESS, ['function consumeFromUser(address,uint256,bytes32,uint256,uint256)'], SC.walletConet);
        const baseHash = args.USDC_tx;
        const consumeTx = await bunit.consumeFromUser(feePayer, feeBUnits6, baseHash, 0n, 2n, {
            gasLimit: 2_500_000,
        });
        await consumeTx.wait();
        (0, logger_1.logger)(safe_1.default.cyan(`[treasuryBridgeFulfill] consumeFromUser ok: ${Number(feeBUnits6) / 1e6} B-Units from ${feePayer} base=${args.USDC_tx.slice(0, 12)}…`));
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(SC);
    }
}
