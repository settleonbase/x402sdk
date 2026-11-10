import { CONET_CHAIN_ID, BEAMIO_ORACLE } from './constants'
import { acquireQuoteLock } from './lock'
import { buildOracleTx, type OracleTx, type TargetInput } from './plan'
import { readQuoteDocument } from './quoteSource'
import { QuoteRefusal, SignerCallError } from './refusal'

export type QuoteSender = (tx: OracleTx) => Promise<{ hash: string }>

export type RunOutcome =
	| { ok: true; sent: true; hash: string }
	| { ok: false; sent: false; reason: string; message?: string; code?: number }

export type RunOnceInput = {
	document: unknown
	nowMs: number
	lockPath: string
	send: QuoteSender
	target?: TargetInput
}

/**
 * One quote attempt. Overlap, a stale source, Base, and a signer refusal all
 * leave `ok` false. The signer function is not called again after it rejects.
 */
export async function runOnce(input: RunOnceInput): Promise<RunOutcome> {
	const lock = acquireQuoteLock(input.lockPath)
	if (!lock.acquired) {
		return { ok: false, sent: false, reason: 'overlap', message: 'previous quote still running' }
	}
	try {
		const quote = readQuoteDocument(input.document, input.nowMs)
		const tx = buildOracleTx(input.target ? { ...quote } : quote, input.target ?? {
			chainId: CONET_CHAIN_ID,
			to: BEAMIO_ORACLE,
			value: 0n,
		})
		const result = await input.send(tx)
		if (!result || typeof result.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.hash)) {
			return { ok: false, sent: false, reason: 'signer', message: 'response had no transaction hash' }
		}
		return { ok: true, sent: true, hash: result.hash }
	} catch (e) {
		if (e instanceof QuoteRefusal) {
			return { ok: false, sent: false, reason: e.reason, message: e.message }
		}
		if (e instanceof SignerCallError) {
			return { ok: false, sent: false, reason: 'signer', code: e.code, message: e.message }
		}
		const message = e instanceof Error ? e.message : 'quote failed'
		return { ok: false, sent: false, reason: 'internal', message }
	} finally {
		lock.release()
	}
}

/** Text for the oneshot. Success is the only line that contains "quoted". */
export function renderOutcome(outcome: RunOutcome): { exitCode: number; line: string } {
	if (outcome.ok) return { exitCode: 0, line: `quoted ${outcome.hash}` }
	if (outcome.reason === 'overlap') {
		return { exitCode: 0, line: 'overlap: previous quote still running; not sent' }
	}
	const detail = outcome.message ? `: ${outcome.message}` : ''
	return { exitCode: 1, line: `refused: ${outcome.reason}${detail}` }
}
