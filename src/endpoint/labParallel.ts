/**
 * Bounded parallel reads for the Lab daemon (B2). The scan and the flush re-check used to await one chain or beacon read after
 * another; the reads are independent, so they now run with a small concurrency while every decision is still applied in the
 * original order (so state changes, counters and the first error are exactly those of the sequential code).
 */

export const READ_CONCURRENCY_DEFAULT = 8
export const READ_CONCURRENCY_MAX = 32

export function resolveReadConcurrency(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number(env.CONET_LAB_MINING_POOL_CL_PAYOUT_READ_CONCURRENCY || READ_CONCURRENCY_DEFAULT)
	return Number.isFinite(n) && n >= 1 ? Math.min(READ_CONCURRENCY_MAX, Math.floor(n)) : READ_CONCURRENCY_DEFAULT
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** Never rejects: a failed read becomes { ok: false, error } so the caller decides at the item's turn. */
export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
	return p.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error })
	)
}

/** Results in input order; at most `limit` calls of fn in flight; fn must not throw (wrap reads with settle). */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length)
	let next = 0
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const i = next++
			if (i >= items.length) return
			out[i] = await fn(items[i]!, i)
		}
	})
	await Promise.all(workers)
	return out
}
