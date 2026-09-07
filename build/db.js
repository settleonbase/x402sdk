"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertAiLearningFeedback = exports.applyNfcCardLinkStateChange = exports.getNfcCardPosAdminGateByUid = exports.getNfcCardPosAdminGateByTagId = exports.getNfcCardSignedTxGateByUid = exports.getNfcCardSignedTxGateByTagId = exports.resolveUniqueBeamioNfcAccountName = exports.buildBeamioNfcBeamioAccountName = exports.upsertNfcCardBeamioNfcNumberByTagId = exports.setNfcCardBeamioNfcNumberIfUnset = exports.getNfcBeamioNfcNumberByTagId = exports.allocateNextBeamioNfcNumber = exports.getBeamioNfcSeqLastAssigned = exports.buildVerraBeamioAccountName = exports.upsertNfcCardVerraNumberByTagId = exports.setNfcCardVerraNumberIfUnset = exports.getNfcVerraNumberByTagId = exports.allocateNextVerraNumber = exports.NFC_CARD_LINK_STATE_SCOPE = exports.listCardMemberDirectory = exports.listDistinctCardMemberTopupMembers = exports.getMemberLastTopupOnCard = exports.listCardMemberTopupEvents = exports.insertMemberTopupEvent = exports.getCardTopupRollup = exports.listPosTerminalCardBindingsByCard = exports.listMerchantCardAddressesForOwnerNewestFirst = exports.deletePosTerminalCardBinding = exports.setActivePosTerminalCardBinding = exports.listPosTerminalCardBindingsForWallet = exports.getPosTerminalCardBindingRow = exports.getPosTerminalCardAddressForWallet = exports.deletePosTerminalAdminCardBinding = exports.upsertPosTerminalAdminCardBinding = exports.assertPosEoaAvailableForCardBinding = exports.regiestChatRoute = exports.addUser = exports.registerBeamioTagForAddress = exports.isBeamioAccountNameAvailable = exports.normalizeBeamioAccountName = exports.maybeClearLegacyNfcBeamioProfileNames = exports.maybeEnqueueNfcVerraBeamioTag = exports.maybeEnqueueNfcBeamioTag = exports.maybeEnqueueNfcCashTreeBeamioTag = exports.getNfcTagIdByUid = exports.buildCashTreeNfcBeamioAccountName = exports.ensureAddressPgpBeamioAdmins = exports.ensureAccountRegistryBeamioAdmins = exports.beamio_ContractPool = exports.isOnchainEmptyResult = void 0;
exports._search = exports._searchExactByAddress = exports.resolveSearchAddressToEOALower = exports.getMintMetadataForOwner = exports.getSeriesByCardAndTokenId = exports.listProductionIssuedNftSeriesForCardDescending = exports.listCouponIssuedNftSeriesForCardDescending = exports.listRecentBeamioIssuedCouponSeries = exports.getOwnerNftSeries = exports.registerMintMetadataToDb = exports.updateSeriesMetadataByCardAndToken = exports.registerSeriesToDb = exports.getLatestCardsGroupedByCategory = exports.getRecentCategorizedBeamioCards = exports.getLatestCards = exports.getNftTierMetadataByCardAndToken = exports.listMembershipNftTierTokenIdsByCard = exports.BEAMIO_ISSUED_NFT_START_ID = exports.BEAMIO_MEMBERSHIP_NFT_START_ID = exports.getNftTierMetadataByOwnerAndToken = exports.upsertNftTierMetadata = exports.insertApiExcludedUserCard = exports.listApiExcludedUserCardAddressesFromDb = exports.getCardCreatedAtByAddress = exports.getCardByAddress = exports.listRegisteredBeamioUserCardAddresses = exports.listReferralMerchantCandidates = exports.getDistinctBeamioCardOwnerAddressesLower = exports.getBeamioCardRowForMetadataSync = exports.registerCardToDb = exports.upsertBeamioSunLastCounterByUid = exports.getBeamioSunLastCounterStateByUid = exports.getBeamioSunLastCounterByUid = exports.listLinkedNfcCardsByOwnerEoa = exports.replaceNfcCardKeyByTagId = exports.registerNfcCardToDb = exports.getNfcRecipientAddressByUid = exports.provisionOrGetNfcWalletByTagId = exports.backfillNfcCardTagIdByUid = exports.isTagIdRegistered = exports.releaseNfcLinkAppSessionIfMatches = exports.listNfcLinkAppSessionsDueForAutoCancel = exports.markNfcLinkAppSessionReleasedByTag = exports.fetchActiveNfcLinkAppSessionForPaymentBlock = exports.upsertActiveNfcLinkAppSession = exports.getNfcRecipientAddressByTagId = exports.getNfcCardPrivateKeyByTagId = exports.getNfcCardPrivateKeyByUid = exports.getNfcCardByUid = exports.getAiLearningFeedback = void 0;
exports.ipfsDataProcess = exports.ipfsAccessProcess = exports.ipfsAccessPool = exports.ipfsDataPool = exports.getMyFollowStatus = exports.FollowerStatus = exports.addFollow = exports.removeFollow = exports.searchUsers = exports.searchUsersResultsForKeyward = void 0;
exports.upsertReferralRegistryClaim = upsertReferralRegistryClaim;
exports.listReferralRegistryClaimsByParent = listReferralRegistryClaimsByParent;
exports.upsertGenesisNodeReferralPurchase = upsertGenesisNodeReferralPurchase;
exports.updateGenesisNodeReferralBridgeSettleTx = updateGenesisNodeReferralBridgeSettleTx;
exports.listGenesisNodeReferralPurchasesMissingBridgeSettle = listGenesisNodeReferralPurchasesMissingBridgeSettle;
exports.getGenesisNodeReferralPurchaseByUsdcTx = getGenesisNodeReferralPurchaseByUsdcTx;
exports.expandGenesisNodeReferralIncomeItems = expandGenesisNodeReferralIncomeItems;
exports.listGenesisNodeReferralPurchasesForAccount = listGenesisNodeReferralPurchasesForAccount;
exports.listGenesisNodeReferralIncomeForAccount = listGenesisNodeReferralIncomeForAccount;
exports.getReferralRegistryTreeSync = getReferralRegistryTreeSync;
exports.setReferralRegistryTreeRebuilding = setReferralRegistryTreeRebuilding;
exports.tryStartReferralRegistryTreeRebuild = tryStartReferralRegistryTreeRebuild;
exports.replaceReferralRegistryTreeMembers = replaceReferralRegistryTreeMembers;
exports.upsertReferralRegistryTreeMember = upsertReferralRegistryTreeMember;
exports.listReferralRegistryTreeByAccount = listReferralRegistryTreeByAccount;
exports.topupCategoryIsRepeatMemberTopup = topupCategoryIsRepeatMemberTopup;
exports.upsertNfcBeamioUserCardHoldingsFromTrustedCards = upsertNfcBeamioUserCardHoldingsFromTrustedCards;
exports.listNfcBeamioUserCardHoldingsByTagId = listNfcBeamioUserCardHoldingsByTagId;
exports.nfcBeamioUserCardHoldingContains = nfcBeamioUserCardHoldingContains;
exports.buildNfcCardLinkStateSignMessage = buildNfcCardLinkStateSignMessage;
exports.mergeBeamioCardMetadataJsonPatch = mergeBeamioCardMetadataJsonPatch;
const ethers_1 = require("ethers");
const pg_1 = require("pg");
const logger_1 = require("./logger");
const util_1 = require("util");
const safe_1 = __importDefault(require("colors/safe"));
const util_2 = require("./util");
const beamio_conet_abi_json_1 = __importDefault(require("./ABI/beamio-conet.abi.json"));
const conet_airdrop_abi_json_1 = __importDefault(require("./ABI/conet_airdrop.abi.json"));
const beamio_AccountRegistry_json_1 = __importDefault(require("./ABI/beamio-AccountRegistry.json"));
const Ipfs_abi_json_1 = __importDefault(require("./ABI/Ipfs.abi.json"));
const conetPGP_json_1 = __importDefault(require("./ABI/conetPGP.json"));
const chainAddresses_1 = require("./chainAddresses");
const couponMetadataCategory_1 = require("./couponMetadataCategory");
const apiExcludedUserCards_1 = require("./apiExcludedUserCards");
const beamioWalletIdentity_1 = require("./beamioWalletIdentity");
const resolveBeamioAaViaUserCardFactory_1 = require("./endpoint/resolveBeamioAaViaUserCardFactory");
const latestCardsQueryCache_1 = require("./endpoint/latestCardsQueryCache");
/**
 *
 *
 *
 */
const RPC_URL = chainAddresses_1.CONET_RPC_URL;
const BASE_RPC_URL = (0, util_2.resolveBeamioBaseHttpRpcUrl)();
/**
 * 判断一次 ethers `view`/`pure` 调用的异常是否等价于「链上无数据」。
 * 当合约返回 0x（如 `getOwnerByAccountName(未注册名字)` / `getAccount(未注册地址)`）时，
 * ethers v6 抛出 `BAD_DATA: could not decode result data (value="0x", ...)`。
 * 这等价于「该 key 不存在」而不是真正的 RPC/合约错误，调用方应当作 `ZeroAddress`/`undefined` 处理。
 */
const isOnchainEmptyResult = (ex) => {
    if (!ex)
        return false;
    if (ex.code === 'BAD_DATA')
        return true;
    const msg = ex.shortMessage || ex.message || String(ex);
    return /could not decode result data|value="0x"|BAD_DATA/i.test(msg);
};
exports.isOnchainEmptyResult = isOnchainEmptyResult;
const providerConet = new ethers_1.ethers.JsonRpcProvider(RPC_URL);
const providerBase = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
const beamioConet = '0xCE8e2Cda88FfE2c99bc88D9471A3CBD08F519FEd';
const airdropRecord = '0x070BcBd163a3a280Ab6106bA62A079f228139379';
const beamioConetAccountRegistry = '0xfFDc8d2021A41F4638Cb3eCf58B5155383EE9f6d';
const IpfsStorageRegistryGlobalDedup = '0x121c4dDCa92f07dc53Fd6Db9bc5A07c2918F9591';
const addressPGP = '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2';
exports.beamio_ContractPool = util_2.masterSetup.beamio_Admins.map(n => {
    const walletConet = new ethers_1.ethers.Wallet(n, providerConet);
    (0, logger_1.logger)(`address => ${walletConet.address}`);
    return {
        // baseWalletClient: walletClientBase,
        privateKey: n,
        wallet: walletConet,
        conetSC: new ethers_1.ethers.Contract(beamioConet, beamio_conet_abi_json_1.default, walletConet),
        // event: new ethers.Contract(eventContract, Event_ABI, walletConet),
        conetAirdrop: new ethers_1.ethers.Contract(airdropRecord, conet_airdrop_abi_json_1.default, walletConet),
        constAccountRegistry: new ethers_1.ethers.Contract(beamioConetAccountRegistry, beamio_AccountRegistry_json_1.default, walletConet),
        constIPFS: new ethers_1.ethers.Contract(IpfsStorageRegistryGlobalDedup, Ipfs_abi_json_1.default, walletConet),
        constPgpManager: new ethers_1.ethers.Contract(addressPGP, conetPGP_json_1.default, walletConet),
    };
});
const ACCOUNT_REGISTRY_ADMIN_ABI = [
    'function changeAddressInAdminlist(address account, bool status) external',
    'function isAdmin(address account) view returns (bool)',
];
const normRegistryAdminPk = (s) => {
    const t = s.trim();
    return t.startsWith('0x') ? t : `0x${t}`;
};
const isRegistryAdminPrivateKeyHex = (s) => {
    const hex = s.trim().startsWith('0x') ? s.trim().slice(2) : s.trim();
    return hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex);
};
/** ~/.master.json 中应登记为 AccountRegistry admin 的运维钱包地址（去重） */
const collectAccountRegistryAdminTargetAddresses = () => {
    const lower = new Set();
    const addPk = (pk) => {
        if (!isRegistryAdminPrivateKeyHex(pk))
            return;
        lower.add(new ethers_1.ethers.Wallet(normRegistryAdminPk(pk)).address.toLowerCase());
    };
    for (const pk of util_2.masterSetup.beamio_Admins ?? [])
        addPk(String(pk));
    for (const pk of util_2.masterSetup.settle_contractAdmin ?? [])
        addPk(String(pk));
    const adminList = util_2.masterSetup.admin;
    if (Array.isArray(adminList)) {
        for (const entry of adminList) {
            if (typeof entry !== 'string')
                continue;
            const t = entry.trim();
            if (ethers_1.ethers.isAddress(t)) {
                lower.add(ethers_1.ethers.getAddress(t).toLowerCase());
            }
            else if (isRegistryAdminPrivateKeyHex(t)) {
                addPk(t);
            }
        }
    }
    const extra = process.env.ACCOUNT_REGISTRY_EXTRA_ADMINS?.trim() ?? process.env.REGISTRY_EXTRA_ADMINS?.trim() ?? '';
    if (extra) {
        for (const part of extra.split(/[,;\s]+/).filter(Boolean)) {
            const p = part.trim();
            if (ethers_1.ethers.isAddress(p))
                lower.add(ethers_1.ethers.getAddress(p).toLowerCase());
        }
    }
    return [...lower].map((a) => ethers_1.ethers.getAddress(a));
};
/** 可用于 changeAddressInAdminlist 的 signer 候选（须链上已是 admin） */
const collectAccountRegistryOwnerSignerCandidates = () => {
    const seen = new Set();
    const wallets = [];
    const tryAdd = (pkRaw) => {
        if (!pkRaw || !isRegistryAdminPrivateKeyHex(pkRaw))
            return;
        const pk = normRegistryAdminPk(pkRaw);
        if (seen.has(pk))
            return;
        seen.add(pk);
        wallets.push(new ethers_1.ethers.Wallet(pk, providerConet));
    };
    tryAdd(process.env.REGISTRY_OWNER_PK?.trim());
    for (const pk of util_2.masterSetup.settle_contractAdmin ?? [])
        tryAdd(String(pk));
    for (const pk of util_2.masterSetup.beamio_Admins ?? [])
        tryAdd(String(pk));
    const adminList = util_2.masterSetup.admin;
    if (Array.isArray(adminList)) {
        for (const entry of adminList) {
            if (typeof entry === 'string' && isRegistryAdminPrivateKeyHex(entry))
                tryAdd(entry);
        }
    }
    return wallets;
};
let accountRegistryAdminBootstrapDone = false;
/**
 * Master 启动时：检查 ~/.master.json 中 beamio_Admins / settle_contractAdmin 是否已在
 * AccountRegistry admin 列表；缺失则尝试用已有 admin signer 登记。
 * 修复 addUserPoolProcess 的 NotAdmin()（224422 新 Registry 部署后常见）。
 */
const ensureAccountRegistryBeamioAdmins = async () => {
    if (accountRegistryAdminBootstrapDone)
        return;
    accountRegistryAdminBootstrapDone = true;
    const targets = collectAccountRegistryAdminTargetAddresses();
    if (!targets.length) {
        (0, logger_1.logger)(safe_1.default.yellow('[ensureAccountRegistryBeamioAdmins] no target admin addresses in masterSetup'));
        return;
    }
    const registryRead = new ethers_1.ethers.Contract(beamioConetAccountRegistry, ACCOUNT_REGISTRY_ADMIN_ABI, providerConet);
    const missing = [];
    for (const addr of targets) {
        try {
            const ok = await registryRead.isAdmin(addr);
            if (!ok)
                missing.push(addr);
        }
        catch (ex) {
            (0, logger_1.logger)(safe_1.default.yellow(`[ensureAccountRegistryBeamioAdmins] isAdmin(${addr}) failed: ${ex?.message ?? ex}`));
            missing.push(addr);
        }
    }
    if (!missing.length) {
        (0, logger_1.logger)(safe_1.default.green(`[ensureAccountRegistryBeamioAdmins] all ${targets.length} ops wallet(s) are AccountRegistry admins`));
        return;
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[ensureAccountRegistryBeamioAdmins] ${missing.length}/${targets.length} wallet(s) missing admin — registering…`));
    let adminSigner = null;
    for (const candidate of collectAccountRegistryOwnerSignerCandidates()) {
        try {
            if (await registryRead.isAdmin(candidate.address)) {
                adminSigner = candidate;
                break;
            }
        }
        catch {
            // try next signer
        }
    }
    if (!adminSigner) {
        (0, logger_1.logger)(safe_1.default.red('[ensureAccountRegistryBeamioAdmins] no signer is AccountRegistry admin — set REGISTRY_OWNER_PK to deployer key or run scripts/addBeamioAdminsToAccountRegistry.ts'));
        return;
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[ensureAccountRegistryBeamioAdmins] using admin signer ${adminSigner.address}`));
    const registryWrite = new ethers_1.ethers.Contract(beamioConetAccountRegistry, ACCOUNT_REGISTRY_ADMIN_ABI, adminSigner);
    for (const addr of missing) {
        try {
            const already = await registryRead.isAdmin(addr);
            if (already)
                continue;
            const tx = await registryWrite.changeAddressInAdminlist(addr, true);
            (0, logger_1.logger)(safe_1.default.cyan(`[ensureAccountRegistryBeamioAdmins] changeAddressInAdminlist(${addr}, true) tx=${tx.hash}`));
            await tx.wait();
            (0, logger_1.logger)(safe_1.default.green(`[ensureAccountRegistryBeamioAdmins] registered admin ${addr}`));
        }
        catch (ex) {
            const msg = ex?.shortMessage || ex?.message || String(ex);
            (0, logger_1.logger)(safe_1.default.red(`[ensureAccountRegistryBeamioAdmins] failed for ${addr}: ${msg}`));
        }
    }
};
exports.ensureAccountRegistryBeamioAdmins = ensureAccountRegistryBeamioAdmins;
const ADDRESS_PGP_ADMIN_ABI = [
    'function changeAddressInAdminlist(address addr, bool status) external',
    'function adminList(address) view returns (bool)',
];
const collectAddressPgpOwnerSignerCandidates = () => {
    const seen = new Set();
    const wallets = [];
    const tryAdd = (pkRaw) => {
        if (!pkRaw || !isRegistryAdminPrivateKeyHex(pkRaw))
            return;
        const pk = normRegistryAdminPk(pkRaw);
        if (seen.has(pk))
            return;
        seen.add(pk);
        wallets.push(new ethers_1.ethers.Wallet(pk, providerConet));
    };
    tryAdd(process.env.ADDRESS_PGP_ADMIN_PK?.trim());
    tryAdd(process.env.REGISTRY_OWNER_PK?.trim());
    for (const pk of util_2.masterSetup.settle_contractAdmin ?? [])
        tryAdd(String(pk));
    for (const pk of util_2.masterSetup.beamio_Admins ?? [])
        tryAdd(String(pk));
    const adminList = util_2.masterSetup.admin;
    if (Array.isArray(adminList)) {
        for (const entry of adminList) {
            if (typeof entry === 'string' && isRegistryAdminPrivateKeyHex(entry))
                tryAdd(entry);
        }
    }
    return wallets;
};
let addressPgpAdminBootstrapDone = false;
/** Master 启动时：登记 beamio_Admins 为 AddressPGP admin，修复 regiestChatRoute addPublicPGPByAdmin not admin。 */
const ensureAddressPgpBeamioAdmins = async () => {
    if (addressPgpAdminBootstrapDone)
        return;
    addressPgpAdminBootstrapDone = true;
    const targets = collectAccountRegistryAdminTargetAddresses();
    if (!targets.length) {
        (0, logger_1.logger)(safe_1.default.yellow('[ensureAddressPgpBeamioAdmins] no target admin addresses in masterSetup'));
        return;
    }
    const pgpRead = new ethers_1.ethers.Contract(addressPGP, ADDRESS_PGP_ADMIN_ABI, providerConet);
    const missing = [];
    for (const addr of targets) {
        try {
            const ok = await pgpRead.adminList(addr);
            if (!ok)
                missing.push(addr);
        }
        catch (ex) {
            (0, logger_1.logger)(safe_1.default.yellow(`[ensureAddressPgpBeamioAdmins] adminList(${addr}) failed: ${ex?.message ?? ex}`));
            missing.push(addr);
        }
    }
    if (!missing.length) {
        (0, logger_1.logger)(safe_1.default.green(`[ensureAddressPgpBeamioAdmins] all ${targets.length} ops wallet(s) are AddressPGP admins`));
        return;
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[ensureAddressPgpBeamioAdmins] ${missing.length}/${targets.length} wallet(s) missing admin — registering…`));
    let adminSigner = null;
    for (const candidate of collectAddressPgpOwnerSignerCandidates()) {
        try {
            if (await pgpRead.adminList(candidate.address)) {
                adminSigner = candidate;
                break;
            }
        }
        catch {
            // try next signer
        }
    }
    if (!adminSigner) {
        (0, logger_1.logger)(safe_1.default.red('[ensureAddressPgpBeamioAdmins] no signer is AddressPGP admin — set ADDRESS_PGP_ADMIN_PK or run scripts/addBeamioAdminsToAddressPGP.ts'));
        return;
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[ensureAddressPgpBeamioAdmins] using admin signer ${adminSigner.address}`));
    const pgpWrite = new ethers_1.ethers.Contract(addressPGP, ADDRESS_PGP_ADMIN_ABI, adminSigner);
    for (const addr of missing) {
        try {
            const already = await pgpRead.adminList(addr);
            if (already)
                continue;
            const tx = await pgpWrite.changeAddressInAdminlist(addr, true);
            (0, logger_1.logger)(safe_1.default.cyan(`[ensureAddressPgpBeamioAdmins] changeAddressInAdminlist(${addr}, true) tx=${tx.hash}`));
            await tx.wait();
            (0, logger_1.logger)(safe_1.default.green(`[ensureAddressPgpBeamioAdmins] registered admin ${addr}`));
        }
        catch (ex) {
            const msg = ex?.shortMessage || ex?.message || String(ex);
            (0, logger_1.logger)(safe_1.default.red(`[ensureAddressPgpBeamioAdmins] failed for ${addr}: ${msg}`));
        }
    }
};
exports.ensureAddressPgpBeamioAdmins = ensureAddressPgpBeamioAdmins;
let initProcess = false;
const initDB = async () => {
    if (initProcess) {
        return;
    }
    initProcess = true;
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    // 1) 全量同步用户（用合约的 getAccountsPaginated，倒序也没关系）
    let cursor = 0n;
    const pageSize = 500n;
    const contract = exports.beamio_ContractPool[0].constAccountRegistry;
    while (true) {
        const [owners, names, createdAts, nextCursor] = await contract.getAccountsPaginated(cursor, pageSize);
        if (owners.length === 0)
            break;
        for (let i = 0; i < owners.length; i++) {
            const address = owners[i];
            const username = names[i];
            const createdAt = createdAts[i];
            (0, logger_1.logger)((0, util_1.inspect)({ owners, names, createdAts, nextCursor }, false, 3, true));
            // 可以再调用 getAccount(address) 拿其他字段，也可以先只存 username + createdAt
            await db.query(`
			INSERT INTO accounts (address, username, created_at)
			VALUES ($1, $2, $3)
			ON CONFLICT (address) DO UPDATE
			SET username = EXCLUDED.username,
				created_at = EXCLUDED.created_at,
				updated_at = NOW()
			`, [address.toLowerCase(), username, createdAt.toString()]);
        }
        const next = BigInt(nextCursor);
        if (next === cursor)
            break;
        cursor = next;
    }
    // 2) 同步 follow 关系（可以按用户遍历或按 event 扫）
    // 这里演示按用户扫 followList（简单但可能慢，后面可以改用事件）
    const { rows } = await db.query("SELECT address FROM accounts");
    const followPageSize = 500n;
    for (const row of rows) {
        const addr = row.address;
        let fCursor = 0n;
        while (true) {
            const [follows, timestamps, nextCursor, total] = await contract.getFollowsPaginated(addr, fCursor, followPageSize);
            if (follows.length === 0)
                break;
            for (let i = 0; i < follows.length; i++) {
                const followee = follows[i];
                const ts = timestamps[i];
                await db.query(`
			INSERT INTO follows (follower, followee, followed_at)
			VALUES ($1, $2, $3)
			ON CONFLICT (follower, followee) DO UPDATE
				SET followed_at = EXCLUDED.followed_at
			`, [addr.toLowerCase(), followee.toLowerCase(), ts.toString()]);
            }
            const nf = BigInt(nextCursor);
            if (nf === fCursor || nf >= BigInt(total))
                break;
            fCursor = nf;
        }
    }
    await db.end();
};
const updateUserFollowsDB = async (follows, db) => {
    if (!follows.length)
        return;
    // 批量插入（这里简单循环，你以后可以优化成 multi-values）
    for (const f of follows) {
        const follower = f.follower.toLowerCase();
        const followee = f.followee.toLowerCase();
        const followedAtStr = f.followedAt.toString();
        await db.query(`
		INSERT INTO follows (follower, followee, followed_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (follower, followee) DO UPDATE SET
			followed_at = EXCLUDED.followed_at
		`, [follower, followee, followedAtStr]);
    }
};
const updateUserDB = async (account) => {
    const now = new Date();
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    // 防御性：规范一下 address + createdAt
    const address = account.address.toLowerCase();
    const createdAtStr = typeof account.createdAt === "bigint"
        ? account.createdAt.toString()
        : new Date().getTime();
    await db.query(`
			INSERT INTO accounts (
			address,
			username,
			image,
			dark_theme,
			is_usdc_faucet,
			is_eth_faucet,
			initial_loading,
			first_name,
			last_name,
			created_at,
			updated_at
			)
			VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
			)
			ON CONFLICT (address) DO UPDATE SET
			username        = EXCLUDED.username,
			image           = EXCLUDED.image,
			dark_theme      = EXCLUDED.dark_theme,
			is_usdc_faucet  = EXCLUDED.is_usdc_faucet,
			is_eth_faucet   = EXCLUDED.is_eth_faucet,
			initial_loading = EXCLUDED.initial_loading,
			first_name      = EXCLUDED.first_name,
			last_name       = EXCLUDED.last_name,
			created_at      = EXCLUDED.created_at,
			updated_at      = EXCLUDED.updated_at
		`, [
        address,
        account.accountName,
        account.image ?? null,
        account.darkTheme,
        account.isUSDCFaucet,
        account.isETHFaucet,
        account.initialLoading,
        account.firstName ?? null,
        account.lastName ?? null,
        createdAtStr,
        now
    ]);
    (0, logger_1.logger)(`updateUserDB success! `, (0, util_1.inspect)(account, false, 3, true));
    await db.end();
};
/** 链上该 handle 未绑定时，清除本地 accounts 表中仍挂着该用户名的陈旧缓存（采信链上）。 */
const clearStaleUsernameFromDb = async (accountName) => {
    const nameNorm = String(accountName || '').trim();
    if (!nameNorm)
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const r = await db.query(`
			UPDATE accounts
			SET username = ''
			WHERE TRIM(COALESCE(username, '')) = $1
			`, [nameNorm]);
        const n = r.rowCount ?? 0;
        if (n > 0) {
            (0, logger_1.logger)(safe_1.default.yellow(`[clearStaleUsernameFromDb] cleared stale handle "${nameNorm}" from ${n} row(s) (align with chain)`));
        }
    }
    finally {
        await db.end().catch(() => { });
    }
};
const rowToGetUserDataResult = (r) => {
    const ca = r.created_at;
    let createdAt;
    if (ca == null || ca === "") {
        createdAt = BigInt(Date.now());
    }
    else if (typeof ca === "bigint") {
        createdAt = ca;
    }
    else {
        createdAt = BigInt(String(ca));
    }
    return {
        address: String(r.address ?? "").toLowerCase(),
        username: String(r.username ?? ""),
        image: String(r.image ?? ""),
        darkTheme: Boolean(r.dark_theme),
        isUSDCFaucet: Boolean(r.is_usdc_faucet),
        isETHFaucet: Boolean(r.is_eth_faucet),
        initialLoading: r.initial_loading !== false,
        firstName: String(r.first_name ?? ""),
        lastName: String(r.last_name ?? ""),
        createdAt,
    };
};
/** 仅读本地 DB，不访问链。 */
const getUserDataFromDbByUsername = async (userName) => {
    const nameNorm = String(userName || "").trim();
    if (!nameNorm)
        return null;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const { rows } = await db.query(`
			SELECT address, username, image, dark_theme, is_usdc_faucet, is_eth_faucet,
				initial_loading, first_name, last_name, created_at
			FROM accounts
			WHERE TRIM(COALESCE(username, '')) = $1
			LIMIT 1
			`, [nameNorm]);
        const row = rows[0];
        if (!row)
            return null;
        return rowToGetUserDataResult(row);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getUserDataFromDbByUsername] ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
/** 可信链上数据拉取并写回本地（供 getUserData 后台调用）。 */
const syncUserDataFromChainToDb = async (userName) => {
    const SC = exports.beamio_ContractPool[0].constAccountRegistry;
    const nameNorm = String(userName || "").trim();
    if (!nameNorm)
        return;
    try {
        // getOwnerByAccountName 在新 registry 上对未注册的 username 会返回 0x（BAD_DATA），
        // 这等价于「名字未被占用」，不是错误。其它异常（RPC 抖动等）仍走外层 catch 报错。
        let owner;
        try {
            owner = await SC.getOwnerByAccountName(nameNorm);
        }
        catch (probeEx) {
            if (!(0, exports.isOnchainEmptyResult)(probeEx))
                throw probeEx;
            owner = ethers_1.ethers.ZeroAddress;
        }
        if (!owner || owner === ethers_1.ethers.ZeroAddress) {
            (0, logger_1.logger)(`[syncUserDataFromChainToDb] username not found on-chain: ${nameNorm}`);
            try {
                await clearStaleUsernameFromDb(nameNorm);
            }
            catch (cle) {
                (0, logger_1.logger)(safe_1.default.yellow(`[syncUserDataFromChainToDb] clearStaleUsernameFromDb failed: ${cle?.message ?? cle}`));
            }
            return;
        }
        const onchain = await SC.getAccount(owner);
        const accountName = onchain.accountName;
        const image = onchain.image;
        const darkTheme = onchain.darkTheme;
        const isUSDCFaucet = onchain.isUSDCFaucet;
        const isETHFaucet = onchain.isETHFaucet;
        const initialLoading = onchain.initialLoading;
        const firstName = onchain.firstName;
        const lastName = onchain.lastName;
        const createdAt = onchain.createdAt * BigInt(1000);
        const exists = onchain.exists;
        if (!exists) {
            (0, logger_1.logger)(`[syncUserDataFromChainToDb] account.exists = false on-chain for ${owner} (${nameNorm})`);
            return;
        }
        const db = new pg_1.Client({ connectionString: DB_URL });
        await db.connect();
        const now = new Date();
        await db.query(`
			INSERT INTO accounts (
				address,
				username,
				image,
				dark_theme,
				is_usdc_faucet,
				is_eth_faucet,
				initial_loading,
				first_name,
				last_name,
				created_at,
				updated_at
			)
			VALUES (
				$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
			)
			ON CONFLICT (address) DO UPDATE SET
				username        = EXCLUDED.username,
				image           = EXCLUDED.image,
				dark_theme      = EXCLUDED.dark_theme,
				is_usdc_faucet  = EXCLUDED.is_usdc_faucet,
				is_eth_faucet   = EXCLUDED.is_eth_faucet,
				initial_loading = EXCLUDED.initial_loading,
				first_name      = EXCLUDED.first_name,
				last_name       = EXCLUDED.last_name,
				created_at      = EXCLUDED.created_at,
				updated_at      = EXCLUDED.updated_at
			`, [
            owner.toLowerCase(),
            accountName,
            image,
            darkTheme,
            isUSDCFaucet,
            isETHFaucet,
            initialLoading,
            firstName || null,
            lastName || null,
            createdAt.toString(),
            now,
        ]);
        (0, logger_1.logger)(`[syncUserDataFromChainToDb] synced user ${nameNorm} (${owner}) from chain to DB`);
        await db.end();
    }
    catch (ex) {
        (0, logger_1.logger)(`[syncUserDataFromChainToDb] failed for username=${nameNorm}:`, ex?.shortMessage || ex?.message || ex);
    }
};
const syncUserDataFromChainInFlight = new Map();
const enqueueSyncUserDataFromChain = (userName) => {
    const k = String(userName || "").trim();
    if (!k)
        return;
    let p = syncUserDataFromChainInFlight.get(k);
    if (p) {
        void p.catch(() => { });
        return;
    }
    p = syncUserDataFromChainToDb(userName)
        .catch((e) => (0, logger_1.logger)(safe_1.default.yellow(`[getUserData] background sync failed: ${e?.message ?? e}`)))
        .finally(() => {
        syncUserDataFromChainInFlight.delete(k);
    });
    syncUserDataFromChainInFlight.set(k, p);
    void p;
};
/**
 * 先返回本地 DB 缓存（若有），再异步拉取链上可信数据并 upsert 本地。
 * 无本地行时返回 null，后台仍尝试同步（例如链上已有、本地未写入）。
 */
const getUserData = async (userName) => {
    const local = await getUserDataFromDbByUsername(userName);
    enqueueSyncUserDataFromChain(userName);
    return local;
};
const addUserPool = [];
const addFollowPool = [];
const regiestChatRoutePool = [];
/** 清洗 firstName/lastName，防止前端误把 JSON 等拼接到字段中 */
const sanitizeName = (s) => {
    if (s == null || typeof s !== 'string')
        return '';
    return String(s).split(/[\r\n]/)[0].trim().slice(0, 128);
};
/** 历史 NFC 自动登记曾把 uid / SUN TagID 写入 firstName / lastName（纯 hex）。 */
const NFC_LEGACY_STORED_NAME_HEX_RE = /^[0-9A-Fa-f]{8,32}$/;
const isLegacyNfcStoredProfileName = (s) => {
    const t = String(s || '').trim();
    return t !== '' && NFC_LEGACY_STORED_NAME_HEX_RE.test(t);
};
const nfcProfileNamesNeedClear = (firstName, lastName) => isLegacyNfcStoredProfileName(firstName) || isLegacyNfcStoredProfileName(lastName);
/** NFC 持卡 beamioTag 登记：链上 profile 的 first/last 须为空（uid/tagId 仅存 DB，不进 AccountRegistry 姓名）。 */
const NFC_BEAMIO_PROFILE_FIRST_NAME = '';
const NFC_BEAMIO_PROFILE_LAST_NAME = '';
/** 与 Cluster `/addUser` 一致：beamioTag 仅允许 3–26 位字母数字与 _ . */
const BEAMIO_ACCOUNT_NAME_RE = /^[a-zA-Z0-9_.]{3,26}$/;
const BEAMIO_ACCOUNT_NAME_MAX_LEN = 26;
/**
 * NFC CashTree 基础设施卡发卡后的 beamioTag：语义为 CashTreeDamo-{NFT#}，链上/接口不允许 `-`，用 `_`。
 * 过长时缩短为 `CT_` + tokenId 尾部，仍超长则用 `c` + keccak hex（总长 ≤26）。
 */
const buildCashTreeNfcBeamioAccountName = (tierTokenId) => {
    const raw = String(tierTokenId || '').replace(/\s/g, '');
    if (!raw || !/^\d+$/.test(raw))
        return '';
    let candidate = `CashTreeDamo_${raw}`;
    if (candidate.length <= BEAMIO_ACCOUNT_NAME_MAX_LEN && BEAMIO_ACCOUNT_NAME_RE.test(candidate))
        return candidate;
    const tail = raw.length > 20 ? raw.slice(-20) : raw;
    candidate = `CT_${tail}`;
    if (candidate.length <= BEAMIO_ACCOUNT_NAME_MAX_LEN && BEAMIO_ACCOUNT_NAME_RE.test(candidate))
        return candidate;
    const h = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(`nfcCashTree:${raw}`)).slice(2, 27);
    return (`c${h}`).slice(0, BEAMIO_ACCOUNT_NAME_MAX_LEN);
};
exports.buildCashTreeNfcBeamioAccountName = buildCashTreeNfcBeamioAccountName;
/** 根据 UID 查 NFC 卡 tag_id（SUN TagID），无则 null */
const getNfcTagIdByUid = async (uid) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(NFC_CARDS_TABLE);
        await db.query(NFC_CARDS_ADD_TAG_ID);
        const u = String(uid || '').trim().toLowerCase();
        if (!u)
            return null;
        const { rows } = await db.query(`SELECT tag_id FROM nfc_cards WHERE LOWER(TRIM(uid)) = $1 LIMIT 1`, [u]);
        const t = rows[0]?.tag_id;
        if (t == null || String(t).trim() === '')
            return null;
        return String(t).trim().toUpperCase();
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcTagIdByUid] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcTagIdByUid = getNfcTagIdByUid;
/**
 * NFC 持卡 EOA 在 AccountRegistry 上登记/补全 beamioTag（服务端 setAccountByAdmin 队列）。
 * 若用户已有**其他** beamioTag（与本次期望名不同），不覆盖。
 */
const maybeEnqueueNfcCashTreeBeamioTag = (params) => {
    void (async () => {
        try {
            const wallet = ethers_1.ethers.getAddress(String(params.wallet || '').trim());
            const uid = String(params.uid || '').trim();
            const tierTokenId = String(params.tierTokenId || '').trim();
            if (!uid || !tierTokenId || tierTokenId === '0')
                return;
            const expectedName = (0, exports.buildCashTreeNfcBeamioAccountName)(tierTokenId);
            if (!expectedName || !BEAMIO_ACCOUNT_NAME_RE.test(expectedName)) {
                (0, logger_1.logger)(safe_1.default.yellow(`[maybeEnqueueNfcCashTreeBeamioTag] invalid accountName derived from tokenId=${tierTokenId}`));
                return;
            }
            let tagId = params.tagIdHex != null && String(params.tagIdHex).trim() !== '' ? String(params.tagIdHex).trim().toUpperCase() : null;
            if (!tagId)
                tagId = await (0, exports.getNfcTagIdByUid)(uid);
            const reg = exports.beamio_ContractPool[0]?.constAccountRegistry;
            if (!reg) {
                (0, logger_1.logger)(safe_1.default.yellow('[maybeEnqueueNfcCashTreeBeamioTag] no constAccountRegistry'));
                return;
            }
            let exists = false;
            let accName = '';
            let fnOn = '';
            let lnOn = '';
            let onchain = null;
            try {
                onchain = await reg.getAccount(wallet);
                exists = !!onchain?.exists;
                accName = String(onchain?.accountName ?? '').trim();
                fnOn = sanitizeName(onchain?.firstName);
                lnOn = sanitizeName(onchain?.lastName);
            }
            catch {
                exists = false;
                onchain = null;
            }
            if (exists && accName !== '' && accName !== expectedName) {
                (0, logger_1.logger)(safe_1.default.gray(`[maybeEnqueueNfcCashTreeBeamioTag] skip: wallet already has tag ${accName} (expected ${expectedName})`));
                return;
            }
            if (exists && accName === expectedName && fnOn === NFC_BEAMIO_PROFILE_FIRST_NAME && lnOn === NFC_BEAMIO_PROFILE_LAST_NAME) {
                return;
            }
            if (exists && accName === expectedName && !nfcProfileNamesNeedClear(fnOn, lnOn) && (fnOn !== '' || lnOn !== '')) {
                (0, logger_1.logger)(safe_1.default.gray(`[maybeEnqueueNfcCashTreeBeamioTag] skip: wallet has custom profile names`));
                return;
            }
            const getExistsUserData = await getUserData(expectedName);
            const fullInput = {
                accountName: expectedName,
                image: exists && onchain ? String(onchain.image ?? '') : '',
                darkTheme: exists && onchain ? !!onchain.darkTheme : false,
                isUSDCFaucet: exists && onchain ? !!onchain.isUSDCFaucet : false,
                isETHFaucet: exists && onchain ? !!onchain.isETHFaucet : false,
                initialLoading: true,
                firstName: NFC_BEAMIO_PROFILE_FIRST_NAME,
                lastName: NFC_BEAMIO_PROFILE_LAST_NAME,
                pgpKeyID: '',
                pgpKey: '',
                address: wallet,
                createdAt: getExistsUserData?.createdAt,
            };
            addUserPool.push({
                wallet,
                account: fullInput,
                recover: [],
                followBeamioOfficial: false,
            });
            addUserPoolProcess();
            (0, logger_1.logger)(safe_1.default.cyan(`[maybeEnqueueNfcCashTreeBeamioTag] queued setAccountByAdmin wallet=${wallet.slice(0, 10)}… tag=${expectedName} (empty profile names)`));
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[maybeEnqueueNfcCashTreeBeamioTag] error: ${e?.message ?? e}`));
        }
    })();
};
exports.maybeEnqueueNfcCashTreeBeamioTag = maybeEnqueueNfcCashTreeBeamioTag;
/**
 * 无基础设施会员 NFT 时的 NFC 默认 beamioTag：beamio_nfc_{N}。
 * N 来自全局 beamio_nfc_seq；登记前用 getOwnerByAccountName 链上排查，占用则递增再试。
 * tagIdHex 绑定 nfc_cards.beamio_nfc_number 幂等复用同一序号。
 */
const maybeEnqueueNfcBeamioTag = (params) => {
    void (async () => {
        try {
            const wallet = ethers_1.ethers.getAddress(String(params.wallet || '').trim());
            const uid = String(params.uid || '').trim();
            if (!uid)
                return;
            const reg = exports.beamio_ContractPool[0]?.constAccountRegistry;
            if (!reg) {
                (0, logger_1.logger)(safe_1.default.yellow('[maybeEnqueueNfcBeamioTag] no constAccountRegistry'));
                return;
            }
            let exists = false;
            let accName = '';
            let fnOn = '';
            let lnOn = '';
            try {
                const o = await reg.getAccount(wallet);
                exists = !!o?.exists;
                accName = String(o?.accountName ?? '').trim();
                fnOn = sanitizeName(o?.firstName);
                lnOn = sanitizeName(o?.lastName);
            }
            catch {
                exists = false;
            }
            if (exists && accName !== '')
                return;
            const expectedName = await (0, exports.resolveUniqueBeamioNfcAccountName)(reg, wallet, params.tagIdHex);
            if (!expectedName || !BEAMIO_ACCOUNT_NAME_RE.test(expectedName)) {
                (0, logger_1.logger)(safe_1.default.yellow('[maybeEnqueueNfcBeamioTag] could not allocate unique beamio_nfc_* name'));
                return;
            }
            if (exists && accName === expectedName && fnOn === NFC_BEAMIO_PROFILE_FIRST_NAME && lnOn === NFC_BEAMIO_PROFILE_LAST_NAME) {
                return;
            }
            if (exists && accName === expectedName && !nfcProfileNamesNeedClear(fnOn, lnOn) && (fnOn !== '' || lnOn !== '')) {
                return;
            }
            const getExistsUserData = await getUserData(expectedName);
            const fullInput = {
                accountName: expectedName,
                image: '',
                darkTheme: false,
                isUSDCFaucet: false,
                isETHFaucet: false,
                initialLoading: true,
                firstName: NFC_BEAMIO_PROFILE_FIRST_NAME,
                lastName: NFC_BEAMIO_PROFILE_LAST_NAME,
                pgpKeyID: '',
                pgpKey: '',
                address: wallet,
                createdAt: getExistsUserData?.createdAt,
            };
            addUserPool.push({
                wallet,
                account: fullInput,
                recover: [],
                followBeamioOfficial: false,
            });
            addUserPoolProcess();
            (0, logger_1.logger)(safe_1.default.cyan(`[maybeEnqueueNfcBeamioTag] queued setAccountByAdmin wallet=${wallet.slice(0, 10)}… tag=${expectedName} (empty profile names)`));
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[maybeEnqueueNfcBeamioTag] error: ${e?.message ?? e}`));
        }
    })();
};
exports.maybeEnqueueNfcBeamioTag = maybeEnqueueNfcBeamioTag;
/** @deprecated 使用 maybeEnqueueNfcBeamioTag（beamio_nfc_{N}） */
const maybeEnqueueNfcVerraBeamioTag = (params) => {
    (0, exports.maybeEnqueueNfcBeamioTag)(params);
};
exports.maybeEnqueueNfcVerraBeamioTag = maybeEnqueueNfcVerraBeamioTag;
/**
 * 将历史误写入 AccountRegistry 的 NFC uid/tagId（hex）从 firstName/lastName 清空。
 * 在持卡 EOA 已有 beamioTag 时由 scheduleEnsureNfcBeamioTagForEoa 触发。
 */
const maybeClearLegacyNfcBeamioProfileNames = (wallet) => {
    void (async () => {
        try {
            const w = ethers_1.ethers.getAddress(String(wallet || '').trim());
            const reg = exports.beamio_ContractPool[0]?.constAccountRegistry;
            if (!reg)
                return;
            let onchain = null;
            try {
                onchain = await reg.getAccount(w);
            }
            catch {
                return;
            }
            if (!onchain?.exists)
                return;
            const accName = String(onchain.accountName ?? '').trim();
            if (!accName)
                return;
            const fnOn = sanitizeName(onchain.firstName);
            const lnOn = sanitizeName(onchain.lastName);
            if (!nfcProfileNamesNeedClear(fnOn, lnOn))
                return;
            if (fnOn === NFC_BEAMIO_PROFILE_FIRST_NAME && lnOn === NFC_BEAMIO_PROFILE_LAST_NAME)
                return;
            const getExistsUserData = await getUserData(accName);
            const fullInput = {
                accountName: accName,
                image: String(onchain.image ?? ''),
                darkTheme: !!onchain.darkTheme,
                isUSDCFaucet: !!onchain.isUSDCFaucet,
                isETHFaucet: !!onchain.isETHFaucet,
                initialLoading: !!onchain.initialLoading,
                firstName: NFC_BEAMIO_PROFILE_FIRST_NAME,
                lastName: NFC_BEAMIO_PROFILE_LAST_NAME,
                pgpKeyID: '',
                pgpKey: '',
                address: w,
                createdAt: getExistsUserData?.createdAt,
            };
            addUserPool.push({
                wallet: w,
                account: fullInput,
                recover: [],
                followBeamioOfficial: false,
            });
            addUserPoolProcess();
            (0, logger_1.logger)(safe_1.default.cyan(`[maybeClearLegacyNfcBeamioProfileNames] queued clear legacy hex names wallet=${w.slice(0, 10)}… tag=${accName}`));
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[maybeClearLegacyNfcBeamioProfileNames] error: ${e?.message ?? e}`));
        }
    })();
};
exports.maybeClearLegacyNfcBeamioProfileNames = maybeClearLegacyNfcBeamioProfileNames;
const addUserPoolProcess = async () => {
    const obj = addUserPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.beamio_ContractPool.shift();
    if (!SC) {
        addUserPool.unshift(obj);
        setTimeout(() => {
            addUserPoolProcess();
        }, 2000);
        return;
    }
    const account = {
        accountName: obj.account.accountName,
        image: obj.account.image ?? '',
        darkTheme: obj.account.darkTheme,
        isUSDCFaucet: obj.account.isUSDCFaucet,
        isETHFaucet: obj.account.isETHFaucet,
        initialLoading: obj.account.initialLoading,
        firstName: sanitizeName(obj.account.firstName),
        lastName: sanitizeName(obj.account.lastName),
        pgpKeyID: obj.account.pgpKeyID ?? '',
        pgpKey: obj.account.pgpKey ?? ''
    };
    // Profile 字段与链上一致时可跳过 setAccountByAdmin；但 Rotate Recovery / Security Backup
    // 只更新 recover 加密包，profile 不变 — 仍须写 setBase64NameByAdmin，不得整单 skip。
    const isProfileUnchanged = async () => {
        try {
            const onchain = await SC.constAccountRegistry.getAccount(obj.wallet);
            if (!onchain?.exists)
                return false;
            const s = (v) => (v == null ? '' : String(v).trim());
            const eq = (a, b) => s(a) === s(b);
            return (eq(onchain.accountName, obj.account.accountName) &&
                eq(onchain.image, obj.account.image ?? '') &&
                !!onchain.darkTheme === !!obj.account.darkTheme &&
                !!onchain.isUSDCFaucet === !!obj.account.isUSDCFaucet &&
                !!onchain.isETHFaucet === !!obj.account.isETHFaucet &&
                !!onchain.initialLoading === !!obj.account.initialLoading &&
                eq(onchain.firstName, account.firstName) &&
                eq(onchain.lastName, account.lastName));
        }
        catch {
            return false;
        }
    };
    const hasRecoverWrites = Array.isArray(obj.recover) && obj.recover.some((n) => !!(n?.encrypto && n?.hash && n.hash !== ethers_1.ethers.ZeroHash));
    const profileUnchanged = await isProfileUnchanged();
    if (profileUnchanged && !hasRecoverWrites) {
        (0, logger_1.logger)(safe_1.default.cyan(`[addUserPoolProcess] skip: no change from on-chain wallet=${obj.wallet} accountName=${obj.account?.accountName}`));
        exports.beamio_ContractPool.unshift(SC);
        setTimeout(addUserPoolProcess, 2000);
        return;
    }
    try {
        if (!profileUnchanged) {
            const tx = await SC.constAccountRegistry.setAccountByAdmin(obj.wallet, account);
            await tx.wait();
            (0, logger_1.logger)('addUserPoolProcess constAccountRegistry SUCCESS!', tx.hash);
        }
        else {
            (0, logger_1.logger)(safe_1.default.cyan(`[addUserPoolProcess] profile unchanged; writing recover blobs only wallet=${obj.wallet} accountName=${obj.account?.accountName}`));
        }
        if (obj.recover?.length) {
            for (const n of obj.recover) {
                if (!n?.encrypto || !n?.hash || n.hash === ethers_1.ethers.ZeroHash)
                    continue;
                try {
                    const tr = await SC.constAccountRegistry.setBase64NameByAdmin(n.hash, n.encrypto, account.accountName, obj.wallet);
                    await tr.wait();
                    (0, logger_1.logger)('addUserPoolProcess setBase64NameByAdmin', tr.hash);
                }
                catch (ex) {
                    const msg = ex?.shortMessage || ex?.message || '';
                    (0, logger_1.logger)(`addUserPoolProcess setBase64NameByAdmin failed (non-fatal): ${msg} | wallet=${obj.wallet} hash=${n.hash?.slice(0, 18)}...`);
                    // 不抛出：setAccountByAdmin 已成功（或本轮仅写 recover），recover 写入失败时仍完成后续
                }
            }
        }
        if (!profileUnchanged) {
            await updateUserDB(obj.account);
            // 注册 @tag 成功后，检测 EOA 是否在 conet 拥有 AA，如果没有则为 eoa 创建 AA
            // Institutional AA tagging must set skipEnsureAa — wallet is already an AA address.
            if (!obj.skipEnsureAa) {
                try {
                    const { ensureAAForEOAOnConet } = await import('./MemberCard.js');
                    (0, logger_1.logger)(`[addUserPoolProcess] ensuring AA for registered user: wallet=${obj.wallet}`);
                    const aaAddr = await ensureAAForEOAOnConet(obj.wallet);
                    (0, logger_1.logger)(`[addUserPoolProcess] AA ensured for registered user: wallet=${obj.wallet} -> AA=${aaAddr}`);
                }
                catch (aaEx) {
                    (0, logger_1.logger)(safe_1.default.red(`[addUserPoolProcess] non-fatal: ensure AA for registered user failed: ${aaEx?.message ?? aaEx}`));
                }
            }
            // 在 setAccountByAdmin 成功后执行 follow BeamioOfficial。
            // 先用 getAccount 探测 BeamioOfficial 是否已经在 registry 上注册；
            // 链上无账户时 ethers 会抛 BAD_DATA: could not decode result data（返回 0x），
            // 与 AccountNotFound 同义，视作"BeamioOfficial 还没注册"安静跳过即可，避免误报为 followByAdmin 失败。
            if (obj.wallet.toLowerCase() !== BeamioOfficial.toLowerCase() && obj.followBeamioOfficial) {
                let officialExists = false;
                try {
                    const onchain = await SC.constAccountRegistry.getAccount(BeamioOfficial);
                    officialExists = !!onchain?.exists;
                }
                catch (_probeEx) {
                    officialExists = false;
                }
                if (!officialExists) {
                    (0, logger_1.logger)(`addUserPoolProcess skip followBeamioOfficial: BeamioOfficial not yet onchain | wallet=${obj.wallet}`);
                }
                else {
                    try {
                        const followTx = await SC.constAccountRegistry.followByAdmin(obj.wallet, BeamioOfficial);
                        await followTx.wait();
                        (0, logger_1.logger)('addUserPoolProcess followByAdmin BeamioOfficial SUCCESS!', followTx.hash);
                        await updateUserFollowDB(obj.wallet, BeamioOfficial);
                    }
                    catch (followEx) {
                        const msg = followEx?.shortMessage || followEx?.message || '';
                        if (/AccountNotFound|routePgpKeyID not in|route key not recorded|could not decode result data|BAD_DATA/i.test(msg)) {
                            (0, logger_1.logger)(`addUserPoolProcess skip followBeamioOfficial: ${msg}`);
                        }
                        else {
                            (0, logger_1.logger)(`addUserPoolProcess followByAdmin Error: ${msg} | wallet=${obj.wallet}`);
                        }
                    }
                }
            }
        }
    }
    catch (ex) {
        const msg = ex?.data ? (() => {
            try {
                const iface = SC.constAccountRegistry.interface;
                const err = iface?.parseError?.(ex.data);
                return err ? `revert: ${err.name}()` : ex.message;
            }
            catch (_) {
                return ex.message;
            }
        })() : ex.message;
        const hint = msg?.includes?.('missing revert data') ? ' [检查: signer 是否在 AccountRegistry admin 列表]' : '';
        (0, logger_1.logger)(`addUserPoolProcess Error: ${msg}${hint} | wallet=${obj.wallet} accountName=${obj.account?.accountName}`);
    }
    exports.beamio_ContractPool.unshift(SC);
    setTimeout(() => {
        addUserPoolProcess();
    }, 2000);
};
const addFollowPoolProcess = async () => {
    const obj = addFollowPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.beamio_ContractPool.shift();
    if (!SC) {
        addFollowPool.unshift(obj);
        setTimeout(() => {
            addFollowPoolProcess();
        }, 2000);
        return;
    }
    try {
        const tx = obj.remove ? await SC.constAccountRegistry.unfollowByAdmin(obj.wallet, obj.followAddress) : await SC.constAccountRegistry.followByAdmin(obj.wallet, obj.followAddress);
        await tx.wait();
        (0, logger_1.logger)(`addFollowPoolProcess constAccountRegistry remove ${obj.remove} SUCCESS!`, tx.hash);
        obj.remove ? await updateUserFollowRemoveDB(obj.wallet, obj.followAddress) : await updateUserFollowDB(obj.wallet, obj.followAddress);
    }
    catch (ex) {
        const msg = ex?.data ? (() => {
            try {
                const iface = SC.constAccountRegistry.interface;
                const err = iface?.parseError?.(ex.data);
                return err ? `revert: ${err.name}()` : ex.message;
            }
            catch (_) {
                return ex.message;
            }
        })() : ex.message;
        (0, logger_1.logger)(`addFollowPoolProcess Error: ${msg} | wallet=${obj.wallet} followAddress=${obj.followAddress} remove=${obj.remove}`);
    }
    exports.beamio_ContractPool.unshift(SC);
    setTimeout(() => {
        addFollowPoolProcess();
    }, 2000);
};
const BeamioOfficial = '0xeabf0a98ac208647247eaa25fdd4eb0e67793d61';
/**
 * addUser 前：以 AccountRegistry 链上为准。handle 未绑定时清理本地该用户名的缓存；
 * 钱包在链上无账户时删除本地该地址的 accounts/follows（避免陈旧行阻碍重新登记）。
 */
const reconcileLocalDbBeforeAddUser = async (accountName, walletRaw) => {
    const reg = exports.beamio_ContractPool[0]?.constAccountRegistry;
    if (!reg)
        return;
    let wallet;
    try {
        wallet = ethers_1.ethers.getAddress(String(walletRaw || '').trim()).toLowerCase();
    }
    catch {
        return;
    }
    const nameNorm = String(accountName || '').trim();
    if (!nameNorm)
        return;
    try {
        // 新 registry 对未注册名字会返回 0x（BAD_DATA），等价于「名字未被占用」。
        let ownerByName;
        try {
            ownerByName = await reg.getOwnerByAccountName(nameNorm);
        }
        catch (probeEx) {
            if (!(0, exports.isOnchainEmptyResult)(probeEx))
                throw probeEx;
            ownerByName = ethers_1.ethers.ZeroAddress;
        }
        const nameFreeOnChain = !ownerByName || ownerByName === ethers_1.ethers.ZeroAddress;
        if (nameFreeOnChain) {
            await clearStaleUsernameFromDb(nameNorm);
        }
        // getAccount 在新 registry 对未注册地址同样返回 0x（BAD_DATA），等价于 exists=false。
        let walletHasAccount = null;
        try {
            const acc = await reg.getAccount(wallet);
            walletHasAccount = !!acc?.exists;
        }
        catch (probeEx) {
            walletHasAccount = (0, exports.isOnchainEmptyResult)(probeEx) ? false : null;
        }
        // 仅当链上明确 exists=false 时删本地；RPC 抖动等不采信为「无账户」，避免误删
        if (walletHasAccount === false) {
            (0, logger_1.logger)(safe_1.default.yellow(`[reconcileLocalDbBeforeAddUser] chain has no account for ${wallet.slice(0, 10)}… — drop stale DB rows if any`));
            await deleteAccountFromDB(wallet);
        }
    }
    catch (ex) {
        (0, logger_1.logger)(safe_1.default.yellow(`[reconcileLocalDbBeforeAddUser] skipped: ${ex?.shortMessage || ex?.message || ex}`));
    }
};
/** Normalize @BeamioTag: strip leading @, validate 3–26 alnum / _ / . */
const normalizeBeamioAccountName = (raw) => {
    const trimmed = String(raw || '')
        .trim()
        .replace(/^@+/, '');
    return BEAMIO_ACCOUNT_NAME_RE.test(trimmed) ? trimmed : '';
};
exports.normalizeBeamioAccountName = normalizeBeamioAccountName;
/** True when AccountRegistry has no owner for this tag (or empty-result). */
const isBeamioAccountNameAvailable = async (accountName) => {
    const name = (0, exports.normalizeBeamioAccountName)(accountName);
    if (!name)
        return false;
    const reg = exports.beamio_ContractPool[0]?.constAccountRegistry;
    if (!reg)
        return false;
    try {
        const owner = (await reg.getOwnerByAccountName(name));
        return !owner || owner === ethers_1.ethers.ZeroAddress;
    }
    catch (ex) {
        if ((0, exports.isOnchainEmptyResult)(ex))
            return true;
        throw ex;
    }
};
exports.isBeamioAccountNameAvailable = isBeamioAccountNameAvailable;
/**
 * Bind a BeamioTag to an arbitrary address (EOA or Smart Wallet / AA) via setAccountByAdmin.
 * Does **not** call ensureAA — safe for institutional AA naming after createAccountFor.
 */
const registerBeamioTagForAddress = async (params) => {
    const name = (0, exports.normalizeBeamioAccountName)(params.accountName);
    if (!name) {
        const err = new Error('Invalid BeamioTag: use 3–26 letters, numbers, _ or .');
        err.statusCode = 400;
        throw err;
    }
    if (!ethers_1.ethers.isAddress(params.wallet) || params.wallet === ethers_1.ethers.ZeroAddress) {
        const err = new Error('Invalid wallet address');
        err.statusCode = 400;
        throw err;
    }
    const wallet = ethers_1.ethers.getAddress(params.wallet);
    const waitForSc = async () => {
        for (let i = 0; i < 40; i++) {
            const SC = exports.beamio_ContractPool.shift();
            if (SC)
                return SC;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error('AccountRegistry admin pool busy');
    };
    const SC = await waitForSc();
    try {
        try {
            const owner = (await SC.constAccountRegistry.getOwnerByAccountName(name));
            if (owner && owner !== ethers_1.ethers.ZeroAddress && owner.toLowerCase() !== wallet.toLowerCase()) {
                const err = new Error(`BeamioTag @${name} is already taken`);
                err.statusCode = 400;
                throw err;
            }
        }
        catch (ex) {
            if (ex?.statusCode === 400)
                throw ex;
            if (!(0, exports.isOnchainEmptyResult)(ex))
                throw ex;
        }
        const getExistsUserData = await getUserData(name);
        const account = {
            accountName: name,
            image: params.image ?? '',
            darkTheme: false,
            isUSDCFaucet: false,
            isETHFaucet: false,
            initialLoading: true,
            firstName: sanitizeName(params.firstName ?? 'Institutional'),
            lastName: sanitizeName(params.lastName ?? 'Smart Wallet'),
            pgpKeyID: '',
            pgpKey: '',
            address: wallet,
            createdAt: getExistsUserData?.createdAt,
        };
        const tx = await SC.constAccountRegistry.setAccountByAdmin(wallet, {
            accountName: account.accountName,
            image: account.image,
            darkTheme: account.darkTheme,
            isUSDCFaucet: account.isUSDCFaucet,
            isETHFaucet: account.isETHFaucet,
            initialLoading: account.initialLoading,
            firstName: account.firstName,
            lastName: account.lastName,
            pgpKeyID: account.pgpKeyID,
            pgpKey: account.pgpKey,
        });
        await tx.wait();
        await updateUserDB(account);
        (0, logger_1.logger)(safe_1.default.green(`[registerBeamioTagForAddress] @${name} → ${wallet} tx=${tx.hash}`));
        return { txHash: tx.hash, accountName: name };
    }
    finally {
        exports.beamio_ContractPool.unshift(SC);
    }
};
exports.registerBeamioTagForAddress = registerBeamioTagForAddress;
const addUser = async (req, res) => {
    const { accountName, wallet, recover, image, isUSDCFaucet, darkTheme, isETHFaucet, firstName, lastName, pgpKeyID, pgpKey } = req.body;
    try {
        await reconcileLocalDbBeforeAddUser(accountName, wallet);
        const getExistsUserData = await getUserData(accountName);
        // 2. 填默认值，保证所有 field 都存在；firstName/lastName 用 sanitizeName 防止 JSON 污染
        const fullInput = {
            accountName: accountName,
            image: image ?? '',
            darkTheme,
            isUSDCFaucet,
            isETHFaucet,
            initialLoading: true,
            firstName: sanitizeName(firstName),
            lastName: sanitizeName(lastName),
            pgpKeyID: pgpKeyID ?? '',
            pgpKey: pgpKey ?? '',
            address: wallet,
            createdAt: getExistsUserData?.createdAt
        };
        addUserPool.push({
            wallet,
            account: fullInput,
            recover: recover,
            followBeamioOfficial: true
        });
        addUserPoolProcess();
        // addFollow 改为在 addUserPoolProcess 内 setAccountByAdmin 成功后执行，避免 AccountNotFound（账户尚未上链时 follow 会 revert）
        // 3. 组装 calldata：ethers v6 struct 传参可以直接用对象
        console.log("[setAccountByAdmin] sending tx for", accountName, fullInput);
        return res.json({
            ok: true
        });
    }
    catch (err) {
        console.error("[setAccountByAdmin] error:", err);
        // ethers v6 报错信息在 err.shortMessage / err.info 等
        return res.status(500).json({
            ok: false,
            error: err.shortMessage || err.message || "Unknown error"
        });
    }
};
exports.addUser = addUser;
const regiestChatRouteProcess = async () => {
    const obj = regiestChatRoutePool.shift();
    if (!obj)
        return;
    const SC = exports.beamio_ContractPool.shift();
    if (!SC) {
        regiestChatRoutePool.unshift(obj);
        setTimeout(regiestChatRouteProcess, 2000);
        return;
    }
    const respond = (status, body) => {
        if (!obj.res.headersSent) {
            obj.res.status(status).json(body);
        }
    };
    try {
        const tx = await SC.constPgpManager.addPublicPGPByAdmin(obj.wallet, obj.keyID, obj.publicKeyArmored, obj.encrypKeyArmored, obj.routeKeyID);
        // 立即返回，避免 Cluster/nginx 等待 tx.wait() 超时 502（与 addUser 入队语义一致）
        respond(200, { ok: true, txHash: tx.hash });
        void tx
            .wait()
            .then(() => {
            (0, logger_1.logger)('regiestChatRouteProcess addPublicPGPByAdmin SUCCESS!', tx.hash);
        })
            .catch((waitErr) => {
            const msg = waitErr instanceof Error ? waitErr.message : String(waitErr);
            (0, logger_1.logger)(safe_1.default.red(`regiestChatRouteProcess tx.wait failed tx=${tx.hash}: ${msg}`));
        });
    }
    catch (err) {
        const msg = err?.shortMessage || err?.message || 'Unknown error';
        (0, logger_1.logger)('regiestChatRouteProcess Error:', msg);
        respond(500, { ok: false, error: msg });
    }
    exports.beamio_ContractPool.unshift(SC);
    setTimeout(regiestChatRouteProcess, 2000);
};
/** 登记 chat route：由 cluster 预检后转发。push regiestChatRoutePool，daemon 排队调用 addPublicPGPByAdmin。*/
const regiestChatRoute = async (req, res) => {
    const { wallet, keyID, publicKeyArmored, encrypKeyArmored, routeKeyID } = req.body;
    if (!ethers_1.ethers.isAddress(wallet) || !keyID || !publicKeyArmored || !encrypKeyArmored || !routeKeyID) {
        return res.status(400).json({ ok: false, error: 'Missing or invalid: wallet, keyID, publicKeyArmored, encrypKeyArmored, routeKeyID' });
    }
    if (!exports.beamio_ContractPool[0]?.constPgpManager) {
        return res.status(500).json({ ok: false, error: 'Service unavailable' });
    }
    regiestChatRoutePool.push({
        wallet: wallet.toLowerCase(),
        keyID: String(keyID).trim(),
        publicKeyArmored: String(publicKeyArmored),
        encrypKeyArmored: String(encrypKeyArmored),
        routeKeyID: String(routeKeyID).trim(),
        res
    });
    (0, logger_1.logger)(safe_1.default.cyan(`[regiestChatRoute] pushed to pool, wallet=${wallet} routeKeyID=${routeKeyID}`));
    regiestChatRouteProcess().catch((err) => {
        (0, logger_1.logger)(safe_1.default.red('[regiestChatRouteProcess] unhandled error:'), err?.message ?? err);
    });
};
exports.regiestChatRoute = regiestChatRoute;
const DB_URL = "postgres://postgres:your_password@127.0.0.1:5432/postgres";
/** beamio_cards 表：存储 createCard 创建的卡，供最新发行卡列表等查询。total_points_minted_6、holder_count 初始为 0，可由 indexer 后续更新。 */
const BEAMIO_CARDS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_cards (
	id SERIAL PRIMARY KEY,
	card_address TEXT UNIQUE NOT NULL,
	card_owner TEXT NOT NULL,
	currency TEXT NOT NULL,
	price_in_currency_e6 TEXT NOT NULL,
	uri TEXT,
	metadata_json JSONB,
	tx_hash TEXT,
	total_points_minted_6 BIGINT DEFAULT 0,
	holder_count INT DEFAULT 0,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`;
const REFERRAL_REGISTRY_CLAIMS_TABLE = `CREATE TABLE IF NOT EXISTS referral_registry_claims (
	claim_tx_hash TEXT PRIMARY KEY,
	redeem_hash TEXT NOT NULL,
	claim_kind TEXT NOT NULL CHECK (claim_kind IN ('l0', 'l1')),
	claimer_eoa TEXT NOT NULL,
	parent_l0 TEXT,
	parent_admin TEXT,
	rebate_bps TEXT NOT NULL,
	ratio_bps TEXT NOT NULL,
	block_number BIGINT,
	claimed_at TIMESTAMPTZ DEFAULT NOW(),
	created_at TIMESTAMPTZ DEFAULT NOW()
)`;
const REFERRAL_REGISTRY_CLAIMS_PARENT_IDX = `CREATE INDEX IF NOT EXISTS idx_referral_registry_claims_parents ON referral_registry_claims (LOWER(parent_l0), LOWER(parent_admin))`;
async function ensureReferralRegistryClaimsSchema(db) {
    await db.query(REFERRAL_REGISTRY_CLAIMS_TABLE);
    await db.query(REFERRAL_REGISTRY_CLAIMS_PARENT_IDX);
}
async function upsertReferralRegistryClaim(params) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryClaimsSchema(db);
        await db.query(`INSERT INTO referral_registry_claims
				(claim_tx_hash, redeem_hash, claim_kind, claimer_eoa, parent_l0, parent_admin, rebate_bps, ratio_bps, block_number)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (claim_tx_hash) DO UPDATE SET
				redeem_hash = EXCLUDED.redeem_hash,
				claim_kind = EXCLUDED.claim_kind,
				claimer_eoa = EXCLUDED.claimer_eoa,
				parent_l0 = EXCLUDED.parent_l0,
				parent_admin = EXCLUDED.parent_admin,
				rebate_bps = EXCLUDED.rebate_bps,
				ratio_bps = EXCLUDED.ratio_bps,
				block_number = EXCLUDED.block_number`, [
            params.claimTxHash.toLowerCase(),
            params.redeemHash.toLowerCase(),
            params.kind,
            ethers_1.ethers.getAddress(params.claimer).toLowerCase(),
            params.parentL0 ? ethers_1.ethers.getAddress(params.parentL0).toLowerCase() : null,
            params.parentAdmin ? ethers_1.ethers.getAddress(params.parentAdmin).toLowerCase() : null,
            params.rebateBps,
            params.ratioBps,
            params.blockNumber ?? null,
        ]);
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function listReferralRegistryClaimsByParent(parent) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryClaimsSchema(db);
        const normalized = ethers_1.ethers.getAddress(parent).toLowerCase();
        const result = await db.query(`SELECT claim_tx_hash, redeem_hash, claim_kind, claimer_eoa, parent_l0, parent_admin,
				rebate_bps, ratio_bps, block_number, claimed_at
			 FROM referral_registry_claims
			 WHERE LOWER(parent_l0) = $1 OR LOWER(parent_admin) = $1
			 ORDER BY claimed_at DESC`, [normalized]);
        return result.rows.map((row) => ({
            claimTxHash: row.claim_tx_hash,
            redeemHash: row.redeem_hash,
            kind: row.claim_kind,
            claimer: ethers_1.ethers.getAddress(row.claimer_eoa),
            parentL0: row.parent_l0 ? ethers_1.ethers.getAddress(row.parent_l0) : null,
            parentAdmin: row.parent_admin ? ethers_1.ethers.getAddress(row.parent_admin) : null,
            rebateBps: String(row.rebate_bps),
            ratioBps: String(row.ratio_bps),
            blockNumber: row.block_number === null ? null : String(row.block_number),
            claimedAt: new Date(row.claimed_at).toISOString(),
        }));
    }
    finally {
        await db.end().catch(() => { });
    }
}
/** Genesis Node Seat purchase ledger — written by Master on fulfill; Cluster serves income details. */
const GENESIS_NODE_REFERRAL_PURCHASES_TABLE = `CREATE TABLE IF NOT EXISTS genesis_node_referral_purchases (
	usdc_tx_hash TEXT PRIMARY KEY,
	operation_id TEXT NOT NULL,
	bind_tx_hash TEXT,
	lock_mint_tx_hash TEXT,
	bridge_settle_tx_hash TEXT,
	buyer TEXT NOT NULL,
	payer TEXT,
	qty TEXT NOT NULL,
	test_mode BOOLEAN NOT NULL DEFAULT FALSE,
	referrer TEXT,
	referrer_l0 TEXT,
	referrer_l1 TEXT,
	admin_payout TEXT,
	foundation_payout TEXT,
	l0_amount_usdc6 TEXT NOT NULL DEFAULT '0',
	l1_amount_usdc6 TEXT NOT NULL DEFAULT '0',
	admin_amount_usdc6 TEXT NOT NULL DEFAULT '0',
	foundation_amount_usdc6 TEXT NOT NULL DEFAULT '0',
	purchased_at TIMESTAMPTZ DEFAULT NOW(),
	created_at TIMESTAMPTZ DEFAULT NOW()
)`;
const GENESIS_NODE_REFERRAL_PURCHASES_BRIDGE_SETTLE_COL = `ALTER TABLE genesis_node_referral_purchases
	ADD COLUMN IF NOT EXISTS bridge_settle_tx_hash TEXT`;
const GENESIS_NODE_REFERRAL_PURCHASES_BENEFICIARY_IDX = `CREATE INDEX IF NOT EXISTS idx_genesis_node_referral_purchases_beneficiaries
	ON genesis_node_referral_purchases (
		LOWER(referrer_l0), LOWER(referrer_l1), LOWER(admin_payout), LOWER(foundation_payout)
	)`;
async function ensureGenesisNodeReferralPurchasesSchema(db) {
    await db.query(GENESIS_NODE_REFERRAL_PURCHASES_TABLE);
    await db.query(GENESIS_NODE_REFERRAL_PURCHASES_BRIDGE_SETTLE_COL);
    await db.query(GENESIS_NODE_REFERRAL_PURCHASES_BENEFICIARY_IDX);
}
function mapGenesisPurchaseRow(row) {
    return {
        usdcTxHash: String(row.usdc_tx_hash),
        operationId: String(row.operation_id),
        bindTxHash: row.bind_tx_hash ? String(row.bind_tx_hash) : null,
        lockMintTxHash: row.lock_mint_tx_hash ? String(row.lock_mint_tx_hash) : null,
        bridgeSettleTxHash: row.bridge_settle_tx_hash ? String(row.bridge_settle_tx_hash) : null,
        buyer: ethers_1.ethers.getAddress(String(row.buyer)),
        payer: row.payer && ethers_1.ethers.isAddress(row.payer) ? ethers_1.ethers.getAddress(String(row.payer)) : null,
        qty: String(row.qty ?? '0'),
        testMode: Boolean(row.test_mode),
        referrer: row.referrer && ethers_1.ethers.isAddress(row.referrer) ? ethers_1.ethers.getAddress(String(row.referrer)) : null,
        referrerL0: row.referrer_l0 && ethers_1.ethers.isAddress(row.referrer_l0) ? ethers_1.ethers.getAddress(String(row.referrer_l0)) : null,
        referrerL1: row.referrer_l1 && ethers_1.ethers.isAddress(row.referrer_l1) ? ethers_1.ethers.getAddress(String(row.referrer_l1)) : null,
        adminPayout: row.admin_payout && ethers_1.ethers.isAddress(row.admin_payout) ? ethers_1.ethers.getAddress(String(row.admin_payout)) : null,
        foundationPayout: row.foundation_payout && ethers_1.ethers.isAddress(row.foundation_payout)
            ? ethers_1.ethers.getAddress(String(row.foundation_payout))
            : null,
        l0AmountUsdc6: String(row.l0_amount_usdc6 ?? '0'),
        l1AmountUsdc6: String(row.l1_amount_usdc6 ?? '0'),
        adminAmountUsdc6: String(row.admin_amount_usdc6 ?? '0'),
        foundationAmountUsdc6: String(row.foundation_amount_usdc6 ?? '0'),
        purchasedAt: new Date(row.purchased_at).toISOString(),
    };
}
async function upsertGenesisNodeReferralPurchase(params) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureGenesisNodeReferralPurchasesSchema(db);
        const usdcTx = params.usdcTxHash.trim().toLowerCase();
        const bridgeSettle = params.bridgeSettleTxHash && /^0x[0-9a-fA-F]{64}$/.test(params.bridgeSettleTxHash.trim())
            ? params.bridgeSettleTxHash.trim().toLowerCase()
            : null;
        await db.query(`INSERT INTO genesis_node_referral_purchases
				(usdc_tx_hash, operation_id, bind_tx_hash, lock_mint_tx_hash, bridge_settle_tx_hash, buyer, payer, qty, test_mode,
				 referrer, referrer_l0, referrer_l1, admin_payout, foundation_payout,
				 l0_amount_usdc6, l1_amount_usdc6, admin_amount_usdc6, foundation_amount_usdc6, purchased_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19::timestamptz, NOW()))
			 ON CONFLICT (usdc_tx_hash) DO UPDATE SET
				operation_id = EXCLUDED.operation_id,
				bind_tx_hash = COALESCE(EXCLUDED.bind_tx_hash, genesis_node_referral_purchases.bind_tx_hash),
				lock_mint_tx_hash = COALESCE(EXCLUDED.lock_mint_tx_hash, genesis_node_referral_purchases.lock_mint_tx_hash),
				bridge_settle_tx_hash = COALESCE(EXCLUDED.bridge_settle_tx_hash, genesis_node_referral_purchases.bridge_settle_tx_hash),
				buyer = EXCLUDED.buyer,
				payer = EXCLUDED.payer,
				qty = EXCLUDED.qty,
				test_mode = EXCLUDED.test_mode,
				referrer = EXCLUDED.referrer,
				referrer_l0 = EXCLUDED.referrer_l0,
				referrer_l1 = EXCLUDED.referrer_l1,
				admin_payout = EXCLUDED.admin_payout,
				foundation_payout = EXCLUDED.foundation_payout,
				l0_amount_usdc6 = EXCLUDED.l0_amount_usdc6,
				l1_amount_usdc6 = EXCLUDED.l1_amount_usdc6,
				admin_amount_usdc6 = EXCLUDED.admin_amount_usdc6,
				foundation_amount_usdc6 = EXCLUDED.foundation_amount_usdc6,
				purchased_at = COALESCE(EXCLUDED.purchased_at, genesis_node_referral_purchases.purchased_at)`, [
            usdcTx,
            params.operationId,
            params.bindTxHash ?? null,
            params.lockMintTxHash ?? null,
            bridgeSettle,
            ethers_1.ethers.getAddress(params.buyer).toLowerCase(),
            params.payer && ethers_1.ethers.isAddress(params.payer) ? ethers_1.ethers.getAddress(params.payer).toLowerCase() : null,
            params.qty,
            params.testMode,
            params.referrer && ethers_1.ethers.isAddress(params.referrer)
                ? ethers_1.ethers.getAddress(params.referrer).toLowerCase()
                : null,
            params.referrerL0 && ethers_1.ethers.isAddress(params.referrerL0)
                ? ethers_1.ethers.getAddress(params.referrerL0).toLowerCase()
                : null,
            params.referrerL1 && ethers_1.ethers.isAddress(params.referrerL1)
                ? ethers_1.ethers.getAddress(params.referrerL1).toLowerCase()
                : null,
            params.adminPayout && ethers_1.ethers.isAddress(params.adminPayout)
                ? ethers_1.ethers.getAddress(params.adminPayout).toLowerCase()
                : null,
            params.foundationPayout && ethers_1.ethers.isAddress(params.foundationPayout)
                ? ethers_1.ethers.getAddress(params.foundationPayout).toLowerCase()
                : null,
            params.l0AmountUsdc6,
            params.l1AmountUsdc6,
            params.adminAmountUsdc6,
            params.foundationAmountUsdc6,
            params.purchasedAt ?? null,
        ]);
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function updateGenesisNodeReferralBridgeSettleTx(params) {
    const usdcTx = params.usdcTxHash.trim().toLowerCase();
    const settle = params.bridgeSettleTxHash.trim().toLowerCase();
    if (!usdcTx || !/^0x[0-9a-fA-F]{64}$/.test(settle))
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureGenesisNodeReferralPurchasesSchema(db);
        await db.query(`UPDATE genesis_node_referral_purchases
			 SET bridge_settle_tx_hash = $2
			 WHERE usdc_tx_hash = $1
			   AND (bridge_settle_tx_hash IS NULL OR bridge_settle_tx_hash = '')`, [usdcTx, settle]);
    }
    finally {
        await db.end().catch(() => { });
    }
}
/** Purchases that still need CoNET voteBridgeOperation hash resolution. */
async function listGenesisNodeReferralPurchasesMissingBridgeSettle(limit = 40) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureGenesisNodeReferralPurchasesSchema(db);
        const result = await db.query(`SELECT usdc_tx_hash, operation_id
			 FROM genesis_node_referral_purchases
			 WHERE operation_id IS NOT NULL
			   AND operation_id <> ''
			   AND (bridge_settle_tx_hash IS NULL OR bridge_settle_tx_hash = '')
			 ORDER BY purchased_at DESC NULLS LAST
			 LIMIT $1`, [Math.max(1, Math.min(limit, 100))]);
        return result.rows.map((row) => ({
            usdcTxHash: String(row.usdc_tx_hash),
            operationId: String(row.operation_id),
        }));
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function getGenesisNodeReferralPurchaseByUsdcTx(usdcTxHash) {
    const key = usdcTxHash.trim().toLowerCase();
    if (!key)
        return null;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureGenesisNodeReferralPurchasesSchema(db);
        const result = await db.query(`SELECT * FROM genesis_node_referral_purchases WHERE usdc_tx_hash = $1 LIMIT 1`, [key]);
        if (!result.rows[0])
            return null;
        return mapGenesisPurchaseRow(result.rows[0]);
    }
    finally {
        await db.end().catch(() => { });
    }
}
/** Flatten purchase rows into per-beneficiary income lines for one account. */
function expandGenesisNodeReferralIncomeItems(account, rows) {
    const eoaLower = ethers_1.ethers.getAddress(account).toLowerCase();
    const items = [];
    const push = (row, role, payee, amountUsdc6) => {
        if (!payee || !ethers_1.ethers.isAddress(payee))
            return;
        if (ethers_1.ethers.getAddress(payee).toLowerCase() !== eoaLower)
            return;
        let amount = 0n;
        try {
            amount = BigInt(amountUsdc6 || '0');
        }
        catch {
            return;
        }
        if (amount <= 0n)
            return;
        items.push({
            transactionHash: row.usdcTxHash.startsWith('0x') ? row.usdcTxHash : `0x${row.usdcTxHash}`,
            operationId: row.operationId,
            bindTxHash: row.bindTxHash,
            lockMintTxHash: row.lockMintTxHash,
            bridgeSettleTxHash: row.bridgeSettleTxHash,
            amountUsdc6: amount.toString(),
            role,
            qty: row.qty,
            testMode: row.testMode,
            buyer: row.buyer,
            timestampMs: Date.parse(row.purchasedAt) || 0,
        });
    };
    for (const row of rows) {
        push(row, 'l0', row.referrerL0, row.l0AmountUsdc6);
        push(row, 'l1', row.referrerL1, row.l1AmountUsdc6);
        push(row, 'admin', row.adminPayout, row.adminAmountUsdc6);
        push(row, 'foundation', row.foundationPayout, row.foundationAmountUsdc6);
    }
    return items.sort((a, b) => b.timestampMs - a.timestampMs);
}
async function listGenesisNodeReferralPurchasesForAccount(account, options = {}) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureGenesisNodeReferralPurchasesSchema(db);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_genesis_node_referral_purchases_purchased_at
			 ON genesis_node_referral_purchases (purchased_at DESC)`);
        const normalized = ethers_1.ethers.getAddress(account).toLowerCase();
        const limitRaw = Number(options.limit);
        const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50));
        const sinceMs = typeof options.sinceMs === 'number' && Number.isFinite(options.sinceMs) && options.sinceMs > 0
            ? Math.floor(options.sinceMs)
            : null;
        const beforeMs = typeof options.beforeMs === 'number' && Number.isFinite(options.beforeMs) && options.beforeMs > 0
            ? Math.floor(options.beforeMs)
            : null;
        const params = [normalized];
        let timeClause = '';
        let orderClause = 'ORDER BY purchased_at DESC';
        if (sinceMs != null) {
            params.push(sinceMs);
            timeClause = ` AND purchased_at > to_timestamp($${params.length}::double precision / 1000.0)`;
            orderClause = 'ORDER BY purchased_at ASC';
        }
        else if (beforeMs != null) {
            params.push(beforeMs);
            timeClause = ` AND purchased_at < to_timestamp($${params.length}::double precision / 1000.0)`;
            orderClause = 'ORDER BY purchased_at DESC';
        }
        params.push(limit + 1);
        const limitParam = `$${params.length}`;
        const result = await db.query(`SELECT * FROM genesis_node_referral_purchases
			 WHERE (
			        LOWER(referrer_l0) = $1
			     OR LOWER(referrer_l1) = $1
			     OR LOWER(admin_payout) = $1
			     OR LOWER(foundation_payout) = $1
			 )
			 ${timeClause}
			 ${orderClause}
			 LIMIT ${limitParam}`, params);
        const mapped = result.rows.map(mapGenesisPurchaseRow);
        const hasMore = mapped.length > limit;
        const rows = hasMore ? mapped.slice(0, limit) : mapped;
        return { rows, hasMore };
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function listGenesisNodeReferralIncomeForAccount(account, options = {}) {
    const { rows, hasMore } = await listGenesisNodeReferralPurchasesForAccount(account, options);
    const items = expandGenesisNodeReferralIncomeItems(account, rows);
    let newestTimestampMs = 0;
    let oldestTimestampMs = 0;
    for (const item of items) {
        if (!item.timestampMs)
            continue;
        if (item.timestampMs > newestTimestampMs)
            newestTimestampMs = item.timestampMs;
        if (!oldestTimestampMs || item.timestampMs < oldestTimestampMs)
            oldestTimestampMs = item.timestampMs;
    }
    return { items, hasMore, newestTimestampMs, oldestTimestampMs };
}
const REFERRAL_REGISTRY_MEMBERS_TABLE = `CREATE TABLE IF NOT EXISTS referral_registry_members (
	account_eoa TEXT PRIMARY KEY,
	is_admin BOOLEAN NOT NULL DEFAULT FALSE,
	member_role TEXT NOT NULL CHECK (member_role IN ('none', 'l0', 'l1', 'merchant')),
	parent_admin TEXT,
	parent_l0 TEXT,
	rebate_bps TEXT NOT NULL DEFAULT '0',
	ratio_bps TEXT NOT NULL DEFAULT '0',
	active BOOLEAN NOT NULL DEFAULT FALSE,
	first_seen_block BIGINT,
	last_seen_block BIGINT,
	last_tx_hash TEXT,
	updated_at TIMESTAMPTZ DEFAULT NOW()
)`;
const REFERRAL_REGISTRY_MEMBERS_PARENT_IDX = `CREATE INDEX IF NOT EXISTS idx_referral_registry_members_parent
	ON referral_registry_members (LOWER(parent_admin), LOWER(parent_l0), member_role)`;
const REFERRAL_REGISTRY_TREE_SYNC_TABLE = `CREATE TABLE IF NOT EXISTS referral_registry_tree_sync (
	singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
	deployment_block BIGINT NOT NULL,
	synced_through_block BIGINT,
	rebuilding BOOLEAN NOT NULL DEFAULT FALSE,
	updated_at TIMESTAMPTZ DEFAULT NOW()
)`;
async function ensureReferralRegistryTreeSchema(db) {
    await db.query(REFERRAL_REGISTRY_MEMBERS_TABLE);
    await db.query(REFERRAL_REGISTRY_MEMBERS_PARENT_IDX);
    await db.query(REFERRAL_REGISTRY_TREE_SYNC_TABLE);
    await db.query(`INSERT INTO referral_registry_tree_sync (singleton, deployment_block)
		 VALUES (TRUE, $1)
		 ON CONFLICT (singleton) DO NOTHING`, ['431457']);
}
function mapReferralRegistryTreeMemberRow(row) {
    return {
        account: ethers_1.ethers.getAddress(row.account_eoa),
        isAdmin: Boolean(row.is_admin),
        role: row.member_role,
        parentAdmin: row.parent_admin ? ethers_1.ethers.getAddress(row.parent_admin) : null,
        parentL0: row.parent_l0 ? ethers_1.ethers.getAddress(row.parent_l0) : null,
        rebateBps: String(row.rebate_bps),
        ratioBps: String(row.ratio_bps),
        active: Boolean(row.active),
        firstSeenBlock: row.first_seen_block === null ? null : String(row.first_seen_block),
        lastSeenBlock: row.last_seen_block === null ? null : String(row.last_seen_block),
        lastTxHash: row.last_tx_hash,
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
async function getReferralRegistryTreeSync() {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryTreeSchema(db);
        const result = await db.query(`SELECT deployment_block, synced_through_block, rebuilding
			 FROM referral_registry_tree_sync
			 WHERE singleton = TRUE`);
        const row = result.rows[0];
        return {
            deploymentBlock: String(row.deployment_block),
            syncedThroughBlock: row.synced_through_block === null ? null : String(row.synced_through_block),
            rebuilding: Boolean(row.rebuilding),
        };
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function setReferralRegistryTreeRebuilding(rebuilding) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryTreeSchema(db);
        await db.query(`UPDATE referral_registry_tree_sync
			 SET rebuilding = $1, updated_at = NOW()
			 WHERE singleton = TRUE`, [rebuilding]);
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function tryStartReferralRegistryTreeRebuild() {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryTreeSchema(db);
        const result = await db.query(`UPDATE referral_registry_tree_sync
			 SET rebuilding = TRUE, updated_at = NOW()
			 WHERE singleton = TRUE
			   AND synced_through_block IS NULL
			   AND (rebuilding = FALSE OR updated_at < NOW() - INTERVAL '5 minutes')
			 RETURNING singleton`);
        return result.rowCount === 1;
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function replaceReferralRegistryTreeMembers(rows, syncedThroughBlock) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryTreeSchema(db);
        await db.query('BEGIN');
        try {
            await db.query('TRUNCATE referral_registry_members');
            for (const row of rows) {
                await db.query(`INSERT INTO referral_registry_members
						(account_eoa, is_admin, member_role, parent_admin, parent_l0, rebate_bps, ratio_bps,
						 active, first_seen_block, last_seen_block, last_tx_hash)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
                    ethers_1.ethers.getAddress(row.account).toLowerCase(),
                    row.isAdmin,
                    row.role,
                    row.parentAdmin ? ethers_1.ethers.getAddress(row.parentAdmin).toLowerCase() : null,
                    row.parentL0 ? ethers_1.ethers.getAddress(row.parentL0).toLowerCase() : null,
                    row.rebateBps ?? '0',
                    row.ratioBps ?? '0',
                    row.active ?? false,
                    row.firstSeenBlock ?? null,
                    row.lastSeenBlock ?? null,
                    row.lastTxHash ?? null,
                ]);
            }
            await db.query(`UPDATE referral_registry_tree_sync
				 SET synced_through_block = $1, rebuilding = FALSE, updated_at = NOW()
				 WHERE singleton = TRUE`, [syncedThroughBlock]);
            await db.query('COMMIT');
        }
        catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function upsertReferralRegistryTreeMember(params) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryTreeSchema(db);
        const account = ethers_1.ethers.getAddress(params.account).toLowerCase();
        const parentAdmin = params.parentAdmin ? ethers_1.ethers.getAddress(params.parentAdmin).toLowerCase() : null;
        const parentL0 = params.parentL0 ? ethers_1.ethers.getAddress(params.parentL0).toLowerCase() : null;
        await db.query(`INSERT INTO referral_registry_members
				(account_eoa, is_admin, member_role, parent_admin, parent_l0, rebate_bps, ratio_bps, active,
				 first_seen_block, last_seen_block, last_tx_hash)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
			 ON CONFLICT (account_eoa) DO UPDATE SET
				is_admin = EXCLUDED.is_admin,
				member_role = EXCLUDED.member_role,
				parent_admin = EXCLUDED.parent_admin,
				parent_l0 = EXCLUDED.parent_l0,
				rebate_bps = EXCLUDED.rebate_bps,
				ratio_bps = EXCLUDED.ratio_bps,
				active = EXCLUDED.active,
				last_seen_block = EXCLUDED.last_seen_block,
				last_tx_hash = EXCLUDED.last_tx_hash,
				updated_at = NOW()`, [
            account,
            params.isAdmin ?? false,
            params.role,
            parentAdmin,
            parentL0,
            params.rebateBps ?? '0',
            params.ratioBps ?? '0',
            params.active ?? true,
            params.blockNumber ?? null,
            params.txHash ?? null,
        ]);
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function listReferralRegistryTreeByAccount(account) {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureReferralRegistryTreeSchema(db);
        const normalized = ethers_1.ethers.getAddress(account).toLowerCase();
        const result = await db.query(`SELECT account_eoa, is_admin, member_role, parent_admin, parent_l0, rebate_bps, ratio_bps,
				active, first_seen_block, last_seen_block, last_tx_hash, updated_at
			 FROM referral_registry_members
			 WHERE LOWER(account_eoa) = $1
			    OR LOWER(parent_admin) = $1
			    OR LOWER(parent_l0) = $1
			 ORDER BY member_role, account_eoa`, [normalized]);
        return result.rows.map(mapReferralRegistryTreeMemberRow);
    }
    finally {
        await db.end().catch(() => { });
    }
}
/**
 * POS 终端 EOA → 可登记多张 BeamioUserCard（一 EOA 多商家）。
 * PK = (pos_eoa, card_address)；`is_active` 标记当前 POS 使用的活跃卡（GET myPosAddress）。
 */
const BEAMIO_POS_TERMINAL_ADMIN_CARD_TABLE = `CREATE TABLE IF NOT EXISTS beamio_pos_terminal_admin_card (
	pos_eoa TEXT NOT NULL,
	card_address TEXT NOT NULL,
	tx_hash TEXT,
	is_active BOOLEAN NOT NULL DEFAULT false,
	updated_at TIMESTAMPTZ DEFAULT NOW(),
	PRIMARY KEY (pos_eoa, card_address)
)`;
const BEAMIO_POS_TERMINAL_ADMIN_CARD_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_beamio_pos_terminal_admin_card_card ON beamio_pos_terminal_admin_card (LOWER(TRIM(card_address)))`;
const BEAMIO_POS_TERMINAL_ADMIN_CARD_IDX_ACTIVE = `CREATE INDEX IF NOT EXISTS idx_beamio_pos_terminal_admin_card_active ON beamio_pos_terminal_admin_card (pos_eoa) WHERE is_active = true`;
async function ensureBeamioPosTerminalAdminCardSchema(db) {
    await db.query(BEAMIO_POS_TERMINAL_ADMIN_CARD_TABLE);
    await db.query(BEAMIO_POS_TERMINAL_ADMIN_CARD_IDX_CARD);
    await db.query(BEAMIO_POS_TERMINAL_ADMIN_CARD_IDX_ACTIVE).catch(() => { });
    await db.query(`ALTER TABLE beamio_pos_terminal_admin_card ADD COLUMN IF NOT EXISTS metadata_json JSONB`).catch(() => { });
    await db.query(`ALTER TABLE beamio_pos_terminal_admin_card ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false`).catch(() => { });
    // Legacy: pos_eoa-only PRIMARY KEY → composite (pos_eoa, card_address) for multi-merchant.
    const { rows: pkCols } = await db.query(`SELECT a.attname AS column_name
		 FROM pg_index i
		 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
		 JOIN pg_class c ON c.oid = i.indrelid
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE i.indisprimary
		   AND n.nspname = 'public'
		   AND c.relname = 'beamio_pos_terminal_admin_card'
		 ORDER BY a.attnum`).catch(() => ({ rows: [] }));
    const pkNames = pkCols.map((r) => r.column_name);
    const isLegacyPk = pkNames.length === 1 && pkNames[0] === 'pos_eoa';
    if (isLegacyPk) {
        await db.query(`
			ALTER TABLE beamio_pos_terminal_admin_card DROP CONSTRAINT IF EXISTS beamio_pos_terminal_admin_card_pkey;
			ALTER TABLE beamio_pos_terminal_admin_card
				ADD CONSTRAINT beamio_pos_terminal_admin_card_pkey PRIMARY KEY (pos_eoa, card_address);
		`);
        (0, logger_1.logger)(safe_1.default.magenta('[ensureBeamioPosTerminalAdminCardSchema] migrated PK → (pos_eoa, card_address)'));
    }
    // Ensure each POS has exactly one active row when any bindings exist.
    await db.query(`
		UPDATE beamio_pos_terminal_admin_card t
		SET is_active = true
		FROM (
			SELECT DISTINCT ON (pos_eoa) pos_eoa, card_address
			FROM beamio_pos_terminal_admin_card
			ORDER BY pos_eoa, is_active DESC, updated_at DESC NULLS LAST
		) pick
		WHERE t.pos_eoa = pick.pos_eoa
		  AND t.card_address = pick.card_address
		  AND NOT EXISTS (
			SELECT 1 FROM beamio_pos_terminal_admin_card x
			WHERE x.pos_eoa = t.pos_eoa AND x.is_active = true
		  )
	`).catch(() => { });
}
/**
 * cardAddAdmin 预检：同一卡重复登记允许。
 * 一终端可绑定多商家卡（不再因「已绑其它卡」拒绝）。
 */
const assertPosEoaAvailableForCardBinding = async (_posLoose, _cardAddressLoose) => {
    try {
        if (!_posLoose || !ethers_1.ethers.isAddress(_posLoose)) {
            return { ok: false, error: 'Invalid terminal address.' };
        }
        if (!_cardAddressLoose || !ethers_1.ethers.isAddress(_cardAddressLoose)) {
            return { ok: false, error: 'Invalid merchant card address.' };
        }
        return { ok: true };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[assertPosEoaAvailableForCardBinding] failed: ${e?.message ?? e}`));
        return { ok: false, error: 'Could not verify terminal registration. Try again later.' };
    }
};
exports.assertPosEoaAvailableForCardBinding = assertPosEoaAvailableForCardBinding;
/**
 * adminManager(add) 上链成功后写入。
 * - 该 POS 尚无任何绑定 → 强制 `is_active=true`（首次绑定）。
 * - 追加绑定：默认 `makeActive=false`（Approve 不自动切 current）；显式 `makeActive=true` 才切换活跃卡。
 */
const upsertPosTerminalAdminCardBinding = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioPosTerminalAdminCardSchema(db);
        const pos = ethers_1.ethers.getAddress(params.posEoa).toLowerCase();
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const meta = params.metadataJson === undefined ? null : params.metadataJson;
        await db.query('BEGIN');
        const { rows: existing } = await db.query(`SELECT COUNT(*)::text AS n FROM beamio_pos_terminal_admin_card WHERE pos_eoa = $1`, [pos]);
        const count = Number(existing[0]?.n ?? '0');
        const makeActive = count === 0 ? true : params.makeActive === true;
        if (makeActive) {
            await db.query(`UPDATE beamio_pos_terminal_admin_card SET is_active = false WHERE pos_eoa = $1 AND is_active = true`, [pos]);
        }
        await db.query(`
			INSERT INTO beamio_pos_terminal_admin_card (pos_eoa, card_address, tx_hash, metadata_json, is_active, updated_at)
			VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
			ON CONFLICT (pos_eoa, card_address) DO UPDATE SET
				tx_hash = COALESCE(EXCLUDED.tx_hash, beamio_pos_terminal_admin_card.tx_hash),
				metadata_json = COALESCE(EXCLUDED.metadata_json, beamio_pos_terminal_admin_card.metadata_json),
				is_active = CASE WHEN $5 THEN true ELSE beamio_pos_terminal_admin_card.is_active END,
				updated_at = NOW()
			`, [pos, card, params.txHash ?? null, meta, makeActive]);
        await db.query('COMMIT');
        (0, logger_1.logger)(safe_1.default.green(`[upsertPosTerminalAdminCardBinding] pos=${pos} card=${card} active=${makeActive}`));
    }
    catch (e) {
        await db.query('ROLLBACK').catch(() => { });
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertPosTerminalAdminCardBinding] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertPosTerminalAdminCardBinding = upsertPosTerminalAdminCardBinding;
const deletePosTerminalAdminCardBinding = async (posLoose, cardAddressLoose) => {
    await (0, exports.deletePosTerminalCardBinding)(posLoose, cardAddressLoose);
};
exports.deletePosTerminalAdminCardBinding = deletePosTerminalAdminCardBinding;
/** POS 问询已登记商户卡地址（Registration Device 成功且链上 confirm 后即有记录）。 */
const getPosTerminalCardAddressForWallet = async (walletLoose) => {
    const row = await (0, exports.getPosTerminalCardBindingRow)(walletLoose);
    return row?.cardAddress ?? null;
};
exports.getPosTerminalCardAddressForWallet = getPosTerminalCardAddressForWallet;
/** 含 DB 内保存的终端 metadata；优先返回 `is_active` 行。 */
const getPosTerminalCardBindingRow = async (walletLoose) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioPosTerminalAdminCardSchema(db);
        const w = ethers_1.ethers.getAddress(walletLoose).toLowerCase();
        const { rows } = await db.query(`SELECT card_address, tx_hash, metadata_json, is_active
			 FROM beamio_pos_terminal_admin_card
			 WHERE pos_eoa = $1
			 ORDER BY is_active DESC, updated_at DESC NULLS LAST
			 LIMIT 1`, [w]);
        if (rows.length === 0)
            return null;
        const raw = rows[0].card_address;
        if (!raw || !ethers_1.ethers.isAddress(raw))
            return null;
        return {
            cardAddress: ethers_1.ethers.getAddress(raw),
            txHash: rows[0].tx_hash ?? null,
            terminalMetadata: rows[0].metadata_json ?? null,
            isActive: Boolean(rows[0].is_active),
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getPosTerminalCardBindingRow] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getPosTerminalCardBindingRow = getPosTerminalCardBindingRow;
/** List all merchant-card bindings for a POS EOA (multi-merchant). */
const listPosTerminalCardBindingsForWallet = async (walletLoose) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioPosTerminalAdminCardSchema(db);
        const w = ethers_1.ethers.getAddress(walletLoose).toLowerCase();
        const { rows } = await db.query(`SELECT card_address, tx_hash, metadata_json, is_active
			 FROM beamio_pos_terminal_admin_card
			 WHERE pos_eoa = $1
			 ORDER BY is_active DESC, updated_at DESC NULLS LAST`, [w]);
        const out = [];
        for (const row of rows) {
            if (!row.card_address || !ethers_1.ethers.isAddress(row.card_address))
                continue;
            out.push({
                cardAddress: ethers_1.ethers.getAddress(row.card_address),
                txHash: row.tx_hash ?? null,
                terminalMetadata: row.metadata_json ?? null,
                isActive: Boolean(row.is_active),
            });
        }
        return out;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listPosTerminalCardBindingsForWallet] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listPosTerminalCardBindingsForWallet = listPosTerminalCardBindingsForWallet;
/** Mark one bound card as the sole active binding for this POS. */
const setActivePosTerminalCardBinding = async (walletLoose, cardAddressLoose) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioPosTerminalAdminCardSchema(db);
        const w = ethers_1.ethers.getAddress(walletLoose).toLowerCase();
        const card = ethers_1.ethers.getAddress(cardAddressLoose).toLowerCase();
        await db.query('BEGIN');
        const { rows: existingRows } = await db.query(`SELECT 1 FROM beamio_pos_terminal_admin_card WHERE pos_eoa = $1 AND card_address = $2`, [w, card]);
        if (existingRows.length === 0) {
            await db.query('ROLLBACK');
            return { ok: false, error: 'Terminal is not bound to this merchant card' };
        }
        await db.query(`UPDATE beamio_pos_terminal_admin_card SET is_active = false WHERE pos_eoa = $1 AND is_active = true`, [w]);
        await db.query(`UPDATE beamio_pos_terminal_admin_card SET is_active = true, updated_at = NOW() WHERE pos_eoa = $1 AND card_address = $2`, [w, card]);
        await db.query('COMMIT');
        return { ok: true };
    }
    catch (e) {
        await db.query('ROLLBACK').catch(() => { });
        (0, logger_1.logger)(safe_1.default.yellow(`[setActivePosTerminalCardBinding] failed: ${e?.message ?? e}`));
        return { ok: false, error: 'Could not set active merchant card' };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.setActivePosTerminalCardBinding = setActivePosTerminalCardBinding;
/**
 * Delete one POS ↔ merchant card binding (blacklist / stale).
 * If the deleted row was active, promote another remaining binding.
 * @deprecated Prefer {@link deletePosTerminalAdminCardBinding} + promote; this name kept for callers that pass (wallet, card).
 */
const deletePosTerminalCardBinding = async (walletLoose, cardAddressLoose) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioPosTerminalAdminCardSchema(db);
        const w = ethers_1.ethers.getAddress(walletLoose).toLowerCase();
        if (!cardAddressLoose || !ethers_1.ethers.isAddress(cardAddressLoose)) {
            (0, logger_1.logger)(safe_1.default.yellow(`[deletePosTerminalCardBinding] refused full wipe for pos=${w}; pass cardAddress`));
            return false;
        }
        const card = ethers_1.ethers.getAddress(cardAddressLoose).toLowerCase();
        await db.query('BEGIN');
        const { rows: before } = await db.query(`SELECT is_active FROM beamio_pos_terminal_admin_card WHERE pos_eoa = $1 AND card_address = $2`, [w, card]);
        const wasActive = Boolean(before[0]?.is_active);
        const result = await db.query(`DELETE FROM beamio_pos_terminal_admin_card WHERE pos_eoa = $1 AND card_address = $2`, [w, card]);
        if (wasActive && (result.rowCount ?? 0) > 0) {
            await db.query(`
				UPDATE beamio_pos_terminal_admin_card t
				SET is_active = true, updated_at = NOW()
				FROM (
					SELECT card_address FROM beamio_pos_terminal_admin_card
					WHERE pos_eoa = $1
					ORDER BY updated_at DESC NULLS LAST
					LIMIT 1
				) pick
				WHERE t.pos_eoa = $1 AND t.card_address = pick.card_address
				`, [w]);
        }
        await db.query('COMMIT');
        return (result.rowCount ?? 0) > 0;
    }
    catch (e) {
        await db.query('ROLLBACK').catch(() => { });
        (0, logger_1.logger)(safe_1.default.yellow(`[deletePosTerminalCardBinding] failed: ${e?.message ?? e}`));
        return false;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.deletePosTerminalCardBinding = deletePosTerminalCardBinding;
/**
 * Owner's merchant program cards in `beamio_cards`, newest first (`created_at DESC`).
 * Caller skips API-excluded / blacklisted addresses when choosing the latest usable card.
 */
const listMerchantCardAddressesForOwnerNewestFirst = async (ownerEoaLoose) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_CARDS_TABLE);
        const owner = ethers_1.ethers.getAddress(ownerEoaLoose).toLowerCase();
        const { rows } = await db.query(`SELECT card_address, created_at
			 FROM beamio_cards
			 WHERE LOWER(TRIM(card_owner)) = $1
			 ORDER BY created_at DESC NULLS LAST`, [owner]);
        const out = [];
        for (const row of rows) {
            if (!row.card_address || !ethers_1.ethers.isAddress(row.card_address))
                continue;
            const createdAt = row.created_at == null
                ? null
                : row.created_at instanceof Date
                    ? row.created_at.toISOString()
                    : String(row.created_at);
            out.push({ cardAddress: ethers_1.ethers.getAddress(row.card_address), createdAt });
        }
        return out;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listMerchantCardAddressesForOwnerNewestFirst] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listMerchantCardAddressesForOwnerNewestFirst = listMerchantCardAddressesForOwnerNewestFirst;
const listPosTerminalCardBindingsByCard = async (cardAddressLoose) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioPosTerminalAdminCardSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddressLoose).toLowerCase();
        const { rows } = await db.query(`SELECT pos_eoa, card_address, tx_hash, metadata_json
			 FROM beamio_pos_terminal_admin_card
			 WHERE LOWER(TRIM(card_address)) = $1
			 ORDER BY updated_at ASC`, [card]);
        const out = [];
        for (const row of rows) {
            if (!row.pos_eoa || !ethers_1.ethers.isAddress(row.pos_eoa))
                continue;
            if (!row.card_address || !ethers_1.ethers.isAddress(row.card_address))
                continue;
            out.push({
                posEoa: ethers_1.ethers.getAddress(row.pos_eoa),
                cardAddress: ethers_1.ethers.getAddress(row.card_address),
                txHash: row.tx_hash ?? null,
                terminalMetadata: row.metadata_json ?? null,
            });
        }
        return out;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listPosTerminalCardBindingsByCard] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listPosTerminalCardBindingsByCard = listPosTerminalCardBindingsByCard;
/** beamio_nft_series 表：存储 issued NFT 系列，含 sharedSeriesMetadata 的 IPFS 引用；metadata_json 为通用型 JSONB（应用场景扩展用，如电影/演唱会/商品等） */
const BEAMIO_NFT_SERIES_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nft_series (
	id SERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	token_id TEXT NOT NULL,
	shared_metadata_hash TEXT NOT NULL,
	ipfs_cid TEXT NOT NULL,
	card_owner TEXT NOT NULL,
	metadata_json JSONB,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	UNIQUE(card_address, token_id)
)`;
/** beamio_nft_mint_metadata 表：每笔 mint 的通用型 metadata_json（电影票座位、商品序列号、演唱会区域等），由 purchase/mint 流程登记 */
const BEAMIO_NFT_MINT_METADATA_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nft_mint_metadata (
	id SERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	token_id TEXT NOT NULL,
	owner_address TEXT NOT NULL,
	tx_hash TEXT,
	metadata_json JSONB NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`;
/** beamio_nft_tier_metadata 表：按 (card_owner, token_id) 存储每张成员 NFT 的 tier metadata，供 GET /metadata/0x{owner}{NFT#}.json 返回 */
const BEAMIO_NFT_TIER_METADATA_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nft_tier_metadata (
	id SERIAL PRIMARY KEY,
	card_owner TEXT NOT NULL,
	token_id BIGINT NOT NULL,
	card_address TEXT NOT NULL,
	metadata_json JSONB NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	UNIQUE(card_owner, token_id)
)`;
/** 每次 Base 上成功 top-up（USDC 购点 / POS NFC mint）后写入：会员档 NFT#、EOA、AA，供 biz 按卡查询会员地址（与 indexer 互补）。base_tx_hash 幂等。 */
const BEAMIO_MEMBER_TOPUP_EVENTS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_member_topup_events (
	id SERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	base_tx_hash TEXT NOT NULL,
	member_eoa TEXT NOT NULL,
	member_aa TEXT NOT NULL,
	tier_token_id TEXT NOT NULL,
	topup_source TEXT NOT NULL,
	topup_category TEXT,
	created_at TIMESTAMPTZ DEFAULT NOW(),
	UNIQUE(base_tx_hash)
)`;
const BEAMIO_MEMBER_TOPUP_EVENTS_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_beamio_member_topup_events_card ON beamio_member_topup_events (LOWER(TRIM(card_address)))`;
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POINTS = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS points_e6 TEXT`;
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_USDC = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS usdc_e6 TEXT`;
/** PR #4 (USDC charge orchestrator): 把外部 USDC 结算 tx 挂到 topup 行上，便于
 *  「USDC settle → tmp wallet topup → tmp wallet charge」三段对账（同一 sid 共享 USDC_tx）。 */
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_ORIG_USDC_TX = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS originating_usdc_tx TEXT`;
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_CHARGE_SID = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS charge_session_id TEXT`;
const BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POS_OPERATOR = `ALTER TABLE beamio_member_topup_events ADD COLUMN IF NOT EXISTS pos_operator TEXT`;
/** 每卡每 EOA 聚合：top-up 次数、累计 points(6) / USDC(6)、仅保留最后一次 top-up 时间戳。 */
const BEAMIO_CARD_MEMBER_TOPUP_STATS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_card_member_topup_stats (
	card_address TEXT NOT NULL,
	member_eoa TEXT NOT NULL,
	member_aa TEXT NOT NULL,
	tier_token_id TEXT NOT NULL,
	topup_count INTEGER NOT NULL DEFAULT 0,
	topup_points_total_e6 NUMERIC(48,0) NOT NULL DEFAULT 0,
	topup_usdc_total_e6 NUMERIC(48,0) NOT NULL DEFAULT 0,
	last_topup_at TIMESTAMPTZ NOT NULL,
	last_base_tx_hash TEXT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (card_address, member_eoa)
)`;
const BEAMIO_CARD_MEMBER_TOPUP_STATS_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_beamio_card_member_topup_stats_card_last ON beamio_card_member_topup_stats (card_address, last_topup_at DESC)`;
/** 每张卡汇总：成功 top-up 总次数、repeat top-up 次数（非新用户：未新发/升级档 NFT，与 MemberCard topupCategory 一致）。 */
const BEAMIO_CARD_TOPUP_ROLLUPS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_card_topup_rollups (
	card_address TEXT PRIMARY KEY,
	total_topup_count BIGINT NOT NULL DEFAULT 0,
	total_repeat_topup_count BIGINT NOT NULL DEFAULT 0,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
async function ensureBeamioCardTopupRollupsSchema(db) {
    await db.query(BEAMIO_CARD_TOPUP_ROLLUPS_TABLE);
    /** Top-up 前无有效会员 NFT 时按渠道累计（近场 NFC / App USDC）。 */
    await db.query(`ALTER TABLE beamio_card_topup_rollups ADD COLUMN IF NOT EXISTS nfc_activation_count BIGINT NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE beamio_card_topup_rollups ADD COLUMN IF NOT EXISTS app_activation_count BIGINT NOT NULL DEFAULT 0`);
}
/** USDC：`usdcTopupCard`；NFC：`topupCard`。其余（newCard / upgrade / usdcNewCard 等）不计入 repeat。 */
function topupCategoryIsRepeatMemberTopup(category) {
    if (category == null)
        return false;
    const c = String(category).trim();
    return c === 'usdcTopupCard' || c === 'topupCard';
}
const getCardTopupRollup = async (cardAddress) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioCardTopupRollupsSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const { rows } = await db.query(`
			SELECT
				total_topup_count::text,
				total_repeat_topup_count::text,
				COALESCE(nfc_activation_count, 0)::text AS nfc_activation_count,
				COALESCE(app_activation_count, 0)::text AS app_activation_count
			FROM beamio_card_topup_rollups
			WHERE card_address = $1
			LIMIT 1
			`, [card]);
        if (!rows.length) {
            return {
                totalTopupCount: 0,
                totalRepeatTopupCount: 0,
                nfcActivationCount: 0,
                appActivationCount: 0,
            };
        }
        return {
            totalTopupCount: Number(rows[0].total_topup_count) || 0,
            totalRepeatTopupCount: Number(rows[0].total_repeat_topup_count) || 0,
            nfcActivationCount: Number(rows[0].nfc_activation_count) || 0,
            appActivationCount: Number(rows[0].app_activation_count) || 0,
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getCardTopupRollup] failed: ${e?.message ?? e}`));
        return {
            totalTopupCount: 0,
            totalRepeatTopupCount: 0,
            nfcActivationCount: 0,
            appActivationCount: 0,
        };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getCardTopupRollup = getCardTopupRollup;
async function ensureBeamioMemberTopupEventsSchema(db) {
    await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_TABLE);
    await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POINTS);
    await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_USDC);
    await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_ORIG_USDC_TX);
    await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_CHARGE_SID);
    await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_ADD_POS_OPERATOR);
    await db.query(BEAMIO_MEMBER_TOPUP_EVENTS_IDX_CARD);
}
async function ensureBeamioCardMemberTopupStatsSchema(db) {
    await db.query(BEAMIO_CARD_MEMBER_TOPUP_STATS_TABLE);
    await db.query(BEAMIO_CARD_MEMBER_TOPUP_STATS_IDX_CARD);
}
function topupAmountToNumericString(v) {
    if (v == null)
        return '0';
    if (typeof v === 'bigint')
        return v.toString();
    if (typeof v === 'number')
        return String(Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const s = String(v).trim();
    if (!s || !/^\d+$/.test(s))
        return '0';
    return s;
}
/** Master：Base top-up 成功后写入事件（幂等 base_tx_hash）；仅在新插入时累加 beamio_card_member_topup_stats。 */
const insertMemberTopupEvent = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const pointsStr = topupAmountToNumericString(params.pointsE6);
    const usdcStr = topupAmountToNumericString(params.usdcE6);
    try {
        await db.connect();
        await ensureBeamioMemberTopupEventsSchema(db);
        await ensureBeamioCardMemberTopupStatsSchema(db);
        await ensureBeamioCardTopupRollupsSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const hash = String(params.baseTxHash).toLowerCase();
        const eoa = ethers_1.ethers.getAddress(params.memberEoa).toLowerCase();
        const aa = ethers_1.ethers.isAddress(params.memberAa) ? ethers_1.ethers.getAddress(params.memberAa).toLowerCase() : ethers_1.ethers.ZeroAddress.toLowerCase();
        const repeatInc = topupCategoryIsRepeatMemberTopup(params.topupCategory) ? 1 : 0;
        const nfcActInc = params.topupSource === 'androidNfcTopup' && params.countAsNfcActivation === true ? 1 : 0;
        const appActInc = params.topupSource === 'usdcPurchasingCard' && params.countAsAppActivation === true ? 1 : 0;
        const origUsdcTxNorm = typeof params.originatingUsdcTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(params.originatingUsdcTx.trim())
            ? params.originatingUsdcTx.trim().toLowerCase()
            : null;
        const chargeSidNorm = typeof params.chargeSessionId === 'string' && params.chargeSessionId.trim().length > 0
            ? params.chargeSessionId.trim().toLowerCase()
            : null;
        const posOpNorm = typeof params.posOperator === 'string' && ethers_1.ethers.isAddress(params.posOperator.trim())
            ? ethers_1.ethers.getAddress(params.posOperator.trim()).toLowerCase()
            : null;
        await db.query('BEGIN');
        try {
            const ins = await db.query(`
				INSERT INTO beamio_member_topup_events (card_address, base_tx_hash, member_eoa, member_aa, tier_token_id, topup_source, topup_category, points_e6, usdc_e6, originating_usdc_tx, charge_session_id, pos_operator)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
				ON CONFLICT (base_tx_hash) DO NOTHING
				RETURNING id
				`, [card, hash, eoa, aa, String(params.tierTokenId), params.topupSource, params.topupCategory ?? null, pointsStr, usdcStr, origUsdcTxNorm, chargeSidNorm, posOpNorm]);
            if (!ins.rows?.length) {
                await db.query('COMMIT');
                return;
            }
            await db.query(`
				INSERT INTO beamio_card_member_topup_stats (
					card_address, member_eoa, member_aa, tier_token_id,
					topup_count, topup_points_total_e6, topup_usdc_total_e6,
					last_topup_at, last_base_tx_hash
				) VALUES ($1, $2, $3, $4, 1, $5::numeric, $6::numeric, NOW(), $7)
				ON CONFLICT (card_address, member_eoa) DO UPDATE SET
					member_aa = EXCLUDED.member_aa,
					tier_token_id = EXCLUDED.tier_token_id,
					topup_count = beamio_card_member_topup_stats.topup_count + 1,
					topup_points_total_e6 = beamio_card_member_topup_stats.topup_points_total_e6 + EXCLUDED.topup_points_total_e6,
					topup_usdc_total_e6 = beamio_card_member_topup_stats.topup_usdc_total_e6 + EXCLUDED.topup_usdc_total_e6,
					last_topup_at = EXCLUDED.last_topup_at,
					last_base_tx_hash = EXCLUDED.last_base_tx_hash,
					updated_at = NOW()
				`, [card, eoa, aa, String(params.tierTokenId), pointsStr, usdcStr, hash]);
            await db.query(`
				INSERT INTO beamio_card_topup_rollups (
					card_address, total_topup_count, total_repeat_topup_count,
					nfc_activation_count, app_activation_count
				)
				VALUES ($1, 1, $2, $3, $4)
				ON CONFLICT (card_address) DO UPDATE SET
					total_topup_count = beamio_card_topup_rollups.total_topup_count + 1,
					total_repeat_topup_count = beamio_card_topup_rollups.total_repeat_topup_count + EXCLUDED.total_repeat_topup_count,
					nfc_activation_count = beamio_card_topup_rollups.nfc_activation_count + EXCLUDED.nfc_activation_count,
					app_activation_count = beamio_card_topup_rollups.app_activation_count + EXCLUDED.app_activation_count,
					updated_at = NOW()
				`, [card, repeatInc, nfcActInc, appActInc]);
            await db.query('COMMIT');
            (0, logger_1.logger)(safe_1.default.green(`[insertMemberTopupEvent] card=${card} tx=${hash.slice(0, 12)}… eoa=${eoa.slice(0, 10)}… tier=${params.tierTokenId} pts+${pointsStr} usdc+${usdcStr} repeat+${repeatInc} nfcAct+${nfcActInc} appAct+${appActInc}`));
        }
        catch (inner) {
            await db.query('ROLLBACK').catch(() => { });
            throw inner;
        }
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[insertMemberTopupEvent] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.insertMemberTopupEvent = insertMemberTopupEvent;
const mapMemberTopupRow = (r) => ({
    memberEoa: r.member_eoa,
    memberAa: r.member_aa,
    tierTokenId: r.tier_token_id,
    baseTxHash: r.base_tx_hash,
    topupSource: r.topup_source,
    topupCategory: r.topup_category,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    ...(r.points_e6 != null && r.points_e6 !== '' ? { pointsE6: r.points_e6 } : {}),
    ...(r.usdc_e6 != null && r.usdc_e6 !== '' ? { usdcE6: r.usdc_e6 } : {}),
});
const mapMemberTopupStatsRow = (r) => ({
    memberEoa: r.member_eoa,
    memberAa: r.member_aa,
    tierTokenId: r.tier_token_id,
    topupCount: typeof r.topup_count === 'number' ? r.topup_count : Number(r.topup_count) || 0,
    topupPointsTotalE6: String(r.topup_points_total_e6 ?? '0'),
    topupUsdcTotalE6: String(r.topup_usdc_total_e6 ?? '0'),
    lastTopupAt: r.last_topup_at instanceof Date ? r.last_topup_at.toISOString() : String(r.last_topup_at),
    lastBaseTxHash: r.last_base_tx_hash,
});
/** Cluster：按卡分页拉取 top-up 事件，按登记时间 created_at 倒序。total 为该卡事件总行数。limit 默认 20，最大 2000。 */
const listCardMemberTopupEvents = async (cardAddress, opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    try {
        await db.connect();
        await ensureBeamioMemberTopupEventsSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`SELECT COUNT(*)::text AS c FROM beamio_member_topup_events WHERE LOWER(TRIM(card_address)) = $1`, [card]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			SELECT member_eoa, member_aa, tier_token_id, base_tx_hash, topup_source, topup_category, created_at, points_e6, usdc_e6
			FROM beamio_member_topup_events
			WHERE LOWER(TRIM(card_address)) = $1
			ORDER BY created_at DESC, id DESC
			LIMIT $2 OFFSET $3
			`, [card, limit, offset]);
        return { items: rows.map(mapMemberTopupRow), total };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listCardMemberTopupEvents] failed: ${e?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCardMemberTopupEvents = listCardMemberTopupEvents;
const getMemberLastTopupOnCard = async (cardAddress, memberEoa) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioMemberTopupEventsSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const eoa = ethers_1.ethers.getAddress(memberEoa).toLowerCase();
        const { rows } = await db.query(`
			SELECT created_at, usdc_e6, points_e6, base_tx_hash
			FROM beamio_member_topup_events
			WHERE LOWER(TRIM(card_address)) = $1 AND LOWER(TRIM(member_eoa)) = $2
			ORDER BY created_at DESC, id DESC
			LIMIT 1
			`, [card, eoa]);
        if (!rows.length)
            return null;
        const r = rows[0];
        return {
            lastTopupAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
            usdcE6: r.usdc_e6 != null && String(r.usdc_e6).trim() !== '' ? String(r.usdc_e6).trim() : null,
            pointsE6: r.points_e6 != null && String(r.points_e6).trim() !== '' ? String(r.points_e6).trim() : null,
            baseTxHash: r.base_tx_hash ?? null,
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getMemberLastTopupOnCard] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getMemberLastTopupOnCard = getMemberLastTopupOnCard;
/**
 * Cluster：按卡读取 beamio_card_member_topup_stats（每用户 top-up 次数、累计 points/USDC、仅最后一次时间戳），按 last_topup_at 倒序分页。
 * total 为该卡聚合行数（会员地址数）。
 */
const listDistinctCardMemberTopupMembers = async (cardAddress, opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    try {
        await db.connect();
        await ensureBeamioCardMemberTopupStatsSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`SELECT COUNT(*)::text AS c FROM beamio_card_member_topup_stats WHERE card_address = $1`, [card]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			SELECT member_eoa, member_aa, tier_token_id, topup_count, topup_points_total_e6, topup_usdc_total_e6, last_topup_at, last_base_tx_hash
			FROM beamio_card_member_topup_stats
			WHERE card_address = $1
			ORDER BY last_topup_at DESC, member_eoa ASC
			LIMIT $2 OFFSET $3
			`, [card, limit, offset]);
        return { items: rows.map(mapMemberTopupStatsRow), total };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listDistinctCardMemberTopupMembers] failed: ${e?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listDistinctCardMemberTopupMembers = listDistinctCardMemberTopupMembers;
const mapCardMemberDirectoryRow = (r) => ({
    ...mapMemberTopupStatsRow(r),
    usedNfc: Boolean(r.used_nfc),
    usedApp: Boolean(r.used_app),
    firstTopupSource: r.first_topup_source != null && String(r.first_topup_source).trim() !== '' ? String(r.first_topup_source).trim() : null,
    firstTopupAt: r.first_topup_at instanceof Date
        ? r.first_topup_at.toISOString()
        : r.first_topup_at != null
            ? String(r.first_topup_at)
            : '',
});
/** Cluster：同 `listDistinctCardMemberTopupMembers` 排序与分页，附加每笔会员在该卡上的 NFC/App top-up 轨迹 */
const listCardMemberDirectory = async (cardAddress, opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    try {
        await db.connect();
        await ensureBeamioCardMemberTopupStatsSchema(db);
        await ensureBeamioMemberTopupEventsSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`SELECT COUNT(*)::text AS c FROM beamio_card_member_topup_stats WHERE card_address = $1`, [card]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			WITH ch AS (
				SELECT
					LOWER(TRIM(member_eoa)) AS eoa,
					BOOL_OR(topup_source = 'androidNfcTopup') AS used_nfc,
					BOOL_OR(topup_source = 'usdcPurchasingCard') AS used_app
				FROM beamio_member_topup_events
				WHERE LOWER(TRIM(card_address)) = $1
				GROUP BY LOWER(TRIM(member_eoa))
			),
			fs AS (
				SELECT DISTINCT ON (LOWER(TRIM(member_eoa)))
					LOWER(TRIM(member_eoa)) AS eoa,
					topup_source AS first_topup_source,
					created_at AS first_topup_at
				FROM beamio_member_topup_events
				WHERE LOWER(TRIM(card_address)) = $1
				ORDER BY LOWER(TRIM(member_eoa)), created_at ASC, id ASC
			)
			SELECT
				s.member_eoa,
				s.member_aa,
				s.tier_token_id,
				s.topup_count,
				s.topup_points_total_e6::text,
				s.topup_usdc_total_e6::text,
				s.last_topup_at,
				s.last_base_tx_hash,
				COALESCE(ch.used_nfc, false) AS used_nfc,
				COALESCE(ch.used_app, false) AS used_app,
				fs.first_topup_source,
				fs.first_topup_at
			FROM beamio_card_member_topup_stats s
			LEFT JOIN ch ON LOWER(TRIM(s.member_eoa)) = ch.eoa
			LEFT JOIN fs ON LOWER(TRIM(s.member_eoa)) = fs.eoa
			WHERE s.card_address = $1
			ORDER BY s.last_topup_at DESC, s.member_eoa ASC
			LIMIT $2 OFFSET $3
			`, [card, limit, offset]);
        return { items: rows.map(mapCardMemberDirectoryRow), total };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listCardMemberDirectory] failed: ${e?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCardMemberDirectory = listCardMemberDirectory;
/** nfc_cards 表：NTAG 424 DNA 登记卡。uid 为 NFC 卡 UID（兼容旧数据）；tag_id 为 SUN 解密得到的 TagID（16 hex），用于合法性校验与查卡。private_key 为关联私钥（仅服务端使用，不返回客户端） */
const NFC_CARDS_TABLE = `CREATE TABLE IF NOT EXISTS nfc_cards (
	id SERIAL PRIMARY KEY,
	uid TEXT UNIQUE NOT NULL,
	private_key TEXT NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`;
const NFC_CARDS_ADD_TAG_ID = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS tag_id TEXT UNIQUE`;
/** Link App 认领完成后写入用户 EOA，供按钱包枚举已绑定 NFC（不暴露私钥） */
const NFC_CARDS_ADD_LINKED_OWNER = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS linked_owner_eoa TEXT`;
const NFC_CARDS_IDX_LINKED_OWNER = `CREATE INDEX IF NOT EXISTS idx_nfc_cards_linked_owner_eoa ON nfc_cards (LOWER(TRIM(linked_owner_eoa))) WHERE linked_owner_eoa IS NOT NULL`;
/** user-linked 卡：active 允许 NFC 交易；deactive 仅允许查余额；remove 后清空私钥与 linked_owner */
const NFC_CARDS_ADD_LINK_STATE = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS nfc_link_state TEXT`;
const NFC_CARDS_PRIVATE_KEY_DROP_NOT_NULL = `ALTER TABLE nfc_cards ALTER COLUMN private_key DROP NOT NULL`;
/** NFC 自动分配的 verra 序号（遗留），按 tag_id 绑定便于幂等 */
const NFC_CARDS_ADD_VERRA_NUMBER = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS verra_number BIGINT`;
/** NFC 自动分配的 beamio_nfc_* 序号，按 tag_id 绑定便于幂等 */
const NFC_CARDS_ADD_BEAMIO_NFC_NUMBER = `ALTER TABLE nfc_cards ADD COLUMN IF NOT EXISTS beamio_nfc_number BIGINT`;
/** NFC TagID -> 已可信确认持有资产的 BeamioUserCard 列表。只在可信链上读成功后 upsert，不因失败/空窗口清空。 */
const NFC_BEAMIO_USER_CARD_HOLDINGS_TABLE = `CREATE TABLE IF NOT EXISTS nfc_beamio_user_card_holdings (
	id SERIAL PRIMARY KEY,
	tag_id TEXT NOT NULL,
	uid TEXT,
	owner_eoa TEXT NOT NULL,
	aa_address TEXT,
	card_address TEXT NOT NULL,
	card_name TEXT,
	card_type TEXT,
	points6 TEXT NOT NULL DEFAULT '0',
	charge_reward_points6 TEXT NOT NULL DEFAULT '0',
	primary_member_token_id TEXT,
	last_trusted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE(tag_id, card_address)
)`;
const NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_OWNER = `CREATE INDEX IF NOT EXISTS idx_nfc_beamio_user_card_holdings_owner ON nfc_beamio_user_card_holdings (LOWER(TRIM(owner_eoa)))`;
const NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_CARD = `CREATE INDEX IF NOT EXISTS idx_nfc_beamio_user_card_holdings_card ON nfc_beamio_user_card_holdings (LOWER(TRIM(card_address)))`;
/** 全局自增 verra 编号（PostgreSQL 单行原子 UPDATE） */
const BEAMIO_VERRA_SEQ_TABLE = `CREATE TABLE IF NOT EXISTS beamio_verra_seq (
	id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	last_assigned BIGINT NOT NULL DEFAULT 0
)`;
const BEAMIO_VERRA_SEQ_SEED = `INSERT INTO beamio_verra_seq (id, last_assigned) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
/** 全局自增 beamio_nfc_* 编号（PostgreSQL 单行原子 UPDATE） */
const BEAMIO_NFC_SEQ_TABLE = `CREATE TABLE IF NOT EXISTS beamio_nfc_seq (
	id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	last_assigned BIGINT NOT NULL DEFAULT 0
)`;
const BEAMIO_NFC_SEQ_SEED = `INSERT INTO beamio_nfc_seq (id, last_assigned) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
exports.NFC_CARD_LINK_STATE_SCOPE = 'beamio:NfcCardLinkState:v1';
const NFC_GATE_DEACTIVATED_MSG = 'This NFC card is deactivated. Only balance checks are allowed. Reactivate it in your wallet app first.';
const NFC_GATE_UNLINKED_MSG = 'This NFC card is not linked or the link was removed.';
async function ensureNfcCardsExtendedSchema(db) {
    await db.query(NFC_CARDS_TABLE);
    await db.query(NFC_CARDS_ADD_TAG_ID);
    await db.query(NFC_CARDS_ADD_LINKED_OWNER);
    await db.query(NFC_CARDS_ADD_LINK_STATE);
    await db.query(NFC_CARDS_PRIVATE_KEY_DROP_NOT_NULL);
    await db.query(NFC_CARDS_ADD_VERRA_NUMBER);
    await db.query(NFC_CARDS_ADD_BEAMIO_NFC_NUMBER);
    await db.query(NFC_CARDS_IDX_LINKED_OWNER);
}
async function ensureNfcBeamioUserCardHoldingsSchema(db) {
    await db.query(NFC_BEAMIO_USER_CARD_HOLDINGS_TABLE);
    await db.query(NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_OWNER);
    await db.query(NFC_BEAMIO_USER_CARD_HOLDINGS_IDX_CARD);
}
function normalizeNfcHoldingTagId(tagIdHex) {
    const tag = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    if (!tag || tag.length !== 16 || !/^[0-9A-F]+$/.test(tag)) {
        throw new Error('Invalid NFC tagId');
    }
    return tag;
}
function nfcHoldingRowFromDb(r) {
    return {
        tagId: String(r.tag_id || '').toUpperCase(),
        uid: r.uid ?? null,
        ownerEoa: ethers_1.ethers.getAddress(r.owner_eoa),
        aaAddress: r.aa_address && ethers_1.ethers.isAddress(r.aa_address) ? ethers_1.ethers.getAddress(r.aa_address) : null,
        cardAddress: ethers_1.ethers.getAddress(r.card_address),
        cardName: r.card_name ?? null,
        cardType: r.card_type ?? null,
        points6: String(r.points6 ?? '0'),
        chargeRewardPoints6: String(r.charge_reward_points6 ?? '0'),
        primaryMemberTokenId: r.primary_member_token_id ?? null,
        lastTrustedAt: r.last_trusted_at instanceof Date ? r.last_trusted_at.toISOString() : String(r.last_trusted_at),
    };
}
async function upsertNfcBeamioUserCardHoldingsFromTrustedCards(params) {
    const tagId = normalizeNfcHoldingTagId(params.tagIdHex);
    const owner = ethers_1.ethers.getAddress(params.ownerEoa).toLowerCase();
    const aa = params.aaAddress && ethers_1.ethers.isAddress(params.aaAddress) ? ethers_1.ethers.getAddress(params.aaAddress).toLowerCase() : null;
    const uid = params.uid ? String(params.uid).trim().replace(/^0x/i, '').toLowerCase() : null;
    const trustedCards = params.cards.filter((c) => {
        if (!c?.cardAddress || !ethers_1.ethers.isAddress(c.cardAddress))
            return false;
        let points6 = 0n;
        let chargeRewardPoints6 = 0n;
        try {
            points6 = BigInt(String(c.points6 ?? '0'));
            chargeRewardPoints6 = BigInt(String(c.chargeRewardPoints6 ?? '0'));
        }
        catch {
            return false;
        }
        const hasNft = Array.isArray(c.nfts) && c.nfts.some((n) => {
            try {
                return BigInt(String(n?.tokenId ?? '0')) > 0n;
            }
            catch {
                return false;
            }
        });
        return points6 > 0n || chargeRewardPoints6 > 0n || hasNft;
    });
    if (trustedCards.length === 0)
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcBeamioUserCardHoldingsSchema(db);
        for (const c of trustedCards) {
            const card = ethers_1.ethers.getAddress(c.cardAddress).toLowerCase();
            await db.query(`
				INSERT INTO nfc_beamio_user_card_holdings (
					tag_id, uid, owner_eoa, aa_address, card_address,
					card_name, card_type, points6, charge_reward_points6,
					primary_member_token_id, last_trusted_at, updated_at
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
				ON CONFLICT (tag_id, card_address) DO UPDATE SET
					uid = COALESCE(EXCLUDED.uid, nfc_beamio_user_card_holdings.uid),
					owner_eoa = EXCLUDED.owner_eoa,
					aa_address = EXCLUDED.aa_address,
					card_name = COALESCE(EXCLUDED.card_name, nfc_beamio_user_card_holdings.card_name),
					card_type = COALESCE(EXCLUDED.card_type, nfc_beamio_user_card_holdings.card_type),
					points6 = EXCLUDED.points6,
					charge_reward_points6 = EXCLUDED.charge_reward_points6,
					primary_member_token_id = COALESCE(EXCLUDED.primary_member_token_id, nfc_beamio_user_card_holdings.primary_member_token_id),
					last_trusted_at = NOW(),
					updated_at = NOW()
				`, [
                tagId,
                uid,
                owner,
                aa,
                card,
                c.cardName ?? null,
                c.cardType ?? null,
                String(c.points6 ?? '0'),
                String(c.chargeRewardPoints6 ?? '0'),
                c.primaryMemberTokenId ?? null,
            ]);
        }
        (0, logger_1.logger)(safe_1.default.green(`[upsertNfcBeamioUserCardHoldings] tagId=${tagId.slice(0, 8)}... cards=${trustedCards.length}`));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertNfcBeamioUserCardHoldings] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function listNfcBeamioUserCardHoldingsByTagId(tagIdHex) {
    const tagId = normalizeNfcHoldingTagId(tagIdHex);
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcBeamioUserCardHoldingsSchema(db);
        const { rows } = await db.query(`
			SELECT tag_id, uid, owner_eoa, aa_address, card_address, card_name, card_type,
				points6, charge_reward_points6, primary_member_token_id, last_trusted_at
			FROM nfc_beamio_user_card_holdings
			WHERE tag_id = $1
			ORDER BY last_trusted_at DESC
			`, [tagId]);
        return rows.map(nfcHoldingRowFromDb);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listNfcBeamioUserCardHoldingsByTagId] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function nfcBeamioUserCardHoldingContains(tagIdHex, cardAddress) {
    const tagId = normalizeNfcHoldingTagId(tagIdHex);
    const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcBeamioUserCardHoldingsSchema(db);
        const { rows } = await db.query(`SELECT 1 AS ok FROM nfc_beamio_user_card_holdings WHERE tag_id = $1 AND card_address = $2 LIMIT 1`, [tagId, card]);
        return rows.length > 0;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[nfcBeamioUserCardHoldingContains] failed: ${e?.message ?? e}`));
        return false;
    }
    finally {
        await db.end().catch(() => { });
    }
}
async function ensureBeamioVerraSeqSchema(db) {
    await db.query(BEAMIO_VERRA_SEQ_TABLE);
    await db.query(BEAMIO_VERRA_SEQ_SEED);
}
/** 分配下一个 verra 序号（全局递增，持久化在 beamio_verra_seq） */
const allocateNextVerraNumber = async () => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioVerraSeqSchema(db);
        const { rows } = await db.query(`UPDATE beamio_verra_seq SET last_assigned = last_assigned + 1 WHERE id = 1 RETURNING last_assigned`);
        const n = rows[0]?.last_assigned;
        return n != null ? Number(n) : 1;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[allocateNextVerraNumber] failed: ${e?.message ?? e}`));
        return 1;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.allocateNextVerraNumber = allocateNextVerraNumber;
const getNfcVerraNumberByTagId = async (tagIdHex) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized))
        return null;
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT verra_number FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`, [normalized]);
        const v = rows[0]?.verra_number;
        if (v == null)
            return null;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcVerraNumberByTagId] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcVerraNumberByTagId = getNfcVerraNumberByTagId;
const setNfcCardVerraNumberIfUnset = async (tagIdHex, verraNum) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(verraNum) || verraNum <= 0)
        return;
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        await db.query(`UPDATE nfc_cards SET verra_number = $2 WHERE UPPER(TRIM(tag_id)) = $1 AND (verra_number IS NULL OR verra_number <= 0)`, [normalized, verraNum]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[setNfcCardVerraNumberIfUnset] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.setNfcCardVerraNumberIfUnset = setNfcCardVerraNumberIfUnset;
const upsertNfcCardVerraNumberByTagId = async (tagIdHex, verraNum) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(verraNum) || verraNum <= 0)
        return;
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        await db.query(`UPDATE nfc_cards SET verra_number = $2 WHERE UPPER(TRIM(tag_id)) = $1`, [normalized, verraNum]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertNfcCardVerraNumberByTagId] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertNfcCardVerraNumberByTagId = upsertNfcCardVerraNumberByTagId;
/**
 * NFC 自动 beamioTag：verra_{N}（遗留；新登记请用 beamio_nfc_{N}）。
 */
const buildVerraBeamioAccountName = (verraNumber) => {
    const n = Math.floor(Number(verraNumber));
    if (!Number.isFinite(n) || n <= 0)
        return '';
    const s = `verra_${n}`;
    return BEAMIO_ACCOUNT_NAME_RE.test(s) ? s : '';
};
exports.buildVerraBeamioAccountName = buildVerraBeamioAccountName;
async function ensureBeamioNfcSeqSchema(db) {
    await db.query(BEAMIO_NFC_SEQ_TABLE);
    await db.query(BEAMIO_NFC_SEQ_SEED);
}
/** 当前 beamio_nfc_seq 已分配到的最大序号（持久化游标） */
const getBeamioNfcSeqLastAssigned = async () => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioNfcSeqSchema(db);
        const { rows } = await db.query(`SELECT last_assigned FROM beamio_nfc_seq WHERE id = 1 LIMIT 1`);
        const n = rows[0]?.last_assigned;
        return n != null && Number.isFinite(Number(n)) ? Number(n) : 0;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getBeamioNfcSeqLastAssigned] failed: ${e?.message ?? e}`));
        return 0;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getBeamioNfcSeqLastAssigned = getBeamioNfcSeqLastAssigned;
/** 分配下一个 beamio_nfc_* 序号（全局递增，持久化在 beamio_nfc_seq） */
const allocateNextBeamioNfcNumber = async () => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioNfcSeqSchema(db);
        const { rows } = await db.query(`UPDATE beamio_nfc_seq SET last_assigned = last_assigned + 1 WHERE id = 1 RETURNING last_assigned`);
        const n = rows[0]?.last_assigned;
        return n != null ? Number(n) : 1;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[allocateNextBeamioNfcNumber] failed: ${e?.message ?? e}`));
        return 1;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.allocateNextBeamioNfcNumber = allocateNextBeamioNfcNumber;
const getNfcBeamioNfcNumberByTagId = async (tagIdHex) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized))
        return null;
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT beamio_nfc_number FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`, [normalized]);
        const v = rows[0]?.beamio_nfc_number;
        if (v == null)
            return null;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcBeamioNfcNumberByTagId] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcBeamioNfcNumberByTagId = getNfcBeamioNfcNumberByTagId;
const setNfcCardBeamioNfcNumberIfUnset = async (tagIdHex, nfcNum) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(nfcNum) || nfcNum <= 0)
        return;
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        await db.query(`UPDATE nfc_cards SET beamio_nfc_number = $2 WHERE UPPER(TRIM(tag_id)) = $1 AND (beamio_nfc_number IS NULL OR beamio_nfc_number <= 0)`, [normalized, nfcNum]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[setNfcCardBeamioNfcNumberIfUnset] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.setNfcCardBeamioNfcNumberIfUnset = setNfcCardBeamioNfcNumberIfUnset;
const upsertNfcCardBeamioNfcNumberByTagId = async (tagIdHex, nfcNum) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized) || !Number.isFinite(nfcNum) || nfcNum <= 0)
        return;
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        await db.query(`UPDATE nfc_cards SET beamio_nfc_number = $2 WHERE UPPER(TRIM(tag_id)) = $1`, [normalized, nfcNum]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertNfcCardBeamioNfcNumberByTagId] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertNfcCardBeamioNfcNumberByTagId = upsertNfcCardBeamioNfcNumberByTagId;
/** NFC 自动 beamioTag：beamio_nfc_{N}（accountName 3–26，须链上未被他人占用） */
const buildBeamioNfcBeamioAccountName = (nfcNumber) => {
    const n = Math.floor(Number(nfcNumber));
    if (!Number.isFinite(n) || n <= 0)
        return '';
    const s = `beamio_nfc_${n}`;
    return BEAMIO_ACCOUNT_NAME_RE.test(s) ? s : '';
};
exports.buildBeamioNfcBeamioAccountName = buildBeamioNfcBeamioAccountName;
async function isBeamioAccountNameAvailableForWallet(reg, accountName, wallet) {
    if (!accountName || !BEAMIO_ACCOUNT_NAME_RE.test(accountName))
        return false;
    try {
        let ow;
        try {
            ow = await reg.getOwnerByAccountName(accountName);
        }
        catch (probeEx) {
            if ((0, exports.isOnchainEmptyResult)(probeEx))
                return true;
            throw probeEx;
        }
        if (!ow || ow === ethers_1.ethers.ZeroAddress)
            return true;
        return ow.toLowerCase() === wallet.toLowerCase();
    }
    catch {
        return false;
    }
}
/** 拉取链上 owner 校验；若已被占用则递增序号直至可用（最多 24 次）。 */
const resolveUniqueBeamioNfcAccountName = async (reg, wallet, tagIdHex) => {
    const tagRaw = tagIdHex != null ? String(tagIdHex).trim().replace(/^0x/i, '').toUpperCase() : '';
    const tagOk = tagRaw.length === 16 && /^[0-9A-F]+$/.test(tagRaw);
    let n = null;
    if (tagOk) {
        n = await (0, exports.getNfcBeamioNfcNumberByTagId)(tagRaw);
    }
    if (n == null) {
        n = await (0, exports.allocateNextBeamioNfcNumber)();
        if (tagOk)
            await (0, exports.setNfcCardBeamioNfcNumberIfUnset)(tagRaw, n);
    }
    for (let attempt = 0; attempt < 24; attempt++) {
        if (attempt > 0) {
            n = await (0, exports.allocateNextBeamioNfcNumber)();
            if (tagOk)
                await (0, exports.upsertNfcCardBeamioNfcNumberByTagId)(tagRaw, n);
        }
        const cand = (0, exports.buildBeamioNfcBeamioAccountName)(n);
        if (!cand)
            continue;
        if (await isBeamioAccountNameAvailableForWallet(reg, cand, wallet)) {
            return cand;
        }
    }
    return '';
};
exports.resolveUniqueBeamioNfcAccountName = resolveUniqueBeamioNfcAccountName;
function normalizeNfcLinkStateRow(state, hasPk) {
    if (!hasPk)
        return 'removed';
    const s = String(state ?? '').trim().toLowerCase();
    if (s === 'deactive')
        return 'deactive';
    return 'active';
}
/**
 * NFC 发起支付/充值/Link 等写操作前检查：DB 行存在且 deactive/removed 时拒绝；无行则不限制（兼容 mnemonic 路径，由私钥解析后续处理）。
 */
const getNfcCardSignedTxGateByTagId = async (tagIdHex) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized))
        return { ok: true };
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT private_key, nfc_link_state FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`, [normalized]);
        if (rows.length === 0)
            return { ok: true };
        const hasPk = rows[0].private_key != null && String(rows[0].private_key).trim() !== '';
        const st = normalizeNfcLinkStateRow(rows[0].nfc_link_state, hasPk);
        if (st === 'removed' || !hasPk)
            return { ok: false, code: 'NFC_CARD_UNLINKED', message: NFC_GATE_UNLINKED_MSG };
        if (st === 'deactive')
            return { ok: false, code: 'NFC_CARD_DEACTIVATED', message: NFC_GATE_DEACTIVATED_MSG };
        return { ok: true };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardSignedTxGateByTagId] failed: ${e?.message ?? e}`));
        return { ok: true };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcCardSignedTxGateByTagId = getNfcCardSignedTxGateByTagId;
const getNfcCardSignedTxGateByUid = async (uid) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalizedUid = String(uid || '').trim().toLowerCase();
    if (!normalizedUid)
        return { ok: true };
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT private_key, nfc_link_state FROM nfc_cards WHERE LOWER(TRIM(uid)) = $1 LIMIT 1`, [normalizedUid]);
        if (rows.length === 0)
            return { ok: true };
        const hasPk = rows[0].private_key != null && String(rows[0].private_key).trim() !== '';
        const st = normalizeNfcLinkStateRow(rows[0].nfc_link_state, hasPk);
        if (st === 'removed' || !hasPk)
            return { ok: false, code: 'NFC_CARD_UNLINKED', message: NFC_GATE_UNLINKED_MSG };
        if (st === 'deactive')
            return { ok: false, code: 'NFC_CARD_DEACTIVATED', message: NFC_GATE_DEACTIVATED_MSG };
        return { ok: true };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardSignedTxGateByUid] failed: ${e?.message ?? e}`));
        return { ok: true };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcCardSignedTxGateByUid = getNfcCardSignedTxGateByUid;
function nfcLinkStateBlocksPosAdmin(state) {
    const s = String(state ?? '').trim().toLowerCase();
    if (s === 'deactive')
        return 'deactive';
    if (s === 'removed')
        return 'removed';
    return null;
}
function posAdminGateFromNfcRow(row) {
    const blocked = nfcLinkStateBlocksPosAdmin(row.nfc_link_state);
    if (blocked === 'deactive') {
        return { ok: false, code: 'NFC_CARD_DEACTIVATED', message: NFC_GATE_DEACTIVATED_MSG };
    }
    if (blocked === 'removed') {
        const recipient = resolveNfcRecipientEoaFromRow(row.linked_owner_eoa, row.private_key);
        if (!recipient) {
            return { ok: false, code: 'NFC_CARD_UNLINKED', message: NFC_GATE_UNLINKED_MSG };
        }
        // Stale `removed` after re-provision: pk / linked owner still resolve an EOA
        // (Check Balance works; POS admin must not 403).
    }
    return { ok: true };
}
/**
 * POS terminal admin top-up / membership (executeForAdmin): block explicit deactive,
 * and removed only when no recipient EOA remains. Does NOT require private_key for
 * the happy path — POS signs with terminal admin. Re-provisioned cards may keep a
 * leftover `nfc_link_state='removed'` while still holding a server pk.
 */
const getNfcCardPosAdminGateByTagId = async (tagIdHex) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalized = String(tagIdHex || '').trim().toUpperCase();
    if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized))
        return { ok: true };
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT nfc_link_state, linked_owner_eoa, private_key FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`, [normalized]);
        if (rows.length === 0)
            return { ok: true };
        return posAdminGateFromNfcRow(rows[0]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardPosAdminGateByTagId] failed: ${e?.message ?? e}`));
        return { ok: true };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcCardPosAdminGateByTagId = getNfcCardPosAdminGateByTagId;
const getNfcCardPosAdminGateByUid = async (uid) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const normalizedUid = String(uid || '').trim().toLowerCase();
    if (!normalizedUid)
        return { ok: true };
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT nfc_link_state, linked_owner_eoa, private_key FROM nfc_cards WHERE LOWER(TRIM(uid)) = $1 LIMIT 1`, [normalizedUid]);
        if (rows.length === 0)
            return { ok: true };
        return posAdminGateFromNfcRow(rows[0]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardPosAdminGateByUid] failed: ${e?.message ?? e}`));
        return { ok: true };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcCardPosAdminGateByUid = getNfcCardPosAdminGateByUid;
/** 与 UI `wallet.signMessage(message)` 一致：键名排序后的 JSON 字符串。 */
function buildNfcCardLinkStateSignMessage(action, tagId16, issuedAtSec) {
    const tag = String(tagId16 || '')
        .trim()
        .replace(/^0x/i, '')
        .toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(tag)) {
        throw new Error('tagId must be 16 hex characters');
    }
    if (!Number.isFinite(issuedAtSec) || issuedAtSec <= 0) {
        throw new Error('issuedAt must be a positive Unix timestamp in seconds');
    }
    if (action !== 'active' && action !== 'deactive' && action !== 'remove') {
        throw new Error('action must be active, deactive, or remove');
    }
    const o = {
        action,
        issuedAt: Math.floor(issuedAtSec),
        scope: exports.NFC_CARD_LINK_STATE_SCOPE,
        tagId: tag,
    };
    return JSON.stringify(o, Object.keys(o).sort());
}
const applyNfcCardLinkStateChange = async (params) => {
    const msgRaw = String(params.message || '').trim();
    const sigRaw = String(params.signature || '').trim();
    if (!msgRaw || !sigRaw) {
        return { ok: false, error: 'Missing message or signature.', errorCode: 'MISSING_PARAMS' };
    }
    let parsed;
    try {
        parsed = JSON.parse(msgRaw);
    }
    catch {
        return { ok: false, error: 'Invalid message JSON.', errorCode: 'INVALID_JSON' };
    }
    const action = parsed.action;
    const issuedAt = parsed.issuedAt;
    const scope = parsed.scope;
    const tagIdRaw = parsed.tagId;
    if (action !== 'active' && action !== 'deactive' && action !== 'remove') {
        return { ok: false, error: 'Invalid action.', errorCode: 'INVALID_ACTION' };
    }
    if (scope !== exports.NFC_CARD_LINK_STATE_SCOPE) {
        return { ok: false, error: 'Invalid scope.', errorCode: 'INVALID_SCOPE' };
    }
    const tagUpper = String(tagIdRaw || '')
        .trim()
        .replace(/^0x/i, '')
        .toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(tagUpper)) {
        return { ok: false, error: 'Invalid tagId.', errorCode: 'INVALID_TAG_ID' };
    }
    if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
        return { ok: false, error: 'Invalid issuedAt.', errorCode: 'INVALID_ISSUED_AT' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Math.floor(issuedAt)) > 600) {
        return { ok: false, error: 'issuedAt expired or out of range.', errorCode: 'STALE_MESSAGE' };
    }
    let canonical;
    try {
        canonical = buildNfcCardLinkStateSignMessage(action, tagUpper, issuedAt);
    }
    catch (e) {
        return { ok: false, error: e?.message ?? 'Invalid payload', errorCode: 'INVALID_PAYLOAD' };
    }
    if (canonical !== msgRaw) {
        return {
            ok: false,
            error: 'Message must be canonical JSON (sorted keys: action, issuedAt, scope, tagId).',
            errorCode: 'NON_CANONICAL_MESSAGE',
        };
    }
    let recovered;
    try {
        recovered = ethers_1.ethers.verifyMessage(msgRaw, sigRaw);
    }
    catch {
        return { ok: false, error: 'Invalid signature.', errorCode: 'INVALID_SIGNATURE' };
    }
    const recoveredNorm = ethers_1.ethers.getAddress(recovered).toLowerCase();
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT private_key, linked_owner_eoa FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`, [tagUpper]);
        if (rows.length === 0) {
            return { ok: false, error: 'Card not found for tagId.', errorCode: 'NOT_FOUND' };
        }
        const pk = rows[0].private_key;
        const ownerCol = rows[0].linked_owner_eoa;
        if (!pk || !String(pk).trim()) {
            return { ok: false, error: 'Card has no bound private key.', errorCode: 'NOT_LINKED' };
        }
        if (!ownerCol || !String(ownerCol).trim()) {
            return { ok: false, error: 'Only user-linked cards can change link state this way.', errorCode: 'NOT_USER_LINKED' };
        }
        let pkAddr;
        try {
            pkAddr = ethers_1.ethers.getAddress(new ethers_1.ethers.Wallet(String(pk).trim()).address).toLowerCase();
        }
        catch {
            return { ok: false, error: 'Stored key is invalid.', errorCode: 'INVALID_STORED_KEY' };
        }
        const ownerNorm = ethers_1.ethers.getAddress(String(ownerCol).trim()).toLowerCase();
        if (pkAddr !== recoveredNorm || ownerNorm !== recoveredNorm) {
            return { ok: false, error: 'Signer does not match the card bound wallet.', errorCode: 'SIGNER_MISMATCH' };
        }
        if (action === 'remove') {
            await db.query(`UPDATE nfc_cards SET private_key = NULL, linked_owner_eoa = NULL, nfc_link_state = 'removed' WHERE UPPER(TRIM(tag_id)) = $1`, [tagUpper]);
        }
        else if (action === 'deactive') {
            await db.query(`UPDATE nfc_cards SET nfc_link_state = 'deactive' WHERE UPPER(TRIM(tag_id)) = $1`, [tagUpper]);
        }
        else {
            await db.query(`UPDATE nfc_cards SET nfc_link_state = 'active' WHERE UPPER(TRIM(tag_id)) = $1`, [tagUpper]);
        }
        return { ok: true, action, tagId: tagUpper };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.red(`[applyNfcCardLinkStateChange] ${e?.message ?? e}`));
        return { ok: false, error: e?.message ?? 'Database error.', errorCode: 'DB_ERROR' };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.applyNfcCardLinkStateChange = applyNfcCardLinkStateChange;
/** beamio_sun_counter_state 表：仅存 SUN 防重放状态，uid 对应最新成功通过验真的 counter。 */
const BEAMIO_SUN_COUNTER_STATE_TABLE = `CREATE TABLE IF NOT EXISTS beamio_sun_counter_state (
	id SERIAL PRIMARY KEY,
	uid TEXT UNIQUE NOT NULL,
	last_counter TEXT NOT NULL,
	updated_at TIMESTAMPTZ DEFAULT NOW()
)`;
/** nfc_link_app_sessions：Link App 进行中会话（Cluster/Master 共用 PG，替代进程内 Map） */
const NFC_LINK_APP_SESSIONS_TABLE = `CREATE TABLE IF NOT EXISTS nfc_link_app_sessions (
	tag_id_hex TEXT PRIMARY KEY,
	uid_hex TEXT NOT NULL,
	counter_hex TEXT NOT NULL,
	payer_eoa TEXT NOT NULL,
	aa_address TEXT NOT NULL,
	redeem_hash_bytes32 TEXT,
	chain_tx_hash TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	released_at TIMESTAMPTZ
)`;
const NFC_LINK_APP_SESSIONS_IDX_PAYER = `CREATE INDEX IF NOT EXISTS idx_nfc_link_app_sessions_active_payer ON nfc_link_app_sessions (LOWER(payer_eoa)) WHERE released_at IS NULL`;
const NFC_LINK_APP_SESSIONS_IDX_AA = `CREATE INDEX IF NOT EXISTS idx_nfc_link_app_sessions_active_aa ON nfc_link_app_sessions (LOWER(aa_address)) WHERE released_at IS NULL AND LOWER(TRIM(aa_address)) <> '0x0000000000000000000000000000000000000000'`;
const NFC_LINK_APP_SESSIONS_ADD_PLAINTEXT = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS link_redeem_plaintext TEXT`;
const NFC_LINK_APP_SESSIONS_ADD_PUBLIC = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS link_redeem_public TEXT`;
const NFC_LINK_APP_SESSIONS_ADD_AUTO_CANCEL_AT = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS auto_cancel_at TIMESTAMPTZ`;
const NFC_LINK_APP_SESSIONS_IDX_AUTO_CANCEL = `CREATE INDEX IF NOT EXISTS idx_nfc_link_app_sessions_auto_cancel ON nfc_link_app_sessions (auto_cancel_at) WHERE released_at IS NULL AND auto_cancel_at IS NOT NULL`;
const NFC_LINK_APP_SESSIONS_ADD_MIGRATE_VIA_CONTAINER = `ALTER TABLE nfc_link_app_sessions ADD COLUMN IF NOT EXISTS migrate_via_container BOOLEAN NOT NULL DEFAULT FALSE`;
/** ai_learning_feedback 表：AI 学习反馈，共享给所有 Beamio 用户。kind: approved=满意, corrected=纠正 */
const AI_LEARNING_FEEDBACK_TABLE = `CREATE TABLE IF NOT EXISTS ai_learning_feedback (
	id SERIAL PRIMARY KEY,
	kind TEXT NOT NULL,
	user_input TEXT NOT NULL,
	action_json JSONB NOT NULL,
	custom_rule TEXT,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`;
/** 插入 AI 学习反馈。correctedAction：Beamio 提供的期望 action（用于 UI 学习，存入 custom_rule 的 JSON） */
const insertAiLearningFeedback = async (kind, userInput, actionJson, customRule, correctedAction) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(AI_LEARNING_FEEDBACK_TABLE);
        // correctedAction 时：custom_rule 存 JSON {_correctedAction: action}，供 prompt 解析
        const ruleVal = correctedAction
            ? JSON.stringify({ _correctedAction: correctedAction })
            : (customRule ?? null);
        await db.query(`INSERT INTO ai_learning_feedback (kind, user_input, action_json, custom_rule) VALUES ($1, $2, $3, $4)`, [kind, String(userInput || '').trim().slice(0, 500), JSON.stringify(actionJson), ruleVal]);
        return true;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[insertAiLearningFeedback] failed: ${e?.message ?? e}`));
        return false;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.insertAiLearningFeedback = insertAiLearningFeedback;
/** 获取所有 AI 学习反馈（共享给所有用户，取最近 50 条） */
const getAiLearningFeedback = async () => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(AI_LEARNING_FEEDBACK_TABLE);
        const { rows } = await db.query(`SELECT kind, user_input, action_json, custom_rule FROM ai_learning_feedback ORDER BY created_at DESC LIMIT 50`);
        return rows.map((r) => ({
            kind: r.kind,
            user_input: r.user_input,
            action_json: r.action_json ?? {},
            custom_rule: r.custom_rule,
        }));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getAiLearningFeedback] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getAiLearningFeedback = getAiLearningFeedback;
/** 根据 UID 查询 NFC 卡状态（不返回 private_key）；若已登记则从 private_key 推导 address 返回 */
const getNfcCardByUid = async (uid) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const normalizedUid = String(uid || '').trim().toLowerCase();
        if (!normalizedUid)
            return { registered: false };
        const { rows } = await db.query(`SELECT private_key FROM nfc_cards WHERE LOWER(uid) = $1 LIMIT 1`, [normalizedUid]);
        if (rows.length === 0)
            return { registered: false };
        const pk = rows[0].private_key;
        if (pk == null || String(pk).trim() === '')
            return { registered: false };
        try {
            const wallet = new ethers_1.ethers.Wallet(pk);
            const address = await wallet.getAddress();
            return { registered: true, address };
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardByUid] derive address failed: ${e?.message ?? e}`));
            return { registered: true };
        }
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardByUid] failed: ${e?.message ?? e}`));
        return { registered: false };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcCardByUid = getNfcCardByUid;
/** 服务端专用：根据 UID 获取 private_key（仅 Master 支付流程使用，不返回客户端）。若 DB 无则从 mnemonic 派生，与 getNfcRecipientAddressByUid / nfcTopup 一致 */
const getNfcCardPrivateKeyByUid = async (uid) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const normalizedUid = String(uid || '').trim().toLowerCase();
        if (!normalizedUid)
            return null;
        const { rows } = await db.query(`SELECT private_key FROM nfc_cards WHERE LOWER(uid) = $1 LIMIT 1`, [normalizedUid]);
        if (rows.length > 0) {
            const pk = rows[0].private_key;
            if (pk != null && String(pk).trim() !== '')
                return String(pk).trim();
            return null;
        }
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardPrivateKeyByUid] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
    // DB 无则从 mnemonic 派生（与 getNfcRecipientAddressByUid 一致）
    const mnemonic = util_2.masterSetup?.cryptoPayWallet;
    if (!mnemonic || typeof mnemonic !== 'string')
        return null;
    const uidNorm = String(uid || '').trim().toLowerCase();
    if (!uidNorm || !/^[0-9a-f]+$/i.test(uidNorm))
        return null;
    const uidHex = uidNorm.padStart(14, '0').slice(-14);
    try {
        const uidBytes = ethers_1.ethers.getBytes('0x' + uidHex);
        const hash = ethers_1.ethers.keccak256(uidBytes);
        const offset = Number(BigInt(hash) % (2n ** 31n));
        const path = `m/44'/60'/0'/0/${offset}`;
        const derived = ethers_1.ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), path);
        return derived.privateKey;
    }
    catch {
        return null;
    }
};
exports.getNfcCardPrivateKeyByUid = getNfcCardPrivateKeyByUid;
/** 根据 TagID（SUN 解密得到的 16 hex）获取 NFC 卡对应的 private_key。仅查 DB，TagID 未登记则返回 null（非法卡）。供 Charge 流程用卡私钥签名。 */
const getNfcCardPrivateKeyByTagId = async (tagIdHex) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const normalized = String(tagIdHex || '').trim().toUpperCase();
        if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized))
            return null;
        const { rows } = await db.query(`SELECT private_key FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`, [normalized]);
        if (rows.length === 0)
            return null;
        const pk = rows[0].private_key;
        if (pk == null || String(pk).trim() === '')
            return null;
        return String(pk).trim();
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcCardPrivateKeyByTagId] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcCardPrivateKeyByTagId = getNfcCardPrivateKeyByTagId;
/** User-linked NFC cards may have linked_owner_eoa without a server-held private_key (Link App bind). */
function resolveNfcRecipientEoaFromRow(linkedOwnerEoa, privateKey) {
    const ownerCol = linkedOwnerEoa != null ? String(linkedOwnerEoa).trim() : '';
    if (ownerCol && ethers_1.ethers.isAddress(ownerCol)) {
        return ethers_1.ethers.getAddress(ownerCol);
    }
    const pk = privateKey != null ? String(privateKey).trim() : '';
    if (!pk)
        return null;
    try {
        return ethers_1.ethers.getAddress(new ethers_1.ethers.Wallet(pk).address);
    }
    catch {
        return null;
    }
}
/** 根据 TagID（SUN 解密得到的 16 hex）获取 NFC 卡对应的 recipient EOA。仅查 DB，TagID 未登记则返回 null（非法卡）。 */
const getNfcRecipientAddressByTagId = async (tagIdHex) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const normalized = String(tagIdHex || '').trim().toUpperCase();
        if (!normalized || normalized.length !== 16 || !/^[0-9A-F]+$/.test(normalized))
            return null;
        const { rows } = await db.query(`SELECT private_key, linked_owner_eoa FROM nfc_cards WHERE UPPER(TRIM(tag_id)) = $1 LIMIT 1`, [normalized]);
        if (rows.length === 0)
            return null;
        return resolveNfcRecipientEoaFromRow(rows[0].linked_owner_eoa, rows[0].private_key);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNfcRecipientAddressByTagId] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNfcRecipientAddressByTagId = getNfcRecipientAddressByTagId;
function normalizeTagIdHexForLinkSession(raw) {
    return String(raw || '').trim().replace(/^0x/i, '').toLowerCase();
}
async function ensureNfcLinkAppSessionsSchema(db) {
    await db.query(NFC_LINK_APP_SESSIONS_TABLE);
    await db.query(NFC_LINK_APP_SESSIONS_ADD_PLAINTEXT);
    await db.query(NFC_LINK_APP_SESSIONS_ADD_PUBLIC);
    await db.query(NFC_LINK_APP_SESSIONS_ADD_AUTO_CANCEL_AT);
    await db.query(NFC_LINK_APP_SESSIONS_ADD_MIGRATE_VIA_CONTAINER);
    await db.query(NFC_LINK_APP_SESSIONS_IDX_AUTO_CANCEL);
    await db.query(NFC_LINK_APP_SESSIONS_IDX_PAYER);
    await db.query(NFC_LINK_APP_SESSIONS_IDX_AA);
}
function rowToNfcLinkSession(r) {
    const h = r.redeem_hash_bytes32;
    const plain = r.link_redeem_plaintext;
    const pub = r.link_redeem_public;
    const ac = r.auto_cancel_at;
    let autoCancelAt = null;
    if (ac != null) {
        autoCancelAt = ac instanceof Date ? ac : new Date(ac);
        if (Number.isNaN(autoCancelAt.getTime()))
            autoCancelAt = null;
    }
    return {
        tagIdHex: r.tag_id_hex,
        uid: r.uid_hex,
        counterHex: r.counter_hex,
        payerEoa: ethers_1.ethers.getAddress(r.payer_eoa),
        aaAddress: ethers_1.ethers.getAddress(r.aa_address),
        redeemHashBytes32: h && String(h).length > 0 ? String(h) : null,
        chainTxHash: r.chain_tx_hash,
        linkRedeemPlaintext: plain != null && String(plain).length > 0 ? String(plain) : null,
        linkRedeemPublic: pub != null && String(pub).length > 0 ? String(pub) : null,
        autoCancelAt,
        migrateViaContainer: Boolean(r.migrate_via_container),
    };
}
/** 写入或刷新当前 tag 的 Link App 活跃会话（released_at 置空） */
const upsertActiveNfcLinkAppSession = async (rec) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcLinkAppSessionsSchema(db);
        const tag = normalizeTagIdHexForLinkSession(rec.tagIdHex);
        if (!tag || tag.length !== 16 || !/^[0-9a-f]+$/.test(tag)) {
            throw new Error('Invalid tagIdHex for nfc link session');
        }
        const payer = ethers_1.ethers.getAddress(rec.payerEoa).toLowerCase();
        const aa = ethers_1.ethers.getAddress(rec.aaAddress).toLowerCase();
        const ctr = String(rec.counterHex || '').trim().toLowerCase();
        const rh = rec.redeemHashBytes32 ? String(rec.redeemHashBytes32).toLowerCase() : null;
        const ctx = rec.chainTxHash ? String(rec.chainTxHash).trim() : null;
        const plain = rec.linkRedeemPlaintext != null && String(rec.linkRedeemPlaintext).length > 0 ? String(rec.linkRedeemPlaintext) : null;
        const pub = rec.linkRedeemPublic != null && String(rec.linkRedeemPublic).length > 0 ? String(rec.linkRedeemPublic) : null;
        const mvc = Boolean(rec.migrateViaContainer);
        await db.query(`INSERT INTO nfc_link_app_sessions (tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, migrate_via_container, released_at, auto_cancel_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NOW() + INTERVAL '5 minutes')
			ON CONFLICT (tag_id_hex) DO UPDATE SET
				uid_hex = EXCLUDED.uid_hex,
				counter_hex = EXCLUDED.counter_hex,
				payer_eoa = EXCLUDED.payer_eoa,
				aa_address = EXCLUDED.aa_address,
				redeem_hash_bytes32 = EXCLUDED.redeem_hash_bytes32,
				chain_tx_hash = EXCLUDED.chain_tx_hash,
				link_redeem_plaintext = EXCLUDED.link_redeem_plaintext,
				link_redeem_public = EXCLUDED.link_redeem_public,
				migrate_via_container = EXCLUDED.migrate_via_container,
				released_at = NULL,
				auto_cancel_at = NOW() + INTERVAL '5 minutes',
				created_at = NOW()`, [tag, rec.uid.trim(), ctr, payer, aa, rh, ctx, plain, pub, mvc]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertActiveNfcLinkAppSession] failed: ${e?.message ?? e}`));
        throw e;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertActiveNfcLinkAppSession = upsertActiveNfcLinkAppSession;
/** 按 tag → AA → payer 顺序查找未释放会话，供付款拦截与校验 */
const fetchActiveNfcLinkAppSessionForPaymentBlock = async (opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcLinkAppSessionsSchema(db);
        if (opts.tagIdHex) {
            const tag = normalizeTagIdHexForLinkSession(opts.tagIdHex);
            if (tag) {
                const { rows } = await db.query(`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
					FROM nfc_link_app_sessions WHERE tag_id_hex = $1 AND released_at IS NULL LIMIT 1`, [tag]);
                if (rows[0])
                    return rowToNfcLinkSession(rows[0]);
            }
        }
        if (opts.aaAddress && ethers_1.ethers.isAddress(opts.aaAddress)) {
            const aa = ethers_1.ethers.getAddress(opts.aaAddress).toLowerCase();
            if (aa !== ethers_1.ethers.ZeroAddress.toLowerCase()) {
                const { rows } = await db.query(`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
					FROM nfc_link_app_sessions WHERE LOWER(TRIM(aa_address)) = $1 AND released_at IS NULL LIMIT 1`, [aa]);
                if (rows[0])
                    return rowToNfcLinkSession(rows[0]);
            }
        }
        if (opts.payerEoa && ethers_1.ethers.isAddress(opts.payerEoa)) {
            const pay = ethers_1.ethers.getAddress(opts.payerEoa).toLowerCase();
            const { rows } = await db.query(`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
				FROM nfc_link_app_sessions WHERE LOWER(TRIM(payer_eoa)) = $1 AND released_at IS NULL LIMIT 1`, [pay]);
            if (rows[0])
                return rowToNfcLinkSession(rows[0]);
        }
        return null;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[fetchActiveNfcLinkAppSessionForPaymentBlock] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.fetchActiveNfcLinkAppSessionForPaymentBlock = fetchActiveNfcLinkAppSessionForPaymentBlock;
/** 链上 redeem 已结束或业务清会话：按 tag 标记释放 */
const markNfcLinkAppSessionReleasedByTag = async (tagIdHex) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcLinkAppSessionsSchema(db);
        const tag = normalizeTagIdHexForLinkSession(tagIdHex);
        if (!tag)
            return;
        await db.query(`UPDATE nfc_link_app_sessions SET released_at = NOW(), auto_cancel_at = NULL WHERE tag_id_hex = $1 AND released_at IS NULL`, [tag]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[markNfcLinkAppSessionReleasedByTag] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.markNfcLinkAppSessionReleasedByTag = markNfcLinkAppSessionReleasedByTag;
/** Master 定时任务：已到 auto_cancel_at 且仍锁定的会话（POST /api/nfcLinkApp 后 5 分钟自动解锁） */
const listNfcLinkAppSessionsDueForAutoCancel = async (limit = 12) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcLinkAppSessionsSchema(db);
        const lim = Math.min(Math.max(1, Math.floor(limit)), 50);
        const { rows } = await db.query(`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
			FROM nfc_link_app_sessions
			WHERE released_at IS NULL
			  AND auto_cancel_at IS NOT NULL
			  AND auto_cancel_at <= NOW()
			ORDER BY auto_cancel_at ASC
			LIMIT $1`, [lim]);
        return rows.map((r) => rowToNfcLinkSession(r));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listNfcLinkAppSessionsDueForAutoCancel] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listNfcLinkAppSessionsDueForAutoCancel = listNfcLinkAppSessionsDueForAutoCancel;
/** App 完成 Link 后释放会话（校验 tag/uid/counter） */
const releaseNfcLinkAppSessionIfMatches = async (body) => {
    const tag = String(body.tagid || '').trim().replace(/^0x/i, '').toLowerCase();
    const uid = String(body.uid || '').trim();
    if (!tag || !uid)
        return { ok: false, error: 'Missing tagid or uid.' };
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcLinkAppSessionsSchema(db);
        const { rows } = await db.query(`SELECT tag_id_hex, uid_hex, counter_hex, payer_eoa, aa_address, redeem_hash_bytes32, chain_tx_hash, link_redeem_plaintext, link_redeem_public, auto_cancel_at, migrate_via_container
			FROM nfc_link_app_sessions WHERE tag_id_hex = $1 AND released_at IS NULL LIMIT 1`, [tag]);
        if (!rows[0])
            return { ok: false, error: 'No active link session for this tag.' };
        const rec = rowToNfcLinkSession(rows[0]);
        if (rec.uid.trim().toLowerCase() !== uid.trim().toLowerCase())
            return { ok: false, error: 'uid mismatch.' };
        const ctr = body.counter;
        const ctrNum = typeof ctr === 'number' && Number.isFinite(ctr) ? ctr : parseInt(String(ctr ?? ''), 10);
        const expected = parseInt(rec.counterHex, 16);
        if (!Number.isFinite(ctrNum) || ctrNum !== expected)
            return { ok: false, error: 'counter mismatch.' };
        await db.query(`UPDATE nfc_link_app_sessions SET released_at = NOW(), auto_cancel_at = NULL WHERE tag_id_hex = $1 AND released_at IS NULL`, [tag]);
        return { ok: true };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[releaseNfcLinkAppSessionIfMatches] failed: ${e?.message ?? e}`));
        return { ok: false, error: 'Database error.' };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.releaseNfcLinkAppSessionIfMatches = releaseNfcLinkAppSessionIfMatches;
/** TagID 是否已登记（合法卡） */
const isTagIdRegistered = async (tagIdHex) => {
    const addr = await (0, exports.getNfcRecipientAddressByTagId)(tagIdHex);
    return addr != null;
};
exports.isTagIdRegistered = isTagIdRegistered;
/**
 * Legacy rows may exist with uid + private_key but tag_id NULL.
 * Attach SUN TagID without rotating the card private key.
 */
const backfillNfcCardTagIdByUid = async (params) => {
    const uid = String(params.uid || '').trim();
    const tagUpper = String(params.tagIdHex || '')
        .trim()
        .replace(/^0x/i, '')
        .toUpperCase();
    if (!uid || tagUpper.length !== 16 || !/^[0-9A-F]+$/.test(tagUpper))
        return false;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(NFC_CARDS_TABLE);
        await db.query(NFC_CARDS_ADD_TAG_ID);
        const r = await db.query(`UPDATE nfc_cards SET tag_id = $2
			 WHERE LOWER(TRIM(uid)) = LOWER(TRIM($1))
			   AND (tag_id IS NULL OR TRIM(tag_id) = '')
			   AND private_key IS NOT NULL AND TRIM(private_key) <> ''`, [uid, tagUpper]);
        const n = typeof r.rowCount === 'number' ? r.rowCount : 0;
        if (n > 0) {
            (0, logger_1.logger)(safe_1.default.green(`[backfillNfcCardTagIdByUid] uid=${uid.slice(0, 14)}... tagId=${tagUpper.slice(0, 8)}...`));
        }
        return n > 0;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[backfillNfcCardTagIdByUid] failed: ${e?.message ?? e}`));
        return false;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.backfillNfcCardTagIdByUid = backfillNfcCardTagIdByUid;
/** 根据 TagID 查找或创建钱包。若已登记则返回 EOA；若未登记则创建新 EOA、登记到 nfc_cards（tag_id 为主键语义）。uidHex 可选，仅兼容旧客户端；缺省时用 tagIdHex 作为 DB uid 列值。 */
const provisionOrGetNfcWalletByTagId = async (tagIdHex, uidHex) => {
    const existing = await (0, exports.getNfcRecipientAddressByTagId)(tagIdHex);
    if (existing)
        return { eoa: existing, wasNewlyProvisioned: false };
    const uidTrim = uidHex?.trim() || '';
    // Legacy: card registered by UID only — bind TagID, keep existing private_key (do not rotate).
    if (uidTrim) {
        const byUidPk = await (0, exports.getNfcCardPrivateKeyByUid)(uidTrim);
        if (byUidPk) {
            await (0, exports.backfillNfcCardTagIdByUid)({ uid: uidTrim, tagIdHex });
            const afterBackfill = await (0, exports.getNfcRecipientAddressByTagId)(tagIdHex);
            if (afterBackfill) {
                (0, logger_1.logger)(safe_1.default.cyan(`[provisionOrGetNfcWalletByTagId] backfilled tagId for uid=${uidTrim.slice(0, 14)}... eoa=${afterBackfill}`));
                return { eoa: afterBackfill, wasNewlyProvisioned: false };
            }
        }
    }
    // User-linked card row may exist with linked_owner_eoa but no private_key — never rotate to a new EOA.
    const linkedOwnerOnly = await (0, exports.getNfcRecipientAddressByTagId)(tagIdHex);
    if (linkedOwnerOnly) {
        return { eoa: linkedOwnerOnly, wasNewlyProvisioned: false };
    }
    const wallet = ethers_1.ethers.Wallet.createRandom();
    await (0, exports.registerNfcCardToDb)({
        uid: uidTrim || tagIdHex.trim(),
        privateKey: wallet.privateKey,
        tagId: tagIdHex
    });
    const after = await (0, exports.getNfcRecipientAddressByTagId)(tagIdHex);
    const eoa = after ?? (await wallet.getAddress());
    const wasNewlyProvisioned = true;
    (0, logger_1.logger)(safe_1.default.green(`[provisionOrGetNfcWalletByTagId] provisioned EOA ${eoa} for tagId=${tagIdHex.slice(0, 8)}...`));
    return { eoa, wasNewlyProvisioned };
};
exports.provisionOrGetNfcWalletByTagId = provisionOrGetNfcWalletByTagId;
/** 根据 UID 获取 NFC 卡对应的 recipient EOA 地址（用于 mintPointsByAdmin 的 to 参数）。若 DB 无则从 mnemonic 派生，不写入 DB。 */
const getNfcRecipientAddressByUid = async (uid) => {
    const normalizedUidRow = String(uid || '').trim().toLowerCase();
    if (normalizedUidRow && /^[0-9a-f]+$/i.test(normalizedUidRow)) {
        const db = new pg_1.Client({ connectionString: DB_URL });
        try {
            await db.connect();
            await ensureNfcCardsExtendedSchema(db);
            const { rows } = await db.query(`SELECT private_key, linked_owner_eoa FROM nfc_cards WHERE LOWER(TRIM(uid)) = $1 LIMIT 1`, [normalizedUidRow]);
            if (rows.length > 0) {
                const resolved = resolveNfcRecipientEoaFromRow(rows[0].linked_owner_eoa, rows[0].private_key);
                if (resolved)
                    return resolved;
            }
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[getNfcRecipientAddressByUid] db read: ${e?.message ?? e}`));
        }
        finally {
            await db.end().catch(() => { });
        }
    }
    let privateKey = await (0, exports.getNfcCardPrivateKeyByUid)(uid);
    if (privateKey) {
        try {
            const wallet = new ethers_1.ethers.Wallet(privateKey);
            return await wallet.getAddress();
        }
        catch {
            return null;
        }
    }
    const mnemonic = util_2.masterSetup?.cryptoPayWallet;
    if (!mnemonic || typeof mnemonic !== 'string')
        return null;
    const normalizedUid = String(uid || '').trim().toLowerCase();
    if (!/^[0-9a-f]+$/i.test(normalizedUid))
        return null;
    const uidHex = normalizedUid.padStart(14, '0').slice(-14);
    try {
        const uidBytes = ethers_1.ethers.getBytes('0x' + uidHex);
        const hash = ethers_1.ethers.keccak256(uidBytes);
        const offset = Number(BigInt(hash) % (2n ** 31n));
        const path = `m/44'/60'/0'/0/${offset}`;
        const derived = ethers_1.ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), path);
        const wallet = new ethers_1.ethers.Wallet(derived.privateKey);
        return await wallet.getAddress();
    }
    catch {
        return null;
    }
};
exports.getNfcRecipientAddressByUid = getNfcRecipientAddressByUid;
/** 登记 NFC 卡到 DB（uid + private_key；tag_id 可选，SUN 解密得到的 TagID，用于合法性校验）。 */
const registerNfcCardToDb = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(NFC_CARDS_TABLE);
        await db.query(NFC_CARDS_ADD_TAG_ID);
        const uid = String(params.uid || '').trim();
        const privateKey = String(params.privateKey || '').trim();
        const tagId = params.tagId ? String(params.tagId).trim().toUpperCase() : null;
        if (!uid || !privateKey)
            return;
        if (tagId && tagId.length === 16 && /^[0-9A-F]+$/.test(tagId)) {
            // Legacy rows may have tag_id set but empty private_key (uid=tagId hex). Fill pk on tag_id before uid INSERT.
            const filledByTag = await db.query(`UPDATE nfc_cards SET
					private_key = $1,
					nfc_link_state = 'active',
					uid = CASE
						WHEN LENGTH(TRIM($2)) = 14 AND $2 ~ '^[0-9A-Fa-f]{14}$' THEN $2
						ELSE uid
					END
				WHERE UPPER(TRIM(tag_id)) = $3
					AND (private_key IS NULL OR TRIM(private_key) = '')`, [privateKey, uid, tagId]);
            if ((filledByTag.rowCount ?? 0) > 0) {
                (0, logger_1.logger)(safe_1.default.green(`[registerNfcCardToDb] filled empty pk on tagId=${tagId.slice(0, 8)}... uid=${uid.slice(0, 14)}...`));
                return;
            }
            // Never rotate an existing private_key on uid conflict (would orphan card assets).
            // Only fill empty private_key / missing tag_id.
            await db.query(`INSERT INTO nfc_cards (uid, private_key, tag_id, nfc_link_state) VALUES ($1, $2, $3, 'active')
				ON CONFLICT (uid) DO UPDATE SET
					private_key = CASE
						WHEN nfc_cards.private_key IS NOT NULL AND TRIM(nfc_cards.private_key) <> '' THEN nfc_cards.private_key
						ELSE EXCLUDED.private_key
					END,
					nfc_link_state = CASE
						WHEN nfc_cards.private_key IS NOT NULL AND TRIM(nfc_cards.private_key) <> '' THEN nfc_cards.nfc_link_state
						ELSE 'active'
					END,
					tag_id = COALESCE(NULLIF(TRIM(nfc_cards.tag_id), ''), EXCLUDED.tag_id)`, [uid, privateKey, tagId]);
            (0, logger_1.logger)(safe_1.default.green(`[registerNfcCardToDb] registered uid=${uid.slice(0, 16)}... tagId=${tagId.slice(0, 8)}...`));
        }
        else {
            await db.query(`INSERT INTO nfc_cards (uid, private_key) VALUES ($1, $2)
				ON CONFLICT (uid) DO UPDATE SET private_key = EXCLUDED.private_key`, [uid, privateKey]);
            (0, logger_1.logger)(safe_1.default.green(`[registerNfcCardToDb] registered uid=${uid.slice(0, 16)}...`));
        }
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[registerNfcCardToDb] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.registerNfcCardToDb = registerNfcCardToDb;
/**
 * Link App 完成后：按 TagID 将 nfc_cards 的私钥替换为用户钱包私钥，并同步 uid（SUN 14 hex）。
 * 先 UPDATE tag_id 命中行；若无行则 INSERT（新卡首次绑定用户密钥）。
 * [linkedOwnerEoa] 写入 linked_owner_eoa，供 listLinkedNfcCards 按 EOA 查询。
 */
const replaceNfcCardKeyByTagId = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const tagUpper = String(params.tagIdHex || '').trim().replace(/^0x/i, '').toUpperCase();
    const pk = String(params.privateKey || '').trim();
    const uid = String(params.uidHex || '').trim().toLowerCase();
    let ownerEoaLower;
    try {
        ownerEoaLower = ethers_1.ethers.getAddress(String(params.linkedOwnerEoa || '').trim()).toLowerCase();
    }
    catch {
        throw new Error('replaceNfcCardKeyByTagId: invalid linkedOwnerEoa');
    }
    if (!tagUpper || tagUpper.length !== 16 || !/^[0-9A-F]+$/.test(tagUpper) || !pk || !uid) {
        throw new Error('replaceNfcCardKeyByTagId: invalid tagIdHex, privateKey, or uidHex');
    }
    try {
        await db.connect();
        await db.query(NFC_CARDS_TABLE);
        await db.query(NFC_CARDS_ADD_TAG_ID);
        await db.query(NFC_CARDS_ADD_LINKED_OWNER);
        await db.query(NFC_CARDS_IDX_LINKED_OWNER);
        await db.query(NFC_CARDS_ADD_LINK_STATE);
        const up = await db.query(`UPDATE nfc_cards SET private_key = $1, uid = $2, linked_owner_eoa = $4, nfc_link_state = 'active' WHERE UPPER(TRIM(tag_id)) = $3`, [pk, uid, tagUpper, ownerEoaLower]);
        if ((up.rowCount ?? 0) > 0)
            return;
        await db.query(`INSERT INTO nfc_cards (uid, private_key, tag_id, linked_owner_eoa, nfc_link_state) VALUES ($1, $2, $3, $4, 'active')
			ON CONFLICT (tag_id) DO UPDATE SET
				private_key = EXCLUDED.private_key,
				uid = EXCLUDED.uid,
				linked_owner_eoa = EXCLUDED.linked_owner_eoa,
				nfc_link_state = 'active'`, [uid, pk, tagUpper, ownerEoaLower]);
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.replaceNfcCardKeyByTagId = replaceNfcCardKeyByTagId;
/** 按用户 EOA 列出已通过 Link App 绑定到该钱包的 NFC（返回 uid 14 hex、tagId 16 hex、linkState；不含私钥） */
const listLinkedNfcCardsByOwnerEoa = async (ownerEoa) => {
    let eoaNorm;
    try {
        eoaNorm = ethers_1.ethers.getAddress(String(ownerEoa || '').trim()).toLowerCase();
    }
    catch {
        return [];
    }
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureNfcCardsExtendedSchema(db);
        const { rows } = await db.query(`SELECT uid, tag_id, nfc_link_state FROM nfc_cards
			 WHERE linked_owner_eoa IS NOT NULL AND LOWER(TRIM(linked_owner_eoa)) = $1
			 AND tag_id IS NOT NULL AND TRIM(tag_id) <> ''
			 AND private_key IS NOT NULL AND TRIM(COALESCE(private_key, '')) <> ''
			 AND COALESCE(NULLIF(LOWER(TRIM(nfc_link_state)), ''), 'active') <> 'removed'
			 ORDER BY id ASC`, [eoaNorm]);
        return rows.map((r) => ({
            uid: String(r.uid || '').replace(/^0x/i, '').toLowerCase(),
            tagId: String(r.tag_id || '').replace(/^0x/i, '').toUpperCase(),
            linkState: String(r.nfc_link_state || '').trim().toLowerCase() === 'deactive' ? 'deactive' : 'active',
        }));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listLinkedNfcCardsByOwnerEoa] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listLinkedNfcCardsByOwnerEoa = listLinkedNfcCardsByOwnerEoa;
const getBeamioSunLastCounterByUid = async (uid) => {
    const state = await (0, exports.getBeamioSunLastCounterStateByUid)(uid);
    return state?.lastCounterHex ?? null;
};
exports.getBeamioSunLastCounterByUid = getBeamioSunLastCounterByUid;
/** 返回 lastCounter 与 updated_at，供 counter 防重放 + 同 tap 短时 grace 使用 */
const getBeamioSunLastCounterStateByUid = async (uid) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_SUN_COUNTER_STATE_TABLE);
        const normalizedUid = String(uid || '').trim().toLowerCase();
        if (!normalizedUid)
            return null;
        const { rows } = await db.query(`SELECT last_counter, updated_at FROM beamio_sun_counter_state WHERE LOWER(uid) = $1 LIMIT 1`, [normalizedUid]);
        const r = rows[0];
        if (!r?.last_counter)
            return null;
        return {
            lastCounterHex: String(r.last_counter).trim().toUpperCase(),
            updatedAt: r.updated_at
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getBeamioSunLastCounterStateByUid] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getBeamioSunLastCounterStateByUid = getBeamioSunLastCounterStateByUid;
const upsertBeamioSunLastCounterByUid = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_SUN_COUNTER_STATE_TABLE);
        const uid = String(params.uid || '').trim().toLowerCase();
        const lastCounterHex = String(params.lastCounterHex || '').trim().toUpperCase();
        if (!uid || !lastCounterHex)
            return;
        await db.query(`
			INSERT INTO beamio_sun_counter_state (uid, last_counter, updated_at)
			VALUES ($1, $2, NOW())
			ON CONFLICT (uid) DO UPDATE SET
				last_counter = EXCLUDED.last_counter,
				updated_at = NOW()
			`, [uid, lastCounterHex]);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertBeamioSunLastCounterByUid] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertBeamioSunLastCounterByUid = upsertBeamioSunLastCounterByUid;
/** Deep-merge metadata_json patch into an existing beamio_cards row (shareTokenMetadata shallow-merged). */
function mergeBeamioCardMetadataJsonPatch(existing, patch, options) {
    const base = existing != null && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
    const patchShare = patch.shareTokenMetadata != null &&
        typeof patch.shareTokenMetadata === 'object' &&
        !Array.isArray(patch.shareTokenMetadata)
        ? patch.shareTokenMetadata
        : null;
    const baseShare = base.shareTokenMetadata != null &&
        typeof base.shareTokenMetadata === 'object' &&
        !Array.isArray(base.shareTokenMetadata)
        ? base.shareTokenMetadata
        : {};
    const merged = { ...base, ...patch };
    if (patchShare) {
        if (options?.preferExistingShareTokenMetadata && Object.keys(baseShare).length > 0) {
            // Late createCard register must not wipe Promotion / Reward PT written after HTTP 200.
            merged.shareTokenMetadata = { ...patchShare, ...baseShare };
        }
        else {
            // Authoritative full share snapshot from metadata file merge — replace nested object
            // so cleared keys (e.g. topupPromotion) are not resurrected from DB stale rows.
            merged.shareTokenMetadata = { ...patchShare };
        }
    }
    else if (Object.keys(baseShare).length > 0) {
        merged.shareTokenMetadata = { ...baseShare };
    }
    if (patch.tiers === undefined && base.tiers !== undefined)
        merged.tiers = base.tiers;
    if (patch.baseMembership === undefined && base.baseMembership !== undefined) {
        merged.baseMembership = base.baseMembership;
    }
    if (patch.upgradeType === undefined && base.upgradeType !== undefined) {
        merged.upgradeType = base.upgradeType;
    }
    if (patch.transferWhitelistEnabled === undefined && base.transferWhitelistEnabled !== undefined) {
        merged.transferWhitelistEnabled = base.transferWhitelistEnabled;
    }
    return merged;
}
function serializeBeamioCardMetadataJson(meta) {
    if (Object.keys(meta).length === 0)
        return null;
    try {
        return JSON.stringify(meta, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.yellow(`[registerCardToDb] metadata JSON stringify failed: ${msg}`));
        return null;
    }
}
/** createCard 成功后登记到本地 DB */
const registerCardToDb = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_CARDS_TABLE);
        const addrLower = params.cardAddress.toLowerCase();
        const existingRes = await db.query(`SELECT metadata_json FROM beamio_cards WHERE card_address = $1 LIMIT 1`, [addrLower]);
        const existingMeta = existingRes.rows[0]?.metadata_json ?? null;
        const patchJson = {
            ...(params.shareTokenMetadata && { shareTokenMetadata: params.shareTokenMetadata }),
            ...(params.tiers && params.tiers.length > 0 && { tiers: params.tiers }),
            ...(params.baseMembership && { baseMembership: params.baseMembership }),
            ...(params.upgradeType != null && { upgradeType: params.upgradeType }),
            ...(typeof params.transferWhitelistEnabled === 'boolean' && {
                transferWhitelistEnabled: params.transferWhitelistEnabled,
            }),
        };
        const mergedMetadata = mergeBeamioCardMetadataJsonPatch(existingMeta, patchJson, {
            preferExistingShareTokenMetadata: params.preferExistingShareTokenMetadata === true,
        });
        const metadataJson = serializeBeamioCardMetadataJson(mergedMetadata);
        await db.query(`
			INSERT INTO beamio_cards (card_address, card_owner, currency, price_in_currency_e6, uri, metadata_json, tx_hash)
			VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
			ON CONFLICT (card_address) DO UPDATE SET
				card_owner = EXCLUDED.card_owner,
				currency = EXCLUDED.currency,
				price_in_currency_e6 = EXCLUDED.price_in_currency_e6,
				uri = EXCLUDED.uri,
				metadata_json = EXCLUDED.metadata_json,
				tx_hash = EXCLUDED.tx_hash
			`, [
            addrLower,
            params.cardOwner.toLowerCase(),
            params.currency,
            params.priceInCurrencyE6,
            params.uri ?? null,
            metadataJson,
            params.txHash ?? null,
        ]);
        const cats = params.shareTokenMetadata?.categories;
        if (Array.isArray(cats) && cats.length > 0) {
            (0, logger_1.logger)(safe_1.default.green(`[registerCardToDb] registered card=${params.cardAddress} categories=${cats.filter((c) => typeof c === 'string' && c.trim()).join(',')}`));
        }
        else {
            (0, logger_1.logger)(safe_1.default.green(`[registerCardToDb] registered card=${params.cardAddress}`));
        }
        try {
            (0, latestCardsQueryCache_1.invalidateLatestCardsQueryCaches)();
        }
        catch {
            /* Discover cache hook is best-effort */
        }
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[registerCardToDb] failed: ${e?.message ?? e}`));
        throw e;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.registerCardToDb = registerCardToDb;
/** 供 metadata 热更新：读取 beamio_cards 登记行（不写链，只同步 JSON + metadata_json）。 */
const getBeamioCardRowForMetadataSync = async (cardAddress) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_CARDS_TABLE);
        const addr = cardAddress.toLowerCase();
        const { rows } = await db.query(`SELECT card_owner, currency, price_in_currency_e6, uri, tx_hash, metadata_json FROM beamio_cards WHERE card_address = $1 LIMIT 1`, [addr]);
        if (rows.length === 0)
            return null;
        const r = rows[0];
        const meta = r.metadata_json != null && typeof r.metadata_json === 'object' && !Array.isArray(r.metadata_json)
            ? r.metadata_json
            : null;
        return {
            cardOwner: r.card_owner,
            currency: r.currency,
            priceInCurrencyE6: String(r.price_in_currency_e6 ?? ''),
            uri: r.uri ?? null,
            txHash: r.tx_hash ?? null,
            metadata: meta,
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getBeamioCardRowForMetadataSync] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getBeamioCardRowForMetadataSync = getBeamioCardRowForMetadataSync;
/** 已登记发卡（beamio_cards）的去重 owner EOA 小写列表，供 Cluster 过滤「发卡方」身份。 */
const getDistinctBeamioCardOwnerAddressesLower = async () => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_CARDS_TABLE);
        const { rows } = await db.query(`
			SELECT DISTINCT LOWER(TRIM(card_owner)) AS card_owner
			FROM beamio_cards
			WHERE card_owner IS NOT NULL AND TRIM(card_owner) <> ''
			`);
        return rows.map((r) => r.card_owner).filter((x) => typeof x === "string" && x.startsWith("0x"));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getDistinctBeamioCardOwnerAddressesLower] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getDistinctBeamioCardOwnerAddressesLower = getDistinctBeamioCardOwnerAddressesLower;
/** Candidate merchant card owners for Admin referral assignment. */
const listReferralMerchantCandidates = async (limit = 500) => {
    const cap = Math.min(Math.max(Math.trunc(limit), 1), 2000);
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_CARDS_TABLE);
        const { rows } = await db.query(`SELECT card_owner, card_address, metadata_json
			 FROM beamio_cards
			 WHERE card_owner IS NOT NULL
			   AND TRIM(card_owner) <> ''
			   AND card_address IS NOT NULL
			   AND TRIM(card_address) <> ''
			 ORDER BY created_at DESC
			 LIMIT $1`, [cap]);
        return rows
            .filter((row) => ethers_1.ethers.isAddress(row.card_owner) && ethers_1.ethers.isAddress(row.card_address))
            .map((row) => ({
            merchant: ethers_1.ethers.getAddress(row.card_owner),
            cardAddress: ethers_1.ethers.getAddress(row.card_address),
            metadata: row.metadata_json && typeof row.metadata_json === 'object'
                ? row.metadata_json
                : null,
        }));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listReferralMerchantCandidates] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listReferralMerchantCandidates = listReferralMerchantCandidates;
/** 读取当前 DB 已登记的全部 BeamioUserCard 地址，用于 API 资产查询按用户过滤实际持有卡。 */
const listRegisteredBeamioUserCardAddresses = async (limit = 5000) => {
    const cap = Math.min(Math.max(Math.trunc(limit), 1), 10000);
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_CARDS_TABLE);
        const { rows } = await db.query(`
			SELECT card_address
			FROM beamio_cards
			WHERE card_address IS NOT NULL AND TRIM(card_address) <> ''
			ORDER BY created_at DESC
			LIMIT $1
			`, [cap]);
        const out = [];
        const seen = new Set();
        for (const r of rows) {
            try {
                const addr = ethers_1.ethers.getAddress(String(r.card_address || '').trim());
                const lower = addr.toLowerCase();
                if (seen.has(lower))
                    continue;
                if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(lower))
                    continue;
                seen.add(lower);
                out.push(addr);
            }
            catch {
                /* ignore malformed DB row */
            }
        }
        return out;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listRegisteredBeamioUserCardAddresses] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listRegisteredBeamioUserCardAddresses = listRegisteredBeamioUserCardAddresses;
/** 按 card_address 查单张卡的 card_owner + metadata_json。供 Cluster GET /api/cardMetadata 用，前端 beamioApi 拉取。 */
const getCardByAddress = async (cardAddress) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const addr = cardAddress.toLowerCase();
        (0, logger_1.logger)(safe_1.default.cyan(`[getCardByAddress] SELECT WHERE card_address = '${addr}'`));
        const { rows } = await db.query(`SELECT card_owner, currency, price_in_currency_e6, uri, tx_hash, created_at, metadata_json FROM beamio_cards WHERE card_address = $1 LIMIT 1`, [addr]);
        (0, logger_1.logger)(safe_1.default.cyan(`[getCardByAddress] rows=${rows.length}`));
        if (rows.length === 0) {
            // debug: 查表里是否有任意记录，以及 card_address 的格式
            const countResult = await db.query(`SELECT COUNT(*) as c FROM beamio_cards`);
            const sampleResult = await db.query(`SELECT card_address FROM beamio_cards LIMIT 3`);
            (0, logger_1.logger)(safe_1.default.yellow(`[getCardByAddress] beamio_cards total rows=${countResult.rows[0]?.c ?? '?'}, sample card_addresses: ${JSON.stringify(sampleResult.rows?.map((r) => r?.card_address) ?? [])}`));
            return null;
        }
        const createdAt = rows[0].created_at;
        return {
            cardOwner: rows[0].card_owner,
            currency: String(rows[0].currency ?? ''),
            priceInCurrencyE6: String(rows[0].price_in_currency_e6 ?? ''),
            uri: rows[0].uri ?? null,
            txHash: rows[0].tx_hash ?? null,
            createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt != null ? String(createdAt) : null,
            metadata: rows[0].metadata_json ?? null,
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getCardByAddress] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getCardByAddress = getCardByAddress;
/** beamio_cards.created_at for Discover merchant visibility (Featured Brands / coupon APIs). */
const getCardCreatedAtByAddress = async (cardAddress) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const addr = cardAddress.toLowerCase();
        const { rows } = await db.query(`SELECT created_at FROM beamio_cards WHERE card_address = $1 LIMIT 1`, [addr]);
        if (rows.length === 0)
            return null;
        const createdAt = rows[0].created_at;
        return createdAt instanceof Date ? createdAt.toISOString() : createdAt != null ? String(createdAt) : null;
    }
    catch {
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getCardCreatedAtByAddress = getCardCreatedAtByAddress;
/** Merchant-initiated API blacklist rows (Programs delete → hide assets / Discover / coupons). */
const BEAMIO_API_EXCLUDED_USER_CARDS_TABLE = `CREATE TABLE IF NOT EXISTS beamio_api_excluded_user_cards (
	card_address TEXT PRIMARY KEY,
	excluded_by TEXT NOT NULL,
	created_at TIMESTAMPTZ DEFAULT NOW()
)`;
async function ensureBeamioApiExcludedUserCardsSchema(db) {
    await db.query(BEAMIO_API_EXCLUDED_USER_CARDS_TABLE);
}
const listApiExcludedUserCardAddressesFromDb = async () => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioApiExcludedUserCardsSchema(db);
        const { rows } = await db.query(`SELECT card_address FROM beamio_api_excluded_user_cards ORDER BY created_at ASC`);
        return rows.map((r) => ethers_1.ethers.getAddress(r.card_address));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listApiExcludedUserCardAddressesFromDb] failed: ${e instanceof Error ? e.message : String(e)}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listApiExcludedUserCardAddressesFromDb = listApiExcludedUserCardAddressesFromDb;
const insertApiExcludedUserCard = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureBeamioApiExcludedUserCardsSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const by = ethers_1.ethers.getAddress(params.excludedBy).toLowerCase();
        await db.query(`
			INSERT INTO beamio_api_excluded_user_cards (card_address, excluded_by)
			VALUES ($1, $2)
			ON CONFLICT (card_address) DO UPDATE SET excluded_by = EXCLUDED.excluded_by
			`, [card, by]);
        return { ok: true };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logger)(safe_1.default.red(`[insertApiExcludedUserCard] failed: ${msg}`));
        return { ok: false, error: 'Could not persist card blacklist entry.' };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.insertApiExcludedUserCard = insertApiExcludedUserCard;
/** 写入或更新单张成员 NFT 的 tier metadata（card_owner + token_id 唯一）。由 mint/redeem 成功后 sync 调用。 */
const upsertNftTierMetadata = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_TIER_METADATA_TABLE);
        const tokenIdNum = Number(params.tokenId);
        await db.query(`
			INSERT INTO beamio_nft_tier_metadata (card_owner, token_id, card_address, metadata_json)
			VALUES ($1, $2, $3, $4::jsonb)
			ON CONFLICT (card_owner, token_id) DO UPDATE SET
				card_address = EXCLUDED.card_address,
				metadata_json = EXCLUDED.metadata_json
			`, [params.cardOwner.toLowerCase(), tokenIdNum, params.cardAddress.toLowerCase(), JSON.stringify(params.metadataJson)]);
        (0, logger_1.logger)(safe_1.default.cyan(`[upsertNftTierMetadata] card_owner=${params.cardOwner} token_id=${tokenIdNum}`));
        (0, logger_1.logger)(safe_1.default.gray(`[upsertNftTierMetadata] metadata_json: ${JSON.stringify(params.metadataJson, null, 2)}`));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertNftTierMetadata] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertNftTierMetadata = upsertNftTierMetadata;
/** 按 0x{owner}{NFT#}.json 的 owner 与 tokenId 查询该 NFT 的 tier metadata。Cluster GET /metadata/0x{owner}{NFT#}.json 用。 */
const getNftTierMetadataByOwnerAndToken = async (cardOwner, tokenId) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const normalized = cardOwner.toLowerCase().startsWith('0x') ? cardOwner.toLowerCase() : '0x' + cardOwner.toLowerCase();
        const tokenIdNum = Number(tokenId);
        const { rows } = await db.query(`SELECT metadata_json FROM beamio_nft_tier_metadata WHERE card_owner = $1 AND token_id = $2 LIMIT 1`, [normalized, tokenIdNum]);
        if (rows.length === 0 || rows[0].metadata_json == null)
            return null;
        return rows[0].metadata_json;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNftTierMetadataByOwnerAndToken] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNftTierMetadataByOwnerAndToken = getNftTierMetadataByOwnerAndToken;
/** 会员档 NFT tokenId 区间（与 BeamioERC1155Logic 一致）。 */
exports.BEAMIO_MEMBERSHIP_NFT_START_ID = 100;
exports.BEAMIO_ISSUED_NFT_START_ID = 100_000_000_000;
/** 已登记在 DB 的会员档 tokenId（供 Blockscout 批量 refetch）。 */
const listMembershipNftTierTokenIdsByCard = async (cardAddress) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const normalized = cardAddress.toLowerCase().startsWith('0x')
            ? cardAddress.toLowerCase()
            : '0x' + cardAddress.toLowerCase();
        const { rows } = await db.query(`SELECT token_id FROM beamio_nft_tier_metadata
			 WHERE card_address = $1 AND token_id >= $2 AND token_id < $3
			 ORDER BY token_id ASC`, [normalized, exports.BEAMIO_MEMBERSHIP_NFT_START_ID, exports.BEAMIO_ISSUED_NFT_START_ID]);
        return rows.map((r) => Number(r.token_id)).filter((n) => Number.isFinite(n));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listMembershipNftTierTokenIdsByCard] failed: ${e instanceof Error ? e.message : e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listMembershipNftTierTokenIdsByCard = listMembershipNftTierTokenIdsByCard;
/** 按 ERC-1155 合约地址 + tokenId 查询该 NFT 的 tier metadata。GET /metadata/0x{cardAddress}{tokenId}.json 用，符合 Base Explorer / EIP-1155 约定（40hex 为合约地址）。 */
const getNftTierMetadataByCardAndToken = async (cardAddress, tokenId) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const normalized = cardAddress.toLowerCase().startsWith('0x') ? cardAddress.toLowerCase() : '0x' + cardAddress.toLowerCase();
        const tokenIdNum = Number(tokenId);
        const { rows } = await db.query(`SELECT metadata_json FROM beamio_nft_tier_metadata WHERE card_address = $1 AND token_id = $2 LIMIT 1`, [normalized, tokenIdNum]);
        if (rows.length === 0 || rows[0].metadata_json == null) {
            (0, logger_1.logger)(safe_1.default.yellow(`[getNftTierMetadataByCardAndToken] card_address=${normalized} token_id=${tokenIdNum} rows=${rows.length} metadata_json=${rows[0]?.metadata_json == null ? 'null' : typeof rows[0]?.metadata_json}`));
            return null;
        }
        const out = rows[0].metadata_json;
        (0, logger_1.logger)(safe_1.default.cyan(`[getNftTierMetadataByCardAndToken] card_address=${normalized} token_id=${tokenIdNum} 查到 metadata 键: ${Object.keys(out || {}).join(',') || '(空对象)'}`));
        return out;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getNftTierMetadataByCardAndToken] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getNftTierMetadataByCardAndToken = getNftTierMetadataByCardAndToken;
const mapBeamioCardSqlRow = (r) => ({
    cardAddress: r.card_address,
    cardOwner: r.card_owner,
    currency: r.currency,
    priceInCurrencyE6: r.price_in_currency_e6,
    uri: r.uri,
    metadata: (r.metadata_json && typeof r.metadata_json === 'object') ? r.metadata_json : null,
    txHash: r.tx_hash,
    totalPointsMinted6: String(r.total_points_minted_6 ?? 0),
    holderCount: Number(r.holder_count ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
});
/** 最新发行的前 N 张卡明细 */
const getLatestCards = async (limit = 20) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const { rows } = await db.query(`
			SELECT card_address, card_owner, currency, price_in_currency_e6, uri, metadata_json, tx_hash, total_points_minted_6, holder_count, created_at
			FROM beamio_cards
			ORDER BY created_at DESC
			LIMIT $1
			`, [limit]);
        return rows.map(mapBeamioCardSqlRow);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getLatestCards] failed: ${e?.message ?? e}`));
        throw e;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getLatestCards = getLatestCards;
/**
 * 从 beamio_cards 拉取「含 shareTokenMetadata.categories 非空」的最近若干张卡（按 created_at 降序）。
 * createCard → registerCardToDb 已将 categories 写入 metadata_json，用于分类登记与聚合。
 */
const getRecentCategorizedBeamioCards = async (limit = 800) => {
    const cap = Math.min(Math.max(limit, 1), 3000);
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_CARDS_TABLE);
        const { rows } = await db.query(`
			SELECT card_address, card_owner, currency, price_in_currency_e6, uri, metadata_json, tx_hash, total_points_minted_6, holder_count, created_at
			FROM beamio_cards
			WHERE jsonb_typeof(COALESCE(metadata_json->'shareTokenMetadata'->'categories', '[]'::jsonb)) = 'array'
			  AND jsonb_array_length(COALESCE(metadata_json->'shareTokenMetadata'->'categories', '[]'::jsonb)) > 0
			ORDER BY created_at DESC
			LIMIT $1
			`, [cap]);
        return rows.map(mapBeamioCardSqlRow);
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getRecentCategorizedBeamioCards] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getRecentCategorizedBeamioCards = getRecentCategorizedBeamioCards;
/**
 * 按 categoryId 聚合发卡：每张卡可出现在多个 category（metadata 中多个 id）。
 * `scanLimit`：最多扫描多少张「已带 categories」的最近发卡；`limitPerCategory`：每个 category 最多返回几张卡（仍按 created_at 全局顺序填充）。
 */
const getLatestCardsGroupedByCategory = async (options) => {
    const scanLimit = Math.min(Math.max(options?.scanLimit ?? 800, 1), 3000);
    const limitPerCategory = Math.min(Math.max(options?.limitPerCategory ?? 80, 1), 500);
    const flat = await (0, exports.getRecentCategorizedBeamioCards)(scanLimit);
    const byCat = new Map();
    const seenInCat = new Map();
    for (const card of flat) {
        const meta = card.metadata;
        const stm = meta && typeof meta.shareTokenMetadata === 'object' ? meta.shareTokenMetadata : null;
        const raw = stm?.categories;
        const cats = Array.isArray(raw) ?
            raw
                .filter((c) => typeof c === 'string' && c.trim() !== '')
                .map((c) => c.trim())
                .slice(0, 32)
            : [];
        for (const cat of cats) {
            if (!byCat.has(cat)) {
                byCat.set(cat, []);
                seenInCat.set(cat, new Set());
            }
            const set = seenInCat.get(cat);
            const lo = card.cardAddress.toLowerCase();
            if (set.has(lo))
                continue;
            set.add(lo);
            const arr = byCat.get(cat);
            if (arr.length < limitPerCategory) {
                arr.push(card);
            }
        }
    }
    return Array.from(byCat.entries())
        .map(([categoryId, items]) => ({ categoryId, items }))
        .sort((a, b) => a.categoryId.localeCompare(b.categoryId));
};
exports.getLatestCardsGroupedByCategory = getLatestCardsGroupedByCategory;
/** 登记 issued NFT 系列到 DB（createIssuedNft 成功后由 API/daemon 调用）；metadataJson 为通用型 JSON，支持电影/演唱会/商品等场景；ipfsCid 可选，无 IPFS 时用 metadataJson 作为 shared metadata */
const registerSeriesToDb = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_SERIES_TABLE);
        const meta = params.metadataJson != null
            ? JSON.stringify((0, couponMetadataCategory_1.seriesMetadataLooksLikeProduction)(params.metadataJson)
                ? (0, couponMetadataCategory_1.normalizeProductionSeriesMetadataJson)(params.metadataJson)
                : (0, couponMetadataCategory_1.normalizeCouponSeriesMetadataJson)(params.metadataJson))
            : null;
        const ipfsCidVal = (params.ipfsCid != null && String(params.ipfsCid).trim() !== '') ? String(params.ipfsCid).trim() : '';
        await db.query(`
			INSERT INTO beamio_nft_series (card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json)
			VALUES ($1, $2, $3, $4, $5, $6::jsonb)
			ON CONFLICT (card_address, token_id) DO UPDATE SET
				shared_metadata_hash = EXCLUDED.shared_metadata_hash,
				ipfs_cid = EXCLUDED.ipfs_cid,
				card_owner = EXCLUDED.card_owner,
				metadata_json = COALESCE(EXCLUDED.metadata_json, beamio_nft_series.metadata_json)
			`, [
            params.cardAddress.toLowerCase(),
            params.tokenId,
            params.sharedMetadataHash,
            ipfsCidVal,
            params.cardOwner.toLowerCase(),
            meta,
        ]);
        (0, logger_1.logger)(safe_1.default.green(`[registerSeriesToDb] registered series card=${params.cardAddress} tokenId=${params.tokenId}`));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[registerSeriesToDb] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.registerSeriesToDb = registerSeriesToDb;
/** 更新已登记 issued NFT 系列 metadata_json（保留 shared_metadata_hash / ipfs_cid / card_owner）。 */
const updateSeriesMetadataByCardAndToken = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_SERIES_TABLE);
        const meta = JSON.stringify((0, couponMetadataCategory_1.seriesMetadataLooksLikeProduction)(params.metadataJson)
            ? (0, couponMetadataCategory_1.normalizeProductionSeriesMetadataJson)(params.metadataJson)
            : (0, couponMetadataCategory_1.normalizeCouponSeriesMetadataJson)(params.metadataJson));
        const { rowCount } = await db.query(`
			UPDATE beamio_nft_series
			SET metadata_json = $3::jsonb
			WHERE card_address = $1 AND token_id = $2
			`, [params.cardAddress.toLowerCase(), params.tokenId, meta]);
        return (rowCount ?? 0) > 0;
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[updateSeriesMetadataByCardAndToken] failed: ${e?.message ?? e}`));
        return false;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.updateSeriesMetadataByCardAndToken = updateSeriesMetadataByCardAndToken;
/** 登记单笔 mint 的通用型 metadata（购买/铸造时调用；metadataJson 任意结构，如 { seat: "A12" }、{ serialNo: "SN-001" }） */
const registerMintMetadataToDb = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_MINT_METADATA_TABLE);
        const meta = JSON.stringify(params.metadataJson);
        await db.query(`
			INSERT INTO beamio_nft_mint_metadata (card_address, token_id, owner_address, tx_hash, metadata_json)
			VALUES ($1, $2, $3, $4, $5::jsonb)
			`, [
            params.cardAddress.toLowerCase(),
            params.tokenId,
            params.ownerAddress.toLowerCase(),
            params.txHash ?? null,
            meta,
        ]);
        (0, logger_1.logger)(safe_1.default.green(`[registerMintMetadataToDb] card=${params.cardAddress} tokenId=${params.tokenId} owner=${params.ownerAddress}`));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[registerMintMetadataToDb] failed: ${e?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.registerMintMetadataToDb = registerMintMetadataToDb;
/** owner 钱包所有的 NFT 系列列表 */
const getOwnerNftSeries = async (owner, limit = 100) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_SERIES_TABLE);
        const { rows } = await db.query(`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_owner = $1
			ORDER BY created_at DESC
			LIMIT $2
			`, [owner.toLowerCase(), limit]);
        return rows.map((r) => ({
            cardAddress: r.card_address,
            tokenId: r.token_id,
            sharedMetadataHash: r.shared_metadata_hash,
            ipfsCid: r.ipfs_cid,
            cardOwner: r.card_owner,
            metadata: r.metadata_json,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        }));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getOwnerNftSeries] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getOwnerNftSeries = getOwnerNftSeries;
const ISSUED_NFT_START_ID_SERIES_FILTER = '100000000000';
/** SQL predicate: beamio_nft_series row is a Program coupon issued series (category Coupon + legacy markers). */
const COUPON_ISSUED_SERIES_METADATA_WHERE = `
(
	(metadata_json->>'category') = 'Coupon'
	OR (
		metadata_json ? 'properties'
		AND (metadata_json->'properties'->>'category') = 'Coupon'
	)
	OR (
		(
			NOT (metadata_json ? 'category')
			OR BTRIM(COALESCE(metadata_json->>'category', '')) = ''
		)
		AND (
			NOT (metadata_json ? 'properties')
			OR NOT ((metadata_json->'properties') ? 'category')
			OR BTRIM(COALESCE(metadata_json->'properties'->>'category', '')) = ''
		)
		AND (
			(metadata_json ? 'couponId')
			OR (
				metadata_json ? 'properties'
				AND ((metadata_json->'properties') ? 'beamioCoupon')
			)
		)
	)
)
AND (
	NOT (metadata_json ? 'category')
	OR (metadata_json->>'category') = 'Coupon'
)
AND (
	NOT (metadata_json ? 'properties')
	OR NOT ((metadata_json->'properties') ? 'category')
	OR (metadata_json->'properties'->>'category') = 'Coupon'
)
`;
/** 全站最近登记的 Program 优惠券 issued-NFT 系列：metadata 含 category=Coupon、根级 couponId 或 properties.beamioCoupon；按 created_at 倒序（与 registerSeriesToDb 入库时间一致）。 */
const listRecentBeamioIssuedCouponSeries = async (limit = 20) => {
    const lim = Number.isFinite(limit) ? Math.floor(Number(limit)) : 20;
    const cap = Math.min(Math.max(lim, 1), 100);
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_SERIES_TABLE);
        const { rows } = await db.query(`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE metadata_json IS NOT NULL
			AND ${COUPON_ISSUED_SERIES_METADATA_WHERE}
			AND token_id ~ '^[0-9]+$'
			AND LENGTH(token_id) <= 40
			AND (token_id::bigint >= $2::bigint)
			ORDER BY created_at DESC NULLS LAST
			LIMIT $1
			`, [cap, ISSUED_NFT_START_ID_SERIES_FILTER]);
        return (0, couponMetadataCategory_1.filterClientCouponSeriesRows)(rows.map((r) => ({
            cardAddress: r.card_address,
            tokenId: r.token_id,
            sharedMetadataHash: r.shared_metadata_hash,
            ipfsCid: r.ipfs_cid,
            cardOwner: r.card_owner,
            metadata: r.metadata_json,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        })));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listRecentBeamioIssuedCouponSeries] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listRecentBeamioIssuedCouponSeries = listRecentBeamioIssuedCouponSeries;
/** 指定卡下登记的 Program 优惠券 issued 系列（与 listRecentBeamioIssuedCouponSeries 同 coupon 语义），按 created_at 倒序；供链上 `isIssuedNftValid` 过滤前取候选集。 */
const listCouponIssuedNftSeriesForCardDescending = async (cardAddress, scanLimit = 200) => {
    const lim = Number.isFinite(scanLimit) ? Math.floor(Number(scanLimit)) : 200;
    const cap = Math.min(Math.max(lim, 1), 500);
    const cardLower = cardAddress.toLowerCase();
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_SERIES_TABLE);
        const { rows } = await db.query(`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_address = $1
			AND metadata_json IS NOT NULL
			AND ${COUPON_ISSUED_SERIES_METADATA_WHERE}
			AND token_id ~ '^[0-9]+$'
			AND LENGTH(token_id) <= 40
			AND (token_id::bigint >= $3::bigint)
			ORDER BY created_at DESC NULLS LAST
			LIMIT $2
			`, [cardLower, cap, ISSUED_NFT_START_ID_SERIES_FILTER]);
        return (0, couponMetadataCategory_1.filterClientCouponSeriesRows)(rows.map((r) => ({
            cardAddress: r.card_address,
            tokenId: r.token_id,
            sharedMetadataHash: r.shared_metadata_hash,
            ipfsCid: r.ipfs_cid,
            cardOwner: r.card_owner,
            metadata: r.metadata_json,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        })));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listCouponIssuedNftSeriesForCardDescending] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCouponIssuedNftSeriesForCardDescending = listCouponIssuedNftSeriesForCardDescending;
/** SQL predicate: beamio_nft_series row is a Program productions / service catalog issued series. */
const PRODUCTION_ISSUED_SERIES_METADATA_WHERE = `
(
	(metadata_json->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
	OR (
		metadata_json ? 'properties'
		AND (
			(metadata_json->'properties'->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
			OR (metadata_json->'properties') ? 'beamioProduction'
		)
	)
	OR (metadata_json ? 'productionId')
)
AND (
	NOT (metadata_json ? 'category')
	OR (metadata_json->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
)
AND (
	NOT (metadata_json ? 'properties')
	OR NOT ((metadata_json->'properties') ? 'category')
	OR (metadata_json->'properties'->>'category') IN ('Product', 'Service', 'Menu', 'ShareLink', 'SalesManagement', 'productions')
)
`;
/** 指定卡下登记的 Program productions issued 系列，按 created_at 倒序。 */
const listProductionIssuedNftSeriesForCardDescending = async (cardAddress, scanLimit = 200) => {
    const lim = Number.isFinite(scanLimit) ? Math.floor(Number(scanLimit)) : 200;
    const cap = Math.min(Math.max(lim, 1), 500);
    const cardLower = cardAddress.toLowerCase();
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_SERIES_TABLE);
        const { rows } = await db.query(`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_address = $1
			AND metadata_json IS NOT NULL
			AND ${PRODUCTION_ISSUED_SERIES_METADATA_WHERE}
			AND token_id ~ '^[0-9]+$'
			AND LENGTH(token_id) <= 40
			AND (token_id::bigint >= $3::bigint)
			ORDER BY created_at DESC NULLS LAST
			LIMIT $2
			`, [cardLower, cap, ISSUED_NFT_START_ID_SERIES_FILTER]);
        return (0, couponMetadataCategory_1.filterClientProductionSeriesRows)(rows.map((r) => ({
            cardAddress: r.card_address,
            tokenId: r.token_id,
            sharedMetadataHash: r.shared_metadata_hash,
            ipfsCid: r.ipfs_cid,
            cardOwner: r.card_owner,
            metadata: r.metadata_json,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        })));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[listProductionIssuedNftSeriesForCardDescending] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listProductionIssuedNftSeriesForCardDescending = listProductionIssuedNftSeriesForCardDescending;
/** 某 NFT 系列的 sharedSeriesMetadata 记录（含 ipfsCid、metadata_json 通用型 JSON） */
const getSeriesByCardAndTokenId = async (cardAddress, tokenId) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_SERIES_TABLE);
        const { rows } = await db.query(`
			SELECT card_address, token_id, shared_metadata_hash, ipfs_cid, card_owner, metadata_json, created_at
			FROM beamio_nft_series
			WHERE card_address = $1 AND token_id = $2
			`, [cardAddress.toLowerCase(), tokenId]);
        if (rows.length === 0)
            return null;
        const r = rows[0];
        return {
            cardAddress: r.card_address,
            tokenId: r.token_id,
            sharedMetadataHash: r.shared_metadata_hash,
            ipfsCid: r.ipfs_cid,
            cardOwner: r.card_owner,
            metadata: r.metadata_json,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        };
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getSeriesByCardAndTokenId] failed: ${e?.message ?? e}`));
        return null;
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getSeriesByCardAndTokenId = getSeriesByCardAndTokenId;
/** owner 在某系列下拥有的各笔 mint 的 metadata_json 列表（按创建顺序，用于电影票座位、商品序列号等） */
const getMintMetadataForOwner = async (cardAddress, tokenId, ownerAddress, limit = 100) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await db.query(BEAMIO_NFT_MINT_METADATA_TABLE);
        const { rows } = await db.query(`
			SELECT tx_hash, metadata_json, created_at
			FROM beamio_nft_mint_metadata
			WHERE card_address = $1 AND token_id = $2 AND owner_address = $3
			ORDER BY created_at ASC
			LIMIT $4
			`, [cardAddress.toLowerCase(), tokenId, ownerAddress.toLowerCase(), limit]);
        return rows.map((r) => ({
            txHash: r.tx_hash,
            metadata: r.metadata_json ?? {},
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        }));
    }
    catch (e) {
        (0, logger_1.logger)(safe_1.default.yellow(`[getMintMetadataForOwner] failed: ${e?.message ?? e}`));
        return [];
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.getMintMetadataForOwner = getMintMetadataForOwner;
/** CoNET factory + owner()：输入地址 → accounts 表用的 EOA 小写。getCode 失败时按 EOA 处理以免 RPC 抖动误杀。 */
const resolveSearchAddressToEOALower = async (address) => {
    try {
        const identity = await (0, beamioWalletIdentity_1.resolveBeamioWalletIdentityFromAddress)(address, {
            conetProvider: providerConet,
            baseProvider: providerBase,
        });
        return identity?.eoa?.toLowerCase() ?? null;
    }
    catch (e) {
        (0, logger_1.logger)(`resolveSearchAddressToEOALower failed: ${e?.message ?? e}`);
        if (!ethers_1.ethers.isAddress(address))
            return null;
        return ethers_1.ethers.getAddress(address).toLowerCase();
    }
};
exports.resolveSearchAddressToEOALower = resolveSearchAddressToEOALower;
function enrichSearchRowWithWalletIdentity(row, identity) {
    if (!identity)
        return row;
    return {
        ...row,
        address: identity.eoa,
        aaAccount: identity.aaAccount ?? row.aaAccount ?? null,
        queriedAddress: identity.queriedAddress,
        walletKind: identity.inputKind,
    };
}
async function searchUsersByAddressWithIdentity(normalized) {
    const identity = await (0, beamioWalletIdentity_1.resolveBeamioWalletIdentityFromAddress)(normalized, {
        conetProvider: providerConet,
        baseProvider: providerBase,
    });
    if (!identity) {
        return { results: [] };
    }
    if (identity.inputKind === 'aa' &&
        identity.eoa.toLowerCase() === identity.queriedAddress.toLowerCase()) {
        try {
            const c = new ethers_1.ethers.Contract(identity.queriedAddress, ['function owner() view returns (address)'], providerConet);
            const o = (await c.owner());
            if (!o || o === ethers_1.ethers.ZeroAddress) {
                return { results: [] };
            }
            identity.eoa = ethers_1.ethers.getAddress(o);
        }
        catch {
            return { results: [] };
        }
    }
    const eoaLower = identity.eoa.toLowerCase();
    const ret = await (0, exports._searchExactByAddress)(eoaLower);
    if ('error' in ret && ret.error) {
        return { error: String(ret.error) };
    }
    const dbRows = (ret.results ?? []);
    if (dbRows.length > 0) {
        let aaAccount = identity.aaAccount;
        if (!aaAccount) {
            aaAccount = await (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaOnConet)(identity.eoa);
        }
        const enrichedIdentity = { ...identity, aaAccount: aaAccount ?? identity.aaAccount };
        return { results: dbRows.map((row) => enrichSearchRowWithWalletIdentity(row, enrichedIdentity)) };
    }
    return {
        results: [
            enrichSearchRowWithWalletIdentity({
                address: identity.eoa,
                username: 'unknow',
                created_at: 0,
                image: '',
                first_name: '',
                last_name: '',
                follow_count: '0',
                follower_count: '0',
            }, identity),
        ],
    };
}
const SEARCH_EXACT_PAGE_SIZE = 10;
/** 仅按 accounts.address 等值匹配（无模糊）。addressLower 为小写 0x 地址。 */
const _searchExactByAddress = async (addressLower) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const offset = 0;
        const { rows: r } = await db.query(`
        SELECT
          a.address,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE((SELECT COUNT(*) FROM follows f WHERE f.follower = a.address), 0) AS follow_count,
          COALESCE((SELECT COUNT(*) FROM follows f2 WHERE f2.followee = a.address), 0) AS follower_count
        FROM accounts a
        WHERE LOWER(a.address) = LOWER($1)
        ORDER BY a.created_at DESC
        LIMIT $2 OFFSET $3
        `, [addressLower, SEARCH_EXACT_PAGE_SIZE, offset]);
        return { results: r };
    }
    catch (err) {
        console.error("searchUsers error:", err);
        return { error: "internal_error" };
    }
    finally {
        await db.end();
    }
};
exports._searchExactByAddress = _searchExactByAddress;
const mergeAccountSearchRowsByAddress = (primary, secondary) => {
    const seen = new Set();
    const out = [];
    for (const row of [...primary, ...secondary]) {
        const k = String(row?.address || "").toLowerCase();
        if (!k || seen.has(k))
            continue;
        seen.add(k);
        out.push(row);
    }
    return out;
};
const beamioTagSearchCaseVariants = (raw) => {
    const t = String(raw || "").trim().replace(/^@+/, "");
    if (!t)
        return [];
    const out = [];
    const seen = new Set();
    const add = (v) => {
        if (!v || seen.has(v))
            return;
        seen.add(v);
        out.push(v);
    };
    add(t);
    add(t.toUpperCase());
    add(t.toLowerCase());
    add(t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
    // LongDHANG → Long | DHANG → LongDhang (AccountRegistry is case-sensitive)
    const runs = [];
    let cur = t[0] ?? "";
    for (let i = 1; i < t.length; i++) {
        const prev = t[i - 1];
        const ch = t[i];
        if (/[a-z]/.test(prev) && /[A-Z]/.test(ch)) {
            runs.push(cur);
            cur = ch;
        }
        else {
            cur += ch;
        }
    }
    if (cur)
        runs.push(cur);
    if (runs.length > 1) {
        add(runs.map((r) => r.charAt(0).toUpperCase() + r.slice(1).toLowerCase()).join(""));
    }
    return out;
};
/**
 * AccountRegistry names are case-sensitive (LONGDHANG ≠ LongDHANG ≠ LongDhang).
 * Merge exact + UPPER + LOWER chain owners so a case-insensitive dropdown is complete
 * even when DB usernames were wiped.
 */
const mergeOnchainExactAccountNameIntoSearchResults = async (keyword, results) => {
    const raw = String(keyword || "").trim().replace(/^@+/, "");
    if (!raw || ethers_1.ethers.isAddress(raw))
        return results;
    const SC = exports.beamio_ContractPool[0]?.constAccountRegistry;
    if (!SC)
        return results;
    const merged = [...results];
    const seen = new Set(merged.map((row) => String(row?.address || "").toLowerCase()).filter(Boolean));
    for (const variant of beamioTagSearchCaseVariants(raw)) {
        let owner = "";
        try {
            owner = await SC.getOwnerByAccountName(variant);
        }
        catch (ex) {
            if (!(0, exports.isOnchainEmptyResult)(ex)) {
                (0, logger_1.logger)(safe_1.default.yellow(`[searchUsers] getOwnerByAccountName(${variant}) failed: ${ex?.shortMessage || ex?.message || ex}`));
            }
            continue;
        }
        if (!owner || owner === ethers_1.ethers.ZeroAddress)
            continue;
        const ownerLower = owner.toLowerCase();
        let accountName = variant;
        let image = "";
        let firstName = "";
        let lastName = "";
        let createdAt = 0;
        try {
            const onchain = await SC.getAccount(owner);
            if (onchain?.accountName)
                accountName = String(onchain.accountName);
            if (onchain?.image)
                image = String(onchain.image);
            if (onchain?.firstName)
                firstName = String(onchain.firstName);
            if (onchain?.lastName)
                lastName = String(onchain.lastName);
            if (onchain?.createdAt != null) {
                const ca = BigInt(onchain.createdAt);
                createdAt = Number(ca > 1000000000000n ? ca : ca * 1000n);
            }
        }
        catch (ex) {
            if (!(0, exports.isOnchainEmptyResult)(ex)) {
                (0, logger_1.logger)(safe_1.default.yellow(`[searchUsers] getAccount(${ownerLower}) failed: ${ex?.shortMessage || ex?.message || ex}`));
            }
        }
        enqueueSyncUserDataFromChain(accountName);
        const existing = merged.find((row) => String(row?.address || "").toLowerCase() === ownerLower);
        if (existing) {
            if (!String(existing.username || "").trim())
                existing.username = accountName;
            if (!String(existing.image || "").trim() && image)
                existing.image = image;
            if (!String(existing.first_name || "").trim() && firstName)
                existing.first_name = firstName;
            if (!String(existing.last_name || "").trim() && lastName)
                existing.last_name = lastName;
            continue;
        }
        if (seen.has(ownerLower))
            continue;
        seen.add(ownerLower);
        merged.unshift({
            address: ownerLower,
            username: accountName,
            created_at: createdAt,
            image,
            first_name: firstName,
            last_name: lastName,
            follow_count: "0",
            follower_count: "0",
            hit_field: "username",
        });
    }
    const qLower = raw.toLowerCase();
    merged.sort((a, b) => {
        const ta = String(a?.username || "").trim().toLowerCase();
        const tb = String(b?.username || "").trim().toLowerCase();
        const ra = ta === qLower ? 0 : ta.startsWith(qLower) ? 1 : 2;
        const rb = tb === qLower ? 0 : tb.startsWith(qLower) ? 1 : 2;
        return ra - rb;
    });
    return merged;
};
/** 关键词模糊搜索（非地址检索须走 searchUsers 里对地址的分支，勿把地址传入本函数）。 */
const _search = async (keyward) => {
    const _keywork = String(keyward || "")
        .trim()
        .replace(/^@+/, "") // ✅ 去掉开头的 @@@
        .replace(/\s+/g, " "); // ✅ 压缩空格
    const _page = 1;
    const _pageSize = 10;
    if (!_keywork) {
        return { results: [] };
    }
    // ethers.isAddress 声明为 `value is string`，对 string 入参在 false 分支会被 TS 误收窄为 never
    if (ethers_1.ethers.isAddress(_keywork)) {
        return { results: [] };
    }
    // ✅ 极短关键词直接返回，避免 %p% 这种扫库
    if (_keywork.length < 2) {
        return { results: [] };
    }
    const raw = _keywork;
    const containsPat = `%${raw}%`;
    const prefixPat = `${raw}%`;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        const offset = (_page - 1) * _pageSize;
        (0, logger_1.logger)(`_search with keyword`);
        const { rows: exactRows } = await db.query(`
        SELECT
          a.address,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE((SELECT COUNT(*) FROM follows f WHERE f.follower = a.address), 0) AS follow_count,
          COALESCE((SELECT COUNT(*) FROM follows f2 WHERE f2.followee = a.address), 0) AS follower_count,
          'username' AS hit_field
        FROM accounts a
        WHERE
          TRIM(COALESCE(a.username, '')) <> ''
          AND LOWER(TRIM(a.username)) = LOWER($1)
        ORDER BY a.created_at DESC
        LIMIT 50
        `, [raw]);
        const { rows: r } = await db.query(`
        WITH q AS (
          SELECT
            $1::text AS raw,
            $2::text AS contains_pat,
            $3::text AS prefix_pat
        )
        SELECT
          a.address,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE((SELECT COUNT(*) FROM follows f WHERE f.follower = a.address), 0) AS follow_count,
          COALESCE((SELECT COUNT(*) FROM follows f2 WHERE f2.followee = a.address), 0) AS follower_count,
          CASE
            WHEN a.username ILIKE q.contains_pat THEN 'username'
            WHEN (COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) ILIKE q.contains_pat THEN 'name'
            WHEN COALESCE(a.first_name, '') ILIKE q.contains_pat THEN 'first_name'
            WHEN COALESCE(a.last_name, '') ILIKE q.contains_pat THEN 'last_name'
            ELSE 'unknown'
          END AS hit_field
        FROM accounts a
        CROSS JOIN q
        WHERE
          a.username ILIKE q.contains_pat
          OR COALESCE(a.first_name, '') ILIKE q.contains_pat
          OR COALESCE(a.last_name, '') ILIKE q.contains_pat
          OR (COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) ILIKE q.contains_pat
        ORDER BY
          CASE
            WHEN LOWER(TRIM(COALESCE(a.username, ''))) = LOWER(q.raw) THEN -1
            WHEN a.username ILIKE q.prefix_pat THEN 0
            WHEN COALESCE(a.first_name, '') ILIKE q.prefix_pat THEN 1
            WHEN COALESCE(a.last_name, '') ILIKE q.prefix_pat THEN 2
            WHEN (COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) ILIKE q.prefix_pat THEN 3
            ELSE 9
          END,
          GREATEST(
            similarity(a.username, q.raw) * 2.0,
            similarity(COALESCE(a.first_name, ''), q.raw) * 1.0,
            similarity(COALESCE(a.last_name, ''), q.raw) * 1.0,
            similarity((COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')), q.raw) * 1.2
          ) DESC,
          a.created_at DESC
        LIMIT $4 OFFSET $5;
        `, [raw, containsPat, prefixPat, _pageSize, offset]);
        return { results: mergeAccountSearchRowsByAddress(exactRows, r) };
    }
    catch (err) {
        console.error("searchUsers error:", err);
        return { error: "internal_error" };
    }
    finally {
        await db.end();
    }
};
exports._search = _search;
/** 与 searchUsers 相同检索逻辑，供 Cluster 在二次过滤前拿到原始 results（无 HTTP）。 */
const searchUsersResultsForKeyward = async (keywardRaw) => {
    let _keywork = String(keywardRaw || "").trim().replace(/^@+/, "");
    if (!_keywork) {
        return { results: [] };
    }
    if (ethers_1.ethers.isAddress(_keywork)) {
        const normalized = ethers_1.ethers.getAddress(_keywork);
        const ret = await searchUsersByAddressWithIdentity(normalized);
        if ("error" in ret && ret.error) {
            return { error: String(ret.error) };
        }
        return { results: ret.results ?? [] };
    }
    const ret = await (0, exports._search)(_keywork);
    if ("error" in ret && ret.error) {
        return { error: String(ret.error) };
    }
    const results = await mergeOnchainExactAccountNameIntoSearchResults(_keywork, ret.results ?? []);
    return { results };
};
exports.searchUsersResultsForKeyward = searchUsersResultsForKeyward;
const searchUsers = async (req, res) => {
    const { keyward } = req.query;
    let _keywork = String(keyward || "").trim().replace(/^@+/, "");
    if (!_keywork) {
        return res.status(404).end();
    }
    if (ethers_1.ethers.isAddress(_keywork)) {
        const normalized = ethers_1.ethers.getAddress(_keywork);
        const ret = await searchUsersByAddressWithIdentity(normalized);
        if ("error" in ret && ret.error) {
            return res.status(500).json({ error: ret.error }).end();
        }
        return res.status(200).json(ret).end();
    }
    const ret = await (0, exports._search)(_keywork);
    if ("error" in ret && ret.error) {
        return res.status(500).json({ error: ret.error }).end();
    }
    const results = await mergeOnchainExactAccountNameIntoSearchResults(_keywork, ret.results ?? []);
    return res.status(200).json({ results }).end();
};
exports.searchUsers = searchUsers;
const updateUserFollowDB = async (accountAddress, // follower
followAddress // followee
) => {
    const follower = accountAddress.toLowerCase();
    const followee = followAddress.toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    try {
        await db.query("BEGIN");
        // 1) 插入关注关系（如果已经存在则忽略）
        const insertResult = await db.query(`
				INSERT INTO follows (follower, followee, followed_at)
				VALUES ($1, $2, $3)
				ON CONFLICT (follower, followee) DO NOTHING
			`, [follower, followee, nowSec]);
        // 2) 只有在真正插入成功时（不是重复关注），才更新计数
        if (insertResult.rowCount !== null && insertResult.rowCount > 0) {
            await db.query(`
				UPDATE accounts
				SET follow_count = follow_count + 1
				WHERE address = $1
				`, [follower]);
            await db.query(`
				UPDATE accounts
				SET follower_count = follower_count + 1
				WHERE address = $1
				`, [followee]);
        }
        await db.query("COMMIT");
    }
    catch (err) {
        await db.query("ROLLBACK");
        throw err;
    }
    finally {
        await db.end();
    }
};
const updateUserFollowRemoveDB = async (accountAddress, // follower
followAddress // followee
) => {
    const follower = accountAddress.toLowerCase();
    const followee = followAddress.toLowerCase();
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    try {
        await db.query("BEGIN");
        // 1) 删除关注关系
        const deleteResult = await db.query(`
				DELETE FROM follows
				WHERE follower = $1 AND followee = $2
			`, [follower, followee]);
        // 如果本来就没有这条关系，就不用改计数，直接提交事务
        if (deleteResult.rowCount === 0) {
            await db.query("COMMIT");
            return;
        }
        // 2) 更新双方计数（做防御：确保不会 < 0）
        await db.query(`
		UPDATE accounts
		SET follow_count = GREATEST(follow_count - 1, 0)
		WHERE address = $1
		`, [follower]);
        await db.query(`
		UPDATE accounts
		SET follower_count = GREATEST(follower_count - 1, 0)
		WHERE address = $1
		`, [followee]);
        await db.query("COMMIT");
    }
    catch (err) {
        await db.query("ROLLBACK");
        throw err;
    }
    finally {
        await db.end();
    }
};
const removeFollow = (req, res) => {
    const { wallet, followAddress } = req.body;
    addFollowPool.push({
        wallet,
        followAddress,
        remove: true
    });
    res.status(200).json({ ok: true }).end();
    addFollowPoolProcess();
};
exports.removeFollow = removeFollow;
const addFollow = (req, res) => {
    const { wallet, followAddress } = req.body;
    addFollowPool.push({
        wallet,
        followAddress,
        remove: false
    });
    res.status(200).json({ ok: true }).end();
    addFollowPoolProcess();
};
exports.addFollow = addFollow;
//		我关注了谁」列表，按时间倒序（最新 follow 在前）
const getFollowingPaginated = async (address, page, pageSize) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    const addr = address.toLowerCase();
    const safePage = page > 0 ? page : 1;
    const safePageSize = pageSize > 0 ? pageSize : 20;
    const offset = (safePage - 1) * safePageSize;
    // 1) 查总数
    const { rows: countRows } = await db.query(`
		SELECT COUNT(*)::BIGINT AS total
		FROM follows
		WHERE follower = $1
		`, [addr]);
    const total = Number(countRows[0]?.total ?? 0);
    if (total === 0) {
        return {
            items: [],
            page: safePage,
            pageSize: safePageSize,
            total: 0
        };
    }
    // 2) 查当前页数据（按 followed_at DESC）
    const { rows } = await db.query(`
		SELECT followee, followed_at
		FROM follows
		WHERE follower = $1
		ORDER BY followed_at DESC
		LIMIT $2 OFFSET $3
		`, [addr, safePageSize, offset]);
    const items = rows.map((r) => ({
        address: String(r.followee),
        followedAt: Number(r.followed_at)
    }));
    return {
        items,
        page: safePage,
        pageSize: safePageSize,
        total
    };
};
//		谁关注了我」列表，按时间倒序（最新 follow 在前）
const getFollowersPaginated = async (address, page, pageSize) => {
    const addr = address.toLowerCase();
    const safePage = page > 0 ? page : 1;
    const safePageSize = pageSize > 0 ? pageSize : 20;
    const offset = (safePage - 1) * safePageSize;
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    // 1) 查总数
    const { rows: countRows } = await db.query(`
		SELECT COUNT(*)::BIGINT AS total
		FROM follows
		WHERE followee = $1
		`, [addr]);
    const total = Number(countRows[0]?.total ?? 0);
    if (total === 0) {
        return {
            items: [],
            page: safePage,
            pageSize: safePageSize,
            total: 0
        };
    }
    // 2) 查当前页数据（按 followed_at DESC）
    const { rows } = await db.query(`
		SELECT follower, followed_at
		FROM follows
		WHERE followee = $1
		ORDER BY followed_at DESC
		LIMIT $2 OFFSET $3
		`, [addr, safePageSize, offset]);
    const items = rows.map((r) => ({
        address: String(r.follower),
        followedAt: Number(r.followed_at)
    }));
    return {
        items,
        page: safePage,
        pageSize: safePageSize,
        total
    };
};
const deleteAccountFromDB = async (address) => {
    const addr = address.toLowerCase();
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    try {
        await db.query("BEGIN");
        // 删关注关系
        await db.query(`
		DELETE FROM follows
		WHERE follower = $1 OR followee = $1
		`, [addr]);
        // 删账号
        await db.query(`
		DELETE FROM accounts
		WHERE address = $1
		`, [addr]);
        await db.query("COMMIT");
    }
    catch (err) {
        await db.query("ROLLBACK");
        throw err;
    }
    finally {
        (0, logger_1.logger)(`deleteAccountFromDB success: ${addr}`);
        await db.end();
    }
};
const FollowerStatus = async (myAddress, followerAddress, db = new pg_1.Client({ connectionString: DB_URL })) => {
    const me = myAddress.toLowerCase();
    const target = followerAddress.toLowerCase();
    await db.connect();
    try {
        // 并行查询
        const [isFollowingResult, isFollowedByResult, followingResult, followersResult, countsResult] = await Promise.all([
            // 1) 我是否关注它？
            db.query(`
			SELECT 1
			FROM follows
			WHERE follower = $1 AND followee = $2
			LIMIT 1
			`, [me, target]),
            // 2) 它是否关注我？
            db.query(`
			SELECT 1
			FROM follows
			WHERE follower = $1 AND followee = $2
			LIMIT 1
			`, [target, me]),
            // 3) 它的最新 following 列表（最新 20）
            db.query(`
			SELECT followee, followed_at
			FROM follows
			WHERE follower = $1
			ORDER BY followed_at DESC
			LIMIT 20
			`, [target]),
            // 4) 它的最新 followers 列表（最新 20）
            db.query(`
			SELECT follower, followed_at
			FROM follows
			WHERE followee = $1
			ORDER BY followed_at DESC
			LIMIT 20
			`, [target]),
            // 5) 它的总 follow_count / follower_count
            // 如果你 accounts 表里没这两列，可以改成 COUNT(*) FROM follows ...
            db.query(`
			SELECT
			COALESCE(follow_count, 0)   AS follow_count,
			COALESCE(follower_count, 0) AS follower_count
			FROM accounts
			WHERE address = $1
			`, [target])
        ]);
        const isFollowing = isFollowingResult.rowCount && isFollowingResult.rowCount > 0 ? true : false;
        const isFollowedBy = isFollowedByResult.rowCount && isFollowedByResult.rowCount > 0 ? true : false;
        const following = followingResult.rows.map((r) => ({
            address: String(r.followee),
            followedAt: Number(r.followed_at)
        }));
        const followers = followersResult.rows.map((r) => ({
            address: String(r.follower),
            followedAt: Number(r.followed_at)
        }));
        const countsRow = countsResult.rows[0] || { follow_count: 0, follower_count: 0 };
        const followingCount = Number(countsRow.follow_count ?? 0);
        const followerCount = Number(countsRow.follower_count ?? 0);
        return {
            isFollowing,
            isFollowedBy,
            following,
            followers,
            followingCount,
            followerCount
        };
    }
    finally {
        await db.end();
    }
};
exports.FollowerStatus = FollowerStatus;
const getMyFollowStatus = async (myAddress) => {
    const addr = myAddress.toLowerCase();
    const db = new pg_1.Client({ connectionString: DB_URL });
    await db.connect();
    try {
        const [followingResult, followersResult, myCountsResult] = await Promise.all([
            // 1) 我关注了谁（最新 20）+ 对方的 profile + 对方的计数
            db.query(`
        SELECT 
          f.followee AS address,
          f.followed_at,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE(a.follow_count, 0)   AS following_count,
          COALESCE(a.follower_count, 0) AS follower_count
        FROM follows f
        LEFT JOIN accounts a
          ON a.address = f.followee
        WHERE f.follower = $1
        ORDER BY f.followed_at DESC
        LIMIT 20
        `, [addr]),
            // 2) 谁关注了我（最新 20）+ 对方的 profile + 对方的计数
            db.query(`
        SELECT 
          f.follower AS address,
          f.followed_at,
          a.username,
          a.created_at,
          a.image,
          a.first_name,
          a.last_name,
          COALESCE(a.follow_count, 0)   AS following_count,
          COALESCE(a.follower_count, 0) AS follower_count
        FROM follows f
        LEFT JOIN accounts a
          ON a.address = f.follower
        WHERE f.followee = $1
        ORDER BY f.followed_at DESC
        LIMIT 20
        `, [addr]),
            // 3) 我自己的 follow_count / follower_count
            db.query(`
        SELECT
          COALESCE(follow_count, 0)   AS following_count,
          COALESCE(follower_count, 0) AS follower_count
        FROM accounts
        WHERE address = $1
        `, [addr])
        ]);
        const following = followingResult.rows.map((r) => ({
            address: String(r.address),
            followedAt: Number(r.followed_at),
            username: r.username ?? null,
            createdAt: r.created_at ? Number(r.created_at) : null,
            image: r.image ?? null,
            firstName: r.first_name ?? null,
            lastName: r.last_name ?? null,
            followingCount: Number(r.following_count ?? 0),
            followerCount: Number(r.follower_count ?? 0)
        }));
        const followers = followersResult.rows.map((r) => ({
            address: String(r.address),
            followedAt: Number(r.followed_at),
            username: r.username ?? null,
            createdAt: r.created_at ? Number(r.created_at) : null,
            image: r.image ?? null,
            firstName: r.first_name ?? null,
            lastName: r.last_name ?? null,
            followingCount: Number(r.following_count ?? 0),
            followerCount: Number(r.follower_count ?? 0)
        }));
        const myCountsRow = myCountsResult.rows[0] || {
            following_count: 0,
            follower_count: 0
        };
        const followingCount = Number(myCountsRow.following_count ?? 0);
        const followerCount = Number(myCountsRow.follower_count ?? 0);
        return {
            following,
            followers,
            followingCount,
            followerCount
        };
    }
    finally {
        await db.end();
    }
};
exports.getMyFollowStatus = getMyFollowStatus;
exports.ipfsDataPool = [];
exports.ipfsAccessPool = [];
const ipfsAccessProcess = async () => {
    const obj = exports.ipfsAccessPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.beamio_ContractPool.shift();
    if (!SC) {
        exports.ipfsAccessPool.unshift(obj);
        return setTimeout(() => {
            (0, exports.ipfsAccessProcess)();
        }, 3000);
    }
    try {
        const tx = await SC.constIPFS.updateAccess(obj.hash);
        await tx.wait();
        (0, logger_1.logger)(`ipfsAccessProcess SUCCESS! ${tx.hash}`);
    }
    catch (ex) {
        (0, logger_1.logger)(`ipfsAccessProcess Error ${ex.message}`);
    }
    exports.beamio_ContractPool.push(SC);
    return setTimeout(() => {
        (0, exports.ipfsAccessProcess)();
    }, 3000);
};
exports.ipfsAccessProcess = ipfsAccessProcess;
const ipfsDataProcess = async () => {
    const obj = exports.ipfsDataPool.shift();
    if (!obj) {
        return;
    }
    const SC = exports.beamio_ContractPool.shift();
    if (!SC) {
        exports.ipfsDataPool.unshift(obj);
        return setTimeout(() => {
            (0, exports.ipfsDataProcess)();
        }, 3000);
    }
    try {
        const tx = await SC.constIPFS.storeAdmin(obj.hash, obj.imageLength, obj.wallet);
        await tx.wait();
        (0, logger_1.logger)(`ipfsDataProcess SUCCESS! ${tx.hash}`);
    }
    catch (ex) {
        (0, logger_1.logger)(`ipfsDataProcess Error ${ex.message}`);
    }
    exports.beamio_ContractPool.push(SC);
    return setTimeout(() => {
        (0, exports.ipfsDataProcess)();
    }, 3000);
};
exports.ipfsDataProcess = ipfsDataProcess;
//		0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61			@Beamio
// const test = async () => {
// 	const result = await _search(`Beamio`)
// 	logger(`result = `, inspect(result))
// }
// test()
const admin = ['0xEaBF0A98aC208647247eAA25fDD4eB0e67793d61'];
const img = `https://beamio.app/favicon.ico`;
// const addUserAdmin = async () => {
// 		const wallet =  admin[0]
// 		const obj: beamioAccount = {
// 			accountName: `Beamio`,
// 			address: wallet,
// 			image: img,
// 			isUSDCFaucet: false,
// 			darkTheme: false,
// 			isETHFaucet: false,
// 			firstName: 'Official',
// 			lastName: 'Beamio',
// 			initialLoading: true
// 		}
// 		addUserPool.push({
// 			wallet,
// 			account: obj,
// 			recover: []
// 		})
// 		addUserPoolProcess()
// 		addFollowPool.push({
// 			wallet,
// 			followAddress: BeamioOfficial,
// 			remove: false
// 		})
// 		addFollowPoolProcess()
// }
// addUserAdmin()
