// 运行时测试：真实 db.ts 的 readActivePosTerminalBindingForCharge（SQL 由 pg 桩按语句应答）。
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
		"    if (globalThis.__bindingSpy) globalThis.__bindingSpy(sql, _params)",
		"    if (String(sql).toLowerCase().includes('lower(trim(card_address))')) {",
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

test('charge binding read: an active row with tx_hash is a binding', async () => {
	globalThis.__bindingMode = 'bound'
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), true)
})

test('charge binding read: no matching row is false (a definite absence, not an error)', async () => {
	globalThis.__bindingMode = 'none'
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), false)
})

test('charge binding read: a database failure throws, it is never reported as absence', async () => {
	globalThis.__bindingMode = 'error'
	await assert.rejects(db.readActivePosTerminalBindingForCharge(CARD), /database unavailable/)
})

test('charge binding read: the query filters is_active, non-null tx_hash, and LOWER(TRIM(card_address))', async () => {
	globalThis.__bindingMode = 'none'
	const captured = []
	globalThis.__bindingSpy = (sql, params) => captured.push({ sql: String(sql), params })
	await db.readActivePosTerminalBindingForCharge(CARD)
	const q = captured.find((c) => /LOWER\(TRIM\(card_address\)\)\s*=\s*\$1/.test(c.sql))
	assert.ok(q, 'the binding query ran')
	assert.match(q.sql, /is_active\s*=\s*true/)
	assert.match(q.sql, /tx_hash IS NOT NULL/)
	assert.deepEqual(q.params, [CARD.toLowerCase()])
	globalThis.__bindingSpy = undefined
})
