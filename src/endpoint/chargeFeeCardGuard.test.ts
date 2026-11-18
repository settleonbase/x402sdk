import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyChargeFeeCardBinding, verifyChargePayeeMatchesCardOwner } from './chargeFeeCardGuard.ts'

const CARD = '0x0000000000000000000000000000000000000c01'
const OTHER_CARD = '0x0000000000000000000000000000000000000c02'
const OWNER_EOA = '0x00000000000000000000000000000000000000e1'
const OWNER_AA = '0x00000000000000000000000000000000000000a1'
const STRANGER = '0x00000000000000000000000000000000000000f9'

test('binding: a bound card is accepted and returned checksummed; the lookup is called with that card', async () => {
	const seen: string[] = []
	const v = await verifyChargeFeeCardBinding({
		merchantCardAddress: CARD.toLowerCase(),
		lookupBinding: async (c) => {
			seen.push(c)
			return 'bound'
		},
	})
	assert.equal(v.ok, true)
	assert.deepEqual(seen.map((x) => x.toLowerCase()), [CARD])
	assert.equal(v.ok && v.cardAddress.toLowerCase(), CARD)
})

test('binding: a card with no active binding is a 4xx pos_card_not_bound, never a fallback card', async () => {
	const v = await verifyChargeFeeCardBinding({ merchantCardAddress: OTHER_CARD, lookupBinding: async () => 'not_bound' })
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_card_not_bound')
})

test('binding: a lookup failure is 503 pos_card_binding_unavailable, distinct from not bound', async () => {
	const v = await verifyChargeFeeCardBinding({ merchantCardAddress: CARD, lookupBinding: async () => 'unavailable' })
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_card_binding_unavailable')
})

test('binding: a missing or invalid merchantCardAddress is rejected without any lookup', async () => {
	let calls = 0
	const lookup = async () => {
		calls++
		return 'bound' as const
	}
	for (const bad of [undefined, null, '', 'not-an-address']) {
		const v = await verifyChargeFeeCardBinding({ merchantCardAddress: bad as any, lookupBinding: lookup })
		assert.equal(v.ok, false)
		assert.equal(!v.ok && v.code, 'pos_card_invalid')
	}
	assert.equal(calls, 0)
})

test('payee: a pure-USDC payee equal to the card owner EOA or AA is accepted', async () => {
	const resolve = async () => ({ eoa: OWNER_EOA, aa: OWNER_AA })
	assert.equal((await verifyChargePayeeMatchesCardOwner({ to: OWNER_EOA, cardAddress: CARD, resolveOwner: resolve })).ok, true)
	assert.equal((await verifyChargePayeeMatchesCardOwner({ to: OWNER_AA, cardAddress: CARD, resolveOwner: resolve })).ok, true)
})

test('payee: a payee that is neither the card owner EOA nor AA is rejected as pos_payee_card_mismatch', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({
		to: STRANGER,
		cardAddress: CARD,
		resolveOwner: async () => ({ eoa: OWNER_EOA, aa: OWNER_AA }),
	})
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
})

test('payee: an owner read failure is 503 and never accepts the payee', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({
		to: OWNER_EOA,
		cardAddress: CARD,
		resolveOwner: async () => {
			throw new Error('rpc timeout')
		},
	})
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_payee_resolve_unavailable')
})
