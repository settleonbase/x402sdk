/**
 * Stop chat pointer writes without returning them to the legacy master.json pool.
 *
 * Clearing WALLET_SIGNER_FEATURES is not this gate. That still selects the legacy route.
 * The only stop is WALLET_SIGNER_CHAT_WRITES=stopped.
 *
 * A remote token stays until the signature is confirmed (receipt status 1).
 * Unconfirmed and abandoned are not a safe settlement, and the legacy pool must not resend that pointer nonce.
 * Those unsettled rows are written to WALLET_SIGNER_CHAT_TOKEN_LEDGER before the remote send,
 * and reloaded after process restart. There is no silent tmpdir default.
 * The ledger path comes only from that environment variable.
 * Unset, blank, or the old default filename inside the temp directory refuses the remote chat write.
 *
 * A missing or empty ledger is an empty set. An older record is never treated as confirmed.
 * A corrupt ledger fail-closes legacy resend. A failed write does not replace an existing file.
 * Writes take an exclusive lock and merge the on-disk rows so two processes cannot drop each other.
 * Reads do not consult this gate.
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const CHAT_WRITES_STOP_VALUE = 'stopped'

/** Ledger of unsettled remote chat signatures. Not the operator key file. */
export const CHAT_TOKEN_LEDGER_ENV = 'WALLET_SIGNER_CHAT_TOKEN_LEDGER'

/** Old implicit filename. A path with this name inside the temp directory is not a configured ledger. */
export const CHAT_TOKEN_LEDGER_DEFAULT_NAME = 'beamio-chat-remote-token-ledger.json'

/** Old settle admin array. The first chat batch must not inherit this name. */
export const CHAT_RELAY_FORBIDDEN_DEFAULT_ARRAY = 'settle_contractAdmin'

export type ChatPointerSettlement = 'not-sent' | 'unconfirmed' | 'abandoned' | 'confirmed'

export type RemoteChatTokenDecision = {
	releaseToken: boolean
	retainToken: boolean
	legacyMayResend: boolean
}

export type RetainedRemoteChatToken = {
	idempotencyKey: string
	owner: string
	pointerNonce: string
	phase: 'unconfirmed' | 'abandoned'
}

const retained = new Map<string, RetainedRemoteChatToken>()
/** Non-empty ledger that could not be parsed. Blocks every legacy resend. */
let ledgerFailClosed = false
let loadedFor: string | undefined

const CHAT_KEY_RE = /^chat:(0x[0-9a-fA-F]{40}):(\d+)$/

/**
 * Null when the caller did not configure a durable ledger.
 * Unset, blank, the temp directory itself, and the old default file inside the temp directory are refused.
 * An explicit test file under a temp subdirectory is allowed.
 */
export function chatTokenLedgerRefusal(env: NodeJS.ProcessEnv = process.env): 'chat_token_ledger_unconfigured' | null {
	const configured = env[CHAT_TOKEN_LEDGER_ENV]?.trim() ?? ''
	if (!configured) return 'chat_token_ledger_unconfigured'
	const resolved = resolve(configured)
	const temp = resolve(tmpdir())
	if (resolved === temp || resolved === join(temp, CHAT_TOKEN_LEDGER_DEFAULT_NAME)) {
		return 'chat_token_ledger_unconfigured'
	}
	return null
}

export function chatTokenLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
	if (chatTokenLedgerRefusal(env)) {
		throw new Error('chat_token_ledger_unconfigured')
	}
	const configured = env[CHAT_TOKEN_LEDGER_ENV]!.trim()
	return isAbsolute(configured) ? configured : resolve(configured)
}

/** True only for the exact stop value. Empty, "off", and a cleared feature list are not a stop. */
export function chatWritesStopped(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.WALLET_SIGNER_CHAT_WRITES ?? '').trim() === CHAT_WRITES_STOP_VALUE
}

/** Pointer reads stay available while writes are stopped. */
export function chatPointerReadsOpen(): boolean {
	return true
}

/**
 * Explicit chat key array. Missing, blank, settle_contractAdmin, and the settle alias are refused.
 * Refusal is not a legacy fallback.
 */
export function explicitChatRelayArray(env: NodeJS.ProcessEnv = process.env): string | null {
	const name = env.WALLET_SIGNER_CHAT_ARRAY?.trim() ?? ''
	if (!name) return null
	const forbidden = new Set<string>([CHAT_RELAY_FORBIDDEN_DEFAULT_ARRAY.toLowerCase()])
	const alias = env.WALLET_SIGNER_SETTLE_ARRAY?.trim()
	if (alias) forbidden.add(alias.toLowerCase())
	if (forbidden.has(name.toLowerCase())) return null
	return name
}

/** Confirmed receipt may drop the token. Anything still in flight must keep it. */
export function decideRemoteChatToken(settlement: ChatPointerSettlement): RemoteChatTokenDecision {
	if (settlement === 'confirmed') {
		return { releaseToken: true, retainToken: false, legacyMayResend: false }
	}
	if (settlement === 'not-sent') {
		return { releaseToken: true, retainToken: false, legacyMayResend: true }
	}
	return { releaseToken: false, retainToken: true, legacyMayResend: false }
}

export function retainRemoteChatToken(token: RetainedRemoteChatToken): void {
	const row = normalizeRetained(token)
	if (!row) return
	if (chatTokenLedgerRefusal()) throw new Error('chat_token_ledger_unconfigured')
	withLedgerLock(() => {
		const disk = readLedger(chatTokenLedgerPath())
		if (disk.failClosed) {
			ledgerFailClosed = true
			loadedFor = chatTokenLedgerPath()
			throw new Error('chat_token_ledger_corrupt')
		}
		const merged = new Map<string, RetainedRemoteChatToken>()
		for (const item of disk.tokens) merged.set(item.idempotencyKey, item)
		merged.set(row.idempotencyKey, row)
		writeLedgerBody(merged)
		replaceMemory(merged, false)
	})
}

/**
 * Drop the retained record only after a confirmed settlement (receipt status 1).
 * The row is removed from the ledger. Restart then no longer blocks that nonce.
 */
export function releaseRemoteChatToken(idempotencyKey: string): void {
	if (chatTokenLedgerRefusal()) throw new Error('chat_token_ledger_unconfigured')
	withLedgerLock(() => {
		const disk = readLedger(chatTokenLedgerPath())
		if (disk.failClosed) {
			ledgerFailClosed = true
			loadedFor = chatTokenLedgerPath()
			throw new Error('chat_token_ledger_corrupt')
		}
		const merged = new Map<string, RetainedRemoteChatToken>()
		for (const item of disk.tokens) merged.set(item.idempotencyKey, item)
		if (!merged.has(idempotencyKey)) {
			replaceMemory(merged, false)
			return
		}
		merged.delete(idempotencyKey)
		writeLedgerBody(merged)
		replaceMemory(merged, false)
	})
}

export function retainedRemoteChatToken(idempotencyKey: string): RetainedRemoteChatToken | undefined {
	ensureLedgerLoaded()
	const row = retained.get(idempotencyKey)
	return row ? { ...row } : undefined
}

export function retainedRemoteChatTokens(): RetainedRemoteChatToken[] {
	ensureLedgerLoaded()
	return [...retained.values()].map((row) => ({ ...row }))
}

/** Legacy settle pool must not resend a pointer nonce whose remote signature is still unreconciled. */
export function legacyPoolMayResendChatNonce(owner: string, pointerNonce: string): boolean {
	ensureLedgerLoaded()
	if (ledgerFailClosed) return false
	const ownerKey = owner.toLowerCase()
	const nonce = String(pointerNonce)
	for (const row of retained.values()) {
		if (row.owner.toLowerCase() === ownerKey && row.pointerNonce === nonce) return false
		const parsed = splitChatKey(row.idempotencyKey)
		if (parsed && parsed.owner === ownerKey && parsed.nonce === nonce) return false
	}
	return true
}

/** Same block, addressed by the chat idempotency key. */
export function legacyPoolMayResendChatIdempotency(idempotencyKey: string): boolean {
	ensureLedgerLoaded()
	if (ledgerFailClosed) return false
	if (retained.has(idempotencyKey)) return false
	const parsed = splitChatKey(idempotencyKey)
	if (!parsed) return true
	return legacyPoolMayResendChatNonce(parsed.owner, parsed.nonce)
}

/**
 * Forget in-process state and read the ledger again.
 * Tests use this as a process restart. Production loads the same file on first use.
 */
export function reloadChatRemoteTokenLedger(): void {
	loadedFor = undefined
	retained.clear()
	ledgerFailClosed = false
	ensureLedgerLoaded()
}

export function resetChatWriteStopForTests(): void {
	retained.clear()
	ledgerFailClosed = false
	if (chatTokenLedgerRefusal()) {
		loadedFor = undefined
		return
	}
	withLedgerLock(() => {
		writeLedgerBody(new Map())
		replaceMemory(new Map(), false)
	})
}

function replaceMemory(tokens: Map<string, RetainedRemoteChatToken>, failClosed: boolean): void {
	retained.clear()
	for (const row of tokens.values()) retained.set(row.idempotencyKey, row)
	ledgerFailClosed = failClosed
	loadedFor = chatTokenLedgerRefusal() ? undefined : chatTokenLedgerPath()
}

function ensureLedgerLoaded(): void {
	if (chatTokenLedgerRefusal()) {
		if (loadedFor === '') return
		retained.clear()
		ledgerFailClosed = false
		loadedFor = ''
		return
	}
	const path = chatTokenLedgerPath()
	if (loadedFor === path) return
	retained.clear()
	ledgerFailClosed = false
	const loaded = readLedger(path)
	ledgerFailClosed = loaded.failClosed
	for (const row of loaded.tokens) retained.set(row.idempotencyKey, row)
	loadedFor = path
}

const LOCK_WAIT_MS = 5_000
const LOCK_STALE_MS = 30_000

function withLedgerLock<T>(fn: () => T): T {
	const path = chatTokenLedgerPath()
	const lock = `${path}.lock`
	mkdirSync(dirname(path), { recursive: true })
	const started = Date.now()
	let fd: number | undefined
	for (;;) {
		try {
			fd = openSync(lock, 'wx', 0o600)
			break
		} catch (err) {
			const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
			if (code !== 'EEXIST') throw new Error(`chat_token_ledger_persist_failed: ${errorText(err)}`)
			try {
				const age = Date.now() - statSync(lock).mtimeMs
				if (age > LOCK_STALE_MS) unlinkSync(lock)
			} catch {
				/* another writer removed or replaced the lock */
			}
			if (Date.now() - started > LOCK_WAIT_MS) throw new Error('chat_token_ledger_persist_failed: lock timeout')
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
		}
	}
	try {
		return fn()
	} finally {
		if (fd !== undefined) closeSync(fd)
		try { unlinkSync(lock) } catch { /* released by the owner */ }
	}
}

function readLedger(path: string): { tokens: RetainedRemoteChatToken[]; failClosed: boolean } {
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch (err) {
		const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
		if (code === 'ENOENT') return { tokens: [], failClosed: false }
		return { tokens: [], failClosed: true }
	}
	if (!text.trim()) return { tokens: [], failClosed: false }
	return parseLedgerText(text)
}

/**
 * v1 is `{ v: 1, tokens: [...] }`. Older shapes stay blocking records.
 * `phase: confirmed` / `settled` in an old record does not release the nonce.
 * Only a missing row (deleted after receipt status 1) is settled.
 */
function parseLedgerText(text: string): { tokens: RetainedRemoteChatToken[]; failClosed: boolean } {
	const trimmed = text.trim()
	if (!trimmed) return { tokens: [], failClosed: false }
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed) as unknown
	} catch {
		return parseNdjson(text)
	}
	if (parsed == null) return { tokens: [], failClosed: true }
	if (Array.isArray(parsed)) return { tokens: collectRecords(parsed), failClosed: false }
	if (typeof parsed === 'object') {
		const obj = parsed as Record<string, unknown>
		if (Array.isArray(obj.tokens)) return { tokens: collectRecords(obj.tokens), failClosed: false }
		if (Array.isArray(obj.records)) return { tokens: collectRecords(obj.records), failClosed: false }
		if (obj.owner || obj.pointerNonce || obj.nonce || obj.idempotencyKey || obj.idempotency || obj.key) {
			return { tokens: coerceRecord(obj), failClosed: false }
		}
		const fromMap: RetainedRemoteChatToken[] = []
		let sawIdentity = false
		for (const [key, value] of Object.entries(obj)) {
			if (key === 'v' || key === 'version') continue
			sawIdentity = true
			if (value && typeof value === 'object') fromMap.push(...coerceRecord(value, key))
			else if (typeof value === 'string') fromMap.push(...coerceRecord({ idempotencyKey: key, phase: value }, key))
			else fromMap.push(...coerceRecord(key))
		}
		if (fromMap.length > 0) return { tokens: fromMap, failClosed: false }
		if (!sawIdentity && (obj.v === 1 || obj.version === 1)) return { tokens: [], failClosed: false }
		if (!sawIdentity && Object.keys(obj).length === 0) return { tokens: [], failClosed: false }
		return { tokens: [], failClosed: true }
	}
	return { tokens: [], failClosed: true }
}

function parseNdjson(text: string): { tokens: RetainedRemoteChatToken[]; failClosed: boolean } {
	const out: RetainedRemoteChatToken[] = []
	let broken = false
	let any = false
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		any = true
		try {
			out.push(...coerceRecord(JSON.parse(line) as unknown))
		} catch {
			broken = true
		}
	}
	if (!any) return { tokens: [], failClosed: false }
	if (broken) return { tokens: out, failClosed: true }
	return { tokens: out, failClosed: false }
}

function collectRecords(rows: unknown[]): RetainedRemoteChatToken[] {
	const out: RetainedRemoteChatToken[] = []
	for (const row of rows) out.push(...coerceRecord(row))
	return out
}

/**
 * Identity is enough to block. An old confirmed/settled/mined flag is not a release.
 * Rows with no owner, nonce, or idempotency key are skipped.
 */
function coerceRecord(raw: unknown, keyHint?: string): RetainedRemoteChatToken[] {
	if (typeof raw === 'string') {
		const parsed = splitChatKey(raw)
		if (!parsed && !raw.startsWith('chat:')) return []
		return [{
			idempotencyKey: raw,
			owner: parsed?.owner ?? '',
			pointerNonce: parsed?.nonce ?? '',
			phase: 'unconfirmed',
		}]
	}
	if (!raw || typeof raw !== 'object') return []
	const row = raw as Record<string, unknown>
	const hinted = keyHint ?? ''
	const idem = stringField(row.idempotencyKey) || stringField(row.idempotency) || stringField(row.key) || hinted
	let owner = stringField(row.owner)
	let nonce = stringField(row.pointerNonce) || stringField(row.nonce)
	const fromKey = splitChatKey(idem)
	if (!owner && fromKey) owner = fromKey.owner
	if (!nonce && fromKey) nonce = fromKey.nonce
	if (!idem && !(owner && nonce)) return []
	const idempotencyKey = idem || `chat:${owner.toLowerCase()}:${nonce}`
	return [{
		idempotencyKey,
		owner: owner.toLowerCase(),
		pointerNonce: nonce,
		phase: oldPhase(row),
	}]
}

function oldPhase(row: Record<string, unknown>): 'unconfirmed' | 'abandoned' {
	const label = stringField(row.phase) || stringField(row.status) || stringField(row.settlement)
	if (label === 'abandoned') return 'abandoned'
	return 'unconfirmed'
}

function normalizeRetained(token: RetainedRemoteChatToken): RetainedRemoteChatToken | undefined {
	return coerceRecord(token)[0]
}

function splitChatKey(key: string): { owner: string; nonce: string } | null {
	const match = CHAT_KEY_RE.exec(key)
	if (!match) return null
	return { owner: match[1]!.toLowerCase(), nonce: match[2]! }
}

function stringField(value: unknown): string {
	if (typeof value === 'string') return value.trim()
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	return ''
}

function writeLedgerBody(tokens: Map<string, RetainedRemoteChatToken>): void {
	const path = chatTokenLedgerPath()
	const body = `${JSON.stringify({ v: 1, tokens: [...tokens.values()] })}\n`
	const tmp = `${path}.tmp.${process.pid}`
	let fd: number | undefined
	try {
		fd = openSync(tmp, 'w', 0o600)
		writeFileSync(fd, body)
		fsyncSync(fd)
	} catch (err) {
		if (fd !== undefined) closeSync(fd)
		try { unlinkSync(tmp) } catch { /* nothing was published */ }
		throw new Error(`chat_token_ledger_persist_failed: ${errorText(err)}`)
	}
	closeSync(fd)
	try {
		renameSync(tmp, path)
		chmodSync(path, 0o600)
	} catch (err) {
		try { unlinkSync(tmp) } catch { /* rename failed before publish */ }
		throw new Error(`chat_token_ledger_persist_failed: ${errorText(err)}`)
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
