"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCardProgramShareClicks = exports.listCardProgramLikes = exports.insertCardProgramShareClick = exports.removeCardProgramLike = exports.upsertCardProgramLike = void 0;
const ethers_1 = require("ethers");
const pg_1 = require("pg");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const DB_URL = 'postgres://postgres:your_password@127.0.0.1:5432/postgres';
const BEAMIO_CARD_PROGRAM_LIKES_TABLE = `
CREATE TABLE IF NOT EXISTS beamio_card_program_likes (
	id BIGSERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	user_eoa TEXT NOT NULL,
	target_kind SMALLINT NOT NULL DEFAULT 1,
	issued_parent_id TEXT NOT NULL DEFAULT '0',
	tx_hash TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE (card_address, user_eoa, target_kind, issued_parent_id)
);
`;
const BEAMIO_CARD_PROGRAM_LIKES_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_likes_card_created
ON beamio_card_program_likes (card_address, created_at DESC);
`;
const BEAMIO_CARD_PROGRAM_SHARE_CLICKS_TABLE = `
CREATE TABLE IF NOT EXISTS beamio_card_program_share_clicks (
	id BIGSERIAL PRIMARY KEY,
	card_address TEXT NOT NULL,
	actor_eoa TEXT NOT NULL,
	referrer_eoa TEXT,
	target_kind SMALLINT NOT NULL DEFAULT 1,
	issued_parent_id TEXT NOT NULL DEFAULT '0',
	tx_hash TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
const BEAMIO_CARD_PROGRAM_SHARE_CLICKS_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_share_clicks_card_created
ON beamio_card_program_share_clicks (card_address, created_at DESC);
`;
async function ensureCardProgramSocialSchema(db) {
    await db.query(BEAMIO_CARD_PROGRAM_LIKES_TABLE);
    await db.query(BEAMIO_CARD_PROGRAM_LIKES_IDX);
    await db.query(BEAMIO_CARD_PROGRAM_SHARE_CLICKS_TABLE);
    await db.query(BEAMIO_CARD_PROGRAM_SHARE_CLICKS_IDX);
}
function normalizeOptionalAddress(raw) {
    if (raw == null || String(raw).trim() === '')
        return null;
    const s = String(raw).trim();
    if (!ethers_1.ethers.isAddress(s))
        return null;
    return ethers_1.ethers.getAddress(s).toLowerCase();
}
/** Master：点赞链上 tx 成功后写入（不做历史回填）。 */
const upsertCardProgramLike = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureCardProgramSocialSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const user = ethers_1.ethers.getAddress(params.userEOA).toLowerCase();
        const targetKind = Number(params.targetKind ?? 1);
        const issuedParentId = String(params.issuedParentId ?? '0');
        const txHash = typeof params.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(params.txHash.trim())
            ? params.txHash.trim().toLowerCase()
            : null;
        await db.query(`
			INSERT INTO beamio_card_program_likes (card_address, user_eoa, target_kind, issued_parent_id, tx_hash)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (card_address, user_eoa, target_kind, issued_parent_id)
			DO UPDATE SET tx_hash = COALESCE(EXCLUDED.tx_hash, beamio_card_program_likes.tx_hash),
			              created_at = NOW()
			`, [card, user, targetKind, issuedParentId, txHash]);
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertCardProgramLike] failed: ${err?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertCardProgramLike = upsertCardProgramLike;
/** Master：取消点赞成功后删除 DB 行。 */
const removeCardProgramLike = async (params) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureCardProgramSocialSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const user = ethers_1.ethers.getAddress(params.userEOA).toLowerCase();
        const targetKind = Number(params.targetKind ?? 1);
        const issuedParentId = String(params.issuedParentId ?? '0');
        await db.query(`
			DELETE FROM beamio_card_program_likes
			WHERE card_address = $1 AND user_eoa = $2 AND target_kind = $3 AND issued_parent_id = $4
			`, [card, user, targetKind, issuedParentId]);
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[removeCardProgramLike] failed: ${err?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.removeCardProgramLike = removeCardProgramLike;
/** Master：dispatchEventReward13 等分享点击统计成功后追加一行（不做历史回填）。 */
const insertCardProgramShareClick = async (params) => {
    const actor = normalizeOptionalAddress(params.actorEOA);
    if (!actor)
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureCardProgramSocialSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const referrer = normalizeOptionalAddress(params.referrerEOA ?? null);
        const targetKind = Number(params.targetKind ?? 1);
        const issuedParentId = String(params.issuedParentId ?? '0');
        const txHash = typeof params.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(params.txHash.trim())
            ? params.txHash.trim().toLowerCase()
            : null;
        await db.query(`
			INSERT INTO beamio_card_program_share_clicks (card_address, actor_eoa, referrer_eoa, target_kind, issued_parent_id, tx_hash)
			VALUES ($1, $2, $3, $4, $5, $6)
			`, [card, actor, referrer, targetKind, issuedParentId, txHash]);
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[insertCardProgramShareClick] failed: ${err?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.insertCardProgramShareClick = insertCardProgramShareClick;
const listCardProgramLikes = async (cardAddress, opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    const targetKind = opts?.targetKind != null ? Number(opts.targetKind) : 1;
    const issuedParentId = String(opts?.issuedParentId ?? '0');
    try {
        await db.connect();
        await ensureCardProgramSocialSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`
			SELECT COUNT(*)::text AS c FROM beamio_card_program_likes
			WHERE card_address = $1 AND target_kind = $2 AND issued_parent_id = $3
			`, [card, targetKind, issuedParentId]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			SELECT user_eoa, target_kind, issued_parent_id, tx_hash, created_at
			FROM beamio_card_program_likes
			WHERE card_address = $1 AND target_kind = $2 AND issued_parent_id = $3
			ORDER BY created_at DESC, id DESC
			LIMIT $4 OFFSET $5
			`, [card, targetKind, issuedParentId, limit, offset]);
        return {
            items: rows.map((r) => ({
                userEoa: ethers_1.ethers.getAddress(r.user_eoa),
                targetKind: r.target_kind,
                issuedParentId: r.issued_parent_id,
                txHash: r.tx_hash,
                createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
            })),
            total,
        };
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[listCardProgramLikes] failed: ${err?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCardProgramLikes = listCardProgramLikes;
const listCardProgramShareClicks = async (cardAddress, opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    const targetKind = opts?.targetKind != null ? Number(opts.targetKind) : 1;
    const issuedParentId = String(opts?.issuedParentId ?? '0');
    try {
        await db.connect();
        await ensureCardProgramSocialSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`
			SELECT COUNT(*)::text AS c FROM beamio_card_program_share_clicks
			WHERE card_address = $1 AND target_kind = $2 AND issued_parent_id = $3
			`, [card, targetKind, issuedParentId]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			SELECT actor_eoa, referrer_eoa, target_kind, issued_parent_id, tx_hash, created_at
			FROM beamio_card_program_share_clicks
			WHERE card_address = $1 AND target_kind = $2 AND issued_parent_id = $3
			ORDER BY created_at DESC, id DESC
			LIMIT $4 OFFSET $5
			`, [card, targetKind, issuedParentId, limit, offset]);
        return {
            items: rows.map((r) => ({
                actorEoa: ethers_1.ethers.getAddress(r.actor_eoa),
                referrerEoa: r.referrer_eoa ? ethers_1.ethers.getAddress(r.referrer_eoa) : null,
                targetKind: r.target_kind,
                issuedParentId: r.issued_parent_id,
                txHash: r.tx_hash,
                createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
            })),
            total,
        };
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[listCardProgramShareClicks] failed: ${err?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCardProgramShareClicks = listCardProgramShareClicks;
