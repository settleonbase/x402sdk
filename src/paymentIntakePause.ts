/**
 * P-A T2 intake pause (operator decision 2026-11-08): stop new payments on the old paths,
 * keep queues and payment records, reconcile paid orders one by one later.
 *
 * One switch: BEAMIO_PAYMENT_INTAKE_PAUSE=1 (or true / yes / on). Read on every call, so the
 * value set in the unit environment applies after a restart; unset it and restart to roll back.
 *
 * While paused:
 * - new-payment entries return 503 with code PAYMENT_INTAKE_PAUSED before any charge;
 * - callbacks that are already in flight are appended to a JSONL journal on disk and do NOT
 *   trigger a chain write (no mintForUsdcPurchase, no consumeFromUser, no bridge mint);
 * - nothing is deleted: existing queues, fulfil files and DB rows are left as they are.
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import Colors from 'colors/safe'
import { logger } from './logger'

export const PAYMENT_INTAKE_PAUSED_CODE = 'PAYMENT_INTAKE_PAUSED'
export const PAYMENT_INTAKE_PAUSED_MESSAGE = 'Payments are paused for maintenance. No charge was made.'

export function isPaymentIntakePaused(): boolean {
	const v = String(process.env.BEAMIO_PAYMENT_INTAKE_PAUSE ?? '').trim().toLowerCase()
	return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export function paymentIntakePauseJournalFile(): string {
	return (
		process.env.BEAMIO_PAYMENT_INTAKE_PAUSE_JOURNAL?.trim() ||
		path.join(homedir(), '.beamio-payment-intake-paused.jsonl')
	)
}

/** JSON body for a refused new-payment request. */
export function paymentIntakePausedBody(extra?: Record<string, unknown>): Record<string, unknown> {
	return { success: false, code: PAYMENT_INTAKE_PAUSED_CODE, error: PAYMENT_INTAKE_PAUSED_MESSAGE, ...(extra ?? {}) }
}

/**
 * Append one held item to the journal. bigint values are written as strings.
 * A write failure is logged and re-thrown: the caller must not report success if the record
 * could not be kept.
 */
export function recordPausedIntake(kind: string, data: Record<string, unknown>): void {
	const line =
		JSON.stringify(
			{ ts: new Date().toISOString(), pid: process.pid, kind, data },
			(_k, v) => (typeof v === 'bigint' ? v.toString() : v),
		) + '\n'
	const file = paymentIntakePauseJournalFile()
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.appendFileSync(file, line, { encoding: 'utf-8', mode: 0o600 })
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e)
		logger(Colors.red(`[paymentIntakePause] journal write FAILED kind=${kind}: ${msg}`))
		throw e
	}
	logger(Colors.yellow(`[paymentIntakePause] held kind=${kind} (no chain write)`))
}

/**
 * For background B-Unit fee charges (consumeFromUser). Returns true when the caller must skip
 * the chain write; the would-be charge is journaled for later reconciliation.
 */
export function holdBUnitConsumeIfPaused(label: string, data: Record<string, unknown>): boolean {
	if (!isPaymentIntakePaused()) return false
	try {
		recordPausedIntake(`bunitConsume:${label}`, data)
	} catch {
		/* already logged; still skip the chain write */
	}
	return true
}

/**
 * Wrap a BUnitAirdrop write contract before calling consumeFromUser. When paused, the call is
 * journaled (user, amount, sourceHash, kind) and rejected with PAYMENT_INTAKE_PAUSED instead of
 * being sent, so every existing catch / .catch path handles it like a failed fee charge, with
 * no chain write and no gas. When not paused, the contract is returned unchanged.
 */
export function guardBUnitConsume<T>(contract: T, label: string): T {
	if (!isPaymentIntakePaused()) return contract
	const held = {
		consumeFromUser: (user: unknown, amount: unknown, sourceHash: unknown, baseGas: unknown, kind: unknown) => {
			holdBUnitConsumeIfPaused(label, { user, amount, sourceHash, baseGas, kind })
			return Promise.reject(new Error(`${PAYMENT_INTAKE_PAUSED_CODE}: B-Unit fee held, no chain write (${label})`))
		},
	}
	return held as unknown as T
}
