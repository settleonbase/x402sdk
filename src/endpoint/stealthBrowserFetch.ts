import type { Browser, BrowserContext } from 'playwright'
import { chromium } from 'playwright'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { isStealthChallengeHtml, STEALTH_BROWSER_UA } from './stealthBrowserChallenge'
import { assertPublicHost, hostnameBlocked, parsePublicHttpUrl } from './stealthBrowserSsrf'

export const STEALTH_MAX_HTML_BYTES = 512 * 1024
const NAV_TIMEOUT_MS = 25_000
const CHALLENGE_WAIT_MS = 22_000
const SETTLE_TIMEOUT_MS = 8_000
const PAGE_TOTAL_MS = 35_000

const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
});
`

function timezoneForUrl(url: string): string {
	try {
		const u = new URL(url)
		const m = u.pathname.match(/^\/([a-z]{2})(?:\/|$)/i)
		const cc = (m?.[1] || '').toLowerCase()
		const map: Record<string, string> = {
			ca: 'America/Toronto',
			us: 'America/New_York',
			au: 'Australia/Sydney',
			gb: 'Europe/London',
			uk: 'Europe/London',
			de: 'Europe/Berlin',
			fr: 'Europe/Paris',
			jp: 'Asia/Tokyo',
			nz: 'Pacific/Auckland',
			sg: 'Asia/Singapore',
			hk: 'Asia/Hong_Kong',
			tw: 'Asia/Taipei',
		}
		if (cc && map[cc]) return map[cc]
	} catch {
		/* ignore */
	}
	return 'America/New_York'
}

const launchArgs = [
	'--disable-blink-features=AutomationControlled',
	'--no-sandbox',
	'--disable-dev-shm-usage',
	'--disable-infobars',
	'--window-size=1920,1080',
	'--lang=en-US',
	'--headless=new',
]

let browserPromise: Promise<Browser> | null = null

async function launchBrowser(): Promise<Browser> {
	const executablePath = (process.env.BEAMIO_STEALTH_BROWSER_EXECUTABLE || '').trim() || undefined
	const channel = (process.env.BEAMIO_STEALTH_BROWSER_CHANNEL || 'chrome').trim()
	const common = {
		headless: true,
		ignoreDefaultArgs: ['--enable-automation'],
		args: launchArgs,
	}
	if (executablePath) {
		return chromium.launch({ ...common, executablePath })
	}
	try {
		return await chromium.launch({ ...common, channel: channel as 'chrome' | 'chromium' })
	} catch (e) {
		logger(Colors.yellow('[stealthBrowserFetch] chrome channel failed, bundled Chromium:'), (e as Error)?.message ?? e)
		return chromium.launch(common)
	}
}

async function getBrowser(): Promise<Browser> {
	if (!browserPromise) {
		browserPromise = launchBrowser().catch((err) => {
			browserPromise = null
			throw err
		})
	}
	const browser = await browserPromise
	if (!browser.isConnected()) {
		browserPromise = null
		return getBrowser()
	}
	return browser
}

export async function closeStealthBrowser(): Promise<void> {
	const p = browserPromise
	browserPromise = null
	if (!p) return
	try {
		const b = await p
		await b.close()
	} catch {
		/* ignore */
	}
}

async function waitOutChallenge(page: { title: () => Promise<string>; content: () => Promise<string> }): Promise<void> {
	const deadline = Date.now() + CHALLENGE_WAIT_MS
	while (Date.now() < deadline) {
		const title = await page.title().catch(() => '')
		const html = await page.content().catch(() => '')
		const sample = `${title}\n${html.slice(0, 12_000)}`
		if (!isStealthChallengeHtml(sample)) return
		await new Promise((r) => setTimeout(r, 400))
	}
}

export type StealthFetchOk = { url: string; html: string; contentLang: string }

export async function stealthFetchHtml(startUrl: string): Promise<StealthFetchOk | null> {
	const start = parsePublicHttpUrl(startUrl)
	if (!start || start.protocol !== 'https:') return null
	if (!(await assertPublicHost(start))) return null

	const browser = await getBrowser()
	let context: BrowserContext | undefined
	const watchdog = setTimeout(() => {
		void context?.close().catch(() => undefined)
	}, PAGE_TOTAL_MS)
	try {
		context = await browser.newContext({
			userAgent: STEALTH_BROWSER_UA,
			viewport: { width: 1920, height: 1080 },
			locale: 'en-US',
			timezoneId: timezoneForUrl(start.toString()),
			extraHTTPHeaders: {
				'Accept-Language': 'en-US,en;q=0.9',
			},
		})
		await context.addInitScript(STEALTH_INIT_SCRIPT)
		const page = await context.newPage()
		await page.route('**/*', (route) => {
			const reqUrl = route.request().url()
			try {
				const u = new URL(reqUrl)
				if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.continue()
				if (hostnameBlocked(u.hostname)) return route.abort()
			} catch {
				return route.continue()
			}
			return route.continue()
		})
		await page.goto(start.toString(), {
			waitUntil: 'domcontentloaded',
			timeout: NAV_TIMEOUT_MS,
			referer: 'https://www.google.com/',
		})
		await waitOutChallenge(page)
		await page.waitForSelector('h1, script[type="application/ld+json"]', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined)
		await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)

		const finalRaw = page.url()
		const final = parsePublicHttpUrl(finalRaw)
		if (!final) return null
		if (!(await assertPublicHost(final))) return null

		let html = await page.content()
		if (html.length > STEALTH_MAX_HTML_BYTES) html = html.slice(0, STEALTH_MAX_HTML_BYTES)
		if (isStealthChallengeHtml(html.slice(0, 16_000))) return null
		const contentLang = await page
			.locator('html')
			.getAttribute('lang')
			.then((v) => (v || '').trim())
			.catch(() => '')
		return { url: final.toString(), html, contentLang }
	} catch (e) {
		logger(Colors.yellow('[stealthBrowserFetch]'), (e as Error)?.message ?? e)
		return null
	} finally {
		clearTimeout(watchdog)
		if (context) await context.close().catch(() => undefined)
	}
}
