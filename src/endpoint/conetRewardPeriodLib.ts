/**
 * Period bucket math aligned with ValidatorNodeRewardIndexer / AdminStatsPeriodLib.
 * Hour = UTC hour since epoch; week = Monday-start; month/year = calendar UTC.
 */

export const REWARD_PERIOD_HOUR = 0
export const REWARD_PERIOD_DAY = 1
export const REWARD_PERIOD_WEEK = 2
export const REWARD_PERIOD_MONTH = 3
export const REWARD_PERIOD_YEAR = 5

const SECONDS_PER_DAY = 86_400
const SECONDS_PER_HOUR = 3_600

export type PeriodBucketMaps = {
	hourly: Map<number, bigint>
	day: Map<number, bigint>
	week: Map<number, bigint>
	month: Map<number, bigint>
	year: Map<number, bigint>
}

export type PeriodTotals = {
	hour: bigint
	day: bigint
	week: bigint
	month: bigint
	year: bigint
}

export function createEmptyPeriodBucketMaps(): PeriodBucketMaps {
	return {
		hourly: new Map(),
		day: new Map(),
		week: new Map(),
		month: new Map(),
		year: new Map(),
	}
}

/** Unix seconds from Blockscout ISO timestamp (e.g. 2026-08-01T19:19:37.000000Z). */
export function parseBlockscoutTimestampSec(iso: unknown): number | null {
	const raw = String(iso ?? '').trim()
	if (!raw) return null
	const ms = Date.parse(raw)
	if (!Number.isFinite(ms)) return null
	return Math.floor(ms / 1000)
}

/** Days since Unix epoch (UTC), matching Solidity `ts / 1 days`. */
export function daysSinceEpoch(tsSec: number): number {
	return Math.floor(tsSec / SECONDS_PER_DAY)
}

/** Port of ValidatorNodeRewardIndexer `_daysToDate` (Gregorian, UTC). */
export function daysToDate(daysSinceEpochVal: number): { year: number; month: number; day: number } {
	let z = daysSinceEpochVal + 719_468
	const era = Math.floor(z / 146_097)
	const doe = z - era * 146_097
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
	let y = yoe + era * 400
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
	const mp = Math.floor((5 * doy + 2) / 153)
	const d = doy - Math.floor((153 * mp + 2) / 5) + 1
	const m = mp < 10 ? mp + 3 : mp - 9
	if (m <= 2) y += 1
	return { year: y, month: m, day: d }
}

export function periodIdsFromTimestamp(tsSec: number): {
	hourId: number
	dayId: number
	weekId: number
	monthId: number
	yearId: number
} {
	const hourId = Math.floor(tsSec / SECONDS_PER_HOUR)
	const dayId = daysSinceEpoch(tsSec)
	const weekId = Math.floor((dayId + 3) / 7)
	const { year, month } = daysToDate(dayId)
	const monthId = year * 12 + (month - 1)
	return { hourId, dayId, weekId, monthId, yearId: year }
}

/** Mirror `_accumulatePeriodBuckets`: use hour-aligned ts (`hourId * 3600`). */
export function accumulatePeriodBucketMaps(maps: PeriodBucketMaps, tsSec: number, amount: bigint): void {
	if (amount <= 0n) return
	const hourId = Math.floor(tsSec / SECONDS_PER_HOUR)
	const hourAlignedTs = hourId * SECONDS_PER_HOUR
	const ids = periodIdsFromTimestamp(hourAlignedTs)
	maps.hourly.set(hourId, (maps.hourly.get(hourId) ?? 0n) + amount)
	maps.day.set(ids.dayId, (maps.day.get(ids.dayId) ?? 0n) + amount)
	maps.week.set(ids.weekId, (maps.week.get(ids.weekId) ?? 0n) + amount)
	maps.month.set(ids.monthId, (maps.month.get(ids.monthId) ?? 0n) + amount)
	maps.year.set(ids.yearId, (maps.year.get(ids.yearId) ?? 0n) + amount)
}

/** O(1) read of current period buckets containing anchorTs (0 = now). */
export function readCurrentPeriodTotals(maps: PeriodBucketMaps, anchorTsSec = 0): PeriodTotals {
	const anchor = anchorTsSec > 0 ? anchorTsSec : Math.floor(Date.now() / 1000)
	const ids = periodIdsFromTimestamp(anchor)
	return {
		hour: maps.hourly.get(ids.hourId) ?? 0n,
		day: maps.day.get(ids.dayId) ?? 0n,
		week: maps.week.get(ids.weekId) ?? 0n,
		month: maps.month.get(ids.monthId) ?? 0n,
		year: maps.year.get(ids.yearId) ?? 0n,
	}
}

export function sumPeriodBucketMaps(maps: PeriodBucketMaps): bigint {
	let total = 0n
	for (const v of maps.hourly.values()) total += v
	return total
}
