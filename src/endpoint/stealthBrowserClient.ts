import Colors from 'colors/safe'
import { logger } from '../logger'
import { STEALTH_BROWSER_UA } from './stealthBrowserChallenge'

export { STEALTH_BROWSER_UA }

export const STEALTH_BROWSER_DEFAULT_URL = 'http://127.0.0.1:17331'
const CLIENT_TIMEOUT_MS = 40_000

export type StealthBrowserFetchResult = {
	url: string
	html: string
	contentLang: string
}

function stealthDisabled(): boolean {
	const v = (process.env.BEAMIO_STEALTH_BROWSER_DISABLED || '').trim()
	return v === '1' || /^true$/i.test(v)
}

function daemonBaseUrl(): string {
	const raw = (process.env.BEAMIO_STEALTH_BROWSER_URL || STEALTH_BROWSER_DEFAULT_URL).trim()
	return raw.replace(/\/+$/, '')
}

/**
 * Cluster-side client. Talks only to the localhost stealth daemon.
 * Returns null when the sidecar is down, disabled, or times out — callers keep slug/fetch fallbacks.
 */
export async function fetchHtmlViaStealthBrowser(url: string): Promise<StealthBrowserFetchResult | null> {
	if (stealthDisabled()) return null
	const target = url.trim()
	if (!target) return null
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS)
	try {
		const res = await fetch(`${daemonBaseUrl()}/fetch`, {
			method: 'POST',
			signal: ac.signal,
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: target }),
		})
		if (res.status === 503) return null
		if (!res.ok) return null
		const body = (await res.json()) as {
			ok?: boolean
			url?: string
			html?: string
			contentLang?: string
		}
		if (!body?.ok || typeof body.html !== 'string' || !body.html) return null
		const finalUrl = typeof body.url === 'string' && body.url ? body.url : target
		return {
			url: finalUrl,
			html: body.html,
			contentLang: typeof body.contentLang === 'string' ? body.contentLang : '',
		}
	} catch (e) {
		logger(Colors.yellow('[stealthBrowserClient]'), (e as Error)?.message ?? e)
		return null
	} finally {
		clearTimeout(timer)
	}
}
