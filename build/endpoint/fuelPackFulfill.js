"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fuelPackFulfillProcess = exports.fuelPackFulfillPool = void 0;
exports.kickFuelPackFulfillPoolPress = kickFuelPackFulfillPoolPress;
/**
 * After Base USDC x402 settle → GENESIS_NODE_BRIDGE_INITIATOR:
 * mint paid B-Units (mintForUsdcPurchase) + optional free bonus + Genesis Ket #0
 * to the merchant beneficiary (not the third-party payer).
 * Idempotent on USDC_tx. Occupies Settle_ConetPool only.
 */
const ethers_1 = require("ethers");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const chainAddresses_1 = require("../chainAddresses");
const settleContractPool_1 = require("../settleContractPool");
const fuelPackCatalog_1 = require("../fuelPackCatalog");
(0, settleContractPool_1.ensureSettleContractPoolInitialized)();
const BUNIT_AIRDROP_MINT_ABI = [
    'function mintForUsdcPurchase(address to, uint256 usdcAmount, bytes32 baseTxHash) external',
];
const BUNIT_REWARD_ABI = ['function mintReward(address to, uint256 amount) external'];
const KET_MINT_ABI = [
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function mint(address to, uint256 id, uint256 amount, bytes data) external',
];
const KET_TOKEN_ID = 0n;
exports.fuelPackFulfillPool = [];
function resolveFuelPackFulfillFile() {
    return (process.env.CONET_FUEL_PACK_FULFILL_FILE?.trim() ||
        node_path_1.default.join((0, node_os_1.homedir)(), '.conet-fuel-pack-fulfill.json'));
}
function readFuelPackFulfillFile() {
    const file = resolveFuelPackFulfillFile();
    if (!node_fs_1.default.existsSync(file))
        return {};
    try {
        return JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeFuelPackFulfillRecord(record) {
    const file = resolveFuelPackFulfillFile();
    const all = readFuelPackFulfillFile();
    all[record.USDC_tx.toLowerCase()] = record;
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf-8');
}
function lookupFuelPackFulfill(usdcTx) {
    const key = usdcTx.trim().toLowerCase();
    if (!key)
        return null;
    return readFuelPackFulfillFile()[key] || null;
}
function kickFuelPackFulfillPoolPress() {
    void (0, exports.fuelPackFulfillProcess)().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red('[fuelPackFulfillProcess] kick error:'), msg);
    });
}
function scheduleFuelPackFulfillPoolPress() {
    if (exports.fuelPackFulfillPool.length === 0)
        return;
    if ((0, settleContractPool_1.hasIdleSettleConet)())
        kickFuelPackFulfillPoolPress();
    else
        setTimeout(() => kickFuelPackFulfillPoolPress(), 3000);
}
const fuelPackFulfillProcess = async () => {
    const obj = exports.fuelPackFulfillPool.shift();
    if (!obj)
        return;
    if (!(0, settleContractPool_1.hasIdleSettleConet)()) {
        exports.fuelPackFulfillPool.unshift(obj);
        return setTimeout(() => void (0, exports.fuelPackFulfillProcess)(), 3000);
    }
    const usdcTx = String(obj.USDC_tx ?? '').trim();
    const SC = (0, settleContractPool_1.shiftSettleConet)();
    if (!SC) {
        exports.fuelPackFulfillPool.unshift(obj);
        return setTimeout(() => void (0, exports.fuelPackFulfillProcess)(), 3000);
    }
    try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(usdcTx)) {
            throw new Error('Invalid USDC_tx');
        }
        if (!ethers_1.ethers.isAddress(obj.beneficiary)) {
            throw new Error('Invalid beneficiary');
        }
        const usdcAmount6 = BigInt(String(obj.usdcAmount6 ?? '0'));
        if (usdcAmount6 <= 0n) {
            throw new Error('Invalid usdcAmount6');
        }
        const existing = lookupFuelPackFulfill(usdcTx);
        if (existing) {
            (0, logger_1.logger)(safe_1.default.cyan(`[fuelPackFulfill] idempotent hit USDC_tx=${usdcTx.slice(0, 12)}… paid=${existing.paidMintTxHash.slice(0, 12)}…`));
            if (obj.res && !obj.res.headersSent) {
                obj.res
                    .status(200)
                    .json({
                    success: true,
                    idempotent: true,
                    beneficiary: existing.beneficiary,
                    USDC_tx: existing.USDC_tx,
                    paidMintTxHash: existing.paidMintTxHash,
                    freeMintTxHash: existing.freeMintTxHash || undefined,
                    ketMintTxHash: existing.ketMintTxHash || undefined,
                })
                    .end();
            }
            return;
        }
        const beneficiary = ethers_1.ethers.getAddress(obj.beneficiary);
        const pack = (0, fuelPackCatalog_1.lookupFuelPack)(obj.packId);
        const freeBUnits6 = pack
            ? (0, fuelPackCatalog_1.fuelPackFreeBUnits6)(pack)
            : BigInt(String(obj.freeBUnits6 ?? '0') || '0');
        const mintKet = pack ? pack.firstTimeOnly === true : obj.mintKet === true;
        const airdrop = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUNIT_AIRDROP_ADDRESS, BUNIT_AIRDROP_MINT_ABI, SC.walletConet);
        const paidTx = await airdrop.mintForUsdcPurchase(beneficiary, usdcAmount6, usdcTx);
        const paidReceipt = await paidTx.wait();
        if (paidReceipt?.status !== 1) {
            throw new Error('mintForUsdcPurchase reverted');
        }
        const paidMintTxHash = paidTx.hash;
        let freeMintTxHash = '';
        if (freeBUnits6 > 0n) {
            try {
                const bunit = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUINT, BUNIT_REWARD_ABI, SC.walletConet);
                const freeTx = await bunit.mintReward(beneficiary, freeBUnits6);
                const freeReceipt = await freeTx.wait();
                if (freeReceipt?.status === 1) {
                    freeMintTxHash = freeTx.hash;
                }
                else {
                    (0, logger_1.logger)(safe_1.default.yellow('[fuelPackFulfill] mintReward status!=1; paid mint already confirmed'));
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logger)(safe_1.default.yellow(`[fuelPackFulfill] mintReward skipped: ${msg}`));
            }
        }
        let ketMintTxHash = '';
        if (mintKet && chainAddresses_1.CONET_BUSINESS_START_KET && ethers_1.ethers.isAddress(chainAddresses_1.CONET_BUSINESS_START_KET)) {
            try {
                const ket = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUSINESS_START_KET, KET_MINT_ABI, SC.walletConet);
                const bal = (await ket.balanceOf(beneficiary, KET_TOKEN_ID));
                if (bal >= 1n) {
                    (0, logger_1.logger)(safe_1.default.cyan(`[fuelPackFulfill] skip Ket mint; beneficiary already holds #0 (${beneficiary.slice(0, 10)}…)`));
                }
                else {
                    const ketTx = await ket.mint(beneficiary, KET_TOKEN_ID, 1n, '0x');
                    const ketReceipt = await ketTx.wait();
                    if (ketReceipt?.status !== 1) {
                        throw new Error('BusinessStartKet mint reverted');
                    }
                    ketMintTxHash = ketTx.hash;
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logger)(safe_1.default.red(`[fuelPackFulfill] Ket mint failed: ${msg}`));
                throw e;
            }
        }
        const record = {
            beneficiary,
            payer: ethers_1.ethers.isAddress(obj.payer) ? ethers_1.ethers.getAddress(obj.payer) : String(obj.payer ?? ''),
            USDC_tx: usdcTx,
            usdcAmount6: usdcAmount6.toString(),
            packId: String(obj.packId ?? ''),
            paidMintTxHash,
            freeMintTxHash,
            ketMintTxHash,
            fulfilledAt: new Date().toISOString(),
        };
        writeFuelPackFulfillRecord(record);
        (0, logger_1.logger)(safe_1.default.green(`[fuelPackFulfill] OK USDC_tx=${usdcTx.slice(0, 12)}… beneficiary=${beneficiary.slice(0, 10)}… pack=${record.packId || 'custom'} paid=${paidMintTxHash.slice(0, 12)}… ket=${ketMintTxHash ? ketMintTxHash.slice(0, 12) : 'none'}`));
        if (obj.res && !obj.res.headersSent) {
            obj.res
                .status(200)
                .json({
                success: true,
                beneficiary,
                USDC_tx: usdcTx,
                paidMintTxHash,
                freeMintTxHash: freeMintTxHash || undefined,
                ketMintTxHash: ketMintTxHash || undefined,
                packId: record.packId || undefined,
            })
                .end();
        }
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.red('[fuelPackFulfillProcess] failed:'), msg);
        if (obj.res && !obj.res.headersSent) {
            obj.res.status(400).json({ success: false, error: msg }).end();
        }
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(SC);
        scheduleFuelPackFulfillPoolPress();
    }
};
exports.fuelPackFulfillProcess = fuelPackFulfillProcess;
