import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyChargeFeeCardBinding, verifyChargePayeeMatchesCardOwner } from './chargeFeeCardGuard.ts'

const CARD = '0x0000000000000000000000000000000000000c01'
const OTHER_CARD = '0x0000000000000000000000000000000000000c02'
const OWNER_EOA = '0x00000000000000000000000000000000000000e1'
const OWNER_AA = '0x00000000000000000000000000000000000000a1'
const STRANGER = '0x00000000000000000000000000000000000000f9'
const noTerminals = async () => [] as string[]

test('binding: a bound card is accepted and returned checksummed; the lookup is called with that card', async () => {
	const seen: string[] = []
	const v = await verifyChargeFeeCardBinding({
		merchantCardAddress: CARD.toLowerCase(),
		lookupBinding: async (c) => {
			seen.push(c)
			return true
		},
	})
	assert.equal(v.ok, true)
	assert.deepEqual(seen.map((x) => x.toLowerCase()), [CARD])
	assert.equal(v.ok && v.cardAddress.toLowerCase(), CARD)
})

test('binding: a card with no active binding is a 4xx pos_card_not_bound, never a fallback card', async () => {
	const v = await verifyChargeFeeCardBinding({ merchantCardAddress: OTHER_CARD, lookupBinding: async () => false })
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_card_not_bound')
})

test('binding: a lookup failure is 503 pos_card_binding_unavailable, distinct from not bound', async () => {
	const v = await verifyChargeFeeCardBinding({
		merchantCardAddress: CARD,
		lookupBinding: async () => {
			throw new Error('database unavailable')
		},
	})
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_card_binding_unavailable')
})

test('binding: a missing or invalid merchantCardAddress is rejected without any lookup', async () => {
	let calls = 0
	const lookup = async () => {
		calls++
		return true
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
	assert.equal((await verifyChargePayeeMatchesCardOwner({ to: OWNER_EOA, cardAddress: CARD, resolveOwner: resolve, resolveTerminalPayees: noTerminals })).ok, true)
	assert.equal((await verifyChargePayeeMatchesCardOwner({ to: OWNER_AA, cardAddress: CARD, resolveOwner: resolve, resolveTerminalPayees: noTerminals })).ok, true)
})

test('payee: a payee that is neither the card owner EOA nor AA is rejected as pos_payee_card_mismatch', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({
		to: STRANGER,
		cardAddress: CARD,
		resolveOwner: async () => ({ eoa: OWNER_EOA, aa: OWNER_AA }),
		resolveTerminalPayees: noTerminals,
	})
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
})

test('payee: an owner read failure is 503 and never accepts the payee', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({
		to: OWNER_EOA,
		cardAddress: CARD,
		resolveTerminalPayees: noTerminals,
		resolveOwner: async () => {
			throw new Error('rpc timeout')
		},
	})
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_payee_resolve_unavailable')
})

test('payee: a malformed owner address from the resolver is 503 (never a 500, never accepted)', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({
		to: OWNER_EOA,
		cardAddress: CARD,
		resolveTerminalPayees: noTerminals,
		resolveOwner: async () => ({ eoa: 'not-an-address', aa: null }),
	})
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_payee_resolve_unavailable')
})

// 终端收款地址集合（有效绑定终端的 EOA 与其 AA）
const TERM_EOA = '0x00000000000000000000000000000000000000d1'
const TERM_AA = '0x00000000000000000000000000000000000000d2'
const ownerOnly = async () => ({ eoa: OWNER_EOA, aa: OWNER_AA })

test('terminal payee: a terminal EOA that is not the owner is accepted; its AA is accepted; owner read is consulted first', async () => {
	const seen: string[] = []
	const e = await verifyChargePayeeMatchesCardOwner({
		to: TERM_EOA,
		cardAddress: CARD,
		resolveOwner: async () => {
			seen.push('owner')
			return { eoa: OWNER_EOA, aa: OWNER_AA }
		},
		resolveTerminalPayees: async () => {
			seen.push('terminals')
			return [TERM_EOA, TERM_AA]
		},
	})
	assert.equal(e.ok, true)
	assert.deepEqual(seen, ['owner', 'terminals'])
	const a = await verifyChargePayeeMatchesCardOwner({ to: TERM_AA, cardAddress: CARD, resolveOwner: ownerOnly, resolveTerminalPayees: async () => [TERM_EOA, TERM_AA] })
	assert.equal(a.ok, true)
})

test('terminal payee: owner payee needs no terminal read', async () => {
	let terminalReads = 0
	const v = await verifyChargePayeeMatchesCardOwner({
		to: OWNER_AA,
		cardAddress: CARD,
		resolveOwner: ownerOnly,
		resolveTerminalPayees: async () => {
			terminalReads++
			return []
		},
	})
	assert.equal(v.ok, true)
	assert.equal(terminalReads, 0)
})

test('terminal payee: a payee outside the owner and the active terminal set is refused as pos_payee_card_mismatch (400)', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({ to: '0x00000000000000000000000000000000000000d9', cardAddress: CARD, resolveOwner: ownerOnly, resolveTerminalPayees: async () => [TERM_EOA, TERM_AA] })
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
})

test('terminal payee: a terminal-list read failure is 503 and the payee is never accepted', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({
		to: TERM_AA,
		cardAddress: CARD,
		resolveOwner: ownerOnly,
		resolveTerminalPayees: async () => {
			throw new Error('db unavailable')
		},
	})
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_payee_resolve_unavailable')
})

test('terminal payee: a malformed address in the terminal set is 503, never a silent drop', async () => {
	const v = await verifyChargePayeeMatchesCardOwner({ to: TERM_AA, cardAddress: CARD, resolveOwner: ownerOnly, resolveTerminalPayees: async () => ['not-an-address'] })
	assert.equal(!v.ok && v.status, 503)
})

