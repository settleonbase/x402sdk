/**
 * Mirror YouTube catalog clips to cached MP4 and serve same-origin for in-page `<video>`.
 * Requires `yt-dlp` and `ffmpeg` on the Beamio API host (conet.network).
 */
import { spawn } from 'child_process'
import { createReadStream } from 'fs'
import * as FsPromises from 'fs/promises'
import * as Os from 'os'
import * as Path from 'path'
import type { Request, Response, Router } from 'express'
import Colors from 'colors/safe'
import { logger } from '../logger'

const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/
/** Align with bizSite production background video max clip length. */
export const CATALOG_YOUTUBE_MIRROR_MAX_SECONDS = 60
const CACHE_SUBDIR = 'beamio-youtube-mirror'
const MIN_CACHED_BYTES = 4096

const inflightMirror = new Map<string, Promise<string>>()

function ytDlpBin(): string {
	return (process.env.YT_DLP_PATH || 'yt-dlp').trim() || 'yt-dlp'
}

function ffmpegBin(): string {
	return (process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg'
}

export function catalogYoutubeMirrorCacheDir(): string {
	const custom = process.env.BEAMIO_YOUTUBE_MIRROR_CACHE_DIR?.trim()
	if (custom) return custom
	return Path.join(Os.homedir(), '.data', CACHE_SUBDIR)
}

export function catalogYoutubeMirrorCachePath(videoId: string): string {
	return Path.join(catalogYoutubeMirrorCacheDir(), `${videoId}.mp4`)
}

/** Same-origin stream URL for homepage / share `<video src>`. */
export function catalogYoutubeStreamProxyUrl(videoId: string): string {
	const id = videoId.trim()
	return `/api/catalogYoutubeStream?v=${encodeURIComponent(id)}`
}

function parseBytesRange(
	rangeHeader: string | undefined,
	size: number
): { start: number; end: number } | null | 'unsatisfiable' {
	if (!rangeHeader?.startsWith('bytes=')) return null
	const spec = rangeHeader.slice(6).split(',')[0]?.trim() ?? ''
	const m = /^(\d*)-(\d*)$/.exec(spec)
	if (!m) return 'unsatisfiable'
	let start = m[1] ? Number.parseInt(m[1], 10) : NaN
	let end = m[2] ? Number.parseInt(m[2], 10) : NaN
	if (Number.isNaN(start)) start = size - (Number.isNaN(end) ? 0 : end)
	if (Number.isNaN(end)) end = size - 1
	if (start < 0 || end < start || start >= size) return 'unsatisfiable'
	return { start, end: Math.min(end, size - 1) }
}

function streamFileWithRange(req: Request, res: Response, filePath: string, mimeType: string, size: number): void {
	const parsed = parseBytesRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)

	res.setHeader('Accept-Ranges', 'bytes')
	res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
	res.setHeader('Access-Control-Allow-Origin', '*')

	if (parsed === 'unsatisfiable') {
		res.status(416)
		res.setHeader('Content-Range', `bytes */${size}`)
		res.end()
		return
	}

	if (!parsed) {
		res.status(200)
		res.setHeader('Content-Type', mimeType)
		res.setHeader('Content-Length', String(size))
		createReadStream(filePath).pipe(res)
		return
	}

	const { start, end } = parsed
	res.status(206)
	res.setHeader('Content-Type', mimeType)
	res.setHeader('Content-Length', String(end - start + 1))
	res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
	createReadStream(filePath, { start, end }).pipe(res)
}

function runCommand(cmd: string, args: string[], timeoutMs = 120_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let stderr = ''
		const timer = setTimeout(() => {
			child.kill('SIGTERM')
			reject(new Error(`${cmd} timed out`))
		}, timeoutMs)
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on('error', (err: NodeJS.ErrnoException) => {
			clearTimeout(timer)
			if (err.code === 'ENOENT') {
				reject(new Error(`${cmd} not found on server`))
				return
			}
			reject(err)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0) resolve()
			else reject(new Error(stderr.trim() || `${cmd} exited ${code}`))
		})
	})
}

async function faststartMp4(inputPath: string, outputPath: string): Promise<boolean> {
	try {
		await runCommand(ffmpegBin(), ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outputPath], 90_000)
		return true
	} catch {
		return false
	}
}

async function mirrorYoutubeToCache(videoId: string): Promise<string> {
	const cacheDir = catalogYoutubeMirrorCacheDir()
	await FsPromises.mkdir(cacheDir, { recursive: true })

	const out = catalogYoutubeMirrorCachePath(videoId)
	const tmp = `${out}.work.mp4`
	const fast = `${out}.fast.mp4`

	await FsPromises.unlink(tmp).catch(() => {})
	await FsPromises.unlink(fast).catch(() => {})

	const url = `https://www.youtube.com/watch?v=${videoId}`
	await runCommand(ytDlpBin(), [
		'--no-playlist',
		'--no-warnings',
		'-f',
		'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b',
		'--merge-output-format',
		'mp4',
		'--download-section',
		`*0-${CATALOG_YOUTUBE_MIRROR_MAX_SECONDS}`,
		'--force-keyframes-at-cuts',
		'--socket-timeout',
		'45',
		'-o',
		tmp,
		url,
	])

	const st = await FsPromises.stat(tmp)
	if (!st.isFile() || st.size < MIN_CACHED_BYTES) {
		throw new Error('YouTube mirror produced empty file')
	}

	if (await faststartMp4(tmp, fast)) {
		await FsPromises.rename(fast, out)
		await FsPromises.unlink(tmp).catch(() => {})
	} else {
		await FsPromises.rename(tmp, out)
	}

	return out
}

async function resolveCachedMirrorPath(videoId: string): Promise<string> {
	const out = catalogYoutubeMirrorCachePath(videoId)
	try {
		const st = await FsPromises.stat(out)
		if (st.isFile() && st.size >= MIN_CACHED_BYTES) return out
	} catch {
		/* cache miss */
	}

	let task = inflightMirror.get(videoId)
	if (!task) {
		task = mirrorYoutubeToCache(videoId).finally(() => {
			inflightMirror.delete(videoId)
		})
		inflightMirror.set(videoId, task)
	}
	return task
}

async function serveMirrorFile(req: Request, res: Response, videoId: string): Promise<void> {
	const filePath = await resolveCachedMirrorPath(videoId)
	const st = await FsPromises.stat(filePath)
	streamFileWithRange(req, res, filePath, 'video/mp4', st.size)
}

/** GET|HEAD /api/catalogYoutubeStream?v={11-char id} — Range-aware MP4 proxy. */
export function registerCatalogYoutubeStreamProxyRoute(router: Router): void {
	const handler = async (req: Request, res: Response): Promise<void> => {
		const v = typeof req.query.v === 'string' ? req.query.v.trim() : ''
		if (!YOUTUBE_VIDEO_ID_RE.test(v)) {
			res.status(400).json({ error: 'Invalid or missing v (YouTube video id)' })
			return
		}

		try {
			if (req.method === 'HEAD') {
				const filePath = await resolveCachedMirrorPath(v)
				const st = await FsPromises.stat(filePath)
				res.setHeader('Accept-Ranges', 'bytes')
				res.setHeader('Content-Type', 'video/mp4')
				res.setHeader('Content-Length', String(st.size))
				res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
				res.setHeader('Access-Control-Allow-Origin', '*')
				res.status(200).end()
				return
			}

			await serveMirrorFile(req, res, v)
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e)
			logger(Colors.yellow('[catalogYoutubeStream]'), v, msg)
			const missingTool = /not found on server/i.test(msg)
			if (!res.headersSent) {
				res.status(missingTool ? 503 : 502).json({
					error: missingTool
						? 'YouTube mirror tools not installed (yt-dlp, ffmpeg)'
						: 'Failed to prepare YouTube stream',
					detail: msg.slice(0, 240),
				})
			}
		}
	}

	router.get('/catalogYoutubeStream', handler)
	router.head('/catalogYoutubeStream', handler)
}
