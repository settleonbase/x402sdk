"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK = exports.LONGDHANG_MIGRATION_AUTHORIZED_OWNER_EOAS = exports.LONGDHANG_OLD_CARD_OWNER = exports.LONGDHANG_OLD_BASE_CARD = exports.LONGDHANG_MIGRATION_VERSION = exports.LONGDHANG_FROZEN_TOTAL_BALANCE_E6 = exports.LONGDHANG_FROZEN_TERMINALS = exports.LONGDHANG_FROZEN_HOLDERS = exports.isLongDhangFrozenSnapshotEnabled = void 0;
exports.getLongDhangMigrationAdminAddress = getLongDhangMigrationAdminAddress;
exports.isLongDhangMigrationAuthorizedOwner = isLongDhangMigrationAuthorizedOwner;
exports.buildLongDhangMigrationAuthMessage = buildLongDhangMigrationAuthMessage;
exports.verifyLongDhangOwnerAuthorization = verifyLongDhangOwnerAuthorization;
exports.previewLongDhangConetMigrationSnapshot = previewLongDhangConetMigrationSnapshot;
exports.createLongDhangConetMigrationCard = createLongDhangConetMigrationCard;
exports.repairLongDhangMigrationTerminalsOnly = repairLongDhangMigrationTerminalsOnly;
exports.runLongDhangConetMigrationBatch = runLongDhangConetMigrationBatch;
exports.verifyLongDhangConetMigration = verifyLongDhangConetMigration;
exports.executeLongDhangConetMigrationAuto = executeLongDhangConetMigrationAuto;
exports.longDhangJson = longDhangJson;
const ethers_1 = require("ethers");
const safe_1 = __importDefault(require("colors/safe"));
const node_util_1 = require("node:util");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = require("node:path");
const logger_1 = require("../logger");
const chainAddresses_1 = require("../chainAddresses");
const util_1 = require("../util");
const shareTokenProgramIcon_1 = require("../shareTokenProgramIcon");
const MemberCard_1 = require("../MemberCard");
const settleContractPool_1 = require("../settleContractPool");
const CCSA_1 = require("../CCSA");
const BeamioUserCardFactoryPaymaster_json_1 = __importDefault(require("../ABI/BeamioUserCardFactoryPaymaster.json"));
const db_1 = require("../db");
const longDhangConetMigrationFrozen_1 = require("./longDhangConetMigrationFrozen");
var longDhangConetMigrationFrozen_2 = require("./longDhangConetMigrationFrozen");
Object.defineProperty(exports, "isLongDhangFrozenSnapshotEnabled", { enumerable: true, get: function () { return longDhangConetMigrationFrozen_2.isLongDhangFrozenSnapshotEnabled; } });
Object.defineProperty(exports, "LONGDHANG_FROZEN_HOLDERS", { enumerable: true, get: function () { return longDhangConetMigrationFrozen_2.LONGDHANG_FROZEN_HOLDERS; } });
Object.defineProperty(exports, "LONGDHANG_FROZEN_TERMINALS", { enumerable: true, get: function () { return longDhangConetMigrationFrozen_2.LONGDHANG_FROZEN_TERMINALS; } });
Object.defineProperty(exports, "LONGDHANG_FROZEN_TOTAL_BALANCE_E6", { enumerable: true, get: function () { return longDhangConetMigrationFrozen_2.LONGDHANG_FROZEN_TOTAL_BALANCE_E6; } });
Object.defineProperty(exports, "LONGDHANG_MIGRATION_VERSION", { enumerable: true, get: function () { return longDhangConetMigrationFrozen_2.LONGDHANG_MIGRATION_VERSION; } });
const BeamioFactoryPaymasterABI = (Array.isArray(BeamioUserCardFactoryPaymaster_json_1.default)
    ? BeamioUserCardFactoryPaymaster_json_1.default
    : BeamioUserCardFactoryPaymaster_json_1.default.abi ?? []);
exports.LONGDHANG_OLD_BASE_CARD = '0x30d80cD71Fd1FFD346737b387dA11C7412363EFF';
exports.LONGDHANG_OLD_CARD_OWNER = '0xA2d21FBd33F7D754D8d7A53fe2B4e5C39A008a1F';
/** EOAs allowed to open migration UI and sign create / start-migration. */
exports.LONGDHANG_MIGRATION_AUTHORIZED_OWNER_EOAS = [exports.LONGDHANG_OLD_CARD_OWNER];
/** Base mainnet deploy block for LONGDHANG_OLD_BASE_CARD (~2026-05-25). Never scan from 0 — pruned RPC rejects ancient eth_getLogs. */
exports.LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK = 46_475_352;
const DEFAULT_BASE_LOG_CHUNK = 15_000;
const DEFAULT_MAX_RUN_ITEMS = 25;
const CARD_METADATA_BASE_URI = 'https://beamio.app/api/metadata/0x';
const ZERO_INPUT_HASH = ethers_1.ethers.ZeroHash;
const ERC1155_TRANSFER_ABI = new ethers_1.ethers.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'function balanceOf(address account,uint256 id) view returns (uint256)',
    'function owner() view returns (address)',
    'function currency() view returns (uint8)',
    'function pointsUnitPriceInCurrencyE6() view returns (uint256)',
]);
const BEAMIO_ACCOUNT_OWNER_ABI = [
    'function owner() view returns (address)',
    'function getOwner() view returns (address)',
    'function isValidSigner(address signer, bytes calldata data) view returns (bytes4)',
];
const AA_FACTORY_ABI = [
    'function beamioAccountOf(address creator) view returns (address)',
    'function primaryAccountOf(address creator) view returns (address)',
    'function getAddress(address creator,uint256 index) view returns (address)',
    'function createAccountFor(address creator) returns (address)',
];
const USER_CARD_ADMIN_ABI = [
    'function owner() view returns (address)',
    'function isAdmin(address who) view returns (bool)',
    'function balanceOf(address account,uint256 id) view returns (uint256)',
    'function mintPointsByAdmin(address user,uint256 points6)',
];
const ACTION_SYNC_TOKEN_ABI = [
    'function getTransactionActionId(bytes32 txId) view returns (uint256 actionId, bool exists)',
    'function syncTokenAction((bytes32 txId, bytes32 originalPaymentHash, uint256 chainId, bytes32 txCategory, string displayJson, uint64 timestamp, address payer, address payee, uint256 finalRequestAmountFiat6, uint256 finalRequestAmountUSDC6, bool isAAAccount, (address asset, uint256 amountE6, uint8 assetType, uint8 source, uint256 tokenId, uint8 itemCurrencyType, uint256 offsetInRequestCurrencyE6)[] route, (uint16 gasChainType, uint256 gasWei, uint256 gasUSDC6, uint256 serviceUSDC6, uint256 bServiceUSDC6, uint256 bServiceUnits6, address feePayer) fees, (uint256 requestAmountFiat6, uint256 requestAmountUSDC6, uint8 currencyFiat, uint256 discountAmountFiat6, uint16 discountRateBps, uint256 taxAmountFiat6, uint16 taxRateBps, string afterNotePayer, string afterNotePayee) meta, address operator, address[] operatorParentChain, address topAdmin, address subordinate) in_) returns (uint256 actionId)',
];
function bigintJson(_key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}
function conetProvider() {
    return new ethers_1.ethers.JsonRpcProvider(chainAddresses_1.CONET_RPC_URL, undefined, { batchMaxCount: 1 });
}
function baseProvider() {
    const url = process.env.LONGDHANG_BASE_RPC_URL?.trim() || (0, util_1.resolveBeamioBaseHttpRpcUrl)();
    return new ethers_1.ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
}
function resolveLongDhangBaseFromBlock() {
    const raw = process.env.LONGDHANG_BASE_OLD_CARD_FROM_BLOCK?.trim();
    if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0)
            return Math.floor(n);
    }
    return exports.LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK;
}
function normalizeAddress(raw) {
    return ethers_1.ethers.getAddress(raw);
}
function migrationLogPrefix() {
    return '[LongDhangConetMigration]';
}
function getLongDhangMigrationAdminAddress() {
    const env = process.env.LONGDHANG_MIGRATION_ADMIN_EOA?.trim();
    if (env && ethers_1.ethers.isAddress(env))
        return ethers_1.ethers.getAddress(env);
    const sc0 = MemberCard_1.Settle_ContractPool[0];
    if (sc0?.walletConet?.address && ethers_1.ethers.isAddress(sc0.walletConet.address)) {
        return ethers_1.ethers.getAddress(sc0.walletConet.address);
    }
    return ethers_1.ethers.ZeroAddress;
}
function isLongDhangMigrationAuthorizedOwner(raw) {
    try {
        if (!raw?.trim())
            return false;
        const norm = normalizeAddress(raw).toLowerCase();
        return exports.LONGDHANG_MIGRATION_AUTHORIZED_OWNER_EOAS.some((a) => normalizeAddress(a).toLowerCase() === norm);
    }
    catch {
        return false;
    }
}
function buildLongDhangMigrationAuthMessage(args) {
    const owner = normalizeAddress(args.ownerEoa);
    const snap = args.snapshotHash && ethers_1.ethers.isHexString(args.snapshotHash, 32) ? args.snapshotHash.toLowerCase() : '';
    const newCard = args.newCardAddress && ethers_1.ethers.isAddress(args.newCardAddress)
        ? normalizeAddress(args.newCardAddress)
        : ethers_1.ethers.ZeroAddress;
    return [
        'LongDhang CoNET Migration',
        `version:${longDhangConetMigrationFrozen_1.LONGDHANG_MIGRATION_VERSION}`,
        `action:${args.action}`,
        `owner:${owner}`,
        `oldBaseCard:${normalizeAddress(exports.LONGDHANG_OLD_BASE_CARD)}`,
        `newConetCard:${newCard}`,
        `snapshotHash:${snap}`,
        `conetChainId:${chainAddresses_1.CONET_MAINNET_CHAIN_ID}`,
    ].join('\n');
}
function verifyLongDhangOwnerAuthorization(args) {
    try {
        const owner = normalizeAddress(args.ownerEoa);
        if (!isLongDhangMigrationAuthorizedOwner(owner)) {
            return { ok: false, error: 'Only an authorized LongDhang migration operator can authorize this migration.' };
        }
        if (!ethers_1.ethers.isHexString(args.snapshotHash, 32)) {
            return { ok: false, error: 'Invalid snapshotHash.' };
        }
        const message = buildLongDhangMigrationAuthMessage(args);
        const signer = normalizeAddress(ethers_1.ethers.verifyMessage(message, args.signature));
        if (signer !== owner) {
            return { ok: false, error: 'Migration authorization signer is not the LongDhang owner.' };
        }
        return { ok: true, signer };
    }
    catch (e) {
        return { ok: false, error: e?.message ?? 'Invalid migration authorization.' };
    }
}
async function resolveOldBaseAaFactory(card, provider) {
    const tryRead = async (sig) => {
        try {
            const c = new ethers_1.ethers.Contract(await card.getAddress(), [sig], provider);
            const addr = String(await c.getFunction(sig.slice(9, sig.indexOf(')') + 1))());
            return ethers_1.ethers.isAddress(addr) ? ethers_1.ethers.getAddress(addr) : null;
        }
        catch {
            return null;
        }
    };
    const fromUnderscore = await tryRead('function _aaFactory() view returns (address)');
    if (fromUnderscore)
        return fromUnderscore;
    const fromPlain = await tryRead('function aaFactory() view returns (address)');
    if (fromPlain)
        return fromPlain;
    return ethers_1.ethers.getAddress(chainAddresses_1.BEAMIO_AA_FACTORY);
}
async function resolveBeamioAccountOwner(holder, provider) {
    const account = new ethers_1.ethers.Contract(holder, BEAMIO_ACCOUNT_OWNER_ABI, provider);
    for (const fn of ['owner', 'getOwner']) {
        try {
            const owner = String(await account.getFunction(fn)());
            if (ethers_1.ethers.isAddress(owner))
                return ethers_1.ethers.getAddress(owner);
        }
        catch {
            /* try next */
        }
    }
    return null;
}
async function aaFactoryMatchesHolder(factoryAddress, eoa, holder, provider) {
    const aaFactory = new ethers_1.ethers.Contract(factoryAddress, AA_FACTORY_ABI, provider);
    const holderNorm = normalizeAddress(holder);
    for (const fn of ['beamioAccountOf', 'primaryAccountOf']) {
        try {
            const addr = String(await aaFactory.getFunction(fn)(eoa));
            if (ethers_1.ethers.isAddress(addr) && ethers_1.ethers.getAddress(addr) === holderNorm)
                return true;
        }
        catch {
            /* try next */
        }
    }
    try {
        const predicted = String(await aaFactory.getFunction('getAddress')(eoa, 0n));
        return ethers_1.ethers.isAddress(predicted) && ethers_1.ethers.getAddress(predicted) === holderNorm;
    }
    catch {
        return false;
    }
}
async function resolveBaseAaForEoa(factoryAddress, eoa, provider) {
    const aaFactory = new ethers_1.ethers.Contract(factoryAddress, AA_FACTORY_ABI, provider);
    const eoaNorm = normalizeAddress(eoa);
    for (const fn of ['beamioAccountOf', 'primaryAccountOf']) {
        try {
            const addr = String(await aaFactory.getFunction(fn)(eoaNorm));
            if (ethers_1.ethers.isAddress(addr) && ethers_1.ethers.getAddress(addr) !== ethers_1.ethers.ZeroAddress) {
                return ethers_1.ethers.getAddress(addr);
            }
        }
        catch {
            /* try next */
        }
    }
    const predicted = String(await aaFactory.getFunction('getAddress')(eoaNorm, 0n));
    if (!ethers_1.ethers.isAddress(predicted))
        throw new Error(`AA factory returned invalid address for ${eoaNorm}`);
    return ethers_1.ethers.getAddress(predicted);
}
function metadataBaseDir() {
    return (0, node_path_1.resolve)(process.env.METADATA_BASE ?? '/home/peter/.data/metadata');
}
function metadataFilePathForCard0(cardAddress) {
    const dir = metadataBaseDir();
    const filename = `0x${ethers_1.ethers.getAddress(cardAddress).slice(2).toLowerCase()}0.json`;
    return { dir, path: (0, node_path_1.resolve)(dir, filename), filename };
}
async function fetchOldCardMetadataFromApi() {
    const token0 = '0'.repeat(64);
    const url = `${CARD_METADATA_BASE_URI}${ethers_1.ethers.getAddress(exports.LONGDHANG_OLD_BASE_CARD).slice(2).toLowerCase()}${token0}.json`;
    try {
        const res = await fetch(url);
        if (!res.ok)
            return null;
        const data = await res.json();
        if (data && typeof data === 'object' && !Array.isArray(data))
            return data;
    }
    catch {
        /* network metadata is optional */
    }
    return null;
}
function normalizeOldCardMetadataForNewCard(raw) {
    const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    const shareRaw = base.shareTokenMetadata;
    const shareTokenMetadata = shareRaw && typeof shareRaw === 'object' && !Array.isArray(shareRaw)
        ? { ...shareRaw }
        : {};
    if (!shareTokenMetadata.name && typeof base.name === 'string')
        shareTokenMetadata.name = base.name;
    if (!shareTokenMetadata.description && typeof base.description === 'string') {
        shareTokenMetadata.description = base.description;
    }
    if (!shareTokenMetadata.image && typeof base.image === 'string')
        shareTokenMetadata.image = base.image;
    if (!shareTokenMetadata.name)
        shareTokenMetadata.name = 'LongDhang';
    Object.assign(shareTokenMetadata, (0, shareTokenProgramIcon_1.ensureShareTokenProgramIconAssembled)(shareTokenMetadata));
    const shareIcon = typeof shareTokenMetadata.icon === 'string' && shareTokenMetadata.icon.trim()
        ? shareTokenMetadata.icon.trim()
        : '';
    const tiers = Array.isArray(base.tiers) ? base.tiers : undefined;
    const upgradeRaw = Number(base.upgradeType);
    const upgradeType = upgradeRaw === 0 || upgradeRaw === 1 || upgradeRaw === 2 ? upgradeRaw : undefined;
    const transferWhitelistEnabled = typeof base.transferWhitelistEnabled === 'boolean' ? base.transferWhitelistEnabled : undefined;
    const fileMetadata = {
        ...base,
        name: typeof base.name === 'string' && base.name.trim() ? base.name : shareTokenMetadata.name,
        ...(typeof base.description === 'string' && base.description.trim()
            ? { description: base.description }
            : typeof shareTokenMetadata.description === 'string'
                ? { description: shareTokenMetadata.description }
                : {}),
        ...(shareIcon ? { icon: shareIcon } : {}),
        ...(typeof shareTokenMetadata.image === 'string' && shareTokenMetadata.image.trim()
            ? { image: shareTokenMetadata.image.trim() }
            : typeof base.image === 'string' && base.image.trim()
                ? { image: base.image }
                : {}),
        shareTokenMetadata,
        ...(tiers && tiers.length > 0 && { tiers }),
        ...(upgradeType != null && { upgradeType }),
        ...(typeof transferWhitelistEnabled === 'boolean' && { transferWhitelistEnabled }),
    };
    return { fileMetadata, shareTokenMetadata, tiers, upgradeType, transferWhitelistEnabled };
}
async function copyLongDhangOldCardMetadataToNewCard(args) {
    const dbRow = await (0, db_1.getCardByAddress)(exports.LONGDHANG_OLD_BASE_CARD).catch(() => null);
    const oldMetadata = dbRow?.metadata && typeof dbRow.metadata === 'object'
        ? dbRow.metadata
        : await fetchOldCardMetadataFromApi();
    const normalized = normalizeOldCardMetadataForNewCard(oldMetadata);
    const { dir, path, filename } = metadataFilePathForCard0(args.newCardAddress);
    if (!path.startsWith(dir + '/') && path !== dir)
        throw new Error('Invalid metadata path');
    if (!node_fs_1.default.existsSync(dir))
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    node_fs_1.default.writeFileSync(path, JSON.stringify(normalized.fileMetadata, null, 2), 'utf-8');
    (0, logger_1.logger)(safe_1.default.green(`${migrationLogPrefix()} copied old card metadata to ${filename}`));
    await (0, db_1.registerCardToDb)({
        cardAddress: args.newCardAddress,
        cardOwner: args.cardOwner,
        currency: args.currency,
        priceInCurrencyE6: args.priceInCurrencyE6,
        uri: CARD_METADATA_BASE_URI,
        shareTokenMetadata: normalized.shareTokenMetadata,
        ...(normalized.tiers && normalized.tiers.length > 0 && {
            tiers: normalized.tiers,
        }),
        ...(normalized.upgradeType != null && { upgradeType: normalized.upgradeType }),
        ...(typeof normalized.transferWhitelistEnabled === 'boolean' && {
            transferWhitelistEnabled: normalized.transferWhitelistEnabled,
        }),
        txHash: args.txHash,
    });
}
const adminManagerIface = new ethers_1.ethers.Interface([
    'function adminManager(address to, bool admin, uint256 newThreshold, string metadata)',
    'function adminManager(address to, bool admin, uint256 newThreshold, string metadata, uint256 mintLimit)',
]);
/** Base/CoNET admin list entry (AA or EOA) → terminal EOA for adminManager.to (Cluster rejects AA). */
async function resolveSubordinateAdminEoa(provider, addr) {
    if (!addr || !ethers_1.ethers.isAddress(addr))
        throw new Error(`Invalid subordinate address: ${addr}`);
    const raw = normalizeAddress(addr);
    const code = await provider.getCode(raw);
    if (code && code !== '0x' && code.length > 2) {
        try {
            const ownerRes = await provider.call({ to: raw, data: '0x8da5cb5b' });
            if (ownerRes && typeof ownerRes === 'string' && ownerRes.length >= 66) {
                return normalizeAddress(`0x${ownerRes.slice(-40)}`);
            }
        }
        catch {
            /* fall through */
        }
    }
    return raw;
}
function normalizeLongDhangTerminalMetadataForCoNet(metaObj, fallback) {
    const base = metaObj && typeof metaObj === 'object' && !Array.isArray(metaObj)
        ? { ...metaObj }
        : { ...(fallback ?? {}) };
    const deviceName = typeof base.deviceName === 'string' && base.deviceName.trim()
        ? base.deviceName.trim()
        : typeof base.name === 'string' && base.name.trim()
            ? base.name.trim()
            : 'POS Terminal';
    const handleRaw = typeof base.handle === 'string' ? base.handle.trim() : '';
    const handle = handleRaw ? (handleRaw.startsWith('@') ? handleRaw : `@${handleRaw}`) : '';
    const allowedTopupMethods = Array.isArray(base.allowedTopupMethods)
        ? base.allowedTopupMethods.map((x) => String(x))
        : ['cash', 'bankCard'];
    const payload = {
        ...base,
        deviceName,
        ...(handle ? { handle } : {}),
        allowedTopupMethods,
        migratedFromCard: normalizeAddress(exports.LONGDHANG_OLD_BASE_CARD),
        source: 'longdhangConetMigration',
    };
    return JSON.stringify(payload);
}
async function collectLongDhangSubAdmins(provider) {
    if ((0, longDhangConetMigrationFrozen_1.isLongDhangFrozenSnapshotEnabled)()) {
        return longDhangConetMigrationFrozen_1.LONGDHANG_FROZEN_TERMINALS.map((t) => {
            let metaObj = {};
            try {
                const parsed = JSON.parse(t.metadataJson);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    metaObj = parsed;
                }
            }
            catch {
                metaObj = { rawMetadata: t.metadataJson };
            }
            return {
                posEoa: normalizeAddress(t.posEoa),
                metadata: normalizeLongDhangTerminalMetadataForCoNet(metaObj),
                mintLimitE6: t.mintLimitE6,
            };
        }).sort((a, b) => a.posEoa.localeCompare(b.posEoa));
    }
    const out = new Map();
    const ownerNorm = normalizeAddress(exports.LONGDHANG_OLD_CARD_OWNER).toLowerCase();
    const dbRows = await (0, db_1.listPosTerminalCardBindingsByCard)(exports.LONGDHANG_OLD_BASE_CARD);
    for (const row of dbRows) {
        if (!ethers_1.ethers.isAddress(row.posEoa))
            continue;
        let posEoa;
        try {
            posEoa = await resolveSubordinateAdminEoa(provider, row.posEoa);
        }
        catch {
            continue;
        }
        if (posEoa.toLowerCase() === ownerNorm)
            continue;
        const metadataObj = row.terminalMetadata && typeof row.terminalMetadata === 'object' && !Array.isArray(row.terminalMetadata)
            ? row.terminalMetadata
            : { source: 'longdhangConetMigration', role: 'sub-admin' };
        out.set(posEoa.toLowerCase(), {
            posEoa,
            metadata: normalizeLongDhangTerminalMetadataForCoNet(metadataObj),
            mintLimitE6: '0',
        });
    }
    const card = new ethers_1.ethers.Contract(exports.LONGDHANG_OLD_BASE_CARD, [
        'function getAdminListWithMetadata() view returns (address[] admins, string[] metadatas, address[] parents)',
        'function adminMintLimit(address admin) view returns (uint256)',
    ], provider);
    try {
        const [admins, metadatas] = (await card.getAdminListWithMetadata());
        for (let i = 0; i < admins.length; i++) {
            const pos = admins[i];
            if (!pos || !ethers_1.ethers.isAddress(pos))
                continue;
            const chainAdmin = normalizeAddress(pos);
            if (chainAdmin.toLowerCase() === ownerNorm)
                continue;
            let posEoa;
            try {
                posEoa = await resolveSubordinateAdminEoa(provider, chainAdmin);
            }
            catch {
                continue;
            }
            const metaRaw = typeof metadatas[i] === 'string' && metadatas[i].trim() ? metadatas[i].trim() : '{}';
            let metaObj = null;
            try {
                const parsed = JSON.parse(metaRaw);
                metaObj =
                    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                        ? parsed
                        : { rawMetadata: metaRaw };
            }
            catch {
                metaObj = { rawMetadata: metaRaw };
            }
            let limit = 0n;
            try {
                limit = BigInt(await card.adminMintLimit(chainAdmin));
            }
            catch {
                try {
                    limit = BigInt(await card.adminMintLimit(posEoa));
                }
                catch {
                    limit = 0n;
                }
            }
            const prior = out.get(posEoa.toLowerCase());
            out.set(posEoa.toLowerCase(), {
                posEoa,
                metadata: normalizeLongDhangTerminalMetadataForCoNet(metaObj, prior ? JSON.parse(prior.metadata) : undefined),
                mintLimitE6: limit > 0n ? limit.toString() : (prior?.mintLimitE6 ?? '0'),
            });
        }
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`${migrationLogPrefix()} getAdminListWithMetadata failed: ${e?.message ?? e}`));
    }
    return [...out.values()].sort((a, b) => a.posEoa.localeCompare(b.posEoa));
}
/** @deprecated use collectLongDhangSubAdmins */
async function collectLongDhangPaymentTerminals(provider) {
    return collectLongDhangSubAdmins(provider);
}
function stableSnapshotHash(payload) {
    // Hash only migration payload — exclude scan window (baseFromBlock/baseToBlock/baseRpcUrl) so
    // preview → create-card → addAdmin → executeAuto does not drift when Base head advances.
    const stable = {
        version: payload.version,
        oldBaseCard: normalizeAddress(payload.oldBaseCard),
        oldBaseCardOwner: normalizeAddress(payload.oldBaseCardOwner),
        baseChainId: payload.baseChainId,
        conetChainId: payload.conetChainId,
        oldBaseAaFactory: normalizeAddress(payload.oldBaseAaFactory),
        totalBalanceE6: payload.totalBalanceE6,
        holders: [...payload.holders]
            .sort((a, b) => a.eoa.localeCompare(b.eoa))
            .map((h) => ({
            eoa: normalizeAddress(h.eoa),
            oldBaseAA: normalizeAddress(h.oldBaseAA),
            balanceE6: h.balanceE6,
        })),
    };
    return ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(JSON.stringify(stable)));
}
async function collectToken0HoldersFromTransfers(provider, cardAddress, fromBlock, toBlock) {
    const balances = new Map();
    const topicSingle = ERC1155_TRANSFER_ABI.getEvent('TransferSingle').topicHash;
    const topicBatch = ERC1155_TRANSFER_ABI.getEvent('TransferBatch').topicHash;
    const chunk = Math.max(1_000, Number(process.env.LONGDHANG_BASE_LOG_CHUNK ?? DEFAULT_BASE_LOG_CHUNK));
    for (let start = fromBlock; start <= toBlock; start += chunk) {
        const end = Math.min(toBlock, start + chunk - 1);
        let logs;
        try {
            logs = await provider.getLogs({
                address: cardAddress,
                fromBlock: start,
                toBlock: end,
                topics: [[topicSingle, topicBatch]],
            });
        }
        catch (e) {
            const msg = String(e?.error?.message ?? e?.message ?? e);
            if (/pruned history|pruned/i.test(msg)) {
                throw new Error(`Base RPC cannot serve eth_getLogs for blocks ${start}–${end} (pruned history). ` +
                    `Set LONGDHANG_BASE_OLD_CARD_FROM_BLOCK to the card deploy block (default ${exports.LONGDHANG_OLD_BASE_CARD_DEPLOY_BLOCK}) ` +
                    `or LONGDHANG_BASE_RPC_URL to a full/archive Base node.`);
            }
            throw e;
        }
        for (const log of logs) {
            try {
                const parsed = ERC1155_TRANSFER_ABI.parseLog(log);
                if (!parsed)
                    continue;
                if (parsed.name === 'TransferSingle') {
                    const from = ethers_1.ethers.getAddress(parsed.args[1]);
                    const to = ethers_1.ethers.getAddress(parsed.args[2]);
                    const id = BigInt(parsed.args[3]);
                    const value = BigInt(parsed.args[4]);
                    if (id !== 0n || value <= 0n)
                        continue;
                    if (from !== ethers_1.ethers.ZeroAddress)
                        balances.set(from, (balances.get(from) ?? 0n) - value);
                    if (to !== ethers_1.ethers.ZeroAddress)
                        balances.set(to, (balances.get(to) ?? 0n) + value);
                }
                else if (parsed.name === 'TransferBatch') {
                    const from = ethers_1.ethers.getAddress(parsed.args[1]);
                    const to = ethers_1.ethers.getAddress(parsed.args[2]);
                    const ids = parsed.args[3];
                    const values = parsed.args[4];
                    for (let i = 0; i < ids.length; i++) {
                        const id = BigInt(ids[i] ?? 0n);
                        const value = BigInt(values[i] ?? 0n);
                        if (id !== 0n || value <= 0n)
                            continue;
                        if (from !== ethers_1.ethers.ZeroAddress)
                            balances.set(from, (balances.get(from) ?? 0n) - value);
                        if (to !== ethers_1.ethers.ZeroAddress)
                            balances.set(to, (balances.get(to) ?? 0n) + value);
                    }
                }
            }
            catch (e) {
                (0, logger_1.logger)(safe_1.default.yellow(`${migrationLogPrefix()} failed to parse transfer log: ${e?.message ?? e}`));
            }
        }
    }
    for (const [addr, bal] of [...balances.entries()]) {
        if (bal <= 0n)
            balances.delete(addr);
    }
    return balances;
}
let snapshotCache = null;
const snapshotByHashCache = new Map();
const SNAPSHOT_BY_HASH_TTL_MS = 2 * 60 * 60 * 1000;
function rememberSnapshotByHash(snapshot) {
    snapshotByHashCache.set(snapshot.snapshotHash.toLowerCase(), snapshot);
    const cutoff = Date.now() - SNAPSHOT_BY_HASH_TTL_MS;
    for (const [hash, snap] of snapshotByHashCache) {
        if (Date.parse(snap.generatedAt) < cutoff)
            snapshotByHashCache.delete(hash);
    }
}
async function resolveLongDhangMigrationSnapshot(options) {
    const requested = options.requestedHash?.trim().toLowerCase();
    if (requested && ethers_1.ethers.isHexString(requested, 32)) {
        const cached = snapshotByHashCache.get(requested);
        if (cached)
            return cached;
    }
    const snapshot = await previewLongDhangConetMigrationSnapshot({ force: options.force ?? Boolean(requested) });
    if (requested && snapshot.snapshotHash.toLowerCase() !== requested) {
        throw new Error(`Snapshot hash mismatch. Current=${snapshot.snapshotHash}, requested=${options.requestedHash}. ` +
            `Members or Base balances changed since preview — refresh and Start Migration again.`);
    }
    return snapshot;
}
async function upsertMemberHolderFromBaseBalance(args) {
    const eoa = normalizeAddress(args.eoa);
    let oldBaseAA = '';
    if (args.preferredAa && ethers_1.ethers.isAddress(args.preferredAa) && ethers_1.ethers.getAddress(args.preferredAa) !== ethers_1.ethers.ZeroAddress) {
        oldBaseAA = ethers_1.ethers.getAddress(args.preferredAa);
    }
    else {
        oldBaseAA = await resolveBaseAaForEoa(args.aaFactory, eoa, args.provider);
    }
    const balance = BigInt(await args.oldCard.balanceOf(oldBaseAA, 0n).catch(() => 0n));
    if (balance <= 0n) {
        args.excluded.push({ holder: eoa, balanceE6: '0', reason: 'Member has zero tokenId=0 balance on Base card.' });
        return;
    }
    const key = eoa.toLowerCase();
    const existing = args.holderByEoa.get(key);
    if (!existing || BigInt(existing.balanceE6) < balance) {
        args.holderByEoa.set(key, {
            eoa,
            oldBaseAA,
            balanceE6: balance.toString(),
            sourceHolder: 'members-directory',
        });
    }
}
async function buildHoldersFromMembersDirectory(args) {
    const holderByEoa = new Map();
    const excluded = [];
    const anomalies = [];
    const pageSize = 2000;
    let offset = 0;
    let total = 0;
    do {
        const page = await (0, db_1.listDistinctCardMemberTopupMembers)(exports.LONGDHANG_OLD_BASE_CARD, { limit: pageSize, offset });
        total = page.total;
        for (const m of page.items) {
            if (!m.memberEoa || !ethers_1.ethers.isAddress(m.memberEoa))
                continue;
            try {
                await upsertMemberHolderFromBaseBalance({
                    oldCard: args.oldCard,
                    aaFactory: args.aaFactory,
                    provider: args.provider,
                    eoa: m.memberEoa,
                    preferredAa: m.memberAa,
                    holderByEoa,
                    excluded,
                });
            }
            catch (e) {
                anomalies.push({
                    holder: m.memberEoa,
                    balanceE6: '0',
                    reason: e?.message ?? String(e),
                });
            }
        }
        if (page.items.length < pageSize)
            break;
        offset += pageSize;
    } while (offset < total);
    return {
        holders: [...holderByEoa.values()].sort((a, b) => a.eoa.localeCompare(b.eoa)),
        excluded,
        anomalies,
    };
}
async function previewLongDhangConetMigrationSnapshot(options = {}) {
    const cacheTtlMs = Number(process.env.LONGDHANG_SNAPSHOT_CACHE_TTL_MS ?? 60_000);
    if (!options.force && snapshotCache && Date.now() - snapshotCache.at < cacheTtlMs)
        return snapshotCache.value;
    if ((0, longDhangConetMigrationFrozen_1.isLongDhangFrozenSnapshotEnabled)()) {
        const stable = (0, longDhangConetMigrationFrozen_1.longDhangFrozenSnapshotStablePayload)();
        const scanMeta = (0, longDhangConetMigrationFrozen_1.longDhangFrozenSnapshotScanMeta)();
        const holders = stable.holders.map((h) => ({
            ...h,
            sourceHolder: 'frozen-snapshot',
        }));
        const basePayload = {
            ...stable,
            baseRpcUrl: scanMeta.baseRpcUrl,
            baseFromBlock: scanMeta.baseFromBlock,
            baseToBlock: scanMeta.baseToBlock,
            holderCount: holders.length,
            excludedCount: 0,
            holders,
            excluded: [],
            anomalies: [],
        };
        const snapshot = {
            ...basePayload,
            snapshotHash: stableSnapshotHash(basePayload),
            migrationAdmin: getLongDhangMigrationAdminAddress(),
            generatedAt: scanMeta.generatedAt,
            terminals: longDhangConetMigrationFrozen_1.LONGDHANG_FROZEN_TERMINALS.map((t) => ({
                posEoa: normalizeAddress(t.posEoa),
                metadata: normalizeLongDhangTerminalMetadataForCoNet(JSON.parse(t.metadataJson)),
                mintLimitE6: t.mintLimitE6,
            })),
            terminalCount: longDhangConetMigrationFrozen_1.LONGDHANG_FROZEN_TERMINALS.length,
        };
        snapshotCache = { at: Date.now(), value: snapshot };
        rememberSnapshotByHash(snapshot);
        return snapshot;
    }
    const provider = baseProvider();
    const oldCard = new ethers_1.ethers.Contract(exports.LONGDHANG_OLD_BASE_CARD, ERC1155_TRANSFER_ABI, provider);
    const latest = await provider.getBlockNumber();
    const fromBlock = resolveLongDhangBaseFromBlock();
    const toBlock = Number(process.env.LONGDHANG_BASE_OLD_CARD_TO_BLOCK ?? latest);
    const ownerOnChain = normalizeAddress(await oldCard.owner());
    if (ownerOnChain !== normalizeAddress(exports.LONGDHANG_OLD_CARD_OWNER)) {
        throw new Error(`Unexpected LongDhang old card owner: ${ownerOnChain}`);
    }
    const aaFactory = await resolveOldBaseAaFactory(oldCard, provider);
    const useMembersDirectory = String(process.env.LONGDHANG_SNAPSHOT_USE_MEMBERS ?? 'true').toLowerCase() !== 'false';
    let holders = [];
    let excluded = [];
    let anomalies = [];
    if (useMembersDirectory) {
        const built = await buildHoldersFromMembersDirectory({ oldCard, aaFactory, provider });
        holders = built.holders;
        excluded = built.excluded;
        anomalies = built.anomalies;
    }
    else {
        const transferBalances = await collectToken0HoldersFromTransfers(provider, exports.LONGDHANG_OLD_BASE_CARD, fromBlock, toBlock);
        const holderByEoa = new Map();
        for (const [holder, eventBalance] of [...transferBalances.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            let currentBalance = 0n;
            try {
                currentBalance = BigInt(await oldCard.balanceOf(holder, 0n));
            }
            catch (e) {
                anomalies.push({ holder, balanceE6: eventBalance.toString(), reason: `balanceOf failed: ${e?.message ?? e}` });
                continue;
            }
            if (currentBalance <= 0n)
                continue;
            if (currentBalance !== eventBalance) {
                anomalies.push({
                    holder,
                    balanceE6: currentBalance.toString(),
                    reason: `event replay balance ${eventBalance.toString()} differs from balanceOf`,
                });
            }
            const code = await provider.getCode(holder);
            if (!code || code === '0x') {
                let oldBaseAA = '';
                try {
                    oldBaseAA = await resolveBaseAaForEoa(aaFactory, holder, provider);
                }
                catch (e) {
                    excluded.push({
                        holder,
                        balanceE6: currentBalance.toString(),
                        reason: `direct EOA holder; could not resolve Base AA: ${e?.message ?? e}`,
                    });
                    continue;
                }
                const aaBalance = BigInt(await oldCard.balanceOf(oldBaseAA, 0n).catch(() => 0n));
                if (aaBalance <= 0n) {
                    excluded.push({
                        holder,
                        balanceE6: currentBalance.toString(),
                        reason: `direct EOA holder; Base AA ${oldBaseAA} has zero tokenId=0 balance`,
                    });
                    continue;
                }
                holderByEoa.set(holder.toLowerCase(), {
                    eoa: ethers_1.ethers.getAddress(holder),
                    oldBaseAA,
                    balanceE6: aaBalance.toString(),
                    sourceHolder: holder,
                });
                continue;
            }
            const eoa = await resolveBeamioAccountOwner(holder, provider);
            if (!eoa) {
                excluded.push({ holder, balanceE6: currentBalance.toString(), reason: 'holder is not a readable BeamioAccount' });
                continue;
            }
            const matches = await aaFactoryMatchesHolder(aaFactory, eoa, holder, provider);
            if (!matches) {
                excluded.push({ holder, balanceE6: currentBalance.toString(), reason: 'holder is not the EOA primary/index-0 AA' });
                continue;
            }
            const eoaKey = eoa.toLowerCase();
            const existing = holderByEoa.get(eoaKey);
            if (!existing || BigInt(existing.balanceE6) < currentBalance) {
                holderByEoa.set(eoaKey, { eoa, oldBaseAA: holder, balanceE6: currentBalance.toString(), sourceHolder: holder });
            }
        }
        holders = [...holderByEoa.values()].sort((a, b) => a.eoa.localeCompare(b.eoa));
    }
    let total = 0n;
    for (const row of holders)
        total += BigInt(row.balanceE6);
    const basePayload = {
        version: longDhangConetMigrationFrozen_1.LONGDHANG_MIGRATION_VERSION,
        oldBaseCard: normalizeAddress(exports.LONGDHANG_OLD_BASE_CARD),
        oldBaseCardOwner: normalizeAddress(exports.LONGDHANG_OLD_CARD_OWNER),
        baseChainId: chainAddresses_1.BASE_MAINNET_CHAIN_ID,
        conetChainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
        baseRpcUrl: (0, util_1.resolveBeamioBaseHttpRpcUrl)(),
        baseFromBlock: fromBlock,
        baseToBlock: toBlock,
        oldBaseAaFactory: aaFactory,
        holderCount: holders.length,
        totalBalanceE6: total.toString(),
        excludedCount: excluded.length,
        holders,
        excluded,
        anomalies,
    };
    const terminalRows = await collectLongDhangSubAdmins(provider);
    const snapshot = {
        ...basePayload,
        snapshotHash: stableSnapshotHash(basePayload),
        migrationAdmin: getLongDhangMigrationAdminAddress(),
        generatedAt: new Date().toISOString(),
        terminals: terminalRows,
        terminalCount: terminalRows.length,
    };
    snapshotCache = { at: Date.now(), value: snapshot };
    rememberSnapshotByHash(snapshot);
    return snapshot;
}
function currencyEnumToSymbol(n) {
    const symbols = ['CAD', 'USD', 'JPY', 'CNY', 'USDC', 'HKD', 'EUR', 'SGD', 'TWD'];
    return symbols[n] ?? 'CAD';
}
async function createLongDhangConetMigrationCard(options) {
    const sc = (0, settleContractPool_1.shiftSettleConet)();
    if (!sc)
        return { success: false, error: 'Settle_ContractPool is busy or not initialized.' };
    let cardOwner = normalizeAddress(exports.LONGDHANG_OLD_CARD_OWNER);
    if (options?.cardOwnerEoa && ethers_1.ethers.isAddress(options.cardOwnerEoa)) {
        const candidate = normalizeAddress(options.cardOwnerEoa);
        if (!isLongDhangMigrationAuthorizedOwner(candidate)) {
            return { success: false, error: 'cardOwnerEoa is not an authorized migration operator.' };
        }
        cardOwner = candidate;
    }
    try {
        const base = baseProvider();
        const oldCard = new ethers_1.ethers.Contract(exports.LONGDHANG_OLD_BASE_CARD, ERC1155_TRANSFER_ABI, base);
        const currencyEnum = Number(await oldCard.currency().catch(() => 0n));
        const price = BigInt(await oldCard.pointsUnitPriceInCurrencyE6().catch(() => 1000000n));
        const currency = currencyEnumToSymbol(currencyEnum);
        const factory = new ethers_1.ethers.Contract(chainAddresses_1.CONET_CARD_FACTORY, BeamioFactoryPaymasterABI, sc.walletConet);
        const result = await (0, CCSA_1.createBeamioCardWithFactoryReturningHash)(factory, cardOwner, currency, price, {
            uri: CARD_METADATA_BASE_URI,
            contractName: 'LongDhang',
            upgradeType: 0,
            transferWhitelistEnabled: false,
            libraryAddresses: {
                BeamioUserCardAdminGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
                BeamioUserCardFaucetGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
                BeamioUserCardFormattingLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_FORMATTING_LIB,
                BeamioUserCardGatewayMintLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
                BeamioUserCardGovernanceLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_GOVERNANCE_LIB,
                BeamioUserCardIssuedNftGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
                BeamioUserCardModuleRouterLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
                BeamioUserCardRedeemGatewayLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
                BeamioUserCardReferrerLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_REFERRER_LIB,
                BeamioUserCardTransferLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_TRANSFER_LIB,
                BeamioUserCardUpdateLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_UPDATE_LIB,
                BeamioUserCardViewsLib: chainAddresses_1.CONET_BEAMIO_USER_CARD_VIEWS_LIB,
            },
        });
        await copyLongDhangOldCardMetadataToNewCard({
            newCardAddress: result.cardAddress,
            cardOwner,
            currency,
            priceInCurrencyE6: price.toString(),
            txHash: result.hash,
        });
        return {
            success: true,
            cardAddress: result.cardAddress,
            txHash: result.hash,
            ownerEoa: cardOwner,
            migrationAdmin: normalizeAddress(sc.walletConet.address),
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.red(`${migrationLogPrefix()} create card failed: ${e?.message ?? e}`));
        return { success: false, error: e?.message ?? String(e) };
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(sc);
    }
}
function executeForAdminDomain(verifyingContract) {
    return {
        name: 'BeamioUserCardFactory',
        version: '1',
        chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
        verifyingContract: normalizeAddress(verifyingContract),
    };
}
async function signExecuteForAdminWithWallet(wallet, cardAddress, data, deadline, nonce) {
    const types = {
        ExecuteForAdmin: [
            { name: 'cardAddress', type: 'address' },
            { name: 'dataHash', type: 'bytes32' },
            { name: 'deadline', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
        ],
    };
    return wallet.signTypedData(executeForAdminDomain(chainAddresses_1.CONET_CARD_FACTORY), types, {
        cardAddress: normalizeAddress(cardAddress),
        dataHash: ethers_1.ethers.keccak256(data),
        deadline,
        nonce,
    });
}
async function ensureConetAaForEoaWithWallet(eoa, wallet) {
    const factory = new ethers_1.ethers.Contract(chainAddresses_1.CONET_AA_FACTORY, AA_FACTORY_ABI, wallet);
    const eoaNorm = normalizeAddress(eoa);
    let aa = '';
    for (const fn of ['beamioAccountOf', 'primaryAccountOf']) {
        try {
            const raw = String(await factory.getFunction(fn)(eoaNorm));
            if (ethers_1.ethers.isAddress(raw) && ethers_1.ethers.getAddress(raw) !== ethers_1.ethers.ZeroAddress) {
                aa = ethers_1.ethers.getAddress(raw);
                break;
            }
        }
        catch {
            /* try next */
        }
    }
    if (aa) {
        const code = await wallet.provider.getCode(aa);
        if (code && code !== '0x')
            return { aa };
    }
    // CoNET AA CREATE2 deploy needs ~2.8M gas; 1.8M OOG → LibDeployFailed() with empty code at predicted address.
    let gasLimit = 3500000n;
    try {
        const estimated = await factory.createAccountFor.estimateGas(eoaNorm);
        gasLimit = (estimated * 125n) / 100n + 150000n;
        if (gasLimit < 3000000n)
            gasLimit = 3000000n;
    }
    catch {
        /* keep conservative fallback */
    }
    const tx = await factory.createAccountFor(eoaNorm, { gasLimit });
    const receipt = await tx.wait();
    if (!receipt || Number(receipt.status ?? 0) !== 1) {
        throw new Error(`createAccountFor failed for ${eoaNorm} (CoNET AA deploy likely needs ≥3M gas; check LibDeployFailed / CREATE2 OOG)`);
    }
    const created = String(await factory.beamioAccountOf(eoaNorm));
    if (!ethers_1.ethers.isAddress(created) || ethers_1.ethers.getAddress(created) === ethers_1.ethers.ZeroAddress) {
        throw new Error(`AA factory did not register account for ${eoaNorm}`);
    }
    return { aa: ethers_1.ethers.getAddress(created), createdTx: tx.hash };
}
function migrationTxId(newCard, row, snapshotHash) {
    return ethers_1.ethers.solidityPackedKeccak256(['string', 'address', 'address', 'address', 'uint256', 'bytes32'], [longDhangConetMigrationFrozen_1.LONGDHANG_MIGRATION_VERSION, normalizeAddress(newCard), normalizeAddress(row.eoa), normalizeAddress(row.oldBaseAA), BigInt(row.balanceE6), snapshotHash]);
}
async function syncMigrationIndexerRow(args) {
    const txId = args.txId;
    try {
        const [, exists] = (await args.indexer.getTransactionActionId(txId));
        if (exists)
            return undefined;
    }
    catch {
        /* old read facet may not expose the helper; try sync and let duplicate revert if needed */
    }
    const amount = BigInt(args.row.balanceE6);
    const displayJson = JSON.stringify({
        title: 'LongDhang CoNET migration airdrop',
        source: 'longdhangConetMigration',
        migration: longDhangConetMigrationFrozen_1.LONGDHANG_MIGRATION_VERSION,
        snapshotHash: args.snapshotHash,
        sourceCard: normalizeAddress(exports.LONGDHANG_OLD_BASE_CARD),
        newConetCard: normalizeAddress(args.newCard),
        oldBaseAA: normalizeAddress(args.row.oldBaseAA),
        conetAA: normalizeAddress(args.conetAA),
        eoa: normalizeAddress(args.row.eoa),
        ...(args.mintTx &&
            args.mintTx !== ethers_1.ethers.ZeroHash && { baseMintTxHash: args.mintTx }),
    });
    const input = {
        txId,
        originalPaymentHash: args.snapshotHash,
        chainId: chainAddresses_1.CONET_MAINNET_CHAIN_ID,
        txCategory: ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes('longdhangMigration:airdrop')),
        displayJson,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
        payer: normalizeAddress(args.row.eoa),
        payee: normalizeAddress(args.conetAA),
        finalRequestAmountFiat6: amount,
        finalRequestAmountUSDC6: 0n,
        isAAAccount: true,
        route: [
            {
                asset: normalizeAddress(args.newCard),
                amountE6: amount,
                assetType: 1,
                source: 1,
                tokenId: 0n,
                itemCurrencyType: 0,
                offsetInRequestCurrencyE6: amount,
            },
        ],
        fees: {
            gasChainType: 0,
            gasWei: 0n,
            gasUSDC6: 0n,
            serviceUSDC6: 0n,
            bServiceUSDC6: 0n,
            bServiceUnits6: 0n,
            feePayer: ethers_1.ethers.ZeroAddress,
        },
        meta: {
            requestAmountFiat6: amount,
            requestAmountUSDC6: 0n,
            currencyFiat: 0,
            discountAmountFiat6: 0n,
            discountRateBps: 0,
            taxAmountFiat6: 0n,
            taxRateBps: 0,
            afterNotePayer: '',
            afterNotePayee: '',
        },
        operator: normalizeAddress(args.operator),
        operatorParentChain: [],
        topAdmin: normalizeAddress(args.operator),
        subordinate: ethers_1.ethers.ZeroAddress,
    };
    let gasLimit = 2500000n;
    try {
        const estimated = await args.indexer.syncTokenAction.estimateGas(input);
        gasLimit = (estimated * 125n) / 100n + 200000n;
        if (gasLimit < 2500000n)
            gasLimit = 2500000n;
    }
    catch {
        /* conservative fallback — 1M OOG observed on CoNET (~985k used) */
    }
    const tx = await args.indexer.syncTokenAction(input, { gasLimit });
    const receipt = await tx.wait();
    if (!receipt || Number(receipt.status ?? 0) !== 1)
        throw new Error(`syncTokenAction failed for ${txId}`);
    return tx.hash;
}
/** Indexer 记账失败不得推翻已成功的链上 mint；返回 hash 或 undefined + 打日志。 */
async function trySyncMigrationIndexerRow(args) {
    try {
        const indexerTx = await syncMigrationIndexerRow(args);
        return { indexerTx };
    }
    catch (e) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        (0, logger_1.logger)(safe_1.default.yellow(`${migrationLogPrefix()} indexer sync failed (mint may still succeed on-chain): ${msg}`));
        return { indexerError: msg };
    }
}
/** @deprecated Server-side POS registration under migration admin — use client owner-signed path per beamio-pos-terminal-admin-hierarchy.mdc */
async function copyLongDhangPaymentTerminalsToNewCard(args) {
    const base = baseProvider();
    const conet = conetProvider();
    const terminals = await collectLongDhangSubAdmins(base);
    const rows = [];
    let registered = 0;
    let skipped = 0;
    let failed = 0;
    const fallbackLimit = BigInt(args.snapshotTotalBalanceE6 || '0');
    for (const t of terminals) {
        const row = {
            posEoa: t.posEoa,
            metadata: t.metadata,
            mintLimitE6: t.mintLimitE6,
            status: 'failed',
        };
        rows.push(row);
        try {
            const posEoa = normalizeAddress(t.posEoa);
            const codeAtPos = await conet.getCode(posEoa);
            if (codeAtPos && codeAtPos !== '0x') {
                throw new Error(`Terminal ${posEoa} is a contract; adminManager requires EOA.`);
            }
            const alreadyAdmin = Boolean(await args.card.isAdmin(posEoa));
            if (alreadyAdmin) {
                await (0, db_1.upsertPosTerminalAdminCardBinding)({
                    posEoa,
                    cardAddress: args.newCard,
                    metadataJson: JSON.parse(t.metadata),
                });
                row.status = 'skipped';
                row.reason = 'Terminal already admin on new card.';
                skipped += 1;
                continue;
            }
            const oldLimit = BigInt(t.mintLimitE6 || '0');
            const mintLimit = oldLimit > 0n ? oldLimit : fallbackLimit;
            row.mintLimitE6 = mintLimit.toString();
            const data = adminManagerIface.encodeFunctionData('adminManager(address,bool,uint256,string,uint256)', [
                posEoa,
                true,
                1n,
                t.metadata,
                mintLimit,
            ]);
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
            const nonce = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
            const signature = await signExecuteForAdminWithWallet(args.wallet, args.newCard, data, deadline, nonce);
            let gasLimit = 2000000n;
            try {
                const estimated = await args.factory.executeForAdmin.estimateGas(args.newCard, data, deadline, nonce, signature);
                gasLimit = (estimated * 125n) / 100n + 200000n;
                if (gasLimit < 2000000n)
                    gasLimit = 2000000n;
            }
            catch {
                /* conservative fallback */
            }
            const tx = await args.factory.executeForAdmin(args.newCard, data, deadline, nonce, signature, { gasLimit });
            const receipt = await tx.wait();
            if (!receipt || Number(receipt.status ?? 0) !== 1)
                throw new Error(`terminal admin tx reverted for ${posEoa}`);
            await (0, db_1.upsertPosTerminalAdminCardBinding)({
                posEoa,
                cardAddress: args.newCard,
                txHash: tx.hash,
                metadataJson: JSON.parse(t.metadata),
            });
            row.status = 'registered';
            row.txHash = tx.hash;
            registered += 1;
        }
        catch (e) {
            row.status = 'failed';
            row.reason = e?.message ?? String(e);
            failed += 1;
            (0, logger_1.logger)(safe_1.default.yellow(`${migrationLogPrefix()} terminal migration failed: ${(0, node_util_1.inspect)(row, false, 3, true)}`));
        }
    }
    return { total: terminals.length, registered, skipped, failed, rows };
}
/** Re-register terminals on CoNET card under merchant owner admin (client-side; owner signs). */
async function repairLongDhangMigrationTerminalsOnly(options) {
    const newCard = normalizeAddress(options.newCardAddress);
    return {
        success: false,
        newCardAddress: newCard,
        admins: { total: 0, registered: 0, skipped: 0, failed: 0, rows: [] },
        verify: { total: 0, matches: 0, mismatches: [] },
        error: 'Terminal repair must run client-side with merchant owner wallet (POST /api/longDhangMigrationRepairTerminals auth + biz registerMigrationTerminalsUnderOwnerAdmin). See beamio-pos-terminal-admin-hierarchy.mdc.',
    };
}
async function runLongDhangConetMigrationBatch(options) {
    const newCard = normalizeAddress(options.newCardAddress);
    const snapshot = await resolveLongDhangMigrationSnapshot({ requestedHash: options.snapshotHash });
    const sc = (0, settleContractPool_1.shiftSettleConet)();
    if (!sc) {
        return {
            success: false,
            newCardAddress: newCard,
            snapshotHash: snapshot.snapshotHash,
            totalSnapshotRows: snapshot.holders.length,
            processed: 0,
            minted: 0,
            skipped: 0,
            failed: 0,
            rows: [],
            terminals: { total: 0, registered: 0, skipped: 0, failed: 0, rows: [] },
            error: 'Settle_ContractPool is busy or not initialized.',
        };
    }
    const rows = [];
    let minted = 0;
    let skipped = 0;
    let failed = 0;
    try {
        const card = new ethers_1.ethers.Contract(newCard, USER_CARD_ADMIN_ABI, sc.walletConet);
        const owner = normalizeAddress(await card.owner());
        if (!isLongDhangMigrationAuthorizedOwner(owner)) {
            throw new Error(`New CoNET card owner is not an authorized migration operator: ${owner}`);
        }
        const adminAddr = normalizeAddress(sc.walletConet.address);
        const isAdmin = Boolean(await card.isAdmin(adminAddr));
        if (!isAdmin)
            throw new Error(`Migration admin ${adminAddr} is not authorized on ${newCard}.`);
        const factory = new ethers_1.ethers.Contract(chainAddresses_1.CONET_CARD_FACTORY, BeamioFactoryPaymasterABI, sc.walletConet);
        const indexer = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_INDEXER_DIAMOND, ACTION_SYNC_TOKEN_ABI, sc.walletConet);
        // POS terminals: owner EOA registers subordinate admins client-side (see beamio-pos-terminal-admin-hierarchy.mdc).
        const terminals = {
            total: 0,
            registered: 0,
            skipped: 0,
            failed: 0,
            rows: [],
        };
        const mintIface = new ethers_1.ethers.Interface(['function mintPointsByAdmin(address user,uint256 points6)']);
        const holderRows = options.limit != null && Number.isFinite(Number(options.limit))
            ? snapshot.holders.slice(0, Math.max(1, Math.floor(Number(options.limit))))
            : snapshot.holders;
        for (const row of holderRows) {
            const out = { ...row, status: 'failed' };
            rows.push(out);
            try {
                const { aa } = await ensureConetAaForEoaWithWallet(row.eoa, sc.walletConet);
                out.conetAA = aa;
                const expected = BigInt(row.balanceE6);
                const current = BigInt(await card.balanceOf(aa, 0n));
                const txId = migrationTxId(newCard, row, snapshot.snapshotHash);
                out.txId = txId;
                const indexerArgs = {
                    indexer,
                    txId,
                    newCard,
                    row,
                    conetAA: aa,
                    mintTx: out.mintTx ?? ethers_1.ethers.ZeroHash,
                    snapshotHash: snapshot.snapshotHash,
                    operator: adminAddr,
                };
                if (current >= expected) {
                    const { indexerTx, indexerError } = await trySyncMigrationIndexerRow(indexerArgs);
                    if (indexerTx)
                        out.indexerTx = indexerTx;
                    if (indexerError)
                        out.indexerError = indexerError;
                    out.status = 'skipped';
                    out.reason = indexerError
                        ? 'CoNET AA already has the snapshot balance; indexer sync pending retry.'
                        : 'CoNET AA already has the snapshot balance.';
                    skipped += 1;
                    continue;
                }
                const delta = expected - current;
                const data = mintIface.encodeFunctionData('mintPointsByAdmin', [aa, delta]);
                const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
                const nonce = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
                const signature = await signExecuteForAdminWithWallet(sc.walletConet, newCard, data, deadline, nonce);
                const tx = await factory.executeForAdmin(newCard, data, deadline, nonce, signature, { gasLimit: 2_500_000 });
                const receipt = await tx.wait();
                if (!receipt || Number(receipt.status ?? 0) !== 1)
                    throw new Error(`executeForAdmin reverted for ${row.eoa}`);
                out.mintTx = tx.hash;
                const { indexerTx, indexerError } = await trySyncMigrationIndexerRow({
                    ...indexerArgs,
                    mintTx: tx.hash,
                });
                if (indexerTx)
                    out.indexerTx = indexerTx;
                if (indexerError) {
                    out.indexerError = indexerError;
                    out.reason = `Mint ok (${tx.hash}); indexer sync failed: ${indexerError}`;
                }
                out.status = 'minted';
                minted += 1;
            }
            catch (e) {
                out.status = 'failed';
                out.reason = e?.message ?? String(e);
                failed += 1;
                (0, logger_1.logger)(safe_1.default.yellow(`${migrationLogPrefix()} row failed: ${(0, node_util_1.inspect)(out, false, 3, true)}`));
            }
        }
        return {
            success: failed === 0 && terminals.failed === 0,
            newCardAddress: newCard,
            snapshotHash: snapshot.snapshotHash,
            totalSnapshotRows: snapshot.holders.length,
            processed: rows.length,
            minted,
            skipped,
            failed,
            rows,
            admins: terminals,
            terminals,
            ...((failed > 0 || terminals.failed > 0) && {
                error: `${failed} member row(s), ${terminals.failed} sub-admin row(s) failed.`,
            }),
        };
    }
    finally {
        (0, settleContractPool_1.unshiftSettleConet)(sc);
    }
}
async function verifyLongDhangConetMigration(newCardAddress, options = {}) {
    const newCard = normalizeAddress(newCardAddress);
    const snapshot = await previewLongDhangConetMigrationSnapshot();
    const provider = conetProvider();
    const card = new ethers_1.ethers.Contract(newCard, USER_CARD_ADMIN_ABI, provider);
    const aaFactory = new ethers_1.ethers.Contract(chainAddresses_1.CONET_AA_FACTORY, AA_FACTORY_ABI, provider);
    const mismatches = [];
    let matches = 0;
    for (const row of snapshot.holders) {
        try {
            const aa = ethers_1.ethers.getAddress(await aaFactory.beamioAccountOf(row.eoa));
            if (aa === ethers_1.ethers.ZeroAddress) {
                mismatches.push({ ...row, reason: 'CoNET AA not registered.' });
                continue;
            }
            const code = await provider.getCode(aa);
            if (!code || code === '0x') {
                mismatches.push({ ...row, conetAA: aa, reason: 'CoNET AA has no code.' });
                continue;
            }
            const bal = BigInt(await card.balanceOf(aa, 0n));
            if (bal !== BigInt(row.balanceE6)) {
                mismatches.push({ ...row, conetAA: aa, conetBalanceE6: bal.toString(), reason: 'Balance mismatch.' });
                continue;
            }
            matches += 1;
        }
        catch (e) {
            mismatches.push({ ...row, reason: e?.message ?? String(e) });
        }
    }
    const expectedTerminals = options.membersOnly ? [] : await collectLongDhangSubAdmins(baseProvider());
    const terminalMismatches = [];
    let terminalMatches = 0;
    for (const t of expectedTerminals) {
        try {
            const isAdmin = Boolean(await card.isAdmin(t.posEoa));
            const dbRow = await (0, db_1.getPosTerminalCardBindingRow)(t.posEoa);
            const dbCard = dbRow?.cardAddress ?? null;
            const cardOwner = normalizeAddress(await card.owner());
            const parent = normalizeAddress((await card.adminParent(t.posEoa)));
            if (!isAdmin) {
                terminalMismatches.push({ posEoa: t.posEoa, reason: 'Terminal is not admin on new card.', dbCardAddress: dbCard });
                continue;
            }
            if (parent !== cardOwner) {
                terminalMismatches.push({
                    posEoa: t.posEoa,
                    reason: `adminParent ${parent} must equal card owner ${cardOwner} (POS under merchant owner admin).`,
                    dbCardAddress: dbCard,
                });
                continue;
            }
            if (!dbCard || ethers_1.ethers.getAddress(dbCard) !== newCard) {
                terminalMismatches.push({ posEoa: t.posEoa, reason: 'POS binding DB does not point to new card.', dbCardAddress: dbCard });
                continue;
            }
            terminalMatches += 1;
        }
        catch (e) {
            terminalMismatches.push({ posEoa: t.posEoa, reason: e?.message ?? String(e) });
        }
    }
    return {
        success: mismatches.length === 0 && (options.membersOnly || terminalMismatches.length === 0),
        newCardAddress: newCard,
        snapshotHash: snapshot.snapshotHash,
        totalRows: snapshot.holders.length,
        matches,
        mismatches,
        terminals: {
            total: expectedTerminals.length,
            matches: terminalMatches,
            mismatches: terminalMismatches,
        },
    };
}
/** One-shot server migration after owner has authorized migration admin on the new CoNET card. */
async function executeLongDhangConetMigrationAuto(options) {
    const phases = [];
    const pushPhase = (phase, ok, detail) => {
        phases.push({ phase, ok, detail });
    };
    try {
        const snapshot = await resolveLongDhangMigrationSnapshot({
            requestedHash: options.snapshotHash,
            force: true,
        });
        pushPhase('snapshot', true, `${snapshot.holderCount} members from frozen Base snapshot (${longDhangConetMigrationFrozen_1.LONGDHANG_FROZEN_TERMINALS.length} terminals)`);
        let newCardAddress = options.existingNewCardAddress?.trim() ?? '';
        if (!newCardAddress || !ethers_1.ethers.isAddress(newCardAddress)) {
            const created = await createLongDhangConetMigrationCard({
                cardOwnerEoa: options.cardOwnerEoa,
            });
            if (!created.success) {
                pushPhase('create-card', false, created.error);
                throw new Error(created.error ?? 'Create CoNET card failed.');
            }
            newCardAddress = created.cardAddress;
            pushPhase('create-card', true, newCardAddress);
        }
        else {
            newCardAddress = ethers_1.ethers.getAddress(newCardAddress);
            pushPhase('create-card', true, `Using existing card ${newCardAddress}`);
        }
        const migrationAdmin = getLongDhangMigrationAdminAddress();
        const conetCard = new ethers_1.ethers.Contract(newCardAddress, USER_CARD_ADMIN_ABI, conetProvider());
        const isAdmin = migrationAdmin !== ethers_1.ethers.ZeroAddress && Boolean(await conetCard.isAdmin(migrationAdmin));
        if (!isAdmin) {
            pushPhase('authorize-admin', false, `Migration admin ${migrationAdmin} is not authorized on ${newCardAddress}.`);
            throw new Error(`Migration admin is not authorized on ${newCardAddress}. Unlock wallet and retry Start Migration.`);
        }
        pushPhase('authorize-admin', true, migrationAdmin);
        const run = await runLongDhangConetMigrationBatch({
            newCardAddress,
            snapshotHash: snapshot.snapshotHash,
        });
        const adminStats = run.admins ?? run.terminals;
        pushPhase('migrate-members', run.failed === 0, `${run.minted} minted, ${run.skipped} skipped, ${run.failed} failed (${run.totalSnapshotRows} total)`);
        pushPhase('migrate-admins', true, 'Deferred — merchant owner registers POS subordinate admins client-side (beamio-pos-terminal-admin-hierarchy).');
        if (!run.success) {
            throw new Error(run.error ?? 'Member migration failed.');
        }
        const verify = await verifyLongDhangConetMigration(newCardAddress, { membersOnly: true });
        pushPhase('verify', verify.success, `${verify.matches}/${verify.totalRows} members, ${verify.terminals.matches}/${verify.terminals.total} sub-admins`);
        if (!verify.success) {
            throw new Error('Verification found balance or sub-admin mismatches.');
        }
        return {
            success: true,
            newCardAddress,
            snapshotHash: snapshot.snapshotHash,
            phases,
            members: {
                total: run.totalSnapshotRows,
                minted: run.minted,
                skipped: run.skipped,
                failed: run.failed,
            },
            admins: {
                total: adminStats?.total ?? 0,
                registered: adminStats?.registered ?? 0,
                skipped: adminStats?.skipped ?? 0,
                failed: adminStats?.failed ?? 0,
                rows: adminStats?.rows ?? [],
            },
            verify: {
                success: verify.success,
                memberMatches: verify.matches,
                memberTotal: verify.totalRows,
                adminMatches: verify.terminals.matches,
                adminTotal: verify.terminals.total,
            },
        };
    }
    catch (e) {
        const msg = e?.message ?? String(e);
        if (phases.length === 0 || phases[phases.length - 1]?.ok) {
            pushPhase('failed', false, msg);
        }
        return {
            success: false,
            newCardAddress: options.existingNewCardAddress && ethers_1.ethers.isAddress(options.existingNewCardAddress)
                ? ethers_1.ethers.getAddress(options.existingNewCardAddress)
                : ethers_1.ethers.ZeroAddress,
            snapshotHash: '',
            phases,
            members: { total: 0, minted: 0, skipped: 0, failed: 0 },
            admins: { total: 0, registered: 0, skipped: 0, failed: 0 },
            error: msg,
        };
    }
}
function longDhangJson(value) {
    return JSON.stringify(value, bigintJson, 2);
}
