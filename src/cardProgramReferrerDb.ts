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

/** kind: 1=topup, 2=charge — mirrors ReferrerRefereeRewardLedgered. */
const BEAMIO_CARD_PROGRAM_REFERRER_REWARDS_TABLE = `
CREATE TABLE IF NOT EXISTS beamio_card_program_referrer_rewards (
	id BIGSERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	referrer_aa TEXT NOT NULL,
	referee_aa TEXT NOT NULL,
	kind SMALLINT NOT NULL,
	reward13_e6 NUMERIC(78,0) NOT NULL DEFAULT 0,
	amount_fiat6 NUMERIC(78,0) NOT NULL DEFAULT 0,
	last_tx_hash TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE (card_address, referrer_aa, referee_aa, kind)
);
`

const BEAMIO_CARD_PROGRAM_REFERRER_REWARDS_REFERRER_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_referrer_rewards_card_referrer
ON beamio_card_program_referrer_rewards (card_address, referrer_aa, kind);
`

async function ensureCardProgramReferrerSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_CARD_PROGRAM_REFEREES_TABLE)
	await db.query(BEAMIO_CARD_PROGRAM_REFEREES_REFERRER_IDX)
	await db.query(BEAMIO_CARD_PROGRAM_REFEREES_UPDATED_IDX)
	await db.query(BEAMIO_CARD_PROGRAM_REFERRER_REWARDS_TABLE)
	await db.query(BEAMIO_CARD_PROGRAM_REFERRER_REWARDS_REFERRER_IDX)
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

/** DB mirror totals for summary KPI when chain count views revert. */
export const readCardProgramReferrerDbSummary = async (
	cardAddress: string,
): Promise<{ dbReferrerTotal: number; dbRegisteredRefereeTotal: number }> => {
	const [referrers, registered] = await Promise.all([
		listCardProgramReferees(cardAddress, { limit: 1, offset: 0 }),
		listCardProgramRegisteredReferees(cardAddress, { limit: 1, offset: 0 }),
	])
	return {
		dbReferrerTotal: referrers.total,
		dbRegisteredRefereeTotal: registered.total,
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
	/** Discover share bind (AdminStats V4+). Storage keys are EOAs; AA only in event payload. */
	'event ShareRefereeBoundWithSignature(address indexed downlineEOA, address indexed refereeEOA, address downlineAA, address refereeAA, bytes32 nonce)',
	/** kind 1=topup, 2=charge — #13 mint ledger for referrer UI. */
	'event ReferrerRefereeRewardLedgered(address indexed referrer, address indexed referee, uint8 kind, uint256 amountFiat6, uint256 reward13E6)',
])

/** Upsert cumulative #13 reward from ReferrerRefereeRewardLedgered (additive per event). */
export const upsertCardProgramReferrerRewardLedger = async (params: {
	cardAddress: string
	referrerAA: string
	refereeAA: string
	kind: number
	amountFiat6: bigint | string
	reward13E6: bigint | string
	txHash?: string | null
}): Promise<void> => {
	const referrer = normalizeAa(params.referrerAA)
	const referee = normalizeAa(params.refereeAA)
	const kind = Number(params.kind)
	if (!referrer || !referee || (kind !== 1 && kind !== 2)) return
	const amountFiat6 = BigInt(params.amountFiat6).toString()
	const reward13E6 = BigInt(params.reward13E6).toString()
	if (BigInt(reward13E6) <= 0n) return
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureCardProgramReferrerSchema(db)
		const card = ethers.getAddress(params.cardAddress).toLowerCase()
		const txHash = normalizeTxHash(params.txHash ?? null)
		await db.query(
			`
			INSERT INTO beamio_card_program_referrer_rewards
				(card_address, referrer_aa, referee_aa, kind, reward13_e6, amount_fiat6, last_tx_hash)
			VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7)
			ON CONFLICT (card_address, referrer_aa, referee_aa, kind)
			DO UPDATE SET
				reward13_e6 = beamio_card_program_referrer_rewards.reward13_e6 + EXCLUDED.reward13_e6,
				amount_fiat6 = beamio_card_program_referrer_rewards.amount_fiat6 + EXCLUDED.amount_fiat6,
				updated_at = NOW(),
				last_tx_hash = COALESCE(EXCLUDED.last_tx_hash, beamio_card_program_referrer_rewards.last_tx_hash)
			`,
			[card, referrer, referee, kind, reward13E6, amountFiat6, txHash],
		)
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[upsertCardProgramReferrerRewardLedger] failed: ${err?.message ?? e}`))
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * Share bind: opener (downlineEOA) becomes referee of share-owner (refereeEOA).
 * DB columns historically named *_aa; product UI resolves via resolveReferrerRegistryAaToEoa (EOA passthrough).
 */
async function applyShareRefereeBoundToDb(params: {
	cardAddress: string
	downlineEOA: string
	refereeEOA: string
	txHash?: string | null
}): Promise<void> {
	const downline = normalizeAa(params.downlineEOA)
	const referrer = normalizeAa(params.refereeEOA)
	if (!downline || !referrer) return
	/** Register share-owner as a referrer account row (mirrors on-chain isReferee[refereeEOA]). */
	await upsertCardProgramRefereeRegistered({
		cardAddress: params.cardAddress,
		refereeAA: referrer,
		txHash: params.txHash,
	})
	/** Downline → uplink referrer (canonical registry edge). */
	await updateCardProgramRefereeReferrer({
		cardAddress: params.cardAddress,
		refereeAA: downline,
		referrerAA: referrer,
		txHash: params.txHash,
	})
}

/** Master：从 card receipt 解析 Referee* / ShareRefereeBound 事件并写入 DB。 */
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
		} else if (parsed.name === 'ShareRefereeBoundWithSignature') {
			await applyShareRefereeBoundToDb({
				cardAddress: params.cardAddress,
				downlineEOA: parsed.args.downlineEOA as string,
				refereeEOA: parsed.args.refereeEOA as string,
				txHash,
			})
		} else if (parsed.name === 'ReferrerRefereeRewardLedgered') {
			await upsertCardProgramReferrerRewardLedger({
				cardAddress: params.cardAddress,
				referrerAA: parsed.args.referrer as string,
				refereeAA: parsed.args.referee as string,
				kind: Number(parsed.args.kind),
				amountFiat6: parsed.args.amountFiat6 as bigint,
				reward13E6: parsed.args.reward13E6 as bigint,
				txHash,
			})
		}
	}
}

const SHARE_REFEREE_BOUND_TOPIC =
	CARD_REFEREE_EVENTS_IFACE.getEvent('ShareRefereeBoundWithSignature')?.topicHash ??
	ethers.id(
		'ShareRefereeBoundWithSignature(address,address,address,address,bytes32)',
	)

/** CoNET eth_getLogs practical window (same ceiling as other scanners). */
const SHARE_REFEREE_LOG_CHUNK = 4_500

/**
 * Backfill beamio_card_program_referees from ShareRefereeBoundWithSignature logs.
 * Use when chain registry views revert (AdminStats unrouted) and DB mirror is empty.
 */
export const backfillCardProgramShareRefereeBindsFromLogs = async (params: {
	cardAddress: string
	provider: ethers.Provider
	fromBlock: number
	toBlock?: number
}): Promise<{ scanned: number; applied: number }> => {
	const card = ethers.getAddress(params.cardAddress)
	const cardLower = card.toLowerCase()
	const tip = params.toBlock ?? Number(await params.provider.getBlockNumber())
	const from = Math.max(0, Math.floor(params.fromBlock))
	const to = Math.max(from, Math.floor(tip))
	let scanned = 0
	let applied = 0
	for (let start = from; start <= to; start += SHARE_REFEREE_LOG_CHUNK) {
		const end = Math.min(to, start + SHARE_REFEREE_LOG_CHUNK - 1)
		let logs: ethers.Log[] = []
		try {
			logs = await params.provider.getLogs({
				address: card,
				topics: [SHARE_REFEREE_BOUND_TOPIC],
				fromBlock: start,
				toBlock: end,
			})
		} catch (e: unknown) {
			const err = e as { message?: string }
			logger(
				Colors.yellow(
					`[backfillShareReferee] getLogs failed ${start}-${end}: ${err?.message ?? e}`,
				),
			)
			continue
		}
		scanned += logs.length
		for (const log of logs) {
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
			if (!parsed || parsed.name !== 'ShareRefereeBoundWithSignature') continue
			await applyShareRefereeBoundToDb({
				cardAddress: card,
				downlineEOA: parsed.args.downlineEOA as string,
				refereeEOA: parsed.args.refereeEOA as string,
				txHash: log.transactionHash,
			})
			applied += 1
		}
	}
	logger(
		Colors.cyan(
			`[backfillShareReferee] card=${card} from=${from} to=${to} scanned=${scanned} applied=${applied}`,
		),
	)
	return { scanned, applied }
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
