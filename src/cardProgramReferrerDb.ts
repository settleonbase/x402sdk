import { ethers } from 'ethers'
import { Client } from 'pg'
import Colors from 'colors/safe'
import { logger } from './logger'

const DB_URL = 'postgres://postgres:your_password@127.0.0.1:5432/postgres'

const BEAMIO_CARD_PROGRAM_REFEREES_TABLE = `
CREATE TABLE IF NOT EXISTS beamio_card_program_referees (
	id BIGSERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	referee_aa TEXT NOT NULL,
	referrer_aa TEXT,
	registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	last_tx_hash TEXT,
	UNIQUE (card_address, referee_aa)
);
`

const BEAMIO_CARD_PROGRAM_REFEREES_REFERRER_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_referees_card_referrer
ON beamio_card_program_referees (card_address, referrer_aa);
`

const BEAMIO_CARD_PROGRAM_REFEREES_UPDATED_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_referees_card_updated
ON beamio_card_program_referees (card_address, updated_at DESC);
`

async function ensureCardProgramReferrerSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_CARD_PROGRAM_REFEREES_TABLE)
	await db.query(BEAMIO_CARD_PROGRAM_REFEREES_REFERRER_IDX)
	await db.query(BEAMIO_CARD_PROGRAM_REFEREES_UPDATED_IDX)
}

export type CardProgramReferrerRow = {
	refereeAa: string
	referrerAa: string | null
	registeredAt: string
	updatedAt: string
	txHash: string | null
}

export type CardProgramReferrerReferrerRow = {
	referrerAa: string
	refereeCount: number
}

export type CardProgramReferrerPage<T> = { items: T[]; total: number }

function normalizeAa(raw: string | undefined | null): string | null {
	if (raw == null || String(raw).trim() === '') return null
	const s = String(raw).trim()
	if (!ethers.isAddress(s)) return null
	return ethers.getAddress(s).toLowerCase()
}

function normalizeTxHash(raw: string | undefined | null): string | null {
	if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.trim())) return null
	return raw.trim().toLowerCase()
}

/** Master：RefereeRegistered 成功后 upsert（不做历史回填）。 */
export const upsertCardProgramRefereeRegistered = async (params: {
	cardAddress: string
	refereeAA: string
	txHash?: string | null
}): Promise<void> => {
	const referee = normalizeAa(params.refereeAA)
	if (!referee) return
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureCardProgramReferrerSchema(db)
		const card = ethers.getAddress(params.cardAddress).toLowerCase()
		const txHash = normalizeTxHash(params.txHash ?? null)
		await db.query(
			`
			INSERT INTO beamio_card_program_referees (card_address, referee_aa, referrer_aa, last_tx_hash)
			VALUES ($1, $2, NULL, $3)
			ON CONFLICT (card_address, referee_aa)
			DO UPDATE SET updated_at = NOW(),
			              last_tx_hash = COALESCE(EXCLUDED.last_tx_hash, beamio_card_program_referees.last_tx_hash)
			`,
			[card, referee, txHash],
		)
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[upsertCardProgramRefereeRegistered] failed: ${err?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** Master：RefereeUnregistered 成功后删除 DB 行。 */
export const removeCardProgramReferee = async (params: {
	cardAddress: string
	refereeAA: string
}): Promise<void> => {
	const referee = normalizeAa(params.refereeAA)
	if (!referee) return
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureCardProgramReferrerSchema(db)
		const card = ethers.getAddress(params.cardAddress).toLowerCase()
		await db.query(
			`DELETE FROM beamio_card_program_referees WHERE card_address = $1 AND referee_aa = $2`,
			[card, referee],
		)
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[removeCardProgramReferee] failed: ${err?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/** Master：RefereeReferrerUpdated 成功后更新 uplink referrer（referrerAA=0 表示 clear）。 */
export const updateCardProgramRefereeReferrer = async (params: {
	cardAddress: string
	refereeAA: string
	referrerAA: string | null
	txHash?: string | null
}): Promise<void> => {
	const referee = normalizeAa(params.refereeAA)
	if (!referee) return
	const referrerRaw = params.referrerAA
	const referrer =
		referrerRaw == null ||
		String(referrerRaw).trim() === '' ||
		String(referrerRaw).toLowerCase() === ethers.ZeroAddress.toLowerCase()
			? null
			: normalizeAa(referrerRaw)
	if (referrerRaw && referrerRaw !== ethers.ZeroAddress && !referrer) return
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureCardProgramReferrerSchema(db)
		const card = ethers.getAddress(params.cardAddress).toLowerCase()
		const txHash = normalizeTxHash(params.txHash ?? null)
		await db.query(
			`
			INSERT INTO beamio_card_program_referees (card_address, referee_aa, referrer_aa, last_tx_hash)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (card_address, referee_aa)
			DO UPDATE SET referrer_aa = EXCLUDED.referrer_aa,
			              updated_at = NOW(),
			              last_tx_hash = COALESCE(EXCLUDED.last_tx_hash, beamio_card_program_referees.last_tx_hash)
			`,
			[card, referee, referrer, txHash],
		)
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[updateCardProgramRefereeReferrer] failed: ${err?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

export const listCardProgramRegisteredReferees = async (
	cardAddress: string,
	opts?: { limit?: number; offset?: number },
): Promise<CardProgramReferrerPage<CardProgramReferrerRow>> => {
	const db = new Client({ connectionString: DB_URL })
	const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000)
	const offset = Math.max(Number(opts?.offset) || 0, 0)
	try {
		await db.connect()
		await ensureCardProgramReferrerSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const countRes = await db.query<{ c: string }>(
			`SELECT COUNT(*)::text AS c FROM beamio_card_program_referees WHERE card_address = $1`,
			[card],
		)
		const total = Number(countRes.rows[0]?.c ?? 0) || 0
		const { rows } = await db.query<{
			referee_aa: string
			referrer_aa: string | null
			registered_at: Date
			updated_at: Date
			last_tx_hash: string | null
		}>(
			`
			SELECT referee_aa, referrer_aa, registered_at, updated_at, last_tx_hash
			FROM beamio_card_program_referees
			WHERE card_address = $1
			ORDER BY registered_at ASC, id ASC
			LIMIT $2 OFFSET $3
			`,
			[card, limit, offset],
		)
		return {
			items: rows.map((r) => ({
				refereeAa: ethers.getAddress(r.referee_aa),
				referrerAa: r.referrer_aa ? ethers.getAddress(r.referrer_aa) : null,
				registeredAt: r.registered_at instanceof Date ? r.registered_at.toISOString() : String(r.registered_at),
				updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
				txHash: r.last_tx_hash,
			})),
			total,
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[listCardProgramRegisteredReferees] failed: ${err?.message ?? e}`))
		return { items: [], total: 0 }
	} finally {
		await db.end().catch(() => {})
	}
}

export const listCardProgramReferees = async (
	cardAddress: string,
	opts?: { limit?: number; offset?: number },
): Promise<CardProgramReferrerPage<CardProgramReferrerReferrerRow>> => {
	const db = new Client({ connectionString: DB_URL })
	const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000)
	const offset = Math.max(Number(opts?.offset) || 0, 0)
	try {
		await db.connect()
		await ensureCardProgramReferrerSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const countRes = await db.query<{ c: string }>(
			`
			SELECT COUNT(DISTINCT referrer_aa)::text AS c
			FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa IS NOT NULL
			`,
			[card],
		)
		const total = Number(countRes.rows[0]?.c ?? 0) || 0
		const { rows } = await db.query<{ referrer_aa: string; referee_count: string }>(
			`
			SELECT referrer_aa, COUNT(*)::text AS referee_count
			FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa IS NOT NULL
			GROUP BY referrer_aa
			ORDER BY MIN(registered_at) ASC, referrer_aa ASC
			LIMIT $2 OFFSET $3
			`,
			[card, limit, offset],
		)
		return {
			items: rows.map((r) => ({
				referrerAa: ethers.getAddress(r.referrer_aa),
				refereeCount: Number(r.referee_count) || 0,
			})),
			total,
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[listCardProgramReferees] failed: ${err?.message ?? e}`))
		return { items: [], total: 0 }
	} finally {
		await db.end().catch(() => {})
	}
}

const CARD_REFEREE_EVENTS_IFACE = new ethers.Interface([
	'event RefereeRegistered(address indexed refereeAA, address indexed operator)',
	'event RefereeUnregistered(address indexed refereeAA, address indexed operator)',
	'event RefereeReferrerUpdated(address indexed refereeAA, address indexed referrerAA, address indexed operator)',
])

/** Master：从 card receipt 解析 Referee* 事件并写入 DB（启用后记录，不做历史回填）。 */
export const syncCardProgramReferrerEventsFromReceipt = async (params: {
	cardAddress: string
	receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> }
	txHash?: string | null
}): Promise<void> => {
	const cardLower = ethers.getAddress(params.cardAddress).toLowerCase()
	const txHash = normalizeTxHash(params.txHash ?? null)
	for (const log of params.receipt.logs) {
		if (log.address.toLowerCase() !== cardLower) continue
		let parsed: ethers.LogDescription | null = null
		try {
			parsed = CARD_REFEREE_EVENTS_IFACE.parseLog({
				topics: [...log.topics],
				data: log.data,
			})
		} catch {
			continue
		}
		if (!parsed) continue
		if (parsed.name === 'RefereeRegistered') {
			await upsertCardProgramRefereeRegistered({
				cardAddress: params.cardAddress,
				refereeAA: parsed.args.refereeAA as string,
				txHash,
			})
		} else if (parsed.name === 'RefereeUnregistered') {
			await removeCardProgramReferee({
				cardAddress: params.cardAddress,
				refereeAA: parsed.args.refereeAA as string,
			})
		} else if (parsed.name === 'RefereeReferrerUpdated') {
			await updateCardProgramRefereeReferrer({
				cardAddress: params.cardAddress,
				refereeAA: parsed.args.refereeAA as string,
				referrerAA: parsed.args.referrerAA as string,
				txHash,
			})
		}
	}
}

export const listCardProgramRefereesByReferrer = async (
	cardAddress: string,
	referrerAA: string,
	opts?: { limit?: number; offset?: number },
): Promise<CardProgramReferrerPage<CardProgramReferrerRow>> => {
	const referrer = normalizeAa(referrerAA)
	if (!referrer) return { items: [], total: 0 }
	const db = new Client({ connectionString: DB_URL })
	const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000)
	const offset = Math.max(Number(opts?.offset) || 0, 0)
	try {
		await db.connect()
		await ensureCardProgramReferrerSchema(db)
		const card = ethers.getAddress(cardAddress).toLowerCase()
		const countRes = await db.query<{ c: string }>(
			`
			SELECT COUNT(*)::text AS c FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa = $2
			`,
			[card, referrer],
		)
		const total = Number(countRes.rows[0]?.c ?? 0) || 0
		const { rows } = await db.query<{
			referee_aa: string
			referrer_aa: string | null
			registered_at: Date
			updated_at: Date
			last_tx_hash: string | null
		}>(
			`
			SELECT referee_aa, referrer_aa, registered_at, updated_at, last_tx_hash
			FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa = $2
			ORDER BY registered_at ASC, id ASC
			LIMIT $3 OFFSET $4
			`,
			[card, referrer, limit, offset],
		)
		return {
			items: rows.map((r) => ({
				refereeAa: ethers.getAddress(r.referee_aa),
				referrerAa: r.referrer_aa ? ethers.getAddress(r.referrer_aa) : null,
				registeredAt: r.registered_at instanceof Date ? r.registered_at.toISOString() : String(r.registered_at),
				updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
				txHash: r.last_tx_hash,
			})),
			total,
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[listCardProgramRefereesByReferrer] failed: ${err?.message ?? e}`))
		return { items: [], total: 0 }
	} finally {
		await db.end().catch(() => {})
	}
}
