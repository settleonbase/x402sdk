"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveReferrerRegistryAaToEoa = resolveReferrerRegistryAaToEoa;
exports.resolveReferrerRegistryLookupKeys = resolveReferrerRegistryLookupKeys;
exports.resolveReferrerRegistryLookupAa = resolveReferrerRegistryLookupAa;
exports.readCardProgramReferrerChainSummary = readCardProgramReferrerChainSummary;
exports.readReferrerRewardBalance = readReferrerRewardBalance;
exports.readRefereeChargePointsTotal6 = readRefereeChargePointsTotal6;
exports.readRefereeCountByReferrer = readRefereeCountByReferrer;
exports.readReferrersPageFromChain = readReferrersPageFromChain;
exports.readRefereesByReferrerPageFromChain = readRefereesByReferrerPageFromChain;
exports.readRegisteredRefereesPageFromChain = readRegisteredRefereesPageFromChain;
const ethers_1 = require("ethers");
const chainAddresses_1 = require("./chainAddresses");
const beamioUserCardChain_1 = require("./beamioUserCardChain");
/** Unified reward points (#13). Legacy #1 was referrer-only and is no longer minted as spendable. */
const REFERRER_REWARD_TOKEN_ID = 13n;
const CARD_REFERRER_READ_ABI = [
    'function referrerTotalCount() view returns (uint256)',
    'function registeredRefereeTotalCount() view returns (uint256)',
    'function refereeCountByReferrer(address referrerAA) view returns (uint256)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function refereeChargePointsTotal6(address refereeAA) view returns (uint256)',
    'function refereeReferrer(address refereeAA) view returns (address)',
    'function getReferrersPage(uint256 offset, uint256 pageSize) view returns (address[] referrers, uint256[] referrerRewardBalances, uint256 total, uint256 nextOffset)',
    'function getRefereesByReferrerPage(address referrerAA, uint256 offset, uint256 pageSize) view returns (address[] referees, uint256[] refereeChargeTotals6, uint256 total, uint256 nextOffset)',
    'function getRegisteredRefereesPage(uint256 offset, uint256 pageSize) view returns (address[] referees, uint256 total, uint256 nextOffset)',
];
const AA_FACTORY_ABI = [
    'function isBeamioAccount(address) view returns (bool)',
    'function beamioAccountOf(address) view returns (address)',
];
const AA_OWNER_ABI = ['function owner() view returns (address)'];
async function cardReferrerReadContract(cardAddress) {
    const card = ethers_1.ethers.getAddress(cardAddress);
    const chain = await (0, beamioUserCardChain_1.resolveUserCardChain)(card);
    const provider = (0, beamioUserCardChain_1.providerForUserCardChain)(chain);
    return { card: new ethers_1.ethers.Contract(card, CARD_REFERRER_READ_ABI, provider), provider };
}
function bigintToCount(raw) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}
/** Chain stores Beamio AA; product UI/API must expose EOA. */
async function resolveReferrerRegistryAaToEoa(provider, aaOrEoa) {
    if (!ethers_1.ethers.isAddress(aaOrEoa) || aaOrEoa === ethers_1.ethers.ZeroAddress)
        return aaOrEoa;
    const addr = ethers_1.ethers.getAddress(aaOrEoa);
    try {
        const fac = new ethers_1.ethers.Contract(chainAddresses_1.CONET_AA_FACTORY, AA_FACTORY_ABI, provider);
        const isAa = Boolean(await fac.isBeamioAccount(addr));
        if (!isAa)
            return addr;
        const acct = new ethers_1.ethers.Contract(addr, AA_OWNER_ABI, provider);
        const owner = (await acct.owner());
        if (owner && owner !== ethers_1.ethers.ZeroAddress)
            return ethers_1.ethers.getAddress(owner);
    }
    catch {
        /* keep addr */
    }
    return addr;
}
/**
 * Lookup keys for referrer-registry mappings.
 * Bind writes the **login EOA** on-card; older rows may be AA. Always try the
 * address as-is first — never rewrite EOA → AA before the first read.
 */
async function resolveReferrerRegistryLookupKeys(provider, eoaOrAa) {
    if (!ethers_1.ethers.isAddress(eoaOrAa) || eoaOrAa === ethers_1.ethers.ZeroAddress)
        return [];
    const addr = ethers_1.ethers.getAddress(eoaOrAa);
    const keys = [addr];
    try {
        const fac = new ethers_1.ethers.Contract(chainAddresses_1.CONET_AA_FACTORY, AA_FACTORY_ABI, provider);
        if (await fac.isBeamioAccount(addr)) {
            const owner = (await new ethers_1.ethers.Contract(addr, AA_OWNER_ABI, provider).owner());
            if (owner && owner !== ethers_1.ethers.ZeroAddress)
                keys.push(ethers_1.ethers.getAddress(owner));
        }
        else {
            const aa = (await fac.beamioAccountOf(addr));
            if (aa && aa !== ethers_1.ethers.ZeroAddress)
                keys.push(ethers_1.ethers.getAddress(aa));
        }
    }
    catch {
        /* keep as-is */
    }
    return [...new Set(keys)];
}
/** Accept EOA or AA for chain index lookups; return the AA used on-card. */
async function resolveReferrerRegistryLookupAa(provider, eoaOrAa) {
    if (!ethers_1.ethers.isAddress(eoaOrAa) || eoaOrAa === ethers_1.ethers.ZeroAddress)
        return eoaOrAa;
    const addr = ethers_1.ethers.getAddress(eoaOrAa);
    try {
        const fac = new ethers_1.ethers.Contract(chainAddresses_1.CONET_AA_FACTORY, AA_FACTORY_ABI, provider);
        if (await fac.isBeamioAccount(addr))
            return addr;
        const aa = (await fac.beamioAccountOf(addr));
        if (aa && aa !== ethers_1.ethers.ZeroAddress)
            return ethers_1.ethers.getAddress(aa);
    }
    catch {
        /* fall through */
    }
    return addr;
}
async function pickLookupWithPreferredHit(keys, read, isHit) {
    let last = null;
    for (const key of keys) {
        const value = await read(key);
        last = { key, value };
        if (isHit(value))
            return last;
    }
    return last;
}
async function mapAaListToEoa(provider, addrs) {
    return Promise.all(addrs.map((a) => resolveReferrerRegistryAaToEoa(provider, a)));
}
async function readCardProgramReferrerChainSummary(cardAddress) {
    try {
        const { card } = await cardReferrerReadContract(cardAddress);
        const [referrerTotal, registeredTotal] = await Promise.all([
            card.referrerTotalCount(),
            card.registeredRefereeTotalCount(),
        ]);
        return {
            referrerTotalCount: bigintToCount(referrerTotal),
            registeredRefereeTotalCount: bigintToCount(registeredTotal),
        };
    }
    catch {
        return { referrerTotalCount: null, registeredRefereeTotalCount: null };
    }
}
async function readReferrerRewardBalance(cardAddress, referrerAA) {
    try {
        if (!ethers_1.ethers.isAddress(referrerAA))
            return null;
        const { card, provider } = await cardReferrerReadContract(cardAddress);
        const keys = await resolveReferrerRegistryLookupKeys(provider, referrerAA);
        const picked = await pickLookupWithPreferredHit(keys, async (key) => (await card.balanceOf(key, REFERRER_REWARD_TOKEN_ID)), (raw) => raw > 0n);
        return picked ? picked.value.toString() : null;
    }
    catch {
        return null;
    }
}
async function readRefereeChargePointsTotal6(cardAddress, refereeAA) {
    try {
        if (!ethers_1.ethers.isAddress(refereeAA))
            return null;
        const { card, provider } = await cardReferrerReadContract(cardAddress);
        const keys = await resolveReferrerRegistryLookupKeys(provider, refereeAA);
        const picked = await pickLookupWithPreferredHit(keys, async (key) => (await card.refereeChargePointsTotal6(key)), (raw) => raw > 0n);
        return picked ? picked.value.toString() : null;
    }
    catch {
        return null;
    }
}
async function readRefereeCountByReferrer(cardAddress, referrerAA) {
    try {
        if (!ethers_1.ethers.isAddress(referrerAA))
            return null;
        const { card, provider } = await cardReferrerReadContract(cardAddress);
        const keys = await resolveReferrerRegistryLookupKeys(provider, referrerAA);
        const picked = await pickLookupWithPreferredHit(keys, async (key) => bigintToCount((await card.refereeCountByReferrer(key))), (n) => n != null && n > 0);
        return picked?.value ?? null;
    }
    catch {
        return null;
    }
}
async function readReferrersPageFromChain(cardAddress, offset, pageSize) {
    try {
        const { card, provider } = await cardReferrerReadContract(cardAddress);
        const [referrers, balances, total, nextOffset] = (await card.getReferrersPage(BigInt(offset), BigInt(pageSize)));
        const items = await Promise.all(referrers.map(async (addr, i) => {
            const referrerAaOnChain = ethers_1.ethers.getAddress(addr);
            const referrerEoa = await resolveReferrerRegistryAaToEoa(provider, referrerAaOnChain);
            return {
                referrerAa: referrerEoa,
                refereeCount: await readRefereeCountByReferrer(cardAddress, referrerAaOnChain),
                referrerRewardBalance: balances[i] != null
                    ? balances[i].toString()
                    : await readReferrerRewardBalance(cardAddress, referrerAaOnChain),
            };
        }));
        return {
            ok: true,
            referrers: items,
            total: bigintToCount(total) ?? items.length,
            nextOffset: bigintToCount(nextOffset) ?? offset + items.length,
        };
    }
    catch {
        return { ok: false };
    }
}
async function readRefereesByReferrerPageFromChain(cardAddress, referrerEoaOrAa, offset, pageSize) {
    try {
        if (!ethers_1.ethers.isAddress(referrerEoaOrAa))
            return { ok: false };
        const { card, provider } = await cardReferrerReadContract(cardAddress);
        const keys = await resolveReferrerRegistryLookupKeys(provider, referrerEoaOrAa);
        if (keys.length === 0)
            return { ok: false };
        let referrerLookup = keys[0];
        let page = null;
        for (const key of keys) {
            try {
                const tuple = (await card.getRefereesByReferrerPage(key, BigInt(offset), BigInt(pageSize)));
                page = tuple;
                referrerLookup = key;
                if ((bigintToCount(tuple[2]) ?? 0) > 0)
                    break;
            }
            catch {
                /* try next key */
            }
        }
        if (!page)
            return { ok: false };
        const [referees, chargeTotals, total, nextOffset] = page;
        const referrerEoa = await resolveReferrerRegistryAaToEoa(provider, referrerLookup);
        const refereeEoas = await mapAaListToEoa(provider, referees);
        return {
            ok: true,
            referrerEoa,
            referees: refereeEoas.map((refereeEoa, i) => ({
                refereeAa: refereeEoa,
                referrerAa: referrerEoa,
                refereeChargePointsTotal6: chargeTotals[i] != null ? chargeTotals[i].toString() : null,
            })),
            total: bigintToCount(total) ?? referees.length,
            nextOffset: bigintToCount(nextOffset) ?? offset + referees.length,
        };
    }
    catch {
        return { ok: false };
    }
}
async function readRegisteredRefereesPageFromChain(cardAddress, offset, pageSize) {
    try {
        const { card, provider } = await cardReferrerReadContract(cardAddress);
        const [referees, total, nextOffset] = (await card.getRegisteredRefereesPage(BigInt(offset), BigInt(pageSize)));
        const items = await Promise.all(referees.map(async (addr) => {
            const refereeAaOnChain = ethers_1.ethers.getAddress(addr);
            const refereeEoa = await resolveReferrerRegistryAaToEoa(provider, refereeAaOnChain);
            let referrerEoa = null;
            try {
                const up = ethers_1.ethers.getAddress((await card.refereeReferrer(refereeAaOnChain)));
                if (up !== ethers_1.ethers.ZeroAddress) {
                    referrerEoa = await resolveReferrerRegistryAaToEoa(provider, up);
                }
            }
            catch {
                referrerEoa = null;
            }
            return { refereeAa: refereeEoa, referrerAa: referrerEoa };
        }));
        return {
            ok: true,
            referees: items,
            total: bigintToCount(total) ?? items.length,
            nextOffset: bigintToCount(nextOffset) ?? offset + items.length,
        };
    }
    catch {
        return { ok: false };
    }
}
