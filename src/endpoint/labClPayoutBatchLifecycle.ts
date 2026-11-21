/**
 * Lab CL payout: durable lifecycle of one withdrawNative batch (B-2 in-flight, B-3 fail-closed).
 *
 * Rules:
 *  1. Write-ahead. The batch record (eventKeys, amount, pool, idempotencyKey) is persisted BEFORE the
 *     signer is asked to send. If that persist fails, nothing is sent.
 *  2. No recomposition while unresolved. While a record is in flight, no new batch is composed.
 *     A receipt timeout keeps the record. The next tick retries the SAME request (same eventKeys, same
 *     idempotencyKey). The signer journal returns the original hash, or sends the identical request.
 *  3. Settle only on a confirmed receipt. A receipt with status 0 releases the record (nothing was paid).
 *     A status 1 receipt marks the eventKeys consumed and drops the record.
 *  4. Fail closed. A persist failure trips the gate (LabPayoutFailClosedGate). A tripped gate blocks every send.
 *
 * Node built-ins, ethers (via labMiningPoolPayoutSigner) only. No WebSocket. No I/O of its own: the
 * caller supplies persist, send, receipt and settle through LabLifecycleDeps, so the same code is tested
 * without a chain.
 */
import { ethers } from 'ethers'
import type { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import {
	assertFixedLabMiningPool,
	labWithdrawFingerprint,
	labWithdrawIdempotencyKey,
} from './labMiningPoolPayoutSigner'

export type LabWithdrawLine = 'realtime' | 'history'

/** The durable record of a withdrawNative batch that has been composed but not yet settled. */
export type LabInFlightWithdraw = {
	line: LabWithdrawLine
	redeem: string
	pool: string
	amountWei: string
	/** Lowercase, sorted. */
	eventKeys: string[]
	requestFingerprint: string
	idempotencyKey: string
	createdAt: string
	/** Set once the signer returned a broadcast hash. */
	hash?: string
}

export type LabBatchRequest = {
	redeem: string
	pool: string
	amount: bigint
	eventKeys: string[]
	line: LabWithdrawLine
}

/** Which durable step the lifecycle is at (the WAL event label of the persist). A failure of any of them is B-2 fail-closed: nothing is sent after it. */
export type LabPersistStep = 'intent' | 'hash' | 'settle' | 'release'

export type LabLifecycleDeps = {
	/** Optional. Called inside the same durable write as the consumed set (before 'persist settled batch'). */
	countSettled?: () => void
	/** Optional. True when a new send must not happen (one-shot limit reached). Checked before every send. */
	stopBeforeSend?: () => boolean
	/** Optional. Persists nothing itself; stops the daemon with an exit code. Used for receipt status 0 and unknown receipts. */
	halt?: (code: number, reason: string) => void
	gate: LabPayoutFailClosedGate
	getInFlight: () => LabInFlightWithdraw | null
	setInFlight: (v: LabInFlightWithdraw | null) => void
	/** Persist the whole state. Throws on failure. */
	persist: (step: LabPersistStep) => void | Promise<void>
	/**
	 * Ask the signer to send the record. Recover-first: the signer returns the original hash when its
	 * journal already holds this idempotencyKey. Throws when no hash is obtained.
	 */
	send: (rec: LabInFlightWithdraw) => Promise<{ hash: string }>
	/** Receipt status, or null while it is not yet available (timeout). */
	waitReceipt: (hash: string) => Promise<{ status: number } | null>
	/** In-memory only: mark the eventKeys consumed and drop them from pending. Caller persists after. */
	settle: (eventKeys: string[]) => void
	/**
	 * Round-5 F1: read and confirm the bound signer address. Called before the intent is persisted, on every new
	 * composition, with no process-level cache. Throws to refuse. The refusal leaves nothing persisted and sends nothing.
	 */
	confirmBeforeSend: () => Promise<void>
	log: (line: string) => void
}

export type LabLifecycleOutcome = 'none' | 'pending' | 'settled' | 'reverted' | 'refused' | 'stopped'

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

/**
 * Thrown by deps.send when the daemon itself refuses before anything reaches the signer (round-4 F1: the bound
 * address is not confirmed). Nothing was broadcast, so the record is released and no attempt is consumed.
 * Any other send error is an unknown outcome and holds the record.
 */
export class LabRefusedBeforeBroadcast extends Error {}

/** Equal as multisets of lowercase keys. Used to check that the settled keys are the batch's keys. */
export function sameEventKeys(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false
	const x = a.map((k) => k.toLowerCase()).sort()
	const y = b.map((k) => k.toLowerCase()).sort()
	for (let i = 0; i < x.length; i++) {
		if (x[i] !== y[i]) return false
	}
	return true
}

/** Build the durable record. Uses the same fingerprint and key as the signer request. */
export function buildLabInFlightWithdraw(req: LabBatchRequest, now: Date): LabInFlightWithdraw {
	const pool = assertFixedLabMiningPool(req.pool)
	const redeem = ethers.getAddress(req.redeem)
	const eventKeys = [...req.eventKeys].map((k) => k.toLowerCase()).sort()
	if (!eventKeys.length) throw new Error('withdrawNative batch has no eventKeys')
	if (req.amount <= 0n) throw new Error('withdrawNative batch amount must be > 0')
	const requestFingerprint = labWithdrawFingerprint({ redeem, pool, amount: req.amount, eventKeys })
	return {
		line: req.line,
		redeem,
		pool,
		amountWei: req.amount.toString(),
		eventKeys,
		requestFingerprint,
		idempotencyKey: labWithdrawIdempotencyKey(requestFingerprint),
		createdAt: now.toISOString(),
	}
}

async function persistOrTrip(deps: LabLifecycleDeps, where: string, step: LabPersistStep): Promise<void> {
	try {
		await deps.persist(step)
	} catch (e) {
		deps.gate.trip(where, e)
		throw e
	}
}

/**
 * Settle or resume the unresolved in-flight record, if any. Never composes a new batch.
 * Returns 'none' when there is no record, 'pending' while the record is unresolved, and
 * 'settled' or 'reverted' when it resolves on this call.
 */
export async function resumeLabWithdrawInFlight(deps: LabLifecycleDeps): Promise<LabLifecycleOutcome> {
	const rec = deps.getInFlight()
	if (!rec) return 'none'
	if (deps.gate.tripped) {
		deps.log(`ALERT in-flight withdrawNative held: fail-closed (${deps.gate.tripReason})`)
		return 'pending'
	}
	let hash = rec.hash
	if (!hash && deps.stopBeforeSend?.()) {
		deps.log('withdrawNative one-shot limit reached: no send (in-flight record kept)')
		return 'stopped'
	}
	if (!hash) {
		let sent: { hash: string }
		try {
			// Round-6 item 3: the bound address is read again immediately before the send. A change refuses the
			// send before broadcast. Nothing has left the daemon yet.
			try {
				await deps.confirmBeforeSend()
			} catch (e) {
				throw new LabRefusedBeforeBroadcast(errMsg(e))
			}
			sent = await deps.send(rec)
		} catch (e) {
			if (e instanceof LabRefusedBeforeBroadcast) {
				deps.setInFlight(null)
				await persistOrTrip(deps, 'persist refused release', 'release')
				deps.log(`ALERT withdrawNative refused before broadcast; nothing sent, record released, entries stay pending: ${errMsg(e)}`)
				return 'refused'
			}
			deps.log(`withdrawNative send unresolved; in-flight batch kept, no new batch (n=${rec.eventKeys.length}): ${errMsg(e)}`)
			return 'pending'
		}
		hash = sent.hash
		rec.hash = hash
		await persistOrTrip(deps, 'persist broadcast hash', 'hash')
	}
	const receipt = await deps.waitReceipt(hash)
	if (receipt === null) {
		deps.log(`withdrawNative receipt not yet available hash=${hash} (n=${rec.eventKeys.length}); in-flight batch kept, no new batch`)
		// Unknown receipt: stop. The record stays persisted; a restart resumes the same hash and never re-sends the key.
		deps.halt?.(4, 'receipt unknown: halted, in-flight record kept, no re-send')
		return 'pending'
	}
	if (receipt.status !== 1) {
		deps.setInFlight(null)
		await persistOrTrip(deps, 'persist reverted release', 'release')
		deps.log(`withdrawNative reverted hash=${hash}; batch released, entries stay pending`)
		// Status 0 is final for this key: stop, do not re-send under the same key without operator review.
		deps.halt?.(3, 'receipt status 0: halted, batch released, no same-key re-send')
		return 'reverted'
	}
	deps.settle(rec.eventKeys)
	deps.setInFlight(null)
	deps.countSettled?.()
	await persistOrTrip(deps, 'persist settled batch', 'settle')
	deps.log(`withdrawNative ok hash=${hash} n=${rec.eventKeys.length}`)
	return 'settled'
}

/**
 * Submit a newly composed batch. If a record is already in flight, the new composition is discarded
 * and the existing record is resumed instead. Throws when the gate is tripped or the intent cannot be
 * persisted (nothing is sent in either case).
 */
export async function submitWithdrawBatchDurably(deps: LabLifecycleDeps, req: LabBatchRequest, now: Date = new Date()): Promise<LabLifecycleOutcome> {
	deps.gate.assertOpen('withdrawNative')
	if (deps.stopBeforeSend?.()) {
		deps.log('withdrawNative one-shot limit reached: no send')
		return 'stopped'
	}
	if (deps.getInFlight()) {
		deps.log('withdrawNative in flight unresolved; a new batch is not composed')
		return resumeLabWithdrawInFlight(deps)
	}
	// Round-5 F1: the bound signer address is read before anything is persisted. A refusal leaves nothing behind.
	try {
		await deps.confirmBeforeSend()
	} catch (e) {
		deps.log(`ALERT withdrawNative refused before intent; bound signer address not confirmed; nothing persisted, nothing sent: ${errMsg(e)}`)
		return 'refused'
	}
	const rec = buildLabInFlightWithdraw(req, now)
	deps.setInFlight(rec)
	try {
		await persistOrTrip(deps, 'persist intent', 'intent')
	} catch (e) {
		deps.setInFlight(null)
		throw e
	}
	return resumeLabWithdrawInFlight(deps)
}
