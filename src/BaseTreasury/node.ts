/**
 * BaseTreasury event listener on Base mainnet.
 * Listens to: ERC20Transferred, ETHDeposited, ERC20Deposited, BUnitPurchased
 *
 * Uses WebSocket (wss://base-rpc.conet.network/ws) for real-time event subscription.
 *
 * Run: npm run base-treasury:listen
 * Or:  node build/BaseTreasury/node.js (after yarn build)
 *
 * Config: BASE_RPC (default: wss://base-rpc.conet.network/ws), BASE_TREASURY_ADDRESS
 */

import { ethers } from "ethers"

const BASE_RPC = process.env.BASE_RPC || "wss://base-rpc.conet.network/ws"
const BASE_TREASURY_ADDRESS = process.env.BASE_TREASURY_ADDRESS || "0x5c64a8b0935DA72d60933bBD8cD10579E1C40c58"

const BASE_TREASURY_EVENTS_ABI = [
  "event ERC20Transferred(address indexed token, address indexed to, uint256 amount)",
  "event ETHDeposited(address indexed depositor, uint256 amount)",
  "event ERC20Deposited(address indexed depositor, address indexed token, uint256 amount, bytes32 indexed nonce)",
  "event BUnitPurchased(address indexed user, address indexed usdc, uint256 amount)",
] as const

function debug(msg: string, data?: object) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [BaseTreasury] ${msg}`, data ? JSON.stringify(data, null, 2) : "")
}

async function main() {
  debug("Starting BaseTreasury event listener", {
    rpc: BASE_RPC,
    contract: BASE_TREASURY_ADDRESS,
  })

  const provider = new ethers.WebSocketProvider(BASE_RPC)
  const contract = new ethers.Contract(BASE_TREASURY_ADDRESS, BASE_TREASURY_EVENTS_ABI, provider)

  contract.on("ETHDeposited", (depositor: string, amount: bigint) => {
    debug("ETHDeposited", { depositor, amount: amount.toString() })
  })

  contract.on("ERC20Deposited", (depositor: string, token: string, amount: bigint, nonce: string) => {
    debug("ERC20Deposited", { depositor, token, amount: amount.toString(), nonce })
  })

  contract.on("BUnitPurchased", (user: string, usdc: string, amount: bigint) => {
    debug("BUnitPurchased", { user, usdc, amount: amount.toString() })
  })

  debug("Listening for events... (Ctrl+C to stop)")
}

main().catch((e) => {
  console.error("[BaseTreasury] Fatal:", e)
  process.exit(1)
})
