"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readBUnitBalanceSnapshot = readBUnitBalanceSnapshot;
const ethers_1 = require("ethers");
const chainAddresses_1 = require("./chainAddresses");
const BUINT_BALANCE_OF_ALL_ABI = [
    'function balanceOfAll(address) view returns (uint256 total, uint256 free, uint256 paid)',
];
const BUNIT_AIRDROP_BALANCE_ABI = ['function getBUnitBalance(address account) view returns (uint256)'];
const BUNIT_DECIMALS = 6;
function units6ToNumber(raw) {
    return Number(raw) / 10 ** BUNIT_DECIMALS;
}
/** 读取 canonical BUint 明细 + 扣费可用余额 + 废弃合约余额（只读）。 */
async function readBUnitBalanceSnapshot(provider, account) {
    const normalized = ethers_1.ethers.getAddress(account);
    const airdrop = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUNIT_AIRDROP_ADDRESS, BUNIT_AIRDROP_BALANCE_ABI, provider);
    const buint = new ethers_1.ethers.Contract(chainAddresses_1.CONET_BUINT, BUINT_BALANCE_OF_ALL_ABI, provider);
    let feeUsableRaw = 0n;
    let freeRaw = 0n;
    let paidRaw = 0n;
    try {
        feeUsableRaw = (await airdrop.getBUnitBalance(normalized));
    }
    catch {
        feeUsableRaw = 0n;
    }
    try {
        const [total, free, paid] = (await buint.balanceOfAll(normalized));
        freeRaw = free;
        paidRaw = paid;
        if (feeUsableRaw === 0n && total > 0n) {
            feeUsableRaw = total;
        }
    }
    catch {
        // keep feeUsable from airdrop path
    }
    const legacyDeprecatedByContract = [];
    let legacySumRaw = 0n;
    for (const depRaw of chainAddresses_1.CONET_DEPRECATED_BUINT_ADDRESSES) {
        if (!depRaw || !ethers_1.ethers.isAddress(depRaw))
            continue;
        const dep = ethers_1.ethers.getAddress(depRaw);
        if (dep.toLowerCase() === chainAddresses_1.CONET_BUINT.toLowerCase())
            continue;
        try {
            const leg = new ethers_1.ethers.Contract(dep, BUINT_BALANCE_OF_ALL_ABI, provider);
            const [total] = (await leg.balanceOfAll(normalized));
            if (total > 0n) {
                legacySumRaw += total;
                legacyDeprecatedByContract.push({ address: dep, total: units6ToNumber(total) });
            }
        }
        catch {
            // skip unreadable legacy
        }
    }
    const feeUsable = units6ToNumber(feeUsableRaw);
    return {
        feeUsable,
        total: feeUsable,
        free: units6ToNumber(freeRaw),
        paid: units6ToNumber(paidRaw),
        legacyDeprecatedTotal: units6ToNumber(legacySumRaw),
        legacyDeprecatedByContract,
    };
}
