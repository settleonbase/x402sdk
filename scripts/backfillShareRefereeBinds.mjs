/**
 * Backfill beamio_card_program_referees from ShareRefereeBoundWithSignature logs.
 * Must run on the API host (DB is localhost Postgres).
 *
 * Usage:
 *   node scripts/backfillShareRefereeBinds.mjs --card 0x086b… [--from-block 930000] [--tx 0xeb99…]
 */
import { ethers } from 'ethers'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const RPC = process.env.CONET_RPC_URL || 'https://publicrpc.conet.network'
const args = process.argv.slice(2)
function arg(name, fallback = null) {
	const i = args.indexOf(name)
	if (i < 0 || i + 1 >= args.length) return fallback
	return args[i + 1]
}

const card = arg('--card')
const txOnly = arg('--tx')
const fromBlockArg = arg('--from-block')

if (!card || !ethers.isAddress(card)) {
	console.error('Usage: node scripts/backfillShareRefereeBinds.mjs --card 0x… [--from-block N] [--tx 0x…]')
	process.exit(1)
}

function loadReferrerDb() {
	try {
		return require('../dist/cardProgramReferrerDb.js')
	} catch {
		return require('../build/cardProgramReferrerDb.js')
	}
}

const {
	syncCardProgramReferrerEventsFromReceipt,
	backfillCardProgramShareRefereeBindsFromLogs,
} = loadReferrerDb()

const provider = new ethers.JsonRpcProvider(RPC)
const cardAddr = ethers.getAddress(card)

if (txOnly) {
	const receipt = await provider.getTransactionReceipt(txOnly)
	if (!receipt || receipt.status !== 1) {
		console.error('tx receipt missing or failed', txOnly)
		process.exit(1)
	}
	await syncCardProgramReferrerEventsFromReceipt({
		cardAddress: cardAddr,
		receipt,
		txHash: receipt.hash,
	})
	console.log('synced from tx', receipt.hash, 'block', receipt.blockNumber)
	process.exit(0)
}

const tip = await provider.getBlockNumber()
const fromBlock = fromBlockArg != null ? Number(fromBlockArg) : Math.max(0, tip - 50_000)
const result = await backfillCardProgramShareRefereeBindsFromLogs({
	cardAddress: cardAddr,
	provider,
	fromBlock,
	toBlock: tip,
})
console.log(JSON.stringify({ card: cardAddr, fromBlock, toBlock: tip, ...result }, null, 2))
