/**
 * P3/P4 long run: a scan actor and W payment actors (each with its own wallet slot) working at full speed on one core and one log, WITH the snapshot scheduler running (snapshots every few seconds, the log
 * trimmed after each commit). Two kinds of directory copies (a kill -9 at that instant): (1) at QUIESCED points (the actors are paused between two iterations and everything is durable) the copy must recover to
 * exactly the state of the core at that instant (a full digest; this is the kill-at-a-state-boundary check, repeated every few seconds and across snapshot commits and log trims); (2) at arbitrary instants
 * while the actors run, the copy must recover without error, to a seq not beyond the log head, with disjoint slots and no consumed key pending (the digest of every seq is not kept: it would be O(state) per commit).
 * At the end the replay of everything on disk equals the core, no ALERT line was printed. Default 20 s (a unit test); the 10-minute run of the review:
 *   LAB_LONG_MS=600000 node --import tsx --test src/endpoint/labPoolsLong.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ActorHub } from './labActorHandle'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WalWriter } from './labWal'
import { WalSnapshotScheduler } from './labWalSnapshotScheduler'
import { canonicalJson } from './labClPayoutStateStore'

type E = { eventKey: string; amount: string; blockNumber: number; withdrawalIndex: number; pubkey: string }
type S = Record<string, unknown>
const DURATION = Number(process.env.LAB_LONG_MS ?? 20_000)
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const fatal = (e: Error): void => {
	throw e
}
const digest = (c: LabPayoutStateCore): string =>
	canonicalJson({
		scalars: c.scalarsCopy(),
		inFlight: c.getInFlight(),
		slots: Object.fromEntries([...c.slotEntries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
		pending: [...c.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)),
		consumed: [...c.consumedKeys()].sort(),
		exited: [...c.exited.keys()].sort(),
	})

test(`scan + 3 wallets + snapshot scheduler for ${DURATION} ms: recovered copies equal the core at their seq, the replay equals the core, slots disjoint, no ALERT`, { timeout: DURATION + 120_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labpoolslong-'))
	const stateDir = path.join(dir, 'state.v2')
	const alerts: string[] = []
	try {
		const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 }, settledBatchCount: 0, realtimeCursor: 500, lastLiveHeadScanned: 500 } })
		const src0 = core.freezeForSnapshot()
		const res0 = await writeSnapshotCooperative(src0, { dir: stateDir, mode: 'wal' })
		core.finishSnapshot(src0, { committed: true, prunedKeys: [], frozenHistCounts: res0.frozenHistCounts })
		const wal = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 256 * 1024, onFatal: fatal })
		const hub = new ActorHub<E, S>({ core, wal, onFatal: fatal, log: (l) => l.includes('ALERT') && alerts.push(l) })
		const scheduler = new WalSnapshotScheduler({ core, wal, stateDir, log: (l) => (l.includes('ALERT') ? alerts.push(l) : undefined), intervalMs: Math.max(1500, Math.min(10_000, DURATION / 8)), quiet: () => !hub.hasUncommittedWrites() })
		scheduler.start()
		const copies: { dir: string; headAtCopy: number }[] = []
		const quiesced: { dir: string; want: string; seq: number }[] = []
		let paused = false
		let busy = 0
		let nextKey = 1
		let block = 500
		let stop = false
		let seed = 0x2545f491
		const rnd = (m: number): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % m)
		const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
		const gate = async (): Promise<void> => {
			while (paused) await new Promise((r) => setTimeout(r, 2))
			busy++
		}
		const scanner = async (): Promise<void> => {
			const h = hub.actor('scan')
			while (!stop) {
				await gate()
				block += 1
				h.pendingAdd(Array.from({ length: 16 }, (_, i) => ({ eventKey: key(nextKey++), amount: '1000', blockNumber: block, withdrawalIndex: i, pubkey: '0xabcdef' })))
				h.setScalar('realtimeCursor', block)
				h.setScalar('lastLiveHeadScanned', block)
				await h.commit('scan')
				busy--
				await new Promise((r) => setTimeout(r, 2 + rnd(6)))
			}
		}
		const payer = async (wl: string): Promise<void> => {
			const h = hub.actor(`pay:${wl}`)
			while (!stop) {
				await gate()
				const cand = [...h.pendingValues()].filter((e) => !hub.isReserved(e.eventKey)).slice(0, 40)
				if (cand.length === 0) {
					busy--
					await new Promise((r) => setTimeout(r, 3))
					continue
				}
				const keys = cand.map((e) => e.eventKey)
				if (!hub.claim(wl, keys, BigInt(keys.length) * 1000n)) {
					busy--
					continue
				}
				await turn()
				h.setSlot(wl, { batchId: `b${Math.floor(rnd(1e9))}`, idempotencyKey: `i-${wl}-${wal.lastSeq}`, line: 'realtime', amountWei: String(keys.length * 1000), eventKeys: keys, status: 'intent' })
				await h.commit('intent')
				hub.releaseClaim(wl)
				await new Promise((r) => setTimeout(r, 1 + rnd(4)))
				h.setSlot(wl, null)
				for (const k of keys) {
					h.pendingDel(k)
					h.consumedAdd(k)
				}
				h.incScalar('settledBatchCount', 1)
				await h.commit('settle')
				busy--
			}
		}
		const snapper = async (): Promise<void> => {
			let n = 0
			while (!stop) {
				await new Promise((r) => setTimeout(r, Math.max(400, DURATION / 40)))
				const c = fs.mkdtempSync(path.join(os.tmpdir(), 'labpoolslong-copy-'))
				fs.cpSync(stateDir, path.join(c, 'state.v2'), { recursive: true })
				copies.push({ dir: c, headAtCopy: wal.lastSeq })
				// every 4th round: a QUIESCED point (the actors finish their iteration and wait), everything durable, then the full digest and a copy
				if (++n % 4 === 0) {
					paused = true
					while (busy > 0) await new Promise((r) => setTimeout(r, 2))
					await wal.whenDurable(wal.lastSeq)
					const q = fs.mkdtempSync(path.join(os.tmpdir(), 'labpoolslong-q-'))
					fs.cpSync(stateDir, path.join(q, 'state.v2'), { recursive: true })
					quiesced.push({ dir: q, want: digest(core), seq: core.lastAppliedSeq })
					paused = false
				}
			}
		}
		const t0 = Date.now()
		const jobs = [scanner(), payer('w1'), payer('w2'), payer('w3'), snapper()]
		await new Promise((r) => setTimeout(r, DURATION))
		stop = true
		await Promise.all(jobs)
		await scheduler.stop()
		await wal.whenDurable(wal.lastSeq)
		await wal.whenDurable(wal.lastSeq)
		const st = scheduler.stats
		const full = recoverPayoutState(stateDir, { readOnly: true })
		assert.equal(digest(full.core), digest(core), 'the replay of everything on disk equals the core')
		const sound = (c: LabPayoutStateCore, label: string): void => {
			const own = new Map<string, string>()
			for (const [w, r] of c.slotEntries()) for (const k of (r as { eventKeys: string[] }).eventKeys) {
				assert.equal(own.get(k), undefined, `${label}: key ${k} in two slots`)
				own.set(k, w)
			}
			let n = 0
			for (const k of c.consumedKeys()) if (c.pendingHas(k) && ++n > 0) assert.fail(`${label}: consumed key ${k} is pending`)
		}
		let checked = 0
		for (const c of copies) {
			try {
				const rec = recoverPayoutState(path.join(c.dir, 'state.v2'), { readOnly: true })
				assert.ok(rec.core.lastAppliedSeq <= wal.lastSeq, 'a copy recovered beyond the log head')
				sound(rec.core, `random copy at head ${c.headAtCopy}`)
				checked++
			} catch (e) {
				if (!/refus|no committed snapshot|damaged|corrupt/i.test((e as Error).message)) throw e
				process.stderr.write(`long: a random copy was refused by the recovery: ${(e as Error).message.slice(0, 120)}\n`)
			}
			fs.rmSync(c.dir, { recursive: true, force: true })
		}
		for (const q of quiesced) {
			const rec = recoverPayoutState(path.join(q.dir, 'state.v2'), { readOnly: true })
			assert.equal(rec.core.lastAppliedSeq, q.seq, 'a quiesced copy recovers to the seq the core had')
			assert.equal(digest(rec.core), q.want, `a kill at the quiesced point seq ${q.seq} recovers to exactly the core's state (across snapshots and log trims)`)
			sound(rec.core, `quiesced copy seq ${q.seq}`)
			fs.rmSync(q.dir, { recursive: true, force: true })
		}
		sound(core, 'final core')
		assert.deepEqual(alerts, [], 'no ALERT')
		assert.ok(st.committed >= 2, `snapshots committed during the run: ${st.committed} (started ${st.started}, failed ${st.failed}, skippedBusy ${st.skippedBusy}, deferredNotQuiet ${st.deferredNotQuiet})`)
		assert.equal(st.failed, 0)
		assert.ok(quiesced.length >= 2, `quiesced checks: ${quiesced.length}`)
		assert.ok(checked >= Math.floor(copies.length * 0.8), `random copies recovered ${checked}/${copies.length}`)
		process.stderr.write(`long ${Date.now() - t0} ms: events=${wal.lastSeq} settledBatches=${core.getScalar('settledBatchCount')} pending=${core.pendingSize} consumed=${core.consumedSize} snapshots committed=${st.committed} failed=${st.failed} skippedBusy=${st.skippedBusy} deferredNotQuiet=${st.deferredNotQuiet} randomCopies=${checked}/${copies.length} quiescedChecks=${quiesced.length}\n`)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
