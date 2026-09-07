"use strict";
/**
 * BaseTreasury event listener on Base mainnet.
 * Listens to: ERC20Transferred, ETHDeposited, ERC20Deposited, BUnitPurchased
 *
 * Uses WebSocket (wss://base-rpc.conet.network/ws) for real-time event subscription.
 *
 * Run: npm run base-treasury:listen
 * Or:  node build/BaseTreasury/node.js (after yarn build)
 *
 * Config: BASE_RPC (default: wss://base-rpc.conet.network/ws), BASE_TREASURY_ADDRESS (unified ConetTreasury CREATE2)
 */
Object.defineProperty(exports, "__esModule", { value: true });
const ethers_1 = require("ethers");
const BASE_RPC = process.env.BASE_RPC || "wss://base-rpc.conet.network/ws";
const BASE_TREASURY_ADDRESS = process.env.BASE_TREASURY_ADDRESS || "0xa311c8fBE7CafC611603Ee925465A62493B73B30";
const BASE_TREASURY_EVENTS_ABI = [
    "event ERC20Transferred(address indexed token, address indexed to, uint256 amount)",
    "event ETHDeposited(address indexed depositor, uint256 amount)",
    "event ERC20Deposited(address indexed depositor, address indexed token, uint256 amount, bytes32 indexed nonce)",
    "event BUnitPurchased(address indexed user, address indexed usdc, uint256 amount)",
];
function debug(msg, data) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [BaseTreasury] ${msg}`, data ? JSON.stringify(data, null, 2) : "");
}
async function main() {
    debug("Starting BaseTreasury event listener", {
        rpc: BASE_RPC,
        contract: BASE_TREASURY_ADDRESS,
    });
    const provider = new ethers_1.ethers.WebSocketProvider(BASE_RPC);
    const contract = new ethers_1.ethers.Contract(BASE_TREASURY_ADDRESS, BASE_TREASURY_EVENTS_ABI, provider);
    contract.on("ETHDeposited", (depositor, amount) => {
        debug("ETHDeposited", { depositor, amount: amount.toString() });
    });
    contract.on("ERC20Deposited", (depositor, token, amount, nonce) => {
        debug("ERC20Deposited", { depositor, token, amount: amount.toString(), nonce });
    });
    contract.on("BUnitPurchased", (user, usdc, amount) => {
        debug("BUnitPurchased", { user, usdc, amount: amount.toString() });
    });
    debug("Listening for events... (Ctrl+C to stop)");
}
main().catch((e) => {
    console.error("[BaseTreasury] Fatal:", e);
    process.exit(1);
});
