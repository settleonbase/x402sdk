import assert from 'node:assert/strict'
import test from 'node:test'
import { ethers } from 'ethers'
import { selectChargeCard } from './chargeCardSelection.ts'

const CCSA = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
const CARD = '0x0000000000000000000000000000000000000c01'
const OTHER = '0x0000000000000000000000000000000000000c02'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

test('selection: a pure-USDC request (kind=0 only) selects the submitted bound card, never a default card', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD.toLowerCase(), items: [{ kind: 0, asset: USDC }], ccsaAddress: CCSA })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.cardAddress, ethers.getAddress(CARD))
	assert.equal(v.ok && v.hasNonCcsaErc1155, false)
})

test('B1: a non-CCSA kind=1 asset different from merchantCardAddress is pos_payee_card_mismatch', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD, items: [{ kind: 1, asset: OTHER }], ccsaAddress: CCSA })
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
	assert.equal(!v.ok && v.status, 400)
})

test('B1: a kind=1 asset equal to merchantCardAddress is accepted and marks the card as ERC1155-bearing', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD, items: [{ kind: 1, asset: CARD }], ccsaAddress: CCSA })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.hasNonCcsaErc1155, true)
})

test('fail closed: a malformed non-CCSA kind=1 asset is rejected, never skipped', () => {
	for (const bad of ['not-an-address', '', undefined, '0x123']) {
		const v = selectChargeCard({
			merchantCardAddress: CARD,
			items: [{ kind: 0, asset: USDC }, { kind: 1, asset: bad as any }],
			ccsaAddress: CCSA,
		})
		assert.equal(v.ok, false, `asset ${String(bad)} must be rejected`)
		assert.equal(!v.ok && v.code, 'pos_card_invalid')
		assert.equal(!v.ok && v.status, 400)
	}
})

test('fail closed: a malformed kind=1 asset ahead of a valid card item is still rejected', () => {
	const v = selectChargeCard({
		merchantCardAddress: CARD,
		items: [{ kind: 1, asset: 'garbage' }, { kind: 1, asset: CARD }],
		ccsaAddress: CCSA,
	})
	assert.equal(v.ok, false)
})

test('B2: a CCSA kind=1 item ahead of the real card does not change the selected card or the payee path', () => {
	const v = selectChargeCard({
		merchantCardAddress: CARD,
		items: [{ kind: 1, asset: CCSA }, { kind: 1, asset: CARD }],
		ccsaAddress: CCSA,
	})
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.cardAddress, ethers.getAddress(CARD))
	assert.equal(v.ok && v.hasNonCcsaErc1155, true)
})

test('B2: a CCSA-only kind=1 request is pure USDC for the payee path (no ERC1155-bearing card)', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD, items: [{ kind: 1, asset: CCSA }], ccsaAddress: CCSA })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.hasNonCcsaErc1155, false)
})

test('B2: the CCSA address is compared case-insensitively', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD, items: [{ kind: 1, asset: CCSA.toLowerCase() }], ccsaAddress: CCSA })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.hasNonCcsaErc1155, false)
})

test('B4: a missing or invalid merchantCardAddress is rejected; no default card is used', () => {
	for (const bad of [undefined, null, '', 'nope', '0x123']) {
		const v = selectChargeCard({ merchantCardAddress: bad as any, items: [{ kind: 0, asset: USDC }], ccsaAddress: CCSA })
		assert.equal(v.ok, false)
		assert.equal(!v.ok && v.code, 'pos_card_invalid')
	}
})

test('B4: the selected card is always checksum-normalised', () => {
	const v = selectChargeCard({ merchantCardAddress: '  ' + CARD.toLowerCase() + ' ', items: [], ccsaAddress: CCSA })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.cardAddress, ethers.getAddress(CARD))
})

test('one function: identical inputs give identical verdicts across repeated calls', () => {
	const input = { merchantCardAddress: CARD, items: [{ kind: 0, asset: USDC }], ccsaAddress: CCSA }
	const a = selectChargeCard(input)
	const b = selectChargeCard(input)
	assert.deepEqual(a, b)
})
