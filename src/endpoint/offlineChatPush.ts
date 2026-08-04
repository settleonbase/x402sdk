/**
 * Offline chat → push badge: iOS APNs + Android FCM.
 * Credentials from ~/.master.json / env — never commit .p8 or FCM service-account keys.
 */

import { createPrivateKey, createSign, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http2 from 'node:http2'
import { Client } from 'pg'
import { ethers } from 'ethers'
import Colors from 'colors/safe'
import { logger } from '../logger'
import { masterSetup } from '../util'
import { CONET_RPC_URL } from '../chainAddresses'
import type { Request, Response } from 'express'

const DB_URL = 'postgres://postgres:your_password@127.0.0.1:5432/postgres'

const ALLOWED_BUNDLE_IDS = new Set(['com.beamio.beamio', 'com.beamio.app'])
const SIGN_MAX_SKEW_MS = 10 * 60 * 1000
/** Burst dedup for multi-entry fan-out (same msg → many saveLocal). Keep short so a second
 * real offline message within a minute still gets APNs (55s previously blocked force-quit retests). */
const NOTIFY_DEDUP_MS = 2_500

const PUSH_DEVICES_TABLE = `CREATE TABLE IF NOT EXISTS beamio_push_devices (
	id SERIAL PRIMARY KEY,
	eoa TEXT NOT NULL,
	device_token TEXT NOT NULL,
	platform TEXT NOT NULL DEFAULT 'ios',
	bundle_id TEXT NOT NULL,
	pgp_key_id TEXT,
	updated_at TIMESTAMPTZ DEFAULT NOW(),
	UNIQUE (device_token)
)`
const PUSH_DEVICES_EOA_IDX = `CREATE INDEX IF NOT EXISTS idx_beamio_push_devices_eoa ON beamio_push_devices (LOWER(eoa))`

const PUSH_UNREAD_TABLE = `CREATE TABLE IF NOT EXISTS beamio_push_unread (
	eoa TEXT PRIMARY KEY,
	unread_count INT NOT NULL DEFAULT 0,
	updated_at TIMESTAMPTZ DEFAULT NOW()
)`

type ApnsConfig = {
	keyId: string
	teamId: string
	bundleId: string
	p8Pem: string
	production: boolean
}

type FcmConfig = {
	projectId: string
	clientEmail: string
	privateKeyPem: string
}

function readApnsConfig(): ApnsConfig | null {
	const m = masterSetup as IMasterSetup & {
		apns_key_id?: string
		apns_team_id?: string
		apns_bundle_id?: string
		apns_p8?: string
		apns_p8_path?: string
		apns_production?: boolean
	}
	const keyId = (process.env.APNS_KEY_ID || m.apns_key_id || '').trim()
	const teamId = (process.env.APNS_TEAM_ID || m.apns_team_id || '').trim()
	const bundleId = (process.env.APNS_BUNDLE_ID || m.apns_bundle_id || 'com.beamio.beamio').trim()
	let p8Pem = (process.env.APNS_P8 || m.apns_p8 || '').trim()
	const p8Path = (process.env.APNS_P8_PATH || m.apns_p8_path || '').trim()
	if (!p8Pem && p8Path) {
		try {
			p8Pem = fs.readFileSync(p8Path, 'utf8').trim()
		} catch (e: any) {
			logger(Colors.yellow(`[APNs] cannot read apns_p8_path: ${e?.message ?? e}`))
			return null
		}
	}
	if (!keyId || !teamId || !p8Pem) return null
	const production =
		process.env.APNS_PRODUCTION === '1' ||
		process.env.APNS_PRODUCTION === 'true' ||
		m.apns_production === true
	return { keyId, teamId, bundleId, p8Pem, production }
}

function readFcmConfig(): FcmConfig | null {
	const m = masterSetup as IMasterSetup & {
		fcm_project_id?: string
		fcm_service_account_json?: string
		fcm_service_account_path?: string
	}
	const projectId = (process.env.FCM_PROJECT_ID || m.fcm_project_id || '').trim()
	let rawJson = (process.env.FCM_SERVICE_ACCOUNT_JSON || m.fcm_service_account_json || '').trim()
	const path = (process.env.FCM_SERVICE_ACCOUNT_PATH || m.fcm_service_account_path || '').trim()
	if (!rawJson && path) {
		try {
			rawJson = fs.readFileSync(path, 'utf8').trim()
		} catch (e: any) {
			logger(Colors.yellow(`[FCM] cannot read fcm_service_account_path: ${e?.message ?? e}`))
			return null
		}
	}
	if (!rawJson) return null
	try {
		const sa = JSON.parse(rawJson) as {
			project_id?: string
			client_email?: string
			private_key?: string
		}
		const pid = projectId || (sa.project_id || '').trim()
		const email = (sa.client_email || '').trim()
		const pk = (sa.private_key || '').replace(/\\n/g, '\n').trim()
		if (!pid || !email || !pk) return null
		return { projectId: pid, clientEmail: email, privateKeyPem: pk }
	} catch (e: any) {
		logger(Colors.yellow(`[FCM] invalid service account JSON: ${e?.message ?? e}`))
		return null
	}
}

function siOfflinePushSecret(): string {
	const m = masterSetup as IMasterSetup & { si_offline_push_secret?: string }
	return (process.env.SI_OFFLINE_PUSH_SECRET || m.si_offline_push_secret || '').trim()
}

const ADDRESS_PGP = '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2'
const ADDRESS_PGP_NODE_ABI = ['function nodeWallet2KeyHash(address) view returns (bytes32)'] as const

function buildNotifyOfflineChatMessage(params: {
	pgpKeyId: string
	eoa: string
	timestamp: number
}): string {
	return [
		'Beamio notifyOfflineChat',
		`pgpKeyId:${params.pgpKeyId}`,
		`eoa:${params.eoa.toLowerCase()}`,
		`timestamp:${params.timestamp}`,
	].join('\n')
}

async function isRegisteredGuardianNodeWallet(wallet: string): Promise<boolean> {
	try {
		const rpc = (process.env.CONET_RPC_URL || CONET_RPC_URL || 'https://rpc1.conet.network').trim()
		const provider = new ethers.JsonRpcProvider(rpc)
		const sc = new ethers.Contract(ADDRESS_PGP, ADDRESS_PGP_NODE_ABI, provider)
		const hash: string = await sc.nodeWallet2KeyHash(ethers.getAddress(wallet))
		return !!hash && hash !== ethers.ZeroHash
	} catch (e: any) {
		logger(Colors.yellow(`[notifyOfflineChat] guardian check failed: ${e?.message ?? e}`))
		return false
	}
}

function b64url(input: Buffer | string): string {
	const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
	return buf.toString('base64url')
}

let cachedApnsJwt: { token: string; exp: number } | null = null

function createApnsJwt(cfg: ApnsConfig): string {
	const now = Math.floor(Date.now() / 1000)
	if (cachedApnsJwt && cachedApnsJwt.exp - 60 > now) return cachedApnsJwt.token
	const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))
	const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: now }))
	const unsigned = `${header}.${claims}`
	const key = createPrivateKey({ key: cfg.p8Pem, format: 'pem' })
	const sig = createSign('SHA256').update(unsigned).sign({ key, dsaEncoding: 'ieee-p1363' })
	const token = `${unsigned}.${b64url(sig)}`
	cachedApnsJwt = { token, exp: now + 50 * 60 }
	return token
}

async function ensurePushSchema(db: Client): Promise<void> {
	await db.query(PUSH_DEVICES_TABLE)
	await db.query(PUSH_DEVICES_EOA_IDX)
	await db.query(PUSH_UNREAD_TABLE)
}

export async function upsertPushDevice(params: {
	eoa: string
	deviceToken: string
	platform: string
	bundleId: string
	pgpKeyId?: string | null
}): Promise<void> {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensurePushSchema(db)
		const eoa = ethers.getAddress(params.eoa).toLowerCase()
		await db.query(
			`INSERT INTO beamio_push_devices (eoa, device_token, platform, bundle_id, pgp_key_id, updated_at)
			 VALUES ($1, $2, $3, $4, $5, NOW())
			 ON CONFLICT (device_token) DO UPDATE SET
			   eoa = EXCLUDED.eoa,
			   platform = EXCLUDED.platform,
			   bundle_id = EXCLUDED.bundle_id,
			   pgp_key_id = EXCLUDED.pgp_key_id,
			   updated_at = NOW()`,
			[eoa, params.deviceToken, params.platform, params.bundleId, params.pgpKeyId || null],
		)
	} finally {
		await db.end().catch(() => {})
	}
}

export async function setPushUnread(eoaRaw: string, unread: number): Promise<number> {
	const safe = Math.max(0, Math.min(999, Math.floor(unread)))
	const eoa = ethers.getAddress(eoaRaw).toLowerCase()
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensurePushSchema(db)
		await db.query(
			`INSERT INTO beamio_push_unread (eoa, unread_count, updated_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (eoa) DO UPDATE SET unread_count = EXCLUDED.unread_count, updated_at = NOW()`,
			[eoa, safe],
		)
		return safe
	} finally {
		await db.end().catch(() => {})
	}
}

export async function incrementPushUnread(eoaRaw: string, delta = 1): Promise<number> {
	const eoa = ethers.getAddress(eoaRaw).toLowerCase()
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensurePushSchema(db)
		const r = await db.query<{ unread_count: number }>(
			`INSERT INTO beamio_push_unread (eoa, unread_count, updated_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (eoa) DO UPDATE SET
			   unread_count = LEAST(999, beamio_push_unread.unread_count + $2),
			   updated_at = NOW()
			 RETURNING unread_count`,
			[eoa, Math.max(1, Math.floor(delta))],
		)
		return Number(r.rows[0]?.unread_count ?? 1)
	} finally {
		await db.end().catch(() => {})
	}
}

async function listDevicesForEoa(
	eoaRaw: string,
): Promise<Array<{ deviceToken: string; bundleId: string; platform: string }>> {
	const eoa = ethers.getAddress(eoaRaw).toLowerCase()
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await ensurePushSchema(db)
		const r = await db.query<{ device_token: string; bundle_id: string; platform: string }>(
			`SELECT device_token, bundle_id, platform FROM beamio_push_devices WHERE LOWER(eoa) = $1`,
			[eoa],
		)
		return r.rows.map((row) => ({
			deviceToken: row.device_token,
			bundleId: row.bundle_id,
			platform: (row.platform || 'ios').toLowerCase(),
		}))
	} finally {
		await db.end().catch(() => {})
	}
}

async function deleteDeviceToken(token: string): Promise<void> {
	const db = new Client({ connectionString: DB_URL })
	try {
		await db.connect()
		await db.query(`DELETE FROM beamio_push_devices WHERE device_token = $1`, [token])
	} finally {
		await db.end().catch(() => {})
	}
}

/**
 * iOS icon badge must use `apns-push-type: alert`.
 * Badge-only `background` + content-available is accepted by APNs (HTTP 200)
 * but iOS often never applies the badge when the app is killed / suspended.
 */
function sendApnsBadge(cfg: ApnsConfig, deviceToken: string, badge: number, topic: string): Promise<{ ok: boolean; status?: number }> {
	return new Promise((resolve) => {
		const host = cfg.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'
		const jwt = createApnsJwt(cfg)
		const client = http2.connect(`https://${host}`)
		client.on('error', (err) => {
			logger(Colors.yellow(`[APNs] connect error: ${(err as Error).message}`))
			try {
				client.close()
			} catch {}
			resolve({ ok: false })
		})
		const req = client.request({
			':method': 'POST',
			':path': `/3/device/${deviceToken}`,
			authorization: `bearer ${jwt}`,
			'apns-topic': topic,
			'apns-push-type': 'alert',
			'apns-priority': '10',
			'apns-id': randomUUID(),
			'content-type': 'application/json',
		})
		let status = 0
		let body = ''
		req.on('response', (headers) => {
			status = Number(headers[':status'] || 0)
		})
		req.setEncoding('utf8')
		req.on('data', (chunk) => {
			body += chunk
		})
		req.on('end', () => {
			try {
				client.close()
			} catch {}
			if (status === 410 || status === 400) {
				if (body) logger(Colors.yellow(`[APNs] fail body=${body.slice(0, 200)}`))
				void deleteDeviceToken(deviceToken)
			} else if (status < 200 || status >= 300) {
				if (body) logger(Colors.yellow(`[APNs] HTTP ${status} body=${body.slice(0, 200)}`))
			}
			resolve({ ok: status >= 200 && status < 300, status })
		})
		req.on('error', (err) => {
			logger(Colors.yellow(`[APNs] request error: ${(err as Error).message}`))
			try {
				client.close()
			} catch {}
			resolve({ ok: false, status })
		})
		const unreadLabel = badge <= 0 ? 'Messages' : badge === 1 ? '1 new message' : `${badge} new messages`
		req.end(
			JSON.stringify({
				aps: {
					alert: {
						title: 'Beamio',
						body: unreadLabel,
					},
					badge: Math.max(0, Math.floor(badge)),
					sound: 'default',
				},
			}),
		)
	})
}

let cachedFcmAccess: { token: string; exp: number } | null = null

async function getFcmAccessToken(cfg: FcmConfig): Promise<string | null> {
	const now = Math.floor(Date.now() / 1000)
	if (cachedFcmAccess && cachedFcmAccess.exp - 60 > now) return cachedFcmAccess.token
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
	const claims = b64url(
		JSON.stringify({
			iss: cfg.clientEmail,
			scope: 'https://www.googleapis.com/auth/firebase.messaging',
			aud: 'https://oauth2.googleapis.com/token',
			iat: now,
			exp: now + 3600,
		}),
	)
	const unsigned = `${header}.${claims}`
	try {
		const key = createPrivateKey({ key: cfg.privateKeyPem, format: 'pem' })
		const sig = createSign('RSA-SHA256').update(unsigned).sign(key)
		const assertion = `${unsigned}.${b64url(sig)}`
		const body = new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion,
		})
		const res = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
		})
		if (!res.ok) {
			logger(Colors.yellow(`[FCM] OAuth token HTTP ${res.status}`))
			return null
		}
		const json = (await res.json()) as { access_token?: string; expires_in?: number }
		const token = (json.access_token || '').trim()
		if (!token) return null
		cachedFcmAccess = { token, exp: now + Math.min(3500, Number(json.expires_in) || 3600) }
		return token
	} catch (e: any) {
		logger(Colors.yellow(`[FCM] OAuth error: ${e?.message ?? e}`))
		return null
	}
}

/**
 * Android launcher badge requires a **notification** FCM (not data-only) when the
 * app is backgrounded / killed — data-only never reaches `onMessageReceived` then,
 * so our silent local `setNumber` never runs. Mirror iOS alert+badge:
 * system tray + `notification_count` for OEM badge.
 * Channel id must match `CashTreesNativeAppStateBridge.BADGE_CHANNEL_ID`.
 */
async function sendFcmBadge(
	cfg: FcmConfig,
	deviceToken: string,
	badge: number,
): Promise<{ ok: boolean; status?: number }> {
	const access = await getFcmAccessToken(cfg)
	if (!access) return { ok: false }
	const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`
	const safeBadge = Math.max(0, Math.floor(badge))
	const unreadLabel =
		safeBadge <= 0 ? 'Messages' : safeBadge === 1 ? '1 new message' : `${safeBadge} new messages`
	const data = {
		type: 'chatBadge',
		badge: String(safeBadge),
		unread: String(safeBadge),
	}
	// badge=0: data-only clear attempt (foreground/alive). Background clear relies on
	// the next open / syncChatBadge; FCM cannot cancel a prior notification via data-only.
	const message: Record<string, unknown> =
		safeBadge > 0
			? {
					token: deviceToken,
					notification: {
						title: 'Beamio',
						body: unreadLabel,
					},
					data,
					android: {
						priority: 'HIGH',
						notification: {
							// Do **not** reuse `app_icon_badge` (IMPORTANCE_MIN local silent
							// channel) — many OEMs skip tray/badge for MIN. New id lets FCM
							// create a default-importance channel without an APK update.
							channel_id: 'beamio_chat_offline',
							notification_count: safeBadge,
							tag: 'beamio_chat_badge',
							default_sound: true,
						},
					},
				}
			: {
					token: deviceToken,
					data,
					android: {
						priority: 'HIGH',
					},
				}
	const payload = { message }
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${access}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		})
		if (res.status === 404 || res.status === 410) {
			void deleteDeviceToken(deviceToken)
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '')
			logger(Colors.yellow(`[FCM] send HTTP ${res.status}: ${text.slice(0, 200)}`))
		}
		return { ok: res.ok, status: res.status }
	} catch (e: any) {
		logger(Colors.yellow(`[FCM] send error: ${e?.message ?? e}`))
		return { ok: false }
	}
}

export async function pushBadgeToEoa(eoa: string, badge: number): Promise<void> {
	const devices = await listDevicesForEoa(eoa)
	if (!devices.length) {
		logger(Colors.cyan(`[push] no devices for ${eoa.slice(0, 10)}…`))
		return
	}
	const apnsCfg = readApnsConfig()
	const fcmCfg = readFcmConfig()
	await Promise.all(
		devices.map(async (d) => {
			if (d.platform === 'android') {
				if (!fcmCfg) {
					logger(Colors.yellow('[FCM] skip — fcm_project_id / service account not configured'))
					return
				}
				const r = await sendFcmBadge(fcmCfg, d.deviceToken, badge)
				logger(
					r.ok
						? Colors.green(`[FCM] badge=${badge} token=${d.deviceToken.slice(0, 12)}… ok`)
						: Colors.yellow(`[FCM] badge fail status=${r.status} token=${d.deviceToken.slice(0, 12)}…`),
				)
				return
			}
			if (!apnsCfg) {
				logger(Colors.yellow('[APNs] skip send — credentials not configured (apns_key_id / apns_team_id / apns_p8)'))
				return
			}
			const topic = d.bundleId || apnsCfg.bundleId
			const r = await sendApnsBadge(apnsCfg, d.deviceToken, badge, topic)
			logger(
				r.ok
					? Colors.green(`[APNs] badge=${badge} token=${d.deviceToken.slice(0, 8)}… ok`)
					: Colors.yellow(`[APNs] badge fail status=${r.status} token=${d.deviceToken.slice(0, 8)}…`),
			)
		}),
	)
}

function isValidPushToken(platform: string, token: string): boolean {
	if (platform === 'ios') return /^[0-9a-f]{64}$/.test(token)
	if (platform === 'android') {
		if (token.length < 80 || token.length > 4096) return false
		return /^[A-Za-z0-9_.:\-]+$/.test(token)
	}
	return false
}

function buildRegisterMessage(params: {
	eoa: string
	deviceToken: string
	platform: string
	bundleId: string
	timestamp: number
}): string {
	return [
		'Beamio registerPushDevice',
		`eoa:${params.eoa.toLowerCase()}`,
		`deviceToken:${params.deviceToken}`,
		`platform:${params.platform}`,
		`bundleId:${params.bundleId}`,
		`timestamp:${params.timestamp}`,
	].join('\n')
}

function buildSyncBadgeMessage(params: { eoa: string; unread: number; timestamp: number }): string {
	return [
		'Beamio syncChatBadge',
		`eoa:${params.eoa.toLowerCase()}`,
		`unread:${params.unread}`,
		`timestamp:${params.timestamp}`,
	].join('\n')
}

function verifyPersonalSign(message: string, signature: string, expectedEoa: string): boolean {
	try {
		const recovered = ethers.verifyMessage(message, signature)
		return recovered.toLowerCase() === expectedEoa.toLowerCase()
	} catch {
		return false
	}
}

function parseTimestamp(raw: unknown): number | null {
	const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
	if (!Number.isFinite(n)) return null
	const ms = n < 1e12 ? n * 1000 : n
	return ms
}

/** Cluster: format + signature precheck, then forward. */
export function registerPushDevicePreCheck(body: any): { ok: true; payload: any } | { ok: false; error: string; status: number } {
	const eoa = String(body?.eoa || '').trim()
	const platform = String(body?.platform || 'ios').trim().toLowerCase()
	const deviceTokenRaw = String(body?.deviceToken || '').trim()
	const deviceToken = platform === 'ios' ? deviceTokenRaw.toLowerCase() : deviceTokenRaw
	const bundleId = String(
		body?.bundleId || (platform === 'android' ? 'com.beamio.app' : 'com.beamio.beamio'),
	).trim()
	const signature = String(body?.signature || '').trim()
	const pgpKeyId = body?.pgpKeyId != null ? String(body.pgpKeyId).trim() : ''
	const ts = parseTimestamp(body?.timestamp)
	if (!ethers.isAddress(eoa) || eoa === ethers.ZeroAddress) return { ok: false, error: 'Invalid eoa', status: 400 }
	if (platform !== 'ios' && platform !== 'android') return { ok: false, error: 'Unsupported platform', status: 400 }
	if (!isValidPushToken(platform, deviceToken)) return { ok: false, error: 'Invalid deviceToken', status: 400 }
	if (!ALLOWED_BUNDLE_IDS.has(bundleId)) return { ok: false, error: 'Invalid bundleId', status: 400 }
	if (!signature) return { ok: false, error: 'Missing signature', status: 400 }
	if (ts == null || Math.abs(Date.now() - ts) > SIGN_MAX_SKEW_MS) return { ok: false, error: 'Invalid or expired timestamp', status: 400 }
	const checksum = ethers.getAddress(eoa)
	const message = buildRegisterMessage({
		eoa: checksum,
		deviceToken,
		platform,
		bundleId,
		timestamp: Math.floor(ts / 1000),
	})
	// Accept either seconds or ms in signed message
	const messageMs = buildRegisterMessage({
		eoa: checksum,
		deviceToken,
		platform,
		bundleId,
		timestamp: ts,
	})
	if (!verifyPersonalSign(message, signature, checksum) && !verifyPersonalSign(messageMs, signature, checksum)) {
		return { ok: false, error: 'Invalid signature', status: 403 }
	}
	return {
		ok: true,
		payload: {
			eoa: checksum.toLowerCase(),
			deviceToken,
			platform,
			bundleId,
			pgpKeyId: pgpKeyId || undefined,
			timestamp: ts,
			signature,
		},
	}
}

export function syncChatBadgePreCheck(body: any): { ok: true; payload: any } | { ok: false; error: string; status: number } {
	const eoa = String(body?.eoa || '').trim()
	const signature = String(body?.signature || '').trim()
	const unreadRaw = body?.unread
	const unread = typeof unreadRaw === 'number' ? unreadRaw : Number(unreadRaw)
	const ts = parseTimestamp(body?.timestamp)
	if (!ethers.isAddress(eoa) || eoa === ethers.ZeroAddress) return { ok: false, error: 'Invalid eoa', status: 400 }
	if (!Number.isFinite(unread) || unread < 0) return { ok: false, error: 'Invalid unread', status: 400 }
	if (!signature) return { ok: false, error: 'Missing signature', status: 400 }
	if (ts == null || Math.abs(Date.now() - ts) > SIGN_MAX_SKEW_MS) return { ok: false, error: 'Invalid or expired timestamp', status: 400 }
	const checksum = ethers.getAddress(eoa)
	const safeUnread = Math.max(0, Math.min(999, Math.floor(unread)))
	const message = buildSyncBadgeMessage({ eoa: checksum, unread: safeUnread, timestamp: Math.floor(ts / 1000) })
	const messageMs = buildSyncBadgeMessage({ eoa: checksum, unread: safeUnread, timestamp: ts })
	if (!verifyPersonalSign(message, signature, checksum) && !verifyPersonalSign(messageMs, signature, checksum)) {
		return { ok: false, error: 'Invalid signature', status: 403 }
	}
	return { ok: true, payload: { eoa: checksum.toLowerCase(), unread: safeUnread, timestamp: ts, signature } }
}

/**
 * CoNET-SI → API auth (prefer node wallet EIP-191; optional shared secret fallback).
 * SI nodes already hold Guardian node keys — no per-node SI_OFFLINE_PUSH_SECRET required.
 */
export async function notifyOfflineChatPreCheck(
	body: any,
): Promise<{ ok: true; payload: any } | { ok: false; error: string; status: number }> {
	const pgpKeyId = body?.pgpKeyId != null ? String(body.pgpKeyId).trim() : ''
	const eoaRaw = body?.eoa != null ? String(body.eoa).trim() : ''
	if (!pgpKeyId && !eoaRaw) return { ok: false, error: 'Missing pgpKeyId or eoa', status: 400 }
	if (eoaRaw && (!ethers.isAddress(eoaRaw) || eoaRaw === ethers.ZeroAddress)) {
		return { ok: false, error: 'Invalid eoa', status: 400 }
	}
	const eoaNorm = eoaRaw ? ethers.getAddress(eoaRaw).toLowerCase() : ''
	const signature = String(body?.signature || '').trim()
	const secret = String(body?.secret || '').trim()
	const expectedSecret = siOfflinePushSecret()

	if (signature) {
		const ts = parseTimestamp(body?.timestamp)
		if (ts == null || Math.abs(Date.now() - ts) > SIGN_MAX_SKEW_MS) {
			return { ok: false, error: 'Invalid or expired timestamp', status: 400 }
		}
		const tsSec = Math.floor(ts / 1000)
		const msgSec = buildNotifyOfflineChatMessage({
			pgpKeyId,
			eoa: eoaNorm || ethers.ZeroAddress,
			timestamp: tsSec,
		})
		const msgMs = buildNotifyOfflineChatMessage({
			pgpKeyId,
			eoa: eoaNorm || ethers.ZeroAddress,
			timestamp: ts,
		})
		let recovered = ''
		try {
			recovered = ethers.verifyMessage(msgSec, signature)
		} catch {
			try {
				recovered = ethers.verifyMessage(msgMs, signature)
			} catch {
				return { ok: false, error: 'Invalid signature', status: 403 }
			}
		}
		const okNode = await isRegisteredGuardianNodeWallet(recovered)
		if (!okNode) return { ok: false, error: 'Signer is not a registered Guardian node', status: 403 }
		return {
			ok: true,
			payload: {
				pgpKeyId: pgpKeyId || undefined,
				eoa: eoaNorm || undefined,
				nodeWallet: recovered.toLowerCase(),
			},
		}
	}

	// Optional fallback for ops / legacy — not required on SI nodes
	if (expectedSecret && secret && secret === expectedSecret) {
		return {
			ok: true,
			payload: {
				pgpKeyId: pgpKeyId || undefined,
				eoa: eoaNorm || undefined,
			},
		}
	}

	if (!signature && !expectedSecret) {
		return { ok: false, error: 'Missing node signature (SI must sign with Guardian node wallet)', status: 401 }
	}
	return { ok: false, error: 'Unauthorized', status: 403 }
}

export async function registerPushDeviceProcess(payload: {
	eoa: string
	deviceToken: string
	platform: string
	bundleId: string
	pgpKeyId?: string
}): Promise<{ success: true }> {
	await upsertPushDevice(payload)
	return { success: true }
}

/**
 * PWA foreground sync: persist unread only — do **not** APNs alert.
 * Icon badge while the shell is open comes from native bridge (`setAppState`).
 * Offline mailbox SI still uses `notifyOfflineChat` → alert+badge.
 */
export async function syncChatBadgeProcess(payload: { eoa: string; unread: number }): Promise<{ success: true; unread: number }> {
	const unread = await setPushUnread(payload.eoa, payload.unread)
	return { success: true, unread }
}

const recentNotifyKeys = new Map<string, number>()

export async function notifyOfflineChatProcess(payload: {
	pgpKeyId?: string
	eoa?: string
}): Promise<{ success: true; eoa?: string; unread?: number; skipped?: string }> {
	let eoa = payload.eoa
	if (!eoa && payload.pgpKeyId) {
		// Master may receive eoa already resolved by SI; if only pgpKeyId, skip chain resolve here
		// SI is expected to send eoa when possible.
		return { success: true, skipped: 'missing_eoa' }
	}
	if (!eoa) return { success: true, skipped: 'missing_eoa' }

	const dedupKey = `${eoa}:${payload.pgpKeyId || ''}`
	const now = Date.now()
	const last = recentNotifyKeys.get(dedupKey) || 0
	if (now - last < NOTIFY_DEDUP_MS) {
		logger(Colors.gray(`[notifyOfflineChat] dedup ${NOTIFY_DEDUP_MS}ms eoa=${eoa}`))
		return { success: true, eoa, skipped: 'dedup' }
	}
	recentNotifyKeys.set(dedupKey, now)
	if (recentNotifyKeys.size > 5000) {
		for (const [k, t] of recentNotifyKeys) {
			if (now - t > NOTIFY_DEDUP_MS * 2) recentNotifyKeys.delete(k)
		}
	}

	const unread = await incrementPushUnread(eoa, 1)
	void pushBadgeToEoa(eoa, unread).catch((e) =>
		logger(Colors.yellow(`[notifyOfflineChat] APNs: ${(e as Error)?.message ?? e}`)),
	)
	return { success: true, eoa, unread }
}

/** Express helpers for Master (assume Cluster already validated). */
export async function handleRegisterPushDeviceMaster(req: Request, res: Response): Promise<void> {
	try {
		const body = req.body || {}
		await registerPushDeviceProcess({
			eoa: String(body.eoa),
			deviceToken: String(body.deviceToken),
			platform: String(body.platform || 'ios'),
			bundleId: String(body.bundleId || 'com.beamio.beamio'),
			pgpKeyId: body.pgpKeyId ? String(body.pgpKeyId) : undefined,
		})
		res.status(200).json({ success: true }).end()
	} catch (e: any) {
		logger(Colors.red(`[registerPushDevice] ${e?.message ?? e}`))
		res.status(500).json({ success: false, error: 'Internal error' }).end()
	}
}

export async function handleSyncChatBadgeMaster(req: Request, res: Response): Promise<void> {
	try {
		const body = req.body || {}
		const out = await syncChatBadgeProcess({
			eoa: String(body.eoa),
			unread: Number(body.unread),
		})
		res.status(200).json(out).end()
	} catch (e: any) {
		logger(Colors.red(`[syncChatBadge] ${e?.message ?? e}`))
		res.status(500).json({ success: false, error: 'Internal error' }).end()
	}
}

export async function handleNotifyOfflineChatMaster(req: Request, res: Response): Promise<void> {
	try {
		const body = req.body || {}
		const out = await notifyOfflineChatProcess({
			pgpKeyId: body.pgpKeyId ? String(body.pgpKeyId) : undefined,
			eoa: body.eoa ? String(body.eoa) : undefined,
		})
		res.status(200).json(out).end()
	} catch (e: any) {
		logger(Colors.red(`[notifyOfflineChat] ${e?.message ?? e}`))
		res.status(500).json({ success: false, error: 'Internal error' }).end()
	}
}

export const offlineChatPushSignHelpers = {
	buildRegisterMessage,
	buildSyncBadgeMessage,
}
