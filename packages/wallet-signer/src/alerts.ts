export type AlertLevel = 'info' | 'warn' | 'critical'

export interface Alerter {
	send(level: AlertLevel, code: string, message: string): void
}

/**
 * Alerts go to stderr (journald). If `webhookUrl` is set, each alert is also POSTed as JSON
 * `{level, code, message, host, ts}`. The channel itself (Telegram bot, mail relay, ...) is the
 * open decision D8; anything that accepts a JSON POST can sit behind the URL.
 * Same code is sent at most once per `dedupeMs`.
 */
export class DefaultAlerter implements Alerter {
	private last = new Map<string, number>()

	constructor(
		private readonly opts: { webhookUrl?: string; host?: string; dedupeMs?: number } = {},
	) {}

	send(level: AlertLevel, code: string, message: string): void {
		const now = Date.now()
		const prev = this.last.get(code)
		if (prev !== undefined && now - prev < (this.opts.dedupeMs ?? 600_000)) return
		this.last.set(code, now)
		process.stderr.write(`[alert] ${level} ${code} ${message}\n`)
		if (!this.opts.webhookUrl) return
		const body = JSON.stringify({ level, code, message, host: this.opts.host ?? 'wallet-signer', ts: new Date(now).toISOString() })
		void fetch(this.opts.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch((e: unknown) => {
			process.stderr.write(`[alert] webhook failed: ${e instanceof Error ? e.message : String(e)}\n`)
		})
	}
}
