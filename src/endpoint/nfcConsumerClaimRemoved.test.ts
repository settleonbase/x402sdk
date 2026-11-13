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

test('positive regression: merchant-side NFC card issuance executors still exported', () => {
	for (const name of ['nfcLinkAppExecute', 'nfcLinkAppCancelExecute', 'payByNfcUidPrepare', 'nfcTopupPreparePayload', 'signUSDC3009ForNfcTopup']) {
		assert.ok(new RegExp(`export (const|async function|function) ${name}\\b`).test(memberSrc), `missing export ${name}`)
	}
})
