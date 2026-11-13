// GAP-17 (2026-11-13): 消费者 NFC 绑定/认领接口 POST /api/nfcLinkAppClaimWithKey 已移除。
// 本测试为静态源码断言（不启动服务、不连库、不连链）：
//   1. 外层 Cluster（beamioServer）与 Master（beamioMaster）都在 express.json 之前返回 410；
//   2. 旧处理函数 nfcLinkAppClaimWithKeyExecute 不再写库、不再转发、不再读取请求体；
//   3. 现行 NFC 发卡 / 托管签字 / NFC 支付等路由仍然注册（正向回归）。
// 运行：node --test src/endpoint/nfcConsumerClaimRemoved.test.ts  （Node >= 22 类型剥离）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')

const serverSrc = read('endpoint/beamioServer.ts')
const masterSrc = read('endpoint/beamioMaster.ts')
const memberSrc = read('MemberCard.ts')

const OLD_PATH = '/api/nfcLinkAppClaimWithKey'
const GUARD_CODE = "NFC_CONSUMER_CLAIM_REMOVED"

function guardBeforeJsonParser(src: string, jsonAnchor: string): void {
	const guardAt = src.indexOf(`app.post('${OLD_PATH}'`)
	const jsonAt = src.indexOf(jsonAnchor)
	assert.ok(guardAt >= 0, 'app-level 410 guard for the removed path must exist')
	assert.equal(src.split(`app.post('${OLD_PATH}'`).length - 1, 1, 'guard must be registered exactly once')
	assert.ok(jsonAt > 0, `express.json anchor not found: ${jsonAnchor}`)
	assert.ok(guardAt < jsonAt, 'guard must run before express.json (body must not be parsed)')
	const block = src.slice(guardAt, src.indexOf('})', guardAt) + 2)
	assert.ok(block.includes('410'), 'guard must answer 410')
	assert.ok(block.includes(GUARD_CODE), 'guard must return errorCode NFC_CONSUMER_CLAIM_REMOVED')
	assert.ok(!/req\.body/.test(block), 'guard must not read the request body')
	assert.ok(!/logger\([^;]*\b(req|_req)\b/.test(block), 'guard must not log request objects')
}

test('Cluster: 410 guard sits before express.json (8mb) and never reads body', () => {
	guardBeforeJsonParser(serverSrc, "app.use ( express.json({ limit: '8mb' }) )")
})

test('Master: 410 guard sits before express.json (5mb) and never reads body', () => {
	guardBeforeJsonParser(masterSrc, "app.use ( express.json({ limit: '5mb' }) )")
})

test('no forwarding of the removed path (postLocalhost) remains', () => {
	assert.ok(!serverSrc.includes(`postLocalhost('${OLD_PATH}'`), 'Cluster must not forward the removed path')
	assert.ok(!masterSrc.includes(`'${OLD_PATH}'`) || masterSrc.includes(`app.post('${OLD_PATH}'`) || masterSrc.includes(`router.post('/nfcLinkAppClaimWithKey'`),
		'Master must not register the old handler')
})

test('Master router handler returns 410 and no longer calls the old executor', () => {
	const at = masterSrc.indexOf("router.post('/nfcLinkAppClaimWithKey'")
	assert.ok(at > 0)
	const block = masterSrc.slice(at, masterSrc.indexOf('})', at) + 2)
	assert.ok(block.includes('410') && block.includes(GUARD_CODE))
	assert.ok(!block.includes('nfcLinkAppClaimWithKeyExecute'))
	assert.ok(!block.includes('req.body'))
})

test('Cluster router handler returns 410 and no longer validates/forwards', () => {
	const at = serverSrc.indexOf("router.post('/nfcLinkAppClaimWithKey'")
	assert.ok(at > 0)
	const block = serverSrc.slice(at, serverSrc.indexOf('})', at) + 2)
	assert.ok(block.includes('410') && block.includes(GUARD_CODE))
	assert.ok(!block.includes('postLocalhost'))
	assert.ok(!block.includes('req.body'))
	assert.ok(!block.includes('replaceNfcCardKeyByTagId'))
})

test('legacy executor is inert: no DB write, no forward, no body access', () => {
	const at = memberSrc.indexOf('export const nfcLinkAppClaimWithKeyExecute')
	const end = memberSrc.indexOf('function _normalizeCardAddress', at)
	assert.ok(at > 0 && end > at)
	const fn = memberSrc.slice(at, end)
	assert.ok(fn.includes('410') && fn.includes(GUARD_CODE))
	for (const forbidden of [
		'replaceNfcCardKeyByTagId(',
		'markNfcLinkAppSessionReleasedByTag(',
		'performNfcLinkAppMigrateAllAssetsViaContainer(',
		'performInfraCardRedeemForUserEoaOnce(',
		'postLocalhost',
		'body.privateKey',
		'console.log',
	]) {
		assert.ok(!fn.includes(forbidden), `legacy executor must not contain ${forbidden}`)
	}
})

// ---- 正向回归：以下路由必须仍然注册（路径字符串级别）
const KEEP_CLUSTER = [
	'/nfcLinkApp', '/nfcLinkAppValidate', '/nfcLinkAppRelease', '/nfcLinkAppCancel',
	'/nfcTopupPrepare', '/nfcTopup', '/nfcUsdcTopup', '/nfcUsdcCharge',
	'/nfcUsdcChargeNfcPrepare', '/nfcUsdcChargeNfcSign', '/nfcUsdcChargeTopupAuth', '/nfcUsdcChargeRawSig',
	'/payByNfcUid', '/payByNfcUidPrepare', '/payByNfcUidSignContainer',
]
const KEEP_MASTER = [
	'/nfcLinkApp', '/nfcLinkAppCancel', '/nfcTopupPrepare', '/nfcTopup', '/nfcUsdcTopup',
	'/nfcUsdcCharge', '/nfcUsdcChargeTopupAuth', '/payByNfcUid', '/payByNfcUidPrepare', '/payByNfcUidSignContainer',
]

test('positive regression: NFC payment / top-up / link-app routes still registered (Cluster)', () => {
	for (const p of KEEP_CLUSTER) {
		assert.ok(serverSrc.includes(`router.post('${p}'`) || serverSrc.includes(`router.get('${p}'`), `missing route ${p}`)
	}
})

test('positive regression: NFC payment / top-up / link-app routes still registered (Master)', () => {
	for (const p of KEEP_MASTER) {
		assert.ok(masterSrc.includes(`router.post('${p}'`), `missing route ${p}`)
	}
})

const dbSrc = read('db.ts')

test('nfcCardLinkState restored (not in the removal scope): signed-message route, no private key input', () => {
	const at = serverSrc.indexOf("router.post('/nfcCardLinkState'")
	assert.ok(at > 0, 'route must be registered')
	const block = serverSrc.slice(at, serverSrc.indexOf('\n\t})\n', at) + 5)
	assert.ok(block.includes('applyNfcCardLinkStateChange({ message'), 'route must call the signed-message handler')
	assert.ok(!block.includes('410'), 'route must not be stopped (pending project decision)')
	assert.ok(!/privateKey|private_key/.test(block), 'route must not accept or log private keys')
	assert.ok(!block.includes('req.body') || block.includes('const { message, signature } = req.body'), 'body is read only for message/signature')
})

test('positive regression A (merchant card issuance): server-generated card key path intact', () => {
	assert.ok(/export const provisionOrGetNfcWalletByTagId\b/.test(dbSrc), 'provisionOrGetNfcWalletByTagId must exist')
	assert.ok(dbSrc.includes('ethers.Wallet.createRandom()') && dbSrc.includes('registerNfcCardToDb({'), 'server-side random card key + registration must remain')
	assert.ok(memberSrc.includes('await provisionOrGetNfcWalletByTagId(tagIdHex, uidTrim)'), 'nfcLinkAppExecute must still provision via server')
	assert.ok(masterSrc.includes("router.post('/getUIDAssetsProvision'") || masterSrc.includes("'/getUIDAssetsProvision'"), 'getUIDAssetsProvision route must remain')
	assert.ok(/export const nfcLinkAppExecute\b/.test(memberSrc), 'nfcLinkAppExecute export must remain')
})

test('positive regression B (managed signing): signing routes and executors intact', () => {
	assert.ok(masterSrc.includes("router.post('/payByNfcUidSignContainer'"))
	assert.ok(serverSrc.includes("router.post('/nfcUsdcChargeNfcSign'") && serverSrc.includes("router.post('/nfcUsdcChargeRawSig'"))
	assert.ok(/export const signUSDC3009ForNfcTopup\b/.test(memberSrc), 'signUSDC3009ForNfcTopup export must remain')
	assert.ok(/export const payByNfcUidSignContainer\b/.test(memberSrc) || /payByNfcUidSignContainer\b/.test(memberSrc), 'payByNfcUidSignContainer executor must remain')
})

test('positive regression C (NFC payment / top-up): prepare, pay, top-up routes intact', () => {
	for (const p of ['/payByNfcUid', '/payByNfcUidPrepare', '/nfcTopupPrepare', '/nfcTopup', '/nfcUsdcTopup']) {
		assert.ok(serverSrc.includes(`router.post('${p}'`) || serverSrc.includes(`router.get('${p}'`), `missing ${p} (Cluster)`)
	}
	for (const p of ['/payByNfcUid', '/payByNfcUidPrepare', '/nfcTopupPrepare', '/nfcTopup', '/nfcUsdcTopup']) {
		assert.ok(masterSrc.includes(`router.post('${p}'`), `missing ${p} (Master)`)
	}
	assert.ok(/export const nfcTopupPreparePayload\b|export async function nfcTopupPreparePayload\b/.test(memberSrc), 'nfcTopupPreparePayload export must remain')
})

test('GAP-17 follow-up: /api/nfcLinkApp (bind session creation) answers 410 on Cluster and Master, no forwarding', () => {
	const sAt = serverSrc.indexOf("router.post('/nfcLinkApp', (_req, res)")
	assert.ok(sAt > 0, 'Cluster /nfcLinkApp must be a 410 handler')
	const sBlock = serverSrc.slice(sAt, serverSrc.indexOf('\n\t})\n', sAt) + 5)
	assert.ok(sBlock.includes('410') && sBlock.includes(GUARD_CODE))
	assert.ok(!sBlock.includes('postLocalhost'), 'Cluster /nfcLinkApp must not forward')
	assert.ok(!sBlock.includes('req.body'))
	const mAt = masterSrc.indexOf("router.post('/nfcLinkApp', (_req, res)")
	assert.ok(mAt > 0, 'Master /nfcLinkApp must be a 410 handler')
	const mBlock = masterSrc.slice(mAt, masterSrc.indexOf('\n\t\t})\n', mAt) + 6)
	assert.ok(mBlock.includes('410') && mBlock.includes(GUARD_CODE))
	assert.ok(!mBlock.includes('nfcLinkAppExecute'), 'Master /nfcLinkApp must not run the executor')
})

test('R-1: legacy HTTP /api/registerNfcCard answers 410 on Cluster and Master before body parsing; no forward, no DB write', () => {
	const guardAt = serverSrc.indexOf("app.post('/api/registerNfcCard'")
	const jsonAt = serverSrc.indexOf("app.use ( express.json({ limit: '8mb' }) )")
	assert.ok(guardAt > 0 && guardAt < jsonAt, 'Cluster guard must sit before express.json')
	const gBlock = serverSrc.slice(guardAt, serverSrc.indexOf('\n\t})\n', guardAt) + 5)
	assert.ok(gBlock.includes('410') && gBlock.includes('NFC_REGISTER_HTTP_REMOVED'))
	assert.ok(!gBlock.includes('req.body') && !gBlock.includes('postLocalhost'))
	const rAt = serverSrc.indexOf("router.post('/registerNfcCard'")
	const rBlock = serverSrc.slice(rAt, serverSrc.indexOf('\n\t})\n', rAt) + 5)
	assert.ok(rBlock.includes('410') && !rBlock.includes('postLocalhost') && !rBlock.includes('req.body'))

	const mGuard = masterSrc.indexOf("app.post('/api/registerNfcCard'")
	const mJson = masterSrc.indexOf("app.use ( express.json({ limit: '5mb' }) )")
	assert.ok(mGuard > 0 && mGuard < mJson, 'Master guard must sit before express.json')
	const mgBlock = masterSrc.slice(mGuard, masterSrc.indexOf('\n\t})\n', mGuard) + 5)
	assert.ok(mgBlock.includes('410') && mgBlock.includes('NFC_REGISTER_HTTP_REMOVED') && !mgBlock.includes('req.body'))
	const mrAt = masterSrc.indexOf("router.post('/registerNfcCard'")
	const mrBlock = masterSrc.slice(mrAt, masterSrc.indexOf('\n\t\t})\n', mrAt) + 6)
	assert.ok(mrBlock.includes('410') && !mrBlock.includes('registerNfcCardToDb') && !mrBlock.includes('req.body'))
})

test('R-1: registerNfcCardToDb and the server-side provisioning chain are kept', () => {
	const dbSrc = read('db.ts')
	assert.ok(/export const registerNfcCardToDb\b/.test(dbSrc), 'registerNfcCardToDb must remain')
	assert.ok(dbSrc.includes('ethers.Wallet.createRandom()') && /export const provisionOrGetNfcWalletByTagId\b/.test(dbSrc))
	assert.ok(masterSrc.includes("router.get('/getUIDAssetsProvision'") || masterSrc.includes("'/getUIDAssetsProvision'"))
})

test('log hygiene: inbound debug logger redacts private-key-like fields in both services', () => {
	for (const src of [serverSrc, masterSrc]) {
		assert.ok(src.includes('const redactSecretsForLog'), 'redaction helper must exist')
		assert.ok(/const body = truncateValue\(redactSecretsForLog\(req\.body\)\)/.test(src), 'inbound logger must redact body')
	}
})

test('test-mode overrides: DB_URL and ports change only when BEAMIO_TEST_MODE=1; defaults unchanged', () => {
	const dbSrc = read('db.ts')
	assert.ok(dbSrc.includes("process.env.BEAMIO_TEST_MODE === '1'") && dbSrc.includes('BEAMIO_TEST_DB_URL'), 'DB_URL override must be gated')
	assert.ok(dbSrc.includes('"postgres://postgres:your_password@127.0.0.1:5432/postgres"'), 'default DB_URL unchanged')
	for (const src of [serverSrc, masterSrc]) {
		assert.ok(src.includes("testModePort('BEAMIO_TEST_MASTER_PORT', 1111)"), 'master port default 1111 gated')
	}
	assert.ok(serverSrc.includes("testModePort('BEAMIO_TEST_CLUSTER_PORT', 2222)"), 'cluster port default 2222 gated')
})
