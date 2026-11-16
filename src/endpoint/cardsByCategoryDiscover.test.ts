import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { BeamioLatestCardItem } from '../db.ts'

// 仓库源码使用无扩展名的导入（tsc nodenext 下可解析），node:test 的 ESM 解析不接受。
// 仅在本测试进程内注册解析钩子：解析失败时依次补 .ts、.js 重试。不改动源码，不影响其他测试文件。
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
})
const { filterCardsByCategoryGroupsForDiscover } = await import('./cardsByCategoryDiscover.ts')

const OWNER = '0x00000000000000000000000000000000000000aa'
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

test('excluded card never appears, and a group that becomes empty is dropped', async () => {
	const groups = [
		{ categoryId: 'food', items: [card(EXCLUDED, NEW), card(NORMAL, NEW)] },
		{ categoryId: 'only-excluded', items: [card(EXCLUDED, NEW)] },
	]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, { omitUnhandedAgentTemp: noAgentTempHidden })
	assert.deepEqual(
		out.map((g) => g.categoryId),
		['food'],
	)
	assert.deepEqual(
		out[0].items.map((c) => c.cardAddress),
		[NORMAL],
	)
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
	assert.deepEqual(
		out.map((g) => [g.categoryId, g.items.map((c) => c.cardAddress)]),
		[['food', [AT_CUTOVER, NORMAL]]],
	)
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
	const hiddenOwner = '0x00000000000000000000000000000000000000bb'
	const seenByOmit: string[] = []
	const groups = [
		{ categoryId: 'food', items: [card(NORMAL, NEW, hiddenOwner), card(EXCLUDED, NEW, OWNER)] },
		{ categoryId: 'drink', items: [card(NORMAL, NEW, hiddenOwner), card(NORMAL_2, NEW, OWNER)] },
	]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, {
		omitUnhandedAgentTemp: async (cards) => {
			seenByOmit.push(...cards.map((c) => c.cardAddress))
			return cards.filter((c) => c.cardOwner !== hiddenOwner)
		},
	})
	assert.deepEqual(seenByOmit, [NORMAL, NORMAL_2])
	assert.deepEqual(
		out.map((g) => [g.categoryId, g.items.map((c) => c.cardAddress)]),
		[['drink', [NORMAL_2]]],
	)
})

test('when the agent temp registry read fails (omit keeps everything), cards stay visible as in latestCards', async () => {
	const groups = [{ categoryId: 'food', items: [card(NORMAL, NEW, '0x00000000000000000000000000000000000000cc')] }]
	const out = await filterCardsByCategoryGroupsForDiscover(groups, { omitUnhandedAgentTemp: noAgentTempHidden })
	assert.deepEqual(out, groups)
})

test('empty input returns empty output', async () => {
	assert.deepEqual(await filterCardsByCategoryGroupsForDiscover([], { omitUnhandedAgentTemp: noAgentTempHidden }), [])
})

// Master 接线静态守卫：确认 beamioMaster 的 /cardsByCategory 处理函数在返回前调用了过滤。
// 接线所在模块依赖链很重（链上与 DB 模块），无法在单元测试中加载，故此处只做源码级检查。
test('Master /cardsByCategory handler applies the Discover filter before responding and caching', () => {
	const src = readFileSync(new URL('./beamioMaster.ts', import.meta.url), 'utf8')
	const start = src.indexOf("router.get('/cardsByCategory'")
	assert.ok(start > 0, 'route not found')
	const body = src.slice(start, src.indexOf('\n\t\t})', start))
	assert.match(body, /filterCardsByCategoryGroupsForDiscover\(rawGroups,/)
	assert.ok(body.indexOf('filterCardsByCategoryGroupsForDiscover') < body.indexOf('cardsByCategoryCache.set'), 'filter must run before cache write')
	assert.ok(body.indexOf('filterCardsByCategoryGroupsForDiscover') < body.indexOf('res.status(200).json({ groups })'), 'filter must run before response')
})
