import assert from 'node:assert/strict'
import test from 'node:test'
import { ethers } from 'ethers'
import {
	CHAT_ROUTE_SIGN_MAX_SKEW_MS,
	ChatRouteReplayGuard,
	buildRegiestChatRouteMessage,
	regiestChatRoutePreCheck,
} from './chatRouteAuth.ts'

const owner = ethers.Wallet.createRandom()
const other = ethers.Wallet.createRandom()

const fields = {
	keyID: 'D153C4294B9BDB31',
	publicKeyArmored: 'LS0tLS1CRUdJTiBQR1AgUFVCTElDIEtFWSBCTE9DSy0tLS0t',
	encrypKeyArmored: 'aes-gcm-blob-base64==',
	routeKeyID: 'F36E92ECD8F5FCD1',
}

async function signedBody(opts: {
	signer?: ethers.HDNodeWallet
	wallet?: string
	timestamp?: number
	nonce?: string
	overrides?: Partial<typeof fields>
} = {}) {
	const signer = opts.signer ?? owner
	const wallet = opts.wallet ?? owner.address
	const timestamp = opts.timestamp ?? Date.now()
	const nonce = opts.nonce ?? ethers.hexlify(ethers.randomBytes(16))
	const msg = buildRegiestChatRouteMessage({ wallet, ...fields, timestamp, nonce })
	const signature = await signer.signMessage(msg)
	return { wallet, ...fields, ...(opts.overrides ?? {}), timestamp, nonce, signature }
}

test('valid owner signature passes and payload is normalized', async () => {
	const body = await signedBody()
	const r = regiestChatRoutePreCheck({ ...body, keyID: `  ${body.keyID} ` })
	assert.equal(r.ok, true)
	if (r.ok) {
		assert.equal(r.payload.wallet, owner.address.toLowerCase())
		assert.equal(r.payload.keyID, fields.keyID)
		assert.equal(r.payload.routeKeyID, fields.routeKeyID)
	}
})

test('timestamp in seconds is rejected (must be unix ms)', async () => {
	const body = await signedBody({ timestamp: Math.floor(Date.now() / 1000) })
	const r = regiestChatRoutePreCheck(body)
	assert.equal(r.ok, false)
	if (!r.ok) assert.equal(r.status, 400)
})

test('missing signature is rejected (no unsigned legacy path)', async () => {
	const { signature: _s, ...unsigned } = await signedBody()
	const r = regiestChatRoutePreCheck(unsigned)
	assert.equal(r.ok, false)
	if (!r.ok) assert.equal(r.error, 'Missing signature')
	const legacy = regiestChatRoutePreCheck({ wallet: owner.address, ...fields })
	assert.equal(legacy.ok, false)
})

test('malformed signature is rejected', async () => {
	const body = await signedBody()
	const r = regiestChatRoutePreCheck({ ...body, signature: '0xdeadbeef' })
	assert.equal(r.ok, false)
	if (!r.ok) assert.equal(r.status, 401)
})

test('signature by another wallet is rejected (address mismatch)', async () => {
	const body = await signedBody({ signer: other, wallet: owner.address })
	const r = regiestChatRoutePreCheck(body)
	assert.equal(r.ok, false)
	if (!r.ok) {
		assert.equal(r.status, 403)
		assert.equal(r.error, 'Signature does not match wallet')
	}
})

test('every signed field is bound: tampering any of them fails', async () => {
	const body = await signedBody()
	const tampered: Record<string, unknown>[] = [
		{ ...body, wallet: other.address },
		{ ...body, keyID: 'AAAAAAAAAAAAAAAA' },
		{ ...body, publicKeyArmored: `${body.publicKeyArmored}x` },
		{ ...body, encrypKeyArmored: `${body.encrypKeyArmored}x` },
		{ ...body, routeKeyID: 'B6FF020087998A06' },
		{ ...body, timestamp: body.timestamp + 1 },
		{ ...body, nonce: ethers.hexlify(ethers.randomBytes(16)) },
	]
	for (const t of tampered) {
		const r = regiestChatRoutePreCheck(t)
		assert.equal(r.ok, false, `tampered field accepted: ${JSON.stringify(t).slice(0, 80)}`)
	}
})

test('expired and future timestamps are rejected', async () => {
	const now = Date.now()
	const old = await signedBody({ timestamp: now - CHAT_ROUTE_SIGN_MAX_SKEW_MS - 1000 })
	const future = await signedBody({ timestamp: now + CHAT_ROUTE_SIGN_MAX_SKEW_MS + 1000 })
	for (const b of [old, future]) {
		const r = regiestChatRoutePreCheck(b, now)
		assert.equal(r.ok, false)
		if (!r.ok) assert.equal(r.error, 'Expired timestamp')
	}
	const edge = await signedBody({ timestamp: now - CHAT_ROUTE_SIGN_MAX_SKEW_MS + 1000 })
	assert.equal(regiestChatRoutePreCheck(edge, now).ok, true)
})

test('bad nonce format is rejected', async () => {
	const body = await signedBody({ nonce: '0x1234' })
	assert.equal(regiestChatRoutePreCheck(body).ok, false)
})

test('replay of an accepted request is rejected by the master guard', async () => {
	const guard = new ChatRouteReplayGuard()
	const body = await signedBody()
	const r1 = regiestChatRoutePreCheck(body)
	assert.equal(r1.ok, true)
	if (!r1.ok) return
	assert.equal(guard.claim(r1.payload.wallet, r1.payload.nonce, r1.payload.timestamp), true)
	// Same request again (also with different address/nonce case) → replay.
	const r2 = regiestChatRoutePreCheck({ ...body, wallet: body.wallet.toUpperCase().replace('0X', '0x') })
	assert.equal(r2.ok, true)
	if (!r2.ok) return
	assert.equal(guard.claim(r2.payload.wallet, r2.payload.nonce.toUpperCase(), r2.payload.timestamp), false)
	// A fresh signed request from the same wallet still works.
	const fresh = regiestChatRoutePreCheck(await signedBody())
	assert.equal(fresh.ok, true)
	if (fresh.ok) assert.equal(guard.claim(fresh.payload.wallet, fresh.payload.nonce, fresh.payload.timestamp), true)
})

test('replay guard forgets entries only after they can no longer pass the timestamp check', () => {
	const guard = new ChatRouteReplayGuard(1000)
	const t0 = 2_000_000_000_000
	assert.equal(guard.claim('0xabc', '0x01', t0, t0), true)
	assert.equal(guard.claim('0xabc', '0x01', t0, t0 + 999), false)
	assert.equal(guard.claim('0xabc', '0x01', t0, t0 + 1001), true)
	assert.equal(guard.size, 1)
})

test('released nonce (chain write never sent) can be retried', () => {
	const guard = new ChatRouteReplayGuard()
	const now = Date.now()
	assert.equal(guard.claim('0xAbC', '0xAA', now, now), true)
	guard.release('0xabc', '0xaa')
	assert.equal(guard.claim('0xabc', '0xaa', now, now), true)
	assert.equal(guard.claim('0xabc', '0xaa', now, now), false)
})
