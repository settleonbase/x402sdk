/**
 * Tests for the withdrawNative batch lifecycle (B-2 in-flight record, B-3 fail-closed).
 * Fakes stand in for memory, disk, the signer journal and the chain receipt. No RPC, no socket.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import {
	LabRefusedBeforeBroadcast,
	resumeLabWithdrawInFlight,
	submitWithdrawBatchDurably,
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
type Disk = { pending: string[]; consumed: string[]; inFlight: LabInFlightWithdraw | null; settled?: number }

class World {
	readonly chain: Chain
	mem: { pending: Set<string>; consumed: Set<string>; inFlight: LabInFlightWithdraw | null }
	disk: Disk
	readonly gate: LabPayoutFailClosedGate
	readonly alerts: string[] = []
	readonly logs: string[] = []
	sendMode: SendMode = 'ok'
	/** Round-5 F1: the bound-address confirmation. 'refuse' throws before anything is persisted. */
	confirmMode: 'ok' | 'refuse' = 'ok'
	confirmCalls = 0
	setInFlightCalls = 0
	/** persist attempts (1-based) that must fail. */
	readonly failPersistAt = new Set<number>()
	persistAttempts = 0
	/** Settled-batch count: written in the same persist as consumed (countSettled). */
	settledMem = 0
	stopFlag = false
	halts: Array<{ code: number; reason: string }> = []

	constructor(init: { pending: string[]; chain?: Chain; disk?: Disk }) {
		this.chain = init.chain ?? { journal: new Map(), receipts: new Map(), sends: [], hashCounter: 0, writeAheadViolations: 0, signerReverted: new Set() }
		this.disk = init.disk ?? { pending: [...init.pending], consumed: [], inFlight: null }
		this.settledMem = this.disk.settled ?? 0
		this.mem = {
			pending: new Set(this.disk.pending),
			consumed: new Set(this.disk.consumed),
			inFlight: this.disk.inFlight ? structuredClone(this.disk.inFlight) : null,
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
				return { hash }
			},
			waitReceipt: async (hash) => {
				const r = this.chain.receipts.get(hash) ?? null
				if (r?.status === 0 && !this.chain.signerLag) this.chain.signerReverted.add(hash)
				return r
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

test('B-2: an ACK lost after broadcast is retried with the identical request; the signer returns the original hash', async () => {
	const w = new World({ pending: [A, B] })
	const d = w.deps()
	w.sendMode = 'ack-lost'
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B])), 'pending')
	assert.equal(w.mem.inFlight?.hash, undefined, 'no hash was obtained')

	w.addPending(C, D)
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B, C, D])), 'pending')
	assert.equal(w.chain.sends.length, 2, 'the retry is a resend of the in-flight request')
	assert.equal(w.chain.sends[0].idempotencyKey, w.chain.sends[1].idempotencyKey)
	assert.deepEqual(w.chain.sends[1].eventKeys, [A, B], 'the retry does not take the new composition')
	assert.equal(w.chain.journal.size, 1, 'one broadcast only')

	w.chain.receipts.set(hashOf(w), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'settled')
	assert.equal(w.chain.writeAheadViolations, 0)
})

test('B-2: a polled reverted receipt releases the batch; the identical composition is re-broadcast under the same key and settles once', async () => {
	const w = new World({ pending: [A, B] })
	const d = w.deps()
	await submitWithdrawBatchDurably(d, req([A, B]))
	const h0 = hashOf(w)
	w.chain.receipts.set(h0, { status: 0 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'reverted')
	assert.equal(w.mem.inFlight, null)
	assert.deepEqual([...w.mem.pending].sort(), [A, B], 'entries stay pending')
	assert.equal(w.mem.consumed.size, 0)

	// The signer has seen the revert, so the same key broadcasts again and returns a new hash.
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B])), 'pending')
	assert.equal(w.chain.sends.length, 2)
	const h1 = hashOf(w, 1)
	assert.notEqual(h1, h0, 'a new broadcast, not the reverted hash')
	assert.equal(w.chain.journal.size, 1, 'one key, the signer now holds the new hash')
	w.chain.receipts.set(h1, { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'settled')
	assert.deepEqual([...w.mem.consumed].sort(), [A, B])
	assert.equal([...w.chain.receipts.values()].filter((r) => r?.status === 1).length, 1, 'exactly one successful payment')
})

test('B-2: inside the signer poll window the same key returns the reverted hash; nothing is re-paid and no second broadcast happens', async () => {
	const w = new World({ pending: [A] })
	const d = w.deps()
	await submitWithdrawBatchDurably(d, req([A]))
	const h0 = hashOf(w)
	// The chain reverts it, and the daemon polls and releases it. The signer has not seen the revert yet.
	w.chain.receipts.set(h0, { status: 0 })
	w.chain.signerLag = true
	assert.equal(await resumeLabWithdrawInFlight(d), 'reverted')
	assert.equal(w.mem.inFlight, null)
	// Identical composition inside the window: the signer returns h0, nothing new is broadcast, and the poll reverts it again.
	assert.equal(await submitWithdrawBatchDurably(d, req([A])), 'reverted')
	assert.equal(hashOf(w, 1), h0, 'the signer returns the old hash inside the window')
	assert.equal(new Set(w.chain.sends.map((_, i) => hashOf(w, i))).size, 1, 'one distinct broadcast only')
	assert.deepEqual([...w.mem.pending], [A], 'still pending, nothing paid')
	// Once the signer has seen the revert, the same key broadcasts a new hash, and that one settles once.
	w.chain.signerLag = false
	w.syncSigner() // the signer's own receipt poll catches up
	assert.equal(await submitWithdrawBatchDurably(d, req([A])), 'pending')
	const h1 = hashOf(w, 2)
	assert.notEqual(h1, h0)
	w.chain.receipts.set(h1, { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(d), 'settled')
	assert.equal([...w.chain.receipts.values()].filter((r) => r?.status === 1).length, 1, 'exactly one successful payment')
	assert.deepEqual([...w.mem.consumed], [A])
})

test('B-2/B-3: a hash persist failure after broadcast; the restart resumes the identical request and does not broadcast again', async () => {
	const w = new World({ pending: [A, B] })
	w.failPersistAt.add(2) // intent is attempt 1, the broadcast hash is attempt 2
	await assert.rejects(submitWithdrawBatchDurably(w.deps(), req([A, B])), /simulated persist failure/)
	assert.equal(w.chain.journal.size, 1, 'the broadcast happened')
	assert.equal(w.disk.inFlight?.hash, undefined, 'the hash is not durable')
	assert.equal(w.gate.tripped, true)

	const r = w.restart()
	assert.equal(await resumeLabWithdrawInFlight(r.deps()), 'pending', 'receipt not yet')
	assert.equal(r.chain.journal.size, 1, 'the signer journal returned the original hash; no second broadcast')
	assert.equal(r.chain.sends.length, 2)
	assert.equal(r.chain.sends[0].idempotencyKey, r.chain.sends[1].idempotencyKey)
	r.chain.receipts.set(hashOf(r), { status: 1 })
	assert.equal(await resumeLabWithdrawInFlight(r.deps()), 'settled')
	assert.deepEqual([...r.mem.consumed].sort(), [A, B])
})

test('B-2: an unreachable signer keeps the record; nothing is composed until a send succeeds', async () => {
	const w = new World({ pending: [A, B] })
	w.sendMode = 'down'
	const d = w.deps()
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B])), 'pending')
	w.addPending(C)
	assert.equal(await submitWithdrawBatchDurably(d, req([A, B, C])), 'pending')
	assert.equal(w.chain.journal.size, 0, 'no broadcast while the signer is down')
	assert.ok(w.chain.sends.every((s) => s.eventKeys.join() === [A, B].join()), 'every retry is the same request')
	w.sendMode = 'ok'
	assert.equal(await resumeLabWithdrawInFlight(d), 'pending')
	assert.equal(w.chain.journal.size, 1)
	assert.equal(w.chain.sends.at(-1)?.eventKeys.join(), [A, B].join())
})

test('F1: a send refused by the daemon before broadcast releases the record; nothing is sent; no attempt is consumed', async () => {
	const w = new World({ pending: [A] })
	w.sendMode = 'refuse'
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'refused')
	assert.equal(w.mem.inFlight, null)
	assert.equal(w.chain.sends.length, 0, 'the signer was never asked')
	assert.equal(w.mem.pending.has(A), true, 'the entry stays pending')
	w.sendMode = 'ok'
	assert.equal(await submitWithdrawBatchDurably(w.deps(), req([A])), 'pending')
	assert.equal(w.chain.sends.length, 1)
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

// Crash injection at each durable write (intent, broadcast hash, settle). The process is simulated as killed at write k:
// the write fails, memory is dropped, and a fresh World restarts from the last durable disk and the same chain.
// Asserts: one broadcast in total for the key, the batch is settled once, and the count is not doubled.
// This is an in-process harness, not a real SIGTERM against a child process (that harness is not built yet).
test('crash injection at each durable write: a restart never broadcasts a second time and settles once', async () => {
	for (const k of [1, 2, 3]) {
		const w = new World({ pending: [A] })
		const predicted = key(0x1001) // the first broadcast hash in the fake signer
		w.chain.receipts.set(predicted, { status: 1 })
		w.failPersistAt.add(k)
		const d = w.deps()
		await submitWithdrawBatchDurably(d, req([A])).catch(() => undefined)
		const back = w.restart()
		// Restart: a held record resumes; otherwise the still-pending batch is composed again (once).
		await submitWithdrawBatchDurably(back.deps(), req([A])).catch(() => undefined)
		await resumeLabWithdrawInFlight(back.deps()).catch(() => undefined)
		assert.equal(back.chain.hashCounter, 1, `k=${k}: exactly one broadcast in total`)
		assert.equal(back.chain.journal.size, 1, `k=${k}: one key, one hash`)
		assert.deepEqual([...back.mem.consumed], [A], `k=${k}: the batch is settled`)
		assert.equal(back.settledMem, 1, `k=${k}: the settled count is 1, not doubled`)
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
