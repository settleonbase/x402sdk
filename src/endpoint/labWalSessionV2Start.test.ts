/**
 * F-B1-1: the first WAL start on a version 2 state. The REAL df78e6b reader (the baseline worktree) is polled in a tight loop while openWalSession converts the state and an actor commits events:
 * every read must either be refused or return exactly the original version 2 content - never a version 2 state with events in a log the old reader ignores. Also: the manifest is version 3 before the
 * first event exists, and a crash before the conversion (simulated by the direct state) leaves a plain version 2 state with no log.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { openWalSession } from './labWalSession'
import { scanWal } from './labWal'
import { canonicalJson } from './labClPayoutStateStore'

const BASELINE = process.env.E2E_BASELINE_ROOT ?? path.resolve(__dirname, '../../../lab-baseline-df78e6b')
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`

test('F-B1-1: v2 -> WAL: no event before the version 3 manifest; the real df78e6b reader is refused or reads the unchanged v2 state at every instant', { skip: !fs.existsSync(path.join(BASELINE, 'src/endpoint/labClPayoutStateStore.ts')) }, async () => {
	const old = (await import(pathToFileURL(path.join(BASELINE, 'src/endpoint/labClPayoutStateStore.ts')).href)) as {
		readSegmentedState: (dir: string) => unknown
		writeSegmentedState: (dir: string, state: unknown) => void
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labv2start-'))
	const stateDir = path.join(dir, 'state.v2')
	try {
		const original = {
			lastBackfillProcessedBlock: 99,
			historyCursor: 120,
			realtimeCursor: 120,
			freezeH: { height: 120, hash: key(77), frozenAt: '2026-11-22T00:00:00.000Z' },
			pending: [1, 2, 3].map((i) => ({ eventKey: key(i), amount: '1000', blockNumber: 110 + i, withdrawalIndex: 0, pubkey: '0x' + 'ab'.repeat(48) })),
			consumedEventKeys: { [key(9)]: true },
			exitedPubkeys: {},
		}
		old.writeSegmentedState(stateDir, original) // the plain daemon's writer
		const want = canonicalJson(old.readSegmentedState(stateDir) as never)
		const seen = { refused: 0, unchanged: 0, other: [] as string[], readWithEventsOnDisk: 0 }
		let stop = false
		// true once any log segment holds bytes: an event is on disk
		const eventsOnDisk = (): boolean => {
			try {
				const wd = path.join(stateDir, 'wal')
				return fs.readdirSync(wd).some((f) => fs.statSync(path.join(wd, f)).size > 0)
			} catch {
				return false
			}
		}
		const poller = (async () => {
			while (!stop) {
				const hadEvents = eventsOnDisk()
				try {
					const st = canonicalJson(old.readSegmentedState(stateDir) as never)
					if (hadEvents) seen.readWithEventsOnDisk++ // the old reader read a directory although an event was already on disk: it ignored that event
					if (st === want) seen.unchanged++
					else seen.other.push(st.slice(0, 200))
				} catch {
					seen.refused++
				}
				await new Promise((r) => setImmediate(r))
			}
		})()
		const logs: string[] = []
		let session!: Awaited<ReturnType<typeof openWalSession>>
		try {
		session = await openWalSession({ stateDir, legacyStateFile: path.join(dir, 'none.json'), scanFloor: 100, log: (l) => logs.push(l) })
		assert.ok(logs.some((l) => l.includes('converted to a version 3 snapshot before the first event')), logs.join('\n'))
		assert.equal((JSON.parse(fs.readFileSync(path.join(stateDir, 'manifest.json'), 'utf8')) as { version: number }).version, 3, 'version 3 before any actor event')
		// the only event so far is the start-up alignment, which openWalSession commits AFTER the conversion
		const events0: number[] = []
		scanWal(stateDir, { afterSeq: 0, repair: false, onEvent: (e) => events0.push(e.seq) })
		assert.ok(events0.length <= 1, `events before the first actor commit: ${events0.length}`)
		const a = session.hub.actor('pay')
		a.consumedAdd(key(1))
		a.pendingDel(key(1))
		a.setSlot('w1', { idempotencyKey: 'k', eventKeys: [key(2)], amountWei: '1000', line: 'realtime' })
		await a.commit('intent')
		await new Promise((r) => setTimeout(r, 30))
		stop = true
		await poller
		await session.scheduler.stop()
		await session.wal.close()
		assert.deepEqual(seen.other, [], 'the old reader never read anything but the original v2 state')
		assert.equal(seen.readWithEventsOnDisk, 0, 'the old reader never succeeded once an event was on disk (it would have ignored the log)')
		assert.ok(seen.unchanged + seen.refused > 10, `polled ${seen.unchanged + seen.refused} times`)
		assert.ok(seen.refused > 0, 'once the version 3 manifest is there the old reader refuses')
		process.stderr.write(`F-B1-1 old reader: unchanged=${seen.unchanged} refused=${seen.refused} other=${seen.other.length} readsWithEventsOnDisk=${seen.readWithEventsOnDisk}\n`)
		// and with the version 3 manifest in place the old reader refuses for good
		assert.throws(() => old.readSegmentedState(stateDir), /unsupported version/)
		} finally {
			stop = true
			await poller
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
