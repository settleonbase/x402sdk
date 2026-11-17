/** Token bucket per minute plus a hard per-UTC-day counter. Keyed by client/array. */
export class RateLimiter {
	private buckets = new Map<string, { tokens: number; at: number }>()
	private daily = new Map<string, { day: string; n: number }>()

	take(key: string, perMinute?: number, perDay?: number, now = Date.now()): boolean {
		if (perMinute !== undefined && perMinute > 0) {
			const b = this.buckets.get(key) ?? { tokens: perMinute, at: now }
			b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute)
			b.at = now
			if (b.tokens < 1) {
				this.buckets.set(key, b)
				return false
			}
			b.tokens -= 1
			this.buckets.set(key, b)
		}
		if (perDay !== undefined && perDay > 0) {
			const day = new Date(now).toISOString().slice(0, 10)
			const d = this.daily.get(key)
			const cur = d && d.day === day ? d : { day, n: 0 }
			if (cur.n >= perDay) return false
			cur.n += 1
			this.daily.set(key, cur)
		}
		return true
	}
}
