import type { Request, Response, Router } from 'express'
import { Readable } from 'stream'
import Colors from 'colors/safe'
import { logger } from '../logger'

/** Default program-card (#0) fragment — must return image/* for explorers. */
export const DEFAULT_METADATA_FRAGMENT_HASH =
	'0x6022e4efb44990767d1faa1642f570ed8a49ab0417b370aaae35f84884061c97'

const FRAGMENT_HASH_RE = /^0x[a-fA-F0-9]{64}$/

function beamioPublicApiOrigin(): string {
	return (process.env.BEAMIO_PUBLIC_API_ORIGIN || 'https://beamio.app').replace(/\/$/, '')
}

function ipfsFragmentOrigin(): string {
	return (process.env.BEAMIO_IPFS_FRAGMENT_ORIGIN || 'https://ipfs.conet.network').replace(/\/$/, '')
}

/** Same-origin explorer image URL (metadata `image` on token #0). */
export function beamioAppFragmentProxyUrl(
	hash: string,
	extraQuery?: Record<string, string | undefined>
): string {
	const norm = normalizeFragmentHash(hash)
	if (!norm) return beamioAppFragmentProxyUrl(DEFAULT_METADATA_FRAGMENT_HASH)
	const params = new URLSearchParams({ hash: norm })
	if (extraQuery) {
		for (const [key, value] of Object.entries(extraQuery)) {
			if (value != null && String(value).trim() !== '') params.set(key, String(value).trim())
		}
	}
	return `${beamioPublicApiOrigin()}/api/fragment?${params.toString()}`
}

export const DEFAULT_METADATA_IMAGE_PROXY_URL = beamioAppFragmentProxyUrl(DEFAULT_METADATA_FRAGMENT_HASH)

/** Program card icon (#0 and fungible ids 1–99): same proxy URL for explorers. */
export function resolveCatalogPointsExplorerImageUrl(fallbackImage?: string): string {
	return explorerProxyImageUrl(fallbackImage) ?? DEFAULT_METADATA_IMAGE_PROXY_URL
}

export function normalizeFragmentHash(raw: string): string | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	const body = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed
	if (!/^[a-fA-F0-9]{64}$/.test(body)) return null
	return `0x${body.toLowerCase()}`
}

/** Parse `hash` from ipfs.conet.network `/api/getFragment` URLs (and already-proxied beamio.app URLs). */
export function parseFragmentHashFromImageUrl(url: string): string | null {
	try {
		const u = new URL(url.trim())
		const host = u.hostname.toLowerCase()
		if (host === 'ipfs.conet.network' || host.endsWith('.ipfs.conet.network')) {
			if (!u.pathname.endsWith('/getFragment')) return null
		} else if (host === 'beamio.app' || host.endsWith('.beamio.app')) {
			if (u.pathname !== '/api/fragment') return null
		} else {
			return null
		}
		const hash = u.searchParams.get('hash')
		return hash ? normalizeFragmentHash(hash) : null
	} catch {
		return null
	}
}

/** Rewrite CoNET fragment URLs to `https://beamio.app/api/fragment?hash=…` for explorer crawlers. */
export function explorerProxyImageUrl(image: string | undefined): string | undefined {
	if (!image || typeof image !== 'string') return image
	const trimmed = image.trim()
	if (!trimmed) return image
	const hash = parseFragmentHashFromImageUrl(trimmed)
	if (!hash) return image
	try {
		const u = new URL(trimmed)
		const t = u.searchParams.get('t') ?? undefined
		return beamioAppFragmentProxyUrl(hash, t ? { t } : undefined)
	} catch {
		return beamioAppFragmentProxyUrl(hash)
	}
}

const UPSTREAM_PASS_HEADERS = [
	'content-type',
	'content-length',
	'accept-ranges',
	'content-range',
	'etag',
	'last-modified',
] as const

async function proxyFragmentToResponse(req: Request, res: Response): Promise<void> {
	const hashRaw = typeof req.query.hash === 'string' ? req.query.hash.trim() : ''
	const hash = normalizeFragmentHash(hashRaw)
	if (!hash || !FRAGMENT_HASH_RE.test(hash)) {
		res.status(400).json({ error: 'Invalid or missing hash' })
		return
	}

	const upstream = new URL(`${ipfsFragmentOrigin()}/api/getFragment`)
	upstream.searchParams.set('hash', hash)
	const t = typeof req.query.t === 'string' ? req.query.t.trim() : ''
	if (t) upstream.searchParams.set('t', t)

	const headers: Record<string, string> = { 'User-Agent': 'Beamio/1.0 (https://beamio.app)' }
	if (typeof req.headers.range === 'string') headers.Range = req.headers.range

	const upstreamRes = await fetch(upstream.toString(), { headers, redirect: 'follow' })
	res.status(upstreamRes.status)
	for (const name of UPSTREAM_PASS_HEADERS) {
		const value = upstreamRes.headers.get(name)
		if (value) res.setHeader(name, value)
	}
	res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
	res.setHeader('Access-Control-Allow-Origin', '*')

	if (!upstreamRes.ok) {
		const text = await upstreamRes.text().catch(() => '')
		res.send(text)
		return
	}

	if (!upstreamRes.body) {
		res.end()
		return
	}

	Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream).pipe(res)
}

/** GET /api/fragment?hash=0x… — same-origin proxy to ipfs.conet.network getFragment (Range-aware). */
export function registerBeamioFragmentProxyRoute(router: Router): void {
	router.get('/fragment', async (req, res) => {
		try {
			await proxyFragmentToResponse(req, res)
		} catch (e: unknown) {
			logger(
				Colors.yellow('[fragment proxy]'),
				e instanceof Error ? e.message : e,
				typeof req.query.hash === 'string' ? req.query.hash.slice(0, 18) : ''
			)
			if (!res.headersSent) {
				res.status(502).json({ error: 'Failed to fetch fragment' })
			}
		}
	})
}
