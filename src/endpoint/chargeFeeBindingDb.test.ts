// 运行时测试：真实 db.ts 的 lookupActivePosTerminalBindingByCard（SQL 由 pg 桩按语句应答）。
// 只加载 db.ts 与其依赖桩；不加载 beamioServer / beamioMaster / MemberCard；不触达 HOME、真实数据库或网络。
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
		'  async connect() {}',
		'  async query(sql, _params) {',
		"    if (String(sql).includes('lower(card_address)')) {",
		"      if (globalThis.__bindingMode === 'error') throw new Error('database unavailable (test stub)')",
		"      return { rows: globalThis.__bindingMode === 'bound' ? [{ '?column?': 1 }] : [] }",
		'    }',
		'    return { rows: [] }',
		'  }',
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
const CARD = '0x0000000000000000000000000000000000000c01'

test('binding lookup: an active row with tx_hash is bound', async () => {
	globalThis.__bindingMode = 'bound'
	assert.equal(await db.lookupActivePosTerminalBindingByCard(CARD), 'bound')
})

test('binding lookup: no active row is not_bound (not an error)', async () => {
	globalThis.__bindingMode = 'none'
	assert.equal(await db.lookupActivePosTerminalBindingByCard(CARD), 'not_bound')
})

test('binding lookup: a database failure is unavailable, never not_bound', async () => {
	globalThis.__bindingMode = 'error'
	assert.equal(await db.lookupActivePosTerminalBindingByCard(CARD), 'unavailable')
})

test('binding lookup: an invalid card address is not_bound without touching the database', async () => {
	globalThis.__bindingMode = 'error'
	assert.equal(await db.lookupActivePosTerminalBindingByCard('not-an-address'), 'not_bound')
})
