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

const { admitChargeRequest } = await import('./chargeRelayGate.ts')

const CCSA = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CARD = '0x0000000000000000000000000000000000000c01'
const OTHER = '0x0000000000000000000000000000000000000c02'
const OWNER_EOA = '0x00000000000000000000000000000000000000e1'
const OWNER_AA = '0x00000000000000000000000000000000000000a1'
const STRANGER = '0x00000000000000000000000000000000000000f9'
const usdcItems = [{ kind: 0, asset: USDC }]

const harness = (over: { bound?: boolean | 'throw'; owner?: any; ownerThrows?: boolean } = {}) => {
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
	assert.deepEqual(h.trace, ['lookup', 'owner'])
})

test('no default-card fallback: the binding is checked only for the requested card, never for another card', async () => {
	const h = harness()
	await admitChargeRequest({ merchantCardAddress: OTHER, items: usdcItems, to: OWNER_EOA, ccsaAddress: CCSA }, h.deps)
	assert.deepEqual(h.args.lookup, [ethers.getAddress(OTHER)])
})

test('an unexpected throw inside the admission is contained as 503 (route never sees a 500)', async () => {
	const v = await admitChargeRequest(
		{ merchantCardAddress: CARD, items: usdcItems, to: OWNER_EOA, ccsaAddress: 'not-an-address' },
		{ lookupBinding: async () => true, resolveOwner: async () => ({ eoa: OWNER_EOA, aa: null }) }
	)
	assert.equal(!v.ok && v.status, 503)
	assert.equal(!v.ok && v.code, 'pos_admission_unavailable')
})
