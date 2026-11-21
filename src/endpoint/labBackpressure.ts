/**
 * Pending-pool back-pressure (memory bound). The pending pool costs about 500 B per entry on the heap and also grows every
 * state generation written to disk, so it must have a ceiling. Two levels, with hysteresis:
 *   history line paused at >= HIGH_WATER_HISTORY, realtime line paused at >= HIGH_WATER_ALL (>= the history level).
 * Pausing only postpones scanning. Cursors only move forward and are persisted, so nothing is lost or skipped.
 */
export const PENDING_HIGH_WATER_HISTORY_DEFAULT = 1_800_000
export const PENDING_HIGH_WATER_ALL_DEFAULT = 2_000_000
export const PENDING_HIGH_WATER_MIN = 10_000
export const PENDING_HIGH_WATER_MAX = 50_000_000
/** Resume once the pool is below this share of the level (avoids flapping around the threshold). */
export const BACKPRESSURE_RESUME_RATIO = 0.95

function parseLevel(raw: string | undefined, fallback: number): number {
	const n = Number(raw || fallback)
	if (!Number.isFinite(n) || n < PENDING_HIGH_WATER_MIN) return fallback
	return Math.min(PENDING_HIGH_WATER_MAX, Math.floor(n))
}

export function resolvePendingHighWater(env: NodeJS.ProcessEnv = process.env): { history: number; all: number } {
	const history = parseLevel(env.CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_HISTORY, PENDING_HIGH_WATER_HISTORY_DEFAULT)
	const all = Math.max(history, parseLevel(env.CONET_LAB_MINING_POOL_CL_PAYOUT_PENDING_HIGH_WATER_ALL, PENDING_HIGH_WATER_ALL_DEFAULT))
	return { history, all }
}

/** true while the line must not scan. Pause at >= high, resume below high * BACKPRESSURE_RESUME_RATIO. */
export function nextPaused(wasPaused: boolean, pendingSize: number, high: number): boolean {
	if (wasPaused) return pendingSize >= Math.floor(high * BACKPRESSURE_RESUME_RATIO)
	return pendingSize >= high
}

/** Both lines at once. The realtime level is the higher one; a paused realtime line always pauses history too. */
export function decideLinePauses(
	prev: { history: boolean; realtime: boolean },
	pendingSize: number,
	high: { history: number; all: number }
): { history: boolean; realtime: boolean } {
	const realtime = nextPaused(prev.realtime, pendingSize, high.all)
	const history = nextPaused(prev.history, pendingSize, high.history) || realtime
	return { history, realtime }
}
