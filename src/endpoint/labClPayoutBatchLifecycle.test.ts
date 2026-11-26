/**
 * Tests for the withdrawNative batch lifecycle (B-2 in-flight record, B-3 fail-closed).
 * Fakes stand in for memory, disk, the signer journal and the chain receipt. No RPC, no socket.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ethers } from 'ethers'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import {
	LabRefusedBeforeBroadcast,
	resumeLabWithdrawInFlight,
	submitWithdrawBatchDurably,
	buildLabInFlightWithdraw,
	verifyFinalizedLabWithdrawalEvidence,
	type LabBatchRequest,
	type LabInFlightWithdraw,
	type LabLifecycleDeps,
} from './labClPayoutBatchLifecycle'
import { LAB_MINING_POOL_FIXED } from './labMiningPoolPayoutSigner'

const REDEEM = '0x2222222222222222222222222222222222222222'
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const A = key(1)
const B = key(2)
const C = key(3)
const D = key(4)

type SendMode = 'ok' | 'ack-lost' | 'down' | 'refuse'
type Sent = { idempotencyKey: string; eventKeys: string[]; amountWei: string; pool: string; hash?: string }
type Chain = {
	journal: Map<string, string> // signer journal: idempotencyKey -> broadcast hash
	receipts: Map<string, { status: number } | null> // hash -> receipt (null or missing = not yet)
	sends: Sent[]
	hashCounter: number
	/** Hashes the signer has seen reverted (it re-broadcasts the same key after a reverted record, f6c70f3 txManager). */
	signerReverted: Set<string>
	/** true: the signer has not yet seen a revert it is asked about (the poll window). */
	signerLag?: boolean
	writeAheadViolations: number
}
type Disk = { pending: string[]; consumed: string[]; inFlight: LabInFlightWithdraw | null; settled?: number; sendAttempts?: number; sendAttemptLimit?: number }

class World {
	readonly chain: Chain
	mem: { pending: Set<string>; consumed: Set<string>; inFlight: LabInFlightWithdraw | null; sendAttempts?: number; sendAttemptLimit?: number }
	disk: Disk
	readonly gate: LabPayoutFailClosedGate
	readonly alerts: string[] = []
	readonly logs: string[] = []
	sendMode: SendMode = 'ok'
	/** Round-5 F1: the bound-address confirmation. 'refuse' throws before anything is persisted. */
	confirmMode: 'ok' | 'refuse' = 'ok'
	confirmCalls = 0
	lookupCalls = 0
	lookupMode: 'journal' | 'not-found' | 'unknown' | 'mismatch' = 'journal'
	setInFlightCalls = 0
	/** persist attempts (1-based) that must fail. */
	readonly failPersistAt = new Set<number>()
	persistAttempts = 0
	/** Settled-batch count: written in the same persist as consumed (countSettled). */
	settledMem = 0
	stopFlag = false
	configuredAttemptLimit = 3
	halts: Array<{ code: number; reason: string }> = []

	constructor(init: { pending: string[]; chain?: Chain; disk?: Disk }) {
		this.chain = init.chain ?? { journal: new Map(), receipts: new Map(), sends: [], hashCounter: 0, writeAheadViolations: 0, signerReverted: new Set() }
		this.disk = init.disk ?? { pending: [...init.pending], consumed: [], inFlight: null, sendAttempts: 0, sendAttemptLimit: 3 }
		this.settledMem = this.disk.settled ?? 0
		this.mem = {
			pending: new Set(this.disk.pending),
			consumed: new Set(this.disk.consumed),
			inFlight: this.disk.inFlight ? structuredClone(this.disk.inFlight) : null,
			sendAttempts: this.disk.sendAttempts,
			sendAttemptLimit: this.disk.sendAttemptLimit,
		}
		this.gate = new LabPayoutFailClosedGate((m) => this.alerts.push(m))
	}

	/** The signer's receipt poll: every hash the chain has reverted is now known to the signer. */
	syncSigner(): void {
		for (const [h, r] of this.chain.receipts) if (r?.status === 0) this.chain.signerReverted.add(h)
	}

	/** Simulate a process restart: memory is rebuilt from the last durable disk state. */
	restart(): World {
		return new World({ pending: [], chain: this.chain, disk: structuredClone(this.disk) })
	}

	deps(): LabLifecycleDeps {
		return {
			gate: this.gate,
			getInFlight: () => this.mem.inFlight,
			setInFlight: (v) => {
				this.setInFlightCalls++
				this.mem.inFlight = v
			},
			confirmBeforeSend: async () => {
				this.confirmCalls++
				if (this.confirmMode === 'refuse') throw new LabRefusedBeforeBroadcast('bound signer address not confirmed (fake)')
			},
			persist: () => {
				this.persistAttempts++
				if (this.failPersistAt.has(this.persistAttempts)) {
					throw new Error('simulated persist failure: Invalid string length')
				}
				this.disk = {
					pending: [...this.mem.pending].sort(),
					consumed: [...this.mem.consumed].sort(),
					inFlight: this.mem.inFlight ? structuredClone(this.mem.inFlight) : null,
					settled: this.settledMem,
					sendAttempts: this.mem.sendAttempts,
					sendAttemptLimit: this.mem.sendAttemptLimit,
				}
			},
			send: async (rec) => {
				if (this.sendMode === 'refuse') throw new LabRefusedBeforeBroadcast('bound signer address not confirmed (fake)')
				this.chain.sends.push({ idempotencyKey: rec.idempotencyKey, eventKeys: [...rec.eventKeys], amountWei: rec.amountWei, pool: rec.pool })
				// Write-ahead: the intent must already be durable when the signer is asked.
				if (this.disk.inFlight?.idempotencyKey !== rec.idempotencyKey) this.chain.writeAheadViolations++
				if (this.sendMode === 'down') throw new Error('signer socket failed')
				let hash = this.chain.journal.get(rec.idempotencyKey)
				// Same key after a reverted record: the signer broadcasts again and returns a new hash. Before the signer has
				// seen the revert (the poll window), it returns the old hash.
				if (!hash || this.chain.signerReverted.has(hash)) {
					hash = key(0x1000 + ++this.chain.hashCounter)
					this.chain.journal.set(rec.idempotencyKey, hash) // broadcast happens here
				}
				if (this.sendMode === 'ack-lost') {
					this.sendMode = 'ok'
					throw new Error('signer ACK lost after broadcast')
				}
				this.chain.sends[this.chain.sends.length - 1].hash = hash
				return { hash, idempotencyKey: rec.idempotencyKey, requestFingerprint: rec.requestFingerprint }
			},
			lookupSignerJournal: async (rec) => {
				this.lookupCalls++
				if (this.lookupMode === 'unknown') return { kind: 'unknown' }
				if (this.lookupMode === 'not-found') return { kind: 'not-found' }
				const hash = this.chain.journal.get(rec.idempotencyKey)
				if (!hash) return { kind: 'not-found' }
				if (this.lookupMode === 'mismatch') return { kind: 'found', hash, idempotencyKey: 'wrong-key', requestFingerprint: 'wrong-fingerprint' }
				return { kind: 'found', hash, idempotencyKey: rec.idempotencyKey, requestFingerprint: rec.requestFingerprint }
			},
			waitReceipt: async (hash) => {
				const r = this.chain.receipts.get(hash) ?? null
				if (r?.status === 0 && !this.chain.signerLag) this.chain.signerReverted.add(hash)
				return r ? { kind: 'finalized' as const, status: r.status as 0 | 1 } : { kind: 'unknown' as const }
			},
			settle: (keys) => {
				for (const k of keys) {
					this.mem.pending.delete(k)
					this.mem.consumed.add(k)
				}
			},
			log: (line) => this.logs.push(line),
			countSettled: () => {
				this.settledMem++
			},
			stopBeforeSend: () => this.stopFlag,
			getSendBudget: () => {
				const { sendAttempts, sendAttemptLimit } = this.mem
				if (sendAttempts == null || sendAttemptLimit == null) return null
				return { used: sendAttempts, limit: sendAttemptLimit, configuredLimit: this.configuredAttemptLimit }
			},
			setSendBudget: (used, limit) => {
				this.mem.sendAttempts = used
				this.mem.sendAttemptLimit = limit
			},
			halt: (code, reason) => {
				this.halts.push({ code, reason })
			},
		}
	}

	addPending(...keys: string[]): void {
		for (const k of keys) this.mem.pending.add(k)
	}
}

const req = (keys: string[]): LabBatchRequest => ({
	redeem: REDEEM,
	pool: LAB_MINING_POOL_FIXED,
	amount: 5n,
	eventKeys: keys,
	line: 'realtime',
})

const hashOf = (w: World, i = 0): string => {
	const s = w.chain.sends[i]
	const h = w.chain.journal.get(s.idempotencyKey)
	assert.ok(h, 'signer journal holds the broadcast hash')
	return h
}

test('safety: finalized receipt verifier distinguishes transaction, canonical-chain, and finality failures', () => {
	const rec = buildLabInFlightWithdraw(req([A]), new Date('2026-01-01T00:00:00Z'))
	const txHash = key(0x9001)
	const blockHash = key(0x9002)
	rec.hash = txHash
	const from = '0x1111111111111111111111111111111111111111'
	const iface = new ethers.Interface(['function withdrawNative(address pool,uint256 amount)'])
	const valid = {
		transaction: {
			hash: txHash,
			from,
			to: REDEEM,
			data: iface.encodeFunctionData('withdrawNative', [LAB_MINING_POOL_FIXED, 5n]),
			value: '0',
			chainId: 224422,
		},
		receipt: { transactionHash: txHash, status: 1, blockNumber: 500, blockHash },
		canonicalBlock: { number: 500, hash: blockHash },
		finalizedBlock: { number: 500, hash: blockHash },
	}
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, valid, from), { kind: 'finalized', status: 1 })
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence({ ...rec, hash: key(0x9004) }, valid, from), { kind: 'unknown' }, 'persisted intent hash must bind the transaction')
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, { ...valid, receipt: { ...valid.receipt, status: null } }, from), { kind: 'unknown' })
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, { ...valid, receipt: { ...valid.receipt, transactionHash: key(7) } }, from), { kind: 'unknown' })
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, { ...valid, canonicalBlock: { number: 500, hash: key(8) } }, from), { kind: 'unknown' })
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, { ...valid, finalizedBlock: { number: 499, hash: key(9) } }, from), { kind: 'unknown' })
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, { ...valid, finalizedBlock: { number: 501, hash: key(0x9003) } }, from), { kind: 'unknown' }, 'later finalized height needs ancestry proof, not height ordering alone')
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, { ...valid, finalizedBlock: { number: Number.MAX_SAFE_INTEGER + 1, hash: blockHash } }, from), { kind: 'unknown' }, 'unsafe block number is not evidence')
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, { ...valid, transaction: { ...valid.transaction, from: '0x2222222222222222222222222222222222222222' } }, from), { kind: 'unknown' }, 'wrong signer identity is not evidence')
	assert.deepEqual(verifyFinalizedLabWithdrawalEvidence(rec, {
		...valid,
		transaction: { ...valid.transaction, data: iface.encodeFunctionData('withdrawNative', [LAB_MINING_POOL_FIXED, 6n]) },
	}, from), { kind: 'unknown' })
})

test('B-2: a receipt timeout keeps the batch; a recomposed batch is not signed again', async () => {
	const w = new World({ pending: [A, B] })
	const d = w.deps()
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B])), 'pending')
	assert.equal(w.chain.sends.length, 1)

	// Scan adds entries, so the composition changes (the force-coalesce case).
	w.addPending(C, D)
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B, C, D])), 'pending')
	assert.equal(w.chain.sends.length, 1, 'no new signature while the receipt is unresolved')
	assert.deepEqual(w.chain.sends[0].eventKeys, [A, B])

	w.chain.receipts.set(hashOf(w), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'settled')
	assert.deepEqual([...w.mem.consumed].sort(), [A, B])
	assert.deepEqual([...w.mem.pending].sort(), [C, D])

	// Only now may a new composition be signed, and it has its own key.
	assert.equal(await submitWithdrawBatchDurably(d, req([C, D])), 'pending')
	assert.equal(w.chain.sends.length, 2)
	assert.notEqual(w.chain.sends[1].idempotencyKey, w.chain.sends[0].idempotencyKey)
	w.chain.receipts.set(hashOf(w, 1), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'settled')
	assert.deepEqual([...w.mem.consumed].sort(), [A, B, C, D].sort())
	assert.equal(w.chain.writeAheadViolations, 0)
})

test('safety: an ACK lost after broadcast is recovered read-only; the same request is never sent twice', async () => {
	const w = new World({ pending: [A, B] })
	const d = w.deps()
	w.sendMode = 'ack-lost'
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B])), 'pending')
	assert.equal(w.mem.inFlight?.hash, undefined, 'no hash was obtained')

	w.addPending(C, D)
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B, C, D])), 'pending')
	assert.equal(w.chain.sends.length, 1, 'resume never re-enters signer_sendTransaction')
	assert.equal(w.chain.journal.size, 1, 'one broadcast only')

	w.chain.receipts.set(hashOf(w), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'settled')
	assert.equal(w.chain.writeAheadViolations, 0)
})

test('safety regression: a hashless in-flight intent is reconciled read-only after restart', async () => {
	const w = new World({ pending: [A, B] })
	w.sendMode = 'ack-lost'
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A, B])), 'pending')
	assert.equal(w.chain.sends.length, 1, 'the first sender call may have broadcast before ACK loss')
	assert.equal(w.disk.inFlight?.hash, undefined, 'the durable intent has no durable hash')

	const before = structuredClone(w.disk.inFlight)
	const restarted = w.restart()
	assert.equal(await resumeLabWithdrawInFlight(restarted.deps()), 'pending')
	assert.equal(restarted.chain.sends.length, 1, 'restart must not enter signer_sendTransaction for an old hashless intent')
	assert.equal(restarted.disk.inFlight?.hash, hashOf(restarted), 'the exact signer journal may restore the hash')
	assert.equal(restarted.disk.inFlight?.sendAttempts, before?.sendAttempts, 'recovery does not consume another attempt')
	assert.equal(restarted.disk.sendAttempts, 1, 'lifetime counter survives restart unchanged')
})

test('safety: a finalized reverted receipt is retained for review and cannot be rebroadcast', async () => {
	const w = new World({ pending: [A, B] })
	const d = w.deps()
	await submitWithdrawBatchDurably(d, req([A, B]))
	const h0 = hashOf(w)
	w.chain.receipts.set(h0, { status: 0 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'reverted')
	assert.notEqual(w.mem.inFlight, null)
	assert.deepEqual([...w.mem.pending].sort(), [A, B], 'entries stay pending')
	assert.equal(w.mem.consumed.size, 0)

	assert.equal(await submitWithdrawBatchDurably(d, req([A, B])), 'reverted')
	assert.equal(w.chain.sends.length, 1, 'revert does not authorize another sender call')
	assert.equal(w.disk.sendAttempts, 1, 'the lifetime attempt remains consumed')
})

test('safety: a reverted intent remains held even while signer journal is behind', async () => {
	const w = new World({ pending: [A] })
	const d = w.deps()
	await submitWithdrawBatchDurably(d, req([A]))
	const h0 = hashOf(w)
	// The chain reverts it. The signer journal is deliberately behind; this never releases the intent.
	w.chain.receipts.set(h0, { status: 0 })
	w.chain.signerLag = true
	assert.equal(await resumeLabWithdrawInFlight(d), 'reverted')
	assert.notEqual(w.mem.inFlight, null)
	assert.equal(await submitWithdrawBatchDurably(d, req([A])), 'reverted')
	assert.equal(hashOf(w), h0)
	assert.equal(w.chain.sends.length, 1, 'journal is read, never sent again')
	assert.deepEqual([...w.mem.pending], [A], 'still pending, nothing paid')
	assert.equal(w.disk.sendAttempts, 1)
})

test('B-2/B-3: a hash persist failure after broadcast; the restart resumes the identical request and does not broadcast again', async () => {
	const w = new World({ pending: [A, B] })
	w.failPersistAt.add(3) // intent, durable attempt reservation, then broadcast hash
	await assert.rejects(submitWithdrawBatchDurably(w.deps(), req([A, B])), /simulated persist failure/)
	assert.equal(w.chain.journal.size, 1, 'the broadcast happened')
	assert.equal(w.disk.inFlight?.hash, undefined, 'the hash is not durable')
	assert.equal(w.gate.tripped, true)

	const r = w.restart()
	assert.equal(await resumeLabWithdrawInFlight(r.deps()), 'pending', 'receipt not yet')
	assert.equal(r.chain.journal.size, 1, 'the signer journal returned the original hash; no second broadcast')
	assert.equal(r.chain.sends.length, 1, 'restart reconciles the existing journal without resend')
	r.chain.receipts.set(hashOf(r), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(r.deps()), 'settled')
	assert.deepEqual([...r.mem.consumed].sort(), [A, B])
})

test('safety: an unreachable signer consumes one attempt and is never automatically retried', async () => {
	const w = new World({ pending: [A, B] })
	w.sendMode = 'down'
	const d = w.deps()
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B])), 'pending')
	w.addPending(C)
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B, C])), 'pending')
	assert.equal(w.chain.journal.size, 0, 'no broadcast while the signer is down')
	assert.equal(w.chain.sends.length, 1)
	assert.equal(w.disk.sendAttempts, 1)
	w.sendMode = 'ok'
	assert.equal(await resumeLabWithdrawInFlight(d), 'pending')
	assert.equal(w.chain.journal.size, 0)
	assert.equal(w.chain.sends.length, 1, 'restart/next tick cannot resend an unknown outcome')
})

test('safety: sender-call errors retain the record and consume the lifetime attempt', async () => {
	const w = new World({ pending: [A] })
	w.sendMode = 'refuse'
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'pending')
	assert.notEqual(w.mem.inFlight, null)
	assert.equal(w.chain.sends.length, 0, 'the signer was never asked')
	assert.equal(w.disk.sendAttempts, 1, 'the attempted sender boundary is durable')
	w.sendMode = 'ok'
	assert.equal(await resumeLabWithdrawInFlight(w.deps()), 'pending')
	assert.equal(w.chain.sends.length, 0, 'no automatic retry after sender entry')
})

test('R5 F1: a refusal of the bound address happens before the intent is persisted; nothing is written, nothing is sent', async () => {
	const w = new World({ pending: [A] })
	w.confirmMode = 'refuse'
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'refused')
	assert.equal(w.setInFlightCalls, 0, 'no in-flight record is ever created')
	assert.equal(w.persistAttempts, 0, 'nothing is persisted')
	assert.equal(w.chain.sends.length, 0, 'the signer is never asked')
	assert.equal(w.mem.inFlight, null)
	assert.ok(w.logs.some((l) => l.includes('refused before intent')))
})

test('R5 F1: the bound address is read again before every new composition (no process cache)', async () => {
	const w = new World({ pending: [A, B] })
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'pending')
	w.chain.receipts.set(w.chain.sends[0].hash!, { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(w.deps()), 'settled')
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([B])), 'pending')
	assert.equal(w.confirmCalls, 4, 'two reads per new composition: at the intent, and immediately before the send (round-6 item 3)')
	assert.equal(w.chain.sends.length, 2)
})


// --- One-shot daemon items (independent review ad571436, items 1, 2, 3, 5) ---

test('one-shot: a restart with the limit already reached never sends; the in-flight record is not touched', async () => {
	const w = new World({ pending: [A] })
	w.settledMem = 1
	w.stopFlag = true
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'stopped')
	assert.equal(w.chain.sends.length, 0, 'nothing is sent past the limit')
	assert.equal(w.mem.inFlight, null, 'no record is created')
})

test('safety: lifetime sender budget is consumed durably and exhaustion survives restart', async () => {
	const w = new World({ pending: [A, B] })
	w.configuredAttemptLimit = 1
	w.mem.sendAttemptLimit = 1
	w.disk.sendAttemptLimit = 1
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'pending')
	assert.equal(w.disk.sendAttempts, 1, 'one attempt was committed before entering send')
	w.chain.receipts.set(hashOf(w), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(w.deps()), 'settled')
	const afterFirst = w.restart()
	assert.equal(afterFirst.disk.sendAttempts, 1)
	assert.equal(await submitWithdrawBatchDurably(afterFirst.deps(), req([B])), 'stopped')
	assert.equal(afterFirst.chain.sends.length, 1, 'a settled intent cannot free the lifetime budget')
	assert.deepEqual([...afterFirst.mem.pending], [B])
})

test('safety: missing or changed historical lifetime budget is UNKNOWN and blocks a new send', async () => {
	const w = new World({ pending: [A] })
	delete w.mem.sendAttempts
	delete w.disk.sendAttempts
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'stopped')
	assert.equal(w.chain.sends.length, 0)
	assert.equal(w.mem.inFlight, null)
	const changed = new World({ pending: [A] })
	changed.configuredAttemptLimit = 4
	assert.equal(await submitWithdrawBatchDurably(changed.deps(), req([A])), 'stopped')
	assert.equal(changed.chain.sends.length, 0)
})

test('one-shot: the settled count and the consumed set are written in one persist; a failure at that write leaves neither', async () => {
	const w = new World({ pending: [A] })
	const d = w.deps()
	assert.equal(await submitWithdrawBatchDurably(d, req([A])), 'pending') // persist 1 (intent), persist 2 (hash)
	w.chain.receipts.set(hashOf(w), { status: 1 })
	w.failPersistAt.add(w.persistAttempts + 1) // the settle write
	await assert.rejects(resumeLabWithdrawInFlight(d), /simulated persist failure/)
	const back = w.restart()
	assert.equal(back.mem.consumed.size, 0, 'consumed is not on disk')
	assert.equal(back.settledMem, 0, 'the count is not on disk either: no paid-but-uncounted state')
	assert.notEqual(back.mem.inFlight, null, 'the in-flight record survives for the restart')
})

test('one-shot: a status 0 receipt halts with code 3 and never re-sends under the same key', async () => {
	const w = new World({ pending: [A] })
	const d = w.deps()
	await submitWithdrawBatchDurably(d, req([A]))
	w.chain.receipts.set(hashOf(w), { status: 0 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'reverted')
	// submit already saw no receipt yet (halt 4); the poll now sees status 0 (halt 3, the last halt)
	assert.equal(w.halts.at(-1)?.code, 3, 'the daemon halts with 3 (RestartPreventExitStatus)')
	assert.equal(w.chain.sends.length, 1, 'no same-key re-send')
})

test('one-shot: an unknown receipt halts with code 4, keeps the record, and a restart resumes the same hash without re-sending', async () => {
	const w = new World({ pending: [A] })
	const d = w.deps()
	await submitWithdrawBatchDurably(d, req([A]))
	assert.equal(await resumeLabWithdrawInFlight(d), 'pending')
	// submit and the explicit resume both see no receipt: two halts with 4, the record kept
	assert.equal(w.halts.length, 2)
	assert.ok(w.halts.every((h) => h.code === 4))
	assert.notEqual(w.mem.inFlight, null, 'the record is kept')
	const back = w.restart()
	back.chain.receipts.set(hashOf(back), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(back.deps()), 'settled')
	assert.equal(back.chain.sends.length, 1, 'restart resumed the same hash; the key was not re-sent')
	assert.equal(back.settledMem, 1)
})

// Crash injection at each durable write (intent, attempt reservation, hash, settle). The process is simulated as killed at write k:
// the write fails, memory is dropped, and a fresh World restarts from the last durable disk and the same chain.
// Asserts: one broadcast in total for the key, the batch is settled once, and the count is not doubled.
// This is an in-process harness, not a real SIGTERM against a child process (that harness is not built yet).
test('crash injection at durable boundaries never repeats a sender call', async () => {
	for (const k of [1, 2, 3, 4]) {
		const w = new World({ pending: [A] })
		const predicted = key(0x1001) // the first broadcast hash in the fake signer
		w.chain.receipts.set(predicted, { status: 1 })
		w.failPersistAt.add(k)
		const d = w.deps()
		await submitWithdrawBatchDurably(d, req([A])).catch(() => undefined)
		const back = w.restart()
		// A failed intent write permits later composition; a persisted intent/attempt is never resent.
		await submitWithdrawBatchDurably(back.deps(), req([A])).catch(() => undefined)
		await resumeLabWithdrawInFlight(back.deps()).catch(() => undefined)
		const expectedSends = k === 2 ? 0 : 1
		assert.equal(back.chain.hashCounter, expectedSends, `k=${k}: sender-call outcome is not repeated`)
		assert.equal(back.chain.journal.size, expectedSends, `k=${k}: journal entry count matches sender call`)
		if (k === 2) {
			assert.deepEqual([...back.mem.consumed], [], 'failed durable attempt reservation prevents send and settlement')
			assert.equal(back.disk.sendAttempts, 0, 'failed reservation is absent from durable state')
		} else {
			assert.deepEqual([...back.mem.consumed], [A], `k=${k}: the batch is settled only when a send may have occurred`)
			assert.equal(back.settledMem, 1, `k=${k}: the settled count is 1, not doubled`)
		}
	}
})

// Shutdown ordering at the lifecycle level (approximation; the reporter's own idle wait and listening-checkpoint flush are
// NOT exercised here). Stop: no new composition or send while a batch is in flight. Drain: the in-flight batch is polled
// while its receipt is still unknown. Restart: a fresh process resumes the same hash and settles once.
test('shutdown ordering (lifecycle level): stop with a batch in flight, drain while the receipt is unknown, restart resumes once', async () => {
	const w = new World({ pending: [A] })
	await submitWithdrawBatchDurably(w.deps(), req([A])) // in flight, hash persisted
	w.stopFlag = true // stop: no new composition or send
	assert.equal(await resumeLabWithdrawInFlight(w.deps()), 'pending', 'drain: the receipt is unknown, the record is kept')
	const back = w.restart()
	back.chain.receipts.set(hashOf(back), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(back.deps()), 'settled', 'restart resumes the same hash and settles')
	assert.equal(back.chain.hashCounter, 1, 'one broadcast in total')
	assert.equal(back.chain.journal.size, 1, 'one key, one hash')
	assert.deepEqual([...back.mem.consumed], [A])
	assert.equal(back.settledMem, 1, 'the count is not doubled')
})
