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
	title: string
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
	thumbnail_url?: string
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
		return {
			ok: true,
			videoId,
			normalizedUrl,
			embedUrl: youtubeEmbedUrlFromVideoId(videoId),
			title,
		}
	} catch {
		clearTimeout(timeout)
		return {
			ok: false,
			error: 'Could not reach YouTube to verify this video. Check your connection and try again.',
		}
	}
}
