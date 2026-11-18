// 运行时测试：真实的 db.ts 中 getRecentCategorizedBeamioCards / getLatestCardsGroupedByCategory 的数据库失败路径。
// 只加载 db.ts 本身；它的直接依赖全部替换为桩（HOME、~/.master.json、签名、网络、数据库一律不触达）：
//   - ./util（masterSetup 为空、RPC 地址为占位）、./logger、pg（Client.connect 抛错）、express（类型）、colors/safe、
//   - 其余本地依赖（链上地址解析、缓存失效、Coupon 元数据工具等）与 JSON ABI。
// 不加载 beamioServer.ts、beamioMaster.ts、MemberCard.ts。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const STUB_BY_SPECIFIER: Record<string, string> = {
	'./util': [
		'export const masterSetup = { beamio_Admins: [], settle_contractAdmin: [], admin: [] }',
		"export const resolveBeamioBaseHttpRpcUrl = () => 'https://stub.invalid/base'",
		'',
	].join('\n'),
	'./logger': "export const logger = (..._args) => {}\n",
	'./chainAddresses': "export const CONET_RPC_URL = 'https://stub.invalid/conet'\n",
	'./couponMetadataCategory': [
		'export const normalizeCouponSeriesMetadataJson = (x) => x',
		'export const normalizeProductionSeriesMetadataJson = (x) => x',
		'export const filterClientCouponSeriesRows = (x) => x',
		'export const filterClientProductionSeriesRows = (x) => x',
		'export const seriesMetadataLooksLikeProduction = () => false',
		'',
	].join('\n'),
	'./apiExcludedUserCards': 'export const isApiExcludedUserCard = () => false\n',
	'./beamioWalletIdentity': 'export const resolveBeamioWalletIdentityFromAddress = async () => null\n',
	'./endpoint/resolveBeamioAaViaUserCardFactory': 'export const resolveBeamioAaOnConet = async () => null\n',
	'./endpoint/latestCardsQueryCache': 'export const invalidateLatestCardsQueryCaches = () => {}\n',
	pg: [
		'export class Client {',
		'  constructor(_opts) {}',
		"  async connect() { throw new Error('database unavailable (test stub)') }",
		'  async query() { throw new Error(\'database unavailable (test stub)\') }',
		'  async end() {}',
		'}',
		'',
	].join('\n'),
	express: 'export const Request = undefined\nexport const Response = undefined\n',
	'colors/safe': "export default { yellow: (s) => s, red: (s) => s, gray: (s) => s }\n",
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const parent = context.parentURL ?? ''
		if (parent.endsWith('/src/db.ts')) {
			if (Object.prototype.hasOwnProperty.call(STUB_BY_SPECIFIER, specifier)) {
				return { url: 'stub:' + specifier, shortCircuit: true }
			}
			if (specifier.endsWith('.json')) return { url: 'stub:json:' + specifier, shortCircuit: true }
		}
		return nextResolve(specifier, context)
	},
	load(url, context, nextLoad) {
		if (url.startsWith('stub:json:')) return { format: 'module', source: 'export default []\n', shortCircuit: true }
		if (url.startsWith('stub:')) {
			const key = url.slice('stub:'.length)
			if (Object.prototype.hasOwnProperty.call(STUB_BY_SPECIFIER, key)) {
				return { format: 'module', source: STUB_BY_SPECIFIER[key], shortCircuit: true }
			}
		}
		return nextLoad(url, context)
	},
})

const db = await import('../db.ts')

test('real db.ts: a categorized-cards database failure propagates as an error, not as an empty result', async () => {
	await assert.rejects(db.getRecentCategorizedBeamioCards(10), /database unavailable \(test stub\)/)
})

test('real db.ts: the aggregation used by the cardsByCategory route propagates the same failure', async () => {
	await assert.rejects(db.getLatestCardsGroupedByCategory({ scanLimit: 10, limitPerCategory: 5 }), /database unavailable \(test stub\)/)
})
