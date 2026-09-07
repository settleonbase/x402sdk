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
exports.FRAGMENT_UPLOAD_CHUNK_BYTES = void 0;
const express_1 = __importStar(require("express"));
const multer_1 = __importDefault(require("multer"));
const logger_1 = require("../logger");
const safe_1 = __importDefault(require("colors/safe"));
const node_http_1 = require("node:http");
const node_fs_1 = __importStar(require("node:fs"));
const util_1 = require("../util");
const node_cluster_1 = __importDefault(require("node:cluster"));
const node_fs_2 = require("node:fs");
const db_1 = require("../db");
const ethers_1 = require("ethers");
const catalogYoutubeStreamProxy_1 = require("./catalogYoutubeStreamProxy");
const kuboFragmentPin_1 = require("./kuboFragmentPin");
const storagePATH = util_1.masterSetup.storagePATH;
/** Max bytes per storageFragmentChunk part (512 KiB). Client uses multipart `chunk`; legacy JSON uses chunkBase64. */
exports.FRAGMENT_UPLOAD_CHUNK_BYTES = 512 * 1024;
const fragmentChunkMulter = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: exports.FRAGMENT_UPLOAD_CHUNK_BYTES },
});
const workerNumber = node_cluster_1.default?.worker?.id ? `worker : ${node_cluster_1.default.worker.id} ` : `${node_cluster_1.default?.isPrimary ? 'Cluster Master' : 'Cluster unknow'}`;
function fragmentPaths(hash) {
    const base = `${storagePATH}/${hash}`;
    return {
        text: base,
        binary: `${base}.bin`,
        meta: `${base}.meta.json`,
    };
}
function fragmentUploadPaths(hash) {
    return {
        partial: `${storagePATH}/${hash}.upload`,
        meta: `${storagePATH}/${hash}.upload.meta.json`,
    };
}
/**
 * Deterministic custom pointer alias (`point-0x<64hex>`) → current content hash.
 * Used by @beamio/chat-sdk encrypted history: a fixed, EOA-derived locator that always
 * resolves to the freshest index CID without exposing which fragment is the index.
 *
 * Owner-bound + monotonic ts → only the same EOA can re-point (anti-hijack, anti-rollback).
 */
const POINTER_PREFIX = 'point-';
/** point-0x + 64 hex. */
const POINTER_RE = /^point-0x[0-9a-fA-F]{64}$/;
/** Reject pointer writes whose signed timestamp is older/newer than this window (seconds). */
const POINTER_TS_WINDOW_SEC = 24 * 60 * 60;
function isPointerHash(hash) {
    return typeof hash === 'string' && hash.startsWith(POINTER_PREFIX);
}
function pointerAliasPath(pointer) {
    // pointer already namespaced by `point-` prefix; keep as its own sidecar file.
    return `${storagePATH}/${pointer}.alias.json`;
}
async function readPointerAlias(pointer) {
    try {
        const raw = await node_fs_1.default.promises.readFile(pointerAliasPath(pointer), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed?.hash || !parsed?.owner)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
async function writePointerAlias(pointer, record) {
    await node_fs_1.default.promises.writeFile(pointerAliasPath(pointer), JSON.stringify(record));
}
/**
 * Validate + persist a pointer re-point. Returns true when the alias now maps to `contentHash`.
 * Requires an EOA signature over `${pointer}|${contentHash}|${ts}` and owner-binding.
 */
async function applyPointerAlias(args) {
    const { pointer, owner, ts, sig, contentHash } = args;
    if (!pointer)
        return { ok: true }; // no pointer requested; content-addressed only
    if (!POINTER_RE.test(pointer))
        return { ok: false, error: 'Invalid pointer format' };
    if (!owner || !sig || !Number.isFinite(ts))
        return { ok: false, error: 'Missing pointer owner/ts/sig' };
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Number(ts)) > POINTER_TS_WINDOW_SEC) {
        return { ok: false, error: 'Pointer timestamp out of window' };
    }
    const message = `${pointer}|${contentHash}|${ts}`;
    const recovered = (0, util_1.checkSign)(message, sig, owner);
    if (!recovered)
        return { ok: false, error: 'Pointer signature invalid' };
    const existing = await readPointerAlias(pointer);
    if (existing) {
        if (existing.owner.toLowerCase() !== owner.toLowerCase()) {
            return { ok: false, error: 'Pointer owned by another wallet' };
        }
        if (Number(ts) < existing.ts) {
            return { ok: false, error: 'Pointer timestamp rollback' };
        }
    }
    await writePointerAlias(pointer, {
        hash: contentHash,
        owner: owner.toLowerCase(),
        ts: Number(ts),
        updatedAt: Date.now(),
    });
    (0, logger_1.logger)(`applyPointerAlias [${pointer}] → ${contentHash} owner=${owner.toLowerCase()}`);
    return { ok: true };
}
function verifyFragmentWalletSign(wallet, signMessage) {
    if (!wallet || !signMessage)
        return false;
    return Boolean((0, util_1.checkSign)(wallet, signMessage, wallet));
}
async function fragmentFinalExists(hash) {
    try {
        await node_fs_1.default.promises.access(fragmentPaths(hash).text);
        return true;
    }
    catch {
        return false;
    }
}
async function readFragmentUploadMeta(hash) {
    try {
        const raw = await node_fs_1.default.promises.readFile(fragmentUploadPaths(hash).meta, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed?.wallet || !Number.isFinite(parsed.totalSize) || parsed.totalSize <= 0)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
async function writeFragmentUploadMeta(hash, meta) {
    await node_fs_1.default.promises.writeFile(fragmentUploadPaths(hash).meta, JSON.stringify(meta));
}
async function getFragmentUploadReceivedBytes(hash) {
    try {
        const stat = await node_fs_1.default.promises.stat(fragmentUploadPaths(hash).partial);
        return stat.size;
    }
    catch {
        return 0;
    }
}
async function finalizeFragmentChunkUpload(hash) {
    const uploadPaths = fragmentUploadPaths(hash);
    const meta = await readFragmentUploadMeta(hash);
    if (!meta)
        return false;
    const received = await getFragmentUploadReceivedBytes(hash);
    if (received !== meta.totalSize) {
        (0, logger_1.logger)(safe_1.default.red(`finalizeFragmentChunkUpload [${hash}] size mismatch received=${received} expected=${meta.totalSize}`));
        return false;
    }
    const data = await node_fs_1.default.promises.readFile(uploadPaths.partial, 'utf8');
    const computed = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(data));
    if (computed.toLowerCase() !== hash.toLowerCase()) {
        (0, logger_1.logger)(safe_1.default.red(`finalizeFragmentChunkUpload [${hash}] hash mismatch`));
        return false;
    }
    const ok = await saveFragment(hash, data);
    await node_fs_1.default.promises.unlink(uploadPaths.partial).catch(() => undefined);
    await node_fs_1.default.promises.unlink(uploadPaths.meta).catch(() => undefined);
    return ok;
}
async function writeFragmentUploadChunk(args) {
    const { hash, wallet, totalSize, offset, chunk } = args;
    if (chunk.length <= 0 || chunk.length > exports.FRAGMENT_UPLOAD_CHUNK_BYTES) {
        throw new Error('Invalid chunk size');
    }
    if (offset < 0 || offset + chunk.length > totalSize) {
        throw new Error('Chunk out of range');
    }
    if (await fragmentFinalExists(hash)) {
        return { received: totalSize, complete: true };
    }
    const uploadPaths = fragmentUploadPaths(hash);
    let meta = await readFragmentUploadMeta(hash);
    if (!meta) {
        meta = { totalSize, wallet };
        await writeFragmentUploadMeta(hash, meta);
        await node_fs_1.default.promises.writeFile(uploadPaths.partial, Buffer.alloc(0));
    }
    else {
        if (meta.wallet.toLowerCase() !== wallet.toLowerCase()) {
            throw new Error('Upload wallet mismatch');
        }
        if (meta.totalSize !== totalSize) {
            throw new Error('Upload totalSize mismatch');
        }
    }
    const receivedBefore = await getFragmentUploadReceivedBytes(hash);
    if (offset < receivedBefore) {
        return { received: receivedBefore, complete: receivedBefore >= totalSize };
    }
    if (offset > receivedBefore) {
        throw new Error('Upload gap — resume from last received byte');
    }
    await node_fs_1.default.promises.appendFile(uploadPaths.partial, chunk);
    const received = receivedBefore + chunk.length;
    if (received >= totalSize) {
        const ok = await finalizeFragmentChunkUpload(hash);
        if (!ok)
            throw new Error('Finalize upload failed');
        return { received: totalSize, complete: true };
    }
    return { received, complete: false };
}
function isRangeStreamableMime(mime) {
    const normalized = mime.toLowerCase().split(';')[0].trim();
    return normalized.startsWith('video/')
        || normalized.startsWith('audio/')
        || normalized === 'application/pdf';
}
function parseBase64(data) {
    const match = data.match(/^data:(.+);base64,(.+)$/);
    if (!match)
        return null;
    return {
        mime: match[1],
        buffer: Buffer.from(match[2], "base64")
    };
}
function parseBytesRange(rangeHeader, size) {
    if (!rangeHeader || !/^bytes=/i.test(rangeHeader))
        return null;
    const spec = rangeHeader.replace(/^bytes=/i, '').trim();
    const [startStr, endStr] = spec.split('-');
    let start;
    let end;
    if (startStr === '' && endStr !== '') {
        const suffixLen = parseInt(endStr, 10);
        if (!Number.isFinite(suffixLen) || suffixLen <= 0)
            return 'unsatisfiable';
        start = Math.max(0, size - suffixLen);
        end = size - 1;
    }
    else {
        start = parseInt(startStr, 10);
        end = endStr !== '' ? parseInt(endStr, 10) : size - 1;
        if (!Number.isFinite(start))
            return 'unsatisfiable';
        if (!Number.isFinite(end) || end >= size)
            end = size - 1;
    }
    if (start < 0 || start > end || start >= size)
        return 'unsatisfiable';
    return { start, end };
}
function sendBinaryWithRange(req, res, buffer, mimeType) {
    const size = buffer.length;
    const parsed = parseBytesRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
    res.setHeader('Accept-Ranges', 'bytes');
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
        res.end(buffer);
        return;
    }
    const { start, end } = parsed;
    const chunk = buffer.subarray(start, end + 1);
    res.status(206);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(chunk.length));
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.end(chunk);
}
function streamFileWithRange(req, res, filePath, mimeType, size) {
    const parsed = parseBytesRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
    res.setHeader('Accept-Ranges', 'bytes');
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
        (0, node_fs_1.createReadStream)(filePath).pipe(res).on('error', err => {
            (0, logger_1.logger)(safe_1.default.red(`getFragment stream error ${err.message}`));
        });
        return;
    }
    const { start, end } = parsed;
    res.status(206);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    (0, node_fs_1.createReadStream)(filePath, { start, end }).pipe(res).on('error', err => {
        (0, logger_1.logger)(safe_1.default.red(`getFragment range stream error ${err.message}`));
    });
}
async function writeBinarySidecar(hash, buffer, mime) {
    const paths = fragmentPaths(hash);
    await node_fs_1.default.promises.writeFile(paths.binary, buffer);
    await node_fs_1.default.promises.writeFile(paths.meta, JSON.stringify({ mime }));
}
//			getIpAddressFromForwardHeader(req.header(''))
const getIpAddressFromForwardHeader = (req) => {
    // logger(inspect(req.headers, false, 3, true))
    const ipaddress = req.headers['X-Real-IP'.toLowerCase()] || req.headers['X-Forwarded-For'.toLowerCase()] || req.headers['CF-Connecting-IP'.toLowerCase()] || req.ip;
    if (!ipaddress) {
        return '';
    }
    if (typeof ipaddress === 'object') {
        return ipaddress[0];
    }
    return ipaddress;
};
const saveFragment = (hash, data) => new Promise(resolve => {
    const fileName = `${storagePATH}/${hash}`;
    (0, logger_1.logger)(`saveFragment [${fileName}] data length = ${data.length}`);
    return (0, node_fs_2.writeFile)(fileName, data, err => {
        if (err) {
            (0, logger_1.logger)(safe_1.default.red(`saveFragment [${hash}] data length [${data.length}] Error! ${err.message}`));
            return resolve(false);
        }
        (0, logger_1.logger)(`saveFragment storage [${fileName}] data length = ${data.length} success!`);
        // Local store is primary; durable Kubo peers are background pin replicas.
        (0, kuboFragmentPin_1.scheduleFragmentKuboReplication)(hash, data);
        const parsed = parseBase64(data);
        if (!parsed || !isRangeStreamableMime(parsed.mime)) {
            return resolve(true);
        }
        return writeBinarySidecar(hash, parsed.buffer, parsed.mime)
            .then(() => {
            (0, logger_1.logger)(`saveFragment binary sidecar [${hash}] mime=${parsed.mime} bytes=${parsed.buffer.length}`);
            return resolve(true);
        })
            .catch(sidecarErr => {
            (0, logger_1.logger)(safe_1.default.yellow(`saveFragment binary sidecar [${hash}] failed: ${sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr)}`));
            return resolve(true);
        });
    });
});
const getFragment = async (req, hash, res) => {
    // Resolve `point-0x…` alias → current content hash before serving.
    if (isPointerHash(hash)) {
        if (!POINTER_RE.test(hash)) {
            res.status(404).end();
            return;
        }
        const alias = await readPointerAlias(hash);
        if (!alias?.hash) {
            (0, logger_1.logger)(safe_1.default.grey(`getFragment pointer [${hash}] not found`));
            res.status(404).end();
            return;
        }
        hash = alias.hash;
    }
    const paths = fragmentPaths(hash);
    (0, logger_1.logger)(`getFragment = ${hash} filename = ${paths.text}`);
    try {
        await node_fs_1.default.promises.access(paths.text);
    }
    catch {
        (0, logger_1.logger)(safe_1.default.red(`getFragment file [${paths.text}] does not exist!`));
        res.status(404).end();
        return;
    }
    try {
        const binStat = await node_fs_1.default.promises.stat(paths.binary);
        let mimeType = 'application/octet-stream';
        try {
            const metaRaw = await node_fs_1.default.promises.readFile(paths.meta, 'utf8');
            const meta = JSON.parse(metaRaw);
            if (meta.mime)
                mimeType = meta.mime;
        }
        catch {
            // optional sidecar metadata
        }
        streamFileWithRange(req, res, paths.binary, mimeType, binStat.size);
        return;
    }
    catch {
        // fall through to legacy text storage
    }
    const raw = await node_fs_1.default.promises.readFile(paths.text, 'utf8');
    if (raw) {
        const base64 = raw.match(/^data:(.+);base64,(.+)$/);
        if (base64) {
            const mimeType = base64[1];
            const buffer = Buffer.from(base64[2], 'base64');
            if (isRangeStreamableMime(mimeType)) {
                void writeBinarySidecar(hash, buffer, mimeType).catch(sidecarErr => {
                    (0, logger_1.logger)(safe_1.default.yellow(`getFragment lazy sidecar [${hash}] failed: ${sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr)}`));
                });
                sendBinaryWithRange(req, res, buffer, mimeType);
                return;
            }
            sendBinaryWithRange(req, res, buffer, mimeType);
            return;
        }
        if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
            res.status(200);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(raw);
            return;
        }
    }
    res.status(200);
    (0, node_fs_1.createReadStream)(paths.text).pipe(res).on('error', err => {
        (0, logger_1.logger)(safe_1.default.red(`getFragment on error ${err.message}`));
    });
};
class server {
    PORT = 8002;
    ipaddressWallet = new Map();
    WalletIpaddress = new Map();
    regiestNodes = new Map();
    nodeIpaddressWallets = new Map();
    constructor() {
        this.startServer();
    }
    startServer = async () => {
        const Cors = require('cors');
        const app = (0, express_1.default)();
        /** JSON body limit: image base64 ~4/3 of raw size; catalog video clips up to ~50MB raw → ~67MB base64. Match nginx 256m. */
        app.use(express_1.default.json({ limit: '256mb' }));
        app.use(express_1.default.urlencoded({ extended: true }));
        app.disable('x-powered-by');
        app.use(express_1.default.urlencoded({ extended: false }));
        const router = (0, express_1.Router)();
        app.use('/api', router);
        app.once('error', (err) => {
            /**
             * https://stackoverflow.com/questions/60372618/nodejs-listen-eacces-permission-denied-0-0-0-080
             * > sudo apt-get install libcap2-bin
             * > sudo setcap cap_net_bind_service=+ep `readlink -f \`which node\``
             *
             */
            (0, logger_1.logger)(err);
            (0, logger_1.logger)(safe_1.default.red(`Local server on ERROR`));
        });
        const server = (0, node_http_1.createServer)(app);
        this.router(router);
        app.all('/', (req, res) => {
            //logger (Colors.red(`get unknow router from ${ipaddress} => ${ req.method } [http://${ req.headers.host }${ req.url }] STOP connect! ${req.body, false, 3, true}`))
            res.status(406).end();
            return res.socket?.end().destroy();
        });
        server.listen(this.PORT, () => {
            return console.table([
                { 'Cluster': ` startup success ${this.PORT} Work [${workerNumber}]` }
            ]);
        });
    };
    router(router) {
        (0, catalogYoutubeStreamProxy_1.registerCatalogYoutubeStreamProxyRoute)(router);
        router.get('/storageFragmentChunkStatus', async (req, res) => {
            const { hash, wallet, signMessage } = req.query;
            const ipaddress = getIpAddressFromForwardHeader(req);
            if (!hash || !verifyFragmentWalletSign(wallet, signMessage)) {
                (0, logger_1.logger)(safe_1.default.grey(`Router /storageFragmentChunkStatus auth error ${ipaddress}`));
                return res.status(403).json({ ok: false, error: 'Unauthorized' });
            }
            if (await fragmentFinalExists(hash)) {
                const meta = await readFragmentUploadMeta(hash);
                return res.status(200).json({
                    ok: true,
                    complete: true,
                    received: meta?.totalSize ?? 0,
                    totalSize: meta?.totalSize ?? 0,
                });
            }
            const meta = await readFragmentUploadMeta(hash);
            const received = await getFragmentUploadReceivedBytes(hash);
            return res.status(200).json({
                ok: true,
                complete: false,
                received,
                totalSize: meta?.totalSize ?? null,
            });
        });
        const storageFragmentChunkMultipart = fragmentChunkMulter.single('chunk');
        router.post('/storageFragmentChunk', (req, res, next) => {
            const ct = (req.headers['content-type'] || '').toLowerCase();
            if (ct.includes('multipart/form-data')) {
                return storageFragmentChunkMultipart(req, res, next);
            }
            return next();
        }, async (req, res) => {
            const ipaddress = getIpAddressFromForwardHeader(req);
            let wallet;
            let signMessage;
            let hash;
            let totalSizeN;
            let offsetN;
            let chunk;
            if (req.file?.buffer) {
                wallet = req.body?.wallet;
                signMessage = req.body?.signMessage;
                hash = req.body?.hash;
                totalSizeN = Number(req.body?.totalSize);
                offsetN = Number(req.body?.offset);
                chunk = req.file.buffer;
            }
            else {
                const body = req.body;
                wallet = body.wallet;
                signMessage = body.signMessage;
                hash = body.hash;
                totalSizeN = Number(body.totalSize);
                offsetN = Number(body.offset);
                if (body.chunkBase64) {
                    try {
                        chunk = Buffer.from(String(body.chunkBase64), 'base64');
                    }
                    catch {
                        return res.status(400).json({ ok: false, error: 'Invalid chunkBase64' });
                    }
                }
            }
            if (!verifyFragmentWalletSign(wallet, signMessage) || !hash || !chunk) {
                (0, logger_1.logger)(safe_1.default.grey(`Router /storageFragmentChunk auth/format error ${ipaddress}`));
                return res.status(403).json({ ok: false, error: 'Unauthorized' });
            }
            if (!Number.isFinite(totalSizeN) || totalSizeN <= 0 || !Number.isFinite(offsetN) || offsetN < 0) {
                return res.status(400).json({ ok: false, error: 'Invalid totalSize or offset' });
            }
            if (chunk.length === 0 || chunk.length > exports.FRAGMENT_UPLOAD_CHUNK_BYTES) {
                return res.status(400).json({ ok: false, error: 'Invalid chunk size' });
            }
            try {
                const result = await writeFragmentUploadChunk({
                    hash,
                    wallet: String(wallet),
                    totalSize: totalSizeN,
                    offset: offsetN,
                    chunk,
                });
                return res.status(200).json({ ok: true, ...result });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                (0, logger_1.logger)(safe_1.default.red(`storageFragmentChunk [${hash}] ${message}`));
                return res.status(400).json({ ok: false, error: message });
            }
        });
        router.post('/storageFragment', async (req, res) => {
            const { wallet, signMessage, image, pointer, pointerOwner, pointerTs, pointerSig } = req.body;
            const ipaddress = getIpAddressFromForwardHeader(req);
            if (!wallet || !signMessage) {
                (0, logger_1.logger)(safe_1.default.grey(`Router /storageFragments !wallet || !signMessage Error! ${ipaddress}`));
                return res.status(403).end();
            }
            const obj = (0, util_1.checkSign)(wallet, signMessage, wallet);
            if (!obj || !image) {
                (0, logger_1.logger)(safe_1.default.grey(`Router /storageFragments !obj Format Error Error! ${ipaddress} checkSign Error!`));
                return res.status(403).end();
            }
            // const kk = await searchUser(obj)
            // if (!kk?.results) {
            // 	logger (Colors.grey(`Router /storageFragments !obj Format Error Error! ${ipaddress} has not Beamioer!`))
            // 	return res.status(403).end()
            // }
            const hash = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(image));
            const SC = db_1.beamio_ContractPool[0];
            const result = await saveFragment(hash, image);
            // Optional deterministic pointer alias (encrypted-history index locator).
            if (pointer) {
                const aliasResult = await applyPointerAlias({
                    pointer,
                    owner: pointerOwner,
                    ts: pointerTs,
                    sig: pointerSig,
                    contentHash: hash,
                });
                if (!aliasResult.ok) {
                    (0, logger_1.logger)(safe_1.default.grey(`Router /storageFragment pointer error ${aliasResult.error} ${ipaddress}`));
                    return res.status(403).json({ ok: false, error: aliasResult.error, hash });
                }
                return res.status(200).json({ ok: true, hash, pointer });
            }
            return res.status(200).json({ ok: true, hash });
        });
        /**
         * Resolve a deterministic pointer alias to its current content hash without
         * downloading the fragment body (fast index-locate for encrypted history).
         */
        router.get('/resolvePointer', async (req, res) => {
            const { pointer } = req.query;
            if (!pointer || !POINTER_RE.test(pointer)) {
                return res.status(400).json({ ok: false, error: 'Invalid pointer' });
            }
            const alias = await readPointerAlias(pointer);
            if (!alias?.hash) {
                return res.status(404).json({ ok: false });
            }
            return res.status(200).json({ ok: true, hash: alias.hash, owner: alias.owner, ts: alias.ts });
        });
        router.get('/getFragment', async (req, res) => {
            const { hash } = req.query;
            if (!hash) {
                return res.status(404).end();
            }
            return getFragment(req, hash, res);
        });
    }
}
exports.default = server;
//	curl -v https://ipfs.conet.network/api/getFragment/free_wallets_53152
//	curl -v https://ipfs.conet.network/api/getFragment/53408_free
