"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_METADATA_IMAGE_PROXY_URL = exports.DEFAULT_METADATA_FRAGMENT_HASH = void 0;
exports.beamioAppFragmentProxyUrl = beamioAppFragmentProxyUrl;
exports.resolveCatalogPointsExplorerImageUrl = resolveCatalogPointsExplorerImageUrl;
exports.normalizeFragmentHash = normalizeFragmentHash;
exports.parseFragmentHashFromImageUrl = parseFragmentHashFromImageUrl;
exports.explorerProxyImageUrl = explorerProxyImageUrl;
exports.registerBeamioFragmentProxyRoute = registerBeamioFragmentProxyRoute;
const stream_1 = require("stream");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("../logger");
/** Default program-card (#0) fragment — must return image/* for explorers. */
exports.DEFAULT_METADATA_FRAGMENT_HASH = '0x6022e4efb44990767d1faa1642f570ed8a49ab0417b370aaae35f84884061c97';
const FRAGMENT_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
function beamioPublicApiOrigin() {
    return (process.env.BEAMIO_PUBLIC_API_ORIGIN || 'https://beamio.app').replace(/\/$/, '');
}
function ipfsFragmentOrigin() {
    return (process.env.BEAMIO_IPFS_FRAGMENT_ORIGIN || 'https://ipfs.conet.network').replace(/\/$/, '');
}
/** Same-origin explorer image URL (metadata `image` on token #0). */
function beamioAppFragmentProxyUrl(hash, extraQuery) {
    const norm = normalizeFragmentHash(hash);
    if (!norm)
        return beamioAppFragmentProxyUrl(exports.DEFAULT_METADATA_FRAGMENT_HASH);
    const params = new URLSearchParams({ hash: norm });
    if (extraQuery) {
        for (const [key, value] of Object.entries(extraQuery)) {
            if (value != null && String(value).trim() !== '')
                params.set(key, String(value).trim());
        }
    }
    return `${beamioPublicApiOrigin()}/api/fragment?${params.toString()}`;
}
exports.DEFAULT_METADATA_IMAGE_PROXY_URL = beamioAppFragmentProxyUrl(exports.DEFAULT_METADATA_FRAGMENT_HASH);
/** Program card icon (#0 and fungible ids 1–99): same proxy URL for explorers. */
function resolveCatalogPointsExplorerImageUrl(fallbackImage) {
    return explorerProxyImageUrl(fallbackImage) ?? exports.DEFAULT_METADATA_IMAGE_PROXY_URL;
}
function normalizeFragmentHash(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    const body = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
    if (!/^[a-fA-F0-9]{64}$/.test(body))
        return null;
    return `0x${body.toLowerCase()}`;
}
/** Parse `hash` from ipfs.conet.network `/api/getFragment` URLs (and already-proxied beamio.app URLs). */
function parseFragmentHashFromImageUrl(url) {
    try {
        const u = new URL(url.trim());
        const host = u.hostname.toLowerCase();
        if (host === 'ipfs.conet.network' || host.endsWith('.ipfs.conet.network')) {
            if (!u.pathname.endsWith('/getFragment'))
                return null;
        }
        else if (host === 'beamio.app' || host.endsWith('.beamio.app')) {
            if (u.pathname !== '/api/fragment')
                return null;
        }
        else {
            return null;
        }
        const hash = u.searchParams.get('hash');
        return hash ? normalizeFragmentHash(hash) : null;
    }
    catch {
        return null;
    }
}
/** Rewrite CoNET fragment URLs to `https://beamio.app/api/fragment?hash=…` for explorer crawlers. */
function explorerProxyImageUrl(image) {
    if (!image || typeof image !== 'string')
        return image;
    const trimmed = image.trim();
    if (!trimmed)
        return image;
    const hash = parseFragmentHashFromImageUrl(trimmed);
    if (!hash)
        return image;
    try {
        const u = new URL(trimmed);
        const t = u.searchParams.get('t') ?? undefined;
        return beamioAppFragmentProxyUrl(hash, t ? { t } : undefined);
    }
    catch {
        return beamioAppFragmentProxyUrl(hash);
    }
}
const UPSTREAM_PASS_HEADERS = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'etag',
    'last-modified',
];
async function proxyFragmentToResponse(req, res) {
    const hashRaw = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';
    const hash = normalizeFragmentHash(hashRaw);
    if (!hash || !FRAGMENT_HASH_RE.test(hash)) {
        res.status(400).json({ error: 'Invalid or missing hash' });
        return;
    }
    const upstream = new URL(`${ipfsFragmentOrigin()}/api/getFragment`);
    upstream.searchParams.set('hash', hash);
    const t = typeof req.query.t === 'string' ? req.query.t.trim() : '';
    if (t)
        upstream.searchParams.set('t', t);
    const headers = { 'User-Agent': 'Beamio/1.0 (https://beamio.app)' };
    if (typeof req.headers.range === 'string')
        headers.Range = req.headers.range;
    const upstreamRes = await fetch(upstream.toString(), { headers, redirect: 'follow' });
    res.status(upstreamRes.status);
    for (const name of UPSTREAM_PASS_HEADERS) {
        const value = upstreamRes.headers.get(name);
        if (value)
            res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        res.send(text);
        return;
    }
    if (!upstreamRes.body) {
        res.end();
        return;
    }
    stream_1.Readable.fromWeb(upstreamRes.body).pipe(res);
}
/** GET /api/fragment?hash=0x… — same-origin proxy to ipfs.conet.network getFragment (Range-aware). */
function registerBeamioFragmentProxyRoute(router) {
    router.get('/fragment', async (req, res) => {
        try {
            await proxyFragmentToResponse(req, res);
        }
        catch (e) {
            (0, logger_1.logger)(safe_1.default.yellow('[fragment proxy]'), e instanceof Error ? e.message : e, typeof req.query.hash === 'string' ? req.query.hash.slice(0, 18) : '');
            if (!res.headersSent) {
                res.status(502).json({ error: 'Failed to fetch fragment' });
            }
        }
    });
}
