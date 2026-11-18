'use strict'
/**
 * 隔离测试：分享链接可信域（beamio.ca / 存量 beamio.app）与 Discover 商家图 og:image 域。
 * - 运行时用 typescript.transpileModule 按需编译 couponClaimShare.ts 及其 .ts 兄弟模块；
 * - 仅桩掉 ../db（避免数据库连接副作用）；不加载 beamioServer / beamioMaster / MemberCard；
 * - 全局 fetch 被替换为失败桩，测试期间不产生任何网络请求；不读取凭据；不写磁盘缓存。
 * 可用 COUPON_SHARE_FILE=<绝对路径> 指向另一份 couponClaimShare 源文件（用于基线对照，须与本文件同目录）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const { ethers } = require('ethers')

globalThis.fetch = async () => {
	throw new Error('network disabled in isolated share test')
}

const ROOT = path.resolve(__dirname, '..')
const TARGET = process.env.COUPON_SHARE_FILE
	? path.resolve(process.env.COUPON_SHARE_FILE)
	: path.join(ROOT, 'src/endpoint/couponClaimShare.ts')

const CARD = '0x6e600DfaEa5eD006A97aF2AD080518c1d06C0A74'
const INVITER = '0x1111111111111111111111111111111111111111'
const REF2 = '0xc31043cF04CFF17a273B33F4cb851f4399e2170E'

const DB_STUB = {
	getCardByAddress: async () => ({
		metadata: { businessName: 'Test Merchant', description: 'Fixture merchant for isolated test' },
	}),
	listCouponIssuedNftSeriesForCardDescending: async () => [],
	listProductionIssuedNftSeriesForCardDescending: async () => [],
	getSeriesByCardAndTokenId: async () => null,
}

require.extensions['.ts'] = (mod, filename) => {
	const src = fs.readFileSync(filename, 'utf8')
	const out = ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
	}).outputText
	mod._compile(out, filename)
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
	if (request === '../db' && parent && parent.filename === TARGET) return DB_STUB
	return originalLoad.apply(this, arguments)
}

const mod = require(TARGET)
Module._load = originalLoad

const discoverInner = (origin) => `${origin}/app/?beamiocard=${CARD}&discover=open`
const wrapper = (inner, origin = 'https://beamio.ca') => `${origin}/app-download?target=${encodeURIComponent(inner)}`

test('beamio.ca Discover wrapper (browser /app-download and crawler path) parses to discover_merchant', () => {
	const parsed = mod.parseCouponClaimShareRequest({ target: wrapper(discoverInner('https://beamio.ca')) })
	assert.ok(parsed, 'beamio.ca Discover target must be accepted')
	assert.equal(parsed.params.kind, 'discover_merchant')
	assert.equal(parsed.params.cardAddress, ethers.getAddress(CARD))
	assert.ok(parsed.shareUrl.startsWith('https://beamio.ca/app-download?target='), 'og:url keeps the pasted beamio.ca wrapper')
})

test('beamio.ca Discover target with ref parameter parses', () => {
	const inner = `https://beamio.ca/app/?beamiocard=${CARD}&discover=open&ref=${INVITER}`
	const parsed = mod.parseCouponClaimShareRequest({ target: wrapper(inner) })
	assert.ok(parsed)
	assert.equal(parsed.params.kind, 'discover_merchant')
})

test('beamio.ca direct /app/ deep link (no wrapper) parses to discover_merchant', () => {
	const parsed = mod.parseCouponClaimShareRequest({ beamiocard: CARD, discover: 'open' })
	assert.ok(parsed)
	assert.equal(parsed.params.kind, 'discover_merchant')
})

test('legacy beamio.app Discover wrapper still parses (存量链接)', () => {
	const parsed = mod.parseCouponClaimShareRequest({ target: wrapper(discoverInner('https://beamio.app'), 'https://beamio.app') })
	assert.ok(parsed)
	assert.equal(parsed.params.kind, 'discover_merchant')
})

test('beamio.ca open-claim, redeem and personal-invite wrappers parse (other share kinds do not regress)', () => {
	const claim = mod.parseCouponClaimShareRequest({
		target: wrapper(`https://beamio.ca/app/?beamiocard=${CARD}&couponId=abc&claim=open`),
	})
	assert.ok(claim)
	assert.equal(claim.params.kind, 'open_claim')

	const redeem = mod.parseCouponClaimShareRequest({
		target: wrapper(`https://beamio.ca/app/?beamiocard=${CARD}&redeemcode=CODE123`),
	})
	assert.ok(redeem)
	assert.equal(redeem.params.kind, 'redeem')

	const invite = mod.parseCouponClaimShareRequest({ target: wrapper(`https://beamio.ca/app/?invite=${INVITER}`) })
	assert.ok(invite)
	assert.equal(invite.params.kind, 'personal_invite')
})

test('untrusted origins are rejected (exact origin match; no suffix or userinfo tricks)', () => {
	const bad = [
		`https://beamio.ca.evil.example/app/?beamiocard=${CARD}&discover=open`,
		`https://evil-beamio.ca/app/?beamiocard=${CARD}&discover=open`,
		`https://sub.beamio.ca/app/?beamiocard=${CARD}&discover=open`,
		`https://beamio.ca:8443/app/?beamiocard=${CARD}&discover=open`,
		`http://beamio.ca/app/?beamiocard=${CARD}&discover=open`,
		`https://beamio.app.evil.example/app/?beamiocard=${CARD}&discover=open`,
		`https://beamio.ca@evil.example/app/?beamiocard=${CARD}&discover=open`,
		`https://beamio.com/app/?beamiocard=${CARD}&discover=open`,
	]
	for (const inner of bad) {
		assert.equal(mod.parseDiscoverMerchantFromBeamioAppUrl(inner), null, `direct: ${inner}`)
		assert.equal(mod.parseCouponClaimShareRequest({ target: wrapper(inner) }), null, `beamio.ca wrapper: ${inner}`)
	}
	// Untrusted wrapper host with a valid beamio.ca inner target must also be rejected.
	const evilWrapper = `https://evil.example/app-download?target=${encodeURIComponent(discoverInner('https://beamio.ca'))}`
	assert.equal(mod.parseCouponClaimShareRequest({ target: evilWrapper }), null, 'untrusted wrapper origin')
})

test('wrong path on a trusted origin is still rejected', () => {
	assert.equal(mod.parseDiscoverMerchantFromBeamioAppUrl(`https://beamio.ca/api/x?beamiocard=${CARD}&discover=open`), null)
})

test('Discover og:image is on beamio.ca; og token round-trips; HTML carries beamio.ca og:image and twitter:image', async () => {
	const parsed = mod.parseCouponClaimShareRequest({ target: wrapper(discoverInner('https://beamio.ca')) })
	const meta = await mod.resolveCouponClaimShareMeta(parsed.params, parsed.shareUrl)
	assert.ok(meta)
	assert.match(meta.ogImageUrl, /^https:\/\/beamio\.ca\/og\/s\/[A-Za-z0-9_-]+\.jpg$/)
	const token = meta.ogImageUrl.slice('https://beamio.ca/og/s/'.length).replace(/\.jpg$/, '')
	const decoded = mod.decodeOgShareToken(token)
	assert.equal(decoded.kind, 'discover_merchant')
	assert.equal(decoded.cardAddress, ethers.getAddress(CARD))
	const html = mod.renderCouponClaimShareHtml(meta)
	assert.ok(html.includes(`<meta property="og:image" content="${meta.ogImageUrl}"`), 'og:image present')
	assert.ok(html.includes(`<meta name="twitter:image" content="${meta.ogImageUrl}"`), 'twitter:image present')
})

test('dynamic share og:image is on beamio.ca for every share kind (coupon, redeem, discover)', () => {
	const coupon = mod.parseCouponClaimShareRequest({
		target: wrapper(`https://beamio.ca/app/?beamiocard=${CARD}&couponId=abc&claim=open`),
	})
	const redeem = mod.parseCouponClaimShareRequest({
		target: wrapper(`https://beamio.ca/app/?beamiocard=${CARD}&redeemcode=CODE123`),
	})
	const discover = mod.parseCouponClaimShareRequest({ target: wrapper(discoverInner('https://beamio.ca')) })
	for (const p of [coupon, redeem, discover]) {
		const meta = mod.buildFallbackCouponClaimShareMeta(p.params, p.shareUrl)
		assert.ok(meta.ogImageUrl.startsWith('https://beamio.ca/og/s/'), meta.ogImageUrl)
	}
})

test('personal-invite og:image is the static beamio.ca banner (owner ruling: all share og:image on beamio.ca)', () => {
	const invite = mod.parseCouponClaimShareRequest({ target: wrapper(`https://beamio.ca/app/?invite=${INVITER}`), v: '1794978675516' })
	const meta = mod.buildFallbackCouponClaimShareMeta(invite.params, invite.shareUrl)
	assert.match(meta.ogImageUrl, /^https:\/\/beamio\.ca\/og-invitation\.jpg\?v=/, meta.ogImageUrl)
	assert.doesNotMatch(meta.ogImageUrl, /beamio\.app/)
})

test('direct /app/ deep link (nginx BC rewrite, no wrapper): og:url on beamio.ca keeps beamiocard, discover, ref and v', () => {
	const parsed = mod.parseCouponClaimShareRequest({
		beamiocard: CARD,
		discover: 'open',
		ref: REF2,
		v: '1794978675516',
	})
	assert.ok(parsed)
	assert.equal(parsed.params.kind, 'discover_merchant')
	const u = new URL(parsed.shareUrl)
	assert.equal(u.origin + u.pathname, 'https://beamio.ca/app/')
	assert.equal(u.searchParams.get('beamiocard'), CARD)
	assert.equal(u.searchParams.get('discover'), 'open')
	assert.equal(u.searchParams.get('ref'), ethers.getAddress(REF2))
	assert.equal(u.searchParams.get('v'), '1794978675516')
})

test('direct /app/ invite deep link is on beamio.ca', () => {
	const parsed = mod.parseCouponClaimShareRequest({ invite: INVITER, v: '1' })
	assert.ok(parsed)
	assert.equal(parsed.params.kind, 'personal_invite')
	assert.ok(parsed.shareUrl.startsWith('https://beamio.ca/app/?invite='), parsed.shareUrl)
})

test('www.beamio.ca and www.beamio.app wrappers parse; other www-like hosts are rejected', () => {
	for (const origin of ['https://www.beamio.ca', 'https://www.beamio.app']) {
		const parsed = mod.parseCouponClaimShareRequest({ target: wrapper(discoverInner(origin), origin) })
		assert.ok(parsed, origin)
		assert.equal(parsed.params.kind, 'discover_merchant')
	}
	for (const inner of [
		`https://www.beamio.ca.evil.example/app/?beamiocard=${CARD}&discover=open`,
		`https://www.beamio.com/app/?beamiocard=${CARD}&discover=open`,
		`https://api.beamio.ca/app/?beamiocard=${CARD}&discover=open`,
	]) {
		assert.equal(mod.parseCouponClaimShareRequest({ target: wrapper(inner) }), null, inner)
	}
})

test('merchant ref deep link and v cache-bust are preserved in shareUrl and og token', () => {
	const inner = `https://beamio.ca/app/?beamiocard=${CARD}&discover=open&ref=${INVITER}`
	const parsed = mod.parseCouponClaimShareRequest({ target: wrapper(inner), v: '1794978675516' })
	assert.ok(parsed)
	const u = new URL(parsed.shareUrl)
	assert.equal(u.origin, 'https://beamio.ca')
	assert.equal(u.searchParams.get('v'), '1794978675516')
	const innerOut = new URL(u.searchParams.get('target'))
	assert.equal(innerOut.searchParams.get('ref'), ethers.getAddress(INVITER))
	assert.equal(innerOut.searchParams.get('discover'), 'open')
	assert.equal(innerOut.searchParams.get('beamiocard'), ethers.getAddress(CARD))
	const meta = mod.buildFallbackCouponClaimShareMeta(parsed.params, parsed.shareUrl)
	const token = meta.ogImageUrl.slice('https://beamio.ca/og/s/'.length).replace(/\.jpg$/, '')
	const payload = mod.decodeOgShareTokenPayload(token)
	assert.equal(payload.cacheBust, '1794978675516')
})

test('crawler path (no app-download wrapper): og:url keeps pasted origin and ref; v is appended', () => {
	const inner = `https://beamio.ca/app/?beamiocard=${CARD}&discover=open&ref=${INVITER}`
	const parsed = mod.parseCouponClaimShareRequest({ target: inner, v: '1794978675516' })
	assert.ok(parsed)
	assert.equal(parsed.params.kind, 'discover_merchant')
	const u = new URL(parsed.shareUrl)
	assert.equal(u.origin, 'https://beamio.ca')
	assert.equal(u.searchParams.get('v'), '1794978675516')
	const innerOut = new URL(u.searchParams.get('target'))
	assert.equal(innerOut.searchParams.get('ref'), INVITER)
})

test('social crawler UA helper recognises SNS crawlers and rejects a browser UA', () => {
	assert.equal(mod.isSocialShareCrawlerUserAgent('facebookexternalhit/1.1'), true)
	assert.equal(mod.isSocialShareCrawlerUserAgent('WhatsApp/2.23.20.0'), true)
	assert.equal(mod.isSocialShareCrawlerUserAgent('Twitterbot/1.0'), true)
	assert.equal(mod.isSocialShareCrawlerUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36'), false)
	assert.equal(mod.isSocialShareCrawlerUserAgent(undefined), false)
})
