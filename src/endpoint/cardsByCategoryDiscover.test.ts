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
const {
	omitCardsOwnedByUnhandedAgentTemp,
	omitCardsOwnedByUnhandedAgentTempFailClosed,
	clearAgentTempVisibleVerdictCache,
	AGENT_TEMP_VISIBLE_VERDICT_TTL_MS,
	AGENT_TEMP_READ_CONCURRENCY,
} = await import('./agentTempDiscoverVisibility.ts')

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
	/** 每次 multicall 的延迟（毫秒），用于观察并发。 */
	delayMs: 0,
	inFlight: 0,
	maxInFlight: 0,
	/** 这些序号（从 1 开始）的 multicall 直接抛错。 */
	failCalls: new Set<number>(),
	/** fail：multicall 直接抛错（整批读取失败）；answer：按 hiddenOwners 返回结果。 */
	mode: 'answer' as 'fail' | 'answer',
	hiddenOwners: new Set<string>(),
	/** 这些 owner 的 agentOfTemp 子调用返回 success=false（单个子调用失败）。 */
	failAgentOf: new Set<string>(),
}
const AGENT_OF_TEMP_SELECTOR = REGISTRY_IFACE.getFunction('agentOfTemp')!.selector
globalThis.__cardsByCategoryRpc = {
	call: async (tx: { data: string }) => {
		rpc.calls += 1
		const ordinal = rpc.calls
		rpc.inFlight += 1
		rpc.maxInFlight = Math.max(rpc.maxInFlight, rpc.inFlight)
		try {
			if (rpc.delayMs > 0) await new Promise((r) => setTimeout(r, rpc.delayMs))
			if (rpc.mode === 'fail' || rpc.failCalls.has(ordinal)) throw new Error('rpc unavailable (test stub)')
			return answer(tx)
		} finally {
			rpc.inFlight -= 1
		}
	},
}
const answer = (tx: { data: string }): string => {
	{
		const [calls] = MULTICALL_IFACE.decodeFunctionData('aggregate3', tx.data)
		const results = calls.map((c: { callData: string }) => {
			if (c.callData.slice(0, 10) === AGENT_OF_TEMP_SELECTOR) {
				const owner = REGISTRY_IFACE.decodeFunctionData('agentOfTemp', c.callData)[0] as string
				if (rpc.failAgentOf.has(owner.toLowerCase())) return [false, '0x']
				const agent = rpc.hiddenOwners.has(owner.toLowerCase()) ? '0x0000000000000000000000000000000000000001' : ethers.ZeroAddress
				return [true, REGISTRY_IFACE.encodeFunctionResult('agentOfTemp', [agent])]
			}
			return [true, REGISTRY_IFACE.encodeFunctionResult('tempHandedOff', [false])]
		})
		return MULTICALL_IFACE.encodeFunctionResult('aggregate3', [results])
	}
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
	rpc.failAgentOf.clear()
	rpc.failCalls.clear()
	rpc.delayMs = 0
	rpc.maxInFlight = 0
	clearAgentTempVisibleVerdictCache()
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

test('latestCards omit (legacy, fail-open): registry read fails -> every card is kept', async () => {
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

test('latestCards omit (legacy): registry reports an unhanded agent temp owner -> that owner cards are hidden', async () => {
	rpc.hiddenOwners.add(TEMP_OWNER.toLowerCase())
	const cards = [card(NORMAL, NEW, TEMP_OWNER), card(NORMAL_2, NEW, OWNER)]
	const out = await omitCardsOwnedByUnhandedAgentTemp(cards)
	assert.equal(rpc.calls > 0, true, 'the registry read path must actually run')
	assert.deepEqual(out.map((c) => c.cardAddress), [NORMAL_2])
})

test('batch reads are bounded: at most AGENT_TEMP_READ_CONCURRENCY multicalls in flight, results complete', async () => {
	// 800 个 owner = 10 批；若不设上限，同时在途数会达到 10，而非 AGENT_TEMP_READ_CONCURRENCY。
	const owners = Array.from({ length: 800 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'))
	rpc.hiddenOwners.add(owners[5].toLowerCase())
	rpc.delayMs = 15
	const cards = owners.map((o, i) => card('0x' + String(i + 1).padStart(40, '0'), NEW, o))
	const out = await omitCardsOwnedByUnhandedAgentTempFailClosed(cards)
	assert.equal(rpc.calls, 10, 'ten batches of 80 owners')
	assert.equal(rpc.maxInFlight <= AGENT_TEMP_READ_CONCURRENCY, true, `max in flight ${rpc.maxInFlight}`)
	assert.equal(rpc.maxInFlight >= 2, true, 'batches must overlap')
	assert.equal(out.length, 799)
	assert.equal(out.some((c) => c.cardOwner === owners[5]), false)
})

test('one failing batch makes the whole read unknown: fail-closed hides every card', async () => {
	const owners = Array.from({ length: 200 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'))
	rpc.failCalls.add(2)
	const cards = owners.map((o, i) => card('0x' + String(i + 1).padStart(40, '0'), NEW, o))
	const out = await omitCardsOwnedByUnhandedAgentTempFailClosed(cards)
	assert.equal(out.length, 0)
})

test('empty input returns empty output', async () => {
	assert.deepEqual(await filterCardsByCategoryGroupsForDiscover([], { omitUnhandedAgentTemp: noAgentTempHidden }), [])
})

// ---- fail-closed（cardsByCategory）：读取失败不等于"已确认可展示" ----
test('fail-closed: registry read fails and nothing was verified -> every card is hidden', async () => {
	rpc.mode = 'fail'
	const cards = [card(NORMAL, NEW, TEMP_OWNER), card(NORMAL_2, NEW, OWNER)]
	const out = await omitCardsOwnedByUnhandedAgentTempFailClosed(cards)
	assert.equal(rpc.calls > 0, true, 'the registry read path must actually run')
	assert.deepEqual(out, [])
})

test('fail-closed: an owner verified visible stays visible within the TTL when a later read fails, then expires', async () => {
	let clock = 1_000_000
	const now = () => clock
	const cards = [card(NORMAL, NEW, OWNER)]
	assert.deepEqual(await omitCardsOwnedByUnhandedAgentTempFailClosed(cards, { now }), cards)
	rpc.mode = 'fail'
	clock += AGENT_TEMP_VISIBLE_VERDICT_TTL_MS - 1
	assert.deepEqual(await omitCardsOwnedByUnhandedAgentTempFailClosed(cards, { now }), cards, 'within TTL: shown')
	clock += 2
	assert.deepEqual(await omitCardsOwnedByUnhandedAgentTempFailClosed(cards, { now }), [], 'after TTL: unknown, hidden')
})

test('fail-closed: a hidden verdict clears an earlier visible verification', async () => {
	let clock = 2_000_000
	const now = () => clock
	const cards = [card(NORMAL, NEW, TEMP_OWNER)]
	assert.deepEqual(await omitCardsOwnedByUnhandedAgentTempFailClosed(cards, { now }), cards)
	rpc.hiddenOwners.add(TEMP_OWNER.toLowerCase())
	assert.deepEqual(await omitCardsOwnedByUnhandedAgentTempFailClosed(cards, { now }), [])
	rpc.hiddenOwners.clear()
	rpc.mode = 'fail'
	assert.deepEqual(await omitCardsOwnedByUnhandedAgentTempFailClosed(cards, { now }), [], 'hidden verdict dropped the cache')
})

test('fail-closed: a single owner whose state call fails is unknown and hidden; other owners are decided normally', async () => {
	rpc.failAgentOf.add(TEMP_OWNER.toLowerCase())
	const cards = [card(NORMAL, NEW, TEMP_OWNER), card(NORMAL_2, NEW, OWNER)]
	const out = await omitCardsOwnedByUnhandedAgentTempFailClosed(cards)
	assert.equal(rpc.calls > 0, true)
	assert.deepEqual(out.map((c) => c.cardAddress), [NORMAL_2])
})

test('fail-closed: a card whose owner is not a valid address is hidden', async () => {
	const out = await omitCardsOwnedByUnhandedAgentTempFailClosed([card(NORMAL, NEW, 'not-an-address')])
	assert.deepEqual(out, [])
})

test('fail-closed through the Discover filter: failed read removes the card and the empty group', async () => {
	rpc.mode = 'fail'
	const groups = [{ categoryId: 'food', items: [card(NORMAL, NEW, OWNER)] }]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, { omitUnhandedAgentTemp: omitCardsOwnedByUnhandedAgentTempFailClosed })
	assert.deepEqual(out, [])
})

// Master 接线静态守卫（beamioMaster.ts 依赖链重，无法在单元测试中加载）。
// 只检查源码文本：过滤调用使用 fail-closed omit、缓存写入的是过滤后的 groups、响应使用过滤后的 groups、
// 冷路径经 single-flight 计算。这不能替代运行时测试。
test('Master /cardsByCategory wiring: fail-closed omit, filtered result cached, single-flight', () => {
	const src = readFileSync(new URL('./beamioMaster.ts', import.meta.url), 'utf8')
	assert.match(src, /import \{ omitCardsOwnedByUnhandedAgentTemp, omitCardsOwnedByUnhandedAgentTempFailClosed \} from '\.\/agentTempDiscoverVisibility'/)
	assert.match(src, /import \{ filterCardsByCategoryGroupsForDiscover \} from '\.\/cardsByCategoryDiscover'/)
	assert.match(src, /import \{ createSingleFlight \} from '\.\/singleFlight'/)
	assert.match(src, /const cardsByCategorySingleFlight = createSingleFlight</)
	const start = src.indexOf("router.get('/cardsByCategory'")
	assert.ok(start > 0, 'route not found')
	const body = src.slice(start, src.indexOf('\n\t\t})', start))
	assert.match(body, /cardsByCategorySingleFlight\.run\(/)
	assert.match(body, /const rawGroups = await getLatestCardsGroupedByCategory\(/)
	assert.match(
		body,
		/const filtered = await filterCardsByCategoryGroupsForDiscover\(rawGroups, \{ omitUnhandedAgentTemp: omitCardsOwnedByUnhandedAgentTempFailClosed \}\)/,
	)
	assert.match(body, /cardsByCategoryCache\.set\(cacheKey, \{ groups: filtered, /)
	assert.match(body, /res\.status\(200\)\.json\(\{ groups \}\)/)
	const filterAt = body.indexOf('filterCardsByCategoryGroupsForDiscover(rawGroups')
	assert.ok(filterAt < body.indexOf('cardsByCategoryCache.set'), 'filter must run before the cache write')
	assert.ok(filterAt < body.indexOf('res.status(200).json({ groups })'), 'filter must run before the response')
})
