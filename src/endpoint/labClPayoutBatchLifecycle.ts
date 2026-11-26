/**
 * Lab CL payout: durable lifecycle of one withdrawNative batch (B-2 in-flight, B-3 fail-closed).
 *
 * Rules:
 *  1. Write-ahead. The batch record (eventKeys, amount, pool, idempotencyKey) is persisted BEFORE the
 *     signer is asked to send. If that persist fails, nothing is sent.
 *  2. No recomposition or resend while unresolved. Existing intents are read-only reconciled against
 *     the exact signer journal and chain; missing/unknown evidence keeps the record and halts payout.
 *  3. Settle only on a transaction-bound finalized receipt. Reverted records remain held for review.
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
	/** Durable sender-call budget. Missing on historical records means UNKNOWN, never zero. */
	sendAttempts?: number
	/** Set once the signer returned a broadcast hash. */
	hash?: string
}

export type LabSignerJournalLookup =
	| { kind: 'found'; hash: string; idempotencyKey: string; requestFingerprint: string }
	| { kind: 'not-found' }
	| { kind: 'unknown' }

export type LabReceiptVerification =
	| { kind: 'finalized'; status: 0 | 1 }
	| { kind: 'unknown' }

export type LabWithdrawalChainEvidence = {
	transaction: { hash: string; from: string; to: string; data: string; value: string; chainId: number }
	receipt: { transactionHash: string; status: number | null; blockNumber: number; blockHash: string }
	canonicalBlock: { number: number; hash: string }
	finalizedBlock: { number: number; hash: string }
}

const WITHDRAW_NATIVE_IFACE = new ethers.Interface([
	'function withdrawNative(address pool,uint256 amount)',
])

/** Pure verifier for adapter-supplied transaction/receipt/chain anchors; no RPC or I/O. */
export function verifyFinalizedLabWithdrawalEvidence(
	rec: LabInFlightWithdraw,
	evidence: LabWithdrawalChainEvidence,
	expectedFrom: string
): LabReceiptVerification {
	try {
		const { transaction: tx, receipt, canonicalBlock, finalizedBlock } = evidence
		if (
			!/^0x[0-9a-fA-F]{64}$/.test(tx.hash) ||
			!rec.hash || !/^0x[0-9a-fA-F]{64}$/.test(rec.hash) ||
			tx.hash.toLowerCase() !== rec.hash.toLowerCase() ||
			tx.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
			eventHashMismatch(receipt.blockHash) || eventHashMismatch(canonicalBlock.hash) || eventHashMismatch(finalizedBlock.hash) ||
			!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 ||
			!Number.isSafeInteger(canonicalBlock.number) || canonicalBlock.number < 0 ||
			!Number.isSafeInteger(finalizedBlock.number) || finalizedBlock.number < 0 ||
			receipt.blockNumber !== canonicalBlock.number ||
			// Without a bounded ancestry proof adapter, only accept a receipt at the exact finalized anchor.
			finalizedBlock.number !== receipt.blockNumber ||
			receipt.blockHash.toLowerCase() !== canonicalBlock.hash.toLowerCase() ||
			finalizedBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
			tx.chainId !== 224422 ||
			ethers.getAddress(tx.from) !== ethers.getAddress(expectedFrom) ||
			ethers.getAddress(tx.to) !== ethers.getAddress(rec.redeem) ||
			BigInt(tx.value) !== 0n
		) return { kind: 'unknown' }
		const parsed = WITHDRAW_NATIVE_IFACE.parseTransaction({ data: tx.data, value: BigInt(tx.value) })
		if (!parsed || parsed.name !== 'withdrawNative') return { kind: 'unknown' }
		if (
			ethers.getAddress(String(parsed.args[0])) !== ethers.getAddress(rec.pool) ||
			BigInt(parsed.args[1]) !== BigInt(rec.amountWei) ||
			(receipt.status !== 0 && receipt.status !== 1)
		) return { kind: 'unknown' }
		return { kind: 'finalized', status: receipt.status }
	} catch {
		return { kind: 'unknown' }
	}
}

function eventHashMismatch(value: string): boolean {
	return typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)
}

export type LabBatchRequest = {
	redeem: string
	pool: string
	amount: bigint
	eventKeys: string[]
	line: LabWithdrawLine
}

export type LabLifecycleDeps = {
	/** Optional. Called inside the same durable write as the consumed set (before 'persist settled batch'). */
	countSettled?: () => void
	/** Optional. True when a new send must not happen (one-shot limit reached). Checked before every send. */
	stopBeforeSend?: () => boolean
	/** Durable lifetime send budget. Both values must be present and agree with the startup-pinned limit. */
	getSendBudget?: () => { used: number; limit: number; configuredLimit: number } | null
	setSendBudget?: (used: number, limit: number) => void
	/** Optional. Persists nothing itself; stops the daemon with an exit code. Used for receipt status 0 and unknown receipts. */
	halt?: (code: number, reason: string) => void
	gate: LabPayoutFailClosedGate
	getInFlight: () => LabInFlightWithdraw | null
	setInFlight: (v: LabInFlightWithdraw | null) => void
	/** Persist the whole state. Throws on failure. */
	persist: () => void
	/**
	 * Ask the signer to send the record. Recover-first: the signer returns the original hash when its
	 * journal already holds this idempotencyKey. Throws when no hash is obtained.
	 */
	send: (rec: LabInFlightWithdraw) => Promise<{ hash: string; idempotencyKey: string; requestFingerprint: string }>
	/** Read-only lookup by the exact idempotency key; absence/error never authorizes a resend. */
	lookupSignerJournal?: (rec: LabInFlightWithdraw) => Promise<LabSignerJournalLookup>
	/** Only a transaction+receipt verified against this record and finalized on the same chain may settle. */
	waitReceipt: (hash: string, rec: LabInFlightWithdraw) => Promise<LabReceiptVerification>
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
 * Thrown by the pre-send address check before an intent is created. This error must never be thrown
 * after entering the signer call, because sender outcome is then unknown and the attempt stays consumed.
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

function persistOrTrip(deps: LabLifecycleDeps, where: string): void {
	try {
		deps.persist()
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
	let expectedFingerprint: string
	try {
		expectedFingerprint = labWithdrawFingerprint({
			redeem: rec.redeem,
			pool: rec.pool,
			amount: BigInt(rec.amountWei),
			eventKeys: rec.eventKeys,
		})
	} catch {
		deps.log('ALERT in-flight withdrawNative fields invalid; record kept, no send or settle')
		return 'pending'
	}
	const expectedIdempotencyKey = labWithdrawIdempotencyKey(expectedFingerprint)
	if (rec.requestFingerprint !== expectedFingerprint || rec.idempotencyKey !== expectedIdempotencyKey) {
		deps.log('ALERT in-flight withdrawNative identity invalid; record kept, no send or settle')
		return 'pending'
	}
	const lookup = deps.lookupSignerJournal
		? await deps.lookupSignerJournal(rec).catch((): LabSignerJournalLookup => ({ kind: 'unknown' }))
		: { kind: 'unknown' as const }
	if (
		lookup.kind !== 'found' ||
		lookup.idempotencyKey !== expectedIdempotencyKey ||
		lookup.requestFingerprint !== expectedFingerprint ||
		!/^0x[0-9a-fA-F]{64}$/.test(lookup.hash)
	) {
		deps.log(`withdrawNative journal ${lookup.kind}; in-flight record kept, no resend or release`)
		deps.halt?.(4, 'signer journal unresolved: record kept, no resend')
		return 'pending'
	}
	if (rec.hash && rec.hash.toLowerCase() !== lookup.hash.toLowerCase()) {
		deps.log('ALERT signer journal hash differs from persisted in-flight hash; record kept')
		deps.halt?.(4, 'signer journal hash mismatch: record kept')
		return 'pending'
	}
	const hash = lookup.hash
	if (!rec.hash) {
		rec.hash = hash
		persistOrTrip(deps, 'persist recovered journal hash')
	}
	const receipt = await deps.waitReceipt(hash, rec).catch((): LabReceiptVerification => ({ kind: 'unknown' }))
	if (receipt.kind === 'unknown') {
		deps.log(`withdrawNative transaction/receipt/finality unknown hash=${hash} (n=${rec.eventKeys.length}); in-flight record kept`)
		deps.halt?.(4, 'receipt or finality unknown: record kept, no resend')
		return 'pending'
	}
	if (receipt.status !== 1) {
		deps.log(`withdrawNative finalized reverted hash=${hash}; in-flight record retained for operator review`)
		deps.halt?.(3, 'finalized receipt status 0: record retained, no same-key retry')
		return 'reverted'
	}
	deps.settle(rec.eventKeys)
	deps.setInFlight(null)
	deps.countSettled?.()
	persistOrTrip(deps, 'persist settled batch')
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
	const budget = deps.getSendBudget?.() ?? null
	if (
		!budget ||
		!Number.isSafeInteger(budget.used) || budget.used < 0 ||
		!Number.isSafeInteger(budget.limit) || budget.limit < 1 ||
		budget.configuredLimit !== budget.limit || budget.used >= budget.limit ||
		!deps.setSendBudget
	) {
		deps.log('withdrawNative total send budget missing, invalid, changed, or exhausted: no send')
		return 'stopped'
	}
	// Round-5 F1: the bound signer address is read before anything is persisted. A refusal leaves nothing behind.
	try {
		await deps.confirmBeforeSend()
	} catch (e) {
		deps.log(`ALERT withdrawNative refused before intent; bound signer address not confirmed; nothing persisted, nothing sent: ${errMsg(e)}`)
		return 'refused'
	}
	const rec = buildLabInFlightWithdraw(req, now)
	rec.sendAttempts = 0
	deps.setInFlight(rec)
	try {
		persistOrTrip(deps, 'persist intent')
	} catch (e) {
		deps.setInFlight(null)
		throw e
	}
	// Reconfirm the address after the durable intent exists, but before consuming the sender-call budget.
	try {
		await deps.confirmBeforeSend()
	} catch (e) {
		deps.setInFlight(null)
		persistOrTrip(deps, 'persist pre-send refusal release')
		deps.log(`ALERT withdrawNative refused before sender call; entries stay pending: ${errMsg(e)}`)
		return 'refused'
	}
	// Recheck after the async address confirmation. The lane is serialized, and this synchronous
	// compare-and-consume plus persist is the final gate immediately before the signer call.
	const currentBudget = deps.getSendBudget?.() ?? null
	if (
		!currentBudget ||
		currentBudget.used !== budget.used ||
		currentBudget.limit !== budget.limit ||
		currentBudget.configuredLimit !== currentBudget.limit ||
		currentBudget.used >= currentBudget.limit ||
		deps.stopBeforeSend?.()
	) {
		deps.log('withdrawNative total send budget changed or stopped before consumption: intent held, no send')
		return 'stopped'
	}
	// Consume both the per-intent and lifetime budgets in one durable write before entering the signer.
	rec.sendAttempts = 1
	deps.setSendBudget!(currentBudget.used + 1, currentBudget.limit)
	persistOrTrip(deps, 'persist sender attempt')
	let sent: { hash: string; idempotencyKey: string; requestFingerprint: string }
	try {
		sent = await deps.send(rec)
	} catch (e) {
		deps.log(`withdrawNative sender outcome unknown; attempt remains consumed and record is held: ${errMsg(e)}`)
		deps.halt?.(4, 'sender outcome unknown: durable attempt retained, no resend')
		return 'pending'
	}
	if (
		sent.idempotencyKey !== rec.idempotencyKey ||
		sent.requestFingerprint !== rec.requestFingerprint ||
		!/^0x[0-9a-fA-F]{64}$/.test(sent.hash)
	) {
		deps.log('ALERT withdrawNative sender response identity invalid; durable attempt retained')
		deps.halt?.(4, 'sender response identity unknown: record retained')
		return 'pending'
	}
	rec.hash = sent.hash
	persistOrTrip(deps, 'persist broadcast hash')
	return resumeLabWithdrawInFlight(deps)
}
