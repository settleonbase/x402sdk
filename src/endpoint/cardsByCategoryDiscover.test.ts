import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { BeamioLatestCardItem } from '../db.ts'

// 仓库源码使用无扩展名的导入（tsc nodenext 下可解析），node:test 的 ESM 解析不接受。
// 仅在本测试进程内注册解析钩子：解析失败时依次补 .ts、.js 重试。不改动源码，不影响其他测试文件。
// beamioUserCardChain.ts 依赖链含 JSON ABI 与链上配置，这里替换为桩模块，使真实的 agentTempDiscoverVisibility 可运行。
const STUB_SOURCES: Record<string, string> = {
	'/src/beamioUserCardChain.ts': [
		'export const providerForUserCardChain = () => globalThis.__cardsByCategoryRpc',
		"export const resolveUserCardChain = async () => 'conet'",
		'',
	].join('\n'),
}
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context)
		} catch (err) {
			if (/\.[cm]?[jt]s$/.test(specifier) || specifier.startsWith('node:')) throw err
			for (const ext of ['.ts', '.js']) {
				try {
					return nextResolve(`${specifier}${ext}`, context)
				} catch {
					// 尝试下一个扩展名
				}
			}
			throw err
		}
	},
	load(url, context, nextLoad) {
		for (const suffix of Object.keys(STUB_SOURCES)) {
			if (url.endsWith(suffix)) return { format: 'module', source: STUB_SOURCES[suffix], shortCircuit: true }
		}
		return nextLoad(url, context)
	},
})

const { ethers } = await import('ethers')
const { filterCardsByCategoryGroupsForDiscover } = await import('./cardsByCategoryDiscover.ts')
const { omitCardsOwnedByUnhandedAgentTemp } = await import('./agentTempDiscoverVisibility.ts')

// ---- 注册表 RPC 桩（替代 CONET 链上读取）----
const REGISTRY_IFACE = new ethers.Interface([
	'function agentOfTemp(address) view returns (address)',
	'function tempHandedOff(address) view returns (bool)',
])
const MULTICALL_IFACE = new ethers.Interface([
	'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
])
const rpc = {
	calls: 0,
	/** fail：多次 multicall 直接抛错（注册表读取失败）；answer：按 hiddenOwners 返回结果。 */
	mode: 'answer' as 'fail' | 'answer',
	hiddenOwners: new Set<string>(),
}
const AGENT_OF_TEMP_SELECTOR = REGISTRY_IFACE.getFunction('agentOfTemp')!.selector
globalThis.__cardsByCategoryRpc = {
	call: async (tx: { data: string }) => {
		rpc.calls += 1
		if (rpc.mode === 'fail') throw new Error('rpc unavailable (test stub)')
		const [calls] = MULTICALL_IFACE.decodeFunctionData('aggregate3', tx.data)
		const results = calls.map((c: { callData: string }) => {
			if (c.callData.slice(0, 10) === AGENT_OF_TEMP_SELECTOR) {
				const owner = REGISTRY_IFACE.decodeFunctionData('agentOfTemp', c.callData)[0] as string
				const agent = rpc.hiddenOwners.has(owner.toLowerCase()) ? '0x0000000000000000000000000000000000000001' : ethers.ZeroAddress
				return [true, REGISTRY_IFACE.encodeFunctionResult('agentOfTemp', [agent])]
			}
			return [true, REGISTRY_IFACE.encodeFunctionResult('tempHandedOff', [false])]
		})
		return MULTICALL_IFACE.encodeFunctionResult('aggregate3', [results])
	},
}

const OWNER = '0x00000000000000000000000000000000000000aa'
const TEMP_OWNER = '0x00000000000000000000000000000000000000bb'
/** API_EXCLUDED 名单中的废弃卡（apiExcludedUserCards.ts）。 */
const EXCLUDED = '0xbccfa50d2a5917c7a8662177f5f4b7a175787270'
const NORMAL = '0x1111111111111111111111111111111111111111'
const NORMAL_2 = '0x2222222222222222222222222222222222222222'
const OLD_BEFORE_CUTOVER = '0x3333333333333333333333333333333333333333'
const AT_CUTOVER = '0x4444444444444444444444444444444444444444'
const ONLY_EXCLUDED_AND_OLD = '0x5555555555555555555555555555555555555555'

const card = (cardAddress: string, createdAt: string, cardOwner = OWNER): BeamioLatestCardItem => ({
	cardAddress,
	cardOwner,
	currency: 'USDC',
	priceInCurrencyE6: '1000000',
	uri: null,
	metadata: null,
	txHash: null,
	totalPointsMinted6: '0',
	holderCount: 0,
	createdAt,
})

const NEW = '2026-06-01T00:00:00.000Z'
const BEFORE = '2026-05-23T00:29:59.999Z'
const AT = '2026-05-23T00:30:00.000Z'

const noAgentTempHidden = async (cards: BeamioLatestCardItem[]) => cards
const identityOmit = async (cards: BeamioLatestCardItem[]) => cards

test.beforeEach(() => {
	rpc.calls = 0
	rpc.mode = 'answer'
	rpc.hiddenOwners.clear()
})

test('excluded card never appears, and a group that becomes empty is dropped', async () => {
	const groups = [
		{ categoryId: 'food', items: [card(EXCLUDED, NEW), card(NORMAL, NEW)] },
		{ categoryId: 'only-excluded', items: [card(EXCLUDED, NEW)] },
	]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, { omitUnhandedAgentTemp: noAgentTempHidden })
	assert.deepEqual(out.map((g) => g.categoryId), ['food'])
	assert.deepEqual(out[0].items.map((c) => c.cardAddress), [NORMAL])
})

test('cutover: cards created before 2026-05-23T00:30Z are hidden, at or after are shown', async () => {
	const groups = [
		{
			categoryId: 'food',
			items: [card(OLD_BEFORE_CUTOVER, BEFORE), card(AT_CUTOVER, AT), card(NORMAL, NEW)],
		},
		{ categoryId: 'old-only', items: [card(ONLY_EXCLUDED_AND_OLD, BEFORE)] },
	]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, { omitUnhandedAgentTemp: noAgentTempHidden })
	assert.deepEqual(out.map((g) => [g.categoryId, g.items.map((c) => c.cardAddress)]), [['food', [AT_CUTOVER, NORMAL]]])
})

test('normal cards are returned unchanged and in the original category and card order', async () => {
	const a = card(NORMAL, NEW)
	const b = card(NORMAL_2, NEW)
	const groups = [
		{ categoryId: 'a-cat', items: [b, a] },
		{ categoryId: 'b-cat', items: [a] },
	]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, { omitUnhandedAgentTemp: noAgentTempHidden })
	assert.deepEqual(out, groups)
})

test('agent temp omit runs after the policy, on deduplicated cards, and hides the owner it reports', async () => {
	const seenByOmit: string[] = []
	const groups = [
		{ categoryId: 'food', items: [card(NORMAL, NEW, TEMP_OWNER), card(EXCLUDED, NEW, OWNER)] },
		{ categoryId: 'drink', items: [card(NORMAL, NEW, TEMP_OWNER), card(NORMAL_2, NEW, OWNER)] },
	]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, {
		omitUnhandedAgentTemp: async (cards) => {
			seenByOmit.push(...cards.map((c) => c.cardAddress))
			return cards.filter((c) => c.cardOwner !== TEMP_OWNER)
		},
	})
	assert.deepEqual(seenByOmit, [NORMAL, NORMAL_2])
	assert.deepEqual(out.map((g) => [g.categoryId, g.items.map((c) => c.cardAddress)]), [['drink', [NORMAL_2]]])
})

test('identity omit stub: the filter keeps whatever the injected omit keeps (contract check only)', async () => {
	const groups = [{ categoryId: 'food', items: [card(NORMAL, NEW, TEMP_OWNER)] }]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, { omitUnhandedAgentTemp: identityOmit })
	assert.deepEqual(out, groups)
})

test('real agent temp omit: registry read fails -> every card is kept (fail-open, as latestCards)', async () => {
	rpc.mode = 'fail'
	const cards = [card(NORMAL, NEW, TEMP_OWNER), card(NORMAL_2, NEW, OWNER)]
	const out = await omitCardsOwnedByUnhandedAgentTemp(cards)
	assert.equal(rpc.calls > 0, true, 'the registry read path must actually run')
	assert.deepEqual(out, cards)
	const groups = [{ categoryId: 'food', items: cards }]
	const viaFilter = await filterCardsByCategoryGroupsForDiscover(groups, {
		omitUnhandedAgentTemp: omitCardsOwnedByUnhandedAgentTemp,
	})
	assert.deepEqual(viaFilter, groups)
})

test('real agent temp omit: registry reports an unhanded agent temp owner -> that owner cards are hidden', async () => {
	rpc.hiddenOwners.add(TEMP_OWNER.toLowerCase())
	const cards = [card(NORMAL, NEW, TEMP_OWNER), card(NORMAL_2, NEW, OWNER)]
	const out = await omitCardsOwnedByUnhandedAgentTemp(cards)
	assert.equal(rpc.calls > 0, true, 'the registry read path must actually run')
	assert.deepEqual(out.map((c) => c.cardAddress), [NORMAL_2])
})

test('empty input returns empty output', async () => {
	assert.deepEqual(await filterCardsByCategoryGroupsForDiscover([], { omitUnhandedAgentTemp: noAgentTempHidden }), [])
})

// Master 接线静态守卫（beamioMaster.ts 依赖链重，无法在单元测试中加载）。
// 只检查源码文本：过滤调用的参数（含真实 omit）、缓存写入的是过滤后的 groups、响应同样使用过滤后的 groups，以及顺序。
// 这不能替代运行时测试。
test('Master /cardsByCategory wiring: real omit, filtered result is cached and returned', () => {
	const src = readFileSync(new URL('./beamioMaster.ts', import.meta.url), 'utf8')
	assert.match(src, /import \{ omitCardsOwnedByUnhandedAgentTemp \} from '\.\/agentTempDiscoverVisibility'/)
	assert.match(src, /import \{ filterCardsByCategoryGroupsForDiscover \} from '\.\/cardsByCategoryDiscover'/)
	const start = src.indexOf("router.get('/cardsByCategory'")
	assert.ok(start > 0, 'route not found')
	const body = src.slice(start, src.indexOf('\n\t\t})', start))
	assert.match(body, /const rawGroups = await getLatestCardsGroupedByCategory\(/)
	assert.match(
		body,
		/const groups = await filterCardsByCategoryGroupsForDiscover\(rawGroups, \{ omitUnhandedAgentTemp: omitCardsOwnedByUnhandedAgentTemp \}\)/,
	)
	assert.match(body, /cardsByCategoryCache\.set\(cacheKey, \{ groups, /)
	assert.match(body, /res\.status\(200\)\.json\(\{ groups \}\)/)
	const filterAt = body.indexOf('filterCardsByCategoryGroupsForDiscover(rawGroups')
	assert.ok(filterAt < body.indexOf('cardsByCategoryCache.set'), 'filter must run before the cache write')
	assert.ok(filterAt < body.indexOf('res.status(200).json({ groups })'), 'filter must run before the response')
})
