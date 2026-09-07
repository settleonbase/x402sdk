"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FUEL_PACK_CATALOG = void 0;
exports.lookupFuelPack = lookupFuelPack;
exports.fuelPackUsdc6 = fuelPackUsdc6;
exports.fuelPackFreeBUnits6 = fuelPackFreeBUnits6;
const ethers_1 = require("ethers");
exports.FUEL_PACK_CATALOG = [
    {
        id: 'genesis_starter',
        priceUsdc: 15,
        usdcAmount: '15',
        paidBUnits: 1500,
        freeBUnits: 500,
        firstTimeOnly: true,
    },
    {
        id: 'testing_waters',
        priceUsdc: 49,
        usdcAmount: '49',
        paidBUnits: 4900,
        freeBUnits: 245,
    },
    {
        id: 'growth',
        priceUsdc: 199,
        usdcAmount: '199',
        paidBUnits: 19900,
        freeBUnits: 1990,
    },
    {
        id: 'enterprise',
        priceUsdc: 999,
        usdcAmount: '999',
        paidBUnits: 99900,
        freeBUnits: 14985,
    },
    {
        id: 'institutional',
        priceUsdc: 4999,
        usdcAmount: '4999',
        paidBUnits: 499900,
        freeBUnits: 0,
    },
];
function lookupFuelPack(raw) {
    const id = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (!id)
        return null;
    return exports.FUEL_PACK_CATALOG.find((p) => p.id === id) ?? null;
}
function fuelPackUsdc6(pack) {
    return ethers_1.ethers.parseUnits(pack.usdcAmount, 6);
}
function fuelPackFreeBUnits6(pack) {
    return BigInt(pack.freeBUnits) * 1000000n;
}
