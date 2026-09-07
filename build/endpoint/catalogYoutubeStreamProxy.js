"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CATALOG_YOUTUBE_MIRROR_MAX_SECONDS = void 0;
exports.ipfsFragmentPublicOrigin = ipfsFragmentPublicOrigin;
exports.catalogYoutubeStreamPublicUrl = catalogYoutubeStreamPublicUrl;
exports.catalogYoutubeMirrorCacheDir = catalogYoutubeMirrorCacheDir;
exports.catalogYoutubeMirrorCachePath = catalogYoutubeMirrorCachePath;
exports.catalogYoutubeStreamProxyUrl = catalogYoutubeStreamProxyUrl;
exports.registerCatalogYoutubeStreamProxyRoute = registerCatalogYoutubeStreamProxyRoute;
/**
 * Mirror YouTube catalog clips to cached MP4 and serve same-origin for in-page `<video>`.
 * Requires `yt-dlp` and `ffmpeg` on the Beamio API host (conet.network).
 */
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const FsPromises = __importStar(require("fs/promises"));
const Os = __importStar(require("os"));
const Path = __importStar(require("path"));
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
/** Align with bizSite production background video max clip length. */
exports.CATALOG_YOUTUBE_MIRROR_MAX_SECONDS = 60;
const CACHE_SUBDIR = 'beamio-youtube-mirror';
const MIN_CACHED_BYTES = 4096;
const inflightMirror = new Map();
function ipfsFragmentPublicOrigin() {
    return (process.env.BEAMIO_IPFS_FRAGMENT_ORIGIN || 'https://ipfs.conet.network').replace(/\/$/, '');
}
/** Public URL for browser `<video src>` (hosted on ipfs.conet.network). */
function catalogYoutubeStreamPublicUrl(videoId) {
    const id = videoId.trim();
    return `${ipfsFragmentPublicOrigin()}/api/catalogYoutubeStream?v=${encodeURIComponent(id)}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ytDlpBin() {
    return (process.env.YT_DLP_PATH || 'yt-dlp').trim() || 'yt-dlp';
}
function ffmpegBin() {
    return (process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
}
function catalogYoutubeMirrorCacheDir() {
    const custom = process.env.BEAMIO_YOUTUBE_MIRROR_CACHE_DIR?.trim();
    if (custom)
        return custom;
    return Path.join(Os.homedir(), '.data', CACHE_SUBDIR);
}
function catalogYoutubeMirrorCachePath(videoId) {
    return Path.join(catalogYoutubeMirrorCacheDir(), `${videoId}.mp4`);
}
/** @deprecated Prefer catalogYoutubeStreamPublicUrl (IPFS host). */
function catalogYoutubeStreamProxyUrl(videoId) {
    return catalogYoutubeStreamPublicUrl(videoId);
}
function parseBytesRange(rangeHeader, size) {
    if (!rangeHeader?.startsWith('bytes='))
        return null;
    const spec = rangeHeader.slice(6).split(',')[0]?.trim() ?? '';
    const m = /^(\d*)-(\d*)$/.exec(spec);
    if (!m)
        return 'unsatisfiable';
    let start = m[1] ? Number.parseInt(m[1], 10) : NaN;
    let end = m[2] ? Number.parseInt(m[2], 10) : NaN;
    if (Number.isNaN(start))
        start = size - (Number.isNaN(end) ? 0 : end);
    if (Number.isNaN(end))
        end = size - 1;
    if (start < 0 || end < start || start >= size)
        return 'unsatisfiable';
    return { start, end: Math.min(end, size - 1) };
}
function streamFileWithRange(req, res, filePath, mimeType, size) {
    const parsed = parseBytesRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (parsed === 'unsatisfiable') {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
    }
    if (!parsed) {
        res.status(200);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', String(size));
        (0, fs_1.createReadStream)(filePath).pipe(res);
        return;
    }
    const { start, end } = parsed;
    res.status(206);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    (0, fs_1.createReadStream)(filePath, { start, end }).pipe(res);
}
function runCommand(cmd, args, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`${cmd} timed out`));
        }, timeoutMs);
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            if (err.code === 'ENOENT') {
                reject(new Error(`${cmd} not found on server`));
                return;
            }
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve();
            else
                reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
        });
    });
}
async function faststartMp4(inputPath, outputPath) {
    try {
        await runCommand(ffmpegBin(), ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outputPath], 90_000);
        return true;
    }
    catch {
        return false;
    }
}
async function mirrorYoutubeToCache(videoId) {
    const cacheDir = catalogYoutubeMirrorCacheDir();
    await FsPromises.mkdir(cacheDir, { recursive: true });
    const out = catalogYoutubeMirrorCachePath(videoId);
    const tmp = `${out}.work.mp4`;
    const fast = `${out}.fast.mp4`;
    await FsPromises.unlink(tmp).catch(() => { });
    await FsPromises.unlink(fast).catch(() => { });
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await runCommand(ytDlpBin(), [
        '--no-playlist',
        '--no-warnings',
        '-f',
        'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b',
        '--merge-output-format',
        'mp4',
        '--download-section',
        `*0-${exports.CATALOG_YOUTUBE_MIRROR_MAX_SECONDS}`,
        '--force-keyframes-at-cuts',
        '--socket-timeout',
        '45',
        '-o',
        tmp,
        url,
    ]);
    const st = await FsPromises.stat(tmp);
    if (!st.isFile() || st.size < MIN_CACHED_BYTES) {
        throw new Error('YouTube mirror produced empty file');
    }
    if (await faststartMp4(tmp, fast)) {
        await FsPromises.rename(fast, out);
        await FsPromises.unlink(tmp).catch(() => { });
    }
    else {
        await FsPromises.rename(tmp, out);
    }
    return out;
}
async function waitForCachedFile(out, attempts = 180) {
    for (let i = 0; i < attempts; i += 1) {
        try {
            const st = await FsPromises.stat(out);
            if (st.isFile() && st.size >= MIN_CACHED_BYTES)
                return out;
        }
        catch {
            /* not ready */
        }
        await sleep(1000);
    }
    return null;
}
async function resolveCachedMirrorPath(videoId) {
    const out = catalogYoutubeMirrorCachePath(videoId);
    try {
        const st = await FsPromises.stat(out);
        if (st.isFile() && st.size >= MIN_CACHED_BYTES)
            return out;
    }
    catch {
        /* cache miss */
    }
    let task = inflightMirror.get(videoId);
    if (!task) {
        task = (async () => {
            const lockPath = `${out}.lock`;
            try {
                await FsPromises.writeFile(lockPath, `${process.pid}@${Date.now()}`, { flag: 'wx' });
            }
            catch {
                const ready = await waitForCachedFile(out);
                if (ready)
                    return ready;
                throw new Error('YouTube mirror already in progress; try again shortly');
            }
            try {
                return await mirrorYoutubeToCache(videoId);
            }
            finally {
                await FsPromises.unlink(lockPath).catch(() => { });
            }
        })().finally(() => {
            inflightMirror.delete(videoId);
        });
        inflightMirror.set(videoId, task);
    }
    return task;
}
async function serveMirrorFile(req, res, videoId) {
    const filePath = await resolveCachedMirrorPath(videoId);
    const st = await FsPromises.stat(filePath);
    streamFileWithRange(req, res, filePath, 'video/mp4', st.size);
}
/** GET|HEAD /api/catalogYoutubeStream?v={11-char id} — Range-aware MP4 proxy. */
function registerCatalogYoutubeStreamProxyRoute(router) {
    const handler = async (req, res) => {
        const v = typeof req.query.v === 'string' ? req.query.v.trim() : '';
        if (!YOUTUBE_VIDEO_ID_RE.test(v)) {
            res.status(400).json({ error: 'Invalid or missing v (YouTube video id)' });
            return;
        }
        try {
            if (req.method === 'HEAD') {
                const filePath = await resolveCachedMirrorPath(v);
                const st = await FsPromises.stat(filePath);
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Content-Length', String(st.size));
                res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.status(200).end();
                return;
            }
            await serveMirrorFile(req, res, v);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logger)(safe_1.default.yellow('[catalogYoutubeStream]'), v, msg);
            const missingTool = /not found on server/i.test(msg);
            if (!res.headersSent) {
                res.status(missingTool ? 503 : 502).json({
                    error: missingTool
                        ? 'YouTube mirror tools not installed (yt-dlp, ffmpeg)'
                        : 'Failed to prepare YouTube stream',
                    detail: msg.slice(0, 240),
                });
            }
        }
    };
    router.get('/catalogYoutubeStream', handler);
    router.head('/catalogYoutubeStream', handler);
}
