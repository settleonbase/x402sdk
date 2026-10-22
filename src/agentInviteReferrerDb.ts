/**
 * Personal invite referees (BeamioAgentReferrerRegistry RegisterReferrer).
 * Persist (introducer EOA → referee EOA) after successful offline-signed bind
 * so introducers can list who registered through their link.
 */
import { ethers } from 'ethers'
import { Client } from 'pg'
import Colors from 'colors/safe'
import { logger } from './logger'

const DB_URL = 'postgres://postgres:your_password@127.0.0.1:5432/postgres'

const BEAMIO_AGENT_INVITE_REFEREES_TABLE = `
CREATE TABLE IF NOT EXISTS beamio_agent_invite_referees (
	id BIGSERIAL PRIMARY KEY,
	introducer_eoa TEXT NOT NULL,
	referee_eoa TEXT NOT NULL,
	registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	last_tx_hash TEXT,
	UNIQUE (introducer_eoa, referee_eoa)
);
`

const BEAMIO_AGENT_INVITE_REFEREES_INTRODUCER_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_agent_invite_referees_introducer
ON beamio_agent_invite_referees (introducer_eoa, registered_at DESC);
`

async function ensureAgentInviteReferrerSchema(db: Client): Promise<void> {
	await db.query(BEAMIO_AGENT_INVITE_REFEREES_TABLE)
	await db.query(BEAMIO_AGENT_INVITE_REFEREES_INTRODUCER_IDX)
}

export type AgentInviteRefereeRow = {
	introducerEoa: string
	refereeEoa: string
	registeredAt: string
	updatedAt: string
	txHash: string | null
}

export type AgentInviteRefereePage = {
	items: AgentInviteRefereeRow[]
	total: number
}

/** Upsert one referee under introducer after RegisterReferrer succeeds on-chain. */
export async function upsertAgentInviteReferee(input: {
	introducer: string
	referee: string
	txHash?: string | null
	registeredAt?: Date | string | null
}): Promise<boolean> {
	if (!ethers.isAddress(input.introducer) || !ethers.isAddress(input.referee)) return false
	const introducer = ethers.getAddress(input.introducer).toLowerCase()
	const referee = ethers.getAddress(input.referee).toLowerCase()
	if (introducer === referee) return false
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensureAgentInviteReferrerSchema(db)
		const registeredAt =
			input.registeredAt instanceof Date
				? input.registeredAt
				: input.registeredAt
					? new Date(input.registeredAt)
					: new Date()
		await db.query(
			`
			INSERT INTO beamio_agent_invite_referees
				(introducer_eoa, referee_eoa, registered_at, updated_at, last_tx_hash)
			VALUES ($1, $2, $3, NOW(), $4)
			ON CONFLICT (introducer_eoa, referee_eoa) DO UPDATE SET
				updated_at = NOW(),
				last_tx_hash = COALESCE(EXCLUDED.last_tx_hash, beamio_agent_invite_referees.last_tx_hash)
			`,
			[introducer, referee, registeredAt, input.txHash?.trim() || null],
		)
		return true
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[upsertAgentInviteReferee] failed: ${err?.message ?? e}`))
		return false
	} finally {
		await db.end().catch(() => {})
	}
}

/** Batch upsert (e.g. chain backfill). Best-effort; returns how many rows attempted. */
export async function upsertAgentInviteRefereesBatch(
	introducer: string,
	referees: string[],
): Promise<number> {
	if (!ethers.isAddress(introducer) || !referees.length) return 0
	let n = 0
	for (const ref of referees) {
		const ok = await upsertAgentInviteReferee({ introducer, referee: ref })
		if (ok) n += 1
	}
	return n
}

export async function listAgentInviteReferees(
	introducerEoa: string,
	opts?: { limit?: number; offset?: number },
): Promise<AgentInviteRefereePage> {
	if (!ethers.isAddress(introducerEoa)) return { items: [], total: 0 }
	const db = new Client({ connectionString: DB_URL })
	const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 200)
	const offset = Math.max(Number(opts?.offset) || 0, 0)
	try {
		await db.connect()
		await ensureAgentInviteReferrerSchema(db)
		const introducer = ethers.getAddress(introducerEoa).toLowerCase()
		const countRes = await db.query<{ c: string }>(
			`SELECT COUNT(*)::text AS c FROM beamio_agent_invite_referees WHERE introducer_eoa = $1`,
			[introducer],
		)
		const total = Number(countRes.rows[0]?.c ?? 0) || 0
		const { rows } = await db.query<{
			introducer_eoa: string
			referee_eoa: string
			registered_at: Date
			updated_at: Date
			last_tx_hash: string | null
		}>(
			`
			SELECT introducer_eoa, referee_eoa, registered_at, updated_at, last_tx_hash
			FROM beamio_agent_invite_referees
			WHERE introducer_eoa = $1
			ORDER BY registered_at DESC, id DESC
			LIMIT $2 OFFSET $3
			`,
			[introducer, limit, offset],
		)
		return {
			items: rows.map((r) => ({
				introducerEoa: ethers.getAddress(r.introducer_eoa),
				refereeEoa: ethers.getAddress(r.referee_eoa),
				registeredAt:
					r.registered_at instanceof Date ? r.registered_at.toISOString() : String(r.registered_at),
				updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
				txHash: r.last_tx_hash,
			})),
			total,
		}
	} catch (e: unknown) {
		const err = e as { message?: string }
		logger(Colors.yellow(`[listAgentInviteReferees] failed: ${err?.message ?? e}`))
		return { items: [], total: 0 }
	} finally {
		await db.end().catch(() => {})
	}
}
