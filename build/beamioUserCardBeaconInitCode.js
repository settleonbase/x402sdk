"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeBeamioUserCardInitializeCalldata = encodeBeamioUserCardInitializeCalldata;
exports.buildBeamioUserCardBeaconProxyInitCode = buildBeamioUserCardBeaconProxyInitCode;
const ethers_1 = require("ethers");
const BeamioUserCardArtifact_json_1 = __importDefault(require("./ABI/BeamioUserCardArtifact.json"));
const BeamioUserCardBeaconProxyArtifact_json_1 = __importDefault(require("./ABI/BeamioUserCardBeaconProxyArtifact.json"));
const chainAddresses_1 = require("./chainAddresses");
function userCardInterface() {
    const abi = BeamioUserCardArtifact_json_1.default.abi;
    if (!Array.isArray(abi))
        throw new Error('BeamioUserCard artifact missing abi');
    const iface = new ethers_1.ethers.Interface(abi);
    try {
        iface.getFunction('initialize');
    }
    catch {
        throw new Error('BeamioUserCard artifact is missing initialize(); run npm run compile && node scripts/syncBeamioUserCardToX402sdk.mjs');
    }
    return iface;
}
/** EIP-1167-style proxy constructor `data` = `initialize(uri, currency, priceE6, owner, gateway)`. */
function encodeBeamioUserCardInitializeCalldata(params) {
    return userCardInterface().encodeFunctionData('initialize', [
        params.uri,
        params.currencyEnum,
        params.pointsUnitPriceInCurrencyE6,
        params.initialOwner,
        params.gateway,
    ]);
}
/**
 * Factory CREATE initCode for a BeaconProxy card (address-stable).
 * Used only when `CONET_USER_CARD_BEACON` is a non-zero address (P2).
 */
async function buildBeamioUserCardBeaconProxyInitCode(params, beaconAddress) {
    const resolved = beaconAddress?.trim()
        ? ethers_1.ethers.getAddress(beaconAddress)
        : (0, chainAddresses_1.resolveConetUserCardBeaconAddress)();
    if (!resolved) {
        throw new Error('CONET_USER_CARD_BEACON is not configured. After P2 deploy set the beacon address; until then createCard uses CREATE initCode.');
    }
    const artifact = BeamioUserCardBeaconProxyArtifact_json_1.default;
    if (!artifact?.bytecode) {
        throw new Error('BeamioUserCardBeaconProxy artifact missing bytecode; run npm run compile && node scripts/syncBeamioUserCardToX402sdk.mjs');
    }
    if (artifact.linkReferences && Object.keys(artifact.linkReferences).length > 0) {
        throw new Error('BeamioUserCardBeaconProxy artifact unexpectedly has linkReferences');
    }
    const data = encodeBeamioUserCardInitializeCalldata(params);
    const factory = new ethers_1.ethers.ContractFactory(artifact.abi, artifact.bytecode);
    const deployTx = await factory.getDeployTransaction(resolved, data);
    const initCode = deployTx?.data;
    if (!initCode)
        throw new Error('Failed to build BeamioUserCardBeaconProxy initCode');
    return initCode;
}
