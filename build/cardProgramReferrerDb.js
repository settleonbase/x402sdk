"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCardProgramRefereesByReferrer = exports.backfillCardProgramShareRefereeBindsFromLogs = exports.syncCardProgramReferrerEventsFromReceipt = exports.upsertCardProgramReferrerRewardLedger = exports.listCardProgramReferees = exports.readCardProgramReferrerDbSummary = exports.listCardProgramRegisteredReferees = exports.updateCardProgramRefereeReferrer = exports.removeCardProgramReferee = exports.upsertCardProgramRefereeRegistered = void 0;
const ethers_1 = require("ethers");
const pg_1 = require("pg");
const safe_1 = __importDefault(require("colors/safe"));
const logger_1 = require("./logger");
const DB_URL = 'postgres://postgres:your_password@127.0.0.1:5432/postgres';
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
`;
const BEAMIO_CARD_PROGRAM_REFEREES_REFERRER_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_referees_card_referrer
ON beamio_card_program_referees (card_address, referrer_aa);
`;
const BEAMIO_CARD_PROGRAM_REFEREES_UPDATED_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_referees_card_updated
ON beamio_card_program_referees (card_address, updated_at DESC);
`;
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
`;
const BEAMIO_CARD_PROGRAM_REFERRER_REWARDS_REFERRER_IDX = `
CREATE INDEX IF NOT EXISTS idx_beamio_card_program_referrer_rewards_card_referrer
ON beamio_card_program_referrer_rewards (card_address, referrer_aa, kind);
`;
async function ensureCardProgramReferrerSchema(db) {
    await db.query(BEAMIO_CARD_PROGRAM_REFEREES_TABLE);
    await db.query(BEAMIO_CARD_PROGRAM_REFEREES_REFERRER_IDX);
    await db.query(BEAMIO_CARD_PROGRAM_REFEREES_UPDATED_IDX);
    await db.query(BEAMIO_CARD_PROGRAM_REFERRER_REWARDS_TABLE);
    await db.query(BEAMIO_CARD_PROGRAM_REFERRER_REWARDS_REFERRER_IDX);
}
function normalizeAa(raw) {
    if (raw == null || String(raw).trim() === '')
        return null;
    const s = String(raw).trim();
    if (!ethers_1.ethers.isAddress(s))
        return null;
    return ethers_1.ethers.getAddress(s).toLowerCase();
}
function normalizeTxHash(raw) {
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.trim()))
        return null;
    return raw.trim().toLowerCase();
}
/** Master：RefereeRegistered 成功后 upsert（不做历史回填）。 */
const upsertCardProgramRefereeRegistered = async (params) => {
    const referee = normalizeAa(params.refereeAA);
    if (!referee)
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureCardProgramReferrerSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const txHash = normalizeTxHash(params.txHash ?? null);
        await db.query(`
			INSERT INTO beamio_card_program_referees (card_address, referee_aa, referrer_aa, last_tx_hash)
			VALUES ($1, $2, NULL, $3)
			ON CONFLICT (card_address, referee_aa)
			DO UPDATE SET updated_at = NOW(),
			              last_tx_hash = COALESCE(EXCLUDED.last_tx_hash, beamio_card_program_referees.last_tx_hash)
			`, [card, referee, txHash]);
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertCardProgramRefereeRegistered] failed: ${err?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertCardProgramRefereeRegistered = upsertCardProgramRefereeRegistered;
/** Master：RefereeUnregistered 成功后删除 DB 行。 */
const removeCardProgramReferee = async (params) => {
    const referee = normalizeAa(params.refereeAA);
    if (!referee)
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureCardProgramReferrerSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        await db.query(`DELETE FROM beamio_card_program_referees WHERE card_address = $1 AND referee_aa = $2`, [card, referee]);
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[removeCardProgramReferee] failed: ${err?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.removeCardProgramReferee = removeCardProgramReferee;
/** Master：RefereeReferrerUpdated 成功后更新 uplink referrer（referrerAA=0 表示 clear）。 */
const updateCardProgramRefereeReferrer = async (params) => {
    const referee = normalizeAa(params.refereeAA);
    if (!referee)
        return;
    const referrerRaw = params.referrerAA;
    const referrer = referrerRaw == null ||
        String(referrerRaw).trim() === '' ||
        String(referrerRaw).toLowerCase() === ethers_1.ethers.ZeroAddress.toLowerCase()
        ? null
        : normalizeAa(referrerRaw);
    if (referrerRaw && referrerRaw !== ethers_1.ethers.ZeroAddress && !referrer)
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureCardProgramReferrerSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const txHash = normalizeTxHash(params.txHash ?? null);
        await db.query(`
			INSERT INTO beamio_card_program_referees (card_address, referee_aa, referrer_aa, last_tx_hash)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (card_address, referee_aa)
			DO UPDATE SET referrer_aa = EXCLUDED.referrer_aa,
			              updated_at = NOW(),
			              last_tx_hash = COALESCE(EXCLUDED.last_tx_hash, beamio_card_program_referees.last_tx_hash)
			`, [card, referee, referrer, txHash]);
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[updateCardProgramRefereeReferrer] failed: ${err?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.updateCardProgramRefereeReferrer = updateCardProgramRefereeReferrer;
const listCardProgramRegisteredReferees = async (cardAddress, opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    try {
        await db.connect();
        await ensureCardProgramReferrerSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`SELECT COUNT(*)::text AS c FROM beamio_card_program_referees WHERE card_address = $1`, [card]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			SELECT referee_aa, referrer_aa, registered_at, updated_at, last_tx_hash
			FROM beamio_card_program_referees
			WHERE card_address = $1
			ORDER BY registered_at ASC, id ASC
			LIMIT $2 OFFSET $3
			`, [card, limit, offset]);
        return {
            items: rows.map((r) => ({
                refereeAa: ethers_1.ethers.getAddress(r.referee_aa),
                referrerAa: r.referrer_aa ? ethers_1.ethers.getAddress(r.referrer_aa) : null,
                registeredAt: r.registered_at instanceof Date ? r.registered_at.toISOString() : String(r.registered_at),
                updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
                txHash: r.last_tx_hash,
            })),
            total,
        };
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[listCardProgramRegisteredReferees] failed: ${err?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCardProgramRegisteredReferees = listCardProgramRegisteredReferees;
/** DB mirror totals for summary KPI when chain count views revert. */
const readCardProgramReferrerDbSummary = async (cardAddress) => {
    const [referrers, registered] = await Promise.all([
        (0, exports.listCardProgramReferees)(cardAddress, { limit: 1, offset: 0 }),
        (0, exports.listCardProgramRegisteredReferees)(cardAddress, { limit: 1, offset: 0 }),
    ]);
    return {
        dbReferrerTotal: referrers.total,
        dbRegisteredRefereeTotal: registered.total,
    };
};
exports.readCardProgramReferrerDbSummary = readCardProgramReferrerDbSummary;
const listCardProgramReferees = async (cardAddress, opts) => {
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    try {
        await db.connect();
        await ensureCardProgramReferrerSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`
			SELECT COUNT(DISTINCT referrer_aa)::text AS c
			FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa IS NOT NULL
			`, [card]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			SELECT referrer_aa, COUNT(*)::text AS referee_count
			FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa IS NOT NULL
			GROUP BY referrer_aa
			ORDER BY MIN(registered_at) ASC, referrer_aa ASC
			LIMIT $2 OFFSET $3
			`, [card, limit, offset]);
        return {
            items: rows.map((r) => ({
                referrerAa: ethers_1.ethers.getAddress(r.referrer_aa),
                refereeCount: Number(r.referee_count) || 0,
            })),
            total,
        };
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[listCardProgramReferees] failed: ${err?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCardProgramReferees = listCardProgramReferees;
const CARD_REFEREE_EVENTS_IFACE = new ethers_1.ethers.Interface([
    'event RefereeRegistered(address indexed refereeAA, address indexed operator)',
    'event RefereeUnregistered(address indexed refereeAA, address indexed operator)',
    'event RefereeReferrerUpdated(address indexed refereeAA, address indexed referrerAA, address indexed operator)',
    /** Discover share bind (AdminStats V4+). Storage keys are EOAs; AA only in event payload. */
    'event ShareRefereeBoundWithSignature(address indexed downlineEOA, address indexed refereeEOA, address downlineAA, address refereeAA, bytes32 nonce)',
    /** kind 1=topup, 2=charge — #13 mint ledger for referrer UI. */
    'event ReferrerRefereeRewardLedgered(address indexed referrer, address indexed referee, uint8 kind, uint256 amountFiat6, uint256 reward13E6)',
]);
/** Upsert cumulative #13 reward from ReferrerRefereeRewardLedgered (additive per event). */
const upsertCardProgramReferrerRewardLedger = async (params) => {
    const referrer = normalizeAa(params.referrerAA);
    const referee = normalizeAa(params.refereeAA);
    const kind = Number(params.kind);
    if (!referrer || !referee || (kind !== 1 && kind !== 2))
        return;
    const amountFiat6 = BigInt(params.amountFiat6).toString();
    const reward13E6 = BigInt(params.reward13E6).toString();
    if (BigInt(reward13E6) <= 0n)
        return;
    const db = new pg_1.Client({ connectionString: DB_URL });
    try {
        await db.connect();
        await ensureCardProgramReferrerSchema(db);
        const card = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
        const txHash = normalizeTxHash(params.txHash ?? null);
        await db.query(`
			INSERT INTO beamio_card_program_referrer_rewards
				(card_address, referrer_aa, referee_aa, kind, reward13_e6, amount_fiat6, last_tx_hash)
			VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7)
			ON CONFLICT (card_address, referrer_aa, referee_aa, kind)
			DO UPDATE SET
				reward13_e6 = beamio_card_program_referrer_rewards.reward13_e6 + EXCLUDED.reward13_e6,
				amount_fiat6 = beamio_card_program_referrer_rewards.amount_fiat6 + EXCLUDED.amount_fiat6,
				updated_at = NOW(),
				last_tx_hash = COALESCE(EXCLUDED.last_tx_hash, beamio_card_program_referrer_rewards.last_tx_hash)
			`, [card, referrer, referee, kind, reward13E6, amountFiat6, txHash]);
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[upsertCardProgramReferrerRewardLedger] failed: ${err?.message ?? e}`));
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.upsertCardProgramReferrerRewardLedger = upsertCardProgramReferrerRewardLedger;
/**
 * Share bind: opener (downlineEOA) becomes referee of share-owner (refereeEOA).
 * DB columns historically named *_aa; product UI resolves via resolveReferrerRegistryAaToEoa (EOA passthrough).
 */
async function applyShareRefereeBoundToDb(params) {
    const downline = normalizeAa(params.downlineEOA);
    const referrer = normalizeAa(params.refereeEOA);
    if (!downline || !referrer)
        return;
    /** Register share-owner as a referrer account row (mirrors on-chain isReferee[refereeEOA]). */
    await (0, exports.upsertCardProgramRefereeRegistered)({
        cardAddress: params.cardAddress,
        refereeAA: referrer,
        txHash: params.txHash,
    });
    /** Downline → uplink referrer (canonical registry edge). */
    await (0, exports.updateCardProgramRefereeReferrer)({
        cardAddress: params.cardAddress,
        refereeAA: downline,
        referrerAA: referrer,
        txHash: params.txHash,
    });
}
/** Master：从 card receipt 解析 Referee* / ShareRefereeBound 事件并写入 DB。 */
const syncCardProgramReferrerEventsFromReceipt = async (params) => {
    const cardLower = ethers_1.ethers.getAddress(params.cardAddress).toLowerCase();
    const txHash = normalizeTxHash(params.txHash ?? null);
    for (const log of params.receipt.logs) {
        if (log.address.toLowerCase() !== cardLower)
            continue;
        let parsed = null;
        try {
            parsed = CARD_REFEREE_EVENTS_IFACE.parseLog({
                topics: [...log.topics],
                data: log.data,
            });
        }
        catch {
            continue;
        }
        if (!parsed)
            continue;
        if (parsed.name === 'RefereeRegistered') {
            await (0, exports.upsertCardProgramRefereeRegistered)({
                cardAddress: params.cardAddress,
                refereeAA: parsed.args.refereeAA,
                txHash,
            });
        }
        else if (parsed.name === 'RefereeUnregistered') {
            await (0, exports.removeCardProgramReferee)({
                cardAddress: params.cardAddress,
                refereeAA: parsed.args.refereeAA,
            });
        }
        else if (parsed.name === 'RefereeReferrerUpdated') {
            await (0, exports.updateCardProgramRefereeReferrer)({
                cardAddress: params.cardAddress,
                refereeAA: parsed.args.refereeAA,
                referrerAA: parsed.args.referrerAA,
                txHash,
            });
        }
        else if (parsed.name === 'ShareRefereeBoundWithSignature') {
            await applyShareRefereeBoundToDb({
                cardAddress: params.cardAddress,
                downlineEOA: parsed.args.downlineEOA,
                refereeEOA: parsed.args.refereeEOA,
                txHash,
            });
        }
        else if (parsed.name === 'ReferrerRefereeRewardLedgered') {
            await (0, exports.upsertCardProgramReferrerRewardLedger)({
                cardAddress: params.cardAddress,
                referrerAA: parsed.args.referrer,
                refereeAA: parsed.args.referee,
                kind: Number(parsed.args.kind),
                amountFiat6: parsed.args.amountFiat6,
                reward13E6: parsed.args.reward13E6,
                txHash,
            });
        }
    }
};
exports.syncCardProgramReferrerEventsFromReceipt = syncCardProgramReferrerEventsFromReceipt;
const SHARE_REFEREE_BOUND_TOPIC = CARD_REFEREE_EVENTS_IFACE.getEvent('ShareRefereeBoundWithSignature')?.topicHash ??
    ethers_1.ethers.id('ShareRefereeBoundWithSignature(address,address,address,address,bytes32)');
/** CoNET eth_getLogs practical window (same ceiling as other scanners). */
const SHARE_REFEREE_LOG_CHUNK = 4_500;
/**
 * Backfill beamio_card_program_referees from ShareRefereeBoundWithSignature logs.
 * Use when chain registry views revert (AdminStats unrouted) and DB mirror is empty.
 */
const backfillCardProgramShareRefereeBindsFromLogs = async (params) => {
    const card = ethers_1.ethers.getAddress(params.cardAddress);
    const cardLower = card.toLowerCase();
    const tip = params.toBlock ?? Number(await params.provider.getBlockNumber());
    const from = Math.max(0, Math.floor(params.fromBlock));
    const to = Math.max(from, Math.floor(tip));
    let scanned = 0;
    let applied = 0;
    for (let start = from; start <= to; start += SHARE_REFEREE_LOG_CHUNK) {
        const end = Math.min(to, start + SHARE_REFEREE_LOG_CHUNK - 1);
        let logs = [];
        try {
            logs = await params.provider.getLogs({
                address: card,
                topics: [SHARE_REFEREE_BOUND_TOPIC],
                fromBlock: start,
                toBlock: end,
            });
        }
        catch (e) {
            const err = e;
            (0, logger_1.logger)(safe_1.default.yellow(`[backfillShareReferee] getLogs failed ${start}-${end}: ${err?.message ?? e}`));
            continue;
        }
        scanned += logs.length;
        for (const log of logs) {
            if (log.address.toLowerCase() !== cardLower)
                continue;
            let parsed = null;
            try {
                parsed = CARD_REFEREE_EVENTS_IFACE.parseLog({
                    topics: [...log.topics],
                    data: log.data,
                });
            }
            catch {
                continue;
            }
            if (!parsed || parsed.name !== 'ShareRefereeBoundWithSignature')
                continue;
            await applyShareRefereeBoundToDb({
                cardAddress: card,
                downlineEOA: parsed.args.downlineEOA,
                refereeEOA: parsed.args.refereeEOA,
                txHash: log.transactionHash,
            });
            applied += 1;
        }
    }
    (0, logger_1.logger)(safe_1.default.cyan(`[backfillShareReferee] card=${card} from=${from} to=${to} scanned=${scanned} applied=${applied}`));
    return { scanned, applied };
};
exports.backfillCardProgramShareRefereeBindsFromLogs = backfillCardProgramShareRefereeBindsFromLogs;
const listCardProgramRefereesByReferrer = async (cardAddress, referrerAA, opts) => {
    const referrer = normalizeAa(referrerAA);
    if (!referrer)
        return { items: [], total: 0 };
    const db = new pg_1.Client({ connectionString: DB_URL });
    const limit = Math.min(Math.max(Number(opts?.limit) || 20, 1), 2000);
    const offset = Math.max(Number(opts?.offset) || 0, 0);
    try {
        await db.connect();
        await ensureCardProgramReferrerSchema(db);
        const card = ethers_1.ethers.getAddress(cardAddress).toLowerCase();
        const countRes = await db.query(`
			SELECT COUNT(*)::text AS c FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa = $2
			`, [card, referrer]);
        const total = Number(countRes.rows[0]?.c ?? 0) || 0;
        const { rows } = await db.query(`
			SELECT referee_aa, referrer_aa, registered_at, updated_at, last_tx_hash
			FROM beamio_card_program_referees
			WHERE card_address = $1 AND referrer_aa = $2
			ORDER BY registered_at ASC, id ASC
			LIMIT $3 OFFSET $4
			`, [card, referrer, limit, offset]);
        return {
            items: rows.map((r) => ({
                refereeAa: ethers_1.ethers.getAddress(r.referee_aa),
                referrerAa: r.referrer_aa ? ethers_1.ethers.getAddress(r.referrer_aa) : null,
                registeredAt: r.registered_at instanceof Date ? r.registered_at.toISOString() : String(r.registered_at),
                updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
                txHash: r.last_tx_hash,
            })),
            total,
        };
    }
    catch (e) {
        const err = e;
        (0, logger_1.logger)(safe_1.default.yellow(`[listCardProgramRefereesByReferrer] failed: ${err?.message ?? e}`));
        return { items: [], total: 0 };
    }
    finally {
        await db.end().catch(() => { });
    }
};
exports.listCardProgramRefereesByReferrer = listCardProgramRefereesByReferrer;
