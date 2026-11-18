// 收费准入的顺序与拒绝语义（纯函数，注入桩；不加载 beamioServer / beamioMaster / MemberCard；不触达网络与数据库）。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { ethers } from 'ethers'

// 生产文件使用无扩展名的相对导入（tsconfig 为 CJS nodenext）；测试运行器需要补上 .ts。
registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]s$/.test(specifier) && (context.parentURL ?? '').endsWith('.ts')) {
			return nextResolve(specifier + '.ts', context)
		}
		return nextResolve(specifier, context)
	},
})

const { admitChargeRequest, verifyChargeFeePayer, recheckBindingBeforeBroadcast, gateChargeRelay } = await import('./chargeRelayGate.ts')

const CCSA = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CARD = '0x0000000000000000000000000000000000000c01'
const OTHER = '0x0000000000000000000000000000000000000c02'
const OWNER_EOA = '0x00000000000000000000000000000000000000e1'
const OWNER_AA = '0x00000000000000000000000000000000000000a1'
const STRANGER = '0x00000000000000000000000000000000000000f9'
const usdcItems = [{ kind: 0, asset: USDC }]

const harness = (over: { bound?: boolean | 'throw'; owner?: any; ownerThrows?: boolean; terminals?: string[] | 'throw' } = {}) => {
	const trace: string[] = []
	const args: Record<string, unknown[]> = { lookup: [], owner: [] }
	return {
		trace,
		args,
		deps: {
			lookupBinding: async (c: string) => {
				trace.push('lookup')
				args.lookup.push(c)
				if (over.bound === 'throw') throw new Error('database unavailable')
				return over.bound ?? true
			},
			resolveOwner: async (c: string) => {
				trace.push('owner')
				args.owner.push(c)
				if (over.ownerThrows) throw new Error('rpc timeout')
				return over.owner ?? { eoa: OWNER_EOA, aa: OWNER_AA }
			},
			resolveTerminalPayees: async () => {
				trace.push('terminals')
				if (over.terminals === 'throw') throw new Error('terminal read failed')
				return over.terminals ?? []
			},
		},
	}
}

test('admission: a bound card with a pure-USDC payee equal to the owner EOA is admitted, returning the checksummed card', async () => {
	const h = harness()
	const v = await admitChargeRequest({ merchantCardAddress: CARD.toLowerCase(), items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.cardAddress, ethers.getAddress(CARD))
	assert.equal(v.ok && v.hasNonCcsaErc1155, false)
})

test('admission: a pure-USDC payee equal to the owner AA is admitted', async () => {
	const h = harness()
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: OWNER_AA, ccsaAddress: CCSA }, h.deps)
	assert.equal(v.ok, true)
})

test('order: selection, then binding, then payee; the lookup and owner resolver receive the same checksummed card', async () => {
	const h = harness()
	const v = await admitChargeRequest({ merchantCardAddress: CARD.toLowerCase(), items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.equal(v.ok, true)
	assert.deepEqual(h.trace, ['lookup', 'owner'])
	assert.deepEqual(h.args.lookup, [ethers.getAddress(CARD)])
	assert.deepEqual(h.args.owner, [ethers.getAddress(CARD)])
	assert.equal(v.ok && v.cardAddress, h.args.lookup[0])
})

test('binding miss: 400 pos_card_not_bound; the payee resolver is never called', async () => {
	const h = harness({ bound: false })
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_card_not_bound')
	assert.deepEqual(h.trace, ['lookup'])
})

test('binding lookup throws: 503 pos_card_binding_unavailable, never a 4xx and never a 500; nothing after it runs', async () => {
	const h = harness({ bound: 'throw' })
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_card_binding_unavailable')
	assert.deepEqual(h.trace, ['lookup'])
})

test('binding lookup throws synchronously: still 503 (contained by the admission)', async () => {
	const v = await admitChargeRequest(
		{ merchantCardAddress: CARD, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA },
		{
			lookupBinding: ((_c: string) => {
				throw new Error('sync failure')
			}) as any,
			resolveOwner: async () => ({ eoa: OWNER_EOA, aa: null }),
			resolveTerminalPayees: async () => [],
		}
	)
	assert.equal(!v.ok && v.status, 503)
})

test('owner read throws: 503 pos_payee_resolve_unavailable; the payee is never accepted', async () => {
	const h = harness({ ownerThrows: true })
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_payee_resolve_unavailable')
})

test('owner resolver returns a malformed address: 503 (never a 500, never accepted)', async () => {
	const h = harness({ owner: { eoa: 'not-an-address', aa: null } })
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_payee_resolve_unavailable')
})

test('payee that is neither the owner EOA nor AA: 400 pos_payee_card_mismatch', async () => {
	const h = harness()
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: STRANGER, ccsaAddress: CCSA }, h.deps)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
})

test('missing or malformed merchantCardAddress: 400 pos_card_invalid; neither the binding nor the owner is read', async () => {
	for (const bad of [undefined, null, '', 'nope']) {
		const h = harness()
		const v = await admitChargeRequest({ merchantCardAddress: bad as any, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
		assert.equal(!v.ok && v.code, 'pos_card_invalid')
		assert.deepEqual(h.trace, [])
	}
})

test('fail closed: a malformed non-CCSA kind=1 asset is 400 pos_card_invalid before any read', async () => {
	const h = harness()
	const v = await admitChargeRequest(
		{ merchantCardAddress: CARD, items: [{ kind: 0, asset: USDC }, { kind: 1, asset: 'garbage' }], to: OWNER_EOA, ccsaAddress: CCSA },
		h.deps
	)
	assert.equal(!v.ok && v.code, 'pos_card_invalid')
	assert.deepEqual(h.trace, [])
})

test('card-bearing request (non-CCSA kind=1 equal to the card): binding still required; the payee is rewritten by the caller, so no to-check', async () => {
	const h = harness()
	const v = await admitChargeRequest(
		{ merchantCardAddress: CARD, items: [{ kind: 1, asset: CARD }], to: STRANGER, ccsaAddress: CCSA },
		h.deps
	)
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.hasNonCcsaErc1155, true)
	assert.deepEqual(h.trace, ['lookup'])
})

test('CCSA-only kind=1 items are pure USDC for the payee path (the to-check applies)', async () => {
	const h = harness()
	const v = await admitChargeRequest(
		{ merchantCardAddress: CARD, items: [{ kind: 1, asset: CCSA }], to: STRANGER, ccsaAddress: CCSA },
		h.deps
	)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
	assert.deepEqual(h.trace, ['lookup', 'owner', 'terminals'])
})

test('no default-card fallback: the binding is checked only for the requested card, never for another card', async () => {
	const h = harness()
	await admitChargeRequest({ merchantCardAddress: OTHER, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.deepEqual(h.args.lookup, [ethers.getAddress(OTHER)])
})

test('an unexpected throw inside the admission is contained as 503 (route never sees a 500)', async () => {
	const v = await admitChargeRequest(
		{ merchantCardAddress: CARD, items: usdcItems, to: OWNER_EOA, ccsaAddress: 'not-an-address' },
		{ lookupBinding: async () => true, resolveOwner: async () => ({ eoa: OWNER_EOA, aa: null }), resolveTerminalPayees: async () => [] }
	)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_admission_unavailable')
})

// ---------------------------------------------------------------------------
// Master 广播前：费用付款人（严格）、广播前绑定复核、单一准入入口。
// ---------------------------------------------------------------------------

const FEE = 5_000_000n
const AA = '0x00000000000000000000000000000000000000a7'
const AA_FACTORY = '0x00000000000000000000000000000000000000f1'

const feeHarness = (balances: Record<string, bigint | 'throw' | 'junk'>, over: { factory?: 'throw'; owner?: 'throw'; aa?: string | null | 'throw' } = {}) => {
	const trace: string[] = []
	return {
		trace,
		deps: {
			feeBUnits6: FEE,
			readAaFactory: async (c: string) => {
				trace.push('factory')
				if (over.factory === 'throw') throw new Error('gateway read failed')
				return AA_FACTORY
			},
			readBUnit: async (addr: string) => {
				trace.push('bunit:' + addr.toLowerCase().slice(-4))
				const v = balances[addr.toLowerCase()]
				if (v === 'throw') throw new Error('rpc timeout')
				if (v === 'junk') return 'not-a-bigint' as any
				return v ?? 0n
			},
			readOwnerEoa: async (c: string) => {
				trace.push('owner')
				if (over.owner === 'throw') throw new Error('owner read failed')
				return OWNER_EOA
			},
			resolveOwnerAa: async (_c: string, _f: string, _e: string) => {
				trace.push('ownerAa')
				if (over.aa === 'throw') throw new Error('aa read failed')
				return over.aa === undefined ? AA : (over.aa as string | null)
			},
		},
	}
}
const K = (a: string) => a.toLowerCase()

test('fee: card balance sufficient is the consumer; no owner or AA read happens', async () => {
	const h = feeHarness({ [K(CARD)]: FEE })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(v.ok, true)
	assert.equal(v.ok && v.source, 'card')
	assert.equal(v.ok && v.consumer, CARD)
	assert.deepEqual(h.trace, ['factory', 'bunit:0c01'])
})

test('fee: card short, owner EOA sufficient is the consumer (EOA before AA)', async () => {
	const h = feeHarness({ [K(CARD)]: 0n, [K(OWNER_EOA)]: FEE })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(v.ok && v.source, 'owner_eoa')
	assert.equal(v.ok && v.consumer, OWNER_EOA)
	assert.ok(!h.trace.includes('ownerAa'))
})

test('fee: card and EOA short, owner AA sufficient is the consumer', async () => {
	const h = feeHarness({ [K(CARD)]: 0n, [K(OWNER_EOA)]: 0n, [K(AA)]: FEE })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(v.ok && v.source, 'owner_aa')
	assert.equal(v.ok && v.consumer, AA)
})

test('fee: every balance read succeeds and is short → 400 pos_fee_insufficient (a trusted zero, not 503)', async () => {
	const h = feeHarness({ [K(CARD)]: 1n, [K(OWNER_EOA)]: 2n, [K(AA)]: 3n })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(v.ok, false)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_fee_insufficient')
})

test('fee: no AA for the owner and every balance short → 400 pos_fee_insufficient', async () => {
	const h = feeHarness({}, { aa: null })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(!v.ok && v.code, 'pos_fee_insufficient')
})

test('fee: a card balance read failure is 503 pos_fee_unavailable and no owner read follows', async () => {
	const h = feeHarness({ [K(CARD)]: 'throw' })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_fee_unavailable')
	assert.ok(!h.trace.includes('owner'))
})

test('fee: a gateway (AA factory) read failure is 503, even when the card balance is sufficient', async () => {
	const h = feeHarness({ [K(CARD)]: FEE }, { factory: 'throw' })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(!v.ok && v.status, 503)
})

test('fee: an owner read failure is 503 (never treated as insufficient)', async () => {
	const h = feeHarness({ [K(CARD)]: 0n }, { owner: 'throw' })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(!v.ok && v.status, 503)
})

test('fee: an EOA balance read failure is 503 (never treated as insufficient)', async () => {
	const h = feeHarness({ [K(CARD)]: 0n, [K(OWNER_EOA)]: 'throw' })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(!v.ok && v.status, 503)
})

test('fee: an AA read failure is 503 (never treated as insufficient)', async () => {
	const h = feeHarness({ [K(CARD)]: 0n, [K(OWNER_EOA)]: 0n }, { aa: 'throw' })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(!v.ok && v.status, 503)
})

test('fee: a non-bigint balance is a read failure (503), never a zero', async () => {
	const h = feeHarness({ [K(CARD)]: 'junk' })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: h.deps })
	assert.equal(!v.ok && v.status, 503)
})

test('fee: a non-positive fee is a configuration failure (503), never a free charge', async () => {
	const h = feeHarness({ [K(CARD)]: 10n })
	const v = await verifyChargeFeePayer({ cardAddress: CARD, deps: { ...h.deps, feeBUnits6: 0n } })
	assert.equal(!v.ok && v.status, 503)
})

test('recheck before broadcast: bound → ok; no binding → 400; lookup throw → 503; malformed card → 400 without lookup', async () => {
	assert.equal((await recheckBindingBeforeBroadcast(CARD, async () => true)).ok, true)
	const miss = await recheckBindingBeforeBroadcast(CARD, async () => false)
	assert.equal(!miss.ok && miss.code, 'pos_card_not_bound')
	const down = await recheckBindingBeforeBroadcast(CARD, async () => {
		throw new Error('db down')
	})
	assert.equal(!down.ok && down.status, 503)
	let called = 0
	const bad = await recheckBindingBeforeBroadcast('nope', async () => {
		called++
		return true
	})
	assert.equal(!bad.ok && bad.code, 'pos_card_invalid')
	assert.equal(called, 0)
})

test('gateChargeRelay: admission rejection stops before fee reads', async () => {
	const h = harness({ bound: false })
	const fh = feeHarness({ [K(CARD)]: FEE })
	const v = await gateChargeRelay(
		{ merchantCardAddress: CARD, items: [{ kind: 0, asset: USDC, amount: 1n }], to: OWNER_EOA, ccsaAddress: CCSA },
		{ admission: h.deps, fee: fh.deps }
	)
	assert.equal(!v.ok && v.code, 'pos_card_not_bound')
	assert.deepEqual(fh.trace, [])
})

test('gateChargeRelay: fee shortfall is a 4xx; fee read failure is 503', async () => {
	const short = await gateChargeRelay(
		{ merchantCardAddress: CARD, items: [{ kind: 0, asset: USDC, amount: 1n }], to: OWNER_EOA, ccsaAddress: CCSA },
		{ admission: harness().deps, fee: feeHarness({}).deps }
	)
	assert.equal(!short.ok && short.status, 400)
	assert.equal(!short.ok && short.code, 'pos_fee_insufficient')
	const down = await gateChargeRelay(
		{ merchantCardAddress: CARD, items: [{ kind: 0, asset: USDC, amount: 1n }], to: OWNER_EOA, ccsaAddress: CCSA },
		{ admission: harness().deps, fee: feeHarness({ [K(CARD)]: 'throw' }).deps }
	)
	assert.equal(!down.ok && down.status, 503)
})

test('gateChargeRelay: success returns one frozen verdict carrying the verified card, the fee consumer and the cap', async () => {
	const v = await gateChargeRelay(
		{ merchantCardAddress: CARD.toLowerCase(), items: [{ kind: 0, asset: USDC, amount: 1n }], to: OWNER_EOA, ccsaAddress: CCSA },
		{ admission: harness().deps, fee: feeHarness({ [K(CARD)]: FEE }).deps }
	)
	assert.equal(v.ok, true)
	if (!v.ok) return
	assert.equal(v.cardAddress, ethers.getAddress(CARD))
	assert.equal(v.feeConsumer, ethers.getAddress(CARD))
	assert.equal(Object.isFrozen(v), true)
})

test('gateChargeRelay: empty items are refused as pos_items_required before any read (Master defence, no Cluster reliance)', async () => {
	const h = harness()
	const fh = feeHarness({ [K(CARD)]: FEE })
	const v = await gateChargeRelay(
		{ merchantCardAddress: CARD, items: [], to: OWNER_EOA, ccsaAddress: CCSA, maxAmount: 0n },
		{ admission: h.deps, fee: fh.deps }
	)
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_items_required')
	assert.deepEqual(h.trace, [])
	assert.deepEqual(fh.trace, [])
})

// ---- 纯 USDC 收款方：卡 owner，或该卡有效绑定终端（EOA 或其 AA）----

test('payee: an active bound terminal EOA (not the owner) is accepted; the terminal AA is accepted too', async () => {
	const TERM_EOA = '0x00000000000000000000000000000000000000d1'
	const TERM_AA = '0x00000000000000000000000000000000000000d2'
	const v1 = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: TERM_EOA, ccsaAddress: CCSA },
		{ ...harness({ terminals: [TERM_EOA, TERM_AA] }).deps })
	assert.equal(v1.ok, true)
	const v2 = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: TERM_AA, ccsaAddress: CCSA },
		{ ...harness({ terminals: [TERM_EOA, TERM_AA] }).deps })
	assert.equal(v2.ok, true)
})

test('payee: the AA of an unbound terminal is refused as pos_payee_card_mismatch (400)', async () => {
	const UNBOUND_AA = '0x00000000000000000000000000000000000000d9'
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: UNBOUND_AA, ccsaAddress: CCSA },
		{ ...harness({ terminals: ['0x00000000000000000000000000000000000000d1'] }).deps })
	assert.equal(!v.ok && v.status, 400)
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
})

test('payee: a deactivated terminal is absent from the active set, so its AA is refused (400)', async () => {
	const DEACTIVATED_AA = '0x00000000000000000000000000000000000000d3'
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: DEACTIVATED_AA, ccsaAddress: CCSA },
		{ ...harness({ terminals: [] }).deps })
	assert.equal(!v.ok && v.code, 'pos_payee_card_mismatch')
})

test('payee: a terminal-list read failure is 503 pos_payee_resolve_unavailable, never accepted', async () => {
	const v = await admitChargeRequest({ merchantCardAddress: CARD, items: usdcItems, to: '0x00000000000000000000000000000000000000d1', ccsaAddress: CCSA },
		{ ...harness({ terminals: 'throw' }).deps })
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_payee_resolve_unavailable')
})

