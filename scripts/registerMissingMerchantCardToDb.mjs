/**
 * Register a missing merchant card into beamio_cards so Discover `/api/latestCards` can list it.
 * Must run on the API host (Postgres is localhost).
 *
 * Usage:
 *   node scripts/registerMissingMerchantCardToDb.mjs --card 0xF4CA… [--tx 0x…] [--owner 0x…]
 */
import { ethers } from 'ethers'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const BEAMIO_CARD0_METADATA_BASE_URI = 'https://beamio.app/api/metadata/0x'
const args = process.argv.slice(2)
function arg(name, fallback = null) {
	const i = args.indexOf(name)
	if (i < 0 || i + 1 >= args.length) return fallback
	return args[i + 1]
}

const card = arg('--card')
const txHash = arg('--tx')
const ownerHint = arg('--owner')

if (!card || !ethers.isAddress(card)) {
	console.error('Usage: node scripts/registerMissingMerchantCardToDb.mjs --card 0x… [--tx 0x…] [--owner 0x…]')
	process.exit(1)
}

if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
	console.error('Invalid --tx hash')
	process.exit(1)
}

if (ownerHint && !ethers.isAddress(ownerHint)) {
	console.error('Invalid --owner address')
	process.exit(1)
}

function loadDb() {
	try {
		return require('../dist/db.js')
	} catch {
		return require('../build/db.js')
	}
}

function loadMemberCard() {
	try {
		return require('../dist/MemberCard.js')
	} catch {
		return require('../build/MemberCard.js')
	}
}

const { registerCardToDb, getBeamioCardRowForMetadataSync } = loadDb()
const { lookupOnChainMerchantCardRegistryIdentity } = loadMemberCard()

const cardAddr = ethers.getAddress(card)
const existing = await getBeamioCardRowForMetadataSync(cardAddr)
if (existing) {
	console.log(JSON.stringify({
		ok: true,
		alreadyRegistered: true,
		cardAddress: cardAddr,
		cardOwner: existing.cardOwner,
		currency: existing.currency,
		priceInCurrencyE6: existing.priceInCurrencyE6,
		txHash: existing.txHash,
	}))
	process.exit(0)
}

const lookup = await lookupOnChainMerchantCardRegistryIdentity(cardAddr)
if (lookup.status !== 'found') {
	console.error(JSON.stringify({ ok: false, error: `on-chain lookup ${lookup.status}`, cardAddress: cardAddr }))
	process.exit(1)
}

if (ownerHint && ethers.getAddress(ownerHint) !== ethers.getAddress(lookup.identity.cardOwner)) {
	console.error(JSON.stringify({
		ok: false,
		error: 'owner mismatch',
		expected: ethers.getAddress(ownerHint),
		onChain: lookup.identity.cardOwner,
	}))
	process.exit(1)
}

await registerCardToDb({
	cardAddress: cardAddr,
	cardOwner: lookup.identity.cardOwner,
	currency: lookup.identity.currency,
	priceInCurrencyE6: lookup.identity.priceInCurrencyE6,
	uri: BEAMIO_CARD0_METADATA_BASE_URI,
	preferExistingShareTokenMetadata: true,
	...(txHash ? { txHash } : {}),
})

const row = await getBeamioCardRowForMetadataSync(cardAddr)
if (!row) {
	console.error(JSON.stringify({ ok: false, error: 'register succeeded but row still missing', cardAddress: cardAddr }))
	process.exit(1)
}

console.log(JSON.stringify({
	ok: true,
	alreadyRegistered: false,
	cardAddress: cardAddr,
	cardOwner: row.cardOwner,
	currency: row.currency,
	priceInCurrencyE6: row.priceInCurrencyE6,
	txHash: row.txHash,
}, null, 2))
