// 运行时测试：真实 db.ts 的 readActivePosTerminalBindingForCharge。
// pg 桩是手写的内存实现：只对 SELECT 1 FROM beamio_pos_terminal_admin_card 逐个求值 WHERE 谓词
// （LOWER(TRIM(card_address)) = $1、is_active = true、tx_hash IS NOT NULL），遇到不认识的谓词即抛错（fail closed）。
// 这不是 PostgreSQL 的 SQL 语义验证（本机没有 PostgreSQL，也未引入 pg-mem）；真实 SQL 行为仍须由上线前的只读核查确认。
// 只加载 db.ts 与其依赖桩；不加载 beamioServer / beamioMaster / MemberCard；不触达 HOME、真实数据库或网络。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const PG_STUB = [
	'export class Client {',
	'  constructor(_opts) {}',
	'  async connect() {}',
	'  async query(sql, params) {',
	'    const text = String(sql)',
	'    if (globalThis.__bindingSpy) globalThis.__bindingSpy(text, params)',
	'    if (globalThis.__bindingMode === "error" && /FROM beamio_pos_terminal_admin_card/i.test(text) && /LOWER\\(TRIM\\(card_address\\)\\)/.test(text)) {',
	'      throw new Error("database unavailable (test stub)")',
	'    }',
	'    if (/^\\s*SELECT\\s+1\\s+FROM\\s+beamio_pos_terminal_admin_card\\b/i.test(text)) {',
	'      return { rows: evaluateBindingSelect(text, params) }',
	'    }',
	'    return { rows: [] }',
	'  }',
	'  async end() {}',
	'}',
	'function evaluateBindingSelect(text, params) {',
	'  const flat = text.replace(/\\s+/g, " ").trim()',
	'  const m = /WHERE (.*?)( LIMIT 1)?$/i.exec(flat)',
	'  if (!m) throw new Error("stub: binding select without WHERE")',
	'  const preds = m[1].split(/ AND /i).map((s) => s.trim())',
	'  const rows = globalThis.__bindingRows || []',
	'  const hits = rows.filter((row) =>',
	'    preds.every((p) => {',
	'      if (p === "LOWER(TRIM(card_address)) = $1") return String(row.card_address).trim().toLowerCase() === params[0]',
	'      if (p === "is_active = true") return row.is_active === true',
	'      if (p === "tx_hash IS NOT NULL") return row.tx_hash !== null && row.tx_hash !== undefined',
	'      throw new Error("stub: unsupported predicate " + p)',
	'    })',
	'  )',
	'  return hits.slice(0, 1).map(() => ({ "?column?": 1 }))',
	'}',
	'',
].join('\n')

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
	pg: PG_STUB,
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
const OTHER_CARD = '0x0000000000000000000000000000000000000c02'

const rowsOf = (...rows) => {
	globalThis.__bindingRows = rows
}

test('charge binding read: an active row with tx_hash is a binding', async () => {
	globalThis.__bindingMode = 'normal'
	rowsOf({ card_address: CARD, is_active: true, tx_hash: '0xaa' })
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), true)
})

test('charge binding read: an inactive row with tx_hash is not a binding (is_active is evaluated)', async () => {
	globalThis.__bindingMode = 'normal'
	rowsOf({ card_address: CARD, is_active: false, tx_hash: '0xaa' })
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), false)
})

test('charge binding read: an active row without tx_hash is not a binding (tx_hash IS NOT NULL is evaluated)', async () => {
	globalThis.__bindingMode = 'normal'
	rowsOf({ card_address: CARD, is_active: true, tx_hash: null })
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), false)
})

test('charge binding read: an active row for a different card is not a binding', async () => {
	globalThis.__bindingMode = 'normal'
	rowsOf({ card_address: OTHER_CARD, is_active: true, tx_hash: '0xaa' })
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), false)
})

test('charge binding read: stored card_address with whitespace and mixed case still matches (LOWER(TRIM()))', async () => {
	globalThis.__bindingMode = 'normal'
	rowsOf({ card_address: '  ' + CARD.toUpperCase().replace('0X', '0x') + ' ', is_active: true, tx_hash: '0xaa' })
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), true)
})

test('charge binding read: no rows is false (a definite absence, not an error)', async () => {
	globalThis.__bindingMode = 'normal'
	rowsOf()
	assert.equal(await db.readActivePosTerminalBindingForCharge(CARD), false)
})

test('charge binding read: a database failure throws, it is never reported as absence', async () => {
	globalThis.__bindingMode = 'error'
	rowsOf({ card_address: CARD, is_active: true, tx_hash: '0xaa' })
	await assert.rejects(db.readActivePosTerminalBindingForCharge(CARD), /database unavailable/)
})

test('charge binding read: the query filters is_active, non-null tx_hash, and LOWER(TRIM(card_address))', async () => {
	globalThis.__bindingMode = 'normal'
	rowsOf()
	const captured = []
	globalThis.__bindingSpy = (sql, params) => captured.push({ sql: String(sql), params })
	await db.readActivePosTerminalBindingForCharge(CARD)
	globalThis.__bindingSpy = undefined
	const q = captured.find((c) => /LOWER\(TRIM\(card_address\)\)\s*=\s*\$1/.test(c.sql))
	assert.ok(q, 'the binding query ran')
	assert.match(q.sql, /is_active\s*=\s*true/)
	assert.match(q.sql, /tx_hash IS NOT NULL/)
	assert.deepEqual(q.params, [CARD.toLowerCase()])
})
