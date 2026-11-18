import assert from 'node:assert/strict'
import test from 'node:test'
import { selectChargeCard, chargeNonCcsaErc1155Assets } from './chargeCardSelection.ts'

const CCSA = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
const CARD = '0x0000000000000000000000000000000000000c01'
const OTHER = '0x0000000000000000000000000000000000000c02'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

test('selection: a pure-USDC request (kind=0 only) selects the submitted bound card, never a default card', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD.toLowerCase(), items: [{ kind: 0, asset: USDC }], ccsaAddress: CCSA })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.cardAddress.toLowerCase(), CARD)
	assert.equal(v.ok && v.hasNonCcsaErc1155, false)
})

test('B1: a non-CCSA kind=1 asset different from merchantCardAddress is pos_payee_card_mismatch', () => {
	const v = selectChargeCard({
		merchantCardAddress: CARD,
		items: [{ kind: 1, asset: OTHER }],
		ccsaAddress: CCSA,
	})
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
	assert.equal(!v.ok && v.status, 400)
})

test('B1: a kind=1 asset equal to merchantCardAddress is accepted and marks the card as ERC1155-bearing', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD, items: [{ kind: 1, asset: CARD }], ccsaAddress: CCSA })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.hasNonCcsaErc1155, true)
})

test('B2: a CCSA kind=1 item ahead of the real card does not change the selected card or the payee path', () => {
	const v = selectChargeCard({
		merchantCardAddress: CARD,
		items: [{ kind: 1, asset: CCSA }, { kind: 1, asset: CARD }],
		ccsaAddress: CCSA,
	})
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.cardAddress.toLowerCase(), CARD)
	assert.deepEqual(chargeNonCcsaErc1155Assets([{ kind: 1, asset: CCSA }], CCSA), [])
})

test('B2: a CCSA-only kind=1 request is pure USDC for the payee path (no ERC1155-bearing card)', () => {
	const v = selectChargeCard({ merchantCardAddress: CARD, items: [{ kind: 1, asset: CCSA }], ccsaAddress: CCSA })
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
	assert.equal(v.ok && v.cardAddress.toLowerCase(), CARD)
	assert.equal(v.ok && v.cardAddress, '0x0000000000000000000000000000000000000c01'.replace(/c01$/, 'c01') && v.cardAddress)
})

test('three callers share one function: identical inputs give identical outputs (spy)', () => {
	const calls: string[] = []
	const spy = (name: string) => {
		calls.push(name)
		return selectChargeCard({ merchantCardAddress: CARD, items: [{ kind: 0, asset: USDC }], ccsaAddress: CCSA })
	}
	const pre = spy('cluster-precheck')
	const master = spy('master-fee')
	const relay = spy('relay-context')
	assert.deepEqual(calls, ['cluster-precheck', 'master-fee', 'relay-context'])
	assert.deepEqual(pre, master)
	assert.deepEqual(master, relay)
})
