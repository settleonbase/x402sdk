// 收费链路的顺序与零广播验证（不加载 beamioServer / beamioMaster / MemberCard）。
// 驱动器按 beamioServer（Cluster）与 MemberCard.OpenContainerRelayProcess（Master）的同一顺序调用真实纯模块
// （chargeRelayGate / chargeCardSelection / chargeFeeCardGuard），在注入边界上计数：
//   forwardToMaster（Cluster 转发）、signer（签名）、relayHandleOps（广播）、accountingPoolPush（记账入队）。
// 设置环境变量 CHARGE_RECEIPT_OUT=<文件> 时，末尾测试会把每个场景的计数与调用顺序写入该文件（原始回执）。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { ethers } from 'ethers'

registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]s$/.test(specifier) && (context.parentURL ?? '').endsWith('.ts')) {
			return nextResolve(specifier + '.ts', context)
		}
		return nextResolve(specifier, context)
	},
})

const { admitChargeRequest, gateChargeRelay, recheckBindingBeforeBroadcast, verifyChargeFeePayer } = await import('./chargeRelayGate.ts')

const CCSA = '0x2032A363BB2cf331142391fC0DAd21D6504922C7'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CARD = '0x0000000000000000000000000000000000000c01'
const OTHER = '0x0000000000000000000000000000000000000c02'
const OWNER_EOA = '0x00000000000000000000000000000000000000e1'
const OWNER_AA = '0x00000000000000000000000000000000000000a1'
const STRANGER = '0x00000000000000000000000000000000000000f9'
const AA_FACTORY = '0x00000000000000000000000000000000000000f1'
const FEE = 5_000_000n
const K = (a: string) => a.toLowerCase()

type Read = bigint | 'throw'
type World = {
	/** 绑定查询按调用序号返回：true / false / 'throw' */
	lookup: (call: number) => boolean | 'throw'
	ownerThrows?: boolean
	balances: Record<string, Read>
	aaThrows?: boolean
	aa?: string | null
	factoryThrows?: boolean
}

type Counters = { forwardToMaster: number; signer: number; relayHandleOps: number; accountingPoolPush: number }
const zero = (): Counters => ({ forwardToMaster: 0, signer: 0, relayHandleOps: 0, accountingPoolPush: 0 })

const makeDeps = (w: World, trace: string[]) => {
	let lookupCalls = 0
	const admission = {
		lookupBinding: async (c: string) => {
			const n = lookupCalls++
			trace.push(`binding#${n}(${K(c).slice(-4)})`)
			const r = w.lookup(n)
			if (r === 'throw') throw new Error('database unavailable')
			return r
		},
		resolveOwner: async (c: string) => {
			trace.push(`owner(${K(c).slice(-4)})`)
			if (w.ownerThrows) throw new Error('owner read failed')
			return { eoa: OWNER_EOA, aa: w.aa === undefined ? OWNER_AA : w.aa }
		},
	}
	const fee = {
		feeBUnits6: FEE,
		readAaFactory: async (c: string) => {
			trace.push('gateway')
			if (w.factoryThrows) throw new Error('gateway read failed')
			return AA_FACTORY
		},
		readBUnit: async (a: string) => {
			trace.push(`bunit(${K(a).slice(-4)})`)
			const v = w.balances[K(a)] ?? 0n
			if (v === 'throw') throw new Error('rpc timeout')
			return v
		},
		readOwnerEoa: async (c: string) => {
			trace.push('owner-eoa')
			if (w.ownerThrows) throw new Error('owner read failed')
			return OWNER_EOA
		},
		resolveOwnerAa: async () => {
			trace.push('owner-aa')
			if (w.aaThrows) throw new Error('aa read failed')
			return w.aa === undefined ? OWNER_AA : w.aa
		},
	}
	return { admission, fee }
}

type Req = { card: string | null | undefined; items: { kind: number; asset: string; amount: bigint }[]; to: string }

/** Cluster（beamioServer /api/AAtoEOA，OpenContainer）：准入 → 严格费用预检 → 转发 Master。 */
const clusterSim = async (req: Req, w: World) => {
	const trace: string[] = []
	const c = zero()
	const deps = makeDeps(w, trace)
	const adm = await admitChargeRequest(
		{ merchantCardAddress: req.card, items: req.items, to: req.to, ccsaAddress: CCSA },
		deps.admission
	)
	if (!adm.ok) return { c, trace, out: { status: adm.status, code: adm.code } as const }
	const fee = await verifyChargeFeePayer({ cardAddress: adm.cardAddress, deps: deps.fee })
	if (!fee.ok) return { c, trace, out: { status: fee.status, code: fee.code } as const }
	c.forwardToMaster++
	trace.push('forwardToMaster')
	return { c, trace, out: { status: 200, card: adm.cardAddress, feeConsumer: fee.consumer } as const }
}

/** Master（MemberCard.OpenContainerRelayProcess）：广播前门禁 → 广播前绑定复核 → 广播 → 回执 → 记账入队。 */
const masterSim = async (req: Req, w: World, c: Counters, trace: string[]) => {
	const deps = makeDeps(w, trace)
	const gate = await gateChargeRelay(
		{ merchantCardAddress: req.card, items: req.items, to: req.to, ccsaAddress: CCSA },
		{ admission: deps.admission, fee: deps.fee }
	)
	if (!gate.ok) return { status: gate.status, code: gate.code, cardAddress: null as string | null }
	const recheck = await recheckBindingBeforeBroadcast(gate.cardAddress, deps.admission.lookupBinding)
	if (!recheck.ok) return { status: recheck.status, code: recheck.code, cardAddress: gate.cardAddress }
	c.signer++
	trace.push('signer')
	c.relayHandleOps++
	trace.push('relayHandleOps')
	c.accountingPoolPush++
	trace.push('accountingPoolPush')
	return { status: 200, code: undefined, cardAddress: gate.cardAddress }
}

const usdc = (amount: bigint) => [{ kind: 0, asset: USDC, amount }]
const bound = () => (() => true) as World['lookup']
const world = (over: Partial<World> = {}): World => ({ lookup: bound(), balances: { [K(CARD)]: FEE }, ...over })

const rows: { scenario: string; stage: string; status: number | string; code: string; forwardToMaster: number; signer: number; relayHandleOps: number; accountingPoolPush: number; trace: string }[] = []
const record = (scenario: string, stage: string, status: number | string, code: string | undefined, c: Counters, trace: string[]) =>
	rows.push({ scenario, stage, status, code: code ?? '-', ...c, trace: trace.join(' > ') })

const expectNoBroadcast = (c: Counters) => {
	assert.equal(c.signer, 0)
	assert.equal(c.relayHandleOps, 0)
	assert.equal(c.accountingPoolPush, 0)
}

// ---- Cluster 预检拒绝：不转 Master、不签发、不广播、不入记账 ----

test('Cluster reject: binding missing → 400 pos_card_not_bound; zero forward, sign, broadcast, accounting', async () => {
	const r = await clusterSim({ card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ lookup: () => false }))
	record('C1 binding missing', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [400, 'pos_card_not_bound'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster reject: binding read failure → 503 pos_card_binding_unavailable (not 400, not 500); zero forward and broadcast', async () => {
	const r = await clusterSim({ card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ lookup: () => 'throw' }))
	record('C2 binding read failure', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [503, 'pos_card_binding_unavailable'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster reject: card mismatch (non-CCSA ERC1155 asset != merchantCardAddress) → 400 pos_payee_card_mismatch', async () => {
	const r = await clusterSim({ card: CARD, items: [{ kind: 1, asset: OTHER, amount: 1n }], to: OWNER_EOA }, world())
	record('C3 card mismatch', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [400, 'pos_payee_card_mismatch'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster reject: malformed kind=1 asset → 400 pos_card_invalid; zero forward and broadcast', async () => {
	const r = await clusterSim({ card: CARD, items: [{ kind: 1, asset: 'garbage', amount: 1n }], to: OWNER_EOA }, world())
	record('C4 malformed asset', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [400, 'pos_card_invalid'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster reject: pure-USDC payee is neither owner EOA nor AA → 400 pos_payee_card_mismatch', async () => {
	const r = await clusterSim({ card: CARD, items: usdc(1n), to: STRANGER }, world())
	record('C5 payee mismatch', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [400, 'pos_payee_card_mismatch'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster reject: owner read failure → 503 pos_payee_resolve_unavailable; zero forward and broadcast', async () => {
	const r = await clusterSim({ card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ ownerThrows: true }))
	record('C6 owner read failure', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [503, 'pos_payee_resolve_unavailable'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster reject: trusted zero balances → 400 pos_fee_insufficient; zero forward and broadcast', async () => {
	const r = await clusterSim({ card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ balances: {} }))
	record('C7 fee insufficient (trusted zero)', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [400, 'pos_fee_insufficient'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster reject: fee balance RPC unavailable → 503 pos_fee_unavailable (distinct from trusted zero); zero forward and broadcast', async () => {
	const r = await clusterSim({ card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ balances: { [K(CARD)]: 'throw' } }))
	record('C8 fee RPC unavailable', 'cluster', r.out.status, r.out.code, r.c, r.trace)
	assert.deepEqual([r.out.status, r.out.code], [503, 'pos_fee_unavailable'])
	assert.equal(r.c.forwardToMaster, 0)
	expectNoBroadcast(r.c)
})

test('Cluster positive control: bound card, owner payee, fee sufficient → forwarded once, one card used throughout', async () => {
	const r = await clusterSim({ card: CARD.toLowerCase(), items: usdc(1n), to: OWNER_AA }, world())
	record('C9 positive control (pure USDC)', 'cluster', r.out.status, '-', r.c, r.trace)
	assert.equal(r.out.status, 200)
	assert.equal(r.out.status === 200 && r.out.card, ethers.getAddress(CARD))
	assert.equal(r.c.forwardToMaster, 1)
	expectNoBroadcast(r.c)
})

// ---- Master 广播前拒绝（即使 Cluster 已转发，Master 独立复核）----

const masterReject = async (name: string, req: Req, w: World, expect: [number, string]) => {
	const c = zero()
	const trace: string[] = []
	const out = await masterSim(req, w, c, trace)
	record(name, 'master', out.status, out.code, c, trace)
	assert.deepEqual([out.status, out.code], expect)
	expectNoBroadcast(c)
	return { c, trace, out }
}

test('Master reject: binding revoked after Cluster admission → recheck 400 pos_card_not_bound; zero broadcast', async () => {
	// 第 0 次（门禁）为真，第 1 次（广播前复核）为假：撤销发生在准入之后
	await masterReject('M1 revoked between gate and broadcast', { card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ lookup: (n) => n === 0 }), [400, 'pos_card_not_bound'])
})

test('Master reject: binding read fails at the pre-broadcast recheck → 503; zero broadcast', async () => {
	await masterReject('M2 recheck read failure', { card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ lookup: (n) => (n === 0 ? true : 'throw') }), [503, 'pos_card_binding_unavailable'])
})

test('Master reject: fee RPC unavailable → 503 before any signing or broadcast; accounting not queued', async () => {
	await masterReject('M3 fee RPC unavailable', { card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ balances: { [K(CARD)]: 'throw' } }), [503, 'pos_fee_unavailable'])
})

test('Master reject: fee trusted zero → 400 pos_fee_insufficient; zero broadcast', async () => {
	await masterReject('M4 fee insufficient (trusted zero)', { card: CARD, items: usdc(1n), to: OWNER_EOA }, world({ balances: {} }), [400, 'pos_fee_insufficient'])
})

test('Master reject: missing merchantCardAddress (no Cluster) → 400 pos_card_invalid; zero broadcast', async () => {
	await masterReject('M6 missing card at Master', { card: undefined, items: usdc(1n), to: OWNER_EOA }, world(), [400, 'pos_card_invalid'])
})

// ---- 成功路径：三处同卡，费用确认先于广播 ----

test('success path: one verified card for admission, fee and relay; fee confirmed before broadcast', async () => {
	const c = zero()
	const trace: string[] = []
	const out = await masterSim({ card: CARD.toLowerCase(), items: usdc(40n), to: OWNER_EOA }, world(), c, trace)
	record('S1 success (Master)', 'master', out.status, '-', c, trace)
	assert.equal(out.status, 200)
	assert.equal(out.cardAddress, ethers.getAddress(CARD))
	assert.equal(c.relayHandleOps, 1)
	assert.equal(c.accountingPoolPush, 1)
	const feeIdx = trace.findIndex((x) => x.startsWith('bunit('))
	const broadcastIdx = trace.indexOf('relayHandleOps')
	assert.ok(feeIdx >= 0 && feeIdx < broadcastIdx, 'fee read happens before the broadcast')
})

// ---- 单次调用中的费用与收款方读取只针对同一张卡 ----

test('the fee reads and the binding reads only ever touch the verified card (never items or a default card)', async () => {
	const trace: string[] = []
	const deps = makeDeps(world(), trace)
	const adm = await admitChargeRequest({ merchantCardAddress: CARD.toLowerCase(), items: usdc(1n), to: OWNER_EOA, ccsaAddress: CCSA }, deps.admission)
	assert.equal(adm.ok, true)
	await verifyChargeFeePayer({ cardAddress: adm.ok ? adm.cardAddress : '', deps: deps.fee })
	const cardSuffix = K(CARD).slice(-4)
	const bunitCalls = trace.filter((x) => x.startsWith('bunit('))
	assert.equal(bunitCalls[0], `bunit(${cardSuffix})`)
	assert.ok(trace.filter((x) => x.startsWith('binding#')).every((x) => x.includes(`(${cardSuffix})`)))
})

// ---- 原始回执（由环境变量触发写入）----

test('receipt: write raw per-scenario counters and call order when CHARGE_RECEIPT_OUT is set', { skip: !process.env.CHARGE_RECEIPT_OUT }, () => {
	const header = ['scenario', 'stage', 'status', 'code', 'forwardToMaster', 'signer', 'relayHandleOps', 'accountingPoolPush', 'trace'].join(' | ')
	const body = rows.map((r) => [r.scenario, r.stage, r.status, r.code, r.forwardToMaster, r.signer, r.relayHandleOps, r.accountingPoolPush, r.trace].join(' | '))
	writeFileSync(process.env.CHARGE_RECEIPT_OUT as string, [header, ...body, ''].join('\n'))
	assert.ok(rows.length >= 15)
})
