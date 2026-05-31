export function parseYoutubeVideoId(raw: string): string | null {
	const input = String(raw ?? '').trim()
	if (!input) return null
	try {
		const url = input.startsWith('http') ? new URL(input) : new URL(`https://${input}`)
		const host = url.hostname.replace(/^www\./, '').toLowerCase()
		if (host === 'youtu.be') {
			const id = url.pathname.replace(/^\//, '').split('/')[0]?.trim()
			return id && /^[\w-]{6,}$/.test(id) ? id : null
		}
		if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
			if (url.pathname === '/watch') {
				const id = url.searchParams.get('v')?.trim()
				return id && /^[\w-]{6,}$/.test(id) ? id : null
			}
			const shorts = url.pathname.match(/^\/shorts\/([\w-]{6,})/)
			if (shorts?.[1]) return shorts[1]
			const embed = url.pathname.match(/^\/embed\/([\w-]{6,})/)
			if (embed?.[1]) return embed[1]
		}
	} catch {
		return null
	}
	return null
}

export function normalizeYoutubeProductionVideoUrl(raw: string): string | null {
	const id = parseYoutubeVideoId(raw)
	if (!id) return null
	return `https://www.youtube.com/watch?v=${id}`
}

export function youtubeEmbedUrlFromVideoId(videoId: string): string {
	return `https://www.youtube.com/embed/${videoId}?rel=0`
}

export type YoutubeProductionVideoValidateSuccess = {
	ok: true
	videoId: string
	normalizedUrl: string
	embedUrl: string
	/** Video title (maps to catalog item subtitle in bizSite). */
	title: string
	/** Channel @handle when present in author URL, else oEmbed author display name (catalog item name). */
	channelUsername: string
	/** Video description from watch page metadata when available. */
	description: string
}

export type YoutubeProductionVideoValidateFailure = {
	ok: false
	error: string
}

export type YoutubeProductionVideoValidateResult =
	| YoutubeProductionVideoValidateSuccess
	| YoutubeProductionVideoValidateFailure

type YoutubeOEmbedResponse = {
	title?: string
	author_name?: string
	author_url?: string
	thumbnail_url?: string
}

/** oEmbed often returns percent-encoded handles in `author_url` (e.g. `/@%E7%9D%A1…`). */
export function decodeYoutubeUrlPathSegment(segment: string): string {
	const raw = String(segment ?? '').trim()
	if (!raw) return ''
	try {
		return decodeURIComponent(raw.replace(/\+/g, ' '))
	} catch {
		return raw
	}
}

/** Prefer decoded `@handle` from `https://www.youtube.com/@handle` oEmbed author_url. */
export function youtubeChannelUsernameFromAuthorUrl(authorUrl: string, authorName: string): string {
	const url = String(authorUrl ?? '').trim()
	if (url) {
		try {
			const parsed = new URL(url)
			const handleMatch = parsed.pathname.match(/^\/@([^/?#]+)/)
			if (handleMatch?.[1]) return decodeYoutubeUrlPathSegment(handleMatch[1])
			const userMatch = parsed.pathname.match(/^\/user\/([^/?#]+)/)
			if (userMatch?.[1]) return decodeYoutubeUrlPathSegment(userMatch[1])
			const cMatch = parsed.pathname.match(/^\/c\/([^/?#]+)/)
			if (cMatch?.[1]) return decodeYoutubeUrlPathSegment(cMatch[1])
		} catch {
			// fall through
		}
	}
	return String(authorName ?? '').trim()
}

/** Parse `"shortDescription":"..."` from YouTube watch HTML (no Data API key). */
export function extractYoutubeShortDescriptionFromWatchHtml(html: string): string {
	const marker = '"shortDescription":"'
	const idx = html.indexOf(marker)
	if (idx < 0) return ''
	const start = idx + marker.length
	let end = start
	let escaped = false
	for (; end < html.length; end++) {
		const ch = html[end]
		if (escaped) {
			escaped = false
			continue
		}
		if (ch === '\\') {
			escaped = true
			continue
		}
		if (ch === '"') break
	}
	if (end <= start) return ''
	try {
		return JSON.parse(`"${html.slice(start, end)}"`) as string
	} catch {
		return ''
	}
}

async function fetchYoutubeVideoDescription(
	videoId: string,
	signal?: AbortSignal
): Promise<string> {
	const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 12_000)
	const merged = signal
		? (() => {
				if (signal.aborted) controller.abort()
				else signal.addEventListener('abort', () => controller.abort(), { once: true })
				return controller.signal
			})()
		: controller.signal
	try {
		const resp = await fetch(watchUrl, {
			method: 'GET',
			headers: {
				Accept: 'text/html,application/xhtml+xml',
				'Accept-Language': 'en-US,en;q=0.9',
				'User-Agent':
					'Mozilla/5.0 (compatible; BeamioYoutubeValidator/1.0; +https://beamio.app)',
			},
			signal: merged,
		})
		clearTimeout(timeout)
		if (!resp.ok) return ''
		const html = await resp.text()
		return extractYoutubeShortDescriptionFromWatchHtml(html).trim()
	} catch {
		clearTimeout(timeout)
		return ''
	}
}

/** Server-side playability check via YouTube oEmbed (no download). */
export async function validateYoutubeProductionVideoUrl(
	rawUrl: string
): Promise<YoutubeProductionVideoValidateResult> {
	const normalizedUrl = normalizeYoutubeProductionVideoUrl(rawUrl)
	if (!normalizedUrl) {
		return { ok: false, error: 'Enter a valid YouTube URL (youtube.com or youtu.be).' }
	}
	const videoId = parseYoutubeVideoId(normalizedUrl)
	if (!videoId) {
		return { ok: false, error: 'Enter a valid YouTube URL (youtube.com or youtu.be).' }
	}

	const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(normalizedUrl)}&format=json`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 15_000)
	try {
		const resp = await fetch(oembedUrl, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			signal: controller.signal,
		})
		clearTimeout(timeout)
		if (!resp.ok) {
			return {
				ok: false,
				error: 'This YouTube video is unavailable, private, or cannot be embedded.',
			}
		}
		const data = (await resp.json()) as YoutubeOEmbedResponse
		const title = typeof data.title === 'string' ? data.title.trim() : ''
		if (!title) {
			return {
				ok: false,
				error: 'This YouTube video could not be verified. Try another link.',
			}
		}
		const authorName = typeof data.author_name === 'string' ? data.author_name.trim() : ''
		const authorUrl = typeof data.author_url === 'string' ? data.author_url.trim() : ''
		const channelUsername = youtubeChannelUsernameFromAuthorUrl(authorUrl, authorName)
		if (!channelUsername) {
			return {
				ok: false,
				error: 'This YouTube channel could not be verified. Try another link.',
			}
		}
		const description = await fetchYoutubeVideoDescription(videoId)
		return {
			ok: true,
			videoId,
			normalizedUrl,
			embedUrl: youtubeEmbedUrlFromVideoId(videoId),
			title,
			channelUsername,
			description,
		}
	} catch {
		clearTimeout(timeout)
		return {
			ok: false,
			error: 'Could not reach YouTube to verify this video. Check your connection and try again.',
		}
	}
}
