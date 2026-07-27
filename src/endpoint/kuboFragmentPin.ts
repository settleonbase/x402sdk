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
import { logger } from '../logger'
import Colors from 'colors/safe'
import { masterSetup } from '../util'

export type KuboPinPeer = {
	url: string
}

export type KuboPinConfig = {
	token?: string
	peers?: KuboPinPeer[]
	/** Per-peer HTTP timeout ms (default 120s). */
	timeoutMs?: number
}

export function getKuboPinConfig(): KuboPinConfig {
	const raw = (masterSetup as { kuboPin?: KuboPinConfig }).kuboPin
	if (!raw || typeof raw !== 'object') return {}
	return raw
}

export type KuboPinPeerResult = {
	url: string
	ok: boolean
	cid?: string
	error?: string
	deduped?: boolean
}

/**
 * Fire-and-forget safe: callers should not await for HTTP response path.
 * Returns settled results when awaited (for scripts / smoke).
 */
export async function replicateFragmentToKuboPeers(
	hash: string,
	data: string,
): Promise<KuboPinPeerResult[]> {
	const cfg = getKuboPinConfig()
	const token = String(cfg.token || '').trim()
	const peers = Array.isArray(cfg.peers) ? cfg.peers : []
	if (!token || peers.length === 0) {
		return []
	}

	const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 120_000
	const normalizedHash = String(hash || '').trim().toLowerCase()

	const jobs = peers.map(async (peer): Promise<KuboPinPeerResult> => {
		const base = String(peer?.url || '').replace(/\/+$/, '')
		if (!base) {
			return { url: String(peer?.url || ''), ok: false, error: 'empty peer url' }
		}
		const url = `${base}/api/pinFragment`
		try {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), timeoutMs)
			try {
				const res = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-CoNET-IPFS-Token': token,
					},
					body: JSON.stringify({ hash: normalizedHash, data }),
					signal: controller.signal,
				})
				const text = await res.text()
				let parsed: { ok?: boolean; cid?: string; error?: string; deduped?: boolean } = {}
				try {
					parsed = JSON.parse(text) as typeof parsed
				} catch {
					parsed = {}
				}
				if (!res.ok || !parsed.ok) {
					const err = parsed.error || text || `HTTP ${res.status}`
					logger(Colors.yellow(`[kuboPin] fail ${url} hash=${normalizedHash} ${err}`))
					return { url: base, ok: false, error: err }
				}
				logger(
					Colors.green(
						`[kuboPin] ok ${url} hash=${normalizedHash} cid=${parsed.cid || ''} deduped=${Boolean(parsed.deduped)}`,
					),
				)
				return {
					url: base,
					ok: true,
					cid: parsed.cid,
					deduped: Boolean(parsed.deduped),
				}
			} finally {
				clearTimeout(timer)
			}
		} catch (e) {
			const err = e instanceof Error ? e.message : String(e)
			logger(Colors.yellow(`[kuboPin] error ${url} hash=${normalizedHash} ${err}`))
			return { url: base, ok: false, error: err }
		}
	})

	return Promise.all(jobs)
}

/** Non-blocking schedule after local fragment save. */
export function scheduleFragmentKuboReplication(hash: string, data: string): void {
	void replicateFragmentToKuboPeers(hash, data).catch(err => {
		logger(
			Colors.yellow(
				`[kuboPin] schedule error hash=${hash} ${err instanceof Error ? err.message : String(err)}`,
			),
		)
	})
}
