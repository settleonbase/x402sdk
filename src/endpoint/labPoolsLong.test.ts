/**
 * P3/P4 long run: a scan actor and W payment actors (each with its own wallet slot) working at full speed on one core and one log, WITH the snapshot scheduler running (snapshots every few seconds, the log
 * trimmed after each commit). Every few seconds a copy of the state directory is taken (a kill -9 at that instant) and recovered: it must equal the state the core really had at the recovered seq. At the
 * end the replay of everything on disk equals the core, no key is in two slots, no consumed key is pending, no ALERT line was printed. Default 20 s (a unit test); the 10-minute run of the review:
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
		const digestBySeq = new Map<number, string>([[0, digest(core)]])
		const copies: string[] = []
		let nextKey = 1
		let block = 500
		let stop = false
		let seed = 0x2545f491
		const rnd = (m: number): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % m)
		const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
		const note = (): void => void digestBySeq.set(wal.lastSeq, digest(core))
		const scanner = async (): Promise<void> => {
			const h = hub.actor('scan')
			while (!stop) {
				block += 1
				h.pendingAdd(Array.from({ length: 16 }, (_, i) => ({ eventKey: key(nextKey++), amount: '1000', blockNumber: block, withdrawalIndex: i, pubkey: '0xabcdef' })))
				h.setScalar('realtimeCursor', block)
				h.setScalar('lastLiveHeadScanned', block)
				const p = h.commit('scan')
				note() // the digest right after the synchronous record of this commit is the state AT its seq
				await p
				await new Promise((r) => setTimeout(r, 2 + rnd(6)))
			}
		}
		const payer = async (wl: string): Promise<void> => {
			const h = hub.actor(`pay:${wl}`)
			while (!stop) {
				const cand = [...h.pendingValues()].filter((e) => !hub.isReserved(e.eventKey)).slice(0, 40)
				if (cand.length === 0) {
					await new Promise((r) => setTimeout(r, 3))
					continue
				}
				const keys = cand.map((e) => e.eventKey)
				if (!hub.claim(wl, keys, BigInt(keys.length) * 1000n)) continue
				await turn()
				h.setSlot(wl, { batchId: `b${Math.floor(rnd(1e9))}`, idempotencyKey: `i-${wl}-${wal.lastSeq}`, line: 'realtime', amountWei: String(keys.length * 1000), eventKeys: keys, status: 'intent' })
				let p = h.commit('intent')
				note()
				await p
				hub.releaseClaim(wl)
				await new Promise((r) => setTimeout(r, 1 + rnd(4)))
				h.setSlot(wl, null)
				for (const k of keys) {
					h.pendingDel(k)
					h.consumedAdd(k)
				}
				h.incScalar('settledBatchCount', 1)
				p = h.commit('settle')
				note()
				await p
			}
		}
		const snapper = async (): Promise<void> => {
			while (!stop) {
				await new Promise((r) => setTimeout(r, Math.max(400, DURATION / 40)))
				const c = fs.mkdtempSync(path.join(os.tmpdir(), 'labpoolslong-copy-'))
				fs.cpSync(stateDir, path.join(c, 'state.v2'), { recursive: true })
				copies.push(c)
			}
		}
		const t0 = Date.now()
		const jobs = [scanner(), payer('w1'), payer('w2'), payer('w3'), snapper()]
		await new Promise((r) => setTimeout(r, DURATION))
		stop = true
		await Promise.all(jobs)
		await scheduler.stop()
		await wal.whenDurable(wal.lastSeq)
		digestBySeq.set(wal.lastSeq, digest(core))
		const st = scheduler.stats
		const full = recoverPayoutState(stateDir, { readOnly: true })
		assert.equal(digest(full.core), digest(core), 'the replay of everything on disk equals the core')
		let checked = 0
		for (const c of copies) {
			try {
				const rec = recoverPayoutState(path.join(c, 'state.v2'), { readOnly: true })
				const want = digestBySeq.get(rec.core.lastAppliedSeq)
				// a copy may have been taken while a snapshot was being written into the directory: the recovery then starts from the older committed snapshot plus the log; its seq is still one the core had
				assert.notEqual(want, undefined, `a copy recovered to seq ${rec.core.lastAppliedSeq}, which no commit produced`)
				assert.equal(digest(rec.core), want, `a kill at seq ${rec.core.lastAppliedSeq} recovers to the state the core had there`)
				checked++
			} catch (e) {
				// a copy of a directory in the middle of a log segment rotation or snapshot commit may be refused as a whole by the recovery (never read as something else): count, do not hide
				if (!/refus|no committed snapshot|damaged|corrupt/i.test((e as Error).message)) throw e
				process.stderr.write(`long: a copy was refused by the recovery: ${(e as Error).message.slice(0, 120)}\n`)
			}
			fs.rmSync(c, { recursive: true, force: true })
		}
		const owners = new Map<string, string>()
		for (const [w, r] of core.slotEntries()) for (const k of (r as { eventKeys: string[] }).eventKeys) {
			assert.equal(owners.get(k), undefined, `key ${k} in two slots`)
			owners.set(k, w)
		}
		for (const k of core.consumedKeys()) assert.equal(core.pendingHas(k), false, 'a consumed key is pending')
		assert.deepEqual(alerts, [], 'no ALERT')
		assert.ok(st.committed >= 2, `snapshots committed during the run: ${st.committed} (started ${st.started}, failed ${st.failed}, skippedBusy ${st.skippedBusy}, deferredNotQuiet ${st.deferredNotQuiet})`)
		assert.equal(st.failed, 0)
		assert.ok(checked >= Math.floor(copies.length * 0.8), `copies recovered ${checked}/${copies.length}`)
		process.stderr.write(`long ${Date.now() - t0} ms: events=${wal.lastSeq} settledBatches=${core.getScalar('settledBatchCount')} pending=${core.pendingSize} consumed=${core.consumedSize} snapshots committed=${st.committed} failed=${st.failed} skippedBusy=${st.skippedBusy} deferredNotQuiet=${st.deferredNotQuiet} copiesChecked=${checked}/${copies.length}\n`)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
