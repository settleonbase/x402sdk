"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getKuboPinConfig = getKuboPinConfig;
exports.replicateFragmentToKuboPeers = replicateFragmentToKuboPeers;
exports.scheduleFragmentKuboReplication = scheduleFragmentKuboReplication;
/**
 * Replicate Beamio fragment payloads to durable Kubo pin peers.
 * Local fragment storage remains the primary read path; Kubo peers are long-term pin replicas.
 *
 * Config in ~/.master.json:
 * {
 *   "kuboPin": {
 *     "token": "<shared secret>",
 *     "peers": [
 *       { "url": "http://38.102.85.33:9545" },
 *       { "url": "http://207.90.192.71:9545" }
 *     ]
 *   }
 * }
 */
const logger_1 = require("../logger");
const safe_1 = __importDefault(require("colors/safe"));
const util_1 = require("../util");
function getKuboPinConfig() {
    const raw = util_1.masterSetup.kuboPin;
    if (!raw || typeof raw !== 'object')
        return {};
    return raw;
}
/**
 * Fire-and-forget safe: callers should not await for HTTP response path.
 * Returns settled results when awaited (for scripts / smoke).
 */
async function replicateFragmentToKuboPeers(hash, data) {
    const cfg = getKuboPinConfig();
    const token = String(cfg.token || '').trim();
    const peers = Array.isArray(cfg.peers) ? cfg.peers : [];
    if (!token || peers.length === 0) {
        return [];
    }
    const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 120_000;
    const normalizedHash = String(hash || '').trim().toLowerCase();
    const jobs = peers.map(async (peer) => {
        const base = String(peer?.url || '').replace(/\/+$/, '');
        if (!base) {
            return { url: String(peer?.url || ''), ok: false, error: 'empty peer url' };
        }
        const url = `${base}/api/pinFragment`;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CoNET-IPFS-Token': token,
                    },
                    body: JSON.stringify({ hash: normalizedHash, data }),
                    signal: controller.signal,
                });
                const text = await res.text();
                let parsed = {};
                try {
                    parsed = JSON.parse(text);
                }
                catch {
                    parsed = {};
                }
                if (!res.ok || !parsed.ok) {
                    const err = parsed.error || text || `HTTP ${res.status}`;
                    (0, logger_1.logger)(safe_1.default.yellow(`[kuboPin] fail ${url} hash=${normalizedHash} ${err}`));
                    return { url: base, ok: false, error: err };
                }
                (0, logger_1.logger)(safe_1.default.green(`[kuboPin] ok ${url} hash=${normalizedHash} cid=${parsed.cid || ''} deduped=${Boolean(parsed.deduped)}`));
                return {
                    url: base,
                    ok: true,
                    cid: parsed.cid,
                    deduped: Boolean(parsed.deduped),
                };
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            (0, logger_1.logger)(safe_1.default.yellow(`[kuboPin] error ${url} hash=${normalizedHash} ${err}`));
            return { url: base, ok: false, error: err };
        }
    });
    return Promise.all(jobs);
}
/** Non-blocking schedule after local fragment save. */
function scheduleFragmentKuboReplication(hash, data) {
    void replicateFragmentToKuboPeers(hash, data).catch(err => {
        (0, logger_1.logger)(safe_1.default.yellow(`[kuboPin] schedule error hash=${hash} ${err instanceof Error ? err.message : String(err)}`));
    });
}
