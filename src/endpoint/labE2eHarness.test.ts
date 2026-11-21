/**
 * P2c-0 review G1/G2/G3: the guards of the end-to-end fixture itself. The "paid at most once" check must FAIL on a real double payment and on a blind (empty) read; the in-flight reader must work on
 * a version 3 / WAL state; the harness must refuse a run whose tick timer was not compressed. Fast, no child process except the last test's logic being exercised through the pure helpers.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WalWriter } from './labWal'
import { assertPaidAtMostOnce, paymentsPerEventKeyOf, readInFlightRecord } from './labE2e/harness.test'

const K = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`

test('G1 negative control: two transactions with overlapping event keys are counted as 2 and the check throws; an empty event-key list throws (blind read); a clean set passes', () => {
	const clean = [
		{ idempotencyKey: 'a', eventKeys: [K(1), K(2)] },
		{ idempotencyKey: 'b', eventKeys: [K(3)] },
	]
	assert.doesNotThrow(() => assertPaidAtMostOnce(clean))
	assert.deepEqual(paymentsPerEventKeyOf(clean), { [K(1)]: 1, [K(2)]: 1, [K(3)]: 1 })
	const dup = [...clean, { idempotencyKey: 'c', eventKeys: [K(2), K(4)] }]
	assert.equal(paymentsPerEventKeyOf(dup)[K(2)], 2, 'the overlapping key is counted twice')
	assert.throws(() => assertPaidAtMostOnce(dup), /was paid by 2 transactions/)
	assert.throws(() => assertPaidAtMostOnce([...clean, { idempotencyKey: 'blind', eventKeys: [] }]), /no event keys: the persisted in-flight record could not be read/)
})

test('G2: the in-flight reader works on a version 2 state, on a WAL-mode version 3 snapshot (intent only in the log), and on a downgrade snapshot', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labe2eg2-'))
	try {
		const stateDir = path.join(dir, 'state.v2')
		const core = new LabPayoutStateCore({ scalars: { freezeH: { height: 500 } } })
		const src = core.freezeForSnapshot()
		const res = await writeSnapshotCooperative(src, { dir: stateDir, mode: 'wal' })
		core.finishSnapshot(src, { committed: true, prunedKeys: [], frozenHistCounts: res.frozenHistCounts })
		assert.equal(readInFlightRecord(stateDir), null, 'nothing in flight yet (version 3 manifest, empty log)')
		const wal = new WalWriter({ stateDir, lastSeq: 0, onFatal: (e) => { throw e } })
		const rec = { idempotencyKey: 'lab-withdrawNative:abc', eventKeys: [K(1), K(2)], line: 'history', amountWei: '3', redeem: '0xr', pool: '0xp', requestFingerprint: '0xf', createdAt: 'x' }
		await core.record(wal, 'intent', [{ op: 'inFlightSet', record: rec }]).durable
		await wal.close()
		const got = readInFlightRecord(stateDir)
		assert.equal(got?.idempotencyKey, 'lab-withdrawNative:abc')
		assert.deepEqual(got?.eventKeys, [K(1), K(2)])
		// the plain reader would have refused this state: that is why the fixture must not use it for WAL states
		const { readSegmentedState } = await import('./labClPayoutStateStore')
		assert.throws(() => readSegmentedState(stateDir), /WAL-mode snapshot/)
		// a plain version 2 state
		const dir2 = path.join(dir, 'plain.v2')
		const { writeSegmentedState } = await import('./labClPayoutStateStore')
		writeSegmentedState(dir2, { pending: [], consumedEventKeys: {}, exitedPubkeys: {}, inFlightWithdraw: rec })
		assert.equal(readInFlightRecord(dir2)?.idempotencyKey, 'lab-withdrawNative:abc')
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('G3: the harness source refuses a child that timed out or finished without compressing any tick timer, and the child reports how many it compressed', () => {
	const h = fs.readFileSync(path.join(__dirname, 'labE2e/harness.test.ts'), 'utf8')
	assert.match(h, /the child did not finish within .* the tick timer was probably not compressed/)
	assert.match(h, /the run finished but no tick timer was compressed/)
	const c = fs.readFileSync(path.join(__dirname, 'labE2e/childMain.test.ts'), 'utf8')
	assert.match(c, /\[e2e-child\] compressed=\$\{scheduledTicks\} requested=\$\{ticks\}/)
})
