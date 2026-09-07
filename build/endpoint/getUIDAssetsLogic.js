"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureNfcCashTreeBeamioTagAfterFetch = exports.pickInfrastructureCashTreeTierTokenId = exports.fetchUIDAssetsForEOA = void 0;
exports.fetchBeamioTagForEoa = fetchBeamioTagForEoa;
exports.pickInfrastructureCashTreeTierTokenIdFromChain = pickInfrastructureCashTreeTierTokenIdFromChain;
exports.scheduleEnsureNfcBeamioTagForEoa = scheduleEnsureNfcBeamioTagForEoa;
/**
 * 共享的 getUIDAssets 资产拉取逻辑。供 Cluster（已有 EOA 时）与 Master（provision 完成后）共同使用。
 */
const ethers_1 = require("ethers");
const logger_1 = require("../logger");
const safe_1 = __importDefault(require("colors/safe"));
const db_1 = require("../db");
const chainAddresses_1 = require("../chainAddresses");
const apiExcludedUserCards_1 = require("../apiExcludedUserCards");
const couponMetadataCategory_1 = require("../couponMetadataCategory");
const membershipTierPick_1 = require("./membershipTierPick");
const membershipNftDiscovery_1 = require("./membershipNftDiscovery");
const resolveBeamioAaViaUserCardFactory_1 = require("./resolveBeamioAaViaUserCardFactory");
const tierMetadataRowResolve_1 = require("./tierMetadataRowResolve");
const beamioUserCardChain_1 = require("../beamioUserCardChain");
const socialExchangeMetadata_1 = require("../socialExchangeMetadata");
/** Drop blacklist + Base-only legacy rows before asset-scan RPC (CoNET merchant cards only). */
async function filterBeamioUserCardAddressesForAssetScan(addresses) {
    const out = [];
    const seen = new Set();
    for (const raw of addresses) {
        if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(raw))
            continue;
        let addr;
        try {
            addr = ethers_1.ethers.getAddress(String(raw || '').trim());
        }
        catch {
            continue;
        }
        const lower = addr.toLowerCase();
        if (seen.has(lower))
            continue;
        if (!(await (0, beamioUserCardChain_1.hasCoNETUserCardBytecode)(addr)))
            continue;
        seen.add(lower);
        out.push(addr);
    }
    return out;
}
/** 与 util.resolveBeamioBaseHttpRpcUrl 一致；此处不 import util，避免经 db 与 util/server 形成循环依赖 */
const BASE_RPC_URL = (typeof process !== 'undefined' && process.env?.BASE_RPC_URL?.trim()) || 'https://base-rpc.conet.network';
const providerBase = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL);
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CADD_BASE = '0x16F93eBC5320C89EfC8701577efe49d14A276a06';
const resolveBeamioAccountOf = async (eoa) => (0, resolveBeamioAaViaUserCardFactory_1.resolveBeamioAaForEoaWithFallback)(providerBase, eoa);
/**
 * 从链上 AccountRegistry 读 EOA 的 beamioTag（accountName）；去掉首尾空白与前缀 `@`。
 * 无登记、`exists` 为 false 或 RPC 失败时返回 undefined。
 */
async function fetchBeamioTagForEoa(eoa) {
    let eoaAddr;
    try {
        eoaAddr = ethers_1.ethers.getAddress(String(eoa || '').trim());
    }
    catch {
        return undefined;
    }
    const reg = db_1.beamio_ContractPool[0]?.constAccountRegistry;
    if (!reg)
        return undefined;
    try {
        const o = await reg.getAccount(eoaAddr);
        if (!o?.exists)
            return undefined;
        const raw = String(o.accountName ?? '')
            .trim()
            .replace(/^@+/, '')
            .trim();
        return raw !== '' ? raw : undefined;
    }
    catch {
        return undefined;
    }
}
const resolveMerchantProgramCardAddress = (opt) => {
    if (!opt || typeof opt !== 'string')
        return null;
    try {
        const a = ethers_1.ethers.getAddress(opt.trim());
        if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(a))
            return null;
        return a;
    }
    catch {
        return null;
    }
};
/** 与 MemberCard / cardMetadata 一致：优先 shareTokenMetadata.name，其次顶层 name。 */
function displayNameFromCardMetadata(m) {
    if (!m || typeof m !== 'object')
        return null;
    const stm = m.shareTokenMetadata;
    const n1 = stm?.name;
    if (typeof n1 === 'string' && n1.trim())
        return n1.trim();
    const n2 = m.name;
    if (typeof n2 === 'string' && n2.trim())
        return n2.trim();
    return null;
}
function readCouponIdFromSeriesMetadata(meta) {
    if (!meta || typeof meta !== 'object')
        return '';
    const rootId = meta.couponId;
    if (typeof rootId === 'string' && rootId.trim())
        return rootId.trim();
    const properties = meta.properties;
    if (!properties || typeof properties !== 'object')
        return '';
    const beamioCoupon = properties.beamioCoupon;
    if (!beamioCoupon || typeof beamioCoupon !== 'object')
        return '';
    const nestedId = beamioCoupon.couponId;
    return typeof nestedId === 'string' && nestedId.trim() ? nestedId.trim() : '';
}
function readCouponRequiresRedeemCode(meta) {
    if (!meta || typeof meta !== 'object')
        return false;
    const root = meta;
    const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
    if (toBool(root.requiresRedeemCode) || toBool(root.redeemCodeRequired))
        return true;
    const properties = root.properties;
    if (!properties || typeof properties !== 'object')
        return false;
    const beamioCoupon = properties.beamioCoupon;
    if (!beamioCoupon || typeof beamioCoupon !== 'object')
        return false;
    const nested = beamioCoupon;
    return toBool(nested.requiresRedeemCode) || toBool(nested.redeemCodeRequired);
}
function readCouponTitleFromSeriesMetadata(meta, tokenId) {
    if (!meta || typeof meta !== 'object')
        return `Coupon #${tokenId}`;
    const rootTitle = typeof meta.title === 'string' ? meta.title.trim() : '';
    if (rootTitle)
        return rootTitle;
    const rootName = typeof meta.name === 'string' ? meta.name.trim() : '';
    if (rootName)
        return rootName;
    const properties = meta.properties;
    if (properties && typeof properties === 'object') {
        const beamioCoupon = properties.beamioCoupon;
        if (beamioCoupon && typeof beamioCoupon === 'object') {
            const nestedTitle = typeof beamioCoupon.title === 'string' ? String(beamioCoupon.title).trim() : '';
            if (nestedTitle)
                return nestedTitle;
            const nestedName = typeof beamioCoupon.name === 'string' ? String(beamioCoupon.name).trim() : '';
            if (nestedName)
                return nestedName;
        }
    }
    return `Coupon #${tokenId}`;
}
/**
 * 仅用 metadata.tiers 的 index / 数组下标对齐链上档（回退用）。
 */
function pickCardMetadataTierRow(tiersRaw, bestNftTier) {
    if (!Array.isArray(tiersRaw) || tiersRaw.length === 0)
        return null;
    const minUsdc6Num = (t) => {
        const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : '';
        const n = parseInt(s, 10);
        return Number.isNaN(n) ? Infinity : n;
    };
    const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b));
    if (bestNftTier === 'Default/Max')
        return tiersSorted[0] ?? null;
    const tierIndexChain = parseInt(bestNftTier, 10) || 0;
    const byIndex = tiersRaw.find((x, i) => (x.index != null ? x.index : i) === tierIndexChain);
    return byIndex ?? tiersRaw[tierIndexChain] ?? null;
}
/**
 * 解析卡 metadata.tiers 展示行：由 {@link pickTierMetadataRowForChainSlot} 优先按 `tierIndex`，
 * 找不到再按链上 `tiers(tierIndex).minUsdc6` 回退；链上调用失败时仅用 index/下标。
 */
async function pickCardMetadataTierRowForChain(card, tiersRaw, bestNftTier, primaryNftAttribute) {
    if (!Array.isArray(tiersRaw) || tiersRaw.length === 0)
        return null;
    const minUsdc6Num = (t) => {
        const s = t.minUsdc6 != null ? String(t.minUsdc6).trim() : '';
        const n = parseInt(s, 10);
        return Number.isNaN(n) ? Infinity : n;
    };
    const tiersSorted = [...tiersRaw].sort((a, b) => minUsdc6Num(a) - minUsdc6Num(b));
    if (bestNftTier === 'Default/Max')
        return tiersSorted[0] ?? null;
    const tierIndexChain = Number.parseInt(bestNftTier, 10);
    if (!Number.isFinite(tierIndexChain) || tierIndexChain < 0) {
        return pickCardMetadataTierRow(tiersRaw, bestNftTier);
    }
    const c = card;
    try {
        const trow = await c.tiers(BigInt(tierIndexChain));
        const picked = (0, tierMetadataRowResolve_1.pickTierMetadataRowForChainSlot)(tiersRaw, tierIndexChain, trow[0].toString(), trow[1], primaryNftAttribute);
        if (picked)
            return picked;
    }
    catch {
        /* tiers(i) revert */
    }
    return pickCardMetadataTierRow(tiersRaw, bestNftTier);
}
const fetchUIDAssetsForEOA = async (eoa, opts) => {
    const eoaAddr = ethers_1.ethers.getAddress(eoa);
    const cardAbi = [
        'function getOwnership(address user) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
        'function getOwnershipByEOA(address userEOA) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
        'function balanceOf(address account, uint256 id) view returns (uint256)',
        'function currency() view returns (uint8)',
        'function tiers(uint256) view returns (uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds)',
    ];
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const caddAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
    const usdc = new ethers_1.ethers.Contract(USDC_BASE, usdcAbi, providerBase);
    const cadd = new ethers_1.ethers.Contract(CADD_BASE, caddAbi, providerBase);
    const [usdcEoaRaw, aaAddr] = await Promise.all([
        usdc.balanceOf(eoaAddr),
        resolveBeamioAccountOf(eoaAddr),
    ]);
    let usdcTotalRaw = usdcEoaRaw;
    let caddTotalRaw = 0n;
    let caddDecimals = 18;
    if (aaAddr) {
        const [usdcAaRaw, caddAaRaw] = await Promise.all([
            usdc.balanceOf(aaAddr),
            cadd.balanceOf(aaAddr).catch(() => 0n),
        ]);
        usdcTotalRaw += usdcAaRaw;
        caddTotalRaw += caddAaRaw;
    }
    const [caddEoaRaw, caddDecimalsRaw] = await Promise.all([
        cadd.balanceOf(eoaAddr).catch(() => 0n),
        cadd.decimals().catch(() => 18),
    ]);
    caddTotalRaw += caddEoaRaw;
    caddDecimals = Number(caddDecimalsRaw);
    const usdcBalance = ethers_1.ethers.formatUnits(usdcTotalRaw, 6);
    const caddBalance = ethers_1.ethers.formatUnits(caddTotalRaw, caddDecimals);
    const currencyMap = { 0: 'CAD', 1: 'USD', 2: 'JPY', 3: 'CNY', 4: 'USDC', 5: 'HKD', 6: 'EUR', 7: 'SGD', 8: 'TWD' };
    const infraAddr = resolveMerchantProgramCardAddress(opts?.infrastructureCardAddress);
    const merchantInfraOnly = opts?.cardsScope === 'merchantInfraOnly';
    const merchantProgramOnly = opts?.cardsScope === 'infrastructureOnly';
    const singleProgramScope = merchantInfraOnly || merchantProgramOnly;
    const programFallbackName = 'Merchant program card';
    const cardAddresses = [];
    if (singleProgramScope) {
        if (!infraAddr) {
            (0, logger_1.logger)(safe_1.default.yellow('[fetchUIDAssetsForEOA] merchantInfraOnly/infrastructureOnly requires merchantInfraCard'));
        }
        else {
            cardAddresses.push({ address: infraAddr, name: programFallbackName, type: 'beamio-user-card' });
        }
    }
    else {
        /* cardsScope=all：仅 DB 已登记 + extraCardAddresses；无全局默认卡 */
    }
    const seenCardAddresses = new Set(cardAddresses.map((c) => c.address.toLowerCase()));
    if (!singleProgramScope && opts?.includeRegisteredBeamioCards !== false) {
        try {
            const registered = await filterBeamioUserCardAddressesForAssetScan(await (0, db_1.listRegisteredBeamioUserCardAddresses)());
            for (const address of registered) {
                const lower = address.toLowerCase();
                if (seenCardAddresses.has(lower))
                    continue;
                cardAddresses.push({ address, name: 'BeamioUserCard', type: 'beamio-user-card' });
                seenCardAddresses.add(lower);
            }
            (0, logger_1.logger)(safe_1.default.gray(`[fetchUIDAssetsForEOA] registered BeamioUserCard candidates=${registered.length} totalCandidates=${cardAddresses.length}`));
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[fetchUIDAssetsForEOA] list registered BeamioUserCards failed: ${e?.message ?? e}`));
        }
    }
    if (!singleProgramScope) {
        for (const raw of opts?.extraCardAddresses ?? []) {
            try {
                if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(raw))
                    continue;
                const address = ethers_1.ethers.getAddress(raw);
                const lower = address.toLowerCase();
                if (seenCardAddresses.has(lower))
                    continue;
                cardAddresses.push({ address, name: 'BeamioUserCard', type: 'beamio-user-card' });
                seenCardAddresses.add(lower);
            }
            catch {
                /* ignore invalid DB/cache address */
            }
        }
    }
    const cardsStaged = [];
    for (const { address: cardAddr, name: fallbackDisplayName, type: cardType } of cardAddresses) {
        if ((0, apiExcludedUserCards_1.isApiExcludedUserCard)(cardAddr))
            continue;
        let cardName = fallbackDisplayName;
        try {
            if (!(await (0, beamioUserCardChain_1.hasCoNETUserCardBytecode)(cardAddr)))
                continue;
            let cardRow = null;
            try {
                cardRow = await (0, db_1.getCardByAddress)(cardAddr);
            }
            catch {
                /* DB 失败仍用链上数据 */
            }
            cardName = displayNameFromCardMetadata(cardRow?.metadata ?? undefined) ?? fallbackDisplayName;
            const cardProvider = (0, beamioUserCardChain_1.providerForUserCardChain)(await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddr));
            const card = new ethers_1.ethers.Contract(cardAddr, cardAbi, cardProvider);
            const tokenHolder = aaAddr || eoaAddr;
            /** V16+: Charge + social Reward PT share ERC-1155 #13 (legacy #2 no longer minted). */
            const [ownershipMerged, reward13ByHolder, reward13ByEoa, currencyNum,] = await Promise.all([
                (0, membershipNftDiscovery_1.resolveMergedCardOwnership)({
                    provider: cardProvider,
                    cardAddress: cardAddr,
                    eoa: eoaAddr,
                    aaAddress: aaAddr,
                }),
                card.balanceOf(tokenHolder, socialExchangeMetadata_1.REWARD_VOUCHER_TOKEN_ID).catch(() => 0n),
                tokenHolder.toLowerCase() === eoaAddr.toLowerCase()
                    ? Promise.resolve(0n)
                    : card.balanceOf(eoaAddr, socialExchangeMetadata_1.REWARD_VOUCHER_TOKEN_ID).catch(() => 0n),
                card.currency(),
            ]);
            const pointsBalance = ownershipMerged.points;
            const nfts = ownershipMerged.nfts;
            const reward13Balance = reward13ByHolder + reward13ByEoa;
            const chargeRewardPointsBalance = reward13Balance;
            const socialRewardPointsBalance = reward13Balance;
            const currency = currencyMap[Number(currencyNum)] ?? 'CAD';
            const nftList = nfts.map((nft) => ({
                tokenId: nft.tokenId.toString(),
                attribute: nft.attribute.toString(),
                tier: nft.tierIndexOrMax === ethers_1.ethers.MaxUint256 ? 'Default/Max' : nft.tierIndexOrMax.toString(),
                expiry: nft.expiry === 0n ? 'Never' : new Date(Number(nft.expiry) * 1000).toLocaleString(),
                isExpired: nft.isExpired,
            }));
            let cardBackground;
            let cardImage;
            let tierName;
            let tierDescription;
            const withTokenId = nftList.filter((n) => Number(n.tokenId) > 0);
            (0, logger_1.logger)(safe_1.default.gray(`[fetchUIDAssetsForEOA] card=${cardAddr} withTokenId=${withTokenId.length}`));
            const pick = await (0, membershipTierPick_1.pickBestMembershipNftByMinUsdc6)(card, nfts.map((nft) => ({
                tokenId: nft.tokenId,
                tierIndexOrMax: nft.tierIndexOrMax,
                isExpired: nft.isExpired,
            })));
            const bestNft = pick ? nftList.find((n) => n.tokenId === pick.tokenId) ?? null : null;
            if (bestNft) {
                try {
                    const bestTokenId = BigInt(bestNft.tokenId);
                    let tierMeta = await (0, db_1.getNftTierMetadataByCardAndToken)(cardAddr, bestTokenId);
                    if (!tierMeta && aaAddr) {
                        tierMeta = await (0, db_1.getNftTierMetadataByOwnerAndToken)(aaAddr, bestTokenId);
                    }
                    if (!tierMeta) {
                        tierMeta = await (0, db_1.getNftTierMetadataByOwnerAndToken)(eoaAddr, bestTokenId);
                    }
                    if (!tierMeta && cardRow?.cardOwner) {
                        tierMeta = await (0, db_1.getNftTierMetadataByOwnerAndToken)(cardRow.cardOwner, bestTokenId);
                    }
                    if (tierMeta && typeof tierMeta === 'object') {
                        const props = tierMeta.properties;
                        const bg = (props?.background_color ?? tierMeta.background_color);
                        if (bg && typeof bg === 'string' && bg.trim()) {
                            cardBackground = bg.trim().startsWith('#') ? bg.trim() : `#${bg.trim().replace(/^#/, '')}`;
                        }
                        const img = (props?.image ?? tierMeta.image);
                        if (img && typeof img === 'string' && img.trim())
                            cardImage = img.trim();
                        tierName = (props?.tier_name ?? tierMeta.name);
                        if (tierName && typeof tierName === 'string' && tierName.trim())
                            tierName = tierName.trim();
                        else
                            tierName = undefined;
                        tierDescription = (props?.tier_description ?? tierMeta.description);
                        if (tierDescription && typeof tierDescription === 'string' && tierDescription.trim())
                            tierDescription = tierDescription.trim();
                        else
                            tierDescription = undefined;
                    }
                    // 卡级 metadata.tiers：与主档链上索引对齐的 name 作为 tierName（覆盖 NFT 库里的占位文案），供 Android/Web 直接使用。
                    if (cardRow?.metadata?.tiers && Array.isArray(cardRow.metadata.tiers)) {
                        const tiersRaw = cardRow.metadata.tiers;
                        const t = await pickCardMetadataTierRowForChain(card, tiersRaw, bestNft.tier, bestNft.attribute);
                        if (t) {
                            const cardTierName = t.name != null ? String(t.name).trim() : '';
                            const cardTierDesc = t.description != null ? String(t.description).trim() : '';
                            if (cardTierName) {
                                tierName = cardTierName;
                                // 与 tierName 同源：卡级 tiers 命中 name 时，description 只认该行；无则清空，禁止沿用 NFT 库按 tokenId 缓存的旧档文案（升降级同 tokenId 会串档）。
                                tierDescription = cardTierDesc !== '' ? cardTierDesc : undefined;
                            }
                            else if (cardTierDesc !== '') {
                                tierDescription = cardTierDesc;
                            }
                            if (!cardImage && t.image && String(t.image).trim())
                                cardImage = String(t.image).trim();
                            if (!cardBackground && t.backgroundColor && String(t.backgroundColor).trim()) {
                                const bg = String(t.backgroundColor).trim();
                                cardBackground = bg.startsWith('#') ? bg : `#${bg.replace(/^#/, '')}`;
                            }
                        }
                        const tierIndexChain = bestNft.tier === 'Default/Max' ? 0 : (parseInt(bestNft.tier, 10) || 0);
                        if (!tierName) {
                            if (bestNft.tier === 'Default/Max' || tierIndexChain === 0)
                                tierName = 'Default';
                            // 与 Android chainTierLabelFromPrimaryNft 一致：链上索引 N →「Tier N」
                            else
                                tierName = `Tier ${tierIndexChain}`;
                        }
                    }
                }
                catch {
                    /* ignore */
                }
            }
            const hasPoints = pointsBalance > 0n;
            const hasChargeRewardPoints = chargeRewardPointsBalance > 0n;
            const hasSocialRewardPoints = socialRewardPointsBalance > 0n;
            const hasNftGt0 = nftList.some((n) => Number(n.tokenId) > 0);
            const includeRow = hasPoints ||
                hasChargeRewardPoints ||
                hasSocialRewardPoints ||
                hasNftGt0 ||
                merchantInfraOnly ||
                merchantProgramOnly ||
                (opts?.includeZeroBalanceCards === true && cardType !== 'beamio-user-card');
            if (includeRow) {
                const row = {
                    cardAddress: cardAddr,
                    cardName,
                    cardType,
                    points: ethers_1.ethers.formatUnits(pointsBalance, 6),
                    points6: String(pointsBalance),
                    chargeRewardPoints: ethers_1.ethers.formatUnits(chargeRewardPointsBalance, 6),
                    chargeRewardPoints6: String(chargeRewardPointsBalance),
                    socialRewardPoints: ethers_1.ethers.formatUnits(socialRewardPointsBalance, 6),
                    socialRewardPoints6: String(socialRewardPointsBalance),
                    cardCurrency: currency,
                    ...(cardBackground != null && { cardBackground }),
                    ...(cardImage != null && { cardImage }),
                    ...(tierName != null && { tierName }),
                    ...(tierDescription != null && { tierDescription }),
                    ...(pick ? { primaryMemberTokenId: pick.tokenId } : {}),
                    nfts: nftList,
                };
                cardsStaged.push({ row, sortMin: pick?.minUsdc6 ?? 0n });
            }
        }
        catch (cardErr) {
            (0, logger_1.logger)(safe_1.default.gray(`[fetchUIDAssetsForEOA] card=${cardAddr} skip: ${cardErr?.message ?? cardErr}`));
            if (singleProgramScope && infraAddr && cardAddr.toLowerCase() === infraAddr.toLowerCase()) {
                try {
                    const cardProvider = (0, beamioUserCardChain_1.providerForUserCardChain)(await (0, beamioUserCardChain_1.resolveUserCardChain)(cardAddr));
                    const card = new ethers_1.ethers.Contract(cardAddr, cardAbi, cardProvider);
                    const currencyNum = await card.currency();
                    const currency = currencyMap[Number(currencyNum)] ?? 'CAD';
                    cardsStaged.push({
                        row: {
                            cardAddress: cardAddr,
                            cardName,
                            cardType,
                            points: '0',
                            points6: '0',
                            chargeRewardPoints: '0',
                            chargeRewardPoints6: '0',
                            socialRewardPoints: '0',
                            socialRewardPoints6: '0',
                            cardCurrency: currency,
                            nfts: [],
                        },
                        sortMin: 0n,
                    });
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
    cardsStaged.sort((a, b) => {
        if (a.sortMin > b.sortMin)
            return -1;
        if (a.sortMin < b.sortMin)
            return 1;
        return 0;
    });
    const cards = (0, apiExcludedUserCards_1.filterApiExcludedCardRows)(cardsStaged.map((s) => s.row));
    const beamioTag = await fetchBeamioTagForEoa(eoaAddr);
    let posTopFields = {};
    if (infraAddr) {
        try {
            const snap = await (0, db_1.getMemberLastTopupOnCard)(infraAddr, eoaAddr);
            if (snap) {
                posTopFields.posLastTopupAt = snap.lastTopupAt;
                if (snap.usdcE6 != null)
                    posTopFields.posLastTopupUsdcE6 = snap.usdcE6;
                if (snap.pointsE6 != null)
                    posTopFields.posLastTopupPointsE6 = snap.pointsE6;
            }
        }
        catch {
            /* DB 失败不阻塞资产查询 */
        }
    }
    let merchantCouponBalances;
    let merchantClaimableCoupons;
    if (infraAddr) {
        try {
            const seriesRows = await (0, db_1.listCouponIssuedNftSeriesForCardDescending)(infraAddr, 80);
            if (seriesRows.length > 0) {
                const tokenHolder = aaAddr && ethers_1.ethers.isAddress(aaAddr) ? ethers_1.ethers.getAddress(aaAddr) : eoaAddr;
                const couponProvider = (0, beamioUserCardChain_1.providerForUserCardChain)(await (0, beamioUserCardChain_1.resolveUserCardChain)(infraAddr));
                const couponRead = new ethers_1.ethers.Contract(infraAddr, [
                    'function isIssuedNftValid(uint256 tokenId) view returns (bool)',
                    'function issuedNftPriceInCurrency6(uint256 tokenId) view returns (uint256)',
                    'function issuedNftUserSigClaimUsed(address userEOA, uint256 tokenId) view returns (bool)',
                    'function balanceOf(address account, uint256 id) view returns (uint256)',
                ], couponProvider);
                const seen = new Set();
                const balances = [];
                const claimables = [];
                for (const row of seriesRows) {
                    if (!(0, couponMetadataCategory_1.metadataMatchesClientCouponCategoryFilter)(row.metadata))
                        continue;
                    const tokenId = String(row.tokenId ?? '').trim();
                    if (!tokenId || seen.has(tokenId))
                        continue;
                    seen.add(tokenId);
                    let tokenIdN;
                    try {
                        tokenIdN = BigInt(tokenId);
                    }
                    catch {
                        continue;
                    }
                    const couponId = readCouponIdFromSeriesMetadata(row.metadata ?? null);
                    if (!couponId)
                        continue;
                    const isDelisted = (0, couponMetadataCategory_1.readCouponDisabledFromMetadata)(row.metadata ?? null);
                    const requiresRedeemCode = readCouponRequiresRedeemCode(row.metadata ?? null);
                    const title = readCouponTitleFromSeriesMetadata(row.metadata ?? null, tokenId);
                    const [isValid, priceInCurrency6, alreadyClaimed, balByHolder, balByEoa] = await Promise.all([
                        couponRead.isIssuedNftValid(tokenIdN).catch(() => false),
                        couponRead.issuedNftPriceInCurrency6(tokenIdN).catch(() => 0n),
                        couponRead.issuedNftUserSigClaimUsed(eoaAddr, tokenIdN).catch(() => false),
                        couponRead.balanceOf(tokenHolder, tokenIdN).catch(() => 0n),
                        tokenHolder.toLowerCase() === eoaAddr.toLowerCase()
                            ? Promise.resolve(0n)
                            : couponRead.balanceOf(eoaAddr, tokenIdN).catch(() => 0n),
                    ]);
                    if (!isValid)
                        continue;
                    const bal = balByHolder > balByEoa ? balByHolder : balByEoa;
                    if (bal > 0n) {
                        balances.push({
                            cardAddress: infraAddr,
                            couponId,
                            tokenId,
                            title,
                            balance: String(bal),
                            requiresRedeemCode,
                        });
                    }
                    if (!requiresRedeemCode && priceInCurrency6 === 0n && !alreadyClaimed && bal === 0n && !isDelisted) {
                        claimables.push({
                            cardAddress: infraAddr,
                            couponId,
                            tokenId,
                            title,
                            requiresRedeemCode,
                        });
                    }
                }
                merchantCouponBalances = balances.length > 0 ? balances : undefined;
                merchantClaimableCoupons = claimables.length > 0 ? claimables : undefined;
            }
        }
        catch {
            /* ignore coupon enrichment failure */
        }
    }
    return {
        ok: true,
        address: eoaAddr,
        aaAddress: aaAddr || undefined,
        ...(beamioTag != null && beamioTag !== '' ? { beamioTag } : {}),
        usdcBalance,
        caddBalance,
        cards,
        ...posTopFields,
        ...(merchantCouponBalances ? { merchantCouponBalances } : {}),
        ...(merchantClaimableCoupons ? { merchantClaimableCoupons } : {}),
    };
};
exports.fetchUIDAssetsForEOA = fetchUIDAssetsForEOA;
/** 商户程序卡主会员 NFT：与链上 `tiers[i].minUsdc6` 最高档一致（`primaryMemberTokenId`）。 */
const pickInfrastructureCashTreeTierTokenId = (cards, programCardAddress) => {
    const want = programCardAddress?.trim();
    const row = want && ethers_1.ethers.isAddress(want)
        ? cards.find((c) => c.cardAddress.toLowerCase() === ethers_1.ethers.getAddress(want).toLowerCase())
        : cards.find((c) => c.cardType === 'beamio-user-card');
    if (!row?.nfts?.length)
        return null;
    const primary = row.primaryMemberTokenId?.trim();
    if (primary && Number(primary) > 0)
        return primary;
    const withT = row.nfts.filter((n) => Number(n.tokenId) > 0);
    if (!withT.length)
        return null;
    return withT.reduce((a, b) => (Number(b.tokenId) > Number(a.tokenId) ? b : a)).tokenId;
};
exports.pickInfrastructureCashTreeTierTokenId = pickInfrastructureCashTreeTierTokenId;
const INFRA_OWNERSHIP_ABI = [
    'function getOwnership(address user) view returns (uint256 pt, (uint256 tokenId, uint256 attribute, uint256 tierIndexOrMax, uint256 expiry, bool isExpired)[] nfts)',
    'function tiers(uint256) view returns (uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds)',
];
/** 仅查基础设施卡在链上的主会员 tokenId（与 fetchUIDAssetsForEOA 一致），供无 cards 数组时的 NFC 入口 */
async function pickInfrastructureCashTreeTierTokenIdFromChain(eoa) {
    const eoaAddr = ethers_1.ethers.getAddress(eoa);
    try {
        const aaAddr = await resolveBeamioAccountOf(eoaAddr);
        const ownership = await (0, membershipNftDiscovery_1.resolveMergedCardOwnership)({
            provider: providerBase,
            cardAddress: chainAddresses_1.BEAMIO_USER_CARD_ASSET_ADDRESS,
            eoa: eoaAddr,
            aaAddress: aaAddr,
        });
        const card = new ethers_1.ethers.Contract(chainAddresses_1.BEAMIO_USER_CARD_ASSET_ADDRESS, INFRA_OWNERSHIP_ABI, providerBase);
        const pick = await (0, membershipTierPick_1.pickBestMembershipNftByMinUsdc6)(card, ownership.nfts.map((nft) => ({
            tokenId: nft.tokenId,
            tierIndexOrMax: nft.tierIndexOrMax,
            isExpired: nft.isExpired,
        })));
        return pick?.tokenId ?? null;
    }
    catch {
        return null;
    }
}
/**
 * NFC 流程在校验 SUN、且 EOA 已有部署 AA 之后：若链上尚无 beamioTag，则排队登记。
 * 优先基础设施卡 NFT 对应的 CashTreeDamo_*；否则分配 beamio_nfc_{N}（beamio_nfc_seq + 链上占用校验）。
 */
function scheduleEnsureNfcBeamioTagForEoa(eoa, uid, tagIdHex, cards) {
    void (async () => {
        try {
            const wallet = ethers_1.ethers.getAddress(String(eoa || '').trim());
            const uidS = String(uid || '').trim();
            if (!uidS)
                return;
            const reg = db_1.beamio_ContractPool[0]?.constAccountRegistry;
            if (!reg)
                return;
            let accName = '';
            let exists = false;
            try {
                const o = await reg.getAccount(wallet);
                exists = !!o?.exists;
                accName = String(o?.accountName ?? '').trim();
            }
            catch {
                exists = false;
            }
            if (exists && accName !== '') {
                (0, db_1.maybeClearLegacyNfcBeamioProfileNames)(wallet);
                return;
            }
            let tierTokenId = null;
            if (cards && cards.length > 0) {
                tierTokenId = (0, exports.pickInfrastructureCashTreeTierTokenId)(cards);
            }
            if (!tierTokenId) {
                tierTokenId = await pickInfrastructureCashTreeTierTokenIdFromChain(wallet);
            }
            if (tierTokenId) {
                (0, db_1.maybeEnqueueNfcCashTreeBeamioTag)({ wallet, uid: uidS, tagIdHex, tierTokenId });
            }
            else {
                (0, db_1.maybeEnqueueNfcBeamioTag)({ wallet, uid: uidS, tagIdHex });
            }
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow(`[scheduleEnsureNfcBeamioTagForEoa] ${e?.message ?? e}`));
        }
    })();
}
/**
 * @deprecated Prefer scheduleEnsureNfcBeamioTagForEoa（含无 NFT 时的 beamio_nfc_*）
 */
const ensureNfcCashTreeBeamioTagAfterFetch = (eoa, uid, tagIdHex, cards) => {
    scheduleEnsureNfcBeamioTagForEoa(eoa, uid, tagIdHex, cards);
};
exports.ensureNfcCashTreeBeamioTagAfterFetch = ensureNfcCashTreeBeamioTagAfterFetch;
